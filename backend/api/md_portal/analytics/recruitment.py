"""MD portal, Recruitment: are we hiring enough, fast enough, and keeping the people we hire?

Everything here is read-only and reuses what the Report Center already computes, so a figure on this page agrees with
the matching report (cited in each ``provenance`` entry):

  * open positions, applicants by stage ........ "Job Openings" (employees_admin_recruit.py)
  * required vs active staff, vacancies ........ "Manpower Requirement vs Actual" (same file)
  * funnel, interviews, sources ................ "Recruitment Funnel", "Interview Schedule", "Resume Screening Pipeline"
  * joiners ................................... "New Joinings" (employees_master_movement.py)
  * leavers and exit dates .................... "Exits Register" / ``exit_infos`` (employees_master_base.py)
  * resignations and their approval stage ..... "Resignation Register" + approval_workflow.progress

What the data cannot say, said once here so the code below does not have to apologise for it:

  * A job posting carries only the day it was posted. There is no closing or filling date, and an applicant is never
    linked to the employee record created when they join. So TIME TO FILL IS NOT MEASURABLE: ``avgTimeToFillDays`` is
    always ``None`` and the age of the positions that are still open is shown instead.
  * Candidate statuses have no history. A funnel step is "where the candidate is today", so every step after the first
    is a lower bound (a rejected job-board applicant cannot be placed at a step).
  * The two pipelines do not mean the same thing by "selected": job-board "selected" is a post-interview selection,
    resume-screening "selected" is "selected for an interview" (the invite is sent from there). The funnel maps both
    onto six steps and says which pipeline can answer which step (see ``_funnel_stages``).
  * Resignation reasons are free text; they are grouped by keyword (``reason_group``) and only counts leave the server.
  * There is no headcount history: past headcount is rebuilt from join and exit dates (see ``Roster``).
"""

from __future__ import annotations

import re
from collections import Counter, defaultdict
from dataclasses import dataclass
from datetime import date, datetime, time, timedelta
from types import SimpleNamespace

from django.db.models import Count, Min, Q
from django.db.models.functions import TruncMonth

from ...clock import FACTORY_TZ, ist_today
from ...models import (
    Applicant,
    Department,
    DepartmentHeadcount,
    Employee,
    EmployeeDocument,
    Job,
    ResignationRequest,
    ScreeningCandidate,
)
from ...reporting.definitions.employees_admin_util import ist_range_q, ist_start
from ...reporting.definitions.employees_master_base import BASIS_APPROX, department_labels, exit_infos, join_date_of
from ..assistant.tools_base import integer_param, tool
from ..common import (
    MdParamError,
    Period,
    Scope,
    add_months,
    cached,
    change,
    envelope,
    last_n_months,
    month_bounds,
    month_label,
    pct,
    period_for_preset,
    prov,
)

# ─── named thresholds (each is shown to the MD in the provenance of the figure that uses it) ──────────────────────

STALE_POSITION_DAYS = 45  # an open position older than this is "stale"
PIPELINE_ACTIVE_DAYS = 90  # a candidate nobody has touched for longer than this is not "in the pipeline"
EARLY_ATTRITION_DAYS = 90  # a leaver who served this long or less left "early"
PENDING_RESIGNATION_WARN_DAYS = 7  # a resignation waiting longer than this needs a nudge
PENDING_RESIGNATION_CRITICAL_DAYS = 14
DEPT_NET_LOSS_MIN = 3  # a department that lost this many more people than it hired is flagged
FUNNEL_MIN_ENTERING = 20  # a funnel step is judged only when at least this many candidates reached it
FUNNEL_MIN_CONVERSION_PCT = 25.0  # ... and it passes on fewer than this share of them
OUTLOOK_DAYS = (30, 60)  # "leavers expected in the next ..."
EARLIEST_YEAR = 1990  # no record in this system is older: an earlier date is a typo, and its arithmetic would overflow
TREND_MONTHS = 12
ANNUALISE_MIN_DAYS = 28  # a shorter period is too noisy to scale up to a year
MAX_LIST = 100

JOB_OPEN = "open"
PENDING_RESIGNATION = ("pending", "dept_approved")  # the two "still waiting" statuses (see approval_workflow)

# Status vocabularies. They mirror employees_admin_recruit.py (APPLICANT_STATUSES / CANDIDATE_STATUSES); a test keeps
# the two in step. "Reached at least" sets: a candidate counts at a step when their status is in the set of that step.
APPLICANT_STATUSES = ("applied", "attended", "selected", "rejected")
CANDIDATE_STATUSES = ("uploaded", "screened", "shortlisted", "not_shortlisted", "selected", "rejected")
APPLICANT_REVIEWED = ("attended", "selected", "rejected")  # HR has acted on the application
APPLICANT_CALLED = ("attended", "selected")  # got as far as an interview (the job board has no shortlist step)
APPLICANT_OFFERED = ("selected",)
APPLICANT_IN_FLIGHT = ("applied", "attended")
# "rejected" is only reachable from shortlisted or selected (resume_screening_views._ALLOWED_TRANSITIONS), so a
# rejected candidate was on the shortlist.
CANDIDATE_SHORTLISTED_OR_LATER = ("shortlisted", "selected", "rejected")
CANDIDATE_IN_FLIGHT = ("uploaded", "screened", "shortlisted", "selected")

STAFF = "staff"
PRODUCTION = "production"

# Org paths of the models that reach the organisation through a department (jobs, applicants, screened candidates).
_JOB_ORG = {"dept": "department_id", "branch": "department__branch_id"}
_APPLICANT_ORG = {"dept": "job__department_id", "branch": "job__department__branch_id"}
_CANDIDATE_ORG = {"dept": "department_id", "branch": "department__branch_id"}

UNASSIGNED = "Unassigned"
NO_UNIT = "No unit"
NO_PLAN_NOTE = (
    "No required headcount has been set (Recruitment, Required Roles), so vacancies against the plan cannot be shown."
)

_ROLE_TEXT = {"hod": "Department head", "hr": "HR"}


# ─── the clock ─────────────────────────────────────────────────────────────────────────────────────────────────


@dataclass(frozen=True)
class _Clock:
    """The factory's today and an aware 'now'. Tests pass ``today``; production passes nothing and gets the real one."""

    today: date
    now: datetime


def _clock(today: date | None = None) -> _Clock:
    if today is None:
        return _Clock(ist_today(), datetime.now(FACTORY_TZ))
    return _Clock(today, datetime.combine(today, time(12, 0), tzinfo=FACTORY_TZ))


def _check_period(period: Period) -> None:
    if period.start.year < EARLIEST_YEAR:
        raise MdParamError(
            f"That period starts in {period.start.year}; this company's records begin after {EARLIEST_YEAR}."
        )


def _ist_day(value: datetime) -> date:
    """The factory's calendar date of an aware timestamp (UTC ``__date`` lookups would misfile 00:00-05:30 IST)."""
    return value.astimezone(FACTORY_TZ).date()


def _iso(value: date | None) -> str | None:
    return value.isoformat() if value else None


def _name(first: str | None, last: str | None) -> str:
    return f"{first or ''} {last or ''}".strip()


def _counts(qs, key: str) -> dict:
    return {row[key]: row["n"] for row in qs.order_by().values(key).annotate(n=Count("id"))}


def _org_q(scope: Scope, *, dept: str, branch: str) -> Q:
    """Unit and department narrowing for rows that reach the organisation through a department. A row with no
    department belongs to no unit, so it is part of the answer only when nothing is narrowed (as in the Report Center)."""
    q = Q()
    if scope.branch_ids:
        q &= Q(**{f"{branch}__in": scope.branch_ids})
    if scope.department_ids:
        q &= Q(**{f"{dept}__in": scope.department_ids})
    return q


def _ats_notes(scope: Scope) -> list[str]:
    """Jobs, applicants and screened candidates have no staff/production flag: say so when the MD picks one."""
    if scope.employment_type:
        return [
            "Job openings, applicants and screened candidates do not record staff or production, so that choice "
            "does not narrow them: they are shown for the chosen unit and department only."
        ]
    return []


def _dept_labels() -> dict[int, str]:
    """{department id: label} for EVERY department: the plain name, plus ' (Unit)' only where two departments of the
    company would otherwise read alike (CUTTING of Unit 1 and of Unit 2). Worked out against all of them, not just the
    ones on one card, so a department reads the same everywhere on the page. One query (two when names clash)."""
    rows = Department.objects.order_by("id").values_list("id", "name", "branch_id")
    return department_labels(SimpleNamespace(id=i, name=name, branch_id=branch_id) for i, name, branch_id in rows)


# ─── employees: the roster, headcount on a date, joiners and leavers ───────────────────────────────────────────


@dataclass(frozen=True)
class Person:
    id: int
    name: str
    kind: str  # "staff" | "production" (free text on the record, so anything else is possible)
    active: bool
    joined: date | None  # None when the join date is missing or unreadable
    left: date | None  # the exit date; None while active
    approx_exit: bool  # deactivated without an approved resignation: the date is the record's last edit
    department_id: int | None
    department: str | None
    unit: str | None  # the employee's unit
    designation: str | None


@dataclass
class Roster:
    """Every employee in scope with the dates headcount is rebuilt from. The system keeps no headcount history, so
    "how many people were employed on day D" is: joined on or before D and not yet gone. Today's headcount is the
    active employees (a person serving notice is already inactive in the system, as on every other page), and a person
    with no readable join date is assumed to have been employed all along."""

    people: list[Person]
    today: date
    missing_join_date: int = 0
    unreadable_join_date: int = 0

    def present(self, day: date, kind: str | None = None) -> list[Person]:
        """The people employed on ``day`` (optionally of one kind)."""
        out = []
        for p in self.people:
            if kind is not None and p.kind != kind:
                continue
            if p.joined is not None and p.joined > day:
                continue
            if day >= self.today:
                if p.active:
                    out.append(p)
            elif p.left is None or p.left > day:
                out.append(p)
        return out

    def present_on(self, day: date, kind: str | None = None) -> int:
        return len(self.present(day, kind))

    def joined_between(self, start: date, end: date) -> list[Person]:
        return [p for p in self.people if p.joined is not None and start <= p.joined <= end]

    def left_between(self, start: date, end: date) -> list[Person]:
        return [p for p in self.people if p.left is not None and start <= p.left <= end]


def _load_roster(scope: Scope, clock: _Clock) -> Roster:
    rows = list(
        Employee.objects.filter(scope.employee_q())
        .order_by("id")
        .values_list(
            "id",
            "first_name",
            "last_name",
            "employment_type",
            "status",
            "join_date",
            "updated_at",
            "department_id",
            "department__name",
            "branch__name",
            "designation__title",
        )
    )
    # The Report Center's own helper dates every exit (one query for all of them): approved resignation, else
    # approval day, else the record's last edit (approximate). Light objects are enough: it reads three attributes.
    gone = [SimpleNamespace(id=r[0], join_date=r[5], updated_at=r[6]) for r in rows if r[4] != "active"]
    exits = exit_infos(gone)
    people: list[Person] = []
    missing = unreadable = 0
    for emp_id, first, last, kind, status, join_raw, _updated, dept_id, dept, unit, designation in rows:
        joined, state = join_date_of(SimpleNamespace(join_date=join_raw))
        missing += state == "missing"
        unreadable += state == "unreadable"
        info = exits.get(emp_id) if status != "active" else None
        people.append(
            Person(
                id=emp_id,
                name=_name(first, last),
                kind=(kind or "").strip(),
                active=status == "active",
                joined=joined,
                left=info.when if info is not None else None,
                approx_exit=info is not None and info.basis == BASIS_APPROX,
                department_id=dept_id,
                department=dept,
                unit=unit,
                designation=designation,
            )
        )
    return Roster(people, clock.today, missing, unreadable)


def _movement(roster: Roster, period: Period, clock: _Clock) -> dict:
    """Joiners, leavers and attrition for a period. The period is cut at today (a custom range may reach forward)."""
    start, end = period.start, min(period.end, clock.today)
    if end < start:
        return {"joiners": [], "leavers": [], "opening": None, "closing": None, "average": None, "days": 0}
    opening = roster.present_on(start - timedelta(days=1))
    closing = roster.present_on(end)
    return {
        "joiners": roster.joined_between(start, end),
        "leavers": roster.left_between(start, end),
        "opening": opening,
        "closing": closing,
        "average": (opening + closing) / 2,
        "days": (end - start).days + 1,
    }


def _early(person: Person) -> bool:
    """Left within EARLY_ATTRITION_DAYS of joining. A leaver whose exit precedes the join date has bad data: not early."""
    if person.joined is None or person.left is None:
        return False
    return 0 <= (person.left - person.joined).days <= EARLY_ATTRITION_DAYS


def _attrition(move: dict) -> tuple[float | None, float | None]:
    """(attrition % for the period, the same scaled to a year). Scaling only from a month up: a week is too noisy."""
    leavers, average = len(move["leavers"]), move["average"]
    rate = pct(leavers, average)
    if rate is None or move["days"] < ANNUALISE_MIN_DAYS:
        return rate, None
    # scaled from the exact rate, not the rounded one: rounding first would be multiplied by up to 12
    return rate, round(100.0 * leavers / average * 365 / move["days"], 1)


# ─── candidates: the funnel ────────────────────────────────────────────────────────────────────────────────────

_STEPS = ("applied", "screened", "shortlisted", "interviewed", "offered")
_STEP_LABEL = {
    "applied": "Applied",
    "screened": "Screened",
    "shortlisted": "Shortlisted",
    "interviewed": "Interviewed",
    "offered": "Offered",
    "joined": "Joined",
}


def _funnel_core(scope: Scope, start: date, end: date, now: datetime) -> dict:
    """Candidates whose record was created between two factory days, counted per funnel step, per pipeline and per
    department. One grouped query per pipeline; everything else is arithmetic on the groups."""
    window = ist_range_q("created_at", start, end)
    applicants = (
        Applicant.objects.filter(_org_q(scope, **_APPLICANT_ORG), window)
        .order_by()
        .values("job__department_id")
        .annotate(
            applied=Count("id"),
            screened=Count("id", filter=Q(status__in=APPLICANT_REVIEWED)),
            shortlisted=Count("id", filter=Q(status__in=APPLICANT_CALLED)),
            interviewed=Count("id", filter=Q(status__in=APPLICANT_CALLED)),
            offered=Count("id", filter=Q(status__in=APPLICANT_OFFERED)),
        )
    )
    resumes = (
        ScreeningCandidate.objects.filter(_org_q(scope, **_CANDIDATE_ORG), window)
        .order_by()
        .values("department_id")
        .annotate(
            applied=Count("id"),
            screened=Count("id", filter=~Q(status="uploaded")),
            shortlisted=Count("id", filter=Q(status__in=CANDIDATE_SHORTLISTED_OR_LATER)),
            # Held = the interview time has passed. Only a shortlisted-or-later candidate can have one.
            interviewed=Count("id", filter=Q(status__in=CANDIDATE_SHORTLISTED_OR_LATER, interview_datetime__lte=now)),
        )
    )
    board: Counter = Counter()
    screening: Counter = Counter()
    by_dept: dict[int | None, dict[str, Counter]] = defaultdict(lambda: {"board": Counter(), "screening": Counter()})
    for row in applicants:
        for step in _STEPS:
            value = row.get(step, 0)
            board[step] += value
            by_dept[row["job__department_id"]]["board"][step] += value
    for row in resumes:
        for step in _STEPS[:4]:
            value = row[step]
            screening[step] += value
            by_dept[row["department_id"]]["screening"][step] += value
    return {"board": board, "screening": screening, "byDepartment": by_dept}


def _step(step: str, count: int | None, base: int | None, base_label: str | None, note: str | None = None) -> dict:
    """One funnel step: how many reached it, what share of the previous step that is, how many were lost on the way."""
    lost = base - count if count is not None and base is not None else None
    return {
        "id": step,
        "label": _STEP_LABEL[step],
        "count": count,
        "previousCount": base,
        "previousLabel": base_label,
        "ofPrevious": pct(count, base) if count is not None else None,
        "dropOff": lost,
        "dropOffPct": pct(lost, base) if lost is not None else None,
        "note": note,
    }


_OFFER_NOTE_COMBINED = (
    "Only the job board records a final selection, so this is job-board candidates only and is compared with the "
    "job-board candidates who were interviewed."
)
_OFFER_NOTE_SCREENING = "Resume screening has no final selection: it ends at the interview invitation."
_JOINED_NOTE = (
    "Everyone who joined in the period, hired through any route. Applicants are not linked to the employee record "
    "they become, so this is not a share of those offered."
)


def _funnel_stages(
    board: dict | Counter | None, screening: dict | Counter | None, joined: int | None, *, view: str
) -> list[dict]:
    """The six steps for one view: "all" (both pipelines), "board" (job board only) or "screening" (resume screening
    only). A step a pipeline cannot answer has ``count`` None, not 0: an unknown is not a loss."""
    b = board or {}
    s = screening or {}
    use_board = view in ("all", "board")
    use_screen = view in ("all", "screening")

    def total(step: str) -> int:
        return (b.get(step, 0) if use_board else 0) + (s.get(step, 0) if use_screen else 0)

    out: list[dict] = []
    previous: int | None = None
    previous_label: str | None = None
    for step in _STEPS[:4]:
        count = total(step)
        out.append(_step(step, count, previous, previous_label))
        previous, previous_label = count, _STEP_LABEL[step].lower()
    if view == "screening":
        out.append(_step("offered", None, None, None, _OFFER_NOTE_SCREENING))
    else:
        offered = b.get("offered", 0)
        base = b.get("interviewed", 0)
        label = "interviewed" if view == "board" else "interviewed (job board)"
        out.append(_step("offered", offered, base, label, _OFFER_NOTE_COMBINED if view == "all" else None))
    out.append(_step("joined", joined if view == "all" else None, None, None, _JOINED_NOTE if view == "all" else None))
    return out


# ─── positions and the staffing plan ────────────────────────────────────────────────────────────────────────────


def _load_positions(scope: Scope, clock: _Clock) -> list[dict]:
    """Every open position, oldest first, with its applicants by status. A fixed number of queries however many."""
    jobs = list(
        Job.objects.filter(_org_q(scope, **_JOB_ORG), status=JOB_OPEN)
        .select_related("department__branch")
        .order_by("created_at", "id")
    )
    mix: dict[int, Counter] = defaultdict(Counter)
    if jobs:
        rows = (
            Applicant.objects.filter(job_id__in=[j.id for j in jobs])
            .order_by()
            .values_list("job_id", "status")
            .annotate(n=Count("id"))
        )
        for job_id, status, n in rows:
            mix[job_id][status] += n
    labels = _dept_labels()
    out: list[dict] = []
    for job in jobs:
        posted = _ist_day(job.created_at)
        days = max(0, (clock.today - posted).days)
        counts = mix.get(job.id, Counter())
        known = {s: counts.get(s, 0) for s in APPLICANT_STATUSES}
        total = sum(counts.values())
        out.append(
            {
                "id": job.id,
                "title": job.title,
                "departmentId": job.department_id,
                "department": labels.get(job.department_id) if job.department_id else None,
                "unit": (job.department.branch.name if job.department.branch_id else NO_UNIT)
                if job.department_id
                else None,
                "postedOn": posted.isoformat(),
                "daysOpen": days,
                "stale": days > STALE_POSITION_DAYS,
                "applicants": total,
                "stageMix": {**known, "other": total - sum(known.values())},
                "salaryRange": (job.salary_range or "").strip() or None,
            }
        )
    out.sort(key=lambda p: (-p["daysOpen"], p["id"]))
    return out


def _headcount_gap(scope: Scope) -> dict:
    """The staffing plan against active staff, per department: the same rules as the Report Center's "Manpower
    Requirement vs Actual" (staff basis): vacancy = max(0, required - active staff), surplus only where a plan exists.
    The plan is a staff plan, so a production-only view has none."""
    if scope.employment_type == PRODUCTION:
        return {"applicable": False, "departments": [], "planned": 0}
    dq = Q()
    if scope.branch_ids:
        dq &= Q(branch_id__in=scope.branch_ids)
    if scope.department_ids:
        dq &= Q(id__in=scope.department_ids)
    depts = list(Department.objects.filter(dq).select_related("branch"))
    ids = [d.id for d in depts]
    plan = dict(
        DepartmentHeadcount.objects.filter(department_id__in=ids).values_list("department_id", "required_count")
    )
    current = _counts(
        Employee.objects.filter(status="active", employment_type=STAFF, department_id__in=ids), "department_id"
    )
    open_jobs = _counts(Job.objects.filter(status=JOB_OPEN, department_id__in=ids), "department_id")
    shortlisted = _counts(
        ScreeningCandidate.objects.filter(status__in=("shortlisted", "selected"), department_id__in=ids),
        "department_id",
    )
    planned = [d for d in depts if plan.get(d.id, 0) > 0]
    labels = _dept_labels()
    rows = []
    for d in planned:
        required, now = plan[d.id], current.get(d.id, 0)
        rows.append(
            {
                "departmentId": d.id,
                "department": labels[d.id],
                "unit": d.branch.name if d.branch_id else NO_UNIT,
                "required": required,
                "current": now,
                "vacancy": max(0, required - now),
                "surplus": max(0, now - required),
                "fillPct": pct(now, required),
                "openJobs": open_jobs.get(d.id, 0),
                "shortlisted": shortlisted.get(d.id, 0),
            }
        )
    rows.sort(key=lambda r: (-r["vacancy"], r["department"].lower(), r["departmentId"]))
    return {"applicable": True, "departments": rows, "planned": len(rows)}


def _gap_totals(gap: dict) -> dict:
    rows = gap["departments"]
    if not gap["applicable"] or not rows:
        return {"required": None, "current": None, "vacancies": None, "surplus": None, "departmentsWithGap": None}
    return {
        "required": sum(r["required"] for r in rows),
        "current": sum(r["current"] for r in rows),
        "vacancies": sum(r["vacancy"] for r in rows),
        "surplus": sum(r["surplus"] for r in rows),
        "departmentsWithGap": sum(1 for r in rows if r["vacancy"] > 0),
    }


# ─── resignations ───────────────────────────────────────────────────────────────────────────────────────────────

# Employees write the reason in their own words, so it is grouped by keyword. The first group that matches wins, in
# this order (a health or family reason outranks "better pay" when a sentence mentions both). Counts only.
_REASON_GROUPS: tuple[tuple[str, str, re.Pattern], ...] = tuple(
    (gid, label, re.compile(pattern, re.IGNORECASE))
    for gid, label, pattern in (
        (
            "health",
            "Health or medical",
            r"\b(health\w*|medical\w*|illness|ill|sick\w*|surger\w*|treatment|hospital\w*|doctor\w*|pregnan\w*|"
            r"maternity|accident|disease\w*|cancer|operation|injur\w*|fever)\b",
        ),
        (
            "family",
            "Family or personal",
            r"\b(famil\w*|personal|marri\w*|wedding|husband|wife|spouse|child\w*|baby|kids?|parents?|mother|father|"
            r"in-?laws?|domestic|elder\w*|home ?town|native|looking after)\b",
        ),
        (
            "relocation",
            "Relocation or distance",
            r"\b(relocat\w*|shift(?:ing)? to|mov(?:e|ed|ing) to|far from|distance|commut\w*|travel\w*|transport\w*|"
            r"bus|nearer|closer)\b",
        ),
        (
            "business",
            "Own business",
            r"\b(own (?:business|shop|company|work)|start(?:ing)? (?:a |my )?(?:own )?business|self[- ]?employ\w*|"
            r"start-?up|farm\w*|agricultur\w*)\b",
        ),
        (
            "pay",
            "Pay or a better job offer",
            r"\b(salary|salaries|pay\w*|wage\w*|package|hike|increment|better (?:opportunit\w*|offers?|jobs?|pay|"
            r"prospects?|positions?|roles?)|new job|another (?:job|company|organi[sz]ation)|other (?:company|job)|"
            r"job offer|offer from|higher (?:salary|pay|position|package))\b",
        ),
        (
            "growth",
            "Career growth or studies",
            r"\b(growth|promot\w*|career|stud(?:y|ies|ying)|educat\w*|degree|college|course|exams?|learn\w*|"
            r"upskill\w*|experience)\b",
        ),
        (
            "work",
            "Work environment or management",
            r"\b(management|manager|supervisor|boss|pressure|stress\w*|work ?load|environment|culture|harass\w*|"
            r"behaviou?r|timings?|working hours|night shift|overtime|unhappy|not happy|dissatisf\w*|conflict|"
            r"colleagues?|team|ill-?treat\w*)\b",
        ),
    )
)
REASON_OTHER = ("other", "Other")
REASON_NOT_STATED = ("not_stated", "Not stated")


def reason_group(text: str | None) -> tuple[str, str]:
    """(id, label) of the group a free-text resignation reason falls in. Blank is "Not stated"; text no keyword
    recognises is "Other". Pure and cheap: it is run once per request on a short list."""
    if not text or not text.strip():
        return REASON_NOT_STATED
    for gid, label, pattern in _REASON_GROUPS:
        if pattern.search(text):
            return gid, label
    return REASON_OTHER


def _waiting_text(roles: list[str]) -> str:
    return " or ".join(_ROLE_TEXT.get(r, r) for r in roles) if roles else "Nobody (not pending)"


def _resignation_slices(scope: Scope, period: Period, clock: _Clock) -> dict:
    """The resignation requests that matter right now, from ONE query: those still waiting for a decision, those
    raised in the period, and those approved whose last working day has not passed (people serving notice)."""
    from ... import approval_workflow as approval

    approval.clear_cache()  # the pipeline is remembered per request; a tool run outside one must not see a stale copy
    cfg = approval.get_config("resignation")
    rows = list(
        ResignationRequest.objects.filter(scope.employee_q("employee__"))
        .filter(
            Q(status__in=PENDING_RESIGNATION)
            | ist_range_q("created_at", period.start, period.end)
            | Q(status="approved", last_working_date__gte=clock.today)
        )
        .select_related("employee__department", "employee__designation")
        .defer("employee__photo_url", "employee__password_hash")
        .order_by("created_at", "id")
    )
    labels = _dept_labels()

    def dept_of(r) -> str:
        return labels.get(r.employee.department_id, UNASSIGNED) if r.employee.department_id else UNASSIGNED

    def reason_of(r) -> tuple[str, str]:
        return reason_group((r.reason or "").strip() or (r.survey_q1_answer or ""))

    pending, notice, raised = [], [], []
    for r in rows:
        requested = _ist_day(r.created_at)
        in_period = period.start <= requested <= period.end
        if in_period:
            raised.append((r, requested))
        if r.status in PENDING_RESIGNATION:
            waiting = approval.progress("resignation", r, cfg)["waitingFor"]
            pending.append(
                {
                    "id": r.id,
                    "employeeId": r.employee_id,
                    "employeeName": _name(r.employee.first_name, r.employee.last_name),
                    "department": dept_of(r),
                    "departmentId": r.employee.department_id,
                    "designation": r.employee.designation.title if r.employee.designation_id else None,
                    "requestedOn": requested.isoformat(),
                    "daysWaiting": max(0, (clock.today - requested).days),
                    "lastWorkingDate": _iso(r.last_working_date),
                    "noticeDays": (r.last_working_date - requested).days if r.last_working_date else None,
                    "daysToLastDay": (r.last_working_date - clock.today).days if r.last_working_date else None,
                    "status": r.status,
                    "waitingFor": list(waiting),
                    "waitingForText": _waiting_text(list(waiting)),
                }
            )
        elif r.status == "approved" and r.last_working_date and r.last_working_date >= clock.today:
            notice.append(
                {
                    "id": r.id,
                    "employeeId": r.employee_id,
                    "employeeName": _name(r.employee.first_name, r.employee.last_name),
                    "department": dept_of(r),
                    "departmentId": r.employee.department_id,
                    "designation": r.employee.designation.title if r.employee.designation_id else None,
                    "approvedOn": _iso(_ist_day(r.approved_at)) if r.approved_at else None,
                    "lastWorkingDate": r.last_working_date.isoformat(),
                    "daysLeft": (r.last_working_date - clock.today).days,
                }
            )
    pending.sort(key=lambda p: (-p["daysWaiting"], p["id"]))
    notice.sort(key=lambda p: (p["daysLeft"], p["id"]))
    return {
        "rows": rows,
        "pending": pending,
        "notice": notice,
        "raised": raised,
        "labels": labels,
        "reasonOf": reason_of,
    }


def _outlook(pending: list[dict], notice: list[dict], clock: _Clock) -> dict:
    """Leavers expected within 30 / 60 days of today. People serving notice are certain; pending requests that name a
    last working day in the window are expected if approved. A pending request with no date cannot be placed."""
    windows = {}
    for days in OUTLOOK_DAYS:
        limit = clock.today + timedelta(days=days)
        certain = [n for n in notice if date.fromisoformat(n["lastWorkingDate"]) <= limit]
        expected = [
            p
            for p in pending
            if p["lastWorkingDate"] and clock.today <= date.fromisoformat(p["lastWorkingDate"]) <= limit
        ]
        windows[f"next{days}"] = {
            "days": days,
            "approved": len(certain),
            "pending": len(expected),
            "total": len(certain) + len(expected),
        }
    horizon = clock.today + timedelta(days=max(OUTLOOK_DAYS))
    by_dept: Counter = Counter()
    names: dict[str, int | None] = {}
    for n in notice:
        if date.fromisoformat(n["lastWorkingDate"]) <= horizon:
            by_dept[n["department"]] += 1
            names[n["department"]] = n["departmentId"]
    for p in pending:
        if p["lastWorkingDate"] and clock.today <= date.fromisoformat(p["lastWorkingDate"]) <= horizon:
            by_dept[p["department"]] += 1
            names[p["department"]] = p["departmentId"]
    return {
        **windows,
        "withoutDate": sum(1 for p in pending if not p["lastWorkingDate"]),
        "byDepartment": [
            {"department": d, "departmentId": names[d], "count": n}
            for d, n in sorted(by_dept.items(), key=lambda kv: (-kv[1], kv[0].lower()))
        ],
    }


# ─── provenance (one explanation per figure, shared by every endpoint that shows the figure) ───────────────────


def _p_open_positions(rows: int) -> dict:
    return prov(
        "open-positions",
        "Open positions",
        dataset="Job openings (Interviews page)",
        definition=(
            "Job postings whose status is Open. Each posting counts as one position: the system has no 'number of "
            "openings' field. Same as the Report Center's Job Openings."
        ),
        formula="count of postings with status = open",
        rows=rows,
        filters=["Unit and department follow the posting's department"],
        caveats=["A posting with no department shows only when no unit or department is chosen."],
    )


def _p_vacancies(rows: int) -> dict:
    return prov(
        "vacancies",
        "Vacancies against the staffing plan",
        dataset="Required Roles (manpower plan) and active staff",
        definition=(
            "How many staff the plan still needs: for each department, the required number minus its active staff "
            "today. Same rules as the Report Center's Manpower Requirement vs Actual."
        ),
        formula="sum over departments of max(0, required - active staff)",
        rows=rows,
        filters=[
            "Staff only: the plan does not cover production",
            "Departments with no required number set are left out",
        ],
        caveats=["There is no headcount history, so this is today's picture."],
    )


def _p_position_age() -> dict:
    return prov(
        "position-age",
        "How long positions have been open",
        dataset="Job openings",
        definition="Days from the day a position was posted (factory date) to today, for positions still open.",
        formula="today - posting date",
        filters=[f"Stale = open for more than {STALE_POSITION_DAYS} days"],
        caveats=["The system does not record when a position is closed or filled, so only open positions can be aged."],
    )


def _p_time_to_fill() -> dict:
    return prov(
        "time-to-fill",
        "Time to fill",
        dataset="Not recorded",
        definition=(
            "Days between posting a position and filling it. This cannot be measured: a posting carries only its "
            "posting date (never a closing or filling date), and an applicant is not linked to the employee record "
            "created when they join."
        ),
        caveats=[
            "Time to fill is not available: the system records when a position is posted but never when it is filled "
            "or closed. The age of positions still open is the nearest measure; recording a closing date on each "
            "posting would make time to fill measurable."
        ],
    )


def _p_pipeline(rows: int | None = None) -> dict:
    return prov(
        "pipeline",
        "Candidates in the pipeline",
        dataset="Job-board applicants and screened resumes",
        definition=(
            "Candidates still being worked on that arrived in the last "
            f"{PIPELINE_ACTIVE_DAYS} days: job-board applicants marked Applied or Attended, and screened resumes that "
            "are Uploaded, Screened, Shortlisted or Selected (for interview)."
        ),
        formula="job-board (applied + attended) + resumes (uploaded + screened + shortlisted + selected)",
        rows=rows,
        caveats=["Older candidates are left out: nobody has moved them for months."],
    )


def _p_interviews(rows: int | None = None) -> dict:
    return prov(
        "interviews",
        "Interviews",
        dataset="Resume Screening interview invitations",
        definition=(
            "Interviews with a date and time, set when HR invites a selected candidate. 'Next 7 days' runs from today "
            "to six days ahead; 'held' means the interview time has already passed."
        ),
        rows=rows,
        caveats=[
            "The system does not record whether the candidate attended.",
            "Job-board applicants have no interview date, so their interviews are not counted here.",
        ],
    )


def _p_candidates(rows: int | None = None) -> dict:
    return prov(
        "candidates",
        "Candidates received and selected",
        dataset="Job-board applicants and screened resumes",
        definition=(
            "Candidates whose record was created in the period: job-board applications plus resumes uploaded to "
            "Resume Screening. 'Selected' counts job-board applicants now marked Selected."
        ),
        rows=rows,
        caveats=[
            "A candidate is counted by where they are today: the system keeps no status history.",
            "In Resume Screening 'Selected' means selected for an interview, not an offer, so it is not counted here.",
        ],
    )


def _p_joiners(rows: int, missing: int = 0, unreadable: int = 0) -> dict:
    caveats = ["Joiners include people who have since left, as in the Report Center's New Joinings."]
    if missing or unreadable:
        caveats.append(
            f"{_plural(missing + unreadable, 'employee')} in scope "
            f"{'has' if missing + unreadable == 1 else 'have'} a missing or unreadable join date and cannot be counted."
        )
    return prov(
        "joiners",
        "Joiners",
        dataset="Employee records (join date)",
        definition="Employees whose join date falls in the period.",
        formula="count of employees with a join date between the first and last day",
        rows=rows,
        caveats=caveats,
    )


def _p_leavers(rows: int, approximate: int = 0) -> dict:
    caveats = ["Employees deleted from the system do not appear."]
    if approximate:
        caveats.append(
            f"{approximate} of {_plural(rows, 'exit')} {'is' if approximate == 1 else 'are'} approximate: the "
            "employee was deactivated without a resignation, so the date is when the record was last edited, and it "
            "moves if the record is edited again."
        )
    return prov(
        "leavers",
        "Leavers",
        dataset="Employee records and approved resignations",
        definition=(
            "Employees who are no longer active and whose exit date falls in the period. The exit date is the approved "
            "resignation's last working day (or its approval day); with no resignation it is the record's last-modified "
            "date. Same dating as the Report Center's Exits Register."
        ),
        formula="count of inactive employees with an exit date between the first and last day",
        rows=rows,
        caveats=caveats,
    )


def _p_attrition(rows: int | None = None) -> dict:
    return prov(
        "attrition",
        "Attrition",
        dataset="Employee records (join and exit dates)",
        definition=(
            "Leavers in the period as a percentage of the average headcount. The system keeps no headcount history, so "
            "headcount on a past day is rebuilt from join and exit dates."
        ),
        formula="leavers / ((headcount at start + headcount at end) / 2) x 100; a year = x 365 / days in the period",
        rows=rows,
        caveats=[
            "People with no readable join date are assumed to have been employed all along.",
            "Today's headcount is the active employees: a person serving notice is already inactive in the system.",
            f"The yearly figure is shown only for periods of {ANNUALISE_MIN_DAYS} days or more.",
        ],
    )


def _p_resignations_raised(rows: int | None = None) -> dict:
    return prov(
        "resignations-raised",
        "Resignations raised",
        dataset="Resignation requests",
        definition="Resignation requests raised in the period (factory date), whatever their outcome.",
        rows=rows,
        caveats=[
            "An employee deactivated by HR without a request has no resignation record.",
            "A request HR deleted from the system cannot be counted.",
        ],
    )


def _p_pending(rows: int | None = None) -> dict:
    return prov(
        "resignations-pending",
        "Resignations waiting for a decision",
        dataset="Resignation requests and the approval workflow",
        definition=(
            "Requests still waiting: status Pending (awaiting the department head) or HOD approved (awaiting HR). "
            "Approved and Rejected are final, and approving makes the employee inactive straight away. 'Waiting for' "
            "follows the pipeline set in Approval Workflow Control (department head, then HR, unless changed). Days "
            "waiting = today - the day it was raised."
        ),
        rows=rows,
    )


def _p_notice(rows: int | None = None) -> dict:
    return prov(
        "notice",
        "People serving notice",
        dataset="Resignation requests",
        definition=(
            "Approved resignations whose last working day is today or later. The system makes them inactive at "
            "approval, so they no longer count in active headcount although they are still at work."
        ),
        rows=rows,
    )


def _p_outlook() -> dict:
    return prov(
        "outlook",
        "Leavers expected in the next 30 and 60 days",
        dataset="Resignation requests",
        definition=(
            "Approved resignations whose last working day falls in the window (certain), plus pending requests that "
            "name a last working day in the window (expected if approved)."
        ),
        caveats=["A pending request with no last working day cannot be placed in a window."],
    )


def _p_reasons(rows: int | None = None) -> dict:
    return prov(
        "reasons",
        "Resignation reasons",
        dataset="Resignation requests (the reason each employee wrote)",
        definition=(
            "Employees write the reason in their own words; each request is placed in the first group whose keywords "
            "it contains. Text no keyword recognises is 'Other'; a blank reason is 'Not stated'."
        ),
        rows=rows,
        caveats=["Grouping is by keyword and approximate. Only counts are shown, never the text."],
    )


# ─── summary ────────────────────────────────────────────────────────────────────────────────────────────────────


def _period_figures(scope: Scope, roster: Roster, period: Period, clock: _Clock) -> dict:
    """Every figure that is tied to a period (so it can be compared with the previous one)."""
    move = _movement(roster, period, clock)
    rate, yearly = _attrition(move)
    core = _funnel_core(scope, period.start, period.end, clock.now)
    day0 = ist_start(period.start)
    day1 = min(ist_start(period.end + timedelta(days=1)), clock.now)  # "held" = the interview time has passed
    held = (
        ScreeningCandidate.objects.filter(
            _org_q(scope, **_CANDIDATE_ORG), interview_datetime__gte=day0, interview_datetime__lt=day1
        ).count()
        if day1 > day0
        else 0
    )
    raised = ResignationRequest.objects.filter(
        scope.employee_q("employee__"), ist_range_q("created_at", period.start, period.end)
    ).count()
    joiners, leavers = move["joiners"], move["leavers"]
    return {
        "candidatesReceived": core["board"]["applied"] + core["screening"]["applied"],
        "candidatesSelected": core["board"]["offered"],
        "interviewsHeld": held,
        "joiners": len(joiners),
        "joinersStaff": sum(1 for p in joiners if p.kind == STAFF),
        "joinersProduction": sum(1 for p in joiners if p.kind == PRODUCTION),
        "leavers": len(leavers),
        "leaversResigned": sum(1 for p in leavers if not p.approx_exit),
        "leaversDeactivated": sum(1 for p in leavers if p.approx_exit),
        "earlyLeavers": sum(1 for p in leavers if _early(p)),
        "net": len(joiners) - len(leavers),
        "resignationsRaised": raised,
        "attritionPct": rate,
        "attritionAnnualisedPct": yearly,
        "averageHeadcount": round(move["average"], 1) if move["average"] is not None else None,
    }


_CHANGE_KEYS = (
    "candidatesReceived",
    "candidatesSelected",
    "interviewsHeld",
    "joiners",
    "leavers",
    "net",
    "resignationsRaised",
    "attritionPct",
)


@cached()
def summary(scope: Scope, period: Period, *, today: date | None = None) -> dict:
    """The recruitment scorecard: where hiring stands right now (positions, pipeline, interviews, pending resignations)
    and what happened in the period (candidates, joiners, leavers, attrition) against the period before it."""
    _check_period(period)
    clock = _clock(today)
    roster = _load_roster(scope, clock)
    positions = _load_positions(scope, clock)
    gap = _headcount_gap(scope)
    totals = _gap_totals(gap)
    current = _period_figures(scope, roster, period, clock)
    previous = _period_figures(scope, roster, period.previous(), clock)

    ages = [p["daysOpen"] for p in positions]
    since = ist_start(clock.today - timedelta(days=PIPELINE_ACTIVE_DAYS - 1))
    on_board = Applicant.objects.filter(
        _org_q(scope, **_APPLICANT_ORG), status__in=APPLICANT_IN_FLIGHT, created_at__gte=since
    ).count()
    on_screening = ScreeningCandidate.objects.filter(
        _org_q(scope, **_CANDIDATE_ORG), status__in=CANDIDATE_IN_FLIGHT, created_at__gte=since
    ).count()
    day0 = ist_start(clock.today)
    upcoming = ScreeningCandidate.objects.filter(
        _org_q(scope, **_CANDIDATE_ORG),
        interview_datetime__gte=day0,
        interview_datetime__lt=day0 + timedelta(days=7),
    ).count()
    today_count = ScreeningCandidate.objects.filter(
        _org_q(scope, **_CANDIDATE_ORG),
        interview_datetime__gte=day0,
        interview_datetime__lt=day0 + timedelta(days=1),
    ).count()

    res = _resignation_slices(scope, period, clock)
    outlook = _outlook(res["pending"], res["notice"], clock)
    waits = [p["daysWaiting"] for p in res["pending"]]

    now_figures = {
        "openPositions": len(positions),
        "vacancies": totals["vacancies"],
        "departmentsWithGap": totals["departmentsWithGap"],
        "stalePositions": sum(1 for p in positions if p["stale"]),
        "avgOpenDays": round(sum(ages) / len(ages), 1) if ages else None,
        "oldestOpenDays": max(ages) if ages else None,
        "avgTimeToFillDays": None,  # not recorded: see the module docstring
        "applicantsInPipeline": on_board + on_screening,
        "pipelineJobBoard": on_board,
        "pipelineScreening": on_screening,
        "interviewsNext7Days": upcoming,
        "interviewsToday": today_count,
        "resignationsPending": len(res["pending"]),
        "oldestPendingDays": max(waits) if waits else None,
        "onNotice": len(res["notice"]),
        "leaversNext30": outlook["next30"]["total"],
    }
    notes = _ats_notes(scope)
    if totals["vacancies"] is None and gap["applicable"]:
        notes.append(NO_PLAN_NOTE)
    approx = current["leaversDeactivated"]
    if approx:
        notes.append(
            f"{approx} of the {_plural(current['leavers'], 'leaver')} in this period "
            f"{'has' if approx == 1 else 'have'} only an approximate exit date (deactivated without a resignation)."
        )
    unreadable_joins = roster.missing_join_date + roster.unreadable_join_date
    if unreadable_joins:
        notes.append(
            f"{_plural(unreadable_joins, 'employee')} {'has' if unreadable_joins == 1 else 'have'} no readable join "
            "date and cannot be counted as joiners."
        )
    return envelope(
        {
            "current": {**now_figures, **current},
            "previous": {k: previous[k] for k in _CHANGE_KEYS},
            "changes": {k: change(current[k], previous[k]) for k in _CHANGE_KEYS},
            "previousPeriod": period.previous().to_json(),
            "thresholds": {
                "staleAfterDays": STALE_POSITION_DAYS,
                "pipelineActiveDays": PIPELINE_ACTIVE_DAYS,
                "earlyAttritionDays": EARLY_ATTRITION_DAYS,
                "resignationWarnAfterDays": PENDING_RESIGNATION_WARN_DAYS,
            },
        },
        period=period,
        scope=scope,
        provenance=[
            _p_open_positions(len(positions)),
            _p_vacancies(gap["planned"]),
            _p_position_age(),
            _p_time_to_fill(),
            _p_pipeline(on_board + on_screening),
            _p_interviews(upcoming + current["interviewsHeld"]),
            _p_candidates(current["candidatesReceived"]),
            _p_joiners(current["joiners"], roster.missing_join_date, roster.unreadable_join_date),
            _p_leavers(current["leavers"], approx),
            _p_resignations_raised(current["resignationsRaised"]),
            _p_pending(len(res["pending"])),
            _p_attrition(len(roster.people)),
        ],
        notes=notes,
    )


# ─── funnel ─────────────────────────────────────────────────────────────────────────────────────────────────────


@cached()
def funnel(scope: Scope, period: Period, *, today: date | None = None) -> dict:
    """Applied -> screened -> shortlisted -> interviewed -> offered -> joined for candidates who entered in the period,
    with the share that passes each step and how many drop out; for both pipelines together, each alone, and by
    department."""
    _check_period(period)
    clock = _clock(today)
    core = _funnel_core(scope, period.start, period.end, clock.now)
    roster = _load_roster(scope, clock)
    move = _movement(roster, period, clock)
    joiners = move["joiners"]
    stages = _funnel_stages(core["board"], core["screening"], len(joiners), view="all")
    views = {
        "jobBoard": _funnel_stages(core["board"], None, None, view="board"),
        "screening": _funnel_stages(None, core["screening"], None, view="screening"),
    }

    joined_by_dept = Counter(p.department_id for p in joiners)
    labels = _dept_labels()
    rows = []
    for dept_id, parts in core["byDepartment"].items():
        row = {step: parts["board"][step] + parts["screening"][step] for step in _STEPS[:4]}
        row["offered"] = parts["board"]["offered"]
        rows.append(
            {
                "departmentId": dept_id,
                "department": labels.get(dept_id, UNASSIGNED),
                **row,
                "joined": joined_by_dept.get(dept_id, 0),
            }
        )
    rows.sort(key=lambda r: (-r["applied"], r["department"].lower()))
    entered = stages[0]["count"]
    return envelope(
        {
            "stages": stages,
            "views": views,
            "byDepartment": rows[:12],
            "departmentsShown": min(len(rows), 12),
            "departmentsTotal": len(rows),
            "joiners": {
                "total": len(joiners),
                "staff": sum(1 for p in joiners if p.kind == STAFF),
                "production": sum(1 for p in joiners if p.kind == PRODUCTION),
                "linked": False,
            },
        },
        period=period,
        scope=scope,
        provenance=[
            prov(
                "funnel",
                "Hiring funnel",
                dataset="Job-board applicants, screened resumes and employee records",
                definition=(
                    "Candidates whose record was created in the period (a job-board application or an uploaded "
                    "resume), counted at each step by where they are today: a candidate counts at a step when their "
                    "status is that step or a later one. Conversion = candidates at the step / candidates at the "
                    "step before; drop-off is the difference."
                ),
                formula="conversion % = step count / previous step count x 100",
                rows=entered,
                filters=[
                    "Job board: Screened = any status except Applied; Shortlisted and Interviewed = Attended or "
                    "Selected; Offered = Selected",
                    "Resume screening: Screened = any status except Uploaded; Shortlisted = Shortlisted, Selected or "
                    "Rejected; Interviewed = the interview time has passed",
                ],
                caveats=[
                    "The system keeps no status history, so a Rejected job-board applicant counts as screened only: "
                    "every step after Screened is a lower bound. Same stages as the Report Center's Recruitment Funnel.",
                    _OFFER_NOTE_COMBINED,
                    _JOINED_NOTE,
                ],
            ),
            _p_joiners(len(joiners), roster.missing_join_date, roster.unreadable_join_date),
        ],
        notes=_ats_notes(scope),
    )


@cached()
def sources(scope: Scope, period: Period) -> dict:
    """Where candidates come from. The system records which pipeline a candidate entered (the public job board or an
    HR resume upload), not how they heard of the job (referral, agency, walk-in), so those are the only channels."""
    _check_period(period)
    window = ist_range_q("created_at", period.start, period.end)
    board = Applicant.objects.filter(_org_q(scope, **_APPLICANT_ORG), window).aggregate(
        n=Count("id"),
        moved=Count("id", filter=Q(status__in=APPLICANT_CALLED)),
        selected=Count("id", filter=Q(status__in=APPLICANT_OFFERED)),
    )
    resumes = ScreeningCandidate.objects.filter(_org_q(scope, **_CANDIDATE_ORG), window).aggregate(
        n=Count("id"),
        single=Count("id", filter=Q(source="single")),
        bulk=Count("id", filter=Q(source="bulk")),
        moved=Count("id", filter=Q(status__in=CANDIDATE_SHORTLISTED_OR_LATER)),
        invited=Count("id", filter=Q(interview_invited_at__isnull=False)),
    )
    channels = [
        {
            "id": "job_board",
            "label": "Job board applications",
            "candidates": board["n"],
            "progressed": board["moved"],
            "progressedPct": pct(board["moved"], board["n"]),
            "progressedLabel": "called to interview",
            "detail": None,
        },
        {
            "id": "resume_upload",
            "label": "Resumes uploaded by HR",
            "candidates": resumes["n"],
            "progressed": resumes["moved"],
            "progressedPct": pct(resumes["moved"], resumes["n"]),
            "progressedLabel": "shortlisted or later",
            "detail": f"{resumes['single']} single · {resumes['bulk']} bulk uploads",
        },
    ]
    return envelope(
        {"channels": channels, "total": board["n"] + resumes["n"], "channelsRecorded": 2},
        period=period,
        scope=scope,
        provenance=[
            prov(
                "sources",
                "Where candidates come from",
                dataset="Job-board applicants and screened resumes",
                definition=(
                    "Candidates whose record was created in the period, by the pipeline they entered: an application "
                    "through the public job board, or a resume HR uploaded to Resume Screening."
                ),
                rows=board["n"] + resumes["n"],
                caveats=[
                    "The system does not record how a candidate heard of the job (referral, agency, walk-in, "
                    "advertisement), so those channels cannot be shown.",
                    "A person who applied on the job board and whose resume was also uploaded counts in both.",
                ],
            )
        ],
        notes=_ats_notes(scope),
    )


# ─── positions ──────────────────────────────────────────────────────────────────────────────────────────────────


@cached()
def positions(scope: Scope, *, limit: int = 50, today: date | None = None) -> dict:
    """Open positions with their age, department, unit, applicants by status and a stale flag, plus required against
    active staff by department. A snapshot of today: it takes no period."""
    clock = _clock(today)
    limit = max(1, min(MAX_LIST, int(limit)))
    rows = _load_positions(scope, clock)
    gap = _headcount_gap(scope)
    totals = _gap_totals(gap)
    ages = [p["daysOpen"] for p in rows]
    notes = _ats_notes(scope)
    if not gap["applicable"]:
        notes.append("The staffing plan covers staff only, so it is not shown for production.")
    elif totals["vacancies"] is None:
        notes.append(NO_PLAN_NOTE)
    return envelope(
        {
            "summary": {
                "open": len(rows),
                "stale": sum(1 for p in rows if p["stale"]),
                "avgOpenDays": round(sum(ages) / len(ages), 1) if ages else None,
                "oldestOpenDays": max(ages) if ages else None,
                "withApplicants": sum(1 for p in rows if p["applicants"] > 0),
                "staleAfterDays": STALE_POSITION_DAYS,
                "avgTimeToFillDays": None,
            },
            "positions": rows[:limit],
            "positionsShown": min(len(rows), limit),
            "headcountGap": {
                "applicable": gap["applicable"],
                **totals,
                "departments": gap["departments"][: min(limit, 25)],
                "departmentsTotal": len(gap["departments"]),
            },
        },
        scope=scope,
        provenance=[_p_open_positions(len(rows)), _p_position_age(), _p_time_to_fill(), _p_vacancies(gap["planned"])],
        notes=notes,
    )


# ─── resignations ───────────────────────────────────────────────────────────────────────────────────────────────


@cached()
def resignations(scope: Scope, period: Period, *, limit: int = 10, today: date | None = None) -> dict:
    """Resignations: those waiting for a decision and for whom, people serving notice, leavers expected in the next 30
    and 60 days, why people resign (grouped) and where. Names appear only in the two short lists, and never next to a
    reason: a named person's reason (often health or family) is not something the MD's page needs."""
    _check_period(period)
    clock = _clock(today)
    limit = max(1, min(25, int(limit)))
    res = _resignation_slices(scope, period, clock)
    pending, notice, raised = res["pending"], res["notice"], res["raised"]
    outlook = _outlook(pending, notice, clock)

    reasons = Counter(res["reasonOf"](r) for r, _day in raised)
    reason_rows = [
        {"id": gid, "label": label, "count": n, "pct": pct(n, len(raised))}
        for (gid, label), n in sorted(reasons.items(), key=lambda kv: (-kv[1], kv[0][1]))
    ]

    decided_days = []
    for r, requested in raised:
        decided = None
        if r.status == "approved" and r.approved_at:
            decided = _ist_day(r.approved_at)
        elif r.status == "rejected" and r.rejected_by == "dept_head" and r.dept_head_approved_at:
            decided = _ist_day(r.dept_head_approved_at)  # an HR rejection carries no time stamp
        if decided is not None:
            decided_days.append((decided - requested).days)

    status_of = Counter()
    by_dept: dict[int | None, Counter] = defaultdict(Counter)
    for r, _day in raised:
        bucket = "pending" if r.status in PENDING_RESIGNATION else r.status
        status_of[bucket] += 1
        dept_id = r.employee.department_id
        by_dept[dept_id]["raised"] += 1
        by_dept[dept_id][bucket] += 1
    dept_rows = [
        {
            "department": res["labels"].get(d, UNASSIGNED) if d is not None else UNASSIGNED,
            "departmentId": d,
            "raised": c["raised"],
            "pending": c["pending"],
            "approved": c["approved"],
            "rejected": c["rejected"],
        }
        for d, c in by_dept.items()
    ]
    dept_rows.sort(key=lambda r: (-r["raised"], r["department"].lower()))

    waits = [p["daysWaiting"] for p in pending]
    return envelope(
        {
            "summary": {
                "pending": len(pending),
                "oldestPendingDays": max(waits) if waits else None,
                "waitingOn": _waiting_summary(pending),
                "onNotice": len(notice),
                "raised": len(raised),
                "approved": status_of["approved"],
                "rejected": status_of["rejected"],
                "stillPending": status_of["pending"],
                "avgDaysToDecision": round(sum(decided_days) / len(decided_days), 1) if decided_days else None,
                "warnAfterDays": PENDING_RESIGNATION_WARN_DAYS,
            },
            "pending": pending[:limit],
            "pendingShown": min(len(pending), limit),
            "onNotice": notice[:limit],
            "onNoticeShown": min(len(notice), limit),
            "reasons": reason_rows,
            "byDepartment": dept_rows[:12],
            "outlook": outlook,
        },
        period=period,
        scope=scope,
        provenance=[
            _p_pending(len(pending)),
            _p_notice(len(notice)),
            _p_outlook(),
            _p_resignations_raised(len(raised)),
            _p_reasons(len(raised)),
        ],
        notes=[],
    )


# ─── joiners and early attrition ────────────────────────────────────────────────────────────────────────────────


@cached()
def joiners(scope: Scope, period: Period, *, limit: int = 10, today: date | None = None) -> dict:
    """Who joined in the period (newest first, capped), by department and unit, with onboarding documents still
    missing; and early attrition: people who left within 90 days of joining."""
    _check_period(period)
    clock = _clock(today)
    limit = max(1, min(25, int(limit)))
    roster = _load_roster(scope, clock)
    move = _movement(roster, period, clock)
    new, gone = move["joiners"], move["leavers"]

    # onboarding: the required documents (the Documents page's own rule) still missing for people who are still here
    from ...employee_documents_views import _required_categories

    active_new = [p for p in new if p.active]
    present: dict[int, set[str]] = defaultdict(set)
    if active_new:
        for emp_id, category in (
            EmployeeDocument.objects.filter(employee_id__in=[p.id for p in active_new])
            .order_by()
            .values_list("employee_id", "category")
            .distinct()
        ):
            present[emp_id].add(category)
    missing_docs = {
        p.id: len([c for c in _required_categories(p.kind or STAFF) if c not in present[p.id]]) for p in active_new
    }

    labels = _dept_labels()

    def dept_of(p: Person) -> str:
        return labels.get(p.department_id, UNASSIGNED) if p.department_id else UNASSIGNED

    ordered = sorted(new, key=lambda p: (p.joined, p.name.lower()), reverse=True)
    by_dept = Counter(dept_of(p) for p in new)
    by_unit = Counter(p.unit or NO_UNIT for p in new)
    early = sorted((p for p in gone if _early(p)), key=lambda p: (p.left, p.name.lower()), reverse=True)
    early_dept = Counter(dept_of(p) for p in early)
    approx = sum(1 for p in gone if p.approx_exit)

    return envelope(
        {
            "summary": {
                "joiners": len(new),
                "staff": sum(1 for p in new if p.kind == STAFF),
                "production": sum(1 for p in new if p.kind == PRODUCTION),
                "stillActive": len(active_new),
                "leftSinceJoining": len(new) - len(active_new),
                "docsPending": sum(1 for n in missing_docs.values() if n > 0),
                "withoutJoinDate": roster.missing_join_date + roster.unreadable_join_date,
            },
            "list": [
                {
                    "employeeId": p.id,
                    "employeeName": p.name,
                    "department": dept_of(p),
                    "designation": p.designation,
                    "unit": p.unit or NO_UNIT,
                    "type": p.kind or None,
                    "joinDate": p.joined.isoformat(),
                    "active": p.active,
                    "docsMissing": missing_docs.get(p.id),
                }
                for p in ordered[:limit]
            ],
            "listShown": min(len(ordered), limit),
            "byDepartment": [{"department": d, "joiners": n} for d, n in _ranked(by_dept)[:12]],
            "byUnit": [{"unit": u, "joiners": n} for u, n in _ranked(by_unit)],
            "earlyAttrition": {
                "windowDays": EARLY_ATTRITION_DAYS,
                "leavers": len(early),
                "totalLeavers": len(gone),
                "pct": pct(len(early), len(gone)),
                "list": [
                    {
                        "employeeId": p.id,
                        "employeeName": p.name,
                        "department": dept_of(p),
                        "joinDate": p.joined.isoformat(),
                        "exitDate": p.left.isoformat(),
                        "daysServed": (p.left - p.joined).days,
                        "approximate": p.approx_exit,
                    }
                    for p in early[:limit]
                ],
                "listShown": min(len(early), limit),
                "byDepartment": [{"department": d, "leavers": n} for d, n in _ranked(early_dept)[:8]],
            },
        },
        period=period,
        scope=scope,
        provenance=[
            _p_joiners(len(new), roster.missing_join_date, roster.unreadable_join_date),
            prov(
                "onboarding-docs",
                "Onboarding documents still missing",
                dataset="Employee documents (Documents page)",
                definition=(
                    "For joiners who are still employed: those missing at least one required document (PAN, Aadhaar, "
                    "educational certificate, voter ID or birth certificate, bank passbook, and the staff letter or "
                    "production documents)."
                ),
                rows=len(active_new),
            ),
            prov(
                "early-attrition",
                "Early attrition",
                dataset="Employee records (join and exit dates)",
                definition=(
                    f"Leavers in the period who left within {EARLY_ATTRITION_DAYS} days of their join date, as a "
                    "share of all leavers in the period."
                ),
                formula=f"leavers with (exit date - join date) <= {EARLY_ATTRITION_DAYS} days / all leavers in the period",
                rows=len(gone),
                caveats=["An exit dated by the record's last edit (no resignation) is approximate."] if approx else [],
            ),
            _p_leavers(len(gone), approx),
        ],
        notes=[],
    )


def _ranked(counter: Counter) -> list[tuple[str, int]]:
    return sorted(counter.items(), key=lambda kv: (-kv[1], kv[0].lower()))


# ─── trend ──────────────────────────────────────────────────────────────────────────────────────────────────────


@cached()
def trend(scope: Scope, *, today: date | None = None) -> dict:
    """Joiners against leavers month by month for the last 12 months, the headcount at each month end, and the
    vacancies against the staffing plan at each month end. A trailing view of the company: it takes no period."""
    clock = _clock(today)
    roster = _load_roster(scope, clock)
    gap = _headcount_gap(scope)
    required = _gap_totals(gap)["required"]
    plan = {r["departmentId"]: r["required"] for r in gap["departments"]}
    staff_series = scope.employment_type != PRODUCTION
    rows = []
    for year, month in last_n_months(TREND_MONTHS, clock.today):
        first, last = month_bounds(year, month)
        end = min(last, clock.today)
        joined = len(roster.joined_between(first, end))
        left = len(roster.left_between(first, end))
        staff = roster.present(end, STAFF) if staff_series else None
        by_dept = Counter(p.department_id for p in staff) if staff is not None else Counter()
        rows.append(
            {
                "month": f"{year}-{month:02d}",
                "label": month_label(year, month),
                "partial": last > clock.today,
                "joiners": joined,
                "leavers": left,
                "net": joined - left,
                "headcount": roster.present_on(end),
                "staffHeadcount": len(staff) if staff is not None else None,
                # the same rule as the vacancies figure: each department's shortfall, never offset by another's surplus
                "vacancies": sum(max(0, need - by_dept.get(d, 0)) for d, need in plan.items())
                if staff is not None and plan
                else None,
            }
        )
    total_in = sum(r["joiners"] for r in rows)
    total_out = sum(r["leavers"] for r in rows)
    notes = []
    if not plan and staff_series:
        notes.append(NO_PLAN_NOTE)
    return envelope(
        {
            "months": rows,
            "required": required,
            "totals": {"joiners": total_in, "leavers": total_out, "net": total_in - total_out},
        },
        scope=scope,
        provenance=[
            _p_joiners(total_in, roster.missing_join_date, roster.unreadable_join_date),
            _p_leavers(total_out),
            prov(
                "headcount-gap",
                "Headcount and vacancies over time",
                dataset="Employee records and Required Roles",
                definition=(
                    "Headcount at the end of each month, rebuilt from join and exit dates. Vacancies are worked out as "
                    "on the Open positions card: for each department, the required staff number set today minus its "
                    "staff at that month end (never below zero), added up."
                ),
                formula="vacancies = sum over departments of max(0, required staff - staff at the month end)",
                rows=len(roster.people),
                caveats=[
                    "The plan has no history: every month is compared with today's required numbers.",
                    "The current month is the month so far, and today's headcount is the active employees.",
                ],
            ),
        ],
        notes=notes,
    )


# ─── what needs attention (the page's list, and the Dashboard's insights) ─────────────────────────────────────

_SEVERITY_RANK = {"critical": 0, "warning": 1, "info": 2, "good": 3}


def _plural(n: int, one: str, many: str | None = None) -> str:
    return f"{n} {one if n == 1 else (many or one + 's')}"


def _insight(id_: str, severity: str, title: str, detail: str, metric: str, ask: str) -> dict:
    return {
        "id": f"recruitment.{id_}",
        "severity": severity,
        "title": title,
        "detail": detail,
        "metric": metric,
        "page": "recruitment",
        "ask": ask,
    }


def _attention(scope: Scope, period: Period, clock: _Clock) -> list[dict]:
    """Exceptions, most severe first. Windowed rules (department losses, funnel, hiring ahead) use ``period``."""
    items: list[dict] = []

    # 1. positions open too long
    open_positions = _load_positions(scope, clock)
    stale = [p for p in open_positions if p["stale"]]
    if stale:
        oldest = stale[0]
        n = len(stale)
        critical = n >= 3 or oldest["daysOpen"] >= 2 * STALE_POSITION_DAYS
        where = f" ({oldest['department']})" if oldest["department"] else ""
        items.append(
            _insight(
                "stale-positions",
                "critical" if critical else "warning",
                f"{_plural(n, 'open position has', 'open positions have')} been open for more than {STALE_POSITION_DAYS} days",
                f"Longest open: {oldest['title']}{where}, {oldest['daysOpen']} days.",
                _plural(n, "position"),
                "Which positions have been open too long, and what is holding them up?",
            )
        )

    # 2. resignations waiting for a decision
    res = _resignation_slices(scope, period, clock)
    pending = res["pending"]
    if pending:
        wait = pending[0]["daysWaiting"]
        severity = (
            "critical"
            if wait >= PENDING_RESIGNATION_CRITICAL_DAYS
            else "warning"
            if wait >= PENDING_RESIGNATION_WARN_DAYS
            else "info"
        )
        items.append(
            _insight(
                "resignations-waiting",
                severity,
                f"{_plural(len(pending), 'resignation')} waiting for a decision",
                f"The longest has waited {_plural(wait, 'day')}. Waiting for: "
                + ", ".join(f"{w['label']} ({w['count']})" for w in _waiting_summary(pending))
                + ".",
                f"{len(pending)} pending",
                "Which resignations are waiting for a decision, and who needs to act?",
            )
        )

    # 3. a department losing more people than it hires
    roster = _load_roster(scope, clock)
    start, end = period.start, min(period.end, clock.today)
    came = roster.joined_between(start, end) if end >= start else []
    went = roster.left_between(start, end) if end >= start else []
    joined_by, left_by = Counter(p.department_id for p in came), Counter(p.department_id for p in went)
    labels = _dept_labels()
    worst = None
    for dept_id in left_by:
        if dept_id is None:
            continue
        net = left_by[dept_id] - joined_by.get(dept_id, 0)
        label = labels.get(dept_id, UNASSIGNED)
        if net >= DEPT_NET_LOSS_MIN and (worst is None or (net, label) > (worst[0], worst[1])):
            worst = (net, label, dept_id)
    if worst is not None:
        net, label, dept_id = worst
        items.append(
            _insight(
                "dept-net-loss",
                "critical" if net >= 10 else "warning",
                f"{label} lost {_plural(left_by[dept_id], 'person', 'people')} and hired {joined_by.get(dept_id, 0)} "
                f"({period.label.lower()})",
                f"A net loss of {net}. Check its open positions and the candidates in the pipeline.",
                f"-{net} net",
                f"Why is {label} losing more people than it hires?",
            )
        )

    # 4. a funnel step that loses almost everyone
    core = _funnel_core(scope, period.start, period.end, clock.now)
    stages = _funnel_stages(core["board"], core["screening"], None, view="all")
    worst_step = None
    phrases = {
        "screened": ("Only {p} of applicants have been screened", "are still waiting for a first review"),
        "shortlisted": ("Only {p} of screened candidates are shortlisted", "were not shortlisted"),
        "interviewed": ("Only {p} of shortlisted candidates reach an interview", "have not reached an interview"),
        "offered": ("Only {p} of interviewed job-board candidates are selected", "were not selected"),
    }
    for s in stages[1:5]:
        base = s["previousCount"]
        if base is None or base < FUNNEL_MIN_ENTERING or s["ofPrevious"] is None:
            continue
        if s["ofPrevious"] < FUNNEL_MIN_CONVERSION_PCT and (
            worst_step is None or s["ofPrevious"] < worst_step["ofPrevious"]
        ):
            worst_step = s
    if worst_step is not None:
        headline_text, tail = phrases[worst_step["id"]]
        base = worst_step["previousCount"]
        items.append(
            _insight(
                "funnel-dropoff",
                "warning",
                headline_text.format(p=f"{worst_step['ofPrevious']:.0f}%") + f" ({period.label.lower()})",
                f"{worst_step['dropOff']} of {base} {tail}.",
                f"{worst_step['count']} of {base}",
                f"Where are we losing candidates in the hiring funnel, and why is {worst_step['label'].lower()} so low?",
            )
        )

    # 5. people due to leave soon, in departments already short of staff
    outlook = _outlook(pending, res["notice"], clock)
    soon = outlook["next30"]["total"]
    if soon:
        gap_rows = {r["departmentId"]: r for r in _headcount_gap(scope)["departments"]}
        top = max(
            (d for d in outlook["byDepartment"]),
            key=lambda d: (d["count"], gap_rows.get(d["departmentId"], {}).get("vacancy", 0)),
        )
        row = gap_rows.get(top["departmentId"])
        short = row is not None and row["vacancy"] > 0
        detail = f"{outlook['next30']['approved']} serving notice and {outlook['next30']['pending']} pending. "
        detail += (
            f"{top['department']} has the most ({top['count']}) and is already {row['vacancy']} short of its plan of {row['required']}."
            if short
            else f"{top['department']} has the most ({top['count']})."
        )
        items.append(
            _insight(
                "leavers-soon",
                "warning" if short else "info",
                f"{_plural(soon, 'person is', 'people are')} due to leave in the next 30 days",
                detail,
                _plural(soon, "leaver"),
                "Who is due to leave in the next 30 days, and which departments will be short of staff?",
            )
        )

    # 6. good news: hiring is ahead of exits
    if len(came) >= 3 and len(came) > len(went):
        left_text = "nobody left" if not went else f"{len(went)} left"
        items.append(
            _insight(
                "hiring-ahead",
                "good",
                f"Hiring is ahead of exits: {len(came)} joined and {left_text} ({period.label.lower()})",
                f"A net gain of {_plural(len(came) - len(went), 'person', 'people')}.",
                f"+{len(came) - len(went)} net",
                "How is hiring doing compared with attrition?",
            )
        )

    items.sort(key=lambda i: _SEVERITY_RANK[i["severity"]])
    return items


def _waiting_summary(pending: list[dict]) -> list[dict]:
    counts = Counter(p["waitingForText"] for p in pending)
    return [{"label": k, "count": v} for k, v in sorted(counts.items(), key=lambda kv: (-kv[1], kv[0]))]


@cached()
def attention(scope: Scope, period: Period, *, today: date | None = None) -> dict:
    """The page's "Needs your attention": the exceptions for the chosen unit, department and period."""
    _check_period(period)
    clock = _clock(today)
    return envelope(
        {"items": _attention(scope, period, clock)},
        period=period,
        scope=scope,
        provenance=[
            prov(
                "attention-rules",
                "What counts as needing attention",
                dataset="Job openings, applicants, resumes, resignations and employee records",
                definition=(
                    f"Positions open more than {STALE_POSITION_DAYS} days (red when three or more, or one is "
                    f"{2 * STALE_POSITION_DAYS} days old); resignations waiting for a decision (amber after "
                    f"{PENDING_RESIGNATION_WARN_DAYS} days, red after {PENDING_RESIGNATION_CRITICAL_DAYS}); a "
                    f"department that lost {DEPT_NET_LOSS_MIN} or more people than it hired in the period (red at 10); a funnel "
                    f"step that passes fewer than {FUNNEL_MIN_CONVERSION_PCT:g}% of at least {FUNNEL_MIN_ENTERING} "
                    "candidates; people due to leave in the next 30 days; and, as good news, hiring ahead of exits."
                ),
            )
        ],
        notes=_ats_notes(scope),
    )


def insights(*, today: date | None = None) -> list[dict]:
    """Company-wide exceptions for the Dashboard: at most five, most severe first. Windowed rules look at 90 days."""
    clock = _clock(today)
    period = period_for_preset("last_90_days", clock.today)
    return _attention(Scope(), period, clock)[:5]


# ─── headline (the Dashboard card strip) ───────────────────────────────────────────────────────────────────────


def headline(*, today: date | None = None) -> dict:
    """Open positions, hires against exits this month, and resignations waiting for a decision, with sparklines."""
    clock = _clock(today)
    scope = Scope()
    roster = _load_roster(scope, clock)
    first = clock.today.replace(day=1)
    joined = len(roster.joined_between(first, clock.today))
    left = len(roster.left_between(first, clock.today))
    # the same number of days of last month, so a half-finished month is not compared with a whole one
    py, pm = add_months(first.year, first.month, -1)
    p_first, p_last = month_bounds(py, pm)
    p_end = min(p_last, p_first + timedelta(days=clock.today.day - 1))
    prev_joined = len(roster.joined_between(p_first, p_end))

    months = last_n_months(6, clock.today)
    spark_joined = []
    for y, m in months:
        a, b = month_bounds(y, m)
        spark_joined.append(len(roster.joined_between(a, min(b, clock.today))))

    positions_now = _load_positions(scope, clock)
    gap = _headcount_gap(scope)
    totals = _gap_totals(gap)
    stale = sum(1 for p in positions_now if p["stale"])

    agg = ResignationRequest.objects.filter(status__in=PENDING_RESIGNATION).aggregate(
        n=Count("id"), oldest=Min("created_at")
    )
    waiting = agg["n"] or 0
    oldest_days = max(0, (clock.today - _ist_day(agg["oldest"])).days) if agg["oldest"] else None
    since = ist_start(date(months[0][0], months[0][1], 1))
    monthly = {
        (row["m"].year, row["m"].month): row["n"]
        for row in ResignationRequest.objects.filter(created_at__gte=since)
        .annotate(m=TruncMonth("created_at", tzinfo=FACTORY_TZ))
        .values("m")
        .annotate(n=Count("id"))
        .order_by()
    }
    spark_resigned = [monthly.get(ym, 0) for ym in months]

    vac_text = (
        f"{totals['vacancies']} vacancies against plan" if totals["vacancies"] is not None else "No staffing plan set"
    )
    stale_text = f" · {stale} over {STALE_POSITION_DAYS} days" if stale else ""
    kpis = [
        {
            "id": "recruitment.open_positions",
            "label": "Open positions",
            "value": len(positions_now),
            "format": "number",
            "sub": vac_text + stale_text,
            "delta": None,
            "spark": None,
            "page": "recruitment",
        },
        {
            "id": "recruitment.joined_this_month",
            "label": "Joined this month",
            "value": joined,
            "format": "number",
            "sub": f"{left} left · net {joined - left:+d}",
            "delta": {**(change(joined, prev_joined) or {"abs": None, "pct": None}), "good": "up"},
            "spark": spark_joined,
            "page": "recruitment",
        },
        {
            "id": "recruitment.pending_resignations",
            "label": "Resignations awaiting decision",
            "value": waiting,
            "format": "number",
            "sub": f"Oldest waiting {oldest_days} days" if oldest_days is not None else "None waiting",
            "delta": None,
            "spark": spark_resigned,
            "page": "recruitment",
        },
    ]
    return {
        "kpis": kpis,
        "provenance": [
            _p_open_positions(len(positions_now)),
            _p_vacancies(gap["planned"]),
            _p_joiners(joined, roster.missing_join_date, roster.unreadable_join_date),
            _p_leavers(left),
            _p_pending(waiting),
        ],
    }


# ─── the assistant's tools ─────────────────────────────────────────────────────────────────────────────────────

_LIMIT = {"limit": integer_param("How many rows to return in lists (default 10, at most 25)", minimum=1, maximum=25)}

TOOLS = [
    tool(
        "recruitment_summary",
        "The recruitment scorecard: open positions and vacancies against the staffing plan, how long positions have "
        "been open (average and oldest, and how many are stale), candidates in the pipeline, interviews scheduled "
        "(next 7 days) and held, joiners, leavers, resignations raised and waiting for a decision, people serving "
        "notice, and attrition % (also as a yearly rate), each compared with the previous period. Use for 'how is "
        "hiring going?', 'are we hiring enough?', 'what is our attrition?'. Time to fill is not recorded by the system, "
        "so it is returned as null: say so rather than guess.",
        summary,
        page="recruitment",
        period="last_90_days",
    ),
    tool(
        "recruitment_funnel",
        "The hiring funnel for candidates who entered in the period: applied, screened, shortlisted, interviewed, "
        "offered, joined, with the conversion % and drop-off at each step, for job-board applicants and resume-screening "
        "candidates together, each alone, and by department. Use for 'where do we lose candidates?', 'how many "
        "applicants become hires?'. Steps are a candidate's CURRENT status (no history is kept), so later steps are "
        "lower bounds; 'joined' is all new employees, not linked to applicants.",
        funnel,
        page="recruitment",
        period="last_90_days",
    ),
    tool(
        "open_positions",
        "Open job positions, oldest first: days open, department, unit, applicants by status and a stale flag (open "
        "more than 45 days), plus required against active staff headcount by department with the vacancy and fill %. "
        "Use for 'which positions have been open too long?', 'which departments are short of staff?'. No period: it is "
        "a picture of today.",
        positions,
        page="recruitment",
        extra=_LIMIT,
        defaults={"limit": 10},
    ),
    tool(
        "resignations_overview",
        "Resignations: those waiting for a decision (and whether they wait for the department head or HR, how many days), "
        "people serving notice, leavers expected in the next 30 and 60 days, resignation reasons grouped by keyword, and "
        "resignations by department, plus how many were raised, approved and rejected in the period. Use for 'who is "
        "leaving?', 'how many resignations are pending?', 'why are people resigning?'.",
        resignations,
        page="recruitment",
        period="last_90_days",
        extra=_LIMIT,
        defaults={"limit": 10},
    ),
    tool(
        "hiring_vs_attrition",
        "Joiners against leavers month by month for the last 12 months, with the headcount at each month end and the gap "
        "to the required staff numbers. Use for 'are we hiring faster than people leave?', 'is the staffing gap closing?'. "
        "No period: it always covers the last 12 months.",
        trend,
        page="recruitment",
    ),
    tool(
        "new_joiners_and_early_exits",
        "Employees who joined in the period (newest first, by department and unit, with onboarding documents still "
        "missing) and early attrition: people who left within 90 days of joining, with their department and days served. "
        "Use for 'who joined recently?', 'are new hires staying?', 'which departments lose people early?'.",
        joiners,
        page="recruitment",
        period="last_90_days",
        extra=_LIMIT,
        defaults={"limit": 10},
    ),
]

__all__ = [
    "TOOLS",
    "attention",
    "funnel",
    "headline",
    "insights",
    "joiners",
    "positions",
    "reason_group",
    "resignations",
    "sources",
    "summary",
    "trend",
]

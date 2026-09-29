"""Recruitment reports: manpower plan vs actual, job board (openings, applicants), resume-screening pipeline
(candidates, interviews, hiring criteria) and a department funnel.

Scoping: none of these models has a branch of its own. Jobs, screening candidates and hiring rule sets reach a
branch through their department, applicants through their job's department. A row with no department belongs to
no branch, so it is visible to unscoped users only (and disappears as soon as a branch/department filter is
used) - see ``employees_admin_util.org_q``."""

from __future__ import annotations

from datetime import date, timedelta

from django.db.models import Avg, Count, F, Q

from api.branch_scope import get_branch_scope
from api.models import (
    Applicant,
    Department,
    DepartmentHeadcount,
    Employee,
    HiringRuleSet,
    Job,
    ScreeningCandidate,
)

from ..filters import branches, boolean, date_range, departments, number, select, text
from ..formatting import fmt_dt
from ..registry import register
from ..types import BADGE, DATE, DATETIME, INTEGER, NUMBER, PERCENT, TEXT, ColumnSpec, ReportResult, ReportSpec
from .employees_admin_util import ist_date, ist_range_q, ist_start, join_list, label, org_q, pct

# ── shared bits ─────────────────────────────────────────────────────────────

CANDIDATE_STATUSES = (
    ("uploaded", "Uploaded"),
    ("screened", "Screened"),
    ("shortlisted", "Shortlisted"),
    ("not_shortlisted", "Not shortlisted"),
    ("selected", "Selected"),
    ("rejected", "Rejected"),
)
_CANDIDATE_LABEL = dict(CANDIDATE_STATUSES)
APPLICANT_STATUSES = (
    ("applied", "Applied"),
    ("attended", "Attended"),
    ("selected", "Selected"),
    ("rejected", "Rejected"),
)
_CANDIDATE_ORG = dict(dept_field="department_id", branch_field="department__branch_id")
_APPLICANT_ORG = dict(dept_field="job__department_id", branch_field="job__department__branch_id")
_DEPT_ORG = dict(dept_field="department_id", branch_field="department__branch_id")


def _dept_text(dept) -> str:
    return dept.name if dept is not None else "Unassigned"


def _branch_text(dept) -> str:
    if dept is None:
        return "No branch"
    return dept.branch.name if dept.branch_id else "No branch"


# ── Manpower Requirement vs Actual ──────────────────────────────────────────

_BASIS = (
    ("staff", "Staff only (as on the Required Roles page)"),
    ("all", "All active employees"),
    ("production", "Production only"),
)


def _dept_q(ctx) -> Q:
    q = Q()
    scope = get_branch_scope(ctx.request)
    if scope is not None:
        q &= Q(branch_id=scope)
    if ctx.params.get("branch_ids"):
        q &= Q(branch_id__in=ctx.params["branch_ids"])
    if ctx.params.get("department_ids"):
        q &= Q(id__in=ctx.params["department_ids"])
    return q


def _counts(qs, key: str) -> dict[int, int]:
    return {r[key]: r["n"] for r in qs.order_by().values(key).annotate(n=Count("id"))}


def _run_manpower(ctx):
    basis = ctx.param("basis", "staff")
    only_gaps = ctx.param("onlyGaps", False)
    depts = list(Department.objects.filter(_dept_q(ctx)).select_related("branch").order_by("branch__name", "name", "id"))
    ids = [d.id for d in depts]
    plan = {h.department_id: h for h in DepartmentHeadcount.objects.filter(department_id__in=ids)}

    emp_q = Q(status="active", department_id__in=ids)
    if basis in ("staff", "production"):
        emp_q &= Q(employment_type=basis)
    scope = get_branch_scope(ctx.request)
    if scope is not None:
        emp_q &= Q(branch_id=scope)
    current = _counts(Employee.objects.filter(emp_q), "department_id")
    open_jobs = _counts(Job.objects.filter(status="open", department_id__in=ids), "department_id")
    pipeline = _counts(
        ScreeningCandidate.objects.filter(status__in=("shortlisted", "selected"), department_id__in=ids), "department_id"
    )

    rows = []
    gaps = 0
    for d in depts:
        hc = plan.get(d.id)
        required = hc.required_count if hc else 0
        now = current.get(d.id, 0)
        vacancy = max(0, required - now)
        surplus = max(0, now - required) if required > 0 else 0
        if required <= 0:
            status = "Not planned"
        elif vacancy:
            status = "Understaffed"
        elif surplus:
            status = "Overstaffed"
        else:
            status = "Fully staffed"
        if vacancy:
            gaps += 1
        if only_gaps and not vacancy:
            continue
        rows.append({
            "branch": d.branch.name if d.branch_id else "No branch",
            "department": d.name,
            "requiredCount": required,
            "currentCount": now,
            "vacancy": vacancy,
            "surplus": surplus,
            "fillPct": pct(now, required) if required > 0 else None,
            "status": status,
            "openJobs": open_jobs.get(d.id, 0),
            "inPipeline": pipeline.get(d.id, 0),
            "notes": (hc.notes or None) if hc else None,
            "updatedOn": ist_date(hc.updated_at) if hc else None,
        })
    shown = rows
    who = {"staff": "active STAFF", "production": "active PRODUCTION", "all": "active"}[basis]
    return ReportResult(
        rows=rows,
        summary=[
            {"label": "Required", "value": sum(r["requiredCount"] for r in shown), "format": "integer"},
            {"label": "Current", "value": sum(r["currentCount"] for r in shown), "format": "integer"},
            {"label": "Vacancies", "value": sum(r["vacancy"] for r in shown), "format": "integer"},
            {"label": "Surplus", "value": sum(r["surplus"] for r in shown), "format": "integer"},
            {"label": "Departments with gaps", "value": gaps, "format": "integer"},
        ],
        notes=[
            f"Current strength counts {who} employees per department today (there is no historical headcount).",
            "'Not planned' = no required count set (or set to 0); fill % is left blank rather than shown as 100%.",
            "Vacancy = required minus current (never negative); surplus is only reported for planned departments. "
            "The plan itself is staff-based, so 'All' or 'Production' will show people against a required count of 0.",
            "Open jobs = job postings still open for the department; in pipeline = screened candidates currently "
            "shortlisted or selected.",
        ],
    )


register(ReportSpec(
    id="manpower-requirement",
    title="Manpower Requirement vs Actual",
    description="Required vs current strength and vacancies per department, with open jobs and pipeline.",
    category="employees",
    icon="Scale",
    tags=("required roles", "vacancy", "headcount plan", "manpower planning"),
    modules=("recruitment.required_roles",),
    filters=(
        branches(),
        departments(),
        select("basis", "Count", _BASIS, default="staff"),
        boolean("onlyGaps", "Only departments with vacancies"),
    ),
    columns=(
        ColumnSpec("branch", "Branch", TEXT, 1.3),
        ColumnSpec("department", "Department", TEXT, 1.8),
        ColumnSpec("requiredCount", "Required", INTEGER, 0.9, total="sum"),
        ColumnSpec("currentCount", "Current", INTEGER, 0.9, total="sum"),
        ColumnSpec("vacancy", "Vacancy", INTEGER, 0.9, total="sum"),
        ColumnSpec("surplus", "Surplus", INTEGER, 0.9, total="sum"),
        ColumnSpec("fillPct", "Fill %", PERCENT, 0.8),
        ColumnSpec("status", "Status", BADGE, 1.2),
        ColumnSpec("openJobs", "Open Jobs", INTEGER, 0.8, total="sum"),
        ColumnSpec("inPipeline", "In Pipeline", INTEGER, 0.9, total="sum"),
        ColumnSpec("notes", "Notes", TEXT, 2.0),
        ColumnSpec("updatedOn", "Plan Updated", DATE, 1.0),
    ),
    run=_run_manpower,
))


# ── Job Openings ────────────────────────────────────────────────────────────

_JOB_STATUS = (("open", "Open"), ("closed", "Closed"), ("all", "All"))


def _run_jobs(ctx):
    status = ctx.param("status", "open")
    within = ctx.param("postedWithinDays")
    q = org_q(ctx, **_DEPT_ORG)
    if status in ("open", "closed"):
        q &= Q(status=status)
    if within:
        q &= Q(created_at__gte=ist_start(ctx.today - timedelta(days=within - 1)))
    jobs = list(
        Job.objects.filter(q)
        .select_related("department", "department__branch")
        .annotate(
            n_all=Count("applicants"),
            n_applied=Count("applicants", filter=Q(applicants__status="applied")),
            n_attended=Count("applicants", filter=Q(applicants__status="attended")),
            n_selected=Count("applicants", filter=Q(applicants__status="selected")),
            n_rejected=Count("applicants", filter=Q(applicants__status="rejected")),
        )
        .order_by("-created_at", "-id")
    )
    rows = []
    open_days: list[int] = []
    for j in jobs:
        posted = ist_date(j.created_at)
        days = None
        if j.status == "open" and posted:
            days = max(0, (ctx.today - date.fromisoformat(posted)).days)
            open_days.append(days)
        rows.append({
            "title": j.title,
            "department": _dept_text(j.department),
            "branch": _branch_text(j.department),
            "status": label(j.status, "Unknown"),
            "postedOn": posted,
            "daysOpen": days,
            "salaryRange": j.salary_range or None,
            "applicants": j.n_all,
            "applied": j.n_applied,
            "attended": j.n_attended,
            "selected": j.n_selected,
            "rejected": j.n_rejected,
            "selectionRatePct": pct(j.n_selected, j.n_all),
        })
    return ReportResult(
        rows=rows,
        summary=[
            {"label": "Open positions", "value": sum(1 for j in jobs if j.status == "open"), "format": "integer"},
            {"label": "Applicants", "value": sum(r["applicants"] for r in rows), "format": "integer"},
            {"label": "Selected", "value": sum(r["selected"] for r in rows), "format": "integer"},
            {
                "label": "Average days open",
                "value": round(sum(open_days) / len(open_days), 1) if open_days else None,
                "format": "number",
            },
        ],
        notes=[
            "Days open counts from the posting date to today and is shown for open jobs only - the system does "
            "not record when a job was closed.",
            "Applicant stages are the applicant's CURRENT status; an applicant with any other status text counts "
            "in the total but in no stage column.",
            "Jobs with no department are listed for unscoped users only.",
        ],
    )


register(ReportSpec(
    id="job-openings",
    title="Job Openings",
    description="Job postings with days open and applicant counts by stage.",
    category="employees",
    icon="Briefcase",
    tags=("jobs", "vacancies", "job board", "hiring"),
    family="job-board",
    variant="Openings",
    modules=("recruitment",),
    filters=(
        select("status", "Job status", _JOB_STATUS, default="open"),
        number("postedWithinDays", "Posted in the last (days)", default=None, min=1, max=3650, help="Blank = any date"),
        branches(),
        departments(),
    ),
    columns=(
        ColumnSpec("title", "Position", TEXT, 2.2),
        ColumnSpec("department", "Department", TEXT, 1.6),
        ColumnSpec("branch", "Branch", TEXT, 1.2),
        ColumnSpec("status", "Status", BADGE, 0.9),
        ColumnSpec("postedOn", "Posted", DATE, 1.1),
        ColumnSpec("daysOpen", "Days Open", INTEGER, 0.8),
        ColumnSpec("salaryRange", "Salary Range", TEXT, 1.3),
        ColumnSpec("applicants", "Applicants", INTEGER, 0.9, total="sum"),
        ColumnSpec("applied", "Applied", INTEGER, 0.8, total="sum"),
        ColumnSpec("attended", "Attended", INTEGER, 0.8, total="sum"),
        ColumnSpec("selected", "Selected", INTEGER, 0.8, total="sum"),
        ColumnSpec("rejected", "Rejected", INTEGER, 0.8, total="sum"),
        ColumnSpec("selectionRatePct", "Selection %", PERCENT, 0.9),
    ),
    run=_run_jobs,
))


# ── Applicant Register ──────────────────────────────────────────────────────

def _run_applicants(ctx):
    q = org_q(ctx, **_APPLICANT_ORG) & ist_range_q("created_at", ctx.date_from, ctx.date_to)
    statuses = ctx.param("status", [])
    if statuses:
        q &= Q(status__in=statuses)
    title = ctx.param("jobTitle")
    if title:
        q &= Q(job__title__icontains=title)
    base = Applicant.objects.filter(q)
    people = (
        base.select_related("job", "job__department")
        .defer("cover_letter")
        .order_by("-created_at", "-id")[: ctx.row_limit]
    )
    rows = [
        {
            "appliedOn": ist_date(a.created_at),
            "name": a.name,
            "phone": a.phone or None,
            "email": a.email or None,
            "jobTitle": a.job.title,
            "department": _dept_text(a.job.department),
            "experience": a.experience or None,
            "status": label(a.status, "Unknown"),
            "notes": a.notes or None,
        }
        for a in people
    ]
    agg = base.order_by().aggregate(
        total=Count("id"),
        **{s: Count("id", filter=Q(status=s)) for s, _ in APPLICANT_STATUSES},
    )
    positions = base.order_by().values("job__title").annotate(n=Count("id")).order_by("-n", "job__title")[:5]
    notes = [
        "Applicants come from the public job board. Phone and email are personal data - handle accordingly.",
        "Interview dates are not listed: the applicant interview-date field is not used by the application.",
    ]
    if agg["total"]:
        notes.append("Top positions: " + ", ".join(f"{p['job__title']} {p['n']}" for p in positions) + ".")
    return ReportResult(
        rows=rows,
        summary=[
            {"label": "Applicants", "value": agg["total"], "format": "integer"},
            *({"label": lab, "value": agg[s], "format": "integer"} for s, lab in APPLICANT_STATUSES),
        ],
        notes=notes,
    )


register(ReportSpec(
    id="applicant-register",
    title="Applicant Register",
    description="Applicants from the public job board with their status and notes.",
    category="employees",
    icon="UserPlus",
    tags=("applicants", "job applications", "candidates", "job board"),
    family="job-board",
    variant="Applicants",
    modules=("recruitment",),
    filters=(
        date_range("thisMonth", label="Applied between"),
        select("status", "Status", APPLICANT_STATUSES, multi=True, placeholder="All statuses"),
        branches(),
        departments(),
        text("jobTitle", "Position", "Job title contains"),
    ),
    columns=(
        ColumnSpec("appliedOn", "Applied", DATE, 1.1),
        ColumnSpec("name", "Name", TEXT, 2.0),
        ColumnSpec("phone", "Phone", TEXT, 1.2),
        ColumnSpec("email", "Email", TEXT, 2.0),
        ColumnSpec("jobTitle", "Position", TEXT, 1.8),
        ColumnSpec("department", "Department", TEXT, 1.4),
        ColumnSpec("experience", "Experience", TEXT, 1.4),
        ColumnSpec("status", "Status", BADGE, 0.9),
        ColumnSpec("notes", "Notes", TEXT, 2.0),
    ),
    run=_run_applicants,
))


# ── Resume Screening Pipeline ───────────────────────────────────────────────

_SOURCES = (("single", "Single upload"), ("bulk", "Bulk upload"))


def _run_screening(ctx):
    q = org_q(ctx, **_CANDIDATE_ORG) & ist_range_q("created_at", ctx.date_from, ctx.date_to)
    statuses = ctx.param("status", [])
    if statuses:
        q &= Q(status__in=statuses)
    source = ctx.param("source")
    if source:
        q &= Q(source=source)
    min_score = ctx.param("minScore")
    if min_score is not None:
        q &= Q(match_score__gte=min_score)
    base = ScreeningCandidate.objects.filter(q)
    cands = (
        base.select_related("rule_set", "department", "department__branch")
        .defer("raw_text_excerpt", "score_breakdown")
        .order_by("-created_at", "-id")[: ctx.row_limit]
    )
    rows = [
        {
            "createdAt": fmt_dt(c.created_at),
            "candidateName": c.candidate_name or None,
            "phone": c.phone or None,
            "email": c.email or None,
            "city": c.city or None,
            "department": _dept_text(c.department),
            "ruleSet": c.rule_set.name,
            "source": label(c.source),
            "experienceYears": float(c.extracted_experience_years) if c.extracted_experience_years is not None else None,
            "education": c.extracted_education or None,
            "matchScore": float(c.match_score) if c.match_score is not None else None,
            "rankInBatch": c.rank_in_batch,
            "status": _CANDIDATE_LABEL.get(c.status, label(c.status, "Unknown")),
            "interviewInvitedAt": fmt_dt(c.interview_invited_at),
            "interviewDatetime": fmt_dt(c.interview_datetime),
            "resumeOnFile": "On file" if c.resume_file else "Removed",
            "notes": c.notes or None,
        }
        for c in cands
    ]
    agg = base.order_by().aggregate(
        total=Count("id"),
        shortlisted=Count("id", filter=Q(status="shortlisted")),
        selected=Count("id", filter=Q(status="selected")),
        rejected=Count("id", filter=Q(status="rejected")),
        avg=Avg("match_score"),
        invited=Count("id", filter=Q(interview_invited_at__isnull=False)),
    )
    return ReportResult(
        rows=rows,
        summary=[
            {"label": "Candidates", "value": agg["total"], "format": "integer"},
            {"label": "Shortlisted", "value": agg["shortlisted"], "format": "integer"},
            {"label": "Selected", "value": agg["selected"], "format": "integer"},
            {"label": "Rejected", "value": agg["rejected"], "format": "integer"},
            {"label": "Average match score", "value": round(float(agg["avg"]), 2) if agg["avg"] is not None else None, "format": "number"},
            {"label": "Interview invites sent", "value": agg["invited"], "format": "integer"},
        ],
        notes=[
            "Match score is left blank for candidates that were uploaded but not scored; rank only exists for bulk uploads.",
            "'Removed' = the resume file no longer exists: it is deleted when a candidate is rejected and after 10 days "
            "for candidates who were neither selected nor rejected. The screening details are kept.",
            "Candidates screened for a rule set with no department are listed for unscoped users only. "
            "Resume files and their links are never included.",
        ],
    )


register(ReportSpec(
    id="screening-pipeline",
    title="Resume Screening Pipeline",
    description="Screened candidates with match score, pipeline status and interview timestamps.",
    category="employees",
    icon="ScanLine",
    tags=("resume screening", "ats", "candidates", "shortlist", "match score"),
    family="resume-screening",
    variant="Pipeline",
    modules=("recruitment.resume_screening",),
    filters=(
        date_range("thisMonth", label="Screened between"),
        select("status", "Status", CANDIDATE_STATUSES, multi=True, placeholder="All statuses"),
        select("source", "Source", _SOURCES, placeholder="Any"),
        branches(),
        departments(),
        number("minScore", "Minimum match score", default=None, min=0, max=100),
    ),
    columns=(
        ColumnSpec("createdAt", "Uploaded", DATETIME, 1.3),
        ColumnSpec("candidateName", "Candidate", TEXT, 2.0),
        ColumnSpec("phone", "Phone", TEXT, 1.2),
        ColumnSpec("email", "Email", TEXT, 2.0),
        ColumnSpec("city", "City", TEXT, 1.1),
        ColumnSpec("department", "Department", TEXT, 1.4),
        ColumnSpec("ruleSet", "Hiring Criteria", TEXT, 1.6),
        ColumnSpec("source", "Source", BADGE, 0.8),
        ColumnSpec("experienceYears", "Exp. (yrs)", NUMBER, 0.8),
        ColumnSpec("education", "Education", TEXT, 1.4),
        ColumnSpec("matchScore", "Match Score", NUMBER, 0.9),
        ColumnSpec("rankInBatch", "Rank", INTEGER, 0.6),
        ColumnSpec("status", "Status", BADGE, 1.0),
        ColumnSpec("interviewInvitedAt", "Invited At", DATETIME, 1.3),
        ColumnSpec("interviewDatetime", "Interview", DATETIME, 1.3),
        ColumnSpec("resumeOnFile", "Resume", BADGE, 0.8),
        ColumnSpec("notes", "Notes", TEXT, 1.6),
    ),
    run=_run_screening,
))


# ── Interview Schedule ──────────────────────────────────────────────────────

_INVITED = (("all", "All"), ("invited", "Invited"), ("pending_invite", "Selected - invite pending"))
_WHEN = (("all", "Any time"), ("upcoming", "Today onwards"), ("past", "Before today"), ("unscheduled", "No interview date"))


def _run_interviews(ctx):
    scope_q = org_q(ctx, **_CANDIDATE_ORG)
    base = ScreeningCandidate.objects.filter(scope_q).filter(Q(status="selected") | Q(interview_datetime__isnull=False))
    today_start = ist_start(ctx.today)
    q = Q()
    invited = ctx.param("invited", "all")
    if invited == "invited":
        q &= Q(interview_invited_at__isnull=False)
    elif invited == "pending_invite":
        q &= Q(status="selected", interview_invited_at__isnull=True)
    when = ctx.param("when", "all")
    if when == "upcoming":
        q &= Q(interview_datetime__gte=today_start)
    elif when == "past":
        q &= Q(interview_datetime__lt=today_start)
    elif when == "unscheduled":
        q &= Q(interview_datetime__isnull=True)
    cands = (
        base.filter(q)
        .select_related("rule_set", "department")
        .defer("raw_text_excerpt", "score_breakdown")
        .order_by(F("interview_datetime").asc(nulls_last=True), "candidate_name", "id")[: ctx.row_limit]
    )
    rows = []
    for c in cands:
        if c.interview_invited_at:
            state = "Invited"
        elif c.status == "selected":
            state = "Pending invite"
        else:
            state = None
        rows.append({
            "interviewDatetime": fmt_dt(c.interview_datetime),
            "candidateName": c.candidate_name or None,
            "phone": c.phone or None,
            "email": c.email or None,
            "department": _dept_text(c.department),
            "ruleSet": c.rule_set.name,
            "matchScore": float(c.match_score) if c.match_score is not None else None,
            "status": _CANDIDATE_LABEL.get(c.status, label(c.status, "Unknown")),
            "invitedAt": fmt_dt(c.interview_invited_at),
            "inviteState": state,
            "notes": c.notes or None,
        })
    week_end = today_start + timedelta(days=7)
    agg = base.order_by().aggregate(
        scheduled=Count("id", filter=Q(interview_datetime__isnull=False)),
        pending=Count("id", filter=Q(status="selected", interview_invited_at__isnull=True)),
        upcoming=Count("id", filter=Q(interview_datetime__gte=today_start, interview_datetime__lt=week_end)),
    )
    return ReportResult(
        rows=rows,
        summary=[
            {"label": "Interviews scheduled", "value": agg["scheduled"], "format": "integer"},
            {"label": "Invites pending", "value": agg["pending"], "format": "integer"},
            {"label": "Interviews in next 7 days", "value": agg["upcoming"], "format": "integer"},
        ],
        notes=[
            "Lists screened candidates who are 'selected' or already have an interview date/time. 'Pending invite' = "
            "selected but no interview invitation sent yet; those rows have no date and sort last.",
            "Summary cards ignore the Invite and When filters. Interview times are shown in IST.",
        ],
    )


register(ReportSpec(
    id="interview-schedule",
    title="Interview Schedule",
    description="Selected candidates with interview date/time and invitation status; pending invites highlighted.",
    category="employees",
    icon="CalendarClock",
    tags=("interviews", "candidates", "invite", "schedule"),
    family="resume-screening",
    variant="Interviews",
    modules=("recruitment.resume_screening",),
    filters=(
        select("invited", "Invitation", _INVITED, default="all"),
        select("when", "Interview date", _WHEN, default="all"),
        branches(),
        departments(),
    ),
    columns=(
        ColumnSpec("interviewDatetime", "Interview", DATETIME, 1.4),
        ColumnSpec("candidateName", "Candidate", TEXT, 2.0),
        ColumnSpec("phone", "Phone", TEXT, 1.2),
        ColumnSpec("email", "Email", TEXT, 2.0),
        ColumnSpec("department", "Department", TEXT, 1.4),
        ColumnSpec("ruleSet", "Hiring Criteria", TEXT, 1.6),
        ColumnSpec("matchScore", "Match Score", NUMBER, 0.9),
        ColumnSpec("status", "Status", BADGE, 1.0),
        ColumnSpec("invitedAt", "Invited At", DATETIME, 1.3),
        ColumnSpec("inviteState", "Invitation", BADGE, 1.1),
        ColumnSpec("notes", "Notes", TEXT, 1.6),
    ),
    run=_run_interviews,
))


# ── Recruitment Funnel ──────────────────────────────────────────────────────

def _run_funnel(ctx):
    cand_q = org_q(ctx, **_CANDIDATE_ORG) & ist_range_q("created_at", ctx.date_from, ctx.date_to)
    app_q = org_q(ctx, **_APPLICANT_ORG) & ist_range_q("created_at", ctx.date_from, ctx.date_to)
    cand = {
        r["department_id"]: r
        for r in ScreeningCandidate.objects.filter(cand_q)
        .order_by()
        .values("department_id")
        .annotate(
            total=Count("id"),
            pending=Count("id", filter=Q(status__in=("uploaded", "screened"))),
            not_short=Count("id", filter=Q(status="not_shortlisted")),
            short=Count("id", filter=Q(status="shortlisted")),
            selected=Count("id", filter=Q(status="selected")),
            rejected=Count("id", filter=Q(status="rejected")),
            avg=Avg("match_score"),
        )
    }
    apps = {
        r["job__department_id"]: r
        for r in Applicant.objects.filter(app_q)
        .order_by()
        .values("job__department_id")
        .annotate(total=Count("id"), selected=Count("id", filter=Q(status="selected")))
    }
    dept_ids = {d for d in (*cand, *apps) if d is not None}
    depts = {d.id: d for d in Department.objects.filter(id__in=dept_ids).select_related("branch")}

    def sort_key(dept_id):
        d = depts.get(dept_id)
        return (1, "", "", 0) if d is None else (0, d.name.lower(), (d.branch.name.lower() if d.branch_id else ""), d.id)

    rows = []
    for dept_id in sorted({*cand, *apps}, key=sort_key):
        c = cand.get(dept_id, {})
        a = apps.get(dept_id, {})
        total = c.get("total", 0)
        short, sel = c.get("short", 0), c.get("selected", 0)
        d = depts.get(dept_id)
        rows.append({
            "branch": _branch_text(d),
            "department": _dept_text(d),
            "candidates": total,
            "pending": c.get("pending", 0),
            "notShortlisted": c.get("not_short", 0),
            "shortlisted": short,
            "selected": sel,
            "rejected": c.get("rejected", 0),
            "avgScore": round(float(c["avg"]), 2) if c.get("avg") is not None else None,
            "progressPct": pct(short + sel, total),
            "selectPct": pct(sel, total),
            "applicants": a.get("total", 0),
            "applicantsSelected": a.get("selected", 0),
        })
    total = sum(r["candidates"] for r in rows)
    short = sum(r["shortlisted"] for r in rows)
    sel = sum(r["selected"] for r in rows)
    return ReportResult(
        rows=rows,
        summary=[
            {"label": "Screened candidates", "value": total, "format": "integer"},
            {"label": "Shortlisted or selected", "value": pct(short + sel, total), "format": "percent"},
            {"label": "Selected", "value": pct(sel, total), "format": "percent"},
            {"label": "Job-board applicants", "value": sum(r["applicants"] for r in rows), "format": "integer"},
        ],
        notes=[
            "Two independent pipelines: resume-screening candidates (columns Candidates to Select %) and job-board "
            "applicants (last two columns). They are never added together.",
            "Stages are each candidate's CURRENT status - the system keeps no history, so a candidate rejected after "
            "being shortlisted cannot be told apart from one rejected at screening. 'Shortlisted or selected %' and "
            "'Selected %' are therefore lower bounds; both use all candidates in the period as the base.",
            "Department 'Unassigned' (no department) appears for unscoped users only.",
        ],
    )


register(ReportSpec(
    id="recruitment-funnel",
    title="Recruitment Funnel",
    description="Department-wise counts through resume screening and the job board, with conversion rates.",
    category="employees",
    icon="Layers",
    tags=("funnel", "conversion", "shortlist", "selection rate", "recruitment"),
    modules=("recruitment",),
    filters=(date_range("thisMonth", label="Uploaded / applied between"), branches(), departments()),
    columns=(
        ColumnSpec("branch", "Branch", TEXT, 1.2),
        ColumnSpec("department", "Department", TEXT, 1.8),
        ColumnSpec("candidates", "Candidates", INTEGER, 0.9, total="sum"),
        ColumnSpec("pending", "Awaiting Decision", INTEGER, 1.0, total="sum"),
        ColumnSpec("notShortlisted", "Not Shortlisted", INTEGER, 1.0, total="sum"),
        ColumnSpec("shortlisted", "Shortlisted", INTEGER, 0.9, total="sum"),
        ColumnSpec("selected", "Selected", INTEGER, 0.9, total="sum"),
        ColumnSpec("rejected", "Rejected", INTEGER, 0.9, total="sum"),
        ColumnSpec("avgScore", "Avg Score", NUMBER, 0.8),
        ColumnSpec("progressPct", "Shortlisted+ %", PERCENT, 1.0),
        ColumnSpec("selectPct", "Selected %", PERCENT, 0.9),
        ColumnSpec("applicants", "Job-board Applicants", INTEGER, 1.1, total="sum"),
        ColumnSpec("applicantsSelected", "Applicants Selected", INTEGER, 1.1, total="sum"),
    ),
    run=_run_funnel,
))


# ── Hiring Criteria (rule sets) ─────────────────────────────────────────────

_ACTIVE = (("active", "Active"), ("inactive", "Inactive"), ("all", "All"))


def _run_criteria(ctx):
    q = org_q(ctx, **_DEPT_ORG)
    state = ctx.param("active", "all")
    if state == "active":
        q &= Q(is_active=True)
    elif state == "inactive":
        q &= Q(is_active=False)
    sets = list(
        HiringRuleSet.objects.filter(q)
        .select_related("department", "department__branch")
        .annotate(n=Count("candidates"))
        .order_by("department__name", "name", "id")
    )
    rows = [
        {
            "name": s.name,
            "department": _dept_text(s.department),
            "branch": _branch_text(s.department),
            "requiredSkills": join_list(s.required_skills),
            "softSkills": join_list(s.soft_skills),
            "education": s.education_qualification or None,
            "minExperienceYears": float(s.min_experience_years) if s.min_experience_years is not None else None,
            "preferredCity": s.preferred_city or None,
            "isActive": "Active" if s.is_active else "Inactive",
            "candidates": s.n,
            "updatedOn": ist_date(s.updated_at),
        }
        for s in sets
    ]
    return ReportResult(
        rows=rows,
        summary=[
            {"label": "Rule sets", "value": len(rows), "format": "integer"},
            {"label": "Active rule sets", "value": sum(1 for s in sets if s.is_active), "format": "integer"},
            {"label": "Candidates screened", "value": sum(s.n for s in sets), "format": "integer"},
        ],
        notes=["Hiring criteria are the department rule sets resumes are scored against."],
    )


register(ReportSpec(
    id="hiring-criteria",
    title="Hiring Criteria",
    description="Department hiring rule sets used to score resumes: skills, education, experience.",
    category="employees",
    icon="ClipboardList",
    tags=("rule sets", "resume scoring", "requirements", "skills"),
    family="resume-screening",
    variant="Criteria",
    modules=("recruitment.resume_screening",),
    filters=(branches(), departments(), select("active", "Status", _ACTIVE, default="all")),
    columns=(
        ColumnSpec("name", "Rule Set", TEXT, 1.8),
        ColumnSpec("department", "Department", TEXT, 1.4),
        ColumnSpec("branch", "Branch", TEXT, 1.2),
        ColumnSpec("requiredSkills", "Required Skills", TEXT, 2.6),
        ColumnSpec("softSkills", "Soft Skills", TEXT, 2.0),
        ColumnSpec("education", "Education", TEXT, 1.6),
        ColumnSpec("minExperienceYears", "Min Exp. (yrs)", NUMBER, 0.9),
        ColumnSpec("preferredCity", "Preferred City", TEXT, 1.2),
        ColumnSpec("isActive", "Status", BADGE, 0.8),
        ColumnSpec("candidates", "Candidates", INTEGER, 0.9, total="sum"),
        ColumnSpec("updatedOn", "Updated", DATE, 1.0),
    ),
    run=_run_criteria,
))

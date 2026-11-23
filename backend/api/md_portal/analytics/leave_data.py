"""MD portal, Leave & Holiday: where the figures come from (the data layer of ``analytics/leave.py``).

Every leave figure on the MD's Leave & Holiday page is built from one list of **leave days**: one entry per employee per
calendar day on which the employee was on *approved* leave. This module builds that list with the very same rules as the
attendance analytics (``analytics/attendance.py``, ``_leave_days_by_type``), so a leave figure here and the same figure
on the Attendance page or in the assistant can never disagree:

* only **approved** requests count (pending and rejected never do);
* a request contributes its Monday to Saturday dates (Sundays are skipped: the rule that produced its stored
  ``total_days``); a request for part of the period is **clipped** to the period, so leave that spans a boundary counts
  only the days inside it; holidays are NOT skipped (the leave was still taken);
* a half-day request counts 0.5 on its single date;
* when two requests cover the same employee-day, only the first one (lowest id) counts;
* **production** employees are left out: the attendance engine ignores leave for them;
* **casual leave** (its own system, a paid day) is added as the type "Casual leave": a full day is 1, a half day (first or
  second half of the shift, since 2026-11-04) is 0.5, as cl_balance.PORTION_DAYS counts it.

Casual Leave has its own yearly balance since 2026-11-02 (cl_balance.py): 12 days a calendar year from the cut-over
(PayrollSettings.cl_balance_since), pending and approved days both hold balance, a half day is 0.5, and a Casual Leave HR
gives for an absent / on-leave date on the Carry Forward tab (approval trail ``via: "carry_forward"``) counts whatever its
date. ``load_cl_balances`` reads that balance directly (cl_balance's own helpers read settings through ``get()``, which may
create a row and cannot run inside the MD's read-only transaction).

Leave requests keep their dates as TEXT (``start_date`` / ``end_date``), so the overlap is decided on the ISO strings in
SQL and the days are expanded in Python: the number of queries never depends on the number of requests.

Nothing here writes. ``LeaveType`` is read once; no ``get()`` that creates a row is used.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import date, datetime, timedelta
from types import SimpleNamespace

from django.db.models import Count

from ...clock import ist_today
from ...models import (
    AttendanceOverrideRequest,
    CasualLeaveRequest,
    Holiday,
    LeaveBalance,
    LeaveRequest,
    PayrollSettings,
)
from ...reporting.definitions.requests_leave_common import (
    LeaveTypeCatalog,
    ist_bounds,
    ist_date,
    leave_dates,
    leave_overlap_q,
    leave_year_q,
    parse_leave_range,
    status_key,
)
from ...reporting.formatting import parse_date
from ..common import MdParamError, Scope

CASUAL_KEY = "casual-paid"
CASUAL_LABEL = "Casual leave"
NO_DEPARTMENT = "No department"
NO_UNIT = "No unit"
NONE_KEY = "__none__"
WEEKDAYS = ("Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun")
SUNDAY = 6

#: The employee columns every query here asks for (so a row can name the person, department and unit without another query).
EMP_VALUES = (
    "employee__employee_code",
    "employee__first_name",
    "employee__last_name",
    "employee__employment_type",
    "employee__status",
    "employee__department__name",
    "employee__branch__name",
)


def today() -> date:
    """The factory's date. Tests freeze it by patching ``ist_today`` on this module."""
    return ist_today()


# ─── small text helpers (the MD reads text built here as it is) ─────────────────────────────────────────────────


def num(value: float | int | None, places: int = 0) -> str:
    """12,34,567 (Indian grouping)."""
    if value is None:
        return "n/a"
    number = round(float(value), places)
    whole, _, frac = f"{abs(number):.{places}f}".partition(".")
    if len(whole) > 3:
        head, tail = whole[:-3], whole[-3:]
        groups = []
        while len(head) > 2:
            groups.insert(0, head[-2:])
            head = head[:-2]
        if head:
            groups.insert(0, head)
        whole = ",".join([*groups, tail])
    return f"{'-' if number < 0 else ''}{whole}{'.' + frac if frac else ''}"


def pct_text(value: float | None, places: int = 0) -> str:
    return "n/a" if value is None else f"{num(value, places)}%"


def days_text(value: float | int | None) -> str:
    """'12 days', '1 day', '0.5 day', '2.5 days'."""
    if value is None:
        return "n/a"
    whole = float(value) == int(float(value))
    return f"{num(value, 0 if whole else 1)} {'day' if float(value) == 1 else 'days'}"


def plural(n: int | float, one: str, many: str | None = None) -> str:
    return one if n == 1 else (many or one + "s")


def short_date(day: date | str | None) -> str:
    if day is None:
        return "n/a"
    if isinstance(day, str):
        day = date.fromisoformat(day)
    return f"{day.day:02d} {day.strftime('%b')}"


def weekday_date(day: date) -> str:
    return f"{WEEKDAYS[day.weekday()]} {short_date(day)}"


def int_arg(value, name: str, default: int, low: int, high: int) -> int:
    """A whole-number parameter: ``default`` when absent, clamped into [low, high] when given, a readable error when it
    is not a number."""
    if value is None or value == "":
        return default
    try:
        number = int(value)
    except (TypeError, ValueError):
        raise MdParamError(f"'{name}' must be a whole number between {low} and {high}.") from None
    return max(low, min(high, number))


def previous_phrase(days: int) -> str:
    if days == 1:
        return "the day before"
    if days == 7:
        return "the 7 days before"
    return f"the previous {days} days"


def daterange(start: date, end: date):
    day = start
    while day <= end:
        yield day
        day += timedelta(days=1)


# ─── who ────────────────────────────────────────────────────────────────────────────────────────────────────────


@dataclass(frozen=True, slots=True)
class Who:
    """The columns of an employee that an answer needs. Names are only ever shown in ``employeeName`` fields (the privacy
    layer pseudonymises those before anything is sent to the model); no contact or bank detail is read at all."""

    id: int
    code: str
    name: str
    kind: str  # "staff" | "production"
    status: str
    dept: str
    unit: str


def who_from(row: dict, employee_id: int) -> Who:
    first, last, code = (
        row.get("employee__first_name"),
        row.get("employee__last_name"),
        row.get("employee__employee_code"),
    )
    return Who(
        id=employee_id,
        code=code or "",
        name=f"{first or ''} {last or ''}".strip() or (code or f"#{employee_id}"),
        kind=row.get("employee__employment_type") or "staff",
        status=row.get("employee__status") or "",
        dept=row.get("employee__department__name") or NO_DEPARTMENT,
        unit=row.get("employee__branch__name") or NO_UNIT,
    )


def person_row(who: Who) -> dict:
    """The part of a list row that identifies a person (the name is the privacy-safe ``employeeName`` field)."""
    return {"employeeCode": who.code, "employeeName": who.name, "department": who.dept, "unit": who.unit}


# ─── the leave types ────────────────────────────────────────────────────────────────────────────────────────────

_SICK_WORDS = ("sick", "medical")
_SICK_CODES = {"sl", "ml"}


@dataclass(frozen=True, slots=True)
class TypeMeta:
    key: str
    label: str
    code: str | None
    paid: bool | None
    sick: bool


def type_meta(key: str, label: str, code: str | None, paid: bool | None) -> TypeMeta:
    low = label.lower()
    sick = any(w in low for w in _SICK_WORDS) or (code or "").strip().lower() in _SICK_CODES
    return TypeMeta(key, label, code, paid, sick)


# ─── the facts ──────────────────────────────────────────────────────────────────────────────────────────────────


@dataclass(frozen=True, slots=True)
class Req:
    """One approved leave request (or casual-leave day, with a negative id)."""

    id: int
    employee_id: int
    type_key: str
    start: date
    end: date
    total: float
    half: bool
    slot: str | None
    applied: date | None  # the factory date it was applied for
    reason_category: str | None = None  # sick | emergency | personal | other (the apps' reason picker), None if not given
    assigned: bool = False  # a Casual Leave HR gave for an absent / on-leave date (Carry Forward tab)

    @property
    def notice(self) -> int | None:
        """Days between applying and the first day of leave: 0 = applied on the day, negative = after it started."""
        return None if self.applied is None else (self.start - self.applied).days


@dataclass
class Facts:
    """Approved leave days between ``lo`` and ``hi`` (inclusive), expanded one entry per employee-day."""

    lo: date
    hi: date
    #: (employee id, day, weight 1.0 or 0.5, leave type key, request id)
    days: list[tuple[int, date, float, str, int]] = field(default_factory=list)
    who: dict[int, Who] = field(default_factory=dict)
    types: dict[str, TypeMeta] = field(default_factory=dict)
    reqs: dict[int, Req] = field(default_factory=dict)
    #: approved requests of production employees that overlap the window (attendance ignores them, so do we)
    production_requests: int = 0
    #: approved requests whose dates cannot be read (start or end is not a date, or the end is before the start)
    unreadable: int = 0

    def between(self, lo: date, hi: date):
        """The leave days inside [lo, hi]."""
        for entry in self.days:
            if lo <= entry[1] <= hi:
                yield entry


def load_facts(scope: Scope, lo: date, hi: date) -> Facts:
    """The approved leave days of everyone in ``scope`` inside [lo, hi]: three queries (leave types, requests, casual
    leave) however many requests there are."""
    facts = Facts(lo=lo, hi=hi)
    catalog = LeaveTypeCatalog()
    requests = (
        LeaveRequest.objects.filter(scope.employee_q("employee__"), status="approved")
        .filter(leave_overlap_q(lo, hi))
        .order_by("id")
        .values(
            "id",
            "employee_id",
            "leave_type_ref_id",
            "type",
            "start_date",
            "end_date",
            "total_days",
            "is_half_day",
            "half_day_slot",
            "reason_category",
            "created_at",
            *EMP_VALUES,
        )
    )
    seen: set[tuple[int, date]] = set()
    for row in requests:
        eid = row["employee_id"]
        who = facts.who.get(eid) or who_from(row, eid)
        if who.kind == "production":
            facts.production_requests += 1
            continue
        shim = SimpleNamespace(**row)
        span = parse_leave_range(shim)
        if span is None:
            facts.unreadable += 1
            continue
        info = catalog.resolve(shim)
        facts.types.setdefault(info.key, type_meta(info.key, info.label, info.code, info.is_paid))
        weight = 0.5 if row["is_half_day"] else 1.0
        counted = False
        for day in leave_dates(shim, span[0], span[1], lo, hi):
            if (eid, day) in seen:
                continue
            seen.add((eid, day))
            facts.days.append((eid, day, weight, info.key, row["id"]))
            counted = True
        if counted:
            facts.who[eid] = who
            facts.reqs[row["id"]] = Req(
                id=row["id"],
                employee_id=eid,
                type_key=info.key,
                start=span[0],
                end=span[1],
                total=float(row["total_days"] or 1),
                half=bool(row["is_half_day"]),
                slot=row["half_day_slot"],
                applied=ist_date(row["created_at"]),
                reason_category=row["reason_category"] or None,
            )

    casual = (
        CasualLeaveRequest.objects.filter(scope.employee_q("employee__"), status="approved", date__gte=lo, date__lte=hi)
        .order_by("id")
        .values("id", "employee_id", "date", "portion", "approval_trail", "created_at", *EMP_VALUES)
    )
    for row in casual:
        eid = row["employee_id"]
        facts.who.setdefault(eid, who_from(row, eid))
        facts.types.setdefault(CASUAL_KEY, type_meta(CASUAL_KEY, CASUAL_LABEL, None, True))
        weight = portion_days(row["portion"])
        facts.days.append((eid, row["date"], weight, CASUAL_KEY, -row["id"]))
        facts.reqs[-row["id"]] = Req(
            id=-row["id"],
            employee_id=eid,
            type_key=CASUAL_KEY,
            start=row["date"],
            end=row["date"],
            total=weight,
            half=weight < 1,
            slot=row["portion"] if weight < 1 else None,
            applied=ist_date(row["created_at"]),
            assigned=is_carry_forward(row["approval_trail"]),
        )
    return facts


# ─── Casual Leave: portions, carry-forward and the yearly balance (cl_balance.py, read directly) ─────────────────

# the yearly allocation's starting value; the Casual Leave policy in Settings decides now (cl_balance.policy())
CL_ENTITLEMENT = 12
CL_HALF_PORTIONS = ("first_half", "second_half")
CL_PORTION_LABEL = {"full": "Full day", "first_half": "Half day (first half)", "second_half": "Half day (second half)"}
CL_ASSIGN_VIA = "carry_forward"
CL_DEFAULT_SINCE = date(2026, 11, 2)
#: A balance this close to nothing is "running low".
CL_LOW_DAYS = 2.0


def portion_days(portion: str | None) -> float:
    """A Casual Leave's days: 0.5 for a first / second half, 1 for a full day (or an older row with no portion)."""
    return 0.5 if portion in CL_HALF_PORTIONS else 1.0


def is_carry_forward(trail) -> bool:
    """A Casual Leave HR gave for an absent / on-leave date on the Carry Forward tab (cl_balance.is_assigned_cl)."""
    return isinstance(trail, list) and any(isinstance(e, dict) and str(e.get("via") or "") == CL_ASSIGN_VIA for e in trail)


def cl_cut_over() -> date:
    """The day Casual Leave started counting against the yearly balance (PayrollSettings.cl_balance_since), read without
    creating the settings row."""
    value = PayrollSettings.objects.filter(pk=1).values_list("cl_balance_since", flat=True).first()
    if isinstance(value, str):
        value = date.fromisoformat(value[:10])
    return value or CL_DEFAULT_SINCE


@dataclass
class ClBalance:
    """One staff member's Casual Leave year."""

    who: Who
    used: float = 0.0  # approved days that count against the year
    pending: float = 0.0  # days held by requests (or HR attendance-edit proposals) still waiting
    assigned_days: float = 0.0  # of `used`: given by HR for absent / on-leave dates (Carry Forward)
    assigned_dates: list[str] = field(default_factory=list)
    half_days: int = 0  # half-day Casual Leave pieces among them
    given: float = 0.0  # what the policy has given so far this year (carried in + the months so far, or the year's days)
    left: float | None = None  # what may still be asked for now (cl_balance's own reading)

    @property
    def remaining(self) -> float:
        if self.left is not None:
            return self.left
        return max(0.0, self.given - self.used - self.pending)


_PEOPLE_VALUES = (
    "id",
    "employee_code",
    "first_name",
    "last_name",
    "employment_type",
    "status",
    "department__name",
    "branch__name",
)


def load_cl_balances(scope: Scope, year: int) -> tuple[list[ClBalance], dict]:
    """The Casual Leave balance of every active staff member in ``scope`` for ``year``. used / pending / Carry Forward /
    half days are counted here (approved + pending days dated in the year from max(cut-over, 1 January), a Carry Forward
    Casual Leave whatever its date; a half day 0.5); what the policy gave and what is left come from cl_balance itself
    (the Casual Leave policy in Settings: days a month or a year, carry forward, the employee's own start after their
    service), so the MD sees the HRMS's own balance. A Casual Leave on a not-worked birthday under the new birthday rule
    uses no balance in the HRMS; the used figure here does not tell it apart.
    Returns (rows, meta) with meta = {"cutOver", "since", "tracked", "allocationText", "yearDays"}."""
    cut_over = cl_cut_over()
    first = max(cut_over, date(year, 1, 1))
    last = date(year, 12, 31)
    from api import cl_balance

    pol = cl_balance.policy()
    meta = {
        "cutOver": cut_over.isoformat(),
        "since": first.isoformat() if first <= last else None,
        "tracked": first <= last,
        "allocationText": pol.allocation_text(),
        "yearDays": float(pol.monthly * 12 if pol.monthly_mode else pol.yearly),
    }
    rows: dict[int, ClBalance] = {}
    for p in scope.employees().exclude(employment_type="production").order_by("id").values(*_PEOPLE_VALUES):
        shim = {f"employee__{k}": v for k, v in p.items() if k != "id"}
        rows[p["id"]] = ClBalance(who=who_from(shim, p["id"]))
    if not rows or first > last:
        return list(rows.values()), meta
    for cl in (
        CasualLeaveRequest.objects.filter(
            employee_id__in=list(rows), date__gte=date(year, 1, 1), date__lte=last, status__in=("pending", "approved")
        )
        .order_by("date", "id")
        .values("employee_id", "date", "portion", "status", "approval_trail")
    ):
        assigned = is_carry_forward(cl["approval_trail"])
        if cl["date"] < first and not assigned:
            continue
        row = rows[cl["employee_id"]]
        days = portion_days(cl["portion"])
        if cl["status"] == "approved":
            row.used += days
        else:
            row.pending += days
        if assigned:
            row.assigned_days += days
            row.assigned_dates.append(cl["date"].isoformat())
        if days < 1:
            row.half_days += 1
    for req in AttendanceOverrideRequest.objects.filter(
        employee_id__in=list(rows),
        date__gte=first,
        date__lte=last,
        status=AttendanceOverrideRequest.STATUS_PENDING,
        requested_values__option="casual_leave",
    ).values("employee_id", "requested_values"):
        rows[req["employee_id"]].pending += portion_days((req["requested_values"] or {}).get("portion"))
    for emp_id, led in cl_balance.ledgers(list(rows), year, cut_over, pol).items():
        block = cl_balance.balance_json(led, cut_over)
        rows[emp_id].given = float(block["total"])
        rows[emp_id].left = float(block["remaining"])
    return list(rows.values()), meta


# ─── headcount and working days (the denominators) ──────────────────────────────────────────────────────────────


@dataclass
class Heads:
    """Active employees that leave applies to (production is left out, as in attendance), in total and by department
    name / unit name (a department with the same name in several units is one department, as everywhere in the portal)."""

    total: int = 0
    by_dept: dict[str, int] = field(default_factory=dict)
    by_unit: dict[str, int] = field(default_factory=dict)


def load_heads(scope: Scope) -> Heads:
    heads = Heads()
    rows = (
        scope.employees()
        .exclude(employment_type="production")
        .order_by()
        .values("department__name", "branch__name")
        .annotate(n=Count("id"))
    )
    for row in rows:
        dept, unit, n = row["department__name"] or NO_DEPARTMENT, row["branch__name"] or NO_UNIT, row["n"]
        heads.total += n
        heads.by_dept[dept] = heads.by_dept.get(dept, 0) + n
        heads.by_unit[unit] = heads.by_unit.get(unit, 0) + n
    return heads


def holiday_names(lo: date, hi: date) -> dict[date, str]:
    """{date: holiday name} for [lo, hi] (two holidays on one date are joined). The attendance engine applies every
    holiday row to everyone, whatever branch or department is written on it, so this is not narrowed to a scope."""
    names: dict[date, str] = {}
    for day, name in (
        Holiday.objects.filter(date__gte=lo, date__lte=hi).order_by("date", "id").values_list("date", "name")
    ):
        names[day] = f"{names[day]} / {name}" if day in names else name
    return names


def holiday_dates(lo: date, hi: date) -> set[date]:
    """Dates that are a holiday in [lo, hi]."""
    return set(holiday_names(lo, hi))


def working_days(lo: date, hi: date, holidays: set[date]) -> int:
    """Monday-to-Saturday dates in [lo, hi] that are not a holiday: the days leave can be taken (Sundays are not counted,
    as in the leave-day rule)."""
    return sum(1 for d in daterange(lo, hi) if d.weekday() != SUNDAY and d not in holidays)


# ─── applications (what was asked for, whatever the answer) ─────────────────────────────────────────────────────


@dataclass(frozen=True, slots=True)
class Application:
    """One leave request as HR sees it in the approval queue."""

    id: int
    who: Who
    status: str  # pending | approved | rejected | other
    type_label: str
    type_key: str
    start: date | None
    end: date | None
    total: float
    half: bool
    applied: date | None
    applied_at: datetime | None
    decided_at: datetime | None  # when the last recorded decision was made (None for older requests)
    stage: str  # who has approved so far, in words
    notice: int | None
    reason_category: str | None = None  # sick | emergency | personal | other, None when not given
    reason: str | None = None  # what the employee wrote
    remark: str | None = None  # the decision's remark (the rejection reason of a rejected request)
    decided_by: str | None = None
    half_slot: str | None = None  # morning | afternoon for a half-day leave


def _decision_time(trail) -> datetime | None:
    """When the last decision on the request was recorded (the approval trail keeps the time of each decision)."""
    if not isinstance(trail, list):
        return None
    for entry in reversed(trail):
        if not isinstance(entry, dict) or entry.get("decision") not in ("approved", "rejected"):
            continue
        at = entry.get("at")
        if not at:
            continue
        try:
            moment = datetime.fromisoformat(str(at))
        except ValueError:
            continue
        return moment if moment.tzinfo else None
    return None


def last_decision(trail) -> dict:
    """The last approve / reject entry of an approval trail ({} when there is none)."""
    if not isinstance(trail, list):
        return {}
    for entry in reversed(trail):
        if isinstance(entry, dict) and entry.get("decision") in ("approved", "rejected"):
            return entry
    return {}


def _stage(trail, status: str) -> str:
    if status != "pending":
        return ""
    roles = []
    if isinstance(trail, list):
        for entry in trail:
            if isinstance(entry, dict) and entry.get("decision") == "approved" and entry.get("role"):
                label = {"hod": "HOD", "hr": "HR"}.get(str(entry["role"]).lower(), str(entry["role"]))
                if label not in roles:
                    roles.append(label)
    if not roles:
        return "Not yet looked at"
    return f"Approved by {' and '.join(roles)}, waiting for the next approver"


_APP_VALUES = (
    "id",
    "employee_id",
    "status",
    "type",
    "leave_type_ref_id",
    "start_date",
    "end_date",
    "total_days",
    "is_half_day",
    "created_at",
    "approval_trail",
    "reason_category",
    "reason",
    "hr_comment",
    "approved_by",
    "half_day_slot",
    *EMP_VALUES,
)


def _application(row: dict, catalog: LeaveTypeCatalog) -> Application:
    shim = SimpleNamespace(**row)
    info = catalog.resolve(shim)
    span = parse_leave_range(shim)
    applied_at = row["created_at"]
    applied = ist_date(applied_at)
    status = status_key(row["status"])
    start = span[0] if span else None
    decided = status in ("approved", "rejected")
    last = last_decision(row["approval_trail"]) if decided else {}
    remark = (str(last.get("comment") or "").strip() or (row["hr_comment"] or "").strip() or None) if decided else None
    return Application(
        id=row["id"],
        who=who_from(row, row["employee_id"]),
        status=status,
        type_label=info.label,
        type_key=info.key,
        start=start,
        end=span[1] if span else None,
        total=float(row["total_days"] or 1),
        half=bool(row["is_half_day"]),
        applied=applied,
        applied_at=applied_at,
        decided_at=_decision_time(row["approval_trail"]) if status in ("approved", "rejected") else None,
        stage=_stage(row["approval_trail"], status),
        notice=(start - applied).days if start and applied else None,
        reason_category=row["reason_category"] or None,
        reason=(row["reason"] or "").strip() or None,
        remark=remark,
        decided_by=(str(last.get("by") or "").strip() or (row["approved_by"] or "").strip() or None) if decided else None,
        half_slot=row["half_day_slot"] if row["is_half_day"] else None,
    )


def applications_made(scope: Scope, lo: date, hi: date) -> list[Application]:
    """Requests applied for (created) on the factory days [lo, hi], every status: one query (plus the leave types)."""
    start_at, end_at = ist_bounds(lo, hi)
    catalog = LeaveTypeCatalog()
    rows = (
        LeaveRequest.objects.filter(scope.employee_q("employee__"), created_at__gte=start_at, created_at__lt=end_at)
        .order_by("id")
        .values(*_APP_VALUES)
    )
    return [_application(row, catalog) for row in rows]


def applications_pending(scope: Scope) -> list[Application]:
    """Every request waiting for a decision right now, whatever date it is for (the same rows, scope and status as the
    attendance analytics' pending count), oldest first."""
    catalog = LeaveTypeCatalog()
    rows = (
        LeaveRequest.objects.filter(scope.employee_q("employee__"), status="pending")
        .order_by("created_at", "id")
        .values(*_APP_VALUES)
    )
    return [_application(row, catalog) for row in rows]


# ─── balances (the yearly allocation HR keeps, and what was really taken) ───────────────────────────────────────


@dataclass(frozen=True, slots=True)
class BalanceRow:
    """One employee's allocation of one leave type for a year, with the days taken counted two ways: ``ledger_used`` is
    what HR's balance ledger says, ``used`` is recomputed from the approved requests (the ledger is bumped on approval
    only and can drift, so the recomputed figure is the one the MD reads)."""

    who: Who
    type_key: str
    type_label: str
    code: str | None
    paid: bool
    carry_forward: bool
    max_carry: float
    allocated: float
    ledger_used: float
    used: float


def load_balances(scope: Scope, year: int) -> tuple[list[BalanceRow], float, int]:
    """(balance rows, days taken that have no allocation, requests with an unreadable date) for the active staff in
    ``scope``. Production employees are left out (leave does not apply to them). Three queries."""
    catalog = LeaveTypeCatalog()
    people = {"employee__status": "active"}
    ledger = (
        LeaveBalance.objects.filter(scope.employee_q("employee__"), year=year, leave_type__is_active=True, **people)
        .exclude(employee__employment_type="production")
        .order_by("employee_id", "leave_type_id")
        .values(
            "employee_id",
            "leave_type_id",
            "allocated",
            "used",
            "leave_type__name",
            "leave_type__code",
            "leave_type__is_paid",
            "leave_type__carry_forward",
            "leave_type__max_carry_forward_days",
            *EMP_VALUES,
        )
    )
    taken = (
        LeaveRequest.objects.filter(scope.employee_q("employee__"), status="approved", **people)
        .exclude(employee__employment_type="production")
        .filter(leave_year_q(year))
        .order_by("id")
        .values("employee_id", "leave_type_ref_id", "type", "start_date", "total_days")
    )
    used: dict[tuple[int, str], float] = {}
    unreadable = 0
    for row in taken:
        start = parse_date(row["start_date"])
        if start is None:
            unreadable += 1
            continue
        if start.year != year:
            continue
        key = catalog.resolve(SimpleNamespace(**row)).key
        used[(row["employee_id"], key)] = used.get((row["employee_id"], key), 0.0) + float(row["total_days"] or 1)

    rows: list[BalanceRow] = []
    allocated_keys: set[tuple[int, str]] = set()
    for row in ledger:
        key = f"t{row['leave_type_id']}"
        pair = (row["employee_id"], key)
        allocated_keys.add(pair)
        rows.append(
            BalanceRow(
                who=who_from(row, row["employee_id"]),
                type_key=key,
                type_label=row["leave_type__name"],
                code=row["leave_type__code"],
                paid=bool(row["leave_type__is_paid"]),
                carry_forward=bool(row["leave_type__carry_forward"]),
                max_carry=float(row["leave_type__max_carry_forward_days"] or 0),
                allocated=float(row["allocated"] or 0),
                ledger_used=float(row["used"] or 0),
                used=round(used.get(pair, 0.0), 2),
            )
        )
    without_allocation = round(sum(days for pair, days in used.items() if pair not in allocated_keys), 2)
    return rows, without_allocation, unreadable

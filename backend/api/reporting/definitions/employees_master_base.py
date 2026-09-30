"""Helpers shared by the Employees & Manpower report definitions (group ``employees_master``).

Nothing in this module registers a report. It holds the small, easy-to-get-wrong pieces every one of
those reports needs: natural employee-code ordering, TEXT join dates, gender/status buckets,
"who is the exit date of an inactive employee", masking of identifiers and the one-HOD-per-employee lookup.
"""

from __future__ import annotations

import calendar
import re
from collections import Counter, defaultdict
from dataclasses import dataclass
from datetime import date, datetime, time, timedelta

from django.db.models import F

from api.branch_scope import get_branch_scope
from api.clock import FACTORY_TZ

from ..formatting import MONTH_NAMES, month_bounds, parse_date

ACTIVE = "active"
BLOOD_GROUPS = ("A+", "A-", "B+", "B-", "AB+", "AB-", "O+", "O-")
NO_BRANCH = "No branch"
UNASSIGNED = "Unassigned"

# Statuses of the approved-resignation trail.
BASIS_RESIGNATION = "Resignation"
BASIS_RESIGNATION_APPROVAL = "Resignation (approval date)"
BASIS_APPROX = "Deactivated (approx.)"


# ── ordering ────────────────────────────────────────────────────────────────

_DIGITS = re.compile(r"(\d+)")


def code_key(code) -> tuple:
    """Natural order for employee codes: 'E2' < 'E10' (a plain string sort puts 'E10' first)."""
    text = (code or "").strip()
    parts = _DIGITS.split(text.lower())
    return ([int(p) if i % 2 else p for i, p in enumerate(parts)], text)


def name_key(emp) -> tuple:
    return (f"{emp.first_name or ''} {emp.last_name or ''}".strip().lower(), code_key(emp.employee_code))


# ── employee scoping ────────────────────────────────────────────────────────


def employees_qs(ctx):
    """The report's employees: filters + branch isolation applied, heavy/secret columns never loaded."""
    return ctx.employees().defer("photo_url", "password_hash")


def is_active(emp) -> bool:
    # Payroll, punches and the app screens all mean exactly status == 'active'; anything else is "not active".
    return (emp.status or "") == ACTIVE


def status_label(value) -> str:
    text = (value or "").strip()
    return text.title() if text else "Unknown"


def type_label(value) -> str | None:
    text = (value or "").strip()
    return text.title() if text else None


def gender_bucket(value) -> str:
    """male | female | other | unspecified (case-insensitive; unknown text counts as 'other')."""
    g = (value or "").strip().lower()
    if g in ("male", "female"):
        return g
    return "other" if g else "unspecified"


def gender_label(value) -> str | None:
    text = (value or "").strip()
    if not text:
        return None
    return text.title() if text.lower() in ("male", "female", "other") else text


def department_name(emp) -> str:
    return emp.department.name if emp.department_id else UNASSIGNED


def branch_name(emp) -> str:
    return emp.branch.name if emp.branch_id else NO_BRANCH


def blank(value) -> bool:
    return value is None or not str(value).strip()


def clean(value) -> str | None:
    """Trimmed text, or None when blank (a dash on screen, an empty cell in Excel)."""
    if value is None:
        return None
    text = str(value).strip()
    return text or None


# ── dates ───────────────────────────────────────────────────────────────────


# A join date outside this window is a spreadsheet placeholder ('9999-12-31', '1900-01-01'), not a hire date: it is
# treated as unreadable so date arithmetic on it (probation end, casual-leave date) can never overflow.
MIN_JOIN_YEAR, MAX_JOIN_YEAR = 1950, 2100


def join_date_of(emp) -> tuple[date | None, str]:
    """(date, state): Employee.join_date is TEXT, so it may be empty, junk or absurd. state = ok|missing|unreadable."""
    raw = (emp.join_date or "").strip()
    if not raw:
        return None, "missing"
    parsed = parse_date(raw)
    if parsed and MIN_JOIN_YEAR <= parsed.year <= MAX_JOIN_YEAR:
        return parsed, "ok"
    return None, "unreadable"


def age_on(dob: date | None, ref: date) -> int | None:
    """Completed years on ``ref``; None when the DOB is unknown or lies in the future."""
    if dob is None:
        return None
    years = ref.year - dob.year - ((ref.month, ref.day) < (dob.month, dob.day))
    return years if years >= 0 else None


def months_between(start: date, end: date) -> int:
    """Completed months from start to end -- the same rule the casual-leave screens use for service length."""
    months = (end.year - start.year) * 12 + (end.month - start.month)
    if end.day < start.day:
        months -= 1
    return months


def tenure_text(months: int | None) -> str | None:
    if months is None or months < 0:
        return None
    if months == 0:
        return "<1m"
    years, rest = divmod(months, 12)
    if years and rest:
        return f"{years}y {rest}m"
    return f"{years}y" if years else f"{rest}m"


def add_months(d: date, n: int) -> date:
    """d + n calendar months, clamped to the month end (31-Aug + 6 months = 28/29-Feb); saturates at 31-Dec-9999."""
    year, month0 = divmod(d.year * 12 + d.month - 1 + n, 12)
    if year > date.max.year:
        return date.max
    month = month0 + 1
    return date(year, month, min(d.day, calendar.monthrange(year, month)[1]))


def months_reached_on(start: date, n: int) -> date:
    """First date on which ``months_between(start, date) >= n``.

    Differs from add_months only for month-end joiners: 31-Aug + 6 months has no 31st in February, so the
    sixth completed month is reached on 1-Mar. Saturates at 31-Dec-9999."""
    year, month0 = divmod(start.year * 12 + start.month - 1 + n, 12)
    if year > date.max.year:
        return date.max
    month = month0 + 1
    last = calendar.monthrange(year, month)[1]
    if start.day <= last:
        return date(year, month, start.day)
    try:
        return date(year, month, last) + timedelta(days=1)
    except OverflowError:
        return date.max


def occurrence_in_year(month: int, day: int, year: int) -> date:
    """A yearly anniversary in ``year``; a 29-Feb date is kept on 28-Feb in non-leap years."""
    if month == 2 and day == 29 and not calendar.isleap(year):
        day = 28
    return date(year, month, day)


def occurrence_in_window(month: int, day: int, start: date, end: date) -> date | None:
    """The date within [start, end] on which the (month, day) anniversary falls (windows may wrap Dec -> Jan)."""
    for year in range(start.year, end.year + 1):
        occ = occurrence_in_year(month, day, year)
        if start <= occ <= end:
            return occ
    return None


def ist_date(value) -> date | None:
    """Aware datetimes are stored in UTC; the calendar date the factory saw is the IST one."""
    if value is None:
        return None
    if isinstance(value, datetime):
        if value.tzinfo is not None:
            value = value.astimezone(FACTORY_TZ)
        return value.date()
    return value


def ist_bounds(d_from: date, d_to: date) -> tuple[datetime, datetime]:
    """Aware [start, end) instants of the IST days d_from..d_to (UTC ``__date`` lookups would misfile 00:00-05:30)."""
    start = datetime.combine(d_from, time.min, tzinfo=FACTORY_TZ)
    end = datetime.combine(d_to + timedelta(days=1), time.min, tzinfo=FACTORY_TZ)
    return start, end


WINDOW_OPTIONS = (
    ("thisMonth", "This month"),
    ("nextMonth", "Next month"),
    ("next7", "Next 7 days"),
    ("next30", "Next 30 days"),
    *((f"m{i:02d}", MONTH_NAMES[i - 1]) for i in range(1, 13)),
)


def window_bounds(key: str | None, today: date) -> tuple[date, date]:
    """Resolve a celebrations 'window' choice against today."""
    if key == "next7":
        return today, today + timedelta(days=6)
    if key == "next30":
        return today, today + timedelta(days=29)
    if key == "nextMonth":
        first = add_months(today.replace(day=1), 1)
        return month_bounds(first.year, first.month)
    if key and key.startswith("m") and key[1:].isdigit():
        return month_bounds(today.year, int(key[1:]))
    return month_bounds(today.year, today.month)


# ── identifiers ─────────────────────────────────────────────────────────────


def mask_tail(value, keep: int = 4) -> str | None:
    """'123456789012' -> '********9012'. Identifiers are shown masked; the full number never leaves the server."""
    text = "".join(str(value).split()) if value is not None else ""
    if not text:
        return None
    if len(text) <= keep:
        return "*" * len(text)
    return "*" * (len(text) - keep) + text[-keep:]


def blood_group_of(value) -> str | None:
    """A recognised blood group ('a+' -> 'A+'), else None (blank or an unrecognised value)."""
    text = "".join((value or "").split()).upper()
    return text if text in BLOOD_GROUPS else None


# ── exits ───────────────────────────────────────────────────────────────────


@dataclass
class ExitInfo:
    when: date | None
    basis: str
    resignation: object | None  # the approved ResignationRequest the date came from, if any


def exit_infos(inactive_employees) -> dict[int, ExitInfo]:
    """Best available exit date for employees who are not active.

    There is no exit-date column. Truth is the latest APPROVED resignation (its last working date, else the
    day HR approved it); a manual deactivation carries no date at all, so the record's last-modified date is
    used and labelled approximate. One query, however many employees.

    Rehiring under the same record is common: an approved resignation dated BEFORE the employee's (latest) join
    date belongs to an earlier stint and is ignored, so a rejoiner who left again is dated by the real exit."""
    from api.models import ResignationRequest

    emps = list(inactive_employees)
    if not emps:
        return {}
    approved: dict[int, list[ResignationRequest]] = {}
    rows = ResignationRequest.objects.filter(status="approved", employee_id__in=[e.id for e in emps]).order_by(
        "employee_id", F("approved_at").desc(nulls_last=True), "-id"
    )
    for r in rows:
        approved.setdefault(r.employee_id, []).append(r)
    out: dict[int, ExitInfo] = {}
    for e in emps:
        joined, _state = join_date_of(e)
        chosen = None
        for r in approved.get(e.id, ()):
            said = r.last_working_date or ist_date(r.approved_at)
            if joined is not None and said is not None and said < joined:
                continue  # an earlier stint: the person came back after it
            chosen = r
            break
        if chosen is not None and chosen.last_working_date:
            out[e.id] = ExitInfo(chosen.last_working_date, BASIS_RESIGNATION, chosen)
        elif chosen is not None and chosen.approved_at:
            out[e.id] = ExitInfo(ist_date(chosen.approved_at), BASIS_RESIGNATION_APPROVAL, chosen)
        else:
            out[e.id] = ExitInfo(ist_date(e.updated_at), BASIS_APPROX, None)
    return out


def service_end_dates(employees, today: date) -> dict[int, date]:
    """{employee_id: the date length of service is measured to}: today for the active, the exit date for leavers.

    A person who has left must not keep accruing service: the Exits Register stops the clock at the exit date, so
    every report that shows tenure has to agree with it. One query for all the leavers."""
    emps = list(employees)
    infos = exit_infos([e for e in emps if not is_active(e)])
    out: dict[int, date] = {}
    for e in emps:
        info = infos.get(e.id)
        out[e.id] = info.when if info is not None and info.when is not None else today
    return out


# ── labels ──────────────────────────────────────────────────────────────────


def department_labels(departments) -> dict[int, str]:
    """{department_id: label}. The plain name, plus ' (Branch)' -- and the id as a last resort -- only where two
    departments in the list would otherwise read alike (CUTTING of Unit 1 and CUTTING of Unit 2)."""
    from api.models import Branch

    depts = list(departments)
    by_name: dict[str, list] = defaultdict(list)
    for d in depts:
        by_name[(d.name or "").strip().lower()].append(d)
    out = {d.id: d.name for d in depts}
    clashing = [d for group in by_name.values() if len(group) > 1 for d in group]
    if not clashing:
        return out
    names = dict(Branch.objects.filter(id__in={d.branch_id for d in clashing if d.branch_id}).values_list("id", "name"))
    for d in clashing:
        out[d.id] = f"{d.name} ({names.get(d.branch_id, NO_BRANCH) if d.branch_id else NO_BRANCH})"
    seen = Counter(out[d.id] for d in clashing)
    for d in clashing:
        if seen[out[d.id]] > 1:  # two departments of one unit with the same name: only the id tells them apart
            out[d.id] = f"{out[d.id]} #{d.id}"
    return out


# ── lookups (one query each, never per row) ─────────────────────────────────


def document_map(employee_ids, categories=None) -> dict[int, set[str]]:
    """{employee_id: {document categories on file}}."""
    from api.models import EmployeeDocument

    qs = EmployeeDocument.objects.filter(employee_id__in=list(employee_ids))
    if categories:
        qs = qs.filter(category__in=list(categories))
    out: dict[int, set[str]] = {}
    for emp_id, category in qs.order_by().values_list("employee_id", "category").distinct():
        out.setdefault(emp_id, set()).add(category)
    return out


def hod_name_map(employees) -> dict[int, str]:
    """{employee_id: HOD name} by the app's own one-HOD-per-employee rule (hod_scope).

    Employees with no active HOD, and HODs themselves, are absent."""
    from api.hod_scope import effective_owner_map
    from api.models import DepartmentManager

    owner = effective_owner_map([e.id for e in employees])
    if not owner:
        return {}
    managers = {
        m.id: m
        for m in DepartmentManager.objects.select_related("employee")
        .defer("employee__photo_url", "employee__password_hash")
        .filter(id__in=set(owner.values()))
    }
    out: dict[int, str] = {}
    for emp_id, manager_id in owner.items():
        m = managers.get(manager_id)
        if m is None or m.employee_id == emp_id:
            continue
        out[emp_id] = f"{m.employee.first_name or ''} {m.employee.last_name or ''}".strip()
    return out


def branch_scope_id(ctx) -> int | None:
    return get_branch_scope(ctx.request)


def pick_columns(columns, keys) -> list:
    """The spec's columns restricted to ``keys``, in spec order."""
    wanted = set(keys)
    return [c for c in columns if c.key in wanted]

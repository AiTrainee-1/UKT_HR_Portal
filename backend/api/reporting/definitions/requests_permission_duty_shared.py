"""Helpers shared by the Permission / On-Duty / Missing-Punch / cross-check report modules (group G7).

Nothing in here registers a report -- the sibling ``requests_permission_duty_*`` modules do.

Conventions this group relies on (see the survey brief for the reasons):

* Aware datetimes are stored in UTC, but a business day is an IST day. Date filters on such columns use IST day
  bounds (``ist_bounds``) and display goes through ``fmt_dt``; Django's ``__date`` lookup is never used because it
  compares the UTC date (a 02:00 IST request would land on the previous day).
* ``permission_time`` / ``punch_time`` / ``punch_date`` / ``AttendanceLog.*`` are naive IST wall-clock values.
* Reports are read-only: ``PayrollSettings.get()`` is get_or_create (a write on a fresh install), so settings are
  read through ``load_settings`` instead.
"""

from __future__ import annotations

import calendar
from datetime import date, datetime, time, timedelta
from typing import Iterable

from api.clock import FACTORY_TZ

from ..common import emp_cells, with_subtotals
from ..types import BADGE, DATE, DATETIME, INTEGER, TEXT, TIME, ColumnSpec  # noqa: F401  (re-used by siblings)

CATEGORY = "leave"

# approver_role / reviewer_role values -> what an HR reader expects to see.
ROLE_LABELS = {"hr": "HR", "dept_head": "HOD", "system": "System"}


def load_settings():
    """The universal PayrollSettings row, WITHOUT creating it. The late pool and the permission cap are
    company-wide rules that the payroll engine reads from this row (never from a branch overlay); a fresh
    install that has no row yet simply gets the model defaults."""
    from api.models import PayrollSettings

    return PayrollSettings.objects.filter(pk=1).first() or PayrollSettings()


def permission_cap(settings) -> int:
    return max(0, int(getattr(settings, "permission_monthly_cap", 3) or 0))


# ── time helpers ────────────────────────────────────────────────────────────


def ist_bounds(d_from: date, d_to: date) -> tuple[datetime, datetime]:
    """[start, end) as aware datetimes covering the IST calendar days d_from..d_to inclusive."""
    start = datetime.combine(d_from, time.min, tzinfo=FACTORY_TZ)
    end = datetime.combine(d_to + timedelta(days=1), time.min, tzinfo=FACTORY_TZ)
    return start, end


def ist_date(value) -> date | None:
    """The IST calendar date of an aware datetime (naive values are taken as already IST)."""
    if value is None:
        return None
    if isinstance(value, datetime):
        return (value.astimezone(FACTORY_TZ) if value.tzinfo is not None else value).date()
    return value


def hours_between(start, end) -> float | None:
    """Elapsed hours between two aware datetimes, 2 dp; None when either is missing or the order is wrong."""
    if start is None or end is None or end < start:
        return None
    return round((end - start).total_seconds() / 3600, 2)


def month_key(d: date) -> str:
    return f"{d.year}-{d.month:02d}"


def whole_months(d_from: date, d_to: date) -> tuple[date, date]:
    """The range widened outwards to whole calendar months (the permission cap is a per-month rule)."""
    return d_from.replace(day=1), d_to.replace(day=calendar.monthrange(d_to.year, d_to.month)[1])


def tstr(value) -> str | None:
    """A naive time -> 'HH:MM'."""
    return value.strftime("%H:%M") if value is not None else None


def dstr(value) -> str | None:
    return value.isoformat() if value is not None else None


def who_and_role(name: str | None, role: str | None) -> str | None:
    """'Priya S (HOD)' / 'Ravi (HR)' / 'Priya S' / 'HOD' / None -- the decision maker as stored (free text)."""
    name = (name or "").strip()
    label = ROLE_LABELS.get((role or "").strip().lower(), (role or "").strip() or None)
    if name and label:
        return f"{name} ({label})"
    return name or label or None


# ── employee cells ──────────────────────────────────────────────────────────


def branch_name(emp) -> str | None:
    return emp.branch.name if emp.branch_id else None


def base_cells(emp) -> dict:
    """EMP_COLS cells + the employee's branch (departments repeat across branches, so an unscoped reader needs it).
    ``emp`` must come from a queryset that select_related's department, designation and branch."""
    cells = emp_cells(emp)
    cells["branch"] = branch_name(emp)
    return cells


BRANCH_COL = ColumnSpec("branch", "Branch", TEXT, 1.1)


# ── grouping / subtotals ────────────────────────────────────────────────────


def department_subtotals(rows: list[dict], sum_keys: Iterable[str]) -> list[dict]:
    """Sort ``rows`` by department (then employee code, then month/date if present) and insert one subtotal row per
    department. Rows must carry ``_branch`` (dropped by the runner): when the result spans more than one branch the
    group is 'DEPT (Branch)', because department names are only unique per branch."""
    multi_branch = len({r.get("_branch") for r in rows}) > 1

    def group(r: dict) -> str:
        dept = r.get("department") or "Unassigned"
        return f"{dept} ({r.get('_branch') or 'no branch'})" if multi_branch else dept

    ordered = sorted(rows, key=lambda r: (group(r), r.get("employeeCode") or "", r.get("month") or "", r.get("_seq", 0)))
    return with_subtotals(ordered, group, sum_keys)


def limited(rows: Iterable, limit: int) -> list:
    """First ``limit`` items of an iterable (the runner flags truncation when it sees more than its own limit)."""
    out = []
    for r in rows:
        out.append(r)
        if len(out) >= limit:
            break
    return out


def yes_no(flag: bool) -> str:
    return "Yes" if flag else "No"

"""Helpers shared by the Leave & Requests report definitions (group ``requests_leave``).

This module registers no report; it only holds the small, read-only building blocks the
``requests_leave*`` definition modules have in common: text-date handling for
``LeaveRequest.start_date/end_date``, IST bucketing of UTC timestamps, leave-type resolution,
de-duplicated leave-day counting and the "HOD or HR" resolution used by the approval reports.
"""

from __future__ import annotations

from collections import defaultdict
from datetime import date, datetime, time, timedelta
from typing import Iterable, NamedTuple

from django.db.models import Q

from api.clock import FACTORY_TZ

from ..access import permission_level
from ..formatting import parse_date
from ..types import TEXT, ColumnSpec

# A stored text date that starts like YYYY-MM-DD (a 'T...' time suffix is tolerated).
ISO_DATE_REGEX = r"^[0-9]{4}-[0-9]{2}-[0-9]{2}"

KNOWN_STATUSES = ("pending", "approved", "rejected")

ROLE_LABELS = {"hr": "HR", "dept_head": "HOD", "system": "System"}


def emp_columns(name: float = 1.9, dept: float = 1.4, designation: float | None = None) -> tuple[ColumnSpec, ...]:
    """The employee identity columns (keys match ``common.emp_cells``) with widths chosen for wide tables,
    where the standard weights leave too little room for dates and status words."""
    cols = [
        ColumnSpec("employeeCode", "Emp Code", TEXT, 0.95),
        ColumnSpec("employeeName", "Employee", TEXT, name),
        ColumnSpec("department", "Department", TEXT, dept),
    ]
    if designation is not None:
        cols.append(ColumnSpec("designation", "Designation", TEXT, designation))
    return tuple(cols)


# ── access ──────────────────────────────────────────────────────────────────


def can_view(ctx, module_key: str) -> bool:
    """Whether the requesting HR user may open ``module_key`` elsewhere in the app (super admin: always).

    Reports that blend several workflows use this to leave out the ones the role cannot see."""
    return permission_level(ctx.request, module_key) in ("view", "edit")


# ── time ────────────────────────────────────────────────────────────────────


def ist_bounds(d_from: date, d_to: date) -> tuple[datetime, datetime]:
    """[start, end) aware datetimes covering the IST calendar days ``d_from``..``d_to`` inclusive.

    Aware timestamps are stored in UTC, so ``created_at__date`` would compare UTC days; filter on these
    bounds instead."""
    start = datetime.combine(d_from, time.min, tzinfo=FACTORY_TZ)
    end = datetime.combine(d_to + timedelta(days=1), time.min, tzinfo=FACTORY_TZ)
    return start, end


def ist_date(value) -> date | None:
    """The IST calendar date of an aware datetime (a naive one is taken as factory time already)."""
    if value is None:
        return None
    if value.tzinfo is None:
        return value.date()
    return value.astimezone(FACTORY_TZ).date()


def hours_between(start, end) -> float | None:
    """Elapsed hours (2 dp) between two aware datetimes; None when either is missing or the order is wrong."""
    if start is None or end is None or end < start:
        return None
    return round((end - start).total_seconds() / 3600, 2)


def add_months(d: date, months: int) -> date:
    """``d`` plus whole calendar months, the day clamped to the target month's length."""
    total = d.year * 12 + (d.month - 1) + months
    year, month0 = divmod(total, 12)
    month = month0 + 1
    last = _days_in_month(year, month)
    return date(year, month, min(d.day, last))


def _days_in_month(year: int, month: int) -> int:
    nxt = date(year + (month == 12), (month % 12) + 1, 1)
    return (nxt - date(year, month, 1)).days


# ── small value helpers ─────────────────────────────────────────────────────


def status_key(raw) -> str:
    """pending / approved / rejected as-is; anything else (the HR PATCH does not validate) is 'other'."""
    value = str(raw or "").strip().lower()
    return value if value in KNOWN_STATUSES else "other"


def status_label(raw) -> str:
    """The status as shown in a badge column: Pending / Approved / Rejected / Other."""
    return status_key(raw).capitalize()


def role_label(raw) -> str | None:
    if raw is None or str(raw).strip() == "":
        return None
    key = str(raw).strip().lower()
    return ROLE_LABELS.get(key, key)


def clip(value, limit: int) -> str | None:
    """Trim long free text for on-screen / PDF cells, keeping the start."""
    if value is None:
        return None
    text = str(value).strip()
    if not text:
        return None
    return text if len(text) <= limit else text[: limit - 1].rstrip() + "…"


def norm_name(value) -> str:
    """Whitespace-normalised person name, the grouping key for free-text approver names."""
    return " ".join(str(value or "").split())


def id_list_note(prefix: str, ids: list[int], suffix: str = "", shown: int = 8) -> str:
    head = ", ".join(str(i) for i in sorted(ids)[:shown])
    more = len(ids) - min(len(ids), shown)
    return f"{prefix} (ids: {head}{f' +{more} more' if more > 0 else ''}){suffix}"


# ── leave request text dates ────────────────────────────────────────────────


def leave_overlap_q(d_from: date, d_to: date) -> Q:
    """LeaveRequest rows that may overlap [d_from, d_to].

    ``start_date``/``end_date`` are TEXT columns holding ISO dates, so the overlap test is a string
    comparison (start <= to AND end >= from); ``__startswith`` would only find the start month. Rows whose
    text is not ISO-shaped (dd-mm-yyyy, blanks ...) cannot be compared in SQL, so they are always fetched
    and decided in Python -- never silently dropped."""
    return (
        Q(start_date__lt=(d_to + timedelta(days=1)).isoformat(), end_date__gte=d_from.isoformat())
        | ~Q(start_date__regex=ISO_DATE_REGEX)
        | ~Q(end_date__regex=ISO_DATE_REGEX)
    )


def leave_year_q(year: int) -> Q:
    """LeaveRequest rows that START in ``year`` (the year a leave balance is charged to), plus non-ISO rows."""
    return Q(start_date__gte=f"{year:04d}-01-01", start_date__lt=f"{year + 1:04d}-01-01") | ~Q(
        start_date__regex=ISO_DATE_REGEX
    )


def parse_leave_range(lr) -> tuple[date, date] | None:
    """(start, end) of a leave request, or None when either text date is unreadable or end < start."""
    start, end = parse_date(lr.start_date), parse_date(lr.end_date)
    if start is None or end is None or end < start:
        return None
    return start, end


def leave_dates(lr, start: date, end: date, lo: date, hi: date) -> list[date]:
    """The dates a request contributes inside [lo, hi].

    A half-day is its single start date. Otherwise every Mon-Sat date of the request (Sundays are skipped,
    exactly the rule that produced the stored ``total_days``; holidays are NOT skipped)."""
    if lr.is_half_day:
        return [start] if lo <= start <= hi else []
    a, b = max(start, lo), min(end, hi)
    out: list[date] = []
    d = a
    while d <= b:
        if d.weekday() != 6:
            out.append(d)
        d += timedelta(days=1)
    return out


def unique_leave_days(items: Iterable[tuple[int, list[date], bool, str | None]]) -> float:
    """Leave days with overlapping / duplicate requests counted once per employee-day.

    ``items`` = (employee_id, dates, is_half_day, half_day_slot). A full day is 1.0; a half-day adds 0.5 per
    distinct slot on a date (so a morning and an afternoon half make one day) unless a full-day request
    already covers that date."""
    full: dict[int, set[date]] = defaultdict(set)
    halves: dict[tuple[int, date], set] = defaultdict(set)
    for emp_id, dates, is_half, slot in items:
        if is_half:
            for d in dates:
                halves[(emp_id, d)].add(slot or "?")
        else:
            full[emp_id].update(dates)
    total = float(sum(len(v) for v in full.values()))
    for (emp_id, d), slots in halves.items():
        if d not in full.get(emp_id, ()):
            total += min(1.0, 0.5 * len(slots))
    return round(total, 2)


# ── leave types ─────────────────────────────────────────────────────────────


class TypeInfo(NamedTuple):
    key: str
    label: str
    code: str | None
    is_paid: bool | None


class LeaveTypeCatalog:
    """LeaveType master loaded once, and the rule that names the leave type of a request.

    Grouping key = the linked ``leave_type_ref`` when set; otherwise the free-text ``type`` matched
    (case-insensitively) to a LeaveType code or name; otherwise the normalised text itself. Historic mobile
    submissions stored ``type='casual'`` with no reference for every leave, so those rows land in an
    'untyped' bucket instead of being credited to a real leave type."""

    def __init__(self):
        from api.models import LeaveType

        self.types = list(LeaveType.objects.order_by("name", "id"))
        self.by_id = {t.id: t for t in self.types}
        self.by_code = {str(t.code).strip().lower(): t for t in self.types}
        self.by_name = {str(t.name).strip().lower(): t for t in self.types}

    @staticmethod
    def _info(t) -> TypeInfo:
        return TypeInfo(f"t{t.id}", t.name, t.code, bool(t.is_paid))

    def for_type(self, t) -> TypeInfo:
        return self._info(t)

    def resolve(self, lr) -> TypeInfo:
        if lr.leave_type_ref_id and lr.leave_type_ref_id in self.by_id:
            return self._info(self.by_id[lr.leave_type_ref_id])
        raw = str(lr.type or "").strip()
        low = raw.lower()
        match = self.by_code.get(low) or self.by_name.get(low)
        if match is not None:
            return self._info(match)
        shown = (raw.capitalize() if raw.islower() else raw) or "Unspecified"
        return TypeInfo(f"x:{low or 'unspecified'}", f"{shown} (untyped)", None, None)


def type_matches(info: TypeInfo, needle: str | None) -> bool:
    """Case-insensitive 'contains' test of the leave-type text filter against label and code."""
    if not needle:
        return True
    n = needle.strip().lower()
    return n in info.label.lower() or (info.code is not None and n in info.code.lower())


# ── who can act: HOD or HR ──────────────────────────────────────────────────


class HodDirectory:
    """The active HOD of each employee (hod_scope.effective_owner_map: ONE call for the whole batch) and the
    HODs' names / approval rights, so 'who is this waiting on' is a dict lookup per row."""

    def __init__(self, employee_ids: Iterable[int]):
        from api.hod_scope import effective_owner_map
        from api.models import DepartmentManager

        ids = list({int(i) for i in employee_ids})
        self.owner: dict[int, int] = effective_owner_map(ids) if ids else {}
        self.managers = {}
        if self.owner:
            self.managers = {
                m.id: m
                for m in DepartmentManager.objects.select_related("employee").filter(id__in=set(self.owner.values()))
            }

    def state(self, emp_id: int, flag: str) -> tuple[str, str | None]:
        """('ok'|'no_right'|'self'|'none', HOD name). ``flag`` = the DepartmentManager.can_approve_* field
        that governs this kind of request. A HOD never decides their own request ('self')."""
        mid = self.owner.get(emp_id)
        m = self.managers.get(mid) if mid is not None else None
        if m is None:
            return "none", None
        name = norm_name(f"{m.employee.first_name} {m.employee.last_name}")
        if m.employee_id == emp_id:
            return "self", name
        if not getattr(m, flag, False):
            return "no_right", name
        return "ok", name

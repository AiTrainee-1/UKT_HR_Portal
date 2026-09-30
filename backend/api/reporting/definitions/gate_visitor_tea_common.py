"""Shared helpers for the Gate reports on visitors and tea breaks (report group G9).

Why this module exists
----------------------
* Every gate timestamp is an aware UTC ``DateTimeField``. A calendar day of the factory is an
  Asia/Kolkata day, so date filters use IST bounds (``ist_bounds``) and grouping uses
  ``TruncDate(..., tzinfo=FACTORY_TZ)`` -- never ``__date`` (which would file a 02:00 IST break
  under the previous day).
* Tea-break duration and remark are NOT stored; the HR page derives them at read time in
  ``tea_break_views._log_json``. The same rules are reproduced here twice, in lock-step:
  in Python (``tea_metrics``, used for one-row-at-a-time registers) and in SQL
  (``WholeMinutes`` + the ``*_q`` builders, used for the summaries so that the highest-volume table
  is aggregated in the database instead of being loaded row by row). A test cross-checks both
  against ``_log_json`` on boundary cases.
* Nothing here writes to the database.
"""

from __future__ import annotations

from datetime import date, datetime, time, timedelta

from django.db.models import (
    Count,
    F,
    Func,
    IntegerField,
    Max,
    OuterRef,
    Q,
    Subquery,
    Sum,
    TextField,
    Value,
)
from django.db.models.functions import Cast, Concat, Lower, Trim
from django.utils import timezone

from api.branch_scope import get_branch_scope
from api.clock import FACTORY_TZ

# The tea-break page's own constants: an open break stops being "in progress" after this many
# minutes, and an open row older than the cutoff is never closed by a later scan.
from api.tea_break_views import NOT_RETURNED_MINUTES, STALE_OPEN_CUTOFF

CATEGORY = "gate"
MODULES = ("outpass_visitors",)  # RBAC module that owns outpass / visitor / tea-break / gate-device data

# A COMPLETED break longer than this is almost always a missed OUT/IN scan (the toggle then pairs the
# wrong scans), not a real break of that length. Such rows are flagged, never silently trusted.
SUSPECT_MINUTES = NOT_RETURNED_MINUTES
DEFAULT_ALLOWED_MINUTES = 15  # TeaBreakRule.allowed_minutes default

REMARK_LABEL = {
    "on_time": "On time",
    "overtime": "Overtime",
    "not_returned": "Not returned",
    "in_progress": "In progress",
}
FLAG_LONG = "Long break"  # completed, longer than SUSPECT_MINUTES
FLAG_OPEN = "Left open"  # never closed and older than the 12-hour toggle window


def now_utc() -> datetime:
    """The instant the report is generated at (aware, UTC). Tests freeze it by patching this."""
    return timezone.now()


# ── IST time helpers ─────────────────────────────────────────────────────────


def ist_bounds(d_from: date | None, d_to: date | None) -> tuple[datetime | None, datetime | None]:
    """[dateFrom 00:00 IST, dateTo + 1 day 00:00 IST) as aware datetimes (either end may be None)."""
    lo = datetime.combine(d_from, time.min, tzinfo=FACTORY_TZ) if d_from else None
    hi = datetime.combine(d_to + timedelta(days=1), time.min, tzinfo=FACTORY_TZ) if d_to else None
    return lo, hi


def in_range(field: str, ctx) -> Q:
    """Q restricting ``field`` to the report's date range, in IST days."""
    lo, hi = ist_bounds(ctx.date_from, ctx.date_to)
    q = Q()
    if lo is not None:
        q &= Q(**{f"{field}__gte": lo})
    if hi is not None:
        q &= Q(**{f"{field}__lt": hi})
    return q


def to_ist(dt: datetime | None) -> datetime | None:
    return dt.astimezone(FACTORY_TZ) if dt is not None else None


def ist_date(dt: datetime | None) -> str | None:
    """ISO date (IST) of an aware datetime."""
    return to_ist(dt).date().isoformat() if dt is not None else None


def hhmm(dt: datetime | None) -> str | None:
    return to_ist(dt).strftime("%H:%M") if dt is not None else None


def hhmm_relative(dt: datetime | None, base_day: date) -> str | None:
    """'HH:MM' in IST; '(+1d)' is appended when the moment falls on a later IST day than ``base_day``
    (a break that starts at 23:50 and ends at 00:10 belongs to the earlier day)."""
    if dt is None:
        return None
    local = to_ist(dt)
    text = local.strftime("%H:%M")
    extra = (local.date() - base_day).days
    return f"{text} (+{extra}d)" if extra > 0 else text


def hour_band(h: int) -> str:
    return f"{h:02d}:00-{h:02d}:59"


def person_name(first, last) -> str:
    return f"{first or ''} {last or ''}".strip()


def emp_cells_from_values(row: dict, prefix: str = "employee__") -> dict:
    """EMP_COLS cells from a ``.values()`` row -- values() (unlike select_related) never drags in the
    employee's base64 photo column."""
    dept = row.get(f"{prefix}department__name")
    return {
        "employeeCode": row.get(f"{prefix}employee_code"),
        "employeeName": person_name(row.get(f"{prefix}first_name"), row.get(f"{prefix}last_name")),
        "department": dept if dept else "Unassigned",
        "designation": row.get(f"{prefix}designation__title"),
    }


EMP_VALUE_FIELDS = (
    "employee_code",
    "first_name",
    "last_name",
    "department__name",
    "designation__title",
)


def emp_value_fields(prefix: str = "employee__") -> list[str]:
    return [f"{prefix}{f}" for f in EMP_VALUE_FIELDS]


# ── branch isolation for models that carry their own branch column ───────────


def branch_q(ctx, field: str = "branch_id") -> Q:
    """Branch isolation (always) AND the user's optional branch filter, for data that links to a branch
    directly (visits, gate devices) rather than through an employee. A scoped user can never widen this:
    both conditions are ANDed."""
    q = Q()
    scope = get_branch_scope(ctx.request)
    if scope is not None:
        q &= Q(**{field: scope})
    ids = ctx.params.get("branch_ids")
    if ids:
        q &= Q(**{f"{field}__in": ids})
    return q


# ── Aadhaar masking ──────────────────────────────────────────────────────────


def mask_aadhaar(last4) -> str | None:
    """'XXXX XXXX 1234' from the last four characters of the stored number. Callers must only ever pass
    the last four characters (``Right(Trim(aadhaar), 4)``), so the full number never leaves the database."""
    digits = "".join(ch for ch in str(last4 or "") if ch.isdigit())
    return f"XXXX XXXX {digits[-4:]}" if len(digits) >= 4 else None


# ── visits ───────────────────────────────────────────────────────────────────


def visit_no_expr(ctx) -> Subquery:
    """Ordinal of a visit among ALL of that visitor's visits the user may see (branch isolation applies,
    the report's own filters do not): 1 = first visit. A correlated count, so it is exact even when other
    filters hide the earlier visits, and it is only evaluated for the rows actually returned."""
    from api.models import VisitorVisit

    inner = VisitorVisit.objects.filter(visitor_id=OuterRef("visitor_id")).filter(
        Q(visited_at__lt=OuterRef("visited_at")) | Q(visited_at=OuterRef("visited_at"), id__lte=OuterRef("id"))
    )
    scope = get_branch_scope(ctx.request)
    if scope is not None:
        inner = inner.filter(branch_id=scope)
    counted = inner.order_by().values("visitor_id").annotate(c=Count("id")).values("c")
    return Subquery(counted, output_field=IntegerField())


def visit_queryset(ctx, *, with_visit_no: bool = False):
    """VisitorVisit rows for the report's branch / date / host filters (see each report's filter list)."""
    from api.models import VisitorVisit

    p = ctx.params
    qs = VisitorVisit.objects.filter(branch_q(ctx, "branch_id")).filter(in_range("visited_at", ctx))
    if p.get("department_ids"):
        qs = qs.filter(meeting_employee__department_id__in=p["department_ids"])
    if p.get("employee_ids"):
        qs = qs.filter(meeting_employee_id__in=p["employee_ids"])
    linked = p.get("hostLinked")
    if linked == "linked_employee":
        qs = qs.filter(meeting_employee__isnull=False)
    elif linked == "free_text":
        qs = qs.filter(meeting_employee__isnull=True)
    if with_visit_no:
        qs = qs.annotate(visit_no=visit_no_expr(ctx))
    return qs


def host_filter_note(ctx) -> str | None:
    p = ctx.params
    if p.get("department_ids") or p.get("employee_ids"):
        return (
            "Host department / host employee filters only match visits linked to an employee; visits where the "
            "visitor typed a free-text host are left out."
        )
    return None


def sent_badge(value, applicable: bool = True) -> str | None:
    """'Sent' when the notification timestamp exists. NULL means 'not sent OR could not be sent' (the visit
    does not record the reason); None (dash) when there is no linked host to notify at all."""
    if not applicable:
        return None
    return "Sent" if value is not None else "Not sent"


# ── tea breaks: duration + remark, in Python and in SQL ──────────────────────


def tea_rule():
    """(allowed_minutes, rule.updated_at). Read-only: ``TeaBreakRule.get()`` would INSERT the singleton when
    it is missing, and a report GET must never write."""
    from api.models import TeaBreakRule

    rule = TeaBreakRule.objects.filter(pk=1).first()
    if rule is None:
        return DEFAULT_ALLOWED_MINUTES, None
    return rule.allowed_minutes, rule.updated_at


def rule_note(allowed: int, updated_at) -> str:
    when = (
        f" (rule last changed {to_ist(updated_at).strftime('%d-%b-%Y')})"
        if updated_at
        else " (default; no rule saved yet)"
    )
    return (
        f"Allowed minutes used: {allowed}{when}. The allowance is applied to every break in the period as it "
        "stands today (it is not stored per break), so re-running an old report after the rule changes can "
        "change its overtime figures."
    )


def tea_metrics(out_at: datetime, in_at: datetime | None, allowed: int, now: datetime) -> tuple[int, str]:
    """(minutes, remark) exactly as ``tea_break_views._log_json`` computes them (same Python ``round``,
    compared after rounding). For an open break the minutes run up to ``now`` -- callers blank them."""
    if in_at is not None:
        taken = round((in_at - out_at).total_seconds() / 60)
        return taken, ("overtime" if taken > allowed else "on_time")
    taken = round((now - out_at).total_seconds() / 60)
    return taken, ("not_returned" if taken > NOT_RETURNED_MINUTES else "in_progress")


def tea_flag(out_at: datetime, in_at: datetime | None, taken: int, now: datetime) -> str | None:
    """Marker for rows whose length cannot be trusted as a real break (a scan was probably missed)."""
    if in_at is not None:
        return FLAG_LONG if taken > SUSPECT_MINUTES else None
    return FLAG_OPEN if now - out_at > STALE_OPEN_CUTOFF else None


class WholeMinutes(Func):
    """Whole minutes of an interval expression, rounded half-to-even like Python's ``round`` (SQL ROUND is
    half-away-from-zero; the two only differ at an exact x.5, e.g. 15 min 30 s). Use as
    ``WholeMinutes(F("in_at") - F("out_at"))`` inside Sum / Max."""

    _X = "(CAST(EXTRACT(EPOCH FROM (%(expressions)s)) AS NUMERIC) / 60)"
    template = (
        f"CAST(ROUND({_X}) - CASE WHEN {_X} - FLOOR({_X}) = 0.5 AND MOD(FLOOR({_X}), 2) = 0 "
        "THEN 1 ELSE 0 END AS INTEGER)"
    )
    output_field = IntegerField()


def break_minutes() -> WholeMinutes:
    return WholeMinutes(F("in_at") - F("out_at"))


def _over(minutes: int) -> timedelta:
    return timedelta(seconds=60 * minutes + 30)


def long_q(minutes: int) -> Q:
    """Completed breaks whose ROUNDED length is more than ``minutes`` (== Python's ``round(x) > minutes``:
    strictly beyond minutes + 30 s, or exactly on it when that rounds up to an even number)."""
    limit = F("out_at") + _over(minutes)
    return Q(in_at__isnull=False) & (Q(in_at__gte=limit) if minutes % 2 else Q(in_at__gt=limit))


def within_q(minutes: int) -> Q:
    """Completed breaks whose rounded length is at most ``minutes`` (the exact complement of ``long_q``)."""
    limit = F("out_at") + _over(minutes)
    return Q(in_at__isnull=False) & (Q(in_at__lt=limit) if minutes % 2 else Q(in_at__lte=limit))


def completed_q() -> Q:
    return Q(in_at__isnull=False)


def open_q() -> Q:
    return Q(in_at__isnull=True)


def not_returned_q(now: datetime) -> Q:
    """Open for more than NOT_RETURNED_MINUTES (rounded), measured to ``now``."""
    limit = now - _over(NOT_RETURNED_MINUTES)
    return Q(in_at__isnull=True) & (Q(out_at__lte=limit) if NOT_RETURNED_MINUTES % 2 else Q(out_at__lt=limit))


def in_progress_q(now: datetime) -> Q:
    limit = now - _over(NOT_RETURNED_MINUTES)
    return Q(in_at__isnull=True) & (Q(out_at__gt=limit) if NOT_RETURNED_MINUTES % 2 else Q(out_at__gte=limit))


def stale_open_q(now: datetime) -> Q:
    return Q(in_at__isnull=True, out_at__lt=now - STALE_OPEN_CUTOFF)


def suspect_q(now: datetime) -> Q:
    """Rows flagged FLAG_LONG or FLAG_OPEN."""
    return long_q(SUSPECT_MINUTES) | stale_open_q(now)


def not_suspect_q(now: datetime) -> Q:
    return within_q(SUSPECT_MINUTES) | Q(in_at__isnull=True, out_at__gte=now - STALE_OPEN_CUTOFF)


def remark_q(remark: str, allowed: int, now: datetime) -> Q:
    return {
        "on_time": within_q(allowed),
        "overtime": long_q(allowed),
        "not_returned": not_returned_q(now),
        "in_progress": in_progress_q(now),
    }[remark]


def tea_measures(allowed: int, now: datetime) -> dict:
    """The aggregate expressions every tea summary shares. ``over_sum`` is the sum of the rounded minutes of
    overtime breaks; minutes over allowance = over_sum - allowed * overtime."""
    wm = break_minutes()
    return {
        "breaks": Count("id"),
        "completed": Count("id", filter=completed_q()),
        "on_time": Count("id", filter=within_q(allowed)),
        "overtime": Count("id", filter=long_q(allowed)),
        "not_returned": Count("id", filter=not_returned_q(now)),
        "in_progress": Count("id", filter=in_progress_q(now)),
        "long_breaks": Count("id", filter=suspect_q(now)),
        "total_min": Sum(wm, filter=completed_q()),
        "max_min": Max(wm, filter=completed_q()),
        "over_sum": Sum(wm, filter=long_q(allowed)),
    }


def over_minutes(over_sum, overtime, allowed: int) -> int:
    return int(over_sum or 0) - allowed * int(overtime or 0)


def avg(total, count) -> float | None:
    """Mean minutes per completed break; None (a dash) when there is nothing to average."""
    return round(int(total or 0) / count, 2) if count else None


def pct(part, whole) -> float | None:
    return round(100.0 * part / whole, 1) if whole else None


def tea_queryset(ctx, *, now: datetime, exclude_suspect: bool = False):
    """TeaBreakLog rows inside the report's IST date range for the report's employee scope (employee
    filters + branch isolation via ``ctx.emp_q``). Break start (out_at) decides the day."""
    from api.models import TeaBreakLog

    qs = TeaBreakLog.objects.filter(ctx.emp_q("employee__")).filter(in_range("out_at", ctx))
    if exclude_suspect:
        qs = qs.filter(not_suspect_q(now))
    return qs


def ist_day_expr(field: str = "out_at"):
    from django.db.models.functions import TruncDate

    return TruncDate(field, tzinfo=FACTORY_TZ)


def ist_hour_expr(field: str = "out_at"):
    from django.db.models.functions import ExtractHour

    return ExtractHour(field, tzinfo=FACTORY_TZ)


def employee_day_key():
    """One distinct value per (employee, IST day) -- Count(..., distinct=True) of it = employee-days."""
    return Concat(
        Cast("employee_id", TextField()),
        Value("|"),
        Cast(ist_day_expr(), TextField()),
        output_field=TextField(),
    )


def free_text_host_key(field: str = "whom_to_meet"):
    """Free-text hosts are grouped case-insensitively on the trimmed text (spelling variants stay apart)."""
    return Lower(Trim(field))


def weekday_name(d: date) -> str:
    return d.strftime("%a")


def peak_hour_text(counts: dict[int, int]) -> str | None:
    """The busiest hour ('10:00-10:59'); ties go to the earlier hour. None when there are no rows."""
    if not counts:
        return None
    best = max(counts.items(), key=lambda kv: (kv[1], -kv[0]))[0]
    return hour_band(best)

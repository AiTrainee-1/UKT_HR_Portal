"""Shared helpers for the gate / outpass report definitions (group G8).

This module registers nothing; ``gate_outpass.py`` (outpass reports) and ``gate_outpass_gate.py``
(QR submissions, scan audit, gate activity, daily gate summary) build on it.

Time
----
Every gate DateTimeField (``created_at``, ``approved_at``, ``exited_at``, ``entered_at``,
``submitted_at``, ``scanned_at``, ...) is an aware UTC value, but the business day is Asia/Kolkata. So:

* a report's ``dateFrom``/``dateTo`` are IST calendar days and are turned into the closed-open instant
  range ``[dateFrom 00:00 IST, dateTo + 1 day 00:00 IST)`` by :func:`in_range` (never ``__date`` lookups,
  which evaluate in UTC and file 00:00-05:30 IST activity under the previous day);
* days are bucketed with ``TruncDate(..., tzinfo=FACTORY_TZ)`` and shown with ``fmt_dt`` (IST).

This mirrors the HR page's ``gate-range.ts`` (IST midnight, week starts Monday, month starts on the 1st)
except that a report range is CLOSED on the right (up to and including ``dateTo``) instead of open-ended.

"Now"
-----
Several figures depend on the moment the report is generated (is a pass still valid, how long has someone
been out). All of them read the clock through :func:`now`, so tests can pin it in one place.
"""

from __future__ import annotations

import math
from dataclasses import replace
from datetime import date, datetime, time, timedelta
from types import SimpleNamespace

from django.db.models import Q
from django.utils import timezone

from api.branch_scope import get_branch_scope
from api.clock import FACTORY_TZ
from api.outpass_request_views import RETURN_QR_VALID_MINUTES, _outpass_scan_status

from ..filters import date_range, select, text
from ..formatting import fmt_dt
from ..types import FilterSpec

# An approved pass is scannable for 60 minutes from approval. The app spells this literal out in three
# places (outpass_request_views, gate_scanner_views x2) and has no shared constant, so it lives here once.
PASS_VALID = timedelta(minutes=60)

# Employee columns that can be very large (base64 photo) or are never reportable. Deferred on every
# select_related("employee...") so a register of 5,000 rows never drags photos through the wire.
EMP_DEFER = ("employee__photo_url", "employee__id_proof", "employee__address", "employee__password_hash")

MAX_TEXT = 240  # free text (destination, reason, comments) is user input: keep cells sane

PASS_TYPE_LABELS = {
    "official": "Official",
    "personal": "Personal",
    "early_dismissal": "Early Dismissal",
}
PASS_TYPE_OPTIONS = (
    ("official", "Official / Mill Duty"),
    ("personal", "Personal Emergency"),
    ("early_dismissal", "Early Shift Dismissal"),
    ("unspecified", "Unspecified (no pass type)"),
)
SOURCE_LABELS = {"manual": "Manual", "on_duty": "On-Duty"}
ROLE_LABELS = {"hr": "HR", "dept_head": "Dept Head", "system": "System"}
STATUS_LABELS = {"pending": "Pending", "approved": "Approved", "rejected": "Rejected"}

# The pass state shown on the reports. The first seven are ``_outpass_scan_status`` verbatim (worded as on the
# HR Outpass page); the last two refine "the employee is out" so an old open row is never presented as live:
#   not_returned     - scanned out on an EARLIER IST day and never scanned back in
#   early_dismissal  - an early-shift-dismissal pass that has left (these legitimately never return)
STATE_LABELS = {
    "not_applicable": None,
    "pending_exit": "Awaiting Exit",
    "exited": "Exited",
    "expired_unscanned": "Expired, Not Scanned",
    "pending_return": "Awaiting Return",
    "return_expired": "Return QR Expired",
    "completed": "Returned",
    "not_returned": "Not Returned",
    "early_dismissal": "Early Dismissal",
}
STATE_OPTIONS = tuple((k, v) for k, v in STATE_LABELS.items() if v) + (
    ("not_applicable", "Pending / rejected (no scan yet)"),
)
# States in which the employee is physically outside right now (exit today, no return yet).
OUTSIDE_STATES = ("exited", "pending_return", "return_expired")
# States that mean "left and no return recorded".
OPEN_STATES = OUTSIDE_STATES + ("not_returned",)

MOVEMENT_LABELS = {
    "completed": "Returned",
    "exited": "Outside Now",
    "pending_return": "Outside Now",
    "return_expired": "Outside Now",
    "not_returned": "Not Returned",
    "early_dismissal": "Early Dismissal",
}

SCAN_TYPE_LABELS = {"exit": "Exit", "entry": "Return"}
SCAN_RESULT_LABELS = {
    "success": "Success",
    "already_scanned": "Already Scanned",
    "expired": "Expired",
    "not_approved": "Not Approved",
    "invalid_qr": "Invalid QR",
    "not_exited": "Not Yet Exited",
}


def now() -> datetime:
    """The report clock (aware UTC). Single seam so tests can pin it."""
    return timezone.now()


# ── time helpers ────────────────────────────────────────────────────────────


def ist_date(value) -> date | None:
    """The IST calendar day of an aware datetime."""
    if value is None:
        return None
    return value.astimezone(FACTORY_TZ).date()


def ist_bounds(ctx) -> tuple[datetime | None, datetime | None]:
    """``[dateFrom 00:00 IST, dateTo+1 00:00 IST)`` as aware datetimes."""
    d1, d2 = ctx.date_from, ctx.date_to
    start = datetime.combine(d1, time.min, tzinfo=FACTORY_TZ) if d1 else None
    end = datetime.combine(d2 + timedelta(days=1), time.min, tzinfo=FACTORY_TZ) if d2 else None
    return start, end


def in_range(field: str, ctx) -> Q:
    start, end = ist_bounds(ctx)
    q = Q()
    if start is not None:
        q &= Q(**{f"{field}__gte": start})
    if end is not None:
        q &= Q(**{f"{field}__lt": end})
    return q


def human(value) -> str | None:
    """Aware datetime -> '05-Sep-2026 14:30' IST, for sentences (columns use ISO strings)."""
    if value is None:
        return None
    return value.astimezone(FACTORY_TZ).strftime("%d-%b-%Y %H:%M")


def half_up_minutes(seconds: float) -> int:
    """Whole minutes, halves rounded UP, never negative - the HR page's ``Math.round`` on a duration."""
    return max(0, math.floor(seconds / 60 + 0.5))


def mean_minutes(values) -> int | None:
    """Average of whole-minute values, halves rounded up (same rule as ``half_up_minutes``)."""
    values = list(values)
    if not values:
        return None
    return math.floor(sum(values) / len(values) + 0.5)


def minutes_between(start, end) -> int | None:
    if start is None or end is None:
        return None
    return half_up_minutes((end - start).total_seconds())


# ── text helpers ────────────────────────────────────────────────────────────


def clean(value, limit: int = MAX_TEXT) -> str | None:
    """Free text -> one tidy line (no newlines), capped. Empty -> None."""
    if value is None:
        return None
    s = " ".join(str(value).split())
    if not s:
        return None
    return s if len(s) <= limit else s[: limit - 3].rstrip() + "..."


def pass_type_label(value) -> str:
    if not value:
        return "Unspecified"
    return PASS_TYPE_LABELS.get(value, str(value))


def reviewer_text(role, name) -> str | None:
    """Who decided the request: 'HR - Name', 'HOD - Name' or 'On-Duty approval (Name)'.

    ``approved_by`` is filled on rejection too, so the column is headed "Reviewed By"."""
    name = clean(name, 80)
    if role == "hr":
        return f"HR – {name}" if name else "HR"
    if role == "dept_head":
        return f"HOD – {name}" if name else "HOD"
    if role == "system":
        return f"On-Duty approval ({name})" if name else "On-Duty approval"
    return name


def role_label(role) -> str | None:
    if not role:
        return None
    return ROLE_LABELS.get(role, str(role))


def status_label(value) -> str | None:
    if not value:
        return None
    return STATUS_LABELS.get(value, str(value).title())


def source_label(value) -> str | None:
    if not value:
        return None
    return SOURCE_LABELS.get(value, str(value))


# ── pass state ──────────────────────────────────────────────────────────────


def as_pass(row: dict) -> SimpleNamespace:
    """A ``.values()`` row as an object ``pass_state`` can read."""
    return SimpleNamespace(**row)


def pass_state(req, now_dt: datetime, today: date) -> str:
    """One key of ``STATE_LABELS`` for an OutpassRequest (or ``as_pass`` row).

    Starts from the app's own ``_outpass_scan_status`` (never re-implemented) and only refines the
    "left the premises" outcomes so that a pass scanned out yesterday is not shown as live."""
    expires_at = req.approved_at + PASS_VALID if req.approved_at else None
    base = _outpass_scan_status(req, expires_at, now_dt)
    if base in OUTSIDE_STATES:
        if req.pass_type == "early_dismissal":
            return "early_dismissal"
        exit_day = ist_date(req.exited_at)
        if exit_day is not None and exit_day < today:
            return "not_returned"
    return base


def state_label(state: str) -> str | None:
    return STATE_LABELS.get(state)


def movement_label(state: str) -> str | None:
    return MOVEMENT_LABELS.get(state)


def is_open(state: str) -> bool:
    """Left and no return recorded (early-dismissal passes are not expected back, so not "open")."""
    return state in OPEN_STATES


def overrun_minutes(req, state: str, now_dt: datetime) -> int | None:
    """Minutes past ``expected_return_at``. Only measurable when the employee came back (entered_at) or is
    outside today (running, as of ``now``). Old open rows and early dismissals have no meaningful overrun."""
    exp = req.expected_return_at
    if exp is None or req.exited_at is None:
        return None
    if req.entered_at is not None:
        return half_up_minutes((req.entered_at - exp).total_seconds())
    if state in OUTSIDE_STATES:
        return half_up_minutes((now_dt - exp).total_seconds())
    return None


def is_late(overrun: int | None) -> bool:
    return overrun is not None and overrun >= 1


def return_qr_state(req, now_dt: datetime) -> str:
    if not req.return_qr_generated_at:
        return "Not generated"
    if now_dt < req.return_qr_generated_at + timedelta(minutes=RETURN_QR_VALID_MINUTES):
        return "Valid"
    return "Expired"


# ── query helpers ───────────────────────────────────────────────────────────


def pass_type_q(value: str | None, prefix: str = "") -> Q:
    if not value:
        return Q()
    if value == "unspecified":
        return Q(**{f"{prefix}pass_type__isnull": True}) | Q(**{f"{prefix}pass_type": ""})
    return Q(**{f"{prefix}pass_type": value})


def gate_name_q(value: str | None, fields: tuple[str, ...]) -> Q:
    """Case-insensitive 'gate name contains' across the given gate FK paths (any one may match)."""
    if not value:
        return Q()
    q = Q()
    for f in fields:
        q |= Q(**{f"{f}__name__icontains": value})
    return q


def branch_q(ctx, field: str = "branch_id") -> Q:
    """Branch isolation + the user-chosen Branch filter on a model with a DIRECT branch column."""
    q = Q()
    scope = get_branch_scope(ctx.request)
    if scope is not None:
        q &= Q(**{field: scope})
    ids = ctx.params.get("branch_ids")
    if ids:
        q &= Q(**{f"{field}__in": ids})
    return q


def employee_link_q(ctx, prefix: str = "employee__") -> Q:
    """The employee-attribute filters (department, designation, type, employee) through an optional FK,
    WITHOUT the branch clause - for rows whose branch is scoped through another column."""
    p = ctx.params
    q = Q()
    if p.get("department_ids"):
        q &= Q(**{f"{prefix}department_id__in": p["department_ids"]})
    if p.get("designation_ids"):
        q &= Q(**{f"{prefix}designation_id__in": p["designation_ids"]})
    if p.get("employment_type"):
        q &= Q(**{f"{prefix}employment_type": p["employment_type"]})
    if p.get("employee_ids"):
        q &= Q(**{f"{prefix}id__in": p["employee_ids"]})
    status = p.get("employee_status")
    if status == "active":
        q &= Q(**{f"{prefix}status": "active"})
    elif status == "inactive":
        q &= ~Q(**{f"{prefix}status": "active"})
    return q


def scan_scope_q(ctx) -> Q:
    """OutpassGateScan has no branch column. A row belongs to a branch through its gate OR its employee.
    A branch-scoped user sees a row only when one of those links is to their branch, so rows that cannot be
    attributed (forged QR at a since-deleted gate) stay with unscoped users. The Branch filter narrows the
    same way and is AND-ed after the isolation clause, so it can never widen it."""
    q = Q()
    scope = get_branch_scope(ctx.request)
    if scope is not None:
        q &= Q(gate__branch_id=scope) | Q(employee__branch_id=scope)
    ids = ctx.params.get("branch_ids")
    if ids:
        q &= Q(gate__branch_id__in=ids) | Q(employee__branch_id__in=ids)
    return q & employee_link_q(ctx)


def truncated_note(ctx, count: int) -> str | None:
    """A note when the row limit cut the list (the runner also flags it; summary cards then cover the
    listed rows only)."""
    if count >= ctx.row_limit:
        return "The list was cut at the row limit, so the headline figures cover the listed rows only. Narrow the filters."
    return None


# ── filter factories ────────────────────────────────────────────────────────


def dates(label: str, basis: str, default: str = "thisMonth") -> FilterSpec:
    """The IST date-range filter with a help line naming which timestamp it filters on."""
    return replace(
        date_range(default=default),
        label=label,
        help=f"IST calendar days, both ends included. Filters on {basis}.",
    )


def pass_type_filter() -> FilterSpec:
    return select("passType", "Pass type", PASS_TYPE_OPTIONS, placeholder="All pass types")


def gate_filter() -> FilterSpec:
    return text("gate", "Gate name contains", placeholder="e.g. Gate 1")


def fmt(value) -> str | None:
    """Aware datetime -> 'YYYY-MM-DD HH:MM' IST."""
    return fmt_dt(value)


def top(items: list[tuple[str, float | int]], n: int = 5) -> list[tuple[str, float | int]]:
    """Highest ``n`` (label, value) pairs, ties broken by label, zero/None dropped."""
    ranked = sorted((i for i in items if i[1]), key=lambda i: (-i[1], i[0]))
    return ranked[:n]


def sum_totals(rows: list[dict], keys: list[str]) -> dict:
    out: dict = {}
    for k in keys:
        vals = [r[k] for r in rows if isinstance(r.get(k), (int, float)) and not isinstance(r.get(k), bool)]
        out[k] = sum(vals) if vals else None
    return out

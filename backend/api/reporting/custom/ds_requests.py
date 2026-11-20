"""Customise data source "requests": one row per employee request of five kinds, side by side: Leave (LeaveRequest),
Casual Leave (CasualLeaveRequest: a full day counts 1, a half day 0.5 - cl_balance.PORTION_DAYS), Permission
(EmployeePermission), On-duty (OnDutySession, dated by the IST day it was raised) and Missing punch (MissingPunchRequest).

A kind is listed only for a role that may open its own page (Leave, Casual Leave, Requests, Geo Attendance, Missing Punch);
the others are left out with a note. Statuses are put in three words (Pending / Approved / Rejected) so one filter fits
every kind; the kind's own stage (Pending HOD, Active ...) is in the Stage field.
"""

from __future__ import annotations

from datetime import date, datetime

from django.db.models import Q

from api.cl_balance import PORTION_DAYS, PORTION_LABEL, portion_of
from api.models import CasualLeaveRequest, EmployeePermission, LeaveRequest, MissingPunchRequest, OnDutySession

from .. import filters as Fl
from ..definitions.payroll_core_common import has_module
from ..definitions.requests_leave_common import (
    LeaveTypeCatalog,
    clip,
    ist_bounds,
    ist_date,
    leave_overlap_q,
    parse_leave_range,
    role_label,
)
from ..formatting import fmt_dt
from ..types import BADGE, DATE, DATETIME, HOURS, NUMBER, TEXT, TIME
from .common import employee_cells, employee_fields, related, scope_filters
from .fields import Dataset, Field, LoadResult

LEAVE, CL, PERMISSION, ON_DUTY, MISSING = "leave", "casual_leave", "permission", "on_duty", "missing_punch"
KINDS = (
    (LEAVE, "Leave", "leave"),
    (CL, "Casual Leave", "casual_leave"),
    (PERMISSION, "Permission", "requests"),
    (ON_DUTY, "On-duty", "geo_attendance"),
    (MISSING, "Missing punch", "missing_punch"),
)  # (key, label, the permission module that opens it)
KIND_LABEL = {k: label for k, label, _m in KINDS}
STATUS_OPTIONS = (("pending", "Pending"), ("approved", "Approved"), ("rejected", "Rejected"))
_STAGE = {
    "pending_hod": "Pending HOD",
    "pending_hr": "Pending HR",
    "active": "Active (approved)",
    "completed": "Completed",
    "pending": "Pending",
    "approved": "Approved",
    "rejected": "Rejected",
}


# The three words of the Status filter, and the stored statuses each one covers (every kind)
_STATUS_DB = {
    "pending": ("pending", "pending_hod", "pending_hr"),
    "approved": ("approved", "active", "completed"),
    "rejected": ("rejected",),
}


def _status_q(status: str | None) -> Q:
    q = Q()
    for value in _STATUS_DB.get(status or "", ()):
        q |= Q(status__iexact=value)
    return q


def _status3(raw: str | None) -> str:
    s = (raw or "").strip().lower()
    if s in ("pending", "pending_hod", "pending_hr"):
        return "Pending"
    if s in ("approved", "active", "completed"):
        return "Approved"
    if s == "rejected":
        return "Rejected"
    return s.title() or "Pending"


def _r(key, label, type_, desc=None, total=None, width=1.0) -> Field:
    return Field(key, label, type_, "request", "req", desc, width=width, total=total)


FIELDS = (
    *employee_fields(),
    _r("req.type", "Request type", TEXT, "Leave, Casual Leave, Permission, On-duty or Missing punch", width=1.1),
    _r(
        "req.detail",
        "Kind",
        TEXT,
        "Leave type, CL portion, permission type, on-duty destination or missing slot",
        width=1.5,
    ),
    _r("req.from", "From", DATE),
    _r("req.to", "To", DATE),
    _r("req.days", "Days", NUMBER, "Leave and Casual Leave days (a half day 0.5); on-duty 1", "sum", 0.7),
    _r("req.hours", "Hours", HOURS, "Permission hours", "sum", 0.7),
    _r("req.time", "Time", TIME, "Permission / missing-punch time", width=0.7),
    _r("req.status", "Status", BADGE, "Pending, Approved or Rejected", width=0.9),
    _r("req.stage", "Stage", TEXT, "The request's own stage (Pending HOD, Pending HR, Active, Completed ...)"),
    _r("req.applied_on", "Applied on", DATETIME, width=1.3),
    _r("req.decided_by", "Decided by", TEXT, width=1.4),
    _r("req.decided_on", "Decided on", DATETIME, width=1.3),
    _r("req.reason", "Reason", TEXT, width=2.4),
)


def _trail_at(trail) -> str | None:
    """When the last approval step was decided, from the approval trail (approval_workflow)."""
    for step in reversed(list(trail or [])):
        if isinstance(step, dict) and step.get("decision") in ("approved", "rejected") and step.get("at"):
            try:
                return fmt_dt(datetime.fromisoformat(str(step["at"])))
            except ValueError:
                return None
    return None


def _row(lr_emp, kind: str, **cells) -> dict:
    return {**employee_cells(lr_emp), "req.type": KIND_LABEL[kind], **cells}


def _leaves(ctx, lo: date, hi: date, limit: int, sq: Q) -> list[dict]:
    catalog = LeaveTypeCatalog()
    out = []
    qs = related(LeaveRequest.objects.filter(ctx.emp_q("employee__"), sq).filter(leave_overlap_q(lo, hi)))
    for lr in qs.select_related("leave_type_ref").order_by("start_date", "id")[: limit + 1]:
        span = parse_leave_range(lr)
        if span is None or span[1] < lo or span[0] > hi:
            continue  # unreadable text dates, or a non-ISO row that does not overlap after all
        slot = dict(LeaveRequest.HALF_DAY_CHOICES).get(lr.half_day_slot or "", "") if lr.is_half_day else ""
        detail = catalog.resolve(lr).label + (f" - {slot}" if slot else "")
        out.append(
            _row(
                lr.employee,
                LEAVE,
                **{
                    "req.detail": detail,
                    "req.from": span[0].isoformat(),
                    "req.to": span[1].isoformat(),
                    "req.days": 0.5 if lr.is_half_day else float(lr.total_days or 0),
                    "req.status": _status3(lr.status),
                    "req.stage": _STAGE.get((lr.status or "").lower(), (lr.status or "").title() or None),
                    "req.applied_on": fmt_dt(lr.created_at),
                    "req.decided_by": _by(lr.approved_by, lr.approver_role),
                    "req.decided_on": _trail_at(lr.approval_trail),
                    "req.reason": clip(lr.reason, 300),
                },
            )
        )
    return out


def _casual(ctx, lo: date, hi: date, limit: int, sq: Q) -> list[dict]:
    qs = related(CasualLeaveRequest.objects.filter(ctx.emp_q("employee__"), sq, date__gte=lo, date__lte=hi))
    out = []
    for cl in qs.order_by("date", "id")[: limit + 1]:
        portion = portion_of(cl.portion)
        out.append(
            _row(
                cl.employee,
                CL,
                **{
                    "req.detail": PORTION_LABEL[portion],
                    "req.from": cl.date.isoformat(),
                    "req.to": cl.date.isoformat(),
                    "req.days": float(PORTION_DAYS[portion]),
                    "req.status": _status3(cl.status),
                    "req.stage": _STAGE.get(cl.status, cl.status),
                    "req.applied_on": fmt_dt(cl.created_at),
                    "req.decided_by": _by(cl.reviewed_by, cl.reviewer_role),
                    "req.decided_on": fmt_dt(cl.reviewed_at) or _trail_at(cl.approval_trail),
                    "req.reason": clip(cl.reason, 300),
                },
            )
        )
    return out


def _permissions(ctx, lo: date, hi: date, limit: int, sq: Q) -> list[dict]:
    qs = related(EmployeePermission.objects.filter(ctx.emp_q("employee__"), sq, date__gte=lo, date__lte=hi))
    out = []
    for p in qs.order_by("date", "id")[: limit + 1]:
        minutes = p.duration_minutes or EmployeePermission.FIXED_DURATION_MINUTES
        out.append(
            _row(
                p.employee,
                PERMISSION,
                **{
                    "req.detail": EmployeePermission.TYPE_LABELS.get(p.type_key, "Permission"),
                    "req.from": p.date.isoformat(),
                    "req.to": p.date.isoformat(),
                    "req.hours": round(minutes / 60, 2),
                    "req.time": p.permission_time.strftime("%H:%M") if p.permission_time else None,
                    "req.status": _status3(p.status),
                    "req.stage": _STAGE.get(p.status, p.status),
                    "req.applied_on": fmt_dt(p.created_at),
                    "req.decided_by": _by(p.approved_by, p.approver_role),
                    "req.decided_on": _trail_at(p.approval_trail),
                    "req.reason": clip(p.reason, 300),
                },
            )
        )
    return out


def _on_duty(ctx, lo: date, hi: date, limit: int, sq: Q) -> list[dict]:
    start, end = ist_bounds(lo, hi)
    qs = related(OnDutySession.objects.filter(ctx.emp_q("employee__"), sq, created_at__gte=start, created_at__lt=end))
    out = []
    for s in qs.order_by("created_at", "id")[: limit + 1]:
        day = ist_date(s.created_at)
        decided_at = s.hr_reviewed_at or (s.hod_reviewed_at if s.status == "rejected" else None)
        out.append(
            _row(
                s.employee,
                ON_DUTY,
                **{
                    "req.detail": clip(s.destination, 120),
                    "req.from": day.isoformat() if day else None,
                    "req.to": day.isoformat() if day else None,
                    "req.days": 1.0,
                    "req.status": _status3(s.status),
                    "req.stage": _STAGE.get(s.status, s.status),
                    "req.applied_on": fmt_dt(s.created_at),
                    "req.decided_by": s.hr_reviewed_by or s.hod_reviewed_by or None,
                    "req.decided_on": fmt_dt(decided_at),
                    "req.reason": clip(s.destination, 300),
                },
            )
        )
    return out


def _missing(ctx, lo: date, hi: date, limit: int, sq: Q) -> list[dict]:
    qs = related(MissingPunchRequest.objects.filter(ctx.emp_q("employee__"), sq, date__gte=lo, date__lte=hi))
    slots = dict(MissingPunchRequest.PUNCH_SLOT_CHOICES)
    out = []
    for m in qs.order_by("date", "id")[: limit + 1]:
        decided_at = m.hr_reviewed_at or (m.hod_reviewed_at if m.status == "rejected" else None)
        out.append(
            _row(
                m.employee,
                MISSING,
                **{
                    "req.detail": slots.get(m.punch_slot or "", "Punch") + f" ({m.punch_type})",
                    "req.from": m.date.isoformat(),
                    "req.to": m.date.isoformat(),
                    "req.time": m.punch_time.strftime("%H:%M") if m.punch_time else None,
                    "req.status": _status3(m.status),
                    "req.stage": _STAGE.get(m.status, m.status),
                    "req.applied_on": fmt_dt(m.created_at),
                    "req.decided_by": m.hr_reviewed_by or m.hod_reviewed_by or None,
                    "req.decided_on": fmt_dt(decided_at),
                    "req.reason": clip(m.reason, 300),
                },
            )
        )
    return out


def _by(name, role) -> str | None:
    name = (name or "").strip()
    if not name:
        return None
    role_text = role_label(role)
    return f"{name} ({role_text})" if role_text else name


_LOADERS = {LEAVE: _leaves, CL: _casual, PERMISSION: _permissions, ON_DUTY: _on_duty, MISSING: _missing}


def _load(ctx, keys: list[str], ceiling: int) -> LoadResult:
    lo, hi = ctx.date_from, ctx.date_to
    chosen = set(ctx.params.get("requestType") or ()) or {k for k, _l, _m in KINDS}
    hidden = [label for k, label, module in KINDS if k in chosen and not has_module(ctx, module)]
    sq = _status_q(ctx.params.get("requestStatus"))
    rows: list[dict] = []
    capped = False
    for kind, _label, module in KINDS:
        if kind not in chosen or not has_module(ctx, module):
            continue
        rows += _LOADERS[kind](ctx, lo, hi, ceiling, sq)
    # one list, in date order (then the employee code)
    rows.sort(key=lambda r: (r.get("req.from") or "", r.get("emp.code") or "", r["req.type"]))
    if len(rows) > ceiling:
        rows, capped = rows[:ceiling], True
    notes = []
    if hidden:
        notes.append(f"Not included, because your role cannot open them: {', '.join(hidden)} requests.")
    return LoadResult(rows=rows, notes=notes, capped=capped)


REQUESTS = Dataset(
    id="requests",
    label="Requests",
    description="One row per request: leave, Casual Leave, permission, on-duty and missing punch, with dates, days or "
    "hours, status, who decided and the reason.",
    grain="request",
    filters=(
        Fl.date_range(),
        *scope_filters(designation=False),
        Fl.select(
            "requestType", "Request type", [(k, label) for k, label, _m in KINDS], multi=True, placeholder="Every kind"
        ),  # fmt: skip
        Fl.select("requestStatus", "Status", STATUS_OPTIONS, placeholder="Every status"),
    ),
    sections=(("employee", "Employee"), ("request", "Request")),
    fields=FIELDS,
    default_fields=(
        "emp.code",
        "emp.name",
        "emp.department",
        "req.type",
        "req.detail",
        "req.from",
        "req.to",
        "req.days",
        "req.status",
        "req.decided_by",
    ),  # fmt: skip
    load=_load,
    modules=tuple(dict.fromkeys(m for _k, _l, m in KINDS)),
    notes=(
        "A request is listed when its date falls in the date range (a leave when any of its days does; an on-duty "
        "session by the IST day it was raised). Casual Leave days follow the Casual Leave rules: a full day counts 1, a "
        "half day 0.5. Leave days are the request's own day count.",
    ),
)

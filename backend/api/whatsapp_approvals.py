"""
WhatsApp messages for approval decisions -one place for every approval workflow.

    leave / permission / casual leave / missing punch / outpass / attendance correction /
    resignation / advance / other employee requests

Each workflow has a small *builder* that turns its own record into the common shape the
"Approval - Approved" / "Approval - Rejected" wording expects (what was asked for, when, why).
The workflow's approve/reject code then makes ONE call:

    whatsapp_approvals.notify_decision("leave", leave_request, "approved", approver="Meena", role="hr")

To cover a new approval workflow add a builder with `@register("key", "/portal/path")` here and
the key to `whatsapp_catalog.APPROVAL_MODULES` -nothing else changes (the switches on the
WhatsApp Control page, the log and the template editor pick it up from the catalog).

Geo Attendance (On-Duty) and its punches have their own wording -see whatsapp_notifications.

Only FINAL decisions are announced: an approval that merely passes a request on to the next
stage (Department Head -> HR) stays quiet until HR decides, but any rejection is final and is
sent at once. Failures never reach the caller: every attempt is logged for HR and a broken
message can't block an approval.
"""

import logging
from dataclasses import dataclass
from typing import Callable

from django.conf import settings as dj_settings

from . import whatsapp_service
from .whatsapp_format import (
    date_str as _date,
    full_name as _name,
    join as _join,
    stamp_str as _stamp,
    time_str as _time,
)

logger = logging.getLogger(__name__)

ROLE_LABELS = {"hr": "HR", "dept_head": "Department Head", "system": "System"}


@dataclass
class Summary:
    """What the message says about the original request."""

    employee: object
    request_type: str
    ref_id: int
    date: str = ""
    time: str = ""
    details: str = ""
    reason: str = ""
    requested_on: str = ""
    # For an approved message only: what happens next (e.g. how long an outpass QR is valid).
    next_step: str = ""


_BUILDERS: dict[str, tuple[Callable, str]] = {}


def register(module: str, portal_path: str = ""):
    """Register the builder for an approval workflow. `portal_path` is the page of the Employee
    Web App where the employee can see the request (used for the "View request" link)."""

    def wrap(fn):
        _BUILDERS[module] = (fn, portal_path)
        return fn

    return wrap


# ── formatting helpers ─────────────────────────────────────────────────────────


def approver_label(name: str, role: str = "") -> str:
    name = (name or "").strip()
    suffix = ROLE_LABELS.get(role, "")
    if name and suffix and suffix.lower() not in name.lower():
        return f"{name} ({suffix})"
    return name or suffix or "HR"


def portal_link(path: str) -> str:
    base = dj_settings.EMPLOYEE_PORTAL_URL
    return f"{base}{path}" if base and path else ""


# ── builders ───────────────────────────────────────────────────────────────────


@register("leave", "/employee/leave")
def _leave(r) -> Summary:
    kind = (r.leave_type_ref.name if r.leave_type_ref_id else (r.type or "leave")).replace("_", " ").title()
    if r.is_half_day:
        days = f"Half day ({r.half_day_slot or 'half'})"
    else:
        n = float(r.total_days or 1)
        days = f"{n:g} day{'s' if n != 1 else ''}"
    when = _date(r.start_date) if r.start_date == r.end_date else f"{_date(r.start_date)} to {_date(r.end_date)}"
    return Summary(
        r.employee,
        "Leave",
        r.id,
        date=when,
        details=_join(f"{kind} ({days})", r.reason),
        reason=r.reason or "",
        requested_on=_stamp(r.created_at),
    )


@register("permission", "/employee/permissions")
def _permission(p) -> Summary:
    length = f"{p.duration_minutes} min" if p.duration_minutes else ""
    return Summary(
        p.employee,
        "Permission",
        p.id,
        date=_date(p.date),
        time=_time(p.permission_time),
        details=_join(p.type, length, p.reason),
        reason=p.reason or "",
        requested_on=_stamp(p.created_at),
    )


@register("casual_leave", "/employee/casual-leave")
def _casual_leave(cl) -> Summary:
    return Summary(
        cl.employee,
        "Casual Leave",
        cl.id,
        date=_date(cl.date),
        details=_join("Casual Leave (paid)", cl.reason),
        reason=cl.reason or "",
        requested_on=_stamp(cl.created_at),
    )


@register("missing_punch", "/employee/missing-punch")
def _missing_punch(r) -> Summary:
    slot = dict(r.PUNCH_SLOT_CHOICES).get(r.punch_slot) or ("Check-In" if r.punch_type == "IN" else "Check-Out")
    return Summary(
        r.employee,
        "Missing Punch",
        r.id,
        date=_date(r.date),
        time=_time(r.punch_time),
        details=_join(slot, r.reason),
        reason=r.reason or "",
        requested_on=_stamp(r.created_at),
    )


@register("outpass", "/employee/outpass")
def _outpass(r) -> Summary:
    kind = dict(r.PASS_TYPE_CHOICES).get(r.pass_type, "")
    back = f"Expected back {_time(r.expected_return_at)}" if r.expected_return_at else ""
    return Summary(
        r.employee,
        "Gate Outpass",
        r.id,
        date=_date(r.created_at),
        time=_time(r.expected_return_at),
        details=_join(kind, r.destination, r.reason, back, sep=" | "),
        reason=r.reason or "",
        requested_on=_stamp(r.created_at),
        next_step="Show your pass QR at the gate within 60 minutes.",
    )


@register("attendance_correction", "/employee/attendance")
def _attendance_correction(r) -> Summary:
    status = (r.requested_values or {}).get("status")
    change = f"Change day to {str(status).replace('_', ' ')}" if status else "Attendance correction"
    return Summary(
        r.employee,
        "Attendance Correction",
        r.id,
        date=_date(r.date),
        details=_join(change, r.reason),
        reason=r.reason or "",
        requested_on=_stamp(r.created_at),
    )


@register("resignation", "/employee/resignation")
def _resignation(r) -> Summary:
    last = f"Last working day: {_date(r.last_working_date)}" if r.last_working_date else ""
    return Summary(
        r.employee,
        "Resignation",
        r.id,
        date=_date(r.last_working_date),
        details=last or "Resignation request",
        reason=r.reason or "",
        requested_on=_stamp(r.created_at),
    )


@register("advance", "/employee/salary")
def _advance(a) -> Summary:
    kind = dict(a.ADVANCE_TYPES).get(a.advance_type, "Advance")
    return Summary(
        a.employee,
        "Advance",
        a.id,
        date=_date(a.created_at),
        details=_join(kind, f"Rs {float(a.amount):,.2f}", a.purpose),
        reason=a.purpose or "",
        requested_on=_stamp(a.created_at),
    )


@register("request", "/employee/notifications")
def _employee_request(r) -> Summary:
    label = dict(r.REQUEST_TYPES).get(r.request_type, "Request")
    return Summary(
        r.employee,
        label,
        r.id,
        date=_date(r.created_at),
        details=r.subject,
        reason=r.description or "",
        requested_on=_stamp(r.created_at),
    )


# ── the one call every approval workflow makes ─────────────────────────────────


def notify_decision(module: str, obj, decision: str, *, approver: str = "", role: str = "", comment: str | None = None):
    """WhatsApp the employee that their `module` request `obj` was approved or rejected.
    Returns the log row (or None when nothing was sent: switched off, not configured, already sent).
    Never raises."""
    try:
        if decision not in ("approved", "rejected"):
            return None
        builder, path = _BUILDERS[module]
        summary = builder(obj)
        approved = decision == "approved"
        comment = (comment or "").strip()
        link = portal_link(path)
        details = _join(summary.details, summary.next_step, sep=". ") if approved else summary.details
        params = {
            "employee_name": _name(summary.employee),
            "request_type": summary.request_type,
            "date": summary.date,
            "time": summary.time,
            "details": details,
            "approver": approver_label(approver, role),
            "comment": comment,
            "requested_on": summary.requested_on,
            "link": link,
            "reason": summary.reason,
        }
        return whatsapp_service.send_notification(
            summary.employee,
            "approval_approved" if approved else "approval_rejected",
            params,
            dedupe_key=f"approval:{module}:{obj.pk}:{decision}",
            document_ref_id=obj.pk,
            related_module=module,
            link_url=link,
        )
    except Exception:
        logger.exception("Approval WhatsApp failed for %s %s", module, getattr(obj, "pk", None))
        return None

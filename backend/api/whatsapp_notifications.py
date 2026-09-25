"""
WhatsApp messages the system sends about what happened to an employee's own things:

  * Geo Attendance (On-Duty) requests and their punches -approved or rejected
  * Gate movement -an employee recorded going OUT or coming back IN
  * A visitor arriving to meet an employee (with the visitor's tap-to-call contact card)

Approval decisions for the other workflows (leave, permission, ...) live in whatsapp_approvals.

Everything here is best-effort by design: a failed or switched-off message must never stop the
approval, gate scan or check-in that raised it, so callers just call these and move on. Every
attempt (and its failure reason) lands in WhatsAppMessageLog for HR to see, and the message itself
is delivered in the background so nobody waits on WhatsApp.
"""

import functools
import logging
import time as time_module

from django.utils import timezone

from . import whatsapp_service
from .whatsapp_approvals import approver_label, portal_link
from .whatsapp_format import date_str, duration_str, full_name, pretty_phone, stamp_str, time_str

logger = logging.getLogger(__name__)


def best_effort(fn):
    """A notification must never break the workflow that raised it: log any error and return None."""

    @functools.wraps(fn)
    def inner(*args, **kwargs):
        try:
            return fn(*args, **kwargs)
        except Exception:
            logger.exception("WhatsApp notification %s failed", fn.__name__)
            return None

    return inner


# ── Geo Attendance (On-Duty) ───────────────────────────────────────────────────


@best_effort
def notify_geo_session_approved(session, reviewer_name: str, comment: str | None = None):
    """The employee's Geo Attendance (On-Duty) request got its final approval from HR.
    Restates what they submitted -the destination and when they asked."""
    emp = session.employee
    comment = (comment or "").strip()
    return whatsapp_service.send_notification(
        emp,
        "geo_approval",
        {
            "employee_name": full_name(emp),
            "destination": session.destination,
            "requested_on": stamp_str(session.created_at),
            "approved_by": reviewer_name or "HR",
            "note": f"\nNote: {comment}" if comment else "",
            "comment": comment,
        },
        dedupe_key=f"geo:{session.id}",
        document_ref_id=session.id,
        related_module="on_duty",
    )


@best_effort
def notify_geo_session_rejected(
    session, reviewer_name: str, role: str = "hr", comment: str | None = None, voided: int = 0
):
    """The employee's Geo Attendance (On-Duty) request was rejected -by their Department Head or
    by HR. `voided` is how many punches recorded under it stopped counting."""
    emp = session.employee
    return whatsapp_service.send_notification(
        emp,
        "geo_rejection",
        {
            "employee_name": full_name(emp),
            "destination": session.destination,
            "requested_on": stamp_str(session.created_at),
            "rejected_by": approver_label(reviewer_name, role),
            "comment": (comment or "").strip(),
            "punches_note": f"The {voided} punch(es) you recorded under it were not counted." if voided else "",
        },
        dedupe_key=f"geo:{session.id}:rejected",
        document_ref_id=session.id,
        related_module="on_duty",
    )


def _punch_params(verification) -> dict:
    emp = verification.employee
    return {
        "employee_name": full_name(emp),
        "punch_name": "Check-In" if verification.punch_type == "IN" else "Check-Out",
        "date": date_str(verification.punch_date),
        "time": time_str(verification.punch_time),
        "location": f"https://maps.google.com/?q={verification.latitude},{verification.longitude}",
    }


@best_effort
def notify_geo_punch_approved(verification, reviewer_name: str, comment: str | None = None):
    """A single captured Geo Attendance punch was approved. Restates what the employee submitted:
    which punch, when, and where."""
    return whatsapp_service.send_notification(
        verification.employee,
        "geo_punch_approval",
        {**_punch_params(verification), "approved_by": reviewer_name or "HR", "comment": (comment or "").strip()},
        dedupe_key=f"geopunch:{verification.id}",
        document_ref_id=verification.id,
        related_module="on_duty_punch",
    )


@best_effort
def notify_geo_punch_rejected(verification, reviewer_name: str, comment: str | None = None):
    """A single captured Geo Attendance punch was rejected; it does not count and can be retried."""
    return whatsapp_service.send_notification(
        verification.employee,
        "geo_punch_rejection",
        {**_punch_params(verification), "rejected_by": reviewer_name or "HR", "comment": (comment or "").strip()},
        dedupe_key=f"geopunch:{verification.id}:rejected",
        document_ref_id=verification.id,
        related_module="on_duty_punch",
    )


@best_effort
def notify_geo_punches_decided(session, decision: str, count: int, reviewer_name: str, comment: str | None = None):
    """HR approved or rejected every punch still pending under one On-Duty request in a single
    action -one summary message instead of a ping per punch."""
    if not count:
        return None
    approved = decision == "approved"
    params = {
        "employee_name": full_name(session.employee),
        "punch_name": f"{count} punch{'es' if count != 1 else ''} (" + session.destination + ")",
        "date": date_str(timezone.now()),
        "comment": (comment or "").strip(),
        "approved_by" if approved else "rejected_by": reviewer_name or "HR",
    }
    return whatsapp_service.send_notification(
        session.employee,
        "geo_punch_approval" if approved else "geo_punch_rejection",
        params,
        # A window of a few seconds so a double-click sends once, but a later batch still goes out.
        dedupe_key=f"geopunches:{session.id}:{decision}:{int(time_module.time() // 30)}",
        document_ref_id=session.id,
        related_module="on_duty_punch",
    )


# ── Gate movement (Outpass) ────────────────────────────────────────────────────


def _gate_params(req) -> dict:
    emp = req.employee
    kind = dict(req.PASS_TYPE_CHOICES).get(req.pass_type, "Outpass")
    out_at = req.exited_at
    return {
        "employee_name": full_name(emp),
        "pass_type": kind,
        "destination": req.destination,
        "reason": req.reason,
        "date": date_str(out_at or req.created_at),
        "gate_out_time": time_str(out_at) if out_at else "",
        "gate_in_time": time_str(req.entered_at) if req.entered_at else "",
        "duration": duration_str((req.entered_at - out_at).total_seconds()) if out_at and req.entered_at else "",
        "gate_name": "",
        "status": "Verified",
        "approved_by": approver_label(req.approved_by or "", req.approver_role or ""),
    }


@best_effort
def notify_gate_out(req):
    """The gate scanner verified an approved outpass and recorded the employee going OUT."""
    params = _gate_params(req)
    params["gate_name"] = req.exit_gate.name if req.exit_gate_id else ""
    params["next_step"] = "Please scan your Return QR at the gate when you come back."
    return whatsapp_service.send_notification(
        req.employee,
        "outpass_gate_out",
        params,
        dedupe_key=f"gate:out:{req.id}",
        document_ref_id=req.id,
        related_module="outpass",
        link_url=portal_link("/employee/outpass"),
    )


@best_effort
def notify_gate_in(req):
    """The gate scanner verified the return QR and recorded the employee coming back IN."""
    params = _gate_params(req)
    params["gate_name"] = req.entry_gate.name if req.entry_gate_id else ""
    return whatsapp_service.send_notification(
        req.employee,
        "outpass_gate_in",
        params,
        dedupe_key=f"gate:in:{req.id}",
        document_ref_id=req.id,
        related_module="outpass",
        link_url=portal_link("/employee/outpass"),
    )


@best_effort
def notify_gate_record(record):
    """Someone recorded a gate exit for this employee through the gate QR form. It is unverified
    -anyone can type an employee code- so the message doubles as a "was this you?" check."""
    emp = record.employee
    if emp is None:
        return None
    return whatsapp_service.send_notification(
        emp,
        "outpass_gate_out",
        {
            "employee_name": full_name(emp),
            "pass_type": "Gate QR form",
            "destination": record.destination,
            "date": date_str(record.submitted_at),
            "gate_out_time": time_str(record.submitted_at),
            "gate_name": record.branch.name if record.branch_id else "",
            "status": "Recorded from the gate QR form (not scanned by a guard)",
            "next_step": "If this wasn't you, please tell HR.",
        },
        dedupe_key=f"gate:record:{record.id}",
        document_ref_id=record.id,
        related_module="outpass",
    )


# ── Visitors ───────────────────────────────────────────────────────────────────


@best_effort
def notify_visitor_arrival(visit, host, on_sent=None):
    """Tell `host` a visitor has arrived, with everything they need to know and the visitor's
    contact card to tap and call. `on_sent(log)` runs once the message is really delivered."""
    visitor = visit.visitor
    arrived = visit.visited_at or timezone.now()
    normalized = whatsapp_service.normalize_phone(visitor.phone)
    return whatsapp_service.send_notification(
        host,
        "visitor_notification",
        {
            "employee_name": full_name(host),
            "visitor_name": visitor.name,
            "visitor_phone": pretty_phone(visitor.phone, normalized),
            "purpose": visit.purpose or "",
            "company": getattr(visitor, "company", "") or "",
            "host_name": visit.whom_to_meet or full_name(host),
            "department": host.department.name if host.department_id else "",
            "visit_date": date_str(arrived),
            "visit_time": time_str(arrived),
            "branch": visit.branch.name if visit.branch_id else "",
            "why_came": visit.why_came or "",
        },
        document_ref_id=visit.id,
        contact={
            "document_type": "visitor_contact",
            "first_name": visitor.name,
            "last_name": "",
            "phone": normalized or visitor.phone,
        },
        on_sent=on_sent,
    )

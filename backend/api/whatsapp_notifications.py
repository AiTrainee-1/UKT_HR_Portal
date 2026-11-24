"""
WhatsApp messages the system sends about what happened to an employee's own things:

  * Geo Attendance (On-Duty) requests and their punches -approved or rejected
  * Gate movement -an employee recorded going OUT or coming back IN
  * A visitor arriving to meet an employee (the visitor's phone number is a line of the message: the official
    WhatsApp Cloud API starts a conversation with an approved template only, so the old contact card is gone)

Approval decisions for the other workflows (leave, permission, ...) live in whatsapp_approvals.

Each message goes out as its Meta template (whatsapp_catalog: meta_template); every variable is sent on ONE line
(whatsapp_format.flat), Meta's rule for a template variable.

Everything here is best-effort by design: a failed or switched-off message must never stop the
approval, gate scan or check-in that raised it, so callers just call these and move on. Every
attempt (and its failure reason) lands in WhatsAppMessageLog for HR to see, and the message itself
is queued and sent by the paced dispatcher (whatsapp_dispatcher.py), so nobody waits on WhatsApp.
"""

import functools
import logging
import time as time_module

from django.utils import timezone

from . import whatsapp_service
from .whatsapp_approvals import approver_label
from .whatsapp_format import date_str, duration_str, flat, full_name, one_line, pretty_phone, stamp_str, time_str

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
    comment = one_line(comment)
    return whatsapp_service.send_notification(
        emp,
        "geo_approval",
        flat(
            {
                "employee_name": full_name(emp),
                "destination": session.destination,
                "requested_on": stamp_str(session.created_at),
                "approved_by": reviewer_name or "HR",
                "note": f"Note: {comment}" if comment else "",
                "comment": comment,
            }
        ),
        dedupe_key=f"geo:{session.id}",
        document_ref_id=session.id,
        related_module="on_duty",
    )


def geo_session_rejection(
    session, reviewer_name: str, role: str = "hr", comment: str | None = None, voided: int = 0
) -> tuple[str, dict, str]:
    """(message type, variables, dedupe key) of the On-Duty rejection: what notify_geo_session_rejected sends on WhatsApp
    and hands to the phone. The automatic rejection of waiting requests (request_auto_reject) hands it to the phone only."""
    emp = session.employee
    params = flat(
        {
            "employee_name": full_name(emp),
            "destination": session.destination,
            "requested_on": stamp_str(session.created_at),
            "rejected_by": approver_label(reviewer_name, role),
            "comment": comment,
            "punches_note": f"The {voided} punch(es) you recorded under it were not counted." if voided else "",
        }
    )
    return "geo_rejection", params, f"geo:{session.id}:rejected"


@best_effort
def notify_geo_session_rejected(
    session, reviewer_name: str, role: str = "hr", comment: str | None = None, voided: int = 0
):
    """The employee's Geo Attendance (On-Duty) request was rejected -by their Department Head or
    by HR. `voided` is how many punches recorded under it stopped counting."""
    document_type, params, dedupe_key = geo_session_rejection(session, reviewer_name, role, comment, voided)
    return whatsapp_service.send_notification(
        session.employee,
        document_type,
        params,
        dedupe_key=dedupe_key,
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
        flat({**_punch_params(verification), "approved_by": reviewer_name or "HR", "comment": comment}),
        dedupe_key=f"geopunch:{verification.id}",
        document_ref_id=verification.id,
        related_module="on_duty_punch",
    )


def geo_punch_rejection(verification, reviewer_name: str, comment: str | None = None) -> tuple[str, dict, str]:
    """(message type, variables, dedupe key) of a rejected On-Duty punch: what notify_geo_punch_rejected sends on WhatsApp
    and hands to the phone. The automatic rejection of waiting requests (request_auto_reject) hands it to the phone only."""
    params = flat({**_punch_params(verification), "rejected_by": reviewer_name or "HR", "comment": comment})
    return "geo_punch_rejection", params, f"geopunch:{verification.id}:rejected"


@best_effort
def notify_geo_punch_rejected(verification, reviewer_name: str, comment: str | None = None):
    """A single captured Geo Attendance punch was rejected; it does not count and can be retried."""
    document_type, params, dedupe_key = geo_punch_rejection(verification, reviewer_name, comment)
    return whatsapp_service.send_notification(
        verification.employee,
        document_type,
        params,
        dedupe_key=dedupe_key,
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
        flat(params),
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
        flat(params),
        dedupe_key=f"gate:out:{req.id}",
        document_ref_id=req.id,
        related_module="outpass",
    )


@best_effort
def notify_gate_in(req):
    """The gate scanner verified the return QR and recorded the employee coming back IN."""
    params = _gate_params(req)
    params["gate_name"] = req.entry_gate.name if req.entry_gate_id else ""
    return whatsapp_service.send_notification(
        req.employee,
        "outpass_gate_in",
        flat(params),
        dedupe_key=f"gate:in:{req.id}",
        document_ref_id=req.id,
        related_module="outpass",
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
        flat(
            {
                "employee_name": full_name(emp),
                "pass_type": "Gate QR form",
                "destination": record.destination,
                "date": date_str(record.submitted_at),
                "gate_out_time": time_str(record.submitted_at),
                "gate_name": record.branch.name if record.branch_id else "",
                "status": "Recorded from the gate QR form (not scanned by a guard)",
                "next_step": "If this wasn't you, please tell HR.",
            }
        ),
        dedupe_key=f"gate:record:{record.id}",
        document_ref_id=record.id,
        related_module="outpass",
    )


# ── Visitors ───────────────────────────────────────────────────────────────────


@best_effort
def notify_visitor_arrival(visit, host):
    """Tell `host` a visitor has arrived, with everything they need to know and the visitor's
    phone number (a line of the template: a contact card can't be sent with Meta's templates).
    Reception's "notified on WhatsApp" time is stamped once the message is really sent (the
    dispatcher's "visitor_notified" hook)."""
    visitor = visit.visitor
    name = visit.visitor_name or visitor.name  # as given at this visit (per branch, 19 Nov 2026)
    arrived = visit.visited_at or timezone.now()
    normalized = whatsapp_service.normalize_phone(visitor.phone)
    return whatsapp_service.send_notification(
        host,
        "visitor_notification",
        flat(
            {
                "employee_name": full_name(host),
                "visitor_name": name,
                "visitor_phone": pretty_phone(visitor.phone, normalized),
                "purpose": visit.purpose or "",
                "company": getattr(visitor, "company", "") or "",
                "host_name": visit.whom_to_meet or full_name(host),
                "department": host.department.name if host.department_id else "",
                "visit_date": date_str(arrived),
                "visit_time": time_str(arrived),
                "branch": visit.branch.name if visit.branch_id else "",
                "why_came": visit.why_came or "",
            }
        ),
        document_ref_id=visit.id,
        on_sent="visitor_notified",
    )

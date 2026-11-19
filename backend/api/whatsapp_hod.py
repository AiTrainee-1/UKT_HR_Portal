"""WhatsApp to Department Heads: "a request is waiting for your approval" (WhatsApp Control -> Department Head
notifications, owner 2026-11-17).

Called wherever the HRMS tells a head that a request reached their step (approval_workflow.notify_hod_of_request for the
workflow requests, and the On-Duty, Missing Punch and resignation submissions). The message is WhatsApp Control's alone:
its master switch, the section's switch ("Department Head notifications"), the type's switch ("New request waiting for
approval"), its wording (Message Text) and this machine's send rules. The head's phone notification about the same
request is Phone Notify Control's own (approval_waiting), independent of this.

The details come from the same summary the approval / rejection messages use (whatsapp_approvals._BUILDERS), so a leave
says its dates and type, a permission its date and time. One message per request and head (the dedupe key); queued, so the
send queue paces it. Never raises into the request it is about.
"""

from __future__ import annotations

import logging

from django.utils import timezone

logger = logging.getLogger(__name__)

TYPE = "hod_request_waiting"


def _name(e) -> str:
    return f"{getattr(e, 'first_name', '') or ''} {getattr(e, 'last_name', '') or ''}".strip()


def request_waiting(
    head,
    workflow: str,
    emp,
    what: str,
    obj=None,
    *,
    request_type: str = "",
    details: str = "",
    date: str = "",
    dedupe: str = "",
):
    """Queue the message for `head` (an Employee) about `emp`'s request `obj` of `workflow`. `what` is the short phrase the
    caller already has ("leave request"); `request_type` / `details` / `date` fill in for a request with no summary
    builder (On-Duty). `dedupe`, when given, replaces the request's id in the dedupe key (one message per employee + kind
    + date of a compensation claim, however often it is raised and withdrawn). Returns the log row or None (switched off,
    no phone, already queued)."""
    from . import whatsapp_service
    from .whatsapp_approvals import _BUILDERS

    try:
        summary = _BUILDERS[workflow](obj) if obj is not None and workflow in _BUILDERS else None
        params = {
            "hod_name": _name(head),
            "employee_name": _name(emp),
            "employee_code": getattr(emp, "employee_code", "") or "",
            "request_type": (summary.request_type if summary else request_type) or (what[:1].upper() + what[1:]),
            "date": (summary.date if summary else date) or "",
            "time": summary.time if summary else "",
            "details": (summary.details if summary else details) or "",
            "reason": summary.reason if summary else "",
            "requested_on": (summary.requested_on if summary else "") or timezone.localdate().strftime("%d %b %Y"),
        }
        ref = getattr(obj, "pk", None)
        if dedupe:
            key = f"hodwait:{workflow}:{dedupe}:{head.pk}"
        else:
            key = f"hodwait:{workflow}:{ref}:{head.pk}" if ref else ""
        return whatsapp_service.send_notification(
            head,
            TYPE,
            params,
            dedupe_key=key,
            document_ref_id=ref,
            related_module=workflow,
            announce=False,  # the phone notification is Phone Notify Control's own (approval_waiting)
        )
    except Exception:
        logger.exception("Department Head WhatsApp for %s %s failed", workflow, getattr(obj, "pk", None))
        return None

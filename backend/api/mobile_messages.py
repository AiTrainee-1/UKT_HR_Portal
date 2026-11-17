"""Phone notifications: which of the messages the HRMS sends get pushed to employees' phones (HR portal -> Phone Notify
Control, 2026-11-17; before that the Mobile Messages tab of Mobile App Login).

Every WhatsApp message is also an in-app notification and a phone push (push_messages.py, signals.py), and the HRMS makes a few
notifications of its own that never go by WhatsApp (EXTRA_TYPES: approval progress, "waiting for your approval", On-Duty
sessions ending, request updates, HR notices, approval reminders, salary paid). This module is HR's control over the PUSH
half: a master switch, a switch per kind of message, and a mute per employee (PushOptOut), kept in MobileMessageSettings. The
in-app record is always saved (switching a message off here never loses it from the Notifications page); only the push to the
phone stops, and the row says so (`push_status = "off"`).

The WhatsApp kinds and their groups come from whatsapp_catalog.py, so a new WhatsApp message appears here with no change in
this file. The approval workflows each have a switch as well ("approval:leave"): a notification about a workflow (its
approval / rejection, its progress, "waiting for your approval") is pushed only while BOTH its kind and its workflow are on.
"""

from __future__ import annotations

from typing import NamedTuple

from . import push_messages
from . import whatsapp_catalog as catalog

MANUAL = "manual"  # a message HR typed on the Mobile Messages page
APPROVAL_PREFIX = "approval:"


# Phone notifications the HRMS sends that are NOT WhatsApp messages, so they are not in whatsapp_catalog.py. Each gets its own
# switch next to the WhatsApp kinds of its group. `audience`: who receives it (employee | approver).
class Extra(NamedTuple):
    label: str
    description: str
    group: str
    sent_from: str
    audience: str = "employee"


REMINDER_SOURCE = "approval_reminder"  # an employee reminding their Department Head (mobile_reminder_views.py)
EXTRA_TYPES: dict[str, Extra] = {
    REMINDER_SOURCE: Extra(
        "Approval reminder",
        "An employee's reminder (HOD Assignment -> My Requests) asking their Department Head to review a request that is "
        "still waiting. Sent at most once a day per request.",
        "approvals",
        "Employee app: My Requests -> Remind",
        "approver",
    ),
    "approval_waiting": Extra(
        "Waiting for your approval",
        "Tells a Department Head that a request (leave, permission, CL, missing punch, resignation, On-Duty and the "
        "others) has reached their step and waits for their decision.",
        "approvals",
        "When an employee submits a request, or one is passed on to the Department Head",
        "approver",
    ),
    "approval_progress": Extra(
        "Request passed to the next approver",
        "Tells the employee their request was approved at one step and now waits for the next approver (for example "
        "the Department Head approved it and it goes to HR). The final approval or rejection is its own message.",
        "approvals",
        "Approvals: a decision that passes the request on",
    ),
    "request_update": Extra(
        "Other request received / updated",
        "Confirms an 'other request' the employee raised (a general request to HR) and tells them when its status "
        "changes before the final decision.",
        "approvals",
        "Employee app: Requests -> Other request; HR Requests page",
    ),
    "on_duty_auto_end": Extra(
        "On-Duty session ended automatically",
        "Tells the employee their On-Duty session was closed by the system: after the 4th punch of the day was approved, "
        "or at the end of the day.",
        "geo",
        "Geo Attendance (automatic)",
    ),
    # payroll_month_workflow.SALARY_PAID_SOURCE (kept as text here: that module imports the models)
    "salary_paid": Extra(
        "Salary paid",
        "Sent to each staff employee when HR marks the month's payroll as Paid (Payroll > Payment Pending > Mark as Paid), "
        "and to an employee on hold or a new joiner released and paid on their own later. It names the month, never "
        "the amount.",
        "documents",
        "Staff Payroll -> Mark as Paid",
    ),
    "hr_notice": Extra(
        "Notice from HR",
        "A notice HR (or a connected system) wrote for one employee through the HRMS notifications API.",
        "other",
        "HRMS notifications API",
    ),
}

# Where each WhatsApp group's messages come from, for the "Sent from" line (a kind can say better in SENT_FROM).
SENT_FROM_GROUP = {
    "documents": "Documents pages (salary slips, ID cards, letters)",
    "attendance": "Automatic attendance alerts (checked every minute)",
    "approvals": "Approvals: when a request is approved or rejected",
    "geo": "Geo Attendance approvals",
    "visitors": "Reception (Outpass / Visitors)",
    "outpass": "Gate (Outpass)",
    "other": "Other HRMS pages",
}
SENT_FROM = {
    "hod_pending_reminder": "HR Requests -> Notify (scheduled reminders)",
    "attendance_report": "Attendance -> Attendance Notify",
}
APPROVER_KINDS = {"hod_pending_reminder"}
# A workflow named differently where the notification is made than on its switch.
WORKFLOW_ALIASES = {
    "compensation": "holiday_work",
    "holiday_work_claim": "holiday_work",
    "attendance": "attendance_correction",
    "attendance_edit": "attendance_correction",
    "employee_request": "request",
}


def workflow_module(key: str) -> str:
    """The approval workflow (catalog.APPROVAL_MODULES key) a notification about `key` belongs to, or "" when it has no
    workflow switch (On-Duty has its own Geo kinds)."""
    key = WORKFLOW_ALIASES.get(key or "", key or "")
    return key if key in catalog.APPROVAL_MODULES else ""


def extra_label(source: str) -> str | None:
    """The label of a non-WhatsApp kind (EXTRA_TYPES), or None."""
    extra = EXTRA_TYPES.get(source)
    return extra.label if extra else None


def approval_key(module: str) -> str:
    return f"{APPROVAL_PREFIX}{module}"


def controls() -> list[dict]:
    """Every switch, in the order the page lists them: [{key, label, description, group, groupLabel, kind, sentFrom,
    audience, origin}]. Never includes a one-time code: those are not notifications at all."""
    rows: list[dict] = []
    for module, label in catalog.MODULES.items():
        for key in catalog.types_in(module):
            if key in push_messages.EXCLUDED_TYPES:
                continue
            t = catalog.TYPES[key]
            rows.append(
                {
                    "key": key,
                    "label": t.label,
                    "description": t.description,
                    "group": module,
                    "groupLabel": label,
                    "kind": "message",
                    "sentFrom": SENT_FROM.get(key) or SENT_FROM_GROUP.get(module, ""),
                    "audience": "approver" if key in APPROVER_KINDS else "employee",
                    "origin": "whatsapp",
                }
            )
        for key, extra in EXTRA_TYPES.items():
            if extra.group == module:
                rows.append(
                    {
                        "key": key,
                        "label": extra.label,
                        "description": extra.description,
                        "group": module,
                        "groupLabel": label,
                        "kind": "message",
                        "sentFrom": extra.sent_from,
                        "audience": extra.audience,
                        "origin": "app",
                    }
                )
    for module, label in catalog.APPROVAL_MODULES.items():
        rows.append(
            {
                "key": approval_key(module),
                "label": label,
                "description": (
                    f"Every phone notification about {label.lower()} requests: approved, rejected, passed on to the next "
                    "approver, and waiting for a Department Head's approval."
                ),
                "group": "approval_workflows",
                "groupLabel": "Approvals by workflow",
                "kind": "workflow",
                "sentFrom": "Approvals",
                "audience": "employee",
                "origin": "app",
            }
        )
    return rows


def valid_keys() -> set[str]:
    return {row["key"] for row in controls()}


def push_allowed(source: str, related_module: str = "") -> bool:
    """May this notification be pushed to phones? The master switch first, then the message type, then (for the approval kind)
    its workflow. An older notification with no source (and a message HR typed) is only subject to the master switch."""
    return off_reason(source, related_module) is None


def off_reason(source: str, related_module: str = "", employee_id: int | None = None) -> str | None:
    """Why this notification must not be pushed (one plain sentence), or None when it may: the master switch, the kind,
    the workflow, and (when `employee_id` is given) the employee's mute."""
    from .models import MobileMessageSettings, PushOptOut

    s = MobileMessageSettings.get()
    if not s.push_enabled:
        return "Phone notifications are switched off (Phone Notify Control -> Controls)."
    if source and source != MANUAL:
        off = set(s.disabled_types or [])
        if source in off:
            return "This kind of notification is switched off for phones (Phone Notify Control -> Controls)."
        if related_module and approval_key(related_module) in off:
            return (
                "This approval workflow's notifications are switched off for phones (Phone Notify Control -> Controls)."
            )
    if employee_id and PushOptOut.objects.filter(employee_id=employee_id).exists():
        return "Phone notifications are muted for this employee (Phone Notify Control -> Employees)."
    return None

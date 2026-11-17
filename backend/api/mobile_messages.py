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

import logging
from typing import NamedTuple

from . import push_messages
from . import whatsapp_catalog as catalog

logger = logging.getLogger(__name__)

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
    # Internal chat (chat_push.py, 2026-11-17): every public message reaches the phones of the people who can read it.
    "chat_announcement": Extra(
        "Company chat: message from HR / management",
        "A message HR, the MD or a Director posts in a company chat channel. Every active employee who reads that channel "
        "(the branch's employees; with 'Send to all branches', every branch) gets it on their phone.",
        "chat",
        "HR Portal: Chat",
    ),
    "chat_message": Extra(
        "Company chat: message from an employee",
        "A message an employee posts in their branch's company chat. Everyone else in that branch gets it on their phone.",
        "chat",
        "Employee app / Employee Web App: Chat",
    ),
    "chat_department": Extra(
        "Department chat message",
        "A message posted in a department's chat channel. The other employees of that department get it on their phone.",
        "chat",
        "Employee app / Employee Web App: Chat (department channel)",
    ),
    "chat_reply": Extra(
        "Reply to your chat message",
        "Somebody replied to one of your chat messages. Replaces the plain message for the person replied to (switch it off "
        "and they get the plain message like everyone else).",
        "chat",
        "Chat: Reply",
    ),
    "chat_report": Extra(
        "Attendance report posted in chat",
        "An Attendance Notify report posted in a company chat channel. Every employee who reads that channel gets its "
        "headline and counts on their phone.",
        "chat",
        "Attendance -> Attendance Notify (Internal Chat)",
    ),
}
EXTRA_TYPES.update(
    {
        # compensation_notices.py (2026-11-17)
        "ot_compensation": Extra(
            "Overtime decided",
            "Tells a staff member how HR decided their detected overtime (Compensation -> OT): paid, given as time off "
            "(on a date or into the compensation balance), or not compensated.",
            "compensation",
            "Compensation -> OT: Assign / Announce / Reject",
        ),
        "compensation_announcement": Extra(
            "Compensation Day / late-in / early-out announced",
            "Tells every staff member an announcement covers that a date is a Compensation Day, or that they may arrive "
            "late / leave early that day without a mark.",
            "compensation",
            "Compensation -> Compensation Days / Windows",
        ),
    }
)
# Groups of their own for kinds that are not WhatsApp messages at all (listed after the WhatsApp groups).
EXTRA_GROUPS = {"compensation": "Compensation & overtime", "chat": "Internal chat"}

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


# ── the dashboard's categories (Phone Notify Control -> Overview, 2026-11-17) ──────────────────────────────────────
# Every switch belongs to exactly one category, and every notification is counted in exactly one (category_of_notification).
class Category(NamedTuple):
    label: str
    description: str


CATEGORIES: dict[str, Category] = {
    "leave": Category("Leave", "Leave and casual leave requests: approved, rejected, passed on to the next approver."),
    "permission": Category("Permission", "Permission requests: approved, rejected, passed on to the next approver."),
    "attendance": Category(
        "Attendance alerts",
        "Absent, late, punch reminders and missing punches (checked every minute), missing-punch and attendance "
        "correction requests, attendance reports.",
    ),
    "on_duty": Category("On-Duty & Geo", "Geo attendance and Geo punch decisions, On-Duty sessions ending."),
    "compensation": Category(
        "Compensation & overtime",
        "Overtime decided (paid, time off, not compensated), Compensation Days and late-in / early-out windows, "
        "holiday-work compensation requests.",
    ),
    "payroll": Category("Payroll & salary", "Salary slips, salary paid, salary advance requests."),
    "chat": Category(
        "Internal chat",
        "Company and department chat messages, replies, and the attendance reports posted in chat.",
    ),
    "employee": Category(
        "Employee updates",
        "ID cards, letters and documents, notices and messages from HR, resignations and other requests.",
    ),
    "gate": Category("Gate & visitors", "Outpass gate out / in, outpass requests, visitor notices."),
    "decisions": Category(
        "Request decisions (all workflows)",
        "The approved, rejected and passed-on messages of every request. Each workflow's own switch (Leave, "
        "Permission ...) can still stop its messages.",
    ),
    "approvers": Category(
        "Approvers & management",
        "What Department Heads receive, including the MD or a Director who heads a department: requests waiting for "
        "their approval, employees' reminders, HR's scheduled pending-approval reminders. HR Portal accounts have no "
        "phone app; they see these in the portal.",
    ),
}
# the approval workflows' switches and notifications
WORKFLOW_CATEGORY = {
    "leave": "leave",
    "casual_leave": "leave",
    "permission": "permission",
    "missing_punch": "attendance",
    "attendance_correction": "attendance",
    "holiday_work": "compensation",
    "advance": "payroll",
    "resignation": "employee",
    "request": "employee",
    "outpass": "gate",
}
SOURCE_CATEGORY = {
    "salary_slip": "payroll",
    "salary_paid": "payroll",
    "attendance_report": "attendance",
    "approval_waiting": "approvers",
    "approval_reminder": "approvers",
    "hod_pending_reminder": "approvers",
    "approval_approved": "decisions",
    "approval_rejected": "decisions",
    "approval_progress": "decisions",
    "request_update": "employee",
    "hr_notice": "employee",
    MANUAL: "employee",
}
GROUP_CATEGORY = {  # the WhatsApp group (or EXTRA_GROUPS key) of a kind not named above
    "documents": "employee",
    "attendance": "attendance",
    "approvals": "decisions",
    "geo": "on_duty",
    "visitors": "gate",
    "outpass": "gate",
    "other": "employee",
    "compensation": "compensation",
    "chat": "chat",
}
APPROVER_SOURCES = frozenset({"approval_waiting", "approval_reminder", "hod_pending_reminder"})


def category_of_key(key: str) -> str:
    """The category of one switch (a kind, or "approval:<workflow>")."""
    if key.startswith(APPROVAL_PREFIX):
        return WORKFLOW_CATEGORY.get(key[len(APPROVAL_PREFIX) :], "decisions")
    if key in SOURCE_CATEGORY:
        return SOURCE_CATEGORY[key]
    extra = EXTRA_TYPES.get(key)
    if extra:
        return GROUP_CATEGORY.get(extra.group, "employee")
    t = catalog.get(key)
    return GROUP_CATEGORY.get(t.module, "employee") if t else "employee"


def category_of_notification(source: str, related_module: str = "") -> str:
    """The one category a notification is counted in: an approver's notice is the approvers', anything about a workflow is
    that workflow's (a leave approval is Leave), the rest by its kind."""
    if source in APPROVER_SOURCES:
        return "approvers"
    module = workflow_module(related_module)
    if module:
        return WORKFLOW_CATEGORY.get(module, "decisions")
    return category_of_key(source or MANUAL)


def controls() -> list[dict]:
    """Every switch, in the order the page lists them: [{key, label, description, group, groupLabel, kind, sentFrom,
    audience, origin}]. Never includes a one-time code: those are not notifications at all."""
    rows: list[dict] = []
    for module, label in {**catalog.MODULES, **EXTRA_GROUPS}.items():
        for key in catalog.types_in(module) if module in catalog.MODULES else ():
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


def categorized_controls() -> list[dict]:
    """controls() with each row's category ({..., category, categoryLabel})."""
    rows = []
    for row in controls():
        key = category_of_key(row["key"])
        rows.append({**row, "category": key, "categoryLabel": CATEGORIES[key].label})
    return rows


def push_allowed(source: str, related_module: str = "") -> bool:
    """May this notification be pushed to phones? The master switch first, then the message type, then (for the approval kind)
    its workflow. An older notification with no source (and a message HR typed) is only subject to the master switch."""
    return off_reason(source, related_module) is None


MASTER_OFF = "Phone notifications are switched off (Phone Notify Control -> Controls)."
KIND_OFF = "This kind of notification is switched off for phones (Phone Notify Control -> Controls)."
WORKFLOW_OFF = "This approval workflow's notifications are switched off for phones (Phone Notify Control -> Controls)."
MUTED = "Phone notifications are muted for this employee (Phone Notify Control -> Employees)."


def switches() -> tuple[bool, set[str]]:
    """(master switch on?, the keys switched off). Read in its own savepoint and never raises: when the settings cannot be
    read the push goes as usual, so a broken read can never stop a notification (or the transaction around it)."""
    from django.db import transaction

    from .models import MobileMessageSettings

    try:
        with transaction.atomic():
            s = MobileMessageSettings.get()
            return bool(s.push_enabled), set(s.disabled_types or [])
    except Exception:
        logger.warning("Could not read the phone notification switches; pushing as usual", exc_info=True)
        return True, set()


def muted_employee_ids(employee_ids) -> set[int]:
    """Which of these employees HR muted (PushOptOut). Same safety as switches(): a missing table (migration 0156 not applied
    yet) or any other read error means nobody is muted, never a lost notification."""
    from django.db import transaction

    from .models import PushOptOut

    ids = [i for i in employee_ids if i]
    if not ids:
        return set()
    try:
        with transaction.atomic():
            return set(PushOptOut.objects.filter(employee_id__in=ids).values_list("employee_id", flat=True))
    except Exception:
        logger.warning(
            "Could not read the muted employees (is migration 0156 applied?); pushing as usual", exc_info=True
        )
        return set()


def _block(master: bool, off: set[str], source: str, related_module: str, muted: bool) -> str | None:
    if not master:
        return MASTER_OFF
    if source and source != MANUAL:
        if source in off:
            return KIND_OFF
        module = workflow_module(related_module) or related_module
        if module and approval_key(module) in off:
            return WORKFLOW_OFF
    if muted:
        return MUTED
    return None


def kind_enabled(source: str) -> bool:
    """Is this kind pushed to phones at all (master switch and its own switch)? For senders that decide before making
    anything, such as the chat and the attendance alerts when WhatsApp is not sending."""
    master, off = switches()
    return master and source not in off


def off_reason(source: str, related_module: str = "", employee_id: int | None = None) -> str | None:
    """Why this notification must not be pushed (one plain sentence), or None when it may: the master switch, the kind,
    the workflow, and (when `employee_id` is given) the employee's mute."""
    master, off = switches()
    muted = bool(employee_id) and employee_id in muted_employee_ids([employee_id])
    return _block(master, off, source, related_module, muted)


def push_blocks(rows) -> dict[int, str]:
    """{notification id: why it must not be pushed} for a batch of notifications, in two reads whatever its size. The rows
    missing from the answer may be pushed."""
    rows = list(rows)
    if not rows:
        return {}
    master, off = switches()
    muted = muted_employee_ids({n.employee_id for n in rows})
    out = {}
    for n in rows:
        reason = _block(master, off, n.source, n.related_module, n.employee_id in muted)
        if reason:
            out[n.pk] = reason
    return out

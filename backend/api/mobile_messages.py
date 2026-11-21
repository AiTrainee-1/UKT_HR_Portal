"""Phone notifications: every kind of phone (push) notification the HRMS sends, and HR's switches over them (HR portal ->
Phone Notify Control, 2026-11-17).

Phone Notify Control is its own module, independent of WhatsApp Control (owner 2026-11-17): its own list of kinds (EVENT_TYPES
and EXTRA_TYPES below, in its own words), its own switches (a master switch, one per kind, one per approval workflow, a mute per
employee), its own recipients (push_recipients.py), its own wording (push_templates.py) and its own attendance alert job
(phone_alerts.py). Nothing set on WhatsApp Control changes a phone notification, and nothing set here changes a WhatsApp
message. Where the same HRMS event (a request approved, a gate exit) is told on both channels, each channel decides with its
own settings.

A switched-off kind keeps its in-app record (the Notifications page) and only the push stops; the row says so
(`push_status = "off"`). A notification about an approval workflow (approved / rejected, passed on, "waiting for your
approval") is pushed only while BOTH its kind and its workflow are on.
"""

from __future__ import annotations

import logging
from typing import NamedTuple

from . import whatsapp_catalog as catalog

logger = logging.getLogger(__name__)

MANUAL = "manual"  # a message HR typed on the Mobile Messages page
APPROVAL_PREFIX = "approval:"


# One kind of phone notification. `group`: where Phone Notify Control lists it (GROUPS); `audience`: who receives it
# (employee | approver | employee_hod: the employee first, then their Department Head when it is not fixed).
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
# On-Duty tracking alerts (geo_tracking/alerts.py, 2026-11-21): the geo-tracking watchdog finds a problem on a recording
# On-Duty track and tells the employee at once (after Geo Attendance -> Settings' short wait); when it is still not fixed
# after the grace period, their Department Head gets the same kind of notification about them. The timing is Geo
# Attendance's; whether the phone carries it is this switch alone.
_TRACKING = "Geo Attendance: automatic tracking alerts (checked every 2 minutes, timing on Geo Attendance -> Settings)"
TRACKING_ALERT_TYPES: dict[str, Extra] = {
    "geo_location_off": Extra(
        "Location turned off alert",
        "The phone's location was turned off during On-Duty, so the route is not recorded: asks the employee to turn it "
        "back on. Their Department Head is told if it stays off past the grace period.",
        "tracking",
        _TRACKING,
        "employee_hod",
    ),
    "geo_permission_restricted": Extra(
        "Background location permission restricted alert",
        "The app's location permission is not 'Allow all the time' (only while using the app, or denied), so the route "
        "cannot be recorded in the background: tells the employee how to fix it. Their Department Head is told if it is "
        "not fixed in time.",
        "tracking",
        _TRACKING,
        "employee_hod",
    ),
    "geo_background_restricted": Extra(
        "Background app restriction alert",
        "The phone restricts the app in the background (background use restricted, or battery optimisation on), so the "
        "route may stop recording: tells the employee how to allow it. Their Department Head is told if it is not fixed "
        "in time.",
        "tracking",
        _TRACKING,
        "employee_hod",
    ),
    "geo_missing_punch": Extra(
        "Missing Geo-Punch alert",
        "No Geo-Punch since the On-Duty started (after the set wait), or fewer than the day's 4 punches at the end of the "
        "duty day: asks the employee to record it. Their Department Head is told if it is still missing after the grace "
        "period.",
        "tracking",
        _TRACKING,
        "employee_hod",
    ),
    "geo_punch_reminder": Extra(
        "Geo-Punch reminder",
        "A friendly reminder when no Geo-Punch was made for the set time while on duty and a punch of the day is still "
        "free. One reminder per wait, to the employee only.",
        "tracking",
        _TRACKING,
    ),
    "geo_tracking_failure": Extra(
        "On-Duty tracking failure alert",
        "The phone sent no location for the signal-lost time (the app was closed, the phone is off or offline): asks the "
        "employee to open the app. Their Department Head is told if nothing arrives within the grace period.",
        "tracking",
        _TRACKING,
        "employee_hod",
    ),
}
EXTRA_TYPES.update(TRACKING_ALERT_TYPES)
# The HRMS events that are told to the phone (and, separately, may also be told on WhatsApp by WhatsApp Control): one kind
# each, described here for the phone. Their keys are the events' keys, which is all the two modules share.
_DOC = "Documents pages: when HR sends the document to the employee"
_ALERTS = "Automatic attendance alerts (checked every minute, Phone Notify Control -> Settings for the timing)"
EVENT_TYPES: dict[str, Extra] = {
    "salary_slip": Extra(
        "Salary slip", "Tells the employee their salary slip for a month was sent to them.", "documents", _DOC
    ),
    "id_card": Extra("ID card", "Tells the employee their ID card was sent to them.", "documents", _DOC),
    "offer_letter": Extra("Offer letter", "Tells the employee their offer letter was sent to them.", "documents", _DOC),
    "experience_letter": Extra(
        "Experience letter", "Tells the employee their experience letter was sent to them.", "documents", _DOC
    ),
    "resignation_letter": Extra(
        "Resignation letter",
        "Tells the employee their resignation letter was sent to them, with the last working day.",
        "documents",
        _DOC,
    ),
    "other": Extra("Other document", "Tells the employee another document was sent to them.", "documents", _DOC),
    "absent_alert": Extra(
        "Absent alert",
        "No punch yet after the shift started and the allowed time has passed: asks the employee to punch in, or to tell HR "
        "they are absent.",
        "attendance",
        _ALERTS,
    ),
    "late_alert": Extra(
        "Late alert",
        "The first punch of the day came after the shift's allowed time: says by how much.",
        "attendance",
        _ALERTS,
    ),
    "four_punch_alert": Extra(
        "Punch reminder",
        "A short reminder before each of the day's punches (check-in, lunch-out, lunch-in, check-out) that is still missing.",
        "attendance",
        _ALERTS,
    ),
    "on_duty_punch_reminder": Extra(
        "On-Duty punch reminder",
        "The same reminder for an employee working On-Duty: their Geo Punch is due.",
        "attendance",
        _ALERTS,
    ),
    "missing_punch_alert": Extra(
        "Missing punch alert",
        "A punch is still missing some time after it was due: asks the employee to punch now.",
        "attendance",
        _ALERTS,
    ),
    "approval_approved": Extra(
        "Request approved",
        "The employee's request (leave, permission, CL, missing punch, outpass and the others) was finally approved.",
        "approvals",
        "Approvals: the final approval",
    ),
    "approval_rejected": Extra(
        "Request rejected",
        "The employee's request was rejected, with the reason given.",
        "approvals",
        "Approvals: a rejection",
    ),
    "hod_pending_reminder": Extra(
        "Pending approvals reminder",
        "HR's scheduled reminder to a Department Head of the requests waiting for them.",
        "approvals",
        "HR Requests -> Notify (scheduled reminders)",
        "approver",
    ),
    "geo_approval": Extra(
        "On-Duty request approved",
        "The employee's On-Duty (Geo Attendance) request was approved: they can punch from the app.",
        "geo",
        "Geo Attendance approvals",
    ),
    "geo_rejection": Extra(
        "On-Duty request rejected", "The employee's On-Duty request was rejected.", "geo", "Geo Attendance approvals"
    ),
    "geo_punch_approval": Extra(
        "Geo punch approved", "One of the employee's Geo punches was approved.", "geo", "Geo Attendance approvals"
    ),
    "geo_punch_rejection": Extra(
        "Geo punch rejected",
        "One of the employee's Geo punches was rejected and does not count; they can punch again.",
        "geo",
        "Geo Attendance approvals",
    ),
    "visitor_notification": Extra(
        "Visitor at reception",
        "A visitor is waiting at reception to meet the employee.",
        "visitors",
        "Reception (Visitors)",
    ),
    "outpass_gate_out": Extra(
        "Gate exit", "The employee's gate exit on an outpass was recorded.", "outpass", "Gate (Outpass)"
    ),
    "outpass_gate_in": Extra(
        "Gate return", "The employee's return through the gate was recorded.", "outpass", "Gate (Outpass)"
    ),
}
# Phone Notify Control's own groups, in the order its pages list them.
GROUPS = {
    "documents": "Documents",
    "attendance": "Attendance alerts",
    "approvals": "Approvals",
    "geo": "On-Duty & Geo",
    "tracking": "On-Duty tracking alerts",
    "visitors": "Visitors",
    "outpass": "Gate outpass",
    "compensation": "Compensation & overtime",
    "chat": "Internal chat",
    "other": "Other",
}


def kind_label(source: str) -> str | None:
    """The phone label of a kind, or None."""
    k = EVENT_TYPES.get(source) or EXTRA_TYPES.get(source)
    return k.label if k else None


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
    """The label of a kind (kept for older callers): kind_label."""
    return kind_label(source)


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
    "on_duty": Category(
        "On-Duty & Geo",
        "Geo attendance and Geo punch decisions, On-Duty sessions ending, and the automatic On-Duty tracking alerts "
        "(location off, permission or background restrictions, missing Geo-Punches, reminders, tracking failures).",
    ),
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
GROUP_CATEGORY = {  # the group of a kind not named above
    "documents": "employee",
    "attendance": "attendance",
    "approvals": "decisions",
    "geo": "on_duty",
    "tracking": "on_duty",
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
    kind = EVENT_TYPES.get(key) or EXTRA_TYPES.get(key)
    return GROUP_CATEGORY.get(kind.group, "employee") if kind else "employee"


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
    audience}]. Never includes a one-time code: those are not notifications at all."""
    rows: list[dict] = []
    for group, label in GROUPS.items():
        for key, k in [*EVENT_TYPES.items(), *EXTRA_TYPES.items()]:
            if k.group != group:
                continue
            rows.append(
                {
                    "key": key,
                    "label": k.label,
                    "description": k.description,
                    "group": group,
                    "groupLabel": label,
                    "kind": "message",
                    "sentFrom": k.sent_from,
                    "audience": k.audience,
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
    from . import push_recipients

    master, off = switches()
    muted = bool(employee_id) and employee_id in muted_employee_ids([employee_id])
    reason = _block(master, off, source, related_module, muted)
    if (
        not reason
        and employee_id
        and (source or "") not in push_recipients.EXEMPT_SOURCES
        and not push_recipients.allows(employee_id)
    ):
        reason = push_recipients.NOT_RECIPIENT
    return reason


def push_blocks(rows) -> dict[int, str]:
    """{notification id: why it must not be pushed} for a batch of notifications, in two reads whatever its size. The rows
    missing from the answer may be pushed."""
    rows = list(rows)
    if not rows:
        return {}
    from . import push_recipients

    master, off = switches()
    muted = muted_employee_ids({n.employee_id for n in rows})
    outside = push_recipients.blocked(rows) if master else set()
    out = {}
    for n in rows:
        reason = _block(master, off, n.source, n.related_module, n.employee_id in muted)
        if not reason and n.pk in outside:
            reason = push_recipients.NOT_RECIPIENT
        if reason:
            out[n.pk] = reason
    return out

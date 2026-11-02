"""Where a notification's View button leads: the `target` of every row of GET /api/notifications.

    target_for(notification, context) -> {kind, id, date, role, category, label} | None

The shape is a contract shared with the mobile app and the Employee Web App (2026-11-02), which route on it:

    kind      the page: "leave", "salary_slip", "attendance", "approvals" ... (KINDS)
    id        the exact row on that page (leave request id, salary slip id, On-Duty session id ...) when the notification
              names it; never a guess
    date      "YYYY-MM-DD" for something about one day (a late / absent / missing punch alert, an attendance change)
    role      "self" (the reader's own thing) or "approver" (a Department Head asked to act -> kind "approvals")
    category  the Approvals category for an approver; for kind "my_requests" the same key says which kind of request it is
    label     the button's words: "View leave request", "Open approvals", "View attendance for 31 Oct" ...

None means there is nothing to open: a message HR typed (Mobile Messages -> Send), a visitor at reception, a plain "general"
notice.

A Notification has no column naming what it is about, so the target is read off what every row already carries, the most
exact evidence first. That also covers every notification made before this module existed.

    1. dedupe_key  the event itself: "wa:approval:leave:42:approved" (whatsapp_approvals.notify_decision) -> leave 42,
                   "wa:late:2026-10-31:7" (whatsapp_alerts) -> attendance on 31 Oct, "wa:gate:out:9" -> gate pass 9,
                   "reminder:5" (mobile_reminder_views) -> the ApprovalReminder, which names the module and request id
    2. source      the WhatsApp catalogue key of a message made by push_messages.announce ("salary_slip", "late_alert" ...)
    3. type + text the in-app notices made directly (approval_workflow.stage_notice / notify_hod_of_request, the
                   Department Head notices of missing punch / On-Duty / resignation, the On-Duty auto-close notices) and
                   the older one-liners. "... is waiting for your approval." is a Department Head being asked to act.

A date is read from the dedupe key when it has one, else from text the HRMS itself formats: an ISO date in an in-app notice
("Missing Punch request for 2026-08-28"), the "📅 Date: 25 Sep 2026" line of a WhatsApp wording (only when it is one day, not a
range), the "Sunday 12 Oct 2026" of a compensation notice. Text that holds two different dates gives no date.

Two lookups need the database: the ApprovalReminder behind "reminder:<id>" and the salary slip of the month a slip message
names. `build_context(rows)` does each once for a whole page of notifications; `target_for(n)` without a context does them
for that one row. Nothing here raises: a row it cannot read gets None.
"""

from __future__ import annotations

import logging
import re
from collections import defaultdict
from dataclasses import dataclass
from datetime import date

from . import whatsapp_catalog as catalog
from .mobile_messages import MANUAL, REMINDER_SOURCE

logger = logging.getLogger(__name__)

KINDS = frozenset(
    {
        "leave",
        "casual_leave",
        "permission",
        "missing_punch",
        "outpass",
        "on_duty",
        "geo_punch",
        "attendance",
        "salary_slip",
        "documents",
        "id_card",
        "compensation",
        "advance",
        "resignation",
        "chat",
        "approvals",
        "my_requests",
        "request",
        "shift",
        "holidays",
        "profile",
    }
)


@dataclass(frozen=True)
class Page:
    kind: str
    label: str
    # A page about one day: a date found in the notification is passed on (the attendance label names it).
    dated: bool = False
    # For kind "my_requests": which kind of request it is, in the Approvals category words.
    category: str | None = None


# ── the table: every page a notification can open ─────────────────────────────

PAGES: dict[str, Page] = {
    "leave": Page("leave", "View leave request", dated=True),
    "casual_leave": Page("casual_leave", "View casual leave", dated=True),
    "permission": Page("permission", "View permission request", dated=True),
    "missing_punch": Page("missing_punch", "View missing punch request", dated=True),
    "outpass": Page("outpass", "View outpass request"),
    "gate_pass": Page("outpass", "View gate pass"),
    "on_duty": Page("on_duty", "View On-Duty"),
    "geo_punch": Page("geo_punch", "View Geo Punch", dated=True),
    "attendance": Page("attendance", "View attendance", dated=True),
    # An attendance change HR proposed for the employee: listed in their My Requests, not on a page of its own.
    "attendance_change": Page("my_requests", "View attendance change", dated=True, category="attendance"),
    "my_requests": Page("my_requests", "View my requests"),
    "salary_slip": Page("salary_slip", "View salary slip"),
    "documents": Page("documents", "View documents"),
    "id_card": Page("id_card", "View ID card"),
    "compensation": Page("compensation", "View compensation", dated=True),
    "advance": Page("advance", "View advance"),
    "resignation": Page("resignation", "View resignation"),
    "request": Page("request", "View request"),
    "chat": Page("chat", "Open chat"),
    "shift": Page("shift", "View shift"),
    "holidays": Page("holidays", "View holidays"),
    "profile": Page("profile", "View profile"),
}
APPROVALS_LABEL = "Open approvals"

# An approval workflow (approval_workflow.DEFINITIONS / whatsapp_catalog.APPROVAL_MODULES key) -> the employee's own page.
WORKFLOW_PAGE: dict[str, str] = {
    "leave": "leave",
    "permission": "permission",
    "casual_leave": "casual_leave",
    "missing_punch": "missing_punch",
    "outpass": "outpass",
    "on_duty": "on_duty",
    "on_duty_punch": "geo_punch",
    "attendance_correction": "attendance_change",
    "holiday_work": "compensation",
    "resignation": "resignation",
    "advance": "advance",
    "request": "request",
}

# The same workflow (or the in-app notice type of one) -> the Approvals category a Department Head decides it under.
# Advances and general requests have no Department Head step, so no category.
APPROVAL_CATEGORY: dict[str, str] = {
    "leave": "leave",
    "permission": "permission",
    "casual_leave": "casual_leave",
    "missing_punch": "missing_punch",
    "outpass": "outpass",
    "on_duty": "on_duty",
    "attendance_correction": "attendance",
    "attendance": "attendance",
    "holiday_work": "holiday_work",
    "resignation": "resignation",
}

# A WhatsApp catalogue key (Notification.source) -> page. None: nothing in the employee apps to open. The two approval
# wordings follow their workflow (related_module) instead; a key added to the catalogue later falls back on its module.
SOURCE_PAGE: dict[str, str | None] = {
    "salary_slip": "salary_slip",
    "id_card": "id_card",
    "offer_letter": "documents",
    "experience_letter": "documents",
    "resignation_letter": "documents",
    "other": "documents",
    "absent_alert": "attendance",
    "late_alert": "attendance",
    "four_punch_alert": "attendance",
    "missing_punch_alert": "attendance",
    "on_duty_punch_reminder": "geo_punch",
    "geo_approval": "on_duty",
    "geo_rejection": "on_duty",
    "geo_punch_approval": "geo_punch",
    "geo_punch_rejection": "geo_punch",
    "outpass_gate_out": "gate_pass",
    "outpass_gate_in": "gate_pass",
    "visitor_notification": None,
    "visitor_contact": None,
}
APPROVAL_SOURCES = frozenset({"approval_approved", "approval_rejected"})
MODULE_PAGE: dict[str, str] = {
    "documents": "documents",
    "attendance": "attendance",
    "geo": "on_duty",
    "outpass": "gate_pass",
}

# Notification.type of a row with no catalogue source (the in-app notices and the older one-liners) -> page.
TYPE_PAGE: dict[str, str] = {
    "leave": "leave",
    "permission": "permission",
    "casual_leave": "casual_leave",
    "missing_punch": "missing_punch",
    "outpass": "outpass",
    "on_duty": "on_duty",
    "attendance": "attendance",
    "compensation": "compensation",
    "resignation": "resignation",
    "advance": "advance",
    "employee_request": "request",
    "request": "request",
    "approval": "my_requests",
    "salary_slip": "salary_slip",
    "id_card": "id_card",
    "offer_letter": "documents",
    "experience_letter": "documents",
    "resignation_letter": "documents",
    "documents": "documents",
    "chat": "chat",
    "shift": "shift",
    "holiday": "holidays",
    "holidays": "holidays",
    "profile": "profile",
}

# Types only ever sent to a Department Head, asking them to decide (approval_workflow.notify_hod_of_request for the two
# HR-raised kinds, and the reminder).
APPROVER_TYPES = frozenset({"holiday_work", "attendance_correction", REMINDER_SOURCE})

# The wording of the in-app notices that ask a Department Head to act (approval_workflow.notify_hod_of_request, the
# reminder, recruitment_views._notify_dept_heads, missing_punch_views / geo_attendance_views._notify_hod_approvers).
_ASKS_TO_ACT = re.compile(
    r"waiting for your approval|needs your approval|provide your approval|please review it"
    r"|\bsubmitted an? (?:missing punch|on-duty)\b",
    re.IGNORECASE,
)
_ATTENDANCE_CHANGE = re.compile(r"\battendance (?:change|correction)\b", re.IGNORECASE)

_MONTHS = ("Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec")
_MONTH_NAMES = (
    "January",
    "February",
    "March",
    "April",
    "May",
    "June",
    "July",
    "August",
    "September",
    "October",
    "November",
    "December",
)
_ISO = re.compile(r"\b(\d{4})-(\d{2})-(\d{2})\b")
# "📅 Date: 25 Sep 2026" on a line of its own (whatsapp_format.date_str); "26 Sep 2026 to 27 Sep 2026" does not match.
_DATE_LINE = re.compile(r"^\W*Date:\s*(\d{1,2}) ([A-Z][a-z]{2}) (\d{4})\s*$", re.MULTILINE)
# "Sunday 12 Oct 2026" (compensation_shared.date_text)
_WEEKDAY_DATE = re.compile(
    r"\b(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday) (\d{1,2}) ([A-Z][a-z]{2}) (\d{4})\b"
)
# "Your salary slip for August 2026 is attached."
_MONTH_YEAR = re.compile(r"\b(" + "|".join(_MONTH_NAMES) + r") (\d{4})\b")


# ── dates ──────────────────────────────────────────────────────────────────────


def _day(year: str, month: int, day: str) -> date | None:
    try:
        return date(int(year), month, int(day))
    except ValueError:
        return None


def _one(days) -> date | None:
    """The date when the text names exactly one day; None for none or for two different days."""
    found = {d for d in days if d is not None}
    return found.pop() if len(found) == 1 else None


def _iso_date(text: str) -> date | None:
    return _one(_day(y, int(m), d) for y, m, d in _ISO.findall(text or ""))


def _month(abbr: str) -> int:
    return _MONTHS.index(abbr) + 1 if abbr in _MONTHS else 0


def _notice_date(text: str) -> date | None:
    """The day an in-app notice is about: an ISO date, else a compensation notice's "Sunday 12 Oct 2026"."""
    return _iso_date(text) or _one(_day(y, _month(m), d) for d, m, y in _WEEKDAY_DATE.findall(text or ""))


def _wording_date(text: str) -> date | None:
    """The day of a WhatsApp wording: its "Date:" line."""
    return _one(_day(y, _month(m), d) for d, m, y in _DATE_LINE.findall(text or ""))


def _key_date(parts: list[str]) -> date | None:
    for part in parts:
        m = _ISO.fullmatch(part)
        if m:
            return _day(m.group(1), int(m.group(2)), m.group(3))
    return None


def _month_year(n) -> tuple[int, int] | None:
    found = {(_MONTH_NAMES.index(name) + 1, int(year)) for name, year in _MONTH_YEAR.findall(n.message or "")}
    return found.pop() if len(found) == 1 else None


def _is_salary_slip(n) -> bool:
    return n.source == "salary_slip" or (not n.source and (n.type or "").strip().lower() == "salary_slip")


# ── building a target ──────────────────────────────────────────────────────────


def _self(page_key: str | None, *, id: int | None = None, day: date | None = None) -> dict | None:
    page = PAGES.get(page_key or "")
    if page is None:
        return None
    day = day if page.dated else None
    label = page.label
    if page.kind == "attendance" and day:
        label = f"View attendance for {day.day} {_MONTHS[day.month - 1]}"
    return {
        "kind": page.kind,
        "id": id,
        "date": day.isoformat() if day else None,
        "role": "self",
        "category": page.category,
        "label": label,
    }


def _approver(category: str | None, *, id: int | None = None, day: date | None = None) -> dict:
    return {
        "kind": "approvals",
        # an id means nothing without the category it belongs to
        "id": id if category else None,
        "date": day.isoformat() if day else None,
        "role": "approver",
        "category": category,
        "label": APPROVALS_LABEL,
    }


def _int(value: str) -> int | None:
    return int(value) if value.isascii() and value.isdigit() else None


_NO_MATCH = object()


def _from_whatsapp_key(n, inner: str):
    """The target named by the dedupe key of a WhatsApp message (push_messages.announce stores it as "wa:<key>"), or
    _NO_MATCH when the key says nothing this module knows."""
    parts = inner.split(":")
    head = parts[0]
    text = n.message or ""
    if head == "approval" and len(parts) >= 3:  # approval:<module>:<pk>:<decision>
        page = WORKFLOW_PAGE.get(parts[1])
        if page:
            return _self(page, id=_int(parts[2]), day=_wording_date(text))
    elif head == "geo" and len(parts) >= 2:  # geo:<session>[:rejected]
        return _self("on_duty", id=_int(parts[1]))
    elif head == "geopunch" and len(parts) >= 2:  # geopunch:<verification>[:rejected]
        return _self("geo_punch", id=_int(parts[1]), day=_wording_date(text))
    elif head == "geopunches" and len(parts) >= 2:  # geopunches:<session>:<decision>:<time bucket>: all of one session
        return _self("on_duty", id=_int(parts[1]))
    elif head == "gate" and len(parts) >= 3:
        if parts[1] in ("out", "in"):  # gate:out:<outpass request>
            return _self("gate_pass", id=_int(parts[2]))
        if parts[1] == "record":  # gate:record:<gate QR form record>: not an outpass request, so no id
            return _self("gate_pass")
    else:
        # The attendance alerts: <tag>:<YYYY-MM-DD>:<employee id> (whatsapp_alerts.run_alerts).
        day = _key_date(parts[1:])
        if day:
            if n.source in SOURCE_PAGE:
                page = SOURCE_PAGE[n.source]
            else:
                page = "geo_punch" if head.startswith("duty") else "attendance"
            return _self(page, day=day)
    return _NO_MATCH


def _from_source(n, source: str, context: dict) -> dict | None:
    """A WhatsApp message with no usable dedupe key (documents carry none)."""
    text = n.message or ""
    if source in APPROVAL_SOURCES:
        page = WORKFLOW_PAGE.get(n.related_module or "") or TYPE_PAGE.get(n.type or "") or "my_requests"
        return _self(page, day=_wording_date(text))
    if source in SOURCE_PAGE:
        page = SOURCE_PAGE[source]
    else:
        page = MODULE_PAGE.get(catalog.module_of(source))
    if page == "salary_slip":
        return _self(page, id=_salary_slip_id(n, context))
    return _self(page, day=_wording_date(text))


def _from_type(n, context: dict) -> dict | None:
    """An in-app notice made directly, or an older one-liner: its type, and its wording for who it asks to act."""
    ntype = (n.type or "").strip().lower()
    text = n.message or ""
    if ntype in APPROVER_TYPES or _ASKS_TO_ACT.search(text):
        return _approver(APPROVAL_CATEGORY.get(ntype), day=_notice_date(text))
    if ntype == "attendance" and _ATTENDANCE_CHANGE.search(text):
        page = "attendance_change"
    else:
        page = TYPE_PAGE.get(ntype)
    if page == "salary_slip":
        return _self(page, id=_salary_slip_id(n, context))
    return _self(page, day=_notice_date(text))


def _reminder(n, context: dict) -> dict:
    """An employee reminding their Department Head (mobile_reminder_views.remind_approver): Approvals, at that request."""
    key = n.dedupe_key or ""
    reminder_id = _int(key.split(":", 1)[1]) if key.startswith("reminder:") else None
    found = context.get("reminders", {}).get(reminder_id)
    day = _iso_date(n.message or "")
    if found:
        module, request_id = found
        return _approver(APPROVAL_CATEGORY.get(module), id=request_id, day=day)
    # The reminder row is gone, or an early reminder row whose type was the module itself ("permission").
    return _approver(APPROVAL_CATEGORY.get(n.type or ""), day=day)


def _salary_slip_id(n, context: dict) -> int | None:
    my = _month_year(n)
    return context.get("slips", {}).get((n.employee_id, *my)) if my else None


def _target(n, context: dict) -> dict | None:
    source = n.source or ""
    key = n.dedupe_key or ""
    if source == MANUAL:
        return None  # HR typed it: nothing to open
    if key.startswith("reminder:") or REMINDER_SOURCE in (source, n.type):
        return _reminder(n, context)
    if key.startswith("wa:"):
        found = _from_whatsapp_key(n, key[3:])
        if found is not _NO_MATCH:
            return found
    if source and catalog.get(source):
        return _from_source(n, source, context)
    return _from_type(n, context)


# ── the API ────────────────────────────────────────────────────────────────────


def build_context(rows) -> dict:
    """The lookups for a page of notifications, two queries at most whatever the page size: the ApprovalReminder rows behind
    "reminder:<id>" keys, and the salary slips the slip messages name (an id only when the month has exactly one slip for
    that employee: a weekly production worker has several)."""
    rows = list(rows)
    context: dict = {"reminders": {}, "slips": {}}
    reminder_ids = {
        _int(n.dedupe_key.split(":", 1)[1]) for n in rows if (n.dedupe_key or "").startswith("reminder:")
    } - {None}
    if reminder_ids:
        from .models import ApprovalReminder

        context["reminders"] = {
            r["id"]: (r["module"], r["request_id"])
            for r in ApprovalReminder.objects.filter(id__in=reminder_ids).values("id", "module", "request_id")
        }
    wanted = {(n.employee_id, *my) for n in rows if _is_salary_slip(n) and (my := _month_year(n))}
    if wanted:
        from .models import SalarySlip

        found = defaultdict(list)
        for s in SalarySlip.objects.filter(
            employee_id__in={w[0] for w in wanted},
            month__in={w[1] for w in wanted},
            year__in={w[2] for w in wanted},
        ).values("id", "employee_id", "month", "year"):
            found[(s["employee_id"], s["month"], s["year"])].append(s["id"])
        context["slips"] = {k: ids[0] for k, ids in found.items() if k in wanted and len(ids) == 1}
    return context


def target_for(notification, context: dict | None = None) -> dict | None:
    """The View target of one notification (see the module docstring), or None when there is nothing to open. Pass the
    `build_context` of the page when serializing many; without one the lookups are made for this row alone. Never raises."""
    try:
        return _target(notification, context if context is not None else build_context([notification]))
    except Exception:
        logger.exception("Could not work out the target of notification %s", getattr(notification, "pk", None))
        return None

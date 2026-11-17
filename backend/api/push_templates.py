"""The wording of phone notifications (Phone Notify Control -> Message Text, owner 2026-11-17).

HR can write a title and a body for every kind of phone notification, with placeholders such as {{employee_name}} or
{{date}}. A kind with no wording saved (or blank) keeps the phone's own built-in wording. The wording is Phone Notify
Control's alone: WhatsApp Control's message text never changes a phone notification, and nothing here changes WhatsApp.

    * An HRMS event (EVENT_WORDING: a request approved, an attendance alert, a document sent ...) has a short built-in
      wording written for a phone, and the event's own details as placeholders.
    * A notification the HRMS makes for the phone alone (approvals waiting, request progress, chat, salary paid,
      overtime ...) has its own placeholders (APP_SPECS), always including {{headline}} and {{message}}: the built-in title
      and sentence, so HR can wrap them ("Action needed: {{message}}") instead of rewriting every case.
    * Not here: what HR types itself (Send a message, the notifications API), and the one-time codes (never
      notifications).

`apply(key, params, title, message)` is what the phone-only senders call: HR's wording filled with the values, or the
built-in title and message when HR wrote none. `render_event(key, params)` makes an event's title and message (HR's
wording, else the built-in one). Placeholders follow one rule: a line whose placeholders are all empty is dropped (so an
optional "Note: {{comment}}" disappears). Saved wording is cached for a few seconds (every alert of a run reads it).
"""

from __future__ import annotations

import logging
import re
import time
from typing import Callable, NamedTuple

from django.db import transaction

logger = logging.getLogger(__name__)

APP_TITLE = "UKTextiles"
MAX_TITLE = 100
MAX_BODY = 1000
CACHE_SECONDS = 15
_PLACEHOLDER = re.compile(r"\{\{\s*([A-Za-z_][A-Za-z0-9_]*|\d+)\s*\}\}")


class Var(NamedTuple):
    name: str
    help: str
    sample: str


class Spec(NamedTuple):
    default_title: str
    default_body: str
    variables: tuple[Var, ...]
    note: str  # what the built-in wording is


def _app(title: str, body: str, note: str, headline: str, message: str, *variables: Var) -> Spec:
    return Spec(
        title,
        body,
        (
            *variables,
            Var("headline", "The built-in title of this notification", headline),
            Var("message", "The built-in sentence of this notification", message),
        ),
        note,
    )


NAME = Var("employee_name", "The employee's name", "Asha Kumar")
CODE = Var("employee_code", "The employee's code", "30012")

# The kinds the HRMS makes itself (mobile_messages.EXTRA_TYPES), and the HOD reminder whose push hod_reminders.py makes.
APP_SPECS: dict[str, Spec] = {
    "approval_waiting": _app(
        APP_TITLE,
        "{{message}}",
        "The built-in sentence names the person and the request, e.g. \"Asha Kumar's leave request is waiting for your "
        'approval."',
        APP_TITLE,
        "Asha Kumar's leave request is waiting for your approval.",
        Var("employee_name", "Who raised the request", "Asha Kumar"),
        Var("employee_code", "Their employee code", "30012"),
        Var("request", "What waits for a decision", "leave request"),
        Var("details", "The date or the place, when the request has one", "21 Nov 2026"),
    ),
    "approval_progress": _app(
        APP_TITLE,
        "{{message}}",
        "The built-in sentence says who approved it and who has it now.",
        APP_TITLE,
        "Approved by your Department Head; now with HR.",
        NAME,
        Var("request", "The kind of request", "leave"),
        Var("next_approver", "Who decides next", "HR"),
    ),
    "request_update": _app(
        APP_TITLE,
        "{{message}}",
        "The built-in sentence confirms the request or names its new status.",
        APP_TITLE,
        "Your request 'Bank letter' is now in progress.",
        NAME,
        Var("request_type", "The kind of request", "Bank letter"),
        Var("subject", "The request's subject", "Bank letter"),
        Var("status", "Its status now", "in progress"),
    ),
    "on_duty_auto_end": _app(
        APP_TITLE,
        "{{message}}",
        "The built-in sentence says why the On-Duty session ended.",
        APP_TITLE,
        "Your On-Duty session for Chennai office was closed automatically at the end of the day.",
        NAME,
        Var("destination", "Where the employee was on duty", "Chennai office"),
    ),
    "salary_paid": _app(
        "Salary Paid",
        "Your salary for {{month}} has been paid.",
        "Names the month, never the amount (a lock screen shows it).",
        "Salary Paid",
        "Your salary for October 2026 has been paid.",
        NAME,
        Var("month", "The month paid", "October 2026"),
    ),
    "approval_reminder": _app(
        "Reminder: request waiting",
        "{{message}}",
        "The built-in text asks the Department Head to review the request and names it.",
        "Reminder: request waiting",
        "Sir, please review this request and provide your approval.\nAsha Kumar (30012) - Leave: 21 Nov 2026.",
        Var("employee_name", "Who sent the reminder", "Asha Kumar"),
        Var("employee_code", "Their employee code", "30012"),
        Var("request", "The request", "Leave"),
        Var("details", "Its summary", "21 Nov 2026"),
        Var("submitted_on", "When it was submitted", "17 Nov 2026, 10:15 AM"),
    ),
    "hod_pending_reminder": _app(
        "Pending approvals",
        "{{message}}",
        "The built-in text is the reminder HR wrote on HR Requests -> Notify.",
        "Pending approvals",
        "Dear Ravi, 3 requests are waiting for your approval.",
        Var("employee_name", "The Department Head's name", "Ravi"),
        Var("total", "How many requests wait", "3"),
        Var("date", "The day of the reminder", "17 Nov 2026"),
    ),
    "chat_announcement": _app(
        "{{sender_name}} in {{channel}}",
        "{{message}}",
        "Shows who wrote it and where, then the message.",
        "UK Textiles HR in Company chat",
        "Holiday on Friday for Deepavali.",
        Var("sender_name", "Who wrote it", "UK Textiles HR"),
        Var("channel", "The chat it was posted in", "Company chat"),
    ),
    "chat_message": _app(
        "{{sender_name}} in {{channel}}",
        "{{message}}",
        "Shows who wrote it and where, then the message.",
        "Ravi Kumar in Company chat",
        "Lunch at 1 today.",
        Var("sender_name", "Who wrote it", "Ravi Kumar"),
        Var("channel", "The chat it was posted in", "Company chat"),
    ),
    "chat_department": _app(
        "{{sender_name}} in {{channel}}",
        "{{message}}",
        "Shows who wrote it and the department's chat, then the message.",
        "Ravi Kumar in Cutting chat",
        "Machine 4 is down.",
        Var("sender_name", "Who wrote it", "Ravi Kumar"),
        Var("channel", "The chat it was posted in", "Cutting chat"),
    ),
    "chat_reply": _app(
        "{{sender_name}} replied to you",
        "{{message}}",
        "Shows who replied, then the reply.",
        "Meena K replied to you",
        "I have the key.",
        Var("sender_name", "Who replied", "Meena K"),
        Var("channel", "The chat", "Company chat"),
    ),
    "chat_report": _app(
        "{{headline}}",
        "{{message}}",
        "The report's first line, then its date and counts.",
        "Attendance report - daily absent",
        "17 Nov 2026 - Staff - as of 12:14\nAbsent: 65\nCL (Casual Leave): 0",
    ),
    "ot_compensation": _app(
        "{{headline}}",
        "{{message}}",
        "Says how the overtime was decided: paid, time off, or not compensated.",
        "Overtime approved: payment",
        "Your extra work on 12 Nov 2026 will be paid (0.5 shifts) with your salary for November 2026.",
        NAME,
        Var("date", "The day of the extra work", "12 Nov 2026"),
        Var("decision", "payment, time off or not compensated", "payment"),
        Var("amount", "The shifts given", "0.5 shifts"),
        Var("granted_on", "The day off granted, for time off", "20 Nov 2026"),
        Var("month", "The salary month, for payment", "November 2026"),
    ),
    "compensation_announcement": _app(
        "{{headline}}",
        "{{message}}",
        "Names the date and what is allowed that day.",
        "Compensation Day announced",
        "21 Nov 2026 is a Compensation Day: no late or permission marks apply that day.",
        Var("date", "The date announced", "21 Nov 2026"),
        Var("kind", "Compensation Day, Late arrival allowed or Early leaving allowed", "Compensation Day"),
        Var("time", "The time allowed, for a late-in or early-out window", "10:00 AM"),
        Var("reason", "HR's reason, when given", "Deepavali"),
    ),
}
# Not wording HR can template: written by HR at send time.
NOT_TEMPLATABLE = frozenset({"manual", "hr_notice"})

# The phone's built-in wording of each HRMS event (mobile_messages.EVENT_TYPES): short, for a lock screen. The placeholders
# are the event's details (the names the event hands over, see EVENT_VARIABLES).
EVENT_WORDING: dict[str, tuple[str, str]] = {
    "salary_slip": ("Salary slip for {{month_year}}", "Your salary slip for {{month_year}} has been sent to you."),
    "id_card": ("Your ID card", "Your employee ID card has been sent to you."),
    "offer_letter": ("Offer letter", "Your offer letter for the position of {{designation}} has been sent to you."),
    "experience_letter": ("Experience letter", "Your experience letter has been sent to you."),
    "resignation_letter": (
        "Resignation letter",
        "Your resignation letter has been sent to you.\nLast working day: {{last_working_day}}",
    ),
    "other": ("New document", "Your {{document_category}} has been sent to you."),
    "absent_alert": (
        "No punch yet today",
        "We have not received your punch for {{date}} (shift start {{shift_start}}, punch allowed until {{cutoff_time}}). "
        "If you are at work, please punch in. If you are absent, please inform HR.",
    ),
    "late_alert": (
        "Marked late today",
        "Your first punch was at {{first_punch}}, {{late_by}} after the allowed time (shift start {{shift_start}}).",
    ),
    "four_punch_alert": (
        "Punch reminder: {{punch_name}}",
        "Your {{punch_name}} is due at {{expected_time}}, in {{minutes_left}}. Please remember to punch.",
    ),
    "on_duty_punch_reminder": (
        "Geo Punch reminder: {{punch_name}}",
        "You are on duty at {{destination}}. Your Geo Punch for {{punch_name}} is due at {{expected_time}}, in "
        "{{minutes_left}}. Please complete it in the app.",
    ),
    "missing_punch_alert": (
        "Missing punch: {{punch_name}}",
        "Your {{punch_name}} (due at {{expected_time}} on {{date}}) is not recorded. Please punch now, or contact HR if you "
        "already did.",
    ),
    "approval_approved": (
        "{{request_type}} approved",
        "Your {{request_type}} request has been approved.\nRequest: {{details}}\nDate: {{date}}\nApproved by: {{approver}}"
        "\nNote: {{comment}}",
    ),
    "approval_rejected": (
        "{{request_type}} rejected",
        "Your {{request_type}} request has been rejected.\nRequest: {{details}}\nDate: {{date}}\nRejected by: {{approver}}"
        "\nReason: {{comment}}",
    ),
    "geo_approval": (
        "On-Duty request approved",
        "Your On-Duty request for {{destination}} has been approved. You can now punch from the app.\nNote: {{comment}}",
    ),
    "geo_rejection": (
        "On-Duty request rejected",
        "Your On-Duty request for {{destination}} has been rejected.\nReason: {{comment}}\n{{punches_note}}",
    ),
    "geo_punch_approval": ("Geo punch approved", "Your Geo {{punch_name}} at {{time}} on {{date}} has been approved."),
    "geo_punch_rejection": (
        "Geo punch rejected",
        "Your Geo {{punch_name}} at {{time}} on {{date}} was rejected and does not count. You can punch again from the "
        "app.\nReason: {{comment}}",
    ),
    "visitor_notification": (
        "Visitor at reception",
        "{{visitor_name}} ({{company}}) is waiting for you at reception.\nPurpose: {{purpose}}",
    ),
    "outpass_gate_out": (
        "Gate exit recorded",
        "Your gate exit at {{gate_out_time}} has been recorded ({{pass_type}}, to {{destination}}).\n{{next_step}}",
    ),
    "outpass_gate_in": (
        "Welcome back",
        "Your return at {{gate_in_time}} has been recorded. Time out: {{duration}}.",
    ),
}


def _event_variables(key: str) -> tuple[Var, ...]:
    """The details an event hands over (the names, help and samples the HRMS defines for the event)."""
    from . import whatsapp_catalog as events

    t = events.get(key)
    return tuple(Var(v.name, v.help, v.sample) for v in t.variables) if t else ()


def spec(key: str) -> Spec | None:
    """The placeholders and the built-in wording of one kind, or None when it has no wording to customise."""
    if key in NOT_TEMPLATABLE:
        return None
    if key in APP_SPECS:
        return APP_SPECS[key]
    if key in EVENT_WORDING:
        title, body = EVENT_WORDING[key]
        return Spec(title, body, _event_variables(key), "The phone's built-in wording.")
    return None


def keys() -> list[str]:
    """Every kind with wording to customise, in the order Phone Notify Control lists the kinds."""
    from . import mobile_messages

    return [r["key"] for r in mobile_messages.controls() if r["kind"] == "message" and spec(r["key"]) is not None]


# ── HR's saved wording ───────────────────────────────────────────────────────

_cache: dict = {"at": None, "rows": {}}


def saved() -> dict[str, tuple[str, str]]:
    """{key: (title, body)} of the kinds HR wrote wording for (blank parts mean "built-in"). Never raises."""
    from . import push_delivery
    from .models import PushTemplate

    now = time.monotonic()
    if not push_delivery.inline_mode() and _cache["at"] is not None and now - _cache["at"] < CACHE_SECONDS:
        return _cache["rows"]
    try:
        with transaction.atomic():
            rows = {
                t.key: (t.title.strip(), t.body.strip())
                for t in PushTemplate.objects.all()
                if t.title.strip() or t.body.strip()
            }
    except Exception:
        logger.warning("Could not read the phone notification wording (is migration 0158 applied?)", exc_info=True)
        rows = {}
    _cache.update(at=now, rows=rows)
    return rows


def forget() -> None:
    """Drop the cache (after HR saves)."""
    _cache["at"] = None


# ── filling it in ────────────────────────────────────────────────────────────


def render_body(template: str, values: dict) -> str:
    from . import whatsapp_service

    return whatsapp_service.render_message(template, values)


def render_title(template: str, values: dict) -> str:
    return " ".join(render_body(template, values).split())[:MAX_TITLE]


def apply(key: str, params, title: str, message: str) -> tuple[str, str]:
    """(title, message) to save and push for a notification of `key`: HR's wording filled with `params` (a dict, or a
    function returning one, called only when HR wrote wording), else the built-in title and message unchanged."""
    custom = saved().get(key)
    if not custom:
        return title, message
    try:
        values = params() if callable(params) else (params or {})
        values = {str(k): "" if v is None else str(v) for k, v in values.items()}
        values.setdefault("headline", title or APP_TITLE)
        values.setdefault("message", message)
        new_title = render_title(custom[0], values) if custom[0] else title
        new_body = render_body(custom[1], values) if custom[1] else message
        return (new_title or title), (new_body or message)
    except Exception:
        logger.exception("Could not fill in the phone wording of %s; the built-in wording is used", key)
        return title, message


def event_values(key: str, params) -> dict:
    """The details of an event as {name: text} (`params` by name, or by position in the event's own order)."""
    names = [v.name for v in _event_variables(key)]
    values: dict = {}
    if isinstance(params, dict):
        values.update({str(k): "" if v is None else str(v) for k, v in params.items()})
    elif isinstance(params, (list, tuple)):
        values.update({name: "" if v is None else str(v) for name, v in zip(names, params)})
    for i, name in enumerate(names, start=1):
        values.setdefault(str(i), values.get(name, ""))
    return values


def render_event(key: str, params) -> tuple[str, str] | None:
    """(title, message) of an HRMS event's phone notification: HR's wording where written, else the built-in one, filled
    with the event's details. None for a kind with no phone wording."""
    s = spec(key)
    if s is None or key not in EVENT_WORDING:
        return None
    custom = saved().get(key, ("", ""))
    values = event_values(key, params)
    title = render_title(custom[0] or s.default_title, values) or APP_TITLE
    body = render_body(custom[1] or s.default_body, values) or title
    return title, body


# ── checking and previewing HR's wording ─────────────────────────────────────


def problem(key: str, title: str, body: str) -> str | None:
    """Why this wording cannot be saved, or None."""
    s = spec(key)
    if s is None:
        return "This notification has no wording to customise."
    if len(title) > MAX_TITLE:
        return f"The title can be at most {MAX_TITLE} characters (a phone shows about 40 to 60)."
    if len(body) > MAX_BODY:
        return f"The message can be at most {MAX_BODY} characters."
    if "\n" in title:
        return "The title must be one line."
    names = {v.name for v in s.variables}
    bad: list[str] = []
    for token in _PLACEHOLDER.findall(title) + _PLACEHOLDER.findall(body):
        ok = (token.isdigit() and 1 <= int(token) <= len(s.variables)) or token in names
        if not ok and token not in bad:
            bad.append(token)
    if bad:
        shown = ", ".join("{{" + b + "}}" for b in bad)
        allowed = ", ".join("{{" + v.name + "}}" for v in s.variables)
        return f"Unknown placeholder {shown}. You can use: {allowed}"
    return None


def sample_values(key: str) -> dict:
    s = spec(key)
    values = {v.name: v.sample for v in s.variables} if s else {}
    for i, v in enumerate(s.variables if s else (), start=1):
        values.setdefault(str(i), v.sample)
    return values


def preview(key: str, title: str, body: str) -> dict:
    """{title, body}: the wording (or the built-in one, when blank) filled with sample values."""
    s = spec(key)
    if s is None:
        return {"title": "", "body": ""}
    values = sample_values(key)
    return {
        "title": render_title(title or s.default_title, values) or APP_TITLE,
        "body": render_body(body or s.default_body, values),
    }


Params = dict | Callable[[], dict] | None

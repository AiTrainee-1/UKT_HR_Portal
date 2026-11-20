"""
Attendance Notify (owner 2026-11-17, /hr/attendance/attendance-notify): attendance reports sent on a schedule through
WhatsApp, Gmail and the internal chat.

    HR saves an automation (report, employees, categories, recipients, times)  -> AttendanceNotifyAutomation
    a 1-minute job (attendance_notify_scheduler.py) starts each due slot        -> AttendanceNotifyRun, unique per
                                                                                    (automation, date, "HH:MM")
    or HR presses "Run now"                                                     -> AttendanceNotifyRun (manual)
    every recipient of the run                                                  -> AttendanceNotifyDelivery

    WhatsApp  whatsapp_service.queue_to_recipient: ONE message per number, the approved Meta template
              hrms_attendance_report (the report's name, its date and the counts on one line: "Absent 4, CL 2"),
              through the shared paced queue (its gap, caps, quiet hours and switches keep the number safe), with the
              exactly-once key "attnotify:<run>:<delivery>:<attempt>:0". The employee list and the PDF with photos go
              by Gmail or the internal chat: a template carries neither. WhatsApp groups can't be reached by the
              official WhatsApp Cloud API: new ones are refused, and a group an older automation still lists is
              skipped with the reason.
    Gmail     email_service.send_email("attendance_report"): ONE email to every To / CC / BCC address (HTML with
              inline photos, or plain text; a PDF when asked)
    Chat      a ChatMessage in each chosen channel (sender "Attendance Notify"), text + a card the HR chat page draws

Exactly once, whatever happens to the server (the same design as hod_reminders.py): a scheduled slot is a database row
unique per (automation, run_date, slot); a run is processed by whoever holds its `claim_token`, the holder beats
`heartbeat_at` after every recipient, and the 1-minute job takes over a run whose holder stopped; a delivery left
"sending" by a holder that stopped is never sent a second time. A failed email / chat delivery is tried again a few
minutes later (at most MAX_ATTEMPTS); a failed WhatsApp message gets the queue's own retry, and HR can "Retry failed".

Sending is never done inside a web request (one sync worker, 30-second limit): "Run now" and "Retry" create the run
and a background thread sends it; the page polls the run.
"""

from __future__ import annotations

import logging
import re
import threading
import uuid
from datetime import date, datetime, timedelta

from django.db import IntegrityError, close_old_connections, connections, transaction
from django.db.models import Q
from django.utils import timezone

from . import attendance_notify_report as rpt
from .clock import FACTORY_TZ, ist_now
from .hod_reminders import due_slots, next_run_at

logger = logging.getLogger(__name__)

SOURCE = "attendance_report"  # the WhatsApp catalogue key and the email type
SENDER_LABEL = "Attendance Notify"
CHANNELS = ("whatsapp", "email", "chat")
CHANNEL_LABELS = {"whatsapp": "WhatsApp", "email": "Gmail", "chat": "Internal Chat"}
FREQUENCIES = ("daily", "weekly", "once")
CONTENTS = ("summary", "detailed", "both")
MAX_TIMES = 6
MAX_NUMBERS = 25
MAX_ADDRESSES = 50
MAX_CHAT_CHANNELS = 20
NAME_MAX = 120
WINDOW_MINUTES = 10
STALE_AFTER = timedelta(minutes=3)
GIVE_UP_AFTER = timedelta(minutes=60)
UNCLAIMED_AFTER = timedelta(minutes=1)
RETRY_AFTER = timedelta(minutes=5)
MAX_ATTEMPTS = 3
QUEUED_NOTE = "Queued for WhatsApp: it leaves within the day's sending limits (WhatsApp Control -> Messages)."
GROUPS_REFUSED = (
    "WhatsApp groups can't be messaged through the official WhatsApp Cloud API: remove the group and add individual "
    "WhatsApp numbers instead."
)

_TIME = re.compile(r"^(\d{1,2}):(\d{2})$")
_EMAIL = re.compile(r"^[^@\s,;<>]+@[^@\s,;<>]+\.[^@\s,;<>]+$")


class Invalid(ValueError):
    def __init__(self, message: str, field: str = ""):
        super().__init__(message)
        self.field = field


# ─────────────────────────── validation ───────────────────────────


def normalize_number(raw) -> str | None:
    """ "+91 98765 43210" -> "919876543210" (digits, with the country code; a 10-digit Indian number gets 91). None
    for anything that cannot be a phone number (fewer than 10 or more than 15 digits once the country code is on)."""
    from . import whatsapp_service as wa

    phone = wa.normalize_phone(str(raw or ""))
    return phone if phone and 10 <= len(phone) <= 15 else None


def parse_times(raw) -> list[str]:
    if not isinstance(raw, list) or not raw:
        raise Invalid("Choose at least one sending time.", "times")
    if len(raw) > MAX_TIMES:
        raise Invalid(f"Choose at most {MAX_TIMES} sending times.", "times")
    out: list[str] = []
    for item in raw:
        m = _TIME.match(item.strip()) if isinstance(item, str) else None
        if not m or int(m.group(1)) > 23 or int(m.group(2)) > 59:
            raise Invalid(f"'{item}' is not a time of day: use HH:MM between 00:00 and 23:59.", "times")
        slot = f"{int(m.group(1)):02d}:{m.group(2)}"
        if slot in out:
            raise Invalid(f"{slot} is listed twice.", "times")
        out.append(slot)
    return sorted(out)


def _date(raw, field: str, label: str) -> date | None:
    if raw in (None, ""):
        return None
    try:
        return date.fromisoformat(str(raw)[:10])
    except ValueError:
        raise Invalid(f"{label} is not a date (YYYY-MM-DD).", field)


def _bool(data: dict, key: str, default: bool) -> bool:
    value = data.get(key, default)
    if not isinstance(value, bool):
        raise Invalid(f"{key} must be true or false.", key)
    return value


def _clean_recipients(channel: str, raw, branch_id) -> dict:
    from .models import AttendanceNotifyRecipientList, ChatChannel

    raw = raw if isinstance(raw, dict) else {}
    list_ids = []
    for i in raw.get("listIds") or []:
        if isinstance(i, int) and not isinstance(i, bool):
            list_ids.append(i)
    if list_ids:
        lists = AttendanceNotifyRecipientList.objects.filter(pk__in=list_ids, channel=channel)
        if branch_id is not None:
            lists = lists.filter(Q(branch_id=branch_id) | Q(branch__isnull=True))
        found = set(lists.values_list("pk", flat=True))
        missing = [i for i in list_ids if i not in found]
        if missing:
            raise Invalid("A saved recipient list was not found (it may have been deleted).", "recipients")
    if channel == "whatsapp":
        numbers, seen = [], set()
        for item in raw.get("numbers") or []:
            value = item.get("value") if isinstance(item, dict) else item
            label = (item.get("label") or "").strip()[:80] if isinstance(item, dict) else ""
            phone = normalize_number(value)
            if not phone:
                raise Invalid(f"'{value}' is not a WhatsApp number.", "recipients")
            if phone not in seen:
                seen.add(phone)
                numbers.append({"value": phone, "label": label})
        if raw.get("groups"):  # Meta's templates cannot reach a group (whatsapp_service.REASON_NO_GROUPS)
            raise Invalid(GROUPS_REFUSED, "recipients")
        if len(numbers) > MAX_NUMBERS:
            raise Invalid(f"Add at most {MAX_NUMBERS} numbers to one automation.", "recipients")
        connected = bool(raw.get("connected"))
        if not (numbers or connected or list_ids):
            raise Invalid("Add at least one WhatsApp number.", "recipients")
        return {"connected": connected, "numbers": numbers, "groups": [], "listIds": list_ids}
    if channel == "email":
        out = {}
        total = 0
        for key in ("to", "cc", "bcc"):
            values, seen = [], set()
            for a in raw.get(key) or []:
                a = str(a or "").strip()
                if not a:
                    continue
                if not _EMAIL.match(a):
                    raise Invalid(f"'{a}' is not an email address.", "recipients")
                if a.lower() not in seen:
                    seen.add(a.lower())
                    values.append(a)
            out[key] = values
            total += len(values)
        if total > MAX_ADDRESSES:
            raise Invalid(f"Add at most {MAX_ADDRESSES} addresses to one automation.", "recipients")
        if not (out["to"] or list_ids):
            raise Invalid("Add at least one 'To' address.", "recipients")
        out["listIds"] = list_ids
        return out
    ids = []
    for i in raw.get("channelIds") or []:
        if isinstance(i, int) and not isinstance(i, bool) and i not in ids:
            ids.append(i)
    if not ids:
        raise Invalid("Choose at least one chat channel.", "recipients")
    if len(ids) > MAX_CHAT_CHANNELS:
        raise Invalid(f"Choose at most {MAX_CHAT_CHANNELS} chat channels.", "recipients")
    channels = ChatChannel.objects.filter(pk__in=ids)
    if branch_id is not None:
        channels = channels.filter(branch_id=branch_id)
    if channels.count() != len(ids):
        raise Invalid("A chat channel was not found.", "recipients")
    return {"channelIds": ids}


def clean(data: dict, *, branch_id=None, existing=None, need_recipients: bool = True) -> dict:
    """The model fields of an automation from the page's JSON, or Invalid(message, field). `existing`: the automation
    being edited (its channel cannot change). `need_recipients=False` (a preview): recipients are not checked."""
    if not isinstance(data, dict):
        raise Invalid("Send the automation as an object.")
    name = str(data.get("name") or "").strip()
    if not name:
        raise Invalid("Give the automation a name.", "name")
    if len(name) > NAME_MAX:
        raise Invalid(f"The name is at most {NAME_MAX} characters.", "name")
    channel = existing.channel if existing is not None else data.get("channel")
    if channel not in CHANNELS:
        raise Invalid("Choose WhatsApp, Gmail or Internal Chat.", "channel")
    report_type = data.get("reportType") or "daily"
    if report_type not in ("daily", "custom"):
        raise Invalid("The report is daily or custom.", "reportType")
    report_day = data.get("reportDay") or "today"
    if report_day not in ("today", "yesterday"):
        raise Invalid("A daily report is about today or yesterday.", "reportDay")
    date_from = _date(data.get("dateFrom"), "dateFrom", "The first date")
    date_to = _date(data.get("dateTo"), "dateTo", "The last date") or date_from
    if report_type == "custom":
        if date_from is None:
            raise Invalid("Choose the date (or the first date) of the report.", "dateFrom")
        if date_to < date_from:
            raise Invalid("The last date is before the first.", "dateTo")
        if (date_to - date_from).days + 1 > rpt.MAX_RANGE_DAYS:
            raise Invalid(f"A report covers at most {rpt.MAX_RANGE_DAYS} days.", "dateTo")
    else:
        date_from = date_to = None
    categories = data.get("categories")
    if not isinstance(categories, list) or not categories:
        raise Invalid(
            "Choose at least one category (Absent, CL, On Leave, On Duty, Permission, Compensation).", "categories"
        )
    bad = [c for c in categories if c not in rpt.CATEGORIES]
    if bad:
        raise Invalid(f"Unknown category '{bad[0]}'.", "categories")
    employee_type = data.get("employeeType") or "all"
    if employee_type not in rpt.EMPLOYEE_TYPES:
        raise Invalid("Employees are all, staff or production.", "employeeType")
    frequency = data.get("frequency") or "daily"
    if frequency not in FREQUENCIES:
        raise Invalid("Send daily, on chosen weekdays, or once.", "frequency")
    days = data.get("days") if data.get("days") is not None else [0, 1, 2, 3, 4, 5]
    if frequency == "weekly":
        if not isinstance(days, list) or not days:
            raise Invalid("Choose at least one day of the week.", "days")
        if any(isinstance(d, bool) or not isinstance(d, int) or not 0 <= d <= 6 for d in days):
            raise Invalid("Days are 0 (Monday) to 6 (Sunday).", "days")
        days = sorted(set(days))
    else:
        days = [0, 1, 2, 3, 4, 5, 6] if frequency == "daily" else []
    run_on = _date(data.get("runOn"), "runOn", "The sending date")
    if frequency == "once":
        if run_on is None:
            raise Invalid("Choose the date to send it on.", "runOn")
    else:
        run_on = None
    times = parse_times(data.get("times"))
    content = data.get("content") or "both"
    if content not in CONTENTS:
        raise Invalid("Send the summary, the detailed list, or both.", "content")
    email_format = data.get("emailFormat") or "html"
    if email_format not in ("text", "html"):
        raise Invalid("The email is plain text or HTML.", "emailFormat")
    subject = str(data.get("subject") or "").strip()
    if len(subject) > 200:
        raise Invalid("The subject is at most 200 characters.", "subject")
    return {
        "name": name,
        "channel": channel,
        "is_active": _bool(data, "isActive", True),
        "report_type": report_type,
        "report_day": report_day,
        "date_from": date_from,
        "date_to": date_to,
        "categories": [c for c in rpt.CATEGORIES if c in set(categories)],
        "employee_type": employee_type,
        "frequency": frequency,
        "days": days,
        "run_on": run_on,
        "times": times,
        "content": content,
        "include_photos": _bool(data, "includePhotos", False),
        "email_format": email_format,
        "attach_pdf": _bool(data, "attachPdf", False),
        "subject": subject,
        "skip_when_empty": _bool(data, "skipWhenEmpty", False),
        "recipients": _clean_recipients(channel, data.get("recipients"), branch_id) if need_recipients else {},
    }


# ─────────────────────────── shapes ───────────────────────────


def config_of(a) -> dict:
    """The camelCase form of an automation (also kept on each run as it was when the run started)."""
    return {
        "name": a.name,
        "channel": a.channel,
        "isActive": a.is_active,
        "reportType": a.report_type,
        "reportDay": a.report_day,
        "dateFrom": a.date_from.isoformat() if a.date_from else None,
        "dateTo": a.date_to.isoformat() if a.date_to else None,
        "categories": list(a.categories or []),
        "employeeType": a.employee_type,
        "frequency": a.frequency,
        "days": list(a.days or []),
        "runOn": a.run_on.isoformat() if a.run_on else None,
        "times": list(a.times or []),
        "content": a.content,
        "includePhotos": a.include_photos,
        "emailFormat": a.email_format,
        "attachPdf": a.attach_pdf,
        "subject": a.subject,
        "skipWhenEmpty": a.skip_when_empty,
        "recipients": a.recipients or {},
    }


def config_from_fields(fields: dict) -> dict:
    """The camelCase config of cleaned (not saved) fields, for a preview."""

    class _A:
        pass

    a = _A()
    for k, v in fields.items():
        setattr(a, k, v)
    return config_of(a)


def recipient_summary(channel: str, recipients: dict) -> str:
    r = recipients or {}
    lists = len(r.get("listIds") or [])
    parts = []
    if channel == "whatsapp":
        if r.get("connected"):
            parts.append("connected number")
        n, g = len(r.get("numbers") or []), len(r.get("groups") or [])
        if n:
            parts.append(f"{n} number{'s' if n != 1 else ''}")
        if g:  # an older automation's groups: skipped at every run (not reachable with Meta's templates)
            parts.append(f"{g} group{'s' if g != 1 else ''} (not sent)")
    elif channel == "email":
        for key, label in (("to", "To"), ("cc", "CC"), ("bcc", "BCC")):
            if r.get(key):
                parts.append(f"{label} {len(r[key])}")
    else:
        c = len(r.get("channelIds") or [])
        parts.append(f"{c} channel{'s' if c != 1 else ''}")
    if lists:
        parts.append(f"{lists} saved list{'s' if lists != 1 else ''}")
    return ", ".join(parts) or "nobody"


def _aware(at: datetime | None) -> str | None:
    if at is None:
        return None
    if timezone.is_naive(at):
        at = at.replace(tzinfo=FACTORY_TZ)
    return at.astimezone(FACTORY_TZ).isoformat()


def schedule_days(a) -> list[int]:
    if a.frequency == "weekly":
        return list(a.days or [])
    if a.frequency == "once":
        return [a.run_on.weekday()] if a.run_on else []
    return [0, 1, 2, 3, 4, 5, 6]


def scheduled_done(automation_id: int, since: date) -> set:
    from .models import AttendanceNotifyRun

    return set(
        AttendanceNotifyRun.objects.filter(
            automation_id=automation_id, trigger=AttendanceNotifyRun.TRIGGER_SCHEDULE, run_date__gte=since
        ).values_list("run_date", "slot")
    )


def due_for(a, now: datetime, done: set) -> list:
    if not a.is_active:
        return []
    slots = due_slots(now, enabled=True, times=a.times, days=schedule_days(a), done=done)
    if a.frequency == "once":
        slots = [(d, s) for d, s in slots if d == a.run_on]
    return slots


def next_run_for(a, now: datetime | None = None) -> datetime | None:
    """When the automation sends next (naive IST), or None (inactive, or a one-off that has passed)."""
    if not a.is_active:
        return None
    now = now or ist_now()
    done = scheduled_done(a.pk, now.date() - timedelta(days=1)) if a.pk else set()
    if a.frequency == "once":
        if not a.run_on or a.run_on < now.date() - timedelta(days=1):
            return None
        at = next_run_at(now, enabled=True, times=a.times, days=schedule_days(a), done=done)
        return at if at is not None and at.date() == a.run_on else None
    return next_run_at(now, enabled=True, times=a.times, days=schedule_days(a), done=done)


def automation_json(a, *, last_run=None, now: datetime | None = None) -> dict:
    out = {"id": a.pk, **config_of(a)}
    out.update(
        {
            "recipientSummary": recipient_summary(a.channel, a.recipients),
            "branch": {"id": a.branch_id, "name": a.branch.name} if a.branch_id and a.branch else None,
            "nextRunAt": _aware(next_run_for(a, now)),
            "lastRun": (
                {
                    "id": last_run.pk,
                    "at": _aware(last_run.started_at),
                    "status": last_run.status,
                    "employees": last_run.employees,
                    "error": last_run.error,
                }
                if last_run is not None
                else None
            ),
            "createdBy": a.created_by,
            "createdAt": _aware(a.created_at),
            "updatedBy": a.updated_by,
            "updatedAt": _aware(a.updated_at),
        }
    )
    return out


def delivery_json(d) -> dict:
    return {
        "id": d.pk,
        "kind": d.kind,
        "recipient": d.recipient,
        "label": d.label,
        "status": d.status,
        "note": d.note,
        "attempts": d.attempts,
        "updatedAt": _aware(d.updated_at),
    }


def run_json(run, deliveries=None) -> dict:
    ds = list(deliveries if deliveries is not None else run.deliveries.all())
    return {
        "id": run.pk,
        "automationId": run.automation_id,
        "automationName": run.automation_name,
        "channel": run.channel,
        "trigger": run.trigger,
        "slot": run.slot,
        "runDate": run.run_date.isoformat() if run.run_date else None,
        "reportFrom": run.report_from.isoformat() if run.report_from else None,
        "reportTo": run.report_to.isoformat() if run.report_to else None,
        "status": run.status,
        "employees": run.employees,
        "counts": run.counts or {},
        "recipients": len(ds),
        "sent": sum(1 for d in ds if d.status in ("sent", "queued")),
        "failed": sum(1 for d in ds if d.status == "failed"),
        "error": run.error,
        "requestedBy": run.requested_by,
        "startedAt": _aware(run.started_at),
        "finishedAt": _aware(run.finished_at),
        "deliveries": [delivery_json(d) for d in ds],
    }


# ─────────────────────────── recipients of a run ───────────────────────────


def recipients_of(a_config: dict, branch_id=None) -> list[tuple]:
    """[(kind, recipient, label)] of an automation: its own recipients and those of its saved lists, each once. Email
    is ONE recipient (one message to every address): (kind, "to, addresses", label, {"cc": [...], "bcc": [...]})."""
    from .models import AttendanceNotifyRecipientList, AttendanceNotifySettings, ChatChannel

    channel = a_config["channel"]
    r = a_config.get("recipients") or {}
    lists = list(AttendanceNotifyRecipientList.objects.filter(pk__in=r.get("listIds") or [], channel=channel))
    out: list = []
    seen: set = set()

    def add(kind, value, label):
        if value and value not in seen:
            seen.add(value)
            out.append((kind, value, label))

    if channel == "whatsapp":
        if r.get("connected"):
            number = normalize_number(AttendanceNotifySettings.get().connected_number)
            add("connected", number or "", "Connected number")
        for n in r.get("numbers") or []:
            add("number", n.get("value"), n.get("label") or "")
        for lst in lists:
            for n in lst.items if isinstance(lst.items, list) else []:
                phone = normalize_number(n.get("value") if isinstance(n, dict) else n)
                add("number", phone, (n.get("label") if isinstance(n, dict) else "") or f"List: {lst.name}")
        for g in r.get("groups") or []:
            add("group", g.get("id"), g.get("name") or "")
        if r.get("connected") and not normalize_number(AttendanceNotifySettings.get().connected_number):
            out.append(("connected", "", "Connected number (not set on the page)"))
        return out
    if channel == "email":
        to, cc, bcc = list(r.get("to") or []), list(r.get("cc") or []), list(r.get("bcc") or [])
        for lst in lists:
            items = lst.items if isinstance(lst.items, dict) else {}
            to += items.get("to") or []
            cc += items.get("cc") or []
            bcc += items.get("bcc") or []

        def uniq(values, taken):
            res = []
            for v in values:
                key = str(v).strip().lower()
                if key and key not in taken:
                    taken.add(key)
                    res.append(str(v).strip())
            return res

        taken: set = set()
        to, cc, bcc = uniq(to, taken), uniq(cc, taken), uniq(bcc, taken)
        label = " · ".join(f"{name} {len(v)}" for name, v in (("To", to), ("CC", cc), ("BCC", bcc)) if v)
        return [("email", ", ".join(to), label, {"cc": cc, "bcc": bcc})]
    names = {}
    for c in ChatChannel.objects.filter(pk__in=r.get("channelIds") or []).select_related("department", "branch"):
        names[c.pk] = chat_channel_name(c)
    for cid in r.get("channelIds") or []:
        add("chat", str(cid), names.get(cid, f"Channel {cid}"))
    return out


def chat_channel_name(c) -> str:
    if c.channel_type == "department":
        return f"{c.department.name if c.department_id and c.department else 'Department'} (department)"
    return f"Company – {c.branch.name}" if c.branch_id and c.branch else "Company (no branch)"


# ─────────────────────────── channel state ───────────────────────────


def channel_status() -> dict:
    """{channel: {available, note}}: whether each channel can deliver right now, and if not why."""
    from . import email_service
    from . import whatsapp_service as wa
    from .models import PayrollSettings

    def state(problem, ready):
        return {"available": problem is None, "note": problem or ready}

    if not wa.has_credentials():
        wa_problem = "WhatsApp is not set up on this server (the Meta WhatsApp Cloud API keys are missing)."
    elif not wa.sending_allowed():
        wa_problem = (
            "WhatsApp sending is off on this machine (a development setup): runs are recorded, nothing is sent."
        )
    else:
        wa_problem = wa.switch_off_reason(SOURCE) or wa.template_problem(SOURCE)
    ps = PayrollSettings.get()
    email_problem = email_service.switch_off_reason(SOURCE)
    if email_problem is None and email_service.smtp_missing_reason(ps):
        email_problem = "Email (SMTP) is not set up in Settings."
    if email_problem is None and not email_service.sending_allowed():
        email_problem = (
            "Email sending is off on this machine (a development setup): runs are recorded, nothing is sent."
        )
    if email_problem is None:
        email_problem = email_service.daily_limit_reason()
    return {
        "whatsapp": state(
            wa_problem,
            "Ready: the summary goes from the company WhatsApp number (an approved template) through the paced queue.",
        ),
        "email": state(email_problem, "Ready: sent from the company Gmail account."),
        "chat": state(None, "Ready: posted in the chosen chat channels as 'Attendance Notify'."),
    }


# ─────────────────────────── sending ───────────────────────────


def dedupe_key(run, d, part: int) -> str:
    return f"attnotify:{run.pk}:{d.pk}:{d.attempts}:{part}"


def whatsapp_params(report) -> dict:
    """The variables of the Meta template hrms_attendance_report (whatsapp_catalog), each on one line: report_title
    "Morning absentees (Staff, Tirupur)", date "17 Nov 2026, as of 09:30", summary "Absent 4, CL 2, On Leave 1 (7 of 250
    employees)"."""
    from .whatsapp_format import flat

    scope = [rpt.TYPE_LABELS.get(report.employee_type, "All employees")]
    if report.branch:
        scope.append(report.branch)
    title = f"{report.name} ({', '.join(scope)})" if report.name else ", ".join(scope)
    when = rpt.days_text(report.days)
    if report.as_of:
        when = f"{when}, as of {report.as_of}"
    counts = ", ".join(f"{rpt.LABELS[c]} {report.counts.get(c, 0)}" for c in report.categories)
    people = f"{report.employees} of {report.total_employees} employees"
    summary = f"{counts} ({people})" if counts else people
    return flat({"report_title": title, "date": when, "summary": summary})


def whatsapp_text(report) -> str:
    """What the WhatsApp message reads like: the template's text (the catalog's wording when this server does not have
    the approved template yet) with this report's variables."""
    from . import whatsapp_service as wa

    return wa.render_template_text(wa.template_for(SOURCE), whatsapp_params(report))


class _Prepared:
    """What a run sends, built once: the report and its renderings (the PDF only when a recipient needs it)."""

    def __init__(self, run, report):
        self.run = run
        self.config = run.config or {}
        self.report = report
        self.content = self.config.get("content") or "both"
        self._pdf = None

    @property
    def wants_pdf(self) -> bool:
        # only email attaches it: a WhatsApp template carries the summary line, not a file
        if self.config.get("channel") == "email":
            return bool(self.config.get("attachPdf"))
        return False

    def pdf(self) -> bytes:
        if self._pdf is None:
            self._pdf = rpt.pdf_bytes(
                self.report, with_photos=bool(self.config.get("includePhotos")), content=self.content
            )
        return self._pdf


def _send_whatsapp(prep: _Prepared, d) -> tuple[str, str]:
    """ONE message per number: the Meta template hrms_attendance_report with the report's summary on one line."""
    from . import whatsapp_service as wa
    from .models import AttendanceNotifyDelivery as D

    if d.kind == "group" or wa.is_group_id(d.recipient or ""):
        return D.STATUS_SKIPPED, wa.REASON_NO_GROUPS
    if not d.recipient:
        return D.STATUS_SKIPPED, "No number: set the connected WhatsApp number on the Attendance Notify page."
    params = whatsapp_params(prep.report)
    logs = [
        wa.queue_to_recipient(
            d.recipient,
            params["summary"],
            recipient_label=d.label or d.recipient,
            dedupe_key=dedupe_key(prep.run, d, 0),
            document_ref_id=prep.run.pk,
            params=params,
        )
    ]
    d.whatsapp_log_ids = [log.pk for log in logs if log is not None]
    d.save(update_fields=["whatsapp_log_ids", "updated_at"])
    return whatsapp_outcome(logs)


def whatsapp_outcome(logs) -> tuple[str, str]:
    """A delivery's status from its WhatsApp messages: failed when any failed / expired, skipped when all were skipped,
    queued while any waits in the queue, else sent."""
    from .models import AttendanceNotifyDelivery as D, WhatsAppMessageLog as L

    logs = [log for log in logs if log is not None]
    if not logs:
        return D.STATUS_FAILED, "No message was queued."
    bad = [log for log in logs if log.status in (L.STATUS_FAILED, L.STATUS_EXPIRED)]
    if bad:
        return D.STATUS_FAILED, bad[0].error_message or "WhatsApp did not accept the message."
    if all(log.status == L.STATUS_SKIPPED for log in logs):
        return D.STATUS_SKIPPED, logs[0].error_message or "Not sent"
    if any(log.status in (L.STATUS_QUEUED, L.STATUS_SENDING, L.STATUS_PENDING) for log in logs):
        return D.STATUS_QUEUED, QUEUED_NOTE
    skipped = [log for log in logs if log.status == L.STATUS_SKIPPED]
    if skipped:
        return D.STATUS_SENT, f"Partly sent: {skipped[0].error_message}"
    return D.STATUS_SENT, ""


def _send_email(prep: _Prepared, d) -> tuple[str, str]:
    from . import email_service
    from .models import AttendanceNotifyDelivery as D
    from .user_settings import _overlay_for_branch

    cc, bcc = prep.config.get("emailCc") or [], prep.config.get("emailBcc") or []
    html = prep.config.get("emailFormat") != "text"
    photos = {}
    if html and prep.config.get("includePhotos") and prep.content in ("detailed", "both"):
        photos = rpt.photo_bytes([r.person.id for r in prep.report.rows])
    cids = {pk: f"emp{pk}@attendance-notify" for pk in photos}
    report = prep.report
    attach = [(rpt.pdf_filename(report), prep.pdf(), "application/pdf")] if prep.wants_pdf else []
    subject_override = (prep.config.get("subject") or "").strip()
    params = {
        "report_name": report.name,
        "date": rpt.days_text(report.days),
        "employee_type": rpt.TYPE_LABELS.get(report.employee_type, "All employees"),
    }
    ps = _overlay_for_branch(prep.run.config.get("branchId"))
    to = [a.strip() for a in (d.recipient or "").split(",") if a.strip()]
    log = email_service.send_email(
        SOURCE,
        to_email=to[0] if to else "",
        extra_to=to[1:],
        cc=cc,
        bcc=bcc,
        params=params,
        ps=ps,
        recipient_name=report.name,
        attachments=attach,
        related_module="attendance",
        ref_id=prep.run.pk,
        report_html=rpt.email_html(report, prep.content, cids if prep.config.get("includePhotos") else None)
        if html
        else "",
        report_text=rpt.email_text(report, prep.content),
        inline_images=[(cids[pk], raw, "image/jpeg") for pk, raw in photos.items()],
        subject=subject_override or None,
    )
    if log is None:
        return D.STATUS_SKIPPED, "Not sent: email is switched off or not set up."
    d.email_log_id = log.pk
    d.save(update_fields=["email_log_id", "updated_at"])
    if log.status == email_service.EMAIL_SENT:
        return D.STATUS_SENT, ""
    if log.status == email_service.EMAIL_BLOCKED:
        return D.STATUS_SKIPPED, log.error_message
    return D.STATUS_FAILED, log.error_message or "The email could not be sent."


def _send_chat(prep: _Prepared, d) -> tuple[str, str]:
    from .models import AttendanceNotifyDelivery as D, ChatChannel, ChatMessage

    if d.chat_message_id:
        return D.STATUS_SENT, ""
    channel = ChatChannel.objects.filter(pk=int(d.recipient or 0)).first()
    if channel is None:
        return D.STATUS_FAILED, "This chat channel no longer exists."
    text = "\n\n".join(rpt.message_parts(prep.report, prep.content, markdown=False))
    payload = rpt.chat_payload(prep.report)
    payload["content"] = prep.content
    payload["includePhotos"] = bool(prep.config.get("includePhotos"))
    if prep.content == "summary":
        payload["rows"] = []
    msg = ChatMessage.objects.create(
        channel=channel, sender=None, sender_label=SENDER_LABEL, text=text, payload=payload
    )
    d.chat_message_id = msg.pk
    d.save(update_fields=["chat_message_id", "updated_at"])
    from . import chat_push

    chat_push.message_posted(msg.pk)  # the channel's readers get its headline on their phones (Phone Notify Control)
    return D.STATUS_SENT, ""


SENDERS = {"whatsapp": _send_whatsapp, "email": _send_email, "chat": _send_chat}


def _set(d, status: str, note: str, *, retry: bool = False) -> None:
    d.status = status
    d.note = (note or "")[:1000]
    d.retry_at = timezone.now() + RETRY_AFTER if retry and d.attempts < MAX_ATTEMPTS else None
    d.save(update_fields=["status", "note", "retry_at", "updated_at"])


def _deliver(prep: _Prepared, d) -> None:
    from .models import AttendanceNotifyDelivery as D

    d.attempts += 1
    d.status = D.STATUS_SENDING
    d.save(update_fields=["attempts", "status", "updated_at"])
    try:
        status, note = SENDERS[prep.run.channel](prep, d)
    except Exception as exc:  # one recipient must never stop the run
        logger.exception("Attendance Notify run %s delivery %s failed", prep.run.pk, d.pk)
        status, note = D.STATUS_FAILED, f"Unexpected error: {exc}"
    # email / chat: a failure is tried again a few minutes later (WhatsApp retries in its own queue)
    _set(d, status, note, retry=status == D.STATUS_FAILED and prep.run.channel in ("email", "chat"))


def finish_status(deliveries) -> str:
    from .models import AttendanceNotifyRun as R

    ds = list(deliveries)
    if not ds:
        return R.STATUS_FAILED
    ok = [d for d in ds if d.status in ("sent", "queued")]
    if len(ok) == len(ds):
        return R.STATUS_DONE
    if ok:
        return R.STATUS_PARTIAL
    if all(d.status == "skipped" for d in ds):
        return R.STATUS_SKIPPED
    return R.STATUS_FAILED


def _beat(run_id: int, token: str) -> bool:
    from .models import AttendanceNotifyRun as R

    return (
        R.objects.filter(pk=run_id, claim_token=token, status=R.STATUS_RUNNING).update(heartbeat_at=timezone.now()) == 1
    )


def fail_run(run_id: int, error: str, token: str | None = None) -> None:
    from .models import AttendanceNotifyDelivery as D, AttendanceNotifyRun as R

    qs = R.objects.filter(pk=run_id, status=R.STATUS_RUNNING)
    if token is not None:
        qs = qs.filter(claim_token=token)
    if not qs.update(status=R.STATUS_FAILED, error=error[:1000], finished_at=timezone.now()):
        return
    D.objects.filter(run_id=run_id, status__in=(D.STATUS_PENDING, D.STATUS_SENDING)).update(
        status=D.STATUS_FAILED, note=f"Not sent: {error}"[:1000]
    )


def build_report(run):
    """The report of a run (the days it was started for, its automation as it was then)."""
    config = run.config or {}
    now = ist_now()
    if run.report_from and run.report_to:
        days_cfg = {**config, "reportType": "custom", "dateFrom": run.report_from, "dateTo": run.report_to}
    else:
        days_cfg = config
    report = rpt.build(days_cfg, now=now, branch_id=config.get("branchId"), branch_name=config.get("branchName") or "")
    report.name = config.get("name") or run.automation_name
    if run.report_from and run.report_to and run.report_to == now.date():
        report.as_of = now.strftime("%H:%M")
    return report


def process_run(run_id: int) -> str | None:
    """Send a run (in the calling thread). Returns its final status, or None when another processor holds it."""
    from .models import AttendanceNotifyDelivery as D, AttendanceNotifyRun as R

    token = uuid.uuid4().hex
    now = timezone.now()
    claimed = (
        R.objects.filter(pk=run_id, status=R.STATUS_RUNNING)
        .filter(Q(claim_token="") | Q(heartbeat_at__isnull=True) | Q(heartbeat_at__lt=now - STALE_AFTER))
        .update(claim_token=token, heartbeat_at=now)
    )
    if not claimed:
        return None
    try:
        run = R.objects.get(pk=run_id)
        # a recipient a stopped holder left "sending" may or may not have been reached: never send it twice
        run.deliveries.filter(status=D.STATUS_SENDING).update(
            status=D.STATUS_FAILED,
            note="Not known: the server stopped while this was being sent, so it was not sent again.",
        )
        report = build_report(run)
        run.employees = report.employees
        run.counts = dict(report.counts)
        run.report_from = report.days[0] if report.days else None
        run.report_to = report.days[-1] if report.days else None
        run.save(update_fields=["employees", "counts", "report_from", "report_to"])
        pending = list(run.deliveries.filter(status=D.STATUS_PENDING).order_by("id"))
        if report.is_empty and (run.config or {}).get("skipWhenEmpty"):
            for d in pending:
                _set(d, D.STATUS_SKIPPED, "Nobody is in the chosen categories: not sent (skip when empty).")
        else:
            prep = _Prepared(run, report)
            for d in pending:
                if not _beat(run_id, token):
                    return None
                _deliver(prep, d)
        status = finish_status(run.deliveries.all())
        if not R.objects.filter(pk=run_id, claim_token=token, status=R.STATUS_RUNNING).update(
            status=status, finished_at=timezone.now()
        ):
            return None
        return status
    except Exception as exc:
        logger.exception("Attendance Notify run %s failed", run_id)
        fail_run(run_id, f"{type(exc).__name__}: {exc}", token)
        return R.STATUS_FAILED


def launch(run_id: int) -> None:
    """Send a run on a background thread once the transaction has committed (never inside the request)."""

    def runner() -> None:
        try:
            close_old_connections()
            process_run(run_id)
        except Exception:
            logger.exception("Attendance Notify run %s could not be processed", run_id)
        finally:
            connections.close_all()

    transaction.on_commit(
        lambda: threading.Thread(target=runner, name=f"attendance-notify-{run_id}", daemon=True).start()
    )


def create_run(a, *, trigger: str, run_date: date, slot: str | None = None, requested_by: str = "", retry_of=None):
    """A run of automation `a` with one delivery per recipient (status pending). Raises IntegrityError when the
    scheduled slot already has its run."""
    from .models import AttendanceNotifyDelivery as D, AttendanceNotifyRun as R

    config = config_of(a)
    config["branchId"] = a.branch_id
    config["branchName"] = a.branch.name if a.branch_id and a.branch else ""
    today = ist_now().date()
    days = rpt.resolve_days(config, run_date if trigger == R.TRIGGER_SCHEDULE else today)
    with transaction.atomic():
        run = R.objects.create(
            automation=a,
            automation_name=a.name,
            channel=a.channel,
            trigger=trigger,
            slot=slot,
            run_date=run_date,
            report_from=days[0] if days else None,
            report_to=days[-1] if days else None,
            config=config,
            requested_by=requested_by,
            retry_of=retry_of,
        )
        for kind, recipient, label, *extra in recipients_of(config, a.branch_id):
            if kind == "email" and extra:  # the CC / BCC of the one email, kept with the run
                run.config = {**run.config, "emailCc": extra[0]["cc"], "emailBcc": extra[0]["bcc"]}
                run.save(update_fields=["config"])
            D.objects.create(run=run, kind=kind, recipient=recipient or "", label=label)
    return run


def running_run_for(automation_id: int):
    from .models import AttendanceNotifyRun as R

    now = timezone.now()
    for run in R.objects.filter(
        automation_id=automation_id, status=R.STATUS_RUNNING, started_at__gte=now - GIVE_UP_AFTER
    ):
        if run.heartbeat_at is None or now - run.heartbeat_at <= STALE_AFTER:
            return run
    return None


def retry_failed(run, requested_by: str = "") -> int:
    """Send the failed deliveries of `run` again (in the same run). Returns how many."""
    from .models import AttendanceNotifyDelivery as D, AttendanceNotifyRun as R

    with transaction.atomic():
        n = run.deliveries.filter(status=D.STATUS_FAILED).update(status=D.STATUS_PENDING, retry_at=None)
        if n:
            R.objects.filter(pk=run.pk).update(
                status=R.STATUS_RUNNING,
                claim_token="",
                heartbeat_at=None,
                finished_at=None,
                error="",
                requested_by=requested_by or run.requested_by,
            )
    if n:
        launch(run.pk)
    return n


# ─────────────────────────── background work ───────────────────────────


def sync_whatsapp(runs=None) -> int:
    """Bring "queued" WhatsApp deliveries up to date with their messages in the queue (sent / failed / skipped), and
    the status of their runs. Returns how many changed."""
    from .models import AttendanceNotifyDelivery as D, AttendanceNotifyRun as R, WhatsAppMessageLog as L

    qs = D.objects.filter(status=D.STATUS_QUEUED, run__channel="whatsapp")
    if runs is not None:
        qs = qs.filter(run__in=runs)
    changed = 0
    touched = set()
    for d in qs.select_related("run")[:500]:
        logs = list(L.objects.filter(pk__in=d.whatsapp_log_ids or []))
        status, note = whatsapp_outcome(logs)
        if status != d.status or note != d.note:
            d.status, d.note = status, note[:1000]
            d.save(update_fields=["status", "note", "updated_at"])
            changed += 1
            touched.add(d.run_id)
    for run in R.objects.filter(pk__in=touched).exclude(status=R.STATUS_RUNNING):
        status = finish_status(run.deliveries.all())
        if status != run.status:
            R.objects.filter(pk=run.pk).update(status=status)
    return changed


def retry_due(now=None) -> int:
    """Email / chat deliveries whose retry time has come: sent again, in their own run (taken over like a stale one)."""
    from .models import AttendanceNotifyDelivery as D, AttendanceNotifyRun as R

    now = now or timezone.now()
    run_ids = set(
        D.objects.filter(status=D.STATUS_FAILED, retry_at__lte=now, attempts__lt=MAX_ATTEMPTS)
        .exclude(run__status=R.STATUS_RUNNING)
        .values_list("run_id", flat=True)
    )
    for run_id in run_ids:
        D.objects.filter(run_id=run_id, status=D.STATUS_FAILED, retry_at__lte=now, attempts__lt=MAX_ATTEMPTS).update(
            status=D.STATUS_PENDING, retry_at=None
        )
        R.objects.filter(pk=run_id).update(status=R.STATUS_RUNNING, claim_token="", heartbeat_at=None, finished_at=None)
        process_run(run_id)
    return len(run_ids)


def resume_stale() -> list[int]:
    from .models import AttendanceNotifyRun as R

    now = timezone.now()
    taken = []
    for run in R.objects.filter(status=R.STATUS_RUNNING).order_by("id"):
        if run.heartbeat_at is not None and now - run.heartbeat_at <= STALE_AFTER:
            continue
        if run.heartbeat_at is None and now - run.started_at < UNCLAIMED_AFTER:
            continue
        if now - run.started_at > GIVE_UP_AFTER:
            fail_run(run.pk, "the server stopped before this run finished, and it is too late to send the rest")
            continue
        if process_run(run.pk) is not None:
            taken.append(run.pk)
    return taken


def run_scheduled(now: datetime | None = None) -> list[int]:
    """The 1-minute job: start (and send, in this thread) every due slot of every active automation, then retries,
    stale runs and the WhatsApp delivery statuses. `now` is naive IST (tests pass one)."""
    from .models import AttendanceNotifyAutomation as A, AttendanceNotifyRun as R

    now = now or ist_now()
    started = []
    for a in A.objects.filter(is_active=True).select_related("branch"):
        done = scheduled_done(a.pk, now.date() - timedelta(days=1))
        for day, slot in due_for(a, now, done):
            try:
                run = create_run(a, trigger=R.TRIGGER_SCHEDULE, run_date=day, slot=slot, requested_by="Scheduler")
            except IntegrityError:
                continue  # another worker started this slot
            started.append(run.pk)
            process_run(run.pk)
        if a.frequency == "once" and a.run_on and a.run_on < now.date() - timedelta(days=1):
            A.objects.filter(pk=a.pk).update(is_active=False)  # a one-off that has passed
    resume_stale()
    retry_due()
    sync_whatsapp()
    return started

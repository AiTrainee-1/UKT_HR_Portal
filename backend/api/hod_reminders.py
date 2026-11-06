"""
Reminders to Department Heads about the requests waiting for their approval (HR Requests page -> Notify).

    HR sets times of day (IST) and weekdays, the channels and the wording   -> HodReminderSettings (one row)
    a 1-minute job (hod_reminder_scheduler.py) starts a due slot            -> HodReminderRun, unique per (date, slot)
    or HR presses "Send now"                                                 -> HodReminderRun (manual)
    every head with a pending request gets ONE personalised message         -> HodReminderDelivery per head
        through WhatsApp   whatsapp_service.send_notification (type `hod_pending_reminder`, WhatsApp Control)
                email      email_service.send_email          (type `hod_pending_reminder`, Gmail Control)
                push       an in-app Notification (type + source `hod_pending_reminder`); signals.py pushes it

"Pending with a head" is the one rule of hod_pending.py (what that head's mobile Approvals tab counts as Pending).
Only heads with at least one pending request are reminded, and only while their own employee record is active.

Exactly once, whatever happens to the server:
  * a scheduled slot is a row unique per (run_date, slot) in the database, so two workers, or a restart inside the
    10-minute window, start it once;
  * a round is processed by whoever holds its `claim_token`; the holder beats `heartbeat_at` after every head, and the
    1-minute job takes over a round whose holder stopped (3 minutes without a beat), or gives it up after 30 minutes;
  * each delivery uses the key "hodrem:<run>:<manager>" for its WhatsApp message (unique in the WhatsApp log) and its
    notification (unique per employee), and a channel left "sending" by a holder that stopped is never retried;
  * the WhatsApp message is sent with announce=False: the phone notification of a reminder is the push channel's own
    Notification (with its own Mobile Messages switch), so a head gets ONE push per round, also while WhatsApp is off.

Every channel respects its own switches (WhatsApp Control, Gmail Control, Mobile Messages) and this machine's send guards
(WHATSAPP_ALLOW_SENDING / EMAIL_ALLOW_SENDING: a development machine sends nothing); a channel that cannot be used for a
head is "skipped" with a plain reason, never an error.

Sending is never done inside a web request (Railway runs one sync gunicorn worker with a 30-second limit): "Send now" only
creates the round and its deliveries; a background thread sends it, and the page polls the round.
"""

from __future__ import annotations

import logging
import re
import threading
import uuid
from dataclasses import dataclass
from datetime import date, datetime, time, timedelta

from django.db import IntegrityError, close_old_connections, connections, transaction
from django.db.models import Q
from django.utils import timezone

from .clock import FACTORY_TZ, ist_now
from .hod_pending import day_text
from .mobile_approvals_views import CATEGORIES

logger = logging.getLogger(__name__)

# The WhatsApp catalogue key, the email type and the Notification type/source of the reminder.
SOURCE = "hod_pending_reminder"
PUSH_TITLE = "Pending approvals"
EMAIL_SUBJECT = "Pending approvals awaiting you – UK Textiles HRMS"

DEFAULT_TEMPLATE = (
    "Dear {{name}},\n"
    "You currently have some pending requests awaiting your approval in the UK Textiles HRMS application.\n"
    "Pending requests:\n"
    "{{pendingList}}\n"
    "Kindly review and approve the pending requests at the earliest.\n"
    "Regards,\n"
    "HR Team – UKT"
)
PLACEHOLDERS = ("name", "pendingList", "total", "date")
TEMPLATE_MIN, TEMPLATE_MAX = 10, 2000
MAX_TIMES = 6
CHANNELS = ("whatsapp", "email", "push")
# A slot fires when IST now is within this many minutes after it (the job runs every minute).
WINDOW_MINUTES = 10
# A round whose holder has not beaten for this long is taken over by the 1-minute job ...
STALE_AFTER = timedelta(minutes=3)
# ... unless it is older than this: then the rest is given up (a reminder hours late helps nobody).
GIVE_UP_AFTER = timedelta(minutes=30)
# A manual round whose thread never started is taken over after this.
UNCLAIMED_AFTER = timedelta(minutes=1)
# WhatsApp failures in one round after which the rest of the round's WhatsApp messages are held back (the number's health).
MAX_WHATSAPP_FAILURES = 3
# The note on a delivery whose WhatsApp message is waiting in the queue (it leaves when the pacing allows, or expires at the
# end of the day: WhatsApp Control -> Messages shows which).
QUEUED_NOTE = "Queued for WhatsApp: sent within the day's sending limits (see WhatsApp Control -> Messages)"

_PLACEHOLDER = re.compile(r"\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}")
_TIME = re.compile(r"^(\d{1,2}):(\d{2})$")


# ─────────────────────────── wording (pure) ───────────────────────────


def line_label(label: str) -> str:
    """The pending-list words of a category: "Leave" -> "Leave Requests", "Resignations" -> "Resignation Requests"; a label
    that already ends in "Requests" stays as it is."""
    if label.endswith("Requests"):
        return label
    base = label[:-1] if label.endswith("s") else label
    return f"{base} Requests"


def pending_list(by_category: dict) -> str:
    """One line per category with a pending count above 0, in the Approvals tab's order: "• Leave Requests: 3"."""
    return "\n".join(
        f"• {line_label(cat.label)}: {by_category[cat.key]}" for cat in CATEGORIES if by_category.get(cat.key)
    )


def render(template: str, *, name: str, by_category: dict, day: date, total: int | None = None) -> str:
    """The message for one head: {{name}}, {{pendingList}}, {{total}} and {{date}} ("04 Nov 2026") filled in."""
    if total is None:
        total = sum(n for n in by_category.values() if n)
    values = {"name": name, "pendingList": pending_list(by_category), "total": str(total), "date": day_text(day)}
    text = _PLACEHOLDER.sub(lambda m: values.get(m.group(1), m.group(0)), (template or "").replace("\r\n", "\n"))
    return "\n".join(line.rstrip() for line in text.split("\n")).strip()


def template_problem(text) -> str | None:
    """Why HR's wording cannot be saved (one plain sentence), or None."""
    if not isinstance(text, str):
        return "The message must be text."
    body = text.strip()
    if len(body) < TEMPLATE_MIN:
        return f"The message is too short: write at least {TEMPLATE_MIN} characters."
    if len(body) > TEMPLATE_MAX:
        return f"The message is too long: keep it to {TEMPLATE_MAX:,} characters."
    names = _PLACEHOLDER.findall(body)
    if "pendingList" not in names:
        return "The message must contain {{pendingList}}, where the list of pending requests goes."
    unknown = [n for n in names if n not in PLACEHOLDERS]
    if unknown:
        return (
            f"Unknown placeholder {{{{{unknown[0]}}}}}. You can use {{{{name}}}}, {{{{pendingList}}}}, {{{{total}}}} "
            "and {{date}}."
        )
    return None


# ─────────────────────────── schedule (pure) ───────────────────────────


def parse_times(raw) -> tuple[list[str] | None, str | None]:
    """(["09:00", "16:30"], None) sorted, or (None, why not). Accepts "9:00" for "09:00"."""
    if not isinstance(raw, list):
        return None, 'Times must be a list such as ["10:00", "16:00"].'
    if not raw:
        return None, "Choose at least one time of day."
    if len(raw) > MAX_TIMES:
        return None, f"Choose at most {MAX_TIMES} times a day."
    out: list[str] = []
    for item in raw:
        m = _TIME.match(item.strip()) if isinstance(item, str) else None
        if not m or int(m.group(1)) > 23 or int(m.group(2)) > 59:
            return None, f"'{item}' is not a time of day: use HH:MM between 00:00 and 23:59."
        slot = f"{int(m.group(1)):02d}:{m.group(2)}"
        if slot in out:
            return None, f"{slot} is listed twice."
        out.append(slot)
    return sorted(out), None


def parse_days(raw) -> tuple[list[int] | None, str | None]:
    """([0, 1, 2], None) sorted (0 = Monday ... 6 = Sunday), or (None, why not)."""
    if not isinstance(raw, list):
        return None, "Days must be a list of weekday numbers (0 = Monday ... 6 = Sunday)."
    if not raw:
        return None, "Choose at least one day of the week."
    out: list[int] = []
    for item in raw:
        if isinstance(item, bool) or not isinstance(item, int) or not 0 <= item <= 6:
            return None, f"'{item}' is not a weekday: use 0 (Monday) to 6 (Sunday)."
        if item in out:
            return None, "A day is listed twice."
        out.append(item)
    return sorted(out), None


def parse_channels(raw, base: dict) -> tuple[dict | None, str | None]:
    """`base` with the channels in `raw` changed, or (None, why not). At least one channel must stay on."""
    if not isinstance(raw, dict):
        return None, 'Channels must be an object such as {"whatsapp": true, "email": true, "push": true}.'
    out = {ch: bool(base.get(ch)) for ch in CHANNELS}
    for key, value in raw.items():
        if key not in CHANNELS:
            return None, f"Unknown channel '{key}': use whatsapp, email or push."
        if not isinstance(value, bool):
            return None, f"The {key} channel must be true or false."
        out[key] = value
    if not any(out.values()):
        return None, "Keep at least one channel (WhatsApp, email or phone notification) on."
    return out, None


def _slot_at(day: date, slot: str) -> datetime | None:
    m = _TIME.match(slot or "")
    if not m or int(m.group(1)) > 23 or int(m.group(2)) > 59:
        return None
    return datetime.combine(day, time(int(m.group(1)), int(m.group(2))))


def due_slots(
    now: datetime, *, enabled: bool, times, days, done, window_minutes: int = WINDOW_MINUTES
) -> list[tuple[date, str]]:
    """The scheduled slots to start now: [(date, "HH:MM")]. `now` is naive IST wall-clock time.

    A slot is due when the schedule is enabled, its date is one of the chosen weekdays, now is within `window_minutes`
    after it (from the minute itself up to, not including, the minute the window ends) and (date, slot) is not in
    `done` (it already ran). Yesterday is looked at too, so a 23:55 slot still fires at 00:02."""
    if not enabled:
        return []
    window = timedelta(minutes=window_minutes)
    out = []
    for day in (now.date() - timedelta(days=1), now.date()):
        if day.weekday() not in days:
            continue
        for slot in times or ():
            at = _slot_at(day, slot)
            if at is not None and at <= now < at + window and (day, slot) not in done:
                out.append((day, slot))
    return sorted(out)


def next_run_at(
    now: datetime, *, enabled: bool, times, days, done, window_minutes: int = WINDOW_MINUTES
) -> datetime | None:
    """When the schedule fires next (naive IST): the first slot not yet run whose window has not passed (one that is due
    right now is returned as is: it fires within a minute). None when disabled or nothing is chosen."""
    if not enabled or not times or not days:
        return None
    window = timedelta(minutes=window_minutes)
    for offset in range(-1, 9):
        day = now.date() + timedelta(days=offset)
        if day.weekday() not in days:
            continue
        for slot in sorted(times):
            at = _slot_at(day, slot)
            if at is None or (day, slot) in done or at + window <= now:
                continue
            return at
    return None


# ─────────────────────────── settings ───────────────────────────


def template_of(s) -> str:
    return (s.template or "").strip() or DEFAULT_TEMPLATE


def channels_of(s) -> dict:
    return {"whatsapp": s.channel_whatsapp, "email": s.channel_email, "push": s.channel_push}


def scheduled_done(since: date) -> set[tuple[date, str]]:
    from .models import HodReminderRun

    return set(
        HodReminderRun.objects.filter(trigger=HodReminderRun.TRIGGER_SCHEDULE, run_date__gte=since).values_list(
            "run_date", "slot"
        )
    )


def next_run_for(s, now: datetime | None = None) -> datetime | None:
    """nextRunAt of the settings, aware (IST)."""
    now = now or ist_now()
    at = next_run_at(
        now,
        enabled=s.enabled,
        times=s.times,
        days=s.days,
        done=scheduled_done(now.date() - timedelta(days=1)) if s.enabled else set(),
    )
    return at.replace(tzinfo=FACTORY_TZ) if at else None


def channel_status() -> dict:
    """{channel: {available, note}}: whether each channel can deliver at all right now, and if not why (the page shows it
    next to each switch). A head without a phone / email / registered phone is reported per delivery instead."""
    from . import email_service, mobile_messages
    from . import whatsapp_service as wa
    from .models import MobileMessageSettings, PayrollSettings, WhatsAppMessageTemplate

    def state(problem: str | None, ready: str) -> dict:
        return {"available": problem is None, "note": problem or ready}

    if not wa.has_credentials():
        wa_problem = "WhatsApp is not set up on this server (the WAClient keys are missing)."
    elif not wa.sending_allowed():
        wa_problem = "WhatsApp sending is off on this machine (a development setup)."
    else:
        wa_problem = wa.switch_off_reason(SOURCE)
        if (
            wa_problem is None
            and WhatsAppMessageTemplate.objects.filter(document_type=SOURCE, is_enabled=False).exists()
        ):
            wa_problem = "This reminder is switched off on the WhatsApp Control page (Message Text)."

    ps = PayrollSettings.get()
    email_problem = email_service.switch_off_reason(SOURCE)
    if email_problem is None and email_service.smtp_missing_reason(ps):
        email_problem = "Email (SMTP) is not set up in Settings."
    if email_problem is None and not email_service.sending_allowed():
        email_problem = "Email sending is off on this machine (a development setup)."
    if email_problem is None:
        email_problem = email_service.daily_limit_reason()

    push_problem = None
    if not mobile_messages.push_allowed(SOURCE):
        push_problem = (
            "Phone notifications are switched off on Mobile App Login -> Mobile Messages."
            if not MobileMessageSettings.get().push_enabled
            else "This reminder's phone notification is switched off on Mobile App Login -> Mobile Messages."
        )
    return {
        "whatsapp": state(wa_problem, "Ready: sent from the company WhatsApp number."),
        "email": state(email_problem, "Ready: sent from the company Gmail account."),
        "push": state(
            push_problem,
            "Ready: reaches heads who signed in to the mobile app (it is also kept in the app's notifications).",
        ),
    }


# ─────────────────────────── who gets one ───────────────────────────


@dataclass
class Target:
    manager: object  # DepartmentManager (employee loaded)
    name: str
    by_category: dict
    total: int


def full_name(emp) -> str:
    return f"{emp.first_name} {emp.last_name}".strip()


def targets(*, manager_ids=None, branch_id: int | None = None) -> list[Target]:
    """The heads a reminder goes to right now: every ACTIVE Department Head whose employee record is active and who has at
    least one request pending with them (hod_pending.py), most pending first. `manager_ids` limits it to those heads;
    `branch_id` to one branch's heads and requests (the preview of a branch login)."""
    from .hod_pending import active_managers, collect

    managers = [m for m in active_managers(branch_id) if (m.employee.status or "active") == "active"]
    if manager_ids is not None:
        wanted = set(manager_ids)
        managers = [m for m in managers if m.id in wanted]
    pending = collect(managers, branch_id=branch_id)
    out = []
    for m in managers:
        hp = pending[m.id]
        if hp.total:
            out.append(Target(m, full_name(m.employee), hp.counts(), hp.total))
    out.sort(key=lambda t: (-t.total, t.name.casefold(), t.manager.id))
    return out


# ─────────────────────────── a round ───────────────────────────


def prepare(run):
    """Build the deliveries of a round once: each head with a pending request now, their figures and their text."""
    from .models import HodReminderDelivery, HodReminderRun

    with transaction.atomic():
        run = HodReminderRun.objects.select_for_update().get(pk=run.pk)
        if run.prepared:
            return run
        template = run.template or DEFAULT_TEMPLATE
        rows = []
        for t in targets(manager_ids=run.manager_ids):
            first = {
                ch: HodReminderDelivery.STATUS_PENDING if run.channels.get(ch) else HodReminderDelivery.STATUS_OFF
                for ch in CHANNELS
            }
            rows.append(
                HodReminderDelivery(
                    run=run,
                    manager=t.manager,
                    employee=t.manager.employee,
                    name=t.name,
                    pending=t.total,
                    by_category=t.by_category,
                    text=render(template, name=t.name, by_category=t.by_category, total=t.total, day=run.run_date),
                    whatsapp_status=first["whatsapp"],
                    email_status=first["email"],
                    push_status=first["push"],
                )
            )
        HodReminderDelivery.objects.bulk_create(rows)
        run.hods = len(rows)
        run.prepared = True
        run.save(update_fields=["hods", "prepared"])
    return run


@dataclass
class _RoundState:
    whatsapp_sent: int = 0
    whatsapp_failures: int = 0


def dedupe_key(run, delivery) -> str:
    return f"hodrem:{run.pk}:{delivery.manager_id or f'd{delivery.pk}'}"


def _send_push(run, d, emp, state: _RoundState) -> tuple[str, str]:
    """The in-app notification, which IS the phone push (signals.py; the Mobile Messages switches apply there)."""
    from .models import HodReminderDelivery as D, Notification

    key = dedupe_key(run, d)
    try:
        with transaction.atomic():
            note = Notification.objects.create(
                employee=emp, type=SOURCE, title=PUSH_TITLE, message=d.text, source=SOURCE, dedupe_key=key
            )
    except IntegrityError:
        note = Notification.objects.filter(employee=emp, dedupe_key=key).first()
        if note is None:
            return D.STATUS_FAILED, "The notification could not be saved."
    note.refresh_from_db(fields=["push_status", "push_error"])
    if note.push_status in ("sent", "delivered"):
        return D.STATUS_SENT, ""
    if note.push_status == "no_device":
        return D.STATUS_SKIPPED, "No phone registered for notifications (it is in the app's notifications list)."
    if note.push_status == "off":
        return (
            D.STATUS_SKIPPED,
            "Phone notifications for this reminder are switched off (Mobile App Login -> Mobile Messages).",
        )
    if note.push_status == "failed":
        return D.STATUS_FAILED, note.push_error or "The phone notification could not be sent."
    return D.STATUS_FAILED, "Not known: the phone notification was not tried."


def _send_email(run, d, emp, state: _RoundState) -> tuple[str, str]:
    from . import email_service
    from .models import HodReminderDelivery as D
    from .user_settings import settings_for_employee

    to = (emp.email or "").strip()
    if not to:
        return D.STATUS_SKIPPED, "No email address"
    if not email_service._ADDRESS.fullmatch(to):
        return D.STATUS_SKIPPED, f"'{to}' is not a valid email address"
    off = email_service.switch_off_reason(SOURCE)
    if off:
        return D.STATUS_SKIPPED, off
    ps = settings_for_employee(emp)
    if email_service.smtp_missing_reason(ps):
        return D.STATUS_SKIPPED, "Email (SMTP) not set up"
    if not email_service.sending_allowed():
        return D.STATUS_SKIPPED, "Email sending is off on this machine (a development setup)"
    limit = email_service.daily_limit_reason()
    if limit:
        return D.STATUS_SKIPPED, limit
    log = email_service.send_email(
        SOURCE,
        to_email=to,
        params={"message": d.text, "employee_name": d.name, "total": d.pending, "date": day_text(run.run_date)},
        ps=ps,
        recipient_name=d.name,
        employee=emp,
        ref_id=run.pk,
        automatic=True,
    )
    if log is None:
        return D.STATUS_SKIPPED, "Not sent: email is switched off or not set up"
    if log.status == email_service.EMAIL_SENT:
        return D.STATUS_SENT, ""
    if log.status == email_service.EMAIL_BLOCKED:
        return D.STATUS_SKIPPED, log.error_message
    return D.STATUS_FAILED, log.error_message or "The email could not be sent."


def _send_whatsapp(run, d, emp, state: _RoundState) -> tuple[str, str]:
    from . import whatsapp_service as wa
    from .models import HodReminderDelivery as D, WhatsAppMessageLog, WhatsAppMessageTemplate

    if not wa.has_credentials():
        return D.STATUS_SKIPPED, "WhatsApp not set up"
    if not wa.sending_allowed():
        return D.STATUS_SKIPPED, "WhatsApp sending is off on this machine (a development setup)"
    off = wa.switch_off_reason(SOURCE)
    if off:
        return D.STATUS_SKIPPED, off
    if WhatsAppMessageTemplate.objects.filter(document_type=SOURCE, is_enabled=False).exists():
        return D.STATUS_SKIPPED, "This reminder is switched off on the WhatsApp Control page (Message Text)"
    if not wa.normalize_phone(emp.phone):
        return D.STATUS_SKIPPED, "No phone number"
    if state.whatsapp_failures >= MAX_WHATSAPP_FAILURES:
        return D.STATUS_SKIPPED, f"Held back: WhatsApp failed {MAX_WHATSAPP_FAILURES} times in this round"
    key = dedupe_key(run, d)
    # Queued, not sent from here: the WhatsApp dispatcher paces every message the number sends (whatsapp_dispatcher.py).
    log = wa.send_notification(
        emp,
        SOURCE,
        {"message": d.text, "name": d.name, "total": d.pending, "date": day_text(run.run_date)},
        dedupe_key=key,
        document_ref_id=run.pk,
        # its phone notification is the push channel's own (one push per round, and the push switch works alone)
        announce=False,
    )
    if log is None:  # this round already queued it (the key is taken), or a switch changed a moment ago
        log = WhatsAppMessageLog.objects.filter(dedupe_key=key).first()
        if log is None:
            return D.STATUS_SKIPPED, "Not sent: WhatsApp is switched off or not set up"
    if log.status in (WhatsAppMessageLog.STATUS_FAILED, WhatsAppMessageLog.STATUS_EXPIRED):
        state.whatsapp_failures += 1
        return D.STATUS_FAILED, log.error_message or "WhatsApp did not accept the message."
    if log.status == WhatsAppMessageLog.STATUS_SKIPPED:
        return D.STATUS_SKIPPED, log.error_message or "Not sent"
    state.whatsapp_sent += 1
    if log.status in (WhatsAppMessageLog.STATUS_QUEUED, WhatsAppMessageLog.STATUS_SENDING):
        return D.STATUS_SENT, QUEUED_NOTE
    return D.STATUS_SENT, ""


# The order a head's channels are tried: the quick, local ones first; WhatsApp last (it is queued and paced).
SENDERS = (("push", _send_push), ("email", _send_email), ("whatsapp", _send_whatsapp))


def _set(d, channel: str, status: str, note: str) -> None:
    setattr(d, f"{channel}_status", status)
    setattr(d, f"{channel}_note", (note or "")[:500])
    d.save(update_fields=[f"{channel}_status", f"{channel}_note", "updated_at"])


def _deliver(run, d, state: _RoundState) -> None:
    from .models import HodReminderDelivery as D

    for channel, send in SENDERS:
        if getattr(d, f"{channel}_status") != D.STATUS_PENDING:
            continue
        emp = d.employee
        if emp is None:
            _set(d, channel, D.STATUS_SKIPPED, "The Department Head's employee record no longer exists")
            continue
        _set(d, channel, D.STATUS_SENDING, "")
        try:
            status, note = send(run, d, emp, state)
        except Exception as exc:  # one head's channel must never stop the round
            logger.exception("HoD reminder %s to %s by %s failed", run.pk, d.name, channel)
            status, note = D.STATUS_FAILED, f"Unexpected error: {exc}"
        _set(d, channel, status, note)


def _beat(run_id: int, token: str) -> bool:
    """Still the holder of this round? (and say so). False: another processor took it over."""
    from .models import HodReminderRun

    return (
        HodReminderRun.objects.filter(pk=run_id, claim_token=token, status=HodReminderRun.STATUS_RUNNING).update(
            heartbeat_at=timezone.now()
        )
        == 1
    )


def fail_run(run_id: int, error: str, token: str | None = None) -> None:
    """End a round as failed: whatever was still to send is marked failed with the reason."""
    from .models import HodReminderDelivery as D, HodReminderRun

    qs = HodReminderRun.objects.filter(pk=run_id, status=HodReminderRun.STATUS_RUNNING)
    if token is not None:
        qs = qs.filter(claim_token=token)
    if not qs.update(status=HodReminderRun.STATUS_FAILED, error=error[:1000], finished_at=timezone.now()):
        return
    for ch in CHANNELS:
        D.objects.filter(run_id=run_id, **{f"{ch}_status__in": (D.STATUS_PENDING, D.STATUS_SENDING)}).update(
            **{f"{ch}_status": D.STATUS_FAILED, f"{ch}_note": f"Not sent: {error}"[:500]}
        )


def process_run(run_id: int) -> str | None:
    """Send a round's reminders (in the calling thread). Returns the round's final status, or None when another processor
    holds it (or it is not running any more)."""
    from . import approval_workflow as approval
    from .models import HodReminderDelivery as D, HodReminderRun

    approval.clear_cache()  # the pipeline cache lives per thread and is only cleared per web request
    token = uuid.uuid4().hex
    now = timezone.now()
    claimed = (
        HodReminderRun.objects.filter(pk=run_id, status=HodReminderRun.STATUS_RUNNING)
        .filter(Q(claim_token="") | Q(heartbeat_at__isnull=True) | Q(heartbeat_at__lt=now - STALE_AFTER))
        .update(claim_token=token, heartbeat_at=now)
    )
    if not claimed:
        return None
    try:
        run = prepare(HodReminderRun.objects.get(pk=run_id))
        # A channel a stopped holder left "sending" may or may not have gone out: never send it a second time.
        for ch in CHANNELS:
            run.deliveries.filter(**{f"{ch}_status": D.STATUS_SENDING}).update(
                **{
                    f"{ch}_status": D.STATUS_FAILED,
                    f"{ch}_note": "Not known: the server stopped while this was being sent, so it was not tried again.",
                }
            )
        state = _RoundState()
        for d in run.deliveries.select_related("employee").order_by("id"):
            if not _beat(run_id, token):
                return None
            _deliver(run, d, state)
        finished = HodReminderRun.objects.filter(pk=run_id, claim_token=token, status=HodReminderRun.STATUS_RUNNING)
        if not finished.update(status=HodReminderRun.STATUS_DONE, finished_at=timezone.now()):
            return None
        return HodReminderRun.STATUS_DONE
    except Exception as exc:
        logger.exception("HoD reminder round %s failed", run_id)
        fail_run(run_id, f"{type(exc).__name__}: {exc}", token)
        return HodReminderRun.STATUS_FAILED


def launch(run_id: int) -> None:
    """Send a manual round on a background thread once the current transaction has committed (never inside the request).
    If the thread never runs (the worker restarts), the 1-minute job takes the round over (resume_stale)."""

    def runner() -> None:
        try:
            close_old_connections()
            process_run(run_id)
        except Exception:
            logger.exception("HoD reminder round %s could not be processed", run_id)
        finally:
            connections.close_all()  # this thread's own connection

    transaction.on_commit(lambda: threading.Thread(target=runner, name=f"hod-reminders-{run_id}", daemon=True).start())


def running_round():
    """A round still being sent (its holder is alive or it was just created), or None."""
    from .models import HodReminderRun

    now = timezone.now()
    for run in HodReminderRun.objects.filter(status=HodReminderRun.STATUS_RUNNING, started_at__gte=now - GIVE_UP_AFTER):
        if run.heartbeat_at is None or now - run.heartbeat_at <= STALE_AFTER:
            return run
    return None


def resume_stale() -> list[int]:
    """Take over the rounds whose processor stopped (a restart, a thread that never started); give up the ones too old to
    still be useful. Returns the ids taken over."""
    from .models import HodReminderRun

    now = timezone.now()
    taken = []
    for run in HodReminderRun.objects.filter(status=HodReminderRun.STATUS_RUNNING).order_by("id"):
        if run.heartbeat_at is not None and now - run.heartbeat_at <= STALE_AFTER:
            continue  # its holder is alive
        if run.heartbeat_at is None and now - run.started_at < UNCLAIMED_AFTER:
            continue  # just created: its thread is about to start
        if now - run.started_at > GIVE_UP_AFTER:
            fail_run(run.pk, "the server stopped before this round finished, and it is too late to send the rest")
            continue
        if process_run(run.pk) is not None:
            taken.append(run.pk)
    return taken


def run_scheduled(now: datetime | None = None) -> list[int]:
    """The 1-minute job: start (and send, in this thread) every scheduled slot that is due, then take over any round whose
    processor stopped. Returns the ids of the rounds started. `now` is naive IST (tests pass one)."""
    from . import approval_workflow as approval
    from .models import HodReminderRun, HodReminderSettings

    approval.clear_cache()
    now = now or ist_now()
    s = HodReminderSettings.get()
    started = []
    if s.enabled:
        done = scheduled_done(now.date() - timedelta(days=1))
        for day, slot in due_slots(now, enabled=s.enabled, times=s.times, days=s.days, done=done):
            try:
                with transaction.atomic():
                    run = HodReminderRun.objects.create(
                        trigger=HodReminderRun.TRIGGER_SCHEDULE,
                        slot=slot,
                        run_date=day,
                        channels=channels_of(s),
                        template=template_of(s),
                    )
            except IntegrityError:
                continue  # another worker started this slot
            started.append(run.pk)
            process_run(run.pk)
    resume_stale()
    return started

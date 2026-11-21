"""Automatic On-Duty tracking alerts (owner brief 2026-11-21).

While an On-Duty track records, the geo-tracking watchdog (watchdog.run_watchdog, every 2 minutes) calls run_alerts(). It
looks at every recording track (and at the tracks the employee marked Done today) and finds six kinds of problem:

  location_off           the phone's location is off: an open GPS_OFF event on the track, or the phone's health block says
                         location is disabled
  permission_restricted  the app's location permission on the phone this track uses is not "always" (while_using / denied)
  background_restricted  the phone restricts the app in the background (background_restricted, or battery_optimised)
  tracking_failure       the phone has sent nothing for the signal-lost time: the watchdog's open SIGNAL_LOST event
  missing_punch          key "first": no punch at all `missing_first_punch_minutes` after the track started;
                         key "day": fewer than the day's 4 punches (and at least one) when the employee marks the duty Done,
                         or at `punch_check_time` (IST) while a duty begun before it still records. A Done day with no punch
                         at all counts too when the employee was never alerted about the first punch.
  punch_reminder         no punch for `punch_reminder_minutes` while on duty (counted from the day's last punch, or the track's
                         start when that is later), a punch of the day still free, and no Missing Geo-Punch alert open:
                         ONE reminder per wait (the wait is its key), to the employee only

Each problem is an EPISODE (models.GeoTrackingAlert, also the log HR reads on Geo Attendance):
  1. first seen -> the episode row. detected_at = when it really began where the data says so (the GPS-off event, the end of
     the silence, the end of the punch wait), else now. One OPEN episode per (track, kind, key): a partial unique index, so
     two runs (or two processes) can never open two.
  2. employee stage: at detected_at + alert_debounce_minutes for the three phone-state kinds (a 30-second blip never alerts),
     at once for the others (their own wait is the debounce). Claimed by a conditional UPDATE: exactly once.
  3. Department Head stage: alert_hod_grace_minutes after the employee stage, when the problem is still there (never for a
     reminder, only while alert_hod_enabled). The head is the employee's ONE active Department Head allowed to approve
     On-Duty requests (hod_scope.managers_to_notify), never the employee themselves. Also claimed exactly once.
  4. the problem clears -> resolved "fixed"; an episode never alerted (it cleared during the debounce) is deleted instead.
     The track ends -> resolved "track_ended", except a "day" Missing Geo-Punch, which stays open until the day has its 4
     punches ("fixed") or the day is over ("day_over").
  5. the same phone-state problem again within alert_cooldown_minutes of its end reopens that episode (no second alert);
     later it is a new episode. A missing-punch / reminder key is used once per track.

Channels. Each stage is handed to BOTH channels at this one call site, and each decides with its OWN settings only:
  phone      Phone Notify Control: its master switch and the kind's switch (mobile_messages.TRACKING_ALERT_TYPES), its
             recipients (push_recipients: an excluded employee gets nothing), its wording (push_templates.apply) and the
             per-employee mute (push_delivery, at push time). The row is a Notification (type "on_duty", source = the kind,
             dedupe "geoalert:<alert>:<stage>:<session>"; notification_targets opens the On-Duty screen, or Approvals ->
             On-Duty for the Department Head).
  WhatsApp   WhatsApp Control: the engine, the kind's own switch (one per kind, OFF until HR turns it on), its Meta
             templates (hrms_<kind>, hrms_<kind>_hod), the send queue (quiet hours, caps, opt-out) and this machine's
             recipient lock (WHATSAPP_ONLY_TO_EMPLOYEES on a development machine).
A kind neither channel would carry is not tracked at all (no episode, nothing in the log). The timing is Geo Attendance ->
Settings (GeoTrackingSettings): when a problem counts is a rule of geo tracking, never a channel's setting.
"""

from __future__ import annotations

import logging
from collections import Counter
from dataclasses import dataclass, field
from datetime import date, datetime, time, timedelta
from typing import NamedTuple

from django.db import IntegrityError, transaction
from django.db.models import Max
from django.utils import timezone

from ..clock import FACTORY_TZ
from ..models import (
    AttendanceLog,
    DutyTrack,
    DutyTrackEvent,
    Employee,
    GeoTrackingAlert,
    GeoTrackingSettings,
    Notification,
    OnDutyPunchVerification,
    TrackingDevice,
)
from ..whatsapp_format import date_str, duration_str, flat, full_name, time_str

logger = logging.getLogger(__name__)

A = GeoTrackingAlert
REQUIRED_PUNCHES = 4  # the On-Duty day's punch slots (geo_attendance_views.ON_DUTY_SLOTS); the 4th ends the track
KEY_FIRST = "first"
KEY_DAY = "day"
PREFIX = "geoalert"
EMPLOYEE, HOD = "employee", "hod"


class Kind(NamedTuple):
    source: str  # the phone kind (Phone Notify Control switch, Notification.source)
    whatsapp: str  # the WhatsApp catalog type to the employee (its switch covers the head's copy too)
    whatsapp_hod: str  # the catalog type to the Department Head ("" = never escalated)
    debounced: bool  # the employee stage waits alert_debounce_minutes after detection


KINDS: dict[str, Kind] = {
    A.KIND_LOCATION_OFF: Kind("geo_location_off", "geo_location_off", "geo_location_off_hod", True),
    A.KIND_PERMISSION: Kind(
        "geo_permission_restricted", "geo_permission_restricted", "geo_permission_restricted_hod", True
    ),
    A.KIND_BACKGROUND: Kind(
        "geo_background_restricted", "geo_background_restricted", "geo_background_restricted_hod", True
    ),
    A.KIND_TRACKING_FAILURE: Kind("geo_tracking_failure", "geo_tracking_failure", "geo_tracking_failure_hod", False),
    A.KIND_MISSING_PUNCH: Kind("geo_missing_punch", "geo_missing_punch", "geo_missing_punch_hod", False),
    A.KIND_PUNCH_REMINDER: Kind("geo_punch_reminder", "geo_punch_reminder", "", False),
}
KIND_LABELS = dict(A.KIND_CHOICES)
#: kinds whose episodes are keyed by what they are about and never repeat on a track (no cooldown reopening)
ONCE_PER_KEY = frozenset({A.KIND_MISSING_PUNCH, A.KIND_PUNCH_REMINDER})

PERMISSION_WORDS = {"while_using": "Only while using the app", "denied": "Denied", "unknown": "Unknown"}

# ── channel outcomes (stored on the episode; the log shows the words) ────────────────────────────────────────────────
OUT_MADE = "made"
OUT_QUEUED = "queued"
OUT_OFF = "off"
OUT_MASTER_OFF = "master_off"
OUT_NOT_RECIPIENT = "not_recipient"
OUT_NOT_CONFIGURED = "not_configured"
OUT_NOT_SENT = "not_sent"
OUT_DUPLICATE = "duplicate"
OUT_NO_HEAD = "no_head"
OUT_ERROR = "error"
OUTCOME_LABELS = {
    OUT_MADE: "Notification made",
    OUT_QUEUED: "Queued",
    OUT_OFF: "Switched off",
    OUT_MASTER_OFF: "All phone notifications off",
    OUT_NOT_RECIPIENT: "Not a phone notification recipient",
    OUT_NOT_CONFIGURED: "WhatsApp not configured on this server",
    OUT_NOT_SENT: "Not sent",
    OUT_DUPLICATE: "Already sent",
    OUT_NO_HEAD: "No Department Head to tell",
    OUT_ERROR: "Could not be sent (see the server log)",
}


# ── the facts of one track ───────────────────────────────────────────────────────────────────────────────────────────


@dataclass
class Facts:
    track: DutyTrack
    today: date
    now: datetime
    device: TrackingDevice | None = None
    gps_off_since: datetime | None = None
    signal_lost: DutyTrackEvent | None = None
    punches: int = 0
    last_punch_at: datetime | None = None
    #: the "first" Missing Geo-Punch episode of this track, if one was ever opened (and whether the employee was told)
    first_alerted: bool = False
    first_exists: bool = False


@dataclass
class Found:
    kind: str
    key: str
    detected_at: datetime | None
    detail: dict = field(default_factory=dict)


def local_today(now: datetime) -> date:
    return now.astimezone(FACTORY_TZ).date()


def _at(day: date, t: time) -> datetime:
    """An IST wall-clock time of `day` as an aware instant."""
    return datetime.combine(day, t.replace(tzinfo=None), tzinfo=FACTORY_TZ)


def _device(track: DutyTrack) -> TrackingDevice | None:
    """The phone this track records from: the one that sent its last fix, else the employee's phone seen most recently since
    the track started. A phone not heard from during the track says nothing about it (its health is older)."""
    qs = TrackingDevice.objects.filter(employee_id=track.employee_id, last_seen_at__gte=track.started_at)
    if track.last_device_id:
        found = qs.filter(device_id=track.last_device_id).first()
        if found is not None:
            return found
    return qs.order_by("-last_seen_at").first()


def _punches(employee: Employee, day: date) -> tuple[int, datetime | None]:
    """(punch slots taken today, the latest punch of today as an instant): every source counts, an On-Duty punch still
    waiting for HR included (geo_attendance_views._taken_slots, the rule the On-Duty screen itself follows)."""
    from ..geo_attendance_views import _taken_slots

    taken = len(_taken_slots(employee, day))
    latest = [
        AttendanceLog.objects.filter(employee=employee, date=day).aggregate(t=Max("punch_time"))["t"],
        OnDutyPunchVerification.objects.filter(
            employee=employee,
            punch_date=day,
            status__in=(OnDutyPunchVerification.STATUS_PENDING, OnDutyPunchVerification.STATUS_APPROVED),
        ).aggregate(t=Max("punch_time"))["t"],
    ]
    times = [t for t in latest if t is not None]
    return taken, (_at(day, max(times)) if times else None)


def gather(track: DutyTrack, now: datetime) -> Facts:
    today = local_today(now)
    facts = Facts(track=track, today=today, now=now)
    if track.status == DutyTrack.STATUS_ACTIVE:
        facts.device = _device(track)
        gps_off = (
            DutyTrackEvent.objects.filter(track=track, kind=DutyTrackEvent.KIND_GPS_OFF, ended_at__isnull=True)
            .order_by("started_at")
            .first()
        )
        facts.gps_off_since = gps_off.started_at if gps_off else None
        facts.signal_lost = (
            DutyTrackEvent.objects.filter(track=track, kind=DutyTrackEvent.KIND_SIGNAL_LOST, ended_at__isnull=True)
            .order_by("-started_at")
            .first()
        )
    facts.punches, facts.last_punch_at = _punches(track.employee, today)
    first = A.objects.filter(track=track, kind=A.KIND_MISSING_PUNCH, key=KEY_FIRST).first()
    facts.first_exists = first is not None
    facts.first_alerted = bool(first and first.employee_sent_at)
    return facts


def _iso(dt: datetime | None) -> str | None:
    return dt.isoformat() if dt else None


def _signal_lost_at(event: DutyTrackEvent) -> datetime:
    """When the watchdog decided the phone was silent (its meta.detectedAt), else when the event was written."""
    raw = (event.meta or {}).get("detectedAt")
    if isinstance(raw, str):
        try:
            parsed = datetime.fromisoformat(raw)
            if parsed.tzinfo is not None:
                return parsed
        except ValueError:
            pass
    return event.created_at


def restriction_words(background_restricted: bool, battery_optimised: bool) -> str:
    parts = []
    if background_restricted:
        parts.append("background use is restricted")
    if battery_optimised:
        parts.append("battery optimisation is on")
    return " and ".join(parts)


def detect(facts: Facts, s: GeoTrackingSettings) -> list[Found]:
    """Every problem true right now on this track (pure: the facts and the settings only)."""
    track, now, dev = facts.track, facts.now, facts.device
    active = track.status == DutyTrack.STATUS_ACTIVE
    out: list[Found] = []
    if active:
        if facts.gps_off_since is not None or (dev is not None and dev.location_enabled is False):
            out.append(
                Found(
                    A.KIND_LOCATION_OFF,
                    "",
                    facts.gps_off_since,
                    {"since": _iso(facts.gps_off_since), "seenBy": "event" if facts.gps_off_since else "health"},
                )
            )
        if dev is not None and dev.permission_level in ("while_using", "denied"):
            out.append(Found(A.KIND_PERMISSION, "", None, {"permission": dev.permission_level}))
        if dev is not None and (dev.background_restricted or dev.battery_optimised):
            out.append(
                Found(
                    A.KIND_BACKGROUND,
                    "",
                    None,
                    {
                        "backgroundRestricted": bool(dev.background_restricted),
                        "batteryOptimised": bool(dev.battery_optimised),
                    },
                )
            )
        if facts.signal_lost is not None:
            out.append(
                Found(
                    A.KIND_TRACKING_FAILURE,
                    "",
                    _signal_lost_at(facts.signal_lost),
                    {"lastHeard": _iso(facts.signal_lost.started_at)},
                )
            )
        first_due = track.started_at + timedelta(minutes=s.missing_first_punch_minutes)
        if facts.punches == 0 and now >= first_due:
            out.append(
                Found(A.KIND_MISSING_PUNCH, KEY_FIRST, first_due, {"punches": 0, "startedAt": _iso(track.started_at)})
            )

    # the day's punches: when the employee marks the duty Done, or at the check time while a duty begun before it records
    check_at = _at(facts.today, s.punch_check_time)
    day_due = None
    if facts.punches < REQUIRED_PUNCHES:
        if active and 0 < facts.punches and now >= check_at and track.started_at < check_at:
            day_due = check_at
        elif (
            track.status == DutyTrack.STATUS_ENDED
            and track.end_reason == DutyTrack.END_MANUAL
            and track.ended_at is not None
            and local_today(track.ended_at) == facts.today
            and (facts.punches > 0 or not facts.first_alerted)
        ):
            day_due = track.ended_at
    if day_due is not None:
        out.append(
            Found(
                A.KIND_MISSING_PUNCH,
                KEY_DAY,
                day_due,
                {"punches": facts.punches, "date": facts.today.isoformat(), "doneAt": _iso(track.ended_at)},
            )
        )

    # one friendly reminder per wait without a punch (not while a Missing Geo-Punch alert speaks for it)
    missing_open = any(f.kind == A.KIND_MISSING_PUNCH for f in out)
    if active and not missing_open and facts.punches < REQUIRED_PUNCHES:
        anchor = track.started_at
        anchor_from = "start"
        if facts.last_punch_at is not None and facts.last_punch_at > anchor:
            anchor, anchor_from = facts.last_punch_at, "punch"
        due = anchor + timedelta(minutes=s.punch_reminder_minutes)
        if now >= due:
            key = anchor.astimezone(FACTORY_TZ).strftime("%Y-%m-%dT%H:%M")
            out.append(
                Found(
                    A.KIND_PUNCH_REMINDER,
                    key,
                    due,
                    {"anchor": _iso(anchor), "anchorFrom": anchor_from, "punches": facts.punches},
                )
            )
    return out


# ── what each channel would carry ────────────────────────────────────────────────────────────────────────────────────


def wanted_kinds() -> dict[str, bool]:
    """{kind: would at least one channel carry it}. Each channel answers from its own settings: Phone Notify Control's master
    + kind switch; WhatsApp Control's engine + kind switch, on a server where WhatsApp can send. Never raises (an unreadable
    channel is one that would not carry it)."""
    from .. import mobile_messages, whatsapp_service

    master, off = mobile_messages.switches()
    try:
        from ..models import WhatsAppSettings

        wa_row = WhatsAppSettings.get()
        wa_ready = whatsapp_service.is_configured()
    except Exception:
        logger.warning("Could not read WhatsApp Control's settings for the tracking alerts", exc_info=True)
        wa_row, wa_ready = None, False
    out = {}
    for kind, k in KINDS.items():
        phone = master and k.source not in off
        wa = bool(
            wa_ready and wa_row is not None and whatsapp_service.switch_off_reason(k.whatsapp, "", wa_row) is None
        )
        out[kind] = phone or wa
    return out


# ── the words ────────────────────────────────────────────────────────────────────────────────────────────────────────


@dataclass
class Words:
    title: str
    message: str
    #: the placeholders HR's phone wording may use (push_templates.APP_SPECS of the kind)
    push: dict
    #: the WhatsApp template's variables
    whatsapp: dict


def _done_word(n: int) -> str:
    if n <= 0:
        return "no punch of the day is recorded"
    return f"only {n} of the day's {REQUIRED_PUNCHES} punches {'is' if n == 1 else 'are'} recorded"


def words(alert: GeoTrackingAlert, stage: str, facts: Facts, head: Employee | None = None) -> Words:
    """The built-in title and sentence for whoever receives this stage, and each channel's variables."""
    track, emp = facts.track, facts.track.employee
    name, code = full_name(emp), emp.employee_code or ""
    destination = (getattr(track.session, "destination", "") or "").strip()[:80] or "On-Duty"
    detail = alert.detail or {}
    since_dt = alert.detected_at
    since = time_str(since_dt)
    alerted = time_str(alert.employee_sent_at) if alert.employee_sent_at else ""
    to_head = stage == HOD
    head_name = full_name(head) if head is not None else ""
    common = {
        "employee_name": name,
        "employee_code": code,
        "recipient": "Department Head" if to_head else "employee",
        "recipient_name": head_name if to_head else name,
        "destination": destination,
    }
    who = f"{name} ({code})" if code else name

    kind = alert.kind
    if kind == A.KIND_LOCATION_OFF:
        if to_head:
            title = f"On-Duty: {name}'s location is off"
            message = (
                f"The phone location of {who} has been off since {since} during On-Duty ({destination}). They were "
                f"alerted at {alerted} and have not turned it back on yet."
            )
        else:
            title = "Location is turned off"
            message = (
                f"Your phone's location was turned off at {since} while you are On-Duty ({destination}). Please turn "
                "Location back on so that your On-Duty route is recorded."
            )
        extra = {"since": since}
        wa = {"since": since, "date": date_str(facts.today)}
    elif kind == A.KIND_PERMISSION:
        level = PERMISSION_WORDS.get(detail.get("permission", ""), detail.get("permission", "") or "Unknown")
        if facts.device is not None and facts.device.permission_level in PERMISSION_WORDS:
            level = PERMISSION_WORDS[facts.device.permission_level]
        if to_head:
            title = f"On-Duty: {name}'s location permission"
            message = (
                f"The UK Textiles app on the phone of {who} has the location permission '{level}' instead of 'Allow all "
                f"the time' since {since}, so their On-Duty route is not fully recorded. They were alerted at {alerted}."
            )
        else:
            title = "Allow location all the time"
            message = (
                f"The UK Textiles app's location permission is '{level}', so your On-Duty route cannot be recorded in the "
                "background. Open Settings > Apps > UK Textiles > Permissions > Location and choose 'Allow all the time'."
            )
        extra = {"permission": level, "since": since}
        wa = {"permission": level, "since": since}
    elif kind == A.KIND_BACKGROUND:
        dev = facts.device
        restriction = (
            restriction_words(bool(dev.background_restricted), bool(dev.battery_optimised))
            if dev is not None and (dev.background_restricted or dev.battery_optimised)
            else restriction_words(bool(detail.get("backgroundRestricted")), bool(detail.get("batteryOptimised")))
        ) or "background use is restricted"
        if to_head:
            title = f"On-Duty: {name}'s app is restricted"
            message = (
                f"The phone of {who} has been limiting the UK Textiles app in the background ({restriction}) since "
                f"{since}, so their On-Duty route may not be recorded. They were alerted at {alerted}."
            )
        else:
            title = "Let the app run in the background"
            message = (
                f"Your phone is limiting the UK Textiles app in the background ({restriction}), so your On-Duty route may "
                "stop recording. Open Settings > Apps > UK Textiles > Battery and choose 'Unrestricted'."
            )
        extra = {"restriction": restriction, "since": since}
        wa = {"restriction": restriction, "since": since}
    elif kind == A.KIND_TRACKING_FAILURE:
        heard_raw = detail.get("lastHeard")
        heard_dt = datetime.fromisoformat(heard_raw) if isinstance(heard_raw, str) else None
        heard = time_str(heard_dt) if heard_dt else since
        if heard_dt and local_today(heard_dt) != facts.today:
            heard = f"{date_str(heard_dt)}, {heard}"
        if to_head:
            title = f"On-Duty: no location from {name}"
            message = (
                f"No On-Duty location has been received from {who} since {heard}. The app may have been closed, or the "
                f"phone is off or offline. They were alerted at {alerted}."
            )
        else:
            title = "On-Duty tracking stopped"
            message = (
                f"We have not received your On-Duty location since {heard}. Please open the UK Textiles app, stay signed "
                "in, and check that Location and mobile data are on."
            )
        extra = {"last_heard": heard}
        wa = {"last_heard": heard}
    elif kind == A.KIND_MISSING_PUNCH:
        n = facts.punches
        if alert.key == KEY_FIRST:
            status = f"no Geo-Punch recorded since the On-Duty started at {time_str(track.started_at)}"
        else:
            status = _done_word(n)
        day_text = date_str(facts.today)
        if to_head:
            title = f"On-Duty: {name}'s Geo-Punch is missing"
            message = f"On-Duty punch check for {who} on {day_text}: {status}. They were alerted at {alerted}."
        else:
            title = "Geo-Punch missing"
            message = (
                f"On-Duty punch check for {day_text}: {status}. Please record the missing Geo-Punch in the app, or raise "
                "a Missing Punch request if your duty has ended."
            )
        extra = {"punch_status": status, "punches": f"{n} of {REQUIRED_PUNCHES}", "date": day_text}
        wa = {"punch_status": status, "date": day_text}
    else:  # the reminder (the employee only)
        anchor_raw = detail.get("anchor")
        anchor = datetime.fromisoformat(anchor_raw) if isinstance(anchor_raw, str) else track.started_at
        waited = duration_str((facts.now - anchor).total_seconds())
        since_text = (
            f"your punch at {time_str(anchor)}"
            if detail.get("anchorFrom") == "punch"
            else f"your On-Duty started at {time_str(anchor)}"
        )
        title = "Geo-Punch reminder"
        message = (
            f"No Geo-Punch for {waited} (since {since_text}). If your next punch is due, please record it in the app."
        )
        extra = {"waited": waited, "since_text": since_text, "punches": f"{facts.punches} of {REQUIRED_PUNCHES}"}
        wa = {"waited": waited, "since_text": since_text, "punches": f"{facts.punches} of {REQUIRED_PUNCHES}"}

    wa_params = {"employee_name": name, "destination": destination, **wa}
    if to_head:
        wa_params.update({"hod_name": head_name, "employee_code": code, "alerted_at": alerted})
    return Words(title=title, message=message, push={**common, **extra}, whatsapp=flat(wa_params))


# ── the two channels ─────────────────────────────────────────────────────────────────────────────────────────────────


def dedupe_key(alert: GeoTrackingAlert, stage: str) -> str:
    """One key per episode and stage, on both channels (notification_targets reads the session from it)."""
    return f"{PREFIX}:{alert.pk}:{stage}:{alert.track.session_id}"


def send_push(kind: str, recipient: Employee, alert: GeoTrackingAlert, stage: str, w: Words):
    """The phone notification, as Phone Notify Control's own settings decide. Returns (outcome, Notification | None)."""
    from .. import mobile_messages, push_recipients, push_templates

    source = KINDS[kind].source
    try:
        master, off = mobile_messages.switches()
        if not master:
            return OUT_MASTER_OFF, None
        if source in off:
            return OUT_OFF, None
        if not push_recipients.allows(recipient):
            return OUT_NOT_RECIPIENT, None  # Phone Notify Control -> Settings: nothing at all for them
        title, message = push_templates.apply(source, w.push, w.title, w.message)
        with transaction.atomic():
            row = Notification.objects.create(
                employee=recipient,
                type="on_duty",
                title=title,
                message=message,
                source=source,
                dedupe_key=dedupe_key(alert, stage)[:160],
            )
        return OUT_MADE, row
    except IntegrityError:
        return OUT_DUPLICATE, None
    except Exception:
        logger.exception("Tracking alert %s: the phone notification (%s) could not be made", alert.pk, stage)
        return OUT_ERROR, None


def send_whatsapp(kind: str, recipient: Employee, alert: GeoTrackingAlert, stage: str, w: Words):
    """The WhatsApp message, as WhatsApp Control's own settings and send queue decide. Returns (outcome, log | None)."""
    from .. import whatsapp_service

    k = KINDS[kind]
    doc_type = k.whatsapp_hod if stage == HOD else k.whatsapp
    try:
        if whatsapp_service.switch_off_reason(doc_type):
            return OUT_OFF, None
        if not whatsapp_service.is_configured():
            return OUT_NOT_CONFIGURED, None
        log = whatsapp_service.send_notification(
            recipient,
            doc_type,
            w.whatsapp,
            dedupe_key=dedupe_key(alert, stage),
            document_ref_id=alert.pk,
            related_module="on_duty",
            announce=False,  # the phone notification is Phone Notify Control's own (send_push)
        )
        return (OUT_QUEUED if log is not None else OUT_NOT_SENT), log
    except Exception:
        logger.exception("Tracking alert %s: the WhatsApp message (%s) could not be queued", alert.pk, stage)
        return OUT_ERROR, None


def department_head(employee: Employee) -> Employee | None:
    """The employee's ONE active Department Head allowed to approve On-Duty requests (never the employee themselves)."""
    from ..hod_scope import managers_to_notify

    heads = managers_to_notify(employee, "can_approve_on_duty", exclude_self=True)
    return heads[0].employee if heads else None


# ── the episode's life ───────────────────────────────────────────────────────────────────────────────────────────────


def close(alert: GeoTrackingAlert, now: datetime, resolution: str) -> str:
    """End an episode: resolved, or deleted when it was never alerted (a blip). Returns "resolved" | "deleted" | ""."""
    if alert.employee_sent_at is None:
        deleted = A.objects.filter(pk=alert.pk, employee_sent_at__isnull=True).delete()[0]
        if deleted:
            return "deleted"
    updated = A.objects.filter(pk=alert.pk, resolved_at__isnull=True).update(resolved_at=now, resolution=resolution)
    return "resolved" if updated else ""


def open_episode(track: DutyTrack, f: Found, s: GeoTrackingSettings, now: datetime) -> GeoTrackingAlert | None:
    """The open episode of a problem just seen: reopened (same episode, no new alert) when it ended within the cooldown, else
    a new one. None when its key was already used on this track (a missing punch / reminder is told once)."""
    if f.kind in ONCE_PER_KEY:
        if A.objects.filter(track=track, kind=f.kind, key=f.key).exists():
            return None
    else:
        recent = (
            A.objects.filter(
                track=track,
                kind=f.kind,
                key=f.key,
                resolved_at__gte=now - timedelta(minutes=s.alert_cooldown_minutes),
            )
            .order_by("-resolved_at")
            .first()
        )
        if recent is not None:
            try:
                with transaction.atomic():
                    A.objects.filter(pk=recent.pk).update(resolved_at=None, resolution="", last_seen_at=now)
                recent.refresh_from_db()
                return recent
            except IntegrityError:
                return A.objects.filter(track=track, kind=f.kind, key=f.key, resolved_at__isnull=True).first()
    try:
        with transaction.atomic():
            return A.objects.create(
                track=track,
                employee_id=track.employee_id,
                kind=f.kind,
                key=f.key,
                detected_at=min(f.detected_at or now, now),
                last_seen_at=now,
                detail=f.detail,
            )
    except IntegrityError:  # another run opened it a moment ago
        return A.objects.filter(track=track, kind=f.kind, key=f.key, resolved_at__isnull=True).first()


def alert_employee(alert: GeoTrackingAlert, facts: Facts, s: GeoTrackingSettings, now: datetime) -> bool:
    """The employee stage, when it is due (after the debounce for the phone-state kinds). Exactly once."""
    if alert.employee_sent_at is not None:
        return False
    wait = s.alert_debounce_minutes if KINDS[alert.kind].debounced else 0
    if now < alert.detected_at + timedelta(minutes=wait):
        return False
    if not A.objects.filter(pk=alert.pk, employee_sent_at__isnull=True).update(employee_sent_at=now):
        return False  # another run took it
    alert.employee_sent_at = now
    emp = facts.track.employee
    w = words(alert, EMPLOYEE, facts)
    push, row = send_push(alert.kind, emp, alert, EMPLOYEE, w)
    wa, log = send_whatsapp(alert.kind, emp, alert, EMPLOYEE, w)
    A.objects.filter(pk=alert.pk).update(
        employee_push=push,
        employee_notification=row,
        employee_whatsapp=wa,
        employee_whatsapp_log=log,
    )
    return True


def alert_head(alert: GeoTrackingAlert, facts: Facts, s: GeoTrackingSettings, now: datetime) -> bool:
    """The Department Head stage: the problem is still there alert_hod_grace_minutes after the employee was told."""
    if (
        not KINDS[alert.kind].whatsapp_hod
        or not s.alert_hod_enabled
        or alert.employee_sent_at is None
        or alert.hod_sent_at is not None
        or now < alert.employee_sent_at + timedelta(minutes=s.alert_hod_grace_minutes)
    ):
        return False
    if not A.objects.filter(pk=alert.pk, hod_sent_at__isnull=True).update(hod_sent_at=now):
        return False
    alert.hod_sent_at = now
    head = department_head(facts.track.employee)
    if head is None:
        A.objects.filter(pk=alert.pk).update(hod_push=OUT_NO_HEAD, hod_whatsapp=OUT_NO_HEAD)
        return True
    w = words(alert, HOD, facts, head)
    push, row = send_push(alert.kind, head, alert, HOD, w)
    wa, log = send_whatsapp(alert.kind, head, alert, HOD, w)
    A.objects.filter(pk=alert.pk).update(
        hod=head, hod_push=push, hod_notification=row, hod_whatsapp=wa, hod_whatsapp_log=log
    )
    return True


def _day_open(alert: GeoTrackingAlert, today: date) -> bool:
    """A "day" Missing Geo-Punch outlives its track until the day is over."""
    return (
        alert.kind == A.KIND_MISSING_PUNCH
        and alert.key == KEY_DAY
        and (alert.detail or {}).get("date") == today.isoformat()
    )


def run_alerts(now: datetime | None = None) -> dict:
    """One pass over every recording track (called by the watchdog). Returns counts: {opened, employee, hod, resolved,
    deleted}. Never raises for one track's problem."""
    now = now or timezone.now()
    s = GeoTrackingSettings.get()
    counts: Counter = Counter()
    open_rows = list(A.objects.filter(resolved_at__isnull=True).select_related("track"))
    if not s.alerts_enabled:
        for alert in open_rows:
            outcome = close(alert, now, A.RESOLVED_ALERTS_OFF)
            if outcome:
                counts[outcome] += 1
        return dict(counts)

    today = local_today(now)
    wanted = wanted_kinds()
    day_start = _at(today, time(0, 0))
    tracks = list(
        DutyTrack.objects.filter(status=DutyTrack.STATUS_ACTIVE).select_related("employee", "session")
    ) + list(
        DutyTrack.objects.filter(
            status=DutyTrack.STATUS_ENDED, end_reason=DutyTrack.END_MANUAL, ended_at__gte=day_start
        ).select_related("employee", "session")
    )
    looked_at = {t.pk for t in tracks}
    by_track: dict[int, dict[tuple[str, str], GeoTrackingAlert]] = {}
    for alert in open_rows:
        if alert.track_id in looked_at:
            by_track.setdefault(alert.track_id, {})[(alert.kind, alert.key)] = alert
            continue
        # a track no longer looked at (ended, rejected, a Done of an earlier day): its episodes end with it, except today's
        # "day" missing punch, which stays open until the punches are in or the day is over
        if alert.track.status == DutyTrack.STATUS_ENDED and alert.track.end_reason != DutyTrack.END_REJECTED:
            if _day_open(alert, today):
                by_track.setdefault(alert.track_id, {})[(alert.kind, alert.key)] = alert
                tracks.append(DutyTrack.objects.select_related("employee", "session").get(pk=alert.track_id))
                looked_at.add(alert.track_id)
                continue
            resolution = A.RESOLVED_DAY_OVER if alert.kind == A.KIND_MISSING_PUNCH and alert.key == KEY_DAY else None
        else:
            resolution = None
        outcome = close(alert, now, resolution or A.RESOLVED_TRACK_ENDED)
        if outcome:
            counts[outcome] += 1

    seen: list[int] = []
    for track in tracks:
        try:
            facts = gather(track, now)
            found = {(f.kind, f.key): f for f in detect(facts, s)}
            existing = by_track.get(track.pk, {})
            for pair, alert in existing.items():
                if pair in found:
                    continue
                if alert.kind == A.KIND_MISSING_PUNCH and alert.key == KEY_DAY:
                    if facts.punches < REQUIRED_PUNCHES and _day_open(alert, today):
                        seen.append(alert.pk)  # still missing: it stays open (the check moment has passed)
                        continue
                    resolution = A.RESOLVED_FIXED if facts.punches >= REQUIRED_PUNCHES else A.RESOLVED_DAY_OVER
                elif track.status != DutyTrack.STATUS_ACTIVE:
                    resolution = A.RESOLVED_TRACK_ENDED
                else:
                    resolution = A.RESOLVED_FIXED
                outcome = close(alert, now, resolution)
                if outcome:
                    counts[outcome] += 1
            for pair, f in found.items():
                alert = existing.get(pair)
                if alert is None:
                    if not wanted.get(f.kind):
                        continue  # no channel would carry it: not tracked
                    alert = open_episode(track, f, s, now)
                    if alert is None:
                        continue
                    if alert.employee_sent_at is None:
                        counts["opened"] += 1
                seen.append(alert.pk)
                if not wanted.get(f.kind):
                    continue
                if alert_employee(alert, facts, s, now):
                    counts["employee"] += 1
                if alert_head(alert, facts, s, now):
                    counts["hod"] += 1
        except Exception:
            logger.exception("Tracking alerts failed for track %s", track.pk)
    if seen:
        A.objects.filter(pk__in=seen).update(last_seen_at=now)
    if counts:
        logger.info("Geo-tracking alerts: %s", dict(counts))
    return dict(counts)


# ── the HR log ───────────────────────────────────────────────────────────────────────────────────────────────────────


def summary(alert: GeoTrackingAlert) -> str:
    """One line saying what the episode is about, for the log."""
    d = alert.detail or {}
    kind = alert.kind
    if kind == A.KIND_LOCATION_OFF:
        return f"Location off since {time_str(alert.detected_at)}"
    if kind == A.KIND_PERMISSION:
        return f"Location permission: {PERMISSION_WORDS.get(d.get('permission', ''), d.get('permission') or 'unknown')}"
    if kind == A.KIND_BACKGROUND:
        words_ = restriction_words(bool(d.get("backgroundRestricted")), bool(d.get("batteryOptimised")))
        return (words_[:1].upper() + words_[1:]) if words_ else "Background use restricted"
    if kind == A.KIND_TRACKING_FAILURE:
        heard = d.get("lastHeard")
        return (
            f"No location since {time_str(datetime.fromisoformat(heard))}" if isinstance(heard, str) else "No location"
        )
    if kind == A.KIND_MISSING_PUNCH:
        if alert.key == KEY_FIRST:
            return f"No Geo-Punch {timedelta_words(alert)} after the On-Duty started"
        n = d.get("punches", 0)
        return f"{n} of {REQUIRED_PUNCHES} punches at the end of the duty day"
    anchor = d.get("anchor")
    since = time_str(datetime.fromisoformat(anchor)) if isinstance(anchor, str) else ""
    return f"No Geo-Punch since {since}" if since else "No Geo-Punch for a while"


def timedelta_words(alert: GeoTrackingAlert) -> str:
    started = (alert.detail or {}).get("startedAt")
    if not isinstance(started, str):
        return "in time"
    return duration_str((alert.detected_at - datetime.fromisoformat(started)).total_seconds())


def _channel(outcome: str, row, kind: str) -> dict:
    """One channel of one stage: the outcome code + words, and (once a row exists) what became of it since."""
    out = {"outcome": outcome or None, "label": OUTCOME_LABELS.get(outcome, outcome or "")}
    if row is not None:
        if kind == "push":
            out.update({"status": row.push_status or "waiting", "error": row.push_error or None, "id": row.pk})
        else:
            out.update({"status": row.status, "error": row.error_message or None, "id": row.pk})
    return out


def alert_json(alert: GeoTrackingAlert, s: GeoTrackingSettings) -> dict:
    emp = alert.employee
    dept = getattr(emp, "department", None)
    stages = [
        {
            "stage": EMPLOYEE,
            "recipientName": full_name(emp),
            "sentAt": _iso(alert.employee_sent_at),
            "push": _channel(alert.employee_push, alert.employee_notification, "push"),
            "whatsapp": _channel(alert.employee_whatsapp, alert.employee_whatsapp_log, "whatsapp"),
        }
    ]
    escalates = bool(KINDS[alert.kind].whatsapp_hod) if alert.kind in KINDS else False
    hod_due = None
    if alert.hod_sent_at is not None:
        stages.append(
            {
                "stage": HOD,
                "recipientName": full_name(alert.hod) if alert.hod_id else None,
                "sentAt": _iso(alert.hod_sent_at),
                "push": _channel(alert.hod_push, alert.hod_notification, "push"),
                "whatsapp": _channel(alert.hod_whatsapp, alert.hod_whatsapp_log, "whatsapp"),
            }
        )
    elif escalates and s.alert_hod_enabled and alert.employee_sent_at and alert.resolved_at is None:
        hod_due = _iso(alert.employee_sent_at + timedelta(minutes=s.alert_hod_grace_minutes))
    return {
        "id": alert.pk,
        "kind": alert.kind,
        "kindLabel": KIND_LABELS.get(alert.kind, alert.kind),
        "key": alert.key,
        "summary": summary(alert),
        "trackId": alert.track_id,
        "sessionId": alert.track.session_id,
        "destination": (getattr(alert.track.session, "destination", "") or "")[:120],
        "employeeId": emp.pk,
        "employeeName": full_name(emp),
        "employeeCode": emp.employee_code,
        "department": dept.name if dept is not None else None,
        "detectedAt": _iso(alert.detected_at),
        "lastSeenAt": _iso(alert.last_seen_at),
        "resolvedAt": _iso(alert.resolved_at),
        "resolution": alert.resolution or None,
        "resolutionLabel": dict(A.RESOLUTION_CHOICES).get(alert.resolution) if alert.resolution else None,
        "open": alert.resolved_at is None,
        "waiting": alert.employee_sent_at is None,
        "escalates": escalates,
        "hodDueAt": hod_due,
        "stages": stages,
    }

"""Phone attendance alerts: Phone Notify Control's own job (owner 2026-11-17: the phone and WhatsApp modules are independent).

Every minute (push_delivery_scheduler) this looks at today's attendance of the staff who receive phone notifications
(push_recipients.py) and makes the phone notification of each alert that is due:

    absent_alert            no punch once the shift's allowed time (+ Settings' extra wait) has passed
    late_alert              the first punch came after the shift's allowed time
    four_punch_alert        a reminder a set time (Settings) before each punch still missing
    on_duty_punch_reminder  the same for an employee On-Duty (their Geo Punch)
    missing_punch_alert     a punch still missing a set time (Settings) after it was due

Only Phone Notify Control decides: its master switch and each alert kind's switch (Controls), its recipients (Settings), its
timing (Settings: alert_*_minutes) and its wording (Message Text). WhatsApp Control's alert switches, timing, limits and
provider have no part in it; WhatsApp's own job (whatsapp_alerts.run_attendance_alerts) is separate. Both use the same
attendance rules (whatsapp_alerts.load_day / evaluate: shifts, leave, permissions, compensation days, freshness), which are
HRMS rules, not either channel's settings.

Each alert is made once per employee and day (its dedupe key; the rows made today are read back at the start of each run).
"""

from __future__ import annotations

import logging
from collections import Counter
from datetime import datetime

from . import mobile_messages, push_messages, push_recipients
from .clock import ist_now
from .models import Employee, MobileMessageSettings, Notification
from .whatsapp_alerts import ALERT_TYPES, evaluate, load_day, non_working_reason

logger = logging.getLogger(__name__)

# Settings limits (minutes)
ABSENT_EXTRA_RANGE = (0, 240)
REMINDER_LEAD_RANGE = (1, 60)
MISSING_AFTER_RANGE = (0, 240)


class PhoneAlertRules:
    """What evaluate() reads as its switches and timing, from Phone Notify Control's settings."""

    def __init__(self, s: MobileMessageSettings, kinds: set[str]):
        self.attendance_alerts_enabled = True
        self.absent_alert_enabled = "absent_alert" in kinds
        self.late_alert_enabled = "late_alert" in kinds
        self.four_punch_alert_enabled = bool({"four_punch_alert", "on_duty_punch_reminder"} & kinds)
        self.missing_punch_alert_enabled = "missing_punch_alert" in kinds
        self.absent_extra_minutes = int(s.alert_absent_extra_minutes)
        self.four_punch_lead_minutes = int(s.alert_reminder_lead_minutes)
        self.missing_punch_after_minutes = int(s.alert_missing_after_minutes)


def alert_kinds() -> set[str]:
    """The alert kinds Phone Notify Control has on (master switch + each kind)."""
    master, off = mobile_messages.switches()
    return {t for t in ALERT_TYPES if t not in off} if master else set()


def _made_today(iso: str) -> set[str]:
    """The alert keys already made into phone notifications today (stored as "wa:<key>", push_messages.announce)."""
    return {
        key[3:]
        for key in Notification.objects.filter(
            source__in=ALERT_TYPES, dedupe_key__startswith="wa:", dedupe_key__contains=f":{iso}:"
        ).values_list("dedupe_key", flat=True)
    }


def run_phone_alerts(now: datetime | None = None) -> dict:
    """Make the phone notifications of the alerts due now. Returns {alert_type: number made}."""
    made: Counter = Counter()
    kinds = alert_kinds()
    if not kinds:
        return {}
    now = now or ist_now()
    if non_working_reason(now.date()):
        return {}
    rules = PhoneAlertRules(MobileMessageSettings.get(), kinds)
    day = load_day(now, rules)
    day.already = _made_today(day.iso)  # this job's own record, not WhatsApp's
    # only the recipients are looked at: "production only", or a short selected list, makes this job almost free
    staff = push_recipients.narrow(
        Employee.objects.filter(status="active", employment_type=Employee.EMPLOYMENT_TYPE_STAFF)
    ).defer("photo_url")
    for emp in staff:
        for item in evaluate(emp, day):
            if item.doc_type not in kinds:
                continue  # e.g. the punch reminder is on but the On-Duty one is off
            key = f"{item.tag}:{day.iso}:{emp.id}"
            if key in day.already:
                continue
            day.already.add(key)
            if push_messages.announce(emp, item.doc_type, params=item.params, dedupe_key=key) is not None:
                made[item.doc_type] += 1
    if made:
        logger.warning("Phone attendance alerts made: %s", dict(made))
    return dict(made)

"""Who receives phone notifications at all (Phone Notify Control -> Settings, owner 2026-11-17).

One company-wide setting, MobileMessageSettings.recipient_mode:
    all         every active employee (the default, as before)
    staff       staff employees only
    production  production employees only
    selected    only the employees on the PushRecipient list ("Selected employees")

Every AUTOMATIC sender asks this module before it makes anything, so an employee outside the setting is never processed:
no notification record, no push, no Expo request. The bulk senders narrow their employee query in the database
(`narrow` / `q`): the chat fan-out, the attendance alerts' phone side, compensation announcements, salary paid. The
one-at-a-time senders ask `allows(employee_id)`. push_delivery checks it once more just before the push (a safety net for a
sender that forgot), and records such a row as push "off" with NOT_RECIPIENT.

What HR writes to one person on purpose is not automatic and always goes: a message from Phone Notify Control -> Send
(source "manual") and a notice through the notifications API (source "hr_notice").

Reading the setting never raises: when it cannot be read (the column before migration 0157 runs) everybody receives, as
before the setting existed.
"""

from __future__ import annotations

import logging

from django.db import transaction
from django.db.models import Q

logger = logging.getLogger(__name__)

ALL, STAFF, PRODUCTION, SELECTED = "all", "staff", "production", "selected"
MODES = (ALL, STAFF, PRODUCTION, SELECTED)
MODE_LABELS = {
    ALL: "All employees",
    STAFF: "Staff only",
    PRODUCTION: "Production only",
    SELECTED: "Selected employees",
}
MODE_DESCRIPTIONS = {
    ALL: "Every active employee, staff and production.",
    STAFF: "Staff employees only. Production employees are left out of every automatic notification.",
    PRODUCTION: "Production employees only. Staff employees are left out of every automatic notification.",
    SELECTED: "Only the employees on the list below, whatever their type.",
}
# Written by HR for one person on purpose: not automatic, so the setting does not apply.
EXEMPT_SOURCES = frozenset({"manual", "hr_notice"})
NOT_RECIPIENT = "Not a phone notification recipient (Phone Notify Control -> Settings)."


def mode() -> str:
    """The current recipient mode ("all" when it cannot be read)."""
    from .models import MobileMessageSettings

    try:
        with transaction.atomic():
            value = MobileMessageSettings.objects.filter(pk=1).values_list("recipient_mode", flat=True).first()
    except Exception:
        logger.warning("Could not read the phone notification recipients (is migration 0157 applied?)", exc_info=True)
        return ALL
    return value if value in MODES else ALL


def q(prefix: str = "", current: str | None = None) -> Q | None:
    """The Employee condition of a mode (`prefix` "employee__" for a query on another model), or None for everybody."""
    m = current or mode()
    if m == STAFF:
        return Q(**{f"{prefix}employment_type": "staff"})
    if m == PRODUCTION:
        return Q(**{f"{prefix}employment_type": "production"})
    if m == SELECTED:
        return Q(**{f"{prefix}push_recipient__isnull": False})
    return None


def narrow(qs, prefix: str = "", current: str | None = None):
    """`qs` left with the recipients only (unchanged for "all")."""
    cond = q(prefix, current)
    return qs if cond is None else qs.filter(cond)


def keep(employee_ids, current: str | None = None) -> set[int]:
    """Which of these employees are recipients."""
    from .models import Employee

    ids = {i for i in employee_ids if i}
    cond = q("", current)
    if cond is None or not ids:
        return ids
    with transaction.atomic():  # a savepoint: a failed read never spoils the caller's transaction
        return set(Employee.objects.filter(pk__in=ids).filter(cond).values_list("id", flat=True))


def allows(employee) -> bool:
    """Is this employee (an Employee or an id) a recipient? One query at most; never raises."""
    emp_id = getattr(employee, "pk", employee)
    if not emp_id:
        return False
    try:
        current = mode()
        if current == ALL:
            return True
        if current in (STAFF, PRODUCTION) and getattr(employee, "employment_type", None):
            return employee.employment_type == current
        return bool(keep([emp_id], current))
    except Exception:
        logger.warning("Could not check the phone notification recipients; notifying as usual", exc_info=True)
        return True


def blocked(rows) -> set[int]:
    """The notification ids of `rows` whose employee is not a recipient (HR's own messages never are blocked)."""
    rows = [n for n in rows if (n.source or "") not in EXEMPT_SOURCES]
    if not rows:
        return set()
    try:
        current = mode()
        if current == ALL:
            return set()
        ok = keep({n.employee_id for n in rows}, current)
    except Exception:
        logger.warning("Could not check the phone notification recipients; pushing as usual", exc_info=True)
        return set()
    return {n.pk for n in rows if n.employee_id not in ok}

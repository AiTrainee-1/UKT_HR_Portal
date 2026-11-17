"""Compensation & overtime -> the employee's phone (2026-11-17, Phone Notify Control's "Compensation & overtime").

Two kinds, each with its own switch on Phone Notify Control (mobile_messages.EXTRA_TYPES):
  * ot_compensation: HR decided a staff member's detected overtime (Compensation -> OT): assigned as payment or as time off
    (on a date, or into the compensation balance), or rejected. One notification per record and decision.
  * compensation_announcement: HR announced a Compensation Day (no Late / Permission that day) or a late-in / early-out window
    for a date. Every active staff member it covers gets one notification.

A Notification row IS the push (signals.py -> push_delivery.py, after the commit). Nothing in here ever raises into the
compensation workflow: a notice that cannot be made is logged and skipped.
"""

from __future__ import annotations

import logging
from decimal import Decimal

from django.db import IntegrityError, transaction

logger = logging.getLogger(__name__)

SOURCE_OT = "ot_compensation"
SOURCE_ANNOUNCEMENT = "compensation_announcement"
NOTIFICATION_TYPE = "compensation"  # notification_targets: opens Compensation in the app


def _day(d) -> str:
    return d.strftime("%d %b %Y") if d else ""


def _time(t) -> str:
    return t.strftime("%I:%M %p").lstrip("0") if t else ""


def _shifts(value) -> str:
    if value is None:
        return "one day"
    v = Decimal(str(value)).normalize()
    text = format(v, "f")
    return f"{text} shift" if v == 1 else f"{text} shifts"


def overtime_text(rec, decision: str) -> tuple[str, str]:
    """(title, body) for an overtime decision: "pay" | "relaxation" | "rejected"."""
    worked = _day(rec.date)
    if decision == "rejected":
        return (
            "Overtime not compensated",
            f"Your extra work on {worked} was reviewed and will not be compensated. Please contact HR if you think this "
            "is a mistake.",
        )
    amount = _shifts(rec.shifts)
    if decision == "pay":
        return (
            "Overtime approved: payment",
            f"Your extra work on {worked} will be paid ({amount}) with your salary for {rec.date.strftime('%B %Y')}.",
        )
    if rec.claim_date:
        return (
            "Overtime approved: time off",
            f"Your extra work on {worked} was approved as time off ({amount}), granted on {_day(rec.claim_date)}.",
        )
    return (
        "Overtime approved: time off",
        f"Your extra work on {worked} was approved as time off ({amount}). It is added to your compensation balance.",
    )


def overtime_decided(rec, decision: str) -> None:
    """Tell the employee how their overtime record was decided. Never raises."""
    from .models import Notification

    try:
        title, body = overtime_text(rec, decision)
        with transaction.atomic():
            Notification.objects.create(
                employee_id=rec.employee_id,
                type=NOTIFICATION_TYPE,
                title=title,
                message=body,
                source=SOURCE_OT,
                dedupe_key=f"ot:{rec.pk}:{decision}",
            )
    except IntegrityError:
        pass  # already told
    except Exception:
        logger.exception("Could not notify the overtime decision of record %s", getattr(rec, "pk", None))


def announcement_text(ann) -> tuple[str, str]:
    from .models import CompensationDayAnnouncement as A

    when = _day(ann.date)
    why = f" Reason: {ann.reason.strip()}" if (ann.reason or "").strip() else ""
    if ann.kind == A.KIND_LATE_IN:
        return (
            "Late arrival allowed",
            f"On {when} you may arrive up to {_time(ann.allowed_time)} without a late mark.{why}",
        )
    if ann.kind == A.KIND_EARLY_OUT:
        at = ann.allowed_time or ann.leave_until_time
        return "Early leaving allowed", f"On {when} you may leave from {_time(at)} without a penalty.{why}"
    until = f" (until {_time(ann.leave_until_time)})" if ann.leave_until_time else ""
    return (
        "Compensation Day announced",
        f"{when} is a Compensation Day{until}: no late or permission marks apply that day.{why}",
    )


def covered_staff(ann) -> list[int]:
    """The active staff an announcement covers: its employees when it names them, else its department, else its branch,
    else everybody (the engine's reading of an empty list)."""
    from .models import Employee

    named = list(ann.employees.values_list("id", flat=True))
    qs = Employee.objects.filter(status="active", employment_type="staff")
    if named:
        qs = qs.filter(id__in=named)
    elif ann.department_id:
        qs = qs.filter(department_id=ann.department_id)
    elif ann.branch_id:
        qs = qs.filter(branch_id=ann.branch_id)
    return list(qs.values_list("id", flat=True))


def announcement_made(ann, employee_ids=None) -> int:
    """One notification per covered staff member (bulk, then pushed after the commit). Returns how many. Never raises."""
    from . import push_delivery
    from .models import Notification

    try:
        ids = list(employee_ids) if employee_ids is not None else covered_staff(ann)
        if not ids:
            return 0
        title, body = announcement_text(ann)
        key = f"compday:{ann.pk}"
        with transaction.atomic():
            Notification.objects.bulk_create(
                [
                    Notification(
                        employee_id=emp_id,
                        type=NOTIFICATION_TYPE,
                        title=title,
                        message=body,
                        source=SOURCE_ANNOUNCEMENT,
                        dedupe_key=key,
                    )
                    for emp_id in ids
                ],
                batch_size=500,
                ignore_conflicts=True,
            )
            made = list(
                Notification.objects.filter(dedupe_key=key, employee_id__in=ids, push_status="").values_list(
                    "pk", flat=True
                )
            )
        push_delivery.schedule(made)  # bulk_create sends no post_save
        return len(made)
    except Exception:
        logger.exception("Could not notify the compensation announcement %s", getattr(ann, "pk", None))
        return 0

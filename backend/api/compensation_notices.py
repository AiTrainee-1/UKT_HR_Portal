"""Compensation & overtime -> the employee's phone (2026-11-17, Phone Notify Control's "Compensation & overtime").

Two kinds, each with its own switch on Phone Notify Control (mobile_messages.EXTRA_TYPES):
  * ot_compensation: HR decided a staff member's detected overtime (Compensation -> OT): assigned as payment or as time off
    (on a date, or into the compensation balance), or rejected. One notification per record and decision.
  * compensation_announcement: HR announced a Compensation Day (no Late / Permission that day) or a late-in / early-out window
    for a date. Every active staff member it covers gets one notification; removing one later sends each of them a
    "cancelled" notice under the same switch (announcement_cancelled, 2026-11-19).

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
    from . import push_recipients, push_templates
    from .models import Notification

    if not push_recipients.allows(rec.employee_id):
        return  # not a phone notification recipient (Phone Notify Control -> Settings)
    try:
        title, body = overtime_text(rec, decision)
        title, body = push_templates.apply(  # HR's wording (Phone Notify Control -> Message Text)
            SOURCE_OT,
            lambda: {
                "employee_name": f"{rec.employee.first_name} {rec.employee.last_name}",
                "date": _day(rec.date),
                "decision": {"pay": "payment", "relaxation": "time off"}.get(decision, "not compensated"),
                "amount": _shifts(rec.shifts),
                "granted_on": _day(rec.claim_date),
                "month": rec.date.strftime("%B %Y"),
            },
            title,
            body,
        )
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

    from . import push_recipients

    named = list(ann.employees.values_list("id", flat=True))
    qs = push_recipients.narrow(Employee.objects.filter(status="active", employment_type="staff"))
    if named:
        qs = qs.filter(id__in=named)
    elif ann.department_id:
        qs = qs.filter(department_id=ann.department_id)
    elif ann.branch_id:
        qs = qs.filter(branch_id=ann.branch_id)
    return list(qs.values_list("id", flat=True))


def announcement_made(ann, employee_ids=None) -> int:
    """One notification per covered staff member (bulk, then pushed after the commit). Returns how many. Never raises."""
    from . import push_delivery, push_recipients, push_templates
    from .models import Notification

    try:
        ids = sorted(push_recipients.keep(employee_ids)) if employee_ids is not None else covered_staff(ann)
        if not ids:
            return 0
        title, body = announcement_text(ann)
        title, body = push_templates.apply(  # HR's wording (Phone Notify Control -> Message Text)
            SOURCE_ANNOUNCEMENT,
            {
                "date": _day(ann.date),
                "kind": {"late_in": "Late arrival allowed", "early_out": "Early leaving allowed"}.get(
                    ann.kind, "Compensation Day"
                ),
                "time": _time(ann.allowed_time or ann.leave_until_time),
                "reason": (ann.reason or "").strip(),
            },
            title,
            body,
        )
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


def cancelled_text(ann) -> tuple[str, str]:
    """(title, body) telling staff an announcement was removed (2026-11-19: an announcement of any date can be removed)."""
    from .models import CompensationDayAnnouncement as A

    when = _day(ann.date)
    if ann.kind == A.KIND_LATE_IN:
        what = f"The late arrival allowed on {when} (up to {_time(ann.allowed_time)})"
    elif ann.kind == A.KIND_EARLY_OUT:
        what = f"The early leaving allowed on {when} (from {_time(ann.allowed_time or ann.leave_until_time)})"
    else:
        what = f"The Compensation Day on {when}"
    return "Announcement cancelled", f"{what} was cancelled by HR: the normal shift times apply that day."


def announcement_cancelled(ann, employee_ids=None, *, announcement_id=None) -> int:
    """One "cancelled" notification per staff member the removed announcement covered (same Phone Notify Control switch as
    the announcement: source compensation_announcement). Call it after the delete with the ids worked out BEFORE it (the
    row and its employee list are gone) and the removed row's id (`ann.pk` is None after a delete). HR's own wording for
    announcements (Message Text) is not applied: it describes an announcement, not its cancellation. Returns how many.
    Never raises."""
    from . import push_delivery, push_recipients
    from .models import Notification

    try:
        ids = sorted(push_recipients.keep(employee_ids)) if employee_ids is not None else covered_staff(ann)
        if not ids:
            return 0
        title, body = cancelled_text(ann)
        key = f"compday-cancel:{announcement_id or ann.pk}"
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
        logger.exception("Could not notify the cancelled compensation announcement %s", announcement_id)
        return 0


# ── compensation claims (2026-11-19) ─────────────────────────────────────────────────────────────────────────────────
# A decided claim is told by whatsapp_approvals.notify_decision (workflow `holiday_work`: the WhatsApp message and its phone
# notification of type "compensation", whose focus id in the apps is hw-<claim id>). What is added here is the one event that
# has no message of its own: HR raising a claim on the employee's behalf (the employee raising their own needs no notice).


def claim_raised_text(claim) -> tuple[str, str]:
    from .compensation_claims import KIND_LABELS

    label = KIND_LABELS.get(claim.kind, "Compensation")
    when = _day(claim.work_date)
    if claim.kind == "use_balance":
        body = (
            f"HR asked, for you, to use {_shifts(claim.shifts)} of your compensation balance on {when}. "
            "It is waiting for your Department Head."
        )
    elif claim.kind == "ot_allowance":
        body = (
            f"HR claimed your late-in allowance ({claim.minutes or 0} min) for the extra hours on {when}. "
            "It is waiting for your Department Head."
        )
    else:
        body = (
            f"HR claimed {_shifts(claim.shifts)} of compensation for you ({label.lower()}, {when}). "
            "It is waiting for your Department Head."
        )
    return f"Compensation claim raised: {label}", body


def claim_raised(claim) -> None:
    """Tell the employee that HR raised a claim for them (Phone Notify Control's "Compensation & overtime" switch, the
    same source as the overtime decisions). One notification per claim. Never raises."""
    from . import push_recipients
    from .models import Notification

    if not push_recipients.allows(claim.employee_id):
        return
    try:
        title, body = claim_raised_text(claim)
        with transaction.atomic():
            Notification.objects.create(
                employee_id=claim.employee_id,
                type=NOTIFICATION_TYPE,
                title=title,
                message=body,
                source=SOURCE_OT,
                dedupe_key=f"claim:{claim.pk}:raised",
            )
    except IntegrityError:
        pass  # already told
    except Exception:
        logger.exception("Could not notify the claim %s raised by HR", getattr(claim, "pk", None))

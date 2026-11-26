"""
Birthday Compensation on a chosen date (owner brief 2026-11-25): the writes. The rules are in birthday_compensation.py.

    raise_use(employee, use_date, portion, reason, raised_by_role, raised_by_name)  one pending use (employee or HR)
    withdraw_use(use_id, by_role, by_name, employee=None)                           a pending use -> withdrawn
    decide_use(use_id, role, decision, actor, comment)                              the Department Head's / HR's decision
    apply_use(use)                                                                  re-derive the day after the final approval

Every write takes the employee row lock first (select_for_update: the lock every compensation writer uses), so two
requests of one employee are checked one after the other and can never both take the same 0.50; the database refuses two
open uses of the same half of a date anyway (uniq_bday_use_first_half / _second_half).

Refusals are UseError(code, message, status) answered {error, code}:
    invalid 400            a bad date / portion, a reason over 500 characters
    not_staff 403          a production employee
    not_eligible 400       inactive, no date of birth, the date is not in the birthday month, the birthday gives nothing
                           to place (not worked / paid birthday leave / a day off / the old rule / not worked out yet)
    not_yet 400            the birthday is still to come (or today with no punch yet)
    lapsed 400             the birthday month is over
    credit_claimed 409     the birthday was already claimed as a 1.00 credit (the 2026-11-19 flow)
    nothing_left 409       all of the 1.00 is placed (waiting / approved), or the portion is more than what is left
    date_not_allowed 400   the date / portion is not eligible (the sentence says why: a Sunday, present that day, ...)
    locked 409             the date's payroll is finalized (Payroll Done)
    already_placed 409     that half of that date is already placed (the database's guard)
    switched_off 403       the master switch, the Birthday switch or the birthday_compensation workflow is off
    no_hod 409             no Department Head who may approve compensation (or the employee is their own head)
    not_found 404, not_pending 400, not_yours 403 (withdrawing)
Decisions raise approval_workflow.ApprovalError (the pipeline's own refusals: not your turn, already decided, a rejection
without its reason ...); an approval the rules refuse now is ApprovalError(status 409, code "use_refused").
"""

from __future__ import annotations

import datetime as dt
import logging

from django.db import IntegrityError, transaction
from django.utils import timezone

from . import approval_workflow as approval
from . import birthday_compensation as rules
from .clock import ist_today
from .compensation_shared import date_text, full_name, master_enabled
from .models import BirthdayCompensationUse, Employee

logger = logging.getLogger(__name__)

WORKFLOW = rules.WORKFLOW
NOTICE_TYPE = (
    "birthday_compensation"  # Notification.type of the employee's notices (notification_targets: Compensation)
)


class UseError(Exception):
    def __init__(self, code: str, message: str, status: int = 400):
        super().__init__(message)
        self.code = code
        self.message = message
        self.status = status

    def as_json(self) -> dict:
        return {"error": self.message, "code": self.code}


def _select():
    return BirthdayCompensationUse.objects.select_related(
        "employee__department", "employee__designation", "employee__branch"
    )


def reload(pk: int) -> BirthdayCompensationUse:
    return _select().get(pk=pk)


def clean_reason(raw) -> str:
    text = " ".join(str(raw or "").split())
    if len(text) > rules.MAX_REASON_LENGTH:
        raise UseError("invalid", f"The reason can be at most {rules.MAX_REASON_LENGTH} characters.")
    return text


def _switch_error() -> UseError | None:
    from .models import CompensationConfig

    if not master_enabled():
        return UseError(
            "switched_off",
            "The OT / Compensation features are switched off in Settings > Payroll, so Birthday Compensation can't be "
            "placed right now.",
            403,
        )
    if not CompensationConfig.get().birthday_enabled:
        return UseError(
            "switched_off",
            "Birthday compensation is switched off in Settings > Compensation, so it can't be placed right now.",
            403,
        )
    if not approval.get_config(WORKFLOW).enabled:
        return UseError(
            "switched_off", "Birthday Compensation requests are switched off right now. Please contact HR.", 403
        )
    return None


_STATE_ERRORS = {
    rules.STATE_UPCOMING: ("not_yet", 400),
    rules.STATE_LAPSED: ("lapsed", 400),
    rules.STATE_CREDIT_CLAIM: ("credit_claimed", 409),
    rules.STATE_PLACED: ("nothing_left", 409),
}


# ─────────────────────────── raising ───────────────────────────


def raise_use(
    *,
    employee: Employee,
    use_date,
    portion: str,
    reason: str = "",
    raised_by_role: str,
    raised_by_name: str,
    request=None,
    today: dt.date | None = None,
) -> BirthdayCompensationUse:
    """Validate everything (switches, staff, the birthday worked and its month open, what is left, the date and portion,
    the payroll lock, a Department Head) and save one pending use, then tell the Department Head (and, when HR raised it,
    the employee). Raises UseError; nothing is saved then."""
    from .attendance_edit import lock_refusal

    for_employee = raised_by_role == BirthdayCompensationUse.RAISED_BY_EMPLOYEE
    if raised_by_role not in (BirthdayCompensationUse.RAISED_BY_EMPLOYEE, BirthdayCompensationUse.RAISED_BY_HR):
        raise UseError("invalid", "raised_by_role must be employee or hr.")
    if not isinstance(use_date, dt.date):
        raise UseError("invalid", "useDate must be a date (YYYY-MM-DD).")
    if portion not in rules.PORTIONS:
        raise UseError("invalid", "portion must be full, first_half or second_half.")
    text = clean_reason(reason)
    today = today or ist_today()
    if employee.employment_type != "staff":
        who = "You are" if for_employee else f"{full_name(employee)} is"
        raise UseError("not_staff", f"{who} a production employee: Birthday Compensation is for staff only.", 403)
    if employee.status != "active":
        raise UseError("not_eligible", f"{full_name(employee)} is not an active employee.")
    if err := _switch_error():
        raise err
    if employee.date_of_birth is None:
        raise UseError(
            "not_eligible",
            "Your date of birth is not on record: please contact HR."
            if for_employee
            else f"{full_name(employee)} has no date of birth on record.",
        )
    birthday = rules.birthday_of_use_date(employee, use_date)
    if birthday is None:
        own = rules.birthday_for(employee, use_date.year)
        raise UseError(
            "not_eligible",
            f"Birthday Compensation can only be placed in the birthday month ({rules.month_label(own)}), so "
            f"{date_text(use_date)} cannot be chosen.",
        )
    # the birthday month's days worked out again first (never a manual day, never a finalized month), outside the lock
    rules._refresh_month(employee, birthday, today)

    with transaction.atomic():
        locked = (
            Employee.objects.select_for_update(of=("self",))
            .select_related("department", "designation", "branch")
            .filter(pk=employee.pk)
            .first()
        )
        if locked is None:
            raise UseError("not_found", "Employee not found.", 404)
        ent = rules.entitlement(locked, birthday, today, for_employee=for_employee)
        if ent.state != rules.STATE_AVAILABLE:
            code, status = _STATE_ERRORS.get(ent.state, ("not_eligible", 400))
            raise UseError(code, ent.message or "This birthday gives no Birthday Compensation to place.", status)
        days = rules.PORTION_DAYS[portion]
        if days > ent.available:
            raise UseError(
                "nothing_left",
                f"Only {rules.days_text(ent.available)} of Birthday Compensation is left to place: choose a first or "
                "second half.",
                409,
            )
        if refusal := lock_refusal(locked, use_date):
            raise UseError("locked", refusal, 409)
        if refusal := rules.portion_refusal(rules.option_for(ent.options, use_date), portion, use_date):
            raise UseError("date_not_allowed", refusal)
        if problem := rules.hod_problem(locked, for_employee=for_employee):
            raise UseError("no_hod", problem, 409)
        use = BirthdayCompensationUse(
            employee=locked,
            birthday=birthday,
            use_date=use_date,
            portion=portion,
            days=days,
            status=BirthdayCompensationUse.STATUS_PENDING,
            reason=text
            or f"Birthday Compensation for {'my' if for_employee else 'the'} birthday, {date_text(birthday)}.",
            raised_by_role=raised_by_role,
            requested_by=raised_by_name or "",
            approval_trail=[],
        )
        try:
            with transaction.atomic():
                use.save()
        except IntegrityError:
            raise UseError(
                "already_placed",
                f"Birthday Compensation is already placed on that half of {date_text(use_date)}.",
                409,
            ) from None
        approval.notify_new_request(WORKFLOW, locked, rules.what_text(use), obj=use, dedupe=_hod_dedupe(use))
        if raised_by_role == BirthdayCompensationUse.RAISED_BY_HR:
            _notify_employee_raised(use)
    if request is not None:
        from .audit_utils import log_action

        log_action(
            request,
            "create",
            "compensation",
            record_id=use.id,
            description=(
                f"Placed Birthday Compensation for {locked.employee_code}: {rules.PORTION_PHRASE[portion]} on "
                f"{use_date.isoformat()} (birthday {birthday.isoformat()}, raised by {raised_by_role})"
            ),
            new_values={
                "useDate": use_date.isoformat(),
                "portion": portion,
                "days": str(days),
                "birthday": birthday.isoformat(),
                "reason": use.reason,
                "raisedByRole": raised_by_role,
            },
        )
    return use


def _hod_dedupe(use: BirthdayCompensationUse) -> str:
    """What the Department Head's "waiting for your approval" message is about (employee, date, portion), so raising,
    withdrawing and raising the same thing again tells the head once; raised again after a rejection is news."""
    rejected = BirthdayCompensationUse.objects.filter(
        employee_id=use.employee_id, use_date=use.use_date, portion=use.portion, status="rejected"
    ).count()
    return f"bdaycomp:{use.employee_id}:{use.use_date.isoformat()}:{use.portion}:r{rejected}"


def _notify_employee_raised(use: BirthdayCompensationUse) -> None:
    """HR placed Birthday Compensation for the employee: tell them (their phone; Phone Notify Control's Compensation
    switch, like a claim HR raised). One notification per use. Never raises."""
    from . import push_recipients
    from .compensation_notices import SOURCE_OT
    from .models import Notification

    try:
        if not push_recipients.allows(use.employee_id):
            return
        with transaction.atomic():
            Notification.objects.create(
                employee_id=use.employee_id,
                type=NOTICE_TYPE,
                title="Birthday Compensation placed for you",
                message=(
                    f"HR placed your Birthday Compensation ({rules.PORTION_PHRASE[use.portion]}) on "
                    f"{date_text(use.use_date)}, for your birthday on {date_text(use.birthday)}. It is waiting for "
                    "your Department Head, then HR."
                ),
                source=SOURCE_OT,
                dedupe_key=f"bdaycomp:{use.pk}:raised",
            )
    except IntegrityError:
        pass
    except Exception:
        logger.exception("Could not notify the Birthday Compensation %s placed by HR", getattr(use, "pk", None))


# ─────────────────────────── withdrawing ───────────────────────────


def withdraw_use(
    use_id: int, *, by_role: str, by_name: str, employee: Employee | None = None
) -> BirthdayCompensationUse:
    """A pending use -> withdrawn (its part of the 1.00 is free again). The employee withdraws only what they raised, HR
    only what HR raised (the other side's request is rejected through the pipeline instead)."""
    with transaction.atomic():
        emp_id = BirthdayCompensationUse.objects.filter(pk=use_id).values_list("employee_id", flat=True).first()
        if emp_id is None or (employee is not None and emp_id != employee.id):
            raise UseError("not_found", "Birthday Compensation request not found.", 404)
        Employee.objects.select_for_update().filter(pk=emp_id).first()
        use = _select().select_for_update(of=("self",)).get(pk=use_id)
        if by_role == BirthdayCompensationUse.RAISED_BY_EMPLOYEE and use.raised_by_role != by_role:
            raise UseError(
                "not_yours", "HR placed this Birthday Compensation for you, so only HR can withdraw it.", 403
            )
        if by_role == BirthdayCompensationUse.RAISED_BY_HR and use.raised_by_role != by_role:
            raise UseError(
                "not_yours",
                "The employee placed this Birthday Compensation themselves: only they can withdraw it (reject it "
                "instead when it is HR's turn).",
                403,
            )
        if use.status != BirthdayCompensationUse.STATUS_PENDING:
            raise UseError(
                "not_pending", f"This request is already {use.status}: only a waiting request can be withdrawn."
            )
        use.status = BirthdayCompensationUse.STATUS_WITHDRAWN
        use.withdrawn_at = timezone.now()
        use.withdrawn_by = by_name or by_role
        use.save()
    return use


# ─────────────────────────── deciding ───────────────────────────


def _approval_problem(use: BirthdayCompensationUse, today: dt.date) -> str | None:
    """Why approving `use` must be refused now (checked at every approval, under the locks): the day's payroll is
    finalized, the master switch is off (the engine would not pay it), the birthday no longer shows as worked (or was
    claimed as a credit), or the day can no longer take that portion (worked since, Casual Leave given, a holiday
    declared ...)."""
    from . import compensation_effects as effects
    from .attendance_edit import lock_refusal
    from .models import HolidayWorkClaim

    emp = use.employee
    if refusal := lock_refusal(emp, use.use_date):
        return refusal
    if not master_enabled():
        return (
            "The OT / Compensation features are switched off in Settings > Payroll, so Birthday Compensation cannot be "
            "approved right now: it would not change the attendance. Ask HR to switch them on, or reject it."
        )
    if HolidayWorkClaim.objects.filter(
        employee=emp,
        kind=HolidayWorkClaim.KIND_BIRTHDAY,
        work_date=use.birthday,
        status__in=HolidayWorkClaim.OPEN_STATUSES,
    ).exists():
        return (
            "This birthday was already claimed as a 1.00 shift credit, so its Birthday Compensation cannot be approved."
        )
    outcome = effects.birthday_outcome(emp, use.birthday, refresh=True, ignore_switches=True) or {}
    if (outcome.get("base") or outcome.get("outcome")) != effects.BIRTHDAY_CREDIT_CLAIMABLE:
        return (
            f"The attendance no longer shows the birthday ({date_text(use.birthday)}) as worked, so its Birthday "
            "Compensation cannot be approved. Reject it."
        )
    if use.use_date <= today:
        rules._refresh_month(emp, use.birthday, today)
    options = rules.day_options(emp, use.birthday, today, exclude_use_id=use.pk)
    if refusal := rules.portion_refusal(rules.option_for(options, use.use_date), use.portion, use.use_date):
        return f"{refusal} Reject this request; a new one can be made."
    return None


def decide_use(
    use_id: int,
    role: str,
    decision: str,
    actor: str,
    comment: str | None = None,
    *,
    today: dt.date | None = None,
):
    """One decision ("approved" / "rejected") by `role` (approval_workflow.HOD or HR) under the birthday_compensation
    pipeline (the Department Head, then HR). Returns (use, outcome); raises approval.ApprovalError (and
    BirthdayCompensationUse.DoesNotExist for a use that is gone). The final approval re-derives the day (apply_use); the
    employee is told like every request: the in-app notice of a step, the WhatsApp / phone decision of the end."""
    from . import whatsapp_approvals

    today = today or ist_today()
    with transaction.atomic():
        emp_id = BirthdayCompensationUse.objects.filter(pk=use_id).values_list("employee_id", flat=True).first()
        if emp_id is None:
            raise BirthdayCompensationUse.DoesNotExist(f"Birthday Compensation {use_id} not found")
        Employee.objects.select_for_update().filter(pk=emp_id).first()
        use = _select().select_for_update(of=("self",)).get(pk=use_id)
        if use.status == BirthdayCompensationUse.STATUS_WITHDRAWN:
            raise approval.ApprovalError("This request was withdrawn.", status=409, code="withdrawn")
        if decision == "approved" and approval.can_act(WORKFLOW, use, role, for_actor=False):
            if refused := _approval_problem(use, today):
                raise approval.ApprovalError(refused, status=409, code="use_refused")
        outcome = approval.decide(WORKFLOW, use, role, decision, actor=actor, comment=comment)
        now = timezone.now()
        remark = approval.clean_remark(comment) or None
        if role == approval.HOD:
            use.hod_reviewed_by, use.hod_reviewed_at, use.hod_review_comment = actor, now, remark
        else:
            use.hr_reviewed_by, use.hr_reviewed_at, use.hr_review_comment = actor, now, remark
        use.status = outcome.status
        use.save()
        tail = ""
        if outcome.final:
            tail = (
                " and it is paid in your attendance"
                if use.use_date <= today
                else " and it will be paid in your attendance on the day"
            )
        approval.stage_notice(
            use.employee, NOTICE_TYPE, approval.notice_for(rules.what_text(use), outcome, tail), outcome
        )
    if outcome.final:
        apply_use(use, today=today)
    if outcome.final or outcome.rejected:
        whatsapp_approvals.notify_decision(
            WORKFLOW, use, decision, approver=actor, role=approval.LEGACY_ROLE[role], comment=remark
        )
    return use, outcome


def apply_use(use: BirthdayCompensationUse, *, today: dt.date | None = None) -> None:
    """After the final approval: a day that has come is worked out again now (a day HR had fixed by hand is released
    first - the approval is the newer decision); a later day is worked out when it comes (the engine reads the approved
    use whenever it computes the day). Never a finalized (Payroll Done) month. Never raises."""
    from .attendance_edit import lock_refusal
    from .attendance_final import compute_range_records
    from .models import AttendanceDayRecord

    today = today or ist_today()
    emp = use.employee
    if use.use_date > today or lock_refusal(emp, use.use_date):
        return
    try:
        with transaction.atomic():
            AttendanceDayRecord.objects.filter(employee=emp, date=use.use_date, source="manual").update(source="auto")
            compute_range_records(emp, use.use_date, use.use_date)
    except Exception:
        logger.exception("Applying Birthday Compensation %s to %s failed", use.pk, use.use_date)

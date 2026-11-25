"""
What a compensation claim does to attendance, and the attendance-side rules the claims need (2026-11-19 spec).

    after_claim_decided(claim)     called by compensation_claims.decide AFTER the commit:
                                     ot_allowance approved -> re-derive the stored day of the next working day after the
                                       OT date (the allowance now applies to it, exactly like the old automatic allowance;
                                       compensation_engine reads the approved claim), unless that day is in the future
                                       (it is judged when it comes), set by hand, or in a locked / Payroll Done month
                                     use_balance approved  -> relax the used date (compensation_apply.apply_relaxation; the
                                       ledger debit BE-1 wrote is what the engine tops the day up from)
                                     holiday_work / ot_shift / birthday / a rejection -> nothing (a balance credit only)
    check_claim_effects(claim)     the refusal reason BEFORE approving, or None:
                                     ot_allowance: no working day follows the OT date, or that day's payroll month is
                                       locked / Payroll Done, or (a day that already happened) HR set it by hand
                                     use_balance: compensation_apply.check_relaxation_day (a working day, not already a
                                       full paid day, the day's total at most 1.00) and the day's month not locked
    next_working_day(emp, date)    the first working day after `date` (the day a Type 1 allowance applies to)
    staff_ot_credit(emp, date, m)  the Type 2 credit by the quarters rule: OT minutes / the employee's working shift length
                                   (shift end - start - lunch, from their shift on that date) in quarters, rounded DOWN,
                                   capped at 1.00; Decimal("0.00") below a quarter, without a shift length, before
                                   CompensationConfig.claims_from or with the quarters rule switched off that day
    quarter_rule_applies(emp, d)   whether staff_ot_credit decides the credit (else the detection's suggested shifts: the
                                   old ladder); below a quarter under the rule is NOT the ladder's, it is nothing
    birthday_outcome(emp, date)    what a birthday gives (BIRTHDAY_* below) from the actual attendance and the claims
    birthday_outcomes(pairs)       the same for many (employee, date) pairs with a fixed handful of queries (HR lists)

Rules apply only from the effective dates (CompensationConfig.claims_apply_on(day), the staff next-morning rule's own
from-date in shift_engine); earlier days keep the old rules even when recomputed. Re-derivation only through the
existing refresh path (attendance_final.compute_range_records, which never touches a manual day), never in a locked month;
payroll is never regenerated. compensation_claims is imported lazily where needed (it imports this module lazily too).
"""

from __future__ import annotations

import datetime as dt
import logging
from decimal import Decimal
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from .models import Employee, HolidayWorkClaim

logger = logging.getLogger(__name__)

ZERO = Decimal("0.00")
ONE = Decimal("1.00")

# birthday_outcome()["outcome"] values. "base" is the attendance part alone (the first six); the claim states replace a
# credit_claimable base when a birthday claim exists.
BIRTHDAY_PAID_LEAVE = "paid_leave"  # not worked (no punch / approved leave): a paid birthday leave, no balance used
BIRTHDAY_CREDIT_CLAIMABLE = "credit_claimable"  # worked (present or half day): one 1.00 credit to claim
BIRTHDAY_CREDIT_PENDING = "credit_pending"  # its claim waits for the HOD
BIRTHDAY_CREDIT_APPROVED = "credit_approved"  # its claim was approved (1.00 in the balance)
BIRTHDAY_CREDIT_REJECTED = "credit_rejected"  # its latest claim was rejected
BIRTHDAY_UPCOMING = "upcoming"  # a birthday still to come
BIRTHDAY_OFF_DAY = (
    "off_day"  # a Sunday / company holiday / off Saturday: no birthday benefit (working it is holiday work)
)
BIRTHDAY_NOT_ELIGIBLE = "not_eligible"  # switched off, not staff / active, not the birthday, before joining ...
BIRTHDAY_OLD_RULE = "old_rule"  # before CompensationConfig.claims_from: the old automatic paid birthday

_CLAIM_OUTCOME = {
    "pending": BIRTHDAY_CREDIT_PENDING,
    "approved": BIRTHDAY_CREDIT_APPROVED,
    "rejected": BIRTHDAY_CREDIT_REJECTED,
}


def _date_text(day: dt.date) -> str:
    return day.strftime("%a %d %b %Y").replace(" 0", " ")


# ── payroll locks ──────────────────────────────────────────────────────────


def month_locked(day: dt.date) -> bool:
    """Is `day`'s staff payroll month finalized (Payroll Done)? Then its attendance can no longer change."""
    from .payroll_month_workflow import is_locked

    return is_locked(day.month, day.year)


def _locked_text(day: dt.date, what: str) -> str:
    from .payroll_month_workflow import month_label

    return (
        f"{month_label(day.month, day.year)} payroll is finalized (Payroll Done), so the attendance of "
        f"{_date_text(day)} can no longer change: {what} cannot be approved."
    )


# ── what approving a claim changes ─────────────────────────────────────────


def after_claim_decided(claim: HolidayWorkClaim) -> None:
    """Re-derives the attendance a decided claim changes (see the module docstring). Called after the decision's
    transaction committed (transaction.on_commit); never raises for a refresh problem (logs it)."""
    from .models import HolidayWorkClaim

    try:
        if claim.status != HolidayWorkClaim.STATUS_APPROVED:
            return
        if claim.kind == HolidayWorkClaim.KIND_OT_ALLOWANCE:
            _apply_allowance(claim)
        elif claim.kind == HolidayWorkClaim.KIND_USE_BALANCE:
            _apply_use_balance(claim)
    except Exception:
        logger.exception("Applying the effect of compensation claim %s (%s) failed", claim.pk, claim.kind)


def _apply_allowance(claim: HolidayWorkClaim) -> None:
    """The allowance applies to the next working day after the OT date: re-derive that stored day when it has already
    come (today or earlier). The engine reads the approved claim (compensation_engine.allowance_for_arrival); a manual day
    is never recomputed (compute_day_record returns it as it is) and a locked month is left alone."""
    from .attendance_final import compute_range_records
    from .clock import ist_today
    from .models import PayrollSettings

    emp = claim.employee
    day = next_working_day(emp, claim.work_date)
    if day is None or day > ist_today() or month_locked(day):
        return
    compute_range_records(emp, day, day, PayrollSettings.get())


def _apply_use_balance(claim: HolidayWorkClaim) -> None:
    """The day off from the balance: the debit is already written; make it show on the day now (a future day is topped
    up when it comes; a day set by hand is topped up in place, once)."""
    from .compensation_apply import apply_relaxation

    if month_locked(claim.work_date):
        return
    apply_relaxation(claim.employee, claim.work_date, Decimal(claim.shifts), "the compensation balance")


def check_claim_effects(claim: HolidayWorkClaim) -> str | None:
    """A plain sentence when approving `claim` must be refused because of what it would change (no working day to apply
    an allowance to, a manual day, a locked / Payroll Done month, not a working day, more than 1.00 shift on the day ...),
    else None. Only ot_allowance and use_balance change attendance; the credit kinds never refuse here."""
    from .models import HolidayWorkClaim

    if claim.kind == HolidayWorkClaim.KIND_OT_ALLOWANCE:
        return _allowance_problem(claim)
    if claim.kind == HolidayWorkClaim.KIND_USE_BALANCE:
        return _use_balance_problem(claim)
    return None


def _allowance_problem(claim: HolidayWorkClaim) -> str | None:
    from .clock import ist_today
    from .models import AttendanceDayRecord

    emp = claim.employee
    day = next_working_day(emp, claim.work_date)
    if day is None:
        return (
            f"No working day follows {_date_text(claim.work_date)} within the next days, so the late-in allowance has "
            "no day to apply to."
        )
    if month_locked(day):
        return _locked_text(day, "a late-in allowance for it")
    if day <= ist_today():
        manual = AttendanceDayRecord.objects.filter(employee=emp, date=day, source="manual").exists()
        if manual:
            return (
                f"HR set the attendance of {_date_text(day)} by hand, so the late-in allowance cannot be applied to it: "
                "ask HR to correct that day instead."
            )
    return None


def _use_balance_problem(claim: HolidayWorkClaim) -> str | None:
    from .compensation_apply import RelaxationRefused, check_relaxation_day

    day = claim.work_date
    if month_locked(day):
        return _locked_text(day, "a day off from the balance")
    try:
        check_relaxation_day(claim.employee, day, Decimal(claim.shifts))
    except RelaxationRefused as exc:
        return str(exc)
    return None


# ── the attendance-side rules the claims need ──────────────────────────────


def next_working_day(employee: Employee, date: dt.date, assignments=None) -> dt.date | None:
    """The first working day after `date` for `employee` (skips Sundays, company holidays and an off Saturday), or
    None when none is found within the look-ahead (compensation_rules.LOOKBACK_DAYS)."""
    from .overtime import next_working_day as _next_working_day

    return _next_working_day(employee, date, assignments)


def staff_ot_credit(employee: Employee, date: dt.date, extra_minutes: int, *, shift=None, config=None) -> Decimal:
    """The Type 2 credit of a staff OT day by the quarters rule (compensation_rules.quarter_credit): extra_minutes / the
    employee's working shift length on `date` (end - start - lunch), in quarters (0.25 / 0.50 / 0.75 / 1.00), rounded
    down, capped at 1.00. Decimal("0.00") below a quarter, for a non-staff employee, without a shift, for a day before
    CompensationConfig.claims_from or with the quarters rule off (the detection then suggests by the old ladder).
    `shift` / `config`, when the caller has them, save the lookups."""
    from . import compensation_engine as comp
    from . import compensation_rules as rules
    from .models import CompensationConfig
    from .shift_engine import _get_shift_for_date

    if getattr(employee, "employment_type", None) != "staff":
        return ZERO
    config = config or CompensationConfig.get()
    if not config.ot_quarter_rule_on(date):
        return ZERO
    if shift is None:
        shift = _get_shift_for_date(employee, date)
    return rules.quarter_credit(int(extra_minutes or 0), comp.shift_working_minutes(shift))


def quarter_rule_applies(employee: Employee, date: dt.date, *, shift=None, config=None) -> bool:
    """Does the quarters rule decide the Type 2 credit of `employee`'s OT on `date`? A staff employee, a day the rule was
    on (CompensationConfig.ot_quarter_rule_on: from claims_from, by its dated history) and a shift whose working length
    is known. True = staff_ot_credit IS the credit (0.00 below a quarter: nothing to claim); False = the old ladder (the
    detection's suggested shifts) decides."""
    from . import compensation_engine as comp
    from .models import CompensationConfig
    from .shift_engine import _get_shift_for_date

    if getattr(employee, "employment_type", None) != "staff":
        return False
    config = config or CompensationConfig.get()
    if not config.ot_quarter_rule_on(date):
        return False
    if shift is None:
        shift = _get_shift_for_date(employee, date)
    return comp.shift_working_minutes(shift) > 0


# ── birthdays ──────────────────────────────────────────────────────────────


def _result(outcome: str, message: str, day: dt.date, shifts=None, **extra) -> dict:
    return {
        "outcome": outcome,
        "base": outcome,
        "message": message,
        "shifts": shifts,
        "date": day,
        "claim": None,
        "claimable": False,
        "dayStatus": None,
        **extra,
    }


def punch_logs_around(pairs) -> dict:
    """{(employee_id, date): [AttendanceLog, ...]} of the days of `pairs` ((employee, date)) and the day before and after
    each, oldest punch first: what worked_days (and resolve_day_punch_logs) need, in one query."""
    from .models import AttendanceLog

    emp_ids = {emp.pk for emp, _d in pairs}
    near = {day + dt.timedelta(days=k) for _e, day in pairs for k in (-1, 0, 1)}
    logs: dict = {}
    if not emp_ids:
        return logs
    for log in AttendanceLog.objects.filter(employee_id__in=emp_ids, date__in=near).order_by("punch_time", "id"):
        logs.setdefault((log.employee_id, log.date), []).append(log)
    return logs


def worked_days(pairs, settings=None, *, logs: dict | None = None, assignments: dict | None = None) -> set:
    """{(employee_id, date)} of the (employee, date) pairs the employee WORKED, read exactly the way the attendance engine
    reads a day (attendance_final.compute_day_record's day_times / has_manual): the day's own punches after the
    cross-midnight reattribution (shift_engine.resolve_day_punch_logs: an early punch that closes the previous night is
    the previous day's; the next morning's early punch that closes this day's open session is this day's), or a manual
    presence row (Attendance present=True) on a day with no punch of its own. A birthday whose only punch closes the
    previous night is therefore NOT worked (it is paid birthday leave), and a manual Casual Leave day the employee then
    came in on IS worked. The one "was the birthday worked?" answer cl_balance (free Casual Leave on an unworked new-rule
    birthday) and birthday_outcomes (credit to claim / paid leave) share (verification 2026-11-19, correctness #1 / #2).
    `logs` (punch_logs_around) and `assignments` ({employee_id: [EmployeeShiftAssignment]}), when the caller read them
    already, save their queries; otherwise one query each, plus one for the presence rows of the days with no punch."""
    from .models import Attendance, EmployeeShiftAssignment, PayrollSettings
    from .shift_engine import resolve_day_punch_logs

    pairs = [(emp, day) for emp, day in pairs]
    out: set = set()
    if not pairs:
        return out
    settings = settings or PayrollSettings.get()
    if logs is None:
        logs = punch_logs_around(pairs)
    if assignments is None:
        assignments = {}
        latest = max(day for _e, day in pairs) + dt.timedelta(days=1)
        for a in (
            EmployeeShiftAssignment.objects.filter(
                employee_id__in={e.pk for e, _d in pairs}, effective_from__lte=latest
            )
            .select_related("shift")
            .order_by("effective_from")
        ):
            assignments.setdefault(a.employee_id, []).append(a)
    no_punch = []
    for emp, day in pairs:
        own = logs.get((emp.pk, day), [])
        following = logs.get((emp.pk, day + dt.timedelta(days=1)), [])
        if own or following:
            around = {
                d: logs.get((emp.pk, d), []) for d in (day - dt.timedelta(days=1), day, day + dt.timedelta(days=1))
            }
            resolved = resolve_day_punch_logs(
                emp, day, list(own), settings, assignments=assignments.get(emp.pk, []), logs_by_date=around
            )
            if resolved:
                out.add((emp.pk, day))
                continue
            if own:
                # every punch of the day closes the previous night: the punch ingest's presence row does not make it a
                # worked day either (attendance_final clears has_manual the same way)
                continue
        no_punch.append((emp, day))
    if no_punch:
        presence = set(
            Attendance.objects.filter(
                employee_id__in={e.pk for e, _d in no_punch},
                date__in=[d.isoformat() for _e, d in no_punch],
                present=True,
            ).values_list("employee_id", "date")
        )
        out |= {(emp.pk, day) for emp, day in no_punch if (emp.pk, day.isoformat()) in presence}
    return out


def day_worked(employee: Employee, day: dt.date, settings=None) -> bool:
    """worked_days for one employee and day."""
    return (employee.pk, day) in worked_days([(employee, day)], settings)


def birthday_outcome(
    employee: Employee, date: dt.date, *, refresh: bool = False, ignore_switches: bool = False
) -> dict:
    """What `employee`'s birthday on `date` gives, from their actual attendance and their birthday claim:
    {"outcome": one of the BIRTHDAY_* values, "base": the attendance part alone (paid_leave / credit_claimable /
    upcoming / off_day / not_eligible / old_rule), "message": a plain sentence, "shifts": Decimal("1.00") for a paid leave
    or a credit (else None), "date", "claim": {id, status, kind, shifts} of the latest birthday claim or None,
    "claimable": True when a credit can be claimed now (worked, no pending / approved claim; a rejected one may be claimed
    again), "dayStatus": the stored day's status or None}. `refresh` / `ignore_switches`: see birthday_outcomes."""
    return birthday_outcomes([(employee, date)], refresh=refresh, ignore_switches=ignore_switches)[(employee.pk, date)]


def birthday_outcomes(
    pairs, today: dt.date | None = None, *, refresh: bool = False, ignore_switches: bool = False
) -> dict:
    """{(employee_id, date): birthday_outcome dict} for many (employee, date) pairs: the settings, the shift assignments,
    the stored days and the claims are each read once.

    A day that has come but has no stored record yet (or a stale one: absent although it has punches now, present
    although it has none ...) is computed through the normal refresh path (compute_range_records) ONLY when `refresh` is
    set (a caller that may write: an HR login with Edit on Compensation, the employee's own page, a claim being raised or
    approved) and the day's payroll month is not finalized (Payroll Done). Otherwise the answer comes from the stored row
    as it is, or says the day is not worked out yet: a read never rewrites attendance (security review 2026-11-19).

    `ignore_switches`: answer from the attendance even with the master / birthday switch off (the approval re-check of a
    birthday credit: a credit kind stays decidable with the switches off, like holiday work and OT credits; verification
    2026-11-19, security #2). Whether the day was worked comes from worked_days."""
    from . import compensation_engine as comp
    from . import compensation_rules as rules
    from .attendance_final import compute_range_records
    from .clock import ist_today
    from .models import (
        AttendanceDayRecord,
        CompensationConfig,
        EmployeeShiftAssignment,
        HolidayWorkClaim,
        PayrollSettings,
    )

    pairs = [(emp, day) for emp, day in pairs]
    out: dict = {}
    if not pairs:
        return out
    today = today or ist_today()
    settings = PayrollSettings.get()
    config = CompensationConfig.get()
    master = bool(settings.compensation_feature_enabled)

    emp_ids = {emp.pk for emp, _d in pairs}
    days = {d for _e, d in pairs}
    assignments: dict = {}
    for a in (
        EmployeeShiftAssignment.objects.filter(employee_id__in=emp_ids, effective_from__lte=max(days))
        .select_related("shift")
        .order_by("effective_from")
    ):
        assignments.setdefault(a.employee_id, []).append(a)

    candidates = []  # (emp, day) whose answer depends on the stored day
    for emp, day in pairs:
        key = (emp.pk, day)
        if not master and not ignore_switches:
            out[key] = _result(
                BIRTHDAY_NOT_ELIGIBLE, "The OT / Compensation features are switched off in Settings.", day
            )
            continue
        if not config.birthday_enabled and not ignore_switches:
            out[key] = _result(BIRTHDAY_NOT_ELIGIBLE, "Birthday compensation is switched off in Settings.", day)
            continue
        if emp.employment_type != "staff" or emp.status != "active":
            out[key] = _result(BIRTHDAY_NOT_ELIGIBLE, "Birthday compensation is for active staff employees only.", day)
            continue
        if not rules.is_birthday(emp.date_of_birth, day):
            out[key] = _result(BIRTHDAY_NOT_ELIGIBLE, f"{_date_text(day)} is not this employee's birthday.", day)
            continue
        effective = config.birthday_effective_from
        if effective and day < effective:
            out[key] = _result(
                BIRTHDAY_NOT_ELIGIBLE,
                f"Birthday compensation starts on {_date_text(effective)}, after this birthday.",
                day,
            )
            continue
        joined = comp._parse_join_date(emp.join_date)
        if joined is not None and day < joined:
            out[key] = _result(BIRTHDAY_NOT_ELIGIBLE, "This birthday is before the employee joined.", day)
            continue
        if comp.is_off_day(emp, day, assignments.get(emp.pk, [])):
            out[key] = _result(
                BIRTHDAY_OFF_DAY,
                f"{_date_text(day)} is a day off (Sunday, company holiday or off Saturday), so the birthday gives no "
                "leave or credit; working it counts as holiday work.",
                day,
            )
            continue
        if not config.birthday_claims_apply_on(day):
            out[key] = _result(
                BIRTHDAY_OLD_RULE,
                "Before the claim rules started, a birthday on a working day was paid automatically.",
                day,
                shifts=ONE,
            )
            continue
        if day > today:
            out[key] = _result(
                BIRTHDAY_UPCOMING,
                "Still to come: absent on the birthday = paid birthday leave; present = one shift to claim.",
                day,
            )
            continue
        candidates.append((emp, day))

    if not candidates:
        return out

    cand_emps = {e.pk for e, _d in candidates}
    cand_days = {d for _e, d in candidates}
    records = {
        (r.employee_id, r.date): r
        for r in AttendanceDayRecord.objects.filter(employee_id__in=cand_emps, date__in=cand_days)
    }
    # the punches of the days and the day before / after each (one query): what is stale here, and what worked_days reads
    logs = punch_logs_around(candidates)
    punched = {(emp_id, d) for (emp_id, d), rows in logs.items() if rows and d in cand_days}
    locked: dict = {}  # (year, month) -> Payroll Done? (read once per month)
    for emp, day in candidates:
        rec = records.get((emp.pk, day))
        # A stored verdict that may predate the day's punches is worked out again: an absent / on-leave day without the
        # birthday marker (computed before the rule), a birthday leave (no punch) on a day that has punches now (the
        # employee came in after the morning's computation), or a present / half day that has no punch any more (its
        # punches were corrected away and the day was not worked out again, e.g. a big Punch View import; verification
        # 2026-11-19, correctness #5).
        stale = (
            rec is not None
            and rec.source != "manual"
            and (
                (
                    rec.compensation_kind != comp.KIND_BIRTHDAY
                    and rec.status in (AttendanceDayRecord.STATUS_ABSENT, "on_leave")
                )
                or (rec.compensation_kind == comp.KIND_BIRTHDAY and (emp.pk, day) in punched)
                or (
                    rec.compensation_kind != comp.KIND_BIRTHDAY
                    and rec.status in (AttendanceDayRecord.STATUS_PRESENT, AttendanceDayRecord.STATUS_HALF)
                    and (emp.pk, day) not in punched
                )
            )
        )
        month = (day.year, day.month)
        if (rec is None or stale) and refresh and month not in locked:
            locked[month] = month_locked(day)
        if (rec is None or stale) and refresh and not locked[month]:
            try:
                computed = compute_range_records(emp, day, day, settings)
                rec = computed[0] if computed else rec
            except Exception:
                logger.exception("Computing the birthday of employee %s on %s failed", emp.pk, day)
        records[(emp.pk, day)] = rec

    claims: dict = {}
    for claim in HolidayWorkClaim.objects.filter(
        kind=HolidayWorkClaim.KIND_BIRTHDAY,
        employee_id__in={e.pk for e, _d in candidates},
        work_date__in={d for _e, d in candidates},
    ).order_by("id"):
        claims[(claim.employee_id, claim.work_date)] = claim  # the latest one wins

    worked = worked_days(candidates, settings, logs=logs, assignments=assignments)
    for emp, day in candidates:
        key = (emp.pk, day)
        rec = records.get(key)
        result = _birthday_from_day(rec, day, today, worked=key in worked)
        claim = claims.get(key)
        if claim is not None:
            result["claim"] = {
                "id": claim.pk,
                "status": claim.status,
                "kind": claim.kind,
                "shifts": claim.shifts,
            }
            if claim.status == HolidayWorkClaim.STATUS_APPROVED and result["base"] != BIRTHDAY_CREDIT_CLAIMABLE:
                # an approved credit stays what HR's list and the employee see, whatever the day shows now (its punches
                # may have been corrected away since; one benefit per birthday: the day is then never paid leave too;
                # verification 2026-11-19)
                result["outcome"] = BIRTHDAY_CREDIT_APPROVED
                result["message"] = (
                    "The birthday credit was approved (1.00 shift added to the compensation balance), although the "
                    "day no longer shows as worked."
                )
            elif result["base"] == BIRTHDAY_CREDIT_CLAIMABLE:
                result["outcome"] = _CLAIM_OUTCOME.get(claim.status, result["outcome"])
                result["message"] = {
                    BIRTHDAY_CREDIT_PENDING: "Worked on the birthday: the credit claim waits for the Department Head.",
                    BIRTHDAY_CREDIT_APPROVED: "Worked on the birthday: the credit claim was approved (1.00 shift added "
                    "to the compensation balance).",
                    BIRTHDAY_CREDIT_REJECTED: "Worked on the birthday: the credit claim was rejected.",
                }.get(result["outcome"], result["message"])
        result["claimable"] = result["base"] == BIRTHDAY_CREDIT_CLAIMABLE and (
            claim is None or claim.status == HolidayWorkClaim.STATUS_REJECTED
        )
        out[key] = result
    return out


def _birthday_from_day(rec, day: dt.date, today: dt.date | None = None, worked: bool | None = None) -> dict:
    """The attendance part of a birthday's outcome from its stored day (new rule, a working day that has come). TODAY's
    birthday with no punch yet is still to be decided (BIRTHDAY_UPCOMING): it becomes paid birthday leave only once the day
    is over (attendance_final), or a credit to claim as soon as the employee punches. `worked` is worked_days' answer (the
    punches as the engine reads them, never the stored row's possibly stale fields); None = read the row's own fields."""
    from . import compensation_engine as comp

    if rec is None:
        return _result(
            BIRTHDAY_NOT_ELIGIBLE,
            "The attendance of the birthday has not been worked out yet: it shows once the day's attendance is.",
            day,
        )
    status = rec.status
    if worked is None:
        worked = bool(rec.first_punch or rec.total_punches)
    if (
        today is not None
        and day >= today
        and not worked
        and rec.source != "manual"
        and rec.compensation_kind != comp.KIND_BIRTHDAY
        and status in ("absent", "on_leave")
    ):
        return _result(
            BIRTHDAY_UPCOMING,
            "Today, no punch yet: if the employee does not come in it becomes paid birthday leave after the day; "
            "if they come in, one shift can be claimed.",
            day,
            dayStatus=status,
        )
    # the birthday marker is the engine's; a day set by hand that pays less than a full day is NOT a paid birthday leave,
    # whatever marker it still carries (e.g. a rejected Casual Leave written over it; correctness review 2026-11-19)
    marker_trusted = not (rec.source == "manual" and Decimal(rec.shifts_earned or 0) < ONE)
    if rec.compensation_kind == comp.KIND_BIRTHDAY and marker_trusted:
        return _result(
            BIRTHDAY_PAID_LEAVE,
            "Not worked on the birthday: paid birthday leave (a full paid day, no leave balance used).",
            day,
            shifts=ONE,
            dayStatus=status,
        )
    if status in ("present", "half_shift") and (worked or rec.source != "manual"):
        return _result(
            BIRTHDAY_CREDIT_CLAIMABLE,
            "Worked on the birthday: one paid day (1.00 shift) can be claimed for another day.",
            day,
            shifts=ONE,
            dayStatus=status,
        )
    if rec.source == "manual" and status == "present" and Decimal(rec.shifts_earned or 0) >= ONE:
        # an approved full-day Casual Leave (or HR marking a paid day by hand) without a punch: already a paid day off
        return _result(
            BIRTHDAY_PAID_LEAVE,
            "Not worked on the birthday: the day is already paid (set by HR, e.g. an approved Casual Leave).",
            day,
            shifts=ONE,
            dayStatus=status,
            viaManualDay=True,
        )
    if status == "holiday":
        return _result(
            BIRTHDAY_OFF_DAY,
            "The birthday is marked as a holiday, so it gives no leave or credit.",
            day,
            dayStatus=status,
        )
    if rec.source == "manual":
        return _result(
            BIRTHDAY_NOT_ELIGIBLE,
            "HR set the attendance of the birthday by hand, so the birthday leave is not applied to it.",
            day,
            dayStatus=status,
        )
    return _result(
        BIRTHDAY_NOT_ELIGIBLE,
        "The birthday's attendance does not give birthday leave or a credit.",
        day,
        dayStatus=status,
    )

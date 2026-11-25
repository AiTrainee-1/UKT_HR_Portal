"""
Compensation claims: the one claim workflow for every kind (2026-11-19 spec, owner decisions 1-4).

    detection says what is claimable -> the employee (mobile app / Employee Web App) or HR on their behalf raises a claim
    -> the employee's Department Head decides (approval workflow `holiday_work`, flag can_approve_compensation)
    -> approval: a credit to the compensation balance (holiday_work / ot_shift / birthday), the Type 1 allowance applied
       to the next working day (ot_allowance), or a debit + a relaxed day (use_balance)

Every claim is a HolidayWorkClaim row (the table keeps its name): `kind`, `work_date` (the claim's date for every kind),
`shifts`, `overtime_record` + `minutes` (ot_*), `raised_by_role` (hr | employee). The database allows one open
(pending / approved) claim per employee + kind + date and one per OT record; CompensationLedger allows one credit and one
debit per claim (migration 0166).

The rules a claim must pass (each refusal is a ClaimError with a plain sentence and a code the apps branch on):

  * switched_off (403)  the OT / Compensation master switch, the kind's own switch in Settings -> Compensation
                        (holiday_work_enabled / allowance_enabled / shift_enabled / birthday_enabled; using the balance
                        needs only the master) and the `holiday_work` approval workflow must be on
  * not_staff (403)     compensation is for staff; not_eligible (400) for an inactive employee
  * too_old (400)       ot_* / birthday / holiday work: the date must be in the last CLAIM_WINDOW_DAYS days (and not in
                        the future: not_eligible); use_balance: today or later is fine (the employee apps are held to the
                        request window by the view)
  * not_eligible (400)  the kind's own evidence: worked that Sunday / holiday; a detected Type 1 allowance (ot_allowance)
                        or an undecided Type 2 record with a credit by the quarters rule (ot_shift, shifts <= the credit);
                        a birthday the attendance says was worked (compensation_effects.birthday_outcome ==
                        credit_claimable); ot_* and birthday only from CompensationConfig.claims_from on (before it they
                        were automatic / HR's); use_balance: a working day the balance (minus what is already asked for)
                        covers, that compensation_effects.check_claim_effects does not refuse
  * already_claimed (409) one open claim per employee, kind and date, and per OT record
  * no_hod (409)        the employee must have a Department Head (not themselves) who may approve compensation
  * invalid (400)       shifts outside 0.25 / 0.50 / 0.75 / 1.00, a missing reason where one is needed

What happens to attendance after a decision (re-deriving the next working day, relaxing the used day) and the refusals
that depend on attendance / payroll state live in compensation_effects.py (BE-2): `decide` calls
`compensation_effects.check_claim_effects(claim)` before approving and `compensation_effects.after_claim_decided(claim)`
after the commit. compensation_effects is imported lazily (inside the functions) to keep the import graph free of cycles.

An approved ot_shift claim also marks its OvertimeRecord decided (announced, relaxation into the balance, no claim date:
exactly what HR's old "relaxation without a date" announce wrote), so HR's Type 2 Pay / Assign can never pay the same OT a
second time; a record HR already decided can never be claimed (the claim is refused, and so is its approval).
"""

from __future__ import annotations

import datetime as dt
import logging
from dataclasses import dataclass, field, replace
from datetime import timedelta
from decimal import Decimal
from typing import TYPE_CHECKING

from django.db import IntegrityError, transaction
from django.db.models import Count, Max, Q, Sum
from django.utils import timezone

from . import approval_workflow as approval
from .clock import ist_today
from .compensation_shared import (
    SHIFT_TEXT,
    birthday_in_year,
    date_text,
    day_kind,
    employee_json,
    full_name,
    holiday_names,
    master_enabled,
    parse_shifts,
    shifts_text,
)
from .models import (
    CompensationConfig,
    CompensationLeaveCredit,
    CompensationLedger,
    Employee,
    HolidayWorkClaim,
    OvertimeRecord,
)

if TYPE_CHECKING:
    from rest_framework.request import Request

logger = logging.getLogger(__name__)

WORKFLOW = "holiday_work"
ZERO = Decimal("0.00")
ONE = Decimal("1.00")
MAX_REASON_LENGTH = 500
# HR asking, on an employee's behalf, to use the balance: how far ahead the day off may be (the employee apps are held
# to the request window instead).
USE_AHEAD_DAYS = 90

# Plain labels of the claim kinds (the apps and the HR portal show them; the HOD's list too).
KIND_LABELS: dict[str, str] = dict(HolidayWorkClaim.KIND_CHOICES)

# Kinds an employee may raise from the apps with POST /api/employee/compensation/claims (use_balance has its own call).
EMPLOYEE_CLAIM_KINDS: tuple[str, ...] = (
    HolidayWorkClaim.KIND_HOLIDAY_WORK,
    HolidayWorkClaim.KIND_OT_ALLOWANCE,
    HolidayWorkClaim.KIND_OT_SHIFT,
    HolidayWorkClaim.KIND_BIRTHDAY,
)
ALL_KINDS: tuple[str, ...] = tuple(KIND_LABELS)

# A claim can be raised for something that happened in the last CLAIM_WINDOW_DAYS days (the apps show it as
# `claimWindowDays`); the same limit holiday_work_views.MAX_CLAIM_AGE_DAYS has always had.
CLAIM_WINDOW_DAYS = 45

# The Settings -> Compensation switch each kind needs (use_balance needs only the master switch).
SWITCH_FIELDS: dict[str, str | None] = {
    HolidayWorkClaim.KIND_HOLIDAY_WORK: "holiday_work_enabled",
    HolidayWorkClaim.KIND_OT_ALLOWANCE: "allowance_enabled",
    HolidayWorkClaim.KIND_OT_SHIFT: "shift_enabled",
    HolidayWorkClaim.KIND_BIRTHDAY: "birthday_enabled",
    HolidayWorkClaim.KIND_USE_BALANCE: None,
}
SWITCH_NAMES = {
    HolidayWorkClaim.KIND_HOLIDAY_WORK: "Sunday / holiday work compensation",
    HolidayWorkClaim.KIND_OT_ALLOWANCE: "The OT late-in allowance (Type 1)",
    HolidayWorkClaim.KIND_OT_SHIFT: "OT shift compensation (Type 2)",
    HolidayWorkClaim.KIND_BIRTHDAY: "Birthday compensation",
}

# The ledger source an approved claim of a credit kind writes.
CREDIT_SOURCES = {
    HolidayWorkClaim.KIND_HOLIDAY_WORK: CompensationLedger.SOURCE_HOLIDAY_WORK,
    HolidayWorkClaim.KIND_OT_SHIFT: CompensationLedger.SOURCE_OT_SHIFT,
    HolidayWorkClaim.KIND_BIRTHDAY: CompensationLedger.SOURCE_BIRTHDAY,
}
SOURCE_LABELS = {
    CompensationLedger.SOURCE_HOLIDAY_WORK: "Sunday / holiday work",
    CompensationLedger.SOURCE_OT_SHIFT: "OT shift credit",
    CompensationLedger.SOURCE_BIRTHDAY: "Birthday credit",
    CompensationLedger.SOURCE_REDEMPTION: "Used",
    CompensationLedger.SOURCE_LEGACY_CREDIT: "Earlier Alternative Day credit",
}

CLAIM_STATUS_LABELS = {
    HolidayWorkClaim.STATUS_PENDING: "Waiting for the Department Head",
    HolidayWorkClaim.STATUS_APPROVED: "Approved",
    HolidayWorkClaim.STATUS_REJECTED: "Not approved",
}

OPEN = HolidayWorkClaim.OPEN_STATUSES

# Holiday work on the employee's OWN off day that is neither a Sunday nor a declared holiday: an off Saturday (the shift
# assignment's saturday_off; owner decision 4: working a day off is ordinary holiday work).
OFF_SATURDAY = "off_saturday"
OFF_SATURDAY_LABEL = "Off Saturday"

# What the reason a Department Head reads starts with, for every kind but holiday work (claim_json for_role="hod").
HOD_REASON_PREFIX = {
    HolidayWorkClaim.KIND_OT_ALLOWANCE: "OT late-in allowance (nothing is added to the balance)",
    HolidayWorkClaim.KIND_OT_SHIFT: "OT shift credit",
    HolidayWorkClaim.KIND_BIRTHDAY: "Birthday credit",
    HolidayWorkClaim.KIND_USE_BALANCE: "Use of compensation balance (a day off taken from the balance)",
}


class ClaimError(Exception):
    """A claim refused with a plain sentence. `code` is the machine-readable reason the apps branch on (not_eligible,
    too_old, not_staff, already_claimed, switched_off, no_hod, ...), `status` the HTTP status the view answers with."""

    def __init__(self, code: str, message: str, status: int = 400):
        super().__init__(message)
        self.code = code
        self.message = message
        self.status = status

    def as_json(self) -> dict:
        return {"error": self.message, "code": self.code}


def _effects():
    from . import compensation_effects

    return compensation_effects


# ─────────────────────────── small helpers ───────────────────────────


def _hhmm(value) -> str | None:
    return value.strftime("%H:%M") if value else None


def _iso(value) -> str | None:
    return value.isoformat() if value else None


def what_text(claim: HolidayWorkClaim) -> str:
    """The phrase the notices use: "holiday-work compensation claim for Sunday 11 Oct 2026" (the holiday-work wording is
    the one the HOD notifications always had)."""
    when = date_text(claim.work_date)
    kind = claim.kind
    if kind == HolidayWorkClaim.KIND_OT_ALLOWANCE:
        return f"OT late-in allowance claim for {when}"
    if kind == HolidayWorkClaim.KIND_OT_SHIFT:
        return f"OT shift compensation claim for {when}"
    if kind == HolidayWorkClaim.KIND_BIRTHDAY:
        return f"birthday compensation claim for {when}"
    if kind == HolidayWorkClaim.KIND_USE_BALANCE:
        return f"request to use {shifts_text(claim.shifts)} shift of the compensation balance on {when}"
    return f"holiday-work compensation claim for {when}"


def ot_credit(record: OvertimeRecord) -> Decimal:
    """The Type 2 credit of a staff OT record, never above 1.00; ZERO = nothing to claim as a shift credit. Under the
    quarters rule (compensation_effects.quarter_rule_applies: a day the rule was on, a known shift length) the credit IS
    staff_ot_credit, so below a quarter is nothing (never the ladder's suggestion); otherwise (before claims_from, the rule
    switched off that day, no shift length) the shifts detection suggested by the ladder."""
    effects = _effects()
    credit = ZERO
    try:
        if effects.quarter_rule_applies(record.employee, record.date):
            credit = Decimal(
                str(effects.staff_ot_credit(record.employee, record.date, int(record.ot_minutes or 0)) or 0)
            )
            return min(credit, ONE).quantize(Decimal("0.01")) if credit > 0 else ZERO
    except Exception:
        logger.exception("staff_ot_credit failed for OT record %s", record.pk)
        return ZERO
    if record.suggested_shifts:
        credit = Decimal(record.suggested_shifts)
    return min(credit, ONE).quantize(Decimal("0.01")) if credit > 0 else ZERO


def overtime_json(record: OvertimeRecord | None) -> dict | None:
    """{id, date, shiftEnd, lastPunch, lastPunchNextDay, extraMinutes} of the OT behind a claim (null for other kinds)."""
    if record is None:
        return None
    end = record.shift_end_time
    next_day = False
    if end is not None and record.ot_minutes is not None:
        next_day = end.hour * 60 + end.minute + int(record.ot_minutes) >= 24 * 60
    return {
        "id": record.id,
        "date": record.date.isoformat(),
        "shiftEnd": _hhmm(end),
        "lastPunch": _hhmm(record.last_punch_out),
        "lastPunchNextDay": next_day,
        "extraMinutes": record.ot_minutes,
        "allowanceMinutes": record.allowance_minutes or None,
        "status": record.status,
    }


def open_claim_for_record(record_id: int | None) -> HolidayWorkClaim | None:
    """The pending / approved claim of an OT record, or None. HR's Type 2 Pay / Assign must leave a record that has one
    alone (compensation_views asks here); detection freezes only a record whose claim was approved (overtime.py)."""
    if record_id is None:
        return None
    return HolidayWorkClaim.objects.filter(overtime_record_id=record_id, status__in=OPEN).order_by("-id").first()


def open_claims_for_records(record_ids) -> dict[int, HolidayWorkClaim]:
    """{overtime_record_id: its pending / approved claim} for a list (one query)."""
    ids = [i for i in record_ids if i is not None]
    out: dict[int, HolidayWorkClaim] = {}
    if not ids:
        return out
    for c in HolidayWorkClaim.objects.filter(overtime_record_id__in=ids, status__in=OPEN).order_by("-id"):
        out.setdefault(c.overtime_record_id, c)
    return out


def latest_claims_for_records(record_ids) -> dict[int, HolidayWorkClaim]:
    """{overtime_record_id: its newest claim, whatever its status} (the OT list shows rejected ones too)."""
    ids = [i for i in record_ids if i is not None]
    out: dict[int, HolidayWorkClaim] = {}
    if not ids:
        return out
    claims = HolidayWorkClaim.objects.filter(overtime_record_id__in=ids).order_by("-id")
    for c in claims:
        current = out.get(c.overtime_record_id)
        # an open claim wins over a newer rejected one (a rejected claim can be raised again)
        if current is None or (current.status not in OPEN and c.status in OPEN):
            out[c.overtime_record_id] = c
    return out


# ─────────────────────────── the Department Head ───────────────────────────


def hod_problem(employee: Employee, *, for_employee: bool = False) -> str | None:
    """Why nobody could decide a claim of `employee` (no Department Head, they are their own head, or their head may not
    approve compensation), or None. Worded for the employee (`for_employee`) or for HR."""
    from .hod_scope import effective_manager

    head = effective_manager(employee)
    name = full_name(employee)
    if head is None or not head.is_active:
        if for_employee:
            return "You have no Department Head assigned, so nobody could approve this claim. Please contact HR."
        return f"{name} has no Department Head assigned, so nobody could approve this claim: assign one in HOD Assignment first."
    if head.employee_id == employee.id:
        if for_employee:
            return (
                "You are a Department Head yourself and a head never decides their own claim. Please contact HR to "
                "have another Department Head assigned to you."
            )
        return f"{name} is a Department Head, and a head never decides their own claim: assign them another head first."
    if not head.can_approve_compensation:
        if for_employee:
            return (
                f"Your Department Head {full_name(head.employee)} is not allowed to approve compensation yet, so nobody "
                "could approve this claim. Please contact HR."
            )
        return (
            f"{full_name(head.employee)} cannot approve compensation: switch it on in User Management (HOD Assignment) "
            f"before raising a claim for {name}."
        )
    return None


# ─────────────────────────── eligibility ───────────────────────────


@dataclass
class Context:
    """What every check of one request (or one list) reads once: the switches, the config and today."""

    today: dt.date
    cfg: CompensationConfig
    master: bool
    workflow_on: bool
    for_employee: bool = False
    _hod: dict = field(default_factory=dict)
    # the open claims a list already read ({("record", id) | (kind, date): claim}), so eligibility does not query them once
    # per item (see remember_open_claims); None = look them up
    known: dict | None = None
    # may the birthday check work a stale / missing stored day out again (a write)? Only a write path (create_claim)
    # does; a list never writes attendance (compensation_effects.birthday_outcomes, security review 2026-11-19)
    refresh: bool = False

    def remember_open_claims(self, employee: Employee) -> None:
        """Read the employee's open claims once (one query) for the eligibility checks of a whole list."""
        self.known = {}
        for c in HolidayWorkClaim.objects.filter(employee=employee, status__in=OPEN).order_by("id"):
            self.known[(c.kind, c.work_date)] = c
            if c.overtime_record_id:
                self.known[("record", c.overtime_record_id)] = c

    def hod_problem(self, employee: Employee) -> str | None:
        if employee.id not in self._hod:
            self._hod[employee.id] = hod_problem(employee, for_employee=self.for_employee)
        return self._hod[employee.id]


def context(
    *,
    for_employee: bool = False,
    today: dt.date | None = None,
    cfg: CompensationConfig | None = None,
    master: bool | None = None,
) -> Context:
    """The switches read once; a caller that already read the config / the master switch hands them in."""
    return Context(
        today=today or ist_today(),
        cfg=cfg or CompensationConfig.get(),
        master=master_enabled() if master is None else bool(master),
        workflow_on=approval.get_config(WORKFLOW).enabled,
        for_employee=for_employee,
    )


def _result(eligible=False, code=None, message=None, shifts=None, minutes=None, claim=None, record=None) -> dict:
    return {
        "eligible": eligible,
        "code": code,
        "message": message,
        "shifts": shifts,
        "minutes": minutes,
        "claim": claim,
        "record": record,
    }


def _switch_error(kind: str, ctx: Context) -> ClaimError | None:
    if not ctx.master:
        return ClaimError(
            "switched_off",
            "The OT / Compensation features are switched off in Settings > Payroll, so a claim can't be raised right now.",
            403,
        )
    switch = SWITCH_FIELDS.get(kind)
    if switch and not getattr(ctx.cfg, switch):
        return ClaimError(
            "switched_off",
            f"{SWITCH_NAMES[kind]} is switched off in Settings > Compensation, so it can't be claimed right now.",
            403,
        )
    if not ctx.workflow_on:
        return ClaimError("switched_off", "Compensation claims are switched off right now. Please contact HR.", 403)
    return None


def _employee_error(employee: Employee, ctx: Context) -> ClaimError | None:
    if employee.employment_type != "staff":
        who = "You are" if ctx.for_employee else f"{full_name(employee)} is"
        return ClaimError("not_staff", f"{who} a production employee: compensation claims are for staff only.", 403)
    if employee.status != "active":
        return ClaimError("not_eligible", f"{full_name(employee)} is not an active employee.")
    return None


def _window_error(day: dt.date, ctx: Context) -> ClaimError | None:
    if day > ctx.today:
        return ClaimError("not_eligible", f"{date_text(day)} has not happened yet, so there is nothing to claim.")
    if day < ctx.today - timedelta(days=CLAIM_WINDOW_DAYS):
        return ClaimError(
            "too_old", f"A claim can only be raised for something in the last {CLAIM_WINDOW_DAYS} days.", 400
        )
    return None


def _old_rule_error(kind: str, day: dt.date, ctx: Context) -> ClaimError | None:
    """ot_* and birthday follow the claim rules only from claims_from on (owner decision 6: no history rewrite); a
    birthday also from the birthday-only CompensationConfig.birthday_claims_from (owner 2026-11-25)."""
    if kind == HolidayWorkClaim.KIND_BIRTHDAY:
        if ctx.cfg.birthday_claims_apply_on(day):
            return None
        since = date_text(min(d for d in (ctx.cfg.claims_from, ctx.cfg.birthday_claims_from) if d is not None))
        return ClaimError(
            "not_eligible", f"Before {since} birthday leave was applied automatically, so there is nothing to claim."
        )
    if ctx.cfg.claims_apply_on(day):
        return None
    since = date_text(ctx.cfg.claims_from)
    if kind == HolidayWorkClaim.KIND_OT_ALLOWANCE:
        text = f"Before {since} the late-in allowance was applied automatically, so there is nothing to claim."
    else:
        text = f"Before {since} OT shift compensation was given by HR: please contact HR about this day."
    return ClaimError("not_eligible", text)


def _open_claim(
    employee: Employee, kind: str, day: dt.date, record: OvertimeRecord | None = None, ctx: Context | None = None
):
    if ctx is not None and ctx.known is not None:
        found = ctx.known.get(("record", record.id)) if record is not None else None
        return found or ctx.known.get((kind, day))
    qs = HolidayWorkClaim.objects.filter(status__in=OPEN)
    if record is not None:
        found = qs.filter(overtime_record=record).order_by("-id").first()
        if found is not None:
            return found
    return qs.filter(employee=employee, kind=kind, work_date=day).order_by("-id").first()


def _already(claim: HolidayWorkClaim, ctx: Context) -> ClaimError:
    state = "waiting for the Department Head" if claim.status == HolidayWorkClaim.STATUS_PENDING else "approved"
    who = "You already have" if ctx.for_employee else f"{full_name(claim.employee)} already has"
    return ClaimError(
        "already_claimed",
        f"{who} a {KIND_LABELS.get(claim.kind, 'compensation').lower()} claim for {date_text(claim.work_date)} that is {state}.",
        409,
    )


def _find_record(employee: Employee, kind: str, target) -> OvertimeRecord | None:
    if isinstance(target, OvertimeRecord):
        return target if target.employee_id == employee.id else None
    if isinstance(target, dt.date):
        wanted = (
            OvertimeRecord.OT_TYPE_ALLOWANCE
            if kind == HolidayWorkClaim.KIND_OT_ALLOWANCE
            else OvertimeRecord.OT_TYPE_SHIFT
        )
        return OvertimeRecord.objects.filter(employee=employee, date=target, ot_type=wanted).first()
    return None


def _check(employee: Employee, kind: str, target, ctx: Context) -> dict:
    """The eligibility of one employee for one kind (raises ClaimError for the refusals; returns the details)."""
    if kind not in EMPLOYEE_CLAIM_KINDS:
        raise ClaimError("invalid", "kind must be holiday_work, ot_allowance, ot_shift or birthday.")
    err = _employee_error(employee, ctx) or _switch_error(kind, ctx)
    if err:
        raise err

    if kind == HolidayWorkClaim.KIND_HOLIDAY_WORK:
        day = target if isinstance(target, dt.date) else None
        if day is None:
            raise ClaimError("invalid", "date must be a date (YYYY-MM-DD).")
        if day_kind(day, holiday_names(day, day)) is None:
            # the employee's own off Saturday is a day off too: working it is holiday work (owner decision 4)
            from .compensation_engine import is_off_day

            if not (day.weekday() == 5 and is_off_day(employee, day)):
                whose = "your" if ctx.for_employee else f"{full_name(employee)}'s"
                raise ClaimError(
                    "not_eligible",
                    f"{date_text(day)} is neither a Sunday, a declared holiday nor {whose} off Saturday, so there is no "
                    "holiday work to claim.",
                )
        err = _window_error(day, ctx)
        if err:
            raise err
        from .holiday_work_views import worked_ids

        if employee.id not in worked_ids(day, [employee.id]):
            who = "You have" if ctx.for_employee else f"{full_name(employee)} has"
            raise ClaimError(
                "not_eligible",
                f"{who} no punches or attendance on {date_text(day)}, so there is no work on record to claim for.",
            )
        existing = _open_claim(employee, kind, day, ctx=ctx)
        if existing is not None:
            raise _already(existing, ctx)
        return _result(True, shifts=ONE)

    if kind in HolidayWorkClaim.OT_KINDS:
        record = _find_record(employee, kind, target)
        if record is None:
            raise ClaimError("not_eligible", "No detected overtime was found for that day.")
        day = record.date
        wanted = (
            OvertimeRecord.OT_TYPE_ALLOWANCE
            if kind == HolidayWorkClaim.KIND_OT_ALLOWANCE
            else OvertimeRecord.OT_TYPE_SHIFT
        )
        if record.ot_type != wanted:
            actual = {
                OvertimeRecord.OT_TYPE_ALLOWANCE: "a late-in allowance (Type 1)",
                OvertimeRecord.OT_TYPE_SHIFT: "shift compensation (Type 2)",
            }.get(record.ot_type, "an older overtime record: please contact HR about it")
            raise ClaimError("not_eligible", f"The overtime of {date_text(day)} is {actual}.")
        err = _old_rule_error(kind, day, ctx) or _window_error(day, ctx)
        if err:
            raise err
        if record.status == OvertimeRecord.STATUS_REJECTED:
            raise ClaimError("not_eligible", f"HR decided the overtime of {date_text(day)} is not compensated.")
        existing = _open_claim(employee, kind, day, record, ctx)
        if existing is not None:
            raise _already(existing, ctx)
        if kind == HolidayWorkClaim.KIND_OT_ALLOWANCE:
            if not record.allowance_minutes:
                raise ClaimError("not_eligible", f"The overtime of {date_text(day)} earned no late-in allowance.")
            return _result(True, shifts=ZERO, minutes=int(record.allowance_minutes), record=record)
        if record.status != OvertimeRecord.STATUS_DETECTED:
            raise ClaimError(
                "not_eligible",
                f"HR already decided the overtime of {date_text(day)} (assigned or paid), so it cannot be claimed as well.",
            )
        credit = ot_credit(record)
        if credit <= 0:
            raise ClaimError(
                "not_eligible", f"The overtime of {date_text(day)} is shorter than a quarter shift: no shift credit."
            )
        return _result(True, shifts=credit, minutes=int(record.ot_minutes or 0), record=record)

    # birthday
    day = target if isinstance(target, dt.date) else None
    if day is None:
        raise ClaimError("invalid", "date must be a date (YYYY-MM-DD).")
    dob = employee.date_of_birth
    if dob is None or birthday_in_year(dob, day.year) != day:
        who = "your" if ctx.for_employee else f"{full_name(employee)}'s"
        raise ClaimError("not_eligible", f"{date_text(day)} is not {who} birthday.")
    err = _old_rule_error(kind, day, ctx) or _window_error(day, ctx)
    if err:
        raise err
    existing = _open_claim(employee, kind, day, ctx=ctx)
    if existing is not None:
        raise _already(existing, ctx)
    effects = _effects()
    outcome = effects.birthday_outcome(employee, day, refresh=ctx.refresh) or {}
    # "base" is the attendance part alone (the outcome itself may already say credit_rejected for an earlier claim, which
    # can be raised again)
    if (outcome.get("base") or outcome.get("outcome")) != effects.BIRTHDAY_CREDIT_CLAIMABLE:
        raise ClaimError(
            "not_eligible",
            outcome.get("message") or "This birthday gives no credit to claim (it was not worked, or was a day off).",
        )
    return _result(True, shifts=ONE)


def eligibility(employee: Employee, kind: str, target, *, ctx: Context | None = None, check_hod: bool = False) -> dict:
    """Whether `employee` can claim `kind` for `target` (a date, or the OvertimeRecord for ot_* kinds), without saving:
    {"eligible", "code", "message", "shifts" (the suggested / maximum shifts), "minutes", "claim" (the open claim, when
    there is one), "record"}. The single answer the list endpoints (employee compensation, OT list, birthdays,
    holiday-work month) and create_claim share. `check_hod` adds the no_hod refusal."""
    ctx = ctx or context()
    try:
        out = _check(employee, kind, target, ctx)
        if check_hod:
            problem = ctx.hod_problem(employee)
            if problem:
                return _result(
                    False, "no_hod", problem, shifts=out["shifts"], minutes=out["minutes"], record=out["record"]
                )
        return out
    except ClaimError as exc:
        claim = None
        if exc.code == "already_claimed":
            record = _find_record(employee, kind, target) if kind in HolidayWorkClaim.OT_KINDS else None
            day = record.date if record is not None else (target if isinstance(target, dt.date) else None)
            claim = _open_claim(employee, kind, day, record) if day else None
        return _result(False, exc.code, exc.message, claim=claim)


# ─────────────────────────── the balance ───────────────────────────


def pending_use(employee_ids) -> dict[int, Decimal]:
    """{employee_id: shifts asked for in use_balance claims still waiting for the Department Head}."""
    return {
        row["employee_id"]: Decimal(row["total"] or 0)
        for row in HolidayWorkClaim.objects.filter(
            employee_id__in=list(employee_ids),
            kind=HolidayWorkClaim.KIND_USE_BALANCE,
            status=HolidayWorkClaim.STATUS_PENDING,
        )
        .values("employee_id")
        .annotate(total=Sum("shifts"))
    }


def balance_figures(employee_ids) -> dict[int, dict]:
    """{employee_id: {earned, used, pending, available, balance}} in shifts. balance = earned - used is exactly
    compensation_apply.balances_for (ledger credits + every legacy Alternative Day credit, less ledger debits other than
    the mirrors of a legacy credit being used and less the legacy credits used); pending = use_balance claims waiting;
    available = balance - pending (what can still be asked for)."""
    ids = list(employee_ids)
    out: dict[int, dict] = {}

    def row(emp_id):
        return out.setdefault(emp_id, {"earned": ZERO, "used": ZERO, "pending": ZERO})

    for r in (
        CompensationLedger.objects.filter(employee_id__in=ids)
        .values("employee_id", "entry_type", "source")
        .annotate(total=Sum("shifts"))
    ):
        total = Decimal(r["total"] or 0)
        if r["entry_type"] == CompensationLedger.ENTRY_CREDIT:
            row(r["employee_id"])["earned"] += total
        elif r["source"] != CompensationLedger.SOURCE_LEGACY_CREDIT:
            row(r["employee_id"])["used"] += total
    for r in (
        CompensationLeaveCredit.objects.filter(employee_id__in=ids)
        .values("employee_id", "status")
        .annotate(n=Count("id"))
    ):
        figures = row(r["employee_id"])
        figures["earned"] += ONE * r["n"]
        if r["status"] == CompensationLeaveCredit.STATUS_USED:
            figures["used"] += ONE * r["n"]
    for emp_id, total in pending_use(ids).items():
        row(emp_id)["pending"] += total
    for figures in out.values():
        figures["balance"] = figures["earned"] - figures["used"]
        figures["available"] = figures["balance"] - figures["pending"]
    return out


def figures_json(figures: dict | None) -> dict:
    f = figures or {}
    return {
        key: float(Decimal(f.get(key, ZERO)).quantize(Decimal("0.01")))
        for key in ("earned", "used", "pending", "available", "balance")
    }


def _use_balance_check(employee: Employee, day: dt.date, shifts: Decimal, ctx: Context) -> None:
    """use_balance: a working day the balance covers (with what is already asked for). Raises ClaimError."""
    err = _employee_error(employee, ctx) or _switch_error(HolidayWorkClaim.KIND_USE_BALANCE, ctx)
    if err:
        raise err
    if day < ctx.today - timedelta(days=CLAIM_WINDOW_DAYS):
        raise ClaimError("too_old", f"The day off can be at most {CLAIM_WINDOW_DAYS} days back.")
    if day > ctx.today + timedelta(days=USE_AHEAD_DAYS):
        raise ClaimError("not_eligible", f"The day off can be at most {USE_AHEAD_DAYS} days ahead.")
    from . import compensation_engine

    if compensation_engine.is_off_day(employee, day):
        raise ClaimError(
            "not_eligible",
            f"{date_text(day)} is already a day off (a Sunday, a holiday or an off Saturday): choose a working day.",
        )
    existing = _open_claim(employee, HolidayWorkClaim.KIND_USE_BALANCE, day, ctx=ctx)
    if existing is not None:
        raise _already(existing, ctx)
    figures = balance_figures([employee.id]).get(employee.id) or {"available": ZERO, "pending": ZERO, "balance": ZERO}
    if shifts > figures["available"]:
        pending = figures["pending"]
        tail = f" ({shifts_text(pending)} is already asked for)" if pending > 0 else ""
        raise ClaimError(
            "not_eligible",
            f"The balance available is {shifts_text(max(figures['available'], ZERO))} shift{tail}, so "
            f"{shifts_text(shifts)} cannot be used.",
        )


# ─────────────────────────── creating a claim ───────────────────────────


def _clean_reason(reason, kind: str) -> str:
    text = str(reason or "").strip()
    if len(text) > MAX_REASON_LENGTH:
        raise ClaimError("invalid", f"The reason can be at most {MAX_REASON_LENGTH} characters.")
    if not text and kind in (HolidayWorkClaim.KIND_HOLIDAY_WORK, HolidayWorkClaim.KIND_USE_BALANCE):
        if kind == HolidayWorkClaim.KIND_HOLIDAY_WORK:
            raise ClaimError(
                "invalid",
                "Give a reason (what was the work on that day?): the Department Head reads it before deciding.",
            )
        raise ClaimError("invalid", "Give a reason for the day off: the Department Head reads it before deciding.")
    return text


def _default_reason(kind: str, record: OvertimeRecord | None, day: dt.date) -> str:
    if record is not None:
        return (
            f"Worked until {_hhmm(record.last_punch_out)} on {date_text(record.date)} "
            f"({record.ot_minutes} minutes past the shift end)."
        )
    if kind == HolidayWorkClaim.KIND_BIRTHDAY:
        return f"Worked on my birthday, {date_text(day)}."
    return ""


def create_claim(
    *,
    employee: Employee,
    kind: str,
    date: dt.date,
    shifts: Decimal | None = None,
    overtime_record: OvertimeRecord | None = None,
    minutes: int | None = None,
    reason: str,
    raised_by_role: str,
    raised_by_name: str,
    request: Request | None = None,
    ctx: Context | None = None,
) -> HolidayWorkClaim:
    """Validates everything (switches, staff only, the claim window, eligibility for `kind` on `date` / the OT record,
    one open claim, an HOD who can approve compensation, for use_balance the balance covering pending + requested) and
    saves one pending claim, then tells the approval workflow (notify the HOD) and writes the audit row. Raises
    ClaimError; nothing is saved then. `raised_by_role` is HolidayWorkClaim.RAISED_BY_HR or RAISED_BY_EMPLOYEE;
    `raised_by_name` goes to requested_by. `minutes` is ignored: an allowance claim always carries the minutes detection
    granted."""
    if kind not in ALL_KINDS:
        raise ClaimError("invalid", "kind must be holiday_work, ot_allowance, ot_shift, birthday or use_balance.")
    if raised_by_role not in (HolidayWorkClaim.RAISED_BY_HR, HolidayWorkClaim.RAISED_BY_EMPLOYEE):
        raise ClaimError("invalid", "raised_by_role must be hr or employee.")
    if not isinstance(date, dt.date):
        raise ClaimError("invalid", "date must be a date (YYYY-MM-DD).")
    ctx = ctx or context(for_employee=raised_by_role == HolidayWorkClaim.RAISED_BY_EMPLOYEE)
    # a list's snapshot of the open claims is never trusted for a write; a write may work the birthday's day out again
    ctx = replace(ctx, known=None, refresh=True)
    text = _clean_reason(reason, kind)

    asked = None
    if shifts not in (None, ""):
        asked = parse_shifts(shifts)
        if asked is None:
            raise ClaimError("invalid", f"shifts must be {SHIFT_TEXT}.")

    with transaction.atomic():
        # The employee row is the lock every balance change takes (HR's redeem too): two claims of one employee are
        # checked one after the other, so they can never both pass "not claimed yet" / "the balance covers it".
        locked = (
            Employee.objects.select_for_update(of=("self",))
            .select_related("department", "designation", "branch")
            .filter(pk=employee.pk)
            .first()
        )
        if locked is None:
            raise ClaimError("not_found", "Employee not found.", 404)

        record = None
        claim_minutes = None
        if kind == HolidayWorkClaim.KIND_USE_BALANCE:
            if asked is None:
                raise ClaimError("invalid", f"shifts is required: {SHIFT_TEXT}.")
            _use_balance_check(locked, date, asked, ctx)
            value = asked
        else:
            target = overtime_record if (kind in HolidayWorkClaim.OT_KINDS and overtime_record is not None) else date
            if kind in HolidayWorkClaim.OT_KINDS and overtime_record is not None:
                if overtime_record.employee_id != locked.id:
                    raise ClaimError("not_eligible", "That overtime record belongs to another employee.")
                record = OvertimeRecord.objects.select_for_update(of=("self",)).filter(pk=overtime_record.pk).first()
                if record is None:
                    raise ClaimError("not_eligible", "No detected overtime was found for that day.")
                if record.date != date:
                    raise ClaimError("invalid", "The date does not match the overtime record's date.")
                target = record
            found = _check(locked, kind, target, ctx)
            record = found["record"] or record
            if kind == HolidayWorkClaim.KIND_OT_ALLOWANCE:
                value = ZERO
                claim_minutes = found["minutes"]
            elif kind == HolidayWorkClaim.KIND_OT_SHIFT:
                credit = found["shifts"]
                value = asked if asked is not None else credit
                if value > credit:
                    raise ClaimError(
                        "not_eligible",
                        f"The overtime of {date_text(record.date)} earns at most {shifts_text(credit)} shift by the "
                        "quarters rule.",
                    )
            elif kind == HolidayWorkClaim.KIND_BIRTHDAY:
                value = ONE
            else:
                value = asked if asked is not None else ONE

        problem = ctx.hod_problem(locked)
        if problem:
            raise ClaimError("no_hod", problem, 409)

        claim = HolidayWorkClaim(
            employee=locked,
            kind=kind,
            work_date=record.date if record is not None else date,
            shifts=value,
            minutes=claim_minutes,
            overtime_record=record,
            reason=text or _default_reason(kind, record, date) or None,
            status=HolidayWorkClaim.STATUS_PENDING,
            requested_by=raised_by_name,
            raised_by_role=raised_by_role,
            approval_trail=[],
        )
        if kind in (HolidayWorkClaim.KIND_USE_BALANCE, HolidayWorkClaim.KIND_OT_ALLOWANCE):
            refused = _effects().check_claim_effects(claim)
            if refused:
                raise ClaimError("not_eligible", refused)
        try:
            with transaction.atomic():
                claim.save()
        except IntegrityError:
            # the database's own guard (one open claim per employee + kind + date, and per OT record)
            raise ClaimError("already_claimed", "This is already claimed: a claim for it is waiting or approved.", 409)
        approval.notify_new_request(WORKFLOW, locked, what_text(claim), obj=claim, dedupe=hod_dedupe(claim))
        if raised_by_role == HolidayWorkClaim.RAISED_BY_HR:
            _notify_employee_raised(claim)
    if request is not None:
        from .audit_utils import log_action

        log_action(
            request,
            "create",
            "compensation",
            record_id=claim.id,
            description=(
                f"Raised {KIND_LABELS[kind].lower()} claim for {locked.employee_code} on {claim.work_date.isoformat()}"
                + (f": {shifts_text(claim.shifts)} shift" if kind != HolidayWorkClaim.KIND_OT_ALLOWANCE else "")
                + (f" ({claim.minutes} min)" if claim.minutes else "")
                + f" (raised by {raised_by_role})"
            ),
            new_values={
                "kind": kind,
                "date": claim.work_date.isoformat(),
                "shifts": str(claim.shifts),
                "minutes": claim.minutes,
                "overtimeRecordId": claim.overtime_record_id,
                "reason": claim.reason,
                "raisedByRole": raised_by_role,
            },
        )
    return claim


def hod_dedupe(claim: HolidayWorkClaim) -> str:
    """What the Department Head's "waiting for your approval" message is about: the employee, the kind, the date and the
    amount (security review 2026-11-19), so raising, withdrawing and raising the SAME claim again tells the head ONCE
    (WhatsApp and the phone notice alike), while a claim raised again with different figures (shifts / minutes) is told
    again: the head's only message must not keep the old figures (verification 2026-11-19). A claim raised again after a
    REJECTION is news, so the count of rejected claims of that employee, kind and date is part of the key."""
    rejected = HolidayWorkClaim.objects.filter(
        employee_id=claim.employee_id,
        kind=claim.kind,
        work_date=claim.work_date,
        status=HolidayWorkClaim.STATUS_REJECTED,
    ).count()
    shifts = Decimal(claim.shifts or 0).quantize(Decimal("0.01"))
    return (
        f"{claim.employee_id}:{claim.kind}:{claim.work_date.isoformat()}:{shifts}:{int(claim.minutes or 0)}:r{rejected}"
    )


def _notify_employee_raised(claim: HolidayWorkClaim) -> None:
    """HR raised a claim on the employee's behalf: tell them (their phone; Phone Notify Control's compensation switch).
    Never raises."""
    try:
        from . import compensation_notices

        compensation_notices.claim_raised(claim)
    except Exception:
        logger.exception("Could not notify the employee of claim %s", claim.pk)


# ─────────────────────────── the Department Head's decision ───────────────────────────


def _refresh_evidence(claim: HolidayWorkClaim) -> None:
    """The approval refreshes its own evidence (verification 2026-11-19, security #1): work the claim's day out again
    (attendance_final.compute_range_records: never a manual day) and, for the OT kinds, bring the employee's OT row of
    that day in step with it (overtime.sync_overtime with prune: a day that no longer qualifies loses its undecided row,
    which sets the claim's overtime_record to NULL), so an approval never credits what a corrected punch removed, even
    before the 15-minute detection job or an HR list ran. decide runs it BEFORE its own transaction, exactly like a
    detection pass (so what it finds stays, even when the approval is then refused); the checks under the decision's locks
    read the result. A Payroll Done month is left alone: its attendance can no longer change. Each step is its own
    transaction / savepoint and never raises (the checks then judge what is stored)."""
    effects = _effects()
    day = claim.work_date
    if effects.month_locked(day):
        return
    from .attendance_final import compute_range_records
    from .models import PayrollSettings
    from .overtime import sync_overtime

    settings = PayrollSettings.get()
    try:
        with transaction.atomic():
            compute_range_records(claim.employee, day, day, settings)
    except Exception:
        logger.exception("Working out the day of claim %s again failed", claim.pk)
    if claim.kind not in HolidayWorkClaim.OT_KINDS:
        return
    try:
        with transaction.atomic():
            sync_overtime(day, day, settings=settings, employee_ids=[claim.employee_id], prune=True)
    except Exception:
        logger.exception("Bringing the OT row of claim %s in step failed", claim.pk)


def _approval_problem(claim: HolidayWorkClaim) -> str | None:
    """Why approving `claim` must be refused now (checked under the locks, just before the ledger is written). The
    evidence the claim was raised on is checked AGAIN here (security review 2026-11-19): detection keeps a pending claim's
    OT record in step with corrected punches, so the record may be gone or earn less now; a holiday-work claim needs the
    day still on record; a birthday credit needs the birthday still worked (compensation_effects.birthday_outcome)."""
    kind = claim.kind
    if kind in (HolidayWorkClaim.KIND_USE_BALANCE, HolidayWorkClaim.KIND_OT_ALLOWANCE) and not master_enabled():
        # with the master switch off the engine applies no allowance and tops up no day: a debit or an allowance
        # approved now would change nothing on the day (the credit kinds stay decidable: they only add to the balance)
        what = "a day off from the balance" if kind == HolidayWorkClaim.KIND_USE_BALANCE else "a late-in allowance"
        return (
            "The OT / Compensation features are switched off in Settings > Payroll, so "
            f"{what} cannot be approved right now: it would not change the attendance. Ask HR to switch them on, or "
            "reject it."
        )
    # (decide refreshed the evidence first: _refresh_evidence, the day worked out again and its OT row brought in step)
    if kind in HolidayWorkClaim.OT_KINDS:
        # a prune sets the claim's overtime_record to NULL in the database, not on this in-memory row
        claim.overtime_record_id = (
            HolidayWorkClaim.objects.filter(pk=claim.pk).values_list("overtime_record_id", flat=True).first()
        )
        if claim.overtime_record_id is None:
            return (
                "The overtime behind this claim is no longer on record (the punches were corrected), so it cannot be "
                "approved. Reject it instead."
            )
        record = (
            OvertimeRecord.objects.select_for_update(of=("self",))
            .select_related("employee")
            .filter(pk=claim.overtime_record_id)
            .first()
        )
        if record is None:
            return "The overtime behind this claim is no longer on record, so it cannot be approved. Reject it instead."
        if kind == HolidayWorkClaim.KIND_OT_ALLOWANCE and record.status == OvertimeRecord.STATUS_REJECTED:
            return "HR decided this overtime is not compensated, so it cannot be approved. Reject this claim instead."
        wanted = (
            OvertimeRecord.OT_TYPE_ALLOWANCE
            if kind == HolidayWorkClaim.KIND_OT_ALLOWANCE
            else OvertimeRecord.OT_TYPE_SHIFT
        )
        # the kind first: a Type 2 row that became a Type 1 allowance after a punch correction (status auto) changed, HR
        # did not decide it (verification 2026-11-19)
        if record.ot_type != wanted:
            return (
                f"The overtime of {date_text(record.date)} changed since the claim was raised (the punches were "
                "corrected) and is no longer what was claimed, so it cannot be approved. Reject it; a new claim can be "
                "raised for what the day shows now."
            )
        if kind == HolidayWorkClaim.KIND_OT_SHIFT and record.status != OvertimeRecord.STATUS_DETECTED:
            return (
                "HR already decided this overtime (assigned or paid), so it cannot be credited as well. Reject this "
                "claim instead."
            )
        if kind == HolidayWorkClaim.KIND_OT_SHIFT:
            credit = ot_credit(record)
            if credit < Decimal(claim.shifts):
                earns = f"{shifts_text(credit)} shift" if credit > 0 else "no shift credit"
                return (
                    f"The overtime of {date_text(record.date)} now earns {earns} (the punches were corrected), less than "
                    f"the {shifts_text(claim.shifts)} claimed, so it cannot be approved. Reject it; a new claim can be "
                    "raised for what the day shows now."
                )
        elif int(record.allowance_minutes or 0) < int(claim.minutes or 0):
            return (
                f"The overtime of {date_text(record.date)} now earns a {int(record.allowance_minutes or 0)} min allowance "
                f"(the punches were corrected), less than the {claim.minutes} min claimed, so it cannot be approved. "
                "Reject it; a new claim can be raised for what the day shows now."
            )
    if kind == HolidayWorkClaim.KIND_HOLIDAY_WORK:
        from .holiday_work_views import worked_ids

        if claim.employee_id not in worked_ids(claim.work_date, [claim.employee_id]):
            return (
                f"{full_name(claim.employee)} has no punches or attendance on {date_text(claim.work_date)} any more (the "
                "punches were corrected), so there is no work on record to approve. Reject it instead."
            )
    if kind == HolidayWorkClaim.KIND_BIRTHDAY:
        effects = _effects()
        # the attendance alone decides here: a credit kind stays decidable with the master / birthday switch off, like
        # holiday work and OT credits (verification 2026-11-19, security #2)
        outcome = effects.birthday_outcome(claim.employee, claim.work_date, refresh=True, ignore_switches=True) or {}
        if (outcome.get("base") or outcome.get("outcome")) != effects.BIRTHDAY_CREDIT_CLAIMABLE:
            return (
                "The attendance no longer shows the birthday as worked"
                + (f" ({outcome['message'].rstrip('.')})" if outcome.get("message") else "")
                + ", so the credit cannot be approved. Reject it instead."
            )
    if kind == HolidayWorkClaim.KIND_USE_BALANCE:
        from .compensation_apply import balance_of

        balance = balance_of(claim.employee)
        if Decimal(claim.shifts) > balance:
            return (
                f"The compensation balance is {shifts_text(balance)} shift now, so {shifts_text(claim.shifts)} cannot be "
                "used. Reject this request instead."
            )
    return _effects().check_claim_effects(claim)


def credit_or_debit(claim: HolidayWorkClaim, actor: str | None = None) -> CompensationLedger | None:
    """The ledger entry an APPROVED claim produces, exactly once (get_or_create on the claim and the entry type; the
    database constraints uniq_ledger_credit_per_claim / uniq_ledger_debit_per_claim back it up): a credit for holiday_work
    (source holiday_work) / ot_shift (source ot_shift, overtime_record set) / birthday (source birthday), a redemption
    debit for use_balance (claim set), nothing for ot_allowance (returns None: its effect is the next-day allowance)."""
    kind = claim.kind
    who = actor or claim.reviewed_by
    if kind == HolidayWorkClaim.KIND_OT_ALLOWANCE:
        return None
    if kind == HolidayWorkClaim.KIND_USE_BALANCE:
        entry, _ = CompensationLedger.objects.get_or_create(
            claim=claim,
            entry_type=CompensationLedger.ENTRY_DEBIT,
            defaults={
                "employee": claim.employee,
                "shifts": claim.shifts,
                "date": claim.work_date,
                "source": CompensationLedger.SOURCE_REDEMPTION,
                "note": f"Used on {claim.work_date.isoformat()} (request #{claim.id}, approved by the Department Head)",
                "created_by": who,
            },
        )
        return entry
    if kind == HolidayWorkClaim.KIND_OT_SHIFT:
        note = f"Overtime on {claim.work_date.isoformat()} (claim #{claim.id})"
    elif kind == HolidayWorkClaim.KIND_BIRTHDAY:
        note = f"Worked on the birthday, {claim.work_date.isoformat()} (claim #{claim.id})"
    else:
        note = f"Holiday / Sunday work on {claim.work_date.isoformat()}"
    entry, _ = CompensationLedger.objects.get_or_create(
        claim=claim,
        entry_type=CompensationLedger.ENTRY_CREDIT,
        defaults={
            "employee": claim.employee,
            "shifts": claim.shifts,
            "date": claim.work_date,
            "source": CREDIT_SOURCES[kind],
            "overtime_record": claim.overtime_record if kind == HolidayWorkClaim.KIND_OT_SHIFT else None,
            "note": note,
            "created_by": who,
        },
    )
    return entry


def _mark_record_credited(claim: HolidayWorkClaim, actor: str) -> None:
    """An approved ot_shift claim decides its OT record: relaxation into the balance with no claim date (what HR's old
    announce wrote for that case), so HR's Pay / Assign refuses it from now on and the detector never touches it."""
    OvertimeRecord.objects.filter(pk=claim.overtime_record_id, status=OvertimeRecord.STATUS_DETECTED).update(
        status=OvertimeRecord.STATUS_ANNOUNCED,
        compensation_type=OvertimeRecord.TYPE_RELAXATION,
        shifts=claim.shifts,
        claim_date=None,
        announced_by=actor,
        announced_at=timezone.now(),
        notes=f"Claimed (claim #{claim.id}) and approved by the Department Head: added to the compensation balance.",
    )


def _after_decided(claim_id: int) -> None:
    try:
        claim = HolidayWorkClaim.objects.select_related("employee", "overtime_record").get(pk=claim_id)
        _effects().after_claim_decided(claim)
    except Exception:
        logger.exception("after_claim_decided failed for claim %s", claim_id)


def _short_day(d: dt.date) -> str:
    return f"{d.day} {d.strftime('%b')}"


def effect_text(claim: HolidayWorkClaim) -> str:
    """One plain sentence for the Department Head: what their decision did ("0.75 shift added to Ravi's balance.",
    "Late-in allowance of 30 min applies on 21 Nov.")."""
    name = claim.employee.first_name or full_name(claim.employee)
    if claim.status == HolidayWorkClaim.STATUS_REJECTED:
        if claim.kind == HolidayWorkClaim.KIND_USE_BALANCE:
            return f"Not approved: nothing was taken from {name}'s balance."
        if claim.kind == HolidayWorkClaim.KIND_OT_ALLOWANCE:
            return "Not approved: no late-in allowance applies."
        return f"Not approved: nothing was added to {name}'s balance."
    if claim.status != HolidayWorkClaim.STATUS_APPROVED:
        return "Waiting for the next approver."
    kind = claim.kind
    if kind == HolidayWorkClaim.KIND_OT_ALLOWANCE:
        applies = None
        try:
            applies = _effects().next_working_day(claim.employee, claim.work_date)
        except Exception:
            logger.exception("next_working_day failed for claim %s", claim.pk)
        when = _short_day(applies) if applies else "the next working day"
        return f"Late-in allowance of {claim.minutes or 0} min applies on {when}."
    if kind == HolidayWorkClaim.KIND_USE_BALANCE:
        return f"{shifts_text(claim.shifts)} shift taken from {name}'s balance for {_short_day(claim.work_date)}."
    return f"{shifts_text(claim.shifts)} shift added to {name}'s balance."


def decide(
    claim: HolidayWorkClaim | int,
    decision: str,
    actor: str,
    comment: str | None = None,
    *,
    role: str = approval.HOD,
):
    """The Department Head's decision ("approved" / "rejected") on a pending claim of any kind, through the approval
    workflow. Returns (claim, outcome); raises approval.ApprovalError when the pipeline does not allow the decision or
    approving is refused (compensation_effects.check_claim_effects, a record HR already decided, a balance that no longer
    covers a use request: status 409, code claim_refused). On final approval the ledger entry is written in the same
    transaction (credit_or_debit, once); compensation_effects.after_claim_decided runs after the commit. The employee is
    told by WhatsApp / phone (whatsapp_approvals.notify_decision) after the commit too."""
    from . import whatsapp_approvals

    claim_id = claim.pk if isinstance(claim, HolidayWorkClaim) else int(claim)
    if decision == HolidayWorkClaim.STATUS_APPROVED:
        waiting = (
            HolidayWorkClaim.objects.select_related("employee")
            .filter(
                pk=claim_id,
                status=HolidayWorkClaim.STATUS_PENDING,
                kind__in=(*HolidayWorkClaim.OT_KINDS, HolidayWorkClaim.KIND_HOLIDAY_WORK),
            )
            .first()
        )
        if waiting is not None:
            _refresh_evidence(waiting)
    with transaction.atomic():
        emp_id = HolidayWorkClaim.objects.filter(pk=claim_id).values_list("employee_id", flat=True).first()
        if emp_id is None:
            raise HolidayWorkClaim.DoesNotExist(f"Claim {claim_id} not found")
        # employee first, then the claim, then (inside the checks) the OT record: the lock order every writer uses
        Employee.objects.select_for_update().filter(pk=emp_id).first()
        claim = (
            HolidayWorkClaim.objects.select_for_update(of=("self",))
            .select_related("employee__department", "employee__designation", "employee__branch", "overtime_record")
            .get(pk=claim_id)
        )
        outcome = approval.decide(WORKFLOW, claim, role, decision, actor=actor, comment=comment)
        if outcome.final:
            refused = _approval_problem(claim)
            if refused:
                raise approval.ApprovalError(refused, status=409, code="claim_refused")
        claim.status = outcome.status
        claim.reviewed_by = actor
        claim.reviewed_at = timezone.now()
        if comment:
            claim.review_comment = comment
        claim.save()
        if outcome.final:
            credit_or_debit(claim, actor)
            if claim.kind == HolidayWorkClaim.KIND_OT_SHIFT:
                _mark_record_credited(claim, actor)
        tail = ""
        if outcome.final and claim.kind in HolidayWorkClaim.CREDIT_KINDS:
            tail = f" and {shifts_text(claim.shifts)} shift was added to your compensation balance"
        approval.stage_notice(
            claim.employee, "compensation", approval.notice_for(what_text(claim), outcome, tail), outcome
        )
        if outcome.final or outcome.rejected:
            transaction.on_commit(lambda cid=claim.id: _after_decided(cid))
    if outcome.final or outcome.rejected:
        whatsapp_approvals.notify_decision(
            WORKFLOW,
            claim,
            decision,
            approver=actor,
            role=approval.LEGACY_ROLE[role],
            comment=claim.review_comment,
        )
    return claim, outcome


def withdraw(claim_id: int) -> dict:
    """Delete a claim that is still pending (the HR portal, the employee's own app). Returns the snapshot for the audit
    log; raises ClaimError when it is gone or already decided."""
    with transaction.atomic():
        locked = HolidayWorkClaim.objects.select_for_update().select_related("employee").filter(pk=claim_id).first()
        if locked is None:
            raise ClaimError("not_found", "Claim not found.", 404)
        if locked.status != HolidayWorkClaim.STATUS_PENDING:
            raise ClaimError(
                "not_pending",
                f"This claim is already {locked.status}: only a claim that is still waiting for the Department Head "
                "can be withdrawn.",
            )
        snapshot = {
            "kind": locked.kind,
            "date": locked.work_date.isoformat(),
            "shifts": str(locked.shifts),
            "reason": locked.reason,
            "employeeCode": locked.employee.employee_code,
        }
        locked.delete()
    return snapshot


# ─────────────────────────── JSON ───────────────────────────


def _ledger_entry(claim: HolidayWorkClaim) -> CompensationLedger | None:
    wanted = (
        CompensationLedger.ENTRY_DEBIT
        if claim.kind == HolidayWorkClaim.KIND_USE_BALANCE
        else CompensationLedger.ENTRY_CREDIT
    )
    return next((e for e in claim.ledger_entries.all() if e.entry_type == wanted), None)


def status_label(claim: HolidayWorkClaim, applies_on: dt.date | None = None) -> str:
    if claim.status == HolidayWorkClaim.STATUS_APPROVED:
        if claim.kind in HolidayWorkClaim.CREDIT_KINDS:
            return "Approved: added to the balance"
        if claim.kind == HolidayWorkClaim.KIND_USE_BALANCE:
            return "Approved: taken from the balance"
        if claim.kind == HolidayWorkClaim.KIND_OT_ALLOWANCE and applies_on:
            return f"Approved: applies on {date_text(applies_on)}"
    return CLAIM_STATUS_LABELS.get(claim.status, claim.status)


def claim_json(
    claim: HolidayWorkClaim,
    *,
    for_role: str,
    cfg: approval.Config | None = None,
    holidays: dict | None = None,
    hods: dict | None = None,
) -> dict:
    """One claim as JSON (camelCase) for `for_role` ("hr" | "employee" | "hod"). The keys the holiday-work claim always
    had (id, the employee columns, workDate, dayKind, holidayName, shifts, reason, status, requestedBy, reviewedBy,
    reviewComment, reviewedAt, createdAt, hodName, credited, approval) plus: kind, kindLabel, date, raisedByRole, minutes,
    overtime {id, date, shiftEnd, lastPunch, lastPunchNextDay, extraMinutes, ...} | null, overtimeRecordId, useDate,
    appliesOn (ot_allowance: the working day the allowance applies to), ledger {id, type, shifts, date, source} | null,
    statusLabel, canWithdraw. `holidays` ({date: name}) and `hods` ({employee_id: HOD name}) are passed by a list so it
    does not query once per row."""
    work_date = claim.work_date
    names = holidays if holidays is not None else holiday_names(work_date, work_date)
    kind = claim.kind or HolidayWorkClaim.KIND_HOLIDAY_WORK
    found_kind = day_kind(work_date, names)
    holiday_name = names.get(work_date)
    if kind == HolidayWorkClaim.KIND_HOLIDAY_WORK:
        # a holiday-work claim on a Saturday that is no declared holiday is work on the employee's own off Saturday
        weekday = work_date.weekday()
        day = found_kind or ("sunday" if weekday == 6 else OFF_SATURDAY if weekday == 5 else "holiday")
        if day == OFF_SATURDAY:
            # older app builds show the holiday name for every day that is not a Sunday
            holiday_name = OFF_SATURDAY_LABEL
    else:
        day = found_kind or "working"
    reason = claim.reason
    if for_role == "hod" and kind in HOD_REASON_PREFIX:
        # older HOD app builds read every row as Sunday / holiday work ("approving adds <shifts> to the balance"): the
        # reason they show says what the claim really is (verification 2026-11-19, old app builds)
        reason = f"{HOD_REASON_PREFIX[kind]}: {reason}" if reason else HOD_REASON_PREFIX[kind]
    entry = _ledger_entry(claim)
    applies_on = None
    if kind == HolidayWorkClaim.KIND_OT_ALLOWANCE:
        try:
            applies_on = _effects().next_working_day(claim.employee, work_date)
        except Exception:
            logger.exception("next_working_day failed for claim %s", claim.pk)
    pending = claim.status == HolidayWorkClaim.STATUS_PENDING
    return {
        "id": claim.id,
        **employee_json(claim.employee),
        "workDate": work_date.isoformat(),
        "date": work_date.isoformat(),
        "dayKind": day,
        "holidayName": holiday_name,
        "shifts": float(claim.shifts),
        "reason": reason,
        "status": claim.status,
        "statusLabel": status_label(claim, applies_on),
        "requestedBy": claim.requested_by,
        "reviewedBy": claim.reviewed_by,
        "reviewComment": claim.review_comment,
        "reviewedAt": _iso(claim.reviewed_at),
        "createdAt": _iso(claim.created_at),
        "hodName": (hods or {}).get(claim.employee_id),
        "credited": entry is not None and entry.entry_type == CompensationLedger.ENTRY_CREDIT,
        "approval": approval.progress(WORKFLOW, claim, cfg),
        "kind": kind,
        "kindLabel": KIND_LABELS.get(kind, kind),
        "raisedByRole": claim.raised_by_role or HolidayWorkClaim.RAISED_BY_HR,
        "minutes": claim.minutes,
        "overtimeRecordId": claim.overtime_record_id,
        "overtime": overtime_json(claim.overtime_record) if claim.overtime_record_id else None,
        "useDate": work_date.isoformat() if kind == HolidayWorkClaim.KIND_USE_BALANCE else None,
        "appliesOn": _iso(applies_on),
        "ledger": (
            {
                "id": entry.id,
                "type": entry.entry_type,
                "shifts": float(entry.shifts),
                "date": entry.date.isoformat(),
                "source": entry.source,
            }
            if entry is not None
            else None
        ),
        # HR may withdraw any pending claim; an employee only the ones they raised themselves (an HR-raised claim is
        # HR's to withdraw); the Department Head never withdraws
        "canWithdraw": pending
        and (
            for_role == "hr" or (for_role == "employee" and claim.raised_by_role == HolidayWorkClaim.RAISED_BY_EMPLOYEE)
        ),
    }


def claims_json(claims: list[HolidayWorkClaim], *, for_role: str = "hr") -> list[dict]:
    """A list of claims, with the holiday names and Department Heads looked up once for the whole list."""
    if not claims:
        return []
    from .holiday_work_views import hod_names

    cfg = approval.get_config(WORKFLOW)
    dates = [c.work_date for c in claims]
    holidays = holiday_names(min(dates), max(dates))
    hods = hod_names({c.employee_id for c in claims})
    return [claim_json(c, for_role=for_role, cfg=cfg, holidays=holidays, hods=hods) for c in claims]


def claim_queryset():
    return HolidayWorkClaim.objects.select_related(
        "employee__department", "employee__designation", "employee__branch", "overtime_record"
    ).prefetch_related("ledger_entries")


def last_activity(employee_ids) -> dict[int, str]:
    """{employee_id: the latest ledger entry / claim time, ISO} for the balance list."""
    out: dict[int, dt.datetime] = {}
    ids = list(employee_ids)
    for model in (CompensationLedger, HolidayWorkClaim):
        for row in model.objects.filter(employee_id__in=ids).values("employee_id").annotate(at=Max("created_at")):
            if row["at"] and (row["employee_id"] not in out or row["at"] > out[row["employee_id"]]):
                out[row["employee_id"]] = row["at"]
    return {k: v.isoformat() for k, v in out.items()}


def employee_search_q(text: str, prefix: str = "employee__") -> Q:
    """Name / code search, the way the other compensation lists search."""
    q = Q()
    for word in text.split():
        q &= (
            Q(**{f"{prefix}first_name__icontains": word})
            | Q(**{f"{prefix}last_name__icontains": word})
            | Q(**{f"{prefix}employee_code__icontains": word})
        )
    return q

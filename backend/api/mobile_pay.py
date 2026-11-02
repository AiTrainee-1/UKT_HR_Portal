"""
The employee's own salary, explained for the mobile app: what the company allocated, what attendance earned, what was
deducted and why, and what was finally payable. READ-ONLY.

Every figure comes from what payroll STORED when it generated the slip: the SalarySlip row, its `breakdown_details` (the
engine's own record of the month, payroll_views._generate_staff_payroll / _generate_production_payroll), and the Payroll row
HR may have changed afterwards (bonus, deductions, paid status). Nothing here recomputes a payroll or calls an engine
function that writes. The only arithmetic is on stored figures:

    loss for days not paid = the stored monthly salary - the stored earned gross (staff only; the engine's gross IS the
                             monthly salary / working days x days paid, so this is exactly what those days cost)
    attendance loss        = that loss + the stored late deduction + the stored permission deduction
    sums of the above over a year.

A figure payroll does not store is null, with a sentence saying why (`notes`), never guessed:
  * production pay is per shift: there is no allocated salary, so no "allocated" figure and no loss for days not paid;
  * production has no permission deduction;
  * a production slip made while late detection was off stores no late deduction (null);
  * a slip from before the engine stored a breakdown has no split of its "Other deductions" into late / permission.

Endpoints (mobile_pay_views.py): GET /api/my/salary-insights?year=YYYY and GET /api/my/salary-slips/<id>/breakdown.
"""

from __future__ import annotations

from decimal import Decimal

from .models import Payroll, SalarySlip
from .payroll_insights import (
    MONTH_ABBR,
    MONTH_NAMES,
    _statutory_lines,
    breakdown_of,
    dec,
    inr,
    money,
    period_label,
    plain,
    plural,
    shifts_text,
)
from .production_cycles import CYCLE_LABELS

KIND_STAFF = "staff"
KIND_PRODUCTION = "production"
KIND_LEGACY = "legacy"

NOTE_PRODUCTION_ALLOCATED = (
    "Production pay is per shift, so there is no fixed salary to compare with: you are paid for the shifts you work."
)
NOTE_PRODUCTION_ABSENT = (
    "Production pay is per shift: an absent day earns no shifts, so nothing is cut from a fixed salary."
)
NOTE_PRODUCTION_PERMISSION = "Production pay has no permission deduction."
NOTE_PRODUCTION_LATE_OFF = (
    "Late detection was switched off for production pay when this slip was made: nothing was deducted."
)
NOTE_NO_BREAKDOWN = "This is an older slip that does not record the details: late and permission deductions are inside Other deductions."
NOTE_NO_ALLOCATED = "This older slip does not record your monthly salary, so the comparison cannot be shown."
NOTE_PERMISSION_OLD = (
    "This slip is from before permissions were charged separately: permissions beyond the free ones were counted as late "
    "marks."
)


# ─────────────────────────────────────────────────────────────────────────────
#  Small helpers
# ─────────────────────────────────────────────────────────────────────────────


def _opt(value) -> float | None:
    return None if value is None else money(value)


def _int(value) -> int | None:
    if value is None or isinstance(value, bool):
        return None
    try:
        return int(dec(value))
    except (ValueError, ArithmeticError):
        return None


def kind_of_slip(slip: SalarySlip, bd: dict | None) -> str:
    """staff (monthly) | production (a dated period) | legacy (an old week-number production slip with no breakdown)."""
    stored = (bd or {}).get("type")
    if stored in (KIND_STAFF, KIND_PRODUCTION):
        return stored
    if slip.period_start is not None:
        return KIND_PRODUCTION
    if slip.week_number is None and slip.employee.employment_type == "staff":
        return KIND_STAFF
    return KIND_LEGACY


def _key(obj) -> tuple:
    """How a slip and its payroll find each other (payroll_insights.slip_key without the employee)."""
    if obj.period_start is not None:
        return ("p", obj.period_start, obj.period_end)
    return ("m", obj.month, obj.year, obj.week_number)


def payrolls_by_key(employee_id: int, slips) -> dict[tuple, Payroll]:
    """{_key: the Payroll row} for these slips of one employee, in one query."""
    years = {s.year for s in slips}
    if not years:
        return {}
    return {_key(p): p for p in Payroll.objects.filter(employee_id=employee_id, year__in=years)}


def period_info(slip: SalarySlip, kind: str) -> dict:
    """The label of a slip's pay period: 'October 2026' for staff, '5 Oct - 11 Oct 2026' + 'Weekly' for production."""
    cycle = slip.pay_cycle if slip.pay_cycle in CYCLE_LABELS else None
    if slip.period_start is not None and slip.period_end is not None:
        start, end = slip.period_start, slip.period_end
        if start.month == end.month:
            short = f"{start.day}-{end.day} {MONTH_ABBR[end.month - 1]}"
        else:
            short = f"{start.day} {MONTH_ABBR[start.month - 1]}-{end.day} {MONTH_ABBR[end.month - 1]}"
        return {
            "label": period_label(start, end),
            "shortLabel": short,
            "start": start.isoformat(),
            "end": end.isoformat(),
            "cycle": cycle,
            "cycleLabel": CYCLE_LABELS.get(cycle) if cycle else None,
        }
    month_name = MONTH_NAMES[slip.month - 1] if 1 <= slip.month <= 12 else str(slip.month)
    label = f"{month_name} {slip.year}"
    short = MONTH_ABBR[slip.month - 1] if 1 <= slip.month <= 12 else str(slip.month)
    if kind == KIND_LEGACY and slip.week_number:
        label = f"Week {slip.week_number} of {label}"
        short = f"Wk {slip.week_number} {short}"
    return {"label": label, "shortLabel": short, "start": None, "end": None, "cycle": cycle, "cycleLabel": None}


def _sort_key(slip: SalarySlip) -> tuple:
    start = slip.period_start
    return (slip.year, slip.month, start.toordinal() if start else 0, slip.week_number or 0, slip.id)


# ─────────────────────────────────────────────────────────────────────────────
#  One slip
# ─────────────────────────────────────────────────────────────────────────────


def _counts(kind: str, slip: SalarySlip, bd: dict | None) -> dict:
    """The attendance numbers behind the pay, exactly as stored (null where this kind of pay has no such number)."""
    s = (bd or {}).get("summary") or {}
    e = (bd or {}).get("earnings") or {}
    d = (bd or {}).get("deductions") or {}
    late = d.get("lateSummary") if isinstance(d.get("lateSummary"), dict) else {}
    perm = d.get("permissionSummary") if isinstance(d.get("permissionSummary"), dict) else {}
    out = {
        "workingDays": None,
        "paidDays": None,
        "presentDays": None,
        "absentDays": None,
        "paidLeaveDays": None,
        "unpaidLeaveDays": None,
        "halfDays": None,
        "lateMarks": None,
        "lateInDays": None,
        "earlyOutDays": None,
        "freeLateMarks": None,
        "billableLateMarks": None,
        "lateShifts": None,
        "permissionsApproved": None,
        "permissionsFree": None,
        "permissionsBeyondFree": None,
        "permissionsCharged": None,
        "permissionShifts": None,
        "dailyRate": None,
        "totalDays": None,
        "daysWorked": None,
        "totalShifts": None,
        "ratePerShift": None,
        "otShifts": None,
    }
    if kind == KIND_STAFF:
        out.update(
            workingDays=_int(s.get("totalWorkingDays", slip.working_days)),
            paidDays=_opt(s.get("effectivePaidDays")),
            presentDays=_opt(s.get("presentDays", slip.present_days)),
            absentDays=_opt(s.get("absentDays")) if s else None,
            paidLeaveDays=_opt(s.get("paidLeaveDays", slip.paid_leave_days)),
            unpaidLeaveDays=_opt(s.get("unpaidLeaveDays", slip.unpaid_leave_days)),
            halfDays=_int(s.get("halfShiftDays")),
            lateInDays=_int(s.get("lateDays", slip.late_days)),
            earlyOutDays=_int(s.get("earlyOutDays")),
            dailyRate=_opt(e.get("dailyRate")),
            otShifts=_opt(e.get("otShifts")),
        )
        if not s:  # an older slip: only the columns
            out["absentDays"] = money(slip.absent_days)
        if late:
            out.update(
                lateMarks=_int(late.get("totalLateCount")),
                freeLateMarks=_int(late.get("freeAllowance")),
                billableLateMarks=_int(late.get("billableLateCount")),
                lateShifts=_opt(late.get("shiftDeductions")),
            )
        if perm:
            out.update(
                permissionsApproved=_int(perm.get("approved")),
                permissionsFree=_int(perm.get("cap")),
                permissionsBeyondFree=_int(perm.get("excess")),
                permissionsCharged=_int(perm.get("billable")) if perm.get("enabled") else 0,
                permissionShifts=_opt(perm.get("shifts")) if perm.get("enabled") else 0.0,
            )
    else:
        out.update(
            totalDays=_int(s.get("totalDays", slip.working_days)),
            daysWorked=_int(s.get("daysWorked")),
            absentDays=_opt(s.get("daysAbsent", slip.absent_days)),
            totalShifts=_opt(s.get("totalShifts", slip.present_days)),
            ratePerShift=_opt((bd or {}).get("salaryPerShift")),
            lateInDays=slip.late_days,
        )
        if late:
            out.update(
                lateMarks=_int(late.get("totalLateCount")),
                billableLateMarks=_int(late.get("billableLateCount")),
                lateShifts=_opt(late.get("shiftDeductions")),
            )
    return out


def _figures(kind: str, slip: SalarySlip, payroll: Payroll | None, bd: dict | None) -> tuple[dict, dict]:
    """(figures, notes): the money of one slip, every number from what payroll stored; a null figure has a note."""
    e = (bd or {}).get("earnings") or {}
    d = (bd or {}).get("deductions") or {}
    notes: dict[str, str] = {}
    gross = dec(slip.gross_salary)
    other_column = dec(slip.other_deductions)

    allocated = None
    if kind == KIND_STAFF:
        if e.get("monthlySalary") is not None:
            allocated = dec(e.get("monthlySalary"))
        elif payroll is not None and payroll.salary_mode == Payroll.SALARY_MODE_MONTHLY:
            allocated = dec(payroll.base_salary)
        else:
            notes["allocated"] = NOTE_NO_ALLOCATED
            notes["absentLoss"] = NOTE_NO_ALLOCATED
    else:
        notes["allocated"] = NOTE_PRODUCTION_ALLOCATED
        notes["absentLoss"] = NOTE_PRODUCTION_ABSENT
    absent_loss = (allocated - gross) if allocated is not None else None

    late = permission = None
    if bd is None:
        notes["late"] = NOTE_NO_BREAKDOWN
        if kind == KIND_STAFF:
            notes["permission"] = NOTE_NO_BREAKDOWN
        else:
            notes["permission"] = NOTE_PRODUCTION_PERMISSION
    elif kind == KIND_STAFF:
        late = dec(d.get("lateShiftPenalty")) if d.get("lateShiftPenalty") is not None else None
        if late is None:
            notes["late"] = NOTE_NO_BREAKDOWN
        if "permissionPenalty" in d:
            permission = dec(d.get("permissionPenalty"))
        else:
            permission = Decimal("0") if late is not None else None
            notes["permission"] = NOTE_PERMISSION_OLD if late is not None else NOTE_NO_BREAKDOWN
    else:
        if d.get("lateShiftPenalty") is not None:
            late = dec(d.get("lateShiftPenalty"))
        else:
            notes["late"] = NOTE_PRODUCTION_LATE_OFF
        notes["permission"] = NOTE_PRODUCTION_PERMISSION

    # what is left of the slip's "Other deductions" column once the late / permission parts are taken out (0 on every
    # slip the current engine makes; the whole column on an older slip with no breakdown)
    other = other_column - (late or Decimal("0")) - (permission or Decimal("0")) if kind == KIND_STAFF else other_column
    parts = [x for x in (absent_loss, late, permission) if x is not None]
    pf, esi, tds = dec(slip.pf_deduction), dec(slip.esi_deduction), dec(slip.tds_deduction)
    figures = {
        "allocated": _opt(allocated),
        "earnedGross": money(gross),
        "absentLoss": _opt(absent_loss),
        "lateDeduction": _opt(late),
        "permissionDeduction": _opt(permission),
        "attendanceLoss": money(sum(parts, Decimal("0"))) if parts else None,
        "otPay": money(slip.ot_amount),
        "incentives": money(slip.incentives),
        "bonuses": money(slip.bonuses),
        "pf": money(pf),
        "esi": money(esi),
        "tds": money(tds),
        "tdsPercent": _opt(slip.tds_percent),
        "statutory": money(pf + esi + tds),
        "advance": money(slip.advance_deduction),
        "otherDeductions": money(other),
        "totalDeductions": money(slip.total_deductions),
        "netPayable": money(slip.net_salary),
    }
    return figures, notes


def _payroll_block(slip: SalarySlip, payroll: Payroll | None) -> dict | None:
    """What HR did on the payroll after the slip was made: paid or not, a bonus, a change to the deductions. The slip
    itself never changes after generation; the Payroll row can (payroll_views.payroll_detail)."""
    if payroll is None:
        return None
    bonus = dec(payroll.bonus)
    change = dec(payroll.deductions) - dec(slip.total_deductions)
    net = dec(payroll.final_salary)
    return {
        "status": payroll.status,
        "statusLabel": "Paid" if payroll.status == Payroll.STATUS_PAID else "Not paid yet",
        "bonus": money(bonus),
        "deductionChange": money(change),
        "net": money(net),
        "matchesSlip": net == dec(slip.net_salary) and bonus == 0 and change == 0,
        # HR added a bonus or changed the deductions. A saved net that differs WITHOUT either (the known "editing a payroll
        # drops its overtime pay" defect, payroll_views.payroll_detail) is not an HR decision: the phone does not show it.
        "hrChanged": bonus != 0 or change != 0,
    }


def _step(key, label, amount, op, note=None) -> dict:
    return {"key": key, "label": label, "amount": _opt(amount), "op": op, "note": note}


def _days_note(counts: dict) -> str:
    working, paid = counts.get("workingDays"), counts.get("paidDays")
    if working is None or paid is None:
        return "The salary for the days you were not paid for."
    if dec(paid) >= dec(working):
        return f"You were paid for all {working} working days: nothing was lost."
    reasons = []
    for key, one in (("absentDays", "absent day"), ("unpaidLeaveDays", "unpaid leave day"), ("halfDays", "half day")):
        value = counts.get(key)
        if value:
            reasons.append(plural(value, one))
    text = f"You were paid for {plain(paid)} of {working} working days"
    if reasons:
        text += " (" + ", ".join(reasons) + ")"
    rate = counts.get("dailyRate")
    if rate:
        text += f". One day is worth {inr(rate)}"
    return text + "."


def _late_note(kind: str, counts: dict, amount, permissions_priced: bool = False) -> str:
    marks = counts.get("lateMarks")
    if marks is None:
        return "Late marks this period, as payroll charged them."
    if kind != KIND_STAFF:
        billable = counts.get("billableLateMarks") or 0
        if not amount:
            return f"{plural(marks, 'late day')}: none charged." if marks else "No late days: nothing deducted."
        return f"{plural(marks, 'late day')}, {plain(billable)} charged = {shifts_text(counts.get('lateShifts') or 0)} of pay."
    free = counts.get("freeLateMarks")
    billable = counts.get("billableLateMarks") or 0
    if not marks:
        return "No late marks this month: nothing deducted."
    if not amount:
        return f"{plural(marks, 'late mark')}, all inside the {plain(free or 0)} free ones: nothing deducted."
    what = "late-in and early-out" if permissions_priced else "late-in, early-out and permissions beyond the free ones"
    text = f"{plural(marks, 'late mark')} ({what})"
    if free is not None:
        text += f", {plain(free)} free"
    text += f", {plain(billable)} charged = {shifts_text(counts.get('lateShifts') or 0)}"
    rate = counts.get("dailyRate")
    if rate:
        text += f" x {inr(rate)} a day"
    return text + "."


def _permission_note(counts: dict, amount, enabled: bool) -> str:
    approved = counts.get("permissionsApproved")
    free = counts.get("permissionsFree")
    if approved is None:
        return "Permissions this month, as payroll charged them."
    if not enabled:
        text = f"{plural(approved, 'approved permission')} this month"
        if free is not None:
            text += f", {plain(free)} free a month"
        return text + ". Permissions are not charged separately: any beyond the free ones count as late marks above."
    if not amount:
        return f"{plural(approved, 'approved permission')} this month: nothing charged."
    return (
        f"{plural(approved, 'approved permission')}, {plain(free or 0)} free a month, "
        f"{plain(counts.get('permissionsCharged') or 0)} charged = {shifts_text(counts.get('permissionShifts') or 0)} of pay."
    )


def _steps(kind: str, slip: SalarySlip, bd: dict | None, figures: dict, notes: dict, counts: dict) -> list[dict]:
    """The slip as a waterfall, top to bottom, each line with one sentence. The last line is the slip's own net pay."""
    steps: list[dict] = []
    e = (bd or {}).get("earnings") or {}
    d = (bd or {}).get("deductions") or {}
    if kind == KIND_STAFF and figures["allocated"] is not None:
        steps.append(
            _step(
                "allocated",
                "Monthly salary",
                figures["allocated"],
                "start",
                "Your full salary for the month, as set by HR.",
            )
        )
        steps.append(
            _step("absent_loss", "Not paid: days not worked", figures["absentLoss"], "minus", _days_note(counts))
        )
        rate, paid = counts.get("dailyRate"), counts.get("paidDays")
        steps.append(
            _step(
                "earned",
                "Salary earned",
                figures["earnedGross"],
                "subtotal",
                f"{inr(rate)} a day x {plain(paid)} days paid."
                if rate and paid is not None
                else "For the days you were paid.",
            )
        )
    elif kind == KIND_STAFF:
        steps.append(_step("earned", "Salary earned", figures["earnedGross"], "start", notes.get("allocated")))
    else:
        shifts, rate = counts.get("totalShifts"), counts.get("ratePerShift")
        note = (
            f"{plain(shifts)} shifts x {inr(rate)} a shift."
            if shifts is not None and rate
            else "Pay for the shifts worked."
        )
        absent = counts.get("absentDays")
        if absent:
            note += f" {plural(absent, 'absent day')} earned no shifts."
        steps.append(_step("earned", "Pay for shifts worked", figures["earnedGross"], "start", note))

    if figures["otPay"]:
        ot_shifts = counts.get("otShifts")
        rate = counts.get("dailyRate")
        note = "Overtime HR gave you as pay."
        if ot_shifts and rate:
            note = f"Overtime HR gave you as pay: {shifts_text(ot_shifts)} x {inr(rate)} a day."
        steps.append(_step("ot_pay", "Overtime pay", figures["otPay"], "plus", note))
    for key, label in (("incentives", "Incentives"), ("bonuses", "Bonus")):
        if figures[key]:
            steps.append(_step(key, label, figures[key], "plus", "Added on this slip."))

    perm = d.get("permissionSummary") if isinstance(d.get("permissionSummary"), dict) else {}
    steps.append(
        _step(
            "late",
            "Late deduction",
            figures["lateDeduction"],
            "minus",
            notes.get("late") or _late_note(kind, counts, figures["lateDeduction"], bool(perm.get("enabled"))),
        )
    )
    steps.append(
        _step(
            "permission",
            "Permission deduction",
            figures["permissionDeduction"],
            "minus",
            notes.get("permission")
            or _permission_note(counts, figures["permissionDeduction"], bool(perm.get("enabled"))),
        )
    )

    # PF / ESI / TDS with the same explanation the HR payroll details page gives (payroll_insights._statutory_lines)
    explained = {}
    if bd is not None:
        earned = dec(slip.gross_salary) + dec(slip.ot_amount)
        for line in _statutory_lines(d, e, earned, slip, kind == KIND_STAFF):
            explained[line["key"]] = line.get("note")
    for key, label in (("pf", "Provident Fund (PF)"), ("esi", "ESI"), ("tds", "Income tax (TDS)")):
        if figures[key]:
            if key == "tds" and figures["tdsPercent"] is not None:
                label = f"Income tax (TDS {plain(figures['tdsPercent'])}%)"
            steps.append(_step(key, label, figures[key], "minus", explained.get(key) or "Deducted by law."))
    if figures["advance"]:
        repayments = d.get("advanceDetails") if isinstance(d.get("advanceDetails"), list) else []
        note = "Repayment of your salary advance / loan due this period."
        if repayments:
            note = f"{plural(len(repayments), 'repayment')} of your salary advance / loan due this period."
        steps.append(_step("advance", "Advance / loan recovery", figures["advance"], "minus", note))
    if figures["otherDeductions"]:
        steps.append(
            _step(
                "other",
                "Other deductions",
                figures["otherDeductions"],
                "minus",
                NOTE_NO_BREAKDOWN if bd is None else "Other deductions on this slip.",
            )
        )
    steps.append(_step("net", "Final payable salary", figures["netPayable"], "total", "What this slip pays you."))
    return steps


def _reconciles(steps: list[dict]) -> bool:
    """Do the lines add up to the net pay line (to the paisa)? Always true for a slip the current engine made."""
    total = Decimal("0")
    for step in steps:
        amount = dec(step["amount"]) if step["amount"] is not None else Decimal("0")
        if step["op"] == "start":
            total = amount
        elif step["op"] == "plus":
            total += amount
        elif step["op"] == "minus":
            total -= amount
        elif step["op"] == "subtotal" and total != amount:
            return False
        elif step["op"] == "total":
            return total == amount
    return False


def period_json(slip: SalarySlip, payroll: Payroll | None) -> dict:
    """Everything the phone shows about one slip: its period, the figures, the attendance counts, the waterfall."""
    bd = breakdown_of(slip)
    kind = kind_of_slip(slip, bd)
    figures, notes = _figures(kind, slip, payroll, bd)
    counts = _counts(kind, slip, bd)
    steps = _steps(kind, slip, bd, figures, notes, counts)
    return {
        "slipId": slip.id,
        "slipNumber": slip.slip_number,
        "kind": kind,
        "month": slip.month,
        "year": slip.year,
        "weekNumber": slip.week_number,
        "period": period_info(slip, kind),
        "hasDetails": bd is not None,
        **figures,
        "counts": counts,
        "notes": notes,
        "steps": steps,
        "reconciles": _reconciles(steps),
        "payroll": _payroll_block(slip, payroll),
        "emailedAt": slip.emailed_at.isoformat() if slip.emailed_at else None,
    }


# ─────────────────────────────────────────────────────────────────────────────
#  A year
# ─────────────────────────────────────────────────────────────────────────────

_SUM_KEYS = (
    "earnedGross",
    "otPay",
    "pf",
    "esi",
    "tds",
    "statutory",
    "advance",
    "otherDeductions",
    "totalDeductions",
    "netPayable",
)
_OPTIONAL_SUM_KEYS = ("allocated", "absentLoss", "lateDeduction", "permissionDeduction", "attendanceLoss")


def year_summary(periods: list[dict]) -> dict:
    """The year's totals: plain sums of the periods' stored figures. An optional figure (allocated, loss, late,
    permission) is summed over the periods that have it; `allocatedPeriods` says how many did."""
    out: dict = {"periods": len(periods)}
    for key in _SUM_KEYS:
        out[key] = money(sum((dec(p[key]) for p in periods), Decimal("0")))
    for key in _OPTIONAL_SUM_KEYS:
        known = [dec(p[key]) for p in periods if p[key] is not None]
        out[key] = money(sum(known, Decimal("0"))) if known else None
    out["allocatedPeriods"] = sum(1 for p in periods if p["allocated"] is not None)
    out["paidDays"] = money(
        sum((dec(p["counts"]["paidDays"]) for p in periods if p["counts"]["paidDays"] is not None), Decimal("0"))
    )
    out["workingDays"] = sum(p["counts"]["workingDays"] or 0 for p in periods)
    return out


def insights_for(emp, year: int) -> dict:
    """GET /my/salary-insights: the employee's slips of `year`, oldest period first, and the year's totals."""
    all_years = sorted(set(SalarySlip.objects.filter(employee=emp).values_list("year", flat=True)), reverse=True)
    slips = list(SalarySlip.objects.select_related("employee").filter(employee=emp, year=year))
    slips.sort(key=_sort_key)
    payrolls = payrolls_by_key(emp.id, slips)
    periods = [period_json(s, payrolls.get(_key(s))) for s in slips]
    production = emp.employment_type == "production"
    notes = []
    if production:
        notes.append(NOTE_PRODUCTION_ALLOCATED)
    return {
        "employmentType": emp.employment_type,
        "year": year,
        "years": all_years,
        "periods": periods,
        "summary": year_summary(periods),
        "notes": notes,
    }


def breakdown_for(slip: SalarySlip) -> dict:
    """GET /my/salary-slips/<id>/breakdown: one slip, explained."""
    payrolls = payrolls_by_key(slip.employee_id, [slip])
    return period_json(slip, payrolls.get(_key(slip)))

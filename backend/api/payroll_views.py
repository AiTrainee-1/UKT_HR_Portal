"""
Enterprise Payroll Engine -UKTextiles HRMS
============================================
Two salary modes:
  • Staff    → monthly, pro-rated by working days (leave-aware, late-tracking)
  • Production → bi-weekly, session-based (morning + afternoon sessions)

All calculations are stored with full day-by-day breakdown in SalarySlip.breakdown_details
so every rupee can be explained to the employee.
"""


class PayrollSkip(Exception):
    """Raised by the payroll engines with a precise, user-facing reason an
    employee was skipped -so the Generate Payroll result always tells HR
    exactly what to fix, instead of one generic catch-all message covering
    unrelated conditions (no salary configured vs. no working days vs. a
    real computation error)."""


import calendar
import io
from datetime import date, datetime, time, timedelta
from decimal import Decimal, ROUND_HALF_UP

from django.db import transaction
from rest_framework.decorators import api_view, parser_classes
from rest_framework.parsers import FormParser, MultiPartParser
from rest_framework.request import Request
from rest_framework.response import Response

from .auth import require_hr
from .branch_scope import scope_to_branch
from .audit_utils import log_action
from .user_settings import (
    _SettingsOverlay, persist_overlay, settings_for, settings_for_employee,
)
from .geo_attendance_views import source_label
from .permission_registry import resolve_permission
from .models import (
    Advance,
    AdvanceRepayment,
    Attendance,
    AttendanceLog,
    Employee,
    EmployeeShiftAssignment,
    Holiday,
    LeaveRequest,
    MonthlyShiftSummary,
    Payroll,
    PayrollSettings,
    SalarySlip,
    SessionConfig,
    WorkSession,
)


# ─────────────────────────────────────────────────────────────────────────────
#  Utilities
# ─────────────────────────────────────────────────────────────────────────────

def _error(msg: str, code: int = 400) -> Response:
    return Response({"error": msg}, status=code)


def _d2(value) -> Decimal:
    """Round to 2 decimal places."""
    return Decimal(str(value)).quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)


def _time_to_str(t: time | None) -> str | None:
    return t.strftime("%H:%M") if t else None


def _compute_hours(check_in: time, check_out: time) -> Decimal:
    dt_in = datetime.combine(date.today(), check_in)
    dt_out = datetime.combine(date.today(), check_out)
    if dt_out <= dt_in:
        dt_out += timedelta(days=1)
    return _d2((dt_out - dt_in).total_seconds() / 3600)


# ─────────────────────────────────────────────────────────────────────────────
#  Shift assignment lookup
# ─────────────────────────────────────────────────────────────────────────────

def _get_active_assignment(emp: Employee, ref_date: date) -> EmployeeShiftAssignment | None:
    """Return the shift assignment active on ref_date, or the most recent one."""
    qs = (
        EmployeeShiftAssignment.objects
        .select_related("shift")
        .filter(employee=emp, effective_from__lte=ref_date)
        .filter(models_effective_to_null_or_after(ref_date))
        .order_by("-effective_from")
    )
    return qs.first()


def models_effective_to_null_or_after(ref_date: date):
    """Returns a Q object: effective_to is null OR effective_to >= ref_date."""
    from django.db.models import Q
    return Q(effective_to__isnull=True) | Q(effective_to__gte=ref_date)


def _effective_shift_times(assignment: EmployeeShiftAssignment):
    """Return (start_time, end_time, grace_minutes, saturday_off) for an assignment."""
    shift = assignment.shift
    start = assignment.custom_start_time or shift.start_time
    end = assignment.custom_end_time or shift.end_time
    # `or` would turn an explicit 0-minute grace into a phantom default —
    # the shift's configured value is authoritative, including zero.
    grace = shift.grace_period_minutes if shift.grace_period_minutes is not None else 0
    sat_off = assignment.saturday_off
    return start, end, grace, sat_off


# ─────────────────────────────────────────────────────────────────────────────
#  Working-day calendar (staff)
# ─────────────────────────────────────────────────────────────────────────────

def _build_working_days(month: int, year: int, saturday_off: bool, holiday_dates: set[date]) -> list[date]:
    """
    Return all working dates in the month for a staff employee.
    Excludes: Sundays (always), Saturdays (if saturday_off), public holidays.
    """
    first = date(year, month, 1)
    last = date(year, month, calendar.monthrange(year, month)[1])
    days = []
    cur = first
    while cur <= last:
        wd = cur.weekday()  # 0=Mon … 6=Sun
        if wd == 6:  # Sunday
            cur += timedelta(days=1)
            continue
        if wd == 5 and saturday_off:
            cur += timedelta(days=1)
            continue
        if cur in holiday_dates:
            cur += timedelta(days=1)
            continue
        days.append(cur)
        cur += timedelta(days=1)
    return days


# ─────────────────────────────────────────────────────────────────────────────
#  Per-day attendance status -sourced entirely from attendance_final's
#  compute_month_records (see _generate_staff_payroll below). This used to
#  have its own independent classifier here (_classify_day, reading raw
#  AttendanceLog/Attendance rows directly) for strict-mode staff, running
#  alongside -and capable of disagreeing with -the engine every other
#  screen uses. Retired 2026-07-25: one engine, one answer, everywhere.
# ─────────────────────────────────────────────────────────────────────────────


# ─────────────────────────────────────────────────────────────────────────────
#  Advance deductions helper
# ─────────────────────────────────────────────────────────────────────────────

def _mark_repayments_processed(advance_details: list[dict]) -> None:
    """After payroll slip is saved, mark the deducted repayments as processed."""
    from decimal import Decimal as D
    for detail in advance_details:
        try:
            rep = AdvanceRepayment.objects.select_related("advance").get(pk=detail["repaymentId"])
            if rep.is_processed:
                continue
            rep.is_processed = True
            rep.save(update_fields=["is_processed"])
            adv = rep.advance
            adv.total_repaid = D(str(adv.total_repaid)) + D(str(rep.amount))
            adv.outstanding = max(D("0"), D(str(adv.amount)) - D(str(adv.total_repaid)))
            if adv.outstanding == 0:
                adv.status = "closed"
            adv.save(update_fields=["total_repaid", "outstanding", "status"])
        except AdvanceRepayment.DoesNotExist:
            pass


def late_shift_deduction(billable_late: int, settings, slabs_field: str = "late_deduction_slabs") -> Decimal:
    """
    Shifts deducted for `billable_late` chargeable occurrences, per an
    HR-editable slab table (Settings → Late Detection). `slabs_field` picks
    which PayrollSettings JSON field to read -defaults to the original Late
    Attendance pool; pass "without_permission_deduction_slabs" for the
    separate Without Permission pool instead. Same shape/semantics either way.

    Each slab row is {"fromLates": N, "deductionShifts": D} -"once the
    billable count reaches N, deduct D shifts". Rows are evaluated in
    ascending order and the HIGHEST matching row wins; the last row's value
    holds for any count beyond it. An empty table means no deduction at all,
    which is how HR switches a pool's penalty off entirely.

    The shipped default for the Late Attendance pool (see
    _default_late_deduction_slabs in models.py) reproduces the formula this
    replaced -every 3 billable lates costs a quarter shift -so existing
    payroll math is unchanged. The Without Permission pool ships empty.
    """
    rows: list[tuple[int, Decimal]] = []
    for row in (getattr(settings, slabs_field, None) or []):
        if not isinstance(row, dict):
            continue
        try:
            rows.append((int(row["fromLates"]), Decimal(str(row["deductionShifts"]))))
        except (KeyError, TypeError, ValueError, ArithmeticError):
            continue  # skip malformed rows rather than failing the whole run
    if not rows:
        return Decimal("0")

    rows.sort(key=lambda r: r[0])
    deduction = Decimal("0")
    for from_lates, shifts in rows:
        if billable_late >= from_lates:
            deduction = shifts
        else:
            break
    return deduction


def _production_late_days(emp: Employee, records, ps) -> tuple[int, dict]:
    """
    Per-day late check for Production Late Detection (Settings → Payroll →
    Production) -entirely independent of AttendanceDayRecord.is_late, which
    reflects the global ProductionShiftConfig singleton and drives
    shifts_earned/pay (left completely untouched here). This instead keys
    off the employee's Manage-Shift-assigned Production ShiftTemplate, per
    explicit user instruction ("shift calculation and late detection should
    be based on the Production shift rules configured there").

    Returns (late_count, {date: reason}). A day with no first_punch
    (absent) or no assigned shift for that date is skipped entirely -no
    reference to check against, so no penalty is ever applied blindly.
    """
    from .shift_engine import _get_shift_for_date, _t2s, _s2t

    late_count = 0
    reasons: dict = {}
    for rec in records:
        if not rec.first_punch:
            continue
        shift = _get_shift_for_date(emp, rec.date)
        if shift is None:
            continue
        grace = (shift.grace_period_minutes or 0) * 60
        deadline_start = _t2s(shift.start_time) + grace
        is_late = _t2s(rec.first_punch) > deadline_start
        parts = []
        if is_late:
            parts.append(
                f"First punch {rec.first_punch.strftime('%H:%M')} after {shift.name} "
                f"start {shift.start_time.strftime('%H:%M')} + {shift.grace_period_minutes} "
                f"min grace ({_s2t(deadline_start).strftime('%H:%M')})"
            )
        if ps.prod_attendance_mode == "strict" and rec.last_punch:
            deadline_end = _t2s(shift.end_time) - grace
            if _t2s(rec.last_punch) < deadline_end:
                is_late = True
                parts.append(
                    f"Last punch {rec.last_punch.strftime('%H:%M')} before {shift.name} "
                    f"end {shift.end_time.strftime('%H:%M')} - {shift.grace_period_minutes} "
                    f"min grace ({_s2t(deadline_end).strftime('%H:%M')})"
                )
        if is_late:
            late_count += 1
            reasons[rec.date] = " / ".join(parts)
    return late_count, reasons


def _pending_advance_repayments(emp: Employee, month: int, year: int) -> tuple[Decimal, list[dict]]:
    """
    Find all pending advance repayments due in this month and return
    (total_amount, list_of_details).
    """
    repayments = (
        AdvanceRepayment.objects
        .select_related("advance")
        .filter(advance__employee=emp, month=month, year=year, is_processed=False)
    )
    total = Decimal("0")
    details = []
    for r in repayments:
        total += r.amount
        details.append({
            "advanceId": r.advance_id,
            "repaymentId": r.id,
            "amount": float(r.amount),
            "notes": r.notes,
        })
    return total, details


# ─────────────────────────────────────────────────────────────────────────────
#  STAFF payroll engine
# ─────────────────────────────────────────────────────────────────────────────

def _generate_staff_payroll(emp: Employee, month: int, year: int, settings=None) -> dict:
    """
    Pro-rated monthly payroll for a staff employee.
    Returns a dict with 'payroll' and 'slip' keys (model instances).
    Raises PayrollSkip with a precise reason if this employee can't be paid
    for this month (no salary configured, no working days, etc).
    """
    if not emp.salary_amount:
        raise PayrollSkip("No Salary Amount set on this employee's profile")

    # 1. Get shift assignment for middle of month (representative date).
    #    Shift start and grace come solely from the assigned shift -there is
    #    no global default. Without an assignment, late detection is disabled
    #    (grace_minutes=None) because there is no basis to judge lateness.
    mid_month = date(year, month, 15)
    assignment = _get_active_assignment(emp, mid_month)
    shift_start: time | None = None
    grace_minutes: int | None = None
    saturday_off = False

    if assignment:
        shift_start, _, grace_minutes, saturday_off = _effective_shift_times(assignment)
        shift_name = assignment.shift.name
        shift_id = assignment.shift_id
    else:
        shift_name = "No shift assigned"
        shift_id = None

    # 2. Get holidays for this month
    holiday_dates = set(
        Holiday.objects.filter(date__year=year, date__month=month).values_list("date", flat=True)
    )

    # 3. Build working-day calendar
    working_days_list = _build_working_days(month, year, saturday_off, holiday_dates)
    total_working_days = len(working_days_list)

    if total_working_days == 0:
        raise PayrollSkip(
            f"No working days found in {month}/{year} for this employee's shift "
            "(check Holidays and Saturday-off configuration)"
        )

    # 4. Fetch approved leave requests that overlap this month
    month_start = date(year, month, 1)
    month_end = date(year, month, calendar.monthrange(year, month)[1])
    approved_leaves = list(
        LeaveRequest.objects
        .select_related("leave_type_ref")
        .filter(
            employee=emp,
            status="approved",
            start_date__lte=month_end.isoformat(),
            end_date__gte=month_start.isoformat(),
        )
    )

    # 5. Final attendance records -the ONE engine every screen in the app
    #    uses (attendance_final.compute_month_records), for every day and
    #    every attendance mode. Internally this already applies the correct
    #    strict/simple classification, night-shift relaxation, and manual
    #    HR overrides (source="manual" rows are returned untouched) -payroll
    #    no longer needs (or has) its own separate classification path.
    from .models import PayrollSettings as _PS
    from .attendance_final import compute_month_records
    _settings = _PS.get()
    use_simple = _settings.attendance_mode == "simple"
    final_records = compute_month_records(emp, year, month, _settings)
    final_by_date = {r.date: r for r in final_records}

    # 6. Classify each working day
    DAY_NAMES = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"]
    days_detail = []
    present_count = 0
    paid_leave_count = 0
    unpaid_leave_count = 0
    absent_count = 0
    late_count = 0
    without_permission_count = 0
    half_shift_count = 0
    full_shift_count = 0
    effective_present = Decimal("0")  # accumulates 0.5 or 1.0 per present day

    for d in working_days_list:
        fr = final_by_date.get(d)
        if fr is not None:
            fr_status = fr.status
            if fr_status in ("present", "half_shift"):
                status = "present"
            elif fr_status == "on_leave":
                # Approved Leave Requests (mobile/web "Leave" feature) are
                # informational only, not a paid-leave entitlement -the only
                # paid leave this company has is Casual Leave, which is a
                # separate system (CasualLeaveRequest) that already marks the
                # day Present directly and never reaches this branch. So an
                # on_leave day here counts as Absent for pay while still
                # displaying as "Unpaid Leave" (not a bare Absent) so HR can
                # see it was a declared leave.
                status = "unpaid_leave"
            elif fr_status == "holiday":
                # A day marked holiday by override shouldn't reduce pay
                status = "paid_leave"
            else:
                status = "absent"
            info = {
                "status": status,
                "is_late": fr.is_late,
                "without_permission": bool(fr.late_in_without_permission or fr.early_out_without_permission),
                "late_reason": fr.late_reason,
                "first_in": fr.first_punch.strftime("%H:%M") if fr.first_punch else None,
                "last_out": fr.last_punch.strftime("%H:%M") if fr.last_punch else None,
                "leave_type": None,
            }
            forced_shifts = Decimal(str(fr.shifts_earned or 0))
            forced_half = fr.is_half_shift or fr_status == "half_shift"
        else:
            # A working day beyond what compute_month_records has reached yet
            # (it only computes up to today) -nothing has happened there,
            # so simply absent for now; this in-progress-month preview gets
            # recalculated once those days actually elapse.
            status = "absent"
            info = {"status": "absent", "is_late": False, "without_permission": False, "late_reason": None, "first_in": None, "last_out": None, "leave_type": None}
            forced_shifts = Decimal("0")
            forced_half = False

        is_late = info["is_late"]
        is_half = False
        day_shifts = Decimal("1.00")

        if status == "present":
            present_count += 1
            if is_late:
                late_count += 1
            if info["without_permission"]:
                without_permission_count += 1
            day_shifts = forced_shifts if forced_shifts > 0 else Decimal("1.00")
            if forced_half or day_shifts == Decimal("0.50"):
                is_half = True
                half_shift_count += 1
            else:
                full_shift_count += 1
            effective_present += day_shifts
        elif status == "paid_leave":
            paid_leave_count += 1
        elif status == "unpaid_leave":
            unpaid_leave_count += 1
        else:
            absent_count += 1

        days_detail.append({
            "date": d.isoformat(),
            "day": DAY_NAMES[d.weekday()],
            "status": status,
            "isLate": is_late,
            "withoutPermission": info["without_permission"],
            "lateReason": info["late_reason"],
            "firstIn": info["first_in"],
            "lastOut": info["last_out"],
            "leaveType": info["leave_type"],
            "shiftsCompleted": float(day_shifts) if status == "present" else 0.0,
            "isHalfShift": is_half,
        })

    # 7. Salary calculation
    # effective_days = sum of shifts_completed for present days + paid leave days
    # (half shift days contribute 0.5 instead of 1.0)
    effective_days = effective_present + Decimal(str(paid_leave_count))
    # Keep full precision through the division AND the multiplication —
    # rounding the daily rate first (then multiplying back by the same
    # working-days count) silently loses a few paise per day, so a fully
    # present employee's gross salary came out short of their actual
    # configured salary_amount (e.g. 8000/26=307.6923..., rounded to
    # 307.69, x26 = 7999.94 instead of exactly 8000). Round only the final
    # result, once. `daily_rate` (rounded) is kept for display/breakdown
    # and the late-penalty calc below -those are fine to round, since
    # neither one needs to algebraically reconstruct the full salary.
    daily_rate_exact = emp.salary_amount / Decimal(str(total_working_days))
    base_gross = _d2(daily_rate_exact * effective_days)
    daily_rate = _d2(daily_rate_exact)

    # Basic = 50% of full monthly salary (not prorated -this is the component base)
    basic_full = _d2(emp.salary_amount * Decimal("0.50"))
    hra_full = _d2(emp.salary_amount * Decimal("0.20"))

    # Prorate basic and HRA by the same factor
    prorate_factor = effective_days / Decimal(str(total_working_days))
    basic = _d2(basic_full * prorate_factor)
    hra = _d2(hra_full * prorate_factor)
    allowances = _d2(base_gross - basic - hra)

    # PF / ESI -read live from PayrollSettings. The Staff Payroll Rules
    # master toggle (Settings → Payroll) must be ON for any deduction to
    # apply; rates alone are not enough.
    # Resolved from the EMPLOYEE's branch, not from whoever is logged in.
    # That is what makes an Admin regeneration reproduce exactly what the
    # branch login would have produced, and lets one Admin run spanning
    # several branches apply each branch's own rates.
    ps = settings if settings is not None else settings_for_employee(emp)
    if ps.staff_payroll_rules_enabled:
        pf_rate     = ps.pf_rate / Decimal("100")          # e.g. 12 -> 0.12
        esi_rate    = ps.esi_rate / Decimal("100")          # e.g. 0.75 -> 0.0075
        esi_ceiling = ps.esi_applicable_below

        pf_deduction = _d2(basic * pf_rate) if pf_rate > 0 else Decimal("0")

        monthly_gross_equivalent = _d2(emp.salary_amount)
        esi_deduction = (
            _d2(base_gross * esi_rate)
            if esi_rate > 0 and monthly_gross_equivalent <= esi_ceiling
            else Decimal("0")
        )
    else:
        pf_deduction = Decimal("0")
        esi_deduction = Decimal("0")

    # 8. Late shift penalty -free allowance and deduction slabs are both
    #    HR-editable (Settings → Late Detection); the shipped defaults are
    #    the values this used to hardcode (3 free/month, every 3 billable
    #    = ¼ shift), so out of the box nothing changes.
    #    late_count comes from the day loop above, itself sourced entirely
    #    from compute_month_records -one number regardless of attendance
    #    mode, instead of the old two-formula split (simple: is_late flags /
    #    strict: a separate DailyShiftLog-based MonthlyShiftSummary). All
    #    approved permission requests this month count as late entries too,
    #    merged into the same late-punch pool. ONE shared 3-free allowance
    #    covers the combined raw total -permissions are NOT pre-filtered by
    #    their own 3-free before merging, since that would double-discount
    #    the free allowance.
    from .models import EmployeePermission
    approved_permissions = EmployeePermission.objects.filter(
        employee=emp, date__year=year, date__month=month, status="approved",
    ).count()

    total_late = late_count + approved_permissions
    free_permissions = max(0, int(getattr(_settings, "late_free_allowance", 3) or 0))
    billable_late = max(0, total_late - free_permissions)
    shift_deductions = late_shift_deduction(billable_late, _settings)
    late_penalty = _d2(shift_deductions * daily_rate) if shift_deductions > 0 else Decimal("0")
    late_summary_data = {
        "totalLateCount": late_count,
        "permissionsUsed": min(total_late, free_permissions),
        "billableLateCount": billable_late,
        "shiftDeductions": float(shift_deductions),
    }

    # 8b. Without Permission penalty -a SEPARATE pool from Late Attendance
    #    above (Settings → Late Detection → Without Permission). Counts
    #    late-in/early-out occurrences inside the 1-hour permission window
    #    that had no approved Permission covering them (see
    #    AttendanceDayRecord.late_in_without_permission/early_out_without_
    #    permission -sourced from the same day-loop as late_count, so no
    #    extra query). Ships with an empty slab table by default, so this is
    #    zero-impact until HR explicitly configures it.
    wp_free_allowance = max(0, int(getattr(_settings, "without_permission_free_allowance", 0) or 0))
    billable_without_permission = max(0, without_permission_count - wp_free_allowance)
    wp_shift_deductions = late_shift_deduction(
        billable_without_permission, _settings, slabs_field="without_permission_deduction_slabs",
    )
    without_permission_penalty = _d2(wp_shift_deductions * daily_rate) if wp_shift_deductions > 0 else Decimal("0")
    without_permission_summary_data = {
        "totalCount": without_permission_count,
        "freeAllowanceUsed": min(without_permission_count, wp_free_allowance),
        "billableCount": billable_without_permission,
        "shiftDeductions": float(wp_shift_deductions),
    }

    if not use_simple:
        # Strict mode still gets its DailyShiftLog/MonthlyShiftSummary
        # refreshed here (mirrors what compute_month_records already did to
        # DailyShiftLog as a side effect of computing each day above) -the
        # mobile/web "My Shift" screens read MonthlyShiftSummary directly.
        # Its return value is intentionally NOT used for late_penalty above;
        # that always comes from the single day-loop-derived late_count now.
        from .shift_engine import compute_monthly_shift_summary
        compute_monthly_shift_summary(emp, year, month, daily_rate)

    # 9. Advances
    advance_total, advance_details = _pending_advance_repayments(emp, month, year)

    total_deductions = _d2(pf_deduction + esi_deduction + advance_total + late_penalty + without_permission_penalty)
    net_salary = _d2(base_gross - total_deductions)

    # 9. Build breakdown JSON (full traceability)
    breakdown = {
        "type": "staff",
        "attendanceMode": "simple" if use_simple else "strict",
        "simpleHalfShiftCutoff": str(_settings.simple_half_shift_cutoff)[:5] if use_simple else None,
        "shiftPunctualityWindowMinutes": _settings.shift_punctuality_window_minutes,
        "shift": {
            "id": shift_id,
            "name": shift_name,
            "startTime": shift_start.strftime("%H:%M") if shift_start else None,
            "gracePeriodMinutes": grace_minutes,
            "saturdayOff": saturday_off,
        },
        "days": days_detail,
        "summary": {
            "totalWorkingDays": total_working_days,
            "presentDays": present_count,
            "paidLeaveDays": paid_leave_count,
            "unpaidLeaveDays": unpaid_leave_count,
            "absentDays": absent_count,
            "lateDays": late_count,
            "withoutPermissionDays": without_permission_count,
            "halfShiftDays": half_shift_count,
            "fullShiftDays": full_shift_count,
            "effectivePaidDays": float(effective_days),
        },
        "earnings": {
            "monthlySalary": float(emp.salary_amount),
            "dailyRate": float(daily_rate),
            "effectiveDays": float(effective_days),
            "basic": float(basic),
            "hra": float(hra),
            "allowances": float(allowances),
            "grossSalary": float(base_gross),
        },
        "deductions": {
            "pf": float(pf_deduction),
            "pfRate": float(ps.pf_rate),
            "esi": float(esi_deduction),
            "esiRate": float(ps.esi_rate),
            "esiApplicableBelow": float(esi_ceiling),
            "advances": float(advance_total),
            "advanceDetails": advance_details,
            "lateShiftPenalty": float(late_penalty),
            "lateSummary": late_summary_data,
            "withoutPermissionPenalty": float(without_permission_penalty),
            "withoutPermissionSummary": without_permission_summary_data,
            "total": float(total_deductions),
        },
        "netSalary": float(net_salary),
    }

    # 10. Upsert Payroll record
    payroll, _ = Payroll.objects.update_or_create(
        employee=emp, month=month, year=year, week_number=None,
        defaults=dict(
            salary_mode="monthly",
            total_working_days=total_working_days,
            present_days=Decimal(str(present_count + paid_leave_count)),
            absent_days=Decimal(str(absent_count + unpaid_leave_count)),
            completed_sessions=0,
            ot_hours=Decimal("0"),
            ot_amount=Decimal("0"),
            base_salary=emp.salary_amount,
            gross_salary=base_gross,
            deductions=total_deductions,
            bonus=Decimal("0"),
            final_salary=net_salary,
            status="pending",
            notes=(
                f"Staff monthly: {present_count} present + {paid_leave_count} paid leave "
                f"= {float(effective_days)} effective days / {total_working_days} working days. "
                f"Late: {late_count}. Without Permission: {without_permission_count}. "
                f"Absent: {absent_count}. Unpaid leave: {unpaid_leave_count}."
            ),
        ),
    )

    # 11. Upsert SalarySlip
    slip_number = f"SS/{emp.employee_code}/{year}/{str(month).zfill(2)}"
    slip, _ = SalarySlip.objects.update_or_create(
        employee=emp, month=month, year=year, week_number=None,
        defaults=dict(
            payroll_run=None,
            slip_number=slip_number,
            basic=basic,
            hra=hra,
            allowances=allowances,
            incentives=Decimal("0"),
            bonuses=Decimal("0"),
            ot_amount=Decimal("0"),
            gross_salary=base_gross,
            pf_deduction=pf_deduction,
            esi_deduction=esi_deduction,
            advance_deduction=advance_total,
            other_deductions=_d2(late_penalty + without_permission_penalty),
            total_deductions=total_deductions,
            net_salary=net_salary,
            working_days=total_working_days,
            present_days=Decimal(str(present_count)),
            absent_days=Decimal(str(absent_count + unpaid_leave_count)),
            paid_leave_days=Decimal(str(paid_leave_count)),
            unpaid_leave_days=Decimal(str(unpaid_leave_count)),
            late_days=late_count,
            completed_sessions=0,
            breakdown_details=breakdown,
        ),
    )

    # Mark advance repayments as processed and update advance outstanding totals
    if advance_details:
        _mark_repayments_processed(advance_details)

    return {"payroll": payroll, "slip": slip}


# ─────────────────────────────────────────────────────────────────────────────
#  PRODUCTION payroll engine (bi-weekly, session-based)
# ─────────────────────────────────────────────────────────────────────────────

def _session_completed(first_in: time, last_out: time | None, min_checkout: time) -> bool:
    """
    A session is counted as completed when:
      - The employee arrived on or before min_checkout time
      - AND punched out on or after min_checkout time
    This handles:
      Morning session (min_checkout=12:40): arrived by 12:40 AND left after 12:40
      Afternoon session (min_checkout=17:30): arrived by 17:30 AND left after 17:30
    """
    if last_out is None:
        return False
    in_secs = first_in.hour * 3600 + first_in.minute * 60
    out_secs = last_out.hour * 3600 + last_out.minute * 60
    cutoff_secs = min_checkout.hour * 3600 + min_checkout.minute * 60
    return in_secs <= cutoff_secs and out_secs >= cutoff_secs


def _generate_production_payroll(emp: Employee, period_start: date, period_end: date, settings=None) -> dict:
    """
    Shift-based payroll for production employees -completely separate from
    the staff engine. No monthly salary, no proration, no leave/permission/
    CL: pay = total shifts earned x salary_per_shift.

    period_start/period_end (both inclusive) come from
    production_period.py::resolve_production_period, driven by Settings →
    Payroll → Production (frequency + period style). Callers are
    responsible for confirming period_end has already elapsed before
    calling this.
    """
    if not emp.salary_per_shift or emp.salary_per_shift <= 0:
        raise PayrollSkip("No Salary Per Shift set on this employee's profile")

    from .attendance_final import compute_range_records

    ps = settings if settings is not None else settings_for_employee(emp)
    date_from, date_to = period_start, period_end
    records = compute_range_records(emp, date_from, date_to)

    DAY_NAMES = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"]
    days_detail = []
    total_shifts = Decimal("0")
    days_worked = 0
    days_absent = 0

    for rec in records:
        shifts = rec.shifts_earned or Decimal("0")
        total_shifts += shifts
        if rec.status in ("present", "half_shift"):
            days_worked += 1
        elif rec.status == "absent":
            days_absent += 1
        days_detail.append({
            "date": rec.date.isoformat(),
            "day": DAY_NAMES[rec.date.weekday()],
            "firstPunch": rec.first_punch.strftime("%H:%M") if rec.first_punch else None,
            "lastPunch": rec.last_punch.strftime("%H:%M") if rec.last_punch else None,
            "shiftsEarned": float(shifts),
            "status": rec.status,
            # Overwritten below (with lateReason) when Production Late
            # Detection is enabled -otherwise this stays the
            # ProductionShiftConfig-based flag AttendanceDayRecord already
            # carries, purely informational and never fed into pay either way.
            "isLate": rec.is_late,
            "lateReason": None,
        })

    # Production Late Detection (Settings → Payroll → Production) -entirely
    # additive: shifts_earned/gross above is computed exactly as before this
    # feature existed. Off by default (prod_late_detection_enabled=False),
    # so this block is a no-op until HR explicitly configures it.
    late_penalty = Decimal("0")
    late_summary = None
    if ps.prod_late_detection_enabled:
        late_count, late_reasons = _production_late_days(emp, records, ps)
        billable_late = max(0, late_count - (ps.prod_late_free_allowance or 0))
        deduction_shifts = late_shift_deduction(billable_late, ps, slabs_field="prod_late_deduction_slabs")
        if deduction_shifts > 0:
            late_penalty = _d2(deduction_shifts * emp.salary_per_shift)
        late_summary = {
            "totalLateCount": late_count,
            "billableLateCount": billable_late,
            "shiftDeductions": float(deduction_shifts),
        }
        for day in days_detail:
            reason = late_reasons.get(date.fromisoformat(day["date"]))
            day["isLate"] = reason is not None
            day["lateReason"] = reason

    salary_per_shift = emp.salary_per_shift
    gross_amount = _d2(total_shifts * salary_per_shift)

    # PF / EF for production -either salary-range rules (when enabled) or flat rates
    monthly_equiv = _d2(gross_amount * 2)  # biweekly * 2 = monthly estimate

    matched_rule = None
    if ps.prod_pf_ef_enabled:
        for rule in (ps.prod_pf_ef_rules or []):
            try:
                lo = Decimal(str(rule.get("minSalary", 0) or 0))
                hi = Decimal(str(rule.get("maxSalary", 0) or 0))
            except Exception:
                continue
            # maxSalary 0 means "no upper limit"
            if monthly_equiv >= lo and (hi <= 0 or monthly_equiv <= hi):
                matched_rule = rule
                break

    if matched_rule is not None:
        rule_pf = Decimal(str(matched_rule.get("pfRate", 0) or 0)) / Decimal("100")
        rule_ef = Decimal(str(matched_rule.get("efRate", 0) or 0)) / Decimal("100")
        pf_deduction = _d2(gross_amount * rule_pf) if rule_pf > 0 else Decimal("0")
        esi_deduction = _d2(gross_amount * rule_ef) if rule_ef > 0 else Decimal("0")
        applied_pf_rate = Decimal(str(matched_rule.get("pfRate", 0) or 0))
        applied_ef_rate = Decimal(str(matched_rule.get("efRate", 0) or 0))
    elif ps.prod_payroll_rules_enabled:
        # Flat rates apply only when the Production Payroll Rules master
        # toggle (Settings → Payroll) is ON -mirrors the staff toggle.
        prod_pf_rate  = ps.prod_pf_rate / Decimal("100")
        prod_esi_rate = ps.prod_esi_rate / Decimal("100")
        prod_esi_ceil = ps.prod_esi_applicable_below
        pf_deduction = _d2(gross_amount * prod_pf_rate) if prod_pf_rate > 0 else Decimal("0")
        esi_deduction = (
            _d2(gross_amount * prod_esi_rate)
            if prod_esi_rate > 0 and monthly_equiv <= prod_esi_ceil
            else Decimal("0")
        )
        applied_pf_rate = ps.prod_pf_rate
        applied_ef_rate = ps.prod_esi_rate
    else:
        pf_deduction = Decimal("0")
        esi_deduction = Decimal("0")
        applied_pf_rate = Decimal("0")
        applied_ef_rate = Decimal("0")

    # Advance-repayment lookups stay month/year-keyed (that schedule is
    # itself a monthly concept) -a period is attributed to the month it
    # ENDS in. If a company's period frequency ever produces two periods
    # ending in the same month, the second one simply finds nothing left
    # pending (the first already claimed it via _mark_repayments_processed).
    month, year = period_end.month, period_end.year
    advance_total, advance_details = _pending_advance_repayments(emp, month, year)

    total_deductions = _d2(pf_deduction + esi_deduction + advance_total + late_penalty)
    net_salary = _d2(gross_amount - total_deductions)

    total_days = (date_to - date_from).days + 1

    breakdown = {
        "type": "production",
        "periodStart": period_start.isoformat(),
        "periodEnd": period_end.isoformat(),
        "dateFrom": date_from.isoformat(),
        "dateTo": date_to.isoformat(),
        "salaryPerShift": float(salary_per_shift),
        "days": days_detail,
        "summary": {
            "totalDays": total_days,
            "daysWorked": days_worked,
            "daysAbsent": days_absent,
            "totalShifts": float(total_shifts),
        },
        "earnings": {
            "totalShifts": float(total_shifts),
            "salaryPerShift": float(salary_per_shift),
            "grossSalary": float(gross_amount),
        },
        "deductions": {
            "pf": float(pf_deduction),
            "pfRate": float(applied_pf_rate),
            "esi": float(esi_deduction),
            "esiRate": float(applied_ef_rate),
            "esiApplicableBelow": float(ps.prod_esi_applicable_below),
            "monthlyEquivalent": float(monthly_equiv),
            # Which salary-range rule was applied (null = flat rates were used)
            "pfEfRule": (
                {
                    "label": matched_rule.get("label") or "Salary-range rule",
                    "pfRate": float(matched_rule.get("pfRate", 0) or 0),
                    "efRate": float(matched_rule.get("efRate", 0) or 0),
                }
                if matched_rule is not None else None
            ),
            "advances": float(advance_total),
            "advanceDetails": advance_details,
            "lateShiftPenalty": float(late_penalty) if late_summary is not None else None,
            "lateSummary": late_summary,
            "total": float(total_deductions),
        },
        "netSalary": float(net_salary),
    }

    payroll, _ = Payroll.objects.update_or_create(
        employee=emp, period_start=period_start, period_end=period_end,
        defaults=dict(
            salary_mode="shift",
            month=month, year=year, week_number=None,
            total_working_days=total_days,
            present_days=total_shifts,
            absent_days=Decimal(str(days_absent)),
            completed_sessions=0,
            ot_hours=Decimal("0"),
            ot_amount=Decimal("0"),
            base_salary=gross_amount,
            gross_salary=gross_amount,
            deductions=total_deductions,
            bonus=Decimal("0"),
            final_salary=net_salary,
            status="pending",
            notes=(
                f"Production period ({date_from} to {date_to}): "
                f"{total_shifts} shifts x Rs{salary_per_shift} = Rs{gross_amount}."
            ),
        ),
    )

    slip_number = f"SS/{emp.employee_code}/{period_start.isoformat()}_{period_end.isoformat()}"
    slip, _ = SalarySlip.objects.update_or_create(
        employee=emp, period_start=period_start, period_end=period_end,
        defaults=dict(
            month=month, year=year, week_number=None,
            payroll_run=None,
            slip_number=slip_number,
            basic=gross_amount,
            hra=Decimal("0"),
            allowances=Decimal("0"),
            incentives=Decimal("0"),
            bonuses=Decimal("0"),
            ot_amount=Decimal("0"),
            gross_salary=gross_amount,
            pf_deduction=pf_deduction,
            esi_deduction=esi_deduction,
            advance_deduction=advance_total,
            other_deductions=Decimal("0"),
            total_deductions=total_deductions,
            net_salary=net_salary,
            working_days=total_days,
            present_days=total_shifts,
            absent_days=Decimal(str(days_absent)),
            paid_leave_days=Decimal("0"),
            unpaid_leave_days=Decimal("0"),
            late_days=sum(1 for d in days_detail if d["isLate"]),
            completed_sessions=0,
            breakdown_details=breakdown,
        ),
    )

    if advance_details:
        _mark_repayments_processed(advance_details)

    return {"payroll": payroll, "slip": slip}


# ─────────────────────────────────────────────────────────────────────────────
#  Serialisers
# ─────────────────────────────────────────────────────────────────────────────

def _session_config_json(sc: SessionConfig) -> dict:
    return {
        "id": sc.id,
        "name": sc.name,
        "startTime": _time_to_str(sc.start_time),
        "endTime": _time_to_str(sc.end_time),
        "minimumCheckoutTime": _time_to_str(sc.minimum_checkout_time),
        "payAmount": float(sc.pay_amount),
        "isOvertime": sc.is_overtime,
        "order": sc.order,
    }


def _att_log_json(log: AttendanceLog) -> dict:
    return {
        "id": log.id,
        "employeeId": log.employee_id,
        "date": log.date.isoformat(),
        "punchTime": log.punch_time.strftime("%H:%M"),
        "punchType": log.punch_type,
        "source": log.source,
        "sourceLabel": source_label(log.source),
    }


def _work_session_json(ws: WorkSession, employee_name: str | None = None) -> dict:
    return {
        "id": ws.id,
        "employeeId": ws.employee_id,
        "employeeName": employee_name,
        "date": ws.date.isoformat(),
        "sessionName": ws.session_name,
        "sessionConfigId": ws.session_config_id,
        "checkIn": ws.check_in.strftime("%H:%M"),
        "checkOut": ws.check_out.strftime("%H:%M"),
        "hoursWorked": float(ws.hours_worked),
        "sessionAmount": float(ws.session_amount),
        "isOvertime": ws.is_overtime,
        "notes": ws.notes,
    }


def _payroll_json(p: Payroll, employee_name: str | None = None) -> dict:
    return {
        "id": p.id,
        "employeeId": p.employee_id,
        "employeeName": employee_name,
        "salaryMode": p.salary_mode,
        "month": p.month,
        "year": p.year,
        "weekNumber": p.week_number,
        "periodStart": p.period_start.isoformat() if p.period_start else None,
        "periodEnd": p.period_end.isoformat() if p.period_end else None,
        "totalWorkingDays": p.total_working_days,
        "presentDays": float(p.present_days),
        "absentDays": float(p.absent_days),
        "completedSessions": p.completed_sessions,
        "otHours": float(p.ot_hours),
        "otAmount": float(p.ot_amount),
        "baseSalary": float(p.base_salary),
        "grossSalary": float(p.gross_salary),
        "deductions": float(p.deductions),
        "bonus": float(p.bonus),
        "finalSalary": float(p.final_salary),
        "status": p.status,
        "notes": p.notes,
        "createdAt": p.created_at.isoformat() if p.created_at else None,
    }


# ─────────────────────────────────────────────────────────────────────────────
#  Session Config CRUD
# ─────────────────────────────────────────────────────────────────────────────

@api_view(["GET", "POST"])
def session_configs(request: Request) -> Response:
    if request.method == "GET":
        return Response([_session_config_json(sc) for sc in SessionConfig.objects.all()])
    return require_hr(_create_session_config)(request)


def _create_session_config(request: Request) -> Response:
    d = request.data
    try:
        start = time.fromisoformat(d["startTime"])
        end = time.fromisoformat(d["endTime"])
    except (KeyError, ValueError):
        return _error("startTime and endTime required (HH:MM)")
    min_co = None
    if d.get("minimumCheckoutTime"):
        try:
            min_co = time.fromisoformat(d["minimumCheckoutTime"])
        except ValueError:
            return _error("minimumCheckoutTime must be HH:MM")
    sc = SessionConfig.objects.create(
        name=d.get("name", "Session"),
        start_time=start,
        end_time=end,
        minimum_checkout_time=min_co,
        pay_amount=Decimal(str(d.get("payAmount", 0))),
        is_overtime=bool(d.get("isOvertime", False)),
        order=int(d.get("order", 99)),
    )
    return Response(_session_config_json(sc), status=201)


@api_view(["PATCH", "DELETE"])
@require_hr
def session_config_detail(request: Request, pk: int) -> Response:
    sc = SessionConfig.objects.filter(pk=pk).first()
    if not sc:
        return _error("Not found", 404)
    if request.method == "DELETE":
        sc.delete()
        return Response(status=204)
    d = request.data
    if "name" in d:
        sc.name = d["name"]
    if "startTime" in d:
        sc.start_time = time.fromisoformat(d["startTime"])
    if "endTime" in d:
        sc.end_time = time.fromisoformat(d["endTime"])
    if "minimumCheckoutTime" in d:
        raw = d["minimumCheckoutTime"]
        sc.minimum_checkout_time = time.fromisoformat(raw) if raw else None
    if "payAmount" in d:
        sc.pay_amount = Decimal(str(d["payAmount"]))
    if "isOvertime" in d:
        sc.is_overtime = bool(d["isOvertime"])
    if "order" in d:
        sc.order = int(d["order"])
    sc.save()
    return Response(_session_config_json(sc))


# ─────────────────────────────────────────────────────────────────────────────
#  Attendance Logs
# ─────────────────────────────────────────────────────────────────────────────

@api_view(["GET", "POST"])
@require_hr
def attendance_logs(request: Request) -> Response:
    if request.method == "GET":
        qs = AttendanceLog.objects.select_related("employee").order_by("-date", "punch_time")
        emp_id = request.query_params.get("employeeId")
        date_str = request.query_params.get("date")
        month = request.query_params.get("month")
        year = request.query_params.get("year")
        if emp_id:
            qs = qs.filter(employee_id=int(emp_id))
        if date_str:
            qs = qs.filter(date=date_str)
        if year:
            qs = qs.filter(date__year=int(year))
        if month:
            qs = qs.filter(date__month=int(month))
        return Response([_att_log_json(l) for l in qs[:500]])

    d = request.data
    try:
        log_date = date.fromisoformat(d["date"])
        punch_time_val = time.fromisoformat(d["punchTime"])
    except (KeyError, ValueError):
        return _error("date (YYYY-MM-DD) and punchTime (HH:MM) required")
    log = AttendanceLog.objects.create(
        employee_id=d["employeeId"],
        date=log_date,
        punch_time=punch_time_val,
        punch_type=d.get("punchType", "IN"),
        source="manual",
    )
    return Response(_att_log_json(log), status=201)


# Manual Excel-import of attendance punches now lives in
# manual_attendance_import_views.py (routed at attendance/manual-import/upload)
# -it matches by Employee Code rather than internal id, also writes the
# Attendance presence table, and shares its write path with live biometric
# sync via biometric_sync._ingest_punches.


# ─────────────────────────────────────────────────────────────────────────────
#  Work Sessions -list / edit
# ─────────────────────────────────────────────────────────────────────────────

@api_view(["GET"])
@require_hr
def work_sessions(request: Request) -> Response:
    qs = WorkSession.objects.select_related("employee").order_by("-date", "check_in")
    emp_id = request.query_params.get("employeeId")
    month = request.query_params.get("month")
    year = request.query_params.get("year")
    if emp_id:
        qs = qs.filter(employee_id=int(emp_id))
    if year:
        qs = qs.filter(date__year=int(year))
    if month:
        qs = qs.filter(date__month=int(month))
    result = []
    for ws in qs[:500]:
        emp = ws.employee
        name = f"{emp.first_name} {emp.last_name}" if emp else None
        result.append(_work_session_json(ws, name))
    return Response(result)


@api_view(["PATCH", "DELETE"])
@require_hr
def work_session_detail(request: Request, pk: int) -> Response:
    ws = WorkSession.objects.select_related("employee").filter(pk=pk).first()
    if not ws:
        return _error("Not found", 404)
    if request.method == "DELETE":
        ws.delete()
        return Response(status=204)
    d = request.data
    if "checkIn" in d:
        ws.check_in = time.fromisoformat(d["checkIn"])
    if "checkOut" in d:
        ws.check_out = time.fromisoformat(d["checkOut"])
    if "sessionAmount" in d:
        ws.session_amount = Decimal(str(d["sessionAmount"]))
    if "sessionName" in d:
        ws.session_name = d["sessionName"]
    if "notes" in d:
        ws.notes = d["notes"]
    ws.hours_worked = _compute_hours(ws.check_in, ws.check_out)
    ws.save()
    emp = ws.employee
    return Response(_work_session_json(ws, f"{emp.first_name} {emp.last_name}" if emp else None))


# ─────────────────────────────────────────────────────────────────────────────
#  Payroll list
# ─────────────────────────────────────────────────────────────────────────────

@api_view(["GET"])
@require_hr
def payroll_list(request: Request) -> Response:
    qs = Payroll.objects.select_related("employee", "employee__department").order_by("-year", "-month", "employee__first_name")
    qs = scope_to_branch(qs, request, field="employee__branch_id")
    emp_id = request.query_params.get("employeeId")
    month = request.query_params.get("month")
    year = request.query_params.get("year")
    status_filter = request.query_params.get("status")
    if emp_id:
        qs = qs.filter(employee_id=int(emp_id))
    if month:
        qs = qs.filter(month=int(month))
    if year:
        qs = qs.filter(year=int(year))
    if status_filter:
        qs = qs.filter(status=status_filter)
    result = []
    for p in qs:
        emp = p.employee
        name = f"{emp.first_name} {emp.last_name}" if emp else None
        row = _payroll_json(p, name)
        # Include bank details for Excel export
        row["bankAccount"] = emp.bank_account or ""
        row["bankIfsc"] = emp.bank_ifsc or ""
        row["bankName"] = emp.bank_name or ""
        row["employeeCode"] = emp.employee_code or ""
        row["email"] = emp.email or ""
        row["departmentId"] = emp.department_id
        row["departmentName"] = emp.department.name if emp.department_id and emp.department else None
        result.append(row)
    return Response(result)


# ─────────────────────────────────────────────────────────────────────────────
#  Skip-check preview (read-only, dry-run -reuses the real engines)
# ─────────────────────────────────────────────────────────────────────────────

class _DryRunAbort(Exception):
    """Internal-only -used purely to force a rollback of a savepoint we
    always intend to discard, never surfaced to a caller."""


def _dry_run_skip_reason(fn, *args) -> str | None:
    """
    Call a payroll-generation function inside a transaction that is always
    rolled back, to discover whether it would succeed or exactly why it
    would be skipped -without ever persisting anything. Returns None if it
    would succeed, or the skip/error reason string otherwise.
    """
    try:
        with transaction.atomic():
            fn(*args)
            raise _DryRunAbort()
    except _DryRunAbort:
        return None
    except PayrollSkip as e:
        return str(e)
    except Exception as e:
        return str(e)


@api_view(["GET"])
@require_hr
def payroll_skip_check(request: Request) -> Response:
    """
    GET /api/payroll/skip-check?month=&year=
    Read-only preview of exactly which active STAFF employees Generate
    Payroll would currently skip, and why. Runs the exact same engine
    function generate_payroll uses, each inside its own savepoint that's
    always rolled back -so this can be called any time, as often as
    needed, without ever writing to the database. This is what powers the
    "Skipped Employees" view on the Payroll page -unlike the transient
    post-generation toast, it works whenever HR wants to check, not only
    immediately after a run.

    Staff only -see production_payroll_views.py::production_skip_check
    for the Production equivalent (period-based, not month/year-based).
    """
    month = request.query_params.get("month")
    year = request.query_params.get("year")

    if not month or not year:
        return _error("month and year are required")
    try:
        month, year = int(month), int(year)
    except ValueError:
        return _error("month and year must be integers")

    employees = list(
        scope_to_branch(Employee.objects, request)
        .filter(status="active", employment_type=Employee.EMPLOYMENT_TYPE_STAFF)
        .order_by("first_name", "last_name")
    )

    skipped = []
    for emp in employees:
        emp_name = f"{emp.first_name} {emp.last_name}".strip()
        reason = _dry_run_skip_reason(_generate_staff_payroll, emp, month, year)
        if reason:
            skipped.append({
                "employeeId": emp.id,
                "employeeCode": emp.employee_code,
                "name": emp_name,
                "reason": reason,
            })

    return Response({
        "totalChecked": len(employees),
        "skippedCount": len(skipped),
        "skipped": skipped,
    })


# ─────────────────────────────────────────────────────────────────────────────
#  Generate payroll (main entry point)
# ─────────────────────────────────────────────────────────────────────────────

@api_view(["POST"])
@require_hr
def generate_payroll(request: Request) -> Response:
    """
    Generate monthly payroll for all active STAFF employees.

    Body: { month, year }

    Staff only -see production_payroll_views.py::production_generate_payroll
    for Production, which is period-based (Settings → Payroll → Production)
    rather than month/year-based and lives on its own dedicated page.
    """
    data = request.data
    month = data.get("month")
    year = data.get("year")

    if not month or not year:
        return _error("month and year are required")
    try:
        month, year = int(month), int(year)
    except ValueError:
        return _error("month and year must be integers")

    employees = list(
        scope_to_branch(Employee.objects, request)
        .filter(status="active", employment_type=Employee.EMPLOYMENT_TYPE_STAFF)
    )
    generated = []
    skipped = []

    from . import payroll_progress
    payroll_progress.start(len(employees))

    for emp in employees:
        emp_name = f"{emp.first_name} {emp.last_name}"
        before_count = len(generated)
        try:
            result = _generate_staff_payroll(emp, month, year)
            generated.append(_payroll_json(result["payroll"], emp_name))
        except PayrollSkip as e:
            skipped.append({"employeeId": emp.id, "name": emp_name, "reason": str(e)})
        except Exception as e:
            skipped.append({"employeeId": emp.id, "name": emp_name, "reason": str(e)})
        payroll_progress.step(emp_name, len(generated) > before_count)

    payroll_progress.finish()

    from .audit_utils import log_action as _log
    _log(request, "create", "payroll", description=(
        f"Generated staff payroll {month}/{year} -"
        f"{len(generated)} generated, {len(skipped)} skipped"
    ))
    return Response({
        "message": (
            f"Payroll generated for {month}/{year}. "
            f"{len(generated)} records computed, {len(skipped)} skipped."
        ),
        "generated": len(generated),
        "skipped": len(skipped),
        "skippedDetails": skipped,
    }, status=201)


@api_view(["GET"])
@require_hr
def generate_payroll_progress(request: Request) -> Response:
    """Poll target for the live payroll generation progress UI."""
    from . import payroll_progress
    return Response(payroll_progress.snapshot())


# ─────────────────────────────────────────────────────────────────────────────
#  Payroll detail PATCH (status / bonus / deductions)
# ─────────────────────────────────────────────────────────────────────────────

@api_view(["PATCH"])
@require_hr
def payroll_detail(request: Request, pk: int) -> Response:
    p = Payroll.objects.select_related("employee").filter(pk=pk).first()
    if not p:
        return _error("Not found", 404)
    d = request.data
    if "status" in d:
        p.status = d["status"]
    if "bonus" in d:
        p.bonus = Decimal(str(d["bonus"]))
    if "deductions" in d:
        p.deductions = Decimal(str(d["deductions"]))
    if "notes" in d:
        p.notes = d["notes"]
    p.final_salary = _d2(p.gross_salary + p.bonus - p.deductions)
    p.save()
    emp = p.employee
    return Response(_payroll_json(p, f"{emp.first_name} {emp.last_name}" if emp else None))


# ─────────────────────────────────────────────────────────────────────────────
#  Payroll breakdown -full traceability for one employee-month
# ─────────────────────────────────────────────────────────────────────────────

@api_view(["GET"])
@require_hr
def payroll_breakdown(request: Request, pk: int) -> Response:
    """Return the full day-by-day breakdown stored in the associated SalarySlip."""
    p = Payroll.objects.select_related("employee").filter(pk=pk).first()
    if not p:
        return _error("Not found", 404)

    if p.period_start:
        # New-style, configurable-period production row -period_start/end
        # is the identity, not month/year/week_number (week_number is null).
        slip = SalarySlip.objects.filter(
            employee=p.employee, period_start=p.period_start, period_end=p.period_end
        ).first()
    else:
        slip = SalarySlip.objects.filter(
            employee=p.employee, month=p.month, year=p.year, week_number=p.week_number
        ).first()

    emp = p.employee
    emp_info = {
        "id": emp.id,
        "code": emp.employee_code,
        "name": f"{emp.first_name} {emp.last_name}",
        "department": emp.department.name if emp.department else None,
        "designation": emp.designation.title if emp.designation else None,
        "employmentType": emp.employment_type,
        "salary": float(emp.salary_amount or 0),
    }

    breakdown = slip.breakdown_details if slip else None

    return Response({
        "payrollId": p.id,
        "employee": emp_info,
        "month": p.month,
        "year": p.year,
        "weekNumber": p.week_number,
        "periodStart": p.period_start.isoformat() if p.period_start else None,
        "periodEnd": p.period_end.isoformat() if p.period_end else None,
        "salaryMode": p.salary_mode,
        "status": p.status,
        "summary": {
            "grossSalary": float(p.gross_salary),
            "deductions": float(p.deductions),
            "bonus": float(p.bonus),
            "netSalary": float(p.final_salary),
        },
        "breakdown": breakdown,
    })


# ─────────────────────────────────────────────────────────────────────────────
#  Seed test attendance data (dev/staging use only)
# ─────────────────────────────────────────────────────────────────────────────

@api_view(["POST"])
@require_hr
def seed_attendance(request: Request) -> Response:
    """
    Create realistic test attendance records for all active employees.

    Body (all optional):
      { month, year, days: 10, includeLateDays: 2, includeAbsentDays: 1 }

    Creates records in BOTH Attendance (simple) AND AttendanceLog (punch-based)
    so the payroll engine can detect presence AND late arrivals.
    """
    data = request.data
    month = int(data.get("month", date.today().month))
    year = int(data.get("year", date.today().year))
    target_days = int(data.get("days", 10))
    late_day_count = int(data.get("includeLateDays", 1))
    absent_day_count = int(data.get("includeAbsentDays", 1))

    employees = Employee.objects.filter(status="active")
    holiday_dates: set[date] = set(
        Holiday.objects.filter(date__year=year, date__month=month).values_list("date", flat=True)
    )

    # Build all working days in month (Mon–Sat) excluding holidays
    first_day = date(year, month, 1)
    last_day = date(year, month, calendar.monthrange(year, month)[1])
    all_working = []
    cur = first_day
    while cur <= last_day and cur <= date.today():
        if cur.weekday() < 6 and cur not in holiday_dates:
            all_working.append(cur)
        cur += timedelta(days=1)

    # Limit to the requested number of days
    seed_days = all_working[:target_days]
    if not seed_days:
        return _error(f"No working days found in {month}/{year} up to today.")

    # Designate which seeded days are late or absent
    absent_days_set: set[date] = set(seed_days[-absent_day_count:]) if absent_day_count else set()
    late_days_list = [d for d in seed_days if d not in absent_days_set][-late_day_count:] if late_day_count else []
    late_days_set: set[date] = set(late_days_list)

    created_att = 0
    created_logs = 0
    skipped = 0

    for emp in employees:
        # Get shift info for realistic punch times
        assignment = _get_active_assignment(emp, seed_days[0])
        if assignment:
            shift_start, shift_end, _, _ = _effective_shift_times(assignment)
        else:
            shift_start = time(9, 0)
            shift_end = time(20, 0) if emp.employment_type == "production" else time(19, 0)

        for d in seed_days:
            date_str = d.isoformat()

            # Skip if already exists
            if Attendance.objects.filter(employee=emp, date=date_str).exists():
                skipped += 1
                continue

            is_absent = d in absent_days_set
            is_late = d in late_days_set

            if is_absent:
                Attendance.objects.create(employee=emp, date=date_str, present=False)
                created_att += 1
                continue

            # Present day -create Attendance record
            Attendance.objects.create(employee=emp, date=date_str, present=True, hours_worked=Decimal("8.00"))
            created_att += 1

            # Create AttendanceLog punch-in
            if is_late:
                # Late by 25 min (beyond typical 15-min grace)
                in_h = shift_start.hour
                in_m = shift_start.minute + 25
                if in_m >= 60:
                    in_h += 1
                    in_m -= 60
                punch_in = time(in_h, in_m)
            else:
                # On time -arrive 5 min before shift
                in_h = shift_start.hour
                in_m = max(0, shift_start.minute - 5)
                punch_in = time(in_h, in_m)

            punch_out = shift_end

            AttendanceLog.objects.create(
                employee=emp, date=d, punch_time=punch_in, punch_type="IN", source="seed"
            )
            AttendanceLog.objects.create(
                employee=emp, date=d, punch_time=punch_out, punch_type="OUT", source="seed"
            )
            created_logs += 2

    return Response({
        "message": (
            f"Seeded attendance for {len(employees)} employees × {len(seed_days)} days "
            f"({absent_day_count} absent, {late_day_count} late)."
        ),
        "attendanceRecordsCreated": created_att,
        "punchLogsCreated": created_logs,
        "skipped": skipped,
        "days": [d.isoformat() for d in seed_days],
        "absentDays": [d.isoformat() for d in absent_days_set],
        "lateDays": [d.isoformat() for d in late_days_set],
    }, status=201)


# ─────────────────────────────────────────────────────────────────────────────
#  Payroll Settings (singleton -PF/ESI rates, pay day, production pay type)
# ─────────────────────────────────────────────────────────────────────────────

def _ps_response(ps) -> dict:
    return {
        # Company profile (drives branding across the whole portal)
        "companyName": ps.company_name,
        "companyTagline": ps.company_tagline,
        "companyPhone": ps.company_phone,
        "companyEmail": ps.company_email,
        "companyWebsite": ps.company_website,
        "companyGstin": ps.company_gstin,
        "companyPan": ps.company_pan,
        "companyAddress": ps.company_address,
        "companyRegistration": ps.company_registration,
        # Staff
        "pfRate": float(ps.pf_rate),
        "esiRate": float(ps.esi_rate),
        "esiApplicableBelow": float(ps.esi_applicable_below),
        # Production
        "prodPfRate": float(ps.prod_pf_rate),
        "prodEsiRate": float(ps.prod_esi_rate),
        "prodEsiApplicableBelow": float(ps.prod_esi_applicable_below),
        # General
        "payDay": ps.pay_day,
        "productionPayType": ps.production_pay_type,
        "defaultSalaryPerShift": float(ps.default_salary_per_shift),
        # Production payroll period (Settings → Payroll → Production)
        "prodPeriodFrequency": ps.prod_period_frequency,
        "prodPeriodStyle": ps.prod_period_style,
        "prodPeriodWeekdayAnchor": ps.prod_period_weekday_anchor,
        "prodPeriodAnchorDate": ps.prod_period_anchor_date.isoformat() if ps.prod_period_anchor_date else None,
        "prodPeriodCustomDays": ps.prod_period_custom_days,
        # Production attendance mode + Late Detection (Settings → Payroll → Production)
        "prodAttendanceMode": ps.prod_attendance_mode,
        "prodLateDetectionEnabled": ps.prod_late_detection_enabled,
        "prodLateFreeAllowance": ps.prod_late_free_allowance,
        "prodLateDeductionSlabs": ps.prod_late_deduction_slabs or [],
        # Salary slip header & signature
        "slipCompanyName": ps.slip_company_name,
        "slipCompanyAddress": ps.slip_company_address,
        "minWageRate": float(ps.min_wage_rate),
        "signatureImage": ps.signature_image,
        "companyLogo": ps.company_logo,
        "authorizedSignature": ps.authorized_signature,
        # Attendance calculation mode
        "attendanceMode": ps.attendance_mode,
        "simpleHalfShiftCutoff": str(ps.simple_half_shift_cutoff)[:5],
        "shiftPunctualityWindowMinutes": ps.shift_punctuality_window_minutes,
        "lastPunchPostShiftGraceHours": float(ps.last_punch_post_shift_grace_hours),
        "firstPunchPreShiftBufferHours": float(ps.first_punch_pre_shift_buffer_hours),
        "halfShiftLateReferenceTime": str(ps.half_shift_late_reference_time)[:5],
        # Defaults pre-filled into a newly created shift (Manage Shift still
        # owns the real per-shift times)
        "defaultShiftGraceMinutes": ps.default_shift_grace_minutes,
        "defaultShiftFirstHalfEnd": str(ps.default_shift_first_half_end)[:5],
        "defaultShiftLunchDurationMinutes": ps.default_shift_lunch_duration_minutes,
        "defaultShiftLunchGraceMinutes": ps.default_shift_lunch_grace_minutes,
        # Late Detection policy
        "lateFreeAllowance": ps.late_free_allowance,
        "lateDeductionSlabs": ps.late_deduction_slabs or [],
        # Without Permission policy -separate pool, see late_shift_deduction()
        "withoutPermissionFreeAllowance": ps.without_permission_free_allowance,
        "withoutPermissionDeductionSlabs": ps.without_permission_deduction_slabs or [],
        # Production attendance windows (1.5-shift day)
        "prodFirstHalfStart": str(ps.prod_first_half_start)[:5],
        "prodFirstHalfEnd": str(ps.prod_first_half_end)[:5],
        "prodSecondHalfStart": str(ps.prod_second_half_start)[:5],
        "prodSecondHalfEnd": str(ps.prod_second_half_end)[:5],
        "prodExtraStart": str(ps.prod_extra_start)[:5],
        "prodExtraEnd": str(ps.prod_extra_end)[:5],
        "prodPfEfEnabled": ps.prod_pf_ef_enabled,
        "prodPfEfRules": ps.prod_pf_ef_rules or [],
        # Feature toggles
        "staffPayrollRulesEnabled": ps.staff_payroll_rules_enabled,
        "prodPayrollRulesEnabled": ps.prod_payroll_rules_enabled,
        "nightShiftEnabled": ps.night_shift_enabled,
        # Backup
        "backupDirectory": ps.backup_directory,
        # SMTP / Email
        "smtpHost": ps.smtp_host,
        "smtpPort": ps.smtp_port,
        "smtpUsername": ps.smtp_username,
        "smtpPassword": ps.smtp_password,
        "smtpFromEmail": ps.smtp_from_email,
        "smtpFromName": ps.smtp_from_name,
        "updatedAt": ps.updated_at.isoformat() if ps.updated_at else None,
    }


# Company/Attendance/Payroll/Salary Slip/SMTP (Settings page tabs) all read
# and write through this one PayrollSettings record via this one endpoint, so
# URL_MODULE_MAP can't give them separate permissions (see the comment there).
# This maps each writable field to the settings.* group(s) that may write it —
# a tuple because "companyLogo" has upload widgets on both the Company and
# Salary Slip tabs, so edit access on either is sufficient for that one field.
FIELD_GROUPS: dict[str, tuple[str, ...]] = {
    "companyName": ("settings.company",),
    "companyTagline": ("settings.company",),
    "companyPhone": ("settings.company",),
    "companyEmail": ("settings.company",),
    "companyWebsite": ("settings.company",),
    "companyGstin": ("settings.company",),
    "companyPan": ("settings.company",),
    "companyAddress": ("settings.company",),
    "companyRegistration": ("settings.company",),
    "companyLogo": ("settings.company", "settings.salary_slip"),
    "attendanceMode": ("settings.attendance",),
    "simpleHalfShiftCutoff": ("settings.attendance",),
    "shiftPunctualityWindowMinutes": ("settings.attendance",),
    "lastPunchPostShiftGraceHours": ("settings.attendance",),
    "firstPunchPreShiftBufferHours": ("settings.attendance",),
    "prodFirstHalfStart": ("settings.attendance",),
    "prodFirstHalfEnd": ("settings.attendance",),
    "prodSecondHalfStart": ("settings.attendance",),
    "prodSecondHalfEnd": ("settings.attendance",),
    "prodExtraStart": ("settings.attendance",),
    "prodExtraEnd": ("settings.attendance",),
    "nightShiftEnabled": ("settings.attendance",),
    "halfShiftLateReferenceTime": ("settings.attendance",),
    "defaultShiftGraceMinutes": ("settings.attendance",),
    "defaultShiftFirstHalfEnd": ("settings.attendance",),
    "defaultShiftLunchDurationMinutes": ("settings.attendance",),
    "defaultShiftLunchGraceMinutes": ("settings.attendance",),
    # Late Detection is its own Settings tab, so it gets its own permission
    # group -HR can be given the attendance timings without the power to
    # change what a late actually costs an employee.
    "lateFreeAllowance": ("settings.late_detection",),
    "lateDeductionSlabs": ("settings.late_detection",),
    "withoutPermissionFreeAllowance": ("settings.late_detection",),
    "withoutPermissionDeductionSlabs": ("settings.late_detection",),
    "pfRate": ("settings.payroll",),
    "esiRate": ("settings.payroll",),
    "esiApplicableBelow": ("settings.payroll",),
    "prodPfRate": ("settings.payroll",),
    "prodEsiRate": ("settings.payroll",),
    "prodEsiApplicableBelow": ("settings.payroll",),
    "payDay": ("settings.payroll",),
    "productionPayType": ("settings.payroll",),
    "defaultSalaryPerShift": ("settings.payroll",),
    # Production payroll period is its own Settings tab -see the note on
    # settings.late_detection above for why this gets a separate group:
    # HR can be given the flat Payroll rates without the power to change
    # when/how Production payroll periods are cut.
    "prodPeriodFrequency": ("settings.production_payroll",),
    "prodPeriodStyle": ("settings.production_payroll",),
    "prodPeriodWeekdayAnchor": ("settings.production_payroll",),
    "prodPeriodAnchorDate": ("settings.production_payroll",),
    "prodPeriodCustomDays": ("settings.production_payroll",),
    "prodAttendanceMode": ("settings.production_payroll",),
    "prodLateDetectionEnabled": ("settings.production_payroll",),
    "prodLateFreeAllowance": ("settings.production_payroll",),
    "prodLateDeductionSlabs": ("settings.production_payroll",),
    "prodPfEfEnabled": ("settings.payroll",),
    "prodPfEfRules": ("settings.payroll",),
    "staffPayrollRulesEnabled": ("settings.payroll",),
    "prodPayrollRulesEnabled": ("settings.payroll",),
    "slipCompanyName": ("settings.salary_slip",),
    "slipCompanyAddress": ("settings.salary_slip",),
    "minWageRate": ("settings.salary_slip",),
    "signatureImage": ("settings.salary_slip",),
    "authorizedSignature": ("settings.salary_slip",),
    "smtpHost": ("settings.smtp",),
    "smtpPort": ("settings.smtp",),
    "smtpUsername": ("settings.smtp",),
    "smtpPassword": ("settings.smtp",),
    "smtpFromEmail": ("settings.smtp",),
    "smtpFromName": ("settings.smtp",),
    "backupDirectory": ("settings.backup",),
}


def _hr_role_permissions(request) -> tuple[dict, bool]:
    """Returns (role.permissions dict, is_super_admin) for the requesting HR
    user, resolved fresh from the DB -mirrors the lookup permission_middleware
    already does, needed here because this one endpoint enforces multiple
    settings.* permissions itself rather than a single URL-level module_key."""
    from .models import HRUser

    hr_user_id = request.jwt_user.get("hrUserId") if hasattr(request, "jwt_user") else None
    hr_user = (
        HRUser.objects.select_related("role").filter(id=hr_user_id, is_active=True).first()
        if hr_user_id else None
    )
    if hr_user is None:
        return {}, False
    return (hr_user.role.permissions if hr_user.role else {}) or {}, hr_user.is_super_admin


@api_view(["GET", "PUT"])
@require_hr
def payroll_settings_view(request: Request) -> Response:
    # Admins get the universal row itself, so their edits are company-wide.
    # Every other login gets a private overlay: they see the universal values
    # until they change something, and keep tracking Admin for the rest.
    ps = settings_for(request)

    if request.method == "GET":
        return Response(_ps_response(ps))

    data = request.data

    permissions, is_super_admin = _hr_role_permissions(request)
    if not is_super_admin:
        denied_fields = [
            key for key in data
            if key in FIELD_GROUPS
            and not any(resolve_permission(permissions, group) == "edit" for group in FIELD_GROUPS[key])
        ]
        if denied_fields:
            return Response(
                {
                    "error": "permission_denied",
                    "message": "You do not have edit access to this settings section.",
                    "fields": denied_fields,
                },
                status=403,
            )

    field_map = {
        "companyName": ("company_name", str),
        "companyTagline": ("company_tagline", str),
        "companyPhone": ("company_phone", str),
        "companyEmail": ("company_email", str),
        "companyWebsite": ("company_website", str),
        "companyGstin": ("company_gstin", str),
        "companyPan": ("company_pan", str),
        "companyAddress": ("company_address", str),
        "companyRegistration": ("company_registration", str),
        "pfRate": ("pf_rate", Decimal),
        "esiRate": ("esi_rate", Decimal),
        "esiApplicableBelow": ("esi_applicable_below", Decimal),
        "prodPfRate": ("prod_pf_rate", Decimal),
        "prodEsiRate": ("prod_esi_rate", Decimal),
        "prodEsiApplicableBelow": ("prod_esi_applicable_below", Decimal),
        "payDay": ("pay_day", int),
        "productionPayType": ("production_pay_type", str),
        "defaultSalaryPerShift": ("default_salary_per_shift", Decimal),
        "prodPeriodFrequency": ("prod_period_frequency", str),
        "prodPeriodStyle": ("prod_period_style", str),
        "prodPeriodWeekdayAnchor": ("prod_period_weekday_anchor", str),
        "prodPeriodAnchorDate": ("prod_period_anchor_date", date.fromisoformat),
        "prodPeriodCustomDays": ("prod_period_custom_days", int),
        "prodAttendanceMode": ("prod_attendance_mode", str),
        "prodLateFreeAllowance": ("prod_late_free_allowance", int),
        "slipCompanyName": ("slip_company_name", str),
        "slipCompanyAddress": ("slip_company_address", str),
        "minWageRate": ("min_wage_rate", Decimal),
        "signatureImage": ("signature_image", str),
        "companyLogo": ("company_logo", str),
        "authorizedSignature": ("authorized_signature", str),
        "smtpHost": ("smtp_host", str),
        "smtpPort": ("smtp_port", int),
        "smtpUsername": ("smtp_username", str),
        "smtpPassword": ("smtp_password", str),
        "smtpFromEmail": ("smtp_from_email", str),
        "smtpFromName": ("smtp_from_name", str),
        "attendanceMode": ("attendance_mode", str),
        "simpleHalfShiftCutoff": ("simple_half_shift_cutoff", str),
        "shiftPunctualityWindowMinutes": ("shift_punctuality_window_minutes", int),
        "lastPunchPostShiftGraceHours": ("last_punch_post_shift_grace_hours", Decimal),
        "firstPunchPreShiftBufferHours": ("first_punch_pre_shift_buffer_hours", Decimal),
        "prodFirstHalfStart": ("prod_first_half_start", str),
        "prodFirstHalfEnd": ("prod_first_half_end", str),
        "prodSecondHalfStart": ("prod_second_half_start", str),
        "prodSecondHalfEnd": ("prod_second_half_end", str),
        "prodExtraStart": ("prod_extra_start", str),
        "prodExtraEnd": ("prod_extra_end", str),
        "halfShiftLateReferenceTime": ("half_shift_late_reference_time", str),
        "defaultShiftGraceMinutes": ("default_shift_grace_minutes", int),
        "defaultShiftFirstHalfEnd": ("default_shift_first_half_end", str),
        "defaultShiftLunchDurationMinutes": ("default_shift_lunch_duration_minutes", int),
        "defaultShiftLunchGraceMinutes": ("default_shift_lunch_grace_minutes", int),
        "lateFreeAllowance": ("late_free_allowance", int),
        "withoutPermissionFreeAllowance": ("without_permission_free_allowance", int),
    }
    # Image fields may legitimately be set to null (user removed the logo /
    # signature) -str(None) would store the literal string "None".
    _nullable_text = {
        "signature_image", "company_logo", "authorized_signature",
        "prod_period_weekday_anchor", "prod_period_anchor_date", "prod_period_custom_days",
    }
    for key, (attr, cast) in field_map.items():
        if key in data:
            val = data[key]
            if val is None and attr in _nullable_text:
                setattr(ps, attr, None)
            else:
                setattr(ps, attr, Decimal(str(val)) if cast is Decimal else cast(val))
    if "prodPfEfRules" in data and isinstance(data["prodPfEfRules"], list):
        ps.prod_pf_ef_rules = data["prodPfEfRules"]
    if "lateDeductionSlabs" in data and isinstance(data["lateDeductionSlabs"], list):
        # Sanitize before storing -these rows drive real salary deductions,
        # so a malformed row must be rejected at the door rather than silently
        # skipped every payroll run afterwards. Non-negative values only,
        # de-duplicated by threshold, stored in ascending order.
        cleaned: dict[int, float] = {}
        for row in data["lateDeductionSlabs"]:
            if not isinstance(row, dict):
                continue
            try:
                from_lates = int(row["fromLates"])
                shifts = float(row["deductionShifts"])
            except (KeyError, TypeError, ValueError):
                return _error("Each late slab needs a numeric fromLates and deductionShifts")
            if from_lates < 0 or shifts < 0:
                return _error("Late slab values cannot be negative")
            cleaned[from_lates] = shifts
        ps.late_deduction_slabs = [
            {"fromLates": k, "deductionShifts": cleaned[k]} for k in sorted(cleaned)
        ]
    if "withoutPermissionDeductionSlabs" in data and isinstance(data["withoutPermissionDeductionSlabs"], list):
        # Same sanitize/sort/dedupe rules as lateDeductionSlabs above -this
        # pool's rows drive real deductions too.
        cleaned: dict[int, float] = {}
        for row in data["withoutPermissionDeductionSlabs"]:
            if not isinstance(row, dict):
                continue
            try:
                from_count = int(row["fromLates"])
                shifts = float(row["deductionShifts"])
            except (KeyError, TypeError, ValueError):
                return _error("Each Without Permission slab needs a numeric fromLates and deductionShifts")
            if from_count < 0 or shifts < 0:
                return _error("Without Permission slab values cannot be negative")
            cleaned[from_count] = shifts
        ps.without_permission_deduction_slabs = [
            {"fromLates": k, "deductionShifts": cleaned[k]} for k in sorted(cleaned)
        ]
    if "prodLateDetectionEnabled" in data:
        ps.prod_late_detection_enabled = bool(data["prodLateDetectionEnabled"])
    if "prodLateDeductionSlabs" in data and isinstance(data["prodLateDeductionSlabs"], list):
        # Same sanitize/sort/dedupe rules as lateDeductionSlabs above -this
        # pool's rows drive real production payroll deductions too.
        cleaned: dict[int, float] = {}
        for row in data["prodLateDeductionSlabs"]:
            if not isinstance(row, dict):
                continue
            try:
                from_lates = int(row["fromLates"])
                shifts = float(row["deductionShifts"])
            except (KeyError, TypeError, ValueError):
                return _error("Each Production Late slab needs a numeric fromLates and deductionShifts")
            if from_lates < 0 or shifts < 0:
                return _error("Production Late slab values cannot be negative")
            cleaned[from_lates] = shifts
        ps.prod_late_deduction_slabs = [
            {"fromLates": k, "deductionShifts": cleaned[k]} for k in sorted(cleaned)
        ]
    if "prodPfEfEnabled" in data:
        ps.prod_pf_ef_enabled = bool(data["prodPfEfEnabled"])
    if "staffPayrollRulesEnabled" in data:
        ps.staff_payroll_rules_enabled = bool(data["staffPayrollRulesEnabled"])
    if "prodPayrollRulesEnabled" in data:
        ps.prod_payroll_rules_enabled = bool(data["prodPayrollRulesEnabled"])
    if "nightShiftEnabled" in data:
        ps.night_shift_enabled = bool(data["nightShiftEnabled"])
    if "backupDirectory" in data:
        ps.backup_directory = str(data["backupDirectory"] or "")

    # Same assignments above ran against either a real row or an overlay;
    # only the write differs. The overlay refuses .save() on purpose, so a
    # non-admin's edit can never fall through to the shared row.
    if isinstance(ps, _SettingsOverlay):
        kept = persist_overlay(ps)
        log_action(
            request, "update", "settings",
            description=f"Personal settings updated ({len(kept)} field(s) overridden)",
        )
    else:
        ps.save()
        log_action(request, "update", "settings", description="Universal settings updated")

    return Response(_ps_response(ps))


# ─────────────────────────────────────────────────────────────────────────────
#  Legacy: process_punch_sessions kept for backward compatibility
# ─────────────────────────────────────────────────────────────────────────────

@api_view(["POST"])
@require_hr
def process_punch_sessions(request: Request) -> Response:
    """Legacy endpoint. The new engine handles this automatically during payroll generation."""
    return Response({
        "message": "Session processing is now handled automatically by the payroll engine. "
                   "Use POST /api/payroll/generate with runType='biweekly' to generate production payroll.",
    })

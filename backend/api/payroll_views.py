"""
Enterprise Payroll Engine — UKTextiles HRMS
============================================
Two salary modes:
  • Staff    → monthly, pro-rated by working days (leave-aware, late-tracking)
  • Production → bi-weekly, session-based (morning + afternoon sessions)

All calculations are stored with full day-by-day breakdown in SalarySlip.breakdown_details
so every rupee can be explained to the employee.
"""


class PayrollSkip(Exception):
    """Raised by the payroll engines with a precise, user-facing reason an
    employee was skipped — so the Generate Payroll result always tells HR
    exactly what to fix, instead of one generic catch-all message covering
    unrelated conditions (no salary configured vs. no working days vs. a
    real computation error)."""


import calendar
import io
from collections import defaultdict
from datetime import date, datetime, time, timedelta
from decimal import Decimal, ROUND_HALF_UP

from django.db import transaction
from rest_framework.decorators import api_view, parser_classes
from rest_framework.parsers import FormParser, MultiPartParser
from rest_framework.request import Request
from rest_framework.response import Response

from .auth import require_hr
from .branch_scope import scope_to_branch
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
#  Per-day attendance status classifier (staff)
# ─────────────────────────────────────────────────────────────────────────────

def _check_leave(day: date, approved_leaves: list) -> dict | None:
    """Return leave status dict if this day falls within an approved leave, else None."""
    for lr in approved_leaves:
        start_str = str(lr.start_date)
        end_str = str(lr.end_date)
        if start_str <= day.isoformat() <= end_str:
            is_paid = lr.leave_type_ref.is_paid if lr.leave_type_ref else True
            return {
                "status": "paid_leave" if is_paid else "unpaid_leave",
                "is_late": False,
                "first_in": None,
                "last_out": None,
                "leave_type": lr.leave_type_ref.name if lr.leave_type_ref else lr.type,
            }
    return None


def _classify_day(
    day: date,
    logs_by_date: dict[date, list],          # AttendanceLog punch records (biometric/excel)
    attendance_by_date: dict[str, object],    # Attendance simple records (manual)
    approved_leaves: list,
    shift_start: time | None,                 # None = no shift assigned → no late detection
    grace_minutes: int | None,
) -> dict:
    """
    Classify a working day into: present | paid_leave | unpaid_leave | absent.

    Priority order:
      1. Approved leave → paid_leave / unpaid_leave
      2. AttendanceLog punch records (if they exist for this day) → present with late detection
      3. Attendance simple record (present=True) → present without late detection
      4. No data → absent
    """
    leave = _check_leave(day, approved_leaves)
    if leave:
        return leave

    # AttendanceLog (punch-based): biometric, Excel, or manual punch entry
    day_logs = logs_by_date.get(day, [])
    in_logs = [l for l in day_logs if l.punch_type == "IN"]
    out_logs = [l for l in day_logs if l.punch_type == "OUT"]

    if in_logs:
        first_in = min(l.punch_time for l in in_logs)
        if out_logs:
            last_out = max(l.punch_time for l in out_logs)
        elif len(day_logs) > 1:
            # Biometric device records all punches as "IN"; the last punch of the day is the evening checkout
            last_out = max(l.punch_time for l in day_logs)
        else:
            last_out = None

        if shift_start is not None and grace_minutes is not None:
            total_grace_secs = grace_minutes * 60
            shift_start_secs = shift_start.hour * 3600 + shift_start.minute * 60
            first_in_secs = first_in.hour * 3600 + first_in.minute * 60
            is_late = (first_in_secs - shift_start_secs) > total_grace_secs
        else:
            # No assigned shift → no basis for lateness
            is_late = False

        return {
            "status": "present",
            "is_late": is_late,
            "first_in": first_in.strftime("%H:%M"),
            "last_out": last_out.strftime("%H:%M") if last_out else None,
            "leave_type": None,
        }

    # Attendance simple record (present boolean — manual attendance module)
    att = attendance_by_date.get(day.isoformat())
    if att and att.present:
        return {
            "status": "present",
            "is_late": False,   # can't detect late without punch time
            "first_in": None,
            "last_out": None,
            "leave_type": None,
        }

    return {"status": "absent", "is_late": False, "first_in": None, "last_out": None, "leave_type": None}


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

def _generate_staff_payroll(emp: Employee, month: int, year: int) -> dict:
    """
    Pro-rated monthly payroll for a staff employee.
    Returns a dict with 'payroll' and 'slip' keys (model instances).
    Raises PayrollSkip with a precise reason if this employee can't be paid
    for this month (no salary configured, no working days, etc).
    """
    if not emp.salary_amount:
        raise PayrollSkip("No Salary Amount set on this employee's profile")

    # 1. Get shift assignment for middle of month (representative date).
    #    Shift start and grace come solely from the assigned shift — there is
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

    # 4a. Fetch AttendanceLog punch records (biometric / Excel import)
    logs = AttendanceLog.objects.filter(employee=emp, date__year=year, date__month=month)
    logs_by_date: dict[date, list] = defaultdict(list)
    for log in logs:
        logs_by_date[log.date].append(log)

    # 4b. Fetch Attendance simple records (manual attendance module — present boolean)
    #     Attendance.date is stored as TEXT ("YYYY-MM-DD"), filter by string prefix
    att_qs = Attendance.objects.filter(
        employee=emp,
        date__gte=f"{year}-{str(month).zfill(2)}-01",
        date__lte=f"{year}-{str(month).zfill(2)}-31",
    )
    attendance_by_date: dict[str, Attendance] = {a.date: a for a in att_qs}

    # 4c. Fetch DailyShiftLog for half-shift detection (staff 4-punch engine results)
    from .models import DailyShiftLog as _DSL
    shift_logs_by_date: dict[date, object] = {}
    if emp.employment_type == "staff":
        shift_logs_by_date = {
            sl.date: sl
            for sl in _DSL.objects.filter(employee=emp, date__year=year, date__month=month)
        }

    # 5. Fetch approved leave requests that overlap this month
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

    # 5b. Final attendance records (auto-computed + HR overrides).
    #     Manual overrides are ALWAYS authoritative. In simple attendance mode
    #     the auto records replace the strict 4-punch classification entirely.
    from .models import AttendanceDayRecord as _ADR, PayrollSettings as _PS
    _settings = _PS.get()
    use_simple = _settings.attendance_mode == "simple"
    if use_simple:
        from .attendance_final import compute_month_records
        final_records = compute_month_records(emp, year, month, _settings)
        final_by_date = {r.date: r for r in final_records}
    else:
        final_by_date = {
            r.date: r
            for r in _ADR.objects.filter(
                employee=emp, date__year=year, date__month=month, source="manual"
            )
        }

    # 6. Classify each working day
    DAY_NAMES = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"]
    days_detail = []
    present_count = 0
    paid_leave_count = 0
    unpaid_leave_count = 0
    absent_count = 0
    late_count = 0
    half_shift_count = 0
    full_shift_count = 0
    effective_present = Decimal("0")  # accumulates 0.5 or 1.0 per present day

    for d in working_days_list:
        # Final record (override / simple mode) takes priority over strict classification
        fr = final_by_date.get(d)
        if fr is not None and (fr.source == "manual" or use_simple):
            fr_status = fr.status
            if fr_status in ("present", "half_shift"):
                status = "present"
            elif fr_status == "on_leave":
                status = "paid_leave"
            elif fr_status == "holiday":
                # A day marked holiday by override shouldn't reduce pay
                status = "paid_leave"
            else:
                status = "absent"
            info = {
                "status": status,
                "is_late": fr.is_late,
                "first_in": fr.first_punch.strftime("%H:%M") if fr.first_punch else None,
                "last_out": fr.last_punch.strftime("%H:%M") if fr.last_punch else None,
                "leave_type": None,
            }
            forced_shifts = Decimal(str(fr.shifts_earned or 0))
            forced_half = fr.is_half_shift or fr_status == "half_shift"
        else:
            info = _classify_day(d, logs_by_date, attendance_by_date, approved_leaves, shift_start, grace_minutes)
            status = info["status"]
            forced_shifts = None
            forced_half = False
            # Night-shift relaxation: worked late last night → late arrival
            # today within the allowed window is not counted as Late.
            if info["is_late"] and info.get("first_in"):
                from .night_shift import get_relaxation_for
                _relax = get_relaxation_for(emp, d)
                if _relax:
                    from datetime import datetime as _dtm
                    _fi = _dtm.strptime(info["first_in"], "%H:%M").time()
                    if _fi <= _relax.allowed_until:
                        info["is_late"] = False

        is_late = info["is_late"]
        is_half = False
        day_shifts = Decimal("1.00")

        if status == "present":
            present_count += 1
            if is_late:
                late_count += 1
            if forced_shifts is not None:
                # Value from the final-attendance record (override or simple mode)
                day_shifts = forced_shifts if forced_shifts > 0 else Decimal("1.00")
                if forced_half or day_shifts == Decimal("0.50"):
                    is_half = True
                    half_shift_count += 1
                else:
                    full_shift_count += 1
            else:
                # Strict mode: use DailyShiftLog.shifts_completed to detect half shifts
                sl = shift_logs_by_date.get(d)
                if sl and sl.shifts_completed > 0:
                    day_shifts = sl.shifts_completed
                    if day_shifts == Decimal("0.50"):
                        is_half = True
                        half_shift_count += 1
                    else:
                        full_shift_count += 1
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
    # and the late-penalty calc below — those are fine to round, since
    # neither one needs to algebraically reconstruct the full salary.
    daily_rate_exact = emp.salary_amount / Decimal(str(total_working_days))
    base_gross = _d2(daily_rate_exact * effective_days)
    daily_rate = _d2(daily_rate_exact)

    # Basic = 50% of full monthly salary (not prorated — this is the component base)
    basic_full = _d2(emp.salary_amount * Decimal("0.50"))
    hra_full = _d2(emp.salary_amount * Decimal("0.20"))

    # Prorate basic and HRA by the same factor
    prorate_factor = effective_days / Decimal(str(total_working_days))
    basic = _d2(basic_full * prorate_factor)
    hra = _d2(hra_full * prorate_factor)
    allowances = _d2(base_gross - basic - hra)

    # PF / ESI — read live from PayrollSettings. The Staff Payroll Rules
    # master toggle (Settings → Payroll) must be ON for any deduction to
    # apply; rates alone are not enough.
    ps = PayrollSettings.get()
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

    # 8. Late shift penalty — 3 free lates/month, every 3 billable = ¼ shift.
    #    Late counts follow the active attendance mode:
    #      simple → is_late flags on the final AttendanceDayRecords (incl. overrides)
    #      strict → 4-punch engine summary (morning late + lunch-return late)
    #    All approved permission requests this month count as late entries too,
    #    merged into the same late-punch pool (applies to both modes — see
    #    shift_engine.compute_monthly_shift_summary for the strict-mode
    #    equivalent). ONE shared 3-free allowance covers the combined raw
    #    total — permissions are NOT pre-filtered by their own 3-free before
    #    merging, since that would double-discount the free allowance.
    late_penalty = Decimal("0")
    late_summary_data = {
        "totalLateCount": late_count,
        "permissionsUsed": 0,
        "billableLateCount": 0,
        "shiftDeductions": 0.0,
    }
    if use_simple:
        from .models import EmployeePermission
        approved_permissions = EmployeePermission.objects.filter(
            employee=emp, date__year=year, date__month=month, status="approved",
        ).count()

        total_late = late_count + approved_permissions  # counted in the day loop from final records
        free_permissions = 3
        billable_late = max(0, total_late - free_permissions)
        shift_deductions = Decimal(str(billable_late // 3)) * Decimal("0.25")
        late_summary_data = {
            "totalLateCount": late_count,
            "permissionsUsed": min(total_late, free_permissions),
            "billableLateCount": billable_late,
            "shiftDeductions": float(shift_deductions),
        }
        if shift_deductions > 0:
            late_penalty = _d2(shift_deductions * daily_rate)
    else:
        from .shift_engine import compute_monthly_shift_summary
        shift_summary = compute_monthly_shift_summary(emp, year, month, daily_rate)
        if shift_summary and shift_summary.salary_deduction_amount > 0:
            late_penalty = shift_summary.salary_deduction_amount
            late_summary_data = {
                "totalLateCount": shift_summary.total_late_count,
                "permissionsUsed": shift_summary.permissions_used,
                "billableLateCount": shift_summary.billable_late_count,
                "shiftDeductions": float(shift_summary.shift_deductions),
            }

    # 9. Advances
    advance_total, advance_details = _pending_advance_repayments(emp, month, year)

    total_deductions = _d2(pf_deduction + esi_deduction + advance_total + late_penalty)
    net_salary = _d2(base_gross - total_deductions)

    # 9. Build breakdown JSON (full traceability)
    breakdown = {
        "type": "staff",
        "attendanceMode": "simple" if use_simple else "strict",
        "simpleHalfShiftCutoff": str(_settings.simple_half_shift_cutoff)[:5] if use_simple else None,
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
                f"Late: {late_count}. Absent: {absent_count}. Unpaid leave: {unpaid_leave_count}."
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
            other_deductions=late_penalty,
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


def _get_biweekly_range(month: int, year: int, week_number: int) -> tuple[date, date]:
    """
    Two pay periods per month:
      week_number=1 → "Week 1 & 2"  → 1st–15th
      week_number=2 → "Week 3 & 4"  → 16th–last day
    """
    if week_number == 1:
        return date(year, month, 1), date(year, month, 15)
    else:
        return date(year, month, 16), date(year, month, calendar.monthrange(year, month)[1])


def _generate_production_payroll(emp: Employee, month: int, year: int, week_number: int) -> dict:
    """
    Shift-based bi-weekly payroll for production employees — completely
    separate from the staff engine. No monthly salary, no proration, no
    leave/permission/CL: pay = total shifts earned x salary_per_shift.
    week_number: 1 (days 1-15) or 2 (days 16-end).
    """
    if not emp.salary_per_shift or emp.salary_per_shift <= 0:
        raise PayrollSkip("No Salary Per Shift set on this employee's profile")

    from .attendance_final import compute_range_records

    date_from, date_to = _get_biweekly_range(month, year, week_number)
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
            "isLate": rec.is_late,
        })

    salary_per_shift = emp.salary_per_shift
    gross_amount = _d2(total_shifts * salary_per_shift)

    # PF / EF for production — either salary-range rules (when enabled) or flat rates
    ps = PayrollSettings.get()
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
        # toggle (Settings → Payroll) is ON — mirrors the staff toggle.
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

    advance_total, advance_details = _pending_advance_repayments(emp, month, year)

    total_deductions = _d2(pf_deduction + esi_deduction + advance_total)
    net_salary = _d2(gross_amount - total_deductions)

    total_days = (date_to - date_from).days + 1

    breakdown = {
        "type": "production",
        "weekNumber": week_number,
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
            "total": float(total_deductions),
        },
        "netSalary": float(net_salary),
    }

    payroll, _ = Payroll.objects.update_or_create(
        employee=emp, month=month, year=year, week_number=week_number,
        defaults=dict(
            salary_mode="shift",
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
                f"Production week {week_number} ({date_from} to {date_to}): "
                f"{total_shifts} shifts x Rs{salary_per_shift} = Rs{gross_amount}."
            ),
        ),
    )

    slip_number = f"SS/{emp.employee_code}/{year}/{str(month).zfill(2)}/W{week_number}"
    slip, _ = SalarySlip.objects.update_or_create(
        employee=emp, month=month, year=year, week_number=week_number,
        defaults=dict(
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
# — it matches by Employee Code rather than internal id, also writes the
# Attendance presence table, and shares its write path with live biometric
# sync via biometric_sync._ingest_punches.


# ─────────────────────────────────────────────────────────────────────────────
#  Work Sessions — list / edit
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
#  Skip-check preview (read-only, dry-run — reuses the real engines)
# ─────────────────────────────────────────────────────────────────────────────

class _DryRunAbort(Exception):
    """Internal-only — used purely to force a rollback of a savepoint we
    always intend to discard, never surfaced to a caller."""


def _dry_run_skip_reason(fn, *args) -> str | None:
    """
    Call a payroll-generation function inside a transaction that is always
    rolled back, to discover whether it would succeed or exactly why it
    would be skipped — without ever persisting anything. Returns None if it
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
    GET /api/payroll/skip-check?month=&year=&runType=monthly|biweekly&weekNumber=
    Read-only preview of exactly which active employees Generate Payroll
    would currently skip, and why. Runs the exact same engine functions
    generate_payroll uses, each inside its own savepoint that's always
    rolled back — so this can be called any time, as often as needed,
    without ever writing to the database. This is what powers the
    "Skipped Employees" view on the Payroll page — unlike the transient
    post-generation toast, it works whenever HR wants to check, not only
    immediately after a run.
    """
    month = request.query_params.get("month")
    year = request.query_params.get("year")
    run_type = request.query_params.get("runType", "monthly")
    week_number = request.query_params.get("weekNumber")

    if not month or not year:
        return _error("month and year are required")
    try:
        month, year = int(month), int(year)
    except ValueError:
        return _error("month and year must be integers")

    employment_type = (
        Employee.EMPLOYMENT_TYPE_STAFF if run_type == "monthly"
        else Employee.EMPLOYMENT_TYPE_PRODUCTION
    )
    employees = list(
        scope_to_branch(Employee.objects, request)
        .filter(status="active", employment_type=employment_type)
        .order_by("first_name", "last_name")
    )

    skipped = []
    for emp in employees:
        emp_name = f"{emp.first_name} {emp.last_name}".strip()
        if run_type == "monthly":
            reason = _dry_run_skip_reason(_generate_staff_payroll, emp, month, year)
        else:
            wk = int(week_number) if week_number else 1
            reason = _dry_run_skip_reason(_generate_production_payroll, emp, month, year, wk)
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
    Generate payrolls for all active employees.

    Body:
      { month, year, runType: "monthly"|"biweekly", weekNumber: 1|2 }

    runType="monthly"  → generates staff (monthly) only
    runType="biweekly" → generates production (session-based) only, for the given weekNumber
    If runType is omitted, generates BOTH in one call (staff monthly + production week 1 and 2).
    """
    data = request.data
    month = data.get("month")
    year = data.get("year")
    run_type = data.get("runType", "all")
    week_number = data.get("weekNumber")

    if not month or not year:
        return _error("month and year are required")
    try:
        month, year = int(month), int(year)
    except ValueError:
        return _error("month and year must be integers")

    if run_type == "biweekly":
        if not week_number or int(week_number) not in (1, 2):
            return _error("weekNumber (1 or 2) is required for biweekly run")
        week_number = int(week_number)

    employees = list(Employee.objects.filter(status="active"))
    generated = []
    skipped = []

    from . import payroll_progress
    payroll_progress.start(len(employees))

    for emp in employees:
        emp_name = f"{emp.first_name} {emp.last_name}"
        before_count = len(generated)
        try:
            if emp.employment_type == "staff" and run_type in ("monthly", "all"):
                result = _generate_staff_payroll(emp, month, year)
                generated.append(_payroll_json(result["payroll"], emp_name))

            elif emp.employment_type == "production" and run_type in ("biweekly", "all"):
                wk = week_number if run_type == "biweekly" else None
                weeks_to_run = [wk] if wk else [1, 2]
                for wk in weeks_to_run:
                    result = _generate_production_payroll(emp, month, year, wk)
                    generated.append(_payroll_json(result["payroll"], emp_name))
        except PayrollSkip as e:
            skipped.append({"employeeId": emp.id, "name": emp_name, "reason": str(e)})
        except Exception as e:
            skipped.append({"employeeId": emp.id, "name": emp_name, "reason": str(e)})
        payroll_progress.step(emp_name, len(generated) > before_count)

    payroll_progress.finish()

    from .audit_utils import log_action as _log
    _log(request, "create", "payroll", description=(
        f"Generated payroll {month}/{year} [{run_type}] — "
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
#  Payroll breakdown — full traceability for one employee-month
# ─────────────────────────────────────────────────────────────────────────────

@api_view(["GET"])
@require_hr
def payroll_breakdown(request: Request, pk: int) -> Response:
    """Return the full day-by-day breakdown stored in the associated SalarySlip."""
    p = Payroll.objects.select_related("employee").filter(pk=pk).first()
    if not p:
        return _error("Not found", 404)

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

            # Present day — create Attendance record
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
                # On time — arrive 5 min before shift
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
#  Payroll Settings (singleton — PF/ESI rates, pay day, production pay type)
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
    "prodFirstHalfStart": ("settings.attendance",),
    "prodFirstHalfEnd": ("settings.attendance",),
    "prodSecondHalfStart": ("settings.attendance",),
    "prodSecondHalfEnd": ("settings.attendance",),
    "prodExtraStart": ("settings.attendance",),
    "prodExtraEnd": ("settings.attendance",),
    "nightShiftEnabled": ("settings.attendance",),
    "pfRate": ("settings.payroll",),
    "esiRate": ("settings.payroll",),
    "esiApplicableBelow": ("settings.payroll",),
    "prodPfRate": ("settings.payroll",),
    "prodEsiRate": ("settings.payroll",),
    "prodEsiApplicableBelow": ("settings.payroll",),
    "payDay": ("settings.payroll",),
    "productionPayType": ("settings.payroll",),
    "defaultSalaryPerShift": ("settings.payroll",),
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
    user, resolved fresh from the DB — mirrors the lookup permission_middleware
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
    ps = PayrollSettings.get()

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
        "prodFirstHalfStart": ("prod_first_half_start", str),
        "prodFirstHalfEnd": ("prod_first_half_end", str),
        "prodSecondHalfStart": ("prod_second_half_start", str),
        "prodSecondHalfEnd": ("prod_second_half_end", str),
        "prodExtraStart": ("prod_extra_start", str),
        "prodExtraEnd": ("prod_extra_end", str),
    }
    # Image fields may legitimately be set to null (user removed the logo /
    # signature) — str(None) would store the literal string "None".
    _nullable_text = {"signature_image", "company_logo", "authorized_signature"}
    for key, (attr, cast) in field_map.items():
        if key in data:
            val = data[key]
            if val is None and attr in _nullable_text:
                setattr(ps, attr, None)
            else:
                setattr(ps, attr, Decimal(str(val)) if cast is Decimal else cast(val))
    if "prodPfEfRules" in data and isinstance(data["prodPfEfRules"], list):
        ps.prod_pf_ef_rules = data["prodPfEfRules"]
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
    ps.save()

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

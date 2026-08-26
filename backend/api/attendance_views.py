import calendar
import logging
from collections import defaultdict
from datetime import date as date_type, datetime, time as time_type, timedelta
from decimal import Decimal
from io import StringIO

from django.db.models import Count, Q
from rest_framework.decorators import api_view
from rest_framework.request import Request
from rest_framework.response import Response

from .auth import require_hr, require_auth, get_token_employee_id
from .branch_scope import get_branch_scope, scope_to_branch
from .geo_attendance_views import source_label
from .models import (
    Attendance, AttendanceLog, Employee, EmployeePermission, EmployeeShiftAssignment,
    LeaveRequest, DailyShiftLog, MonthlyShiftSummary, Holiday,
    PayrollSettings, ProductionShiftConfig, ProductionShiftSegment,
)

logger = logging.getLogger(__name__)

# API key the AiFace-Mars device must send in the X-Device-Key header.
# Set BIOMETRIC_API_KEY in your .env file -never hardcode this value.


def _today() -> date_type:
    return date_type.today()


def _parse_date(s) -> date_type:
    if s:
        try:
            return date_type.fromisoformat(str(s))
        except (ValueError, TypeError):
            pass
    return _today()


def _punched_ids(d: date_type) -> set[int]:
    return set(
        AttendanceLog.objects.filter(date=d)
        .values_list("employee_id", flat=True)
        .distinct()
    )


def _manual_present_ids(d: date_type) -> set[int]:
    return set(
        Attendance.objects.filter(date=str(d), present=True)
        .values_list("employee_id", flat=True)
    )


def _bio_punched_ids(d: date_type) -> set[int]:
    """Employees with an actual biometric-device punch today. Unlike the
    Attendance table (present=True), which biometric sync ALSO writes to as
    a side effect and so can't tell biometric from manual apart on its own,
    AttendanceLog.source reliably distinguishes them."""
    return set(
        AttendanceLog.objects.filter(date=d, source__startswith="biometric")
        .values_list("employee_id", flat=True)
        .distinct()
    )


def _leave_ids(d: date_type) -> set[int]:
    return set(
        LeaveRequest.objects.filter(
            status="approved",
            start_date__lte=str(d),
            end_date__gte=str(d),
        ).values_list("employee_id", flat=True)
    )


def _late_count(d: date_type, allowed_ids: set[int] | None = None) -> int:
    """Employees who punched IN after their shift start + grace period."""
    logs = (
        AttendanceLog.objects
        .filter(date=d, punch_type=AttendanceLog.PUNCH_IN)
        .order_by("employee_id", "punch_time")
    )
    first_punch: dict[int, time_type] = {}
    for log in logs:
        if log.employee_id not in first_punch:
            first_punch[log.employee_id] = log.punch_time

    late = 0
    for emp_id, pt in first_punch.items():
        if allowed_ids is not None and emp_id not in allowed_ids:
            continue
        asgn = (
            EmployeeShiftAssignment.objects
            .filter(
                employee_id=emp_id,
                effective_from__lte=d,
            )
            .filter(Q(effective_to__isnull=True) | Q(effective_to__gte=d))
            .select_related("shift")
            .order_by("-effective_from")
            .first()
        )
        if asgn and asgn.shift.start_time:
            grace = asgn.shift.grace_period_minutes or 0
            deadline = datetime.combine(d, asgn.shift.start_time) + timedelta(minutes=grace)
            if datetime.combine(d, pt) > deadline:
                late += 1
    return late


# ── Summary ──────────────────────────────────────────────────────────────────

@api_view(["GET"])
@require_hr
def attendance_summary(request: Request) -> Response:
    d = _parse_date(request.query_params.get("date"))
    yesterday = d - timedelta(days=1)
    emp_type = request.query_params.get("employmentType")  # staff | production | None
    branch_id = get_branch_scope(request)

    base_qs = Employee.objects.filter(status="active")
    if branch_id is not None:
        base_qs = base_qs.filter(branch_id=branch_id)
    if emp_type:
        base_qs = base_qs.filter(employment_type=emp_type)
    restrict_ids = set(base_qs.values_list("id", flat=True)) if (emp_type or branch_id is not None) else None

    total = base_qs.count()
    prod_qs = Employee.objects.filter(status="active", employment_type="production")
    staff_qs = Employee.objects.filter(status="active", employment_type="staff")
    if branch_id is not None:
        prod_qs = prod_qs.filter(branch_id=branch_id)
        staff_qs = staff_qs.filter(branch_id=branch_id)
    prod_total = prod_qs.count()
    staff_total = staff_qs.count()

    all_punched_ids = _punched_ids(d)
    bio_ids = _bio_punched_ids(d)
    manual_ids = _manual_present_ids(d)
    if restrict_ids is not None:
        all_punched_ids &= restrict_ids
        bio_ids &= restrict_ids
        manual_ids &= restrict_ids
    present_ids = all_punched_ids | manual_ids

    # Production / Staff breakdown of present
    present_emp_types = dict(
        Employee.objects.filter(id__in=present_ids)
        .values_list("id", "employment_type")
    )
    prod_present = sum(1 for t in present_emp_types.values() if t == "production")
    staff_present = sum(1 for t in present_emp_types.values() if t == "staff")

    present_today = len(present_ids)
    not_punched = max(0, total - present_today)

    # Yesterday stats
    y_bio = _punched_ids(yesterday)
    y_manual = _manual_present_ids(yesterday)
    if restrict_ids is not None:
        y_bio &= restrict_ids
        y_manual &= restrict_ids
    y_present_ids = y_bio | y_manual
    y_leave = _leave_ids(yesterday)
    if restrict_ids is not None:
        y_leave &= restrict_ids
    y_late = _late_count(yesterday, restrict_ids)
    y_absent = max(0, total - len(y_present_ids) - len(y_leave & (set(range(total + 1)) - y_present_ids)))

    return Response({
        "date": str(d),
        "totalEmployees": total,
        "productionTotal": prod_total,
        "staffTotal": staff_total,
        "presentToday": present_today,
        "biometricPresent": len(bio_ids),
        "manualPresent": len(present_ids - bio_ids),
        "productionPresent": prod_present,
        "staffPresent": staff_present,
        "notPunched": not_punched,
        "productionNotPunched": max(0, prod_total - prod_present),
        "staffNotPunched": max(0, staff_total - staff_present),
        "yesterday": {
            "date": str(yesterday),
            "present": len(y_present_ids),
            "absent": max(0, total - len(y_present_ids) - len(y_leave)),
            "late": y_late,
            "onLeave": len(y_leave),
        },
    })


# ── Company-wide "Today's Overview" (Attendance Search page) ────────────────

@api_view(["GET"])
@require_hr
def attendance_company_summary(request: Request) -> Response:
    """Today's company-wide attendance breakdown (Staff + Production
    combined) for the Attendance Search page's overview cards. Present/
    Half-Shift/Shift-units require the real compute_day_record engine (the
    cheap raw-punch helpers above have no Half-Shift or shift-unit concept),
    so this reuses it per active employee -same figures the page's own
    per-employee search already shows, not a separate approximation.

    Everything compute_day_record() would otherwise look up one employee at
    a time (punches, shift assignment, night-shift relaxation state,
    approved permission, existing day record) is bulk-fetched here ONCE
    across the whole roster and handed down per employee via `prefetch`
    -the same prefetch-dict shape compute_month_records() already uses for
    one employee across many days, just sliced the other way (many
    employees, one day). Calling compute_day_record with no prefetch at all
    across a ~230-employee roster measured at ~57s per request; this keeps
    it to a small, fixed number of bulk queries regardless of roster size."""
    from decimal import Decimal
    from .attendance_final import compute_day_record
    from .models import AttendanceDayRecord, EmployeeShiftAssignment, NightShiftRelaxation, NightShiftRule
    from .night_shift import ensure_default_rules

    d = _today()
    branch_id = get_branch_scope(request)

    employees_qs = Employee.objects.filter(status="active")
    if branch_id is not None:
        employees_qs = employees_qs.filter(branch_id=branch_id)
    employees = list(employees_qs)
    emp_ids = [e.id for e in employees]

    ps = PayrollSettings.get()
    prod_config = ProductionShiftConfig.get()
    prod_segments = list(ProductionShiftSegment.objects.filter(is_active=True))
    leave_ids_today = _leave_ids(d)
    is_holiday_today = Holiday.objects.filter(date=d).exists()

    yesterday = d - timedelta(days=1)
    logs_by_emp_date: dict[int, dict] = {}
    for log in AttendanceLog.objects.filter(
        employee_id__in=emp_ids, date__gte=yesterday, date__lte=d,
    ).order_by("punch_time"):
        logs_by_emp_date.setdefault(log.employee_id, {}).setdefault(log.date, []).append(log)

    assignments_by_emp: dict[int, list] = {}
    for a in (
        EmployeeShiftAssignment.objects.filter(employee_id__in=emp_ids, effective_from__lte=d)
        .filter(Q(effective_to__isnull=True) | Q(effective_to__gte=yesterday))
        .select_related("shift")
    ):
        assignments_by_emp.setdefault(a.employee_id, []).append(a)

    existing_records_by_emp: dict[int, dict] = {}
    for r in AttendanceDayRecord.objects.filter(employee_id__in=emp_ids, date=d):
        existing_records_by_emp.setdefault(r.employee_id, {})[r.date] = r

    manual_present_by_emp: dict[int, set] = {}
    for emp_id in Attendance.objects.filter(
        employee_id__in=emp_ids, date=d.isoformat(), present=True,
    ).values_list("employee_id", flat=True):
        manual_present_by_emp.setdefault(emp_id, set()).add(d)

    ensure_default_rules()
    night_rules = list(NightShiftRule.objects.filter(is_active=True))

    relaxations_by_emp: dict[int, dict] = {}
    for r in NightShiftRelaxation.objects.filter(employee_id__in=emp_ids, relaxation_date=d):
        relaxations_by_emp.setdefault(r.employee_id, {})[r.relaxation_date] = r

    permissions_by_emp: dict[int, dict] = {}
    for p in EmployeePermission.objects.filter(
        employee_id__in=emp_ids, date=d, status="approved",
    ).order_by("updated_at"):
        permissions_by_emp.setdefault(p.employee_id, {})[p.date] = p

    present = half_shift = absent = on_leave = late = 0
    total_shifts_earned = Decimal("0")
    for emp in employees:
        is_production = emp.employment_type == "production"
        emp_logs_by_date = logs_by_emp_date.get(emp.id, {})
        prefetch = {
            "assignments": assignments_by_emp.get(emp.id, []),
            "existing_day_records": existing_records_by_emp.get(emp.id, {}),
            "manual_attendance_dates": manual_present_by_emp.get(emp.id, set()),
            "night_logs_by_date": emp_logs_by_date,
            "night_rules": night_rules,
            "existing_relaxations": relaxations_by_emp.get(emp.id, {}),
            "approved_permissions_by_date": permissions_by_emp.get(emp.id, {}),
        }
        rec = compute_day_record(
            emp, d,
            punch_logs=emp_logs_by_date.get(d, []),
            settings=ps,
            leave_dates={d} if emp.id in leave_ids_today else set(),
            holiday_dates={d} if is_holiday_today else set(),
            prod_config=prod_config if is_production else None,
            prod_segments=prod_segments if is_production else None,
            prefetch=prefetch,
        )
        if rec.status == "present":
            present += 1
        elif rec.status == "half_shift":
            half_shift += 1
        elif rec.status == "on_leave":
            on_leave += 1
        elif rec.status == "absent":
            absent += 1
        if rec.is_late:
            late += 1
        total_shifts_earned += rec.shifts_earned or Decimal("0")

    permission_today = EmployeePermission.objects.filter(
        date=d, status="approved", employee_id__in=emp_ids
    ).count()

    return Response({
        "date": str(d),
        "totalEmployees": len(employees),
        "present": present,
        "halfShift": half_shift,
        "absent": absent,
        "onLeave": on_leave,
        "late": late,
        "permission": permission_today,
        "totalShiftsEarned": float(total_shifts_earned),
    })


# ── Mobile Home -"Today at a Glance" + Live Feed ─────────────────────────────

@api_view(["GET"])
@require_auth
def mobile_home_summary(request: Request) -> Response:
    """Company-wide today snapshot for the mobile app's Home screen -scoped
    to the requesting employee's own branch (derived from their own row,
    since get_branch_scope() only ever resolves for HR tokens). Reuses the
    exact same counting helpers as attendance_summary (HR portal) so the two
    can never disagree on what "present"/"late" means for the same day."""
    d = _today()
    token_emp_id = get_token_employee_id(request)
    branch_id = None
    if token_emp_id:
        branch_id = Employee.objects.filter(pk=token_emp_id).values_list("branch_id", flat=True).first()

    base_qs = Employee.objects.filter(status="active")
    if branch_id is not None:
        base_qs = base_qs.filter(branch_id=branch_id)
    restrict_ids = set(base_qs.values_list("id", flat=True)) if branch_id is not None else None

    total = base_qs.count()
    present_ids = _punched_ids(d) | _manual_present_ids(d)
    leave_ids = _leave_ids(d)
    if restrict_ids is not None:
        present_ids &= restrict_ids
        leave_ids &= restrict_ids
    present_today = len(present_ids)
    absent_today = max(0, total - present_today - len(leave_ids))
    late_today = _late_count(d, restrict_ids)

    permission_qs = EmployeePermission.objects.filter(date=d, status="approved")
    if restrict_ids is not None:
        permission_qs = permission_qs.filter(employee_id__in=restrict_ids)
    permission_today = permission_qs.count()

    return Response({
        "date": str(d),
        "presentToday": present_today,
        "absentToday": absent_today,
        "lateToday": late_today,
        "permissionToday": permission_today,
    })


@api_view(["GET"])
@require_auth
def attendance_live_feed(request: Request) -> Response:
    """Today's own punches ticker for the mobile Home screen -self-scoped
    to the requesting employee only (never another employee's punches).
    IN/OUT is derived by time-position within the employee's day -never
    the raw stored punch_type -same rule as attendance_employee_history,
    since biometric devices often record every punch as IN."""
    d = _today()
    try:
        limit = min(max(int(request.query_params.get("limit") or 20), 1), 50)
    except (TypeError, ValueError):
        limit = 20

    token_emp_id = get_token_employee_id(request)

    logs_qs = AttendanceLog.objects.filter(date=d).select_related(
        "employee", "employee__department"
    ).order_by("employee_id", "punch_time")
    if token_emp_id:
        logs_qs = logs_qs.filter(employee_id=token_emp_id)

    items = []
    position_by_emp: dict[int, int] = defaultdict(int)
    for log in logs_qs:
        position = position_by_emp[log.employee_id]
        position_by_emp[log.employee_id] += 1
        emp = log.employee
        items.append({
            "employeeName": f"{emp.first_name} {emp.last_name}",
            "department": emp.department.name if emp.department_id and emp.department else None,
            "event": "in" if position % 2 == 0 else "out",
            "time": log.punch_time.strftime("%H:%M"),
            "date": str(d),
            "_sortKey": log.punch_time,
        })

    items.sort(key=lambda item: item["_sortKey"], reverse=True)
    for item in items:
        del item["_sortKey"]

    return Response({"items": items[:limit]})


# ── Daily employee list ───────────────────────────────────────────────────────

@api_view(["GET"])
@require_hr
def attendance_daily(request: Request) -> Response:
    d = _parse_date(request.query_params.get("date"))
    emp_type = request.query_params.get("employmentType")

    # Bulk-fetch all data for this date in 3 queries
    logs = list(
        AttendanceLog.objects.filter(date=d).order_by("employee_id", "punch_time")
    )
    logs_by_emp: dict[int, list] = defaultdict(list)
    for log in logs:
        logs_by_emp[log.employee_id].append(log)

    manual_by_emp = {
        a.employee_id: a
        for a in Attendance.objects.filter(date=str(d))
    }

    leave_emp_ids = _leave_ids(d)

    qs = Employee.objects.filter(status="active").select_related("department", "designation")
    qs = scope_to_branch(qs, request)
    if emp_type:
        qs = qs.filter(employment_type=emp_type)

    results = []
    for emp in qs:
        emp_logs = logs_by_emp.get(emp.id, [])
        manual = manual_by_emp.get(emp.id)

        if emp_logs:
            from .attendance_final import _resolve_primary_source
            # First/last punch of the day by time position, not by
            # filtering for a stored "IN"/"OUT" type -biometric devices
            # often record every punch as "IN", which would silently blank
            # out last_out on those days if this filtered by type instead.
            first_in = emp_logs[0]
            last_out = emp_logs[-1] if len(emp_logs) > 1 else None
            status = "present"
            # Biometric wins whenever it contributed anything that day —
            # not just "whichever punch happens to be first in the list".
            source = _resolve_primary_source(emp_logs)
        elif manual and manual.present:
            first_in = None
            last_out = None
            status = "manual"
            source = "manual"
        elif emp.id in leave_emp_ids:
            first_in = None
            last_out = None
            status = "on_leave"
            source = None
        else:
            first_in = None
            last_out = None
            status = "absent"
            source = None

        results.append({
            "employeeId": emp.id,
            "employeeCode": emp.employee_code,
            "employeeName": f"{emp.first_name} {emp.last_name}",
            "department": emp.department.name if emp.department else None,
            "designation": emp.designation.title if emp.designation else None,
            "employmentType": emp.employment_type,
            "status": status,
            "firstPunch": first_in.punch_time.strftime("%H:%M") if first_in else None,
            "lastPunch": last_out.punch_time.strftime("%H:%M") if last_out else None,
            "source": source,
            "sourceLabel": source_label(source) if source else None,
            "totalPunches": len(emp_logs),
        })

    return Response(results)


# ── Monthly trend ─────────────────────────────────────────────────────────────

@api_view(["GET"])
@require_hr
def attendance_monthly_trend(request: Request) -> Response:
    year = int(request.query_params.get("year", _today().year))
    month = int(request.query_params.get("month", _today().month))
    emp_type = request.query_params.get("employmentType")

    branch_id = get_branch_scope(request)
    emp_qs = Employee.objects.filter(status="active")
    if branch_id is not None:
        emp_qs = emp_qs.filter(branch_id=branch_id)
    if emp_type:
        emp_qs = emp_qs.filter(employment_type=emp_type)
    total = emp_qs.count()
    type_ids = set(emp_qs.values_list("id", flat=True)) if (emp_type or branch_id is not None) else None

    log_qs = AttendanceLog.objects.filter(date__year=year, date__month=month)
    if type_ids is not None:
        log_qs = log_qs.filter(employee_id__in=type_ids)
    bio_daily = {
        str(row["date"]): row["cnt"]
        for row in log_qs.values("date").annotate(cnt=Count("employee_id", distinct=True))
    }

    prefix = f"{year}-{str(month).zfill(2)}"
    manual_daily: dict[str, int] = defaultdict(int)
    manual_qs = Attendance.objects.filter(date__startswith=prefix, present=True)
    if type_ids is not None:
        manual_qs = manual_qs.filter(employee_id__in=type_ids)
    for a in manual_qs:
        manual_daily[a.date] += 1

    days_in_month = calendar.monthrange(year, month)[1]
    today_str = str(_today())
    result = []
    for day in range(1, days_in_month + 1):
        d_str = f"{year}-{str(month).zfill(2)}-{str(day).zfill(2)}"
        if d_str > today_str:
            break
        present = max(bio_daily.get(d_str, 0), manual_daily.get(d_str, 0))
        result.append({
            "date": d_str,
            "day": day,
            "label": str(day),
            "present": present,
            "absent": max(0, total - present),
        })

    return Response(result)


# ── Employee attendance history ───────────────────────────────────────────────

@api_view(["GET"])
@require_auth
def attendance_employee_history(request: Request, pk: int) -> Response:
    # Employees can only view their own attendance
    token_emp_id = get_token_employee_id(request)
    if token_emp_id and token_emp_id != pk:
        return Response({"error": "Access denied"}, status=403)
    emp = scope_to_branch(Employee.objects, request).select_related("department", "designation").filter(pk=pk).first()
    if not emp:
        return Response({"error": "Employee not found"}, status=404)

    from .attendance_final import compute_month_records, month_summary_from_records

    today = date_type.today()
    month = int(request.query_params.get("month") or today.month)
    year  = int(request.query_params.get("year")  or today.year)
    _, days_in_month = calendar.monthrange(year, month)

    # The exact same day-by-day engine payroll and the HR portal's
    # Attendance Search page use (compute_day_record / compute_month_records
    # in attendance_final.py) -so Present / Half Shift / Late can never
    # disagree between HRMS and this endpoint (which both the mobile app and
    # this page's own Employee Detail dialog consume). Previously this view
    # ran its own simplified inline classification that never produced
    # "half_shift" at all and used a plain grace-period late check instead
    # of the shift punctuality-window rule -the root cause of Half Shift /
    # Late looking wrong on mobile compared to the HR portal.
    day_records = {r.date: r for r in compute_month_records(emp, year, month)}

    # Punch logs for the month -display only now; status/late/half-shift
    # all come from day_records above, not from re-deriving punches here.
    logs_qs = AttendanceLog.objects.filter(
        employee_id=pk, date__year=year, date__month=month,
    ).order_by("date", "punch_time")
    by_date: dict[str, list] = defaultdict(list)
    for log in logs_qs:
        date_key = str(log.date)
        position = len(by_date[date_key])
        by_date[date_key].append({
            "time": log.punch_time.strftime("%H:%M"),
            "type": "IN" if position % 2 == 0 else "OUT",
            "source": log.source,
            "sourceLabel": source_label(log.source),
        })

    # Manual attendance records -display only (notes/hours worked)
    prefix = f"{year}-{str(month).zfill(2)}"
    manual_by_date = {str(a.date): a for a in Attendance.objects.filter(employee_id=pk, date__startswith=prefix)}

    # Leave type per date -compute_day_record only exposes status=on_leave,
    # not which leave type, so that's still resolved separately for display.
    leave_dates: dict[str, str] = {}
    for leave in LeaveRequest.objects.filter(employee_id=pk, status="approved"):
        try:
            start = date_type.fromisoformat(str(leave.start_date))
            end   = date_type.fromisoformat(str(leave.end_date))
            cur   = start
            while cur <= end:
                if cur.year == year and cur.month == month:
                    leave_dates[cur.isoformat()] = leave.type
                cur += timedelta(days=1)
        except Exception:
            pass

    records = []
    for day in range(1, days_in_month + 1):
        cur_date = date_type(year, month, day)
        date_str = cur_date.isoformat()
        is_future = cur_date > today

        punches = by_date.get(date_str, [])
        manual  = manual_by_date.get(date_str)
        rec     = day_records.get(cur_date)

        if is_future:
            status = "future"
        elif rec is not None:
            status = rec.status
        else:
            status = "absent"

        first_in = rec.first_punch.strftime("%H:%M") if rec and rec.first_punch else (punches[0]["time"] if punches else None)
        last_out = rec.last_punch.strftime("%H:%M") if rec and rec.last_punch else (punches[-1]["time"] if len(punches) > 1 else None)

        records.append({
            "date":         date_str,
            "day":          cur_date.strftime("%a"),
            "status":       status,
            "isLate":       bool(rec.is_late) if rec else False,
            "isHalfShift":  bool(rec.is_half_shift) if rec else False,
            "present":      status in ("present", "half_shift"),
            "firstPunch":   first_in,
            "lastPunch":    last_out,
            "totalPunches": rec.total_punches if rec else len(punches),
            "punches":      punches,
            "leaveType":    leave_dates.get(date_str),
            "hoursWorked":  str(manual.hours_worked) if manual and manual.hours_worked else None,
            "source":       (punches[0]["source"] if punches else ("manual" if manual else None)),
            "sourceLabel":  (rec.primary_source if rec and rec.primary_source else None) or (source_label(punches[0]["source"]) if punches else None),
            "notes":        manual.notes if manual else None,
        })

    summary = month_summary_from_records(list(day_records.values()))

    return Response({
        "employee": {
            "id":             emp.id,
            "code":           emp.employee_code,
            "name":           f"{emp.first_name} {emp.last_name}",
            "department":     emp.department.name if emp.department else None,
            "designation":    emp.designation.title if emp.designation else None,
            "employmentType": emp.employment_type,
        },
        "month": month,
        "year":  year,
        "summary": {
            # workingDays = elapsed days this month minus holidays (see
            # month_summary_from_records) -the denominator the employee
            # apps show alongside Present/Absent/Leave so the figures are
            # readable as "X of Y" rather than bare counts.
            "workingDays": summary["workingDays"],
            "present":   summary["present"],
            "halfShift": summary["halfShift"],
            "absent":    summary["absent"],
            "onLeave":   summary["onLeave"],
            "late":      summary["late"],
        },
        # "Was present in some form" -full + half shift days combined,
        # matching this field's pre-existing meaning (used for the HR
        # portal's attendance-rate %), now with Half Shift correctly
        # counted in it instead of silently missing.
        "totalPresent": summary["present"] + summary["halfShift"],
        "totalAbsent":  summary["absent"],
        "records": records,
    })


# ── Biometric device webhook (AiFace-Mars) ────────────────────────────────────

@api_view(["POST"])
def biometric_punch(request: Request) -> Response:
    """
    AiFace-Mars pushes attendance via HTTP POST to this endpoint.

    Headers:
      X-Device-Key: <BIOMETRIC_API_KEY>

    Body (JSON):
      personId   : employee_code or employee ID stored on device
      time       : ISO-8601 datetime or Unix timestamp
      eventType  : 0=check-in (default), 1=check-out
      devSN      : device serial number (optional)
    """
    from django.conf import settings
    api_key = request.headers.get("X-Device-Key") or request.data.get("apiKey")
    expected = settings.BIOMETRIC_API_KEY
    if not expected:
        return Response({"error": "BIOMETRIC_API_KEY is not configured on the server"}, status=500)
    if api_key != expected:
        return Response({"error": "Unauthorized"}, status=401)

    data = request.data
    person_id = data.get("personId") or data.get("employeeCode")
    punch_time_raw = data.get("time") or data.get("punchTime")
    event_type = data.get("eventType", 0)
    device_sn = data.get("devSN") or data.get("deviceId", "")

    if not person_id or not punch_time_raw:
        # This endpoint has never actually received a push from real device
        # firmware -the payload shape below is from documentation, not a
        # verified sample. Logging the raw body here means the first real
        # mismatch tells us exactly what to fix instead of a bare 400 with
        # no forensic trail (the device itself won't show this anywhere).
        logger.warning("biometric_punch: missing personId/time -raw body: %r", request.data)
        return Response({"error": "personId and time are required"}, status=400)

    # Employee Code ONLY -the code enrolled on the device IS the Employee
    # Code in this company, always. This used to also fall back to the
    # internal database row id, which could silently attribute a punch to a
    # completely different person whenever a code happened to collide with
    # another employee's row id (e.g. code "73" vs db id 73). Never again.
    emp = Employee.objects.filter(employee_code=str(person_id).strip()).first()
    if not emp:
        return Response({"error": f"Employee '{person_id}' not found"}, status=404)

    try:
        if isinstance(punch_time_raw, (int, float)):
            from datetime import timezone
            dt = datetime.fromtimestamp(punch_time_raw, tz=timezone.utc).astimezone()
        else:
            dt = datetime.fromisoformat(str(punch_time_raw).replace("Z", "+00:00"))
    except (ValueError, TypeError):
        logger.warning("biometric_punch: unparsable time %r -raw body: %r", punch_time_raw, request.data)
        return Response({"error": "Invalid time format. Use ISO-8601 or Unix timestamp."}, status=400)

    punch_date = dt.date()
    punch_time = dt.time().replace(microsecond=0)
    punch_type = (
        AttendanceLog.PUNCH_OUT
        if str(event_type) in ("1", "OUT", "check-out")
        else AttendanceLog.PUNCH_IN
    )

    log = AttendanceLog.objects.create(
        employee=emp,
        date=punch_date,
        punch_time=punch_time,
        punch_type=punch_type,
        source=f"biometric:{device_sn}" if device_sn else "biometric",
    )

    # Keep Attendance summary record in sync
    Attendance.objects.update_or_create(
        employee=emp,
        date=str(punch_date),
        defaults={"present": True},
    )

    return Response({
        "ok": True,
        "logId": log.id,
        "employee": f"{emp.first_name} {emp.last_name}",
        "punchType": punch_type,
        "punchTime": punch_time.strftime("%H:%M:%S"),
        "date": str(punch_date),
    }, status=201)


# ── Manual attendance entry ───────────────────────────────────────────────────

@api_view(["POST"])
@require_hr
def manual_attendance(request: Request) -> Response:
    """
    HR manually adds attendance for an employee (e.g. after CCTV verification).
    Creates an AttendanceLog entry with source='manual'.
    """
    data = request.data
    emp_id = data.get("employeeId")
    date_str = data.get("date")
    punch_time_str = data.get("punchTime")
    punch_type = str(data.get("punchType", "IN")).upper()
    notes = data.get("notes", "")
    hours_worked = data.get("hoursWorked")

    if not emp_id or not date_str:
        return Response({"error": "employeeId and date are required"}, status=400)

    try:
        emp = Employee.objects.get(pk=emp_id)
    except Employee.DoesNotExist:
        return Response({"error": "Employee not found"}, status=404)

    try:
        d = date_type.fromisoformat(date_str)
    except (ValueError, TypeError):
        return Response({"error": "Invalid date format"}, status=400)

    log = None
    if punch_time_str:
        try:
            h, m = punch_time_str.split(":")
            pt = time_type(int(h), int(m))
        except (ValueError, TypeError, AttributeError):
            return Response({"error": "Invalid punchTime format. Use HH:MM"}, status=400)

        log = AttendanceLog.objects.create(
            employee=emp,
            date=d,
            punch_time=pt,
            punch_type=punch_type,
            source="manual",
        )

    att, _ = Attendance.objects.update_or_create(
        employee=emp,
        date=date_str,
        defaults={
            "present": True,
            "hours_worked": hours_worked,
            "notes": notes,
        },
    )

    return Response({
        "ok": True,
        "attendanceId": att.id,
        "logId": log.id if log else None,
        "employee": f"{emp.first_name} {emp.last_name}",
        "date": str(d),
    }, status=201)


@api_view(["GET"])
@require_auth
def attendance_sync_status(request: Request) -> Response:
    """
    GET /api/attendance/sync-status -employee-facing.

    Tells the employee apps whether today's attendance might still be
    incomplete because biometric hasn't been synced yet. `pendingSync` is
    true only when BOTH: (1) today already has a punch from a non-biometric
    source (Geo Punch / On-Duty / HR Entry) for this employee, AND (2) no
    active biometric device has synced since midnight today -since a
    biometric-device-recorded punch for the same physical check-in could
    still be sitting unsynced on the device, which would change today's
    picture once HR runs Sync Biometric. Never flags a day with zero
    punches at all (nothing to be "incomplete" yet) or a day biometric has
    already contributed to.
    """
    from .models import BiometricDevice
    from .geo_attendance_views import _day_bounds_utc

    emp_id = get_token_employee_id(request)
    if not emp_id:
        return Response({"error": "Employee authentication required"}, status=403)

    today = _today()
    today_logs = list(AttendanceLog.objects.filter(employee_id=emp_id, date=today))
    has_non_biometric_punch = any(not l.source.startswith("biometric") for l in today_logs)
    has_biometric_punch = any(l.source.startswith("biometric") for l in today_logs)

    # IST day boundary, not a naive make_aware() -this server's clock is
    # IST but Django's TIME_ZONE is UTC, so a naive midnight would silently
    # anchor 5:30 hours off. See geo_attendance_views._day_bounds_utc, the
    # one already-correct helper for this in the codebase.
    today_start_utc, _today_end_utc = _day_bounds_utc(today)
    synced_today = BiometricDevice.objects.filter(
        is_active=True, last_synced_at__gte=today_start_utc,
    ).exists()

    pending_sync = has_non_biometric_punch and not has_biometric_punch and not synced_today
    return Response({"pendingSync": pending_sync})


# ── Biometric Sync ────────────────────────────────────────────────────────────
# Two device sources, both supported together:
#   • backend/.env (BIOMETRIC_DEVICE_IP/PORT/PASSWORD) -always works, unchanged
#   • Settings → Devices -any number of additional devices added from the UI

def _date_from_for_mode(mode: str):
    """mode: 'day' | 'week' | 'month' | 'all' -the only 4 sync ranges HR needs."""
    from datetime import date as _date
    today = _date.today()
    if mode == "day":
        return today
    if mode == "week":
        return today - timedelta(days=7)
    if mode == "month":
        return today - timedelta(days=30)
    return None  # "all"


def run_biometric_sync(mode: str = "day", device_id=None) -> dict:
    """
    Run the biometric sync and return a merged summary dict.
    mode: "day" | "week" | "month" | "all"
    device_id: int (a specific Settings device), "env" (the .env-configured
               device), or "all"/None (the .env device + every enabled
               Settings device, merged).
    """
    from .biometric_sync import BiometricSyncError, get_sync_targets, pull_from_device
    from . import sync_progress
    from django.utils import timezone

    date_from = _date_from_for_mode(mode)

    try:
        targets = get_sync_targets(device_id)
    except BiometricSyncError as exc:
        return {"ok": False, "error": str(exc)}

    # Progress-tracking only (UI pipeline) -does not affect the sync itself.
    sync_progress.start(targets)

    total_created = 0
    not_found_ids: set = set()
    device_errors = []
    succeeded = 0
    suspicious_days = []

    for t in targets:
        if t.get("config_error"):
            device_errors.append(f"{t['label']}: {t['config_error']}")
            sync_progress.mark(t["label"], "failed")
            continue
        sync_progress.mark(t["label"], "syncing")
        try:
            result = pull_from_device(t["host"], t["port"], t["password"], date_from, device_label=t["label"])
            total_created += result["created"]
            not_found_ids |= result["notFound"]
            suspicious_days.extend(result.get("suspiciousDays", []))
            succeeded += 1
            if t["device"] is not None:
                t["device"].last_synced_at = timezone.now()
                t["device"].save(update_fields=["last_synced_at"])
            sync_progress.mark(t["label"], "completed")
        except BiometricSyncError as exc:
            device_errors.append(f"{t['label']}: {exc}")
            sync_progress.mark(t["label"], "failed")
        except Exception as exc:
            logger.exception("Biometric sync failed for device %s", t["label"])
            device_errors.append(f"{t['label']}: {exc}")
            sync_progress.mark(t["label"], "failed")

    sync_progress.finish()

    if succeeded == 0:
        return {"ok": False, "error": "; ".join(device_errors)}

    if suspicious_days:
        emp_ids = {d["employeeId"] for d in suspicious_days}
        names = {
            e.id: f"{e.first_name} {e.last_name}".strip()
            for e in Employee.objects.filter(id__in=emp_ids)
        }
        for d in suspicious_days:
            d["employeeName"] = names.get(d["employeeId"], "")

    return {
        "ok": True,
        "created": total_created,
        "syncedAt": datetime.utcnow().isoformat() + "Z",
        "unmatchedDeviceIds": sorted(not_found_ids),
        "deviceErrors": device_errors,
        # Days where one employee logged 6+ punches -almost always means the
        # biometric device has two different people sharing one Device User
        # ID. Employee-Code-only matching can't split them since the device
        # itself sends one identical id for both; this needs to be fixed by
        # re-enrolling the duplicate person under their own unique Device
        # User ID and remapping it in Settings → Devices.
        "suspiciousDays": suspicious_days,
    }


@api_view(["POST"])
@require_hr
def sync_biometric_api(request: Request) -> Response:
    mode = request.data.get("mode", "day")       # "day" | "week" | "month" | "all"
    device_id = request.data.get("deviceId")     # int | "env" | "all" | list[int] | None
    result = run_biometric_sync(mode, device_id)
    status_code = 200 if result["ok"] else 502
    return Response(result, status=status_code)


@api_view(["GET"])
@require_hr
def sync_biometric_progress(request: Request) -> Response:
    """Poll target for the live Start → Device → Completed sync pipeline UI."""
    from . import sync_progress
    return Response(sync_progress.snapshot())


# ── Report Log ────────────────────────────────────────────────────────────────

def _assigned_shift_json(shift) -> dict | None:
    if not shift:
        return None
    return {
        "name": shift.name,
        "startTime": shift.start_time.strftime("%H:%M") if shift.start_time else None,
        "endTime": shift.end_time.strftime("%H:%M") if shift.end_time else None,
        "gracePeriodMinutes": shift.grace_period_minutes,
    }


def _full_day_row(emp, rec, shift, dsl, cl, perm, leave=None) -> dict:
    """
    One employee's full attendance picture for one day -used by the Report
    Log page's detail view. Built entirely from data the existing engines
    already compute (AttendanceDayRecord / DailyShiftLog / Casual Leave /
    Permission / Leave); nothing here recalculates anything.
    """
    if dsl:
        punch1 = dsl.punch1.strftime("%H:%M") if dsl.punch1 else None
        punch2 = dsl.punch2.strftime("%H:%M") if dsl.punch2 else None
        punch3 = dsl.punch3.strftime("%H:%M") if dsl.punch3 else None
        punch4 = dsl.punch4.strftime("%H:%M") if dsl.punch4 else None
        late_morning = dsl.late_morning
        late_return = dsl.late_return
        late_reason = dsl.late_reason
    else:
        punch1 = rec.first_punch.strftime("%H:%M") if rec.first_punch else None
        punch2 = punch3 = None
        punch4 = rec.last_punch.strftime("%H:%M") if rec.last_punch else None
        late_morning = rec.is_late
        late_return = False
        late_reason = rec.override_note if rec.is_late else None

    return {
        "employeeId": emp.id,
        "employeeCode": emp.employee_code,
        "employeeName": f"{emp.first_name} {emp.last_name}",
        "department": emp.department.name if emp.department else None,
        "designation": emp.designation.title if emp.designation else None,
        "date": str(rec.date),
        "assignedShift": _assigned_shift_json(shift),
        "punch1": punch1, "punch2": punch2, "punch3": punch3, "punch4": punch4,
        "totalPunches": rec.total_punches,
        "status": rec.status,  # present | half_shift | absent | on_leave | holiday
        "isLate": bool(rec.is_late),
        "isHalfShift": bool(rec.is_half_shift),
        "earlyLeave": bool(rec.early_leave),
        "shiftsCompleted": str(rec.shifts_earned),
        "lateMorning": bool(late_morning),
        "lateReturn": bool(late_return),
        "lateReason": late_reason,
        "casualLeave": {"status": cl.status, "reason": cl.reason} if cl else None,
        "permission": (
            {
                "status": perm.status,
                "time": perm.permission_time.strftime("%H:%M") if perm.permission_time else None,
                "reason": perm.reason,
            }
            if perm else None
        ),
        "leave": (
            {"status": leave.status, "type": getattr(leave, "type", None), "reason": leave.reason}
            if leave else None
        ),
        "source": rec.source,
    }


def _month_summary_row(emp, summary: dict, cl_count: int, perm_count: int) -> dict:
    """
    One employee's aggregate attendance picture for a month -used by the
    Report Log page's summary view. Built entirely from
    month_summary_from_records() (attendance_final.py), the same monthly
    aggregation used elsewhere in the app -including onLeave, which is
    already correct here because compute_month_records() feeds
    compute_day_record() the real approved-leave date set for every day.
    """
    return {
        "employeeId": emp.id,
        "employeeCode": emp.employee_code,
        "employeeName": f"{emp.first_name} {emp.last_name}",
        "department": emp.department.name if emp.department else None,
        "designation": emp.designation.title if emp.designation else None,
        "totalDays": summary["totalDays"],
        "workingDays": summary["workingDays"],
        "effectiveDays": summary["effectiveDays"],
        "presentDays": summary["present"],
        "halfShiftDays": summary["halfShift"],
        "absentDays": summary["absent"],
        "onLeaveDays": summary["onLeave"],
        "casualLeaveCount": cl_count,
        "permissionCount": perm_count,
        "holidays": summary["holidays"],
        "lateCount": summary["late"],
        "totalShifts": summary["totalShifts"],
    }


@api_view(["GET"])
@require_hr
def attendance_report_log(request: Request) -> Response:
    """
    GET /api/attendance/report-log?month=7&year=2026[&department=3&search=ram]
        → summary mode: one aggregate row per active staff employee for that
          month, optionally narrowed to one department and/or an employee
          code/name search.

    GET /api/attendance/report-log?month=7&year=2026&employeeId=123
        → detail mode: one employee's full month, day by day -every punch
          slot, status, late/half-shift, Casual Leave, Permission, and Leave.

    Built on the same AttendanceDayRecord/DailyShiftLog engines used
    everywhere else (compute_day_record / compute_daily_shift_log via
    compute_month_records) -this endpoint only reads and joins their
    output for display, it does not change how anything is calculated.
    View-only: nothing here writes anything HR didn't already trigger
    elsewhere (compute_month_records persists AttendanceDayRecord as a
    side effect, same as every other page that reads attendance).
    """
    from .models import PayrollSettings, CasualLeaveRequest, EmployeePermission
    from .attendance_final import compute_month_records, month_summary_from_records
    from .shift_engine import _get_shift_for_date

    settings = PayrollSettings.get()
    month_param = request.query_params.get("month")
    year_param = request.query_params.get("year")
    emp_id_param = request.query_params.get("employeeId")
    department_param = request.query_params.get("department")
    search_param = request.query_params.get("search")
    is_strict = settings.attendance_mode != "simple"

    if not month_param or not year_param:
        return Response({"error": "Provide month and year"}, status=400)
    try:
        m = int(month_param)
        y = int(year_param)
    except (ValueError, TypeError):
        return Response({"error": "Invalid month/year"}, status=400)

    # ── Detail mode: one employee, full day-by-day month ────────────────────
    if emp_id_param:
        emp = (
            scope_to_branch(Employee.objects, request)
            .select_related("department", "designation")
            .filter(pk=emp_id_param, status="active")
            .first()
        )
        if not emp:
            return Response({"error": "Employee not found"}, status=404)

        records = compute_month_records(emp, y, m, settings)
        # Only approved CL/Permission/Leave requests are shown here -pending
        # ones aren't final yet and rejected ones didn't happen, so none of
        # the three belong on an attendance report.
        cl_map = {
            c.date: c for c in CasualLeaveRequest.objects.filter(
                employee=emp, date__year=y, date__month=m, status="approved",
            )
        }
        perm_map = {
            p.date: p for p in EmployeePermission.objects.filter(
                employee=emp, date__year=y, date__month=m, status="approved",
            )
        }
        month_start = date_type(y, m, 1)
        month_end = date_type(y, m, calendar.monthrange(y, m)[1])
        leave_map: dict = {}
        for lr in LeaveRequest.objects.filter(
            employee=emp, status="approved",
            start_date__lte=month_end.isoformat(), end_date__gte=month_start.isoformat(),
        ):
            lr_start = max(date_type.fromisoformat(str(lr.start_date)[:10]), month_start)
            lr_end = min(date_type.fromisoformat(str(lr.end_date)[:10]), month_end)
            cur = lr_start
            while cur <= lr_end:
                leave_map[cur] = lr
                cur += timedelta(days=1)

        dsl_map = {}
        if is_strict:
            dsl_map = {
                l.date: l for l in DailyShiftLog.objects.filter(
                    employee=emp, date__year=y, date__month=m,
                )
            }

        days = []
        for rec in records:
            shift = _get_shift_for_date(emp, rec.date)
            days.append(_full_day_row(
                emp, rec, shift, dsl_map.get(rec.date),
                cl_map.get(rec.date), perm_map.get(rec.date), leave_map.get(rec.date),
            ))
        return Response({
            "month": m, "year": y,
            "employee": {
                "id": emp.id,
                "code": emp.employee_code,
                "name": f"{emp.first_name} {emp.last_name}",
                "department": emp.department.name if emp.department else None,
                "designation": emp.designation.title if emp.designation else None,
            },
            "days": days,
        })

    # ── Summary mode: every matching employee, aggregate for the month ──────
    emps_qs = (
        scope_to_branch(Employee.objects, request)
        .filter(status="active", employment_type="staff")
        .select_related("department", "designation")
        .order_by("first_name")
    )
    if department_param:
        emps_qs = emps_qs.filter(department_id=department_param)
    if search_param:
        q = search_param.strip()
        emps_qs = emps_qs.filter(
            Q(employee_code__icontains=q) | Q(first_name__icontains=q) | Q(last_name__icontains=q)
        )
    emps = list(emps_qs)
    emp_ids = [e.id for e in emps]

    # Batched CL/Permission counts (one query each for every matching
    # employee) instead of a per-employee query -avoids N+1 as the employee
    # list grows.
    cl_counts: dict[int, int] = defaultdict(int)
    for row in (
        CasualLeaveRequest.objects.filter(
            employee_id__in=emp_ids, date__year=y, date__month=m, status="approved",
        ).values("employee_id").annotate(n=Count("id"))
    ):
        cl_counts[row["employee_id"]] = row["n"]

    perm_counts: dict[int, int] = defaultdict(int)
    for row in (
        EmployeePermission.objects.filter(
            employee_id__in=emp_ids, date__year=y, date__month=m, status="approved",
        ).values("employee_id").annotate(n=Count("id"))
    ):
        perm_counts[row["employee_id"]] = row["n"]

    employees = []
    for emp in emps:
        records = compute_month_records(emp, y, m, settings)
        summary = month_summary_from_records(records)
        employees.append(_month_summary_row(emp, summary, cl_counts[emp.id], perm_counts[emp.id]))

    return Response({"month": m, "year": y, "employees": employees})


@api_view(["GET"])
@require_hr
def attendance_search(request: Request) -> Response:
    """
    GET /api/attendance/search?query=<employee code or name>&date=YYYY-MM-DD
    (date defaults to today) -HR-facing lookup: find an employee by Employee
    Code or Name and see their shift plus all 4 punch slots for that day,
    each tagged with its source (Biometric, Geo Punch, On-Duty, HR Entry,
    Manual Entry). Branch-scoped, capped at 25 matches.
    """
    from .shift_engine import _get_shift_for_date

    query = (request.query_params.get("query") or "").strip()
    if not query:
        return Response({"error": "query is required"}, status=400)

    date_str = request.query_params.get("date")
    d = date_type.today()
    if date_str:
        try:
            d = datetime.fromisoformat(date_str).date()
        except ValueError:
            return Response({"error": "Invalid date format"}, status=400)

    emps = (
        scope_to_branch(Employee.objects, request)
        .select_related("department", "designation")
        .filter(
            Q(employee_code__icontains=query)
            | Q(first_name__icontains=query)
            | Q(last_name__icontains=query),
            status="active",
        )
        .order_by("employee_code")[:25]
    )

    results = []
    for emp in emps:
        logs = list(
            AttendanceLog.objects.filter(employee=emp, date=d).order_by("punch_time")
        )
        # Displayed IN/OUT alternates by time-sorted position rather than the
        # raw stored punch_type -a Geo/On-Duty punch captured before that
        # day's biometric sync catches up can end up with a stale stored
        # type once sync backfills an earlier punch (see
        # geo_attendance_views._next_punch); position-based labeling can't
        # go stale the same way, since it's derived fresh every read.
        #
        # Every punch that exists is shown here, uncapped -this is display
        # only. Shift-value calculation elsewhere still uses just the first
        # and last punch (P1/P4); showing every punch on this search page
        # doesn't change that logic at all.
        punches = [
            {
                "time": log.punch_time.strftime("%H:%M:%S"),
                "type": "IN" if i % 2 == 0 else "OUT",
                "source": log.source,
                "sourceLabel": source_label(log.source),
            }
            for i, log in enumerate(logs)
        ]
        while len(punches) < 4:
            punches.append(None)

        shift = _get_shift_for_date(emp, d)
        results.append({
            "employeeId": emp.id,
            "employeeCode": emp.employee_code,
            "employeeName": f"{emp.first_name} {emp.last_name}",
            "department": emp.department.name if emp.department_id and emp.department else None,
            "designation": emp.designation.title if emp.designation_id and emp.designation else None,
            "shift": _assigned_shift_json(shift),
            "punches": punches,
            "totalPunches": len(logs),
        })

    return Response({"date": str(d), "query": query, "count": len(results), "results": results})


@api_view(["GET"])
@require_hr
def attendance_search_range(request: Request) -> Response:
    """
    GET /api/attendance/search/range?employeeId=123&startDate=YYYY-MM-DD&endDate=YYYY-MM-DD
    One employee's full day-by-day attendance picture across an arbitrary
    date range -powers the Week/Month/Custom Range filters on the
    Attendance Search page once a specific employee has been picked from
    the query match list. Each day carries the same punch/source shape as
    attendance_search() above, plus the day's computed status/late flag
    and any approved Leave or Permission record covering that date.
    Capped at 100 days per request to keep this a bounded single-employee
    lookup rather than an unbounded report query.
    """
    from .attendance_final import compute_range_records
    from .models import CasualLeaveRequest, EmployeePermission
    from .shift_engine import _get_shift_for_date

    emp_id = request.query_params.get("employeeId")
    if not emp_id:
        return Response({"error": "employeeId is required"}, status=400)

    emp = (
        scope_to_branch(Employee.objects, request)
        .select_related("department", "designation")
        .filter(pk=emp_id, status="active")
        .first()
    )
    if not emp:
        return Response({"error": "Employee not found"}, status=404)

    start_str = request.query_params.get("startDate")
    end_str = request.query_params.get("endDate")
    try:
        date_from = date_type.fromisoformat(start_str) if start_str else _today()
        date_to = date_type.fromisoformat(end_str) if end_str else _today()
    except ValueError:
        return Response({"error": "Invalid date format"}, status=400)

    if date_from > date_to:
        date_from, date_to = date_to, date_from
    if (date_to - date_from).days > 100:
        return Response({"error": "Date range is too large -please select 100 days or fewer"}, status=400)

    records = compute_range_records(emp, date_from, date_to)

    logs = list(
        AttendanceLog.objects.filter(employee=emp, date__gte=date_from, date__lte=date_to)
        .order_by("date", "punch_time")
    )
    logs_by_date: dict = {}
    for log in logs:
        logs_by_date.setdefault(log.date, []).append(log)

    leave_map: dict = {}
    for lr in LeaveRequest.objects.filter(
        employee=emp, status="approved",
        start_date__lte=date_to.isoformat(), end_date__gte=date_from.isoformat(),
    ):
        lr_start = max(date_type.fromisoformat(str(lr.start_date)[:10]), date_from)
        lr_end = min(date_type.fromisoformat(str(lr.end_date)[:10]), date_to)
        cur = lr_start
        while cur <= lr_end:
            leave_map[cur] = lr
            cur += timedelta(days=1)

    perm_map = {
        p.date: p for p in EmployeePermission.objects.filter(
            employee=emp, date__gte=date_from, date__lte=date_to, status="approved",
        )
    }
    cl_map = {
        c.date: c for c in CasualLeaveRequest.objects.filter(
            employee=emp, date__gte=date_from, date__lte=date_to, status="approved",
        )
    }

    days = []
    for rec in records:
        day_logs = logs_by_date.get(rec.date, [])
        # See attendance_search()'s identical comment above -IN/OUT is
        # derived from time-sorted position, not the raw stored punch_type,
        # so a stale label from the cross-source ordering bug can't surface.
        # Every punch is shown, uncapped (display only -shift-value math
        # elsewhere still only uses the first and last punch).
        punches = [
            {
                "time": log.punch_time.strftime("%H:%M:%S"),
                "type": "IN" if i % 2 == 0 else "OUT",
                "source": log.source,
                "sourceLabel": source_label(log.source),
            }
            for i, log in enumerate(day_logs)
        ]
        while len(punches) < 4:
            punches.append(None)

        leave = leave_map.get(rec.date)
        perm = perm_map.get(rec.date)
        cl = cl_map.get(rec.date)
        days.append({
            "date": str(rec.date),
            "status": rec.status,
            "isLate": bool(rec.is_late),
            "isHalfShift": bool(rec.is_half_shift),
            "totalPunches": rec.total_punches,
            "punches": punches,
            "casualLeave": {"status": cl.status, "reason": cl.reason} if cl else None,
            "leave": {"status": leave.status, "type": leave.type, "reason": leave.reason} if leave else None,
            "permission": (
                {
                    "status": perm.status,
                    "time": perm.permission_time.strftime("%H:%M") if perm.permission_time else None,
                    "reason": perm.reason,
                }
                if perm else None
            ),
        })

    shift = _get_shift_for_date(emp, date_to)
    return Response({
        "employeeId": emp.id,
        "employeeCode": emp.employee_code,
        "employeeName": f"{emp.first_name} {emp.last_name}",
        "department": emp.department.name if emp.department_id and emp.department else None,
        "designation": emp.designation.title if emp.designation_id and emp.designation else None,
        "shift": _assigned_shift_json(shift),
        "startDate": str(date_from),
        "endDate": str(date_to),
        "days": days,
    })


@api_view(["POST"])
@require_hr
def compute_shift_logs(request: Request) -> Response:
    """
    POST /api/attendance/compute-shifts/
    Body: { "date": "2026-07-01" }  -recompute for all staff that day
    Body: { "month": 7, "year": 2026 }  -recompute entire month
    Body: { "month": 7, "year": 2026, "employeeId": 123 }  -one employee
    """
    from .shift_engine import compute_daily_shift_log, compute_monthly_shift_summary, recompute_date, NEW_ATTENDANCE_RULE_CUTOVER, resolve_day_punch_logs
    from .models import PayrollSettings
    from collections import defaultdict

    data = request.data
    date_param = data.get("date")
    month_param = data.get("month")
    year_param = data.get("year")
    emp_id_param = data.get("employeeId")

    if date_param:
        try:
            d = date_type.fromisoformat(str(date_param))
        except (ValueError, TypeError):
            return Response({"error": "Invalid date"}, status=400)
        count = recompute_date(d)
        return Response({"ok": True, "computed": count, "date": str(d)})

    if month_param and year_param:
        try:
            m = int(month_param)
            y = int(year_param)
        except (ValueError, TypeError):
            return Response({"error": "Invalid month/year"}, status=400)

        import calendar as cal
        days_in_month = cal.monthrange(y, m)[1]
        today_d = _today()

        emp_qs = Employee.objects.filter(status="active", employment_type="staff")
        if emp_id_param:
            emp_qs = emp_qs.filter(pk=emp_id_param)

        emps = list(emp_qs)
        total_computed = 0
        payroll_settings = PayrollSettings.get()

        # One query for the whole month (+1 day padding each side, for
        # cross-midnight punch reattribution's neighbor-day lookups) instead
        # of one per day -{employee_id: {date: [AttendanceLog, ...]}}.
        month_start = date_type(y, m, 1)
        month_end = date_type(y, m, days_in_month)
        all_logs = list(
            AttendanceLog.objects.filter(
                date__gte=month_start - timedelta(days=1),
                date__lte=month_end + timedelta(days=1),
                employee__in=emps,
            ).order_by("punch_time")
        )
        logs_by_emp: dict = defaultdict(lambda: defaultdict(list))
        for log in all_logs:
            logs_by_emp[log.employee_id][log.date].append(log)

        for day in range(1, days_in_month + 1):
            d = date_type(y, m, day)
            if d > today_d:
                break
            for emp in emps:
                emp_logs_by_date = logs_by_emp.get(emp.id, {})
                punches = resolve_day_punch_logs(
                    emp, d, emp_logs_by_date.get(d, []), payroll_settings,
                    logs_by_date=emp_logs_by_date,
                )
                compute_daily_shift_log(emp, d, punches, legacy=d < NEW_ATTENDANCE_RULE_CUTOVER)
                total_computed += 1

        # Recompute monthly summaries
        from decimal import Decimal
        for emp in emps:
            daily_rate = None
            if emp.salary_amount:
                _, dm = cal.monthrange(y, m)
                daily_rate = Decimal(str(emp.salary_amount)) / dm
            compute_monthly_shift_summary(emp, y, m, daily_rate)

        return Response({
            "ok": True,
            "computed": total_computed,
            "month": m,
            "year": y,
            "employees": len(emps),
        })

    return Response({"error": "Provide date or month+year"}, status=400)


@api_view(["GET"])
@require_hr
def attendance_late_summary(request: Request) -> Response:
    """
    GET /api/attendance/late-summary/?month=7&year=2026
    Returns monthly late summary for all staff employees.
    """
    try:
        m = int(request.query_params.get("month", _today().month))
        y = int(request.query_params.get("year", _today().year))
    except (ValueError, TypeError):
        return Response({"error": "Invalid month/year"}, status=400)

    summaries = (
        scope_to_branch(MonthlyShiftSummary.objects, request, field="employee__branch_id")
        .filter(year=y, month=m)
        .select_related("employee__department", "employee__designation")
        .order_by("employee__first_name")
    )

    # Pre-compute half-shift counts from DailyShiftLog for all employees in one query
    from decimal import Decimal as _D
    half_shift_map: dict[int, int] = {}
    for log in DailyShiftLog.objects.filter(date__year=y, date__month=m, shifts_completed=_D("0.50")).values("employee_id"):
        eid = log["employee_id"]
        half_shift_map[eid] = half_shift_map.get(eid, 0) + 1

    results = []
    for s in summaries:
        emp = s.employee
        results.append({
            "employeeId": emp.id,
            "employeeCode": emp.employee_code,
            "employeeName": f"{emp.first_name} {emp.last_name}",
            "department": emp.department.name if emp.department else None,
            "totalShifts": str(s.total_shifts),
            "halfShiftDays": half_shift_map.get(emp.id, 0),
            "totalLateCount": s.total_late_count,
            "permissionOverageCount": s.permission_overage_count,
            "permissionsUsed": s.permissions_used,
            "billableLateCount": s.billable_late_count,
            "shiftDeductions": str(s.shift_deductions),
            "salaryDeductionAmount": str(s.salary_deduction_amount),
        })

    return Response({"month": m, "year": y, "employees": results})


@api_view(["GET"])
@require_auth
def employee_shift_monthly_stats(request: Request) -> Response:
    """
    GET /api/attendance/employee-shift-stats/?employee_id=X&month=M&year=Y
    Returns detailed monthly shift stats for one employee (used by Manage Shift
    panel, and self-service by the mobile app's My Shift page).
    An employee token always gets their own stats, ignoring employee_id.
    """
    import calendar as _cal
    from collections import defaultdict as _dd
    from decimal import Decimal as _D

    token_emp_id = get_token_employee_id(request)
    if token_emp_id:
        emp_id = token_emp_id
    else:
        from .auth import is_hr
        if not is_hr(request):
            return Response({"error": "HR access required"}, status=403)
        emp_id = request.query_params.get("employee_id")
    try:
        m = int(request.query_params.get("month", _today().month))
        y = int(request.query_params.get("year", _today().year))
    except (ValueError, TypeError):
        return Response({"error": "Invalid month/year"}, status=400)

    try:
        emp = Employee.objects.select_related("department", "designation").get(pk=emp_id)
    except (Employee.DoesNotExist, TypeError, ValueError):
        return Response({"error": "Employee not found"}, status=404)

    days_in_month = _cal.monthrange(y, m)[1]
    today = _today()

    from .attendance_final import compute_month_records, month_summary_from_records

    # The exact same day-by-day engine payroll and the HR portal's
    # Attendance Search / Attendance page use -so this endpoint (mobile My
    # Shift, the Employee Web App's My Shift + Attendance pages, and HR's
    # Manage Shift panel) can never disagree with the Attendance page again.
    # Previously this view ran its own inline day loop keyed off
    # DailyShiftLog, a table that is ONLY ever written in strict attendance
    # mode -in simple mode (this deployment's mode) DailyShiftLog rows are
    # never created at all, so every count below silently computed as 0/near-
    # zero regardless of real attendance. That was the root cause of "Monthly
    # Attendance Summary" showing wrong numbers on mobile.
    day_records = {r.date: r for r in compute_month_records(emp, y, m)}

    # DailyShiftLog is still consulted per-day, purely for the granular
    # Late-Morning-vs-Late-Return split that only strict mode's 4-punch
    # engine actually computes (simple mode has no lunch-return concept at
    # all) -when it doesn't exist for a day, both fall back to the
    # canonical single is_late flag attributed to "morning".
    shift_logs: dict[date_type, object] = {
        sl.date: sl
        for sl in DailyShiftLog.objects.filter(employee=emp, date__year=y, date__month=m)
    }

    # ── Raw biometric/manual punches keyed by date string -display only ────
    punches_by_date: dict[str, list] = _dd(list)
    for log in AttendanceLog.objects.filter(
        employee=emp, date__year=y, date__month=m
    ).order_by("date", "punch_time"):
        date_key = log.date.isoformat()
        # IN/OUT alternates by time-sorted position within the day (the
        # current list length is that position, since rows arrive in
        # date/punch_time order already) rather than the raw stored
        # punch_type -see attendance_search()'s comment for why.
        position = len(punches_by_date[date_key])
        punches_by_date[date_key].append({
            "time": log.punch_time.strftime("%H:%M"),
            "type": "IN" if position % 2 == 0 else "OUT",
            "source": log.source,
            "sourceLabel": source_label(log.source),
        })

    # ── Manual attendance records -display only (notes/hours worked) ───────
    prefix = f"{y}-{str(m).zfill(2)}"
    manual_by_date = {
        str(a.date): a
        for a in Attendance.objects.filter(employee=emp, date__startswith=prefix)
    }

    # ── Leave type per date -compute_day_record only exposes status=on_leave,
    #    not which leave type, so that's still resolved separately for display.
    month_start = date_type(y, m, 1)
    month_end = date_type(y, m, days_in_month)
    leave_date_map: dict[str, str] = {}
    for lr in LeaveRequest.objects.filter(
        employee=emp, status="approved",
        start_date__lte=month_end.isoformat(),
        end_date__gte=month_start.isoformat(),
    ):
        lr_start = max(date_type.fromisoformat(str(lr.start_date)), month_start)
        lr_end = min(date_type.fromisoformat(str(lr.end_date)), month_end)
        cur = lr_start
        while cur <= lr_end:
            leave_date_map[cur.isoformat()] = getattr(lr, "type", "Leave")
            cur += timedelta(days=1)

    daily = []
    for day in range(1, days_in_month + 1):
        cur = date_type(y, m, day)
        date_str = cur.isoformat()
        is_future = cur > today

        punches = punches_by_date.get(date_str, [])
        manual = manual_by_date.get(date_str)
        rec = day_records.get(cur)

        if is_future:
            status = "future"
        elif rec is not None:
            status = rec.status
        else:
            status = "absent"

        first_in = rec.first_punch.strftime("%H:%M") if rec and rec.first_punch else (punches[0]["time"] if punches else None)
        last_out = rec.last_punch.strftime("%H:%M") if rec and rec.last_punch else (punches[-1]["time"] if len(punches) > 1 else None)
        shifts_done = rec.shifts_earned if rec else _D("0")
        is_half = bool(rec.is_half_shift) if rec else False
        is_late = bool(rec.is_late) if rec else False

        sl = shift_logs.get(cur)
        late_am = sl.late_morning if sl else is_late
        late_ret = sl.late_return if sl else False

        daily.append({
            "date": date_str,
            "day": cur.strftime("%a"),
            "status": status,
            "firstPunch": first_in,
            "lastPunch": last_out,
            "totalPunches": rec.total_punches if rec else len(punches),
            "source": (punches[0]["source"] if punches else ("manual" if manual else None)),
            "sourceLabel": (rec.primary_source if rec and rec.primary_source else None) or (source_label(punches[0]["source"]) if punches else None),
            "leaveType": leave_date_map.get(date_str),
            "shiftsCompleted": str(shifts_done) if rec else None,
            "isHalfShift": is_half,
            "isLate": is_late,
            "lateMorning": late_am,
            "lateReturn": late_ret,
        })

    summary = month_summary_from_records(list(day_records.values()))
    # "Present" here means full-shift days specifically -Half Shift is its
    # own bucket, matching the Attendance page / Attendance Search's summary
    # cards (present + halfShift kept distinct there too, not merged).
    present_days = summary["present"]
    full_shift_days = summary["present"]
    half_shift_days = summary["halfShift"]
    absent_days = summary["absent"]
    leave_days = summary["onLeave"]
    total_late = summary["late"]
    total_effective_shifts = summary["totalShifts"]
    late_morning_days = sum(1 for d in daily if d["lateMorning"])
    late_return_days = sum(1 for d in daily if d["lateReturn"])

    # ── Live permission/late-deduction preview -same formula payroll uses
    #    (payroll_views.py), computed fresh from the day loop above rather
    #    than depending on a MonthlyShiftSummary row that only exists once
    #    HR has actually run payroll for this month (previously this whole
    #    block was `None` -and silently wrong before that, since it too
    #    read from DailyShiftLog-derived late counts -until the first
    #    payroll run of the month).
    from .models import EmployeePermission
    approved_permissions = EmployeePermission.objects.filter(
        employee=emp, date__year=y, date__month=m, status="approved",
    ).count()
    total_late_for_deduction = total_late + approved_permissions
    free_permissions = 3
    permissions_used = min(total_late_for_deduction, free_permissions)
    billable_late = max(0, total_late_for_deduction - free_permissions)
    shift_deductions = _D(str(billable_late // 3)) * _D("0.25")
    permission_overage_count = max(0, approved_permissions - free_permissions)

    salary_deduction_amount = _D("0")
    if shift_deductions > 0 and emp.employment_type == "staff" and emp.salary_amount:
        from .payroll_views import _build_working_days, _d2
        from .models import Holiday
        assignment = (
            EmployeeShiftAssignment.objects.filter(employee=emp, effective_from__lte=month_end)
            .filter(Q(effective_to__isnull=True) | Q(effective_to__gte=month_start))
            .order_by("-effective_from").first()
        )
        saturday_off = bool(assignment.saturday_off) if assignment else False
        holiday_dates = set(Holiday.objects.filter(date__year=y, date__month=m).values_list("date", flat=True))
        working_days_list = _build_working_days(m, y, saturday_off, holiday_dates)
        if working_days_list:
            daily_rate = _d2(emp.salary_amount / _D(str(len(working_days_list))))
            salary_deduction_amount = _d2(shift_deductions * daily_rate)

    summary_data = {
        "totalShifts": str(total_effective_shifts),
        "totalLateCount": total_late,
        "permissionsUsed": permissions_used,
        "permissionOverageCount": permission_overage_count,
        "billableLateCount": billable_late,
        "shiftDeductions": str(shift_deductions),
        "salaryDeductionAmount": str(salary_deduction_amount),
    }

    return Response({
        "employeeId": emp.id,
        "employeeCode": emp.employee_code,
        "employeeName": f"{emp.first_name} {emp.last_name}",
        "department": emp.department.name if emp.department else None,
        "designation": emp.designation.title if emp.designation else None,
        "employmentType": emp.employment_type,
        "month": m,
        "year": y,
        "presentDays": present_days,
        "absentDays": absent_days,
        "leaveDays": leave_days,
        "halfShiftDays": half_shift_days,
        "fullShiftDays": full_shift_days,
        "totalEffectiveShifts": str(total_effective_shifts),
        "lateMorningDays": late_morning_days,
        "lateReturnDays": late_return_days,
        "totalLateCount": total_late,
        "summary": summary_data,
        "dailyLogs": daily,
    })

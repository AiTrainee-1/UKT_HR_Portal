"""
Growth & Final-Attendance API
=============================
• Employee monthly attendance search (weeks 1–5 + totals) with final records
• HR manual overrides (present/absent, late, half-shift) -become authoritative
• Promotions (designation/department history + promote action)
• Salary increments (percent-based, history, initial-salary tracking)
• ID card data + public QR verification endpoint
"""

import io
from datetime import date as date_type, datetime
from decimal import Decimal, InvalidOperation

from django.conf import settings as django_settings
from django.http import HttpResponse
from django.utils import timezone
from openpyxl import Workbook
from openpyxl.styles import Alignment, Font, PatternFill
from rest_framework.decorators import api_view
from rest_framework.request import Request
from rest_framework.response import Response

from .audit_utils import log_action
from .auth import require_hr, require_auth, get_token_employee_id, get_hr_display_name
from .user_settings import settings_for, settings_for_employee
from .branch_scope import scope_to_branch
from .clock import ist_now, ist_today
from .models import (
    AttendanceDayRecord, AttendanceOverrideRequest, Bonus, Department, Designation, Employee,
    PayrollSettings, Promotion, SalaryIncrement, SalarySlip,
)
from .attendance_final import (
    compute_month_records, compute_day_record, month_summary_from_records,
)
from .shift_engine import _get_shift_for_date


def _emp_by_code_or_id(request) -> Employee | None:
    code = (request.query_params.get("code") or request.data.get("employeeCode", "")
            if hasattr(request, "data") else request.query_params.get("code")) or ""
    emp_id = request.query_params.get("employeeId") or (
        request.data.get("employeeId") if hasattr(request, "data") else None
    )
    if emp_id:
        return scope_to_branch(Employee.objects, request).filter(id=emp_id).first()
    if code:
        return scope_to_branch(Employee.objects, request).filter(employee_code__iexact=str(code).strip()).first()
    return None


def _record_dict(r: AttendanceDayRecord) -> dict:
    return {
        "date": str(r.date),
        "day": r.date.strftime("%a"),
        "status": r.status,
        "isLate": r.is_late,
        "isHalfShift": r.is_half_shift,
        "earlyLeave": r.early_leave,
        "shiftsEarned": str(r.shifts_earned),
        "firstPunch": r.first_punch.strftime("%H:%M") if r.first_punch else None,
        "lastPunch": r.last_punch.strftime("%H:%M") if r.last_punch else None,
        "totalPunches": r.total_punches,
        "source": r.source,
        "primarySource": r.primary_source,
        "overrideBy": r.override_by,
        "overrideNote": r.override_note,
        "computedMode": r.computed_mode,
    }


# ── Employee monthly attendance (search + weekly table) ────────────────────

@api_view(["GET"])
@require_auth
def employee_monthly_attendance(request: Request) -> Response:
    token_emp_id = get_token_employee_id(request)
    if token_emp_id:
        emp = Employee.objects.filter(id=token_emp_id).select_related("department", "designation").first()
    else:
        from .auth import is_hr
        if not is_hr(request):
            return Response({"error": "HR access required"}, status=403)
        emp = _emp_by_code_or_id(request)
    if not emp:
        return Response({"error": "Employee not found"}, status=404)

    today = ist_today()
    month = int(request.query_params.get("month", today.month))
    year = int(request.query_params.get("year", today.year))

    settings = settings_for(request)
    records = compute_month_records(emp, year, month, settings)

    # Weeks: 1–7 → W1, 8–14 → W2, 15–21 → W3, 22–28 → W4, 29+ → W5
    weeks: dict[int, list] = {}
    for r in records:
        w = min(5, (r.date.day - 1) // 7 + 1)
        weeks.setdefault(w, []).append(_record_dict(r))

    # Assigned shift for a representative day this month -this, and only
    # this, is what drives late/half-shift detection for the employee.
    from calendar import monthrange
    rep_day = date_type(year, month, min(15, monthrange(year, month)[1]))
    shift = _get_shift_for_date(emp, rep_day)

    return Response({
        "employee": {
            "id": emp.id,
            "code": emp.employee_code,
            "name": f"{emp.first_name} {emp.last_name}",
            "department": emp.department.name if emp.department else None,
            "designation": emp.designation.title if emp.designation else None,
            "employmentType": emp.employment_type,
            "photoUrl": emp.photo_url,
        },
        "assignedShift": {
            "name": shift.name,
            "startTime": shift.start_time.strftime("%H:%M") if shift.start_time else None,
            "endTime": shift.end_time.strftime("%H:%M") if shift.end_time else None,
            "gracePeriodMinutes": shift.grace_period_minutes,
        } if shift else None,
        "month": month,
        "year": year,
        "attendanceMode": settings.attendance_mode,
        "weeks": [
            {"week": w, "days": weeks[w]} for w in sorted(weeks.keys())
        ],
        "summary": month_summary_from_records(records),
    })


# ── Manual override ─────────────────────────────────────────────────────────

def _parse_time(v):
    try:
        return datetime.strptime(str(v)[:5], "%H:%M").time()
    except (ValueError, TypeError):
        return None


def _resolve_override_fields(record: AttendanceDayRecord, emp: Employee, data: dict) -> dict:
    """Compute the final field values an override would apply, without saving."""
    status = data.get("status", record.status)
    if status not in ("present", "absent", "half_shift", "on_leave", "holiday"):
        raise ValueError(f"Invalid status '{status}'")

    is_late = bool(data.get("isLate", record.is_late))
    is_half = bool(data.get("isHalfShift", record.is_half_shift))

    first_punch = record.first_punch
    last_punch = record.last_punch
    if "firstPunch" in data:
        first_punch = _parse_time(data["firstPunch"]) if data["firstPunch"] else None
    if "lastPunch" in data:
        last_punch = _parse_time(data["lastPunch"]) if data["lastPunch"] else None

    if status == "half_shift":
        is_half = True
    elif status in ("absent", "on_leave", "holiday"):
        is_half = False
        is_late = False
    elif status == "present" and is_half:
        status = "half_shift"

    if status == "present":
        max_shifts = Decimal("1.50") if emp.employment_type == "production" else Decimal("1.00")
        shifts = min(Decimal(str(record.shifts_earned or 0)) or Decimal("1.00"), max_shifts)
        if shifts < Decimal("1.00"):
            shifts = Decimal("1.00")
    elif status == "half_shift":
        shifts = Decimal("0.50")
    else:
        shifts = Decimal("0")

    return {
        "status": status,
        "isLate": is_late,
        "isHalfShift": is_half,
        "firstPunch": first_punch.strftime("%H:%M") if first_punch else None,
        "lastPunch": last_punch.strftime("%H:%M") if last_punch else None,
        "shiftsEarned": str(shifts),
        "note": data.get("note") or record.override_note,
    }


def _snapshot_fields(record: AttendanceDayRecord) -> dict:
    return {
        "status": record.status,
        "isLate": record.is_late,
        "isHalfShift": record.is_half_shift,
        "firstPunch": record.first_punch.strftime("%H:%M") if record.first_punch else None,
        "lastPunch": record.last_punch.strftime("%H:%M") if record.last_punch else None,
        "shiftsEarned": str(record.shifts_earned),
        "note": record.override_note,
        "source": record.source,
    }


def apply_override_values(record: AttendanceDayRecord, values: dict, reviewer_name: str) -> AttendanceDayRecord:
    """Write resolved override values onto the record (called after approval)."""
    record.status = values["status"]
    record.is_late = values["isLate"]
    record.is_half_shift = values["isHalfShift"]
    record.first_punch = _parse_time(values["firstPunch"]) if values.get("firstPunch") else None
    record.last_punch = _parse_time(values["lastPunch"]) if values.get("lastPunch") else None
    record.shifts_earned = Decimal(str(values["shiftsEarned"]))
    record.source = "manual"
    record.override_by = reviewer_name
    record.override_note = values.get("note")
    record.save()
    return record


def _override_request_dict(req: AttendanceOverrideRequest) -> dict:
    emp = req.employee
    return {
        "id": req.id,
        "employeeId": emp.id,
        "employeeCode": emp.employee_code,
        "employeeName": f"{emp.first_name} {emp.last_name}",
        "department": emp.department.name if emp.department_id and emp.department else None,
        "date": str(req.date),
        "previousValues": req.previous_values,
        "requestedValues": req.requested_values,
        "reason": req.reason,
        "status": req.status,
        "requestedBy": req.requested_by,
        "reviewedBy": req.reviewed_by,
        "reviewComment": req.review_comment,
        "reviewedAt": req.reviewed_at.isoformat() if req.reviewed_at else None,
        "createdAt": req.created_at.isoformat() if req.created_at else None,
    }


@api_view(["POST"])
@require_hr
def attendance_day_override(request: Request) -> Response:
    """
    Body: { employeeId, date, status?, isLate?, isHalfShift?,
            firstPunch? ("HH:MM"), lastPunch? ("HH:MM"), note?, reset? }

    reset=true reverts the day to auto-computed values immediately (removes
    a prior manual override -restoring the objective computed truth does
    not require approval).

    Any other change is NOT applied directly. It creates a pending
    AttendanceOverrideRequest that a Department Head must approve before the
    AttendanceDayRecord is actually overwritten. This prevents HR from
    unilaterally editing attendance data used by payroll.
    """
    data = request.data
    emp = scope_to_branch(Employee.objects, request).filter(id=data.get("employeeId")).first()
    if not emp:
        return Response({"error": "Employee not found"}, status=404)
    try:
        d = date_type.fromisoformat(str(data.get("date")))
    except (ValueError, TypeError):
        return Response({"error": "Invalid date"}, status=400)

    hr_name = get_hr_display_name(request)

    if data.get("reset"):
        AttendanceDayRecord.objects.filter(employee=emp, date=d).delete()
        AttendanceOverrideRequest.objects.filter(
            employee=emp, date=d, status=AttendanceOverrideRequest.STATUS_PENDING
        ).update(status=AttendanceOverrideRequest.STATUS_REJECTED, review_comment="Superseded by revert to automatic")
        record = compute_day_record(emp, d)
        return Response({"ok": True, "record": _record_dict(record), "reset": True})

    record = AttendanceDayRecord.objects.filter(employee=emp, date=d).first()
    if record is None:
        record = compute_day_record(emp, d)

    try:
        resolved = _resolve_override_fields(record, emp, data)
    except ValueError as e:
        return Response({"error": str(e)}, status=400)

    # Replace any earlier pending request for the same day with this new one
    AttendanceOverrideRequest.objects.filter(
        employee=emp, date=d, status=AttendanceOverrideRequest.STATUS_PENDING
    ).update(status=AttendanceOverrideRequest.STATUS_REJECTED, review_comment="Superseded by a newer request")

    req = AttendanceOverrideRequest.objects.create(
        employee=emp,
        date=d,
        previous_values=_snapshot_fields(record),
        requested_values=resolved,
        reason=data.get("note"),
        requested_by=hr_name,
    )
    return Response({
        "ok": True,
        "pendingApproval": True,
        "request": _override_request_dict(req),
        "record": _record_dict(record),  # unchanged -for UI reference
    }, status=202)


@api_view(["GET"])
@require_hr
def attendance_override_requests(request: Request) -> Response:
    """HR-side visibility into submitted override requests and their approval status."""
    qs = AttendanceOverrideRequest.objects.select_related("employee__department")
    if emp_id := request.query_params.get("employeeId"):
        qs = qs.filter(employee_id=emp_id)
    if code := request.query_params.get("code"):
        qs = qs.filter(employee__employee_code__iexact=code.strip())
    if status_filter := request.query_params.get("status"):
        qs = qs.filter(status=status_filter)
    qs = qs.order_by("-created_at")[:200]
    return Response([_override_request_dict(r) for r in qs])


# ── Promotions ──────────────────────────────────────────────────────────────

def _promotion_dict(p: Promotion) -> dict:
    return {
        "id": p.id,
        "employeeId": p.employee_id,
        "employeeCode": p.employee.employee_code,
        "employeeName": f"{p.employee.first_name} {p.employee.last_name}",
        "previousDepartment": p.previous_department.name if p.previous_department else None,
        "previousDesignation": p.previous_designation.title if p.previous_designation else None,
        "newDepartment": p.new_department.name if p.new_department else None,
        "newDesignation": p.new_designation.title if p.new_designation else None,
        "effectiveDate": str(p.effective_date),
        "notes": p.notes,
        "promotedBy": p.promoted_by,
        "createdAt": p.created_at.isoformat() if p.created_at else None,
    }


@api_view(["GET", "POST"])
@require_hr
def promotions(request: Request) -> Response:
    if request.method == "GET":
        qs = Promotion.objects.select_related(
            "employee", "previous_department", "previous_designation",
            "new_department", "new_designation",
        )
        emp_id = request.query_params.get("employeeId")
        code = request.query_params.get("code")
        if emp_id:
            qs = qs.filter(employee_id=emp_id)
        elif code:
            qs = qs.filter(employee__employee_code__iexact=code.strip())
        return Response([_promotion_dict(p) for p in qs[:200]])

    # POST -promote: record history AND apply to the employee
    data = request.data
    emp = scope_to_branch(Employee.objects, request).filter(id=data.get("employeeId")).first()
    if not emp:
        return Response({"error": "Employee not found"}, status=404)

    new_dept = Department.objects.filter(id=data.get("newDepartmentId")).first() \
        if data.get("newDepartmentId") else emp.department
    new_desig = Designation.objects.filter(id=data.get("newDesignationId")).first() \
        if data.get("newDesignationId") else emp.designation

    if new_dept == emp.department and new_desig == emp.designation:
        return Response({"error": "No change -select a new designation or department"}, status=400)

    try:
        eff = date_type.fromisoformat(str(data.get("effectiveDate")))
    except (ValueError, TypeError):
        eff = ist_today()

    promo = Promotion.objects.create(
        employee=emp,
        previous_department=emp.department,
        previous_designation=emp.designation,
        new_department=new_dept,
        new_designation=new_desig,
        effective_date=eff,
        notes=data.get("notes"),
        promoted_by=get_hr_display_name(request),
    )
    emp.department = new_dept
    emp.designation = new_desig
    emp.save(update_fields=["department", "designation", "updated_at"])
    return Response(_promotion_dict(promo), status=201)


@api_view(["DELETE"])
@require_hr
def promotion_detail(request: Request, pk: int) -> Response:
    promo = Promotion.objects.filter(id=pk).first()
    if not promo:
        return Response({"error": "Not found"}, status=404)
    promo.delete()
    return Response({"ok": True})


# ── Salary Increments ───────────────────────────────────────────────────────

def _increment_dict(i: SalaryIncrement) -> dict:
    return {
        "id": i.id,
        "employeeId": i.employee_id,
        "employeeCode": i.employee.employee_code,
        "employeeName": f"{i.employee.first_name} {i.employee.last_name}",
        "previousSalary": float(i.previous_salary),
        "newSalary": float(i.new_salary),
        "percent": float(i.percent),
        "effectiveDate": str(i.effective_date),
        "notes": i.notes,
        "addedBy": i.added_by,
        "createdAt": i.created_at.isoformat() if i.created_at else None,
    }


@api_view(["GET"])
@require_hr
def increment_summary(request: Request) -> Response:
    """Salary picture for one employee: current, initial, total increments."""
    emp = _emp_by_code_or_id(request)
    if not emp:
        return Response({"error": "Employee not found"}, status=404)

    increments = list(
        SalaryIncrement.objects.filter(employee=emp).select_related("employee")
    )
    current = float(emp.salary_amount or 0)
    initial = float(emp.initial_salary) if emp.initial_salary is not None else (
        float(increments[-1].previous_salary) if increments else current
    )
    return Response({
        "employee": {
            "id": emp.id,
            "code": emp.employee_code,
            "name": f"{emp.first_name} {emp.last_name}",
            "department": emp.department.name if emp.department else None,
            "designation": emp.designation.title if emp.designation else None,
            "employmentType": emp.employment_type,
        },
        "currentSalary": current,
        "initialSalary": initial,
        "totalIncrementAmount": round(current - initial, 2),
        "totalIncrements": len(increments),
        "history": [_increment_dict(i) for i in increments],
    })


@api_view(["POST"])
@require_hr
def add_increment(request: Request) -> Response:
    """Body: { employeeId, percent? , amount?, effectiveDate?, notes? }"""
    data = request.data
    emp = scope_to_branch(Employee.objects, request).filter(id=data.get("employeeId")).first()
    if not emp:
        return Response({"error": "Employee not found"}, status=404)

    current = Decimal(str(emp.salary_amount or 0))
    if current <= 0:
        return Response({"error": "Employee has no base salary set"}, status=400)

    try:
        if data.get("percent") not in (None, ""):
            percent = Decimal(str(data["percent"]))
            new_salary = (current * (1 + percent / 100)).quantize(Decimal("0.01"))
        elif data.get("amount") not in (None, ""):
            amount = Decimal(str(data["amount"]))
            new_salary = (current + amount).quantize(Decimal("0.01"))
            percent = (amount / current * 100).quantize(Decimal("0.01"))
        else:
            return Response({"error": "Provide percent or amount"}, status=400)
    except (InvalidOperation, ZeroDivisionError):
        return Response({"error": "Invalid number"}, status=400)

    if new_salary <= 0:
        return Response({"error": "Resulting salary must be positive"}, status=400)

    try:
        eff = date_type.fromisoformat(str(data.get("effectiveDate")))
    except (ValueError, TypeError):
        eff = ist_today()

    # Preserve the baseline the first time an increment is added
    if emp.initial_salary is None:
        emp.initial_salary = current

    inc = SalaryIncrement.objects.create(
        employee=emp,
        previous_salary=current,
        new_salary=new_salary,
        percent=percent,
        effective_date=eff,
        notes=data.get("notes"),
        added_by=get_hr_display_name(request),
    )
    emp.salary_amount = new_salary
    emp.save(update_fields=["salary_amount", "initial_salary", "updated_at"])
    return Response(_increment_dict(inc), status=201)


@api_view(["GET"])
@require_hr
def increment_dashboard(request: Request) -> Response:
    """Company-wide increment analytics for the Increment page dashboard."""
    increments = list(
        SalaryIncrement.objects.select_related(
            "employee__department", "employee__designation"
        ).order_by("-created_at")
    )

    total_increments = len(increments)
    incremented_employee_ids = {i.employee_id for i in increments}
    total_employees_incremented = len(incremented_employee_ids)

    total_increment_amount = sum((i.new_salary - i.previous_salary) for i in increments) if increments else Decimal("0")
    avg_percent = (
        sum(i.percent for i in increments) / len(increments)
        if increments else Decimal("0")
    )

    # Department-wise stats
    dept_stats: dict[str, dict] = {}
    for i in increments:
        dept_name = i.employee.department.name if i.employee.department_id and i.employee.department else "Unassigned"
        d = dept_stats.setdefault(dept_name, {"count": 0, "totalPercent": Decimal("0"), "totalAmount": Decimal("0"), "employeeIds": set()})
        d["count"] += 1
        d["totalPercent"] += i.percent
        d["totalAmount"] += (i.new_salary - i.previous_salary)
        d["employeeIds"].add(i.employee_id)

    department_breakdown = [
        {
            "department": name,
            "incrementCount": d["count"],
            "employeeCount": len(d["employeeIds"]),
            "avgPercent": float((d["totalPercent"] / d["count"]).quantize(Decimal("0.01"))) if d["count"] else 0.0,
            "totalAmount": float(d["totalAmount"]),
        }
        for name, d in dept_stats.items()
    ]
    department_breakdown.sort(key=lambda x: x["totalAmount"], reverse=True)

    # Top increments by percentage
    top_increments = sorted(increments, key=lambda i: i.percent, reverse=True)[:5]

    return Response({
        "totalIncrements": total_increments,
        "totalEmployeesIncremented": total_employees_incremented,
        "totalIncrementAmount": float(total_increment_amount),
        "avgIncrementPercent": float(avg_percent.quantize(Decimal("0.01"))) if increments else 0.0,
        "departmentBreakdown": department_breakdown,
        "recentIncrements": [_increment_dict(i) for i in increments[:10]],
        "topIncrements": [_increment_dict(i) for i in top_increments],
    })


# ── Statutory Bonus (Payment of Bonus Act, 1965) ────────────────────────────
#
# Calculation base per employee = sum across the financial year's generated
# SalarySlip rows of min(slip.basic, bonus_wage_ceiling); bonus_amount =
# calculation_base * bonus_percent / 100, only if the employee's most recent
# in-year monthly wage is at or below bonus_eligibility_ceiling.
#
# Caveat that matters for correctness, not just performance: for STAFF
# employees, SalarySlip.basic is a genuine Basic-pay component (see
# _generate_staff_payroll). For PRODUCTION employees, _generate_production_payroll
# deliberately puts the entire period gross into `basic` (hra/allowances are
# zeroed there) -so a production employee's "basic" in this calculation is
# really their period gross, not a true Basic component. This is applied
# uniformly rather than papered over with a separate proxy formula, because
# it's the real generated payroll data this company already relies on -but
# it means production bonus figures run on a different effective definition
# of "wage" than staff ones, and that should stay visible, not hidden.

def _fy_label_for_date(d: date_type, fy_start_month: int) -> str:
    start_year = d.year if d.month >= fy_start_month else d.year - 1
    return f"{start_year}-{str(start_year + 1)[-2:]}"


def _fy_month_years(financial_year: str, fy_start_month: int) -> set[tuple[int, int]]:
    """{"2025-26", fy_start_month=4} -> {(2025,4), (2025,5), ..., (2026,3)}."""
    try:
        start_year = int(str(financial_year).split("-")[0])
    except (ValueError, AttributeError, IndexError):
        start_year = ist_today().year
    pairs = set()
    for i in range(12):
        raw = fy_start_month + i
        year = start_year + (raw - 1) // 12
        month = ((raw - 1) % 12) + 1
        pairs.add((year, month))
    return pairs


def _calculate_bonus_for_employee(emp: Employee, financial_year: str, settings: PayrollSettings) -> dict:
    fy_start_month = int(settings.bonus_fy_start_month or 4)
    month_years = _fy_month_years(financial_year, fy_start_month)

    fy_slips = sorted(
        (s for s in SalarySlip.objects.filter(employee=emp) if (s.year, s.month) in month_years),
        key=lambda s: (s.year, s.month),
    )

    ceiling = settings.bonus_wage_ceiling
    calculation_base = sum((min(s.basic, ceiling) for s in fy_slips), Decimal("0"))
    records_considered = len(fy_slips)

    if fy_slips:
        monthly_wage = fy_slips[-1].basic
    else:
        monthly_wage = emp.salary_amount or Decimal("0")

    has_data = bool(fy_slips) or bool(emp.salary_amount)
    eligible = has_data and monthly_wage <= settings.bonus_eligibility_ceiling
    bonus_amount = (
        (calculation_base * settings.bonus_percent / 100).quantize(Decimal("0.01"))
        if eligible else Decimal("0.00")
    )

    if not has_data:
        reason = "No salary or payroll data available"
    elif not eligible:
        reason = f"Monthly wage ₹{monthly_wage:,.2f} exceeds the ₹{settings.bonus_eligibility_ceiling:,.0f} eligibility ceiling"
    else:
        reason = None

    return {
        "employeeId": emp.id,
        "employeeCode": emp.employee_code,
        "employeeName": f"{emp.first_name} {emp.last_name}",
        "department": emp.department.name if emp.department else None,
        "employmentType": emp.employment_type,
        "monthlyWage": float(monthly_wage),
        "eligible": eligible,
        "reason": reason,
        "recordsConsidered": records_considered,
        "calculationBase": float(calculation_base),
        "bonusPercent": float(settings.bonus_percent),
        "bonusAmount": float(bonus_amount),
    }


def _bonus_dict(b: Bonus) -> dict:
    return {
        "id": b.id,
        "employeeId": b.employee_id,
        "employeeCode": b.employee.employee_code,
        "employeeName": f"{b.employee.first_name} {b.employee.last_name}",
        "department": b.employee.department.name if b.employee.department_id and b.employee.department else None,
        "financialYear": b.financial_year,
        "recordsConsidered": b.records_considered,
        "calculationBase": float(b.calculation_base),
        "bonusPercentApplied": float(b.bonus_percent_applied),
        "bonusAmount": float(b.bonus_amount),
        "status": b.status,
        "notes": b.notes,
        "computedBy": b.computed_by,
        "createdAt": b.created_at.isoformat() if b.created_at else None,
    }


@api_view(["GET"])
@require_hr
def bonus_calculate(request: Request) -> Response:
    """Dry-run preview -no writes. Every active branch-scoped employee,
    eligible and ineligible both, with the full calculation trail.

    Settings are resolved PER EMPLOYEE (settings_for_employee), not once for
    the requesting operator -same reasoning as payroll generation: a run
    spanning several branches must apply each branch's own bonus_percent/
    ceilings, not whichever branch (or none) the operator happens to be on.
    """
    default_settings = settings_for(request)
    fy = request.query_params.get("financialYear") or _fy_label_for_date(
        ist_today(), int(default_settings.bonus_fy_start_month or 4)
    )

    employees = scope_to_branch(Employee.objects, request).filter(status="active").select_related("department")
    rows = [_calculate_bonus_for_employee(emp, fy, settings_for_employee(emp)) for emp in employees]

    eligible_rows = [r for r in rows if r["eligible"]]
    total_bonus = sum((Decimal(str(r["bonusAmount"])) for r in eligible_rows), Decimal("0"))
    return Response({
        "financialYear": fy,
        "results": rows,
        "totalEmployees": len(rows),
        "totalEligible": len(eligible_rows),
        "totalBonusAmount": float(total_bonus),
        "avgBonusAmount": float((total_bonus / len(eligible_rows)).quantize(Decimal("0.01"))) if eligible_rows else 0.0,
    })


@api_view(["POST"])
@require_hr
def bonus_generate(request: Request) -> Response:
    """Body: { financialYear }. Persists a Bonus row per ELIGIBLE employee
    -re-running for the same FY updates existing rows (unique_together on
    employee+financial_year) rather than duplicating. Settings resolved per
    employee's own branch, same reasoning as bonus_calculate above."""
    fy = (request.data.get("financialYear") or "").strip()
    if not fy:
        return Response({"error": "financialYear is required"}, status=400)

    employees = scope_to_branch(Employee.objects, request).filter(status="active").select_related("department")
    computed_by = get_hr_display_name(request)
    created = 0
    for emp in employees:
        emp_settings = settings_for_employee(emp)
        result = _calculate_bonus_for_employee(emp, fy, emp_settings)
        if not result["eligible"]:
            continue
        Bonus.objects.update_or_create(
            employee=emp, financial_year=fy,
            defaults={
                "records_considered": result["recordsConsidered"],
                "calculation_base": Decimal(str(result["calculationBase"])),
                "bonus_percent_applied": emp_settings.bonus_percent,
                "bonus_amount": Decimal(str(result["bonusAmount"])),
                "computed_by": computed_by,
            },
        )
        created += 1

    log_action(request, "create", "bonus", description=f"Generated bonus register for FY {fy} -{created} eligible employee(s)")
    return Response({"financialYear": fy, "generated": created})


@api_view(["GET"])
@require_hr
def bonus_list(request: Request) -> Response:
    qs = scope_to_branch(
        Bonus.objects.select_related("employee", "employee__department"),
        request, field="employee__branch_id",
    )
    fy = request.query_params.get("financialYear")
    if fy:
        qs = qs.filter(financial_year=fy)
    status_filter = request.query_params.get("status")
    if status_filter:
        qs = qs.filter(status=status_filter)
    dept_id = request.query_params.get("departmentId")
    if dept_id:
        qs = qs.filter(employee__department_id=dept_id)
    return Response({"results": [_bonus_dict(b) for b in qs]})


@api_view(["PATCH"])
@require_hr
def bonus_detail(request: Request, pk: int) -> Response:
    b = scope_to_branch(Bonus.objects, request, field="employee__branch_id").filter(pk=pk).first()
    if not b:
        return Response({"error": "Bonus record not found"}, status=404)
    data = request.data
    if "status" in data and data["status"] in dict(Bonus.STATUS_CHOICES):
        b.status = data["status"]
    if "notes" in data:
        b.notes = data["notes"]
    b.save(update_fields=["status", "notes"])
    return Response(_bonus_dict(b))


@api_view(["GET"])
@require_hr
def bonus_export(request: Request) -> HttpResponse:
    qs = scope_to_branch(
        Bonus.objects.select_related("employee", "employee__department"),
        request, field="employee__branch_id",
    )
    fy = request.query_params.get("financialYear")
    if fy:
        qs = qs.filter(financial_year=fy)
    rows = list(qs.order_by("employee__employee_code"))

    wb = Workbook()
    ws = wb.active
    ws.title = "Bonus Register"[:31]

    headers = [
        "Employee Code", "Name", "Department", "Financial Year",
        "Records Considered", "Calculation Base", "Bonus %", "Bonus Amount", "Status",
    ]
    ws.append(headers)
    header_fill = PatternFill("solid", fgColor="006496")
    for cell in ws[1]:
        cell.font = Font(bold=True, color="FFFFFF")
        cell.fill = header_fill
        cell.alignment = Alignment(horizontal="left", vertical="center")

    for b in rows:
        ws.append([
            str(b.employee.employee_code or ""),
            f"{b.employee.first_name} {b.employee.last_name}".strip(),
            b.employee.department.name if b.employee.department_id and b.employee.department else "",
            b.financial_year,
            b.records_considered,
            float(b.calculation_base),
            float(b.bonus_percent_applied),
            float(b.bonus_amount),
            b.status,
        ])

    for col, width in zip("ABCDEFGHI", (16, 26, 20, 14, 16, 16, 10, 14, 12)):
        ws.column_dimensions[col].width = width
    ws.freeze_panes = "A2"

    buf = io.BytesIO()
    wb.save(buf)
    buf.seek(0)

    filename = f"bonus-register-{fy or 'all'}-{timezone.localdate().isoformat()}.xlsx"
    response = HttpResponse(
        buf.read(),
        content_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    )
    response["Content-Disposition"] = f'attachment; filename="{filename}"'
    log_action(request, "export", "bonus", description=f"Exported bonus register for FY {fy or 'all'} ({len(rows)} record(s))")
    return response


# ── ID Card data + QR verification ─────────────────────────────────────────

def _idcard_dict(emp: Employee, settings: PayrollSettings) -> dict:
    from .models import IdCardSettings
    tmpl = IdCardSettings.get()
    return {
        "id": emp.id,
        "code": emp.employee_code,
        "name": f"{emp.first_name} {emp.last_name}",
        "designation": emp.designation.title if emp.designation else None,
        "department": emp.department.name if emp.department else None,
        "branchName": emp.branch.name if emp.branch_id and emp.branch else None,
        "branchCode": emp.branch.code if emp.branch_id and emp.branch else None,
        "unitCode": emp.unit_code,
        "employmentType": emp.employment_type,
        "photoUrl": emp.photo_url,
        "bloodGroup": emp.blood_group,
        "dateOfBirth": str(emp.date_of_birth) if emp.date_of_birth else None,
        "emergencyContact": emp.emergency_contact,
        "address": emp.address,
        "phone": emp.phone,
        "email": emp.email,
        "joinDate": emp.join_date,
        "status": emp.status,
        "company": {
            "name": settings.company_name or settings.slip_company_name,
            "address": settings.company_address or settings.slip_company_address,
            "logo": settings.company_logo,
            "signature": settings.authorized_signature or settings.signature_image,
        },
        "template": {
            "primaryColor": tmpl.primary_color,
            "secondaryColor": tmpl.secondary_color,
            "textColor": tmpl.text_color,
            "fontFamily": tmpl.font_family,
            "backgroundStyle": tmpl.background_style,
            "logoPosition": tmpl.logo_position,
            "cornerStyle": tmpl.corner_style,
            "showQrOnBack": tmpl.show_qr_on_back,
            "footerText": tmpl.footer_text,
        },
    }


@api_view(["GET"])
@require_auth
def idcard_data(request: Request) -> Response:
    """
    ID card payload for one employee (?employeeId= / ?code=) or many (?ids=1,2,3).
    An employee token only ever gets their own card, regardless of query params —
    bulk (?ids=) and lookup-by-other-employee are HR only.
    """
    settings = settings_for(request)
    token_emp_id = get_token_employee_id(request)
    if token_emp_id:
        emp = Employee.objects.filter(id=token_emp_id).select_related("department", "designation", "branch").first()
        if not emp:
            return Response({"error": "Employee not found"}, status=404)
        return Response(_idcard_dict(emp, settings))

    from .auth import is_hr
    if not is_hr(request):
        return Response({"error": "HR access required"}, status=403)

    ids = request.query_params.get("ids")
    if ids:
        id_list = [int(x) for x in ids.split(",") if x.strip().isdigit()]
        emps = scope_to_branch(Employee.objects, request).filter(
            id__in=id_list
        ).select_related("department", "designation", "branch")
        return Response([_idcard_dict(e, settings) for e in emps])
    emp = _emp_by_code_or_id(request)
    if not emp:
        return Response({"error": "Employee not found"}, status=404)
    return Response(_idcard_dict(emp, settings))


@api_view(["GET"])
def verify_employee(request: Request, code: str) -> Response:
    """PUBLIC endpoint hit by the QR code -no auth required."""
    emp = (
        Employee.objects.filter(employee_code__iexact=code.strip())
        .select_related("department", "designation")
        .first()
    )
    settings = settings_for(request)
    if not emp:
        return Response({
            "verified": False,
            "company": {"name": settings.slip_company_name, "logo": settings.company_logo},
        }, status=404)
    return Response({
        "verified": emp.status == "active",
        "status": emp.status,
        "employee": {
            "code": emp.employee_code,
            "name": f"{emp.first_name} {emp.last_name}",
            "designation": emp.designation.title if emp.designation else None,
            "department": emp.department.name if emp.department else None,
            "employmentType": emp.employment_type,
            "photoUrl": emp.photo_url,
            "bloodGroup": emp.blood_group,
            "joinDate": emp.join_date,
        },
        "company": {
            "name": settings.slip_company_name,
            "address": settings.slip_company_address,
            "logo": settings.company_logo,
        },
    })


def _public_base_url(request: Request) -> str:
    """Public origin for the QR verification link -this has to be the
    FRONTEND's origin, since /verify/:code (App.tsx) is a frontend route,
    not a Django one.

    On a cloud deployment (Railway backend + Vercel frontend) those are two
    different domains, so settings.FRONTEND_URL is used when set. On-premise,
    where Nginx serves both frontend and /api under one hostname, FRONTEND_URL
    is left unset and the request's own host is correct, exactly as before.
    Without this fallback, a cloud deploy would silently bake a QR code that
    points at the API server with a path Django doesn't serve, 404-ing on
    every card printed since the domains were split -not on every scan
    failing loudly, since nothing here raises; it just silently encodes the
    wrong URL onto every card.
    """
    if django_settings.FRONTEND_URL:
        return django_settings.FRONTEND_URL
    return request.build_absolute_uri("/").rstrip("/")


@api_view(["POST"])
@require_hr
def email_idcard(request: Request) -> Response:
    """Send an employee's ID card by email, with a real backend-rendered
    image attached (idcard_render.py) -previously this only attached
    anything if the frontend passed a client-rendered `image`, which it
    never actually did, so ID card emails silently had no attachment."""
    import smtplib
    from email.mime.image import MIMEImage
    from email.mime.multipart import MIMEMultipart
    from email.mime.text import MIMEText

    from .idcard_render import render_idcard_png

    data = request.data
    emp = scope_to_branch(Employee.objects, request).filter(
        id=data.get("employeeId")
    ).select_related("department", "designation", "branch").first()
    if not emp:
        return Response({"error": "Employee not found"}, status=404)
    to_email = data.get("toEmail") or emp.email
    if not to_email:
        return Response({"error": "Employee has no email address"}, status=400)

    s = settings_for(request)
    if not (s.smtp_username and s.smtp_password):
        return Response({"error": "SMTP is not configured in Settings"}, status=400)

    msg = MIMEMultipart()
    msg["Subject"] = f"Your Employee ID Card -{s.slip_company_name}"
    msg["From"] = f"{s.smtp_from_name} <{s.smtp_from_email or s.smtp_username}>"
    msg["To"] = to_email
    msg.attach(MIMEText(
        f"<p>Dear {emp.first_name},</p>"
        f"<p>Please find your employee ID card attached.</p>"
        f"<p>Regards,<br>{s.smtp_from_name}</p>",
        "html",
    ))

    idcard = _idcard_dict(emp, s)
    verify_url = f"{_public_base_url(request)}/verify/{emp.employee_code}"
    png_bytes = render_idcard_png(idcard, verify_url)
    part = MIMEImage(png_bytes, _subtype="png")
    part.add_header("Content-Disposition", "attachment", filename=f"idcard-{emp.employee_code}.png")
    msg.attach(part)

    try:
        with smtplib.SMTP(s.smtp_host, s.smtp_port, timeout=20) as server:
            server.starttls()
            server.login(s.smtp_username, s.smtp_password)
            server.send_message(msg)
    except Exception as e:  # noqa: BLE001 -report SMTP failure to the UI
        return Response({"error": f"Email failed: {e}"}, status=502)

    return Response({"ok": True, "sentTo": to_email})


@api_view(["POST"])
@require_hr
def idcard_whatsapp(request: Request) -> Response:
    """Send an employee's ID card via WhatsApp. Body: { employeeId }"""
    from . import whatsapp_service
    from .idcard_render import render_idcard_png

    if not whatsapp_service.is_configured():
        return Response({"error": "WhatsApp is not configured on this server (missing credentials in .env)."}, status=400)

    emp = scope_to_branch(Employee.objects, request).filter(
        id=request.data.get("employeeId")
    ).select_related("department", "designation", "branch").first()
    if not emp:
        return Response({"error": "Employee not found"}, status=404)

    s = settings_for(request)
    idcard = _idcard_dict(emp, s)
    verify_url = f"{_public_base_url(request)}/verify/{emp.employee_code}"
    png_bytes = render_idcard_png(idcard, verify_url)

    log = whatsapp_service.send_document(
        emp, "id_card", png_bytes, f"idcard-{emp.employee_code}.png",
        body_params=[idcard["name"]], mime_type="image/png",
        document_ref_id=emp.id, sent_by_id=request.jwt_user.get("hrUserId"),
    )
    if log.status != "sent":
        return Response({"error": log.error_message}, status=400)
    return Response({"ok": True, "sentTo": log.phone_number})

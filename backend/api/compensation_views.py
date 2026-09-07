"""Compensation -read-only CTC breakdown per employee.

Purely a display/reporting feature: computes Basic/HRA/Allowances/Employer
PF/Employer ESI/Annual CTC live from each employee's own salary_amount and
the configurable basic_percent/hra_percent settings (Settings -> Payroll).
Deliberately does NOT touch, read from, or feed back into the actual payroll
generation engine (_generate_staff_payroll/_generate_production_payroll in
payroll_views.py), which keeps its own separate, hardcoded 50/20 split
exactly as it already was -this page can be reconfigured freely without
changing a single real payroll number.
"""
from datetime import date as date_type, time as time_type
from decimal import Decimal
from functools import wraps

from rest_framework.decorators import api_view
from rest_framework.request import Request
from rest_framework.response import Response

from .auth import require_hr, get_hr_display_name
from .audit_utils import log_action
from .branch_scope import scope_to_branch
from .models import (
    CompensationDayAnnouncement, CompensationLeaveCredit, Employee,
    OvertimeRecord, PayrollSettings, SalarySlip,
)
from .user_settings import settings_for_employee


def require_compensation_enabled(view_func):
    """
    Single choke point for the Compensation feature's master switch
    (PayrollSettings.compensation_feature_enabled) -every endpoint in this
    module goes through it, so turning the feature off in Settings genuinely
    disables CTC Breakdown, OT Detection, Compensation Leave, and History &
    Reports everywhere at once, not just hides the sidebar entry. Mirrors
    night_shift.py's get_relaxation_for, which was fixed the same way after
    its own toggle was found to only hide a page while calculations kept
    running regardless.
    """
    @wraps(view_func)
    def wrapper(request, *args, **kwargs):
        if not PayrollSettings.get().compensation_feature_enabled:
            return Response({"error": "The Compensation feature is currently disabled in Settings."}, status=403)
        return view_func(request, *args, **kwargs)
    return wrapper


def _d2(value) -> Decimal:
    return Decimal(str(value)).quantize(Decimal("0.01"))


def _compensation_dict(emp: Employee) -> dict:
    settings = settings_for_employee(emp)
    salary = emp.salary_amount or Decimal("0")

    basic = _d2(salary * settings.basic_percent / 100)
    hra = _d2(salary * settings.hra_percent / 100)
    allowances = _d2(salary - basic - hra)

    is_production = emp.employment_type == Employee.EMPLOYMENT_TYPE_PRODUCTION
    pf_rate = settings.prod_pf_rate if is_production else settings.pf_rate
    esi_rate = settings.prod_esi_rate if is_production else settings.esi_rate
    esi_ceiling = settings.prod_esi_applicable_below if is_production else settings.esi_applicable_below

    employer_pf = _d2(basic * pf_rate / 100) if pf_rate else Decimal("0.00")
    employer_esi = _d2(salary * esi_rate / 100) if esi_rate and salary <= esi_ceiling else Decimal("0.00")

    gross_monthly = _d2(salary)
    annual_ctc = _d2((gross_monthly + employer_pf + employer_esi) * 12)

    return {
        "employeeId": emp.id,
        "employeeCode": emp.employee_code,
        "employeeName": f"{emp.first_name} {emp.last_name}",
        "department": emp.department.name if emp.department else None,
        "designation": emp.designation.title if emp.designation else None,
        "branch": emp.branch.name if emp.branch else None,
        "employmentType": emp.employment_type,
        "basic": float(basic),
        "hra": float(hra),
        "allowances": float(allowances),
        "employerPf": float(employer_pf),
        "employerEsi": float(employer_esi),
        "grossMonthly": float(gross_monthly),
        "annualCtc": float(annual_ctc),
    }


@api_view(["GET"])
@require_hr
@require_compensation_enabled
def compensation_list(request: Request) -> Response:
    qs = scope_to_branch(
        Employee.objects.select_related("department", "designation", "branch"), request
    ).filter(status=request.query_params.get("status") or "active")

    dept_id = request.query_params.get("departmentId")
    if dept_id:
        qs = qs.filter(department_id=dept_id)
    branch_id = request.query_params.get("branchId")
    if branch_id:
        qs = qs.filter(branch_id=branch_id)
    employment_type = request.query_params.get("employmentType")
    if employment_type:
        qs = qs.filter(employment_type=employment_type)
    search = (request.query_params.get("search") or "").strip()
    if search:
        from django.db.models import Q
        qs = qs.filter(
            Q(first_name__icontains=search) | Q(last_name__icontains=search) | Q(employee_code__icontains=search)
        )

    rows = [_compensation_dict(emp) for emp in qs.order_by("employee_code")]
    return Response({"results": rows, "count": len(rows)})


# ──────────────────────────────────────────────
#  OT (Overtime) detection + HR announce/reject
# ──────────────────────────────────────────────

def _ot_dict(r: OvertimeRecord) -> dict:
    emp = r.employee
    return {
        "id": r.id,
        "employeeId": emp.id,
        "employeeCode": emp.employee_code,
        "employeeName": f"{emp.first_name} {emp.last_name}",
        "department": emp.department.name if emp.department else None,
        "date": str(r.date),
        "shiftEndTime": r.shift_end_time.strftime("%H:%M") if r.shift_end_time else None,
        "lastPunchOut": r.last_punch_out.strftime("%H:%M") if r.last_punch_out else None,
        "otMinutes": r.ot_minutes,
        "status": r.status,
        "compensationType": r.compensation_type,
        "announcedBy": r.announced_by,
        "announcedAt": r.announced_at.isoformat() if r.announced_at else None,
    }


@api_view(["GET"])
@require_hr
@require_compensation_enabled
def overtime_list(request: Request) -> Response:
    """Runs detection fresh (cheap, idempotent upsert -see overtime.py), then
    returns the month's records, optionally filtered by status."""
    from .overtime import detect_overtime_for_month

    today = date_type.today()
    year = int(request.query_params.get("year") or today.year)
    month = int(request.query_params.get("month") or today.month)
    settings = PayrollSettings.get()

    records = detect_overtime_for_month(year, month, settings=settings)
    emp_ids = scope_to_branch(Employee.objects, request).values_list("id", flat=True)
    records = [r for r in records if r.employee_id in set(emp_ids)]

    status = request.query_params.get("status")
    if status:
        records = [r for r in records if r.status == status]

    return Response({
        "results": [_ot_dict(r) for r in records],
        "count": len(records),
        "settings": {
            "otDetectionEnabled": settings.ot_detection_enabled,
            "otThresholdMinutes": settings.ot_threshold_minutes,
            "otCompensationType": settings.ot_compensation_type,
        },
    })


@api_view(["POST"])
@require_hr
@require_compensation_enabled
def overtime_announce(request: Request) -> Response:
    """Body: {records: [{employeeId, date}], compensationType?}. Confirms
    Pay or Relaxation for each detected record -nothing is paid/credited
    until this runs. compensationType defaults to the live Settings value;
    HR may override it for this batch."""
    data = request.data
    items = data.get("records") or []
    if not items:
        return Response({"error": "No records specified"}, status=400)

    settings = PayrollSettings.get()
    comp_type = data.get("compensationType") or settings.ot_compensation_type
    if comp_type not in (OvertimeRecord.TYPE_PAY, OvertimeRecord.TYPE_RELAXATION):
        return Response({"error": "compensationType must be 'pay' or 'relaxation'"}, status=400)

    actor = get_hr_display_name(request)
    from django.utils import timezone
    announced = []
    for item in items:
        try:
            rec = OvertimeRecord.objects.select_related("employee").get(
                employee_id=item.get("employeeId"), date=item.get("date"),
                status=OvertimeRecord.STATUS_DETECTED,
            )
        except OvertimeRecord.DoesNotExist:
            continue
        rec.status = OvertimeRecord.STATUS_ANNOUNCED
        rec.compensation_type = comp_type
        rec.announced_by = actor
        rec.announced_at = timezone.now()
        rec.save()
        if comp_type == OvertimeRecord.TYPE_RELAXATION:
            CompensationLeaveCredit.objects.create(employee=rec.employee, source_overtime_record=rec)
        announced.append(rec)

    log_action(
        request, "announce", "compensation",
        description=f"Announced {len(announced)} OT record(s) as {comp_type}",
    )
    return Response({"announced": len(announced), "results": [_ot_dict(r) for r in announced]})


@api_view(["POST"])
@require_hr
@require_compensation_enabled
def overtime_reject(request: Request) -> Response:
    """Body: {records: [{employeeId, date}]}. Dismisses a detected record
    (e.g. an HR-authorized late stay that isn't real OT) -no further action."""
    items = request.data.get("records") or []
    count = 0
    for item in items:
        updated = OvertimeRecord.objects.filter(
            employee_id=item.get("employeeId"), date=item.get("date"),
            status=OvertimeRecord.STATUS_DETECTED,
        ).update(status=OvertimeRecord.STATUS_REJECTED)
        count += updated
    log_action(request, "reject", "compensation", description=f"Rejected {count} OT record(s)")
    return Response({"rejected": count})


# ──────────────────────────────────────────────
#  Relaxation/Alternative-Day credits
# ──────────────────────────────────────────────

def _credit_dict(c: CompensationLeaveCredit) -> dict:
    emp = c.employee
    return {
        "id": c.id,
        "employeeId": emp.id,
        "employeeCode": emp.employee_code,
        "employeeName": f"{emp.first_name} {emp.last_name}",
        "status": c.status,
        "usedDate": str(c.used_date) if c.used_date else None,
        "sourceDate": str(c.source_overtime_record.date) if c.source_overtime_record else None,
        "createdAt": c.created_at.isoformat() if c.created_at else None,
    }


@api_view(["GET"])
@require_hr
@require_compensation_enabled
def compensation_credits_list(request: Request) -> Response:
    emp_ids = scope_to_branch(Employee.objects, request).values_list("id", flat=True)
    qs = CompensationLeaveCredit.objects.select_related("employee", "source_overtime_record").filter(
        employee_id__in=emp_ids,
    )
    status = request.query_params.get("status")
    if status:
        qs = qs.filter(status=status)
    emp_id = request.query_params.get("employeeId")
    if emp_id:
        qs = qs.filter(employee_id=emp_id)
    rows = [_credit_dict(c) for c in qs.order_by("-created_at")]
    return Response({"results": rows, "count": len(rows)})


@api_view(["POST"])
@require_hr
@require_compensation_enabled
def compensation_credit_redeem(request: Request, pk: int) -> Response:
    """Body: {date}. HR redeems an available credit on the employee's behalf
    (per the requirement that employees cannot self-assign compensation) -
    writes that date's attendance as a paid day off, same pattern as
    casual_leave_views._write_attendance_for_cl."""
    from .attendance_final import compute_day_record
    from .models import AttendanceDayRecord

    credit = CompensationLeaveCredit.objects.select_related("employee").filter(
        pk=pk, status=CompensationLeaveCredit.STATUS_AVAILABLE,
    ).first()
    if not credit:
        return Response({"error": "Credit not found or already used"}, status=404)

    redeem_date_str = request.data.get("date")
    if not redeem_date_str:
        return Response({"error": "date is required"}, status=400)
    redeem_date = date_type.fromisoformat(redeem_date_str)

    record = AttendanceDayRecord.objects.filter(employee=credit.employee, date=redeem_date).first()
    if record is None:
        record = compute_day_record(credit.employee, redeem_date)

    actor = get_hr_display_name(request)
    record.status = "present"
    record.shifts_earned = Decimal("1.00")
    record.is_late = False
    record.is_half_shift = False
    record.override_note = "Compensation Alternative Day (paid) -redeemed"
    record.source = "manual"
    record.override_by = actor
    record.save()

    credit.status = CompensationLeaveCredit.STATUS_USED
    credit.used_date = redeem_date
    credit.save()

    log_action(
        request, "redeem", "compensation", record_id=credit.id,
        description=f"Redeemed Alternative Day for {credit.employee.employee_code} on {redeem_date}",
    )
    return Response(_credit_dict(credit))


# ──────────────────────────────────────────────
#  Compensation-Leave (HR-announced day, real punches still decide Full/Half)
# ──────────────────────────────────────────────

def _leave_day_dict(a: CompensationDayAnnouncement) -> dict:
    return {
        "id": a.id,
        "date": str(a.date),
        "leaveUntilTime": a.leave_until_time.strftime("%H:%M") if a.leave_until_time else None,
        "branch": a.branch.name if a.branch else None,
        "department": a.department.name if a.department else None,
        "employeeIds": list(a.employees.values_list("id", flat=True)),
        "employeeCount": a.employees.count(),
        "reason": a.reason,
        "announcedBy": a.announced_by,
        "createdAt": a.created_at.isoformat() if a.created_at else None,
    }


@api_view(["GET", "POST"])
@require_hr
@require_compensation_enabled
def compensation_leave_days(request: Request) -> Response:
    if request.method == "GET":
        qs = CompensationDayAnnouncement.objects.select_related("branch", "department").prefetch_related("employees")
        year = request.query_params.get("year")
        month = request.query_params.get("month")
        if year:
            qs = qs.filter(date__year=year)
        if month:
            qs = qs.filter(date__month=month)
        rows = [_leave_day_dict(a) for a in qs.order_by("-date")]
        return Response({"results": rows, "count": len(rows)})

    data = request.data
    date_str = data.get("date")
    if not date_str:
        return Response({"error": "date is required"}, status=400)

    leave_until_raw = data.get("leaveUntilTime") or None
    leave_until_time = time_type.fromisoformat(leave_until_raw) if leave_until_raw else None

    ann = CompensationDayAnnouncement.objects.create(
        date=date_type.fromisoformat(date_str),
        leave_until_time=leave_until_time,
        branch_id=data.get("branchId") or None,
        department_id=data.get("departmentId") or None,
        reason=data.get("reason") or None,
        announced_by=get_hr_display_name(request),
    )
    employee_ids = data.get("employeeIds") or []
    if employee_ids:
        ann.employees.set(employee_ids)

    log_action(
        request, "create", "compensation", record_id=ann.id,
        description=f"Announced Compensation Day for {ann.date}",
    )
    return Response(_leave_day_dict(ann), status=201)


@api_view(["DELETE"])
@require_hr
@require_compensation_enabled
def compensation_leave_day_detail(request: Request, pk: int) -> Response:
    ann = CompensationDayAnnouncement.objects.filter(pk=pk).first()
    if not ann:
        return Response({"error": "Not found"}, status=404)
    if ann.date <= date_type.today():
        return Response({"error": "Cannot delete a past or today's announcement"}, status=400)
    ann.delete()
    log_action(request, "delete", "compensation", record_id=pk, description="Removed Compensation Day announcement")
    return Response(status=204)


# ──────────────────────────────────────────────
#  Cost + benefit/non-benefit summary (History & Reports)
# ──────────────────────────────────────────────

def _compensation_summary_data(emp_ids: set[int], month: int, year: int) -> dict:
    """
    Cost + benefit/non-benefit breakdown for one month. Pulled out of the
    view so it can be unit-tested directly without an authenticated request
    (see tests_zone_boundary.py).

    `paidCost` is the real, exact sum of OT amounts already reflected in
    generated SalarySlips this month -authoritative, whatever payroll
    actually paid. `pendingCostEstimate` is a labeled ESTIMATE
    (salary_amount / 30 per announced-but-unpaid day) for planning only -it
    is not the exact figure the next payroll run will produce, since that
    depends on the period's real working-day calendar
    (_build_working_days/_generate_staff_payroll).

    "Benefiting" = Pay already paid in a generated slip, or a Relaxation
    credit already redeemed. "Not benefiting" = announced but not yet
    realized (awaiting payroll, or an unredeemed credit).
    """
    ot_records = list(
        OvertimeRecord.objects.filter(
            employee_id__in=emp_ids, date__year=year, date__month=month,
            status=OvertimeRecord.STATUS_ANNOUNCED,
        ).select_related("employee").order_by("date")
    )
    slips_by_emp = {
        s.employee_id: s
        for s in SalarySlip.objects.filter(employee_id__in=emp_ids, year=year, month=month, week_number=None)
    }
    credits_by_record = {
        c.source_overtime_record_id: c
        for c in CompensationLeaveCredit.objects.filter(source_overtime_record__in=ot_records)
    }

    paid_cost = Decimal("0")
    pending_cost = Decimal("0")
    paid_employee_ids: set[int] = set()
    benefiting = []
    not_benefiting = []

    for rec in ot_records:
        emp = rec.employee
        row = {
            "employeeId": emp.id, "employeeCode": emp.employee_code,
            "employeeName": f"{emp.first_name} {emp.last_name}",
            "type": rec.compensation_type, "date": str(rec.date),
        }
        if rec.compensation_type == OvertimeRecord.TYPE_PAY:
            slip = slips_by_emp.get(emp.id)
            if slip and slip.ot_amount and slip.ot_amount > 0:
                if emp.id not in paid_employee_ids:
                    paid_cost += slip.ot_amount
                    paid_employee_ids.add(emp.id)
                benefiting.append({**row, "detail": f"Paid {float(slip.ot_amount)} in {month}/{year} payroll"})
            else:
                daily_estimate = _d2((emp.salary_amount or Decimal("0")) / Decimal("30"))
                pending_cost += daily_estimate
                not_benefiting.append({**row, "detail": "Awaiting next payroll run"})
        elif rec.compensation_type == OvertimeRecord.TYPE_RELAXATION:
            credit = credits_by_record.get(rec.id)
            if credit and credit.status == CompensationLeaveCredit.STATUS_USED:
                benefiting.append({**row, "detail": f"Alternative Day taken on {credit.used_date}"})
            else:
                not_benefiting.append({**row, "detail": "Credit not yet redeemed"})

    return {
        "month": month, "year": year,
        "paidCost": float(_d2(paid_cost)),
        "pendingCostEstimate": float(_d2(pending_cost)),
        "benefiting": benefiting,
        "notBenefiting": not_benefiting,
    }


@api_view(["GET"])
@require_hr
@require_compensation_enabled
def compensation_summary(request: Request) -> Response:
    today = date_type.today()
    year = int(request.query_params.get("year") or today.year)
    month = int(request.query_params.get("month") or today.month)
    emp_ids = set(scope_to_branch(Employee.objects, request).values_list("id", flat=True))
    return Response(_compensation_summary_data(emp_ids, month, year))

"""
Casual Leave (CL) Module
========================
Paid leave, staff-only, one per calendar month, eligibility after 6 months of
service. Fully independent of LeaveRequest / permissions — its own table and
its own approval flow (HR directly, or Department Head from the mobile app,
configurable per-manager in User Management via can_approve_casual_leave).

Attendance integration:
  approved → AttendanceDayRecord for that date = Present, 1.00 shift (paid)
  rejected → AttendanceDayRecord for that date = Leave
Both are written as source="manual" so payroll treats them as authoritative.
"""

from datetime import date as date_type, datetime
from decimal import Decimal

from django.utils import timezone
from rest_framework.decorators import api_view
from rest_framework.request import Request
from rest_framework.response import Response

from .auth import require_hr, require_auth, get_token_employee_id
from .branch_scope import scope_to_branch
from .models import AttendanceDayRecord, CasualLeaveRequest, Employee, Notification

ELIGIBILITY_MONTHS = 6


# ── Helpers ────────────────────────────────────────────────────────────────

def _parse_join_date(raw) -> date_type | None:
    if not raw:
        return None
    s = str(raw).strip()
    for fmt in ("%Y-%m-%d", "%d/%m/%Y", "%d-%m-%Y"):
        try:
            return datetime.strptime(s[:10], fmt).date()
        except ValueError:
            continue
    return None


def _service_months(emp: Employee, today: date_type | None = None) -> int | None:
    """Completed months of service, or None when join date is unknown."""
    today = today or date_type.today()
    joined = _parse_join_date(emp.join_date)
    if joined is None:
        return None
    months = (today.year - joined.year) * 12 + (today.month - joined.month)
    if today.day < joined.day:
        months -= 1
    return max(0, months)


def _cl_used_in_month(emp_id: int, year: int, month: int, exclude_id: int | None = None) -> bool:
    qs = CasualLeaveRequest.objects.filter(
        employee_id=emp_id, date__year=year, date__month=month,
        status__in=["pending", "approved"],
    )
    if exclude_id:
        qs = qs.exclude(pk=exclude_id)
    return qs.exists()


def check_cl_eligibility(emp: Employee, for_date: date_type) -> tuple[bool, str | None]:
    """(eligible, reason_if_not). Applies all the CL business rules."""
    if emp.employment_type != "staff":
        return False, "Casual Leave is available only for staff employees"
    if emp.status != "active":
        return False, "Employee is not active"
    months = _service_months(emp)
    if months is None:
        return False, "Join date not set — contact HR"
    if months < ELIGIBILITY_MONTHS:
        return False, f"Eligible after {ELIGIBILITY_MONTHS} months of service (currently {months})"
    if _cl_used_in_month(emp.id, for_date.year, for_date.month):
        return False, "Casual Leave already used this month (limit: 1 per month)"
    return True, None


def _cl_dict(r: CasualLeaveRequest) -> dict:
    emp = r.employee
    return {
        "id": r.id,
        "employeeId": emp.id,
        "employeeCode": emp.employee_code,
        "employeeName": f"{emp.first_name} {emp.last_name}",
        "department": emp.department.name if emp.department_id and emp.department else None,
        "designation": emp.designation.title if emp.designation_id and emp.designation else None,
        "date": str(r.date),
        "reason": r.reason,
        "status": r.status,
        "reviewedBy": r.reviewed_by,
        "reviewerRole": r.reviewer_role,
        "reviewComment": r.review_comment,
        "reviewedAt": r.reviewed_at.isoformat() if r.reviewed_at else None,
        "createdAt": r.created_at.isoformat() if r.created_at else None,
    }


def _write_attendance_for_cl(cl: CasualLeaveRequest, reviewer: str) -> None:
    """Write the final attendance verdict for the CL date (source=manual wins)."""
    from .attendance_final import compute_day_record

    record = AttendanceDayRecord.objects.filter(employee=cl.employee, date=cl.date).first()
    if record is None:
        record = compute_day_record(cl.employee, cl.date)

    if cl.status == CasualLeaveRequest.STATUS_APPROVED:
        record.status = "present"
        record.shifts_earned = Decimal("1.00")
        record.is_late = False
        record.is_half_shift = False
        record.override_note = "Casual Leave (paid) — approved"
    else:  # rejected
        record.status = "on_leave"
        record.shifts_earned = Decimal("0")
        record.is_late = False
        record.is_half_shift = False
        record.override_note = "Casual Leave rejected — marked as leave"
    record.source = "manual"
    record.override_by = reviewer
    record.save()


def apply_cl_decision(cl: CasualLeaveRequest, status: str, reviewer: str,
                      reviewer_role: str, comment: str | None) -> CasualLeaveRequest:
    """Shared by HR and Department Head endpoints."""
    cl.status = status
    cl.reviewed_by = reviewer
    cl.reviewer_role = reviewer_role
    cl.review_comment = comment
    cl.reviewed_at = timezone.now()
    cl.save()
    _write_attendance_for_cl(cl, reviewer)
    Notification.objects.create(
        employee=cl.employee,
        type="casual_leave",
        message=f"Your Casual Leave request for {cl.date.isoformat()} was {status}.",
    )
    return cl


# ── List / submit ───────────────────────────────────────────────────────────

@api_view(["GET", "POST"])
@require_auth
def casual_leaves(request: Request) -> Response:
    if request.method == "GET":
        qs = CasualLeaveRequest.objects.select_related(
            "employee__department", "employee__designation"
        )
        qs = scope_to_branch(qs, request, field="employee__branch_id")
        # Employees see only their own CLs
        token_emp_id = get_token_employee_id(request)
        if token_emp_id:
            qs = qs.filter(employee_id=token_emp_id)
        else:
            if emp_id := request.query_params.get("employeeId"):
                qs = qs.filter(employee_id=emp_id)
            if code := request.query_params.get("employeeCode"):
                qs = qs.filter(employee__employee_code__iexact=code.strip())
        if status_filter := request.query_params.get("status"):
            qs = qs.filter(status=status_filter)
        if month := request.query_params.get("month"):
            qs = qs.filter(date__month=month)
        if year := request.query_params.get("year"):
            qs = qs.filter(date__year=year)
        return Response([_cl_dict(r) for r in qs[:300]])

    # POST — submit a CL request (mobile app or HR on behalf)
    data = request.data
    emp_id = None
    if code := data.get("employeeCode"):
        found = Employee.objects.filter(employee_code__iexact=str(code).strip()).first()
        emp_id = found.id if found else None
    if not emp_id:
        emp_id = data.get("employeeId")

    token_emp_id = get_token_employee_id(request)
    if token_emp_id:
        # Employees can only submit for themselves
        if emp_id and str(emp_id) != str(token_emp_id):
            return Response({"error": "You can only apply Casual Leave for yourself"}, status=403)
        emp_id = token_emp_id

    if not emp_id or not data.get("date"):
        return Response({"error": "employeeId and date are required"}, status=400)

    emp = Employee.objects.filter(id=emp_id).first()
    if not emp:
        return Response({"error": "Employee not found"}, status=404)

    try:
        cl_date = date_type.fromisoformat(str(data["date"]))
    except (ValueError, TypeError):
        return Response({"error": "Invalid date"}, status=400)

    eligible, reason = check_cl_eligibility(emp, cl_date)
    if not eligible:
        return Response({"error": reason}, status=400)

    cl = CasualLeaveRequest.objects.create(
        employee=emp,
        date=cl_date,
        reason=data.get("reason"),
    )
    return Response(_cl_dict(cl), status=201)


# ── HR decision ─────────────────────────────────────────────────────────────

@api_view(["PATCH", "DELETE"])
@require_hr
def casual_leave_detail(request: Request, pk: int) -> Response:
    cl = CasualLeaveRequest.objects.select_related("employee").filter(pk=pk).first()
    if not cl:
        return Response({"error": "Casual leave request not found"}, status=404)

    if request.method == "DELETE":
        cl.delete()
        return Response({"ok": True})

    status_val = request.data.get("status")
    if status_val not in ("approved", "rejected"):
        return Response({"error": "status must be 'approved' or 'rejected'"}, status=400)
    if cl.status != "pending":
        return Response({"error": f"This request was already {cl.status}"}, status=400)

    reviewer = getattr(request, "hr_user_name", None) or "HR"
    apply_cl_decision(cl, status_val, reviewer, "hr", request.data.get("comment"))
    return Response(_cl_dict(cl))


# ── Eligibility board (HR page) ─────────────────────────────────────────────

@api_view(["GET"])
@require_hr
def casual_leave_eligibility(request: Request) -> Response:
    """All staff employees with their CL eligibility status for a month."""
    today = date_type.today()
    month = int(request.query_params.get("month", today.month))
    year = int(request.query_params.get("year", today.year))
    check_date = date_type(year, month, 15)  # representative day of the month

    used_map: dict[int, CasualLeaveRequest] = {}
    for r in CasualLeaveRequest.objects.filter(
        date__year=year, date__month=month, status__in=["pending", "approved"]
    ).select_related("employee"):
        used_map[r.employee_id] = r

    rows = []
    for emp in Employee.objects.filter(
        status="active", employment_type="staff"
    ).select_related("department", "designation"):
        months = _service_months(emp, check_date)
        service_ok = months is not None and months >= ELIGIBILITY_MONTHS
        used = used_map.get(emp.id)
        rows.append({
            "employeeId": emp.id,
            "employeeCode": emp.employee_code,
            "employeeName": f"{emp.first_name} {emp.last_name}",
            "department": emp.department.name if emp.department_id and emp.department else None,
            "designation": emp.designation.title if emp.designation_id and emp.designation else None,
            "joinDate": emp.join_date,
            "serviceMonths": months,
            "eligible": service_ok and used is None,
            "reason": (
                "Casual Leave already used this month (limit: 1 per month)" if service_ok and used is not None
                else None if service_ok
                else ("Join date not set" if months is None
                      else f"{months}/{ELIGIBILITY_MONTHS} months of service")
            ),
            "usedThisMonth": bool(used),
            "usedStatus": used.status if used else None,
            "usedDate": str(used.date) if used else None,
        })

    rows.sort(key=lambda r: (not r["eligible"], r["employeeName"]))
    return Response({
        "month": month,
        "year": year,
        "eligibilityMonths": ELIGIBILITY_MONTHS,
        "employees": rows,
    })

"""HR/employee dashboard summaries, interview summary and salary trends."""

from .auth import get_token_employee_id, require_auth, require_hr
from .branch_scope import scope_to_branch
from .clock import ist_today
from .models import (
    Applicant,
    AttendanceLog,
    Department,
    Employee,
    EmployeePermission,
    Job,
    LeaveBalance,
    LeaveRequest,
    Notification,
    OnDutyPunchVerification,
    OnDutySession,
    Payroll,
    SalaryRecord,
)
from .salary_record_views import _salary_from_payroll, _salary_with_name
from .view_common import _error
from decimal import Decimal
from django.db.models import Count, DecimalField, Q, Sum, Value
from django.db.models.functions import Coalesce
from rest_framework.decorators import api_view
from rest_framework.request import Request
from rest_framework.response import Response


# --- Dashboard ---


MONTH_NAMES = [
    "Jan", "Feb", "Mar", "Apr", "May", "Jun",
    "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
]


@api_view(["GET"])
@require_hr
def hr_dashboard_summary(request: Request) -> Response:
    # Every query below is branch-scoped -a branch-restricted HR user only
    # ever sees totals for their own branch. scope_to_branch() is a no-op for
    # super admins and branch-less legacy roles (see branch_scope.py), so
    # they still see company-wide totals as before.
    scoped_employees = scope_to_branch(Employee.objects, request)
    emp_stats = scoped_employees.aggregate(
        total=Count("id"),
        active=Count("id", filter=Q(status="active")),
        inactive=Count("id", filter=Q(status="inactive")),
    )
    pending_leaves = scope_to_branch(
        LeaveRequest.objects, request, field="employee__branch_id"
    ).filter(status="pending").count()
    unread_notifications = scope_to_branch(
        Notification.objects, request, field="employee__branch_id"
    ).filter(is_read=False).count()
    total_departments = scope_to_branch(Department.objects, request).count()
    _zero = Value(Decimal("0"), output_field=DecimalField())
    salary_stats = scoped_employees.filter(status="active").aggregate(
        monthly_total=Coalesce(
            Sum("salary_amount", filter=Q(salary_type="monthly")), _zero
        ),
        weekly_total=Coalesce(
            Sum("salary_amount", filter=Q(salary_type="weekly")), _zero
        ),
    )
    open_jobs = scope_to_branch(
        Job.objects, request, field="department__branch_id"
    ).filter(status="open").count()
    pending_applicants = scope_to_branch(
        Applicant.objects, request, field="job__department__branch_id"
    ).filter(status="applied").count()
    gender_stats = scoped_employees.filter(status="active").aggregate(
        male=Count("id", filter=Q(gender="male")),
        female=Count("id", filter=Q(gender="female")),
        other=Count("id", filter=~Q(gender__in=["male", "female"])),
    )

    today = ist_today()
    geo_punches_today = scope_to_branch(
        AttendanceLog.objects, request, field="employee__branch_id"
    ).filter(date=today, source="geo:auto").count()
    scoped_on_duty = scope_to_branch(OnDutySession.objects, request)  # OnDutySession.branch_id is a direct field
    on_duty_pending = scoped_on_duty.filter(
        status__in=[OnDutySession.STATUS_PENDING_HOD, OnDutySession.STATUS_PENDING_HR]
    ).count()
    on_duty_sessions_active = scoped_on_duty.filter(status=OnDutySession.STATUS_ACTIVE).count()
    on_duty_completed_today = scoped_on_duty.filter(
        status=OnDutySession.STATUS_COMPLETED, completed_at__date=today
    ).count()
    employees_on_duty_today = scoped_on_duty.filter(
        Q(created_at__date=today) | Q(status=OnDutySession.STATUS_ACTIVE)
    ).values("employee_id").distinct().count()
    pending_punch_verifications = scope_to_branch(
        OnDutyPunchVerification.objects, request, field="employee__branch_id"
    ).filter(status=OnDutyPunchVerification.STATUS_PENDING).count()
    live_tracking_enabled = scoped_employees.filter(location_tracking_enabled=True, status="active").count()
    production_payroll_pending = scope_to_branch(
        Payroll.objects, request, field="employee__branch_id"
    ).filter(salary_mode="shift", status="pending").count()

    return Response(
        {
            "totalEmployees": emp_stats["total"] or 0,
            "activeEmployees": emp_stats["active"] or 0,
            "inactiveEmployees": emp_stats["inactive"] or 0,
            "pendingLeaves": pending_leaves,
            "unreadNotifications": unread_notifications,
            "totalDepartments": total_departments,
            "monthlySalaryTotal": float(salary_stats["monthly_total"] or 0),
            "weeklySalaryTotal": float(salary_stats["weekly_total"] or 0),
            "openJobs": open_jobs,
            "pendingApplicants": pending_applicants,
            "maleEmployees": gender_stats["male"] or 0,
            "femaleEmployees": gender_stats["female"] or 0,
            "otherEmployees": gender_stats["other"] or 0,
            "geoPunchesToday": geo_punches_today,
            "onDutyPendingApprovals": on_duty_pending,
            "onDutySessionsActive": on_duty_sessions_active,
            "onDutyCompletedToday": on_duty_completed_today,
            "employeesOnDutyToday": employees_on_duty_today,
            "pendingPunchVerifications": pending_punch_verifications,
            "liveTrackingEnabledCount": live_tracking_enabled,
            "productionPayrollPending": production_payroll_pending,
        }
    )


@api_view(["GET"])
@require_auth
def employee_dashboard_summary(request: Request) -> Response:
    # An employee token always sees its own summary; only HR may pick an employee.
    employee_id = get_token_employee_id(request)
    if employee_id is None:
        employee_id = request.query_params.get("employeeId")
    if not employee_id:
        return _error("employeeId required", 400)
    employee_id = int(employee_id)

    today = ist_today()
    month, year = today.month, today.year

    emp = Employee.objects.filter(pk=employee_id).first()
    if not emp:
        return _error("Employee not found", 404)

    # Present / half-shift / absent / leave / working days all come from the
    # same day-by-day engine payroll, the HR portal and the mobile Attendance
    # tab use (attendance_final.compute_month_records). This view previously
    # ran its own inline count that hardcoded "Sunday off", ignored holidays
    # entirely, counted any punch at all as a full present day, and derived
    # absent purely by subtraction -so the app's Home card could disagree
    # with its own Attendance tab (and with HRMS) for the very same month.
    from .attendance_final import compute_month_records, month_summary_from_records

    summary = month_summary_from_records(compute_month_records(emp, year, month))
    working_days_so_far   = summary["workingDays"]
    present_days          = summary["present"]
    half_shift_days       = summary["halfShift"]
    absent_days           = summary["absent"]
    leave_days_this_month = summary["onLeave"]
    late_days             = summary["late"]

    approved_leaves = LeaveRequest.objects.filter(employee_id=employee_id, status="approved")

    # Leave balance (sum of remaining across all leave types this year)
    leave_balance = LeaveBalance.objects.filter(
        employee_id=employee_id, year=year,
    ).aggregate(total=Sum("remaining"))["total"] or 0

    # Pending requests = pending leaves + pending permissions
    pending_leaves = LeaveRequest.objects.filter(employee_id=employee_id, status="pending").count()
    pending_perms  = EmployeePermission.objects.filter(employee_id=employee_id, status="pending").count()

    payrolls = Payroll.objects.filter(employee_id=employee_id).order_by("-year", "-month")[:6]
    if payrolls.exists():
        recent = [_salary_from_payroll(p) for p in payrolls]
    else:
        recent = [
            _salary_with_name(r)
            for r in SalaryRecord.objects.filter(employee_id=employee_id)
            .order_by("-year", "-month")[:6]
        ]

    # Manager access flags
    from .models import DepartmentManager
    from django.db.models import Q as DQ
    manager_profile = None
    try:
        manager_profile = DepartmentManager.objects.prefetch_related(
            "department_assignments", "employee_assignments"
        ).get(employee_id=employee_id, is_active=True)
    except DepartmentManager.DoesNotExist:
        pass

    is_manager = manager_profile is not None
    pending_approvals_count = 0
    if is_manager:
        dept_ids = [da.department_id for da in manager_profile.department_assignments.all()]
        direct_ids = [ea.employee_id for ea in manager_profile.employee_assignments.all()]
        emp_filter = DQ(employee_id__in=direct_ids)
        if dept_ids:
            emp_filter |= DQ(employee__department_id__in=dept_ids)
        pending_approvals_count = (
            LeaveRequest.objects.filter(emp_filter, status="pending").count()
            + EmployeePermission.objects.filter(emp_filter, status="pending").count()
        )

    return Response({
        "employeeId":     employee_id,
        "workingDays":    working_days_so_far,
        "presentDays":    present_days,
        "halfShiftDays":  half_shift_days,
        "lateDays":       late_days,
        "absentDays":     absent_days,
        "leaveDays":      leave_days_this_month,
        "leaveBalance":   float(leave_balance),
        "pendingRequests": pending_leaves + pending_perms,
        "pendingLeaves":  pending_leaves,
        "approvedLeaves": approved_leaves.count(),
        "recentSalaries": recent,
        "isManager":      is_manager,
        "canSubmitLeave": is_manager,
        "pendingApprovalsCount": pending_approvals_count,
    })


@api_view(["GET"])
@require_hr
def interview_summary(_request: Request) -> Response:
    stats = {
        row["status"]: row["count"]
        for row in Applicant.objects.values("status").annotate(count=Count("id"))
    }
    total = sum(stats.values())
    return Response(
        {
            "totalApplicants": total,
            "attended": stats.get("attended", 0),
            "selected": stats.get("selected", 0),
            "rejected": stats.get("rejected", 0),
            "pending": stats.get("applied", 0),
        }
    )


@api_view(["GET"])
@require_hr
def salary_trends(_request: Request) -> Response:
    # Prefer Payroll table (authoritative) when present, otherwise fall back to legacy SalaryRecord
    _zero = Value(Decimal("0"), output_field=DecimalField())

    payroll_qs = (
        Payroll.objects.values("month", "year")
        .annotate(total=Coalesce(Sum("final_salary"), _zero))
        .order_by("year", "month")[:12]
    )

    if payroll_qs.exists():
        trends = payroll_qs
    else:
        trends = (
            SalaryRecord.objects.values("month", "year")
            .annotate(total=Coalesce(Sum("amount"), _zero))
            .order_by("year", "month")[:12]
        )

    return Response(
        [
            {
                "month": t["month"],
                "year": t["year"],
                "total": float(t["total"]),
                "label": f"{MONTH_NAMES[t['month'] - 1]} {t['year']}",
            }
            for t in trends
        ]
    )

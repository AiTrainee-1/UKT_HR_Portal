"""
HR Reports — all endpoints return JSON { count, results }.
Frontend handles table rendering and Excel export via exceljs.
"""
import calendar
from collections import defaultdict
from datetime import date, datetime, timedelta

from rest_framework.decorators import api_view
from rest_framework.request import Request
from rest_framework.response import Response

from .auth import require_hr
from .models import (
    Employee, Attendance, AttendanceLog, LeaveRequest, LeaveBalance, LeaveType,
    Department, Branch, Advance, AdvanceRepayment, SalarySlip,
)

MONTH_NAMES = [
    "January","February","March","April","May","June",
    "July","August","September","October","November","December",
]


def _emp_base(emp):
    return {
        "employeeId": emp.id,
        "employeeCode": emp.employee_code,
        "employeeName": f"{emp.first_name} {emp.last_name}",
        "department": emp.department.name if emp.department_id else "",
        "designation": emp.designation.title if emp.designation_id else "",
        "employmentType": emp.employment_type,
    }


def _parse_date(s):
    try:
        return date.fromisoformat(s)
    except Exception:
        return None


# ─────────────────────────────────────────────────────────────────────────────
# 1. Attendance Summary Report
#    Uses SalarySlip (already has present/absent/late/OT computed by payroll engine)
#    Fallback: count AttendanceLog punch-in days if no salary slip
# ─────────────────────────────────────────────────────────────────────────────

@api_view(["GET"])
@require_hr
def attendance_summary_report(request: Request):
    month     = int(request.query_params.get("month", date.today().month))
    year      = int(request.query_params.get("year",  date.today().year))
    dept_id   = request.query_params.get("departmentId")
    emp_id    = request.query_params.get("employeeId")
    emp_type  = request.query_params.get("employmentType")

    emp_qs = (
        Employee.objects
        .select_related("department", "designation")
        .filter(status="active")
    )
    if dept_id:
        emp_qs = emp_qs.filter(department_id=dept_id)
    if emp_id:
        emp_qs = emp_qs.filter(id=emp_id)
    if emp_type:
        emp_qs = emp_qs.filter(employment_type=emp_type)

    # Salary slips for the month give us the cleanest pre-computed data
    slips = {
        (s.employee_id, s.week_number): s
        for s in SalarySlip.objects.filter(month=month, year=year)
        if s.employee_id in {e.id for e in emp_qs}
    }

    # Punch-log fallback: count distinct IN days per employee
    punch_days = defaultdict(set)
    for log in AttendanceLog.objects.filter(
        date__month=month, date__year=year, punch_type="IN"
    ).values("employee_id", "date"):
        punch_days[log["employee_id"]].add(log["date"])

    total_days = calendar.monthrange(year, month)[1]

    results = []
    for emp in emp_qs:
        # Gather all slips for this employee (monthly = 1 slip, biweekly = 2 slips)
        emp_slips = [v for (eid, wk), v in slips.items() if eid == emp.id]

        if emp_slips:
            present   = sum(float(s.present_days)  for s in emp_slips)
            absent    = sum(float(s.absent_days)   for s in emp_slips)
            late      = sum(s.late_days            for s in emp_slips)
            ot_amt    = sum(float(s.ot_amount)     for s in emp_slips)
            gross     = sum(float(s.gross_salary)  for s in emp_slips)
            net       = sum(float(s.net_salary)    for s in emp_slips)
        else:
            present = len(punch_days.get(emp.id, set()))
            absent  = max(0, total_days - present)
            late    = 0
            ot_amt  = 0
            gross   = 0
            net     = 0

        results.append({
            **_emp_base(emp),
            "month": month,
            "year": year,
            "monthName": MONTH_NAMES[month - 1],
            "totalDays": total_days,
            "presentDays": round(present, 1),
            "absentDays": round(absent, 1),
            "lateDays": late,
            "otAmount": round(ot_amt, 2),
            "grossSalary": round(gross, 2),
            "netSalary": round(net, 2),
            "attendancePct": round((present / total_days * 100) if total_days else 0, 1),
        })

    results.sort(key=lambda r: r["employeeCode"])
    return Response({"count": len(results), "month": month, "year": year, "results": results})


# ─────────────────────────────────────────────────────────────────────────────
# 2. Attendance Punch Log (raw records)
# ─────────────────────────────────────────────────────────────────────────────

@api_view(["GET"])
@require_hr
def attendance_report(request: Request):
    date_from = request.query_params.get("dateFrom")
    date_to   = request.query_params.get("dateTo")
    dept_id   = request.query_params.get("departmentId")
    emp_id    = request.query_params.get("employeeId")
    emp_type  = request.query_params.get("employmentType")

    qs = (
        AttendanceLog.objects
        .select_related("employee", "employee__department", "employee__designation")
        .order_by("date", "employee__employee_code", "punch_time")
    )
    if date_from:
        qs = qs.filter(date__gte=date_from)
    if date_to:
        qs = qs.filter(date__lte=date_to)
    if dept_id:
        qs = qs.filter(employee__department_id=dept_id)
    if emp_id:
        qs = qs.filter(employee_id=emp_id)
    if emp_type:
        qs = qs.filter(employee__employment_type=emp_type)

    results = [
        {
            **_emp_base(log.employee),
            "date": log.date.isoformat(),
            "punchType": log.punch_type,
            "punchTime": log.punch_time.strftime("%H:%M"),
            "source": log.source,
        }
        for log in qs[:2000]
    ]
    return Response({"count": qs.count(), "results": results})


# ─────────────────────────────────────────────────────────────────────────────
# 3. Leave Report (requests)
# ─────────────────────────────────────────────────────────────────────────────

@api_view(["GET"])
@require_hr
def leave_report(request: Request):
    year    = request.query_params.get("year",  str(date.today().year))
    month   = request.query_params.get("month", "")
    dept_id = request.query_params.get("departmentId")
    emp_id  = request.query_params.get("employeeId")
    status  = request.query_params.get("status")

    qs = (
        LeaveRequest.objects
        .select_related("employee", "employee__department", "employee__designation", "leave_type_ref")
        .order_by("-created_at")
    )

    if year:
        qs = qs.filter(start_date__startswith=str(year))
    if month:
        prefix = f"{year}-{int(month):02d}"
        qs = qs.filter(start_date__startswith=prefix)
    if dept_id:
        qs = qs.filter(employee__department_id=dept_id)
    if emp_id:
        qs = qs.filter(employee_id=emp_id)
    if status:
        qs = qs.filter(status=status)

    results = [
        {
            **_emp_base(lr.employee),
            "leaveType": lr.leave_type_ref.name if lr.leave_type_ref_id else lr.type,
            "startDate": lr.start_date,
            "endDate": lr.end_date,
            "totalDays": float(lr.total_days),
            "reason": lr.reason,
            "status": lr.status,
            "approvedBy": lr.approved_by,
            "createdAt": lr.created_at.strftime("%Y-%m-%d") if lr.created_at else None,
        }
        for lr in qs
    ]
    return Response({"count": len(results), "results": results})


# ─────────────────────────────────────────────────────────────────────────────
# 4. Leave Balance Report
# ─────────────────────────────────────────────────────────────────────────────

@api_view(["GET"])
@require_hr
def leave_balance_report(request: Request):
    year    = int(request.query_params.get("year",  date.today().year))
    dept_id = request.query_params.get("departmentId")
    emp_id  = request.query_params.get("employeeId")

    qs = (
        LeaveBalance.objects
        .select_related("employee", "employee__department", "employee__designation", "leave_type")
        .filter(year=year, employee__status="active")
        .order_by("employee__employee_code", "leave_type__code")
    )
    if dept_id:
        qs = qs.filter(employee__department_id=dept_id)
    if emp_id:
        qs = qs.filter(employee_id=emp_id)

    results = [
        {
            **_emp_base(lb.employee),
            "year": lb.year,
            "leaveType": lb.leave_type.name,
            "leaveCode": lb.leave_type.code,
            "allocated": float(lb.allocated),
            "used": float(lb.used),
            "remaining": float(lb.remaining),
            "carriedForward": float(lb.carried_forward),
        }
        for lb in qs
    ]
    return Response({"count": len(results), "results": results})


# ─────────────────────────────────────────────────────────────────────────────
# 5. Salary Register (Payroll Report)
# ─────────────────────────────────────────────────────────────────────────────

@api_view(["GET"])
@require_hr
def payroll_report(request: Request):
    month    = request.query_params.get("month",  date.today().month)
    year     = request.query_params.get("year",   date.today().year)
    dept_id  = request.query_params.get("departmentId")
    emp_id   = request.query_params.get("employeeId")
    emp_type = request.query_params.get("employmentType")  # staff / production
    week_num = request.query_params.get("weekNumber")      # 1 or 2 for production

    qs = (
        SalarySlip.objects
        .select_related("employee", "employee__department", "employee__designation")
        .filter(month=int(month), year=int(year))
        .order_by("employee__employee_code")
    )
    if dept_id:
        qs = qs.filter(employee__department_id=dept_id)
    if emp_id:
        qs = qs.filter(employee_id=emp_id)
    if emp_type == "staff":
        qs = qs.filter(week_number__isnull=True)
    elif emp_type == "production":
        qs = qs.filter(week_number__isnull=False)
        if week_num:
            qs = qs.filter(week_number=int(week_num))

    results = [
        {
            **_emp_base(s.employee),
            "salaryType": s.employee.salary_type,
            "month": s.month,
            "year": s.year,
            "weekNumber": s.week_number,
            "workingDays": s.working_days,
            "presentDays": float(s.present_days),
            "absentDays": float(s.absent_days),
            "lateDays": s.late_days,
            "basic": float(s.basic),
            "hra": float(s.hra),
            "allowances": float(s.allowances),
            "otAmount": float(s.ot_amount),
            "grossSalary": float(s.gross_salary),
            "pfDeduction": float(s.pf_deduction),
            "esiDeduction": float(s.esi_deduction),
            "advanceDeduction": float(s.advance_deduction),
            "otherDeductions": float(s.other_deductions),
            "totalDeductions": float(s.total_deductions),
            "netSalary": float(s.net_salary),
            "bankAccount": s.employee.bank_account or "",
            "bankIfsc": s.employee.bank_ifsc or "",
            "bankName": s.employee.bank_name or "",
        }
        for s in qs
    ]

    totals = {
        "grossSalary": round(sum(r["grossSalary"] for r in results), 2),
        "pfDeduction": round(sum(r["pfDeduction"] for r in results), 2),
        "esiDeduction": round(sum(r["esiDeduction"] for r in results), 2),
        "totalDeductions": round(sum(r["totalDeductions"] for r in results), 2),
        "netSalary": round(sum(r["netSalary"] for r in results), 2),
    }

    return Response({"count": len(results), "results": results, "totals": totals})


# ─────────────────────────────────────────────────────────────────────────────
# 6. PF / ESI Contribution Report (Statutory Compliance)
# ─────────────────────────────────────────────────────────────────────────────

@api_view(["GET"])
@require_hr
def pf_esi_report(request: Request):
    month   = int(request.query_params.get("month", date.today().month))
    year    = int(request.query_params.get("year",  date.today().year))
    dept_id = request.query_params.get("departmentId")
    emp_id  = request.query_params.get("employeeId")

    qs = (
        SalarySlip.objects
        .select_related("employee", "employee__department", "employee__designation")
        .filter(month=month, year=year)
        .order_by("employee__employee_code")
    )
    if dept_id:
        qs = qs.filter(employee__department_id=dept_id)
    if emp_id:
        qs = qs.filter(employee_id=emp_id)

    # Aggregate by employee (sum across weekly slips for production)
    by_emp: dict = {}
    for s in qs:
        eid = s.employee_id
        if eid not in by_emp:
            by_emp[eid] = {
                **_emp_base(s.employee),
                "pfNumber": s.employee.pf_number or "",
                "esiNumber": s.employee.esi_number or "",
                "uanNumber": s.employee.uan_number or "",
                "grossSalary": 0.0,
                "pfDeduction": 0.0,
                "esiDeduction": 0.0,
                "pfEligible": False,
                "esiEligible": False,
            }
        by_emp[eid]["grossSalary"]  += float(s.gross_salary)
        by_emp[eid]["pfDeduction"]  += float(s.pf_deduction)
        by_emp[eid]["esiDeduction"] += float(s.esi_deduction)
        if s.pf_deduction  > 0: by_emp[eid]["pfEligible"]  = True
        if s.esi_deduction > 0: by_emp[eid]["esiEligible"] = True

    results = sorted(by_emp.values(), key=lambda r: r["employeeCode"])
    totals = {
        "grossSalary": round(sum(r["grossSalary"] for r in results), 2),
        "pfDeduction": round(sum(r["pfDeduction"] for r in results), 2),
        "esiDeduction": round(sum(r["esiDeduction"] for r in results), 2),
    }
    return Response({"count": len(results), "month": month, "year": year, "results": results, "totals": totals})


# ─────────────────────────────────────────────────────────────────────────────
# 7. Employee Master Report
# ─────────────────────────────────────────────────────────────────────────────

@api_view(["GET"])
@require_hr
def employee_report(request: Request):
    dept_id    = request.query_params.get("departmentId")
    branch_id  = request.query_params.get("branchId")
    emp_type   = request.query_params.get("employmentType")
    emp_status = request.query_params.get("status", "active")
    emp_id     = request.query_params.get("employeeId")

    qs = (
        Employee.objects
        .select_related("department", "designation", "branch")
        .filter(status=emp_status)
        .order_by("employee_code")
    )
    if dept_id:
        qs = qs.filter(department_id=dept_id)
    if branch_id:
        qs = qs.filter(branch_id=branch_id)
    if emp_type:
        qs = qs.filter(employment_type=emp_type)
    if emp_id:
        qs = qs.filter(id=emp_id)

    results = [
        {
            "employeeId": e.id,
            "employeeCode": e.employee_code,
            "name": f"{e.first_name} {e.last_name}",
            "gender": e.gender or "",
            "department": e.department.name if e.department_id else "",
            "designation": e.designation.title if e.designation_id else "",
            "branch": e.branch.name if e.branch_id else "",
            "employmentType": e.employment_type,
            "salaryType": e.salary_type,
            "salaryAmount": float(e.salary_amount or 0),
            "phone": e.phone or "",
            "email": e.email or "",
            "joinDate": e.join_date or "",
            "pfNumber": e.pf_number or "",
            "esiNumber": e.esi_number or "",
            "uanNumber": e.uan_number or "",
            "bankAccount": e.bank_account or "",
            "bankIfsc": e.bank_ifsc or "",
            "bankName": e.bank_name or "",
            "status": e.status,
        }
        for e in qs
    ]
    return Response({"count": len(results), "results": results})


# ─────────────────────────────────────────────────────────────────────────────
# 8. Headcount / Strength Report
# ─────────────────────────────────────────────────────────────────────────────

@api_view(["GET"])
@require_hr
def headcount_report(request: Request):
    emp_status = request.query_params.get("status", "active")

    employees = (
        Employee.objects
        .select_related("department", "designation", "branch")
        .filter(status=emp_status)
    )

    by_dept: dict    = defaultdict(lambda: {"staff": 0, "production": 0, "male": 0, "female": 0, "other": 0, "total": 0})
    by_type: dict    = defaultdict(int)
    by_gender: dict  = defaultdict(int)
    new_this_month   = []
    today            = date.today()
    month_start      = f"{today.year}-{today.month:02d}"

    for e in employees:
        dept = e.department.name if e.department_id else "Unassigned"
        by_dept[dept][e.employment_type] = by_dept[dept].get(e.employment_type, 0) + 1
        by_dept[dept][e.gender or "other"] = by_dept[dept].get(e.gender or "other", 0) + 1
        by_dept[dept]["total"] += 1
        by_type[e.employment_type] += 1
        by_gender[e.gender or "other"] += 1
        if e.join_date and str(e.join_date).startswith(month_start):
            new_this_month.append({
                "employeeCode": e.employee_code,
                "name": f"{e.first_name} {e.last_name}",
                "department": dept,
                "employmentType": e.employment_type,
                "joinDate": e.join_date,
            })

    dept_breakdown = [
        {"department": k, **v}
        for k, v in sorted(by_dept.items())
    ]

    return Response({
        "total": employees.count(),
        "byDepartment": dept_breakdown,
        "byType": dict(by_type),
        "byGender": dict(by_gender),
        "newThisMonth": new_this_month,
    })


# ─────────────────────────────────────────────────────────────────────────────
# 9. Loan / Settlement Report
# ─────────────────────────────────────────────────────────────────────────────

@api_view(["GET"])
@require_hr
def settlement_report(request: Request):
    adv_status  = request.query_params.get("status")      # pending/approved/closed/rejected
    adv_type    = request.query_params.get("type")         # general/term
    dept_id     = request.query_params.get("departmentId")
    emp_id      = request.query_params.get("employeeId")
    overdue_only = request.query_params.get("overdueOnly") == "true"

    qs = (
        Advance.objects
        .select_related("employee", "employee__department", "employee__designation")
        .prefetch_related("repayments")
        .order_by("-created_at")
    )
    if adv_status:
        qs = qs.filter(status=adv_status)
    if adv_type:
        qs = qs.filter(advance_type=adv_type)
    if dept_id:
        qs = qs.filter(employee__department_id=dept_id)
    if emp_id:
        qs = qs.filter(employee_id=emp_id)

    today = date.today()
    results = []
    for a in qs:
        # Overdue check: count months from start with no repayment
        paid_months = {(r.year, r.month) for r in a.repayments.all()}
        overdue_count = 0
        if a.status == "approved" and a.repayment_start_month and a.repayment_start_year:
            y, m = a.repayment_start_year, a.repayment_start_month
            while (y, m) < (today.year, today.month):
                if (y, m) not in paid_months:
                    overdue_count += 1
                m += 1
                if m > 12:
                    m, y = 1, y + 1

        if overdue_only and overdue_count == 0:
            continue

        results.append({
            **_emp_base(a.employee),
            "advanceType": a.advance_type,
            "advanceTypeLabel": "General Advance" if a.advance_type == "general" else "Term Loan",
            "amount": float(a.amount),
            "purpose": a.purpose or "",
            "status": a.status,
            "emiAmount": float(a.emi_amount),
            "totalRepaid": float(a.total_repaid),
            "outstanding": float(a.outstanding),
            "repaymentStartMonth": a.repayment_start_month,
            "repaymentStartYear": a.repayment_start_year,
            "overdueMonths": overdue_count,
            "paymentsCount": a.repayments.count(),
            "createdAt": a.created_at.strftime("%Y-%m-%d") if a.created_at else None,
        })

    totals = {
        "totalDisbursed": round(sum(r["amount"] for r in results), 2),
        "totalRepaid": round(sum(r["totalRepaid"] for r in results), 2),
        "totalOutstanding": round(sum(r["outstanding"] for r in results), 2),
    }
    return Response({"count": len(results), "results": results, "totals": totals})


# ─────────────────────────────────────────────────────────────────────────────
# 10. New Joinings Report
# ─────────────────────────────────────────────────────────────────────────────

@api_view(["GET"])
@require_hr
def new_joinings_report(request: Request):
    month   = int(request.query_params.get("month", date.today().month))
    year    = int(request.query_params.get("year",  date.today().year))
    dept_id = request.query_params.get("departmentId")
    emp_type = request.query_params.get("employmentType")

    prefix = f"{year}-{month:02d}"
    qs = (
        Employee.objects
        .select_related("department", "designation", "branch")
        .filter(join_date__startswith=prefix)
        .order_by("join_date", "employee_code")
    )
    if dept_id:
        qs = qs.filter(department_id=dept_id)
    if emp_type:
        qs = qs.filter(employment_type=emp_type)

    results = [
        {
            "employeeCode": e.employee_code,
            "name": f"{e.first_name} {e.last_name}",
            "gender": e.gender or "",
            "department": e.department.name if e.department_id else "",
            "designation": e.designation.title if e.designation_id else "",
            "branch": e.branch.name if e.branch_id else "",
            "employmentType": e.employment_type,
            "salaryAmount": float(e.salary_amount or 0),
            "phone": e.phone or "",
            "email": e.email or "",
            "joinDate": e.join_date or "",
        }
        for e in qs
    ]
    return Response({"count": len(results), "month": month, "year": year, "results": results})

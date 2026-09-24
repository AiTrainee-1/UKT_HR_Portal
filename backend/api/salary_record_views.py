"""Legacy SalaryRecord list/create/update and the attendance-based salary calculator."""

from .auth import get_token_employee_id, require_auth, require_hr
from .models import Attendance, Employee, Payroll, SalaryRecord
from .serializers import parse_decimal, salary_record_json
from .view_common import _employee_name, _error
from decimal import Decimal
from django.db.models import Count, Q
from rest_framework.decorators import api_view
from rest_framework.request import Request
from rest_framework.response import Response


# --- Salary ---


def _salary_with_name(record: SalaryRecord) -> dict:
    name = _employee_name(record.employee_id)
    return salary_record_json(record, name)


def _salary_from_payroll(payroll: Payroll) -> dict:
    return {
        "id": payroll.id,
        "employeeId": payroll.employee_id,
        "month": payroll.month,
        "year": payroll.year,
        "amount": float(payroll.final_salary),
        "type": payroll.salary_mode,
        "status": payroll.status,
        "notes": payroll.notes,
        "createdAt": payroll.created_at.isoformat() if payroll.created_at else None,
    }


@api_view(["GET", "POST"])
def salary_records(request: Request) -> Response:
    if request.method == "GET":
        return require_auth(_salary_records_list)(request)
    return require_hr(_salary_records_create)(request)


def _salary_records_list(request: Request) -> Response:
    employee_id = request.query_params.get("employeeId")
    month = request.query_params.get("month")
    year = request.query_params.get("year")

    # An employee token only ever sees its own payroll, whatever employeeId says.
    if (token_emp_id := get_token_employee_id(request)) is not None:
        employee_id = token_emp_id

    if not employee_id:
        return _error("employeeId required", 400)

    employee_id = int(employee_id)
    result = []
    
    # Fetch Payroll records (primary source)
    payroll_qs = Payroll.objects.filter(employee_id=employee_id)
    if month:
        payroll_qs = payroll_qs.filter(month=int(month))
    if year:
        payroll_qs = payroll_qs.filter(year=int(year))
    
    for p in payroll_qs:
        result.append({
            "id": p.id,
            "employeeId": p.employee_id,
            "month": p.month,
            "year": p.year,
            "amount": float(p.final_salary),
            "type": p.salary_mode,
            "status": p.status,
            "notes": p.notes,
            "createdAt": p.created_at.isoformat() if p.created_at else None,
        })
    
    # Fallback to SalaryRecord if no Payroll records exist
    if not result:
        salary_qs = SalaryRecord.objects.filter(employee_id=employee_id).select_related("employee")
        if month:
            salary_qs = salary_qs.filter(month=int(month))
        if year:
            salary_qs = salary_qs.filter(year=int(year))
        result = [_salary_with_name(r) for r in salary_qs]
    
    # Sort by year descending, then month descending
    result.sort(key=lambda x: (x["year"], x["month"]), reverse=True)
    return Response(result)


def _salary_records_create(request: Request) -> Response:
    data = request.data
    record = SalaryRecord.objects.create(
        employee_id=data.get("employeeId"),
        month=data.get("month"),
        year=data.get("year"),
        amount=parse_decimal(data.get("amount")),
        type=data.get("type", "monthly"),
        week_number=data.get("weekNumber"),
        status=data.get("status", "pending"),
        notes=data.get("notes"),
    )
    return Response(_salary_with_name(record), status=201)


@api_view(["PATCH"])
@require_hr
def update_salary_record(request: Request, pk: int) -> Response:
    record = SalaryRecord.objects.filter(pk=pk).first()
    if not record:
        return _error("Not found", 404)
    if "amount" in request.data:
        record.amount = parse_decimal(request.data["amount"])
    if "status" in request.data:
        record.status = request.data["status"]
    if "notes" in request.data:
        record.notes = request.data["notes"]
    record.save()
    return Response(_salary_with_name(record))


def _month_attendance_counts(prefix: str) -> dict[int, tuple[int, int]]:
    """{employee_id: (present_days, total_marked_days)} for every employee
    with at least one Attendance row in the "YYYY-MM" month, in one query.
    calculate_salary_records used to issue two COUNT queries per employee."""
    rows = (
        Attendance.objects.filter(date__startswith=prefix)
        .values("employee_id")
        .annotate(total=Count("id"), present=Count("id", filter=Q(present=True)))
    )
    return {r["employee_id"]: (r["present"], r["total"]) for r in rows}


@api_view(["POST"])
@require_hr
def calculate_salary_records(request: Request) -> Response:
    month = request.data.get("month")
    year = request.data.get("year")
    if not month or not year:
        return _error("Month and year are required", 400)
    
    try:
        month = int(month)
        year = int(year)
    except ValueError:
        return _error("Month and year must be integers", 400)

    # Fetch all active employees
    employees = Employee.objects.filter(status="active")
    generated_count = 0
    updated_count = 0

    prefix = f"{year}-{month:02d}"

    counts = _month_attendance_counts(prefix)

    for emp in employees:
        present_days, total_working_days = counts.get(emp.id, (0, 0))

        if total_working_days == 0:
            # Skip if there's no attendance record for this month
            continue

        if emp.salary_type == "monthly":
            # Per day rate based on 26 days
            per_day = emp.salary_amount / Decimal("26.00")
            calculated_amount = per_day * Decimal(present_days)
            notes = f"Auto-calculated: worked {present_days}/{total_working_days} days. Monthly Base: ₹{emp.salary_amount:,.2f}"
        else: # weekly rate
            # Per day rate based on 6 days
            per_day = emp.salary_amount / Decimal("6.00")
            calculated_amount = per_day * Decimal(present_days)
            notes = f"Auto-calculated: worked {present_days}/{total_working_days} days. Weekly Base: ₹{emp.salary_amount:,.2f}"

        calculated_amount = calculated_amount.quantize(Decimal("0.01"))

        # Check if record already exists
        record, created = SalaryRecord.objects.get_or_create(
            employee=emp,
            month=month,
            year=year,
            defaults={
                "amount": calculated_amount,
                "type": emp.salary_type,
                "status": "pending",
                "notes": notes
            }
        )

        if not created:
            record.amount = calculated_amount
            record.notes = notes
            record.type = emp.salary_type
            record.save()
            updated_count += 1
        else:
            generated_count += 1

    return Response({
        "message": f"Successfully calculated payroll for {month}/{year}.",
        "generated": generated_count,
        "updated": updated_count
    })

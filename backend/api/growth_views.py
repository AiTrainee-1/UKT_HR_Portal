"""
Growth & Final-Attendance API
=============================
• Employee monthly attendance search (weeks 1–5 + totals) with final records
• HR manual overrides (present/absent, late, half-shift) — become authoritative
• Promotions (designation/department history + promote action)
• Salary increments (percent-based, history, initial-salary tracking)
• ID card data + public QR verification endpoint
"""

from datetime import date as date_type, datetime
from decimal import Decimal, InvalidOperation

from rest_framework.decorators import api_view
from rest_framework.request import Request
from rest_framework.response import Response

from .auth import require_hr
from .models import (
    AttendanceDayRecord, AttendanceOverrideRequest, Department, Designation, Employee,
    PayrollSettings, Promotion, SalaryIncrement,
)
from .attendance_final import (
    compute_month_records, compute_day_record, month_summary_from_records,
)


def _emp_by_code_or_id(request) -> Employee | None:
    code = (request.query_params.get("code") or request.data.get("employeeCode", "")
            if hasattr(request, "data") else request.query_params.get("code")) or ""
    emp_id = request.query_params.get("employeeId") or (
        request.data.get("employeeId") if hasattr(request, "data") else None
    )
    if emp_id:
        return Employee.objects.filter(id=emp_id).first()
    if code:
        return Employee.objects.filter(employee_code__iexact=str(code).strip()).first()
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
        "overrideBy": r.override_by,
        "overrideNote": r.override_note,
        "computedMode": r.computed_mode,
    }


# ── Employee monthly attendance (search + weekly table) ────────────────────

@api_view(["GET"])
@require_hr
def employee_monthly_attendance(request: Request) -> Response:
    emp = _emp_by_code_or_id(request)
    if not emp:
        return Response({"error": "Employee not found"}, status=404)

    today = date_type.today()
    month = int(request.query_params.get("month", today.month))
    year = int(request.query_params.get("year", today.year))

    settings = PayrollSettings.get()
    records = compute_month_records(emp, year, month, settings)

    # Weeks: 1–7 → W1, 8–14 → W2, 15–21 → W3, 22–28 → W4, 29+ → W5
    weeks: dict[int, list] = {}
    for r in records:
        w = min(5, (r.date.day - 1) // 7 + 1)
        weeks.setdefault(w, []).append(_record_dict(r))

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
    a prior manual override — restoring the objective computed truth does
    not require approval).

    Any other change is NOT applied directly. It creates a pending
    AttendanceOverrideRequest that a Department Head must approve before the
    AttendanceDayRecord is actually overwritten. This prevents HR from
    unilaterally editing attendance data used by payroll.
    """
    data = request.data
    emp = Employee.objects.filter(id=data.get("employeeId")).first()
    if not emp:
        return Response({"error": "Employee not found"}, status=404)
    try:
        d = date_type.fromisoformat(str(data.get("date")))
    except (ValueError, TypeError):
        return Response({"error": "Invalid date"}, status=400)

    hr_name = getattr(request, "hr_user_name", None) or "HR"

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
        "record": _record_dict(record),  # unchanged — for UI reference
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

    # POST — promote: record history AND apply to the employee
    data = request.data
    emp = Employee.objects.filter(id=data.get("employeeId")).first()
    if not emp:
        return Response({"error": "Employee not found"}, status=404)

    new_dept = Department.objects.filter(id=data.get("newDepartmentId")).first() \
        if data.get("newDepartmentId") else emp.department
    new_desig = Designation.objects.filter(id=data.get("newDesignationId")).first() \
        if data.get("newDesignationId") else emp.designation

    if new_dept == emp.department and new_desig == emp.designation:
        return Response({"error": "No change — select a new designation or department"}, status=400)

    try:
        eff = date_type.fromisoformat(str(data.get("effectiveDate")))
    except (ValueError, TypeError):
        eff = date_type.today()

    promo = Promotion.objects.create(
        employee=emp,
        previous_department=emp.department,
        previous_designation=emp.designation,
        new_department=new_dept,
        new_designation=new_desig,
        effective_date=eff,
        notes=data.get("notes"),
        promoted_by=getattr(request, "hr_user_name", None) or "HR",
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
    emp = Employee.objects.filter(id=data.get("employeeId")).first()
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
        eff = date_type.today()

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
        added_by=getattr(request, "hr_user_name", None) or "HR",
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
@require_hr
def idcard_data(request: Request) -> Response:
    """ID card payload for one employee (?employeeId= / ?code=) or many (?ids=1,2,3)."""
    settings = PayrollSettings.get()
    ids = request.query_params.get("ids")
    if ids:
        id_list = [int(x) for x in ids.split(",") if x.strip().isdigit()]
        emps = Employee.objects.filter(id__in=id_list).select_related("department", "designation")
        return Response([_idcard_dict(e, settings) for e in emps])
    emp = _emp_by_code_or_id(request)
    if not emp:
        return Response({"error": "Employee not found"}, status=404)
    return Response(_idcard_dict(emp, settings))


@api_view(["GET"])
def verify_employee(request: Request, code: str) -> Response:
    """PUBLIC endpoint hit by the QR code — no auth required."""
    emp = (
        Employee.objects.filter(employee_code__iexact=code.strip())
        .select_related("department", "designation")
        .first()
    )
    settings = PayrollSettings.get()
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


@api_view(["POST"])
@require_hr
def email_idcard(request: Request) -> Response:
    """Send an employee's ID card by email. Body: { employeeId, image? (dataURL) }"""
    import base64
    import re
    import smtplib
    from email.mime.image import MIMEImage
    from email.mime.multipart import MIMEMultipart
    from email.mime.text import MIMEText

    data = request.data
    emp = Employee.objects.filter(id=data.get("employeeId")).first()
    if not emp:
        return Response({"error": "Employee not found"}, status=404)
    to_email = data.get("toEmail") or emp.email
    if not to_email:
        return Response({"error": "Employee has no email address"}, status=400)

    s = PayrollSettings.get()
    if not (s.smtp_username and s.smtp_password):
        return Response({"error": "SMTP is not configured in Settings"}, status=400)

    msg = MIMEMultipart()
    msg["Subject"] = f"Your Employee ID Card — {s.slip_company_name}"
    msg["From"] = f"{s.smtp_from_name} <{s.smtp_from_email or s.smtp_username}>"
    msg["To"] = to_email
    msg.attach(MIMEText(
        f"<p>Dear {emp.first_name},</p>"
        f"<p>Please find your employee ID card attached.</p>"
        f"<p>Regards,<br>{s.smtp_from_name}</p>",
        "html",
    ))

    image = data.get("image")
    if image:
        m = re.match(r"data:image/(png|jpe?g);base64,(.+)", image)
        if m:
            img_bytes = base64.b64decode(m.group(2))
            part = MIMEImage(img_bytes, _subtype=m.group(1))
            part.add_header(
                "Content-Disposition", "attachment",
                filename=f"idcard-{emp.employee_code}.{m.group(1)}",
            )
            msg.attach(part)

    try:
        with smtplib.SMTP(s.smtp_host, s.smtp_port, timeout=20) as server:
            server.starttls()
            server.login(s.smtp_username, s.smtp_password)
            server.send_message(msg)
    except Exception as e:  # noqa: BLE001 — report SMTP failure to the UI
        return Response({"error": f"Email failed: {e}"}, status=502)

    return Response({"ok": True, "sentTo": to_email})

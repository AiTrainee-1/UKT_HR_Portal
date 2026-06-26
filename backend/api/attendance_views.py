import calendar
from collections import defaultdict
from datetime import date as date_type, datetime, time as time_type, timedelta

from django.db.models import Count, Q
from rest_framework.decorators import api_view
from rest_framework.request import Request
from rest_framework.response import Response

from .auth import require_hr
from .models import (
    Attendance, AttendanceLog, Employee, EmployeeShiftAssignment, LeaveRequest,
)

# API key the AiFace-Mars device must send in the X-Device-Key header.
# Set BIOMETRIC_API_KEY in your .env file — never hardcode this value.


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


def _leave_ids(d: date_type) -> set[int]:
    return set(
        LeaveRequest.objects.filter(
            status="approved",
            start_date__lte=str(d),
            end_date__gte=str(d),
        ).values_list("employee_id", flat=True)
    )


def _late_count(d: date_type) -> int:
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

    total = Employee.objects.filter(status="active").count()
    prod_total = Employee.objects.filter(status="active", employment_type="production").count()
    staff_total = Employee.objects.filter(status="active", employment_type="staff").count()

    bio_ids = _punched_ids(d)
    manual_ids = _manual_present_ids(d)
    present_ids = bio_ids | manual_ids

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
    y_present_ids = y_bio | y_manual
    y_leave = _leave_ids(yesterday)
    y_late = _late_count(yesterday)
    y_absent = max(0, total - len(y_present_ids) - len(y_leave & (set(range(total + 1)) - y_present_ids)))

    return Response({
        "date": str(d),
        "totalEmployees": total,
        "productionTotal": prod_total,
        "staffTotal": staff_total,
        "presentToday": present_today,
        "biometricPresent": len(bio_ids - manual_ids),
        "manualPresent": len(manual_ids),
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
    if emp_type:
        qs = qs.filter(employment_type=emp_type)

    results = []
    for emp in qs:
        emp_logs = logs_by_emp.get(emp.id, [])
        manual = manual_by_emp.get(emp.id)

        if emp_logs:
            first_in = next((l for l in emp_logs if l.punch_type == "IN"), None)
            last_out = next((l for l in reversed(emp_logs) if l.punch_type == "OUT"), None)
            status = "present"
            source = emp_logs[0].source
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
            "totalPunches": len(emp_logs),
        })

    return Response(results)


# ── Monthly trend ─────────────────────────────────────────────────────────────

@api_view(["GET"])
@require_hr
def attendance_monthly_trend(request: Request) -> Response:
    year = int(request.query_params.get("year", _today().year))
    month = int(request.query_params.get("month", _today().month))

    total = Employee.objects.filter(status="active").count()

    bio_daily = {
        str(row["date"]): row["cnt"]
        for row in AttendanceLog.objects
        .filter(date__year=year, date__month=month)
        .values("date")
        .annotate(cnt=Count("employee_id", distinct=True))
    }

    prefix = f"{year}-{str(month).zfill(2)}"
    manual_daily: dict[str, int] = defaultdict(int)
    for a in Attendance.objects.filter(date__startswith=prefix, present=True):
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
@require_hr
def attendance_employee_history(request: Request, pk: int) -> Response:
    try:
        emp = Employee.objects.select_related("department", "designation").get(pk=pk)
    except Employee.DoesNotExist:
        return Response({"error": "Employee not found"}, status=404)

    month = request.query_params.get("month")
    year = request.query_params.get("year")

    logs_qs = AttendanceLog.objects.filter(employee_id=pk).order_by("date", "punch_time")
    att_qs = Attendance.objects.filter(employee_id=pk).order_by("-date")

    if year:
        logs_qs = logs_qs.filter(date__year=int(year))
        att_qs = att_qs.filter(date__startswith=str(year))
    if month and year:
        logs_qs = logs_qs.filter(date__month=int(month))
        prefix = f"{year}-{str(month).zfill(2)}"
        att_qs = att_qs.filter(date__startswith=prefix)

    by_date: dict[str, list] = defaultdict(list)
    for log in logs_qs:
        by_date[str(log.date)].append({
            "time": log.punch_time.strftime("%H:%M"),
            "type": log.punch_type,
            "source": log.source,
        })

    manual_by_date = {str(a.date): a for a in att_qs}

    all_dates = sorted(set(list(by_date.keys()) + list(manual_by_date.keys())), reverse=True)

    records = []
    for date_str in all_dates:
        punches = by_date.get(date_str, [])
        manual = manual_by_date.get(date_str)
        first_in = next((p["time"] for p in punches if p["type"] == "IN"), None)
        last_out = next((p["time"] for p in reversed(punches) if p["type"] == "OUT"), None)
        present = bool(punches) or bool(manual and manual.present)
        records.append({
            "date": date_str,
            "present": present,
            "firstPunch": first_in,
            "lastPunch": last_out,
            "totalPunches": len(punches),
            "punches": punches,
            "hoursWorked": str(manual.hours_worked) if manual and manual.hours_worked else None,
            "source": punches[0]["source"] if punches else ("manual" if manual else None),
            "notes": manual.notes if manual else None,
        })

    return Response({
        "employee": {
            "id": emp.id,
            "code": emp.employee_code,
            "name": f"{emp.first_name} {emp.last_name}",
            "department": emp.department.name if emp.department else None,
            "designation": emp.designation.title if emp.designation else None,
            "employmentType": emp.employment_type,
        },
        "records": records,
        "totalPresent": sum(1 for r in records if r["present"]),
        "totalAbsent": sum(1 for r in records if not r["present"]),
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
        return Response({"error": "personId and time are required"}, status=400)

    emp = Employee.objects.filter(
        Q(employee_code=str(person_id)) | Q(id=str(person_id))
    ).first()
    if not emp:
        return Response({"error": f"Employee '{person_id}' not found"}, status=404)

    try:
        if isinstance(punch_time_raw, (int, float)):
            from datetime import timezone
            dt = datetime.fromtimestamp(punch_time_raw, tz=timezone.utc).astimezone()
        else:
            dt = datetime.fromisoformat(str(punch_time_raw).replace("Z", "+00:00"))
    except (ValueError, TypeError):
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

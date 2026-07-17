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
from .models import (
    Attendance, AttendanceLog, Employee, EmployeeShiftAssignment, LeaveRequest,
    DailyShiftLog, MonthlyShiftSummary,
)

logger = logging.getLogger(__name__)

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

    bio_ids = _punched_ids(d)
    manual_ids = _manual_present_ids(d)
    if restrict_ids is not None:
        bio_ids &= restrict_ids
        manual_ids &= restrict_ids
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
    qs = scope_to_branch(qs, request)
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

    today = date_type.today()
    month = int(request.query_params.get("month") or today.month)
    year  = int(request.query_params.get("year")  or today.year)
    _, days_in_month = calendar.monthrange(year, month)

    # Punch logs for the month
    logs_qs = AttendanceLog.objects.filter(
        employee_id=pk, date__year=year, date__month=month,
    ).order_by("date", "punch_time")

    # Manual attendance records
    prefix = f"{year}-{str(month).zfill(2)}"
    att_qs = Attendance.objects.filter(employee_id=pk, date__startswith=prefix)

    # Approved leaves that overlap with this month
    leave_qs = LeaveRequest.objects.filter(employee_id=pk, status="approved")

    # Build punch map
    by_date: dict[str, list] = defaultdict(list)
    for log in logs_qs:
        by_date[str(log.date)].append({
            "time": log.punch_time.strftime("%H:%M"),
            "type": log.punch_type,
            "source": log.source,
        })

    manual_by_date = {str(a.date): a for a in att_qs}

    # Build leave date map
    leave_dates: dict[str, str] = {}
    for leave in leave_qs:
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
    present_count = absent_count = on_leave_count = 0

    for day in range(1, days_in_month + 1):
        cur_date = date_type(year, month, day)
        date_str = cur_date.isoformat()
        is_sunday = cur_date.weekday() == 6
        is_future = cur_date > today

        punches   = by_date.get(date_str, [])
        manual    = manual_by_date.get(date_str)
        first_in  = next((p["time"] for p in punches if p["type"] == "IN"), None)
        last_out  = next((p["time"] for p in reversed(punches) if p["type"] == "OUT"), None)
        has_punch = bool(punches) or bool(manual and manual.present)

        if is_sunday:
            status = "holiday"
        elif is_future:
            status = "future"
        elif date_str in leave_dates:
            status = "on_leave"
            on_leave_count += 1
        elif has_punch:
            status = "present"
            present_count += 1
        else:
            status = "absent"
            absent_count += 1

        records.append({
            "date":        date_str,
            "day":         cur_date.strftime("%a"),
            "status":      status,
            "present":     has_punch,
            "firstPunch":  first_in,
            "lastPunch":   last_out,
            "totalPunches": len(punches),
            "punches":     punches,
            "leaveType":   leave_dates.get(date_str),
            "hoursWorked": str(manual.hours_worked) if manual and manual.hours_worked else None,
            "source":      punches[0]["source"] if punches else ("manual" if manual else None),
            "notes":       manual.notes if manual else None,
        })

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
            "present": present_count,
            "absent":  absent_count,
            "onLeave": on_leave_count,
            "late":    0,
        },
        "totalPresent": present_count,
        "totalAbsent":  absent_count,
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


# ── Biometric Sync ────────────────────────────────────────────────────────────
# Two device sources, both supported together:
#   • backend/.env (BIOMETRIC_DEVICE_IP/PORT/PASSWORD) — always works, unchanged
#   • Settings → Devices — any number of additional devices added from the UI

def _date_from_for_mode(mode: str):
    """mode: 'day' | 'week' | 'month' | 'all' — the only 4 sync ranges HR needs."""
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

    # Progress-tracking only (UI pipeline) — does not affect the sync itself.
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
        # Days where one employee logged 6+ punches — almost always means the
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
    device_id = request.data.get("deviceId")     # int | "env" | "all" | None
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


def _full_day_row(emp, rec, shift, dsl, cl, perm) -> dict:
    """
    One employee's full attendance picture for one day — used by the
    redesigned Report Log page. Built entirely from data the existing
    engines already compute (AttendanceDayRecord / DailyShiftLog / Casual
    Leave / Permission); nothing here recalculates anything.
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
        "source": rec.source,
    }


@api_view(["GET"])
@require_hr
def attendance_report_log(request: Request) -> Response:
    """
    GET /api/attendance/report-log/?date=2026-07-01
        → every active staff employee's full attendance picture for that date
          (present, absent, on leave, holiday — everyone, not just those who punched)

    GET /api/attendance/report-log/?month=7&year=2026&employeeId=123
        → one employee's full month, day by day

    Built on the same AttendanceDayRecord/DailyShiftLog engines used
    everywhere else (compute_day_record / compute_daily_shift_log via
    compute_month_records) — this endpoint only reads and joins their
    output for display, it does not change how anything is calculated.
    Casual Leave and Permission rows for the same date(s) are attached so
    a day's full story (shift, punches, late/half/absent, CL, permission)
    is visible in one place.
    """
    from .models import PayrollSettings, CasualLeaveRequest, EmployeePermission
    from .attendance_final import compute_day_record, compute_month_records
    from .shift_engine import _get_shift_for_date

    settings = PayrollSettings.get()
    date_param = request.query_params.get("date")
    month_param = request.query_params.get("month")
    year_param = request.query_params.get("year")
    emp_id_param = request.query_params.get("employeeId")
    is_strict = settings.attendance_mode != "simple"

    if date_param:
        try:
            d = date_type.fromisoformat(date_param)
        except (ValueError, TypeError):
            d = _today()

        emps = list(
            scope_to_branch(Employee.objects, request)
            .filter(status="active", employment_type="staff")
            .select_related("department", "designation")
            .order_by("first_name")
        )
        # Only approved CL/Permission requests are shown here — pending ones
        # aren't final yet and rejected ones didn't happen, so neither belongs
        # on an attendance report.
        cl_map = {c.employee_id: c for c in CasualLeaveRequest.objects.filter(date=d, status="approved")}
        perm_map = {p.employee_id: p for p in EmployeePermission.objects.filter(date=d, status="approved")}

        rows = []
        for emp in emps:
            rec = compute_day_record(emp, d, settings=settings)
            shift = _get_shift_for_date(emp, d)
            dsl = DailyShiftLog.objects.filter(employee=emp, date=d).first() if is_strict else None
            rows.append(_full_day_row(emp, rec, shift, dsl, cl_map.get(emp.id), perm_map.get(emp.id)))
        return Response(rows)

    if month_param and year_param:
        try:
            m = int(month_param)
            y = int(year_param)
        except (ValueError, TypeError):
            return Response({"error": "Invalid month/year"}, status=400)
        if not emp_id_param:
            return Response({"error": "employeeId is required for the month view"}, status=400)
        emp = (
            scope_to_branch(Employee.objects, request)
            .select_related("department", "designation")
            .filter(pk=emp_id_param, status="active")
            .first()
        )
        if not emp:
            return Response({"error": "Employee not found"}, status=404)

        records = compute_month_records(emp, y, m, settings)
        # Only approved CL/Permission requests are shown here — see the
        # matching comment in the day-view branch above.
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
        dsl_map = {}
        if is_strict:
            dsl_map = {
                l.date: l for l in DailyShiftLog.objects.filter(
                    employee=emp, date__year=y, date__month=m,
                )
            }

        rows = []
        for rec in records:
            shift = _get_shift_for_date(emp, rec.date)
            rows.append(_full_day_row(
                emp, rec, shift, dsl_map.get(rec.date),
                cl_map.get(rec.date), perm_map.get(rec.date),
            ))
        return Response(rows)

    return Response({"error": "Provide date or month+year"}, status=400)


@api_view(["POST"])
@require_hr
def compute_shift_logs(request: Request) -> Response:
    """
    POST /api/attendance/compute-shifts/
    Body: { "date": "2026-07-01" }  — recompute for all staff that day
    Body: { "month": 7, "year": 2026 }  — recompute entire month
    Body: { "month": 7, "year": 2026, "employeeId": 123 }  — one employee
    """
    from .shift_engine import compute_daily_shift_log, compute_monthly_shift_summary, recompute_date
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

        for day in range(1, days_in_month + 1):
            d = date_type(y, m, day)
            if d > today_d:
                break
            logs = list(
                AttendanceLog.objects.filter(
                    date=d,
                    employee__in=emps,
                ).select_related("employee")
            )
            by_emp: dict = defaultdict(list)
            for log in logs:
                by_emp[log.employee_id].append(log)

            emp_map = {e.id: e for e in emps}
            for emp in emps:
                punches = by_emp.get(emp.id, [])
                compute_daily_shift_log(emp, d, punches)
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

    # ── DailyShiftLog rows keyed by date ────────────────────────────────────
    shift_logs: dict[date_type, object] = {
        sl.date: sl
        for sl in DailyShiftLog.objects.filter(employee=emp, date__year=y, date__month=m)
    }

    # ── Raw biometric/manual punches keyed by date string ───────────────────
    punches_by_date: dict[str, list] = _dd(list)
    for log in AttendanceLog.objects.filter(
        employee=emp, date__year=y, date__month=m
    ).order_by("date", "punch_time"):
        punches_by_date[log.date.isoformat()].append({
            "time": log.punch_time.strftime("%H:%M"),
            "type": log.punch_type,
            "source": log.source,
        })

    # ── Manual attendance records ────────────────────────────────────────────
    prefix = f"{y}-{str(m).zfill(2)}"
    manual_by_date = {
        str(a.date): a
        for a in Attendance.objects.filter(employee=emp, date__startswith=prefix)
    }

    # ── Approved leave dates ─────────────────────────────────────────────────
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

    # ── Build full daily records for every day in month ──────────────────────
    present_days = half_shift_days = full_shift_days = 0
    absent_days = leave_days = late_morning_days = late_return_days = 0
    total_effective_shifts = _D("0")

    daily = []
    for day in range(1, days_in_month + 1):
        cur = date_type(y, m, day)
        date_str = cur.isoformat()
        is_sunday = cur.weekday() == 6
        is_future = cur > today

        punches = punches_by_date.get(date_str, [])
        manual = manual_by_date.get(date_str)
        has_punch = bool(punches) or bool(manual and manual.present)

        # All punches are stored as "IN" by the biometric device;
        # first punch = morning IN, last punch = evening OUT
        first_in = punches[0]["time"] if punches else None
        last_out = punches[-1]["time"] if len(punches) > 1 else None
        source = punches[0]["source"] if punches else ("manual" if manual else None)

        if is_sunday:
            status = "holiday"
        elif is_future:
            status = "future"
        elif date_str in leave_date_map:
            status = "on_leave"
            leave_days += 1
        elif has_punch:
            status = "present"
            present_days += 1
        else:
            status = "absent"
            absent_days += 1

        sl = shift_logs.get(cur)
        shifts_done = _D("0")
        is_half = False
        late_am = late_ret = False

        if sl:
            shifts_done = sl.shifts_completed
            is_half = shifts_done == _D("0.50")
            late_am = sl.late_morning
            late_ret = sl.late_return
            if status == "present":
                total_effective_shifts += shifts_done
                if is_half:
                    half_shift_days += 1
                elif shifts_done >= _D("1.00"):
                    full_shift_days += 1
        if late_am:
            late_morning_days += 1
        if late_ret:
            late_return_days += 1

        daily.append({
            "date": date_str,
            "day": cur.strftime("%a"),
            "status": status,
            "firstPunch": first_in,
            "lastPunch": last_out,
            "totalPunches": len(punches),
            "source": source,
            "leaveType": leave_date_map.get(date_str),
            "shiftsCompleted": str(shifts_done) if sl else None,
            "isHalfShift": is_half,
            "lateMorning": late_am,
            "lateReturn": late_ret,
        })

    total_late = late_morning_days + late_return_days

    # ── MonthlyShiftSummary (payroll engine result) ──────────────────────────
    try:
        s = MonthlyShiftSummary.objects.get(employee=emp, year=y, month=m)
        summary_data = {
            "totalShifts": str(s.total_shifts),
            "totalLateCount": s.total_late_count,
            "permissionsUsed": s.permissions_used,
            "permissionOverageCount": s.permission_overage_count,
            "billableLateCount": s.billable_late_count,
            "shiftDeductions": str(s.shift_deductions),
            "salaryDeductionAmount": str(s.salary_deduction_amount),
        }
    except MonthlyShiftSummary.DoesNotExist:
        summary_data = None

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

"""
Enterprise Payroll Engine for UK-Textile HRMS
Provides:
  • Session config CRUD
  • Excel / manual punch-log upload
  • Punch-pair → WorkSession processing engine
  • Payroll generation (monthly + session-based)
  • Payroll CRUD
"""
import io
from datetime import date, datetime, time, timedelta
from decimal import Decimal

from rest_framework.decorators import api_view
from rest_framework.request import Request
from rest_framework.response import Response

from .auth import require_hr
from .models import (
    Attendance,
    AttendanceLog,
    Employee,
    Payroll,
    SessionConfig,
    WorkSession,
)


def _error(message: str, code: int = 400) -> Response:
    return Response({"error": message}, status=code)


# ─────────────────────────────────────────────────────────────────────────────
#  Helper serialisers for payroll models
# ─────────────────────────────────────────────────────────────────────────────

def _session_config_json(sc: SessionConfig) -> dict:
    return {
        "id": sc.id,
        "name": sc.name,
        "startTime": sc.start_time.strftime("%H:%M"),
        "endTime": sc.end_time.strftime("%H:%M"),
        "payAmount": float(sc.pay_amount),
        "isOvertime": sc.is_overtime,
        "order": sc.order,
    }


def _att_log_json(log: AttendanceLog) -> dict:
    return {
        "id": log.id,
        "employeeId": log.employee_id,
        "date": log.date.isoformat(),
        "punchTime": log.punch_time.strftime("%H:%M"),
        "punchType": log.punch_type,
        "source": log.source,
    }


def _work_session_json(ws: WorkSession, employee_name: str | None = None) -> dict:
    return {
        "id": ws.id,
        "employeeId": ws.employee_id,
        "employeeName": employee_name,
        "date": ws.date.isoformat(),
        "sessionName": ws.session_name,
        "sessionConfigId": ws.session_config_id,
        "checkIn": ws.check_in.strftime("%H:%M"),
        "checkOut": ws.check_out.strftime("%H:%M"),
        "hoursWorked": float(ws.hours_worked),
        "sessionAmount": float(ws.session_amount),
        "isOvertime": ws.is_overtime,
        "notes": ws.notes,
    }


def _payroll_json(p: Payroll, employee_name: str | None = None) -> dict:
    return {
        "id": p.id,
        "employeeId": p.employee_id,
        "employeeName": employee_name,
        "salaryMode": p.salary_mode,
        "month": p.month,
        "year": p.year,
        "weekNumber": p.week_number,
        "totalWorkingDays": p.total_working_days,
        "presentDays": float(p.present_days),
        "absentDays": float(p.absent_days),
        "completedSessions": p.completed_sessions,
        "otHours": float(p.ot_hours),
        "otAmount": float(p.ot_amount),
        "baseSalary": float(p.base_salary),
        "grossSalary": float(p.gross_salary),
        "deductions": float(p.deductions),
        "bonus": float(p.bonus),
        "finalSalary": float(p.final_salary),
        "status": p.status,
        "notes": p.notes,
        "createdAt": p.created_at.isoformat() if p.created_at else None,
    }


# ─────────────────────────────────────────────────────────────────────────────
#  Session Config CRUD
# ─────────────────────────────────────────────────────────────────────────────

@api_view(["GET", "POST"])
def session_configs(request: Request) -> Response:
    if request.method == "GET":
        return Response([_session_config_json(sc) for sc in SessionConfig.objects.all()])
    return require_hr(_create_session_config)(request)


def _create_session_config(request: Request) -> Response:
    d = request.data
    try:
        start = time.fromisoformat(d["startTime"])
        end = time.fromisoformat(d["endTime"])
    except (KeyError, ValueError):
        return _error("startTime and endTime required (HH:MM format)")
    sc = SessionConfig.objects.create(
        name=d.get("name", "Session"),
        start_time=start,
        end_time=end,
        pay_amount=Decimal(str(d.get("payAmount", 0))),
        is_overtime=bool(d.get("isOvertime", False)),
        order=int(d.get("order", 99)),
    )
    return Response(_session_config_json(sc), status=201)


@api_view(["PATCH", "DELETE"])
@require_hr
def session_config_detail(request: Request, pk: int) -> Response:
    sc = SessionConfig.objects.filter(pk=pk).first()
    if not sc:
        return _error("Not found", 404)
    if request.method == "DELETE":
        sc.delete()
        return Response(status=204)
    d = request.data
    if "name" in d:
        sc.name = d["name"]
    if "startTime" in d:
        sc.start_time = time.fromisoformat(d["startTime"])
    if "endTime" in d:
        sc.end_time = time.fromisoformat(d["endTime"])
    if "payAmount" in d:
        sc.pay_amount = Decimal(str(d["payAmount"]))
    if "isOvertime" in d:
        sc.is_overtime = bool(d["isOvertime"])
    if "order" in d:
        sc.order = int(d["order"])
    sc.save()
    return Response(_session_config_json(sc))


# ─────────────────────────────────────────────────────────────────────────────
#  Attendance Logs (punch-level)
# ─────────────────────────────────────────────────────────────────────────────

@api_view(["GET", "POST"])
@require_hr
def attendance_logs(request: Request) -> Response:
    if request.method == "GET":
        qs = AttendanceLog.objects.select_related("employee").order_by("-date", "punch_time")
        emp_id = request.query_params.get("employeeId")
        date_str = request.query_params.get("date")
        month = request.query_params.get("month")
        year = request.query_params.get("year")
        if emp_id:
            qs = qs.filter(employee_id=int(emp_id))
        if date_str:
            qs = qs.filter(date=date_str)
        if year:
            qs = qs.filter(date__year=int(year))
        if month:
            qs = qs.filter(date__month=int(month))
        return Response([_att_log_json(l) for l in qs[:500]])

    # POST – single manual punch entry
    d = request.data
    try:
        log_date = date.fromisoformat(d["date"])
        punch_time_val = time.fromisoformat(d["punchTime"])
    except (KeyError, ValueError):
        return _error("date (YYYY-MM-DD) and punchTime (HH:MM) required")
    log = AttendanceLog.objects.create(
        employee_id=d["employeeId"],
        date=log_date,
        punch_time=punch_time_val,
        punch_type=d.get("punchType", "IN"),
        source="manual",
    )
    return Response(_att_log_json(log), status=201)


@api_view(["POST"])
@require_hr
def upload_attendance_excel(request: Request) -> Response:
    """
    Parse an Excel file with columns:
      Employee ID | Employee Name | Date | Time | Type
    Date format: DD-MM-YYYY or YYYY-MM-DD
    Time format: HH:MM
    Type: IN or OUT
    """
    file = request.FILES.get("file")
    if not file:
        return _error("No file uploaded. Send as multipart/form-data with key 'file'.")

    try:
        import pandas as pd
        df = pd.read_excel(io.BytesIO(file.read()))
    except Exception as e:
        return _error(f"Failed to read Excel: {e}")

    # Normalise column names
    df.columns = [str(c).strip().lower().replace(" ", "_") for c in df.columns]

    # Detect columns
    id_col = next((c for c in df.columns if "employee" in c and "id" in c), None)
    date_col = next((c for c in df.columns if "date" in c), None)
    time_col = next((c for c in df.columns if "time" in c), None)
    type_col = next((c for c in df.columns if "type" in c), None)

    if not all([id_col, date_col, time_col, type_col]):
        return _error(
            f"Could not find required columns. Detected: {list(df.columns)}. "
            "Expected: Employee ID, Date, Time, Type"
        )

    created = 0
    skipped = 0
    errors = []

    for idx, row in df.iterrows():
        try:
            emp_id = int(row[id_col])
            emp = Employee.objects.filter(id=emp_id).first()
            if not emp:
                errors.append(f"Row {idx+2}: Employee ID {emp_id} not found.")
                skipped += 1
                continue

            # Parse date
            raw_date = str(row[date_col]).strip()
            for fmt in ("%d-%m-%Y", "%Y-%m-%d", "%d/%m/%Y", "%m/%d/%Y"):
                try:
                    log_date = datetime.strptime(raw_date, fmt).date()
                    break
                except ValueError:
                    continue
            else:
                errors.append(f"Row {idx+2}: Cannot parse date '{raw_date}'.")
                skipped += 1
                continue

            # Parse time
            raw_time = str(row[time_col]).strip()
            if ":" not in raw_time:
                raw_time = raw_time[:2] + ":" + raw_time[2:]
            punch_time_val = time.fromisoformat(raw_time[:5])

            punch_type = str(row[type_col]).strip().upper()
            if punch_type not in ("IN", "OUT"):
                punch_type = "IN"

            AttendanceLog.objects.create(
                employee=emp,
                date=log_date,
                punch_time=punch_time_val,
                punch_type=punch_type,
                source="excel",
            )
            created += 1
        except Exception as e:
            errors.append(f"Row {idx+2}: {e}")
            skipped += 1

    return Response({
        "message": f"Imported {created} punch logs, skipped {skipped}.",
        "created": created,
        "skipped": skipped,
        "errors": errors[:20],  # Return at most 20 errors
    }, status=201)


# ─────────────────────────────────────────────────────────────────────────────
#  Session Processing Engine – converts punch pairs → WorkSessions
# ─────────────────────────────────────────────────────────────────────────────

def _match_session_config(check_in: time, check_out: time) -> SessionConfig | None:
    """Match an IN/OUT pair to the closest SessionConfig by start_time proximity."""
    configs = SessionConfig.objects.all()
    best = None
    best_delta = timedelta(hours=999)
    for cfg in configs:
        delta = abs(
            timedelta(hours=check_in.hour, minutes=check_in.minute)
            - timedelta(hours=cfg.start_time.hour, minutes=cfg.start_time.minute)
        )
        if delta < best_delta:
            best_delta = delta
            best = cfg
    # Only match if within 90 minutes
    return best if best_delta <= timedelta(minutes=90) else None


def _compute_hours(check_in: time, check_out: time) -> Decimal:
    dt_in = datetime.combine(date.today(), check_in)
    dt_out = datetime.combine(date.today(), check_out)
    if dt_out <= dt_in:
        dt_out += timedelta(days=1)  # crosses midnight
    diff = (dt_out - dt_in).total_seconds() / 3600
    return Decimal(str(round(diff, 2)))


@api_view(["POST"])
@require_hr
def process_punch_sessions(request: Request) -> Response:
    """
    Convert AttendanceLogs (IN/OUT pairs) into WorkSessions.
    Accepts: { month, year, employeeId? }
    """
    month = request.data.get("month")
    year = request.data.get("year")
    emp_filter_id = request.data.get("employeeId")

    if not month or not year:
        return _error("month and year are required")

    try:
        month, year = int(month), int(year)
    except ValueError:
        return _error("month and year must be integers")

    qs = AttendanceLog.objects.filter(date__year=year, date__month=month).order_by("employee_id", "date", "punch_time")
    if emp_filter_id:
        qs = qs.filter(employee_id=int(emp_filter_id))

    # Delete existing WorkSessions for this period (re-process)
    ws_qs = WorkSession.objects.filter(date__year=year, date__month=month)
    if emp_filter_id:
        ws_qs = ws_qs.filter(employee_id=int(emp_filter_id))
    ws_qs.delete()

    # Group logs by employee → date
    from collections import defaultdict
    grouped: dict[int, dict[date, list[AttendanceLog]]] = defaultdict(lambda: defaultdict(list))
    for log in qs:
        grouped[log.employee_id][log.date].append(log)

    created_count = 0
    for emp_id, date_logs in grouped.items():
        emp = Employee.objects.filter(id=emp_id).first()
        if not emp:
            continue
        for log_date, logs in date_logs.items():
            ins = [l for l in logs if l.punch_type == "IN"]
            outs = [l for l in logs if l.punch_type == "OUT"]
            # Pair IN→OUT sequentially
            pairs = list(zip(ins, outs))
            for in_log, out_log in pairs:
                check_in = in_log.punch_time
                check_out = out_log.punch_time
                hours = _compute_hours(check_in, check_out)
                cfg = _match_session_config(check_in, check_out)
                session_name = cfg.name if cfg else "Custom"
                session_amount = cfg.pay_amount if cfg else (hours * Decimal("80"))
                is_ot = cfg.is_overtime if cfg else False
                WorkSession.objects.create(
                    employee=emp,
                    date=log_date,
                    session_config=cfg,
                    session_name=session_name,
                    check_in=check_in,
                    check_out=check_out,
                    hours_worked=hours,
                    session_amount=session_amount,
                    is_overtime=is_ot,
                )
                created_count += 1

    return Response({
        "message": f"Processed sessions for {month}/{year}. Created {created_count} work sessions.",
        "created": created_count,
    })


# ─────────────────────────────────────────────────────────────────────────────
#  Work Sessions – list / edit
# ─────────────────────────────────────────────────────────────────────────────

@api_view(["GET"])
@require_hr
def work_sessions(request: Request) -> Response:
    qs = WorkSession.objects.select_related("employee").order_by("-date", "check_in")
    emp_id = request.query_params.get("employeeId")
    month = request.query_params.get("month")
    year = request.query_params.get("year")
    if emp_id:
        qs = qs.filter(employee_id=int(emp_id))
    if year:
        qs = qs.filter(date__year=int(year))
    if month:
        qs = qs.filter(date__month=int(month))
    result = []
    for ws in qs[:500]:
        emp = ws.employee
        name = f"{emp.first_name} {emp.last_name}" if emp else None
        result.append(_work_session_json(ws, name))
    return Response(result)


@api_view(["PATCH", "DELETE"])
@require_hr
def work_session_detail(request: Request, pk: int) -> Response:
    ws = WorkSession.objects.select_related("employee").filter(pk=pk).first()
    if not ws:
        return _error("Not found", 404)
    if request.method == "DELETE":
        ws.delete()
        return Response(status=204)
    d = request.data
    if "checkIn" in d:
        ws.check_in = time.fromisoformat(d["checkIn"])
    if "checkOut" in d:
        ws.check_out = time.fromisoformat(d["checkOut"])
    if "sessionAmount" in d:
        ws.session_amount = Decimal(str(d["sessionAmount"]))
    if "sessionName" in d:
        ws.session_name = d["sessionName"]
    if "notes" in d:
        ws.notes = d["notes"]
    ws.hours_worked = _compute_hours(ws.check_in, ws.check_out)
    ws.save()
    emp = ws.employee
    return Response(_work_session_json(ws, f"{emp.first_name} {emp.last_name}" if emp else None))


# ─────────────────────────────────────────────────────────────────────────────
#  Payroll Engine – generate / list / update
# ─────────────────────────────────────────────────────────────────────────────

def _generate_monthly_payroll(emp: Employee, month: int, year: int) -> Payroll | None:
    """Monthly payroll engine: full/half day based on session presence."""
    prefix = f"{year}-{month:02d}"

    # Count days with attendance logs (each day the employee punched)
    from collections import defaultdict
    log_qs = AttendanceLog.objects.filter(
        employee=emp, date__year=year, date__month=month
    ).order_by("date", "punch_time")

    # Group by date → list of logs
    day_logs: dict[date, list] = defaultdict(list)
    for log in log_qs:
        day_logs[log.date].append(log)

    total_days = len(day_logs)
    if total_days == 0:
        # Fallback to old simple attendance table
        present_count = Attendance.objects.filter(
            employee=emp, date__startswith=prefix, present=True
        ).count()
        total_count = Attendance.objects.filter(employee=emp, date__startswith=prefix).count()
        if total_count == 0:
            return None
        present_days = Decimal(str(present_count))
        absent_days = Decimal(str(total_count - present_count))
        total_days = total_count
    else:
        present_days = Decimal("0")
        for _date, logs in day_logs.items():
            ins = [l for l in logs if l.punch_type == "IN"]
            outs = [l for l in logs if l.punch_type == "OUT"]
            sessions_today = min(len(ins), len(outs))
            if sessions_today >= 2:
                present_days += Decimal("1")    # Full day
            elif sessions_today == 1:
                present_days += Decimal("0.5")  # Half day
        absent_days = Decimal(str(total_days)) - present_days

    if not emp.salary_amount:
        return None

    per_day = emp.salary_amount / Decimal("26")
    gross = (per_day * present_days).quantize(Decimal("0.01"))

    # OT – count any sessions with is_overtime=True
    ot_sessions = WorkSession.objects.filter(
        employee=emp, date__year=year, date__month=month, is_overtime=True
    )
    ot_amount = sum(ws.session_amount for ws in ot_sessions) or Decimal("0")
    ot_hours = sum(ws.hours_worked for ws in ot_sessions) or Decimal("0")

    final = (gross + ot_amount).quantize(Decimal("0.01"))

    lookup = {
        "employee": emp,
        "month": month,
        "year": year,
        "week_number": None,
    }
    existing_payrolls = Payroll.objects.filter(**lookup).order_by("id")
    if existing_payrolls.count() > 1:
        existing_payrolls.exclude(pk=existing_payrolls.first().pk).delete()
    existing = existing_payrolls.first()
    if existing and existing.status == Payroll.STATUS_PAID:
        return existing

    payroll, _ = Payroll.objects.update_or_create(
        **lookup,
        defaults=dict(
            salary_mode="monthly",
            total_working_days=total_days,
            present_days=present_days,
            absent_days=absent_days,
            completed_sessions=int(present_days * 2),
            ot_hours=ot_hours,
            ot_amount=ot_amount,
            base_salary=emp.salary_amount,
            gross_salary=gross,
            deductions=Decimal("0"),
            bonus=Decimal("0"),
            final_salary=final,
            status="pending",
            notes=(
                f"Monthly payroll: {present_days} days present ({absent_days} absent) "
                f"out of {total_days} working days. OT: {ot_hours}h = ₹{ot_amount}"
            ),
        ),
    )
    return payroll


def _generate_session_payroll(emp: Employee, month: int, year: int) -> Payroll | None:
    """Session-based payroll engine for tailors/weekly workers."""
    sessions = WorkSession.objects.filter(
        employee=emp, date__year=year, date__month=month
    )
    if not sessions.exists():
        return None

    total_amount = sum(ws.session_amount for ws in sessions)
    ot_sessions = [ws for ws in sessions if ws.is_overtime]
    ot_amount = sum(ws.session_amount for ws in ot_sessions)
    ot_hours = sum(ws.hours_worked for ws in ot_sessions)
    total_hours = sum(ws.hours_worked for ws in sessions)

    # Attendance days (distinct dates with sessions)
    distinct_dates = sessions.values("date").distinct().count()

    lookup = {
        "employee": emp,
        "month": month,
        "year": year,
        "week_number": None,
    }
    existing_payrolls = Payroll.objects.filter(**lookup).order_by("id")
    if existing_payrolls.count() > 1:
        existing_payrolls.exclude(pk=existing_payrolls.first().pk).delete()
    existing = existing_payrolls.first()
    if existing and existing.status == Payroll.STATUS_PAID:
        return existing

    payroll, _ = Payroll.objects.update_or_create(
        **lookup,
        defaults=dict(
            salary_mode="session",
            total_working_days=distinct_dates,
            present_days=Decimal(str(distinct_dates)),
            absent_days=Decimal("0"),
            completed_sessions=sessions.count(),
            ot_hours=ot_hours,
            ot_amount=ot_amount,
            base_salary=Decimal(str(total_amount)),
            gross_salary=Decimal(str(total_amount)),
            deductions=Decimal("0"),
            bonus=Decimal("0"),
            final_salary=Decimal(str(total_amount)).quantize(Decimal("0.01")),
            status="pending",
            notes=(
                f"Session payroll: {sessions.count()} sessions, "
                f"{float(total_hours):.1f}h total, "
                f"OT: {float(ot_hours):.1f}h = ₹{float(ot_amount):.2f}"
            ),
        ),
    )
    return payroll


@api_view(["GET"])
@require_hr
def payroll_list(request: Request) -> Response:
    qs = Payroll.objects.select_related("employee").order_by("-year", "-month", "employee__first_name")
    emp_id = request.query_params.get("employeeId")
    month = request.query_params.get("month")
    year = request.query_params.get("year")
    status_filter = request.query_params.get("status")
    if emp_id:
        qs = qs.filter(employee_id=int(emp_id))
    if month:
        qs = qs.filter(month=int(month))
    if year:
        qs = qs.filter(year=int(year))
    if status_filter:
        qs = qs.filter(status=status_filter)
    result = []
    for p in qs:
        emp = p.employee
        name = f"{emp.first_name} {emp.last_name}" if emp else None
        result.append(_payroll_json(p, name))
    return Response(result)


@api_view(["POST"])
@require_hr
def generate_payroll(request: Request) -> Response:
    """Generate payrolls for all active employees for the given month/year."""
    month = request.data.get("month")
    year = request.data.get("year")
    if not month or not year:
        return _error("month and year are required")
    try:
        month, year = int(month), int(year)
    except ValueError:
        return _error("month and year must be integers")

    employees = Employee.objects.filter(status="active")
    generated = []
    skipped = []

    for emp in employees:
        try:
            # Determine mode from salary_type field
            mode = emp.salary_type  # "monthly" or "weekly" / "session"
            if mode == "monthly":
                p = _generate_monthly_payroll(emp, month, year)
            else:
                p = _generate_session_payroll(emp, month, year)

            if p:
                emp_name = f"{emp.first_name} {emp.last_name}"
                generated.append(_payroll_json(p, emp_name))
            else:
                skipped.append({"employeeId": emp.id, "reason": "No attendance data found"})
        except Exception as e:
            skipped.append({"employeeId": emp.id, "reason": str(e)})

    return Response({
        "message": f"Payroll generated for {month}/{year}. {len(generated)} computed, {len(skipped)} skipped.",
        "generated": len(generated),
        "skipped": len(skipped),
        "payrolls": generated,
        "skippedDetails": skipped,
    }, status=201)


@api_view(["PATCH"])
@require_hr
def payroll_detail(request: Request, pk: int) -> Response:
    """Update payroll status, bonus, deductions."""
    p = Payroll.objects.select_related("employee").filter(pk=pk).first()
    if not p:
        return _error("Not found", 404)
    d = request.data
    if "status" in d:
        p.status = d["status"]
    if "bonus" in d:
        p.bonus = Decimal(str(d["bonus"]))
    if "deductions" in d:
        p.deductions = Decimal(str(d["deductions"]))
    if "notes" in d:
        p.notes = d["notes"]
    # Recompute final
    p.final_salary = (p.gross_salary + p.bonus - p.deductions).quantize(Decimal("0.01"))
    p.save()
    emp = p.employee
    return Response(_payroll_json(p, f"{emp.first_name} {emp.last_name}" if emp else None))

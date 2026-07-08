"""
Night Shift Relaxation — Dashboard & Rules API
==============================================
Read/manage the relaxation records produced by night_shift.py and the
DB-driven rule table. All HR-only.
"""

from datetime import date as date_type, datetime, timedelta

from rest_framework.decorators import api_view
from rest_framework.request import Request
from rest_framework.response import Response

from .auth import require_hr
from .models import AttendanceLog, NightShiftRelaxation, NightShiftRule
from .night_shift import (
    MORNING_CUTOFF, detect_night_for_date, ensure_default_rules, record_report,
)


def _parse_time(v):
    try:
        return datetime.strptime(str(v)[:5], "%H:%M").time()
    except (ValueError, TypeError):
        return None


def _relax_dict(r: NightShiftRelaxation, now: datetime | None = None) -> dict:
    emp = r.employee
    today = date_type.today()
    now = now or datetime.now()

    # Status semantics for the dashboard
    if r.reported_at:
        status = "reported_within" if r.within_allowance else "reported_late"
    elif r.relaxation_date == today:
        deadline = datetime.combine(today, r.allowed_until)
        status = "waiting" if now <= deadline else "window_expired"
    elif r.relaxation_date > today:
        status = "waiting"
    else:
        status = "no_report"

    remaining_minutes = None
    if status == "waiting" and r.relaxation_date == today:
        remaining_minutes = max(
            0, int((datetime.combine(today, r.allowed_until) - now).total_seconds() // 60)
        )

    return {
        "id": r.id,
        "employeeId": emp.id,
        "employeeCode": emp.employee_code,
        "employeeName": f"{emp.first_name} {emp.last_name}",
        "department": emp.department.name if emp.department_id and emp.department else None,
        "nightDate": str(r.night_date),
        "relaxationDate": str(r.relaxation_date),
        "lastPunchOut": r.last_punch_out.strftime("%H:%M"),
        "crossedMidnight": r.crossed_midnight,
        "allowedUntil": r.allowed_until.strftime("%H:%M"),
        "ruleName": r.rule.name if r.rule_id and r.rule else None,
        "reportedAt": r.reported_at.strftime("%H:%M") if r.reported_at else None,
        "withinAllowance": r.within_allowance,
        "status": status,
        "remainingMinutes": remaining_minutes,
    }


def _refresh_reported(relaxations) -> None:
    """Fill reported_at for rows whose employee has since punched in."""
    for r in relaxations:
        if r.reported_at:
            continue
        first = (
            AttendanceLog.objects.filter(
                employee_id=r.employee_id,
                date=r.relaxation_date,
                punch_time__gt=MORNING_CUTOFF if r.crossed_midnight else datetime.min.time(),
            )
            .order_by("punch_time")
            .values_list("punch_time", flat=True)
            .first()
        )
        if first:
            record_report(r, first)


# ── Dashboard ────────────────────────────────────────────────────────────────

@api_view(["GET"])
@require_hr
def night_shift_dashboard(request: Request) -> Response:
    """
    ?date=YYYY-MM-DD       → relaxations applying to that day (default: today);
                             detection for the previous night runs automatically.
    ?month=&year=          → all relaxation records in that month.
    ?employeeId= / ?departmentId=  → extra filters (combinable with the above).
    """
    qs = NightShiftRelaxation.objects.select_related("employee__department", "rule")

    month = request.query_params.get("month")
    year = request.query_params.get("year")
    if month and year:
        qs = qs.filter(relaxation_date__year=int(year), relaxation_date__month=int(month))
        detected = None
    else:
        try:
            d = date_type.fromisoformat(request.query_params.get("date", ""))
        except (ValueError, TypeError):
            d = date_type.today()
        # Detect from last night's punches so the dashboard is always current
        detected = detect_night_for_date(d - timedelta(days=1))
        qs = qs.filter(relaxation_date=d)

    if emp_id := request.query_params.get("employeeId"):
        qs = qs.filter(employee_id=emp_id)
    if dept_id := request.query_params.get("departmentId"):
        qs = qs.filter(employee__department_id=dept_id)

    relaxations = list(qs.order_by("-relaxation_date", "employee__first_name")[:400])
    _refresh_reported(relaxations)

    rows = [_relax_dict(r) for r in relaxations]
    return Response({
        "detected": detected,
        "count": len(rows),
        "summary": {
            "reportedWithin": sum(1 for r in rows if r["status"] == "reported_within"),
            "reportedLate": sum(1 for r in rows if r["status"] == "reported_late"),
            "waiting": sum(1 for r in rows if r["status"] == "waiting"),
            "noReport": sum(1 for r in rows if r["status"] in ("no_report", "window_expired")),
        },
        "records": rows,
    })


@api_view(["POST"])
@require_hr
def night_shift_recompute(request: Request) -> Response:
    """
    Body: { "date": "YYYY-MM-DD" }        → re-detect one night
          { "month": 7, "year": 2026 }    → re-detect every night in the month
    """
    data = request.data
    if data.get("date"):
        try:
            d = date_type.fromisoformat(str(data["date"]))
        except (ValueError, TypeError):
            return Response({"error": "Invalid date"}, status=400)
        return Response({"ok": True, "detected": detect_night_for_date(d), "date": str(d)})

    if data.get("month") and data.get("year"):
        import calendar as cal
        m, y = int(data["month"]), int(data["year"])
        today = date_type.today()
        total = 0
        for day in range(1, cal.monthrange(y, m)[1] + 1):
            d = date_type(y, m, day)
            if d >= today:
                break
            total += detect_night_for_date(d)
        return Response({"ok": True, "detected": total, "month": m, "year": y})

    return Response({"error": "Provide date or month+year"}, status=400)


# ── Rules CRUD ───────────────────────────────────────────────────────────────

def _rule_dict(r: NightShiftRule) -> dict:
    return {
        "id": r.id,
        "name": r.name,
        "workedUntil": r.worked_until.strftime("%H:%M"),
        "crossesMidnight": r.crosses_midnight,
        "allowedFirstPunch": r.allowed_first_punch.strftime("%H:%M"),
        "order": r.order,
        "isActive": r.is_active,
    }


@api_view(["GET", "POST"])
@require_hr
def night_shift_rules(request: Request) -> Response:
    ensure_default_rules()
    if request.method == "GET":
        return Response([_rule_dict(r) for r in NightShiftRule.objects.all()])

    data = request.data
    worked_until = _parse_time(data.get("workedUntil"))
    allowed = _parse_time(data.get("allowedFirstPunch"))
    if not data.get("name") or not worked_until or not allowed:
        return Response({"error": "name, workedUntil and allowedFirstPunch are required"}, status=400)
    rule = NightShiftRule.objects.create(
        name=data["name"],
        worked_until=worked_until,
        crosses_midnight=bool(data.get("crossesMidnight", False)),
        allowed_first_punch=allowed,
        order=int(data.get("order", 99)),
        is_active=bool(data.get("isActive", True)),
    )
    return Response(_rule_dict(rule), status=201)


@api_view(["PUT", "DELETE"])
@require_hr
def night_shift_rule_detail(request: Request, pk: int) -> Response:
    rule = NightShiftRule.objects.filter(pk=pk).first()
    if not rule:
        return Response({"error": "Rule not found"}, status=404)

    if request.method == "DELETE":
        rule.delete()
        return Response({"ok": True})

    data = request.data
    if "name" in data:
        rule.name = data["name"]
    if "workedUntil" in data and (t := _parse_time(data["workedUntil"])):
        rule.worked_until = t
    if "allowedFirstPunch" in data and (t := _parse_time(data["allowedFirstPunch"])):
        rule.allowed_first_punch = t
    if "crossesMidnight" in data:
        rule.crosses_midnight = bool(data["crossesMidnight"])
    if "order" in data:
        rule.order = int(data["order"])
    if "isActive" in data:
        rule.is_active = bool(data["isActive"])
    rule.save()
    return Response(_rule_dict(rule))

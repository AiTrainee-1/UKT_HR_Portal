"""
Punch View: a day's status set by hand, and the History page of everything changed from Punch View.

  GET  /api/attendance/punches/day-status?code=188&date=2026-10-05   one employee's day as it stands now
  POST /api/attendance/punches/day-status                            set it Present / Half Day / Absent, or back to automatic
  GET  /api/attendance/punches/history                                what was changed here (filters, paged)

A status set here is applied AT ONCE as HR's own decision (a manual day record: payroll reads it first and the engine never
recomputes it), with a reason, and is written to the History with the status it replaced. It does not go through the
Department Head approval an Attendance Search edit goes through: the page's permission (Attendance Edit) is the control.
Everything the page changes (punches added, edited or deleted by an upload, a day's status set by hand or put back, and the
days whose status changed by itself because their punches changed) is a row in PunchViewHistory.
"""

from __future__ import annotations

import uuid
from decimal import Decimal
from datetime import date as date_type, datetime

from django.db import transaction
from rest_framework.decorators import api_view
from rest_framework.request import Request
from rest_framework.response import Response

from .auth import get_hr_display_name, require_hr
from .branch_scope import scope_to_branch
from .models import AttendanceDayRecord, AttendanceLog, AttendanceOverrideRequest, Employee, PunchViewHistory
from .view_common import error_response as _error

SETTABLE = ("present", "half_shift", "absent", "on_leave", "holiday")
STATUS_LABEL = {
    "present": "Present",
    "half_shift": "Half Day",
    "absent": "Absent",
    "on_leave": "On leave",
    "holiday": "Holiday",
}
MAX_PAGE_SIZE = 200


def new_batch() -> str:
    return uuid.uuid4().hex[:12]


def _actor(request: Request) -> tuple[str, int | None]:
    user = getattr(request, "jwt_user", {}) or {}
    return get_hr_display_name(request), user.get("hrUserId") or user.get("userId")


def day_state(pairs, record_by_pair: dict | None = None) -> dict:
    """{(employee id, date): {"status", "source", "shifts"}} for the days that have a stored attendance record."""
    pairs = set(pairs)
    if not pairs:
        return {}
    emp_ids = {e for e, _d in pairs}
    days = {d for _e, d in pairs}
    out = {}
    for r in AttendanceDayRecord.objects.filter(employee_id__in=emp_ids, date__gte=min(days), date__lte=max(days)).only(
        "employee_id",
        "date",
        "status",
        "source",
        "shifts_earned",
        "is_late",
        "early_leave",
        "first_punch",
        "last_punch",
    ):
        if (r.employee_id, r.date) in pairs:
            out[(r.employee_id, r.date)] = _state_of(r)
    return out


def _shifts(record: AttendanceDayRecord) -> str:
    return str(Decimal(str(record.shifts_earned or 0)).quantize(Decimal("0.01")))


def _state_of(record: AttendanceDayRecord | None) -> dict | None:
    if record is None:
        return None
    return {
        "status": record.status,
        "source": record.source,
        "shifts": _shifts(record),
        "late": bool(record.is_late),
        "earlyOut": bool(record.early_leave),
        "first": record.first_punch.strftime("%H:%M") if record.first_punch else None,
        "last": record.last_punch.strftime("%H:%M") if record.last_punch else None,
    }


def entry(
    request: Request,
    action: str,
    emp: Employee,
    day,
    before=None,
    after=None,
    note: str = "",
    via: str = "page",
    batch: str = "",
) -> PunchViewHistory:
    """An unsaved history row for this request's user."""
    name, actor_id = _actor(request)
    return PunchViewHistory(
        action=action,
        employee=emp,
        employee_code=str(emp.employee_code or ""),
        employee_name=f"{emp.first_name} {emp.last_name}".strip(),
        date=day,
        details={"before": before, "after": after},
        note=note or "",
        via=via,
        batch=batch,
        actor_name=name,
        actor_id=actor_id,
        branch_id=emp.branch_id,
    )


def save_entries(entries: list[PunchViewHistory]) -> None:
    if entries:
        PunchViewHistory.objects.bulk_create(entries, batch_size=500)


def _item(h: PunchViewHistory) -> dict:
    return {
        "id": h.id,
        "action": h.action,
        "actionLabel": dict(PunchViewHistory.ACTION_CHOICES).get(h.action, h.action),
        "employeeId": h.employee_id,
        "employeeCode": h.employee_code,
        "employeeName": h.employee_name,
        "date": str(h.date) if h.date else None,
        "before": (h.details or {}).get("before"),
        "after": (h.details or {}).get("after"),
        "note": h.note,
        "via": h.via,
        "batch": h.batch,
        "actorName": h.actor_name,
        "createdAt": h.created_at.isoformat() if h.created_at else None,
    }


# ── a day's status ──────────────────────────────────────────────────────────


def _day_payload(emp: Employee, d: date_type, record: AttendanceDayRecord) -> dict:
    punches = AttendanceLog.objects.filter(employee=emp, date=d).count()
    return {
        "employeeId": emp.pk,
        "code": emp.employee_code,
        "name": f"{emp.first_name} {emp.last_name}".strip(),
        "employmentType": emp.employment_type,
        "date": str(d),
        "status": record.status,
        "statusLabel": STATUS_LABEL.get(record.status, record.status),
        "source": record.source,
        "shifts": _shifts(record),
        "firstPunch": record.first_punch.strftime("%H:%M") if record.first_punch else None,
        "lastPunch": record.last_punch.strftime("%H:%M") if record.last_punch else None,
        "punchCount": punches,
        "overrideBy": record.override_by,
        "overrideNote": record.override_note,
    }


def _employee_and_day(request: Request, data):
    """(employee, date) from ?code= / employeeId and date, or an error Response."""
    from .clock import ist_today

    qs = scope_to_branch(Employee.objects, request, field="branch_id")
    code = str(data.get("code") or "").strip()
    if code:
        emp = qs.filter(employee_code=code).first()
    else:
        try:
            emp = qs.filter(pk=int(data.get("employeeId"))).first()
        except (TypeError, ValueError):
            emp = None
    if emp is None:
        return None, None, _error("Employee not found", 404)
    try:
        d = date_type.fromisoformat(str(data.get("date"))[:10])
    except (TypeError, ValueError):
        return None, None, _error("Date must look like 2026-10-05")
    if d > ist_today():
        return None, None, _error("A day that has not come yet cannot be set.")
    return emp, d, None


@api_view(["GET", "POST"])
@require_hr
def punch_day_status(request: Request) -> Response:
    from .attendance_final import compute_day_record
    from .growth_views import _resolve_override_fields, apply_override_values

    data = request.query_params if request.method == "GET" else request.data
    emp, d, failure = _employee_and_day(request, data)
    if failure is not None:
        return failure

    record = AttendanceDayRecord.objects.filter(employee=emp, date=d).first() or compute_day_record(emp, d)
    if request.method == "GET":
        return Response(_day_payload(emp, d, record))

    status = str(request.data.get("status") or "").strip()
    note = str(request.data.get("note") or "").strip()
    if status not in SETTABLE + ("auto",):
        return _error("status must be present, half_shift, absent, on_leave, holiday or auto")
    if status != "auto" and len(note) < 3:
        return _error("Give a reason (a few words): it is kept in the History.")
    before = _state_of(record)

    with transaction.atomic():
        # an Attendance Search edit still waiting for approval for this day is overtaken by this decision
        AttendanceOverrideRequest.objects.filter(
            employee=emp, date=d, status=AttendanceOverrideRequest.STATUS_PENDING
        ).update(
            status=AttendanceOverrideRequest.STATUS_REJECTED,
            review_comment="Superseded by a direct update (Punch View history)",
        )
        if status == "auto":
            AttendanceDayRecord.objects.filter(employee=emp, date=d).delete()
            record = compute_day_record(emp, d)
            action = PunchViewHistory.ACTION_STATUS_RESET
        else:
            # the optional details of the Attendance page's edit form: the Late / Early Out marks and the first and last
            # punch a day is shown with (a flag not sent is cleared, as the day is being set by hand)
            req = request.data
            values = {
                "status": status,
                "isLate": bool(req.get("isLate", False)),
                "isEarlyOut": bool(req.get("isEarlyOut", False)),
                "isHalfShift": status == "half_shift",
                "note": note,
            }
            for key in ("firstPunch", "lastPunch"):
                if key in req:
                    values[key] = req.get(key)
            try:
                resolved = _resolve_override_fields(record, emp, values)
            except ValueError as exc:
                return _error(str(exc))
            record = apply_override_values(record, resolved, get_hr_display_name(request))
            action = PunchViewHistory.ACTION_STATUS_SET
        save_entries([entry(request, action, emp, d, before=before, after=_state_of(record), note=note)])

    return Response({"ok": True, "day": _day_payload(emp, d, record)})


# ── the History page ────────────────────────────────────────────────────────


@api_view(["GET"])
@require_hr
def punch_history(request: Request) -> Response:
    """What was changed from Punch View, newest first. Filters: q (Employee Code or name), employeeId, action, from / to
    (the day it was changed, YYYY-MM-DD), page, pageSize. Branch-limited logins see their own branch's rows."""
    from django.db.models import Q

    qs = scope_to_branch(PunchViewHistory.objects.all(), request, field="branch_id")
    p = request.query_params
    if p.get("employeeId"):
        try:
            qs = qs.filter(employee_id=int(p["employeeId"]))
        except ValueError:
            return _error("employeeId must be a number")
    q = (p.get("q") or "").strip()
    if q:
        cond = Q()
        for word in q.split()[:5]:
            cond &= Q(employee_code__icontains=word) | Q(employee_name__icontains=word)
        qs = qs.filter(cond)
    if p.get("action") in dict(PunchViewHistory.ACTION_CHOICES):
        qs = qs.filter(action=p["action"])
    if p.get("by"):
        qs = qs.filter(actor_name__icontains=p["by"].strip())
    for key, lookup in (
        ("from", "created_at__date__gte"),
        ("to", "created_at__date__lte"),
        ("dayFrom", "date__gte"),
        ("dayTo", "date__lte"),
    ):
        if p.get(key):
            try:
                qs = qs.filter(**{lookup: datetime.strptime(p[key][:10], "%Y-%m-%d").date()})
            except ValueError:
                return _error(f"{key} must look like 2026-10-05")
    try:
        page = max(1, int(p.get("page", 1)))
        size = max(1, min(MAX_PAGE_SIZE, int(p.get("pageSize", 50))))
    except ValueError:
        return _error("page and pageSize must be numbers")
    total = qs.count()
    start = (page - 1) * size
    return Response(
        {
            "total": total,
            "page": page,
            "pageSize": size,
            "items": [_item(h) for h in qs[start : start + size]],
        }
    )

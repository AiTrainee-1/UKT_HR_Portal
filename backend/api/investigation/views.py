"""/api/employee-investigation/... - Employees -> Investigation (permission key employees.investigation; it follows
"Activate / deactivate an employee" until a role sets it).

    GET  summary                                   counts for the Employees page button {d15, d30, tonight}
    GET  list?bucket=15|30&kind=all|staff|production   the active employees away 15-29 / 30+ days
    GET  auto?kind=                                 the Auto Trigger: its switch and last run, who the next run would
                                                    inactivate, and everyone it inactivated (with what happened since)
    GET  detail?employeeId=                         one employee's absence: the days, their leave, punches, decisions
    POST inactivate   {employeeIds, reason, bucket}  Mark inactive (edit)
    POST keep-active  {employeeIds, reason, bucket}  Keep active for this absence (edit)
    POST reactivate   {employeeIds, reason}          Make active again (edit)
    PUT  settings     {autoEnabled}                  the Auto Trigger switch (a login for all units)
    POST run-now                                    run the Auto Trigger at once, whatever the switch says (a login for
                                                    all units; the same rules as the nightly run)

GET = view, POST / PUT = edit (HrPermissionMiddleware). Every list only shows the caller's branch scope; the Auto Trigger
itself always runs company-wide.
"""

from __future__ import annotations

from datetime import date, timedelta
from types import SimpleNamespace

from rest_framework.decorators import api_view
from rest_framework.request import Request
from rest_framework.response import Response

from ..audit_utils import log_action
from ..auth import get_hr_display_name, require_hr
from ..branch_scope import get_branch_scope, scope_to_branch
from ..clock import ist_today
from ..compensation_shared import parse_join_date
from .engine import join_of
from ..models import (
    AttendanceLog,
    CasualLeaveRequest,
    Employee,
    EmployeeInvestigation,
    Holiday,
    InvestigationSettings,
    LeaveRequest,
)
from ..unit_labels import unit_label
from . import engine, service

RUN_AT = "01:00"
CALENDAR_DAYS_SHOWN = 120


def _error(message: str, status: int = 400, **extra) -> Response:
    return Response({"error": message, **extra}, status=status)


def _kind_q(qs, kind: str):
    if kind == "production":
        return qs.filter(employment_type=Employee.EMPLOYMENT_TYPE_PRODUCTION)
    if kind == "staff":
        return qs.exclude(employment_type=Employee.EMPLOYMENT_TYPE_PRODUCTION)
    return qs


def _scope(request: Request):
    return scope_to_branch(Employee.objects.all(), request).select_related("department", "designation", "branch")


def _kind(request: Request) -> str:
    kind = str(request.query_params.get("kind") or "all").lower()
    return kind if kind in ("all", "staff", "production") else "all"


def _iso(value):
    return value.isoformat() if value else None


def _name(emp) -> str:
    return f"{emp.first_name or ''} {emp.last_name or ''}".strip()


def decision_json(d: EmployeeInvestigation | None) -> dict | None:
    if d is None:
        return None
    return {
        "id": d.id,
        "action": d.action,
        "actionLabel": d.get_action_display(),
        "reason": d.reason or None,
        "by": d.by or None,
        "at": _iso(d.at),
        "bucket": d.bucket or None,
        "spellStart": _iso(d.spell_start),
        "lastAttended": _iso(d.last_attended),
        "absentDays": d.absent_days,
    }


def _row(emp, spell: engine.Spell, decision: EmployeeInvestigation | None, days: int) -> dict:
    due, why = engine.auto_due(spell, decision, days) if (emp.status or "").lower() == "active" else (False, None)
    joined = join_of(emp, ist_today())
    return {
        "id": emp.id,
        "code": emp.employee_code,
        "name": _name(emp),
        "kind": "production" if emp.employment_type == Employee.EMPLOYMENT_TYPE_PRODUCTION else "staff",
        "status": (emp.status or "active").lower(),
        "departmentId": emp.department_id,
        "department": emp.department.name if emp.department_id and emp.department else "",
        "designation": emp.designation.title if emp.designation_id and emp.designation else "",
        "branchId": emp.branch_id,
        "unit": (unit_label(emp.branch) or emp.branch.name) if emp.branch_id and emp.branch else "",
        "phone": emp.phone or None,
        "joinDate": _iso(joined),
        "lastAttended": _iso(spell.last_attended),
        "awayFrom": _iso(spell.start),
        "calendarDays": spell.calendar_days,
        "absentDays": spell.absent_days,
        "noDataDays": len(spell.gap_days),
        "workingDays": spell.working_days,
        "leaveDays": spell.leave_days,
        "coveredByLeave": spell.covered_by_leave,
        "neverAttended": spell.never_attended,
        "bucket": spell.bucket,
        "decision": decision_json(decision),
        "keptActive": engine.kept_for_spell(decision, spell),
        "autoTonight": due,
        "autoWhyNot": why,
    }


def _settings_json(request: Request) -> dict:
    s = service.settings_row()
    return {
        "autoEnabled": s.auto_enabled,
        "autoDays": s.auto_days,
        "runAt": RUN_AT,
        "lastRunAt": _iso(s.last_run_at),
        "lastRun": s.last_run_summary or None,
        "canChange": get_branch_scope(request) is None,
        "rules": {
            "list15": engine.LIST_15,
            "list30": engine.LIST_30,
            "gapShare": engine.GAP_SHARE,
        },
    }


def _active_rows(request: Request, kind: str):
    emps = list(_kind_q(_scope(request).filter(status="active"), kind).order_by("employee_code"))
    spells = engine.spells(emps)
    listed = [e for e in emps if spells[e.id].bucket is not None]
    latest = engine.decisions([e.id for e in listed])
    days = service.settings_row().auto_days
    return [_row(e, spells[e.id], latest.get(e.id), days) for e in listed]


@api_view(["GET"])
@require_hr
def summary(request: Request) -> Response:
    rows = _active_rows(request, "all")
    return Response(
        {
            "d15": sum(1 for r in rows if r["bucket"] == "15"),
            "d30": sum(1 for r in rows if r["bucket"] == "30"),
            "tonight": sum(1 for r in rows if r["autoTonight"]),
            "autoEnabled": service.settings_row().auto_enabled,
        }
    )


@api_view(["GET"])
@require_hr
def list_view(request: Request) -> Response:
    bucket = str(request.query_params.get("bucket") or "15")
    if bucket not in ("15", "30"):
        return _error("bucket must be 15 or 30")
    kind = _kind(request)
    rows = _active_rows(request, kind)
    shown = sorted((r for r in rows if r["bucket"] == bucket), key=lambda r: (-r["absentDays"], r["code"] or ""))
    yesterday = ist_today() - timedelta(days=1)
    return Response(
        {
            "bucket": bucket,
            "kind": kind,
            "asOf": yesterday.isoformat(),
            "counts": {
                "d15": sum(1 for r in rows if r["bucket"] == "15"),
                "d30": sum(1 for r in rows if r["bucket"] == "30"),
                "tonight": sum(1 for r in rows if r["autoTonight"]),
            },
            "settings": _settings_json(request),
            "employees": shown,
        }
    )


@api_view(["GET"])
@require_hr
def auto_view(request: Request) -> Response:
    kind = _kind(request)
    rows = _active_rows(request, kind)
    tonight = sorted((r for r in rows if r["autoTonight"]), key=lambda r: (-r["absentDays"], r["code"] or ""))
    scope_ids = _kind_q(_scope(request), kind).values_list("id", flat=True)
    autos = list(
        EmployeeInvestigation.objects.select_related(
            "employee__department", "employee__designation", "employee__branch"
        )
        .filter(action=EmployeeInvestigation.ACTION_AUTO, employee_id__in=scope_ids)
        .order_by("-at", "-id")[:500]
    )
    after = engine.decisions({a.employee_id for a in autos})
    history = []
    for a in autos:
        emp = a.employee
        latest = after.get(emp.id)
        history.append(
            {
                **decision_json(a),
                "employee": {
                    "id": emp.id,
                    "code": emp.employee_code,
                    "name": _name(emp),
                    "kind": "production" if emp.employment_type == Employee.EMPLOYMENT_TYPE_PRODUCTION else "staff",
                    "department": emp.department.name if emp.department_id and emp.department else "",
                    "unit": (unit_label(emp.branch) or emp.branch.name) if emp.branch_id and emp.branch else "",
                    "status": (emp.status or "active").lower(),
                },
                "calendarDays": a.calendar_days,
                # what happened since (made active again by HR ...), when it is a later decision than this one
                "since": decision_json(latest) if latest is not None and latest.id != a.id else None,
            }
        )
    return Response({"kind": kind, "settings": _settings_json(request), "tonight": tonight, "history": history})


def _day_kind(d: date, holidays: set, gaps: set, leave: dict, pending: set) -> str:
    if leave.get(d, 0) >= 1:
        return "leave"
    if leave.get(d, 0) > 0:
        return "half_leave"
    if d in holidays:
        return "holiday"
    if d.weekday() == 6:
        return "sunday"
    if d in gaps:
        return "no_data"
    if d in pending:
        return "leave_pending"
    return "absent"


@api_view(["GET"])
@require_hr
def detail(request: Request) -> Response:
    try:
        emp = _scope(request).filter(pk=int(request.query_params.get("employeeId"))).first()
    except (TypeError, ValueError):
        emp = None
    if emp is None:
        return _error("Employee not found", 404)
    spell = engine.spells([emp])[emp.id]
    decisions = list(EmployeeInvestigation.objects.filter(employee=emp).order_by("-at", "-id")[:50])
    days = service.settings_row().auto_days
    out = {"employee": _row(emp, spell, decisions[0] if decisions else None, days), "decisions": []}
    out["decisions"] = [decision_json(d) for d in decisions]
    yesterday = spell.end
    if spell.start is None or spell.start > yesterday:
        return Response({**out, "calendar": [], "leaves": [], "casualLeaves": [], "punches": _punches(emp)})

    shown_from = max(spell.start, yesterday - timedelta(days=CALENDAR_DAYS_SHOWN - 1))
    holidays = {
        d: n for d, n in Holiday.objects.filter(date__range=(shown_from, yesterday)).values_list("date", "name")
    }
    from ..hr_analytics.collect import approved_leave

    leave, _records = approved_leave(SimpleNamespace(start=spell.start, end=yesterday), [emp.id])
    mine = leave.get(emp.id, {})
    leaves = list(
        LeaveRequest.objects.filter(
            employee=emp, start_date__lte=yesterday.isoformat(), end_date__gte=spell.start.isoformat()
        ).order_by("start_date")
    )
    pending = set()
    for r in leaves:
        if r.status != "pending":
            continue
        first, last = parse_join_date(r.start_date), parse_join_date(r.end_date) or parse_join_date(r.start_date)
        if first and last:
            pending |= {first + timedelta(days=i) for i in range((last - first).days + 1)}
    gaps = set(spell.gap_days)
    calendar = []
    d = shown_from
    while d <= yesterday:
        calendar.append(
            {
                "date": d.isoformat(),
                "kind": _day_kind(d, set(holidays), gaps, mine, pending),
                "holiday": holidays.get(d),
            }
        )
        d += timedelta(days=1)
    cls = CasualLeaveRequest.objects.filter(employee=emp, date__range=(spell.start, yesterday)).order_by("date")
    return Response(
        {
            **out,
            "calendarFrom": shown_from.isoformat(),
            "calendar": calendar,
            "leaves": [
                {
                    "id": r.id,
                    "type": (r.type or "leave").replace("_", " ").capitalize(),
                    "from": r.start_date,
                    "to": r.end_date,
                    "days": float(r.total_days) if r.total_days is not None else None,
                    "halfDay": bool(r.is_half_day),
                    "status": r.status,
                    "reason": r.reason or None,
                    "decidedBy": r.approved_by or None,
                }
                for r in leaves
            ],
            "casualLeaves": [
                {"id": c.id, "date": c.date.isoformat(), "portion": c.portion, "status": c.status, "reason": c.reason}
                for c in cls
            ],
            "punches": _punches(emp),
        }
    )


def _punches(emp) -> list[dict]:
    """The employee's last punches (any time), newest first: when they were last seen."""
    return [
        {"date": p.date.isoformat(), "time": p.punch_time.strftime("%H:%M"), "source": p.source}
        for p in AttendanceLog.objects.filter(employee=emp).order_by("-date", "-punch_time")[:8]
    ]


def _body(request: Request):
    data = request.data if isinstance(request.data, dict) else {}
    raw = data.get("employeeIds")
    if not isinstance(raw, list) or not raw:
        raise service.Refused("Select at least one employee.")
    try:
        ids = list(dict.fromkeys(int(v) for v in raw))
    except (TypeError, ValueError):
        raise service.Refused("Select at least one employee.") from None
    if len(ids) > 200:
        raise service.Refused("At most 200 employees at a time.")
    found = {e.id: e for e in _scope(request).filter(id__in=ids)}
    emps = [found[i] for i in ids if i in found]
    if not emps:
        raise service.Refused("None of these employees is in your list.")
    return data, emps


def _act(request: Request, fn, verb: str, needs_bucket: bool = True) -> Response:
    try:
        data, emps = _body(request)
        reason = service.clean_reason(data.get("reason"))
    except service.Refused as exc:
        return _error(str(exc))
    bucket = str(data.get("bucket") or "")
    if needs_bucket and bucket not in ("15", "30", "auto"):
        bucket = "30"
    actor = get_hr_display_name(request)
    done, refused = fn(emps, reason, actor, bucket) if needs_bucket else fn(emps, reason, actor)
    if done:
        codes = ", ".join(d["employeeCode"] for d in done[:10]) + (" ..." if len(done) > 10 else "")
        log_action(
            request,
            "update",
            "employees",
            description=f"Investigation: {verb} {len(done)} employee(s) ({codes}). Reason: {reason}",
            new_values={"employeeIds": [d["employeeId"] for d in done], "bucket": bucket or None, "reason": reason},
        )
    return Response({"done": done, "refused": refused})


@api_view(["POST"])
@require_hr
def inactivate(request: Request) -> Response:
    return _act(request, service.inactivate, "marked inactive")


@api_view(["POST"])
@require_hr
def keep_active(request: Request) -> Response:
    return _act(request, service.keep_active, "kept active")


@api_view(["POST"])
@require_hr
def reactivate(request: Request) -> Response:
    return _act(request, service.reactivate, "made active again", needs_bucket=False)


@api_view(["POST"])
@require_hr
def run_now(request: Request) -> Response:
    """Run the Auto Trigger now (owner 2026-11-23): everyone the Tonight list shows is marked inactive at once, by exactly
    the nightly rules. Company-wide, so only a login for all units may press it."""
    if get_branch_scope(request) is not None:
        return _error("The Auto Trigger runs for the whole company: only a login for all units can run it.", 403)

    actor = get_hr_display_name(request)
    summary = service.auto_run(force=True, run_by=actor)
    log_action(
        request,
        "update",
        "employees",
        description=f"Investigation Auto Trigger run now: {summary.get('inactivated', 0)} employee(s) marked inactive",
        new_values={"employeeIds": summary.get("employeeIds") or []},
    )
    return Response({"summary": summary, "settings": _settings_json(request)})


@api_view(["GET", "PUT"])
@require_hr
def settings_view(request: Request) -> Response:
    if request.method == "PUT":
        if get_branch_scope(request) is not None:
            return _error("The Auto Trigger is one company-wide switch: only a login for all units can change it.", 403)
        value = (request.data if isinstance(request.data, dict) else {}).get("autoEnabled")
        if not isinstance(value, bool):
            return _error("autoEnabled must be true or false.")
        row = InvestigationSettings.get()
        if row.auto_enabled != value:
            row.auto_enabled = value
            row.updated_by = get_hr_display_name(request)
            row.save(update_fields=["auto_enabled", "updated_by", "updated_at"])
            log_action(
                request,
                "update",
                "employees",
                description=f"Investigation Auto Trigger switched {'on' if value else 'off'}",
            )
    return Response(_settings_json(request))

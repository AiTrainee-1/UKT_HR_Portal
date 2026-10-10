"""
Requests hub: one list of every request an employee (or HR) raises and somebody has to decide.

    GET /api/hr-requests?kind=all|leave,permission,...&status=any|waiting|decided|approved|rejected
                       &since=YYYY-MM-DD&until=YYYY-MM-DD&branchId=&departmentId=&employeeType=&limit=

The HR portal's Requests page used to merge three of the lists the HRMS keeps (leave, permission, manual outpass). This is
the same thing for every kind in approval_workflow.DEFINITIONS plus the general employee requests: ONE response with, per
kind, how many are waiting and who for, the request rows themselves (employee, what was asked, where it stands in its
approval pipeline, who decided it and when) and the figures for the cards above the list.

It only reads. Deciding a request still goes to the endpoint of its own kind (leave-requests/<id>/status, permissions/<id>,
casual-leaves/<id>, ...), so the approval pipeline in approval_workflow.py is never bypassed here. Visibility is the one the
existing list of each kind has: branch-scoped by the HR user's branch, and a kind is left out entirely when the user's role
cannot open the module that owns it (leave, casual_leave, geo_attendance, settlement, ...). The Managing Director only ever
views: every kind is reported with access "view".
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import date, datetime, time, timedelta
from typing import Callable

from django.apps import apps
from django.db.models import Q
from rest_framework.decorators import api_view
from rest_framework.request import Request
from rest_framework.response import Response

from . import approval_workflow as approval
from .auth import require_hr
from .branch_scope import scope_to_branch
from .clock import FACTORY_TZ, ist_today
from .models import AttendanceLog
from .permission_registry import effective_permissions, resolve_permission

# Rows returned per kind when the caller does not say (and the most it may ask for): a kind with more rows than this in the
# chosen period is reported as truncated, and the page tells HR to narrow the period.
DEFAULT_LIMIT = 200
MAX_LIMIT = 1000

STATUS_CHOICES = ("any", "waiting", "decided", "approved", "rejected")

# "Approved / rejected this month" counts decisions made this month. A request carries no single "decided at" column across
# kinds, so decisions are read from rows submitted since the start of the PREVIOUS month: nobody waits longer than that for a
# decision (an employee may only request the current month, plus the last one for two days).
DECISION_LOOKBACK_MONTHS = 1


@dataclass(frozen=True)
class Kind:
    key: str  # the approval workflow key (also the tab key on the page)
    label: str
    module: str  # the permission module that owns the kind (permission_registry.py)
    model: str
    # "quick": HR decides with Approve / Reject here; "notes": HR sets a status and notes here (general employee requests);
    # "link": the decision needs more than a button, so the page opens the dedicated page
    mode: str
    open_path: str | None
    open_label: str | None
    waiting: tuple[str, ...]  # stored statuses that mean "still waiting for a decision"
    rejected: tuple[str, ...] = ("rejected",)
    scope_field: str = "employee__branch_id"
    extra_filter: dict = field(default_factory=dict)
    select: tuple[str, ...] = ("employee__department", "employee__designation", "employee__branch")


KINDS: tuple[Kind, ...] = (
    Kind("leave", "Leave", "leave", "LeaveRequest", "quick", "/hr/leave?tab=leaves", "Leave & Holiday", ("pending",)),
    Kind(
        "permission",
        "Permission",
        "requests",
        "EmployeePermission",
        "quick",
        "/hr/leave?tab=permissions",
        "Leave & Holiday",
        ("pending",),
    ),
    Kind(
        "casual_leave",
        "Casual Leave",
        "casual_leave",
        "CasualLeaveRequest",
        "quick",
        "/hr/casual-leave",
        "Casual Leave",
        ("pending",),
    ),
    Kind(
        "missing_punch",
        "Missing Punch",
        "missing_punch",
        "MissingPunchRequest",
        "quick",
        "/hr/missing-punch",
        "Missing Punch",
        ("pending_hod", "pending_hr"),
    ),
    Kind(
        "on_duty",
        "On-Duty",
        "geo_attendance",
        "OnDutySession",
        "quick",
        "/hr/geo-attendance",
        "Geo Attendance",
        ("pending_hod", "pending_hr"),
        scope_field="branch_id",
        select=("employee__department", "employee__designation", "employee__branch", "branch"),
    ),
    Kind(
        "on_duty_punch",
        "On-Duty punches",
        "geo_attendance",
        "OnDutyPunchVerification",
        "link",
        "/hr/geo-attendance",
        "Geo Attendance",
        ("pending",),
        select=("employee__department", "employee__designation", "employee__branch", "session"),
    ),
    Kind(
        "outpass",
        "Outpass",
        "requests",
        "OutpassRequest",
        "quick",
        "/hr/outpass-visitors/outpass",
        "Outpass",
        ("pending",),
        extra_filter={"source": "manual"},
        select=("employee__department", "employee__designation", "employee__branch", "exit_gate"),
    ),
    Kind(
        "request",
        "Other requests",
        "requests",
        "EmployeeRequest",
        "notes",
        None,
        None,
        ("pending", "in_review", "more_info"),
    ),
    Kind(
        "attendance_correction",
        "Attendance correction",
        "attendance",
        "AttendanceOverrideRequest",
        "link",
        "/hr/attendance",
        "Attendance",
        ("pending",),
    ),
    Kind(
        "resignation",
        "Resignation",
        "recruitment.resignations",
        "ResignationRequest",
        "link",
        "/hr/recruitment/resignations",
        "Resignations",
        ("pending", "dept_approved"),
        select=("employee__department", "employee__designation", "employee__branch", "dept_head"),
    ),
    Kind(
        "advance",
        "Advance",
        "settlement",
        "Advance",
        "link",
        "/hr/settlement",
        "Settlement",
        ("pending",),
    ),
)
BY_KEY = {k.key: k for k in KINDS}

REQUEST_TYPE_LABELS = {
    "leave": "Leave",
    "salary_enquiry": "Salary enquiry",
    "shift_correction": "Shift correction",
    "advance": "Advance",
    "permission": "Permission",
    "general": "General query",
}


# ───────────────────────────── small helpers ─────────────────────────────


def _iso(value) -> str | None:
    return value.isoformat() if value else None


def _name(emp) -> str:
    return f"{emp.first_name} {emp.last_name}".strip()


def _cap(text: str | None) -> str:
    return (text or "").replace("_", " ").strip().capitalize()


def _hhmm(value) -> str | None:
    return value.strftime("%H:%M") if value else None


def _money(value) -> str:
    return f"Rs. {float(value):,.0f}"


def _employee_json(emp) -> dict:
    return {
        "id": emp.id,
        "code": emp.employee_code,
        "name": _name(emp),
        "department": emp.department.name if emp.department_id and emp.department else None,
        "departmentId": emp.department_id,
        "designation": emp.designation.title if emp.designation_id and emp.designation else None,
        "branch": emp.branch.name if emp.branch_id and emp.branch else None,
        "branchId": emp.branch_id,
        "type": emp.employment_type,
        "photoUrl": emp.photo_url,
    }


def _is_waiting(kind: Kind, obj) -> bool:
    return obj.status in kind.waiting


def _normal_status(kind: Kind, obj) -> str:
    if _is_waiting(kind, obj):
        return "pending"
    return "rejected" if obj.status in kind.rejected else "approved"


def _queue(prog: dict | None) -> str | None:
    """Who a waiting request is with: HR (HR could decide it right now), the HOD (HR has to wait for that step) or someone
    else (HR is not in the pipeline at all)."""
    if not prog or prog.get("currentStep") is None:
        return None
    if prog["canAct"]["hr"]:
        return "hr"
    if "hod" in prog["waitingFor"]:
        return "hod"
    return "other"


def _role(raw: str | None) -> str | None:
    if not raw:
        return None
    return {"dept_head": "hod", "hod": "hod", "hr": "hr", "system": "system"}.get(raw, raw)


# ───────────────────────────── per-kind rows ─────────────────────────────
# Each builder returns the parts that differ between kinds. `decision` is (by, role, at, comment) from the request's own
# columns; the approval trail (the pipeline's record) wins over it when it has an entry.


def _leave(r):
    days = float(r.total_days) if r.total_days is not None else 1
    if r.is_half_day:
        label = f"Half Day Leave ({'Afternoon' if r.half_day_slot == 'afternoon' else 'Morning'})"
    else:
        label = _cap(r.type) if (r.type or "").lower().endswith("leave") else f"{_cap(r.type)} Leave"
    span = r.start_date if r.start_date == r.end_date else f"{r.start_date} → {r.end_date}"
    return {
        "label": label,
        "summary": f"{span} · {days:g} day{'' if days == 1 else 's'}",
        "reason": r.reason,
        "date": r.start_date,
        "details": [
            ("From", r.start_date),
            ("To", r.end_date),
            ("Days", f"{days:g}"),
            ("Leave type", _cap(r.type)),
        ],
        "decision": (r.approved_by, _role(r.approver_role), None, r.hr_comment),
    }


def _permission(r, extra):
    perm = extra["permission"](r)
    time_text = perm["permissionTime"]
    return {
        "label": f"Permission · {perm['typeLabel'] or 'Type not set'}",
        "summary": f"{perm['date']}" + (f" at {time_text}" if time_text else ""),
        "reason": r.reason,
        "date": perm["date"],
        "details": [
            ("Date", perm["date"]),
            ("Time", time_text or "Not given"),
            ("Type", perm["typeLabel"] or "Not set yet"),
            ("Duration", f"{perm['durationMinutes']} minutes" if perm["durationMinutes"] else "Not given"),
        ],
        "decision": (r.approved_by, _role(r.approver_role), None, r.hr_comment),
        "extra": {
            "typeKey": perm["typeKey"],
            "typeLabel": perm["typeLabel"],
            "capStatus": perm["capStatus"],
            "statusLabel": perm["statusLabel"],
            "monthlyLimit": perm["monthlyLimit"],
            "permissionTime": time_text,
        },
    }


def _casual(r):
    return {
        "label": "Casual Leave",
        "summary": str(r.date),
        "reason": r.reason,
        "date": str(r.date),
        "details": [("Date", str(r.date))],
        "decision": (r.reviewed_by, _role(r.reviewer_role), r.reviewed_at, r.review_comment),
    }


def _missing_punch(r):
    slot = dict(r.PUNCH_SLOT_CHOICES).get(r.punch_slot) or ("Check-in" if r.punch_type == "IN" else "Check-out")
    return {
        "label": f"Missing Punch · {slot}",
        "summary": f"{r.date} at {_hhmm(r.punch_time)} · {slot}",
        "reason": r.reason,
        "date": str(r.date),
        "details": [("Date", str(r.date)), ("Punch time", _hhmm(r.punch_time) or ""), ("Punch", slot)],
        "decision": (
            r.hr_reviewed_by or r.hod_reviewed_by,
            "hr" if r.hr_reviewed_by else ("hod" if r.hod_reviewed_by else None),
            r.hr_reviewed_at or r.hod_reviewed_at,
            r.hr_review_comment or r.hod_review_comment,
        ),
    }


def _on_duty(r):
    pending_punches = r.punch_verifications.filter(status="pending").count() if r.status.startswith("pending") else 0
    details = [("Destination", r.destination)]
    if r.branch_id and r.branch:
        details.append(("Branch", r.branch.name))
    if pending_punches:
        details.append(("Punches waiting", f"{pending_punches} (accepted or voided with this decision)"))
    if r.started_at:
        details.append(("Started", r.started_at.astimezone(FACTORY_TZ).strftime("%Y-%m-%d %H:%M")))
    if r.completed_at:
        details.append(("Completed", r.completed_at.astimezone(FACTORY_TZ).strftime("%Y-%m-%d %H:%M")))
    return {
        "label": "On-Duty",
        "summary": r.destination,
        "reason": None,
        "date": _iso(r.created_at.astimezone(FACTORY_TZ).date()) if r.created_at else None,
        "details": details,
        "decision": (
            r.hr_reviewed_by or r.hod_reviewed_by,
            "hr" if r.hr_reviewed_by else ("hod" if r.hod_reviewed_by else None),
            r.hr_reviewed_at or r.hod_reviewed_at,
            r.hr_review_comment or r.hod_review_comment,
        ),
        "extra": {"pendingPunchCount": pending_punches, "sessionStatus": r.status},
    }


def _on_duty_punch(r):
    punch = dict(AttendanceLog.PUNCH_CHOICES).get(r.punch_type) or r.punch_type
    return {
        "label": f"On-Duty punch {r.punch_number} ({punch})",
        "summary": f"{r.punch_date} {_hhmm(r.punch_time)} · {r.session.destination}",
        "reason": None,
        "date": str(r.punch_date),
        "details": [
            ("Date", str(r.punch_date)),
            ("Time", _hhmm(r.punch_time) or ""),
            ("Destination", r.session.destination),
            ("Photo", "Captured (check it on the Geo Attendance page)" if r.photo else "None"),
            ("Mock location", "Yes - the phone reported a mocked GPS" if r.is_mocked else "No"),
        ],
        "decision": (r.hr_reviewed_by, "hr" if r.hr_reviewed_by else None, r.hr_reviewed_at, r.hr_review_comment),
    }


def _outpass(r):
    details = [("Destination", r.destination), ("Pass type", _cap(r.pass_type) or "Not given")]
    if r.expected_return_at:
        details.append(("Expected back", r.expected_return_at.astimezone(FACTORY_TZ).strftime("%Y-%m-%d %H:%M")))
    if r.exit_gate_id and r.exited_at:
        details.append(("Exited", f"{r.exit_gate.name} at {r.exited_at.astimezone(FACTORY_TZ).strftime('%H:%M')}"))
    return {
        "label": f"Outpass · {_cap(r.pass_type)}" if r.pass_type else "Outpass",
        "summary": r.destination,
        "reason": r.reason,
        "date": _iso(r.created_at.astimezone(FACTORY_TZ).date()) if r.created_at else None,
        "details": details,
        "decision": (r.approved_by, _role(r.approver_role), r.approved_at, r.review_comment),
    }


def _request(r):
    type_label = REQUEST_TYPE_LABELS.get(r.request_type, _cap(r.request_type))
    return {
        "label": type_label,
        "summary": r.subject,
        "reason": r.description,
        "date": _iso(r.created_at.astimezone(FACTORY_TZ).date()) if r.created_at else None,
        "details": [("Type", type_label), ("Subject", r.subject), ("Handled", _cap(r.status))],
        "decision": (r.handled_by, "hr" if r.handled_by else None, r.handled_at, r.hr_notes),
        "statusLabel": {"pending": "Pending", "in_review": "In review", "more_info": "More info needed"}.get(r.status),
        "extra": {"requestType": r.request_type, "storedStatus": r.status, "hrNotes": r.hr_notes},
    }


def _correction(r):
    asked = r.requested_values or {}
    before = r.previous_values or {}
    details = [("Date", str(r.date)), ("Raised by", r.requested_by or "HR")]
    for key in sorted(asked):
        details.append((f"Change {key}", f"{before.get(key, '-')} → {asked[key]}"))
    changes = ", ".join(f"{k}: {asked[k]}" for k in sorted(asked)[:3])
    return {
        "label": "Attendance correction",
        "summary": f"{r.date}" + (f" · {changes}" if changes else ""),
        "reason": r.reason,
        "date": str(r.date),
        "details": details,
        "decision": (r.reviewed_by, "hod" if r.reviewed_by else None, r.reviewed_at, r.review_comment),
    }


def _resignation(r):
    details = [("Last working day", _iso(r.last_working_date) or "Not given")]
    if r.dept_head_id and r.dept_head:
        details.append(("Department Head", _name(r.dept_head)))
    if r.dept_head_comment:
        details.append(("Department Head note", r.dept_head_comment))
    return {
        "label": "Resignation",
        "summary": f"Last working day {r.last_working_date}" if r.last_working_date else "Last working day not given",
        "reason": r.reason,
        "date": _iso(r.last_working_date),
        "details": details,
        "decision": (
            r.approved_by or r.rejected_by,
            "hr" if (r.approved_by or r.rejected_by) else None,
            r.approved_at,
            r.hr_comment,
        ),
    }


def _advance(r):
    kind_label = dict(r.ADVANCE_TYPES).get(r.advance_type, _cap(r.advance_type))
    details = [("Amount", _money(r.amount)), ("Type", kind_label)]
    if r.repayment_months:
        details.append(("Repayment", f"{r.repayment_months} months of {_money(r.emi_amount)}"))
    return {
        "label": f"Advance · {kind_label}",
        "summary": f"{_money(r.amount)} · {kind_label}",
        "reason": r.purpose,
        "date": _iso(r.created_at.astimezone(FACTORY_TZ).date()) if r.created_at else None,
        "details": details,
        "decision": (r.approved_by, "hr" if r.approved_by else None, r.approved_at, None),
    }


BUILDERS: dict[str, Callable] = {
    "leave": _leave,
    "casual_leave": _casual,
    "missing_punch": _missing_punch,
    "on_duty": _on_duty,
    "on_duty_punch": _on_duty_punch,
    "outpass": _outpass,
    "request": _request,
    "attendance_correction": _correction,
    "resignation": _resignation,
    "advance": _advance,
}


def _decision_of(kind: Kind, obj, parts: dict) -> dict:
    """Who decided a request and when: the approval trail's last decision, with the request's own columns filling any gap."""
    by, role, at, comment = parts.get("decision") or (None, None, None, None)
    trail = approval.trail_of(kind.key, obj) if approval.adapter(kind.key) else []
    last = next((e for e in reversed(trail) if e.get("decision") in ("approved", "rejected")), None)
    if last:
        by = last.get("by") or by
        role = last.get("role") or role
        at = last.get("at") or at
        comment = last.get("comment") or comment
    return {"by": by, "role": _role(role), "at": at.isoformat() if hasattr(at, "isoformat") else at, "comment": comment}


def _item(kind: Kind, obj, cfg, extra: dict) -> dict:
    build = BUILDERS.get(kind.key)
    parts = build(obj) if build else _permission(obj, extra)
    prog = approval.progress(kind.key, obj, cfg)
    status = _normal_status(kind, obj)
    waiting = status == "pending"
    return {
        "key": f"{kind.key}-{obj.id}",
        "kind": kind.key,
        "id": obj.id,
        "employee": _employee_json(obj.employee),
        "label": parts["label"],
        "summary": parts["summary"],
        "reason": parts.get("reason"),
        "date": parts.get("date"),
        "details": [{"label": a, "value": b} for a, b in parts["details"]],
        "status": status,
        "rawStatus": obj.status,
        "statusLabel": parts.get("statusLabel"),
        "queue": _queue(prog) if waiting else None,
        "approval": prog,
        "submittedAt": _iso(obj.created_at),
        # only a finished request has a decision: a half-approved one shows its steps in `approval`
        "decided": None if waiting else _decision_of(kind, obj, parts),
        "extra": parts.get("extra") or {},
    }


# ───────────────────────────── queries ─────────────────────────────


def _model(kind: Kind):
    return apps.get_model("api", kind.model)


def _base_qs(kind: Kind, request: Request):
    qs = _model(kind).objects.filter(**kind.extra_filter)
    return scope_to_branch(qs, request, field=kind.scope_field)


def _filtered_qs(kind: Kind, request: Request, params: dict):
    qs = _base_qs(kind, request).select_related(*kind.select)
    status = params["status"]
    waiting = Q(status__in=kind.waiting)
    if status == "waiting":
        qs = qs.filter(waiting)
    elif status == "decided":
        qs = qs.exclude(waiting)
    elif status == "rejected":
        qs = qs.filter(status__in=kind.rejected)
    elif status == "approved":
        qs = qs.exclude(waiting).exclude(status__in=kind.rejected)
    if params["since"]:
        qs = qs.filter(created_at__gte=params["since"])
    if params["until"]:
        qs = qs.filter(created_at__lt=params["until"])
    if params["branch_id"]:
        qs = qs.filter(employee__branch_id=params["branch_id"])
    if params["department_id"]:
        qs = qs.filter(employee__department_id=params["department_id"])
    if params["employee_type"]:
        qs = qs.filter(employee__employment_type=params["employee_type"])
    return qs.order_by("-created_at", "-id")


def _day_start(day: date) -> datetime:
    return datetime.combine(day, time.min, tzinfo=FACTORY_TZ)


def _parse_params(request: Request) -> tuple[dict | None, str | None]:
    q = request.query_params
    status = (q.get("status") or "any").lower()
    if status not in STATUS_CHOICES:
        return None, f"status must be one of: {', '.join(STATUS_CHOICES)}"
    out: dict = {"status": status, "since": None, "until": None}
    try:
        if q.get("since"):
            out["since"] = _day_start(date.fromisoformat(q["since"]))
        if q.get("until"):
            out["until"] = _day_start(date.fromisoformat(q["until"]) + timedelta(days=1))  # the last day is included
        for name, key in (("branchId", "branch_id"), ("departmentId", "department_id")):
            out[key] = int(q[name]) if q.get(name) else None
        limit = int(q.get("limit") or DEFAULT_LIMIT)
    except (TypeError, ValueError):
        return None, "since / until must be dates (YYYY-MM-DD); branchId, departmentId and limit must be numbers"
    out["limit"] = max(1, min(MAX_LIMIT, limit))
    employee_type = (q.get("employeeType") or "").lower()
    out["employee_type"] = employee_type if employee_type in ("staff", "production") else None
    wanted = [k for k in (q.get("kind") or "all").split(",") if k and k != "all"]
    unknown = [k for k in wanted if k not in BY_KEY]
    if unknown:
        return None, f"unknown kind: {', '.join(unknown)}"
    out["kinds"] = wanted
    return out, None


def _access_by_kind(request: Request) -> dict[str, str]:
    """The level ("view" | "edit") the caller has on each kind's module; a kind they cannot open at all is absent."""
    from .models import HRUser

    user_id = (getattr(request, "jwt_user", None) or {}).get("hrUserId")
    hr = HRUser.objects.select_related("role").filter(pk=user_id, is_active=True).first() if user_id else None
    if hr is None:
        return {}
    permissions = effective_permissions(hr)
    out: dict[str, str] = {}
    for kind in KINDS:
        level = "edit" if hr.is_super_admin else resolve_permission(permissions, kind.module)
        if level in ("view", "edit"):
            # the Managing Director only looks at requests; the decision endpoints refuse the MD anyway
            out[kind.key] = "view" if hr.is_md else level
    return out


def _stats_and_waiting(kinds: list[Kind], request: Request, month_start: datetime) -> tuple[dict, dict]:
    """The card figures and, per kind, how many requests are waiting (all time, whatever filters the list has)."""
    waiting_by_kind: dict[str, dict] = {}
    totals = {"waitingHr": 0, "waitingHod": 0, "waitingOther": 0, "approvedThisMonth": 0, "rejectedThisMonth": 0}
    oldest = None
    lookback = _day_start(_shift_month(month_start.date(), -DECISION_LOOKBACK_MONTHS))
    for kind in kinds:
        cfg = approval.get_config(kind.key)
        counts = {"total": 0, "hr": 0, "hod": 0, "other": 0}
        base = _base_qs(kind, request).select_related(*kind.select)
        for obj in base.filter(status__in=kind.waiting):
            queue = _queue(approval.progress(kind.key, obj, cfg)) or "other"
            counts["total"] += 1
            counts[queue] += 1
            if obj.created_at and (oldest is None or obj.created_at < oldest["at"]):
                oldest = {"at": obj.created_at, "kind": kind, "obj": obj}
        waiting_by_kind[kind.key] = counts
        totals["waitingHr"] += counts["hr"]
        totals["waitingHod"] += counts["hod"]
        totals["waitingOther"] += counts["other"]
        for obj in base.exclude(status__in=kind.waiting).filter(created_at__gte=lookback):
            parts = BUILDERS[kind.key](obj) if kind.key in BUILDERS else {}
            when = _decision_of(kind, obj, parts)["at"]
            decided_at = _as_datetime(when) or obj.created_at
            if decided_at and decided_at >= month_start:
                totals["rejectedThisMonth" if obj.status in kind.rejected else "approvedThisMonth"] += 1
    totals["waiting"] = totals["waitingHr"] + totals["waitingHod"] + totals["waitingOther"]
    totals["oldestWaiting"] = (
        {
            "kind": oldest["kind"].key,
            "id": oldest["obj"].id,
            "employeeName": _name(oldest["obj"].employee),
            "label": oldest["kind"].label,
            "submittedAt": oldest["at"].isoformat(),
        }
        if oldest
        else None
    )
    return totals, waiting_by_kind


def _as_datetime(value) -> datetime | None:
    if isinstance(value, datetime):
        return value
    try:
        return datetime.fromisoformat(value) if value else None
    except (TypeError, ValueError):
        return None


def _shift_month(day: date, months: int) -> date:
    index = day.year * 12 + day.month - 1 + months
    return date(index // 12, index % 12 + 1, 1)


def _filter_options(request: Request) -> dict:
    """The branches and departments the caller may filter by (their own branch only, for a branch-scoped HR user), so the
    page needs no access to the Branches / Departments modules to fill its filters."""
    from .models import Branch, Department

    branches = scope_to_branch(Branch.objects.all(), request, field="id").order_by("name")
    departments = scope_to_branch(Department.objects.all(), request, field="branch_id").order_by("name")
    return {
        "branches": [{"id": b.id, "name": b.name} for b in branches],
        "departments": [{"id": d.id, "name": d.name, "branchId": d.branch_id} for d in departments],
    }


def _permission_row_builder():
    """The permission list's own serializer (with the monthly-cap lookups it needs), shared across the rows of one call."""
    from .leave_views import _CapStatusCache, _permission_json
    from .models import PayrollSettings

    settings = PayrollSettings.get()
    cap_cache = _CapStatusCache(settings.permission_monthly_cap)
    cfg = approval.get_config("permission")
    return lambda p: _permission_json(p, settings=settings, cap_cache=cap_cache, cfg=cfg)


@api_view(["GET"])
@require_hr
def hr_requests(request: Request) -> Response:
    params, error = _parse_params(request)
    if error:
        return Response({"error": error}, status=400)

    access = _access_by_kind(request)
    allowed = [k for k in KINDS if k.key in access]
    month_start = _day_start(ist_today().replace(day=1))
    totals, waiting_by_kind = _stats_and_waiting(allowed, request, month_start)

    wanted = [k for k in allowed if not params["kinds"] or k.key in params["kinds"]]
    extra = {"permission": _permission_row_builder()}
    items: list[dict] = []
    matched: dict[str, int] = {}
    for kind in wanted:
        qs = _filtered_qs(kind, request, params)
        matched[kind.key] = qs.count()
        cfg = approval.get_config(kind.key)
        items.extend(_item(kind, obj, cfg, extra) for obj in qs[: params["limit"]])
    items.sort(key=lambda i: (i["submittedAt"] or "", i["id"]), reverse=True)

    kinds_json = []
    for kind in allowed:
        defn = approval.definition(kind.key)
        cfg = approval.get_config(kind.key)
        waiting = waiting_by_kind[kind.key]
        kinds_json.append(
            {
                "key": kind.key,
                "label": kind.label,
                "group": defn.group,
                "access": access[kind.key],
                "mode": kind.mode,
                "openPath": kind.open_path,
                "openLabel": kind.open_label,
                "pipeline": approval.pipeline_text(defn.requested_by, cfg.steps),
                "enabled": cfg.enabled,
                "waiting": waiting["total"],
                "waitingHr": waiting["hr"],
                "waitingHod": waiting["hod"],
                "matched": matched.get(kind.key),
                "truncated": matched.get(kind.key, 0) > params["limit"],
            }
        )
    return Response(
        {
            "kinds": kinds_json,
            "stats": totals,
            "items": items,
            "limit": params["limit"],
            "options": _filter_options(request),
        }
    )

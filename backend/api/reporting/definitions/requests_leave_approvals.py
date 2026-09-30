"""Request-desk and approval reports: the employee (mobile app) request register, everything still waiting
for a decision with its age and who it is waiting on, and approver workload / turnaround.

Approval facts these reports rely on (all read from stored rows, nothing is recomputed):

* Leave, permission, casual leave and manual outpass requests are single-stage: the employee's HOD (if that
  HOD holds the matching approval right) *or* HR, whoever acts first.
* Missing-punch requests and on-duty sessions are two-stage, HOD then HR. HR cannot act on a missing-punch
  request until the HOD has; HR may decide an on-duty session directly (the fallback when there is no HOD).
* Attendance corrections are proposed by HR and can only be decided by the employee's HOD.
* Resignations need the HOD first; HR can only reject before that, and gives the final approval after it.
* Who the HOD is comes from ``hod_scope.effective_owner_map`` (one active HOD per employee) and is the
  CURRENT assignment; decided rows are attributed by the approver name stored on them.
* Leave and permission rows carry no decision timestamp, so their turnaround is not derivable and is left blank.
"""

from __future__ import annotations

from collections import defaultdict
from datetime import date
from typing import NamedTuple

from django.db.models import Q

from api.models import (
    Advance,
    AttendanceOverrideRequest,
    CasualLeaveRequest,
    EmployeePermission,
    EmployeeRequest,
    LeaveRequest,
    MissingPunchRequest,
    OnDutyPunchVerification,
    OnDutySession,
    OutpassRequest,
    ResignationRequest,
)

from ..common import emp_cells
from ..filters import date_range, scope, select, text
from ..formatting import display_date, fmt_dt, indian_number, parse_date
from ..registry import register
from ..types import BADGE, DATE, DATETIME, HOURS, INTEGER, PERCENT, TEXT, ColumnSpec, ReportResult, ReportSpec
from . import requests_leave_common as C

CATEGORY = "leave"

# key -> (label, permission module that owns the data). Order is the display order.
WORKFLOWS: dict[str, tuple[str, str]] = {
    "leave": ("Leave", "leave"),
    "permission": ("Permission", "requests"),
    "casual_leave": ("Casual Leave", "casual_leave"),
    "missing_punch": ("Missing Punch", "missing_punch"),
    "on_duty": ("On-Duty", "geo_attendance"),
    "on_duty_punch": ("On-Duty Punch", "geo_attendance"),
    "attendance_override": ("Attendance Correction", "attendance"),
    "outpass": ("Outpass", "requests"),
    "employee_request": ("Employee Request", "requests"),
    "resignation": ("Resignation", "recruitment.resignations"),
    "advance": ("Advance / Loan", "settlement"),
}
OWNING_MODULES = tuple(dict.fromkeys(m for _label, m in WORKFLOWS.values()))
WORKLOAD_FLOWS = (
    "leave",
    "permission",
    "casual_leave",
    "missing_punch",
    "on_duty",
    "on_duty_punch",
    "attendance_override",
    "outpass",
    "employee_request",
)

# DepartmentManager.can_approve_* flag that governs each HOD-approvable workflow.
HOD_FLAG = {
    "leave": "can_approve_leaves",
    "permission": "can_approve_permissions",
    "casual_leave": "can_approve_casual_leave",
    "outpass": "can_approve_permissions",
    "on_duty": "can_approve_on_duty",
    "missing_punch": "can_approve_missing_punch",
    "attendance_override": "can_approve_attendance",
    "resignation": "can_approve_resignations",
}
HOD_OR_HR = ("leave", "permission", "casual_leave", "outpass", "on_duty")  # first to act wins (on-duty: HR fallback)
HR_ONLY = ("employee_request", "advance", "on_duty_punch")

AGE_BUCKETS = (
    ("0-1 days", 0, 1),
    ("2-3 days", 2, 3),
    ("4-7 days", 4, 7),
    ("8-15 days", 8, 15),
    ("Over 15 days", 16, None),
)


def _bucket(age: int) -> str:
    for label, lo, hi in AGE_BUCKETS:
        if age >= lo and (hi is None or age <= hi):
            return label
    return AGE_BUCKETS[-1][0]


def _visible(ctx, keys) -> list[str]:
    return [k for k in keys if C.can_view(ctx, WORKFLOWS[k][1])]


# ══════════════════════════════════════════════════════════════════════════════
#  Employee Requests Register
# ══════════════════════════════════════════════════════════════════════════════

_TYPE_LABELS = dict(EmployeeRequest.REQUEST_TYPES)
_STATUS_LABELS = dict(EmployeeRequest.STATUS_CHOICES)
_OPEN_STATUSES = ("pending", "in_review", "more_info")
_REQUEST_COLUMNS = (
    *C.emp_columns(name=1.6, dept=1.5),
    ColumnSpec("requestType", "Type", BADGE, 1.3),
    ColumnSpec("subject", "Subject", TEXT, 2.0),
    ColumnSpec("description", "Details", TEXT, 2.6),
    ColumnSpec("createdAt", "Raised on", DATETIME, 1.5),
    ColumnSpec("status", "Status", BADGE, 1.2),
    ColumnSpec("handledBy", "Handled by", TEXT, 1.3),
    ColumnSpec("handledAt", "Last handled", DATETIME, 1.5),
    ColumnSpec("hrNotes", "HR notes", TEXT, 1.8),
    ColumnSpec("turnaroundHours", "Handling time (hrs)", HOURS, 1.3),
    ColumnSpec("openAgeDays", "Open (days)", INTEGER, 0.8),
)


def _run_employee_requests(ctx) -> ReportResult:
    start_dt, end_dt = C.ist_bounds(ctx.date_from, ctx.date_to)
    qs = (
        EmployeeRequest.objects.select_related("employee__department", "employee__designation")
        .filter(ctx.emp_q("employee__"), created_at__gte=start_dt, created_at__lt=end_dt)
        .order_by("created_at", "id")
    )
    if ctx.param("requestType"):
        qs = qs.filter(request_type=ctx.param("requestType"))
    if ctx.param("status"):
        qs = qs.filter(status=ctx.param("status"))
    if ctx.param("handledBy"):
        qs = qs.filter(handled_by__icontains=ctx.param("handledBy"))

    limit = 2000 if ctx.purpose == "xlsx" else 300
    rows = []
    by_type: dict[str, int] = defaultdict(int)
    by_status: dict[str, int] = defaultdict(int)
    handling: list[float] = []
    open_ages: list[int] = []
    for r in qs:
        by_type[r.request_type] += 1
        by_status[r.status] += 1
        created = C.ist_date(r.created_at)
        age = None
        hours = None
        if r.status in _OPEN_STATUSES and created:
            age = max(0, (ctx.today - created).days)
            open_ages.append(age)
        elif r.status in ("approved", "rejected"):
            hours = C.hours_between(r.created_at, r.handled_at)
            if hours is not None:
                handling.append(hours)
        rows.append(
            {
                **emp_cells(r.employee),
                "requestType": _TYPE_LABELS.get(
                    r.request_type, str(r.request_type or "").replace("_", " ").title() or None
                ),
                "subject": C.clip(r.subject, 160),
                "description": C.clip(r.description, limit),
                "createdAt": fmt_dt(r.created_at),
                "status": _STATUS_LABELS.get(r.status, str(r.status or "").replace("_", " ").capitalize() or None),
                "handledBy": r.handled_by or None,
                "handledAt": fmt_dt(r.handled_at),
                "hrNotes": C.clip(r.hr_notes, limit),
                "turnaroundHours": hours,
                "openAgeDays": age,
            }
        )

    open_count = sum(n for s, n in by_status.items() if s in _OPEN_STATUSES)
    summary = [
        {"label": "Requests", "value": len(rows), "format": "integer"},
        {"label": "Open", "value": open_count, "format": "integer"},
        {"label": "Approved", "value": by_status.get("approved", 0), "format": "integer"},
        {"label": "Rejected", "value": by_status.get("rejected", 0), "format": "integer"},
        {
            "label": "Average handling time (hrs)",
            "value": round(sum(handling) / len(handling), 2) if handling else None,
            "format": "hours",
        },
        {"label": "Oldest open request (days)", "value": max(open_ages) if open_ages else None, "format": "integer"},
    ]
    notes = [
        "Open = pending, in review or more information needed; 'Open (days)' counts from the day it was raised "
        "(IST) to today. Handling time is shown for approved / rejected requests only.",
        "'Last handled' is stamped on every HR update, including a notes-only edit, and 'Handled by' is typed in "
        "by HR, so handling time is approximate. Requests of type leave, permission and advance are free-text "
        "tickets: they do not create the real leave, permission or advance records.",
    ]
    if by_type:
        notes.append(
            "By type: "
            + ", ".join(
                f"{_TYPE_LABELS.get(k, k)} {n}" for k, n in sorted(by_type.items(), key=lambda kv: (-kv[1], kv[0]))
            )
            + "."
        )
    return ReportResult(rows=rows, summary=summary, notes=notes)


register(
    ReportSpec(
        id="employee-requests-register",
        title="Employee Requests Register",
        description="Mobile-app service requests (salary enquiry, shift correction, advance, permission, general) with status and handling time.",
        category=CATEGORY,
        icon="ClipboardList",
        tags=("employee request", "ticket", "salary enquiry", "mobile app", "helpdesk"),
        modules=("requests",),
        filters=(
            date_range(label="Raised between"),
            *scope(status="all"),
            select("requestType", "Request type", tuple(EmployeeRequest.REQUEST_TYPES)),
            select("status", "Status", tuple(EmployeeRequest.STATUS_CHOICES)),
            text("handledBy", "Handled by", placeholder="Name"),
        ),
        columns=_REQUEST_COLUMNS,
        run=_run_employee_requests,
    )
)


# ══════════════════════════════════════════════════════════════════════════════
#  Pending approvals - who is waiting on whom
# ══════════════════════════════════════════════════════════════════════════════


class Pending(NamedTuple):
    workflow: str
    req_id: int
    emp: object
    subject: str
    request_date: date | None
    created_at: object
    stage_key: str  # "hod" | "hr" | "any"
    stage: str
    extra: str | None = None


def _base(model, ctx, *related):
    return model.objects.select_related("employee__department", "employee__designation", *related).filter(
        ctx.emp_q("employee__")
    )


def _load_leave(ctx) -> list[Pending]:
    catalog = C.LeaveTypeCatalog()
    out = []
    for lr in _base(LeaveRequest, ctx).filter(status="pending"):
        start = parse_date(lr.start_date)
        days = float(lr.total_days) if lr.total_days is not None else 1.0
        span = (
            f"{display_date(lr.start_date)} (half day)"
            if lr.is_half_day
            else f"{display_date(lr.start_date)} to {display_date(lr.end_date)}"
        )
        out.append(
            Pending(
                "leave",
                lr.id,
                lr.employee,
                f"{catalog.resolve(lr).label}, {span} ({days:g} day(s))",
                start,
                lr.created_at,
                "any",
                "Pending",
            )
        )
    return out


def _load_permission(ctx) -> list[Pending]:
    out = []
    for p in _base(EmployeePermission, ctx).filter(status="pending"):
        label = EmployeePermission.TYPE_LABELS.get(
            EmployeePermission.normalize_type(p.type), "Permission (unclassified)"
        )
        at = f" at {p.permission_time:%H:%M}" if p.permission_time else ""
        out.append(
            Pending(
                "permission",
                p.id,
                p.employee,
                f"{label} on {display_date(p.date)}{at}",
                p.date,
                p.created_at,
                "any",
                "Pending",
            )
        )
    return out


def _load_casual(ctx) -> list[Pending]:
    return [
        Pending(
            "casual_leave",
            r.id,
            r.employee,
            f"Casual Leave on {display_date(r.date)}",
            r.date,
            r.created_at,
            "any",
            "Pending",
        )
        for r in _base(CasualLeaveRequest, ctx).filter(status="pending")
    ]


_SLOT_LABELS = dict(MissingPunchRequest.PUNCH_SLOT_CHOICES)


def _load_missing_punch(ctx) -> list[Pending]:
    out = []
    for r in _base(MissingPunchRequest, ctx).filter(status__in=("pending_hod", "pending_hr")):
        what = _SLOT_LABELS.get(r.punch_slot) or ("Check-in" if r.punch_type == "IN" else "Check-out")
        hod = r.status == "pending_hod"
        out.append(
            Pending(
                "missing_punch",
                r.id,
                r.employee,
                f"{what} {r.punch_time:%H:%M} on {display_date(r.date)}",
                r.date,
                r.created_at,
                "hod" if hod else "hr",
                "HOD stage" if hod else "HR stage",
            )
        )
    return out


def _load_on_duty(ctx) -> list[Pending]:
    out = []
    for s in _base(OnDutySession, ctx).filter(status__in=("pending_hod", "pending_hr")):
        hod = s.status == "pending_hod"
        out.append(
            Pending(
                "on_duty",
                s.id,
                s.employee,
                s.destination,
                C.ist_date(s.created_at),
                s.created_at,
                "hod" if hod else "hr",
                "HOD stage" if hod else "HR stage",
                "ended" if s.employee_ended_at else None,
            )
        )
    return out


def _load_on_duty_punch(ctx) -> list[Pending]:
    out = []
    for v in _base(OnDutyPunchVerification, ctx, "session").filter(status="pending"):
        out.append(
            Pending(
                "on_duty_punch",
                v.id,
                v.employee,
                f"Punch {v.punch_number} ({v.punch_type}) {v.punch_time:%H:%M} on {display_date(v.punch_date)} - {v.session.destination}",
                v.punch_date,
                v.created_at,
                "hr",
                "Pending HR",
                v.session.status,
            )
        )
    return out


def _load_override(ctx) -> list[Pending]:
    return [
        Pending(
            "attendance_override",
            r.id,
            r.employee,
            f"Attendance correction for {display_date(r.date)}",
            r.date,
            r.created_at,
            "hod",
            "Pending HOD",
        )
        for r in _base(AttendanceOverrideRequest, ctx).filter(status="pending")
    ]


def _load_outpass(ctx) -> list[Pending]:
    return [
        Pending(
            "outpass", r.id, r.employee, f"To {r.destination}", C.ist_date(r.created_at), r.created_at, "any", "Pending"
        )
        for r in _base(OutpassRequest, ctx).filter(status="pending", source="manual")
    ]


_REQUEST_STAGE = {"pending": "Pending", "in_review": "In review", "more_info": "More info needed"}


def _load_employee_request(ctx) -> list[Pending]:
    return [
        Pending(
            "employee_request",
            r.id,
            r.employee,
            f"{_TYPE_LABELS.get(r.request_type, r.request_type)}: {r.subject}",
            C.ist_date(r.created_at),
            r.created_at,
            "hr",
            _REQUEST_STAGE.get(r.status, r.status),
            r.status,
        )
        for r in _base(EmployeeRequest, ctx).filter(status__in=_OPEN_STATUSES)
    ]


def _load_resignation(ctx) -> list[Pending]:
    out = []
    for r in _base(ResignationRequest, ctx).filter(status__in=("pending", "dept_approved")):
        hod = r.status == "pending"
        last = f", last working day {display_date(r.last_working_date)}" if r.last_working_date else ""
        out.append(
            Pending(
                "resignation",
                r.id,
                r.employee,
                f"Resignation{last}",
                r.last_working_date or C.ist_date(r.created_at),
                r.created_at,
                "hod" if hod else "hr",
                "HOD stage" if hod else "HR stage",
            )
        )
    return out


_ADVANCE_TYPES = dict(Advance.ADVANCE_TYPES)


def _load_advance(ctx) -> list[Pending]:
    return [
        Pending(
            "advance",
            a.id,
            a.employee,
            f"{_ADVANCE_TYPES.get(a.advance_type, a.advance_type)} of Rs. {indian_number(float(a.amount))}",
            C.ist_date(a.created_at),
            a.created_at,
            "hr",
            "Pending",
        )
        for a in _base(Advance, ctx).filter(status="pending")
    ]


_LOADERS = {
    "leave": _load_leave,
    "permission": _load_permission,
    "casual_leave": _load_casual,
    "missing_punch": _load_missing_punch,
    "on_duty": _load_on_duty,
    "on_duty_punch": _load_on_duty_punch,
    "attendance_override": _load_override,
    "outpass": _load_outpass,
    "employee_request": _load_employee_request,
    "resignation": _load_resignation,
    "advance": _load_advance,
}


def collect_pending(ctx, keys) -> list[Pending]:
    out: list[Pending] = []
    for key in keys:
        out += _LOADERS[key](ctx)
    return out


def resolve_holder(item: Pending, directory: C.HodDirectory) -> tuple[str, str, str | None, str | None]:
    """(holder, text, hodAssigned, hodName).

    holder: 'hod' (only the HOD can act), 'either' (HOD or HR, whoever first), 'hr' (only HR can act) or
    'stuck' (a HOD-only step with no HOD able to act, so nobody can decide it), or 'employee' (HR asked the
    employee for more information, so the next move is theirs)."""
    wf = item.workflow
    if wf in HR_ONLY:
        if wf == "on_duty_punch" and item.extra in ("pending_hod", "pending_hr"):
            return "hr", "HR - after the On-Duty request is approved", None, None
        if wf == "employee_request" and item.extra == "more_info":
            return "employee", "Employee (HR asked for more information)", None, None
        return "hr", "HR", None, None
    state, name = directory.state(item.emp.id, HOD_FLAG[wf])
    assigned = "No" if state == "none" else "Yes"
    if item.stage_key == "hr":
        return "hr", "HR", assigned, name if state == "ok" else None
    hod_name = name if state == "ok" else None
    if state == "ok":
        if wf in HOD_OR_HR:
            return "either", f"HOD {name} or HR", assigned, hod_name
        return "hod", f"HOD {name}" + (" (HR can only reject)" if wf == "resignation" else ""), assigned, hod_name
    reason = {
        "none": "no HOD assigned",
        "no_right": f"HOD {name} lacks the approval right",
        "self": "the employee is their own HOD",
    }[state]
    if wf in HOD_OR_HR:
        return "hr", f"HR ({reason})", assigned, None
    if wf == "resignation":
        return "stuck", f"No HOD can act ({reason}); HR can only reject", assigned, None
    return "stuck", f"No approver can act ({reason}); HR cannot decide this step", assigned, None


_PENDING_COLUMNS = (
    ColumnSpec("module", "Request", BADGE, 1.4),
    ColumnSpec("requestId", "Ref #", INTEGER, 0.6),
    *C.emp_columns(name=1.6, dept=1.3),
    ColumnSpec("subject", "Details", TEXT, 2.8),
    ColumnSpec("requestDate", "For date", DATE, 1.45),
    ColumnSpec("submittedAt", "Submitted", DATETIME, 1.5),
    ColumnSpec("ageDays", "Waiting (days)", INTEGER, 0.9),
    ColumnSpec("ageBucket", "Age", BADGE, 1.1),
    ColumnSpec("stage", "Stage", BADGE, 1.0),
    ColumnSpec("pendingWith", "Waiting on", TEXT, 2.6),
    ColumnSpec("hodAssigned", "Has HOD", BADGE, 0.8),
)


def _run_pending(ctx) -> ReportResult:
    allowed = _visible(ctx, WORKFLOWS)
    requested = ctx.param("module") or []
    keys = [k for k in allowed if not requested or k in requested]
    items = collect_pending(ctx, keys)
    directory = C.HodDirectory({i.emp.id for i in items})

    wanted = ctx.param("pendingWith")
    min_age = ctx.param("minAgeDays")
    order = {k: i for i, k in enumerate(WORKFLOWS)}
    built = []
    for it in items:
        created = C.ist_date(it.created_at)
        age = max(0, (ctx.today - created).days) if created else 0
        if min_age and age < int(min_age):
            continue
        holder, holder_text, assigned, _name = resolve_holder(it, directory)
        if wanted == "hod" and holder not in ("hod", "either"):
            continue
        if wanted == "hr" and holder not in ("hr", "either"):
            continue
        if wanted == "stuck" and holder != "stuck":
            continue
        built.append((it, age, holder, holder_text, assigned))
    built.sort(key=lambda b: (-b[1], order[b[0].workflow], b[0].req_id))

    rows = []
    bucket_counts: dict[str, int] = defaultdict(int)
    flow_counts: dict[str, int] = defaultdict(int)
    holder_counts: dict[str, int] = defaultdict(int)
    for it, age, holder, holder_text, assigned in built:
        bucket_counts[_bucket(age)] += 1
        flow_counts[it.workflow] += 1
        holder_counts[holder] += 1
        rows.append(
            {
                "module": WORKFLOWS[it.workflow][0],
                "requestId": it.req_id,
                **emp_cells(it.emp),
                "subject": C.clip(it.subject, 200),
                "requestDate": it.request_date.isoformat() if it.request_date else None,
                "submittedAt": fmt_dt(it.created_at),
                "ageDays": age,
                "ageBucket": _bucket(age),
                "stage": it.stage,
                "pendingWith": holder_text,
                "hodAssigned": assigned,
            }
        )

    oldest = max((b[1] for b in built), default=None)
    summary = [
        {"label": "Pending requests", "value": len(rows), "format": "integer"},
        {"label": "Oldest (days)", "value": oldest, "format": "integer"},
        {"label": "Waiting over 7 days", "value": sum(1 for b in built if b[1] > 7), "format": "integer"},
        {"label": "Stuck - no approver can act", "value": holder_counts["stuck"], "format": "integer"},
        {"label": "With HR only", "value": holder_counts["hr"], "format": "integer"},
        {"label": "With the HOD only", "value": holder_counts["hod"], "format": "integer"},
        {"label": "HOD or HR", "value": holder_counts["either"], "format": "integer"},
        {"label": "Waiting on the employee", "value": holder_counts["employee"], "format": "integer"},
    ]
    notes = [
        "Age counts whole days from the day the request was submitted (IST) to today. 'Waiting on' is worked out "
        "from the CURRENT HOD assignment and approval rights (one HOD per employee); a HOD never decides their "
        "own request.",
        "Leave, permission, casual leave and outpass requests can be decided by the HOD or by HR, whoever acts "
        "first; on-duty sessions likewise at the HOD stage (HR may decide directly). A missing-punch request or "
        "an attendance correction with no HOD able to act cannot be decided by anyone until a HOD is assigned - "
        "those are shown as stuck. On-duty punches wait for HR and cannot be approved until their on-duty "
        "request is.",
    ]
    if bucket_counts:
        notes.append(
            "By age: "
            + ", ".join(f"{label} {bucket_counts[label]}" for label, _lo, _hi in AGE_BUCKETS if bucket_counts[label])
            + "."
        )
    if flow_counts:
        notes.append(
            "By request: " + ", ".join(f"{WORKFLOWS[k][0]} {flow_counts[k]}" for k in WORKFLOWS if flow_counts[k]) + "."
        )
    hidden = [WORKFLOWS[k][0] for k in WORKFLOWS if k not in allowed]
    if hidden:
        notes.append("Not shown because your role cannot open them elsewhere in the app: " + ", ".join(hidden) + ".")
    return ReportResult(rows=rows, summary=summary, notes=notes)


register(
    ReportSpec(
        id="pending-approvals-ageing",
        title="Pending Approvals Ageing",
        description="Everything still waiting for a decision - leave, permission, missing punch, on-duty and more - with its age and who it is waiting on.",
        category=CATEGORY,
        icon="Hourglass",
        tags=("pending", "approvals", "ageing", "backlog", "stuck", "hod"),
        modules=OWNING_MODULES,
        filters=(
            select(
                "module",
                "Request type",
                tuple((k, v[0]) for k, v in WORKFLOWS.items()),
                multi=True,
                placeholder="All request types",
            ),
            *scope(status="all"),
            select(
                "pendingWith",
                "Waiting on",
                (
                    ("hod", "HOD can act"),
                    ("hr", "HR can act"),
                    ("stuck", "Stuck - no approver can act"),
                ),
            ),
            select(
                "minAgeDays",
                "Waiting at least",
                (("2", "2+ days"), ("4", "4+ days"), ("8", "8+ days"), ("15", "15+ days")),
            ),
        ),
        columns=_PENDING_COLUMNS,
        run=_run_pending,
    )
)


# ══════════════════════════════════════════════════════════════════════════════
#  Approver workload & turnaround
# ══════════════════════════════════════════════════════════════════════════════

NOT_RECORDED = "(not recorded)"
TIMING_BASIS = {
    "Leave": "N/A",
    "Permission": "N/A",
    "Casual Leave": "Decision time",
    "On-Duty Punch": "Decision time",
    "Attendance Correction": "Decision time",
    "Outpass": "Decision time",
    "Employee Request": "Last handled (approx.)",
}
HR_QUEUE = "HR queue (shared)"


class Event(NamedTuple):
    module: str
    role: str
    name: str
    decision: str  # approved | rejected
    hours: float | None


def _stage_module(workflow: str, side: str) -> str:
    base = WORKFLOWS[workflow][0]
    return f"{base} - {side} stage" if workflow in ("missing_punch", "on_duty") else base


def _timing_basis(module: str) -> str:
    if module.endswith(" stage"):
        return "Stage time"
    return TIMING_BASIS.get(module, "N/A")


def _in_range(value, start_dt, end_dt) -> bool:
    return value is not None and start_dt <= value < end_dt


def _workload_events(ctx, keys, start_dt, end_dt) -> list[Event]:
    emp_q = ctx.emp_q("employee__")
    in_created = Q(created_at__gte=start_dt, created_at__lt=end_dt)
    decided = ("approved", "rejected")
    events: list[Event] = []

    if "leave" in keys:
        for role, by, st in LeaveRequest.objects.filter(emp_q, in_created, status__in=decided).values_list(
            "approver_role", "approved_by", "status"
        ):
            events.append(Event("Leave", C.role_label(role) or "Unknown", C.norm_name(by) or NOT_RECORDED, st, None))
    if "permission" in keys:
        for role, by, st in EmployeePermission.objects.filter(emp_q, in_created, status__in=decided).values_list(
            "approver_role", "approved_by", "status"
        ):
            events.append(
                Event("Permission", C.role_label(role) or "Unknown", C.norm_name(by) or NOT_RECORDED, st, None)
            )
    if "casual_leave" in keys:
        for role, by, st, created, at in CasualLeaveRequest.objects.filter(
            emp_q, status__in=decided, reviewed_at__gte=start_dt, reviewed_at__lt=end_dt
        ).values_list("reviewer_role", "reviewed_by", "status", "created_at", "reviewed_at"):
            events.append(
                Event(
                    "Casual Leave",
                    C.role_label(role) or "Unknown",
                    C.norm_name(by) or NOT_RECORDED,
                    st,
                    C.hours_between(created, at),
                )
            )
    if "missing_punch" in keys:
        rows = MissingPunchRequest.objects.filter(
            emp_q,
            Q(hod_reviewed_at__gte=start_dt, hod_reviewed_at__lt=end_dt)
            | Q(hr_reviewed_at__gte=start_dt, hr_reviewed_at__lt=end_dt),
        ).values_list("status", "hod_reviewed_by", "hod_reviewed_at", "hr_reviewed_by", "hr_reviewed_at", "created_at")
        for st, hod_by, hod_at, hr_by, hr_at, created in rows:
            if _in_range(hod_at, start_dt, end_dt):
                decision = "rejected" if (st == "rejected" and hr_at is None) else "approved"
                events.append(
                    Event(
                        _stage_module("missing_punch", "HOD"),
                        "HOD",
                        C.norm_name(hod_by) or NOT_RECORDED,
                        decision,
                        C.hours_between(created, hod_at),
                    )
                )
            if _in_range(hr_at, start_dt, end_dt) and st in decided:
                events.append(
                    Event(
                        _stage_module("missing_punch", "HR"),
                        "HR",
                        C.norm_name(hr_by) or NOT_RECORDED,
                        st,
                        C.hours_between(hod_at or created, hr_at),
                    )
                )
    if "on_duty" in keys:
        rows = OnDutySession.objects.filter(
            emp_q,
            Q(hod_reviewed_at__gte=start_dt, hod_reviewed_at__lt=end_dt)
            | Q(hr_reviewed_at__gte=start_dt, hr_reviewed_at__lt=end_dt),
        ).values_list("status", "hod_reviewed_by", "hod_reviewed_at", "hr_reviewed_by", "hr_reviewed_at", "created_at")
        for st, hod_by, hod_at, hr_by, hr_at, created in rows:
            if _in_range(hod_at, start_dt, end_dt):
                decision = "rejected" if (st == "rejected" and hr_at is None) else "approved"
                events.append(
                    Event(
                        _stage_module("on_duty", "HOD"),
                        "HOD",
                        C.norm_name(hod_by) or NOT_RECORDED,
                        decision,
                        C.hours_between(created, hod_at),
                    )
                )
            if _in_range(hr_at, start_dt, end_dt):
                decision = "rejected" if st == "rejected" else "approved"
                events.append(
                    Event(
                        _stage_module("on_duty", "HR"),
                        "HR",
                        C.norm_name(hr_by) or NOT_RECORDED,
                        decision,
                        C.hours_between(hod_at or created, hr_at),
                    )
                )
    if "on_duty_punch" in keys:
        for by, st, created, at in (
            OnDutyPunchVerification.objects.filter(
                emp_q,
                status__in=decided,
                hr_reviewed_at__gte=start_dt,
                hr_reviewed_at__lt=end_dt,
            )
            .exclude(hr_review_comment__startswith="Voided automatically")
            .values_list("hr_reviewed_by", "status", "created_at", "hr_reviewed_at")
        ):
            events.append(
                Event("On-Duty Punch", "HR", C.norm_name(by) or NOT_RECORDED, st, C.hours_between(created, at))
            )
    if "attendance_override" in keys:
        for by, st, created, at in AttendanceOverrideRequest.objects.filter(
            emp_q,
            status__in=decided,
            reviewed_by__isnull=False,
            reviewed_at__gte=start_dt,
            reviewed_at__lt=end_dt,
        ).values_list("reviewed_by", "status", "created_at", "reviewed_at"):
            events.append(
                Event("Attendance Correction", "HOD", C.norm_name(by) or NOT_RECORDED, st, C.hours_between(created, at))
            )
    if "outpass" in keys:
        # Approved passes carry approved_at; a rejected one has no decision time, so it is placed by request date.
        window = Q(approved_at__gte=start_dt, approved_at__lt=end_dt) | (Q(approved_at__isnull=True) & in_created)
        for role, by, st, created, at in OutpassRequest.objects.filter(
            emp_q, window, status__in=decided, source="manual"
        ).values_list("approver_role", "approved_by", "status", "created_at", "approved_at"):
            events.append(
                Event(
                    "Outpass",
                    C.role_label(role) or "Unknown",
                    C.norm_name(by) or NOT_RECORDED,
                    st,
                    C.hours_between(created, at) if st == "approved" else None,
                )
            )
    if "employee_request" in keys:
        for by, st, created, at in EmployeeRequest.objects.filter(
            emp_q,
            status__in=decided,
            handled_at__gte=start_dt,
            handled_at__lt=end_dt,
        ).values_list("handled_by", "status", "created_at", "handled_at"):
            events.append(
                Event("Employee Request", "HR", C.norm_name(by) or NOT_RECORDED, st, C.hours_between(created, at))
            )
    return events


_WORKLOAD_COLUMNS = (
    ColumnSpec("approverName", "Approver", TEXT, 2.2),
    ColumnSpec("approverRole", "Role", BADGE, 0.8),
    ColumnSpec("module", "Request", TEXT, 2.0),
    ColumnSpec("approved", "Approved", INTEGER, 0.8, total="sum"),
    ColumnSpec("rejected", "Rejected", INTEGER, 0.8, total="sum"),
    ColumnSpec("total", "Decisions", INTEGER, 0.8, total="sum"),
    ColumnSpec("rejectionRate", "Rejection rate", PERCENT, 0.9),
    ColumnSpec("avgTurnaroundHours", "Avg turnaround (hrs)", HOURS, 1.0),
    ColumnSpec("maxTurnaroundHours", "Slowest (hrs)", HOURS, 1.0),
    ColumnSpec("pendingNow", "Waiting now", INTEGER, 0.8),
    ColumnSpec("timingBasis", "Timing basis", BADGE, 1.3),
)


def _run_workload(ctx) -> ReportResult:
    start_dt, end_dt = C.ist_bounds(ctx.date_from, ctx.date_to)
    allowed = _visible(ctx, WORKLOAD_FLOWS)
    requested = ctx.param("module") or []
    keys = [k for k in allowed if not requested or k in requested]
    events = _workload_events(ctx, set(keys), start_dt, end_dt)

    role_wanted = {"hr": "HR", "dept_head": "HOD"}.get(ctx.param("approverRole") or "")
    name_wanted = (ctx.param("approverName") or "").strip().lower()

    def wanted(role: str, name: str) -> bool:
        return (not role_wanted or role == role_wanted) and (not name_wanted or name_wanted in name.lower())

    groups: dict[tuple[str, str, str], dict] = {}

    def group(role: str, name: str, module: str) -> dict:
        return groups.setdefault((role, name, module), {"approved": 0, "rejected": 0, "hours": [], "pending": 0})

    timed_by_approver: dict[tuple[str, str], list[float]] = defaultdict(list)
    decisions_by_role: dict[str, int] = defaultdict(int)
    for ev in events:
        if not wanted(ev.role, ev.name):
            continue
        g = group(ev.role, ev.name, ev.module)
        g[ev.decision] += 1
        decisions_by_role[ev.role] += 1
        if ev.hours is not None:
            g["hours"].append(ev.hours)
            timed_by_approver[(ev.role, ev.name)].append(ev.hours)

    # Work still waiting, by the CURRENT HOD / the shared HR queue -- not limited to the date range.
    items = collect_pending(ctx, keys)
    directory = C.HodDirectory({i.emp.id for i in items})
    pending_total = 0
    for it in items:
        holder, _text, _assigned, hod_name = resolve_holder(it, directory)
        counted = False
        if holder in ("hod", "either") and hod_name and wanted("HOD", hod_name):
            group("HOD", hod_name, _stage_module(it.workflow, "HOD"))["pending"] += 1
            counted = True
        if holder in ("hr", "either") and wanted("HR", HR_QUEUE):
            group("HR", HR_QUEUE, _stage_module(it.workflow, "HR"))["pending"] += 1
            counted = True
        pending_total += counted

    rows = []
    for (role, name, module), g in sorted(groups.items(), key=lambda kv: (kv[0][1].lower(), kv[0][0], kv[0][2])):
        total = g["approved"] + g["rejected"]
        hours = g["hours"]
        shows_pending = role == "HOD" or name == HR_QUEUE
        rows.append(
            {
                "approverName": name,
                "approverRole": role,
                "module": module,
                "approved": g["approved"],
                "rejected": g["rejected"],
                "total": total,
                "rejectionRate": round(g["rejected"] / total * 100, 1) if total else None,
                "avgTurnaroundHours": round(sum(hours) / len(hours), 2) if hours else None,
                "maxTurnaroundHours": max(hours) if hours else None,
                "pendingNow": g["pending"] if shows_pending else None,
                "timingBasis": _timing_basis(module),
            }
        )

    all_hours = [h for hs in timed_by_approver.values() for h in hs]
    named = {k: sum(v) / len(v) for k, v in timed_by_approver.items() if k[1] != NOT_RECORDED}
    fastest = min(named.items(), key=lambda kv: (kv[1], kv[0][1]), default=None)
    slowest = max(named.items(), key=lambda kv: (kv[1], kv[0][1]), default=None)
    summary = [
        {"label": "Decisions in the period", "value": sum(r["total"] for r in rows), "format": "integer"},
        {
            "label": "Average turnaround (hrs)",
            "value": round(sum(all_hours) / len(all_hours), 2) if all_hours else None,
            "format": "hours",
        },
        {"label": "Decided by HR", "value": decisions_by_role.get("HR", 0), "format": "integer"},
        {"label": "Decided by HODs", "value": decisions_by_role.get("HOD", 0), "format": "integer"},
        {
            "label": "Fastest approver",
            "value": f"{fastest[0][1]} ({fastest[1]:.1f} h)" if fastest else None,
            "format": "text",
        },
        {
            "label": "Slowest approver",
            "value": f"{slowest[0][1]} ({slowest[1]:.1f} h)" if slowest else None,
            "format": "text",
        },
        {"label": "Requests waiting now", "value": pending_total, "format": "integer"},
    ]
    notes = [
        "Decisions are counted on the day they were taken (IST). Leave, permission and rejected outpass requests "
        "store no decision time, so they are placed by the day the request was raised and their turnaround is "
        "left blank; approvals are grouped by the approver's role and the name stored on the request (free text, "
        "so two people sharing a name are merged).",
        "Missing-punch and on-duty requests have two stages, listed separately: turnaround is the time that "
        "stage held the request (the HR stage is measured from the HOD's decision, or from filing when HR "
        "decided directly). Employee-request turnaround uses the 'last handled' time, which is approximate.",
        "Left out: attendance corrections superseded by a newer request, on-duty punches voided automatically "
        "when their request was rejected, and outpasses created automatically by an on-duty approval. "
        "On-duty punches approved together with their session each count as one HR decision.",
        "'Waiting now' is today's backlog (not limited to the dates chosen): HOD rows show requests currently "
        "waiting on that HOD, the shared HR row shows requests HR can act on. A request that HOD or HR may "
        "decide appears in both, so the column is not additive.",
    ]
    hidden = [WORKFLOWS[k][0] for k in WORKLOAD_FLOWS if k not in allowed]
    if hidden:
        notes.append("Not shown because your role cannot open them elsewhere in the app: " + ", ".join(hidden) + ".")
    return ReportResult(rows=rows, summary=summary, notes=notes)


register(
    ReportSpec(
        id="approver-workload-turnaround",
        title="Approver Workload & Turnaround",
        description="Per approver (HR / HOD) and request type: decisions taken, approve-reject split, turnaround and work still waiting.",
        category=CATEGORY,
        icon="Users",
        tags=("approver", "hod", "turnaround", "workload", "sla"),
        modules=OWNING_MODULES,
        filters=(
            date_range(label="Decided between"),
            select(
                "module",
                "Request type",
                tuple((k, WORKFLOWS[k][0]) for k in WORKLOAD_FLOWS),
                multi=True,
                placeholder="All request types",
            ),
            *scope(designation=False, status=None),
            select("approverRole", "Approver role", (("hr", "HR"), ("dept_head", "Department head"))),
            text("approverName", "Approver name", placeholder="Name"),
        ),
        columns=_WORKLOAD_COLUMNS,
        run=_run_workload,
    )
)

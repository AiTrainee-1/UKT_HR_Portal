"""
The Department Head's request history for the mobile Approvals tab (2026-10-31).

    GET /api/manager/requests/summary
        {categories: [{key, workflow, label, pending, approved, rejected}], total: {pending, approved, rejected}}
    GET /api/manager/requests?category=<key>&status=pending|approved|rejected&search=&page=&page_size=
        {category, status, search, counts: {pending, approved, rejected}, items, page, pageSize, total, hasMore}

Category keys: leave, permission, casual_leave, attendance, missing_punch, on_duty, outpass, holiday_work, resignation
(the camel spellings the app uses - casualLeave, missingPunch, onDuty, holidayWork, attendanceCorrection - are accepted
too). On-Duty (added 2026-10-31) counts as finally approved once it is `active` or `completed`, and its rows carry the
day and the punches recorded under it.

Scope - a head never sees more here than GET /manager/pending-requests?status=all already shows them:
  * only an ACTIVE DepartmentManager row for the signed-in employee (HR tokens and other employees: 403);
  * only the employees that really report to this head under the one-HOD-per-employee rule (hod_scope.py:
    individual assignments, departments - which belong to one branch - and HR's carve-outs), never their own requests;
  * a category behind a per-person switch is only listed while that switch is on (Leave and Permission are always
    listed, as on the Approvals tab; Outpass follows the Permissions switch); a switched-off category answers 403.

The three statuses, for one head:
  * pending  - waiting for THIS head's decision now under HR's pipeline: exactly the rows /manager/pending-requests
               lists (approval_workflow.filter_actionable), so the number matches the tab badge.
  * approved - finally approved, OR approved by the Department Head and now waiting for HR (outcome.state
               "in_progress"); the head's own approval belongs here even before HR has finished.
  * rejected - finally rejected (by whoever).
A request still waiting for someone else that the Department Head has not touched (HR goes first, or HR alone decides
it) is in none of the three until it reaches the head or is decided.

Every row is the same JSON /manager/pending-requests sends for that category (so the app renders both alike, with its
`approval` block), plus `historyStatus` and an `outcome` block saying who decided it - "you", another Department Head
or HR - read from the approval trail, with the trail itself (`outcome.decisions`).
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Callable

from django.db.models import Q
from django.utils import timezone
from rest_framework.decorators import api_view
from rest_framework.request import Request
from rest_framework.response import Response

from . import approval_workflow as approval
from .auth import get_token_employee_id, require_auth
from .branch_scope import scope_to_branch
from .clock import FACTORY_TZ
from .hod_scope import managed_employee_ids
from .models import (
    AttendanceOverrideRequest,
    CasualLeaveRequest,
    DepartmentManager,
    EmployeePermission,
    HolidayWorkClaim,
    LeaveRequest,
    MissingPunchRequest,
    OnDutySession,
    OutpassRequest,
    ResignationRequest,
)

STATUSES = ("pending", "approved", "rejected")
DEFAULT_PAGE_SIZE = 20
MAX_PAGE_SIZE = 50
_EMP = ("employee__department", "employee__designation", "employee__branch")


def _nested_employee(emp) -> dict:
    """The nested `employee` object /manager/pending-requests adds to leave and permission rows."""
    return {
        "id": emp.id,
        "employeeCode": emp.employee_code,
        "name": f"{emp.first_name} {emp.last_name}",
        "firstName": emp.first_name,
        "lastName": emp.last_name,
        "department": emp.department.name if emp.department_id and emp.department else None,
        "designation": emp.designation.title if emp.designation_id and emp.designation else None,
    }


def _rows_leave(rows, cfg):
    from .serializers import leave_request_json

    out = []
    for r in rows:
        data = leave_request_json(r, cfg=cfg)
        data["employee"] = _nested_employee(r.employee)
        out.append(data)
    return out


def _rows_permission(rows, cfg):
    from .leave_views import _CapStatusCache, _permission_json
    from .models import PayrollSettings

    settings = PayrollSettings.get()
    cache = _CapStatusCache(settings.permission_monthly_cap)
    out = []
    for p in rows:
        data = _permission_json(p, settings=settings, cap_cache=cache, cfg=cfg)
        data["employee"] = _nested_employee(p.employee)
        out.append(data)
    return out


def _rows_casual(rows, cfg):
    from .casual_leave_views import _cl_dict

    return [_cl_dict(r, cfg) for r in rows]


def _rows_attendance(rows, cfg):
    from .growth_views import _override_request_dict

    return [_override_request_dict(r, cfg) for r in rows]


def _rows_missing_punch(rows, cfg):
    from .missing_punch_views import _missing_punch_dict

    return [_missing_punch_dict(r, cfg) for r in rows]


def _rows_outpass(rows, cfg):
    from .outpass_request_views import _outpass_request_json

    return [_outpass_request_json(r, with_employee=True, cfg=cfg) for r in rows]


def _rows_holiday_work(rows, cfg):
    from .holiday_work_views import claims_json

    return claims_json(list(rows))


def _rows_on_duty(rows, cfg):
    """The On-Duty row /manager/pending-requests sends (onDutySessions), plus what the head needs to judge it: the day
    (`date`, factory time) and every punch recorded under it with its time, place and whether it has photos (open them
    with GET /on-duty-punch-verifications/<id>/photo?n=1|2, which lets the employee's own Department Head in)."""
    from .geo_attendance_views import _on_duty_session_dict

    out = []
    for s in rows:
        data = _on_duty_session_dict(s, cfg=cfg)
        when = s.started_at or s.created_at
        data["date"] = timezone.localtime(when, FACTORY_TZ).date().isoformat() if when else None
        punches = sorted(s.punch_verifications.all(), key=lambda v: (v.punch_date, v.punch_number, v.id))
        data["punches"] = [
            {
                "id": v.id,
                "punchDate": v.punch_date.isoformat(),
                "punchTime": v.punch_time.strftime("%H:%M"),
                "punchType": v.punch_type,
                "punchNumber": v.punch_number,
                "status": v.status,
                "hasPhoto": bool(v.photo),
                "hasPhoto2": bool(v.photo2),
                "latitude": float(v.latitude) if v.latitude is not None else None,
                "longitude": float(v.longitude) if v.longitude is not None else None,
                "accuracyM": v.accuracy_m,
                "isMocked": v.is_mocked,
            }
            for v in punches
        ]
        out.append(data)
    return out


def _rows_resignation(rows, cfg):
    from .recruitment_views import _resignation_json

    return [_resignation_json(r, cfg) for r in rows]


@dataclass(frozen=True)
class Category:
    key: str
    workflow: str  # approval_workflow key
    label: str
    model: type
    pending_statuses: tuple[str, ...]
    switch: str | None  # DepartmentManager can_approve_* field that must be on, None = always listed
    rows: Callable
    select: tuple[str, ...] = _EMP
    prefetch: tuple[str, ...] = ()
    extra: dict = field(default_factory=dict)
    # Fields that name whoever decided a request made before the approval trail existed.
    legacy_names: tuple[str, ...] = ()
    aliases: tuple[str, ...] = ()
    # The statuses that mean "finally approved" (an approved On-Duty request is running or finished).
    approved_statuses: tuple[str, ...] = ("approved",)


CATEGORIES: tuple[Category, ...] = (
    Category("leave", "leave", "Leave", LeaveRequest, ("pending",), None, _rows_leave, legacy_names=("approved_by",)),
    Category(
        "permission",
        "permission",
        "Permission",
        EmployeePermission,
        ("pending",),
        None,
        _rows_permission,
        legacy_names=("approved_by",),
    ),
    Category(
        "casual_leave",
        "casual_leave",
        "Casual Leave",
        CasualLeaveRequest,
        ("pending",),
        "can_approve_casual_leave",
        _rows_casual,
        legacy_names=("reviewed_by",),
        aliases=("casualleave", "casual"),
    ),
    Category(
        "attendance",
        "attendance_correction",
        "Attendance",
        AttendanceOverrideRequest,
        ("pending",),
        "can_approve_attendance",
        _rows_attendance,
        legacy_names=("reviewed_by",),
        aliases=("attendance_correction", "attendancecorrection"),
    ),
    Category(
        "missing_punch",
        "missing_punch",
        "Missing Punch",
        MissingPunchRequest,
        (MissingPunchRequest.STATUS_PENDING_HOD, MissingPunchRequest.STATUS_PENDING_HR),
        "can_approve_missing_punch",
        _rows_missing_punch,
        legacy_names=("hr_reviewed_by", "hod_reviewed_by"),
        aliases=("missingpunch",),
    ),
    Category(
        "on_duty",
        "on_duty",
        "On-Duty",
        OnDutySession,
        (OnDutySession.STATUS_PENDING_HOD, OnDutySession.STATUS_PENDING_HR),
        "can_approve_on_duty",
        _rows_on_duty,
        select=("employee__department", "employee__designation", "employee__branch", "branch"),
        prefetch=("punch_verifications",),
        legacy_names=("hr_reviewed_by", "hod_reviewed_by"),
        aliases=("onduty",),
        approved_statuses=(OnDutySession.STATUS_ACTIVE, OnDutySession.STATUS_COMPLETED),
    ),
    Category(
        "outpass",
        "outpass",
        "Outpass",
        OutpassRequest,
        ("pending",),
        # The Approvals tab and manager_update_outpass_status share the Permissions switch.
        "can_approve_permissions",
        _rows_outpass,
        extra={"source": OutpassRequest.SOURCE_MANUAL},
        legacy_names=("approved_by",),
    ),
    Category(
        "holiday_work",
        "holiday_work",
        "Compensation",
        HolidayWorkClaim,
        ("pending",),
        "can_approve_compensation",
        _rows_holiday_work,
        prefetch=("ledger_entries",),
        legacy_names=("reviewed_by",),
        aliases=("holidaywork", "compensation"),
    ),
    Category(
        "resignation",
        "resignation",
        "Resignations",
        ResignationRequest,
        ("pending", "dept_approved"),
        "can_approve_resignations",
        _rows_resignation,
        select=("employee__department", "employee__designation", "employee__branch", "dept_head"),
        legacy_names=("approved_by",),
        aliases=("resignations",),
    ),
)
_BY_KEY = {c.key: c for c in CATEGORIES}
for _c in CATEGORIES:
    for _a in _c.aliases:
        _BY_KEY[_a] = _c


def category_for(raw: str | None) -> Category | None:
    key = (raw or "").strip().lower().replace("-", "_")
    return _BY_KEY.get(key) or _BY_KEY.get(key.replace("_", ""))


def allowed(m: DepartmentManager, cat: Category) -> bool:
    return cat.switch is None or bool(getattr(m, cat.switch, False))


# ─────────────────────────── who decided ───────────────────────────


def _full_name(emp) -> str:
    return f"{emp.first_name} {emp.last_name}".strip()


def _same_person(a, b: str) -> bool:
    return isinstance(a, str) and a.strip().casefold() == b.strip().casefold() and b.strip() != ""


def _legacy_role(obj) -> str | None:
    raw = (getattr(obj, "approver_role", None) or getattr(obj, "reviewer_role", None) or "").strip().lower()
    if raw in ("hod", "dept_head", "department_head", "manager"):
        return approval.HOD
    if raw == "hr":
        return approval.HR
    return None


def _decision_json(e: dict) -> dict:
    out = {
        "role": e.get("role"),
        "decision": e.get("decision"),
        "by": e.get("by"),
        "at": e.get("at"),
        "comment": e.get("comment"),
    }
    if e.get("skipped"):
        out["skipped"] = list(e["skipped"])
    return out


def _iso(value):
    return value.isoformat() if value else None


def trail_for(cat: Category, obj) -> list[dict]:
    """approval_workflow.trail_of, except for a missing-punch / On-Duty request REJECTED before the trail existed: its
    old per-role stamps only ever meant approvals there, so the last reviewer stamped is the one who rejected it."""
    trail = approval.trail_of(cat.workflow, obj)
    if getattr(obj, "approval_trail", None) is not None or getattr(obj, "status", None) != "rejected":
        return trail
    if not hasattr(obj, "hod_reviewed_by"):
        return trail
    if obj.hr_reviewed_by:
        kept = [e for e in trail if e.get("role") != approval.HR]
        return kept + [
            {
                "role": approval.HR,
                "decision": "rejected",
                "by": obj.hr_reviewed_by,
                "at": _iso(obj.hr_reviewed_at),
                "comment": getattr(obj, "hr_review_comment", None),
            }
        ]
    if obj.hod_reviewed_by:
        return [
            {
                "role": approval.HOD,
                "decision": "rejected",
                "by": obj.hod_reviewed_by,
                "at": _iso(obj.hod_reviewed_at),
                "comment": getattr(obj, "hod_review_comment", None),
            }
        ]
    return trail


def outcome_of(cat: Category, obj, *, me_name: str, me_employee_id: int, actionable: bool) -> tuple[str | None, dict]:
    """(bucket, outcome) for one request seen by one head. bucket None = in none of the three lists (see module doc)."""
    status = getattr(obj, "status", None)
    trail = trail_for(cat, obj)
    decided = [e for e in trail if e.get("decision") in ("approved", "rejected")]
    hod_entries = [e for e in decided if e.get("role") == approval.HOD]
    hod_entry = hod_entries[-1] if hod_entries else None

    mine = None
    if hod_entry is not None and _same_person(hod_entry.get("by"), me_name):
        mine = hod_entry
    elif hod_entry is not None and cat.key == "resignation" and getattr(obj, "dept_head_id", None) == me_employee_id:
        mine = hod_entry  # a resignation stamps the deciding head's own employee record

    final = None
    if status in cat.approved_statuses:
        final = next((e for e in reversed(decided) if e.get("decision") == "approved"), None)
        state = "approved"
    elif status == "rejected":
        final = next((e for e in reversed(decided) if e.get("decision") == "rejected"), None)
        state = "rejected"
    elif status in cat.pending_statuses:
        state = (
            "pending" if actionable else ("in_progress" if hod_entry and hod_entry["decision"] == "approved" else None)
        )
    else:  # cancelled / withdrawn / anything else: not one of the three
        state = None

    bucket = {"pending": "pending", "in_progress": "approved", "approved": "approved", "rejected": "rejected"}.get(
        state or ""
    )

    decided_by_role = final.get("role") if final else None
    decided_by_name = final.get("by") if final else None
    if state in ("approved", "rejected") and final is None:
        # Decided before the approval trail existed: the name the request kept, the role if it says.
        decided_by_role = _legacy_role(obj)
        decided_by_name = next(
            (getattr(obj, f) for f in cat.legacy_names if isinstance(getattr(obj, f, None), str) and getattr(obj, f)),
            None,
        )
        if decided_by_name and decided_by_name.strip().lower() in ("hr", "dept_head", "system"):
            decided_by_role = decided_by_role or {"hr": approval.HR, "dept_head": approval.HOD}.get(
                decided_by_name.strip().lower()
            )
            decided_by_name = None

    decided_by_you = bool(final is not None and final is mine)
    if final is None and decided_by_name and _same_person(decided_by_name, me_name):
        decided_by_you = True  # a legacy row that kept this head's name
    your_decision = mine.get("decision") if mine else (state if decided_by_you else None)
    return bucket, {
        "state": state,
        # "approved" | "rejected" | None: what THIS head decided on it (it may differ from the final outcome).
        "yourDecision": your_decision,
        "yourDecisionAt": mine.get("at") if mine else None,
        "yourComment": mine.get("comment") if mine else None,
        "decidedByYou": decided_by_you,
        "decidedByRole": decided_by_role,
        "decidedByName": decided_by_name,
        "decidedAt": final.get("at") if final else None,
        "decisions": [_decision_json(e) for e in decided],
    }


# ─────────────────────────── scope ───────────────────────────


def _manager_for(request: Request):
    """(manager, None) for an active Department Head, else (None, 403 response)."""
    token_emp_id = get_token_employee_id(request)
    if not token_emp_id:
        return None, Response({"error": "Employee authentication required"}, status=403)
    m = (
        scope_to_branch(DepartmentManager.objects, request, field="employee__branch_id")
        .select_related("employee")
        .filter(employee_id=token_emp_id, is_active=True)
        .first()
    )
    if m is None:
        return None, Response({"error": "Not a department manager"}, status=403)
    return m, None


def _scope_filter(m: DepartmentManager) -> Q:
    """The same filter /manager/pending-requests builds: the head's real reports, never the head."""
    return Q(employee_id__in=managed_employee_ids(m)) & ~Q(employee_id=m.employee_id)


def _search_filter(text: str) -> Q:
    q = Q()
    for term in text.split()[:5]:
        q &= (
            Q(employee__first_name__icontains=term)
            | Q(employee__last_name__icontains=term)
            | Q(employee__employee_code__icontains=term)
        )
    return q


def _base_qs(cat: Category, scope: Q):
    qs = cat.model.objects.filter(scope, **cat.extra).select_related(*cat.select)
    if cat.prefetch:
        qs = qs.prefetch_related(*cat.prefetch)
    return qs


def _split_pending(cat: Category, qs, cfg) -> tuple[list, list]:
    """(pending for this head now, approved by a Department Head and waiting for someone else) among the open rows."""
    mine, forwarded = [], []
    for obj in qs.filter(status__in=cat.pending_statuses).order_by("created_at", "id"):
        if approval.can_act(cat.workflow, obj, approval.HOD, cfg):
            mine.append(obj)
            continue
        roles = [e for e in trail_for(cat, obj) if e.get("role") == approval.HOD]
        if roles and roles[-1].get("decision") == "approved":
            forwarded.append(obj)
    return mine, forwarded


def _counts(cat: Category, qs, cfg) -> tuple[dict, list, list]:
    pending, forwarded = _split_pending(cat, qs, cfg)
    return (
        {
            "pending": len(pending),
            "approved": qs.filter(status__in=cat.approved_statuses).count() + len(forwarded),
            "rejected": qs.filter(status="rejected").count(),
        },
        pending,
        forwarded,
    )


def _int(raw, default: int, lo: int, hi: int) -> int:
    try:
        value = int(raw)
    except (TypeError, ValueError):
        return default
    return max(lo, min(hi, value))


# ─────────────────────────── endpoints ───────────────────────────


@api_view(["GET"])
@require_auth
def manager_requests_summary(request: Request) -> Response:
    m, refusal = _manager_for(request)
    if refusal:
        return refusal
    scope = _scope_filter(m)
    cfgs = approval.all_configs()
    categories, total = [], {s: 0 for s in STATUSES}
    for cat in CATEGORIES:
        if not allowed(m, cat):
            continue
        counts, _p, _f = _counts(cat, _base_qs(cat, scope), cfgs[cat.workflow])
        for s in STATUSES:
            total[s] += counts[s]
        categories.append({"key": cat.key, "workflow": cat.workflow, "label": cat.label, **counts})
    return Response({"categories": categories, "total": total})


@api_view(["GET"])
@require_auth
def manager_requests(request: Request) -> Response:
    m, refusal = _manager_for(request)
    if refusal:
        return refusal

    params = request.query_params
    cat = category_for(params.get("category"))
    if cat is None:
        return Response(
            {"error": f"category must be one of: {', '.join(c.key for c in CATEGORIES)}", "code": "bad_category"},
            status=400,
        )
    if not allowed(m, cat):
        return Response(
            {
                "error": f"You can't approve {cat.label.lower()} requests any more. Ask HR if this is wrong.",
                "code": "category_disabled",
            },
            status=403,
        )
    status = (params.get("status") or "pending").strip().lower()
    if status not in STATUSES:
        return Response({"error": "status must be pending, approved or rejected", "code": "bad_status"}, status=400)
    page = _int(params.get("page"), 1, 1, 10_000)
    page_size = _int(params.get("page_size") or params.get("pageSize"), DEFAULT_PAGE_SIZE, 1, MAX_PAGE_SIZE)
    search = (params.get("search") or params.get("q") or "").strip()[:80]

    cfg = approval.all_configs()[cat.workflow]
    qs = _base_qs(cat, _scope_filter(m))
    counts, pending, forwarded = _counts(cat, qs, cfg)

    matching = qs.filter(_search_filter(search)) if search else qs
    if status == "pending":
        ids = set(matching.filter(pk__in=[o.pk for o in pending]).values_list("pk", flat=True)) if search else None
        rows_all = [o for o in pending if ids is None or o.pk in ids]  # oldest first: the longest wait at the top
        total = len(rows_all)
        rows = rows_all[(page - 1) * page_size : page * page_size]
    else:
        if status == "approved":
            listed = matching.filter(Q(status__in=cat.approved_statuses) | Q(pk__in=[o.pk for o in forwarded]))
        else:
            listed = matching.filter(status="rejected")
        listed = listed.order_by("-created_at", "-id")
        total = listed.count()
        rows = list(listed[(page - 1) * page_size : page * page_size])

    pending_ids = {o.pk for o in pending}
    me_name = _full_name(m.employee)
    items = cat.rows(rows, cfg)
    for obj, data in zip(rows, items):
        bucket, outcome = outcome_of(
            cat, obj, me_name=me_name, me_employee_id=m.employee_id, actionable=obj.pk in pending_ids
        )
        data["category"] = cat.key
        data["historyStatus"] = bucket
        data["outcome"] = outcome

    return Response(
        {
            "category": cat.key,
            "status": status,
            "search": search,
            "counts": counts,
            "items": items,
            "page": page,
            "pageSize": page_size,
            "total": total,
            "hasMore": page * page_size < total,
        }
    )

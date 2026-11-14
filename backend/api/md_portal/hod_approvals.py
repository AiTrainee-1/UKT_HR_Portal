"""HOD approvals in the MD portal (/md/approvals, 2026-11-14).

The Managing Director sees, and decides, the requests waiting for the Department Heads who work in the MD department:
an employee whose own department is called "MD" (or "Managing Director") and who is an active Department Head in User
Management. Adding someone to that department and making them a Department Head is all it takes; taking either away
removes them, because the list is worked out on every request.

Nothing here re-implements an approval. The rows are what the Department Head's own app lists
(manager_views.hod_requests) and a decision runs the very function their own button runs (manager_views.hod_decide_*,
recruitment_views.hod_decide_resignation), at the Department Head's step of the pipeline HR configured: the same
checks, the same next step (HR, when the pipeline has one), the same notices to the employee. The decision is recorded
as "<MD> (MD, for <Department Head>)" and written to the audit log under the MD's account.

The rows of nine kinds are flattened here into one shape (`item`) so the page can list them together.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Callable

from django.db.models import Q

from ..models import Department, DepartmentManager

# Department names (any case) that make a Department Head one of the MD's.
MD_DEPARTMENT_NAMES = ("md", "managing director")

STATUSES = ("pending", "approved", "rejected", "all")
DECISIONS = ("approved", "rejected")
GROUPS = ("leave", "permission", "other")


@dataclass(frozen=True)
class Kind:
    key: str  # the approval workflow key (approval_workflow.py)
    label: str
    group: str  # leave | permission | other
    rows: str  # the list in manager_views.hod_requests()
    right: str  # the DepartmentManager switch HR sets in User Management
    right_label: str


KINDS: dict[str, Kind] = {
    k.key: k
    for k in (
        Kind("leave", "Leave", "leave", "leaveRequests", "can_approve_leaves", "approve leave"),
        Kind(
            "casual_leave", "Casual leave", "leave", "casualLeaves", "can_approve_casual_leave", "approve casual leave"
        ),
        Kind("permission", "Permission", "permission", "permissions", "can_approve_permissions", "approve permission"),
        Kind("outpass", "Outpass", "permission", "outpassRequests", "can_approve_permissions", "approve permission"),
        Kind(
            "missing_punch",
            "Missing punch",
            "other",
            "missingPunchRequests",
            "can_approve_missing_punch",
            "approve missing punch",
        ),
        Kind("on_duty", "On-Duty", "other", "onDutySessions", "can_approve_on_duty", "approve On-Duty"),
        Kind(
            "attendance_correction",
            "Attendance change",
            "other",
            "attendanceRequests",
            "can_approve_attendance",
            "approve attendance",
        ),
        Kind(
            "holiday_work",
            "Holiday work",
            "other",
            "holidayWorkClaims",
            "can_approve_compensation",
            "approve compensation",
        ),
        Kind("resignation", "Resignation", "other", "resignations", "can_approve_resignations", "approve resignation"),
    )
}


# ─── who the MD's Department Heads are ──────────────────────────────────────────────────────────────────────────


def md_department_q(prefix: str = "") -> Q:
    q = Q()
    for name in MD_DEPARTMENT_NAMES:
        q |= Q(**{f"{prefix}name__iexact": name})
    return q


def md_departments() -> list[Department]:
    return list(Department.objects.select_related("branch").filter(md_department_q()).order_by("name", "id"))


def md_hods():
    """The active Department Heads whose own department is the MD department, by name."""
    return (
        DepartmentManager.objects.select_related("employee__department", "employee__designation", "employee__branch")
        .defer("employee__photo_url")
        .prefetch_related("department_assignments__department", "employee_assignments")
        .filter(is_active=True)
        .filter(md_department_q("employee__department__"))
        .order_by("employee__first_name", "employee__last_name", "id")
    )


def md_hod(manager_id: int) -> DepartmentManager | None:
    return md_hods().filter(pk=manager_id).first()


def hod_name(m: DepartmentManager) -> str:
    e = m.employee
    return " ".join(p for p in (e.first_name, e.last_name) if p and p.strip(" .")).strip() or e.employee_code


def hod_json(m: DepartmentManager, pending: dict[str, int] | None = None) -> dict:
    from ..hod_scope import managed_employee_ids

    e = m.employee
    people = [i for i in managed_employee_ids(m) if i != e.id]
    return {
        "id": m.id,
        "employeeId": e.id,
        "code": e.employee_code,
        "name": hod_name(m),
        "designation": e.designation.title if e.designation_id and e.designation else None,
        "department": e.department.name if e.department_id and e.department else None,
        "branch": e.branch.name if e.branch_id and e.branch else None,
        "employeeStatus": e.status,
        "oversees": {
            "departments": sorted({a.department.name for a in m.department_assignments.all() if a.department_id}),
            "people": len(people),
        },
        "rights": {k.key: bool(getattr(m, k.right)) for k in KINDS.values()},
        "pending": pending if pending is not None else pending_counts(m),
    }


def pending_counts(m: DepartmentManager) -> dict[str, int]:
    """What this Department Head can decide right now, by group (the same counts their own app shows)."""
    from ..manager_views import _hod_pending_counts, hod_emp_filter

    raw = _hod_pending_counts(m, hod_emp_filter(m))
    out = {g: 0 for g in GROUPS}
    for key, n in raw.items():
        out[KINDS[key].group if key in KINDS else "other"] += n
    out["total"] = sum(raw.values())
    return out


def hods_payload() -> dict:
    depts = md_departments()
    return {
        "hods": [hod_json(m) for m in md_hods()],
        "mdDepartments": [
            {"id": d.id, "name": d.name, "branch": d.branch.name if d.branch_id and d.branch else None} for d in depts
        ],
    }


# ─── one shape for nine kinds of request ────────────────────────────────────────────────────────────────────────


def _date_part(value: Any) -> str | None:
    return str(value)[:10] if value else None


def _num(value: Any) -> str:
    try:
        return f"{float(value):g}"
    except (TypeError, ValueError):
        return str(value)


def _plural(value: Any, word: str) -> str:
    text = _num(value)
    return f"{text} {word}" if text == "1" else f"{text} {word}s"


def _describe(kind: str, row: dict) -> tuple[str, str | None, str | None, str | None]:
    """(title, from date, to date or None, one line of detail) for a row of `kind`."""
    if kind == "leave":
        start, end = row.get("startDate"), row.get("endDate")
        if row.get("isHalfDay"):
            slot = row.get("halfDaySlot")
            detail = f"Half day ({slot})" if slot else "Half day"
        else:
            detail = _plural(row.get("totalDays") or 1, "day")
        title = row.get("reasonCategoryLabel") or row.get("type") or "Leave"
        return title, start, end if end and end != start else None, detail
    if kind == "casual_leave":
        return "Casual leave", row.get("date"), None, row.get("portionLabel") or row.get("portion")
    if kind == "permission":
        bits = [
            b for b in (row.get("permissionTime"), row.get("durationMinutes") and f"{row['durationMinutes']} min") if b
        ]
        return row.get("typeLabel") or "Permission", row.get("date"), None, " · ".join(bits) or None
    if kind == "outpass":
        bits = [row.get("destination"), row.get("passType")]
        if row.get("expectedReturnAt"):
            bits.append(f"back by {str(row['expectedReturnAt'])[11:16]}")
        return "Outpass", _date_part(row.get("createdAt")), None, " · ".join(b for b in bits if b) or None
    if kind == "missing_punch":
        detail = " at ".join(b for b in (row.get("punchType"), row.get("punchTime")) if b) or None
        return "Missing punch", row.get("date"), None, detail
    if kind == "on_duty":
        return "On-Duty", _date_part(row.get("startedAt") or row.get("createdAt")), None, row.get("destination")
    if kind == "attendance_correction":
        note = (row.get("requestedValues") or {}).get("note")
        return row.get("typeLabel") or "Attendance change", row.get("date"), None, note
    if kind == "holiday_work":
        day = row.get("holidayName") or ("Sunday" if row.get("dayKind") == "sunday" else "Holiday")
        return f"Holiday work · {day}", row.get("workDate"), None, _plural(row.get("shifts") or 0, "shift")
    if kind == "resignation":
        last = row.get("lastWorkingDate")
        return "Resignation", _date_part(row.get("createdAt")), None, f"Last working day {last}" if last else None
    return KINDS[kind].label, None, None, None


_CANCELLED = ("cancelled", "canceled", "withdrawn")
_ROLE_NAMES = {"hod": "the Department Head", "hr": "HR"}


def _state(row: dict) -> str:
    status = str(row.get("status") or "").lower()
    if status == "rejected":
        return "rejected"
    if status in _CANCELLED:
        return "cancelled"
    approval = row.get("approval") or {}
    if approval.get("waitingFor") or status.startswith("pending") or status == "dept_approved":
        return "pending"
    if any(s.get("state") == "rejected" for s in approval.get("steps") or []):
        return "rejected"
    return "approved"


def item(kind: str, row: dict, hod: DepartmentManager) -> dict:
    """One request of any kind, as the MD's HOD approvals page lists it."""
    spec = KINDS[kind]
    emp = row.get("employee") if isinstance(row.get("employee"), dict) else {}
    approval = row.get("approval") or {}
    steps = [
        {
            "label": s.get("label"),
            "roles": s.get("roles") or [],
            "state": s.get("state"),
            "by": s.get("by"),
            "at": s.get("at"),
            "comment": s.get("comment"),
        }
        for s in approval.get("steps") or []
    ]
    decided = [s for s in steps if s.get("by")]
    title, start, end, detail = _describe(kind, row)
    state = _state(row)
    allowed = bool(getattr(hod, spec.right))
    can_approve = bool((approval.get("canAct") or {}).get("hod")) and state == "pending"
    can_reject = bool((approval.get("canReject") or {}).get("hod")) and state == "pending"
    waiting = [r for r in approval.get("waitingFor") or []]
    if state == "pending":
        if can_approve or can_reject:
            label = "Waiting for the Department Head"
        elif waiting:
            label = "Waiting for " + " or ".join(_ROLE_NAMES.get(r, r) for r in waiting)
        else:
            label = "Pending"
    else:
        label = {"approved": "Approved", "rejected": "Rejected", "cancelled": "Cancelled"}[state]
    blocked = None
    if (can_approve or can_reject) and not allowed:
        blocked = (
            f"{hod_name(hod)}'s '{spec.right_label}' right is switched off in User Management, so this step cannot be "
            "decided for them. HR can switch it on, or decide it themselves."
        )
    return {
        "key": f"{kind}-{row.get('id')}",
        "kind": kind,
        "kindLabel": spec.label,
        "group": spec.group,
        "id": row.get("id"),
        "employee": {
            "id": row.get("employeeId") or emp.get("id"),
            "code": row.get("employeeCode") or emp.get("employeeCode"),
            "name": row.get("employeeName") or emp.get("name"),
            "department": row.get("department") or row.get("departmentName") or emp.get("department"),
            "designation": row.get("designation") or emp.get("designation"),
        },
        "title": title,
        "from": start,
        "to": end,
        "detail": detail,
        "reason": row.get("reason"),
        "status": row.get("status"),
        "state": state,
        "statusLabel": label,
        "submittedAt": row.get("createdAt"),
        "decidedBy": decided[-1]["by"] if decided else None,
        "decidedAt": decided[-1]["at"] if decided else None,
        "steps": steps,
        "waitingFor": waiting,
        "canApprove": can_approve and allowed,
        "canReject": can_reject and allowed,
        "blockedReason": blocked,
    }


def requests_payload(m: DepartmentManager, status: str) -> dict:
    from ..manager_views import hod_requests

    raw = hod_requests(m, status)
    items = [item(k.key, row, m) for k in KINDS.values() for row in raw.get(k.rows) or []]
    items.sort(key=lambda i: str(i.get("submittedAt") or ""), reverse=True)
    counts = {g: sum(1 for i in items if i["group"] == g) for g in GROUPS}
    counts["total"] = len(items)
    return {
        "hod": hod_json(m),
        "status": status,
        "items": items,
        "counts": counts,
    }


# ─── deciding at the Department Head's step ─────────────────────────────────────────────────────────────────────


def md_actor(md_user, m: DepartmentManager) -> str:
    """The name the decision is recorded under: the MD's, saying for which Department Head."""
    md_name = (getattr(md_user, "full_name", None) or getattr(md_user, "username", None) or "Managing Director").strip()
    return f"{md_name} (MD, for {hod_name(m)})"


def deciders() -> dict[str, Callable]:
    """kind -> fn(m, pk, decision, comment, actor, request) -> DRF Response, each the Department Head's own code."""
    from .. import manager_views as mv
    from ..recruitment_views import hod_decide_resignation

    def plain(fn):
        return lambda m, pk, decision, comment, actor, request: fn(
            m, pk, {"status": decision, "comment": comment}, actor, request
        )

    return {
        "leave": plain(mv.hod_decide_leave),
        "casual_leave": plain(mv.hod_decide_casual_leave),
        "permission": plain(mv.hod_decide_permission),
        "outpass": plain(mv.hod_decide_outpass),
        "missing_punch": plain(mv.hod_decide_missing_punch),
        "on_duty": plain(mv.hod_decide_on_duty),
        "attendance_correction": plain(mv.hod_decide_attendance),
        "holiday_work": plain(mv.hod_decide_holiday_work),
        "resignation": lambda m, pk, decision, comment, actor, request: hod_decide_resignation(
            m, pk, {"action": "approve" if decision == "approved" else "reject", "comment": comment}, actor
        ),
    }

"""
HR account categories and approval rights: who may APPROVE what, kept apart from who may see and edit it.

Categories (HRUser.category)
----------------------------
    admin         every account made before 2026-11-10, the Super Admin and the Managing Director included. Nothing changes
                  for these: they keep their role and the rule every role had (approve = edit on the module).
    hr_manager    a supervising HR login: works inside the pages and approvals its role (plus per-account changes) gives it,
                  approves what HR Assistants may not, and reviews their activity (hr_activity_views.py).
    hr_assistant  a restricted HR login. It can NEVER approve the kinds in ASSISTANT_LOCKED (missing-punch requests and
                  attendance edits), whatever its role or per-account changes say, and the API refuses to grant them.

Only a super administrator sets a category (hr_user_views.py). It is always read from the database, never from a token.

Rights, in order
----------------
1. The role: Role.permissions (hidden / view / edit per module) and Role.approvals ({kind: bool}). A role with NO approvals
   map (approvals is NULL, as every role made before 2026-11-10) keeps the old rule: an account may approve a kind of
   request exactly when it may EDIT the module that owns it (APPROVAL_KINDS[...].module).
2. Per-account changes (HRUser.permission_overrides, HR Manager / HR Assistant accounts only): a module set to another
   level, an approval switched on or off for that one person.
3. Category locks: an HR Assistant never approves ASSISTANT_LOCKED kinds.
4. Nobody approves a kind whose module they cannot open at all (hidden), and the Super Admin approves everything.

Enforcement lives in three places, all reading this module: the permission middleware (module access; it also lets an
account whose approvals are explicit DECIDE a request on a module it may only view), approval_workflow.decide (every
decision made by HR through the pipeline engine) and the HR decision endpoints themselves (approval_refusal), which also
cover the decisions that never reach decide (revisions, advances, On-Duty punches, general requests ...). The `approval`
block of every request (approval_workflow.progress) tells the screens, so they hide Approve / Reject.
"""

from __future__ import annotations

from contextvars import ContextVar
from dataclasses import dataclass

from .permission_registry import MODULE_TREE, effective_permissions, resolve_permission

ADMIN = "admin"
HR_MANAGER = "hr_manager"
HR_ASSISTANT = "hr_assistant"
CATEGORIES = (ADMIN, HR_MANAGER, HR_ASSISTANT)
#: The categories that are managed on their own Account Management tabs and may carry per-account changes.
STAFF_CATEGORIES = (HR_MANAGER, HR_ASSISTANT)
CATEGORY_LABEL = {
    ADMIN: "Admin",
    HR_MANAGER: "HR Manager",
    HR_ASSISTANT: "HR Assistant",
    "super_admin": "Super Admin",
    "md": "Managing Director",
}

LEVELS = ("hidden", "view", "edit")


@dataclass(frozen=True)
class ApprovalKind:
    key: str  # the approval workflow key (approval_workflow.DEFINITIONS)
    label: str
    module: str  # the permission module that owns the requests (the old rule: edit on it = may approve them)
    description: str


# Every kind of request HR decides. Holiday / Sunday work is not here: only a Department Head decides it.
APPROVAL_KINDS: tuple[ApprovalKind, ...] = (
    ApprovalKind("leave", "Leave", "leave", "Approve or reject employees' leave requests."),
    ApprovalKind(
        "permission", "Permission", "requests", "Approve or reject Late-In / Early-Out / One-Hour permissions."
    ),
    ApprovalKind("casual_leave", "Casual Leave", "casual_leave", "Approve or reject Casual Leave requests."),
    ApprovalKind("missing_punch", "Missing Punch", "missing_punch", "Approve or reject missed-punch requests."),
    ApprovalKind(
        "attendance_correction",
        "Attendance edits",
        "attendance",
        "Give HR's approval to an attendance change (after the Department Head's).",
    ),
    ApprovalKind(
        "on_duty", "On-Duty requests", "geo_attendance", "Approve or reject On-Duty (Geo Attendance) requests."
    ),
    ApprovalKind("on_duty_punch", "On-Duty punches", "geo_attendance", "Accept or reject the punches made On-Duty."),
    ApprovalKind("outpass", "Gate Outpass", "requests", "Approve or reject outpass requests."),
    ApprovalKind("request", "Other requests", "requests", "Approve or reject employees' general requests."),
    ApprovalKind("resignation", "Resignation", "recruitment.resignations", "Approve or reject resignations."),
    ApprovalKind("advance", "Advance", "settlement", "Approve or reject salary advances."),
)
KIND_BY_KEY = {k.key: k for k in APPROVAL_KINDS}
APPROVAL_KEYS = tuple(k.key for k in APPROVAL_KINDS)

# What an HR Assistant may never approve (the owner, 2026-11-10), and the reason the screens show.
ASSISTANT_LOCKED: dict[str, str] = {
    "missing_punch": "HR Assistants can't approve missing-punch requests. An HR Manager or the Super Admin decides them.",
    "attendance_correction": (
        "HR Assistants can't approve attendance edits. An HR Manager or the Super Admin gives HR's approval."
    ),
}

_CHILDREN = {node["key"]: [c["key"] for c in node.get("children", [])] for node in MODULE_TREE}
_ALL_MODULE_KEYS = frozenset([node["key"] for node in MODULE_TREE] + [c for kids in _CHILDREN.values() for c in kids])


# ───────────────────────────── categories ─────────────────────────────


def category_of(hr_user) -> str:
    """The stored category. Anything unknown (a hand-edited row) is read as the most restricted one."""
    value = getattr(hr_user, "category", None) or ADMIN
    return value if value in CATEGORIES else HR_ASSISTANT


def display_category(hr_user) -> str:
    """What the screens call the account: "super_admin", "md", or its category."""
    if getattr(hr_user, "is_super_admin", False):
        return "super_admin"
    if getattr(hr_user, "is_md", False):
        return "md"
    return category_of(hr_user)


def role_fits(role, category: str) -> bool:
    """A role made for one category can only be given to accounts of that category ("" = any account)."""
    wanted = (getattr(role, "category", "") or "") if role is not None else ""
    return wanted == "" or wanted == category


# ───────────────────────────── overrides ─────────────────────────────


def overrides_of(hr_user) -> dict:
    """{"modules": {...}, "approvals": {...}} for an HR Manager / Assistant (empty for every other account)."""
    if hr_user is None or category_of(hr_user) not in STAFF_CATEGORIES or getattr(hr_user, "is_md", False):
        return {"modules": {}, "approvals": {}}
    raw = getattr(hr_user, "permission_overrides", None) or {}
    modules = raw.get("modules") if isinstance(raw, dict) else None
    approvals = raw.get("approvals") if isinstance(raw, dict) else None
    return {
        "modules": {k: v for k, v in (modules or {}).items() if k in _ALL_MODULE_KEYS and v in LEVELS},
        "approvals": {k: bool(v) for k, v in (approvals or {}).items() if k in KIND_BY_KEY},
    }


def validate_approvals(raw, *, category: str = "", field: str = "approvals") -> tuple[dict | None, str | None]:
    """A role's (or an account's) approvals map, cleaned: {kind: bool}. None stays None (a role on the old rule)."""
    if raw is None:
        return None, None
    if not isinstance(raw, dict):
        return None, f"{field} must be an object of request type -> true/false."
    out: dict[str, bool] = {}
    for key, value in raw.items():
        if key not in KIND_BY_KEY:
            return None, f"Unknown request type in {field}: {key}"
        if not isinstance(value, bool):
            return None, f"{field}.{key} must be true or false."
        if value and category == HR_ASSISTANT and key in ASSISTANT_LOCKED:
            return None, ASSISTANT_LOCKED[key]
        out[key] = value
    return out, None


def validate_overrides(raw, category: str) -> tuple[dict | None, str | None]:
    """Per-account changes, cleaned, or what is wrong with them. Only HR Manager / HR Assistant accounts may have any."""
    if raw in (None, {}):
        return {}, None
    if not isinstance(raw, dict) or set(raw) - {"modules", "approvals"}:
        return None, 'permissionOverrides must look like {"modules": {...}, "approvals": {...}}.'
    if category not in STAFF_CATEGORIES:
        return None, "Only HR Manager and HR Assistant accounts can have changes of their own. Change the role instead."
    modules = raw.get("modules") or {}
    if not isinstance(modules, dict):
        return None, "permissionOverrides.modules must be an object of module -> hidden/view/edit."
    for key, level in modules.items():
        if key not in _ALL_MODULE_KEYS:
            return None, f"Unknown module: {key}"
        if level not in LEVELS:
            return None, f"{key} must be hidden, view or edit."
    approvals, error = validate_approvals(
        raw.get("approvals") or {}, category=category, field="permissionOverrides.approvals"
    )
    if error:
        return None, error
    out: dict = {}
    if modules:
        out["modules"] = dict(modules)
    if approvals:
        out["approvals"] = approvals
    return out, None


# ───────────────────────────── what an account may approve ─────────────────────────────


def uses_explicit_approvals(hr_user) -> bool:
    """True when the account's approvals are decided by switches (a role with an approvals map, or an HR Manager /
    HR Assistant account) rather than by the old "edit = approve" rule. Never for the Super Admin or the MD: nothing
    changes for them."""
    if hr_user is None or getattr(hr_user, "is_super_admin", False) or getattr(hr_user, "is_md", False):
        return False
    if category_of(hr_user) in STAFF_CATEGORIES:
        return True
    role = getattr(hr_user, "role", None)
    return isinstance(getattr(role, "approvals", None), dict)


def effective_approvals(hr_user, permissions: dict | None = None) -> dict[str, bool]:
    """{kind: may approve / reject} for this account, after role, per-account changes and category locks."""
    if hr_user is None or not getattr(hr_user, "is_active", True):
        return {k: False for k in APPROVAL_KEYS}
    if getattr(hr_user, "is_super_admin", False):
        return {k: True for k in APPROVAL_KEYS}
    cached = getattr(hr_user, "_hr_access_approvals", None)
    if cached is not None and permissions is None:
        return cached
    perms = permissions if permissions is not None else effective_permissions(hr_user)
    category = category_of(hr_user)
    role = getattr(hr_user, "role", None)
    role_map = role.approvals if role is not None and isinstance(getattr(role, "approvals", None), dict) else None
    if getattr(hr_user, "is_md", False):
        role_map = None  # the Managing Director always keeps the old rule (permission_registry.MD_VIEW_ONLY decides)
    changes = overrides_of(hr_user)["approvals"]
    out: dict[str, bool] = {}
    for kind in APPROVAL_KINDS:
        level = resolve_permission(perms, kind.module)
        allowed = (level == "edit") if role_map is None else bool(role_map.get(kind.key, False))
        if kind.key in changes:
            allowed = changes[kind.key]
        if level not in ("view", "edit"):
            allowed = False  # nobody decides requests they cannot even open
        if category == HR_ASSISTANT and kind.key in ASSISTANT_LOCKED:
            allowed = False
        out[kind.key] = allowed
    if permissions is None:
        try:
            hr_user._hr_access_approvals = out
        except AttributeError:
            pass
    return out


def may_approve(hr_user, kind: str) -> bool:
    if kind not in KIND_BY_KEY:
        return bool(hr_user is not None and getattr(hr_user, "is_super_admin", False))
    return effective_approvals(hr_user).get(kind, False)


def refusal_text(hr_user, kind: str) -> str:
    if category_of(hr_user) == HR_ASSISTANT and kind in ASSISTANT_LOCKED:
        return ASSISTANT_LOCKED[kind]
    label = KIND_BY_KEY[kind].label if kind in KIND_BY_KEY else kind
    return (
        f"Your account can't approve or reject {label} requests. An HR Manager or the Super Admin has to decide them."
    )


def access_json(hr_user) -> dict:
    """What /auth/me tells the portal about the account's category and approvals (the API checks them again)."""
    permissions = effective_permissions(hr_user) if hr_user is not None else {}
    category = display_category(hr_user) if hr_user is not None else ADMIN
    return {
        "category": category_of(hr_user) if hr_user is not None else ADMIN,
        "categoryLabel": CATEGORY_LABEL.get(category, category),
        "displayCategory": category,
        # "explicit": the approvals below decide (Approve buttons follow them); "legacy": approve = edit, as always
        "approvalMode": "explicit" if uses_explicit_approvals(hr_user) else "legacy",
        "approvals": effective_approvals(hr_user, permissions) if hr_user is not None else {},
        "lockedApprovals": sorted(ASSISTANT_LOCKED) if category_of(hr_user) == HR_ASSISTANT else [],
    }


# ───────────────────────────── decision endpoints ─────────────────────────────

# The HR endpoints that decide a request, by path (relative to /api/) and method. An account whose approvals are explicit
# may call these on a module it may only VIEW when it may approve that kind (HrPermissionMiddleware); the view itself
# then refuses anything that is not a decision (decision_only_refusal). Each of these views also calls approval_refusal.
DECISION_ROUTES: tuple[tuple[str, str, str], ...] = (
    (r"leave-requests/\d+/status", "PATCH", "leave"),
    (r"permissions/\d+", "PUT", "permission"),
    (r"casual-leaves/\d+", "PATCH", "casual_leave"),
    (r"missing-punch-requests/\d+/status", "PATCH", "missing_punch"),
    (r"attendance/override-requests/\d+", "PATCH", "attendance_correction"),
    (r"on-duty-sessions/\d+/status", "PATCH", "on_duty"),
    (r"on-duty-sessions/\d+/punches", "PATCH", "on_duty_punch"),
    (r"on-duty-punch-verifications/\d+/status", "PATCH", "on_duty_punch"),
    (r"outpass-requests/\d+/hr-status", "PUT", "outpass"),
    (r"employee-requests/\d+/action", "PUT", "request"),
    (r"recruitment/resignations/\d+/action", "PATCH", "resignation"),
    (r"advances/\d+", "PUT", "advance"),
)


def decision_kind(rel_path: str, method: str) -> str | None:
    """The kind of request this call decides, when it is one of DECISION_ROUTES."""
    import re

    for pattern, verb, kind in DECISION_ROUTES:
        if method == verb and re.fullmatch(pattern, rel_path.rstrip("/")):
            return kind
    return None


# ───────────────────────────── the account behind this request ─────────────────────────────

# Set by HrPermissionMiddleware for the length of one HR request, so the approval engine (which is not given the request)
# can tell who is deciding and the `approval` block of every listed request can say whether THIS account may act.
_ACTOR: ContextVar = ContextVar("hr_actor", default=None)


def set_actor(hr_user):
    return _ACTOR.set(hr_user)


def reset_actor(token) -> None:
    _ACTOR.reset(token)


def current_actor():
    return _ACTOR.get()


def actor_may_approve(kind: str) -> bool:
    """For the screens: may the account behind this request approve `kind`? True when there is no HR account (a background
    job, an employee or HOD token) or the account is on the old rule, so nothing changes for those."""
    actor = current_actor()
    if actor is None or not uses_explicit_approvals(actor):
        return True
    return may_approve(actor, kind)


def actor_refusal(kind: str) -> str | None:
    """For approval_workflow.decide: the refusal message when the HR account behind this request may not decide `kind`."""
    actor = current_actor()
    if actor is None or may_approve(actor, kind):
        return None
    return refusal_text(actor, kind)


def request_actor(request):
    """The active HR account making `request` (the middleware's copy, else fresh from the database), or None."""
    actor = getattr(request, "hr_actor", None)
    if actor is not None:
        return actor
    from .models import HRUser

    hr_user_id = (getattr(request, "jwt_user", None) or {}).get("hrUserId")
    if not hr_user_id:
        return None
    return HRUser.objects.select_related("role").filter(id=hr_user_id, is_active=True).first()


def approval_refusal(request, kind: str):
    """403 `approval_not_permitted` when the HR account making this request may not approve / reject `kind`, else None.
    Every HR decision endpoint calls it before deciding anything."""
    from rest_framework.response import Response

    actor = request_actor(request)
    if actor is not None and may_approve(actor, kind):
        return None
    message = refusal_text(actor, kind) if actor is not None else "This account is disabled."
    return Response({"error": message, "code": "approval_not_permitted", "kind": kind}, status=403)


def decision_only_refusal(request):
    """403 when the middleware let this request through only to DECIDE (the account may approve these requests but may
    only view the module), and the request tries to change something else."""
    from rest_framework.response import Response

    if not getattr(request, "hr_decision_only", False):
        return None
    return Response(
        {
            "error": "Your account can approve or reject these requests, but not change them.",
            "code": "permission_denied",
        },
        status=403,
    )


def out_of_branch(request, branch_id) -> bool:
    """A branch-scoped HR account deciding a request of another branch (the lists never show those)."""
    from .branch_scope import get_branch_scope

    scope = get_branch_scope(request)
    return scope is not None and branch_id != scope


def audit_module(kind: str) -> str:
    """The Activity Logs module a decision of this kind is filed under (the top of its permission module)."""
    return KIND_BY_KEY[kind].module.split(".")[0] if kind in KIND_BY_KEY else kind


def log_decision(request, kind: str, obj, decision: str, what: str = "") -> None:
    """One Activity Logs row for an HR approval / rejection (never raises)."""
    from .audit_utils import log_action

    label = KIND_BY_KEY[kind].label if kind in KIND_BY_KEY else kind
    word = "Approved" if decision == "approved" else "Rejected" if decision == "rejected" else f"Set to {decision}:"
    emp = getattr(obj, "employee", None)
    who = f"{emp.first_name} {emp.last_name}".strip() if emp is not None else ""
    code = f" ({emp.employee_code})" if emp is not None and getattr(emp, "employee_code", None) else ""
    detail = what or (f"{label} request of {who}{code}" if who else f"{label} request #{getattr(obj, 'pk', '')}")
    log_action(
        request,
        "approve" if decision == "approved" else "reject" if decision == "rejected" else "update",
        audit_module(kind),
        record_id=getattr(obj, "pk", None),
        description=f"{word} {detail}",
        new_values={"requestType": kind, "decision": decision, "status": getattr(obj, "status", None)},
    )

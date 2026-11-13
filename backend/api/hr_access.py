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

from .permission_registry import all_module_keys, effective_permissions, resolve_permission

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
    key: str  # the approval kind (the approval workflow key where it has one: approval_workflow.DEFINITIONS)
    label: str
    module: str  # the permission module that owns the requests (the old rule: edit on it = may approve them)
    description: str
    group: str = ""  # the heading it is listed under in Account Management (APPROVAL_GROUPS)
    # An older, wider kind this one was split out of (2026-11-11: "request" -> one kind per request type, "advance" -> general
    # / term). A role or account that set the old switch and not this one keeps what the old switch said.
    replaces: str | None = None
    # A decision that always needed Edit on its module (Payroll Done, Bonus approval ...): the switch is an extra right on
    # top of Edit, never instead of it, and a role with approvals of its own that never set it keeps "edit = approve".
    needs_edit: bool = False
    note: str = ""  # an extra condition, in plain words (a login for the whole company ...)

    def to_json(self) -> dict:
        out = {
            "key": self.key,
            "label": self.label,
            "module": self.module,
            "description": self.description,
            "group": self.group,
        }
        if self.replaces:
            out["replaces"] = self.replaces
        if self.needs_edit:
            out["needsEdit"] = True
        if self.note:
            out["note"] = self.note
        return out


# The headings of the Approvals list: the page each kind of decision is made on.
APPROVAL_GROUPS: tuple[dict, ...] = (
    {"id": "leave", "label": "Leave & Holiday"},
    {"id": "casual_leave", "label": "Casual Leave"},
    {"id": "attendance", "label": "Attendance"},
    {"id": "geo", "label": "Geo Attendance"},
    {"id": "outpass", "label": "Outpass"},
    {"id": "other_requests", "label": "Requests page - Other requests (the employee request form)"},
    {"id": "recruitment", "label": "Recruitment"},
    {"id": "settlement", "label": "Settlement"},
    {"id": "payroll", "label": "Staff Payroll"},
    {"id": "compensation", "label": "Compensation"},
    {"id": "bonus", "label": "Bonus"},
)

_WHOLE_COMPANY = "Only for a login that covers every branch, as before."

# Every kind of decision HR makes, each with its own switch. Holiday / Sunday work is in INFO_KINDS: only a Department Head
# decides it.
APPROVAL_KINDS: tuple[ApprovalKind, ...] = (
    ApprovalKind("leave", "Leave requests", "leave", "Approve or reject leave and half-day leave requests.", "leave"),
    ApprovalKind(
        "permission",
        "Permission requests",
        "requests",
        "Approve or reject Late-In / Early-Out / One-Hour permissions.",
        "leave",
    ),
    ApprovalKind(
        "casual_leave", "Casual Leave requests", "casual_leave", "Approve or reject CL requests.", "casual_leave"
    ),
    ApprovalKind(
        "missing_punch",
        "Missing punch requests",
        "missing_punch",
        "Approve or reject missed-punch requests.",
        "attendance",
    ),
    ApprovalKind(
        "attendance_correction",
        "Attendance edit requests",
        "attendance",
        "Give HR's approval to a change of a day's attendance (after the Department Head's).",
        "attendance",
    ),
    ApprovalKind("on_duty", "On-Duty requests", "geo_attendance", "Approve or reject On-Duty requests.", "geo"),
    ApprovalKind(
        "on_duty_punch",
        "On-Duty punch verifications",
        "geo_attendance",
        "Accept or reject the punches made On-Duty.",
        "geo",
    ),
    ApprovalKind("outpass", "Outpass requests", "requests", "Approve or reject gate outpass requests.", "outpass"),
    ApprovalKind(
        "request_leave",
        "Leave Request",
        "requests",
        "A leave asked for with the request form (not the Leave & Holiday leave requests).",
        "other_requests",
        replaces="request",
    ),
    ApprovalKind(
        "request_salary_enquiry",
        "Salary Enquiry",
        "requests",
        "A question about salary sent with the request form.",
        "other_requests",
        replaces="request",
    ),
    ApprovalKind(
        "request_shift_correction",
        "Shift Correction",
        "requests",
        "A request to correct a shift, sent with the request form.",
        "other_requests",
        replaces="request",
    ),
    ApprovalKind(
        "request_advance",
        "Advance Request",
        "requests",
        "An advance asked for with the request form (the advance itself is decided under Settlement).",
        "other_requests",
        replaces="request",
    ),
    ApprovalKind(
        "request_permission",
        "Permission Request",
        "requests",
        "A permission asked for with the request form (not the Late-In / Early-Out permissions).",
        "other_requests",
        replaces="request",
    ),
    ApprovalKind(
        "request_general",
        "General Query",
        "requests",
        "Any other question or request sent with the request form.",
        "other_requests",
        replaces="request",
    ),
    ApprovalKind(
        "resignation", "Resignations", "recruitment.resignations", "Approve or reject resignations.", "recruitment"
    ),
    ApprovalKind(
        "interview_result",
        "Interview results",
        "recruitment",
        "Mark an applicant selected or rejected on the Interviews page.",
        "recruitment",
        needs_edit=True,
    ),
    ApprovalKind(
        "resume_decision",
        "Resume screening decisions",
        "recruitment.resume_screening",
        "Mark a screened candidate selected or rejected.",
        "recruitment",
        needs_edit=True,
    ),
    ApprovalKind(
        "advance_general",
        "General advances",
        "settlement",
        "Approve or reject a one-time salary advance.",
        "settlement",
        replaces="advance",
    ),
    ApprovalKind(
        "advance_term",
        "Term advances (loans)",
        "settlement",
        "Approve or reject a loan repaid in monthly instalments.",
        "settlement",
        replaces="advance",
    ),
    ApprovalKind(
        "payroll_hold",
        "Hold / unhold a salary",
        "payroll",
        "Hold an employee's salary for the month, or release the hold, before Payroll Done.",
        "payroll",
        needs_edit=True,
    ),
    ApprovalKind(
        "payroll_add",
        "Add a new joiner to the payroll",
        "payroll",
        "Put a new joiner into this month's payroll.",
        "payroll",
        needs_edit=True,
    ),
    ApprovalKind(
        "payroll_finalize",
        "Payroll Done (lock the month)",
        "payroll",
        "Finalize and lock the month's staff payroll.",
        "payroll",
        needs_edit=True,
        note=_WHOLE_COMPANY,
    ),
    ApprovalKind(
        "payroll_mark_paid",
        "Mark the month as Paid",
        "payroll",
        "Record that the finalized month has been paid and tell the employees.",
        "payroll",
        needs_edit=True,
        note=_WHOLE_COMPANY,
    ),
    ApprovalKind(
        "payroll_release",
        "Release & pay",
        "payroll",
        "Pay a held salary or a new joiner after Payroll Done.",
        "payroll",
        needs_edit=True,
        note=_WHOLE_COMPANY,
    ),
    ApprovalKind(
        "payroll_mark_cleared",
        "Mark a salary as cleared",
        "payroll",
        "Mark one employee's payroll as paid (Mark as Cleared, staff and production).",
        "payroll",
        needs_edit=True,
    ),
    ApprovalKind(
        "compensation_ot",
        "OT shift compensation",
        "compensation.ot",
        "Assign or reject compensation for extra shifts worked, and announce earlier records.",
        "compensation",
        needs_edit=True,
    ),
    ApprovalKind(
        "bonus_status",
        "Bonus approval and payment",
        "bonus",
        "Set a bonus row to Approved or Paid.",
        "bonus",
        needs_edit=True,
    ),
)
KIND_BY_KEY = {k.key: k for k in APPROVAL_KINDS}
APPROVAL_KEYS = tuple(k.key for k in APPROVAL_KINDS)

# Decisions HR does not make, listed so the owner sees them too (no switch).
INFO_KINDS: tuple[dict, ...] = (
    {
        "key": "holiday_work",
        "label": "Holiday / Sunday work claims",
        "group": "compensation",
        "text": "Decided by the Department Head only: HR has no approval step for them.",
    },
)

# The older kinds that were split (2026-11-11) and the kinds that took their place. They are still accepted from an older
# client and still read from a role or an account that set them (a new kind follows its old switch until it has its own);
# asking "may this account approve <old kind>" means "any of them" (the screens and the middleware ask it before they know
# which type a request is; the view then checks the exact kind: kind_for).
ALIASES: dict[str, tuple[str, ...]] = {
    old: tuple(k.key for k in APPROVAL_KINDS if k.replaces == old) for old in ("request", "advance")
}
ALIAS_LABEL = {"request": "Other requests", "advance": "Advance"}
ALIAS_MODULE = {"request": "requests", "advance": "settlement"}
REQUEST_TYPE_KINDS = {k.key[len("request_") :]: k.key for k in APPROVAL_KINDS if k.replaces == "request"}


def kind_for(workflow_key: str, obj=None) -> str:
    """The approval kind of one request: an employee request by its type, an advance by general / term, else the
    workflow key itself."""
    if workflow_key == "request" and obj is not None:
        return REQUEST_TYPE_KINDS.get(getattr(obj, "request_type", None) or "", "request_general")
    if workflow_key == "advance" and obj is not None:
        return "advance_term" if getattr(obj, "advance_type", None) == "term" else "advance_general"
    return workflow_key


# What an HR Assistant may never approve (the owner, 2026-11-10), and the reason the screens show.
ASSISTANT_LOCKED: dict[str, str] = {
    "missing_punch": "HR Assistants can't approve missing-punch requests. An HR Manager or the Super Admin decides them.",
    "attendance_correction": (
        "HR Assistants can't approve attendance edits. An HR Manager or the Super Admin gives HR's approval."
    ),
}

_ALL_MODULE_KEYS = frozenset(all_module_keys())
# what an older client may still send / a role may still hold: the kinds that were split
_KNOWN_APPROVAL_KEYS = frozenset(KIND_BY_KEY) | frozenset(ALIASES)


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
        "approvals": {k: bool(v) for k, v in (approvals or {}).items() if k in _KNOWN_APPROVAL_KEYS},
    }


def validate_approvals(raw, *, category: str = "", field: str = "approvals") -> tuple[dict | None, str | None]:
    """A role's (or an account's) approvals map, cleaned: {kind: bool}. None stays None (a role on the old rule)."""
    if raw is None:
        return None, None
    if not isinstance(raw, dict):
        return None, f"{field} must be an object of request type -> true/false."
    out: dict[str, bool] = {}
    for key, value in raw.items():
        if key not in _KNOWN_APPROVAL_KEYS:
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
        allowed = (level == "edit") if role_map is None else _switch(role_map, kind, level)
        own = _own_switch(changes, kind)
        if own is not None:
            allowed = own
        if level not in ("view", "edit"):
            allowed = False  # nobody decides requests they cannot even open
        if kind.needs_edit and level != "edit":
            allowed = False  # an extra right on top of Edit, never instead of it
        if category == HR_ASSISTANT and kind.key in ASSISTANT_LOCKED:
            allowed = False
        out[kind.key] = allowed
    if permissions is None:
        try:
            hr_user._hr_access_approvals = out
        except AttributeError:
            pass
    return out


def _own_switch(switches: dict, kind: ApprovalKind) -> bool | None:
    """A switch set for this kind, or for the older kind it was split out of; None when neither is set."""
    if kind.key in switches:
        return bool(switches[kind.key])
    if kind.replaces and kind.replaces in switches:
        return bool(switches[kind.replaces])
    return None


def _switch(role_map: dict, kind: ApprovalKind, level: str) -> bool:
    """What a role with approvals of its own says about `kind`. Unset: off, as it always was, except for a decision that
    only ever needed Edit (needs_edit): that one keeps "edit = approve" until the role sets it."""
    own = _own_switch(role_map, kind)
    if own is not None:
        return own
    return level == "edit" if kind.needs_edit else False


def may_approve(hr_user, kind: str) -> bool:
    if kind in ALIASES:  # "any request type" / "any advance": the view checks the exact one (kind_for)
        approvals = effective_approvals(hr_user)
        return any(approvals.get(k, False) for k in ALIASES[kind])
    if kind not in KIND_BY_KEY:
        return bool(hr_user is not None and getattr(hr_user, "is_super_admin", False))
    return effective_approvals(hr_user).get(kind, False)


# How the Activity Logs rows have always named a decision ("Approved Leave request of ..."); kinds added later use their
# label.
_LOG_NOUN = {
    "leave": "Leave",
    "permission": "Permission",
    "casual_leave": "Casual Leave",
    "missing_punch": "Missing Punch",
    "attendance_correction": "Attendance edits",
    "on_duty": "On-Duty requests",
    "on_duty_punch": "On-Duty punches",
    "outpass": "Gate Outpass",
    "resignation": "Resignation",
    **{k: "Other requests" for k in ALIASES["request"]},
    **{k: "Advance" for k in ALIASES["advance"]},
    "request": "Other requests",
    "advance": "Advance",
}


def kind_label(kind: str) -> str:
    if kind in KIND_BY_KEY:
        return KIND_BY_KEY[kind].label
    return ALIAS_LABEL.get(kind, kind)


def refusal_text(hr_user, kind: str) -> str:
    if category_of(hr_user) == HR_ASSISTANT and kind in ASSISTANT_LOCKED:
        return ASSISTANT_LOCKED[kind]
    spec = KIND_BY_KEY.get(kind)
    if spec is not None and spec.needs_edit:
        return f"Your account can't do this: {spec.label}. Ask the Super Admin to allow it in Account Management."
    return (
        f"Your account can't approve or reject {kind_label(kind)}. An HR Manager or the Super Admin has to decide them."
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
    if kind in KIND_BY_KEY:
        return KIND_BY_KEY[kind].module.split(".")[0]
    return ALIAS_MODULE.get(kind, kind)


def log_decision(request, kind: str, obj, decision: str, what: str = "") -> None:
    """One Activity Logs row for an HR approval / rejection (never raises)."""
    from .audit_utils import log_action

    label = _LOG_NOUN.get(kind) or kind_label(kind)
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

import bcrypt
from datetime import timedelta

from django.db import transaction
from django.utils import timezone
from django.db.models import Count

from rest_framework.decorators import api_view
from rest_framework.request import Request
from rest_framework.response import Response

from . import hr_access
from .auth import is_master_admin, require_master_admin, require_super_admin, require_super_admin_or_md
from .branch_scope import scope_to_branch
from .models import HRUser, Role, AuditLog
from .audit_utils import log_action
from .super_admin_sync import env_controls_super_admin


def role_json(r):
    return {
        "id": r.id,
        "name": r.name,
        "description": r.description,
        "permissions": r.permissions,
        # {request type: may approve} (hr_access.APPROVAL_KINDS), or null: the role keeps the old rule (approve = edit)
        "approvals": r.approvals if isinstance(r.approvals, dict) else None,
        # "" = for any account; "hr_manager" / "hr_assistant" = only for accounts of that category
        "category": r.category or "",
        "isSystem": r.is_system,
        "createdAt": r.created_at.isoformat() if r.created_at else None,
    }


def _role_snapshot(r) -> dict:
    """What the Activity Logs keep of a role before / after a change."""
    return {
        "name": r.name,
        "category": r.category or "",
        "permissions": r.permissions,
        "approvals": r.approvals if isinstance(r.approvals, dict) else None,
    }


def _account_snapshot(u) -> dict:
    """What the Activity Logs keep of an account before / after a change (never the password)."""
    return {
        "category": hr_access.category_of(u),
        "roleId": u.role_id,
        "branchId": u.branch_id,
        "isActive": u.is_active,
        "fullName": u.full_name,
        "email": u.email,
        "isMd": u.is_md,
        "permissionOverrides": hr_access.overrides_of(u),
    }


def _changed(before: dict, after: dict) -> tuple[dict, dict]:
    keys = [k for k in after if before.get(k) != after.get(k)]
    return {k: before.get(k) for k in keys}, {k: after.get(k) for k in keys}


def _invalid(problem: str) -> Response:
    """400 for a refused change; `approval_locked` when it tried to give an HR Assistant an approval it may never have."""
    code = "approval_locked" if problem in hr_access.ASSISTANT_LOCKED.values() else "invalid"
    return Response({"error": problem, "code": code}, status=400)


def _role_problem(role_id, category: str):
    """(role, error message): the role an account is being given, and why it cannot have it."""
    if role_id in (None, ""):
        return None, None
    role = Role.objects.filter(pk=role_id).first()
    if role is None:
        return None, "That role does not exist any more."
    if not hr_access.role_fits(role, category):
        wanted = hr_access.CATEGORY_LABEL.get(role.category, role.category)
        mine = hr_access.CATEGORY_LABEL.get(category, category)
        return role, f'"{role.name}" is a role for {wanted} accounts, and this is an {mine} account. Pick another role.'
    return role, None


def hr_user_json(u):
    display = hr_access.display_category(u)
    return {
        "id": u.id,
        "username": u.username,
        "email": u.email,
        "fullName": u.full_name,
        "roleId": u.role_id,
        "roleName": u.role.name if u.role else None,
        "departmentId": u.department_id,
        "departmentName": u.department.name if u.department else None,
        "branchId": u.branch_id,
        "branchName": u.branch.name if u.branch else None,
        "isActive": u.is_active,
        "isSuperAdmin": u.is_super_admin,
        # The Super Admin's username and password come from ADMIN_USERNAME / ADMIN_PASSWORD in the backend .env (synced
        # at every start, api/super_admin_sync.py): the portal shows them as read-only for that account.
        "credentialsFromEnv": bool(u.is_super_admin and env_controls_super_admin()),
        "isHidden": u.is_hidden,
        "masterFeatures": u.master_features or {},
        # The Managing Director identity (see HRUser.is_md): at most one account has it.
        "isMd": u.is_md,
        "mdAssignedAt": u.md_assigned_at.isoformat() if u.md_assigned_at else None,
        # The account category (hr_access.py): "admin" | "hr_manager" | "hr_assistant"; displayCategory also tells the
        # Super Admin ("super_admin") and the MD ("md") apart. permissionOverrides = the account's own changes on top of
        # its role ({"modules": {...}, "approvals": {...}}, HR Manager / HR Assistant accounts only).
        "category": hr_access.category_of(u),
        "displayCategory": display,
        "categoryLabel": hr_access.CATEGORY_LABEL.get(display, display),
        "permissionOverrides": hr_access.overrides_of(u),
        "lastLogin": u.last_login.isoformat() if u.last_login else None,
        "createdAt": u.created_at.isoformat() if u.created_at else None,
    }


def _md_summary(u):
    return {"id": u.id, "username": u.username, "fullName": u.full_name}


def _apply_md(request, user, want: bool, replace: bool):
    """Give `user` the Managing Director identity, or take it away. Returns an error Response, or None when it is fine.

    Mutates `user` only (the caller saves it, inside a transaction); the one write it makes itself is clearing the
    PREVIOUS MD when `replace` is true, and only after every check has passed, so a refusal never leaves anything
    half done.

    The rules, each a 400 with a plain message:
    - a super administrator is never the MD (the MD gets the executive portal, not the control plane);
    - the MD is company-wide: an account limited to one branch cannot be the MD, and an MD cannot be given a branch;
    - a disabled account cannot be the MD (it could not sign in to use it).
    A different account already being the MD is a 409 `md_exists` naming them, unless the caller sent replaceMd=true
    (the screen asks the administrator to confirm, then retries with it)."""
    if not want:
        if user.is_md:
            user.is_md = False
            user.md_assigned_at = None
        return None
    if user.is_md:
        return None  # already the MD: nothing to do
    if user.is_super_admin:
        return Response(
            {"error": "A super administrator can't also be the MD. Use a separate account for the MD."}, status=400
        )
    if hr_access.category_of(user) in hr_access.STAFF_CATEGORIES:
        label = hr_access.CATEGORY_LABEL[hr_access.category_of(user)]
        return Response({"error": f"An {label} account can't be the MD. Use a separate account for the MD."}, status=400)
    if user.branch_id is not None:
        return Response(
            {
                "error": "The MD sees the whole company, so the account can't be limited to one branch. "
                "Set Branch to All branches first."
            },
            status=400,
        )
    if not user.is_active:
        return Response(
            {"error": "Enable the account before making it the MD: a disabled account can't sign in."}, status=400
        )
    previous = HRUser.objects.filter(is_md=True).exclude(pk=user.pk).first()
    if previous is not None:
        if not replace:
            return Response(
                {
                    "error": f"{previous.username} is already the MD. "
                    f"Making {user.username} the MD removes it from {previous.username}.",
                    "code": "md_exists",
                    "currentMd": _md_summary(previous),
                },
                status=409,
            )
        log_action(
            request, "update", "user_management", record_id=previous.id,
            description=f"Removed MD access from: {previous.username} (replaced by {user.username})",
        )
        HRUser.objects.filter(is_md=True).exclude(pk=user.pk).update(is_md=False, md_assigned_at=None)
    user.is_md = True
    user.md_assigned_at = timezone.now()
    return None


def audit_log_json(log):
    return {
        "id": log.id,
        "userType": log.user_type,
        "userId": log.user_id,
        # the HR portal account that acted (stamped from 2026-11-10 on; null on older rows and non-HR rows)
        "hrUserId": log.hr_user_id,
        "userName": log.user_name,
        "action": log.action,
        "module": log.module,
        "recordId": log.record_id,
        "recordDescription": log.record_description,
        "oldValues": log.old_values,
        "newValues": log.new_values,
        "ipAddress": log.ip_address,
        "createdAt": log.created_at.isoformat() if log.created_at else None,
    }


# ── Roles ────────────────────────────────────────────────────────────────────

#: What a role can be made for: any account (""), or only HR Manager / HR Assistant accounts.
ROLE_CATEGORIES = ("", hr_access.HR_MANAGER, hr_access.HR_ASSISTANT)


@api_view(["GET", "POST"])
@require_super_admin
def roles(request: Request) -> Response:
    if request.method == "GET":
        qs = Role.objects.order_by("name")
        return Response([role_json(r) for r in qs])

    data = request.data
    if not str(data.get("name") or "").strip():
        return Response({"error": "name is required"}, status=400)
    if Role.objects.filter(name__iexact=str(data["name"]).strip()).exists():
        return Response({"error": "Role already exists"}, status=400)
    category = data.get("category") or ""
    if category not in ROLE_CATEGORIES:
        return Response({"error": "category must be empty (any account), hr_manager or hr_assistant."}, status=400)
    approvals, error = hr_access.validate_approvals(data.get("approvals"), category=category)
    if error:
        return _invalid(error)

    role = Role.objects.create(
        name=data["name"],
        description=data.get("description"),
        permissions=data.get("permissions", {}),
        approvals=approvals,
        category=category,
    )
    log_action(
        request, "create", "user_management", record_id=role.id, description=f"Created role: {role.name}",
        new_values=_role_snapshot(role),
    )  # fmt: skip
    return Response(role_json(role), status=201)


@api_view(["GET", "PUT", "DELETE"])
@require_super_admin
def role_detail(request: Request, pk: int) -> Response:
    try:
        role = Role.objects.get(pk=pk)
    except Role.DoesNotExist:
        return Response({"error": "Role not found"}, status=404)

    if request.method == "GET":
        return Response(role_json(role))

    if request.method == "PUT":
        data = request.data
        before = _role_snapshot(role)
        if "name" in data:
            # Names are unique: renaming onto another role's name used to reach the database and come back as a 500.
            new_name = str(data["name"] or "").strip()
            if not new_name:
                return Response({"error": "name is required"}, status=400)
            if Role.objects.filter(name__iexact=new_name).exclude(pk=role.pk).exists():
                return Response({"error": "Role already exists"}, status=400)
            role.name = new_name
        if "category" in data:
            category = data["category"] or ""
            if category not in ROLE_CATEGORIES:
                return Response({"error": "category must be empty (any account), hr_manager or hr_assistant."}, status=400)
            if category:
                others = role.users.exclude(category=category)
                if others.exists():
                    n = others.count()
                    label = hr_access.CATEGORY_LABEL[category]
                    return Response(
                        {
                            "error": f"{n} {'account that uses' if n == 1 else 'accounts that use'} this role "
                            f"{'is not an' if n == 1 else 'are not'} {label} {'account' if n == 1 else 'accounts'}. "
                            "Give them another role first, or keep the role for any account."
                        },
                        status=400,
                    )
            role.category = category
        if "approvals" in data or "category" in data:
            raw = data["approvals"] if "approvals" in data else role.approvals
            approvals, error = hr_access.validate_approvals(raw, category=role.category or "")
            if error:
                return _invalid(error)
            role.approvals = approvals
        if "description" in data:
            role.description = data["description"]
        if "permissions" in data:
            role.permissions = data["permissions"]
        role.save()
        old, new = _changed(before, _role_snapshot(role))
        log_action(
            request, "update", "user_management", record_id=role.id, description=f"Updated role: {role.name}",
            old_values=old or None, new_values=new or None,
        )  # fmt: skip
        return Response(role_json(role))

    if role.is_system:
        return Response({"error": "Cannot delete system roles"}, status=400)
    log_action(request, "delete", "user_management", record_id=role.id, description=f"Deleted role: {role.name}")
    role.delete()
    return Response(status=204)


# ── HR Users ─────────────────────────────────────────────────────────────────

@api_view(["GET", "POST"])
@require_super_admin
def hr_users(request: Request) -> Response:
    if request.method == "GET":
        qs = HRUser.objects.select_related("role", "department", "branch").order_by("username")

        # Hidden accounts are withheld from the normal Account Management
        # list. includeHidden is honoured ONLY for the master admin -a plain
        # super admin passing the flag by hand still gets the filtered list,
        # otherwise hiding would be trivially bypassable from the URL bar.
        wants_hidden = request.query_params.get("includeHidden") == "1"
        requester = HRUser.objects.filter(id=request.jwt_user.get("hrUserId")).first()
        if not (wants_hidden and is_master_admin(requester)):
            qs = qs.filter(is_hidden=False)

        # HRUser carries its own branch, so scope on it directly. A branch
        # admin manages their branch's logins; accounts with no branch are
        # unscoped admins and stay visible only to other unscoped admins.
        qs = scope_to_branch(qs, request, field="branch_id")

        return Response([hr_user_json(u) for u in qs])

    data = request.data
    if not data.get("username") or not data.get("password"):
        return Response({"error": "username and password are required"}, status=400)
    if HRUser.objects.filter(username=data["username"]).exists():
        return Response({"error": "Username already exists"}, status=400)
    # The category is set here, by the Super Admin, and nowhere else (hr_access.py). Default: an Admin account as before.
    category = data.get("category") or hr_access.ADMIN
    if category not in hr_access.CATEGORIES:
        return Response({"error": "category must be admin, hr_manager or hr_assistant."}, status=400)
    _role, problem = _role_problem(data.get("roleId"), category)
    if problem:
        return Response({"error": problem}, status=400)
    overrides, problem = hr_access.validate_overrides(data.get("permissionOverrides"), category)
    if problem:
        return _invalid(problem)

    pw_hash = bcrypt.hashpw(data["password"].encode(), bcrypt.gensalt()).decode()
    with transaction.atomic():
        user = HRUser(
            username=data["username"],
            email=data.get("email"),
            full_name=data.get("fullName"),
            password_hash=pw_hash,
            role_id=data.get("roleId") or None,
            department_id=data.get("departmentId"),
            branch_id=data.get("branchId"),
            category=category,
            permission_overrides=overrides,
        )
        if data.get("isMd"):
            error = _apply_md(request, user, True, bool(data.get("replaceMd")))
            if error is not None:
                return error
        user.save()
    label = hr_access.CATEGORY_LABEL[category]
    log_action(
        request, "create", "user_management", record_id=user.id,
        description=f"Created HR user: {user.username}" + (f" ({label})" if category != hr_access.ADMIN else ""),
        new_values=_account_snapshot(user),
    )  # fmt: skip
    if user.is_md:
        log_action(request, "update", "user_management", record_id=user.id, description=f"Assigned MD: {user.username}")
    return Response(hr_user_json(user), status=201)


@api_view(["GET", "PUT", "DELETE"])
@require_super_admin
def hr_user_detail(request: Request, pk: int) -> Response:
    try:
        u = HRUser.objects.select_related("role", "department", "branch").get(pk=pk)
    except HRUser.DoesNotExist:
        return Response({"error": "User not found"}, status=404)

    if request.method == "GET":
        return Response(hr_user_json(u))

    if request.method == "PUT":
        data = request.data
        if data.get("password") and u.is_super_admin and env_controls_super_admin():
            # it would be put back to the .env value at the next start anyway (owner 2026-11-10: .env has priority)
            return Response(
                {
                    "error": "The Super Admin's username and password come from the backend .env (ADMIN_USERNAME and "
                    "ADMIN_PASSWORD). Change them there and restart the backend."
                },
                status=400,
            )
        was_md = u.is_md
        before = _account_snapshot(u)
        # The category (hr_access.py), set only here and on create, by the Super Admin. The Super Admin and the MD stay
        # Admin accounts, so nothing about them can change.
        category = hr_access.category_of(u)
        if "category" in data and (data["category"] or hr_access.ADMIN) != category:
            category = data["category"] or hr_access.ADMIN
            if category not in hr_access.CATEGORIES:
                return Response({"error": "category must be admin, hr_manager or hr_assistant."}, status=400)
            if u.is_super_admin or u.is_md:
                who = "the Super Admin" if u.is_super_admin else "the MD"
                return Response({"error": f"This is {who}'s account: it stays an Admin account."}, status=400)
        role_id = data["roleId"] if "roleId" in data else u.role_id
        _role, problem = _role_problem(role_id, category)
        if problem:
            return Response({"error": problem}, status=400)
        if "permissionOverrides" in data:
            overrides, problem = hr_access.validate_overrides(data["permissionOverrides"], category)
            if problem:
                return _invalid(problem)
        elif category != hr_access.category_of(u):
            # a new category: the account's own changes stay only where they still make sense
            kept = hr_access.overrides_of(u) if category in hr_access.STAFF_CATEGORIES else {}
            if category == hr_access.HR_ASSISTANT and kept.get("approvals"):
                kept["approvals"] = {k: v for k, v in kept["approvals"].items() if k not in hr_access.ASSISTANT_LOCKED}
            overrides, _ = hr_access.validate_overrides({k: v for k, v in kept.items() if v}, category)
        else:
            overrides = None  # unchanged
        with transaction.atomic():
            for field, attr in [
                ("email", "email"), ("fullName", "full_name"),
                ("roleId", "role_id"), ("departmentId", "department_id"),
                ("branchId", "branch_id"), ("isActive", "is_active"),
            ]:
                if field in data:
                    setattr(u, attr, data[field])
            if "roleId" in data and data["roleId"] in ("", None):
                u.role_id = None
            u.category = category
            if overrides is not None:
                u.permission_overrides = overrides
            if data.get("password"):
                u.password_hash = bcrypt.hashpw(data["password"].encode(), bcrypt.gensalt()).decode()
            if "isMd" in data:
                error = _apply_md(request, u, bool(data["isMd"]), bool(data.get("replaceMd")))
                if error is not None:
                    return error
            elif u.is_md and u.branch_id is not None:
                return Response(
                    {"error": "The MD sees the whole company, so the account can't be limited to one branch."},
                    status=400,
                )
            u.save()
        old, new = _changed(before, _account_snapshot(u))
        if data.get("password"):
            new["password"] = "changed"
        words = []
        if "isActive" in old:
            words.append("activated" if u.is_active else "deactivated")
        if "category" in old:
            words.append(f"category {hr_access.CATEGORY_LABEL[old['category']]} -> {hr_access.CATEGORY_LABEL[category]}")
        if "roleId" in old:
            words.append(f"role -> {u.role.name if u.role_id and u.role else 'none'}")
        if "permissionOverrides" in old:
            words.append("own access changes updated")
        log_action(
            request, "update", "user_management", record_id=u.id,
            description=f"Updated HR user: {u.username}" + (f" ({', '.join(words)})" if words else ""),
            old_values=old or None, new_values=new or None,
        )  # fmt: skip
        if u.is_md and not was_md:
            log_action(request, "update", "user_management", record_id=u.id, description=f"Assigned MD: {u.username}")
        elif was_md and not u.is_md:
            log_action(
                request, "update", "user_management", record_id=u.id, description=f"Removed MD access from: {u.username}"
            )
        return Response(hr_user_json(u))

    if u.is_super_admin:
        return Response({"error": "Cannot delete super admin"}, status=400)
    log_action(request, "delete", "user_management", record_id=u.id, description=f"Deleted HR user: {u.username}")
    u.delete()
    return Response(status=204)


# ── Audit Logs ────────────────────────────────────────────────────────────────

#: Capability keys the master page may grant. Declared explicitly so a typo
#: in the request body is a 400 rather than a junk key nobody ever reads
#: again. "co" is reserved now and carries no behaviour yet -nothing in the
#: app checks it, so toggling it is safe and inert until a feature claims it.
MASTER_FEATURE_KEYS = {"co"}


@api_view(["GET"])
@require_master_admin
def master_hr_users(request: Request) -> Response:
    """Every account, hidden ones included -the master page's list.

    A separate endpoint from `hr_users` purely so the stricter guard is
    structural rather than a query parameter someone can forget to check.
    """
    qs = HRUser.objects.select_related("role", "department", "branch").order_by("username")
    return Response([hr_user_json(u) for u in qs])


@api_view(["PATCH"])
@require_master_admin
def master_hr_user_flags(request: Request, pk: int) -> Response:
    """Body: { isHidden?: bool, features?: { co?: bool } }

    The ONLY writer of is_hidden / master_features. Deliberately cannot touch
    is_active, role, branch or password -those stay on the normal Account
    Management page, so this route can never become a second way to
    administer users.
    """
    user = HRUser.objects.select_related("role", "department", "branch").filter(pk=pk).first()
    if not user:
        return Response({"error": "User not found"}, status=404)

    changes = []
    fields = []

    if "isHidden" in request.data:
        # Self-hiding is allowed on purpose: hiding the admin account from
        # the list other super admins see is a real use for this page, and
        # it is always recoverable -the master list shows hidden accounts.
        user.is_hidden = bool(request.data["isHidden"])
        fields.append("is_hidden")
        changes.append("hidden" if user.is_hidden else "visible")

    features = request.data.get("features")
    if features is not None:
        if not isinstance(features, dict):
            return Response({"error": "features must be an object"}, status=400)
        unknown = set(features) - MASTER_FEATURE_KEYS
        if unknown:
            return Response(
                {"error": f"Unknown feature key(s): {', '.join(sorted(unknown))}"}, status=400
            )
        merged = dict(user.master_features or {})
        for key, value in features.items():
            merged[key] = bool(value)
            changes.append(f"{key.upper()}={'on' if merged[key] else 'off'}")
        user.master_features = merged
        fields.append("master_features")

    if not fields:
        return Response({"error": "Nothing to update"}, status=400)

    user.save(update_fields=fields + ["updated_at"])

    # Logged like any other account change -a hidden account must stay just
    # as traceable as a visible one, or this page becomes a blind spot.
    log_action(
        request, "update", "user_management", record_id=user.id,
        description=f"Master: {user.username} -> {', '.join(changes)}",
    )
    return Response(hr_user_json(user))


@api_view(["GET"])
@require_super_admin
def audit_logs(request: Request) -> Response:
    """Admin-only. Deliberately NOT branch-scoped for branch users, because
    branch users cannot reach this at all -the audit trail is an oversight
    tool for whoever runs the company, not something each unit reviews for
    itself. Rows still carry a branch (see AuditLog.branch) so an admin can
    tell which unit an action came from."""
    module = request.query_params.get("module")
    action = request.query_params.get("action")
    user_name = request.query_params.get("userName")
    date_from = request.query_params.get("dateFrom")
    date_to = request.query_params.get("dateTo")
    page = int(request.query_params.get("page", 1))
    page_size = int(request.query_params.get("pageSize", 50))

    # Rows written before AuditLog gained a branch are null and stay
    # admin-only -see the model. Everything written from now on carries the
    # acting user's branch, so a branch admin sees their own unit's trail.
    qs = scope_to_branch(AuditLog.objects, request, field="branch_id").order_by("-created_at")
    if module:
        qs = qs.filter(module=module)
    if action:
        qs = qs.filter(action=action)
    if user_name:
        qs = qs.filter(user_name__icontains=user_name)
    if date_from:
        qs = qs.filter(created_at__date__gte=date_from)
    if date_to:
        qs = qs.filter(created_at__date__lte=date_to)

    total = qs.count()
    offset = (page - 1) * page_size
    logs = qs[offset: offset + page_size]
    return Response({
        "total": total,
        "page": page,
        "pageSize": page_size,
        "results": [audit_log_json(log) for log in logs],
    })


@api_view(["GET"])
@require_super_admin_or_md
def audit_logs_stats(request: Request) -> Response:
    now = timezone.now()
    today_start = now.replace(hour=0, minute=0, second=0, microsecond=0)
    week_start = today_start - timedelta(days=now.weekday())

    # Same scope as the log list itself -otherwise the KPI cards above
    # the table would count rows the table below cannot show.
    all_logs = scope_to_branch(AuditLog.objects, request, field="branch_id")
    today_count = all_logs.filter(created_at__gte=today_start).count()
    week_count = all_logs.filter(created_at__gte=week_start).count()
    total_count = all_logs.count()

    by_module = list(
        all_logs.values("module").annotate(count=Count("id")).order_by("-count")[:8]
    )
    by_action = list(
        all_logs.values("action").annotate(count=Count("id")).order_by("-count")
    )
    recent_users = list(
        all_logs.order_by("-created_at")
        .values("user_name", "created_at")[:5]
    )

    return Response({
        "today": today_count,
        "thisWeek": week_count,
        "total": total_count,
        "byModule": {item["module"]: item["count"] for item in by_module},
        "byAction": {item["action"]: item["count"] for item in by_action},
        "recentUsers": [
            {"name": r["user_name"], "at": r["created_at"].isoformat()}
            for r in recent_users
        ],
    })

import bcrypt
from datetime import datetime, timedelta

from django.utils import timezone
from django.db.models import Count

from rest_framework.decorators import api_view
from rest_framework.request import Request
from rest_framework.response import Response

from .auth import require_hr, require_super_admin
from .models import HRUser, Role, AuditLog
from .audit_utils import log_action


def role_json(r):
    return {
        "id": r.id,
        "name": r.name,
        "description": r.description,
        "permissions": r.permissions,
        "isSystem": r.is_system,
        "createdAt": r.created_at.isoformat() if r.created_at else None,
    }


def hr_user_json(u):
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
        "lastLogin": u.last_login.isoformat() if u.last_login else None,
        "createdAt": u.created_at.isoformat() if u.created_at else None,
    }


def audit_log_json(log):
    return {
        "id": log.id,
        "userType": log.user_type,
        "userId": log.user_id,
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

@api_view(["GET", "POST"])
@require_super_admin
def roles(request: Request) -> Response:
    if request.method == "GET":
        qs = Role.objects.order_by("name")
        return Response([role_json(r) for r in qs])

    data = request.data
    if not data.get("name"):
        return Response({"error": "name is required"}, status=400)
    if Role.objects.filter(name=data["name"]).exists():
        return Response({"error": "Role already exists"}, status=400)

    role = Role.objects.create(
        name=data["name"],
        description=data.get("description"),
        permissions=data.get("permissions", {}),
    )
    log_action(request, "create", "user_management", record_id=role.id, description=f"Created role: {role.name}")
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
        if "name" in data:
            role.name = data["name"]
        if "description" in data:
            role.description = data["description"]
        if "permissions" in data:
            role.permissions = data["permissions"]
        role.save()
        log_action(request, "update", "user_management", record_id=role.id, description=f"Updated role: {role.name}")
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
        return Response([hr_user_json(u) for u in qs])

    data = request.data
    if not data.get("username") or not data.get("password"):
        return Response({"error": "username and password are required"}, status=400)
    if HRUser.objects.filter(username=data["username"]).exists():
        return Response({"error": "Username already exists"}, status=400)

    pw_hash = bcrypt.hashpw(data["password"].encode(), bcrypt.gensalt()).decode()
    user = HRUser.objects.create(
        username=data["username"],
        email=data.get("email"),
        full_name=data.get("fullName"),
        password_hash=pw_hash,
        role_id=data.get("roleId"),
        department_id=data.get("departmentId"),
        branch_id=data.get("branchId"),
    )
    log_action(request, "create", "user_management", record_id=user.id, description=f"Created HR user: {user.username}")
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
        for field, attr in [
            ("email", "email"), ("fullName", "full_name"),
            ("roleId", "role_id"), ("departmentId", "department_id"),
            ("branchId", "branch_id"), ("isActive", "is_active"),
        ]:
            if field in data:
                setattr(u, attr, data[field])
        if data.get("password"):
            u.password_hash = bcrypt.hashpw(data["password"].encode(), bcrypt.gensalt()).decode()
        u.save()
        log_action(request, "update", "user_management", record_id=u.id, description=f"Updated HR user: {u.username}")
        return Response(hr_user_json(u))

    if u.is_super_admin:
        return Response({"error": "Cannot delete super admin"}, status=400)
    log_action(request, "delete", "user_management", record_id=u.id, description=f"Deleted HR user: {u.username}")
    u.delete()
    return Response(status=204)


# ── Audit Logs ────────────────────────────────────────────────────────────────

@api_view(["GET"])
@require_hr
def audit_logs(request: Request) -> Response:
    module = request.query_params.get("module")
    action = request.query_params.get("action")
    user_name = request.query_params.get("userName")
    date_from = request.query_params.get("dateFrom")
    date_to = request.query_params.get("dateTo")
    page = int(request.query_params.get("page", 1))
    page_size = int(request.query_params.get("pageSize", 50))

    qs = AuditLog.objects.order_by("-created_at")
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
@require_hr
def audit_logs_stats(request: Request) -> Response:
    now = timezone.now()
    today_start = now.replace(hour=0, minute=0, second=0, microsecond=0)
    week_start = today_start - timedelta(days=now.weekday())

    all_logs = AuditLog.objects.all()
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

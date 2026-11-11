"""
HR Assistant activity: what the HR Assistants (and, for the Super Admin, the HR Managers) did in the HR portal.

    GET /api/hr-activity?category=hr_assistant|hr_manager&accountId=&module=&action=&dateFrom=&dateTo=&search=&page=&pageSize=

Who may look (owner 2026-11-10): the Super Admin (everyone of either category) and HR Managers (HR Assistants only, those
in the manager's own branch when the manager is limited to one branch, and only the modules the manager can open).

Where the rows come from: the Activity Logs (AuditLog), by the account that acted (AuditLog.hr_user_id). Two kinds:
* what the views log themselves (approvals and rejections: hr_access.log_decision; account and role changes; attendance
  edits; settings ...), with the old and new values where the view kept them;
* one row per successful change an HR Manager / HR Assistant makes anywhere else (record_write below, called by
  HrPermissionMiddleware): the page, the record and what was sent (secrets, photos and files left out). Nothing changes
  for the Admin accounts, the Super Admin or the MD: they are not logged this way.
"""

from __future__ import annotations

import json
import re
from datetime import timedelta

from django.utils import timezone
from rest_framework.decorators import api_view
from rest_framework.request import Request
from rest_framework.response import Response

from . import hr_access
from .auth import require_hr
from .permission_registry import (
    MODULE_TREE,
    READ_ONLY_POST_PATHS,
    effective_permissions,
    resolve_module,
    resolve_permission,
)

WRITE_METHODS = {"POST", "PUT", "PATCH", "DELETE"}
MAX_BODY_BYTES = 64 * 1024
# Never kept in the trail, whatever the endpoint: passwords, keys, codes, bank details, photos and files.
_SECRET = re.compile(
    r"pass|token|secret|otp|signature|photo|image|file|base64|aadhaar|aadhar|bank|account|api_?key", re.I
)
_LABELS = {node["key"]: node["label"] for node in MODULE_TREE}
_LABELS.update({"auth": "Sign-in", "general": "Other"})
# Activity Logs module names that are not a sidebar module: the module whose access lets a manager see them.
AUDIT_MODULE_SCOPE = {
    "approval_workflow": "user_management",
    "hod_reminders": "requests",
    "compensation_settings": "settings",
    "production_shift_rules": "settings",
    "shared_endpoints": "settings",
    "mobile_app_version": "mobile_app_login",
}
# Shown to a manager whatever their own access: signing in and out, and calls that belong to no module.
ALWAYS_VISIBLE = ("auth", "general")
# POST calls that only check or preview something (nothing is saved): not part of the trail.
READ_LIKE_SUFFIXES = ("preview", "skip-check", "/check", "/validate", "/test")


# ───────────────────────────── writing the trail ─────────────────────────────


def _clean(value, depth: int = 0):
    if isinstance(value, dict):
        if depth >= 2:
            return "{…}"
        out = {}
        for i, (k, v) in enumerate(value.items()):
            if i >= 40:
                out["…"] = f"{len(value) - 40} more"
                break
            if _SECRET.search(str(k)):
                continue
            out[str(k)] = _clean(v, depth + 1)
        return out
    if isinstance(value, list):
        items = [_clean(v, depth + 1) for v in value[:20]]
        return items + ([f"… {len(value) - 20} more"] if len(value) > 20 else [])
    if isinstance(value, str):
        if value.startswith("data:") or len(value) > 200:
            return value[:200] + "…" if not value.startswith("data:") else "(file)"
        return value
    return value


def capture_write(request, actor, rel_path):
    """Before the view runs: the details of a change an HR Manager / HR Assistant is making, or None (nothing to log).
    The body is read here because the view consumes the stream."""
    if (
        actor is None
        or rel_path is None
        or request.method not in WRITE_METHODS
        or actor.is_super_admin
        or actor.is_md
        or hr_access.category_of(actor) not in hr_access.STAFF_CATEGORIES
        or rel_path.startswith(("auth/", "shared/"))
        or rel_path in READ_ONLY_POST_PATHS
        or rel_path.rstrip("/").endswith(READ_LIKE_SUFFIXES)
    ):
        return None
    body = None
    content_type = request.META.get("CONTENT_TYPE", "")
    try:
        length = int(request.META.get("CONTENT_LENGTH") or 0)
    except ValueError:
        length = 0
    if "json" in content_type and 0 < length <= MAX_BODY_BYTES:
        try:
            body = _clean(json.loads(request.body or b"null"))
        except Exception:
            body = None
    elif length:
        body = {"(upload)": f"{length} bytes"}
    return {"actor": actor, "path": rel_path, "method": request.method, "body": body}


def record_write(request, response, captured) -> None:
    """After the view: one Activity Logs row for a change that succeeded and that the view did not log itself."""
    status = getattr(response, "status_code", 500)
    if not (200 <= status < 300) or getattr(request, "_audit_logged", False):
        return
    try:
        from .audit_utils import _get_ip
        from .models import AuditLog

        actor, path, method = captured["actor"], captured["path"], captured["method"]
        module_key = resolve_module(path)
        module = module_key.split(".")[0] if module_key else "general"
        label = _LABELS.get(module_key or "", None) or _LABELS.get(module, module)
        number = re.search(r"(?:^|/)(\d+)(?:/|$)", path)
        if method == "DELETE":
            action, verb = "delete", "Deleted in"
        elif "export" in path or path.endswith(("/pdf", "/excel", "/xlsx")):
            action, verb = "export", "Exported from"
        elif method == "POST":
            action, verb = "create", "Added in"
        else:
            action, verb = "update", "Changed in"
        AuditLog.objects.create(
            user_type="hr",
            hr_user_id=actor.id,
            user_name=actor.full_name or actor.username,
            action=action,
            module=module,
            record_id=int(number.group(1)) if number else None,
            record_description=f"{verb} {label} ({method} /api/{path})",
            new_values={"request": captured["body"]} if captured["body"] is not None else None,
            ip_address=_get_ip(request),
            branch_id=actor.branch_id,
        )
    except Exception:
        pass  # the trail must never break the change it describes


# ───────────────────────────── reading it ─────────────────────────────


def _visible_modules(viewer) -> set[str] | None:
    """The Activity Logs modules this viewer may see rows of; None = every module (the Super Admin)."""
    if viewer.is_super_admin:
        return None
    perms = effective_permissions(viewer)
    out = set(ALWAYS_VISIBLE)
    for node in MODULE_TREE:
        keys = [node["key"]] + [c["key"] for c in node.get("children", [])]
        if any(resolve_permission(perms, k) in ("view", "edit") for k in keys):
            out.add(node["key"])
    out.update(name for name, owner in AUDIT_MODULE_SCOPE.items() if owner in out)
    return out


def _row(log, people: dict) -> dict:
    who = people.get(log.hr_user_id)
    return {
        "id": log.id,
        "at": log.created_at.isoformat() if log.created_at else None,
        "accountId": log.hr_user_id,
        "username": who.username if who else None,
        "fullName": (who.full_name if who else None) or log.user_name,
        "action": log.action,
        "module": log.module,
        "moduleLabel": _LABELS.get(log.module, log.module.replace("_", " ").capitalize()),
        "recordId": log.record_id,
        "description": log.record_description,
        "oldValues": log.old_values,
        "newValues": log.new_values,
        "ipAddress": log.ip_address,
    }


def _int(raw, default: int, lo: int, hi: int) -> int:
    try:
        return max(lo, min(hi, int(raw)))
    except (TypeError, ValueError):
        return default


@api_view(["GET"])
@require_hr
def hr_activity(request: Request) -> Response:
    from .models import AuditLog, HRUser

    viewer = hr_access.request_actor(request)
    is_admin = bool(viewer and viewer.is_super_admin)
    if viewer is None or not (is_admin or hr_access.category_of(viewer) == hr_access.HR_MANAGER) or viewer.is_md:
        return Response(
            {
                "error": "Only the Super Admin and HR Managers can review HR Assistant activity.",
                "code": "permission_denied",
            },
            status=403,
        )
    q = request.query_params
    category = q.get("category") or hr_access.HR_ASSISTANT
    if category not in hr_access.STAFF_CATEGORIES:
        return Response({"error": "category must be hr_assistant or hr_manager."}, status=400)
    if category == hr_access.HR_MANAGER and not is_admin:
        return Response(
            {"error": "Only the Super Admin can review HR Manager activity.", "code": "permission_denied"}, status=403
        )

    people_qs = HRUser.objects.select_related("role", "branch").filter(
        category=category, is_super_admin=False, is_md=False
    )
    if not is_admin and viewer.branch_id is not None:
        # a manager limited to one branch sees that branch's assistants (a company-wide assistant is not theirs)
        people_qs = people_qs.filter(branch_id=viewer.branch_id)
    people = {p.id: p for p in people_qs.order_by("username")}

    qs = AuditLog.objects.filter(hr_user_id__in=list(people))
    visible = _visible_modules(viewer)
    if visible is not None:
        qs = qs.filter(module__in=sorted(visible))
    if account_id := q.get("accountId"):
        qs = qs.filter(hr_user_id=_int(account_id, -1, -1, 2**31))
    if module := q.get("module"):
        qs = qs.filter(module=module)
    if action := q.get("action"):
        qs = qs.filter(action=action)
    if date_from := q.get("dateFrom"):
        qs = qs.filter(created_at__date__gte=date_from[:10])
    if date_to := q.get("dateTo"):
        qs = qs.filter(created_at__date__lte=date_to[:10])
    if search := (q.get("search") or "").strip():
        qs = qs.filter(record_description__icontains=search[:100])

    try:
        total = qs.count()
    except Exception:
        return Response({"error": "dateFrom / dateTo must be dates (YYYY-MM-DD)."}, status=400)
    page = _int(q.get("page"), 1, 1, 100000)
    page_size = _int(q.get("pageSize"), 50, 1, 500)
    rows = qs.order_by("-created_at", "-id")[(page - 1) * page_size : page * page_size]

    base = AuditLog.objects.filter(hr_user_id__in=list(people))
    if visible is not None:
        base = base.filter(module__in=sorted(visible))
    now = timezone.now()
    today = now.replace(hour=0, minute=0, second=0, microsecond=0)
    modules = sorted(set(base.values_list("module", flat=True).distinct()))
    return Response(
        {
            "category": category,
            "total": total,
            "page": page,
            "pageSize": page_size,
            "results": [_row(log, people) for log in rows],
            "summary": {
                "today": base.filter(created_at__gte=today).count(),
                "last7Days": base.filter(created_at__gte=now - timedelta(days=7)).count(),
                "approvals": base.filter(action__in=("approve", "reject")).count(),
            },
            "accounts": [
                {
                    "id": p.id,
                    "username": p.username,
                    "fullName": p.full_name,
                    "roleName": p.role.name if p.role_id and p.role else None,
                    "branchName": p.branch.name if p.branch_id and p.branch else None,
                    "isActive": p.is_active,
                    "lastLogin": p.last_login.isoformat() if p.last_login else None,
                }
                for p in people.values()
            ],
            "modules": [{"key": m, "label": _LABELS.get(m, m.replace("_", " ").capitalize())} for m in modules],
            "canSeeManagers": is_admin,
        }
    )

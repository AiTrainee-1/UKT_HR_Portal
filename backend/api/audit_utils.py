"""Shared helper for writing audit log entries. Never raises -always safe to call."""
from __future__ import annotations
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from rest_framework.request import Request


def log_action(
    request: "Request",
    action: str,
    module: str,
    record_id: int | None = None,
    description: str | None = None,
    old_values: dict | None = None,
    new_values: dict | None = None,
) -> None:
    try:
        from .models import AuditLog
        user = getattr(request, "jwt_user", {}) or {}
        AuditLog.objects.create(
            user_type=user.get("role", "hr"),
            user_id=user.get("userId") or user.get("employeeId"),
            user_name=user.get("name") or user.get("username") or "system",
            action=action,
            module=module,
            record_id=record_id,
            record_description=description,
            old_values=old_values,
            new_values=new_values,
            ip_address=_get_ip(request),
            # Stamped now because it cannot be recovered later -AuditLog has
            # no foreign key to the actor. None for unscoped admins, which is
            # accurate: the action was not taken on behalf of one branch.
            branch_id=_get_branch(request),
        )
    except Exception:
        pass


def _get_branch(request) -> int | None:
    """The acting user's branch, or None for unscoped admins.

    Reads the same request attribute HrPermissionMiddleware sets for every
    scoped query, so an audit row is stamped with exactly the branch whose
    data the action was allowed to touch.
    """
    try:
        from .branch_scope import get_branch_scope
        return get_branch_scope(request)
    except Exception:
        return None


def _get_ip(request) -> str | None:
    x_forwarded = request.META.get("HTTP_X_FORWARDED_FOR")
    if x_forwarded:
        return x_forwarded.split(",")[0].strip()
    return request.META.get("REMOTE_ADDR")

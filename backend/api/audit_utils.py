"""Shared helper for writing audit log entries. Never raises — always safe to call."""
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
        )
    except Exception:
        pass


def _get_ip(request) -> str | None:
    x_forwarded = request.META.get("HTTP_X_FORWARDED_FOR")
    if x_forwarded:
        return x_forwarded.split(",")[0].strip()
    return request.META.get("REMOTE_ADDR")

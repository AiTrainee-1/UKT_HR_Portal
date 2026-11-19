"""Shared helper for writing audit log entries. Never raises -always safe to call."""
from __future__ import annotations
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from rest_framework.request import Request


def build_log_entry(
    request: "Request",
    action: str,
    module: str,
    record_id: int | None = None,
    description: str | None = None,
    old_values: dict | None = None,
    new_values: dict | None = None,
):
    """An unsaved AuditLog for this request's user. log_action saves one at a time; a bulk upload collects one per
    employee and writes them together with save_log_entries."""
    from .models import AuditLog
    user = getattr(request, "jwt_user", {}) or {}
    # The middleware's generic HR activity row (hr_activity_views.record_write) is skipped when the view wrote its own.
    try:
        setattr(getattr(request, "_request", request), "_audit_logged", True)
    except Exception:
        pass
    hr_user_id = user.get("hrUserId") if user.get("role", "hr") == "hr" else None
    device_name, device_branch = _device_actor(request, user)
    return AuditLog(
        user_type=user.get("role", "hr"),
        user_id=user.get("userId") or user.get("employeeId"),
        hr_user_id=hr_user_id if isinstance(hr_user_id, int) else None,
        user_name=device_name or user.get("name") or user.get("username") or "system",
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
        branch_id=device_branch if device_name else _get_branch(request),
    )


# The device logins that act on their own (a gate monitor, a reception desk): the audit row names the device, as
# "Gate - <name>" / "Reception desk - <name>", and carries the device's branch (an HR row carries the HR user's).
_DEVICE_ACTORS = (
    ("gate_device", "gate_device", "gateName", "Gate"),
    ("reception_device", "reception_device", "deskName", "Reception desk"),
)


def _device_actor(request, user: dict) -> tuple[str | None, int | None]:
    """(actor name, branch id) for a gate / reception desk request, else (None, None). The device that
    auth.require_gate_device / require_reception_device put on the request (its current name), else the token's claim."""
    role = user.get("role")
    for device_role, attr, claim, word in _DEVICE_ACTORS:
        if role != device_role:
            continue
        device = getattr(request, attr, None)
        name = getattr(device, "name", None) or user.get(claim)
        if not name:
            return f"{word} #{user.get('deviceId')}", None
        return f"{word} - {name}", getattr(device, "branch_id", None)
    return None, None


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
        build_log_entry(request, action, module, record_id, description, old_values, new_values).save()
    except Exception:
        pass


def save_log_entries(entries: list) -> None:
    """Write a batch of build_log_entry() rows in ONE query. Never raises: the insert runs in its own savepoint, so
    a failure here can neither abort the caller's transaction nor lose the work it already did."""
    if not entries:
        return
    try:
        from django.db import transaction
        from .models import AuditLog
        with transaction.atomic():
            AuditLog.objects.bulk_create(entries, batch_size=500)
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

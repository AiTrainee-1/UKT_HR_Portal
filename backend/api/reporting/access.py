"""Who may see / run a report.

HrPermissionMiddleware already gates every /api/reports/* request on the "reports" module (view is
enough for GET). Two extra rules live here:

* ``modules`` -- a report also needs "view"+ on at least one of the modules that own its data, so
  a "reports" grant is not a back door to payroll, visitor or attendance data the role cannot open
  elsewhere in the app. Fails closed: an unknown module key resolves to "hidden".
* ``super_admin_only`` -- data that is admin-only elsewhere (audit trail, user accounts).
* ``md_only`` -- the executive reports of the Managing Director (hidden from everybody else).

The Managing Director (HRUser.is_md) reads EVERY report, company-wide and read-only: ``permission_level`` gives that
account "view" on every module, so the in-report gates (salary, payroll types, resignation details) open for it and
nothing else changes for anyone. Reports never write, so "view" is all it needs.

Role permissions are read once per request and reused, so a catalog of ~50 reports costs one query.
"""

from __future__ import annotations

from api.permission_registry import resolve_permission

from .types import ReportSpec

OK = "ok"
FORBIDDEN = "forbidden"  # exists, but the user's role lacks the owning module
HIDDEN = "hidden"  # super-admin-only: pretend it does not exist


def _hr_user(request):
    cached = getattr(request, "_report_hr_user", False)
    if cached is not False:
        return cached
    from api.models import HRUser

    user = None
    hr_user_id = (getattr(request, "jwt_user", None) or {}).get("hrUserId")
    if hr_user_id:
        user = HRUser.objects.select_related("role").filter(id=hr_user_id, is_active=True).first()
    request._report_hr_user = user
    return user


def is_super_admin(request) -> bool:
    user = _hr_user(request)
    return bool(user and user.is_super_admin)


def is_md(request) -> bool:
    user = _hr_user(request)
    return bool(user and user.is_md)


def hr_display_name(request) -> str:
    user = _hr_user(request)
    if user is not None:
        return user.full_name or user.username
    return (getattr(request, "jwt_user", None) or {}).get("name") or "HR"


def permission_level(request, module_key: str) -> str:
    """ "hidden" | "view" | "edit" for the requesting HR user (super admin = edit; unknown user = hidden)."""
    user = _hr_user(request)
    if user is None:
        return "hidden"
    if user.is_super_admin:
        return "edit"
    if user.is_md:
        return "view"  # the Managing Director: read-only access to everything a report can show
    return resolve_permission(user.role.permissions if user.role else {}, module_key)


def access_state(request, spec: ReportSpec) -> str:
    if spec.md_only:
        return OK if is_md(request) else HIDDEN
    if is_md(request):
        return OK  # the Managing Director may open every other report too, super-admin-only ones included
    if spec.super_admin_only:
        return OK if is_super_admin(request) else HIDDEN
    if not spec.modules or is_super_admin(request):
        return OK
    if any(permission_level(request, m) in ("view", "edit") for m in spec.modules):
        return OK
    return FORBIDDEN


def can_access(request, spec: ReportSpec) -> bool:
    return access_state(request, spec) == OK

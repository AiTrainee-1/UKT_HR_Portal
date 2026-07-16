from django.http import JsonResponse

from .auth import get_bearer_token
from .jwt_utils import verify_token
from .permission_registry import resolve_module, resolve_permission

SAFE_METHODS = {"GET", "HEAD", "OPTIONS"}
# auth/* must always be reachable to log in or check identity; healthz for
# uptime probes. Everything else under /api/ is a candidate for gating.
EXEMPT_PREFIXES = ("auth/",)
EXEMPT_PATHS = ("healthz",)

# Read-only aggregate/config data pulled by many pages regardless of the
# viewer's access to that data's "owning" module — company branding
# (payroll-settings), a device picker (biometric-devices), the company
# holiday calendar, and audit-log *counts* (not the log entries themselves,
# which stay behind activity_logs). None of these expose the kind of
# per-record sensitive detail their owning module's full page does, so GET
# is always allowed here; writes still go through the normal module check
# below (payroll-settings/biometric-devices POST still needs "settings" edit,
# holidays POST still needs "leave" edit).
ALWAYS_READABLE_GET_PREFIXES = (
    "payroll-settings",
    "biometric-devices",
    "holidays",
    "audit-logs/stats",
)


def _is_always_readable_get(path: str) -> bool:
    for prefix in ALWAYS_READABLE_GET_PREFIXES:
        if path == prefix or path.startswith(prefix + "/"):
            return True
    return False


class HrPermissionMiddleware:
    """
    Enforces Role.permissions (hidden/view/edit) for HR-portal requests.

    Deliberately implemented as middleware rather than extending the
    @require_hr decorator: several views in this codebase dispatch per-HTTP-
    method internally (e.g. views.py::employees calls require_auth(...) for
    GET but require_hr(...) for POST from inside one function body), so GET
    traffic on some modules never passes through @require_hr at all. A
    decorator-only check would miss those; middleware runs on every request
    regardless of which decorator (or none) the matched view uses.

    Employee/manager-portal tokens (role != "hr") are untouched — this only
    ever restricts the HR portal. Endpoints not present in the module
    registry (dashboard summaries, notifications, chat, roles/hr-users —
    the latter gated separately by require_super_admin) are left ungated.
    """

    def __init__(self, get_response):
        self.get_response = get_response

    def __call__(self, request):
        if request.path.startswith("/api/"):
            rel_path = request.path[len("/api/"):]
            if not rel_path.startswith(EXEMPT_PREFIXES) and rel_path not in EXEMPT_PATHS:
                denial = self._check(request, rel_path)
                if denial is not None:
                    return denial

        return self.get_response(request)

    def _check(self, request, rel_path):
        token = get_bearer_token(request)
        if not token:
            return None  # no/absent token — let the view's own auth decorator 401 it

        try:
            payload = verify_token(token)
        except Exception:
            return None  # invalid/expired — let the view's own auth decorator handle it

        if payload.get("role") != "hr":
            return None

        from .models import HRUser

        hr_user_id = payload.get("hrUserId")
        hr_user = (
            HRUser.objects.select_related("role").filter(id=hr_user_id, is_active=True).first()
            if hr_user_id
            else None
        )
        if hr_user is None:
            # Token references an account that no longer exists or has been
            # disabled — reject immediately rather than waiting for JWT expiry.
            return JsonResponse({"error": "account_disabled", "message": "This account is disabled."}, status=401)

        if hr_user.is_super_admin:
            return None

        if request.method in SAFE_METHODS and _is_always_readable_get(rel_path):
            return None

        module_key = resolve_module(rel_path)
        if module_key is None:
            return None  # not a gated sidebar module

        # Cascading: a submodule (e.g. "employees.departments") with no
        # explicit entry inherits its parent's ("employees") level.
        level = resolve_permission(hr_user.role.permissions if hr_user.role else {}, module_key)

        if level == "edit":
            return None
        if level == "view" and request.method in SAFE_METHODS:
            return None

        return JsonResponse(
            {"error": "permission_denied", "message": "You do not have access to this section."},
            status=403,
        )

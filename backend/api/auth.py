from functools import wraps

from rest_framework.request import Request
from rest_framework.response import Response

from .jwt_utils import verify_token


def get_bearer_token(request: Request) -> str | None:
    auth = request.headers.get("Authorization", "")
    if auth.startswith("Bearer "):
        return auth[7:]
    return None


def require_auth(view_func):
    @wraps(view_func)
    def wrapper(request: Request, *args, **kwargs):
        token = get_bearer_token(request)
        if not token:
            return Response({"error": "Unauthorized"}, status=401)
        try:
            request.jwt_user = verify_token(token)
        except Exception:
            return Response({"error": "Invalid or expired token"}, status=401)
        return view_func(request, *args, **kwargs)

    return wrapper


def require_hr(view_func):
    @wraps(view_func)
    @require_auth
    def wrapper(request: Request, *args, **kwargs):
        if request.jwt_user.get("role") != "hr":
            return Response({"error": "HR access required"}, status=403)
        return view_func(request, *args, **kwargs)

    return wrapper


def require_super_admin(view_func):
    """
    Gates the Account Management endpoints (roles, hr-users) — the control
    plane for the whole RBAC system. Deliberately separate from the generic
    per-module hidden/view/edit permissions enforced in permission_middleware.py:
    a regular role can never be configured to grant access here, only
    HRUser.is_super_admin can.
    """
    @wraps(view_func)
    @require_hr
    def wrapper(request: Request, *args, **kwargs):
        from .models import HRUser

        hr_user_id = request.jwt_user.get("hrUserId")
        is_admin = (
            hr_user_id is not None
            and HRUser.objects.filter(id=hr_user_id, is_active=True, is_super_admin=True).exists()
        )
        if not is_admin:
            return Response({"error": "Administrator access required"}, status=403)
        return view_func(request, *args, **kwargs)

    return wrapper


def get_token_employee_id(request: Request) -> int | None:
    """If the logged-in user is an employee, return their employeeId from the JWT. HR returns None."""
    user = getattr(request, "jwt_user", {})
    if user.get("role") == "employee":
        return user.get("employeeId")
    return None


def is_hr(request: Request) -> bool:
    return getattr(request, "jwt_user", {}).get("role") == "hr"

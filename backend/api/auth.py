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

        # LoginSession revocation check -the JWT itself is stateless and
        # stays "valid" for its full 12h lifetime, so a Login Devices revoke
        # (or self logout) has to be enforced here via a live DB check, same
        # pattern require_super_admin already uses for is_active/is_super_admin.
        # Only HR tokens carry a jti (see hr_login in views.py) -employee
        # tokens never set one, so this is a no-op on the employee/mobile path.
        jti = request.jwt_user.get("jti")
        if jti:
            from django.utils import timezone

            from .models import LoginSession

            session = LoginSession.objects.filter(jti=jti).first()
            if session is None or session.revoked_at is not None:
                return Response({"error": "Session revoked"}, status=401)
            now = timezone.now()
            if (now - session.last_seen_at).total_seconds() > 60:
                session.last_seen_at = now
                session.save(update_fields=["last_seen_at"])

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


def is_master_admin(hr_user) -> bool:
    """Is this the ONE designated admin account?

    Deliberately narrower than `is_super_admin`: several people can be super
    admins, but only the account named by ADMIN_USERNAME in .env -the same
    account apps.py bootstraps -may reach Account Management → Master. That
    page can hide accounts from every other admin, so "any super admin" would
    make hiding purely cosmetic between them.

    Fails CLOSED when ADMIN_USERNAME is unset: no master admin exists rather
    than silently widening to all super admins. The 403 says so explicitly.

    Matched case-insensitively to agree with the bootstrap in apps.py, which
    looks the account up with username__iexact.
    """
    from django.conf import settings

    admin_username = (getattr(settings, "ADMIN_USERNAME", "") or "").strip()
    if not admin_username or hr_user is None:
        return False
    return (
        hr_user.is_active
        and hr_user.is_super_admin
        and hr_user.username.strip().lower() == admin_username.lower()
    )


def require_master_admin(view_func):
    """Restrict a view to the single ADMIN_USERNAME account -see is_master_admin."""

    @wraps(view_func)
    @require_hr
    def wrapper(request: Request, *args, **kwargs):
        from django.conf import settings

        from .models import HRUser

        hr_user = HRUser.objects.filter(id=request.jwt_user.get("hrUserId")).first()
        if not is_master_admin(hr_user):
            if not (getattr(settings, "ADMIN_USERNAME", "") or "").strip():
                return Response(
                    {"error": "No master admin is configured -set ADMIN_USERNAME in .env"},
                    status=403,
                )
            return Response({"error": "Master administrator access required"}, status=403)
        return view_func(request, *args, **kwargs)

    return wrapper


def require_super_admin(view_func):
    """
    Gates the Account Management endpoints (roles, hr-users) -the control
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


def get_hr_display_name(request: Request) -> str:
    """
    Real name of the logged-in HR user, for attribution fields like
    reviewed_by/approved_by/requested_by. hr_login() already embeds
    `"name": account.full_name or account.username` into the JWT payload
    (views.py), and require_auth decodes it back onto request.jwt_user on
    every authenticated call -so this is always available on any
    @require_hr view without a fresh DB lookup. Falls back to the literal
    "HR" only if somehow absent (e.g. a still-valid token issued before
    this field existed).
    """
    return getattr(request, "jwt_user", {}).get("name") or "HR"

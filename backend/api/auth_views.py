"""Health check and HR/employee login, logout, set-password and /auth/me."""

import bcrypt
import uuid

from .audit_utils import _get_ip, log_action
from .auth import get_bearer_token, require_auth
from .jwt_utils import sign_token, verify_token
from .models import Employee, HRUser, HrLoginAttempt, LoginSession
from .serializers import employee_full_name
from .session_utils import parse_user_agent
from .view_common import _error
from datetime import timedelta
from django.db.models import Q
from django.utils import timezone
from rest_framework.decorators import api_view, throttle_classes
from rest_framework.request import Request
from rest_framework.response import Response
from rest_framework.throttling import ScopedRateThrottle


# --- Health ---


@api_view(["GET"])
def healthz(_request: Request) -> Response:
    return Response({"status": "ok"})


# --- Auth ---

# HR Portal login lockout -independent of the DRF per-IP throttle below.
# This is per-username, so an attacker rotating IPs still gets locked out.
HR_LOCKOUT_THRESHOLD = 5


HR_LOCKOUT_WINDOW_MINUTES = 15


HR_LOCKOUT_DURATION_MINUTES = 15


def _hr_username_locked_out(username: str) -> bool:
    if not username:
        return False
    window_start = timezone.now() - timedelta(minutes=HR_LOCKOUT_WINDOW_MINUTES)
    recent = HrLoginAttempt.objects.filter(
        username__iexact=username, created_at__gte=window_start
    ).order_by("-created_at")[:HR_LOCKOUT_THRESHOLD]
    if len(recent) < HR_LOCKOUT_THRESHOLD:
        return False
    # Locked out only if the most recent N attempts were ALL failures —
    # a single success resets the count.
    return all(not a.success for a in recent)


@api_view(["POST"])
@throttle_classes([ScopedRateThrottle])
def hr_login(request: Request) -> Response:
    request.throttle_scope = "login"
    username = (request.data.get("username") or "").strip()
    password = request.data.get("password") or ""

    if _hr_username_locked_out(username):
        log_action(request, "login_blocked", "auth", description=f"Locked-out login attempt for: {username}")
        return _error(
            f"Too many failed attempts. Try again in {HR_LOCKOUT_DURATION_MINUTES} minutes.", 429
        )

    account = HRUser.objects.filter(username__iexact=username, is_active=True).first()
    valid = bool(account) and bool(password) and bcrypt.checkpw(password.encode(), account.password_hash.encode())

    HrLoginAttempt.objects.create(username=username, ip_address=_get_ip(request), success=valid)

    if not valid:
        log_action(request, "login_failed", "auth", description=f"Failed login for: {username}")
        return _error("Invalid credentials", 401)

    label = account.full_name or account.username
    account.last_login = timezone.now()
    account.save(update_fields=["last_login"])
    # Shorter-lived token than employee sessions -this is the privileged portal.
    # Permissions are NOT baked into the token -see permission_middleware.py,
    # which re-checks HRUser.is_active/role.permissions fresh on every request
    # so an Admin revoking access takes effect immediately, not after expiry.
    # jti ties this token to a revocable LoginSession row (see require_hr in
    # auth.py) -powers the Login Devices page and remote/self logout.
    jti = uuid.uuid4().hex
    token_payload = {
        "role": "hr",
        "name": label,
        "username": account.username,
        "hrUserId": account.id,
        "isSuperAdmin": account.is_super_admin,
        "jti": jti,
    }
    token = sign_token(token_payload, expires_in=timedelta(hours=12))
    request.jwt_user = token_payload
    user_agent = request.META.get("HTTP_USER_AGENT", "")
    LoginSession.objects.create(
        hr_user=account,
        jti=jti,
        device_label=parse_user_agent(user_agent),
        user_agent=user_agent,
        ip_address=_get_ip(request),
    )
    log_action(request, "login", "auth", description=f"{label} ({account.username}) logged in")
    return Response({"token": token, "role": "hr", "employeeId": None, "name": label})


@api_view(["POST"])
@throttle_classes([ScopedRateThrottle])
def employee_login(request: Request) -> Response:
    request.throttle_scope = "employee_login"
    from .models import WhatsAppSettings
    from .whatsapp_service import is_configured as whatsapp_configured

    wa = WhatsAppSettings.get()
    if not wa.password_login_enabled and wa.otp_login_enabled and whatsapp_configured():
        return _error("Password sign-in is turned off. Please sign in with a WhatsApp code.", 403)
    identifier = request.data.get("identifier")
    password = request.data.get("password")
    if not identifier or not password:
        return _error("Validation error")
    employee = Employee.objects.filter(
        Q(phone=identifier) | Q(email=identifier) | Q(employee_code=identifier)
    ).first()
    if not employee:
        return _error("You are not registered. Please contact HR.", 401)
    if not employee.password_hash:
        return _error("No password set. Please set your password first.", 401)
    if not bcrypt.checkpw(password.encode(), employee.password_hash.encode()):
        return _error("Invalid password", 401)
    # Feeds the HR portal's Mobile App Login page ("who has actually signed
    # in, and when"). Written on every successful login, not just the first.
    employee.last_mobile_login_at = timezone.now()
    employee.save(update_fields=["last_mobile_login_at", "updated_at"])
    name = employee_full_name(employee)
    token = sign_token({"role": "employee", "employeeId": employee.id, "name": name})
    return Response(
        {"token": token, "role": "employee", "employeeId": employee.id, "name": name}
    )


@api_view(["POST"])
@require_auth
def logout(request: Request) -> Response:
    jti = request.jwt_user.get("jti")
    if jti:
        LoginSession.objects.filter(jti=jti, revoked_at__isnull=True).update(revoked_at=timezone.now())
    return Response({"message": "Logged out"})


@api_view(["POST"])
@throttle_classes([ScopedRateThrottle])
def set_password(request: Request) -> Response:
    request.throttle_scope = "employee_login"
    identifier = request.data.get("identifier")
    password = request.data.get("password")
    if not identifier or not password or len(password) < 8:
        return _error("Validation error")
    employee = Employee.objects.filter(
        Q(phone=identifier) | Q(email=identifier) | Q(employee_code=identifier)
    ).first()
    if not employee:
        return _error("Employee not found. Please contact HR.", 404)
    # Only that employee's own signed-in session may set or change their password
    # here -otherwise anyone who knows a colleague's employee code could take over
    # their account. A signed-in employee with no password yet (they came in by
    # WhatsApp code) is covered by the same rule.
    token = get_bearer_token(request)
    try:
        claims = verify_token(token) if token else {}
    except Exception:
        claims = {}
    own_session = claims.get("role") == "employee" and claims.get("employeeId") == employee.id
    if not own_session:
        if employee.password_hash:
            return _error("Sign in to change your password.", 403)
        # First-time setup by someone not signed in: they must confirm the WhatsApp
        # code sent to their registered number first (otp_views.otp_activate). Only
        # when that can't work (switched off / WhatsApp not configured) does the old
        # open setup remain, so no new employee is locked out.
        from .otp_service import activation_required

        if activation_required():
            return _error(
                "Please confirm the code we send to your registered WhatsApp number to set your password.",
                403,
            )
    employee.password_hash = bcrypt.hashpw(password.encode(), bcrypt.gensalt(rounds=10)).decode()
    employee.password_updated_at = timezone.now()
    employee.save(update_fields=["password_hash", "password_updated_at", "updated_at"])
    return Response({"message": "Password set successfully"})


@api_view(["GET"])
@require_auth
def auth_me(request: Request) -> Response:
    user = request.jwt_user
    payload = {
        "role": user.get("role"),
        "employeeId": user.get("employeeId"),
        "name": user.get("name", ""),
    }
    if user.get("role") == "hr":
        # Resolved fresh from the DB (not trusted from the token) so a
        # permission change by an Admin is reflected on the next page load.
        hr_user = (
            HRUser.objects.select_related("role", "branch")
            .filter(id=user.get("hrUserId"), is_active=True)
            .first()
        )
        is_super_admin = bool(hr_user and hr_user.is_super_admin)
        permissions = (hr_user.role.permissions if hr_user and hr_user.role else {}) or {}
        payload["isSuperAdmin"] = is_super_admin
        # Narrower than isSuperAdmin -only the ADMIN_USERNAME account. Gates
        # Account Management → Master in the UI; the API guard is what
        # actually enforces it (see auth.require_master_admin).
        from .auth import is_master_admin
        payload["isMasterAdmin"] = is_master_admin(hr_user)
        payload["permissions"] = permissions
        payload["branchId"] = hr_user.branch_id if hr_user else None
        payload["branchName"] = hr_user.branch.name if hr_user and hr_user.branch else None
    return Response(payload)

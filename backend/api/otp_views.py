"""
Employee sign-in and password reset by WhatsApp OTP (mobile app + Employee Web
App). Public endpoints under /api/auth/ -the employee has no token yet- so
they are rate limited per IP here, and per employee inside otp_service.

    GET  /api/auth/login-options        which sign-in methods are switched on
    POST /api/auth/otp/request          {employeeCode, purpose: "login"|"reset"|"activate"}
    POST /api/auth/otp/login            {employeeCode, otp}
    POST /api/auth/otp/reset-password   {employeeCode, otp, password}
    POST /api/auth/otp/activate         {employeeCode, otp, password}   (first-time password)
"""

import bcrypt
from django.utils import timezone
from rest_framework.decorators import api_view, throttle_classes
from rest_framework.request import Request
from rest_framework.response import Response
from rest_framework.throttling import ScopedRateThrottle

from . import otp_service, whatsapp_service
from .audit_utils import _get_ip
from .jwt_utils import sign_token
from .models import EmployeeOtp, WhatsAppSettings
from .serializers import employee_full_name
from .view_common import error_response as _error


def _identifier(data) -> str:
    return str(data.get("employeeCode") or data.get("identifier") or "").strip()


def _otp_error(exc: otp_service.OtpError) -> Response:
    return Response({"error": exc.message, **exc.extra}, status=exc.status)


@api_view(["GET"])
def login_options(request: Request) -> Response:
    """Which sign-in methods the apps should offer. OTP is only advertised when
    it can actually work (switched on AND WhatsApp configured on this server)."""
    settings = WhatsAppSettings.get()
    available = whatsapp_service.is_configured()
    return Response(
        {
            "otpLogin": bool(settings.otp_login_enabled and available),
            "otpReset": bool(settings.otp_reset_enabled and available),
            # A new employee must confirm a WhatsApp code before choosing a password.
            "otpActivate": bool(settings.otp_activate_enabled and available),
            # Never lock everyone out: if OTP can't work, password login stays.
            "passwordLogin": bool(settings.password_login_enabled or not (settings.otp_login_enabled and available)),
        }
    )


@api_view(["POST"])
@throttle_classes([ScopedRateThrottle])
def otp_request(request: Request) -> Response:
    request.throttle_scope = "otp_request"
    purpose = str(request.data.get("purpose") or EmployeeOtp.PURPOSE_LOGIN)
    try:
        result = otp_service.request_otp(_identifier(request.data), purpose, _get_ip(request))
    except otp_service.OtpError as exc:
        return _otp_error(exc)
    return Response({"message": "We've sent a code to your WhatsApp.", **result})


@api_view(["POST"])
@throttle_classes([ScopedRateThrottle])
def otp_login(request: Request) -> Response:
    request.throttle_scope = "otp_verify"
    try:
        employee = otp_service.verify_otp(_identifier(request.data), request.data.get("otp"), EmployeeOtp.PURPOSE_LOGIN)
    except otp_service.OtpError as exc:
        return _otp_error(exc)

    # Same bookkeeping and response shape as a password login (auth_views.employee_login).
    employee.last_mobile_login_at = timezone.now()
    employee.save(update_fields=["last_mobile_login_at", "updated_at"])
    name = employee_full_name(employee)
    token = sign_token({"role": "employee", "employeeId": employee.id, "name": name})
    return Response({"token": token, "role": "employee", "employeeId": employee.id, "name": name})


@api_view(["POST"])
@throttle_classes([ScopedRateThrottle])
def otp_reset_password(request: Request) -> Response:
    request.throttle_scope = "otp_verify"
    password = request.data.get("password") or ""
    if len(password) < 8:
        return _error("Password must be at least 8 characters.")
    try:
        employee = otp_service.verify_otp(_identifier(request.data), request.data.get("otp"), EmployeeOtp.PURPOSE_RESET)
    except otp_service.OtpError as exc:
        return _otp_error(exc)

    employee.password_hash = bcrypt.hashpw(password.encode(), bcrypt.gensalt(rounds=10)).decode()
    employee.password_updated_at = timezone.now()
    employee.save(update_fields=["password_hash", "password_updated_at", "updated_at"])
    otp_service.invalidate_all(employee)
    return Response({"message": "Password updated. You can now sign in."})


@api_view(["POST"])
@throttle_classes([ScopedRateThrottle])
def otp_activate(request: Request) -> Response:
    """First-time password: only after the employee has confirmed the WhatsApp
    code sent to the number HR registered for them."""
    request.throttle_scope = "otp_verify"
    password = request.data.get("password") or ""
    if len(password) < 8:
        return _error("Password must be at least 8 characters.")
    try:
        employee = otp_service.verify_otp(
            _identifier(request.data), request.data.get("otp"), EmployeeOtp.PURPOSE_ACTIVATE
        )
    except otp_service.OtpError as exc:
        return _otp_error(exc)
    if employee.password_hash:
        # Someone set one between asking for the code and using it.
        return _error("This account already has a password. Please sign in, or use Forgot password.", 409)

    employee.password_hash = bcrypt.hashpw(password.encode(), bcrypt.gensalt(rounds=10)).decode()
    employee.password_updated_at = timezone.now()
    employee.save(update_fields=["password_hash", "password_updated_at", "updated_at"])
    otp_service.invalidate_all(employee)
    return Response({"message": "Password set. You can now sign in."})

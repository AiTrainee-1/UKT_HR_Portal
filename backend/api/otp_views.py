"""
Employee sign-in and password reset by one-time code (mobile app + Employee Web
App), delivered by WhatsApp (switched on at WhatsApp Control) or SMS (switched on
at SMS Control): two independent channels, either one alone is enough.
Public endpoints under /api/auth/ -the employee has no token yet- so
they are rate limited per IP here, and per employee inside otp_service.

    GET  /api/auth/login-options        which sign-in methods work right now (never cached):
                                        {otpLogin, otpReset, otpActivate, passwordLogin,
                                         otpChannels: {login: ["whatsapp", "sms"], reset: [...], activate: [...]},
                                         channels: {whatsapp: {name, codeLength: 6}, sms: {name, codeLength: 4}},
                                         otpChannel, codeLength}   (the last two for older apps: the first channel)
    POST /api/auth/otp/request          {employeeCode, purpose: "login"|"reset"|"activate", channel?: "whatsapp"|"sms"}
                                        -> {message, maskedPhone, expiresInSeconds, resendAfterSeconds, channel,
                                            codeLength, otherChannels}
                                        no channel: the first available one; a channel that is not available:
                                        400 {error, code: "channel_unavailable", availableChannels}
    POST /api/auth/otp/login            {employeeCode, otp}
    POST /api/auth/otp/reset-password   {employeeCode, otp, password}
    POST /api/auth/otp/activate         {employeeCode, otp, password}   (first-time password)
"""

import bcrypt
from django.utils import timezone
from rest_framework.decorators import api_view
from rest_framework.request import Request
from rest_framework.response import Response

from . import otp_service
from .audit_utils import _get_ip
from .models import EmployeeOtp
from .throttles import throttle
from .view_common import error_response as _error


def _identifier(data) -> str:
    return str(data.get("employeeCode") or data.get("identifier") or "").strip()


def _json_object(request: Request):
    """The JSON object the client sent, or None when it sent anything else (an array, a string, a number, null: a 400
    like any other malformed request, never a 500)."""
    data = request.data
    return data if isinstance(data, dict) else None


_BAD_BODY = "Send the request as a JSON object."


def _password_problem(password) -> str | None:
    """Why this new password is refused, or None. Checked BEFORE the code is used: a bad password must never burn the
    code (and a value that is not text, e.g. a list, must never reach the hashing)."""
    if not otp_service.is_plain_text(password):
        return "Enter a valid password."
    if len(password) < 8:
        return "Password must be at least 8 characters."
    return None


def _otp_error(exc: otp_service.OtpError) -> Response:
    return Response({"error": exc.message, **exc.extra}, status=exc.status)


@api_view(["GET"])
def login_options(request: Request) -> Response:
    """Which sign-in methods the apps should offer, per purpose and channel. A channel is only listed when it can
    actually work (switched on AND able to deliver from this server). Never cached: a switch HR flips on a Control page
    must reach the apps at once. See otp_service.login_options."""
    response = Response(otp_service.login_options())
    response["Cache-Control"] = "no-store"
    return response


@api_view(["POST"])
@throttle("otp_request")
def otp_request(request: Request) -> Response:
    data = _json_object(request)
    if data is None:
        return _error(_BAD_BODY)
    purpose = str(data.get("purpose") or EmployeeOtp.PURPOSE_LOGIN)
    channel = data.get("channel")
    if channel == "":
        channel = None  # an app that sends an empty channel means "whichever works"
    try:
        result = otp_service.request_otp(_identifier(data), purpose, _get_ip(request), channel=channel)
    except otp_service.OtpError as exc:
        return _otp_error(exc)
    # result: message (names the channel), maskedPhone, expiresInSeconds, resendAfterSeconds, channel, codeLength,
    # otherChannels
    return Response(result)


@api_view(["POST"])
@throttle("otp_verify")
def otp_login(request: Request) -> Response:
    data = _json_object(request)
    if data is None:
        return _error(_BAD_BODY)
    try:
        employee = otp_service.verify_otp(_identifier(data), data.get("otp"), EmployeeOtp.PURPOSE_LOGIN)
    except otp_service.OtpError as exc:
        return _otp_error(exc)

    # Same bookkeeping and response shape as a password login (auth_views.employee_login).
    employee.last_mobile_login_at = timezone.now()
    employee.save(update_fields=["last_mobile_login_at", "updated_at"])
    # A revocable session that lasts until the employee signs out (employee_sessions.py), not a 7-day token.
    from . import employee_sessions

    token = employee_sessions.issue_token(request, employee)
    # {token, role, employeeId, name} plus the additive accountStatus / employeeStatus (owner 2026-11-25). A code is only
    # ever sent to an active employee (otp_service.find_employee), so this says "active" in practice.
    # A browser also keeps the session in an HttpOnly cookie, so the web app does not ask for a new code (owner 2026-11-25).
    return employee_sessions.remember_browser(Response(employee_sessions.sign_in_json(employee, token)), request, token)


@api_view(["POST"])
@throttle("otp_verify")
def otp_reset_password(request: Request) -> Response:
    data = _json_object(request)
    if data is None:
        return _error(_BAD_BODY)
    password = data.get("password") or ""
    problem = _password_problem(password)
    if problem:
        return _error(problem)
    try:
        employee = otp_service.verify_otp(_identifier(data), data.get("otp"), EmployeeOtp.PURPOSE_RESET)
    except otp_service.OtpError as exc:
        return _otp_error(exc)

    employee.password_hash = bcrypt.hashpw(password.encode(), bcrypt.gensalt(rounds=10)).decode()
    employee.password_updated_at = timezone.now()
    employee.save(update_fields=["password_hash", "password_updated_at", "updated_at"])
    otp_service.invalidate_all(employee)
    return Response({"message": "Password updated. You can now sign in."})


@api_view(["POST"])
@throttle("otp_verify")
def otp_activate(request: Request) -> Response:
    """First-time password: only after the employee has confirmed the code
    sent to the number HR registered for them."""
    data = _json_object(request)
    if data is None:
        return _error(_BAD_BODY)
    password = data.get("password") or ""
    problem = _password_problem(password)
    if problem:
        return _error(problem)
    try:
        employee = otp_service.verify_otp(_identifier(data), data.get("otp"), EmployeeOtp.PURPOSE_ACTIVATE)
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

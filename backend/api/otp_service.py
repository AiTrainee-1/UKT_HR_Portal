"""
WhatsApp one-time passcodes for the employee apps (mobile app + Employee Web
App): sign in with an Employee Code, reset a forgotten password, or confirm a
new employee's first password ("activate").

Security properties, each covered by tests_otp.py:
  * Codes are 6 random digits from `secrets`, valid for a few minutes
    (WhatsAppSettings.otp_expiry_minutes) and usable exactly once.
  * Only a salted HMAC of the code is stored -never the code- so a database
    read or backup can't be turned into a login. The message log stores the
    text with the code redacted.
  * At most MAX_ATTEMPTS wrong guesses per code, then it is dead.
  * A new request kills every earlier unused code of the same purpose, so only
    the latest message works.
  * Requests are rate limited per employee (resend cooldown + hourly cap) on
    top of the per-IP throttle on the endpoints.
  * A code issued for one purpose can't be used for another.
"""

import hashlib
import hmac
import secrets
from datetime import timedelta

from django.conf import settings as dj_settings
from django.db import transaction
from django.utils import timezone

from . import whatsapp_service
from .models import Employee, EmployeeOtp, WhatsAppSettings

OTP_LENGTH = 6
RESEND_COOLDOWN_SECONDS = 60
MAX_REQUESTS_PER_HOUR = 5
MAX_ATTEMPTS = 5

_TYPE_FOR_PURPOSE = {
    EmployeeOtp.PURPOSE_LOGIN: "otp_login",
    EmployeeOtp.PURPOSE_RESET: "otp_reset",
    EmployeeOtp.PURPOSE_ACTIVATE: "otp_activate",
}
_SWITCH_FOR_PURPOSE = {
    EmployeeOtp.PURPOSE_LOGIN: "otp_login_enabled",
    EmployeeOtp.PURPOSE_RESET: "otp_reset_enabled",
    EmployeeOtp.PURPOSE_ACTIVATE: "otp_activate_enabled",
}


def activation_required() -> bool:
    """True when a first-time password must be confirmed with a WhatsApp code.
    Only while that can really work (switched on AND WhatsApp configured on this
    server); otherwise the old open first-time setup stays, so nobody is locked out."""
    return bool(WhatsAppSettings.get().otp_activate_enabled and whatsapp_service.is_configured())


class OtpError(Exception):
    """A refusal the API should report as-is. `status` is the HTTP status."""

    def __init__(self, message: str, status: int = 400, **extra):
        super().__init__(message)
        self.message = message
        self.status = status
        self.extra = extra


def mask_phone(phone: str) -> str:
    digits = "".join(ch for ch in phone if ch.isdigit())
    return f"{'•' * max(0, len(digits) - 4)}{digits[-4:]}" if digits else ""


def _hash(code: str, salt: str, employee_id: int, purpose: str) -> str:
    key = dj_settings.SECRET_KEY.encode()
    digest = hmac.new(key, f"{salt}:{purpose}:{employee_id}:{code}".encode(), hashlib.sha256).hexdigest()
    return f"{salt}${digest}"


def _matches(stored: str, code: str, employee_id: int, purpose: str) -> bool:
    salt = stored.split("$", 1)[0]
    return hmac.compare_digest(stored, _hash(code, salt, employee_id, purpose))


def find_employee(identifier: str | None) -> Employee:
    identifier = (identifier or "").strip()
    if not identifier:
        raise OtpError("Enter your Employee Code.")
    employee = Employee.objects.filter(employee_code__iexact=identifier).first()
    if employee is None:
        raise OtpError("You are not registered. Please contact HR.", 404)
    if employee.status != "active":
        raise OtpError("This account is not active. Please contact HR.", 403)
    return employee


def request_otp(identifier: str | None, purpose: str, ip: str = "") -> dict:
    """Create a code and WhatsApp it to the employee's registered number."""
    if purpose not in _TYPE_FOR_PURPOSE:
        raise OtpError("Unknown purpose.")
    settings = WhatsAppSettings.get()
    if not getattr(settings, _SWITCH_FOR_PURPOSE[purpose]):
        raise OtpError(
            "WhatsApp OTP is turned off. Please use your password or contact HR.",
            403,
        )
    if not whatsapp_service.is_configured():
        raise OtpError("WhatsApp OTP isn't available right now. Please contact HR.", 503)

    employee = find_employee(identifier)
    if purpose == EmployeeOtp.PURPOSE_ACTIVATE and employee.password_hash:
        raise OtpError("This account already has a password. Please sign in, or use Forgot password.", 409)
    phone = whatsapp_service.normalize_phone(employee.phone)
    if not phone:
        raise OtpError("No mobile number is registered for this employee. Please contact HR.", 400)

    now = timezone.now()
    recent = EmployeeOtp.objects.filter(employee=employee, purpose=purpose)
    latest = recent.first()
    if latest is not None:
        wait = RESEND_COOLDOWN_SECONDS - int((now - latest.created_at).total_seconds())
        if wait > 0:
            raise OtpError(f"Please wait {wait} seconds before asking for another code.", 429, retryAfterSeconds=wait)
    if recent.filter(created_at__gte=now - timedelta(hours=1)).count() >= MAX_REQUESTS_PER_HOUR:
        raise OtpError("Too many codes requested. Please try again in an hour, or contact HR.", 429)

    code = "".join(secrets.choice("0123456789") for _ in range(OTP_LENGTH))
    salt = secrets.token_hex(8)
    minutes = max(1, int(settings.otp_expiry_minutes))
    with transaction.atomic():
        # Only the newest message may work.
        recent.filter(consumed_at__isnull=True).update(consumed_at=now)
        otp = EmployeeOtp.objects.create(
            employee=employee,
            purpose=purpose,
            code_hash=_hash(code, salt, employee.id, purpose),
            phone_number=phone,
            expires_at=now + timedelta(minutes=minutes),
            requested_ip=ip or "",
        )

    log = whatsapp_service.send_notification(
        employee,
        _TYPE_FOR_PURPOSE[purpose],
        [code, str(minutes)],
        log_params=["••••••", str(minutes)],
        asynchronous=False,
    )
    if log is None or log.status == "failed":
        # Nothing usable reached the employee, so this code must not stay valid
        # (and shouldn't count against their hourly allowance).
        otp.delete()
        raise OtpError("We couldn't send the code on WhatsApp. Please try again in a moment or contact HR.", 502)

    return {
        "maskedPhone": mask_phone(phone),
        "expiresInSeconds": minutes * 60,
        "resendAfterSeconds": RESEND_COOLDOWN_SECONDS,
    }


def verify_otp(identifier: str | None, code: str | None, purpose: str) -> Employee:
    """Check a code and consume it. Returns the employee, or raises OtpError.
    Every failure a guesser could learn from is reported as the same generic
    "incorrect or expired" message."""
    if purpose not in _TYPE_FOR_PURPOSE:
        raise OtpError("Unknown purpose.")
    code = (code or "").strip()
    generic = OtpError("That code is incorrect or has expired. Please request a new one.", 400)
    if not code.isdigit() or len(code) != OTP_LENGTH:
        raise OtpError(f"Enter the {OTP_LENGTH}-digit code.")
    employee = Employee.objects.filter(employee_code__iexact=(identifier or "").strip(), status="active").first()
    if employee is None:
        raise generic

    # The outcome is decided inside the transaction but the error is raised
    # AFTER it commits: raising inside would roll back the incremented attempt
    # counter, which would make guessing unlimited.
    outcome = "invalid"
    with transaction.atomic():
        otp = (
            EmployeeOtp.objects.select_for_update()
            .filter(employee=employee, purpose=purpose, consumed_at__isnull=True, expires_at__gt=timezone.now())
            .first()
        )
        if otp is not None:
            otp.attempts += 1
            if otp.attempts > MAX_ATTEMPTS:
                otp.consumed_at = timezone.now()
                otp.save(update_fields=["attempts", "consumed_at"])
                outcome = "locked"
            elif _matches(otp.code_hash, code, employee.id, purpose):
                otp.consumed_at = timezone.now()
                otp.save(update_fields=["attempts", "consumed_at"])
                outcome = "ok"
            else:
                otp.save(update_fields=["attempts"])
    if outcome == "locked":
        raise OtpError("Too many wrong attempts. Please request a new code.", 429)
    if outcome != "ok":
        raise generic
    return employee


def invalidate_all(employee: Employee) -> None:
    """Kill every unused code (used after a password reset)."""
    EmployeeOtp.objects.filter(employee=employee, consumed_at__isnull=True).update(consumed_at=timezone.now())

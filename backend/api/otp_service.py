"""
One-time passcodes for the employee apps (mobile app + Employee Web App): sign
in with an Employee Code, reset a forgotten password, or confirm a new
employee's first password ("activate"). The code is delivered by ONE channel at
a time, chosen on the SMS Control page (SmsSettings.otp_channel): WhatsApp
(WAClient, the default and the original behaviour) or SMS (2Factor, sms_service.py).
Everything below the delivery step -generation, hashing, expiry, single use,
attempt limit, purpose binding- is shared by both channels.

Security properties, each covered by tests_otp.py (WhatsApp) and
tests_sms_otp.py (SMS):
  * Codes are 6 random digits from `secrets`, valid for a few minutes
    (the active channel's expiry setting) and usable exactly once.
  * Only a salted HMAC of the code is stored -never the code- so a database
    read or backup can't be turned into a login. The message logs store the
    text with the code redacted (WhatsApp) or no text at all (SMS).
  * At most the channel's attempt limit of wrong guesses per code, then it is dead.
  * A new request kills every earlier unused code of the same purpose, so only
    the latest message works -but only once the new code was really sent: a send
    that fails (or is blocked by a limit) deletes the new row and leaves the
    employee's previous code valid, so nobody can make a victim's code die by
    making a send fail.
  * One request per employee at a time: the cooldown / hourly check and the
    creation of the new code run under a lock on the employee row, so twelve
    simultaneous requests send one message.
  * Requests are rate limited per employee (resend cooldown + hourly cap) on
    top of the per-IP throttle on the endpoints; the SMS channel adds a
    per-phone-number cap, global hourly/daily caps and a circuit breaker
    (sms_service.py).
  * A code issued for one purpose can't be used for another.

While the channel is 'whatsapp' every limit, switch and sentence is exactly what
it was before the SMS channel existed.
"""

import hashlib
import hmac
import secrets
from dataclasses import dataclass
from datetime import timedelta

from django.conf import settings as dj_settings
from django.db import transaction
from django.utils import timezone

from . import sms_service, whatsapp_service
from .models import Employee, EmployeeOtp, SmsSettings, WhatsAppSettings

OTP_LENGTH = 6
RESEND_COOLDOWN_SECONDS = 60
MAX_REQUESTS_PER_HOUR = 5
MAX_ATTEMPTS = 5

CHANNEL_WHATSAPP = SmsSettings.CHANNEL_WHATSAPP
CHANNEL_SMS = SmsSettings.CHANNEL_SMS
_CHANNEL_NAME = {CHANNEL_WHATSAPP: "WhatsApp", CHANNEL_SMS: "SMS"}

_TYPE_FOR_PURPOSE = {
    EmployeeOtp.PURPOSE_LOGIN: "otp_login",
    EmployeeOtp.PURPOSE_RESET: "otp_reset",
    EmployeeOtp.PURPOSE_ACTIVATE: "otp_activate",
}


@dataclass(frozen=True)
class OtpConfig:
    """The settings one request works with, resolved ONCE for the active channel: which channel, its three switches and
    its limits. For WhatsApp these are the WhatsAppSettings switches/expiry and the module constants above, for SMS the
    SmsSettings values."""

    channel: str
    login_enabled: bool
    reset_enabled: bool
    activate_enabled: bool
    expiry_minutes: int
    resend_cooldown_seconds: int
    max_requests_per_hour: int
    max_attempts_per_code: int
    password_login_enabled: bool  # always WhatsAppSettings.password_login_enabled: one switch for both channels

    @property
    def name(self) -> str:
        """The channel as people read it: 'WhatsApp' or 'SMS'."""
        return _CHANNEL_NAME[self.channel]

    def enabled_for(self, purpose: str) -> bool:
        """Is this purpose's switch on (login_enabled / reset_enabled / activate_enabled)?"""
        return bool(getattr(self, f"{purpose}_enabled"))

    def available(self, purpose: str | None = None) -> bool:
        """Can this channel deliver a code from this server (configured AND allowed to send)? A LONG-TERM fact: it says
        nothing about a cap or the circuit breaker (see paused_now)."""
        if self.channel == CHANNEL_SMS:
            return sms_service.is_available(purpose)
        return whatsapp_service.is_configured()

    def paused_now(self) -> bool:
        """Is the channel configured but unable to send for the moment (SMS: the circuit breaker is paused or a global
        hourly / daily cap is used up)? Anybody can bring this about with a flood of code requests, so it must never
        close another sign-in method: password sign-in stays open while it is true (see password_login_block_message and
        login_options). WhatsApp has no such state."""
        return self.channel == CHANNEL_SMS and sms_service.temporarily_unavailable()


def resolve() -> OtpConfig:
    """The active channel's settings (see OtpConfig)."""
    sms = SmsSettings.get()
    wa = WhatsAppSettings.get()
    if sms.otp_channel == CHANNEL_SMS:
        return OtpConfig(
            channel=CHANNEL_SMS,
            login_enabled=sms.otp_login_enabled,
            reset_enabled=sms.otp_reset_enabled,
            activate_enabled=sms.otp_activate_enabled,
            expiry_minutes=sms.otp_expiry_minutes,
            resend_cooldown_seconds=sms.resend_cooldown_seconds,
            max_requests_per_hour=sms.max_requests_per_hour,
            max_attempts_per_code=sms.max_attempts_per_code,
            password_login_enabled=wa.password_login_enabled,
        )
    return OtpConfig(
        channel=CHANNEL_WHATSAPP,
        login_enabled=wa.otp_login_enabled,
        reset_enabled=wa.otp_reset_enabled,
        activate_enabled=wa.otp_activate_enabled,
        expiry_minutes=wa.otp_expiry_minutes,
        resend_cooldown_seconds=RESEND_COOLDOWN_SECONDS,
        max_requests_per_hour=MAX_REQUESTS_PER_HOUR,
        max_attempts_per_code=MAX_ATTEMPTS,
        password_login_enabled=wa.password_login_enabled,
    )


def activation_required() -> bool:
    """True when a first-time password must be confirmed with a code (sent by the active channel).
    Only while that can really work (switched on AND the channel configured on this
    server); otherwise the old open first-time setup stays, so nobody is locked out."""
    cfg = resolve()
    return bool(cfg.activate_enabled and cfg.available(EmployeeOtp.PURPOSE_ACTIVATE))


def activation_message() -> str:
    """What set-password tells a stranger who must confirm a code first (names the active channel)."""
    if resolve().channel == CHANNEL_SMS:
        return "Please confirm the code we send by SMS to your registered mobile number to set your password."
    return "Please confirm the code we send to your registered WhatsApp number to set your password."


def password_login_block_message() -> str | None:
    """The refusal for a password sign-in when HR has switched password login off while code sign-in really works,
    else None. (Never locks everyone out: when code sign-in can't work -not configured, or paused / capped for the
    moment (paused_now)- password login stays open.)"""
    cfg = resolve()
    if (
        not cfg.password_login_enabled
        and cfg.login_enabled
        and cfg.available(EmployeeOtp.PURPOSE_LOGIN)
        and not cfg.paused_now()
    ):
        article = "an" if cfg.channel == CHANNEL_SMS else "a"
        return f"Password sign-in is turned off. Please sign in with {article} {cfg.name} code."
    return None


def login_options() -> dict:
    """Which sign-in methods the apps should offer. A code method is only advertised when it can actually work
    (switched on AND the ACTIVE channel configured and allowed to send on this server); `otpChannel` says which
    channel that is ('sms' | 'whatsapp') so the apps can name it."""
    cfg = resolve()
    login = bool(cfg.login_enabled and cfg.available(EmployeeOtp.PURPOSE_LOGIN))
    return {
        "otpLogin": login,
        "otpReset": bool(cfg.reset_enabled and cfg.available(EmployeeOtp.PURPOSE_RESET)),
        # A new employee must confirm a code before choosing a password.
        "otpActivate": bool(cfg.activate_enabled and cfg.available(EmployeeOtp.PURPOSE_ACTIVATE)),
        # Never lock everyone out: if code sign-in can't work -not configured, or paused / capped for the moment-
        # password login stays. (The code methods above stay advertised while merely paused: they come back by
        # themselves and a request meanwhile gets the plain "temporarily unavailable" sentence.)
        "passwordLogin": bool(cfg.password_login_enabled or not login or cfg.paused_now()),
        "otpChannel": cfg.channel,
    }


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


def is_plain_text(value) -> bool:
    """Text a person could have typed: a string without a NUL byte (PostgreSQL refuses a NUL in a query: a 500)."""
    return isinstance(value, str) and "\x00" not in value


def find_employee(identifier: str | None) -> Employee:
    identifier = (identifier or "").strip()
    if not identifier or not is_plain_text(identifier):
        raise OtpError("Enter your Employee Code.")
    employee = Employee.objects.filter(employee_code__iexact=identifier).first()
    if employee is None:
        raise OtpError("You are not registered. Please contact HR.", 404)
    if employee.status != "active":
        raise OtpError("This account is not active. Please contact HR.", 403)
    return employee


def request_otp(identifier: str | None, purpose: str, ip: str = "") -> dict:
    """Create a code and send it, by the active channel (WhatsApp or SMS), to the employee's registered number.
    Returns {message, maskedPhone, expiresInSeconds, resendAfterSeconds, channel}."""
    if purpose not in _TYPE_FOR_PURPOSE:
        raise OtpError("Unknown purpose.")
    cfg = resolve()
    if not cfg.enabled_for(purpose):
        raise OtpError(
            f"{cfg.name} OTP is turned off. Please use your password or contact HR.",
            403,
        )
    if not cfg.available(purpose):
        raise OtpError(f"{cfg.name} OTP isn't available right now. Please contact HR.", 503)

    employee = find_employee(identifier)
    if purpose == EmployeeOtp.PURPOSE_ACTIVATE and employee.password_hash:
        raise OtpError("This account already has a password. Please sign in, or use Forgot password.", 409)
    phone = whatsapp_service.normalize_phone(employee.phone)
    if not phone:
        raise OtpError("No mobile number is registered for this employee. Please contact HR.", 400)
    if cfg.channel == CHANNEL_SMS and not sms_service.is_valid_number(phone):
        # refused before anything is created or requested: a landline or a half-typed number
        raise OtpError(sms_service.MSG_BAD_NUMBER, 400)

    code = "".join(secrets.choice("0123456789") for _ in range(OTP_LENGTH))
    salt = secrets.token_hex(8)
    minutes = max(1, int(cfg.expiry_minutes))
    with transaction.atomic():
        # One request per employee at a time: the cooldown / hourly check and the creation of the new code happen under
        # a lock on the employee row, so simultaneous requests cannot all pass the check and send a message each (the
        # second one waits here, then sees the first one's new code and its cooldown). The lock is released at the end of
        # this block, BEFORE the (slow) send.
        if Employee.objects.select_for_update().filter(pk=employee.pk).first() is None:
            raise OtpError("You are not registered. Please contact HR.", 404)
        now = timezone.now()  # taken after the lock: a request that had to wait must not compute with an old clock
        recent = EmployeeOtp.objects.filter(employee=employee, purpose=purpose)
        latest = recent.first()
        if latest is not None:
            wait = cfg.resend_cooldown_seconds - int((now - latest.created_at).total_seconds())
            if wait > 0:
                raise OtpError(
                    f"Please wait {wait} seconds before asking for another code.", 429, retryAfterSeconds=wait
                )
        if recent.filter(created_at__gte=now - timedelta(hours=1)).count() >= cfg.max_requests_per_hour:
            raise OtpError("Too many codes requested. Please try again in an hour, or contact HR.", 429)
        # The new code is only ADDED here. The earlier codes are consumed after the send succeeded (below): consuming
        # them first meant that a send that failed or was blocked killed the employee's still-valid code.
        otp = EmployeeOtp.objects.create(
            employee=employee,
            purpose=purpose,
            code_hash=_hash(code, salt, employee.id, purpose),
            phone_number=phone,
            expires_at=now + timedelta(minutes=minutes),
            requested_ip=ip or "",
        )

    if cfg.channel == CHANNEL_SMS:
        sent = sms_service.send_otp(employee, purpose, code, minutes, phone=phone, ip=ip)
        if not sent.ok:
            # Nothing usable reached the employee (or a limit stopped the send): same rule as WhatsApp below. The new
            # row goes; the employee's previous code, if any, stays valid.
            otp.delete()
            raise OtpError(sent.message, sent.http_status)
        message = f"We've sent a code by SMS to {mask_phone(phone)}."
    else:
        log = whatsapp_service.send_notification(
            employee,
            _TYPE_FOR_PURPOSE[purpose],
            [code, str(minutes)],
            log_params=["••••••", str(minutes)],
            asynchronous=False,
        )
        if log is None or log.status == "failed":
            # Nothing usable reached the employee, so this code must not stay valid
            # (and shouldn't count against their hourly allowance); the previous one stays valid.
            otp.delete()
            raise OtpError("We couldn't send the code on WhatsApp. Please try again in a moment or contact HR.", 502)
        message = "We've sent a code to your WhatsApp."

    # Only the newest message may work: now that it really went out, the earlier codes die.
    EmployeeOtp.objects.filter(employee=employee, purpose=purpose, consumed_at__isnull=True).exclude(pk=otp.pk).update(
        consumed_at=timezone.now()
    )

    return {
        "message": message,
        "maskedPhone": mask_phone(phone),
        "expiresInSeconds": minutes * 60,
        "resendAfterSeconds": cfg.resend_cooldown_seconds,
        "channel": cfg.channel,
    }


def verify_otp(identifier: str | None, code: str | None, purpose: str) -> Employee:
    """Check a code and consume it. Returns the employee, or raises OtpError.
    Every failure a guesser could learn from is reported as the same generic
    "incorrect or expired" message."""
    if purpose not in _TYPE_FOR_PURPOSE:
        raise OtpError("Unknown purpose.")
    generic = OtpError("That code is incorrect or has expired. Please request a new one.", 400)
    # the code is JSON from the client: a number, a list ... is a 400 like any other malformed code, never a 500
    code = code.strip() if isinstance(code, str) else ""
    if not (code.isascii() and code.isdigit()) or len(code) != OTP_LENGTH:
        raise OtpError(f"Enter the {OTP_LENGTH}-digit code.")
    identifier = (identifier or "").strip()
    if not is_plain_text(identifier):
        raise generic
    employee = Employee.objects.filter(employee_code__iexact=identifier, status="active").first()
    if employee is None:
        raise generic

    # The outcome is decided inside the transaction but the error is raised
    # AFTER it commits: raising inside would roll back the incremented attempt
    # counter, which would make guessing unlimited.
    outcome = "invalid"
    max_attempts = resolve().max_attempts_per_code
    with transaction.atomic():
        otp = (
            EmployeeOtp.objects.select_for_update()
            .filter(employee=employee, purpose=purpose, consumed_at__isnull=True, expires_at__gt=timezone.now())
            .first()
        )
        if otp is not None:
            otp.attempts += 1
            if otp.attempts > max_attempts:
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

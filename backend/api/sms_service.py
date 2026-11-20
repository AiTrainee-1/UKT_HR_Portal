"""
SMS delivery of one-time codes (2Factor.in) -the one place the rest of the HRMS sends an SMS through
==================================================================================================
    otp_service.request_otp -> send_otp() -> twofactor_client.send_otp() -> 2Factor -> the employee's phone
    SMS Control page "Test"  -> send_test() -> send_otp() ----^

SMS IS FOR ONE-TIME CODES ONLY (owner, 2026-11-20): sign-in, password reset and account activation codes through the
approved OTP template. send_otp() is the only way an SMS leaves the system (the Control page's test is a code through the
same template), it carries nothing but 4 to 6 digits, and there is no function for free text, promotions, bulk messages
or notifications. tests_sms_otp.SmsIsOnlyForCodesTests pins that no other module calls the 2Factor client.

The code itself is generated and verified by otp_service (an HMAC is stored, never the code); this module only carries
it. Every attempt ends up as a SmsMessageLog row that HR sees on the SMS Control page: "sent", "failed" (2Factor or the
network refused it) or "blocked" (a limit stopped it before anything left). A row never holds the code, the text, the
auth key or a full phone number. Nothing here raises for an expected failure.

Protections, all counted from the log so they hold across server workers and restarts:
  * not configured / not allowed to send on this machine -> nothing is attempted (see sending_block_reason)
  * LOCAL DEVELOPMENT ONLY: `manage.py runserver` texts only the employees named in SMS_ONLY_TO_EMPLOYEES (exactly like
    WHATSAPP_ONLY_TO_EMPLOYEES for WhatsApp; none named = nothing is sent; a local fake 2Factor of the e2e stack is
    exempt). Production never runs runserver, so the variable is ignored there (see local_dev_server)
  * circuit breaker: BREAKER_FAILURES failed sends within BREAKER_WINDOW pause SMS for BREAKER_PAUSE, so a dead
    provider or a wrong key is not hammered and employees are told to use their password. Only failures that say
    something about the PROVIDER count: a refused number or an unrecognised refusal of one message (error codes
    "number" / "rejected", PER_RECIPIENT_ERRORS) is one employee's problem and must not pause SMS for everybody.
  * global hourly (rolling) and daily (IST calendar day) caps on the SMS the system sends: cost and abuse protection
  * a per-NUMBER hourly cap (two employee records sharing a number cannot multiply it)
  (the per-employee resend cooldown / hourly allowance and the per-IP throttle live in otp_service / the views)

temporarily_unavailable() says whether the breaker is paused or a global cap is used up: otp_service uses it to keep
password sign-in open while the codes cannot be sent (an anonymous caller can use a global cap up, and that must never
lock employees out). The log keeps at most one 'blocked' row per employee per reason per minute (BLOCKED_ROW_WINDOW),
so a flood of refused requests cannot fill the table.

The check and the reservation of the send happen together under a row lock (SELECT ... FOR UPDATE on the settings row),
and the log row is written as "sent" BEFORE the call and corrected to "failed" afterwards, so two simultaneous requests
can never both slip under the same cap, and a crash in the middle leaves the send counted (the safe direction).
"""

import hashlib
import hmac
import logging
import os
import re
import sys
from dataclasses import dataclass
from datetime import datetime, time as time_type, timedelta
from decimal import Decimal
from urllib.parse import urlparse

from django.conf import settings as dj_settings
from django.core.cache import cache
from django.db import DatabaseError, transaction
from django.utils import timezone

from . import twofactor_client, whatsapp_service
from .clock import FACTORY_TZ
from .models import SmsMessageLog, SmsSettings

logger = logging.getLogger(__name__)

#: what twofactor_client raises for a send 2Factor (or the network) did not accept
SEND_ERRORS = (twofactor_client.TwoFactorError,)

PURPOSES = ("login", "reset", "activate")

BREAKER_FAILURES = 3
BREAKER_WINDOW = timedelta(minutes=10)
BREAKER_PAUSE = timedelta(minutes=10)
#: failures that are about one recipient / one message, not about the provider: they never pause SMS for everybody
PER_RECIPIENT_ERRORS = ("number", "rejected")
#: a refused request writes a 'blocked' log row at most once per employee per reason within this window
BLOCKED_ROW_WINDOW = timedelta(minutes=1)
#: the dummy code of the SMS Control page's test message
TEST_CODE = "1234"

# What the person asking for a code is told (plain sentences; the apps show them as they are).
MSG_UNAVAILABLE = "SMS OTP isn't available right now. Please contact HR."
MSG_TEMPORARILY_UNAVAILABLE = "SMS is temporarily unavailable. Please use your password or contact HR."
MSG_PHONE_CAP = "Too many codes were sent to this number. Please try again in an hour, or contact HR."
MSG_SEND_FAILED = "We couldn't send the code by SMS. Please try again in a moment or contact HR."
MSG_BAD_NUMBER = "The mobile number registered for this employee isn't a valid mobile number. Please contact HR."

MSG_NOT_A_CODE = "Only one-time codes (4 to 6 digits) can be sent by SMS."
#: what a refused recipient is told on a development machine (SMS_ONLY_TO_EMPLOYEES); the words never start like a
#: provider failure, and the row is 'blocked', so it never pauses SMS for everybody
DEV_SAFETY = "Not sent (development safety)"

BALANCE_NOT_SET_UP = "2Factor is not set up on this server, so the balance cannot be checked."
BALANCE_EMPTY_NOTE = (
    "2Factor refused the last message because the account has no balance. Top it up in the 2Factor panel."
)
#: the balance is read from 2Factor at most once per BALANCE_CACHE_SECONDS (the overview polls)
BALANCE_CACHE_SECONDS = 300
#: fewer credits than this shows a "top up soon" alert on the SMS Control page
LOW_BALANCE_CREDITS = 100
#: rupees per SMS for the cost estimate until HR sets their own (SMS Control -> Settings -> Cost)
DEFAULT_PRICE_PER_SMS = Decimal("0.20")

# What marks a value as the demo text of .env.example rather than a credential (all compared in lower case):
_PLACEHOLDER_STARTS = ("your_", "your-", "your ", "demo")
_PLACEHOLDER_WORDS = ("yourkey", "replace_me", "replace-me", "replaceme", "changeme", "xxx", "todo")
# "here" only as a whole token ("put-it-here", "key_here", "here_goes_the_key", "paste...here"): a real key may well
# contain the letters (there, where, adheres, ...), and refusing it would silently stop SMS for good
_PLACEHOLDER_HERE = ("_here", "-here", "here_", "...here")
_ANGLE_BRACKETS = re.compile(r"<[^<>]*>")


# ── configuration ───────────────────────────────────────────────────────────


def _setting(name: str) -> str:
    return str(getattr(dj_settings, name, "") or "").strip()


def looks_like_placeholder(value) -> bool:
    """True for an empty value and for the demo text shipped in .env.example: your_ / your- / demo at the start,
    yourkey / replace_me / changeme / xxx / todo anywhere, <anything in angle brackets>, and 'here' as a whole token
    (_here, -here, here_, ...here). A placeholder must never be mistaken for a real credential; a real key that merely
    contains the letters 'here' (there, where) is one."""
    low = str(value or "").strip().lower()
    return (
        not low
        or low.startswith(_PLACEHOLDER_STARTS)
        or any(word in low for word in _PLACEHOLDER_WORDS)
        or any(token in low for token in _PLACEHOLDER_HERE)
        or bool(_ANGLE_BRACKETS.search(low))
    )


def auth_key() -> str:
    """The 2Factor API key, '' when empty or still the placeholder."""
    key = _setting("TWOFACTOR_API_KEY")
    return "" if looks_like_placeholder(key) else key


def sender_id() -> str:
    """The DLT sender header (informational: 2Factor takes the sender from the template), '' when unset."""
    value = _setting("TWOFACTOR_SENDER_ID")
    return "" if looks_like_placeholder(value) else value


def api_base() -> str:
    return _setting("TWOFACTOR_API_BASE").rstrip("/")


def template_name() -> str:
    """The approved template's NAME (one template for every purpose), '' when empty or still the placeholder."""
    name = _setting("TWOFACTOR_TEMPLATE_NAME")
    return "" if looks_like_placeholder(name) else name


def config_problems() -> list[str]:
    """What is missing or still a placeholder, as short phrases (empty = configured). Never quotes a value."""
    problems = []
    key = auth_key()
    if not key:
        problems.append("TWOFACTOR_API_KEY is empty or still the placeholder value")
    elif twofactor_client.key_problem(key):
        problems.append(twofactor_client.key_problem(key))
    name = template_name()
    if not name:
        problems.append("TWOFACTOR_TEMPLATE_NAME is empty or still the placeholder value")
    elif twofactor_client.template_problem(name):
        problems.append(twofactor_client.template_problem(name))
    base = twofactor_client.base_url_problem(api_base())
    if base:
        problems.append(base.rstrip("."))
    return problems


def is_configured() -> bool:
    """Key and template present and real (not the placeholders). Says nothing about whether this machine may send: see
    sending_allowed."""
    return not config_problems()


def sending_allowed() -> bool:
    """May this machine send SMS? On a real server yes; on a development machine no, unless SMS_ALLOW_SENDING=true says
    otherwise: the same rule as whatsapp_service.sending_allowed (see config/settings.py for why)."""
    forced = getattr(dj_settings, "SMS_ALLOW_SENDING", None)
    if forced is not None:
        return bool(forced)
    return not dj_settings.DEBUG and "runserver" not in sys.argv


def local_dev_server() -> bool:
    """Is this Django's own development server (`manage.py runserver`) on a developer's machine? The ONLY place the
    SMS_ONLY_TO_EMPLOYEES recipient lock applies (the same rule as WhatsApp's WHATSAPP_ONLY_TO_EMPLOYEES). Production never
    runs runserver (gunicorn on Railway, waitress on-premise), and Railway's own variables rule it out a second time.
    DEBUG is deliberately NOT a sign: a misconfigured DEBUG=true on the live server must never limit its codes."""
    if os.environ.get("RAILWAY_ENVIRONMENT") or os.environ.get("RAILWAY_ENVIRONMENT_NAME"):
        return False
    return "runserver" in sys.argv


def provider_is_local() -> bool:
    """Is TWOFACTOR_API_BASE on this machine (the e2e stack's fake 2Factor)? Such a provider reaches nobody."""
    try:
        host = (urlparse(api_base()).hostname or "").lower()
    except ValueError:
        return False
    return host in ("localhost", "127.0.0.1", "::1")


def recipient_codes() -> list[str]:
    """The employee codes the local development server may text (SMS_ONLY_TO_EMPLOYEES). Always [] anywhere else."""
    if not local_dev_server():
        return []
    return [str(c).strip() for c in (getattr(dj_settings, "SMS_ONLY_TO_EMPLOYEES", None) or []) if str(c).strip()]


def allowed_numbers() -> set[str] | None:
    """The normalised numbers this machine may text, or None when there is no limit (a real server; or the e2e stack's
    local fake 2Factor with nobody named). A development machine otherwise always has a limit: an empty set when nobody
    is named, so nothing is sent."""
    if not local_dev_server():
        return None
    codes = recipient_codes()
    if not codes and provider_is_local():
        return None
    from .models import Employee

    phones = Employee.objects.filter(employee_code__in=codes).values_list("phone", flat=True)
    return {n for n in (normalize_phone(p) for p in phones) if n}


def recipient_block_reason(number: str | None) -> str | None:
    """Why this (normalised) number may not be texted from this machine, or None."""
    allowed = allowed_numbers()
    if allowed is None or (number or "") in allowed:
        return None
    codes = ", ".join(recipient_codes()) or "none set"
    return f"{DEV_SAFETY}: this machine may only text employee {codes} (SMS_ONLY_TO_EMPLOYEES)."


def sending_block_reason(purpose: str | None = None) -> str | None:
    """Why nothing can be sent from here, or None when it can. (`purpose` is kept for the callers: one template serves
    every purpose.)"""
    problems = config_problems()
    if problems:
        return f"SMS is not set up on this server: {'; '.join(problems)} (set them in the server's .env)."
    if not sending_allowed():
        return (
            "SMS sending is switched off on this machine because it is a development setup (DEBUG on or runserver), "
            "so it can't text employees from the live account. Set SMS_ALLOW_SENDING=true to override."
        )
    if local_dev_server() and not recipient_codes() and not provider_is_local():
        return (
            "This development machine may send SMS only to the employees named in SMS_ONLY_TO_EMPLOYEES (for example "
            "SMS_ONLY_TO_EMPLOYEES=30020), and none is named, so nothing is sent."
        )
    return None


def is_available(purpose: str | None = None) -> bool:
    """Configured AND allowed to send: what the apps are told when they ask which sign-in methods work."""
    return sending_block_reason(purpose) is None


# ── phone numbers ───────────────────────────────────────────────────────────


def is_valid_number(digits: str | None) -> bool:
    """Is this normalised number (digits, international) one we should text? It must belong to SMS_COUNTRY_CODE and,
    for India (91), be a 10-digit mobile number starting 6-9: a landline or a half-typed number is refused before any
    request. (Other countries: a national part of 6 to 12 digits.)"""
    if not digits or not digits.isascii() or not digits.isdigit():
        return False
    country = _setting("SMS_COUNTRY_CODE") or "91"
    if not digits.startswith(country):
        return False
    national = digits[len(country) :]
    if country == "91":
        return len(national) == 10 and national[0] in "6789"
    return 6 <= len(national) <= 12 and len(digits) <= 15


def normalize_phone(raw: str | None) -> str | None:
    """The number as 2Factor wants it (digits, international, no '+'), or None when there is nothing valid to text. The
    cleaning is whatsapp_service.normalize_phone's, so both channels agree on what a number is."""
    number = whatsapp_service.normalize_phone(raw)
    return number if is_valid_number(number) else None


def mask_phone(phone: str) -> str:
    digits = "".join(ch for ch in phone if ch.isdigit())
    return f"{'•' * max(0, len(digits) - 4)}{digits[-4:]}" if digits else ""


def phone_hash(number: str) -> str:
    """A keyed hash of the normalised number: the log counts per number with it and never stores the number."""
    return hmac.new(dj_settings.SECRET_KEY.encode(), f"sms-phone:{number}".encode(), hashlib.sha256).hexdigest()


# ── what the limits are counting ────────────────────────────────────────────


def _day_start(now: datetime) -> datetime:
    return datetime.combine(now.astimezone(FACTORY_TZ).date(), time_type.min, tzinfo=FACTORY_TZ)


def usage(now: datetime | None = None) -> dict:
    """SMS the system has sent in the last rolling hour and since IST midnight (a send counts from the moment it is
    attempted; a failed one stops counting)."""
    now = now or timezone.now()
    sent = SmsMessageLog.objects.filter(status=SmsMessageLog.STATUS_SENT)
    return {
        "hourUsed": sent.filter(created_at__gte=now - timedelta(hours=1)).count(),
        "dayUsed": sent.filter(created_at__gte=_day_start(now)).count(),
    }


def circuit(now: datetime | None = None) -> tuple[bool, datetime | None]:
    """(paused, until): SMS is paused for BREAKER_PAUSE after BREAKER_FAILURES failed sends within BREAKER_WINDOW.
    Failures about one recipient or one message (PER_RECIPIENT_ERRORS) are not counted: a bad number must not be able to
    pause SMS for everybody."""
    now = now or timezone.now()
    recent = list(
        SmsMessageLog.objects.filter(status=SmsMessageLog.STATUS_FAILED, created_at__gte=now - BREAKER_WINDOW)
        .exclude(error_code__in=PER_RECIPIENT_ERRORS)
        .order_by("-created_at")
        .values_list("created_at", flat=True)[:BREAKER_FAILURES]
    )
    if len(recent) < BREAKER_FAILURES:
        return False, None
    until = recent[0] + BREAKER_PAUSE
    return (True, until) if until > now else (False, None)


def temporarily_unavailable(now: datetime | None = None) -> bool:
    """Can the system not send an SMS RIGHT NOW although it is configured: the circuit breaker is paused, or the global
    hourly or daily cap is used up? The answer is temporary and anybody can bring it about (a flood of code requests
    uses a cap up), so it must never close another sign-in method: otp_service keeps password sign-in open while this
    is true."""
    return pause_reason(now) is not None


def pause_reason(now: datetime | None = None) -> str | None:
    """Why SMS cannot be sent at this moment although it is configured (the breaker is paused, or the global hourly /
    daily cap is used up), as one sentence for HR; None when nothing pauses it."""
    now = now or timezone.now()
    paused, until = circuit(now)
    if paused:
        clock = until.astimezone(FACTORY_TZ).strftime("%H:%M")
        minutes = int(BREAKER_WINDOW.total_seconds() // 60)
        return f"SMS sending is paused until {clock} (IST) because {BREAKER_FAILURES} sends failed within {minutes} minutes."
    cfg = SmsSettings.get()
    used = usage(now)
    if used["hourUsed"] >= cfg.hourly_cap:
        return f"The hourly limit of {cfg.hourly_cap} SMS is used up."
    if used["dayUsed"] >= cfg.daily_cap:
        return f"The daily limit of {cfg.daily_cap} SMS is used up (it starts again at midnight IST)."
    return None


def price_per_sms(s: SmsSettings | None = None) -> Decimal:
    """Rupees per SMS for the cost estimate: what HR set on SMS Control, else DEFAULT_PRICE_PER_SMS."""
    value = (s or SmsSettings.get()).price_per_sms
    return Decimal(value) if value is not None else DEFAULT_PRICE_PER_SMS


def _balance_cache_key() -> str:
    # a different key or address is a different account: never show one account's balance for another
    fingerprint = hashlib.sha256(f"{auth_key()}|{api_base()}".encode()).hexdigest()[:16]
    return f"sms_control:twofactor_balance:{fingerprint}"


def balance(*, refresh: bool = False) -> dict:
    """The SMS credits left on the 2Factor account, read from 2Factor at most once per BALANCE_CACHE_SECONDS (a read:
    nothing is sent). {"credits": number | None, "available": the same (older pages read it), "checkedAt": ISO time |
    None, "error": one sentence | None}. Never raises; never carries the key. `refresh` skips the cache."""
    if config_problems():
        return {"credits": None, "available": None, "checkedAt": None, "error": BALANCE_NOT_SET_UP}
    key = _balance_cache_key()
    entry = None if refresh else cache.get(key)
    if not isinstance(entry, dict):
        checked = timezone.now().isoformat()
        try:
            credits = twofactor_client.balance(api_key=auth_key(), base_url=api_base())
            entry = {"credits": credits, "checkedAt": checked, "error": None}
        except twofactor_client.TwoFactorError as exc:
            entry = {"credits": None, "checkedAt": checked, "error": f"The balance could not be read: {exc.message}"}
        except Exception as exc:  # a bug must never break the page (and must not log the URL: it holds the key)
            logger.error("2Factor balance check crashed unexpectedly (%s)", type(exc).__name__)
            entry = {
                "credits": None,
                "checkedAt": checked,
                "error": "The balance could not be read because of an unexpected error on this server.",
            }
        cache.set(key, entry, BALANCE_CACHE_SECONDS)
    error = entry.get("error")
    credits = entry.get("credits")
    last = (
        SmsMessageLog.objects.exclude(status=SmsMessageLog.STATUS_BLOCKED)
        .filter(created_at__gte=timezone.now() - timedelta(hours=24))
        .first()
    )
    if (
        last is not None
        and last.status == SmsMessageLog.STATUS_FAILED
        and last.error_code == "balance"
        and not (credits or 0) > 0
    ):
        error = BALANCE_EMPTY_NOTE
    return {"credits": credits, "available": credits, "checkedAt": entry.get("checkedAt"), "error": error}


# ── sending ─────────────────────────────────────────────────────────────────


@dataclass(frozen=True)
class SmsResult:
    """The outcome of one send. `message` is the sentence for the person who asked for the code, `http_status` the status
    the API answers with when not `ok`, `detail` the plain sentence HR sees in the log (empty on success)."""

    ok: bool
    status: str  # sent | failed | blocked
    kind: str  # sent, not_configured, invalid_number, paused, hourly_cap, daily_cap, phone_cap, or the failure kind
    message: str = ""
    http_status: int = 200
    detail: str = ""
    log_id: int | None = None
    masked_phone: str = ""


def _refusal(cfg: SmsSettings, number: str, number_hash: str, now: datetime):
    """(kind, sentence for the person, http status, sentence for HR) when a limit stops this send, else None."""
    locked = recipient_block_reason(number)
    if locked:
        return ("dev_lock", locked, 403, f"Blocked: {locked}")
    paused, until = circuit(now)
    if paused:
        clock = until.astimezone(FACTORY_TZ).strftime("%H:%M")
        minutes = int(BREAKER_WINDOW.total_seconds() // 60)
        return (
            "paused",
            MSG_TEMPORARILY_UNAVAILABLE,
            503,
            f"Blocked: SMS sending is paused until {clock} (IST) because {BREAKER_FAILURES} sends failed within {minutes} minutes.",
        )
    used = usage(now)
    if used["hourUsed"] >= cfg.hourly_cap:
        return (
            "hourly_cap",
            MSG_TEMPORARILY_UNAVAILABLE,
            503,
            f"Blocked: the hourly limit of {cfg.hourly_cap} SMS was reached.",
        )
    if used["dayUsed"] >= cfg.daily_cap:
        return (
            "daily_cap",
            MSG_TEMPORARILY_UNAVAILABLE,
            503,
            f"Blocked: the daily limit of {cfg.daily_cap} SMS was reached.",
        )
    to_this_number = SmsMessageLog.objects.filter(
        phone_hash=number_hash, status=SmsMessageLog.STATUS_SENT, created_at__gte=now - timedelta(hours=1)
    ).count()
    if to_this_number >= cfg.max_per_phone_per_hour:
        return (
            "phone_cap",
            MSG_PHONE_CAP,
            429,
            f"Blocked: this number already received {to_this_number} SMS in the last hour (limit {cfg.max_per_phone_per_hour}).",
        )
    return None


def _finish(log_id: int, status: str, message_id: str = "", error: str = "", error_code: str = "") -> None:
    """Write the outcome onto the row reserved for the send. Never raises (the SMS may already have left)."""
    try:
        SmsMessageLog.objects.filter(pk=log_id).update(
            status=status, provider_message_id=message_id, error=error[:300], error_code=error_code
        )
    except DatabaseError:
        logger.error("Could not record the outcome of SMS log row %s", log_id)


def _deliver(
    *, purpose: str, code: str, minutes: int, number: str, employee=None, sent_by_id=None, ip: str = ""
) -> SmsResult:
    """The pipeline: breaker, caps and the per-number cap are checked and the send is reserved under one lock, then the
    one HTTP call, then the row is corrected. `number` is already normalised and valid."""
    masked = mask_phone(number)
    block = sending_block_reason(purpose)
    if block:
        return SmsResult(
            False, SmsMessageLog.STATUS_FAILED, "not_configured", MSG_UNAVAILABLE, 503, block, None, masked
        )

    cfg = SmsSettings.get()
    now = timezone.now()
    number_hash = phone_hash(number)
    row = dict(
        employee=employee,
        sent_by_id=sent_by_id,
        phone_masked=masked,
        phone_hash=number_hash,
        purpose=purpose,
        requested_ip=(ip or "")[:64],
        created_at=now,
    )
    with transaction.atomic():
        SmsSettings.objects.select_for_update().get(pk=cfg.pk)  # one send decision at a time, across workers
        refused = _refusal(cfg, number, number_hash, now)
        if refused:
            kind, for_person, http_status, for_hr = refused
            # One 'blocked' row per employee per reason per minute is all HR needs to see; a caller who keeps asking
            # while a limit holds must not be able to fill the table (a request with no employee: one per reason).
            already = SmsMessageLog.objects.filter(
                status=SmsMessageLog.STATUS_BLOCKED,
                error_code=kind,
                employee=employee,
                created_at__gte=now - BLOCKED_ROW_WINDOW,
            ).exists()
            log = (
                None
                if already
                else SmsMessageLog.objects.create(
                    status=SmsMessageLog.STATUS_BLOCKED, error=for_hr, error_code=kind, **row
                )
            )
        else:
            log = SmsMessageLog.objects.create(status=SmsMessageLog.STATUS_SENT, **row)
    if refused:
        log_id = log.id if log is not None else None
        return SmsResult(False, SmsMessageLog.STATUS_BLOCKED, kind, for_person, http_status, for_hr, log_id, masked)

    try:
        message_id = twofactor_client.send_otp(
            api_key=auth_key(),
            template_name=template_name(),
            mobile=number,
            code=code,
            base_url=api_base(),
        )
    except SEND_ERRORS as exc:
        _finish(log.id, SmsMessageLog.STATUS_FAILED, error=exc.message, error_code=exc.kind)
        return SmsResult(
            False, SmsMessageLog.STATUS_FAILED, exc.kind, MSG_SEND_FAILED, 502, exc.message, log.id, masked
        )
    except Exception as exc:  # a bug must not 500 the OTP request, and must not log the code
        logger.error("SMS send crashed unexpectedly (%s)", type(exc).__name__)
        detail = "The SMS could not be sent because of an unexpected error on this server."
        _finish(log.id, SmsMessageLog.STATUS_FAILED, error=detail, error_code="unexpected")
        return SmsResult(False, SmsMessageLog.STATUS_FAILED, "unexpected", MSG_SEND_FAILED, 502, detail, log.id, masked)

    _finish(log.id, SmsMessageLog.STATUS_SENT, message_id=message_id)
    return SmsResult(True, SmsMessageLog.STATUS_SENT, "sent", "", 200, "", log.id, masked)


_SEND_PURPOSES = tuple(p for p, _ in SmsMessageLog.PURPOSES)  # login, reset, activate, test


def send_otp(
    employee,
    purpose: str,
    code: str,
    minutes: int,
    *,
    phone: str | None = None,
    ip: str = "",
    sent_by_id: int | None = None,
) -> SmsResult:
    """THE one way an SMS leaves the HRMS: a one-time code (4 to 6 digits, nothing else) through the approved OTP
    template. `phone` is the normalised number (default: the employee's registered one). Returns the outcome; nothing
    here raises. A failed or blocked outcome means the code did not reach the employee: the caller must discard it."""
    if purpose not in _SEND_PURPOSES or not (
        isinstance(code, str) and code.isascii() and code.isdigit() and 4 <= len(code) <= 6
    ):
        return SmsResult(False, SmsMessageLog.STATUS_FAILED, "not_a_code", MSG_NOT_A_CODE, 400, MSG_NOT_A_CODE)
    number = phone or normalize_phone(getattr(employee, "phone", None))
    if not number or not is_valid_number(number):
        return SmsResult(False, SmsMessageLog.STATUS_FAILED, "invalid_number", MSG_BAD_NUMBER, 400, MSG_BAD_NUMBER)
    return _deliver(
        purpose=purpose, code=code, minutes=minutes, number=number, employee=employee, sent_by_id=sent_by_id, ip=ip
    )


def send_test(raw_phone: str | None, sent_by_id: int | None, ip: str = "", *, employee=None) -> SmsResult:
    """The SMS Control page's test: a one-time code (the dummy TEST_CODE) through the same OTP template and send_otp, to
    an employee's registered number (`employee`) or to the number typed (masked in the log, purpose 'test'). Counts
    against the caps and obeys SMS_ONLY_TO_EMPLOYEES like any other send."""
    number = normalize_phone(employee.phone if employee is not None else raw_phone)
    if not number:
        message = (
            "This employee has no valid mobile number registered."
            if employee is not None
            else "Enter a valid mobile number, for example 9876543210."
        )
        return SmsResult(False, SmsMessageLog.STATUS_FAILED, "invalid_number", message, 400, message)
    minutes = max(1, int(SmsSettings.get().otp_expiry_minutes))
    return send_otp(
        employee, SmsMessageLog.PURPOSE_TEST, TEST_CODE, minutes, phone=number, ip=ip, sent_by_id=sent_by_id
    )

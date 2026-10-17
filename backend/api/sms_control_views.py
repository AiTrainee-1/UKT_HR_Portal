"""
SMS Control page (HR portal -> SMS Control): where HR picks how one-time codes are delivered (WhatsApp or SMS through
2Factor), sets the limits, sees what was sent and sends a test. All endpoints are HR-only and sit under the `sms_control`
permission module (see permission_registry.URL_MODULE_MAP): GET needs "view", PUT / POST need "edit".

    GET  /api/sms-control/overview     status cards: channel, configured?, sending allowed?, balance, today, 7 days, limits
    GET  /api/sms-control/settings     channel, switches, expiry and limits, with a `version` and `warnings`
    PUT  /api/sms-control/settings     change them (all-or-nothing, stale guard)
    GET  /api/sms-control/messages     the SMS log (filters + pagination), never a code or a full number
    POST /api/sms-control/test         {"phone": "9876543210"}: one test SMS with the dummy code 123456

Nothing here ever returns, accepts or logs the auth key: it lives in the server's .env only, and the overview says only
whether each value is set. Branch logins see only their own branch's messages; changing the settings and sending a test
are company-wide actions, so a branch login gets 403 {"code": "company_wide_settings"} (reading stays open).

The settings document (GET, and the PUT answer):
  {"otpChannel": "whatsapp" | "sms", "otpLoginEnabled": true, "otpResetEnabled": true, "otpActivateEnabled": true,
   "otpExpiryMinutes": 5, "resendCooldownSeconds": 60, "maxRequestsPerHour": 5, "maxAttemptsPerCode": 5,
   "maxPerPhonePerHour": 5, "hourlyCap": 300, "dailyCap": 1500,
   "version": "9f2c41d07a3b5e68", "updatedAt": "2026-10-17T10:00:00+00:00" | null, "updatedBy": "Asha" | null,
   "warnings": ["..."]}
PUT takes the same body; every key is optional (an omitted one is left alone) and `version` / `updatedAt` / `updatedBy` /
`warnings` are ignored when sent back. Any problem is a 400 {"error": "<one plain sentence>"} and nothing is saved.
SWITCHING THE CHANNEL TO "sms" is refused (400, "SMS cannot be selected until 2Factor is configured on the server:
missing: ...") while 2Factor is not configured on the server: with no way to send a code the system would fall back to
the open first-time password setup, which anyone who knows an employee code could use. Switching back to "whatsapp" is
always allowed, and so is saving other values while the channel stays "sms" (a `warnings` entry then says 2Factor went
missing).
The HR page must show that sentence as it is. Keeping password sign-in switched on (WhatsApp Control) is advised while
SMS is the channel: the system opens password sign-in by itself while SMS cannot send (a limit used up, the breaker
paused), but a switched-off password login is one more thing that can go wrong; `warnings` says so.
`expectedVersion` (the `version` the page loaded) that no longer matches what is saved answers 400
{"error": ..., "code": "stale_settings"}; the settings row is locked (SELECT ... FOR UPDATE) for the whole save, so two
saves at the same moment run one after the other. A save that changes nothing writes nothing (no audit row either).
Ranges: expiry 1..15 minutes, resend cooldown 30..600 seconds, requests per hour 1..20, attempts per code 3..10,
per phone per hour 1..20, hourly cap 1..10000, daily cap 1..10000 (never 0), hourly cap not above the daily cap.
Defaults of a new installation: hourly cap 300, daily cap 1500 (migration 0124; a row saved earlier keeps its numbers).

Audit rows (module `sms_control`): action "update" (old and new values of what changed) and "test" (who sent a test to
which MASKED number). Never a code, never the key.
"""

import hashlib
import json
import math
from datetime import date, datetime, timedelta

from django.db import transaction
from django.db.models import Count, Max, Q
from django.db.models.functions import TruncDate
from django.utils import timezone
from rest_framework.decorators import api_view
from rest_framework.exceptions import ParseError, UnsupportedMediaType
from rest_framework.request import Request
from rest_framework.response import Response

from . import sms_service
from .audit_utils import _get_ip, log_action
from .auth import require_hr
from .branch_scope import get_branch_scope, scope_to_branch
from .clock import FACTORY_TZ
from .models import SmsMessageLog, SmsSettings, WhatsAppSettings

AUDIT_MODULE = "sms_control"
TEST_LIMIT_PER_HOUR = 3

STATUSES = (SmsMessageLog.STATUS_SENT, SmsMessageLog.STATUS_FAILED, SmsMessageLog.STATUS_BLOCKED)
PURPOSES = tuple(p for p, _ in SmsMessageLog.PURPOSES)
DEFAULT_PAGE_SIZE = 50
MAX_PAGE_SIZE = 200

COMPANY_WIDE_MESSAGE = (
    "SMS settings apply to the whole company, so a branch login can read them but not change them or send a test. "
    "Ask an administrator or a head-office login."
)
STALE_VERSION = (
    "The SMS settings were changed by somebody else after this page was loaded: reload the page and make your "
    "change again."
)

CHANNELS = tuple(c for c, _ in SmsSettings.CHANNELS)
# json key, model field
BOOL_FIELDS = (
    ("otpLoginEnabled", "otp_login_enabled"),
    ("otpResetEnabled", "otp_reset_enabled"),
    ("otpActivateEnabled", "otp_activate_enabled"),
)
# json key, model field, label, (min, max)
INT_FIELDS = (
    ("otpExpiryMinutes", "otp_expiry_minutes", "Code expiry (minutes)", (1, 15)),
    ("resendCooldownSeconds", "resend_cooldown_seconds", "Resend cooldown (seconds)", (30, 600)),
    ("maxRequestsPerHour", "max_requests_per_hour", "Codes per employee per hour", (1, 20)),
    ("maxAttemptsPerCode", "max_attempts_per_code", "Wrong attempts per code", (3, 10)),
    ("maxPerPhonePerHour", "max_per_phone_per_hour", "SMS per phone number per hour", (1, 20)),
    ("hourlyCap", "hourly_cap", "Hourly limit on all SMS", (1, 10000)),
    ("dailyCap", "daily_cap", "Daily limit on all SMS", (1, 10000)),
)
# what the audit description calls each setting
_FIELD_LABELS = {
    "otpChannel": "delivery channel",
    "otpLoginEnabled": "OTP login switch",
    "otpResetEnabled": "OTP password reset switch",
    "otpActivateEnabled": "OTP account activation switch",
    "otpExpiryMinutes": "code expiry",
    "resendCooldownSeconds": "resend cooldown",
    "maxRequestsPerHour": "codes per employee per hour",
    "maxAttemptsPerCode": "wrong attempts per code",
    "maxPerPhonePerHour": "SMS per phone number per hour",
    "hourlyCap": "hourly limit",
    "dailyCap": "daily limit",
}


class SettingsError(Exception):
    """A problem with the submitted settings: the message is the one plain sentence the 400 carries."""

    def __init__(self, message: str, code: str | None = None):
        super().__init__(message)
        self.code = code


def _error(message: str, status: int = 400, **extra) -> Response:
    return Response({"error": message, **extra}, status=status)


def _read_body(request: Request):
    """(the JSON object, None), or (None, the 400 / 415 answer): every refusal carries {"error": "<one sentence>"}."""
    try:
        data = request.data
    except UnsupportedMediaType:
        return None, _error("The body must be sent as JSON.", 415)
    except ParseError:
        return None, _error("The body is not valid JSON.")
    except RecursionError:
        return None, _error("The body is nested too deeply to read: send a plain JSON object.")
    if not isinstance(data, dict):
        return None, _error("The body must be a JSON object.")
    return data, None


def _forbid_branch_logins(request: Request):
    if get_branch_scope(request) is not None:
        return Response({"error": COMPANY_WIDE_MESSAGE, "code": "company_wide_settings"}, status=403)
    return None


def _as_int(value):
    """A JSON whole number (5 or 5.0) as an int, else None."""
    if isinstance(value, bool):
        return None
    if isinstance(value, int):
        return value
    if isinstance(value, float) and math.isfinite(value) and value.is_integer():
        return int(value)
    return None


# ── the settings document ───────────────────────────────────────────────────


def _plain(s: SmsSettings) -> dict:
    """The editable values as the document's keys."""
    out = {"otpChannel": s.otp_channel}
    for key, field in BOOL_FIELDS:
        out[key] = bool(getattr(s, field))
    for key, field, _label, _range in INT_FIELDS:
        out[key] = int(getattr(s, field))
    return out


def _version(plain: dict) -> str:
    """A fingerprint of the editable values: it changes whenever anything the PUT can change does."""
    text = json.dumps(plain, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(text.encode()).hexdigest()[:16]


def _warnings(s: SmsSettings) -> list[str]:
    """Advice about what is saved (never blocks a save)."""
    out = []
    if s.otp_channel != SmsSettings.CHANNEL_SMS:
        return out
    if sms_service.config_problems():
        out.append(
            "SMS is selected but 2Factor is not configured: employees will not be able to receive codes "
            "(password login stays)."
        )
    elif not sms_service.sending_allowed():
        out.append(
            "SMS is selected but this server is not allowed to send SMS (it is a development setup): employees will "
            "not be able to receive codes (password login stays)."
        )
    if not (s.otp_login_enabled or s.otp_reset_enabled or s.otp_activate_enabled):
        out.append("All three code switches are off, so employees can only use their password.")
    if not WhatsAppSettings.get().password_login_enabled:
        out.append(
            "Password sign-in is switched off (WhatsApp Control), so SMS is the only way in: keep it on. If SMS stops "
            "working (a limit is used up, 2Factor fails) the system opens password sign-in again by itself until it "
            "works."
        )
    paused, until = sms_service.circuit()
    if paused:
        out.append(
            f"SMS sending is paused until {until.astimezone(FACTORY_TZ):%H:%M} (IST) because 2Factor failed "
            f"{sms_service.BREAKER_FAILURES} times in a row; employees are told to use their password."
        )
    return out


def _body(s: SmsSettings) -> dict:
    plain = _plain(s)
    updated_by = None
    if s.updated_by_id:
        user = s.updated_by
        updated_by = user.full_name or user.username
    return {
        **plain,
        "version": _version(plain),
        "updatedAt": s.updated_at.isoformat() if s.updated_at else None,
        "updatedBy": updated_by,
        "warnings": _warnings(s),
    }


def _parse(data: dict, before: dict) -> dict:
    """The proposed values: what was sent over what is saved. Raises SettingsError (nothing is written)."""
    doc = dict(before)
    if "otpChannel" in data:
        if data["otpChannel"] not in CHANNELS:
            raise SettingsError("The delivery channel must be 'whatsapp' or 'sms'.")
        doc["otpChannel"] = data["otpChannel"]
    for key, _field in BOOL_FIELDS:
        if key in data:
            if not isinstance(data[key], bool):
                raise SettingsError(f"{key} must be true or false.")
            doc[key] = data[key]
    for key, _field, label, (low, high) in INT_FIELDS:
        if key in data:
            value = _as_int(data[key])
            if value is None or not low <= value <= high:
                raise SettingsError(f"{label} must be a whole number between {low} and {high}.")
            doc[key] = value
    if doc["hourlyCap"] > doc["dailyCap"]:
        raise SettingsError(
            f"The hourly limit ({doc['hourlyCap']}) cannot be more than the daily limit ({doc['dailyCap']})."
        )
    return doc


def _model_field(key: str) -> str:
    if key == "otpChannel":
        return "otp_channel"
    for json_key, field, *_rest in (*BOOL_FIELDS, *INT_FIELDS):
        if json_key == key:
            return field
    raise KeyError(key)


@transaction.atomic
def _apply(request: Request, data: dict) -> tuple[dict, dict] | None:
    """Validate and save a PUT body. Raises SettingsError. The settings row is read FOR UPDATE and held until the
    transaction ends, so two saves at the same moment run one after the other. Returns (old values, new values) of
    what changed, or None when nothing did."""
    SmsSettings.get()  # makes sure the row exists
    s = SmsSettings.objects.select_for_update().get(pk=1)
    before = _plain(s)

    expected = data.get("expectedVersion")
    if expected is not None:
        if not isinstance(expected, str):
            raise SettingsError("expectedVersion must be the version text the page loaded.")
        if expected != _version(before):
            raise SettingsError(STALE_VERSION, code="stale_settings")

    proposed = _parse(data, before)
    if proposed["otpChannel"] == SmsSettings.CHANNEL_SMS and before["otpChannel"] != SmsSettings.CHANNEL_SMS:
        # With SMS selected and nothing able to send a code, set-password falls back to its open first-time setup (any
        # unactivated employee code can be taken over), so the switch itself is refused until the server is set up.
        missing = sms_service.config_problems()
        if missing:
            raise SettingsError(
                f"SMS cannot be selected until 2Factor is configured on the server: missing: {'; '.join(missing)}."
            )
    changed = [key for key in proposed if proposed[key] != before[key]]
    if not changed:
        return None
    for key in changed:
        setattr(s, _model_field(key), proposed[key])
    s.updated_at = timezone.now()
    s.updated_by_id = (getattr(request, "jwt_user", {}) or {}).get("hrUserId")
    s.save()
    return {key: before[key] for key in changed}, {key: proposed[key] for key in changed}


@api_view(["GET", "PUT"])
@require_hr
def sms_settings(request: Request) -> Response:
    """GET: the settings document. PUT: save it (see the module docstring)."""
    if request.method == "GET":
        return Response(_body(SmsSettings.get()))

    refusal = _forbid_branch_logins(request)
    if refusal is not None:
        return refusal
    data, refusal = _read_body(request)
    if refusal is not None:
        return refusal
    try:
        changes = _apply(request, data)
    except SettingsError as exc:
        extra = {"code": exc.code} if exc.code else {}
        return _error(str(exc), **extra)
    if changes is not None:
        old_values, new_values = changes
        log_action(
            request,
            "update",
            AUDIT_MODULE,
            description="Changed SMS settings: " + ", ".join(_FIELD_LABELS[key] for key in new_values),
            old_values=old_values,
            new_values=new_values,
        )
    return Response(_body(SmsSettings.objects.select_related("updated_by").get(pk=1)))


# ── overview ────────────────────────────────────────────────────────────────


def _messages_qs(request: Request):
    return scope_to_branch(SmsMessageLog.objects.select_related("employee"), request, field="employee__branch_id")


def _day_start(days_back: int = 0) -> datetime:
    today = timezone.now().astimezone(FACTORY_TZ).date() - timedelta(days=days_back)
    return datetime.combine(today, datetime.min.time(), tzinfo=FACTORY_TZ)


def _counts(qs) -> dict:
    counts = {status: 0 for status in STATUSES}
    for row in qs.values("status").annotate(n=Count("id")):
        counts[row["status"]] = counts.get(row["status"], 0) + row["n"]
    return counts


def _env() -> dict:
    """What the server's .env holds for 2Factor: whether the API key is set (to a real value, not a placeholder; never the
    key itself), the sender id and the template name (not secrets; '' when unset or still the placeholder) and the API
    address."""
    return {
        "authKey": bool(sms_service.auth_key()),
        "senderId": sms_service.sender_id(),
        "templateName": sms_service.template_name(),
        "apiBase": sms_service.api_base(),
    }


def _sending_note() -> str:
    reason = sms_service.sending_block_reason()
    if reason:
        return reason
    return "This server is set up to send SMS."


@api_view(["GET"])
@require_hr
def sms_overview(request: Request) -> Response:
    s = SmsSettings.get()
    qs = _messages_qs(request)

    today = _counts(qs.filter(created_at__gte=_day_start()))

    first_day = _day_start(6)
    per_day: dict = {}
    for row in (
        qs.filter(created_at__gte=first_day, status__in=(SmsMessageLog.STATUS_SENT, SmsMessageLog.STATUS_FAILED))
        .annotate(day=TruncDate("created_at", tzinfo=FACTORY_TZ))
        .values("day", "status")
        .annotate(n=Count("id"))
    ):
        per_day.setdefault(row["day"], {})[row["status"]] = row["n"]
    start = first_day.date()
    last7 = []
    for offset in range(7):
        day = start + timedelta(days=offset)
        counts = per_day.get(day, {})
        last7.append({"date": day.isoformat(), "sent": counts.get("sent", 0), "failed": counts.get("failed", 0)})

    last_sent = qs.filter(status=SmsMessageLog.STATUS_SENT).aggregate(at=Max("created_at"))["at"]
    used = sms_service.usage()
    paused, until = sms_service.circuit()
    return Response(
        {
            "provider": "twofactor",
            "channel": s.otp_channel,
            "configured": sms_service.is_configured(),
            "sendingAllowed": sms_service.sending_allowed(),
            "sendingNote": _sending_note(),
            "env": _env(),
            "balance": sms_service.balance(),
            "today": today,
            "last7Days": last7,
            "lastSentAt": last_sent.isoformat() if last_sent else None,
            "limits": {
                "hourlyCap": s.hourly_cap,
                "dailyCap": s.daily_cap,
                "hourUsed": used["hourUsed"],
                "dayUsed": used["dayUsed"],
            },
            "circuit": {"paused": paused, "until": until.isoformat() if until else None},
        }
    )


# ── messages ────────────────────────────────────────────────────────────────


def _item(m: SmsMessageLog) -> dict:
    emp = m.employee
    if emp is not None:
        name, code = f"{emp.first_name} {emp.last_name}".strip(), emp.employee_code
    else:
        name, code = ("Test message" if m.purpose == SmsMessageLog.PURPOSE_TEST else ""), ""
    return {
        "id": m.id,
        "at": m.created_at.isoformat(),
        "employeeId": m.employee_id,
        "employeeName": name,
        "employeeCode": code,
        "maskedPhone": m.phone_masked,
        "purpose": m.purpose,
        "status": m.status,
        "error": m.error,
        "providerMessageId": m.provider_message_id,
        "ip": m.requested_ip,
    }


@api_view(["GET"])
@require_hr
def sms_messages(request: Request) -> Response:
    """The SMS log, newest first. Filters: status, purpose, search (employee name / code, or the last digits of the
    masked number), dateFrom, dateTo (YYYY-MM-DD, IST). `statusCounts` counts every status under the OTHER filters (so
    the status tabs show how many each would list)."""
    q = request.query_params
    qs = _messages_qs(request)
    status = q.get("status")
    if status and status not in STATUSES:
        return _error(f"status must be one of: {', '.join(STATUSES)}")
    purpose = q.get("purpose")
    if purpose:
        if purpose not in PURPOSES:
            return _error(f"purpose must be one of: {', '.join(PURPOSES)}")
        qs = qs.filter(purpose=purpose)
    if search := (q.get("search") or "").strip()[:100]:
        qs = qs.filter(
            Q(employee__first_name__icontains=search)
            | Q(employee__last_name__icontains=search)
            | Q(employee__employee_code__icontains=search)
            | Q(phone_masked__icontains=search)
        )
    for param, op in (("dateFrom", "gte"), ("dateTo", "lt")):
        if raw := q.get(param):
            try:
                day = date.fromisoformat(raw)
            except ValueError:
                return _error(f"{param} must be YYYY-MM-DD")
            if op == "lt":
                day += timedelta(days=1)
            qs = qs.filter(**{f"created_at__{op}": datetime.combine(day, datetime.min.time(), tzinfo=FACTORY_TZ)})
    try:
        page = max(1, int(q.get("page", 1)))
        page_size = max(1, min(MAX_PAGE_SIZE, int(q.get("pageSize", DEFAULT_PAGE_SIZE))))
    except (TypeError, ValueError):
        return _error("page and pageSize must be numbers")

    status_counts = _counts(qs)
    if status:
        qs = qs.filter(status=status)
    qs = qs.order_by("-created_at", "-id")
    start = (page - 1) * page_size
    return Response(
        {
            "items": [_item(m) for m in qs[start : start + page_size]],
            "total": qs.count(),
            "page": page,
            "pageSize": page_size,
            "statusCounts": status_counts,
        }
    )


# ── test ────────────────────────────────────────────────────────────────────


def _test_answer(ok: bool, message: str, status: int = 200) -> Response:
    """The test endpoint's answer. A refusal that is an HTTP error carries `error` as well, like the rest of the API."""
    body = {"ok": ok, "message": message}
    if status >= 400:
        body["error"] = message
    return Response(body, status=status)


@api_view(["POST"])
@require_hr
def sms_test(request: Request) -> Response:
    """Send ONE test SMS (the real template, the dummy code 123456) to the number given. Answers 200 {"ok", "message"}
    for everything that is about the send itself (accepted, refused by 2Factor, not configured, a limit); 400 for a
    number that is not a number, 429 after TEST_LIMIT_PER_HOUR tests in an hour by this HR user, 403 for a branch
    login."""
    if get_branch_scope(request) is not None:
        body = {"ok": False, "message": COMPANY_WIDE_MESSAGE, "error": COMPANY_WIDE_MESSAGE}
        return Response({**body, "code": "company_wide_settings"}, status=403)
    data, refusal = _read_body(request)
    if refusal is not None:
        return refusal
    phone = data.get("phone")
    if not isinstance(phone, str) or not phone.strip() or len(phone) > 40:
        return _test_answer(False, "Enter the mobile number to send the test to, for example 9876543210.", 400)
    if sms_service.normalize_phone(phone) is None:
        return _test_answer(False, "Enter a valid mobile number, for example 9876543210.", 400)

    user_id = (getattr(request, "jwt_user", {}) or {}).get("hrUserId")
    recent = SmsMessageLog.objects.filter(
        purpose=SmsMessageLog.PURPOSE_TEST, sent_by_id=user_id, created_at__gte=timezone.now() - timedelta(hours=1)
    ).count()
    if recent >= TEST_LIMIT_PER_HOUR:
        return _test_answer(
            False, f"You can send {TEST_LIMIT_PER_HOUR} test messages per hour. Please try again later.", 429
        )

    block = sms_service.sending_block_reason(SmsMessageLog.PURPOSE_TEST)
    if block:
        return _test_answer(False, block)

    result = sms_service.send_test(phone, user_id, _get_ip(request) or "")
    if result.log_id is not None:
        outcome = {"sent": "", "failed": " (2Factor refused it)", "blocked": " (stopped by a limit)"}[result.status]
        log_action(request, "test", AUDIT_MODULE, description=f"Sent a test SMS to {result.masked_phone}{outcome}")
    if result.ok:
        return _test_answer(
            True,
            f"2Factor accepted the test SMS for {result.masked_phone}. It normally arrives within a minute; "
            "if it does not, check the number and the DLT template.",
        )
    if result.status == SmsMessageLog.STATUS_FAILED and result.kind != "not_configured":
        return _test_answer(False, f"The test SMS was not sent. {result.detail}")
    return _test_answer(False, result.detail or result.message)

"""
SMS Control page (HR portal -> SMS Control): the central control of SMS in the HRMS. SMS is used ONLY for one-time codes
(sign-in, password reset, account activation) through 2Factor.in. SMS codes are switched on here, independently of
WhatsApp codes (switched on at WhatsApp Control): either one alone is enough, and the apps follow both at once
(GET /api/auth/login-options is never cached). All endpoints are HR-only and sit under the `sms_control` permission module
(see permission_registry.URL_MODULE_MAP): GET needs "view", PUT / PATCH / POST need "edit".

    GET  /api/sms-control/overview          status, balance, this month's numbers and cost, the caps, alerts
    GET  /api/sms-control/usage?month=YYYY-MM   one month: per day, per purpose, cost and projection, balance
    GET  /api/sms-control/settings          switches, expiry and limits, cost settings, with a `version` and `warnings`
    PUT  /api/sms-control/settings          change them (all-or-nothing, stale guard); PATCH is the same
    GET  /api/sms-control/messages          the SMS log (filters + pagination), never a code or a full number
    POST /api/sms-control/test              {"employeeCode": "30020"} or {"phone": "9876543210"}: one TEST code (1234)
                                            through the OTP template (there is no free text anywhere)

Nothing here ever returns, accepts or logs the auth key: it lives in the server's .env only, and the overview says only
whether each value is set. Branch logins see only their own branch's messages and numbers; changing the settings and
sending a test are company-wide actions, so a branch login gets 403 {"code": "company_wide_settings"} (reading stays open).

The settings document (GET, and the PUT / PATCH answer):
  {"otpEnabled": false, "otpLoginEnabled": true, "otpResetEnabled": true, "otpActivateEnabled": true,
   "otpExpiryMinutes": 5, "resendCooldownSeconds": 60, "maxRequestsPerHour": 5, "maxAttemptsPerCode": 5,
   "maxPerPhonePerHour": 5, "hourlyCap": 300, "dailyCap": 1500, "pricePerSms": 0.2, "monthlyBudget": null,
   "pricePerSmsDefault": 0.2,
   "version": "9f2c41d07a3b5e68", "updatedAt": "2026-10-17T10:00:00+00:00" | null, "updatedBy": "Asha" | null,
   "warnings": ["..."]}
PUT / PATCH take the same body; every key is optional (an omitted one is left alone) and `version` / `updatedAt` /
`updatedBy` / `warnings` / `pricePerSmsDefault` are ignored when sent back. Any problem is a 400 {"error": "<one plain
sentence>"} and nothing is saved. `otpChannel` (the one-channel switch of before 2026-11-20) is refused with a 400: SMS and
WhatsApp codes are now switched on separately. `pricePerSms` null goes back to the default (DEFAULT_PRICE_PER_SMS),
`monthlyBudget` null means no budget.
SWITCHING SMS CODES ON is refused (400, "SMS codes cannot be switched on until 2Factor is configured on the server:
missing: ...") while 2Factor is not configured on the server. Switching them off is always allowed, and so is saving other
values while they stay on (a `warnings` entry then says 2Factor went missing).
`expectedVersion` (the `version` the page loaded) that no longer matches what is saved answers 400
{"error": ..., "code": "stale_settings"}; the settings row is locked (SELECT ... FOR UPDATE) for the whole save, so two
saves at the same moment run one after the other. A save that changes nothing writes nothing (no audit row either).
Ranges: expiry 1..15 minutes, resend cooldown 30..600 seconds, requests per hour 1..20, attempts per code 3..5,
per phone per hour 1..20, hourly cap 1..10000, daily cap 1..10000 (never 0), hourly cap not above the daily cap,
price per SMS 0..100 rupees, monthly budget 0..10 000 000 rupees.

Numbers on the overview and the usage page (one IST month): requested = every logged attempt (sent + failed + blocked),
sent = accepted by 2Factor (what costs money; test messages included), verified = SMS codes employees really used in time
(otp_service.verified_codes), deliveryRate = sent / (sent + failed) and verifiedRate = verified / codes sent to employees,
both percentages with one decimal (null when there is nothing to divide). cost.soFar = sent x price per SMS; projected =
soFar / elapsed days x days in the month for the current month (a past month: its actual total).

Audit rows (module `sms_control`): action "update" (old and new values of what changed) and "test" (who sent a test to
which MASKED number). Never a code, never the key.
"""

import calendar
import hashlib
import json
import math
from datetime import date, datetime, timedelta
from decimal import ROUND_HALF_UP, Decimal

from django.db import transaction
from django.db.models import Count, Max, Q
from django.db.models.functions import TruncDate
from django.utils import timezone
from rest_framework.decorators import api_view
from rest_framework.exceptions import ParseError, UnsupportedMediaType
from rest_framework.request import Request
from rest_framework.response import Response

from . import otp_service, sms_service
from .audit_utils import _get_ip, log_action
from .auth import require_hr
from .branch_scope import get_branch_scope, scope_to_branch
from .clock import FACTORY_TZ
from .models import Employee, SmsMessageLog, SmsSettings, WhatsAppSettings

AUDIT_MODULE = "sms_control"
TEST_LIMIT_PER_HOUR = 3

STATUSES = (SmsMessageLog.STATUS_SENT, SmsMessageLog.STATUS_FAILED, SmsMessageLog.STATUS_BLOCKED)
PURPOSES = tuple(p for p, _ in SmsMessageLog.PURPOSES)
OTP_PURPOSES = (SmsMessageLog.PURPOSE_LOGIN, SmsMessageLog.PURPOSE_RESET, SmsMessageLog.PURPOSE_ACTIVATE)
DEFAULT_PAGE_SIZE = 50
MAX_PAGE_SIZE = 200
CURRENCY = "INR"
#: a cap used at least this much (percent) shows a warning on the overview
CAP_WARNING_PCT = 80

COMPANY_WIDE_MESSAGE = (
    "SMS settings apply to the whole company, so a branch login can read them but not change them or send a test. "
    "Ask an administrator or a head-office login."
)
STALE_VERSION = (
    "The SMS settings were changed by somebody else after this page was loaded: reload the page and make your "
    "change again."
)
CHANNEL_RETIRED = (
    "SMS and WhatsApp codes are now switched on separately: use the SMS codes switch here (otpEnabled) and the "
    "WhatsApp codes switch on WhatsApp Control."
)

# json key, model field
BOOL_FIELDS = (
    ("otpEnabled", "otp_enabled"),
    ("otpLoginEnabled", "otp_login_enabled"),
    ("otpResetEnabled", "otp_reset_enabled"),
    ("otpActivateEnabled", "otp_activate_enabled"),
)
# json key, model field, label, (min, max)
INT_FIELDS = (
    ("otpExpiryMinutes", "otp_expiry_minutes", "Code expiry (minutes)", (1, 15)),
    ("resendCooldownSeconds", "resend_cooldown_seconds", "Resend cooldown (seconds)", (30, 600)),
    ("maxRequestsPerHour", "max_requests_per_hour", "Codes per employee per hour", (1, 20)),
    ("maxAttemptsPerCode", "max_attempts_per_code", "Wrong attempts per code", (3, 5)),
    ("maxPerPhonePerHour", "max_per_phone_per_hour", "SMS per phone number per hour", (1, 20)),
    ("hourlyCap", "hourly_cap", "Hourly limit on all SMS", (1, 10000)),
    ("dailyCap", "daily_cap", "Daily limit on all SMS", (1, 10000)),
)
# json key, model field, label, (min, max), decimal places, may be null
MONEY_FIELDS = (
    ("pricePerSms", "price_per_sms", "Price per SMS (rupees)", (0, 100), 4),
    ("monthlyBudget", "monthly_budget", "Monthly budget (rupees)", (0, 10_000_000), 2),
)
# what the audit description calls each setting
_FIELD_LABELS = {
    "otpEnabled": "SMS codes switch",
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
    "pricePerSms": "price per SMS",
    "monthlyBudget": "monthly budget",
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


def _as_number(value):
    """A JSON number (not a bool, not NaN / infinite) as a float, else None."""
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    number = float(value)
    return number if math.isfinite(number) else None


def _money(value) -> float:
    """Rupees rounded to 2 decimals, as a JSON number."""
    return float(Decimal(value).quantize(Decimal("0.01"), rounding=ROUND_HALF_UP))


def _pct(part, whole) -> float | None:
    """part / whole as a percentage with one decimal, None when whole is 0."""
    return round(float(part) * 100 / float(whole), 1) if whole else None


# ── the settings document ───────────────────────────────────────────────────


def _plain(s: SmsSettings) -> dict:
    """The editable values as the document's keys (the price is the one in use: HR's, else the default)."""
    out = {}
    for key, field in BOOL_FIELDS:
        out[key] = bool(getattr(s, field))
    for key, field, _label, _range in INT_FIELDS:
        out[key] = int(getattr(s, field))
    out["pricePerSms"] = float(sms_service.price_per_sms(s))
    out["monthlyBudget"] = float(s.monthly_budget) if s.monthly_budget is not None else None
    return out


def _version(plain: dict) -> str:
    """A fingerprint of the editable values: it changes whenever anything the PUT can change does."""
    text = json.dumps(plain, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(text.encode()).hexdigest()[:16]


def _warnings(s: SmsSettings) -> list[str]:
    """Advice about what is saved (never blocks a save)."""
    out = []
    if not s.otp_enabled:
        return out
    if sms_service.config_problems():
        out.append(
            "SMS codes are switched on but 2Factor is not configured: employees will not get codes by SMS "
            "(password login stays)."
        )
    else:
        reason = sms_service.sending_block_reason()
        if reason:
            out.append(f"SMS codes are switched on but this server cannot send them: {reason}")
    if not (s.otp_login_enabled or s.otp_reset_enabled or s.otp_activate_enabled):
        out.append("SMS codes are switched on but all three code switches are off, so no SMS is sent.")
    if not WhatsAppSettings.get().password_login_enabled:
        out.append(
            "Password sign-in is switched off (WhatsApp Control): keep at least one code channel working. If no code can "
            "be sent (a limit is used up, 2Factor fails) the system opens password sign-in again by itself until it works."
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
        "pricePerSmsDefault": float(sms_service.DEFAULT_PRICE_PER_SMS),
        "version": _version(plain),
        "updatedAt": s.updated_at.isoformat() if s.updated_at else None,
        "updatedBy": updated_by,
        "warnings": _warnings(s),
    }


def _parse(data: dict, before: dict) -> dict:
    """The proposed values: what was sent over what is saved. Raises SettingsError (nothing is written)."""
    if "otpChannel" in data:
        raise SettingsError(CHANNEL_RETIRED)
    doc = dict(before)
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
    for key, _field, label, (low, high), places in MONEY_FIELDS:
        if key in data:
            if data[key] is None:
                doc[key] = float(sms_service.DEFAULT_PRICE_PER_SMS) if key == "pricePerSms" else None
                continue
            value = _as_number(data[key])
            if value is None or not low <= value <= high:
                extra = "" if key == "pricePerSms" else " (or empty for no budget)"
                raise SettingsError(f"{label} must be a number between {low} and {high:,}{extra}.")
            doc[key] = round(value, places)
    if doc["hourlyCap"] > doc["dailyCap"]:
        raise SettingsError(
            f"The hourly limit ({doc['hourlyCap']}) cannot be more than the daily limit ({doc['dailyCap']})."
        )
    return doc


def _model_value(key: str, value):
    """(model field, value to store) for a document key."""
    for json_key, field in BOOL_FIELDS:
        if json_key == key:
            return field, value
    for json_key, field, *_rest in INT_FIELDS:
        if json_key == key:
            return field, value
    for json_key, field, _label, _range, places in MONEY_FIELDS:
        if json_key == key:
            return field, (None if value is None else Decimal(str(value)).quantize(Decimal(1).scaleb(-places)))
    raise KeyError(key)


@transaction.atomic
def _apply(request: Request, data: dict) -> tuple[dict, dict] | None:
    """Validate and save a PUT / PATCH body. Raises SettingsError. The settings row is read FOR UPDATE and held until the
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
    if proposed["otpEnabled"] and not before["otpEnabled"]:
        # With SMS codes on and nothing able to send them the apps would offer nothing by SMS anyway; refusing the switch
        # makes HR set 2Factor up first instead of believing SMS codes work.
        missing = sms_service.config_problems()
        if missing:
            raise SettingsError(
                f"SMS codes cannot be switched on until 2Factor is configured on the server: missing: {'; '.join(missing)}."
            )
    changed = [key for key in proposed if proposed[key] != before[key]]
    if not changed:
        return None
    for key in changed:
        field, value = _model_value(key, proposed[key])
        setattr(s, field, value)
    s.updated_at = timezone.now()
    s.updated_by_id = (getattr(request, "jwt_user", {}) or {}).get("hrUserId")
    s.save()
    return {key: before[key] for key in changed}, {key: proposed[key] for key in changed}


@api_view(["GET", "PUT", "PATCH"])
@require_hr
def sms_settings(request: Request) -> Response:
    """GET: the settings document. PUT / PATCH: save it (see the module docstring)."""
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


# ── numbers for one month ───────────────────────────────────────────────────


def _messages_qs(request: Request):
    return scope_to_branch(SmsMessageLog.objects.select_related("employee"), request, field="employee__branch_id")


def _verified_qs(request: Request):
    return scope_to_branch(otp_service.verified_codes(otp_service.CHANNEL_SMS), request, field="employee__branch_id")


def _day_start(days_back: int = 0) -> datetime:
    today = timezone.now().astimezone(FACTORY_TZ).date() - timedelta(days=days_back)
    return datetime.combine(today, datetime.min.time(), tzinfo=FACTORY_TZ)


def _ist_midnight(day: date) -> datetime:
    return datetime.combine(day, datetime.min.time(), tzinfo=FACTORY_TZ)


def _counts(qs) -> dict:
    counts = {status: 0 for status in STATUSES}
    for row in qs.values("status").annotate(n=Count("id")):
        counts[row["status"]] = counts.get(row["status"], 0) + row["n"]
    return counts


def _parse_month(raw) -> date | None:
    """'YYYY-MM' as the month's first day, None when it is not one."""
    try:
        year, month = (int(part) for part in str(raw).split("-"))
        return date(year, month, 1) if 2000 <= year <= 2100 else None
    except (TypeError, ValueError):
        return None


def _month_numbers(request: Request, first: date, s: SmsSettings) -> dict:
    """Everything the usage page and the overview show about one IST month (see the module docstring)."""
    today = timezone.now().astimezone(FACTORY_TZ).date()
    days_in_month = calendar.monthrange(first.year, first.month)[1]
    last = first.replace(day=days_in_month)
    is_current = first <= today <= last
    shown_until = today if (is_current or first > today) else last  # a future month: no days yet
    start, end = _ist_midnight(first), _ist_midnight(last + timedelta(days=1))

    per_day: dict = {}
    per_purpose = {p: {"sent": 0, "failed": 0, "blocked": 0, "verified": 0} for p in PURPOSES}
    totals = {"sent": 0, "failed": 0, "blocked": 0}
    logs = _messages_qs(request).filter(created_at__gte=start, created_at__lt=end)
    for row in (
        logs.annotate(day=TruncDate("created_at", tzinfo=FACTORY_TZ))
        .values("day", "status", "purpose")
        .annotate(n=Count("id"))
    ):
        status, n = row["status"], row["n"]
        if status not in totals:
            continue
        totals[status] += n
        per_day.setdefault(row["day"], {}).setdefault(status, 0)
        per_day[row["day"]][status] += n
        if row["purpose"] in per_purpose:
            per_purpose[row["purpose"]][status] += n
    verified = 0
    verified_rows = _verified_qs(request).filter(consumed_at__gte=start, consumed_at__lt=end)
    for row in (
        verified_rows.annotate(day=TruncDate("consumed_at", tzinfo=FACTORY_TZ))
        .values("day", "purpose")
        .annotate(n=Count("id"))
    ):
        verified += row["n"]
        per_day.setdefault(row["day"], {}).setdefault("verified", 0)
        per_day[row["day"]]["verified"] += row["n"]
        if row["purpose"] in per_purpose:
            per_purpose[row["purpose"]]["verified"] += row["n"]

    days = []
    if first <= shown_until:
        for offset in range((shown_until - first).days + 1):
            day = first + timedelta(days=offset)
            counts = per_day.get(day, {})
            days.append(
                {
                    "date": day.isoformat(),
                    "sent": counts.get("sent", 0),
                    "failed": counts.get("failed", 0),
                    "blocked": counts.get("blocked", 0),
                    "verified": counts.get("verified", 0),
                }
            )

    sent_to_employees = sum(per_purpose[p]["sent"] for p in OTP_PURPOSES)
    price = sms_service.price_per_sms(s)
    so_far = price * totals["sent"]
    if is_current:
        projected = so_far / today.day * days_in_month
    elif first > today:
        projected = Decimal(0)
    else:
        projected = so_far
    budget = Decimal(s.monthly_budget) if s.monthly_budget is not None else None
    return {
        "month": f"{first.year:04d}-{first.month:02d}",
        "days": days,
        "daysInMonth": days_in_month,
        "elapsedDays": today.day if is_current else (days_in_month if first < today else 0),
        "totals": {
            "requested": totals["sent"] + totals["failed"] + totals["blocked"],
            **totals,
            "verified": verified,
            "deliveryRate": _pct(totals["sent"], totals["sent"] + totals["failed"]),
            "verifiedRate": _pct(verified, sent_to_employees),
        },
        "byPurpose": per_purpose,
        "cost": {
            "perSms": float(price),
            "soFar": _money(so_far),
            "projected": _money(projected),
            "budget": float(budget) if budget is not None else None,
            "budgetUsedPct": _pct(so_far, budget) if budget else None,
            "projectedBudgetPct": _pct(projected, budget) if budget else None,
            "currency": CURRENCY,
            "isCurrentMonth": is_current,
        },
    }


@api_view(["GET"])
@require_hr
def sms_usage(request: Request) -> Response:
    """One IST month (`month=YYYY-MM`, default this month): per day, per purpose, totals, cost and the projection, and the
    balance. See the module docstring for what each number counts."""
    raw = request.query_params.get("month")
    if raw:
        first = _parse_month(raw)
        if first is None:
            return _error("month must be YYYY-MM, for example 2026-11.")
    else:
        first = timezone.now().astimezone(FACTORY_TZ).date().replace(day=1)
    numbers = _month_numbers(request, first, SmsSettings.get())
    return Response({**numbers, "balance": sms_service.balance()})


# ── overview ────────────────────────────────────────────────────────────────


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


def _alerts(s: SmsSettings, status: dict, month: dict, limits: dict, balance: dict) -> list[dict]:
    """What HR should look at, most serious first: {level: error | warning | info, code, message}."""
    out = []

    def add(level, code, message):
        out.append({"level": level, "code": code, "message": message})

    on = s.otp_enabled
    if not status["configured"]:
        add(
            "error" if on else "info",
            "not_configured",
            sms_service.sending_block_reason() or "2Factor is not set up on this server.",
        )
    elif not status["sendingAllowedNow"]:
        add("warning" if on else "info", "sending_blocked", sms_service.sending_block_reason())
    if not on:
        add("info", "otp_off", "SMS codes are switched off: no SMS is sent (Settings -> OTP Switches).")
    elif not (s.otp_login_enabled or s.otp_reset_enabled or s.otp_activate_enabled):
        add("warning", "all_switches_off", "SMS codes are on but all three code switches are off, so no SMS is sent.")
    if status["paused"]:
        add("error", "paused", status["pauseReason"])
    else:
        for used, cap, label in (
            (limits["hourUsed"], limits["hourlyCap"], "hourly"),
            (limits["dayUsed"], limits["dailyCap"], "daily"),
        ):
            if cap and used * 100 >= cap * CAP_WARNING_PCT:
                add("warning", f"{label}_cap_near", f"{used} of the {label} limit of {cap} SMS are used.")
    if status["configured"]:
        credits = balance.get("credits")
        if credits is None:
            add("warning", "balance_unknown", balance.get("error") or "The 2Factor balance could not be read.")
        elif credits <= 0:
            add(
                "error", "balance_empty", "The 2Factor account has no SMS credits left: top it up in the 2Factor panel."
            )
        elif credits < sms_service.LOW_BALANCE_CREDITS:
            add(
                "warning", "balance_low", f"Only {credits} SMS credits are left on the 2Factor account: top it up soon."
            )
    cost = month["cost"]
    if cost["budget"] is not None:
        if cost["budgetUsedPct"] is not None and cost["budgetUsedPct"] >= 100:
            add("error", "budget_exceeded", f"This month's SMS cost (₹{cost['soFar']:.2f}) has reached the budget.")
        elif cost["projectedBudgetPct"] is not None and cost["projectedBudgetPct"] > 100:
            add(
                "warning",
                "budget_projected",
                f"At this pace the month ends at about ₹{cost['projected']:.2f}, over the budget of ₹{cost['budget']:.2f}.",
            )
    rate = month["totals"]["deliveryRate"]
    if rate is not None and rate < 90 and month["totals"]["failed"] >= 3:
        add("warning", "failures", f"Only {rate}% of this month's SMS were accepted by 2Factor: see Messages for why.")
    codes = sms_service.recipient_codes()
    if codes:
        add(
            "info",
            "dev_lock",
            f"This development machine texts only employee {', '.join(codes)} (SMS_ONLY_TO_EMPLOYEES).",
        )
    order = {"error": 0, "warning": 1, "info": 2}
    return sorted(out, key=lambda a: order[a["level"]])


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
    otp = otp_service.channel_status(otp_service.CHANNEL_SMS)
    pause_reason = sms_service.pause_reason()
    configured = sms_service.is_configured()
    status = {
        "configured": configured,
        "sendingAllowed": sms_service.sending_allowed(),
        # configured, allowed, and (on a development machine) somebody named in SMS_ONLY_TO_EMPLOYEES
        "sendingAllowedNow": sms_service.is_available(),
        "otpEnabled": s.otp_enabled,
        "available": otp["available"],
        "purposes": otp["purposes"],
        "paused": pause_reason is not None,
        "pauseReason": pause_reason,
        "devLock": {
            "active": sms_service.allowed_numbers() is not None,
            "onlyToEmployees": sms_service.recipient_codes(),
        },
    }
    limits = {
        "hourlyCap": s.hourly_cap,
        "dailyCap": s.daily_cap,
        "hourUsed": used["hourUsed"],
        "dayUsed": used["dayUsed"],
    }
    first = timezone.now().astimezone(FACTORY_TZ).date().replace(day=1)
    month = _month_numbers(request, first, s)
    balance = sms_service.balance()
    totals = month["totals"]
    return Response(
        {
            "provider": "twofactor",
            "configured": configured,
            "sendingAllowed": status["sendingAllowed"],
            "sendingNote": _sending_note(),
            "otpEnabled": s.otp_enabled,
            "status": status,
            "env": _env(),
            "balance": balance,
            "today": today,
            "last7Days": last7,
            "lastSentAt": last_sent.isoformat() if last_sent else None,
            "limits": limits,
            "circuit": {"paused": paused, "until": until.isoformat() if until else None},
            "month": {
                "month": month["month"],
                "requested": totals["requested"],
                "sent": totals["sent"],
                "failed": totals["failed"],
                "blocked": totals["blocked"],
                "verified": totals["verified"],
                "deliveryRate": totals["deliveryRate"],
                "verifiedRate": totals["verifiedRate"],
            },
            "cost": month["cost"],
            "alerts": _alerts(s, status, month, limits, balance),
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


def _test_employee(data: dict):
    """(the employee named by employeeCode / employeeId, None) or (None, the 400 answer); (None, None) when the body names
    no employee (a typed number then)."""
    code, emp_id = data.get("employeeCode"), data.get("employeeId")
    if code in (None, "") and emp_id in (None, ""):
        return None, None
    employee = None
    if code not in (None, ""):
        if isinstance(code, str) and "\x00" not in code and len(code) <= 40:
            employee = Employee.objects.filter(employee_code__iexact=code.strip()).first()
    else:
        number = _as_int(emp_id) if not isinstance(emp_id, str) else (int(emp_id) if emp_id.isdigit() else None)
        if number is not None:
            employee = Employee.objects.filter(pk=number).first()
    if employee is None:
        return None, _test_answer(False, "No employee with that code. Choose the employee to send the test to.", 400)
    if sms_service.normalize_phone(employee.phone) is None:
        return None, _test_answer(False, "This employee has no valid mobile number registered.", 400)
    return employee, None


@api_view(["POST"])
@require_hr
def sms_test(request: Request) -> Response:
    """Send ONE test code (the dummy 1234, through the real OTP template: there is no free text) to an employee's
    registered number ({"employeeCode"} or {"employeeId"}) or to a typed number ({"phone"}). Answers 200 {"ok",
    "message"} for everything that is about the send itself (accepted, refused by 2Factor, not configured, a limit, the
    development lock); 400 for no usable employee / number, 429 after TEST_LIMIT_PER_HOUR tests in an hour by this HR
    user, 403 for a branch login."""
    if get_branch_scope(request) is not None:
        body = {"ok": False, "message": COMPANY_WIDE_MESSAGE, "error": COMPANY_WIDE_MESSAGE}
        return Response({**body, "code": "company_wide_settings"}, status=403)
    data, refusal = _read_body(request)
    if refusal is not None:
        return refusal
    employee, refusal = _test_employee(data)
    if refusal is not None:
        return refusal
    phone = data.get("phone")
    if employee is None:
        if not isinstance(phone, str) or not phone.strip() or len(phone) > 40:
            return _test_answer(
                False, "Choose the employee to send the test to, or enter a mobile number like 9876543210.", 400
            )
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

    result = sms_service.send_test(phone, user_id, _get_ip(request) or "", employee=employee)
    if result.log_id is not None:
        outcome = {"sent": "", "failed": " (2Factor refused it)", "blocked": " (stopped by a limit)"}[result.status]
        who = f"{employee.employee_code} on " if employee is not None else ""
        log_action(request, "test", AUDIT_MODULE, description=f"Sent a test SMS to {who}{result.masked_phone}{outcome}")
    if result.ok:
        return _test_answer(
            True,
            f"2Factor accepted the test code for {result.masked_phone}. It normally arrives within a minute; "
            "if it does not, check the number and the DLT template.",
        )
    if result.status == SmsMessageLog.STATUS_FAILED and result.kind != "not_configured":
        return _test_answer(False, f"The test SMS was not sent. {result.detail}")
    return _test_answer(False, result.detail or result.message)

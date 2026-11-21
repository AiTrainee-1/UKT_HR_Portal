"""
One-time passcodes for the employee apps (mobile app + Employee Web App): sign in with an Employee Code, reset a
forgotten password, or confirm a new employee's first password ("activate").

Two delivery channels, INDEPENDENT of each other (owner, 2026-11-20):
  * WhatsApp: the Meta WhatsApp Cloud API, an approved AUTHENTICATION template (`hrms_otp` unless HR pointed the purpose's
    message type at another one); switched on WhatsApp Control (WhatsAppSettings.otp_enabled, its three purpose switches
    otp_login_enabled / otp_reset_enabled / otp_activate_enabled, otp_expiry_minutes). 6-digit codes.
  * SMS: 2Factor.in (sms_service.py); switched on SMS Control (SmsSettings.otp_enabled, its own three purpose switches,
    expiry, cooldown and limits). 4-digit codes (the DLT template says "XXXX").
A channel is AVAILABLE for a purpose when its master switch and its purpose switch are on AND it can really deliver from
this server (configured, allowed to send; WhatsApp also: the WhatsApp master switch on and the template APPROVED by Meta).
Either channel alone is enough; neither reads the other's settings. When both are available the apps let the employee
choose (`channel` on otp/request); a request without a channel (an older app) gets the first available one, WhatsApp
before SMS. Every successful answer names the other channels that would also work (`otherChannels`), so an app can offer
"Didn't get it? Send by SMS instead". A channel on hold (pause_reason: a breaker, Meta's account pause, a global limit
used up; account_problem: the provider account refuses) stays listed: it fails the request with a plain sentence (a
WhatsApp code on hold never reaches Meta), keeps password sign-in open (see paused_now), and a request that names no
channel goes to the other one.

Each channel keeps its OWN expiry, resend cooldown, hourly / daily allowance and attempt limit, counted on its own codes
(EmployeeOtp.channel; a row from before the column counts by its length: 4 digits = SMS, 6 = WhatsApp). Generation,
hashing, single use, purpose binding and "only the newest code works" are shared by both.

Security properties, each covered by tests_otp.py, tests_otp_channels.py and tests_sms_otp.py:
  * Codes are random digits from `secrets` (CODE_LENGTH per channel), valid for a few minutes (the channel's expiry) and
    usable exactly once. The length is stored on the code row, so a code verifies with the length it was issued with.
  * Only a salted HMAC of the code is stored -never the code- so a database read or backup can't be turned into a login.
  * At most the channel's attempt limit of wrong guesses per code, then it is dead. Four digits are only 10 000
    combinations, so SMS is held tighter (the SMS_* constants below): at most 5 wrong guesses per code and 10 codes per
    employee and purpose in any 24 hours, i.e. at most 50 guesses a day (0.5 %) against one account.
  * A new request (on either channel) kills every earlier unused code of the same purpose, so only the latest message
    works -but only once the new code was really sent: a send that fails (or is blocked by a limit) deletes the new row
    and leaves the employee's previous code valid, so nobody can make a victim's code die by making a send fail.
  * One request per employee at a time: the cooldown / allowance checks and the creation of the new code run under a lock
    on the employee row, so twelve simultaneous requests send one message.
  * Requests are rate limited per employee and channel (resend cooldown, hourly and daily allowance) on top of the
    per-IP throttle on the endpoints; each channel adds a per-number cap, global caps and a circuit breaker (SMS:
    sms_service.py; WhatsApp: the WHATSAPP_* limits here and whatsapp_dispatcher.pause_state).
  * A code issued for one purpose can't be used for another.

Nobody is ever locked out:
  * password sign-in can be refused (WhatsAppSettings.password_login_enabled off) only while at least one channel is
    available for sign-in AND not on hold right now (pause_reason / account_problem);
  * a first password needs a code only while at least one channel is available for activation and its provider account
    is not refusing to send; otherwise the old open first-time setup stays. A temporary hold (a breaker, a limit used up)
    never reopens it: anybody can bring one about with a flood of requests.
WhatsApp codes cost money, so they have limits of their own like SMS (WHATSAPP_MAX_REQUESTS_PER_DAY and the lines below
it): per employee and purpose a day, per phone number an hour, and every WhatsApp code an hour / a day.

A code that dies without being used (a newer code replaced it, the attempt limit was reached, a password reset killed it)
is marked consumed AND expired at that moment (expires_at = consumed_at), so `consumed_at < expires_at` means "used in
time": verified_codes() is what the Control pages count as verified.
"""

import hashlib
import hmac
import secrets
from dataclasses import dataclass
from datetime import datetime, time as time_type, timedelta

from django.conf import settings as dj_settings
from django.db import transaction
from django.db.models import F, Q, QuerySet
from django.utils import timezone

from . import sms_service, whatsapp_service
from . import whatsapp_catalog as catalog
from .clock import FACTORY_TZ
from .models import Employee, EmployeeOtp, SmsSettings, WhatsAppSettings, WhatsAppTemplate

RESEND_COOLDOWN_SECONDS = 60
MAX_REQUESTS_PER_HOUR = 5
MAX_ATTEMPTS = 5

CHANNEL_WHATSAPP = "whatsapp"
CHANNEL_SMS = "sms"
#: every channel, in the order the apps list them and a request without a channel tries them
CHANNELS = (CHANNEL_WHATSAPP, CHANNEL_SMS)
PURPOSES = (EmployeeOtp.PURPOSE_LOGIN, EmployeeOtp.PURPOSE_RESET, EmployeeOtp.PURPOSE_ACTIVATE)

#: digits in the code, per delivery channel. SMS: the approved DLT template says "XXXX" and 6-digit codes are not
#: delivered through it. WhatsApp keeps the 6 digits it always had.
CODE_LENGTH = {CHANNEL_SMS: 4, CHANNEL_WHATSAPP: 6}
#: EmployeeOtp.code_length's default: every code from before the SMS channel
DEFAULT_CODE_LENGTH = CODE_LENGTH[CHANNEL_WHATSAPP]

#: 4 digits can be guessed far more easily than 6, so the SMS channel is held to these ceilings whatever the SMS Control
#: page holds (a row saved earlier with a larger number is clamped): wrong guesses per code, and codes one employee may
#: ask for per purpose in any 24 hours. Together: at most 5 x 10 = 50 guesses in 24 hours against one account (0.5 %).
SMS_MAX_ATTEMPTS_CEILING = 5
SMS_MAX_REQUESTS_PER_DAY = 10

#: WhatsApp codes cost money too (Meta charges every authentication message), so they have limits of their own, like
#: SMS (a Django setting of the same name with the WHATSAPP_OTP_ prefix overrides each one; there is no column for them
#: yet): codes per employee and purpose in any 24 hours, codes to one phone number in any hour (two employee records that
#: share a number cannot multiply the allowance), and every WhatsApp code in the rolling hour / since midnight IST. A
#: global limit used up PAUSES WhatsApp codes (whatsapp_pause_reason): the request gets a plain sentence and password
#: sign-in stays open, so an anonymous flood can cost at most these numbers and never lock anybody out.
WHATSAPP_MAX_REQUESTS_PER_DAY = 10
WHATSAPP_MAX_PER_NUMBER_PER_HOUR = 10
WHATSAPP_HOURLY_CAP = 300
WHATSAPP_DAILY_CAP = 1500
_WHATSAPP_LIMIT_SETTINGS = (
    ("perEmployeePerDay", "WHATSAPP_OTP_MAX_PER_DAY", WHATSAPP_MAX_REQUESTS_PER_DAY),
    ("perNumberPerHour", "WHATSAPP_OTP_MAX_PER_NUMBER_PER_HOUR", WHATSAPP_MAX_PER_NUMBER_PER_HOUR),
    ("hourlyCap", "WHATSAPP_OTP_HOURLY_CAP", WHATSAPP_HOURLY_CAP),
    ("dailyCap", "WHATSAPP_OTP_DAILY_CAP", WHATSAPP_DAILY_CAP),
)
MSG_NUMBER_CAP = "Too many codes were sent to this number. Please try again in an hour, or contact HR."

#: the Meta AUTHENTICATION template every WhatsApp code goes out as, unless HR pointed the purpose's message type at
#: another one (WhatsAppSettings.template_overrides) or the catalog names one for it
WHATSAPP_OTP_TEMPLATE = "hrms_otp"
TEMPLATE_APPROVED = "APPROVED"

_CHANNEL_NAME = {CHANNEL_WHATSAPP: "WhatsApp", CHANNEL_SMS: "SMS"}
_PURPOSE_LABEL = {
    EmployeeOtp.PURPOSE_LOGIN: "sign-in",
    EmployeeOtp.PURPOSE_RESET: "password reset",
    EmployeeOtp.PURPOSE_ACTIVATE: "account activation",
}
_TYPE_FOR_PURPOSE = {
    EmployeeOtp.PURPOSE_LOGIN: "otp_login",
    EmployeeOtp.PURPOSE_RESET: "otp_reset",
    EmployeeOtp.PURPOSE_ACTIVATE: "otp_activate",
}


def code_length(channel: str | None) -> int:
    """How many digits a code issued on this channel has (an unknown channel: the 6 of WhatsApp)."""
    return CODE_LENGTH.get(channel or "", DEFAULT_CODE_LENGTH)


def channel_name(channel: str) -> str:
    """The channel as people read it: 'WhatsApp' or 'SMS'."""
    return _CHANNEL_NAME.get(channel, channel)


def _names(channels) -> str:
    return " or ".join(channel_name(c) for c in channels)


@dataclass(frozen=True)
class OtpConfig:
    """One channel's own settings: its master switch, its three purpose switches and its limits. WhatsApp: the
    WhatsAppSettings switches / expiry and the module constants above; SMS: the SmsSettings values."""

    channel: str
    enabled: bool  # the channel's own OTP master switch
    login_enabled: bool
    reset_enabled: bool
    activate_enabled: bool
    expiry_minutes: int
    resend_cooldown_seconds: int
    max_requests_per_hour: int
    max_attempts_per_code: int
    max_requests_per_day: int | None  # per employee and purpose, rolling 24 h; None = no daily limit

    @property
    def code_length(self) -> int:
        return code_length(self.channel)

    @property
    def name(self) -> str:
        return channel_name(self.channel)

    def switched_on(self, purpose: str) -> bool:
        """Are this channel's master switch AND this purpose's switch on?"""
        return bool(self.enabled and getattr(self, f"{purpose}_enabled", False))


def whatsapp_limits() -> dict[str, int]:
    """The WhatsApp code limits in force: {perEmployeePerDay, perNumberPerHour, hourlyCap, dailyCap} (see
    WHATSAPP_MAX_REQUESTS_PER_DAY)."""
    out = {}
    for key, setting, default in _WHATSAPP_LIMIT_SETTINGS:
        try:
            out[key] = max(1, int(getattr(dj_settings, setting, default)))
        except (TypeError, ValueError):
            out[key] = default
    return out


def _whatsapp_config(wa: WhatsAppSettings) -> OtpConfig:
    return OtpConfig(
        channel=CHANNEL_WHATSAPP,
        enabled=bool(wa.otp_enabled),
        login_enabled=bool(wa.otp_login_enabled),
        reset_enabled=bool(wa.otp_reset_enabled),
        activate_enabled=bool(wa.otp_activate_enabled),
        expiry_minutes=int(wa.otp_expiry_minutes),
        resend_cooldown_seconds=RESEND_COOLDOWN_SECONDS,
        max_requests_per_hour=MAX_REQUESTS_PER_HOUR,
        max_attempts_per_code=MAX_ATTEMPTS,
        max_requests_per_day=whatsapp_limits()["perEmployeePerDay"],
    )


def _sms_config(sms: SmsSettings) -> OtpConfig:
    return OtpConfig(
        channel=CHANNEL_SMS,
        enabled=bool(sms.otp_enabled),
        login_enabled=bool(sms.otp_login_enabled),
        reset_enabled=bool(sms.otp_reset_enabled),
        activate_enabled=bool(sms.otp_activate_enabled),
        expiry_minutes=int(sms.otp_expiry_minutes),
        resend_cooldown_seconds=int(sms.resend_cooldown_seconds),
        max_requests_per_hour=int(sms.max_requests_per_hour),
        max_attempts_per_code=min(int(sms.max_attempts_per_code), SMS_MAX_ATTEMPTS_CEILING),
        max_requests_per_day=SMS_MAX_REQUESTS_PER_DAY,
    )


def resolve(channel: str) -> OtpConfig:
    """This channel's settings (see OtpConfig)."""
    if channel == CHANNEL_SMS:
        return _sms_config(SmsSettings.get())
    if channel == CHANNEL_WHATSAPP:
        return _whatsapp_config(WhatsAppSettings.get())
    raise ValueError(f"unknown OTP channel {channel!r}")


# ── which WhatsApp template carries the codes ───────────────────────────────


def whatsapp_template_name(purpose: str, wa: WhatsAppSettings | None = None) -> str:
    """The Meta template a WhatsApp code for this purpose goes out as: HR's choice for the purpose's message type
    (WhatsAppSettings.template_overrides), else the catalog's default for it -resolved exactly the way whatsapp_service
    resolves it when it sends, so "available" here and the real send never disagree. The catalog names one shared
    AUTHENTICATION template for the three code types (WHATSAPP_OTP_TEMPLATE, `hrms_otp`); it is also the fallback for a
    code type the catalog does not send through Meta."""
    key = _TYPE_FOR_PURPOSE[purpose]
    overrides = (wa or WhatsAppSettings.get()).template_overrides
    chosen = overrides.get(key) if isinstance(overrides, dict) else None
    if isinstance(chosen, str) and chosen.strip():
        return chosen.strip()
    t = catalog.get(key)
    default = getattr(t, "default_template_name", None) if t is not None else None
    return default or WHATSAPP_OTP_TEMPLATE


def whatsapp_template(purpose: str, wa: WhatsAppSettings | None = None) -> WhatsAppTemplate | None:
    """The APPROVED Meta template row (name + language) a WhatsApp code for this purpose is sent as, or None."""
    name = whatsapp_template_name(purpose, wa)
    return WhatsAppTemplate.objects.filter(name=name, status__iexact=TEMPLATE_APPROVED).order_by("language").first()


def whatsapp_template_status(purpose: str, wa: WhatsAppSettings | None = None) -> str | None:
    """Meta's review status of this purpose's template as last seen ('APPROVED', 'PENDING', 'REJECTED', ...), None when
    no template of that name is known. When the name exists in several languages an approved one wins."""
    name = whatsapp_template_name(purpose, wa)
    statuses = {str(s).upper() for s in WhatsAppTemplate.objects.filter(name=name).values_list("status", flat=True)}
    if not statuses:
        return None
    return TEMPLATE_APPROVED if TEMPLATE_APPROVED in statuses else sorted(statuses)[0]


# ── pauses: a channel that is set up but cannot send at this moment ─────────────


def _day_start(now):
    local = now.astimezone(FACTORY_TZ)
    return datetime.combine(local.date(), time_type.min, tzinfo=FACTORY_TZ)


def whatsapp_code_usage(now=None) -> dict[str, int]:
    """WhatsApp codes sent (or on their way) in the rolling hour and since midnight IST: the channel's code rows. A code
    whose send failed was deleted, so only what went to Meta counts."""
    now = now or timezone.now()
    rows = EmployeeOtp.objects.filter(_of_channel(CHANNEL_WHATSAPP))
    return {
        "hourUsed": rows.filter(created_at__gte=now - timedelta(hours=1)).count(),
        "dayUsed": rows.filter(created_at__gte=_day_start(now)).count(),
    }


def _whatsapp_cap_reason(now) -> str | None:
    limits = whatsapp_limits()
    used = whatsapp_code_usage(now)
    if used["hourUsed"] >= limits["hourlyCap"]:
        return f"The hourly limit of {limits['hourlyCap']} WhatsApp codes is used up."
    if used["dayUsed"] >= limits["dailyCap"]:
        return f"The daily limit of {limits['dailyCap']} WhatsApp codes is used up (it starts again at midnight IST)."
    return None


def whatsapp_pause_reason(now=None) -> str | None:
    """Why WhatsApp codes cannot be sent at this moment although WhatsApp is set up, as one sentence for HR; None when
    nothing holds them: WhatsApp sending is paused (Meta said the account cannot send, or messages kept failing at Meta:
    whatsapp_dispatcher.pause_state), or a global code limit is used up (WHATSAPP_HOURLY_CAP / WHATSAPP_DAILY_CAP)."""
    from . import whatsapp_dispatcher

    now = now or timezone.now()
    paused, why, _until = whatsapp_dispatcher.pause_state(now)
    if paused:
        return why
    return _whatsapp_cap_reason(now)


def pause_reason(channel: str, now=None) -> str | None:
    """Why this channel cannot send a code at this moment although it is set up (a circuit breaker, a global limit used
    up, Meta's account pause), else None. Temporary, and partly in anybody's hands (a flood of code requests uses a limit
    up): it reopens password sign-in, never the open first-password setup."""
    if channel == CHANNEL_SMS:
        return sms_service.pause_reason(now)
    return whatsapp_pause_reason(now)


def account_problem(channel: str, now=None) -> str | None:
    """Why the provider ACCOUNT behind this channel refuses to send at all (WhatsApp: an expired token, a blocked or
    locked number, a payment problem; SMS: a refused key, no balance), held until a message goes out again; else None.
    Nobody outside can bring it about, so while it holds the channel counts as unable to deliver everywhere: password
    sign-in and the open first-password setup both stay available."""
    if channel == CHANNEL_SMS:
        return sms_service.account_problem(now)
    from . import whatsapp_dispatcher

    return whatsapp_dispatcher.account_problem(now)


# ── availability ────────────────────────────────────────────────────────────


class _Snapshot:
    """The settings and channel checks behind ONE decision, each read at most once."""

    def __init__(self):
        self.wa = WhatsAppSettings.get()
        self.sms = SmsSettings.get()
        self.configs = {CHANNEL_WHATSAPP: _whatsapp_config(self.wa), CHANNEL_SMS: _sms_config(self.sms)}
        self._delivery: dict[str, list[str]] = {}
        self._template: dict[str, str | None] = {}
        self._pause: dict[str, str | None] = {}
        self._broken: dict[str, str | None] = {}

    def delivery_problems(self, channel: str) -> list[str]:
        """Why this channel cannot deliver from this server at all (purpose-independent), [] when it can."""
        if channel not in self._delivery:
            out = []
            if channel == CHANNEL_SMS:
                reason = sms_service.sending_block_reason()
                if reason:
                    out.append(reason)
            else:
                if not whatsapp_service.is_configured():
                    out.append(
                        "WhatsApp is not set up on this server, or this machine may not send WhatsApp messages "
                        "(WhatsApp Control -> Settings)."
                    )
                if not whatsapp_service.engine_enabled():
                    out.append("The WhatsApp master switch is off (WhatsApp Control -> Message Controls).")
            self._delivery[channel] = out
        return self._delivery[channel]

    def template_status(self, purpose: str) -> str | None:
        name = whatsapp_template_name(purpose, self.wa)
        if name not in self._template:
            self._template[name] = whatsapp_template_status(purpose, self.wa)
        return self._template[name]

    def available(self, channel: str, purpose: str) -> bool:
        """Switched on for the purpose AND able to deliver (checked lazily: an off channel costs no further query)."""
        if not self.configs[channel].switched_on(purpose) or self.delivery_problems(channel):
            return False
        return channel != CHANNEL_WHATSAPP or self.template_status(purpose) == TEMPLATE_APPROVED

    def available_channels(self, purpose: str) -> list[str]:
        return [c for c in CHANNELS if self.available(c, purpose)]

    def problems(self, channel: str, purpose: str) -> list[str]:
        """Every reason this channel can't deliver a code for this purpose, as sentences for HR ([] = available)."""
        cfg = self.configs[channel]
        out = []
        if not cfg.enabled:
            out.append(f"{cfg.name} codes are switched off.")
        elif not cfg.switched_on(purpose):
            out.append(f"{cfg.name} codes for {_PURPOSE_LABEL[purpose]} are switched off.")
        out.extend(self.delivery_problems(channel))
        if channel == CHANNEL_WHATSAPP:
            status = self.template_status(purpose)
            name = whatsapp_template_name(purpose, self.wa)
            if status is None:
                out.append(f"The WhatsApp template '{name}' does not exist yet (WhatsApp Control -> OTP: create it).")
            elif status != TEMPLATE_APPROVED:
                out.append(f"The WhatsApp template '{name}' is not approved by Meta (status: {status}).")
        return out

    def pause_reason(self, channel: str) -> str | None:
        """See pause_reason(): a temporary hold (breaker, a global limit, Meta's account pause)."""
        if channel not in self._pause:
            self._pause[channel] = pause_reason(channel)
        return self._pause[channel]

    def broken(self, channel: str) -> str | None:
        """See account_problem(): the provider account refuses to send until it is fixed."""
        if channel not in self._broken:
            self._broken[channel] = account_problem(channel)
        return self._broken[channel]

    def paused(self, channel: str) -> bool:
        """Configured but unable to send at this moment: held for a while, or the provider account refuses."""
        return bool(self.pause_reason(channel) or self.broken(channel))

    def why_paused(self, channel: str) -> str | None:
        return self.broken(channel) or self.pause_reason(channel)

    def first_ready(self, channels: list[str]) -> str | None:
        """The channel a request that names none gets: the first that is not paused, else the first (which then answers
        with the plain 'can't be sent right now' sentence). An older app can't choose, so it must never be sent to a
        paused channel while the other one works."""
        if len(channels) > 1:
            for channel in channels:
                if not self.paused(channel):
                    return channel
        return channels[0] if channels else None


def available_channels(purpose: str) -> list[str]:
    """The channels that can deliver a code for this purpose right now, WhatsApp first ([] = none)."""
    return _Snapshot().available_channels(purpose)


def otp_channels() -> dict[str, list[str]]:
    """{"login": [...], "reset": [...], "activate": [...]}: the available channels per purpose."""
    snap = _Snapshot()
    return {purpose: snap.available_channels(purpose) for purpose in PURPOSES}


def channel_problems(channel: str, purpose: str) -> list[str]:
    """Why this channel cannot deliver a code for this purpose, as plain sentences for HR; [] = available."""
    return _Snapshot().problems(channel, purpose)


def paused_now(channel: str) -> bool:
    """Is the channel configured but unable to send for the moment: a breaker or Meta's account pause, a global limit
    used up (pause_reason), or the provider account refuses (account_problem)? Anybody can bring part of this about with
    a flood of code requests, so it must never close another sign-in method: password sign-in stays open while it is
    true."""
    return bool(pause_reason(channel) or account_problem(channel))


def channel_status(channel: str) -> dict:
    """One channel's OTP state for its Control page: {channel, enabled, available (for at least one purpose), purposes:
    {login, reset, activate: bool}, problems: {purpose: [sentences]}, paused, pauseReason, codeLength, expiryMinutes}
    (+ for WhatsApp: templateName, templateStatus, limits)."""
    snap = _Snapshot()
    cfg = snap.configs[channel]
    purposes = {purpose: snap.available(channel, purpose) for purpose in PURPOSES}
    out = {
        "channel": channel,
        "enabled": cfg.enabled,
        "available": any(purposes.values()),
        "purposes": purposes,
        "problems": {purpose: snap.problems(channel, purpose) for purpose in PURPOSES},
        "paused": snap.paused(channel),
        "pauseReason": snap.why_paused(channel),
        "codeLength": cfg.code_length,
        "expiryMinutes": cfg.expiry_minutes,
    }
    if channel == CHANNEL_WHATSAPP:
        out["templateName"] = whatsapp_template_name(EmployeeOtp.PURPOSE_LOGIN, snap.wa)
        out["templateStatus"] = snap.template_status(EmployeeOtp.PURPOSE_LOGIN)
        out["limits"] = {**whatsapp_limits(), **whatsapp_code_usage()}
    return out


def _activation_channels(snap: _Snapshot) -> list[str]:
    """The channels a first password can really be confirmed through: available for activation and the provider account
    not refusing to send. A temporary pause (a breaker, a global limit used up) does NOT take a channel out here: anybody
    can bring one about with a flood of code requests, and that must never reopen the open setup to strangers."""
    return [c for c in snap.available_channels(EmployeeOtp.PURPOSE_ACTIVATE) if not snap.broken(c)]


def activation_required() -> bool:
    """True when a first-time password must be confirmed with a code. Only while that can really work (at least one
    channel available for activation whose provider account is not refusing to send); otherwise the old open first-time
    setup stays, so nobody is locked out."""
    return bool(_activation_channels(_Snapshot()))


def activation_message() -> str:
    """What set-password tells a stranger who must confirm a code first (names the channels that would send it)."""
    channels = _activation_channels(_Snapshot())
    if channels == [CHANNEL_SMS]:
        return "Please confirm the code we send by SMS to your registered mobile number to set your password."
    if channels == [CHANNEL_WHATSAPP]:
        return "Please confirm the code we send to your registered WhatsApp number to set your password."
    return "Please confirm the code we send to your registered mobile number (by WhatsApp or SMS) to set your password."


def _login_ready(snap: _Snapshot) -> list[str]:
    """The channels a code sign-in really works on right now: available for sign-in, not paused and the provider account
    not refusing to send."""
    return [c for c in snap.available_channels(EmployeeOtp.PURPOSE_LOGIN) if not snap.paused(c)]


def password_login_block_message() -> str | None:
    """The refusal for a password sign-in when HR has switched password login off while code sign-in really works, else
    None. Never locks everyone out: while no channel can send a sign-in code right now (switched off, not configured,
    paused / capped for the moment) password sign-in stays open."""
    snap = _Snapshot()
    if snap.wa.password_login_enabled:
        return None
    ready = _login_ready(snap)
    if not ready:
        return None
    article = "an" if ready[0] == CHANNEL_SMS else "a"
    return f"Password sign-in is turned off. Please sign in with {article} {_names(ready)} code."


def login_options() -> dict:
    """Which sign-in methods the apps should offer.

    otpChannels {login, reset, activate}: the channels available for each purpose (WhatsApp first); channels: name and
    code length of every channel in those lists. For older apps: otpLogin / otpReset / otpActivate (that purpose's list is
    not empty), otpChannel (the first channel of the login list, else of reset, else of activate; null when there is none)
    and codeLength (that channel's digits; 6 when there is none). passwordLogin is false only while HR switched password
    sign-in off AND a code sign-in really works right now. While one of two channels is paused, otpChannel names the
    other one: a request that names no channel is sent there too (_Snapshot.first_ready), so an older app always gets the
    code length it shows."""
    snap = _Snapshot()
    lists = {purpose: snap.available_channels(purpose) for purpose in PURPOSES}
    first = next((snap.first_ready(lists[p]) for p in PURPOSES if lists[p]), None)
    used = [c for c in CHANNELS if any(c in channels for channels in lists.values())]
    return {
        "otpLogin": bool(lists[EmployeeOtp.PURPOSE_LOGIN]),
        "otpReset": bool(lists[EmployeeOtp.PURPOSE_RESET]),
        "otpActivate": bool(lists[EmployeeOtp.PURPOSE_ACTIVATE]),
        "passwordLogin": bool(snap.wa.password_login_enabled or not _login_ready(snap)),
        "otpChannel": first,
        "codeLength": code_length(first),
        "otpChannels": lists,
        "channels": {c: {"name": channel_name(c), "codeLength": code_length(c)} for c in used},
    }


# ── the codes ───────────────────────────────────────────────────────────────


class OtpError(Exception):
    """A refusal the API should report as-is. `status` is the HTTP status; `extra` goes into the answer next to "error"."""

    def __init__(self, error: str, status: int = 400, /, **extra):
        super().__init__(error)
        self.message = error
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


def _of_channel(channel: str) -> Q:
    """The code rows issued on this channel (a row from before EmployeeOtp.channel: by its length)."""
    return Q(channel=channel) | Q(channel="", code_length=code_length(channel))


def row_channel(otp: EmployeeOtp) -> str:
    """The channel a code row went out on (a row from before the column: 4 digits = SMS, else WhatsApp)."""
    if otp.channel in CODE_LENGTH:
        return otp.channel
    return CHANNEL_SMS if otp.code_length == CODE_LENGTH[CHANNEL_SMS] else CHANNEL_WHATSAPP


def verified_codes(channel: str) -> QuerySet:
    """The code rows of this channel that were USED in time (verified): consumed before they expired. A code that died
    unused (replaced, locked, killed by a reset) has expires_at set to its consumed_at, so it never counts. Filter it by
    consumed_at for a period."""
    return EmployeeOtp.objects.filter(channel=channel, consumed_at__isnull=False, consumed_at__lt=F("expires_at"))


def _pick(snap: _Snapshot, purpose: str, requested) -> tuple[OtpConfig, list[str]]:
    """(the channel config this request uses, every channel available for the purpose), or OtpError."""
    available = snap.available_channels(purpose)
    if requested is not None:
        if requested in available:
            return snap.configs[requested], available
        if requested in CHANNELS:
            message = f"{channel_name(requested)} codes aren't available right now."
        else:
            message = "Choose how to get the code: WhatsApp or SMS."
        message += f" Please choose {_names(available)}." if available else " Please use your password or contact HR."
        # `message` repeats `error` for the apps that read the contract's name for it
        raise OtpError(message, 400, code="channel_unavailable", availableChannels=available, message=message)
    if available:
        return snap.configs[snap.first_ready(available)], available
    switched = [c for c in CHANNELS if snap.configs[c].switched_on(purpose)]
    if not switched:
        raise OtpError(
            "One-time codes are turned off. Please use your password or contact HR.",
            403,
            code="otp_off",
            availableChannels=[],
        )
    raise OtpError(
        f"{_names(switched)} OTP isn't available right now. Please contact HR.",
        503,
        code="otp_unavailable",
        availableChannels=[],
    )


def _send_whatsapp_code(employee: Employee, purpose: str, code: str, minutes: int, phone: str) -> bool:
    """THE one call that sends a code by WhatsApp: the purpose's message type through whatsapp_service, at once (never
    queued), its log row with the code redacted. True when WhatsApp accepted it. Kept to this single call so the
    WhatsApp side can change how it sends (the Meta AUTHENTICATION template) without touching the channel logic here."""
    log = whatsapp_service.send_notification(
        employee,
        _TYPE_FOR_PURPOSE[purpose],
        [code, str(minutes)],
        log_params=["••••••", str(minutes)],
    )  # a code is sent at once, never queued (whatsapp_catalog kind "code")
    return log is not None and log.status in ("sent", "delivered", "read", "queued", "sending")


def _whatsapp_paused_message(others: list[str]) -> str:
    message = "WhatsApp codes can't be sent right now."
    return message + (
        f" Please choose {_names(others)} instead." if others else " Please use your password or contact HR."
    )


def _whatsapp_limit_refusal(phone: str, now, others: list[str]) -> tuple[str, int] | None:
    """(sentence, http status) when a WhatsApp code limit stops this request (see WHATSAPP_MAX_REQUESTS_PER_DAY), else
    None. Counted on the channel's code rows, so a failed send (its row is deleted) never counts."""
    limits = whatsapp_limits()
    if _whatsapp_cap_reason(now):
        return _whatsapp_paused_message(others), 503
    to_this_number = (
        EmployeeOtp.objects.filter(_of_channel(CHANNEL_WHATSAPP))
        .filter(phone_number=phone, created_at__gte=now - timedelta(hours=1))
        .count()
    )
    if to_this_number >= limits["perNumberPerHour"]:
        return MSG_NUMBER_CAP, 429
    return None


def request_otp(identifier: str | None, purpose: str, ip: str = "", channel: str | None = None) -> dict:
    """Create a code and send it to the employee's registered number by `channel` ("whatsapp" | "sms"; None: the first
    available for the purpose). Returns {message, maskedPhone, expiresInSeconds, resendAfterSeconds, channel, codeLength,
    otherChannels}. Raises OtpError (a requested channel that is not available: 400 code "channel_unavailable" with
    availableChannels)."""
    if purpose not in _TYPE_FOR_PURPOSE:
        raise OtpError("Unknown purpose.")
    snap = _Snapshot()
    cfg, available = _pick(snap, purpose, channel)
    others = [c for c in available if c != cfg.channel]

    employee = find_employee(identifier)
    if purpose == EmployeeOtp.PURPOSE_ACTIVATE and employee.password_hash:
        raise OtpError("This account already has a password. Please sign in, or use Forgot password.", 409)
    phone = whatsapp_service.normalize_phone(employee.phone)
    if not phone:
        raise OtpError("No mobile number is registered for this employee. Please contact HR.", 400)
    if cfg.channel == CHANNEL_SMS and not sms_service.is_valid_number(phone):
        # refused before anything is created or requested: a landline or a half-typed number
        raise OtpError(sms_service.MSG_BAD_NUMBER, 400, otherChannels=others)
    if cfg.channel == CHANNEL_WHATSAPP and snap.pause_reason(CHANNEL_WHATSAPP):
        # Meta said the account cannot send, messages keep failing at Meta, or a global code limit is used up: nothing is
        # tried (more sends would only fail, cost money or hurt the number's standing). Password sign-in is open meanwhile.
        raise OtpError(_whatsapp_paused_message(others), 503, otherChannels=others)

    length = cfg.code_length
    code = "".join(secrets.choice("0123456789") for _ in range(length))
    salt = secrets.token_hex(8)
    minutes = max(1, int(cfg.expiry_minutes))
    with transaction.atomic():
        # One request per employee at a time: the cooldown / allowance checks and the creation of the new code happen
        # under a lock on the employee row, so simultaneous requests cannot all pass the checks and send a message each
        # (the second one waits here, then sees the first one's new code and its cooldown). The lock is released at the
        # end of this block, BEFORE the (slow) send.
        if Employee.objects.select_for_update().filter(pk=employee.pk).first() is None:
            raise OtpError("You are not registered. Please contact HR.", 404)
        now = timezone.now()  # taken after the lock: a request that had to wait must not compute with an old clock
        # each channel counts its own codes: asking for an SMS after a WhatsApp code is not held up by WhatsApp's cooldown
        recent = EmployeeOtp.objects.filter(employee=employee, purpose=purpose).filter(_of_channel(cfg.channel))
        latest = recent.order_by("-created_at").first()
        if latest is not None:
            wait = cfg.resend_cooldown_seconds - int((now - latest.created_at).total_seconds())
            if wait > 0:
                raise OtpError(
                    f"Please wait {wait} seconds before asking for another code.",
                    429,
                    retryAfterSeconds=wait,
                    otherChannels=others,
                )
        if recent.filter(created_at__gte=now - timedelta(hours=1)).count() >= cfg.max_requests_per_hour:
            raise OtpError(
                "Too many codes requested. Please try again in an hour, or contact HR.", 429, otherChannels=others
            )
        if (
            cfg.max_requests_per_day is not None
            and recent.filter(created_at__gte=now - timedelta(hours=24)).count() >= cfg.max_requests_per_day
        ):
            raise OtpError(
                "Too many codes requested today. Please try again tomorrow, or contact HR.", 429, otherChannels=others
            )
        if cfg.channel == CHANNEL_WHATSAPP:
            # The global and per-number WhatsApp limits are checked, and the new code row that counts against them is
            # written, under a lock on the WhatsApp settings row: simultaneous requests for different employees can't
            # all slip under the same limit. (SMS does the same inside sms_service.)
            WhatsAppSettings.objects.select_for_update().filter(pk=snap.wa.pk).first()
            refused = _whatsapp_limit_refusal(phone, now, others)
            if refused:
                raise OtpError(*refused, otherChannels=others)
        # The new code is only ADDED here. The earlier codes are consumed after the send succeeded (below): consuming
        # them first meant that a send that failed or was blocked killed the employee's still-valid code.
        otp = EmployeeOtp.objects.create(
            employee=employee,
            purpose=purpose,
            code_hash=_hash(code, salt, employee.id, purpose),
            code_length=length,
            channel=cfg.channel,
            phone_number=phone,
            expires_at=now + timedelta(minutes=minutes),
            requested_ip=ip or "",
        )

    if cfg.channel == CHANNEL_SMS:
        sent = sms_service.send_otp(employee, purpose, code, minutes, phone=phone, ip=ip)
        if not sent.ok:
            # Nothing usable reached the employee (or a limit stopped the send): the new row goes; the employee's
            # previous code, if any, stays valid.
            otp.delete()
            raise OtpError(sent.message, sent.http_status, otherChannels=others)
        message = f"We've sent a code by SMS to {mask_phone(phone)}."
    else:
        if not _send_whatsapp_code(employee, purpose, code, minutes, phone):
            # Nothing usable reached the employee, so this code must not stay valid (and shouldn't count against their
            # allowance); the previous one stays valid.
            otp.delete()
            raise OtpError(
                "We couldn't send the code on WhatsApp. Please try again in a moment or contact HR.",
                502,
                otherChannels=others,
            )
        message = "We've sent a code to your WhatsApp."

    # Only the newest message may work: now that it really went out, the earlier codes (of either channel) die.
    _kill(EmployeeOtp.objects.filter(employee=employee, purpose=purpose).exclude(pk=otp.pk))

    return {
        "message": message,
        "maskedPhone": mask_phone(phone),
        "expiresInSeconds": minutes * 60,
        "resendAfterSeconds": cfg.resend_cooldown_seconds,
        "channel": cfg.channel,
        "codeLength": length,
        "otherChannels": others,
    }


def _kill(rows) -> int:
    """Consume the unused codes among `rows` without using them: consumed AND expired now (see verified_codes)."""
    now = timezone.now()
    return rows.filter(consumed_at__isnull=True).update(consumed_at=now, expires_at=now)


def _attempt_limit(otp: EmployeeOtp) -> int:
    """Wrong guesses allowed on this code: its own channel's limit."""
    if row_channel(otp) == CHANNEL_SMS:
        return _sms_config(SmsSettings.get()).max_attempts_per_code
    return MAX_ATTEMPTS


def _shape_message(purpose: str) -> str:
    lengths = sorted({code_length(c) for c in available_channels(purpose)})
    if len(lengths) == 1:
        return f"Enter the {lengths[0]}-digit code."
    if lengths:
        return "Enter the " + " or ".join(str(n) for n in lengths) + "-digit code."
    return "Enter the code we sent you."


def verify_otp(identifier: str | None, code: str | None, purpose: str) -> Employee:
    """Check a code and consume it. Returns the employee, or raises OtpError.
    Every failure a guesser could learn from is reported as the same generic
    "incorrect or expired" message."""
    if purpose not in _TYPE_FOR_PURPOSE:
        raise OtpError("Unknown purpose.")
    generic = OtpError("That code is incorrect or has expired. Please request a new one.", 400)
    # the code is JSON from the client: a number, a list ... is a 400 like any other malformed code, never a 500
    code = code.strip() if isinstance(code, str) else ""
    # Which length is right depends on the code row (each channel issues its own length), so here only the shapes any
    # channel can issue pass; the exact length is checked against the row below.
    if not (code.isascii() and code.isdigit()) or len(code) not in set(CODE_LENGTH.values()):
        raise OtpError(_shape_message(purpose))
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
    with transaction.atomic():
        otp = (
            EmployeeOtp.objects.select_for_update()
            .filter(employee=employee, purpose=purpose, consumed_at__isnull=True, expires_at__gt=timezone.now())
            .order_by("-created_at")
            .first()
        )
        if otp is not None:
            otp.attempts += 1
            if otp.attempts > _attempt_limit(otp):
                # dead: consumed AND expired now, so it never counts as verified
                otp.consumed_at = otp.expires_at = timezone.now()
                otp.save(update_fields=["attempts", "consumed_at", "expires_at"])
                outcome = "locked"
            elif len(code) != otp.code_length:
                # Not a guess at this code (a different length can never match): counted like one anyway, and answered
                # with the same generic sentence, so the length tells a prober nothing about whether a code is live.
                otp.save(update_fields=["attempts"])
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
    _kill(EmployeeOtp.objects.filter(employee=employee))

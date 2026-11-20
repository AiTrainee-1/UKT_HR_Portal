"""
Meta WhatsApp Cloud API client (2026-11-20): the ONLY module that talks to Meta's Graph API.

It knows Meta and nothing about the HRMS (no models, no switches, no employees): whatsapp_service / whatsapp_dispatcher
decide WHAT is sent and WHEN, this module sends it and reads Meta's state. Every business-started message is an
APPROVED Meta template.

Configuration (backend/.env locally, Railway Variables on the live server; never stored in the database, never returned
by an endpoint, never logged; see config/settings.py):

    WHATSAPP_CLOUD_PHONE_NUMBER_ID      the sending number's id (required)
    WHATSAPP_CLOUD_BUSINESS_ACCOUNT_ID  the WhatsApp Business Account (WABA) id: templates, pricing (required)
    WHATSAPP_CLOUD_ACCESS_TOKEN         the system-user token, secret (required)
    WHATSAPP_CLOUD_APP_SECRET           checks the webhook's X-Hub-Signature-256, secret (required for the webhook)
    WHATSAPP_CLOUD_WEBHOOK_VERIFY_TOKEN Meta's one-time webhook verification, secret (required for the webhook)
    WHATSAPP_CLOUD_API_VERSION          default v23.0
    WHATSAPP_CLOUD_TEMPLATE_LANGUAGE    default en
    WHATSAPP_CLOUD_API_BASE             default https://graph.facebook.com (host only, no version); http is accepted for a
                                        local address only (the e2e fake, frontend/e2e/fake-meta.mjs)

Every request goes to f"{API_BASE}/{API_VERSION}/{path}" with `Authorization: Bearer <token>` in a header (never in the
URL), and a timeout. The token and the app secret never reach an exception text, a returned answer or a log line.

Public API (whatsapp_service, the WhatsApp Control views and the template / usage modules code against exactly these):

    is_configured() -> bool
        PHONE_NUMBER_ID, BUSINESS_ACCOUNT_ID and ACCESS_TOKEN are all set (enough to send and to manage templates).
    missing_env() -> list[str]
        the NAMES of the required variables that are blank (the five marked required above), in that order.
    env_status() -> list[dict]
        [{"name", "set", "secret", "required"}] for every WHATSAPP_CLOUD_* variable (the Settings checklist). No value.
    api_version() / template_language() / api_base() -> str

    send_template(to, name, language, params: dict, header=None) -> str
        One template message; returns Meta's message id (the wamid the webhook refers to). `to` = digits with the
        country code ("919876543210"). `params` = {variable name: value} for a NAMED template (body parameters with
        parameter_name); when every key is a number ("1", "2" ...) the parameters are positional, in that order. Every
        value goes through sanitize_param. `header` = None, or {"type": "document"|"image"|"video", "id": <media id>,
        "filename": "slip.pdf"} (filename for documents only), or a ready Meta header parameter dict.
    send_auth_code(to, name, language, code) -> str
        An AUTHENTICATION (copy-code) template: the code as the body parameter AND as the URL button's parameter.
    upload_media(content: bytes, mime, filename) -> str
        POST /{PHONE_NUMBER_ID}/media (multipart); returns the media id (Meta keeps it 30 days).
    list_templates() -> list[dict]
        Every template of the WABA, Meta's own shape (id, name, status, category, language, components,
        quality_score, rejected_reason, parameter_format), following the paging cursors.
    create_template(payload: dict) -> dict
        POST /{WABA_ID}/message_templates; returns Meta's answer ({"id", "status", "category"}).
    delete_template(name, meta_id=None) -> dict
        DELETE /{WABA_ID}/message_templates?name=<name>[&hsm_id=<meta_id>] (with hsm_id only that language goes).
    phone_number_info() -> dict
        The number's state (display_phone_number, verified_name, quality_rating, messaging_limit_tier, status,
        name_status, code_verification_status, throughput, platform_type); retried with fewer fields when Meta says a
        field does not exist.
    pricing_analytics(start: date, end: date) -> list[dict]
        Meta's own cost figures for the WABA, one dict per day / pricing category / pricing type between the two dates
        (inclusive, IST): {"start", "end" (unix seconds), "date" (YYYY-MM-DD, IST), "volume", "cost",
        "pricing_category" (lowercase: authentication | utility | marketing | service ...), "pricing_type"}.

    sanitize_param(value) -> str
        A template variable as Meta accepts it: one line, no tabs, no runs of spaces, never empty ("-"), at most
        MAX_PARAM_LENGTH characters.
    verify_signature(raw_body: bytes, header: str | None) -> bool
        The webhook's X-Hub-Signature-256 (sha256=HMAC-SHA256(app secret, raw body)), compared in constant time. False
        when the app secret is not set.
    verify_token_matches(token) -> bool
        The webhook verification's hub.verify_token against WHATSAPP_CLOUD_WEBHOOK_VERIFY_TOKEN (constant time; False
        when it is not set).
    friendly_error(code, fallback="") -> str
        What a Meta error code means, in plain words for HR.

    MetaApiError(code, message, temporary=False, http_status=None, response=None)
        Anything that did not work. .code (Meta's error code, None for a network problem), .message (Meta's own
        explanation, the most specific it gave), .temporary (worth one retry later: 5xx, timeouts, rate limits),
        .http_status, .response (Meta's error object, token-free), .friendly (plain words), .account_level (the whole
        number/account cannot send: the queue pauses), .message_level (only this message / recipient / template is
        affected: never pauses the queue). str(e) = "<friendly> (code N)".
"""

from __future__ import annotations

import hashlib
import hmac
import logging
import re
from datetime import date, datetime, time as time_type, timedelta
from urllib.parse import quote, urlparse
from zoneinfo import ZoneInfo

import requests
from django.conf import settings as dj_settings

logger = logging.getLogger(__name__)

DEFAULT_API_BASE = "https://graph.facebook.com"
DEFAULT_API_VERSION = "v23.0"
DEFAULT_LANGUAGE = "en"
IST = ZoneInfo("Asia/Kolkata")

# (connect, read) timeouts: a send waits at most 20 s for Meta's answer (an OTP request is a person waiting), an upload
# 60 s, a read 15 s.
SEND_TIMEOUT = (5, 20)
UPLOAD_TIMEOUT = (5, 60)
READ_TIMEOUT = (5, 15)
MAX_TEMPLATE_PAGES = 50
# A template variable longer than this is cut (Meta refuses a filled body over 1024 characters, error 132005).
MAX_PARAM_LENGTH = 300

PHONE_FIELDS = (
    "display_phone_number,verified_name,quality_rating,messaging_limit_tier,status,name_status,"
    "code_verification_status,throughput,platform_type"
)
PHONE_FIELDS_BASIC = "display_phone_number,verified_name,quality_rating,status,name_status,platform_type,throughput"
TEMPLATE_FIELDS = "id,name,status,category,language,components,quality_score,rejected_reason,parameter_format"

# Worth one retry a minute later: Meta's own trouble, throughput / rate limits, "something went wrong".
TEMPORARY_CODES = frozenset({1, 2, 4, 17, 341, 80007, 130429, 131000, 131016, 131056, 133004})
# The whole number / account cannot send: the queue pauses at the first one (whatsapp_dispatcher).
ACCOUNT_CODES = frozenset({190, 368, 131031, 131042, 131048, 131057, 133010})
# Only this message (its recipient, its template or its variables) is affected: never counted against the account, so a
# few employees without WhatsApp never pause the queue.
MESSAGE_LEVEL_CODES = frozenset(
    {
        131026,
        131030,
        131047,
        131049,
        131050,
        131051,
        131052,
        131053,
        132000,
        132001,
        132005,
        132007,
        132012,
        132015,
        132016,
        132068,
        132069,
    }
)

FRIENDLY = {
    1: "Meta's API had an unknown problem; try again in a moment.",
    2: "Meta's service is temporarily unavailable; try again in a moment.",
    4: "Too many calls to Meta from this app right now; try again in a moment.",
    10: "The access token lacks a WhatsApp permission (whatsapp_business_messaging / whatsapp_business_management).",
    100: "Meta refused a parameter of the request (a wrong id, field or template component).",
    190: "The WhatsApp access token is invalid or has expired: create a new system-user token and update "
    "WHATSAPP_CLOUD_ACCESS_TOKEN.",
    200: "The access token lacks a permission for this WhatsApp Business Account.",
    368: "Meta has temporarily blocked this number for policy violations: check WhatsApp Manager -> Account quality.",
    80007: "The WhatsApp Business Account hit Meta's rate limit; try again later.",
    130429: "Sending too fast for Meta's throughput limit; the queue tries again later.",
    131000: "Something went wrong at Meta while sending; try again in a moment.",
    131016: "Meta's WhatsApp service is temporarily unavailable; try again in a moment.",
    131026: "The message could not be delivered: the number may not be on WhatsApp, or its WhatsApp app is too old.",
    131030: "This recipient is not on the test number's allowed list (add it in Meta's API Setup).",
    131031: "Meta has locked this WhatsApp Business Account: see WhatsApp Manager -> Account quality.",
    131042: "There is a payment problem on the WhatsApp Business Account: fix the payment method in WhatsApp Manager.",
    131047: "Free text is only allowed within 24 hours of the employee's last message: a template is needed.",
    131048: "Meta's spam limit was hit: too many messages were blocked or reported. Check WhatsApp Manager -> "
    "Account quality.",
    131049: "Meta chose not to deliver this message to keep the ecosystem healthy (keep templates factual and useful).",
    131050: "The person has stopped marketing messages from this business.",
    131051: "This message type is not supported.",
    131052: "The media file could not be downloaded from the employee's message.",
    131053: "The media file could not be uploaded to Meta (check its type and size).",
    131056: "Too many messages to the same number in a short time; the queue tries again later.",
    131057: "The WhatsApp Business Account is in maintenance mode at Meta.",
    132000: "The number of template variables sent does not match the approved template.",
    132001: "The template does not exist at Meta in this language, or it is not approved yet.",
    132005: "The message is too long once the variables are filled in: shorten the values.",
    132007: "The template's wording breaks a WhatsApp policy.",
    132012: "A template variable has the wrong format (new lines, tabs or too many spaces).",
    132015: "The template is paused by Meta because of low quality.",
    132016: "The template is disabled by Meta because of low quality.",
    132068: "The template's flow is blocked.",
    132069: "The template's flow is throttled.",
    133004: "Meta's server is temporarily unavailable; try again in a moment.",
    133010: "The phone number is not registered with the WhatsApp Cloud API: register it first.",
}

ENV_VARS = (
    # (setting name, secret, required)
    ("WHATSAPP_CLOUD_PHONE_NUMBER_ID", False, True),
    ("WHATSAPP_CLOUD_BUSINESS_ACCOUNT_ID", False, True),
    ("WHATSAPP_CLOUD_ACCESS_TOKEN", True, True),
    ("WHATSAPP_CLOUD_APP_SECRET", True, True),
    ("WHATSAPP_CLOUD_WEBHOOK_VERIFY_TOKEN", True, True),
    ("WHATSAPP_CLOUD_API_VERSION", False, False),
    ("WHATSAPP_CLOUD_TEMPLATE_LANGUAGE", False, False),
    ("WHATSAPP_CLOUD_API_BASE", False, False),
)
_SEND_ENV = ("WHATSAPP_CLOUD_PHONE_NUMBER_ID", "WHATSAPP_CLOUD_BUSINESS_ACCOUNT_ID", "WHATSAPP_CLOUD_ACCESS_TOKEN")


def friendly_error(code, fallback: str = "") -> str:
    try:
        code = int(code)
    except (TypeError, ValueError):
        return fallback or "WhatsApp (Meta) refused the request."
    return FRIENDLY.get(code) or fallback or f"WhatsApp (Meta) refused the request (error {code})."


class MetaApiError(Exception):
    """A Graph API call that did not work (see the module docstring)."""

    def __init__(self, code, message: str, temporary: bool = False, http_status: int | None = None, response=None):
        try:
            self.code = int(code) if code is not None else None
        except (TypeError, ValueError):
            self.code = None
        self.message = _scrub(str(message or ""))
        self.temporary = bool(temporary)
        self.http_status = http_status
        self.response = _scrub(response)
        super().__init__(str(self))

    @property
    def friendly(self) -> str:
        if self.code is None:
            return self.message or "WhatsApp (Meta) could not be reached."
        return friendly_error(self.code, self.message)

    @property
    def account_level(self) -> bool:
        return self.code in ACCOUNT_CODES

    @property
    def message_level(self) -> bool:
        return self.code in MESSAGE_LEVEL_CODES

    def __str__(self) -> str:
        if self.code is None:
            return self.friendly
        return f"{self.friendly} (code {self.code})"


# ── configuration ───────────────────────────────────────────────────────────────────


def _setting(name: str) -> str:
    return str(getattr(dj_settings, name, "") or "").strip()


def api_base() -> str:
    return (_setting("WHATSAPP_CLOUD_API_BASE") or DEFAULT_API_BASE).rstrip("/")


def api_version() -> str:
    return _setting("WHATSAPP_CLOUD_API_VERSION") or DEFAULT_API_VERSION


def template_language() -> str:
    return _setting("WHATSAPP_CLOUD_TEMPLATE_LANGUAGE") or DEFAULT_LANGUAGE


def base_is_local() -> bool:
    """Does WHATSAPP_CLOUD_API_BASE point at this machine (the e2e fake)? Such a "Meta" reaches nobody."""
    host = (urlparse(api_base()).hostname or "").lower()
    return host in ("localhost", "127.0.0.1", "::1")


def is_configured() -> bool:
    return all(_setting(name) for name in _SEND_ENV)


def missing_env() -> list[str]:
    return [name for name, _secret, required in ENV_VARS if required and not _setting(name)]


def env_status() -> list[dict]:
    return [
        {"name": name, "set": bool(_setting(name)), "secret": secret, "required": required}
        for name, secret, required in ENV_VARS
    ]


def _secrets() -> list[str]:
    return [s for s in (_setting("WHATSAPP_CLOUD_ACCESS_TOKEN"), _setting("WHATSAPP_CLOUD_APP_SECRET")) if s]


def _scrub(value):
    """`value` with the access token and the app secret removed wherever they appear, and any key that looks like a
    credential masked: what may be shown to HR, stored in a log row or written to a log line."""
    secrets = _secrets()
    if isinstance(value, str):
        for secret in secrets:
            if secret and secret in value:
                value = value.replace(secret, "***")
        return value
    if isinstance(value, dict):
        out = {}
        for k, v in value.items():
            if any(w in str(k).lower() for w in ("token", "secret", "password", "authorization")):
                out[k] = "***"
            else:
                out[k] = _scrub(v)
        return out
    if isinstance(value, (list, tuple)):
        return [_scrub(v) for v in list(value)[:50]]
    return value


def _url(path: str) -> str:
    base = api_base()
    parsed = urlparse(base)
    if parsed.scheme != "https" and not (parsed.scheme == "http" and base_is_local()):
        raise MetaApiError(
            None,
            "WHATSAPP_CLOUD_API_BASE must be an https address (plain http is accepted only for a local test server).",
        )
    return f"{base}/{quote(api_version(), safe='.')}/{path}"


def _id(name: str) -> str:
    value = _setting(name)
    if not value:
        raise MetaApiError(None, f"WhatsApp (Meta Cloud API) is not configured on this server: {name} is missing.")
    return quote(value, safe="")


def _headers() -> dict:
    token = _setting("WHATSAPP_CLOUD_ACCESS_TOKEN")
    if not token:
        raise MetaApiError(
            None, "WhatsApp (Meta Cloud API) is not configured on this server: WHATSAPP_CLOUD_ACCESS_TOKEN is missing."
        )
    return {"Authorization": f"Bearer {token}"}


def _request(method: str, path: str, *, timeout, **kwargs) -> dict:
    """One Graph API call; Meta's JSON answer, or MetaApiError."""
    url = _url(path)
    call = getattr(requests, method)
    try:
        resp = call(url, headers=_headers(), timeout=timeout, **kwargs)
    except requests.Timeout:
        raise MetaApiError(
            None, "Could not reach Meta (WhatsApp Cloud API): the request timed out.", temporary=True
        ) from None
    except requests.RequestException as exc:
        raise MetaApiError(
            None, f"Could not reach Meta (WhatsApp Cloud API): {type(exc).__name__}.", temporary=True
        ) from None
    return _answer(resp)


def _answer(resp) -> dict:
    status = getattr(resp, "status_code", 0) or 0
    try:
        data = resp.json() if getattr(resp, "content", b"") else {}
    except ValueError:
        data = {}
    if not isinstance(data, dict):
        data = {"data": data} if isinstance(data, list) else {}
    error = data.get("error")
    if status < 400 and not error:
        return data
    error = error if isinstance(error, dict) else {}
    code = error.get("code")
    details = (error.get("error_data") or {}).get("details") if isinstance(error.get("error_data"), dict) else None
    message = (
        details
        or error.get("error_user_msg")
        or error.get("message")
        or (str(getattr(resp, "text", "") or "")[:200].strip())
        or f"HTTP {status}"
    )
    try:
        numeric = int(code) if code is not None else None
    except (TypeError, ValueError):
        numeric = None
    temporary = status >= 500 or status == 429 or (numeric in TEMPORARY_CODES)
    raise MetaApiError(numeric, message, temporary=temporary, http_status=status or None, response=error or None)


# ── template variables ──────────────────────────────────────────────────────────────


def sanitize_param(value) -> str:
    """One line, no tabs, single spaces, never empty, at most MAX_PARAM_LENGTH characters (Meta's rules for a variable:
    "Param text cannot have new-line/tab characters or more than 4 consecutive spaces")."""
    text = " ".join(str("" if value is None else value).split())
    if len(text) > MAX_PARAM_LENGTH:
        text = text[: MAX_PARAM_LENGTH - 1].rstrip() + "…"
    return text or "-"


def _body_parameters(params: dict | None) -> list[dict]:
    params = params or {}
    keys = [str(k) for k in params]
    if keys and all(k.isdigit() for k in keys):  # a positional template: {{1}}, {{2}} ... in that order
        ordered = sorted(params.items(), key=lambda kv: int(str(kv[0])))
        return [{"type": "text", "text": sanitize_param(v)} for _, v in ordered]
    return [{"type": "text", "parameter_name": str(k), "text": sanitize_param(v)} for k, v in params.items()]


def _header_parameter(header) -> dict | None:
    if not header:
        return None
    kind = str(header.get("type") or "").lower()
    if kind in header:  # already Meta's shape: {"type": "document", "document": {...}} / {"type": "text", "text": ...}
        return header
    if kind in ("document", "image", "video"):
        media = {"id": str(header.get("id") or "")}
        if kind == "document" and header.get("filename"):
            media["filename"] = str(header["filename"])
        return {"type": kind, kind: media}
    raise ValueError(f"Unknown template header type: {kind!r}")


# ── sending ─────────────────────────────────────────────────────────────────────────


def _send(to: str, template: dict) -> str:
    body = {
        "messaging_product": "whatsapp",
        "recipient_type": "individual",
        "to": "".join(ch for ch in str(to or "") if ch.isdigit()),
        "type": "template",
        "template": template,
    }
    data = _request("post", f"{_id('WHATSAPP_CLOUD_PHONE_NUMBER_ID')}/messages", json=body, timeout=SEND_TIMEOUT)
    messages = data.get("messages") if isinstance(data.get("messages"), list) else []
    wamid = str((messages[0] or {}).get("id") or "") if messages and isinstance(messages[0], dict) else ""
    if not wamid:
        raise MetaApiError(None, "Meta answered without a message id: the message may not have been accepted.")
    return wamid


def send_template(to: str, name: str, language: str, params: dict | None, header=None) -> str:
    components = []
    header_param = _header_parameter(header)
    if header_param is not None:
        components.append({"type": "header", "parameters": [header_param]})
    body_params = _body_parameters(params)
    if body_params:
        components.append({"type": "body", "parameters": body_params})
    template = {"name": name, "language": {"code": language or template_language()}}
    if components:
        template["components"] = components
    return _send(to, template)


def send_auth_code(to: str, name: str, language: str, code: str) -> str:
    code = sanitize_param(code)
    return _send(
        to,
        {
            "name": name,
            "language": {"code": language or template_language()},
            "components": [
                {"type": "body", "parameters": [{"type": "text", "text": code}]},
                {"type": "button", "sub_type": "url", "index": "0", "parameters": [{"type": "text", "text": code}]},
            ],
        },
    )


def upload_media(content: bytes, mime: str, filename: str) -> str:
    data = _request(
        "post",
        f"{_id('WHATSAPP_CLOUD_PHONE_NUMBER_ID')}/media",
        data={"messaging_product": "whatsapp", "type": mime},
        files={"file": (filename or "file", content, mime)},
        timeout=UPLOAD_TIMEOUT,
    )
    media_id = str(data.get("id") or "")
    if not media_id:
        raise MetaApiError(None, "Meta answered the upload without a media id.")
    return media_id


# ── templates ───────────────────────────────────────────────────────────────────────


def list_templates() -> list[dict]:
    path = f"{_id('WHATSAPP_CLOUD_BUSINESS_ACCOUNT_ID')}/message_templates"
    params = {"fields": TEMPLATE_FIELDS, "limit": 100}
    found: list[dict] = []
    for _ in range(MAX_TEMPLATE_PAGES):
        data = _request("get", path, params=params, timeout=READ_TIMEOUT)
        found.extend(t for t in (data.get("data") or []) if isinstance(t, dict))
        paging = data.get("paging") if isinstance(data.get("paging"), dict) else {}
        after = (paging.get("cursors") or {}).get("after") if isinstance(paging.get("cursors"), dict) else None
        # The cursor, not paging.next: the next page is asked of the same configured host, never of an address taken
        # from an answer.
        if not paging.get("next") or not after:
            break
        params = {**params, "after": after}
    return found


def create_template(payload: dict) -> dict:
    return _request(
        "post",
        f"{_id('WHATSAPP_CLOUD_BUSINESS_ACCOUNT_ID')}/message_templates",
        json=payload,
        timeout=READ_TIMEOUT,
    )


def delete_template(name: str, meta_id: str | None = None) -> dict:
    params = {"name": name}
    if meta_id:
        params["hsm_id"] = str(meta_id)
    return _request(
        "delete",
        f"{_id('WHATSAPP_CLOUD_BUSINESS_ACCOUNT_ID')}/message_templates",
        params=params,
        timeout=READ_TIMEOUT,
    )


# ── the number and the money ────────────────────────────────────────────────────────


def phone_number_info() -> dict:
    path = _id("WHATSAPP_CLOUD_PHONE_NUMBER_ID")
    try:
        data = _request("get", path, params={"fields": PHONE_FIELDS}, timeout=READ_TIMEOUT)
    except MetaApiError as exc:
        if exc.code != 100:
            raise
        # An API version without one of the newer fields (messaging_limit_tier ...): ask for the basic ones.
        data = _request("get", path, params={"fields": PHONE_FIELDS_BASIC}, timeout=READ_TIMEOUT)
    return {k: v for k, v in data.items() if k != "id"}


def _ist_midnight(day: date) -> int:
    return int(datetime.combine(day, time_type(0, 0), tzinfo=IST).timestamp())


def pricing_analytics(start: date, end: date) -> list[dict]:
    if end < start:
        start, end = end, start
    since, until = _ist_midnight(start), _ist_midnight(end + timedelta(days=1))
    fields = (
        f"pricing_analytics.start({since}).end({until}).granularity(DAILY)"
        '.dimensions(["PRICING_CATEGORY","PRICING_TYPE"])'
    )
    data = _request("get", _id("WHATSAPP_CLOUD_BUSINESS_ACCOUNT_ID"), params={"fields": fields}, timeout=READ_TIMEOUT)
    analytics = data.get("pricing_analytics") if isinstance(data.get("pricing_analytics"), dict) else {}
    points: list[dict] = []
    for block in analytics.get("data") or []:
        for p in (block or {}).get("data_points") or []:
            if not isinstance(p, dict):
                continue
            try:
                begin = int(p.get("start") or 0)
            except (TypeError, ValueError):
                begin = 0
            points.append(
                {
                    "start": begin,
                    "end": p.get("end"),
                    "date": datetime.fromtimestamp(begin, IST).date().isoformat() if begin else None,
                    "volume": _number(p.get("volume"), int),
                    "cost": _number(p.get("cost"), float),
                    "pricing_category": str(p.get("pricing_category") or "").lower(),
                    "pricing_type": str(p.get("pricing_type") or ""),
                }
            )
    return points


def _number(value, kind):
    try:
        return kind(value or 0)
    except (TypeError, ValueError):
        return kind(0)


# ── the webhook ─────────────────────────────────────────────────────────────────────

_SIGNATURE = re.compile(r"^sha256=([0-9a-fA-F]{64})$")


def verify_signature(raw_body: bytes, header: str | None) -> bool:
    secret = _setting("WHATSAPP_CLOUD_APP_SECRET")
    match = _SIGNATURE.match((header or "").strip())
    if not secret or not match:
        return False
    expected = hmac.new(secret.encode("utf-8"), raw_body or b"", hashlib.sha256).hexdigest()
    return hmac.compare_digest(expected, match.group(1).lower())


def verify_token_matches(token) -> bool:
    expected = _setting("WHATSAPP_CLOUD_WEBHOOK_VERIFY_TOKEN")
    if not expected or not isinstance(token, str):
        return False
    return hmac.compare_digest(expected.encode("utf-8"), token.encode("utf-8"))

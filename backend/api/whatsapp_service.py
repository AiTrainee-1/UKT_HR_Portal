"""
WhatsApp notification service -the one place every HRMS module sends through
======================================================================
    HRMS module -> send_notification() / send_document() -> queued WhatsAppMessageLog row
                -> whatsapp_dispatcher (paced) -> deliver_template() -> Meta WhatsApp Cloud API -> employee

  * whatsapp_catalog     what each message is, its variables, its queue kind and its Meta template (meta_template /
                         meta_header / meta_category)
  * this module          switches (master, module, type, opt-out), which Meta template a type is sent as and whether it
                         is approved, the log rows, and the one send path to Meta (deliver_template / deliver_code)
  * whatsapp_cloud       the Graph API client (knows Meta, nothing about the HRMS)
  * whatsapp_dispatcher  the one paced sender: at least `min_gap_seconds` between messages, hourly / daily /
                         per-employee caps, quiet hours, today-only expiry, one retry for a temporary failure, a
                         circuit breaker
  * whatsapp_approvals / whatsapp_notifications / whatsapp_alerts
                         what to say for each HRMS event

Since 2026-11-20 WhatsApp goes through the official Meta WhatsApp Cloud API only. Meta lets a business
start a conversation with an APPROVED message template only, so:

  * every message type is sent as its template: WhatsAppSettings.template_overrides[type] when HR picked one, else the
    catalog's default `hrms_<type>` (MessageType.default_template_name; "-" = never sent through Meta). The template
    must be APPROVED in WhatsAppTemplate (the local mirror of Meta's list, kept by WhatsApp Control -> Templates and
    the webhook). A type without one is SKIPPED with a clear reason, never a provider failure (the queue never pauses
    for it).
  * the variables travel to Meta as the template's named parameters (whatsapp_cloud.sanitize_param flattens each value
    to one line). A queued row keeps them in payload["params"] until its turn; message_text is the rendered template
    body, for the history.
  * a document / ID card is uploaded to Meta (whatsapp_cloud.upload_media) when its row is sent and travels in the
    template's header; between queueing and sending the bytes wait in WhatsAppMediaAsset (no public link any more).
  * a one-time code goes as an AUTHENTICATION (copy-code) template (deliver_code).
  * groups and contact cards do not exist for templates: refused / not sent, with the reason.

Since 2026-11-06 nothing but a one-time code is sent from the request (or job) that raised it: everything else is
written as a `queued` row and leaves when the dispatcher's pacing allows. A code is sent at once (the employee is
waiting for it), blocked only by the master switch.

Every attempt -queued, sent, failed, expired, skipped, switched off by HR- ends up as a WhatsAppMessageLog row that HR
sees on the WhatsApp Control page, and a failed message never raises into the workflow that triggered it.

Public functions other modules use (names and contracts kept): send_notification, send_document, queue_document,
send_text, queue_to_recipient, accepted, engine_enabled, is_configured, has_credentials, sending_allowed,
sending_block_reason, recipient_block_reason, recipient_codes, allowed_numbers, development_machine, local_dev_server,
switch_off_reason, feature_enabled, opted_out, normalize_phone, render_message, build_document, expire_stale_pending,
is_group_id, fetch_groups (always refuses now), public_base_problem (always None now), WhatsAppServiceError.

New with Meta:
    template_name_for(document_type, s=None) -> str | None     the template a type is sent as (None: not via Meta)
    template_for(document_type, s=None) -> TemplateChoice       that template's local row, status, language, category,
                                                                header, variables, and `.problem` (why it can't be
                                                                sent now, or None)
    template_problem(document_type, s=None) -> str | None
    template_approved(document_type, s=None) -> bool
    deliver_template(to, document_type, params, *, media=None, media_id="", media_filename="", choice=None)
        -> SendResult(wamid, template_name, language, text, media_id)
                                                                THE send of one template message (the dispatcher and
                                                                the test message); raises WhatsAppServiceError
    deliver_code(to, document_type, code, *, minutes=None, choice=None) -> SendResult
                                                                a one-time code (otp_service through send_notification)
    phone_status(refresh=False) -> dict                         Meta's view of the number, cached 5 minutes

Credentials (WHATSAPP_CLOUD_*) are .env-only -see config/settings.py and whatsapp_cloud.py- never stored in the
database or editable from the UI.

send_document() / send_text() / send_notification() never raise for an "expected" failure (not configured, no phone on
file, switched off, template not approved, or a Meta API error).
"""

import logging
import os
import re
import secrets
import sys
from dataclasses import dataclass, field
from datetime import datetime, timedelta

from django.conf import settings as dj_settings
from django.core.cache import cache
from django.db import IntegrityError, transaction
from django.utils import timezone
from django.utils.module_loading import import_string

from . import push_messages
from . import whatsapp_catalog as catalog
from . import whatsapp_cloud as cloud

logger = logging.getLogger(__name__)

_MEDIA_ASSET_TTL = timedelta(hours=24)

# Derived from whatsapp_catalog (the single source); kept under these names for older callers.
DEFAULT_MESSAGES = {t.key: t.body for t in catalog.TYPES.values()}
PLACEHOLDER_HELP = {key: catalog.variable_help(key) for key in catalog.TYPES}
# Message type -> the WhatsAppSettings column that switches just that type on/off.
FEATURE_SWITCHES = {t.key: t.switch for t in catalog.TYPES.values() if t.switch}

# A row in one of these states was accepted for sending: it is queued, on its way, or the provider took it. An endpoint
# that sends one document reports success for these (the message may still be waiting for its turn in the queue).
ACCEPTED_STATUSES = ("queued", "sending", "sent", "delivered", "read")

REASON_OPTED_OUT = "This employee has opted out of WhatsApp messages: not sent."
REASON_QUIET = "Quiet hours: not sent"
REASON_NO_GROUPS = (
    "WhatsApp groups can't be messaged through the official WhatsApp Cloud API: add individual numbers instead."
)
# The texts the provider (or the way to it) produced, which the dispatcher's circuit breaker counts. A refusal of ONE
# message by Meta (its recipient, its template, its variables) starts with REFUSED_PREFIX and is never counted.
SEND_FAILED_PREFIX = "Send failed: "
REFUSED_PREFIX = "Refused by WhatsApp: "
UNREACHABLE_PREFIX = "Could not reach Meta"

# Documents built only when their turn comes (a bulk send must answer at once, not build a few hundred PDFs inside one
# web request): a name stored in the queued row's payload -> the function that returns the file's bytes.
DOCUMENT_BUILDERS = {"salary_slip": "api.salary_slip_views.whatsapp_slip_pdf"}

APPROVED = "APPROVED"
AUTHENTICATION = "AUTHENTICATION"
_MEDIA_HEADERS = ("document", "image", "video")


class WhatsAppServiceError(Exception):
    """A send that did not work. `temporary` is True for a failure worth ONE retry a minute later (Meta could not be
    reached, timed out, answered 5xx or a rate limit); everything else (a refused number, an unapproved template, a bad
    token) is final. `code` is Meta's error code when Meta answered with one."""

    def __init__(
        self,
        message: str = "",
        temporary: bool = False,
        http_status: int | None = None,
        provider_response=None,
        code: int | None = None,
        meta_message: str = "",
    ):
        super().__init__(message)
        self.temporary = temporary
        # what Meta answered, for the test message and the log (credentials never included)
        self.http_status = http_status
        self.provider_response = provider_response
        self.code = code
        self.meta_message = meta_message
        self.media_id = ""  # a file uploaded to Meta before the send itself failed (deliver_template)


def has_credentials() -> bool:
    """The Meta Cloud API variables needed to send are set (whatsapp_cloud.is_configured)."""
    return cloud.is_configured()


def sending_allowed() -> bool:
    """May this machine send WhatsApp messages? On a real server yes; on a development machine no, unless
    WHATSAPP_ALLOW_SENDING=true says otherwise (see config/settings.py for why)."""
    forced = getattr(dj_settings, "WHATSAPP_ALLOW_SENDING", None)
    if forced is not None:
        return bool(forced)
    return not dj_settings.DEBUG and "runserver" not in sys.argv


def development_machine() -> bool:
    """DEBUG on, or running under runserver: a developer's machine, never the real server."""
    return bool(dj_settings.DEBUG) or "runserver" in sys.argv


def provider_is_local() -> bool:
    """Is WHATSAPP_CLOUD_API_BASE on this machine (the e2e stack's fake Graph API, frontend/e2e/fake-meta.mjs)? Such a
    provider reaches nobody, so a development machine needs no recipient limit for it."""
    return cloud.base_is_local()


def local_dev_server() -> bool:
    """Is this Django's own development server (`manage.py runserver`) on a developer's machine? The ONLY place the
    WHATSAPP_ONLY_TO_EMPLOYEES recipient lock applies (owner 2026-11-18, after the lock reached production through a
    Railway variable: "the 30020 restriction must apply only to local development").

    Production never runs runserver (gunicorn on Railway, waitress on-premise), and Railway's own RAILWAY_ENVIRONMENT
    variable rules it out a second time. DEBUG is deliberately NOT a sign: a misconfigured DEBUG=true on the live server
    must never limit its messages."""
    if os.environ.get("RAILWAY_ENVIRONMENT") or os.environ.get("RAILWAY_ENVIRONMENT_NAME"):
        return False
    return "runserver" in sys.argv


def recipient_codes() -> list[str]:
    """The employee codes the local development server may message (WHATSAPP_ONLY_TO_EMPLOYEES). Always [] anywhere else:
    the restriction is for local testing only and is ignored in production even when the variable is set there, so
    production messages every eligible employee exactly as before."""
    if not local_dev_server():
        return []
    return list(getattr(dj_settings, "WHATSAPP_ONLY_TO_EMPLOYEES", None) or [])


def allowed_numbers() -> set[str] | None:
    """The phone numbers (normalised) this machine may message, or None when there is no limit. A real server has none.
    A development machine always has one (an empty set when no employee is named: nothing may be sent), except with a
    local fake Graph API (the e2e stack)."""
    if not local_dev_server():
        return None
    codes = recipient_codes()
    if not codes and provider_is_local():
        return None
    from .models import Employee

    phones = Employee.objects.filter(employee_code__in=codes).values_list("phone", flat=True)
    return {n for n in (normalize_phone(p) for p in phones) if n}


DEV_SAFETY = "Not sent (development safety)"


def recipient_block_reason(to: str | None) -> str | None:
    """Why this recipient (a number or a group id) may not be messaged from this machine, or None. The words never start
    like a provider failure, so a refusal here never pauses the send queue (whatsapp_dispatcher's circuit breaker)."""
    allowed = allowed_numbers()
    if allowed is None:
        return None
    codes = ", ".join(recipient_codes()) or "none set"
    if is_group_id(to or ""):
        return f"{DEV_SAFETY}: this machine may only message employee {codes} (WHATSAPP_ONLY_TO_EMPLOYEES), not groups."
    if (to or "") not in allowed:
        return f"{DEV_SAFETY}: this machine may only message employee {codes} (WHATSAPP_ONLY_TO_EMPLOYEES)."
    return None


def sending_block_reason() -> str | None:
    """Why nothing can be sent from here, or None when it can."""
    if not has_credentials():
        missing = [
            name
            for name in (
                "WHATSAPP_CLOUD_PHONE_NUMBER_ID",
                "WHATSAPP_CLOUD_BUSINESS_ACCOUNT_ID",
                "WHATSAPP_CLOUD_ACCESS_TOKEN",
            )
            if not str(getattr(dj_settings, name, "") or "").strip()
        ]
        return (
            "WhatsApp (Meta Cloud API) is not configured on this server (missing "
            f"{' / '.join(missing)} in .env, Railway Variables on the live server)."
        )
    if not sending_allowed():
        return (
            "WhatsApp sending is switched off on this machine because it is a development setup (DEBUG on or "
            "runserver), so it can't message employees from the live number. Set WHATSAPP_ALLOW_SENDING=true and "
            "WHATSAPP_ONLY_TO_EMPLOYEES=<your employee code> to send test messages to yourself only."
        )
    if local_dev_server() and not recipient_codes() and not provider_is_local():
        return (
            "This development machine may send WhatsApp only to the employees named in WHATSAPP_ONLY_TO_EMPLOYEES "
            "(for example WHATSAPP_ONLY_TO_EMPLOYEES=30020), and none is named, so nothing is sent."
        )
    return None


def is_configured() -> bool:
    """Credentials present AND this machine is allowed to send."""
    return sending_block_reason() is None


def normalize_phone(raw: str | None) -> str | None:
    """
    Employee.phone is stored as a plain local number (no country code, no formatting guarantees at all -it's a
    free-text field). Meta needs the full international number as digits only (no '+', spaces or punctuation).
    Prefixes WHATSAPP_DEFAULT_COUNTRY_CODE (default "91") only when the number doesn't already start with it. Returns
    None if there's nothing usable to send to, so callers can report "no phone on file" cleanly instead of sending
    garbage to the API.
    """
    if not raw:
        return None
    digits = "".join(ch for ch in raw if ch.isdigit())
    if not digits:
        return None
    country_code = dj_settings.WHATSAPP_DEFAULT_COUNTRY_CODE or "91"
    # "00" is the international dialling prefix, a single leading "0" the domestic trunk prefix.
    if digits.startswith("00"):
        digits = digits[2:]
    elif digits.startswith("0"):
        digits = digits[1:]
    # Already international only when the country code is followed by a full
    # 10-digit national number. Checking just "starts with 91" is wrong: many
    # valid Indian mobiles (9123456789, 9111111111 ...) begin with 91.
    if digits.startswith(country_code) and len(digits) >= len(country_code) + 10:
        return digits
    return f"{country_code}{digits}"


_PLACEHOLDER = re.compile(r"\{\{\s*([A-Za-z_][A-Za-z0-9_]*|\d+)\s*\}\}")


def _values(params, order: list[str] | None) -> dict[str, str]:
    """name -> text, also reachable by position ({{1}} = the first variable) so a positional template, or a caller that
    passes a list, keeps working."""
    order = order or []
    values: dict[str, str] = {}
    if isinstance(params, dict):
        values.update({str(k): "" if v is None else str(v) for k, v in params.items()})
        for i, name in enumerate(order, start=1):
            values.setdefault(str(i), values.get(name, ""))
    else:
        seq = ["" if v is None else str(v) for v in (params or [])]
        for i, v in enumerate(seq, start=1):
            values[str(i)] = v
        for i, name in enumerate(order):
            if i < len(seq):
                values.setdefault(name, seq[i])
    return values


def render_message(body: str, params, order: list[str] | None = None) -> str:
    """Fill {{name}} / {{1}} placeholders. `params` is a dict (by name) or a list (by position);
    `order` names the positions. A placeholder with no value renders empty rather than leaking
    "{{3}}" to a person, and a line whose placeholders are ALL empty is dropped, so an optional
    detail ("Note: {{comment}}") disappears instead of leaving an empty label."""
    values = _values(params, order)
    for retired in catalog.RETIRED_VARIABLES:
        values.pop(retired, None)
    lines = []
    for line in body.split("\n"):
        names = _PLACEHOLDER.findall(line)
        if not names:
            lines.append(line)
            continue
        # Wording saved long ago can still name a placeholder that was retired (the Employee Web App link): the
        # whole line goes, so an employee never gets a label with nothing after it, a raw {{...}} or an address.
        if any(n in catalog.RETIRED_VARIABLES for n in names):
            continue
        if all(not values.get(n, "").strip() for n in names):
            continue
        lines.append(_PLACEHOLDER.sub(lambda m: values.get(m.group(1), ""), line).rstrip())
    return re.sub(r"\n{3,}", "\n\n", "\n".join(lines)).strip()


def _order_for(document_type: str) -> list[str]:
    t = catalog.get(document_type)
    return t.variable_names if t else []


def _template_body(document_type: str) -> str:
    """The catalog's own wording of this type (what an HRMS template draft starts from). The wording HR used to save on
    the old Message Text tab is no longer sent: with Meta the wording IS the approved template."""
    return DEFAULT_MESSAGES.get(document_type, "")


# ── which Meta template a message type is sent as ─────────────────────────────────────


@dataclass(frozen=True)
class TemplateChoice:
    """The Meta template a message type goes out as, as this server last saw it (WhatsAppTemplate)."""

    document_type: str
    name: str | None  # None: the type is not sent through Meta at all
    language: str
    status: str  # Meta's status (APPROVED, PENDING, REJECTED, PAUSED ...), "MISSING" (no row here) or "NONE"
    category: str  # UTILITY | AUTHENTICATION | MARKETING
    row: object | None = field(default=None, compare=False)
    problem: str | None = None  # why it can't be sent now, or None

    @property
    def approved(self) -> bool:
        return self.problem is None

    def _component(self, kind: str) -> dict:
        for c in (getattr(self.row, "components", None) or []) if self.row is not None else []:
            if isinstance(c, dict) and str(c.get("type") or "").upper() == kind:
                return c
        return {}

    @property
    def header(self) -> str:
        """ "" | "document" | "image" | "video" | "text": what the template's header holds. From the template Meta
        approved when this server has its components, else the catalog's meta_header."""
        found = self._component("HEADER")
        if found:
            return str(found.get("format") or "text").lower()
        if self.row is not None and getattr(self.row, "components", None):
            return ""
        spec = catalog.get(self.document_type)
        return spec.meta_header if spec else ""

    @property
    def body_text(self) -> str:
        return str(self._component("BODY").get("text") or "")

    @property
    def header_text(self) -> str:
        found = self._component("HEADER")
        return str(found.get("text") or "") if str(found.get("format") or "").upper() == "TEXT" else ""

    @property
    def variable_names(self) -> list[str]:
        """The template's own variables, in order: from its body when this server has it, else the catalog's."""
        body = self.body_text
        if body:
            seen: list[str] = []
            for name in _PLACEHOLDER.findall(body):
                if name not in seen:
                    seen.append(name)
            return seen
        if self.category == AUTHENTICATION:
            return ["code"]
        return _order_for(self.document_type)


def template_name_for(document_type: str, s=None) -> str | None:
    """The Meta template this type is sent as: HR's choice (WhatsAppSettings.template_overrides), else the catalog's
    default name. None: the type is never sent through Meta (catalog meta_template "-", or not in the catalog)."""
    spec = catalog.get(document_type)
    if spec is None or spec.default_template_name is None:
        return None
    if s is None:
        from .models import WhatsAppSettings

        s = WhatsAppSettings.get()
    override = str((s.template_overrides or {}).get(document_type) or "").strip()
    return override or spec.default_template_name


def _pick(rows: list, language: str):
    """Approved in the configured language, else approved in any language, else the configured language's row, else
    any: the row whose status explains the most."""
    for test in (
        lambda r: r.status == APPROVED and r.language == language,
        lambda r: r.status == APPROVED,
        lambda r: r.language == language,
        lambda r: True,
    ):
        for r in rows:
            if test(r):
                return r
    return None


def template_for(document_type: str, s=None) -> TemplateChoice:
    from .models import WhatsAppSettings, WhatsAppTemplate

    spec = catalog.get(document_type)
    label = spec.label if spec else document_type
    category = spec.meta_category if spec else "UTILITY"
    language = cloud.template_language()
    s = s or WhatsAppSettings.get()
    name = template_name_for(document_type, s)
    if name is None:
        return TemplateChoice(
            document_type,
            None,
            language,
            "NONE",
            category,
            None,
            f"'{label}' is not sent through the WhatsApp Cloud API (it has no Meta template): not sent.",
        )
    row = _pick(list(WhatsAppTemplate.objects.filter(name=name)), language)
    if row is None:
        return TemplateChoice(
            document_type,
            name,
            language,
            "MISSING",
            category,
            None,
            f"The WhatsApp template '{name}' for '{label}' is not on this server yet: create it (or Sync now) on "
            "WhatsApp Control -> Templates. Not sent.",
        )
    status = str(row.status or "").upper()
    problem = None
    if status != APPROVED:
        problem = f"The WhatsApp template '{name}' is {status or 'not submitted'} at Meta, not approved yet: not sent."
        if status == "REJECTED" and row.rejected_reason:
            problem = f"The WhatsApp template '{name}' was rejected by Meta ({row.rejected_reason}): not sent."
    return TemplateChoice(
        document_type, name, row.language or language, status, (row.category or category).upper(), row, problem
    )


def template_problem(document_type: str, s=None) -> str | None:
    return template_for(document_type, s).problem


def template_approved(document_type: str, s=None) -> bool:
    return template_for(document_type, s).problem is None


def template_params(choice: TemplateChoice, values: dict[str, str]) -> dict[str, str]:
    """{variable: value} for exactly the variables the template has (a missing value is sent as "-")."""
    return {name: values.get(name, "") for name in choice.variable_names}


def _fill(text: str, values: dict[str, str]) -> str:
    return _PLACEHOLDER.sub(lambda m: cloud.sanitize_param(values.get(m.group(1), "")), text)


def render_auth_text(code: str, choice: TemplateChoice | None = None, minutes=None) -> str:
    """What an AUTHENTICATION (copy-code) template looks like on the phone (Meta writes the words itself)."""
    text = f"{code} is your verification code."
    body = choice._component("BODY") if choice is not None else {}
    footer = choice._component("FOOTER") if choice is not None else {}
    if body.get("add_security_recommendation", True):
        text += " For your security, do not share this code."
    expiry = footer.get("code_expiration_minutes") or minutes
    if expiry:
        text += f"\nThis code expires in {expiry} minutes."
    return text


def render_template_text(choice: TemplateChoice, params) -> str:
    """The template's body with the variables filled in (what the employee reads), for the log and the previews. Falls
    back to the catalog's wording when this server does not have the template's text."""
    values = _values(params, _order_for(choice.document_type))
    if choice.category == AUTHENTICATION:
        return render_auth_text(values.get("code") or values.get("1") or "", choice, values.get("minutes"))
    if choice.body_text:
        return _fill(choice.body_text, values).strip()
    return render_message(_template_body(choice.document_type), values, _order_for(choice.document_type))


@dataclass
class SendResult:
    wamid: str
    template_name: str
    language: str
    text: str
    media_id: str = ""


def _service_error(exc: "cloud.MetaApiError") -> WhatsAppServiceError:
    if exc.code is None and exc.temporary:
        text = exc.friendly  # "Could not reach Meta (WhatsApp Cloud API): ..."
    elif exc.message_level:
        text = f"{REFUSED_PREFIX}{exc}"
    else:
        text = f"{SEND_FAILED_PREFIX}{exc}"
    return WhatsAppServiceError(
        text[:1000],
        temporary=exc.temporary,
        http_status=exc.http_status,
        provider_response=exc.response,
        code=exc.code,
        meta_message=exc.message,
    )


def _guard(to: str) -> None:
    """The last line of defence, in front of every call that reaches Meta: credentials, this machine's rules, and the
    development-machine recipient lock."""
    blocked = sending_block_reason()
    if blocked:
        raise WhatsAppServiceError(blocked)
    if is_group_id(to or ""):
        raise WhatsAppServiceError(REASON_NO_GROUPS)
    refused = recipient_block_reason(to)
    if refused:
        raise WhatsAppServiceError(refused)


def deliver_template(
    to: str,
    document_type: str,
    params,
    *,
    media=None,
    media_id: str = "",
    media_filename: str = "",
    choice: TemplateChoice | None = None,
) -> SendResult:
    """Send one message of `document_type` to `to` (digits with the country code) as its APPROVED template, NOW. The
    only path to Meta for everything but a one-time code. `params`: the type's variables (dict by name or list by
    position). `media`: the file of a document / ID card, (bytes, filename, mime type) or a function returning that
    (called only when the message really goes); `media_id` reuses a file already uploaded (a retry). Raises
    WhatsAppServiceError; Meta's refusals keep its code (`.code`) and its words (`.meta_message`)."""
    _guard(to)
    choice = choice or template_for(document_type)
    if choice.problem:
        raise WhatsAppServiceError(choice.problem)
    if choice.category == AUTHENTICATION:
        values = _values(params, _order_for(document_type))
        return deliver_code(to, document_type, values.get("code") or values.get("1") or "", choice=choice)
    values = _values(params, _order_for(document_type))
    header = None
    fmt = choice.header
    try:
        if fmt in _MEDIA_HEADERS:
            filename = media_filename
            if not media_id:
                if media is None:
                    raise WhatsAppServiceError(f"The {fmt} of this message is missing: not sent.")
                content, filename, mime_type = media() if callable(media) else media
                media_id = cloud.upload_media(content, mime_type, filename)
            header = {"type": fmt, "id": media_id, "filename": filename or "document.pdf"}
        elif media is not None or media_id:
            raise WhatsAppServiceError(
                f"The WhatsApp template '{choice.name}' has no document or image header, so the file can't be attached: "
                "not sent."
            )
        elif fmt == "text" and choice.header_text:
            names = _PLACEHOLDER.findall(choice.header_text)
            if names:
                header = {
                    "type": "text",
                    "parameter_name": names[0],
                    "text": cloud.sanitize_param(values.get(names[0])),
                }
                if names[0].isdigit():
                    header.pop("parameter_name")
        wamid = cloud.send_template(to, choice.name, choice.language, template_params(choice, values), header)
    except cloud.MetaApiError as exc:
        error = _service_error(exc)
        error.media_id = media_id  # a file already uploaded: a retry reuses it
        raise error from None
    return SendResult(wamid, choice.name, choice.language, render_template_text(choice, values), media_id)


def deliver_code(
    to: str, document_type: str, code: str, *, minutes=None, choice: TemplateChoice | None = None
) -> SendResult:
    """A one-time code NOW, as the type's AUTHENTICATION (copy-code) template (the code is the body parameter and the
    copy button's). A type pointed at a non-authentication template sends {code, minutes} as its variables instead.
    `text` of the result carries the code: the caller logs a redacted text."""
    _guard(to)
    choice = choice or template_for(document_type)
    if choice.problem:
        raise WhatsAppServiceError(choice.problem)
    code = str(code or "").strip()
    if not code:
        raise WhatsAppServiceError("No code to send.")
    try:
        if choice.category == AUTHENTICATION:
            wamid = cloud.send_auth_code(to, choice.name, choice.language, code)
            return SendResult(wamid, choice.name, choice.language, render_auth_text(code, choice, minutes))
        values = {"code": code, "minutes": "" if minutes is None else str(minutes), "1": code}
        if minutes is not None:
            values["2"] = str(minutes)
        wamid = cloud.send_template(to, choice.name, choice.language, template_params(choice, values))
    except cloud.MetaApiError as exc:
        raise _service_error(exc) from None
    return SendResult(wamid, choice.name, choice.language, render_template_text(choice, values))


# ── Meta's view of the number ───────────────────────────────────────────────────────

_PHONE_CACHE_KEY = "whatsapp_cloud:phone_status"
_PHONE_CACHE_SECONDS = 300


def phone_status(refresh: bool = False) -> dict:
    """Meta's view of the sending number, cached 5 minutes (refresh=True asks Meta now). Sends nothing; allowed on any
    machine (it needs the credentials only).

    {"ok": True, "phone": {displayPhoneNumber, verifiedName, qualityRating, messagingLimitTier, status, nameStatus,
    codeVerificationStatus, throughput, platformType}, "tokenOk": True, "checkedAt"} or {"ok": False, "phone": None,
    "tokenOk": False (Meta refused the token) | None (not configured / not known), "error", "code", "checkedAt"}."""
    if not cloud.is_configured():
        return {
            "ok": False,
            "phone": None,
            "tokenOk": None,
            "error": "WhatsApp (Meta Cloud API) is not configured on this server.",
            "code": None,
            "checkedAt": None,
        }
    if not refresh:
        cached = cache.get(_PHONE_CACHE_KEY)
        if cached is not None:
            return cached
    now = timezone.now().isoformat()
    try:
        info = cloud.phone_number_info()
    except cloud.MetaApiError as exc:
        result = {
            "ok": False,
            "phone": None,
            "tokenOk": False if exc.code in (190, 10, 200) else None,
            "error": str(exc),
            "code": exc.code,
            "checkedAt": now,
        }
        cache.set(_PHONE_CACHE_KEY, result, 60)  # a failure is asked again sooner
        return result
    throughput = info.get("throughput")
    result = {
        "ok": True,
        "phone": {
            "displayPhoneNumber": info.get("display_phone_number"),
            "verifiedName": info.get("verified_name"),
            "qualityRating": info.get("quality_rating"),
            "messagingLimitTier": info.get("messaging_limit_tier"),
            "status": info.get("status"),
            "nameStatus": info.get("name_status"),
            "codeVerificationStatus": info.get("code_verification_status"),
            "throughput": throughput.get("level") if isinstance(throughput, dict) else throughput,
            "platformType": info.get("platform_type"),
        },
        "tokenOk": True,
        "error": None,
        "code": None,
        "checkedAt": now,
    }
    cache.set(_PHONE_CACHE_KEY, result, _PHONE_CACHE_SECONDS)
    return result


# ── public base address (the webhook URL HR pastes into Meta) ───────────────────────


def _backend_public_base_url(request) -> str:
    """This server's public origin: settings.BACKEND_PUBLIC_URL when set (a proxy / tunnel whose Host header is not the
    public one), else the request's own origin. Used for the webhook address WhatsApp Control shows."""
    if dj_settings.BACKEND_PUBLIC_URL:
        return dj_settings.BACKEND_PUBLIC_URL.rstrip("/")
    if request is None:
        return ""
    return request.build_absolute_uri("/").rstrip("/")


def public_base_problem(base: str) -> str | None:
    """Kept for older callers: with Meta a file is uploaded to WhatsApp (whatsapp_cloud.upload_media), so no public
    address of this server is needed for documents any more. Always None."""
    return None


# ── documents waiting for their turn ────────────────────────────────────────────────


def _store_media(file_bytes: bytes, filename: str, mime_type: str) -> str:
    """Keep a document's bytes until its queued row is sent (WhatsAppMediaAsset, addressed by a random token; nothing
    serves it publicly). Also lazily prunes rows past their expiry (a queued row never outlives its day)."""
    from .models import WhatsAppMediaAsset

    WhatsAppMediaAsset.objects.filter(expires_at__lt=timezone.now()).delete()

    token = secrets.token_urlsafe(32)
    WhatsAppMediaAsset.objects.create(
        token=token,
        content=file_bytes,
        filename=filename,
        mime_type=mime_type,
        expires_at=timezone.now() + _MEDIA_ASSET_TTL,
    )
    return token


def load_media(token: str) -> tuple[bytes, str, str] | None:
    """(bytes, filename, mime type) of a stored document, or None when it is gone."""
    from .models import WhatsAppMediaAsset

    asset = WhatsAppMediaAsset.objects.filter(token=token).first() if token else None
    if asset is None:
        return None
    return bytes(asset.content), asset.filename, asset.mime_type


# ── groups and contact cards: not available with templates ──────────────────────────

GROUP_SUFFIX = "@g.us"


def is_group_id(value) -> bool:
    """A WhatsApp group's id ("120363…@g.us"), as the old WhatsApp Web link listed them. Meta's templates cannot reach a group:
    such a recipient is refused (REASON_NO_GROUPS)."""
    return isinstance(value, str) and value.endswith(GROUP_SUFFIX) and value[: -len(GROUP_SUFFIX)].isdigit()


def fetch_groups() -> list[dict]:
    """Kept for older callers: there are no groups with the official WhatsApp Cloud API. Always raises."""
    raise WhatsAppServiceError(REASON_NO_GROUPS)


# ── switches ────────────────────────────────────────────────────────────────────────


def engine_enabled(s=None) -> bool:
    """The master switch (WhatsApp Control): False stops EVERY WhatsApp message, one-time codes included."""
    from .models import WhatsAppSettings

    return bool((s or WhatsAppSettings.get()).engine_enabled)


def switch_off_reason(document_type: str, related_module: str = "", s=None) -> str | None:
    """Why HR's switches say this message must not go out, or None when it may. A message is sent only when the master
    switch, its module's switch, and its own switch are all on: its own boolean where it has one, and it is not in the
    list of types switched off one by one (WhatsAppSettings.disabled_message_types). The shared approval wording also
    needs that approval workflow's switch."""
    t = catalog.get(document_type)
    if t is None:
        return None
    from .models import WhatsAppSettings

    s = s or WhatsAppSettings.get()
    if not s.engine_enabled:
        return "WhatsApp sending is switched off (master switch) on the WhatsApp Control page."
    if t.switch and not getattr(s, t.switch):
        return f"'{t.label}' is switched off on the WhatsApp Control page."
    if document_type in (s.disabled_message_types or []):
        return f"'{t.label}' is switched off on the WhatsApp Control page."
    master = catalog.MODULE_SWITCHES.get(t.module)
    if master and not getattr(s, master):
        return f"{catalog.MODULES[t.module]} notifications are switched off on the WhatsApp Control page."
    if t.module == "approvals" and related_module and related_module in (s.disabled_approval_modules or []):
        name = catalog.APPROVAL_MODULES.get(related_module, related_module)
        return f"{name} approval messages are switched off on the WhatsApp Control page."
    return None


def feature_enabled(document_type: str, related_module: str = "") -> bool:
    """False when HR has switched this message type (or its whole module, or WhatsApp itself) off on the
    WhatsApp Control page."""
    return switch_off_reason(document_type, related_module) is None


def opted_out(employee) -> bool:
    """Has this employee opted out of WhatsApp notifications and documents (WhatsApp Control -> Employees, or a STOP
    reply)? A code they ask for themselves still goes."""
    from .models import WhatsAppOptOut

    emp_id = employee if isinstance(employee, int) else getattr(employee, "pk", None)  # an employee or its id
    return bool(emp_id) and WhatsAppOptOut.objects.filter(employee_id=emp_id).exists()


def accepted(log) -> bool:
    """Was this send accepted (queued, on its way, or taken by the provider)? See ACCEPTED_STATUSES."""
    return log is not None and log.status in ACCEPTED_STATUSES


def _inline_delivery() -> bool:
    """settings.WHATSAPP_ASYNC_SEND False (always under `manage.py test`): a queued row is delivered at once, inside the
    call that queued it, ignoring the pacing, caps and quiet hours, so a test sees the outcome straight away. Never set
    it on a real server: it would bypass everything that keeps the number from being restricted."""
    return not dj_settings.WHATSAPP_ASYNC_SEND


# ── the log rows and the queue ──────────────────────────────────────────────────────


def _named_params(document_type: str, params) -> dict[str, str]:
    """The variables as {name: value} for the queued row's payload (what the dispatcher sends later)."""
    values = _values(params, _order_for(document_type))
    names = _order_for(document_type) or [k for k in values if not k.isdigit()]
    out = {name: values.get(name, "") for name in names}
    for k, v in values.items():  # a variable a custom template has that the catalog does not list
        if not k.isdigit():
            out.setdefault(k, v)
    return out


def _log_text(document_type: str, params, choice: TemplateChoice | None = None) -> str:
    """What the message says, for the history: the template's text filled in (the catalog's wording when this server
    does not have the template's text yet)."""
    if choice is not None and choice.name and choice.category != AUTHENTICATION:
        return render_template_text(choice, params)
    return render_message(_template_body(document_type), params, _order_for(document_type))


def _log(
    employee,
    document_type: str,
    document_ref_id,
    phone_number: str,
    status: str,
    provider_message_id: str = "",
    error_message: str = "",
    sent_by_id=None,
    message_text: str = "",
    dedupe_key: str = "",
    related_module: str = "",
    payload: dict | None = None,
    priority: int | None = None,
    template_name: str = "",
):
    from .models import WhatsAppMessageLog

    spec = catalog.get(document_type)
    return WhatsAppMessageLog.objects.create(
        employee=employee,
        document_type=document_type,
        document_ref_id=document_ref_id,
        phone_number=phone_number or "",
        status=status,
        provider_message_id=provider_message_id,
        error_message=error_message,
        sent_by_id=sent_by_id,
        message_text=message_text,
        dedupe_key=dedupe_key,
        related_module=related_module,
        kind=spec.kind if spec else catalog.KIND_AUTOMATIC,
        priority=priority if priority is not None else (spec.priority if spec else 5),
        payload=payload or {},
        template_name=template_name or "",
    )


def _precheck(employee, document_type, document_ref_id, sent_by_id, params, payload=None, priority=None):
    """Shared guard clauses for the document / text send paths. Returns (phone, text, choice, stopped_log): when
    stopped_log is set, the send must stop and return it (a failed row for a switch or a missing phone, a skipped row
    for an employee who opted out, quiet hours, or a template that is not approved)."""
    phone = normalize_phone(getattr(employee, "phone", None))
    choice = None

    def stop(msg, status="failed", text=""):
        return _log(
            employee,
            document_type,
            document_ref_id,
            phone or "",
            status,
            error_message=msg,
            sent_by_id=sent_by_id,
            message_text=text,
            payload=payload,
            priority=priority,
            template_name=(choice.name or "") if choice is not None else "",
        )

    blocked = sending_block_reason()
    if blocked:
        return phone, None, None, stop(blocked)
    if not phone:
        return phone, None, None, stop("No phone number on file for this employee.")
    off = switch_off_reason(document_type)
    if off:
        return phone, None, None, stop(off)
    choice = template_for(document_type)
    text = _log_text(document_type, params, choice)
    if opted_out(employee):
        return phone, None, choice, stop(REASON_OPTED_OUT, "skipped", text)
    if choice.problem:
        return phone, None, choice, stop(choice.problem, "skipped", text)
    if not _inline_delivery():
        from . import whatsapp_dispatcher

        if whatsapp_dispatcher.in_quiet_hours():
            return phone, None, choice, stop(REASON_QUIET, "skipped", text)
    return phone, text, choice, None


def _queue_row(employee, document_type, phone, text, *, document_ref_id, sent_by_id, payload, priority, choice=None):
    """Write the queued row of a document / text send (no dedupe key), and deliver it at once in inline mode."""
    from . import whatsapp_dispatcher
    from .models import WhatsAppMessageLog, WhatsAppSettings

    now = timezone.now()
    spec = catalog.get(document_type)
    log = WhatsAppMessageLog.objects.create(
        employee=employee,
        document_type=document_type,
        document_ref_id=document_ref_id,
        phone_number=phone,
        status=WhatsAppMessageLog.STATUS_QUEUED,
        sent_by_id=sent_by_id,
        message_text=text,
        kind=spec.kind if spec else catalog.KIND_DOCUMENT,
        priority=priority if priority is not None else (spec.priority if spec else 3),
        send_after=now,
        expires_at=whatsapp_dispatcher.expiry_for(document_type, WhatsAppSettings.get(), now),
        payload=payload,
        template_name=(choice.name or "") if choice is not None else "",
    )
    if _inline_delivery():
        return whatsapp_dispatcher.deliver_now(log)
    return log


def send_document(
    request,
    employee,
    document_type: str,
    pdf_bytes: bytes,
    filename: str,
    body_params,
    mime_type: str = "application/pdf",
    document_ref_id: int | None = None,
    sent_by_id: int | None = None,
):
    """
    The one entry point every single-document send endpoint calls. Normalizes the phone, checks the switches and the
    type's template, keeps the file (WhatsAppMediaAsset) and QUEUES the message (the dispatcher uploads the file to
    Meta and sends it in the template's header when the pacing allows, usually within a minute). Always returns a
    WhatsAppMessageLog row: queued when accepted, failed (not configured / no phone / switched off) or skipped (opted
    out, quiet hours, template not approved) otherwise, so callers never need their own try/except to get a uniform
    result to report back to the user. Report success with `accepted(log)`.

    `request` is accepted for older callers and not needed any more (Meta takes the file as an upload, so no public
    link of this server is built).
    """
    # the event, told on the phone by Phone Notify Control with its own settings and wording (push_messages.py)
    push_messages.announce(employee, document_type, params=body_params)
    phone, text, choice, stopped = _precheck(employee, document_type, document_ref_id, sent_by_id, body_params)
    if stopped is not None:
        return stopped
    token = _store_media(pdf_bytes, filename, mime_type)
    payload = {
        "params": _named_params(document_type, body_params),
        "media_token": token,
        "filename": filename,
        "mime_type": mime_type,
    }
    return _queue_row(
        employee,
        document_type,
        phone,
        text,
        document_ref_id=document_ref_id,
        sent_by_id=sent_by_id,
        payload=payload,
        priority=None,
        choice=choice,
    )


def queue_document(
    request,
    employee,
    document_type: str,
    body_params,
    *,
    build: str,
    build_args: dict,
    filename: str,
    mime_type: str = "application/pdf",
    document_ref_id: int | None = None,
    sent_by_id: int | None = None,
    batch_id: str = "",
):
    """One document of a BULK send: queued without its file, which the dispatcher builds when the row's turn comes
    (DOCUMENT_BUILDERS[build](**build_args)), so the request that queues a few hundred answers at once. Every row of
    one bulk send carries `batch_id` in its payload (whatsapp_bulk_progress reads the batch's progress from the rows)
    and goes behind everything time-critical (catalog.PRIORITY_BULK). Same return contract as send_document."""
    if build not in DOCUMENT_BUILDERS:
        raise ValueError(f"Unknown document builder: {build}")
    push_messages.announce(employee, document_type, params=body_params)  # Phone Notify Control's own notification
    marker = {"batch": batch_id} if batch_id else {}
    phone, text, choice, stopped = _precheck(
        employee,
        document_type,
        document_ref_id,
        sent_by_id,
        body_params,
        payload=marker,
        priority=catalog.PRIORITY_BULK,
    )
    if stopped is not None:
        return stopped
    payload = {
        **marker,
        "params": _named_params(document_type, body_params),
        "build": build,
        "build_args": build_args,
        "filename": filename,
        "mime_type": mime_type,
    }
    return _queue_row(
        employee,
        document_type,
        phone,
        text,
        document_ref_id=document_ref_id,
        sent_by_id=sent_by_id,
        payload=payload,
        priority=catalog.PRIORITY_BULK,
        choice=choice,
    )


def build_document(name: str, args: dict) -> bytes:
    """The bytes of a document queued without its file (queue_document)."""
    return import_string(DOCUMENT_BUILDERS[name])(**(args or {}))


def send_text(
    employee,
    document_type: str,
    body_params,
    document_ref_id: int | None = None,
    sent_by_id: int | None = None,
):
    """Same contract as send_document above (always returns a WhatsAppMessageLog row, never raises) but a template with
    no attachment, queued like every other non-code message."""
    phone, text, choice, stopped = _precheck(employee, document_type, document_ref_id, sent_by_id, body_params)
    if stopped is not None:
        return stopped
    return _queue_row(
        employee,
        document_type,
        phone,
        text,
        document_ref_id=document_ref_id,
        sent_by_id=sent_by_id,
        payload={"params": _named_params(document_type, body_params)},
        priority=None,
        choice=choice,
    )


def _send_code_now(log, phone: str, params, log_params=None):
    """A one-time code: sent from the request that asked for it (the employee is waiting), outcome recorded on its
    pending row. It counts as the last message sent for the queue's gap. The row's text is the code-free version."""
    from .models import WhatsAppMessageLog

    log.attempts = 1
    values = _values(params, _order_for(log.document_type))
    code = values.get("code") or values.get("1") or ""
    minutes = values.get("minutes") or values.get("2") or None
    try:
        choice = template_for(log.document_type)
        log.template_name = choice.name or ""
        result = deliver_code(phone, log.document_type, code, minutes=minutes, choice=choice)
    except WhatsAppServiceError as exc:
        log.status = WhatsAppMessageLog.STATUS_FAILED
        log.error_message = str(exc)[:1000]
    except Exception as exc:  # never leave a row pending because of a bug in a helper
        logger.exception("Unexpected error sending WhatsApp code %s", log.id)
        log.status = WhatsAppMessageLog.STATUS_FAILED
        log.error_message = f"Unexpected error: {exc}"
    else:
        log.status = WhatsAppMessageLog.STATUS_SENT
        log.provider_message_id = result.wamid
        log.sent_at = timezone.now()
        log.template_name = result.template_name
    if log_params is not None or code:
        hidden = _values(log_params, _order_for(log.document_type)) if log_params is not None else {}
        shown = hidden.get("code") or hidden.get("1") or "••••••"
        log.message_text = render_auth_text(shown, None, minutes)
    log.save(
        update_fields=[
            "status",
            "error_message",
            "provider_message_id",
            "sent_at",
            "attempts",
            "template_name",
            "message_text",
            "updated_at",
        ]
    )
    return log


def queue_to_recipient(
    to: str,
    text: str,
    *,
    recipient_label: str,
    dedupe_key: str,
    document_type: str = "attendance_report",
    document_ref_id: int | None = None,
    document: tuple[bytes, str, str] | None = None,
    base_url: str = "",
    params: dict | None = None,
):
    """A message to a phone number that is not an employee's (Attendance Notify's reports), queued like every other
    message so the pacing, the caps, quiet hours and the switches keep the number safe. It goes as the type's template:
    `params` are its variables ({name: value}); without them the whole `text` becomes the type's first variable
    (flattened to one line). `document` = (bytes, filename, mime type) travels in the template's header (the template
    must have a document header). `base_url` is accepted for older callers and not needed.

    A WhatsApp group id is refused (skipped, REASON_NO_GROUPS): Meta's templates cannot reach a group.

    Returns the WhatsAppMessageLog row (status queued, or failed / skipped with the reason); `dedupe_key` makes it
    exactly-once: the same key again returns the first row and queues nothing."""
    from . import whatsapp_dispatcher
    from .models import WhatsAppMessageLog, WhatsAppSettings

    existing = WhatsAppMessageLog.objects.filter(dedupe_key=dedupe_key).first() if dedupe_key else None
    if existing is not None:
        return existing
    spec = catalog.get(document_type)
    if params is None:
        order = _order_for(document_type)
        params = {order[0]: text} if order else {}
    values = _named_params(document_type, params)
    choice = template_for(document_type)
    logged = _log_text(document_type, values, choice) or text
    common = dict(
        employee=None,
        recipient_label=recipient_label[:200],
        document_type=document_type,
        document_ref_id=document_ref_id,
        phone_number=to,
        message_text=logged,
        dedupe_key=dedupe_key,
        kind=catalog.KIND_DOCUMENT if document is not None else catalog.KIND_REQUESTED,
        priority=spec.priority if spec else 3,
        template_name=choice.name or "",
    )

    def stop(reason: str, status: str = WhatsAppMessageLog.STATUS_FAILED):
        try:
            with transaction.atomic():
                return WhatsAppMessageLog.objects.create(status=status, error_message=reason, **common)
        except IntegrityError:
            return WhatsAppMessageLog.objects.filter(dedupe_key=dedupe_key).first()

    blocked = sending_block_reason()
    if blocked:
        return stop(blocked)
    if not to:
        return stop("No WhatsApp number.")
    if is_group_id(to):
        return stop(REASON_NO_GROUPS, WhatsAppMessageLog.STATUS_SKIPPED)
    off = switch_off_reason(document_type)
    if off:
        return stop(off)
    if choice.problem:
        return stop(choice.problem, WhatsAppMessageLog.STATUS_SKIPPED)
    if not _inline_delivery() and whatsapp_dispatcher.in_quiet_hours():
        return stop(REASON_QUIET, WhatsAppMessageLog.STATUS_SKIPPED)
    payload: dict = {"params": values}
    if document is not None:
        content, filename, mime_type = document
        payload.update(
            {"media_token": _store_media(content, filename, mime_type), "filename": filename, "mime_type": mime_type}
        )
    now = timezone.now()
    try:
        with transaction.atomic():
            log = WhatsAppMessageLog.objects.create(
                status=WhatsAppMessageLog.STATUS_QUEUED,
                send_after=now,
                expires_at=whatsapp_dispatcher.expiry_for(document_type, WhatsAppSettings.get(), now),
                payload=payload,
                **common,
            )
    except IntegrityError:  # another worker queued this key a moment ago
        return WhatsAppMessageLog.objects.filter(dedupe_key=dedupe_key).first()
    if _inline_delivery():
        return whatsapp_dispatcher.deliver_now(log)
    return log


def send_notification(
    employee,
    document_type: str,
    params,
    *,
    dedupe_key: str = "",
    document_ref_id: int | None = None,
    log_params=None,
    related_module: str = "",
    contact: dict | None = None,
    on_sent: str | None = None,
    expires_at: datetime | None = None,
    asynchronous: bool | None = None,
    announce: bool = True,
):
    """THE entry point for a message the *system* decided to send (an alert, an approval, a gate
    movement, a visitor arrival) or that an employee asked for (a one-time code). Returns the
    WhatsAppMessageLog row, or None when nothing was attempted.

    `params` are the template's variables, by name (a dict) or by position (a list).
    `related_module` names the workflow behind a shared message ("leave" for the Approved wording).
    `contact` is accepted for older callers and ignored: Meta's templates carry no contact card (the visitor's number is
    a variable of the visitor message).
    `on_sent` names a hook (whatsapp_dispatcher.ON_SENT_HOOKS) run once the message is really sent.
    `expires_at` is a moment after which the message is no longer worth sending (the alert job knows it exactly); the
    row expires at the earliest of that, the type's freshness and the end of today.

    None -not a failed row- is returned when: HR has this type (or its module, or WhatsApp itself) switched off,
    WhatsApp isn't configured on this server, or `dedupe_key` was already used (the message already went out, or is
    queued). Those aren't failures worth listing; a *failed* row is reserved for a real attempt that couldn't complete
    (no phone on file, Meta's error, a code whose template is not approved).

    A one-time code is sent at once (deliver_code) and the row comes back sent / failed. Everything else is QUEUED (the
    row comes back "queued") and leaves when whatsapp_dispatcher's pacing allows; during quiet hours it is recorded
    "skipped" instead, and for an employee who opted out it is recorded "skipped" too. A type whose template is not
    approved is skipped when its turn comes (whatsapp_dispatcher). With dedupe_key the reserved row is what makes the
    message exactly-once. `log_params` lets a caller store a redacted version (the one-time code must never sit in the
    history).

    `asynchronous` is accepted for older callers and ignored: whether a message waits in the queue is decided by its kind
    (whatsapp_catalog), never by the caller. Nothing in here raises into the calling workflow.

    The same HRMS event is also handed to Phone Notify Control (push_messages.announce), which decides about the phone
    with its OWN settings and wording; nothing WhatsApp Control has set reaches it, and it never changes this message.
    `announce=False` leaves the phone out: for a caller whose phone notification is made elsewhere (the attendance alerts,
    phone_alerts.py; the Department Head reminders, hod_reminders.py).
    """
    from .models import WhatsAppMessageLog, WhatsAppSettings

    try:
        # The event, to Phone Notify Control (push_messages.py): its own channel and settings, decided before (and whatever)
        # WhatsApp decides below. A one-time code never goes there.
        if announce:
            push_messages.announce(
                employee, document_type, related_module=related_module, dedupe_key=dedupe_key, params=params
            )
        settings_row = WhatsAppSettings.get()
        if switch_off_reason(document_type, related_module, settings_row) or not is_configured():
            return None

        spec = catalog.get(document_type)
        kind = spec.kind if spec else catalog.KIND_AUTOMATIC
        phone = normalize_phone(getattr(employee, "phone", None))
        now = timezone.now()
        fields = {
            "employee": employee,
            "document_type": document_type,
            "document_ref_id": document_ref_id,
            "phone_number": phone or "",
            "dedupe_key": dedupe_key,
            "related_module": related_module,
            "kind": kind,
            "priority": spec.priority if spec else 5,
        }

        if kind == catalog.KIND_CODE:
            try:
                with transaction.atomic():
                    log = WhatsAppMessageLog.objects.create(status=WhatsAppMessageLog.STATUS_PENDING, **fields)
            except IntegrityError:
                return None
            if not phone:
                log.status = WhatsAppMessageLog.STATUS_FAILED
                log.error_message = "No phone number on file for this employee."
                log.save(update_fields=["status", "error_message", "updated_at"])
                return log
            return _send_code_now(log, phone, params, log_params)

        from . import whatsapp_dispatcher

        choice = template_for(document_type, settings_row)
        payload = {"params": _named_params(document_type, params)}
        if on_sent:
            payload["on_sent"] = on_sent
        logged_text = _log_text(document_type, log_params if log_params is not None else params, choice)
        status, reason = WhatsAppMessageLog.STATUS_QUEUED, ""
        if not phone:
            status, reason = WhatsAppMessageLog.STATUS_FAILED, "No phone number on file for this employee."
        elif opted_out(employee):
            status, reason = WhatsAppMessageLog.STATUS_SKIPPED, REASON_OPTED_OUT
        elif not _inline_delivery() and whatsapp_dispatcher.in_quiet_hours(settings_row, now):
            status, reason = WhatsAppMessageLog.STATUS_SKIPPED, REASON_QUIET
        try:
            with transaction.atomic():
                log = WhatsAppMessageLog.objects.create(
                    status=status,
                    error_message=reason,
                    send_after=now,
                    expires_at=whatsapp_dispatcher.expiry_for(document_type, settings_row, now, until=expires_at),
                    payload=payload,
                    message_text=logged_text,
                    template_name=choice.name or "",
                    **fields,
                )
        except IntegrityError:
            return None
        if status == WhatsAppMessageLog.STATUS_QUEUED and _inline_delivery():
            return whatsapp_dispatcher.deliver_now(log)
        return log
    except Exception:
        logger.exception("WhatsApp notification %s could not be prepared", document_type)
        return None


def expire_stale_pending(minutes: int = 10) -> int:
    """A code still "pending" long after it was reserved, or a queued message still "sending" long after the dispatcher
    took it, never left (the server stopped between taking it and recording the outcome). Mark it failed so HR sees it
    instead of a forever-pending row; it is never retried (it may have reached the employee). Run from the alert job
    and the dispatcher."""
    from django.db.models import Q

    from .models import WhatsAppMessageLog

    cutoff = timezone.now() - timedelta(minutes=minutes)
    return WhatsAppMessageLog.objects.filter(
        Q(status=WhatsAppMessageLog.STATUS_PENDING, created_at__lt=cutoff)
        | Q(status=WhatsAppMessageLog.STATUS_SENDING, updated_at__lt=cutoff)
    ).update(
        status=WhatsAppMessageLog.STATUS_FAILED,
        error_message="This message was never sent - the server stopped before it could be delivered.",
        updated_at=timezone.now(),
    )


def _without_credentials(data):
    """`data` with every credential masked (an answer from Meta, safe to show and keep)."""
    return cloud._scrub(data)

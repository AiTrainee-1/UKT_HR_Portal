"""
The 2Factor.in HTTP client: one function, `send_otp`, that sends ONE one-time-code SMS and says whether 2Factor accepted it.
The only SMS provider of the HRMS; sms_service.py is the pipeline around it (caps, breaker, log).

Which 2Factor API, and why
--------------------------
We use 2Factor's "Send OTP: Custom OTP" call, not its AUTOGEN calls: we generate, store (as an HMAC) and verify the codes
ourselves in otp_service.py, so 2Factor is only the carrier (the AUTOGEN calls make 2Factor generate the code and keep its
own copy). The owner's approved DLT template is

    template name  UKT_HRMS_OTP   sender id  UKTHRM
    "XXXX is your UK Textiles HRMS OTP. Official message from UK Textiles. Do not share it with anyone."

and 2Factor puts the OTP we pass in the XXXX place.

The request, as implemented:

    GET {TWOFACTOR_API_BASE}/{api_key}/SMS/+{phone}/{otp}/{template_name}
        e.g. https://2factor.in/API/V1/<api key>/SMS/+919876543210/4829/UKT_HRMS_OTP

`phone` is the international format with the country code (the documentation's example is +919999999999). `otp` is the
code we generated, 4 to 6 characters (we send 4 digits: the template says "XXXX", and 6-digit codes were not delivered
through it; otp_service.CODE_LENGTH is the one place that number lives). `template_name` is optional in the API (a default template
is used without it); we always send the approved one.

The answer: HTTP 200 {"Status": "Success", "Details": "<session id>"} when accepted ("accepted" is not "delivered").
Refusals are HTTP 400 {"Status": "Error", "Details": "..."}: "Invalid API Key", "Invalid Phone Number - Length
Mismatch(Expected: 10)", "Invalid OTP Code - Length Mismatch(Expected: 4-6)". The documentation lists no complete error
table, so ANYTHING that is not exactly a success is a failure, classified by status and by words in `Details`.

Documentation used (read 2026-10-17):
  https://2factor.in/API/DOCS/SMS_OTP.html                 (the endpoint pattern)
  https://documenter.getpostman.com/view/301893/TWDamFGh   (2Factor API Documentation: the custom-OTP call with the
                                                            template name, the phone format, the response bodies)
No balance call is documented: nothing is called (sms_service.balance says where to look).
Not confirmed by the documentation: whether the XXXX placeholder is replaced when the code has fewer / more than 4
characters (the documentation only says the code must be 4 to 6 characters): use the SMS Control page's test message
once after setting 2Factor up and read the SMS that arrives.

THE API KEY IS IN THE URL PATH. That makes every place a URL can travel a leak, so:
  * No exception from `requests` / `urllib3` is ever chained or shown: they embed the URL. Every failure is re-raised
    `from None` as a TwoFactorError carrying one of OUR sentences (plus, for an unrecognised refusal, 2Factor's own
    wording passed through `redact`).
  * `redact()` removes the key (any letter case) and the whole `/API/V1/<key>/` path segment from any text. urllib3
    logs "GET /API/V1/<key>/SMS/... 200" at DEBUG level, so a filter that applies `redact` is installed on the urllib3 /
    requests loggers when this module is imported (_install_log_redaction).
  * The key is never in a log line, a SmsMessageLog row, an audit row, an HTTP answer or the HR page.
  * The code is in the URL too (it has to be): it is never logged either.

Other safety rules (each covered by tests_twofactor.py): timeouts (5 s to connect, 10 s to read), exactly ONE attempt (a
retry could send the code twice), redirects not followed, the answer streamed and read only up to 20 000 bytes, HTTPS
only (plain http for a localhost / 127.0.0.1 / ::1 base URL only: a fake server of a test), the key / template name /
phone / code checked for the shapes they can have BEFORE they go into a URL (so nothing can add a path segment or a query).
"""

import json
import logging
import re
from urllib.parse import urlparse

import requests


CONNECT_TIMEOUT_SECONDS = 5
READ_TIMEOUT_SECONDS = 10
MAX_RESPONSE_BYTES = 20_000
_READ_CHUNK_BYTES = 4096

_LOOPBACK_HOSTS = ("localhost", "127.0.0.1", "::1")
_KEY_OK = re.compile(r"^[A-Za-z0-9._-]{8,100}$")
_TEMPLATE_OK = re.compile(r"^[A-Za-z0-9._-]{1,60}$")
_CODE_OK = re.compile(r"^[0-9]{4,6}$")
_PHONE_OK = re.compile(r"^[0-9]{8,15}$")
_ID_OK = re.compile(r"^[A-Za-z0-9._:-]{4,100}$")
# the key's place in a request path, for texts that may quote a URL: /API/V1/<anything>/ (and a trailing one)
_KEY_PATH = re.compile(r"(/API/V1/)[^/\s'\"?#]+", re.IGNORECASE)


class TwoFactorError(Exception):
    """A send 2Factor (or the network) did not accept. `message` is one plain sentence safe to store and to show HR;
    `kind` is the machine-readable reason (the log's error_code); `status` the HTTP status when there was one."""

    def __init__(self, kind: str, message: str, status: int | None = None):
        super().__init__(message)
        self.kind = kind
        self.message = message
        self.status = status


def clean_provider_text(text, *secrets: str) -> str:
    """2Factor's own wording made safe to store: one line, printable, the given secrets (in ANY letter case) and every run
    of 4+ digits (a phone number, a code, an id) replaced, at most 120 characters."""
    out = re.sub(r"\s+", " ", "".join(ch for ch in str(text or "") if ch.isprintable() or ch.isspace())).strip()
    for secret in secrets:
        if secret and len(secret) >= 4:
            out = re.sub(re.escape(secret), "…", out, flags=re.IGNORECASE)
    out = re.sub(r"\d{4,}", "…", out)
    return out[:120]


def read_limited(response) -> str:
    """At most MAX_RESPONSE_BYTES of the (streamed) body as text. Whatever is beyond is never read."""
    received = bytearray()
    for chunk in response.iter_content(chunk_size=_READ_CHUNK_BYTES):
        received.extend(chunk)
        if len(received) >= MAX_RESPONSE_BYTES:
            break
    return bytes(received[:MAX_RESPONSE_BYTES]).decode("utf-8", errors="replace")


def redact(text, *secrets: str) -> str:
    """`text` with the API key (in any letter case) and the key's whole path segment of any 2Factor URL removed."""
    out = str(text or "")
    for secret in secrets:
        if secret and len(secret) >= 4:
            out = re.sub(re.escape(secret), "…", out, flags=re.IGNORECASE)
    return _KEY_PATH.sub(r"\1…", out)


class _RedactingFilter(logging.Filter):
    """Rewrites every record of the loggers it is attached to so that no 2Factor URL carries its key."""

    def filter(self, record: logging.LogRecord) -> bool:
        try:
            message = record.getMessage()
        except Exception:  # noqa: BLE001 - a malformed record is passed on as it is
            return True
        redacted = redact(message)
        if redacted != message:
            record.msg, record.args = redacted, ()
        return True


_FILTERED_LOGGERS = (
    "urllib3",
    "urllib3.connectionpool",
    "urllib3.util.retry",
    "urllib3.poolmanager",
    "urllib3.response",
    "requests",
    "requests.packages.urllib3",
    "requests.packages.urllib3.connectionpool",
)
_filter = _RedactingFilter()


def _install_log_redaction() -> None:
    """urllib3 logs the request path (so: the key) at DEBUG level; make sure whatever handler a deployment configures only
    ever sees the redacted text. Safe to call twice."""
    for name in _FILTERED_LOGGERS:
        logger = logging.getLogger(name)
        if _filter not in logger.filters:
            logger.addFilter(_filter)


_install_log_redaction()


def base_url_problem(base: str) -> str | None:
    """Why this API base URL must not be used, or None. https only; http only for a loopback address."""
    try:
        parts = urlparse(base or "")
        host = (parts.hostname or "").lower()
    except ValueError:
        return "TWOFACTOR_API_BASE is not a valid web address."
    if parts.query or parts.fragment or parts.params:
        return "TWOFACTOR_API_BASE must not contain a query or a fragment."
    if parts.scheme == "https" and host:
        return None
    if parts.scheme == "http" and host in _LOOPBACK_HOSTS:
        return None
    return "TWOFACTOR_API_BASE must be an https:// address (plain http is accepted for localhost only)."


def key_problem(key: str) -> str | None:
    """Why this API key cannot be put in a URL path (never quotes the key), or None."""
    if _KEY_OK.match(key or ""):
        return None
    return "TWOFACTOR_API_KEY has characters or a length an API key never has"


def template_problem(name: str) -> str | None:
    if _TEMPLATE_OK.match(name or ""):
        return None
    return "TWOFACTOR_TEMPLATE_NAME has characters a template name never has (letters, digits, . _ - only)"


def _classify(status: int, details: str, secrets: tuple[str, ...]) -> TwoFactorError:
    """The failure 2Factor's answer amounts to. Words are matched case-insensitively; anything unrecognised is a plain
    '2Factor refused the message' that carries 2Factor's cleaned wording so HR can look it up."""
    low = (details or "").lower()
    if status == 429:
        return TwoFactorError(
            "rate", "2Factor is limiting the requests from this account. Please try again later.", status
        )
    if "api key" in low or "apikey" in low or "authentication" in low or status in (401, 403):
        return TwoFactorError(
            "auth", "2Factor did not accept the API key. Check TWOFACTOR_API_KEY in the server's .env.", status
        )
    if "template" in low:
        return TwoFactorError(
            "template",
            "2Factor does not accept the template name. Check TWOFACTOR_TEMPLATE_NAME and that the template is approved.",
            status,
        )
    if "balance" in low or "credit" in low or "insufficient" in low or "no sms" in low:
        return TwoFactorError(
            "balance", "The 2Factor account has no balance for this message. Top it up in the 2Factor panel.", status
        )
    if "phone" in low or "mobile" in low or "number" in low:
        return TwoFactorError("number", "2Factor refused the mobile number.", status)
    if status >= 500:
        return TwoFactorError(
            "http", f"2Factor had a problem on its side (HTTP {status}). Please try again later.", status
        )
    detail = clean_provider_text(redact(details, *secrets), *secrets)
    return TwoFactorError(
        "rejected", "2Factor refused the message." + (f" 2Factor said: {detail}" if detail else ""), status
    )


_MSG_TIMEOUT = "2Factor did not answer in time: the SMS may still arrive."
_MSG_CONNECT_TIMEOUT = "This server never connected to 2Factor in time, so no SMS was sent."
_MSG_CUT_OFF = "2Factor's answer was cut off before it was complete: the SMS may still arrive."


def _session_id(value) -> str:
    """2Factor's session id when it looks like one (letters, digits, . _ : -), else empty."""
    text = str(value or "").strip()
    return text if _ID_OK.match(text) else ""


def send_otp(*, api_key: str, template_name: str, mobile: str, code: str, base_url: str) -> str:
    """Send one code through the custom-OTP call. `mobile` is the number in international format without '+'. Returns
    2Factor's session id ("" if it gave none) when 2Factor accepted it; raises TwoFactorError for every other outcome.
    Never retries."""
    problem = base_url_problem(base_url)
    if problem:
        raise TwoFactorError("config", problem)
    if not api_key or not template_name or not mobile or not code:
        raise TwoFactorError("config", "SMS is not set up on this server.")
    problem = key_problem(api_key) or template_problem(template_name)
    if problem:
        raise TwoFactorError("config", problem)
    if not _PHONE_OK.match(mobile) or not _CODE_OK.match(str(code)):
        raise TwoFactorError("config", "The mobile number or the code is not in a shape 2Factor accepts.")
    secrets = (api_key,)
    url = f"{base_url.rstrip('/')}/{api_key}/SMS/+{mobile}/{code}/{template_name}"
    try:
        response = requests.get(
            url,
            headers={"accept": "application/json"},
            timeout=(CONNECT_TIMEOUT_SECONDS, READ_TIMEOUT_SECONDS),
            allow_redirects=False,
            stream=True,
        )
    except requests.exceptions.ConnectTimeout:
        raise TwoFactorError("timeout", _MSG_CONNECT_TIMEOUT) from None
    except requests.exceptions.Timeout:
        raise TwoFactorError("timeout", _MSG_TIMEOUT) from None
    except requests.exceptions.SSLError:
        raise TwoFactorError("connection", "The secure connection to 2Factor failed.") from None
    except Exception:  # noqa: BLE001
        # Any other failure: its text can quote the URL (the key): drop it, keep only the fact.
        raise TwoFactorError("connection", "This server could not connect to 2Factor.") from None

    try:
        status = int(getattr(response, "status_code", 0) or 0)
        try:
            text = read_limited(response)
        except requests.exceptions.Timeout:
            raise TwoFactorError("timeout", _MSG_TIMEOUT, status) from None
        except (requests.exceptions.RequestException, OSError, ValueError):
            raise TwoFactorError("connection", _MSG_CUT_OFF, status) from None
    finally:
        try:
            response.close()
        except Exception:  # noqa: BLE001 - releasing the connection must never change the outcome
            pass

    try:
        data = json.loads(text) if text.strip() else None
    except (ValueError, RecursionError):
        data = None
    if not isinstance(data, dict):
        if status >= 500 or status in (401, 403, 429):
            raise _classify(status, "", secrets)
        raise TwoFactorError("bad_response", "2Factor sent a reply this system could not understand.", status)

    outcome = str(data.get("Status", "")).strip().lower()
    if outcome == "success" and 200 <= status < 300:
        return _session_id(data.get("Details"))
    raise _classify(status, str(data.get("Details") or data.get("Message") or ""), secrets)

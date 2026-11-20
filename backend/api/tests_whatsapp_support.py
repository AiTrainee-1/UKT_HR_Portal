"""Shared helpers for tests that send WhatsApp through the Meta WhatsApp Cloud API (no test ever reaches Meta).

    from .tests_whatsapp_support import META, FakeMeta, approve_templates, make_template

    @override_settings(**META)
    class MyTests(TestCase):
        def setUp(self):
            self.meta = FakeMeta.install(self)      # patches api.whatsapp_cloud.requests for this test
            approve_templates("approval_approved")  # APPROVED WhatsAppTemplate rows (all catalog types when none named)

        def test_x(self):
            ...                                     # code under test sends
            self.assertEqual(self.meta.sent[0]["template"], "hrms_approval_approved")
            self.assertEqual(self.meta.sent[0]["params"]["employee_name"], "Asha")

FakeMeta answers like Meta's Graph API (messages, media, message_templates GET/POST/DELETE, the phone number, pricing
analytics) and records every call. `fail(...)` makes the next call(s) answer with a Meta error; `network_error()` makes
them raise a connection error.

META sets the WHATSAPP_CLOUD_* variables to test values (the access token is a recognisable fake, so a test can assert
it never leaks) and allows sending on the test machine.
"""

from __future__ import annotations

import json
from unittest import mock
from urllib.parse import urlparse

import requests

from . import whatsapp_catalog as catalog

TOKEN = "test-meta-token-NEVER-SHOWN"
APP_SECRET = "test-app-secret-NEVER-SHOWN"
VERIFY_TOKEN = "test-verify-token"
PHONE_NUMBER_ID = "105550001111"
WABA_ID = "205550002222"

META = dict(
    WHATSAPP_CLOUD_API_BASE="https://graph.facebook.com",
    WHATSAPP_CLOUD_API_VERSION="v23.0",
    WHATSAPP_CLOUD_PHONE_NUMBER_ID=PHONE_NUMBER_ID,
    WHATSAPP_CLOUD_BUSINESS_ACCOUNT_ID=WABA_ID,
    WHATSAPP_CLOUD_ACCESS_TOKEN=TOKEN,
    WHATSAPP_CLOUD_APP_SECRET=APP_SECRET,
    WHATSAPP_CLOUD_WEBHOOK_VERIFY_TOKEN=VERIFY_TOKEN,
    WHATSAPP_CLOUD_TEMPLATE_LANGUAGE="en",
    WHATSAPP_DEFAULT_COUNTRY_CODE="91",
    WHATSAPP_ALLOW_SENDING=True,
)
# The same with no credentials at all ("not configured").
NO_META = dict(
    WHATSAPP_CLOUD_PHONE_NUMBER_ID="",
    WHATSAPP_CLOUD_BUSINESS_ACCOUNT_ID="",
    WHATSAPP_CLOUD_ACCESS_TOKEN="",
    WHATSAPP_CLOUD_APP_SECRET="",
    WHATSAPP_CLOUD_WEBHOOK_VERIFY_TOKEN="",
)

FOOTER = "UK Textiles HR"


class Resp:
    """A requests.Response stand-in."""

    def __init__(self, status_code: int = 200, body=None, text: str | None = None):
        self.status_code = status_code
        self._body = body
        self.text = text if text is not None else (json.dumps(body) if body is not None else "")
        self.content = self.text.encode("utf-8")
        self.ok = status_code < 400

    def json(self):
        if self._body is None:
            raise ValueError("no json")
        return self._body


def meta_error(code: int, message: str = "Error", status: int = 400, details: str | None = None) -> Resp:
    error = {"message": message, "type": "OAuthException", "code": code, "fbtrace_id": "TRACE"}
    if details:
        error["error_data"] = {"messaging_product": "whatsapp", "details": details}
    return Resp(status, {"error": error})


def components_for(spec, body: str | None = None, header: str | None = None) -> list[dict]:
    """The components of a template for a catalog type as WhatsApp Control would create it."""
    if spec is not None and spec.meta_category == "AUTHENTICATION":
        return [
            {"type": "BODY", "add_security_recommendation": True},
            {"type": "FOOTER", "code_expiration_minutes": 5},
            {"type": "BUTTONS", "buttons": [{"type": "OTP", "otp_type": "COPY_CODE", "text": "Copy code"}]},
        ]
    out = []
    fmt = header if header is not None else (spec.meta_header if spec is not None else "")
    if fmt:
        out.append({"type": "HEADER", "format": fmt.upper()})
    out.append({"type": "BODY", "text": body if body is not None else (spec.body if spec is not None else "Hi")})
    out.append({"type": "FOOTER", "text": FOOTER})
    return out


def make_template(
    name: str,
    body: str | None = None,
    *,
    category: str = "UTILITY",
    header: str = "",
    status: str = "APPROVED",
    language: str = "en",
    message_type: str = "",
    components: list | None = None,
):
    """One WhatsAppTemplate row (created or replaced)."""
    from .models import WhatsAppTemplate

    if components is None:
        if category == "AUTHENTICATION":
            components = components_for(catalog.get("otp_login"))
        else:
            components = components_for(None, body if body is not None else "Hello {{employee_name}}.", header)
    row, _ = WhatsAppTemplate.objects.update_or_create(
        name=name,
        language=language,
        defaults={
            "category": category,
            "status": status,
            "components": components,
            "message_type": message_type,
            "parameter_format": "named",
            "meta_id": f"meta-{name}",
        },
    )
    return row


def approve_templates(*keys: str, status: str = "APPROVED", language: str = "en") -> list:
    """A template row for each named catalog type (every type sent through Meta when none is named), with the type's
    default wording as its body, its catalog header and category: what "Create all missing" + Meta's approval give."""
    rows = []
    for key in keys or tuple(catalog.TYPES):
        spec = catalog.get(key)
        if spec is None or spec.default_template_name is None:
            continue
        rows.append(
            make_template(
                spec.default_template_name,
                category=spec.meta_category,
                status=status,
                language=language,
                message_type=key,
                components=components_for(spec),
            )
        )
    return rows


class FakeMeta:
    """Meta's Graph API for one test (see the module docstring)."""

    def __init__(self):
        self.calls: list[dict] = []
        self.sent: list[dict] = []
        self.uploads: list[dict] = []
        self.created: list[dict] = []
        self.deleted: list[dict] = []
        self.templates: list[dict] = []
        self.phone = {
            "display_phone_number": "+91 98765 43210",
            "verified_name": "UK Textiles",
            "quality_rating": "GREEN",
            "messaging_limit_tier": "TIER_1K",
            "status": "CONNECTED",
            "name_status": "APPROVED",
            "code_verification_status": "VERIFIED",
            "throughput": {"level": "STANDARD"},
            "platform_type": "CLOUD_API",
            "id": PHONE_NUMBER_ID,
        }
        self.pricing: list[dict] = []
        self._queue: list = []  # Resp to answer, or an exception to raise, for the next calls (in order)
        self._n = 0
        self._patches: list = []

    # ── set up ──
    @classmethod
    def install(cls, test) -> "FakeMeta":
        fake = cls()
        fake.start()
        test.addCleanup(fake.stop)
        return fake

    def start(self) -> "FakeMeta":
        for method in ("post", "get", "delete"):
            p = mock.patch(f"api.whatsapp_cloud.requests.{method}", side_effect=self._handler(method.upper()))
            p.start()
            self._patches.append(p)
        return self

    def stop(self) -> None:
        for p in self._patches:
            p.stop()
        self._patches = []

    def fail(self, code: int = 131026, message: str = "Message undeliverable", status: int = 400, times: int = 1):
        for _ in range(times):
            self._queue.append(meta_error(code, message, status))

    def answer(self, resp: Resp, times: int = 1):
        for _ in range(times):
            self._queue.append(resp)

    def network_error(self, times: int = 1, exc: Exception | None = None):
        for _ in range(times):
            self._queue.append(exc or requests.ConnectionError("network down"))

    # ── what was sent ──
    @property
    def templates_sent(self) -> list[str]:
        return [m["template"] for m in self.sent]

    def last(self) -> dict:
        return self.sent[-1]

    # ── the Graph API ──
    def _handler(self, method: str):
        def handle(url, **kwargs):
            path = urlparse(url).path.strip("/").split("/")
            if path and path[0].startswith("v") and "." in path[0]:
                path = path[1:]
            call = {"method": method, "url": url, "path": "/".join(path), **kwargs}
            self.calls.append(call)
            if self._queue:
                nxt = self._queue.pop(0)
                if isinstance(nxt, Exception):
                    raise nxt
                return nxt
            return self._route(method, path, kwargs)

        return handle

    def _route(self, method: str, path: list[str], kwargs: dict) -> Resp:
        edge = path[1] if len(path) > 1 else ""
        if method == "POST" and edge == "messages":
            body = kwargs.get("json") or {}
            self._n += 1
            wamid = f"wamid.TEST{self._n:04d}"
            template = body.get("template") or {}
            record = {
                "id": wamid,
                "to": body.get("to"),
                "template": template.get("name"),
                "language": (template.get("language") or {}).get("code"),
                "params": {},
                "header": None,
                "button": None,
                "body": body,
            }
            for comp in template.get("components") or []:
                kind = comp.get("type")
                parameters = comp.get("parameters") or []
                if kind == "body":
                    if all("parameter_name" in p for p in parameters):
                        record["params"] = {p["parameter_name"]: p.get("text") for p in parameters}
                    else:
                        record["params"] = {str(i): p.get("text") for i, p in enumerate(parameters, start=1)}
                elif kind == "header" and parameters:
                    record["header"] = parameters[0]
                elif kind == "button" and parameters:
                    record["button"] = parameters[0].get("text")
            self.sent.append(record)
            return Resp(
                200,
                {
                    "messaging_product": "whatsapp",
                    "contacts": [{"input": body.get("to"), "wa_id": body.get("to")}],
                    "messages": [{"id": wamid}],
                },
            )
        if method == "POST" and edge == "media":
            self._n += 1
            name, content, mime = (kwargs.get("files") or {}).get("file", ("file", b"", ""))
            self.uploads.append(
                {"filename": name, "mime": mime, "size": len(content or b""), "data": kwargs.get("data")}
            )
            return Resp(200, {"id": f"MEDIA{self._n:04d}"})
        if edge == "message_templates":
            if method == "GET":
                return Resp(200, {"data": list(self.templates), "paging": {"cursors": {"before": "B", "after": "A"}}})
            if method == "POST":
                payload = kwargs.get("json") or {}
                self.created.append(payload)
                self._n += 1
                return Resp(
                    200, {"id": f"9{self._n:05d}", "status": "PENDING", "category": payload.get("category", "UTILITY")}
                )
            if method == "DELETE":
                self.deleted.append(dict(kwargs.get("params") or {}))
                return Resp(200, {"success": True})
        if method == "GET" and len(path) == 1:
            fields = str((kwargs.get("params") or {}).get("fields") or "")
            if fields.startswith("pricing_analytics"):
                return Resp(200, {"pricing_analytics": {"data": [{"data_points": list(self.pricing)}]}, "id": path[0]})
            return Resp(200, dict(self.phone))
        return Resp(404, {"error": {"message": "Unknown path", "code": 100}})

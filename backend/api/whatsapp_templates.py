"""
WhatsApp Control -> Templates (2026-11-20): the Meta message templates every WhatsApp message goes out as.

With the Meta WhatsApp Cloud API a business may start a conversation with an APPROVED template only, so every HRMS
message type (whatsapp_catalog) needs a template at Meta. This module turns the catalog into Meta templates, submits
them, and keeps the local mirror (WhatsAppTemplate) in step with Meta. It never sends a message.

    draft_for(type_key, s=None) -> dict
        A ready-to-submit draft for one catalog type: {messageType, label, name, language, category, header, headerText,
        body, footer, examples, variables, warnings, errors, codeExpirationMinutes, addSecurityRecommendation, preview,
        currentStatus, currentProblem}. A UTILITY type's body is the catalog's default wording with {{named}} variables
        (numbered ones renamed, the "- UK Textiles HR" sign-off moved to the footer, a fixed title / closing line added
        when the wording would start / end with a variable, which Meta refuses); a one-time-code type gets the
        AUTHENTICATION shape (Meta writes the words itself; expiry from WhatsAppSettings.otp_expiry_minutes).
    validate(data) -> Validated(clean, errors {field: sentence}, warnings [sentences])
        Meta's rules: lowercase / underscore name, a known language code, UTILITY or AUTHENTICATION (never MARKETING),
        body of at most 1024 characters that does not start or end with a variable, variables {{lowercase_names}} only
        and never side by side on a line, an example for every variable, a footer of at most 60 characters without
        variables. Warnings (submittable, but Meta may object): mostly variables, a variable used twice, two variables
        with only a line break between them, a type's file header left out.
    payload_for(clean, header_handle=None) -> dict          Meta's create-template body
    create(clean, user=None, s=None) -> (row, message)      submit to Meta (a REJECTED template is edited and
                                                            resubmitted under its Meta id), save the local row, point
                                                            the message type at it when it has another name
    create_missing(user=None, s=None) -> list[dict]         one draft submitted per switched-on type that has neither
                                                            an approved nor a pending template (a shared template, e.g.
                                                            hrms_otp, is submitted once); one result per type
    sync(now=None) -> dict                                  pull every template from Meta, upsert by name + language,
                                                            mark local rows Meta no longer has as DELETED
    delete(row) -> dict                                     delete at Meta (that language only) and here
    used_by(name, s=None) -> list[str]                      the catalog types sent as this template
    uses_map(s) -> {name: [types]}                          the same for every template at once
    template_json(row, s=None) -> dict                      one row as WhatsApp Control lists it
    missing_for_enabled_types(s=None) -> list[dict]         switched-on types whose template is not approved or pending
    type_switched_on(type_key, s) -> bool                   HR's switches for the type are on (the engine master switch
                                                            aside: a template is prepared before sending starts)
    TemplateError(message, fields=None, status=400)         what the views answer with

A document / ID card template has a media header, and Meta wants a sample file as its example: it is uploaded through
Meta's Resumable Upload API (GET /app for the app id, POST /{app}/uploads, POST /upload:<session>), a generated sample
PDF / PNG, so HR never has to find one. When that is not possible HR creates it in WhatsApp Manager and presses Sync now.
"""

from __future__ import annotations

import logging
import re
from dataclasses import dataclass, field
from io import BytesIO
from urllib.parse import quote

import requests
from django.db import transaction
from django.utils import timezone

from . import whatsapp_catalog as catalog
from . import whatsapp_cloud as cloud
from . import whatsapp_service

logger = logging.getLogger(__name__)

UTILITY = "UTILITY"
AUTHENTICATION = "AUTHENTICATION"
MARKETING = "MARKETING"
CATEGORIES = (UTILITY, AUTHENTICATION)
FOOTER = "UK Textiles HR"
MEDIA_HEADERS = ("document", "image")
HEADERS = ("", "text") + MEDIA_HEADERS

MAX_NAME = 512
MAX_BODY = 1024
MAX_FOOTER = 60
MAX_HEADER_TEXT = 60
MAX_EXAMPLE = 200
CODE_EXPIRY_RANGE = (1, 90)

# Meta's review states: in review or usable (a type is covered), and the ones that keep the name taken at Meta.
APPROVED = "APPROVED"
IN_REVIEW = ("PENDING", "IN_APPEAL")
COVERED = (APPROVED,) + IN_REVIEW
TAKEN = COVERED + ("PAUSED", "DISABLED", "PENDING_DELETION", "LIMIT_EXCEEDED")
NOT_AT_META = ("DRAFT", "DELETED")

# The closing line a draft gets when the wording would end with a variable (Meta refuses that), and the title it gets
# when it would start with one.
CLOSING_LINE = "Please contact HR if you have any questions."

_NAME = re.compile(r"^[a-z0-9_]+$")
_LANGUAGE = re.compile(r"^[a-z]{2,3}(_[A-Z]{2})?$")
_VARIABLE_NAME = re.compile(r"^[a-z][a-z0-9_]*$")
_ANY_PLACEHOLDER = re.compile(r"\{\{(.*?)\}\}", re.DOTALL)
_PLACEHOLDER = re.compile(r"\{\{\s*([A-Za-z_][A-Za-z0-9_]*|\d+)\s*\}\}")
_SESSION = re.compile(r"^upload:[A-Za-z0-9_\-=+/.:]+(\?sig=[A-Za-z0-9_\-=+/.%]+)?$")


class TemplateError(Exception):
    """A refusal the WhatsApp Control views answer with: {"error": message, "fields": {...}} and `status`."""

    def __init__(self, message: str, fields: dict | None = None, status: int = 400, code: int | None = None):
        super().__init__(message)
        self.message = message
        self.fields = fields or {}
        self.status = status
        self.code = code


# ── which types need a template ─────────────────────────────────────────────────────


def _settings(s=None):
    if s is not None:
        return s
    from .models import WhatsAppSettings

    return WhatsAppSettings.get()


def is_code_type(spec) -> bool:
    return spec is not None and (spec.module == "otp" or spec.kind == catalog.KIND_CODE)


def type_switched_on(type_key: str, s) -> bool:
    """Are HR's switches for this message type on (its own switch, its one-by-one switch, its module's switch, and for a
    one-time code the WhatsApp OTP master)? The engine master switch is left out on purpose: templates are prepared
    before sending is switched on. A type not sent through Meta is never "on" here."""
    spec = catalog.get(type_key)
    if spec is None or spec.default_template_name is None:
        return False
    if is_code_type(spec) and not s.otp_enabled:
        return False
    if spec.switch and not getattr(s, spec.switch, False):
        return False
    if type_key in (s.disabled_message_types or []):
        return False
    master = catalog.MODULE_SWITCHES.get(spec.module)
    return not (master and not getattr(s, master, False))


def used_by(name: str, s=None) -> list[str]:
    """The catalog types sent as the template `name` (by default, or because HR chose it)."""
    s = _settings(s)
    return [key for key in catalog.TYPES if whatsapp_service.template_name_for(key, s) == name]


def uses_map(s) -> dict[str, list[str]]:
    """{template name: [the catalog types sent as it]} for every type sent through Meta."""
    out: dict[str, list[str]] = {}
    for key in catalog.TYPES:
        name = whatsapp_service.template_name_for(key, s)
        if name:
            out.setdefault(name, []).append(key)
    return out


def missing_for_enabled_types(s=None) -> list[dict]:
    """Every switched-on type whose template is neither approved nor in review at Meta: it is skipped until one is.
    [{type, label, module, templateName, status (MISSING | REJECTED | PAUSED | DELETED ...), problem}]."""
    s = _settings(s)
    out = []
    for key, spec in catalog.TYPES.items():
        if not type_switched_on(key, s):
            continue
        choice = whatsapp_service.template_for(key, s)
        if choice.status in COVERED:
            continue
        out.append(
            {
                "type": key,
                "label": spec.label,
                "module": spec.module,
                "templateName": choice.name,
                "status": choice.status,
                "problem": choice.problem,
            }
        )
    return out


# ── drafts ──────────────────────────────────────────────────────────────────────────


def _rename_positional(line: str, names: list[str]) -> str:
    def swap(m):
        token = m.group(1)
        if token.isdigit() and 0 < int(token) <= len(names):
            token = names[int(token) - 1]
        return "{{" + token + "}}"

    return _PLACEHOLDER.sub(swap, line)


def _starts_with_variable(body: str) -> bool:
    return body.strip().startswith("{{")


def _ends_with_variable(body: str) -> bool:
    return body.strip().endswith("}}")


def body_variables(body: str) -> list[str]:
    """The {{variables}} of a body, in order of first use."""
    seen: list[str] = []
    for raw in _ANY_PLACEHOLDER.findall(body or ""):
        name = raw.strip()
        if name not in seen:
            seen.append(name)
    return seen


def catalog_body(spec) -> tuple[str, list[str]]:
    """The catalog's default wording of a type as a Meta template body, and what was changed to make it acceptable."""
    notes: list[str] = []
    names = spec.variable_names
    lines = []
    for line in (spec.body or "").split("\n"):
        if line.strip() == catalog.SIGN:
            continue  # the footer signs every template
        line = _rename_positional(line, names)
        if any(n in catalog.RETIRED_VARIABLES for n in _PLACEHOLDER.findall(line)):
            continue
        lines.append(line.rstrip())
    body = re.sub(r"\n{3,}", "\n\n", "\n".join(lines)).strip()
    if not body:
        return "", notes
    # An optional line that is nothing but a variable (WAClient dropped it when empty; a template can't drop a line)
    # is flattened into a labelled line, so it never stands next to another variable and an empty value reads "Note: -".
    if not _PLACEHOLDER.fullmatch(body):
        flat = []
        for line in body.split("\n"):
            match = _PLACEHOLDER.fullmatch(line.strip())
            if match:
                line = f"Note: {{{{{match.group(1)}}}}}"
                notes.append(
                    f"The optional line {{{{{match.group(1)}}}}} reads 'Note: ...': a template can't drop a line, so "
                    "when there is nothing to say the employee sees 'Note: -'."
                )
            flat.append(line)
        body = "\n".join(flat)
    if _starts_with_variable(body):
        body = f"*{spec.label}*\n\n{body}"
        notes.append("A title was added at the top: Meta does not accept a template that starts with a variable.")
    if _ends_with_variable(body):
        body = f"{body}\n\n{CLOSING_LINE}"
        notes.append("A closing line was added: Meta does not accept a template that ends with a variable.")
    return body, notes


def _example(value) -> str:
    text = cloud.sanitize_param(value)
    return text[:MAX_EXAMPLE]


def _render(body: str, examples: dict[str, str]) -> str:
    return _ANY_PLACEHOLDER.sub(lambda m: examples.get(m.group(1).strip(), "-") or "-", body or "")


def auth_preview(minutes, security: bool = True, code: str = "123456") -> str:
    text = f"{code} is your verification code."
    if security:
        text += " For your security, do not share this code."
    if minutes:
        text += f"\nThis code expires in {minutes} minutes."
    return text


def preview_of(clean: dict) -> str:
    """What the employee reads (the examples filled in), for the draft and the editor's bubble."""
    if clean.get("category") == AUTHENTICATION:
        return auth_preview(clean.get("codeExpirationMinutes"), clean.get("addSecurityRecommendation", True))
    parts = []
    if clean.get("header") == "text" and clean.get("headerText"):
        parts.append(f"*{clean['headerText']}*")
    parts.append(_render(clean.get("body", ""), clean.get("examples") or {}))
    return "\n\n".join(p for p in parts if p).strip()


def draft_for(type_key: str, s=None) -> dict:
    """A ready-to-submit draft for one catalog type (see the module docstring). TemplateError 404 for an unknown type,
    400 for a type that is never sent through Meta."""
    spec = catalog.get(type_key)
    if spec is None:
        raise TemplateError(f"Unknown message type: {type_key}", status=404)
    s = _settings(s)
    name = whatsapp_service.template_name_for(type_key, s)
    if name is None:
        raise TemplateError(f"'{spec.label}' is not sent through WhatsApp Cloud API, so it needs no Meta template.")
    choice = whatsapp_service.template_for(type_key, s)
    language = cloud.template_language()
    base = {
        "messageType": type_key,
        "label": spec.label,
        "module": spec.module,
        "name": name,
        "language": language,
        "currentStatus": choice.status,
        "currentProblem": choice.problem,
    }
    if (spec.meta_category or "").upper() == AUTHENTICATION:
        data = {
            **base,
            "category": AUTHENTICATION,
            "header": "",
            "headerText": "",
            "body": "",
            "footer": "",
            "examples": {},
            "variables": [],
            "codeExpirationMinutes": int(s.otp_expiry_minutes),
            "addSecurityRecommendation": True,
        }
        notes = [
            "Meta writes the text of a code template itself: '<code> is your verification code.', the security "
            "line, the expiry and a Copy code button. One template carries every WhatsApp code (sign-in, password "
            "reset, activation)."
        ]
    else:
        body, notes = catalog_body(spec)
        variables = body_variables(body)
        samples = {v.name: v.sample for v in spec.variables}
        data = {
            **base,
            "category": UTILITY,
            "header": spec.meta_header or "",
            "headerText": "",
            "body": body,
            "footer": FOOTER,
            "examples": {v: _example(samples.get(v, "")) for v in variables},
            "variables": variables,
            "codeExpirationMinutes": None,
            "addSecurityRecommendation": None,
        }
        if data["header"] in MEDIA_HEADERS:
            notes.append(
                f"The {data['header']} travels in the template's header. A sample {data['header']} is uploaded to "
                "Meta as the example when you submit."
            )
    checked = validate(data)
    data["warnings"] = notes + checked.warnings
    data["errors"] = checked.errors
    data["preview"] = preview_of(checked.clean or data)
    return data


# ── validation ──────────────────────────────────────────────────────────────────────


@dataclass
class Validated:
    clean: dict
    errors: dict = field(default_factory=dict)
    warnings: list = field(default_factory=list)

    @property
    def ok(self) -> bool:
        return not self.errors

    def first_error(self) -> str:
        return next(iter(self.errors.values()), "")


def _text(data: dict, key: str) -> str:
    value = data.get(key)
    return value if isinstance(value, str) else ("" if value is None else str(value))


def _whole(value) -> int | None:
    if isinstance(value, bool):
        return None
    if isinstance(value, int):
        return value
    if isinstance(value, float) and value.is_integer():
        return int(value)
    if isinstance(value, str) and re.fullmatch(r"\d+", value.strip()):
        return int(value.strip())
    return None


def validate(data) -> Validated:
    """Check a template (a draft, or what HR edited) against Meta's rules. See the module docstring."""
    data = data if isinstance(data, dict) else {}
    errors: dict[str, str] = {}
    warnings: list[str] = []

    name = _text(data, "name").strip()
    if not name:
        errors["name"] = "Give the template a name."
    elif len(name) > MAX_NAME or not _NAME.fullmatch(name):
        errors["name"] = "Use lowercase letters, numbers and underscores only, for example hrms_late_alert."

    language = _text(data, "language").strip() or cloud.template_language()
    if not _LANGUAGE.fullmatch(language):
        errors["language"] = "Use a language code Meta knows, for example en, en_US, ta or hi."

    category = (_text(data, "category").strip() or UTILITY).upper()
    if category == MARKETING:
        errors["category"] = (
            "UK Textiles HRMS sends Utility and Authentication templates only: Marketing costs more and is not used "
            "for messages to employees."
        )
    elif category not in CATEGORIES:
        errors["category"] = "Category must be UTILITY or AUTHENTICATION."

    message_type = _text(data, "messageType").strip()
    spec = None
    if message_type:
        spec = catalog.get(message_type)
        if spec is None:
            errors["messageType"] = f"Unknown message type: {message_type}"
        elif spec.default_template_name is None:
            errors["messageType"] = f"'{spec.label}' is not sent through WhatsApp Cloud API."

    clean = {"name": name, "language": language, "category": category, "messageType": message_type}

    if category == AUTHENTICATION:
        minutes = data.get("codeExpirationMinutes")
        if minutes in (None, ""):
            minutes = int(_settings().otp_expiry_minutes)
        minutes = _whole(minutes)
        lo, hi = CODE_EXPIRY_RANGE
        if minutes is None or not lo <= minutes <= hi:
            errors["codeExpirationMinutes"] = f"How long a code lasts must be a whole number of minutes, {lo} to {hi}."
        security = data.get("addSecurityRecommendation", True)
        if security is None:
            security = True
        if not isinstance(security, bool):
            errors["addSecurityRecommendation"] = "addSecurityRecommendation must be true or false."
        clean.update(
            {
                "header": "",
                "headerText": "",
                "body": "",
                "footer": "",
                "examples": {},
                "variables": [],
                "codeExpirationMinutes": minutes,
                "addSecurityRecommendation": bool(security),
            }
        )
        if spec is not None and not is_code_type(spec):
            warnings.append(f"'{spec.label}' is not a one-time code: an Authentication template can only carry a code.")
        return Validated(clean, errors, warnings)

    header = _text(data, "header").strip().lower()
    if header not in HEADERS:
        errors["header"] = "Header must be none, document, image or text."
    header_text = _text(data, "headerText").strip()
    if header == "text":
        if not header_text:
            errors["headerText"] = "Write the header text, or choose no header."
        elif len(header_text) > MAX_HEADER_TEXT or "\n" in header_text:
            errors["headerText"] = f"The header is one line of at most {MAX_HEADER_TEXT} characters."
        elif "{{" in header_text or "}}" in header_text:
            errors["headerText"] = "The header can't hold a variable here: put it in the body."
    else:
        header_text = ""

    body = _text(data, "body").replace("\r\n", "\n").strip()
    variables = body_variables(body)
    if not body:
        errors["body"] = "Write the message text (the body)."
    elif len(body) > MAX_BODY:
        errors["body"] = f"The body is {len(body)} characters: Meta allows at most {MAX_BODY}."
    else:
        bad = [v for v in variables if not _VARIABLE_NAME.fullmatch(v)]
        leftover = _ANY_PLACEHOLDER.sub("", body)
        if bad:
            shown = ", ".join("{{" + b + "}}" for b in bad)
            errors["body"] = (
                f"Variable {shown} is not allowed: name variables with lowercase letters, numbers and underscores, "
                "starting with a letter, for example {{employee_name}}."
            )
        elif "{{" in leftover or "}}" in leftover:
            errors["body"] = "A variable is not closed: write it as {{name}}."
        elif _starts_with_variable(body):
            errors["body"] = "Meta does not accept a template that starts with a variable: begin with fixed text."
        elif _ends_with_variable(body):
            errors["body"] = "Meta does not accept a template that ends with a variable: end with fixed text."
        elif re.search(r"\}\}[ \t]*\{\{", body):
            errors["body"] = "Two variables side by side are not accepted by Meta: put words between them."
        if not errors.get("body"):
            if re.search(r"\}\}\s*\n\s*\{\{", body):
                warnings.append(
                    "Two variables are separated by a line break only: Meta may refuse it. Put a label before the "
                    "second one, for example 'Note: {{...}}'."
                )
            if re.search(r"\n{3,}", body):
                warnings.append("More than one empty line in a row: Meta may refuse it.")
            fixed_words = len(re.findall(r"[A-Za-z0-9]+", _ANY_PLACEHOLDER.sub(" ", body)))
            if variables and fixed_words < len(variables) + 3:
                warnings.append(
                    "The text is mostly variables: Meta may reject it. Add more fixed words around the variables."
                )
            counts = [n for n in variables if len(re.findall(r"\{\{\s*" + re.escape(n) + r"\s*\}\}", body)) > 1]
            for name in counts:
                warnings.append(f"{{{{{name}}}}} is used more than once: Meta may ask for it only once.")

    raw_examples = data.get("examples")
    if raw_examples is not None and not isinstance(raw_examples, dict):
        errors["examples"] = "examples must be an object: {variable: example}."
        raw_examples = {}
    raw_examples = raw_examples or {}
    examples: dict[str, str] = {}
    missing = []
    for v in variables:
        value = raw_examples.get(v)
        value = "" if value is None else str(value)
        if not value.strip():
            missing.append(v)
            continue
        examples[v] = _example(value)
    if missing and "body" not in errors and "examples" not in errors:
        shown = ", ".join("{{" + m + "}}" for m in missing)
        errors["examples"] = f"Give an example value for {shown}: Meta asks for one for every variable."

    footer = _text(data, "footer").strip()
    if len(footer) > MAX_FOOTER:
        errors["footer"] = f"The footer is {len(footer)} characters: Meta allows at most {MAX_FOOTER}."
    elif "\n" in footer:
        errors["footer"] = "The footer is one line."
    elif "{{" in footer or "}}" in footer:
        errors["footer"] = "The footer can't hold a variable."

    if spec is not None and not errors.get("body"):
        known = set(spec.variable_names)
        foreign = [v for v in variables if v not in known]
        if foreign:
            shown = ", ".join("{{" + f + "}}" for f in foreign)
            warnings.append(
                f"{shown} is not a variable '{spec.label}' fills in: the employee would see '-' there. It can use: "
                + ", ".join("{{" + k + "}}" for k in spec.variable_names)
            )
        if is_code_type(spec):
            warnings.append(
                "One-time codes are best sent as an Authentication template (Meta's Copy code button, cheaper in India)."
            )
        if spec.meta_header in MEDIA_HEADERS and header != spec.meta_header:
            warnings.append(
                f"'{spec.label}' sends a {spec.meta_header}: without a {spec.meta_header} header the file can't be "
                "attached and the message is not sent."
            )

    clean.update(
        {
            "header": header,
            "headerText": header_text,
            "body": body,
            "footer": footer,
            "examples": examples,
            "variables": variables,
            "codeExpirationMinutes": None,
            "addSecurityRecommendation": None,
        }
    )
    return Validated(clean, errors, warnings)


# ── Meta's create-template body ─────────────────────────────────────────────────────


def components_for(clean: dict, header_handle: str | None = None) -> list[dict]:
    if clean["category"] == AUTHENTICATION:
        return [
            {"type": "BODY", "add_security_recommendation": bool(clean.get("addSecurityRecommendation", True))},
            {"type": "FOOTER", "code_expiration_minutes": int(clean["codeExpirationMinutes"])},
            {"type": "BUTTONS", "buttons": [{"type": "OTP", "otp_type": "COPY_CODE", "text": "Copy code"}]},
        ]
    components: list[dict] = []
    header = clean.get("header") or ""
    if header == "text":
        components.append({"type": "HEADER", "format": "TEXT", "text": clean["headerText"]})
    elif header in MEDIA_HEADERS:
        item = {"type": "HEADER", "format": header.upper()}
        if header_handle:
            item["example"] = {"header_handle": [header_handle]}
        components.append(item)
    body: dict = {"type": "BODY", "text": clean["body"]}
    if clean.get("variables"):
        body["example"] = {
            "body_text_named_params": [{"param_name": v, "example": clean["examples"][v]} for v in clean["variables"]]
        }
    components.append(body)
    if clean.get("footer"):
        components.append({"type": "FOOTER", "text": clean["footer"]})
    return components


def payload_for(clean: dict, header_handle: str | None = None) -> dict:
    payload = {
        "name": clean["name"],
        "language": clean["language"],
        "category": clean["category"],
        "components": components_for(clean, header_handle),
    }
    if clean["category"] != AUTHENTICATION:
        payload["parameter_format"] = "named"
    return payload


# ── the sample file a media header needs (Meta's Resumable Upload API) ───────────────


def sample_file(fmt: str, label: str = "Document") -> tuple[bytes, str, str]:
    """(bytes, filename, mime) of a small sample for a template's media header example."""
    if fmt == "image":
        try:
            from PIL import Image, ImageDraw

            img = Image.new("RGB", (640, 400), (247, 244, 238))
            draw = ImageDraw.Draw(img)
            draw.rectangle((0, 0, 640, 70), fill=(44, 62, 80))
            draw.text((24, 26), "UK Textiles HRMS", fill=(255, 255, 255))
            draw.text((24, 120), "Employee ID Card (sample)", fill=(30, 30, 30))
            draw.text((24, 160), "Name: Asha Kumar", fill=(30, 30, 30))
            draw.text((24, 190), "Employee code: 30012", fill=(30, 30, 30))
            out = BytesIO()
            img.save(out, format="PNG")
            return out.getvalue(), "uk-textiles-id-card-sample.png", "image/png"
        except Exception:  # Pillow missing or broken: the 1x1 picture the test message uses
            from .whatsapp_test_views import SAMPLE_PNG

            return SAMPLE_PNG, "uk-textiles-id-card-sample.png", "image/png"
    from reportlab.lib.pagesizes import A6
    from reportlab.pdfgen import canvas

    out = BytesIO()
    page = canvas.Canvas(out, pagesize=A6)
    page.setFont("Helvetica-Bold", 13)
    page.drawString(24, 330, "UK Textiles HRMS")
    page.setFont("Helvetica", 10)
    page.drawString(24, 310, f"{label} (sample)")
    page.drawString(24, 294, "Employee: Asha Kumar")
    page.showPage()
    page.save()
    return out.getvalue(), "uk-textiles-sample.pdf", "application/pdf"


def upload_header_example(fmt: str, label: str = "Document") -> str:
    """Upload a sample file through Meta's Resumable Upload API and return its handle (the header example). The upload
    session belongs to the Meta app: settings.WHATSAPP_CLOUD_APP_ID when a deployment sets it, else the app the access
    token was issued for (GET /app)."""
    content, filename, mime = sample_file(fmt, label)
    app_id = cloud._setting("WHATSAPP_CLOUD_APP_ID")
    if not app_id:
        app = cloud._request("get", "app", params={"fields": "id"}, timeout=cloud.READ_TIMEOUT)
        app_id = str(app.get("id") or "").strip()
    if not app_id.isdigit():
        raise cloud.MetaApiError(None, "Meta did not say which app the access token belongs to.")
    session = cloud._request(
        "post",
        f"{quote(app_id, safe='')}/uploads",
        params={"file_name": filename, "file_length": len(content), "file_type": mime},
        timeout=cloud.READ_TIMEOUT,
    )
    session_id = str(session.get("id") or "").strip()
    if not _SESSION.fullmatch(session_id) or ".." in session_id:
        raise cloud.MetaApiError(None, "Meta did not open an upload session for the sample file.")
    token = cloud._setting("WHATSAPP_CLOUD_ACCESS_TOKEN")
    try:
        # The upload step itself wants "OAuth <token>" and the offset; the body is the raw file.
        resp = requests.post(
            cloud._url(session_id),
            headers={"Authorization": f"OAuth {token}", "file_offset": "0"},
            data=content,
            timeout=cloud.UPLOAD_TIMEOUT,
        )
    except requests.RequestException as exc:
        raise cloud.MetaApiError(
            None, f"Could not reach Meta (WhatsApp Cloud API): {type(exc).__name__}.", temporary=True
        ) from None
    handle = str(cloud._answer(resp).get("h") or "").strip()
    if not handle:
        raise cloud.MetaApiError(None, "Meta answered the sample upload without a handle.")
    return handle


# ── submitting ──────────────────────────────────────────────────────────────────────


def not_configured_message() -> str:
    missing = [
        n
        for n in ("WHATSAPP_CLOUD_PHONE_NUMBER_ID", "WHATSAPP_CLOUD_BUSINESS_ACCOUNT_ID", "WHATSAPP_CLOUD_ACCESS_TOKEN")
        if n in cloud.missing_env()
    ]
    return (
        "WhatsApp (Meta Cloud API) is not configured on this server: set "
        + ", ".join(missing or ["the WHATSAPP_CLOUD_* variables"])
        + " (backend/.env locally, Railway Variables on the live server) and restart the backend."
    )


def _meta_error(exc: cloud.MetaApiError, what: str) -> TemplateError:
    status = 502 if exc.code is None and exc.temporary else 400
    detail = exc.message if exc.message and exc.message not in exc.friendly else ""
    text = f"{what}: {exc}"
    if detail:
        text += f" Meta said: {detail}"
    return TemplateError(text, status=status, code=exc.code)


def _point_type_at(type_key: str, name: str, s) -> bool:
    """Make `type_key` go out as `name` (an override, or none when it is the catalog's default). True when it changed."""
    spec = catalog.get(type_key)
    if spec is None or spec.default_template_name is None:
        return False
    overrides = dict(s.template_overrides or {})
    before = overrides.get(type_key)
    if name == spec.default_template_name:
        overrides.pop(type_key, None)
    else:
        overrides[type_key] = name
    if overrides.get(type_key) == before:
        return False
    s.template_overrides = overrides
    s.save(update_fields=["template_overrides", "updated_at"])
    return True


def create(clean: dict, user=None, s=None) -> tuple:
    """Submit a validated template to Meta and save the local row. A REJECTED template of the same name and language
    that Meta knows is edited and resubmitted instead (Meta keeps the name). Returns (row, message)."""
    from .models import WhatsAppTemplate

    if not cloud.is_configured():
        raise TemplateError(not_configured_message())
    s = _settings(s)
    name, language = clean["name"], clean["language"]
    existing = WhatsAppTemplate.objects.filter(name=name, language=language).first()
    if existing is not None and existing.status.upper() in TAKEN:
        raise TemplateError(
            f"A template called {name} ({language}) already exists at Meta ({existing.status.lower()}). Delete it "
            "first, or choose another name.",
            fields={"name": "This name is already used in this language."},
            status=409,
        )
    resubmit = existing is not None and existing.status.upper() == "REJECTED" and bool(existing.meta_id)
    header = clean.get("header") or ""
    try:
        handle = None
        if header in MEDIA_HEADERS:
            spec = catalog.get(clean.get("messageType") or "")
            handle = upload_header_example(header, spec.label if spec else "Document")
        payload = payload_for(clean, handle)
        if resubmit:
            edit = {"components": payload["components"]}
            if clean["category"] != AUTHENTICATION:
                edit["category"] = clean["category"]
            cloud._request("post", quote(existing.meta_id, safe=""), json=edit, timeout=cloud.READ_TIMEOUT)
            answer = {"id": existing.meta_id, "status": "PENDING", "category": clean["category"]}
        else:
            answer = cloud.create_template(payload)
    except cloud.MetaApiError as exc:
        what = "Could not upload the sample file Meta needs" if header in MEDIA_HEADERS and handle is None else None
        if what and exc.code is not None:
            what += " (create this template in WhatsApp Manager instead, then Sync now)"
        raise _meta_error(exc, what or "Meta refused the template") from None

    status = str(answer.get("status") or "PENDING").upper()
    category = str(answer.get("category") or clean["category"]).upper()
    now = timezone.now()
    with transaction.atomic():
        row, _ = WhatsAppTemplate.objects.update_or_create(
            name=name,
            language=language,
            defaults={
                "category": category,
                "status": status,
                "meta_id": str(answer.get("id") or (existing.meta_id if existing else "") or ""),
                "parameter_format": "positional" if clean["category"] == AUTHENTICATION else "named",
                "components": payload["components"],
                "rejected_reason": "",
                "quality_score": "",
                "message_type": clean.get("messageType") or (existing.message_type if existing else ""),
                "last_synced_at": now,
                "created_by": user if user is not None else (existing.created_by if existing else None),
            },
        )
        if clean.get("messageType"):
            _point_type_at(clean["messageType"], name, s)
    if category != clean["category"]:
        message = f"Submitted. Meta classified it as {category.title()}, not {clean['category'].title()}."
    elif status == APPROVED:
        message = "Approved by Meta: it can be used at once."
    elif status == "REJECTED":
        message = "Meta rejected it at once. Check the wording and submit again."
    else:
        message = (
            "Resubmitted" if resubmit else "Submitted"
        ) + " to Meta for approval: usually minutes, at most 24 hours."
    return row, message


def create_missing(user=None, s=None) -> list[dict]:
    """Submit a draft for every switched-on type that has neither an approved nor a pending template (see the module
    docstring). [{type, label, name, ok, status, error, message}]."""
    if not cloud.is_configured():
        raise TemplateError(not_configured_message())
    s = _settings(s)
    results = []
    by_name: dict[str, dict] = {}
    for key, spec in catalog.TYPES.items():
        if not type_switched_on(key, s):
            continue
        name = whatsapp_service.template_name_for(key, s)
        if name in by_name:  # a template shared with a type before (the codes' one): its outcome is this type's too
            results.append({**by_name[name], "type": key, "label": spec.label})
            continue
        choice = whatsapp_service.template_for(key, s)
        if choice.status in COVERED:
            continue
        result = {"type": key, "label": spec.label, "name": name, "ok": False, "status": choice.status}
        if choice.status not in ("MISSING",) + NOT_AT_META:
            why = choice.problem or f"The template '{name}' is {choice.status.lower()} at Meta."
            result["error"] = f"{why} Edit it on Templates and submit it again."
        else:
            try:
                draft = draft_for(key, s)
                checked = validate(draft)
                if not checked.ok:
                    result["error"] = f"The draft needs editing first: {checked.first_error()}"
                else:
                    row, message = create(checked.clean, user=user, s=s)
                    result.update({"ok": True, "status": row.status, "error": None, "message": message})
            except TemplateError as exc:
                result["error"] = exc.message
        by_name[name] = result
        results.append(result)
    return results


# ── sync ────────────────────────────────────────────────────────────────────────────


def _quality(value) -> str:
    if isinstance(value, dict):
        value = value.get("score")
    text = str(value or "").strip().upper()
    return "" if text in ("", "UNKNOWN", "NONE") else text


def _reason(value) -> str:
    text = str(value or "").strip()
    return "" if text.upper() in ("", "NONE") else text


def sync(now=None) -> dict:
    """Pull every template from Meta and mirror it here (see the module docstring). Raises TemplateError."""
    from .models import WhatsAppTemplate

    if not cloud.is_configured():
        raise TemplateError(not_configured_message())
    try:
        items = cloud.list_templates()
    except cloud.MetaApiError as exc:
        raise _meta_error(exc, "Could not read the templates from Meta") from None
    now = now or timezone.now()
    s = _settings()
    uses = uses_map(s)
    seen: set[tuple[str, str]] = set()
    created = updated = 0
    with transaction.atomic():
        for t in items:
            name = str(t.get("name") or "").strip()
            language = str(t.get("language") or "").strip()
            if not name or not language or (name, language) in seen:
                continue
            seen.add((name, language))
            fields = {
                "status": str(t.get("status") or "PENDING").upper(),
                "category": str(t.get("category") or UTILITY).upper(),
                "meta_id": str(t.get("id") or ""),
                "components": [c for c in (t.get("components") or []) if isinstance(c, dict)],
                "rejected_reason": _reason(t.get("rejected_reason")),
                "quality_score": _quality(t.get("quality_score")),
                "parameter_format": str(t.get("parameter_format") or "named").lower(),
                "last_synced_at": now,
            }
            row = WhatsAppTemplate.objects.filter(name=name, language=language).first()
            if row is None:
                types = uses.get(name) or []
                WhatsAppTemplate.objects.create(
                    name=name, language=language, message_type=types[0] if types else "", **fields
                )
                created += 1
            else:
                for k, v in fields.items():
                    setattr(row, k, v)
                if not row.message_type and uses.get(name):
                    row.message_type = uses[name][0]
                row.save()
                updated += 1
        gone = 0
        for row in WhatsAppTemplate.objects.exclude(status__in=NOT_AT_META):
            if (row.name, row.language) not in seen:
                row.status = "DELETED"
                row.last_synced_at = now
                row.save(update_fields=["status", "last_synced_at", "updated_at"])
                gone += 1
    message = f"{len(seen)} template{'s' if len(seen) != 1 else ''} read from Meta"
    details = [f"{n} {w}" for n, w in ((created, "new"), (gone, "no longer at Meta")) if n]
    if details:
        message += f" ({', '.join(details)})"
    return {
        "synced": len(seen),
        "created": created,
        "updated": updated,
        "deleted": gone,
        "lastSyncedAt": now.isoformat(),
        "message": message + ".",
    }


# ── delete ──────────────────────────────────────────────────────────────────────────


def _gone_at_meta(exc: cloud.MetaApiError) -> bool:
    text = (exc.message or "").lower()
    return exc.http_status == 404 or any(w in text for w in ("not found", "does not exist", "doesn't exist"))


def delete(row) -> dict:
    """Delete the template at Meta (this language only, by its Meta id) and here. A template Meta never had (DRAFT) or no
    longer has (DELETED) is removed here only."""
    from .models import WhatsAppTemplate

    s = _settings()
    types = used_by(row.name, s)
    at_meta = row.status.upper() not in NOT_AT_META
    if at_meta:
        if not cloud.is_configured():
            raise TemplateError(not_configured_message())
        if not row.meta_id and WhatsAppTemplate.objects.filter(name=row.name).exclude(pk=row.pk).exists():
            # Without its Meta id the delete would take every language of the name with it.
            raise TemplateError(
                f"This server does not know Meta's id of {row.name} ({row.language}): press Sync now, then delete it."
            )
        try:
            cloud.delete_template(row.name, row.meta_id or None)
        except cloud.MetaApiError as exc:
            if not _gone_at_meta(exc):
                raise _meta_error(exc, "Meta did not delete the template") from None
    info = {"deleted": True, "name": row.name, "language": row.language, "messageTypes": types, "atMeta": at_meta}
    row.delete()
    left = WhatsAppTemplate.objects.filter(name=info["name"], status=APPROVED).exists()
    if types and not left:
        labels = ", ".join(catalog.label(t) for t in types)
        info["message"] = f"Deleted. {labels} now has no approved template and is skipped until it gets one."
    else:
        info["message"] = "Deleted."
    return info


# ── how WhatsApp Control lists a template ───────────────────────────────────────────


def _component(components, kind: str) -> dict:
    for c in components or []:
        if isinstance(c, dict) and str(c.get("type") or "").upper() == kind:
            return c
    return {}


def template_json(row, s=None, uses: dict | None = None) -> dict:
    s = _settings(s) if uses is None else s
    uses = uses if uses is not None else uses_map(s)
    components = row.components if isinstance(row.components, list) else []
    header = _component(components, "HEADER")
    body = _component(components, "BODY")
    footer = _component(components, "FOOTER")
    category = (row.category or "").upper()
    return {
        "id": row.id,
        "name": row.name,
        "language": row.language,
        "category": category,
        "status": (row.status or "").upper(),
        "qualityScore": row.quality_score or None,
        "rejectedReason": row.rejected_reason or None,
        "messageTypes": uses.get(row.name, []),
        "madeFor": row.message_type or None,
        "components": components,
        "header": str(header.get("format") or "").lower() if header else "",
        "body": str(body.get("text") or ""),
        "footer": str(footer.get("text") or ""),
        "variables": body_variables(str(body.get("text") or "")),
        "codeExpirationMinutes": footer.get("code_expiration_minutes") if category == AUTHENTICATION else None,
        "metaId": row.meta_id or None,
        "lastSyncedAt": row.last_synced_at.isoformat() if row.last_synced_at else None,
        "createdAt": row.created_at.isoformat() if row.created_at else None,
        "updatedAt": row.updated_at.isoformat() if row.updated_at else None,
    }


def list_json(s=None) -> dict:
    from django.db.models import Max

    from .models import WhatsAppTemplate

    s = _settings(s)
    uses = uses_map(s)
    rows = list(WhatsAppTemplate.objects.all().order_by("name", "language"))
    last = WhatsAppTemplate.objects.aggregate(last=Max("last_synced_at"))["last"]
    return {
        "templates": [template_json(r, s, uses) for r in rows],
        "lastSyncedAt": last.isoformat() if last else None,
        "configured": cloud.is_configured(),
        "language": cloud.template_language(),
    }

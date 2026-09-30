"""
HR / software-support contact details (Settings -> HR Contact).

One company-wide record, shown to employees in the Employee Web App and the Employee Mobile App wherever
they need help: a sign-in problem, a problem with either app, or the server not working. HR edits it on
the Settings page (through PUT /api/payroll-settings, field group `settings.hr_contact`); the apps read it
here, without a login, because the people who need it most cannot sign in.

    GET /api/support-contact      public, read-only

Two contacts are kept, because they answer different problems:

  hr        the HR department: cannot sign in, not registered, account inactive, anything about the apps
  support   the software / IT contact: the server is down or unreachable, the database is offline

`support` falls back to `hr` when nothing is filled in for it (and says so in `usesHrFallback`), so a
screen that must show "who to call about the server" always has an answer as long as either is set.
Nothing secret lives here: these are the numbers and addresses HR chose to publish to staff.

The apps keep the last answer on the device, because the moment they most need it (the server is down)
is the moment they cannot ask for it.
"""

import re

from rest_framework.decorators import api_view
from rest_framework.request import Request
from rest_framework.response import Response

# JSON key -> (PayrollSettings column, longest allowed text, kind). `kind` decides the format check.
FIELDS: dict[str, tuple[str, int, str]] = {
    "hrContactName": ("hr_contact_name", 80, "text"),
    "hrContactPhone": ("hr_contact_phone", 30, "phone"),
    "hrContactWhatsapp": ("hr_contact_whatsapp", 30, "phone"),
    "hrContactEmail": ("hr_contact_email", 120, "email"),
    "hrContactHours": ("hr_contact_hours", 120, "text"),
    "supportContactName": ("support_contact_name", 80, "text"),
    "supportContactPhone": ("support_contact_phone", 30, "phone"),
    "supportContactWhatsapp": ("support_contact_whatsapp", 30, "phone"),
    "supportContactEmail": ("support_contact_email", 120, "email"),
    "supportContactHours": ("support_contact_hours", 120, "text"),
    "contactNote": ("contact_note", 500, "note"),
}

LABELS = {
    "hrContactName": "HR contact name",
    "hrContactPhone": "HR phone number",
    "hrContactWhatsapp": "HR WhatsApp number",
    "hrContactEmail": "HR email",
    "hrContactHours": "HR available hours",
    "supportContactName": "Software support name",
    "supportContactPhone": "Software support phone number",
    "supportContactWhatsapp": "Software support WhatsApp number",
    "supportContactEmail": "Software support email",
    "supportContactHours": "Software support available hours",
    "contactNote": "Note",
}

DEFAULT_HR_LABEL = "HR Department"
DEFAULT_SUPPORT_LABEL = "Software Support"

# Digits, spaces and the usual separators, with "+" only at the start. A comma, slash or a second number
# would otherwise end up inside a tel: link that dials nothing.
_PHONE_CHARS = re.compile(r"[0-9+ ()\-.]+")
_EMAIL = re.compile(r"[^@\s,;<>\"']+@[^@\s,;<>\"']+\.[^@\s,;<>\"']+")
_CONTROL = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]")


def _digits(value: str) -> str:
    return re.sub(r"\D", "", value or "")


def clean_updates(data) -> tuple[dict, str | None]:
    """Validate the contact fields present in a settings PUT body. Returns ({column: value}, None), or
    ({}, message) for the first problem, in which case nothing may be saved. Blank clears a field."""
    updates: dict = {}
    for key, (column, limit, kind) in FIELDS.items():
        if key not in data:
            continue
        label = LABELS[key]
        raw = data[key]
        if raw is None:
            updates[column] = ""
            continue
        if not isinstance(raw, str):
            return {}, f"{label} must be text"
        value = raw.strip() if kind == "note" else " ".join(raw.split())
        if _CONTROL.search(value):
            return {}, f"{label} contains characters that can't be used"
        if len(value) > limit:
            return {}, f"{label} must be at most {limit} characters"
        if value and kind == "phone":
            digits = len(_digits(value))
            if not _PHONE_CHARS.fullmatch(value) or "+" in value[1:] or not 6 <= digits <= 15:
                return {}, (
                    f"{label} must be one phone number (6-15 digits, spaces and + - ( ) allowed), "
                    "for example 0421 430 0800 or +91 98765 43210"
                )
        if value and kind == "email" and not _EMAIL.fullmatch(value):
            return {}, f"{label} must be a valid email address, for example hr@company.com"
        updates[column] = value
    return updates, None


def _dial(raw: str) -> str:
    """What a tel: link should dial: the digits as entered, keeping a leading +."""
    digits = _digits(raw)
    return ("+" if digits and raw.strip().startswith("+") else "") + digits


def _whatsapp_number(raw: str) -> str:
    """The international number (digits, with the country code) a wa.me link needs, or ""."""
    if not _digits(raw):
        return ""
    from . import whatsapp_service

    return whatsapp_service.normalize_phone(raw) or ""


def _block(ps, prefix: str, default_label: str) -> dict:
    def get(name: str) -> str:
        return (getattr(ps, f"{prefix}_contact_{name}", "") or "").strip()

    phone, whatsapp, email = get("phone"), get("whatsapp"), get("email")
    return {
        "label": get("name") or default_label,
        "phone": phone,
        "phoneDial": _dial(phone),
        "whatsapp": whatsapp,
        "whatsappNumber": _whatsapp_number(whatsapp),
        "email": email,
        "hours": get("hours"),
        "hasContact": bool(phone or whatsapp or email),
    }


def contact_payload(ps) -> dict:
    """What the apps get. `hr` is for sign-in and app problems, `support` for the server being down."""
    hr = _block(ps, "hr", DEFAULT_HR_LABEL)
    support = _block(ps, "support", DEFAULT_SUPPORT_LABEL)
    support["usesHrFallback"] = False
    if not support["hasContact"] and hr["hasContact"]:
        support = {**hr, "usesHrFallback": True}
    hr["usesHrFallback"] = False
    return {
        "hr": hr,
        "support": support,
        "note": (getattr(ps, "contact_note", "") or "").strip(),
        "companyName": ps.company_name,
        # False until HR has entered at least one way to reach someone: the apps then show plain wording.
        "configured": bool(hr["hasContact"] or support["hasContact"]),
        "updatedAt": ps.updated_at.isoformat() if ps.updated_at else None,
    }


@api_view(["GET"])
def support_contact(request: Request) -> Response:
    """Public on purpose (like the app-update check): the sign-in screen needs it before anyone has signed in,
    and a signed-out app must never be sent to the login page by it. Returns only what HR chose to publish."""
    from .models import PayrollSettings

    response = Response(contact_payload(PayrollSettings.get()))
    # The apps keep their own copy for when the server is unreachable; when they can ask, the answer is current.
    response["Cache-Control"] = "no-store"
    return response

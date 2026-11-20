"""Helpers for the tests of the modules that RAISE WhatsApp messages (approvals, alerts, gate, visitors, Department Heads,
reminders, Attendance Notify, documents), on top of tests_whatsapp_support's FakeMeta.

    from .tests_whatsapp_caller_support import sent_text, sent_texts, assert_template_variables

`sent_text(record)` is what the employee reads for one message FakeMeta received: the approved template's body (as
approve_templates made it: the catalog wording) with the variables Meta was given. `assert_template_variables` checks the
rule every caller must keep: the variables it sends are the type's catalog variables, each on one line.
"""

from __future__ import annotations

import re

from . import whatsapp_catalog as catalog

_PLACEHOLDER = re.compile(r"\{\{\s*([A-Za-z_][A-Za-z0-9_]*|\d+)\s*\}\}")


def _body_of(template_name: str) -> str:
    from .models import WhatsAppTemplate

    row = WhatsAppTemplate.objects.filter(name=template_name).order_by("id").first()
    for comp in (row.components or []) if row is not None else []:
        if isinstance(comp, dict) and str(comp.get("type") or "").upper() == "BODY":
            return str(comp.get("text") or "")
    return ""


def sent_text(record: dict) -> str:
    """The text of one message FakeMeta received (its template's body with the variables filled in)."""
    params = record.get("params") or {}
    body = _body_of(record.get("template") or "")
    return _PLACEHOLDER.sub(lambda m: str(params.get(m.group(1), "")), body).strip()


def sent_texts(meta) -> list[str]:
    return [sent_text(r) for r in meta.sent]


def type_of_template(template_name: str) -> str | None:
    """The catalog type whose default template this is (None for a custom name)."""
    for key, spec in catalog.TYPES.items():
        if spec.default_template_name == template_name:
            return key
    return None


def assert_template_variables(test, record: dict, document_type: str | None = None) -> None:
    """Every variable Meta was given is one of the type's catalog variables, on one line, never empty, never more than
    4 spaces in a row (Meta's rules for a template variable)."""
    key = document_type or type_of_template(record.get("template") or "")
    test.assertIsNotNone(key, f"no catalog type sends the template {record.get('template')!r}")
    allowed = set(catalog.get(key).variable_names)
    test.assertLessEqual(set(record["params"]), allowed, f"{key}: variables the catalog does not list")
    for name, value in record["params"].items():
        test.assertIsInstance(value, str, f"{key}.{name}")
        test.assertTrue(value, f"{key}.{name} is empty")
        test.assertNotRegex(value, r"[\n\r\t]", f"{key}.{name} is not one line")
        test.assertNotIn("     ", value, f"{key}.{name} has more than 4 spaces in a row")

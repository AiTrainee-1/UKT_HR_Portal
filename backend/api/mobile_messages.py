"""Mobile Messages: which of the messages the HRMS sends get pushed to employees' phones (Mobile App Login -> Mobile Messages).

Every WhatsApp message is also an in-app notification and a phone push (push_messages.py, signals.py). This module is HR's control
over the PUSH half: a master switch and a switch per message type, kept in MobileMessageSettings. The in-app record is always saved
(switching a message off here never loses it from the Notifications page); only the push to the phone stops, and the row says so
(`push_status = "off"`).

The messages and their groups come from whatsapp_catalog.py, so a new WhatsApp message appears here with no change in this file.
The approval wording is shared by every workflow, so each workflow ("approval:leave") has its own switch as well: a message of
the approval kind is pushed only while BOTH its type and its workflow are on.
"""

from __future__ import annotations

from . import push_messages
from . import whatsapp_catalog as catalog

MANUAL = "manual"  # a message HR typed on the Mobile Messages page
APPROVAL_PREFIX = "approval:"


def approval_key(module: str) -> str:
    return f"{APPROVAL_PREFIX}{module}"


def controls() -> list[dict]:
    """Every switch, in the order the page lists them: [{key, label, description, group, groupLabel, kind}]. Never includes a
    one-time code: those are not notifications at all."""
    rows: list[dict] = []
    for module, label in catalog.MODULES.items():
        for key in catalog.types_in(module):
            if key in push_messages.EXCLUDED_TYPES:
                continue
            t = catalog.TYPES[key]
            rows.append(
                {
                    "key": key,
                    "label": t.label,
                    "description": t.description,
                    "group": module,
                    "groupLabel": label,
                    "kind": "message",
                }
            )
    for module, label in catalog.APPROVAL_MODULES.items():
        rows.append(
            {
                "key": approval_key(module),
                "label": label,
                "description": f"The approval and rejection messages of {label.lower()} requests.",
                "group": "approval_workflows",
                "groupLabel": "Approvals by workflow",
                "kind": "workflow",
            }
        )
    return rows


def valid_keys() -> set[str]:
    return {row["key"] for row in controls()}


def push_allowed(source: str, related_module: str = "") -> bool:
    """May this notification be pushed to phones? The master switch first, then the message type, then (for the approval kind)
    its workflow. An older notification with no source (and a message HR typed) is only subject to the master switch."""
    from .models import MobileMessageSettings

    s = MobileMessageSettings.get()
    if not s.push_enabled:
        return False
    if not source or source == MANUAL:
        return True
    off = set(s.disabled_types or [])
    if source in off:
        return False
    return not (related_module and approval_key(related_module) in off)

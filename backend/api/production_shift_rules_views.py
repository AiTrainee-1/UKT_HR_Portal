"""
Settings -> Production shifts: the editable shift table of PRODUCTION employees (production_shift_rules.py is the engine).

  GET  /api/production-shift-rules           the whole document (permission module `settings.attendance`, view)
  PUT  /api/production-shift-rules           save it (same module, edit; company-wide: a branch login gets 403)
  POST /api/production-shift-rules/preview   what a made-up day earns with the SAVED rules (module view; writes nothing)

The legacy /api/production-shift-config and /api/production-shift-segments endpoints (system_settings_views.py) are not
touched: the punch1..4 times, the 10-minute grace and the segments they edit are the calculation of every day BEFORE the
document's `effectiveFrom`.

Body (GET, and the PUT answer):
  {
    "enabled": true, "effectiveFrom": "2026-10-14", "graceMinutes": 5, "minCredit": 0.0, "roundingStep": 0.01,
    "roundingMode": "nearest", "fullDayValue": 1.0, "nightSessionHours": 12,
    "groups": [{"id": 1, "label": "Day shift", "kind": "day", "appliesOn": "mon_sat", "startTime": "08:30",
                "firstPunchFrom": "04:00", "firstPunchTo": "16:59", "mainOutTime": "20:00", "mainOutNextDay": false,
                "enabled": true,
                "rules": [{"id": 1, "label": "Leaves at morning tea", "outTime": "10:30", "outNextDay": false,
                           "shiftValue": 0.25, "enabled": true}]}],
    "breaks": [{"id": 1, "label": "Morning tea", "startTime": "10:30", "endTime": "10:45", "enabled": true}],
    "updatedAt": "2026-10-14T10:00:00+05:30", "updatedBy": "Asha", "warnings": [],
    "legacy": {"punch1Time": "08:30", "punch2Time": "12:45", "punch3Time": "13:30", "punch4Time": "20:00",
               "graceMinutes": 10},
    "version": "9f2c41d07a3b5e68"
  }
Times are "HH:MM" (24 hour); a time after midnight is the clock time plus `outNextDay` / `mainOutNextDay`. `updatedAt` /
`updatedBy` are the last SAVE from this page (read from the audit trail; null until somebody has saved). `legacy` is a
read-only echo of what the old calculation uses. `version` is a fingerprint of everything the PUT can change.

PUT takes the same body without updatedAt / updatedBy / warnings / legacy / version (they are ignored when sent back, so
the GET body can be sent as it is, a stale one included: it simply restores that table). Every top-level key is optional (an omitted one is left alone); `groups` and `breaks`, when
sent, REPLACE the whole table: an item with an `id` updates that row, an item without one is created, and a row whose id
is missing from the array is deleted (a deleted group takes its rules with it); inside an item an omitted key keeps the
stored value (a group item sent without `rules` keeps its rules). The ORDER of an array is the order of the table
(`order` is numbered from it). A rule can never move to another group. The PUT is all-or-nothing: any problem is a 400
{"error": "<one plain sentence>"} and nothing is saved. The answer is the new body (the ids of new rows included) plus
`warnings`. A save that changes nothing writes nothing (no audit row either).

`expectedVersion` is the guard against a stale copy: a page that sends back the `version` it loaded (as `expectedVersion`)
and finds it is not what is saved now (somebody else saved after the page was loaded) gets a 400
{"error": ..., "code": "stale_settings"} and nothing is saved. A body without `expectedVersion` skips that check (the plain
GET body, whose `version` is ignored, is a deliberate restore); the settings row is still locked (SELECT ... FOR UPDATE)
for the whole save, so two saves at the same moment run one after the other, and a row id that no longer exists is refused
with "reload the page".

Rules of the PUT (each a plain-sentence 400 when broken):
  * `enabled` true/false; `effectiveFrom` a real date YYYY-MM-DD (2000..2100) - or null while `enabled` is false; switching
    the rules on with no date named starts them TODAY (IST), so they never reach back into days already judged;
  * `graceMinutes` 0..30; `nightSessionHours` 1..24; `minCredit` 0..9.99 and not above the most any enabled group can
    pay; `roundingStep` 0.01 / 0.05 / 0.25; `roundingMode` nearest / down; `fullDayValue` > 0 and <= 9.99;
  * a group: a name, `kind` day / night / sunday / custom, `appliesOn` mon_sat / sunday / all, HH:MM times, the first-punch
    window not ending before it starts, a standard departure after the start time; enabled groups must not take the same
    first punch on the same days (windows may not overlap); an enabled group needs an enabled rule, and the rules cannot
    be switched on with no enabled group;
  * the rules of an enabled group (the enabled rows): leave-by times after the group's start, strictly increasing in the
    order of the array (a next-day time is after a same-day one), shift values > 0, <= 9.99, at most two decimals and never
    going down, and no two on the same PAID time (a rule at the end of a break and one at its start are the same paid
    time: the engine cannot tell them apart);
  * a break: start before end on the same day; enabled breaks must not overlap.

`warnings` (advice; the save has happened): a ladder point inside a break, a weekday no enabled group covers, a full-day
value no day of a group can reach (these three are also in the GET body: they are mistakes in what is saved), and - only
in the answer of the save that changes the rules - a start date in the past, production payroll already generated for days
these rules judge ("days from <date> are re-judged: regenerate payroll to apply"), and a group the save touched that has
no rule after its standard departure (time worked later earns nothing more).
"""

import hashlib
import json
import math
import re
from dataclasses import dataclass, field
from datetime import date as date_type, time as time_type
from decimal import Decimal, InvalidOperation
from itertools import combinations

from django.db import transaction
from django.db.models import Max
from rest_framework.decorators import api_view
from rest_framework.request import Request
from rest_framework.response import Response

from . import production_shift_rules as psr
from .attendance_final import production_day_result
from .audit_utils import log_action
from .auth import require_hr
from .branch_scope import get_branch_scope
from .clock import FACTORY_TZ, ist_today
from .models import (
    AuditLog,
    Payroll,
    ProductionBreak,
    ProductionShiftConfig,
    ProductionShiftGroup,
    ProductionShiftRule,
)

AUDIT_MODULE = "production_shift_rules"

COMPANY_WIDE_MESSAGE = (
    "Production shift rules apply to the whole company, so a branch login can read them but not change them. "
    "Ask an administrator or a head-office login."
)

STALE_GROUP = "A shift group that no longer exists was edited: reload the page and try again."
STALE_RULE = "A shift rule that no longer exists was edited: reload the page and try again."
STALE_BREAK = "A break that no longer exists was edited: reload the page and try again."
STALE_VERSION = (
    "The production shift rules were changed by somebody else after this page was loaded: reload the page and make your "
    "change again."
)

# Sanity ceilings: a typo, not a real table (they also bound the work one request can ask for).
MAX_GROUPS = 12
MAX_RULES_PER_GROUP = 60
MAX_BREAKS = 30
MAX_LABEL = 100
MAX_PREVIEW_PUNCHES = 24

CENT = Decimal("0.01")
MAX_SHIFT_VALUE = Decimal("9.99")
DAY_MIN = 1440

_DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
_TIME_RE = re.compile(r"^(?:[01]\d|2[0-3]):[0-5]\d$")
_MISSING = object()

# the document's top-level settings -> the column of the config row they live in
SCALARS = {
    "enabled": "rules_enabled",
    "effectiveFrom": "rules_effective_from",
    "graceMinutes": "rules_grace_minutes",
    "minCredit": "rules_min_credit",
    "roundingStep": "rules_rounding_step",
    "roundingMode": "rules_rounding_mode",
    "fullDayValue": "rules_full_day_value",
    "nightSessionHours": "rules_night_session_hours",
}
_FIELD_LABELS = {
    "enabled": "master switch",
    "effectiveFrom": "start date",
    "graceMinutes": "grace minutes",
    "minCredit": "minimum credit",
    "roundingStep": "rounding step",
    "roundingMode": "rounding mode",
    "fullDayValue": "full-day value",
    "nightSessionHours": "night session hours",
    "groups": "shift groups and rules",
    "breaks": "breaks",
}


class SettingsError(Exception):
    """A problem with the submitted document: the message is the one plain sentence the 400 carries."""

    def __init__(self, message: str, code: str | None = None):
        super().__init__(message)
        self.code = code


# ── small readers / formatters ──────────────────────────────────────────────


def _hhmm(value: time_type | None) -> str | None:
    """A stored time as "HH:MM" (seconds dropped: the engine floors every punch to its minute anyway)."""
    return value.strftime("%H:%M") if value is not None else None


def _minutes(text: str) -> int:
    return int(text[:2]) * 60 + int(text[3:5])


def _to_time(text: str) -> time_type:
    return time_type(int(text[:2]), int(text[3:5]))


def _clock(minutes: int) -> str:
    """Minutes since the shift day's midnight as a clock time, '(next day)' past midnight."""
    text = f"{(minutes % DAY_MIN) // 60:02d}:{minutes % 60:02d}"
    return f"{text} (next day)" if minutes >= DAY_MIN else text


def _plain(value):
    """The document as JSON-safe plain data: Decimals become floats (a shift value of 0.25 is 0.25 on the wire)."""
    if isinstance(value, Decimal):
        return float(value)
    if isinstance(value, dict):
        return {k: _plain(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [_plain(v) for v in value]
    return value


def _version(plain: dict) -> str:
    """A fingerprint of the document: it changes whenever anything the PUT can change does."""
    text = json.dumps(plain, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(text.encode()).hexdigest()[:16]


def _judging(plain: dict) -> dict:
    """The document without the names: what decides how a day is judged (a rename alone changes no figure)."""
    if isinstance(plain, dict):
        return {k: _judging(v) for k, v in plain.items() if k != "label"}
    if isinstance(plain, list):
        return [_judging(v) for v in plain]
    return plain


# ── reading ─────────────────────────────────────────────────────────────────


@dataclass
class _State:
    config: ProductionShiftConfig
    groups: list
    rules_by_group: dict = field(default_factory=dict)
    breaks: list = field(default_factory=list)


def _load_state(config: ProductionShiftConfig | None = None) -> _State:
    """The saved rows. Reading never creates the settings row: a database without one shows the defaults (no start date,
    so the old calculation) until somebody saves."""
    if config is None:
        config = ProductionShiftConfig.objects.filter(pk=1).first() or ProductionShiftConfig(pk=1)
    groups = list(ProductionShiftGroup.objects.order_by("order", "id"))
    rules_by_group: dict = {}
    for rule in ProductionShiftRule.objects.order_by("order", "id"):
        rules_by_group.setdefault(rule.group_id, []).append(rule)
    breaks = list(ProductionBreak.objects.order_by("order", "id"))
    return _State(config, groups, rules_by_group, breaks)


def _document(state: _State) -> dict:
    """The saved state as the document (Decimals still Decimals; see _plain)."""
    config = state.config
    return {
        "enabled": bool(config.rules_enabled),
        "effectiveFrom": str(config.rules_effective_from) if config.rules_effective_from else None,
        "graceMinutes": config.rules_grace_minutes,
        "minCredit": Decimal(config.rules_min_credit).quantize(CENT),
        "roundingStep": Decimal(config.rules_rounding_step).quantize(CENT),
        "roundingMode": config.rules_rounding_mode,
        "fullDayValue": Decimal(config.rules_full_day_value).quantize(CENT),
        "nightSessionHours": config.rules_night_session_hours,
        "groups": [
            {
                "id": g.id,
                "label": g.label,
                "kind": g.kind,
                "appliesOn": g.applies_on,
                "startTime": _hhmm(g.start_time),
                "firstPunchFrom": _hhmm(g.first_punch_from),
                "firstPunchTo": _hhmm(g.first_punch_to),
                "mainOutTime": _hhmm(g.main_out_time),
                "mainOutNextDay": bool(g.main_out_next_day) if g.main_out_time is not None else False,
                "enabled": g.enabled,
                "rules": [
                    {
                        "id": r.id,
                        "label": r.label,
                        "outTime": _hhmm(r.out_time),
                        "outNextDay": r.out_next_day,
                        "shiftValue": Decimal(r.shift_value).quantize(CENT),
                        "enabled": r.enabled,
                    }
                    for r in state.rules_by_group.get(g.id, [])
                ],
            }
            for g in state.groups
        ],
        "breaks": [
            {
                "id": b.id,
                "label": b.label,
                "startTime": _hhmm(b.start_time),
                "endTime": _hhmm(b.end_time),
                "enabled": b.enabled,
            }
            for b in state.breaks
        ],
    }


def _legacy(config: ProductionShiftConfig) -> dict:
    """What the old calculation uses (read-only here: edited by the legacy endpoints, kept for days before the start)."""
    return {
        "punch1Time": _hhmm(config.punch1_time),
        "punch2Time": _hhmm(config.punch2_time),
        "punch3Time": _hhmm(config.punch3_time),
        "punch4Time": _hhmm(config.punch4_time),
        "graceMinutes": config.grace_minutes,
    }


def _last_save() -> tuple[str | None, str | None]:
    """(updatedAt, updatedBy) of the last save from this page, from the audit trail (None, None before the first)."""
    row = (
        AuditLog.objects.filter(module=AUDIT_MODULE, action="update")
        .order_by("-created_at", "-id")
        .values("user_name", "created_at")
        .first()
    )
    if row is None:
        return None, None
    return row["created_at"].astimezone(FACTORY_TZ).isoformat(), row["user_name"]


def _advice(document: dict) -> list[str]:
    """Advice about the saved table (never blocks a save). See the module docstring."""
    out: list[str] = []
    breaks = [b for b in document["breaks"] if b["enabled"]]
    live = [g for g in document["groups"] if g["enabled"]]
    for g in live:
        rules = [r for r in g["rules"] if r["enabled"]]
        if not rules:
            continue
        for r in rules:
            minutes = _minutes(r["outTime"]) + (DAY_MIN if r["outNextDay"] else 0)
            for b in breaks:
                start, end = _minutes(b["startTime"]), _minutes(b["endTime"])
                if start < minutes % DAY_MIN < end:
                    out.append(
                        f"{g['label']}: the {_clock(minutes)} rule falls inside the {b['label'] or 'break'} "
                        f"({b['startTime']}-{b['endTime']}), which is unpaid, so it counts as {b['startTime']}."
                    )
    if document["enabled"]:
        covered = {"mon_sat": False, "sunday": False}
        for g in live:
            if any(r["enabled"] for r in g["rules"]):
                for day in ("mon_sat", "sunday") if g["appliesOn"] == "all" else (g["appliesOn"],):
                    covered[day] = True
        for day, name in (("mon_sat", "Monday to Saturday"), ("sunday", "Sunday")):
            if not covered[day] and live:
                out.append(
                    f"No enabled shift group applies on {name}, so those days are still judged by the old calculation."
                )
        full_day = document["fullDayValue"]
        for g in live:
            rules = [r for r in g["rules"] if r["enabled"]]
            if rules and full_day > max(r["shiftValue"] for r in rules):
                out.append(
                    f"The full-day value {full_day:.2f} is more than the most the {g['label']} can pay "
                    f"({max(r['shiftValue'] for r in rules):.2f}), so every day in it counts as a half shift."
                )
    return out


def _cap_advice(before: dict, after: dict) -> list[str]:
    """Advice only the save that touches a group can give: that group has no rule after its standard departure, so time
    worked later earns nothing more. Not in the GET body: for the seeded Night and Sunday groups it is how the owner's
    table is written, and a banner nobody can act on would be shown on every visit. Groups the save did not change say
    nothing."""
    stored = {g["id"]: g for g in before["groups"]}
    out = []
    for g in after["groups"]:
        if not g["enabled"] or g["mainOutTime"] is None or g == stored.get(g["id"]):
            continue
        rules = [r for r in g["rules"] if r["enabled"]]
        if not rules:
            continue
        main = _minutes(g["mainOutTime"]) + (DAY_MIN if g["mainOutNextDay"] else 0)
        if not any(_minutes(r["outTime"]) + (DAY_MIN if r["outNextDay"] else 0) > main for r in rules):
            top = max(r["shiftValue"] for r in rules)
            out.append(
                f"{g['label']}: there is no rule after the standard departure {_clock(main)}, so time worked later "
                f"earns nothing more (the day stays at {top:.2f}). Add a row if later work should earn more."
            )
    return out


def rules_body(extra_warnings=()) -> dict:
    """The whole document with its read-only extras (see the module docstring)."""
    state = _load_state()
    document = _document(state)
    plain = _plain(document)
    updated_at, updated_by = _last_save()
    return {
        **plain,
        "updatedAt": updated_at,
        "updatedBy": updated_by,
        "warnings": [*extra_warnings, *_advice(document)],
        "legacy": _legacy(state.config),
        "version": _version(plain),
    }


# ── validating a body ───────────────────────────────────────────────────────


def _as_int(value):
    """A JSON whole number (5 or 5.0) as an int, else None."""
    if isinstance(value, bool):
        return None
    if isinstance(value, int):
        return value
    if isinstance(value, float) and math.isfinite(value) and value.is_integer():
        return int(value)
    return None


def _as_decimal(value):
    """A JSON number with at most two decimals as a Decimal, else None (a string, a bool, 1e999, 0.125 are all None).
    A Decimal is the stored value of a row an item did not restate: it passes the same test."""
    if isinstance(value, bool) or not isinstance(value, (int, float, Decimal)):
        return None
    if isinstance(value, float) and not math.isfinite(value):
        return None
    if isinstance(value, Decimal) and not value.is_finite():
        return None
    try:
        exact = Decimal(str(value))
        rounded = exact.quantize(CENT)
    except InvalidOperation:
        return None
    return rounded if rounded == exact else None


def _bool(value, message: str) -> bool:
    if not isinstance(value, bool):
        raise SettingsError(message)
    return value


def _time(value, where: str, what: str) -> str:
    """ "HH:MM" as given, or the sentence saying what was wrong (a missing value included)."""
    if not isinstance(value, str) or not _TIME_RE.match(value.strip()):
        raise SettingsError(f"{where}: {what} must be a time written HH:MM (24-hour), for example 08:30.")
    return value.strip()


def _pick(item: dict, base: dict | None, key: str, default=_MISSING):
    """The value sent for `key`, else the stored one (an existing row), else the default (a new row), else _MISSING."""
    if key in item:
        return item[key]
    if base is not None:
        return base[key]
    return default


def _label(value, where: str, what: str, required: bool) -> str:
    if value is _MISSING or value is None:
        value = ""
    if not isinstance(value, str):
        raise SettingsError(f"{where}: {what} must be text.")
    value = value.strip()
    if required and not value:
        raise SettingsError(f"{where}: {what} is required.")
    if len(value) > MAX_LABEL:
        raise SettingsError(f"{where}: {what} can be at most {MAX_LABEL} characters.")
    return value


def _item_id(item: dict, where: str, seen: set, noun: str):
    """The row id an item carries (None for a new row); a repeated or non-numeric one is a sentence."""
    raw = item.get("id")
    if raw is None:
        return None
    row_id = _as_int(raw)
    if row_id is None:
        raise SettingsError(f"{where}: the id must be a whole number.")
    if row_id in seen:
        raise SettingsError(f"{where}: the same {noun} id is used twice.")
    seen.add(row_id)
    return row_id


def _parse_scalars(data: dict, before: dict, today: date_type) -> dict:
    doc = {key: before[key] for key in SCALARS}
    if "enabled" in data:
        doc["enabled"] = _bool(data["enabled"], "The master switch ('enabled') must be true or false.")
    if "effectiveFrom" in data:
        raw = data["effectiveFrom"]
        if raw in (None, ""):
            doc["effectiveFrom"] = None
        else:
            if not isinstance(raw, str) or not _DATE_RE.match(raw):
                raise SettingsError("Applies from must be a date written YYYY-MM-DD (for example 2026-10-14).")
            try:
                parsed = date_type.fromisoformat(raw)
            except ValueError:
                raise SettingsError("Applies from must be a real date, for example 2026-10-14.") from None
            if not 2000 <= parsed.year <= 2100:
                raise SettingsError("Applies from must be a date between the years 2000 and 2100.")
            doc["effectiveFrom"] = raw
    if "graceMinutes" in data:
        grace = _as_int(data["graceMinutes"])
        if grace is None or not 0 <= grace <= 30:
            raise SettingsError("Grace minutes must be a whole number between 0 and 30.")
        doc["graceMinutes"] = grace
    if "nightSessionHours" in data:
        hours = _as_int(data["nightSessionHours"])
        if hours is None or not 1 <= hours <= 24:
            raise SettingsError("Night session hours must be a whole number between 1 and 24.")
        doc["nightSessionHours"] = hours
    if "minCredit" in data:
        credit = _as_decimal(data["minCredit"])
        if credit is None or not 0 <= credit <= MAX_SHIFT_VALUE:
            raise SettingsError("Minimum credit must be a number between 0 and 9.99, with at most two decimals.")
        doc["minCredit"] = credit
    if "roundingStep" in data:
        step = _as_decimal(data["roundingStep"])
        if step is None or step not in psr.ROUNDING_STEPS:
            raise SettingsError("Rounding step must be 0.01, 0.05 or 0.25.")
        doc["roundingStep"] = step
    if "roundingMode" in data:
        if data["roundingMode"] not in psr.ROUNDING_MODES:
            raise SettingsError("Rounding mode must be 'nearest' or 'down'.")
        doc["roundingMode"] = data["roundingMode"]
    if "fullDayValue" in data:
        full = _as_decimal(data["fullDayValue"])
        if full is None or not 0 < full <= MAX_SHIFT_VALUE:
            raise SettingsError("Full-day value must be more than 0 and at most 9.99, with at most two decimals.")
        doc["fullDayValue"] = full
    # The date is what keeps the new rules away from days already judged: while they are on, one is always set.
    if doc["enabled"] and doc["effectiveFrom"] is None:
        if "effectiveFrom" in data:
            raise SettingsError("Applies from: choose the first day the new rules are used while they are switched on.")
        doc["effectiveFrom"] = today.isoformat()
    return doc


def _parse_rules(items, base_rules: list, where: str, seen: set, other_rule_ids: set) -> list[dict]:
    if not isinstance(items, list):
        raise SettingsError(f"{where}: 'rules' must be a list.")
    if len(items) > MAX_RULES_PER_GROUP:
        raise SettingsError(f"{where}: there can be at most {MAX_RULES_PER_GROUP} rules in one group.")
    by_id = {r["id"]: r for r in base_rules}
    out = []
    for position, item in enumerate(items, start=1):
        here = f"{where}, rule {position}"
        if not isinstance(item, dict):
            raise SettingsError("Every rule must be an object.")
        rule_id = _item_id(item, here, seen, "rule")
        base = None
        if rule_id is not None:
            base = by_id.get(rule_id)
            if base is None:
                if rule_id in other_rule_ids:
                    raise SettingsError(f"{here}: this rule belongs to another group: reload the page and try again.")
                raise SettingsError(STALE_RULE)
        rule = {"id": rule_id}
        rule["label"] = _label(_pick(item, base, "label", ""), here, "the name", required=False)
        rule["outTime"] = _time(_pick(item, base, "outTime"), here, "the leave-by time")
        rule["outNextDay"] = _bool(
            _pick(item, base, "outNextDay", False), f"{here}: 'outNextDay' must be true or false."
        )
        value = _as_decimal(_pick(item, base, "shiftValue"))
        if value is None or not 0 < value <= MAX_SHIFT_VALUE:
            raise SettingsError(
                f"{here}: the shift value must be a number more than 0 and at most 9.99, with at most two decimals."
            )
        rule["shiftValue"] = value
        rule["enabled"] = _bool(_pick(item, base, "enabled", True), f"{here}: 'enabled' must be true or false.")
        out.append(rule)
    return out


def _parse_groups(items, before_groups: list) -> list[dict]:
    if not isinstance(items, list):
        raise SettingsError("'groups' must be a list.")
    if len(items) > MAX_GROUPS:
        raise SettingsError(f"There can be at most {MAX_GROUPS} shift groups.")
    existing = {g["id"]: g for g in before_groups}
    rule_owner = {r["id"]: g["id"] for g in before_groups for r in g["rules"]}
    seen_groups: set = set()
    seen_rules: set = set()
    out = []
    for position, item in enumerate(items, start=1):
        where = f"Shift group {position}"
        if not isinstance(item, dict):
            raise SettingsError("Every shift group must be an object.")
        group_id = _item_id(item, where, seen_groups, "group")
        base = None
        if group_id is not None:
            base = existing.get(group_id)
            if base is None:
                raise SettingsError(STALE_GROUP)
        group = {"id": group_id}
        group["label"] = _label(_pick(item, base, "label"), where, "the name", required=True)
        where = group["label"]
        group["kind"] = _pick(item, base, "kind", "custom")
        if group["kind"] not in psr.KIND_CHOICES:
            raise SettingsError(f"{where}: the kind must be one of {', '.join(psr.KIND_CHOICES)}.")
        group["appliesOn"] = _pick(item, base, "appliesOn", "mon_sat")
        if group["appliesOn"] not in psr.APPLIES_ON_CHOICES:
            raise SettingsError(f"{where}: 'appliesOn' must be one of {', '.join(psr.APPLIES_ON_CHOICES)}.")
        group["startTime"] = _time(_pick(item, base, "startTime"), where, "the start time")
        group["firstPunchFrom"] = _time(_pick(item, base, "firstPunchFrom"), where, "the first-punch window start")
        group["firstPunchTo"] = _time(_pick(item, base, "firstPunchTo"), where, "the first-punch window end")
        main_out = _pick(item, base, "mainOutTime", None)
        group["mainOutTime"] = None if main_out in (None, "") else _time(main_out, where, "the standard departure")
        next_day = _bool(
            _pick(item, base, "mainOutNextDay", False), f"{where}: 'mainOutNextDay' must be true or false."
        )
        group["mainOutNextDay"] = next_day if group["mainOutTime"] is not None else False
        group["enabled"] = _bool(_pick(item, base, "enabled", True), f"{where}: 'enabled' must be true or false.")
        if "rules" in item:
            rules_in = item["rules"]
        else:
            rules_in = [dict(r) for r in base["rules"]] if base is not None else []
        other_ids = {rid for rid, owner in rule_owner.items() if owner != group_id}
        group["rules"] = _parse_rules(rules_in, base["rules"] if base is not None else [], where, seen_rules, other_ids)
        out.append(group)
    return out


def _parse_breaks(items, before_breaks: list) -> list[dict]:
    if not isinstance(items, list):
        raise SettingsError("'breaks' must be a list.")
    if len(items) > MAX_BREAKS:
        raise SettingsError(f"There can be at most {MAX_BREAKS} breaks.")
    existing = {b["id"]: b for b in before_breaks}
    seen: set = set()
    out = []
    for position, item in enumerate(items, start=1):
        where = f"Break {position}"
        if not isinstance(item, dict):
            raise SettingsError("Every break must be an object.")
        break_id = _item_id(item, where, seen, "break")
        base = None
        if break_id is not None:
            base = existing.get(break_id)
            if base is None:
                raise SettingsError(STALE_BREAK)
        row = {"id": break_id}
        row["label"] = _label(_pick(item, base, "label", ""), where, "the name", required=False)
        if row["label"]:
            where = row["label"]
        row["startTime"] = _time(_pick(item, base, "startTime"), where, "the start time")
        row["endTime"] = _time(_pick(item, base, "endTime"), where, "the end time")
        row["enabled"] = _bool(_pick(item, base, "enabled", True), f"{where}: 'enabled' must be true or false.")
        out.append(row)
    return out


def _validate(doc: dict) -> None:
    """The rules that look at the table as a whole (the final table: what will be saved)."""
    live_breaks = []
    for position, b in enumerate(doc["breaks"], start=1):
        name = b["label"] or f"Break {position}"
        start, end = _minutes(b["startTime"]), _minutes(b["endTime"])
        if start >= end:
            raise SettingsError(
                f"{name}: the break must end after it starts ({b['startTime']} to {b['endTime']}); "
                "a break cannot cross midnight."
            )
        if not b["enabled"]:
            continue
        for other, o_start, o_end in live_breaks:
            if start < o_end and o_start < end:
                raise SettingsError(
                    f"{name} ({b['startTime']}-{b['endTime']}) overlaps {other} "
                    f"({o_start // 60:02d}:{o_start % 60:02d}-{o_end // 60:02d}:{o_end % 60:02d}): "
                    "breaks that are switched on cannot overlap."
                )
        live_breaks.append((name, start, end))
    windows = [psr.BreakWindow(name, start * 60, end * 60) for name, start, end in live_breaks]

    live_groups = []
    for g in doc["groups"]:
        name = g["label"]
        start = _minutes(g["startTime"])
        window_from, window_to = _minutes(g["firstPunchFrom"]), _minutes(g["firstPunchTo"])
        if window_from > window_to:
            raise SettingsError(
                f"{name}: the first-punch window must not end before it starts ({g['firstPunchFrom']} to "
                f"{g['firstPunchTo']})."
            )
        if g["mainOutTime"] is not None:
            main = _minutes(g["mainOutTime"]) + (DAY_MIN if g["mainOutNextDay"] else 0)
            if main <= start:
                raise SettingsError(
                    f"{name}: the standard departure {_clock(main)} must be after the start time {g['startTime']}."
                )
        if not g["enabled"]:
            continue
        live_groups.append(g)
        rules = [r for r in g["rules"] if r["enabled"]]
        if not rules:
            raise SettingsError(f"{name} is switched on but has no enabled rule: add or enable at least one.")
        previous = None  # (minutes, value, paid seconds) of the enabled rule before
        for r in rules:
            minutes = _minutes(r["outTime"]) + (DAY_MIN if r["outNextDay"] else 0)
            if minutes <= start:
                raise SettingsError(
                    f"{name}: the {_clock(minutes)} rule is not after the start time {g['startTime']}: "
                    "a worker cannot leave before arriving."
                )
            if previous is not None:
                if minutes == previous[0]:
                    raise SettingsError(
                        f"{name}: two rules leave at {_clock(minutes)}; each time can only be used once."
                    )
                if minutes < previous[0]:
                    raise SettingsError(
                        f"{name}: the rules must be listed in time order, but {_clock(minutes)} comes after "
                        f"{_clock(previous[0])}."
                    )
                if r["shiftValue"] < previous[1]:
                    raise SettingsError(
                        f"{name}: the {_clock(minutes)} rule earns {r['shiftValue']:.2f}, less than the "
                        f"{_clock(previous[0])} rule before it ({previous[1]:.2f}): shift values can only stay the same "
                        "or go up."
                    )
            paid = psr.paid_seconds(start * 60, minutes * 60, windows)
            if previous is not None and paid == previous[2]:
                raise SettingsError(
                    f"{name}: the {_clock(previous[0])} and {_clock(minutes)} rules are on the same paid time (the "
                    "break between them is unpaid), so only one of the two can have a rule."
                )
            previous = (minutes, r["shiftValue"], paid)

    for a, b in combinations(live_groups, 2):
        shared_days = _days(a["appliesOn"]) & _days(b["appliesOn"])
        low = max(a["firstPunchFrom"], b["firstPunchFrom"])
        high = min(a["firstPunchTo"], b["firstPunchTo"])
        if shared_days and low <= high:
            raise SettingsError(
                f"{a['label']} and {b['label']} both take first punches between {low} and {high} on the same days: "
                "change one of the first-punch windows so a day belongs to one group only."
            )

    if doc["enabled"] and not live_groups:
        raise SettingsError(
            "The new rules are switched on but no shift group is switched on: switch a group on, or switch the rules off."
        )
    if doc["minCredit"] > 0:
        for g in live_groups:
            top = max(r["shiftValue"] for r in g["rules"] if r["enabled"])
            if doc["minCredit"] > top:
                raise SettingsError(
                    f"Minimum credit {doc['minCredit']:.2f} is more than the most {g['label']} can pay ({top:.2f}): "
                    "lower it or add a higher rule."
                )


def _days(applies_on: str) -> set:
    return {"mon_sat": {"mon_sat"}, "sunday": {"sunday"}, "all": {"mon_sat", "sunday"}}[applies_on]


# ── writing ─────────────────────────────────────────────────────────────────


def _differs(stored, wanted) -> bool:
    """Does a stored column differ from the wanted value? Times compare to the minute (a stored 16:59:59 is 16:59)."""
    if isinstance(stored, time_type) and isinstance(wanted, time_type):
        return stored.replace(second=0, microsecond=0) != wanted
    if isinstance(stored, Decimal) or isinstance(wanted, Decimal):
        return Decimal(str(stored)) != Decimal(str(wanted))
    return stored != wanted


def _write_row(model, existing, fields: dict, **extra):
    """Create the row, or update only the columns that really differ (a row nothing changed is not written)."""
    if existing is None:
        return model.objects.create(**fields, **extra)
    changed = [name for name, value in fields.items() if _differs(getattr(existing, name), value)]
    if changed:
        for name in changed:
            setattr(existing, name, fields[name])
        existing.save(update_fields=[*changed, "updated_at"])
    return existing


def _save_tables(state: _State, proposed: dict) -> None:
    """Make the tables what `proposed` says (validated): ids present are updated, new rows created, missing ones deleted
    (a group's rules go with it); `order` is numbered from the array order."""
    stored_groups = {g.id: g for g in state.groups}
    keep_groups = {g["id"] for g in proposed["groups"] if g["id"] is not None}
    gone = [gid for gid in stored_groups if gid not in keep_groups]
    if gone:
        ProductionShiftGroup.objects.filter(id__in=gone).delete()
    for order, g in enumerate(proposed["groups"], start=1):
        fields = {
            "label": g["label"],
            "kind": g["kind"],
            "applies_on": g["appliesOn"],
            "start_time": _to_time(g["startTime"]),
            "first_punch_from": _to_time(g["firstPunchFrom"]),
            "first_punch_to": _to_time(g["firstPunchTo"]),
            "main_out_time": _to_time(g["mainOutTime"]) if g["mainOutTime"] is not None else None,
            "main_out_next_day": g["mainOutNextDay"],
            "enabled": g["enabled"],
            "order": order,
        }
        group = _write_row(ProductionShiftGroup, stored_groups.get(g["id"]), fields)
        stored_rules = {r.id: r for r in state.rules_by_group.get(g["id"], [])} if g["id"] is not None else {}
        keep_rules = {r["id"] for r in g["rules"] if r["id"] is not None}
        gone_rules = [rid for rid in stored_rules if rid not in keep_rules]
        if gone_rules:
            ProductionShiftRule.objects.filter(id__in=gone_rules).delete()
        for rule_order, r in enumerate(g["rules"], start=1):
            _write_row(
                ProductionShiftRule,
                stored_rules.get(r["id"]),
                {
                    "label": r["label"],
                    "out_time": _to_time(r["outTime"]),
                    "out_next_day": r["outNextDay"],
                    "shift_value": r["shiftValue"],
                    "enabled": r["enabled"],
                    "order": rule_order,
                },
                group=group,
            )

    stored_breaks = {b.id: b for b in state.breaks}
    keep_breaks = {b["id"] for b in proposed["breaks"] if b["id"] is not None}
    gone_breaks = [bid for bid in stored_breaks if bid not in keep_breaks]
    if gone_breaks:
        ProductionBreak.objects.filter(id__in=gone_breaks).delete()
    for order, b in enumerate(proposed["breaks"], start=1):
        _write_row(
            ProductionBreak,
            stored_breaks.get(b["id"]),
            {
                "label": b["label"],
                "start_time": _to_time(b["startTime"]),
                "end_time": _to_time(b["endTime"]),
                "enabled": b["enabled"],
                "order": order,
            },
        )


@dataclass
class SaveResult:
    changed: bool
    warnings: list
    old_values: dict
    new_values: dict


def _change_warnings(before: dict, after: dict, today: date_type) -> list[str]:
    """Warnings that only the save which CHANGES the rules can give (see the module docstring)."""
    out: list[str] = []
    after_date = after["effectiveFrom"]
    if after["enabled"] and after_date and date_type.fromisoformat(after_date) < today:
        if after_date != before["effectiveFrom"] or not before["enabled"]:
            out.append(
                f"The new rules start on {after_date}, which is in the past: days from {after_date} up to today are "
                "judged by the new table whenever they are recalculated (a page opened, payroll generated again), so "
                "figures already shown for them can change."
            )
    if _judging(before) != _judging(after) and after_date and (before["enabled"] or after["enabled"]):
        last = Payroll.objects.filter(salary_mode="shift", period_end__isnull=False).aggregate(last=Max("period_end"))
        last_end = last["last"]
        if last_end is not None and last_end >= date_type.fromisoformat(after_date):
            out.append(
                f"Production payroll up to {last_end.isoformat()} has already been generated: days from {after_date} are "
                "re-judged by these rules when payroll is regenerated, so regenerate it to apply them (the payroll "
                "saved so far keeps its old figures until then)."
            )
    return out


@transaction.atomic
def apply_rules(data: dict, today: date_type | None = None) -> SaveResult:
    """Validate and save a PUT body (see the module docstring). Raises SettingsError (nothing saved). The settings row
    is read FOR UPDATE and held until the transaction ends, so two saves at the same moment run one after the other (the
    second starts from what the first saved)."""
    today = today or ist_today()
    ProductionShiftConfig.get()  # makes sure the row exists
    config = ProductionShiftConfig.objects.select_for_update().get(pk=1)
    state = _load_state(config)
    before = _document(state)
    before_plain = _plain(before)

    expected = data.get("expectedVersion")
    if expected is not None and expected != _version(before_plain):
        raise SettingsError(STALE_VERSION, code="stale_settings")

    proposed = _parse_scalars(data, before, today)
    proposed["groups"] = _parse_groups(data["groups"], before["groups"]) if "groups" in data else before["groups"]
    proposed["breaks"] = _parse_breaks(data["breaks"], before["breaks"]) if "breaks" in data else before["breaks"]
    _validate(proposed)

    if _plain(proposed) == before_plain:
        return SaveResult(False, [], {}, {})

    changed_columns = []
    for key, column in SCALARS.items():
        wanted = proposed[key]
        if key == "effectiveFrom":
            wanted = date_type.fromisoformat(wanted) if wanted else None
        if _differs(getattr(config, column), wanted):
            setattr(config, column, wanted)
            changed_columns.append(column)
    if changed_columns:
        config.save(update_fields=[*changed_columns, "updated_at"])
    _save_tables(state, proposed)

    after = _document(_load_state(config))
    after_plain = _plain(after)
    old_values: dict = {}
    new_values: dict = {}
    for key in (*SCALARS, "groups", "breaks"):
        if before_plain[key] != after_plain[key]:
            old_values[key] = before_plain[key]
            new_values[key] = after_plain[key]
    warnings = [*_change_warnings(before_plain, after_plain, today), *_cap_advice(before, after)]
    return SaveResult(True, warnings, old_values, new_values)


# ── views ───────────────────────────────────────────────────────────────────


def _forbid_branch_logins(request: Request):
    if get_branch_scope(request) is not None:
        return Response({"error": COMPANY_WIDE_MESSAGE, "code": "company_wide_settings"}, status=403)
    return None


@api_view(["GET", "PUT"])
@require_hr
def production_shift_rules(request: Request) -> Response:
    """GET: the Settings -> Production shifts document. PUT: save it (see the module docstring)."""
    if request.method == "GET":
        return Response(rules_body())

    refusal = _forbid_branch_logins(request)
    if refusal is not None:
        return refusal
    data = request.data
    if not isinstance(data, dict):
        return Response({"error": "The body must be a JSON object."}, status=400)
    try:
        result = apply_rules(data)
    except SettingsError as exc:
        payload = {"error": str(exc)}
        if exc.code:
            payload["code"] = exc.code
        return Response(payload, status=400)
    if result.changed:
        log_action(
            request,
            "update",
            "production_shift_rules",
            description="Changed production shift rules: "
            + ", ".join(_FIELD_LABELS[key] for key in _FIELD_LABELS if key in result.new_values),
            old_values=result.old_values,
            new_values=result.new_values,
        )
    return Response(rules_body(result.warnings))


def _preview_legacy_reason(config, ruleset: psr.RuleSet, d: date_type, group_missing: bool) -> str:
    if not config.rules_enabled:
        return "The new rules are switched off, so the old calculation is used"
    if config.rules_effective_from is None:
        return "The new rules have no start date yet, so the old calculation is used"
    if d < config.rules_effective_from:
        return f"The new rules start on {config.rules_effective_from.isoformat()}, so {d.isoformat()} is still judged by the old calculation"
    if not ruleset.groups:
        return "No shift group is switched on, so the old calculation is used"
    if group_missing:
        return f"No shift group applies on a {d.strftime('%A')}, so the old calculation is used"
    return "The old calculation is used"


@api_view(["POST"])
@require_hr
def production_shift_rules_preview(request: Request) -> Response:
    """What a made-up day earns with the SAVED rules: {punches: ["08:30", ...], date: "2026-10-15"} ->
    {group, shifts, status, isLate, earlyLeave, note, calculation}. Punches are typed in the order they happened (a time
    that is not later than the one before is the next morning: ["21:00", "05:30"] is a night). Pure: it reads the saved
    rules and never writes (a date before the rules start, or rules switched off, gives the OLD calculation, said so in
    `group` / `note`). The body's own rules are not read: a preview of an unsaved edit is not offered."""
    data = request.data
    if not isinstance(data, dict):
        return Response({"error": "The body must be a JSON object."}, status=400)
    punches = data.get("punches")
    if not isinstance(punches, list) or not all(isinstance(p, str) for p in punches):
        return Response({"error": "'punches' must be a list of times written HH:MM."}, status=400)
    if len(punches) > MAX_PREVIEW_PUNCHES:
        return Response({"error": f"At most {MAX_PREVIEW_PUNCHES} punches can be tried at once."}, status=400)
    raw_date = data.get("date")
    if raw_date in (None, ""):
        day = ist_today()
    else:
        if not isinstance(raw_date, str) or not _DATE_RE.match(raw_date):
            return Response({"error": "'date' must be a date written YYYY-MM-DD."}, status=400)
        try:
            day = date_type.fromisoformat(raw_date)
        except ValueError:
            return Response({"error": "'date' must be a real date written YYYY-MM-DD."}, status=400)
    try:
        seconds = psr.parse_punch_list(punches)
    except ValueError as exc:
        return Response({"error": str(exc)}, status=400)
    if not seconds:
        return Response(
            {
                "group": None,
                "shifts": 0.0,
                "status": "absent",
                "isLate": False,
                "earlyLeave": False,
                "note": "No punches: the day counts as absent.",
                "calculation": "none",
            }
        )

    config = ProductionShiftConfig.objects.filter(pk=1).first() or ProductionShiftConfig(pk=1)
    ruleset = psr.load_ruleset(config)
    result = psr.evaluate_day(ruleset, day, seconds) if ruleset.applies(day) else None
    if result is not None:
        return Response(
            {
                "group": result["rule_group"],
                "shifts": float(result["shifts_earned"]),
                "status": result["status"],
                "isLate": bool(result.get("is_late")),
                "earlyLeave": bool(result.get("early_leave")),
                "note": result["rule_note"],
                "calculation": "rules",
            }
        )

    # the old calculation, on the punches that fall on this calendar day (a punch after midnight is the next day's there)
    own = [s for s in seconds if s < psr.DAY_S]
    legacy = production_day_result(day, {day: own}, config=config, ruleset=psr.RuleSet())
    reason = _preview_legacy_reason(config, ruleset, day, group_missing=ruleset.applies(day))
    shifts = legacy["shifts_earned"]
    note = (
        f"{reason}: {Decimal(shifts):.2f} shift(s) with the punch times and {config.grace_minutes}-minute grace it uses"
    )
    if len(own) < len(seconds):
        note += "; punches after midnight belong to the next day in the old calculation"
    return Response(
        {
            "group": "Old calculation",
            "shifts": float(shifts),
            "status": legacy["status"],
            "isLate": bool(legacy.get("is_late")),
            "earlyLeave": bool(legacy.get("early_leave")),
            "note": note,
            "calculation": "legacy",
        }
    )

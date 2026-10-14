"""
Settings -> Compensation: the switches, thresholds and editable rule tables of the OT / Compensation features.

  GET|PUT /api/compensation/settings   permission module `settings.compensation` (see permission_registry.URL_MODULE_MAP)
  GET     /api/compensation/config     the same body, read-only, for the Compensation page (module `compensation`)

The Settings tab stays editable while the master switch (Settings -> Payroll -> OT / Compensation,
PayrollSettings.compensation_feature_enabled) is OFF: the features simply do not act until it is on again. These are
company-wide rules, so a login that belongs to one branch may read them but not change them.

Body (GET, and the PUT answer):
  {
    "masterEnabled": true,
    "allowance": {"enabled": false, "effectiveFrom": "2026-10-14"},
    "shift": {"enabled": false, "minExtraMinutes": 150, "relaxationEnabled": true, "payEnabled": false},
    "windows": {"enabled": false},
    "holidayWork": {"enabled": false},
    "birthday": {"enabled": false, "effectiveFrom": null},
    "allowanceRules": [{"id": 1, "label": "1 hour", "enabled": true, "minExtraMinutes": 60, "allowanceMinutes": 30,
                        "sortOrder": 1}],
    "shiftRules": [{"id": 5, "label": "Up to 9:00 PM", "enabled": true, "untilMinutes": 1260, "shifts": 0.25,
                    "sortOrder": 1}],
    "updatedBy": "Asha", "updatedAt": "2026-10-14T10:00:00+05:30"
  }

PUT takes the same body without masterEnabled / updatedBy / updatedAt. Every top-level group is optional (an omitted
group is left alone); inside a group only the keys sent change. The two rule arrays REPLACE the whole set: an item
with an `id` updates that rule, an item without one is created, and the rules whose id is missing from the array are
deleted. The order of the array is the order of the table (sortOrder is re-numbered from it). The PUT is all-or-nothing:
any problem is a 400 {"error": "<one plain sentence>"} and nothing is saved. The answer is the new body plus `warnings`.

Rules of the PUT (each a plain-sentence 400 when broken):
  * allowance minutes 0..240, `minExtraMinutes` >= 1 and not repeated among the enabled allowance rules;
  * shift rules: `shifts` one of 0.25 / 0.50 / 0.75 / 1; `untilMinutes` (minutes after the OT day's midnight, 1..2880)
    strictly increasing among the ENABLED rows, and the last enabled row must have none (null = no limit);
  * `shift.minExtraMinutes` 1..1440;
  * an enabled feature needs at least one enabled rule (allowance: an allowance rule; shift: a shift rule AND at least
    one of relaxation / pay switched on);
  * `effectiveFrom` (a date or null) for allowance and birthday. SWITCHING A FEATURE ON (off -> on) with no date named
    sets it to TODAY (IST) - it never reaches back into days already judged. Naming an earlier date is allowed (the owner
    decides; the screen warns) and is the only way to get one.
"""

import math
from datetime import date as date_type

from django.db import transaction
from rest_framework.decorators import api_view
from rest_framework.request import Request
from rest_framework.response import Response

from . import compensation_rules as rules
from .audit_utils import log_action
from .auth import get_hr_display_name, require_hr
from .branch_scope import get_branch_scope
from .clock import FACTORY_TZ, ist_today
from .models import CompensationConfig, CompensationRule, PayrollSettings

COMPANY_WIDE_MESSAGE = (
    "Compensation rules apply to the whole company, so a branch login can read them but not change them. "
    "Ask an administrator or a head-office login."
)


# The most extra work a rule can ask for (also the ceiling of shift.minExtraMinutes): a longer one is a typo, and a bigger
# number would not fit the database column.
MAX_EXTRA_MINUTES = 1440


class SettingsError(Exception):
    """A problem with the submitted settings: the message is the one plain sentence the 400 carries."""


# ── reading ─────────────────────────────────────────────────────────────────


def _date_json(value):
    return str(value) if value else None


def settings_body() -> dict:
    """The whole Settings -> Compensation body (see the module docstring)."""
    config = CompensationConfig.get()
    master = PayrollSettings.get().compensation_feature_enabled
    allowance_rows = CompensationRule.objects.filter(kind=CompensationRule.KIND_ALLOWANCE).order_by("sort_order", "id")
    shift_rows = CompensationRule.objects.filter(kind=CompensationRule.KIND_SHIFT).order_by("sort_order", "id")
    # `updated_at` is stamped by the migration that seeds the row too: until somebody has really saved, there is no
    # "last saved" to show (updated_by is only ever set by a save)
    updated_at = (
        config.updated_at.astimezone(FACTORY_TZ).isoformat() if (config.updated_at and config.updated_by) else None
    )
    return {
        "masterEnabled": bool(master),
        "allowance": {
            "enabled": config.allowance_enabled,
            "effectiveFrom": _date_json(config.allowance_effective_from),
        },
        "shift": {
            "enabled": config.shift_enabled,
            "minExtraMinutes": config.shift_min_extra_minutes,
            "relaxationEnabled": config.relaxation_enabled,
            "payEnabled": config.pay_enabled,
        },
        "windows": {"enabled": config.windows_enabled},
        "holidayWork": {"enabled": config.holiday_work_enabled},
        "birthday": {"enabled": config.birthday_enabled, "effectiveFrom": _date_json(config.birthday_effective_from)},
        "allowanceRules": [
            {
                "id": r.id,
                "label": r.label,
                "enabled": r.enabled,
                "minExtraMinutes": r.min_extra_minutes,
                "allowanceMinutes": r.allowance_minutes,
                "sortOrder": r.sort_order,
            }
            for r in allowance_rows
        ],
        "shiftRules": [
            {
                "id": r.id,
                "label": r.label,
                "enabled": r.enabled,
                "untilMinutes": r.until_minutes,
                "shifts": float(r.shifts) if r.shifts is not None else None,
                "sortOrder": r.sort_order,
            }
            for r in shift_rows
        ],
        "updatedBy": config.updated_by,
        "updatedAt": updated_at,
    }


# ── writing ─────────────────────────────────────────────────────────────────


def _rules_snapshot(kind: str) -> list[dict]:
    """One rule table as plain dicts (for the audit trail: what the table was and what it became)."""
    out = []
    for r in CompensationRule.objects.filter(kind=kind).order_by("sort_order", "id"):
        row = {"id": r.id, "label": r.label, "enabled": r.enabled}
        if kind == CompensationRule.KIND_ALLOWANCE:
            row.update(minExtraMinutes=r.min_extra_minutes, allowanceMinutes=r.allowance_minutes)
        else:
            row.update(untilMinutes=r.until_minutes, shifts=float(r.shifts) if r.shifts is not None else None)
        out.append(row)
    return out


def _finite(value, where: str, what: str) -> None:
    """A JSON number such as 1e999 parses to infinity: refuse it with a sentence before it reaches int()."""
    if isinstance(value, float) and not math.isfinite(value):
        raise SettingsError(f"{where}: {what} must be a whole number.")


def _group(data: dict, key: str) -> dict | None:
    value = data.get(key)
    if value is None:
        return None
    if not isinstance(value, dict):
        raise SettingsError(f"'{key}' must be an object.")
    return value


def _bool(group: dict, key: str, where: str):
    """The boolean at group[key] (a JSON true/false), or None when it was not sent."""
    if key not in group:
        return None
    value = group[key]
    if not isinstance(value, bool):
        raise SettingsError(f"{where}: '{key}' must be true or false.")
    return value


def _date(group: dict, key: str, where: str):
    """(sent, value): the date at group[key] (ISO string) or None for an explicit null."""
    if key not in group:
        return False, None
    raw = group[key]
    if raw in (None, ""):
        return True, None
    try:
        return True, date_type.fromisoformat(str(raw))
    except ValueError:
        raise SettingsError(f"{where}: '{key}' must be a date (YYYY-MM-DD) or null.") from None


def _int(value, where: str, what: str):
    if isinstance(value, bool) or value is None:
        raise SettingsError(f"{where}: {what} is required (a whole number).")
    try:
        if isinstance(value, float) and not value.is_integer():
            raise ValueError
        return int(value)
    except (TypeError, ValueError):
        raise SettingsError(f"{where}: {what} must be a whole number.") from None


def _ordered(items: list, noun: str) -> list[dict]:
    """The items as dicts in table order: by the sortOrder each carries (when it does), else the order sent."""
    if not isinstance(items, list):
        raise SettingsError(f"'{noun}' must be a list.")
    rows = []
    for position, item in enumerate(items):
        if not isinstance(item, dict):
            raise SettingsError(f"Every item of '{noun}' must be an object.")
        order = item.get("sortOrder")
        order = order if isinstance(order, int) and not isinstance(order, bool) else position + 1
        rows.append((order, position, item))
    rows.sort(key=lambda t: (t[0], t[1]))
    return [t[2] for t in rows]


def _apply_rules(kind: str, items: list, noun: str) -> list[dict]:
    """Validate a replacement rule table and return it normalised (snake_case dicts, in table order); nothing is saved."""
    ordered = _ordered(items, noun)
    seen_ids = set()
    rows = []
    for position, item in enumerate(ordered, start=1):
        where = f"{'Allowance' if kind == CompensationRule.KIND_ALLOWANCE else 'Shift'} rule {position}"
        rule_id = item.get("id")
        if rule_id is not None:
            rule_id = _int(rule_id, where, "id")
            if rule_id in seen_ids:
                raise SettingsError(f"{where}: the same rule id is used twice.")
            seen_ids.add(rule_id)
        enabled = item.get("enabled", True)
        if not isinstance(enabled, bool):
            raise SettingsError(f"{where}: 'enabled' must be true or false.")
        label = item.get("label")
        if label is not None and not isinstance(label, str):
            raise SettingsError(f"{where}: the name must be text.")
        row = {"id": rule_id, "enabled": enabled, "label": (label or "").strip()}
        if kind == CompensationRule.KIND_ALLOWANCE:
            row["min_extra_minutes"] = item.get("minExtraMinutes")
            row["allowance_minutes"] = item.get("allowanceMinutes")
            _finite(row["min_extra_minutes"], where, "the extra work needed")
            _finite(row["allowance_minutes"], where, "the allowance")
            floor = row["min_extra_minutes"]
            if isinstance(floor, (int, float)) and not isinstance(floor, bool) and floor > MAX_EXTRA_MINUTES:
                raise SettingsError(
                    f"{where}: the extra work needed can be at most {MAX_EXTRA_MINUTES} minutes (24 hours)."
                )
        else:
            row["until_minutes"] = item.get("untilMinutes")
            row["shifts"] = item.get("shifts")
            _finite(row["until_minutes"], where, "the time limit")
        rows.append(row)
    errors = (
        rules.validate_allowance_rows(rows)
        if kind == CompensationRule.KIND_ALLOWANCE
        else rules.validate_shift_rows(rows)
    )
    if errors:
        raise SettingsError(errors[0])
    return rows


def _default_label(kind: str, row: dict) -> str:
    if kind == CompensationRule.KIND_ALLOWANCE:
        return rules.describe_duration(int(row["min_extra_minutes"]))
    until = row.get("until_minutes")
    return f"Up to {rules.describe_clock(int(until))}" if until is not None else "No time limit"


def _save_rules(kind: str, rows: list[dict]) -> None:
    """Replace the kind's table with `rows` (validated): ids present are updated, new rows created, missing ids deleted."""
    existing = {r.id: r for r in CompensationRule.objects.filter(kind=kind)}
    for row in rows:
        if row["id"] is not None and row["id"] not in existing:
            raise SettingsError(
                f"A {'allowance' if kind == CompensationRule.KIND_ALLOWANCE else 'shift'} rule that no longer "
                "exists was edited: reload the page and try again."
            )
    keep = {row["id"] for row in rows if row["id"] is not None}
    CompensationRule.objects.filter(kind=kind).exclude(id__in=keep).delete()
    for order, row in enumerate(rows, start=1):
        fields = {"enabled": row["enabled"], "sort_order": order, "label": row["label"] or _default_label(kind, row)}
        if kind == CompensationRule.KIND_ALLOWANCE:
            fields["min_extra_minutes"] = int(row["min_extra_minutes"])
            fields["allowance_minutes"] = int(row["allowance_minutes"])
        else:
            fields["until_minutes"] = int(row["until_minutes"]) if row["until_minutes"] is not None else None
            fields["shifts"] = rules.normalise_shifts(row["shifts"])
        if row["id"] is None:
            CompensationRule.objects.create(kind=kind, **fields)
        else:
            rule = existing[row["id"]]
            for name, value in fields.items():
                setattr(rule, name, value)
            rule.save()


def _apply_dated_feature(
    group: dict, label: str, config, enabled_attr: str, from_attr: str, today: date_type, warnings: list
) -> None:
    """The `enabled` / `effectiveFrom` pair of a feature that changes how a day is judged (allowance, birthday). A date
    named in the body is used as it is (the owner may name an earlier one); switching the feature ON with no date named
    sets it to today, so it can never reach back into days already judged; one that is on needs a date. Switching it off,
    or on again from today, changes how days judged EARLIER come out when they are recalculated: said in `warnings`."""
    turned = _bool(group, "enabled", label)
    sent, named = _date(group, "effectiveFrom", label)
    was_on = getattr(config, enabled_attr)
    previous = getattr(config, from_attr)
    if turned is False and was_on:
        warnings.append(
            f"{label} is switched off: a day recalculated while it is off (a page opened, payroll generated again) is "
            "judged without it, including days it already covered."
        )
    elif turned and not was_on and previous is not None and named is None:
        warnings.append(
            f"{label} was on before, from {previous.isoformat()}. Switching it on again starts it from "
            f"{today.isoformat()}, so days from {previous.isoformat()} up to today are no longer covered by it when "
            "they are recalculated. To keep them, name the earlier date as its start."
        )
    if turned is not None:
        setattr(config, enabled_attr, turned)
    now_on = getattr(config, enabled_attr)
    if named is not None:
        setattr(config, from_attr, named)
    elif now_on and not was_on:
        setattr(config, from_attr, today)
    elif sent and now_on:
        raise SettingsError(f"{label}: an effective-from date is required while it is switched on.")
    elif sent:
        setattr(config, from_attr, None)


def _mirror_legacy_ot_settings(config) -> None:
    """Keep PayrollSettings.ot_detection_enabled / ot_threshold_minutes (the settings from before this tab existed) true to
    what this tab says. The engine no longer reads them, but the Report Center's overtime columns and the MD portal's
    overtime figures still ask "is OT detection on" and "how many minutes past the shift end count", so they follow these
    rules instead of going stale. Detection is on when either feature is; it starts at the earliest enabled allowance rule
    (or at the shift-based start when only that is on)."""
    starts = []
    if config.allowance_enabled:
        starts += CompensationRule.objects.filter(kind=CompensationRule.KIND_ALLOWANCE, enabled=True).values_list(
            "min_extra_minutes", flat=True
        )
    if config.shift_enabled:
        starts.append(config.shift_min_extra_minutes)
    starts = [m for m in starts if m]
    legacy = PayrollSettings.get()
    legacy.ot_detection_enabled = bool(config.allowance_enabled or config.shift_enabled)
    fields = ["ot_detection_enabled"]
    if starts:
        legacy.ot_threshold_minutes = min(starts)
        fields.append("ot_threshold_minutes")
    legacy.save(update_fields=fields)


@transaction.atomic
def apply_settings(data: dict, actor: str):
    """Validate and save a PUT body (see the module docstring). Raises SettingsError (nothing saved); returns
    (warnings about the result, {changed field: old value}, {changed field: new value}); the rule tables that changed are
    in both under "allowanceRules" / "shiftRules". The settings row is read FOR UPDATE and held until the transaction ends,
    so two saves at the same moment run one after the other (the second starts from what the first saved)."""
    CompensationConfig.get()  # makes sure the row exists
    config = CompensationConfig.objects.select_for_update().get(pk=1)
    today = ist_today()
    warnings: list[str] = []
    before = {f.name: getattr(config, f.name) for f in config._meta.fields}
    rules_before = {
        "allowanceRules": _rules_snapshot(CompensationRule.KIND_ALLOWANCE),
        "shiftRules": _rules_snapshot(CompensationRule.KIND_SHIFT),
    }

    allowance = _group(data, "allowance")
    shift = _group(data, "shift")
    windows = _group(data, "windows")
    holiday_work = _group(data, "holidayWork")
    birthday = _group(data, "birthday")

    if allowance is not None:
        _apply_dated_feature(
            allowance,
            "The next-day allowance",
            config,
            "allowance_enabled",
            "allowance_effective_from",
            today,
            warnings,
        )

    if shift is not None:
        enabled = _bool(shift, "enabled", "Shift")
        if enabled is not None:
            config.shift_enabled = enabled
        if "minExtraMinutes" in shift:
            _finite(shift["minExtraMinutes"], "Shift", "the extra work where shift compensation starts")
            minutes = _int(shift["minExtraMinutes"], "Shift", "the extra work where shift compensation starts")
            if not 1 <= minutes <= MAX_EXTRA_MINUTES:
                raise SettingsError(
                    "Shift: the extra work where shift compensation starts must be between 1 and 1440 minutes."
                )
            config.shift_min_extra_minutes = minutes
        relaxation = _bool(shift, "relaxationEnabled", "Shift")
        if relaxation is not None:
            config.relaxation_enabled = relaxation
        pay = _bool(shift, "payEnabled", "Shift")
        if pay is not None:
            config.pay_enabled = pay

    if windows is not None:
        enabled = _bool(windows, "enabled", "Announced late-in / early-out")
        if enabled is False and config.windows_enabled:
            warnings.append(
                "Announced late-in / early-out is switched off: a day recalculated while it is off is judged by the "
                "employee's own shift times again, including days an announcement already covered."
            )
        if enabled is not None:
            config.windows_enabled = enabled

    if holiday_work is not None:
        enabled = _bool(holiday_work, "enabled", "Sunday / holiday work")
        if enabled is not None:
            config.holiday_work_enabled = enabled

    if birthday is not None:
        _apply_dated_feature(
            birthday, "Birthday leave", config, "birthday_enabled", "birthday_effective_from", today, warnings
        )

    allowance_rows = (
        _apply_rules(CompensationRule.KIND_ALLOWANCE, data["allowanceRules"], "allowanceRules")
        if "allowanceRules" in data
        else None
    )
    shift_rows = (
        _apply_rules(CompensationRule.KIND_SHIFT, data["shiftRules"], "shiftRules") if "shiftRules" in data else None
    )

    # An enabled feature needs something to work with, judged on the table as it will be after this save.
    def enabled_count(kind, rows):
        if rows is not None:
            return sum(1 for r in rows if r["enabled"])
        return CompensationRule.objects.filter(kind=kind, enabled=True).count()

    if config.allowance_enabled and enabled_count(CompensationRule.KIND_ALLOWANCE, allowance_rows) == 0:
        raise SettingsError(
            "The next-day allowance is switched on but has no enabled rule: add or enable at least one."
        )
    if config.shift_enabled:
        if enabled_count(CompensationRule.KIND_SHIFT, shift_rows) == 0:
            raise SettingsError(
                "Shift-based compensation is switched on but has no enabled shift rule: add or enable at least one."
            )
        if not (config.relaxation_enabled or config.pay_enabled):
            raise SettingsError("Shift-based compensation is switched on: switch on Relaxation, Pay or both.")

    if allowance_rows is not None:
        _save_rules(CompensationRule.KIND_ALLOWANCE, allowance_rows)
    if shift_rows is not None:
        _save_rules(CompensationRule.KIND_SHIFT, shift_rows)
    config.updated_by = actor
    config.save()
    _mirror_legacy_ot_settings(config)

    if config.allowance_enabled:
        threshold = config.shift_min_extra_minutes
        for rule in CompensationRule.objects.filter(kind=CompensationRule.KIND_ALLOWANCE, enabled=True):
            if (rule.min_extra_minutes or 0) > threshold:
                warnings.append(
                    f"The '{rule.label}' allowance can never apply: shift-based compensation already starts at "
                    f"{rules.describe_duration(threshold)} of extra work."
                )
    after = {f.name: getattr(config, f.name) for f in config._meta.fields}
    skip = ("updated_at", "updated_by")
    old_values = {k: str(before.get(k)) for k, v in after.items() if before.get(k) != v and k not in skip}
    new_values = {k: str(v) for k, v in after.items() if before.get(k) != v and k not in skip}
    rules_after = {
        "allowanceRules": _rules_snapshot(CompensationRule.KIND_ALLOWANCE),
        "shiftRules": _rules_snapshot(CompensationRule.KIND_SHIFT),
    }
    for name, table in rules_after.items():
        if table != rules_before[name]:  # which rule changed, and from what: the audit trail keeps both tables
            old_values[name] = rules_before[name]
            new_values[name] = table
    return warnings, old_values, new_values


def _forbid_branch_logins(request: Request):
    if get_branch_scope(request) is not None:
        return Response({"error": COMPANY_WIDE_MESSAGE, "code": "company_wide_settings"}, status=403)
    return None


@api_view(["GET", "PUT"])
@require_hr
def compensation_settings(request: Request) -> Response:
    """GET: the Settings -> Compensation body. PUT: save it (see the module docstring)."""
    if request.method == "GET":
        return Response(settings_body())

    refusal = _forbid_branch_logins(request)
    if refusal is not None:
        return refusal
    data = request.data
    if not isinstance(data, dict):
        return Response({"error": "The body must be a JSON object."}, status=400)
    try:
        with transaction.atomic():
            warnings, old_values, new_values = apply_settings(data, get_hr_display_name(request))
    except SettingsError as exc:
        return Response({"error": str(exc)}, status=400)
    log_action(
        request,
        "update",
        "compensation_settings",
        description="Changed Compensation settings" + (f": {', '.join(sorted(new_values))}" if new_values else ""),
        old_values=old_values or None,
        new_values=new_values or None,
    )
    return Response({**settings_body(), "warnings": warnings})


@api_view(["GET"])
@require_hr
def compensation_config(request: Request) -> Response:
    """Read-only copy of the Settings -> Compensation body for the Compensation page (module `compensation`)."""
    return Response(settings_body())

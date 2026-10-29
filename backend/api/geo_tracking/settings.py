"""GeoTrackingSettings: the accessor, the JSON shape the API speaks, and the validation of a write.

  GET /api/tracking/settings   the full object (camelCase)
  PUT /api/tracking/settings   a PARTIAL update (any subset of the keys, camelCase or snake_case), answered with the full
                               object; a problem is a 400 {"error": "<one plain sentence>"} and nothing is saved

The ranges below are enforced here (the database only stores). A changed notice text without an explicit noticeVersion
raises the version by one, so every employee has to accept the new wording before their next track records.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import time

from django.utils import timezone

from ..models import GeoTrackingSettings
from .parsing import parse_bool, parse_float, parse_int, snake_key


class SettingsError(ValueError):
    """A rejected write; str(error) is the one plain sentence for HR."""


@dataclass(frozen=True)
class Field:
    attr: str  # model attribute
    key: str  # camelCase name in the API
    label: str  # for the error sentence
    kind: str  # int | float | bool | text | choice | time
    lo: float | None = None
    hi: float | None = None
    choices: tuple | None = None


FIELDS: tuple[Field, ...] = (
    Field("enabled", "enabled", "Tracking", "bool"),
    Field("stop_seconds", "stopSeconds", "Stop duration", "int", 60, 3600),
    Field("stop_radius_m", "stopRadiusM", "Stop radius", "int", 10, 500),
    Field("stop_accuracy_factor", "stopAccuracyFactor", "Stop accuracy factor", "float", 0.5, 5.0),
    Field("merge_stop_gap_seconds", "mergeStopGapSeconds", "Stop merge time", "int", 0, 1800),
    Field("gap_seconds", "gapSeconds", "Gap length", "int", 60, 3600),
    Field("signal_lost_seconds", "signalLostSeconds", "Signal-lost time", "int", 120, 7200),
    Field("max_accuracy_m", "maxAccuracyM", "Maximum accuracy", "int", 10, 1000),
    Field("max_speed_kmh", "maxSpeedKmh", "Maximum speed", "int", 30, 500),
    Field("sample_moving_seconds", "sampleMovingSeconds", "Moving sample interval", "int", 2, 120),
    Field("sample_still_seconds", "sampleStillSeconds", "Still sample interval", "int", 30, 1800),
    Field("distance_filter_m", "distanceFilterM", "Distance filter", "int", 0, 200),
    Field("upload_batch_points", "uploadBatchPoints", "Upload batch size", "int", 5, 500),
    Field("upload_interval_seconds", "uploadIntervalSeconds", "Upload interval", "int", 10, 900),
    Field("retention_days", "retentionDays", "Retention", "int", 7, 3650),
    Field("day_end_time", "dayEndTime", "Day-end time", "time"),
    Field("onduty_punch_photos", "ondutyPunchPhotos", "On-Duty punch photos", "choice", choices=(1, 2)),
    Field("notice_version", "noticeVersion", "Notice version", "int", 1, 1_000_000),
    Field("notice_text", "noticeText", "Notice text", "text"),
    Field(
        "reverse_geocode_provider",
        "reverseGeocodeProvider",
        "Address lookup",
        "choice",
        choices=(GeoTrackingSettings.REVERSE_GEOCODE_OFF, GeoTrackingSettings.REVERSE_GEOCODE_NOMINATIM),
    ),
)
BY_ATTR = {f.attr: f for f in FIELDS}
#: other spellings a client may use for a key (the punch-photo policy is also called punchPhotos in /tracking/state)
ALIASES = {"punch_photos": "onduty_punch_photos", "on_duty_punch_photos": "onduty_punch_photos"}

DAY_END_EARLIEST = time(12, 0)
NOTICE_MAX_CHARS = 5000


def get() -> GeoTrackingSettings:
    return GeoTrackingSettings.get()


def parse_clock(value) -> time | None:
    """'23:50' / '23:50:00' / a time -> time (seconds dropped), else None."""
    if isinstance(value, time):
        return value.replace(second=0, microsecond=0)
    if not isinstance(value, str):
        return None
    parts = value.strip().split(":")
    if len(parts) not in (2, 3):
        return None
    try:
        h, m = int(parts[0]), int(parts[1])
    except ValueError:
        return None
    if not (0 <= h <= 23 and 0 <= m <= 59):
        return None
    return time(h, m)


def to_dict(s: GeoTrackingSettings) -> dict:
    """The full settings object, camelCase."""
    out = {
        "enabled": s.enabled,
        "stopSeconds": s.stop_seconds,
        "stopRadiusM": s.stop_radius_m,
        "stopAccuracyFactor": s.stop_accuracy_factor,
        "mergeStopGapSeconds": s.merge_stop_gap_seconds,
        "gapSeconds": s.gap_seconds,
        "signalLostSeconds": s.signal_lost_seconds,
        "maxAccuracyM": s.max_accuracy_m,
        "maxSpeedKmh": s.max_speed_kmh,
        "sampleMovingSeconds": s.sample_moving_seconds,
        "sampleStillSeconds": s.sample_still_seconds,
        "distanceFilterM": s.distance_filter_m,
        "uploadBatchPoints": s.upload_batch_points,
        "uploadIntervalSeconds": s.upload_interval_seconds,
        "retentionDays": s.retention_days,
        "dayEndTime": s.day_end_time.strftime("%H:%M"),
        "ondutyPunchPhotos": s.onduty_punch_photos,
        "punchPhotos": s.onduty_punch_photos,
        "noticeVersion": s.notice_version,
        "noticeText": s.notice_text,
        "reverseGeocodeProvider": s.reverse_geocode_provider,
        "updatedBy": s.updated_by.full_name or s.updated_by.username if s.updated_by_id else None,
        "updatedAt": s.updated_at.isoformat() if s.updated_at else None,
    }
    return out


def client_config(s: GeoTrackingSettings) -> dict:
    """What the apps need to sample and upload (the `config` of /tracking/state and /tracking/batch)."""
    return {
        "sampleMovingSeconds": s.sample_moving_seconds,
        "sampleStillSeconds": s.sample_still_seconds,
        "distanceFilterM": s.distance_filter_m,
        "uploadBatchPoints": s.upload_batch_points,
        "uploadIntervalSeconds": s.upload_interval_seconds,
        "maxAccuracyM": s.max_accuracy_m,
    }


def _coerce(f: Field, raw):
    if f.kind == "bool":
        value = parse_bool(raw)
        if value is None or isinstance(raw, (int, float)) and not isinstance(raw, bool) and raw not in (0, 1):
            raise SettingsError(f"{f.label} must be true or false.")
        return value
    if f.kind == "int":
        value = parse_int(raw)
        if value is None:
            raise SettingsError(f"{f.label} must be a whole number.")
    elif f.kind == "float":
        value = parse_float(raw)
        if value is None:
            raise SettingsError(f"{f.label} must be a number.")
    elif f.kind == "text":
        if not isinstance(raw, str):
            raise SettingsError(f"{f.label} must be text.")
        value = raw.strip()
        if not value:
            raise SettingsError(f"{f.label} cannot be empty.")
        if len(value) > NOTICE_MAX_CHARS:
            raise SettingsError(f"{f.label} can be at most {NOTICE_MAX_CHARS} characters.")
        return value
    elif f.kind == "choice":
        value = (
            parse_int(raw)
            if all(isinstance(c, int) for c in f.choices)
            else (raw.strip().lower() if isinstance(raw, str) else None)
        )
        if value not in f.choices:
            options = " or ".join(str(c) for c in f.choices)
            raise SettingsError(f"{f.label} must be {options}.")
        return value
    elif f.kind == "time":
        value = parse_clock(raw)
        if value is None:
            raise SettingsError(f"{f.label} must be a time like 23:50.")
        if value < DAY_END_EARLIEST:
            raise SettingsError(f"{f.label} must be between 12:00 and 23:59 (it closes the day's duties).")
        return value
    if f.lo is not None and value < f.lo or f.hi is not None and value > f.hi:
        lo = int(f.lo) if f.lo == int(f.lo) else f.lo
        hi = int(f.hi) if f.hi == int(f.hi) else f.hi
        raise SettingsError(f"{f.label} must be between {lo} and {hi}.")
    return value


def validate(data) -> dict:
    """The validated {model attribute: value} of a partial update. Unknown keys are ignored; the first problem raises
    SettingsError."""
    if not isinstance(data, dict):
        raise SettingsError("Send the settings as a JSON object.")
    flat = {}
    for key, raw in data.items():
        attr = ALIASES.get(snake_key(key), snake_key(key))
        if attr in BY_ATTR:
            flat[attr] = raw
    return {attr: _coerce(BY_ATTR[attr], raw) for attr, raw in flat.items()}


def apply_update(s: GeoTrackingSettings, data, user=None) -> tuple[dict, dict]:
    """Validate ``data`` and save it. Returns (old, new) dicts of the changed attributes (for the audit log); nothing is
    saved when it raises."""
    values = validate(data)
    sent = {ALIASES.get(snake_key(k), snake_key(k)) for k in (data or {})}
    if "notice_text" in values and values["notice_text"] != s.notice_text and "notice_version" not in sent:
        values["notice_version"] = s.notice_version + 1
    if "notice_version" in values and values["notice_version"] < s.notice_version:
        raise SettingsError("The notice version cannot go down: employees have already accepted the current one.")
    old, new = {}, {}
    for attr, value in values.items():
        current = getattr(s, attr)
        if current != value:
            old[attr] = current.strftime("%H:%M") if isinstance(current, time) else current
            new[attr] = value.strftime("%H:%M") if isinstance(value, time) else value
            setattr(s, attr, value)
    if old:
        s.updated_by = user
        s.updated_at = timezone.now()
        s.save()
    return old, new


def punch_photos() -> int:
    """How many photos an On-Duty punch takes right now (1 or 2)."""
    return 2 if get().onduty_punch_photos == 2 else 1

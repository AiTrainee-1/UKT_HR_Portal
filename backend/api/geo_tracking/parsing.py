"""Tolerant readers for what the apps send.

The mobile app's axios client DECAMELIZES JSON request bodies (also nested), the web app and the HR portal do not, and a
person can type either into a query string: every reader here accepts camelCase and snake_case alike, and times as epoch
milliseconds (or seconds) or ISO-8601 (with an offset, or a trailing Z).
"""

from __future__ import annotations

import math
import re
from datetime import datetime, timezone as dt_timezone

_CAMEL = re.compile(r"(?<=[a-z0-9])(?=[A-Z])")


def snake_key(key) -> str:
    """isMocked -> is_mocked, deviceId -> device_id, already_snake stays."""
    return _CAMEL.sub("_", str(key)).lower()


def normalize(d) -> dict:
    """A shallow copy of ``d`` with snake_case keys (the values are untouched; call it on each level you read)."""
    if not isinstance(d, dict):
        return {}
    return {snake_key(k): v for k, v in d.items()}


def pick(d: dict, *names, default=None):
    """The first of ``names`` present in the (already normalised) dict, else ``default``."""
    for name in names:
        key = snake_key(name)
        if key in d and d[key] is not None:
            return d[key]
    return default


def parse_time(value) -> datetime | None:
    """An aware UTC datetime, or None when ``value`` is not a usable time. Epoch numbers above 1e11 are milliseconds,
    below it seconds; an ISO string without an offset is read as UTC."""
    if value is None or isinstance(value, bool):
        return None
    dt: datetime | None = None
    if isinstance(value, datetime):
        dt = value
    elif isinstance(value, (int, float)):
        dt = _from_number(float(value))
    elif isinstance(value, str):
        text = value.strip()
        if not text:
            return None
        try:
            dt = _from_number(float(text))
        except ValueError:
            try:
                dt = datetime.fromisoformat(text.replace("z", "Z"))
            except ValueError:
                return None
    if dt is None:
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=dt_timezone.utc)
    dt = dt.astimezone(dt_timezone.utc)
    if not (2000 <= dt.year <= 2100):
        return None
    return dt


def _from_number(n: float) -> datetime | None:
    if not math.isfinite(n):
        return None
    seconds = n / 1000.0 if abs(n) >= 1e11 else n
    try:
        return datetime.fromtimestamp(seconds, tz=dt_timezone.utc)
    except (OverflowError, OSError, ValueError):
        return None


def parse_float(value, *, lo: float | None = None, hi: float | None = None) -> float | None:
    """A finite float within [lo, hi], else None. Booleans and non-numeric text are None."""
    if value is None or isinstance(value, bool):
        return None
    try:
        f = float(value)
    except (TypeError, ValueError):
        return None
    if not math.isfinite(f):
        return None
    if lo is not None and f < lo:
        return None
    if hi is not None and f > hi:
        return None
    return f


def parse_int(value, *, lo: int | None = None, hi: int | None = None) -> int | None:
    """A whole number (a float with no fraction counts, "7" counts) within [lo, hi], else None."""
    if value is None or isinstance(value, bool):
        return None
    try:
        f = float(value)
    except (TypeError, ValueError):
        return None
    if not math.isfinite(f) or f != int(f):
        return None
    n = int(f)
    if lo is not None and n < lo:
        return None
    if hi is not None and n > hi:
        return None
    return n


_TRUE = {"1", "true", "yes", "y", "on"}
_FALSE = {"0", "false", "no", "n", "off", ""}


def parse_bool(value, default: bool | None = None) -> bool | None:
    """True/False for booleans, 0/1 and the usual strings; ``default`` for anything else (None counts as unknown)."""
    if isinstance(value, bool):
        return value
    if value is None:
        return default
    if isinstance(value, (int, float)):
        return bool(value)
    if isinstance(value, str):
        text = value.strip().lower()
        if text in _TRUE:
            return True
        if text in _FALSE:
            return False
    return default

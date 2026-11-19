"""Dated settings histories (compensation claims review, 2026-11-19).

A rule whose switch or value must never change days already judged keeps a HISTORY next to its live fields: a list of
entries {"from": "YYYY-MM-DD" | None, ...values} (None = from the very beginning). The value in force on a day is the
entry with the latest `from` on or before that day; a day before every entry keeps the OLD rule. Every change made in
Settings appends an entry dated today (IST): days before today keep what they were judged by, even when recomputed.

    PayrollSettings.staff_next_morning_history   [{"from", "enabled", "cutoff": "HH:MM"}]  (shift_engine)
    CompensationConfig.ot_quarter_rule_history   [{"from", "on"}]                           (Type 2 quarters rule)

An EMPTY history (a row that never recorded a change: a fresh install, a test database) follows the live fields, exactly
as before the history existed. Pure functions, no database access: models and engines import this freely.
"""

from __future__ import annotations

from datetime import date


def as_date(value) -> date | None:
    """An entry's "from" as a date (None for "from the very beginning", or a value that is not a date)."""
    if value in (None, ""):
        return None
    if isinstance(value, date):
        return value
    try:
        return date.fromisoformat(str(value)[:10])
    except ValueError:
        return None


def entries(history) -> list[dict]:
    """The usable entries of a history (a JSON list of dicts), oldest first; anything malformed is skipped."""
    if not isinstance(history, list):
        return []
    rows = [e for e in history if isinstance(e, dict)]
    # stable: two entries of one date keep their order (the later one wins)
    return sorted(rows, key=lambda e: as_date(e.get("from")) or date.min)


def entry_on(history, day: date) -> dict | None:
    """The entry in force on `day`: the one with the latest `from` on or before it (on the same date the later entry
    wins). None when `day` is before every entry (the old rule) or the history is empty."""
    found = None
    for entry in entries(history):
        start = as_date(entry.get("from"))
        if start is None or start <= day:
            found = entry
    return found


def appended(history, values: dict, today: date) -> list[dict]:
    """A copy of `history` with a new entry {"from": today, **values}; an entry already dated today is replaced (the
    last change of a day is the one in force from that day)."""
    kept = [e for e in entries(history) if as_date(e.get("from")) != today]
    kept.append({"from": today.isoformat(), **values})
    return entries(kept)


def moved_start(history, new_start: date) -> list[dict]:
    """The history with its START moved forward to `new_start` (an explicit "the rule applies from" change): the entries
    before it are dropped except the one in force on `new_start`, which now starts there."""
    current = entry_on(history, new_start)
    later = [e for e in entries(history) if (as_date(e.get("from")) or date.min) > new_start]
    head = [{**current, "from": new_start.isoformat()}] if current is not None else []
    return head + later


def as_json(history) -> list[dict]:
    """The history for an API answer: oldest first, `from` as YYYY-MM-DD or null."""
    out = []
    for entry in entries(history):
        start = as_date(entry.get("from"))
        out.append({**entry, "from": start.isoformat() if start else None})
    return out

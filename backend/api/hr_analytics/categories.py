"""The checks of each Analytics tab, what each counts, its threshold, and how an employee's attention level is worked out.

A threshold is set PER MONTH (what HR thinks is too often in a month) and scaled to the chosen period, so "4 late days a
month" asks 4 of any calendar month, 3 of a 21-day period and 1 of a week. The page may override any of them (`t_<key>=<per month>`).
"""

from __future__ import annotations

import math
from dataclasses import dataclass

from .period import Filters


@dataclass(frozen=True)
class Category:
    key: str
    label: str
    description: str
    unit: str  # days | times | requests | sessions | nights | runs
    per_month: float
    informational: bool = False  # listed with its records, but never raises an employee's level


STAFF = (
    Category("leave", "Frequent leave", "Approved leave and casual leave days taken in the period.", "days", 3),
    Category("late", "Frequent late arrival", "Days the attendance engine marked late.", "days", 4),
    Category(
        "missing_punch",
        "Missing punches",
        "Days with a missing-punch request, or with only one punch recorded (forgot to punch in or out).",
        "days",
        3,
    ),
    Category("on_duty", "Frequent On-Duty requests", "On-Duty requests submitted in the period.", "requests", 6),
    Category(
        "on_duty_no_punch",
        "On-Duty without punches",
        "Approved On-Duty days on which fewer than the 4 Geo-Attendance punches were recorded.",
        "sessions",
        1,
    ),
    Category(
        "absent_on_leave",
        "Absent despite approved leave",
        "Days marked absent although a full-day leave or casual leave was approved for them.",
        "days",
        1,
    ),
    Category(
        "attendance_edits",
        "Frequent attendance edits",
        "Days whose attendance HR edited or asked to correct.",
        "days",
        3,
    ),
    Category(
        "hod_rejected",
        "Requests the HOD rejected",
        "Requests the Department Head turned down.",
        "requests",
        2,
    ),
    Category(
        "hod_waiting",
        "Waiting long with the HOD",
        "Requests that waited more than 2 days for the Department Head (still waiting, or answered late).",
        "requests",
        1,
    ),
    Category(
        "hod_corrections",
        "Corrections through the HOD",
        "Attendance corrections the Department Head had to approve or reject.",
        "requests",
        2,
    ),
    Category(
        "permissions", "Excessive permission requests", "Permission requests for days in the period.", "requests", 4
    ),
)

PRODUCTION = (
    Category(
        "leave",
        "Frequent days off",
        "Approved leave days plus working days with no attendance (absent); Sundays, holidays and days whose punches never arrived are left out.",
        "days",
        4,
    ),
    Category("late", "Frequent late arrival", "Days the attendance engine marked late.", "days", 4),
    Category(
        "night_work",
        "Night work",
        "Days with at least 1 hour worked between 22:00 and 06:00.",
        "nights",
        6,
    ),
    Category(
        "continuous_leave",
        "Continuous leave",
        "Runs of 3 or more working days off in a row.",
        "runs",
        1,
    ),
    Category(
        "late_details",
        "Late attendance details",
        "Everyone who came late at least once, with their dates, times and pattern.",
        "days",
        1,
        informational=True,
    ),
)

BY_TYPE = {"staff": STAFF, "production": PRODUCTION}

# Requests that waited longer than this with the Department Head count as "waiting long".
HOD_WAIT_HOURS = 48
# Days off in a row (working days) that make a "continuous leave" run.
CONTINUOUS_DAYS = 3
# Minutes worked between NIGHT_START and NIGHT_END that make a night.
NIGHT_MINUTES = 60
NIGHT_START_MIN = 22 * 60
NIGHT_END_MIN = 6 * 60
# On-Duty punches expected on an approved On-Duty day.
ON_DUTY_PUNCHES = 4


def categories(kind: str) -> tuple[Category, ...]:
    return BY_TYPE[kind]


def by_key(kind: str, key: str) -> Category | None:
    return next((c for c in BY_TYPE[kind] if c.key == key), None)


def per_month(cat: Category, f: Filters) -> float:
    return f.overrides.get(cat.key, cat.per_month)


def threshold(cat: Category, f: Filters) -> int:
    """The count that flags an employee over this period: the monthly number scaled to the period and rounded half up, so a
    calendar month asks exactly the monthly number (never less than 1)."""
    return max(1, math.floor(per_month(cat, f) * f.months + 0.5))


def level(counts: dict[str, float], kind: str, f: Filters) -> tuple[str, list[str], float]:
    """(level, flagged category keys, score). high = a count at twice its threshold or 3+ flags; attention = 1+ flag;
    watch = hits under every threshold; ok = nothing. Informational checks never count."""
    flags: list[str] = []
    score = 0.0
    double = False
    hits = False
    for cat in BY_TYPE[kind]:
        n = counts.get(cat.key, 0)
        if not n or cat.informational:
            continue
        hits = True
        t = threshold(cat, f)
        score += n / t
        if n >= t:
            flags.append(cat.key)
            if n >= 2 * t:
                double = True
    if double or len(flags) >= 3:
        return "high", flags, round(score, 2)
    if flags:
        return "attention", flags, round(score, 2)
    return ("watch" if hits else "ok"), flags, round(score, 2)


def category_json(cat: Category, f: Filters) -> dict:
    return {
        "key": cat.key,
        "label": cat.label,
        "description": cat.description,
        "unit": cat.unit,
        "thresholdPerMonth": per_month(cat, f),
        "threshold": threshold(cat, f),
        "informational": cat.informational,
    }

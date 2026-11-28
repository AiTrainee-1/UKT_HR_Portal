"""What the Report Center lists, and in which order (the owner's 2026-11-19 cleanup).

Only the reports named here appear in the catalog, in this order inside their category, plus the saved Customise
reports (custom/) and the Managing Director's own category (md_only specs, listed as they register). Every other
registered report is RETIRED: it is not listed and the run / export endpoints refuse it with 404, but its definition
still loads because other code reuses its helpers (the MD portal analytics, gate exports) and its tests keep guarding
that shared logic.

The HR category is the owner's quality reference and is kept exactly as it was.
"""

from __future__ import annotations

from .types import ReportSpec

LAYOUT: dict[str, tuple[str, ...]] = {
    "hr": (
        "employee-confo-details",
        "production-daily-punches",
        "production-shift-rules",
        "hr-salary-statement",
        "hr-production-salary-statement",
        "hr-daily-movement-register",
        "hr-punching-register",
        "hr-strength-register",
        "hr-attendance-register-summary",
        "hr-time-card",
    ),
    "attendance": (
        "staff-attendance-report",
        "production-attendance-report",
        "staff-time-card-report",
        "time-card-shift-count",
        "production-time-card-punches",
        "production-shift-ot-punches",
        "production-all-punches",
        "leave-report",
        "employee-overall-leave",
        "late-detection",
        "monthly-misspunch",
        "geo-attendance",
        "on-duty-report",
        "on-duty-punch-details",
        "attendance-log-report",
        "production-attendance-log",
    ),
    "shift": (
        "assigned-shift-report",
        "gained-shift-report",
        "shift-change-history",
        "shift-wise-attendance",
        "shift-assignment-gaps",
    ),
    "payroll": (
        "salary-statement",
        "production-salary-report",
        "staff-salary-report",
        "gained-salary-report",
        "expected-salary-report",
        "department-salary-report",
        "department-headcount-report",
        "department-employee-report",
    ),
    "employees": (
        "employee-overall-details",
        "employee-fixed-salary",
        "employee-monthly-shift",
        "employee-time-card",
        "employee-punch-details",
        "staff-age-analysis",
    ),
}

_ORDER: dict[str, tuple[str, int]] = {
    rid: (cat, i) for cat, ids in LAYOUT.items() for i, rid in enumerate(ids)
}
_CATEGORY_RANK = {cat: i for i, cat in enumerate(LAYOUT)}


def is_listed(spec: ReportSpec) -> bool:
    """Listed in the catalog and runnable: a layout report, a saved Customise report, or the MD's own pack."""
    if spec.md_only or spec.category == "customise":
        return True
    return spec.id in _ORDER


def sort_key(spec: ReportSpec) -> tuple[int, int, str]:
    cat, i = _ORDER.get(spec.id, (spec.category, 10_000))
    return (_CATEGORY_RANK.get(cat, 100), i, spec.title)

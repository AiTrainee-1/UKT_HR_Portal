"""People milestones: birthdays, work anniversaries and service milestones (probation / casual-leave eligibility).

Owner: group ``employees_master``. Birthdays and anniversaries match on (month, day) ignoring the year, wrap
across 31-Dec -> 1-Jan and keep a 29-Feb date on 28-Feb in non-leap years.
"""

from __future__ import annotations

import calendar
from collections import Counter
from datetime import timedelta

from .. import filters as F
from ..formatting import display_date
from ..registry import register
from ..types import (
    BADGE,
    DATE,
    INTEGER,
    TEXT,
    ColumnSpec,
    ReportResult,
    ReportSpec,
)
from .employees_master_base import (
    WINDOW_OPTIONS,
    add_months,
    clean,
    code_key,
    department_name,
    employees_qs,
    join_date_of,
    months_between,
    months_reached_on,
    occurrence_in_window,
    type_label,
    window_bounds,
)

CATEGORY = "employees"
MODULES = ("employees",)


def _person_name(emp) -> str:
    return f"{emp.first_name or ''} {emp.last_name or ''}".strip()


def _weekday(d) -> str:
    return calendar.day_name[d.weekday()]


def _window_filter():
    return F.select(
        "window", "Show", WINDOW_OPTIONS, default="thisMonth",
        help="A month, or a rolling window starting today (a window may cross into the next year).",
    )  # fmt: skip


# ═════════════════════════════════════════════════════════════════════════════
# birthdays
# ═════════════════════════════════════════════════════════════════════════════

BIRTHDAY_COLUMNS = (
    ColumnSpec("birthday", "Birthday", DATE, 1.1),
    ColumnSpec("weekday", "Day", TEXT, 1.0),
    ColumnSpec("employeeCode", "Emp Code", TEXT, 1.0),
    ColumnSpec("employeeName", "Employee", TEXT, 2.2),
    ColumnSpec("department", "Department", TEXT, 1.5),
    ColumnSpec("designation", "Designation", TEXT, 1.5),
    ColumnSpec("employmentType", "Type", BADGE, 0.9),
    ColumnSpec("dateOfBirth", "Date of Birth", DATE, 1.1),
    ColumnSpec("turningAge", "Turning", INTEGER, 0.7),
    ColumnSpec("phone", "Phone", TEXT, 1.2),
)


def _birthdays_run(ctx) -> ReportResult:
    start, end = window_bounds(ctx.param("window", "thisMonth"), ctx.today)
    emps = list(employees_qs(ctx))
    hits = []
    no_dob = 0
    for e in emps:
        dob = e.date_of_birth
        if dob is None:
            no_dob += 1
            continue
        occ = occurrence_in_window(dob.month, dob.day, start, end)
        if occ is None or occ.year <= dob.year:
            continue
        hits.append((occ, e))
    hits.sort(key=lambda t: (t[0], (t[1].first_name or "").lower(), code_key(t[1].employee_code)))
    rows = [{
        "birthday": occ,
        "weekday": _weekday(occ),
        "employeeCode": e.employee_code,
        "employeeName": _person_name(e),
        "department": department_name(e),
        "designation": e.designation.title if e.designation_id else None,
        "employmentType": type_label(e.employment_type),
        "dateOfBirth": e.date_of_birth,
        "turningAge": occ.year - e.date_of_birth.year,
        "phone": clean(e.phone),
    } for occ, e in hits]  # fmt: skip
    summary = [
        {"label": "Birthdays in window", "value": len(rows), "format": "integer"},
        {"label": "No date of birth (not listed)", "value": no_dob, "format": "integer"},
    ]
    notes = [
        f"Window: {display_date(start)} to {display_date(end)}. A 29-Feb birthday is shown on 28-Feb in non-leap years."
    ]
    if no_dob:
        notes.append(f"{no_dob} employee(s) in scope have no date of birth on file and cannot be listed.")
    return ReportResult(rows=rows, summary=summary, notes=notes)


register(ReportSpec(
    id="birthdays",
    title="Birthdays",
    description="Employee birthdays in a month or the coming days, in calendar order.",
    category=CATEGORY,
    modules=MODULES,
    icon="Cake",
    tags=("birthday", "celebrations", "date of birth", "wishes"),
    family="celebrations",
    variant="Birthdays",
    landscape=False,
    filters=(_window_filter(), *F.scope(employee=False, status="active")),
    columns=BIRTHDAY_COLUMNS,
    run=_birthdays_run,
))  # fmt: skip


# ═════════════════════════════════════════════════════════════════════════════
# work-anniversaries
# ═════════════════════════════════════════════════════════════════════════════

ANNIVERSARY_COLUMNS = (
    ColumnSpec("anniversary", "Anniversary", DATE, 1.1),
    ColumnSpec("weekday", "Day", TEXT, 1.0),
    ColumnSpec("employeeCode", "Emp Code", TEXT, 1.0),
    ColumnSpec("employeeName", "Employee", TEXT, 2.2),
    ColumnSpec("department", "Department", TEXT, 1.5),
    ColumnSpec("designation", "Designation", TEXT, 1.5),
    ColumnSpec("employmentType", "Type", BADGE, 0.9),
    ColumnSpec("joinDate", "Join Date", DATE, 1.1),
    ColumnSpec("yearsCompleted", "Years Completed", INTEGER, 0.9),
    ColumnSpec("phone", "Phone", TEXT, 1.2),
)


def _anniversaries_run(ctx) -> ReportResult:
    start, end = window_bounds(ctx.param("window", "thisMonth"), ctx.today)
    min_years = max(1, ctx.param("minYears", 1))
    # Only people who are still with the company have an anniversary.
    emps = list(employees_qs(ctx).filter(status="active"))
    hits = []
    unusable = 0
    for e in emps:
        joined, _state = join_date_of(e)
        if joined is None:
            unusable += 1
            continue
        occ = occurrence_in_window(joined.month, joined.day, start, end)
        if occ is None:
            continue
        years = occ.year - joined.year
        if years < min_years:
            continue
        hits.append((occ, years, e))
    hits.sort(key=lambda t: (t[0], -t[1], code_key(t[2].employee_code)))
    rows = [{
        "anniversary": occ,
        "weekday": _weekday(occ),
        "employeeCode": e.employee_code,
        "employeeName": _person_name(e),
        "department": department_name(e),
        "designation": e.designation.title if e.designation_id else None,
        "employmentType": type_label(e.employment_type),
        "joinDate": join_date_of(e)[0],
        "yearsCompleted": years,
        "phone": clean(e.phone),
    } for occ, years, e in hits]  # fmt: skip
    summary = [
        {"label": "Anniversaries in window", "value": len(rows), "format": "integer"},
        {"label": "Join date missing / unreadable (not listed)", "value": unusable, "format": "integer"},
    ]
    notes = [
        f"Window: {display_date(start)} to {display_date(end)}. Active employees only; at least {min_years} completed "
        "year(s) of service. A 29-Feb join date is shown on 28-Feb in non-leap years.",
    ]
    if unusable:
        notes.append(f"{unusable} active employee(s) have a missing or unreadable join date and cannot be listed.")
    return ReportResult(rows=rows, summary=summary, notes=notes)


register(ReportSpec(
    id="work-anniversaries",
    title="Work Anniversaries",
    description="Service anniversaries and completed years of service in a month or the coming days.",
    category=CATEGORY,
    modules=MODULES,
    icon="Award",
    tags=("anniversary", "service", "years of service", "celebrations", "milestone", "long service"),
    family="celebrations",
    variant="Work anniversaries",
    landscape=False,
    filters=(
        _window_filter(),
        *F.scope(employee=False, status=None),
        F.number("minYears", "Minimum years of service", default=1, min=1, max=60),
    ),
    columns=ANNIVERSARY_COLUMNS,
    run=_anniversaries_run,
))  # fmt: skip


# ═════════════════════════════════════════════════════════════════════════════
# service-milestones
# ═════════════════════════════════════════════════════════════════════════════

MILESTONE_COLUMNS = (
    ColumnSpec("employeeCode", "Emp Code", TEXT, 1.0),
    ColumnSpec("employeeName", "Employee", TEXT, 2.2),
    ColumnSpec("department", "Department", TEXT, 1.5),
    ColumnSpec("designation", "Designation", TEXT, 1.5),
    ColumnSpec("employmentType", "Type", BADGE, 0.9),
    ColumnSpec("joinDate", "Join Date", DATE, 1.1),
    ColumnSpec("serviceMonths", "Service (Months)", INTEGER, 0.9),
    ColumnSpec("probationEnd", "Probation Ends", DATE, 1.1),
    ColumnSpec("probationSource", "Probation Date", BADGE, 0.9),
    ColumnSpec("confirmationDate", "Confirmed On", DATE, 1.1),
    ColumnSpec("clEligibleFrom", "Casual Leave From", DATE, 1.1),
    ColumnSpec("clEligible", "Casual Leave", BADGE, 1.0),
)
MILESTONE_OPTIONS = (
    ("probation_ending", "Probation ending in 30 days"),
    ("probation_over", "Probation completed"),
    ("cl_eligible", "Casual leave eligible"),
    ("cl_not_yet", "Casual leave not yet eligible"),
)


def _milestones_run(ctx) -> ReportResult:
    from api.casual_leave_views import ELIGIBILITY_MONTHS

    today = ctx.today
    probation_months = ctx.param("probationMonths", 3)
    milestone = ctx.params.get("milestone")
    emps = list(employees_qs(ctx))
    emps.sort(key=lambda e: code_key(e.employee_code))

    counts: Counter = Counter()
    rows = []
    no_join = 0
    for e in emps:
        joined, _state = join_date_of(e)
        if joined is None:
            no_join += 1
            continue
        months = max(0, months_between(joined, today))
        recorded = e.probation_end_date
        probation_end = recorded or add_months(joined, probation_months)
        confirmed = e.confirmation_date
        on_probation = probation_end > today and not (confirmed and confirmed <= today)
        ending_soon = on_probation and probation_end <= today + timedelta(days=30)
        is_staff = (e.employment_type or "").strip() == "staff"
        if not is_staff:
            cl_state, cl_from = "Not applicable", None
        else:
            cl_from = months_reached_on(joined, ELIGIBILITY_MONTHS)
            cl_state = "Eligible" if months >= ELIGIBILITY_MONTHS else "Not yet"
        counts["probation"] += on_probation
        counts["ending"] += ending_soon
        counts["cl_yes"] += cl_state == "Eligible"
        counts["cl_no"] += cl_state == "Not yet"
        keep = {
            None: True,
            "probation_ending": ending_soon,
            "probation_over": not on_probation,
            "cl_eligible": cl_state == "Eligible",
            "cl_not_yet": cl_state == "Not yet",
        }[milestone]
        if not keep:
            continue
        rows.append({
            "employeeCode": e.employee_code,
            "employeeName": _person_name(e),
            "department": department_name(e),
            "designation": e.designation.title if e.designation_id else None,
            "employmentType": type_label(e.employment_type),
            "joinDate": joined,
            "serviceMonths": months,
            "probationEnd": probation_end,
            "probationSource": "Recorded" if recorded else "Derived",
            "confirmationDate": confirmed,
            "clEligibleFrom": cl_from,
            "clEligible": cl_state,
        })  # fmt: skip

    summary = [
        {"label": "On probation", "value": counts["probation"], "format": "integer"},
        {"label": "Probation ending in 30 days", "value": counts["ending"], "format": "integer"},
        {"label": "Casual leave eligible", "value": counts["cl_yes"], "format": "integer"},
        {"label": "Casual leave not yet eligible", "value": counts["cl_no"], "format": "integer"},
        {"label": "Join date missing (not listed)", "value": no_join, "format": "integer"},
    ]
    notes = [
        f"No probation policy is stored: 'Derived' probation end = join date + {probation_months} month(s); 'Recorded' "
        "means HR entered a probation end date on the employee. Change the months above to test another policy.",
        f"Casual leave is for staff only, after {ELIGIBILITY_MONTHS} completed months of service (the same rule the "
        "casual-leave screens apply); production employees show 'Not applicable'.",
    ]
    if no_join:
        notes.append(f"{no_join} employee(s) have a missing or unreadable join date and are left out.")
    return ReportResult(rows=rows, summary=summary, notes=notes)


register(ReportSpec(
    id="service-milestones",
    title="Service Milestones",
    description="Completed service, probation end and casual-leave eligibility date for each employee.",
    category=CATEGORY,
    modules=("employees", "casual_leave"),
    icon="Hourglass",
    tags=("probation", "confirmation", "casual leave", "eligibility", "service", "tenure"),
    filters=(
        *F.scope(employee=False, status="active"),
        F.number("probationMonths", "Probation (months)", default=3, min=1, max=24, help="Used where no probation end date is recorded."),
        F.select("milestone", "Show", MILESTONE_OPTIONS, placeholder="Everyone"),
    ),
    columns=MILESTONE_COLUMNS,
    run=_milestones_run,
))  # fmt: skip

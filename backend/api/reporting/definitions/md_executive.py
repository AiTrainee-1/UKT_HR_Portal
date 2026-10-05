"""The executive pack of the Managing Director (category ``md``): seven one-page reports that exist for the MD alone.

Every spec is ``md_only``: hidden from everybody else (super administrators included) and visible and runnable by the MD
only (see ``reporting/access.py``). They are registered by the modules below when the Report Center loads its
definitions; this module is the index of the pack, so the MD portal and the tests have one place to ask which reports
belong to it.

    md-daily-brief            MD Daily Brief               one day, unit by unit: headcount, attendance, visitors,
                                                           outpasses, tea-break overruns, and what to look at
    md-weekly-workforce       Weekly Workforce Summary     by department, a week against the week before
    md-monthly-payroll        Monthly Payroll Summary      by department, a month's cost and what drove the change
    md-attrition-hiring       Attrition & Hiring Review    opening / closing headcount, joiners, leavers, attrition,
                                                           open positions, pending resignations, early attrition
    md-attendance-exceptions  Attendance Exceptions        the people behind long absences, chronic absence, lateness
    md-department-scorecard   Department Scorecard         every department against the company, with Red/Amber/Green
    md-gate-discipline        Gate & Discipline Review     visitors, outpasses, hours lost, tea-break overruns

Where the numbers come from: the MD portal's analytics modules (``md_portal/analytics``), through ``md_sources``; the
shared helpers, caveats and RAG rules are in ``md_common``. A figure in a report equals the figure on the MD's page and
in the assistant for the same period and scope.
"""

from __future__ import annotations

from . import (
    md_attendance_exceptions,
    md_attrition_hiring,
    md_daily_brief,
    md_department_scorecard,
    md_gate_discipline,
    md_monthly_payroll,
    md_weekly_workforce,
)

REPORTS = (
    md_daily_brief.SPEC,
    md_weekly_workforce.SPEC,
    md_monthly_payroll.SPEC,
    md_attrition_hiring.SPEC,
    md_attendance_exceptions.SPEC,
    md_department_scorecard.SPEC,
    md_gate_discipline.SPEC,
)
MD_REPORT_IDS = tuple(spec.id for spec in REPORTS)

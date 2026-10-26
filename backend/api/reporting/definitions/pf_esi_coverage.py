"""
PF / ESI Coverage: how many employees have PF / ESI deductions and how many do not.

Built on pf_esi.coverage_rows / coverage_counts, the same functions behind GET /api/pf-esi/coverage and its Excel / PDF export
(pf_esi_coverage_export.py), so the Report Center, the Employees > Co Emp page and the downloaded files always show the same
numbers. Unlike the PF / ESI statements (which quote what past payrolls deducted) this is the rules AS THEY STAND NOW:

    Co Emp       PF and ESI apply; the row says whether the rules of Settings > PF & ESI give this employee PF and / or ESI
                 (Staff: judged on the current salary split; Production: on the monthly equivalent of the latest generated
                 payroll period, 'Not evaluated' when there is none yet)
    TDS          TDS only, never PF or ESI
    Not Co Emp   neither

Read-only: nothing is generated or written.
"""

from __future__ import annotations

from api import pf_esi

from ..filters import scope
from ..registry import register
from ..types import BADGE, NUMBER, TEXT, ColumnSpec, ReportResult, ReportSpec

CLASS_TITLES = {pf_esi.CLASS_STAFF: "Staff", pf_esi.CLASS_PRODUCTION: "Production"}
CATEGORY_TEXT = {
    pf_esi.CATEGORY_CO_EMP: "Co Emp",
    pf_esi.CATEGORY_TDS: "TDS",
    pf_esi.CATEGORY_NONE: "Not Co Emp",
}
STATUS_TEXT = {
    pf_esi.STATUS_PF_ESI: "PF and ESI",
    pf_esi.STATUS_PF_ONLY: "PF only",
    pf_esi.STATUS_ESI_ONLY: "ESI only",
    pf_esi.STATUS_NEITHER: "Co Emp, no PF or ESI",
    pf_esi.STATUS_NOT_EVALUATED: "Not evaluated",
    pf_esi.STATUS_TDS: "TDS only",
    pf_esi.STATUS_NOT_CO_EMP: "Not Co Emp",
}


def yes_no(value) -> str | None:
    return None if value is None else ("Yes" if value else "No")


def _run(ctx) -> ReportResult:
    # ctx.row_limit is the ceiling plus one (the runner refuses an export over the limit); employees come ordered by code
    employees = list(ctx.employees()[: ctx.row_limit])
    rows_in = pf_esi.coverage_rows(employees)
    rows = [
        {
            "employeeCode": r["employeeCode"],
            "employeeName": r["name"],
            "type": CLASS_TITLES[
                pf_esi.CLASS_PRODUCTION if r["employmentType"] == "production" else pf_esi.CLASS_STAFF
            ],
            "department": r["departmentName"] or "Unassigned",
            "branch": r["branchName"],
            "category": CATEGORY_TEXT[r["category"]],
            "pf": yes_no(r["pf"]),
            "pfRate": r["pfRatePercent"],
            "esi": yes_no(r["esi"]),
            "esiRate": r["esiRatePercent"],
            "status": STATUS_TEXT[r["status"]],
            "tdsPercent": r["tdsPercent"],
        }
        for r in rows_in
    ]
    counts = {
        key: sum(pf_esi.coverage_counts(rows_in, emp_class)[key] for emp_class in pf_esi.CLASSES)
        for key in ("total", "coEmp", "withPf", "withEsi", "withBoth", "withNeither", "tds", "notCoEmp", "notEvaluated")
    }
    summary = [
        {"label": "Employees", "value": counts["total"], "format": "integer"},
        {"label": "Co Emp (PF and ESI apply)", "value": counts["coEmp"], "format": "integer"},
        {"label": "With PF", "value": counts["withPf"], "format": "integer"},
        {"label": "With ESI", "value": counts["withEsi"], "format": "integer"},
        {"label": "With both", "value": counts["withBoth"], "format": "integer"},
        {"label": "Co Emp, no PF or ESI", "value": counts["withNeither"], "format": "integer"},
        {"label": "TDS employees", "value": counts["tds"], "format": "integer"},
        {"label": "Not Co Emp", "value": counts["notCoEmp"], "format": "integer"},
    ]
    if counts["notEvaluated"]:
        summary.append({"label": "Not evaluated yet", "value": counts["notEvaluated"], "format": "integer"})
    notes = [
        "Only Co Emp employees (Employees > Co Emp) can have PF or ESI, by the rules of Settings > PF & ESI (a unit's own "
        "rules when it has them, else the rules for all units). TDS employees have TDS only; everybody else has neither.",
        "This shows what the next payroll would do under today's rules, not what past payrolls deducted: see the PF and ESI "
        "statements for that.",
        "Staff are judged on their current salary split. Production workers are judged on the monthly equivalent of their "
        "latest generated payroll period: a Co Emp worker with none yet is 'Not evaluated'.",
    ]
    return ReportResult(rows=rows, summary=summary, notes=notes)


register(
    ReportSpec(
        id="pf-esi-coverage",
        title="PF / ESI Coverage",
        description="How many employees have PF and ESI deductions and how many do not: Co Emp, TDS and the rest, "
        "with the PF and ESI percentage each Co Emp employee gets under today's rules.",
        category="payroll",
        icon="PieChart",
        tags=("pf", "esi", "co emp", "tds", "coverage", "statutory", "how many", "deductions"),
        modules=("employees",),
        filters=scope(status="active", designation=False, employee=False),
        columns=(
            ColumnSpec("employeeCode", "Emp Code", TEXT, 1.0),
            ColumnSpec("employeeName", "Employee", TEXT, 2.2),
            ColumnSpec("type", "Type", BADGE, 1.0),
            ColumnSpec("department", "Department", TEXT, 1.5),
            ColumnSpec("branch", "Branch", TEXT, 1.3),
            ColumnSpec("category", "Category", BADGE, 1.1),
            ColumnSpec("pf", "PF", BADGE, 0.7),
            ColumnSpec("pfRate", "PF %", NUMBER, 0.8),
            ColumnSpec("esi", "ESI", BADGE, 0.7),
            ColumnSpec("esiRate", "ESI %", NUMBER, 0.8),
            ColumnSpec("status", "Status", BADGE, 1.5),
            ColumnSpec("tdsPercent", "TDS %", NUMBER, 0.8),
        ),
        run=_run,
    )
)

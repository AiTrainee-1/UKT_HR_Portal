"""
Statutory payroll statements: PF, ESI and the PF/ESI coverage register.

All three read the stored SalarySlip rows (so an employee who has since left still appears) and quote
the deductions the payroll engine actually made. Employer shares are NOT stored anywhere in the system;
where a statement shows one it is a clearly labelled statutory-derived estimate (constants in
payroll_statutory_common) and never replaces the figure deducted from the employee.
"""

from __future__ import annotations

from decimal import ROUND_HALF_UP, Decimal

from django.db.models import F, OuterRef, Subquery

from api.models import SalarySlip

from ..filters import month_days, period, scope, select
from ..formatting import month_label
from ..registry import register
from ..types import BADGE, CURRENCY, NUMBER, TEXT, ColumnSpec, ReportResult, ReportSpec
from .payroll_statutory_common import (
    EDLI_RATE, EPF_ADMIN_RATE, EPF_RATE, EPS_RATE, EPS_WAGE_CEILING, ESI_EMPLOYER_RATE, PAYROLL_MODULES, PRODUCTION,
    STAFF, TYPE_LABEL, as_dict, blank, dec, dec_or_none, dept_name, employee_type_q, money, natural_key, period_text,
    read_settings, slip_type, slip_type_q, visible_types, with_breakdown, whole_rupee,
)

_ZERO = Decimal("0")


# -- shared: one accumulator per employee (and payroll kind) for the month ---------------------------------
def _month_slips(ctx, year: int, month: int, *breakdown: str):
    qs = SalarySlip.objects.filter(
        ctx.emp_q("employee__"), slip_type_q(visible_types(ctx)), year=year, month=month
    ).select_related("employee__department")
    return with_breakdown(qs, *breakdown).order_by("employee_id", "id")


def _attendance_days(slip, typ: str, summ: dict, days_in_month: Decimal):
    """(days paid, non-contributory days) for a slip, from the stored breakdown.

    Staff: weekly offs and holidays are paid days, so days paid = calendar days - loss-of-pay days, where
    loss-of-pay = working days - effective paid days (half-days count 0.5). Production: days worked, and
    the days of the pay period on which nothing was worked. Unknown (no breakdown) is None, not zero."""
    if typ == STAFF:
        eff = dec_or_none(summ.get("effectivePaidDays"))
        lop = max(_ZERO, Decimal(slip.working_days) - eff) if eff is not None else dec(slip.absent_days)
        return days_in_month - lop, lop
    worked = dec_or_none(summ.get("daysWorked"))
    if worked is None:
        return None, None
    total = dec_or_none(summ.get("totalDays"))
    total = total if total is not None else Decimal(slip.working_days)
    return worked, max(_ZERO, total - worked)


def _accumulate(slips, year: int, month: int, extra=None):
    """{(employee id, kind): totals}. Several production slips in one month are summed; for staff (one slip
    per month by design) a duplicate would double-count pay, so the newest slip wins and the count is returned."""
    days_in_month = Decimal(month_days(year, month))
    acc: dict[tuple[int, str], dict] = {}
    dupes = 0
    for s in slips:
        typ = slip_type(s)
        days_paid, ncp = _attendance_days(s, typ, as_dict(s.bd_summary), days_in_month)
        one = {
            "emp": s.employee, "type": typ, "slip_id": s.id,
            "gross": dec(s.gross_salary) + dec(s.ot_amount), "pf_wages": dec(s.basic), "pf": dec(s.pf_deduction),
            "esi_wages": dec(s.gross_salary), "esi": dec(s.esi_deduction),
            "days_paid": days_paid, "ncp": ncp,
        }
        if extra:
            one.update(extra(s, typ))
        key = (s.employee_id, typ)
        cur = acc.get(key)
        if cur is None:
            acc[key] = one
        elif typ == STAFF:
            dupes += 1
            if s.id > cur["slip_id"]:
                acc[key] = one
        else:
            for k in ("gross", "pf_wages", "pf", "esi_wages", "esi"):
                cur[k] += one[k]
            for k in ("days_paid", "ncp"):
                cur[k] = None if cur[k] is None or one[k] is None else cur[k] + one[k]
            for k, v in one.items():
                if k.startswith("flag_"):
                    cur[k] = cur[k] or v
    ordered = sorted(acc.values(), key=lambda a: natural_key(a["emp"].employee_code))
    return ordered, dupes


def _ids(emp) -> tuple[str | None, str | None, str | None]:
    def clean(v):
        return None if blank(v) else str(v).strip()

    return clean(emp.uan_number), clean(emp.pf_number), clean(emp.esi_number)


def _dupe_note(dupes: int) -> list[str]:
    return [f"{dupes} duplicate staff slip(s) for the same month were ignored (the newest is used)."] if dupes else []


# -- PF statement -------------------------------------------------------------------------------------------
def _run_pf(ctx) -> ReportResult:
    year, month = ctx.period
    capped = (ctx.param("wageCeiling") or "15000") == "15000"
    coverage = ctx.param("coverage") or "covered"
    slips = list(_month_slips(ctx, year, month, "bd_summary"))
    accs, dupes = _accumulate(slips, year, month)

    rows: list[dict] = []
    keys = ("gross", "pf_wages", "epf_wages", "eps_wages", "ee", "eps", "er_epf", "er_total", "remit", "edli_wages")
    tot = {k: _ZERO for k in keys}
    missing_uan = covered_n = 0
    for a in accs:
        emp = a["emp"]
        covered = a["pf"] > 0
        covered_n += covered
        if coverage == "covered" and not covered:
            continue
        uan, pf_no, _esi = _ids(emp)
        epf_wages = min(a["pf_wages"], EPS_WAGE_CEILING) if capped else a["pf_wages"]
        eps_wages = min(a["pf_wages"], EPS_WAGE_CEILING)
        er_total = eps = er_epf = variance = remit = None
        tot["gross"] += a["gross"]
        tot["pf_wages"] += a["pf_wages"]
        tot["epf_wages"] += epf_wages
        tot["eps_wages"] += eps_wages
        if covered:
            er_total = whole_rupee(epf_wages * EPF_RATE / 100)  # statutory 12% on the EPF wage base (EE = ER)
            eps = whole_rupee(eps_wages * EPS_RATE / 100)
            er_epf = er_total - eps
            variance = a["pf"] - er_total
            remit = er_total * 2
            tot["ee"] += a["pf"]
            tot["eps"] += eps
            tot["er_epf"] += er_epf
            tot["er_total"] += er_total
            tot["remit"] += remit
            tot["edli_wages"] += eps_wages
            missing_uan += uan is None
        gaps = [n for n, v in (("UAN", uan), ("PF no.", pf_no)) if v is None]
        rows.append({
            "employeeCode": emp.employee_code,
            "employeeName": f"{emp.first_name or ''} {emp.last_name or ''}".strip(),
            "uanNumber": uan,
            "pfNumber": pf_no,
            "department": dept_name(emp),
            "employmentType": TYPE_LABEL[a["type"]],
            "daysPaid": money(a["days_paid"]),
            "ncpDays": money(a["ncp"]),
            "grossWages": money(a["gross"]),
            "pfWages": money(a["pf_wages"]),
            "epfWages": money(epf_wages),
            "epsWages": money(eps_wages),
            "eeShare": money(a["pf"]),
            "epsShare": money(eps),
            "erEpfShare": money(er_epf),
            "erTotal": money(er_total),
            "eeVariance": money(variance),
            "totalRemittance": money(remit),
            "idCheck": ("Missing " + ", ".join(gaps)) if gaps else ("OK" if covered else None),
        })

    edli = whole_rupee(tot["edli_wages"] * EDLI_RATE / 100)
    admin = whole_rupee(tot["epf_wages"] * EPF_ADMIN_RATE / 100)
    notes = [
        f"Employee PF is the amount deducted on the salary slips for {month_label(year, month)}; PF wages are the "
        "basic pay on the slip. Employees who have since left are included (the statement is driven by slips).",
        "Employer shares are statutory-derived estimates (the system stores no employer rates): EPF 12% of EPF "
        "wages, of which EPS 8.33% on wages capped at Rs. 15,000 and the rest to EPF; whole-rupee rounding. "
        + ("EPF wages are capped at Rs. 15,000." if capped else "EPF wages are the actual PF wages (no cap)."),
        "'Deducted vs 12%' = PF deducted on the slip minus 12% of EPF wages; it is non-zero when payroll deducts "
        "on wages above the cap or at a different rate.",
        "Days paid: staff = calendar days minus loss-of-pay days (weekly offs and holidays are paid); NCP days = "
        "loss-of-pay days. Production = days worked / days not worked in the pay periods ending in the month.",
        "Gross wages = gross salary + overtime pay on the slip.",
        f"Estimated employer charges on this statement: EDLI 0.5% = Rs. {edli:,.0f}; PF administration 0.5% = "
        f"Rs. {admin:,.0f} (statutory minimums may apply).",
    ] + _dupe_note(dupes)
    if coverage == "covered":
        notes.append("Only employees with PF deducted are listed; choose 'All employees with a slip' to see the rest.")
    summary = [
        {"label": "PF covered employees", "value": covered_n, "format": "integer"},
        {"label": "PF wages", "value": money(tot["pf_wages"]), "format": "currency"},
        {"label": "EPF wages", "value": money(tot["epf_wages"]), "format": "currency"},
        {"label": "EE PF deducted", "value": money(tot["ee"]), "format": "currency"},
        {"label": "ER EPS (est.)", "value": money(tot["eps"]), "format": "currency"},
        {"label": "ER EPF (est.)", "value": money(tot["er_epf"]), "format": "currency"},
        {"label": "Statutory remittance (est.)", "value": money(tot["remit"]), "format": "currency"},
        {"label": "Covered, UAN missing", "value": missing_uan, "format": "integer"},
    ]
    return ReportResult(rows=rows, summary=summary, notes=notes)


_PF_COLS = (
    ColumnSpec("employeeCode", "Emp Code", TEXT, 1.0),
    ColumnSpec("employeeName", "Employee", TEXT, 2.2),
    ColumnSpec("uanNumber", "UAN", TEXT, 1.5),
    ColumnSpec("pfNumber", "PF No.", TEXT, 1.4),
    ColumnSpec("department", "Department", TEXT, 1.4),
    ColumnSpec("employmentType", "Type", BADGE, 0.9),
    ColumnSpec("daysPaid", "Days paid", NUMBER, 0.8),
    ColumnSpec("ncpDays", "NCP days", NUMBER, 0.8),
    ColumnSpec("grossWages", "Gross wages", CURRENCY, 1.3, total="sum"),
    ColumnSpec("pfWages", "PF wages", CURRENCY, 1.3, total="sum"),
    ColumnSpec("epfWages", "EPF wages", CURRENCY, 1.3, total="sum"),
    ColumnSpec("epsWages", "EPS wages", CURRENCY, 1.3, total="sum"),
    ColumnSpec("eeShare", "EE PF deducted", CURRENCY, 1.3, total="sum"),
    ColumnSpec("epsShare", "ER EPS 8.33%", CURRENCY, 1.2, total="sum"),
    ColumnSpec("erEpfShare", "ER EPF diff", CURRENCY, 1.2, total="sum"),
    ColumnSpec("erTotal", "ER share 12%", CURRENCY, 1.2, total="sum"),
    ColumnSpec("eeVariance", "Deducted vs 12%", CURRENCY, 1.2, total="sum"),
    ColumnSpec("totalRemittance", "Remittance (EE+ER)", CURRENCY, 1.4, total="sum"),
    ColumnSpec("idCheck", "ID check", BADGE, 1.5),
)

register(ReportSpec(
    id="pf-statement",
    title="PF Statement",
    description="Provident fund wages and contributions per employee for a month, with UAN, NCP days and the "
    "employer EPS / EPF split (ECR style).",
    category="payroll",
    icon="Landmark",
    tags=("epf", "eps", "provident fund", "ecr", "uan", "statutory"),
    modules=PAYROLL_MODULES,
    filters=(
        period(default="lastMonth"),
        *scope(status=None),
        select(
            "wageCeiling", "EPF wage basis",
            [("15000", "Capped at Rs. 15,000 (statutory)"), ("none", "Actual PF wages (no cap)")], default="15000",
            help="Wages the 12% employee/employer shares are worked on.",
        ),
        select(
            "coverage", "Coverage",
            [("covered", "PF covered only"), ("all", "All employees with a slip")], default="covered",
        ),
    ),
    columns=_PF_COLS,
    run=_run_pf,
))


# -- ESI statement ------------------------------------------------------------------------------------------
def _esi_extra(slip, typ: str) -> dict:
    limit = dec_or_none(slip.bd_esi_limit)
    basis = (
        dec_or_none(as_dict(slip.bd_earn).get("monthlySalary")) if typ == STAFF else dec_or_none(slip.bd_month_eq)
    )
    return {"flag_above": bool(limit is not None and basis is not None and basis > limit)}


def _run_esi(ctx) -> ReportResult:
    year, month = ctx.period
    coverage = ctx.param("coverage") or "covered"
    slips = list(_month_slips(ctx, year, month, "bd_summary", "bd_earn", "bd_esi_limit", "bd_month_eq"))
    accs, dupes = _accumulate(slips, year, month, extra=_esi_extra)

    rows: list[dict] = []
    covered_n = above_n = missing_ip = 0
    wages = ee_tot = er_tot = _ZERO
    for a in accs:
        emp = a["emp"]
        covered = a["esi"] > 0
        _uan, _pf, esi_no = _ids(emp)
        if covered:
            covered_n += 1
            missing_ip += esi_no is None
        elif a["flag_above"]:
            above_n += 1
        if (coverage == "covered" and not covered) or (coverage == "exempt" and covered):
            continue
        er = total = None
        if covered:
            er = (a["esi_wages"] * ESI_EMPLOYER_RATE / 100).quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)
            total = a["esi"] + er
            wages += a["esi_wages"]
            ee_tot += a["esi"]
            er_tot += er
        rows.append({
            "employeeCode": emp.employee_code,
            "employeeName": f"{emp.first_name or ''} {emp.last_name or ''}".strip(),
            "esiNumber": esi_no,
            "department": dept_name(emp),
            "employmentType": TYPE_LABEL[a["type"]],
            "daysPaid": money(a["days_paid"]),
            "esiWages": money(a["esi_wages"]),
            "eeShare": money(a["esi"]),
            "erShare": money(er),
            "totalContribution": money(total),
            "coverage": "Covered" if covered else ("Above ceiling" if a["flag_above"] else "Not covered"),
            "idCheck": ("OK" if esi_no else "Missing IP no.") if covered else None,
        })

    notes = [
        f"Employee ESI is the amount deducted on the salary slips for {month_label(year, month)}. ESI wages are the "
        "slip's gross salary as payroll used it, which excludes overtime pay; the statutory wage base includes it.",
        "Employer share is a statutory-derived estimate at 3.25% of ESI wages (the system stores no employer "
        "rate). ESIC rounds each contribution up to the next rupee; amounts here keep payroll's paise.",
        "'Above ceiling' = the salary payroll tested (staff: monthly salary; production: gross x 2) was over the "
        "ESI limit stored in the slip. Contribution-period stickiness (Apr-Sep / Oct-Mar) is not modelled.",
        "Days paid: staff = calendar days minus loss-of-pay days; production = days worked in the pay periods.",
    ] + _dupe_note(dupes)
    summary = [
        {"label": "ESI covered employees", "value": covered_n, "format": "integer"},
        {"label": "ESI wages", "value": money(wages), "format": "currency"},
        {"label": "Employee contribution", "value": money(ee_tot), "format": "currency"},
        {"label": "Employer contribution (est.)", "value": money(er_tot), "format": "currency"},
        {"label": "Total contribution", "value": money(ee_tot + er_tot), "format": "currency"},
        {"label": "Above ESI ceiling (exempt)", "value": above_n, "format": "integer"},
        {"label": "Covered, IP number missing", "value": missing_ip, "format": "integer"},
    ]
    return ReportResult(rows=rows, summary=summary, notes=notes)


register(ReportSpec(
    id="esi-statement",
    title="ESI Statement",
    description="ESI-covered employees with IP number, ESI wages and employee / employer contributions for a month.",
    category="payroll",
    icon="HeartPulse",
    tags=("esic", "employee state insurance", "ip number", "statutory"),
    modules=PAYROLL_MODULES,
    filters=(
        period(default="lastMonth"),
        *scope(status=None),
        select(
            "coverage", "Coverage",
            [("covered", "ESI covered only"), ("exempt", "Not covered / above ceiling"), ("all", "All employees with a slip")],
            default="covered",
        ),
    ),
    columns=(
        ColumnSpec("employeeCode", "Emp Code", TEXT, 1.0),
        ColumnSpec("employeeName", "Employee", TEXT, 2.2),
        ColumnSpec("esiNumber", "ESI IP No.", TEXT, 1.5),
        ColumnSpec("department", "Department", TEXT, 1.5),
        ColumnSpec("employmentType", "Type", BADGE, 0.9),
        ColumnSpec("daysPaid", "Days paid", NUMBER, 0.8),
        ColumnSpec("esiWages", "ESI wages", CURRENCY, 1.3, total="sum"),
        ColumnSpec("eeShare", "Employee share", CURRENCY, 1.3, total="sum"),
        ColumnSpec("erShare", "Employer 3.25%", CURRENCY, 1.3, total="sum"),
        ColumnSpec("totalContribution", "Total contribution", CURRENCY, 1.4, total="sum"),
        ColumnSpec("coverage", "Coverage", BADGE, 1.2),
        ColumnSpec("idCheck", "ID check", BADGE, 1.2),
    ),
    run=_run_esi,
))


# -- PF / ESI coverage & identifier register ---------------------------------------------------------------
def _run_coverage(ctx) -> ReportResult:
    types = visible_types(ctx)
    coverage = ctx.param("coverage") or "all"
    latest = (
        SalarySlip.objects.filter(slip_type_q(types), employee=OuterRef("pk"))
        .order_by("-year", "-month", F("period_end").desc(nulls_last=True), "-id")
        .values("id")[:1]
    )
    emps = list(ctx.employees().filter(employee_type_q(types)).annotate(latest_slip_id=Subquery(latest)))
    ids = [e.latest_slip_id for e in emps if e.latest_slip_id]
    slips = {
        s.id: s
        for s in with_breakdown(SalarySlip.objects.filter(id__in=ids), "bd_earn", "bd_esi_limit", "bd_month_eq")
    } if ids else {}

    settings = read_settings()
    rows: list[dict] = []
    n_pf = n_esi = n_neither = n_missing = n_near = n_noslip = 0
    for e in sorted(emps, key=lambda x: natural_key(x.employee_code)):
        s = slips.get(e.latest_slip_id)
        uan, pf_no, esi_no = _ids(e)
        typ = slip_type(s) if s else (PRODUCTION if e.employment_type == PRODUCTION else STAFF)
        limit = dec_or_none(s.bd_esi_limit) if s else None
        if typ == STAFF:
            basis = e.salary_amount
        else:
            basis = dec_or_none(s.bd_month_eq) if s else None
        pf_cov = bool(s and s.pf_deduction > 0)
        esi_cov = bool(s and s.esi_deduction > 0)
        above = bool(s and not esi_cov and limit is not None and basis is not None and basis > limit)
        near = bool(
            s and limit and basis is not None and basis <= limit and basis >= limit * Decimal("0.9")
        )
        gaps = []
        if pf_cov:
            gaps += [n for n, v in (("UAN", uan), ("PF no.", pf_no)) if v is None]
        if esi_cov and esi_no is None:
            gaps.append("ESI no.")
        n_noslip += s is None
        n_pf += pf_cov
        n_esi += esi_cov
        n_neither += bool(s and not pf_cov and not esi_cov)
        n_missing += bool(gaps)
        n_near += near
        keep = {
            "all": True, "pf": pf_cov, "esi": esi_cov, "neither": bool(s and not pf_cov and not esi_cov),
            "missing-ids": bool(gaps), "no-slip": s is None,
        }[coverage]
        if not keep:
            continue
        rows.append({
            "employeeCode": e.employee_code,
            "employeeName": f"{e.first_name or ''} {e.last_name or ''}".strip(),
            "department": dept_name(e),
            "employmentType": TYPE_LABEL[typ],
            "salaryBasis": money(dec_or_none(basis)),
            "esiCeiling": money(limit),
            "pfCovered": "No slip" if s is None else ("Yes" if pf_cov else "No"),
            "esiCovered": "No slip" if s is None else ("Yes" if esi_cov else ("Above ceiling" if above else "No")),
            "pfNumber": pf_no,
            "esiNumber": esi_no,
            "uanNumber": uan,
            "idCheck": ("Missing " + ", ".join(gaps)) if gaps else ("OK" if (pf_cov or esi_cov) else None),
            "lastSlipPeriod": period_text(s) if s else None,
        })

    on = "ON" if settings.staff_payroll_rules_enabled else "OFF"
    pon = "ON" if settings.prod_payroll_rules_enabled else "OFF"
    notes = [
        "Coverage is inferred from the PF / ESI deducted on each employee's latest salary slip (there is no "
        "per-employee PF/ESI switch). Employees with no slip show 'No slip'.",
        f"Company-wide payroll rules switch: staff PF/ESI rules {on}, production PF/ESI rules {pon} (a branch may "
        "override; production may also use salary-range rules). While a switch is off nobody in that group is covered.",
        "Salary / monthly equivalent: staff = monthly salary on the profile; production = latest slip gross x 2, "
        "the figure payroll tests against the ESI ceiling. 'Near ceiling' = within 10% below the ESI limit.",
    ]
    summary = [
        {"label": "Employees", "value": len(emps), "format": "integer"},
        {"label": "PF covered", "value": n_pf, "format": "integer"},
        {"label": "ESI covered", "value": n_esi, "format": "integer"},
        {"label": "Covered by neither", "value": n_neither, "format": "integer"},
        {"label": "No slip yet", "value": n_noslip, "format": "integer"},
        {"label": "Covered, IDs missing", "value": n_missing, "format": "integer"},
        {"label": "Within 10% of ESI ceiling", "value": n_near, "format": "integer"},
    ]
    return ReportResult(rows=rows, summary=summary, notes=notes)


register(ReportSpec(
    id="statutory-coverage",
    title="PF / ESI Coverage Register",
    description="Who is under PF and ESI (from the latest slip), with UAN, PF and ESI numbers and salary against "
    "the ESI ceiling.",
    category="payroll",
    icon="ShieldCheck",
    tags=("pf", "esi", "uan", "identifiers", "coverage", "statutory"),
    modules=PAYROLL_MODULES,
    filters=(
        *scope(status="active"),
        select(
            "coverage", "Coverage",
            [
                ("all", "All employees"), ("pf", "PF covered"), ("esi", "ESI covered"), ("neither", "Covered by neither"),
                ("missing-ids", "Covered but IDs missing"), ("no-slip", "No slip yet"),
            ],
            default="all",
        ),
    ),
    columns=(
        ColumnSpec("employeeCode", "Emp Code", TEXT, 1.0),
        ColumnSpec("employeeName", "Employee", TEXT, 2.2),
        ColumnSpec("department", "Department", TEXT, 1.5),
        ColumnSpec("employmentType", "Type", BADGE, 0.9),
        ColumnSpec("salaryBasis", "Salary / monthly equiv.", CURRENCY, 1.3),
        ColumnSpec("esiCeiling", "ESI ceiling", CURRENCY, 1.1),
        ColumnSpec("pfCovered", "PF", BADGE, 0.8),
        ColumnSpec("esiCovered", "ESI", BADGE, 1.0),
        ColumnSpec("pfNumber", "PF No.", TEXT, 1.3),
        ColumnSpec("esiNumber", "ESI IP No.", TEXT, 1.3),
        ColumnSpec("uanNumber", "UAN", TEXT, 1.4),
        ColumnSpec("idCheck", "ID check", BADGE, 1.4),
        ColumnSpec("lastSlipPeriod", "Last slip", TEXT, 1.6),
    ),
    run=_run_coverage,
))


"""
The Salary Statement: the data of the printed 'Salary Statement' (grouped by department, one line per employee, a
subtotal per department and a grand total), for staff payroll (one month) and production payroll (one pay-cycle period).

    GET /api/payroll/salary-statement?month=&year=[&departmentId=&branchId=&employeeId=&status=paid|pending]
    GET /api/payroll/production/salary-statement?cycle=&periodStart=&periodEnd=[...same filters]

READ-ONLY, and built from what payroll stored: the Payroll row (its money, TDS included), its SalarySlip (PF / ESI / advance and the
breakdown's day counts), the employee's profile and recorded salary split, approved Casual Leave and the running advances.
Nothing is recomputed. Every figure of a row is explained in the response's `notes`, because the printed layout cannot say
how its columns are worked out. Staff is gated by the `payroll` permission module and production by `production_payroll`
(the module comes from the URL); a branch-scoped login only ever gets its own branch.

A statement of hundreds of employees is a fixed number of queries: the payrolls (with their employee, department, designation
and branch), their slips, approved Casual Leave, advance balances and the company settings, each fetched once for everyone.
The response shape is `SalaryStatement` in frontend/src/lib/api-client/custom-hooks/payroll-insights.ts.
"""

from __future__ import annotations

from decimal import Decimal

from django.utils import timezone
from rest_framework.decorators import api_view
from rest_framework.request import Request
from rest_framework.response import Response

from .auth import require_hr
from .branch_scope import get_branch_scope
from .models import Branch, Payroll
from .payroll_insights import (
    KIND_PRODUCTION,
    KIND_STAFF,
    SettingsResolver,
    breakdown_of,
    casual_leave_dates,
    ddmmyyyy,
    dec,
    full_name,
    join_date_of,
    money,
    natural_key,
    advance_balances_before,
    parse_iso_date,
    slip_key,
    slips_for,
)
from .payroll_insights_views import ScopeError, parse_scope, scope_payrolls
from .salary_split import FIRST_PORTION, SECOND_PORTION, breakup_of, from_paise, halves, rescale, to_paise
from .view_common import error_response as _error

NO_DEPARTMENT = "No department"


# ─────────────────────────────────────────────────────────────────────────────
#  Columns
# ─────────────────────────────────────────────────────────────────────────────


def _column(key, label, fmt, weight, group, *, align=None, total=None, sub=None) -> dict:
    """One StatementColumn. Numbers sit to the right and add up; text sits to the left and does not (sno is centred)."""
    numeric = fmt in ("days", "money", "int") and key != "sno"
    return {
        "key": key,
        "label": label,
        "sub": sub,
        "align": align or ("right" if numeric else "left"),
        "format": fmt,
        "weight": weight,
        "total": numeric if total is None else total,
        "group": group,
    }


def staff_columns() -> list[dict]:
    """The printed statement's columns, in its order."""
    return [
        _column("sno", "SNO", "int", 0.6, "identity", align="center"),
        _column("code", "ID NO", "text", 1.1, "identity"),
        _column("name", "Name", "text", 3, "identity"),
        _column("designation", "Designation", "text", 2.2, "identity"),
        _column("basic", "Basic salary", "money", 1.3, "earnings"),
        _column("total", "Total", "money", 1.3, "earnings"),
        _column("present", "Present", "days", 1, "attendance"),
        _column("cl", "CL", "days", 1, "attendance"),
        _column("lop", "LOP", "days", 1, "attendance"),
        _column("hd", "HD", "days", 1, "attendance"),
        _column("totalDays", "Total Days", "days", 1, "attendance"),
        _column("petrol", "PTRL", "money", 1.1, "earnings"),
        _column("othersAllow", "Others Allow", "money", 1.2, "earnings"),
        _column("eSalary", "E salary", "money", 1.3, "earnings"),
        _column("tAdvance", "T.Advance", "money", 1.2, "deductions"),
        _column("advance", "Advance", "money", 1.1, "deductions"),
        _column("esi", "ESI", "money", 1, "deductions"),
        _column("pf", "PF", "money", 1, "deductions"),
        _column("tds", "TDS", "money", 1, "deductions"),
        _column("others", "Others", "money", 1.1, "deductions"),
        _column("lopAmount", "Lop& PSAmt", "money", 1.2, "deductions", sub="information"),
        _column("totalDeduction", "Total Deduction", "money", 1.3, "deductions"),
        _column("net", "NET", "money", 1.3, "result"),
        _column("remarks", "Remarks", "text", 2, "result"),
    ]


def production_columns() -> list[dict]:
    return [
        _column("sno", "SNO", "int", 0.6, "identity", align="center"),
        _column("code", "ID NO", "text", 1.1, "identity"),
        _column("name", "Name", "text", 3, "identity"),
        _column("designation", "Designation", "text", 2.2, "identity"),
        _column("rate", "Rate / shift", "money", 1.1, "earnings", total=False),
        _column("worked", "Days worked", "days", 1, "attendance"),
        _column("absent", "Absent", "days", 1, "attendance"),
        _column("late", "Late", "int", 0.8, "attendance"),
        _column("shifts", "Shifts", "days", 1, "attendance"),
        _column("eSalary", "E salary", "money", 1.3, "earnings"),
        _column("tAdvance", "T.Advance", "money", 1.2, "deductions"),
        _column("advance", "Advance", "money", 1.1, "deductions"),
        _column("esi", "ESI / EF", "money", 1, "deductions"),
        _column("pf", "PF", "money", 1, "deductions"),
        _column("tds", "TDS", "money", 1, "deductions"),
        _column("others", "Others", "money", 1.1, "deductions"),
        _column("totalDeduction", "Total Deduction", "money", 1.3, "deductions"),
        _column("net", "NET", "money", 1.3, "result"),
        _column("remarks", "Remarks", "text", 2, "result"),
    ]


# ─────────────────────────────────────────────────────────────────────────────
#  One row
# ─────────────────────────────────────────────────────────────────────────────


def _remarks(emp, start, end) -> str:
    """Short and only what the profile says: JOINED dd-mm when the join date is inside the period, LEFT when the employee
    is no longer active."""
    parts = []
    joined = join_date_of(emp)
    if joined is not None and start <= joined <= end:
        parts.append(f"JOINED {joined.day:02d}-{joined.month:02d}")
    if emp.status != "active":
        parts.append("LEFT")
    return ", ".join(parts)


def _salary_parts(emp, total: Decimal) -> tuple[Decimal, Decimal, Decimal]:
    """(Basic, PTRL, Others Allow) of a salary: the first split portion, the Petrol allowance, and the rest of the second
    portion, so the three always add up to `total`. The recorded split is rescaled to the payroll's own salary when the
    salary has been changed since (an increment), keeping its proportions; with no split recorded Basic is 50%, PTRL 0 and
    the other 50% is Others Allow."""
    if total <= 0:
        return Decimal("0"), Decimal("0"), Decimal("0")
    parts = breakup_of(emp)
    if parts is None:
        first, second = halves(total)
        return from_paise(first), Decimal("0"), from_paise(second)
    if sum(to_paise(v) for v in parts.values()) != to_paise(total):
        parts = rescale(parts, total)
    basic = sum((parts[c] for c in FIRST_PORTION), Decimal("0"))
    second = sum((parts[c] for c in SECOND_PORTION), Decimal("0"))
    petrol = parts["petrol_allowance"]
    return basic, petrol, second - petrol


def _staff_values(payroll: Payroll, slip, bd, cl_dates: set, balance: Decimal, start, end) -> dict:
    emp = payroll.employee
    total = dec(payroll.base_salary)
    working = Decimal(int(payroll.total_working_days or 0))
    gross, ot, bonus = dec(payroll.gross_salary), dec(payroll.ot_amount), dec(payroll.bonus)
    if bd is not None:
        summary = bd.get("summary") or {}
        paid_days = dec(summary["effectivePaidDays"]) if "effectivePaidDays" in summary else dec(payroll.present_days)
        half_days = dec(summary.get("halfShiftDays"))
        cl = sum(
            (
                dec(d.get("shiftsCompleted"))
                for d in bd.get("days") or []
                if d.get("status") == "present" and parse_iso_date(d.get("date")) in cl_dates
            ),
            Decimal("0"),
        )
    else:
        paid_days, half_days, cl = dec(payroll.present_days), Decimal("0"), Decimal("0")
    cl = min(cl, paid_days)
    basic, petrol, others_allow = _salary_parts(emp, total)

    pf = dec(slip.pf_deduction) if slip is not None else Decimal("0")
    esi = dec(slip.esi_deduction) if slip is not None else Decimal("0")
    advance = dec(slip.advance_deduction) if slip is not None else Decimal("0")
    tds = dec(payroll.tds_deduction)
    total_deduction = dec(payroll.deductions)
    return {
        "code": emp.employee_code,
        "name": full_name(emp),
        "designation": emp.designation.title if emp.designation_id else "",
        "basic": money(basic),
        "total": money(total),
        "present": money(paid_days - cl),
        "cl": money(cl),
        "lop": money(max(Decimal("0"), working - paid_days)),
        "hd": money(half_days),
        "totalDays": money(paid_days),
        "petrol": money(petrol),
        "othersAllow": money(others_allow),
        "eSalary": money(gross + ot + bonus),
        "tAdvance": money(balance),
        "advance": money(advance),
        "esi": money(esi),
        "pf": money(pf),
        "tds": money(tds),
        "others": money(total_deduction - pf - esi - tds - advance),
        "lopAmount": money(max(Decimal("0"), total - gross)),
        "totalDeduction": money(total_deduction),
        "net": money(payroll.final_salary),
        "remarks": _remarks(emp, start, end),
    }


def _production_values(payroll: Payroll, slip, bd, balance: Decimal, start, end) -> dict:
    emp = payroll.employee
    gross, bonus = dec(payroll.gross_salary), dec(payroll.bonus)
    pf = dec(slip.pf_deduction) if slip is not None else Decimal("0")
    esi = dec(slip.esi_deduction) if slip is not None else Decimal("0")
    advance = dec(slip.advance_deduction) if slip is not None else Decimal("0")
    tds = dec(payroll.tds_deduction)
    total_deduction = dec(payroll.deductions)
    if bd is not None:
        summary = bd.get("summary") or {}
        rate = dec(bd["salaryPerShift"]) if "salaryPerShift" in bd else dec(emp.salary_per_shift)
        worked = money(summary.get("daysWorked")) if "daysWorked" in summary else None
        absent = money(summary.get("daysAbsent")) if "daysAbsent" in summary else None
        late = sum(1 for d in bd.get("days") or [] if d.get("isLate"))
        shifts = money(summary["totalShifts"]) if "totalShifts" in summary else money(payroll.present_days)
    else:
        rate = dec(emp.salary_per_shift)
        worked, absent, late, shifts = None, money(payroll.absent_days), None, money(payroll.present_days)
    return {
        "code": emp.employee_code,
        "name": full_name(emp),
        "designation": emp.designation.title if emp.designation_id else "",
        "rate": money(rate),
        "worked": worked,
        "absent": absent,
        "late": late,
        "shifts": shifts,
        "eSalary": money(gross + bonus),
        "tAdvance": money(balance),
        "advance": money(advance),
        "esi": money(esi),
        "pf": money(pf),
        "tds": money(tds),
        "others": money(total_deduction - pf - esi - tds - advance),
        "totalDeduction": money(total_deduction),
        "net": money(payroll.final_salary),
        "remarks": _remarks(emp, start, end),
    }


# ─────────────────────────────────────────────────────────────────────────────
#  Groups and totals
# ─────────────────────────────────────────────────────────────────────────────


def _sum_row(rows: list[dict], columns: list[dict], label: str) -> dict:
    """A subtotal / total line: the columns that add up, summed over `rows` (None cells count as nothing)."""
    values: dict = {}
    for column in columns:
        if column["total"]:
            values[column["key"]] = money(sum((dec(r["values"].get(column["key"])) for r in rows), Decimal("0")))
        else:
            values[column["key"]] = None
    values["name"] = label
    return {"payrollId": None, "employeeId": None, "sno": None, "status": None, "values": values}


def _groups(payrolls: list[Payroll], rows: dict[int, dict], columns: list[dict]) -> list[dict]:
    """The rows under their department bands, bands in name order (employees with none last) and rows in code order, with
    the running SNO and a subtotal per band. Two departments of different branches that share a name get the branch added
    to their band, so they are not mistaken for one."""
    labels: dict[str, set] = {}
    for p in payrolls:
        emp = p.employee
        name = emp.department.name if emp.department_id else NO_DEPARTMENT
        labels.setdefault(name, set()).add(emp.department_id)
    bands: dict[tuple, dict] = {}
    for p in payrolls:
        emp = p.employee
        name = emp.department.name if emp.department_id else NO_DEPARTMENT
        label = name
        if len(labels[name]) > 1:
            label = f"{name} ({emp.branch.name if emp.branch_id else 'No branch'})"
        key = (emp.department_id,)
        band = bands.setdefault(
            key, {"key": str(emp.department_id) if emp.department_id else "none", "label": label, "items": []}
        )
        band["items"].append(p)
    ordered = sorted(bands.values(), key=lambda b: (b["label"].startswith(NO_DEPARTMENT), b["label"].lower()))
    out = []
    sno = 0
    for band in ordered:
        group_rows = []
        for p in sorted(band["items"], key=lambda p: (natural_key(p.employee.employee_code), p.id)):
            sno += 1
            values = {**rows[p.id], "sno": sno}
            group_rows.append(
                {"payrollId": p.id, "employeeId": p.employee_id, "sno": sno, "status": p.status, "values": values}
            )
        out.append(
            {
                "key": band["key"],
                "label": band["label"],
                "rows": group_rows,
                "subtotal": _sum_row(group_rows, columns, "Sub total"),
            }
        )
    return out


# ─────────────────────────────────────────────────────────────────────────────
#  The statement
# ─────────────────────────────────────────────────────────────────────────────


def _staff_notes() -> list[str]:
    return [
        "Basic is the first salary-split portion (Basic + DA + Retaining Allowance); with no split recorded it is 50% of the "
        "salary. PTRL is the Petrol allowance and Others Allow the rest of the second portion, so Basic + PTRL + Others "
        "Allow = Total.",
        "Total is the monthly salary. E salary is the salary earned for the days paid (Total x Total Days / working days) "
        "plus any overtime pay and HR bonus.",
        "Present is the days paid as worked (a half day counts 0.5; a working day HR marked as a paid holiday counts 1), "
        "without Casual Leave; CL is the approved Casual Leave days; Total Days = Present + CL; "
        "LOP = working days - Total Days; HD is the number of half-shift days.",
        "T.Advance is the advance balance before this month's recovery; Advance is what was recovered this month.",
        "ESI and PF are deducted only from Co Emp employees (Employees > Co Emp), by the rules of Settings > PF & ESI, from "
        "Basic + DA + Retaining Allowance. TDS is deducted only from employees on the TDS list: the TDS percentage set for "
        "them of the pay earned (it is 0 for everybody else).",
        "Others is the late deduction plus any deduction HR added; Total Deduction = ESI + PF + TDS + Advance + Others; "
        "NET = E salary - Total Deduction.",
        "Lop& PSAmt = Total - E salary: the pay lost to LOP. It is shown for information and is not part of Total Deduction.",
    ]


def _production_notes() -> list[str]:
    return [
        "Rate / shift is the worker's salary per shift; Shifts is the total shifts earned in the period (a day earns 0.25 to "
        "1.5); Days worked and Absent count the days of the period; Late counts the days marked late.",
        "E salary is the pay for the shifts earned (Shifts x Rate / shift) plus any HR bonus.",
        "T.Advance is the advance balance before this period's recovery; Advance is what was recovered in this period.",
        "ESI / EF is the ESI deduction. ESI and PF are deducted only from Co Emp workers (Employees > Co Emp), by the rules "
        "of Settings > PF & ESI, from the first 50% of the period pay. TDS is deducted only from workers on the TDS list: "
        "the TDS percentage set for them of the period pay (it is 0 for everybody else).",
        "Others is the late deduction plus any deduction HR added; Total Deduction = ESI / EF + PF + TDS + Advance + "
        "Others; NET = E salary - Total Deduction.",
    ]


def _branch_label(request: Request, scope) -> str | None:
    """The branch's name when the statement is about exactly one branch (a branch-scoped login, or a branchId filter)."""
    branch_id = scope.branch_id if scope.branch_id is not None else get_branch_scope(request)
    if branch_id is None:
        return None
    branch = Branch.objects.filter(pk=branch_id).values("name", "code").first()
    return (branch["name"] or branch["code"]) if branch else None


def _statement_response(request: Request, kind: str) -> Response:
    try:
        scope = parse_scope(request, kind)
    except ScopeError as exc:
        return _error(str(exc), 400)
    staff = kind == KIND_STAFF
    info = scope.period_info()
    start, end = parse_iso_date(info["start"]), parse_iso_date(info["end"])
    payrolls = list(scope_payrolls(request, scope))
    employee_ids = [p.employee_id for p in payrolls]
    slips = slips_for(payrolls)
    balances = advance_balances_before(employee_ids, info["year"], info["month"])
    cl = casual_leave_dates(employee_ids, scope.year, scope.month) if staff else {}
    columns = staff_columns() if staff else production_columns()

    rows: dict[int, dict] = {}
    no_slip = mismatched = 0
    for p in payrolls:
        slip = slips.get(slip_key(p))
        bd = breakdown_of(slip)
        no_slip += bd is None
        if staff:
            values = _staff_values(
                p, slip, bd, cl.get(p.employee_id, set()), balances.get(p.employee_id, Decimal("0")), start, end
            )
        else:
            values = _production_values(p, slip, bd, balances.get(p.employee_id, Decimal("0")), start, end)
        # NET is the saved payroll figure; it equals E salary - Total Deduction unless the payroll was edited after
        # overtime was added (the saved net leaves overtime out), which the notes then say.
        if abs(dec(values["net"]) - (dec(values["eSalary"]) - dec(values["totalDeduction"]))) > Decimal("0.005"):
            mismatched += 1
        rows[p.id] = values

    groups = _groups(payrolls, rows, columns)
    every_row = [row for group in groups for row in group["rows"]]
    company = SettingsResolver(()).base
    from_label, to_label = ddmmyyyy(start), ddmmyyyy(end)
    notes = _staff_notes() if staff else _production_notes()
    if no_slip:
        notes.append(
            f"{no_slip} payroll(s) have no stored day-by-day breakdown, so their day counts come from the payroll record "
            "instead."
        )
    if mismatched:
        notes.append(
            f"For {mismatched} payroll(s) NET is the saved payroll figure, which differs from E salary - Total Deduction: "
            "the payroll was edited after it was generated (the saved net leaves overtime pay out)."
        )
    heading = "Salary Statement" if staff else "Production Salary Statement"
    paid = sum(1 for p in payrolls if p.status == Payroll.STATUS_PAID)
    return Response(
        {
            "kind": kind,
            "company": {
                "name": company.company_name or company.slip_company_name or "UKTextiles",
                "branchLabel": _branch_label(request, scope),
            },
            "title": f"{heading} From {from_label} To {to_label}",
            "period": {**info, "fromLabel": from_label, "toLabel": to_label},
            "generatedAt": timezone.now().isoformat(),
            "columns": columns,
            "groups": groups,
            "total": _sum_row(every_row, columns, "Grand total"),
            "counts": {
                "employees": len(payrolls),
                "departments": len(groups),
                "paid": paid,
                "pending": len(payrolls) - paid,
            },
            "notes": notes,
        }
    )


@api_view(["GET"])
@require_hr
def staff_salary_statement(request: Request) -> Response:
    """GET /api/payroll/salary-statement?month=&year=[&departmentId=&branchId=&employeeId=&status=paid|pending]
    The printed Salary Statement of one month of staff payroll: department bands, one row per employee in code order, a
    subtotal per department and a grand total (see the module notes for how each column is worked out)."""
    return _statement_response(request, KIND_STAFF)


@api_view(["GET"])
@require_hr
def production_salary_statement(request: Request) -> Response:
    """GET /api/payroll/production/salary-statement?cycle=&periodStart=&periodEnd=[&departmentId=&branchId=&employeeId=&status=]
    The same statement for one period of one production pay cycle (shift columns instead of the staff day columns)."""
    return _statement_response(request, KIND_PRODUCTION)

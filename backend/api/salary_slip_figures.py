"""What a salary slip prints, taken from the Payroll Report (owner 2026-11-04: "both reports must display exactly the same
salary components and deduction details").

The slip PDF used to read only its own SalarySlip row: the engine's old Basic / HRA / Other Allowances split, fixed 0 lines
(DA, CA, EA, PTRL, T.Advance, LOP) and its stored net, which missed anything HR changed on the payroll afterwards (a bonus,
a deduction). The Payroll Report (the Salary Statement, ``payroll_statement_views.statement_rows``) reads the payroll AND
the slip. This module builds the slip's figures from that very same row, so the two can never differ:

    Earnings    Basic salary / PTRL / Others Allow (the salary split, they add up to the monthly Total), less the
                Lop & PS amount (pay not earned), plus OT and Bonus = E salary
    Deductions  Advance, ESI, PF, TDS, Others = Total Deduction
    NET         the payroll's saved net (the statement's NET)
    Days        Present, CL, LOP, HD, Total Days (staff); days worked, absent, late, shifts (production)

Only what applies is listed: a zero allowance, a deduction the employee is not covered by (ESI / PF outside Co Emp, TDS
outside the TDS list), and the statement's information-only columns are left out. A slip with no payroll (the Settings
preview) falls back to its own stored figures, with the same no-zero-lines rule. Read-only.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from decimal import Decimal

ZERO = Decimal("0")


@dataclass
class SlipFigures:
    earnings: list[tuple[str, Decimal]]  # the lines; the total is `earnings_total`
    earnings_total: Decimal
    deductions: list[tuple[str, Decimal]]
    deductions_total: Decimal
    net: Decimal
    days: list[tuple[str, str]] = field(default_factory=list)
    source: str = "statement"  # "statement" | "slip" (no payroll found)


def _dec(value) -> Decimal:
    try:
        return Decimal(str(value)) if value is not None else ZERO
    except Exception:
        return ZERO


def _days(value) -> str:
    """26.0 -> "26", 2.5 -> "2.5"."""
    d = _dec(value)
    return f"{d.normalize():f}" if d != d.to_integral_value() else str(int(d))


def _tds_label(slip, payroll) -> str:
    percent = getattr(payroll, "tds_percent", None) if payroll is not None else None
    if percent is None:
        percent = slip.tds_percent
    if percent is None:
        return "TDS"
    return f"TDS ({format(Decimal(str(percent)).normalize(), 'f')}%)"


def _deduction_lines(values: dict, slip, payroll) -> list[tuple[str, Decimal]]:
    lines = []
    for key, label in (("advance", "Advance"), ("esi", "ESI"), ("pf", "PF")):
        if _dec(values.get(key)):
            lines.append((label, _dec(values.get(key))))
    if _dec(values.get("tds")):
        lines.append((_tds_label(slip, payroll), _dec(values.get("tds"))))
    if _dec(values.get("others")):
        lines.append(("Others", _dec(values.get("others"))))
    return lines


def _slip_key(slip) -> tuple:
    if slip.period_start is not None:
        return (slip.employee_id, slip.period_start, slip.period_end)
    return (slip.employee_id, slip.month, slip.year, slip.week_number)


def _payrolls_for(slips) -> dict[tuple, object]:
    """{slip key: its payroll} for these slips, in one query (the latest payroll of a key wins, as payroll_of)."""
    from django.db.models import Q

    from .models import Payroll
    from .payroll_insights import slip_key

    saved = [s for s in slips if s.pk and s.employee_id]
    if not saved:
        return {}
    cond = Q()
    for month, year in {(s.month, s.year) for s in saved if s.period_start is None}:
        cond |= Q(month=month, year=year, period_start__isnull=True)
    starts = {s.period_start for s in saved if s.period_start is not None}
    if starts:
        cond |= Q(period_start__in=starts)
    out: dict[tuple, object] = {}
    for p in (
        Payroll.objects.select_related("employee__department", "employee__designation")
        .filter(employee_id__in={s.employee_id for s in saved})
        .filter(cond)
        .order_by("id")
    ):
        out[slip_key(p)] = p
    return out


def figures_for(slips) -> dict[int, SlipFigures]:
    """{id(slip): its figures} for many slips with a fixed number of queries: one for the payrolls, then one statement
    build per pay period (the bulk two-per-page PDF prints hundreds)."""
    from .payroll_insights import KIND_PRODUCTION, KIND_STAFF, kind_of, production_period, staff_period
    from .payroll_statement_views import statement_rows

    slips = list(slips)
    payrolls = _payrolls_for(slips)
    groups: dict[tuple, list] = {}
    for slip in slips:
        payroll = payrolls.get(_slip_key(slip)) if slip.pk else None
        kind = kind_of(payroll) if payroll is not None else None
        if payroll is None or kind not in (KIND_STAFF, KIND_PRODUCTION):
            continue
        period = (
            (kind, payroll.month, payroll.year)
            if kind == KIND_STAFF
            else (kind, payroll.period_start, payroll.period_end, getattr(payroll, "pay_cycle", None))
        )
        groups.setdefault(period, []).append(payroll)
    values: dict[int, dict] = {}
    for period, members in groups.items():
        kind = period[0]
        info = staff_period(period[1], period[2]) if kind == KIND_STAFF else production_period(*period[1:])
        rows, _no_slip, _mismatched = statement_rows(members, kind, info)
        values.update(rows)

    out: dict[int, SlipFigures] = {}
    for slip in slips:
        payroll = payrolls.get(_slip_key(slip)) if slip.pk else None
        v = values.get(payroll.id) if payroll is not None else None
        out[id(slip)] = _from_row(slip, payroll, v, kind_of(payroll)) if v is not None else _from_slip(slip)
    return out


def figures(slip) -> SlipFigures:
    """The slip's earnings, deductions, NET and days, exactly as the Payroll Report has them."""
    return figures_for([slip])[id(slip)]


def _from_row(slip, payroll, v: dict, kind: str) -> SlipFigures:
    """The slip's figures from its Salary Statement row `v`."""
    from .payroll_insights import KIND_STAFF

    ot, bonus = _dec(payroll.ot_amount), _dec(payroll.bonus)
    gross = _dec(payroll.gross_salary)

    earnings: list[tuple[str, Decimal]] = []
    if kind == KIND_STAFF:
        earnings.append(("Basic salary", _dec(v["basic"])))
        for key, label in (("petrol", "PTRL"), ("othersAllow", "Others Allow")):
            if _dec(v.get(key)):
                earnings.append((label, _dec(v[key])))
        # the salary split adds up to the monthly Total; what the days paid did not earn comes off it
        adjustment = gross - _dec(v["total"])
        if adjustment < 0:
            lop = _dec(v.get("lop"))
            earnings.append((f"Lop & PS amount ({_days(lop)} LOP day{'' if lop == 1 else 's'})", adjustment))
        elif adjustment > 0:
            earnings.append(("Extra pay earned", adjustment))
        days = [
            ("Total Days (paid)", f"{_days(v['totalDays'])} of {int(payroll.total_working_days or 0)}"),
            ("Present", _days(v["present"])),
            ("CL", _days(v["cl"])),
            ("LOP", _days(v["lop"])),
            ("HD (half days)", _days(v["hd"])),
        ]
    else:
        shifts = _dec(v.get("shifts"))
        earnings.append((f"Pay for {_days(shifts)} shifts at {_dec(v.get('rate')):,.2f}", gross))
        days = [
            ("Days worked", _days(v["worked"]) if v.get("worked") is not None else "-"),
            ("Absent", _days(v["absent"]) if v.get("absent") is not None else "-"),
            ("Late", str(v["late"]) if v.get("late") is not None else "-"),
            ("Shifts", _days(shifts)),
        ]
    if ot:
        earnings.append(("OT Wages", ot))
    if bonus:
        earnings.append(("Bonus", bonus))

    return SlipFigures(
        earnings=earnings,
        earnings_total=_dec(v["eSalary"]),
        deductions=_deduction_lines(v, slip, payroll),
        deductions_total=_dec(v["totalDeduction"]),
        net=_dec(v["net"]),
        days=days,
    )


def _from_slip(slip) -> SlipFigures:
    """A slip with no payroll behind it (the Settings preview, a legacy row): its own stored figures, zero lines left out."""
    earnings = [("Basic salary", _dec(slip.basic))]
    for label, value in (
        ("HRA", slip.hra),
        ("Other Allowances", _dec(slip.allowances) + _dec(slip.incentives)),
        ("OT Wages", slip.ot_amount),
        ("Bonus", slip.bonuses),
    ):
        if _dec(value):
            earnings.append((label, _dec(value)))
    values = {
        "advance": slip.advance_deduction,
        "esi": slip.esi_deduction,
        "pf": slip.pf_deduction,
        "tds": slip.tds_deduction,
        "others": slip.other_deductions,
    }
    total_earnings = _dec(slip.gross_salary) + _dec(slip.bonuses)  # an older slip's gross already holds its OT
    return SlipFigures(
        earnings=earnings,
        earnings_total=total_earnings,
        deductions=_deduction_lines(values, slip, None),
        deductions_total=_dec(slip.total_deductions),
        net=_dec(slip.net_salary),
        days=[("Days paid", _days(slip.present_days))],
        source="slip",
    )


def leave_lines_for(slips) -> dict[int, list[list[str]]]:
    """{id(slip): the leave its employee has for the slip's year} with a fixed number of queries: the yearly Casual Leave
    balance (12 a year, staff) and any other leave type allotted for the year, as [name, total, used, left]; nothing when
    none applies (no made-up 0 lines)."""
    from . import cl_balance
    from .models import LeaveBalance

    slips = list(slips)
    out: dict[int, list[list[str]]] = {id(s): [] for s in slips}
    by_year: dict[int, set[int]] = {}
    for s in slips:
        emp = s.employee
        if getattr(emp, "pk", None):
            by_year.setdefault(s.year, set()).add(emp.pk)
    cut_over = cl_balance.since() if by_year else None
    cl: dict[tuple[int, int], dict] = {}
    other: dict[tuple[int, int], list] = {}
    for year, ids in by_year.items():
        staff = [s.employee.pk for s in slips if s.year == year and s.employee.employment_type == "staff"]
        for emp_id, block in cl_balance.balances(set(staff), year, cut_over).items():
            cl[(emp_id, year)] = block
        for lb in LeaveBalance.objects.select_related("leave_type").filter(employee_id__in=ids, year=year):
            other.setdefault((lb.employee_id, year), []).append(lb)
    for s in slips:
        emp = s.employee
        if not getattr(emp, "pk", None):
            continue
        rows = out[id(s)]
        block = cl.get((emp.pk, s.year))
        if block and block["tracked"]:
            total, left = _dec(block["total"]), _dec(block["remaining"])
            rows.append(["Casual Leave", _days(total), _days(total - left), _days(left)])
        for lb in other.get((emp.pk, s.year), []):
            name = lb.leave_type.name if lb.leave_type_id else "Leave"
            if "casual" in name.lower():
                continue  # Casual Leave is the yearly balance above
            rows.append([name, _days(lb.allocated), _days(lb.used), _days(lb.remaining)])
    return out


def leave_lines(emp, year: int) -> list[list[str]]:
    """The leave one slip lists (see leave_lines_for)."""
    from types import SimpleNamespace

    probe = SimpleNamespace(employee=emp, year=year)
    return leave_lines_for([probe])[id(probe)]

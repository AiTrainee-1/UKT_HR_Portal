"""Helpers of the Salary category (category id ``payroll``, label "Salary") of the 2026-11-19 Report Center layout.

Nothing in this module registers a report: ``rc_salary`` (the payroll-based reports), ``rc_salary_gained`` (gained and
expected salary from attendance) and ``rc_salary_departments`` (department headcount and employee lists) share it.

Money always comes from the generated Payroll rows through the Payroll pages' own builder
(``payroll_statement_views.statement_rows``), never from a SalarySlip alone, so a figure here equals the Payroll page's.
Which payrolls a list holds follows the payroll pages' workflow rules (``payroll_month_workflow`` for staff,
``production_period_workflow`` for production), and "Paid" is ``Payroll.payment_status`` (Mark as Paid / paid
separately), never ``Payroll.status`` (that is HR's "Cleared" check).
"""

from __future__ import annotations

import re
from collections import defaultdict
from datetime import date, timedelta
from decimal import Decimal

from django.db.models import Q

from api.models import Employee, Payroll
from api.payroll_insights import (
    KIND_PRODUCTION,
    KIND_STAFF,
    breakdown_of,
    natural_key,
    production_period,
    slip_key,
    staff_period,
)
from api.payroll_month_workflow import MAIN_PAYROLL_Q, ON_STATEMENT_Q, SKIPPED_Q
from api.payroll_statement_views import statement_rows
from api.production_cycles import CYCLE_LABELS
from api.production_period_workflow import MAIN_Q, PARKED_Q, period_label, row_cycle

from .. import filters as F
from ..access import permission_level
from ..formatting import MONTH_NAMES, full_name, month_bounds
from ..runner import KIND_SUBTOTAL
from .employees_master_base import department_labels, join_date_of
from .hr_reports_salary_statement import unit_of

CATEGORY = "payroll"  # shown as "Salary" (types.CATEGORIES)

STAFF, PRODUCTION = KIND_STAFF, KIND_PRODUCTION
KIND_LABEL = {STAFF: "Staff", PRODUCTION: "Production"}
NO_DEPARTMENT = "No department"

# Payroll money: staff rows are Payroll's, production rows Production Payroll's
PAYROLL_MODULES = {STAFF: ("payroll",), PRODUCTION: ("production_payroll",)}
# Fixed salary / rates (the employee's salary structure): the Salary module, or the payroll that pays it
SALARY_MODULES = {STAFF: ("salary", "payroll"), PRODUCTION: ("salary", "production_payroll")}

ZERO = Decimal("0")
CENT = Decimal("0.01")


def d2(value) -> Decimal:
    return Decimal(str(value or 0)).quantize(CENT)


def money(value) -> float | None:
    return None if value is None else float(d2(value))


# ── who may see which kind ───────────────────────────────────────────────────


def may_view(ctx, modules: tuple[str, ...]) -> bool:
    return any(permission_level(ctx.request, m) in ("view", "edit") for m in modules)


def visible_kinds(ctx, module_map: dict[str, tuple[str, ...]]) -> tuple[list[str], list[str]]:
    """(the employee kinds this run lists, notes). A kind is listed when the role may view one of its modules
    (``module_map``) and the Employee type filter (when the report has one) asks for it. A role that may see only one
    kind gets only that kind, and a note says so; asking for the other kind lists nobody instead of quietly switching."""
    wanted = ctx.params.get("employment_type")
    allowed = [k for k in (STAFF, PRODUCTION) if may_view(ctx, module_map[k])]
    notes: list[str] = []
    if len(allowed) == 1:
        other = PRODUCTION if allowed[0] == STAFF else STAFF
        notes.append(
            f"Your role can see {KIND_LABEL[allowed[0]].lower()} figures only, so {KIND_LABEL[other].lower()} "
            "employees are not listed."
        )
    kinds = [k for k in allowed if wanted in (None, k)]
    return kinds, notes


# ── join dates ───────────────────────────────────────────────────────────────

# '01-01-45640': an Excel serial number stored in the year's place by an old spreadsheet import (all production rows on
# the dev data). Decoded as Excel does (day 1 = 1900-01-01, with its 1900 leap-year bug: serial 0 = 1899-12-30).
_SERIAL = re.compile(r"^\s*\d{1,2}[-/.]\d{1,2}[-/.](\d{5})\s*$")
_EXCEL_EPOCH = date(1899, 12, 30)
JOIN_OK, JOIN_SERIAL, JOIN_MISSING, JOIN_UNREADABLE = "ok", "serial", "missing", "unreadable"


def join_date(emp) -> tuple[date | None, str]:
    """(join date, state): the shared reader (employees_master_base.join_date_of: ISO / dd-mm-yyyy, years 1950-2100),
    plus the 'dd-mm-<Excel serial>' text of the old import decoded (state "serial"). Never drops an employee: an
    unreadable date is (None, "unreadable") and the caller treats the person as employed."""
    joined, state = join_date_of(emp)
    if joined is not None:
        return joined, JOIN_OK
    match = _SERIAL.match(emp.join_date or "")
    if match and 20_000 <= int(match.group(1)) <= 80_000:  # 1954-10-03 .. 2119-01-10
        return _EXCEL_EPOCH + timedelta(days=int(match.group(1))), JOIN_SERIAL
    return None, state


def join_notes(states: dict[str, int]) -> list[str]:
    notes = []
    if states.get(JOIN_SERIAL):
        notes.append(
            f"{states[JOIN_SERIAL]} join date(s) are stored as a spreadsheet serial number (for example '01-01-45640', "
            "left by an old import); they are read as the date the number stands for (45640 = 14-Dec-2024)."
        )
    if states.get(JOIN_UNREADABLE):
        notes.append(f"{states[JOIN_UNREADABLE]} join date(s) cannot be read; those employees are counted as employed.")
    return notes


# ── labels ───────────────────────────────────────────────────────────────────


def department_map(employees) -> dict[int | None, str]:
    """{department_id: label} for these employees (the branch is added only where two departments share a name)."""
    depts = {e.department.id: e.department for e in employees if e.department_id}
    out: dict[int | None, str] = dict(department_labels(depts.values()))
    out[None] = NO_DEPARTMENT
    return out


def unit_text(emp) -> str:
    return unit_of(emp)[1]


def month_label(year: int, month: int) -> str:
    return f"{MONTH_NAMES[month - 1]} {year}"


def code_sort(code) -> tuple:
    return natural_key(code or "")


def dept_sort(label: str) -> tuple:
    return (label == NO_DEPARTMENT, label.lower())


# ── payroll lists ────────────────────────────────────────────────────────────

LIST_STATEMENT, LIST_MAIN, LIST_SKIPPED = "statement", "main", "skipped"
LIST_OPTIONS = (
    (LIST_STATEMENT, "Salary statement (payroll + held salaries)"),
    (LIST_MAIN, "Main payroll only (bank file)"),
    (LIST_SKIPPED, "Skipped only (held, new joiners, paid separately)"),
)
LIST_WORDS = {
    LIST_STATEMENT: "the month's Salary Statement list: the main payroll plus the salaries on hold (Remarks HOLD); new "
    "joiners not yet added to the payroll are left out (staff, payroll_month_workflow) and so are production workers "
    "waiting in a period's New Joiners (production_period_workflow)",
    LIST_MAIN: "the main payroll only (what the Records, their totals and the bank file hold): no salary on hold, no "
    "new joiner not yet added, nobody released and paid separately",
    LIST_SKIPPED: "the skipped employees only: staff on hold (HOLD), new joiners not yet added (NEW JOINER) and those "
    "released and paid separately (PAID SEPARATELY); production workers waiting in a period's New Joiners",
}


def payroll_list_filter(default: str = LIST_STATEMENT):
    return F.select(
        "payrollList",
        "Payroll list",
        LIST_OPTIONS,
        default=default,
        required=True,
        help="Which payrolls of the month: the Salary Statement's (default), the main payroll only, or the skipped ones.",
    )


def list_q(kind: str, which: str) -> Q:
    if kind == STAFF:
        return {LIST_STATEMENT: ON_STATEMENT_Q, LIST_MAIN: MAIN_PAYROLL_Q, LIST_SKIPPED: SKIPPED_Q}[which]
    return PARKED_Q if which == LIST_SKIPPED else MAIN_Q


PAY_PAID, PAY_NOT_PAID, PAY_CLEARED = "paid", "not_paid", "cleared"
PAYMENT_OPTIONS = (
    (PAY_PAID, "Paid"),
    (PAY_NOT_PAID, "Not paid yet"),
    (PAY_CLEARED, "Cleared, not paid yet"),
)
PAYMENT_WORDS = (
    "Payment: Paid = paid (Mark as Paid, or released and paid separately: Payroll.payment_status); Cleared = HR has "
    "verified the salary (Mark as Cleared) but it is not paid yet; Pending = neither."
)


def payment_filter():
    return F.select("paymentStatus", "Payment status", PAYMENT_OPTIONS, placeholder="Paid and not paid")


def payment_q(value: str | None) -> Q:
    if value == PAY_PAID:
        return Q(payment_status=Payroll.PAYMENT_PAID)
    if value == PAY_NOT_PAID:
        return ~Q(payment_status=Payroll.PAYMENT_PAID)
    if value == PAY_CLEARED:
        return ~Q(payment_status=Payroll.PAYMENT_PAID) & Q(status=Payroll.STATUS_PAID)
    return Q()


def payment_label(p: Payroll) -> str:
    if p.payment_status == Payroll.PAYMENT_PAID:
        return "Paid"
    return "Cleared" if p.status == Payroll.STATUS_PAID else "Pending"


PAYROLL_RELATIONS = (
    "employee",
    "employee__department",
    "employee__designation",
    "employee__branch",
)
EMPLOYEE_SECRETS = ("employee__photo_url", "employee__password_hash")


def payroll_qs():
    """Payroll rows with their employee (never the photo or the password hash), department, designation and branch."""
    return Payroll.objects.select_related(*PAYROLL_RELATIONS).defer(*EMPLOYEE_SECRETS)


def kind_q(kind: str) -> Q:
    """Staff month rows / production period rows (legacy week-numbered rows are neither)."""
    if kind == STAFF:
        return Q(salary_mode=Payroll.SALARY_MODE_MONTHLY, week_number__isnull=True, period_start__isnull=True)
    return Q(salary_mode=Payroll.SALARY_MODE_SHIFT, period_start__isnull=False)


def kind_of_row(p: Payroll) -> str:
    return PRODUCTION if p.period_start is not None else STAFF


def month_payrolls(ctx, year: int, month: int, kinds: list[str], which: str, payment: str | None) -> list[Payroll]:
    """The month's payrolls of these kinds, in the report's scope, ACTIVE employees only (as every payroll page lists
    them): staff = the month's monthly payroll; production = every pay period that ENDS in the month (payroll
    attributes a period to the month it ends in). One query."""
    if not kinds:
        return []
    cond = Q()
    for kind in kinds:
        cond |= kind_q(kind) & list_q(kind, which)
    qs = (
        payroll_qs()
        .filter(cond, month=month, year=year, employee__status="active")
        .filter(ctx.emp_q("employee__"))
        .filter(payment_q(payment))
    )
    return list(qs.order_by("employee__employee_code", "period_start", "id"))


def inactive_count(ctx, year: int, month: int, kinds: list[str]) -> int:
    """Generated payrolls of the month in the report's scope whose employee is no longer active (left out)."""
    if not kinds:
        return 0
    cond = Q()
    for kind in kinds:
        cond |= kind_q(kind)
    return (
        Payroll.objects.filter(cond, month=month, year=year)
        .exclude(employee__status="active")
        .filter(ctx.emp_q("employee__"))
        .count()
    )


def statement_values(payrolls: list[Payroll]) -> tuple[dict[int, dict], int, int]:
    """({payroll id: the Payroll page's statement values}, payrolls with no stored breakdown, payrolls whose NET was
    edited) for a mix of staff months and production periods: the builder is called once per month / per pay period,
    as the Salary Statement endpoints call it."""
    groups: dict[tuple, list[Payroll]] = defaultdict(list)
    for p in payrolls:
        if p.period_start is None:
            groups[(STAFF, p.month, p.year)].append(p)
        else:
            groups[(PRODUCTION, p.period_start, p.period_end, row_cycle(p))].append(p)
    values: dict[int, dict] = {}
    no_slip = mismatched = 0
    for key, rows in groups.items():
        if key[0] == STAFF:
            info = staff_period(key[1], key[2])
        else:
            info = production_period(key[1], key[2], key[3])
        got, missing, edited = statement_rows(rows, key[0], info)
        values.update(got)
        no_slip += missing
        mismatched += edited
    return values, no_slip, mismatched


def pay_period_text(p: Payroll) -> str:
    if p.period_start is None:
        return month_label(p.year, p.month)
    return period_label(row_cycle(p), p.period_start, p.period_end)


def cycle_text(p: Payroll) -> str | None:
    if p.period_start is None:
        return None
    return CYCLE_LABELS.get(row_cycle(p) or "", "No pay cycle")


def overlapping_ids(payrolls: list[Payroll]) -> set[int]:
    """Production payrolls of one worker whose pay periods share a day (an older draft a later run should replace)."""
    by_emp: dict[int, list[Payroll]] = defaultdict(list)
    for p in payrolls:
        if p.period_start is not None:
            by_emp[p.employee_id].append(p)
    out: set[int] = set()
    for rows in by_emp.values():
        rows.sort(key=lambda p: (p.period_start, p.period_end))
        for a, b in zip(rows, rows[1:]):
            if b.period_start <= a.period_end:
                out.update((a.id, b.id))
    return out


# ── employer PF / ESI ────────────────────────────────────────────────────────


def employer_contributions(slip) -> tuple[Decimal, Decimal]:
    """(employer PF, employer ESI) of one payslip by the Settings > PF & ESI rule payroll matched: the rule's percentage
    of the same PF / ESI wages the employee's share was taken from (the slip's breakdown, deductions.statutory). The rules
    carry one percentage each, which the app applies to the employer's share too (pf_esi.employer_contributions, the
    Compensation page's employer cost). Not rounded up (only the employee's ESI is). Zero without a Co Emp rule."""
    bd = breakdown_of(slip)
    stat = ((bd or {}).get("deductions") or {}).get("statutory")
    if not isinstance(stat, dict):
        return ZERO, ZERO
    wages = Decimal(str(stat.get("pfWages") or 0))
    out = []
    for key in ("pfRule", "esiRule"):
        rule = stat.get(key)
        rate = Decimal(str(rule.get("ratePercent") or 0)) if isinstance(rule, dict) else ZERO
        out.append(d2(wages * rate / Decimal("100")))
    return out[0], out[1]


def slip_of(slips: dict, p: Payroll):
    return slips.get(slip_key(p))


# ── rows ─────────────────────────────────────────────────────────────────────


def group_subtotals(
    rows: list[dict],
    group_key: str,
    sum_keys: tuple[str, ...],
    *,
    label_key: str,
    label=lambda g, n: f"{g} total",
    count_key: str | None = None,
    min_rows: int = 1,
) -> list[dict]:
    """A ``_kind: subtotal`` line after each run of rows sharing ``row[group_key]`` (rows already ordered by it), for runs
    of at least ``min_rows`` rows. ``label(group, rows in it)`` names the line; ``count_key`` (optional) gets the number
    of rows. The runner's totals row skips subtotal lines, so nothing is counted twice."""
    out: list[dict] = []
    run: list[dict] = []

    def flush():
        if not run:
            return
        out.extend(run)
        if len(run) >= min_rows:
            line = {label_key: label(run[0][group_key], len(run)), "_kind": KIND_SUBTOTAL}
            for k in sum_keys:
                vals = [r.get(k) for r in run if isinstance(r.get(k), (int, float)) and not isinstance(r.get(k), bool)]
                line[k] = round(sum(vals), 2) if vals else None
            if count_key:
                line[count_key] = len(run)
            out.append(line)

    for r in rows:
        if run and r[group_key] != run[0][group_key]:
            flush()
            run = []
        run.append(r)
    flush()
    return out


def full(emp) -> str:
    return full_name(emp)


def employees_by_kind(ctx, kinds: list[str]):
    """ctx.employees() narrowed to these kinds (no query when there are none)."""
    if not kinds:
        return Employee.objects.none()
    return ctx.employees().filter(employment_type__in=kinds)


def read_settings(request):
    """The production pages' settings (user_settings.settings_for: the viewer's branch overlay), or None on an install
    whose settings row was never saved (a report must not create it)."""
    from api.models import PayrollSettings
    from api.user_settings import settings_for

    if not PayrollSettings.objects.filter(pk=1).exists():
        return None
    return settings_for(request)


def month_window(ctx) -> tuple[date, date]:
    year, month = ctx.period
    return month_bounds(year, month)

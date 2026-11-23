"""Who the regular payroll missed for a month, and why (the Missed Payroll page's lists).

STAFF (a calendar month; the Staff Payroll's own month):
    no_salary      active, no monthly salary on the profile ("salary not fixed"): set it first, then generate
    on_hold        the Staff Payroll worked them out but the salary is on Hold
    new_joiner     joined inside the month: parked in Skipped -> New joiners, or never worked out
    not_generated  active, salary set, but no payroll for the month (never generated, skipped by the engine ...)
    not_cleared    IN the month's payroll but not marked Cleared on Payroll Details: listed to check, never generated
                   here (that would pay them twice)
    inactive       inactive employees who punched in the month or have a payroll of it: their own tab, never mixed in
PRODUCTION (a calendar month; only days NO payroll pays yet, production_coverage.py):
    no_salary / new_joiner (parked in a period's New Joiners, or joined in the month) / not_generated (punched on days no
    payroll pays: no pay cycle, the period not generated ...) / not_cleared (a payroll of a period ending in the month not
    Cleared) / inactive.
An employee the regular payroll already pays for the month (and Cleared), or someone joining after the month, is not
listed. Someone with a Missed Payroll entry keeps the category it was generated for, whatever its status.
"""

from __future__ import annotations

from datetime import date

from django.db.models import Q

from .. import payroll_month_workflow as month_workflow
from .. import production_coverage as coverage
from ..compensation_shared import parse_join_date
from ..models import AttendanceDayRecord, AttendanceLog, Employee, MissedPayroll, Payroll
from ..production_cycles import CYCLE_LABELS
from ..unit_labels import unit_label
from . import engine

CATEGORIES = ("not_generated", "no_salary", "on_hold", "new_joiner", "not_cleared", "inactive")
CATEGORY_LABELS = {
    "not_generated": "Not generated",
    "no_salary": "Salary not fixed",
    "on_hold": "On hold",
    "new_joiner": "New joiners",
    "not_cleared": "Not cleared",
    "inactive": "Inactive",
}
# what may be generated here (not_cleared is in the month's payroll already; no_salary needs the salary first)
GENERATABLE = {"not_generated", "on_hold", "new_joiner", "inactive"}


def employees_qs(qs):
    return qs.select_related("department", "designation", "branch").defer("photo_url", "password_hash", "address")


def _name(emp) -> str:
    return f"{emp.first_name or ''} {emp.last_name or ''}".strip()


def _unit(emp) -> str:
    return (unit_label(emp.branch) or emp.branch.name) if emp.branch_id and emp.branch else ""


def _bank_issue(emp) -> str | None:
    if not (emp.bank_account or "").strip():
        return "No bank account number"
    if not (emp.bank_ifsc or "").strip():
        return "No IFSC code"
    return None


def _money(value) -> float | None:
    return float(value) if value is not None else None


def _iso(value):
    return value.isoformat() if value else None


def entry_json(entry: MissedPayroll | None) -> dict | None:
    if entry is None:
        return None
    figures = entry.figures or {}
    return {
        "id": entry.id,
        "status": entry.status,
        "category": entry.category,
        "gross": _money(entry.gross),
        "deductions": _money(entry.deductions),
        "net": _money(entry.net),
        "payRanges": figures.get("payRanges") or [],
        "payDays": coverage.day_count(engine.ranges_from_json(figures.get("payRanges"))),
        "replacesPayrollId": entry.replaces_id,
        "payrollId": entry.payroll_id,
        "generatedAt": _iso(entry.regenerated_at or entry.generated_at),
        "generatedBy": entry.generated_by or None,
        "clearedAt": _iso(entry.cleared_at),
        "clearedBy": entry.cleared_by or None,
        "doneAt": _iso(entry.done_at),
        "doneBy": entry.done_by or None,
        "paidAt": _iso(entry.paid_at),
        "paidBy": entry.paid_by or None,
        "paidOn": _iso(entry.paid_on),
    }


def _payroll_json(p: Payroll | None) -> dict | None:
    if p is None:
        return None
    return {
        "id": p.id,
        "net": _money(p.final_salary),
        "cleared": p.status == Payroll.STATUS_PAID,
        "onHold": bool(p.on_hold),
        "newJoinerParked": bool(p.new_joiner_parked),
        "paymentStatus": p.payment_status,
        "periodStart": _iso(p.period_start),
        "periodEnd": _iso(p.period_end),
        "payCycle": p.pay_cycle,
        "source": p.source or None,
    }


def _row(emp, kind: str, category: str, reason: str, detail: str | None, **extra) -> dict:
    joined = parse_join_date(emp.join_date)
    salary = emp.salary_amount if kind == engine.KIND_STAFF else emp.salary_per_shift
    return {
        "id": emp.id,
        "code": emp.employee_code,
        "name": _name(emp),
        "status": (emp.status or "active").lower(),
        "departmentId": emp.department_id,
        "department": emp.department.name if emp.department_id and emp.department else "",
        "designationId": emp.designation_id,
        "designation": emp.designation.title if emp.designation_id and emp.designation else "",
        "branchId": emp.branch_id,
        "unit": _unit(emp),
        "joinDate": joined.isoformat() if joined else None,
        "salary": _money(salary) if salary else None,
        "payCycle": emp.production_pay_cycle if kind == engine.KIND_PRODUCTION else None,
        "bankIssue": _bank_issue(emp),
        "category": category,
        "categoryLabel": CATEGORY_LABELS[category],
        "reason": reason,
        "detail": detail,
        **extra,
    }


def _can_generate(category: str, entry: MissedPayroll | None, salary, month_ok: str | None) -> tuple[bool, str | None]:
    if entry is not None and entry.status != MissedPayroll.STATUS_GENERATED:
        return False, {
            MissedPayroll.STATUS_CLEARED: "Cleared: undo Clear to work it out again.",
            MissedPayroll.STATUS_DONE: "Done: already in the month's payroll.",
            MissedPayroll.STATUS_PAID: "Paid.",
        }[entry.status]
    if category == "not_cleared":
        return False, "Already in the month's payroll: mark it Cleared on its Payroll Details page."
    if not salary:
        return False, "Set the salary on the employee's profile first."
    if month_ok:
        return False, month_ok
    return category in GENERATABLE, None


def _entries(kind: str, ids, month: int, year: int) -> dict[int, MissedPayroll]:
    return {
        e.employee_id: e
        for e in MissedPayroll.objects.filter(kind=kind, month=month, year=year, employee_id__in=list(ids))
    }


def _punched(ids, start: date, end: date) -> dict[int, set[date]]:
    """employee id -> the days of [start, end] they worked: a punch, or a day record that earned shifts (a day HR set by
    hand, a Casual Leave, an On-Duty day ...)."""
    out: dict[int, set[date]] = {}
    ids = list(ids)
    for emp_id, day in (
        AttendanceLog.objects.filter(employee_id__in=ids, date__range=(start, end))
        .values_list("employee_id", "date")
        .distinct()
    ):
        out.setdefault(emp_id, set()).add(day)
    for emp_id, day in AttendanceDayRecord.objects.filter(
        employee_id__in=ids, date__range=(start, end), shifts_earned__gt=0
    ).values_list("employee_id", "date"):
        out.setdefault(emp_id, set()).add(day)
    return out


# ─────────────────────────────────────────────────────────────────────────────
#  Staff
# ─────────────────────────────────────────────────────────────────────────────


def classify_staff(emps, month: int, year: int) -> dict[int, dict]:
    """employee id -> page row (only the employees the regular payroll missed, or who have an entry)."""
    first, last = engine.month_bounds(month, year)
    label = engine.label(month, year)
    ids = [e.id for e in emps]
    rows = {
        p.employee_id: p
        for p in Payroll.objects.filter(
            employee_id__in=ids,
            salary_mode=Payroll.SALARY_MODE_MONTHLY,
            month=month,
            year=year,
            week_number=None,
            period_start__isnull=True,
        ).order_by("-id")
    }
    entries = _entries(engine.KIND_STAFF, ids, month, year)
    inactive_ids = [e.id for e in emps if (e.status or "").lower() != "active"]
    punched = _punched(inactive_ids, first, last) if inactive_ids else {}
    month_ok = None if engine.month_started(month, year) else f"{label} has not started yet."
    out: dict[int, dict] = {}
    for emp in emps:
        p, entry = rows.get(emp.id), entries.get(emp.id)
        active = (emp.status or "").lower() == "active"
        joined = parse_join_date(emp.join_date)
        detail = None
        if entry is not None:
            category = entry.category or "not_generated"
            reason = _reason_staff(category, emp, p, label)
        elif not active:
            if p is None and emp.id not in punched:
                continue
            if p is not None and (p.payment_status == Payroll.PAYMENT_PAID or p.released_from or p.source):
                continue
            category, reason = "inactive", "Inactive employee: the payroll leaves inactive employees out."
            days = len(punched.get(emp.id, ()))
            detail = f"Punched on {days} day{'' if days == 1 else 's'} of {label}." if days else None
            if p is not None:
                detail = (detail + " " if detail else "") + "A payroll of the month was made before they left."
        elif joined is not None and joined > last:
            continue
        elif p is not None and p.source:
            continue
        elif p is not None and p.released_from:
            continue  # held / parked, then released and paid separately on the Staff Payroll page
        elif p is not None and p.on_hold:
            category = "on_hold"
            reason = _reason_staff(category, emp, p, label)
            detail = f"Held by {p.hold_changed_by}." if p.hold_changed_by else None
        elif p is not None and p.new_joiner_parked:
            category, reason = "new_joiner", _reason_staff("new_joiner", emp, p, label)
        elif p is not None:
            if p.status == Payroll.STATUS_PAID:
                continue  # in the payroll and Cleared: nothing missed
            category, reason = "not_cleared", _reason_staff("not_cleared", emp, p, label)
        elif not emp.salary_amount or emp.salary_amount <= 0:
            category, reason = "no_salary", _reason_staff("no_salary", emp, p, label)
            detail = "Add the monthly salary on the employee's profile, then generate here."
        elif month_workflow.is_new_joiner(emp, month, year):
            category, reason = "new_joiner", _reason_staff("new_joiner", emp, p, label)
        else:
            category, reason = "not_generated", _reason_staff("not_generated", emp, p, label)
        ok, why = _can_generate(category, entry, emp.salary_amount, month_ok)
        out[emp.id] = _row(
            emp,
            engine.KIND_STAFF,
            category,
            reason,
            detail,
            payroll=_payroll_json(p),
            entry=entry_json(entry),
            canGenerate=ok,
            cannotGenerate=why,
            payDays=None,
        )
    return out


def _reason_staff(category: str, emp, p: Payroll | None, label: str) -> str:
    joined = parse_join_date(emp.join_date)
    return {
        "no_salary": "No monthly salary on the profile (salary not fixed): the payroll could not work it out.",
        "on_hold": f"Salary on hold for {label} on the Staff Payroll.",
        "new_joiner": (
            f"New joiner (joined {joined:%d %b %Y}): "
            + ("waiting in Skipped -> New joiners." if p is not None else "not in the month's payroll.")
            if joined
            else "New joiner: not in the month's payroll."
        ),
        "not_cleared": f"In the {label} payroll but not marked Cleared on Payroll Details.",
        "not_generated": f"No payroll for {label}: never generated for this employee, or skipped by the payroll.",
        "inactive": "Inactive employee: the payroll leaves inactive employees out.",
    }[category]


# ─────────────────────────────────────────────────────────────────────────────
#  Production
# ─────────────────────────────────────────────────────────────────────────────


def classify_production(emps, month: int, year: int) -> dict[int, dict]:
    first, last = engine.month_bounds(month, year)
    label = engine.label(month, year)
    ids = [e.id for e in emps]
    spans = coverage.spans_for_employees(ids)
    entries = _entries(engine.KIND_PRODUCTION, ids, month, year)
    parked = engine.parked_rows(ids, month, year)
    punched = _punched(ids, first, last)
    uncleared: dict[int, int] = {}
    for emp_id in (
        Payroll.objects.filter(
            employee_id__in=ids,
            salary_mode=Payroll.SALARY_MODE_SHIFT,
            period_start__isnull=False,
            month=month,
            year=year,
            new_joiner_parked=False,
            status=Payroll.STATUS_PENDING,
        )
        .exclude(source=Payroll.SOURCE_MISSED_PAYROLL)
        .values_list("employee_id", flat=True)
    ):
        uncleared[emp_id] = uncleared.get(emp_id, 0) + 1
    ended = engine.month_ended(month, year)
    month_ok = None if ended else f"{label} has not ended yet: production pay is worked out once the month is over."
    out: dict[int, dict] = {}
    for emp in emps:
        entry, row = entries.get(emp.id), parked.get(emp.id)
        active = (emp.status or "").lower() == "active"
        unpaid = engine.unpaid_ranges(spans.get(emp.id, []), month, year)
        worked = sorted(d for d in punched.get(emp.id, ()) if any(a <= d <= b for a, b in unpaid))
        joined = parse_join_date(emp.join_date)
        cycle = CYCLE_LABELS.get(emp.production_pay_cycle or "", None)
        detail = None
        pay_ranges = engine.ranges_from_json((entry.figures or {}).get("payRanges")) if entry is not None else None
        if entry is not None:
            category = entry.category or "not_generated"
            reason = _reason_production(category, emp, row, label, cycle)
        elif not active:
            if not worked and row is None:
                continue
            category, reason = "inactive", _reason_production("inactive", emp, row, label, cycle)
        elif row is not None:
            category, reason = "new_joiner", _reason_production("new_joiner", emp, row, label, cycle)
            pay_ranges = [(row.period_start, row.period_end)]
        elif worked:
            if not emp.salary_per_shift or emp.salary_per_shift <= 0:
                category, reason = "no_salary", _reason_production("no_salary", emp, row, label, cycle)
                detail = "Add the salary per shift on the employee's profile, then generate here."
            elif joined is not None and joined.year == year and joined.month == month:
                category, reason = "new_joiner", _reason_production("new_joiner", emp, row, label, cycle)
            else:
                category, reason = "not_generated", _reason_production("not_generated", emp, row, label, cycle)
        elif emp.id in uncleared:
            category, reason = "not_cleared", _reason_production("not_cleared", emp, row, label, cycle)
            n = uncleared[emp.id]
            detail = f"{n} payslip{'' if n == 1 else 's'} of periods ending in {label} not Cleared."
        else:
            continue
        if pay_ranges is None:
            pay_ranges = unpaid
        if detail is None and worked and category in ("not_generated", "new_joiner", "inactive"):
            detail = f"Worked {len(worked)} day{'' if len(worked) == 1 else 's'} that no payroll pays yet."
            if category == "not_generated" and cycle:
                # the likeliest reason: the cycle's period holding these days is simply not generated yet
                detail += f" If the {cycle} period with these days is not generated yet, generate it on the Production Payroll instead."
        ok, why = _can_generate(category, entry, emp.salary_per_shift, month_ok)
        out[emp.id] = _row(
            emp,
            engine.KIND_PRODUCTION,
            category,
            reason,
            detail,
            payroll=_payroll_json(row),
            entry=entry_json(entry),
            canGenerate=ok,
            cannotGenerate=why,
            payDays={
                "ranges": engine.ranges_json(pay_ranges),
                "text": coverage.fmt_ranges(pay_ranges) if pay_ranges else "",
                "days": coverage.day_count(pay_ranges),
                "worked": len(worked),
            },
        )
    return out


def _reason_production(category: str, emp, row: Payroll | None, label: str, cycle: str | None) -> str:
    joined = parse_join_date(emp.join_date)
    if category == "new_joiner" and row is not None:
        return (
            f"New joiner waiting in the {CYCLE_LABELS.get(row.pay_cycle or '', 'period')} period "
            f"{coverage.fmt_range(row.period_start, row.period_end)} (New Joiners)."
        )
    return {
        "no_salary": "No salary per shift on the profile (salary not fixed): the payroll could not work it out.",
        "new_joiner": (
            f"New joiner (joined {joined:%d %b %Y}): worked days of {label} no payroll pays yet."
            if joined
            else f"New joiner: worked days of {label} no payroll pays yet."
        ),
        "not_cleared": f"Paid by the Production Payroll in {label} but not marked Cleared.",
        "not_generated": (
            f"Worked days of {label} that no payroll pays yet ({cycle} cycle)."
            if cycle
            else f"Worked days of {label} that no payroll pays yet: no production pay cycle assigned."
        ),
        "inactive": "Inactive worker: the payroll leaves inactive workers out.",
    }[category]


# ─────────────────────────────────────────────────────────────────────────────
#  The page
# ─────────────────────────────────────────────────────────────────────────────


def kind_filter(kind: str) -> Q:
    if kind == engine.KIND_PRODUCTION:
        return Q(employment_type=Employee.EMPLOYMENT_TYPE_PRODUCTION)
    return ~Q(employment_type=Employee.EMPLOYMENT_TYPE_PRODUCTION)


def classify(kind: str, emps, month: int, year: int) -> dict[int, dict]:
    if kind == engine.KIND_PRODUCTION:
        return classify_production(emps, month, year)
    return classify_staff(emps, month, year)


def summary(rows: list[dict]) -> dict:
    by_category = {c: 0 for c in CATEGORIES}
    by_status = {s: 0 for s, _l in MissedPayroll.STATUS_CHOICES}
    net = {s: 0.0 for s, _l in MissedPayroll.STATUS_CHOICES}
    for r in rows:
        by_category[r["category"]] += 1
        entry = r.get("entry")
        if entry:
            by_status[entry["status"]] += 1
            net[entry["status"]] += entry["net"] or 0
    return {
        "total": len(rows),
        "active": sum(1 for r in rows if r["status"] == "active"),
        "inactive": sum(1 for r in rows if r["status"] != "active"),
        "byCategory": by_category,
        "byStatus": by_status,
        "netByStatus": {k: round(v, 2) for k, v in net.items()},
    }


def main_generated(kind: str, month: int, year: int) -> bool:
    """Has the regular payroll worked out anyone for the month yet (so the page can say it has not run at all)?"""
    if kind == engine.KIND_PRODUCTION:
        return Payroll.objects.filter(
            salary_mode=Payroll.SALARY_MODE_SHIFT, period_start__isnull=False, month=month, year=year
        ).exists()
    return month_workflow.staff_month(month, year).exclude(source=Payroll.SOURCE_MISSED_PAYROLL).exists()

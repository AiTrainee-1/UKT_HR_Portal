"""MD portal: the employee-focused Payroll page (owner 2026-11-14). What the company spends on salaries each month, what is
deducted and what employees actually earn, by month, department and employee, and one employee's full salary history.
Read-only: every function only reads, and every REST view runs inside ``common.read_only_db()``.

THE CONTRACT is ``frontend/src/pages/md/payroll-dashboard/types.ts`` (every key, and where each figure comes from);
``tests_md_payroll_people`` checks every response against it.

    monthly                 the month and the months before it, every figure for the scope, with the month's status
    department-breakdown    every department with a slip in the month, with the month before
    people                  one row per employee (a production worker's period slips added up), searched, sorted, paged
    people/<id>             one employee's monthly salary history, newest first

The slips are payroll.py's own (``payroll._slips``): legacy weekly production slips out, new joiners HR has not added to
the payroll yet out, people who have since left in; a staff slip belongs to its month, a production slip to the month its
pay period ENDS in; unit and department are the employee's CURRENT ones. So the money here agrees with the Payroll
Analysis figures to the paisa (earned = salary earned, net, deductions, late; companyCost = its employer cost), except
that the employer PF / ESI estimate is rounded per slip here (per department there): a few paise at most.

Per slip (contract names):

* earnedSalary    ``gross_salary`` less any bonus on the slip (shown as ``bonus``; the engines write none, so it is
                  ``gross_salary``), so companyCost = earned + overtime + bonus + employer PF/ESI never counts a bonus twice
* actualSalary    staff: ``earnings.monthlySalary`` of the slip's calculation (a slip without one: its earned salary, so
                  nothing is called lost); production: none
* lateDeduction   payroll.py's late figure (``LATE_SQL``): the late and permission penalties the slip deducted. A Penalty
                  Early Out takes shifts off the PAID DAYS (it is not a deduction line), so it shows in loss of pay
* clDays          the Salary Statement's CL column (``payroll_statement_views._staff_values``): approved Casual Leave
                  (``payroll_insights.casual_leave_days``, the same rule, read for several months at once) on the slip's
                  present / half-shift days, min(shifts completed, the CL portion), at most the paid days
* adjustment      the payroll details page's "Adjustment by HR" (``payroll_insights``, issue "adjustment"): HR's bonus
                  less what HR changed the deductions by after the slip was computed; null when neither
* status          payroll.py's month state (Payroll Done / payment pending / Paid; Cleared is a verification, never paid);
                  a person's month from their own payroll row
"""

from __future__ import annotations

from collections import defaultdict
from datetime import date
from decimal import Decimal, InvalidOperation
from typing import Any, Iterable, Sequence

from django.db.models import QuerySet

from ...models import CasualLeaveRequest, Employee, Payroll, PayrollMonthClose, SalarySlip
from ...payroll_insights import natural_key, parse_iso_date
from ...reporting.definitions.payroll_core_common import EMPLOYER_ESI_RATE, EMPLOYER_PF_RATE, LATE_SQL, SLIP_TYPE_SQL
from ..common import MdParamError, Scope, cached, change, money, parse_month, pct
from . import payroll as P

ZERO = Decimal("0")
ONE = Decimal("1")
HALF = Decimal("0.5")

MONTHS_DEFAULT, MONTHS_MAX = 12, 36
PERSON_MONTHS_DEFAULT, PERSON_MONTHS_MAX = 24, 120
PAGE_SIZE_DEFAULT, PAGE_SIZE_MAX = 25, 100
SORTS = (
    "name",
    "code",
    "department",
    "actualSalary",
    "earnedSalary",
    "attendanceDeduction",
    "deductions",
    "netPaid",
    "companyCost",
    "clDays",
    "clAmount",
)
DIRECTIONS = ("asc", "desc")
CHANGE_KEYS = ("companyCost", "earnedSalary", "netPaid", "attendanceDeduction", "clAmount", "employees")
UNASSIGNED = "Unassigned"

Ym = tuple[int, int]


# ─── small helpers ──────────────────────────────────────────────────────────────────────────────────────────────


def _num(value: Any) -> Decimal | None:
    """A number from a slip's stored calculation (JSON): None when it is missing or not a number."""
    if value is None or isinstance(value, bool):
        return None
    if isinstance(value, Decimal):
        return value
    if isinstance(value, (int, float)):
        return Decimal(str(value))
    if isinstance(value, str):
        try:
            return Decimal(value.strip())
        except InvalidOperation:
            return None
    return None


def _first(*values: Decimal | None) -> Decimal | None:
    return next((v for v in values if v is not None), None)


def _days(value: Decimal) -> float:
    return round(float(value), 2)


def _echo(scope: Scope) -> dict:
    return {
        "branch": scope.labels.get("branch"),
        "department": scope.labels.get("department"),
        "type": scope.employment_type,
    }


def _clamp(value: int, low: int, high: int) -> int:
    return max(low, min(high, int(value)))


def _month_of(month: str | None, available: Sequence[Ym]) -> Ym | None:
    """The month asked for, else (as the rest of the payroll analytics, payroll._context) the latest month that has ENDED
    and has slips: a month still running is provisional (its staff slips count the days to come as absent), so the page
    opens on the last complete month. Else the latest month with slips, else none."""
    if month:
        return parse_month(month)
    today = P._today()
    ended = [x for x in available if P._end(x) < today]
    return ended[0] if ended else (available[0] if available else None)


# ─── the slips of some months, one row each ─────────────────────────────────────────────────────────────────────

_SLIP_FIELDS = (
    "id",
    "employee_id",
    "year",
    "month",
    "period_start",
    "period_end",
    "pay_cycle",
    "gross_salary",
    "ot_amount",
    "bonuses",
    "basic",
    "pf_deduction",
    "esi_deduction",
    "tds_deduction",
    "advance_deduction",
    "total_deductions",
    "net_salary",
    "working_days",
    "present_days",
    "absent_days",
    "paid_leave_days",
    "employee__employee_code",
    "employee__first_name",
    "employee__last_name",
    "employee__status",
    "employee__employment_type",
    "employee__department_id",
    "employee__department__name",
    "employee__department__branch__name",
    "employee__branch__name",
    "employee__designation__title",
    # the small parts of the stored calculation (never its day-by-day list: that is read only for Casual Leave)
    "breakdown_details__summary",
    "breakdown_details__earnings",
    "breakdown_details__salaryPerShift",
)


def _rows(qs: QuerySet) -> list[dict]:
    """One dict per slip: its columns, its employee and the figures of the contract (see ``_figures``)."""
    out = []
    for r in (
        qs.annotate(stype=SLIP_TYPE_SQL, late_amt=LATE_SQL, pf_wages=P._PF_WAGES)
        .order_by()
        .values(*_SLIP_FIELDS, "stype", "late_amt", "pf_wages")
    ):
        r["fig"] = _figures(r)
        out.append(r)
    return out


def _figures(r: dict) -> dict[str, Decimal | None]:
    """The contract's figures of ONE slip, as Decimals (CL is added later by ``_add_casual_leave``)."""
    dec = P._dec
    summary = r.get("breakdown_details__summary") if isinstance(r.get("breakdown_details__summary"), dict) else {}
    earnings = r.get("breakdown_details__earnings") if isinstance(r.get("breakdown_details__earnings"), dict) else {}
    staff = r["stype"] == "staff"
    bonus = dec(r["bonuses"])
    earned = dec(r["gross_salary"]) - bonus
    ot = dec(r["ot_amount"])
    pf, esi, tds = dec(r["pf_deduction"]), dec(r["esi_deduction"]), dec(r["tds_deduction"])
    adv, total = dec(r["advance_deduction"]), dec(r["total_deductions"])
    late = dec(r["late_amt"])
    if staff:
        monthly = _num(earnings.get("monthlySalary"))
        actual: Decimal | None = monthly if monthly is not None else earned
        lop: Decimal | None = max(ZERO, actual - earned)
        working = _first(
            _num(summary.get("companyDays")), _num(summary.get("totalWorkingDays")), dec(r["working_days"])
        )
        paid_days = _first(_num(summary.get("effectivePaidDays")), dec(r["present_days"]) + dec(r["paid_leave_days"]))
        lop_days = max(ZERO, working - paid_days)
        daily = _num(earnings.get("dailyRate"))
        present = _first(_num(summary.get("presentDays")), dec(r["present_days"]))
        holidays = _first(_num(summary.get("holidayDays")), ZERO)
        late_days = _first(_num(summary.get("lateDays")), ZERO)
        shifts = ZERO
        rate = None
    else:
        actual = lop = None
        span = (r["period_end"] - r["period_start"]).days + 1 if r["period_start"] and r["period_end"] else 0
        working = _first(_num(summary.get("totalDays")), Decimal(span))
        lop_days = _first(_num(summary.get("daysAbsent")), dec(r["absent_days"]))
        paid_days = _first(_num(summary.get("daysWorked")), max(ZERO, working - lop_days))
        daily = None
        present = paid_days
        holidays = ZERO
        late_days = _first(_num(summary.get("lateDays")), ZERO)
        shifts = _first(_num(summary.get("totalShifts")), _num(earnings.get("totalShifts")), dec(r["present_days"]))
        rate = _first(_num(r.get("breakdown_details__salaryPerShift")), _num(earnings.get("salaryPerShift")))
    wages = r["pf_wages"]
    pf_base = (wages if wages is not None else dec(r["basic"])) if pf > 0 else ZERO
    esi_base = (wages if wages is not None else dec(r["gross_salary"])) if esi > 0 else ZERO
    employer = P._d2(dec(pf_base) * EMPLOYER_PF_RATE / 100) + P._d2(dec(esi_base) * EMPLOYER_ESI_RATE / 100)
    return {
        "actual": actual,
        "earned": earned,
        "lop": lop,
        "late": late,
        "attendance": (lop or ZERO) + late,
        "ot": ot,
        "bonus": bonus,
        "pf": pf,
        "esi": esi,
        "tds": tds,
        "adv": adv,
        "other": total - pf - esi - tds - adv - late,
        "ded": total,
        "net": dec(r["net_salary"]),
        "employer": employer,
        "cost": earned + ot + bonus + employer,
        "cl_days": ZERO,
        "cl_amount": ZERO,
        "working": working,
        "paid_days": paid_days,
        "lop_days": lop_days,
        "daily": daily,
        "present": present,
        "holidays": holidays,
        "late_days": late_days,
        "shifts": shifts,
        "rate": rate,
    }


def _casual_leave(employee_ids: Iterable[int], pairs: Iterable[Ym]) -> dict[tuple[int, int, int], dict[date, Decimal]]:
    """{(employee, year, month): {date: approved Casual Leave days on it}} for several months in ONE query: exactly
    ``payroll_insights.casual_leave_days`` (1 for a full day, 0.5 per half, two halves on a date make 1)."""
    ids, wanted = sorted(set(employee_ids)), set(pairs)
    if not ids or not wanted:
        return {}
    first, last = min(wanted), max(wanted)
    out: dict[tuple[int, int, int], dict[date, Decimal]] = {}
    rows = CasualLeaveRequest.objects.filter(
        employee_id__in=ids,
        date__gte=date(first[0], first[1], 1),
        date__lte=P._end(last),
        status=CasualLeaveRequest.STATUS_APPROVED,
    ).values_list("employee_id", "date", "portion")
    for employee_id, day, portion in rows:
        if (day.year, day.month) not in wanted:
            continue
        days = out.setdefault((employee_id, day.year, day.month), {})
        part = ONE if portion == CasualLeaveRequest.PORTION_FULL else HALF
        days[day] = min(ONE, days.get(day, ZERO) + part)
    return out


def _add_casual_leave(rows: list[dict], pairs: Iterable[Ym]) -> None:
    """Put clDays / clAmount on the STAFF slips of ``pairs`` (two queries at most: the leave, and the day lists of only
    the slips that have some). The Salary Statement's rule: a CL date counts on a present / half-shift day of the slip,
    min(shifts completed that day, the CL portion), and the total is at most the slip's paid days."""
    staff = [r for r in rows if r["stype"] == "staff"]
    leave = _casual_leave((r["employee_id"] for r in staff), pairs)
    hits = {r["id"]: r for r in staff if (r["employee_id"], r["year"], r["month"]) in leave}
    if not hits:
        return
    for slip_id, days in SalarySlip.objects.filter(id__in=list(hits)).values_list("id", "breakdown_details__days"):
        r = hits[slip_id]
        cl_days = leave[(r["employee_id"], r["year"], r["month"])]
        total = ZERO
        for d in days if isinstance(days, list) else []:
            if not isinstance(d, dict) or d.get("status") not in ("present", "half_shift"):
                continue
            day = parse_iso_date(d.get("date"))
            if day in cl_days:
                total += min(_num(d.get("shiftsCompleted")) or ZERO, cl_days[day])
        fig = r["fig"]
        total = min(total, fig["paid_days"])
        fig["cl_days"] = total
        fig["cl_amount"] = P._d2(total * fig["daily"]) if fig["daily"] is not None else ZERO


def _month_rows(scope: Scope, pairs: Sequence[Ym], *, cl_pairs: Iterable[Ym] | None = None) -> dict[Ym, list[dict]]:
    """The slips of ``pairs`` in the scope, by month, with Casual Leave worked out for ``cl_pairs`` (default: all)."""
    rows = _rows(P._slips(scope, pairs)) if pairs else []
    _add_casual_leave(rows, pairs if cl_pairs is None else cl_pairs)
    by_month: dict[Ym, list[dict]] = defaultdict(list)
    for r in rows:
        by_month[(r["year"], r["month"])].append(r)
    return by_month


# ─── adding figures up ──────────────────────────────────────────────────────────────────────────────────────────

_SUMMED = (
    "earned",
    "late",
    "attendance",
    "ot",
    "bonus",
    "pf",
    "esi",
    "tds",
    "adv",
    "other",
    "ded",
    "net",
    "employer",
    "cost",
    "cl_days",
    "cl_amount",
    "working",
    "paid_days",
    "lop_days",
)


class _Sum:
    """The figures of several slips added up, with the people they belong to."""

    def __init__(self, rows: Iterable[dict] = ()):
        self.people: set[int] = set()
        self.staff = False
        self.total = dict.fromkeys(_SUMMED, ZERO)
        self.actual = ZERO
        self.lop = ZERO
        for r in rows:
            self.add(r)

    def add(self, r: dict) -> None:
        fig = r["fig"]
        self.people.add(r["employee_id"])
        for key in _SUMMED:
            self.total[key] += fig[key]
        if fig["actual"] is not None:
            self.staff = True
            self.actual += fig["actual"]
            self.lop += fig["lop"]

    def json(self) -> dict:
        t = self.total
        return {
            "employees": len(self.people),
            "actualSalary": money(self.actual) if self.staff else None,
            "earnedSalary": money(t["earned"]),
            "lossOfPay": money(self.lop) if self.staff else None,
            "lateDeduction": money(t["late"]),
            "attendanceDeduction": money(t["attendance"]),
            "overtime": money(t["ot"]),
            "bonus": money(t["bonus"]),
            "deductions": {
                "pf": money(t["pf"]),
                "esi": money(t["esi"]),
                "tds": money(t["tds"]),
                "advance": money(t["adv"]),
                "late": money(t["late"]),
                "other": money(t["other"]),
                "total": money(t["ded"]),
            },
            "netPaid": money(t["net"]),
            "employerPfEsi": money(t["employer"]),
            "companyCost": money(t["cost"]),
            "clDays": _days(t["cl_days"]),
            "clAmount": money(t["cl_amount"]),
            "workingDays": _days(t["working"]),
            "paidDays": _days(t["paid_days"]),
            "lopDays": _days(t["lop_days"]),
        }


def _averages(fig: dict) -> dict:
    n = fig["employees"]
    return {
        "averageEarned": money(fig["earnedSalary"] / n) if n else 0.0,
        "averageNetPaid": money(fig["netPaid"] / n) if n else 0.0,
        "attendancePct": pct(fig["paidDays"], fig["workingDays"]),
    }


# ─── the status of a month in words ─────────────────────────────────────────────────────────────────────────────


def _state_words(st: dict) -> dict:
    """payroll.py's month state as {state, label, detail}: where the month stands, in one sentence."""
    state, label = st["state"], st["stateLabel"]
    detail: str | None
    if state == "finalized":
        days = st.get("paymentPendingDays") or 0
        detail = (
            f"Payroll Done on {P._day_text(st.get('finalizedAt'))}: payment pending for {P._plural(days, 'day')} "
            f"({P._inr(st['unpaidNet'])} not paid yet)."
        )
    elif state == "paid":
        if st.get("markedPaidAt"):
            took = st.get("daysToPay")
            detail = f"Marked as paid on {P._day_text(st['markedPaidAt'])}" + (
                f", {P._plural(took, 'day')} after Payroll Done." if took is not None else "."
            )
        else:
            detail = "Every slip is cleared (paid)."
    elif state == "generated" and st.get("staffState") == "generated":
        detail = (
            f"Still open: HR can change it. {st.get('clearedSlips', 0)} of {st['slips']} verified (Cleared); "
            "nothing is paid yet."
        )
    elif state in ("generated", "part_paid"):
        detail = f"{st['unpaidSlips']} of {st['slips']} slips are not paid yet ({P._inr(st['unpaidNet'])})."
    elif state == "in_progress":
        detail = "The month is still running: staff figures are provisional."
    else:
        detail = None
    extra = []
    if st.get("onHold"):
        extra.append(f"{P._plural(st['onHold'], 'salary', 'salaries')} on hold.")
    if st.get("newJoinersWaiting"):
        extra.append(f"{P._plural(st['newJoinersWaiting'], 'new joiner')} waiting to be added to the payroll.")
    if extra:
        detail = " ".join([detail, *extra] if detail else extra)
    return {"state": state, "label": label, "detail": detail}


def _person_state(
    staff_row: dict | None, prod_rows: list[dict], close: PayrollMonthClose | None, ended: bool, today: date
) -> dict:
    """Where ONE person's month stands, from their own payroll row(s)."""
    if staff_row is not None:
        if staff_row["payment_status"] == Payroll.PAYMENT_PAID:
            when = P._day_text(P._wall(staff_row["payment_paid_at"]))
            alone = " separately, after Payroll Done" if staff_row["released_from"] else ""
            return {"state": "paid", "label": "Paid", "detail": f"Paid on {when}{alone}."}
        if staff_row["on_hold"]:
            return {
                "state": "on_hold",
                "label": "On hold",
                "detail": "HR is holding this salary: it is on the Salary Statement but not paid with the month.",
            }
        if close is not None:
            days = max(0, (today - P._ist_date(close.finalized_at)).days)
            return {
                "state": "finalized",
                "label": "Payroll Done, payment pending",
                "detail": f"Locked on {P._day_text(P._wall(close.finalized_at))}; not marked as paid yet "
                f"({P._plural(days, 'day')}).",
            }
        cleared = (staff_row["status"] or "").strip().lower() == Payroll.STATUS_PAID
        if not ended:
            return {"state": "in_progress", "label": "In progress (provisional)", "detail": None}
        return {
            "state": "generated",
            "label": "Generated, still open",
            "detail": "Verified by HR (Cleared), not paid yet." if cleared else "Not verified (Cleared) or paid yet.",
        }
    if prod_rows:
        paid = sum(1 for p in prod_rows if (p["status"] or "").strip().lower() == Payroll.STATUS_PAID)
        n = len(prod_rows)
        if paid >= n:
            return {"state": "paid", "label": "Paid", "detail": f"All {P._plural(n, 'pay period')} cleared (paid)."}
        if paid:
            return {"state": "part_paid", "label": "Part paid", "detail": f"{paid} of {n} pay periods cleared (paid)."}
        if not ended:
            return {"state": "in_progress", "label": "In progress", "detail": None}
        return {"state": "generated", "label": "Generated, not paid", "detail": "Not cleared (paid) yet."}
    return {"state": "no_data", "label": "No payroll row", "detail": None}


_PAYROLL_FIELDS = (
    "employee_id",
    "year",
    "month",
    "period_start",
    "period_end",
    "status",
    "on_hold",
    "payment_status",
    "payment_paid_at",
    "released_from",
    "bonus",
    "deductions",
)


def _payroll_rows(qs: QuerySet) -> tuple[dict[tuple, dict], dict[tuple, dict]]:
    """The payroll rows that go with the slips: (staff by (employee, year, month), production by (employee, period))."""
    staff: dict[tuple, dict] = {}
    production: dict[tuple, dict] = {}
    for p in qs.filter(week_number__isnull=True).order_by("id").values(*_PAYROLL_FIELDS):
        if p["period_start"] is None:
            staff[(p["employee_id"], p["year"], p["month"])] = p
        else:
            production[(p["employee_id"], p["period_start"], p["period_end"])] = p
    return staff, production


def _payment_status(staff_row: dict | None, prod_rows: list[dict]) -> str | None:
    """The employee apps' rule: staff by the payment status, production paid once every period is Cleared."""
    if staff_row is not None:
        return staff_row["payment_status"] or Payroll.PAYMENT_NOT_PAID
    if prod_rows:
        cleared = all((p["status"] or "").strip().lower() == Payroll.STATUS_PAID for p in prod_rows)
        return Payroll.PAYMENT_PAID if cleared else Payroll.PAYMENT_NOT_PAID
    return None


def _adjustment(slips: list[dict], staff_row: dict | None, production: dict[tuple, dict]) -> Decimal | None:
    """The details page's "Adjustment by HR": HR's bonus less what HR changed the deductions by after the slip was
    computed, over the person's slips of the month; None when HR changed neither."""
    total, touched = ZERO, False
    for r in slips:
        p = (
            staff_row
            if r["period_start"] is None
            else production.get((r["employee_id"], r["period_start"], r["period_end"]))
        )
        if p is None:
            continue
        bonus = P._dec(p["bonus"])
        changed = P._dec(p["deductions"]) - P._dec(r["total_deductions"])
        if bonus != 0 or changed != 0:
            touched = True
            total += bonus - changed
    return total if touched else None


# ─── 1. monthly ─────────────────────────────────────────────────────────────────────────────────────────────────


def _month_row(ym: Ym, rows: list[dict], st: dict) -> dict:
    return {"month": P._key(ym), "label": P._label(ym), **_Sum(rows).json(), "status": _state_words(st)}


@cached()
def payroll_monthly(scope: Scope, month: str | None = None, months: int = MONTHS_DEFAULT) -> dict:
    """The month (default: the latest ENDED month with slips) and the months before it, oldest first, with the change on the month
    before. A month in the window with no payroll is left out of the list (a note names it): no zeros that mean 'none'."""
    months = _clamp(months, 1, MONTHS_MAX)
    today = P._today()
    available = P._available_months(scope)
    ym = _month_of(month, available)
    notes = list(scope.notes)
    base = {"available": [P._key(x) for x in available], "scope": _echo(scope)}
    if ym is None:
        return {
            "month": None,
            "label": None,
            "months": [],
            "current": None,
            "previous": None,
            "change": None,
            **base,
            "notes": notes + [P.NO_PAYROLL_NOTE],
        }
    window = [P._shift(ym, -i) for i in range(months - 1, -1, -1)]
    prev = P._shift(ym, -1)
    pairs = window + ([prev] if prev not in window else [])
    by_month = _month_rows(scope, pairs)
    states = P._month_states(scope, pairs, today, available)
    rows = {x: _month_row(x, by_month[x], states[x]) for x in pairs if by_month.get(x)}
    current, previous = rows.get(ym), rows.get(prev)
    started = min(available) if available else ym
    missing = [x for x in window if x not in rows and x >= started]
    if current is None:
        notes.append(
            f"No salary slips exist for {P._label(ym)} in this selection: payroll has not been generated for it."
        )
    elif missing:
        notes.append(
            "No payroll in " + ", ".join(P._label(x) for x in missing) + ": left out of the months (not shown as zero)."
        )
    return {
        "month": P._key(ym),
        "label": P._label(ym),
        "months": [rows[x] for x in window if x in rows],
        "current": current,
        "previous": previous,
        "change": {k: change(current[k], previous[k]) for k in CHANGE_KEYS} if current and previous else None,
        **base,
        "notes": notes,
    }


# ─── 2. department breakdown ────────────────────────────────────────────────────────────────────────────────────


def _department_key(r: dict) -> tuple:
    return (r["employee__department_id"],)


@cached()
def payroll_department_breakdown(scope: Scope, month: str | None = None) -> dict:
    """Every department with a slip in the month (the employee's CURRENT department), costliest first."""
    available = P._available_months(scope)
    ym = _month_of(month, available)
    notes = list(scope.notes)
    empty_totals = {**_Sum().json(), "averageEarned": 0.0, "averageNetPaid": 0.0, "attendancePct": None}
    if ym is None:
        return {
            "month": None,
            "label": None,
            "rows": [],
            "totals": empty_totals,
            "scope": _echo(scope),
            "notes": notes + [P.NO_PAYROLL_NOTE],
        }
    prev = P._shift(ym, -1)
    by_month = _month_rows(scope, [ym, prev], cl_pairs=[ym])
    now: dict[tuple, list[dict]] = defaultdict(list)
    before: dict[tuple, _Sum] = defaultdict(_Sum)
    for r in by_month.get(ym, []):
        now[_department_key(r)].append(r)
    for r in by_month.get(prev, []):
        before[_department_key(r)].add(r)
    total = _Sum(by_month.get(ym, []))
    total_cost = total.total["cost"]
    rows = []
    for key, items in now.items():
        fig = _Sum(items).json()
        first = items[0]
        previous = before[key].json()["companyCost"] if key in before else None
        rows.append(
            {
                "department": first["employee__department__name"] or UNASSIGNED,
                "unit": first["employee__department__branch__name"],
                **fig,
                **_averages(fig),
                "sharePct": pct(fig["companyCost"], float(total_cost)) or 0.0,
                "previousCompanyCost": previous,
                "change": change(fig["companyCost"], previous),
            }
        )
    rows.sort(key=lambda d: (-d["companyCost"], d["department"].lower(), d["unit"] or ""))
    totals_json = total.json()
    if not rows:
        notes.append(
            f"No salary slips exist for {P._label(ym)} in this selection: payroll has not been generated for it."
        )
    return {
        "month": P._key(ym),
        "label": P._label(ym),
        "rows": rows,
        "totals": {**totals_json, **_averages(totals_json)},
        "scope": _echo(scope),
        "notes": notes,
    }


# ─── 3. people ──────────────────────────────────────────────────────────────────────────────────────────────────


def _name(r: dict) -> str:
    return f"{r['employee__first_name'] or ''} {r['employee__last_name'] or ''}".strip()


def _sort_key(sort: str):
    if sort == "name":
        return lambda row: (row["name"].lower(), natural_key(row["code"]))
    if sort == "code":
        return lambda row: (natural_key(row["code"]), row["name"].lower())
    if sort == "department":
        return lambda row: ((row["department"] or "").lower(), row["name"].lower())
    if sort == "deductions":
        return lambda row: row["deductions"]["total"]
    return lambda row: row[sort]


def _people_rows(scope: Scope, ym: Ym) -> list[dict]:
    """One row per employee with a slip in the month (their slips added up), with their hold and payment status."""
    slips = _month_rows(scope, [ym]).get(ym, [])
    staff_rows, prod_rows = _payroll_rows(Payroll.objects.filter(P._slip_scope_q(scope), year=ym[0], month=ym[1]))
    by_emp: dict[int, list[dict]] = defaultdict(list)
    for r in slips:
        by_emp[r["employee_id"]].append(r)
    out = []
    for emp_id, items in by_emp.items():
        first = items[0]
        staff_row = staff_rows.get((emp_id, ym[0], ym[1])) if any(r["stype"] == "staff" for r in items) else None
        periods = [r for r in items if r["stype"] == "production"]
        own = [prod_rows[k] for r in periods if (k := (emp_id, r["period_start"], r["period_end"])) in prod_rows]
        out.append(
            {
                "employeeId": emp_id,
                "code": first["employee__employee_code"] or "",
                "name": _name(first),
                "department": first["employee__department__name"],
                "unit": first["employee__branch__name"],
                "designation": first["employee__designation__title"],
                "type": "staff" if staff_row is not None or len(periods) < len(items) else "production",
                "status": first["employee__status"] or "",
                "onHold": bool(staff_row and staff_row["on_hold"]),
                "paymentStatus": _payment_status(staff_row, own),
                "periods": len(periods),
                **_Sum(items).json(),
                "_slips": items,
            }
        )
    return out


@cached()
def payroll_people(
    scope: Scope,
    month: str | None = None,
    q: str | None = None,
    sort: str = "name",
    direction: str = "asc",
    page: int = 1,
    page_size: int = PAGE_SIZE_DEFAULT,
) -> dict:
    """The employees paid in the month, searched by name or code, sorted and paged; ``totals`` cover every match."""
    if sort not in SORTS:
        raise MdParamError(f"'sort' must be one of {', '.join(SORTS)}, got '{sort}'.")
    if direction not in DIRECTIONS:
        raise MdParamError(f"'dir' must be asc or desc, got '{direction}'.")
    page, page_size = max(1, int(page)), _clamp(page_size, 1, PAGE_SIZE_MAX)
    available = P._available_months(scope)
    ym = _month_of(month, available)
    notes = list(scope.notes)
    base = {"page": page, "pageSize": page_size, "scope": _echo(scope)}
    if ym is None:
        return {
            "month": None,
            "label": None,
            "total": 0,
            "rows": [],
            "totals": _Sum().json(),
            **base,
            "notes": notes + [P.NO_PAYROLL_NOTE],
        }
    rows = _people_rows(scope, ym)
    needle = (q or "").strip().lower()
    if needle:
        rows = [r for r in rows if needle in r["name"].lower() or needle in r["code"].lower()]
    totals = _Sum(s for r in rows for s in r["_slips"]).json()
    key = _sort_key(sort)
    if sort == "actualSalary":  # production has none: last whichever way the list runs
        known = sorted((r for r in rows if r["actualSalary"] is not None), key=key, reverse=direction == "desc")
        rows = known + sorted((r for r in rows if r["actualSalary"] is None), key=_sort_key("name"))
    else:
        rows.sort(key=_sort_key("name"))  # a stable tie-break by name
        rows.sort(key=key, reverse=direction == "desc")
    start = (page - 1) * page_size
    shown = [{k: v for k, v in r.items() if k != "_slips"} for r in rows[start : start + page_size]]
    if not rows:
        notes.append(
            f"Nobody matches '{q.strip()}' in {P._label(ym)}."
            if needle
            else f"No salary slips exist for {P._label(ym)}."
        )
    return {
        "month": P._key(ym),
        "label": P._label(ym),
        "total": len(rows),
        "rows": shown,
        "totals": totals,
        **base,
        "notes": notes,
    }


# ─── 4. one employee's history ──────────────────────────────────────────────────────────────────────────────────


def _period_json(r: dict) -> dict:
    fig = r["fig"]
    return {
        "start": r["period_start"].isoformat(),
        "end": r["period_end"].isoformat(),
        "cycle": r["pay_cycle"],
        "netPaid": money(fig["net"]),
        "shifts": _days(fig["shifts"]),
        "ratePerShift": money(fig["rate"]) if fig["rate"] is not None else None,
    }


@cached()
def payroll_person(employee_id: int, months: int = PERSON_MONTHS_DEFAULT) -> dict | None:
    """Every month the employee has slips (newest first, up to ``months``) with the figures, the days, the status and
    HR's adjustment; None when there is no such employee (the route answers 404)."""
    months = _clamp(months, 1, PERSON_MONTHS_MAX)
    emp = (
        Employee.objects.select_related("department", "branch", "designation")
        .filter(pk=employee_id)
        .only(
            "id",
            "employee_code",
            "first_name",
            "last_name",
            "status",
            "employment_type",
            "join_date",
            "salary_amount",
            "department__name",
            "branch__name",
            "designation__title",
        )
        .first()
    )
    if emp is None:
        return None
    today = P._today()
    slips = _rows(P._slips(Scope()).filter(employee_id=emp.id))
    wanted = sorted({(r["year"], r["month"]) for r in slips}, reverse=True)[:months]
    keep = set(wanted)
    slips = [r for r in slips if (r["year"], r["month"]) in keep]
    _add_casual_leave(slips, wanted)
    staff_rows, prod_rows = _payroll_rows(Payroll.objects.filter(employee_id=emp.id))
    closes = {(c.year, c.month): c for c in PayrollMonthClose.objects.filter(P._pairs_q(wanted))}
    by_month: dict[Ym, list[dict]] = defaultdict(list)
    for r in slips:
        by_month[(r["year"], r["month"])].append(r)
    out = []
    total = _Sum()
    for ym in wanted:
        items = sorted(by_month[ym], key=lambda r: (r["period_start"] or date.min, r["id"]))
        staff_slip = next((r for r in items if r["stype"] == "staff"), None)
        staff_row = staff_rows.get((emp.id, ym[0], ym[1])) if staff_slip is not None else None
        periods = [r for r in items if r["stype"] == "production"]
        own = [prod_rows[k] for r in periods if (k := (emp.id, r["period_start"], r["period_end"])) in prod_rows]
        group = _Sum(items)
        for r in items:
            total.add(r)
        figures = group.json()
        days = staff_slip["fig"] if staff_slip is not None else None
        adjustment = _adjustment(items, staff_row, prod_rows)
        out.append(
            {
                "month": P._key(ym),
                "label": P._label(ym),
                **figures,
                "status": _person_state(staff_row, own, closes.get(ym), P._end(ym) < today, today),
                "dailyRate": money(days["daily"]) if days is not None and days["daily"] is not None else None,
                "presentDays": _days(sum((r["fig"]["present"] for r in items), ZERO)),
                "holidayDays": _days(sum((r["fig"]["holidays"] for r in items), ZERO)),
                "lateDays": _days(sum((r["fig"]["late_days"] for r in items), ZERO)),
                "adjustment": money(adjustment) if adjustment is not None else None,
                "onHold": bool(staff_row and staff_row["on_hold"]),
                "paymentStatus": _payment_status(staff_row, own),
                "paymentPaidAt": P._wall(staff_row["payment_paid_at"]) if staff_row else None,
                "periods": [_period_json(r) for r in periods],
            }
        )
    notes = []
    waiting = sorted(
        {
            (p["year"], p["month"])
            for p in Payroll.objects.filter(
                employee_id=emp.id, new_joiner_parked=True, added_to_payroll_at__isnull=True
            ).values("year", "month")
        }
    )
    if waiting:
        notes.append(
            "Not in the payroll yet (a new joiner HR has not added): "
            + ", ".join(P._label(x) for x in waiting)
            + ". Those months are left out until HR adds them."
        )
    if not out:
        notes.append("No salary slip has been generated for this employee yet.")
    production = emp.employment_type == "production"
    return {
        "employee": {
            "id": emp.id,
            "code": emp.employee_code or "",
            "name": f"{emp.first_name or ''} {emp.last_name or ''}".strip(),
            "department": emp.department.name if emp.department_id else None,
            "unit": emp.branch.name if emp.branch_id else None,
            "designation": emp.designation.title if emp.designation_id else None,
            "type": "production" if production else "staff",
            "status": emp.status or "",
            "joinDate": emp.join_date or None,
            "monthlySalary": None if production or emp.salary_amount is None else money(emp.salary_amount),
        },
        "months": out,
        "totals": total.json(),
        "notes": notes,
    }

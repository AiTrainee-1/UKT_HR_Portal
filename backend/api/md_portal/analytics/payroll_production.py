"""MD portal: PRODUCTION payroll analytics (owner 2026-11-21: "Staff and Production separated, like the HRMS"). Production
is paid per pay period of a cycle (Weekly / BiWeekly / Monthly = four weeks; production_cycles.py), so this side of the
Payroll page is organised by cycle and period, exactly as HR's Production Payroll pages are. Read-only: every function
only reads, and every REST view runs inside ``common.read_only_db()``.

THE CONTRACT is ``frontend/src/pages/md/payroll-dashboard/types.ts`` (the ``Prod*`` types); ``tests_md_payroll_production``
checks every response against it.

    production/overview          the cycles with payroll, the chosen cycle's periods (newest first), the chosen period's
                                 figures and where it stands (Generated / Payroll Done / Paid), the period before, the
                                 cycle's last periods, every production month (all cycles, by the month a period ENDS
                                 in) and the year so far against the year before
    production/departments       the chosen period by department, with the period before
    production/people            the workers of the chosen period, searched, sorted, paged
    production/people/<id>       one worker's pay periods, newest first, day by day

WHICH PAYSLIPS (payroll.py's ``_slips`` with the production scope): every period payslip (legacy weekly slips out) except
the workers parked in a period's New Joiners until HR adds them (production_period_workflow.py, 2026-11-16) - so a
period's figures are HR's "main payroll" of it. Workers who have since LEFT stay in (what a period cost does not change
when someone leaves later; HR's lists show active workers only: the difference is reported as ``leftSince``).

A payslip's CYCLE is the one stamped on it, else (generated before the cycles existed) its worker's cycle now, as HR's
pages read it (production_period_workflow.cycle_q); a payslip with neither is under "No pay cycle". Unit and department
are the worker's CURRENT ones.

THE MONEY of one payslip is payroll_people's (``payroll_people._figures``), so it matches HR's Production Payroll and its
Salary Statement (``payroll_statement_views._production_values``) to the paisa:

* grossPay        shifts x the rate per shift (``gross_salary``), what the shifts earned
* excess / detection / bonus   HR's Excess and Detection of the period (payroll_excess.py, 2026-11-20); bonus = the net
* deductions      the payroll row's total; PF / ESI / advance / late from the payslip, TDS from the payroll row
* netPaid         the payroll row's ``final_salary`` (rounded UP to the rupee), what the bank file pays
* companyCost     gross + bonus + the employer PF / ESI estimate (payroll.py's rates)
* shifts / daysWorked / daysAbsent / daysPaid / periodDays   the payslip's summary (daysPaid = the days the payslip pays:
                  the whole period, or fewer / more after a change of pay cycle)

WHERE A PERIOD STANDS: HR's period workflow (``ProductionPeriodClose``): Payroll Done locks it, Mark as Paid records the
day it was paid. A period with no close is Generated, unless every payslip of it is already marked Paid (periods paid
before the workflow existed, migration 0151) or some are (Part paid). Cleared is HR's verification, never payment.
"""

from __future__ import annotations

import dataclasses
from collections import defaultdict
from datetime import date
from decimal import Decimal
from typing import Iterable, Sequence

from django.db.models import Count, Q, QuerySet

from ...models import Employee, Payroll, ProductionPeriodClose, SalarySlip
from ...payroll_insights import natural_key
from ...production_cycles import CYCLE_LABELS as HR_CYCLE_LABELS
from ...production_cycles import CYCLES
from ..common import MdParamError, Scope, cached, change, money, pct
from . import payroll as P
from . import payroll_people as PP

ZERO = Decimal("0")
NONE = "none"
CYCLE_ORDER: tuple[str, ...] = (*CYCLES, NONE)
CYCLE_LABELS: dict[str, str] = {**HR_CYCLE_LABELS, NONE: "No pay cycle"}
STATE_LABELS = {
    "generated": "Generated",
    "part_paid": "Part paid",
    "finalized": "Payroll Done",
    "paid": "Paid",
}
PERIODS_DEFAULT, PERIODS_MAX = 12, 52
MONTHS = 12
PAGE_SIZE_DEFAULT, PAGE_SIZE_MAX = 25, 100
SORTS = (
    "name",
    "code",
    "department",
    "shifts",
    "ratePerShift",
    "grossPay",
    "bonus",
    "deductions",
    "netPaid",
    "companyCost",
    "daysAbsent",
    "lateDays",
)
DIRECTIONS = ("asc", "desc")
CHANGE_KEYS = ("companyCost", "grossPay", "netPaid", "deductions", "bonus", "shifts", "employees")
NO_PRODUCTION_NOTE = (
    "No production payroll has been generated yet: there are no production payslips for this selection. Figures appear "
    "here once HR generates a pay period on a Production Payroll page."
)

Period = tuple[date, date]
Ym = tuple[int, int]


# ─── small helpers ──────────────────────────────────────────────────────────────────────────────────────────────


def production_scope(scope: Scope) -> Scope:
    return dataclasses.replace(scope, employment_type="production")


def _echo(scope: Scope) -> dict:
    return {"branch": scope.labels.get("branch"), "department": scope.labels.get("department"), "type": "production"}


def _clamp(value: int, low: int, high: int) -> int:
    return max(low, min(high, int(value)))


def _days(value: Decimal | float | int | None) -> float:
    return round(float(value or 0), 2)


def normalise_cycle(value: str | None) -> str | None:
    """The ``cycle`` parameter: weekly | biweekly | monthly | none, or None for the default. Anything else is a 400."""
    text = str(value or "").strip().lower()
    if not text:
        return None
    if text not in CYCLE_ORDER:
        raise MdParamError(f"'cycle' must be one of {', '.join(CYCLE_ORDER)}, got '{value}'.")
    return text


def parse_period(start: str | None, end: str | None) -> Period | None:
    """``periodStart`` + ``periodEnd`` (YYYY-MM-DD), both or neither; None for the default period."""
    a, b = str(start or "").strip(), str(end or "").strip()
    if not a and not b:
        return None
    if not a or not b:
        raise MdParamError("'periodStart' and 'periodEnd' must be given together (YYYY-MM-DD).")
    try:
        first, last = date.fromisoformat(a[:10]), date.fromisoformat(b[:10])
    except ValueError:
        raise MdParamError(f"'periodStart' / 'periodEnd' must be dates (YYYY-MM-DD), got '{a}' / '{b}'.") from None
    if last < first:
        raise MdParamError("'periodEnd' cannot be before 'periodStart'.")
    return first, last


def _stamp_cycle(value: str | None) -> str | None:
    text = (value or "").strip().lower()
    return text if text in CYCLES else None


def slip_cycle(r: dict) -> str:
    """The cycle a payslip belongs to: stamped on it, else its worker's cycle now, else none."""
    return _stamp_cycle(r.get("pay_cycle")) or _stamp_cycle(r.get("employee__production_pay_cycle")) or NONE


def cycle_q(cycle: str, prefix: str = "") -> Q:
    """Payslips (or payroll rows: the same column names) of one cycle, as HR's pages read them."""
    unstamped = Q(**{f"{prefix}pay_cycle__isnull": True}) | Q(**{f"{prefix}pay_cycle": ""})
    if cycle == NONE:
        known = Q(**{f"{prefix}employee__production_pay_cycle__in": CYCLES})
        stamped = Q(**{f"{prefix}pay_cycle__in": CYCLES})
        return ~stamped & ~(unstamped & known)
    return Q(**{f"{prefix}pay_cycle": cycle}) | (unstamped & Q(**{f"{prefix}employee__production_pay_cycle": cycle}))


def _periods_q(periods: Iterable[Period]) -> Q:
    q = Q(pk__in=[])
    for start, end in periods:
        q |= Q(period_start=start, period_end=end)
    return q


def _fmt(d: date) -> str:
    return f"{d.day} {d:%b}"


def period_label(start: date, end: date) -> str:
    """'22 Oct - 4 Nov 2026' (the year once when both ends share it)."""
    if start.year == end.year:
        return f"{_fmt(start)} - {_fmt(end)} {end.year}"
    return f"{_fmt(start)} {start.year} - {_fmt(end)} {end.year}"


def _period_key(start: date, end: date) -> str:
    return f"{start.isoformat()}_{end.isoformat()}"


# ─── adding production figures up ───────────────────────────────────────────────────────────────────────────────

_SUMMED = (
    "earned",
    "bonus",
    "excess",
    "detection",
    "pf",
    "esi",
    "tds",
    "adv",
    "late",
    "other",
    "ded",
    "net",
    "employer",
    "cost",
    "shifts",
    "paid_days",
    "lop_days",
    "working",
    "period_days",
)


class ProdSum:
    """The figures of several production payslips added up, with the workers they belong to."""

    def __init__(self, rows: Iterable[dict] = ()):
        self.people: set[int] = set()
        self.slips = 0
        self.total = dict.fromkeys(_SUMMED, ZERO)
        for r in rows:
            self.add(r)

    def add(self, r: dict) -> None:
        fig = r["fig"]
        self.people.add(r["employee_id"])
        self.slips += 1
        for key in _SUMMED:
            self.total[key] += fig[key] or ZERO

    def json(self) -> dict:
        t = self.total
        n = len(self.people)
        seen = t["paid_days"] + t["lop_days"]
        return {
            "employees": n,
            "slips": self.slips,
            "shifts": _days(t["shifts"]),
            "daysWorked": _days(t["paid_days"]),
            "daysAbsent": _days(t["lop_days"]),
            "daysPaid": _days(t["working"]),
            "grossPay": money(t["earned"]),
            "excess": money(t["excess"]),
            "detection": money(t["detection"]),
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
            "averageRatePerShift": money(t["earned"] / t["shifts"]) if t["shifts"] else None,
            "averageNetPerWorker": money(t["net"] / n) if n else 0.0,
            "shiftsPerWorker": _days(t["shifts"] / n) if n else 0.0,
            "attendancePct": pct(float(t["paid_days"]), float(seen)),
        }


def _changes(cur: dict | None, prev: dict | None) -> dict | None:
    if not cur or not prev:
        return None
    return {
        k: change(cur[k]["total"], prev[k]["total"]) if k == "deductions" else change(cur[k], prev[k])
        for k in CHANGE_KEYS
    }


# ─── the payslips ───────────────────────────────────────────────────────────────────────────────────────────────


def _slips(scope: Scope) -> QuerySet:
    """The production payslips the figures are made of (payroll.py's own set, production scope)."""
    return P._slips(production_scope(scope))


def _rows(qs: QuerySet) -> list[dict]:
    rows = PP._rows(qs)
    for r in rows:
        r["cycle"] = slip_cycle(r)
    return rows


def _index(scope: Scope, today: date) -> dict[str, list[dict]]:
    """{cycle: [period, ...] newest first}: every period that has payslips in the scope, with how many payslips and
    workers it has, how many are paid (Mark as Paid) and verified (Cleared), and where it stands. Two queries."""
    grouped = (
        _slips(scope)
        .annotate(is_paid=P._paid_case(), is_cleared=P._cleared_case())
        .order_by()
        .values("pay_cycle", "employee__production_pay_cycle", "period_start", "period_end")
        .annotate(
            slips=Count("id"),
            paid=Count("id", filter=Q(is_paid=True)),
            cleared=Count("id", filter=Q(is_cleared=True)),
        )
    )
    merged: dict[tuple[str, date, date], dict] = {}
    for g in grouped:
        key = (slip_cycle(g), g["period_start"], g["period_end"])
        m = merged.setdefault(key, {"slips": 0, "paid": 0, "cleared": 0})
        for k in ("slips", "paid", "cleared"):
            m[k] += int(g[k] or 0)
    if not merged:
        return {}
    first = min(k[1] for k in merged)
    last = max(k[2] for k in merged)
    closes = {
        (c.cycle, c.period_start, c.period_end): c
        for c in ProductionPeriodClose.objects.filter(period_start__gte=first, period_end__lte=last)
    }
    out: dict[str, list[dict]] = defaultdict(list)
    for (cycle, start, end), m in merged.items():
        close = closes.get((cycle, start, end))
        out[cycle].append(
            {
                "cycle": cycle,
                "start": start,
                "end": end,
                "slips": m["slips"],
                "paid": m["paid"],
                "cleared": m["cleared"],
                "ended": end < today,
                "close": close,
                "state": _state(close, m["slips"], m["paid"]),
            }
        )
    for periods in out.values():
        periods.sort(key=lambda p: (p["start"], p["end"]), reverse=True)
    return dict(out)


def _state(close: ProductionPeriodClose | None, slips: int, paid: int) -> str:
    if close is not None:
        return "paid" if close.paid_at else "finalized"
    if slips and paid >= slips:
        return "paid"
    return "part_paid" if paid else "generated"


def _period_brief(p: dict) -> dict:
    return {
        "start": p["start"].isoformat(),
        "end": p["end"].isoformat(),
        "key": _period_key(p["start"], p["end"]),
        "label": period_label(p["start"], p["end"]),
        "state": p["state"],
        "stateLabel": STATE_LABELS[p["state"]],
        "ended": p["ended"],
        "slips": p["slips"],
    }


def _default_cycle(index: dict[str, list[dict]]) -> str:
    """The cycle most workers are paid on: the most payslips in its latest ENDED period (ties: the more recent period,
    then Weekly, BiWeekly, Monthly, none). A cycle with a handful of trial payslips does not hide the main one."""

    def weight(cycle: str) -> tuple:
        latest = ([p for p in index[cycle] if p["ended"]] or index[cycle])[0]
        return (latest["slips"], latest["end"], -CYCLE_ORDER.index(cycle))

    return max(index, key=weight)


def _choose(index: dict[str, list[dict]], cycle: str | None, period: Period | None) -> tuple[str, dict | None]:
    """The cycle (asked, else the default) and its period (asked, else the latest ENDED one, else the latest)."""
    chosen = cycle or _default_cycle(index)
    periods = index.get(chosen, [])
    if not periods:
        return chosen, None
    if period is not None:
        return chosen, next((p for p in periods if (p["start"], p["end"]) == period), None)
    ended = [p for p in periods if p["ended"]]
    return chosen, (ended or periods)[0]


def _assigned(scope: Scope) -> dict[str, int]:
    """Active production workers of the scope on each cycle now (Unassigned: in no payroll)."""
    rows = (
        production_scope(scope).employees(active=True).order_by().values("production_pay_cycle").annotate(n=Count("id"))
    )
    out: dict[str, int] = defaultdict(int)
    for r in rows:
        out[_stamp_cycle(r["production_pay_cycle"]) or NONE] += int(r["n"])
    return dict(out)


def _cycles_json(index: dict[str, list[dict]], assigned: dict[str, int]) -> list[dict]:
    out = []
    for cycle in CYCLE_ORDER:
        periods = index.get(cycle)
        if not periods:
            continue
        out.append(
            {
                "cycle": cycle,
                "label": CYCLE_LABELS[cycle],
                "periods": len(periods),
                "latestStart": periods[0]["start"].isoformat(),
                "latestEnd": periods[0]["end"].isoformat(),
                "assigned": assigned.get(cycle, 0) if cycle != NONE else 0,
            }
        )
    return out


def _period_rows(scope: Scope, cycle: str, periods: Sequence[dict]) -> dict[Period, list[dict]]:
    """The payslips of some periods of a cycle, by period (one query for the payslips, one for their payroll rows)."""
    if not periods:
        return {}
    rows = _rows(_slips(scope).filter(cycle_q(cycle), _periods_q((p["start"], p["end"]) for p in periods)))
    out: dict[Period, list[dict]] = defaultdict(list)
    for r in rows:
        out[(r["period_start"], r["period_end"])].append(r)
    return out


# ─── where a period stands ──────────────────────────────────────────────────────────────────────────────────────


def _parked(scope: Scope, cycle: str, start: date, end: date) -> dict:
    """Workers parked in the period's New Joiners (not in any figure until HR adds them), in the scope."""
    rows = Payroll.objects.filter(
        P._slip_scope_q(production_scope(scope)),
        cycle_q(cycle),
        period_start=start,
        period_end=end,
        new_joiner_parked=True,
    ).values_list("parked_reason", "final_salary")
    moved = sum(1 for reason, _ in rows if reason == Payroll.PARKED_TRANSFER)
    return {
        "count": len(rows),
        "newJoiners": len(rows) - moved,
        "movedIn": moved,
        "net": money(sum((P._dec(net) for _, net in rows), ZERO)),
    }


def _status(p: dict, rows: list[dict], parked: dict, today: date) -> dict:
    close: ProductionPeriodClose | None = p["close"]
    paid_ids = {r["id"] for r in rows if r.get("pay") and r["pay"]["payment_status"] == Payroll.PAYMENT_PAID}
    unpaid_net = sum((r["fig"]["net"] for r in rows if r["id"] not in paid_ids), ZERO)
    left = {r["employee_id"] for r in rows if (r["employee__status"] or "").strip().lower() != "active"}
    left_net = sum((r["fig"]["net"] for r in rows if r["employee_id"] in left), ZERO)
    state = p["state"]
    finalized_at = P._wall(close.finalized_at) if close else None
    paid_at = P._wall(close.paid_at) if close and close.paid_at else None
    days_to_pay = (
        max(0, (P._ist_date(close.paid_at) - P._ist_date(close.finalized_at)).days) if close and close.paid_at else None
    )
    pending_days = max(0, (today - P._ist_date(close.finalized_at)).days) if close and not close.paid_at else None
    slips, cleared = len(rows), sum(1 for r in rows if r.get("pay") and _cleared(r["pay"]))
    if state == "paid" and close is not None:
        on = close.paid_on.strftime("%d %b %Y").lstrip("0") if close.paid_on else P._day_text(paid_at)
        detail = f"Paid on {on}" + (
            f", {P._plural(days_to_pay, 'day')} after Payroll Done." if days_to_pay is not None else "."
        )
    elif state == "paid":
        detail = "Every payslip is marked paid (before the period workflow existed, or one by one)."
    elif state == "finalized":
        detail = (
            f"Payroll Done on {P._day_text(finalized_at)}: payment pending for {P._plural(pending_days or 0, 'day')} "
            f"({P._inr(unpaid_net)} not paid yet)."
        )
    elif state == "part_paid":
        detail = f"{slips - len(paid_ids)} of {slips} payslips are not paid yet ({P._inr(unpaid_net)})."
    else:
        detail = f"Open: HR can still generate it again. {cleared} of {slips} verified (Cleared); nothing is paid yet."
    if parked["count"]:
        detail += f" {P._plural(parked['count'], 'worker')} waiting in New Joiners (not in these figures)."
    return {
        "state": state,
        "label": STATE_LABELS[state],
        "detail": detail,
        "ended": p["ended"],
        "locked": close is not None,
        "finalizedAt": finalized_at,
        "finalizedBy": (close.finalized_by or None) if close else None,
        "paidAt": paid_at,
        "paidBy": (close.paid_by or None) if close and close.paid_at else None,
        "paidOn": close.paid_on.isoformat() if close and close.paid_at and close.paid_on else None,
        "daysToPay": days_to_pay,
        "paymentPendingDays": pending_days,
        "slips": slips,
        "paidSlips": len(paid_ids),
        "unpaidSlips": slips - len(paid_ids),
        "unpaidNet": money(unpaid_net),
        "clearedSlips": cleared,
        "parked": parked,
        "leftSince": len(left),
        "leftSinceNet": money(left_net),
    }


def _cleared(pay: dict) -> bool:
    return (pay.get("status") or "").strip().lower() == Payroll.STATUS_PAID


# ─── months and years (every cycle) ─────────────────────────────────────────────────────────────────────────────


def _month_rows(scope: Scope, pairs: Sequence[Ym]) -> dict[Ym, list[dict]]:
    """Every production payslip of some months (the month a period ENDS in), by month."""
    out: dict[Ym, list[dict]] = defaultdict(list)
    if not pairs:
        return out
    for r in _rows(_slips(scope).filter(P._pairs_q(pairs))):
        out[(r["year"], r["month"])].append(r)
    return out


def _month_json(ym: Ym, rows: list[dict]) -> dict:
    by_cycle: dict[str, list[dict]] = defaultdict(list)
    for r in rows:
        by_cycle[r["cycle"]].append(r)
    return {
        "month": P._key(ym),
        "label": P._label(ym),
        "periods": len({(r["cycle"], r["period_start"], r["period_end"]) for r in rows}),
        **ProdSum(rows).json(),
        "cycles": [
            {
                "cycle": c,
                "label": CYCLE_LABELS[c],
                "employees": len({r["employee_id"] for r in by_cycle[c]}),
                "netPaid": money(sum((r["fig"]["net"] for r in by_cycle[c]), ZERO)),
                "companyCost": money(sum((r["fig"]["cost"] for r in by_cycle[c]), ZERO)),
            }
            for c in CYCLE_ORDER
            if by_cycle.get(c)
        ],
    }


def _year_block(year: int, first: Ym, last: Ym, by_month: dict[Ym, list[dict]]) -> dict | None:
    pairs = [x for x in by_month if first <= x <= last and by_month[x]]
    if not pairs:
        return None
    rows = [r for x in pairs for r in by_month[x]]
    return {
        "year": year,
        "label": f"{year} ({P._label(first)[:3]}-{P._label(last)[:3]})" if first != last else P._label(first),
        "from": P._key(first),
        "to": P._key(last),
        "months": len(pairs),
        **ProdSum(rows).json(),
    }


def _months_and_years(scope: Scope, ym: Ym) -> tuple[list[dict], dict]:
    """The production months up to ``ym`` (oldest first, only months with payslips) and the year so far against the
    same months a year before, every cycle together."""
    window = [P._shift(ym, -i) for i in range(MONTHS - 1, -1, -1)]
    years = [(ym[0], m) for m in range(1, ym[1] + 1)] + [(ym[0] - 1, m) for m in range(1, 13)]
    by_month = _month_rows(scope, sorted(set(window) | set(years)))
    months = [_month_json(x, by_month[x]) for x in window if by_month.get(x)]
    current = _year_block(ym[0], (ym[0], 1), ym, by_month)
    previous = _year_block(ym[0] - 1, (ym[0] - 1, 1), (ym[0] - 1, ym[1]), by_month)
    return months, {
        "current": current,
        "previous": previous,
        "previousFull": _year_block(ym[0] - 1, (ym[0] - 1, 1), (ym[0] - 1, 12), by_month),
        "change": _changes(current, previous),
        "months": PP.year_months(ym, by_month, _point),
    }


def _point(rows: list[dict]) -> dict:
    fig = ProdSum(rows).json()
    return {"companyCost": fig["companyCost"], "netPaid": fig["netPaid"], "employees": fig["employees"]}


# ─── 1. overview ────────────────────────────────────────────────────────────────────────────────────────────────


def _empty(scope: Scope, notes: list[str], cycles: list[dict] | None = None, cycle: str | None = None) -> dict:
    return {
        "cycles": cycles or [],
        "cycle": cycle,
        "cycleLabel": CYCLE_LABELS.get(cycle or "") if cycle else None,
        "periods": [],
        "period": None,
        "current": None,
        "status": None,
        "previous": None,
        "change": None,
        "trend": [],
        "months": [],
        "yearly": None,
        "departments": PP._department_options(production_scope(scope)),
        "scope": _echo(scope),
        "notes": notes,
    }


@cached()
def production_overview(
    scope: Scope,
    cycle: str | None = None,
    period: Period | None = None,
    periods: int = PERIODS_DEFAULT,
) -> dict:
    """The cycles, the chosen cycle's periods, the chosen period's figures and status against the period before, the
    cycle's last ``periods`` periods (oldest first), the production months and the year so far."""
    periods = _clamp(periods, 2, PERIODS_MAX)
    today = P._today()
    notes = list(scope.notes)
    index = _index(scope, today)
    if not index:
        return _empty(scope, notes + [NO_PRODUCTION_NOTE])
    cycles = _cycles_json(index, _assigned(scope))
    chosen, p = _choose(index, cycle, period)
    if chosen not in index:
        return _empty(
            scope,
            notes + [f"No {CYCLE_LABELS[chosen]} payroll has been generated in this selection."],
            cycles,
            chosen,
        )
    listed = index[chosen]
    if p is None:
        body = _empty(
            scope,
            notes + [f"There is no {CYCLE_LABELS[chosen]} payroll for {period_label(*period)} in this selection."],
            cycles,
            chosen,
        )
        body["periods"] = [_period_brief(x) for x in listed]
        return body
    position = listed.index(p)
    before = listed[position + 1] if position + 1 < len(listed) else None
    shown = list(reversed(listed[position : position + periods]))
    by_period = _period_rows(scope, chosen, shown)
    rows = by_period.get((p["start"], p["end"]), [])
    current = ProdSum(rows).json()
    before_rows = by_period.get((before["start"], before["end"])) if before else None
    previous = ProdSum(before_rows).json() if before_rows else None
    status = _status(p, rows, _parked(scope, chosen, p["start"], p["end"]), today)
    if status["leftSince"]:
        notes.append(
            f"{P._plural(status['leftSince'], 'worker')} paid in this period {'has' if status['leftSince'] == 1 else 'have'} "
            f"left since ({P._inr(status['leftSinceNet'])} net): counted here as the period's cost, while HR's "
            "Production Payroll lists active workers only."
        )
    months, yearly = _months_and_years(scope, (p["end"].year, p["end"].month))
    return {
        "cycles": cycles,
        "cycle": chosen,
        "cycleLabel": CYCLE_LABELS[chosen],
        "periods": [_period_brief(x) for x in listed],
        "period": _period_brief(p),
        "current": current,
        "status": status,
        "previous": {**_period_brief(before), **previous} if before and previous else None,
        "change": _changes(current, previous),
        "trend": [{**_period_brief(x), **ProdSum(by_period.get((x["start"], x["end"]), [])).json()} for x in shown],
        "months": months,
        "yearly": yearly,
        "departments": PP._department_options(production_scope(scope)),
        "scope": _echo(scope),
        "notes": notes,
    }


# ─── 2. departments ─────────────────────────────────────────────────────────────────────────────────────────────


def _resolve(scope: Scope, cycle: str | None, period: Period | None) -> tuple[dict, str | None, dict | None, list[str]]:
    today = P._today()
    notes = list(scope.notes)
    index = _index(scope, today)
    if not index:
        return index, None, None, notes + [NO_PRODUCTION_NOTE]
    chosen, p = _choose(index, cycle, period)
    if p is None:
        notes.append(
            f"There is no {CYCLE_LABELS[chosen]} payroll for {period_label(*period)} in this selection."
            if period
            else f"No {CYCLE_LABELS[chosen]} payroll has been generated in this selection."
        )
    return index, chosen, p, notes


@cached()
def production_departments(scope: Scope, cycle: str | None = None, period: Period | None = None) -> dict:
    """The chosen period by department (the worker's CURRENT department), costliest first, with the period before."""
    index, chosen, p, notes = _resolve(scope, cycle, period)
    head = {
        "cycle": chosen,
        "cycleLabel": CYCLE_LABELS.get(chosen or "") if chosen else None,
        "period": _period_brief(p) if p else None,
        "scope": _echo(scope),
    }
    if p is None:
        return {**head, "rows": [], "totals": ProdSum().json(), "previousPeriod": None, "notes": notes}
    listed = index[chosen]
    position = listed.index(p)
    before = listed[position + 1] if position + 1 < len(listed) else None
    by_period = _period_rows(scope, chosen, [p] + ([before] if before else []))
    now: dict[int | None, list[dict]] = defaultdict(list)
    was: dict[int | None, ProdSum] = defaultdict(ProdSum)
    for r in by_period.get((p["start"], p["end"]), []):
        now[r["employee__department_id"]].append(r)
    if before:
        for r in by_period.get((before["start"], before["end"]), []):
            was[r["employee__department_id"]].add(r)
    total = ProdSum(r for items in now.values() for r in items)
    total_cost = float(total.total["cost"])
    rows = []
    for key, items in now.items():
        fig = ProdSum(items).json()
        first = items[0]
        previous = was[key].json() if key in was else None
        rows.append(
            {
                "department": first["employee__department__name"] or PP.UNASSIGNED,
                "unit": first["employee__department__branch__name"],
                **fig,
                "sharePct": pct(fig["companyCost"], total_cost) or 0.0,
                "previousCompanyCost": previous["companyCost"] if previous else None,
                "previousNetPaid": previous["netPaid"] if previous else None,
                "change": change(fig["companyCost"], previous["companyCost"] if previous else None),
            }
        )
    rows.sort(key=lambda d: (-d["companyCost"], d["department"].lower(), d["unit"] or ""))
    return {
        **head,
        "rows": rows,
        "totals": total.json(),
        "previousPeriod": _period_brief(before) if before else None,
        "notes": notes,
    }


# ─── 3. the workers of a period ─────────────────────────────────────────────────────────────────────────────────


def _late_days(slip_ids: Sequence[int]) -> dict[int, int]:
    """Late days of each payslip: the days its stored calculation flags late (as the Salary Statement counts them)."""
    out: dict[int, int] = {}
    for slip_id, days in SalarySlip.objects.filter(id__in=list(slip_ids)).values_list("id", "breakdown_details__days"):
        out[slip_id] = sum(1 for d in days if isinstance(d, dict) and d.get("isLate")) if isinstance(days, list) else 0
    return out


def _person_name(r: dict) -> str:
    return f"{r['employee__first_name'] or ''} {r['employee__last_name'] or ''}".strip()


def _worker_row(r: dict, late: int) -> dict:
    fig, pay = r["fig"], r.get("pay")
    one = ProdSum([r]).json()
    return {
        "employeeId": r["employee_id"],
        "code": r["employee__employee_code"] or "",
        "name": _person_name(r),
        "department": r["employee__department__name"],
        "unit": r["employee__branch__name"],
        "designation": r["employee__designation__title"],
        "status": r["employee__status"] or "",
        "ratePerShift": money(fig["rate"]) if fig["rate"] is not None else None,
        "shifts": one["shifts"],
        "daysWorked": one["daysWorked"],
        "daysAbsent": one["daysAbsent"],
        "daysPaid": one["daysPaid"],
        "periodDays": _days(fig["period_days"]),
        "lateDays": late,
        "grossPay": one["grossPay"],
        "excess": one["excess"],
        "detection": one["detection"],
        "bonus": one["bonus"],
        "deductions": one["deductions"],
        "netPaid": one["netPaid"],
        "employerPfEsi": one["employerPfEsi"],
        "companyCost": one["companyCost"],
        "paymentStatus": (pay["payment_status"] or Payroll.PAYMENT_NOT_PAID) if pay else None,
        "cleared": bool(pay and _cleared(pay)),
    }


def _sort_key(sort: str):
    if sort == "name":
        return lambda row: (row["name"].lower(), natural_key(row["code"]))
    if sort == "code":
        return lambda row: (natural_key(row["code"]), row["name"].lower())
    if sort == "department":
        return lambda row: ((row["department"] or "").lower(), row["name"].lower())
    if sort == "deductions":
        return lambda row: row["deductions"]["total"]
    if sort == "ratePerShift":
        return lambda row: row["ratePerShift"] if row["ratePerShift"] is not None else -1
    return lambda row: row[sort]


@cached()
def production_people(
    scope: Scope,
    cycle: str | None = None,
    period: Period | None = None,
    q: str | None = None,
    sort: str = "name",
    direction: str = "asc",
    page: int = 1,
    page_size: int = PAGE_SIZE_DEFAULT,
) -> dict:
    """The workers paid in the chosen period, searched by name or code, sorted and paged; ``totals`` cover every match."""
    if sort not in SORTS:
        raise MdParamError(f"'sort' must be one of {', '.join(SORTS)}, got '{sort}'.")
    if direction not in DIRECTIONS:
        raise MdParamError(f"'dir' must be asc or desc, got '{direction}'.")
    page, page_size = max(1, int(page)), _clamp(page_size, 1, PAGE_SIZE_MAX)
    index, chosen, p, notes = _resolve(scope, cycle, period)
    head = {
        "cycle": chosen,
        "cycleLabel": CYCLE_LABELS.get(chosen or "") if chosen else None,
        "period": _period_brief(p) if p else None,
        "page": page,
        "pageSize": page_size,
        "scope": _echo(scope),
    }
    if p is None:
        return {**head, "total": 0, "rows": [], "totals": ProdSum().json(), "notes": notes}
    slips = _period_rows(scope, chosen, [p]).get((p["start"], p["end"]), [])
    late = _late_days([r["id"] for r in slips])
    pairs = [(r, _worker_row(r, late.get(r["id"], 0))) for r in slips]
    needle = (q or "").strip().lower()
    if needle:
        pairs = [(r, w) for r, w in pairs if needle in w["name"].lower() or needle in w["code"].lower()]
    totals = ProdSum(r for r, _ in pairs).json()
    rows = [w for _, w in pairs]
    rows.sort(key=_sort_key("name"))
    rows.sort(key=_sort_key(sort), reverse=direction == "desc")
    start = (page - 1) * page_size
    if not rows:
        notes.append(f"Nobody matches '{q.strip()}' in this period." if needle else "No payslips in this period.")
    return {**head, "total": len(rows), "rows": rows[start : start + page_size], "totals": totals, "notes": notes}


# ─── 4. one worker's pay periods ────────────────────────────────────────────────────────────────────────────────


def _day_json(d: dict) -> dict:
    shifts = PP._num(d.get("shiftsEarned"))
    return {
        "date": str(d.get("date") or ""),
        "day": str(d.get("day") or ""),
        "status": str(d.get("status") or ""),
        "shifts": _days(shifts) if shifts is not None else 0.0,
        "late": bool(d.get("isLate")),
        "firstPunch": d.get("firstPunch") if isinstance(d.get("firstPunch"), str) else None,
        "lastPunch": d.get("lastPunch") if isinstance(d.get("lastPunch"), str) else None,
        "lastPunchNextDay": bool(d.get("lastPunchNextDay")),
    }


@cached()
def production_person(employee_id: int, periods: int = PERIODS_DEFAULT) -> dict | None:
    """Every pay period the worker has a payslip for (newest first, up to ``periods``, every cycle), each with its
    figures, where it stands and the days; None when there is no such employee (the route answers 404)."""
    periods = _clamp(periods, 1, PERIODS_MAX)
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
            "salary_per_shift",
            "production_pay_cycle",
            "department__name",
            "branch__name",
            "designation__title",
        )
        .first()
    )
    if emp is None:
        return None
    slips = sorted(
        _rows(_slips(Scope()).filter(employee_id=emp.id)),
        key=lambda r: (r["period_start"], r["period_end"]),
        reverse=True,
    )[:periods]
    days = dict(SalarySlip.objects.filter(id__in=[r["id"] for r in slips]).values_list("id", "breakdown_details__days"))
    keys = {(r["cycle"], r["period_start"], r["period_end"]) for r in slips}
    closes = (
        {
            (c.cycle, c.period_start, c.period_end): c
            for c in ProductionPeriodClose.objects.filter(
                period_start__gte=min(k[1] for k in keys), period_end__lte=max(k[2] for k in keys)
            )
        }
        if keys
        else {}
    )
    out = []
    for r in slips:
        pay = r.get("pay")
        paid = bool(pay and pay["payment_status"] == Payroll.PAYMENT_PAID)
        close = closes.get((r["cycle"], r["period_start"], r["period_end"]))
        state = _state(close, 1, 1 if paid else 0)
        listed = [d for d in days.get(r["id"]) or [] if isinstance(d, dict)]
        figures = _worker_row(r, sum(1 for d in listed if d.get("isLate")))
        out.append(
            {
                "cycle": r["cycle"],
                "cycleLabel": CYCLE_LABELS[r["cycle"]],
                "start": r["period_start"].isoformat(),
                "end": r["period_end"].isoformat(),
                "key": _period_key(r["period_start"], r["period_end"]),
                "label": period_label(r["period_start"], r["period_end"]),
                "state": state,
                "stateLabel": STATE_LABELS[state],
                "paymentStatus": (pay["payment_status"] or Payroll.PAYMENT_NOT_PAID) if pay else None,
                "paymentPaidAt": P._wall(pay["payment_paid_at"]) if pay and paid else None,
                "cleared": bool(pay and _cleared(pay)),
                **{k: figures[k] for k in _PERIOD_KEYS},
                "days": [_day_json(d) for d in listed],
            }
        )
    notes = []
    parked = (
        Payroll.objects.filter(employee_id=emp.id, period_start__isnull=False, new_joiner_parked=True)
        .order_by("-period_start")
        .values_list("period_start", "period_end")
    )
    if parked:
        notes.append(
            "Waiting in New Joiners (not in the payroll until HR adds them): "
            + ", ".join(period_label(a, b) for a, b in parked)
            + "."
        )
    if not out:
        notes.append("No production payslip has been generated for this worker yet.")
    return {
        "employee": {
            "id": emp.id,
            "code": emp.employee_code or "",
            "name": f"{emp.first_name or ''} {emp.last_name or ''}".strip(),
            "department": emp.department.name if emp.department_id else None,
            "unit": emp.branch.name if emp.branch_id else None,
            "designation": emp.designation.title if emp.designation_id else None,
            "type": "production" if emp.employment_type == "production" else "staff",
            "status": emp.status or "",
            "joinDate": emp.join_date or None,
            "cycle": _stamp_cycle(emp.production_pay_cycle),
            "cycleLabel": CYCLE_LABELS.get(_stamp_cycle(emp.production_pay_cycle) or "", None),
            "ratePerShift": money(emp.salary_per_shift) if emp.salary_per_shift is not None else None,
        },
        "periods": out,
        "totals": ProdSum(slips).json(),
        "notes": notes,
    }


_PERIOD_KEYS = (
    "ratePerShift",
    "shifts",
    "daysWorked",
    "daysAbsent",
    "daysPaid",
    "periodDays",
    "lateDays",
    "grossPay",
    "excess",
    "detection",
    "bonus",
    "deductions",
    "netPaid",
    "employerPfEsi",
    "companyCost",
)

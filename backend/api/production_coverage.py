"""
Production pay-cycle coverage: which working days an employee's payroll has already paid, so moving an employee between
Weekly, BiWeekly and Monthly (production_cycles.py) never pays the same day twice and never loses one (owner, 2026-11-06).

    covered days  the union of the days every payroll row of the employee pays:
                    a production period row  -> its paid_ranges, or period_start..period_end when that is NULL;
                    a staff monthly row      -> the whole calendar month (so a staff -> production switch cannot pay a
                                                day twice either);
                    a legacy week-number / session row has no dates and covers nothing.
                  The row being (re)generated -the same employee and period- is left out.
    pay days      the days of the period [s, e] that are not covered.
    catch-up      L = the latest covered day before s. When the row holding L was generated on ANOTHER cycle (or is a staff
                  month), the days L+1 .. s-1 -which no payroll paid- are added to this row, ahead of its period. A row
                  generated before the cycles existed (no cycle stamped) adds nothing: that gap is only reported, so a
                  first run never pays ancient history.
    refused       nothing of [s, e] is left to pay: every day is already in another payroll.

A row's paid days (catch-up + pay days) are stored on Payroll.paid_ranges, and only when they differ from the plain
period: an ordinary run stores NULL and is computed exactly as before.

Everything here is plain data except spans_for_employees(), which reads the payroll rows in one query.
"""

from __future__ import annotations

import calendar
from dataclasses import dataclass, field
from datetime import date, timedelta
from decimal import Decimal

from .production_cycles import CYCLE_LABELS, DEFAULT_MONTHLY_EQUIVALENT_FACTOR, MONTHLY_EQUIVALENT_FACTOR

ONE_DAY = timedelta(days=1)
# A production month is four weeks: the PF / ESI rules are monthly, so a period's pay is scaled to 28 days.
PRODUCTION_MONTH_DAYS = 28
MONTH_ABBR = ("Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec")
MONTH_NAMES = (
    "January",
    "February",
    "March",
    "April",
    "May",
    "June",
    "July",
    "August",
    "September",
    "October",
    "November",
    "December",
)
STAFF = "staff"
STAFF_LABEL = "Staff Payroll"
NO_CYCLE_LABEL = "Production Payroll"

Range = tuple[date, date]


# ── ranges of days ───────────────────────────────────────────────────────────────


def merge(ranges) -> list[Range]:
    """Sorted, with overlapping and touching ranges joined: [(1, 3), (4, 6), (9, 9)] -> [(1, 6), (9, 9)]."""
    out: list[Range] = []
    for start, end in sorted(r for r in ranges if r[0] <= r[1]):
        if out and start <= out[-1][1] + ONE_DAY:
            if end > out[-1][1]:
                out[-1] = (out[-1][0], end)
        else:
            out.append((start, end))
    return out


def subtract(whole: Range, taken) -> list[Range]:
    """The parts of `whole` that none of `taken` covers."""
    start, end = whole
    out: list[Range] = []
    cursor = start
    for a, b in merge(taken):
        if b < cursor or a > end:
            continue
        if a > cursor:
            out.append((cursor, a - ONE_DAY))
        cursor = max(cursor, b + ONE_DAY)
        if cursor > end:
            break
    if cursor <= end:
        out.append((cursor, end))
    return out


def intersect(a: Range, b: Range) -> Range | None:
    start, end = max(a[0], b[0]), min(a[1], b[1])
    return (start, end) if start <= end else None


def day_count(ranges) -> int:
    return sum((end - start).days + 1 for start, end in ranges)


def each_day(ranges):
    for start, end in ranges:
        day = start
        while day <= end:
            yield day
            day += ONE_DAY


def parse_ranges(raw) -> list[Range]:
    """Payroll.paid_ranges -> merged (from, to) pairs. Anything unreadable is skipped rather than failing a run."""
    out = []
    for item in raw if isinstance(raw, list) else []:
        try:
            start, end = date.fromisoformat(str(item["from"])[:10]), date.fromisoformat(str(item["to"])[:10])
        except (KeyError, TypeError, ValueError):
            continue
        if start <= end:
            out.append((start, end))
    return merge(out)


def ranges_json(ranges) -> list[dict]:
    return [{"from": start.isoformat(), "to": end.isoformat()} for start, end in ranges]


# ── how dates are written ───────────────────────────────────────────────────────


def fmt_day(day: date) -> str:
    return f"{day.day} {MONTH_ABBR[day.month - 1]} {day.year}"


def fmt_range(start: date, end: date) -> str:
    """'9 Nov 2026', '9 Nov – 29 Nov 2026', '29 Dec 2025 – 4 Jan 2026'."""
    if start == end:
        return fmt_day(start)
    left = f"{start.day} {MONTH_ABBR[start.month - 1]}"
    if start.year != end.year:
        left += f" {start.year}"
    return f"{left} – {end.day} {MONTH_ABBR[end.month - 1]} {end.year}"


def fmt_ranges(ranges) -> str:
    parts = [fmt_range(a, b) for a, b in ranges]
    if len(parts) <= 1:
        return parts[0] if parts else ""
    return f"{', '.join(parts[:-1])} and {parts[-1]}"


def status_label(status: str) -> str:
    return "Cleared" if status == "paid" else "pending"


# ── the rows that pay days ──────────────────────────────────────────────────────


@dataclass(frozen=True)
class PayrollRef:
    """One payroll row, as much of it as coverage needs."""

    payroll_id: int
    cycle: str | None
    staff: bool
    status: str
    period_start: date
    period_end: date

    @property
    def label(self) -> str:
        """'Weekly', 'Staff Payroll', or 'Production Payroll' for a row generated before the cycles existed."""
        if self.staff:
            return STAFF_LABEL
        return CYCLE_LABELS.get(self.cycle or "", NO_CYCLE_LABEL)

    @property
    def describe(self) -> str:
        """'the Weekly payroll for 2 Nov – 8 Nov 2026 (Cleared)' / 'the Staff Payroll for October 2026 (pending)'."""
        if self.staff:
            when = f"{MONTH_NAMES[self.period_start.month - 1]} {self.period_start.year}"
            return f"the Staff Payroll for {when} ({status_label(self.status)})"
        kind = f"{CYCLE_LABELS[self.cycle]} payroll" if self.cycle in CYCLE_LABELS else "production payroll"
        return f"the {kind} for {fmt_range(self.period_start, self.period_end)} ({status_label(self.status)})"


@dataclass(frozen=True)
class PaidSpan:
    start: date
    end: date
    row: PayrollRef


def spans_of_row(
    *,
    payroll_id: int,
    salary_mode: str,
    month: int | None,
    year: int | None,
    period_start: date | None,
    period_end: date | None,
    paid_ranges,
    pay_cycle: str | None,
    status: str,
) -> list[PaidSpan]:
    """The days one payroll row pays."""
    if period_start is not None and period_end is not None:
        ref = PayrollRef(payroll_id, pay_cycle, False, status, period_start, period_end)
        ranges = parse_ranges(paid_ranges) if paid_ranges else [(period_start, period_end)]
        return [PaidSpan(a, b, ref) for a, b in ranges]
    if salary_mode == "monthly" and month and year:
        first = date(year, month, 1)
        last = date(year, month, calendar.monthrange(year, month)[1])
        return [PaidSpan(first, last, PayrollRef(payroll_id, None, True, status, first, last))]
    return []  # a legacy week-number production row: no dates to cover


_ROW_FIELDS = (
    "id",
    "employee_id",
    "salary_mode",
    "month",
    "year",
    "period_start",
    "period_end",
    "paid_ranges",
    "pay_cycle",
    "status",
)


def spans_for_employees(employee_ids) -> dict[int, list[PaidSpan]]:
    """employee id -> every day their payroll rows pay (one query for the whole list)."""
    from django.db.models import Q

    from .models import Payroll

    out: dict[int, list[PaidSpan]] = {int(i): [] for i in employee_ids}
    if not out:
        return out
    rows = (
        Payroll.objects.filter(employee_id__in=list(out))
        .filter(Q(period_start__isnull=False) | Q(salary_mode=Payroll.SALARY_MODE_MONTHLY))
        .values_list(*_ROW_FIELDS)
    )
    for pk, emp_id, mode, month, year, start, end, ranges, cycle, status in rows:
        out[emp_id].extend(
            spans_of_row(
                payroll_id=pk,
                salary_mode=mode,
                month=month,
                year=year,
                period_start=start,
                period_end=end,
                paid_ranges=ranges,
                pay_cycle=cycle,
                status=status,
            )
        )
    return out


def spans_for_employee(employee_id: int) -> list[PaidSpan]:
    return spans_for_employees([employee_id])[int(employee_id)]


# ── one period of one employee ──────────────────────────────────────────────────


@dataclass(frozen=True)
class PaidPart:
    """Days of the period another payroll already paid."""

    start: date
    end: date
    row: PayrollRef

    def json(self) -> dict:
        return {
            "from": self.start.isoformat(),
            "to": self.end.isoformat(),
            "payrollId": self.row.payroll_id,
            "cycle": self.row.cycle,
            "kind": STAFF if self.row.staff else "production",
            "label": self.row.label,
            "status": self.row.status,
            "periodStart": self.row.period_start.isoformat(),
            "periodEnd": self.row.period_end.isoformat(),
        }


@dataclass(frozen=True)
class CatchUp:
    """Days before the period that no payroll paid, added to this row because the employee changed cycle."""

    start: date
    end: date
    row: PayrollRef  # the payroll that paid the day just before them (the previous cycle)

    def json(self) -> dict:
        return {
            "from": self.start.isoformat(),
            "to": self.end.isoformat(),
            "days": (self.end - self.start).days + 1,
            "fromCycle": self.row.cycle,
            "fromKind": STAFF if self.row.staff else "production",
            "fromLabel": self.row.label,
            "afterPayrollId": self.row.payroll_id,
        }


@dataclass
class PeriodPlan:
    """What a payroll for one employee and one period of a cycle pays."""

    period_start: date
    period_end: date
    cycle: str | None
    pay_ranges: list[Range]
    already_paid: list[PaidPart] = field(default_factory=list)
    catch_up: list[CatchUp] = field(default_factory=list)
    # days after a row with no cycle stamped that no payroll paid: reported, never added
    legacy_gap: CatchUp | None = None
    # the employee has payroll rows other than the one being (re)generated
    has_history: bool = False
    # the latest row before or overlapping this period (for the reassignment warning)
    last_row: PayrollRef | None = None

    @classmethod
    def plain(cls, start: date, end: date, cycle: str | None = None) -> PeriodPlan:
        return cls(start, end, cycle, [(start, end)])

    @classmethod
    def from_ranges(cls, start: date, end: date, ranges, cycle: str | None = None) -> PeriodPlan:
        """A plan from bare paid days (tests, simple callers): days inside the period are pay days, days before it are
        catch-up; nothing is known about the payroll that paid the rest."""
        merged = merge(ranges)
        pay = merge(part for r in merged if (part := intersect(r, (start, end))))
        before = [(a, min(b, start - ONE_DAY)) for a, b in merged if a < start]
        unknown = PayrollRef(0, None, False, "pending", start, end)
        return cls(start, end, cycle, pay, catch_up=[CatchUp(a, b, unknown) for a, b in before])

    # derived

    @property
    def catch_up_ranges(self) -> list[Range]:
        return [(c.start, c.end) for c in self.catch_up]

    @property
    def paid_ranges(self) -> list[Range]:
        """Every day this row pays: catch-up + pay days, merged."""
        return merge([*self.catch_up_ranges, *self.pay_ranges])

    @property
    def period_days(self) -> int:
        return (self.period_end - self.period_start).days + 1

    @property
    def pay_days(self) -> int:
        return day_count(self.pay_ranges)

    @property
    def catch_up_days(self) -> int:
        return day_count(self.catch_up_ranges)

    @property
    def paid_days(self) -> int:
        return day_count(self.paid_ranges)

    @property
    def is_plain(self) -> bool:
        """The whole period and nothing else: an ordinary run."""
        return not self.catch_up and self.pay_ranges == [(self.period_start, self.period_end)]

    @property
    def refused(self) -> bool:
        return not self.pay_ranges

    def stored_ranges(self) -> list[dict] | None:
        """Payroll.paid_ranges: NULL for an ordinary run."""
        return None if self.is_plain else ranges_json(self.paid_ranges)

    def refusal_reason(self) -> str:
        rows = list({p.row.payroll_id: p.row for p in self.already_paid}.values())
        names = [r.describe for r in rows] or ["another payroll"]
        joined = names[0] if len(names) == 1 else f"{', '.join(names[:-1])} and {names[-1]}"
        return (
            f"Already paid: every day of {fmt_range(self.period_start, self.period_end)} is already in {joined}. "
            "Nothing is paid twice."
        )

    def note(self) -> str | None:
        """One plain sentence about what is different from an ordinary run; None for an ordinary run."""
        if self.is_plain and self.legacy_gap is None:
            return None
        parts = []
        if self.refused:
            parts.append(self.refusal_reason())
        elif self.already_paid:
            by_label: dict[str, list[Range]] = {}
            for p in self.already_paid:
                by_label.setdefault(p.row.label, []).append((p.start, p.end))
            paid = "; ".join(f"{fmt_ranges(ranges)} already paid on {label}" for label, ranges in by_label.items())
            parts.append(f"Pays {fmt_ranges(self.pay_ranges)} only; {paid}.")
        for c in self.catch_up:
            parts.append(
                f"Adds catch-up days {fmt_range(c.start, c.end)}: after the employee left {c.row.label} no payroll paid "
                "them."
            )
        if self.legacy_gap is not None:
            g = self.legacy_gap
            parts.append(
                f"{fmt_range(g.start, g.end)} were not paid by any payroll; the payroll before them was generated before "
                "pay cycles existed, so they are not added automatically."
            )
        return " ".join(parts)

    def json(self) -> dict:
        return {
            "periodStart": self.period_start.isoformat(),
            "periodEnd": self.period_end.isoformat(),
            "periodDays": self.period_days,
            "payDays": self.pay_days,
            "catchUpDays": self.catch_up_days,
            "paidDays": self.paid_days,
            "payRanges": ranges_json(self.pay_ranges),
            "alreadyPaid": [p.json() for p in self.already_paid],
            "catchUp": [c.json() for c in self.catch_up],
            "legacyGap": self.legacy_gap.json() if self.legacy_gap is not None else None,
            "partial": not self.is_plain,
            "refused": self.refused,
            "note": self.note(),
        }


def _own_row(span: PaidSpan, start: date, end: date) -> bool:
    return not span.row.staff and span.row.period_start == start and span.row.period_end == end


def plan_period(spans, start: date, end: date, cycle: str | None) -> PeriodPlan:
    """What a payroll of `cycle` for [start, end] pays an employee whose payroll rows pay `spans`. The row for this same
    period (if it exists) is left out, so generating it again gives the same answer as the first time."""
    others = [s for s in spans if not _own_row(s, start, end)]
    covered = [(s.start, s.end) for s in others]
    pay = subtract((start, end), covered)

    already: list[PaidPart] = []
    for s in sorted(others, key=lambda s: (s.start, s.row.payroll_id)):
        part = intersect((s.start, s.end), (start, end))
        if part is None:
            continue
        if already and already[-1].row == s.row and part[0] <= already[-1].end + ONE_DAY:
            already[-1] = PaidPart(already[-1].start, max(already[-1].end, part[1]), s.row)
        else:
            already.append(PaidPart(part[0], part[1], s.row))

    plan = PeriodPlan(start, end, cycle, pay, already_paid=already, has_history=bool(others))

    # the latest covered day before the period, and the row that pays it
    before = [(min(s.end, start - ONE_DAY), s) for s in others if s.start < start]
    if before:
        latest_day, holder = max(before, key=lambda item: (item[0], item[1].row.period_end, item[1].row.payroll_id))
        gap_start, gap_end = latest_day + ONE_DAY, start - ONE_DAY
        if gap_start <= gap_end and cycle is not None:
            row = holder.row
            if row.staff or (row.cycle is not None and row.cycle != cycle):
                plan.catch_up = [CatchUp(gap_start, gap_end, row)]
            elif row.cycle is None:
                plan.legacy_gap = CatchUp(gap_start, gap_end, row)

    if others:
        plan.last_row = max(others, key=lambda s: (s.end, s.row.period_end, s.row.payroll_id)).row
    return plan


def plans_for_employees(employee_ids, start: date, end: date, cycle: str | None) -> dict[int, PeriodPlan]:
    """employee id -> plan_period for each (one query)."""
    return {
        emp_id: plan_period(spans, start, end, cycle) for emp_id, spans in spans_for_employees(employee_ids).items()
    }


# ── PF / ESI on a part period ───────────────────────────────────────────────────


def cycle_factor(cycle: str | None) -> int:
    return MONTHLY_EQUIVALENT_FACTOR.get(cycle, DEFAULT_MONTHLY_EQUIVALENT_FACTOR)


def monthly_factor(cycle: str | None, paid_days: int | None = None) -> int | Decimal:
    """What a period's gross is multiplied by before it is tested against the monthly PF / ESI rules.

    The cycle's own factor (Weekly 4, BiWeekly 2, Monthly 1; 2 with no cycle) for an ordinary row (`paid_days` None) and
    for a row that pays as many days as the cycle has; otherwise the month-equivalent of the days it really pays, 28 / paid
    days, so a part period (or one with catch-up days) is not judged as a smaller or bigger wage than it is."""
    factor = cycle_factor(cycle)
    cycle_days = PRODUCTION_MONTH_DAYS // factor
    if not paid_days or paid_days <= 0 or paid_days == cycle_days:
        return factor
    return Decimal(PRODUCTION_MONTH_DAYS) / Decimal(paid_days)


def factor_json(factor: int | Decimal) -> int | float:
    """A whole factor stays a whole number (what every ordinary breakdown has always stored); 28/21 -> 1.3333."""
    if isinstance(factor, int):
        return factor
    if factor == factor.to_integral_value():
        return int(factor)
    return round(float(factor), 4)


def row_paid_days(payroll) -> int | None:
    """How many days a stored production period row pays; None for a row with no period."""
    if getattr(payroll, "period_start", None) is None or getattr(payroll, "period_end", None) is None:
        return None
    ranges = parse_ranges(getattr(payroll, "paid_ranges", None))
    if ranges:
        return day_count(ranges)
    return (payroll.period_end - payroll.period_start).days + 1


def row_monthly_factor(payroll, cycle: str | None = None) -> int | Decimal:
    """monthly_factor() of a stored row (`cycle` when the row has none stamped): the cycle's own factor unless the row
    has paid_ranges of its own."""
    ranges = parse_ranges(getattr(payroll, "paid_ranges", None))
    return monthly_factor(getattr(payroll, "pay_cycle", None) or cycle, day_count(ranges) if ranges else None)

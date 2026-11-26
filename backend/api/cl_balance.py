"""Casual Leave balance, following the policy HR sets on Settings -> Casual Leave (owner 2026-11-21; CasualLeavePolicy).

Who: active staff who have the service the policy asks for (N months or N days after joining). How much: with the MONTHLY
allocation (the default) every month adds its days (1, 2, 3 ...); with carry forward on, unused days stay for later
months of the year with no monthly limit on them, so in January someone has 1, in February 2 if January's was not used.
Without carry forward each month's days are for that month only. With the YEARLY allocation (the rule of 2026-11-02 to
2026-11-21) the year's days are there at once. At 31 December unused days lapse, or move into the next year (at most the
policy's maximum).

The policy counts from the cut-over (PayrollSettings.cl_balance_since, 2026-11-02 by default): Casual Leave dated earlier
never counts against the balance (and keeps the old one-per-month rule). On the Casual Leave page's Carry Forward tab HR
turns an employee's ABSENT or ON LEAVE dates into approved Casual Leave (cl_adjustment_views.assign): that Casual Leave
counts against the balance even when its date is before the start (Part.assigned; it counts in the start's month).

Pending counts so nobody can ask for more than is left while requests wait; a rejected (or deleted) request frees its days
again. A Casual Leave HR proposes from the Attendance Edit page counts as pending while that attendance change waits for
the Department Head and HR (it becomes a real approved Casual Leave when both approve: attendance_edit._apply_casual_leave),
so the employee cannot use the same days twice in the meantime.

A Casual Leave dated on an employee's birthday under the NEW birthday rule (compensation, owner 2026-11-19: on/after
CompensationConfig.claims_from, birthday switched on, an active staff member, not an off day) that was NOT worked (no
punch that day) uses NO balance: the day is a paid birthday leave (attendance_final), so the Casual Leave request stays
as it is but is never counted (Part.birthday). On a worked birthday it counts like any Casual Leave (the worked birthday
earns its own credit to claim instead).

Read-only: nothing here writes anything.
"""

from __future__ import annotations

import calendar
from dataclasses import dataclass, replace
from datetime import date, datetime
from decimal import Decimal

# the yearly allocation's default (and the only rule from 2026-11-02 to 2026-11-21); the policy decides now (policy())
ENTITLEMENT = 12
FULL, FIRST_HALF, SECOND_HALF = "full", "first_half", "second_half"
PORTION_DAYS = {FULL: Decimal("1"), FIRST_HALF: Decimal("0.5"), SECOND_HALF: Decimal("0.5")}
PORTION_LABEL = {FULL: "Full day", FIRST_HALF: "Half day (first half)", SECOND_HALF: "Half day (second half)"}
HR_EDIT_OPTION = "casual_leave"  # AttendanceOverrideRequest.requested_values["option"] of a proposed Casual Leave
MONTH_NAMES = (
    "January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December",
)  # fmt: skip


def number(value) -> int | float:
    """1 -> 1, 1.5 -> 1.5: a whole count stays a whole number for older readers."""
    value = Decimal(str(value))
    return int(value) if value == value.to_integral_value() else float(value)


def portion_of(value: str | None) -> str:
    return value if value in PORTION_DAYS else FULL


def since() -> date:
    """The cut-over day: Casual Leave dated on/after it counts against the balance (the policy starts that day)."""
    from .models import PayrollSettings
    from .models.payroll import CL_BALANCE_DEFAULT_SINCE

    value = PayrollSettings.get().cl_balance_since
    if isinstance(value, str):  # a settings row read before it was reloaded from the database
        value = date.fromisoformat(value[:10])
    return value or CL_BALANCE_DEFAULT_SINCE


def counts(d: date, cut_over: date) -> bool:
    """Whether Casual Leave dated `d` uses the yearly balance (else the old one-per-month rule applies to it)."""
    return d >= cut_over


def window(year: int, cut_over: date) -> tuple[date, date] | None:
    """The days of `year` whose Casual Leave counts against that year's balance, or None (the whole year is before the
    cut-over, so no balance is kept for it)."""
    first, last = max(cut_over, date(year, 1, 1)), date(year, 12, 31)
    return (first, last) if first <= last else None


@dataclass(frozen=True)
class Part:
    """One piece of Casual Leave that holds balance days: a pending / approved request, or a Casual Leave HR proposed on the
    Attendance Edit page that is still waiting (source "hr_edit", kind "attendance_correction")."""

    employee_id: int
    date: date
    portion: str
    status: str  # "approved" | "pending"
    request_id: int
    kind: str  # "casual_leave" | "attendance_correction"
    source: str  # "employee" (asked for in the apps / by HR on the Casual Leave page) | "hr_edit" | "hr_assign"
    created_at: datetime | None = None
    decided_at: datetime | None = None
    # HR gave it for an absent date on the Carry Forward tab: it uses the year's balance whatever its date
    assigned: bool = False
    # dated on a NEW-rule birthday (see new_rule_birthdays): a paid birthday leave, so it never uses the balance
    birthday: bool = False

    def counts(self, cut_over: date) -> bool:
        """Whether it uses the yearly balance: dated on/after the cut-over, or given by HR for an absent date; never when
        it falls on a new-rule birthday (paid birthday leave, no Casual Leave balance used)."""
        if self.birthday:
            return False
        return self.assigned or counts(self.date, cut_over)

    @property
    def days(self) -> Decimal:
        return PORTION_DAYS[self.portion]

    def to_json(self) -> dict:
        return {
            "id": self.request_id,
            "requestKind": self.kind,
            "date": self.date.isoformat(),
            "portion": self.portion,
            "portionLabel": PORTION_LABEL[self.portion],
            "days": number(self.days),
            "status": self.status,
            "source": self.source,
            # added 2026-11-19: on a new-rule birthday (paid birthday leave): it uses no Casual Leave balance
            "birthday": self.birthday,
        }


def new_rule_birthdays(candidates) -> set[tuple[int, date]]:
    """{(employee id, date)} of the (employee id, date of birth, employment type, date) candidates whose date is the
    employee's birthday under the NEW birthday rule (compensation_engine.birthday_rule: master + birthday switch on,
    on/after the birthday effective date and CompensationConfig.claims_from, active staff, not before joining, not an off
    day) AND that was not worked (compensation_effects.worked_days: the day's punches as the attendance engine reads them,
    or a manual presence row) AND that gave no approved birthday credit. A Casual Leave on such a day is a paid birthday
    leave and uses no balance; on a WORKED birthday (or one already credited) it counts like any Casual Leave (the worked
    birthday gives its own credit to claim instead). No query unless a date of birth matches a candidate date (then the
    switches, those employees, their punches of those days and their birthday claims are read)."""
    from .compensation_rules import is_birthday

    matched = [
        (emp_id, d)
        for emp_id, dob, kind, d in candidates
        if kind == "staff" and dob is not None and is_birthday(dob, d)
    ]
    if not matched:
        return set()
    from . import compensation_engine as comp
    from .models import CompensationConfig, Employee, PayrollSettings

    if not PayrollSettings.get().compensation_feature_enabled:
        return set()
    ctx = comp.CompContext(master=True, config=CompensationConfig.get())
    if not ctx.birthday_on:
        return set()
    employees = Employee.objects.in_bulk({emp_id for emp_id, _d in matched})
    new_rule = {
        (emp_id, d)
        for emp_id, d in matched
        if emp_id in employees and comp.birthday_rule(employees[emp_id], d, ctx) == comp.BIRTHDAY_RULE_NEW
    }
    if not new_rule:
        return set()
    from .compensation_effects import worked_days
    from .models import HolidayWorkClaim

    # "worked" the way the attendance engine reads the day (verification 2026-11-19, correctness #1 / #2): a birthday
    # whose only punch closes the previous night is NOT worked (paid birthday leave, so its Casual Leave is free); a
    # Casual Leave day the employee then came in on IS worked
    worked = worked_days([(employees[emp_id], d) for emp_id, d in new_rule])
    # a birthday already turned into an APPROVED credit (worked, then its punches were corrected away) is never also a
    # free Casual Leave day: one benefit per birthday (the same check as attendance_final._approved_birthday_credit)
    credited = set(
        HolidayWorkClaim.objects.filter(
            kind=HolidayWorkClaim.KIND_BIRTHDAY,
            status=HolidayWorkClaim.STATUS_APPROVED,
            employee_id__in={emp_id for emp_id, _d in new_rule},
            work_date__in={d for _e, d in new_rule},
        ).values_list("employee_id", "work_date")
    )
    unworked = new_rule - worked - credited
    if unworked:
        # ... and a birthday that already gave an approved Birthday Compensation use (2026-11-25) is not free either: the
        # same guard as attendance_final._approved_birthday_credit (one query, only when an unworked birthday is left)
        from .models import BirthdayCompensationUse

        unworked -= set(
            BirthdayCompensationUse.objects.filter(
                status=BirthdayCompensationUse.STATUS_APPROVED,
                employee_id__in={emp_id for emp_id, _d in unworked},
                birthday__in={d for _e, d in unworked},
            ).values_list("employee_id", "birthday")
        )
    return unworked


def is_hr_edit_cl(cl) -> bool:
    """A Casual Leave written by an approved HR attendance edit (its approval trail carries the edit's id)."""
    return any(str(e.get("via") or "") == "attendance_correction" for e in (cl.approval_trail or []))


ASSIGN_VIA = "carry_forward"  # approval_trail "via" of a Casual Leave HR gave for an absent date (Carry Forward tab)


def is_assigned_cl(cl) -> bool:
    """A Casual Leave HR gave for an absent date on the Carry Forward tab."""
    return any(str(e.get("via") or "") == ASSIGN_VIA for e in (cl.approval_trail or []))


def source_of(cl) -> str:
    if is_assigned_cl(cl):
        return "hr_assign"
    return "hr_edit" if is_hr_edit_cl(cl) else "employee"


def hr_edit_id_of(cl) -> int | None:
    for e in cl.approval_trail or []:
        if str(e.get("via") or "") == "attendance_correction" and e.get("attendanceEditId"):
            return int(e["attendanceEditId"])
    return None


def parts(employee_ids, start: date, end: date, exclude_override_ids=()) -> dict[int, list[Part]]:
    """{employee id: [Part, ...]} for every Casual Leave day held between start and end (both included): pending and
    approved requests, plus Casual Leave proposed on the Attendance Edit page that is still waiting. Two queries (more
    only when a Casual Leave falls on the employee's birthday: new_rule_birthdays marks those Part.birthday)."""
    from django.db.models import F

    from .models import AttendanceOverrideRequest, CasualLeaveRequest

    ids = list(employee_ids)
    out: dict[int, list[Part]] = {i: [] for i in ids}
    if not ids or start > end:
        return out
    who = {"emp_dob": F("employee__date_of_birth"), "emp_kind": F("employee__employment_type")}
    candidates = []
    for cl in (
        CasualLeaveRequest.objects.filter(
            employee_id__in=ids, date__range=(start, end), status__in=("pending", "approved")
        )
        .annotate(**who)
        .order_by("date", "id")
    ):
        candidates.append((cl.employee_id, cl.emp_dob, cl.emp_kind, cl.date))
        out[cl.employee_id].append(
            Part(
                cl.employee_id,
                cl.date,
                portion_of(cl.portion),
                cl.status,
                cl.id,
                "casual_leave",
                source_of(cl),
                cl.created_at,
                cl.reviewed_at,
                is_assigned_cl(cl),
            )
        )
    proposed = AttendanceOverrideRequest.objects.filter(
        employee_id__in=ids,
        date__range=(start, end),
        status=AttendanceOverrideRequest.STATUS_PENDING,
        requested_values__option=HR_EDIT_OPTION,
    ).exclude(pk__in=list(exclude_override_ids))
    for req in proposed.annotate(**who).order_by("date", "id"):
        candidates.append((req.employee_id, req.emp_dob, req.emp_kind, req.date))
        out[req.employee_id].append(
            Part(
                req.employee_id,
                req.date,
                portion_of((req.requested_values or {}).get("portion")),
                "pending",
                req.id,
                "attendance_correction",
                "hr_edit",
                req.created_at,
                None,
            )
        )
    birthdays = new_rule_birthdays(candidates)
    if birthdays:
        for emp_id, held in out.items():
            out[emp_id] = [replace(p, birthday=True) if (emp_id, p.date) in birthdays else p for p in held]
    return out


# ── the policy (Settings -> Casual Leave, owner 2026-11-21) ───────────────────────────────────────────────────────────


@dataclass(frozen=True)
class Policy:
    """CasualLeavePolicy as the engine reads it (see models/leave.py)."""

    basis: str = "months"  # "months" | "days": how the service needed before Casual Leave is counted
    service: int = 6  # that many months / days after joining
    allocation: str = "monthly"  # "monthly" (earned each month) | "yearly" (the year's days at once)
    monthly: Decimal = Decimal("1")
    yearly: Decimal = Decimal("12")
    carry_forward: bool = True  # monthly: unused days stay for later months of the year (no monthly limit on them)
    year_end_carry: bool = False  # unused days on 31 December move into the next year (else they lapse)
    year_end_cap: Decimal | None = None  # at most this many move (None = all)
    half_day: bool = True

    @property
    def monthly_mode(self) -> bool:
        return self.allocation == "monthly"

    @property
    def carries_within_year(self) -> bool:
        """Unused days stay for later months: always with the yearly allocation, by the switch with the monthly one."""
        return self.carry_forward or not self.monthly_mode

    @property
    def carries_into_next_year(self) -> bool:
        return self.year_end_carry and self.carries_within_year

    def service_text(self) -> str:
        unit = "month" if self.basis == "months" else "day"
        return f"{self.service} {unit}{'' if self.service == 1 else 's'} of service"

    def allocation_text(self) -> str:
        if self.monthly_mode:
            return f"{number(self.monthly)} day{'' if self.monthly == 1 else 's'} a month"
        return f"{number(self.yearly)} days a year"


DEFAULT_POLICY = Policy()


def policy() -> Policy:
    """The policy HR saved (Settings -> Casual Leave); the defaults while nothing was saved. Read-only (the reports read
    it too and never write): the row is only created when HR saves the policy."""
    from .models import CasualLeavePolicy

    row = CasualLeavePolicy.objects.filter(pk=1).first()
    if row is None:
        return DEFAULT_POLICY
    return Policy(
        basis="days" if row.eligibility_basis == "days" else "months",
        service=max(0, int(row.eligibility_value or 0)),
        allocation="yearly" if row.allocation == "yearly" else "monthly",
        monthly=Decimal(str(row.monthly_allocation)),
        yearly=Decimal(str(row.yearly_allocation)),
        carry_forward=bool(row.carry_forward),
        year_end_carry=bool(row.year_end_carry),
        year_end_cap=Decimal(str(row.year_end_carry_max)) if row.year_end_carry_max is not None else None,
        half_day=bool(row.half_day_allowed),
    )


# ── service before Casual Leave ───────────────────────────────────────────────────────────────────────────────────


def parse_join_date(raw) -> date | None:
    """Employee.join_date as a date (it is stored as text: "2024-01-15", "15-01-2024", "15/01/2024"); None when unknown."""
    if not raw:
        return None
    if isinstance(raw, date):
        return raw
    text = str(raw).strip()[:10]
    for fmt in ("%Y-%m-%d", "%d-%m-%Y", "%d/%m/%Y", "%Y/%m/%d"):
        try:
            return datetime.strptime(text, fmt).date()
        except ValueError:
            continue
    return None


def months_between(joined: date, on: date) -> int:
    """Completed months from `joined` to `on`."""
    months = (on.year - joined.year) * 12 + (on.month - joined.month)
    if on.day < joined.day:
        months -= 1
    return max(0, months)


def eligible_from(joined: date, pol: Policy | None = None) -> date:
    """The first day on which an employee who joined on `joined` has the service the policy asks for: `service` completed
    months (joining on the 31st lands on the month's last day when the target month is shorter) or `service` days."""
    from datetime import timedelta

    pol = pol or policy()
    if pol.basis == "days":
        return joined + timedelta(days=pol.service)
    total = joined.month - 1 + pol.service
    year, month = joined.year + total // 12, total % 12 + 1
    on = date(year, month, min(joined.day, calendar.monthrange(year, month)[1]))
    while months_between(joined, on) < pol.service:
        on = date.fromordinal(on.toordinal() + 1)
    return on


def service_done(joined: date, on: date, pol: Policy | None = None) -> str:
    """The service completed by `on`, in the policy's unit ("4 months", "120 days")."""
    pol = pol or policy()
    if pol.basis == "days":
        n = max(0, (on - joined).days)
        return f"{n} day{'' if n == 1 else 's'}"
    n = months_between(joined, on)
    return f"{n} month{'' if n == 1 else 's'}"


# ── the year's ledger: what is given, used and left, month by month ─────────────────────────────────────────────


@dataclass
class YearLedger:
    year: int
    start: date | None  # the first day that earns / counts (None: nothing this year)
    carried_in: Decimal
    allocated: list[Decimal]  # 12 months
    used: list[Decimal]  # approved, by the month it counts in
    pending: list[Decimal]
    pol: Policy

    def _slack(self, k: int) -> Decimal:
        """Days left after month k (0-based) once everything held up to it is taken off."""
        return (
            self.carried_in
            + sum(self.allocated[: k + 1], Decimal("0"))
            - sum(self.used[: k + 1], Decimal("0"))
            - sum(self.pending[: k + 1], Decimal("0"))
        )

    def available(self, month: int) -> Decimal:
        """What may still be asked for with a date in `month` (1-12): with carry, the least left in this or any later
        month of the year (a Casual Leave already asked for in a later month keeps its days); without carry, what is left
        of this month's own days."""
        if self.start is None or month < self.start.month:
            return Decimal("0")
        i = month - 1
        if not self.pol.carries_within_year:
            return max(Decimal("0"), self.allocated[i] - self.used[i] - self.pending[i])
        return max(Decimal("0"), min(self._slack(k) for k in range(i, 12)))

    def given_through(self, month: int) -> Decimal:
        """Carried in + every month's days up to and including `month`."""
        return self.carried_in + sum(self.allocated[:month], Decimal("0"))

    def left_at_year_end(self) -> Decimal:
        if self.start is None:
            return Decimal("0")
        if not self.pol.carries_within_year:
            return Decimal("0")
        return max(Decimal("0"), self._slack(11))

    def carried_out(self) -> Decimal:
        """What moves into the next year (0 when unused days lapse)."""
        if not self.pol.carries_into_next_year:
            return Decimal("0")
        left = self.left_at_year_end()
        return min(left, self.pol.year_end_cap) if self.pol.year_end_cap is not None else left


def _start(year: int, cut_over: date, joined: date | None, pol: Policy) -> date | None:
    """The first day of `year` that earns / counts: the latest of 1 January, the policy's start (cut-over) and the day the
    employee has the service; None when that is after the year. An unknown join date sets no service limit here (as the
    balance always did): asking for Casual Leave is refused until HR sets it (casual_leave_views.service_refusal)."""
    first = max(date(year, 1, 1), cut_over)
    if joined is not None:
        first = max(first, eligible_from(joined, pol))
    return first if first.year == year else None


def _month_of(p: Part, start: date) -> int:
    """The month a held Casual Leave counts in: its own; one HR gave for an absent date before the start counts in the
    start's month."""
    return p.date.month if p.date >= start else start.month


def _counted(p: Part, year: int, start: date, cut_over: date) -> bool:
    if p.birthday or p.date.year != year:
        return False
    return p.assigned or (p.date >= start and counts(p.date, cut_over))


def _ledger(year, start, carried_in, held, cut_over, pol) -> YearLedger:
    zero = [Decimal("0")] * 12
    ledger = YearLedger(year, start, carried_in, list(zero), list(zero), list(zero), pol)
    if start is None:
        return ledger
    if pol.monthly_mode:
        for m in range(start.month, 13):
            ledger.allocated[m - 1] = pol.monthly
    else:
        ledger.allocated[start.month - 1] = pol.yearly
    for p in held:
        if not _counted(p, year, start, cut_over):
            continue
        i = _month_of(p, start) - 1
        if p.status == "approved":
            ledger.used[i] += p.days
        else:
            ledger.pending[i] += p.days
    return ledger


def ledgers(
    employee_ids, year: int, cut_over: date | None = None, pol: Policy | None = None, exclude_override_ids=()
) -> dict[int, YearLedger]:
    """{employee id: the year's ledger} in a fixed number of queries. When unused days move into the next year, the earlier
    years since the cut-over are worked out too (their leftovers are this year's carried-in days)."""
    from .models import Employee

    cut_over = cut_over or since()
    pol = pol or policy()
    ids = list(employee_ids)
    joined = {
        e_id: parse_join_date(raw) for e_id, raw in Employee.objects.filter(pk__in=ids).values_list("id", "join_date")
    }
    first_year = cut_over.year if pol.carries_into_next_year else year
    out: dict[int, YearLedger] = {}
    if year < cut_over.year:
        return {i: _ledger(year, None, Decimal("0"), [], cut_over, pol) for i in ids}
    held = parts(ids, date(min(first_year, year), 1, 1), date(year, 12, 31), exclude_override_ids=exclude_override_ids)
    for emp_id in ids:
        carried = Decimal("0")
        for y in range(min(first_year, year), year + 1):
            start = _start(y, cut_over, joined.get(emp_id), pol)
            mine = [p for p in held.get(emp_id, []) if p.date.year == y]
            ledger = _ledger(y, start, carried, mine, cut_over, pol)
            carried = ledger.carried_out()
        out[emp_id] = ledger
    return out


def ledger(emp, year: int, exclude_override_ids=(), cut_over: date | None = None, pol: Policy | None = None):
    return ledgers([emp.pk], year, cut_over, pol, exclude_override_ids)[emp.pk]


def _reference_month(ledger: YearLedger, today: date) -> int:
    """The month whose balance a screen shows: this month in the running year (the first month that earns while the
    balance has not started yet: what it starts with), December for a past year, the first month that earns for a later
    year."""
    if ledger.year < today.year:
        return 12
    first = ledger.start.month if ledger.start else 1
    if ledger.year > today.year:
        return first
    return max(today.month, first)


def balance_json(ledger: YearLedger, cut_over: date, today: date | None = None) -> dict:
    """The balance block every screen reads (same keys as before 2026-11-21, plus the policy's)."""
    from .clock import ist_today

    today = today or ist_today()
    ref = _reference_month(ledger, today)
    used = sum(ledger.used, Decimal("0"))
    pending = sum(ledger.pending, Decimal("0"))
    remaining = ledger.available(ref)
    pol = ledger.pol
    return {
        # what has been given so far: carried in + every month's days up to the month shown (the year's days at once with
        # the yearly allocation)
        "total": number(ledger.given_through(ref) if ledger.start else Decimal("0")),
        "used": number(used),
        "pending": number(pending),
        "remaining": number(remaining),
        "year": ledger.year,
        "since": ledger.start.isoformat() if ledger.start else None,
        "endsOn": date(ledger.year, 12, 31).isoformat(),
        "cutOver": cut_over.isoformat(),
        "tracked": ledger.start is not None,
        # added 2026-11-21 (Settings -> Casual Leave)
        "asOf": date(ledger.year, ref, 1).strftime("%Y-%m"),
        "allocation": pol.allocation,
        "perMonth": number(pol.monthly) if pol.monthly_mode else None,
        "perYear": number(pol.yearly) if not pol.monthly_mode else None,
        "carriedIn": number(ledger.carried_in),
        "carryForward": pol.carries_within_year,
        "yearEnd": "carry" if pol.carries_into_next_year else "lapse",
        "leftAtYearEnd": number(ledger.left_at_year_end()),
    }


def balance(emp, year: int, exclude_override_ids=(), cut_over: date | None = None, today: date | None = None) -> dict:
    cut_over = cut_over or since()
    return balance_json(ledger(emp, year, exclude_override_ids, cut_over), cut_over, today)


def balances(employee_ids, year: int, cut_over: date | None = None, today: date | None = None) -> dict[int, dict]:
    """{employee id: balance block} for many employees in a fixed number of queries (the HR Casual Leave board)."""
    cut_over = cut_over or since()
    return {i: balance_json(led, cut_over, today) for i, led in ledgers(employee_ids, year, cut_over).items()}


def available_on(emp, d: date, exclude_override_ids=(), cut_over: date | None = None) -> Decimal:
    """What may still be asked for with the date `d` (the month's own days and, with carry, the unused ones before it)."""
    return ledger(emp, d.year, exclude_override_ids, cut_over).available(d.month)


def remaining_days(emp, year: int, exclude_override_ids=(), cut_over: date | None = None) -> Decimal:
    """The balance the screens show for `year` (this month's, in the running year)."""
    return Decimal(str(balance(emp, year, exclude_override_ids, cut_over)["remaining"]))


def day_parts(emp, d: date, exclude_override_ids=()) -> list[Part]:
    """The Casual Leave already held on one date (to refuse the same half twice, or a full day over a half)."""
    return parts([emp.pk], d, d, exclude_override_ids=exclude_override_ids)[emp.pk]


def left_word(remaining) -> str:
    """The older per-month `left` value from a balance: "full" (a whole day or more), "one_half" or "nothing"."""
    remaining = Decimal(str(remaining))
    if remaining >= 1:
        return "full"
    return "one_half" if remaining >= Decimal("0.5") else "nothing"


def month_usage(emp, year: int, cut_over: date | None = None) -> list[dict]:
    """The twelve months of `year`: the days given, used (approved), waiting (pending) and still available, the days dated
    before the cut-over (never deducted) and every part, so the apps can draw the year."""
    cut_over = cut_over or since()
    led = ledger(emp, year, cut_over=cut_over)
    held = parts([emp.pk], date(year, 1, 1), date(year, 12, 31))[emp.pk]
    out = []
    for month in range(1, 13):
        mine = [p for p in held if p.date.month == month]
        counted = [p for p in mine if p.counts(cut_over)]
        before = [p for p in mine if not p.counts(cut_over) and not p.birthday]
        last_day = date(year, month, calendar.monthrange(year, month)[1])
        out.append(
            {
                "month": f"{year:04d}-{month:02d}",
                "label": f"{MONTH_NAMES[month - 1]} {year}",
                "used": number(sum((p.days for p in counted if p.status == "approved"), Decimal("0"))),
                "pending": number(sum((p.days for p in counted if p.status == "pending"), Decimal("0"))),
                "beforeCutOver": number(sum((p.days for p in before), Decimal("0"))),
                # "yearly_balance" when the month has any day on/after the cut-over (the policy's balance applies), else
                # "one_per_month" (the old rule)
                "rule": "yearly_balance" if counts(last_day, cut_over) else "one_per_month",
                # added 2026-11-21: the month's own days and what may still be asked for in it
                "allocated": number(led.allocated[month - 1]),
                "available": number(led.available(month)),
                "parts": [{**p.to_json(), "counted": p.counts(cut_over)} for p in mine],
            }
        )
    return out


# ── usage history ("2 -> 1 on 3 Nov: Casual Leave approved") ───────────────────────────────────────────────────────


def _ist(moment) -> date | None:
    from .clock import FACTORY_TZ

    if moment is None:
        return None
    if isinstance(moment, datetime):
        return moment.astimezone(FACTORY_TZ).date() if moment.tzinfo else moment.date()
    return moment


def _fmt(value: Decimal) -> str:
    return str(number(value))


def _days_text(value: Decimal) -> str:
    return f"{_fmt(value)} day{'' if value == 1 else 's'}"


def history(emp, year: int, today: date | None = None, cut_over: date | None = None) -> dict:
    """The year's balance as a running story, oldest first: what was carried in, each month's days (or the year's at once)
    as they are given, one line per Casual Leave that counts (approved: on the day it was approved; waiting: on the day it
    was asked for; rejected: on the day it was rejected, with no days used; Casual Leave HR gave for an absent / leave day
    counts whatever its date), unused days of a month that lapse when nothing carries over, and once the year is over the
    days that lapse or move into the next year. The last line's balance is today's balance."""
    from .clock import ist_today
    from .models import AttendanceOverrideRequest, CasualLeaveRequest

    cut_over = cut_over or since()
    today = today or ist_today()
    led = ledger(emp, year, cut_over=cut_over)
    pol = led.pol
    head = {
        "employeeId": emp.pk,
        "year": year,
        "total": number(led.given_through(12)) if led.start else 0,
        "balance": balance_json(led, cut_over, today),
    }
    if led.start is None:
        return {**head, "entries": []}
    start, end = led.start, date(year, 12, 31)

    events: list[tuple] = []  # (day, order, created, kind, change, payload)
    blank = {
        "date": None,
        "portion": None,
        "portionLabel": None,
        "days": None,
        "requestId": None,
        "requestKind": None,
        "source": None,
        "status": None,
    }
    # the first line: what the year opens with (carried in, plus the year's days at once with the yearly allocation)
    opening = led.carried_in + (Decimal("0") if pol.monthly_mode else led.allocated[start.month - 1])
    events.append((start, 0, None, "opening", opening, dict(blank)))
    if pol.monthly_mode:
        for m in range(start.month, 13):
            amount = led.allocated[m - 1]
            on = start if m == start.month else date(year, m, 1)
            if amount and on <= max(today, start):
                events.append((on, 1, None, "allocated", amount, {**blank, "days": number(amount), "month": m}))

    requests = list(
        CasualLeaveRequest.objects.filter(employee=emp, date__range=(date(year, 1, 1), end)).order_by(
            "created_at", "id"
        )
    )
    proposals = list(
        AttendanceOverrideRequest.objects.filter(
            employee=emp,
            date__range=(start, end),
            status=AttendanceOverrideRequest.STATUS_PENDING,
            requested_values__option=HR_EDIT_OPTION,
        ).order_by("created_at", "id")
    )
    # a Casual Leave on a new-rule birthday is a paid birthday leave: listed, but it uses no days
    birthdays = new_rule_birthdays(
        (emp.pk, emp.date_of_birth, emp.employment_type, row.date) for row in [*requests, *proposals]
    )
    for cl in requests:
        if (cl.date < start or not counts(cl.date, cut_over)) and not is_assigned_cl(cl):
            continue  # before the policy started (or before the service was done): never counted
        portion = portion_of(cl.portion)
        days = PORTION_DAYS[portion]
        change = Decimal("0") if (emp.pk, cl.date) in birthdays else -days
        base = {
            "date": cl.date.isoformat(),
            "portion": portion,
            "portionLabel": PORTION_LABEL[portion],
            "days": number(days),
            "requestId": cl.id,
            "requestKind": "casual_leave",
            "source": source_of(cl),
            "status": cl.status,
            "birthday": (emp.pk, cl.date) in birthdays,
        }
        if cl.status == "approved":
            events.append((_ist(cl.reviewed_at) or _ist(cl.created_at), 2, cl.created_at, "approved", change, base))
        elif cl.status == "pending":
            events.append((_ist(cl.created_at), 2, cl.created_at, "pending", change, base))
        elif cl.status == "rejected":
            events.append(
                (_ist(cl.reviewed_at) or _ist(cl.created_at), 2, cl.created_at, "rejected", Decimal("0"), base)
            )
    for req in proposals:
        portion = portion_of((req.requested_values or {}).get("portion"))
        days = PORTION_DAYS[portion]
        events.append(
            (
                _ist(req.created_at),
                2,
                req.created_at,
                "pending",
                Decimal("0") if (emp.pk, req.date) in birthdays else -days,
                {
                    "date": req.date.isoformat(),
                    "portion": portion,
                    "portionLabel": PORTION_LABEL[portion],
                    "days": number(days),
                    "requestId": req.id,
                    "requestKind": "attendance_correction",
                    "source": "hr_edit",
                    "status": "pending",
                    "birthday": (emp.pk, req.date) in birthdays,
                },
            )
        )
    # without carry, a month's unused days lapse when the month is over
    if not pol.carries_within_year:
        for m in range(start.month, 13):
            last = date(year, m, calendar.monthrange(year, m)[1])
            left = led.allocated[m - 1] - led.used[m - 1] - led.pending[m - 1]
            if last < today and left > 0:
                events.append((last, 3, None, "month_lapsed", -left, {**blank, "days": number(left), "month": m}))
    events.sort(key=lambda e: (e[0] or start, e[1], e[2].timestamp() if e[2] else 0.0))

    left = Decimal("0")
    entries = []
    for on, _order, _created, kind, change, base in events:
        before, after = left, left + change
        left = after
        when = (on or start).strftime("%d %b")
        if kind == "opening":
            carried = f"{_days_text(led.carried_in)} carried over from {year - 1}"
            if not pol.monthly_mode:
                text = f"{_fmt(after)} Casual Leave days for {year}, from {start.strftime('%d %b %Y')}"
                text += f" (with {carried})" if led.carried_in else ""
            elif led.carried_in:
                text = f"{_fmt(after)} on {when}: {carried}"
            else:
                text = f"Casual Leave for {year} from {start.strftime('%d %b %Y')}: {pol.allocation_text()}"
        elif kind == "allocated":
            what = (
                f"{MONTH_NAMES[base['month'] - 1]}'s Casual Leave" if pol.monthly_mode else f"Casual Leave for {year}"
            )
            text = f"{_fmt(before)} → {_fmt(after)} on {when}: {what} (+{_fmt(change)})"
        elif kind == "month_lapsed":
            text = (
                f"{_fmt(before)} → {_fmt(after)} on {when}: {_days_text(-change)} of "
                f"{MONTH_NAMES[base['month'] - 1]} not used (unused days do not carry over)"
            )
        else:
            cl_day = date.fromisoformat(base["date"]).strftime("%d %b %Y")
            what = f"{base['portionLabel']}, {cl_day}"
            by_hr = base["source"] == "hr_edit"
            if base.get("birthday") and kind != "rejected":
                did = "Casual Leave on the birthday: paid birthday leave, no balance used"
            elif kind == "approved" and base["source"] == "hr_assign":
                did = "Casual Leave given by HR for an absent / leave / half day"
            elif kind == "approved":
                did = "Casual Leave given by HR (attendance edit), approved" if by_hr else "Casual Leave approved"
            elif kind == "pending":
                did = (
                    "Casual Leave proposed by HR (attendance edit), waiting for approval"
                    if by_hr
                    else "Casual Leave asked for, waiting for approval"
                )
            else:
                did = "Casual Leave rejected (no days used)"
            text = f"{_fmt(before)} → {_fmt(after)} on {when}: {did} ({what})"
        entries.append(
            {
                **{k: v for k, v in base.items() if k != "month"},
                "kind": kind,
                "on": (on or start).isoformat(),
                "change": number(change),
                "balanceBefore": number(before) if kind != "opening" else None,
                "balanceAfter": number(after),
                "text": text,
            }
        )
    if today > end and pol.carries_within_year and left > 0:
        moved = led.carried_out()
        lapsed = left - moved
        if moved:
            entries.append(
                {
                    **blank,
                    "kind": "carried_out",
                    "on": end.isoformat(),
                    "days": number(moved),
                    "change": number(-moved),
                    "balanceBefore": number(left),
                    "balanceAfter": number(left - moved),
                    "text": f"{_fmt(left)} → {_fmt(left - moved)} on 31 Dec: {_days_text(moved)} carried into {year + 1}",
                }
            )
            left -= moved
        if lapsed > 0:
            entries.append(
                {
                    **blank,
                    "kind": "lapsed",
                    "on": end.isoformat(),
                    "days": number(lapsed),
                    "change": number(-lapsed),
                    "balanceBefore": number(left),
                    "balanceAfter": 0,
                    "text": f"{_fmt(left)} → 0 on 31 Dec: unused Casual Leave lapsed",
                }
            )
    return {**head, "entries": entries}

"""Casual Leave yearly balance (owner 2026-11-02).

Every eligible staff member has ENTITLEMENT (12) Casual Leave days a calendar year and may use them any time while the
balance lasts (a half day counts 0.5). It replaced "one Casual Leave per calendar month" for every date on/after the
cut-over (PayrollSettings.cl_balance_since, 2026-11-02 by default): everyone started FRESH at 12 that day, Casual Leave
dated earlier never counts against the balance (and keeps the old one-per-month rule). Unused days lapse on 31 December;
a fresh 12 starts on 1 January.

    balance(year) = 12 - (approved + pending Casual Leave days dated in the year, on/after max(cut-over, 1 January))

Pending counts so nobody can ask for more than is left while requests wait; a rejected (or deleted) request frees its days
again. A Casual Leave HR proposes from the Attendance Edit page counts as pending while that attendance change waits for
the Department Head and HR (it becomes a real approved Casual Leave when both approve: attendance_edit._apply_casual_leave),
so the employee cannot use the same days twice in the meantime.

Read-only: nothing here writes anything.
"""

from __future__ import annotations

import calendar
from dataclasses import dataclass
from datetime import date, datetime
from decimal import Decimal

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
    """The cut-over day: Casual Leave dated on/after it counts against the yearly balance."""
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
    source: str  # "employee" (asked for in the apps / by HR on the Casual Leave page) | "hr_edit"
    created_at: datetime | None = None
    decided_at: datetime | None = None

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
        }


def is_hr_edit_cl(cl) -> bool:
    """A Casual Leave written by an approved HR attendance edit (its approval trail carries the edit's id)."""
    return any(str(e.get("via") or "") == "attendance_correction" for e in (cl.approval_trail or []))


def hr_edit_id_of(cl) -> int | None:
    for e in cl.approval_trail or []:
        if str(e.get("via") or "") == "attendance_correction" and e.get("attendanceEditId"):
            return int(e["attendanceEditId"])
    return None


def parts(employee_ids, start: date, end: date, exclude_override_ids=()) -> dict[int, list[Part]]:
    """{employee id: [Part, ...]} for every Casual Leave day held between start and end (both included): pending and
    approved requests, plus Casual Leave proposed on the Attendance Edit page that is still waiting. Two queries."""
    from .models import AttendanceOverrideRequest, CasualLeaveRequest

    ids = list(employee_ids)
    out: dict[int, list[Part]] = {i: [] for i in ids}
    if not ids or start > end:
        return out
    for cl in CasualLeaveRequest.objects.filter(
        employee_id__in=ids, date__range=(start, end), status__in=("pending", "approved")
    ).order_by("date", "id"):
        out[cl.employee_id].append(
            Part(
                cl.employee_id,
                cl.date,
                portion_of(cl.portion),
                cl.status,
                cl.id,
                "casual_leave",
                "hr_edit" if is_hr_edit_cl(cl) else "employee",
                cl.created_at,
                cl.reviewed_at,
            )
        )
    proposed = AttendanceOverrideRequest.objects.filter(
        employee_id__in=ids,
        date__range=(start, end),
        status=AttendanceOverrideRequest.STATUS_PENDING,
        requested_values__option=HR_EDIT_OPTION,
    ).exclude(pk__in=list(exclude_override_ids))
    for req in proposed.order_by("date", "id"):
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
    return out


def balance_json(held: list[Part], year: int, cut_over: date) -> dict:
    """The balance block every screen reads. `held` = the Parts of the year's balance window."""
    win = window(year, cut_over)
    counted = [p for p in held if win is not None and win[0] <= p.date <= win[1]]
    used = sum((p.days for p in counted if p.status == "approved"), Decimal("0"))
    pending = sum((p.days for p in counted if p.status == "pending"), Decimal("0"))
    remaining = max(Decimal("0"), ENTITLEMENT - used - pending)
    return {
        "total": ENTITLEMENT,
        "used": number(used),
        "pending": number(pending),
        "remaining": number(remaining),
        "year": year,
        # the first day of the year that counts (the cut-over in its own year, else 1 January); None = no balance is kept
        # for this year (it is wholly before the cut-over)
        "since": win[0].isoformat() if win else None,
        "endsOn": date(year, 12, 31).isoformat(),
        "cutOver": cut_over.isoformat(),
        "tracked": win is not None,
    }


def balance(emp, year: int, exclude_override_ids=(), cut_over: date | None = None) -> dict:
    cut_over = cut_over or since()
    win = window(year, cut_over)
    held = parts([emp.pk], *win, exclude_override_ids=exclude_override_ids)[emp.pk] if win else []
    return balance_json(held, year, cut_over)


def balances(employee_ids, year: int, cut_over: date | None = None) -> dict[int, dict]:
    """{employee id: balance block} for many employees in two queries (the HR Casual Leave board)."""
    cut_over = cut_over or since()
    win = window(year, cut_over)
    ids = list(employee_ids)
    held = parts(ids, *win) if win else {i: [] for i in ids}
    return {i: balance_json(held.get(i, []), year, cut_over) for i in ids}


def remaining_days(emp, year: int, exclude_override_ids=(), cut_over: date | None = None) -> Decimal:
    return Decimal(str(balance(emp, year, exclude_override_ids, cut_over)["remaining"]))


def day_parts(emp, d: date, exclude_override_ids=()) -> list[Part]:
    """The Casual Leave already held on one date (to refuse the same half twice, or a full day over a half)."""
    return parts([emp.pk], d, d, exclude_override_ids=exclude_override_ids)[emp.pk]


def left_word(remaining) -> str:
    """The older per-month `left` value from a yearly balance: "full" (a whole day or more), "one_half" or "nothing"."""
    remaining = Decimal(str(remaining))
    if remaining >= 1:
        return "full"
    return "one_half" if remaining >= Decimal("0.5") else "nothing"


def month_usage(emp, year: int, cut_over: date | None = None) -> list[dict]:
    """The twelve months of `year`: the Casual Leave days used (approved) and waiting (pending) that count against the
    balance, the days dated before the cut-over (never deducted) and every part, so the apps can draw the year."""
    cut_over = cut_over or since()
    held = parts([emp.pk], date(year, 1, 1), date(year, 12, 31))[emp.pk]
    out = []
    for month in range(1, 13):
        mine = [p for p in held if p.date.month == month]
        counted = [p for p in mine if counts(p.date, cut_over)]
        before = [p for p in mine if not counts(p.date, cut_over)]
        last_day = date(year, month, calendar.monthrange(year, month)[1])
        out.append(
            {
                "month": f"{year:04d}-{month:02d}",
                "label": f"{MONTH_NAMES[month - 1]} {year}",
                "used": number(sum((p.days for p in counted if p.status == "approved"), Decimal("0"))),
                "pending": number(sum((p.days for p in counted if p.status == "pending"), Decimal("0"))),
                "beforeCutOver": number(sum((p.days for p in before), Decimal("0"))),
                # "yearly_balance" when the month has any day on/after the cut-over, else "one_per_month" (the old rule)
                "rule": "yearly_balance" if counts(last_day, cut_over) else "one_per_month",
                "parts": [{**p.to_json(), "counted": counts(p.date, cut_over)} for p in mine],
            }
        )
    return out


# ── usage history ("12 -> 11 on 3 Nov: Casual Leave approved") ─────────────────


def _ist(moment) -> date | None:
    from .clock import FACTORY_TZ

    if moment is None:
        return None
    if isinstance(moment, datetime):
        return moment.astimezone(FACTORY_TZ).date() if moment.tzinfo else moment.date()
    return moment


def _fmt(value: Decimal) -> str:
    return str(number(value))


def history(emp, year: int, today: date | None = None, cut_over: date | None = None) -> dict:
    """The year's balance as a running story, oldest first: the fresh 12, then one line per Casual Leave that counts
    (approved: on the day it was approved; waiting: on the day it was asked for; rejected: on the day it was rejected, with
    no days used), and, once the year is over, the unused days lapsing on 31 December. The last line's balance is today's
    balance."""
    from .clock import ist_today
    from .models import AttendanceOverrideRequest, CasualLeaveRequest

    cut_over = cut_over or since()
    today = today or ist_today()
    win = window(year, cut_over)
    head = {"employeeId": emp.pk, "year": year, "total": ENTITLEMENT, "balance": balance(emp, year, cut_over=cut_over)}
    if win is None:
        return {**head, "entries": []}

    events: list[tuple] = []  # (day, order, kind, change, payload)
    for cl in CasualLeaveRequest.objects.filter(employee=emp, date__range=win).order_by("created_at", "id"):
        portion = portion_of(cl.portion)
        days = PORTION_DAYS[portion]
        source = "hr_edit" if is_hr_edit_cl(cl) else "employee"
        base = {
            "date": cl.date.isoformat(),
            "portion": portion,
            "portionLabel": PORTION_LABEL[portion],
            "days": number(days),
            "requestId": cl.id,
            "requestKind": "casual_leave",
            "source": source,
            "status": cl.status,
        }
        if cl.status == "approved":
            on = _ist(cl.reviewed_at) or _ist(cl.created_at)
            events.append((on, cl.created_at, "approved", -days, base))
        elif cl.status == "pending":
            events.append((_ist(cl.created_at), cl.created_at, "pending", -days, base))
        elif cl.status == "rejected":
            on = _ist(cl.reviewed_at) or _ist(cl.created_at)
            events.append((on, cl.created_at, "rejected", Decimal("0"), base))
    for req in AttendanceOverrideRequest.objects.filter(
        employee=emp,
        date__range=win,
        status=AttendanceOverrideRequest.STATUS_PENDING,
        requested_values__option=HR_EDIT_OPTION,
    ).order_by("created_at", "id"):
        portion = portion_of((req.requested_values or {}).get("portion"))
        days = PORTION_DAYS[portion]
        events.append(
            (
                _ist(req.created_at),
                req.created_at,
                "pending",
                -days,
                {
                    "date": req.date.isoformat(),
                    "portion": portion,
                    "portionLabel": PORTION_LABEL[portion],
                    "days": number(days),
                    "requestId": req.id,
                    "requestKind": "attendance_correction",
                    "source": "hr_edit",
                    "status": "pending",
                },
            )
        )
    events.sort(key=lambda e: (e[0] or win[0], e[1].timestamp() if e[1] else 0.0))

    left = Decimal(ENTITLEMENT)
    entries = [
        {
            "kind": "opening",
            "on": win[0].isoformat(),
            "date": None,
            "portion": None,
            "portionLabel": None,
            "days": None,
            "change": ENTITLEMENT,
            "balanceBefore": None,
            "balanceAfter": ENTITLEMENT,
            "requestId": None,
            "requestKind": None,
            "source": None,
            "status": None,
            "text": f"{ENTITLEMENT} Casual Leave days for {year}, from {win[0].strftime('%d %b %Y')}",
        }
    ]
    for on, _created, kind, change, base in events:
        before, after = left, left + change
        left = after
        cl_day = date.fromisoformat(base["date"]).strftime("%d %b %Y")
        what = f"{base['portionLabel']}, {cl_day}"
        by_hr = base["source"] == "hr_edit"
        if kind == "approved":
            did = "Casual Leave given by HR (attendance edit), approved" if by_hr else "Casual Leave approved"
        elif kind == "pending":
            did = (
                "Casual Leave proposed by HR (attendance edit), waiting for approval"
                if by_hr
                else "Casual Leave asked for, waiting for approval"
            )
        else:
            did = "Casual Leave rejected (no days used)"
        when = (on or win[0]).strftime("%d %b")
        entries.append(
            {
                **base,
                "kind": kind,
                "on": (on or win[0]).isoformat(),
                "change": number(change),
                "balanceBefore": number(before),
                "balanceAfter": number(after),
                "text": f"{_fmt(before)} → {_fmt(after)} on {when}: {did} ({what})",
            }
        )
    if today > win[1] and left > 0:
        entries.append(
            {
                "kind": "lapsed",
                "on": win[1].isoformat(),
                "date": None,
                "portion": None,
                "portionLabel": None,
                "days": number(left),
                "change": number(-left),
                "balanceBefore": number(left),
                "balanceAfter": 0,
                "requestId": None,
                "requestKind": None,
                "source": None,
                "status": None,
                "text": f"{_fmt(left)} → 0 on 31 Dec: unused Casual Leave lapsed (a fresh {ENTITLEMENT} starts on 1 January)",
            }
        )
    return {**head, "entries": entries}

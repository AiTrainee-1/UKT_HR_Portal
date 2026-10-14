"""
Overtime and compensation reports.

Overtime here is the payroll concept, not a punch calculation: staff days that HR has detected, announced (as
paid overtime - ``shifts`` x the daily rate, a record from before the shift-based rules being ONE whole day - or as
relaxation) or rejected, plus the automatic next-day late-in allowance (status ``auto``, Type 1) that is listed for
information and never paid. The source of truth is the stored ``OvertimeRecord`` plus what the generated slip paid
(``ot_amount`` and the breakdown's ``otShifts`` / ``otDays`` / ``dailyRate``).
Nothing here runs overtime detection - that writes rows - so the reports show exactly what HR has on record.

The Compensation feature switch (Settings > Payroll) gates every report in this module: while it is off nothing is
detected, announced or paid, so the reports return an empty result with an explanation instead of zeros.
"""

from __future__ import annotations

from datetime import date, datetime, time, timedelta
from decimal import ROUND_HALF_UP, Decimal

from django.db.models import Count, Exists, OuterRef, Q, Sum

from api.branch_scope import get_branch_scope
from api.clock import FACTORY_TZ
from api.models import (
    CompensationDayAnnouncement,
    CompensationLeaveCredit,
    Department,
    Employee,
    OvertimeRecord,
    SalarySlip,
)

from ..filters import branches, date_range, departments, period, scope, select
from ..formatting import fmt_dt, month_bounds, month_label
from ..registry import register
from ..types import (
    BADGE,
    CURRENCY,
    DATE,
    DATETIME,
    HOURS,
    INTEGER,
    MINUTES,
    TEXT,
    TIME,
    ColumnSpec,
    ReportResult,
    ReportSpec,
)
from .payroll_statutory_common import (
    as_dict,
    dec,
    dec_or_none,
    dept_name,
    feature_off_result_notes,
    money,
    natural_key,
    read_settings,
    with_breakdown,
)

_ZERO = Decimal("0")
_ONE = Decimal("1")
_CENT = Decimal("0.01")
OT_MODULES = ("compensation", "payroll")
_STAFF_SLIP = dict(period_start__isnull=True, week_number__isnull=True)

_OT_PAY_NOTE = (
    "Overtime is paid per announced Pay-type record as its shifts (0.25 / 0.50 / 0.75 / 1) x the daily rate on that "
    "month's slip - a record from before the shift-based rules is one whole day - added to net pay outside gross "
    "salary, PF and ESI; minutes and hours are informational. Relaxation-type records give time off instead of pay, "
    "and the next-day late-in allowance (status Automatic) is listed for information only: it is never paid."
)
_OT_ROWS_NOTE = (
    "Only records on file are shown: overtime is detected when HR opens Compensation > OT Detection while an OT "
    "feature (Settings > Compensation) and the Compensation feature are on. This report never runs detection. "
    "Overtime is detected for staff only (production 'extra shifts' are already inside their gross pay)."
)
# How the register names an OvertimeRecord.status (the stored value 'auto' is the Type 1 next-day allowance).
_STATUS_LABEL = {"auto": "Automatic"}


def _months(d1: date, d2: date) -> list[tuple[int, int]]:
    out, y, m = [], d1.year, d1.month
    while (y, m) <= (d2.year, d2.month):
        out.append((y, m))
        y, m = (y + 1, 1) if m == 12 else (y, m + 1)
    return out


def _staff_slips(emp_ids, months):
    """{(employee id, year, month): staff SalarySlip} for the employees / months (newest slip wins)."""
    if not emp_ids or not months:
        return {}
    q = Q()
    for y, m in months:
        q |= Q(year=y, month=m)
    qs = with_breakdown(SalarySlip.objects.filter(q, employee_id__in=emp_ids, **_STAFF_SLIP), "bd_earn")
    return {(s.employee_id, s.year, s.month): s for s in qs.order_by("id")}


def _ist_bounds(d1: date, d2: date) -> tuple[datetime, datetime]:
    """Aware [start, end) datetimes covering the IST calendar days d1..d2 (created_at is stored in UTC)."""
    return (
        datetime.combine(d1, time.min, tzinfo=FACTORY_TZ),
        datetime.combine(d2 + timedelta(days=1), time.min, tzinfo=FACTORY_TZ),
    )


def _window(token: str, today: date) -> tuple[date | None, date | None]:
    if token == "thisMonth":
        return month_bounds(today.year, today.month)
    if token == "lastMonth":
        prev = today.replace(day=1) - timedelta(days=1)
        return month_bounds(prev.year, prev.month)
    if token == "last90":
        return today - timedelta(days=89), today
    if token == "thisYear":
        return date(today.year, 1, 1), date(today.year, 12, 31)
    if token == "upcoming":
        return today, None
    return None, None


def _hours(minutes) -> float:
    return round((minutes or 0) / 60, 2)


def _shifts_of(value) -> Decimal:
    """The shifts one Pay record pays: its own ``shifts`` (Type 2: 0.25 / 0.50 / 0.75 / 1), or ONE day when it has none
    (a record from before the shift-based rules, which payroll has always paid as a whole day)."""
    return Decimal(str(value)) if value is not None else _ONE


def _slip_ot_shifts(earn: dict) -> Decimal:
    """The shifts of OT pay a slip actually holds: the breakdown's ``otShifts`` (slips generated since the shift-based
    rules), else ``otDays`` (older slips: one whole day per Pay record)."""
    shifts = dec_or_none(earn.get("otShifts"))
    return shifts if shifts is not None else dec(earn.get("otDays"))


def _amount(rate: Decimal | None, shifts: Decimal) -> Decimal | None:
    """shifts x the daily rate in paise, rounded half up the way payroll rounds; None while the rate is unknown."""
    return None if rate is None else (rate * shifts).quantize(_CENT, rounding=ROUND_HALF_UP)


# -- overtime register ----------------------------------------------------------------------------------------
def _run_register(ctx) -> ReportResult:
    settings = read_settings()
    notes = feature_off_result_notes(settings, need_detection=True)
    if not settings.compensation_feature_enabled:
        return ReportResult(rows=[], notes=notes)

    d1, d2 = ctx.date_from, ctx.date_to
    qs = OvertimeRecord.objects.filter(ctx.emp_q("employee__"), date__gte=d1, date__lte=d2)
    status = ctx.param("status") or "all"
    if status != "all":
        qs = qs.filter(status=status)
    ctype = ctx.param("compensationType") or "all"
    if ctype != "all":
        qs = qs.filter(compensation_type=ctype)
    recs = list(
        qs.select_related("employee__department").order_by("employee__employee_code", "date", "id")[: ctx.row_limit]
    )
    recs.sort(key=lambda r: (natural_key(r.employee.employee_code), r.date, r.id))

    emp_ids = {r.employee_id for r in recs}
    months = _months(d1, d2)
    slips = _staff_slips(emp_ids, months)
    pay_counts: dict[tuple[int, int, int], int] = {}
    pay_shifts: dict[tuple[int, int, int], Decimal] = {}  # the shifts those records pay (payroll's own sum)
    if emp_ids:
        first, last = month_bounds(*months[0])[0], month_bounds(*months[-1])[1]
        pay_qs = (
            OvertimeRecord.objects.filter(
                employee_id__in=emp_ids, date__gte=first, date__lte=last, status="announced", compensation_type="pay"
            )
            .exclude(ot_type=OvertimeRecord.OT_TYPE_ALLOWANCE)  # payroll never pays the Type 1 allowance
            .values_list("employee_id", "date", "shifts")
        )
        for emp_id, d, shifts in pay_qs:
            pkey = (emp_id, d.year, d.month)
            pay_counts[pkey] = pay_counts.get(pkey, 0) + 1
            pay_shifts[pkey] = pay_shifts.get(pkey, _ZERO) + _shifts_of(shifts)
    credits = (
        {
            c.source_overtime_record_id: c
            for c in CompensationLeaveCredit.objects.filter(source_overtime_record_id__in=[r.id for r in recs])
        }
        if recs
        else {}
    )

    rows: list[dict] = []
    n = {"detected": 0, "announced": 0, "rejected": 0, "auto": 0, "relax": 0}
    pay_groups: dict[tuple[int, int, int], list[int]] = {}  # (employee, year, month) -> [listed pay rows, missing days]
    hours_total = _ZERO
    payable_total = _ZERO
    for r in recs:
        emp = r.employee
        key = (r.employee_id, r.date.year, r.date.month)
        slip = slips.get(key)
        earn = as_dict(slip.bd_earn) if slip else {}
        rate = dec_or_none(earn.get("dailyRate")) if slip else None
        is_pay = r.status == "announced" and r.compensation_type == "pay"
        outcome = payable = None
        if is_pay:
            # What the slip holds is a SHIFTS total (a record pays shifts x the daily rate), so "paid" compares shifts.
            paid_shifts = _slip_ot_shifts(earn)
            announced_shifts = pay_shifts.get(key, _ZERO)
            outcome = (
                "Paid in slip"
                if paid_shifts >= announced_shifts
                else ("Partly paid" if paid_shifts else "Awaiting payroll")
            )
            # A month's slip also counts the RECORDS it paid (otDays), so the records still missing are counted once
            # per employee-month (as the payment summary does) - not once for every listed row of a month that is
            # only partly paid.
            missing = max(0, pay_counts.get(key, 0) - int(dec(earn.get("otDays"))))
            group = pay_groups.setdefault(key, [0, missing])
            group[0] += 1
            payable = _amount(rate, _shifts_of(r.shifts))
            payable_total += payable or _ZERO
        elif r.status == "announced" and r.compensation_type == "relaxation":
            n["relax"] += 1
            credit = credits.get(r.id)
            if r.ot_type == OvertimeRecord.OT_TYPE_SHIFT:
                # Shift-based relaxation tops a day up (or goes to the balance) - it never makes a leave credit.
                outcome = f"Relaxation on {r.claim_date.strftime('%d %b')}" if r.claim_date else "Added to balance"
            else:
                outcome = (
                    "No credit"
                    if credit is None
                    else ("Credit used" if credit.status == "used" else "Credit available")
                )
        elif r.status == OvertimeRecord.STATUS_AUTO:
            # The next-day late-in allowance (Type 1): information only - nobody decides it and it is never paid.
            outcome = f"Allowance {r.allowance_minutes} min"
        n[r.status] = n.get(r.status, 0) + 1
        hours_total += Decimal(str(_hours(r.ot_minutes)))
        rows.append(
            {
                "employeeCode": emp.employee_code,
                "employeeName": f"{emp.first_name or ''} {emp.last_name or ''}".strip(),
                "department": dept_name(emp),
                "date": r.date.isoformat(),
                "shiftEndTime": r.shift_end_time,
                "lastPunchOut": r.last_punch_out,
                "otMinutes": r.ot_minutes,
                "otHours": _hours(r.ot_minutes),
                "status": _STATUS_LABEL.get(r.status, r.status.title()),
                "compensationType": r.compensation_type.title() if r.compensation_type else None,
                "outcome": outcome,
                "announcedBy": r.announced_by,
                "announcedAt": fmt_dt(r.announced_at),
                "payableAmount": money(payable),
            }
        )

    pay_pending = sum(min(listed, missing) for listed, missing in pay_groups.values())
    notes += [
        _OT_PAY_NOTE,
        _OT_ROWS_NOTE,
        "Payable = the row's shifts x the daily rate on the employee's generated slip for that month (a dash when no "
        "slip exists yet, and for rows that are never paid). "
        "Outcome: 'Paid in slip' = the slip's overtime shifts cover every announced Pay shift of that month; "
        "'Awaiting payroll' = announced after (or without) payroll generation - regenerate payroll to include it; "
        "'Partly paid' = the slip covers only some of the month's Pay shifts (the slip holds a total, not which "
        "records), and 'Pay days awaiting payroll' counts only the records the slip is still missing. "
        "An Automatic row is the next-day late-in allowance: its outcome is the minutes allowed on the next working "
        "day's first punch.",
    ]
    summary = [
        {"label": "Records", "value": len(rows), "format": "integer"},
        {"label": "Total OT hours (listed)", "value": money(hours_total), "format": "hours"},
        {"label": "Detected", "value": n["detected"], "format": "integer"},
        {"label": "Announced", "value": n["announced"], "format": "integer"},
        {"label": "Rejected", "value": n["rejected"], "format": "integer"},
        {"label": "Automatic (allowance)", "value": n["auto"], "format": "integer"},
        {"label": "Pay days awaiting payroll", "value": pay_pending, "format": "integer"},
        {"label": "Payable (where a slip exists)", "value": money(payable_total), "format": "currency"},
        {"label": "Relaxation credits granted", "value": n["relax"], "format": "integer"},
    ]
    return ReportResult(rows=rows, summary=summary, notes=notes)


register(
    ReportSpec(
        id="overtime-register",
        title="Overtime Register",
        description="Day-wise overtime on record: shift end, last punch, minutes, HR decision (pay or relaxation) and "
        "whether payroll has paid it, plus the automatic next-day late-in allowance (never paid).",
        category="payroll",
        icon="Clock",
        tags=("overtime", "ot", "compensation", "announced", "relaxation", "payroll"),
        family="overtime",
        variant="Register",
        modules=(
            "compensation",
        ),  # day-wise HR decisions are Compensation-page data; the Summary also opens for Payroll
        filters=(
            date_range(label="Overtime date"),
            *scope(status=None, employment=False),
            select(
                "status",
                "Status",
                [
                    ("all", "All"),
                    ("detected", "Detected"),
                    ("announced", "Announced"),
                    ("rejected", "Rejected"),
                    ("auto", "Automatic"),
                ],
                default="all",
            ),
            select(
                "compensationType",
                "Compensation",
                [("all", "All"), ("pay", "Pay"), ("relaxation", "Relaxation")],
                default="all",
            ),
        ),
        columns=(
            ColumnSpec("employeeCode", "Emp Code", TEXT, 1.0),
            ColumnSpec("employeeName", "Employee", TEXT, 2.2),
            ColumnSpec("department", "Department", TEXT, 1.4),
            ColumnSpec("date", "Date", DATE, 1.1),
            ColumnSpec("shiftEndTime", "Shift end", TIME, 0.8),
            ColumnSpec("lastPunchOut", "Last punch", TIME, 0.8),
            ColumnSpec("otMinutes", "OT minutes", MINUTES, 0.8, total="sum"),
            ColumnSpec("otHours", "OT hours", HOURS, 0.8, total="sum"),
            ColumnSpec("status", "Status", BADGE, 1.0),
            ColumnSpec("compensationType", "Comp. type", BADGE, 1.0),
            ColumnSpec("outcome", "Outcome", BADGE, 1.4),
            ColumnSpec("announcedBy", "Announced by", TEXT, 1.2),
            ColumnSpec("announcedAt", "Announced at", DATETIME, 1.7),
            ColumnSpec("payableAmount", "Payable", CURRENCY, 1.1, total="sum"),
        ),
        run=_run_register,
        screen_limit=10_000,
    )
)


# -- overtime payment summary ------------------------------------------------------------------------------------
def _run_summary(ctx) -> ReportResult:
    settings = read_settings()
    notes = feature_off_result_notes(settings, need_detection=True)
    if not settings.compensation_feature_enabled:
        return ReportResult(rows=[], notes=notes)

    year, month = ctx.period
    m1, m2 = month_bounds(year, month)
    ctype = ctx.param("compensationType") or "all"
    agg = list(
        OvertimeRecord.objects.filter(ctx.emp_q("employee__"), date__gte=m1, date__lte=m2)
        .order_by("employee_id")
        .values("employee_id")
        .annotate(
            detected=Count("id", filter=Q(status="detected")),
            pay=Count("id", filter=Q(status="announced", compensation_type="pay")),
            # what those Pay records are worth in SHIFTS: their own shifts, and ONE day for a record without any
            pay_shifts_set=Sum("shifts", filter=Q(status="announced", compensation_type="pay", shifts__isnull=False)),
            pay_legacy=Count("id", filter=Q(status="announced", compensation_type="pay", shifts__isnull=True)),
            relax=Count("id", filter=Q(status="announced", compensation_type="relaxation")),
            rejected=Count("id", filter=Q(status="rejected")),
            minutes=Sum("ot_minutes", filter=~Q(status="rejected")),
        )
    )
    by_emp = {a["employee_id"]: a for a in agg}
    slip_qs = with_breakdown(
        SalarySlip.objects.filter(
            Q(ot_amount__gt=0) | Q(employee_id__in=list(by_emp)),
            ctx.emp_q("employee__"),
            year=year,
            month=month,
            **_STAFF_SLIP,
        ).select_related("employee__department"),
        "bd_earn",
    )
    slips = {s.employee_id: s for s in slip_qs.order_by("id")}
    emps = {i: s.employee for i, s in slips.items()}
    missing = [i for i in by_emp if i not in emps]
    if missing:
        emps.update({e.id: e for e in Employee.objects.filter(id__in=missing).select_related("department")})

    rows: list[dict] = []
    tot = {"emps": 0, "hours": _ZERO, "pay": 0, "relax": 0, "paid": _ZERO, "pend_days": 0, "pend_amt": _ZERO}
    for emp_id in sorted(emps, key=lambda i: natural_key(emps[i].employee_code)):
        emp, a, s = emps[emp_id], by_emp.get(emp_id), slips.get(emp_id)
        a = a or {
            "detected": 0,
            "pay": 0,
            "pay_shifts_set": None,
            "pay_legacy": 0,
            "relax": 0,
            "rejected": 0,
            "minutes": 0,
        }
        slip_ot = dec(s.ot_amount) if s else None
        if ctype == "pay" and not (a["pay"] or (slip_ot or _ZERO) > 0):
            continue
        if ctype == "relaxation" and not a["relax"]:
            continue
        earn = as_dict(s.bd_earn) if s else {}
        rate = dec_or_none(earn.get("dailyRate"))
        paid_days = int(dec(earn.get("otDays"))) if s else 0
        pending = max(0, a["pay"] - paid_days)
        # Money follows SHIFTS (a Pay record pays shifts x the daily rate), not the number of records: 4 records of
        # 0.25 shift are worth one day, not four.
        pay_shifts = dec(a["pay_shifts_set"]) + a["pay_legacy"]
        pending_shifts = max(_ZERO, pay_shifts - (_slip_ot_shifts(earn) if s else _ZERO))
        expected = _amount(rate, pay_shifts)
        pend_amt = _amount(rate, pending_shifts)
        tot["emps"] += 1
        tot["hours"] += Decimal(str(_hours(a["minutes"])))
        tot["pay"] += a["pay"]
        tot["relax"] += a["relax"]
        tot["paid"] += slip_ot or _ZERO
        tot["pend_days"] += pending
        tot["pend_amt"] += pend_amt or _ZERO
        rows.append(
            {
                "employeeCode": emp.employee_code,
                "employeeName": f"{emp.first_name or ''} {emp.last_name or ''}".strip(),
                "department": dept_name(emp),
                "period": month_label(year, month),
                "detectedDays": a["detected"],
                "announcedPayDays": a["pay"],
                "relaxationDays": a["relax"],
                "rejectedDays": a["rejected"],
                "totalOtHours": _hours(a["minutes"]),
                "dailyRate": money(rate),
                "expectedOtPay": money(expected),
                "slipOtAmount": money(slip_ot),
                "pendingPayDays": pending,
                "pendingPayAmount": money(pend_amt),
            }
        )

    ids = list(emps)
    redeemed = 0
    if ids:
        redeemed = CompensationLeaveCredit.objects.filter(
            employee_id__in=ids,
            status="used",
            source_overtime_record__date__gte=m1,
            source_overtime_record__date__lte=m2,
        ).count()
    notes += [
        _OT_PAY_NOTE,
        _OT_ROWS_NOTE,
        "OT hours exclude rejected days and include the automatic next-day allowance days (they earn a later arrival, "
        "never pay). A 'Pay day' is one announced Pay record; it pays its shifts (0.25 / 0.50 / "
        "0.75 / 1) of the daily rate, so Expected pay = the announced Pay shifts x the daily rate on the month's slip; "
        "'slip OT' is what the generated slip actually paid. Pending = announced Pay records the slip does not yet "
        "include (announced after payroll was generated); they are paid when payroll is regenerated, and the pending "
        "amount is the shifts the slip is still missing x the daily rate. "
        "A dash for the rate means no slip has been generated for that employee this month.",
    ]
    summary = [
        {"label": "Employees with overtime", "value": tot["emps"], "format": "integer"},
        {"label": "OT hours (excl. rejected)", "value": money(tot["hours"]), "format": "hours"},
        {"label": "Announced pay days", "value": tot["pay"], "format": "integer"},
        {"label": "OT paid in slips", "value": money(tot["paid"]), "format": "currency"},
        {"label": "Pay days pending payroll", "value": tot["pend_days"], "format": "integer"},
        {"label": "Pending amount (where rate known)", "value": money(tot["pend_amt"]), "format": "currency"},
        {"label": "Relaxation days announced", "value": tot["relax"], "format": "integer"},
        {"label": "Credits redeemed", "value": redeemed, "format": "integer"},
    ]
    return ReportResult(rows=rows, summary=summary, notes=notes)


register(
    ReportSpec(
        id="overtime-payment-summary",
        title="Overtime Payment Summary",
        description="Per employee for a month: overtime days by decision, hours, expected vs paid overtime wages and "
        "what is still pending payroll.",
        category="payroll",
        icon="Banknote",
        tags=("overtime", "ot payment", "ot wages", "compensation", "payroll"),
        family="overtime",
        variant="Summary",
        modules=OT_MODULES,
        filters=(
            period(default="lastMonth"),
            *scope(status=None, employment=False),
            select(
                "compensationType",
                "Compensation",
                [("all", "All"), ("pay", "Pay"), ("relaxation", "Relaxation")],
                default="all",
            ),
        ),
        columns=(
            ColumnSpec("employeeCode", "Emp Code", TEXT, 1.0),
            ColumnSpec("employeeName", "Employee", TEXT, 2.2),
            ColumnSpec("department", "Department", TEXT, 1.4),
            ColumnSpec("period", "Month", TEXT, 1.1),
            ColumnSpec("detectedDays", "Detected days", INTEGER, 1.0, total="sum"),
            ColumnSpec("announcedPayDays", "Pay days", INTEGER, 0.7, total="sum"),
            ColumnSpec("relaxationDays", "Relaxation days", INTEGER, 1.0, total="sum"),
            ColumnSpec("rejectedDays", "Rejected days", INTEGER, 0.9, total="sum"),
            ColumnSpec("totalOtHours", "OT hours", HOURS, 0.8, total="sum"),
            ColumnSpec("dailyRate", "Daily rate", CURRENCY, 1.0),
            ColumnSpec("expectedOtPay", "Expected OT pay", CURRENCY, 1.2, total="sum"),
            ColumnSpec("slipOtAmount", "OT paid in slip", CURRENCY, 1.2, total="sum"),
            ColumnSpec("pendingPayDays", "Pending days", INTEGER, 0.8, total="sum"),
            ColumnSpec("pendingPayAmount", "Pending amount", CURRENCY, 1.2, total="sum"),
        ),
        run=_run_summary,
    )
)


# -- compensation (alternative day) credits -----------------------------------------------------------------------
_EARNED_OPTIONS = [
    ("all", "All time"),
    ("thisMonth", "This month"),
    ("lastMonth", "Last month"),
    ("last90", "Last 90 days"),
    ("thisYear", "This year"),
]


def _run_credits(ctx) -> ReportResult:
    settings = read_settings()
    notes = feature_off_result_notes(settings)
    if not settings.compensation_feature_enabled:
        return ReportResult(rows=[], notes=notes)

    qs = CompensationLeaveCredit.objects.filter(ctx.emp_q("employee__"))
    status = ctx.param("status") or "all"
    if status != "all":
        qs = qs.filter(status=status)
    a, b = _window(ctx.param("earnedIn") or "all", ctx.today)
    if a is not None:
        start, end = _ist_bounds(a, b)
        qs = qs.filter(created_at__gte=start, created_at__lt=end)
    credits = list(
        qs.select_related("employee__department", "source_overtime_record").order_by("created_at", "id")[
            : ctx.row_limit
        ]
    )
    credits.sort(key=lambda c: (natural_key(c.employee.employee_code), c.created_at, c.id))

    rows: list[dict] = []
    available = used = 0
    holders: set[int] = set()
    oldest = None
    for c in credits:
        emp = c.employee
        earned_on = c.created_at.astimezone(FACTORY_TZ).date()
        age = (ctx.today - earned_on).days if c.status == "available" else None
        if c.status == "available":
            available += 1
            holders.add(c.employee_id)
            oldest = age if oldest is None else max(oldest, age)
        else:
            used += 1
        rows.append(
            {
                "employeeCode": emp.employee_code,
                "employeeName": f"{emp.first_name or ''} {emp.last_name or ''}".strip(),
                "department": dept_name(emp),
                "sourceDate": c.source_overtime_record.date.isoformat() if c.source_overtime_record_id else None,
                "createdAt": fmt_dt(c.created_at),
                "status": c.status.title(),
                "usedDate": c.used_date.isoformat() if c.used_date else None,
                "ageDays": age,
            }
        )
    notes += [
        "A credit is earned when HR announces a day of overtime as Relaxation; HR later redeems it against a date, "
        "which is written as a paid present day. This report only reads that record.",
        "Credits have no expiry in the system: 'Age' (days since the credit was earned, unused credits only) is informational. "
        "The source overtime date is blank when the overtime record was later removed.",
    ]
    summary = [
        {"label": "Credits earned", "value": len(rows), "format": "integer"},
        {"label": "Available", "value": available, "format": "integer"},
        {"label": "Redeemed", "value": used, "format": "integer"},
        {"label": "Employees holding credits", "value": len(holders), "format": "integer"},
        {"label": "Oldest unused (days)", "value": oldest, "format": "integer"},
    ]
    return ReportResult(rows=rows, summary=summary, notes=notes)


register(
    ReportSpec(
        id="compensation-credits",
        title="Compensation Credits (Alternative Days)",
        description="Alternative-day credits earned from relaxation-type overtime: who holds them, how old they are and "
        "which have been redeemed.",
        category="payroll",
        icon="Hourglass",
        tags=("compensation", "alternative day", "relaxation", "credit", "comp off", "overtime"),
        modules=("compensation",),
        filters=(
            *scope(status=None, employment=False),
            select(
                "status", "Status", [("all", "All"), ("available", "Available"), ("used", "Redeemed")], default="all"
            ),
            select("earnedIn", "Earned", _EARNED_OPTIONS, default="all"),
        ),
        columns=(
            ColumnSpec("employeeCode", "Emp Code", TEXT, 1.0),
            ColumnSpec("employeeName", "Employee", TEXT, 2.2),
            ColumnSpec("department", "Department", TEXT, 1.5),
            ColumnSpec("sourceDate", "Overtime date", DATE, 1.1),
            ColumnSpec("createdAt", "Credit earned", DATETIME, 1.4),
            ColumnSpec("status", "Status", BADGE, 1.0),
            ColumnSpec("usedDate", "Redeemed on", DATE, 1.1),
            ColumnSpec("ageDays", "Age (days)", INTEGER, 0.8),
        ),
        run=_run_credits,
    )
)


# -- compensation day announcements ---------------------------------------------------------------------------------
def _announcements_q(ctx) -> Q:
    """Who may see an announcement. An announcement has no employee link of its own, so it is scoped through the
    branch it names, the branch of its department, or the branches of the employees it names; one that names none
    of them is company-wide and visible to everyone."""
    branch = get_branch_scope(ctx.request)
    if branch is None:
        return Q()
    return (
        Q(branch_id=branch)
        | Q(branch__isnull=True, department__isnull=True, employees__isnull=True)
        | Q(branch__isnull=True, department__branch_id=branch)
        | Q(employees__branch_id=branch)
    )


def _applies_to_q(branch_ids, department_ids) -> Q:
    """Announcements that apply to at least one employee inside the branch / department filters, by the engine's
    own rule (``attendance_final._compensation_day_for``): an announcement that NAMES employees applies to those
    employees only - whatever its branch / department fields say - and one that names nobody applies to the people
    of its branch and department, null meaning 'not limited' on that axis. A department implies its own branch, so
    a Unit 1 department's day does not apply to Unit 2."""
    named = CompensationDayAnnouncement.employees.through.objects.filter(compensationdayannouncement_id=OuterRef("pk"))
    listed = named
    unlisted = Q()
    if branch_ids:
        listed = listed.filter(employee__branch_id__in=branch_ids)
        unlisted &= (Q(branch__isnull=True) | Q(branch_id__in=branch_ids)) & (
            Q(department__isnull=True) | Q(department__branch__isnull=True) | Q(department__branch_id__in=branch_ids)
        )
    if department_ids:
        listed = listed.filter(employee__department_id__in=department_ids)
        wanted = Department.objects.filter(pk__in=department_ids)
        # the mirror image: the filtered departments' own branches (a branch-less department restricts nothing)
        unlisted &= (Q(department__isnull=True) | Q(department_id__in=department_ids)) & (
            Q(branch__isnull=True)
            | Q(branch_id__in=wanted.values("branch_id"))
            | Q(Exists(wanted.filter(branch__isnull=True)))
        )
    return (Q(Exists(named)) & Q(Exists(listed))) | (~Q(Exists(named)) & unlisted)


def _run_announcements(ctx) -> ReportResult:
    settings = read_settings()
    notes = feature_off_result_notes(settings)
    if not settings.compensation_feature_enabled:
        return ReportResult(rows=[], notes=notes)

    qs = CompensationDayAnnouncement.objects.filter(_announcements_q(ctx))
    a, b = _window(ctx.param("when") or "thisYear", ctx.today)
    if a is not None:
        qs = qs.filter(date__gte=a)
    if b is not None:
        qs = qs.filter(date__lte=b)
    p = ctx.params
    if p.get("branch_ids") or p.get("department_ids"):
        qs = qs.filter(_applies_to_q(p.get("branch_ids"), p.get("department_ids")))
    anns = list(qs.select_related("branch", "department").distinct().order_by("-date", "-id")[: ctx.row_limit])

    counts: dict[int, int] = {}
    if anns:
        through = CompensationDayAnnouncement.employees.through
        cq = through.objects.filter(compensationdayannouncement_id__in=[x.id for x in anns])
        scoped = get_branch_scope(ctx.request)
        if scoped is not None:
            cq = cq.filter(employee__branch_id=scoped)
        counts = {
            r["compensationdayannouncement_id"]: r["n"]
            for r in cq.order_by().values("compensationdayannouncement_id").annotate(n=Count("id"))
        }

    rows: list[dict] = []
    whole = early = late_in = early_out = 0
    for x in anns:
        # What the announcement DOES follows its kind: a late-in / early-out window moves one edge of the day (its time
        # is `allowed_time`), a legacy day exemption is a whole day or - with a time - an early release.
        if x.kind == CompensationDayAnnouncement.KIND_LATE_IN:
            release = "Late-in window"
            late_in += 1
        elif x.kind == CompensationDayAnnouncement.KIND_EARLY_OUT:
            release = "Early-out window"
            early_out += 1
        elif x.leave_until_time is not None:
            release = "Early release"
            early += 1
        else:
            release = "Whole day"
            whole += 1
        rows.append(
            {
                "date": x.date.isoformat(),
                "leaveUntilTime": x.leave_until_time,
                "releaseType": release,
                "windowTime": x.allowed_time,
                "branch": x.branch.name if x.branch_id else "All branches",
                "department": x.department.name if x.department_id else "All departments",
                "employeeCount": counts.get(x.id),
                "reason": x.reason,
                "announcedBy": x.announced_by,
                "createdAt": fmt_dt(x.created_at),
            }
        )
    notes += [
        "A compensation day only suspends late / permission detection for the people it covers (a whole day, or from the "
        "'leave until' time for an early release); Full / Half day is still decided by the day's punches. A late-in "
        "window (staff may arrive until the 'Window time' with no grace of their own) or an early-out window (staff may "
        "leave from it) moves only that edge of the day: it does not suspend detection for the rest of the day.",
        "Branch / department 'All' means the announcement is not limited on that axis. 'Employees named' counts the "
        "individually listed employees (only those in your branch when your access is branch-limited).",
    ]
    summary = [
        {"label": "Announcements", "value": len(rows), "format": "integer"},
        {"label": "Whole-day", "value": whole, "format": "integer"},
        {"label": "Early release", "value": early, "format": "integer"},
        {"label": "Late-in windows", "value": late_in, "format": "integer"},
        {"label": "Early-out windows", "value": early_out, "format": "integer"},
        {"label": "Distinct dates", "value": len({r["date"] for r in rows}), "format": "integer"},
    ]
    return ReportResult(rows=rows, summary=summary, notes=notes)


register(
    ReportSpec(
        id="compensation-day-announcements",
        title="Compensation Day Announcements",
        description="HR-declared festival or special compensation days and company late-in / early-out windows, with "
        "their scope and time.",
        category="payroll",
        icon="CalendarDays",
        tags=(
            "compensation day",
            "festival",
            "early release",
            "announcement",
            "holiday",
            "late-in window",
            "early-out window",
        ),
        modules=("compensation",),
        filters=(
            select(
                "when",
                "Announced for",
                [
                    ("thisYear", "This year"),
                    ("all", "All time"),
                    ("upcoming", "Upcoming"),
                    ("thisMonth", "This month"),
                    ("lastMonth", "Last month"),
                ],
                default="thisYear",
            ),
            branches(),
            departments(),
        ),
        columns=(
            ColumnSpec("date", "Date", DATE, 1.1),
            ColumnSpec("leaveUntilTime", "Leave until", TIME, 0.9),
            ColumnSpec("releaseType", "Type", BADGE, 1.1),
            ColumnSpec("windowTime", "Window time", TIME, 0.9),
            ColumnSpec("branch", "Branch", TEXT, 1.3),
            ColumnSpec("department", "Department", TEXT, 1.4),
            ColumnSpec("employeeCount", "Employees named", INTEGER, 0.9),
            ColumnSpec("reason", "Reason", TEXT, 2.4),
            ColumnSpec("announcedBy", "Announced by", TEXT, 1.4),
            ColumnSpec("createdAt", "Announced on", DATETIME, 1.4),
        ),
        run=_run_announcements,
    )
)

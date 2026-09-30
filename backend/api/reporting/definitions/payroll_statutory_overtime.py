"""
Overtime and compensation reports.

Overtime here is the payroll concept, not a punch calculation: staff days that HR has detected, announced (as
paid overtime - ONE day's salary per day - or as a relaxation credit) or rejected. The source of truth is the stored
``OvertimeRecord`` plus what the generated slip paid (``ot_amount`` and the breakdown's ``otDays`` / ``dailyRate``).
Nothing here runs overtime detection - that writes rows - so the reports show exactly what HR has on record.

The Compensation feature switch (Settings > Payroll) gates every report in this module: while it is off nothing is
detected, announced or paid, so the reports return an empty result with an explanation instead of zeros.
"""

from __future__ import annotations

from datetime import date, datetime, time, timedelta
from decimal import Decimal

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
OT_MODULES = ("compensation", "payroll")
_STAFF_SLIP = dict(period_start__isnull=True, week_number__isnull=True)

_OT_PAY_NOTE = (
    "Overtime is paid as ONE day's salary (the daily rate on that month's slip) per announced Pay-type day, added to net "
    "pay outside gross salary, PF and ESI; minutes and hours are informational. Relaxation-type days earn an "
    "alternative-day credit instead of pay."
)
_OT_ROWS_NOTE = (
    "Only records on file are shown: overtime is detected when HR opens Compensation > Overtime while detection and "
    "the Compensation feature are on. This report never runs detection. Overtime is detected for staff only "
    "(production 'extra shifts' are already inside their gross pay)."
)


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
    if emp_ids:
        first, last = month_bounds(*months[0])[0], month_bounds(*months[-1])[1]
        pay_qs = OvertimeRecord.objects.filter(
            employee_id__in=emp_ids, date__gte=first, date__lte=last, status="announced", compensation_type="pay"
        ).values_list("employee_id", "date")
        for emp_id, d in pay_qs:
            pay_counts[(emp_id, d.year, d.month)] = pay_counts.get((emp_id, d.year, d.month), 0) + 1
    credits = (
        {
            c.source_overtime_record_id: c
            for c in CompensationLeaveCredit.objects.filter(source_overtime_record_id__in=[r.id for r in recs])
        }
        if recs
        else {}
    )

    rows: list[dict] = []
    n = {"detected": 0, "announced": 0, "rejected": 0, "relax": 0}
    pay_groups: dict[tuple[int, int, int], list[int]] = {}  # (employee, year, month) -> [listed pay rows, missing days]
    hours_total = _ZERO
    payable_total = _ZERO
    for r in recs:
        emp = r.employee
        key = (r.employee_id, r.date.year, r.date.month)
        slip = slips.get(key)
        rate = dec_or_none(as_dict(slip.bd_earn).get("dailyRate")) if slip else None
        is_pay = r.status == "announced" and r.compensation_type == "pay"
        outcome = payable = None
        if is_pay:
            paid_days = int(dec(as_dict(slip.bd_earn).get("otDays"))) if slip else 0
            announced = pay_counts.get(key, 0)
            outcome = "Paid in slip" if paid_days >= announced else ("Partly paid" if paid_days else "Awaiting payroll")
            # A month's slip pays a COUNT of days, so the days still missing are counted once per employee-month
            # (as the payment summary does) - not once for every listed row of a month that is only partly paid.
            group = pay_groups.setdefault(key, [0, max(0, announced - paid_days)])
            group[0] += 1
            payable = rate
            payable_total += rate or _ZERO
        elif r.status == "announced" and r.compensation_type == "relaxation":
            n["relax"] += 1
            credit = credits.get(r.id)
            outcome = (
                "No credit" if credit is None else ("Credit used" if credit.status == "used" else "Credit available")
            )
        n[r.status] += 1
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
                "status": r.status.title(),
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
        "Payable = the daily rate on the employee's generated slip for that month (a dash when no slip exists yet). "
        "Outcome: 'Paid in slip' = the slip's overtime days cover every announced Pay day of that month; "
        "'Awaiting payroll' = announced after (or without) payroll generation - regenerate payroll to include it; "
        "'Partly paid' = the slip covers only some of the month's Pay days (the slip holds a count, not which days), "
        "and 'Pay days awaiting payroll' counts only the days the slip is still missing.",
    ]
    summary = [
        {"label": "Records", "value": len(rows), "format": "integer"},
        {"label": "Total OT hours (listed)", "value": money(hours_total), "format": "hours"},
        {"label": "Detected", "value": n["detected"], "format": "integer"},
        {"label": "Announced", "value": n["announced"], "format": "integer"},
        {"label": "Rejected", "value": n["rejected"], "format": "integer"},
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
        "whether payroll has paid it.",
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
                [("all", "All"), ("detected", "Detected"), ("announced", "Announced"), ("rejected", "Rejected")],
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
        a = a or {"detected": 0, "pay": 0, "relax": 0, "rejected": 0, "minutes": 0}
        slip_ot = dec(s.ot_amount) if s else None
        if ctype == "pay" and not (a["pay"] or (slip_ot or _ZERO) > 0):
            continue
        if ctype == "relaxation" and not a["relax"]:
            continue
        earn = as_dict(s.bd_earn) if s else {}
        rate = dec_or_none(earn.get("dailyRate"))
        paid_days = int(dec(earn.get("otDays"))) if s else 0
        pending = max(0, a["pay"] - paid_days)
        expected = rate * a["pay"] if rate is not None else None
        pend_amt = rate * pending if rate is not None else None
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
        "OT hours exclude rejected days. Expected pay = announced Pay days x the daily rate on the month's slip; "
        "'slip OT' is what the generated slip actually paid. Pending = announced Pay days the slip does not yet "
        "include (announced after payroll was generated) and are paid when payroll is regenerated. "
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
    whole = early = 0
    for x in anns:
        is_early = x.leave_until_time is not None
        early += is_early
        whole += not is_early
        rows.append(
            {
                "date": x.date.isoformat(),
                "leaveUntilTime": x.leave_until_time,
                "releaseType": "Early release" if is_early else "Whole day",
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
        "'leave until' time for an early release); Full / Half day is still decided by the day's punches.",
        "Branch / department 'All' means the announcement is not limited on that axis. 'Employees named' counts the "
        "individually listed employees (only those in your branch when your access is branch-limited).",
    ]
    summary = [
        {"label": "Announcements", "value": len(rows), "format": "integer"},
        {"label": "Whole-day", "value": whole, "format": "integer"},
        {"label": "Early release", "value": early, "format": "integer"},
        {"label": "Distinct dates", "value": len({r["date"] for r in rows}), "format": "integer"},
    ]
    return ReportResult(rows=rows, summary=summary, notes=notes)


register(
    ReportSpec(
        id="compensation-day-announcements",
        title="Compensation Day Announcements",
        description="HR-declared festival or special compensation days with their scope and early-release time.",
        category="payroll",
        icon="CalendarDays",
        tags=("compensation day", "festival", "early release", "announcement", "holiday"),
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

"""Leave & holiday reports: leave register, leave balance statement, monthly leave summary,
daily leave load by department and the holiday calendar.

Sources of truth (nothing here re-derives a payroll decision):

* ``LeaveRequest`` for every leave application and its decision. ``start_date`` / ``end_date`` are TEXT
  columns, so date filters are overlap tests on ISO strings (never ``__startswith``) and rows whose text
  cannot be read are counted in the report notes instead of crashing or silently vanishing.
* ``LeaveBalance`` is only an HR-maintained ledger; the usage next to it is computed independently from the
  approved / pending requests so drift in the ledger is visible.
* ``CasualLeaveRequest`` is a separate paid-leave system; it appears only where a report says so, and only
  for roles that can open Casual Leave elsewhere in the app.
"""

from __future__ import annotations

from collections import defaultdict
from datetime import date, timedelta
from decimal import Decimal

from django.db.models import Q

from api.branch_scope import get_branch_scope
from api.models import (
    AttendanceDayRecord,
    CasualLeaveRequest,
    Department,
    EmployeePermission,
    Holiday,
    LeaveBalance,
    LeaveRequest,
    OnDutySession,
)

from ..common import EMP_COLS_SHORT, emp_cells, with_subtotals
from ..filters import boolean, branches, date_range, departments, scope, select, text, year
from ..formatting import MONTH_ABBR, display_date, fmt_dt, parse_date
from ..registry import register
from ..types import BADGE, DATE, DATETIME, INTEGER, NUMBER, PERCENT, TEXT, ColumnSpec, ReportResult, ReportSpec
from . import requests_leave_common as C

CATEGORY = "leave"
CL_SYSTEM_LABEL = "Casual Leave (CL system)"
STATUS_OPTIONS = (
    ("pending", "Pending"),
    ("approved", "Approved"),
    ("rejected", "Rejected"),
    ("other", "Other / unrecognised"),
)
MONTH_KEYS = ("jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec")


def _dec(value) -> Decimal:
    return Decimal(str(value)) if value is not None else Decimal(0)


def _f(value) -> float | None:
    return None if value is None else round(float(value), 2)


def _casual_scope_note(ctx) -> str | None:
    return None if C.can_view(ctx, "casual_leave") else (
        "Casual Leave (CL system) is not included: your role does not have access to the Casual Leave module."
    )


# ══════════════════════════════════════════════════════════════════════════════
#  Leave Register
# ══════════════════════════════════════════════════════════════════════════════

_REGISTER_COLUMNS = (
    *EMP_COLS_SHORT,
    ColumnSpec("leaveType", "Leave type", TEXT, 1.4),
    ColumnSpec("startDate", "From", DATE, 1.1),
    ColumnSpec("endDate", "To", DATE, 1.1),
    ColumnSpec("dayType", "Day type", BADGE, 1.3),
    ColumnSpec("totalDays", "Total days", NUMBER, 0.8),
    ColumnSpec("daysInPeriod", "Days in period", NUMBER, 0.8),
    ColumnSpec("advanceDays", "Notice (days)", INTEGER, 0.8),
    ColumnSpec("reason", "Reason", TEXT, 2.0),
    ColumnSpec("appliedOn", "Applied on", DATETIME, 1.4),
    ColumnSpec("status", "Status", BADGE, 1.0),
    ColumnSpec("approvedBy", "Decided by", TEXT, 1.5),
    ColumnSpec("approverRole", "Role", BADGE, 0.8),
    ColumnSpec("hrComment", "Comment", TEXT, 1.6),
    ColumnSpec("payImpact", "Pay impact", BADGE, 1.6),
)


def _pay_impact(emp, lr) -> str | None:
    status = C.status_badge(lr.status)
    if status == "approved":
        if emp.employment_type == "production":
            return "No effect (production)"
        return "Half-day leave" if lr.is_half_day else "Unpaid (LOP)"
    if status == "pending":
        return "Awaiting decision"
    if status == "rejected":
        return "None"
    return None


def _day_type(lr) -> str:
    if not lr.is_half_day:
        return "Full day"
    slot = {"morning": "morning", "afternoon": "afternoon"}.get(str(lr.half_day_slot or ""), None)
    return f"Half day ({slot})" if slot else "Half day"


def _run_leave_register(ctx) -> ReportResult:
    d_from, d_to = ctx.date_from, ctx.date_to
    catalog = C.LeaveTypeCatalog()
    qs = (
        LeaveRequest.objects.select_related("employee__department", "employee__designation")
        .filter(ctx.emp_q("employee__"))
        .filter(C.leave_overlap_q(d_from, d_to))
    )
    status = ctx.param("status")
    if status == "other":
        qs = qs.exclude(status__in=C.KNOWN_STATUSES)
    elif status:
        qs = qs.filter(status=status)
    day_type = ctx.param("dayType")
    if day_type == "half":
        qs = qs.filter(is_half_day=True)
    elif day_type == "full":
        qs = qs.filter(is_half_day=False)
    if ctx.param("approverRole"):
        qs = qs.filter(approver_role=ctx.param("approverRole"))
    needle = ctx.param("leaveType")

    entries = []
    unreadable: list[int] = []
    for lr in qs:
        rng = C.parse_leave_range(lr)
        if rng is None:
            unreadable.append(lr.id)
            continue
        start, end = rng
        if start > d_to or end < d_from:  # non-ISO rows are only decided here
            continue
        info = catalog.resolve(lr)
        if not C.type_matches(info, needle):
            continue
        dates = C.leave_dates(lr, start, end, d_from, d_to)
        entries.append((lr, start, end, info, dates))
    entries.sort(key=lambda e: (e[0].employee.employee_code, e[1], e[2], e[0].id))

    rows = []
    by_status: dict[str, list] = defaultdict(list)
    employees_on_leave: set[int] = set()
    lop_items = []
    half_requests = 0
    for lr, start, end, info, dates in entries:
        emp = lr.employee
        st = C.status_badge(lr.status)
        days_in_period = 0.5 * len(dates) if lr.is_half_day else float(len(dates))
        applied = C.ist_date(lr.created_at)
        item = (lr.employee_id, dates, lr.is_half_day, lr.half_day_slot)
        by_status[st].append(item)
        if st == "approved":
            employees_on_leave.add(lr.employee_id)
            if emp.employment_type != "production":
                lop_items.append(item)
        if lr.is_half_day:
            half_requests += 1
        rows.append({
            **emp_cells(emp),
            "leaveType": info.label,
            "startDate": start.isoformat(),
            "endDate": end.isoformat(),
            "dayType": _day_type(lr),
            "totalDays": _f(lr.total_days),
            "daysInPeriod": days_in_period,
            "advanceDays": (start - applied).days if applied else None,
            "reason": (lr.reason or "").strip() or None,
            "appliedOn": fmt_dt(lr.created_at),
            "status": st,
            "approvedBy": lr.approved_by or None,
            "approverRole": C.role_label(lr.approver_role),
            "hrComment": (lr.hr_comment or "").strip() or None,
            "payImpact": _pay_impact(emp, lr),
        })

    summary = [
        {"label": "Leave requests", "value": len(rows), "format": "integer"},
        {"label": "Approved days (in period)", "value": C.unique_leave_days(by_status["approved"]), "format": "number"},
        {"label": "Pending days (in period)", "value": C.unique_leave_days(by_status["pending"]), "format": "number"},
        {"label": "Rejected days (in period)", "value": C.unique_leave_days(by_status["rejected"]), "format": "number"},
        {"label": "Half-day requests", "value": half_requests, "format": "integer"},
        {"label": "Unpaid (LOP) days - staff", "value": C.unique_leave_days(lop_items), "format": "number"},
        {"label": "Employees on approved leave", "value": len(employees_on_leave), "format": "integer"},
    ]
    notes = [
        "Lists every leave request that overlaps the selected dates. 'Total days' is the figure stored on the "
        "request; 'Days in period' counts only its Mon-Sat dates inside the selected range (Sundays are not "
        "counted, public holidays are not excluded) and a half-day counts 0.5. Day totals in the summary count "
        "an employee's overlapping or duplicate requests once per day.",
        "Pay impact follows the attendance engine: a staff employee's approved full-day leave is marked On "
        "Leave and paid as unpaid (LOP) unless the employee punched that day (punches always win), and the "
        "leave type's 'paid' flag is not consulted. Production employees' leave has no attendance or payroll "
        "effect. Half-day leave keeps the half shift the employee worked.",
        "Notice = days between the day the request was filed (IST) and the first leave day; a negative "
        "number means the leave was applied for after it had started.",
        "Requests deleted by HR are not recorded anywhere and therefore cannot appear here.",
    ]
    if unreadable:
        notes.append(C.id_list_note(
            f"{len(unreadable)} leave request(s) with unreadable start/end dates could not be placed in the date "
            "range and are not listed", unreadable,
        ))
    return ReportResult(rows=rows, summary=summary, notes=notes)


register(ReportSpec(
    id="leave-register",
    title="Leave Register",
    description="Every leave application in the period with type, days, half-day, approver, decision and payroll effect.",
    category=CATEGORY,
    icon="CalendarOff",
    tags=("leave", "lop", "loss of pay", "half day", "approval"),
    family="leave",
    variant="Register",
    modules=("leave",),
    filters=(
        date_range(label="Leave falls within"),
        *scope(status="all"),
        select("status", "Status", STATUS_OPTIONS),
        select("dayType", "Day type", (("full", "Full day"), ("half", "Half day"))),
        select("approverRole", "Decided by", (("hr", "HR"), ("dept_head", "Department head"))),
        text("leaveType", "Leave type", placeholder="Code or name, e.g. CL"),
    ),
    columns=_REGISTER_COLUMNS,
    run=_run_leave_register,
))


# ══════════════════════════════════════════════════════════════════════════════
#  Leave Balance Statement
# ══════════════════════════════════════════════════════════════════════════════

_BALANCE_COLUMNS = (
    ColumnSpec("employeeCode", "Emp Code", TEXT, 1.0),
    ColumnSpec("employeeName", "Employee", TEXT, 2.2),
    ColumnSpec("department", "Department", TEXT, 1.5),
    ColumnSpec("leaveType", "Leave type", TEXT, 1.8),
    ColumnSpec("leaveCode", "Code", TEXT, 0.7),
    ColumnSpec("isPaid", "Paid?", BADGE, 0.8),
    ColumnSpec("allocated", "Allocated", NUMBER, 0.9, total="sum"),
    ColumnSpec("carriedForward", "Carried fwd", NUMBER, 0.9),
    ColumnSpec("ledgerUsed", "Ledger used", NUMBER, 0.9),
    ColumnSpec("approvedDays", "Approved days", NUMBER, 0.9, total="sum"),
    ColumnSpec("pendingDays", "Pending days", NUMBER, 0.9, total="sum"),
    ColumnSpec("ledgerRemaining", "Ledger remaining", NUMBER, 1.0),
    ColumnSpec("computedRemaining", "Remaining (computed)", NUMBER, 1.1, total="sum"),
    ColumnSpec("variance", "Ledger - approved", NUMBER, 1.0),
)


def _run_leave_balance(ctx) -> ReportResult:
    from api.casual_leave_views import CL_YEARLY_ENTITLEMENT

    yr = ctx.year
    catalog = C.LeaveTypeCatalog()
    emp_q = ctx.emp_q("employee__")
    needle = ctx.param("leaveType")

    balances = list(
        LeaveBalance.objects.select_related("employee__department", "employee__designation")
        .filter(emp_q, year=yr)
    )
    requests = (
        LeaveRequest.objects.select_related("employee__department", "employee__designation")
        .filter(emp_q, status__in=("approved", "pending"))
        .filter(C.leave_year_q(yr))
    )

    employees: dict[int, object] = {}
    infos: dict[str, C.TypeInfo] = {}
    ledger: dict[tuple[int, str], LeaveBalance] = {}
    for b in balances:
        lt = catalog.by_id.get(b.leave_type_id)
        if lt is None:
            continue
        info = catalog.for_type(lt)
        infos[info.key] = info
        employees[b.employee_id] = b.employee
        ledger[(b.employee_id, info.key)] = b

    usage: dict[tuple[int, str], dict[str, Decimal]] = defaultdict(lambda: {"approved": Decimal(0), "pending": Decimal(0)})
    unreadable: list[int] = []
    for lr in requests:
        start = parse_date(lr.start_date)
        if start is None:
            unreadable.append(lr.id)
            continue
        if start.year != yr:
            continue
        info = catalog.resolve(lr)
        infos[info.key] = info
        employees[lr.employee_id] = lr.employee
        usage[(lr.employee_id, info.key)][lr.status] += _dec(lr.total_days)

    rows: list[dict] = []
    keys = set(ledger) | set(usage)
    for key in keys:
        emp_id, tkey = key
        info = infos[tkey]
        if not C.type_matches(info, needle):
            continue
        b = ledger.get(key)
        u = usage.get(key) or {"approved": Decimal(0), "pending": Decimal(0)}
        allocated = b.allocated if b else None
        approved = u["approved"]
        rows.append({
            **emp_cells(employees[emp_id]),
            "leaveType": info.label,
            "leaveCode": info.code,
            "isPaid": None if info.is_paid is None else ("Paid" if info.is_paid else "Unpaid"),
            "allocated": _f(allocated),
            "carriedForward": _f(b.carried_forward) if b else None,
            "ledgerUsed": _f(b.used) if b else None,
            "approvedDays": _f(approved),
            "pendingDays": _f(u["pending"]),
            "ledgerRemaining": _f(b.remaining) if b else None,
            "computedRemaining": _f(allocated - approved) if allocated is not None else None,
            "variance": _f(b.used - approved) if b else None,
            "_mismatch": bool(b and abs(b.used - approved) >= Decimal("0.05")),
        })

    notes: list[str] = []
    include_casual = bool(ctx.param("includeCasual", True))
    if include_casual and C.can_view(ctx, "casual_leave"):
        cl: dict[int, dict] = {}
        for r in (
            CasualLeaveRequest.objects.select_related("employee__department", "employee__designation")
            .filter(emp_q, date__year=yr, status__in=("approved", "pending"))
        ):
            slot = cl.setdefault(r.employee_id, {"emp": r.employee, "approved": 0, "pending": 0})
            slot[r.status] += 1
        cl_info = C.TypeInfo("cl-system", CL_SYSTEM_LABEL, None, True)
        if C.type_matches(cl_info, needle):
            for emp_id, slot in cl.items():
                employees[emp_id] = slot["emp"]
                rows.append({
                    **emp_cells(slot["emp"]),
                    "leaveType": CL_SYSTEM_LABEL,
                    "leaveCode": None,
                    "isPaid": "Paid",
                    "allocated": float(CL_YEARLY_ENTITLEMENT),
                    "carriedForward": None,
                    "ledgerUsed": None,
                    "approvedDays": float(slot["approved"]),
                    "pendingDays": float(slot["pending"]),
                    "ledgerRemaining": None,
                    "computedRemaining": float(max(0, CL_YEARLY_ENTITLEMENT - slot["approved"])),
                    "variance": None,
                    "_mismatch": False,
                })
        notes.append(
            f"Casual Leave (CL system) rows use the fixed yearly entitlement of {CL_YEARLY_ENTITLEMENT} days, "
            "which is a constant in the app rather than a LeaveBalance record; they have no ledger figures."
        )
    elif include_casual:
        notes.append(_casual_scope_note(ctx))

    if ctx.param("onlyMismatch"):
        rows = [
            r for r in rows
            if r["_mismatch"] or (r["computedRemaining"] is not None and r["computedRemaining"] < 0)
        ]
    rows.sort(key=lambda r: (r["employeeCode"], r["leaveType"]))

    with_ledger = [r for r in rows if r["ledgerUsed"] is not None]
    employees_with_allocation = {r["employeeCode"] for r in rows if r["allocated"] is not None}
    overdrawn = {r["employeeCode"] for r in rows if r["computedRemaining"] is not None and r["computedRemaining"] < 0}
    mismatches = sum(1 for r in rows if r["_mismatch"])
    summary = [
        {"label": "Employees with an allocation", "value": len(employees_with_allocation), "format": "integer"},
        {"label": "Days allocated", "value": round(sum(r["allocated"] or 0 for r in rows), 2), "format": "number"},
        {"label": "Approved days taken", "value": round(sum(r["approvedDays"] or 0 for r in rows), 2), "format": "number"},
        {"label": "Remaining (computed)", "value": round(sum(r["computedRemaining"] or 0 for r in rows), 2), "format": "number"},
        {"label": "Employees over-drawn", "value": len(overdrawn), "format": "integer"},
        {"label": "Ledger mismatches", "value": mismatches, "format": "integer"},
    ]

    if not balances:
        notes.insert(0, (
            f"No leave balances have been allocated for {yr} in this selection; the usage shown is computed "
            "from approved and pending leave requests only."
        ))
    notes += [
        "'Ledger' columns are the LeaveBalance figures HR maintains. 'Approved days' and 'Pending days' are "
        "computed independently from leave requests that start in the year (each request's stored total days, "
        "a half-day being 0.5). 'Remaining (computed)' = allocated - approved days.",
        "The ledger can drift: it is bumped on approval only and never restored when a request is later "
        "rejected or deleted, an approve-reject-approve sequence counts twice, and a leave applied without a "
        "leave type is deducted from EVERY balance row of the employee. Carried-forward days are shown for "
        "information; they are not added to the remaining balance. Leave-type limits and the paid flag are "
        "not enforced by the app.",
        "Leave with no matching leave type is listed on its own '(untyped)' row.",
    ]
    if with_ledger:
        notes.append("Ledger - approved = ledger used minus approved days; a non-zero value flags a mismatch.")
    unassigned = ctx.employees().count() - len({r["employeeCode"] for r in rows})
    if unassigned > 0 and not ctx.param("onlyMismatch") and not needle:
        notes.append(f"{unassigned} employee(s) in this selection have no allocation and no leave in {yr}.")
    if unreadable:
        notes.append(C.id_list_note(
            f"{len(unreadable)} leave request(s) with unreadable dates are not counted", unreadable,
        ))
    return ReportResult(rows=rows, summary=summary, notes=[n for n in notes if n])


register(ReportSpec(
    id="leave-balance-statement",
    title="Leave Balance Statement",
    description="Allocation, carry-forward, ledger usage and independently computed usage per employee and leave type.",
    category=CATEGORY,
    icon="Scale",
    tags=("leave balance", "allocation", "entitlement", "carry forward"),
    modules=("leave",),
    filters=(
        year(),
        *scope(status="active"),
        text("leaveType", "Leave type", placeholder="Code or name, e.g. CL"),
        boolean("onlyMismatch", "Only rows needing attention", help="Ledger differs from approved leave, or the balance is overdrawn."),
        boolean("includeCasual", "Include Casual Leave (CL system)", default=True),
    ),
    columns=_BALANCE_COLUMNS,
    run=_run_leave_balance,
))


# ══════════════════════════════════════════════════════════════════════════════
#  Monthly Leave Summary
# ══════════════════════════════════════════════════════════════════════════════

_MONTHLY_COLUMNS = (
    ColumnSpec("employeeCode", "Emp Code", TEXT, 1.0),
    ColumnSpec("employeeName", "Employee", TEXT, 2.2),
    ColumnSpec("department", "Department", TEXT, 1.4),
    ColumnSpec("leaveType", "Leave type", TEXT, 1.6),
    *(ColumnSpec(k, MONTH_ABBR[i], NUMBER, 0.6, total="sum") for i, k in enumerate(MONTH_KEYS)),
    ColumnSpec("total", "Total", NUMBER, 0.8, total="sum"),
)


def _month_counts(full_dates: set[date], half_dates: dict[date, set]) -> list[float]:
    months = [0.0] * 12
    for d in full_dates:
        months[d.month - 1] += 1
    for d, slots in half_dates.items():
        if d not in full_dates:
            months[d.month - 1] += min(1.0, 0.5 * len(slots))
    return months


def _run_leave_monthly(ctx) -> ReportResult:
    yr = ctx.year
    lo, hi = date(yr, 1, 1), date(yr, 12, 31)
    catalog = C.LeaveTypeCatalog()
    emp_q = ctx.emp_q("employee__")
    needle = ctx.param("leaveType")

    full: dict[tuple[int, str], set[date]] = defaultdict(set)
    halves: dict[tuple[int, str], dict[date, set]] = defaultdict(lambda: defaultdict(set))
    meta: dict[tuple[int, str], tuple] = {}
    unreadable: list[int] = []
    qs = (
        LeaveRequest.objects.select_related("employee__department", "employee__designation")
        .filter(emp_q, status="approved")
        .filter(C.leave_overlap_q(lo, hi))
    )
    for lr in qs:
        rng = C.parse_leave_range(lr)
        if rng is None:
            unreadable.append(lr.id)
            continue
        start, end = rng
        if start > hi or end < lo:
            continue
        info = catalog.resolve(lr)
        if not C.type_matches(info, needle):
            continue
        dates = C.leave_dates(lr, start, end, lo, hi)
        if not dates:
            continue
        key = (lr.employee_id, info.key)
        meta[key] = (lr.employee, info.label)
        if lr.is_half_day:
            for d in dates:
                halves[key][d].add(lr.half_day_slot or "?")
        else:
            full[key].update(dates)

    grid: list[tuple] = []  # (employee, label, months)
    for key, (emp, label) in meta.items():
        grid.append((emp, label, _month_counts(full.get(key, set()), halves.get(key, {}))))

    notes: list[str] = []
    include_casual = bool(ctx.param("includeCasual", True))
    if include_casual and C.can_view(ctx, "casual_leave"):
        if C.type_matches(C.TypeInfo("cl-system", CL_SYSTEM_LABEL, None, True), needle):
            per_emp: dict[int, tuple] = {}
            for r in (
                CasualLeaveRequest.objects.select_related("employee__department", "employee__designation")
                .filter(emp_q, status="approved", date__year=yr)
            ):
                emp, months = per_emp.setdefault(r.employee_id, (r.employee, [0.0] * 12))
                months[r.date.month - 1] += 1
            grid += [(emp, CL_SYSTEM_LABEL, months) for emp, months in per_emp.values()]
        notes.append("Casual Leave (CL system) rows count approved casual leave days (one day per request).")
    elif include_casual:
        notes.append(_casual_scope_note(ctx))

    grid.sort(key=lambda g: (
        g[0].department.name if g[0].department_id else "Unassigned", g[0].employee_code, g[1],
    ))
    rows = []
    for emp, label, months in grid:
        row = {**emp_cells(emp), "leaveType": label, "total": round(sum(months), 2)}
        for k, v in zip(MONTH_KEYS, months):
            row[k] = round(v, 2) if v else None
        rows.append(row)

    total_days = round(sum(r["total"] for r in rows), 2)
    employees = {r["employeeCode"] for r in rows}
    by_dept: dict[str, float] = defaultdict(float)
    for r in rows:
        by_dept[r["department"]] += r["total"]
    top = max(by_dept.items(), key=lambda kv: (kv[1], kv[0]), default=None)
    summary = [
        {"label": "Leave days in the year", "value": total_days, "format": "number"},
        {"label": "Employees with leave", "value": len(employees), "format": "integer"},
        {"label": "Average days per employee", "value": round(total_days / len(employees), 2) if employees else None,
         "format": "number"},
        {"label": "Department with most leave", "value": f"{top[0]} ({top[1]:g} days)" if top else None, "format": "text"},
    ]
    rows = with_subtotals(rows, lambda r: r["department"], [*MONTH_KEYS, "total"])
    notes = [
        "Approved leave only, split across months by date. Sundays are not counted and public holidays are "
        "not excluded (the same convention as the stored total days); a half-day counts 0.5. A dash means no "
        "leave in that month. Overlapping or duplicate requests of one type count once per day.",
        "Leave with no matching leave type is listed on its own '(untyped)' row. Cross-year leave contributes "
        "only the days that fall inside the selected year.",
        *notes,
    ]
    if unreadable:
        notes.append(C.id_list_note(
            f"{len(unreadable)} approved leave request(s) with unreadable dates are not counted", unreadable,
        ))
    return ReportResult(rows=rows, summary=summary, notes=[n for n in notes if n])


register(ReportSpec(
    id="leave-summary-monthly",
    title="Monthly Leave Summary",
    description="Approved leave days per employee and leave type for each month of the year, with department subtotals.",
    category=CATEGORY,
    icon="CalendarRange",
    tags=("leave", "annual", "monthly", "grid"),
    family="leave",
    variant="Monthly Summary",
    modules=("leave",),
    filters=(
        year(),
        *scope(status="all"),
        text("leaveType", "Leave type", placeholder="Code or name, e.g. CL"),
        boolean("includeCasual", "Include Casual Leave (CL system)", default=True),
    ),
    columns=_MONTHLY_COLUMNS,
    run=_run_leave_monthly,
))


# ══════════════════════════════════════════════════════════════════════════════
#  Daily Leave & Absence Load by Department
# ══════════════════════════════════════════════════════════════════════════════

_CALENDAR_COLUMNS = (
    ColumnSpec("date", "Date", DATE, 1.1),
    ColumnSpec("weekday", "Day", TEXT, 0.8),
    ColumnSpec("dayType", "Day type", BADGE, 1.0),
    ColumnSpec("department", "Department", TEXT, 1.8),
    ColumnSpec("strength", "Strength", INTEGER, 0.8),
    ColumnSpec("onLeaveFull", "Full-day leave", NUMBER, 0.9),
    ColumnSpec("onLeaveHalf", "Half-day leave", NUMBER, 0.9),
    ColumnSpec("casualLeave", "Casual leave", NUMBER, 0.9),
    ColumnSpec("onDuty", "On duty", NUMBER, 0.8),
    ColumnSpec("permission", "Permission", NUMBER, 0.8),
    ColumnSpec("absentUnexplained", "Absent (no leave)", NUMBER, 1.0),
    ColumnSpec("leavePct", "Leave %", PERCENT, 0.8),
)


def _run_leave_calendar(ctx) -> ReportResult:
    lo, hi = ctx.date_from, ctx.date_to
    days = ctx.days_in_range
    can = {
        "leave": C.can_view(ctx, "leave"),
        "casual": C.can_view(ctx, "casual_leave"),
        "duty": C.can_view(ctx, "geo_attendance"),
        "permission": C.can_view(ctx, "requests"),
        "absent": C.can_view(ctx, "attendance"),
    }
    emp_q = ctx.emp_q("employee__")
    active = Q(employee__status="active")

    roster = list(ctx.employees().filter(status="active"))
    joined = {e.id: parse_date(e.join_date) for e in roster}
    holidays = set(Holiday.objects.filter(date__range=(lo, hi)).values_list("date", flat=True))

    full: dict[date, set[int]] = defaultdict(set)
    half: dict[date, set[int]] = defaultdict(set)
    cl: dict[date, set[int]] = defaultdict(set)
    duty: dict[date, set[int]] = defaultdict(set)
    perm: dict[date, set[int]] = defaultdict(set)
    absent: dict[date, set[int]] = defaultdict(set)
    unreadable: list[int] = []

    if can["leave"]:
        for lr in LeaveRequest.objects.filter(emp_q, active, status="approved").filter(C.leave_overlap_q(lo, hi)):
            rng = C.parse_leave_range(lr)
            if rng is None:
                unreadable.append(lr.id)
                continue
            start, end = rng
            if lr.is_half_day:
                if lo <= start <= hi:
                    half[start].add(lr.employee_id)
                continue
            d = max(start, lo)
            while d <= min(end, hi):
                full[d].add(lr.employee_id)
                d += timedelta(days=1)
    if can["casual"]:
        for eid, d in CasualLeaveRequest.objects.filter(emp_q, active, status="approved", date__range=(lo, hi)).values_list(
            "employee_id", "date"
        ):
            cl[d].add(eid)
    if can["duty"]:
        start_dt, end_dt = C.ist_bounds(lo, hi)
        for eid, created in OnDutySession.objects.filter(
            emp_q, active, status__in=("active", "completed"), created_at__gte=start_dt, created_at__lt=end_dt,
        ).values_list("employee_id", "created_at"):
            duty[C.ist_date(created)].add(eid)
    if can["permission"]:
        for eid, d in EmployeePermission.objects.filter(emp_q, active, status="approved", date__range=(lo, hi)).values_list(
            "employee_id", "date"
        ):
            perm[d].add(eid)
    if can["absent"]:
        for eid, d in AttendanceDayRecord.objects.filter(emp_q, active, status="absent", date__range=(lo, hi)).values_list(
            "employee_id", "date"
        ):
            absent[d].add(eid)

    by_dept: dict[int | None, list] = defaultdict(list)
    for e in roster:
        by_dept[e.department_id].append(e)
    dept_rows = {
        d.id: d for d in Department.objects.select_related("branch").filter(id__in=[k for k in by_dept if k is not None])
    }
    labels: dict[int | None, str] = {}
    for dept_id in by_dept:
        labels[dept_id] = dept_rows[dept_id].name if dept_id is not None and dept_id in dept_rows else "Unassigned"
    dup = {name for name in labels.values() if list(labels.values()).count(name) > 1}
    for dept_id, name in list(labels.items()):
        if name in dup and dept_id in dept_rows and dept_rows[dept_id].branch_id:
            labels[dept_id] = f"{name} ({dept_rows[dept_id].branch.name})"
    order = sorted(by_dept, key=lambda k: (labels[k], k or 0))

    rows: list[dict] = []
    day_totals: dict[date, tuple[float, int]] = {}
    for d in days:
        is_holiday = d in holidays
        day_type = "Holiday" if is_holiday else "Sunday" if d.weekday() == 6 else "Working day"
        day_leave = 0.0
        day_expected = 0
        for dept_id in order:
            present = [e for e in by_dept[dept_id] if joined[e.id] is None or joined[e.id] <= d]
            working = [
                e for e in present
                if not (is_holiday or (d.weekday() == 6 and e.employment_type == "staff"))
            ]
            row = {
                "date": d.isoformat(), "weekday": d.strftime("%a"), "dayType": day_type,
                "department": labels[dept_id], "strength": len(present),
                "onLeaveFull": None, "onLeaveHalf": None, "casualLeave": None, "onDuty": None,
                "permission": None, "absentUnexplained": None, "leavePct": None,
            }
            if working:
                n_full = n_cl = n_half = n_duty = n_perm = n_abs = 0
                for e in working:
                    eid = e.id
                    is_full = eid in full[d]
                    is_cl = (not is_full) and eid in cl[d]
                    is_half = (not is_full) and (not is_cl) and eid in half[d]
                    n_full += is_full
                    n_cl += is_cl
                    n_half += is_half
                    n_duty += eid in duty[d]
                    n_perm += eid in perm[d]
                    n_abs += eid in absent[d] and not (is_full or is_cl or is_half)
                leave_eq = n_full + n_cl + 0.5 * n_half
                if can["leave"]:
                    row["onLeaveFull"], row["onLeaveHalf"] = float(n_full), float(n_half)
                if can["casual"]:
                    row["casualLeave"] = float(n_cl)
                if can["duty"]:
                    row["onDuty"] = float(n_duty)
                if can["permission"]:
                    row["permission"] = float(n_perm)
                if can["absent"]:
                    row["absentUnexplained"] = float(n_abs)
                if can["leave"] or can["casual"]:
                    row["leavePct"] = round(leave_eq / len(working) * 100, 1)
                    day_leave += leave_eq
                    day_expected += len(working)
            rows.append(row)
        day_totals[d] = (day_leave, day_expected)

    counted = [(d, lv, ex) for d, (lv, ex) in day_totals.items() if ex > 0]
    peak = max(counted, key=lambda t: (t[1], -t[0].toordinal()), default=None)
    avg_pct = round(sum(lv / ex * 100 for _d, lv, ex in counted) / len(counted), 1) if counted else None
    summary = [
        {"label": "Days in range", "value": len(days), "format": "integer"},
        {"label": "Departments", "value": len(order), "format": "integer"},
        {"label": "Peak leave day",
         "value": f"{display_date(peak[0])} ({peak[1]:g} on leave)" if peak and peak[1] > 0 else None, "format": "text"},
        {"label": "Average daily leave %", "value": avg_pct, "format": "percent"},
    ]
    notes = [
        "Strength is today's active employees of the department who had joined by that day (department "
        "history is not stored). Sundays are the weekly off for staff and public holidays are off for "
        "everyone: those employees are left out of the counts, and a fully-off department shows dashes.",
        "Each employee is counted once per day as full-day leave, else casual leave, else half-day leave "
        "(half-day = 0.5 in Leave %). Only approved requests are counted. Approved on-duty sessions are placed on "
        "the day they were requested (IST), because a session has no date of its own.",
        "'Absent (no leave)' counts stored attendance records marked Absent that no approved leave covers; days "
        "that were never computed have no record, so it can under-state absence.",
    ]
    hidden = [name for key, name in (
        ("leave", "leave"), ("casual", "casual leave"), ("duty", "on-duty"), ("permission", "permission"),
        ("absent", "attendance"),
    ) if not can[key]]
    if hidden:
        notes.append("Columns left blank because your role cannot open that module elsewhere: " + ", ".join(hidden) + ".")
    if unreadable:
        notes.append(C.id_list_note(
            f"{len(unreadable)} approved leave request(s) with unreadable dates are not counted", unreadable,
        ))
    return ReportResult(rows=rows, summary=summary, notes=notes)


register(ReportSpec(
    id="leave-department-calendar",
    title="Daily Leave Load by Department",
    description="Per day and department: strength, employees on leave, casual leave, on duty, permission and unexplained absence.",
    category=CATEGORY,
    icon="CalendarClock",
    tags=("leave calendar", "absence", "strength", "department"),
    modules=("leave", "casual_leave", "requests", "geo_attendance", "attendance"),
    filters=(
        date_range(max_days=31, label="Dates"),
        *scope(designation=False, employee=False, status=None),
    ),
    columns=_CALENDAR_COLUMNS,
    run=_run_leave_calendar,
))


# ══════════════════════════════════════════════════════════════════════════════
#  Holiday Calendar
# ══════════════════════════════════════════════════════════════════════════════

_HOLIDAY_COLUMNS = (
    ColumnSpec("date", "Date", DATE, 1.1),
    ColumnSpec("weekday", "Day", TEXT, 1.0),
    ColumnSpec("name", "Holiday", TEXT, 2.4),
    ColumnSpec("holidayType", "Type", BADGE, 1.0),
    ColumnSpec("scope", "Applies to", TEXT, 1.5),
    ColumnSpec("department", "Department", TEXT, 1.5),
    ColumnSpec("isRecurring", "Recurring", BADGE, 0.9),
    ColumnSpec("onSunday", "On a Sunday", BADGE, 0.9),
    ColumnSpec("description", "Notes", TEXT, 2.4),
)


def _run_holiday_list(ctx) -> ReportResult:
    qs = Holiday.objects.select_related("branch", "department").filter(date__year=ctx.year)
    branch_scope = get_branch_scope(ctx.request)
    if branch_scope is not None:
        # A branch user sees their own branch's holidays plus company-wide ones (no branch) -- but not a
        # company-wide row that is tied to another branch's department.
        qs = qs.filter(
            Q(branch_id=branch_scope)
            | (Q(branch_id__isnull=True) & (Q(department_id__isnull=True) | Q(department__branch_id=branch_scope)))
        )
    if ctx.params.get("branch_ids"):
        qs = qs.filter(Q(branch_id__in=ctx.params["branch_ids"]) | Q(branch_id__isnull=True))
    if ctx.params.get("department_ids"):
        qs = qs.filter(Q(department_id__in=ctx.params["department_ids"]) | Q(department_id__isnull=True))
    if ctx.param("holidayType"):
        qs = qs.filter(holiday_type=ctx.param("holidayType"))

    rows = []
    date_counts: dict[date, int] = defaultdict(int)
    type_counts: dict[str, int] = defaultdict(int)
    for h in qs.order_by("date", "id"):
        date_counts[h.date] += 1
        type_counts[h.holiday_type] += 1
        rows.append({
            "date": h.date.isoformat(),
            "weekday": h.date.strftime("%A"),
            "name": h.name,
            "holidayType": h.holiday_type,
            "scope": h.branch.name if h.branch_id else "All branches",
            "department": h.department.name if h.department_id else "All departments",
            "isRecurring": "Yes" if h.is_recurring else "No",
            "onSunday": "Yes" if h.date.weekday() == 6 else "No",
            "description": (h.description or "").strip() or None,
        })
    on_sunday = sum(1 for d in date_counts if d.weekday() == 6)
    summary = [
        {"label": "Holidays listed", "value": len(rows), "format": "integer"},
        {"label": "Distinct dates", "value": len(date_counts), "format": "integer"},
        {"label": "National", "value": type_counts.get("national", 0), "format": "integer"},
        {"label": "Regional", "value": type_counts.get("regional", 0), "format": "integer"},
        {"label": "Company", "value": type_counts.get("company", 0), "format": "integer"},
        {"label": "Fall on a Sunday", "value": on_sunday, "format": "integer"},
        {"label": "Working-day holidays", "value": len(date_counts) - on_sunday, "format": "integer"},
    ]
    notes = [
        "The attendance and payroll engines treat every holiday as company-wide, whatever branch or department "
        "is shown in 'Applies to' / 'Department'.",
        "'Recurring' is only a flag: a recurring holiday is not repeated automatically, so it needs its own row "
        "for each year. Holidays on a Sunday give staff no extra day off.",
    ]
    dup = sum(1 for n in date_counts.values() if n > 1)
    if dup:
        notes.append(f"{dup} date(s) have more than one holiday row.")
    return ReportResult(rows=rows, summary=summary, notes=notes)


register(ReportSpec(
    id="holiday-list",
    title="Holiday Calendar",
    description="The year's holiday list with weekday, type, branch / department scope and whether it falls on a Sunday.",
    category=CATEGORY,
    icon="CalendarDays",
    tags=("holiday", "calendar", "festival", "weekly off"),
    modules=("leave",),
    landscape=False,
    filters=(
        year(),
        select("holidayType", "Holiday type", (("national", "National"), ("regional", "Regional"), ("company", "Company"))),
        branches(),
        departments(),
    ),
    columns=_HOLIDAY_COLUMNS,
    run=_run_holiday_list,
))

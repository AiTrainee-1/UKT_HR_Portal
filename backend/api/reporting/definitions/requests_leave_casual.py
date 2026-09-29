"""Casual Leave reports: the CL register (every request, reviewer, turnaround, attendance outcome) and the
eligibility / yearly-usage board.

Casual Leave is its own paid-leave system (``CasualLeaveRequest``): staff only, one per calendar month
(a pending or approved request uses the slot, a rejected one does not), eligible after 6 completed months of
service, 12 per year (a display entitlement -- it is a constant in the app, not a LeaveBalance row). Deciding a
request writes the day's attendance record (approved = paid present, rejected = marked leave), which this
report checks against but never changes.
"""

from __future__ import annotations

from collections import defaultdict
from datetime import date

from api.models import AttendanceDayRecord, CasualLeaveRequest

from ..common import EMP_COLS, emp_cells
from ..filters import date_range, period, scope, select
from ..formatting import MONTH_ABBR, fmt_dt
from ..registry import register
from ..types import BADGE, DATE, DATETIME, HOURS, INTEGER, TEXT, ColumnSpec, ReportResult, ReportSpec
from . import requests_leave_common as C

CATEGORY = "leave"
STATUS_OPTIONS = (("pending", "Pending"), ("approved", "Approved"), ("rejected", "Rejected"))


# ══════════════════════════════════════════════════════════════════════════════
#  Casual Leave Records
# ══════════════════════════════════════════════════════════════════════════════

_REGISTER_COLUMNS = (
    *EMP_COLS,
    ColumnSpec("joinDate", "Joined", DATE, 1.1),
    ColumnSpec("serviceMonths", "Service (months)", INTEGER, 0.8),
    ColumnSpec("clDate", "CL date", DATE, 1.1),
    ColumnSpec("weekday", "Day", TEXT, 0.7),
    ColumnSpec("reason", "Reason", TEXT, 2.0),
    ColumnSpec("appliedOn", "Applied on", DATETIME, 1.4),
    ColumnSpec("status", "Status", BADGE, 1.0),
    ColumnSpec("reviewedBy", "Reviewed by", TEXT, 1.5),
    ColumnSpec("reviewerRole", "Role", BADGE, 0.8),
    ColumnSpec("reviewedAt", "Reviewed at", DATETIME, 1.4),
    ColumnSpec("turnaroundHours", "Turnaround (hrs)", HOURS, 0.9),
    ColumnSpec("reviewComment", "Comment", TEXT, 1.5),
    ColumnSpec("attendanceOutcome", "Attendance outcome", BADGE, 1.6),
)


def _outcome(status: str, record) -> str | None:
    """What the request did to the day, checked against the stored attendance record."""
    if status == "pending":
        return "Awaiting decision"
    note = (record[1] if record else "") or ""
    if status == "approved":
        return "Paid present" if note.startswith("Casual Leave (paid)") else "Not reflected in attendance"
    if status == "rejected":
        if record and record[0] == "on_leave" and note.startswith("Casual Leave rejected"):
            return "Marked unpaid leave"
        return "Not reflected in attendance"
    return None


def _run_cl_register(ctx) -> ReportResult:
    from api.casual_leave_views import _parse_join_date, _service_months

    d_from, d_to = ctx.date_from, ctx.date_to
    qs = (
        CasualLeaveRequest.objects.select_related("employee__department", "employee__designation")
        .filter(ctx.emp_q("employee__"), date__range=(d_from, d_to))
        .order_by("date", "employee__employee_code", "id")
    )
    if ctx.param("status"):
        qs = qs.filter(status=ctx.param("status"))
    if ctx.param("reviewerRole"):
        qs = qs.filter(reviewer_role=ctx.param("reviewerRole"))
    items = list(qs)

    records: dict[tuple[int, date], tuple[str, str]] = {}
    if items:
        for eid, d, st, note in AttendanceDayRecord.objects.filter(
            employee_id__in={r.employee_id for r in items}, date__range=(d_from, d_to)
        ).values_list("employee_id", "date", "status", "override_note"):
            records[(eid, d)] = (st, note or "")

    rows = []
    turnarounds: list[float] = []
    counts = defaultdict(int)
    for r in items:
        emp = r.employee
        st = C.status_badge(r.status)
        counts[st] += 1
        joined = _parse_join_date(emp.join_date)
        hours = C.hours_between(r.created_at, r.reviewed_at)
        if hours is not None:
            turnarounds.append(hours)
        rows.append({
            **emp_cells(emp),
            "joinDate": joined.isoformat() if joined else None,
            "serviceMonths": _service_months(emp, r.date),
            "clDate": r.date.isoformat(),
            "weekday": r.date.strftime("%a"),
            "reason": (r.reason or "").strip() or None,
            "appliedOn": fmt_dt(r.created_at),
            "status": st,
            "reviewedBy": r.reviewed_by or None,
            "reviewerRole": C.role_label(r.reviewer_role),
            "reviewedAt": fmt_dt(r.reviewed_at),
            "turnaroundHours": hours,
            "reviewComment": (r.review_comment or "").strip() or None,
            "attendanceOutcome": _outcome(st, records.get((r.employee_id, r.date))),
        })

    summary = [
        {"label": "Casual leave requests", "value": len(rows), "format": "integer"},
        {"label": "Approved (paid days)", "value": counts["approved"], "format": "integer"},
        {"label": "Rejected", "value": counts["rejected"], "format": "integer"},
        {"label": "Pending", "value": counts["pending"], "format": "integer"},
        {"label": "Employees", "value": len({r["employeeCode"] for r in rows}), "format": "integer"},
        {"label": "Average turnaround (hrs)",
         "value": round(sum(turnarounds) / len(turnarounds), 2) if turnarounds else None, "format": "hours"},
    ]
    notes = [
        "An approved casual leave is written to attendance as a paid full present day; a rejected one is written "
        "as an unpaid leave day even if the employee punched that day. 'Attendance outcome' checks the stored "
        "attendance record: 'Not reflected in attendance' means the day record was removed or later changed by "
        "an HR override, and a request HR deleted leaves its attendance entry behind.",
        "Service (months) is completed months of service on the casual leave date. Turnaround is the time from "
        "filing to the reviewer's decision. All times are IST. One request per calendar month is allowed, so two "
        "in a month means the first was rejected.",
    ]
    return ReportResult(rows=rows, summary=summary, notes=notes)


register(ReportSpec(
    id="casual-leave-register",
    title="Casual Leave Records",
    description="Every casual leave request with service length, reviewer, turnaround and the attendance outcome it produced.",
    category=CATEGORY,
    icon="CalendarCheck",
    tags=("casual leave", "cl", "paid leave"),
    family="casual-leave",
    variant="Records",
    modules=("casual_leave",),
    filters=(
        date_range(label="Casual leave date"),
        *scope(status="all"),
        select("status", "Status", STATUS_OPTIONS),
        select("reviewerRole", "Reviewed by", (("hr", "HR"), ("dept_head", "Department head"))),
    ),
    columns=_REGISTER_COLUMNS,
    run=_run_cl_register,
))


# ══════════════════════════════════════════════════════════════════════════════
#  Casual Leave Eligibility & Yearly Usage
# ══════════════════════════════════════════════════════════════════════════════

_ELIGIBILITY_LABELS = {
    "eligible": "Eligible",
    "not_eligible_service": "Not yet eligible",
    "used_this_month": "Used this month",
    "no_join_date": "No join date",
}

_ELIGIBILITY_COLUMNS = (
    *EMP_COLS,
    ColumnSpec("joinDate", "Joined", DATE, 1.1),
    ColumnSpec("serviceMonths", "Service (months)", INTEGER, 0.8),
    ColumnSpec("eligibleFrom", "Eligible from", DATE, 1.1),
    ColumnSpec("eligible", "Eligibility", BADGE, 1.2),
    ColumnSpec("reason", "Reason", TEXT, 2.2),
    ColumnSpec("approvedThisYear", "Approved (year)", INTEGER, 0.9, total="sum"),
    ColumnSpec("pendingThisYear", "Pending (year)", INTEGER, 0.9, total="sum"),
    ColumnSpec("remainingThisYear", "Remaining (year)", INTEGER, 0.9, total="sum"),
    ColumnSpec("monthsUsed", "Months used", TEXT, 1.8),
)


def _run_cl_eligibility(ctx) -> ReportResult:
    from api.casual_leave_views import CL_YEARLY_ENTITLEMENT, ELIGIBILITY_MONTHS, _parse_join_date, _service_months

    yr, month = ctx.period
    check_date = date(yr, month, 15)  # the same representative day the HR eligibility board uses
    employees = list(ctx.employees().filter(employment_type="staff"))

    usage: dict[int, dict] = defaultdict(lambda: {"approved": 0, "pending": 0, "months": {}})
    for eid, d, st in CasualLeaveRequest.objects.filter(
        ctx.emp_q("employee__"), employee__employment_type="staff", date__year=yr, status__in=("approved", "pending"),
    ).values_list("employee_id", "date", "status"):
        u = usage[eid]
        u[st] += 1
        # An approved request outranks a pending one that is in the same month (cannot normally happen).
        if u["months"].get(d.month) != "approved":
            u["months"][d.month] = st

    wanted = ctx.param("eligibility")
    rows = []
    for emp in employees:
        u = usage.get(emp.id) or {"approved": 0, "pending": 0, "months": {}}
        months = _service_months(emp, check_date)
        joined = _parse_join_date(emp.join_date)
        used_now = u["months"].get(month)
        if months is None:
            key, reason = "no_join_date", "Join date not set or not readable"
        elif months < ELIGIBILITY_MONTHS:
            key, reason = "not_eligible_service", f"{months}/{ELIGIBILITY_MONTHS} months of service"
        elif used_now:
            key, reason = "used_this_month", "Casual Leave already used this month (limit: 1 per month)"
        else:
            key, reason = "eligible", None
        if wanted and wanted != key:
            continue
        used_text = ", ".join(
            MONTH_ABBR[m - 1] + (" (pending)" if s == "pending" else "") for m, s in sorted(u["months"].items())
        )
        rows.append({
            **emp_cells(emp),
            "joinDate": joined.isoformat() if joined else None,
            "serviceMonths": months,
            "eligibleFrom": C.add_months(joined, ELIGIBILITY_MONTHS).isoformat() if joined else None,
            "eligible": _ELIGIBILITY_LABELS[key],
            "reason": reason,
            "approvedThisYear": u["approved"],
            "pendingThisYear": u["pending"],
            "remainingThisYear": max(0, CL_YEARLY_ENTITLEMENT - u["approved"]),
            "monthsUsed": used_text or None,
            "_key": key,
        })

    count = defaultdict(int)
    for r in rows:
        count[r["_key"]] += 1
    summary = [
        {"label": "Eligible", "value": count["eligible"], "format": "integer"},
        {"label": "Not yet eligible", "value": count["not_eligible_service"], "format": "integer"},
        {"label": "Used this month", "value": count["used_this_month"], "format": "integer"},
        {"label": "No join date", "value": count["no_join_date"], "format": "integer"},
        {"label": f"Approved casual leave in {yr}", "value": sum(r["approvedThisYear"] for r in rows), "format": "integer"},
        {"label": f"No approved casual leave in {yr}", "value": sum(1 for r in rows if not r["approvedThisYear"]),
         "format": "integer"},
    ]
    notes = [
        f"Eligibility is judged as of the 15th of the selected month (as on the HR eligibility board): staff only, "
        f"at least {ELIGIBILITY_MONTHS} completed months of service, and no pending or approved casual leave in "
        "that month (a rejected request does not use the monthly slot). Production employees are not covered "
        "because casual leave is a staff benefit.",
        f"The yearly entitlement is {CL_YEARLY_ENTITLEMENT} days and is a constant in the app; remaining = "
        f"{CL_YEARLY_ENTITLEMENT} - approved requests in {yr}. Join dates are read in any of the formats the "
        "employee record allows (YYYY-MM-DD, DD/MM/YYYY, DD-MM-YYYY).",
    ]
    return ReportResult(rows=rows, summary=summary, notes=notes)


register(ReportSpec(
    id="casual-leave-eligibility-usage",
    title="Casual Leave Eligibility & Usage",
    description="Staff service length, casual leave eligibility, months already used and the yearly entitlement left.",
    category=CATEGORY,
    icon="CalendarCheck",
    tags=("casual leave", "eligibility", "entitlement"),
    family="casual-leave",
    variant="Eligibility & Usage",
    modules=("casual_leave",),
    filters=(
        period(label="Eligibility month"),
        *scope(employment=False, status="active"),
        select("eligibility", "Eligibility", tuple(_ELIGIBILITY_LABELS.items())),
    ),
    columns=_ELIGIBILITY_COLUMNS,
    run=_run_cl_eligibility,
))

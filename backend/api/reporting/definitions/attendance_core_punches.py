"""Punch-level and audit reports: the raw Punch Log, Punch Exceptions, Unmatched Device IDs and Manual Attendance
Overrides. All read-only; none computes or writes attendance.
"""

from __future__ import annotations

import datetime as dt
from collections import Counter

from django.db.models import Count, F, IntegerField, OuterRef, Q, Subquery
from django.db.models.functions import Coalesce, Mod

from api.geo_attendance_views import source_label
from api.models import AttendanceDayRecord, AttendanceLog, AttendanceOverrideRequest, Employee, UnmatchedPunch

from ..filters import date_range, select, text
from ..formatting import fmt_dt
from ..registry import register
from ..types import BADGE, DATE, DATETIME, INTEGER, TEXT, TIME, ColumnSpec, ReportResult, ReportSpec
from .attendance_core_data import (
    EXC_DUPLICATE,
    EXC_MANY,
    EXC_NO_PUNCHES,
    EXC_ON_HOLIDAY,
    EXC_ON_LEAVE,
    EXC_ODD,
    EXC_SINGLE,
    EXCEPTION_LABELS,
    AttendanceData,
    build_day,
    device_of,
    drop_dormant,
    emp_days_guard,
    hhmm,
    scope_filters,
    scoped_employees,
    weekday_text,
)


def _name(emp) -> str:
    return f"{emp.first_name or ''} {emp.last_name or ''}".strip()


# ── Punch Log ───────────────────────────────────────────────────────────────────

SOURCE_OPTIONS = [
    ("biometric", "Biometric device"),
    ("geo", "Geo punch"),
    ("on_duty", "On-duty"),
    ("missing_punch", "Missing punch (approved)"),
    ("manual", "HR / manual entry"),
]
_SOURCE_Q = {
    "biometric": Q(source__startswith="biometric"),
    "geo": Q(source="geo:auto"),
    "on_duty": Q(source="on_duty:approved"),
    "missing_punch": Q(source="missing_punch:approved"),
    "manual": Q(source__startswith="manual"),
}
POSITION_OPTIONS = [("first", "First punch of the day"), ("last", "Last punch of the day")]

PUNCH_COLUMNS = (
    ColumnSpec("employeeCode", "Emp Code", TEXT, 1.0),
    ColumnSpec("employeeName", "Employee", TEXT, 2.2),
    ColumnSpec("department", "Department", TEXT, 1.4),
    ColumnSpec("date", "Date", DATE, 1.1),
    ColumnSpec("day", "Day", TEXT, 0.6),
    ColumnSpec("punchNo", "Punch No", INTEGER, 0.7),
    ColumnSpec("punchTime", "Time", TEXT, 0.9, align="center"),
    ColumnSpec("direction", "In / Out", BADGE, 0.7),
    ColumnSpec("dayPunches", "Punches That Day", INTEGER, 0.9),
    ColumnSpec("sourceLabel", "Source", TEXT, 1.1),
    ColumnSpec("device", "Device", TEXT, 1.3),
    ColumnSpec("storedType", "Stored Type", TEXT, 0.8, align="center"),
)


def _same_day():
    return AttendanceLog.objects.filter(employee_id=OuterRef("employee_id"), date=OuterRef("date")).order_by()


def _run_punch_log(ctx) -> ReportResult:
    base = AttendanceLog.objects.filter(ctx.emp_q("employee__"), date__gte=ctx.date_from, date__lte=ctx.date_to)
    src = ctx.params.get("source")
    scoped = base.filter(_SOURCE_Q[src]) if src else base

    # Position / count of a punch among ALL that employee's punches of the day (not just the filtered ones), by
    # correlated subqueries, so the source filter and the row limit never disturb the numbering.
    earlier = _same_day().filter(
        Q(punch_time__lt=OuterRef("punch_time")) | Q(punch_time=OuterRef("punch_time"), id__lt=OuterRef("id"))
    )
    rows_qs = scoped.select_related("employee", "employee__department").annotate(
        pos=Coalesce(
            Subquery(earlier.values("employee_id").annotate(c=Count("id")).values("c"), output_field=IntegerField()), 0
        )
        + 1,
        cnt=Coalesce(
            Subquery(
                _same_day().values("employee_id").annotate(c=Count("id")).values("c"), output_field=IntegerField()
            ),
            0,
        ),
    )
    position = ctx.params.get("punchPosition")
    if position == "first":
        rows_qs = rows_qs.filter(pos=1)
    elif position == "last":
        rows_qs = rows_qs.filter(pos=F("cnt"))
    rows_qs = rows_qs.order_by(
        "employee__first_name", "employee__last_name", "employee_id", "date", "punch_time", "id"
    )[: ctx.row_limit]

    rows = []
    for log in rows_qs:
        emp = log.employee
        rows.append(
            {
                "employeeCode": emp.employee_code,
                "employeeName": _name(emp),
                "department": emp.department.name if emp.department_id else "Unassigned",
                "date": log.date.isoformat(),
                "day": weekday_text(log.date),
                "punchNo": log.pos,
                "punchTime": log.punch_time.strftime("%H:%M:%S"),
                "direction": "IN" if log.pos % 2 else "OUT",
                "dayPunches": log.cnt,
                "sourceLabel": source_label(log.source),
                "device": device_of(log.source),
                "storedType": log.punch_type,
            }
        )

    total = scoped.count()
    people = scoped.order_by().values("employee_id").distinct().count()
    emp_days = scoped.order_by().values("employee_id", "date").distinct().count()
    odd_days = (
        base.order_by()
        .values("employee_id", "date")
        .annotate(n=Count("id"))
        .annotate(m=Mod("n", 2))
        .filter(m=1)
        .count()
    )
    by_label: Counter = Counter()
    for source, n in scoped.values_list("source").annotate(n=Count("id")).order_by():
        by_label[source_label(source)] += n
    notes = [
        "Every raw punch stored for the period. In / Out is positional (the 1st, 3rd ... punch of an employee's day is In, "
        "the 2nd, 4th ... is Out) because the device's own In / Out flag is unreliable; the stored flag is shown "
        "separately. A punch belongs to the calendar date the device stamped; the engine may move a night exit to the "
        "previous working day (see Time Card).",
        "By source: " + ", ".join(f"{k} {v:,}" for k, v in by_label.most_common()) + "."
        if by_label
        else "No punches in this period.",
        f"'Days with an odd punch count' ({odd_days:,}) is counted over all sources for the same employees and dates.",
    ]
    summary = [
        {"label": "Punches", "value": total, "format": "integer"},
        {"label": "Employees", "value": people, "format": "integer"},
        {"label": "Employee-days", "value": emp_days, "format": "integer"},
        {"label": "Days with odd punch count", "value": odd_days, "format": "integer"},
        {"label": "Biometric punches", "value": by_label.get("Biometric", 0), "format": "integer"},
        {"label": "Other sources", "value": total - by_label.get("Biometric", 0), "format": "integer"},
    ]
    return ReportResult(rows=rows, summary=summary, notes=notes)


register(
    ReportSpec(
        id="punch-log",
        title="Punch Log",
        description="Every raw biometric, geo, on-duty and manual punch with positional In / Out, source and device - "
        "complete, never silently cut off.",
        category="attendance",
        icon="Fingerprint",
        tags=("punch", "biometric", "raw", "log", "in out", "device"),
        modules=("attendance",),
        filters=(
            date_range(default="today", label="Date range", max_days=62),
            *scope_filters(status="all"),
            select("source", "Source", SOURCE_OPTIONS, placeholder="All sources"),
            select("punchPosition", "Punches", POSITION_OPTIONS, placeholder="All punches"),
        ),
        columns=PUNCH_COLUMNS,
        run=_run_punch_log,
        landscape=True,
        screen_limit=10_000,
        pdf_max_rows=5_000,
    )
)


# ── Punch Exceptions ────────────────────────────────────────────────────────────

SUGGESTIONS = {
    EXC_SINGLE: "Only one punch: the engine treats the day as a Half Day (or Absent if it fell 13:30-14:30). If the "
    "other punch was missed, raise a Missing Punch request.",
    EXC_ODD: "Odd number of punches: one In or Out is missing - check the sequence and raise a Missing Punch request.",
    EXC_MANY: "Six or more punches: usually two people sharing one device user ID, or repeated taps. Check the device ID.",
    EXC_DUPLICATE: "Two punches within 5 minutes: a double tap (ignored when counting worked hours).",
    EXC_NO_PUNCHES: "Marked present with no punches - a leftover presence entry. Confirm the attendance or correct it.",
    EXC_ON_LEAVE: "Punches on a day of approved leave: the punches win and the day counts as worked. Confirm the leave.",
    EXC_ON_HOLIDAY: "Punches on a company holiday: worked holiday - check whether compensation is due.",
}
EXCEPTION_OPTIONS = [(k, v) for k, v in EXCEPTION_LABELS.items()]

EXC_COLUMNS = (
    ColumnSpec("employeeCode", "Emp Code", TEXT, 1.0),
    ColumnSpec("employeeName", "Employee", TEXT, 2.2),
    ColumnSpec("department", "Department", TEXT, 1.4),
    ColumnSpec("date", "Date", DATE, 1.1),
    ColumnSpec("day", "Day", TEXT, 0.6),
    ColumnSpec("exceptionType", "Exception", BADGE, 1.4),
    ColumnSpec("punchCount", "Punches", INTEGER, 0.7),
    ColumnSpec("punches", "Punch Times", TEXT, 2.0),
    ColumnSpec("status", "Day Status", BADGE, 1.0),
    ColumnSpec("source", "Source", TEXT, 1.0),
    ColumnSpec("suggestion", "What to check", TEXT, 3.6),
)


def _run_exceptions(ctx) -> ReportResult:
    days = ctx.days_in_range
    employees = scoped_employees(ctx, order="dept_code")
    emp_days_guard(len(employees), len(days))
    data = AttendanceData(ctx, employees, ctx.date_from, ctx.date_to, punches=True, leaves=True)
    employees = drop_dormant(ctx, employees, data)
    want = ctx.params.get("exceptionType")

    rows: list[dict] = []
    by_type: Counter = Counter()
    people: set[int] = set()
    half_from_single = 0
    for emp in employees:
        for d in days:
            day = build_day(data, emp, d)
            for key in day.issues:
                if want and key != want:
                    continue
                rec = day.rec
                p = day.punches
                rows.append(
                    {
                        "employeeCode": emp.employee_code,
                        "employeeName": _name(emp),
                        "department": emp.department.name if emp.department_id else "Unassigned",
                        "date": d.isoformat(),
                        "day": weekday_text(d),
                        "exceptionType": EXCEPTION_LABELS[key],
                        "punchCount": len(p) or None,
                        "punches": ", ".join(hhmm(x.at) + (" (+1)" if x.on > d else "") for x in p) or None,
                        "status": day.label,
                        "source": (rec.primary_source if rec is not None else None) or None,
                        "suggestion": SUGGESTIONS[key],
                    }
                )
                by_type[key] += 1
                people.add(emp.id)
                if key == EXC_SINGLE and rec is not None and rec.status == "half_shift":
                    half_from_single += 1
            if len(rows) > ctx.row_limit:
                break
        if len(rows) > ctx.row_limit:
            break

    notes = [
        "Days that need HR's attention, read from the raw punches (night exits placed on the day they close, exactly as "
        "the engine does) and the stored day verdict. One row per exception; a day can appear under several types.",
        f"{half_from_single} single-punch day(s) were silently counted as a Half Day by the engine's two-half rule.",
        "Today is left out of the single / odd punch checks (the employee may still be in the shift). Double taps are two "
        "punches within 5 minutes.",
    ]
    summary = [
        {"label": "Exceptions", "value": len(rows), "format": "integer"},
        {"label": "Employees", "value": len(people), "format": "integer"},
        {"label": "Single punch", "value": by_type[EXC_SINGLE], "format": "integer"},
        {"label": "Odd punches", "value": by_type[EXC_ODD], "format": "integer"},
        {"label": "Many punches", "value": by_type[EXC_MANY], "format": "integer"},
        {"label": "Duplicate taps", "value": by_type[EXC_DUPLICATE], "format": "integer"},
        {"label": "Present without punches", "value": by_type[EXC_NO_PUNCHES], "format": "integer"},
        {"label": "On leave / holiday", "value": by_type[EXC_ON_LEAVE] + by_type[EXC_ON_HOLIDAY], "format": "integer"},
    ]
    return ReportResult(rows=rows, summary=summary, notes=notes)


register(
    ReportSpec(
        id="punch-exceptions",
        title="Punch Exceptions",
        description="Days needing attention: single or odd punches, missing out-punch, six-plus punches, double taps, "
        "present without punches and punches on leave or holidays.",
        category="attendance",
        icon="AlertTriangle",
        tags=("missing punch", "odd punches", "single punch", "exceptions", "duplicate", "data quality"),
        modules=("attendance",),
        filters=(
            date_range(default="thisMonth", label="Date range", max_days=62),
            *scope_filters(status="all"),
            select("exceptionType", "Exception", EXCEPTION_OPTIONS, placeholder="All exceptions"),
        ),
        columns=EXC_COLUMNS,
        run=_run_exceptions,
        landscape=True,
        screen_limit=10_000,
        pdf_max_rows=5_000,
    )
)


# ── Unmatched Device IDs ────────────────────────────────────────────────────────

SEEN_OPTIONS = [("7", "Punched in the last 7 days"), ("30", "Punched in the last 30 days")]
RESOLVED_OPTIONS = [("unresolved", "Unresolved"), ("resolved", "Resolved"), ("all", "All")]

UNMATCHED_COLUMNS = (
    ColumnSpec("deviceUserId", "Device User ID", TEXT, 1.2),
    ColumnSpec("deviceLabel", "Device", TEXT, 1.4),
    ColumnSpec("deviceSerial", "Device Serial", TEXT, 1.4),
    ColumnSpec("punchCount", "Punches Discarded", INTEGER, 1.0, total="sum"),
    ColumnSpec("firstSeenAt", "First Seen", DATETIME, 1.4),
    ColumnSpec("lastSeenAt", "Last Seen", DATETIME, 1.4),
    ColumnSpec("lastPunchDate", "Last Punch Date", DATE, 1.1),
    ColumnSpec("lastPunchTime", "Last Punch Time", TIME, 0.9),
    ColumnSpec("matchHint", "Match Hint", TEXT, 3.0),
    ColumnSpec("resolved", "State", BADGE, 0.9),
    ColumnSpec("resolvedNote", "Resolution Note", TEXT, 2.0),
)


def _match_hint(device_user_id: str, emp) -> str:
    if emp is None:
        return "No employee has this code - register the employee or fix the device user ID."
    who = f"{emp.employee_code} {_name(emp)}".strip()
    if emp.status != "active":
        return (
            f"Employee {who} exists but is {emp.status}: the device pull ignores inactive employees, "
            "so their punches land here."
        )
    return f"Employee {who} exists and is active - the ID may have been fixed after these punches; check whether it is resolved."


def _run_unmatched(ctx) -> ReportResult:
    from api.branch_scope import get_branch_scope

    if get_branch_scope(ctx.request) is not None:
        return ReportResult(
            rows=[],
            notes=[
                "Device IDs that match no employee have no branch link, so this list is company-wide and is shown only to HR "
                "users who are not restricted to a branch."
            ],
        )
    qs = UnmatchedPunch.objects.all()
    state = ctx.params.get("resolved") or "unresolved"
    if state == "unresolved":
        qs = qs.filter(resolved=False)
    elif state == "resolved":
        qs = qs.filter(resolved=True)
    seen = ctx.params.get("seen")
    if seen:
        qs = qs.filter(last_punch_date__gte=ctx.today - dt.timedelta(days=int(seen) - 1))
    term = ctx.params.get("device")
    if term:
        qs = qs.filter(Q(device_label__icontains=term) | Q(device_serial__icontains=term))
    uid = ctx.params.get("deviceUserId")
    if uid:
        qs = qs.filter(device_user_id__icontains=uid)
    items = list(qs.order_by("-last_seen_at", "device_user_id", "device_serial")[: ctx.row_limit])
    emps = {e.employee_code: e for e in Employee.objects.filter(employee_code__in=[u.device_user_id for u in items])}

    rows = [
        {
            "deviceUserId": u.device_user_id,
            "deviceLabel": u.device_label or None,
            "deviceSerial": u.device_serial or None,
            "punchCount": u.punch_count,
            "firstSeenAt": fmt_dt(u.first_seen_at),
            "lastSeenAt": fmt_dt(u.last_seen_at),
            "lastPunchDate": u.last_punch_date.isoformat() if u.last_punch_date else None,
            "lastPunchTime": hhmm(u.last_punch_time),
            "matchHint": _match_hint(u.device_user_id, emps.get(u.device_user_id)),
            "resolved": "Resolved" if u.resolved else "Unresolved",
            "resolvedNote": u.resolved_note or None,
        }
        for u in items
    ]

    week_ago = ctx.today - dt.timedelta(days=6)
    unresolved = UnmatchedPunch.objects.filter(resolved=False)
    recent = unresolved.filter(last_punch_date__gte=week_ago).count()
    discarded = sum(unresolved.values_list("punch_count", flat=True))
    summary = [
        {"label": "Unresolved IDs", "value": unresolved.count(), "format": "integer"},
        {"label": "Punches discarded (approx.)", "value": discarded, "format": "integer"},
        {"label": "Punched in last 7 days", "value": recent, "format": "integer"},
        {"label": "Shown", "value": len(rows), "format": "integer"},
    ]
    notes = [
        "Company-wide list of device user IDs whose punches match no employee, so the attendance is being discarded. "
        "Times are shown in IST.",
        "Punch counts are approximate: a device pull re-counts the whole device log on every sync, while the ADMS push "
        "counts about one per punch. The same ID can appear twice (pull rows have no device serial, ADMS rows do).",
    ]
    return ReportResult(rows=rows, summary=summary, notes=notes)


register(
    ReportSpec(
        id="unmatched-punches",
        title="Unmatched Device IDs",
        description="Biometric user IDs that punch but match no employee - attendance that is being discarded - with device, "
        "counts, last punch and a hint about the likely cause.",
        category="attendance",
        icon="Fingerprint",
        tags=("unmatched", "skipped punches", "device", "biometric", "unknown id"),
        modules=("attendance",),
        filters=(
            select(
                "resolved",
                "State",
                RESOLVED_OPTIONS,
                default="unresolved",
                placeholder="Unresolved",
                help="Unresolved IDs are the ones still losing attendance.",
            ),
            select("seen", "Activity", SEEN_OPTIONS, placeholder="Any time"),
            text("device", "Device", placeholder="Device name or serial"),
            text("deviceUserId", "Device user ID"),
        ),
        columns=UNMATCHED_COLUMNS,
        run=_run_unmatched,
        landscape=True,
        screen_limit=5_000,
        pdf_max_rows=3_000,
    )
)


# ── Manual Attendance Overrides ─────────────────────────────────────────────────

REQUEST_STATUS_OPTIONS = [("pending", "Pending"), ("approved", "Approved"), ("rejected", "Rejected")]
ORIGIN_OPTIONS = [
    ("hr_override", "HR override"),
    ("casual_leave", "Casual leave"),
    ("compensation_redemption", "Compensation redemption"),
]
STATUS_TEXT = {
    "present": "Present",
    "half_shift": "Half Day",
    "absent": "Absent",
    "on_leave": "Leave",
    "holiday": "Holiday",
}
O_HR, O_CL, O_CL_REJECTED, O_COMP = (
    "HR override",
    "Casual leave (approved)",
    "Casual leave (rejected)",
    "Compensation redemption",
)

OVERRIDE_COLUMNS = (
    ColumnSpec("employeeCode", "Emp Code", TEXT, 1.0),
    ColumnSpec("employeeName", "Employee", TEXT, 2.0),
    ColumnSpec("department", "Department", TEXT, 1.3),
    ColumnSpec("date", "Attendance Date", DATE, 1.1),
    ColumnSpec("origin", "Origin", TEXT, 1.5),
    ColumnSpec("before", "Before", TEXT, 2.2),
    ColumnSpec("after", "After", TEXT, 2.2),
    ColumnSpec("reason", "Reason / Note", TEXT, 2.2),
    ColumnSpec("status", "Status", BADGE, 0.9),
    ColumnSpec("requestedBy", "Requested By", TEXT, 1.2),
    ColumnSpec("createdAt", "Requested / Applied", DATETIME, 1.3),
    ColumnSpec("reviewedBy", "Reviewed / Applied By", TEXT, 1.3),
    ColumnSpec("reviewedAt", "Reviewed At", DATETIME, 1.3),
    ColumnSpec("reviewComment", "Review Comment", TEXT, 1.8),
)


def describe_values(v) -> str | None:
    """'Absent; late; 09:40 to 18:05; 1.00 shift' from an override request's before / after snapshot."""
    if not isinstance(v, dict) or not v:
        return None
    parts = []
    if v.get("status"):
        parts.append(STATUS_TEXT.get(v["status"], str(v["status"])))
    if v.get("isLate"):
        parts.append("late")
    if v.get("isEarlyOut"):
        parts.append("early out")
    if v.get("isHalfShift") and v.get("status") != "half_shift":
        parts.append("half shift")
    if v.get("firstPunch") or v.get("lastPunch"):
        parts.append(f"{v.get('firstPunch') or '-'} to {v.get('lastPunch') or '-'}")
    if v.get("shiftsEarned") not in (None, ""):
        parts.append(f"{v['shiftsEarned']} shift")
    return "; ".join(parts) or None


def _record_values(rec) -> dict:
    return {
        "status": rec.status,
        "isLate": rec.is_late,
        "isEarlyOut": rec.early_leave,
        "isHalfShift": rec.is_half_shift,
        "firstPunch": hhmm(rec.first_punch),
        "lastPunch": hhmm(rec.last_punch),
        "shiftsEarned": str(rec.shifts_earned),
    }


def _origin_of(rec) -> str:
    note = rec.override_note or ""
    if note.startswith("Casual Leave (paid)"):
        return O_CL
    if note.startswith("Casual Leave rejected"):
        return O_CL_REJECTED
    if note.startswith("Compensation Alternative Day"):
        return O_COMP
    return O_HR


_ORIGIN_KEY = {
    O_HR: "hr_override",
    O_CL: "casual_leave",
    O_CL_REJECTED: "casual_leave",
    O_COMP: "compensation_redemption",
}


def _run_overrides(ctx) -> ReportResult:
    emp_q = ctx.emp_q("employee__")
    status_f = ctx.params.get("requestStatus")
    origin_f = ctx.params.get("origin")
    by_f = (ctx.params.get("requestedBy") or "").strip()
    limit = ctx.row_limit

    rows: list[dict] = []
    sort_keys: list[tuple] = []
    counts: Counter = Counter()

    if origin_f in (None, "hr_override"):
        reqs = AttendanceOverrideRequest.objects.select_related("employee", "employee__department").filter(
            emp_q, date__gte=ctx.date_from, date__lte=ctx.date_to
        )
        if status_f:
            reqs = reqs.filter(status=status_f)
        if by_f:
            reqs = reqs.filter(requested_by__icontains=by_f)
        for r in reqs.order_by("-date", "employee__employee_code", "-created_at", "-id")[:limit]:
            e = r.employee
            counts[r.status] += 1
            rows.append(
                {
                    "employeeCode": e.employee_code,
                    "employeeName": _name(e),
                    "department": e.department.name if e.department_id else "Unassigned",
                    "date": r.date.isoformat(),
                    "origin": O_HR + " request",
                    "before": describe_values(r.previous_values),
                    "after": describe_values(r.requested_values),
                    "reason": r.reason,
                    "status": r.status.title(),
                    "requestedBy": r.requested_by,
                    "createdAt": fmt_dt(r.created_at),
                    "reviewedBy": r.reviewed_by,
                    "reviewedAt": fmt_dt(r.reviewed_at),
                    "reviewComment": r.review_comment,
                }
            )
            sort_keys.append((r.date, e.employee_code, r.id))

    frozen_total = AttendanceDayRecord.objects.filter(
        emp_q, source="manual", date__gte=ctx.date_from, date__lte=ctx.date_to
    ).count()
    if status_f in (None, "approved"):
        # An approved request already appears above; the frozen record it produced must not appear twice.
        approved = set(
            AttendanceOverrideRequest.objects.filter(
                emp_q, status="approved", date__gte=ctx.date_from, date__lte=ctx.date_to
            ).values_list("employee_id", "date")
        )
        recs = AttendanceDayRecord.objects.select_related("employee", "employee__department").filter(
            emp_q, source="manual", date__gte=ctx.date_from, date__lte=ctx.date_to
        )
        if by_f:
            recs = recs.filter(override_by__icontains=by_f)
        for rec in recs.order_by("-date", "employee__employee_code", "-id")[:limit]:
            origin = _origin_of(rec)
            if origin_f and _ORIGIN_KEY[origin] != origin_f:
                continue
            if origin == O_HR and (rec.employee_id, rec.date) in approved:
                continue
            e = rec.employee
            counts["frozen"] += 1
            rows.append(
                {
                    "employeeCode": e.employee_code,
                    "employeeName": _name(e),
                    "department": e.department.name if e.department_id else "Unassigned",
                    "date": rec.date.isoformat(),
                    "origin": origin,
                    "before": None,
                    "after": describe_values(_record_values(rec)),
                    "reason": rec.override_note,
                    "status": "Applied",
                    "requestedBy": None,
                    "createdAt": fmt_dt(rec.updated_at),
                    "reviewedBy": rec.override_by,
                    "reviewedAt": None,
                    "reviewComment": None,
                }
            )
            sort_keys.append((rec.date, e.employee_code, -rec.id))

    # newest attendance date first, then employee code, then the request before the frozen day
    order = sorted(range(len(rows)), key=lambda i: (-sort_keys[i][0].toordinal(), sort_keys[i][1], -sort_keys[i][2]))
    rows = [rows[i] for i in order][:limit]

    notes = [
        "HR proposes an attendance change and a Department Head must approve it before the day is overwritten; every "
        "request is listed with its before / after snapshot. 'Applied' rows are days now frozen as manual (casual leave, "
        "compensation redemption or an HR override) that no longer change when punches change.",
        "Reverting a day to automatic deletes its record and rejects pending requests for it ('Superseded by revert to "
        "automatic'); such days no longer appear as applied. Dates filter the attendance date, not the request date.",
    ]
    summary = [
        {
            "label": "Requests",
            "value": counts["pending"] + counts["approved"] + counts["rejected"],
            "format": "integer",
        },
        {"label": "Pending", "value": counts["pending"], "format": "integer"},
        {"label": "Approved", "value": counts["approved"], "format": "integer"},
        {"label": "Rejected", "value": counts["rejected"], "format": "integer"},
        {"label": "Days frozen as manual", "value": frozen_total, "format": "integer"},
    ]
    return ReportResult(rows=rows, summary=summary, notes=notes)


register(
    ReportSpec(
        id="manual-overrides",
        title="Manual Attendance Overrides",
        description="Audit of HR attendance override requests (pending, approved, rejected, with before / after) and of the "
        "days frozen as manual: casual leave, compensation redemption and HR overrides.",
        category="attendance",
        icon="ShieldCheck",
        tags=("override", "manual", "audit", "approval", "casual leave", "frozen"),
        modules=("attendance",),
        filters=(
            date_range(default="thisMonth", label="Attendance date"),
            *scope_filters(status=None),
            select("requestStatus", "Request status", REQUEST_STATUS_OPTIONS, placeholder="All"),
            select("origin", "Origin", ORIGIN_OPTIONS, placeholder="All"),
            text("requestedBy", "Requested / applied by", placeholder="HR user name"),
        ),
        columns=OVERRIDE_COLUMNS,
        run=_run_overrides,
        landscape=True,
        screen_limit=5_000,
        pdf_max_rows=3_000,
    )
)

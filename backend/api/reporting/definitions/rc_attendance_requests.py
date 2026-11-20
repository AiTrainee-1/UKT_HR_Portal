"""Attendance category, requests side (the owner's 2026-11-19 Report Center layout, layout.py ATTENDANCE 8, 9, 12-14):

* ``leave-report``            Leave Report: every LeaveRequest and every Casual Leave (CasualLeaveRequest) in a range.
* ``employee-overall-leave``  Individual Employee Overall Leave Report: one employee's year in one statement.
* ``geo-attendance``          Geo Attendance Report: punches made from the mobile app with location.
* ``on-duty-report``          On-Duty Report: the on-duty session register (the retired ``on-duty-register``).
* ``on-duty-punch-details``   On-Duty with Punch Details: each on-duty day with every punch of that day.

Data used (all read-only; nothing here writes):

* Leave: ``LeaveRequest`` (TEXT start/end dates: overlap tests on ISO strings, requests_leave_common) and
  ``CasualLeaveRequest`` (one date, portion full / first_half / second_half = 1 / 0.5 / 0.5 day). Casual Leave balance
  figures come from ``api/cl_balance.py`` (12 days a calendar year from the cut-over ``PayrollSettings.cl_balance_since``,
  pending holds days, rejected frees them, Carry Forward CL counts whatever its date, a CL on an unworked new-rule birthday
  uses no balance). The cut-over is read without the get_or_create ``cl_balance.since()`` does.
* Geo: the app records location in three places, and only two of them are punches.
  1. Office Geo Punch: ``AttendanceLog`` rows with ``source="geo:auto"``. The server accepts such a punch only inside
     the branch geofence and refuses a mock location, and it does NOT store the coordinates (AttendanceLog has no
     location columns); a refused punch is not stored at all.
  2. On-duty punches: ``OnDutyPunchVerification`` (latitude / longitude / accuracy_m / is_mocked / selfie, HR status).
     An approved one is copied into ``AttendanceLog`` as ``source="on_duty:approved"``; the verification row is listed,
     never that copy, so nothing is counted twice.
  3. Tracking, not punches: ``LiveLocationPing`` (72 h breadcrumbs) and the on-duty journey tables ``DutyTrack`` /
     ``DutyTrackPoint`` / ``DutyTrackSegment`` (geo_tracking). Only the journey summary (``DutyTrack.distance_m``,
     ``stop_count``, ``mock_points``) is shown, on the On-Duty with Punch Details report.
* Distance from the site = great-circle distance (geo_utils.haversine_distance_m) to the geofence centre of the
  employee's branch (Manage Branches; radius ``geofence_radius_m`` or the app's 200 m default), as the MD portal does.
* Day status / shift credit: the STORED ``AttendanceDayRecord`` (what payroll pays); never recomputed.

Employee rows are always loaded without ``photo_url`` / ``password_hash``.
"""

from __future__ import annotations

from collections import Counter, defaultdict
from datetime import date
from decimal import Decimal

from django.db.models import Count, Max, Min, Q

from api import cl_balance

from .. import filters as F
from ..filters import ReportParamError
from ..formatting import display_date, fmt_dt, r2
from ..registry import register
from ..runner import KIND_SUBTOTAL
from ..types import (
    BADGE,
    DATE,
    DATETIME,
    INTEGER,
    NUMBER,
    TEXT,
    TIME,
    ColumnSpec,
    FilterSpec,
    ReportResult,
    ReportSection,
    ReportSpec,
    F_EMPLOYEE,
)
from . import requests_leave_common as C
from . import requests_permission_duty_onduty as OD
from . import requests_permission_duty_permissions as P
from . import requests_permission_duty_shared as S
from .attendance_analysis_common import ABSENT, HALF, LEAVE, STATUS_LABELS, Roster, classify_day, payroll_settings
from .employees_master_base import join_date_of
from .requests_leave import _day_type as leave_day_type
from .requests_leave import _pay_impact as leave_pay_impact

CATEGORY = "attendance"
# Never pull these through select_related("employee"): photo_url is a ~43 KB base64 image, password_hash a secret.
NO_PHOTO = ("employee__photo_url", "employee__password_hash")
EMP_RELATED = ("employee__department", "employee__designation", "employee__branch")
STATUS_OPTIONS = (("pending", "Pending"), ("approved", "Approved"), ("rejected", "Rejected"))
VOID_PREFIX = "Voided automatically"  # geo_attendance_views._void_session_punches
CL_LABEL = "Casual Leave (CL)"


def _cl_cut_over() -> date:
    """PayrollSettings.cl_balance_since without cl_balance.since()'s get_or_create (a report never writes)."""
    from api.models.payroll import CL_BALANCE_DEFAULT_SINCE

    value = getattr(payroll_settings(), "cl_balance_since", None)
    if isinstance(value, str):
        value = date.fromisoformat(value[:10])
    return value or CL_BALANCE_DEFAULT_SINCE


def new_rule_birthdays(candidates) -> set[tuple[int, date]]:
    """cl_balance.new_rule_birthdays, read-only: that function reads CompensationConfig through its get_or_create, which
    would INSERT the settings row on an install that never saved the Compensation tab. There the birthday rule is off
    (birthday_enabled defaults to False), so the answer without the row is "no birthday" -- the same, without the write.
    No query at all unless a date of birth matches a candidate date."""
    from api.compensation_rules import is_birthday
    from api.models import CompensationConfig

    matched = [
        (emp_id, dob, kind, d)
        for emp_id, dob, kind, d in candidates
        if kind == "staff" and dob is not None and is_birthday(dob, d)
    ]
    if not matched or not CompensationConfig.objects.filter(pk=1).exists():
        return set()
    return cl_balance.new_rule_birthdays(matched)


def _num(value) -> float | None:
    return None if value is None else round(float(value), 2)


def _days_text(value) -> str:
    return str(cl_balance.number(Decimal(str(value))))


# ══════════════════════════════════════════════════════════════════════════════
#  Leave Report
# ══════════════════════════════════════════════════════════════════════════════

KIND_LEAVE, KIND_CL = "Leave", "Casual Leave"
LEAVE_KIND_OPTIONS = (("leave", "Leave requests"), ("casual", "Casual Leave"))


def cl_balance_effect(status: str, source: str, assigned: bool, birthday: bool, d: date, cut_over: date) -> str | None:
    """What a Casual Leave did to the yearly balance (cl_balance.Part.counts, worded for a badge)."""
    if status == "rejected":
        return "Not used (rejected)"
    if status not in ("approved", "pending"):
        return None
    if birthday:
        return "Not used (birthday leave)"
    if not (assigned or d >= cut_over):
        return "Before cut-over (old rule)"
    held = "Used" if status == "approved" else "Held (pending)"
    if source == "hr_assign":
        return f"{held} - HR Carry Forward"
    if source == "hr_edit":
        return f"{held} - HR attendance edit"
    return held


def cl_pay_effect(status: str, portion: str, birthday: bool) -> str | None:
    if status == "approved":
        if birthday:
            return "Paid birthday leave"
        return "Paid (Casual Leave)" if portion == cl_balance.FULL else "Half day paid (Casual Leave)"
    if status == "pending":
        return "Awaiting decision"
    if status == "rejected":
        return "Not paid as Casual Leave"
    return None


_LEAVE_REPORT_COLUMNS = (
    *C.emp_columns(name=1.5, dept=1.4),
    ColumnSpec("kind", "Kind", BADGE, 1.05),
    ColumnSpec("leaveType", "Leave type", TEXT, 1.3),
    ColumnSpec("startDate", "From", DATE, 1.3),
    ColumnSpec("endDate", "To", DATE, 1.3),
    ColumnSpec("dayType", "Day type", BADGE, 1.25),
    ColumnSpec("days", "Days", NUMBER, 0.6, total="sum"),
    ColumnSpec("daysInPeriod", "Days in period", NUMBER, 0.85, total="sum"),
    ColumnSpec("status", "Status", BADGE, 0.95),
    ColumnSpec("appliedOn", "Applied on", DATETIME, 1.35),
    ColumnSpec("decidedBy", "Decided by", TEXT, 1.3),
    ColumnSpec("reason", "Reason", TEXT, 1.4),
    ColumnSpec("clBalance", "CL balance", BADGE, 1.35),
    ColumnSpec("payEffect", "Pay effect", BADGE, 1.35),
)

_BY_TYPE_COLUMNS = (
    ColumnSpec("leaveType", "Leave type", TEXT, 2.2),
    ColumnSpec("kind", "Kind", BADGE, 1.1),
    ColumnSpec("requests", "Requests", INTEGER, 0.9, total="sum"),
    ColumnSpec("approvedDays", "Approved days", NUMBER, 1.0, total="sum"),
    ColumnSpec("pendingDays", "Pending days", NUMBER, 1.0, total="sum"),
    ColumnSpec("rejectedDays", "Rejected days", NUMBER, 1.0, total="sum"),
    ColumnSpec("employees", "Employees", INTEGER, 0.9),
)


def _leave_entries(ctx, d_from: date, d_to: date, status: str | None) -> tuple[list[dict], list[int]]:
    """One entry per LeaveRequest overlapping the range: the row plus the facts the summary needs."""
    from api.models import LeaveRequest

    catalog = C.LeaveTypeCatalog()
    qs = (
        LeaveRequest.objects.select_related(*EMP_RELATED)
        .defer(*NO_PHOTO)
        .filter(ctx.emp_q("employee__"))
        .filter(C.leave_overlap_q(d_from, d_to))
    )
    if status:
        qs = qs.filter(status=status)
    out: list[dict] = []
    unreadable: list[int] = []
    for lr in qs.order_by("id"):
        rng = C.parse_leave_range(lr)
        if rng is None:
            unreadable.append(lr.id)
            continue
        start, end = rng
        if start > d_to or end < d_from:
            continue
        info = catalog.resolve(lr)
        dates = C.leave_dates(lr, start, end, d_from, d_to)
        emp = lr.employee
        st = C.status_key(lr.status)
        out.append(
            {
                "_emp": lr.employee_id,
                "_status": st,
                "_type": info.label,
                "_kind": KIND_LEAVE,
                "_item": (lr.employee_id, dates, lr.is_half_day, lr.half_day_slot),
                "_cl_used": Decimal("0"),
                "_sort": (emp.employee_code or "", start, 0, lr.id),
                "row": {
                    **S.base_cells(emp),
                    "kind": KIND_LEAVE,
                    "leaveType": info.label,
                    "startDate": start.isoformat(),
                    "endDate": end.isoformat(),
                    "dayType": leave_day_type(lr),
                    "days": _num(lr.total_days),
                    "daysInPeriod": 0.5 * len(dates) if lr.is_half_day else float(len(dates)),
                    "status": C.status_label(lr.status),
                    "appliedOn": fmt_dt(lr.created_at),
                    "decidedBy": S.who_and_role(lr.approved_by, lr.approver_role) if st != "pending" else None,
                    "reason": C.clip(lr.reason, 160),
                    "clBalance": None,
                    "payEffect": leave_pay_impact(emp, lr),
                },
            }
        )
    return out, unreadable


def _cl_entries(ctx, d_from: date, d_to: date, status: str | None, cut_over: date) -> list[dict]:
    """One entry per CasualLeaveRequest dated in the range, with its cl_balance reading."""
    from api.models import CasualLeaveRequest

    qs = (
        CasualLeaveRequest.objects.select_related(*EMP_RELATED)
        .defer(*NO_PHOTO)
        .filter(ctx.emp_q("employee__"), date__range=(d_from, d_to))
    )
    if status:
        qs = qs.filter(status=status)
    items = list(qs.order_by("date", "id"))
    birthdays = new_rule_birthdays(
        (r.employee_id, r.employee.date_of_birth, r.employee.employment_type, r.date)
        for r in items
        if r.status in ("approved", "pending")
    )
    out: list[dict] = []
    for r in items:
        emp = r.employee
        st = C.status_key(r.status)
        portion = cl_balance.portion_of(r.portion)
        days = cl_balance.PORTION_DAYS[portion]
        source = cl_balance.source_of(r)
        assigned = cl_balance.is_assigned_cl(r)
        birthday = (r.employee_id, r.date) in birthdays
        counted = st in ("approved", "pending") and not birthday and (assigned or r.date >= cut_over)
        out.append(
            {
                "_emp": r.employee_id,
                "_status": st,
                "_type": CL_LABEL,
                "_kind": KIND_CL,
                "_item": (r.employee_id, [r.date], portion != cl_balance.FULL, portion),
                "_cl_used": days if (counted and st == "approved") else Decimal("0"),
                "_sort": (emp.employee_code or "", r.date, 1, r.id),
                "row": {
                    **S.base_cells(emp),
                    "kind": KIND_CL,
                    "leaveType": CL_LABEL,
                    "startDate": r.date.isoformat(),
                    "endDate": r.date.isoformat(),
                    "dayType": cl_balance.PORTION_LABEL[portion],
                    "days": float(days),
                    "daysInPeriod": float(days),
                    "status": C.status_label(r.status),
                    "appliedOn": fmt_dt(r.created_at),
                    "decidedBy": S.who_and_role(r.reviewed_by, r.reviewer_role) if st != "pending" else None,
                    "reason": C.clip(r.reason, 160),
                    "clBalance": cl_balance_effect(st, source, assigned, birthday, r.date, cut_over),
                    "payEffect": cl_pay_effect(st, portion, birthday),
                },
            }
        )
    return out


def _leave_report_run(ctx) -> ReportResult:
    d_from, d_to = ctx.date_from, ctx.date_to
    kind, status = ctx.param("kind"), ctx.param("status")
    may_leave, may_cl = C.can_view(ctx, "leave"), C.can_view(ctx, "casual_leave")
    cut_over = _cl_cut_over()

    entries: list[dict] = []
    unreadable: list[int] = []
    if may_leave and kind in (None, "leave"):
        got, unreadable = _leave_entries(ctx, d_from, d_to, status)
        entries += got
    if may_cl and kind in (None, "casual"):
        entries += _cl_entries(ctx, d_from, d_to, status, cut_over)
    entries.sort(key=lambda e: e["_sort"])

    shown = S.shown(entries, ctx)  # the summary describes the rows the runner keeps
    by_status: dict[str, list] = defaultdict(list)
    for e in shown:
        by_status[e["_status"]].append(e["_item"])
    on_leave = {e["_emp"] for e in shown if e["_status"] == "approved"}
    cl_used = sum((e["_cl_used"] for e in shown), Decimal("0"))

    by_type: dict[tuple[str, str], dict] = {}
    for e in shown:
        slot = by_type.setdefault(
            (e["_kind"], e["_type"]), {"requests": 0, "items": defaultdict(list), "employees": set()}
        )
        slot["requests"] += 1
        slot["items"][e["_status"]].append(e["_item"])
        slot["employees"].add(e["_emp"])
    type_rows = [
        {
            "leaveType": label,
            "kind": k,
            "requests": v["requests"],
            "approvedDays": C.unique_leave_days(v["items"]["approved"]),
            "pendingDays": C.unique_leave_days(v["items"]["pending"]),
            "rejectedDays": C.unique_leave_days(v["items"]["rejected"]),
            "employees": len(v["employees"]),
        }
        for (k, label), v in sorted(by_type.items(), key=lambda kv: (kv[0][0] == KIND_CL, kv[0][1].lower()))
    ]

    notes = [
        "Lists every leave request and every Casual Leave that falls in the selected dates. For a leave request 'Days' "
        "is the figure stored on the request and 'Days in period' counts its Monday-Saturday dates inside the range "
        "(Sundays are not counted, holidays are not excluded); a half day counts 0.5. The summary counts an employee's "
        "overlapping requests once per day.",
        f"Casual Leave: one date per request, a full day = 1 and a half day (first or second half) = 0.5. From "
        f"{display_date(cut_over)} (the cut-over in Settings) every employee has {cl_balance.ENTITLEMENT} Casual Leave "
        "days a calendar year: approved days use the balance, pending days hold it, a rejected request frees it. Casual "
        "Leave HR gives on the Carry Forward tab uses the balance whatever its date; a Casual Leave on an unworked "
        "birthday under the new birthday rule is a paid birthday leave and uses no balance. Casual Leave dated before "
        "the cut-over followed the older one-per-month rule and is not charged to the yearly balance.",
        "Pay effect follows the attendance engine: a staff employee's approved full-day leave is unpaid (LOP) unless "
        "they punched that day; a production employee's leave has no attendance or payroll effect; an approved Casual "
        "Leave is a paid day (a half day pays half).",
        "A Casual Leave HR proposes on the Attendance Edit page appears here once both approvals make it a Casual "
        "Leave; while it waits it holds balance (see the Individual Employee Overall Leave Report).",
    ]
    if not may_leave:
        notes.append("Leave requests are not included: your role does not have access to the Leave module.")
    if not may_cl:
        notes.append("Casual Leave is not included: your role does not have access to the Casual Leave module.")
    if unreadable:
        notes.append(
            C.id_list_note(
                f"{len(unreadable)} leave request(s) with unreadable start / end dates could not be placed in the range "
                "and are not listed",
                unreadable,
            )
        )
    notes += S.cut_note(entries, ctx)
    return ReportResult(
        rows=[e["row"] for e in entries],
        summary=[
            {"label": "Requests", "value": len(shown), "format": "integer"},
            {"label": "Approved days", "value": C.unique_leave_days(by_status["approved"]), "format": "number"},
            {"label": "Pending days", "value": C.unique_leave_days(by_status["pending"]), "format": "number"},
            {"label": "Rejected days", "value": C.unique_leave_days(by_status["rejected"]), "format": "number"},
            {"label": "CL days used from balance", "value": float(cl_used), "format": "number"},
            {"label": "Employees on approved leave", "value": len(on_leave), "format": "integer"},
        ],
        notes=notes,
        sections=[
            ReportSection(
                title="By leave type",
                columns=_BY_TYPE_COLUMNS,
                rows=type_rows,
                totals={
                    "requests": sum(r["requests"] for r in type_rows),
                    "approvedDays": round(sum(r["approvedDays"] for r in type_rows), 2),
                    "pendingDays": round(sum(r["pendingDays"] for r in type_rows), 2),
                    "rejectedDays": round(sum(r["rejectedDays"] for r in type_rows), 2),
                }
                if type_rows
                else None,
                notes=[
                    "Days inside the selected range; overlapping requests of one employee are counted once per day."
                ],
                sheet="By leave type",
                empty="No leave in the selected dates.",
            )
        ],
    )


register(
    ReportSpec(
        id="leave-report",
        title="Leave Report",
        description="Every leave request and Casual Leave in the period: type, dates, days, status, approver, reason and CL balance effect.",
        category=CATEGORY,
        icon="CalendarOff",
        tags=("leave", "casual leave", "cl", "half day", "lop", "approval", "balance"),
        modules=("leave", "casual_leave"),
        filters=(
            F.date_range("thisMonth", "Leave falls within"),
            F.branches(),
            F.departments(),
            F.employment_type(),
            F.employees(),
            F.employee_status("all"),
            F.select("kind", "Leave kind", LEAVE_KIND_OPTIONS),
            F.select("status", "Status", STATUS_OPTIONS),
        ),
        columns=_LEAVE_REPORT_COLUMNS,
        run=_leave_report_run,
    )
)


# ══════════════════════════════════════════════════════════════════════════════
#  Individual Employee Overall Leave Report
# ══════════════════════════════════════════════════════════════════════════════

K_ATTENDANCE, K_PERMISSION, K_ON_DUTY, K_MISSING = "Attendance", "Permission", "On-duty", "Missing punch"
_KIND_ORDER = {KIND_LEAVE: 0, KIND_CL: 1, K_PERMISSION: 2, K_ON_DUTY: 3, K_MISSING: 4, K_ATTENDANCE: 5}
_ON_DUTY_STATE = {
    "pending_hod": "pending",
    "pending_hr": "pending",
    "active": "approved",
    "completed": "approved",
    "rejected": "rejected",
}
_MISSING_STATE = {"pending_hod": "pending", "pending_hr": "pending", "approved": "approved", "rejected": "rejected"}

_OVERALL_COLUMNS = (
    ColumnSpec("item", "Leave / request", TEXT, 2.1),
    ColumnSpec("kind", "Kind", BADGE, 1.1),
    ColumnSpec("fromDate", "From", DATE, 1.3),
    ColumnSpec("toDate", "To", DATE, 1.3),
    ColumnSpec("days", "Days", NUMBER, 0.65),
    ColumnSpec("status", "Status", BADGE, 0.95),
    ColumnSpec("taken", "Taken / approved", NUMBER, 1.05),
    ColumnSpec("pending", "Pending", NUMBER, 0.85),
    ColumnSpec("rejected", "Rejected", NUMBER, 0.85),
    ColumnSpec("balance", "Balance left", NUMBER, 0.9),
    ColumnSpec("decidedBy", "Decided by", TEXT, 1.4),
    ColumnSpec("details", "Details", TEXT, 3.4),
)


def _state_label(state: str) -> str:
    return {"approved": "Approved", "pending": "Pending", "rejected": "Rejected"}.get(state, "Other")


def _summary_row(item: str, kind: str, taken=None, pending=None, rejected=None, balance=None, details=None) -> dict:
    return {
        "item": item,
        "kind": kind,
        "taken": taken,
        "pending": pending,
        "rejected": rejected,
        "balance": balance,
        "details": details,
    }


def _plural(n, one: str, many: str | None = None) -> str:
    n_text = _days_text(n) if isinstance(n, (Decimal, float)) else str(n)
    word = one if n == 1 else (many or one + "s")
    return f"{n_text} {word}"


def _overall_leave(emp, y0: date, y1: date, rows: list, requests: list) -> tuple[Decimal, Decimal, list[int]]:
    """Leave requests of the year: one summary row per leave type, one request row each. Returns (approved days,
    pending days, unreadable ids)."""
    from api.models import LeaveRequest

    catalog = C.LeaveTypeCatalog()
    per_type: dict[str, dict] = {}
    unreadable: list[int] = []
    for lr in LeaveRequest.objects.filter(employee_id=emp.id).filter(C.leave_overlap_q(y0, y1)).order_by("id"):
        rng = C.parse_leave_range(lr)
        if rng is None:
            unreadable.append(lr.id)
            continue
        start, end = rng
        if start > y1 or end < y0:
            continue
        info = catalog.resolve(lr)
        label = f"{info.label} ({info.code})" if info.code else info.label
        st = C.status_key(lr.status)
        dates = C.leave_dates(lr, start, end, y0, y1)
        slot = per_type.setdefault(label, {"requests": 0, "items": defaultdict(list), "half": 0})
        slot["requests"] += 1
        slot["items"][st].append((emp.id, dates, lr.is_half_day, lr.half_day_slot))
        slot["half"] += 1 if lr.is_half_day else 0
        applied = C.ist_date(lr.created_at)
        bits = [leave_day_type(lr)]
        if applied:
            bits.append(f"applied {display_date(applied)}")
        if lr.reason:
            bits.append(C.clip(lr.reason, 120))
        if (lr.hr_comment or "").strip():
            bits.append(f"comment: {C.clip(lr.hr_comment, 80)}")
        requests.append(
            {
                "_sort": (start, lr.created_at, _KIND_ORDER[KIND_LEAVE], lr.id),
                "item": label,
                "kind": KIND_LEAVE,
                "fromDate": start.isoformat(),
                "toDate": end.isoformat(),
                "days": _num(lr.total_days),
                "status": C.status_label(lr.status),
                "decidedBy": S.who_and_role(lr.approved_by, lr.approver_role) if st != "pending" else None,
                "details": "; ".join(b for b in bits if b),
            }
        )
    approved = pending = Decimal("0")
    for label in sorted(per_type, key=str.lower):
        v = per_type[label]
        a = C.unique_leave_days(v["items"]["approved"])
        p = C.unique_leave_days(v["items"]["pending"])
        approved += Decimal(str(a))
        pending += Decimal(str(p))
        details = [_plural(v["requests"], "request")]
        if v["half"]:
            details.append(_plural(v["half"], "half day"))
        rows.append(
            _summary_row(
                label,
                KIND_LEAVE,
                a,
                p,
                C.unique_leave_days(v["items"]["rejected"]),
                details=", ".join(details),
            )
        )
    return approved, pending, unreadable


def _overall_cl(emp, year: int, y0: date, y1: date, cut_over: date, rows: list, requests: list) -> tuple:
    """Casual Leave of the year with the cl_balance reading. Returns (approved days, pending days, balance block)."""
    from api.models import CasualLeaveRequest

    held = cl_balance.parts([emp.id], y0, y1)[emp.id]
    bal = cl_balance.balance_json(held, year, cut_over)
    by_request = {p.request_id: p for p in held if p.kind == "casual_leave"}
    proposals = [p for p in held if p.kind == "attendance_correction"]
    cls = list(CasualLeaveRequest.objects.filter(employee_id=emp.id, date__range=(y0, y1)).order_by("date", "id"))
    if emp.employment_type != "staff" and not cls and not proposals:
        return Decimal("0"), Decimal("0"), None

    totals = {"approved": Decimal("0"), "pending": Decimal("0"), "rejected": Decimal("0")}
    assigned_days = half_count = before_days = birthday_days = Decimal("0")
    for r in cls:
        st = C.status_key(r.status)
        portion = cl_balance.portion_of(r.portion)
        days = cl_balance.PORTION_DAYS[portion]
        part = by_request.get(r.id)
        birthday = bool(part and part.birthday)
        assigned = cl_balance.is_assigned_cl(r)
        if st in totals:
            totals[st] += days
        if st in ("approved", "pending"):
            if birthday:
                birthday_days += days
            elif assigned:
                assigned_days += days
            elif r.date < cut_over:
                before_days += days
        if portion != cl_balance.FULL:
            half_count += 1
        effect = cl_balance_effect(st, cl_balance.source_of(r), assigned, birthday, r.date, cut_over)
        bits = [cl_balance.PORTION_LABEL[portion]]
        if effect:
            bits.append(f"balance: {effect}")
        applied = C.ist_date(r.created_at)
        if applied:
            bits.append(f"applied {display_date(applied)}")
        if r.reason:
            bits.append(C.clip(r.reason, 120))
        requests.append(
            {
                "_sort": (r.date, r.created_at, _KIND_ORDER[KIND_CL], r.id),
                "item": CL_LABEL,
                "kind": KIND_CL,
                "fromDate": r.date.isoformat(),
                "toDate": r.date.isoformat(),
                "days": float(days),
                "status": C.status_label(r.status),
                "decidedBy": S.who_and_role(r.reviewed_by, r.reviewer_role) if st != "pending" else None,
                "details": "; ".join(bits),
            }
        )
    for p in proposals:
        totals["pending"] += p.days
        requests.append(
            {
                "_sort": (p.date, p.created_at, _KIND_ORDER[KIND_CL], p.request_id),
                "item": f"{CL_LABEL} proposed by HR",
                "kind": KIND_CL,
                "fromDate": p.date.isoformat(),
                "toDate": p.date.isoformat(),
                "days": float(p.days),
                "status": "Pending",
                "decidedBy": None,
                "details": f"{cl_balance.PORTION_LABEL[p.portion]}; Attendance Edit proposal waiting for approval "
                "(holds balance)",
            }
        )

    if bal["tracked"]:
        head = (
            f"{cl_balance.ENTITLEMENT} days a year from {display_date(bal['since'])}: used {bal['used']}, "
            f"pending {bal['pending']}, left {bal['remaining']}"
        )
    else:
        head = (
            f"No yearly balance for {year}: the {cl_balance.ENTITLEMENT}-day balance starts on {display_date(cut_over)}"
        )
    extra = []
    if assigned_days:
        extra.append(f"{_days_text(assigned_days)} given by HR on the Carry Forward tab")
    if half_count:
        extra.append(_plural(int(half_count), "half day"))
    if before_days:
        extra.append(f"{_days_text(before_days)} before the cut-over (old one-per-month rule, not charged)")
    if birthday_days:
        extra.append(f"{_days_text(birthday_days)} on a birthday (paid birthday leave, no balance used)")
    if emp.employment_type != "staff":
        extra.append("Casual Leave is for staff")
    rows.append(
        _summary_row(
            CL_LABEL,
            KIND_CL,
            float(totals["approved"]),
            float(totals["pending"]),
            float(totals["rejected"]),
            balance=float(bal["remaining"]) if bal["tracked"] else None,
            details="; ".join([head, *extra]),
        )
    )
    return totals["approved"], totals["pending"], bal


def _overall_permissions(emp, y0: date, y1: date, rows: list, requests: list) -> None:
    from api.attendance_final import bulk_permission_cap_status
    from api.models import EmployeePermission

    perms = list(EmployeePermission.objects.filter(employee_id=emp.id, date__range=(y0, y1)).order_by("date", "id"))
    cap = S.permission_cap(payroll_settings())
    cap_state = bulk_permission_cap_status(perms, cap)
    counts: Counter = Counter()
    types: Counter = Counter()
    for p in perms:
        st = C.status_key(p.status)
        counts[st] += 1
        slug = P.permission_type(p)
        if st == "approved":
            types[slug] += 1
            if cap_state.get(p.id) == "excess":
                counts["excess"] += 1
        bits = [P.type_label(slug)]
        if p.permission_time:
            bits.append(f"at {p.permission_time.strftime('%H:%M')}")
        bits.append(f"{P._minutes(p)} min")
        if st == "approved":
            bits.append("beyond the monthly cap" if cap_state.get(p.id) == "excess" else "within the monthly cap")
        if p.reason:
            bits.append(C.clip(p.reason, 100))
        requests.append(
            {
                "_sort": (p.date, p.created_at, _KIND_ORDER[K_PERMISSION], p.id),
                "item": "Permission",
                "kind": K_PERMISSION,
                "fromDate": p.date.isoformat(),
                "toDate": None,
                "days": None,
                "status": C.status_label(p.status),
                "decidedBy": S.who_and_role(p.approved_by, p.approver_role) if st != "pending" else None,
                "details": ", ".join(bits),
            }
        )
    by_type = ", ".join(f"{P.type_label(slug)} {n}" for slug, n in sorted(types.items()))
    details = [f"Counted in requests; {cap} a month are within the cap"]
    if by_type:
        details.append(f"approved: {by_type}")
    if counts["excess"]:
        details.append(f"{counts['excess']} beyond the monthly cap")
    rows.append(
        _summary_row(
            "Permissions (requests)",
            K_PERMISSION,
            counts["approved"],
            counts["pending"],
            counts["rejected"],
            details="; ".join(details),
        )
    )


def _overall_on_duty(emp, y0: date, y1: date, rows: list, requests: list) -> int:
    from api.models import OnDutySession

    start, end = S.ist_bounds(y0, y1)
    days: dict[str, set] = defaultdict(set)
    n = 0
    for s in OnDutySession.objects.filter(employee_id=emp.id, created_at__gte=start, created_at__lt=end).order_by(
        "created_at", "id"
    ):
        n += 1
        state = _ON_DUTY_STATE.get(s.status, "other")
        day = S.ist_date(s.created_at)
        days[state].add(day)
        bits = [f"to {C.clip(s.destination, 60)}" if s.destination else None, OD.decision_path(s)]
        completion = OD.completion_text(s)
        if completion:
            bits.append(completion)
        requests.append(
            {
                "_sort": (day, s.created_at, _KIND_ORDER[K_ON_DUTY], s.id),
                "item": "On-duty",
                "kind": K_ON_DUTY,
                "fromDate": day.isoformat(),
                "toDate": None,
                "days": None,
                "status": _state_label(state),
                "decidedBy": s.hr_reviewed_by or s.hod_reviewed_by or None,
                "details": "; ".join(b for b in bits if b),
            }
        )
    rows.append(
        _summary_row(
            "On-duty days",
            K_ON_DUTY,
            len(days["approved"]),
            len(days["pending"]),
            len(days["rejected"]),
            details=f"{_plural(n, 'request')}; a day counts once HR approved the request (Active or Completed)",
        )
    )
    return len(days["approved"])


def _overall_missing(emp, y0: date, y1: date, rows: list, requests: list) -> None:
    from api.models import MissingPunchRequest

    counts: Counter = Counter()
    slots = dict(MissingPunchRequest.PUNCH_SLOT_CHOICES)
    for m in MissingPunchRequest.objects.filter(employee_id=emp.id, date__range=(y0, y1)).order_by("date", "id"):
        state = _MISSING_STATE.get(m.status, "other")
        counts[state] += 1
        what = slots.get(m.punch_slot or "", None) or ("In punch" if m.punch_type == "IN" else "Out punch")
        bits = [f"{what} at {m.punch_time.strftime('%H:%M')}"]
        if m.reason:
            bits.append(C.clip(m.reason, 100))
        requests.append(
            {
                "_sort": (m.date, m.created_at, _KIND_ORDER[K_MISSING], m.id),
                "item": "Missing punch",
                "kind": K_MISSING,
                "fromDate": m.date.isoformat(),
                "toDate": None,
                "days": None,
                "status": _state_label(state),
                "decidedBy": m.hr_reviewed_by or m.hod_reviewed_by or None,
                "details": "; ".join(bits),
            }
        )
    rows.append(
        _summary_row(
            "Missing punch requests",
            K_MISSING,
            counts["approved"],
            counts["pending"],
            counts["rejected"],
            details="Counted in requests; an approved request adds the punch to that day",
        )
    )


def _overall_attendance(ctx, emp, y0: date, y1: date, rows: list) -> int:
    """Absent / on-leave / half days from the STORED day records (classify_day: Saturday-off Saturdays, days outside
    employment and today are not absences)."""
    from api.models import AttendanceDayRecord

    roster = Roster(ctx, y0, y1)
    roster._join[emp.id] = join_date_of(emp)[0]  # TEXT join date: an unreadable one never masks the whole year
    tally: Counter = Counter()
    for rec in AttendanceDayRecord.objects.filter(employee_id=emp.id, date__range=(y0, y1)).only(
        "id", "date", "status"
    ):
        tally[classify_day(rec, emp, roster, ctx.today, production_sunday_off=True)] += 1
    prod = emp.employment_type == "production"
    off_rule = "Sundays" if prod else "Saturday-off Saturdays"
    rows.append(
        _summary_row(
            "Absent days",
            K_ATTENDANCE,
            tally[ABSENT],
            details=f"Stored attendance: days marked Absent before today ({off_rule}, holidays and days outside "
            "employment are not counted)",
        )
    )
    rows.append(
        _summary_row(
            "On leave days (attendance)",
            K_ATTENDANCE,
            tally[LEAVE],
            details="Stored attendance: days the attendance engine marked On leave",
        )
    )
    rows.append(
        _summary_row(
            "Half days (attendance)",
            K_ATTENDANCE,
            tally[HALF],
            details="Stored attendance: half-shift days (a half-day leave or half a day worked)",
        )
    )
    return tally[ABSENT]


def _overall_run(ctx) -> ReportResult:
    ids = ctx.params.get("employee_ids") or []
    if len(ids) > 1:
        raise ReportParamError("Choose one employee: this report covers one person at a time.", "employeeIds")
    yr = ctx.year
    if not ids:
        return ReportResult(
            rows=[],
            notes=[
                "Choose an employee to see their leave, Casual Leave balance, permissions, on-duty days, missing "
                f"punch requests and absent days for {yr}."
            ],
        )
    emp = ctx.employees().first()  # branch isolation + department filter already applied
    if emp is None:
        return ReportResult(rows=[], notes=["No employee matches the filters (check the branch and department)."])

    y0, y1 = date(yr, 1, 1), date(yr, 12, 31)
    summary_rows: list[dict] = []
    requests: list[dict] = []
    notes: list[str] = []
    leave_taken = leave_pending = Decimal("0")
    bal = None
    if C.can_view(ctx, "leave"):
        a, p, unreadable = _overall_leave(emp, y0, y1, summary_rows, requests)
        leave_taken += a
        leave_pending += p
        if unreadable:
            notes.append(
                C.id_list_note(f"{len(unreadable)} leave request(s) with unreadable dates are left out", unreadable)
            )
        if not any(r["kind"] == KIND_LEAVE for r in summary_rows):
            summary_rows.append(_summary_row("Leave requests", KIND_LEAVE, 0, 0, 0, details="No leave requests"))
    else:
        notes.append(
            "Leave requests and permissions are not included: your role does not have access to the Leave module."
        )
    if C.can_view(ctx, "casual_leave"):
        cut_over = _cl_cut_over()
        a, p, bal = _overall_cl(emp, yr, y0, y1, cut_over, summary_rows, requests)
        leave_taken += a
        leave_pending += p
    else:
        notes.append("Casual Leave is not included: your role does not have access to the Casual Leave module.")
    if C.can_view(ctx, "leave"):
        _overall_permissions(emp, y0, y1, summary_rows, requests)
    on_duty_days = None
    if C.can_view(ctx, "geo_attendance"):
        on_duty_days = _overall_on_duty(emp, y0, y1, summary_rows, requests)
    else:
        notes.append("On-duty is not included: your role does not have access to Geo Attendance.")
    if C.can_view(ctx, "missing_punch") or C.can_view(ctx, "attendance"):
        _overall_missing(emp, y0, y1, summary_rows, requests)
    absent = None
    if C.can_view(ctx, "attendance"):
        absent = _overall_attendance(ctx, emp, y0, y1, summary_rows)
    else:
        notes.append("Attendance days are not included: your role does not have access to Attendance.")

    requests.sort(key=lambda r: r.pop("_sort"))
    who = f"{emp.employee_code} {(emp.first_name or '').strip()} {(emp.last_name or '').strip()}".strip()
    dept = emp.department.name if emp.department_id else "Unassigned"
    rows = [
        {"item": f"Summary for {yr}: {who} ({dept})", "_kind": KIND_SUBTOTAL},
        *summary_rows,
        {"item": f"Every request in date order ({len(requests)})", "_kind": KIND_SUBTOTAL},
        *requests,
    ]
    notes[:0] = [
        "The first part sums the year per leave type and request kind (Taken / approved, Pending and Rejected are days "
        "for leave and Casual Leave and on-duty, and request counts for permissions and missing punches); the second "
        "part lists every request in date order.",
        "Leave days count the request's Monday-Saturday dates inside the year (a half day = 0.5). Casual Leave follows "
        f"the yearly balance: {cl_balance.ENTITLEMENT} days a calendar year from the cut-over, a half day = 0.5, "
        "pending holds days, rejected frees them, Carry Forward days given by HR count whatever their date, and a "
        "Casual Leave on an unworked new-rule birthday uses none.",
        "On-duty days are the IST dates of the requests. Absent / on leave / half days come from the stored attendance "
        "records (what payroll pays from)"
        + (", by shift day for production." if emp.employment_type == "production" else "."),
    ]
    return ReportResult(
        rows=rows,
        summary=[
            {"label": "Employee", "value": who, "format": "text"},
            {"label": "Leave days taken", "value": float(leave_taken), "format": "number"},
            {"label": "Pending days", "value": float(leave_pending), "format": "number"},
            {
                "label": "Casual Leave left",
                "value": float(bal["remaining"]) if bal and bal["tracked"] else None,
                "format": "number",
            },
            {"label": "On-duty days", "value": on_duty_days, "format": "integer"},
            {"label": "Absent days", "value": absent, "format": "integer"},
        ],
        notes=notes,
    )


register(
    ReportSpec(
        id="employee-overall-leave",
        title="Individual Employee Overall Leave Report",
        description="One employee's year: leave by type, Casual Leave balance, permissions, on-duty, missing punches and absent days.",
        category=CATEGORY,
        icon="UserRound",
        tags=("leave", "casual leave", "cl balance", "employee", "permission", "on duty", "missing punch", "absent"),
        modules=("leave", "casual_leave"),
        filters=(
            F.year(),
            F.branches(),
            F.departments(),
            FilterSpec(
                "employee",
                F_EMPLOYEE,
                "Employee",
                multi=True,
                required=True,
                placeholder="Choose one employee",
                help="This report covers one employee at a time.",
            ),
        ),
        columns=_OVERALL_COLUMNS,
        run=_overall_run,
        pdf_max_rows=2000,
    )
)


# ══════════════════════════════════════════════════════════════════════════════
#  Geo Attendance Report
# ══════════════════════════════════════════════════════════════════════════════

SRC_OFFICE, SRC_ON_DUTY = "Office geo punch", "On-duty punch"
GEO_SOURCE_OPTIONS = (("office", SRC_OFFICE), ("on_duty", SRC_ON_DUTY))
GEO_CHECK_OPTIONS = (
    ("accepted", "Accepted (office punch inside the fence)"),
    ("pending", "Pending HR"),
    ("approved", "Approved by HR"),
    ("rejected", "Rejected by HR"),
    ("voided", "Voided (request rejected)"),
    ("mocked", "Mock GPS"),
    ("outside", "Outside the site fence"),
)

_GEO_COLUMNS = (
    *S.LEAD_COLS,
    ColumnSpec("site", "Site", TEXT, 1.1),
    ColumnSpec("punchDate", "Date", DATE, 1.3),
    ColumnSpec("punchTime", "Time", TIME, 0.7),
    ColumnSpec("source", "Punched by", BADGE, 1.3),
    ColumnSpec("punchType", "In/Out", BADGE, 0.65),
    ColumnSpec("location", "Location (lat, lng)", TEXT, 1.9),
    ColumnSpec("accuracyM", "Accuracy (m)", NUMBER, 0.9),
    ColumnSpec("distanceM", "From site (m)", INTEGER, 0.95),
    ColumnSpec("fence", "Fence", BADGE, 1.0),
    ColumnSpec("gps", "GPS", BADGE, 0.8),
    ColumnSpec("verification", "Verification", BADGE, 1.05),
    ColumnSpec("destination", "Destination", TEXT, 1.6),
    ColumnSpec("reviewedBy", "Reviewed by", TEXT, 1.2),
)


def site_distance(emp, lat, lng) -> tuple[int | None, bool | None]:
    """(metres from the employee's branch geofence centre, inside its radius) -- (None, None) when the branch has no
    location (Manage Branches)."""
    from api.geo_attendance_views import DEFAULT_RADIUS_M
    from api.geo_utils import haversine_distance_m

    b = emp.branch if emp.branch_id else None
    if b is None or b.geofence_lat is None or b.geofence_lng is None or lat is None or lng is None:
        return None, None
    dist = haversine_distance_m(float(lat), float(lng), float(b.geofence_lat), float(b.geofence_lng))
    return int(round(dist)), dist <= (b.geofence_radius_m or DEFAULT_RADIUS_M)


def verification_state(status: str | None, comment: str | None) -> str:
    if status == "rejected":
        return "voided" if (comment or "").startswith(VOID_PREFIX) else "rejected"
    return status or "pending"


_VERIFY_LABEL = {
    "accepted": "Accepted",
    "pending": "Pending",
    "approved": "Approved",
    "rejected": "Rejected",
    "voided": "Voided",
}


def _geo_run(ctx) -> ReportResult:
    from api.models import AttendanceLog, OnDutyPunchVerification

    d_from, d_to = ctx.date_from, ctx.date_to
    source, check = ctx.param("source"), ctx.param("check")
    entries: list[tuple] = []  # (sort key, row, facts)

    if source in (None, "on_duty") and check != "accepted":
        qs = OnDutyPunchVerification.objects.filter(
            ctx.emp_q("employee__"), punch_date__gte=d_from, punch_date__lte=d_to
        )
        if check in ("pending", "approved"):
            qs = qs.filter(status=check)
        elif check == "rejected":
            qs = qs.filter(status="rejected").exclude(hr_review_comment__startswith=VOID_PREFIX)
        elif check == "voided":
            qs = qs.filter(status="rejected", hr_review_comment__startswith=VOID_PREFIX)
        elif check == "mocked":
            qs = qs.filter(is_mocked=True)
        qs = qs.select_related(*EMP_RELATED, "session").defer(*NO_PHOTO).order_by("punch_date", "punch_time", "id")
        if check != "outside":  # 'outside' is measured here, so it cannot be cut in SQL
            qs = qs[: ctx.row_limit]
        for v in qs:
            emp = v.employee
            dist, inside = site_distance(emp, v.latitude, v.longitude)
            if check == "outside" and inside is not False:
                continue
            state = verification_state(v.status, v.hr_review_comment)
            entries.append(
                (
                    (v.punch_date, v.punch_time, emp.employee_code or "", 1, v.id),
                    {
                        **S.base_cells(emp),
                        "site": S.branch_name(emp),
                        "punchDate": v.punch_date.isoformat(),
                        "punchTime": S.tstr(v.punch_time),
                        "source": SRC_ON_DUTY,
                        "punchType": v.punch_type,
                        "location": f"{v.latitude:.6f}, {v.longitude:.6f}",
                        "accuracyM": r2(v.accuracy_m),
                        "distanceM": dist,
                        "fence": "No site location" if inside is None else ("Inside" if inside else "Outside"),
                        "gps": "Mocked" if v.is_mocked else "Genuine",
                        "verification": _VERIFY_LABEL.get(state, state.title()),
                        "destination": v.session.destination if v.session_id else None,
                        "reviewedBy": v.hr_reviewed_by,
                    },
                    {"src": "on_duty", "state": state, "mocked": v.is_mocked, "outside": inside is False},
                )
            )

    if source in (None, "office") and check in (None, "accepted"):
        logs = (
            AttendanceLog.objects.filter(ctx.emp_q("employee__"), source="geo:auto", date__gte=d_from, date__lte=d_to)
            .select_related(*EMP_RELATED)
            .defer(*NO_PHOTO)
            .order_by("date", "punch_time", "id")[: ctx.row_limit]
        )
        for log in logs:
            emp = log.employee
            entries.append(
                (
                    (log.date, log.punch_time, emp.employee_code or "", 0, log.id),
                    {
                        **S.base_cells(emp),
                        "site": S.branch_name(emp),
                        "punchDate": log.date.isoformat(),
                        "punchTime": S.tstr(log.punch_time),
                        "source": SRC_OFFICE,
                        "punchType": log.punch_type,
                        "location": None,  # never stored for an office geo punch
                        "accuracyM": None,
                        "distanceM": None,
                        "fence": "Inside",  # the server records an office geo punch only inside the fence
                        "gps": "Genuine",  # a mock location is refused, never recorded
                        "verification": "Accepted",
                        "destination": None,
                        "reviewedBy": None,
                    },
                    {"src": "office", "state": "accepted", "mocked": False, "outside": False},
                )
            )

    entries.sort(key=lambda e: e[0])
    entries = entries[: ctx.row_limit]
    shown = S.shown(entries, ctx)
    facts = [e[2] for e in shown]
    states = Counter(f["state"] for f in facts)
    return ReportResult(
        rows=[e[1] for e in entries],
        summary=[
            {"label": "Geo punches", "value": len(facts), "format": "integer"},
            {"label": "Office geo punches", "value": sum(f["src"] == "office" for f in facts), "format": "integer"},
            {"label": "On-duty punches", "value": sum(f["src"] == "on_duty" for f in facts), "format": "integer"},
            {"label": "Waiting for HR", "value": states["pending"], "format": "integer"},
            {"label": "Rejected or voided", "value": states["rejected"] + states["voided"], "format": "integer"},
            {"label": "Mock GPS", "value": sum(bool(f["mocked"]) for f in facts), "format": "integer"},
        ],
        notes=[
            "Office geo punch = a punch from the mobile app inside the branch geofence (stored as attendance source "
            "'geo:auto'). The server records it only inside the fence and refuses a mock location, and it does not store "
            "the coordinates, so Location, Accuracy and From site stay blank for it; a refused punch is not stored and "
            "cannot be listed.",
            "On-duty punch = a punch with selfie and GPS made under an On-Duty request. It counts as attendance only "
            "once HR approves it; Voided = rejected automatically because the On-Duty request itself was rejected.",
            "From site = straight-line distance to the geofence centre of the employee's branch (Manage Branches); "
            "Inside / Outside compares it with the branch radius (200 m when none is set). On-duty work is away from the "
            "site by design, so Outside is a lens, not a fault. Accuracy is the phone's GPS error radius.",
            "Dates and times are as captured (IST calendar date). Selfies are not exported; live location pings and "
            "journey tracks are not punches (journey distance is on the On-Duty with Punch Details report).",
            *S.cut_note(entries, ctx),
        ],
    )


register(
    ReportSpec(
        id="geo-attendance",
        title="Geo Attendance Report",
        description="Punches from the mobile app with location: time, coordinates, accuracy, distance from the site, mock GPS and verification.",
        category=CATEGORY,
        icon="MapPin",
        tags=("geo", "gps", "location", "geofence", "mobile punch", "on duty", "mock location"),
        modules=("geo_attendance",),
        filters=(
            F.date_range("thisMonth", "Punch date"),
            F.branches(),
            F.departments(),
            F.employment_type(),
            F.employees(),
            F.employee_status("all"),
            F.select("source", "Punched by", GEO_SOURCE_OPTIONS),
            F.select("check", "Verification", GEO_CHECK_OPTIONS),
        ),
        columns=_GEO_COLUMNS,
        run=_geo_run,
    )
)


# ══════════════════════════════════════════════════════════════════════════════
#  On-Duty Report (the retired on-duty-register, re-listed under Attendance)
# ══════════════════════════════════════════════════════════════════════════════


def _on_duty_report_run(ctx) -> ReportResult:
    """on-duty-register's run (requests_permission_duty_onduty._register_run) with the employee rows loaded without
    photo_url / password_hash; same rows, same columns, same notes."""
    from api.models import OnDutyPunchVerification, OutpassRequest

    sessions = list(
        OD._sessions_base(ctx)
        .select_related(*EMP_RELATED, "branch")
        .defer(*NO_PHOTO)
        .order_by("created_at", "id")[: ctx.row_limit]
    )
    ids = [s.id for s in sessions]
    live = ~Q(status="rejected")
    stats = {
        r["session_id"]: r
        for r in OnDutyPunchVerification.objects.filter(session_id__in=ids)
        .order_by()
        .values("session_id")
        .annotate(
            total=Count("id"),
            approved=Count("id", filter=Q(status="approved")),
            pending=Count("id", filter=Q(status="pending")),
            rejected=Count("id", filter=Q(status="rejected")),
            mocked=Count("id", filter=Q(is_mocked=True)),
            first=Min("punch_time", filter=live),
            last=Max("punch_time", filter=live),
        )
    }
    with_outpass = set(
        OutpassRequest.objects.filter(on_duty_session_id__in=ids, source="on_duty").values_list(
            "on_duty_session_id", flat=True
        )
    )
    counted = {s.id for s in S.shown(sessions, ctx)}
    rows = []
    hours: list[float] = []
    punches = mocked_sessions = 0
    by_status: Counter = Counter()
    for s in sessions:
        st = stats.get(s.id) or {}
        h = S.hours_between(s.created_at, OD.decided_at(s))
        comments = "; ".join(
            f"{label}: {text}" for label, text in (("HOD", s.hod_review_comment), ("HR", s.hr_review_comment)) if text
        )
        rows.append(
            {
                **S.base_cells(s.employee),
                "branch": s.branch.name if s.branch_id else None,
                "requestedAt": fmt_dt(s.created_at),
                "destination": s.destination,
                "status": OD.status_label(s.status),
                "decisionPath": OD.decision_path(s),
                "hodBy": s.hod_reviewed_by,
                "hodAt": fmt_dt(s.hod_reviewed_at),
                "hrBy": s.hr_reviewed_by,
                "hrAt": fmt_dt(s.hr_reviewed_at),
                "comments": comments or None,
                "decisionHours": h,
                "punchesTotal": st.get("total", 0),
                "punchesApproved": st.get("approved", 0),
                "punchesPending": st.get("pending", 0),
                "punchesRejected": st.get("rejected", 0),
                "firstPunch": S.tstr(st.get("first")),
                "lastPunch": S.tstr(st.get("last")),
                "mockedPunches": st.get("mocked", 0),
                "completion": OD.completion_text(s),
                "outpass": "Issued" if s.id in with_outpass else None,
            }
        )
        if s.id not in counted:
            continue
        if h is not None:
            hours.append(h)
        punches += st.get("total", 0)
        mocked_sessions += 1 if st.get("mocked", 0) else 0
        by_status[
            "pending"
            if s.status in ("pending_hod", "pending_hr")
            else "approved"
            if s.status in OD.APPROVED_STATUSES
            else s.status
        ] += 1
    return ReportResult(
        rows=rows,
        summary=[
            {"label": "On-duty requests", "value": len(counted), "format": "integer"},
            {"label": "Pending decision", "value": by_status["pending"], "format": "integer"},
            {"label": "Approved by HR", "value": by_status["approved"], "format": "integer"},
            {"label": "Rejected", "value": by_status["rejected"], "format": "integer"},
            {"label": "Punches captured", "value": punches, "format": "integer"},
            {
                "label": "Avg request-to-decision (h)",
                "value": round(sum(hours) / len(hours), 2) if hours else None,
                "format": "hours",
            },
        ],
        notes=[
            "Date = the IST date the on-duty request was submitted (a session has no date of its own). Branch = the "
            "employee's branch when the request was raised.",
            "The employee may work and punch as soon as the request is submitted; those punches stay Pending until HR "
            "approves the request, and are voided (Rejected) if either stage rejects it. Approved = HR approved "
            "(Active or Completed).",
            "First / last punch consider approved and pending punches only. Decision hours = request submitted to the "
            f"final answer (HR decision, or the HOD's rejection); blank while undecided. {mocked_sessions} request(s) "
            "include a mock-GPS punch.",
            *S.cut_note(sessions, ctx),
        ],
    )


def _on_duty_register_columns() -> tuple[ColumnSpec, ...]:
    from ..derive import base_spec

    return base_spec("on-duty-register").columns


register(
    ReportSpec(
        id="on-duty-report",
        title="On-Duty Report",
        description="Every on-duty request: destination, HOD and HR decisions, punches captured, mock GPS and how it ended.",
        category=CATEGORY,
        icon="ClipboardList",
        tags=("on duty", "on-duty", "field visit", "outdoor duty", "approval"),
        modules=("geo_attendance",),
        filters=(
            F.date_range("thisMonth", "Request date"),
            *F.scope(status="all"),
            F.select("status", "Status", OD.STATUS_OPTIONS),
        ),
        columns=_on_duty_register_columns(),
        run=_on_duty_report_run,
    )
)


# ══════════════════════════════════════════════════════════════════════════════
#  On-Duty with Punch Details
# ══════════════════════════════════════════════════════════════════════════════

_PUNCH_DETAIL_COLUMNS = (
    *S.LEAD_COLS,
    ColumnSpec("dutyDate", "On-duty date", DATE, 1.3),
    ColumnSpec("destination", "Destination", TEXT, 1.5),
    ColumnSpec("request", "Request", BADGE, 0.95),
    ColumnSpec("punches", "Punches of the day", TEXT, 3.6),
    ColumnSpec("approved", "Approved", INTEGER, 0.85, total="sum"),
    ColumnSpec("pending", "Pending", INTEGER, 0.8, total="sum"),
    ColumnSpec("rejected", "Rejected", INTEGER, 0.85, total="sum"),
    ColumnSpec("mocked", "Mock GPS", INTEGER, 0.8, total="sum"),
    ColumnSpec("dayStatus", "Day status", BADGE, 1.0),
    ColumnSpec("shifts", "Shift credit", NUMBER, 0.8, total="sum"),
    ColumnSpec("outcome", "Verification", BADGE, 1.15),
    ColumnSpec("journeyKm", "Journey (km)", NUMBER, 0.85, total="sum"),
)


def off_quarter_grid(value) -> bool:
    """A stored shift credit that is not a multiple of 0.25 (production days stored before the quarters-only rule)."""
    if value is None:
        return False
    return (Decimal(str(value)) * 4) % 1 != 0


def punch_outcome(states: list[str]) -> str:
    """One word for the day's on-duty punches: what HR still has to do, or what it decided."""
    if not states:
        return "No on-duty punches"
    c = Counter(states)
    if c["pending"]:
        return "Waiting for HR"
    if c["approved"] == len(states):
        return "All approved"
    if c["approved"]:
        return "Partly rejected"
    return "Voided" if c["voided"] == len(states) else "Rejected"


def _punch_details_run(ctx) -> ReportResult:
    from api.geo_attendance_views import source_label
    from api.models import AttendanceDayRecord, AttendanceLog, DutyTrack, OnDutyPunchVerification

    sessions = list(
        OD._sessions_base(ctx)
        .select_related(*EMP_RELATED)
        .defer(*NO_PHOTO)
        .order_by("created_at", "id")[: ctx.row_limit]
    )
    ids = [s.id for s in sessions]
    day_of = {s.id: S.ist_date(s.created_at) for s in sessions}
    keys = {(s.employee_id, day_of[s.id]) for s in sessions}
    emp_ids = {k[0] for k in keys}
    lo = min((k[1] for k in keys), default=None)
    hi = max((k[1] for k in keys), default=None)

    verifs: dict[int, list] = defaultdict(list)
    for v in (
        OnDutyPunchVerification.objects.filter(session_id__in=ids)
        .order_by("punch_date", "punch_time", "id")
        .values("session_id", "punch_date", "punch_time", "punch_type", "status", "is_mocked", "hr_review_comment")
    ):
        verifs[v["session_id"]].append(v)
    logs: dict[tuple, list] = defaultdict(list)
    records: dict[tuple, dict] = {}
    if keys:
        for eid, d, t, kind, src in (
            AttendanceLog.objects.filter(employee_id__in=emp_ids, date__range=(lo, hi))
            .exclude(source="on_duty:approved")  # shown through the session's own verification rows
            .order_by("punch_time", "id")
            .values_list("employee_id", "date", "punch_time", "punch_type", "source")
        ):
            if (eid, d) in keys:
                logs[(eid, d)].append((t, kind, source_label(src)))
        for r in AttendanceDayRecord.objects.filter(employee_id__in=emp_ids, date__range=(lo, hi)).values(
            "employee_id", "date", "status", "shifts_earned"
        ):
            if (r["employee_id"], r["date"]) in keys:
                records[(r["employee_id"], r["date"])] = r
    tracks = {
        t["session_id"]: t
        for t in DutyTrack.objects.filter(session_id__in=ids).values("session_id", "distance_m", "stop_count")
    }

    counted = {s.id for s in S.shown(sessions, ctx)}
    rows = []
    totals: Counter = Counter()
    km_total = 0.0
    for s in sessions:
        day = day_of[s.id]
        key = (s.employee_id, day)
        own = verifs.get(s.id, [])
        states = [verification_state(v["status"], v["hr_review_comment"]) for v in own]
        # device punches without IN/OUT: most devices send every punch as IN, so the stored direction says nothing
        listed = [(t, f"{S.tstr(t)} {label}") for t, _kind, label in logs.get(key, [])]
        for v, state in zip(own, states):
            when = S.tstr(v["punch_time"])
            if v["punch_date"] != day:
                when = f"{when} ({display_date(v['punch_date'])})"
            mock = ", mock GPS" if v["is_mocked"] else ""
            listed.append((v["punch_time"], f"{when} On-duty {v['punch_type']} ({state}{mock})"))
        listed.sort(key=lambda x: x[0])
        rec = records.get(key)
        track = tracks.get(s.id)
        km = round((track["distance_m"] or 0) / 1000, 2) if track else None
        c = Counter(states)
        day_status = STATUS_LABELS.get(rec["status"], rec["status"]) if rec else None
        if rec and s.employee.employment_type == "production" and off_quarter_grid(rec["shifts_earned"]):
            day_status = f"{day_status} (out of date)"
            if s.id in counted:
                totals["stale"] += 1
        rows.append(
            {
                **S.base_cells(s.employee),
                "dutyDate": day.isoformat(),
                "destination": s.destination,
                "request": OD.status_label(s.status),
                "punches": "; ".join(text for _t, text in listed) or None,
                "approved": c["approved"],
                "pending": c["pending"],
                "rejected": c["rejected"] + c["voided"],
                "mocked": sum(1 for v in own if v["is_mocked"]),
                "dayStatus": day_status,
                "shifts": r2(rec["shifts_earned"]) if rec else None,
                "outcome": punch_outcome(states),
                "journeyKm": km,
            }
        )
        if s.id in counted:
            totals["days"] += 1
            totals["punches"] += len(own)
            totals["approved"] += c["approved"]
            totals["pending"] += c["pending"]
            totals["rejected"] += c["rejected"] + c["voided"]
            km_total += km or 0.0
    return ReportResult(
        rows=rows,
        summary=[
            {"label": "On-duty days", "value": totals["days"], "format": "integer"},
            {"label": "On-duty punches", "value": totals["punches"], "format": "integer"},
            {"label": "Approved", "value": totals["approved"], "format": "integer"},
            {"label": "Waiting for HR", "value": totals["pending"], "format": "integer"},
            {"label": "Rejected or voided", "value": totals["rejected"], "format": "integer"},
            {"label": "Journey tracked (km)", "value": round(km_total, 2), "format": "number"},
        ],
        notes=[
            "One row per on-duty request; the on-duty date is the IST date it was submitted. 'Punches of the day' lists "
            "every punch the employee has on that calendar date: device and app punches (biometric, office geo punch, HR "
            "entry, missing punch ...) and the request's own on-duty punches with their HR state (an approved on-duty "
            "punch is the attendance punch itself, so it is not listed twice).",
            "Verification: Waiting for HR while any on-duty punch is pending; All approved; Partly rejected; Rejected; "
            "Voided = rejected automatically with the request. Approved / Pending / Rejected count on-duty punches only.",
            "Day status and shift credit are the stored attendance record of that date (what payroll pays). A production "
            "employee's day is stored under the shift day it started.",
            "Journey (km) = the distance of the request's geo-tracking journey (DutyTrack), when the app recorded one.",
            *(
                [
                    f"{totals['stale']} production day(s) hold a shift credit off the quarter grid (stored before the "
                    "quarters-only rule): shown as stored and marked 'out of date'; payroll works such a day out again."
                ]
                if totals["stale"]
                else []
            ),
            *S.cut_note(sessions, ctx),
        ],
    )


register(
    ReportSpec(
        id="on-duty-punch-details",
        title="On-Duty with Punch Details",
        description="Each on-duty day with every punch of that day (device and on-duty GPS), HR verification, day status and journey.",
        category=CATEGORY,
        icon="Fingerprint",
        tags=("on duty", "on-duty", "punch", "gps", "verification", "journey"),
        modules=("geo_attendance",),
        filters=(
            F.date_range("thisMonth", "On-duty date"),
            *F.scope(status="all"),
            F.select("status", "Request status", OD.STATUS_OPTIONS),
        ),
        columns=_PUNCH_DETAIL_COLUMNS,
        run=_punch_details_run,
    )
)

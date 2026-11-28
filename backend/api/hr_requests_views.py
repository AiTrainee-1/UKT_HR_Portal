"""
Requests hub: one list of every request an employee (or HR) raises and somebody has to decide.

    GET /api/hr-requests?kind=all|leave,permission,...&status=any|waiting|decided|approved|rejected
                       &since=YYYY-MM-DD&until=YYYY-MM-DD&branchId=&departmentId=&employeeType=&limit=

    Paged (the HR portal since 2026-11-21): add &page=1&pageSize=25 and, optionally, &q= (every word must match the
    employee or the request's own text), &status=waiting_hr|waiting_hod, &requestType= (Other requests), &sort=latest|
    oldest|waiting|employee|kind, &focus=<kind>-<id> (that request is returned as `focusItem` whatever the filters), and
    &export=1 (one page of up to EXPORT_MAX rows, for the Excel / CSV export). The response then also carries `page`,
    `pageSize`, `total` and `pages`; `items` is that page only, already filtered and sorted by the server.

    Date filter (the HR portal's Today / Yesterday / This Month / Custom, 2026-11-24): add &from=YYYY-MM-DD&to=YYYY-MM-DD
    (India days, both included, either may be left out) and only the requests FOR those days are listed (date_span.py):
    a leave whose days overlap them, a permission / casual leave / missing punch / attendance correction by its date, an
    On-Duty punch by its punch date, a compensation claim by its work date; an On-Duty request, an outpass and a general
    request by the day they were made (the day they are for); a resignation and an advance by the day they were made too
    (a last working day / a deduction month is usually ahead, where a filter that never goes past today cannot reach).
    The figures (`stats`) and each kind's waiting counts then follow those days as well: waiting for HR / HOD and the
    oldest waiting among the requests for those days, and approvedThisMonth / rejectedThisMonth become the requests for
    those days that ended approved / rejected. `stats` also gains `range` {from, to}, `allWaiting` (every waiting request,
    any day), `outsideWaiting` (the waiting ones for other days) and `outsideEarliest` (the earliest day one of those is
    for). `since` / `until` (the submitted date) still work beside it. Without from / to everything is as before.

The HR portal's Requests page used to merge three of the lists the HRMS keeps (leave, permission, manual outpass). This is
the same thing for every kind in approval_workflow.DEFINITIONS plus the general employee requests: ONE response with, per
kind, how many are waiting and who for, the request rows themselves (employee, what was asked, where it stands in its
approval pipeline, who decided it and when) and the figures for the cards above the list.

It only reads. Deciding a request still goes to the endpoint of its own kind (leave-requests/<id>/status, permissions/<id>,
casual-leaves/<id>, ...), so the approval pipeline in approval_workflow.py is never bypassed here. Visibility is the one the
existing list of each kind has: branch-scoped by the HR user's branch, and a kind is left out entirely when the user's role
cannot open the module that owns it (leave, casual_leave, geo_attendance, settlement, ...). The Managing Director only ever
views: every kind is reported with access "view".
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import date, datetime, time, timedelta
from typing import Callable

from django.apps import apps
from django.db.models import Q
from rest_framework.decorators import api_view
from rest_framework.request import Request
from rest_framework.response import Response

from . import approval_workflow as approval
from .auth import require_hr
from .branch_scope import scope_to_branch
from .clock import FACTORY_TZ, ist_today
from .date_span import DaySpan, DaySpanError, parse_day_span
from .employee_photo import employee_photo_link, photo_links
from .models import AttendanceLog
from .permission_registry import effective_permissions, resolve_permission

# Rows returned per kind when the caller does not say (and the most it may ask for): a kind with more rows than this in the
# chosen period is reported as truncated, and the page tells HR to narrow the period.
DEFAULT_LIMIT = 200
MAX_LIMIT = 1000

# The paged list (2026-11-21): rows per page the page may ask for, and the most one export call returns.
PAGE_SIZE_DEFAULT = 25
PAGE_SIZE_MAX = 100
EXPORT_MAX = 5000

STATUS_CHOICES = ("any", "waiting", "decided", "approved", "rejected")
# only with page=: waiting for HR / for the Department Head right now (worked out from each row's approval pipeline)
PAGED_STATUS_CHOICES = STATUS_CHOICES + ("waiting_hr", "waiting_hod")
SORT_CHOICES = ("latest", "oldest", "waiting", "employee", "kind")

# "Approved / rejected this month" counts decisions made this month. A request carries no single "decided at" column across
# kinds, so decisions are read from rows submitted since the start of the PREVIOUS month: nobody waits longer than that for a
# decision (an employee may only request the current month, plus the last one for two days).
DECISION_LOOKBACK_MONTHS = 1


@dataclass(frozen=True)
class Kind:
    key: str  # the approval workflow key (also the tab key on the page)
    label: str
    module: str  # the permission module that owns the kind (permission_registry.py)
    model: str
    # "quick": HR decides with Approve / Reject here; "notes": HR sets a status and notes here (general employee requests);
    # "link": the decision needs more than a button, so the page opens the dedicated page
    mode: str
    open_path: str | None
    open_label: str | None
    waiting: tuple[str, ...]  # stored statuses that mean "still waiting for a decision"
    rejected: tuple[str, ...] = ("rejected",)
    scope_field: str = "employee__branch_id"
    extra_filter: dict = field(default_factory=dict)
    select: tuple[str, ...] = ("employee__department", "employee__designation", "employee__branch")
    # the request's own text columns the paged search looks in (besides the employee's name, code, department ...)
    search: tuple[str, ...] = ("reason",)
    # the day the request is FOR, for the from / to date filter (2026-11-24): a date column (with the column of its last
    # day for a span, `day_text` when they hold YYYY-MM-DD text); None = the India day it was made (created_at)
    day_field: str | None = None
    day_end_field: str | None = None
    day_text: bool = False


# The Compensation claims list (the Sunday / holiday work section's Claims tab lists every claim kind).
COMPENSATION_CLAIMS_PATH = "/hr/compensation/compensation-leave/holiday-work/claims"
# The Birthdays section of Compensation Leave (Birthday Compensation is chosen and listed there).
BIRTHDAYS_PATH = "/hr/compensation/compensation-leave/birthdays"

KINDS: tuple[Kind, ...] = (
    Kind(
        "leave",
        "Leave",
        "leave",
        "LeaveRequest",
        "quick",
        "/hr/leave?tab=leaves",
        "Leave & Holiday",
        ("pending",),
        search=("reason", "type"),
        day_field="start_date",
        day_end_field="end_date",
        day_text=True,
    ),
    Kind(
        "permission",
        "Permission",
        "requests",
        "EmployeePermission",
        "quick",
        "/hr/leave?tab=permissions",
        "Leave & Holiday",
        ("pending",),
        day_field="date",
    ),
    Kind(
        "casual_leave",
        "Casual Leave",
        "casual_leave",
        "CasualLeaveRequest",
        "quick",
        "/hr/casual-leave",
        "Casual Leave",
        ("pending",),
        day_field="date",
    ),
    Kind(
        "missing_punch",
        "Missing Punch",
        "missing_punch",
        "MissingPunchRequest",
        "quick",
        "/hr/missing-punch",
        "Missing Punch",
        ("pending_hod", "pending_hr"),
        day_field="date",
    ),
    Kind(
        "on_duty",
        "On-Duty",
        "geo_attendance",
        "OnDutySession",
        "quick",
        "/hr/geo-attendance/approvals",
        "Geo Attendance",
        ("pending_hod", "pending_hr"),
        scope_field="branch_id",
        select=("employee__department", "employee__designation", "employee__branch", "branch"),
        search=("destination",),
    ),
    Kind(
        "on_duty_punch",
        "On-Duty punches",
        "geo_attendance",
        "OnDutyPunchVerification",
        "link",
        # the section where the punches are decided (Geo Attendance has an address per section since 2026-11)
        "/hr/geo-attendance/verifications",
        "Geo Attendance",
        ("pending",),
        select=("employee__department", "employee__designation", "employee__branch", "session"),
        search=("session__destination",),
        day_field="punch_date",
    ),
    Kind(
        "outpass",
        "Outpass",
        "requests",
        "OutpassRequest",
        "quick",
        "/hr/outpass-visitors/outpass",
        "Outpass",
        ("pending",),
        extra_filter={"source": "manual"},
        select=("employee__department", "employee__designation", "employee__branch", "exit_gate"),
        search=("destination", "reason"),
    ),
    Kind(
        "request",
        "Other requests",
        "requests",
        "EmployeeRequest",
        "notes",
        None,
        None,
        ("pending", "in_review", "more_info"),
        search=("subject", "description", "hr_notes"),
    ),
    Kind(
        "attendance_correction",
        "Attendance correction",
        "attendance",
        "AttendanceOverrideRequest",
        "quick",
        None,
        None,
        ("pending",),
        day_field="date",
    ),
    # every compensation claim kind since 2026-11-19 (Sunday / holiday work, OT allowance / shift credit, birthday credit,
    # use of the balance): the Department Head decides them, so HR opens the Compensation claims list
    Kind(
        "holiday_work",
        "Compensation claims",
        "compensation",
        "HolidayWorkClaim",
        "link",
        COMPENSATION_CLAIMS_PATH,
        "Compensation",
        ("pending",),
        # a date HR chose on the calendar (hr_step) is its own kind below: HR decides it after the Department Head
        extra_filter={"hr_step": False},
        day_field="work_date",
    ),
    # Compensation days on a chosen date (2026-11-28, compensation_placement.py): HR placed Shift / OT / Sunday / holiday
    # work compensation (or the balance) on a date; the Department Head decides first, then HR here (Approve / Reject call
    # PATCH /api/compensation/placements/<id>/decision). Listed by the claim's date (the day worked / the day off).
    Kind(
        "compensation_placement",
        "Compensation days (chosen dates)",
        "compensation.leave.holiday_work.claims",
        "HolidayWorkClaim",
        "quick",
        COMPENSATION_CLAIMS_PATH,
        "Compensation",
        ("pending",),
        extra_filter={"hr_step": True},
        select=("employee__department", "employee__designation", "employee__branch", "source_claim"),
        day_field="work_date",
    ),
    # Birthday Compensation days (2026-11-25): the Department Head decides first, then HR here (Approve / Reject call
    # PATCH /api/compensation/birthday-compensation/uses/<id>/decision); listed by the day it is placed on. A withdrawn one
    # is never listed (nobody decided it).
    Kind(
        "birthday_compensation",
        "Birthday Compensation",
        "compensation.leave.birthdays",
        "BirthdayCompensationUse",
        "quick",
        BIRTHDAYS_PATH,
        "Compensation",
        ("pending",),
        extra_filter={"withdrawn_at__isnull": True},
        day_field="use_date",
    ),
    Kind(
        "resignation",
        "Resignation",
        "recruitment.resignations",
        "ResignationRequest",
        "link",
        "/hr/recruitment/resignations",
        "Resignations",
        ("pending", "dept_approved"),
        select=("employee__department", "employee__designation", "employee__branch", "dept_head"),
    ),
    Kind(
        "advance",
        "Advance",
        "settlement",
        "Advance",
        "link",
        "/hr/Loan&Advance",  # the Settlement page, renamed Loan & Advance (owner 2026-11-27)
        "Loan & Advance",
        ("pending",),
        search=("purpose",),
    ),
)
BY_KEY = {k.key: k for k in KINDS}

REQUEST_TYPE_LABELS = {
    "leave": "Leave",
    "salary_enquiry": "Salary enquiry",
    "shift_correction": "Shift correction",
    "advance": "Advance",
    "permission": "Permission",
    "general": "General query",
}


# ───────────────────────────── small helpers ─────────────────────────────


def _iso(value) -> str | None:
    return value.isoformat() if value else None


def _name(emp) -> str:
    return f"{emp.first_name} {emp.last_name}".strip()


def _cap(text: str | None) -> str:
    return (text or "").replace("_", " ").strip().capitalize()


def _hhmm(value) -> str | None:
    return value.strftime("%H:%M") if value else None


def _money(value) -> str:
    return f"Rs. {float(value):,.0f}"


def _requested(day, to=None, note: str | None = None, *, label: str = "Requested date", precision: str = "day"):
    """The date (or range) a request is FOR, as the page shows it beside when it was submitted (owner brief 2026-11-21):
    {"from", "to" (a range only), "note" (time, part of day ...), "label" (what the date is), "precision" (day | month)}.
    None when there is no date to show."""
    if not day:
        return None
    text = lambda v: v if isinstance(v, str) else v.isoformat()  # noqa: E731
    return {"from": text(day), "to": text(to) if to else None, "note": note, "label": label, "precision": precision}


def _employee_json(emp, photos: dict | None = None) -> dict:
    """`photos`: photo_links of the listed employees. The photo is a signed link (employee_photo.py), never the embedded
    picture: one employee's 2 MB photo used to be repeated in every request they had made, 86 MB for one list."""
    return {
        "id": emp.id,
        "code": emp.employee_code,
        "name": _name(emp),
        "department": emp.department.name if emp.department_id and emp.department else None,
        "departmentId": emp.department_id,
        "designation": emp.designation.title if emp.designation_id and emp.designation else None,
        "branch": emp.branch.name if emp.branch_id and emp.branch else None,
        "branchId": emp.branch_id,
        "type": emp.employment_type,
        "photoUrl": employee_photo_link(emp, photos),
    }


def _is_waiting(kind: Kind, obj) -> bool:
    return obj.status in kind.waiting


def _normal_status(kind: Kind, obj) -> str:
    if _is_waiting(kind, obj):
        return "pending"
    return "rejected" if obj.status in kind.rejected else "approved"


def _queue(prog: dict | None) -> str | None:
    """Who a waiting request is with: HR (HR could decide it right now), the HOD (HR has to wait for that step) or someone
    else (HR is not in the pipeline at all)."""
    if not prog or prog.get("currentStep") is None:
        return None
    # HR's turn under the pipeline, whether or not the account looking may approve this kind (hr_access.py)
    if prog.get("hrTurn", prog["canAct"]["hr"]):
        return "hr"
    if "hod" in prog["waitingFor"]:
        return "hod"
    return "other"


def _role(raw: str | None) -> str | None:
    if not raw:
        return None
    return {"dept_head": "hod", "hod": "hod", "hr": "hr", "system": "system"}.get(raw, raw)


# ───────────────────────────── per-kind rows ─────────────────────────────
# Each builder returns the parts that differ between kinds. `decision` is (by, role, at, comment) from the request's own
# columns; the approval trail (the pipeline's record) wins over it when it has an entry.


def _leave(r):
    days = float(r.total_days) if r.total_days is not None else 1
    if r.is_half_day:
        label = f"Half Day Leave ({'Afternoon' if r.half_day_slot == 'afternoon' else 'Morning'})"
    else:
        label = _cap(r.type) if (r.type or "").lower().endswith("leave") else f"{_cap(r.type)} Leave"
    span = r.start_date if r.start_date == r.end_date else f"{r.start_date} → {r.end_date}"
    # the reason the employee picked in the apps (Sick Leave / Emergency / Personal / Other Reasons); blank on older ones
    category = dict(r.REASON_CATEGORY_CHOICES).get(r.reason_category or "")
    details = [
        ("From", r.start_date),
        ("To", r.end_date),
        ("Days", f"{days:g}"),
        ("Leave type", _cap(r.type)),
    ]
    if category:
        label = f"{label} · {category}"
        details.append(("Reason type", category))
    return {
        "label": label,
        "summary": f"{span} · {days:g} day{'' if days == 1 else 's'}",
        "reason": r.reason,
        "requested": _requested(
            r.start_date,
            r.end_date if r.end_date != r.start_date else None,
            f"{days:g} day{'' if days == 1 else 's'}",
            label="Requested dates" if r.end_date and r.end_date != r.start_date else "Requested date",
        ),
        "date": r.start_date,
        "details": details,
        "decision": (r.approved_by, _role(r.approver_role), None, r.hr_comment),
    }


def _permission(r, extra):
    perm = extra["permission"](r)
    time_text = perm["permissionTime"]
    return {
        "label": f"Permission · {perm['typeLabel'] or 'Type not set'}",
        "summary": f"{perm['date']}" + (f" at {time_text}" if time_text else ""),
        "reason": r.reason,
        "requested": _requested(perm["date"], note=f"at {time_text}" if time_text else None),
        "date": perm["date"],
        "details": [
            ("Date", perm["date"]),
            ("Time", time_text or "Not given"),
            ("Type", perm["typeLabel"] or "Not set yet"),
            ("Duration", f"{perm['durationMinutes']} minutes" if perm["durationMinutes"] else "Not given"),
        ],
        "decision": (r.approved_by, _role(r.approver_role), None, r.hr_comment),
        "extra": {
            "typeKey": perm["typeKey"],
            "typeLabel": perm["typeLabel"],
            "capStatus": perm["capStatus"],
            "statusLabel": perm["statusLabel"],
            "monthlyLimit": perm["monthlyLimit"],
            "permissionTime": time_text,
        },
    }


def _casual(r):
    # a half-day CL (first / second half of the shift) says so; a full day reads exactly as before
    portion = dict(r.PORTION_CHOICES).get(r.portion) if r.portion and r.portion != r.PORTION_FULL else None
    return {
        "label": f"Casual Leave · Half day ({portion.lower()})" if portion else "Casual Leave",
        "summary": f"{r.date} · {portion.lower()}" if portion else str(r.date),
        "reason": r.reason,
        "requested": _requested(r.date, note=f"half day ({portion.lower()})" if portion else "full day"),
        "date": str(r.date),
        "details": [("Date", str(r.date)), ("Day part", f"Half day ({portion.lower()})" if portion else "Full day")],
        "decision": (r.reviewed_by, _role(r.reviewer_role), r.reviewed_at, r.review_comment),
    }


def _missing_punch(r):
    slot = dict(r.PUNCH_SLOT_CHOICES).get(r.punch_slot) or ("Check-in" if r.punch_type == "IN" else "Check-out")
    return {
        "label": f"Missing Punch · {slot}",
        "summary": f"{r.date} at {_hhmm(r.punch_time)} · {slot}",
        "reason": r.reason,
        "requested": _requested(
            r.date, note=f"{slot.lower()} at {_hhmm(r.punch_time)}" if r.punch_time else slot.lower()
        ),
        "date": str(r.date),
        "details": [("Date", str(r.date)), ("Punch time", _hhmm(r.punch_time) or ""), ("Punch", slot)],
        "decision": (
            r.hr_reviewed_by or r.hod_reviewed_by,
            "hr" if r.hr_reviewed_by else ("hod" if r.hod_reviewed_by else None),
            r.hr_reviewed_at or r.hod_reviewed_at,
            r.hr_review_comment or r.hod_review_comment,
        ),
    }


def _on_duty(r):
    pending_punches = r.punch_verifications.filter(status="pending").count() if r.status.startswith("pending") else 0
    details = [("Destination", r.destination)]
    if r.branch_id and r.branch:
        details.append(("Branch", r.branch.name))
    if pending_punches:
        details.append(("Punches waiting", f"{pending_punches} (accepted or voided with this decision)"))
    if r.started_at:
        details.append(("Started", r.started_at.astimezone(FACTORY_TZ).strftime("%Y-%m-%d %H:%M")))
    if r.completed_at:
        details.append(("Completed", r.completed_at.astimezone(FACTORY_TZ).strftime("%Y-%m-%d %H:%M")))
    return {
        "label": "On-Duty",
        "summary": r.destination,
        "reason": None,
        # the day the employee went on duty (the day they started it, else the day they asked)
        "requested": _requested(
            (r.started_at or r.created_at).astimezone(FACTORY_TZ).date() if (r.started_at or r.created_at) else None,
            note=f"at {r.destination}" if r.destination else None,
            label="On-Duty day",
        ),
        "date": _iso(r.created_at.astimezone(FACTORY_TZ).date()) if r.created_at else None,
        "details": details,
        "decision": (
            r.hr_reviewed_by or r.hod_reviewed_by,
            "hr" if r.hr_reviewed_by else ("hod" if r.hod_reviewed_by else None),
            r.hr_reviewed_at or r.hod_reviewed_at,
            r.hr_review_comment or r.hod_review_comment,
        ),
        "extra": {"pendingPunchCount": pending_punches, "sessionStatus": r.status},
    }


def _on_duty_punch(r):
    punch = dict(AttendanceLog.PUNCH_CHOICES).get(r.punch_type) or r.punch_type
    return {
        "label": f"On-Duty punch {r.punch_number} ({punch})",
        "summary": f"{r.punch_date} {_hhmm(r.punch_time)} · {r.session.destination}",
        "reason": None,
        "requested": _requested(r.punch_date, note=f"punch at {_hhmm(r.punch_time)}" if r.punch_time else None),
        "date": str(r.punch_date),
        "details": [
            ("Date", str(r.punch_date)),
            ("Time", _hhmm(r.punch_time) or ""),
            ("Destination", r.session.destination),
            ("Photo", "Captured (check it on the Geo Attendance page)" if r.photo else "None"),
            ("Mock location", "Yes - the phone reported a mocked GPS" if r.is_mocked else "No"),
        ],
        "decision": (r.hr_reviewed_by, "hr" if r.hr_reviewed_by else None, r.hr_reviewed_at, r.hr_review_comment),
    }


def _outpass(r):
    details = [("Destination", r.destination), ("Pass type", _cap(r.pass_type) or "Not given")]
    if r.expected_return_at:
        details.append(("Expected back", r.expected_return_at.astimezone(FACTORY_TZ).strftime("%Y-%m-%d %H:%M")))
    if r.exit_gate_id and r.exited_at:
        details.append(("Exited", f"{r.exit_gate.name} at {r.exited_at.astimezone(FACTORY_TZ).strftime('%H:%M')}"))
    return {
        "label": f"Outpass · {_cap(r.pass_type)}" if r.pass_type else "Outpass",
        "summary": r.destination,
        "reason": r.reason,
        # an outpass is for the day it was asked for (going out now), back by the expected time when one was given
        "requested": _requested(
            r.created_at.astimezone(FACTORY_TZ).date() if r.created_at else None,
            note=(
                f"back by {r.expected_return_at.astimezone(FACTORY_TZ).strftime('%H:%M')}"
                if r.expected_return_at
                else None
            ),
            label="Going out on",
        ),
        "date": _iso(r.created_at.astimezone(FACTORY_TZ).date()) if r.created_at else None,
        "details": details,
        "decision": (r.approved_by, _role(r.approver_role), r.approved_at, r.review_comment),
    }


def _request(r):
    type_label = REQUEST_TYPE_LABELS.get(r.request_type, _cap(r.request_type))
    return {
        "label": type_label,
        "summary": r.subject,
        "reason": r.description,
        "reasonLabel": "Description",
        "requested": None,  # a general request is not for a date
        "date": _iso(r.created_at.astimezone(FACTORY_TZ).date()) if r.created_at else None,
        "details": [("Type", type_label), ("Subject", r.subject), ("Handled", _cap(r.status))],
        "decision": (r.handled_by, "hr" if r.handled_by else None, r.handled_at, r.hr_notes),
        "statusLabel": {"pending": "Pending", "in_review": "In review", "more_info": "More info needed"}.get(r.status),
        "extra": {"requestType": r.request_type, "storedStatus": r.status, "hrNotes": r.hr_notes},
    }


def _correction(r):
    asked = r.requested_values or {}
    before = r.previous_values or {}
    proposed = asked.get("typeLabel") or _cap(asked.get("status"))
    was = _cap(before.get("status")) or "-"
    # A Permission / Casual Leave half-day edit (2026-11-02) leaves the shift count to the attendance engine: no figure then.
    shifts = asked.get("shiftsEarned")
    details = [
        ("Date", str(r.date)),
        ("Was", f"{was} · {float(before.get('shiftsEarned') or 0):.2f} shift"),
        ("Proposed", f"{proposed} · {float(shifts):.2f} shift" if shifts not in (None, "") else proposed),
    ]
    if asked.get("firstPunch") or asked.get("lastPunch"):
        details.append(("Times", f"{asked.get('firstPunch') or '-'} to {asked.get('lastPunch') or '-'}"))
    marks = [m for m, on in (("Late", asked.get("isLate")), ("Early out", asked.get("isEarlyOut"))) if on]
    if marks:
        details.append(("Marked", ", ".join(marks)))
    details.append(("Raised by", r.requested_by or "HR"))
    return {
        "label": "Attendance correction",
        "summary": f"{r.date} · {was} → {proposed}",
        "reason": r.reason,
        "requested": _requested(r.date, note=f"{was} → {proposed}"),
        "date": str(r.date),
        "details": details,
        "decision": (r.reviewed_by, "hr" if r.reviewed_by else None, r.reviewed_at, r.review_comment),
    }


def _holiday_work(r):
    """A compensation claim of any kind (the one claim table, 2026-11-19)."""
    from .compensation_claims import KIND_LABELS

    kind = getattr(r, "kind", "holiday_work") or "holiday_work"
    raised = "Employee" if getattr(r, "raised_by_role", "hr") == "employee" else "HR"
    shifts = f"{float(r.shifts):.2f}"
    if kind == "holiday_work":
        day = "Sunday" if r.work_date.weekday() == 6 else "Holiday"
        details = [("Work date", str(r.work_date)), ("Day", day), ("Shifts claimed", shifts)]
        label, summary = "Holiday / Sunday work", f"{r.work_date} · {float(r.shifts):g} shift"
    elif kind == "ot_allowance":
        details = [("OT date", str(r.work_date)), ("Late-in allowance", f"{r.minutes or 0} min")]
        label, summary = KIND_LABELS[kind], f"{r.work_date} · {r.minutes or 0} min"
    elif kind == "use_balance":
        details = [("Day off", str(r.work_date)), ("Shifts to use", shifts)]
        label, summary = KIND_LABELS[kind], f"{r.work_date} · {float(r.shifts):g} shift"
    else:
        date_label = "OT date" if kind == "ot_shift" else "Birthday"
        details = [(date_label, str(r.work_date)), ("Shifts claimed", shifts)]
        label, summary = KIND_LABELS.get(kind, "Compensation claim"), f"{r.work_date} · {float(r.shifts):g} shift"
    if raised == "Employee":
        details.append(("Raised by", f"{r.requested_by or 'The employee'} (employee)"))
    else:
        details.append(("Raised by", r.requested_by or "HR"))
    return {
        "label": label,
        "summary": summary,
        "reason": r.reason,
        "requested": _requested(
            r.work_date, note=summary.split(" · ", 1)[1] if " · " in summary else None, label=details[0][0]
        ),
        "date": str(r.work_date),
        "details": details,
        "decision": (r.reviewed_by, "hod" if r.reviewed_by else None, r.reviewed_at, r.review_comment),
        "extra": {
            "claimKind": kind,
            "raisedByRole": getattr(r, "raised_by_role", "hr"),
            # the Claims tab's own URL state (hmonth / hemp / hclaim): every month, this employee, this claim open
            "openPath": f"{COMPENSATION_CLAIMS_PATH}?hmonth=all&hemp={r.employee_id}&hclaim={r.id}",
        },
    }


def _compensation_placement(r):
    """A compensation day HR placed on a chosen date (2026-11-28): what it places, the day and how much."""
    from . import compensation_placement as places

    day, shifts = places.placed_day(r)
    comp = places.claim_type(r)
    label = places.TYPE_LABELS[comp]
    details = [("Day off on", str(day) if day else "-"), ("Shifts", f"{float(shifts):.2f}")]
    if r.kind != "use_balance":
        details.append(("Worked on" if r.kind == "holiday_work" else "OT date", str(r.work_date)))
        details.append(("Credit", f"{float(r.shifts):.2f}"))
    elif r.source_claim_id and getattr(r, "source_claim", None) is not None:
        details.append(("From the credit of", str(r.source_claim.work_date)))
    else:
        details.append(("From", "The compensation balance"))
    details.append(("Placed by", r.requested_by or "HR"))
    summary = f"{day} · {float(shifts):g} shift" if day else label
    return {
        "label": label,
        "summary": summary,
        "reason": r.reason,
        "requested": _requested(day, note=f"{float(shifts):g} shift", label="Day off on") if day else None,
        "date": str(day) if day else str(r.work_date),
        "details": details,
        "decision": (r.reviewed_by, None, r.reviewed_at, r.review_comment),
        "extra": {
            "claimKind": r.kind,
            "compType": comp,
            "useDate": str(day) if day else None,
            "openPath": f"{COMPENSATION_CLAIMS_PATH}?hmonth=all&hemp={r.employee_id}&hclaim={r.id}",
        },
    }


def _birthday_compensation(r):
    """A Birthday Compensation day placed in the birthday month (2026-11-25)."""
    part = {"full": "Full day", "first_half": "First half", "second_half": "Second half"}.get(r.portion, r.portion)
    raised = "Employee" if r.raised_by_role == "employee" else "HR"
    details = [
        ("Placed on", str(r.use_date)),
        ("Day part", part),
        ("Days", f"{float(r.days):.2f}"),
        ("Birthday", str(r.birthday)),
        (
            "Raised by",
            f"{r.requested_by or 'The employee'} (employee)" if raised == "Employee" else r.requested_by or "HR",
        ),
    ]
    hr_done = bool(r.hr_reviewed_by)
    return {
        "label": f"Birthday Compensation · {part.lower()}",
        "summary": f"{r.use_date} · {part.lower()} (birthday {r.birthday})",
        "reason": r.reason or None,
        "requested": _requested(r.use_date, note=part.lower(), label="Placed on"),
        "date": str(r.use_date),
        "details": details,
        "decision": (
            r.hr_reviewed_by or r.hod_reviewed_by,
            "hr" if hr_done else ("hod" if r.hod_reviewed_by else None),
            r.hr_reviewed_at or r.hod_reviewed_at,
            r.hr_review_comment if hr_done else r.hod_review_comment,
        ),
        "extra": {
            "birthday": str(r.birthday),
            "portion": r.portion,
            "days": float(r.days),
            "raisedByRole": r.raised_by_role,
            "decisionPath": f"/api/compensation/birthday-compensation/uses/{r.id}/decision",
            # the Birthdays list's own URL state (bperiod / bdate / bq): the birthday's month, this employee
            "openPath": f"{BIRTHDAYS_PATH}/list?bperiod=month&bdate={r.birthday}&bq={r.employee.employee_code}",
        },
    }


def _resignation(r):
    details = [("Last working day", _iso(r.last_working_date) or "Not given")]
    if r.dept_head_id and r.dept_head:
        details.append(("Department Head", _name(r.dept_head)))
    if r.dept_head_comment:
        details.append(("Department Head note", r.dept_head_comment))
    return {
        "label": "Resignation",
        "summary": f"Last working day {r.last_working_date}" if r.last_working_date else "Last working day not given",
        "reason": r.reason,
        "requested": _requested(r.last_working_date, label="Last working day"),
        "date": _iso(r.last_working_date),
        "details": details,
        "decision": (
            r.approved_by or r.rejected_by,
            "hr" if (r.approved_by or r.rejected_by) else None,
            r.approved_at,
            r.hr_comment,
        ),
    }


def _advance(r):
    kind_label = dict(r.ADVANCE_TYPES).get(r.advance_type, _cap(r.advance_type))
    details = [("Amount", _money(r.amount)), ("Type", kind_label)]
    if r.repayment_months:
        details.append(("Repayment", f"{r.repayment_months} months of {_money(r.emi_amount)}"))
    return {
        "label": f"Advance · {kind_label}",
        "summary": f"{_money(r.amount)} · {kind_label}",
        "reason": r.purpose,
        "reasonLabel": "Purpose",
        # an advance is for the month its deduction starts in
        "requested": (
            _requested(date(r.repayment_start_year, r.repayment_start_month, 1), label="Deduct from", precision="month")
            if r.repayment_start_year and r.repayment_start_month
            else None
        ),
        "date": _iso(r.created_at.astimezone(FACTORY_TZ).date()) if r.created_at else None,
        "details": details,
        "decision": (r.approved_by, "hr" if r.approved_by else None, r.approved_at, None),
    }


BUILDERS: dict[str, Callable] = {
    "leave": _leave,
    "casual_leave": _casual,
    "missing_punch": _missing_punch,
    "on_duty": _on_duty,
    "on_duty_punch": _on_duty_punch,
    "outpass": _outpass,
    "request": _request,
    "attendance_correction": _correction,
    "holiday_work": _holiday_work,
    "compensation_placement": _compensation_placement,
    "birthday_compensation": _birthday_compensation,
    "resignation": _resignation,
    "advance": _advance,
}


def _decision_of(kind: Kind, obj, parts: dict) -> dict:
    """Who decided a request and when: the approval trail's last decision, with the request's own columns filling any gap."""
    by, role, at, comment = parts.get("decision") or (None, None, None, None)
    trail = approval.trail_of(kind.key, obj) if approval.adapter(kind.key) else []
    last = next((e for e in reversed(trail) if e.get("decision") in ("approved", "rejected")), None)
    if last:
        by = last.get("by") or by
        role = last.get("role") or role
        at = last.get("at") or at
        comment = last.get("comment") or comment
    return {"by": by, "role": _role(role), "at": at.isoformat() if hasattr(at, "isoformat") else at, "comment": comment}


def _item(kind: Kind, obj, cfg, extra: dict, photos: dict | None = None) -> dict:
    build = BUILDERS.get(kind.key)
    parts = build(obj) if build else _permission(obj, extra)
    prog = approval.progress(kind.key, obj, cfg)
    status = _normal_status(kind, obj)
    waiting = status == "pending"
    return {
        "key": f"{kind.key}-{obj.id}",
        "kind": kind.key,
        "id": obj.id,
        "employee": _employee_json(obj.employee, photos),
        "label": parts["label"],
        "summary": parts["summary"],
        "reason": parts.get("reason"),
        # added 2026-11-21: what the reason is called on this kind, and the date(s) the request is for
        "reasonLabel": parts.get("reasonLabel") or "Reason",
        "requested": parts.get("requested"),
        "date": parts.get("date"),
        "details": [{"label": a, "value": b} for a, b in parts["details"]],
        "status": status,
        "rawStatus": obj.status,
        "statusLabel": parts.get("statusLabel"),
        "queue": _queue(prog) if waiting else None,
        "approval": prog,
        "submittedAt": _iso(obj.created_at),
        # only a finished request has a decision: a half-approved one shows its steps in `approval`
        "decided": None if waiting else _decision_of(kind, obj, parts),
        "extra": parts.get("extra") or {},
    }


# ───────────────────────────── queries ─────────────────────────────


def _model(kind: Kind):
    return apps.get_model("api", kind.model)


def _base_qs(kind: Kind, request: Request):
    qs = _model(kind).objects.filter(**kind.extra_filter)
    return scope_to_branch(qs, request, field=kind.scope_field)


def _with_related(kind: Kind, request: Request):
    """The kind's rows with what the list shows of them, except the employee's photo: an embedded photo can be MBs and
    select_related would read it once per row. The list shows a link instead (photo_links, one query per response). A
    resignation's Department Head (an employee too) is only ever shown by name."""
    unread = ["employee__photo_url"] + (["dept_head__photo_url"] if "dept_head" in kind.select else [])
    return _base_qs(kind, request).select_related(*kind.select).defer(*unread)


def _day_q(kind: Kind, span: DaySpan) -> Q:
    """The requests of `kind` that are for one of the span's days (see Kind.day_field)."""
    if kind.day_field is None:
        return span.instant_q("created_at")
    return span.day_q(kind.day_field, kind.day_end_field, text=kind.day_text)


def _day_of(kind: Kind, obj) -> date | None:
    """The (first) day a request is for, the same rule as _day_q."""
    if kind.day_field is None:
        return obj.created_at.astimezone(FACTORY_TZ).date() if obj.created_at else None
    value = getattr(obj, kind.day_field, None)
    if isinstance(value, str):
        try:
            return date.fromisoformat(value)
        except ValueError:
            return None
    return value


def _filtered_qs(kind: Kind, request: Request, params: dict):
    qs = _with_related(kind, request)
    if params.get("span") is not None:
        qs = qs.filter(_day_q(kind, params["span"]))
    status = params["status"]
    waiting = Q(status__in=kind.waiting)
    if status in ("waiting", "waiting_hr", "waiting_hod"):
        qs = qs.filter(waiting)
    elif status == "decided":
        qs = qs.exclude(waiting)
    elif status == "rejected":
        qs = qs.filter(status__in=kind.rejected)
    elif status == "approved":
        qs = qs.exclude(waiting).exclude(status__in=kind.rejected)
    if params["since"]:
        qs = qs.filter(created_at__gte=params["since"])
    if params["until"]:
        qs = qs.filter(created_at__lt=params["until"])
    if params["branch_id"]:
        qs = qs.filter(employee__branch_id=params["branch_id"])
    if params["department_id"]:
        qs = qs.filter(employee__department_id=params["department_id"])
    if params["employee_type"]:
        qs = qs.filter(employee__employment_type=params["employee_type"])
    return qs.order_by("-created_at", "-id")


def _day_start(day: date) -> datetime:
    return datetime.combine(day, time.min, tzinfo=FACTORY_TZ)


def _parse_params(request: Request) -> tuple[dict | None, str | None]:
    q = request.query_params
    paged = bool(q.get("page"))
    status = (q.get("status") or "any").lower()
    choices = PAGED_STATUS_CHOICES if paged else STATUS_CHOICES
    if status not in choices:
        return None, f"status must be one of: {', '.join(choices)}"
    out: dict = {"status": status, "since": None, "until": None}
    page, error = _parse_paging(q) if paged else (None, None)
    if error:
        return None, error
    out["paging"] = page
    try:
        if q.get("since"):
            out["since"] = _day_start(date.fromisoformat(q["since"]))
        if q.get("until"):
            out["until"] = _day_start(date.fromisoformat(q["until"]) + timedelta(days=1))  # the last day is included
        for name, key in (("branchId", "branch_id"), ("departmentId", "department_id")):
            out[key] = int(q[name]) if q.get(name) else None
        limit = int(q.get("limit") or DEFAULT_LIMIT)
    except (TypeError, ValueError):
        return None, "since / until must be dates (YYYY-MM-DD); branchId, departmentId and limit must be numbers"
    out["limit"] = max(1, min(MAX_LIMIT, limit))
    employee_type = (q.get("employeeType") or "").lower()
    out["employee_type"] = employee_type if employee_type in ("staff", "production") else None
    wanted = [k for k in (q.get("kind") or "all").split(",") if k and k != "all"]
    unknown = [k for k in wanted if k not in BY_KEY]
    if unknown:
        return None, f"unknown kind: {', '.join(unknown)}"
    out["kinds"] = wanted
    try:
        out["span"] = parse_day_span(q)
    except DaySpanError as exc:
        return None, str(exc)
    return out, None


def _parse_paging(q) -> tuple[dict | None, str | None]:
    """page / pageSize / q / sort / requestType / focus / export of the paged list (2026-11-21)."""
    try:
        page = max(1, int(q.get("page") or 1))
        size = int(q.get("pageSize") or PAGE_SIZE_DEFAULT)
    except (TypeError, ValueError):
        return None, "page and pageSize must be numbers"
    export = q.get("export") in ("1", "true")
    size = max(1, min(EXPORT_MAX if export else PAGE_SIZE_MAX, size))
    sort = (q.get("sort") or "latest").lower()
    if sort not in SORT_CHOICES:
        return None, f"sort must be one of: {', '.join(SORT_CHOICES)}"
    focus = None
    raw_focus = (q.get("focus") or "").strip()
    if raw_focus:
        key, _, pk = raw_focus.rpartition("-")
        if key not in BY_KEY or not pk.isdigit():
            return None, "focus must be <kind>-<id>, e.g. leave-12"
        focus = (key, int(pk))
    return {
        "page": page,
        "size": size,
        "words": [w for w in str(q.get("q") or "")[:200].lower().split() if w],
        "sort": sort,
        "request_type": (q.get("requestType") or "").strip() or None,
        "focus": focus,
    }, None


def _access_by_kind(request: Request) -> tuple[dict[str, str], dict[str, bool]]:
    """The level ("view" | "edit") the caller has on each kind's module (a kind they cannot open at all is absent), and
    whether they may approve / reject each kind (hr_access.py: a right of its own, apart from the level)."""
    from . import hr_access
    from .models import HRUser

    user_id = (getattr(request, "jwt_user", None) or {}).get("hrUserId")
    hr = HRUser.objects.select_related("role").filter(pk=user_id, is_active=True).first() if user_id else None
    if hr is None:
        return {}, {}
    permissions = effective_permissions(hr)
    approvals = hr_access.effective_approvals(hr, permissions)
    out: dict[str, str] = {}
    may: dict[str, bool] = {}
    for kind in KINDS:
        level = "edit" if hr.is_super_admin else resolve_permission(permissions, kind.module)
        # Requests -> Requests -> <kind> (permission_tree.py): a role can hide one kind of this list on its own. It follows
        # the Requests page until it is set, so nothing changes for a role that never set it.
        if not hr.is_super_admin and resolve_permission(permissions, f"requests.list.{kind.key}") == "hidden":
            level = "hidden"
        if level in ("view", "edit"):
            # the Managing Director only looks at requests; the decision endpoints refuse the MD anyway
            out[kind.key] = "view" if hr.is_md else level
            # an employee request / an advance: the account may approve at least one of its types (each row's own
            # `approval` block says which: hr_access.kind_for)
            kinds = hr_access.ALIASES.get(kind.key, (kind.key,))
            may[kind.key] = (not hr.is_md) and any(approvals.get(k, False) for k in kinds)
    return out, may


def _stats_and_waiting(
    kinds: list[Kind], request: Request, month_start: datetime, span: DaySpan | None = None
) -> tuple[dict, dict]:
    """The card figures and, per kind, how many requests are waiting (all time, whatever filters the list has). With a
    `span` (the date filter) both are about the requests for those days, and the waiting ones for other days are counted
    apart (outsideWaiting / outsideEarliest)."""
    waiting_by_kind: dict[str, dict] = {}
    totals = {"waitingHr": 0, "waitingHod": 0, "waitingOther": 0, "approvedThisMonth": 0, "rejectedThisMonth": 0}
    oldest = None
    outside = {"count": 0, "earliest": None}
    lookback = _day_start(_shift_month(month_start.date(), -DECISION_LOOKBACK_MONTHS))
    for kind in kinds:
        cfg = approval.get_config(kind.key)
        counts = {"total": 0, "hr": 0, "hod": 0, "other": 0}
        base = _with_related(kind, request)
        waiting_qs = base.filter(status__in=kind.waiting)
        if span is not None:
            in_span = waiting_qs.filter(_day_q(kind, span))
            for obj in waiting_qs.exclude(pk__in=in_span.values("pk")):
                outside["count"] += 1
                day = _day_of(kind, obj)
                if day is not None and (outside["earliest"] is None or day < outside["earliest"]):
                    outside["earliest"] = day
            waiting_qs = in_span
        for obj in waiting_qs:
            queue = _queue(approval.progress(kind.key, obj, cfg)) or "other"
            counts["total"] += 1
            counts[queue] += 1
            if obj.created_at and (oldest is None or obj.created_at < oldest["at"]):
                oldest = {"at": obj.created_at, "kind": kind, "obj": obj}
        waiting_by_kind[kind.key] = counts
        totals["waitingHr"] += counts["hr"]
        totals["waitingHod"] += counts["hod"]
        totals["waitingOther"] += counts["other"]
        if span is not None:
            # the requests for these days that ended approved / rejected (whenever they were decided)
            decided = base.exclude(status__in=kind.waiting).filter(_day_q(kind, span)).order_by()
            rejected = decided.filter(status__in=kind.rejected).count()
            totals["rejectedThisMonth"] += rejected
            totals["approvedThisMonth"] += decided.count() - rejected
            continue
        for obj in base.exclude(status__in=kind.waiting).filter(created_at__gte=lookback):
            parts = BUILDERS[kind.key](obj) if kind.key in BUILDERS else {}
            when = _decision_of(kind, obj, parts)["at"]
            decided_at = _as_datetime(when) or obj.created_at
            if decided_at and decided_at >= month_start:
                totals["rejectedThisMonth" if obj.status in kind.rejected else "approvedThisMonth"] += 1
    totals["waiting"] = totals["waitingHr"] + totals["waitingHod"] + totals["waitingOther"]
    totals["oldestWaiting"] = (
        {
            "kind": oldest["kind"].key,
            "id": oldest["obj"].id,
            "employeeName": _name(oldest["obj"].employee),
            "label": oldest["kind"].label,
            "submittedAt": oldest["at"].isoformat(),
        }
        if oldest
        else None
    )
    if span is not None:
        totals["range"] = span.as_json()
        totals["outsideWaiting"] = outside["count"]
        totals["allWaiting"] = totals["waiting"] + outside["count"]
        totals["outsideEarliest"] = outside["earliest"].isoformat() if outside["earliest"] else None
    return totals, waiting_by_kind


def _as_datetime(value) -> datetime | None:
    if isinstance(value, datetime):
        return value
    try:
        return datetime.fromisoformat(value) if value else None
    except (TypeError, ValueError):
        return None


def _shift_month(day: date, months: int) -> date:
    index = day.year * 12 + day.month - 1 + months
    return date(index // 12, index % 12 + 1, 1)


def _filter_options(request: Request) -> dict:
    """The branches and departments the caller may filter by (their own branch only, for a branch-scoped HR user), so the
    page needs no access to the Branches / Departments modules to fill its filters."""
    from .models import Branch, Department

    branches = scope_to_branch(Branch.objects.all(), request, field="id").order_by("name")
    departments = scope_to_branch(Department.objects.all(), request, field="branch_id").order_by("name")
    return {
        "branches": [{"id": b.id, "name": b.name} for b in branches],
        "departments": [
            {"id": d.id, "name": d.name, "branchId": d.branch_id, "category": d.category} for d in departments
        ],
    }


# ───────────────────────────── the paged list (2026-11-21) ─────────────────────────────

# the employee columns every word of the search may match (the request's own text is Kind.search)
EMPLOYEE_SEARCH = (
    "employee__first_name",
    "employee__last_name",
    "employee__employee_code",
    "employee__department__name",
    "employee__designation__title",
    "employee__branch__name",
)


def _search_q(kind: Kind, words: list[str]) -> Q:
    """Every word must appear in the employee's name / code / department / designation / branch or in the request's own
    text; a word that is part of the kind's name ("leave", "outpass") matches every request of that kind."""
    query = Q()
    label = kind.label.lower()
    for word in words:
        if word in label:
            continue
        any_column = Q()
        for column in EMPLOYEE_SEARCH + kind.search:
            any_column |= Q(**{f"{column}__icontains": word})
        query &= any_column
    return query


@dataclass(frozen=True)
class _Row:
    """What the order of the whole list needs of one request, read without building it."""

    kind: Kind
    id: int
    at: float  # submitted, as a timestamp (0 when unknown)
    waiting: bool
    name: str


def _sorted(rows: list[_Row], sort: str) -> list[_Row]:
    newest = sorted(rows, key=lambda r: (r.at, r.kind.key, r.id), reverse=True)
    if sort == "oldest":
        return newest[::-1]
    if sort == "waiting":
        # waiting requests first, the longest waiting on top; decided ones after, newest first
        return [r for r in newest if r.waiting][::-1] + [r for r in newest if not r.waiting]
    if sort == "employee":
        return sorted(newest, key=lambda r: r.name)  # stable: newest first within one employee
    if sort == "kind":
        return sorted(newest, key=lambda r: r.kind.label.lower())
    return newest


def _matching_rows(kind: Kind, request: Request, params: dict) -> list[_Row]:
    paging = params["paging"]
    qs = _filtered_qs(kind, request, params)
    if paging["words"]:
        qs = qs.filter(_search_q(kind, paging["words"]))
    if paging["request_type"] and kind.key == "request":
        qs = qs.filter(request_type=paging["request_type"])
    keep = None
    queue = {"waiting_hr": "hr", "waiting_hod": "hod"}.get(params["status"])
    if queue:
        # who a request waits for comes from its pipeline, not a column: worked out for the (few) waiting rows only
        cfg = approval.get_config(kind.key)
        keep = {obj.id for obj in qs if (_queue(approval.progress(kind.key, obj, cfg)) or "other") == queue}
    rows = []
    light = qs.values_list("id", "created_at", "status", "employee__first_name", "employee__last_name")
    for pk, created, status, first, last in light:
        if keep is not None and pk not in keep:
            continue
        name = f"{first or ''} {last or ''}".strip().lower()
        rows.append(_Row(kind, pk, created.timestamp() if created else 0.0, status in kind.waiting, name))
    return rows


def _build(pairs: list[tuple[Kind, int]], request: Request, extra: dict) -> list[dict]:
    """The full rows of one page, in the page's order (one query per kind on the page, one for the photos)."""
    ids_by_kind: dict[str, list[int]] = {}
    for kind, pk in pairs:
        ids_by_kind.setdefault(kind.key, []).append(pk)
    objs = {}
    for key, ids in ids_by_kind.items():
        for obj in _with_related(BY_KEY[key], request).filter(pk__in=ids):
            objs[(key, obj.id)] = obj
    photos = photo_links(obj.employee_id for obj in objs.values())
    cfgs: dict[str, approval.Config] = {}
    items = []
    for kind, pk in pairs:
        obj = objs.get((kind.key, pk))
        if obj is not None:
            cfg = cfgs.setdefault(kind.key, approval.get_config(kind.key))
            items.append(_item(kind, obj, cfg, extra, photos))
    return items


def _paged(request: Request, params: dict, wanted: list[Kind], allowed: list[Kind], extra: dict) -> dict:
    paging = params["paging"]
    rows: list[_Row] = []
    matched: dict[str, int] = {}
    for kind in wanted:
        found = _matching_rows(kind, request, params)
        matched[kind.key] = len(found)
        rows.extend(found)
    rows = _sorted(rows, paging["sort"])
    total = len(rows)
    size = paging["size"]
    pages = max(1, -(-total // size))
    page = min(paging["page"], pages)
    chunk = rows[(page - 1) * size : page * size]
    items = _build([(r.kind, r.id) for r in chunk], request, extra)
    focus_item = None
    if paging["focus"]:
        key, pk = paging["focus"]
        if any(k.key == key for k in allowed):
            found = _build([(BY_KEY[key], pk)], request, extra)
            focus_item = found[0] if found else None
    return {
        "items": items,
        "matched": matched,
        "page": page,
        "pageSize": size,
        "total": total,
        "pages": pages,
        "focusItem": focus_item,
    }


def _permission_row_builder():
    """The permission list's own serializer (with the monthly-cap lookups it needs), shared across the rows of one call."""
    from .leave_views import _CapStatusCache, _permission_json
    from .models import PayrollSettings

    settings = PayrollSettings.get()
    cap_cache = _CapStatusCache(settings.permission_monthly_cap)
    cfg = approval.get_config("permission")
    return lambda p: _permission_json(p, settings=settings, cap_cache=cap_cache, cfg=cfg)


@api_view(["GET"])
@require_hr
def hr_requests(request: Request) -> Response:
    params, error = _parse_params(request)
    if error:
        return Response({"error": error}, status=400)

    access, may_approve = _access_by_kind(request)
    allowed = [k for k in KINDS if k.key in access]
    month_start = _day_start(ist_today().replace(day=1))
    totals, waiting_by_kind = _stats_and_waiting(allowed, request, month_start, params["span"])

    wanted = [k for k in allowed if not params["kinds"] or k.key in params["kinds"]]
    extra = {"permission": _permission_row_builder()}
    paged = _paged(request, params, wanted, allowed, extra) if params["paging"] else None
    items: list[dict] = []
    matched: dict[str, int] = {}
    if paged:
        items, matched = paged["items"], paged["matched"]
    else:
        listed: list[tuple[Kind, list]] = []
        for kind in wanted:
            qs = _filtered_qs(kind, request, params)
            matched[kind.key] = qs.count()
            listed.append((kind, list(qs[: params["limit"]])))
        photos = photo_links(obj.employee_id for _kind, rows in listed for obj in rows)
        for kind, rows in listed:
            cfg = approval.get_config(kind.key)
            items.extend(_item(kind, obj, cfg, extra, photos) for obj in rows)
        items.sort(key=lambda i: (i["submittedAt"] or "", i["id"]), reverse=True)

    kinds_json = []
    from .settlement_automation.service import is_automation

    # Settlement Automation Method (2026-11-26): advances are decided in the month's settlement workflow, so the hub only
    # links to it (no Approve / Reject here; PUT /api/advances refuses them anyway)
    advances_by_workflow = is_automation()
    for kind in allowed:
        defn = approval.definition(kind.key)
        cfg = approval.get_config(kind.key)
        waiting = waiting_by_kind[kind.key]
        by_workflow = advances_by_workflow and kind.key == "advance"
        kinds_json.append(
            {
                "key": kind.key,
                "label": kind.label,
                "group": defn.group,
                "access": access[kind.key],
                # added 2026-11-10: whether this account may approve / reject this kind (apart from its access level)
                "canApprove": False if by_workflow else may_approve.get(kind.key, False),
                "mode": "link" if by_workflow else kind.mode,
                "openPath": "/hr/Loan&Advance" if by_workflow else kind.open_path,
                "openLabel": "Open the Loan & Advance workflow" if by_workflow else kind.open_label,
                "pipeline": approval.pipeline_text(defn.requested_by, cfg.steps),
                "enabled": cfg.enabled,
                "waiting": waiting["total"],
                "waitingHr": waiting["hr"],
                "waitingHod": waiting["hod"],
                "matched": matched.get(kind.key),
                # a paged list is never cut short: every matching request is on one of its pages
                "truncated": not paged and matched.get(kind.key, 0) > params["limit"],
            }
        )
    body = {
        "kinds": kinds_json,
        "stats": totals,
        "items": items,
        "limit": paged["pageSize"] if paged else params["limit"],
        "options": _filter_options(request),
    }
    if paged:
        body.update({k: paged[k] for k in ("page", "pageSize", "total", "pages", "focusItem")})
    return Response(body)

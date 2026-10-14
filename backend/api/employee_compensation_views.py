"""
What the employee apps (mobile app, Employee Web App) show about compensation, and who the employee's Department Head is.

    GET /api/employee/compensation    the employee's compensation page
    GET /api/employee/hod             the employee's assigned Department Head and what that HOD can approve

Both answer ONLY about the signed-in employee (employee token; an HR token is refused: there is no "view as"). Both are
read-only.

Compensation is for STAFF only: a production employee gets the same answer shape with every switch off and nothing
listed (`isStaff: false`). The Department Head card is for everybody, production included.

/api/employee/compensation
    { isStaff, enabled: {master, allowance, shift, relaxation, pay, windows, holidayWork, birthday, any},
      balanceShifts,                      the compensation balance in shifts (HOD-approved holiday-work credits and legacy
                                          credits, less what HR redeemed)
      items: [...],                       newest first, see ITEM below
      todayAllowance, tomorrowAllowance,  the next-day late-in allowance that applies today / on the next working day, or null
      askHr: {title, text, points, contact}  the "Ask Request for Compensation" tab: contact is Settings -> HR Contact }

  ITEM: { key, kind, group, date, title, detail, status, statusLabel, shifts, minutes, minutesUsed, used, legacy? }
    kind  ot_allowance | ot_shift (detected, HR has not assigned it) | ot_shift_relaxation | ot_shift_pay | holiday_work |
          redemption | window_late_in | window_early_out | birthday
    group detected (the system found it) | assigned (HR gave it) | company (announced for everybody) | birthday | balance

  What is shown: the employee's own OT records, holiday-work claims and balance redemptions of the last HISTORY_DAYS days;
  the announced windows that cover them (from WINDOW_PAST_DAYS ago, and every upcoming one) while the Windows switch is on;
  and their birthday leave (this year's, and next year's once this year's has passed) while the Birthday switch is on.
  A feature switched off hides its own virtual items (windows, birthday) but never the records that already exist.
"""

from __future__ import annotations

import logging
from datetime import date, datetime, timedelta
from decimal import Decimal
from typing import Callable

from django.db.models import Q
from rest_framework.decorators import api_view
from rest_framework.request import Request
from rest_framework.response import Response

from . import approval_workflow as approval
from .auth import get_token_employee_id, require_auth
from .clock import ist_today
from .compensation_apply import balance_of
from .compensation_shared import (
    birthday_employee_problem,
    birthday_in_year,
    birthday_verdict,
    date_text,
    day_kind,
    full_name,
    holiday_names,
    hr_contact,
    shifts_text,
    switches,
)
from .hod_scope import effective_manager
from .overtime import next_working_day, refresh_employee_overtime
from .models import (
    AttendanceDayRecord,
    CompensationConfig,
    CompensationDayAnnouncement,
    CompensationLedger,
    DepartmentManager,
    Employee,
    EmployeeShiftAssignment,
    HolidayWorkClaim,
    OvertimeRecord,
)

logger = logging.getLogger(__name__)

HISTORY_DAYS = 90
WINDOW_PAST_DAYS = 30
WINDOW_AHEAD_DAYS = 90
ALLOWANCE_LOOKBACK_DAYS = 10
WORKED_STATUSES = (AttendanceDayRecord.STATUS_PRESENT, AttendanceDayRecord.STATUS_HALF)
ASSIGNED_STATUSES = ("announced", "assigned")

STATUS_LABELS = {
    "detected": "Detected: ask HR to claim it",
    "assigned": "Assigned by HR",
    "applied": "Applied",
    "scheduled": "Scheduled",
    "not_applied": "Not applied",
    "used": "Used",
    "not_used": "Not used",
    "pending": "Waiting",
    "pending_hod": "Waiting for your Department Head",
    "approved": "Approved",
    "rejected": "Not approved",
    "taken": "Taken",
    "upcoming": "Upcoming",
    "today": "Today",
    "available": "Available",
    "not_applicable": "Not applicable",
    "paid": "Paid",
    "auto": "Automatic",
}

ASK_HR_TITLE = "Ask Request for Compensation"

# The approvals a Department Head can give, in the order the card lists them. Compensation and casual leave are staff only.
APPROVAL_ORDER = (
    "leave",
    "permission",
    "casual_leave",
    "missing_punch",
    "on_duty",
    "attendance_correction",
    "resignation",
    "outpass",
    "holiday_work",
)
STAFF_ONLY_APPROVALS = ("casual_leave", "holiday_work")


def _hhmm(value) -> str | None:
    return value.strftime("%H:%M") if value else None


def _stop(text: str | None) -> str:
    """A sentence that ends properly: 'Not on site' -> 'Not on site.' (empty stays empty)."""
    text = (text or "").strip()
    return text if not text or text[-1] in ".!?" else text + "."


def _iso(value) -> str | None:
    return value.isoformat() if value else None


def _employee_only(request: Request):
    """(employee, None) for an employee token, else (None, the refusal)."""
    emp_id = get_token_employee_id(request)
    if not emp_id:
        return None, Response({"error": "Please sign in as an employee to see this."}, status=403)
    emp = Employee.objects.select_related("department", "designation", "branch").filter(pk=emp_id).first()
    if emp is None:
        return None, Response({"error": "Employee not found"}, status=404)
    return emp, None


def _item(key, kind, group, day, title, detail, status, **extra) -> dict:
    out = {
        "key": key,
        "kind": kind,
        "group": group,
        "date": _iso(day),
        "title": title,
        "detail": detail,
        "status": status,
        "statusLabel": STATUS_LABELS.get(status, status),
        "shifts": None,
        "minutes": None,
        "minutesUsed": None,
        "used": None,
    }
    out.update(extra)
    return out


# ─────────────────────────── the balance ───────────────────────────


def balance_shifts(emp) -> Decimal:
    """The compensation balance in shifts, by the engine's own definition (compensation_apply.balance_of): ledger credits
    (approved holiday-work claims) less redemptions, plus the legacy Alternative Day credits still available."""
    return balance_of(emp).quantize(Decimal("0.01"))


# ─────────────────────────── working days ───────────────────────────


def _on_time_until(emp, applies_on: date, minutes: int, assignments=None) -> str | None:
    """The latest arrival that is still on time on `applies_on`: shift start + the allowance + the shift's own grace.
    `assignments` = the employee's shift assignments, read once by the caller (no query per record)."""
    from .shift_engine import _get_shift_for_date

    shift = _get_shift_for_date(emp, applies_on, assignments=assignments)
    if shift is None or not shift.start_time:
        return None
    start = datetime.combine(applies_on, shift.start_time) + timedelta(
        minutes=minutes + int(shift.grace_period_minutes or 0)
    )
    return start.strftime("%H:%M")


# ─────────────────────────── the items ───────────────────────────


def _ot_items(emp, today: date, cfg: CompensationConfig, master: bool, assignments: list):
    """(items, todayAllowance, tomorrowAllowance) from the employee's OT records. `master` = the master switch and
    `assignments` = the employee's shift assignments, both read once by the caller."""
    since = today - timedelta(days=HISTORY_DAYS)
    records = list(OvertimeRecord.objects.filter(employee=emp, date__gte=since).order_by("-date"))
    allowance = [r for r in records if r.ot_type == OvertimeRecord.OT_TYPE_ALLOWANCE]
    markers: list = []
    worked: list = []
    if allowance:
        oldest = min(r.date for r in allowance)
        markers = list(
            # the allowance minutes are stored whichever marker won the day (a company window or a relaxation on the same
            # day shows ITS kind), so "used" is read from the minutes as well as from the allowance's own kind
            AttendanceDayRecord.objects.filter(
                Q(compensation_kind="ot_allowance") | Q(compensation_minutes__gt=0), employee=emp, date__gt=oldest
            ).order_by("date")
        )
        worked = list(
            AttendanceDayRecord.objects.filter(
                employee=emp, status__in=WORKED_STATUSES, date__gt=oldest, date__lte=today
            ).values_list("date", flat=True)
        )
    ot_dates = sorted(r.date for r in allowance)
    claim_dates = {
        r.claim_date
        for r in records
        if r.claim_date and r.status in ASSIGNED_STATUSES and r.compensation_type == OvertimeRecord.TYPE_RELAXATION
    }
    relaxed_days = (
        set(
            AttendanceDayRecord.objects.filter(
                employee=emp, compensation_kind="relaxation", date__in=claim_dates
            ).values_list("date", flat=True)
        )
        if claim_dates
        else set()
    )
    items: list[dict] = []
    for r in records:
        extra_minutes = r.ot_minutes
        worked_until = _hhmm(r.last_punch_out)
        if r.ot_type == OvertimeRecord.OT_TYPE_ALLOWANCE:
            later = [d for d in ot_dates if d > r.date]
            window_end = min([r.date + timedelta(days=ALLOWANCE_LOOKBACK_DAYS), *later[:1]])
            used = next((m for m in markers if r.date < m.date <= window_end), None)
            if used is not None:
                status = "used"
            elif any(r.date < d <= window_end for d in worked):
                status = "not_used"
            else:
                status = "pending"
            detail = (
                f"You worked until {worked_until} ({extra_minutes} minutes past your shift end). You can arrive up to "
                f"{r.allowance_minutes} minutes later on your next working day without being marked late. This is "
                "automatic: there is nothing to claim."
            )
            if used is not None:
                detail = used.compensation_note or detail
            items.append(
                _item(
                    f"ot-{r.id}",
                    "ot_allowance",
                    "detected",
                    r.date,
                    f"Late-in allowance earned: {r.allowance_minutes} minutes",
                    detail,
                    status,
                    minutes=r.allowance_minutes,
                    minutesUsed=used.compensation_minutes if used else None,
                    used=used is not None,
                )
            )
        elif r.status in ASSIGNED_STATUSES:
            legacy = r.ot_type == OvertimeRecord.OT_TYPE_LEGACY
            shifts = r.shifts if r.shifts is not None else (Decimal("1.00") if legacy else None)
            relaxation = r.compensation_type == OvertimeRecord.TYPE_RELAXATION
            kind = "ot_shift_relaxation" if relaxation else "ot_shift_pay"
            when = r.claim_date
            if relaxation:
                if when is None:
                    status = "assigned"
                elif when in relaxed_days:
                    status = "applied"  # the day carries the relaxation marker
                elif when >= today:
                    status = "scheduled"
                else:
                    status = "not_applied"
                title = (
                    f"Compensation day assigned by HR: {shifts_text(shifts)} shift" if shifts else "Compensation day"
                )
                detail = f"You worked until {worked_until} ({extra_minutes} minutes past your shift end)."
                if when:
                    detail += f" HR granted the relaxation for {date_text(when)}."
            else:
                status = "assigned"
                title = f"Overtime pay assigned by HR: {shifts_text(shifts)} shift" if shifts else "Overtime pay"
                detail = (
                    f"You worked until {worked_until} ({extra_minutes} minutes past your shift end). It is paid as part "
                    "of your salary for that month."
                )
            items.append(
                _item(
                    f"ot-{r.id}",
                    kind,
                    "assigned",
                    when or r.date,
                    title,
                    detail,
                    status,
                    shifts=float(shifts) if shifts is not None else None,
                    minutes=extra_minutes,
                    legacy=legacy,
                    workDate=_iso(r.date),
                )
            )
        elif r.status == OvertimeRecord.STATUS_DETECTED:
            suggested = r.suggested_shifts
            items.append(
                _item(
                    f"ot-{r.id}",
                    "ot_shift",
                    "detected",
                    r.date,
                    "Extra hours detected: ask HR for compensation",
                    (
                        f"You worked until {worked_until} ({extra_minutes} minutes past your shift end)"
                        + (f", which can earn up to {shifts_text(suggested)} shift" if suggested else "")
                        + ". Shift compensation is given by HR, not automatically: contact HR to request it."
                    ),
                    "detected",
                    shifts=float(suggested) if suggested is not None else None,
                    minutes=extra_minutes,
                )
            )
        # a rejected record is HR's decision that it is not compensable: it is not listed

    # the next-day allowance that applies today / on the next working day
    today_allowance = tomorrow_allowance = None
    if master and cfg.allowance_enabled:
        tomorrow_on = next_working_day(emp, today, assignments)
        for r in allowance:
            # an allowance only applies on the next working day, so only a recent OT day can still be pending
            if not r.allowance_minutes or r.date < today - timedelta(days=ALLOWANCE_LOOKBACK_DAYS):
                continue
            applies_on = next_working_day(emp, r.date, assignments)
            if applies_on is None or (cfg.allowance_effective_from and applies_on < cfg.allowance_effective_from):
                continue
            block = {
                "date": applies_on.isoformat(),
                "minutes": r.allowance_minutes,
                "workDate": r.date.isoformat(),
                "onTimeUntil": _on_time_until(emp, applies_on, r.allowance_minutes, assignments),
                "note": (
                    f"You worked late on {date_text(r.date)}: you can arrive up to {r.allowance_minutes} minutes "
                    "later without being marked late."
                ),
            }
            if applies_on == today and today_allowance is None:
                today_allowance = block
            elif applies_on == tomorrow_on and applies_on > today and tomorrow_allowance is None:
                tomorrow_allowance = block
    return items, today_allowance, tomorrow_allowance


def _claim_items(emp, today: date, holidays: dict):
    since = today - timedelta(days=HISTORY_DAYS)
    items = []
    for c in HolidayWorkClaim.objects.filter(employee=emp, work_date__gte=since).order_by("-work_date", "-id"):
        kind = day_kind(c.work_date, holidays) or ("sunday" if c.work_date.weekday() == 6 else "holiday")
        what = "Sunday" if kind == "sunday" else "Holiday"
        status = {"pending": "pending_hod"}.get(c.status, c.status)
        if c.status == HolidayWorkClaim.STATUS_APPROVED:
            detail = f"Approved by {c.reviewed_by or 'your Department Head'}: {shifts_text(c.shifts)} shift was added to your compensation balance."
        elif c.status == HolidayWorkClaim.STATUS_REJECTED:
            detail = f"Not approved by {c.reviewed_by or 'your Department Head'}." + (
                f" {_stop(c.review_comment)}" if c.review_comment else ""
            )
        else:
            detail = "HR raised this claim. It is waiting for your Department Head to approve it."
        if c.reason:
            detail += f" Reason: {_stop(c.reason)}"
        items.append(
            _item(
                f"hw-{c.id}",
                "holiday_work",
                "assigned",
                c.work_date,
                f"{what} work: {shifts_text(c.shifts)} shift",
                detail,
                status,
                shifts=float(c.shifts),
                workDate=_iso(c.work_date),
            )
        )
    return items


def _redemption_items(emp, today: date):
    since = today - timedelta(days=HISTORY_DAYS)
    return [
        _item(
            f"rd-{e.id}",
            "redemption",
            "balance",
            e.date,
            f"Compensation day taken: {shifts_text(e.shifts)} shift",
            e.note or f"HR used {shifts_text(e.shifts)} shift of your compensation balance for {date_text(e.date)}.",
            "taken",
            shifts=float(e.shifts),
        )
        for e in CompensationLedger.objects.filter(
            employee=emp, entry_type=CompensationLedger.ENTRY_DEBIT, date__gte=since
        ).order_by("-date", "-id")
    ]


def _covers(ann: CompensationDayAnnouncement, emp) -> bool:
    listed = {e.id for e in ann.employees.all()}
    if listed:
        return emp.id in listed
    if ann.branch_id and ann.branch_id != emp.branch_id:
        return False
    if ann.department_id and ann.department_id != emp.department_id:
        return False
    return True


def _window_items(emp, today: date):
    anns = [
        a
        for a in CompensationDayAnnouncement.objects.filter(
            kind__in=(CompensationDayAnnouncement.KIND_LATE_IN, CompensationDayAnnouncement.KIND_EARLY_OUT),
            date__gte=today - timedelta(days=WINDOW_PAST_DAYS),
            date__lte=today + timedelta(days=WINDOW_AHEAD_DAYS),
        )
        .prefetch_related("employees")
        .order_by("-date", "-id")
        if _covers(a, emp)
    ]
    if not anns:
        return []
    marked = {
        (r.date, r.compensation_kind)
        for r in AttendanceDayRecord.objects.filter(
            employee=emp,
            date__in={a.date for a in anns},
            compensation_kind__in=("window_late_in", "window_early_out"),
        )
    }
    items = []
    for a in anns:
        at = _hhmm(a.allowed_time or a.leave_until_time)
        late_in = a.kind == CompensationDayAnnouncement.KIND_LATE_IN
        kind = "window_late_in" if late_in else "window_early_out"
        used = (a.date, kind) in marked
        if a.date > today:
            status = "upcoming"
        elif a.date == today:
            status = "used" if used else "today"
        else:
            status = "used" if used else "not_used"
        title = f"Company late-in window: arrive by {at}" if late_in else f"Company early-out window: leave from {at}"
        detail = (
            f"On {date_text(a.date)} everyone may "
            + (f"arrive up to {at}" if late_in else f"leave from {at}")
            + ": your own shift time and grace do not apply for that edge."
        )
        if a.reason:
            detail += f" Reason: {_stop(a.reason)}"
        items.append(_item(f"win-{a.id}", kind, "company", a.date, title, detail, status, used=used or None, time=at))
    return items


def _birthday_items(
    emp, today: date, holidays_for: Callable[[date], dict], cfg: CompensationConfig, master: bool, assignments: list
):
    if emp.date_of_birth is None:
        return []
    this_year = birthday_in_year(emp.date_of_birth, today.year)
    days = [this_year]
    if this_year < today:
        days.append(birthday_in_year(emp.date_of_birth, today.year + 1))
    records = {
        r.date: r for r in AttendanceDayRecord.objects.filter(employee=emp, date__in=days, compensation_kind="birthday")
    }
    items = []
    for day in days:
        benefits, why = birthday_verdict(day, master, cfg, holidays_for(day))
        if benefits:
            saturday_off = False
            if day.weekday() == 5:
                from .shift_engine import _get_assignment_for_date

                assignment = _get_assignment_for_date(emp, day, assignments=assignments)
                saturday_off = bool(assignment and assignment.saturday_off)
            why = birthday_employee_problem(emp, day, saturday_off)
            benefits = not why
        applied = day in records
        if applied:
            status = "applied"
            detail = "Paid birthday leave: present for the whole day, with no late or early marks."
        elif not benefits:
            status = "not_applicable"
            detail = why
        elif day >= today:
            status = "today" if day == today else "upcoming"
            detail = "You get paid birthday leave on your birthday: whether you come to work or not, no attendance rule applies that day."
        else:
            status = "not_applied"
            detail = "This day was not marked as birthday leave. Contact HR if you think it should have been."
        items.append(
            _item(
                f"bd-{day.isoformat()}",
                "birthday",
                "birthday",
                day,
                "Birthday leave (paid)",
                detail,
                status,
                shifts=1.0 if applied else None,
            )
        )
    return items


# ─────────────────────────── ask HR ───────────────────────────


def _ask_hr(flags: dict) -> dict:
    points = []
    if flags["allowance"]:
        points.append(
            "Working a little past your shift end earns a late-in allowance for your next working day. It is automatic: "
            "you do not need to ask for it."
        )
    if flags["shift"]:
        points.append(
            "Working much longer past your shift end can earn shift compensation (0.25 to 1 shift). HR gives it, it is "
            "not automatic: contact HR to request it."
        )
    if flags["holidayWork"]:
        points.append(
            "If you worked on a Sunday or a company holiday, contact HR to claim compensation for it. HR raises the "
            "claim and your Department Head approves it before it is added to your compensation balance."
        )
    if flags["windows"]:
        points.append(
            "When the company announces a late-in or early-out time for a day, it appears here for everybody."
        )
    if flags["birthday"]:
        points.append("You get paid leave on your birthday automatically.")
    if not points:
        points.append("Compensation is not switched on yet. Contact HR for any question.")
    text = (
        "The system detects when you work extra hours or work on a Sunday or a company holiday, and shows it here. "
        "If you worked extra and it is missing from the list, or you want to claim compensation, contact HR."
    )
    return {"title": ASK_HR_TITLE, "text": text, "points": points, "contact": hr_contact()}


def _disabled_payload(message: str) -> dict:
    off = {
        key: False
        for key in ("master", "allowance", "shift", "relaxation", "pay", "windows", "holidayWork", "birthday", "any")
    }
    return {
        "isStaff": False,
        "enabled": off,
        "balanceShifts": 0.0,
        "items": [],
        "todayAllowance": None,
        "tomorrowAllowance": None,
        "askHr": None,
        "message": message,
    }


@api_view(["GET"])
@require_auth
def employee_compensation(request: Request) -> Response:
    emp, refusal = _employee_only(request)
    if refusal is not None:
        return refusal
    if emp.employment_type != "staff":
        return Response(_disabled_payload("Compensation is for staff employees only."))

    today = ist_today()
    # The employee's own OT rows must exist without anybody opening HR's OT page: re-derive their recent stored days if
    # their punches are newer, then create / update their rows (never anybody else's, never a decided row, nothing
    # pruned). Best effort: a failure here must never take the page down.
    try:
        refresh_employee_overtime(emp, today)
    except Exception:
        logger.exception("Refreshing the OT rows of employee %s failed", emp.pk)
    flags = switches()
    cfg = CompensationConfig.get()
    assignments = list(EmployeeShiftAssignment.objects.filter(employee=emp).select_related("shift"))
    holiday_cache: dict = {}
    holidays = holiday_names(today - timedelta(days=HISTORY_DAYS), today + timedelta(days=30))

    def holidays_for(day: date) -> dict:
        if day not in holiday_cache:
            holiday_cache[day] = holiday_names(day, day)
        return holiday_cache[day]

    items, today_allowance, tomorrow_allowance = _ot_items(emp, today, cfg, flags["master"], assignments)
    items += _claim_items(emp, today, holidays)
    items += _redemption_items(emp, today)
    if flags["windows"]:
        items += _window_items(emp, today)
    if flags["birthday"]:
        items += _birthday_items(emp, today, holidays_for, cfg, flags["master"], assignments)
    items.sort(key=lambda i: (i["date"] or "", i["key"]), reverse=True)
    return Response(
        {
            "isStaff": True,
            "enabled": flags,
            "balanceShifts": float(balance_shifts(emp)),
            "items": items,
            "todayAllowance": today_allowance,
            "tomorrowAllowance": tomorrow_allowance,
            "askHr": _ask_hr(flags),
            "message": None,
        }
    )


# ─────────────────────────── the Department Head ───────────────────────────


def _approvals_json(manager: DepartmentManager, emp) -> list[dict]:
    cfgs = approval.all_configs()
    holiday_work_on = switches()["holidayWork"]
    out = []
    for key in APPROVAL_ORDER:
        defn = approval.definition(key)
        if key in STAFF_ONLY_APPROVALS and emp.employment_type != "staff":
            continue
        cfg = cfgs[key]
        if not cfg.enabled:
            can, why = False, "Switched off by HR."
        elif not approval.role_takes_part(key, approval.HOD, cfg):
            can, why = False, "HR decides this one."
        elif defn.hod_flag and not getattr(manager, defn.hod_flag, False):
            can, why = False, "Not enabled for your Department Head."
        elif key == "holiday_work" and not holiday_work_on:
            can, why = False, "Holiday / Sunday work compensation is switched off."
        else:
            can, why = True, ""
        out.append(
            {
                "key": key,
                "label": defn.label,
                "canApprove": can,
                "reason": why or None,
                "requestedBy": defn.requested_by,
                "path": approval.pipeline_text(defn.requested_by, cfg.steps),
            }
        )
    return out


@api_view(["GET"])
@require_auth
def employee_hod(request: Request) -> Response:
    emp, refusal = _employee_only(request)
    if refusal is not None:
        return refusal
    contact = hr_contact()
    base = {
        "assigned": False,
        "name": None,
        "phone": None,
        "photoUrl": None,
        "designation": None,
        "department": None,
        "branch": None,
        "email": None,
        "approvals": [],
        "hrContact": contact,
        "contactNote": "For any question about approvals, contact HR.",
    }
    found = effective_manager(emp)
    if found is None:
        return Response(
            {
                **base,
                "message": "You do not have a Department Head assigned yet. Please contact HR to have one assigned.",
            }
        )
    if found.employee_id == emp.id:
        return Response(
            {**base, "isSelf": True, "message": "You are a Department Head yourself, so HR decides your own requests."}
        )
    manager = DepartmentManager.objects.select_related(
        "employee__department", "employee__designation", "employee__branch"
    ).get(pk=found.pk)
    boss = manager.employee
    return Response(
        {
            **base,
            "assigned": True,
            "employeeId": boss.id,
            "employeeCode": boss.employee_code,
            "name": full_name(boss),
            "phone": boss.phone,
            "photoUrl": boss.photo_url,
            "designation": boss.designation.title if boss.designation_id and boss.designation else None,
            "department": boss.department.name if boss.department_id and boss.department else None,
            "branch": boss.branch.name if boss.branch_id and boss.branch else None,
            "email": boss.email,
            "approvals": _approvals_json(manager, emp),
            "message": None,
        }
    )

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
      todayAllowance, tomorrowAllowance,  the next-day late-in allowance that applies today / on the next working day, or
                                          null: see ALLOWANCE below
      askHr: {title, text, points, contact}  the "Ask Request for Compensation" tab, see ASK HR below (null for production)
      message }                           null for staff; for a production employee the sentence saying why nothing is listed

  ITEM: { key, kind, group, date, title, detail, status, statusLabel, shifts, minutes, minutesUsed, used,
          workDate?, time?, legacy? }
    kind  ot_allowance | ot_shift (detected, HR has not assigned it) | ot_shift_relaxation | ot_shift_pay | holiday_work |
          redemption | window_late_in | window_early_out | birthday
    group detected (the system found it) | assigned (HR gave it) | company (announced for everybody) | birthday | balance
    date  the day the item is about: the OT day, the claim date HR granted (assigned OT with one), the day worked (a
          holiday-work claim), the day HR used the balance (a redemption), the window's day, the birthday
    workDate  'YYYY-MM-DD', ONLY on ot_shift_relaxation, ot_shift_pay and holiday_work: the day the work was done (for the
          assigned OT kinds `date` may be the later day HR granted the relaxation / pay for, so the two can differ)
    time  'HH:MM', ONLY on window_late_in / window_early_out: the announced arrive-by / leave-from time
    legacy  ONLY on ot_shift_relaxation / ot_shift_pay: true for a record from before the OT overhaul (it counts one shift)
    shifts  null where no shift amount applies. A paid birthday never touches the balance, so it carries none; a late-in
          allowance and a window carry none either
    status  detected | assigned | applied | scheduled | not_applied | used | not_used | available | pending | pending_hod |
          approved | rejected | taken | upcoming | today | not_applicable. statusLabel is the sentence to print.
          ot_allowance: used (a day carries its marker) | not_used (a worked day in its window did not need it, or the window
          has passed) | available (nothing has used it yet and its window is still open). holiday_work: pending_hod while it
          waits for the Department Head, approved, rejected; when NOBODY can decide a waiting claim (the employee has no
          Department Head, is the head themselves, or their head may not approve compensation) the status stays pending_hod
          (both apps tone it as "needs attention") but statusLabel and detail say so and point to HR.
    redemption  the detail is always built from the formatted date ("HR used 0.25 shift of your compensation balance for
          Monday 12 Oct 2026."): HR's own ledger note (which holds an internal credit id and a raw ISO date) is never shown.

  ALLOWANCE (todayAllowance / tomorrowAllowance): { date, minutes, workDate, onTimeUntil, note }
    date         the day the allowance applies on. tomorrowAllowance is the NEXT WORKING DAY of the employee's shift, not
                 always the next calendar day (a Friday's OT with a Saturday-off shift gives the Monday)
    minutes      the minutes the employee may arrive later
    workDate     the OT day that earned it
    onTimeUntil  'HH:MM', the latest arrival that is still on time that day (shift start + the allowance + the shift's own
                 grace); null when the employee has no shift assigned
    note         the sentence to print

  ASK HR: askHr.contact is Settings -> HR Contact: { label, phone, phoneDial, whatsapp, whatsappNumber, email, hours,
    hasContact, usesHrFallback }. `label` falls back to "HR Department", `phoneDial` is what a tel: link should dial,
    `whatsappNumber` the international digits a wa.me link needs, `hasContact` is false until HR entered any way to reach
    them, `usesHrFallback` is always false here (it is true only for the support block of /api/support-contact).

  What is shown: the employee's own OT records, holiday-work claims and balance redemptions of the last HISTORY_DAYS days;
  the announced windows that cover them (from WINDOW_PAST_DAYS ago, and every upcoming one) while the Windows switch is on;
  and their birthday leave (this year's, and next year's once this year's has passed) while the Birthday switch is on.
  A feature switched off hides its own virtual items (windows, birthday) but never the records that already exist.

  CLAIMS (2026-11-19, additive): the employee claims compensation themselves (POST /api/employee/compensation/claims, see
  compensation_claims_views.py) and their Department Head decides. Every item also carries
    claimable        true when the employee can claim it now (Claim button)
    claimKind        the claim kind it is claimed as (holiday_work | ot_allowance | ot_shift | birthday), null when nothing
                     can ever be claimed for it
    claim            the claim made for it: {id, kind, kindLabel, status, statusLabel, shifts, minutes, raisedByRole,
                     requestedBy, reviewedBy, reviewComment, createdAt, workDate, useDate, overtime, canWithdraw} | null
    claimMessage     why it cannot be claimed (no Department Head who may approve, ...), null otherwise
    suggestedShifts  the shifts a claim is for (ot_shift: the quarters credit; holiday work / birthday credit: 1.00)
    overtimeRecordId ONLY on OT items: the record the claim names (also the number in the `ot-<id>` key)
  New statuses: claimable | claim_pending | claim_approved | claim_rejected (Type 1 / Type 2 / birthday credit on and after
  CompensationConfig.claims_from; days before it keep the old automatic / ask-HR statuses). New item kinds:
    holiday_work with status claimable (key hwd-<date>): a Sunday / holiday in the last 45 days the employee worked and has
        not claimed yet (a raised claim is the hw-<id> item as before)
    birthday_credit (key bd-<date>): a birthday the employee worked: one 1.00 credit to claim (absent / on leave on it =
        paid birthday leave, the `birthday` item)
    use_balance (key hw-<id>): a request to use the balance that is waiting or was not approved (an approved one is the
        `redemption` item of its debit, with `claim` set)
  todayAllowance / tomorrowAllowance: on and after claims_from only an allowance whose claim the Department Head APPROVED.
  Top level adds canClaim, claimWindowDays (45) and useBalance {allowed, balanceShifts, pendingShifts, availableShifts,
  message}. A notification about a claim opens hw-<claim id>: match it against `claim.id` of an item.

  dayKind: the HR/manager claim lists (holidayWorkClaims) say dayKind 'sunday' | 'holiday' (a declared holiday on a Sunday is
  'holiday'); the attendance day records (/attendance/employee/<id>, employee-shift-stats dailyLogs) say 'holiday' |
  'weekly_off' | null. A Sunday is 'sunday' on a claim and 'weekly_off' on an attendance day: never share one mapping.

/api/employee/hod
    { assigned, name, phone, photoUrl, designation, department, branch, email, approvals, hrContact, contactNote, message,
      employeeId?, employeeCode?, isSelf? }
    assigned     false (with `message`, empty `approvals`) when the employee has no active Department Head
    isSelf       ONLY present, and true, when the employee is a Department Head whose own department is their head. They get
                 no head card; the message says that a head never approves their own requests, that who decides them
                 depends on the approval path HR set for each kind, and that a request only a Department Head can decide
                 (holiday-work compensation) needs another head
    employeeId, employeeCode  ONLY when assigned: the head's own employee id / code
    photoUrl     the head's photo: an external link / path as stored, or for an embedded data: image its signed absolute
                 link (employee_photo.py), which loads with no token; never the picture itself (it can be MBs)
    approvals    [{ key, label, canApprove, reason, requestedBy, path }] in APPROVAL_ORDER. `reason` explains a false
                 `canApprove`. holiday_work with the compensation / holiday-work switch OFF is canApprove TRUE with a reason
                 saying that no new claims are raised but waiting ones can still be decided: the manager endpoints never
                 look at that switch for a claim that already exists. (The apps print `reason` only for a false canApprove.)
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
from . import compensation_claims as claims_mod
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
from .employee_photo import photo_link
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
    # the claim workflow (2026-11-19)
    "claimable": "Ready to claim",
    "claim_pending": "Claimed: waiting for your Department Head",
    "claim_approved": "Approved",
    "claim_rejected": "Not approved",
}
CLAIM_STATUS = {"pending": "claim_pending", "approved": "claim_approved", "rejected": "claim_rejected"}

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

HOLIDAY_WORK_OFF_REASON = (
    "Holiday / Sunday work compensation is switched off, so neither you nor HR can raise new claims for it. "
    "Claims that are already waiting can still be decided."
)
SELF_HEAD_MESSAGE = (
    "You are a Department Head yourself, so you never approve your own requests. Who decides them depends on the "
    "approval path HR set for each kind of request: ask HR if one of yours is waiting. A request that only a Department "
    "Head can decide (such as Holiday / Sunday work compensation) needs another Department Head, so ask HR to assign "
    "you one."
)


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


def claim_brief(c: HolidayWorkClaim | None) -> dict | None:
    """The `claim` block of an item (and what the employee's claims list shows of a claim, in short)."""
    if c is None:
        return None
    pending = c.status == HolidayWorkClaim.STATUS_PENDING
    return {
        "id": c.id,
        "kind": c.kind,
        "kindLabel": claims_mod.KIND_LABELS.get(c.kind, c.kind),
        "status": c.status,
        "statusLabel": claims_mod.status_label(c),
        "shifts": float(c.shifts),
        "minutes": c.minutes,
        "raisedByRole": c.raised_by_role,
        "requestedBy": c.requested_by,
        "reviewedBy": c.reviewed_by,
        "reviewComment": c.review_comment,
        "createdAt": _iso(c.created_at),
        "workDate": _iso(c.work_date),
        "useDate": _iso(c.work_date) if c.kind == HolidayWorkClaim.KIND_USE_BALANCE else None,
        "overtime": claims_mod.overtime_json(c.overtime_record) if c.overtime_record_id else None,
        "canWithdraw": pending and c.raised_by_role == HolidayWorkClaim.RAISED_BY_EMPLOYEE,
    }


def _claim_fields(kind: str | None, *, claimable=False, claim=None, message=None, suggested=None) -> dict:
    """The claim keys every item carries (see CLAIMS in the module docstring)."""
    return {
        "claimable": bool(claimable),
        "claimKind": kind,
        "claim": claim_brief(claim),
        "claimMessage": message,
        "suggestedShifts": float(suggested) if suggested is not None else None,
    }


def _claimability(emp, kind: str, target, ctx) -> tuple[bool, str | None, object]:
    """(claimable now, why not when it is worth saying, suggested shifts) from compensation_claims.eligibility. A reason is
    only given when the employee could act on it (no Department Head who may approve): a switched-off feature or a closed
    window is not something to show on every item."""
    ctx = ctx or claims_mod.context(for_employee=True)
    found = claims_mod.eligibility(emp, kind, target, ctx=ctx, check_hod=True)
    if found["eligible"]:
        return True, None, found["shifts"]
    return False, (found["message"] if found["code"] == "no_hod" else None), found["shifts"]


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


def _ot_items(
    emp,
    today: date,
    cfg: CompensationConfig,
    master: bool,
    assignments: list,
    since: date | None = None,
    ctx=None,
):
    """(items, todayAllowance, tomorrowAllowance) from the employee's OT records. `master` = the master switch and
    `assignments` = the employee's shift assignments, both read once by the caller. `since` (optional, the mobile
    year history in mobile_pay_compensation.py) reads from that day instead of the last HISTORY_DAYS. `ctx` is the
    claim context (compensation_claims.context) the caller made once, so every item answers "claimable?" alike.

    From CompensationConfig.claims_from on an OT day is claimed (owner decisions 2-3): a Type 1 allowance only applies
    after the Department Head approved its claim, a Type 2 day is claimed as a balance credit. Days before it keep the
    old statuses (automatic allowance, "ask HR")."""
    ctx = ctx or claims_mod.context(for_employee=True, today=today)
    since = since if since is not None else today - timedelta(days=HISTORY_DAYS)
    records = list(OvertimeRecord.objects.filter(employee=emp, date__gte=since).order_by("-date"))
    record_claims = claims_mod.latest_claims_for_records([r.id for r in records])
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
        claim = record_claims.get(r.id)
        new_rule = cfg.claims_apply_on(r.date)
        if r.ot_type == OvertimeRecord.OT_TYPE_ALLOWANCE:
            later = [d for d in ot_dates if d > r.date]
            window_end = min([r.date + timedelta(days=ALLOWANCE_LOOKBACK_DAYS), *later[:1]])
            used = next((m for m in markers if r.date < m.date <= window_end), None)
            fields = _claim_fields(None)
            if not new_rule:
                if used is not None:
                    status = "used"
                elif window_end < today or any(r.date < d <= window_end for d in worked):
                    # a worked day in the window did not need it, or the window has closed with no worked day at all
                    status = "not_used"
                else:
                    # automatic and still open: nothing to claim, and not an approval the employee is waiting on
                    status = "available"
                detail = (
                    f"You worked until {worked_until} ({extra_minutes} minutes past your shift end). You can arrive up "
                    f"to {r.allowance_minutes} minutes later on your next working day without being marked late. This "
                    "is automatic: there is nothing to claim."
                )
                if used is not None:
                    detail = used.compensation_note or detail
            else:
                fields = _claim_fields(HolidayWorkClaim.KIND_OT_ALLOWANCE, claim=claim)
                approved = claim is not None and claim.status == HolidayWorkClaim.STATUS_APPROVED
                base = (
                    f"You worked until {worked_until} ({extra_minutes} minutes past your shift end), which earns a "
                    f"{r.allowance_minutes}-minute late-in allowance for your next working day."
                )
                if approved:
                    status = "used" if used is not None else "claim_approved"
                    detail = (
                        used.compensation_note
                        if used is not None and used.compensation_note
                        else base + " Your Department Head approved it: you will not be marked late within it."
                    )
                elif claim is not None and claim.status == HolidayWorkClaim.STATUS_PENDING:
                    status, detail = "claim_pending", base + " Your claim is waiting for your Department Head."
                else:
                    can, why, _shifts = _claimability(emp, HolidayWorkClaim.KIND_OT_ALLOWANCE, r, ctx)
                    fields = _claim_fields(HolidayWorkClaim.KIND_OT_ALLOWANCE, claimable=can, claim=claim, message=why)
                    if claim is not None:
                        status = "claim_rejected"
                        detail = (
                            base
                            + " Your Department Head did not approve the claim."
                            + (f" {_stop(claim.review_comment)}" if claim.review_comment else "")
                        )
                    elif can:
                        status, detail = "claimable", base + " Claim it: it applies once your Department Head approves."
                    elif why:
                        status, detail = "detected", base + f" {why}"
                    else:
                        status, detail = "not_used", base + " It can no longer be claimed."
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
                    overtimeRecordId=r.id,
                    **fields,
                )
            )
        elif claim is not None and claim.kind == HolidayWorkClaim.KIND_OT_SHIFT and new_rule:
            # a Type 2 day the employee (or HR for them) claimed: the claim says where it stands
            status = CLAIM_STATUS.get(claim.status, claim.status)
            detail = f"You worked until {worked_until} ({extra_minutes} minutes past your shift end)."
            if claim.status == HolidayWorkClaim.STATUS_APPROVED:
                detail += f" Approved: {shifts_text(claim.shifts)} shift was added to your compensation balance."
            elif claim.status == HolidayWorkClaim.STATUS_PENDING:
                detail += f" Your claim for {shifts_text(claim.shifts)} shift is waiting for your Department Head."
            else:
                detail += " Your Department Head did not approve the claim." + (
                    f" {_stop(claim.review_comment)}" if claim.review_comment else ""
                )
            fields = _claim_fields(HolidayWorkClaim.KIND_OT_SHIFT, claim=claim, suggested=claim.shifts)
            if claim.status == HolidayWorkClaim.STATUS_REJECTED and r.status == OvertimeRecord.STATUS_DETECTED:
                can, why, suggested = _claimability(emp, HolidayWorkClaim.KIND_OT_SHIFT, r, ctx)
                fields = _claim_fields(
                    HolidayWorkClaim.KIND_OT_SHIFT, claimable=can, claim=claim, message=why, suggested=suggested
                )
            items.append(
                _item(
                    f"ot-{r.id}",
                    "ot_shift",
                    "detected",
                    r.date,
                    f"Extra hours: {shifts_text(claim.shifts)} shift claimed",
                    detail,
                    status,
                    shifts=float(claim.shifts),
                    minutes=extra_minutes,
                    overtimeRecordId=r.id,
                    **fields,
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
                    overtimeRecordId=r.id,
                    **_claim_fields(None),
                )
            )
        elif r.status == OvertimeRecord.STATUS_DETECTED:
            if new_rule and r.ot_type == OvertimeRecord.OT_TYPE_SHIFT:
                can, why, suggested = _claimability(emp, HolidayWorkClaim.KIND_OT_SHIFT, r, ctx)
                if suggested is None:
                    suggested = claims_mod.ot_credit(r) or None
                status = "claimable" if can else "detected"
                detail = (
                    f"You worked until {worked_until} ({extra_minutes} minutes past your shift end)"
                    + (f", which earns {shifts_text(suggested)} shift" if suggested else "")
                    + ". Claim it: once your Department Head approves, it is added to your compensation balance to use "
                    "on another day."
                )
                fields = _claim_fields(
                    HolidayWorkClaim.KIND_OT_SHIFT, claimable=can, claim=claim, message=why, suggested=suggested
                )
                title = "Extra hours detected: claim compensation"
            else:
                suggested = r.suggested_shifts
                status = "detected"
                detail = (
                    f"You worked until {worked_until} ({extra_minutes} minutes past your shift end)"
                    + (f", which can earn up to {shifts_text(suggested)} shift" if suggested else "")
                    + ". Shift compensation is given by HR, not automatically: contact HR to request it."
                )
                fields = _claim_fields(None)
                title = "Extra hours detected: ask HR for compensation"
            items.append(
                _item(
                    f"ot-{r.id}",
                    "ot_shift",
                    "detected",
                    r.date,
                    title,
                    detail,
                    status,
                    shifts=float(suggested) if suggested is not None else None,
                    minutes=extra_minutes,
                    overtimeRecordId=r.id,
                    **fields,
                )
            )
        # a rejected record is HR's decision that it is not compensable: it is not listed

    # the next-day allowance that applies today / on the next working day (from claims_from on: approved claims only)
    today_allowance = tomorrow_allowance = None
    if master and cfg.allowance_enabled:
        tomorrow_on = next_working_day(emp, today, assignments)
        for r in allowance:
            # an allowance only applies on the next working day, so only a recent OT day can still be pending
            if not r.allowance_minutes or r.date < today - timedelta(days=ALLOWANCE_LOOKBACK_DAYS):
                continue
            if cfg.claims_apply_on(r.date):
                claim = record_claims.get(r.id)
                if claim is None or claim.status != HolidayWorkClaim.STATUS_APPROVED:
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


STUCK_CLAIM_LABEL = "No Department Head can decide this yet: contact HR"


def _stuck_claim_detail(emp, raised_by_employee: bool = False) -> str | None:
    """The sentence for a claim that is waiting but that NOBODY can decide right now, or None when the employee's
    Department Head can. The same three cases as holiday_work_views._stuck_warnings (the warning HR gets when raising the
    claim): no active head, the employee is their own head (a head never decides their own claim, and holiday work is a
    Department-Head-only workflow, so HR cannot either), or a head whose profile may not approve compensation. The
    Settings switches are NOT a case: a claim that is already waiting can still be decided while they are off."""
    head = effective_manager(emp)
    who = "You raised this claim" if raised_by_employee else "HR raised this claim"
    if head is None:
        return f"{who}, but you have no Department Head assigned, so nobody can decide it yet. Please contact HR."
    if head.employee_id == emp.id:
        return (
            f"{who}, but you are a Department Head yourself and a head never decides their own claim, "
            "so nobody can decide it yet. Please contact HR to have another Department Head assigned to you."
        )
    if not head.can_approve_compensation:
        return (
            f"{who}, but your Department Head {full_name(head.employee)} is not allowed to approve "
            "compensation yet, so nobody can decide it. Please contact HR."
        )
    return None


def _worked_off_days(emp, start: date, end: date, holidays: dict) -> set[date]:
    """The Sundays / declared holidays in [start, end] the employee has on record as worked (punches, a manual present
    entry or a present / half-shift day record): what holiday_work_views.worked_ids reads, for a range in three queries."""
    from .models import Attendance, AttendanceLog

    days = set(
        AttendanceLog.objects.filter(employee=emp, date__gte=start, date__lte=end).values_list("date", flat=True)
    )
    days |= set(
        AttendanceDayRecord.objects.filter(
            employee=emp, date__gte=start, date__lte=end, status__in=WORKED_STATUSES
        ).values_list("date", flat=True)
    )
    for raw in Attendance.objects.filter(
        employee=emp, present=True, date__gte=start.isoformat(), date__lte=end.isoformat()
    ).values_list("date", flat=True):
        try:
            days.add(date.fromisoformat(str(raw)[:10]))
        except ValueError:
            continue
    return {d for d in days if start <= d <= end and day_kind(d, holidays) is not None}


def _claim_items(emp, today: date, holidays: dict, since: date | None = None, ctx=None):
    """The employee's holiday-work claims (hw-<id>, as before), their requests to use the balance that are waiting or were
    not approved (use_balance, hw-<id>), and the Sundays / holidays of the claim window they worked and have not claimed
    yet (holiday_work, status claimable, hwd-<date>). OT and birthday claims are shown on their own items."""
    since = since if since is not None else today - timedelta(days=HISTORY_DAYS)
    rows = list(
        HolidayWorkClaim.objects.filter(
            employee=emp,
            work_date__gte=since,
            kind__in=(HolidayWorkClaim.KIND_HOLIDAY_WORK, HolidayWorkClaim.KIND_USE_BALANCE),
        )
        .select_related("overtime_record")
        .order_by("-work_date", "-id")
    )
    # looked up once, and only when something is waiting
    pending = [c for c in rows if c.status == HolidayWorkClaim.STATUS_PENDING]
    stuck_hr = _stuck_claim_detail(emp) if any(c.raised_by_role != "employee" for c in pending) else None
    stuck_own = _stuck_claim_detail(emp, True) if any(c.raised_by_role == "employee" for c in pending) else None
    items = []
    for c in rows:
        own = c.raised_by_role == HolidayWorkClaim.RAISED_BY_EMPLOYEE
        stuck = stuck_own if own else stuck_hr
        extra = {}
        if c.kind == HolidayWorkClaim.KIND_USE_BALANCE:
            if c.status == HolidayWorkClaim.STATUS_APPROVED:
                continue  # the approved request is the `redemption` item of its debit
            when = date_text(c.work_date)
            if c.status == HolidayWorkClaim.STATUS_REJECTED:
                detail = f"Not approved by {c.reviewed_by or 'your Department Head'}." + (
                    f" {_stop(c.review_comment)}" if c.review_comment else ""
                )
            elif stuck:
                detail = stuck
                extra["statusLabel"] = STUCK_CLAIM_LABEL
            else:
                who = "You asked" if own else "HR asked, for you,"
                detail = (
                    f"{who} to use {shifts_text(c.shifts)} shift of your balance on {when}. It is waiting for your "
                    "Department Head."
                )
            items.append(
                _item(
                    f"hw-{c.id}",
                    "use_balance",
                    "balance",
                    c.work_date,
                    f"Use balance: {shifts_text(c.shifts)} shift",
                    detail,
                    CLAIM_STATUS.get(c.status, c.status),
                    shifts=float(c.shifts),
                    workDate=_iso(c.work_date),
                    **_claim_fields(HolidayWorkClaim.KIND_USE_BALANCE, claim=c),
                    **extra,
                )
            )
            continue
        kind = day_kind(c.work_date, holidays) or ("sunday" if c.work_date.weekday() == 6 else "holiday")
        what = "Sunday" if kind == "sunday" else "Holiday"
        status = {"pending": "pending_hod"}.get(c.status, c.status)
        if c.status == HolidayWorkClaim.STATUS_APPROVED:
            detail = f"Approved by {c.reviewed_by or 'your Department Head'}: {shifts_text(c.shifts)} shift was added to your compensation balance."
        elif c.status == HolidayWorkClaim.STATUS_REJECTED:
            detail = f"Not approved by {c.reviewed_by or 'your Department Head'}." + (
                f" {_stop(c.review_comment)}" if c.review_comment else ""
            )
        elif stuck:
            # the status word stays pending_hod (both apps tone it as "needs attention"): only the words change
            detail = stuck
            extra["statusLabel"] = STUCK_CLAIM_LABEL
        elif own:
            detail = "You raised this claim. It is waiting for your Department Head to approve it."
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
                **_claim_fields(HolidayWorkClaim.KIND_HOLIDAY_WORK, claim=c, suggested=c.shifts),
                **extra,
            )
        )

    # worked Sundays / holidays of the claim window with no claim yet: the employee can claim them
    if ctx is not None and ctx.master and ctx.cfg.holiday_work_enabled and ctx.workflow_on:
        start = max(since, today - timedelta(days=claims_mod.CLAIM_WINDOW_DAYS))
        claimed = {c.work_date for c in rows if c.kind == HolidayWorkClaim.KIND_HOLIDAY_WORK}
        # the employee is active staff (the caller), the switches are on and every day is a worked Sunday / holiday of
        # the window with no claim: only the Department Head is left to check (create_claim checks it all again)
        why = ctx.hod_problem(emp) if emp.status == "active" else None
        can, suggested = emp.status == "active" and why is None, Decimal("1.00")
        for day in sorted(_worked_off_days(emp, start, today, holidays) - claimed, reverse=True):
            if not (can or why):
                continue
            kind = day_kind(day, holidays)
            what = "Sunday" if kind == "sunday" else (holidays.get(day) or "Holiday")
            detail = (
                f"You worked on {date_text(day)}. Claim compensation for it: once your Department Head approves, it is "
                "added to your compensation balance to use on another day."
            )
            if why:
                detail = f"You worked on {date_text(day)}. {why}"
            items.append(
                _item(
                    f"hwd-{day.isoformat()}",
                    "holiday_work",
                    "detected",
                    day,
                    f"{what} work: claim compensation",
                    detail,
                    "claimable" if can else "detected",
                    shifts=None,
                    workDate=_iso(day),
                    **_claim_fields(
                        HolidayWorkClaim.KIND_HOLIDAY_WORK,
                        claimable=can,
                        message=why,
                        suggested=suggested or Decimal("1.00"),
                    ),
                )
            )
    return items


def _redemption_detail(e: CompensationLedger) -> str:
    """What the employee reads about a day HR took from the balance. Built from the formatted date, never from HR's
    ledger note: that holds 'Redeemed on 2026-10-12' (a raw ISO date) or 'Alternative Day credit 12 used' (an internal id)."""
    when = date_text(e.date)
    if e.source == "legacy_credit":
        return f"HR used your earlier Alternative Day credit ({shifts_text(e.shifts)} shift) for {when}."
    if e.claim_id is not None:
        return f"Your Department Head approved using {shifts_text(e.shifts)} shift of your compensation balance for {when}."
    return f"HR used {shifts_text(e.shifts)} shift of your compensation balance for {when}."


def _redemption_items(emp, today: date, since: date | None = None):
    since = since if since is not None else today - timedelta(days=HISTORY_DAYS)
    return [
        _item(
            f"rd-{e.id}",
            "redemption",
            "balance",
            e.date,
            f"Compensation day taken: {shifts_text(e.shifts)} shift",
            _redemption_detail(e),
            "taken",
            shifts=float(e.shifts),
            **_claim_fields(HolidayWorkClaim.KIND_USE_BALANCE if e.claim_id else None, claim=e.claim),
        )
        for e in CompensationLedger.objects.filter(
            employee=emp, entry_type=CompensationLedger.ENTRY_DEBIT, date__gte=since
        )
        .select_related("claim", "claim__overtime_record")
        .order_by("-date", "-id")
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


def _window_items(emp, today: date, since: date | None = None, until: date | None = None):
    anns = [
        a
        for a in CompensationDayAnnouncement.objects.filter(
            kind__in=(CompensationDayAnnouncement.KIND_LATE_IN, CompensationDayAnnouncement.KIND_EARLY_OUT),
            date__gte=since if since is not None else today - timedelta(days=WINDOW_PAST_DAYS),
            date__lte=until if until is not None else today + timedelta(days=WINDOW_AHEAD_DAYS),
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
    emp,
    today: date,
    holidays_for: Callable[[date], dict],
    cfg: CompensationConfig,
    master: bool,
    assignments: list,
    year: int | None = None,
    ctx=None,
):
    """This year's birthday (and next year's once it has passed); with `year` (the mobile year history), that year's.

    From CompensationConfig.claims_from on (owner decision 4) a birthday is a normal working day: absent or on approved
    leave = paid birthday leave (`birthday`, status applied), worked = one 1.00 credit to claim (`birthday_credit`), what
    compensation_effects.birthday_outcome says from the attendance. Days before it keep the automatic paid leave."""
    if emp.date_of_birth is None:
        return []
    if year is not None:
        days = [birthday_in_year(emp.date_of_birth, year)]
    else:
        this_year = birthday_in_year(emp.date_of_birth, today.year)
        days = [this_year]
        if this_year < today:
            days.append(birthday_in_year(emp.date_of_birth, today.year + 1))
    records = {
        r.date: r for r in AttendanceDayRecord.objects.filter(employee=emp, date__in=days, compensation_kind="birthday")
    }
    claimed: dict = {}
    for c in HolidayWorkClaim.objects.filter(
        employee=emp, kind=HolidayWorkClaim.KIND_BIRTHDAY, work_date__in=days
    ).order_by("-id"):
        current = claimed.get(c.work_date)
        if current is None or (
            current.status not in HolidayWorkClaim.OPEN_STATUSES and c.status in HolidayWorkClaim.OPEN_STATUSES
        ):
            claimed[c.work_date] = c
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
        if benefits and cfg.claims_apply_on(day):
            items.append(_birthday_claim_item(emp, day, today, claimed.get(day), ctx))
            continue
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
                # no shifts: a paid birthday never touches the compensation balance, so a "1 shift" chip would read as
                # a credit that was never added
            )
        )
    return items


BIRTHDAY_RULE_TEXT = (
    "Your birthday is a normal working day. If you are absent or on approved leave that day, it is paid birthday leave "
    "(no leave balance is used). If you come to work, you can claim one shift of compensation to take on another day."
)
BIRTHDAY_TODAY_TEXT = (
    "Today is your birthday, a normal working day. If you do not come to work today (absent or on approved leave), it "
    "becomes paid birthday leave once the day is over (no leave balance is used). If you come to work, you can claim "
    "one shift of compensation to take on another day."
)
BIRTHDAY_PAID_TEXT = (
    "You were not at work on your birthday (absent or on approved leave), so it is paid birthday leave: a full paid day, "
    "no leave or Casual Leave balance used."
)
BIRTHDAY_PAID_BY_HR_TEXT = (
    "You were not at work on your birthday and the day is already paid (set by HR, for example an approved Casual "
    "Leave)."
)


def _birthday_claim_item(emp, day: date, today: date, claim, ctx) -> dict:
    """One birthday under the claim rule (see _birthday_items)."""
    key = f"bd-{day.isoformat()}"
    if claim is not None:
        status = CLAIM_STATUS.get(claim.status, claim.status)
        if claim.status == HolidayWorkClaim.STATUS_APPROVED:
            detail = "You worked on your birthday. Approved: 1.00 shift was added to your compensation balance."
        elif claim.status == HolidayWorkClaim.STATUS_PENDING:
            detail = "You worked on your birthday. Your claim for 1.00 shift is waiting for your Department Head."
        else:
            detail = "You worked on your birthday. Your Department Head did not approve the claim." + (
                f" {_stop(claim.review_comment)}" if claim.review_comment else ""
            )
        fields = _claim_fields(HolidayWorkClaim.KIND_BIRTHDAY, claim=claim, suggested=Decimal("1.00"))
        if claim.status == HolidayWorkClaim.STATUS_REJECTED:
            can, why, _s = _claimability(emp, HolidayWorkClaim.KIND_BIRTHDAY, day, ctx)
            fields = _claim_fields(
                HolidayWorkClaim.KIND_BIRTHDAY, claimable=can, claim=claim, message=why, suggested=Decimal("1.00")
            )
        return _item(
            key, "birthday_credit", "birthday", day, "Birthday credit: 1.00 shift", detail, status, shifts=1.0, **fields
        )
    from . import compensation_effects as effects

    outcome = {}
    try:
        # the employee's own page keeps its own recent days fresh (like refresh_employee_overtime): a missing / stale
        # birthday is worked out, but never in a finalized payroll month (compensation_effects.birthday_outcomes)
        outcome = effects.birthday_outcome(emp, day, refresh=True) or {}
    except Exception:
        logger.exception("birthday_outcome failed for employee %s on %s", emp.pk, day)
    result = outcome.get("base") or outcome.get("outcome")
    if result == effects.BIRTHDAY_CREDIT_CLAIMABLE:
        can, why, _s = _claimability(emp, HolidayWorkClaim.KIND_BIRTHDAY, day, ctx)
        detail = (
            "You worked on your birthday, so you can claim one shift of compensation (1.00) to take on another day. "
            "Your Department Head approves it."
        )
        if why:
            detail = f"You worked on your birthday. {why}"
        elif not can:
            detail = "You worked on your birthday, but it can no longer be claimed."
        return _item(
            key,
            "birthday_credit",
            "birthday",
            day,
            "Birthday credit: 1.00 shift",
            detail,
            "claimable" if can else ("detected" if why else "not_applicable"),
            shifts=1.0,
            **_claim_fields(HolidayWorkClaim.KIND_BIRTHDAY, claimable=can, message=why, suggested=Decimal("1.00")),
        )
    # the new rule: never "paid whatever you do" (the old automatic wording stays on the birthdays before claims_from)
    if result == effects.BIRTHDAY_PAID_LEAVE:
        status, title = "applied", "Birthday leave (paid)"
        detail = BIRTHDAY_PAID_BY_HR_TEXT if outcome.get("viaManualDay") else BIRTHDAY_PAID_TEXT
    elif day >= today:
        status = "today" if day == today else "upcoming"
        title = "Birthday: a normal working day"
        detail = BIRTHDAY_TODAY_TEXT if day == today else BIRTHDAY_RULE_TEXT
    else:
        status, title = "not_applicable", "Birthday"
        detail = outcome.get("message") or "This birthday gives no birthday compensation."
    return _item(key, "birthday", "birthday", day, title, detail, status, **_claim_fields(None))


# ─────────────────────────── ask HR ───────────────────────────


def _ask_hr(flags: dict, claims_on: bool = True) -> dict:
    """The "Ask Request for Compensation" tab. Since 2026-11-19 the employee claims compensation themselves in the app
    (the Claim button on an item, "Use my balance"): HR is the contact for what is missing or wrong."""
    points = []
    if flags["allowance"]:
        points.append(
            "Working a little past your shift end earns a late-in allowance for your next working day. Claim it here: it "
            "applies once your Department Head approves."
        )
    if flags["shift"]:
        points.append(
            "Working much longer past your shift end earns shift compensation (0.25 to 1 shift, by how much of a shift "
            "you worked extra). Claim it here: once your Department Head approves, it is added to your compensation "
            "balance."
        )
    if flags["holidayWork"]:
        points.append(
            "If you worked on a Sunday or a company holiday, claim compensation for it here. Your Department Head "
            "approves it before it is added to your compensation balance."
        )
    if flags["birthday"]:
        points.append(
            "Your birthday is a normal working day: absent or on approved leave, it is paid birthday leave; if you work, "
            "you can claim one shift of compensation."
        )
    if flags["master"]:
        points.append(
            'To take a day (or part of one) off from your compensation balance, use "Use my balance": your Department '
            "Head approves it."
        )
    if flags["windows"]:
        points.append(
            "When the company announces a late-in or early-out time for a day, it appears here for everybody."
        )
    if not flags["any"]:
        points = ["Compensation is not switched on yet. Contact HR for any question."]
    if claims_on:
        text = (
            "The system detects when you work extra hours, work on a Sunday or a company holiday, or work on your "
            "birthday, and shows it here with a Claim button. Your claim goes to your Department Head. If something "
            "you worked is missing from the list, or a claim is stuck, contact HR."
        )
    else:
        text = (
            "The system detects when you work extra hours or work on a Sunday or a company holiday, and shows it here. "
            "Claims cannot be raised right now: if you worked extra and it is missing from the list, contact HR."
        )
    return {"title": ASK_HR_TITLE, "text": text, "points": points, "contact": hr_contact()}


def _use_balance_block(emp, ctx, problem: str | None) -> dict:
    """What "Use my balance" may do: the balance, what is already asked for and what is left to ask for."""
    figures = claims_mod.balance_figures([emp.id]).get(emp.id) or {}
    balance = Decimal(figures.get("balance", 0))
    pending = Decimal(figures.get("pending", 0))
    available = Decimal(figures.get("available", 0))
    message = None
    if not ctx.master:
        message = "Compensation is switched off right now, so the balance cannot be used."
    elif not ctx.workflow_on:
        message = "Compensation claims are switched off right now. Please contact HR."
    elif problem:
        message = problem
    elif available < Decimal("0.25"):
        message = (
            "Everything in your balance is already asked for: wait for your Department Head."
            if pending > 0
            else "Your compensation balance is empty."
        )
    return {
        "allowed": message is None,
        "balanceShifts": float(balance.quantize(Decimal("0.01"))),
        "pendingShifts": float(pending.quantize(Decimal("0.01"))),
        "availableShifts": float(max(available, Decimal("0")).quantize(Decimal("0.01"))),
        "message": message,
    }


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
        "canClaim": False,
        "claimWindowDays": claims_mod.CLAIM_WINDOW_DAYS,
        "useBalance": {
            "allowed": False,
            "balanceShifts": 0.0,
            "pendingShifts": 0.0,
            "availableShifts": 0.0,
            "message": message,
        },
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

    ctx = claims_mod.context(for_employee=True, today=today, cfg=cfg, master=flags["master"])
    ctx.remember_open_claims(emp)  # one query for every item's "already claimed?"
    items, today_allowance, tomorrow_allowance = _ot_items(emp, today, cfg, flags["master"], assignments, ctx=ctx)
    items += _claim_items(emp, today, holidays, ctx=ctx)
    items += _redemption_items(emp, today)
    if flags["windows"]:
        items += _window_items(emp, today)
    if flags["birthday"]:
        items += _birthday_items(emp, today, holidays_for, cfg, flags["master"], assignments, ctx=ctx)
    items.sort(key=lambda i: (i["date"] or "", i["key"]), reverse=True)
    hod_problem = ctx.hod_problem(emp)
    claim_features = flags["holidayWork"] or flags["allowance"] or flags["shift"] or flags["birthday"]
    can_claim = bool(ctx.master and ctx.workflow_on and claim_features and not hod_problem)
    use_balance = _use_balance_block(emp, ctx, hod_problem)
    return Response(
        {
            "isStaff": True,
            "enabled": flags,
            # the same figure as balance_shifts / compensation_apply.balance_of, read with the use-balance block's queries
            "balanceShifts": use_balance["balanceShifts"],
            "items": items,
            "todayAllowance": today_allowance,
            "tomorrowAllowance": tomorrow_allowance,
            "askHr": _ask_hr(flags, claims_on=bool(ctx.master and ctx.workflow_on)),
            "message": None,
            # the claim workflow (2026-11-19): the apps show Claim / Use my balance only when the server sends canClaim
            "canClaim": can_claim,
            "claimMessage": hod_problem if (ctx.master and ctx.workflow_on and claim_features) else None,
            "claimWindowDays": claims_mod.CLAIM_WINDOW_DAYS,
            "useBalance": use_balance,
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
            # The switch only stops HR raising NEW claims. The manager endpoints (pending list, count, decision) never look
            # at it, so the head can still decide a claim that is already waiting: saying "cannot" would be untrue.
            can, why = True, HOLIDAY_WORK_OFF_REASON
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
        return Response({**base, "isSelf": True, "message": SELF_HEAD_MESSAGE})
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
            "photoUrl": photo_link(boss.id, boss.photo_url),
            "designation": boss.designation.title if boss.designation_id and boss.designation else None,
            "department": boss.department.name if boss.department_id and boss.department else None,
            "branch": boss.branch.name if boss.branch_id and boss.branch else None,
            "email": boss.email,
            "approvals": _approvals_json(manager, emp),
            "message": None,
        }
    )

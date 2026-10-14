"""Compensation -read-only CTC breakdown per employee.

Purely a display/reporting feature: shows each employee's 50% + 50% salary split (Basic, DA, Retaining Allowance |
Other, Petrol, HRA, Special Allowance, CA -salary_split.py) with the Employer PF / Employer ESI / Annual CTC worked
out from it (ctc.py, shared with the Report Center's CTC statement). Deliberately does NOT touch, read from, or feed
back into the actual payroll generation engine (_generate_staff_payroll/_generate_production_payroll in
payroll_views.py), which keeps its own calculation exactly as it already was.
"""
from datetime import date as date_type, timedelta
from decimal import Decimal
from functools import wraps

from django.db import transaction
from django.db.models import Q
from rest_framework.decorators import api_view
from rest_framework.request import Request
from rest_framework.response import Response

from . import compensation_rules as rules
from .auth import require_hr, get_hr_display_name
from .audit_utils import log_action
from .branch_scope import get_branch_scope, scope_to_branch
from .clock import ist_today
from .compensation_shared import parse_date, parse_time
from .ctc import ctc_figures
from .models import (
    AttendanceDayRecord, CompensationConfig, CompensationDayAnnouncement, CompensationLeaveCredit,
    CompensationLedger, Employee, EmployeeShiftAssignment, OvertimeRecord, PayrollSettings, SalarySlip,
    Branch, Department,
)
from .user_settings import settings_for_employee


COMPENSATION_FEATURES_OFF_MESSAGE = (
    "The OT / Compensation features are switched off in Settings > Payroll > OT / Compensation, so this can't be "
    "changed right now. Switch them on there to announce OT, add Compensation Days or redeem credits."
)


def require_compensation_features_for_changes(view_func):
    """
    The Compensation page is a mandatory part of the portal, so PayrollSettings.compensation_feature_enabled does NOT
    switch the page off: it stays in the sidebar, and every read here (CTC Breakdown, OT records, Compensation Days,
    credits, History & Reports) keeps working whatever the switch says. The switch controls what the feature DOES in the
    background -detecting OT, paying announced OT in payroll, exempting Compensation Days from Late/Permission
    detection- and each of those checks it where it acts (overtime.py, attendance_final.py, payroll_views.py).

    What this decorator adds is the one thing that would otherwise mislead: while the features are off, announcing OT,
    adding or removing a Compensation Day and redeeming a credit would save a record that nothing acts on (and that
    would start to act, retroactively, the day the switch is turned back on). Those changes are refused with a clear
    message; GET/HEAD/OPTIONS always pass. Existing records are never touched by the switch.
    """
    @wraps(view_func)
    def wrapper(request, *args, **kwargs):
        if request.method not in ("GET", "HEAD", "OPTIONS") and not PayrollSettings.get().compensation_feature_enabled:
            return Response({"error": COMPENSATION_FEATURES_OFF_MESSAGE}, status=403)
        return view_func(request, *args, **kwargs)
    return wrapper


def _d2(value) -> Decimal:
    return Decimal(str(value)).quantize(Decimal("0.01"))


# ──────────────────────────────────────────────
#  Reading what a request sent (a bad value is a 400, never a crash)
# ──────────────────────────────────────────────

_MAX_ID = 2**63 - 1  # the largest id the database can hold


def _int_or_none(raw) -> int | None:
    """An id or a year from a JSON body or a query string: a whole number the database can hold. Anything else (text, a
    list or an object, a bool, a fraction, an infinity: JSON `1e999` parses to one) is None, so the caller answers 400
    instead of letting the ORM raise."""
    if raw is None or isinstance(raw, (bool, list, tuple, dict)):
        return None
    try:
        value = int(raw)
    except (TypeError, ValueError, OverflowError):
        return None
    if isinstance(raw, float) and value != raw:
        return None
    return value if 0 < value <= _MAX_ID else None


def can_edit_compensation(request) -> bool:
    """Whether the caller's role may CHANGE Compensation (a super administrator always may). Reading must never write: the
    OT list brings detection up to date only for a login that could also assign, so a view-only role triggers no write."""
    from .models import HRUser
    from .permission_registry import effective_permissions, resolve_permission

    user_id = (getattr(request, "jwt_user", None) or {}).get("hrUserId")
    hr = HRUser.objects.select_related("role").filter(pk=user_id, is_active=True).first() if user_id else None
    if hr is None:
        return False
    if hr.is_super_admin:
        return True
    return resolve_permission(effective_permissions(hr), "compensation") == "edit"


def _assignments_by_employee(employee_ids, start: date_type, end: date_type) -> dict[int, list]:
    """{employee_id: [EmployeeShiftAssignment, ...]} overlapping [start, end], one query: handed to overtime.next_working_day
    so an off-Saturday check never goes back to the database once per row."""
    out: dict[int, list] = {}
    for a in (
        EmployeeShiftAssignment.objects.filter(employee_id__in=list(employee_ids), effective_from__lte=end)
        .filter(Q(effective_to__isnull=True) | Q(effective_to__gte=start))
        .select_related("shift")
    ):
        out.setdefault(a.employee_id, []).append(a)
    return out


def _compensation_dict(emp: Employee, settings=None) -> dict:
    """One CTC Breakdown row. `settings` may be passed in when the caller already has the employee's resolved settings."""
    return {
        "employeeId": emp.id,
        "employeeCode": emp.employee_code,
        "employeeName": f"{emp.first_name} {emp.last_name}",
        "department": emp.department.name if emp.department else None,
        "designation": emp.designation.title if emp.designation else None,
        "branch": emp.branch.name if emp.branch else None,
        "employmentType": emp.employment_type,
        **ctc_figures(emp, settings or settings_for_employee(emp)),
    }


@api_view(["GET"])
@require_hr
@require_compensation_features_for_changes
def compensation_list(request: Request) -> Response:
    qs = scope_to_branch(
        Employee.objects.select_related("department", "designation", "branch"), request
    ).filter(status=request.query_params.get("status") or "active")

    dept_id = request.query_params.get("departmentId")
    if dept_id:
        qs = qs.filter(department_id=dept_id)
    branch_id = request.query_params.get("branchId")
    if branch_id:
        qs = qs.filter(branch_id=branch_id)
    employment_type = request.query_params.get("employmentType")
    if employment_type:
        qs = qs.filter(employment_type=employment_type)
    search = (request.query_params.get("search") or "").strip()
    if search:
        from django.db.models import Q
        qs = qs.filter(
            Q(first_name__icontains=search) | Q(last_name__icontains=search) | Q(employee_code__icontains=search)
        )

    rows = [_compensation_dict(emp) for emp in qs.order_by("employee_code")]
    return Response({"results": rows, "count": len(rows)})


# ──────────────────────────────────────────────
#  OT (Overtime) detection + HR assign/reject
# ──────────────────────────────────────────────
#
# Two kinds of OT (see overtime.py): Type 1 "allowance" (automatic next-day late-in allowance, status "auto", HR does
# nothing) and Type 2 "shift" (0.25 / 0.50 / 0.75 / 1 shift that HR assigns as relaxation or pay). Records made before the
# overhaul are "legacy" (one day's pay, or one credit): they keep their old meaning and the old announce endpoint.

STATUS_LABELS = {"detected": "Detected", "announced": "Assigned", "rejected": "Rejected", "auto": "Automatic"}
LEGACY_ANNOUNCED_LABEL = "Announced"
MODES = (OvertimeRecord.TYPE_RELAXATION, OvertimeRecord.TYPE_PAY)


def _shifts_json(value):
    return float(value) if value is not None else None


def _ot_dict(r: OvertimeRecord, used: dict | None = None, statuses: dict | None = None) -> dict:
    """One OT row. `used` = {(employee_id, date of OT day): (date used on, minutes used)} for Type 1 rows whose allowance
    the employee actually used on the next working day (built by the list view; absent = unknown/not used). `statuses` =
    {(employee_id, date): "used" | "pending" | "not_used"}, the same rows' `allowanceStatus` (see _allowance_use_map)."""
    emp = r.employee
    last_next_day = bool(
        r.shift_end_time is not None
        and r.last_punch_out is not None
        and r.ot_minutes is not None
        and (r.shift_end_time.hour * 60 + r.shift_end_time.minute + r.ot_minutes) >= rules.MINUTES_PER_DAY
    )
    legacy = r.ot_type == OvertimeRecord.OT_TYPE_LEGACY
    label = LEGACY_ANNOUNCED_LABEL if (legacy and r.status == OvertimeRecord.STATUS_ANNOUNCED) else STATUS_LABELS.get(
        r.status, r.status
    )
    hit = (used or {}).get((r.employee_id, r.date))
    is_allowance = r.ot_type == OvertimeRecord.OT_TYPE_ALLOWANCE
    return {
        "id": r.id,
        "employeeId": emp.id,
        "employeeCode": emp.employee_code,
        "employeeName": f"{emp.first_name} {emp.last_name}",
        "department": emp.department.name if emp.department else None,
        "date": str(r.date),
        "shiftEndTime": r.shift_end_time.strftime("%H:%M") if r.shift_end_time else None,
        "lastPunchOut": r.last_punch_out.strftime("%H:%M") if r.last_punch_out else None,
        "lastPunchNextDay": last_next_day,
        "otMinutes": r.ot_minutes,
        "otType": r.ot_type,
        "allowanceMinutes": r.allowance_minutes or 0,
        "suggestedShifts": _shifts_json(r.suggested_shifts),
        "shifts": _shifts_json(r.shifts),
        "claimDate": str(r.claim_date) if r.claim_date else None,
        "status": r.status,
        "statusLabel": label,
        "compensationType": r.compensation_type,
        "announcedBy": r.announced_by,
        "announcedAt": r.announced_at.isoformat() if r.announced_at else None,
        # Type 1 only: did the employee use the allowance on the next working day (the attendance day says so)
        "allowanceUsed": (hit is not None) if is_allowance else None,
        "usedOn": str(hit[0]) if (is_allowance and hit) else None,
        "usedMinutes": hit[1] if (is_allowance and hit) else None,
        # Type 1 only: "used" | "not_used" | "pending" ("pending" = the day it applies to has not elapsed yet, so
        # "not used" would be premature). allowanceUsed above is unchanged.
        "allowanceStatus": (
            (statuses or {}).get((r.employee_id, r.date), "used" if hit is not None else "not_used")
            if is_allowance
            else None
        ),
        "canAssign": r.status == OvertimeRecord.STATUS_DETECTED and r.ot_type == OvertimeRecord.OT_TYPE_SHIFT,
    }


def _allowance_use_map(records, today=None) -> tuple[dict, dict]:
    """(used, statuses) for the Type 1 rows of `records`.

    used     {(employee_id, OT date): (date used on, minutes used)} for the rows whose allowance was used: the next working
             day's AttendanceDayRecord carries the allowance minutes. That is the case whichever marker won the day: when a
             company window or a relaxation shares the day, compensation_kind shows THAT, but the minutes of the allowance
             are still stored, so "used" is read from the minutes as well as from the "ot_allowance" kind.
    statuses {(employee_id, OT date): "used" | "pending" | "not_used"}: "pending" while the day the allowance applies to has
             not elapsed (it is today or later), so "not used" is never shown before it can be known.

    The shift assignments of every employee are read once and handed to next_working_day, so the off-Saturday test never
    goes back to the database per row; three queries for the whole list however long it is."""
    from .overtime import next_working_day

    today = today or ist_today()
    rows = [r for r in records if r.ot_type == OvertimeRecord.OT_TYPE_ALLOWANCE]
    if not rows:
        return {}, {}
    assignments = _assignments_by_employee(
        {r.employee_id for r in rows},
        min(r.date for r in rows),
        max(r.date for r in rows) + timedelta(days=rules.LOOKBACK_DAYS),
    )
    next_by_row = {}
    for r in rows:
        nwd = next_working_day(r.employee, r.date, assignments.get(r.employee_id, []))
        if nwd is not None:
            next_by_row[(r.employee_id, r.date)] = nwd
    found = {}
    if next_by_row:
        found = {
            (emp_id, day): minutes
            for emp_id, day, minutes in AttendanceDayRecord.objects.filter(
                Q(compensation_kind="ot_allowance") | Q(compensation_minutes__gt=0),
                employee_id__in={k[0] for k in next_by_row},
                date__in=set(next_by_row.values()),
            ).values_list("employee_id", "date", "compensation_minutes")
        }
    used = {key: (nwd, found[(key[0], nwd)]) for key, nwd in next_by_row.items() if (key[0], nwd) in found}
    statuses = {}
    for r in rows:
        key = (r.employee_id, r.date)
        nwd = next_by_row.get(key)
        if key in used:
            statuses[key] = "used"
        elif nwd is not None and nwd >= today:
            statuses[key] = "pending"
        else:
            statuses[key] = "not_used"
    return used, statuses


def _int_or_default(raw, default: int) -> int:
    try:
        return int(raw)
    except (TypeError, ValueError):
        return default


# Years the OT list accepts: wide enough for any real month, narrow enough that date(year, month, 1) cannot fail.
OT_LIST_MIN_YEAR, OT_LIST_MAX_YEAR = 2000, 2100
# Records one assign request may carry (the holiday-work request has the same kind of cap).
MAX_ASSIGN_RECORDS = 200


@api_view(["GET"])
@require_hr
@require_compensation_features_for_changes
def overtime_list(request: Request) -> Response:
    """Brings detection up to date (a conditional, idempotent upsert that writes nothing when nothing changed: see
    overtime.py; the attendance engine does not depend on it, and the scheduled pass keeps the rows fresh anyway) for a
    login that may edit Compensation, then returns the month's records of BOTH types, optionally filtered by `status`
    (detected | auto | assigned | announced | rejected; "assigned" is the same as "announced"), `type` (allowance | shift |
    legacy, or 1 | 2), and `departmentId` / `employeeId`. A view-only role gets the rows as they are: reading writes nothing."""
    from .overtime import detect_overtime_for_month

    today = ist_today()
    year = _int_or_default(request.query_params.get("year"), today.year)
    month = _int_or_default(request.query_params.get("month"), today.month)
    if not 1 <= month <= 12:
        return Response({"error": "month must be between 1 and 12"}, status=400)
    if not OT_LIST_MIN_YEAR <= year <= OT_LIST_MAX_YEAR:
        return Response({"error": f"year must be between {OT_LIST_MIN_YEAR} and {OT_LIST_MAX_YEAR}"}, status=400)
    settings = PayrollSettings.get()
    config = CompensationConfig.get()

    records = detect_overtime_for_month(year, month, settings=settings, write=can_edit_compensation(request))
    emp_ids = set(scope_to_branch(Employee.objects, request).values_list("id", flat=True))
    records = [r for r in records if r.employee_id in emp_ids]

    status = request.query_params.get("status")
    if status:
        status = OvertimeRecord.STATUS_ANNOUNCED if status == "assigned" else status
        records = [r for r in records if r.status == status]
    ot_type = {"1": "allowance", "2": "shift"}.get(request.query_params.get("type") or "", request.query_params.get("type"))
    if ot_type:
        records = [r for r in records if r.ot_type == ot_type]
    dept = request.query_params.get("departmentId")
    if dept:
        records = [r for r in records if str(r.employee.department_id) == str(dept)]
    emp = request.query_params.get("employeeId")
    if emp:
        records = [r for r in records if str(r.employee_id) == str(emp)]

    used, statuses = _allowance_use_map(records, today)
    return Response({
        "results": [_ot_dict(r, used, statuses) for r in records],
        "count": len(records),
        # kept for the old screen: it read these three
        "settings": {
            "otDetectionEnabled": bool(
                settings.compensation_feature_enabled and (config.shift_enabled or config.allowance_enabled)
            ),
            "otThresholdMinutes": config.shift_min_extra_minutes,
            "otCompensationType": settings.ot_compensation_type,
        },
        # what the page needs to decide which actions to offer
        "config": {
            "masterEnabled": settings.compensation_feature_enabled,
            "allowanceEnabled": config.allowance_enabled,
            "shiftEnabled": config.shift_enabled,
            "relaxationEnabled": config.relaxation_enabled,
            "payEnabled": config.pay_enabled,
            "shiftMinExtraMinutes": config.shift_min_extra_minutes,
        },
    })


def _assign_one(
    request: Request, emp_id: int, item: dict, mode: str, batch_shifts, batch_claim, actor: str, settings=None
) -> dict:
    """Assign ONE Type 2 record of employee `emp_id`. Returns {"ok": True, "record": rec} or {"ok": False, "reason":
    sentence}. `settings` (the PayrollSettings the request already loaded) is handed to the day check and the day
    re-computation so neither reads it again per record."""
    from django.utils import timezone

    from .compensation_apply import RelaxationRefused, apply_relaxation, check_relaxation_day

    try:
        ot_date = date_type.fromisoformat(str(item.get("date")))
    except (TypeError, ValueError):
        return {"ok": False, "reason": "Each record needs a valid date (YYYY-MM-DD)."}
    with transaction.atomic():
        if mode == OvertimeRecord.TYPE_RELAXATION:
            # The employee row is the lock a balance redemption takes too: two grants / redemptions on one employee are
            # checked one after the other, so they can never both pass "the day still has room" (always employee first,
            # then the record: the one lock order every writer here uses).
            Employee.objects.select_for_update().filter(pk=emp_id).first()
        rec = (
            OvertimeRecord.objects.select_for_update(of=("self",))
            .select_related("employee", "employee__department")
            .filter(employee_id=emp_id, date=ot_date)
            .first()
        )
        if rec is None:
            return {"ok": False, "reason": "No overtime record found for that employee and date."}
        who = f"{rec.employee.employee_code} on {ot_date.strftime('%d %b %Y')}"
        if rec.ot_type != OvertimeRecord.OT_TYPE_SHIFT:
            if rec.ot_type == OvertimeRecord.OT_TYPE_ALLOWANCE:
                return {"ok": False, "reason": f"{who}: a next-day allowance is automatic, there is nothing to assign."}
            return {"ok": False, "reason": f"{who}: this is an older record; use Announce for it."}
        if rec.status != OvertimeRecord.STATUS_DETECTED:
            return {"ok": False, "reason": f"{who}: it is already {STATUS_LABELS.get(rec.status, rec.status).lower()}."}
        if rec.employee.employment_type != "staff":
            return {"ok": False, "reason": f"{who}: compensation applies to staff employees only."}

        raw_shifts = item.get("shifts")
        if raw_shifts in (None, ""):
            raw_shifts = batch_shifts
        if raw_shifts in (None, ""):
            shifts = rec.suggested_shifts
            if shifts is None:
                return {"ok": False, "reason": f"{who}: choose the shifts to assign (0.25, 0.50, 0.75 or 1)."}
        else:
            shifts = rules.normalise_shifts(raw_shifts)
            if shifts is None:
                return {"ok": False, "reason": f"{who}: shifts must be one of 0.25, 0.50, 0.75 or 1."}

        raw_claim = item.get("claimDate")
        if raw_claim in (None, ""):
            raw_claim = batch_claim
        claim_date = None
        if raw_claim not in (None, ""):
            try:
                claim_date = date_type.fromisoformat(str(raw_claim))
            except ValueError:
                return {"ok": False, "reason": f"{who}: the claim date is not a valid date."}
            if (claim_date.year, claim_date.month) != (ot_date.year, ot_date.month):
                return {"ok": False, "reason": f"{who}: the date it is granted must be in the same month as the overtime."}
        if mode == OvertimeRecord.TYPE_RELAXATION:
            if claim_date is None:
                return {"ok": False, "reason": f"{who}: choose the date the relaxation (day off) is granted for."}
            try:
                check_relaxation_day(rec.employee, claim_date, shifts, settings=settings)
            except RelaxationRefused as exc:
                return {"ok": False, "reason": f"{who}: {exc}"}

        rec.status = OvertimeRecord.STATUS_ANNOUNCED
        rec.compensation_type = mode
        rec.shifts = shifts
        rec.claim_date = claim_date
        rec.announced_by = actor
        rec.announced_at = timezone.now()
        rec.save()
        if mode == OvertimeRecord.TYPE_RELAXATION:
            apply_relaxation(
                rec.employee, claim_date, shifts, f"the overtime of {ot_date.strftime('%d %b %Y')}", settings=settings
            )
    log_action(
        request, "assign", "compensation", record_id=rec.id,
        description=(
            f"Assigned {shifts:.2f} shift of overtime compensation to {rec.employee.employee_code} for "
            f"{ot_date} as {mode}" + (f", granted on {claim_date}" if claim_date else "")
        ),
        new_values={
            "employeeId": rec.employee_id, "date": str(ot_date), "mode": mode, "shifts": float(shifts),
            "claimDate": str(claim_date) if claim_date else None,
        },
    )
    return {"ok": True, "record": rec}


@api_view(["POST"])
@require_hr
@require_compensation_features_for_changes
def overtime_assign(request: Request) -> Response:
    """Body: {records: [{employeeId, date, shifts?, claimDate?}], mode: "relaxation" | "pay", shifts?, claimDate?}.

    HR assigns Type 2 (shift-based) compensation. `mode` must be one of the modes switched on in Settings > Compensation.
    Per record: `shifts` (0.25 | 0.50 | 0.75 | 1; default = the suggested shifts), `claimDate` (the date it is granted:
    any date in the SAME MONTH as the overtime, past or future; REQUIRED for relaxation, optional for pay). A request-level
    problem is a 400; a record that cannot be assigned is reported in `skipped` (with the reason) and the rest still
    are. If nothing could be assigned the answer is a 400 carrying the first reason. Relaxation is applied to the claim
    date straight away (see compensation_apply.py); pay is picked up by the month's payroll. One assignment per record.
    At most MAX_ASSIGN_RECORDS records per request (each relaxation re-computes the day it is granted on)."""
    data = request.data if isinstance(request.data, dict) else {}
    items = data.get("records") or []
    if not isinstance(items, list) or not items:
        return Response({"error": "No records specified"}, status=400)
    if len(items) > MAX_ASSIGN_RECORDS:
        return Response({"error": f"At most {MAX_ASSIGN_RECORDS} records can be assigned in one request."}, status=400)
    mode = data.get("mode")
    if mode not in MODES:
        return Response({"error": "mode must be 'relaxation' or 'pay'"}, status=400)
    config = CompensationConfig.get()
    if not config.shift_enabled:
        return Response(
            {"error": "Shift-based compensation (Type 2) is switched off in Settings > Compensation."}, status=403
        )
    if mode == OvertimeRecord.TYPE_RELAXATION and not config.relaxation_enabled:
        return Response({"error": "Relaxation (a day off) is switched off in Settings > Compensation."}, status=403)
    if mode == OvertimeRecord.TYPE_PAY and not config.pay_enabled:
        return Response({"error": "Payment is switched off in Settings > Compensation."}, status=403)
    if "shifts" in data and data.get("shifts") not in (None, "") and rules.normalise_shifts(data.get("shifts")) is None:
        return Response({"error": "shifts must be one of 0.25, 0.50, 0.75 or 1"}, status=400)

    allowed = set(scope_to_branch(Employee.objects, request).values_list("id", flat=True))
    actor = get_hr_display_name(request)
    settings = PayrollSettings.get()
    assigned, skipped = [], []
    for item in items:
        emp_id = _int_or_none(item.get("employeeId")) if isinstance(item, dict) else None
        if emp_id is None or emp_id not in allowed:
            skipped.append({
                "employeeId": item.get("employeeId") if isinstance(item, dict) else None,
                "date": item.get("date") if isinstance(item, dict) else None,
                "reason": "No overtime record found for that employee and date.",
            })
            continue
        result = _assign_one(request, emp_id, item, mode, data.get("shifts"), data.get("claimDate"), actor, settings)
        if result["ok"]:
            assigned.append(result["record"])
        else:
            skipped.append({"employeeId": item.get("employeeId"), "date": item.get("date"), "reason": result["reason"]})
    if not assigned:
        return Response({"error": skipped[0]["reason"], "assigned": 0, "skipped": skipped}, status=400)
    return Response({"assigned": len(assigned), "results": [_ot_dict(r) for r in assigned], "skipped": skipped})


@api_view(["POST"])
@require_hr
@require_compensation_features_for_changes
def overtime_announce(request: Request) -> Response:
    """LEGACY endpoint, kept for clients from before the overhaul. Body: {records: [{employeeId, date}],
    compensationType?}. Confirms Pay or Relaxation for each detected record -nothing is paid/credited until this runs.
    compensationType defaults to the live Settings value; HR may override it for this batch.

    A legacy record keeps its old meaning exactly (pay = one day's salary, relaxation = one compensation credit). A Type 2
    record is mapped onto the new assignment with its SUGGESTED shifts: pay as in assign; relaxation without a claim date
    becomes shifts added to the employee's compensation balance (a ledger credit HR can redeem on any date). Type 1 rows
    are automatic and are skipped.

    Goes through the same gates as the new assign: only the caller's own branch and only staff; a Type 2 record also needs
    Type 2 (and the chosen mode) switched on in Settings > Compensation, exactly as assign does (a record from before the
    overhaul keeps its old meaning and needs none of them). Each record is decided under a row lock and re-checked as still
    "detected" after it, so a double submit or two HR users can never credit it twice or overwrite an assignment."""
    from django.utils import timezone

    data = request.data if isinstance(request.data, dict) else {}
    items = data.get("records") or []
    if not isinstance(items, list) or not items:
        return Response({"error": "No records specified"}, status=400)

    settings = PayrollSettings.get()
    config = CompensationConfig.get()
    comp_type = data.get("compensationType") or settings.ot_compensation_type
    if comp_type not in (OvertimeRecord.TYPE_PAY, OvertimeRecord.TYPE_RELAXATION):
        return Response({"error": "compensationType must be 'pay' or 'relaxation'"}, status=400)

    allowed = set(scope_to_branch(Employee.objects.filter(employment_type="staff"), request).values_list("id", flat=True))
    actor = get_hr_display_name(request)
    announced = []
    for item in items:
        emp_id = _int_or_none(item.get("employeeId")) if isinstance(item, dict) else None
        ot_date = parse_date(item.get("date")) if isinstance(item, dict) else None
        if emp_id is None or emp_id not in allowed or ot_date is None:
            continue
        with transaction.atomic():
            # employee first, then the record: the one lock order every writer here uses (a ledger credit is inserted
            # below, and that insert needs a share lock on the employee row an assign / redemption holds)
            Employee.objects.select_for_update().filter(pk=emp_id).first()
            rec = (
                OvertimeRecord.objects.select_for_update(of=("self",))
                .select_related("employee", "employee__department")
                .filter(employee_id=emp_id, date=ot_date, status=OvertimeRecord.STATUS_DETECTED)
                .first()
            )
            if rec is None:
                continue  # not there, not undecided any more (somebody got there first), or not this person's
            if rec.ot_type == OvertimeRecord.OT_TYPE_SHIFT:
                if rec.suggested_shifts is None or not config.shift_enabled:
                    continue
                if comp_type == OvertimeRecord.TYPE_RELAXATION and not config.relaxation_enabled:
                    continue
                if comp_type == OvertimeRecord.TYPE_PAY and not config.pay_enabled:
                    continue
                rec.shifts = rec.suggested_shifts
            rec.status = OvertimeRecord.STATUS_ANNOUNCED
            rec.compensation_type = comp_type
            rec.announced_by = actor
            rec.announced_at = timezone.now()
            rec.save()
            if comp_type == OvertimeRecord.TYPE_RELAXATION:
                if rec.ot_type == OvertimeRecord.OT_TYPE_SHIFT:
                    CompensationLedger.objects.create(
                        employee=rec.employee, entry_type=CompensationLedger.ENTRY_CREDIT, shifts=rec.shifts,
                        date=rec.date, source="ot_shift", overtime_record=rec, created_by=actor,
                        note="Overtime relaxation announced without a date: added to the balance",
                    )
                else:
                    CompensationLeaveCredit.objects.create(employee=rec.employee, source_overtime_record=rec)
        announced.append(rec)
        log_action(
            request, "announce", "compensation", record_id=rec.id,
            description=(
                f"Announced overtime of {rec.employee.employee_code} on {rec.date} as {comp_type}"
                + (f": {rec.shifts:.2f} shift" if rec.shifts is not None else ": one day")
            ),
            new_values={
                "employeeId": rec.employee_id, "date": str(rec.date), "mode": comp_type,
                "shifts": float(rec.shifts) if rec.shifts is not None else None, "otType": rec.ot_type,
            },
        )
    return Response({"announced": len(announced), "results": [_ot_dict(r) for r in announced]})


@api_view(["POST"])
@require_hr
@require_compensation_features_for_changes
def overtime_reject(request: Request) -> Response:
    """Body: {records: [{employeeId, date}]}. Dismisses a detected record
    (e.g. an HR-authorized late stay that isn't real OT) -no further action. Only the caller's own branch and only staff;
    only a record that is still "detected" (the update names that status, so a record somebody assigned a moment ago is
    never turned into a rejection). One audit entry per record."""
    data = request.data if isinstance(request.data, dict) else {}
    items = data.get("records") or []
    if not isinstance(items, list):
        return Response({"error": "records must be a list"}, status=400)
    allowed = set(scope_to_branch(Employee.objects.filter(employment_type="staff"), request).values_list("id", flat=True))
    count = 0
    for item in items:
        emp_id = _int_or_none(item.get("employeeId")) if isinstance(item, dict) else None
        ot_date = parse_date(item.get("date")) if isinstance(item, dict) else None
        if emp_id is None or emp_id not in allowed or ot_date is None:
            continue
        rec = (
            OvertimeRecord.objects.select_related("employee")
            .filter(employee_id=emp_id, date=ot_date, status=OvertimeRecord.STATUS_DETECTED)
            .first()
        )
        if rec is None:
            continue
        updated = OvertimeRecord.objects.filter(pk=rec.pk, status=OvertimeRecord.STATUS_DETECTED).update(
            status=OvertimeRecord.STATUS_REJECTED
        )
        if updated:
            count += updated
            log_action(
                request, "reject", "compensation", record_id=rec.id,
                description=f"Rejected overtime of {rec.employee.employee_code} on {ot_date}",
                new_values={"employeeId": emp_id, "date": str(ot_date)},
            )
    return Response({"rejected": count})


# ──────────────────────────────────────────────
#  Compensation balance (shifts): credits, redemptions
# ──────────────────────────────────────────────

def _entry_dict(e: CompensationLedger) -> dict:
    return {
        "id": e.id,
        "type": e.entry_type,
        "shifts": float(e.shifts),
        "date": str(e.date),
        "source": e.source,
        "note": e.note,
        "createdBy": e.created_by,
        "createdAt": e.created_at.isoformat() if e.created_at else None,
        # a debit that only mirrors a legacy credit being used is not subtracted a second time
        "counted": not (e.entry_type == CompensationLedger.ENTRY_DEBIT and e.source == "legacy_credit"),
    }


@api_view(["GET"])
@require_hr
@require_compensation_features_for_changes
def compensation_balance(request: Request) -> Response:
    """GET ?employeeId=N -> that employee's compensation balance in shifts and every entry (ledger credits and debits,
    plus each still-available legacy credit as a 1.00 credit with source "legacy_credit"). Without employeeId: the
    employees that have a balance or any entry, with their balance. Staff only, branch-scoped."""
    from .compensation_apply import balances_for

    scope = scope_to_branch(Employee.objects.filter(employment_type="staff"), request)
    emp_id = request.query_params.get("employeeId")
    if emp_id:
        emp_id = _int_or_none(emp_id)
        if emp_id is None:
            return Response({"error": "employeeId must be a number"}, status=400)
        emp = scope.filter(id=emp_id).select_related("department").first()
        if emp is None:
            return Response({"error": "Employee not found"}, status=404)
        entries = [_entry_dict(e) for e in CompensationLedger.objects.filter(employee=emp).order_by("-date", "-id")]
        for credit in CompensationLeaveCredit.objects.filter(
            employee=emp, status=CompensationLeaveCredit.STATUS_AVAILABLE
        ).select_related("source_overtime_record"):
            entries.append({
                "id": None, "type": "credit", "shifts": 1.0,
                "date": str(credit.source_overtime_record.date) if credit.source_overtime_record else str(credit.created_at.date()),
                "source": "legacy_credit", "note": "Alternative Day credit from an earlier overtime announcement",
                "createdBy": None, "createdAt": credit.created_at.isoformat() if credit.created_at else None,
                "counted": True, "legacyCreditId": credit.id,
            })
        balance = balances_for([emp.pk]).get(emp.pk, Decimal("0.00"))
        return Response({
            "employeeId": emp.id, "employeeCode": emp.employee_code,
            "employeeName": f"{emp.first_name} {emp.last_name}",
            "balance": float(balance), "entries": entries,
        })

    ids_with_entries = set(CompensationLedger.objects.values_list("employee_id", flat=True)) | set(
        CompensationLeaveCredit.objects.filter(status=CompensationLeaveCredit.STATUS_AVAILABLE).values_list(
            "employee_id", flat=True
        )
    )
    employees = {e.id: e for e in scope.filter(id__in=ids_with_entries).select_related("department")}
    balances = balances_for(employees.keys())
    rows = [
        {
            "employeeId": e.id, "employeeCode": e.employee_code, "employeeName": f"{e.first_name} {e.last_name}",
            "department": e.department.name if e.department else None, "balance": float(balances.get(e.id, 0)),
        }
        for e in sorted(employees.values(), key=lambda e: e.employee_code)
    ]
    return Response({"results": rows, "count": len(rows)})


@api_view(["POST"])
@require_hr
@require_compensation_features_for_changes
def balance_redeem(request: Request) -> Response:
    """Body: {employeeId, date, shifts}. HR redeems `shifts` (0.25 | 0.50 | 0.75 | 1) of the employee's compensation
    balance on `date`: a ledger debit, and the day is topped up by that much (never above 1.00 shift, never on a Sunday /
    holiday: see compensation_apply.py). More than the balance is refused. Employees never redeem themselves."""
    from .compensation_apply import RelaxationRefused, apply_relaxation, balance_of, check_relaxation_day

    data = request.data if isinstance(request.data, dict) else {}
    raw_id = data.get("employeeId")
    emp_id = _int_or_none(raw_id)
    if raw_id not in (None, "") and emp_id is None:
        return Response({"error": "employeeId must be a number"}, status=400)
    emp = scope_to_branch(Employee.objects, request).filter(id=emp_id).first() if emp_id is not None else None
    if emp is None:
        return Response({"error": "Employee not found"}, status=404)
    try:
        day = date_type.fromisoformat(str(data.get("date")))
    except (TypeError, ValueError):
        return Response({"error": "date is required (YYYY-MM-DD)"}, status=400)
    shifts = rules.normalise_shifts(data.get("shifts"))
    if shifts is None:
        return Response({"error": "shifts must be one of 0.25, 0.50, 0.75 or 1"}, status=400)

    actor = get_hr_display_name(request)
    settings = PayrollSettings.get()
    with transaction.atomic():
        # lock the employee so two redemptions can never spend the same balance
        locked = Employee.objects.select_for_update().get(pk=emp.pk)
        balance = balance_of(locked)
        if shifts > balance:
            return Response(
                {"error": f"The balance is {balance:.2f} shift, so {shifts:.2f} cannot be redeemed.", "balance": float(balance)},
                status=400,
            )
        try:
            check_relaxation_day(locked, day, shifts, settings=settings)
        except RelaxationRefused as exc:
            return Response({"error": str(exc), "balance": float(balance)}, status=400)
        entry = CompensationLedger.objects.create(
            employee=locked, entry_type=CompensationLedger.ENTRY_DEBIT, shifts=shifts, date=day,
            source="redemption", created_by=actor, note=f"Redeemed on {day}",
        )
        apply_relaxation(locked, day, shifts, "the compensation balance", settings=settings)
    log_action(
        request, "redeem", "compensation", record_id=entry.id,
        description=f"Redeemed {shifts:.2f} shift of compensation balance for {emp.employee_code} on {day}",
        new_values={"employeeId": emp.id, "date": str(day), "shifts": float(shifts)},
    )
    return Response({"entry": _entry_dict(entry), "balance": float(balance - shifts)}, status=201)


# ──────────────────────────────────────────────
#  Relaxation/Alternative-Day credits
# ──────────────────────────────────────────────

def _credit_dict(c: CompensationLeaveCredit) -> dict:
    emp = c.employee
    return {
        "id": c.id,
        "employeeId": emp.id,
        "employeeCode": emp.employee_code,
        "employeeName": f"{emp.first_name} {emp.last_name}",
        "status": c.status,
        "usedDate": str(c.used_date) if c.used_date else None,
        "sourceDate": str(c.source_overtime_record.date) if c.source_overtime_record else None,
        "createdAt": c.created_at.isoformat() if c.created_at else None,
    }


@api_view(["GET"])
@require_hr
@require_compensation_features_for_changes
def compensation_credits_list(request: Request) -> Response:
    emp_ids = scope_to_branch(Employee.objects, request).values_list("id", flat=True)
    qs = CompensationLeaveCredit.objects.select_related("employee", "source_overtime_record").filter(
        employee_id__in=emp_ids,
    )
    status = request.query_params.get("status")
    if status:
        qs = qs.filter(status=status)
    emp_id = request.query_params.get("employeeId")
    if emp_id:
        emp_id = _int_or_none(emp_id)
        if emp_id is None:
            return Response({"error": "employeeId must be a number"}, status=400)
        qs = qs.filter(employee_id=emp_id)
    rows = [_credit_dict(c) for c in qs.order_by("-created_at")]
    return Response({"results": rows, "count": len(rows)})


@api_view(["POST"])
@require_hr
@require_compensation_features_for_changes
def compensation_credit_redeem(request: Request, pk: int) -> Response:
    """Body: {date}. HR redeems an available credit on the employee's behalf
    (per the requirement that employees cannot self-assign compensation) -
    writes that date's attendance as a paid day off, same pattern as
    casual_leave_views._write_attendance_for_cl.

    Goes through the same gates as the balance redemption: the caller's own branch, staff only, the employee row locked and
    the credit re-read under that lock, and the credit may only be spent while the compensation balance still holds the
    shift it counts for (balance_of counts every available credit as one shift, so a credit whose shift was already taken
    through the balance redemption is refused instead of being paid a second time)."""
    from .attendance_final import compute_day_record
    from .compensation_apply import balance_of

    credit = scope_to_branch(
        CompensationLeaveCredit.objects.select_related("employee").filter(
            pk=pk, status=CompensationLeaveCredit.STATUS_AVAILABLE
        ),
        request,
        field="employee__branch_id",
    ).first()
    if not credit:
        return Response({"error": "Credit not found or already used"}, status=404)

    redeem_date_str = request.data.get("date") if isinstance(request.data, dict) else None
    if not redeem_date_str:
        return Response({"error": "date is required"}, status=400)
    redeem_date = parse_date(redeem_date_str)
    if redeem_date is None:
        return Response({"error": "date must be a date (YYYY-MM-DD)"}, status=400)

    actor = get_hr_display_name(request)
    with transaction.atomic():
        # employee first (the lock a balance redemption takes), then the credit, re-read under it
        employee = Employee.objects.select_for_update().get(pk=credit.employee_id)
        credit = (
            CompensationLeaveCredit.objects.select_for_update(of=("self",))
            .filter(pk=pk, status=CompensationLeaveCredit.STATUS_AVAILABLE)
            .first()
        )
        if credit is None:
            return Response({"error": "Credit not found or already used"}, status=404)
        credit.employee = employee
        if employee.employment_type != "staff":
            return Response({"error": "Compensation applies to staff employees only."}, status=400)
        pool = balance_of(employee)
        if pool < Decimal("1.00"):
            return Response(
                {
                    "error": (
                        f"The compensation balance is {pool:.2f} shift, so this Alternative Day credit can no longer be "
                        "redeemed: its shift was already taken through the balance."
                    ),
                    "balance": float(pool),
                },
                status=400,
            )

        record = AttendanceDayRecord.objects.filter(employee=employee, date=redeem_date).first()
        if record is None:
            record = compute_day_record(employee, redeem_date)

        record.status = "present"
        record.shifts_earned = Decimal("1.00")
        record.is_late = False
        record.early_leave = False  # a paid day carries no late/early-out mark -this row is never recomputed
        record.late_reason = None
        record.is_half_shift = False
        record.override_note = "Compensation Alternative Day (paid) -redeemed"
        record.source = "manual"
        record.override_by = actor
        record.compensation_kind = "relaxation"
        record.compensation_minutes = 0
        record.compensation_note = "Compensation relaxation: 1.00 shift added from an Alternative Day credit"
        record.save()

        credit.status = CompensationLeaveCredit.STATUS_USED
        credit.used_date = redeem_date
        credit.save()
        # The use is mirrored in the ledger (a debit that is not subtracted from the balance a second time: the credit's own
        # status already took it out of the balance). The day above is a manual row, so the engine never tops it up again.
        CompensationLedger.objects.create(
            employee=employee, entry_type=CompensationLedger.ENTRY_DEBIT, shifts=Decimal("1.00"),
            date=redeem_date, source="legacy_credit", created_by=actor, note=f"Alternative Day credit {credit.id} used",
        )

    log_action(
        request, "redeem", "compensation", record_id=credit.id,
        description=f"Redeemed Alternative Day for {credit.employee.employee_code} on {redeem_date}",
    )
    return Response(_credit_dict(credit))


# ──────────────────────────────────────────────
#  Compensation-Leave (HR-announced day, real punches still decide Full/Half)
# ──────────────────────────────────────────────

def _leave_day_dict(a: CompensationDayAnnouncement) -> dict:
    return {
        "id": a.id,
        "kind": a.kind,
        "date": str(a.date),
        "allowedTime": a.allowed_time.strftime("%H:%M") if a.allowed_time else None,
        "leaveUntilTime": a.leave_until_time.strftime("%H:%M") if a.leave_until_time else None,
        "branch": a.branch.name if a.branch else None,
        "department": a.department.name if a.department else None,
        "employeeIds": list(a.employees.values_list("id", flat=True)),
        "employeeCount": a.employees.count(),
        "reason": a.reason,
        "announcedBy": a.announced_by,
        "createdAt": a.created_at.isoformat() if a.created_at else None,
    }


def _legacy_day_scope(request: Request, data: dict) -> tuple[dict | None, Response | None]:
    """(scope, None) with branch_id / department_id / employee_ids to store, or (None, the refusal): the same ownership rules
    as the new windows. A branch-scoped login announces for its own branch only (the row is stamped with it: it is never a
    company-wide exemption), and the employees it lists must be active staff of that branch; a department must exist."""
    branch_scope = get_branch_scope(request)
    raw_branch = data.get("branchId")
    branch_id = _int_or_none(raw_branch)
    if raw_branch not in (None, "", 0) and branch_id is None:
        return None, Response({"error": "branchId must be a number"}, status=400)
    raw_department = data.get("departmentId")
    department_id = _int_or_none(raw_department)
    if raw_department not in (None, "", 0) and department_id is None:
        return None, Response({"error": "departmentId must be a number"}, status=400)
    raw_ids = data.get("employeeIds") or []
    if not isinstance(raw_ids, list):
        return None, Response({"error": "employeeIds must be a list of employee ids"}, status=400)
    employee_ids = [_int_or_none(i) for i in raw_ids]
    if any(i is None for i in employee_ids):
        return None, Response({"error": "employeeIds must be employee ids"}, status=400)
    employee_ids = list(dict.fromkeys(employee_ids))
    if employee_ids:
        staff = set(
            scope_to_branch(Employee.objects.filter(pk__in=employee_ids), request)
            .filter(employment_type="staff", status="active")
            .values_list("pk", flat=True)
        )
        missing = [i for i in employee_ids if i not in staff]
        if missing:
            return None, Response(
                {
                    "error": "Only active staff members in your branch can be listed: these ids are not (production "
                    f"employees, inactive or unknown people): {', '.join(str(i) for i in missing[:10])}."
                },
                status=400,
            )
    if branch_scope is not None:
        if branch_id not in (None, branch_scope):
            return None, Response({"error": "You can only announce for your own branch."}, status=403)
        branch_id = branch_scope
    if branch_id is not None and not Branch.objects.filter(pk=branch_id).exists():
        return None, Response({"error": "Branch not found."}, status=404)
    if department_id is not None and not Department.objects.filter(pk=department_id).exists():
        return None, Response({"error": "Department not found."}, status=404)
    return {"branch_id": branch_id, "department_id": department_id, "employee_ids": employee_ids}, None


@api_view(["GET", "POST"])
@require_hr
@require_compensation_features_for_changes
def compensation_leave_days(request: Request) -> Response:
    if request.method == "GET":
        from .compensation_windows_views import visible_announcements

        qs = CompensationDayAnnouncement.objects.select_related("branch", "department").prefetch_related("employees")
        # a branch-scoped login sees its own branch's announcements and the company-wide ones, like the windows list
        qs = visible_announcements(qs, get_branch_scope(request))
        for name, lookup in (("year", "date__year"), ("month", "date__month")):
            raw = request.query_params.get(name)
            if raw:
                value = _int_or_none(raw)
                if value is None:
                    return Response({"error": f"{name} must be a number"}, status=400)
                qs = qs.filter(**{lookup: value})
        rows = [_leave_day_dict(a) for a in qs.order_by("-date")]
        return Response({"results": rows, "count": len(rows)})

    data = request.data if isinstance(request.data, dict) else {}
    date_str = data.get("date")
    if not date_str:
        return Response({"error": "date is required"}, status=400)
    day = parse_date(date_str)
    if day is None:
        return Response({"error": "date must be a date (YYYY-MM-DD)"}, status=400)

    # The legacy Compensation Day only. Company-announced late-in / early-out windows are made through
    # /api/compensation/windows (compensation_windows_views.py), which carries their own rules.
    if (data.get("kind") or CompensationDayAnnouncement.KIND_DAY) != CompensationDayAnnouncement.KIND_DAY:
        return Response(
            {"error": "Late-in / early-out announcements are made at /api/compensation/windows."}, status=400
        )
    leave_until_raw = data.get("leaveUntilTime") or None
    leave_until_time = parse_time(leave_until_raw) if leave_until_raw else None
    if leave_until_raw and leave_until_time is None:
        return Response({"error": "leaveUntilTime must be a time like 16:00 (HH:MM)"}, status=400)
    scope, refusal = _legacy_day_scope(request, data)
    if refusal is not None:
        return refusal

    # the row and its employee list are created together: a failure between them must never leave a row with an empty list
    # (which the engine reads as "everybody")
    with transaction.atomic():
        ann = CompensationDayAnnouncement.objects.create(
            date=day,
            leave_until_time=leave_until_time,
            branch_id=scope["branch_id"],
            department_id=scope["department_id"],
            reason=data.get("reason") or None,
            announced_by=get_hr_display_name(request),
        )
        if scope["employee_ids"]:
            ann.employees.set(scope["employee_ids"])

    log_action(
        request, "create", "compensation", record_id=ann.id,
        description=f"Announced Compensation Day for {ann.date}",
    )
    return Response(_leave_day_dict(ann), status=201)


@api_view(["DELETE"])
@require_hr
@require_compensation_features_for_changes
def compensation_leave_day_detail(request: Request, pk: int) -> Response:
    """Removes a legacy Compensation Day (kind "day") for a FUTURE date (India's calendar: today's has already been acted
    on). A late-in / early-out window is not a Compensation Day: it is removed at /api/compensation/windows/<id>, which
    carries the windows rules (the Windows switch, the branch ownership); a branch-scoped login cannot remove a
    company-wide or another branch's announcement."""
    ann = CompensationDayAnnouncement.objects.prefetch_related("employees").filter(pk=pk).first()
    if not ann:
        return Response({"error": "Not found"}, status=404)
    if ann.kind != CompensationDayAnnouncement.KIND_DAY:
        return Response(
            {"error": "That is a late-in / early-out window: remove it at /api/compensation/windows/<id>."}, status=404
        )
    if ann.date <= ist_today():
        return Response({"error": "Cannot delete a past or today's announcement"}, status=400)
    scope = get_branch_scope(request)
    if scope is not None:
        listed = list(ann.employees.all())
        if not (ann.branch_id == scope or (listed and all(e.branch_id == scope for e in listed))):
            return Response(
                {"error": "This announcement belongs to the whole company or another branch: only its owner can remove it."},
                status=403,
            )
    ann.delete()
    log_action(request, "delete", "compensation", record_id=pk, description="Removed Compensation Day announcement")
    return Response(status=204)


# ──────────────────────────────────────────────
#  Cost + benefit/non-benefit summary (History & Reports)
# ──────────────────────────────────────────────

def _compensation_summary_data(emp_ids: set[int], month: int, year: int) -> dict:
    """
    Cost + benefit/non-benefit breakdown for one month. Pulled out of the
    view so it can be unit-tested directly without an authenticated request
    (see tests_zone_boundary.py).

    `paidCost` is the real, exact sum of OT amounts already reflected in
    generated SalarySlips this month -authoritative, whatever payroll
    actually paid. `pendingCostEstimate` is a labeled ESTIMATE
    (salary_amount / 30 per announced-but-unpaid day) for planning only -it
    is not the exact figure the next payroll run will produce, since that
    depends on the period's real working-day calendar
    (_build_working_days/_generate_staff_payroll).

    "Benefiting" = Pay already paid in a generated slip, or a Relaxation
    credit already redeemed. "Not benefiting" = announced but not yet
    realized (awaiting payroll, or an unredeemed credit).
    """
    ot_records = list(
        OvertimeRecord.objects.filter(
            employee_id__in=emp_ids, date__year=year, date__month=month,
            status=OvertimeRecord.STATUS_ANNOUNCED,
        ).select_related("employee").order_by("date")
    )
    slips_by_emp = {
        s.employee_id: s
        for s in SalarySlip.objects.filter(employee_id__in=emp_ids, year=year, month=month, week_number=None)
    }
    credits_by_record = {
        c.source_overtime_record_id: c
        for c in CompensationLeaveCredit.objects.filter(source_overtime_record__in=ot_records)
    }

    paid_cost = Decimal("0")
    pending_cost = Decimal("0")
    paid_employee_ids: set[int] = set()
    benefiting = []
    not_benefiting = []

    for rec in ot_records:
        emp = rec.employee
        row = {
            "employeeId": emp.id, "employeeCode": emp.employee_code,
            "employeeName": f"{emp.first_name} {emp.last_name}",
            "type": rec.compensation_type, "date": str(rec.date),
        }
        if rec.compensation_type == OvertimeRecord.TYPE_PAY:
            slip = slips_by_emp.get(emp.id)
            if slip and slip.ot_amount and slip.ot_amount > 0:
                if emp.id not in paid_employee_ids:
                    paid_cost += slip.ot_amount
                    paid_employee_ids.add(emp.id)
                benefiting.append({**row, "detail": f"Paid {float(slip.ot_amount)} in {month}/{year} payroll"})
            else:
                daily_estimate = _d2((emp.salary_amount or Decimal("0")) / Decimal("30") * (rec.shifts or Decimal("1")))
                pending_cost += daily_estimate
                not_benefiting.append({**row, "detail": "Awaiting next payroll run"})
        elif rec.compensation_type == OvertimeRecord.TYPE_RELAXATION and rec.claim_date is not None:
            # a Type 2 relaxation is applied to its claim date as soon as HR assigns it
            benefiting.append({**row, "detail": f"{rec.shifts or 0} shift of relaxation granted for {rec.claim_date}"})
        elif rec.compensation_type == OvertimeRecord.TYPE_RELAXATION:
            credit = credits_by_record.get(rec.id)
            if credit and credit.status == CompensationLeaveCredit.STATUS_USED:
                benefiting.append({**row, "detail": f"Alternative Day taken on {credit.used_date}"})
            else:
                not_benefiting.append({**row, "detail": "Credit not yet redeemed"})

    return {
        "month": month, "year": year,
        "paidCost": float(_d2(paid_cost)),
        "pendingCostEstimate": float(_d2(pending_cost)),
        "benefiting": benefiting,
        "notBenefiting": not_benefiting,
    }


@api_view(["GET"])
@require_hr
@require_compensation_features_for_changes
def compensation_summary(request: Request) -> Response:
    today = date_type.today()
    year = int(request.query_params.get("year") or today.year)
    month = int(request.query_params.get("month") or today.month)
    emp_ids = set(scope_to_branch(Employee.objects, request).values_list("id", flat=True))
    return Response(_compensation_summary_data(emp_ids, month, year))

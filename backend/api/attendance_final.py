"""
Final Attendance Engine -mode-aware day computation + HR overrides
===================================================================

Produces one AttendanceDayRecord per employee per day. This table is the
single source of truth for Payroll/Salary:

  • source == "auto"   → computed from punches using the mode selected in
                          Settings (strict | simple)
  • source == "manual" → HR override; NEVER recomputed automatically

Staff. Three independent axes, identical in Simple and Strict mode (Strict
additionally tracks a fourth, unrelated lunch-return axis -see
shift_engine.py):

  • Half-Day Detection (REPLACES the old punctuality-window Full/Half/Absent
    rule entirely) → any punch before PayrollSettings.half_day_first_half_
    end_time (default 13:30) counts as the whole Morning Half attended; any
    punch at/after half_day_second_half_start_time (default 14:30) counts as
    the whole Evening Half attended. Both halves → Full Day (1.00); one →
    Half Day (0.50); neither → Absent (0.00). See _half_day_status.
  • Late Detection: Morning Late-In / Evening Early-Out (see
    shift_engine.morning_late_in/evening_early_out) -independently
    toggleable (PayrollSettings.morning_late_in_enabled/evening_early_out_
    enabled), judged against the shift's own start/end + grace, OR that
    day's PERMISSION-SHIFTED effective boundary when an approved, in-cap
    Morning Late-In/Evening Early-Out permission applies -see
    _permissions_for_day / _effective_shift_for_day. Completely orthogonal to
    Half-Day status: a very late arrival that still beats the Half-Day
    cutoff is Full Day AND Late, never auto-demoted.
  • Permission: 3 canonical types (EmployeePermission.TYPE_CHOICES), capped
    at PayrollSettings.permission_monthly_cap (default 3) per calendar
    month, counted earliest-first. An approved permission beyond the cap is
    still approved (HR's call, logged for audit) but does not shift any
    boundary -that day is judged against the plain shift time like an
    ordinary unexcused occurrence. Middle One-Hour never shifts a boundary,
    in or out of the cap -see PayrollSettings for the full policy write-up.

production:     1.5-shift day (works in both modes):
                • first half   08:30–12:30  → 0.50
                • second half  13:30–17:30  → 0.50
                • extra half   17:50–20:00  → 0.50
                windows configurable in PayrollSettings. Entirely separate
                from the staff rules above -no Half-Day/Late Detection/
                Permission concept applies to production.
"""

import calendar
from datetime import date as date_type, datetime, timedelta
from decimal import Decimal
from functools import lru_cache

from django.db.models import Q

from .clock import ist_today
from .models import (
    AttendanceDayRecord, AttendanceLog, Attendance, Holiday,
    LeaveRequest, PayrollSettings, ProductionShiftConfig, ProductionShiftSegment,
)
from .shift_engine import (
    _get_shift_for_date, _t2s, _s2t,
    resolve_day_punch_logs, morning_late_in, evening_early_out,
)


# ── Helpers ────────────────────────────────────────────────────────────────

def _leave_dates_for_month(emp, year: int, month: int) -> set:
    """Set of date objects covered by approved FULL-day leave in the given
    month. Half-Day Leave rows are deliberately excluded (is_half_day=False)
    -see _half_day_leave_dates_for_month below, which handles those
    separately since a half day needs to carry which half, not just
    membership in a set."""
    first = date_type(year, month, 1)
    last = date_type(year, month, calendar.monthrange(year, month)[1])
    dates = set()
    for lr in LeaveRequest.objects.filter(employee=emp, status="approved", is_half_day=False):
        try:
            s = datetime.strptime(str(lr.start_date)[:10], "%Y-%m-%d").date()
            e = datetime.strptime(str(lr.end_date)[:10], "%Y-%m-%d").date()
        except (ValueError, TypeError):
            continue
        d = max(s, first)
        while d <= min(e, last):
            dates.add(d)
            d += timedelta(days=1)
    return dates


def _half_day_leave_dates_for_month(emp, year: int, month: int) -> dict:
    """{date: "morning"|"afternoon"} for approved Half-Day Leave in the given
    month -a half-day leave is always a single day (enforced at submission),
    so this is a lookup, not a range walk like _leave_dates_for_month."""
    first = date_type(year, month, 1)
    last = date_type(year, month, calendar.monthrange(year, month)[1])
    out: dict = {}
    for lr in LeaveRequest.objects.filter(employee=emp, status="approved", is_half_day=True):
        try:
            d = datetime.strptime(str(lr.start_date)[:10], "%Y-%m-%d").date()
        except (ValueError, TypeError):
            continue
        if first <= d <= last:
            out[d] = lr.half_day_slot
    return out


@lru_cache(maxsize=512)
def _holiday_dates_for_month(year: int, month: int) -> set:
    """Company-wide -identical for every employee, unlike
    _leave_dates_for_month/_half_day_leave_dates_for_month above. Cached
    since compute_month_records/compute_range_records call this once per
    employee: looping a few hundred employees over a month range otherwise
    reissues the exact same query that many times (see
    attendance_report_log_sheet, the worst offender -every employee in the
    roster, every request). Holiday CRUD (leave_views.py) clears this cache
    on create/update/delete so an edit takes effect immediately rather than
    waiting for a process restart."""
    return set(
        Holiday.objects.filter(date__year=year, date__month=month)
        .values_list("date", flat=True)
    )


def _resolve_primary_source(punch_logs, has_manual: bool = False) -> str | None:
    """
    Which RAW source tag this day's attendance actually came from -for
    display only, never used in shift-value math. Biometric always wins
    whenever it contributed anything that day (never silently overridden by
    a later or lesser source, per the "don't replace biometric data" rule),
    else On-Duty, else Geo Punch, else "manual" (a manual punch or a bare
    Attendance.present=True row from the Add Attendance button). Feed the
    result through geo_attendance_views.source_label() to get the display
    label -kept as two steps so callers that just need the raw tag (e.g.
    to reuse existing source_label() call sites) don't have to reverse a
    human label back into one.
    """
    sources = {p.source for p in punch_logs}
    if any(s.startswith("biometric") for s in sources):
        return "biometric"
    if "on_duty:approved" in sources:
        return "on_duty:approved"
    if "missing_punch:approved" in sources:
        return "missing_punch:approved"
    if "geo:auto" in sources:
        return "geo:auto"
    if sources or has_manual:
        return "manual"
    return None


def _sunday(d: date_type) -> bool:
    return d.weekday() == 6


def _compensation_days_by_date(date_from: date_type, date_to: date_type, settings=None) -> dict:
    """{date: [CompensationDayAnnouncement, ...]} for [date_from, date_to],
    with each announcement's explicit employee list prefetched -one round of
    queries for the whole range instead of one per employee-day. Empty when
    the Compensation feature is switched off (matches _compensation_day_for's
    own master-switch check)."""
    if settings is None:
        settings = PayrollSettings.get()
    if not settings.compensation_feature_enabled:
        return {}
    from .models import CompensationDayAnnouncement
    out: dict = {}
    for ann in CompensationDayAnnouncement.objects.filter(
        date__gte=date_from, date__lte=date_to,
    ).prefetch_related("employees"):
        out.setdefault(ann.date, []).append(ann)
    return out


def _compensation_day_for(emp, d: date_type, settings=None, prefetched=None):
    """
    The CompensationDayAnnouncement covering (emp, d), or None. Scoping
    (Holiday's nullable-FK convention, extended with an explicit employee
    list): an announcement applies to `emp` when either
      - `emp` is explicitly listed in `announcement.employees`, or
      - the employee list is empty AND emp's branch/department match
        whichever of `announcement.branch`/`announcement.department` are
        set (null on either axis = unscoped there).
    Announcements are rare, but this is called once per employee per day, so
    bulk callers pass `prefetched` ({date: [announcement, ...]} from
    _compensation_days_by_date, employees already prefetched) -otherwise a
    roster-wide month view issues one query per employee-day. Without it,
    it queries fresh per call (single-day callers).

    Master off-switch: PayrollSettings.compensation_feature_enabled. Checked
    here -the single choke point compute_day_record already goes through -
    so turning the Compensation feature off in Settings stops this exemption
    from applying at all, even though the CompensationDayAnnouncement rows
    themselves are left untouched in the database.
    """
    if settings is None:
        settings = PayrollSettings.get()
    if not settings.compensation_feature_enabled:
        return None
    if prefetched is not None:
        announcements = prefetched.get(d, [])
    else:
        from .models import CompensationDayAnnouncement
        announcements = CompensationDayAnnouncement.objects.filter(date=d).prefetch_related("employees")
    for ann in announcements:
        listed = {e.pk for e in ann.employees.all()}
        if emp.pk in listed:
            return ann
        if listed:
            continue
        if ann.branch_id and ann.branch_id != emp.branch_id:
            continue
        if ann.department_id and ann.department_id != emp.department_id:
            continue
        return ann
    return None


def _half_day_status(punch_times: list, settings, second_half_start_override=None) -> tuple:
    """
    (status, shifts_earned, is_half_shift) from punch PRESENCE alone -the
    same rule for Simple and Strict mode, replacing the old punctuality-
    window Full/Half/Absent decision entirely. Any punch strictly before
    half_day_first_half_end_time counts as the whole Morning Half attended;
    any punch at/after half_day_second_half_start_time counts as the whole
    Evening Half attended (a lone punch that falls inside the gap between
    the two, with no other punch, attends neither -Absent, not Half Day).

    `second_half_start_override` -a Compensation Day's `leave_until_time`
    replaces half_day_second_half_start_time as the Evening Half cutoff for
    that one day: staying through the announced early-release time still
    earns Full Day, but leaving well before it (the announcement is a
    release, not a blanket exemption) is still only a Half Day.
    """
    if not punch_times:
        return "absent", Decimal("0"), False
    first_end_s = _t2s(settings.half_day_first_half_end_time)
    second_start_s = _t2s(second_half_start_override or settings.half_day_second_half_start_time)
    # A punch is a clock time or, for one reattributed from the next calendar date (a 01:00 exit
    # is this working day's 25:00), already a count of seconds since this day's midnight.
    secs = [t if isinstance(t, int) else _t2s(t) for t in punch_times]
    morning = any(s < first_end_s for s in secs)
    evening = any(s >= second_start_s for s in secs)
    if morning and evening:
        return "present", Decimal("1.00"), False
    if morning or evening:
        return "half_shift", Decimal("0.50"), True
    return "absent", Decimal("0"), False


def infer_permission_type(permission_time, shift):
    """
    Best-effort permission type for a request saved with none -clients from before the rewrite
    (the employee web app, older backends) never sent one. The requested clock time is compared
    with the shift's own edges: within 90 minutes of the start (and nearer to it) is a Morning
    Late-In, within 90 minutes of the end an Evening Early-Out, anything else a Middle One-Hour
    Permission. None when there is not enough to go on (no time, or no shift that day).
    """
    from .models import EmployeePermission

    if permission_time is None or shift is None:
        return None
    t = _t2s(permission_time)
    start = _t2s(shift.start_time)
    end = _t2s(shift.end_time)
    if end <= start:  # overnight shift
        end += 86400
        if t < start:
            t += 86400
    d_start, d_end = abs(t - start), abs(end - t)
    window = 90 * 60
    if d_start <= window and d_start <= d_end:
        return EmployeePermission.TYPE_MORNING_LATE_IN
    if d_end <= window:
        return EmployeePermission.TYPE_EVENING_EARLY_OUT
    return EmployeePermission.TYPE_MIDDLE_PERMISSION


def _permission_kind(perm, shift_fn):
    """Canonical type of a permission row: its own (either spelling), else inferred from its time.
    `shift_fn` is a zero-arg callable so the shift is only looked up when inference is needed."""
    return perm.type_key or infer_permission_type(perm.permission_time, shift_fn() if shift_fn else None)


def permission_cap_status(perm, cap: int) -> str:
    """
    "within_cap" | "excess" for an APPROVED EmployeePermission -its position
    (earliest-first by date, id) among that employee's approved permissions
    in its own calendar month, against PayrollSettings.permission_monthly_
    cap. "not_applicable" for a pending/rejected one, which never shifts
    anything regardless of position. One COUNT query per call -list endpoints
    use bulk_permission_cap_status instead.
    """
    if perm.status != "approved":
        return "not_applicable"
    from .models import EmployeePermission
    earlier = EmployeePermission.objects.filter(
        employee_id=perm.employee_id, status="approved",
        date__year=perm.date.year, date__month=perm.date.month,
    ).filter(Q(date__lt=perm.date) | Q(date=perm.date, id__lt=perm.id)).count()
    return "within_cap" if earlier < max(0, cap) else "excess"


def bulk_permission_cap_status(perms, cap: int) -> dict:
    """{permission.id: "within_cap" | "excess" | "not_applicable"} for many permissions at once -
    one query for the whole batch instead of one COUNT per row (the HR permission list can hold
    thousands). Same ordering rule as permission_cap_status."""
    from .models import EmployeePermission

    perms = list(perms)
    out = {p.id: "not_applicable" for p in perms}
    approved = [p for p in perms if p.status == "approved"]
    if not approved:
        return out
    lo = min(p.date for p in approved).replace(day=1)
    hi_d = max(p.date for p in approved)
    hi = hi_d.replace(day=calendar.monthrange(hi_d.year, hi_d.month)[1])
    order: dict = {}
    for pid, eid, pd in EmployeePermission.objects.filter(
        employee_id__in={p.employee_id for p in approved}, status="approved", date__gte=lo, date__lte=hi,
    ).order_by("date", "id").values_list("id", "employee_id", "date"):
        order.setdefault((eid, pd.year, pd.month), []).append(pid)
    limit = max(0, cap)
    for p in approved:
        ids = order.get((p.employee_id, p.date.year, p.date.month), [])
        idx = ids.index(p.id) if p.id in ids else len(ids)
        out[p.id] = "within_cap" if idx < limit else "excess"
    return out


def _permissions_for_day(emp, d: date_type, cap: int, prefetch=None, shift_fn=None):
    """
    [(permission, kind, in_cap), ...] for EVERY approved EmployeePermission of (emp, d), lowest id
    first -staff only. An employee may legitimately hold a Morning Late-In AND an Evening
    Early-Out (and a Middle one) on the same day, so this returns them all -it used to keep only
    the last-updated one and silently ignore the rest.

    `kind` is the canonical type slug (either stored spelling is accepted; an untyped legacy row
    is inferred from its time -see infer_permission_type), or None when it cannot be determined
    -such a row shifts nothing but still counts toward the monthly cap. `in_cap` is whether it is
    one of the first `cap` approved permissions that calendar month, counted earliest-first by
    (date, id) -see PayrollSettings.permission_monthly_cap. Pending/rejected permissions are never
    returned (only "approved" rows are looked up), so they never shift a boundary.

    `prefetch`, when given, may contain "approved_permissions_by_date" ({date: [EmployeePermission,
    ...]}; a bare EmployeePermission per date is tolerated) and "approved_permissions_this_month"
    ({(year, month): [(date, id), ...]}, spanning the FULL calendar month(s) touched even when the
    caller's own range is narrower -cap position is always judged against the whole month).
    Falls back to fresh queries when omitted.
    """
    from .models import EmployeePermission

    prefetched = prefetch.get("approved_permissions_by_date") if prefetch else None
    if prefetched is not None:
        got = prefetched.get(d)
        perms = list(got) if isinstance(got, (list, tuple)) else ([got] if got is not None else [])
    else:
        perms = list(EmployeePermission.objects.filter(employee=emp, date=d, status="approved"))
    if not perms:
        return []
    perms.sort(key=lambda p: p.id)

    prefetched_month = prefetch.get("approved_permissions_this_month") if prefetch else None
    if prefetched_month is not None:
        ordered = prefetched_month.get((d.year, d.month), [])

        def earlier_count(p):
            return sum(1 for pd, pid in ordered if (pd, pid) < (d, p.id))
    else:
        month_qs = EmployeePermission.objects.filter(
            employee=emp, status="approved", date__year=d.year, date__month=d.month,
        )

        def earlier_count(p):
            return month_qs.filter(Q(date__lt=d) | Q(date=d, id__lt=p.id)).count()

    limit = max(0, cap)
    return [(p, _permission_kind(p, shift_fn), earlier_count(p) < limit) for p in perms]


def _effective_shift_for_day(shift, comp_day, day_perms):
    """
    Build this day's EFFECTIVE shift for Late Detection: a copy of `shift`
    with a Compensation Day's `leave_until_time` (end time) applied first,
    then, for each approved IN-CAP Morning Late-In / Evening Early-Out
    permission, that permission's fixed 60-minute boundary shift on top (one
    shift per edge, however many such permissions the day holds). Returns
    (effective_shift, applied_morning, applied_evening). Middle One-Hour never
    shifts anything. An Evening Early-Out permission is skipped (not applied)
    on a day that already has a Compensation Day end-time release -both would
    otherwise adjust the same end_time, and Compensation Day's "never
    penalized" release already takes precedence; Morning Late-In is
    unaffected by this since it only ever touches start_time.
    """
    from copy import copy
    from .models import EmployeePermission

    if shift is None:
        return None, False, False
    effective = shift
    comp_end_override = comp_day.leave_until_time if (comp_day and comp_day.leave_until_time) else None
    if comp_end_override:
        effective = copy(effective)
        effective.end_time = comp_end_override

    shift_secs = EmployeePermission.FIXED_DURATION_MINUTES * 60
    applied_morning = applied_evening = False
    for _perm, kind, in_cap in day_perms:
        if not in_cap:
            continue
        if kind == EmployeePermission.TYPE_MORNING_LATE_IN and not applied_morning:
            effective = copy(effective)
            effective.start_time = _s2t(_t2s(effective.start_time) + shift_secs)
            applied_morning = True
        elif kind == EmployeePermission.TYPE_EVENING_EARLY_OUT and not applied_evening and not comp_end_override:
            effective = copy(effective)
            effective.end_time = _s2t(max(0, _t2s(effective.end_time) - shift_secs))
            applied_evening = True
    return effective, applied_morning, applied_evening


def permission_flags_json(rec) -> dict:
    """
    The Late Detection / Permission flags of an AttendanceDayRecord (None = no record) as the
    camelCase keys every attendance endpoint returns -built in ONE place so no endpoint can drift.

    Two generations of keys are emitted on purpose:
      * current: morningPermissionApplied / eveningPermissionApplied (an approved, in-cap Morning
        Late-In / Evening Early-Out permission shifted that edge today), morningPermissionExcess /
        eveningPermissionExcess (approved but beyond the monthly cap, so it did NOT shift the edge)
        and middlePermissionToday.
      * DEPRECATED, kept for the installed employee mobile app and the deployed employee web app,
        which still read them: permissionMorning / permissionDeparture (+ the *WithRequest twins),
        permissionZoneCount, permissionEscalatedToHalfShift. They mirror the current flags: a
        permission that shifted an edge always had a request behind it. Remove once no supported
        client version reads them.
    """
    if rec is None:
        applied_m = applied_e = False
        excess_m = excess_e = middle = False
        afternoon = False
    else:
        applied_m = bool(rec.morning_permission_applied)
        applied_e = bool(rec.evening_permission_applied)
        excess_m = bool(rec.morning_permission_excess)
        excess_e = bool(rec.evening_permission_excess)
        middle = bool(rec.middle_permission_today)
        afternoon = bool(rec.permission_afternoon)
    return {
        "morningPermissionApplied": applied_m,
        "eveningPermissionApplied": applied_e,
        "morningPermissionExcess": excess_m,
        "eveningPermissionExcess": excess_e,
        "middlePermissionToday": middle,
        # ── DEPRECATED aliases (see docstring) ──
        "permissionMorning": applied_m,
        "permissionMorningWithRequest": applied_m,
        "permissionDeparture": applied_e,
        "permissionDepartureWithRequest": applied_e,
        "permissionZoneCount": int(applied_m) + int(applied_e) + int(afternoon),
        "permissionEscalatedToHalfShift": False,
    }


def late_pool_summary(records, approved_permission_count: int, settings, counted_dates=None) -> dict:
    """
    THE one Late Detection pool for a month -payroll, MonthlyShiftSummary and the employee
    shift-stats screen all call this, so they can never disagree about a deduction.

    Three kinds of occurrence share one pool (settings.late_free_allowance free, the rest priced
    by the late-deduction slabs):
      * Morning Late-In days     (r.is_late)
      * Evening Early-Out days   (r.early_leave -only ever set while that detection is enabled)
      * Excess permissions       (approved permissions beyond permission_monthly_cap that month)
    A day whose late/early flag comes with an EXCESS permission on the same edge is one occurrence,
    not two: the excess permission is that occurrence (it did not shield the day, so the day was
    judged against the plain shift time), and it is already in the excess count.

    `records`: the month's AttendanceDayRecords; only present / half-shift days are looked at.
    `counted_dates`: optional set of dates to restrict to (payroll passes its working days).
    Returns plain ints; callers add their own pricing.
    """
    late_in = early_out = 0
    for r in records:
        if counted_dates is not None and r.date not in counted_dates:
            continue
        if r.status not in ("present", "half_shift"):
            continue
        if r.is_late and not r.morning_permission_excess:
            late_in += 1
        if r.early_leave and not r.evening_permission_excess:
            early_out += 1
    cap = max(0, int(getattr(settings, "permission_monthly_cap", 3) or 0))
    excess = max(0, int(approved_permission_count or 0) - cap)
    total = late_in + early_out + excess
    free = max(0, int(getattr(settings, "late_free_allowance", 3) or 0))
    return {
        "late_in": late_in,
        "early_out": early_out,
        "excess_permissions": excess,
        "total": total,
        "free_used": min(total, free),
        "billable": max(0, total - free),
    }


def _reason_without(reason, prefix: str):
    """`reason` (the "; "-joined explanation built for a day) minus the parts that start with `prefix`;
    None when nothing is left."""
    if not reason:
        return None
    kept = [part for part in reason.split("; ") if not part.startswith(prefix)]
    return "; ".join(kept) or None


def _late_basis_notes(shift, comp_day, applied_morning: bool, applied_evening: bool) -> dict:
    """
    Plain-language account of how each Late Detection boundary was built for the day, echoed into
    the reason text ("... is after 09:40 (shift start 08:30 + 60 min Morning Late-In permission +
    10 min grace)") so HR can read the exact rule back to an employee who asks why they were
    flagged. `shift` is the REAL assigned shift, not the permission-adjusted copy.
    """
    from .models import EmployeePermission

    if shift is None:
        return {}
    grace = shift.grace_period_minutes or 0
    perm_min = EmployeePermission.FIXED_DURATION_MINUTES

    morning = f"shift start {shift.start_time.strftime('%H:%M')}"
    if applied_morning:
        morning += f" + {perm_min} min Morning Late-In permission"
    if grace:
        morning += f" + {grace} min grace"

    if comp_day is not None and comp_day.leave_until_time:
        evening = f"compensation-day release {comp_day.leave_until_time.strftime('%H:%M')}"
    else:
        evening = f"shift end {shift.end_time.strftime('%H:%M')}"
    if applied_evening:
        evening += f" - {perm_min} min Evening Early-Out permission"
    if grace:
        evening += f" - {grace} min grace"
    return {"morning": morning, "evening": evening}


# ── Staff: simple mode ─────────────────────────────────────────────────────

def _compute_staff_simple(emp, d, punch_times, settings, shift, notes=None, punch_secs=None):
    """
    Late Detection fields for a staff day in simple mode -status/
    shifts_earned/is_half_shift are NOT decided here (see _half_day_status,
    called once by compute_day_record for both modes uniformly). `shift` is
    the day's EFFECTIVE shift, already adjusted by the caller for a
    Compensation Day and/or an in-cap Permission (see
    _effective_shift_for_day) -this function only ever compares against it
    directly, with no permission-awareness of its own. `notes` ({"morning":
    ..., "evening": ...}) is the caller's plain-language account of how each
    boundary was built, echoed into the reason text.
    """
    if not punch_times:
        return {}
    notes = notes or {}
    first = punch_times[0]
    last = punch_times[-1] if len(punch_times) > 1 else None

    is_late = False
    early_leave = False
    late_reasons: list[str] = []
    if shift and settings.morning_late_in_enabled:
        is_late, reason = morning_late_in(first, shift, basis=notes.get("morning"))
        if reason:
            late_reasons.append(reason)
    if shift and last and settings.evening_early_out_enabled:
        early_leave, reason = evening_early_out(
            last, shift, basis=notes.get("evening"),
            punch_secs=punch_secs[-1] if punch_secs else None,
        )
        if reason:
            late_reasons.append(reason)

    return {
        "is_late": is_late, "early_leave": early_leave,
        "late_reason": "; ".join(late_reasons) if late_reasons else None,
        "first_punch": first, "last_punch": last,
    }


# ── Staff: strict mode (reuse 4-punch engine result) ───────────────────────

def _compute_staff_strict(emp, d, punch_logs, punch_times, assignments=None, settings=None,
                           shift=None, has_permission: bool = False, permission_time=None, notes=None):
    """Same Late Detection axes as simple mode (via the shared shift_engine
    helpers), plus the untouched strict-mode lunch-return ("Night Late")
    axis. `shift` -see _compute_staff_simple's docstring; passed through
    verbatim as `shift_override` so both modes judge the exact same
    effective boundary. `has_permission`/`permission_time` only feed the
    lunch-return axis's own (unrelated) "with request" label."""
    from .shift_engine import compute_daily_shift_log
    if not punch_times:
        return {}
    log = compute_daily_shift_log(
        emp, d, punch_logs, assignments=assignments,
        has_permission=has_permission, permission_time=permission_time,
        settings=settings, shift_override=shift, reason_notes=notes,
    )
    return {
        "is_late": bool(log.late_morning),
        "early_leave": bool(getattr(log, "early_leave", False)),
        "late_afternoon": getattr(log, "late_afternoon", False),
        "permission_afternoon": getattr(log, "permission_afternoon", False),
        "permission_afternoon_with_request": getattr(log, "permission_afternoon_with_request", False),
        "late_reason": log.late_reason,
        "first_punch": log.punch1,
        "last_punch": log.punch4 or (punch_times[-1] if len(punch_times) > 1 else None),
    }


# ── Production: dynamic shift-segment day ───────────────────────────────────
#
# Default 4-punch day (8:30 arrival / 12:45 lunch-out / 13:30 lunch-return /
# 20:00 departure) is scored against an ordered list of ProductionShiftSegment
# rows. Each segment is credited when a continuous worked span covers it
# (within the configured grace). With 4 punches the day splits into a morning
# span and an afternoon span; with any other punch count a single first→last
# span is used instead, so a bare arrival+departure without a lunch punch
# still earns credit for every segment it fully covers. Punches beyond the
# fourth extend the afternoon span rather than adding a third one.

def _as_time(v):
    """TimeField defaults may still be raw strings on a freshly-created row
    (before the next DB round-trip parses them) -normalize defensively."""
    if isinstance(v, str):
        return datetime.strptime(v[:5], "%H:%M").time()
    return v


def _production_spans(punch_times):
    # punch_times[-1] rather than [3] for the afternoon close: with exactly
    # four punches these are the same value, but Office Geo Punch no longer
    # caps the day at four, and a 6-punch day scored to index 3 would end the
    # afternoon span at a mid-shift break and silently drop segment credit
    # the employee actually earned. Last punch = end of day, at any count.
    if len(punch_times) >= 4:
        return [(punch_times[0], punch_times[1]), (punch_times[2], punch_times[-1])]
    if len(punch_times) >= 2:
        return [(punch_times[0], punch_times[-1])]
    return []


def _compute_production(emp, d, punch_times, settings, config=None, segments=None):
    if not punch_times:
        return {"status": "absent", "shifts_earned": Decimal("0")}

    if config is None:
        config = ProductionShiftConfig.get()
    if segments is None:
        segments = list(ProductionShiftSegment.objects.filter(is_active=True))

    first = punch_times[0]
    last = punch_times[-1] if len(punch_times) > 1 else None

    spans = _production_spans(punch_times)
    grace = (config.grace_minutes or 10) * 60

    def covered(seg) -> bool:
        # Arrival may be up to `grace` late, departure up to `grace` early,
        # and the segment is still credited in full.
        latest_ok_start = _t2s(_as_time(seg.start_time)) + grace
        earliest_ok_end = _t2s(_as_time(seg.end_time)) - grace
        return any(_t2s(s) <= latest_ok_start and _t2s(e) >= earliest_ok_end for s, e in spans)

    shifts = Decimal("0")
    for seg in segments:
        if covered(seg):
            shifts += Decimal(str(seg.shift_value))

    max_possible = sum((Decimal(str(s.shift_value)) for s in segments), Decimal("0"))
    if max_possible <= 0:
        max_possible = Decimal("1.50")
    if shifts == 0 and spans:
        # Punched in/out but matched no configured segment window → minimal credit for showing up
        shifts = Decimal("0.25")
    shifts = min(shifts, max_possible)

    is_late = _t2s(first) > _t2s(_as_time(config.punch1_time)) + grace
    early_leave = last is not None and _t2s(last) < _t2s(_as_time(config.punch4_time)) - grace
    is_half = shifts <= (max_possible / 2)

    return {
        "status": "half_shift" if is_half else "present",
        "is_late": is_late,
        "is_half_shift": is_half,
        "early_leave": early_leave,
        "shifts_earned": shifts,
        "first_punch": first,
        "last_punch": last,
    }


# ── Main entry: compute (or keep) the final record for one day ─────────────

def compute_day_record(emp, d: date_type, punch_logs=None, settings=None,
                       leave_dates=None, holiday_dates=None, half_day_leave_dates=None,
                       prod_config=None, prod_segments=None, prefetch=None):
    """
    Compute and persist the AttendanceDayRecord for (emp, d).
    Manual overrides are preserved -returns the existing row untouched.

    `prefetch`, when given, is a dict of data a bulk caller (compute_month_records)
    already fetched once for this employee's whole month instead of this
    function re-querying per day -this is what makes computing every
    employee's month (Report Log summary, payroll generation) fast instead
    of an O(employees × days) query storm. Recognized keys, all optional:
      assignments            -this employee's EmployeeShiftAssignment list
      existing_day_records    -{date: AttendanceDayRecord}
      manual_attendance_dates -set of date objects with a manual present row
      night_logs_by_date      -{date: [AttendanceLog, ...]} spanning one day
                                 before the month through the month's end,
                                 used by resolve_day_punch_logs' cross-midnight
                                 punch reattribution (see below)
    Omitted (the default), every one of these is looked up fresh exactly as
    before -every other caller is unaffected.
    """
    prefetch = prefetch or {}
    assignments = prefetch.get("assignments")

    existing_day_records = prefetch.get("existing_day_records")
    if existing_day_records is not None:
        existing = existing_day_records.get(d)
    else:
        existing = AttendanceDayRecord.objects.filter(employee=emp, date=d).first()
    if existing and existing.source == "manual":
        return existing

    if settings is None:
        settings = PayrollSettings.get()

    if punch_logs is None:
        punch_logs = list(
            AttendanceLog.objects.filter(employee=emp, date=d).order_by("punch_time")
        )
    punch_times = sorted(p.punch_time for p in punch_logs)

    def _chronological(logs):
        # (seconds since THIS day's midnight, clock time), oldest first. A punch reattributed from
        # the next calendar date carries that date, so a 01:00 exit is 25:00 here -compared as a bare
        # clock time it would count as "before 13:30" (Morning half only) and as an early-out.
        return sorted((_t2s(p.punch_time) + 86400 * (p.date - d).days, p.punch_time) for p in logs)

    day_pairs = _chronological(punch_logs)

    # ── Cross-midnight punch reattribution ───────────────────────────────
    # An ordinary day's forgotten evening exit punch made hours late, after
    # midnight, would otherwise be misread as tomorrow's first punch -silently
    # shifting every one of tomorrow's real punches down a slot. See
    # resolve_day_punch_logs. No-ops (returns punch_logs unchanged) when
    # disabled in Settings or for non-staff employees.
    resolved_logs = resolve_day_punch_logs(
        emp, d, punch_logs, settings, assignments=assignments,
        logs_by_date=prefetch.get("night_logs_by_date"),
    )
    if resolved_logs is not punch_logs:
        punch_logs = resolved_logs
        day_pairs = _chronological(punch_logs)
    day_secs = [s for s, _t in day_pairs]
    day_times = [t for _s, t in day_pairs]

    # Manual attendance entries (Attendance table) count as presence too
    manual_attendance_dates = prefetch.get("manual_attendance_dates")
    if manual_attendance_dates is not None:
        has_manual = d in manual_attendance_dates
    else:
        has_manual = Attendance.objects.filter(
            employee=emp, date=d.isoformat(), present=True
        ).exists()

    on_leave = (d in leave_dates) if leave_dates is not None else False
    is_holiday = (d in holiday_dates) if holiday_dates is not None else False
    # "morning" | "afternoon" | None -see _half_day_leave_dates_for_month.
    half_day_slot = half_day_leave_dates.get(d) if half_day_leave_dates is not None else None

    fields = {
        "is_late": False, "is_half_shift": False, "early_leave": False,
        "late_afternoon": False,
        "morning_permission_excess": False, "evening_permission_excess": False,
        "morning_permission_applied": False, "evening_permission_applied": False,
        "middle_permission_today": False,
        "permission_afternoon": False, "permission_afternoon_with_request": False,
        "is_compensation_day": False,
        "is_half_day_leave": False,
        "late_reason": None,
        "first_punch": None, "last_punch": None,
    }

    is_production = emp.employment_type == "production"

    # Every approved EmployeePermission of this day -each with its canonical
    # type and whether it is still within PayrollSettings.permission_monthly_
    # cap this calendar month. Staff only (Permission for production has no
    # equivalent role here). See _permissions_for_day; a bulk caller
    # (compute_month_records) supplies both prefetch keys once per month.
    day_perms: list = []
    has_permission = False
    permission_time = None
    if not is_production:
        day_perms = _permissions_for_day(
            emp, d, settings.permission_monthly_cap, prefetch=prefetch,
            shift_fn=lambda: _get_shift_for_date(emp, d, assignments=assignments),
        )
        # The untouched strict-mode lunch-return axis reads ANY approved
        # permission's time, regardless of type or cap status -unchanged
        # from before this rewrite.
        has_permission = bool(day_perms)
        permission_time = day_perms[0][0].permission_time if day_perms else None

    # This day's Compensation Day announcement, if any -staff only. See
    # _compensation_day_for's docstring for scoping rules.
    comp_day = None if is_production else _compensation_day_for(
        emp, d, settings=settings, prefetched=prefetch.get("compensation_days_by_date"),
    )

    if day_times or has_manual:
        if not day_times and has_manual:
            computed = {"status": "present", "shifts_earned": Decimal("1.00")}
        elif is_production:
            computed = _compute_production(emp, d, day_times, settings, prod_config, prod_segments)
        else:
            from .models import EmployeePermission

            shift = _get_shift_for_date(emp, d, assignments=assignments)
            effective_shift, applied_morning, applied_evening = _effective_shift_for_day(shift, comp_day, day_perms)
            notes = _late_basis_notes(shift, comp_day, applied_morning, applied_evening)
            if settings.attendance_mode == "simple":
                computed = _compute_staff_simple(
                    emp, d, day_times, settings, effective_shift, notes=notes, punch_secs=day_secs
                )
            else:
                computed = _compute_staff_strict(
                    emp, d, punch_logs, day_times, assignments=assignments, settings=settings,
                    shift=effective_shift, has_permission=has_permission, permission_time=permission_time,
                    notes=notes,
                )
            # Which permissions did what today: an in-cap Morning Late-In / Evening Early-Out
            # shifted that edge ("applied"); one beyond the monthly cap did NOT ("excess") and the
            # edge was judged against the plain shift time; a Middle One-Hour never shifts anything.
            kinds = [(kind, in_cap) for _p, kind, in_cap in day_perms]
            morning_excess = (not applied_morning) and any(
                k == EmployeePermission.TYPE_MORNING_LATE_IN and not c for k, c in kinds)
            evening_excess = (not applied_evening) and any(
                k == EmployeePermission.TYPE_EVENING_EARLY_OUT and not c for k, c in kinds)
            computed["morning_permission_applied"] = applied_morning
            computed["evening_permission_applied"] = applied_evening
            computed["morning_permission_excess"] = morning_excess
            computed["evening_permission_excess"] = evening_excess
            computed["middle_permission_today"] = any(k == EmployeePermission.TYPE_MIDDLE_PERMISSION for k, _c in kinds)
            cap = max(0, int(settings.permission_monthly_cap or 0))
            excess_notes = []
            if morning_excess:
                excess_notes.append(
                    f"Morning Late-In permission approved but Excess (over {cap} per month): "
                    "judged against the plain shift start and counted in the late pool")
            if evening_excess:
                excess_notes.append(
                    f"Evening Early-Out permission approved but Excess (over {cap} per month): "
                    "judged against the plain shift end and counted in the late pool")
            if excess_notes:
                computed["late_reason"] = "; ".join(
                    [r for r in [computed.get("late_reason")] if r] + excess_notes)

            # Half-Day Detection -REPLACES whatever status/shifts_earned the
            # mode-specific function above would otherwise imply; identical
            # rule for both modes. A Compensation Day's leave_until_time, if
            # set, replaces the Evening Half cutoff for the day.
            second_half_override = comp_day.leave_until_time if (comp_day and comp_day.leave_until_time) else None
            status, shifts_earned, is_half = _half_day_status(
                day_secs, settings, second_half_start_override=second_half_override,
            )
            computed["status"] = status
            computed["shifts_earned"] = shifts_earned
            computed["is_half_shift"] = is_half

        if comp_day:
            # Suppress every Late/Permission flag -a compensation day is
            # never penalized. Deliberately does NOT touch status/
            # shifts_earned/is_half_shift -Full vs Half still comes from
            # real punches (against leave_until_time as the effective shift
            # end, when set), never auto-granted.
            for key in (
                "early_leave", "late_afternoon",
                "permission_afternoon", "permission_afternoon_with_request",
            ):
                if key in computed:
                    computed[key] = False
            computed["is_late"] = False
            computed["late_reason"] = None

        # Half-Day Leave: a day the engine already resolved to Half Shift is
        # exactly what a half day covered by approved leave looks like -
        # don't invent a new status, just annotate it (shifts_earned stays
        # the same 0.50 Half Shift already pays, so payroll needs no
        # separate branch either). Deliberately does NOT touch a "present"/
        # "absent" outcome: if the employee worked the whole day anyway,
        # their real attendance wins (same "punches always win" rule the
        # on_leave check already follows); if they never punched at all,
        # that falls through to the ordinary absent branch below -a no-show
        # for the half they still owed is not covered by a half-day leave.
        if half_day_slot and not is_production and computed.get("status") == "half_shift":
            computed["is_half_day_leave"] = True
            if half_day_slot == LeaveRequest.HALF_DAY_MORNING:
                # Leave covers the morning -an afternoon-only arrival is
                # never "late"; they were never expected before the
                # half-shift reference time in the first place.
                computed["is_late"] = False
                computed["late_reason"] = _reason_without(computed.get("late_reason"), "Morning Late-In")
            else:
                # Afternoon slot: the employee still owes a normal morning
                # arrival, so whatever is_late the engine already computed for
                # that arrival is left exactly as it is -but the afternoon is
                # covered by the leave, so leaving at lunch is not an early-out.
                computed["early_leave"] = False
                computed["late_reason"] = _reason_without(computed.get("late_reason"), "Evening Early-Out")
    elif is_production:
        # Production employees have no leave/CL and work Sundays as a normal
        # day -only an explicit company Holiday exempts them; otherwise a
        # day with zero punches is simply Absent.
        if is_holiday:
            computed = {"status": "holiday", "shifts_earned": Decimal("0")}
        else:
            computed = {"status": "absent", "shifts_earned": Decimal("0")}
    elif on_leave:
        computed = {"status": "on_leave", "shifts_earned": Decimal("0")}
    elif is_holiday or _sunday(d):
        computed = {"status": "holiday", "shifts_earned": Decimal("0")}
    else:
        computed = {"status": "absent", "shifts_earned": Decimal("0")}

    fields.update(computed)
    fields["is_compensation_day"] = bool(comp_day)

    fields["total_punches"] = len(punch_times)
    fields["computed_mode"] = (
        "production" if emp.employment_type == "production" else settings.attendance_mode
    )
    fields["source"] = "auto"
    _primary_raw = _resolve_primary_source(punch_logs, has_manual=has_manual)
    if _primary_raw:
        from .geo_attendance_views import source_label
        fields["primary_source"] = source_label(_primary_raw)
    else:
        fields["primary_source"] = None
    # Normalize to the field's actual DB precision (2 decimal places) so a
    # freshly computed value (e.g. the literal Decimal("0")) compares equal
    # in *representation*, not just value, to one read back from the DB —
    # otherwise the skip-write check below would never fire for zero-shift
    # days, since Decimal("0") == Decimal("0.00") but str() differs.
    fields["shifts_earned"] = Decimal(fields["shifts_earned"]).quantize(Decimal("0.01"))

    # Skip the write entirely when the freshly computed values match what's
    # already persisted -a day's outcome rarely changes once computed, and
    # this turns the common "nothing changed since last time" case (bulk
    # month-wide reads) into zero write queries instead of one per day.
    if existing is not None and all(getattr(existing, k) == v for k, v in fields.items()):
        return existing

    record, _ = AttendanceDayRecord.objects.update_or_create(
        employee=emp, date=d, defaults=fields,
    )
    return record


def compute_month_records(emp, year: int, month: int, settings=None):
    """
    Compute final records for every elapsed day of the month. Returns list.

    Everything compute_day_record() would otherwise look up one day at a
    time (existing AttendanceDayRecord, manual Attendance rows, the
    employee's shift assignment(s)) is fetched here ONCE for the whole month
    and handed down via `prefetch`.
    Calling this per employee across a full roster (Report Log summary,
    Payroll generation) would otherwise be an O(employees × days) query
    storm -this keeps each employee's month to a small, fixed number of
    queries regardless of how many days are in it.
    """
    if settings is None:
        settings = PayrollSettings.get()

    days_in_month = calendar.monthrange(year, month)[1]
    today = ist_today()
    month_start = date_type(year, month, 1)
    month_end = date_type(year, month, days_in_month)

    # One day before AND after the month too -cross-midnight punch
    # reattribution (resolve_day_punch_logs) for the LAST day of the month
    # needs the following day's early punches to check, and for symmetry the
    # first day of the month also gets the previous day's punches available.
    logs = AttendanceLog.objects.filter(
        employee=emp, date__gte=month_start - timedelta(days=1), date__lte=month_end + timedelta(days=1),
    ).order_by("punch_time")
    logs_by_date = {}
    for log in logs:
        logs_by_date.setdefault(log.date, []).append(log)

    leave_dates = _leave_dates_for_month(emp, year, month)
    holiday_dates = _holiday_dates_for_month(year, month)
    half_day_leave_dates = _half_day_leave_dates_for_month(emp, year, month)

    prod_config = ProductionShiftConfig.get() if emp.employment_type == "production" else None
    prod_segments = (
        list(ProductionShiftSegment.objects.filter(is_active=True))
        if emp.employment_type == "production" else None
    )

    from .models import EmployeeShiftAssignment

    assignments = list(
        EmployeeShiftAssignment.objects.filter(employee=emp, effective_from__lte=month_end)
        .filter(Q(effective_to__isnull=True) | Q(effective_to__gte=month_start - timedelta(days=1)))
        .select_related("shift")
    )
    existing_day_records = {
        r.date: r for r in AttendanceDayRecord.objects.filter(
            employee=emp, date__gte=month_start, date__lte=month_end,
        )
    }
    manual_attendance_dates = {
        date_type.fromisoformat(str(dt)[:10])
        for dt in Attendance.objects.filter(
            employee=emp, date__gte=month_start.isoformat(), date__lte=month_end.isoformat(),
            present=True,
        ).values_list("date", flat=True)
    }
    from .models import EmployeePermission
    approved_permissions_by_date = {}
    approved_permissions_this_month = {(year, month): []}
    if emp.employment_type != "production":
        for p in EmployeePermission.objects.filter(
            employee=emp, date__gte=month_start, date__lte=month_end, status="approved",
        ).order_by("updated_at"):
            # EVERY approved row of a date is kept (an employee can hold a Morning Late-In AND an
            # Evening Early-Out the same day), and the cap-position list needs every row too
            # (list order doesn't matter -_permissions_for_day only filters/counts it).
            approved_permissions_by_date.setdefault(p.date, []).append(p)
            approved_permissions_this_month[(year, month)].append((p.date, p.id))
    prefetch = {
        "assignments": assignments,
        "existing_day_records": existing_day_records,
        "manual_attendance_dates": manual_attendance_dates,
        "night_logs_by_date": logs_by_date,
        "approved_permissions_by_date": approved_permissions_by_date,
        "approved_permissions_this_month": approved_permissions_this_month,
        "compensation_days_by_date": (
            None if emp.employment_type == "production"
            else _compensation_days_by_date(month_start, month_end, settings)
        ),
    }

    records = []
    for day in range(1, days_in_month + 1):
        d = date_type(year, month, day)
        if d > today:
            break
        records.append(compute_day_record(
            emp, d,
            punch_logs=logs_by_date.get(d, []),
            settings=settings,
            leave_dates=leave_dates,
            holiday_dates=holiday_dates,
            half_day_leave_dates=half_day_leave_dates,
            prod_config=prod_config,
            prod_segments=prod_segments,
            prefetch=prefetch,
        ))
    return records


def compute_range_records(emp, date_from: date_type, date_to: date_type, settings=None):
    """
    Compute final records for every day in [date_from, date_to] (inclusive).

    Builds the same full prefetch dict compute_month_records does (shift
    assignments, existing AttendanceDayRecord rows, manual attendance,
    approved permissions -see that function's docstring), just scoped to an
    arbitrary range instead of a calendar month. This used to only prefetch
    night_logs_by_date, leaving compute_day_record to fall back to a live
    query per missing key on EVERY day -harmless for a single employee's
    range (attendance_search/range's own use), but attendance_report_log_sheet
    calls this once per employee across the whole roster, which turned that
    per-day gap into exactly the O(employees × days) query storm
    compute_month_records's docstring warns about avoiding.
    """
    if settings is None:
        settings = PayrollSettings.get()

    today = ist_today()
    # One day of padding on each side -cross-midnight punch reattribution
    # (resolve_day_punch_logs) for the last day needs the following day's
    # early punches to check.
    logs = AttendanceLog.objects.filter(
        employee=emp, date__gte=date_from - timedelta(days=1), date__lte=date_to + timedelta(days=1),
    ).order_by("punch_time")
    logs_by_date = {}
    for log in logs:
        logs_by_date.setdefault(log.date, []).append(log)

    # EVERY calendar month the range touches -not just the two it starts and ends in: a range over
    # three or more months (attendance search allows ~100 days) used to skip the middle month, whose
    # permissions then had no cap-position list and were all treated as in-cap.
    months = set()
    _cursor = date_from.replace(day=1)
    while _cursor <= date_to:
        months.add((_cursor.year, _cursor.month))
        _cursor = (_cursor.replace(day=28) + timedelta(days=4)).replace(day=1)
    leave_dates, holiday_dates = set(), set()
    half_day_leave_dates: dict = {}
    for y, m in months:
        leave_dates |= _leave_dates_for_month(emp, y, m)
        holiday_dates |= _holiday_dates_for_month(y, m)
        half_day_leave_dates.update(_half_day_leave_dates_for_month(emp, y, m))

    prod_config = ProductionShiftConfig.get() if emp.employment_type == "production" else None
    prod_segments = (
        list(ProductionShiftSegment.objects.filter(is_active=True))
        if emp.employment_type == "production" else None
    )

    from .models import EmployeePermission, EmployeeShiftAssignment

    assignments = list(
        EmployeeShiftAssignment.objects.filter(employee=emp, effective_from__lte=date_to)
        .filter(Q(effective_to__isnull=True) | Q(effective_to__gte=date_from - timedelta(days=1)))
        .select_related("shift")
    )
    existing_day_records = {
        r.date: r for r in AttendanceDayRecord.objects.filter(
            employee=emp, date__gte=date_from, date__lte=date_to,
        )
    }
    manual_attendance_dates = {
        date_type.fromisoformat(str(dt)[:10])
        for dt in Attendance.objects.filter(
            employee=emp, date__gte=date_from.isoformat(), date__lte=date_to.isoformat(),
            present=True,
        ).values_list("date", flat=True)
    }
    approved_permissions_by_date = {}
    if emp.employment_type != "production":
        for p in EmployeePermission.objects.filter(
            employee=emp, date__gte=date_from, date__lte=date_to, status="approved",
        ).order_by("updated_at"):
            approved_permissions_by_date.setdefault(p.date, []).append(p)

    # Cap position must always be judged against the FULL calendar month(s)
    # touched, never just whatever (possibly partial-month) range was
    # requested -queried separately per month, same `months` set already
    # built above for leave/holiday dates.
    approved_permissions_this_month: dict = {}
    if emp.employment_type != "production":
        for y, m in months:
            m_start = date_type(y, m, 1)
            m_end = date_type(y, m, calendar.monthrange(y, m)[1])
            approved_permissions_this_month[(y, m)] = list(
                EmployeePermission.objects.filter(
                    employee=emp, date__gte=m_start, date__lte=m_end, status="approved",
                ).values_list("date", "id")
            )

    prefetch = {
        "assignments": assignments,
        "existing_day_records": existing_day_records,
        "manual_attendance_dates": manual_attendance_dates,
        "night_logs_by_date": logs_by_date,
        "approved_permissions_by_date": approved_permissions_by_date,
        "approved_permissions_this_month": approved_permissions_this_month,
        "compensation_days_by_date": (
            None if emp.employment_type == "production"
            else _compensation_days_by_date(date_from, date_to, settings)
        ),
    }

    records = []
    d = date_from
    while d <= date_to:
        if d > today:
            break
        records.append(compute_day_record(
            emp, d,
            punch_logs=logs_by_date.get(d, []),
            settings=settings,
            leave_dates=leave_dates,
            holiday_dates=holiday_dates,
            half_day_leave_dates=half_day_leave_dates,
            prod_config=prod_config,
            prod_segments=prod_segments,
            prefetch=prefetch,
        ))
        d += timedelta(days=1)
    return records


def month_summary_from_records(records) -> dict:
    """Aggregate totals used by the weekly search table and payroll."""
    present = sum(1 for r in records if r.status == "present")
    half = sum(1 for r in records if r.status == "half_shift" or r.is_half_shift)
    absent = sum(1 for r in records if r.status == "absent")
    leave = sum(1 for r in records if r.status == "on_leave")
    holidays = sum(1 for r in records if r.status == "holiday")
    late = sum(1 for r in records if r.is_late)
    shifts = sum((r.shifts_earned or Decimal("0")) for r in records)
    working_days = len(records) - holidays
    return {
        "totalDays": len(records),
        "workingDays": working_days,
        "present": present,
        "halfShift": half,
        "absent": absent,
        "onLeave": leave,
        "holidays": holidays,
        "late": late,
        "totalShifts": str(shifts),
        # Effective attendance = full presents + 0.5 × halves
        "effectiveDays": str(Decimal(present) + Decimal(half) * Decimal("0.5")),
    }

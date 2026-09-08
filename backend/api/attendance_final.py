"""
Final Attendance Engine -mode-aware day computation + HR overrides
===================================================================

Produces one AttendanceDayRecord per employee per day. This table is the
single source of truth for Payroll/Salary:

  • source == "auto"   → computed from punches using the mode selected in
                          Settings (strict | simple)
  • source == "manual" → HR override; NEVER recomputed automatically

Modes (staff, current rule -d >= NEW_ATTENDANCE_RULE_CUTOVER; both modes
share the same Full/Half/Absent decision, see _punctuality_ok in
shift_engine.py; simple vs strict now only differs in whether lunch-return
lateness is additionally tracked):
  • Full Shift  → a first punch AND a distinct last punch both exist, AND
                  both fall within PayrollSettings.shift_punctuality_window_
                  minutes (default 60) of the employee's assigned shift's
                  start/end time. No assigned shift = no reference to check
                  against, so only the punch-presence half of the rule
                  applies then.
  • Half Shift  → any other punch pattern with >=1 punch (a single punch,
                  or a first+last pair outside the punctuality window).
  • Absent      → zero punches (and not on leave/holiday).
  • Night Shift Relaxation can still upgrade a punctuality-caused Half
    Shift back to Full once the day completes -see get_relaxation_for.

Pre-cutover days stay frozen under the OLD rule (punch3+punch4 required
for strict, a 13:30 cutoff for simple) so already-paid history never
silently changes -see NEW_ATTENDANCE_RULE_CUTOVER.

production:     1.5-shift day (works in both modes):
                • first half   08:30–12:30  → 0.50
                • second half  13:30–17:30  → 0.50
                • extra half   17:50–20:00  → 0.50
                windows configurable in PayrollSettings. Unaffected by the
                punctuality-window rule above (staff-only).
"""

import calendar
from datetime import date as date_type, datetime, time as time_type, timedelta
from decimal import Decimal

from django.db.models import Q, Sum

from .clock import ist_now, ist_today
from .models import (
    AttendanceDayRecord, AttendanceLog, Attendance, Employee, Holiday,
    LeaveRequest, PayrollSettings, ProductionShiftConfig, ProductionShiftSegment,
)
from .shift_engine import (
    _get_shift_for_date, _t2s, _s2t, NEW_ATTENDANCE_RULE_CUTOVER,
    _punctuality_ok, _punctuality_window_minutes, resolve_day_punch_logs,
    _is_after_half_shift_late_reference,
    _permission_covers_late_in, _permission_covers_early_out,
    _permission_window_minutes, _classify_zone,
    ZONE_ON_TIME, ZONE_LATE, ZONE_PERMISSION, ZONE_HALF_SHIFT,
)

# The simple-mode half-shift cutoff as it actually stood at
# NEW_ATTENDANCE_RULE_CUTOVER -frozen here, deliberately NOT read from the
# live (HR-editable) PayrollSettings.simple_half_shift_cutoff, so a future
# edit to that setting can never retroactively change how a pre-cutover day
# recomputes. See the legacy_rule branch in _compute_staff_simple.
LEGACY_SIMPLE_HALF_SHIFT_CUTOFF = time_type(13, 30)


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


def _holiday_dates_for_month(year: int, month: int) -> set:
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


def _compensation_day_for(emp, d: date_type, settings=None):
    """
    The CompensationDayAnnouncement covering (emp, d), or None. Scoping
    (Holiday's nullable-FK convention, extended with an explicit employee
    list): an announcement applies to `emp` when either
      - `emp` is explicitly listed in `announcement.employees`, or
      - the employee list is empty AND emp's branch/department match
        whichever of `announcement.branch`/`announcement.department` are
        set (null on either axis = unscoped there).
    Announcements are expected to be rare (a handful of festival/special
    days a year), so this queries fresh per call rather than needing a
    month-wide prefetch like approved_permissions_by_date.

    Master off-switch: PayrollSettings.compensation_feature_enabled. Checked
    here -the single choke point compute_day_record already goes through -
    so turning the Compensation feature off in Settings stops this exemption
    from applying at all, even though the CompensationDayAnnouncement rows
    themselves are left untouched in the database (mirrors night_shift.py's
    get_relaxation_for master-switch check).
    """
    if settings is None:
        settings = PayrollSettings.get()
    if not settings.compensation_feature_enabled:
        return None
    from .models import CompensationDayAnnouncement
    for ann in CompensationDayAnnouncement.objects.filter(date=d):
        if ann.employees.filter(pk=emp.pk).exists():
            return ann
        if ann.employees.exists():
            continue
        if ann.branch_id and ann.branch_id != emp.branch_id:
            continue
        if ann.department_id and ann.department_id != emp.department_id:
            continue
        return ann
    return None


def _permission_zone_count_this_week(emp, d: date_type, week_permission_counts=None) -> int:
    """
    Sum of AttendanceDayRecord.permission_zone_count for days in the current
    ISO week (Mon-Sun) strictly BEFORE `d` -used to enforce
    PayrollSettings.max_permissions_per_week without re-deriving it from the
    per-edge booleans on every prior day.

    `week_permission_counts`, when given, is a {date: permission_zone_count}
    map a bulk caller (compute_month_records) already fetched once for the
    employee's whole month (plus a little lead-in) -avoids one query per day.
    Omitted, queries directly (cheap: one employee, up to 6 rows).
    """
    week_start = d - timedelta(days=d.weekday())
    if week_permission_counts is not None:
        return sum(
            count for day, count in week_permission_counts.items()
            if week_start <= day < d
        )
    total = AttendanceDayRecord.objects.filter(
        employee=emp, date__gte=week_start, date__lt=d,
    ).aggregate(total=Sum("permission_zone_count"))["total"]
    return total or 0


def _enforce_permission_caps(emp, d: date_type, fields: dict, settings, week_permission_counts=None) -> None:
    """
    Mutates `fields` in place: enforces max_permissions_per_day (priority
    order morning -> afternoon -> departure) then max_permissions_per_week.
    Any edge beyond the surviving budget is escalated -its permission_*/
    *_with_request flags are cleared, and the day is demoted to Half Shift
    (permission_escalated_to_half_shift=True), mirroring how any other edge
    failure already demotes shifts_earned today. No-op when the day isn't a
    Full-Shift ("present") staff day, or when no edge landed in a
    Permission zone.
    """
    if fields.get("status") != "present":
        return
    edges = [k for k in ("permission_morning", "permission_afternoon", "permission_departure") if fields.get(k)]
    if not edges:
        return

    max_per_day = settings.max_permissions_per_day
    max_per_day = 1 if max_per_day is None else max_per_day
    max_per_week = settings.max_permissions_per_week
    max_per_week = 2 if max_per_week is None else max_per_week

    surviving = edges[:max_per_day] if max_per_day >= 0 else list(edges)
    escalated = edges[len(surviving):]

    week_used = _permission_zone_count_this_week(emp, d, week_permission_counts=week_permission_counts)
    week_budget = max(0, max_per_week - week_used)
    if len(surviving) > week_budget:
        escalated = surviving[week_budget:] + escalated
        surviving = surviving[:week_budget]

    if escalated:
        legacy_without_permission_field = {
            "permission_morning": "late_in_without_permission",
            "permission_departure": "early_out_without_permission",
        }
        for key in escalated:
            fields[key] = False
            fields[f"{key}_with_request"] = False
            legacy_field = legacy_without_permission_field.get(key)
            if legacy_field:
                fields[legacy_field] = False
        fields["permission_escalated_to_half_shift"] = True
        fields["status"] = "half_shift"
        fields["is_half_shift"] = True
        fields["shifts_earned"] = Decimal("0.50")

    fields["permission_zone_count"] = len(surviving)


# ── Staff: simple mode ─────────────────────────────────────────────────────

def _compute_staff_simple(emp, d, punch_times, settings, shift, legacy_rule: bool = False,
                           has_permission: bool = False, permission_time=None):
    """Return dict of computed fields for a staff day in simple mode."""
    if not punch_times:
        return {"status": "absent", "shifts_earned": Decimal("0")}

    first = punch_times[0]
    last = punch_times[-1] if len(punch_times) > 1 else None

    # Late: morning punch beyond shift start + grace -both values come solely
    # from the employee's assigned ShiftTemplate (Shift Management). There is
    # no Settings-level default: without an assigned shift there is no basis
    # for late detection, so the day is simply never flagged late.
    #
    # Zone-based detection (Full-Shift days only -see the "present" return
    # branch below, the only place these flags are actually kept): a punch
    # past grace but still inside the punctuality window is Late (Morning);
    # past that window but inside the extra permission window is auto-
    # detected Permission, independent of any submitted EmployeePermission -
    # a submitted+approved one occurring near this edge only labels the
    # occurrence "with request" (late_in_without_permission is the inverse,
    # repurposed from its old "waives Late" meaning). Same idea mirrored onto
    # the evening side for early departure. Simple mode has no punch2/punch3,
    # so there is no afternoon/Night-Late axis here -see shift_engine.py's
    # compute_daily_shift_log for the strict-mode version, which does.
    is_late = False
    early_leave = False
    late_in_without_permission = False
    early_out_without_permission = False
    permission_morning = permission_morning_with_request = False
    permission_departure = permission_departure_with_request = False
    late_reasons: list[str] = []
    window_minutes = _punctuality_window_minutes(shift, settings=settings) if shift else 0
    permission_window_min = _permission_window_minutes(settings=settings) if shift else 0
    if shift:
        grace = (shift.grace_period_minutes if shift.grace_period_minutes is not None else 0) * 60
        shift_start_secs = _t2s(shift.start_time)
        delta = max(0, _t2s(first) - shift_start_secs)
        zone = _classify_zone(delta, grace, window_minutes * 60, permission_window_min * 60)
        if zone == ZONE_LATE:
            is_late = True
            late_reasons.append(
                f"Late morning: arrived {first.strftime('%H:%M')}, "
                f"deadline {_s2t(shift_start_secs + grace).strftime('%H:%M')}"
            )
        elif zone == ZONE_PERMISSION:
            permission_morning = True
            permission_morning_with_request = bool(has_permission and _permission_covers_late_in(
                permission_time, shift, window_minutes + permission_window_min,
            ))
            late_in_without_permission = not permission_morning_with_request
            tag = "With Permission" if permission_morning_with_request else "Without Permission"
            late_reasons.append(f"Permission (morning, {tag}): arrived {first.strftime('%H:%M')}")

        if last and _t2s(last) < _t2s(shift.end_time):
            early_leave = True
        if last:
            shift_end_secs = _t2s(shift.end_time)
            delta = max(0, shift_end_secs - _t2s(last))
            zone = _classify_zone(delta, grace, window_minutes * 60, permission_window_min * 60)
            if zone == ZONE_LATE:
                is_late = True
                late_reasons.append(
                    f"Early out: left {last.strftime('%H:%M')}, "
                    f"deadline {_s2t(shift_end_secs - grace).strftime('%H:%M')}"
                )
            elif zone == ZONE_PERMISSION:
                permission_departure = True
                permission_departure_with_request = bool(has_permission and _permission_covers_early_out(
                    permission_time, shift, window_minutes + permission_window_min,
                ))
                early_out_without_permission = not permission_departure_with_request
                tag = "With Permission" if permission_departure_with_request else "Without Permission"
                late_reasons.append(f"Permission (departure, {tag}): left {last.strftime('%H:%M')}")

    # For a day that resolves to Half Shift, Late is decided purely against
    # the configured half-shift late reference (Settings → Attendance →
    # Staff, default 2:30 PM) instead of the shift's own start/grace -see
    # that helper's docstring in shift_engine.py. A punch at or before the
    # reference is never late for Half Shift purposes; only strictly after
    # it is. This REPLACES `is_late` in the two Half Shift return branches
    # below -the Full Shift ("present") branch keeps using the original
    # `is_late` completely unchanged. `settings` is already in scope here,
    # so the reference is passed in rather than re-queried.
    half_ref = getattr(settings, "half_shift_late_reference_time", None)
    is_late_half_shift = _is_after_half_shift_late_reference(first, half_ref)
    half_shift_reason = None
    if is_late_half_shift:
        from .shift_engine import HALF_SHIFT_LATE_REFERENCE_DEFAULT
        ref = half_ref or HALF_SHIFT_LATE_REFERENCE_DEFAULT
        half_shift_reason = (
            f"Late (Half Shift): arrived {first.strftime('%H:%M')}, "
            f"Half Shift reference {ref.strftime('%H:%M')}"
        )

    if legacy_rule:
        # Frozen pre-2026-07-25 behavior: arriving after the cutoff always
        # forced Half Shift, even with a valid first+last pair. Hardcoded
        # to the value simple_half_shift_cutoff actually held at the
        # cutover (13:30) -NOT read live from settings, which is still an
        # HR-editable field going forward. Reading it live here would mean
        # any future edit to that setting retroactively changes how every
        # pre-cutover historical day recomputes the next time it's viewed,
        # defeating the entire point of freezing history at the cutover.
        cutoff = LEGACY_SIMPLE_HALF_SHIFT_CUTOFF
        if _t2s(first) > _t2s(cutoff):
            return {
                "status": "half_shift", "is_half_shift": True,
                "shifts_earned": Decimal("0.50"),
                "first_punch": first, "last_punch": last,
            }

    # Current rule: Full Shift whenever a first punch AND a distinct last
    # punch both exist -no cutoff exception. Single punch = Half Shift.
    if last is None:
        return {
            "status": "half_shift", "is_half_shift": True,
            "is_late": is_late_half_shift, "late_reason": half_shift_reason,
            "shifts_earned": Decimal("0.50"), "first_punch": first,
        }

    # Shift punctuality window (current rule only): a first+last pair isn't
    # enough on its own -both also need to fall within the punctuality
    # window of the assigned shift's actual start/end time, or the day is
    # capped at Half Shift. This is a single universal threshold -see
    # _punctuality_window_minutes -the same for every employee, not gated
    # by an approved Permission (a punch inside the window but past the
    # shift's own small grace_period_minutes is still just Late, per
    # is_late above; only a punch past this wider window caps the day at
    # Half Shift). No shift assigned = no reference to check against, so
    # this never applies then (matches is_late's own convention).
    #
    # This is the same 4-case rule spelled out in _punctuality_ok's
    # docstring (shift_engine.py) -a first punch at 11am/noon/1:30pm/later
    # is Half Shift here regardless of an otherwise-valid last punch,
    # confirmed against a 14/14 boundary test on 2026-07-25.
    if not legacy_rule:
        if not _punctuality_ok(first, last, shift, window_minutes, permission_window_min):
            return {
                "status": "half_shift", "is_half_shift": True,
                "is_late": is_late_half_shift, "late_reason": half_shift_reason,
                "shifts_earned": Decimal("0.50"), "first_punch": first, "last_punch": last,
            }

    return {
        "status": "present", "is_late": is_late, "early_leave": early_leave,
        "late_in_without_permission": late_in_without_permission,
        "early_out_without_permission": early_out_without_permission,
        "permission_morning": permission_morning,
        "permission_morning_with_request": permission_morning_with_request,
        "permission_departure": permission_departure,
        "permission_departure_with_request": permission_departure_with_request,
        "late_reason": "; ".join(late_reasons) if late_reasons else None,
        "shifts_earned": Decimal("1.00"),
        "first_punch": first, "last_punch": last,
    }


# ── Staff: strict mode (reuse 4-punch engine result) ───────────────────────

def _compute_staff_strict(emp, d, punch_logs, punch_times, assignments=None, relaxation=None, legacy_rule: bool = False,
                           has_permission: bool = False, permission_time=None, settings=None,
                           shift_end_override=None):
    from .shift_engine import compute_daily_shift_log
    if not punch_times:
        return {"status": "absent", "shifts_earned": Decimal("0")}
    log = compute_daily_shift_log(
        emp, d, punch_logs, assignments=assignments, relaxation=relaxation,
        legacy=legacy_rule, has_permission=has_permission, permission_time=permission_time,
        settings=settings, shift_end_override=shift_end_override,
    )
    shifts = Decimal(log.shifts_completed or 0)
    is_half = shifts == Decimal("0.50")
    early_out_wp = getattr(log, "early_out_without_permission", False)
    return {
        "status": "half_shift" if is_half else ("present" if shifts > 0 else "absent"),
        # early_out_without_permission is a wholly new detection axis (the
        # evening side had no is_late contribution at all before this) —
        # folded in alongside the two pre-existing axes (morning grace,
        # lunch-return), not replacing either.
        "is_late": bool(log.late_morning or log.late_return or early_out_wp),
        "is_half_shift": is_half,
        "late_afternoon": getattr(log, "late_afternoon", False),
        "late_in_without_permission": getattr(log, "late_in_without_permission", False),
        "early_out_without_permission": early_out_wp,
        "permission_morning": getattr(log, "permission_morning", False),
        "permission_morning_with_request": getattr(log, "permission_morning_with_request", False),
        "permission_afternoon": getattr(log, "permission_afternoon", False),
        "permission_afternoon_with_request": getattr(log, "permission_afternoon_with_request", False),
        "permission_departure": getattr(log, "permission_departure", False),
        "permission_departure_with_request": getattr(log, "permission_departure_with_request", False),
        "late_reason": log.late_reason,
        "shifts_earned": shifts,
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
                                 before the month through the month's end
      night_rules             -active NightShiftRule list
      existing_relaxations    -{date: NightShiftRelaxation} by relaxation_date
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

    # ── Night Shift Relaxation ──────────────────────────────────────────
    # If the employee worked late last night they may report late today
    # without Late / Half-Shift penalties. Also, early-morning punches that
    # are actually last night's checkout must not count as today's arrival.
    from .night_shift import get_relaxation_for, record_report, MORNING_CUTOFF
    relaxation = get_relaxation_for(
        emp, d,
        assignments=assignments,
        logs_by_date=prefetch.get("night_logs_by_date"),
        rules=prefetch.get("night_rules"),
        existing_relaxations=prefetch.get("existing_relaxations"),
        settings=settings,
    ) if punch_times else None
    if relaxation and relaxation.crossed_midnight:
        day_times = [t for t in punch_times if t > MORNING_CUTOFF]
        punch_logs = [p for p in punch_logs if p.punch_time > MORNING_CUTOFF]
    else:
        day_times = punch_times

    # ── Cross-midnight punch reattribution ───────────────────────────────
    # Separate from Night Shift Relaxation above (that's for a genuine
    # continuous night-shift session); this is for an ordinary day's
    # forgotten evening exit punch made hours late, after midnight, which
    # would otherwise be misread as tomorrow's first punch -silently
    # shifting every one of tomorrow's real punches down a slot. See
    # resolve_day_punch_logs. No-ops (returns punch_logs unchanged) when
    # disabled in Settings or for non-staff employees.
    resolved_logs = resolve_day_punch_logs(
        emp, d, punch_logs, settings, assignments=assignments,
        logs_by_date=prefetch.get("night_logs_by_date"),
    )
    if resolved_logs is not punch_logs:
        punch_logs = resolved_logs
        day_times = [p.punch_time for p in punch_logs]

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
        "late_in_without_permission": False, "early_out_without_permission": False,
        "permission_morning": False, "permission_morning_with_request": False,
        "permission_afternoon": False, "permission_afternoon_with_request": False,
        "permission_departure": False, "permission_departure_with_request": False,
        "permission_zone_count": 0, "permission_escalated_to_half_shift": False,
        "is_compensation_day": False,
        "is_half_day_leave": False,
        "late_reason": None,
        "first_punch": None, "last_punch": None,
    }

    is_production = emp.employment_type == "production"
    legacy_rule = d < NEW_ATTENDANCE_RULE_CUTOVER

    # This day's approved EmployeePermission, if any -staff only (Permission
    # for production has no equivalent role here). A bulk caller
    # (compute_month_records) supplies this once per month via prefetch;
    # otherwise it's looked up fresh, same convention as every other
    # prefetch-able lookup in this function.
    has_permission = False
    permission_time = None
    if not is_production:
        prefetched_permissions = prefetch.get("approved_permissions_by_date")
        if prefetched_permissions is not None:
            _perm = prefetched_permissions.get(d)
        else:
            from .models import EmployeePermission
            _perm = EmployeePermission.objects.filter(
                employee=emp, date=d, status="approved"
            ).order_by("-updated_at").first()
        has_permission = _perm is not None
        permission_time = _perm.permission_time if _perm else None

    # This day's Compensation Day announcement, if any -staff only. See
    # _compensation_day_for's docstring for scoping rules. `leave_until_time`
    # (when set) overrides the effective shift end for the Full/Half-Shift
    # decision below; either way, the resulting Late/Permission flags are
    # zeroed out afterward (a compensation day is never penalized), while
    # Full vs Half is still judged from real punches -never auto-granted.
    comp_day = None if is_production else _compensation_day_for(emp, d, settings=settings)

    if day_times or has_manual:
        if not day_times and has_manual:
            computed = {"status": "present", "shifts_earned": Decimal("1.00")}
        elif is_production:
            computed = _compute_production(emp, d, day_times, settings, prod_config, prod_segments)
        elif settings.attendance_mode == "simple":
            shift = _get_shift_for_date(emp, d, assignments=assignments)
            if comp_day and comp_day.leave_until_time and shift:
                from copy import copy
                shift = copy(shift)
                shift.end_time = comp_day.leave_until_time
            computed = _compute_staff_simple(
                emp, d, day_times, settings, shift, legacy_rule=legacy_rule,
                has_permission=has_permission, permission_time=permission_time,
            )
        else:
            computed = _compute_staff_strict(
                emp, d, punch_logs, day_times, assignments=assignments, relaxation=relaxation, legacy_rule=legacy_rule,
                has_permission=has_permission, permission_time=permission_time, settings=settings,
                shift_end_override=comp_day.leave_until_time if comp_day else None,
            )
        if comp_day:
            # Suppress every Late/Permission flag -a compensation day is
            # never penalized. Deliberately does NOT touch status/
            # shifts_earned/is_half_shift -Full vs Half still comes from
            # real punches (against leave_until_time as the effective shift
            # end, when set), never auto-granted.
            for key in (
                "late_afternoon", "late_in_without_permission", "early_out_without_permission",
                "permission_morning", "permission_morning_with_request",
                "permission_afternoon", "permission_afternoon_with_request",
                "permission_departure", "permission_departure_with_request",
            ):
                if key in computed:
                    computed[key] = False
            computed["is_late"] = False
            computed["late_reason"] = None

        # Half-Day Leave: a single punch (or a punctuality-window failure)
        # that the engine already resolved to Half Shift is exactly what a
        # half day covered by approved leave looks like -don't invent a new
        # status, just annotate it (shifts_earned stays the same 0.50 Half
        # Shift already pays, so payroll needs no separate branch either).
        # Deliberately does NOT touch a "present"/"absent" outcome: if the
        # employee worked the whole day anyway, their real attendance wins
        # (same "punches always win" rule the on_leave check already
        # follows); if they never punched at all, that falls through to the
        # ordinary absent branch below -a no-show for the half they still
        # owed is not covered by a half-day leave.
        if half_day_slot and not is_production and computed.get("status") == "half_shift":
            computed["is_half_day_leave"] = True
            if half_day_slot == LeaveRequest.HALF_DAY_MORNING:
                # Leave covers the morning -an afternoon-only arrival is
                # never "late"; they were never expected before the
                # half-shift reference time in the first place.
                computed["is_late"] = False
                computed["late_reason"] = None
            # Afternoon slot: the employee still owes a normal morning
            # arrival, so whatever is_late/late_reason the engine already
            # computed for that arrival is left exactly as it is.
    elif punch_times and relaxation and relaxation.crossed_midnight:
        # Only last night's checkout punches exist so far today -the employee
        # has not yet reported for the new day. Not absent; still within the
        # relaxation window (or simply not arrived yet).
        computed = {"status": "absent", "shifts_earned": Decimal("0")}
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

    # Apply the relaxation: arriving within the allowed window is never Late,
    # and a half-shift caused purely by the late arrival becomes a full shift
    # once the day is completed (a distinct evening punch exists).
    if relaxation and day_times:
        first_day_punch = day_times[0]
        record_report(relaxation, first_day_punch)
        if first_day_punch <= relaxation.allowed_until:
            fields["is_late"] = False
            # A Half-Day Leave's Half Shift is never eligible for this
            # promotion -it isn't "half" because of a late/incomplete punch
            # pattern the rest of the day could still complete, it's half
            # because the OTHER half is covered by approved leave.
            if fields.get("status") == "half_shift" and len(day_times) > 1 and not fields.get("is_half_day_leave"):
                fields["status"] = "present"
                fields["is_half_shift"] = False
                fields["shifts_earned"] = Decimal("1.00")

    # Daily/weekly Permission-zone caps (staff only -see _enforce_permission_
    # caps). Runs last, after Night Shift Relaxation, so a relaxation-driven
    # promotion back to Full Shift can't be silently undone by this, and this
    # can't be silently undone by relaxation either.
    if not is_production:
        _enforce_permission_caps(
            emp, d, fields, settings,
            week_permission_counts=prefetch.get("week_permission_counts"),
        )

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
    employee's shift assignment(s), night-shift rules/relaxation state) is
    fetched here ONCE for the whole month and handed down via `prefetch`.
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

    # One day before AND after the month too -night-shift detection for
    # day 1 needs the previous night's punches, and cross-midnight punch
    # reattribution (resolve_day_punch_logs) for the LAST day of the month
    # needs the following day's early punches to check.
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

    from .models import EmployeeShiftAssignment, NightShiftRelaxation, NightShiftRule
    from .night_shift import ensure_default_rules

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
    ensure_default_rules()
    night_rules = list(NightShiftRule.objects.filter(is_active=True))
    existing_relaxations = {
        r.relaxation_date: r for r in NightShiftRelaxation.objects.filter(
            employee=emp, relaxation_date__gte=month_start, relaxation_date__lte=month_end,
        )
    }
    from .models import EmployeePermission
    approved_permissions_by_date = {}
    if emp.employment_type != "production":
        for p in EmployeePermission.objects.filter(
            employee=emp, date__gte=month_start, date__lte=month_end, status="approved",
        ).order_by("updated_at"):
            approved_permissions_by_date[p.date] = p  # last write wins, matches -updated_at .first() elsewhere
    prefetch = {
        "assignments": assignments,
        "existing_day_records": existing_day_records,
        "manual_attendance_dates": manual_attendance_dates,
        "night_logs_by_date": logs_by_date,
        "night_rules": night_rules,
        "existing_relaxations": existing_relaxations,
        "approved_permissions_by_date": approved_permissions_by_date,
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
    """Compute final records for every day in [date_from, date_to] (inclusive)."""
    if settings is None:
        settings = PayrollSettings.get()

    today = ist_today()
    # One day of padding on each side -night-shift detection for the
    # first day and cross-midnight punch reattribution (resolve_day_punch_logs)
    # for the last day both need a neighboring day's punches to check.
    logs = AttendanceLog.objects.filter(
        employee=emp, date__gte=date_from - timedelta(days=1), date__lte=date_to + timedelta(days=1),
    ).order_by("punch_time")
    logs_by_date = {}
    for log in logs:
        logs_by_date.setdefault(log.date, []).append(log)

    months = {(d.year, d.month) for d in (date_from, date_to)}
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
            prefetch={"night_logs_by_date": logs_by_date},
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

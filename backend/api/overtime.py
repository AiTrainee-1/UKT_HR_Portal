"""
OT (Overtime) Detection Engine
==============================
Staff only. A day is measured by how far the LAST punch is past the employee's OWN assigned shift's end (never a fixed
clock time): AttendanceDayRecord.ot_extra_minutes, worked out by attendance_final from its own seconds-since-midnight
punch list, so a punch after midnight counts (the first OT screen subtracted clock times and never saw it).

Two kinds of OT, both following the rules in Settings -> Compensation (compensation_rules.py):

  Type 1 - "allowance": up to the Type 2 threshold (default 2 h 30) of extra work earns the next working day's first
      punch a late-in allowance. AUTOMATIC: a status "auto" row is listed for information, HR does nothing, nothing is
      paid. The attendance engine does NOT read these rows (it derives the allowance from the previous day itself), so a
      row that was never listed can never cost an employee their allowance.
  Type 2 - "shift": MORE than the threshold earns 0.25 / 0.50 / 0.75 / 1 shift. Detection lists the day as "detected"
      with the SUGGESTED shifts from the clock-time ladder; HR assigns it (compensation_views.overtime_assign) as
      relaxation (a day off) or pay, or rejects it.

Detection is a safe, idempotent upsert (sync_overtime): it never changes attendance or payroll on its own, never touches a
record HR has already decided (announced / rejected), writes NOTHING when nothing changed, and re-running it only
refreshes what is still undecided. Every write is conditional on the row still being undecided (a compare-and-set in the
database, not a decision from an in-memory snapshot), so an HR assignment or rejection that lands while a pass is running
is never overwritten or deleted, and two passes that run at the same moment cannot collide. Old "legacy" rows (made before
the overhaul, one day's pay or one credit when announced) are left exactly as they are, except that an undecided one whose
day now qualifies as Type 2 becomes a Type 2 candidate.

Who runs it, so the rows exist without anybody opening the OT page (the employee apps and the reports read them):
  * the scheduled pass (overtime_scheduler.py -> run_detection_job): re-derives the stored day of anybody whose punches
    arrived after it was last computed, then syncs the month;
  * the employee's own Compensation page (refresh_employee_overtime): the same for ONE employee, create / update only;
  * the HR OT list (compensation_views.overtime_list), for a login that may edit Compensation only: a view-only role never
    writes anything.

Gated like everything in the compensation overhaul: the master switch (PayrollSettings.compensation_feature_enabled) and
the feature's own switch (CompensationConfig.allowance_enabled / shift_enabled); Type 1 rows are only listed from the
allowance's effective-from date on (nothing is retroactive).
"""

import logging
from dataclasses import dataclass
from datetime import date as date_type, timedelta

from django.db import transaction
from django.db.models import Max, Q

from . import compensation_engine as comp
from . import compensation_rules as rules
from .clock import ist_today
from .models import (
    AttendanceDayRecord,
    AttendanceLog,
    CompensationConfig,
    CompensationRule,
    Employee,
    EmployeeShiftAssignment,
    OvertimeRecord,
    PayrollSettings,
)
from .shift_engine import _get_shift_for_date, _t2s

logger = logging.getLogger(__name__)

# The rows HR has not decided: the only ones detection may ever change or remove.
UNDECIDED = (OvertimeRecord.STATUS_AUTO, OvertimeRecord.STATUS_DETECTED)

# How far back a stored day is re-derived when punches arrived after it was last computed.
RECOMPUTE_DAYS = 3
# The window the employee's own page keeps in step (the allowance only ever applies to a recent day).
EMPLOYEE_WINDOW_DAYS = rules.LOOKBACK_DAYS
# The scheduled pass syncs this month, and the previous one while its last days can still change.
JOB_MONTH_GRACE_DAYS = 5


def _ot_minutes_for(last_punch, shift_end) -> int:
    """Whole minutes `last_punch` is past `shift_end` on the same clock (the first OT screen's measure). Kept for the
    demo-data generator (management/commands/md_demo); detection itself measures from the engine's own punch list."""
    return max(0, (_t2s(last_punch) - _t2s(shift_end)) // 60)


def _month_records(year: int, month: int, employees=None):
    qs = OvertimeRecord.objects.filter(date__year=year, date__month=month).select_related(
        "employee", "employee__department"
    )
    if employees is not None:
        qs = qs.filter(employee__in=employees)
    return list(qs.order_by("-date", "employee__employee_code"))


def extra_for_record(rec: AttendanceDayRecord, shift) -> int:
    """Extra minutes a stored day shows: its ot_extra_minutes, or - for a day not recomputed since that column existed
    - the same-day clock difference (a day-shift's last punch before midnight; an after-midnight punch can only come
    from the stored figure)."""
    if rec.ot_extra_minutes:
        return rec.ot_extra_minutes
    end = comp.shift_end_secs(shift)
    if end is None or end >= 86400 or rec.last_punch is None:
        return 0
    return rules.extra_minutes(_t2s(rec.last_punch), end)


@dataclass
class SyncResult:
    created: int = 0
    updated: int = 0
    deleted: int = 0

    @property
    def changed(self) -> bool:
        return bool(self.created or self.updated or self.deleted)


def _snapshot(employee_ids, date_from: date_type, date_to: date_type) -> dict:
    """The OT rows as they are right now: {(employee_id, date): row}. A pass decides from this and then writes only
    conditionally (see sync_overtime), so a row that changes after this read is never overwritten."""
    return {
        (r.employee_id, r.date): r
        for r in OvertimeRecord.objects.filter(employee_id__in=employee_ids, date__gte=date_from, date__lte=date_to)
    }


def _gates(settings=None, config=None):
    """(settings, config) when detection may run at all, else None: the master switch and at least one feature on."""
    if settings is None:
        settings = PayrollSettings.get()
    if not settings.compensation_feature_enabled:
        return None
    if config is None:
        config = CompensationConfig.get()
    if not (config.shift_enabled or config.allowance_enabled):
        return None
    return settings, config


def sync_overtime(
    date_from: date_type,
    date_to: date_type,
    settings=None,
    employee_ids=None,
    prune: bool = True,
    config=None,
) -> SyncResult:
    """Bring the OT rows of [date_from, date_to] in step with the stored attendance days of the active staff (all of them,
    or only `employee_ids`): create what is missing, refresh what is still undecided and, with `prune`, remove an
    undecided row whose day no longer qualifies. Writes nothing when nothing differs. Never touches a decided row."""
    result = SyncResult()
    gates = _gates(settings, config)
    if gates is None:
        return result
    settings, config = gates

    staff = Employee.objects.filter(status="active", employment_type="staff")
    if employee_ids is not None:
        staff = staff.filter(pk__in=list(employee_ids))
    employees = {e.pk: e for e in staff.only("id", "employment_type", "status")}
    if not employees:
        return result
    ids = list(employees)

    allowance_rules = (
        list(CompensationRule.objects.filter(kind=CompensationRule.KIND_ALLOWANCE, enabled=True))
        if config.allowance_enabled
        else []
    )
    shift_rules = (
        list(CompensationRule.objects.filter(kind=CompensationRule.KIND_SHIFT, enabled=True))
        if config.shift_enabled
        else []
    )
    threshold = config.shift_min_extra_minutes
    allowance_from = config.allowance_effective_from

    assignments: dict[int, list] = {}
    for a in (
        EmployeeShiftAssignment.objects.filter(employee_id__in=ids, effective_from__lte=date_to)
        .filter(Q(effective_to__isnull=True) | Q(effective_to__gte=date_from))
        .select_related("shift")
    ):
        assignments.setdefault(a.employee_id, []).append(a)

    # Only the four columns the measure needs, and no join onto the employee: the shift comes from `assignments`.
    day_records = (
        AttendanceDayRecord.objects.filter(
            employee_id__in=ids,
            date__gte=date_from,
            date__lte=date_to,
            status__in=["present", "half_shift"],
        )
        .exclude(last_punch__isnull=True)
        .only("employee_id", "date", "last_punch", "ot_extra_minutes")
    )
    existing = _snapshot(ids, date_from, date_to)

    wanted: dict[tuple, dict] = {}  # (employee_id, date) -> the row this day should be
    for rec in day_records:
        emp = employees[rec.employee_id]
        emp_assignments = assignments.get(rec.employee_id, [])
        shift = _get_shift_for_date(emp, rec.date, assignments=emp_assignments)
        if shift is None or shift.end_time is None:
            continue
        if comp.is_off_day(emp, rec.date, emp_assignments):
            continue  # work on a Sunday / holiday is not OT: it is Compensation Leave (holiday work)
        extra = extra_for_record(rec, shift)
        if extra <= 0:
            continue
        end_secs = comp.shift_end_secs(shift)
        last_minutes = end_secs // 60 + extra  # minutes since the OT day's midnight (after midnight: 1440 +)
        base = {
            "shift_end_time": shift.end_time,
            "last_punch_out": rec.last_punch,
            "ot_minutes": extra,
        }
        if config.shift_enabled and rules.is_type2_day(extra, threshold):
            wanted[(rec.employee_id, rec.date)] = {
                **base,
                "ot_type": OvertimeRecord.OT_TYPE_SHIFT,
                "status": OvertimeRecord.STATUS_DETECTED,
                "suggested_shifts": rules.shift_for_last_punch(last_minutes, shift_rules),
                "allowance_minutes": 0,
            }
        elif config.allowance_enabled and (allowance_from is None or rec.date >= allowance_from):
            minutes = rules.allowance_minutes_for(extra, allowance_rules, max_extra=threshold)
            if minutes > 0:
                wanted[(rec.employee_id, rec.date)] = {
                    **base,
                    "ot_type": OvertimeRecord.OT_TYPE_ALLOWANCE,
                    "status": OvertimeRecord.STATUS_AUTO,
                    "allowance_minutes": minutes,
                    "suggested_shifts": None,
                }

    to_create: list[OvertimeRecord] = []
    to_update: list[tuple[OvertimeRecord, dict]] = []
    for key, values in wanted.items():
        row = existing.get(key)
        if row is None:
            to_create.append(OvertimeRecord(employee_id=key[0], date=key[1], **values))
            continue
        if row.status not in UNDECIDED:
            continue  # HR already decided: never silently re-flag it
        if row.ot_type == OvertimeRecord.OT_TYPE_LEGACY and values["ot_type"] != OvertimeRecord.OT_TYPE_SHIFT:
            continue  # an undecided legacy row stays what it was unless the day is now a Type 2 candidate
        changed = {field: value for field, value in values.items() if getattr(row, field) != value}
        if changed:  # nothing differs: nothing is written (a read must not turn into hundreds of UPDATEs)
            to_update.append((row, changed))

    # Rows this pass no longer wants: an undecided Type 1 row (kept in step with the rules) and an undecided Type 2
    # candidate whose day no longer qualifies (a punch was corrected, a threshold raised). Only for the kinds that are on.
    stale: list[int] = []
    if prune:
        for key, row in existing.items():
            if key in wanted:
                continue
            if config.allowance_enabled and row.status == OvertimeRecord.STATUS_AUTO:
                stale.append(row.pk)
            elif (
                config.shift_enabled
                and row.status == OvertimeRecord.STATUS_DETECTED
                and row.ot_type == OvertimeRecord.OT_TYPE_SHIFT
            ):
                stale.append(row.pk)

    if not (to_create or to_update or stale):
        return result

    with transaction.atomic():
        if to_create:
            # ON CONFLICT DO NOTHING: another pass that inserted the same day a moment ago wins, and nothing breaks.
            # In key order, so two passes that insert overlapping days can never wait on each other.
            to_create.sort(key=lambda row: (row.employee_id, row.date))
            OvertimeRecord.objects.bulk_create(to_create, ignore_conflicts=True)
            result.created = len(to_create)
        # Always in primary-key order, so two passes that overlap can never wait on each other's rows.
        for row, changed in sorted(to_update, key=lambda pair: pair[0].pk):
            # Conditional on the row STILL being undecided: an assignment or rejection committed after the snapshot
            # above makes this match nothing, and the HR decision stands.
            result.updated += OvertimeRecord.objects.filter(pk=row.pk, status__in=UNDECIDED).update(**changed)
        if stale:
            victims = list(
                OvertimeRecord.objects.select_for_update()
                .filter(pk__in=stale, status__in=UNDECIDED)
                .exclude(ot_type=OvertimeRecord.OT_TYPE_LEGACY)
                .order_by("pk")
                .values_list("pk", flat=True)
            )
            if victims:
                OvertimeRecord.objects.filter(pk__in=victims).delete()
                result.deleted = len(victims)
    return result


def detect_overtime_for_month(
    year: int, month: int, settings=None, employee_ids=None, write: bool = True
) -> list[OvertimeRecord]:
    """
    Detect OT for every active staff employee across the given month, upsert OvertimeRecord rows (Type 1 "auto",
    Type 2 "detected", never overwriting an already announced/rejected row's decision), and return the current full
    list for that month. Safe to call repeatedly: re-running never re-flags a record HR has already reviewed, and a
    pass that finds nothing to change writes nothing.

    `employee_ids` limits detection and the answer to those staff. `write=False` only READS (the rows as they are): what a
    view-only login gets, and what a caller that only needs the list asks for.
    """
    if settings is None:
        settings = PayrollSettings.get()
    # Master off-switch: the Compensation feature as a whole. Checked here too (not just at the API layer) so any
    # non-API caller (a management command, a cron job) can't detect OT while the feature is meant to be fully off.
    gates = _gates(settings)
    if gates is None:
        return _month_records(year, month)

    month_start = date_type(year, month, 1)
    month_end = (month_start.replace(day=28) + timedelta(days=4)).replace(day=1) - timedelta(days=1)
    if write:
        sync_overtime(month_start, month_end, settings=gates[0], employee_ids=employee_ids, config=gates[1])
    staff = Employee.objects.filter(status="active", employment_type="staff")
    if employee_ids is not None:
        staff = staff.filter(pk__in=list(employee_ids))
    return _month_records(year, month, staff)


# ── keeping the rows (and the days they come from) fresh without anybody opening the OT page ──


def recompute_stale_days(date_from: date_type, date_to: date_type, employee_ids=None, settings=None) -> int:
    """Re-derive the stored attendance day of every active staff member whose punches arrived AFTER that day was last
    computed (or that has punches and no stored day at all), for the days in [date_from, date_to]. A day's OT comes from
    its stored record, and a record is only ever written when somebody looks at that day: this is what makes the rows
    exist without anyone looking. Only those days are touched: a quiet roster costs two queries. A day HR set by hand
    (source manual) is never recomputed. Returns how many employees were recomputed."""
    from .attendance_final import compute_range_records

    staff = Employee.objects.filter(status="active", employment_type="staff")
    if employee_ids is not None:
        staff = staff.filter(pk__in=list(employee_ids))
    ids = list(staff.values_list("pk", flat=True))
    if not ids:
        return 0
    latest_punch: dict[tuple, object] = {}
    for row in (
        AttendanceLog.objects.filter(
            employee_id__in=ids, date__gte=date_from, date__lte=date_to + timedelta(days=1)
        )
        .values("employee_id", "date")
        .annotate(latest=Max("created_at"))
        .order_by()
    ):
        latest_punch[(row["employee_id"], row["date"])] = row["latest"]
    if not latest_punch:
        return 0
    stored = {
        (r["employee_id"], r["date"]): r
        for r in AttendanceDayRecord.objects.filter(
            employee_id__in={k[0] for k in latest_punch}, date__gte=date_from, date__lte=date_to
        ).values("employee_id", "date", "updated_at", "source")
    }
    dirty: dict[int, set] = {}
    for (emp_id, punch_day), latest in latest_punch.items():
        # a punch stamped after midnight can belong to the day before it, so it makes both days stale
        for day in (punch_day, punch_day - timedelta(days=1)):
            if not date_from <= day <= date_to:
                continue
            record = stored.get((emp_id, day))
            if record is not None and (record["source"] == "manual" or record["updated_at"] >= latest):
                continue
            dirty.setdefault(emp_id, set()).add(day)
    if not dirty:
        return 0
    if settings is None:
        settings = PayrollSettings.get()
    done = 0
    for emp in Employee.objects.filter(pk__in=list(dirty)).order_by("pk"):
        days = dirty[emp.pk]
        try:
            compute_range_records(emp, min(days), max(days), settings)
            done += 1
        except Exception:
            # one broken employee never stops the rest (and never breaks the page that asked)
            logger.exception("Re-deriving the attendance of employee %s (%s to %s) failed", emp.pk, min(days), max(days))
    return done


def refresh_employee_overtime(emp, today: date_type | None = None, settings=None) -> SyncResult | None:
    """The lazy refresh the employee's own Compensation page does: re-derive that employee's recent stored days if their
    punches are newer, then create / update the OT rows of the recent window. Create / update only (nothing is pruned
    here: that is the scheduled pass's and the HR list's job), only ever the employee's own undecided rows. None when
    the features are off or the employee is not active staff."""
    if emp.employment_type != "staff" or emp.status != "active":
        return None
    gates = _gates(settings)
    if gates is None:
        return None
    settings, config = gates
    today = today or ist_today()
    recompute_stale_days(today - timedelta(days=RECOMPUTE_DAYS), today, employee_ids=[emp.pk], settings=settings)
    return sync_overtime(
        today - timedelta(days=EMPLOYEE_WINDOW_DAYS),
        today,
        settings=settings,
        employee_ids=[emp.pk],
        prune=False,
        config=config,
    )


def run_detection_job(today: date_type | None = None) -> dict:
    """The scheduled pass (overtime_scheduler.py): re-derive the recent days whose punches are newer than their stored
    record, then sync the OT rows of the current month (and of the previous one while its last days can still change) for
    every active staff member. Does nothing at all while the master switch or both OT features are off."""
    gates = _gates()
    if gates is None:
        return {"skipped": True}
    settings, config = gates
    today = today or ist_today()
    recomputed = recompute_stale_days(today - timedelta(days=RECOMPUTE_DAYS), today, settings=settings)
    first = (today - timedelta(days=JOB_MONTH_GRACE_DAYS)).replace(day=1)
    result = sync_overtime(first, today, settings=settings, config=config)
    return {
        "skipped": False,
        "recomputed": recomputed,
        "created": result.created,
        "updated": result.updated,
        "deleted": result.deleted,
    }


def next_working_day(emp, d: date_type, assignments=None, lookahead: int = rules.LOOKBACK_DAYS):
    """The first working day after `d` (skipping Sundays, company holidays and an off Saturday), or None."""
    cursor = d + timedelta(days=1)
    for _ in range(lookahead):
        if not comp.is_off_day(emp, cursor, assignments):
            return cursor
        cursor += timedelta(days=1)
    return None

"""
Late Detection and half-day reports (category "attendance").

* late-coming family: ``late-coming-detail`` | ``late-summary-counts`` | ``late-penalty-breakdown``
* ``early-out``
* ``half-day``

All of them read the STORED ``AttendanceDayRecord`` verdicts (see attendance_analysis_common) and
re-derive only what the engine never stores (minutes late / early, the half that was worked, the
cause of a half day). The pool figures use ``attendance_final.late_pool_summary`` and payroll's own
working-day calendar, slab table and rounding, so they equal the payslip.
"""

from __future__ import annotations

from collections import Counter, defaultdict
from datetime import timedelta
from decimal import Decimal

from django.db.models import Count

from api.attendance_final import half_period, late_pool_summary
from api.models import EmployeePermission, LeaveRequest
from api.payroll_views import _d2, late_pool_pricing
from api.shift_engine import _t2s

from ..common import EMP_COLS_SHORT, emp_cells
from ..filters import boolean, date_range, period, select, text
from ..formatting import month_bounds, parse_date, r2
from ..registry import register
from ..types import (
    BADGE,
    CURRENCY,
    DATE,
    INTEGER,
    MINUTES,
    NUMBER,
    TEXT,
    TIME,
    ColumnSpec,
    ReportResult,
    ReportSpec,
)
from .attendance_analysis_common import (
    STATUS_LABELS,
    Roster,
    coverage_notes,
    day_abbr,
    day_records,
    emp_sort_key,
    evening_earliness,
    hm,
    morning_lateness,
    payroll_settings,
    people,
    production_config,
    scope_filters,
    secs_hm,
    subtotals_within_limit,
)
from .attendance_core_data import (
    allowance_minutes,
    is_relaxation_day,
    window_early_out_applied,
    window_late_in_applied,
)
from .production_judge import ProductionJudge

MODULES = ("attendance",)

PERMISSION_EFFECT = (
    ("applied", "Permission applied"),
    ("excess", "Permission excess (over cap)"),
    ("none", "No permission"),
)
POOL_FILTER = (("counted", "Counted in the late pool"), ("not_counted", "Not counted"))
MIN_LATE = (
    ("5", "5+ minutes"),
    ("10", "10+ minutes"),
    ("15", "15+ minutes"),
    ("30", "30+ minutes"),
    ("60", "60+ minutes"),
)

_RANGE_DAYS = 92


def _avg(values: list[int]) -> float | None:
    return round(sum(values) / len(values), 1) if values else None


def _slab_text(settings) -> str:
    rows = []
    for row in settings.late_deduction_slabs or []:
        if isinstance(row, dict) and "fromLates" in row and "deductionShifts" in row:
            rows.append((int(row["fromLates"]), Decimal(str(row["deductionShifts"]))))
    if not rows:
        return "no deduction slabs are configured (late pool is not priced)"
    rows.sort()
    return "; ".join(f"{a}+ billable = {b.normalize():f} shift" for a, b in rows)


def _permission_slab_text(settings) -> str:
    rows = []
    for row in settings.permission_deduction_slabs or []:
        if isinstance(row, dict) and "fromPermissions" in row and "deductionShifts" in row:
            rows.append((int(row["fromPermissions"]), Decimal(str(row["deductionShifts"]))))
    if not rows:
        return "no permission slabs are configured (excess permissions are not priced)"
    rows.sort()
    return "; ".join(f"{a}+ billable = {b.normalize():f} shift" for a, b in rows)


def _permission_badge(applied: bool, excess: bool) -> str | None:
    if excess:
        return "Excess"
    if applied:
        return "Applied"
    return None


def _pool_status(rec, emp, roster: Roster, excess_flag: bool, priced: bool = False) -> str:
    """Is this flagged day one occurrence of the payroll late pool? With Permission Deduction Slabs ON (`priced`) a
    day whose excess permission is on the same edge is an occurrence of the late pool itself (the permission is
    absorbed by it, not priced again); with the switch off it is merged into the excess permission."""
    if emp.employment_type == "production":
        return "Production (separate)"
    if rec.status not in ("present", "half_shift"):
        return "Not counted (day status)"
    if rec.date not in roster.working_days(emp.id, rec.date.year, rec.date.month):
        return "Non-working day"
    if excess_flag and not priced:
        return "Merged with excess permission"
    return "Counted"


def _production_grace(pcfg) -> int:
    """The engine reads a 0 / empty grace as the 10-minute default (``attendance_final._compute_production``)."""
    return pcfg.grace_minutes or 10


def _prod_judged(pcfg, rec):
    """The shift-table verdict (group, start, main out, grace) of a stored production day the rules judged, else None:
    a day before the effective date was judged by the legacy punch-1 / punch-4 times and the 10-minute grace."""
    return ProductionJudge(pcfg).judgement(rec)


def _prod_early(judged):
    """(effective end seconds, deadline seconds, minutes before the end) of a production day the shift table judged early,
    or None when it was not."""
    if not judged.early_leave or judged.main_out_time is None or judged.early_minutes <= 0:
        return None
    end = judged.main_out_time.hour * 3600 + judged.main_out_time.minute * 60
    return end, end - judged.grace_minutes * 60, judged.early_minutes


def _morning_basis(emp, rec, roster: Roster, pcfg):
    """(shift name, start time, grace) the day was judged against."""
    if emp.employment_type == "production":
        judged = _prod_judged(pcfg, rec)
        if judged is not None:
            return f"Production: {judged.group.label}", judged.start_time, judged.grace_minutes
        return "Production (fixed times)", pcfg.punch1_time, _production_grace(pcfg)
    shift = roster.shift_on(emp.id, rec.date)
    if shift is None:
        return None, None, 0
    return shift.name, shift.start_time, shift.grace_period_minutes


def _evening_basis(emp, rec, roster: Roster, pcfg):
    if emp.employment_type == "production":
        judged = _prod_judged(pcfg, rec)
        if judged is not None and judged.main_out_time is not None:
            return f"Production: {judged.group.label}", judged.main_out_time, judged.grace_minutes
        return "Production (fixed times)", pcfg.punch4_time, _production_grace(pcfg)
    shift = roster.shift_on(emp.id, rec.date)
    if shift is None:
        return None, None, 0
    return shift.name, shift.end_time, shift.grace_period_minutes


def _window_late(emp, rec) -> bool:
    """Did a company-announced late-in time decide this staff day's arrival (so its start and grace are not the shift's)?"""
    return emp.employment_type != "production" and window_late_in_applied(rec)


def _window_early(emp, rec) -> bool:
    return emp.employment_type != "production" and window_early_out_applied(rec)


def _lateness(emp, rec, start, grace, pcfg=None):
    """morning_lateness of a stored late day, measured from the start the engine really judged it against: a Type 1
    next-day allowance moved the start later by the minutes the day record carries; a company-announced late-in replaced
    the start and grace by a time the record does not keep, so that day is not measured at all (None: unknown, never a
    guess). Production has neither. A production day the shift table judged is compared to the minute against its group's
    start + the rules' grace (as the engine does); an older day to the second against the legacy punch-1 time."""
    if emp.employment_type == "production":
        in_force = pcfg is not None and _prod_judged(pcfg, rec) is not None
        return morning_lateness(
            rec.first_punch, start, grace, rec.morning_permission_applied, exact_seconds=not in_force
        )
    if window_late_in_applied(rec):
        return None
    return morning_lateness(
        rec.first_punch, start, grace, rec.morning_permission_applied, start_shift_minutes=allowance_minutes(rec)
    )


# ═════════════════════════════════════════════════════════════════════════════
#  late-coming-detail
# ═════════════════════════════════════════════════════════════════════════════

_DETAIL_COLS = (
    *EMP_COLS_SHORT,
    ColumnSpec("date", "Date", DATE, 1.4),
    ColumnSpec("day", "Day", TEXT, 0.6),
    ColumnSpec("shift", "Shift", TEXT, 1.4),
    ColumnSpec("shiftStart", "Eff. start", TIME, 0.9),
    ColumnSpec("graceMinutes", "Grace (min)", MINUTES, 0.8),
    ColumnSpec("deadline", "Deadline", TIME, 1.15),
    ColumnSpec("firstPunch", "First punch", TIME, 0.9),
    ColumnSpec("lateMinutes", "Late by (min)", MINUTES, 0.9, total="sum"),
    ColumnSpec("beyondGrace", "Past deadline (min)", MINUTES, 1.2, total="sum"),
    ColumnSpec("permission", "Permission", BADGE, 1.3),
    ColumnSpec("poolStatus", "Late pool", BADGE, 1.7),
    ColumnSpec("status", "Day status", BADGE, 0.9),
    ColumnSpec("reason", "Engine reason", TEXT, 3.4),
)


def _late_detail_run(ctx):
    d_from, d_to = ctx.date_from, ctx.date_to
    settings = payroll_settings()
    pcfg = production_config()
    roster = Roster(ctx, d_from, d_to)
    people_by_id = people(ctx)

    qs = day_records(ctx, d_from, d_to, is_late=True)
    effect = ctx.params.get("permissionEffect")
    if effect == "applied":
        qs = qs.filter(morning_permission_applied=True)
    elif effect == "excess":
        qs = qs.filter(morning_permission_excess=True)
    elif effect == "none":
        qs = qs.filter(morning_permission_applied=False, morning_permission_excess=False)

    shift_text = (ctx.params.get("shift") or "").lower()
    min_late = int(ctx.params.get("minLate") or 0)
    pool_filter = ctx.params.get("poolFilter")
    python_filtered = bool(shift_text or min_late or pool_filter)
    qs = qs.order_by("date", "id")
    if not python_filtered:
        qs = qs[: ctx.row_limit]
    records = [r for r in qs if r.employee_id in people_by_id]

    built = []
    windowed = moved = 0  # rows judged against an announced late-in time / against a start the allowance moved
    for rec in records:
        emp = people_by_id[rec.employee_id]
        shift_name, start, grace = _morning_basis(emp, rec, roster, pcfg)
        if shift_text and shift_text not in (shift_name or "").lower():
            continue
        window = _window_late(emp, rec)
        allowance = 0 if emp.employment_type == "production" else allowance_minutes(rec)
        late = _lateness(emp, rec, start, grace, pcfg)
        late_min = late[2] if late else None
        if min_late and (late_min is None or late_min < min_late):
            continue
        pool = _pool_status(rec, emp, roster, rec.morning_permission_excess, bool(settings.permission_pricing_enabled))
        if pool_filter == "counted" and pool != "Counted":
            continue
        if pool_filter == "not_counted" and pool == "Counted":
            continue
        windowed += window
        moved += bool(allowance)
        if window:  # the announced time is the start and there is no grace: nothing of the shift's applies
            shown_start = None
        elif late:
            shown_start = secs_hm(late[0])
        else:
            shown_start = secs_hm(_t2s(start) + 60 * allowance) if start else None
        row = {
            **emp_cells(emp),
            "date": rec.date.isoformat(),
            "day": day_abbr(rec.date),
            "shift": shift_name or "No shift assigned",
            "shiftStart": shown_start,
            "graceMinutes": None if window else (grace if start is not None else None),
            "deadline": secs_hm(late[1]) if late else None,
            "firstPunch": hm(rec.first_punch),
            "lateMinutes": late_min,
            "beyondGrace": late[3] if late else None,
            "permission": _permission_badge(rec.morning_permission_applied, rec.morning_permission_excess),
            "poolStatus": pool,
            "status": STATUS_LABELS.get(rec.status, rec.status),
            "reason": rec.late_reason,
        }
        built.append((emp_sort_key(emp), rec.date, row))
    built.sort(key=lambda t: (t[0], t[1]))
    rows = [t[2] for t in built]

    minutes = [r["lateMinutes"] for r in rows if r["lateMinutes"] is not None]
    summary = [
        {"label": "Late occurrences", "value": len(rows), "format": "integer"},
        {"label": "Employees affected", "value": len({r["employeeCode"] for r in rows}), "format": "integer"},
        {"label": "Average late (min)", "value": _avg(minutes), "format": "number"},
        {"label": "Longest late (min)", "value": max(minutes) if minutes else None, "format": "integer"},
        {
            "label": "Counted in late pool",
            "value": sum(1 for r in rows if r["poolStatus"] == "Counted"),
            "format": "integer",
        },
    ]
    rows, sub_note = subtotals_within_limit(ctx, rows, lambda r: r["department"], ["lateMinutes", "beyondGrace"])

    notes = [
        "Each row is one day flagged Late-In by Attendance. The day record stores only the flag, so the minutes are "
        "re-derived from the stored first punch and the shift in force that day (arrivals compared to the minute; "
        "an approved in-cap Morning Late-In permission moves the start by 60 minutes; grace is added on top). A "
        "production day on or after the date the shift-table rules start is measured from its group's start time "
        "(Day / Night / Sunday) with the rules' own grace; an earlier production day from the legacy arrival time.",
        "Late by = first punch minus effective start. Past deadline = first punch minus (effective start + grace). The "
        "effective start is the one the engine used, so a next-day OT late-in allowance moves it later.",
        "Night Late (strict-mode lunch return) is informational, never priced, and is not listed here.",
    ]
    if not settings.morning_late_in_enabled:
        notes.append(
            "Morning Late-In detection is currently switched off in Attendance settings; rows shown were flagged while it was on."
        )
    if moved:
        notes.append(
            f"{moved} row(s) used a next-day OT late-in allowance: the engine moved their start later by those minutes, so "
            "Eff. start, Deadline and the minutes are measured from the moved start (the allowance is not late time)."
        )
    if windowed:
        notes.append(
            f"{windowed} row(s) are days with a company-announced late-in time: the engine judged them against that announced "
            "time with no grace, which the day record does not keep, so their start, deadline and minutes are left blank "
            "(the flag is kept, the minutes are not guessed)."
        )
    blank = sum(1 for r in rows if r.get("_kind") is None and r.get("lateMinutes") is None) - windowed
    if blank > 0:
        notes.append(
            f"{blank} row(s) show no minutes: the shift could not be found for that day or was edited after the day was "
            "computed (the flag is kept, the minutes are not guessed)."
        )
    notes.append("Employees with no shift assignment are never flagged late, so they cannot appear here.")
    if sub_note:
        notes.append(sub_note)
    notes.extend(coverage_notes(ctx, people_by_id, d_from, d_to))
    return ReportResult(rows=rows, summary=summary, notes=notes)


register(
    ReportSpec(
        id="late-coming-detail",
        title="Late Coming Detail",
        description="Every Morning Late-In day with shift, deadline, first punch, minutes late and permission effect.",
        category="attendance",
        family="late-coming",
        variant="Detail",
        icon="Clock",
        tags=("late", "late in", "late detection", "punctuality", "late coming"),
        modules=MODULES,
        filters=(
            date_range("thisMonth", max_days=_RANGE_DAYS),
            *scope_filters(employment_default="staff"),
            select("permissionEffect", "Permission effect", PERMISSION_EFFECT),
            select("minLate", "Minimum late by", MIN_LATE),
            select("poolFilter", "Late pool", POOL_FILTER, placeholder="All"),
            # A free-text shift name: shift templates are data, not fixed options.
            text("shift", "Shift name contains", "e.g. General"),
        ),
        columns=_DETAIL_COLS,
        run=_late_detail_run,
    )
)


# ═════════════════════════════════════════════════════════════════════════════
#  late-summary-counts / late-penalty-breakdown  (month pools)
# ═════════════════════════════════════════════════════════════════════════════


class _EmpMonth:
    """One employee's month of stored day records plus everything the late pool needs."""

    __slots__ = (
        "emp",
        "records",
        "working",
        "approved",
        "pool",
        "flagged",
        "minutes",
        "worst_day",
        "night",
        "halves",
        "shift_name",
        "unmeasured",
    )


def _month_pools(ctx, year: int, month: int):
    """[_EmpMonth] for every scoped employee with at least one stored record in the month, in register order."""
    m_from, m_to = month_bounds(year, month)
    settings = payroll_settings()
    pcfg = production_config()
    roster = Roster(ctx, m_from, m_to)
    people_by_id = people(ctx, "salary_amount")

    by_emp = defaultdict(list)
    for rec in day_records(ctx, m_from, m_to).order_by("date"):
        if rec.employee_id in people_by_id:
            by_emp[rec.employee_id].append(rec)

    approved = dict(
        EmployeePermission.objects.filter(ctx.emp_q("employee__"), status="approved", date__gte=m_from, date__lte=m_to)
        .values("employee_id")
        .annotate(n=Count("id"))
        .values_list("employee_id", "n")
    )

    out = []
    for emp_id, recs in by_emp.items():
        emp = people_by_id[emp_id]
        em = _EmpMonth()
        em.emp, em.records = emp, recs
        is_prod = emp.employment_type == "production"
        em.approved = approved.get(emp_id, 0)
        if is_prod:
            em.working, em.pool = None, None
        else:
            em.working = roster.working_days(emp_id, year, month)
            em.pool = late_pool_summary(recs, em.approved, settings, counted_dates=set(em.working))
        em.flagged = sum(1 for r in recs if r.is_late)
        em.night = sum(1 for r in recs if r.late_afternoon)
        em.halves = sum(1 for r in recs if r.status == "half_shift")
        minutes = []
        worst = None
        em.unmeasured = 0  # flagged days whose start the day record does not keep (an announced late-in)
        for r in recs:
            if not r.is_late:
                continue
            _name, start, grace = _morning_basis(emp, r, roster, pcfg)
            late = _lateness(emp, r, start, grace, pcfg)
            if late:
                minutes.append(late[2])
                if worst is None or late[2] > worst[0]:  # the earliest date wins a tie (records are in date order)
                    worst = (late[2], r.date)
            elif _window_late(emp, r):
                em.unmeasured += 1
        em.minutes = minutes
        em.worst_day = worst[1] if worst else None
        if is_prod:
            em.shift_name = None
        else:
            asg = roster.assignment_on(emp_id, m_from.replace(day=15))
            em.shift_name = asg.shift.name if asg else "No shift assigned"
        out.append(em)
    out.sort(key=lambda em: emp_sort_key(em.emp))
    return out, settings, roster, people_by_id


_COUNT_COLS = (
    *EMP_COLS_SHORT,
    ColumnSpec("shift", "Shift", TEXT, 1.4),
    ColumnSpec("workingDays", "Working days", INTEGER, 0.9),
    ColumnSpec("lateDays", "Late days flagged", INTEGER, 1.0, total="sum"),
    ColumnSpec("lateIn", "Late-In (pool)", INTEGER, 0.9, total="sum"),
    ColumnSpec("earlyOut", "Early-Out (pool)", INTEGER, 0.9, total="sum"),
    ColumnSpec("excessPermissions", "Excess permissions", INTEGER, 1.0, total="sum"),
    ColumnSpec("poolTotal", "Pool total", INTEGER, 0.8, total="sum"),
    ColumnSpec("freeUsed", "Free used", INTEGER, 0.7, total="sum"),
    ColumnSpec("billable", "Billable", INTEGER, 0.8, total="sum"),
    ColumnSpec("minutesTotal", "Late minutes", MINUTES, 0.9, total="sum"),
    ColumnSpec("minutesAvg", "Avg late (min)", MINUTES, 0.9),
    ColumnSpec("minutesMax", "Worst late (min)", MINUTES, 0.9),
    ColumnSpec("worstDay", "Worst day", DATE, 1.4),
    ColumnSpec("approvedPermissions", "Approved permissions", INTEGER, 1.0, total="sum"),
    ColumnSpec("nightLate", "Night late (info)", INTEGER, 0.9, total="sum"),
    ColumnSpec("halfDays", "Half days", INTEGER, 0.7, total="sum"),
)

MIN_POOL = (("1", "1 or more"), ("3", "3 or more"), ("4", "4 or more (billable)"), ("6", "6 or more"))


def _counts_run(ctx):
    year, month = ctx.period
    pools, settings, roster, people_by_id = _month_pools(ctx, year, month)
    min_pool = int(ctx.params.get("minPool") or 0)
    only_billable = bool(ctx.params.get("onlyBillable"))
    priced = bool(settings.permission_pricing_enabled)  # Permission Deduction Slabs: excess permissions priced apart
    show_early = bool(settings.evening_early_out_enabled) or any(em.pool and em.pool["early_out"] for em in pools)
    # Night late is a strict-mode (lunch-return) flag: in Simple mode the column would be zeros only.
    show_night = settings.attendance_mode == "strict" or any(em.night for em in pools)

    rows = []
    kept = []
    for em in pools:
        pool = em.pool
        pool_total = pool["total"] if pool else None
        if min_pool and (pool_total or 0) < min_pool:
            continue
        if only_billable and not (pool and (pool["billable"] > 0 or pool["permission_billable"] > 0)):
            continue
        kept.append(em)
        rows.append(
            {
                **emp_cells(em.emp),
                **(
                    {
                        "permissionPriced": pool["permission_pool"] if pool else None,
                        "permissionBillable": pool["permission_billable"] if pool else None,
                    }
                    if priced
                    else {}
                ),
                "shift": em.shift_name,
                "workingDays": len(em.working) if em.working is not None else None,
                "lateDays": em.flagged,
                "lateIn": pool["late_in"] if pool else None,
                "earlyOut": pool["early_out"] if pool else None,
                "excessPermissions": pool["excess_permissions"] if pool else None,
                "poolTotal": pool_total,
                "freeUsed": pool["free_used"] if pool else None,
                "billable": pool["billable"] if pool else None,
                # flagged days whose minutes could not be re-derived are unknown, not zero
                "minutesTotal": sum(em.minutes) if em.minutes else (None if em.flagged else 0),
                "minutesAvg": round(sum(em.minutes) / len(em.minutes)) if em.minutes else None,
                "minutesMax": max(em.minutes) if em.minutes else None,
                "worstDay": em.worst_day.isoformat() if em.worst_day else None,
                "approvedPermissions": em.approved if pool else None,
                "nightLate": em.night,
                "halfDays": em.halves,
            }
        )
    sum_keys = [
        "lateDays",
        "lateIn",
        "earlyOut",
        "excessPermissions",
        "poolTotal",
        "freeUsed",
        "billable",
        "minutesTotal",
        "approvedPermissions",
        "nightLate",
        "halfDays",
    ]
    if priced:
        sum_keys += ["permissionPriced", "permissionBillable"]
    rows, sub_note = subtotals_within_limit(ctx, rows, lambda r: r["department"], sum_keys)

    staff = [em for em in kept if em.pool]
    summary = [
        {
            "label": "Employees with lates",
            "value": sum(1 for em in kept if em.flagged or (em.pool and em.pool["total"])),
            "format": "integer",
        },
        {
            "label": "Over the free allowance",
            "value": sum(1 for em in staff if em.pool["billable"] > 0 or em.pool["permission_billable"] > 0),
            "format": "integer",
        },
        {"label": "Pool occurrences", "value": sum(em.pool["total"] for em in staff), "format": "integer"},
        {"label": "Late minutes", "value": sum(sum(em.minutes) for em in kept), "format": "minutes"},
        {
            "label": "Free allowance / month",
            "value": max(0, int(settings.late_free_allowance or 0)),
            "format": "integer",
        },
        {
            "label": "Permission cap / month",
            "value": max(0, int(settings.permission_monthly_cap or 0)),
            "format": "integer",
        },
    ]
    if priced:
        summary.append(
            {
                "label": "Permission free allowance / month",
                "value": max(0, int(settings.permission_free_allowance or 0)),
                "format": "integer",
            }
        )
    notes = [
        f"Late pool for {month_bounds(year, month)[0]:%B %Y}, computed live from the stored day records with the same "
        + (
            "formula payroll uses: Late-In days + Early-Out days; only present / half-day days on payroll working days "
            "count. Permission Deduction Slabs are ON, so approved permissions beyond the monthly cap are NOT in this "
            "pool: they are priced on their own (Priced separately / Permission billable). A late day that carries an "
            "excess permission on the same edge stays one occurrence, counted here, and that permission is not priced again."
            if priced
            else "formula payroll uses: Late-In days + Early-Out days + approved permissions beyond the monthly cap; only "
            "present / half-day days on payroll working days count; a late day that carries an excess permission on the "
            "same edge is one occurrence, not two."
        ),
        "Late days flagged is the raw number of flagged days (Sundays and other non-working days included), so it can "
        "exceed Late-In (pool). Production employees are not part of the staff pool (their rules are separate); pool "
        "columns show a dash for them.",
        "Late minutes are re-derived from first punch and shift (see Late Coming Detail); a next-day OT late-in allowance "
        "moves the start later by its minutes.",
    ]
    unmeasured = sum(em.unmeasured for em in kept)
    if unmeasured:
        notes.append(
            f"{unmeasured} flagged day(s) were judged against a company-announced late-in time the day record does not keep: "
            "they count in Late days flagged and in the pool, but their minutes are left out (never guessed)."
        )
    if show_night:
        notes.append(
            "Night late (strict-mode lunch return) is informational only: it is never priced and never demotes a day."
        )
    else:
        notes.append(
            "Night late (a strict-mode lunch-return flag) is not shown: attendance runs in Simple mode and no day carries it."
        )
    if not show_early:
        notes.append("Early-Out detection is switched off in Attendance settings, so that column is hidden.")
    no_shift = [em for em in kept if em.shift_name == "No shift assigned"]
    if no_shift:
        notes.append(
            f"{len(no_shift)} staff employee(s) have no shift assignment; Late Detection cannot flag them "
            "(see the Shift Assignment Gaps report)."
        )
    if sub_note:
        notes.append(sub_note)
    notes.extend(coverage_notes(ctx, people_by_id, *month_bounds(year, month)))
    columns = [c for c in _COUNT_COLS if (show_early or c.key != "earlyOut") and (show_night or c.key != "nightLate")]
    if priced:
        at = next(i for i, c in enumerate(columns) if c.key == "excessPermissions")
        columns[at + 1 : at + 1] = [
            ColumnSpec("permissionPriced", "Priced separately", INTEGER, 1.0, total="sum"),
            ColumnSpec("permissionBillable", "Permission billable", INTEGER, 1.0, total="sum"),
        ]
    return ReportResult(rows=rows, summary=summary, notes=notes, columns=columns)


register(
    ReportSpec(
        id="late-summary-counts",
        title="Late Coming Summary (Counts)",
        description="Per employee for a month: late days, late-in / early-out / excess-permission pool, free vs billable, minutes.",
        category="attendance",
        family="late-coming",
        variant="Counts",
        icon="Clock",
        tags=("late", "late count", "late detection", "counts", "pool", "permission"),
        modules=MODULES,
        filters=(
            period("thisMonth"),
            *scope_filters(employment_default="staff"),
            select("minPool", "Pool total", MIN_POOL, placeholder="Any"),
            boolean("onlyBillable", "Only employees over the free allowance"),
        ),
        columns=_COUNT_COLS,
        run=_counts_run,
    )
)


_PENALTY_COLS = (
    *EMP_COLS_SHORT,
    ColumnSpec("workingDays", "Working days", INTEGER, 0.9),
    ColumnSpec("lateInEarlyOut", "Late-In + Early-Out", INTEGER, 1.1, total="sum"),
    ColumnSpec("excessPermissions", "Excess permissions", INTEGER, 1.1, total="sum"),
    ColumnSpec("poolTotal", "Pool total", INTEGER, 0.8, total="sum"),
    ColumnSpec("freeUsed", "Free used", INTEGER, 0.8, total="sum"),
    ColumnSpec("billable", "Billable", INTEGER, 0.8, total="sum"),
    ColumnSpec("shiftDeductions", "Shift deductions", NUMBER, 1.0, total="sum"),
    ColumnSpec("salaryDeduction", "Salary deduction", CURRENCY, 1.2, total="sum"),
)


def _penalty_run(ctx):
    year, month = ctx.period
    pools, settings, roster, people_by_id = _month_pools(ctx, year, month)
    only_affected = bool(ctx.params.get("onlyAffected"))
    priced = bool(settings.permission_pricing_enabled)  # Permission Deduction Slabs: excess permissions priced apart

    rows = []
    for em in pools:
        if em.emp.employment_type != "staff" or em.pool is None:
            continue  # the pool and its deduction are a staff concept
        pool = em.pool
        if only_affected and not (pool["total"] or pool["permission_pool"]):
            continue
        salary = em.emp.salary_amount
        working = len(em.working)
        daily_rate = _d2(Decimal(salary) / Decimal(str(working))) if salary and working else None
        # payroll's own pricing: the late pool through the late slabs and (switch ON) the excess permissions through the
        # permission slabs; an employee with no salary has shifts but no rupee figure (payroll skips them)
        pricing = late_pool_pricing(pool, settings, daily_rate)
        shifts = pricing["late_shifts"]
        deduction = pricing["penalty"] if daily_rate is not None else None
        rows.append(
            {
                **emp_cells(em.emp),
                "workingDays": working,
                "lateInEarlyOut": pool["late_in"] + pool["early_out"],
                "excessPermissions": pool["excess_permissions"],
                "poolTotal": pool["total"],
                "freeUsed": pool["free_used"],
                "billable": pool["billable"],
                "shiftDeductions": float(shifts),
                **(
                    {
                        "permissionPriced": pool["permission_pool"],
                        "permissionBillable": pool["permission_billable"],
                        "permissionShifts": float(pricing["permission_shifts"]),
                    }
                    if priced
                    else {}
                ),
                "salaryDeduction": r2(deduction),
            }
        )
    sum_keys = [
        "lateInEarlyOut",
        "excessPermissions",
        "poolTotal",
        "freeUsed",
        "billable",
        "shiftDeductions",
        "salaryDeduction",
    ]
    if priced:
        sum_keys += ["permissionPriced", "permissionBillable", "permissionShifts"]
    rows, sub_note = subtotals_within_limit(ctx, rows, lambda r: r["department"], sum_keys)

    data = [r for r in rows if r.get("_kind") is None]
    summary = [
        {
            "label": "Employees with a deduction",
            "value": sum(1 for r in data if (r["shiftDeductions"] or 0) + (r.get("permissionShifts") or 0) > 0),
            "format": "integer",
        },
        {"label": "Pool occurrences", "value": sum(r["poolTotal"] for r in data), "format": "integer"},
        {"label": "Billable occurrences", "value": sum(r["billable"] for r in data), "format": "integer"},
        {
            "label": "Shifts deducted",
            "value": round(sum(r["shiftDeductions"] + (r.get("permissionShifts") or 0) for r in data), 2),
            "format": "number",
        },
        {
            "label": "Salary deduction",
            "value": round(sum(r["salaryDeduction"] or 0 for r in data), 2),
            "format": "currency",
        },
    ]
    notes = [
        "Live pre-payroll view: recomputed now from the stored day records with the same pool formula, working days, "
        "slab table and HALF-UP rounding payroll uses (staff only). The saved snapshot the older Report Log screen reads "
        "is only refreshed by strict-mode payroll runs, so it can lag behind these figures; the finalised, as-paid figures "
        "are in the Late Salary Impact report.",
        f"Free allowance: {max(0, int(settings.late_free_allowance or 0))} per month. Permission cap: "
        f"{max(0, int(settings.permission_monthly_cap or 0))} approved permissions per month "
        + ("(the rest are priced on their own, see below). " if priced else "(the rest join the pool). ")
        + f"Deduction slabs: {_slab_text(settings)}.",
        (
            "Late-In + Early-Out includes the days whose excess permission is on the same edge (one occurrence, counted "
            "here); Pool total is Late-In + Early-Out only. Free used = the free allowance consumed; Billable = pool "
            "total minus the free allowance."
            if priced
            else "Late-In + Early-Out excludes days merged into an excess permission; Pool total adds the excess "
            "permissions. Free used = the free allowance consumed; Billable = pool total minus the free allowance."
        ),
        "Salary deduction = shifts deducted x daily rate, where daily rate = monthly salary / payroll working days. "
        "Employees with no salary amount show a dash (payroll does not pay them).",
    ]
    if priced:
        notes.append(
            "Permission Deduction Slabs are ON: the excess permissions (approved beyond the cap, not already counted "
            "as a late day on the same edge) are 'Priced separately'; after the permission free allowance of "
            f"{max(0, int(settings.permission_free_allowance or 0))} the rest are 'Permission billable' and priced by "
            f"the permission slabs ({_permission_slab_text(settings)}). Salary deduction is the late-pool deduction plus "
            "the permission deduction."
        )
    if not settings.evening_early_out_enabled:
        notes.append("Early-Out detection is switched off, so the pool holds Late-In days and excess permissions only.")
    if sub_note:
        notes.append(sub_note)
    notes.extend(coverage_notes(ctx, people_by_id, *month_bounds(year, month)))
    # The Report Log screen heads this column "Free (n)" with the monthly allowance in it.
    free = max(0, int(settings.late_free_allowance or 0))
    columns = [
        ColumnSpec("freeUsed", f"Free ({free})", INTEGER, 0.8, total="sum") if c.key == "freeUsed" else c
        for c in _PENALTY_COLS
    ]
    if priced:
        at = next(i for i, c in enumerate(columns) if c.key == "shiftDeductions")
        columns[at + 1 : at + 1] = [
            ColumnSpec("permissionPriced", "Priced separately", INTEGER, 1.0, total="sum"),
            ColumnSpec("permissionBillable", "Permission billable", INTEGER, 1.0, total="sum"),
            ColumnSpec("permissionShifts", "Permission shifts", NUMBER, 1.0, total="sum"),
        ]
    return ReportResult(rows=rows, summary=summary, notes=notes, columns=columns)


register(
    ReportSpec(
        id="late-penalty-breakdown",
        title="Late-Penalty Breakdown",
        description="Live late pool per staff member: late-in + early-out, excess permissions, free, billable, shifts and salary deducted.",
        category="attendance",
        family="late-coming",
        variant="Penalty",
        icon="Scale",
        tags=("late", "penalty", "deduction", "pool", "report log", "late summary", "salary"),
        modules=("attendance", "payroll"),
        filters=(
            period("thisMonth"),
            *scope_filters(designation=True, employment_default="staff"),
            boolean("onlyAffected", "Only employees with a pool count"),
        ),
        columns=_PENALTY_COLS,
        run=_penalty_run,
    )
)


# ═════════════════════════════════════════════════════════════════════════════
#  early-out
# ═════════════════════════════════════════════════════════════════════════════

_EARLY_COLS = (
    *EMP_COLS_SHORT,
    ColumnSpec("date", "Date", DATE, 1.4),
    ColumnSpec("day", "Day", TEXT, 0.6),
    ColumnSpec("shift", "Shift", TEXT, 1.4),
    ColumnSpec("shiftEnd", "Eff. end", TIME, 0.9),
    ColumnSpec("deadline", "Deadline", TIME, 1.15),
    ColumnSpec("lastPunch", "Last punch", TIME, 0.9),
    ColumnSpec("earlyMinutes", "Left early by (min)", MINUTES, 1.0, total="sum"),
    ColumnSpec("permission", "Permission", BADGE, 1.3),
    ColumnSpec("poolStatus", "Late pool", BADGE, 1.7),
    ColumnSpec("status", "Day status", BADGE, 0.9),
    ColumnSpec("reason", "Engine reason", TEXT, 3.4),
)


def _early_out_run(ctx):
    d_from, d_to = ctx.date_from, ctx.date_to
    settings = payroll_settings()
    pcfg = production_config()
    roster = Roster(ctx, d_from, d_to)
    people_by_id = people(ctx)

    qs = day_records(ctx, d_from, d_to, early_leave=True)
    effect = ctx.params.get("permissionEffect")
    if effect == "applied":
        qs = qs.filter(evening_permission_applied=True)
    elif effect == "excess":
        qs = qs.filter(evening_permission_excess=True)
    elif effect == "none":
        qs = qs.filter(evening_permission_applied=False, evening_permission_excess=False)
    records = [r for r in qs.order_by("date", "id")[: ctx.row_limit] if r.employee_id in people_by_id]

    built = []
    windowed = 0
    for rec in records:
        emp = people_by_id[rec.employee_id]
        shift_name, end, grace = _evening_basis(emp, rec, roster, pcfg)
        window = _window_early(emp, rec)
        # an announced early-out replaced the shift's end and grace by a time the day record does not keep: not measured
        judged = _prod_judged(pcfg, rec) if emp.employment_type == "production" else None
        if judged is not None:
            # the shift table judged the day: measured against its group's main out, which for a night group is the
            # NEXT morning (a clock comparison alone would read a 23:00 exit as after a 05:30 end)
            early = _prod_early(judged)
        else:
            early = None if window else evening_earliness(rec.last_punch, end, grace, rec.evening_permission_applied)
        windowed += window
        built.append(
            (
                emp_sort_key(emp),
                rec.date,
                {
                    **emp_cells(emp),
                    "date": rec.date.isoformat(),
                    "day": day_abbr(rec.date),
                    "shift": shift_name or "No shift assigned",
                    "shiftEnd": secs_hm(early[0]) if early else (None if window else (hm(end) if end else None)),
                    "deadline": secs_hm(early[1]) if early else None,
                    "lastPunch": hm(rec.last_punch),
                    "earlyMinutes": early[2] if early else None,
                    "permission": _permission_badge(rec.evening_permission_applied, rec.evening_permission_excess),
                    "poolStatus": _pool_status_early(rec, emp, roster, bool(settings.permission_pricing_enabled)),
                    "status": STATUS_LABELS.get(rec.status, rec.status),
                    "reason": rec.late_reason,
                },
            )
        )
    built.sort(key=lambda t: (t[0], t[1]))
    rows = [t[2] for t in built]

    minutes = [r["earlyMinutes"] for r in rows if r["earlyMinutes"] is not None]
    summary = [
        {"label": "Early-out occurrences", "value": len(rows), "format": "integer"},
        {"label": "Employees affected", "value": len({r["employeeCode"] for r in rows}), "format": "integer"},
        {"label": "Average early (min)", "value": _avg(minutes), "format": "number"},
        {"label": "Longest early (min)", "value": max(minutes) if minutes else None, "format": "integer"},
    ]
    rows, sub_note = subtotals_within_limit(ctx, rows, lambda r: r["department"], ["earlyMinutes"])

    notes = [
        "Each row is a day flagged Evening Early-Out: the last punch (needs at least two punches) is before the shift end "
        "minus grace. Minutes are re-derived from the stored last punch and the shift in force that day; an approved "
        "in-cap Evening Early-Out permission moves the end 60 minutes earlier.",
        "A cross-midnight exit is never an early-out, and a compensation-day release or an afternoon half-day leave clears the flag. "
        "A production day the shift-table rules judged (from their start date) is measured against its group's standard out "
        "(a night group's is the next morning) less the rules' grace; an earlier production day against the legacy departure time.",
    ]
    if windowed:
        notes.append(
            f"{windowed} row(s) are days with a company-announced early-out time: the engine judged them against that "
            "announced time with no grace, which the day record does not keep, so their end, deadline and minutes are left "
            "blank (the flag is kept, the minutes are not guessed)."
        )
    if not settings.evening_early_out_enabled:
        notes.append(
            "Early-Out detection is switched off in Attendance settings (it is off by default), so no new days are flagged; "
            "any rows shown were flagged while it was on."
        )
    if sub_note:
        notes.append(sub_note)
    notes.extend(coverage_notes(ctx, people_by_id, d_from, d_to))
    return ReportResult(rows=rows, summary=summary, notes=notes)


def _pool_status_early(rec, emp, roster: Roster, priced: bool = False) -> str:
    return _pool_status(rec, emp, roster, rec.evening_permission_excess, priced)


register(
    ReportSpec(
        id="early-out",
        title="Early Departure (Early-Out)",
        description="Days an employee left before shift end minus grace, with minutes early and permission effect.",
        category="attendance",
        icon="LogOut",
        tags=("early out", "early leave", "early departure", "left early"),
        modules=MODULES,
        filters=(
            date_range("thisMonth", max_days=_RANGE_DAYS),
            *scope_filters(employment_default="staff"),
            select("permissionEffect", "Permission effect", PERMISSION_EFFECT),
        ),
        columns=_EARLY_COLS,
        run=_early_out_run,
    )
)


# ═════════════════════════════════════════════════════════════════════════════
#  half-day
# ═════════════════════════════════════════════════════════════════════════════

HALF_WORKED = (("morning", "Morning half"), ("evening", "Evening half"), ("unknown", "Not known"))
HALF_CAUSE = (
    ("single_punch", "Single punch"),
    ("left_early", "Left early"),
    ("arrived_late", "Arrived late"),
    ("half_day_leave", "Half-day leave"),
    ("hr_override", "HR override"),
    ("relaxation", "Compensation relaxation"),
    ("production_short_day", "Short production day"),
    ("other", "Other"),
)
CAUSE_LABEL = dict(HALF_CAUSE)
_VIEW = (("detail", "Detail (one row per half day)"), ("summary", "Summary (counts per employee)"))

_HALF_DETAIL_COLS = (
    *EMP_COLS_SHORT,
    ColumnSpec("date", "Date", DATE, 1.4),
    ColumnSpec("day", "Day", TEXT, 0.6),
    ColumnSpec("halfWorked", "Half worked", BADGE, 1.0),
    ColumnSpec("cause", "Cause", BADGE, 1.4),
    ColumnSpec("firstPunch", "First punch", TIME, 0.9),
    ColumnSpec("lastPunch", "Last punch", TIME, 0.9),
    ColumnSpec("punchCount", "Punches", INTEGER, 0.9),
    ColumnSpec("leaveSlot", "Leave slot", BADGE, 0.9),
    ColumnSpec("shiftsEarned", "Shift credit", NUMBER, 0.8, total="sum"),
    ColumnSpec("shiftsLost", "Shifts lost", NUMBER, 0.8, total="sum"),
    ColumnSpec("late", "Late", BADGE, 0.7),
    ColumnSpec("source", "Source", TEXT, 1.1),
    ColumnSpec("note", "Note", TEXT, 2.6),
)

_HALF_SUMMARY_COLS = (
    *EMP_COLS_SHORT,
    ColumnSpec("halfDays", "Half days", INTEGER, 0.8, total="sum"),
    ColumnSpec("morning", "Morning half", INTEGER, 0.9, total="sum"),
    ColumnSpec("evening", "Evening half", INTEGER, 0.9, total="sum"),
    ColumnSpec("unknown", "Not known", INTEGER, 0.8, total="sum"),
    ColumnSpec("singlePunch", "Single punch", INTEGER, 0.9, total="sum"),
    ColumnSpec("leftEarly", "Left early", INTEGER, 0.8, total="sum"),
    ColumnSpec("arrivedLate", "Arrived late", INTEGER, 0.9, total="sum"),
    ColumnSpec("halfDayLeave", "Half-day leave", INTEGER, 0.9, total="sum"),
    ColumnSpec("hrOverride", "HR override", INTEGER, 0.8, total="sum"),
    ColumnSpec("relaxation", "Relaxation", INTEGER, 0.9, total="sum"),
    ColumnSpec("shiftsLost", "Shifts lost", NUMBER, 0.8, total="sum"),
)


def _half_cause(rec, emp, worked: str | None) -> str:
    if emp.employment_type == "production":
        return "production_short_day"
    if rec.source == "manual":
        return "hr_override"
    if is_relaxation_day(rec):
        return "relaxation"  # made up by an OT relaxation / redeemed balance: no punches at all, not a missing one
    if rec.is_half_day_leave:
        return "half_day_leave"
    if rec.last_punch is None:
        return "single_punch"
    if worked == "morning":
        return "left_early"
    if worked == "evening":
        return "arrived_late"
    return "other"


def _half_run(ctx):
    d_from, d_to = ctx.date_from, ctx.date_to
    settings = payroll_settings()
    people_by_id = people(ctx)

    qs = day_records(ctx, d_from, d_to, status="half_shift").order_by("date", "id")
    slots = {}
    for eid, start, slot in LeaveRequest.objects.filter(
        ctx.emp_q("employee__"),
        status="approved",
        is_half_day=True,
        start_date__gte=d_from.isoformat(),
        start_date__lt=(d_to + timedelta(days=1)).isoformat(),
    ).values_list("employee_id", "start_date", "half_day_slot"):
        d = parse_date(start)
        if d:
            slots[(eid, d)] = slot

    want_worked = ctx.params.get("halfWorked")
    want_cause = ctx.params.get("cause")
    view = ctx.params.get("view") or "detail"

    built = []
    for rec in qs:
        emp = people_by_id.get(rec.employee_id)
        if emp is None:
            continue
        is_prod = emp.employment_type == "production"
        if is_prod or rec.first_punch is None:
            worked = None
        else:
            worked = half_period(rec, settings) or "evening"
        cause = _half_cause(rec, emp, worked)
        if want_worked and (worked or "unknown") != want_worked:
            continue
        if want_cause and cause != want_cause:
            continue
        slot = slots.get((emp.id, rec.date))
        note_parts = []
        if rec.override_note:
            note_parts.append(rec.override_note)
        if rec.is_compensation_day:
            note_parts.append("Compensation day (evening cut-off replaced by the release time)")
        if rec.compensation_note:
            note_parts.append(rec.compensation_note)
        shifts = float(rec.shifts_earned or 0)
        built.append(
            (
                emp_sort_key(emp),
                rec.date,
                emp,
                {
                    **emp_cells(emp),
                    "date": rec.date.isoformat(),
                    "day": day_abbr(rec.date),
                    "halfWorked": worked.title() if worked else None,
                    "cause": CAUSE_LABEL[cause],
                    "firstPunch": hm(rec.first_punch),
                    "lastPunch": hm(rec.last_punch),
                    "punchCount": rec.total_punches,
                    "leaveSlot": {"morning": "Morning", "afternoon": "Afternoon"}.get(slot)
                    if (rec.is_half_day_leave and slot)
                    else None,
                    "shiftsEarned": shifts,
                    "shiftsLost": None if is_prod else round(1 - shifts, 2),
                    "late": "Late" if rec.is_late else None,
                    "source": "HR override" if rec.source == "manual" else rec.primary_source,
                    "note": "; ".join(note_parts) or None,
                    "_cause": cause,
                    "_worked": worked,
                },
            )
        )
    built.sort(key=lambda t: (t[0], t[1]))

    staff_lost = round(sum(t[3]["shiftsLost"] or 0 for t in built), 2)
    summary = [
        {"label": "Half days", "value": len(built), "format": "integer"},
        {"label": "Employees affected", "value": len({t[2].id for t in built}), "format": "integer"},
        {"label": "Shift equivalents lost", "value": staff_lost, "format": "number"},
        {
            "label": "Morning half worked",
            "value": sum(1 for t in built if t[3]["_worked"] == "morning"),
            "format": "integer",
        },
        {
            "label": "Evening half worked",
            "value": sum(1 for t in built if t[3]["_worked"] == "evening"),
            "format": "integer",
        },
        {
            "label": "Single-punch days",
            "value": sum(1 for t in built if t[3]["_cause"] == "single_punch"),
            "format": "integer",
        },
    ]

    if view == "summary":
        per: dict[int, Counter] = defaultdict(Counter)
        lost: dict[int, float] = defaultdict(float)
        emps: dict[int, object] = {}
        for _k, _d, emp, row in built:
            emps[emp.id] = emp
            c = per[emp.id]
            c["halfDays"] += 1
            c[row["_worked"] or "unknown"] += 1
            c[row["_cause"]] += 1
            lost[emp.id] += row["shiftsLost"] or 0
        rows = []
        for eid in sorted(emps, key=lambda i: emp_sort_key(emps[i])):
            c = per[eid]
            rows.append(
                {
                    **emp_cells(emps[eid]),
                    "halfDays": c["halfDays"],
                    "morning": c["morning"],
                    "evening": c["evening"],
                    "unknown": c["unknown"],
                    "singlePunch": c["single_punch"],
                    "leftEarly": c["left_early"],
                    "arrivedLate": c["arrived_late"],
                    "halfDayLeave": c["half_day_leave"],
                    "hrOverride": c["hr_override"],
                    "relaxation": c["relaxation"],
                    "shiftsLost": round(lost[eid], 2),
                }
            )
        rows, sub_note = subtotals_within_limit(
            ctx,
            rows,
            lambda r: r["department"],
            [
                "halfDays",
                "morning",
                "evening",
                "unknown",
                "singlePunch",
                "leftEarly",
                "arrivedLate",
                "halfDayLeave",
                "hrOverride",
                "relaxation",
                "shiftsLost",
            ],
        )
        columns = list(_HALF_SUMMARY_COLS)
    else:
        rows = [t[3] for t in built[: ctx.row_limit]]
        # subtotals of a cut-off list would be wrong, and must not push a complete one over the limit
        rows, sub_note = subtotals_within_limit(ctx, rows, lambda r: r["department"], ["shiftsEarned", "shiftsLost"])
        columns = list(_HALF_DETAIL_COLS)

    notes = [
        "Half-day rule (identical for Simple and Strict mode): a first punch within the shift's first-half limit (its start "
        f"+ grace + {settings.arrival_late_window_minutes} min Late window + {settings.arrival_permission_window_minutes} min "
        f"permission window + {settings.arrival_extra_minutes} min extra) counts as the morning half; a punch at or after the "
        f"second-half start ({settings.half_day_second_half_start_time:%H:%M}) counts as the evening half; both = full day, "
        "one = half day, neither = absent. The first-half limit follows each shift; the second-half start is a company-wide setting.",
        "Half worked comes from the day record's arrival zone (older or manual records: from the first punch). Cause is derived "
        "from the stored day: HR override (manual record), compensation relaxation (an OT relaxation or redeemed balance paid "
        "the day without any punch), half-day "
        "leave, single punch (a lone punch is a half day by rule and is usually a missing punch), left early (morning only) or "
        "arrived late (evening only).",
        "For production employees a half day is a day whose shift credit is under the full-day value: at most half of the "
        "day's maximum before the shift-table rules start, below the rules' full-day value (1.00 by default) from then on; "
        "the morning / evening split and shifts lost do not apply to them.",
    ]
    if sub_note:
        notes.append(sub_note)
    notes.extend(coverage_notes(ctx, people_by_id, d_from, d_to))
    return ReportResult(rows=rows, summary=summary, notes=notes, columns=columns)


register(
    ReportSpec(
        id="half-day",
        title="Half-Day Report",
        description="Every half-day with the half worked, punches and the derived cause; switch to counts per employee.",
        category="attendance",
        icon="Hourglass",
        tags=("half day", "half shift", "0.5", "single punch", "half-day leave"),
        modules=MODULES,
        filters=(
            date_range("thisMonth", max_days=_RANGE_DAYS),
            *scope_filters(employment_default="staff"),
            select("halfWorked", "Half worked", HALF_WORKED),
            select("cause", "Cause", HALF_CAUSE),
            select("view", "View", _VIEW, default="detail", placeholder="Detail"),
        ),
        columns=_HALF_DETAIL_COLS,
        run=_half_run,
    )
)

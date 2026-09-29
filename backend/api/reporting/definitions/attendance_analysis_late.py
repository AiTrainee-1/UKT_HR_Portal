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

from api.attendance_final import late_pool_summary
from api.models import EmployeePermission, LeaveRequest
from api.payroll_views import _d2, late_shift_deduction

from ..common import EMP_COLS_SHORT, emp_cells, with_subtotals
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
)

MODULES = ("attendance",)

PERMISSION_EFFECT = (("applied", "Permission applied"), ("excess", "Permission excess (over cap)"), ("none", "No permission"))
POOL_FILTER = (("counted", "Counted in the late pool"), ("not_counted", "Not counted"))
MIN_LATE = (("5", "5+ minutes"), ("10", "10+ minutes"), ("15", "15+ minutes"), ("30", "30+ minutes"), ("60", "60+ minutes"))

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


def _permission_badge(applied: bool, excess: bool) -> str | None:
    if excess:
        return "Excess"
    if applied:
        return "Applied"
    return None


def _pool_status(rec, emp, roster: Roster, excess_flag: bool) -> str:
    """Is this flagged day one occurrence of the payroll late pool?"""
    if emp.employment_type == "production":
        return "Production (separate)"
    if rec.status not in ("present", "half_shift"):
        return "Not counted (day status)"
    if rec.date not in roster.working_days(emp.id, rec.date.year, rec.date.month):
        return "Non-working day"
    if excess_flag:
        return "Merged with excess permission"
    return "Counted"


def _morning_basis(emp, rec, roster: Roster, pcfg):
    """(shift name, start time, grace) the day was judged against."""
    if emp.employment_type == "production":
        return "Production (fixed times)", pcfg.punch1_time, pcfg.grace_minutes
    shift = roster.shift_on(emp.id, rec.date)
    if shift is None:
        return None, None, 0
    return shift.name, shift.start_time, shift.grace_period_minutes


def _evening_basis(emp, rec, roster: Roster, pcfg):
    if emp.employment_type == "production":
        return "Production (fixed times)", pcfg.punch4_time, pcfg.grace_minutes
    shift = roster.shift_on(emp.id, rec.date)
    if shift is None:
        return None, None, 0
    return shift.name, shift.end_time, shift.grace_period_minutes


# ═════════════════════════════════════════════════════════════════════════════
#  late-coming-detail
# ═════════════════════════════════════════════════════════════════════════════

_DETAIL_COLS = (
    *EMP_COLS_SHORT,
    ColumnSpec("date", "Date", DATE, 1.1),
    ColumnSpec("day", "Day", TEXT, 0.6),
    ColumnSpec("shift", "Shift", TEXT, 1.4),
    ColumnSpec("shiftStart", "Effective start", TIME, 0.9),
    ColumnSpec("graceMinutes", "Grace (min)", MINUTES, 0.8),
    ColumnSpec("deadline", "Deadline", TIME, 0.8),
    ColumnSpec("firstPunch", "First punch", TIME, 0.9),
    ColumnSpec("lateMinutes", "Late by (min)", MINUTES, 0.9, total="sum"),
    ColumnSpec("beyondGrace", "Past deadline (min)", MINUTES, 1.0, total="sum"),
    ColumnSpec("permission", "Permission", BADGE, 0.9),
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
    for rec in records:
        emp = people_by_id[rec.employee_id]
        shift_name, start, grace = _morning_basis(emp, rec, roster, pcfg)
        if shift_text and shift_text not in (shift_name or "").lower():
            continue
        late = morning_lateness(rec.first_punch, start, grace, rec.morning_permission_applied)
        late_min = late[2] if late else None
        if min_late and (late_min is None or late_min < min_late):
            continue
        pool = _pool_status(rec, emp, roster, rec.morning_permission_excess)
        if pool_filter == "counted" and pool != "Counted":
            continue
        if pool_filter == "not_counted" and pool == "Counted":
            continue
        row = {
            **emp_cells(emp),
            "date": rec.date.isoformat(),
            "day": day_abbr(rec.date),
            "shift": shift_name or "No shift assigned",
            "shiftStart": secs_hm(late[0]) if late else (hm(start) if start else None),
            "graceMinutes": grace if start is not None else None,
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
    truncated = not python_filtered and len(records) >= ctx.row_limit

    minutes = [r["lateMinutes"] for r in rows if r["lateMinutes"] is not None]
    summary = [
        {"label": "Late occurrences", "value": len(rows), "format": "integer"},
        {"label": "Employees affected", "value": len({r["employeeCode"] for r in rows}), "format": "integer"},
        {"label": "Average late (min)", "value": _avg(minutes), "format": "number"},
        {"label": "Longest late (min)", "value": max(minutes) if minutes else None, "format": "integer"},
        {"label": "Counted in late pool", "value": sum(1 for r in rows if r["poolStatus"] == "Counted"), "format": "integer"},
    ]
    if not truncated:
        rows = with_subtotals(rows, lambda r: r["department"], ["lateMinutes", "beyondGrace"])

    notes = [
        "Each row is one day flagged Late-In by Attendance. The day record stores only the flag, so the minutes are "
        "re-derived from the stored first punch and the shift in force that day (arrivals compared to the minute; "
        "an approved in-cap Morning Late-In permission moves the start by 60 minutes; grace is added on top).",
        "Late by = first punch minus effective start. Past deadline = first punch minus (effective start + grace).",
        "Night Late (strict-mode lunch return) is informational, never priced, and is not listed here.",
    ]
    if not settings.morning_late_in_enabled:
        notes.append(
            "Morning Late-In detection is currently switched off in Attendance settings; rows shown were flagged while it was on."
        )
    blank = sum(1 for r in rows if r.get("_kind") is None and r.get("lateMinutes") is None)
    if blank:
        notes.append(
            f"{blank} row(s) show no minutes: the shift could not be found for that day or was edited after the day was "
            "computed (the flag is kept, the minutes are not guessed)."
        )
    notes.append("Employees with no shift assignment are never flagged late, so they cannot appear here.")
    if truncated:
        notes.append("Department subtotals are omitted because the list was cut off; narrow the filters.")
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
        "emp", "records", "working", "approved", "pool", "flagged", "early_flagged", "minutes", "night", "halves",
        "shift_name",
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
        em.early_flagged = sum(1 for r in recs if r.early_leave)
        em.night = sum(1 for r in recs if r.late_afternoon)
        em.halves = sum(1 for r in recs if r.status == "half_shift")
        minutes = []
        for r in recs:
            if not r.is_late:
                continue
            _name, start, grace = _morning_basis(emp, r, roster, pcfg)
            late = morning_lateness(r.first_punch, start, grace, r.morning_permission_applied)
            if late:
                minutes.append(late[2])
        em.minutes = minutes
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
    show_early = bool(settings.evening_early_out_enabled) or any(
        em.pool and em.pool["early_out"] for em in pools
    )

    rows = []
    kept = []
    for em in pools:
        pool = em.pool
        pool_total = pool["total"] if pool else None
        if min_pool and (pool_total or 0) < min_pool:
            continue
        if only_billable and not (pool and pool["billable"] > 0):
            continue
        kept.append(em)
        rows.append({
            **emp_cells(em.emp),
            "shift": em.shift_name,
            "workingDays": len(em.working) if em.working is not None else None,
            "lateDays": em.flagged,
            "lateIn": pool["late_in"] if pool else None,
            "earlyOut": pool["early_out"] if pool else None,
            "excessPermissions": pool["excess_permissions"] if pool else None,
            "poolTotal": pool_total,
            "freeUsed": pool["free_used"] if pool else None,
            "billable": pool["billable"] if pool else None,
            "minutesTotal": sum(em.minutes) if em.minutes else 0,
            "minutesAvg": round(sum(em.minutes) / len(em.minutes)) if em.minutes else None,
            "minutesMax": max(em.minutes) if em.minutes else None,
            "approvedPermissions": em.approved if pool else None,
            "nightLate": em.night,
            "halfDays": em.halves,
        })
    sum_keys = ["lateDays", "lateIn", "earlyOut", "excessPermissions", "poolTotal", "freeUsed", "billable",
                "minutesTotal", "approvedPermissions", "nightLate", "halfDays"]
    rows = with_subtotals(rows, lambda r: r["department"], sum_keys)

    staff = [em for em in kept if em.pool]
    summary = [
        {"label": "Employees with lates", "value": sum(1 for em in kept if em.flagged or (em.pool and em.pool["total"])), "format": "integer"},
        {"label": "Over the free allowance", "value": sum(1 for em in staff if em.pool["billable"] > 0), "format": "integer"},
        {"label": "Pool occurrences", "value": sum(em.pool["total"] for em in staff), "format": "integer"},
        {"label": "Late minutes", "value": sum(sum(em.minutes) for em in kept), "format": "minutes"},
        {"label": "Free allowance / month", "value": max(0, int(settings.late_free_allowance or 0)), "format": "integer"},
        {"label": "Permission cap / month", "value": max(0, int(settings.permission_monthly_cap or 0)), "format": "integer"},
    ]
    notes = [
        f"Late pool for {month_bounds(year, month)[0]:%B %Y}, computed live from the stored day records with the same "
        "formula payroll uses: Late-In days + Early-Out days + approved permissions beyond the monthly cap; only "
        "present / half-day days on payroll working days count; a late day that carries an excess permission on the "
        "same edge is one occurrence, not two.",
        "Late days flagged is the raw number of flagged days (Sundays and other non-working days included), so it can "
        "exceed Late-In (pool). Production employees are not part of the staff pool (their rules are separate); pool "
        "columns show a dash for them.",
        "Late minutes are re-derived from first punch and shift (see Late Coming Detail); Night late (strict-mode lunch "
        "return) is informational only.",
    ]
    if not show_early:
        notes.append("Early-Out detection is switched off in Attendance settings, so that column is hidden.")
    no_shift = [em for em in kept if em.shift_name == "No shift assigned"]
    if no_shift:
        notes.append(
            f"{len(no_shift)} staff employee(s) have no shift assignment; Late Detection cannot flag them "
            "(see the Shift Assignment Gaps report)."
        )
    notes.extend(coverage_notes(ctx, people_by_id, *month_bounds(year, month)))
    columns = [c for c in _COUNT_COLS if show_early or c.key != "earlyOut"]
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

    rows = []
    for em in pools:
        if em.emp.employment_type != "staff" or em.pool is None:
            continue  # the pool and its deduction are a staff concept
        pool = em.pool
        if only_affected and not pool["total"]:
            continue
        shifts = late_shift_deduction(pool["billable"], settings)
        salary = em.emp.salary_amount
        working = len(em.working)
        if salary and working:
            daily_rate = _d2(Decimal(salary) / Decimal(str(working)))
            deduction = _d2(shifts * daily_rate) if shifts > 0 else Decimal("0")
        else:
            deduction = None  # payroll skips an employee with no salary: no daily rate, no deduction
        rows.append({
            **emp_cells(em.emp),
            "workingDays": working,
            "lateInEarlyOut": pool["late_in"] + pool["early_out"],
            "excessPermissions": pool["excess_permissions"],
            "poolTotal": pool["total"],
            "freeUsed": pool["free_used"],
            "billable": pool["billable"],
            "shiftDeductions": float(shifts),
            "salaryDeduction": r2(deduction),
        })
    sum_keys = ["lateInEarlyOut", "excessPermissions", "poolTotal", "freeUsed", "billable", "shiftDeductions", "salaryDeduction"]
    rows = with_subtotals(rows, lambda r: r["department"], sum_keys)

    data = [r for r in rows if r.get("_kind") is None]
    summary = [
        {"label": "Employees with a deduction", "value": sum(1 for r in data if (r["shiftDeductions"] or 0) > 0), "format": "integer"},
        {"label": "Pool occurrences", "value": sum(r["poolTotal"] for r in data), "format": "integer"},
        {"label": "Billable occurrences", "value": sum(r["billable"] for r in data), "format": "integer"},
        {"label": "Shifts deducted", "value": round(sum(r["shiftDeductions"] for r in data), 2), "format": "number"},
        {"label": "Salary deduction", "value": round(sum(r["salaryDeduction"] or 0 for r in data), 2), "format": "currency"},
    ]
    notes = [
        "Live pre-payroll view: recomputed now from the stored day records with the same pool formula, working days, "
        "slab table and HALF-UP rounding payroll uses (staff only). The saved snapshot the older Report Log screen reads "
        "is only refreshed by strict-mode payroll runs, so it can lag behind these figures; the finalised, as-paid figures "
        "are in the Late Salary Impact report.",
        f"Free allowance: {max(0, int(settings.late_free_allowance or 0))} per month. Permission cap: "
        f"{max(0, int(settings.permission_monthly_cap or 0))} approved permissions per month (the rest join the pool). "
        f"Deduction slabs: {_slab_text(settings)}.",
        "Late-In + Early-Out excludes days merged into an excess permission; Pool total adds the excess permissions. "
        "Free used = the free allowance consumed; Billable = pool total minus the free allowance.",
        "Salary deduction = shifts deducted x daily rate, where daily rate = monthly salary / payroll working days. "
        "Employees with no salary amount show a dash (payroll does not pay them).",
    ]
    if not settings.evening_early_out_enabled:
        notes.append("Early-Out detection is switched off, so the pool holds Late-In days and excess permissions only.")
    notes.extend(coverage_notes(ctx, people_by_id, *month_bounds(year, month)))
    return ReportResult(rows=rows, summary=summary, notes=notes)


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
    ColumnSpec("date", "Date", DATE, 1.1),
    ColumnSpec("day", "Day", TEXT, 0.6),
    ColumnSpec("shift", "Shift", TEXT, 1.4),
    ColumnSpec("shiftEnd", "Effective end", TIME, 0.9),
    ColumnSpec("deadline", "Deadline", TIME, 0.8),
    ColumnSpec("lastPunch", "Last punch", TIME, 0.9),
    ColumnSpec("earlyMinutes", "Left early by (min)", MINUTES, 1.0, total="sum"),
    ColumnSpec("permission", "Permission", BADGE, 0.9),
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
    for rec in records:
        emp = people_by_id[rec.employee_id]
        shift_name, end, grace = _evening_basis(emp, rec, roster, pcfg)
        early = evening_earliness(rec.last_punch, end, grace, rec.evening_permission_applied)
        built.append((emp_sort_key(emp), rec.date, {
            **emp_cells(emp),
            "date": rec.date.isoformat(),
            "day": day_abbr(rec.date),
            "shift": shift_name or "No shift assigned",
            "shiftEnd": secs_hm(early[0]) if early else (hm(end) if end else None),
            "deadline": secs_hm(early[1]) if early else None,
            "lastPunch": hm(rec.last_punch),
            "earlyMinutes": early[2] if early else None,
            "permission": _permission_badge(rec.evening_permission_applied, rec.evening_permission_excess),
            "poolStatus": _pool_status_early(rec, emp, roster),
            "status": STATUS_LABELS.get(rec.status, rec.status),
            "reason": rec.late_reason,
        }))
    built.sort(key=lambda t: (t[0], t[1]))
    rows = [t[2] for t in built]
    truncated = len(records) >= ctx.row_limit

    minutes = [r["earlyMinutes"] for r in rows if r["earlyMinutes"] is not None]
    summary = [
        {"label": "Early-out occurrences", "value": len(rows), "format": "integer"},
        {"label": "Employees affected", "value": len({r["employeeCode"] for r in rows}), "format": "integer"},
        {"label": "Average early (min)", "value": _avg(minutes), "format": "number"},
        {"label": "Longest early (min)", "value": max(minutes) if minutes else None, "format": "integer"},
    ]
    if not truncated:
        rows = with_subtotals(rows, lambda r: r["department"], ["earlyMinutes"])

    notes = [
        "Each row is a day flagged Evening Early-Out: the last punch (needs at least two punches) is before the shift end "
        "minus grace. Minutes are re-derived from the stored last punch and the shift in force that day; an approved "
        "in-cap Evening Early-Out permission moves the end 60 minutes earlier.",
        "A cross-midnight exit is never an early-out, and a compensation-day release or an afternoon half-day leave clears the flag.",
    ]
    if not settings.evening_early_out_enabled:
        notes.append(
            "Early-Out detection is switched off in Attendance settings (it is off by default), so no new days are flagged; "
            "any rows shown were flagged while it was on."
        )
    if truncated:
        notes.append("Department subtotals are omitted because the list was cut off; narrow the filters.")
    notes.extend(coverage_notes(ctx, people_by_id, d_from, d_to))
    return ReportResult(rows=rows, summary=summary, notes=notes)


def _pool_status_early(rec, emp, roster: Roster) -> str:
    return _pool_status(rec, emp, roster, rec.evening_permission_excess)


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
    ("production_short_day", "Short production day"),
    ("other", "Other"),
)
CAUSE_LABEL = dict(HALF_CAUSE)
_VIEW = (("detail", "Detail (one row per half day)"), ("summary", "Summary (counts per employee)"))

_HALF_DETAIL_COLS = (
    *EMP_COLS_SHORT,
    ColumnSpec("date", "Date", DATE, 1.1),
    ColumnSpec("day", "Day", TEXT, 0.6),
    ColumnSpec("halfWorked", "Half worked", BADGE, 1.0),
    ColumnSpec("cause", "Cause", BADGE, 1.2),
    ColumnSpec("firstPunch", "First punch", TIME, 0.9),
    ColumnSpec("lastPunch", "Last punch", TIME, 0.9),
    ColumnSpec("punchCount", "Punches", INTEGER, 0.7),
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
    ColumnSpec("shiftsLost", "Shifts lost", NUMBER, 0.8, total="sum"),
)


def _half_cause(rec, emp, worked: str | None) -> str:
    if emp.employment_type == "production":
        return "production_short_day"
    if rec.source == "manual":
        return "hr_override"
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
    first_end = settings.half_day_first_half_end_time

    qs = day_records(ctx, d_from, d_to, status="half_shift").order_by("date", "id")
    slots = {}
    for eid, start, slot in LeaveRequest.objects.filter(
        ctx.emp_q("employee__"), status="approved", is_half_day=True,
        start_date__gte=d_from.isoformat(), start_date__lt=(d_to + timedelta(days=1)).isoformat(),
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
            worked = "morning" if rec.first_punch < first_end else "evening"
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
        shifts = float(rec.shifts_earned or 0)
        built.append((emp_sort_key(emp), rec.date, emp, {
            **emp_cells(emp),
            "date": rec.date.isoformat(),
            "day": day_abbr(rec.date),
            "halfWorked": worked.title() if worked else None,
            "cause": CAUSE_LABEL[cause],
            "firstPunch": hm(rec.first_punch),
            "lastPunch": hm(rec.last_punch),
            "punchCount": rec.total_punches,
            "leaveSlot": {"morning": "Morning", "afternoon": "Afternoon"}.get(slot) if (rec.is_half_day_leave and slot) else None,
            "shiftsEarned": shifts,
            "shiftsLost": None if is_prod else round(1 - shifts, 2),
            "late": "Late" if rec.is_late else None,
            "source": "HR override" if rec.source == "manual" else rec.primary_source,
            "note": "; ".join(note_parts) or None,
            "_cause": cause,
            "_worked": worked,
        }))
    built.sort(key=lambda t: (t[0], t[1]))

    staff_lost = round(sum(t[3]["shiftsLost"] or 0 for t in built), 2)
    summary = [
        {"label": "Half days", "value": len(built), "format": "integer"},
        {"label": "Employees affected", "value": len({t[2].id for t in built}), "format": "integer"},
        {"label": "Shift equivalents lost", "value": staff_lost, "format": "number"},
        {"label": "Morning half worked", "value": sum(1 for t in built if t[3]["_worked"] == "morning"), "format": "integer"},
        {"label": "Evening half worked", "value": sum(1 for t in built if t[3]["_worked"] == "evening"), "format": "integer"},
        {"label": "Single-punch days", "value": sum(1 for t in built if t[3]["_cause"] == "single_punch"), "format": "integer"},
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
            rows.append({
                **emp_cells(emps[eid]),
                "halfDays": c["halfDays"], "morning": c["morning"], "evening": c["evening"], "unknown": c["unknown"],
                "singlePunch": c["single_punch"], "leftEarly": c["left_early"], "arrivedLate": c["arrived_late"],
                "halfDayLeave": c["half_day_leave"], "hrOverride": c["hr_override"], "shiftsLost": round(lost[eid], 2),
            })
        rows = with_subtotals(
            rows, lambda r: r["department"],
            ["halfDays", "morning", "evening", "unknown", "singlePunch", "leftEarly", "arrivedLate", "halfDayLeave", "hrOverride", "shiftsLost"],
        )
        columns = list(_HALF_SUMMARY_COLS)
    else:
        rows = [t[3] for t in built[: ctx.row_limit]]
        columns = list(_HALF_DETAIL_COLS)

    notes = [
        "Half-day rule (identical for Simple and Strict mode): a punch before the first-half end "
        f"({first_end:%H:%M}) counts as the morning half; a punch at or after the second-half start "
        f"({settings.half_day_second_half_start_time:%H:%M}) counts as the evening half; both = full day, one = half day, "
        "neither = absent. The cut-offs are company-wide settings, not the shift's own times.",
        "Half worked is inferred from the first punch. Cause is derived from the stored day: HR override (manual record), half-day "
        "leave, single punch (a lone punch is a half day by rule and is usually a missing punch), left early (morning only) or "
        "arrived late (evening only).",
        "For production employees a half day means the shift credit is at most half of the day's maximum; the morning / "
        "evening split and shifts lost do not apply to them.",
    ]
    notes.extend(coverage_notes(ctx, people_by_id, d_from, d_to))
    return ReportResult(rows=rows, summary=summary, notes=notes, columns=columns)


register(
    ReportSpec(
        id="half-day",
        title="Half-Day Report",
        description="Every half-day with the half worked, punches and the derived cause; switch to counts per employee.",
        category="attendance",
        icon="Clock",
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

"""Permission reports (group G7): the register, the per-employee-month counts against the monthly cap, and the
salary effect of permissions that fall beyond the cap.

Sources of truth (read-only):

* ``EmployeePermission`` -- one row per request. Three canonical types (Morning Late-In, Evening Early-Out, Middle
  One-Hour); older rows carry the pre-rewrite spellings or no type at all, so the type is always resolved through
  ``EmployeePermission.normalize_type``.
* The monthly cap: the first ``PayrollSettings.permission_monthly_cap`` APPROVED permissions of an employee in a
  calendar month (ranked by date, id; all three types together) are within the cap, later ones are Excess and join the
  late pool. Cap status comes from ``attendance_final.bulk_permission_cap_status`` and the excess count from
  ``attendance_final.late_pool_summary`` -- the same code payroll runs -- never from a re-implementation.
* ``AttendanceDayRecord`` flags (stored) for the effect a permission had on its day; ``SalarySlip.breakdown_details``
  for what payroll actually charged.
"""

from __future__ import annotations

from collections import defaultdict
from decimal import ROUND_HALF_UP, Decimal

from django.db.models import Count

from .. import filters as F
from ..common import EMP_COLS
from ..formatting import fmt_dt, r2
from ..registry import register
from ..types import BADGE, CURRENCY, DATE, DATETIME, INTEGER, MINUTES, NUMBER, PERCENT, TEXT, TIME, ColumnSpec, ReportResult, ReportSpec
from . import requests_permission_duty_shared as S

TYPE_OPTIONS = (
    ("morning_late_in", "Morning Late-In"),
    ("evening_early_out", "Evening Early-Out"),
    ("middle_permission", "Middle One-Hour Permission"),
    ("unclassified", "Unclassified (no type recorded)"),
)
UNCLASSIFIED = "unclassified"
STATUS_OPTIONS = (("pending", "Pending"), ("approved", "Approved"), ("rejected", "Rejected"))
STATUS_LABELS = dict(STATUS_OPTIONS)
CAP_LABELS = {"within_cap": "Within cap", "excess": "Excess"}


def permission_type(p) -> str:
    """Canonical type slug of a permission row, or 'unclassified' for a blank/unknown spelling."""
    from api.models import EmployeePermission

    return EmployeePermission.normalize_type(p.type) or UNCLASSIFIED


def type_label(slug: str) -> str:
    return "Unclassified" if slug == UNCLASSIFIED else dict(TYPE_OPTIONS).get(slug, "Unclassified")


def status_label(status) -> str | None:
    if not status:
        return None
    return STATUS_LABELS.get(status, str(status).replace("_", " ").title())


def _minutes(p) -> int:
    """Stored duration, or the fixed 60 minutes for old rows that never stored one."""
    from api.models import EmployeePermission

    return p.duration_minutes if p.duration_minutes is not None else EmployeePermission.FIXED_DURATION_MINUTES


def _money(value) -> Decimal:
    return Decimal(str(value)).quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)


# ── 1. Permission register ──────────────────────────────────────────────────


def _day_effect(p, slug: str, emp, rec) -> str | None:
    """What an approved permission did to its day, from the stored attendance record's flags."""
    from api.models import EmployeePermission

    if p.status == "pending":
        return "Pending - no effect yet"
    if p.status == "rejected":
        return "Rejected - no effect"
    if p.status != "approved":
        return None
    if emp.employment_type == "production":
        return "None (production: permissions have no effect)"
    if slug == UNCLASSIFIED:
        return "Counts toward the cap; type unknown"
    if rec is None:
        return None
    minutes = EmployeePermission.FIXED_DURATION_MINUTES
    if slug == "morning_late_in":
        if rec.morning_permission_applied:
            return f"Late-in boundary moved +{minutes} min"
        if rec.morning_permission_excess:
            return "Excess: late-in not protected"
    elif slug == "evening_early_out":
        if rec.evening_permission_applied:
            return f"Early-out boundary moved -{minutes} min"
        if rec.evening_permission_excess:
            return "Excess: early-out not protected"
    elif slug == "middle_permission" and rec.middle_permission_today:
        return "Recorded (never moves a boundary)"
    return "Not reflected on the day record"


def _register_run(ctx) -> ReportResult:
    from datetime import datetime, timedelta

    from api.attendance_final import bulk_permission_cap_status
    from api.models import AttendanceDayRecord, EmployeePermission

    settings = S.load_settings()
    cap = S.permission_cap(settings)
    base = EmployeePermission.objects.filter(ctx.emp_q("employee__"), date__gte=ctx.date_from, date__lte=ctx.date_to)
    if ctx.param("status"):
        base = base.filter(status=ctx.param("status"))
    if ctx.param("approverRole"):
        base = base.filter(approver_role=ctx.param("approverRole"))

    # Stage 1: light rows only (no joins), so the type / cap filters and the row limit are exact.
    light = list(
        base.only("id", "employee", "date", "status", "type").order_by("date", "employee__employee_code", "id")
    )
    if ctx.param("permissionType"):
        light = [p for p in light if permission_type(p) == ctx.param("permissionType")]
    caps = bulk_permission_cap_status(light, cap)
    if ctx.param("capStatus"):
        light = [p for p in light if caps[p.id] == ctx.param("capStatus")]
    light = light[: ctx.row_limit]

    # Stage 2: full rows for what will be shown.
    full = EmployeePermission.objects.select_related(
        "employee__department", "employee__designation", "employee__branch"
    ).in_bulk([p.id for p in light])

    approved = [p for p in light if p.status == "approved"]
    seq: dict[int, int] = {}
    days: dict[tuple, object] = {}
    if approved:
        emp_ids = {p.employee_id for p in approved}
        lo = min(p.date for p in approved).replace(day=1)
        hi = max(p.date for p in approved)
        order: dict[tuple, list[int]] = defaultdict(list)
        for pid, eid, d in (
            EmployeePermission.objects.filter(employee_id__in=emp_ids, status="approved", date__gte=lo, date__lte=hi)
            .order_by("date", "id")
            .values_list("id", "employee_id", "date")
        ):
            order[(eid, d.year, d.month)].append(pid)
        for pids in order.values():
            for i, pid in enumerate(pids, 1):
                seq[pid] = i
        for rec in AttendanceDayRecord.objects.filter(
            employee_id__in=emp_ids, date__in={p.date for p in approved}
        ).only(
            "employee", "date", "morning_permission_applied", "morning_permission_excess",
            "evening_permission_applied", "evening_permission_excess", "middle_permission_today",
        ):
            days[(rec.employee_id, rec.date)] = rec

    rows = []
    by_type: dict[str, int] = defaultdict(int)
    counts = {"approved": 0, "pending": 0, "rejected": 0, "within_cap": 0, "excess": 0}
    excess_emps: set[int] = set()
    approved_minutes = 0
    unclassified = untimed_duration = 0
    for stub in light:
        p = full[stub.id]
        emp = p.employee
        slug = permission_type(p)
        minutes = _minutes(p)
        if p.duration_minutes is None:
            untimed_duration += 1
        end = None
        if p.permission_time is not None:
            end = S.tstr((datetime.combine(p.date, p.permission_time) + timedelta(minutes=minutes)).time())
        cap_state = caps.get(p.id)
        rows.append({
            **S.base_cells(emp),
            "date": p.date.isoformat(),
            "typeLabel": type_label(slug),
            "permissionTime": S.tstr(p.permission_time),
            "permissionEnd": end,
            "durationMinutes": minutes,
            "reason": p.reason,
            "appliedOn": fmt_dt(p.created_at),
            "status": status_label(p.status),
            "capStatus": CAP_LABELS.get(cap_state),
            "monthSeq": seq.get(p.id),
            "decidedBy": S.who_and_role(p.approved_by, p.approver_role),
            "hrComment": p.hr_comment,
            "dayEffect": _day_effect(p, slug, emp, days.get((p.employee_id, p.date))),
        })
        by_type[slug] += 1
        if slug == UNCLASSIFIED:
            unclassified += 1
        if p.status in counts:
            counts[p.status] += 1
        if p.status == "approved":
            approved_minutes += minutes
            counts[cap_state if cap_state in counts else "within_cap"] += 1
            if cap_state == "excess":
                excess_emps.add(p.employee_id)

    notes = [
        f"Monthly cap in force: {cap} approved permission(s) per employee per calendar month, all three types counted "
        "together, earliest first. Later approved permissions are Excess: they do not protect the day and join the late pool.",
        "Only approved permissions count toward the cap. The position is recalculated on every run, so approving an "
        "earlier-dated permission later can push a previously in-cap one into Excess.",
        "Effect on the day is read from the stored attendance record (blank = no record yet). Production employees' "
        "permissions have no attendance or payroll effect.",
    ]
    if by_type:
        notes.append(
            "Requests by type: " + ", ".join(f"{type_label(k)} {by_type[k]}" for k, _l in TYPE_OPTIONS if by_type.get(k)) + "."
        )
    if unclassified:
        notes.append("Unclassified rows are older requests saved without a type; they still count toward the cap.")
    if untimed_duration:
        notes.append("Rows with no stored duration are shown as the fixed 60 minutes.")
    return ReportResult(
        rows=rows,
        summary=[
            {"label": "Total requests", "value": len(rows), "format": "integer"},
            {"label": "Approved", "value": counts["approved"], "format": "integer"},
            {"label": "Pending", "value": counts["pending"], "format": "integer"},
            {"label": "Rejected", "value": counts["rejected"], "format": "integer"},
            {"label": "Approved hours", "value": round(approved_minutes / 60, 2), "format": "hours"},
            {"label": "Within cap", "value": counts["within_cap"], "format": "integer"},
            {"label": "Excess", "value": counts["excess"], "format": "integer"},
            {"label": "Employees with excess", "value": len(excess_emps), "format": "integer"},
        ],
        notes=notes,
    )


register(ReportSpec(
    id="permission-register",
    title="Permission Records",
    description="Every permission request with its type, time window, decision, cap position and effect on the day.",
    category=S.CATEGORY,
    family="permissions",
    variant="Records",
    icon="Clock",
    tags=("permission", "late in", "early out", "short leave", "cap"),
    modules=("requests",),
    filters=(
        F.date_range("thisMonth", "Permission date"),
        *F.scope(status="all"),
        F.select("permissionType", "Permission type", TYPE_OPTIONS),
        F.select("status", "Status", STATUS_OPTIONS),
        F.select("capStatus", "Cap position", (("within_cap", "Within cap"), ("excess", "Excess (over the cap)"))),
        F.select("approverRole", "Decided by", (("hr", "HR"), ("dept_head", "Department Head"))),
    ),
    columns=(
        *EMP_COLS[:3],
        S.BRANCH_COL,
        ColumnSpec("date", "Date", DATE, 1.1),
        ColumnSpec("typeLabel", "Type", BADGE, 1.6),
        ColumnSpec("permissionTime", "From", TIME, 0.7),
        ColumnSpec("permissionEnd", "To", TIME, 0.7),
        ColumnSpec("durationMinutes", "Minutes", MINUTES, 0.8),
        ColumnSpec("reason", "Reason", TEXT, 2.2),
        ColumnSpec("appliedOn", "Applied on", DATETIME, 1.4),
        ColumnSpec("status", "Status", BADGE, 0.9),
        ColumnSpec("capStatus", "Cap position", BADGE, 1.0),
        ColumnSpec("monthSeq", "Nth in month", INTEGER, 0.8),
        ColumnSpec("decidedBy", "Decided by", TEXT, 1.5),
        ColumnSpec("hrComment", "Comment", TEXT, 1.6),
        ColumnSpec("dayEffect", "Effect on the day", TEXT, 2.0),
    ),
    run=_register_run,
))


# ── 2. Permission counts (employee x month) ─────────────────────────────────


def _new_bucket() -> dict:
    return {"morning_late_in": 0, "evening_early_out": 0, "middle_permission": 0, UNCLASSIFIED: 0,
            "approved": 0, "pending": 0, "rejected": 0, "minutes": 0, "last": None}


def _counts_run(ctx) -> ReportResult:
    from api.attendance_final import late_pool_summary
    from api.models import EmployeePermission

    settings = S.load_settings()
    cap = S.permission_cap(settings)
    lo, hi = S.whole_months(ctx.date_from, ctx.date_to)
    qs = EmployeePermission.objects.filter(ctx.emp_q("employee__"), date__gte=lo, date__lte=hi)

    buckets: dict[tuple[int, str], dict] = defaultdict(_new_bucket)
    for eid, d, status, raw_type, duration in qs.values_list(
        "employee_id", "date", "status", "type", "duration_minutes"
    ).iterator():
        b = buckets[(eid, S.month_key(d))]
        if status == "approved":
            b["approved"] += 1
            b[EmployeePermission.normalize_type(raw_type) or UNCLASSIFIED] += 1
            b["minutes"] += duration if duration is not None else EmployeePermission.FIXED_DURATION_MINUTES
            b["last"] = d if b["last"] is None or d > b["last"] else b["last"]
        elif status == "pending":
            b["pending"] += 1
        elif status == "rejected":
            b["rejected"] += 1

    employees = {e.id: e for e in ctx.employees().filter(id__in={k[0] for k in buckets})}
    rows = []
    over_cap: set[int] = set()
    for (eid, month), b in buckets.items():
        emp = employees.get(eid)
        if emp is None:
            continue
        # Same formula the payroll engine uses for permissions beyond the cap.
        excess = late_pool_summary((), b["approved"], settings)["excess_permissions"]
        if ctx.param("onlyExcess") and excess == 0:
            continue
        if excess:
            over_cap.add(eid)
        rows.append({
            **{k: v for k, v in S.base_cells(emp).items() if k != "branch"},
            "_branch": S.branch_name(emp),
            "month": month,
            "morningLateIn": b["morning_late_in"],
            "eveningEarlyOut": b["evening_early_out"],
            "middleOneHour": b["middle_permission"],
            "unclassified": b[UNCLASSIFIED],
            "totalApproved": b["approved"],
            "pending": b["pending"],
            "rejected": b["rejected"],
            "monthlyCap": cap,
            "excess": excess,
            "capUsedPct": round(b["approved"] * 100 / cap, 1) if cap else None,
            "approvedMinutes": b["minutes"],
            "lastPermissionDate": S.dstr(b["last"]),
        })

    rows = S.department_subtotals(
        rows,
        ("morningLateIn", "eveningEarlyOut", "middleOneHour", "unclassified", "totalApproved", "pending", "rejected",
         "excess", "approvedMinutes"),
    )
    data = [r for r in rows if r.get("_kind") != "subtotal"]
    notes = [
        f"Monthly cap in force: {cap} approved permission(s) per employee per calendar month; all three types count "
        "together. Excess = approved permissions beyond the cap (they join the late pool, priced by payroll).",
        "The type columns count APPROVED permissions only; Pending and Rejected are shown separately and never count "
        "toward the cap. 'Unclassified' = older requests saved without a type (they still count).",
        "Cap-used can exceed 100% when HR approves beyond the cap. Production employees' permissions have no "
        "attendance or payroll effect.",
    ]
    if (lo, hi) != (ctx.date_from, ctx.date_to):
        notes.append(
            f"The cap is a per-calendar-month rule, so the date range was widened to whole months "
            f"({lo.isoformat()} to {hi.isoformat()})."
        )
    return ReportResult(
        rows=rows,
        summary=[
            {"label": "Approved permissions", "value": sum(r["totalApproved"] for r in data), "format": "integer"},
            {"label": "Excess permissions", "value": sum(r["excess"] for r in data), "format": "integer"},
            {"label": "Employees over the cap", "value": len(over_cap), "format": "integer"},
            {"label": "Approved hours", "value": round(sum(r["approvedMinutes"] for r in data) / 60, 2), "format": "hours"},
            {"label": "Pending requests", "value": sum(r["pending"] for r in data), "format": "integer"},
        ],
        notes=notes,
    )


register(ReportSpec(
    id="permission-monthly-counts",
    title="Permission Counts",
    description="Permissions per employee per month by type and status, against the monthly cap, with the excess count.",
    category=S.CATEGORY,
    family="permissions",
    variant="Counts",
    icon="Hash",
    tags=("permission", "cap", "excess", "count", "monthly"),
    modules=("requests",),
    filters=(
        F.date_range("thisMonth", "Permission date", max_days=366),
        *F.scope(status="all"),
        F.boolean("onlyExcess", "Only employees over the cap"),
    ),
    columns=(
        *EMP_COLS,
        ColumnSpec("month", "Month", TEXT, 0.9),
        ColumnSpec("morningLateIn", "Morning late-in", INTEGER, 0.9, total="sum"),
        ColumnSpec("eveningEarlyOut", "Evening early-out", INTEGER, 0.9, total="sum"),
        ColumnSpec("middleOneHour", "Middle 1-hour", INTEGER, 0.9, total="sum"),
        ColumnSpec("unclassified", "Unclassified", INTEGER, 0.9, total="sum"),
        ColumnSpec("totalApproved", "Approved", INTEGER, 0.8, total="sum"),
        ColumnSpec("pending", "Pending", INTEGER, 0.8, total="sum"),
        ColumnSpec("rejected", "Rejected", INTEGER, 0.8, total="sum"),
        ColumnSpec("monthlyCap", "Cap", INTEGER, 0.6),
        ColumnSpec("excess", "Excess", INTEGER, 0.8, total="sum"),
        ColumnSpec("capUsedPct", "Cap used", PERCENT, 0.8),
        ColumnSpec("approvedMinutes", "Approved minutes", MINUTES, 1.0, total="sum"),
        ColumnSpec("lastPermissionDate", "Last approved", DATE, 1.1),
    ),
    run=_counts_run,
))


# ── 3. Excess permissions -> salary impact ──────────────────────────────────


def _slip_pool(slip) -> tuple[dict, dict, dict]:
    """(lateSummary, deductions, earnings) of a slip's breakdown, tolerating older / partial JSON."""
    bd = slip.breakdown_details if isinstance(slip.breakdown_details, dict) else {}
    ded = bd.get("deductions") if isinstance(bd.get("deductions"), dict) else {}
    earn = bd.get("earnings") if isinstance(bd.get("earnings"), dict) else {}
    late = ded.get("lateSummary") if isinstance(ded.get("lateSummary"), dict) else {}
    return late, ded, earn


def _as_int(value) -> int | None:
    try:
        return None if value is None else int(value)
    except (TypeError, ValueError):
        return None


def _excess_cost(late: dict, daily_rate, settings) -> float | None:
    """Rupees of the late-pool penalty caused by the excess permissions: the penalty with them in the pool minus the
    penalty without them, priced by the engine's own slab function. Only returned when re-pricing the stored billable
    count with the CURRENT slabs reproduces the payslip (otherwise the slabs changed since it was generated)."""
    from api.payroll_views import late_shift_deduction

    total, excess, billable = _as_int(late.get("totalLateCount")), _as_int(late.get("excessPermissionCount")), _as_int(late.get("billableLateCount"))
    free = _as_int(late.get("freeAllowance"))
    if None in (total, excess, billable, free) or daily_rate is None or late.get("shiftDeductions") is None:
        return None
    with_excess = late_shift_deduction(billable, settings)
    if with_excess != Decimal(str(late["shiftDeductions"])):
        return None
    without = late_shift_deduction(max(0, total - excess - free), settings)
    rate = Decimal(str(daily_rate))
    return float(_money(with_excess * rate) - _money(without * rate))


def _impact_run(ctx) -> ReportResult:
    from api.attendance_final import late_pool_summary
    from api.models import EmployeePermission, SalarySlip

    year, month = ctx.period
    settings = S.load_settings()
    cap_now = S.permission_cap(settings)
    scope_q = ctx.emp_q("employee__")

    live: dict[int, int] = dict(
        EmployeePermission.objects.filter(
            scope_q, employee__employment_type="staff", status="approved", date__year=year, date__month=month
        ).values("employee_id").annotate(n=Count("id")).values_list("employee_id", "n")
    )
    slips: dict[int, object] = {}
    for slip in SalarySlip.objects.filter(
        scope_q, employee__employment_type="staff", month=month, year=year,
        week_number__isnull=True, period_start__isnull=True,
    ).order_by("id"):
        slips[slip.employee_id] = slip  # a later duplicate wins

    late_of = {eid: _slip_pool(s) for eid, s in slips.items()}
    wanted = set(live) | {eid for eid, (late, _d, _e) in late_of.items() if (_as_int(late.get("excessPermissionCount")) or 0) > 0}
    employees = list(ctx.employees().filter(id__in=wanted, employment_type="staff"))

    rows = []
    changed = 0
    for emp in employees:
        approved = live.get(emp.id, 0)
        slip = slips.get(emp.id)
        row = {
            **{k: v for k, v in S.base_cells(emp).items() if k != "branch"},
            "_branch": S.branch_name(emp),
            "approvedPermissions": approved,
            "monthlyCap": cap_now,
            "excessPermissions": late_pool_summary((), approved, settings)["excess_permissions"],
            "lateInCount": None, "earlyOutCount": None, "totalPool": None, "freeAllowance": None,
            "billableLate": None, "shiftDeductions": None, "dailyRate": None, "latePenalty": None, "excessCost": None,
            "slipStatus": "No payslip",
        }
        if slip is not None:
            late, ded, earn = late_of[emp.id]
            if not late:
                row["slipStatus"] = "Payslip without late data"
            else:
                cap_used = _as_int(late.get("permissionMonthlyCap"))
                cap_used = cap_now if cap_used is None else cap_used
                stored_excess = _as_int(late.get("excessPermissionCount")) or 0
                row.update({
                    "monthlyCap": cap_used,
                    "excessPermissions": stored_excess,
                    "lateInCount": _as_int(late.get("lateInCount")),
                    "earlyOutCount": _as_int(late.get("earlyOutCount")),
                    "totalPool": _as_int(late.get("totalLateCount")),
                    "freeAllowance": _as_int(late.get("freeAllowance")),
                    "billableLate": _as_int(late.get("billableLateCount")),
                    "shiftDeductions": r2(late.get("shiftDeductions")),
                    "dailyRate": r2(earn.get("dailyRate")),
                    "latePenalty": r2(ded["lateShiftPenalty"]) if ded.get("lateShiftPenalty") is not None else r2(slip.other_deductions),
                    "excessCost": _excess_cost(late, earn.get("dailyRate"), settings),
                })
                drifted = max(0, approved - cap_used) != stored_excess
                row["slipStatus"] = "Changed since payslip" if drifted else "Payslip generated"
                changed += 1 if drifted else 0
        rows.append(row)

    show = ctx.param("show")
    if show == "excess":
        rows = [r for r in rows if (r["excessPermissions"] or 0) > 0]
    elif show == "penalised":
        rows = [r for r in rows if (r["latePenalty"] or 0) > 0]

    sum_keys = ("approvedPermissions", "excessPermissions", "lateInCount", "earlyOutCount", "totalPool", "billableLate",
                "shiftDeductions", "latePenalty", "excessCost")
    rows = S.department_subtotals(rows, sum_keys)
    data = [r for r in rows if r.get("_kind") != "subtotal"]
    return ReportResult(
        rows=rows,
        summary=[
            {"label": "Late-pool salary deducted", "value": round(sum(r["latePenalty"] or 0 for r in data), 2), "format": "currency"},
            {"label": "Salary caused by excess permissions", "value": round(sum(r["excessCost"] or 0 for r in data), 2), "format": "currency"},
            {"label": "Employees penalised", "value": sum(1 for r in data if (r["latePenalty"] or 0) > 0), "format": "integer"},
            {"label": "Excess permissions", "value": sum(r["excessPermissions"] or 0 for r in data), "format": "integer"},
            {"label": "Billable occurrences", "value": sum(r["billableLate"] or 0 for r in data), "format": "integer"},
            {"label": "Changed since payslip", "value": changed, "format": "integer"},
        ],
        notes=[
            "Staff only: production employees have no permission concept. Listed: employees with at least one approved "
            "permission in the month (or an excess permission on their payslip); employees whose late pool has no "
            "permissions are not listed here.",
            "Pool figures and the penalty are the generated payslip's stored values (late pool = late-in + early-out + "
            "permissions beyond the cap; free allowance, then slabs x daily rate). Months without a payslip show live "
            "permission counts only.",
            "'Salary caused by excess permissions' = penalty with the excess permissions in the pool minus the penalty "
            "without them, priced with the current late-deduction slabs; blank when the slabs have changed since the "
            "payslip was generated.",
            "'Changed since payslip' = permissions were approved, rejected or removed after the payslip was generated "
            "(live excess differs from the payslip); regenerate the payslip to apply the change.",
        ],
    )


register(ReportSpec(
    id="permission-excess-salary-impact",
    title="Excess Permission Salary Impact",
    description="Staff permissions beyond the monthly cap, the late pool they fall into and the salary deducted.",
    category=S.CATEGORY,
    family="permissions",
    variant="Salary impact",
    icon="IndianRupee",
    tags=("permission", "excess", "late", "deduction", "salary", "cap"),
    modules=("payroll", "salary", "salary_slip"),
    filters=(
        F.period("lastMonth"),
        *F.scope(status="all", employment=False),
        F.select("show", "Show", (("excess", "Only employees with excess permissions"), ("penalised", "Only employees with a late-pool deduction"))),
    ),
    columns=(
        *EMP_COLS,
        ColumnSpec("approvedPermissions", "Approved permissions", INTEGER, 1.0, total="sum"),
        ColumnSpec("monthlyCap", "Cap", INTEGER, 0.6),
        ColumnSpec("excessPermissions", "Excess", INTEGER, 0.8, total="sum"),
        ColumnSpec("lateInCount", "Late-in", INTEGER, 0.8, total="sum"),
        ColumnSpec("earlyOutCount", "Early-out", INTEGER, 0.8, total="sum"),
        ColumnSpec("totalPool", "Pool total", INTEGER, 0.8, total="sum"),
        ColumnSpec("freeAllowance", "Free", INTEGER, 0.6),
        ColumnSpec("billableLate", "Billable", INTEGER, 0.8, total="sum"),
        ColumnSpec("shiftDeductions", "Shifts deducted", NUMBER, 0.9, total="sum"),
        ColumnSpec("dailyRate", "Daily rate", CURRENCY, 1.1),
        ColumnSpec("latePenalty", "Late-pool deduction", CURRENCY, 1.3, total="sum"),
        ColumnSpec("excessCost", "Due to excess permissions", CURRENCY, 1.3, total="sum"),
        ColumnSpec("slipStatus", "Payslip", BADGE, 1.4),
    ),
    run=_impact_run,
))

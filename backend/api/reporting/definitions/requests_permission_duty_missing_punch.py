"""Missing-punch reports (group G7): the request register and the per-employee monthly frequency.

A ``MissingPunchRequest`` goes HOD first, then HR (HR can never act on a request still at the HOD stage; a HOD
rejection is final and leaves the ``hr_*`` columns empty). ``date`` is the day of the forgotten punch, not the day the
request was filed; ``punch_time`` is naive IST while the review stamps are aware UTC (shown in IST).

Approval writes one ``AttendanceLog`` row (source ``missing_punch:approved``) via get_or_create -- so the register
checks the punch log to say whether the punch really exists.
"""

from __future__ import annotations

from collections import defaultdict

from django.db.models import Exists, OuterRef, Q

from .. import filters as F
from ..common import EMP_COLS
from ..formatting import fmt_dt, full_name
from ..registry import register
from ..types import BADGE, DATE, DATETIME, HOURS, INTEGER, NUMBER, TEXT, TIME, ColumnSpec, ReportResult, ReportSpec
from . import requests_permission_duty_shared as S

STATUS_OPTIONS = (
    ("pending", "Pending (HOD or HR)"),
    ("pending_hod", "Pending HOD"),
    ("pending_hr", "Pending HR"),
    ("approved", "Approved"),
    ("rejected", "Rejected"),
)
STATUS_LABELS = {"pending_hod": "Pending", "pending_hr": "Pending", "approved": "Approved", "rejected": "Rejected"}
SLOT_OPTIONS = (
    ("morning_in", "Morning Check-In"),
    ("lunch_out", "Lunch Check-Out"),
    ("lunch_in", "Lunch Check-In"),
    ("evening_out", "Evening Check-Out"),
    ("unspecified", "Not specified"),
)
SLOT_LABELS = dict(SLOT_OPTIONS)
WRITTEN_SOURCE = "missing_punch:approved"  # AttendanceLog.source of the punch an approval adds


def slot_label(slot) -> str:
    if not slot:
        return "Not specified"
    return SLOT_LABELS.get(slot) or str(slot).replace("_", " ").title()


def status_label(status) -> str | None:
    if not status:
        return None
    return STATUS_LABELS.get(status, str(status).replace("_", " ").title())


def _filtered(ctx):
    from api.models import MissingPunchRequest

    qs = MissingPunchRequest.objects.filter(ctx.emp_q("employee__"), date__gte=ctx.date_from, date__lte=ctx.date_to)
    status = ctx.param("status")
    if status == "pending":
        qs = qs.filter(status__in=("pending_hod", "pending_hr"))
    elif status:
        qs = qs.filter(status=status)
    slot = ctx.param("punchSlot")
    if slot == "unspecified":
        qs = qs.filter(Q(punch_slot__isnull=True) | Q(punch_slot=""))
    elif slot:
        qs = qs.filter(punch_slot=slot)
    rejected_at = ctx.param("rejectedAt")
    if rejected_at == "hod":
        qs = qs.filter(status="rejected", hr_reviewed_at__isnull=True)
    elif rejected_at == "hr":
        qs = qs.filter(status="rejected", hr_reviewed_at__isnull=False)
    return qs


def _decided_at(r):
    if r.status == "approved":
        return r.hr_reviewed_at
    if r.status == "rejected":
        return r.hr_reviewed_at or r.hod_reviewed_at
    return None


# ── 1. Register ─────────────────────────────────────────────────────────────


def _pending_with(reqs) -> tuple[dict[int, str], set[int]]:
    """{request id: who it is waiting for} for pending requests, and the ids that are stuck (nobody can act).

    A request at the HOD stage needs THE employee's one active HOD (hod_scope's one-HOD rule) and that HOD must hold the
    Missing Punch approval right; HR cannot act on it before that. A head never decides their own request (the HOD
    approval endpoint excludes it from their scope), so a request filed by the employee's own HOD is stuck too. Two
    queries however many requests there are."""
    from api.hod_scope import effective_owner_map
    from api.models import DepartmentManager

    at_hod = [r for r in reqs if r.status == "pending_hod"]
    owner = effective_owner_map({r.employee_id for r in at_hod}) if at_hod else {}
    managers = (
        {m.id: m for m in DepartmentManager.objects.select_related("employee").filter(id__in=set(owner.values()))}
        if owner
        else {}
    )
    text: dict[int, str] = {}
    stuck: set[int] = set()
    for r in reqs:
        if r.status == "pending_hr":
            text[r.id] = "HR"
        elif r.status == "pending_hod":
            m = managers.get(owner.get(r.employee_id))
            if m is None:
                text[r.id] = "No HOD assigned - HR cannot act"
                stuck.add(r.id)
            elif m.employee_id == r.employee_id:
                text[r.id] = f"HOD {full_name(m.employee)}: a head never decides their own request - stuck"
                stuck.add(r.id)
            elif not m.can_approve_missing_punch:
                text[r.id] = f"HOD {full_name(m.employee)}: no Missing Punch approval right - stuck"
                stuck.add(r.id)
            else:
                text[r.id] = f"HOD: {full_name(m.employee)}"
    return text, stuck


def _register_run(ctx) -> ReportResult:
    from api.models import AttendanceLog

    base = _filtered(ctx)
    reqs = list(
        base.select_related("employee__department", "employee__designation", "employee__branch").order_by(
            "date", "employee__employee_code", "id"
        )[: ctx.row_limit]
    )
    pending_text, stuck = _pending_with(reqs)

    # Which approved requests actually have their punch in the log: one query, only the matching punches come back.
    matching = base.filter(
        status="approved",
        employee_id=OuterRef("employee_id"),
        date=OuterRef("date"),
        punch_time=OuterRef("punch_time"),
        punch_type=OuterRef("punch_type"),
    )
    logged = {
        (eid, d, t, ty): src
        for eid, d, t, ty, src in AttendanceLog.objects.filter(Exists(matching)).values_list(
            "employee_id", "date", "punch_time", "punch_type", "source"
        )
    }  # the log is unique per (employee, date, time, in/out), so one source per punch

    rows = []
    counts = {"approved": 0, "rejected_hod": 0, "rejected_hr": 0, "pending": 0}
    turnaround: list[float] = []
    by_slot: dict[str, int] = defaultdict(int)
    missing_from_log = 0
    counted = {r.id for r in S.shown(reqs, ctx)}  # the extra row the runner uses to flag a cut is not counted
    for r in reqs:
        in_count = r.id in counted
        h = S.hours_between(r.created_at, _decided_at(r))
        if h is not None and in_count:
            turnaround.append(h)
        written = None
        if r.status == "approved":
            src = logged.get((r.employee_id, r.date, r.punch_time, r.punch_type))
            if src is None:
                written = "Missing from punch log"
                missing_from_log += 1 if in_count else 0
            else:
                written = "Yes - added by approval" if src == WRITTEN_SOURCE else "Yes - already recorded"
        comments = "; ".join(
            f"{label}: {text}" for label, text in (("HOD", r.hod_review_comment), ("HR", r.hr_review_comment)) if text
        )
        applied = S.ist_date(r.created_at)
        rows.append(
            {
                **S.base_cells(r.employee),
                "date": r.date.isoformat(),
                "punchSlot": slot_label(r.punch_slot),
                "punchType": r.punch_type,
                "punchTime": S.tstr(r.punch_time),
                "reason": r.reason,
                "appliedOn": fmt_dt(r.created_at),
                "lagDays": (applied - r.date).days if applied else None,
                "status": status_label(r.status),
                "hodBy": r.hod_reviewed_by,
                "hodAt": fmt_dt(r.hod_reviewed_at),
                "hrBy": r.hr_reviewed_by,
                "hrAt": fmt_dt(r.hr_reviewed_at),
                "comments": comments or None,
                "turnaroundHours": h,
                "pendingWith": pending_text.get(r.id),
                "punchWritten": written,
            }
        )
        if not in_count:
            continue
        by_slot[r.punch_slot or "unspecified"] += 1
        if r.status == "approved":
            counts["approved"] += 1
        elif r.status == "rejected":
            counts["rejected_hr" if r.hr_reviewed_at else "rejected_hod"] += 1
        elif r.status in ("pending_hod", "pending_hr"):
            counts["pending"] += 1

    notes = [
        "Date = the day of the forgotten punch; 'Days late' = how many days after it the request was filed (IST).",
        "Two-stage approval: HOD first, then HR. HR cannot act on a request that is still at the HOD stage, and a HOD "
        "rejection is final. A request with no HOD, a HOD without the Missing Punch right, or filed by the HOD "
        "themselves (a head never decides their own request) stays stuck until the HOD assignment is fixed or the "
        "request is deleted.",
        "Punch written: approval adds one punch to the log; 'already recorded' means an identical punch existed (for "
        "example from the biometric device); 'Missing from punch log' means the punch was approved but is not in the "
        "log now (deleted or replaced). Turnaround = filed to final decision, blank while pending.",
        "Requests by slot: " + ", ".join(f"{slot_label(k)} {v}" for k, v in sorted(by_slot.items())) + "."
        if by_slot
        else "",
        *S.cut_note(reqs, ctx),
    ]
    return ReportResult(
        rows=rows,
        summary=[
            {"label": "Requests", "value": len(counted), "format": "integer"},
            {"label": "Approved", "value": counts["approved"], "format": "integer"},
            {"label": "Rejected by HOD", "value": counts["rejected_hod"], "format": "integer"},
            {"label": "Rejected by HR", "value": counts["rejected_hr"], "format": "integer"},
            {"label": "Pending", "value": counts["pending"], "format": "integer"},
            {"label": "Stuck (no HOD / no right)", "value": len(stuck & counted), "format": "integer"},
            {"label": "Approved but not in log", "value": missing_from_log, "format": "integer"},
            {
                "label": "Avg turnaround (h)",
                "value": round(sum(turnaround) / len(turnaround), 2) if turnaround else None,
                "format": "hours",
            },
        ],
        notes=[n for n in notes if n],
    )


register(
    ReportSpec(
        id="missing-punch-register",
        title="Missing Punch Records",
        description="Every missing-punch request with slot, time, reason, HOD and HR decisions and whether the punch was written.",
        category=S.CATEGORY,
        family="missing-punch",
        variant="Requests",
        icon="TriangleAlert",
        tags=("missing punch", "forgot punch", "attendance", "hod", "approval"),
        modules=("missing_punch",),
        filters=(
            F.date_range("thisMonth", "Missed-punch date"),
            *F.scope(status="all"),
            F.select("status", "Status", STATUS_OPTIONS),
            F.select("punchSlot", "Punch slot", SLOT_OPTIONS),
            F.select("rejectedAt", "Rejected at", (("hod", "HOD stage"), ("hr", "HR stage"))),
        ),
        columns=(
            *S.LEAD_COLS,
            S.BRANCH_COL,
            ColumnSpec("date", "Missed on", DATE, 1.4),
            ColumnSpec("punchSlot", "Slot", BADGE, 1.5),
            ColumnSpec("punchType", "In/Out", BADGE, 0.6),
            ColumnSpec("punchTime", "Time", TIME, 0.7),
            ColumnSpec("reason", "Reason", TEXT, 2.0),
            ColumnSpec("appliedOn", "Filed on", DATETIME, 1.5),
            ColumnSpec("lagDays", "Days late", INTEGER, 0.7),
            ColumnSpec("status", "Status", BADGE, 1.1),
            ColumnSpec("hodBy", "HOD", TEXT, 1.2),
            ColumnSpec("hodAt", "HOD decided", DATETIME, 1.4),
            ColumnSpec("hrBy", "HR", TEXT, 1.2),
            ColumnSpec("hrAt", "HR decided", DATETIME, 1.4),
            ColumnSpec("comments", "Comments", TEXT, 1.8),
            ColumnSpec("turnaroundHours", "Turnaround (h)", HOURS, 1.2),
            ColumnSpec("pendingWith", "Pending with", TEXT, 2.0),
            ColumnSpec("punchWritten", "Punch written", BADGE, 1.5),
        ),
        run=_register_run,
    )
)


# ── 2. Monthly frequency ────────────────────────────────────────────────────

_SLOT_KEYS = {"morning_in": "morningIn", "lunch_out": "lunchOut", "lunch_in": "lunchIn", "evening_out": "eveningOut"}


def _new_bucket() -> dict:
    return {
        "requests": 0,
        "approved": 0,
        "rejected": 0,
        "pending": 0,
        "morningIn": 0,
        "lunchOut": 0,
        "lunchIn": 0,
        "eveningOut": 0,
        "unspecified": 0,
        "lag": [],
    }


def _counts_run(ctx) -> ReportResult:
    from api.models import MissingPunchRequest

    qs = MissingPunchRequest.objects.filter(ctx.emp_q("employee__"), date__gte=ctx.date_from, date__lte=ctx.date_to)
    buckets: dict[tuple[int, str], dict] = defaultdict(_new_bucket)
    for eid, d, status, slot, created in qs.values_list(
        "employee_id", "date", "status", "punch_slot", "created_at"
    ).iterator():
        b = buckets[(eid, S.month_key(d))]
        b["requests"] += 1
        if status == "approved":
            b["approved"] += 1
        elif status == "rejected":
            b["rejected"] += 1
        elif status in ("pending_hod", "pending_hr"):
            b["pending"] += 1
        b[_SLOT_KEYS.get(slot or "", "unspecified")] += 1
        filed = S.ist_date(created)
        if filed is not None:
            b["lag"].append((filed - d).days)

    # "At least N requests" is about the employee over the whole date range (a repeat requester), not about one month.
    minimum = int(ctx.param("minRequests") or 1)
    per_employee_total: dict[int, int] = defaultdict(int)
    for (eid, _month), b in buckets.items():
        per_employee_total[eid] += b["requests"]
    employees = {e.id: e for e in ctx.employees().filter(id__in={k[0] for k in buckets})}
    rows = []
    for (eid, month), b in buckets.items():
        emp = employees.get(eid)
        if emp is None or per_employee_total[eid] < minimum:
            continue
        rows.append(
            {
                **{k: v for k, v in S.base_cells(emp).items() if k != "branch"},
                "_branch": S.branch_name(emp),
                "month": month,
                **{
                    k: b[k]
                    for k in (
                        "requests",
                        "approved",
                        "rejected",
                        "pending",
                        "morningIn",
                        "lunchOut",
                        "lunchIn",
                        "eveningOut",
                        "unspecified",
                    )
                },
                "avgLagDays": round(sum(b["lag"]) / len(b["lag"]), 1) if b["lag"] else None,
            }
        )
    rows = S.department_subtotals(
        rows,
        (
            "requests",
            "approved",
            "rejected",
            "pending",
            "morningIn",
            "lunchOut",
            "lunchIn",
            "eveningOut",
            "unspecified",
        ),
    )
    data = [r for r in rows if r.get("_kind") != "subtotal"]
    per_employee: dict[str, int] = defaultdict(int)
    for r in data:
        per_employee[r["employeeCode"]] += r["requests"]
    decided = sum(r["approved"] + r["rejected"] for r in data)
    return ReportResult(
        rows=rows,
        summary=[
            {"label": "Requests", "value": sum(r["requests"] for r in data), "format": "integer"},
            {
                "label": "Employees with 3 or more",
                "value": sum(1 for n in per_employee.values() if n >= 3),
                "format": "integer",
            },
            {
                "label": "Approval rate",
                "value": round(sum(r["approved"] for r in data) * 100 / decided, 1) if decided else None,
                "format": "percent",
            },
            {"label": "Pending", "value": sum(r["pending"] for r in data), "format": "integer"},
        ],
        notes=[
            "One row per employee per calendar month of the forgotten punch. Slot = which punch the employee said was "
            "missing (a request without a slot counts as 'Not specified').",
            "Approval rate = approved / (approved + rejected); pending requests are not counted in it. Avg days late = "
            "average gap between the missed day and the day the request was filed.",
        ],
    )


register(
    ReportSpec(
        id="missing-punch-monthly-counts",
        title="Missing Punch Frequency",
        description="Repeat missing-punch requesters: requests per employee per month by slot and outcome.",
        category=S.CATEGORY,
        family="missing-punch",
        variant="Monthly counts",
        icon="Sigma",
        tags=("missing punch", "frequency", "count", "monthly", "repeat"),
        modules=("missing_punch",),
        filters=(
            F.date_range("thisMonth", "Missed-punch date", max_days=366),
            *F.scope(status="all"),
            F.select(
                "minRequests",
                "At least",
                (("2", "2 requests"), ("3", "3 requests"), ("5", "5 requests")),
                placeholder="Any number",
                help="Only employees with at least this many requests in the whole date range",
            ),
        ),
        columns=(
            *EMP_COLS,
            ColumnSpec("month", "Month", TEXT, 0.9),
            ColumnSpec("requests", "Requests", INTEGER, 1.05, total="sum"),
            ColumnSpec("approved", "Approved", INTEGER, 1.1, total="sum"),
            ColumnSpec("rejected", "Rejected", INTEGER, 1.05, total="sum"),
            ColumnSpec("pending", "Pending", INTEGER, 0.95, total="sum"),
            ColumnSpec("morningIn", "Morning in", INTEGER, 0.9, total="sum"),
            ColumnSpec("lunchOut", "Lunch out", INTEGER, 0.9, total="sum"),
            ColumnSpec("lunchIn", "Lunch in", INTEGER, 0.9, total="sum"),
            ColumnSpec("eveningOut", "Evening out", INTEGER, 0.9, total="sum"),
            ColumnSpec("unspecified", "No slot", INTEGER, 0.85, total="sum"),
            ColumnSpec("avgLagDays", "Avg days late", NUMBER, 0.9),
        ),
        run=_counts_run,
    )
)

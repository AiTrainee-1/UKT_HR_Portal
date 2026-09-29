"""Outpass reports (group G8, category "gate").

All of them read OutpassRequest - the only model that carries the whole pass lifecycle (requested ->
approved/rejected -> exit scan -> return scan). The anonymous QR-form submissions (OutpassRecord) and the raw
gate-scan audit live in ``gate_outpass_gate.py``.

The family "outpass" groups the four views a payroll/HR manager reaches for first: the register (same fields
as the Approved Passes table on the HR Outpass page, plus the outside time), the In / Out register, and the
per-employee and per-department summaries.

Nothing here touches attendance, payroll or leave - gate data has no salary effect in this system, and the
reports say so instead of implying a deduction.
"""

from __future__ import annotations

from collections import Counter
from datetime import timedelta

from django.db.models import Count, F, Q

from api.models import Branch, Department, Employee, OutpassRecord, OutpassRequest

from ..common import EMP_COLS, EMP_COLS_SHORT, emp_cells
from ..filters import boolean, scope, select
from ..formatting import minutes_text, r2
from ..registry import register
from ..types import (
    BADGE, DATE, DATETIME, DURATION, INTEGER, NUMBER, PERCENT, TEXT, ColumnSpec, ReportResult, ReportSpec,
)
from . import gate_outpass_common as C

MODULES = ("outpass_visitors", "requests")
NOTE_TIMES = "All times are Asia/Kolkata (IST)."
NOTE_NO_PAYROLL = "Gate data has no attendance, payroll or leave effect in this system; this report is informational."
NOTE_DOOR_TO_DOOR = (
    "Time outside is measured door to door (exit scan to return scan) and stays blank until a return is scanned; "
    "passes never scanned back are never given a running duration."
)
NOTE_STATE = (
    "Pass status follows the HR Outpass page. A pass scanned out on an earlier day with no return scan shows "
    "Not Returned, and an early-shift-dismissal pass that has left shows Early Dismissal (those are not expected back)."
)

APPROVAL_OPTIONS = (("pending", "Pending"), ("approved", "Approved"), ("rejected", "Rejected"))
ORIGIN_OPTIONS = (("manual", "Manual request"), ("on_duty", "On-Duty pass"))
ROLE_OPTIONS = (("hr", "HR"), ("dept_head", "Department head"), ("system", "System (On-Duty)"))


# ── shared query helpers ────────────────────────────────────────────────────


def _request_qs(ctx):
    """OutpassRequest with everything the detail reports print, branch isolation + employee filters applied."""
    return (
        OutpassRequest.objects.select_related("employee__department", "employee__designation", "exit_gate", "entry_gate")
        .defer(*C.EMP_DEFER)
        .filter(ctx.emp_q("employee__"))
    )


def _values_qs(ctx):
    """Same scope, but plain dict rows for the summary reports (no model instances)."""
    return OutpassRequest.objects.filter(ctx.emp_q("employee__")).order_by()


def _counts_line(prefix: str, counter: Counter) -> str | None:
    if not counter:
        return None
    body = ", ".join(f"{k} {v}" for k, v in sorted(counter.items(), key=lambda kv: (-kv[1], str(kv[0]))))
    return f"{prefix}: {body}."


def _text_summary(label: str, value) -> dict:
    return {"label": label, "value": value, "format": "text"}


def _sorted_notes(*notes) -> list[str]:
    return [n for n in notes if n]


# ── 1. outpass-register ─────────────────────────────────────────────────────

REGISTER_COLUMNS = (
    ColumnSpec("requestedAt", "Requested", DATETIME, 1.4),
    *EMP_COLS,
    ColumnSpec("passType", "Pass Type", BADGE, 1.1),
    ColumnSpec("source", "Origin", BADGE, 0.9),
    ColumnSpec("destination", "Destination", TEXT, 1.8),
    ColumnSpec("reason", "Reason", TEXT, 1.8),
    ColumnSpec("status", "Approval", BADGE, 0.9),
    ColumnSpec("reviewedBy", "Reviewed By", TEXT, 1.5),
    ColumnSpec("approvedAt", "Approved At", DATETIME, 1.4),
    ColumnSpec("expiresAt", "Pass Expires", DATETIME, 1.4),
    ColumnSpec("scanStatus", "Pass Status", BADGE, 1.3),
    ColumnSpec("exitGate", "Exit Gate", TEXT, 1.0),
    ColumnSpec("exitedAt", "Exit Time", DATETIME, 1.4),
    ColumnSpec("entryGate", "Return Gate", TEXT, 1.0),
    ColumnSpec("enteredAt", "Return Time", DATETIME, 1.4),
    ColumnSpec("outsideMinutes", "Time Outside", DURATION, 1.0, total="sum"),
    ColumnSpec("expectedReturnAt", "Expected Return", DATETIME, 1.4),
    ColumnSpec("reviewComment", "Review Comment", TEXT, 1.6),
)


def _register_row(req, state: str) -> dict:
    return {
        "requestedAt": C.fmt(req.created_at),
        **emp_cells(req.employee),
        "passType": C.pass_type_label(req.pass_type),
        "source": C.source_label(req.source),
        "destination": C.clean(req.destination),
        "reason": C.clean(req.reason),
        "status": C.status_label(req.status),
        "reviewedBy": C.reviewer_text(req.approver_role, req.approved_by),
        "approvedAt": C.fmt(req.approved_at),
        "expiresAt": C.fmt(req.approved_at + C.PASS_VALID) if req.approved_at else None,
        "scanStatus": C.state_label(state),
        "exitGate": req.exit_gate.name if req.exit_gate_id else None,
        "exitedAt": C.fmt(req.exited_at),
        "entryGate": req.entry_gate.name if req.entry_gate_id else None,
        "enteredAt": C.fmt(req.entered_at),
        "outsideMinutes": C.minutes_between(req.exited_at, req.entered_at),
        "expectedReturnAt": C.fmt(req.expected_return_at),
        "reviewComment": C.clean(req.review_comment),
    }


def _run_register(ctx) -> ReportResult:
    now_dt = C.now()
    today = C.ist_date(now_dt)
    p = ctx.params
    qs = _request_qs(ctx).filter(C.in_range("created_at", ctx)).filter(C.pass_type_q(p.get("passType")))
    if p.get("approvalStatus"):
        qs = qs.filter(status=p["approvalStatus"])
    if p.get("source"):
        qs = qs.filter(source=p["source"])
    if p.get("reviewerRole"):
        qs = qs.filter(approver_role=p["reviewerRole"])
    qs = qs.filter(C.gate_name_q(p.get("gate"), ("exit_gate", "entry_gate"))).order_by("-created_at", "-id")

    wanted_state = p.get("scanStatus")
    if wanted_state:
        # The pass state depends on "now", so it cannot be a SQL filter: derive it, keep matches, stop at the cap.
        picked = []
        for req in qs:
            if C.pass_state(req, now_dt, today) == wanted_state:
                picked.append(req)
                if len(picked) >= ctx.row_limit:
                    break
    else:
        picked = list(qs[: ctx.row_limit])

    rows, states = [], []
    for req in picked:
        state = C.pass_state(req, now_dt, today)
        states.append(state)
        rows.append(_register_row(req, state))

    n = len(picked)
    by_status = Counter(r.status for r in picked)
    outside = [r["outsideMinutes"] for r in rows if r["outsideMinutes"] is not None]
    summary = [
        {"label": "Total requests", "value": n, "format": "integer"},
        {"label": "Approved", "value": by_status.get("approved", 0), "format": "integer"},
        {"label": "Rejected", "value": by_status.get("rejected", 0), "format": "integer"},
        {"label": "Pending", "value": by_status.get("pending", 0), "format": "integer"},
        {"label": "Exited", "value": sum(1 for r in picked if r.exited_at), "format": "integer"},
        {"label": "Returned", "value": sum(1 for r in picked if r.entered_at), "format": "integer"},
        {"label": "Not returned", "value": sum(1 for s in states if C.is_open(s)), "format": "integer"},
        {
            "label": "Avg time outside",
            "value": C.mean_minutes(outside),
            "format": "duration",
        },
    ]
    notes = _sorted_notes(
        NOTE_TIMES,
        NOTE_STATE,
        NOTE_DOOR_TO_DOOR,
        "Pass Expires is the approval time plus 60 minutes. Reviewed By is also filled when a request was rejected.",
        _counts_line("By pass type", Counter(C.pass_type_label(r.pass_type) for r in picked)),
        _counts_line("By origin", Counter(C.source_label(r.source) for r in picked)),
        _counts_line("By reviewer", Counter(C.role_label(r.approver_role) or "Not decided" for r in picked)),
        C.truncated_note(ctx, n),
    )
    return ReportResult(rows=rows, summary=summary, notes=notes)


register(ReportSpec(
    id="outpass-register",
    title="Outpass Register",
    description="Every outpass request with its approval, gate exit and return, time outside and current pass status.",
    category="gate",
    icon="DoorOpen",
    tags=("outpass", "gate pass", "approved passes", "exit", "return", "register"),
    family="outpass",
    variant="Register",
    modules=MODULES,
    filters=(
        C.dates("Requested between", "the date the pass was requested"),
        *scope(status="all"),
        C.pass_type_filter(),
        select("approvalStatus", "Approval status", APPROVAL_OPTIONS, placeholder="All"),
        select("scanStatus", "Pass status", C.STATE_OPTIONS, placeholder="All"),
        select("source", "Origin", ORIGIN_OPTIONS, placeholder="All origins"),
        select("reviewerRole", "Reviewed by", ROLE_OPTIONS, placeholder="Anyone"),
        C.gate_filter(),
    ),
    columns=REGISTER_COLUMNS,
    run=_run_register,
))


# ── 2. outpass-in-out-register ──────────────────────────────────────────────

IN_OUT_COLUMNS = (
    ColumnSpec("date", "Date", DATE, 1.1),
    ColumnSpec("employeeCode", "Emp Code", TEXT, 1.0),
    ColumnSpec("employeeName", "Employee", TEXT, 2.2),
    ColumnSpec("department", "Department", TEXT, 1.5),
    ColumnSpec("passType", "Pass Type", BADGE, 1.1),
    ColumnSpec("destination", "Destination", TEXT, 1.8),
    ColumnSpec("exitGate", "Exit Gate", TEXT, 1.0),
    ColumnSpec("exitedAt", "Out", DATETIME, 1.4),
    ColumnSpec("entryGate", "Return Gate", TEXT, 1.0),
    ColumnSpec("enteredAt", "In", DATETIME, 1.4),
    ColumnSpec("outsideMinutes", "Time Outside", DURATION, 1.0, total="sum"),
    ColumnSpec("expectedReturnAt", "Expected Return", DATETIME, 1.4),
    ColumnSpec("overrunMinutes", "Over Expected", DURATION, 1.0),
    ColumnSpec("reviewedBy", "Approved By", TEXT, 1.5),
    ColumnSpec("state", "State", BADGE, 1.1),
)


_RETURN_STATE_OPTIONS = (
    ("returned", "Returned"), ("outside_now", "Outside Now"), ("not_returned", "Not Returned"),
    ("early_dismissal", "Early Dismissal"),
)
_RETURN_STATE_KEYS = {
    "outside_now": C.OUTSIDE_STATES, "not_returned": ("not_returned",), "early_dismissal": ("early_dismissal",),
}


def _run_in_out(ctx) -> ReportResult:
    now_dt = C.now()
    today = C.ist_date(now_dt)
    p = ctx.params
    qs = (
        _request_qs(ctx)
        .filter(exited_at__isnull=False)
        .filter(C.in_range("exited_at", ctx))
        .filter(C.pass_type_q(p.get("passType")))
        .filter(C.gate_name_q(p.get("gate"), ("exit_gate", "entry_gate")))
    )
    wanted = _RETURN_STATE_KEYS.get(p.get("returnState"))
    if p.get("returnState") == "returned":
        qs = qs.filter(entered_at__isnull=False)
    elif wanted:
        qs = qs.filter(entered_at__isnull=True)

    picked, states = [], []
    for req in qs.order_by("-exited_at", "-id"):
        state = C.pass_state(req, now_dt, today)
        if wanted and state not in wanted:
            continue
        picked.append(req)
        states.append(state)
        if len(picked) >= ctx.row_limit:
            break

    rows = []
    for req, state in zip(picked, states):
        emp = emp_cells(req.employee)
        rows.append({
            "date": C.ist_date(req.exited_at).isoformat(),
            "employeeCode": emp["employeeCode"],
            "employeeName": emp["employeeName"],
            "department": emp["department"],
            "passType": C.pass_type_label(req.pass_type),
            "destination": C.clean(req.destination),
            "exitGate": req.exit_gate.name if req.exit_gate_id else None,
            "exitedAt": C.fmt(req.exited_at),
            "entryGate": req.entry_gate.name if req.entry_gate_id else None,
            "enteredAt": C.fmt(req.entered_at),
            "outsideMinutes": C.minutes_between(req.exited_at, req.entered_at),
            "expectedReturnAt": C.fmt(req.expected_return_at),
            "overrunMinutes": C.overrun_minutes(req, state, now_dt),
            "reviewedBy": C.reviewer_text(req.approver_role, req.approved_by),
            "state": C.movement_label(state),
        })

    n = len(picked)
    outside = [r["outsideMinutes"] for r in rows if r["outsideMinutes"] is not None]
    per_gate = Counter(r["exitGate"] or "Unknown gate" for r in rows)
    by_state = Counter(states)
    summary = [
        {"label": "Total exits", "value": n, "format": "integer"},
        {"label": "Returned", "value": by_state.get("completed", 0), "format": "integer"},
        {"label": "Outside now", "value": sum(by_state.get(k, 0) for k in C.OUTSIDE_STATES), "format": "integer"},
        {"label": "Not returned (earlier days)", "value": by_state.get("not_returned", 0), "format": "integer"},
        {"label": "Total time outside", "value": sum(outside) if outside else None, "format": "duration"},
        {"label": "Avg time outside", "value": C.mean_minutes(outside), "format": "duration"},
        {"label": "Longest absence", "value": max(outside) if outside else None, "format": "duration"},
    ]
    notes = _sorted_notes(
        NOTE_TIMES,
        "Only passes that were physically scanned out at a gate are listed; the date is the IST day of the exit scan.",
        NOTE_DOOR_TO_DOOR,
        "State: Outside Now = scanned out today and not yet back; Not Returned = scanned out on an earlier day with no "
        "return scan; Early Dismissal = an early-shift-dismissal pass (not expected back).",
        f"Early dismissals in this list: {by_state.get('early_dismissal', 0)}." if by_state.get("early_dismissal") else None,
        "Over Expected is shown only for passes that came back, or are outside now, and had an expected return time.",
        _counts_line("Exits per gate", per_gate),
        C.truncated_note(ctx, n),
    )
    return ReportResult(rows=rows, summary=summary, notes=notes)


register(ReportSpec(
    id="outpass-in-out-register",
    title="Gate In / Out Register",
    description="Security-desk register of gate exits and returns with the time each employee was outside.",
    category="gate",
    icon="ArrowRightLeft",
    tags=("outpass", "in out", "gate register", "movement", "exit", "return"),
    family="outpass",
    variant="In / Out",
    modules=MODULES,
    filters=(
        C.dates("Exited between", "the time of the exit scan"),
        *scope(designation=False, status=None),
        C.pass_type_filter(),
        select("returnState", "State", _RETURN_STATE_OPTIONS, placeholder="All"),
        C.gate_filter(),
    ),
    columns=IN_OUT_COLUMNS,
    run=_run_in_out,
))


# ── per-employee / per-group statistics (values-based) ──────────────────────

STAT_FIELDS = (
    "employee_id", "status", "pass_type", "source", "approved_at", "exited_at", "entered_at",
    "return_qr_generated_at", "expected_return_at",
)


class _Stats:
    """Counters for a set of requests. Feed it ``.values()`` rows via ``add``."""

    __slots__ = (
        "requests", "approved", "rejected", "pending", "exited", "returned", "open", "expired_unused",
        "official", "personal", "early", "unspecified", "outside", "late", "employees",
    )

    def __init__(self):
        self.requests = self.approved = self.rejected = self.pending = 0
        self.exited = self.returned = self.open = self.expired_unused = 0
        self.official = self.personal = self.early = self.unspecified = 0
        self.late = 0
        self.outside: list[int] = []
        self.employees: set[int] = set()

    def add(self, row: dict, state: str, overrun: int | None) -> None:
        self.requests += 1
        self.employees.add(row["employee_id"])
        if row["status"] == "approved":
            self.approved += 1
        elif row["status"] == "rejected":
            self.rejected += 1
        elif row["status"] == "pending":
            self.pending += 1
        if row["exited_at"]:
            self.exited += 1
        if row["entered_at"]:
            self.returned += 1
            minutes = C.minutes_between(row["exited_at"], row["entered_at"])
            if minutes is not None:
                self.outside.append(minutes)
        if C.is_open(state):
            self.open += 1
        if state == "expired_unscanned":
            self.expired_unused += 1
        pt = row["pass_type"]
        if pt == "official":
            self.official += 1
        elif pt == "personal":
            self.personal += 1
        elif pt == "early_dismissal":
            self.early += 1
        else:
            self.unspecified += 1
        if C.is_late(overrun):
            self.late += 1

    @property
    def total_outside(self) -> int | None:
        return sum(self.outside) if self.outside else None

    @property
    def avg_outside(self) -> int | None:
        return C.mean_minutes(self.outside)

    @property
    def max_outside(self) -> int | None:
        return max(self.outside) if self.outside else None


def _feed(stats_for, rows, now_dt, today) -> None:
    """Classify each values-row once and hand it to the right ``_Stats``."""
    for row in rows:
        obj = C.as_pass(row)
        state = C.pass_state(obj, now_dt, today)
        overrun = C.overrun_minutes(obj, state, now_dt)
        stats_for(row).add(row, state, overrun)


# ── 3. outpass-employee-summary ─────────────────────────────────────────────

EMPLOYEE_SUMMARY_COLUMNS = (
    *EMP_COLS,
    ColumnSpec("requests", "Requests", INTEGER, 0.9, total="sum"),
    ColumnSpec("approved", "Approved", INTEGER, 0.9, total="sum"),
    ColumnSpec("rejected", "Rejected", INTEGER, 0.9, total="sum"),
    ColumnSpec("pending", "Pending", INTEGER, 0.9, total="sum"),
    ColumnSpec("exited", "Exited", INTEGER, 0.8, total="sum"),
    ColumnSpec("returned", "Returned", INTEGER, 0.9, total="sum"),
    ColumnSpec("notReturned", "Not Returned", INTEGER, 1.0, total="sum"),
    ColumnSpec("expiredUnused", "Expired Unused", INTEGER, 1.0, total="sum"),
    ColumnSpec("official", "Official", INTEGER, 0.8, total="sum"),
    ColumnSpec("personal", "Personal", INTEGER, 0.8, total="sum"),
    ColumnSpec("earlyDismissal", "Early Dismissal", INTEGER, 1.0, total="sum"),
    ColumnSpec("unspecified", "Unspecified", INTEGER, 0.9, total="sum"),
    ColumnSpec("totalOutsideMinutes", "Total Outside", DURATION, 1.0),
    ColumnSpec("avgOutsideMinutes", "Avg / Pass", DURATION, 0.9),
    ColumnSpec("maxOutsideMinutes", "Longest", DURATION, 0.9),
    ColumnSpec("lateReturns", "Late Returns", INTEGER, 0.9, total="sum"),
    ColumnSpec("qrSubmissions", "QR Submissions", INTEGER, 1.0, total="sum"),
)
_MIN_PASSES = (("1", "1 or more"), ("2", "2 or more"), ("3", "3 or more"), ("5", "5 or more"), ("10", "10 or more"))


def _run_employee_summary(ctx) -> ReportResult:
    now_dt = C.now()
    today = C.ist_date(now_dt)
    p = ctx.params
    rows_qs = (
        _values_qs(ctx)
        .filter(C.in_range("created_at", ctx))
        .filter(C.pass_type_q(p.get("passType")))
        .values(*STAT_FIELDS)
    )
    per_emp: dict[int, _Stats] = {}
    _feed(lambda row: per_emp.setdefault(row["employee_id"], _Stats()), rows_qs, now_dt, today)

    include_zero = bool(p.get("includeZero"))
    if include_zero:
        emp_qs = Employee.objects.filter(ctx.emp_q())
    else:
        emp_qs = Employee.objects.filter(id__in=list(per_emp))
    emps = {
        e.id: e
        for e in emp_qs.select_related("department", "designation").defer("photo_url", "id_proof", "address", "password_hash")
    }
    qr_counts = dict(
        OutpassRecord.objects.filter(source="qr", employee__isnull=False)
        .filter(ctx.emp_q("employee__"))
        .filter(C.in_range("submitted_at", ctx))
        .order_by()
        .values_list("employee_id")
        .annotate(n=Count("id"))
    )
    threshold = 0 if include_zero else max(1, int(p.get("minPasses") or 1))

    rows, all_outside, per_person = [], [], []
    for emp_id, emp in emps.items():
        s = per_emp.get(emp_id) or _Stats()
        if s.requests < threshold:
            continue
        all_outside.extend(s.outside)
        rows.append({
            **emp_cells(emp),
            "requests": s.requests, "approved": s.approved, "rejected": s.rejected, "pending": s.pending,
            "exited": s.exited, "returned": s.returned, "notReturned": s.open,
            "expiredUnused": s.expired_unused, "official": s.official, "personal": s.personal,
            "earlyDismissal": s.early, "unspecified": s.unspecified,
            "totalOutsideMinutes": s.total_outside, "avgOutsideMinutes": s.avg_outside,
            "maxOutsideMinutes": s.max_outside, "lateReturns": s.late,
            "qrSubmissions": qr_counts.get(emp_id, 0),
        })
        per_person.append((f"{emp.employee_code} {emp.first_name}".strip(), s))
    rows.sort(key=lambda r: (-r["requests"], r["employeeCode"]))

    totals = C.sum_totals(rows, [
        "requests", "approved", "rejected", "pending", "exited", "returned", "notReturned", "expiredUnused",
        "official", "personal", "earlyDismissal", "unspecified", "lateReturns", "qrSubmissions",
    ])
    totals["totalOutsideMinutes"] = sum(all_outside) if all_outside else None
    totals["avgOutsideMinutes"] = C.mean_minutes(all_outside)
    totals["maxOutsideMinutes"] = max(all_outside) if all_outside else None

    top_passes = C.top([(name, s.requests) for name, s in per_person])
    top_minutes = C.top([(name, s.total_outside or 0) for name, s in per_person])
    summary = [
        {"label": "Employees with a pass", "value": sum(1 for r in rows if r["requests"] > 0), "format": "integer"},
        {"label": "Total requests", "value": totals["requests"], "format": "integer"},
        {"label": "Approved", "value": totals["approved"], "format": "integer"},
        {"label": "Rejected", "value": totals["rejected"], "format": "integer"},
        {"label": "Total time outside", "value": totals["totalOutsideMinutes"], "format": "duration"},
        {"label": "Avg per returned pass", "value": totals["avgOutsideMinutes"], "format": "duration"},
    ]
    notes = _sorted_notes(
        NOTE_TIMES,
        NOTE_NO_PAYROLL,
        "Counts cover requests created in the selected dates. Time outside, average and longest use returned "
        "passes only. Not Returned excludes early-shift-dismissal passes (they are not expected back).",
        "Late Returns count passes that came back (or are outside today) after their expected return time; passes "
        "without an expected return time are never counted as late.",
        "QR Submissions are anonymous gate-form exits matched to the employee by code. They are shown separately "
        "and never added to the pass counts; submissions that match no employee appear in the Gate QR Submissions report.",
        "Employees with no passes are hidden unless 'Include employees with no passes' is on.",
        ("Most passes: " + "; ".join(f"{n} ({v})" for n, v in top_passes) + ".") if top_passes else None,
        ("Most time outside: " + "; ".join(f"{n} ({minutes_text(v)})" for n, v in top_minutes) + ".")
        if top_minutes else None,
    )
    return ReportResult(rows=rows, totals=totals, summary=summary, notes=notes)


register(ReportSpec(
    id="outpass-employee-summary",
    title="Outpass Summary by Employee",
    description="Per employee: passes requested, approved, used and returned, time outside and late returns.",
    category="gate",
    icon="UserRound",
    tags=("outpass", "employee", "summary", "counts", "frequent", "time outside"),
    family="outpass",
    variant="By Employee",
    modules=MODULES,
    filters=(
        C.dates("Requested between", "the date the pass was requested"),
        *scope(status="all"),
        C.pass_type_filter(),
        select("minPasses", "Minimum passes", _MIN_PASSES, placeholder="Any (at least 1)",
               help="Only employees with at least this many requests. Ignored when employees with no passes are included."),
        boolean("includeZero", "Include employees with no passes"),
    ),
    columns=EMPLOYEE_SUMMARY_COLUMNS,
    run=_run_employee_summary,
))


# ── 4. outpass-department-summary ───────────────────────────────────────────

DEPT_SUMMARY_COLUMNS = (
    ColumnSpec("group", "Group", TEXT, 2.2),
    ColumnSpec("branch", "Branch", TEXT, 1.4),
    ColumnSpec("headcount", "Active Headcount", INTEGER, 1.0, total="sum"),
    ColumnSpec("employeesWithPass", "Employees With Pass", INTEGER, 1.1, total="sum"),
    ColumnSpec("requests", "Requests", INTEGER, 0.9, total="sum"),
    ColumnSpec("approved", "Approved", INTEGER, 0.9, total="sum"),
    ColumnSpec("rejected", "Rejected", INTEGER, 0.9, total="sum"),
    ColumnSpec("exited", "Exited", INTEGER, 0.8, total="sum"),
    ColumnSpec("returned", "Returned", INTEGER, 0.9, total="sum"),
    ColumnSpec("notReturned", "Not Returned", INTEGER, 1.0, total="sum"),
    ColumnSpec("totalOutsideMinutes", "Total Outside", DURATION, 1.0),
    ColumnSpec("avgOutsideMinutes", "Avg / Pass", DURATION, 0.9),
    ColumnSpec("passesPer100", "Passes per 100 Staff", NUMBER, 1.1),
)
_GROUP_OPTIONS = (
    ("department", "Department"), ("branch", "Branch"), ("employmentType", "Staff / Production"),
    ("passType", "Pass type"),
)
_GROUP_TITLE = {"department": "Department", "branch": "Branch", "employmentType": "Employee type", "passType": "Pass type"}


def _run_department_summary(ctx) -> ReportResult:
    now_dt = C.now()
    today = C.ist_date(now_dt)
    group = ctx.param("groupBy", "department")
    rows_qs = _values_qs(ctx).filter(C.in_range("created_at", ctx)).values(
        *STAT_FIELDS, "employee__department_id", "employee__branch_id", "employee__employment_type"
    )
    key_field = {
        "department": "employee__department_id", "branch": "employee__branch_id",
        "employmentType": "employee__employment_type", "passType": "pass_type",
    }[group]

    def key_of(row):
        return (row[key_field] or None) if group == "passType" else row[key_field]

    stats: dict = {}
    _feed(lambda row: stats.setdefault(key_of(row), _Stats()), rows_qs, now_dt, today)

    headcount: dict = {}
    if group != "passType":
        hc_field = {"department": "department_id", "branch": "branch_id", "employmentType": "employment_type"}[group]
        for r in (
            Employee.objects.filter(ctx.emp_q(), status="active").order_by().values(hc_field).annotate(n=Count("id"))
        ):
            headcount[r[hc_field]] = r["n"]

    keys = set(stats) | set(headcount)
    names = _group_names(group, keys)
    rows, all_outside = [], []
    for k in keys:
        s = stats.get(k) or _Stats()
        hc = headcount.get(k) if group != "passType" else None
        label, branch = names.get(k, (str(k), None))
        all_outside.extend(s.outside)
        rows.append({
            "group": label, "branch": branch,
            "headcount": hc if group != "passType" else None,
            "employeesWithPass": len(s.employees),
            "requests": s.requests, "approved": s.approved, "rejected": s.rejected,
            "exited": s.exited, "returned": s.returned, "notReturned": s.open,
            "totalOutsideMinutes": s.total_outside, "avgOutsideMinutes": s.avg_outside,
            "passesPer100": r2(s.requests * 100 / hc) if hc else None,
        })
    rows.sort(key=lambda r: (-r["requests"], r["group"], r["branch"] or ""))

    totals = C.sum_totals(rows, [
        "headcount", "employeesWithPass", "requests", "approved", "rejected", "exited", "returned", "notReturned",
    ])
    totals["totalOutsideMinutes"] = sum(all_outside) if all_outside else None
    totals["avgOutsideMinutes"] = C.mean_minutes(all_outside)
    total_hc = totals["headcount"]
    totals["passesPer100"] = r2(totals["requests"] * 100 / total_hc) if total_hc else None

    busiest = C.top([(r["group"], r["requests"]) for r in rows], 1)
    longest = C.top([(r["group"], r["totalOutsideMinutes"] or 0) for r in rows], 1)
    summary = [
        {"label": "Total requests", "value": totals["requests"], "format": "integer"},
        {"label": "Employees with a pass", "value": totals["employeesWithPass"], "format": "integer"},
        {"label": "Total time outside", "value": totals["totalOutsideMinutes"], "format": "duration"},
        _text_summary("Most passes", f"{busiest[0][0]} ({busiest[0][1]})" if busiest else None),
        _text_summary("Most time outside", f"{longest[0][0]} ({minutes_text(longest[0][1])})" if longest else None),
    ]
    notes = _sorted_notes(
        NOTE_TIMES,
        NOTE_NO_PAYROLL,
        f"Grouped by {_GROUP_TITLE[group].lower()}. Departments are keyed by id (the same name can exist in several "
        "branches) and shown with their branch.",
        "Headcount is today's number of ACTIVE employees, not a historical figure, so passes per 100 staff for an old "
        "period is only indicative. Employees with no department are grouped as No Department.",
        None if group != "passType" else "Headcount is not available when grouping by pass type.",
        "Time outside and average use returned passes only. Not Returned excludes early-shift-dismissal passes.",
    )
    return ReportResult(rows=rows, totals=totals, summary=summary, notes=notes)


def _group_names(group: str, keys) -> dict:
    """{key: (label, branch name)} for the group keys, loading each lookup once."""
    if group == "department":
        ids = [k for k in keys if k is not None]
        out = {
            d.id: (d.name, d.branch.name if d.branch_id else None)
            for d in Department.objects.filter(id__in=ids).select_related("branch")
        }
        out[None] = ("No Department", None)
        return out
    if group == "branch":
        ids = [k for k in keys if k is not None]
        out = {b.id: (b.name, None) for b in Branch.objects.filter(id__in=ids)}
        out[None] = ("No Branch", None)
        return out
    if group == "employmentType":
        return {"staff": ("Staff", None), "production": ("Production", None), None: ("Not set", None)}
    return {None: ("Unspecified", None), **{k: (C.pass_type_label(k), None) for k in keys if k}}


register(ReportSpec(
    id="outpass-department-summary",
    title="Outpass Summary by Department",
    description="Passes and time outside per department, branch, staff type or pass type, against headcount.",
    category="gate",
    icon="Building2",
    tags=("outpass", "department", "summary", "counts", "headcount", "branch"),
    family="outpass",
    variant="By Department",
    modules=MODULES,
    filters=(
        C.dates("Requested between", "the date the pass was requested"),
        *scope(designation=False, employee=False, status=None),
        select("groupBy", "Group by", _GROUP_OPTIONS, default="department", placeholder="Department"),
    ),
    columns=DEPT_SUMMARY_COLUMNS,
    run=_run_department_summary,
))


# ── 5. outpass-not-returned ─────────────────────────────────────────────────

NOT_RETURNED_COLUMNS = (
    *EMP_COLS,
    ColumnSpec("phone", "Phone", TEXT, 1.2),
    ColumnSpec("passType", "Pass Type", BADGE, 1.1),
    ColumnSpec("destination", "Destination", TEXT, 1.8),
    ColumnSpec("reason", "Reason", TEXT, 1.8),
    ColumnSpec("exitGate", "Exit Gate", TEXT, 1.0),
    ColumnSpec("exitedAt", "Exit Time", DATETIME, 1.4),
    ColumnSpec("minutesOutside", "Outside So Far", DURATION, 1.0),
    ColumnSpec("expectedReturnAt", "Expected Return", DATETIME, 1.4),
    ColumnSpec("overdueMinutes", "Overdue By", DURATION, 1.0),
    ColumnSpec("returnQrState", "Return QR", BADGE, 1.0),
    ColumnSpec("reviewedBy", "Approved By", TEXT, 1.5),
    ColumnSpec("bucket", "Status", BADGE, 1.1),
)
_MIN_OUTSIDE = (("30", "30 minutes"), ("60", "1 hour"), ("120", "2 hours"), ("240", "4 hours"))


def _run_not_returned(ctx) -> ReportResult:
    now_dt = C.now()
    today = C.ist_date(now_dt)
    p = ctx.params
    qs = (
        _request_qs(ctx)
        .filter(exited_at__isnull=False, entered_at__isnull=True)
        .filter(C.in_range("exited_at", ctx))
        .filter(C.pass_type_q(p.get("passType")))
    )
    if not p.get("includeEarlyDismissal"):
        qs = qs.exclude(pass_type="early_dismissal")
    min_out = int(p.get("minOutsideMinutes") or 0)
    if min_out:
        # "Outside at least N min" compares whole minutes (halves up); the half-minute of slack keeps SQL and Python equal.
        qs = qs.filter(exited_at__lte=now_dt - timedelta(minutes=min_out) + timedelta(seconds=30))

    built, past_expected = [], 0
    for req in qs.order_by("-exited_at", "-id")[: ctx.row_limit]:
        state = C.pass_state(req, now_dt, today)
        running = C.minutes_between(req.exited_at, now_dt)
        if min_out and (running or 0) < min_out:
            continue
        outside_now = state in C.OUTSIDE_STATES
        overrun = C.overrun_minutes(req, state, now_dt)
        if req.expected_return_at and now_dt > req.expected_return_at:
            past_expected += 1
        emp = emp_cells(req.employee)
        built.append((0 if outside_now else 1, req.exited_at, {
            **emp,
            "phone": C.clean(req.employee.phone, 40),
            "passType": C.pass_type_label(req.pass_type),
            "destination": C.clean(req.destination),
            "reason": C.clean(req.reason),
            "exitGate": req.exit_gate.name if req.exit_gate_id else None,
            "exitedAt": C.fmt(req.exited_at),
            # Only a pass that left today has a meaningful running time; an old open row must never look live.
            "minutesOutside": running if outside_now else None,
            "expectedReturnAt": C.fmt(req.expected_return_at),
            "overdueMinutes": overrun if (outside_now and C.is_late(overrun)) else None,
            "returnQrState": C.return_qr_state(req, now_dt),
            "reviewedBy": C.reviewer_text(req.approver_role, req.approved_by),
            "bucket": C.movement_label(state),
        }))
    built.sort(key=lambda b: (b[0], -b[1].timestamp()))
    rows = [b[2] for b in built]

    outside_now_n = sum(1 for b in built if b[0] == 0)
    stamp = now_dt.astimezone(C.FACTORY_TZ).strftime("%Y-%m-%d %H:%M")
    summary = [
        {"label": "Outside now (exited today)", "value": outside_now_n, "format": "integer"},
        {"label": "Return never recorded (earlier days)", "value": len(built) - outside_now_n, "format": "integer"},
        {"label": "Past expected return time", "value": past_expected, "format": "integer"},
        {"label": "Report as of (IST)", "value": stamp, "format": "datetime"},
    ]
    notes = _sorted_notes(
        f"Snapshot as of {stamp} IST: who is outside and for how long depend on the moment the report is run.",
        "Outside Now = scanned out today and not yet scanned back. Not Returned = scanned out on an earlier day with no "
        "return scan; no running duration is shown for those because they are not live.",
        None if p.get("includeEarlyDismissal") else
        "Early-shift-dismissal passes are excluded (those employees are not expected back); tick 'Include early "
        "dismissals' to list them.",
        "Phone is the employee's number on file and may be blank. Return QR shows whether the employee generated a "
        "return QR (valid for 60 minutes).",
        NOTE_TIMES,
        C.truncated_note(ctx, len(built)),
    )
    return ReportResult(rows=rows, summary=summary, notes=notes)


register(ReportSpec(
    id="outpass-not-returned",
    title="Outpass Not Returned",
    description="Passes scanned out at a gate with no return scan: who is outside now and whose return was never recorded.",
    category="gate",
    icon="LogOut",
    tags=("outpass", "not returned", "outside", "still out", "currently out", "missing return"),
    modules=MODULES,
    filters=(
        C.dates("Exited between", "the time of the exit scan"),
        *scope(status=None),
        C.pass_type_filter(),
        select("minOutsideMinutes", "Outside at least", _MIN_OUTSIDE, placeholder="Any time"),
        boolean("includeEarlyDismissal", "Include early dismissals"),
    ),
    columns=NOT_RETURNED_COLUMNS,
    run=_run_not_returned,
))


# ── 6. outpass-late-return ──────────────────────────────────────────────────

LATE_RETURN_COLUMNS = (
    *EMP_COLS_SHORT,
    ColumnSpec("passType", "Pass Type", BADGE, 1.1),
    ColumnSpec("destination", "Destination", TEXT, 1.8),
    ColumnSpec("exitedAt", "Exit Time", DATETIME, 1.4),
    ColumnSpec("expectedReturnAt", "Expected Return", DATETIME, 1.4),
    ColumnSpec("enteredAt", "Returned At", DATETIME, 1.4),
    ColumnSpec("overrunMinutes", "Late By", DURATION, 1.0, total="sum"),
    ColumnSpec("state", "State", BADGE, 1.1),
    ColumnSpec("reviewedBy", "Approved By", TEXT, 1.5),
)
_MIN_OVERRUN = (("10", "10 minutes"), ("15", "15 minutes"), ("30", "30 minutes"), ("60", "1 hour"))


def _run_late_return(ctx) -> ReportResult:
    now_dt = C.now()
    today = C.ist_date(now_dt)
    p = ctx.params
    min_over = max(1, int(p.get("minOverrunMinutes") or 1))
    qs = (
        _request_qs(ctx)
        .filter(expected_return_at__isnull=False, exited_at__isnull=False)
        .filter(C.in_range("exited_at", ctx))
        .filter(Q(entered_at__isnull=True) | Q(entered_at__gt=F("expected_return_at")))
        .order_by("-exited_at", "-id")
    )
    rows, per_emp, skipped = [], Counter(), 0
    for req in qs:
        state = C.pass_state(req, now_dt, today)
        over = C.overrun_minutes(req, state, now_dt)
        if over is None:
            skipped += 1  # left on an earlier day (or an early dismissal) and never scanned back: nothing to measure
            continue
        if over < min_over:
            continue
        emp = emp_cells(req.employee)
        rows.append({
            "employeeCode": emp["employeeCode"], "employeeName": emp["employeeName"], "department": emp["department"],
            "passType": C.pass_type_label(req.pass_type),
            "destination": C.clean(req.destination),
            "exitedAt": C.fmt(req.exited_at),
            "expectedReturnAt": C.fmt(req.expected_return_at),
            "enteredAt": C.fmt(req.entered_at),
            "overrunMinutes": over,
            "state": "Returned Late" if req.entered_at else "Outside Now",
            "reviewedBy": C.reviewer_text(req.approver_role, req.approved_by),
        })
        per_emp[emp["employeeCode"]] += 1
        if len(rows) >= ctx.row_limit:
            break

    overs = [r["overrunMinutes"] for r in rows]
    repeat = sum(1 for n in per_emp.values() if n >= 3)
    summary = [
        {"label": "Late returns", "value": len(rows), "format": "integer"},
        {"label": "Average overrun", "value": C.mean_minutes(overs), "format": "duration"},
        {"label": "Longest overrun", "value": max(overs) if overs else None, "format": "duration"},
        {"label": "Employees with 3+ late returns", "value": repeat, "format": "integer"},
    ]
    notes = _sorted_notes(
        NOTE_TIMES,
        "Expected return time is optional and informational (it never affects pass validity): passes without one - "
        "including every On-Duty pass - cannot appear here.",
        "Late By is the minutes between the expected return and the return scan (or, for someone still outside today, "
        "up to now). A return within 30 seconds of the expected time is not counted as late.",
        (f"{skipped} pass(es) with an expected return time were scanned out on an earlier day (or are early dismissals) "
         "and never scanned back; they have no measurable overrun - see the Outpass Not Returned report.")
        if skipped else None,
        "If the mobile or web app ever sent the expected time without a time zone, it would be stored 5h30m off; treat "
        "small overruns as indicative.",
        NOTE_NO_PAYROLL,
        C.truncated_note(ctx, len(rows)),
    )
    return ReportResult(rows=rows, summary=summary, notes=notes)


register(ReportSpec(
    id="outpass-late-return",
    title="Outpass Late Returns",
    description="Employees who came back after the return time they gave on the pass, and by how much.",
    category="gate",
    icon="Timer",
    tags=("outpass", "late return", "overrun", "expected return", "overstay"),
    modules=MODULES,
    filters=(
        C.dates("Exited between", "the time of the exit scan"),
        *scope(designation=False, status=None),
        select("minOverrunMinutes", "Late by at least", _MIN_OVERRUN, placeholder="Any (1 minute or more)"),
    ),
    columns=LATE_RETURN_COLUMNS,
    run=_run_late_return,
))


# ── 7. outpass-approval-turnaround ──────────────────────────────────────────

TURNAROUND_COLUMNS = (
    ColumnSpec("approverName", "Approver", TEXT, 2.2),
    ColumnSpec("approverRole", "Role", BADGE, 1.1),
    ColumnSpec("decisions", "Decisions", INTEGER, 0.9, total="sum"),
    ColumnSpec("approved", "Approved", INTEGER, 0.9, total="sum"),
    ColumnSpec("rejected", "Rejected", INTEGER, 0.9, total="sum"),
    ColumnSpec("avgTurnaroundMinutes", "Avg Turnaround", DURATION, 1.1),
    ColumnSpec("maxTurnaroundMinutes", "Slowest", DURATION, 1.0),
    ColumnSpec("within15MinPct", "Approved Within 15 Min", PERCENT, 1.2),
)


def _run_turnaround(ctx) -> ReportResult:
    p = ctx.params
    base = _values_qs(ctx).filter(C.in_range("created_at", ctx), source="manual")
    decided = base.filter(status__in=("approved", "rejected"))
    if p.get("reviewerRole"):
        decided = decided.filter(approver_role=p["reviewerRole"])

    groups: dict[tuple[str, str], dict] = {}
    all_turn: list[float] = []
    for r in decided.values("status", "approver_role", "approved_by", "created_at", "approved_at"):
        key = (r["approver_role"] or "", (r["approved_by"] or "").strip())
        g = groups.setdefault(key, {"approved": 0, "rejected": 0, "turn": []})
        g[r["status"]] += 1
        if r["status"] == "approved" and r["approved_at"]:
            secs = max(0.0, (r["approved_at"] - r["created_at"]).total_seconds())
            g["turn"].append(secs)
            all_turn.append(secs)

    def stats(turns):
        if not turns:
            return None, None, None
        within = sum(1 for t in turns if t <= 15 * 60)
        return (
            C.half_up_minutes(sum(turns) / len(turns)), C.half_up_minutes(max(turns)),
            r2(within * 100 / len(turns)),
        )

    rows = []
    for (role, name), g in groups.items():
        avg, mx, pct = stats(g["turn"])
        rows.append({
            "approverName": name or "Unknown", "approverRole": C.role_label(role),
            "decisions": g["approved"] + g["rejected"], "approved": g["approved"], "rejected": g["rejected"],
            "avgTurnaroundMinutes": avg, "maxTurnaroundMinutes": mx, "within15MinPct": pct,
        })
    rows.sort(key=lambda r: (-r["decisions"], r["approverName"], r["approverRole"] or ""))

    avg_all, max_all, pct_all = stats(all_turn)
    totals = C.sum_totals(rows, ["decisions", "approved", "rejected"])
    totals.update({"avgTurnaroundMinutes": avg_all, "maxTurnaroundMinutes": max_all, "within15MinPct": pct_all})
    backlog = base.filter(status="pending").count()
    over_60 = sum(1 for t in all_turn if t > 60 * 60)
    summary = [
        {"label": "Decisions", "value": totals["decisions"], "format": "integer"},
        {"label": "Avg turnaround (approvals)", "value": avg_all, "format": "duration"},
        {"label": "Approved within 15 min", "value": pct_all, "format": "percent"},
        {"label": "Approved after 60+ min", "value": over_60, "format": "integer"},
        {"label": "Still pending", "value": backlog, "format": "integer"},
    ]
    notes = _sorted_notes(
        NOTE_TIMES,
        "Manual requests only: On-Duty passes are created already approved by the system, so they have no approval wait.",
        "Turnaround = approval time minus request time, for approvals only. A rejection stores no decision time, so "
        "rejections count as decisions but are left out of turnaround. When a decision is later changed the last one "
        "wins.",
        "A pass is scannable for 60 minutes after approval, so an approval that took over an hour usually means the "
        "requester could not use the pass window in time.",
        "Approvers are identified by the display name saved on the request; two people with the same name are merged.",
        "Still pending counts manual requests in the selected dates that have no decision yet (see Pending Outpass "
        "Requests for the list).",
    )
    return ReportResult(rows=rows, totals=totals, summary=summary, notes=notes)


register(ReportSpec(
    id="outpass-approval-turnaround",
    title="Outpass Approval Turnaround",
    description="How quickly HR and department heads decide outpass requests, with the approve / reject mix per approver.",
    category="gate",
    icon="BadgeCheck",
    tags=("outpass", "approval", "turnaround", "approver", "hod", "hr", "sla"),
    modules=MODULES,
    filters=(
        C.dates("Requested between", "the date the pass was requested"),
        *scope(designation=False, status=None),
        select("reviewerRole", "Reviewed by", (("hr", "HR"), ("dept_head", "Department head")), placeholder="Anyone"),
    ),
    columns=TURNAROUND_COLUMNS,
    run=_run_turnaround,
))


# ── 8. outpass-pending-requests ─────────────────────────────────────────────

PENDING_COLUMNS = (
    ColumnSpec("requestedAt", "Requested", DATETIME, 1.4),
    ColumnSpec("ageMinutes", "Waiting", DURATION, 1.0),
    ColumnSpec("ageBand", "Age", BADGE, 1.1),
    *EMP_COLS_SHORT,
    ColumnSpec("passType", "Pass Type", BADGE, 1.1),
    ColumnSpec("destination", "Destination", TEXT, 1.8),
    ColumnSpec("reason", "Reason", TEXT, 1.8),
    ColumnSpec("expectedReturnAt", "Expected Return", DATETIME, 1.4),
    ColumnSpec("reportingManager", "Reporting Manager", TEXT, 1.6),
)
_MIN_AGE = (("30", "30 minutes"), ("60", "1 hour"), ("240", "4 hours"), ("1440", "1 day"))


def _age_band(minutes: int) -> str:
    if minutes < 60:
        return "Under 1 Hour"
    if minutes < 240:
        return "1 - 4 Hours"
    if minutes <= 24 * 60:
        return "4 - 24 Hours"
    return "Overdue"


def _run_pending(ctx) -> ReportResult:
    now_dt = C.now()
    min_age = int(ctx.param("minAge") or 0)
    base = OutpassRequest.objects.filter(ctx.emp_q("employee__"), status="pending")
    qs = (
        base.filter(C.in_range("created_at", ctx))
        .select_related("employee__department", "employee__designation", "employee__reporting_manager")
        .defer(*C.EMP_DEFER, "employee__reporting_manager__photo_url", "employee__reporting_manager__id_proof",
               "employee__reporting_manager__address", "employee__reporting_manager__password_hash")
        .order_by("created_at", "id")
    )
    if min_age:
        qs = qs.filter(created_at__lte=now_dt - timedelta(minutes=min_age) + timedelta(seconds=30))
    rows, ages = [], []
    for req in qs[: ctx.row_limit]:
        age = C.minutes_between(req.created_at, now_dt) or 0
        if age < min_age:
            continue
        emp = emp_cells(req.employee)
        mgr = req.employee.reporting_manager
        rows.append({
            "requestedAt": C.fmt(req.created_at), "ageMinutes": age, "ageBand": _age_band(age),
            "employeeCode": emp["employeeCode"], "employeeName": emp["employeeName"], "department": emp["department"],
            "passType": C.pass_type_label(req.pass_type),
            "destination": C.clean(req.destination), "reason": C.clean(req.reason),
            "expectedReturnAt": C.fmt(req.expected_return_at),
            "reportingManager": f"{mgr.first_name} {mgr.last_name}".strip() if mgr else None,
        })
        ages.append(age)

    start, _end = C.ist_bounds(ctx)
    older = base.filter(created_at__lt=start).count() if start else 0
    stamp = now_dt.astimezone(C.FACTORY_TZ).strftime("%Y-%m-%d %H:%M")
    summary = [
        {"label": "Pending requests", "value": len(rows), "format": "integer"},
        {"label": "Oldest waiting", "value": max(ages) if ages else None, "format": "duration"},
        {"label": "Waiting over 1 day", "value": sum(1 for a in ages if a > 24 * 60), "format": "integer"},
        {"label": "Report as of (IST)", "value": stamp, "format": "datetime"},
    ]
    notes = _sorted_notes(
        f"Snapshot as of {stamp} IST: waiting time is measured up to that moment.",
        "A pending request never expires by itself. One waiting more than a day is marked Overdue - the outing it "
        "asked for has almost certainly passed.",
        (f"{older} more pending request(s) were created before the selected dates; widen the range to list them.")
        if older else None,
        "Reporting Manager is the manager on the employee's record (the approver may be the department head or HR).",
        NOTE_TIMES,
        C.truncated_note(ctx, len(rows)),
    )
    return ReportResult(rows=rows, summary=summary, notes=notes)


register(ReportSpec(
    id="outpass-pending-requests",
    title="Pending Outpass Requests",
    description="Outpass requests still waiting for a decision and how long each has waited.",
    category="gate",
    icon="Hourglass",
    tags=("outpass", "pending", "awaiting approval", "ageing", "backlog"),
    modules=MODULES,
    filters=(
        C.dates("Requested between", "the date the pass was requested"),
        *scope(designation=False, status=None),
        select("minAge", "Waiting at least", _MIN_AGE, placeholder="Any time"),
    ),
    columns=PENDING_COLUMNS,
    run=_run_pending,
))


# ── 9. outpass-expired-unused ───────────────────────────────────────────────

EXPIRED_COLUMNS = (
    *EMP_COLS_SHORT,
    ColumnSpec("passType", "Pass Type", BADGE, 1.1),
    ColumnSpec("source", "Origin", BADGE, 0.9),
    ColumnSpec("destination", "Destination", TEXT, 1.8),
    ColumnSpec("approvedAt", "Approved At", DATETIME, 1.4),
    ColumnSpec("expiredAt", "Expired At", DATETIME, 1.4),
    ColumnSpec("reviewedBy", "Approved By", TEXT, 1.5),
    ColumnSpec("reviewerRole", "Role", BADGE, 1.0),
)


def _run_expired_unused(ctx) -> ReportResult:
    now_dt = C.now()
    today = C.ist_date(now_dt)
    p = ctx.params
    origin = p.get("source") or "manual"
    base = (
        _request_qs(ctx)
        .filter(status="approved", approved_at__isnull=False)
        .filter(C.in_range("approved_at", ctx))
    )
    if origin != "all":
        base = base.filter(source=origin)
    if p.get("reviewerRole"):
        base = base.filter(approver_role=p["reviewerRole"])
    approved_total = base.count()
    candidates = base.filter(exited_at__isnull=True, approved_at__lte=now_dt - C.PASS_VALID).order_by("-approved_at", "-id")

    rows = []
    for req in candidates:
        if C.pass_state(req, now_dt, today) != "expired_unscanned":
            continue
        emp = emp_cells(req.employee)
        rows.append({
            "employeeCode": emp["employeeCode"], "employeeName": emp["employeeName"], "department": emp["department"],
            "passType": C.pass_type_label(req.pass_type), "source": C.source_label(req.source),
            "destination": C.clean(req.destination),
            "approvedAt": C.fmt(req.approved_at), "expiredAt": C.fmt(req.approved_at + C.PASS_VALID),
            "reviewedBy": C.reviewer_text(req.approver_role, req.approved_by),
            "reviewerRole": C.role_label(req.approver_role),
        })
        if len(rows) >= ctx.row_limit:
            break

    n = len(rows)
    by_origin = Counter(r["source"] for r in rows)
    summary = [
        {"label": "Approved but never used", "value": n, "format": "integer"},
        {"label": "Approved passes in period", "value": approved_total, "format": "integer"},
        {"label": "Share never used", "value": r2(n * 100 / approved_total) if approved_total else None, "format": "percent"},
    ]
    notes = _sorted_notes(
        NOTE_TIMES,
        "Lists approved passes whose 60-minute exit window closed without a gate scan, so no exit was recorded. "
        "Passes approved less than 60 minutes ago are still valid and are not listed.",
        "Approved passes in period counts every pass approved in the selected dates (used, unused and still valid) "
        "within the chosen origin, so the share is a rough guide, not a leakage rate.",
        "On-Duty passes are created automatically when an On-Duty session is finally approved and are often never "
        "scanned; that is why the default origin is Manual. Choose All to include them."
        if origin == "manual" else None,
        _counts_line("By origin", by_origin),
        C.truncated_note(ctx, n),
    )
    return ReportResult(rows=rows, summary=summary, notes=notes)


register(ReportSpec(
    id="outpass-expired-unused",
    title="Approved but Unused Outpasses",
    description="Approved passes whose 60-minute exit window lapsed without a gate scan.",
    category="gate",
    icon="TriangleAlert",
    tags=("outpass", "expired", "unused", "not scanned", "approved not used"),
    modules=MODULES,
    filters=(
        C.dates("Approved between", "the approval time"),
        *scope(designation=False, status=None),
        select(
            "source", "Origin", (("manual", "Manual requests"), ("on_duty", "On-Duty passes"), ("all", "All origins")),
            default="manual",
        ),
        select("reviewerRole", "Approved by", ROLE_OPTIONS, placeholder="Anyone"),
    ),
    columns=EXPIRED_COLUMNS,
    run=_run_expired_unused,
))


# ── 10. outpass-purpose-analysis ────────────────────────────────────────────

PURPOSE_COLUMNS = (
    ColumnSpec("passType", "Pass Type", BADGE, 1.4),
    ColumnSpec("origin", "Origin", BADGE, 1.0),
    ColumnSpec("requests", "Requests", INTEGER, 0.9, total="sum"),
    ColumnSpec("approved", "Approved", INTEGER, 0.9, total="sum"),
    ColumnSpec("rejected", "Rejected", INTEGER, 0.9, total="sum"),
    ColumnSpec("pending", "Pending", INTEGER, 0.9, total="sum"),
    ColumnSpec("approvalRatePct", "Approval Rate", PERCENT, 1.0),
    ColumnSpec("returned", "Returned", INTEGER, 0.9, total="sum"),
    ColumnSpec("avgOutsideMinutes", "Avg Outside", DURATION, 1.0),
    ColumnSpec("totalOutsideMinutes", "Total Outside", DURATION, 1.0),
    ColumnSpec("sharePct", "Share of Requests", PERCENT, 1.0),
)


def _run_purpose(ctx) -> ReportResult:
    now_dt = C.now()
    today = C.ist_date(now_dt)
    rows_qs = _values_qs(ctx).filter(C.in_range("created_at", ctx)).values(*STAT_FIELDS)
    stats: dict[tuple, _Stats] = {}
    _feed(lambda row: stats.setdefault((row["pass_type"] or None, row["source"]), _Stats()), rows_qs, now_dt, today)

    total_requests = sum(s.requests for s in stats.values())
    rows, all_outside = [], []
    for (pt, src), s in stats.items():
        decided = s.approved + s.rejected
        all_outside.extend(s.outside)
        rows.append({
            "passType": C.pass_type_label(pt), "origin": C.source_label(src),
            "requests": s.requests, "approved": s.approved, "rejected": s.rejected, "pending": s.pending,
            "approvalRatePct": r2(s.approved * 100 / decided) if decided else None,
            "returned": s.returned, "avgOutsideMinutes": s.avg_outside, "totalOutsideMinutes": s.total_outside,
            "sharePct": r2(s.requests * 100 / total_requests) if total_requests else None,
        })
    rows.sort(key=lambda r: (-r["requests"], r["passType"], r["origin"] or ""))

    totals = C.sum_totals(rows, ["requests", "approved", "rejected", "pending", "returned"])
    decided_all = totals["approved"] + totals["rejected"] if totals["requests"] else 0
    totals["approvalRatePct"] = r2(totals["approved"] * 100 / decided_all) if decided_all else None
    totals["totalOutsideMinutes"] = sum(all_outside) if all_outside else None
    totals["avgOutsideMinutes"] = C.mean_minutes(all_outside)
    totals["sharePct"] = 100.0 if total_requests else None

    by_type = Counter()
    for r in rows:
        by_type[r["passType"]] += r["requests"]
    common = C.top(list(by_type.items()), 1)
    summary = [
        {"label": "Total requests", "value": total_requests, "format": "integer"},
        _text_summary("Most common pass type", f"{common[0][0]} ({common[0][1]})" if common else None),
        {"label": "Overall approval rate", "value": totals["approvalRatePct"], "format": "percent"},
        {"label": "Total time outside", "value": totals["totalOutsideMinutes"], "format": "duration"},
    ]
    notes = _sorted_notes(
        NOTE_TIMES,
        "Grouped by pass type and origin only; destination and reason are free text and are deliberately not grouped. "
        "On-Duty passes carry no pass type, so they always fall under Unspecified.",
        "Approval rate = approved / (approved + rejected); requests still pending are left out of the rate. Time "
        "outside uses returned passes only.",
        NOTE_NO_PAYROLL,
    )
    return ReportResult(rows=rows, totals=totals, summary=summary, notes=notes)


register(ReportSpec(
    id="outpass-purpose-analysis",
    title="Outpass Purpose Analysis",
    description="Passes by pass type and origin: volume, approval rate and time outside.",
    category="gate",
    icon="PieChart",
    tags=("outpass", "purpose", "pass type", "analysis", "official", "personal", "approval rate"),
    modules=MODULES,
    filters=(
        C.dates("Requested between", "the date the pass was requested"),
        *scope(designation=False, employee=False, status=None),
    ),
    columns=PURPOSE_COLUMNS,
    run=_run_purpose,
))

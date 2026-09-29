"""Gate-side reports (group G8, category "gate"): the anonymous QR outpass submissions, the raw gate-scan
audit, per-gate throughput and the one-row-per-day gate summary.

None of these models has a plain branch column the way Employee does, so each report states how it scopes a
branch-limited user (see ``gate_outpass_common``): QR submissions by the QR's own branch, scans by gate OR
employee branch (rows that cannot be attributed stay with unscoped users), the daily summary by each source's
own branch link. Gate data never influences attendance, payroll or leave.
"""

from __future__ import annotations

from collections import Counter, defaultdict
from datetime import timedelta

from django.db.models import Count, DurationField, ExpressionWrapper, F, Q
from django.db.models.functions import TruncDate

from api.branch_scope import get_branch_scope
from api.clock import FACTORY_TZ
from api.models import (
    GateDevice, OutpassGateScan, OutpassRecord, OutpassRequest, TeaBreakLog, TeaBreakRule, VisitorVisit,
)

from ..filters import boolean, branches, scope, select
from ..formatting import full_name, r2
from ..registry import register
from ..types import BADGE, DATE, DATETIME, INTEGER, PERCENT, TEXT, ColumnSpec, ReportResult, ReportSpec
from . import gate_outpass_common as C

MODULES = ("outpass_visitors",)
NOTE_TIMES = "All times are Asia/Kolkata (IST)."
DEFAULT_TEA_MINUTES = 15  # TeaBreakRule.allowed_minutes default, used when HR never saved a rule
NOTE_NO_PAYROLL = "Gate data has no attendance, payroll or leave effect in this system; this report is informational."


def _counts_line(prefix: str, counter: Counter) -> str | None:
    if not counter:
        return None
    body = ", ".join(f"{k} {v}" for k, v in sorted(counter.items(), key=lambda kv: (-kv[1], str(kv[0]))))
    return f"{prefix}: {body}."


def _text_summary(label: str, value) -> dict:
    return {"label": label, "value": value, "format": "text"}


def _notes(*items) -> list[str]:
    return [i for i in items if i]


# ── 11. outpass-qr-submissions ──────────────────────────────────────────────

QR_COLUMNS = (
    ColumnSpec("submittedAt", "Submitted", DATETIME, 1.4),
    ColumnSpec("enteredCode", "Code Entered", TEXT, 1.0),
    ColumnSpec("enteredName", "Name Entered", TEXT, 2.0),
    ColumnSpec("matchedEmployee", "Matched Employee", TEXT, 2.2),
    ColumnSpec("department", "Department", TEXT, 1.5),
    ColumnSpec("designation", "Designation", TEXT, 1.5),
    ColumnSpec("destination", "Destination", TEXT, 2.0),
    ColumnSpec("branch", "QR Branch", TEXT, 1.3),
    ColumnSpec("matchStatus", "Match", BADGE, 1.1),
    ColumnSpec("source", "Source", BADGE, 1.2),
)
_QR_SOURCES = (
    ("qr", "Gate QR form only"),
    ("request", "Approved-pass copies only"),
    ("all", "Everything on the Outpass page"),
)
_QR_SOURCE_LABEL = {"qr": "QR Form", "request": "Approved Pass"}
_MATCH_OPTIONS = (("matched", "Matched"), ("name_mismatch", "Name mismatch"), ("unmatched", "Unmatched"))
_MATCH_LABEL = {"matched": "Matched", "name_mismatch": "Name Mismatch", "unmatched": "Unmatched"}


def _norm(name) -> str:
    return " ".join(str(name or "").split()).casefold()


def _match_status(rec) -> str:
    if rec.employee_id is None:
        return "unmatched"
    return "matched" if _norm(rec.employee_name) == _norm(full_name(rec.employee)) else "name_mismatch"


def _run_qr(ctx) -> ReportResult:
    p = ctx.params
    source = p.get("source") or "qr"
    qs = (
        OutpassRecord.objects.select_related("branch", "employee__department", "employee__designation")
        .defer(*C.EMP_DEFER)
        .filter(C.branch_q(ctx), C.employee_link_q(ctx), C.in_range("submitted_at", ctx))
    )
    if source != "all":
        qs = qs.filter(source=source)
    wanted = p.get("matchStatus")
    picked, statuses = [], []
    for rec in qs.order_by("-submitted_at", "-id"):
        status = _match_status(rec)
        if wanted and status != wanted:
            continue
        picked.append(rec)
        statuses.append(status)
        if len(picked) >= ctx.row_limit:
            break

    rows = []
    for rec, status in zip(picked, statuses):
        emp = rec.employee
        rows.append({
            "submittedAt": C.fmt(rec.submitted_at),
            "enteredCode": C.clean(rec.employee_code, 60),
            "enteredName": C.clean(rec.employee_name, 120),
            "matchedEmployee": f"{emp.employee_code} - {full_name(emp)}" if emp else None,
            "department": (emp.department.name if emp.department_id else "Unassigned") if emp else None,
            "designation": emp.designation.title if emp and emp.designation_id else None,
            "destination": C.clean(rec.destination),
            "branch": rec.branch.name if rec.branch_id else None,
            "matchStatus": _MATCH_LABEL[status],
            "source": _QR_SOURCE_LABEL.get(rec.source, rec.source),
        })

    n = len(picked)
    counts = Counter(statuses)
    per_branch = Counter((r.branch.name if r.branch_id else "No branch") for r in picked)
    per_person = Counter(f"{r.employee.employee_code} {r.employee.first_name}".strip() for r in picked if r.employee_id)
    top_people = C.top(list(per_person.items()))
    summary = [
        {"label": "Submissions", "value": n, "format": "integer"},
        {"label": "Matched to an employee", "value": counts.get("matched", 0), "format": "integer"},
        {"label": "Name mismatch", "value": counts.get("name_mismatch", 0), "format": "integer"},
        {"label": "Unmatched", "value": counts.get("unmatched", 0), "format": "integer"},
    ]
    notes = _notes(
        NOTE_TIMES,
        "Submissions are unverified: anyone with the branch QR can type any employee code and name. Match = the code "
        "belongs to an employee and the typed name equals that employee's name; Name Mismatch = the code exists but "
        "the name differs; Unmatched = the code belongs to nobody.",
        "The form records only name, code and destination - no return time, approver, reason or duration exists, so "
        "none is shown. QR Branch is the branch of the QR that was scanned, which may differ from the employee's own.",
        "Department, designation, type and employee filters only match submissions linked to an employee, so "
        "unmatched submissions are hidden while any of them is set."
        if any(p.get(k) for k in ("department_ids", "designation_ids", "employment_type", "employee_ids")) else None,
        "The Outpass page's Gate QR Submissions table also lists a copy of every approved pass (and one more copy each "
        "time HR re-approves). Those copies are not gate exits: they are excluded here by default; choose 'Everything on "
        "the Outpass page' to reproduce that table." if source == "qr" else None,
        _counts_line("By QR branch", per_branch),
        ("Most submissions: " + "; ".join(f"{name} ({v})" for name, v in top_people) + ".") if top_people else None,
        C.truncated_note(ctx, n),
    )
    return ReportResult(rows=rows, summary=summary, notes=notes)


register(ReportSpec(
    id="outpass-qr-submissions",
    title="Gate QR Submissions",
    description="Anonymous exits logged through the branch QR form, checked against the employee master.",
    category="gate",
    icon="QrCode",
    tags=("outpass", "qr", "gate qr", "submissions", "unverified", "mismatch"),
    modules=MODULES,
    filters=(
        C.dates("Submitted between", "the time of the submission"),
        *scope(status=None),
        select("source", "Records", _QR_SOURCES, default="qr", placeholder="Gate QR form only"),
        select("matchStatus", "Match result", _MATCH_OPTIONS, placeholder="All"),
    ),
    columns=QR_COLUMNS,
    run=_run_qr,
))


# ── 12. gate-scan-audit-log ─────────────────────────────────────────────────

SCAN_COLUMNS = (
    ColumnSpec("scannedAt", "Scanned", DATETIME, 1.4),
    ColumnSpec("gate", "Gate", TEXT, 1.2),
    ColumnSpec("gateBranch", "Gate Branch", TEXT, 1.2),
    ColumnSpec("scanType", "Leg", BADGE, 0.9),
    ColumnSpec("result", "Result", BADGE, 1.2),
    ColumnSpec("employeeCode", "Emp Code", TEXT, 1.0),
    ColumnSpec("employeeName", "Employee", TEXT, 2.2),
    ColumnSpec("department", "Department", TEXT, 1.5),
    ColumnSpec("passType", "Pass Type", BADGE, 1.1),
    ColumnSpec("destination", "Destination", TEXT, 1.8),
    ColumnSpec("detail", "Detail", TEXT, 2.6),
)
_SCAN_TYPES = (("exit", "Exit"), ("entry", "Return"))
_SCAN_RESULTS = tuple(C.SCAN_RESULT_LABELS.items())


def _scan_detail(scan) -> str:
    """What happened, in our words. The stored message is not printed for already-scanned results because it
    embeds a clock time formatted in UTC (5h30 behind IST)."""
    req = scan.outpass_request
    entry = scan.scan_type == "entry"
    result = scan.result
    if result == "success":
        return "Return recorded" if entry else "Exit recorded"
    if result == "already_scanned":
        when = gate = None
        if req:
            when = req.entered_at if entry else req.exited_at
            gate_fk = req.entry_gate if entry else req.exit_gate
            gate = gate_fk.name if gate_fk else None
        label = "Already returned" if entry else "Pass already used - exited"
        return label + (f" at {C.human(when)}" if when else "") + (f" via {gate}" if gate else "")
    if result == "expired":
        if req and req.approved_at:
            return f"Pass expired at {C.human(req.approved_at + C.PASS_VALID)} (valid 60 minutes from approval)"
        return "Pass expired"
    if result == "not_approved":
        return "Request was not approved (pending or rejected)"
    if result == "not_exited":
        return "Return scanned before any exit was recorded"
    return C.clean(scan.message, 160) or "QR code not recognised"


def _run_scans(ctx) -> ReportResult:
    p = ctx.params
    qs = (
        OutpassGateScan.objects.select_related(
            "gate__branch", "employee__department", "outpass_request__exit_gate", "outpass_request__entry_gate"
        )
        .defer(*C.EMP_DEFER)
        .filter(C.scan_scope_q(ctx), C.in_range("scanned_at", ctx))
        .filter(C.gate_name_q(p.get("gate"), ("gate",)))
    )
    if p.get("scanType"):
        qs = qs.filter(scan_type=p["scanType"])
    if p.get("result"):
        qs = qs.filter(result=p["result"])
    picked = list(qs.order_by("-scanned_at", "-id")[: ctx.row_limit])

    rows = []
    for s in picked:
        emp, req = s.employee, s.outpass_request
        rows.append({
            "scannedAt": C.fmt(s.scanned_at),
            "gate": s.gate.name if s.gate_id else "Unknown gate",
            "gateBranch": s.gate.branch.name if s.gate_id and s.gate.branch_id else None,
            "scanType": C.SCAN_TYPE_LABELS.get(s.scan_type, s.scan_type),
            "result": C.SCAN_RESULT_LABELS.get(s.result, s.result),
            "employeeCode": emp.employee_code if emp else None,
            "employeeName": full_name(emp) if emp else None,
            "department": (emp.department.name if emp.department_id else "Unassigned") if emp else None,
            "passType": C.pass_type_label(req.pass_type) if req else None,
            "destination": C.clean(req.destination) if req else None,
            "detail": _scan_detail(s),
        })

    n = len(picked)
    ok = sum(1 for s in picked if s.result == "success")
    denied = [s for s in picked if s.result != "success"]
    by_reason = Counter(C.SCAN_RESULT_LABELS.get(s.result, s.result) for s in denied)
    per_gate_total, per_gate_denied = Counter(), Counter()
    for s in picked:
        g = s.gate.name if s.gate_id else "Unknown gate"
        per_gate_total[g] += 1
        if s.result != "success":
            per_gate_denied[g] += 1
    gate_rates = sorted(
        ((g, per_gate_denied[g], t) for g, t in per_gate_total.items() if per_gate_denied[g]),
        key=lambda x: (-x[1] / x[2], x[0]),
    )[:8]
    repeat = Counter(s.employee_id for s in denied if s.employee_id)
    summary = [
        {"label": "Scan attempts", "value": n, "format": "integer"},
        {"label": "Successful", "value": ok, "format": "integer"},
        {"label": "Denied", "value": len(denied), "format": "integer"},
        {"label": "Denial rate", "value": r2(len(denied) * 100 / n) if n else None, "format": "percent"},
        {"label": "Employees with 3+ denied attempts", "value": sum(1 for v in repeat.values() if v >= 3), "format": "integer"},
    ]
    notes = _notes(
        NOTE_TIMES,
        "Every outpass exit and return scan attempt at every gate, successful or denied. Tea-break scans are not "
        "logged here (see the tea-break reports); a failed tea-break scan appears as Invalid QR.",
        "Leg shows which QR was scanned (exit pass or return QR). A QR that could not be read has no employee or pass, and "
        "its leg is recorded as Exit whichever it was. Rows at a gate that has since been deleted show Unknown gate.",
        "Detail is written from the result and the pass's own times, not from the stored message, which carries a clock "
        "time in UTC.",
        _counts_line("Denied by reason", by_reason),
        ("Denial rate by gate: " + "; ".join(f"{g} {d} of {t} ({r2(d * 100 / t)}%)" for g, d, t in gate_rates) + ".")
        if gate_rates else None,
        "Department, type and employee filters only match scans linked to an employee, so unreadable QR scans are "
        "hidden while any of them is set."
        if any(p.get(k) for k in ("department_ids", "employment_type", "employee_ids")) else None,
        C.truncated_note(ctx, n),
    )
    return ReportResult(rows=rows, summary=summary, notes=notes)


register(ReportSpec(
    id="gate-scan-audit-log",
    title="Gate Scan Audit Log",
    description="Every outpass exit and return scan at every gate, including denied and forged attempts.",
    category="gate",
    icon="ScanLine",
    tags=("gate", "scan", "audit", "denied", "invalid qr", "security", "expired"),
    modules=MODULES,
    filters=(
        C.dates("Scanned between", "the time of the scan", default="thisWeek"),
        *scope(designation=False, status=None),
        C.gate_filter(),
        select("scanType", "Leg", _SCAN_TYPES, placeholder="Exit and return"),
        select("result", "Result", _SCAN_RESULTS, placeholder="All results"),
    ),
    columns=SCAN_COLUMNS,
    run=_run_scans,
))


# ── 13. gate-activity-summary ───────────────────────────────────────────────

ACTIVITY_COLUMNS = (
    ColumnSpec("gate", "Gate", TEXT, 2.0),
    ColumnSpec("branch", "Branch", TEXT, 1.4),
    ColumnSpec("isActive", "Status", BADGE, 0.9),
    ColumnSpec("lastLoginAt", "Last Login", DATETIME, 1.4),
    ColumnSpec("exitScans", "Exits", INTEGER, 0.8, total="sum"),
    ColumnSpec("returnScans", "Returns", INTEGER, 0.8, total="sum"),
    ColumnSpec("alreadyScanned", "Already Scanned", INTEGER, 1.0, total="sum"),
    ColumnSpec("expired", "Expired", INTEGER, 0.8, total="sum"),
    ColumnSpec("notApproved", "Not Approved", INTEGER, 0.9, total="sum"),
    ColumnSpec("notExited", "Not Yet Exited", INTEGER, 0.9, total="sum"),
    ColumnSpec("invalidQr", "Invalid QR", INTEGER, 0.8, total="sum"),
    ColumnSpec("teaOut", "Tea Out", INTEGER, 0.8, total="sum"),
    ColumnSpec("teaIn", "Tea In", INTEGER, 0.8, total="sum"),
    ColumnSpec("totalScans", "Total Scans", INTEGER, 0.9, total="sum"),
    ColumnSpec("deniedScans", "Denied", INTEGER, 0.8, total="sum"),
    ColumnSpec("denialPct", "Denial Rate", PERCENT, 0.9),
)
_DENIED_KEY = {
    "already_scanned": "alreadyScanned", "expired": "expired", "not_approved": "notApproved",
    "not_exited": "notExited", "invalid_qr": "invalidQr",
}


def _run_activity(ctx) -> ReportResult:
    p = ctx.params
    gates_qs = GateDevice.objects.select_related("branch").filter(C.branch_q(ctx))
    if p.get("activeOnly"):
        gates_qs = gates_qs.filter(is_active=True)
    if p.get("gate"):
        gates_qs = gates_qs.filter(name__icontains=p["gate"])
    gates = list(gates_qs.order_by("name", "id"))
    ids = [g.id for g in gates]
    # Scans at a gate that no longer exists cannot be tied to a branch: only unscoped users, with no
    # branch/gate/status narrowing in force, see them (as one "Unknown / removed gate" row).
    include_unknown = (
        get_branch_scope(ctx.request) is None
        and not (p.get("branch_ids") or p.get("gate") or p.get("activeOnly"))
    )

    def gate_q(field: str) -> Q:
        q = Q(**{f"{field}__in": ids})
        return q | Q(**{f"{field}__isnull": True}) if include_unknown else q

    counts: dict = defaultdict(int)
    for r in (
        OutpassGateScan.objects.filter(C.in_range("scanned_at", ctx)).filter(gate_q("gate_id"))
        .order_by().values("gate_id", "scan_type", "result").annotate(n=Count("id"))
    ):
        counts[(r["gate_id"], r["scan_type"], r["result"])] += r["n"]
    tea_out = {
        r["out_gate_id"]: r["n"]
        for r in TeaBreakLog.objects.filter(C.in_range("out_at", ctx)).filter(gate_q("out_gate_id"))
        .order_by().values("out_gate_id").annotate(n=Count("id"))
    }
    tea_in = {
        r["in_gate_id"]: r["n"]
        for r in TeaBreakLog.objects.filter(C.in_range("in_at", ctx)).filter(gate_q("in_gate_id"))
        .order_by().values("in_gate_id").annotate(n=Count("id"))
    }

    def row_for(gate_id, name, branch, active, last_login) -> dict:
        row = {
            "gate": name, "branch": branch, "isActive": active, "lastLoginAt": C.fmt(last_login),
            "exitScans": counts[(gate_id, "exit", "success")], "returnScans": counts[(gate_id, "entry", "success")],
            "alreadyScanned": 0, "expired": 0, "notApproved": 0, "notExited": 0, "invalidQr": 0,
            "teaOut": tea_out.get(gate_id, 0), "teaIn": tea_in.get(gate_id, 0),
        }
        attempts = sum(v for (g, _t, _r), v in counts.items() if g == gate_id)
        for (g, _t, result), v in counts.items():
            if g == gate_id and result in _DENIED_KEY:
                row[_DENIED_KEY[result]] += v
        denied = sum(row[k] for k in _DENIED_KEY.values())
        row["deniedScans"] = denied
        row["totalScans"] = attempts + row["teaOut"] + row["teaIn"]
        row["denialPct"] = r2(denied * 100 / attempts) if attempts else None
        return row

    rows = [
        row_for(g.id, g.name, g.branch.name if g.branch_id else None, "Active" if g.is_active else "Inactive", g.last_login_at)
        for g in gates
    ]
    if include_unknown:
        unknown = row_for(None, "Unknown / removed gate", None, None, None)
        if unknown["totalScans"]:
            rows.append(unknown)
    rows.sort(key=lambda r: (-r["totalScans"], r["gate"]))

    totals = C.sum_totals(rows, [c.key for c in ACTIVITY_COLUMNS if c.total == "sum"])
    attempts_all = sum(v for v in counts.values())
    totals["denialPct"] = r2(totals["deniedScans"] * 100 / attempts_all) if attempts_all and totals["deniedScans"] is not None else None
    busiest = C.top([(r["gate"], r["totalScans"]) for r in rows], 1)
    summary = [
        {"label": "Total scans", "value": totals["totalScans"], "format": "integer"},
        {"label": "Outpass scan attempts", "value": attempts_all, "format": "integer"},
        {"label": "Denied", "value": totals["deniedScans"], "format": "integer"},
        {"label": "Denial rate", "value": totals["denialPct"], "format": "percent"},
        _text_summary("Busiest gate", f"{busiest[0][0]} ({busiest[0][1]})" if busiest else None),
    ]
    notes = _notes(
        NOTE_TIMES,
        "Exits and Returns are successful outpass scans; the five denial columns are failed attempts. Denial rate = "
        "denied / outpass scan attempts. Tea Out and Tea In count tea-break scans at the gate (each OUT or IN scan is "
        "one scan) and have no denial states; a failed tea-break scan shows under Invalid QR.",
        "Total Scans = outpass attempts + tea-break scans. Last Login is the only activity time a gate device records.",
        "Scans at a gate that has since been deleted are shown as Unknown / removed gate, to users who can see every "
        "branch only." if include_unknown else None,
        "Device passwords and login links are never included in reports.",
    )
    return ReportResult(rows=rows, totals=totals, summary=summary, notes=notes)


register(ReportSpec(
    id="gate-activity-summary",
    title="Gate Activity Summary",
    description="Per gate: outpass exits and returns, denied scans by reason and tea-break scans.",
    category="gate",
    icon="BarChart3",
    tags=("gate", "activity", "throughput", "scans", "denied", "devices"),
    modules=MODULES,
    filters=(
        C.dates("Scanned between", "the time of each scan"),
        branches(),
        C.gate_filter(),
        boolean("activeOnly", "Active gates only"),
    ),
    columns=ACTIVITY_COLUMNS,
    run=_run_activity,
))


# ── 14. gate-daily-summary ──────────────────────────────────────────────────

DAILY_COLUMNS = (
    ColumnSpec("date", "Date", DATE, 1.1),
    ColumnSpec("weekday", "Day", TEXT, 0.7),
    ColumnSpec("passRequests", "Pass Requests", INTEGER, 1.0, total="sum"),
    ColumnSpec("passesApproved", "Passes Approved", INTEGER, 1.0, total="sum"),
    ColumnSpec("exits", "Gate Exits", INTEGER, 0.9, total="sum"),
    ColumnSpec("returns", "Gate Returns", INTEGER, 0.9, total="sum"),
    ColumnSpec("qrSubmissions", "QR Submissions", INTEGER, 1.0, total="sum"),
    ColumnSpec("visitors", "Visitors", INTEGER, 0.8, total="sum"),
    ColumnSpec("teaBreaks", "Tea Breaks", INTEGER, 0.9, total="sum"),
    ColumnSpec("teaOvertime", "Tea Overtime", INTEGER, 0.9, total="sum"),
    ColumnSpec("deniedScans", "Denied Scans", INTEGER, 0.9, total="sum"),
)


def _by_day(qs, field: str, **aggregates) -> dict:
    """{IST date: aggregated row} - days are cut at IST midnight, never UTC."""
    rows = (
        qs.order_by().annotate(day=TruncDate(field, tzinfo=FACTORY_TZ)).values("day")
        .annotate(n=Count("id"), **aggregates)
    )
    return {r["day"]: r for r in rows}


def _run_daily(ctx) -> ReportResult:
    rng = lambda field: C.in_range(field, ctx)  # noqa: E731
    req_scope = OutpassRequest.objects.filter(ctx.emp_q("employee__"))
    requested = _by_day(req_scope.filter(rng("created_at")), "created_at")
    approved = _by_day(req_scope.filter(status="approved").filter(rng("approved_at")), "approved_at")
    exits = _by_day(req_scope.filter(rng("exited_at")), "exited_at")
    returns = _by_day(req_scope.filter(rng("entered_at")), "entered_at")
    qr = _by_day(OutpassRecord.objects.filter(source="qr").filter(C.branch_q(ctx)).filter(rng("submitted_at")), "submitted_at")
    visitors = _by_day(VisitorVisit.objects.filter(C.branch_q(ctx)).filter(rng("visited_at")), "visited_at")
    denied = _by_day(
        OutpassGateScan.objects.exclude(result="success").filter(C.scan_scope_q(ctx)).filter(rng("scanned_at")),
        "scanned_at",
    )

    rule = TeaBreakRule.objects.filter(pk=1).first()  # never TeaBreakRule.get(): that creates the row on a GET
    allowed = rule.allowed_minutes if rule else DEFAULT_TEA_MINUTES
    tie = timedelta(minutes=allowed, seconds=30)
    # The HR tea-break page marks a completed break overtime when round(minutes) > allowed, with Python's
    # round-half-even: so exactly allowed + 0.5 minutes is overtime only when `allowed` is odd.
    over = Q(taken_td__gt=tie) | Q(taken_td=tie) if allowed % 2 == 1 else Q(taken_td__gt=tie)
    tea = _by_day(
        TeaBreakLog.objects.filter(ctx.emp_q("employee__")).filter(rng("out_at"))
        .annotate(taken_td=ExpressionWrapper(F("in_at") - F("out_at"), output_field=DurationField())),
        "out_at",
        ot=Count("id", filter=over),
    )

    rows = []
    for d in ctx.days_in_range:
        rows.append({
            "date": d.isoformat(), "weekday": d.strftime("%a"),
            "passRequests": requested.get(d, {}).get("n", 0), "passesApproved": approved.get(d, {}).get("n", 0),
            "exits": exits.get(d, {}).get("n", 0), "returns": returns.get(d, {}).get("n", 0),
            "qrSubmissions": qr.get(d, {}).get("n", 0), "visitors": visitors.get(d, {}).get("n", 0),
            "teaBreaks": tea.get(d, {}).get("n", 0), "teaOvertime": tea.get(d, {}).get("ot", 0),
            "deniedScans": denied.get(d, {}).get("n", 0),
        })

    totals = C.sum_totals(rows, [c.key for c in DAILY_COLUMNS if c.total == "sum"])
    busiest = max(rows, key=lambda r: (r["exits"], r["date"]), default=None)
    summary = [
        {"label": "Pass requests", "value": totals["passRequests"], "format": "integer"},
        {"label": "Gate exits", "value": totals["exits"], "format": "integer"},
        {"label": "QR submissions", "value": totals["qrSubmissions"], "format": "integer"},
        {"label": "Visitors", "value": totals["visitors"], "format": "integer"},
        {"label": "Tea breaks", "value": totals["teaBreaks"], "format": "integer"},
        {"label": "Denied scans", "value": totals["deniedScans"], "format": "integer"},
        _text_summary(
            "Busiest day (most gate exits)",
            f"{busiest['date']} ({busiest['exits']} exits)" if busiest and busiest["exits"] else None,
        ),
    ]
    notes = _notes(
        NOTE_TIMES + " Every day in the range is listed, including days with no activity.",
        "Each column is counted on its own timestamp and branch link, so columns are not additive: pass requests by "
        "request date, passes approved by approval date, gate exits and returns by the scan date, QR submissions by "
        "submission date (branch of the QR), visitors by visit date, tea breaks by the OUT scan date, denied scans by "
        "scan date (gate or employee branch).",
        "Exits and QR submissions are different things and are never combined: exits are scanned approved passes, QR "
        "submissions are unverified form entries.",
        f"Tea Overtime uses the current allowed break of {allowed} minutes for every day shown, including past ones.",
        NOTE_NO_PAYROLL,
    )
    return ReportResult(rows=rows, totals=totals, summary=summary, notes=notes)


register(ReportSpec(
    id="gate-daily-summary",
    title="Daily Gate Summary",
    description="One row per day: pass requests, gate exits and returns, QR submissions, visitors, tea breaks and denied scans.",
    category="gate",
    icon="CalendarDays",
    tags=("gate", "daily", "summary", "overview", "visitors", "tea break", "outpass"),
    modules=MODULES,
    filters=(
        C.dates("Date range", "each figure's own timestamp", default="thisMonth"),
        branches(),
    ),
    columns=DAILY_COLUMNS,
    run=_run_daily,
))

"""Gate overview reports (report group G9): time away per employee and the device register.

Both are informational: gate data has no link to attendance, shift or payroll, so nothing here is a deduction.
"""

from __future__ import annotations

from django.db.models import Count, F, Q, Sum

from ..filters import boolean, branches, date_range, scope, select
from ..formatting import fmt_dt
from ..registry import register
from ..types import BADGE, DATETIME, DURATION, INTEGER, TEXT, ColumnSpec, ReportResult, ReportSpec
from . import gate_visitor_tea_common as C

# ═════════════════════════════════════════════════════════════════════════════
# employee-time-away-summary
# ═════════════════════════════════════════════════════════════════════════════


def _run_time_away(ctx):
    from api.models import Employee, OutpassRecord, OutpassRequest, VisitorVisit

    now = C.now_utc()
    allowed, rule_at = C.tea_rule()
    excluded = bool(ctx.params.get("excludeSuspect"))
    scope_q = ctx.emp_q("employee__")

    # Passes: an exit scan puts the employee outside; minutes only exist once the return was scanned too.
    returned = Q(entered_at__isnull=False, entered_at__gte=F("exited_at"))
    outpass = {
        r["employee_id"]: r
        for r in OutpassRequest.objects.filter(scope_q, exited_at__isnull=False).filter(C.in_range("exited_at", ctx))
        .values("employee_id")
        .annotate(exits=Count("id"), mins=Sum(C.WholeMinutes(F("entered_at") - F("exited_at")), filter=returned))
        .order_by()
    }
    # Gate QR submissions: unverified, no in-time, so they contribute a count only (never minutes).
    qr = {
        r["employee_id"]: r["n"]
        for r in OutpassRecord.objects.filter(scope_q, source="qr", employee__isnull=False)
        .filter(C.in_range("submitted_at", ctx))
        .values("employee_id").annotate(n=Count("id")).order_by()
    }
    tea = {
        r["employee_id"]: r
        for r in C.tea_queryset(ctx, now=now, exclude_suspect=excluded)
        .values("employee_id")
        .annotate(
            n=Count("id"),
            mins=Sum(C.break_minutes(), filter=C.completed_q()),
            ot=Count("id", filter=C.long_q(allowed)),
        )
        .order_by()
    }
    hosted = {
        r["meeting_employee_id"]: r["n"]
        for r in VisitorVisit.objects.filter(ctx.emp_q("meeting_employee__"), meeting_employee__isnull=False)
        .filter(C.in_range("visited_at", ctx))
        .values("meeting_employee_id").annotate(n=Count("id")).order_by()
    }

    ids = set(outpass) | set(qr) | set(tea) | set(hosted)
    people = (
        Employee.objects.filter(ctx.emp_q(), id__in=ids)
        .values("id", *C.emp_value_fields(""))
        .order_by("employee_code", "id")
    )
    rows = []
    for e in people:
        op = outpass.get(e["id"])
        tb = tea.get(e["id"])
        op_min = int(op["mins"] or 0) if op else 0
        tea_min = int(tb["mins"] or 0) if tb else 0
        rows.append({
            **C.emp_cells_from_values(e, ""),
            "outpassExits": op["exits"] if op else 0,
            "outpassMinutes": op_min,
            "qrExits": qr.get(e["id"], 0),
            "teaBreaks": tb["n"] if tb else 0,
            "teaMinutes": tea_min,
            "teaOvertime": tb["ot"] if tb else 0,
            "visitorsHosted": hosted.get(e["id"], 0),
            "totalAwayMinutes": op_min + tea_min,
        })

    top = max(rows, key=lambda r: r["totalAwayMinutes"], default=None)  # first (lowest code) wins a tie
    summary = [
        {"label": "Employees with gate activity", "value": len(rows), "format": "integer"},
        {"label": "Outpass exits", "value": sum(r["outpassExits"] for r in rows), "format": "integer"},
        {"label": "Tea breaks", "value": sum(r["teaBreaks"] for r in rows), "format": "integer"},
        {"label": "Time away (outpass + tea)", "value": sum(r["totalAwayMinutes"] for r in rows), "format": "duration"},
        {
            "label": "Most time away",
            "value": f"{top['employeeCode']} {top['employeeName']}" if top and top["totalAwayMinutes"] else None,
            "format": "text",
        },
        {"label": "Visitors hosted", "value": sum(r["visitorsHosted"] for r in rows), "format": "integer"},
    ]
    notes = [
        "Informational only - not linked to attendance, shift or payroll.",
        "Outpass minutes count passes whose return was scanned (door to door); a pass with no return scan has no duration "
        "and contributes only to the exit count. Gate QR exits are unverified and have no in-time, so they are counts only.",
        "Tea minutes are completed breaks only (open breaks have no duration). "
        + C.rule_note(allowed, rule_at),
        "Time away = outpass minutes + tea-break minutes; visitors hosted are visits where the visitor was matched to this "
        "employee. Each figure uses its own timestamp (pass exit, QR submission, break start, visit) in Indian Standard Time.",
    ]
    if excluded:
        notes.append("Long and left-open tea breaks were left out (filter 'Leave out long / unclosed tea breaks').")
    return ReportResult(rows=rows[: ctx.row_limit], summary=summary, notes=notes)


register(ReportSpec(
    id="employee-time-away-summary",
    title="Employee Time Away Summary",
    description="Per employee: outpass exits and minutes outside, gate QR exits, tea breaks and visitors hosted - informational.",
    category=C.CATEGORY,
    icon="LogOut",
    tags=("time away", "outpass", "tea", "visitor", "gate", "summary"),
    modules=C.MODULES,
    filters=(
        date_range("thisMonth", "Period"),
        *scope(status="all"),
        boolean(
            "excludeSuspect", "Leave out long / unclosed tea breaks",
            help=f"Drops completed tea breaks over {C.SUSPECT_MINUTES} minutes and breaks left open for over 12 hours (usually a missed scan).",
        ),
    ),
    columns=(
        ColumnSpec("employeeCode", "Emp Code", TEXT, 1.0),
        ColumnSpec("employeeName", "Employee", TEXT, 2.2),
        ColumnSpec("department", "Department", TEXT, 1.5),
        ColumnSpec("designation", "Designation", TEXT, 1.5),
        ColumnSpec("outpassExits", "Outpass exits", INTEGER, 0.9, total="sum"),
        ColumnSpec("outpassMinutes", "Outpass time", DURATION, 1.0, total="sum"),
        ColumnSpec("qrExits", "QR exits", INTEGER, 0.8, total="sum"),
        ColumnSpec("teaBreaks", "Tea breaks", INTEGER, 0.8, total="sum"),
        ColumnSpec("teaMinutes", "Tea time", DURATION, 1.0, total="sum"),
        ColumnSpec("teaOvertime", "Tea overtime", INTEGER, 0.8, total="sum"),
        ColumnSpec("visitorsHosted", "Visitors hosted", INTEGER, 0.9, total="sum"),
        ColumnSpec("totalAwayMinutes", "Total time away", DURATION, 1.1, total="sum"),
    ),
    run=_run_time_away,
))


# ═════════════════════════════════════════════════════════════════════════════
# gate-device-register
# ═════════════════════════════════════════════════════════════════════════════

_DEVICE_TYPES = [("gate", "Gate scanners"), ("reception", "Reception desks")]
_DEVICE_STATUS = [("active", "Active"), ("deactivated", "Deactivated")]


def _run_devices(ctx):
    from api.models import GateDevice, OutpassGateScan, ReceptionDevice, TeaBreakLog

    kind = ctx.params.get("deviceType")
    status = ctx.params.get("deviceStatus")

    def fetch(model):
        qs = model.objects.filter(C.branch_q(ctx, "branch_id"))
        if status == "active":
            qs = qs.filter(is_active=True)
        elif status == "deactivated":
            qs = qs.filter(is_active=False)
        # Explicit columns: password_hash and login_token must never be read into a report.
        return list(
            qs.values("id", "name", "branch__name", "username", "is_active", "created_by", "created_at", "last_login_at")
            .order_by("branch__name", "name", "id")
        )

    gates = fetch(GateDevice) if kind != "reception" else []
    desks = fetch(ReceptionDevice) if kind != "gate" else []
    gate_ids = [g["id"] for g in gates]

    outpass_scans = {
        r["gate_id"]: r["n"]
        for r in OutpassGateScan.objects.filter(gate_id__in=gate_ids).filter(C.in_range("scanned_at", ctx))
        .values("gate_id").annotate(n=Count("id")).order_by()
    }
    tea_out = {
        r["out_gate_id"]: r["n"]
        for r in TeaBreakLog.objects.filter(out_gate_id__in=gate_ids).filter(C.in_range("out_at", ctx))
        .values("out_gate_id").annotate(n=Count("id")).order_by()
    }
    tea_in = {
        r["in_gate_id"]: r["n"]
        for r in TeaBreakLog.objects.filter(in_gate_id__in=gate_ids).filter(C.in_range("in_at", ctx))
        .values("in_gate_id").annotate(n=Count("id")).order_by()
    }

    def row(d, label, scans, tea_scans):
        return {
            "name": d["name"],
            "deviceType": label,
            "branch": d["branch__name"],
            "username": d["username"],
            "status": "Active" if d["is_active"] else "Deactivated",
            "createdBy": d["created_by"],
            "createdAt": fmt_dt(d["created_at"]),
            "lastLoginAt": fmt_dt(d["last_login_at"]),
            "outpassScans": scans,
            "teaScans": tea_scans,
        }

    rows = [
        row(g, "Gate scanner", outpass_scans.get(g["id"], 0), tea_out.get(g["id"], 0) + tea_in.get(g["id"], 0)) for g in gates
    ] + [row(d, "Reception desk", None, None) for d in desks]

    devices = gates + desks
    summary = [
        {"label": "Devices", "value": len(devices), "format": "integer"},
        {"label": "Active", "value": sum(1 for d in devices if d["is_active"]), "format": "integer"},
        {"label": "Deactivated", "value": sum(1 for d in devices if not d["is_active"]), "format": "integer"},
        {"label": "Never logged in", "value": sum(1 for d in devices if d["last_login_at"] is None), "format": "integer"},
        {"label": "Outpass scans in period", "value": sum(outpass_scans.values()), "format": "integer"},
        {"label": "Tea-break scans in period", "value": sum(tea_out.values()) + sum(tea_in.values()), "format": "integer"},
    ]
    notes = [
        "Login tokens and password hashes are never included in this report.",
        "Outpass scans = every exit/return QR scan attempt logged at the gate in the period, including denied ones. Tea scans "
        "= tea-break OUT and IN scans made at the gate. Reception desks do not scan (dash).",
        "A gate that was deleted no longer appears, and its historical scans are not attributed to any device. 'Last login' "
        "is the only activity stamp a device keeps.",
    ]
    return ReportResult(rows=rows, summary=summary, notes=notes)


register(ReportSpec(
    id="gate-device-register",
    title="Gate & Reception Device Register",
    description="Master list of gate scanner and reception desk logins with status, last activity and scans in a period.",
    category=C.CATEGORY,
    icon="ScanLine",
    tags=("gate", "device", "scanner", "reception", "kiosk"),
    modules=C.MODULES,
    filters=(
        date_range("thisMonth", "Scan activity period"),
        branches(),
        select("deviceType", "Device type", _DEVICE_TYPES, placeholder="All devices"),
        select("deviceStatus", "Status", _DEVICE_STATUS, placeholder="All"),
    ),
    columns=(
        ColumnSpec("name", "Device", TEXT, 1.8),
        ColumnSpec("deviceType", "Type", BADGE, 1.1),
        ColumnSpec("branch", "Branch", TEXT, 1.4),
        ColumnSpec("username", "Username", TEXT, 1.4),
        ColumnSpec("status", "Status", BADGE, 1.0),
        ColumnSpec("createdBy", "Created by", TEXT, 1.3),
        ColumnSpec("createdAt", "Created at", DATETIME, 1.4),
        ColumnSpec("lastLoginAt", "Last login", DATETIME, 1.4),
        ColumnSpec("outpassScans", "Outpass scans", INTEGER, 1.0, total="sum"),
        ColumnSpec("teaScans", "Tea scans", INTEGER, 0.9, total="sum"),
    ),
    run=_run_devices,
))

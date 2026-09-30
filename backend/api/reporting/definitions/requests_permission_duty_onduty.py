"""On-duty reports (group G7): the session register, an employee-wise summary and the GPS / selfie punch audit log.

An ``OnDutySession`` has no date column: the business date is the IST date of ``created_at`` (an aware UTC instant), so
every date filter here uses IST day bounds. Its ``branch`` is a snapshot taken when the request was raised; row access
still follows the employee's CURRENT branch through ``ctx.emp_q`` like every other report.

Photos never leave the server through a report: only a Yes/No "has photo" flag is exported (the image itself needs
the authenticated on-duty-punch-verifications/<id>/photo endpoint). Coordinates are exported as exact 6-decimal text.
"""

from __future__ import annotations

from collections import Counter, defaultdict

from django.db.models import Count, Exists, Max, Min, OuterRef, Q

from .. import filters as F
from ..common import EMP_COLS
from ..formatting import fmt_dt, r2
from ..registry import register
from ..types import BADGE, DATE, DATETIME, HOURS, INTEGER, NUMBER, TEXT, TIME, ColumnSpec, ReportResult, ReportSpec
from . import requests_permission_duty_shared as S

STATUS_OPTIONS = (
    ("pending_hod", "Pending HOD"),
    ("pending_hr", "Pending HR"),
    ("active", "Active (HR approved)"),
    ("completed", "Completed"),
    ("rejected", "Rejected"),
)
STATUS_LABELS = {
    "pending_hod": "Pending",
    "pending_hr": "Pending",
    "active": "Active",
    "completed": "Completed",
    "rejected": "Rejected",
}
APPROVED_STATUSES = ("active", "completed")
PATH_OPTIONS = (
    ("hod_then_hr", "HOD approved, then HR"),
    ("hod_rejected", "Rejected by HOD"),
    ("hr_direct", "HR decided directly"),
    ("awaiting", "Still awaiting a decision"),
)
COMPLETION_OPTIONS = (
    ("manual", "Employee marked done"),
    ("auto_4th_punch", "All 4 punches recorded"),
    ("auto_day_end", "Day ended automatically (11 PM)"),
    ("not_completed", "Not completed"),
)
COMPLETION_LABELS = {
    "manual": "Employee marked done",
    "auto_4th_punch": "All 4 punches recorded",
    "auto_day_end": "Day ended (auto)",
}


def status_label(status) -> str | None:
    if not status:
        return None
    return STATUS_LABELS.get(status, str(status).replace("_", " ").title())


def decision_path(s) -> str | None:
    """How the two-stage HOD -> HR approval went, from the stored review stamps."""
    hod, hr = s.hod_reviewed_at is not None, s.hr_reviewed_at is not None
    if hod and hr:
        return "HOD, then HR"
    if hod and s.status == "rejected":
        return "Rejected by HOD"
    if hod:
        return "Awaiting HR (HOD approved)"
    if hr:
        return "HR directly"
    if s.status == "pending_hod":
        return "Awaiting HOD"
    if s.status == "pending_hr":
        return "Awaiting HR"
    return None


def decided_at(s):
    """When the request got its final answer: HR's decision, or the HOD's rejection. None while undecided."""
    if s.status in APPROVED_STATUSES:
        return s.hr_reviewed_at
    if s.status == "rejected":
        return s.hr_reviewed_at or s.hod_reviewed_at
    return None


def completion_text(s) -> str | None:
    if s.completion_reason:
        return COMPLETION_LABELS.get(s.completion_reason, str(s.completion_reason).replace("_", " ").title())
    if s.employee_ended_at is not None:
        return "Employee done (awaiting HR)" if s.status in ("pending_hod", "pending_hr") else "Employee marked done"
    return None


def _session_filters(ctx, qs):
    """Filters shared by the register and the employee summary (all applied in the database)."""
    from api.models import OnDutyPunchVerification

    if ctx.param("status"):
        qs = qs.filter(status=ctx.param("status"))
    path = ctx.param("decisionPath")
    if path == "hod_then_hr":
        qs = qs.filter(hod_reviewed_at__isnull=False, hr_reviewed_at__isnull=False)
    elif path == "hod_rejected":
        qs = qs.filter(hod_reviewed_at__isnull=False, hr_reviewed_at__isnull=True, status="rejected")
    elif path == "hr_direct":
        qs = qs.filter(hod_reviewed_at__isnull=True, hr_reviewed_at__isnull=False)
    elif path == "awaiting":
        qs = qs.filter(status__in=("pending_hod", "pending_hr"))
    # The same three-way reading as ``completion_text`` (the Completion column), so a filter never returns rows whose
    # column says the opposite: a session the employee ended themselves but that HR has not decided yet has no
    # completion_reason, yet its column reads "Employee done (awaiting HR)".
    completion = ctx.param("completion")
    no_reason = Q(completion_reason__isnull=True) | Q(completion_reason="")
    if completion == "not_completed":
        qs = qs.filter(no_reason, employee_ended_at__isnull=True)
    elif completion == "manual":
        qs = qs.filter(Q(completion_reason="manual") | (no_reason & Q(employee_ended_at__isnull=False)))
    elif completion:
        qs = qs.filter(completion_reason=completion)
    if ctx.param("destination"):
        qs = qs.filter(destination__icontains=ctx.param("destination"))
    if ctx.param("mockedOnly"):
        qs = qs.filter(Exists(OnDutyPunchVerification.objects.filter(session=OuterRef("pk"), is_mocked=True)))
    return qs


def _sessions_base(ctx):
    from api.models import OnDutySession

    start, end = S.ist_bounds(ctx.date_from, ctx.date_to)
    return _session_filters(
        ctx, OnDutySession.objects.filter(ctx.emp_q("employee__"), created_at__gte=start, created_at__lt=end)
    )


def _session_filter_specs() -> tuple:
    return (
        F.select("status", "Status", STATUS_OPTIONS),
        F.select("decisionPath", "Decision path", PATH_OPTIONS),
        F.select("completion", "How it ended", COMPLETION_OPTIONS),
        F.text("destination", "Destination contains", "e.g. Coimbatore"),
        F.boolean("mockedOnly", "Only sessions with mock-GPS punches"),
    )


# ── 1. Session register ─────────────────────────────────────────────────────


def _register_run(ctx) -> ReportResult:
    from api.models import OnDutyPunchVerification, OutpassRequest

    sessions = list(
        _sessions_base(ctx)
        .select_related("employee__department", "employee__designation", "employee__branch", "branch")
        .order_by("created_at", "id")[: ctx.row_limit]
    )
    ids = [s.id for s in sessions]
    live = ~Q(status="rejected")
    stats = {
        r["session_id"]: r
        for r in OnDutyPunchVerification.objects.filter(session_id__in=ids)
        .order_by()
        .values("session_id")
        .annotate(
            total=Count("id"),
            approved=Count("id", filter=Q(status="approved")),
            pending=Count("id", filter=Q(status="pending")),
            rejected=Count("id", filter=Q(status="rejected")),
            mocked=Count("id", filter=Q(is_mocked=True)),
            first=Min("punch_time", filter=live),
            last=Max("punch_time", filter=live),
        )
    }
    with_outpass = set(
        OutpassRequest.objects.filter(on_duty_session_id__in=ids, source="on_duty").values_list(
            "on_duty_session_id", flat=True
        )
    )

    rows = []
    hours: list[float] = []
    totals = {"punches": 0, "mocked_sessions": 0}
    by_status: Counter = Counter()
    counted = S.shown(sessions, ctx)  # the summary cards describe the rows that stay, not the runner's extra one
    counted_ids = {s.id for s in counted}
    for s in sessions:
        st = stats.get(s.id) or {}
        h = S.hours_between(s.created_at, decided_at(s))
        if h is not None and s.id in counted_ids:
            hours.append(h)
        comments = "; ".join(
            f"{label}: {text}" for label, text in (("HOD", s.hod_review_comment), ("HR", s.hr_review_comment)) if text
        )
        rows.append(
            {
                **S.base_cells(s.employee),
                "branch": s.branch.name if s.branch_id else None,  # the branch at request time
                "requestedAt": fmt_dt(s.created_at),
                "destination": s.destination,
                "status": status_label(s.status),
                "decisionPath": decision_path(s),
                "hodBy": s.hod_reviewed_by,
                "hodAt": fmt_dt(s.hod_reviewed_at),
                "hrBy": s.hr_reviewed_by,
                "hrAt": fmt_dt(s.hr_reviewed_at),
                "comments": comments or None,
                "decisionHours": h,
                "punchesTotal": st.get("total", 0),
                "punchesApproved": st.get("approved", 0),
                "punchesPending": st.get("pending", 0),
                "punchesRejected": st.get("rejected", 0),
                "firstPunch": S.tstr(st.get("first")),
                "lastPunch": S.tstr(st.get("last")),
                "mockedPunches": st.get("mocked", 0),
                "completion": completion_text(s),
                "outpass": "Issued" if s.id in with_outpass else None,
            }
        )
        if s.id not in counted_ids:
            continue
        totals["punches"] += st.get("total", 0)
        totals["mocked_sessions"] += 1 if st.get("mocked", 0) else 0
        by_status[
            "pending"
            if s.status in ("pending_hod", "pending_hr")
            else "approved"
            if s.status in APPROVED_STATUSES
            else s.status
        ] += 1

    return ReportResult(
        rows=rows,
        summary=[
            {"label": "Sessions", "value": len(counted), "format": "integer"},
            {"label": "Pending decision", "value": by_status["pending"], "format": "integer"},
            {"label": "Approved by HR", "value": by_status["approved"], "format": "integer"},
            {"label": "Rejected", "value": by_status["rejected"], "format": "integer"},
            {"label": "Punches captured", "value": totals["punches"], "format": "integer"},
            {"label": "Sessions with mock GPS", "value": totals["mocked_sessions"], "format": "integer"},
            {
                "label": "Avg request-to-decision (h)",
                "value": round(sum(hours) / len(hours), 2) if hours else None,
                "format": "hours",
            },
            {"label": "Employees on duty", "value": len({s.employee_id for s in counted}), "format": "integer"},
        ],
        notes=[
            "Date = the IST date the on-duty request was submitted (a session has no date of its own). Branch = the "
            "employee's branch when the request was raised.",
            "The employee may work and punch as soon as the request is submitted; those punches stay Pending until HR "
            "approves the session, and are voided (Rejected) if either stage rejects it. Approved = HR approved "
            "(Active or Completed).",
            "First / last punch consider approved and pending punches only. Decision hours = request submitted to the "
            "final answer (HR decision, or the HOD's rejection); blank while undecided.",
            *S.cut_note(sessions, ctx),
        ],
    )


register(
    ReportSpec(
        id="on-duty-register",
        title="On-Duty Records",
        description="Every on-duty session with destination, HOD and HR decisions, punches captured and how it ended.",
        category=S.CATEGORY,
        family="on-duty",
        variant="Sessions",
        icon="MapPin",
        tags=("on duty", "on-duty", "field visit", "gps", "geo attendance"),
        modules=("geo_attendance",),
        filters=(F.date_range("thisMonth", "Request date"), *F.scope(status="all"), *_session_filter_specs()),
        columns=(
            *S.LEAD_COLS,
            S.BRANCH_COL,
            ColumnSpec("requestedAt", "Requested", DATETIME, 1.4),
            ColumnSpec("destination", "Destination", TEXT, 2.0),
            ColumnSpec("status", "Status", BADGE, 1.1),
            ColumnSpec("decisionPath", "Decision path", BADGE, 1.5),
            ColumnSpec("hodBy", "HOD", TEXT, 1.3),
            ColumnSpec("hodAt", "HOD decided", DATETIME, 1.4),
            ColumnSpec("hrBy", "HR", TEXT, 1.3),
            ColumnSpec("hrAt", "HR decided", DATETIME, 1.4),
            ColumnSpec("comments", "Comments", TEXT, 1.8),
            ColumnSpec("decisionHours", "Decision (h)", HOURS, 0.9),
            ColumnSpec("punchesTotal", "Punches", INTEGER, 1.0, total="sum"),
            ColumnSpec("punchesApproved", "Approved", INTEGER, 1.05, total="sum"),
            ColumnSpec("punchesPending", "Pending", INTEGER, 1.0, total="sum"),
            ColumnSpec("punchesRejected", "Rejected", INTEGER, 1.05, total="sum"),
            ColumnSpec("firstPunch", "First punch", TIME, 0.85),
            ColumnSpec("lastPunch", "Last punch", TIME, 0.85),
            ColumnSpec("mockedPunches", "Mock GPS", INTEGER, 0.85, total="sum"),
            ColumnSpec("completion", "Completion", BADGE, 1.6),
            ColumnSpec("outpass", "Outpass", BADGE, 1.0),
        ),
        run=_register_run,
    )
)


# ── 2. Employee summary ─────────────────────────────────────────────────────


def _summary_run(ctx) -> ReportResult:
    from api.models import OnDutyPunchVerification

    base = _sessions_base(ctx)
    per: dict[int, dict] = defaultdict(
        lambda: {
            "sessions": 0,
            "approved": 0,
            "rejected": 0,
            "pending": 0,
            "days": set(),
            "dest": Counter(),
            "names": {},
            "last": None,
        }
    )
    session_ids: list[int] = []
    for sid, eid, status, destination, created in (
        base.order_by("created_at", "id")
        .values_list("id", "employee_id", "status", "destination", "created_at")
        .iterator()
    ):
        session_ids.append(sid)
        b = per[eid]
        day = S.ist_date(created)
        b["sessions"] += 1
        if status in APPROVED_STATUSES:
            b["approved"] += 1
            b["days"].add(day)
            # Only a day HR approved is a day on duty: a rejected request never became attendance and a pending one
            # is not decided yet.
            b["last"] = day if b["last"] is None or day > b["last"] else b["last"]
        elif status == "rejected":
            b["rejected"] += 1
        else:
            b["pending"] += 1
        text = (destination or "").strip()
        if text:
            b["dest"][text.lower()] += 1
            b["names"].setdefault(text.lower(), text)

    punches = {
        r["employee_id"]: r
        for r in OnDutyPunchVerification.objects.filter(session_id__in=session_ids)
        .order_by()
        .values("employee_id")
        .annotate(
            total=Count("id"),
            rejected=Count("id", filter=Q(status="rejected")),
            mocked=Count("id", filter=Q(is_mocked=True)),
        )
    }
    employees = {e.id: e for e in ctx.employees().filter(id__in=per.keys())}
    rows = []
    for eid, b in per.items():
        emp = employees.get(eid)
        if emp is None:
            continue
        top = sorted(b["dest"].items(), key=lambda kv: (-kv[1], kv[0]))
        pr = punches.get(eid) or {}
        rows.append(
            {
                **{k: v for k, v in S.base_cells(emp).items() if k != "branch"},
                "_branch": S.branch_name(emp),
                "sessions": b["sessions"],
                "daysOnDuty": len(b["days"]),
                "approved": b["approved"],
                "rejected": b["rejected"],
                "pending": b["pending"],
                "punchesTotal": pr.get("total", 0),
                "punchesRejected": pr.get("rejected", 0),
                "mockedPunches": pr.get("mocked", 0),
                "topDestination": b["names"][top[0][0]] if top else None,
                "lastOnDuty": S.dstr(b["last"]),
            }
        )
    rows = S.department_subtotals(
        rows,
        (
            "sessions",
            "daysOnDuty",
            "approved",
            "rejected",
            "pending",
            "punchesTotal",
            "punchesRejected",
            "mockedPunches",
        ),
    )
    data = [r for r in rows if r.get("_kind") != "subtotal"]
    busiest = max(data, key=lambda r: (r["sessions"], r["employeeCode"] or ""), default=None) if data else None
    return ReportResult(
        rows=rows,
        summary=[
            {"label": "Employees with on-duty", "value": len(data), "format": "integer"},
            {"label": "Sessions", "value": sum(r["sessions"] for r in data), "format": "integer"},
            {"label": "Approved on-duty days", "value": sum(r["daysOnDuty"] for r in data), "format": "integer"},
            {"label": "Mock-GPS punches", "value": sum(r["mockedPunches"] for r in data), "format": "integer"},
            {
                "label": "Most sessions",
                "value": f"{busiest['employeeName']} ({busiest['sessions']})" if busiest else None,
                "format": "text",
            },
        ],
        notes=[
            "Approved days = distinct IST dates with at least one HR-approved (Active or Completed) session; rejected "
            "days never count as attendance. Pending = still awaiting the HOD or HR decision. Last on duty = the latest "
            "such approved day (blank when none of the employee's requests was approved).",
            "Punch counts include every captured on-duty punch (approved, pending and rejected). Top destination = the "
            "destination typed most often in the period.",
        ],
    )


register(
    ReportSpec(
        id="on-duty-employee-summary",
        title="On-Duty Summary by Employee",
        description="Per employee: on-duty sessions and approved days, decisions, punches and mock-GPS flags.",
        category=S.CATEGORY,
        family="on-duty",
        variant="Employee summary",
        icon="Users",
        tags=("on duty", "on-duty", "summary", "employee"),
        modules=("geo_attendance",),
        filters=(F.date_range("thisMonth", "Request date"), *F.scope(status="all"), *_session_filter_specs()),
        columns=(
            *EMP_COLS,
            ColumnSpec("sessions", "Sessions", INTEGER, 1.0, total="sum"),
            ColumnSpec("daysOnDuty", "Approved days", INTEGER, 1.1, total="sum"),
            ColumnSpec("approved", "Approved", INTEGER, 1.1, total="sum"),
            ColumnSpec("rejected", "Rejected", INTEGER, 1.1, total="sum"),
            ColumnSpec("pending", "Pending", INTEGER, 1.0, total="sum"),
            ColumnSpec("punchesTotal", "Punches", INTEGER, 1.0, total="sum"),
            ColumnSpec("punchesRejected", "Punches rejected", INTEGER, 1.1, total="sum"),
            ColumnSpec("mockedPunches", "Mock GPS", INTEGER, 0.9, total="sum"),
            ColumnSpec("topDestination", "Top destination", TEXT, 2.0),
            ColumnSpec("lastOnDuty", "Last on duty", DATE, 1.4),
        ),
        run=_summary_run,
    )
)


# ── 3. Punch verification log (GPS & selfie audit) ──────────────────────────


def _punch_run(ctx) -> ReportResult:
    from api.models import OnDutyPunchVerification

    qs = OnDutyPunchVerification.objects.filter(
        ctx.emp_q("employee__"), punch_date__gte=ctx.date_from, punch_date__lte=ctx.date_to
    )
    if ctx.param("status"):
        qs = qs.filter(status=ctx.param("status"))
    if ctx.param("mockedOnly"):
        qs = qs.filter(is_mocked=True)
    if ctx.param("accuracyWorse"):
        qs = qs.filter(accuracy_m__gt=int(ctx.param("accuracyWorse")))
    punches = list(
        qs.select_related("employee__department", "employee__designation", "employee__branch", "session").order_by(
            "punch_date", "punch_time", "id"
        )[: ctx.row_limit]
    )
    rows = []
    counts: Counter = Counter()
    accuracies: list[float] = []
    mocked = 0
    counted = {v.id for v in S.shown(punches, ctx)}  # the extra row the runner uses to flag a cut is not counted
    for v in punches:
        lat, lng = f"{v.latitude:.6f}", f"{v.longitude:.6f}"
        if v.id in counted:
            if v.accuracy_m is not None:
                accuracies.append(v.accuracy_m)
            counts[v.status] += 1
            mocked += 1 if v.is_mocked else 0
        rows.append(
            {
                **S.base_cells(v.employee),
                "punchDate": v.punch_date.isoformat(),
                "punchTime": S.tstr(v.punch_time),
                "punchNumber": v.punch_number,
                "punchType": v.punch_type,
                "destination": v.session.destination,
                "latitude": lat,
                "longitude": lng,
                "accuracyM": r2(v.accuracy_m),
                "isMocked": "Mocked" if v.is_mocked else "Genuine",
                "hasPhoto": S.yes_no(bool(v.photo.name)),
                "mapLink": f"https://www.google.com/maps?q={lat},{lng}",
                "sessionStatus": status_label(v.session.status),
                "status": (v.status or "").title() or None,
                "hrReviewedBy": v.hr_reviewed_by,
                "hrReviewedAt": fmt_dt(v.hr_reviewed_at),
                "hrReviewComment": v.hr_review_comment,
            }
        )
    return ReportResult(
        rows=rows,
        summary=[
            {"label": "Punches", "value": len(counted), "format": "integer"},
            {"label": "Approved", "value": counts["approved"], "format": "integer"},
            {"label": "Pending", "value": counts["pending"], "format": "integer"},
            {"label": "Rejected", "value": counts["rejected"], "format": "integer"},
            {"label": "Mock-GPS punches", "value": mocked, "format": "integer"},
            {
                "label": "Average accuracy (m)",
                "value": round(sum(accuracies) / len(accuracies), 1) if accuracies else None,
                "format": "number",
            },
        ],
        notes=[
            "Date and time are the punch as captured on the device (IST). Coordinates are exact; open the map link to "
            "see the spot. Accuracy is the GPS error radius in metres: the larger, the less reliable.",
            "Selfies are not included in exports; 'Photo' only says whether one was captured. Photos are viewed in the "
            "Geo Attendance screen.",
            "A punch under a session that is still pending stays Pending until HR decides the session; punches "
            "voided by a rejected request carry the comment 'Voided automatically ...'.",
            *S.cut_note(punches, ctx),
        ],
    )


register(
    ReportSpec(
        id="on-duty-punch-verification-log",
        title="On-Duty Punch Verification Log",
        description="Every GPS and selfie on-duty punch with location, accuracy, mock-GPS flag and HR decision, for audit.",
        category=S.CATEGORY,
        family="on-duty",
        variant="Punch verification",
        icon="Fingerprint",
        tags=("on duty", "gps", "selfie", "mock location", "audit", "punch"),
        modules=("geo_attendance",),
        filters=(
            F.date_range("thisMonth", "Punch date"),
            *F.scope(status="all"),
            F.select(
                "status", "Punch status", (("pending", "Pending"), ("approved", "Approved"), ("rejected", "Rejected"))
            ),
            F.boolean("mockedOnly", "Only mock-GPS punches"),
            F.select(
                "accuracyWorse",
                "GPS accuracy",
                (("50", "Worse than 50 m"), ("100", "Worse than 100 m"), ("200", "Worse than 200 m")),
            ),
        ),
        columns=(
            *S.LEAD_COLS,
            S.BRANCH_COL,
            ColumnSpec("punchDate", "Date", DATE, 1.35),
            ColumnSpec("punchTime", "Time", TIME, 0.7),
            ColumnSpec("punchNumber", "Punch no.", INTEGER, 0.7),
            ColumnSpec("punchType", "In/Out", BADGE, 0.7),
            ColumnSpec("destination", "Destination", TEXT, 1.8),
            ColumnSpec("latitude", "Latitude", TEXT, 1.0),
            ColumnSpec("longitude", "Longitude", TEXT, 1.0),
            ColumnSpec("accuracyM", "Accuracy (m)", NUMBER, 0.9),
            ColumnSpec("isMocked", "GPS", BADGE, 0.9),
            ColumnSpec("hasPhoto", "Photo", BADGE, 0.7),
            ColumnSpec("mapLink", "Map", TEXT, 2.4),
            ColumnSpec("sessionStatus", "Session", BADGE, 0.9),
            ColumnSpec("status", "Punch status", BADGE, 0.9),
            ColumnSpec("hrReviewedBy", "Reviewed by", TEXT, 1.2),
            ColumnSpec("hrReviewedAt", "Reviewed on", DATETIME, 1.4),
            ColumnSpec("hrReviewComment", "HR comment", TEXT, 1.8),
        ),
        run=_punch_run,
    )
)

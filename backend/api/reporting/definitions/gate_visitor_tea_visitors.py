"""Gate reports on VISITORS (report group G9).

Data: ``VisitorVisit`` (one row per physical visit, check-in only) + ``Visitor`` (identity, deduplicated by the
exact phone string). Visits are scoped to a branch through ``VisitorVisit.branch`` (the branch whose QR was
scanned); a visit with no branch is visible to unscoped users only.

What does NOT exist, and is therefore never faked: check-out time, visit duration, company, vehicle, photo, ID
type. "Currently inside" cannot be derived.

Privacy: the full Aadhaar number is never read into Python -- only ``RIGHT(TRIM(aadhaar), 4)`` is selected and
printed as ``XXXX XXXX 1234``. Phone numbers appear only in the two per-person listings (register, repeat
visitors), never in the aggregate summaries.
"""

from __future__ import annotations

from datetime import date

from django.db.models import Avg, Case, Count, F, Max, Min, OuterRef, Q, Subquery, TextField, Value, When
from django.db.models.functions import Cast, Concat, Right, Trim

from ..filters import branches, date_range, departments, employees, select, text
from ..formatting import fmt_dt
from ..registry import register
from ..types import BADGE, DATE, DATETIME, INTEGER, TEXT, ColumnSpec, ReportResult, ReportSpec
from . import gate_visitor_tea_common as C

# ── shared filter definitions ────────────────────────────────────────────────

_HOST_LINKED = select(
    "hostLinked", "Host", [("linked_employee", "Linked to an employee"), ("free_text", "Free-text host only")],
    placeholder="All hosts",
)
_NOTE_PHONE_VARIANTS = (
    "A visitor is identified by the exact phone number typed at the gate, so the same person entered once with and "
    "once without the +91 country code (or with different spacing) appears as two visitors."
)


def _visit_no_note(ctx) -> str:
    who = "your branch's visits" if C.get_branch_scope(ctx.request) is not None else "all recorded visits"
    return f"Visit no. 1 = the visitor's first visit in {who}, whatever the filters."


# ═════════════════════════════════════════════════════════════════════════════
# visitor-register
# ═════════════════════════════════════════════════════════════════════════════

_NOTIFICATION_OPTIONS = [
    ("email_sent", "Host was emailed"),
    ("whatsapp_sent", "Host was sent WhatsApp"),
    ("either", "Host notified on either channel"),
    ("neither", "Host not notified"),
]


def _apply_notification(qs, mode):
    if mode == "email_sent":
        return qs.filter(notified_email_at__isnull=False)
    if mode == "whatsapp_sent":
        return qs.filter(notified_whatsapp_at__isnull=False)
    if mode == "either":
        return qs.filter(Q(notified_email_at__isnull=False) | Q(notified_whatsapp_at__isnull=False))
    if mode == "neither":
        return qs.filter(notified_email_at__isnull=True, notified_whatsapp_at__isnull=True)
    return qs


def _run_register(ctx):
    qs = C.visit_queryset(ctx, with_visit_no=True)
    vtype = ctx.params.get("visitorType")
    if vtype == "first_visit":
        qs = qs.filter(visit_no=1)
    elif vtype == "repeat":
        qs = qs.filter(visit_no__gt=1)
    qs = _apply_notification(qs, ctx.params.get("notification"))
    needle = ctx.params.get("q")
    if needle:
        qs = qs.filter(Q(visitor__name__icontains=needle) | Q(visitor__phone__icontains=needle))

    rows_qs = (
        qs.annotate(aad_tail=Right(Trim("visitor__aadhaar_number"), 4))
        .values(
            "id", "visited_at", "visitor__name", "visitor__phone", "aad_tail", "why_came", "whom_to_meet", "purpose",
            "branch__name", "meeting_employee_id", "meeting_employee__employee_code", "meeting_employee__first_name",
            "meeting_employee__last_name", "meeting_employee__department__name", "notified_email_at",
            "notified_whatsapp_at", "visit_no",
        )
        .order_by("visited_at", "id")
    )
    rows = []
    for r in rows_qs[: ctx.row_limit]:
        linked = r["meeting_employee_id"] is not None
        rows.append({
            "visitedAt": fmt_dt(r["visited_at"]),
            "visitorName": r["visitor__name"],
            "phone": r["visitor__phone"],
            "aadhaarMasked": C.mask_aadhaar(r["aad_tail"]),
            "whyCame": r["why_came"],
            "whomToMeet": r["whom_to_meet"],
            "hostCode": r["meeting_employee__employee_code"],
            "hostName": C.person_name(r["meeting_employee__first_name"], r["meeting_employee__last_name"]) if linked else None,
            "hostDepartment": r["meeting_employee__department__name"] if linked else None,
            "purpose": r["purpose"],
            "branch": r["branch__name"],
            "visitNo": r["visit_no"],
            "visitorType": "First visit" if r["visit_no"] == 1 else "Repeat",
            "emailNotified": C.sent_badge(r["notified_email_at"], linked),
            "whatsappNotified": C.sent_badge(r["notified_whatsapp_at"], linked),
        })

    agg = qs.aggregate(
        visits=Count("id"),
        unique=Count("visitor_id", distinct=True),
        first=Count("id", filter=Q(visit_no=1)),
        linked=Count("id", filter=Q(meeting_employee__isnull=False)),
        emailed=Count("id", filter=Q(notified_email_at__isnull=False)),
        whatsapped=Count("id", filter=Q(notified_whatsapp_at__isnull=False)),
    )
    summary = [
        {"label": "Visits", "value": agg["visits"], "format": "integer"},
        {"label": "Unique visitors", "value": agg["unique"], "format": "integer"},
        {"label": "First-time visits", "value": agg["first"], "format": "integer"},
        {"label": "Repeat visits", "value": agg["visits"] - agg["first"], "format": "integer"},
        {"label": "With a linked host employee", "value": agg["linked"], "format": "integer"},
        {"label": "Host emailed", "value": agg["emailed"], "format": "integer"},
        {"label": "Host sent WhatsApp", "value": agg["whatsapped"], "format": "integer"},
    ]
    notes = [
        "One row per check-in. The system records no check-out time, duration, company or vehicle, so none are shown.",
        "Aadhaar numbers are masked to the last 4 digits in this report and both exports.",
        "'Why came' is only captured on a visitor's first visit, so it is blank for repeat visits.",
        "Host notification: 'Not sent' means it was not sent OR could not be sent (no email/phone on file, channel "
        "switched off); the failure reason is not stored. Visits with a free-text host have no one to notify (dash).",
        _visit_no_note(ctx),
        _NOTE_PHONE_VARIANTS,
    ]
    branch_split = list(qs.order_by().values("branch__name").annotate(n=Count("id")).order_by("branch__name"))
    if len(branch_split) > 1:
        notes.append("Visits by branch: " + "; ".join(f"{b['branch__name'] or 'No branch'} {b['n']}" for b in branch_split) + ".")
    note = C.host_filter_note(ctx)
    if note:
        notes.append(note)
    return ReportResult(rows=rows, summary=summary, notes=notes)


register(ReportSpec(
    id="visitor-register",
    title="Visitor Register",
    description="Every visitor check-in with who they met, purpose and whether the host was notified; Aadhaar masked.",
    category=C.CATEGORY,
    icon="UserRound",
    tags=("visitor", "visitors", "reception", "guest", "visit", "gate", "check-in"),
    family="visitors",
    variant="Register",
    modules=C.MODULES,
    filters=(
        date_range("thisMonth", "Visit date"),
        branches(),
        departments("Host department"),
        employees("Host employee"),
        _HOST_LINKED,
        select("visitorType", "Visitor type", [("first_visit", "First visit only"), ("repeat", "Repeat visits only")], placeholder="All visits"),
        select("notification", "Host notification", _NOTIFICATION_OPTIONS, placeholder="Any"),
        text("q", "Visitor name / phone", "Search"),
    ),
    columns=(
        ColumnSpec("visitedAt", "Visited at", DATETIME, 1.4),
        ColumnSpec("visitorName", "Visitor", TEXT, 1.8),
        ColumnSpec("phone", "Phone", TEXT, 1.2),
        ColumnSpec("aadhaarMasked", "Aadhaar", TEXT, 1.3),
        ColumnSpec("whyCame", "Why came", TEXT, 1.5),
        ColumnSpec("whomToMeet", "Whom to meet", TEXT, 1.5),
        ColumnSpec("hostCode", "Host code", TEXT, 0.9),
        ColumnSpec("hostName", "Host employee", TEXT, 1.6),
        ColumnSpec("hostDepartment", "Host dept", TEXT, 1.3),
        ColumnSpec("purpose", "Purpose", TEXT, 1.8),
        ColumnSpec("branch", "Branch", TEXT, 1.0),
        ColumnSpec("visitNo", "Visit no.", INTEGER, 0.7),
        ColumnSpec("visitorType", "Type", BADGE, 0.9),
        ColumnSpec("emailNotified", "Email", BADGE, 0.8),
        ColumnSpec("whatsappNotified", "WhatsApp", BADGE, 0.8),
    ),
    run=_run_register,
))


# ═════════════════════════════════════════════════════════════════════════════
# visitor-host-summary
# ═════════════════════════════════════════════════════════════════════════════


def _run_host_summary(ctx):
    qs = C.visit_queryset(ctx)
    measures = dict(
        visits=Count("id"),
        unique=Count("visitor_id", distinct=True),
        first=Min("visited_at"),
        last=Max("visited_at"),
        emailed=Count("id", filter=Q(notified_email_at__isnull=False)),
        whatsapped=Count("id", filter=Q(notified_whatsapp_at__isnull=False)),
    )
    linked = (
        qs.filter(meeting_employee__isnull=False)
        .values(
            "meeting_employee_id", "meeting_employee__employee_code", "meeting_employee__first_name",
            "meeting_employee__last_name", "meeting_employee__department__name",
        )
        .annotate(**measures)
        .order_by()
    )
    free = (
        qs.filter(meeting_employee__isnull=True)
        .annotate(host_key=C.free_text_host_key())
        .values("host_key")
        .annotate(host_name=Min(Trim("whom_to_meet")), **measures)
        .order_by()
    )
    rows = []
    for r in linked:
        rows.append({
            "hostType": "Employee",
            "hostCode": r["meeting_employee__employee_code"],
            "hostName": C.person_name(r["meeting_employee__first_name"], r["meeting_employee__last_name"]),
            "department": r["meeting_employee__department__name"] or "Unassigned",
            "visits": r["visits"], "uniqueVisitors": r["unique"],
            "firstVisitAt": fmt_dt(r["first"]), "lastVisitAt": fmt_dt(r["last"]),
            "emailSent": r["emailed"], "whatsappSent": r["whatsapped"],
        })
    for r in free:
        rows.append({
            "hostType": "Free text",
            "hostCode": None,
            "hostName": r["host_name"] or "(blank)",
            "department": None,
            "visits": r["visits"], "uniqueVisitors": r["unique"],
            "firstVisitAt": fmt_dt(r["first"]), "lastVisitAt": fmt_dt(r["last"]),
            "emailSent": r["emailed"], "whatsappSent": r["whatsapped"],
        })
    rows.sort(key=lambda x: (-x["visits"], (x["hostName"] or "").lower(), x["hostType"] != "Employee", x["hostCode"] or ""))
    rows = rows[: ctx.row_limit]

    total = sum(r["visits"] for r in rows)
    free_visits = sum(r["visits"] for r in rows if r["hostType"] == "Free text")
    top = rows[0] if rows else None
    summary = [
        {"label": "Visits", "value": total, "format": "integer"},
        {"label": "Hosts", "value": len(rows), "format": "integer"},
        {"label": "Visits with no linked employee", "value": C.pct(free_visits, total), "format": "percent"},
        {
            "label": "Most visited host",
            "value": f"{top['hostName']} ({top['visits']})" if top else None, "format": "text",
        },
    ]
    notes = [
        "Employee hosts are visits where the gate form matched the person met to an employee (by phone). Everything "
        "else is grouped by the free text typed, case-insensitively; spelling variants of one person stay separate rows.",
        "Host department is the host's CURRENT department. Unique visitors are counted per host, so they do not add "
        "up across rows.",
        _NOTE_PHONE_VARIANTS,
    ]
    note = C.host_filter_note(ctx)
    if note:
        notes.append(note)
    return ReportResult(rows=rows, summary=summary, notes=notes)


register(ReportSpec(
    id="visitor-host-summary",
    title="Visitors by Host",
    description="Which employees (or free-text hosts) receive the most visitors, with unique visitors and notification counts.",
    category=C.CATEGORY,
    icon="Handshake",
    tags=("visitor", "host", "person met", "whom to meet"),
    family="visitors",
    variant="By host",
    modules=C.MODULES,
    filters=(
        date_range("thisMonth", "Visit date"),
        branches(),
        departments("Host department"),
        employees("Host employee"),
        _HOST_LINKED,
    ),
    columns=(
        ColumnSpec("hostType", "Host type", BADGE, 0.9),
        ColumnSpec("hostCode", "Host code", TEXT, 0.9),
        ColumnSpec("hostName", "Host", TEXT, 2.2),
        ColumnSpec("department", "Department", TEXT, 1.5),
        ColumnSpec("visits", "Visits", INTEGER, 0.8, total="sum"),
        ColumnSpec("uniqueVisitors", "Unique visitors", INTEGER, 1.0),
        ColumnSpec("firstVisitAt", "First visit", DATETIME, 1.3),
        ColumnSpec("lastVisitAt", "Last visit", DATETIME, 1.3),
        ColumnSpec("emailSent", "Emailed", INTEGER, 0.8, total="sum"),
        ColumnSpec("whatsappSent", "WhatsApp sent", INTEGER, 0.9, total="sum"),
    ),
    run=_run_host_summary,
))


# ═════════════════════════════════════════════════════════════════════════════
# visitor-frequency
# ═════════════════════════════════════════════════════════════════════════════


def _run_frequency(ctx):
    from api.models import Visitor, VisitorVisit

    lo, hi = C.ist_bounds(ctx.date_from, ctx.date_to)
    scope = C.branch_q(ctx, "visits__branch_id")  # branch isolation AND the branch filter, for every count
    period = scope & Q(visits__visited_at__gte=lo, visits__visited_at__lt=hi)

    latest = (
        VisitorVisit.objects.filter(C.branch_q(ctx, "branch_id"), C.in_range("visited_at", ctx), visitor_id=OuterRef("pk"))
        .order_by("-visited_at", "-id")
    )
    host_key = Case(
        When(
            visits__meeting_employee_id__isnull=False,
            then=Concat(Value("e"), Cast("visits__meeting_employee_id", TextField()), output_field=TextField()),
        ),
        default=Concat(Value("t"), C.free_text_host_key("visits__whom_to_meet"), output_field=TextField()),
        output_field=TextField(),
    )
    qs = Visitor.objects.annotate(
        in_period=Count("visits", filter=period),
        ever=Count("visits", filter=scope or None),
        first_visit=Min("visits__visited_at", filter=scope or None),
        last_visit=Max("visits__visited_at", filter=period),
        hosts=Count(host_key, filter=period, distinct=True),
        last_host=Subquery(latest.values("whom_to_meet")[:1]),
        last_purpose=Subquery(latest.values("purpose")[:1]),
        aad_tail=Right(Trim("aadhaar_number"), 4),
    ).filter(in_period__gte=max(1, int(ctx.params.get("minVisits") or 1)))
    vtype = ctx.params.get("visitorType")
    if vtype == "new_in_period":
        qs = qs.filter(first_visit__gte=lo)
    elif vtype == "returning":
        qs = qs.filter(first_visit__lt=lo)
    needle = ctx.params.get("q")
    if needle:
        qs = qs.filter(Q(name__icontains=needle) | Q(phone__icontains=needle))

    fetched = list(
        qs.order_by("-in_period", "-ever", "name", "id").values(
            "id", "name", "phone", "aad_tail", "first_visit", "in_period", "ever", "last_visit", "hosts", "last_host", "last_purpose",
        )[: ctx.row_limit]
    )
    rows = []
    for r in fetched:
        rows.append({
            "visitorName": r["name"],
            "phone": r["phone"],
            "aadhaarMasked": C.mask_aadhaar(r["aad_tail"]),
            "firstSeenAt": fmt_dt(r["first_visit"]),
            "visitsInPeriod": r["in_period"],
            "totalVisitsEver": r["ever"],
            "lastVisitAt": fmt_dt(r["last_visit"]),
            "distinctHosts": r["hosts"],
            "lastHost": r["last_host"],
            "lastPurpose": r["last_purpose"],
        })

    notes = [
        "Visitors with at least one visit in the period. 'Total visits' counts every visit ever recorded for that "
        "visitor" + (" at your branch" if C.get_branch_scope(ctx.request) is not None else "") + ", not just the period.",
        "'First seen' is the visitor's first recorded visit. 'Distinct hosts' counts employees and free-text names "
        "met in the period (free text compared case-insensitively).",
        "Phone numbers are shown so that two visitors with the same name can be told apart; Aadhaar is masked to the last 4 digits.",
        _NOTE_PHONE_VARIANTS,
    ]
    if len(fetched) >= ctx.row_limit:
        return ReportResult(rows=rows, notes=notes + ["Summary cards are omitted because the list is longer than the row limit."])
    new_count = sum(1 for r in fetched if lo is not None and r["first_visit"] is not None and r["first_visit"] >= lo)
    top = fetched[0] if fetched else None
    summary = [
        {"label": "Unique visitors", "value": len(fetched), "format": "integer"},
        {"label": "New in period", "value": new_count, "format": "integer"},
        {"label": "Returning", "value": len(fetched) - new_count, "format": "integer"},
        {"label": "Most frequent visitor", "value": f"{top['name']} ({top['in_period']})" if top else None, "format": "text"},
    ]
    return ReportResult(rows=rows, summary=summary, notes=notes)


register(ReportSpec(
    id="visitor-frequency",
    title="Repeat Visitor Report",
    description="Visitors ranked by number of visits, with first-seen date, hosts met and the latest purpose.",
    category=C.CATEGORY,
    icon="History",
    tags=("visitor", "repeat", "frequent", "returning"),
    modules=C.MODULES,
    filters=(
        date_range("thisMonth", "Visit date"),
        branches(),
        select(
            "minVisits", "Minimum visits in period",
            [("2", "2 or more"), ("3", "3 or more"), ("5", "5 or more"), ("10", "10 or more")], placeholder="1 or more",
        ),
        select(
            "visitorType", "Visitor type",
            [("new_in_period", "First seen in the period"), ("returning", "Seen before the period")], placeholder="All",
        ),
        text("q", "Visitor name / phone", "Search"),
    ),
    columns=(
        ColumnSpec("visitorName", "Visitor", TEXT, 2.0),
        ColumnSpec("phone", "Phone", TEXT, 1.2),
        ColumnSpec("aadhaarMasked", "Aadhaar", TEXT, 1.3),
        ColumnSpec("firstSeenAt", "First seen", DATETIME, 1.3),
        ColumnSpec("visitsInPeriod", "Visits in period", INTEGER, 0.9, total="sum"),
        ColumnSpec("totalVisitsEver", "Total visits", INTEGER, 0.9),
        ColumnSpec("lastVisitAt", "Last visit", DATETIME, 1.3),
        ColumnSpec("distinctHosts", "Distinct hosts", INTEGER, 0.9),
        ColumnSpec("lastHost", "Last person met", TEXT, 1.6),
        ColumnSpec("lastPurpose", "Last purpose", TEXT, 2.0),
    ),
    run=_run_frequency,
))


# ═════════════════════════════════════════════════════════════════════════════
# visitor-daily-summary
# ═════════════════════════════════════════════════════════════════════════════


def _run_daily(ctx):
    qs = C.visit_queryset(ctx, with_visit_no=True)
    day = C.ist_day_expr("visited_at")
    per_day = {
        r["d"]: r
        for r in qs.annotate(d=day).values("d").annotate(
            visits=Count("id"),
            unique=Count("visitor_id", distinct=True),
            first=Count("id", filter=Q(visit_no=1)),
            linked=Count("id", filter=Q(meeting_employee__isnull=False)),
        ).order_by()
    }
    hours: dict[date, dict[int, int]] = {}
    for r in qs.annotate(d=day, h=C.ist_hour_expr("visited_at")).values("d", "h").annotate(n=Count("id")).order_by():
        hours.setdefault(r["d"], {})[r["h"]] = r["n"]

    rows = []
    for d in ctx.days_in_range:
        r = per_day.get(d)
        visits = r["visits"] if r else 0
        rows.append({
            "date": d.isoformat(),
            "weekday": C.weekday_name(d),
            "visits": visits,
            "uniqueVisitors": r["unique"] if r else 0,
            "firstTime": r["first"] if r else 0,
            "repeat": (r["visits"] - r["first"]) if r else 0,
            "hostLinked": r["linked"] if r else 0,
            "peakHour": C.peak_hour_text(hours.get(d, {})),
        })

    total = sum(r["visits"] for r in rows)
    busiest = max(
        (r for r in rows if r["visits"]), key=lambda r: (r["visits"], -date.fromisoformat(r["date"]).toordinal()), default=None,
    )
    overall_unique = qs.order_by().values("visitor_id").distinct().count()
    summary = [
        {"label": "Visits", "value": total, "format": "integer"},
        {"label": "Unique visitors in period", "value": overall_unique, "format": "integer"},
        {"label": "Daily average (calendar days)", "value": round(total / len(rows), 1) if rows else None, "format": "number"},
        {
            "label": "Busiest day",
            "value": f"{busiest['date']} ({busiest['visits']})" if busiest else None, "format": "text",
        },
    ]
    notes = [
        "Days are Indian Standard Time days; days with no visits are listed with zero. Peak hour is the busiest "
        "check-in hour of that day (earlier hour wins a tie).",
        "'Unique visitors' is per day, so it does not add up across days (see the summary card for the period).",
        _visit_no_note(ctx),
    ]
    return ReportResult(rows=rows, summary=summary, notes=notes)


register(ReportSpec(
    id="visitor-daily-summary",
    title="Visitor Daily Summary",
    description="Day-wise visitor volumes with the first-time / repeat split and the peak check-in hour.",
    category=C.CATEGORY,
    icon="CalendarDays",
    tags=("visitor", "daily", "trend", "footfall"),
    family="visitors",
    variant="Daily",
    modules=C.MODULES,
    filters=(date_range("thisMonth", "Visit date"), branches(), _HOST_LINKED),
    columns=(
        ColumnSpec("date", "Date", DATE, 1.1),
        ColumnSpec("weekday", "Day", TEXT, 0.7),
        ColumnSpec("visits", "Visits", INTEGER, 0.8, total="sum"),
        ColumnSpec("uniqueVisitors", "Unique visitors", INTEGER, 1.0),
        ColumnSpec("firstTime", "First-time", INTEGER, 0.9, total="sum"),
        ColumnSpec("repeat", "Repeat", INTEGER, 0.8, total="sum"),
        ColumnSpec("hostLinked", "Host linked", INTEGER, 0.9, total="sum"),
        ColumnSpec("peakHour", "Peak hour", TEXT, 1.1),
    ),
    run=_run_daily,
))


# ═════════════════════════════════════════════════════════════════════════════
# visitor-notification-delivery
# ═════════════════════════════════════════════════════════════════════════════

_DELIVERY_STATES = [
    ("both_sent", "Email and WhatsApp sent"),
    ("email_only", "Email only"),
    ("whatsapp_only", "WhatsApp only"),
    ("none_sent", "Nothing sent"),
]


def _delay_seconds(sent_at, visited_at) -> int | None:
    if sent_at is None or visited_at is None:
        return None
    return int(round((sent_at - visited_at).total_seconds()))


def _run_notification(ctx):
    qs = C.visit_queryset(ctx).filter(meeting_employee__isnull=False)
    state = ctx.params.get("deliveryState")
    has_email, has_wa = Q(notified_email_at__isnull=False), Q(notified_whatsapp_at__isnull=False)
    if state == "both_sent":
        qs = qs.filter(has_email, has_wa)
    elif state == "email_only":
        qs = qs.filter(has_email, ~has_wa)
    elif state == "whatsapp_only":
        qs = qs.filter(~has_email, has_wa)
    elif state == "none_sent":
        qs = qs.filter(~has_email, ~has_wa)

    fetched = (
        qs.values(
            "visited_at", "visitor__name", "meeting_employee_id", "meeting_employee__first_name",
            "meeting_employee__last_name", "meeting_employee__department__name", "meeting_employee__email",
            "meeting_employee__phone", "notified_email_at", "notified_whatsapp_at",
        )
        .order_by("visited_at", "id")[: ctx.row_limit]
    )
    rows = []
    for r in fetched:
        rows.append({
            "visitedAt": fmt_dt(r["visited_at"]),
            "visitorName": r["visitor__name"],
            "hostName": C.person_name(r["meeting_employee__first_name"], r["meeting_employee__last_name"]),
            "hostDepartment": r["meeting_employee__department__name"] or "Unassigned",
            "hostHasEmail": "Yes" if (r["meeting_employee__email"] or "").strip() else "No",
            "hostHasPhone": "Yes" if (r["meeting_employee__phone"] or "").strip() else "No",
            "emailSentAt": fmt_dt(r["notified_email_at"]),
            "emailDelaySeconds": _delay_seconds(r["notified_email_at"], r["visited_at"]),
            "whatsappSentAt": fmt_dt(r["notified_whatsapp_at"]),
            "whatsappDelaySeconds": _delay_seconds(r["notified_whatsapp_at"], r["visited_at"]),
        })

    no_email = Q(meeting_employee__email__isnull=True) | Q(meeting_employee__email="")
    no_phone = Q(meeting_employee__phone__isnull=True) | Q(meeting_employee__phone="")
    agg = qs.aggregate(
        visits=Count("id"),
        emailed=Count("id", filter=has_email),
        whatsapped=Count("id", filter=has_wa),
        hosts_no_email=Count("meeting_employee_id", distinct=True, filter=no_email),
        hosts_no_phone=Count("meeting_employee_id", distinct=True, filter=no_phone),
        avg_email=Avg(F("notified_email_at") - F("visited_at")),
        avg_wa=Avg(F("notified_whatsapp_at") - F("visited_at")),
    )
    summary = [
        {"label": "Visits with a linked host", "value": agg["visits"], "format": "integer"},
        {"label": "Email delivered", "value": C.pct(agg["emailed"], agg["visits"]), "format": "percent"},
        {"label": "WhatsApp delivered", "value": C.pct(agg["whatsapped"], agg["visits"]), "format": "percent"},
        {
            "label": "Avg email delay (s)",
            "value": round(agg["avg_email"].total_seconds()) if agg["avg_email"] is not None else None, "format": "integer",
        },
        {
            "label": "Avg WhatsApp delay (s)",
            "value": round(agg["avg_wa"].total_seconds()) if agg["avg_wa"] is not None else None, "format": "integer",
        },
        {"label": "Hosts with no email on file", "value": agg["hosts_no_email"], "format": "integer"},
        {"label": "Hosts with no phone on file", "value": agg["hosts_no_phone"], "format": "integer"},
    ]
    notes = [
        "Only visits where the visitor's host was matched to an employee are listed - a free-text host cannot be notified.",
        "A blank 'sent at' means the message was not sent OR could not be sent (SMTP or WhatsApp not configured, no "
        "email/phone on file); the visit does not record why. WhatsApp is delivered asynchronously, so its time can lag.",
        "Delivery rates are the share of these visits whose host was notified on that channel. Delays are seconds "
        "from check-in; email addresses and phone numbers themselves are not shown.",
    ]
    return ReportResult(rows=rows, summary=summary, notes=notes)


register(ReportSpec(
    id="visitor-notification-delivery",
    title="Visitor Host Notification Status",
    description="For visits tied to an employee host: was the host notified by email and WhatsApp, and how fast.",
    category=C.CATEGORY,
    icon="Smartphone",
    tags=("visitor", "notification", "whatsapp", "email", "host"),
    modules=C.MODULES,
    filters=(
        date_range("thisMonth", "Visit date"),
        branches(),
        departments("Host department"),
        employees("Host employee"),
        select("deliveryState", "Delivery", _DELIVERY_STATES, placeholder="Any"),
    ),
    columns=(
        ColumnSpec("visitedAt", "Visited at", DATETIME, 1.4),
        ColumnSpec("visitorName", "Visitor", TEXT, 1.8),
        ColumnSpec("hostName", "Host", TEXT, 2.0),
        ColumnSpec("hostDepartment", "Host dept", TEXT, 1.4),
        ColumnSpec("hostHasEmail", "Host email on file", BADGE, 0.9),
        ColumnSpec("hostHasPhone", "Host phone on file", BADGE, 0.9),
        ColumnSpec("emailSentAt", "Email sent at", DATETIME, 1.4),
        ColumnSpec("emailDelaySeconds", "Email delay (s)", INTEGER, 0.9),
        ColumnSpec("whatsappSentAt", "WhatsApp sent at", DATETIME, 1.4),
        ColumnSpec("whatsappDelaySeconds", "WhatsApp delay (s)", INTEGER, 0.9),
    ),
    run=_run_notification,
))

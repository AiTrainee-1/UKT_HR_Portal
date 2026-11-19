"""
Outpass / Visitors -pure gate data-collection, no attendance/payroll/leave
link whatsoever. Two independent flows sharing one shape:

  HR portal (this app's own login, @require_hr, branch-scoped via
  branch_scope.py exactly like attendance_views.py):
    - GET  <kind>/qr        get-or-create the permanent per-branch QR token
    - GET  <kind>/summary   today/week/month KPI counts
    - GET  <kind>/records   filtered list

  Public gate form (no auth at all -reached only via the QR's URL, same
  AllowAny-by-default shape as verify_employee in growth_views.py and
  _applicants_submit in views.py):
    - GET  <kind>/gate/<token>            resolve token -> branch name
    - POST outpass/gate/<token>/submit    outpass submission
    - POST visitor/gate/<token>/check-phone / new / repeat   visitor flow

"Today/week/month" boundaries are computed in the factory's own Asia/Kolkata
calendar (clock.py's FACTORY_TZ), not in the server's UTC clock -matching
attendance's own reasoning (clock.py's module docstring) rather than
audit_logs_stats' simpler UTC-midnight boundary, since a gate submission at
say 10:30pm IST should count as "today" even though it's already tomorrow in
UTC.
"""
from __future__ import annotations

from datetime import date, datetime, time, timedelta
from decimal import ROUND_HALF_UP, Decimal

from django.db.models import Avg, Count, F, Func, IntegerField, OuterRef, Q, Subquery, TextField, Value
from django.db.models.functions import Coalesce
from django.utils import timezone
from rest_framework.decorators import api_view
from rest_framework.request import Request
from rest_framework.response import Response

from .auth import require_hr
from .branch_scope import get_branch_scope, scope_to_branch
from .clock import FACTORY_TZ
from .employee_photo import employee_photo_link, photo_links
from .models import Branch, Employee, GateQRCode, OutpassRecord, Visitor, VisitorVisit
from .throttles import throttle
from .user_settings import settings_for_employee


# ── Shared helpers ───────────────────────────────────────────────────────────

def _now():
    """The current instant (aware). One place, so tests can stand the clock at an IST day edge."""
    return timezone.now()


def _range_bounds(now=None):
    """(today_start, week_start, month_start), all in Asia/Kolkata."""
    now_ist = (now or _now()).astimezone(FACTORY_TZ)
    today_start = now_ist.replace(hour=0, minute=0, second=0, microsecond=0)
    week_start = today_start - timedelta(days=today_start.weekday())
    month_start = today_start.replace(day=1)
    return today_start, week_start, month_start


def _range_start(range_key: str):
    today_start, week_start, month_start = _range_bounds()
    if range_key == "week":
        return week_start
    if range_key == "month":
        return month_start
    return today_start


DEFAULT_PAGE_SIZE = 20
MAX_PAGE_SIZE = 100


def _paginate_params(request: Request) -> tuple[int, int]:
    try:
        page = int(request.query_params.get("page", 1))
    except (TypeError, ValueError):
        page = 1
    try:
        page_size = int(request.query_params.get("pageSize", DEFAULT_PAGE_SIZE))
    except (TypeError, ValueError):
        page_size = DEFAULT_PAGE_SIZE
    return max(1, page), max(1, min(page_size, MAX_PAGE_SIZE))


def _resolve_branch_for_qr(request: Request) -> Branch | None:
    """A branch-scoped HR user always gets their own branch, ignoring any
    query param -only an unscoped user (super admin / branch-less role) may
    pick a branch via ?branchId=, since letting a scoped user override this
    would leak another branch's permanent QR token to them."""
    branch_id = get_branch_scope(request)
    if branch_id is None:
        branch_id = request.query_params.get("branchId")
        if not branch_id:
            return None
    return Branch.objects.filter(id=branch_id).first()


def _gate_qr_or_none(token: str, kind: str) -> GateQRCode | None:
    return GateQRCode.objects.filter(token=token, kind=kind).select_related("branch").first()


def _create_outpass_record_for(employee: Employee, destination: str, source: str) -> OutpassRecord:
    """Shared with outpass_request_views.py (manual/HR/HOD-approved requests)
    and geo_attendance_views.py::_create_outpass_from_on_duty -every path
    that produces an Outpass ends up creating exactly this same row shape,
    so the HR Outpass page (outpass_qr/summary/records above) needs no
    changes at all to show requests approved outside the QR flow."""
    return OutpassRecord.objects.create(
        branch=employee.branch,
        employee=employee,
        employee_name=f"{employee.first_name} {employee.last_name}",
        employee_code=employee.employee_code,
        destination=destination,
        source=source,
    )


_QR_NOT_FOUND = Response({"error": "This QR code is not recognized."}, status=404)


def _digits_only(raw: str | None) -> str:
    return "".join(ch for ch in (raw or "") if ch.isdigit())


def _find_employee_by_phone(raw_phone: str) -> Employee | None:
    """Employee.phone is free-text (no formatting guarantee -see
    whatsapp_service.normalize_phone's own docstring), so an exact match is
    tried first (fast, cheap) and a digits-only comparison is the fallback
    for anything typed with different spacing/punctuation/country-code
    presence. Matches on the LAST 10 digits so a visitor typing a number
    with or without a country code both still resolve to the same person."""
    raw_phone = (raw_phone or "").strip()
    if not raw_phone:
        return None

    exact = Employee.objects.filter(phone=raw_phone).first()
    if exact:
        return exact

    digits = _digits_only(raw_phone)
    if len(digits) < 7:
        return None
    tail = digits[-10:]
    for emp in Employee.objects.exclude(phone__isnull=True).exclude(phone="").only("id", "phone"):
        if _digits_only(emp.phone)[-10:] == tail:
            return Employee.objects.select_related("department", "designation").get(pk=emp.pk)
    return None


def _employee_contact_json(emp: Employee, photos: dict | None = None) -> dict:
    """The photo is a signed link (employee_photo.py), never the embedded picture; `photos`: photo_links of a list."""
    return {
        "id": emp.id,
        "employeeCode": emp.employee_code,
        "name": f"{emp.first_name} {emp.last_name}",
        "department": emp.department.name if emp.department else None,
        "designation": emp.designation.title if emp.designation else None,
        "phone": emp.phone,
        "email": emp.email,
        "photoUrl": employee_photo_link(emp, photos),
    }


# ── Visitor -> host employee notification ───────────────────────────────────
# Best-effort on both channels -a visitor's check-in must always succeed
# regardless of whether their host can be reached right now, exactly like
# whatsapp_service.send_document never raises for an "expected" failure.
# Nothing here is ever surfaced back to the visitor's own form; only
# notified_email_at/notified_whatsapp_at on VisitorVisit (read from the
# Reception dashboard) and the WhatsAppMessageLog audit trail reflect it.

def _send_visitor_email(visit: VisitorVisit, emp: Employee) -> None:
    """The arrival notice by email, through the central email service (which logs it for the Gmail Control
    page). Automatic: with nothing to attempt -no address on file, SMTP not set up, HR switched it off- it
    returns quietly and leaves no history row; a real attempt that fails is logged."""
    from . import email_service

    visitor = visit.visitor
    emp_name = f"{emp.first_name} {emp.last_name}".strip()
    log = email_service.send_email(
        "visitor_arrival",
        to_email=emp.email,
        params={
            "employee_name": emp_name,
            "visitor_name": visitor.name,
            "visitor_phone": visitor.phone,
            "purpose": visit.purpose,
        },
        ps=settings_for_employee(emp),
        recipient_name=emp_name,
        employee=emp,
        ref_id=visit.id,
        automatic=True,
    )
    if log is not None and log.status == email_service.EMAIL_SENT:
        visit.notified_email_at = timezone.now()
        visit.save(update_fields=["notified_email_at"])


def _send_visitor_whatsapp(visit: VisitorVisit, emp: Employee) -> None:
    """The visitor message (name, contact, purpose, department, date and time) plus the
    visitor's contact card to tap and call. Queued, so the visitor's check-in never waits on
    WhatsApp; the Reception "notified" time is stamped once it is really sent."""
    from . import whatsapp_notifications

    whatsapp_notifications.notify_visitor_arrival(visit, emp)


def _notify_employee_of_visitor(visit: VisitorVisit) -> None:
    emp = visit.meeting_employee
    if not emp:
        return
    try:
        _send_visitor_email(visit, emp)
    except Exception:
        pass
    try:
        _send_visitor_whatsapp(visit, emp)
    except Exception:
        pass


# ── Outpass -HR portal ───────────────────────────────────────────────────────

@api_view(["GET"])
@require_hr
def outpass_qr(request: Request) -> Response:
    branch = _resolve_branch_for_qr(request)
    if branch is None:
        return Response({"error": "No branch selected."}, status=400)
    qr = GateQRCode.get_or_create_for(branch, GateQRCode.KIND_OUTPASS)
    return Response({"token": qr.token, "branchId": branch.id, "branchName": branch.name})


@api_view(["GET"])
@require_hr
def outpass_summary(request: Request) -> Response:
    today_start, week_start, month_start = _range_bounds()
    qs = scope_to_branch(OutpassRecord.objects, request)
    return Response({
        "today": qs.filter(submitted_at__gte=today_start).count(),
        "thisWeek": qs.filter(submitted_at__gte=week_start).count(),
        "thisMonth": qs.filter(submitted_at__gte=month_start).count(),
    })


@api_view(["GET"])
@require_hr
def outpass_records(request: Request) -> Response:
    start = _range_start(request.query_params.get("range", "month"))
    page, page_size = _paginate_params(request)
    qs = scope_to_branch(OutpassRecord.objects, request).filter(submitted_at__gte=start).select_related("branch")
    total = qs.count()
    offset = (page - 1) * page_size
    rows = qs[offset:offset + page_size]
    return Response({
        "items": [
            {
                "id": r.id,
                "employeeName": r.employee_name,
                "employeeCode": r.employee_code,
                "destination": r.destination,
                "branchName": r.branch.name if r.branch else None,
                "submittedAt": r.submitted_at.isoformat(),
                "source": r.source,
            }
            for r in rows
        ],
        "total": total,
        "page": page,
        "pageSize": page_size,
    })


# ── Outpass -public gate form ────────────────────────────────────────────────

@api_view(["GET"])
def outpass_gate_info(request: Request, token: str) -> Response:
    qr = _gate_qr_or_none(token, GateQRCode.KIND_OUTPASS)
    if not qr:
        return _QR_NOT_FOUND
    return Response({"branchName": qr.branch.name})


@api_view(["POST"])
@throttle("gate_submit")
def outpass_gate_submit(request: Request, token: str) -> Response:
    qr = _gate_qr_or_none(token, GateQRCode.KIND_OUTPASS)
    if not qr:
        return _QR_NOT_FOUND

    name = (request.data.get("name") or "").strip()
    employee_code = (request.data.get("employeeCode") or "").strip()
    destination = (request.data.get("destination") or "").strip()
    if not name or not employee_code or not destination:
        return Response({"error": "Name, employee code and destination are all required."}, status=400)

    employee = Employee.objects.filter(employee_code__iexact=employee_code).first()
    record = OutpassRecord.objects.create(
        branch=qr.branch, employee=employee,
        employee_name=name, employee_code=employee_code, destination=destination,
    )
    if employee is not None:
        from . import whatsapp_notifications

        whatsapp_notifications.notify_gate_record(record)
    return Response({"submitted": True}, status=201)


# ── Visitors -HR portal ──────────────────────────────────────────────────────

@api_view(["GET"])
@require_hr
def visitor_qr(request: Request) -> Response:
    branch = _resolve_branch_for_qr(request)
    if branch is None:
        return Response({"error": "No branch selected."}, status=400)
    qr = GateQRCode.get_or_create_for(branch, GateQRCode.KIND_VISITOR)
    return Response({"token": qr.token, "branchId": branch.id, "branchName": branch.name})


# The Visitors page's filters, one meaning for the list, the figures and the file (visitor/records, visitor/summary,
# visitor/export) and the visit JSON (also the reception desk's). A visit's status is worked out, never stored:
# checked_out = a check-out was recorded (by HR or a reception desk, from 18 Nov 2026); inside = came today (India time)
# and not checked out; not_checked_out = an earlier day with no check-out ("Left without check-out").
VISIT_INSIDE = "inside"
VISIT_CHECKED_OUT = "checked_out"
VISIT_NOT_CHECKED_OUT = "not_checked_out"
VISIT_STATUS_LABELS = {
    VISIT_INSIDE: "Inside",
    VISIT_CHECKED_OUT: "Checked out",
    VISIT_NOT_CHECKED_OUT: "Left without check-out",
}
VISIT_SOURCE_LABELS = {
    VisitorVisit.SOURCE_QR: "QR self check-in",
    VisitorVisit.SOURCE_HR: "Registered by HR",
    VisitorVisit.SOURCE_RECEPTION: "Reception desk",
}
LONG_STAY = timedelta(hours=2)  # "Inside over 2 h"
# a check-out can be recorded this long after the check-in (a visitor who came in the evening leaves after midnight;
# visitor_admin_views._check_out enforces it, the visit JSON's canCheckOut says it)
CHECK_OUT_WITHIN = timedelta(hours=24)
MAX_SEARCH_WORDS = 4


class VisitFilterError(ValueError):
    """A filter the Visitors endpoints cannot use; str(e) is the plain message of the 400."""


def _day_start(now):
    """00:00 India time of the day `now` falls on (aware)."""
    return now.astimezone(FACTORY_TZ).replace(hour=0, minute=0, second=0, microsecond=0)


def _filter_date(value, name: str):
    value = (value or "").strip()
    if not value:
        return None
    try:
        return date.fromisoformat(value)
    except ValueError:
        raise VisitFilterError(f"{name} must be a date like 2026-11-18.") from None


def _filter_id(value, name: str):
    value = str(value or "").strip()
    if not value:
        return None
    if not value.isdigit():
        raise VisitFilterError(f"{name} must be a number.")
    return int(value)


def visit_filter_params(request: Request) -> dict:
    """This request's Visitors filters, checked (raises VisitFilterError):
    from / to (YYYY-MM-DD, India days, inclusive; without either, the old `range` today / week / month applies, month by
    default), status, source, branchId (only an HR account not bound to a branch may pick one; a bound account always
    gets its own branch), hostEmployeeId, departmentId (the host's department) and q (up to four words, each must match
    the visitor's name or phone, the company, the host, the purpose, the vehicle or the badge)."""
    qp = request.query_params
    d_from, d_to = _filter_date(qp.get("from"), "from"), _filter_date(qp.get("to"), "to")
    if d_from and d_to and d_from > d_to:
        raise VisitFilterError("The start date must be on or before the end date.")
    status = (qp.get("status") or "").strip() or None
    if status is not None and status not in VISIT_STATUS_LABELS:
        raise VisitFilterError("status must be inside, checked_out or not_checked_out.")
    source = (qp.get("source") or "").strip() or None
    if source is not None and source not in VISIT_SOURCE_LABELS:
        raise VisitFilterError("source must be qr, hr or reception.")
    scope = get_branch_scope(request)
    return {
        "from": d_from,
        "to": d_to,
        "range": (qp.get("range") or "").strip() or "month",
        "status": status,
        "source": source,
        "branch_id": scope if scope is not None else _filter_id(qp.get("branchId"), "branchId"),
        "host_id": _filter_id(qp.get("hostEmployeeId"), "hostEmployeeId"),
        "department_id": _filter_id(qp.get("departmentId"), "departmentId"),
        "q": " ".join((qp.get("q") or "").split()[:MAX_SEARCH_WORDS]),
    }


def _search_q(term: str) -> Q:
    return (
        Q(visitor__name__icontains=term)
        | Q(visitor__phone__icontains=term)
        | Q(company__icontains=term)
        | Q(whom_to_meet__icontains=term)
        | Q(meeting_employee__first_name__icontains=term)
        | Q(meeting_employee__last_name__icontains=term)
        | Q(meeting_employee__employee_code__iexact=term)
        | Q(purpose__icontains=term)
        | Q(vehicle_number__icontains=term)
        | Q(badge_number__iexact=term)
    )


def visits_base(p: dict):
    """The visits the filters allow before the dates and the status: the branch, the host, the host's department, how
    the visit was checked in and the search words."""
    qs = VisitorVisit.objects.all()
    if p["branch_id"] is not None:
        qs = qs.filter(branch_id=p["branch_id"])
    if p["host_id"] is not None:
        qs = qs.filter(meeting_employee_id=p["host_id"])
    if p["department_id"] is not None:
        qs = qs.filter(meeting_employee__department_id=p["department_id"])
    if p["source"]:
        qs = qs.filter(source=p["source"])
    for term in p["q"].split():
        qs = qs.filter(_search_q(term))
    return qs


def visit_date_q(p: dict) -> Q:
    """The dates: from / to as India days (inclusive), else the old range (today / week / month)."""
    if p["from"] is None and p["to"] is None:
        return Q(visited_at__gte=_range_start(p["range"]))
    q = Q()
    if p["from"] is not None:
        q &= Q(visited_at__gte=datetime.combine(p["from"], time.min, tzinfo=FACTORY_TZ))
    if p["to"] is not None:
        q &= Q(visited_at__lt=datetime.combine(p["to"] + timedelta(days=1), time.min, tzinfo=FACTORY_TZ))
    return q


def visit_status_q(status, today_start) -> Q:
    if status == VISIT_CHECKED_OUT:
        return Q(checked_out_at__isnull=False)
    if status == VISIT_INSIDE:
        return Q(checked_out_at__isnull=True, visited_at__gte=today_start)
    if status == VISIT_NOT_CHECKED_OUT:
        return Q(checked_out_at__isnull=True, visited_at__lt=today_start)
    return Q()


def filtered_visits(p: dict, today_start):
    """Every filter applied (dates and status too), newest first."""
    return (
        visits_base(p)
        .filter(visit_date_q(p) & visit_status_q(p["status"], today_start))
        .order_by("-visited_at", "-id")
    )


def visit_rows(qs):
    """What the visit JSON reads, in the same query: the visitor, the branch, the host and the host's department and
    designation. The host's photo is never read out (the JSON sends a link: photo_links)."""
    return qs.select_related(
        "visitor", "branch", "meeting_employee__department", "meeting_employee__designation"
    ).defer("meeting_employee__photo_url")


def with_visit_count(qs, branch_id=None):
    """Adds visit_count (the visitor's visits, at `branch_id` only when given) as one subquery, not a query per row."""
    sub = VisitorVisit.objects.filter(visitor_id=OuterRef("visitor_id"))
    if branch_id is not None:
        sub = sub.filter(branch_id=branch_id)
    sub = sub.order_by().values("visitor_id").annotate(n=Count("id")).values("n")
    return qs.annotate(visit_count=Coalesce(Subquery(sub, output_field=IntegerField()), 0))


def visit_status(v: VisitorVisit, today_start) -> str:
    if v.checked_out_at is not None:
        return VISIT_CHECKED_OUT
    if v.visited_at >= today_start:
        return VISIT_INSIDE
    return VISIT_NOT_CHECKED_OUT


# Time inside, ONE rule for the row, the summary and the file (19 Nov 2026): each visit counts its whole minutes (the
# seconds dropped: 45 s is 0 min, 1 min 59 s is 1 min), and an average is the mean of those whole minutes rounded half
# up (0.5 -> 1). The SQL (VisitMinutes, visitor_summary) and the Python (whole_minutes, average_minutes) agree.


def whole_minutes(start, end) -> int:
    """Whole minutes from `start` to `end`, the seconds dropped (never below 0)."""
    return max(0, int((end - start).total_seconds() // 60))


def average_minutes(values) -> int | None:
    """The mean of whole minutes (ints, or the Decimal / float SQL's AVG gives), rounded half up; None for none."""
    if isinstance(values, (list, tuple)):
        if not values:
            return None
        mean = Decimal(sum(values)) / Decimal(len(values))
    elif values is None:
        return None
    else:
        mean = Decimal(str(values))
    return int(mean.quantize(Decimal("1"), rounding=ROUND_HALF_UP))


class VisitMinutes(Func):
    """whole_minutes in SQL: FLOOR of the interval's seconds / 60 (never below 0), e.g. inside Avg()."""

    template = "GREATEST(0, FLOOR(EXTRACT(EPOCH FROM (%(expressions)s)) / 60))"
    output_field = IntegerField()


def _minutes_inside(v: VisitorVisit, status: str, now):
    """Whole minutes from check-in to check-out (or to now while inside); None when the visitor left without one."""
    if status == VISIT_CHECKED_OUT:
        end = v.checked_out_at
    elif status == VISIT_INSIDE:
        end = now
    else:
        return None
    return whole_minutes(v.visited_at, end)


def _phone_digits_expr(field: str):
    """The digits of a phone column (everything else dropped), for matching however it was typed."""
    return Func(F(field), Value(r"[^0-9]"), Value(""), Value("g"), function="REGEXP_REPLACE", output_field=TextField())


def find_visitor_by_phone(raw_phone: str):
    """The Visitor with this phone: the exact text first, then the same last 10 digits however it was typed (spaces,
    +91), like _find_employee_by_phone. None for a blank or too short number."""
    raw_phone = (raw_phone or "").strip()
    if not raw_phone:
        return None
    exact = Visitor.objects.filter(phone=raw_phone).first()
    if exact:
        return exact
    digits = _digits_only(raw_phone)
    if len(digits) < 7:
        return None
    return (
        Visitor.objects.annotate(phone_digits=_phone_digits_expr("phone"))
        .filter(phone_digits__endswith=digits[-10:])
        .order_by("id")
        .first()
    )


def mask_phone(phone: str | None) -> str:
    """98•••••210: the first two and the last three of the (last ten) digits."""
    digits = _digits_only(phone)[-10:]
    if len(digits) >= 7:
        return digits[:2] + "•" * (len(digits) - 5) + digits[-3:]
    if len(digits) >= 3:
        return "•" * (len(digits) - 2) + digits[-2:]
    return "•••" if phone else ""


@api_view(["GET"])
@require_hr
def visitor_summary(request: Request) -> Response:
    """today / thisWeek / thisMonth (as before) and insideNow / checkedOutToday / longStayNow / repeatThisMonth, for
    the page's filters except the dates and the status; inRange {visits, checkedOut, avgMinutes} for every filter."""
    try:
        p = visit_filter_params(request)
    except VisitFilterError as e:
        return Response({"error": str(e)}, status=400)
    now = _now()
    today_start, week_start, month_start = _range_bounds(now)
    base = visits_base(p)
    inside = Q(checked_out_at__isnull=True, visited_at__gte=today_start)
    out = base.aggregate(
        today=Count("id", filter=Q(visited_at__gte=today_start)),
        thisWeek=Count("id", filter=Q(visited_at__gte=week_start)),
        thisMonth=Count("id", filter=Q(visited_at__gte=month_start)),
        insideNow=Count("id", filter=inside),
        checkedOutToday=Count("id", filter=Q(checked_out_at__gte=today_start)),
        longStayNow=Count("id", filter=inside & Q(visited_at__lt=now - LONG_STAY)),
    )
    # repeat visitors: came this month (these filters) and have two or more visits in all (this branch)
    branch_visits = VisitorVisit.objects.all()
    if p["branch_id"] is not None:
        branch_visits = branch_visits.filter(branch_id=p["branch_id"])
    out["repeatThisMonth"] = (
        branch_visits.filter(visitor_id__in=base.filter(visited_at__gte=month_start).values("visitor_id"))
        .order_by()
        .values("visitor_id")
        .annotate(n=Count("id"))
        .filter(n__gte=2)
        .count()
    )
    in_range = (
        base.filter(visit_date_q(p) & visit_status_q(p["status"], today_start))
        .order_by()
        .aggregate(
            visits=Count("id"),
            checkedOut=Count("id", filter=Q(checked_out_at__isnull=False)),
            avg=Avg(VisitMinutes(F("checked_out_at") - F("visited_at")), filter=Q(checked_out_at__isnull=False)),
        )
    )
    # the rows' own whole minutes, averaged half up (the same rule as minutesInside and the file)
    in_range["avgMinutes"] = average_minutes(in_range.pop("avg"))
    out["inRange"] = in_range
    if (request.query_params.get("options") or "").lower() in ("1", "true"):
        out["options"] = _visit_filter_options(p["branch_id"])
    return Response(out)


def _visit_filter_options(branch_id) -> dict:
    """The Visitors page's Host and Department selects (?options=1 on visitor/summary): the employees visitors have come
    to meet at this branch (any date) and their departments, by name. No HR employee list is needed for it."""
    qs = VisitorVisit.objects.filter(meeting_employee__isnull=False)
    if branch_id is not None:
        qs = qs.filter(branch_id=branch_id)
    rows = qs.order_by().values(
        "meeting_employee_id",
        "meeting_employee__first_name",
        "meeting_employee__last_name",
        "meeting_employee__department_id",
        "meeting_employee__department__name",
    ).distinct()
    hosts, departments = {}, {}
    for r in rows:
        name = f"{r['meeting_employee__first_name'] or ''} {r['meeting_employee__last_name'] or ''}".strip()
        hosts[r["meeting_employee_id"]] = {
            "id": r["meeting_employee_id"],
            "name": name or f"#{r['meeting_employee_id']}",
            "department": r["meeting_employee__department__name"],
        }
        if r["meeting_employee__department_id"] is not None:
            departments[r["meeting_employee__department_id"]] = r["meeting_employee__department__name"]
    return {
        "hosts": sorted(hosts.values(), key=lambda h: (h["name"].lower(), h["id"])),
        "departments": [
            {"id": i, "name": n} for i, n in sorted(departments.items(), key=lambda kv: ((kv[1] or "").lower(), kv[0]))
        ],
    }


def _visitor_visit_dict(v: VisitorVisit, photos: dict | None = None, *, now=None, today_start=None) -> dict:
    # Full Aadhaar is included here (not just the last-4 preview) -this
    # endpoint is already @require_hr + RBAC-gated on the "outpass_visitors"
    # module (see permission_registry.py), so whoever can load this table at
    # all is already trusted with the data; the UI just defaults to masked
    # so it isn't left on-screen for anyone glancing at a shared monitor.
    # Same trust level applies to reception_views.py's @require_reception_device
    # endpoint, which calls this same function. (Files never carry it: visitor_export masks it in the database.)
    # Keys are only ever added (the reception console and older screens read the first ones). A list passes `now` /
    # `today_start` once and annotates visit_count (with_visit_count), so a row costs no query of its own.
    now = now or _now()
    today_start = today_start or _day_start(now)
    status = visit_status(v, today_start)
    visit_count = getattr(v, "visit_count", None)
    if visit_count is None:
        visit_count = VisitorVisit.objects.filter(visitor_id=v.visitor_id).count()
    aadhaar = v.visitor.aadhaar_number or ""
    return {
        "id": v.id,
        "name": v.visitor.name,
        "phone": v.visitor.phone,
        "aadhaar": aadhaar or None,
        "aadhaarLast4": aadhaar[-4:] if len(aadhaar) >= 4 else None,
        "whyCame": v.why_came,
        "whomToMeet": v.whom_to_meet,
        "purpose": v.purpose,
        "branchName": v.branch.name if v.branch else None,
        "visitedAt": v.visited_at.isoformat(),
        "meetingEmployee": _employee_contact_json(v.meeting_employee, photos) if v.meeting_employee_id else None,
        "notifiedEmailAt": v.notified_email_at.isoformat() if v.notified_email_at else None,
        "notifiedWhatsappAt": v.notified_whatsapp_at.isoformat() if v.notified_whatsapp_at else None,
        # from 18 Nov 2026: how it was checked in, its check-out and the desk details
        "visitorId": v.visitor_id,
        "branchId": v.branch_id,
        "source": v.source,
        "sourceLabel": VISIT_SOURCE_LABELS.get(v.source, v.source),
        "checkedInBy": v.checked_in_by,
        "checkedOutAt": v.checked_out_at.isoformat() if v.checked_out_at else None,
        "checkedOutBy": v.checked_out_by,
        "checkoutSource": v.checkout_source,
        "company": v.company,
        "vehicleNumber": v.vehicle_number,
        "peopleCount": v.people_count,
        "idProofType": v.id_proof_type,
        "badgeNumber": v.badge_number,
        "notes": v.notes,
        "status": status,
        "statusLabel": VISIT_STATUS_LABELS[status],
        "minutesInside": _minutes_inside(v, status, now),
        "visitCount": visit_count,
        # 19 Nov 2026: a check-out may be recorded (none yet, checked in under 24 hours ago): a night visitor whose
        # status is already "Left without check-out" after midnight can still be checked out
        "canCheckOut": v.checked_out_at is None and now - v.visited_at < CHECK_OUT_WITHIN,
    }


@api_view(["GET"])
@require_hr
def visitor_records(request: Request) -> Response:
    """The Visitors list: range (today / week / month, month by default) as before, or from / to, plus status, branchId,
    hostEmployeeId, departmentId, source and q (see visit_filter_params); page, pageSize."""
    try:
        p = visit_filter_params(request)
    except VisitFilterError as e:
        return Response({"error": str(e)}, status=400)
    page, page_size = _paginate_params(request)
    now = _now()
    today_start = _day_start(now)
    qs = filtered_visits(p, today_start)
    total = qs.count()
    offset = (page - 1) * page_size
    # visits at the branch chosen (the account's own, or ?branchId= for an account not bound to one), like the summary's
    # "Repeat" figure, so the column and the tile agree
    rows = list(with_visit_count(visit_rows(qs), p["branch_id"])[offset:offset + page_size])
    photos = photo_links(v.meeting_employee_id for v in rows)
    return Response({
        "items": [_visitor_visit_dict(v, photos, now=now, today_start=today_start) for v in rows],
        "total": total,
        "page": page,
        "pageSize": page_size,
    })


# ── Visitors -public gate form ───────────────────────────────────────────────

@api_view(["GET"])
def visitor_gate_info(request: Request, token: str) -> Response:
    qr = _gate_qr_or_none(token, GateQRCode.KIND_VISITOR)
    if not qr:
        return _QR_NOT_FOUND
    return Response({"branchName": qr.branch.name})


@api_view(["POST"])
@throttle("gate_submit")
def visitor_check_phone(request: Request, token: str) -> Response:
    qr = _gate_qr_or_none(token, GateQRCode.KIND_VISITOR)
    if not qr:
        return _QR_NOT_FOUND

    phone = (request.data.get("phone") or "").strip()
    if not phone:
        return Response({"error": "Phone number is required."}, status=400)

    visitor = Visitor.objects.filter(phone=phone).first()
    if not visitor:
        return Response({"found": False})
    return Response({"found": True, "name": visitor.name})


@api_view(["POST"])
@throttle("gate_submit")
def visitor_check_employee_phone(request: Request, token: str) -> Response:
    """"Are you meeting a specific employee?" -> Yes step: the visitor (or
    receptionist filling in on their behalf) enters the employee's name and
    phone number, and this resolves the actual Employee record by matching
    that phone against Employee.phone (see _find_employee_by_phone), so the
    form can show "is this who you mean?" before the visit is recorded and
    an arrival notification goes out. Never blocks check-in: if nothing
    matches, the caller falls back to the plain free-text whomToMeet field,
    exactly like before this feature existed."""
    qr = _gate_qr_or_none(token, GateQRCode.KIND_VISITOR)
    if not qr:
        return _QR_NOT_FOUND

    phone = (request.data.get("phone") or "").strip()
    if not phone:
        return Response({"error": "Phone number is required."}, status=400)

    employee = _find_employee_by_phone(phone)
    if not employee:
        return Response({"found": False})
    return Response({"found": True, "employee": _employee_contact_json(employee)})


@api_view(["POST"])
@throttle("gate_submit")
def visitor_gate_new(request: Request, token: str) -> Response:
    qr = _gate_qr_or_none(token, GateQRCode.KIND_VISITOR)
    if not qr:
        return _QR_NOT_FOUND

    name = (request.data.get("name") or "").strip()
    phone = (request.data.get("phone") or "").strip()
    aadhaar = (request.data.get("aadhaarNumber") or "").strip()
    why_came = (request.data.get("whyCame") or "").strip()
    whom_to_meet = (request.data.get("whomToMeet") or "").strip()
    purpose = (request.data.get("purpose") or "").strip()
    meeting_employee_id = request.data.get("meetingEmployeeId")
    if not name or not phone or not whom_to_meet or not purpose:
        return Response(
            {"error": "Name, phone, whom you're meeting and purpose are all required."}, status=400
        )

    if Visitor.objects.filter(phone=phone).exists():
        return Response(
            {"error": 'A visitor with this phone number already exists. Use "Already Visited" instead.'},
            status=409,
        )

    meeting_employee = Employee.objects.filter(pk=meeting_employee_id).first() if meeting_employee_id else None

    visitor = Visitor.objects.create(name=name, phone=phone, aadhaar_number=aadhaar or None)
    visit = VisitorVisit.objects.create(
        visitor=visitor, branch=qr.branch, why_came=why_came or None,
        whom_to_meet=whom_to_meet, purpose=purpose, meeting_employee=meeting_employee,
    )
    _notify_employee_of_visitor(visit)
    return Response({"submitted": True}, status=201)


@api_view(["POST"])
@throttle("gate_submit")
def visitor_gate_repeat(request: Request, token: str) -> Response:
    qr = _gate_qr_or_none(token, GateQRCode.KIND_VISITOR)
    if not qr:
        return _QR_NOT_FOUND

    phone = (request.data.get("phone") or "").strip()
    whom_to_meet = (request.data.get("whomToMeet") or "").strip()
    purpose = (request.data.get("purpose") or "").strip()
    meeting_employee_id = request.data.get("meetingEmployeeId")

    visitor = Visitor.objects.filter(phone=phone).first()
    if not visitor:
        return Response({"error": "No visitor found with this phone number."}, status=404)
    if not whom_to_meet or not purpose:
        return Response({"error": "Whom you're meeting and purpose are both required."}, status=400)

    meeting_employee = Employee.objects.filter(pk=meeting_employee_id).first() if meeting_employee_id else None

    visit = VisitorVisit.objects.create(
        visitor=visitor, branch=qr.branch, whom_to_meet=whom_to_meet, purpose=purpose,
        meeting_employee=meeting_employee,
    )
    _notify_employee_of_visitor(visit)
    return Response({"submitted": True}, status=201)

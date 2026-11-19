"""
Visitors (HR portal): register a visit, check a visitor out, a visit's detail and history, the visitors directory and
the export, under /api/visitor/visits, /api/visitor/people and /api/visitor/export (permission key
outpass_visitors.visitors; view for GET, edit for writes). Plus the reception desk's check-out,
POST /api/reception-devices/visits/<id>/check-out (desk-authenticated, its own branch only).

The visit JSON is outpass_visitor_views._visitor_visit_dict (keys only ever added; the reception console reads it too)
and the filters are outpass_visitor_views.visit_filter_params, so the list, the figures and the file always agree.
Files go through gate_exports.file_response (the Report Center's writers); the Aadhaar number never leaves the
database whole in a file (only its last four digits are read, then masked "XXXX XXXX 1234").

Check-in and check-out exist from 18 Nov 2026: a visit registered here is checked in now (source "hr"), a QR self
check-in has source "qr". A check-out can be recorded once, within 24 hours of the check-in (so a visitor who came in
the evening can be checked out after midnight), by HR or the reception desk of that branch; a visit older than that
with no check-out stays "Left without check-out".

A Visitor row is one person for every branch (matched by phone), but the name and Aadhaar are per branch (19 Nov 2026):
each visit keeps what was given at it (VisitorVisit.visitor_name / aadhaar_number, visitor_identity.py), a register
copies a blank field only from the person's latest visit at the SAME branch, and a caller that sees one branch (a
reception desk, a branch-bound HR account) only ever sees, counts and finds that branch's visits: see register_visit,
visitor_people and visitor_visit_detail.
"""

from __future__ import annotations

import logging
from types import SimpleNamespace

from django.db import IntegrityError, transaction
from django.db.models import Count, F, Max, Q
from django.db.models.functions import Coalesce, Right, Trim
from rest_framework.decorators import api_view
from rest_framework.request import Request
from rest_framework.response import Response

from .audit_utils import log_action
from .auth import get_hr_display_name, require_hr, require_reception_device
from .branch_scope import get_branch_scope
from .clock import FACTORY_TZ
from .employee_photo import photo_links
from .gate_exports import file_response
from .gate_records import EXPORT_FETCH_LIMIT
from .models import Branch, Department, Employee, Visitor, VisitorVisit
from .outpass_visitor_views import (
    CHECK_OUT_WITHIN,
    VISIT_CHECKED_OUT,
    VISIT_INSIDE,
    VISIT_SOURCE_LABELS,
    VISIT_STATUS_LABELS,
    VisitFilterError,
    _day_start,
    _digits_only,
    _notify_employee_of_visitor,
    _now,
    _paginate_params,
    _range_bounds,
    _visitor_visit_dict,
    average_minutes,
    filtered_visits,
    find_visitor_by_phone,
    mask_phone,
    visit_filter_params,
    visit_rows,
    visit_status,
    whole_minutes,
    with_visit_count,
)
from .visitor_identity import aadhaar_expr, identity, latest_name_subquery, name_expr, visit_name

logger = logging.getLogger(__name__)

HISTORY_SIZE = 20
MAX_PEOPLE = 50
NOTE_MAX = 300
# the longest each text of the register form may be (characters)
TEXT_LIMITS = {
    "name": ("Name", 120),
    "phone": ("Phone number", 20),
    "company": ("Company", 120),
    "vehicleNumber": ("Vehicle number", 20),
    "idProofType": ("ID proof", 40),
    "badgeNumber": ("Badge number", 30),
    "whomToMeet": ("Meeting", 120),
    "purpose": ("Purpose", 300),
    "whyCame": ("Reason", 300),
    "notes": ("Notes", 1000),
}
NOT_FOUND = "This visit was not found."
OTHER_BRANCH_HOST = "Choose someone from this branch."


def _bad(message: str, status: int = 400, **extra) -> Response:
    return Response({"error": message, **extra}, status=status)


def _hhmm(dt) -> str:
    return dt.astimezone(FACTORY_TZ).strftime("%H:%M")


def _day_label(dt) -> str:
    return dt.astimezone(FACTORY_TZ).strftime("%d %b %Y").lstrip("0")


def _visit_json(pk: int, branch_id=None) -> dict | None:
    """One visit as the list shows it (visit count over `branch_id`'s visits when given), or None."""
    visit = with_visit_count(visit_rows(VisitorVisit.objects.filter(pk=pk)), branch_id).first()
    if visit is None:
        return None
    return _visitor_visit_dict(visit, photo_links([visit.meeting_employee_id]))


# ── Register (HR checks a visitor in now) ───────────────────────────────────


def _form_text(data, key: str, *, keep_lines: bool = False) -> str:
    value = data.get(key)
    if value is None:
        return ""
    text = str(value).strip()
    return text if keep_lines else " ".join(text.split())


def register_fields(data):
    """The register form without its branch (HR picks one, a reception desk always has its own), checked: (fields, None)
    or (None, 400 response). Shared by HR's POST visitor/visits and the desk's POST reception-devices/visits."""
    data = data if hasattr(data, "get") else {}
    f = {key: _form_text(data, key, keep_lines=key == "notes") for key in TEXT_LIMITS}
    f["aadhaarNumber"] = _form_text(data, "aadhaarNumber")
    for key, (label, limit) in TEXT_LIMITS.items():
        if len(f[key]) > limit:
            return None, _bad(f"{label} is too long (at most {limit} characters).")

    if not f["phone"]:
        return None, _bad("Enter the visitor's phone number.")
    if len(_digits_only(f["phone"])) < 6:
        return None, _bad("Enter a phone number with at least 6 digits.")
    if not f["purpose"]:
        return None, _bad("Enter the purpose of the visit.")

    aadhaar = f["aadhaarNumber"]
    if aadhaar:
        digits = _digits_only(aadhaar)
        if len(digits) != 12 or len(aadhaar.replace(" ", "").replace("-", "")) != 12:
            return None, _bad("An Aadhaar number has 12 digits.")
        f["aadhaarNumber"] = digits

    raw_count = data.get("peopleCount")
    if raw_count in (None, ""):
        f["peopleCount"] = 1
    else:
        try:
            count = int(str(raw_count).strip())
        except (TypeError, ValueError):
            count = 0
        if not 1 <= count <= MAX_PEOPLE:
            return None, _bad(f"Number of people must be between 1 and {MAX_PEOPLE}.")
        f["peopleCount"] = count

    host = None
    raw_host = data.get("meetingEmployeeId")
    if raw_host not in (None, ""):
        host_id = str(raw_host).strip()
        host = Employee.objects.filter(pk=int(host_id)).first() if host_id.isdigit() else None
        if host is None:
            return None, _bad("The employee to meet was not found. Look them up again or type a name.")
        if not f["whomToMeet"]:
            f["whomToMeet"] = f"{host.first_name} {host.last_name}".strip()
    if not f["whomToMeet"]:
        return None, _bad("Enter whom the visitor is meeting.")
    f["host"] = host
    return f, None


def _register_input(request: Request):
    """HR's register form, checked: (fields, None) or (None, 400 response); `branch` is the account's own branch, or the
    one the body names for an account not bound to a branch."""
    data = request.data if hasattr(request.data, "get") else {}
    f, error = register_fields(data)
    if error is not None:
        return None, error
    scope = get_branch_scope(request)
    if scope is not None:
        branch = Branch.objects.filter(pk=scope).first()
    else:
        raw_branch = str(data.get("branchId") or "").strip()
        if not raw_branch:
            return None, _bad("Choose the branch the visitor is at.")
        branch = Branch.objects.filter(pk=int(raw_branch)).first() if raw_branch.isdigit() else None
    if branch is None:
        return None, _bad("That branch was not found.")
    f["branch"] = branch
    return f, None


def register_visit(f: dict, *, branch, source: str, checked_in_by: str, desk=None, scoped: bool = False):
    """Checks the visitor of the form `f` (register_fields) in now at `branch`: (visit, None) or (None, error response).
    The phone finds a returning visitor (that Visitor row, the phone anchor, is reused and never changed), else a new
    one is made; a visitor still inside at this branch today is 409 already_inside. The host is told like the QR form
    does (email + WhatsApp, best effort: it never fails the request). `desk`: the reception desk that registered it
    (checked_in_desk). Shared by HR (source "hr") and the reception desk (source "reception"); the caller writes its own
    audit row and answers with registered_json.

    The name and Aadhaar are the visit's own (19 Nov 2026, visitor_identity.py): what the form typed, and for a field left
    blank, what the person's latest visit at THIS branch had; never another branch's. Someone this branch has not seen
    before therefore needs a name, like a new visitor. The Visitor row's own name / Aadhaar (what was given when it was
    first made) are left as they are: nothing shows them any more, and one branch's register must not change them.

    `scoped`: the caller sees `branch` only (a reception desk, a branch-bound HR account). Then the host must work at
    `branch` (400 "Choose someone from this branch.")."""
    now = _now()
    host = f["host"]
    if scoped and host is not None and host.branch_id != branch.id:
        return None, _bad(OTHER_BRANCH_HOST)
    name, aadhaar = f["name"], f["aadhaarNumber"] or None

    with transaction.atomic():
        visitor, created = find_visitor_by_phone(f["phone"]), False
        if visitor is None:
            if not name:
                return None, _bad("Enter the visitor's name.")
            try:
                with transaction.atomic():
                    visitor = Visitor.objects.create(name=name, phone=f["phone"], aadhaar_number=aadhaar)
                    created = True
            except IntegrityError:  # registered a moment ago by another screen (perhaps at another branch)
                visitor = Visitor.objects.get(phone=f["phone"])
        if not created:
            here = VisitorVisit.objects.filter(visitor=visitor, branch=branch).select_related("visitor")
            open_visit = (
                here.filter(checked_out_at__isnull=True, visited_at__gte=_day_start(now))
                .order_by("-visited_at", "-id")
                .first()
            )
            if open_visit is not None:
                return None, _bad(
                    f"{visit_name(open_visit)} is already inside (checked in at {_hhmm(open_visit.visited_at)}). "
                    "Check them out before registering a new visit.",
                    409,
                    code="already_inside",
                    visitId=open_visit.id,
                )
            last_here = here.order_by("-visited_at", "-id").first()
            if last_here is not None:  # a blank field: what this branch was told last time
                known_name, known_aadhaar = identity(last_here)
                name, aadhaar = name or known_name, aadhaar or known_aadhaar
            if not name:  # known only at other branches (or not at all): their name is never borrowed
                return None, _bad("Enter the visitor's name.")

        visit = VisitorVisit.objects.create(
            visitor=visitor,
            branch=branch,
            visitor_name=name,
            aadhaar_number=aadhaar,
            why_came=f["whyCame"] or None,
            whom_to_meet=f["whomToMeet"],
            purpose=f["purpose"],
            meeting_employee=f["host"],
            source=source,
            checked_in_by=checked_in_by,
            checked_in_desk=desk,
            company=f["company"] or None,
            vehicle_number=f["vehicleNumber"].upper() or None,
            people_count=f["peopleCount"],
            id_proof_type=f["idProofType"] or None,
            badge_number=f["badgeNumber"] or None,
            notes=f["notes"] or None,
        )

    try:  # best effort, exactly like the QR form: the visitor is in whatever happens to the message
        _notify_employee_of_visitor(visit)
    except Exception:
        logger.exception("visitor %s: telling the host failed", visit.id)
    return visit, None


def registered_json(visit, branch_id) -> dict | None:
    """The answer to a register: the visit as the list shows it (its own name / Aadhaar, the visit count over
    `branch_id`)."""
    return _visit_json(visit.id, branch_id)


@api_view(["POST"])
@require_hr
def visitor_visits_create(request: Request) -> Response:
    """HR registers a visitor: the visit is checked in now (source "hr", checked_in_by = this HR user), see
    register_visit. 201 + the visit."""
    f, error = _register_input(request)
    if error is not None:
        return error
    branch = f["branch"]
    scope = get_branch_scope(request)
    visit, error = register_visit(
        f,
        branch=branch,
        source=VisitorVisit.SOURCE_HR,
        checked_in_by=get_hr_display_name(request),
        scoped=scope is not None,
    )
    if error is not None:
        return error

    log_action(
        request,
        "create",
        "outpass_visitors",
        record_id=visit.id,
        description=f"Visitor registered: {visit_name(visit)}, meeting {visit.whom_to_meet} ({branch.name})"[:480],
    )
    return Response(registered_json(visit, scope), status=201)


# ── One visit and the visitor's history ─────────────────────────────────────


def _scoped(request: Request):
    scope = get_branch_scope(request)
    qs = VisitorVisit.objects.all()
    return qs if scope is None else qs.filter(branch_id=scope)


@api_view(["GET"])
@require_hr
def visitor_visit_detail(request: Request, pk: int) -> Response:
    """The visit (as in the list) plus `history`: that visitor's latest 20 visits this account may see, newest first
    (this one included)."""
    scope = get_branch_scope(request)
    visit = with_visit_count(visit_rows(_scoped(request).filter(pk=pk)), scope).first()
    if visit is None:
        return _bad(NOT_FOUND, 404)
    history = list(
        with_visit_count(
            visit_rows(_scoped(request).filter(visitor_id=visit.visitor_id).order_by("-visited_at", "-id")), scope
        )[:HISTORY_SIZE]
    )
    photos = photo_links([visit.meeting_employee_id, *(h.meeting_employee_id for h in history)])
    now = _now()
    today_start = _day_start(now)
    body = _visitor_visit_dict(visit, photos, now=now, today_start=today_start)
    body["history"] = [_visitor_visit_dict(h, photos, now=now, today_start=today_start) for h in history]
    return Response(body)


# ── Check-out (HR and the reception desk) ───────────────────────────────────


def _check_out(qs, *, by: str, source: str, note: str, desk=None):
    """Records the check-out of the visit in `qs` (already limited to what the caller may touch): (visit, None) or
    (None, error response). Once only, and within CHECK_OUT_WITHIN (24 hours) of the check-in, so a visitor who came in
    the evening is checked out after midnight too. `desk`: the reception desk that checked the visitor out
    (checked_out_desk, so Manage Reception counts it for that desk login)."""
    now = _now()
    with transaction.atomic():
        visit = qs.select_for_update().first()
        if visit is None:
            return None, _bad(NOT_FOUND, 404)
        if visit.checked_out_at is not None:
            return None, _bad(
                f"{visit_name(visit)} was already checked out at {_hhmm(visit.checked_out_at)}.",
                409,
                code="already_checked_out",
                checkedOutAt=visit.checked_out_at.isoformat(),
            )
        if now - visit.visited_at >= CHECK_OUT_WITHIN:
            return None, _bad(
                f"This visit started on {_day_label(visit.visited_at)} at {_hhmm(visit.visited_at)}, more than 24 hours "
                "ago. A check-out can only be recorded within 24 hours of the check-in.",
                409,
                code="earlier_day",
            )
        visit.checked_out_at = now
        visit.checked_out_by = by
        visit.checkout_source = source
        visit.checked_out_desk = desk
        fields = ["checked_out_at", "checked_out_by", "checkout_source", "checked_out_desk"]
        if note:
            visit.notes = f"{visit.notes}\nCheck-out: {note}" if visit.notes else f"Check-out: {note}"
            fields.append("notes")
        visit.save(update_fields=fields)
    return visit, None


def _note(request: Request):
    data = request.data if hasattr(request.data, "get") else {}
    note = _form_text(data, "note")
    if len(note) > NOTE_MAX:
        return None, _bad(f"The note is too long (at most {NOTE_MAX} characters).")
    return note, None


@api_view(["POST"])
@require_hr
def visitor_visit_check_out(request: Request, pk: int) -> Response:
    """HR checks a visitor out now ({note?}): 200 + the visit; 409 when already checked out or checked in more than 24
    hours ago."""
    note, error = _note(request)
    if error is not None:
        return error
    visit, error = _check_out(
        _scoped(request).filter(pk=pk), by=get_hr_display_name(request), source=VisitorVisit.SOURCE_HR, note=note
    )
    if error is not None:
        return error
    log_action(
        request,
        "update",
        "outpass_visitors",
        record_id=visit.id,
        description=f"Visitor checked out: {visit_name(visit)}"[:480],
    )
    return Response(_visit_json(visit.id, get_branch_scope(request)))


@api_view(["POST"])
@require_reception_device
def reception_visit_check_out(request: Request, pk: int) -> Response:
    """The reception desk checks a visitor out: only a visit of the desk's own branch (another branch's is 404)."""
    device = request.reception_device
    note, error = _note(request)
    if error is not None:
        return error
    visit, error = _check_out(
        VisitorVisit.objects.filter(pk=pk, branch_id=device.branch_id),
        by=device.name,
        source=VisitorVisit.SOURCE_RECEPTION,
        note=note,
        desk=device,
    )
    if error is not None:
        return error
    log_action(
        request,
        "update",
        "outpass_visitors",
        record_id=visit.id,
        description=f"Visitor checked out at the reception desk {device.name}: {visit_name(visit)}"[:480],
    )
    return Response(_visit_json(visit.id, device.branch_id))


# ── The visitors directory (People) ─────────────────────────────────────────


@api_view(["GET"])
@require_hr
def visitor_people(request: Request) -> Response:
    """Everyone who has visited (this account's branch, or ?branchId= for an account not bound to one), most recent
    first: {id, name, phoneMasked, lastVisitAt, visitCount, lastHost, insideNow, lastVisitId, lastCompany}. q: up to
    four words, each in the name or the phone. phone: the visitor with this number (however it is typed), for the
    register form's "returning visitor" check.

    Per branch (19 Nov 2026): only visits at that branch count (who is listed or found by phone, visitCount, the last
    visit, inside now) and the name is the one given at the person's latest visit there (visitor_identity.py); an
    account not bound to a branch without ?branchId= sees every branch, named as at their latest visit anywhere."""
    scope = get_branch_scope(request)
    branch_id = scope
    if scope is None:
        raw = (request.query_params.get("branchId") or "").strip()
        if raw and not raw.isdigit():
            return _bad("branchId must be a number.")
        branch_id = int(raw) if raw else None
    page, page_size = _paginate_params(request)
    today_start = _day_start(_now())

    in_branch = Q() if branch_id is None else Q(visits__branch_id=branch_id)
    seen = VisitorVisit.objects.all() if branch_id is None else VisitorVisit.objects.filter(branch_id=branch_id)
    qs = Visitor.objects.annotate(
        visit_count=Count("visits", filter=in_branch),
        last_visit_at=Max("visits__visited_at", filter=in_branch),
        shown_name=Coalesce(latest_name_subquery(seen), F("name")),
    ).filter(visit_count__gt=0)
    phone = (request.query_params.get("phone") or "").strip()
    if phone:
        match = find_visitor_by_phone(phone)
        qs = qs.filter(pk=match.pk if match is not None else 0)
    for term in (request.query_params.get("q") or "").split()[:4]:
        qs = qs.filter(Q(shown_name__icontains=term) | Q(phone__icontains=term))

    total = qs.count()
    offset = (page - 1) * page_size
    people = list(qs.order_by("-last_visit_at", "-id")[offset : offset + page_size])
    ids = [p.id for p in people]
    visits = VisitorVisit.objects.filter(visitor_id__in=ids)
    if branch_id is not None:
        visits = visits.filter(branch_id=branch_id)
    last = {
        row["visitor_id"]: row
        for row in visits.order_by("visitor_id", "-visited_at", "-id")
        .distinct("visitor_id")
        .values(
            "visitor_id",
            "id",
            "whom_to_meet",
            "company",
            "meeting_employee__first_name",
            "meeting_employee__last_name",
        )
    }
    inside = set(
        visits.filter(checked_out_at__isnull=True, visited_at__gte=today_start).values_list("visitor_id", flat=True)
    )

    def host(row) -> str | None:
        if row is None:
            return None
        first, last_name = row["meeting_employee__first_name"], row["meeting_employee__last_name"]
        if first or last_name:
            return f"{first or ''} {last_name or ''}".strip()
        return row["whom_to_meet"] or None

    return Response(
        {
            "items": [
                {
                    "id": p.id,
                    "name": p.shown_name,
                    "phoneMasked": mask_phone(p.phone),
                    "lastVisitAt": p.last_visit_at.isoformat() if p.last_visit_at else None,
                    "visitCount": p.visit_count,
                    "lastHost": host(last.get(p.id)),
                    "insideNow": p.id in inside,
                    "lastVisitId": last[p.id]["id"] if p.id in last else None,
                    "lastCompany": last[p.id]["company"] if p.id in last else None,
                }
                for p in people
            ],
            "total": total,
            "page": page,
            "pageSize": page_size,
        }
    )


# ── Export (Excel / PDF of the list's filters) ──────────────────────────────

EXPORT_COLUMNS = [
    {"key": "visitedAt", "label": "Checked in", "type": "datetime"},
    {"key": "visitor", "label": "Visitor", "type": "text"},
    {"key": "phone", "label": "Phone", "type": "text"},
    {"key": "aadhaar", "label": "Aadhaar", "type": "text"},
    {"key": "company", "label": "Company", "type": "text"},
    {"key": "people", "label": "People", "type": "int", "width": 0.6},
    {"key": "vehicle", "label": "Vehicle", "type": "text"},
    {"key": "host", "label": "Meeting", "type": "text"},
    {"key": "department", "label": "Department", "type": "text"},
    {"key": "purpose", "label": "Purpose", "type": "text", "width": 1.4},
    {"key": "status", "label": "Status", "type": "text"},
    {"key": "checkedOutAt", "label": "Checked out", "type": "datetime"},
    {"key": "minutes", "label": "Time inside", "type": "minutes"},
    {"key": "checkedInBy", "label": "Checked in by", "type": "text"},
    {"key": "branch", "label": "Branch", "type": "text"},
]
RANGE_LABELS = {"today": "Today", "week": "This week", "month": "This month"}


def _masked_aadhaar(tail) -> str | None:
    digits = "".join(ch for ch in str(tail or "") if ch.isdigit())
    return f"XXXX XXXX {digits[-4:]}" if len(digits) >= 4 else None


def _fmt_day(d) -> str:
    return d.strftime("%d %b %Y").lstrip("0")


def _filters_text(p: dict) -> list[tuple[str, str]]:
    if p["from"] or p["to"]:
        if p["from"] and p["to"] and p["from"] == p["to"]:
            dates = _fmt_day(p["from"])
        elif p["from"] and p["to"]:
            dates = f"{_fmt_day(p['from'])} to {_fmt_day(p['to'])}"
        elif p["from"]:
            dates = f"From {_fmt_day(p['from'])}"
        else:
            dates = f"Up to {_fmt_day(p['to'])}"
    else:
        dates = RANGE_LABELS.get(p["range"], "Today")
    pairs = [("Dates", dates)]
    if p["status"]:
        pairs.append(("Status", VISIT_STATUS_LABELS[p["status"]]))
    if p["branch_id"] is not None:
        branch = Branch.objects.filter(pk=p["branch_id"]).values_list("name", flat=True).first()
        pairs.append(("Branch", branch or f"#{p['branch_id']}"))
    if p["host_id"] is not None:
        emp = Employee.objects.filter(pk=p["host_id"]).values("first_name", "last_name").first()
        pairs.append(("Meeting", f"{emp['first_name']} {emp['last_name']}".strip() if emp else f"#{p['host_id']}"))
    if p["department_id"] is not None:
        dept = Department.objects.filter(pk=p["department_id"]).values_list("name", flat=True).first()
        pairs.append(("Department", dept or f"#{p['department_id']}"))
    if p["source"]:
        pairs.append(("Checked in", VISIT_SOURCE_LABELS[p["source"]]))
    if p["q"]:
        pairs.append(("Search", p["q"]))
    return pairs


@api_view(["GET"])
@require_hr
def visitor_export(request: Request) -> Response:
    """The list's filters (visitor/records) as an Excel or PDF file (?fmt=xlsx|pdf), every matching row. The phone is
    shown (HR sees it on the page); the Aadhaar number only as XXXX XXXX 1234 (its last four digits are all that is
    read). 413 when there are too many rows for one file."""
    try:
        p = visit_filter_params(request)
    except VisitFilterError as e:
        return _bad(str(e))
    return visits_file(request, p)


def visits_file(request: Request, p: dict, *, title: str = "Visitors", slug: str = "visitors", log_description=None):
    """The visits of the filters `p` (visit_filter_params) as an Excel / PDF file (?fmt), see visitor_export. Shared with
    the reception desk's own export (reception-devices/visits/export, `p` forced to the desk's branch)."""
    now = _now()
    today_start = _range_bounds(now)[0]
    rows = list(
        filtered_visits(p, today_start)
        # the name / Aadhaar given at each visit (visitor_identity.py), the Aadhaar's last four digits only
        .annotate(shown_name=name_expr(), aadhaar_tail=Right(Trim(aadhaar_expr()), 4))
        .values(
            "visited_at",
            "checked_out_at",
            "shown_name",
            "visitor__phone",
            "aadhaar_tail",
            "company",
            "people_count",
            "vehicle_number",
            "whom_to_meet",
            "meeting_employee__first_name",
            "meeting_employee__last_name",
            "meeting_employee__department__name",
            "purpose",
            "source",
            "checked_in_by",
            "branch__name",
        )[:EXPORT_FETCH_LIMIT]
    )

    out, minutes_done = [], []
    inside = 0
    for r in rows:
        status = visit_status(
            SimpleNamespace(visited_at=r["visited_at"], checked_out_at=r["checked_out_at"]), today_start
        )
        minutes = None
        if status == VISIT_CHECKED_OUT:
            minutes = whole_minutes(r["visited_at"], r["checked_out_at"])
            minutes_done.append(minutes)
        elif status == VISIT_INSIDE:
            inside += 1
            minutes = whole_minutes(r["visited_at"], now)
        first, last = r["meeting_employee__first_name"], r["meeting_employee__last_name"]
        host = f"{first or ''} {last or ''}".strip() if (first or last) else r["whom_to_meet"]
        label = VISIT_SOURCE_LABELS.get(r["source"], r["source"])
        by = r["checked_in_by"]
        out.append(
            {
                "visitedAt": r["visited_at"],
                "visitor": r["shown_name"],
                "phone": r["visitor__phone"],
                "aadhaar": _masked_aadhaar(r["aadhaar_tail"]),
                "company": r["company"],
                "people": r["people_count"],
                "vehicle": r["vehicle_number"],
                "host": host,
                "department": r["meeting_employee__department__name"],
                "purpose": r["purpose"],
                "status": VISIT_STATUS_LABELS[status],
                "checkedOutAt": r["checked_out_at"],
                "minutes": minutes,
                "checkedInBy": f"{label} ({by})" if by and r["source"] != VisitorVisit.SOURCE_QR else label,
                "branch": r["branch__name"],
            }
        )

    summary = [
        {"label": "Visits", "value": len(out)},
        {"label": "Checked out", "value": len(minutes_done)},
        {"label": "Inside now", "value": inside},
    ]
    if minutes_done:
        summary.append(
            {
                "label": "Average time inside",
                "value": average_minutes(minutes_done),  # the page's rule: whole minutes, mean half up
                "format": "minutes",
            }
        )
    return file_response(
        request,
        slug=slug,
        title=title,
        columns=EXPORT_COLUMNS,
        rows=out,
        fmt=request.query_params.get("fmt"),
        filters_text=_filters_text(p),
        summary=summary,
        notes=["Check-out is recorded from 18 Nov 2026 for visits checked out by HR or a reception desk."],
        log_description=log_description,
    )

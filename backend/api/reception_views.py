"""
Reception desks: the desk's own side under /api/reception-devices/* (the HR side, Visitors -> Manage Reception, is
reception_admin_views.py). A desk is not an HR login: everything here but the sign-in is desk-authenticated
(auth.require_reception_device: the desk's own token, never an HR one), always limited to the desk's own branch.

    POST login              public, throttle "login". {username, password} -> {token, deviceId, deskName, desk}. ONE
                            sign-in for every desk (/reception-login): the username decides the desk (case does not
                            matter). 401 wrong / 403 switched off / 429 five wrong tries in 15 min
                            (reception_credentials.LOGIN_ERRORS), each with a `code`; every try is a ReceptionLoginAttempt.
                            A success opens a ReceptionSession and hands out a 30-day token for it.
    GET  login-info/<token> public: the desk an old per-desk link names (a hint on the sign-in page only).
    GET  me                 {desk, session, expiresAt} plus `token` (a fresh one for the same session) when fewer than 15
                            days are left, so a desk in daily use never runs out (the console calls it on load, every 5
                            minutes, when its tab comes back into view and when the network returns).
    POST logout             ends THIS session only (other browsers of the desk stay signed in) -> 204.
    GET  summary            today / this week / this month, inside now and checked out today, at the desk's branch.
    GET  visits             the branch's visits: range (today by default) or from / to, status, q, page, pageSize.
    POST visits             a walk-in visitor registered at the desk = checked in now (the same form, checks, visitor
                            reuse and host message as HR's POST visitor/visits; source "reception", checked in by the desk,
                            checked_in_desk = this desk, the branch = the desk's).
    GET  visits/export      the same visits as an Excel / PDF file (?fmt=xlsx|pdf); the Aadhaar number only masked.
    POST visits/<id>/check-out   visitor_admin_views.reception_visit_check_out (records checked_out_desk).
    POST host-lookup        {phone} -> {found, employee}: the employee a visitor is meeting, by phone (the QR form's own
                            look-up), of the desk's branch only (since 19 Nov 2026: a host must work at this branch).
    GET  visitor-lookup     ?phone -> {visitor}: a returning visitor of this branch (name, visits, inside now), or null.

A switched-off or deleted desk gets 403 code "desk_revoked", an ended session 401 code "session_ended" (from
require_reception_device itself); the console then clears its three localStorage keys and shows /reception-login.
"""

from __future__ import annotations

from datetime import datetime
from datetime import timezone as dt_timezone

from django.db.models import Count, Max, Q
from rest_framework.decorators import api_view
from rest_framework.request import Request
from rest_framework.response import Response

from . import visitor_admin_views as vav
from .audit_utils import log_action
from .auth import require_reception_device
from .employee_photo import photo_links
from .jwt_utils import verify_token
from .models import ReceptionDevice, ReceptionSession, Visitor, VisitorVisit
from .outpass_visitor_views import (
    VisitFilterError,
    _day_start,
    _employee_contact_json,
    _find_employee_by_phone,
    _now,
    _paginate_params,
    _range_bounds,
    _visitor_visit_dict,
    filtered_visits,
    find_visitor_by_phone,
    visit_filter_params,
    visit_rows,
    with_visit_count,
)
from .reception_credentials import (
    LOGIN_ERRORS,
    LOGIN_OK,
    check_desk_login,
    desk_token,
    end_desk_session,
    start_desk_session,
    token_expires_soon,
)
from .throttles import throttle


def _desk_json(desk: ReceptionDevice) -> dict:
    """What the desk's own screens show about it (never the username, password or login link)."""
    return {
        "id": desk.id,
        "name": desk.name,
        "branchName": desk.branch.name if desk.branch_id else None,
        "location": desk.location or None,
    }


def _iso(value) -> str | None:
    return value.isoformat() if value else None


def _session_json(session: ReceptionSession | None) -> dict | None:
    """This browser's sign-in (None for a token from before 18 Nov 2026, which has no session row). Never the sid."""
    if session is None:
        return None
    return {
        "id": session.id,
        "deviceLabel": session.device_label or None,
        "createdAt": _iso(session.created_at),
        "lastSeenAt": _iso(session.last_seen_at),
    }


def _expires_at(payload: dict) -> str | None:
    exp = payload.get("exp")
    if not isinstance(exp, (int, float)):
        return None
    return datetime.fromtimestamp(exp, tz=dt_timezone.utc).isoformat()


# ── Reception desk auth -public sign-in, then the desk's own session ─────────


@api_view(["GET"])
def reception_login_info(request: Request, login_token: str) -> Response:
    device = ReceptionDevice.objects.filter(login_token=login_token).select_related("branch").first()
    if not device:
        return Response({"error": "This reception login link is not recognized."}, status=404)
    return Response({"deskName": device.name, "branchName": device.branch.name, "isActive": device.is_active})


@api_view(["POST"])
@throttle("login")
def reception_login(request: Request) -> Response:
    data = request.data if hasattr(request.data, "get") else {}
    username, password = data.get("username"), data.get("password")
    if not isinstance(username, str) or not username.strip() or not isinstance(password, str) or not password:
        return Response({"error": "Enter the desk's username and password.", "code": "missing"}, status=400)
    desk, outcome = check_desk_login(request, username, password)
    if outcome != LOGIN_OK:
        status, message = LOGIN_ERRORS[outcome]
        return Response({"error": message, "code": outcome}, status=status)
    _session, token = start_desk_session(desk, request)
    # token / deviceId / deskName: the keys the console stored before 18 Nov 2026; desk: what it shows now
    return Response({"token": token, "deviceId": desk.id, "deskName": desk.name, "desk": _desk_json(desk)})


@api_view(["GET"])
@require_reception_device
def reception_me(request: Request) -> Response:
    desk, session = request.reception_device, request.reception_session
    body = {"desk": _desk_json(desk), "session": _session_json(session), "expiresAt": _expires_at(request.jwt_user)}
    # Only a session token is renewed: an old token (no rsid) cannot be ended by HR, so it never becomes a 30-day one.
    if session is not None and token_expires_soon(request.jwt_user):
        fresh = desk_token(desk, session)
        body["token"] = fresh
        body["expiresAt"] = _expires_at(verify_token(fresh))
    return Response(body)


@api_view(["POST"])
@require_reception_device
def reception_logout(request: Request) -> Response:
    # An old token without a session has nothing to end on the server: the console forgets it, and it runs out.
    if request.reception_session is not None:
        end_desk_session(request.reception_session, ReceptionSession.REVOKED_LOGOUT)
    return Response(status=204)


# ── Reception dashboard -the desk's branch only ─────────────────────────────


@api_view(["GET"])
@require_reception_device
def reception_summary(request: Request) -> Response:
    today_start, week_start, month_start = _range_bounds()
    qs = VisitorVisit.objects.filter(branch_id=request.reception_device.branch_id)
    return Response(
        {
            "today": qs.filter(visited_at__gte=today_start).count(),
            "thisWeek": qs.filter(visited_at__gte=week_start).count(),
            "thisMonth": qs.filter(visited_at__gte=month_start).count(),
            # who is in the building now (came today, not checked out) and today's check-outs (from 18 Nov 2026)
            "insideNow": qs.filter(visited_at__gte=today_start, checked_out_at__isnull=True).count(),
            "checkedOutToday": qs.filter(checked_out_at__gte=today_start).count(),
        }
    )


def _desk_filters(request: Request) -> dict:
    """The Visitors filters of the query string (visit_filter_params), always at the desk's own branch (any branchId
    asked for is ignored) and today when no range or dates are given. Raises VisitFilterError."""
    p = visit_filter_params(request)
    qp = request.query_params
    if not ((qp.get("range") or "").strip() or (qp.get("from") or "").strip() or (qp.get("to") or "").strip()):
        p["range"] = "today"
    p["branch_id"] = request.reception_device.branch_id
    return p


@api_view(["GET", "POST"])
@require_reception_device
def reception_visits(request: Request) -> Response:
    if request.method == "POST":
        return _desk_register(request)
    try:
        p = _desk_filters(request)
    except VisitFilterError as e:
        return Response({"error": str(e)}, status=400)
    page, page_size = _paginate_params(request)
    branch_id = p["branch_id"]
    now = _now()
    today_start = _day_start(now)
    qs = filtered_visits(p, today_start)
    total = qs.count()
    offset = (page - 1) * page_size
    # one query for the page (visit counts included) and one for the hosts' photo links, never a query per row
    rows = list(with_visit_count(visit_rows(qs), branch_id)[offset : offset + page_size])
    photos = photo_links(v.meeting_employee_id for v in rows)
    return Response(
        {
            "items": [_visitor_visit_dict(v, photos, now=now, today_start=today_start) for v in rows],
            "total": total,
            "page": page,
            "pageSize": page_size,
        }
    )


def _desk_register(request: Request) -> Response:
    """A walk-in visitor registered at the desk: checked in now at the desk's branch (visitor_admin_views.register_visit,
    the very code HR's Register visitor runs, as a one-branch caller), source "reception", checked in by the desk. 201 +
    the visit (never another branch's details of the person)."""
    desk = request.reception_device
    f, error = vav.register_fields(request.data)
    if error is not None:
        return error
    visit, error = vav.register_visit(
        f, branch=desk.branch, source=VisitorVisit.SOURCE_RECEPTION, checked_in_by=desk.name, desk=desk, scoped=True
    )
    if error is not None:
        return error
    log_action(
        request,
        "create",
        "outpass_visitors",
        record_id=visit.id,
        description=(
            f"Visitor registered at the reception desk {desk.name}: "
            f"{(visit.shown_identity or {}).get('name') or visit.visitor.name}, meeting {visit.whom_to_meet}"
        )[:480],
    )
    return Response(vav.registered_json(visit, desk.branch_id), status=201)


@api_view(["GET"])
@require_reception_device
def reception_visits_export(request: Request) -> Response:
    """This desk's branch visits (the list's filters: range / from / to, status, q) as ?fmt=xlsx|pdf."""
    desk = request.reception_device
    try:
        p = _desk_filters(request)
    except VisitFilterError as e:
        return Response({"error": str(e)}, status=400)
    return vav.visits_file(
        request,
        p,
        title=f"Visitors - {desk.name}",
        slug=f"visitors_{desk.name}",
    )


@api_view(["POST"])
@require_reception_device
def reception_host_lookup(request: Request) -> Response:
    """Whom the visitor is meeting, by the employee's phone: {found, employee} (the QR form's own look-up). Only an
    employee of the desk's branch is found: a desk never reads another branch's staff contact details."""
    data = request.data if hasattr(request.data, "get") else {}
    phone = str(data.get("phone") or "").strip()
    if not phone:
        return Response({"error": "Enter the employee's phone number."}, status=400)
    employee = _find_employee_by_phone(phone)
    if not employee or employee.branch_id != request.reception_device.branch_id:
        return Response({"found": False})
    return Response({"found": True, "employee": _employee_contact_json(employee)})


@api_view(["GET"])
@require_reception_device
def reception_visitor_lookup(request: Request) -> Response:
    """A returning visitor of this desk's branch by phone (however it is typed): {visitor: {id, name, visitCount,
    lastVisitAt, insideNow, lastVisitId} | null}. Someone who has only visited other branches is not shown."""
    branch_id = request.reception_device.branch_id
    match = find_visitor_by_phone(request.query_params.get("phone") or "")
    if match is None:
        return Response({"visitor": None})
    today_start = _day_start(_now())
    here = VisitorVisit.objects.filter(visitor=match, branch_id=branch_id)
    agg = here.aggregate(
        n=Count("id"),
        last=Max("visited_at"),
        inside=Count("id", filter=Q(checked_out_at__isnull=True, visited_at__gte=today_start)),
    )
    if not agg["n"]:
        return Response({"visitor": None})
    last = here.order_by("-visited_at", "-id").values_list("id", flat=True).first()
    person: Visitor = match
    return Response(
        {
            "visitor": {
                "id": person.id,
                "name": person.name,
                "visitCount": agg["n"],
                "lastVisitAt": _iso(agg["last"]),
                "insideNow": agg["inside"] > 0,
                "lastVisitId": last,
            }
        }
    )

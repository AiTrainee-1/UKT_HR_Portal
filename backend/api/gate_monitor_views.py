"""
Gate Monitor (/gatemonitor): the one shared gate sign-in and the gate's own console, under /api/gate-monitor/*.
Gate-device authenticated (auth.require_gate_device), never an HR token, so these paths are not in the permission
tree (tests_permission_tree.API_ALLOWLIST says why).

    POST login              public, throttle "login". {username, password} -> {token, gate}. The username decides the
                            gate (case does not matter). 401 wrong / 403 switched off / 429 five wrong tries in 15 min
                            (gate_credentials.LOGIN_ERRORS), each with a `code`. Every try is a GateLoginAttempt row.
    GET  me                 {gate, session, expiresAt} plus `token` (a fresh one for the same session) when fewer than 15
                            days are left, so a gate in daily use never runs out. The monitor calls it on load, every
                            5 minutes and whenever its tab comes back into view.
    POST logout             ends THIS session only (other browsers of the gate stay signed in) -> 204.
    POST scan               {qrToken} -> exactly POST gate-devices/scan (gate_scanner_views.resolve_gate_scan, which
                            honours the gate's allow_outpass / allow_tea_break).
    GET  summary            today (IST) at this gate: {exits, returns, teaOut, teaIn, denied, total, passesOutNow,
                            teaOutNow, outNow, date}.
    GET  records            this gate's records (gate_records.records_page): from, to, type, result, q, page, pageSize.
                            gateId and branchId are IGNORED: a gate only ever sees its own rows.
    GET  records/export     the same rows as an Excel / PDF file (?fmt=xlsx|pdf), titled "Gate records - <gate>".

A switched-off or deleted gate gets 403 code "gate_revoked" and an ended session 401 code "session_ended" from
require_gate_device itself; the monitor then clears its three localStorage keys and shows its sign-in page.
"""

from __future__ import annotations

from datetime import datetime
from datetime import timezone as dt_timezone

from rest_framework.decorators import api_view
from rest_framework.request import Request
from rest_framework.response import Response

from . import gate_exports, gate_records
from .auth import require_gate_device
from .clock import ist_today
from .gate_credentials import (
    LOGIN_ERRORS,
    LOGIN_OK,
    check_gate_login,
    end_gate_session,
    gate_token,
    start_gate_session,
    token_expires_soon,
)
from .gate_scanner_views import resolve_gate_scan
from .jwt_utils import verify_token
from .models import GateDevice, GateSession
from .throttles import throttle

# The gate monitor's export: every gate record column except "Gate" (the file is one gate's, named in its title).
EXPORT_COLUMNS = [c for c in gate_records.EXPORT_COLUMNS if c["key"] != "gate"]


def _gate_json(gate: GateDevice) -> dict:
    """What the monitor shows about its gate (never the username, password or login link)."""
    return {
        "id": gate.id,
        "name": gate.name,
        "branchName": gate.branch.name if gate.branch_id else None,
        "location": gate.location or None,
        "allowOutpass": bool(gate.allow_outpass),
        "allowTeaBreak": bool(gate.allow_tea_break),
    }


def _iso(value) -> str | None:
    return value.isoformat() if value else None


def _session_json(session: GateSession | None) -> dict | None:
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


@api_view(["POST"])
@throttle("login")
def gate_monitor_login(request: Request) -> Response:
    data = request.data if hasattr(request.data, "get") else {}
    username, password = data.get("username"), data.get("password")
    if not isinstance(username, str) or not username.strip() or not isinstance(password, str) or not password:
        return Response({"error": "Enter the gate's username and password.", "code": "missing"}, status=400)
    gate, outcome = check_gate_login(request, username, password)
    if outcome != LOGIN_OK:
        status, message = LOGIN_ERRORS[outcome]
        return Response({"error": message, "code": outcome}, status=status)
    _session, token = start_gate_session(gate, request)
    return Response({"token": token, "gate": _gate_json(gate)})


@api_view(["GET"])
@require_gate_device
def gate_monitor_me(request: Request) -> Response:
    gate, session = request.gate_device, request.gate_session
    body = {"gate": _gate_json(gate), "session": _session_json(session), "expiresAt": _expires_at(request.jwt_user)}
    # Only a session token is renewed: an old token (no gsid) cannot be ended by HR, so it is never turned into a
    # 30-day one; it simply runs out and the gate signs in again.
    if session is not None and token_expires_soon(request.jwt_user):
        fresh = gate_token(gate, session)
        body["token"] = fresh
        body["expiresAt"] = _expires_at(verify_token(fresh))
    return Response(body)


@api_view(["POST"])
@require_gate_device
def gate_monitor_logout(request: Request) -> Response:
    # An old token without a session has nothing to end on the server: the monitor forgets it, and it runs out.
    if request.gate_session is not None:
        end_gate_session(request.gate_session, GateSession.REVOKED_LOGOUT)
    return Response(status=204)


@api_view(["POST"])
@require_gate_device
def gate_monitor_scan(request: Request) -> Response:
    data = request.data if hasattr(request.data, "get") else {}
    body, status = resolve_gate_scan(request.gate_device, data.get("qrToken"))
    return Response(body, status=status)


@api_view(["GET"])
@require_gate_device
def gate_monitor_summary(request: Request) -> Response:
    summary = gate_records.gate_summary([request.gate_device.id])
    return Response({**summary, "date": ist_today().isoformat()})


def _params(request: Request) -> dict:
    """The record filters of the query string, without gateId / branchId (a gate sees its own rows only)."""
    return gate_records.params_from_query(request.query_params, allow_gate=False, allow_branch=False)


@api_view(["GET"])
@require_gate_device
def gate_monitor_records(request: Request) -> Response:
    try:
        page = gate_records.records_page(None, gate_ids=[request.gate_device.id], **_params(request))
    except gate_records.BadParam as e:
        return Response({"error": str(e)}, status=400)
    return Response(page)


@api_view(["GET"])
@require_gate_device
def gate_monitor_records_export(request: Request) -> Response:
    gate = request.gate_device
    fmt = gate_exports.export_format(request.query_params.get("fmt"))
    if fmt is None:
        return gate_exports.bad_format_response()
    try:
        params = _params(request)
        rows = gate_records.records_for_export(None, gate_ids=[gate.id], **params)
        counts = gate_records.record_counts(
            None, gate_ids=[gate.id], date_from=params["date_from"], date_to=params["date_to"], q=params["q"]
        )
    except gate_records.BadParam as e:
        return Response({"error": str(e)}, status=400)
    title = f"Gate records - {gate.name}"
    return gate_exports.file_response(
        request,
        slug=f"gate_records_{gate.name}",
        title=title,
        columns=EXPORT_COLUMNS,
        rows=rows,
        fmt=fmt,
        filters_text=gate_records.describe_filters(gate_names=[gate.name], **params),
        summary=gate_records.counts_summary(counts),
        log_description=f"{title} (gate monitor) - {fmt.upper()} - {len(rows)} rows",
    )

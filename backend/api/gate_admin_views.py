"""
Manage Gates (HR portal): the gate logins under /api/gate-devices, permission key outpass_visitors.outpass.gate_devices
(view for GET, edit for writes; POST <id>/reveal-password is outpass_visitors.outpass.gate_devices.view_password, which
is off unless the role sets it itself: permission_registry.REQUIRE_EXPLICIT). The middleware enforces those levels; every
view here also keeps a branch-scoped HR user to the gates of their own branch (another branch's gate is "not found",
never shown).

    GET    gate-devices                     every gate in scope (?q, ?status=active|inactive, ?branchId unscoped only)
    POST   gate-devices                     add a gate
    GET    gate-devices/<id>                one gate + its signed-in sessions
    PUT    gate-devices/<id>                change it (a new username / password, or switching it off, signs it out)
    DELETE gate-devices/<id>                hard delete (the page steers people to switching it off instead)
    POST   gate-devices/<id>/reveal-password    the stored password (audit "view_password"), or 409 not_stored
    POST   gate-devices/<id>/sign-out       end every session of the gate
    GET    gate-devices/summary             the tiles of the page (?from, ?to, ?branchId)
    GET    gate-devices/records             gate_records.records_page (?gateId ?from ?to ?type ?result ?q ?branchId ...)
    GET    gate-devices/records/export      the same records as an Excel / PDF file (?fmt=xlsx|pdf)
    GET    gate-devices/export              the gate list as a file (no password, no login link)

A gate's JSON keeps every key the old dialog and the e2e suite read (id, name, branchId, branchName, username, isActive,
loginToken, createdBy, createdAt, lastLoginAt) and adds location, notes, allowOutpass, allowTeaBreak, updatedAt,
updatedBy, passwordViewable, activeSessions, lastActivityAt and counts {today, exits, returns, teaOut, teaIn, denied,
total} (today = every record of today, the others all time). The numbers of a whole list come from a fixed number of
grouped queries (gate_records.gate_counts / gate_last_activity, one sessions count), never one query per gate. No
payload or file ever holds password_hash, password_encrypted or a password; the login link token stays only in the
JSON the old dialog used (loginToken), never in a file.

gate_devices / gate_device_detail / _gate_device_json moved here from gate_scanner_views.py on 18 Nov 2026; every write
is audit-logged (log_action create / update / delete / view_password / export, module "outpass_visitors") and stamps
updated_at / updated_by, which also ends a sign-in lock of the gate (gate_credentials.login_locked_out).
"""

from __future__ import annotations

import uuid
from django.db.models import Count, Q
from django.db.models.functions import Coalesce
from django.utils import timezone
from rest_framework.decorators import api_view
from rest_framework.request import Request
from rest_framework.response import Response

from . import gate_records as gr
from .audit_utils import log_action
from .auth import get_hr_display_name, require_hr
from .branch_scope import get_branch_scope, scope_to_branch
from .clock import ist_today
from .gate_credentials import (
    MIN_PASSWORD_LENGTH,
    SIGNED_IN_WITHIN,
    TOKEN_LIFETIME,
    open_sessions,
    password_viewable,
    reveal_gate_password,
    revoke_gate_sessions,
    set_gate_password,
)
from .gate_exports import file_response
from .models import Branch, GateDevice, GateSession

MIN_USERNAME_LENGTH = 3
MAX_USERNAME_LENGTH = 60
STATUS_ACTIVE = "active"
STATUS_INACTIVE = "inactive"

NOT_FOUND = {"error": "Gate not found"}
NOT_STORED = {
    "error": "This gate's password was set before 18 Nov 2026, so it cannot be shown. Set a new password to see it.",
    "code": "not_stored",
}
OWN_BRANCH_ONLY = "You can only keep gates in your own branch."

# The gate list file: what HR needs to manage the gates, never a password or a login link
LIST_EXPORT_COLUMNS: list[dict] = [
    {"key": "name", "label": "Gate", "type": "text"},
    {"key": "branch", "label": "Branch", "type": "text"},
    {"key": "location", "label": "Location", "type": "text"},
    {"key": "username", "label": "Username", "type": "text"},
    {"key": "status", "label": "Status", "type": "text"},
    {"key": "takes", "label": "Takes", "type": "text"},
    {"key": "today", "label": "Records today", "type": "int"},
    {"key": "exits", "label": "Exits", "type": "int"},
    {"key": "returns", "label": "Returns", "type": "int"},
    {"key": "teaOut", "label": "Tea break out", "type": "int"},
    {"key": "teaIn", "label": "Tea break in", "type": "int"},
    {"key": "denied", "label": "Denied", "type": "int"},
    {"key": "total", "label": "All records", "type": "int"},
    {"key": "sessions", "label": "Signed in on", "type": "int"},
    {"key": "lastActivity", "label": "Last activity", "type": "datetime"},
    {"key": "lastLogin", "label": "Last sign-in", "type": "datetime"},
    {"key": "createdBy", "label": "Created by", "type": "text"},
    {"key": "createdAt", "label": "Created on", "type": "datetime"},
    {"key": "updatedBy", "label": "Changed by", "type": "text"},
    {"key": "updatedAt", "label": "Changed on", "type": "datetime"},
    {"key": "notes", "label": "Notes", "type": "text"},
]


def _iso(value):
    return value.isoformat() if value else None


def _not_found() -> Response:
    return Response(NOT_FOUND, status=404)


def _bad(message: str, status: int = 400) -> Response:
    return Response({"error": message}, status=status)


# ── the numbers beside each gate ──────────────────────────────────────────────


def live_sessions(gate_ids=None):
    """Open sessions whose token can still be in use: not revoked, and seen (or, never seen, started) within the token
    lifetime. A session nobody revoked but whose 30-day token has long expired is not "signed in" any more."""
    since = timezone.now() - TOKEN_LIFETIME
    return open_sessions(gate_ids).annotate(seen=Coalesce("last_seen_at", "created_at")).filter(seen__gte=since)


def _extras(gate_ids: list[int]) -> dict:
    """{gate id: {counts, lastActivityAt, activeSessions}} for these gates, in a fixed number of queries (3 + 3 for the
    counts, 3 for the last activity, 1 for the sessions) whatever the number of gates."""
    if not gate_ids:
        return {}
    today = ist_today()
    totals = gr.gate_counts(gate_ids)
    todays = gr.gate_counts(gate_ids, today, today)
    last = gr.gate_last_activity(gate_ids)
    sessions = dict(
        live_sessions(gate_ids).order_by().values("gate_id").annotate(n=Count("id")).values_list("gate_id", "n")
    )
    out = {}
    for gid in gate_ids:
        counts = dict(totals.get(gid) or {})
        counts["today"] = (todays.get(gid) or {}).get("total", 0)
        out[gid] = {"counts": counts, "lastActivityAt": last.get(gid), "activeSessions": sessions.get(gid, 0)}
    return out


def _empty_counts() -> dict:
    return {"today": 0, "exits": 0, "returns": 0, "teaOut": 0, "teaIn": 0, "denied": 0, "total": 0}


def _gate_device_json(gate: GateDevice, extra: dict | None = None) -> dict:
    """A gate as the HR pages show it. The first ten keys are the old dialog's (unchanged); `extra` is this gate's
    entry of _extras (computed for it alone when not given). Never a password, a hash or the encrypted copy."""
    if extra is None:
        extra = _extras([gate.id]).get(gate.id) or {}
    counts = {**_empty_counts(), **(extra.get("counts") or {})}
    return {
        "id": gate.id,
        "name": gate.name,
        "branchId": gate.branch_id,
        "branchName": gate.branch.name if gate.branch_id else None,
        "username": gate.username,
        "isActive": gate.is_active,
        "loginToken": gate.login_token,
        "createdBy": gate.created_by,
        "createdAt": gate.created_at.isoformat(),
        "lastLoginAt": _iso(gate.last_login_at),
        "location": gate.location,
        "notes": gate.notes,
        "allowOutpass": gate.allow_outpass,
        "allowTeaBreak": gate.allow_tea_break,
        "updatedAt": _iso(gate.updated_at),
        "updatedBy": gate.updated_by,
        "passwordViewable": password_viewable(gate),
        "activeSessions": extra.get("activeSessions", 0),
        "lastActivityAt": _iso(extra.get("lastActivityAt")),
        "counts": counts,
    }


def _sessions_json(gate: GateDevice) -> list[dict]:
    rows = live_sessions([gate.id]).order_by("-seen", "-id")
    return [
        {
            "id": s.id,
            "deviceLabel": s.device_label or "Unknown browser",
            "createdAt": _iso(s.created_at),
            "lastSeenAt": _iso(s.last_seen_at),
        }
        for s in rows
    ]


# ── input ─────────────────────────────────────────────────────────────────────


class _Invalid(ValueError):
    """Bad input: str(e) is the message of the 400."""


def _flag(data, key: str):
    """A true / false field of the body (JSON booleans, also "true" / "false" / 1 / 0). Raises _Invalid."""
    value = data.get(key)
    if isinstance(value, bool):
        return value
    if value in (0, 1):
        return bool(value)
    if isinstance(value, str) and value.strip().lower() in ("true", "false", "1", "0"):
        return value.strip().lower() in ("true", "1")
    raise _Invalid(f"{key} must be true or false")


def _text(data, key: str, max_length: int = 500) -> str | None:
    """A free-text field: trimmed, empty -> None, at most max_length characters. Raises _Invalid."""
    value = data.get(key)
    if value is None:
        return None
    if not isinstance(value, str):
        raise _Invalid(f"{key} must be text")
    value = value.strip()
    if len(value) > max_length:
        raise _Invalid(f"{key} can be at most {max_length} characters")
    return value or None


def _username(data) -> str:
    value = data.get("username")
    value = value.strip() if isinstance(value, str) else ""
    if len(value) < MIN_USERNAME_LENGTH:
        raise _Invalid(f"Username must be at least {MIN_USERNAME_LENGTH} characters")
    if len(value) > MAX_USERNAME_LENGTH:
        raise _Invalid(f"Username can be at most {MAX_USERNAME_LENGTH} characters")
    if any(ch.isspace() for ch in value):
        raise _Invalid("Username cannot have spaces")
    return value


def _password(data) -> str:
    value = data.get("password")
    if not isinstance(value, str) or len(value) < MIN_PASSWORD_LENGTH:
        raise _Invalid(f"Password must be at least {MIN_PASSWORD_LENGTH} characters")
    if len(value) > 128:
        raise _Invalid("Password can be at most 128 characters")
    return value


def _username_taken(username: str, exclude_id: int | None = None) -> bool:
    qs = GateDevice.objects.filter(username__iexact=username)
    if exclude_id is not None:
        qs = qs.exclude(pk=exclude_id)
    return qs.exists()


def _scoped_gates(request: Request):
    return scope_to_branch(GateDevice.objects.select_related("branch"), request)


def _scoped_gate(request: Request, pk: int) -> GateDevice | None:
    return _scoped_gates(request).filter(pk=pk).first()


def _list_filters(request: Request, qs):
    """?q (name, username, location, branch), ?status=active|inactive, ?branchId (unscoped users only). Raises
    _Invalid."""
    params = request.query_params
    status = (params.get("status") or "").strip().lower()
    if status == STATUS_ACTIVE:
        qs = qs.filter(is_active=True)
    elif status == STATUS_INACTIVE:
        qs = qs.filter(is_active=False)
    elif status:
        raise _Invalid("status must be active or inactive")
    branch = (params.get("branchId") or "").strip()
    if branch and get_branch_scope(request) is None:
        if not branch.isdigit():
            raise _Invalid("branchId must be a number")
        qs = qs.filter(branch_id=int(branch))
    for term in (params.get("q") or "").split()[:4]:
        qs = qs.filter(
            Q(name__icontains=term)
            | Q(username__icontains=term)
            | Q(location__icontains=term)
            | Q(branch__name__icontains=term)
        )
    return qs


def _branch_name(request: Request, branch_id) -> str | None:
    scope = get_branch_scope(request)
    target = scope if scope is not None else branch_id
    if not target:
        return None
    return Branch.objects.filter(pk=target).values_list("name", flat=True).first()


def _where(gate: GateDevice) -> str:
    return f"{gate.name} ({gate.branch.name})" if gate.branch_id else gate.name


# ── list + add ────────────────────────────────────────────────────────────────


@api_view(["GET", "POST"])
@require_hr
def gate_devices(request: Request) -> Response:
    if request.method == "GET":
        try:
            gates = list(_list_filters(request, _scoped_gates(request).order_by("name", "id")))
        except _Invalid as e:
            return _bad(str(e))
        extras = _extras([g.id for g in gates])
        return Response([_gate_device_json(g, extras.get(g.id)) for g in gates])

    data = request.data
    name = (data.get("name") or "").strip() if isinstance(data.get("name"), str) else ""
    if not name or not data.get("username") or not data.get("password"):
        return _bad("name, username and password are required")
    try:
        username = _username(data)
        password = _password(data)
        location = _text(data, "location", 200)
        notes = _text(data, "notes", 1000)
        allow_outpass = _flag(data, "allowOutpass") if "allowOutpass" in data else True
        allow_tea_break = _flag(data, "allowTeaBreak") if "allowTeaBreak" in data else True
    except _Invalid as e:
        return _bad(str(e))

    branch_id = get_branch_scope(request) or data.get("branchId")
    if not branch_id:
        return _bad("branchId is required")
    branch = Branch.objects.filter(id=branch_id).first() if str(branch_id).isdigit() else None
    if not branch:
        return Response({"error": "Branch not found"}, status=404)

    if _username_taken(username):
        return Response({"error": "That username is already taken"}, status=409)

    who = get_hr_display_name(request)
    gate = GateDevice(
        name=name,
        branch=branch,
        username=username,
        login_token=uuid.uuid4().hex,
        created_by=who,
        location=location,
        notes=notes,
        allow_outpass=allow_outpass,
        allow_tea_break=allow_tea_break,
        updated_at=timezone.now(),
        updated_by=who,
    )
    set_gate_password(gate, password)
    gate.save()
    log_action(
        request,
        "create",
        "outpass_visitors",
        record_id=gate.id,
        description=f"Added gate {_where(gate)} with username {gate.username}",
    )
    return Response(_gate_device_json(gate, {}), status=201)


# ── one gate ──────────────────────────────────────────────────────────────────

# what a PUT may change, as (body key, model field) for the audit entry's old / new values (never the password)
_AUDITED = (
    ("name", "name"),
    ("branchId", "branch_id"),
    ("username", "username"),
    ("location", "location"),
    ("notes", "notes"),
    ("allowOutpass", "allow_outpass"),
    ("allowTeaBreak", "allow_tea_break"),
    ("isActive", "is_active"),
)


def _save_fields(changed: list[str], password_changed: bool) -> list[str]:
    """The model fields a PUT writes: the _AUDITED ones it changed, the password columns when it set one, the stamp."""
    fields = [("branch" if field == "branch_id" else field) for key, field in _AUDITED if key in changed]
    if password_changed:
        fields += ["password_hash", "password_encrypted"]
    return fields + ["updated_at", "updated_by"]


def _apply_update(request: Request, gate: GateDevice, data) -> tuple[bool, bool]:
    """Writes the body's changes onto `gate` (not saved). Returns (password changed, username changed). Raises
    _Invalid (400) or PermissionError (403, a branch move by a branch-bound user) or LookupError (404 branch / 409
    username, the message says which)."""
    if "name" in data:
        name = data.get("name")
        name = name.strip() if isinstance(name, str) else ""
        if not name:
            raise _Invalid("name cannot be empty")
        gate.name = name
    if "branchId" in data and data.get("branchId") not in (None, ""):
        raw = data.get("branchId")
        if not str(raw).isdigit():
            raise _Invalid("branchId must be a number")
        scope = get_branch_scope(request)
        if scope is not None:
            if int(raw) != scope:
                raise PermissionError(OWN_BRANCH_ONLY)
        else:
            branch = Branch.objects.filter(pk=int(raw)).first()
            if branch is None:
                raise LookupError("Branch not found")
            gate.branch = branch
    username_changed = False
    if "username" in data:
        username = _username(data)
        if username != gate.username:
            if _username_taken(username, exclude_id=gate.id):
                raise LookupError("That username is already taken")
            # a change of letter case only is the same sign-in (usernames match case-insensitively): no sign-out
            username_changed = username.lower() != gate.username.lower()
            gate.username = username
    if "location" in data:
        gate.location = _text(data, "location", 200)
    if "notes" in data:
        gate.notes = _text(data, "notes", 1000)
    if "allowOutpass" in data:
        gate.allow_outpass = _flag(data, "allowOutpass")
    if "allowTeaBreak" in data:
        gate.allow_tea_break = _flag(data, "allowTeaBreak")
    if "isActive" in data:
        gate.is_active = _flag(data, "isActive")
    password_changed = False
    if data.get("password"):
        set_gate_password(gate, _password(data))
        password_changed = True
    return password_changed, username_changed


@api_view(["GET", "PUT", "DELETE"])
@require_hr
def gate_device_detail(request: Request, pk: int) -> Response:
    gate = _scoped_gate(request, pk)
    if not gate:
        return _not_found()

    if request.method == "GET":
        return Response({**_gate_device_json(gate), "sessions": _sessions_json(gate)})

    if request.method == "DELETE":
        where, gate_id = _where(gate), gate.id
        gate.delete()
        log_action(
            request,
            "delete",
            "outpass_visitors",
            record_id=gate_id,
            description=f"Deleted gate {where} (its records stay, under a removed gate)",
        )
        return Response(status=204)

    data = request.data
    before = {key: getattr(gate, field) for key, field in _AUDITED}
    was_active = gate.is_active
    try:
        password_changed, username_changed = _apply_update(request, gate, data)
    except _Invalid as e:
        return _bad(str(e))
    except PermissionError as e:
        return _bad(str(e), 403)
    except LookupError as e:
        message = str(e.args[0]) if e.args else "Not found"
        return _bad(message, 409 if "username" in message else 404)

    # updated_at also ends a sign-in lock of this gate (gate_credentials.login_locked_out)
    gate.updated_at = timezone.now()
    gate.updated_by = get_hr_display_name(request)
    after = {key: getattr(gate, field) for key, field in _AUDITED}
    changed = [key for key, _field in _AUDITED if before[key] != after[key]]
    # Only the columns this request changed (and the stamp): another HR change at the same moment (a password reset, a
    # switch-off) is never written back over by this request's older copy of the row.
    gate.save(update_fields=_save_fields(changed, password_changed))

    signed_out = 0
    if was_active and not gate.is_active:
        signed_out += revoke_gate_sessions(gate, GateSession.REVOKED_DEACTIVATED)
    if password_changed:
        signed_out += revoke_gate_sessions(gate, GateSession.REVOKED_PASSWORD_CHANGED)
    if username_changed:
        signed_out += revoke_gate_sessions(gate, GateSession.REVOKED_USERNAME_CHANGED)

    words = [k for k in changed if k != "isActive"] + (["password"] if password_changed else [])
    if was_active != gate.is_active:
        verb = "Switched on" if gate.is_active else "Switched off"
        description = f"{verb} gate {_where(gate)}" + (f"; also changed {', '.join(words)}" if words else "")
    else:
        description = f"Changed gate {_where(gate)}: {', '.join(words) if words else 'nothing'}"
    if signed_out:
        description += f" ({signed_out} signed-in {'browser' if signed_out == 1 else 'browsers'} signed out)"
    log_action(
        request,
        "update",
        "outpass_visitors",
        record_id=gate.id,
        description=description[:480],
        old_values={k: before[k] for k in changed} or None,
        new_values=({k: after[k] for k in changed} | ({"password": "changed"} if password_changed else {})) or None,
    )
    return Response(_gate_device_json(gate))


@api_view(["POST"])
@require_hr
def gate_device_reveal_password(request: Request, pk: int) -> Response:
    """The gate's password, for HR with edit on "See gate passwords" (the middleware enforces the key). Every shown
    password is an audit entry "view_password" (the high-severity "Gate login password viewed" on the MD's activity
    page); the password itself is never logged. A gate set before passwords were kept answers 409 not_stored."""
    gate = _scoped_gate(request, pk)
    if not gate:
        return _not_found()
    password = reveal_gate_password(gate)
    if password is None:
        return Response(NOT_STORED, status=409)
    log_action(
        request,
        "view_password",
        "outpass_visitors",
        record_id=gate.id,
        description=f"Viewed the login password of gate {_where(gate)}",
    )
    response = Response({"password": password})
    response["Cache-Control"] = "no-store"
    return response


@api_view(["POST"])
@require_hr
def gate_device_sign_out(request: Request, pk: int) -> Response:
    """Ends every session of the gate (each gate monitor showing it goes back to its sign-in page)."""
    gate = _scoped_gate(request, pk)
    if not gate:
        return _not_found()
    count = revoke_gate_sessions(gate, GateSession.REVOKED_HR_SIGNED_OUT)
    log_action(
        request,
        "update",
        "outpass_visitors",
        record_id=gate.id,
        description=f"Signed out every browser of gate {_where(gate)} ({count} signed out)",
    )
    return Response({"signedOut": count})


# ── the page's tiles ──────────────────────────────────────────────────────────


@api_view(["GET"])
@require_hr
def gate_devices_summary(request: Request) -> Response:
    """{gates, active, signedInNow, recordsToday, deniedToday, records, denied}: gates in scope, switched on, with a
    session seen in the last 10 minutes; today's records and denials; and the same two for ?from / ?to (no dates =
    all time). ?branchId narrows an unscoped user."""
    params = request.query_params
    branch_raw = (params.get("branchId") or "").strip()
    if branch_raw and not branch_raw.isdigit():
        return _bad("branchId must be a number")
    branch_id = int(branch_raw) if branch_raw and get_branch_scope(request) is None else None
    gates = _scoped_gates(request)
    if branch_id is not None:
        gates = gates.filter(branch_id=branch_id)
    row = gates.aggregate(n=Count("id"), on=Count("id", filter=Q(is_active=True)))
    ids = list(gates.values_list("id", flat=True))
    signed_in = open_sessions(ids).filter(last_seen_at__gte=timezone.now() - SIGNED_IN_WITHIN).count() if ids else 0
    try:
        today = ist_today()
        todays = gr.record_counts(request, date_from=today, date_to=today, branch_id=branch_id)
        ranged = gr.record_counts(
            request, date_from=params.get("from") or None, date_to=params.get("to") or None, branch_id=branch_id
        )
    except gr.BadParam as e:
        return _bad(str(e))
    return Response(
        {
            "gates": row["n"],
            "active": row["on"],
            "signedInNow": signed_in,
            "recordsToday": todays["total"],
            "deniedToday": todays["denied"],
            "records": ranged["total"],
            "denied": ranged["denied"],
        }
    )


# ── records ───────────────────────────────────────────────────────────────────


@api_view(["GET"])
@require_hr
def gate_devices_records(request: Request) -> Response:
    """One page of what happened at the gates in scope (gate_records.records_page): ?gateId (one or "1,2"), ?from ?to
    (IST days), ?type, ?result, ?q, ?branchId (unscoped only), ?page ?pageSize. A gate of another branch simply has no
    rows for a branch-scoped user."""
    try:
        params = gr.params_from_query(request.query_params)
        return Response(gr.records_page(request, **params))
    except gr.BadParam as e:
        return _bad(str(e))


@api_view(["GET"])
@require_hr
def gate_devices_records_export(request: Request) -> Response:
    """The records the list shows (same filters, every page) as ?fmt=xlsx|pdf: "Gate records" (with the gate's name in
    the title when one gate is chosen), the filters line and the counts."""
    try:
        params = gr.params_from_query(request.query_params)
        rows = gr.records_for_export(request, **params)
        counts = gr.record_counts(
            request,
            gate_ids=params.get("gate_ids"),
            date_from=params.get("date_from"),
            date_to=params.get("date_to"),
            q=params.get("q"),
            branch_id=params.get("branch_id"),
        )
    except gr.BadParam as e:
        return _bad(str(e))
    ids = params.get("gate_ids") or ()
    names_by_id = dict(_scoped_gates(request).filter(pk__in=ids).values_list("id", "name")) if ids else {}
    names = [names_by_id[i] for i in ids if i in names_by_id]
    one = names[0] if len(ids) == 1 and names else None
    title = f"Gate records - {one}" if one else "Gate records"
    return file_response(
        request,
        slug=f"gate_records_{one}" if one else "gate_records",
        title=title,
        columns=gr.EXPORT_COLUMNS,
        rows=rows,
        fmt=request.query_params.get("fmt"),
        filters_text=gr.describe_filters(
            gate_names=names, branch_name=_branch_name(request, params.get("branch_id")), **params
        ),
        summary=gr.counts_summary(counts),
    )


# ── the gate list file ────────────────────────────────────────────────────────


@api_view(["GET"])
@require_hr
def gate_devices_export(request: Request) -> Response:
    """The gates in scope (?q, ?status, ?branchId as the list) as ?fmt=xlsx|pdf: name, branch, location, username,
    status, what it takes, its counts, sessions and dates. Never a password, a hash or the login link."""
    try:
        gates = list(_list_filters(request, _scoped_gates(request).order_by("name", "id")))
    except _Invalid as e:
        return _bad(str(e))
    extras = _extras([g.id for g in gates])
    rows = []
    for g in gates:
        extra = extras.get(g.id) or {}
        counts = {**_empty_counts(), **(extra.get("counts") or {})}
        takes = [w for w, on in (("Gate passes", g.allow_outpass), ("Tea breaks", g.allow_tea_break)) if on]
        rows.append(
            {
                "name": g.name,
                "branch": g.branch.name if g.branch_id else None,
                "location": g.location,
                "username": g.username,
                "status": "Switched on" if g.is_active else "Switched off",
                "takes": ", ".join(takes) or "Nothing",
                "today": counts["today"],
                "exits": counts["exits"],
                "returns": counts["returns"],
                "teaOut": counts["teaOut"],
                "teaIn": counts["teaIn"],
                "denied": counts["denied"],
                "total": counts["total"],
                "sessions": extra.get("activeSessions", 0),
                "lastActivity": extra.get("lastActivityAt"),
                "lastLogin": g.last_login_at,
                "createdBy": g.created_by,
                "createdAt": g.created_at,
                "updatedBy": g.updated_by,
                "updatedAt": g.updated_at,
                "notes": g.notes,
            }
        )
    params = request.query_params
    filters: list[tuple[str, str]] = []
    branch_name = _branch_name(request, (params.get("branchId") or "").strip() or None)
    if branch_name:
        filters.append(("Branch", branch_name))
    status = (params.get("status") or "").strip().lower()
    if status:
        filters.append(("Status", "Switched on" if status == STATUS_ACTIVE else "Switched off"))
    if (params.get("q") or "").strip():
        filters.append(("Search", params.get("q").strip()))
    on = sum(1 for g in gates if g.is_active)
    return file_response(
        request,
        slug="gates",
        title="Gates",
        columns=LIST_EXPORT_COLUMNS,
        rows=rows,
        fmt=params.get("fmt"),
        filters_text=filters,
        summary=[
            {"label": "Gates", "value": len(gates)},
            {"label": "Switched on", "value": on},
            {"label": "Switched off", "value": len(gates) - on},
            {"label": "Records today", "value": sum(r["today"] for r in rows)},
        ],
        notes=["Passwords and sign-in links are never part of this file."],
    )

"""
Manage Reception (HR portal, Visitors -> Manage Reception): the reception desk logins under /api/reception-devices,
permission key outpass_visitors.visitors.reception_devices (view for GET, edit for writes; POST <id>/reveal-password is
outpass_visitors.visitors.reception_devices.view_password, which is off unless the role sets it itself:
permission_registry.REQUIRE_EXPLICIT). The middleware enforces those levels; every view here also keeps a branch-scoped
HR user to the desks of their own branch (another branch's desk is "not found", never shown). The desk's own side
(sign-in, console) is reception_views.py.

    GET    reception-devices                    every desk in scope (?q, ?deskStatus=active|inactive, ?branchId unscoped)
    POST   reception-devices                    add a desk
    GET    reception-devices/<id>               one desk + its signed-in browsers
    PUT    reception-devices/<id>               change it (a new username / password, or switching it off, signs it out)
    DELETE reception-devices/<id>               hard delete (the page steers people to switching it off instead)
    POST   reception-devices/<id>/reveal-password   the stored password (audit "view_password"), or 409 not_stored
    POST   reception-devices/<id>/sign-out      end every session of the desk
    GET    reception-devices/overview           the tiles of the page (?from, ?to, ?branchId)
    GET    reception-devices/records            what the desks did: check-ins and check-outs (?deskId ?from ?to ?type ?q
                                                ?branchId ?page ?pageSize)
    GET    reception-devices/records/export     the same records as an Excel / PDF file (?fmt=xlsx|pdf)
    GET    reception-devices/export             the desk list as a file (no password, no login link)

A desk's JSON keeps every key the old Reception logins dialog read (id, name, branchId, branchName, username, isActive,
loginToken, createdBy, createdAt, lastLoginAt) and adds location, notes, updatedAt, updatedBy, passwordViewable,
activeSessions, lastActivityAt and counts {today, checkIns, checkOuts, total} (today = check-ins + check-outs of today in
India time, the others all time). A desk's records are the visits it checked in (a walk-in registered at the desk,
VisitorVisit.checked_in_desk) and the visits it checked out (checked_out_desk), from 18 Nov 2026. The numbers of a whole
list come from a fixed number of grouped queries, never one per desk. No payload or file ever holds password_hash,
password_encrypted or a password; the login link token stays only in the JSON the old dialog used, never in a file.

Every write is audit-logged (log_action create / update / delete / view_password / export, module "outpass_visitors")
and stamps updated_at / updated_by, which also ends a sign-in lock of the desk (reception_credentials.login_locked_out).
"""

from __future__ import annotations

import uuid
from datetime import date, datetime, time, timedelta

from django.db.models import Count, F, Max, Q, TextField, Value
from django.db.models.functions import Coalesce
from django.utils import timezone
from rest_framework.decorators import api_view
from rest_framework.request import Request
from rest_framework.response import Response

from .audit_utils import log_action
from .auth import get_hr_display_name, require_hr
from .branch_scope import get_branch_scope, scope_to_branch
from .clock import FACTORY_TZ
from .gate_exports import file_response
from .gate_records import EXPORT_FETCH_LIMIT
from .models import Branch, ReceptionDevice, ReceptionSession, VisitorVisit
from .outpass_visitor_views import (
    VISIT_STATUS_LABELS,
    _day_start,
    _minutes_inside,
    _now,
    _search_q,
    visit_rows,
    visit_status,
)
from .reception_credentials import (
    MIN_PASSWORD_LENGTH,
    SIGNED_IN_WITHIN,
    TOKEN_LIFETIME,
    open_sessions,
    password_viewable,
    reveal_desk_password,
    revoke_desk_sessions,
    set_desk_password,
)

MIN_USERNAME_LENGTH = 3
MAX_USERNAME_LENGTH = 60
STATUS_ACTIVE = "active"
STATUS_INACTIVE = "inactive"
DEFAULT_PAGE_SIZE = 25
MAX_PAGE_SIZE = 100
MAX_SEARCH_WORDS = 4

CHECK_IN = "check_in"
CHECK_OUT = "check_out"
TYPE_LABELS = {CHECK_IN: "Check-in", CHECK_OUT: "Check-out"}

NOT_FOUND = {"error": "Reception desk not found"}
NOT_STORED = {
    "error": "This desk's password was set before 18 Nov 2026, so it cannot be shown. Set a new password to see it.",
    "code": "not_stored",
}
OWN_BRANCH_ONLY = "You can only keep desks in your own branch."
REMOVED_DESK = "Removed desk"

# The desk list file: what HR needs to manage the desks, never a password or a login link
LIST_EXPORT_COLUMNS: list[dict] = [
    {"key": "name", "label": "Desk", "type": "text"},
    {"key": "branch", "label": "Branch", "type": "text"},
    {"key": "location", "label": "Location", "type": "text"},
    {"key": "username", "label": "Username", "type": "text"},
    {"key": "status", "label": "Status", "type": "text"},
    {"key": "today", "label": "Records today", "type": "int"},
    {"key": "checkIns", "label": "Check-ins", "type": "int"},
    {"key": "checkOuts", "label": "Check-outs", "type": "int"},
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

# The records file: who came, when, at which desk. Never a phone number or an Aadhaar number.
RECORD_EXPORT_COLUMNS: list[dict] = [
    {"key": "at", "label": "When", "type": "datetime"},
    {"key": "type", "label": "Type", "type": "text"},
    {"key": "desk", "label": "Desk", "type": "text"},
    {"key": "visitor", "label": "Visitor", "type": "text"},
    {"key": "company", "label": "Company", "type": "text"},
    {"key": "people", "label": "People", "type": "int", "width": 0.6},
    {"key": "host", "label": "Meeting", "type": "text"},
    {"key": "purpose", "label": "Purpose", "type": "text", "width": 1.4},
    {"key": "status", "label": "Status", "type": "text"},
    {"key": "visitedAt", "label": "Checked in", "type": "datetime"},
    {"key": "checkedOutAt", "label": "Checked out", "type": "datetime"},
    {"key": "minutes", "label": "Time inside", "type": "minutes"},
    {"key": "branch", "label": "Branch", "type": "text"},
]


def _iso(value):
    return value.isoformat() if value else None


def _not_found() -> Response:
    return Response(NOT_FOUND, status=404)


def _bad(message: str, status: int = 400) -> Response:
    return Response({"error": message}, status=status)


class _Invalid(ValueError):
    """Bad input: str(e) is the message of the 400."""


# ── the numbers beside each desk ──────────────────────────────────────────────


def live_sessions(desk_ids=None):
    """Open sessions whose token can still be in use: not revoked, and seen (or, never seen, started) within the token
    lifetime. A session nobody revoked but whose 30-day token has long expired is not "signed in" any more."""
    since = timezone.now() - TOKEN_LIFETIME
    return open_sessions(desk_ids).annotate(seen=Coalesce("last_seen_at", "created_at")).filter(seen__gte=since)


def _empty_counts() -> dict:
    return {"today": 0, "checkIns": 0, "checkOuts": 0, "total": 0}


def _extras(desk_ids: list[int]) -> dict:
    """{desk id: {counts, lastActivityAt, activeSessions}} for these desks in three queries whatever their number (the
    check-ins grouped by desk, the check-outs grouped by desk, the sessions grouped by desk)."""
    if not desk_ids:
        return {}
    today_start = _day_start(_now())
    ins = {
        r["checked_in_desk_id"]: r
        for r in VisitorVisit.objects.filter(checked_in_desk_id__in=desk_ids)
        .order_by()
        .values("checked_in_desk_id")
        .annotate(n=Count("id"), today=Count("id", filter=Q(visited_at__gte=today_start)), last=Max("visited_at"))
    }
    outs = {
        r["checked_out_desk_id"]: r
        for r in VisitorVisit.objects.filter(checked_out_desk_id__in=desk_ids)
        .order_by()
        .values("checked_out_desk_id")
        .annotate(
            n=Count("id"), today=Count("id", filter=Q(checked_out_at__gte=today_start)), last=Max("checked_out_at")
        )
    }
    sessions = dict(
        live_sessions(desk_ids).order_by().values("desk_id").annotate(n=Count("id")).values_list("desk_id", "n")
    )
    out = {}
    for did in desk_ids:
        i, o = ins.get(did) or {}, outs.get(did) or {}
        check_ins, check_outs = i.get("n", 0), o.get("n", 0)
        lasts = [v for v in (i.get("last"), o.get("last")) if v is not None]
        out[did] = {
            "counts": {
                "today": i.get("today", 0) + o.get("today", 0),
                "checkIns": check_ins,
                "checkOuts": check_outs,
                "total": check_ins + check_outs,
            },
            "lastActivityAt": max(lasts) if lasts else None,
            "activeSessions": sessions.get(did, 0),
        }
    return out


def _desk_json(desk: ReceptionDevice, extra: dict | None = None) -> dict:
    """A desk as the HR pages show it. The first ten keys are the old dialog's (unchanged); `extra` is this desk's entry
    of _extras (computed for it alone when not given). Never a password, a hash or the encrypted copy."""
    if extra is None:
        extra = _extras([desk.id]).get(desk.id) or {}
    return {
        "id": desk.id,
        "name": desk.name,
        "branchId": desk.branch_id,
        "branchName": desk.branch.name if desk.branch_id else None,
        "username": desk.username,
        "isActive": desk.is_active,
        "loginToken": desk.login_token,
        "createdBy": desk.created_by,
        "createdAt": desk.created_at.isoformat(),
        "lastLoginAt": _iso(desk.last_login_at),
        "location": desk.location,
        "notes": desk.notes,
        "updatedAt": _iso(desk.updated_at),
        "updatedBy": desk.updated_by,
        "passwordViewable": password_viewable(desk),
        "activeSessions": extra.get("activeSessions", 0),
        "lastActivityAt": _iso(extra.get("lastActivityAt")),
        "counts": {**_empty_counts(), **(extra.get("counts") or {})},
    }


def _sessions_json(desk: ReceptionDevice) -> list[dict]:
    rows = live_sessions([desk.id]).order_by("-seen", "-id")
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


def _flag(data, key: str) -> bool:
    """A true / false field of the body (JSON booleans, also "true" / "false" / 1 / 0). Raises _Invalid."""
    value = data.get(key)
    if isinstance(value, bool):
        return value
    if value in (0, 1):
        return bool(value)
    if isinstance(value, str) and value.strip().lower() in ("true", "false", "1", "0"):
        return value.strip().lower() in ("true", "1")
    raise _Invalid(f"{key} must be true or false")


def _text(data, key: str, max_length: int) -> str | None:
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
    qs = ReceptionDevice.objects.filter(username__iexact=username)
    if exclude_id is not None:
        qs = qs.exclude(pk=exclude_id)
    return qs.exists()


def _scoped_desks(request: Request):
    return scope_to_branch(ReceptionDevice.objects.select_related("branch"), request)


def _scoped_desk(request: Request, pk: int) -> ReceptionDevice | None:
    return _scoped_desks(request).filter(pk=pk).first()


def _branch_param(request: Request) -> int | None:
    """?branchId for an HR account not bound to a branch (a bound one always gets its own). Raises _Invalid."""
    raw = (request.query_params.get("branchId") or "").strip()
    if not raw:
        return None
    if not raw.isdigit():
        raise _Invalid("branchId must be a number")
    return int(raw) if get_branch_scope(request) is None else None


def _list_filters(request: Request, qs):
    """?q (name, username, location, branch), ?deskStatus=active|inactive, ?branchId (unscoped users only). Raises
    _Invalid."""
    params = request.query_params
    status = (params.get("deskStatus") or "").strip().lower()
    if status == STATUS_ACTIVE:
        qs = qs.filter(is_active=True)
    elif status == STATUS_INACTIVE:
        qs = qs.filter(is_active=False)
    elif status:
        raise _Invalid("deskStatus must be active or inactive")
    branch_id = _branch_param(request)
    if branch_id is not None:
        qs = qs.filter(branch_id=branch_id)
    for term in (params.get("q") or "").split()[:MAX_SEARCH_WORDS]:
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


def _where(desk: ReceptionDevice) -> str:
    return f"{desk.name} ({desk.branch.name})" if desk.branch_id else desk.name


# ── list + add ────────────────────────────────────────────────────────────────


@api_view(["GET", "POST"])
@require_hr
def reception_devices(request: Request) -> Response:
    if request.method == "GET":
        try:
            desks = list(_list_filters(request, _scoped_desks(request).order_by("name", "id")))
        except _Invalid as e:
            return _bad(str(e))
        extras = _extras([d.id for d in desks])
        return Response([_desk_json(d, extras.get(d.id)) for d in desks])

    data = request.data if hasattr(request.data, "get") else {}
    name = (data.get("name") or "").strip() if isinstance(data.get("name"), str) else ""
    if not name or not data.get("username") or not data.get("password"):
        return _bad("name, username and password are required")
    try:
        username = _username(data)
        password = _password(data)
        location = _text(data, "location", 200)
        notes = _text(data, "notes", 1000)
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
    desk = ReceptionDevice(
        name=name,
        branch=branch,
        username=username,
        login_token=uuid.uuid4().hex,
        created_by=who,
        location=location,
        notes=notes,
        updated_at=timezone.now(),
        updated_by=who,
    )
    set_desk_password(desk, password)
    desk.save()
    log_action(
        request,
        "create",
        "outpass_visitors",
        record_id=desk.id,
        description=f"Added reception desk {_where(desk)} with username {desk.username}",
    )
    return Response(_desk_json(desk, {}), status=201)


# ── one desk ──────────────────────────────────────────────────────────────────

# what a PUT may change, as (body key, model field) for the audit entry's old / new values (never the password)
_AUDITED = (
    ("name", "name"),
    ("branchId", "branch_id"),
    ("username", "username"),
    ("location", "location"),
    ("notes", "notes"),
    ("isActive", "is_active"),
)


def _save_fields(changed: list[str], password_changed: bool) -> list[str]:
    """The model fields a PUT writes: the _AUDITED ones it changed, the password columns when it set one, the stamp."""
    fields = [("branch" if field == "branch_id" else field) for key, field in _AUDITED if key in changed]
    if password_changed:
        fields += ["password_hash", "password_encrypted"]
    return fields + ["updated_at", "updated_by"]


def _apply_update(request: Request, desk: ReceptionDevice, data) -> tuple[bool, bool]:
    """Writes the body's changes onto `desk` (not saved). Returns (password changed, username changed). Raises _Invalid
    (400), PermissionError (403, a branch move by a branch-bound user) or LookupError (404 branch / 409 username)."""
    if "name" in data:
        name = data.get("name")
        name = name.strip() if isinstance(name, str) else ""
        if not name:
            raise _Invalid("name cannot be empty")
        desk.name = name
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
            desk.branch = branch
    username_changed = False
    if "username" in data:
        username = _username(data)
        if username != desk.username:
            if _username_taken(username, exclude_id=desk.id):
                raise LookupError("That username is already taken")
            # a change of letter case only is the same sign-in (usernames match case-insensitively): no sign-out
            username_changed = username.lower() != desk.username.lower()
            desk.username = username
    if "location" in data:
        desk.location = _text(data, "location", 200)
    if "notes" in data:
        desk.notes = _text(data, "notes", 1000)
    if "isActive" in data:
        desk.is_active = _flag(data, "isActive")
    password_changed = False
    if data.get("password"):
        set_desk_password(desk, _password(data))
        password_changed = True
    return password_changed, username_changed


@api_view(["GET", "PUT", "DELETE"])
@require_hr
def reception_device_detail(request: Request, pk: int) -> Response:
    desk = _scoped_desk(request, pk)
    if not desk:
        return _not_found()

    if request.method == "GET":
        return Response({**_desk_json(desk), "sessions": _sessions_json(desk)})

    if request.method == "DELETE":
        where, desk_id = _where(desk), desk.id
        desk.delete()
        log_action(
            request,
            "delete",
            "outpass_visitors",
            record_id=desk_id,
            description=f"Deleted reception desk {where} (its visits stay on the Visitors page)",
        )
        return Response(status=204)

    data = request.data if hasattr(request.data, "get") else {}
    before = {key: getattr(desk, field) for key, field in _AUDITED}
    was_active = desk.is_active
    try:
        password_changed, username_changed = _apply_update(request, desk, data)
    except _Invalid as e:
        return _bad(str(e))
    except PermissionError as e:
        return _bad(str(e), 403)
    except LookupError as e:
        message = str(e.args[0]) if e.args else "Not found"
        return _bad(message, 409 if "username" in message else 404)

    # updated_at also ends a sign-in lock of this desk (reception_credentials.login_locked_out)
    desk.updated_at = timezone.now()
    desk.updated_by = get_hr_display_name(request)
    after = {key: getattr(desk, field) for key, field in _AUDITED}
    changed = [key for key, _field in _AUDITED if before[key] != after[key]]
    # Only the columns this request changed (and the stamp): another HR change at the same moment (a password reset, a
    # switch-off) is never written back over by this request's older copy of the row.
    desk.save(update_fields=_save_fields(changed, password_changed))

    signed_out = 0
    if was_active and not desk.is_active:
        signed_out += revoke_desk_sessions(desk, ReceptionSession.REVOKED_DEACTIVATED)
    if password_changed:
        signed_out += revoke_desk_sessions(desk, ReceptionSession.REVOKED_PASSWORD_CHANGED)
    if username_changed:
        signed_out += revoke_desk_sessions(desk, ReceptionSession.REVOKED_USERNAME_CHANGED)

    words = [k for k in changed if k != "isActive"] + (["password"] if password_changed else [])
    if was_active != desk.is_active:
        verb = "Switched on" if desk.is_active else "Switched off"
        description = f"{verb} reception desk {_where(desk)}" + (f"; also changed {', '.join(words)}" if words else "")
    else:
        description = f"Changed reception desk {_where(desk)}: {', '.join(words) if words else 'nothing'}"
    if signed_out:
        description += f" ({signed_out} signed-in {'browser' if signed_out == 1 else 'browsers'} signed out)"
    log_action(
        request,
        "update",
        "outpass_visitors",
        record_id=desk.id,
        description=description[:480],
        old_values={k: before[k] for k in changed} or None,
        new_values=({k: after[k] for k in changed} | ({"password": "changed"} if password_changed else {})) or None,
    )
    return Response(_desk_json(desk))


@api_view(["POST"])
@require_hr
def reception_device_reveal_password(request: Request, pk: int) -> Response:
    """The desk's password, for HR with edit on "See desk passwords" (the middleware enforces the key). Every shown
    password is an audit entry "view_password"; the password itself is never logged. A desk set before passwords were
    kept answers 409 not_stored."""
    desk = _scoped_desk(request, pk)
    if not desk:
        return _not_found()
    password = reveal_desk_password(desk)
    if password is None:
        return Response(NOT_STORED, status=409)
    log_action(
        request,
        "view_password",
        "outpass_visitors",
        record_id=desk.id,
        description=f"Viewed the login password of reception desk {_where(desk)}",
    )
    response = Response({"password": password})
    response["Cache-Control"] = "no-store"
    return response


@api_view(["POST"])
@require_hr
def reception_device_sign_out(request: Request, pk: int) -> Response:
    """Ends every session of the desk (each browser showing it goes back to the desk sign-in page)."""
    desk = _scoped_desk(request, pk)
    if not desk:
        return _not_found()
    count = revoke_desk_sessions(desk, ReceptionSession.REVOKED_HR_SIGNED_OUT)
    log_action(
        request,
        "update",
        "outpass_visitors",
        record_id=desk.id,
        description=f"Signed out every browser of reception desk {_where(desk)} ({count} signed out)",
    )
    return Response({"signedOut": count})


# ── records: what the desks did ───────────────────────────────────────────────


def _day(value, name: str) -> date | None:
    value = (value or "").strip() if isinstance(value, str) else ""
    if not value:
        return None
    try:
        return date.fromisoformat(value)
    except ValueError:
        raise _Invalid(f"{name} must be a date like 2026-11-18") from None


def _ids(value) -> list[int] | None:
    raw = (value or "").strip() if isinstance(value, str) else ""
    if not raw:
        return None
    parts = [p.strip() for p in raw.split(",") if p.strip()]
    if not parts or not all(p.isdigit() for p in parts):
        raise _Invalid("deskId must be a number or a list of numbers")
    return [int(p) for p in parts]


def _int(value, default: int, low: int, high: int) -> int:
    try:
        n = int(value)
    except (TypeError, ValueError):
        return default
    return max(low, min(n, high))


def records_params(request: Request) -> dict:
    """The record filters of the query string: deskId (one or "1,2"), from / to (India days, inclusive), type
    (check_in | check_out), q (up to four words, each in the visitor, the company, the host, the purpose...), branchId
    (unscoped users only), page, pageSize (at most 100). Raises _Invalid."""
    qp = request.query_params
    d_from, d_to = _day(qp.get("from"), "from"), _day(qp.get("to"), "to")
    if d_from and d_to and d_from > d_to:
        raise _Invalid("The start date must be on or before the end date")
    kind = (qp.get("type") or "").strip() or None
    if kind is not None and kind not in TYPE_LABELS:
        raise _Invalid("type must be check_in or check_out")
    return {
        "desk_ids": _ids(qp.get("deskId")),
        "date_from": d_from,
        "date_to": d_to,
        "type": kind,
        "q": " ".join((qp.get("q") or "").split()[:MAX_SEARCH_WORDS]),
        "branch_id": _branch_param(request),
        "page": _int(qp.get("page"), 1, 1, 10**6),
        "page_size": _int(qp.get("pageSize"), DEFAULT_PAGE_SIZE, 1, MAX_PAGE_SIZE),
    }


def _bounds(p: dict) -> tuple[datetime | None, datetime | None]:
    start = datetime.combine(p["date_from"], time.min, tzinfo=FACTORY_TZ) if p["date_from"] else None
    end = datetime.combine(p["date_to"] + timedelta(days=1), time.min, tzinfo=FACTORY_TZ) if p["date_to"] else None
    return start, end


def _event_sets(request: Request, p: dict) -> dict:
    """{CHECK_IN: visits a desk checked in, CHECK_OUT: visits a desk checked out}, each limited to the desks this
    account may see (their branch; a deskId of another branch matches nothing), the desks asked for, the dates (on the
    check-in time / the check-out time) and the search words. Every type, whatever ?type says (the counts need both)."""
    desks = _scoped_desks(request)
    if p["branch_id"] is not None:
        desks = desks.filter(branch_id=p["branch_id"])
    if p["desk_ids"] is not None:
        desks = desks.filter(pk__in=p["desk_ids"])
    desk_ids = desks.values("id")
    start, end = _bounds(p)
    words = Q()
    for term in p["q"].split():
        words &= _search_q(term)
    out = {}
    for kind, desk_field, at_field in (
        (CHECK_IN, "checked_in_desk", "visited_at"),
        (CHECK_OUT, "checked_out_desk", "checked_out_at"),
    ):
        qs = VisitorVisit.objects.filter(**{f"{desk_field}_id__in": desk_ids}).filter(words)
        if start is not None:
            qs = qs.filter(**{f"{at_field}__gte": start})
        if end is not None:
            qs = qs.filter(**{f"{at_field}__lt": end})
        out[kind] = qs
    return out


def _event_rows(sets: dict, kinds) -> object:
    """One row per event (visit id, when, type, desk id) of the chosen kinds, as one SQL query (a UNION), newest
    first."""
    parts = []
    for kind in kinds:
        desk_field, at_field = (
            ("checked_in_desk_id", "visited_at") if kind == CHECK_IN else ("checked_out_desk_id", "checked_out_at")
        )
        parts.append(
            sets[kind]
            .order_by()
            .annotate(at=F(at_field), kind=Value(kind, output_field=TextField()), desk_ref=F(desk_field))
            .values("id", "at", "kind", "desk_ref")
        )
    combined = parts[0] if len(parts) == 1 else parts[0].union(*parts[1:], all=True)
    return combined.order_by("-at", "-id")


def _counts(sets: dict) -> dict:
    ins, outs = sets[CHECK_IN].count(), sets[CHECK_OUT].count()
    return {"checkIns": ins, "checkOuts": outs, "total": ins + outs}


def _host(v: VisitorVisit) -> str | None:
    emp = v.meeting_employee
    if emp is not None:
        return f"{emp.first_name or ''} {emp.last_name or ''}".strip() or v.whom_to_meet
    return v.whom_to_meet or None


def _materialise(events: list[dict]) -> tuple[dict, dict]:
    """The visits and the desk names of a page of events, in two queries."""
    visits = {v.id: v for v in visit_rows(VisitorVisit.objects.filter(pk__in={e["id"] for e in events})).order_by()}
    desk_names = dict(
        ReceptionDevice.objects.filter(pk__in={e["desk_ref"] for e in events if e["desk_ref"]}).values_list(
            "id", "name"
        )
    )
    return visits, desk_names


def _record_json(e: dict, v: VisitorVisit | None, desk_names: dict, now, today_start) -> dict:
    status = visit_status(v, today_start) if v is not None else None
    desk_id = e["desk_ref"]
    return {
        "id": f"{'in' if e['kind'] == CHECK_IN else 'out'}-{e['id']}",
        "at": _iso(e["at"]),
        "type": e["kind"],
        "typeLabel": TYPE_LABELS[e["kind"]],
        "desk": {"id": desk_id, "name": desk_names.get(desk_id, REMOVED_DESK)} if desk_id else None,
        "visit": None
        if v is None
        else {
            "id": v.id,
            "visitorName": v.visitor.name,
            "company": v.company,
            "peopleCount": v.people_count,
            "host": _host(v),
            "hostDepartment": v.meeting_employee.department.name
            if v.meeting_employee_id and v.meeting_employee.department_id
            else None,
            "purpose": v.purpose,
            "badgeNumber": v.badge_number,
            "status": status,
            "statusLabel": VISIT_STATUS_LABELS[status],
            "visitedAt": _iso(v.visited_at),
            "checkedOutAt": _iso(v.checked_out_at),
            "minutesInside": _minutes_inside(v, status, now),
            "branchName": v.branch.name if v.branch_id else None,
        },
    }


@api_view(["GET"])
@require_hr
def reception_devices_records(request: Request) -> Response:
    """One page of what the desks in scope did: {items, total, page, pageSize, counts: {checkIns, checkOuts, total}}.
    Each item: {id ("in-<visit>" | "out-<visit>"), at, type, typeLabel, desk {id, name}, visit {id, visitorName, company,
    peopleCount, host, hostDepartment, purpose, badgeNumber, status, statusLabel, visitedAt, checkedOutAt, minutesInside,
    branchName}}. counts cover both types (the other filters apply); total is the filtered count."""
    try:
        p = records_params(request)
    except _Invalid as e:
        return _bad(str(e))
    sets = _event_sets(request, p)
    kinds = [p["type"]] if p["type"] else [CHECK_IN, CHECK_OUT]
    counts = _counts(sets)
    total = sum(counts["checkIns" if k == CHECK_IN else "checkOuts"] for k in kinds)
    offset = (p["page"] - 1) * p["page_size"]
    events = list(_event_rows(sets, kinds)[offset : offset + p["page_size"]])
    visits, desk_names = _materialise(events)
    now = _now()
    today_start = _day_start(now)
    return Response(
        {
            "items": [_record_json(e, visits.get(e["id"]), desk_names, now, today_start) for e in events],
            "total": total,
            "page": p["page"],
            "pageSize": p["page_size"],
            "counts": counts,
        }
    )


def _fmt_day(d: date) -> str:
    return d.strftime("%d %b %Y").lstrip("0")


def _records_filters_text(request: Request, p: dict, desk_names: list[str]) -> list[tuple[str, str]]:
    pairs: list[tuple[str, str]] = []
    if p["date_from"] and p["date_to"]:
        same = p["date_from"] == p["date_to"]
        pairs.append(
            ("Dates", _fmt_day(p["date_from"]) if same else f"{_fmt_day(p['date_from'])} to {_fmt_day(p['date_to'])}")
        )
    elif p["date_from"]:
        pairs.append(("Dates", f"From {_fmt_day(p['date_from'])}"))
    elif p["date_to"]:
        pairs.append(("Dates", f"Up to {_fmt_day(p['date_to'])}"))
    else:
        pairs.append(("Dates", "All dates"))
    if desk_names:
        pairs.append(("Desk", ", ".join(desk_names)))
    if p["type"]:
        pairs.append(("Type", TYPE_LABELS[p["type"]]))
    branch = _branch_name(request, p["branch_id"])
    if branch:
        pairs.append(("Branch", branch))
    if p["q"]:
        pairs.append(("Search", p["q"]))
    return pairs


@api_view(["GET"])
@require_hr
def reception_devices_records_export(request: Request) -> Response:
    """The records the list shows (same filters, every page) as ?fmt=xlsx|pdf: "Reception records" (with the desk's
    name in the title when one desk is chosen), the filters line and the counts. No phone and no Aadhaar number."""
    try:
        p = records_params(request)
    except _Invalid as e:
        return _bad(str(e))
    sets = _event_sets(request, p)
    kinds = [p["type"]] if p["type"] else [CHECK_IN, CHECK_OUT]
    counts = _counts(sets)
    events = list(_event_rows(sets, kinds)[:EXPORT_FETCH_LIMIT])
    visits, desk_names = _materialise(events)
    now = _now()
    today_start = _day_start(now)
    rows = []
    for e in events:
        rec = _record_json(e, visits.get(e["id"]), desk_names, now, today_start)
        v = rec["visit"] or {}
        rows.append(
            {
                "at": e["at"],
                "type": rec["typeLabel"],
                "desk": rec["desk"]["name"] if rec["desk"] else REMOVED_DESK,
                "visitor": v.get("visitorName"),
                "company": v.get("company"),
                "people": v.get("peopleCount"),
                "host": v.get("host"),
                "purpose": v.get("purpose"),
                "status": v.get("statusLabel"),
                "visitedAt": visits[e["id"]].visited_at if e["id"] in visits else None,
                "checkedOutAt": visits[e["id"]].checked_out_at if e["id"] in visits else None,
                "minutes": v.get("minutesInside"),
                "branch": v.get("branchName"),
            }
        )
    ids = p["desk_ids"] or ()
    names_by_id = dict(_scoped_desks(request).filter(pk__in=ids).values_list("id", "name")) if ids else {}
    names = [names_by_id[i] for i in ids if i in names_by_id]
    one = names[0] if len(ids) == 1 and names else None
    title = f"Reception records - {one}" if one else "Reception records"
    return file_response(
        request,
        slug=f"reception_records_{one}" if one else "reception_records",
        title=title,
        columns=RECORD_EXPORT_COLUMNS,
        rows=rows,
        fmt=request.query_params.get("fmt"),
        filters_text=_records_filters_text(request, p, names),
        summary=[
            {"label": "Records", "value": counts["checkIns"] if p["type"] == CHECK_IN else counts["checkOuts"]}
            if p["type"]
            else {"label": "Records", "value": counts["total"]},
            {"label": "Check-ins", "value": counts["checkIns"]},
            {"label": "Check-outs", "value": counts["checkOuts"]},
        ],
        notes=[
            "Records of each desk login from 18 Nov 2026: the visitors it checked in and the visitors it checked out."
        ],
    )


# ── the page's tiles ──────────────────────────────────────────────────────────


@api_view(["GET"])
@require_hr
def reception_devices_overview(request: Request) -> Response:
    """{desks, active, signedInNow, checkInsToday, checkOutsToday, checkIns, checkOuts}: desks in scope, switched on, with
    a session seen in the last 10 minutes; today's check-ins and check-outs at the desks; and the same two for ?from /
    ?to (no dates = all time). ?branchId narrows an unscoped user."""
    try:
        branch_id = _branch_param(request)
        d_from, d_to = _day(request.query_params.get("from"), "from"), _day(request.query_params.get("to"), "to")
    except _Invalid as e:
        return _bad(str(e))
    desks = _scoped_desks(request)
    if branch_id is not None:
        desks = desks.filter(branch_id=branch_id)
    row = desks.aggregate(n=Count("id"), on=Count("id", filter=Q(is_active=True)))
    ids = list(desks.values_list("id", flat=True))
    signed_in = open_sessions(ids).filter(last_seen_at__gte=timezone.now() - SIGNED_IN_WITHIN).count() if ids else 0
    today_start = _day_start(_now())
    base = {"page": 1, "page_size": 1, "desk_ids": None, "type": None, "q": "", "branch_id": branch_id}
    today = _event_sets(request, {**base, "date_from": None, "date_to": None})
    ranged = _counts(_event_sets(request, {**base, "date_from": d_from, "date_to": d_to}))
    return Response(
        {
            "desks": row["n"],
            "active": row["on"],
            "signedInNow": signed_in,
            "checkInsToday": today[CHECK_IN].filter(visited_at__gte=today_start).count(),
            "checkOutsToday": today[CHECK_OUT].filter(checked_out_at__gte=today_start).count(),
            "checkIns": ranged["checkIns"],
            "checkOuts": ranged["checkOuts"],
        }
    )


# ── the desk list file ────────────────────────────────────────────────────────


@api_view(["GET"])
@require_hr
def reception_devices_export(request: Request) -> Response:
    """The desks in scope (?q, ?deskStatus, ?branchId as the list) as ?fmt=xlsx|pdf: name, branch, location, username,
    status, its counts, sessions and dates. Never a password, a hash or the login link."""
    try:
        desks = list(_list_filters(request, _scoped_desks(request).order_by("name", "id")))
    except _Invalid as e:
        return _bad(str(e))
    extras = _extras([d.id for d in desks])
    rows = []
    for d in desks:
        extra = extras.get(d.id) or {}
        counts = {**_empty_counts(), **(extra.get("counts") or {})}
        rows.append(
            {
                "name": d.name,
                "branch": d.branch.name if d.branch_id else None,
                "location": d.location,
                "username": d.username,
                "status": "Switched on" if d.is_active else "Switched off",
                "today": counts["today"],
                "checkIns": counts["checkIns"],
                "checkOuts": counts["checkOuts"],
                "total": counts["total"],
                "sessions": extra.get("activeSessions", 0),
                "lastActivity": extra.get("lastActivityAt"),
                "lastLogin": d.last_login_at,
                "createdBy": d.created_by,
                "createdAt": d.created_at,
                "updatedBy": d.updated_by,
                "updatedAt": d.updated_at,
                "notes": d.notes,
            }
        )
    params = request.query_params
    filters: list[tuple[str, str]] = []
    try:
        branch_name = _branch_name(request, _branch_param(request))
    except _Invalid:
        branch_name = None
    if branch_name:
        filters.append(("Branch", branch_name))
    status = (params.get("deskStatus") or "").strip().lower()
    if status:
        filters.append(("Status", "Switched on" if status == STATUS_ACTIVE else "Switched off"))
    if (params.get("q") or "").strip():
        filters.append(("Search", params.get("q").strip()))
    on = sum(1 for d in desks if d.is_active)
    return file_response(
        request,
        slug="reception_desks",
        title="Reception desks",
        columns=LIST_EXPORT_COLUMNS,
        rows=rows,
        fmt=params.get("fmt"),
        filters_text=filters,
        summary=[
            {"label": "Desks", "value": len(desks)},
            {"label": "Switched on", "value": on},
            {"label": "Switched off", "value": len(desks) - on},
            {"label": "Records today", "value": sum(r["today"] for r in rows)},
        ],
        notes=["Passwords and sign-in links are never part of this file."],
    )

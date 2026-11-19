"""
Reception desk credentials and sessions: the reception twin of gate_credentials.py (one shared sign-in at /reception-login
for every desk; the username decides the desk).

* Passwords. ``password_hash`` (bcrypt) stays the only login check; ``password_encrypted`` keeps the same password
  Fernet-encrypted so HR can be shown it (Visitors -> Manage Reception -> View, POST reception-devices/<id>/reveal-password).
  The hashing and the Fernet key are gate_credentials' (hash_password / encrypt_password / decrypt_password /
  password_matches): one scheme for every device login, nothing copied.
* Sessions. A desk token is a 30-day JWT ``{"role": "reception_device", "deviceId", "deskName", "rsid"}`` whose ``rsid``
  is the ``sid`` of one ReceptionSession row, so one browser can be signed out (logout) or all of a desk's (password
  reset, username change, switching it off, HR "Sign out everywhere"). The claim is deliberately neither ``jti``
  (auth._authenticate reads any jti as an HR LoginSession) nor ``gsid`` (a gate's). auth.require_reception_device
  enforces it; a token without rsid (the 24 h kind issued before 18 Nov 2026) is refused since 19 Nov 2026.
* Sign-in attempts. Every attempt is a ReceptionLoginAttempt row (apart from the gates': a username is unique per table);
  5 wrong tries for one username within 15 minutes lock it until the window passes, or until HR changes the desk (every
  PUT reception-devices/<id> stamps updated_at, and only the tries after that count). Counted, timed and pruned exactly
  like a gate's (gate_credentials.check_device_login).

Nothing here prints or logs a password or a token.
"""

from __future__ import annotations

import uuid

from django.utils import timezone

from .audit_utils import _get_ip
from .gate_credentials import (
    LOCKOUT_THRESHOLD,
    LOCKOUT_WINDOW,
    LOGIN_LOCKED,
    LOGIN_OK,
    LOGIN_SWITCHED_OFF,
    LOGIN_WRONG,
    MIN_PASSWORD_LENGTH,
    REFRESH_BELOW,
    SIGNED_IN_WITHIN,
    TOKEN_LIFETIME,
    TOUCH_EVERY,
    check_device_login,
    decrypt_password,
    encrypt_password,
    hash_password,
    normalize_username,
    password_matches,
    token_expires_soon,
)
from .jwt_utils import sign_token
from .models import ReceptionDevice, ReceptionLoginAttempt, ReceptionSession
from .session_utils import parse_user_agent

__all__ = [
    "LOCKOUT_THRESHOLD",
    "LOCKOUT_WINDOW",
    "LOGIN_ERRORS",
    "LOGIN_LOCKED",
    "LOGIN_OK",
    "LOGIN_SWITCHED_OFF",
    "LOGIN_WRONG",
    "MIN_PASSWORD_LENGTH",
    "REFRESH_BELOW",
    "SIGNED_IN_WITHIN",
    "TOKEN_LIFETIME",
    "check_desk_login",
    "check_desk_password",
    "desk_token",
    "end_desk_session",
    "login_locked_out",
    "new_desk_session",
    "normalize_username",
    "open_sessions",
    "password_viewable",
    "record_login_attempt",
    "reveal_desk_password",
    "revoke_desk_sessions",
    "session_for_token",
    "set_desk_password",
    "start_desk_session",
    "token_expires_soon",
    "touch_session",
]

# check_desk_login outcomes (the gate ones), with the status and the words the desk sign-in shows for each
LOGIN_ERRORS: dict[str, tuple[int, str]] = {
    LOGIN_WRONG: (401, "Wrong username or password."),
    LOGIN_SWITCHED_OFF: (403, "This desk is switched off. Ask HR to switch it on."),
    LOGIN_LOCKED: (429, "Too many wrong tries. Wait 15 minutes or ask HR to reset the password."),
}


# ── passwords ────────────────────────────────────────────────────────────────


def set_desk_password(desk: ReceptionDevice, raw: str, *, save: bool = False) -> None:
    """Set `raw` as the desk's password: the bcrypt hash (the login check) and the encrypted copy (for View).

    Does NOT save unless `save=True` (then only those two columns) and never revokes sessions: a caller that changes an
    existing password calls revoke_desk_sessions(desk, ReceptionSession.REVOKED_PASSWORD_CHANGED) itself."""
    desk.password_hash = hash_password(raw)
    desk.password_encrypted = encrypt_password(raw)
    if save:
        desk.save(update_fields=["password_hash", "password_encrypted"])


def reveal_desk_password(desk: ReceptionDevice) -> str | None:
    """The desk's current password, or None when it cannot be shown (set before 18 Nov 2026, or the secret changed).
    The caller logs the view (log_action "view_password") and never logs the value."""
    return decrypt_password(desk.password_encrypted)


def password_viewable(desk: ReceptionDevice) -> bool:
    """Whether the desk has a stored copy to show (cheap: no decryption). For list payloads (`passwordViewable`)."""
    return bool(desk.password_encrypted)


def check_desk_password(desk: ReceptionDevice, raw: str) -> bool:
    return password_matches(desk.password_hash, raw)


# ── sessions ─────────────────────────────────────────────────────────────────


def new_desk_session(desk: ReceptionDevice, request) -> ReceptionSession:
    """A new open session for this desk, labelled from the request's browser and address."""
    user_agent = (request.META.get("HTTP_USER_AGENT") or "")[:500]
    return ReceptionSession.objects.create(
        desk=desk,
        sid=uuid.uuid4().hex,
        device_label=parse_user_agent(user_agent),
        user_agent=user_agent,
        ip_address=_get_ip(request),
        last_seen_at=timezone.now(),
    )


def desk_token(desk: ReceptionDevice, session: ReceptionSession) -> str:
    """The 30-day desk JWT for this session (the secret value: never print it)."""
    payload = {"role": "reception_device", "deviceId": desk.id, "deskName": desk.name, "rsid": session.sid}
    return sign_token(payload, expires_in=TOKEN_LIFETIME)


def session_for_token(payload: dict, desk: ReceptionDevice) -> ReceptionSession | None:
    """The open session a token's `rsid` names, when it belongs to `desk`; None when it is missing, revoked or another
    desk's (the caller then refuses the request). A token without rsid is not checked here (legacy, see the module)."""
    sid = payload.get("rsid")
    if not sid or not isinstance(sid, str):
        return None
    return ReceptionSession.objects.filter(sid=sid, desk=desk, revoked_at__isnull=True).first()


def touch_session(session: ReceptionSession) -> None:
    """Stamp last_seen_at, at most once a minute (an UPDATE of that one column)."""
    now = timezone.now()
    if session.last_seen_at is None or now - session.last_seen_at >= TOUCH_EVERY:
        ReceptionSession.objects.filter(pk=session.pk).update(last_seen_at=now)
        session.last_seen_at = now


def end_desk_session(session: ReceptionSession, reason: str = ReceptionSession.REVOKED_LOGOUT) -> bool:
    """Revoke one session (the desk's Sign out). False when it was already ended."""
    now = timezone.now()
    changed = ReceptionSession.objects.filter(pk=session.pk, revoked_at__isnull=True).update(
        revoked_at=now, revoked_reason=reason
    )
    if changed:
        session.revoked_at, session.revoked_reason = now, reason
    return bool(changed)


def revoke_desk_sessions(desk: ReceptionDevice, reason: str) -> int:
    """Revoke every open session of the desk; returns how many were open. `reason` is a ReceptionSession.REVOKED_*."""
    return ReceptionSession.objects.filter(desk=desk, revoked_at__isnull=True).update(
        revoked_at=timezone.now(), revoked_reason=reason
    )


def open_sessions(desk_ids=None):
    """Open (not revoked) sessions, of these desks when given. `.filter(last_seen_at__gte=now - SIGNED_IN_WITHIN)` of it
    is "signed in now"."""
    qs = ReceptionSession.objects.filter(revoked_at__isnull=True)
    if desk_ids is not None:
        qs = qs.filter(desk_id__in=list(desk_ids))
    return qs


# ── sign-in attempts ─────────────────────────────────────────────────────────


def _desk_by_username(name: str) -> ReceptionDevice | None:
    return ReceptionDevice.objects.select_related("branch").filter(username__iexact=name).first() if name else None


def login_locked_out(username, desk: ReceptionDevice | None = None) -> bool:
    """True when the last LOCKOUT_THRESHOLD attempts for this username within LOCKOUT_WINDOW were all wrong. A correct
    sign-in in between ends the lock, and so does any HR change to the desk after the tries (its updated_at, stamped by
    every PUT reception-devices/<id>, e.g. a password reset). `desk`: the desk of that username when the caller has it."""
    name = normalize_username(username)
    if not name:
        return False
    since = timezone.now() - LOCKOUT_WINDOW
    desk = desk if desk is not None else _desk_by_username(name)
    if desk is not None and desk.updated_at and desk.updated_at > since:
        since = desk.updated_at
    recent = list(
        ReceptionLoginAttempt.objects.filter(username=name, created_at__gte=since)
        .order_by("-created_at", "-id")
        .values_list("success", flat=True)[:LOCKOUT_THRESHOLD]
    )
    return len(recent) >= LOCKOUT_THRESHOLD and not any(recent)


def record_login_attempt(username, ip: str | None, success: bool) -> None:
    """One ReceptionLoginAttempt row (the username normalised; nothing about the password)."""
    ReceptionLoginAttempt.objects.create(username=normalize_username(username), ip_address=ip, success=bool(success))


def check_desk_login(request, username, password) -> tuple[ReceptionDevice | None, str]:
    """The whole desk sign-in decision (POST reception-devices/login).

    Returns (desk, LOGIN_OK) or (None | desk, one of LOGIN_WRONG / LOGIN_SWITCHED_OFF / LOGIN_LOCKED); LOGIN_ERRORS has
    the status and words for each. Records the attempt (not while locked, and not for an empty username) the way a
    gate's is (gate_credentials.check_device_login). Starts no session: call start_desk_session."""
    return check_device_login(
        request,
        username,
        password,
        find=_desk_by_username,
        attempts=ReceptionLoginAttempt,
        locked_out=login_locked_out,
        password_ok=check_desk_password,
    )


def start_desk_session(desk: ReceptionDevice, request) -> tuple[ReceptionSession, str]:
    """After LOGIN_OK: open a session, stamp last_login_at, and return (session, token)."""
    session = new_desk_session(desk, request)
    desk.last_login_at = timezone.now()
    desk.save(update_fields=["last_login_at"])
    return session, desk_token(desk, session)

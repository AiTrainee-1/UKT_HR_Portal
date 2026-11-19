"""
Gate monitor credentials and sessions: one place for everything secret about a gate login.

* Passwords. ``password_hash`` (bcrypt, rounds 10) stays the only login check. Beside it ``password_encrypted`` keeps the
  same password Fernet-encrypted so HR can be shown it (Manage Gates -> View, POST gate-devices/<id>/reveal-password).
  The key is derived from settings.JWT_SECRET, so rotating that secret makes every stored copy unreadable: reveal then
  says "not available, set a new password", and signing in still works (bcrypt).
* Sessions. A gate token is a 30-day JWT ``{"role": "gate_device", "deviceId", "gateName", "gsid"}`` whose ``gsid`` is
  the ``sid`` of one GateSession row, so one browser can be signed out (logout) or all of a gate's (password reset,
  username change, switching the gate off, HR "Sign out everywhere"). The claim is deliberately NOT ``jti``:
  auth._authenticate reads any jti as an HR LoginSession. auth.require_gate_device enforces it; a token without a gsid
  (the 24 h kind issued before 18 Nov 2026) is refused since 19 Nov 2026, as it could not be signed out.
* Sign-in attempts. Every attempt is a GateLoginAttempt row; 5 wrong tries for one username within 15 minutes lock that
  username until the window passes, or until HR changes the gate (a password reset stamps GateDevice.updated_at, and only
  the tries after that count), which is what "ask HR to reset the password" in the message relies on. A try for a known
  gate counts under the gate's own username (however it was typed); it is written as a failure BEFORE the password is
  checked (and marked a success after), so tries sent all at once each see the others; a username no gate has still
  costs one bcrypt check (a fixed hash), so the time taken does not tell which usernames exist. Rows older than 30 days
  are removed on each successful sign-in.

Nothing here prints or logs a password or a token.
"""

from __future__ import annotations

import base64
import hashlib
import uuid
from datetime import datetime, timedelta
from datetime import timezone as dt_timezone

import bcrypt
from cryptography.fernet import Fernet, InvalidToken
from django.conf import settings
from django.utils import timezone

from .audit_utils import _get_ip
from .jwt_utils import sign_token
from .models import GateDevice, GateLoginAttempt, GateSession
from .session_utils import parse_user_agent

TOKEN_LIFETIME = timedelta(days=30)
# GET /api/gate-monitor/me hands out a fresh token when the current one has less than this left, so a gate in daily use
# is never signed out by expiry.
REFRESH_BELOW = timedelta(days=15)
# last_seen_at is written at most this often per session (every gate request passes require_gate_device)
TOUCH_EVERY = timedelta(seconds=60)
# "signed in now" on Manage Gates: an open session seen this recently
SIGNED_IN_WITHIN = timedelta(minutes=10)

LOCKOUT_THRESHOLD = 5
LOCKOUT_WINDOW = timedelta(minutes=15)
# sign-in attempt rows older than this are removed (on each successful sign-in)
ATTEMPT_RETENTION = timedelta(days=30)

MIN_PASSWORD_LENGTH = 6
BCRYPT_ROUNDS = 10

# check_gate_login outcomes, with the status and the words the gate monitor shows for each
LOGIN_OK = "ok"
LOGIN_WRONG = "wrong"
LOGIN_SWITCHED_OFF = "switched_off"
LOGIN_LOCKED = "locked"
LOGIN_ERRORS: dict[str, tuple[int, str]] = {
    LOGIN_WRONG: (401, "Wrong username or password."),
    LOGIN_SWITCHED_OFF: (403, "This gate is switched off. Ask HR to switch it on."),
    LOGIN_LOCKED: (429, "Too many wrong tries. Wait 15 minutes or ask HR to reset the password."),
}

_FERNET_SALT = "uktex-gate-password:"
# A bcrypt hash (rounds BCRYPT_ROUNDS) of a random text nobody knows. Checked when no device has the username typed, so
# a wrong username takes as long as a wrong password and the time of an answer tells nothing about which usernames exist.
_DUMMY_HASH = b"$2b$10$FXnhJdX3cl/xr9KsAI0L/.ooMimOb6UZJhyfOQ8WVPdDMpqESRLn6"


# ── passwords ────────────────────────────────────────────────────────────────


def _fernet() -> Fernet:
    digest = hashlib.sha256((_FERNET_SALT + settings.JWT_SECRET).encode()).digest()
    return Fernet(base64.urlsafe_b64encode(digest))


def set_gate_password(gate: GateDevice, raw: str, *, save: bool = False) -> None:
    """Set `raw` as the gate's password: the bcrypt hash (the login check) and the encrypted copy (for View).

    Does NOT save unless `save=True` (then only those two columns), so a view that also changes other fields saves once.
    Does not revoke sessions: callers that change an existing password call revoke_gate_sessions(gate,
    GateSession.REVOKED_PASSWORD_CHANGED) themselves. Length rules are the caller's (MIN_PASSWORD_LENGTH)."""
    gate.password_hash = bcrypt.hashpw(raw.encode(), bcrypt.gensalt(rounds=BCRYPT_ROUNDS)).decode()
    gate.password_encrypted = _fernet().encrypt(raw.encode()).decode()
    if save:
        gate.save(update_fields=["password_hash", "password_encrypted"])


def reveal_gate_password(gate: GateDevice) -> str | None:
    """The gate's current password, or None when it cannot be shown (set before 18 Nov 2026, or the secret changed).
    The caller logs the view (log_action "view_password") and never logs the value."""
    if not gate.password_encrypted:
        return None
    try:
        return _fernet().decrypt(gate.password_encrypted.encode()).decode()
    except (InvalidToken, ValueError, TypeError):
        return None


def password_viewable(gate: GateDevice) -> bool:
    """Whether the gate has a stored copy to show (cheap: no decryption). For list payloads (`passwordViewable`)."""
    return bool(gate.password_encrypted)


def check_gate_password(gate: GateDevice, raw: str) -> bool:
    """bcrypt check that is False (not an exception) for an empty password or an unusable stored hash."""
    if not raw or not gate.password_hash:
        return False
    try:
        return bcrypt.checkpw(raw.encode(), gate.password_hash.encode())
    except ValueError:
        return False


# The same password scheme for any device login with `password_hash` + `password_encrypted` columns (reception desks,
# reception_credentials.py): one place for the bcrypt rounds and the Fernet key, nothing copied.


def hash_password(raw: str) -> str:
    """The bcrypt hash (rounds BCRYPT_ROUNDS) a device login checks a password against."""
    return bcrypt.hashpw(raw.encode(), bcrypt.gensalt(rounds=BCRYPT_ROUNDS)).decode()


def encrypt_password(raw: str) -> str:
    """The Fernet copy of a password that HR's View can decrypt (key derived from settings.JWT_SECRET)."""
    return _fernet().encrypt(raw.encode()).decode()


def decrypt_password(ciphertext: str | None) -> str | None:
    """The password of a Fernet copy, or None when there is none or it cannot be read (the secret changed)."""
    if not ciphertext:
        return None
    try:
        return _fernet().decrypt(ciphertext.encode()).decode()
    except (InvalidToken, ValueError, TypeError):
        return None


def password_matches(stored_hash: str | None, raw: str) -> bool:
    """bcrypt check that is False (not an exception) for an empty password or an unusable stored hash."""
    if not raw or not stored_hash:
        return False
    try:
        return bcrypt.checkpw(raw.encode(), stored_hash.encode())
    except ValueError:
        return False


# ── sessions ─────────────────────────────────────────────────────────────────


def new_gate_session(gate: GateDevice, request) -> GateSession:
    """A new open session for this gate, labelled from the request's browser and address."""
    user_agent = (request.META.get("HTTP_USER_AGENT") or "")[:500]
    return GateSession.objects.create(
        gate=gate,
        sid=uuid.uuid4().hex,
        device_label=parse_user_agent(user_agent),
        user_agent=user_agent,
        ip_address=_get_ip(request),
        last_seen_at=timezone.now(),
    )


def gate_token(gate: GateDevice, session: GateSession) -> str:
    """The 30-day gate JWT for this session (the secret value: never print it)."""
    payload = {"role": "gate_device", "deviceId": gate.id, "gateName": gate.name, "gsid": session.sid}
    return sign_token(payload, expires_in=TOKEN_LIFETIME)


def session_for_token(payload: dict, gate: GateDevice) -> GateSession | None:
    """The open session a token's `gsid` names, when it belongs to `gate`; None when it is missing, revoked or another
    gate's (the caller then refuses the request). A token without gsid is not checked here (legacy, see the module)."""
    sid = payload.get("gsid")
    if not sid or not isinstance(sid, str):
        return None
    return GateSession.objects.filter(sid=sid, gate=gate, revoked_at__isnull=True).first()


def touch_session(session: GateSession) -> None:
    """Stamp last_seen_at, at most once a minute (an UPDATE of that one column)."""
    now = timezone.now()
    if session.last_seen_at is None or now - session.last_seen_at >= TOUCH_EVERY:
        GateSession.objects.filter(pk=session.pk).update(last_seen_at=now)
        session.last_seen_at = now


def end_gate_session(session: GateSession, reason: str = GateSession.REVOKED_LOGOUT) -> bool:
    """Revoke one session (the gate monitor's Sign out). False when it was already ended."""
    now = timezone.now()
    changed = GateSession.objects.filter(pk=session.pk, revoked_at__isnull=True).update(
        revoked_at=now, revoked_reason=reason
    )
    if changed:
        session.revoked_at, session.revoked_reason = now, reason
    return bool(changed)


def revoke_gate_sessions(gate: GateDevice, reason: str) -> int:
    """Revoke every open session of the gate; returns how many were open. `reason` is one of GateSession.REVOKED_*."""
    return GateSession.objects.filter(gate=gate, revoked_at__isnull=True).update(
        revoked_at=timezone.now(), revoked_reason=reason
    )


def open_sessions(gate_ids=None):
    """Open (not revoked) sessions, of these gates when given. `.filter(last_seen_at__gte=now - SIGNED_IN_WITHIN)` of
    it is "signed in now"."""
    qs = GateSession.objects.filter(revoked_at__isnull=True)
    if gate_ids is not None:
        qs = qs.filter(gate_id__in=list(gate_ids))
    return qs


def token_expires_soon(payload: dict, now: datetime | None = None) -> bool:
    """True when the token's exp is less than REFRESH_BELOW away (or missing): GET gate-monitor/me then returns a fresh
    token for the same session."""
    exp = payload.get("exp")
    if not isinstance(exp, (int, float)):
        return True
    now = now or timezone.now()
    return datetime.fromtimestamp(exp, tz=dt_timezone.utc) - now < REFRESH_BELOW


# ── sign-in attempts ─────────────────────────────────────────────────────────


def normalize_username(username) -> str:
    """How a username is compared and stored in GateLoginAttempt: trimmed, lower case, at most 200 characters."""
    if not isinstance(username, str):
        return ""
    return username.strip().lower()[:200]


def _gate_by_username(name: str) -> GateDevice | None:
    return GateDevice.objects.select_related("branch").filter(username__iexact=name).first() if name else None


def login_locked_out(username, gate: GateDevice | None = None) -> bool:
    """True when the last LOCKOUT_THRESHOLD attempts for this username within LOCKOUT_WINDOW were all wrong. A correct
    sign-in in between ends the lock (as for HR sign-in), and so does any HR change to the gate after the tries (its
    updated_at, stamped by every PUT gate-devices/<id>, e.g. a password reset). `gate`: the gate of that username when
    the caller already has it (looked up otherwise)."""
    name = normalize_username(username)
    if not name:
        return False
    since = timezone.now() - LOCKOUT_WINDOW
    gate = gate if gate is not None else _gate_by_username(name)
    if gate is not None and gate.updated_at and gate.updated_at > since:
        since = gate.updated_at
    recent = list(
        GateLoginAttempt.objects.filter(username=name, created_at__gte=since)
        .order_by("-created_at", "-id")
        .values_list("success", flat=True)[:LOCKOUT_THRESHOLD]
    )
    return len(recent) >= LOCKOUT_THRESHOLD and not any(recent)


def record_login_attempt(username, ip: str | None, success: bool) -> None:
    """One GateLoginAttempt row (the username normalised; nothing about the password)."""
    GateLoginAttempt.objects.create(username=normalize_username(username), ip_address=ip, success=bool(success))


def spend_password_check(raw) -> None:
    """One bcrypt check against a fixed hash, its answer thrown away: what a sign-in for an unknown username (or a device
    with no usable password) costs, so it takes as long as a wrong password for a real one."""
    try:
        bcrypt.checkpw((raw if isinstance(raw, str) and raw else "-").encode(), _DUMMY_HASH)
    except ValueError:
        pass


def check_device_login(request, username, password, *, find, attempts, locked_out, password_ok) -> tuple:
    """The sign-in decision of a device login (a gate, a reception desk), shared by check_gate_login and
    reception_credentials.check_desk_login: find(name) -> the device or None; attempts: its LoginAttempt model;
    locked_out(key, device) -> bool; password_ok(device, raw) -> bool. Returns (device | None, outcome).

    * A known device's tries count under its OWN username (lower case), however it was typed; an unknown name under the
      name typed (normalised).
    * The try is written as a failure BEFORE the (slow) password check and marked a success after it, so tries sent at
      the same moment each see the others and the lock cannot be outrun.
    * An unknown username (or an empty password) still costs one bcrypt check (spend_password_check).
    * A correct password for a switched-off device stays a failed try. A success removes the tries older than
      ATTEMPT_RETENTION (of every username)."""
    name = normalize_username(username)
    if not name:
        return None, LOGIN_WRONG
    device = find(name)
    key = normalize_username(device.username) if device is not None else name
    if locked_out(key, device):
        return None, LOGIN_LOCKED
    raw = password if isinstance(password, str) else ""
    attempt = attempts.objects.create(username=key, ip_address=_get_ip(request), success=False)
    if device is None or not device.password_hash or not raw:
        spend_password_check(raw)  # the same time as a real check, whatever was missing
        return None, LOGIN_WRONG
    if not password_ok(device, raw):
        return None, LOGIN_WRONG
    if not device.is_active:
        return device, LOGIN_SWITCHED_OFF
    attempts.objects.filter(pk=attempt.pk).update(success=True)
    attempts.objects.filter(created_at__lt=timezone.now() - ATTEMPT_RETENTION).delete()
    return device, LOGIN_OK


def check_gate_login(request, username, password) -> tuple[GateDevice | None, str]:
    """The whole sign-in decision, shared by POST gate-monitor/login and the old POST gate-devices/login.

    Returns (gate, LOGIN_OK) or (None | gate, one of LOGIN_WRONG / LOGIN_SWITCHED_OFF / LOGIN_LOCKED); LOGIN_ERRORS
    has the status and words for each. Records the attempt (not while locked, and not for an empty username): see
    check_device_login. Starts no session: call start_gate_session on LOGIN_OK."""
    return check_device_login(
        request,
        username,
        password,
        find=_gate_by_username,
        attempts=GateLoginAttempt,
        locked_out=login_locked_out,
        password_ok=check_gate_password,
    )


def start_gate_session(gate: GateDevice, request) -> tuple[GateSession, str]:
    """After LOGIN_OK: open a session, stamp last_login_at, and return (session, token)."""
    session = new_gate_session(gate, request)
    gate.last_login_at = timezone.now()
    gate.save(update_fields=["last_login_at"])
    return session, gate_token(gate, session)

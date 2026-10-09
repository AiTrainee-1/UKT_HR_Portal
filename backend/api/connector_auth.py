"""
Credentials of a Site Connector, and the decorator that guards the endpoints it calls.

A connector is created in the HRMS first. That makes a short pairing code (shown once, valid for a day, good for one
use). The connector sends the code to /api/connector/pair/ and gets back its own long random token, which it keeps and
sends as `Authorization: Bearer <token>` on every later request. The database keeps only the SHA-256 of each, so neither
can be read back; a lost token means pairing again.

These tokens are not the HR portal's JWTs: they are opaque, they identify a machine, not a person, and they are checked
against the database on every request, so deactivating or deleting a connector locks it out at its next call.
"""

from __future__ import annotations

import hashlib
import hmac
import secrets
from datetime import timedelta
from functools import wraps

from django.conf import settings
from django.core.cache import cache
from django.utils import timezone
from rest_framework.request import Request
from rest_framework.response import Response

from .auth import get_bearer_token

PAIRING_MINUTES = 24 * 60
# no 0/O, 1/I: a code is read off a screen and typed in at the factory
PAIRING_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
PAIRING_LENGTH = 8
TOKEN_PREFIX = "ukt_"

# Pairing is the one connector endpoint that needs no token, so it is rate limited: per address, and for the whole server.
PAIR_ATTEMPTS_PER_ADDRESS = 10
PAIR_ATTEMPTS_PER_SERVER = 300
PAIR_WINDOW_SECONDS = 600
# no connector request is anywhere near this (the largest are a chunk of 5000 punches and a list of 3000 users); a body past
# it is refused before it is read, so a connector cannot be used to fill the server's memory
MAX_BODY_BYTES = 3 * 1024 * 1024


def sha256(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def pairing_digest(code: str) -> str:
    """What is kept of a pairing code: a keyed hash, so that someone who can read the database cannot work a live code
    out of it (the code is only 40 bits; a plain hash of it falls to a short search)."""
    return hmac.new(
        settings.SECRET_KEY.encode("utf-8"), normalize_code(code).encode("utf-8"), hashlib.sha256
    ).hexdigest()


def new_token() -> str:
    return TOKEN_PREFIX + secrets.token_urlsafe(32)


def new_pairing_code() -> str:
    """A code like K7QM-4XWD, as it is shown."""
    raw = "".join(secrets.choice(PAIRING_ALPHABET) for _ in range(PAIRING_LENGTH))
    return f"{raw[:4]}-{raw[4:]}"


def normalize_code(raw) -> str:
    """The code as it is hashed: upper case, without the dash or spaces somebody typed or pasted."""
    return "".join(ch for ch in str(raw or "").upper() if ch.isalnum())


def pairing_expiry():
    return timezone.now() + timedelta(minutes=PAIRING_MINUTES)


def _caller(request: Request) -> str:
    """The address a request really came from, as far as it can be told: the LAST hop of X-Forwarded-For is the one the
    platform's own proxy added; the first is whatever the caller chose to write, so it must not decide the throttle."""
    forwarded = request.META.get("HTTP_X_FORWARDED_FOR", "")
    hop = forwarded.split(",")[-1].strip() if forwarded else request.META.get("REMOTE_ADDR", "")
    return (hop or "?")[:64]


def pair_throttled(request: Request) -> bool:
    """Count this attempt and say whether there have been too many. Counted in the cache (per process), which is enough to
    make guessing a one-in-a-trillion code pointless."""
    window = PAIR_WINDOW_SECONDS
    keys = (f"connector-pair:{_caller(request)}", "connector-pair:all")
    limits = (PAIR_ATTEMPTS_PER_ADDRESS, PAIR_ATTEMPTS_PER_SERVER)
    blocked = False
    for key, limit in zip(keys, limits):
        cache.add(key, 0, window)
        try:
            count = cache.incr(key)
        except ValueError:  # expired between the two calls
            cache.set(key, 1, window)
            count = 1
        if count > limit:
            blocked = True
    return blocked


def require_connector(view_func):
    """The caller must be a paired, active Site Connector. Sets request.connector."""

    @wraps(view_func)
    def wrapper(request: Request, *args, **kwargs):
        from .models import BiometricSiteConnector

        try:
            length = int(request.META.get("CONTENT_LENGTH") or 0)
        except ValueError:
            length = 0
        if length > MAX_BODY_BYTES:
            return Response({"error": "too_large", "message": "That request is too large."}, status=413)
        token = get_bearer_token(request)
        if not token:
            return Response({"error": "unauthorized", "message": "A connector token is required."}, status=401)
        connector = BiometricSiteConnector.objects.filter(token_hash=sha256(token)).first()
        if connector is None:
            return Response({"error": "invalid_token", "message": "This token is not recognised."}, status=401)
        if not connector.is_active:
            return Response(
                {"error": "revoked", "message": "This connector has been switched off in the HRMS."}, status=403
            )
        request.connector = connector
        return view_func(request, *args, **kwargs)

    return wrapper

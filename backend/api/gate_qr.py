"""Short signed gate QR codes (Outpass exit, Outpass return, tea break).

The long JWT the gate QRs used to carry (about 220 characters, a dense QR image) is cut short by some scanners and scanner
apps: they stop after the last dot, so the signature never arrives and the gate rightly refuses the code. These codes carry
the same facts in about 40 characters, uppercase letters, digits and dots only (the QR "alphanumeric" mode: a small, low
density image that every scanner reads), and are protected the same way: a keyed signature (HMAC-SHA256 under a key derived
from JWT_SECRET for this purpose only, cut to 96 bits) that nobody can produce without the server's secret.

    P.<request>.<expiry>.<sig>                       exit pass of Outpass request <request>
    R.<request>.<generated>.<expiry>.<sig>           return pass; <generated> = when it was generated (microseconds)
    T.<employee>.<sig>                               permanent tea-break code of an employee

<request>, <employee>, <expiry> (unix seconds) and <generated> are base 36. The server still decides everything else from
its own records (was the pass approved, already used, is this the newest return code), exactly as with the old token; the
old long JWT is still accepted by gate_scanner_views.resolve_gate_scan so a pass already open on a phone keeps working.
Matching is case-insensitive (a scanner that lowercases the text still works).
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import re
import time
from datetime import datetime, timedelta, timezone

from django.conf import settings

ROLE_BY_PREFIX = {"P": "outpass_pass", "R": "outpass_return", "T": "tea_break"}
_SIG_BYTES = 12  # 96 bits: far beyond guessing, 20 characters
_SHAPE = re.compile(r"^[PRT](\.[0-9A-Z]+)+$")
_FIELDS = {"P": 4, "R": 5, "T": 3}  # parts including the prefix and the signature
_DIGITS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ"


class GateQrError(ValueError):
    """The text is not a valid, current gate QR code (never says which check failed: it reaches the guard as 'not recognized')."""


def _key() -> bytes:
    return hmac.new(settings.JWT_SECRET.encode("utf-8"), b"uk-gate-qr-v1", hashlib.sha256).digest()


def _b36(n: int) -> str:
    if n < 0:
        raise ValueError("negative")
    out = ""
    while True:
        n, r = divmod(n, 36)
        out = _DIGITS[r] + out
        if n == 0:
            return out


def _sign(body: str) -> str:
    raw = hmac.new(_key(), body.encode("ascii"), hashlib.sha256).digest()[:_SIG_BYTES]
    return base64.b32encode(raw).decode("ascii").rstrip("=")


def _seal(body: str) -> str:
    return f"{body}.{_sign(body)}"


def _unix(dt: datetime) -> int:
    return int(dt.timestamp())


def _micros(dt: datetime) -> int:
    return _unix(dt) * 1_000_000 + dt.microsecond


def pass_code(request_id: int, expires_in: timedelta) -> str:
    """The exit QR text of an approved Outpass request, valid for `expires_in` from now."""
    return _seal(f"P.{_b36(request_id)}.{_b36(int(time.time() + expires_in.total_seconds()))}")


def return_code(request_id: int, generated_at: datetime, expires_in: timedelta) -> str:
    """The return QR text: carries the moment it was generated so a newer one makes this one stale."""
    return _seal(
        f"R.{_b36(request_id)}.{_b36(_micros(generated_at))}.{_b36(int(time.time() + expires_in.total_seconds()))}"
    )


def tea_code(employee_id: int) -> str:
    """The permanent tea-break QR text of an employee (no expiry: it only identifies them, like the old 10-year token)."""
    return _seal(f"T.{_b36(employee_id)}")


def looks_like_code(text: str) -> bool:
    """True when the text has the shape of a gate QR code (so it is checked as one, not as a JWT)."""
    return bool(_SHAPE.match((text or "").strip().upper()))


def looks_like_cut_jwt(text: str) -> bool:
    """True for a JWT that lost its tail: starts like one ('eyJ') but is not the complete three-part token. A scanner
    that cut it is the usual reason; the guard is told to scan again instead of 'not recognized'."""
    text = (text or "").strip()
    if not text.startswith("eyJ"):
        return False
    parts = text.split(".")
    return len(parts) < 3 or not parts[2]


def parse(text: str) -> dict:
    """The facts of a valid code, shaped like the old token's payload ({role, requestId, generatedAt (ISO), employeeId}).
    Raises GateQrError for anything else: wrong shape, wrong signature, expired."""
    text = (text or "").strip().upper()
    if not _SHAPE.match(text):
        raise GateQrError("shape")
    parts = text.split(".")
    prefix = parts[0]
    if len(parts) != _FIELDS[prefix]:
        raise GateQrError("fields")
    body, sig = ".".join(parts[:-1]), parts[-1]
    if not hmac.compare_digest(_sign(body), sig):
        raise GateQrError("signature")
    try:
        numbers = [int(p, 36) for p in parts[1:-1]]
    except ValueError as e:  # pragma: no cover - the shape check already limits the characters
        raise GateQrError("number") from e
    out: dict = {"role": ROLE_BY_PREFIX[prefix]}
    if prefix == "T":
        out["employeeId"] = numbers[0]
        return out
    expires = numbers[-1]
    if expires < time.time():
        raise GateQrError("expired")
    out["requestId"] = numbers[0]
    if prefix == "R":
        micros = numbers[1]
        out["generatedAt"] = (
            datetime.fromtimestamp(micros // 1_000_000, tz=timezone.utc)
            .replace(microsecond=micros % 1_000_000)
            .isoformat()
        )
    return out

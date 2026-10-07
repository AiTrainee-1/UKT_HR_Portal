"""
Talking to one biometric terminal over the ZK protocol (TCP, port 4370), for Device Control.

pyzk speaks the protocol. This module is what the portal needs on top of it:

  * One place that opens a session, with a short reachability pre-check, a per-device lock (a terminal serves one
    session at a time) and errors a person can act on ("did not answer", "wrong Comm Key", ...) instead of a stack.
  * Users are read and written as the device's own raw records, never rebuilt from scratch. pyzk's set_user writes a
    zero in a byte that every real terminal keeps at 1 (the user's group), so an edit through it would quietly change
    more than was asked. Here an edit overlays only the fields being changed on the record the device returned, and
    every other byte is sent back exactly as it was.
  * A fast attendance reader. pyzk's get_attendance looks every punch's user up with a linear scan, which on a
    terminal with a hundred thousand punches and a few thousand users is minutes of CPU; this one uses a dictionary.
    A record whose date cannot exist is skipped and counted instead of aborting the whole read.

Nothing here touches the database: device_directory.py and device_fetch.py do that. The same terminals are reached
by the existing Sync Biometric code (biometric_sync.py), which this module deliberately does not change.
"""

from __future__ import annotations

import logging
import os
import socket
import struct
import threading
import time
from contextlib import contextmanager
from dataclasses import dataclass
from datetime import date, datetime

from .device_probe import is_private_host

logger = logging.getLogger(__name__)

ZK_IO_TIMEOUT_SECONDS = 10
PRECHECK_SECONDS = 3
READ_LOCK_WAIT_SECONDS = 6
WRITE_LOCK_WAIT_SECONDS = 25
# The longest a whole session may last. pyzk waits for the rest of a download in a loop that never ends when the terminal
# closes the connection half way (it keeps asking a closed connection for more), and a session that never ends holds
# the per-device lock for ever: past this the connection is dropped from outside, which ends the loop.
SESSION_DEADLINE_SECONDS = 120
LOG_READ_DEADLINE_SECONDS = 600

# Privileges as the terminals store them (pyzk's USER_* constants carry the same numbers).
PRIVILEGE_USER = 0
PRIVILEGE_ENROLLER = 2
PRIVILEGE_ADMIN = 6
PRIVILEGE_SUPER_ADMIN = 14
PRIVILEGE_LABELS = {
    PRIVILEGE_USER: "User",
    PRIVILEGE_ENROLLER: "Enroller",
    PRIVILEGE_ADMIN: "Administrator",
    PRIVILEGE_SUPER_ADMIN: "Super admin",
}

# The two layouts a user record has. Newer terminals (every one of this company's) use 72 bytes; older ones 28.
RECORD_72 = 72
RECORD_28 = 28
NAME_BYTES = {RECORD_72: 24, RECORD_28: 8}
PASSWORD_BYTES = {RECORD_72: 8, RECORD_28: 5}


class DeviceUnavailable(Exception):
    """The device could not be used, with a reason a person can act on.

    code: cloud (this server cannot see the factory network), timeout, refused, unreachable, auth, busy (another
    operation holds the device), protocol (it answered in a way this code does not understand), lost (the connection
    broke part way), rejected (the device refused one user record or delete; the connection is fine), error."""

    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code
        self.message = message


@dataclass
class DeviceUser:
    uid: int
    user_id: str
    name: str
    privilege: int
    card: int
    password: str  # in memory only: never stored, never returned by an API
    group: str
    raw: bytes  # the record exactly as the device holds it

    @property
    def has_password(self) -> bool:
        return bool(self.password)


@dataclass
class Punch:
    user_id: str
    at: datetime
    status: int


def on_cloud() -> bool:
    """True when this server is the Railway deployment (it has no route into the factory network)."""
    env = os.environ
    return bool(env.get("RAILWAY_ENVIRONMENT") or env.get("RAILWAY_PROJECT_ID") or env.get("RAILWAY_SERVICE_ID"))


# ── one session at a time per device ────────────────────────────────────────────────────────────────────────────────

_locks: dict[tuple[str, int], threading.Lock] = {}
_locks_guard = threading.Lock()


def _lock_for(host: str, port: int) -> threading.Lock:
    with _locks_guard:
        return _locks.setdefault((host, port), threading.Lock())


# ── user records ────────────────────────────────────────────────────────────────────────────────────────────────────


def _text(raw: bytes) -> str:
    return raw.split(b"\x00")[0].decode("utf-8", errors="ignore").strip()


def parse_record(raw: bytes) -> DeviceUser:
    """One user record (72 or 28 bytes) into its fields. The raw record is kept so an edit can overlay on it."""
    if len(raw) == RECORD_72:
        uid, privilege, password, name, card = struct.unpack_from("<HB8s24sI", raw, 0)
        group = _text(raw[40:47])
        user_id = _text(raw[48:72])
    elif len(raw) == RECORD_28:
        uid, privilege, password, name, card = struct.unpack_from("<HB5s8sI", raw, 0)
        group = str(raw[21])
        user_id = str(struct.unpack_from("<I", raw, 24)[0])
    else:
        raise DeviceUnavailable("protocol", f"A user record of {len(raw)} bytes is not a layout this portal knows.")
    return DeviceUser(
        uid=uid,
        user_id=user_id,
        name=_text(name),
        privilege=privilege,
        card=card,
        password=_text(password),
        group=group,
        raw=bytes(raw),
    )


def build_record(
    size: int,
    *,
    uid: int,
    user_id: str,
    name: str | None = None,
    privilege: int | None = None,
    password: str | None = None,
    card: int | None = None,
    group: str | None = None,
    base: bytes | None = None,
) -> bytes:
    """A user record to send to the device. `base` is the record the device returned for this user: every field left
    as None keeps its bytes, and bytes this function does not know about are never touched. Without a base (a new
    user) the record starts from what a terminal itself writes: zeros, with the group byte at 1."""
    if size not in (RECORD_72, RECORD_28):
        raise DeviceUnavailable("protocol", f"A user record of {size} bytes is not a layout this portal knows.")
    if base is not None and len(base) != size:
        raise ValueError("the record to change is not the size of the device's records")
    if not 0 < uid <= 0xFFFF:
        raise ValueError("the device slot number is out of range")
    rec = bytearray(base if base is not None else bytes(size))
    if base is None:
        if size == RECORD_72:
            rec[39] = 1
        else:
            rec[21] = 1
    struct.pack_into("<H", rec, 0, uid)
    if privilege is not None:
        rec[2] = privilege & 0xFF
    pw_width = PASSWORD_BYTES[size]
    if password is not None:
        encoded = password.encode("utf-8")
        if len(encoded) > pw_width:
            raise ValueError(f"the password can be at most {pw_width} characters on this device")
        rec[3 : 3 + pw_width] = encoded.ljust(pw_width, b"\x00")
    name_off = 11 if size == RECORD_72 else 8
    name_width = NAME_BYTES[size]
    if name is not None:
        encoded = name.encode("utf-8")
        if len(encoded) > name_width:
            raise ValueError(f"the name can be at most {name_width} bytes on this device")
        rec[name_off : name_off + name_width] = encoded.ljust(name_width, b"\x00")
    card_off = 35 if size == RECORD_72 else 16
    if card is not None:
        if not 0 <= card <= 0xFFFFFFFF:
            raise ValueError("the card number must fit in 32 bits")
        struct.pack_into("<I", rec, card_off, card)
    if size == RECORD_72:
        if group is not None:
            encoded = group.encode("utf-8")
            if len(encoded) > 7:
                raise ValueError("the group can be at most 7 characters on this device")
            rec[40:47] = encoded.ljust(7, b"\x00")
        encoded = user_id.encode("utf-8")
        if len(encoded) > 24:
            raise ValueError("the user ID can be at most 24 characters")
        rec[48:72] = encoded.ljust(24, b"\x00")
    else:
        if group is not None:
            rec[21] = int(group) & 0xFF if str(group).isdigit() else 0
        if not (str(user_id).isascii() and str(user_id).isdigit()):
            raise ValueError("this older device only takes a numeric user ID")
        if int(user_id) > 0xFFFFFFFF:
            raise ValueError("the user ID is too large for this older device")
        struct.pack_into("<I", rec, 24, int(user_id))
    return bytes(rec)


# ── time ────────────────────────────────────────────────────────────────────────────────────────────────────────────


def decode_time(raw: bytes) -> datetime:
    """The terminal's 4-byte timestamp (months of 31 days: the device's own arithmetic). ValueError for a date that
    does not exist."""
    t = struct.unpack("<I", raw)[0]
    second = t % 60
    t //= 60
    minute = t % 60
    t //= 60
    hour = t % 24
    t //= 24
    day = t % 31 + 1
    t //= 31
    month = t % 12 + 1
    t //= 12
    return datetime(t + 2000, month, day, hour, minute, second)


def encode_time(moment: datetime) -> bytes:
    value = (
        ((moment.year % 100) * 12 * 31 + ((moment.month - 1) * 31) + moment.day - 1) * (24 * 60 * 60)
        + (moment.hour * 60 + moment.minute) * 60
        + moment.second
    )
    return struct.pack("<I", value)


# ── errors ──────────────────────────────────────────────────────────────────────────────────────────────────────────


def _precheck(host: str, port: int) -> None:
    """A plain TCP connect, in a few seconds, before the slower handshake. A device that does not answer must not
    hold a request open for the whole protocol timeout."""
    try:
        sock = socket.create_connection((host, port), timeout=PRECHECK_SECONDS)
    except socket.timeout as exc:
        raise DeviceUnavailable(
            "timeout",
            f"{host}:{port} did not answer within {PRECHECK_SECONDS} seconds. Check that the device is on, its IP "
            "address, the network cable and any firewall between this server and the device.",
        ) from exc
    except ConnectionRefusedError as exc:
        raise DeviceUnavailable(
            "refused",
            f"{host} answered but refused port {port}. Check the TCP COMM. Port on the device "
            "(Menu → COMM. → Ethernet) against the port in Settings → Devices.",
        ) from exc
    except OSError as exc:
        raise DeviceUnavailable(
            "unreachable", f"There is no route to {host}:{port} from this server ({exc.strerror or exc})."
        ) from exc
    sock.close()


def _classify(exc: Exception, host: str, port: int) -> DeviceUnavailable:
    if isinstance(exc, DeviceUnavailable):
        return exc
    text = str(exc)
    if "unauth" in text.lower():
        return DeviceUnavailable("auth", "The device refused the communication password (Comm Key).")
    if isinstance(exc, (socket.timeout, TimeoutError)) or "timed out" in text.lower():
        return DeviceUnavailable("timeout", f"The device at {host}:{port} stopped answering ({text}).")
    if isinstance(exc, OSError) or type(exc).__name__ == "ZKNetworkError":
        return DeviceUnavailable("lost", f"The connection to the device at {host}:{port} was lost ({text}).")
    return DeviceUnavailable("error", f"The device at {host}:{port} reported a problem: {text}")


def _device_errors() -> tuple[type[BaseException], ...]:
    """The exceptions that mean "the device or the network misbehaved" (and nothing else: a bug or a bad value in the
    calling code must stay what it is)."""
    try:
        from zk.exception import ZKError

        return (ZKError, OSError, struct.error)
    except ImportError:  # pragma: no cover -pyzk is a requirement
        return (OSError, struct.error)


def _send(conn, command: int, payload: bytes = b"", response_size: int = 1024) -> dict:
    """pyzk's low-level command call (it has no public one for the commands used here)."""
    return conn._ZK__send_command(command, payload, response_size)


# ── a session ───────────────────────────────────────────────────────────────────────────────────────────────────────


class Session:
    """One open connection to one device."""

    def __init__(self, conn, host: str, port: int):
        self.conn = conn
        self.host = host
        self.port = port
        self.record_size = RECORD_72
        self.deadline_hit = False

    # reading ---------------------------------------------------------------------------------------------------------

    def sizes(self) -> dict:
        c = self.conn
        c.read_sizes()
        return {
            "users": c.users,
            "usersCap": c.users_cap,
            "fingers": c.fingers,
            "fingersCap": c.fingers_cap,
            "records": c.records,
            "recordsCap": c.rec_cap,
            "cards": c.cards,
            "faces": getattr(c, "faces", 0),
            "facesCap": getattr(c, "faces_cap", 0),
        }

    def identity(self) -> dict:
        """Serial, model, firmware and the longest user ID the device accepts. Each is optional: a model that does
        not answer one leaves it out."""
        out: dict = {}
        for key, fn in (
            ("serial", self.conn.get_serialnumber),
            ("platform", self.conn.get_platform),
            ("firmware", self.conn.get_firmware_version),
            ("pinWidth", self.conn.get_pin_width),
        ):
            try:
                out[key] = fn()
            except Exception:  # noqa: BLE001 -one missing detail must not lose the rest
                pass
        return out

    def device_time(self) -> datetime | None:
        try:
            return self.conn.get_time()
        except Exception:  # noqa: BLE001
            return None

    def read_users(self) -> list[DeviceUser]:
        from zk import const

        c = self.conn
        c.read_sizes()
        if c.users == 0:
            if c.users_cap and c.users_cap - c.users_av > 0:
                # its own counters disagree (slots in use, yet "no users"): an empty answer here could be mistaken for
                # an empty device and a new user written over a real one
                raise DeviceUnavailable(
                    "protocol", "The device reported no users although it says some slots are in use."
                )
            return []
        data, size = c.read_with_buffer(const.CMD_USERTEMP_RRQ, const.FCT_USER)
        if size <= 4:
            raise DeviceUnavailable("protocol", "The device returned no user data although it reports users.")
        total = struct.unpack("<I", data[:4])[0]
        record_size = total // c.users
        if record_size not in (RECORD_72, RECORD_28):
            raise DeviceUnavailable(
                "protocol", f"The device's user records are {record_size} bytes, a layout this portal does not know."
            )
        self.record_size = record_size
        body = data[4 : 4 + total]
        return [parse_record(body[i : i + record_size]) for i in range(0, len(body) - record_size + 1, record_size)]

    def read_attendance(self, since: date | None = None, until: date | None = None) -> tuple[list[Punch], int, int]:
        """The punches on the device between two dates (inclusive; None = no limit), how many records had a date that
        cannot exist (skipped), and how many valid records the device holds in all. A punch outside the range is
        counted but never turned into an object, so a year of history does not cost a year of memory."""
        from zk import const

        c = self.conn
        c.read_sizes()
        if c.records == 0:
            return [], 0, 0
        by_uid: dict[int, str] = {}
        by_pin: dict[str, int] = {}
        for u in self.read_users():
            by_uid[u.uid] = u.user_id
            by_pin[u.user_id] = u.uid
        data, size = c.read_with_buffer(const.CMD_ATTLOG_RRQ)
        if size < 4:
            return [], 0, 0
        total = struct.unpack("<I", data[:4])[0]
        record_size = total // c.records
        body = data[4:]
        punches: list[Punch] = []
        invalid = 0
        valid = 0

        def keep(user_id: str, stamp: bytes, status: int) -> None:
            nonlocal invalid, valid
            try:
                at = decode_time(stamp)
            except ValueError:
                invalid += 1
                return
            valid += 1
            day = at.date()
            if (since is None or day >= since) and (until is None or day <= until):
                punches.append(Punch(user_id, at, status))

        if record_size == 8:
            fmt = struct.Struct("<HB4sB")
            for off in range(0, len(body) - 7, 8):
                uid, status, stamp, _verify = fmt.unpack_from(body, off)
                keep(by_uid.get(uid, str(uid)), stamp, status)
        elif record_size == 16:
            fmt = struct.Struct("<I4sBB2sI")
            for off in range(0, len(body) - 15, 16):
                pin, stamp, status, _verify, _res, _work = fmt.unpack_from(body, off)
                keep(str(pin), stamp, status)
        else:
            fmt = struct.Struct("<H24sB4sB8s")
            for off in range(0, len(body) - 39, 40):
                _uid, pin, status, stamp, _verify, _space = fmt.unpack_from(body, off)
                keep(_text(pin), stamp, status)
        return punches, invalid, valid

    # writing ---------------------------------------------------------------------------------------------------------

    def write_record(self, record: bytes) -> None:
        from zk import const

        try:
            response = _send(self.conn, const.CMD_USER_WRQ, record)
            if not response.get("status"):
                raise DeviceUnavailable(
                    "rejected", f"The device refused the user record (answer code {response.get('code')})."
                )
            self.conn.refresh_data()
        except _device_errors() as exc:
            raise _classify(exc, self.host, self.port) from exc

    def delete_uid(self, uid: int) -> None:
        from zk import const

        try:
            response = _send(self.conn, const.CMD_DELETE_USER, struct.pack("<H", uid))
            if not response.get("status"):
                raise DeviceUnavailable(
                    "rejected", f"The device refused to delete the user (answer code {response.get('code')})."
                )
            self.conn.refresh_data()
        except _device_errors() as exc:
            raise _classify(exc, self.host, self.port) from exc


def _drop_connection(session: "Session") -> None:
    """The watchdog: the session has run past its deadline, so close its socket from outside. That wakes whatever pyzk
    is stuck waiting for, with an error instead of a loop that never ends."""
    session.deadline_hit = True
    sock = getattr(session.conn, "_ZK__sock", None)
    for action in (lambda: sock.shutdown(socket.SHUT_RDWR), lambda: sock.close()):
        try:
            action()
        except Exception:  # noqa: BLE001
            pass


@contextmanager
def open_session(host: str, port: int | None, password: int = 0, *, write: bool = False, deadline: float | None = None):
    """Open a session with the device and close it afterwards.

    write=True waits longer for the device's lock (a person is waiting for the change) and holds the terminal
    disabled for the duration, so nobody punches into a half-finished write; it is always enabled again, even when
    the write fails. The session is dropped after `deadline` seconds however far it has got (SESSION_DEADLINE_SECONDS
    unless given)."""
    deadline = deadline or SESSION_DEADLINE_SECONDS
    port = port or 4370
    if on_cloud() and is_private_host(host):
        raise DeviceUnavailable(
            "cloud",
            f"This server runs in the cloud and cannot reach {host}, an address inside the factory network. "
            "Open the HRMS on a computer in the factory (the local app), or have the firewall forward the device's port.",
        )
    lock = _lock_for(host, port)
    if not lock.acquire(timeout=WRITE_LOCK_WAIT_SECONDS if write else READ_LOCK_WAIT_SECONDS):
        raise DeviceUnavailable("busy", "The device is busy with another operation. Try again in a moment.")
    conn = None
    try:
        _precheck(host, port)
        try:
            from zk import ZK

            conn = ZK(
                host, port=port, timeout=ZK_IO_TIMEOUT_SECONDS, password=password, force_udp=False, ommit_ping=True
            ).connect()
        except Exception as exc:  # noqa: BLE001
            raise _classify(exc, host, port) from exc
        session = Session(conn, host, port)
        watchdog = threading.Timer(deadline, _drop_connection, args=(session,))
        watchdog.daemon = True
        watchdog.start()
        timed_out = DeviceUnavailable(
            "timeout", f"The device did not finish within {int(deadline)} seconds, so the connection was dropped."
        )
        disabled = False
        try:
            if write:
                conn.disable_device()
                disabled = True
            yield session
        except DeviceUnavailable as exc:
            if session.deadline_hit and exc.code != "timeout":
                raise timed_out from exc
            raise
        except _device_errors() as exc:
            if session.deadline_hit:
                raise timed_out from exc
            raise _classify(exc, host, port) from exc
        finally:
            watchdog.cancel()
            if disabled:
                try:
                    conn.enable_device()
                except Exception:  # noqa: BLE001
                    logger.warning("Could not re-enable the device at %s:%s after a write", host, port)
    finally:
        if conn is not None:
            try:
                conn.disconnect()
            except Exception:  # noqa: BLE001
                pass
        lock.release()


def timed_probe(host: str, port: int | None, password: int = 0) -> dict:
    """The overview's check of one device: can this server open a session, how fast, and what the device says about
    itself. {"ok", "code", "error", "latencyMs", "capacity", "deviceTime", "busy"}. Never raises."""
    started = time.perf_counter()
    try:
        with open_session(host, port, password) as session:
            latency = (time.perf_counter() - started) * 1000
            capacity = {**session.sizes(), **session.identity()}
            when = session.device_time()
        return {
            "ok": True,
            "code": "ok",
            "error": "",
            "latencyMs": round(latency, 1),
            "capacity": capacity,
            "deviceTime": when.isoformat() if when else None,
        }
    except DeviceUnavailable as exc:
        return {
            "ok": exc.code == "busy",
            "code": exc.code,
            "error": exc.message,
            "latencyMs": None,
            "capacity": None,
            "deviceTime": None,
        }
    except Exception as exc:  # noqa: BLE001
        logger.exception("Unexpected failure probing %s:%s", host, port)
        return {
            "ok": False,
            "code": "error",
            "error": str(exc),
            "latencyMs": None,
            "capacity": None,
            "deviceTime": None,
        }

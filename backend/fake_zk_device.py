"""
A fake ZKTeco terminal, for tests. It speaks enough of the ZK protocol over TCP for pyzk and api/device_client.py to
treat it as a real device: connect (with or without a Comm Key), capacity, identity options, the user table, the
attendance log, writing and deleting users, enabling and disabling.

It is written from pyzk's client code and from user records captured off the company's real terminals (72-byte records
whose byte 39 is 1, user ID at 48..72), and deliberately does not import api/device_client.py: the tests check that
module against an independent implementation of the other end.

In a unit test:

    device = FakeDevice(); device.add_user(1, "1001", "Asha")
    with FakeServer(device) as server:          # server.port is the TCP port to point a BiometricDevice row at
        ...

For the Playwright suite it runs as a process (several devices on consecutive ports, plus a small HTTP control port
to reset, inspect and inject punches):

    python fake_zk_device.py --base-port 14371 --count 3 --control-port 14380
"""

from __future__ import annotations

import argparse
import json
import socketserver
import struct
import threading
import time
from datetime import datetime, timedelta
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from zk.base import make_commkey

CMD_USER_WRQ = 8
CMD_OPTIONS_RRQ = 11
CMD_DELETE_USER = 18
CMD_GET_FREE_SIZES = 50
CMD_GET_PINWIDTH = 69
CMD_GET_TIME = 201
CMD_CONNECT = 1000
CMD_EXIT = 1001
CMD_ENABLEDEVICE = 1002
CMD_DISABLEDEVICE = 1003
CMD_REFRESHDATA = 1013
CMD_GET_VERSION = 1100
CMD_AUTH = 1102
CMD_DATA = 1501
CMD_FREE_DATA = 1502
CMD_READ_BUFFER = 1503
CMD_ACK_OK = 2000
CMD_ACK_ERROR = 2001
CMD_ACK_UNAUTH = 2005

CMD_USERTEMP_RRQ = 9
CMD_ATTLOG_RRQ = 13


def _encode_time(moment: datetime) -> bytes:
    value = (
        ((moment.year % 100) * 12 * 31 + ((moment.month - 1) * 31) + moment.day - 1) * 86400
        + (moment.hour * 60 + moment.minute) * 60
        + moment.second
    )
    return struct.pack("<I", value)


def _checksum(data: bytes) -> int:
    total = 0
    for i in range(0, len(data) - 1, 2):
        total += data[i] | (data[i + 1] << 8)
        if total > 65535:
            total -= 65535
    if len(data) % 2:
        total += data[-1]
    while total > 65535:
        total -= 65535
    total = ~total
    while total < 0:
        total += 65535
    return total & 0xFFFF


def record72(uid: int, user_id: str, name: str, privilege: int = 0, card: int = 0, password: str = "") -> bytes:
    """A user record the way the real terminals hold it: the byte after the card is 1 (the group), the rest zero."""
    rec = bytearray(72)
    struct.pack_into("<H", rec, 0, uid)
    rec[2] = privilege
    rec[3:11] = password.encode().ljust(8, b"\x00")
    rec[11:35] = name.encode().ljust(24, b"\x00")
    struct.pack_into("<I", rec, 35, card)
    rec[39] = 1
    rec[48:72] = user_id.encode().ljust(24, b"\x00")
    return bytes(rec)


def record28(uid: int, user_id: str, name: str, privilege: int = 0, card: int = 0, password: str = "") -> bytes:
    rec = bytearray(28)
    struct.pack_into("<H", rec, 0, uid)
    rec[2] = privilege
    rec[3:8] = password.encode().ljust(5, b"\x00")
    rec[8:16] = name.encode().ljust(8, b"\x00")
    struct.pack_into("<I", rec, 16, card)
    rec[21] = 1
    struct.pack_into("<I", rec, 24, int(user_id))
    return bytes(rec)


DROP = object()  # the answer that means: close the connection without a word


class FakeDevice:
    """The state of one pretend terminal. Safe to change from a test while a server thread reads it."""

    def __init__(
        self,
        *,
        serial: str = "FAKE000001",
        name: str = "x 2008",
        platform: str = "ZAM180_TFT",
        password: int = 0,
        record_size: int = 72,
        users_cap: int = 3000,
        records_cap: int = 150000,
        pin_width: int = 9,
    ):
        self.lock = threading.RLock()
        self.serial = serial
        self.password = password
        self.record_size = record_size
        self.users_cap = users_cap
        self.records_cap = records_cap
        self.pin_width = pin_width
        self.options = {
            "~SerialNumber": serial,
            "~DeviceName": name,
            "~Platform": platform,
            "MAC": "00:17:61:12:bc:b4",
            "IPAddress": "192.168.0.99",
        }
        self.users: dict[int, bytes] = {}
        self.punches: list[tuple[str, datetime, int]] = []
        self.faces = 0
        self.commands: list[int] = []  # every command received, in order (for tests)
        self.enabled = True
        self.sessions = 0
        # failure injection
        self.refuse_writes = False  # answer ACK_ERROR to user writes and deletes
        self.mute = False  # accept the connection, then never answer
        self.invalid_punch_dates = 0  # extra punch records with a date that cannot exist
        self.drop_after_writes: int | None = None  # hang up (no answer) on the write or delete after this many
        self.ignore_privilege = False  # accept a user write but keep the role at 0: firmware that normalises it
        self.truncate_reads = False  # send half of a big download, then close: a terminal that reboots mid-transfer
        self.report_zero_users = False  # say there are no users while the other counters say there are
        self._writes_done = 0
        self.refuse_connections_after: int | None = None

    # building -----------------------------------------------------------------------------------------------------
    def add_user(
        self, uid: int, user_id: str, name: str, privilege: int = 0, card: int = 0, password: str = ""
    ) -> None:
        make = record72 if self.record_size == 72 else record28
        with self.lock:
            self.users[uid] = make(uid, user_id, name, privilege, card, password)

    def add_punch(self, user_id: str, at: datetime, status: int = 0) -> None:
        with self.lock:
            self.punches.append((user_id, at.replace(microsecond=0), status))

    # inspecting -------------------------------------------------------------------------------------------------
    def user_ids(self) -> list[str]:
        with self.lock:
            return sorted(self._parse(r)["user_id"] for r in self.users.values())

    def user(self, user_id: str) -> dict | None:
        with self.lock:
            for rec in self.users.values():
                parsed = self._parse(rec)
                if parsed["user_id"] == user_id:
                    return parsed
        return None

    def _parse(self, rec: bytes) -> dict:
        def text(b: bytes) -> str:
            return b.split(b"\x00")[0].decode("utf-8", "ignore")

        if len(rec) == 72:
            return {
                "uid": struct.unpack_from("<H", rec, 0)[0],
                "privilege": rec[2],
                "password": text(rec[3:11]),
                "name": text(rec[11:35]),
                "card": struct.unpack_from("<I", rec, 35)[0],
                "flag": rec[39],
                "group": text(rec[40:47]),
                "user_id": text(rec[48:72]),
                "raw": rec,
            }
        return {
            "uid": struct.unpack_from("<H", rec, 0)[0],
            "privilege": rec[2],
            "password": text(rec[3:8]),
            "name": text(rec[8:16]),
            "card": struct.unpack_from("<I", rec, 16)[0],
            "flag": rec[21],
            "group": str(rec[21]),
            "user_id": str(struct.unpack_from("<I", rec, 24)[0]),
            "raw": rec,
        }

    def snapshot(self) -> dict:
        with self.lock:
            return {
                "serial": self.serial,
                "enabled": self.enabled,
                "users": [{k: v for k, v in self._parse(r).items() if k != "raw"} for r in self.users.values()],
                "punches": len(self.punches),
                "commands": list(self.commands[-50:]),
            }

    # the protocol ---------------------------------------------------------------------------------------------
    def respond(self, command: int, data: bytes, session: dict) -> tuple[int, bytes] | None:
        """(answer code, answer data) for one command; None closes the connection."""
        with self.lock:
            self.commands.append(command)
            if command == CMD_CONNECT:
                self.sessions += 1
                if self.password and not session.get("authed"):
                    return CMD_ACK_UNAUTH, b""
                session["authed"] = True
                return CMD_ACK_OK, b""
            if command == CMD_AUTH:
                if make_commkey(self.password, session["id"]) == data[:4]:
                    session["authed"] = True
                    return CMD_ACK_OK, b""
                return CMD_ACK_UNAUTH, b""
            if self.password and not session.get("authed"):
                return CMD_ACK_UNAUTH, b""
            if command == CMD_EXIT:
                return None
            if command == CMD_ENABLEDEVICE:
                self.enabled = True
                return CMD_ACK_OK, b""
            if command == CMD_DISABLEDEVICE:
                self.enabled = False
                return CMD_ACK_OK, b""
            if command == CMD_GET_FREE_SIZES:
                fields = [0] * 20
                fields[4] = 0 if self.report_zero_users else len(self.users)
                fields[6] = 0
                fields[8] = len(self.punches)
                fields[12] = sum(1 for r in self.users.values() if self._parse(r)["card"])
                fields[14] = 0
                fields[15] = self.users_cap
                fields[16] = self.records_cap
                fields[17] = 0
                fields[18] = self.users_cap - len(self.users)
                fields[19] = self.records_cap - len(self.punches)
                return CMD_ACK_OK, struct.pack("<20i", *fields) + struct.pack("<3i", self.faces, 0, self.users_cap)
            if command == CMD_OPTIONS_RRQ:
                key = data.split(b"\x00")[0].decode("utf-8", "ignore")
                if key in self.options:
                    return CMD_ACK_OK, f"{key}={self.options[key]}".encode() + b"\x00"
                return CMD_ACK_ERROR, b""
            if command == CMD_GET_PINWIDTH:
                return CMD_ACK_OK, bytes([self.pin_width])
            if command == CMD_GET_VERSION:
                return CMD_ACK_OK, b"Ver 6.60 Mar 24 2021\x00"
            if command == CMD_GET_TIME:
                return CMD_ACK_OK, _encode_time(datetime.now().replace(microsecond=0))
            if command == CMD_READ_BUFFER:
                _flag, what, _fct, _ext = struct.unpack("<bhii", data[:11])
                if what == CMD_USERTEMP_RRQ:
                    body = b"".join(self.users[uid] for uid in sorted(self.users))
                elif what == CMD_ATTLOG_RRQ:
                    body = b"".join(self._punch_record(i, p) for i, p in enumerate(self.punches))
                    body += b"".join(self._bad_punch_record() for _ in range(self.invalid_punch_dates))
                else:
                    return CMD_ACK_ERROR, b""
                return CMD_DATA, struct.pack("<I", len(body)) + body
            if command in (CMD_USER_WRQ, CMD_DELETE_USER):
                if self.drop_after_writes is not None and self._writes_done >= self.drop_after_writes:
                    return DROP
                self._writes_done += 1
            if command == CMD_USER_WRQ:
                if (
                    self.refuse_writes
                    or len(self.users) >= self.users_cap
                    and struct.unpack_from("<H", data, 0)[0] not in self.users
                ):
                    return CMD_ACK_ERROR, b""
                if len(data) != self.record_size:
                    return CMD_ACK_ERROR, b""
                record = bytearray(data)
                if self.ignore_privilege:
                    record[2] = 0
                self.users[struct.unpack_from("<H", data, 0)[0]] = bytes(record)
                return CMD_ACK_OK, b""
            if command == CMD_DELETE_USER:
                if self.refuse_writes:
                    return CMD_ACK_ERROR, b""
                self.users.pop(struct.unpack("<H", data[:2])[0], None)
                return CMD_ACK_OK, b""
            return CMD_ACK_OK, b""  # refresh, free data and everything else this fake does not model

    def _uid_of(self, user_id: str) -> int:
        for rec in self.users.values():
            parsed = self._parse(rec)
            if parsed["user_id"] == user_id:
                return parsed["uid"]
        return 0

    def _punch_record(self, index: int, punch: tuple[str, datetime, int]) -> bytes:
        user_id, at, status = punch
        return struct.pack("<H24sB4sB8s", self._uid_of(user_id), user_id.encode(), status, _encode_time(at), 1, b"")

    def _bad_punch_record(self) -> bytes:
        # day 31 of a 30-day month: the device's own 31-day months allow the encoding, the calendar does not
        stamp = struct.pack("<I", (((26 * 12 + 3) * 31) + 30) * 86400)  # 2026-04-31
        return struct.pack("<H24sB4sB8s", 1, b"1", 0, stamp, 1, b"")


class _Handler(socketserver.BaseRequestHandler):
    def handle(self):  # noqa: D401
        device: FakeDevice = self.server.device  # type: ignore[attr-defined]
        sock = self.request
        sock.settimeout(30)
        session = {"id": (int(time.time() * 1000) % 60000) + 1, "authed": False}

        def recv_exact(n: int) -> bytes:
            buf = b""
            while len(buf) < n:
                chunk = sock.recv(n - len(buf))
                if not chunk:
                    return b""
                buf += chunk
            return buf

        limit = device.refuse_connections_after
        if limit is not None and device.sessions >= limit:
            return
        while True:
            try:
                top = recv_exact(8)
                if not top:
                    return
                _m1, _m2, length = struct.unpack("<HHI", top)
                payload = recv_exact(length)
                if not payload:
                    return
            except OSError:
                return
            command, _check, _session, reply_id = struct.unpack("<4H", payload[:8])
            data = payload[8:]
            if device.mute:
                time.sleep(60)
                return
            answer = device.respond(command, data, session)
            if answer is DROP:
                return
            if answer is not None and device.truncate_reads and answer[0] == CMD_DATA and len(answer[1]) > 2000:
                head = struct.pack("<4H", answer[0], 0, session["id"], reply_id)
                packet = head + answer[1]
                frame = struct.pack("<HHI", 0x5050, 0x7D82, len(packet)) + packet
                try:
                    sock.sendall(frame[: len(frame) // 2])
                except OSError:
                    pass
                return
            if answer is None:
                self._send(sock, CMD_ACK_OK, b"", session["id"], reply_id)
                return
            self._send(sock, answer[0], answer[1], session["id"], reply_id)

    @staticmethod
    def _send(sock, code: int, data: bytes, session_id: int, reply_id: int) -> None:
        head = struct.pack("<4H", code, 0, session_id, reply_id)
        check = _checksum(head + data)
        packet = struct.pack("<4H", code, check, session_id, reply_id) + data
        try:
            sock.sendall(struct.pack("<HHI", 0x5050, 0x7D82, len(packet)) + packet)
        except OSError:  # the client hung up (it does not wait for the answer to its disconnect)
            pass


class _Server(socketserver.ThreadingTCPServer):
    allow_reuse_address = True
    daemon_threads = True


class FakeServer:
    """Serve one FakeDevice on a TCP port (0 = pick a free one). A context manager."""

    def __init__(self, device: FakeDevice, host: str = "127.0.0.1", port: int = 0):
        self.device = device
        self._server = _Server((host, port), _Handler)
        self._server.device = device  # type: ignore[attr-defined]
        self.host, self.port = self._server.server_address[0], self._server.server_address[1]
        self._thread = threading.Thread(target=lambda: self._server.serve_forever(poll_interval=0.02), daemon=True)

    def start(self) -> "FakeServer":
        self._thread.start()
        return self

    def stop(self) -> None:
        self._server.shutdown()
        self._server.server_close()

    def __enter__(self) -> "FakeServer":
        return self.start()

    def __exit__(self, *exc) -> None:
        self.stop()


# ── the Playwright process ──────────────────────────────────────────────────────────────────────────────────────────


def seed_devices(devices: list[FakeDevice]) -> None:
    """The fixed data the Playwright suite (frontend/e2e/device-control.spec.ts) expects. DC1001.. are employees that spec
    creates in the HRMS; DC9001 and DC9002 are on a device and in no HRMS."""
    today = datetime.now().replace(hour=9, minute=0, second=0, microsecond=0)
    for index, device in enumerate(devices):
        with device.lock:
            device.users.clear()
            device.punches.clear()
            device.commands.clear()
            device.enabled = True
            device.refuse_writes = False
            device.mute = False
            device.invalid_punch_dates = 0
            device.drop_after_writes = None
            device.ignore_privilege = False
            device.truncate_reads = False
            device.report_zero_users = False
            device._writes_done = 0
            if index == 0:
                device.add_user(1, "DC1001", "Asha Dev", privilege=14, card=555)
                device.add_user(2, "DC1002", "Ravi Dev")
                device.add_user(3, "DC1003", "Meena Dev")
                device.add_user(4, "DC9001", "Stranger One")
            elif index == 1:
                device.add_user(1, "DC1001", "ASHA DEV")
                device.add_user(2, "DC1002", "Ravi Dev")
                device.add_user(3, "DC9002", "Stranger Two")
            else:
                device.add_user(1, "DC1004", "Kumar Dev")
                device.add_user(2, "DC1006", "Old Inactive")
            device.faces = len(device.users)
        # a day's punches today and yesterday for three people on device 0 (the Data Fetch tests read these)
        if index == 0:
            for code in ("DC1001", "DC1002", "DC9001"):
                device.add_punch(code, today, 0)
                device.add_punch(code, today.replace(hour=18), 1)
                device.add_punch(code, today - timedelta(days=1), 0)
                device.add_punch(code, (today - timedelta(days=1)).replace(hour=18), 1)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--base-port", type=int, default=14371)
    parser.add_argument("--count", type=int, default=3)
    parser.add_argument("--control-port", type=int, default=14380)
    args = parser.parse_args()

    devices = [FakeDevice(serial=f"FAKE00000{i + 1}", name=f"x 2008 #{i + 1}") for i in range(args.count)]
    seed_devices(devices)
    servers = [FakeServer(d, port=args.base_port + i).start() for i, d in enumerate(devices)]

    class Control(BaseHTTPRequestHandler):
        def _json(self, payload, status=200):
            body = json.dumps(payload).encode()
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, *a):  # quiet
            pass

        def _index(self):
            parts = [p for p in self.path.split("?")[0].split("/") if p]
            return parts

        def do_GET(self):  # noqa: N802
            parts = self._index()
            if parts == ["health"]:
                return self._json({"ok": True, "devices": len(devices)})
            if len(parts) == 2 and parts[0] == "devices":
                return self._json(devices[int(parts[1])].snapshot())
            self._json({"error": "not found"}, 404)

        def do_POST(self):  # noqa: N802
            parts = self._index()
            length = int(self.headers.get("Content-Length") or 0)
            body = json.loads(self.rfile.read(length) or b"{}")
            if parts == ["reset"]:
                seed_devices(devices)
                return self._json({"ok": True})
            if len(parts) == 3 and parts[0] == "devices":
                device = devices[int(parts[1])]
                if parts[2] == "punch":
                    device.add_punch(body["userId"], datetime.fromisoformat(body["at"]), int(body.get("status", 0)))
                elif parts[2] == "flags":
                    for key in (
                        "refuse_writes",
                        "mute",
                        "invalid_punch_dates",
                        "drop_after_writes",
                        "ignore_privilege",
                        "truncate_reads",
                        "report_zero_users",
                    ):
                        if key in body:
                            setattr(device, key, body[key])
                else:
                    return self._json({"error": "not found"}, 404)
                return self._json({"ok": True})
            self._json({"error": "not found"}, 404)

    ThreadingHTTPServer(("127.0.0.1", args.control_port), Control).serve_forever()
    for s in servers:  # pragma: no cover
        s.stop()


if __name__ == "__main__":
    main()

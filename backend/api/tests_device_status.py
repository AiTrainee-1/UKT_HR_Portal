"""The Biometric Device Status page: what the ADMS listener records, what a connection check finds, how the two become
a verdict, and who may see or run any of it."""

import socket
import subprocess
from datetime import date, datetime, time, timedelta
from datetime import timezone as dt_timezone
from unittest import mock

from django.test import TestCase, override_settings
from django.utils import timezone

from . import device_diagnosis as diag
from . import device_probe as probe
from .clock import ist_today
from .device_health import (
    HEARTBEAT_FRESH_SECONDS,
    HEARTBEAT_WRITE_EVERY_SECONDS,
    connection_state,
    device_health,
    parse_options_body,
)
from .device_status import PROBE_HISTORY_KEEP, build_status, run_check
from .jwt_utils import sign_token
from .models import (
    AttendanceLog,
    AuditLog,
    BiometricDevice,
    BiometricProbe,
    BiometricUnknownPusher,
    Employee,
    HRUser,
    Role,
    UnmatchedPunch,
)

NOW = datetime(2026, 10, 6, 12, 0, tzinfo=dt_timezone.utc)
STATUS = "/api/attendance/biometric-status"


def make_device(name="Gate 1", host="192.168.0.59", serial="SN1", **kw):
    return BiometricDevice.objects.create(name=name, host=host, port=4370, serial_number=serial, **kw)


def ago(seconds=0, **kw):
    return NOW - timedelta(seconds=seconds, **kw)


def headers(super_admin=True, permissions=None, username="ds_user"):
    role = (
        Role.objects.create(name=f"role-{username}", permissions=permissions or {}) if permissions is not None else None
    )
    user = HRUser.objects.create(username=username, password_hash="x", is_super_admin=super_admin, role=role)
    return {"HTTP_AUTHORIZATION": f"Bearer {sign_token({'role': 'hr', 'hrUserId': user.id})}"}


# ─── is it connected? ─────────────────────────────────────────────────────────────────────────────────────────────────


class ConnectionStateTests(TestCase):
    def state(self, **fields):
        return connection_state(BiometricDevice(name="d", is_active=fields.pop("is_active", True), **fields), NOW)

    def test_a_switched_off_device_is_disabled_whatever_it_sent(self):
        self.assertEqual(self.state(is_active=False, last_heartbeat_at=ago(5)), "disabled")

    def test_a_device_never_heard_from_is_never(self):
        self.assertEqual(self.state(), "never")

    def test_a_device_that_polls_is_connected_for_three_minutes_after_its_last_poll(self):
        self.assertEqual(self.state(last_heartbeat_at=ago(HEARTBEAT_FRESH_SECONDS - 1)), "connected")
        self.assertEqual(self.state(last_heartbeat_at=ago(HEARTBEAT_FRESH_SECONDS + 1)), "disconnected")

    def test_a_device_that_polls_is_not_rescued_by_an_older_push(self):
        # it pushed an hour ago but stopped polling ten minutes ago: it has dropped off, a quiet hour does not explain it
        self.assertEqual(self.state(last_heartbeat_at=ago(600), last_push_at=ago(3600)), "disconnected")

    def test_a_device_that_does_not_poll_is_judged_by_its_last_push_over_six_hours(self):
        self.assertEqual(self.state(last_push_at=ago(hours=5)), "connected")
        self.assertEqual(self.state(last_push_at=ago(hours=7)), "disconnected")

    def test_a_device_that_stopped_polling_days_ago_falls_back_to_its_pushes(self):
        self.assertEqual(self.state(last_heartbeat_at=ago(hours=60), last_push_at=ago(hours=1)), "connected")

    def test_the_sync_indicator_uses_the_same_decision(self):
        d = make_device(last_heartbeat_at=timezone.now() - timedelta(seconds=20))
        silent = make_device("Gate 2", "192.168.0.60", "SN2", last_heartbeat_at=timezone.now() - timedelta(minutes=10))
        rows = {r["id"]: r for r in device_health()["devices"]}
        self.assertEqual(rows[d.id]["status"], "live")
        self.assertEqual(rows[silent.id]["status"], "silent")
        self.assertIn("lastContactAt", rows[d.id])


# ─── what the listener records ────────────────────────────────────────────────────────────────────────────────────────


class AdmsTelemetryTests(TestCase):
    def setUp(self):
        self.device = make_device()

    def refreshed(self):
        self.device.refresh_from_db()
        return self.device

    def test_a_poll_is_a_heartbeat_with_the_senders_address(self):
        r = self.client.get(
            "/iclock/getrequest", {"SN": "SN1"}, REMOTE_ADDR="10.0.0.1", HTTP_X_FORWARDED_FOR="203.0.113.7, 10.0.0.1"
        )
        self.assertEqual((r.status_code, r.content), (200, b"OK"))
        d = self.refreshed()
        self.assertIsNotNone(d.last_heartbeat_at)
        self.assertIsNone(d.last_push_at)  # a poll is not a push
        self.assertEqual(d.last_remote_ip, "203.0.113.7")

    def test_polls_are_written_at_most_every_half_minute(self):
        with mock.patch("django.utils.timezone.now", return_value=NOW):
            self.client.get("/iclock/getrequest", {"SN": "SN1"})
        with mock.patch(
            "django.utils.timezone.now", return_value=NOW + timedelta(seconds=HEARTBEAT_WRITE_EVERY_SECONDS - 5)
        ):
            self.client.get("/iclock/getrequest", {"SN": "SN1"})
        self.assertEqual(self.refreshed().last_heartbeat_at, NOW)
        with mock.patch(
            "django.utils.timezone.now", return_value=NOW + timedelta(seconds=HEARTBEAT_WRITE_EVERY_SECONDS + 5)
        ):
            self.client.get("/iclock/getrequest", {"SN": "SN1"})
        self.assertEqual(self.refreshed().last_heartbeat_at, NOW + timedelta(seconds=HEARTBEAT_WRITE_EVERY_SECONDS + 5))

    def test_the_handshake_is_a_push_and_a_heartbeat_and_keeps_what_the_device_says_about_itself(self):
        self.client.get(
            "/iclock/cdata", {"SN": "SN1", "pushver": "2.4.1", "language": "69", "junk": "x" * 500, "options": "all"}
        )
        d = self.refreshed()
        self.assertIsNotNone(d.last_push_at)
        self.assertIsNotNone(d.last_heartbeat_at)
        self.assertEqual(d.reported_config, {"pushver": "2.4.1", "language": "69"})  # whitelisted keys only

    def test_an_options_upload_adds_its_settings_trimmed(self):
        body = "~DeviceName=x 2008,IPAddress=192.168.0.59,GATEIPAddress=192.168.0.254,Secret=hunter2,MAC=" + "a" * 200
        self.client.post("/iclock/cdata?SN=SN1&table=options", body, content_type="text/plain")
        config = self.refreshed().reported_config
        self.assertEqual(config["IPAddress"], "192.168.0.59")
        self.assertEqual(config["GATEIPAddress"], "192.168.0.254")
        self.assertNotIn("Secret", config)
        self.assertEqual(len(config["MAC"]), 80)

    def test_parse_options_body_accepts_commas_lines_and_ampersands(self):
        self.assertEqual(parse_options_body("A=1,B=2\nC=3&D=4"), {"A": "1", "B": "2", "C": "3", "D": "4"})

    def test_attendance_data_stamps_when_it_arrived_and_the_newest_punch(self):
        Employee.objects.create(employee_code="E1", first_name="Asha", last_name="K")
        body = "E1\t2026-10-06 08:00:00\t255\t15\nE1\t2026-10-06 17:05:09\t255\t15\n"
        self.client.post("/iclock/cdata?SN=SN1&table=ATTLOG", body, content_type="text/plain")
        d = self.refreshed()
        self.assertIsNotNone(d.last_data_at)
        self.assertEqual((d.last_punch_date, d.last_punch_time), (date(2026, 10, 6), time(17, 5, 9)))
        self.assertEqual(d.last_error, "")
        self.assertEqual(AttendanceLog.objects.filter(source="biometric:adms:SN1").count(), 2)

    def test_an_older_push_does_not_move_the_newest_punch_back(self):
        Employee.objects.create(employee_code="E1", first_name="Asha", last_name="K")
        self.client.post(
            "/iclock/cdata?SN=SN1&table=ATTLOG", "E1\t2026-10-06 17:00:00\t255\t15\n", content_type="text/plain"
        )
        self.client.post(
            "/iclock/cdata?SN=SN1&table=ATTLOG", "E1\t2026-10-06 09:00:00\t255\t15\n", content_type="text/plain"
        )
        self.assertEqual(self.refreshed().last_punch_time, time(17, 0, 0))

    def test_lines_that_cannot_be_read_are_recorded_and_a_clean_push_clears_them(self):
        Employee.objects.create(employee_code="E1", first_name="Asha", last_name="K")
        self.client.post(
            "/iclock/cdata?SN=SN1&table=ATTLOG", "garbage\nE1\tnot-a-time\t255\n", content_type="text/plain"
        )
        d = self.refreshed()
        self.assertIn("2 attendance lines", d.last_error)
        self.assertIsNotNone(d.last_error_at)
        self.client.post(
            "/iclock/cdata?SN=SN1&table=ATTLOG", "E1\t2026-10-06 08:00:00\t255\t15\n", content_type="text/plain"
        )
        self.assertEqual(self.refreshed().last_error, "")

    def test_the_one_unlinked_device_gets_the_first_unknown_serial(self):
        BiometricDevice.objects.all().delete()
        waiting = make_device("New", "192.168.0.70", "")
        self.client.get("/iclock/getrequest", {"SN": "NEWSN"})
        waiting.refresh_from_db()
        self.assertEqual(waiting.serial_number, "NEWSN")
        self.assertFalse(BiometricUnknownPusher.objects.exists())

    def test_with_several_unlinked_devices_nothing_is_guessed_and_the_sender_is_listed_as_unknown(self):
        BiometricDevice.objects.all().delete()
        make_device("A", "192.168.0.70", "")
        make_device("B", "192.168.0.71", "")
        Employee.objects.create(employee_code="E1", first_name="Asha", last_name="K")
        self.client.get("/iclock/cdata", {"SN": "MYSTERY"}, REMOTE_ADDR="198.51.100.9")
        self.client.post(
            "/iclock/cdata?SN=MYSTERY&table=ATTLOG", "E1\t2026-10-06 08:00:00\t255\t15\n", content_type="text/plain"
        )
        self.assertFalse(BiometricDevice.objects.exclude(serial_number="").exists())
        unknown = BiometricUnknownPusher.objects.get(serial_number="MYSTERY")
        self.assertEqual((unknown.last_remote_ip, unknown.punch_count), ("198.51.100.9", 1))

    def test_a_failure_to_record_never_breaks_the_device_request(self):
        with mock.patch("api.device_health.BiometricDevice.objects.filter", side_effect=RuntimeError("db down")):
            r = self.client.get("/iclock/getrequest", {"SN": "SN1"})
        self.assertEqual(r.status_code, 200)


# ─── the connection check ─────────────────────────────────────────────────────────────────────────────────────────────


class FakeSocket:
    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False


class LowLevelProbeTests(TestCase):
    def test_hosts_that_could_be_read_as_options_are_refused(self):
        for bad in ("", "-f", "a b", "x;rm", "host/../", "a" * 300):
            self.assertFalse(probe.valid_host(bad), bad)
        for good in ("192.168.0.59", "device.factory.local", "api.uktextiles.in"):
            self.assertTrue(probe.valid_host(good), good)

    def test_private_addresses_are_recognised(self):
        self.assertTrue(probe.is_private_host("192.168.0.59"))
        self.assertTrue(probe.is_private_host("10.1.2.3"))
        self.assertFalse(probe.is_private_host("8.8.8.8"))
        self.assertFalse(probe.is_private_host("api.uktextiles.in"))

    def test_tcp_failures_are_told_apart(self):
        cases = [
            (socket.timeout("timed out"), probe.TIMEOUT),
            (ConnectionRefusedError(), probe.REFUSED),
            (OSError(113, "No route to host"), probe.UNREACHABLE),
            (OSError(10051, "network unreachable"), probe.UNREACHABLE),
            (OSError(5, "something else"), probe.ERROR),
        ]
        for exc, kind in cases:
            with mock.patch("socket.create_connection", side_effect=exc):
                ms, got, message = probe.tcp_connect("192.168.0.1", 4370)
            self.assertEqual((ms, got), (None, kind), exc)
            self.assertTrue(message)

    def test_a_tcp_success_has_a_time(self):
        with mock.patch("socket.create_connection", return_value=FakeSocket()):
            ms, kind, _ = probe.tcp_connect("192.168.0.1", 4370)
        self.assertIsNone(kind)
        self.assertGreaterEqual(ms, 0)

    def ping(self, stdout, returncode=0):
        done = subprocess.CompletedProcess(["ping"], returncode, stdout=stdout, stderr="")
        with mock.patch("subprocess.run", return_value=done):
            return probe.icmp_ping("192.168.0.59")

    def test_a_real_reply_is_read_on_windows_and_linux(self):
        self.assertEqual(
            self.ping("Reply from 192.168.0.59: bytes=32 time=12ms TTL=64"), {"available": True, "ok": True, "ms": 12.0}
        )
        self.assertEqual(
            self.ping("64 bytes from 192.168.0.59: icmp_seq=1 ttl=64 time=0.456 ms"),
            {"available": True, "ok": True, "ms": 0.456},
        )
        self.assertEqual(self.ping("Reply from 192.168.0.59: bytes=32 time<1ms TTL=64")["ms"], 1.0)

    def test_windows_destination_unreachable_is_not_a_reply_even_though_ping_exits_zero(self):
        out = "Reply from 192.168.0.56: Destination host unreachable."
        self.assertEqual(self.ping(out, returncode=0), {"available": True, "ok": False, "ms": None})

    def test_no_reply_and_no_ping_program_are_different_answers(self):
        self.assertEqual(self.ping("Request timed out.", returncode=1), {"available": True, "ok": False, "ms": None})
        with mock.patch("subprocess.run", side_effect=FileNotFoundError):
            self.assertEqual(probe.icmp_ping("192.168.0.59"), {"available": False, "ok": False, "ms": None})
        with mock.patch("subprocess.run", side_effect=subprocess.TimeoutExpired("ping", 5)):
            self.assertEqual(probe.icmp_ping("192.168.0.59"), {"available": True, "ok": False, "ms": None})


class FakeConnection:
    """What pyzk's connection offers, with the device's settings in a dict."""

    def __init__(self, options, time_=datetime(2026, 10, 6, 12, 0, 0), fail_on=()):
        self.options, self.time_, self.fail_on = options, time_, fail_on
        self.users, self.records = 510, 51102
        self._ZK__data = b""
        self.disconnected = False

    def _ZK__send_command(self, command, key, size):
        name = key.rstrip(b"\x00").decode()
        if name in self.fail_on:
            raise RuntimeError("device hiccup")
        if name not in self.options:
            return {"status": False}
        self._ZK__data = f"{name}={self.options[name]}".encode() + b"\x00"
        return {"status": True}

    def get_time(self):
        return self.time_

    def read_sizes(self):
        return None

    def disconnect(self):
        self.disconnected = True


GOOD_OPTIONS = {
    "~SerialNumber": "SN1",
    "~DeviceName": "x 2008",
    "IPAddress": "192.168.0.59",
    "NetMask": "255.255.255.0",
    "GATEIPAddress": "192.168.0.254",
    "DNS": "8.8.8.8",
    "DHCP": "0",
    "ICLOCKSVRURL": "api.uktextiles.in",
    "IclockSvrFun": "1",
    "EnableProxyServer": "0",
    "TZAdj": "330",
}


class ReadDeviceTests(TestCase):
    def read(self, conn, **kw):
        fake = mock.Mock()
        fake.return_value.connect.return_value = conn
        with mock.patch("zk.ZK", fake):
            return probe.read_device("192.168.0.59", 4370, 0, datetime(2026, 10, 6, 12, 0, 0), **kw)

    def test_the_devices_settings_are_read_and_typed(self):
        conn = FakeConnection({**GOOD_OPTIONS, "WebServerPort": "81", "DHCP": "1"})
        detail = self.read(conn)
        self.assertEqual(detail["serial"], "SN1")
        self.assertEqual(detail["gateway"], "192.168.0.254")
        self.assertIs(detail["dhcp"], True)
        self.assertIs(detail["admsEnabled"], True)
        self.assertIs(detail["proxyEnabled"], False)
        self.assertEqual((detail["serverPort"], detail["timeZoneMinutes"]), (81, 330))
        self.assertEqual((detail["users"], detail["records"]), (510, 51102))
        self.assertEqual(detail["clockSkewSeconds"], 0)
        self.assertTrue(conn.disconnected)

    def test_the_clock_skew_is_the_device_minus_the_server(self):
        conn = FakeConnection(GOOD_OPTIONS, time_=datetime(2026, 10, 6, 12, 7, 30))
        self.assertEqual(self.read(conn)["clockSkewSeconds"], 450)

    def test_one_setting_the_model_lacks_or_fails_on_does_not_lose_the_rest(self):
        conn = FakeConnection(GOOD_OPTIONS, fail_on=("DNS",))
        detail = self.read(conn)
        self.assertNotIn("dns", detail)
        self.assertEqual(detail["serial"], "SN1")

    def test_a_wrong_password_is_reported_as_one(self):
        from zk.exception import ZKErrorResponse

        fake = mock.Mock()
        fake.return_value.connect.side_effect = ZKErrorResponse("Unauthenticated")
        with mock.patch("zk.ZK", fake), self.assertRaises(probe.ProbeFailure) as caught:
            probe.read_device("192.168.0.59", 4370, 123, datetime(2026, 10, 6))
        self.assertEqual(caught.exception.status, probe.AUTH_FAILED)

    def test_a_handshake_that_fails_is_an_error_with_the_reason(self):
        from zk.exception import ZKNetworkError

        fake = mock.Mock()
        fake.return_value.connect.side_effect = ZKNetworkError("connection reset")
        with mock.patch("zk.ZK", fake), self.assertRaises(probe.ProbeFailure) as caught:
            probe.read_device("192.168.0.59", 4370, 0, datetime(2026, 10, 6))
        self.assertEqual(caught.exception.status, probe.ERROR)
        self.assertIn("connection reset", caught.exception.message)


class ProbeDeviceTests(TestCase):
    NOW_IST = datetime(2026, 10, 6, 12, 0, 0)
    PING_OK = {"available": True, "ok": True, "ms": 2.0}

    def probe(self, host="192.168.0.59", tcp=(5.0, None, ""), ping=None, read=None):
        read_patch = mock.patch(
            "api.device_probe.read_device",
            **({"side_effect": read} if isinstance(read, Exception) else {"return_value": read or {"serial": "SN1"}}),
        )
        with (
            mock.patch("api.device_probe.icmp_ping", return_value=ping or self.PING_OK),
            mock.patch("api.device_probe.tcp_connect", return_value=tcp),
            read_patch,
        ):
            return probe.probe_device(host, 4370, 0, self.NOW_IST)

    def steps(self, result):
        return {s["key"]: s["ok"] for s in result["steps"]}

    def test_a_device_that_answers_everything_is_reachable_with_its_settings(self):
        r = self.probe(read={"serial": "SN1", "gateway": "192.168.0.254"})
        self.assertEqual((r["status"], r["latencyMs"], r["detail"]["serial"]), ("reachable", 5.0, "SN1"))
        self.assertEqual(self.steps(r), {"address": True, "ping": True, "port": True, "device": True, "settings": True})

    def test_a_timeout_stops_at_the_port_step(self):
        r = self.probe(
            tcp=(None, probe.TIMEOUT, "No answer within 3 seconds"), ping={"available": True, "ok": False, "ms": None}
        )
        self.assertEqual(r["status"], "timeout")
        self.assertEqual(self.steps(r), {"address": True, "ping": False, "port": False})
        self.assertIn("3 seconds", r["error"])

    def test_a_closed_port_on_a_host_that_pings_is_refused_not_dead(self):
        r = self.probe(tcp=(None, probe.REFUSED, "refused"))
        self.assertEqual(r["status"], "refused")
        self.assertTrue(r["icmp"]["ok"])

    def test_a_wrong_password_is_auth(self):
        r = self.probe(read=probe.ProbeFailure(probe.AUTH_FAILED, "refused the communication password"))
        self.assertEqual((r["status"], self.steps(r)["device"]), ("auth", False))

    def test_no_ping_program_is_a_neutral_step_not_a_failure(self):
        r = self.probe(ping={"available": False, "ok": False, "ms": None})
        self.assertEqual(r["status"], "reachable")
        self.assertIsNone(self.steps(r)["ping"])

    def test_a_host_name_that_does_not_resolve_is_a_dns_failure(self):
        with mock.patch("socket.getaddrinfo", side_effect=socket.gaierror("nope")):
            r = probe.probe_device("device.factory.local", 4370, 0, self.NOW_IST)
        self.assertEqual(r["status"], "dns")
        self.assertIn("device.factory.local", r["error"])

    def test_a_host_name_that_resolves_is_checked_at_its_address(self):
        with mock.patch("socket.getaddrinfo", return_value=[(2, 1, 6, "", ("192.168.0.59", 4370))]):
            r = self.probe(host="device.factory.local")
        self.assertEqual(r["status"], "reachable")

    def test_an_invalid_host_is_reported_not_connected_to(self):
        with mock.patch("api.device_probe.tcp_connect") as tcp:
            r = probe.probe_device("-oProxy", 4370, 0, self.NOW_IST)
        self.assertEqual(r["status"], "error")
        tcp.assert_not_called()

    def test_an_unexpected_failure_is_reported_not_raised(self):
        r = self.probe(read=RuntimeError("boom"))
        self.assertEqual((r["status"], r["error"]), ("error", "boom"))


class RunChecksTests(TestCase):
    NOW_IST = datetime(2026, 10, 6, 12, 0, 0)

    def test_several_devices_are_checked_together_and_each_gets_its_own_result(self):
        results = {"192.168.0.1": {"status": "reachable"}, "192.168.0.2": {"status": "timeout"}}
        with mock.patch("api.device_probe.probe_device", side_effect=lambda host, *a: results[host]):
            out = probe.run_checks(
                [
                    {"id": 1, "host": "192.168.0.1", "port": 4370, "password": 0},
                    {"id": 2, "host": "192.168.0.2", "port": None, "password": 0},
                ],
                self.NOW_IST,
            )
        self.assertEqual({k: v["status"] for k, v in out.items()}, {1: "reachable", 2: "timeout"})

    def test_a_second_check_while_one_runs_is_refused(self):
        probe._run_lock.acquire()
        try:
            with self.assertRaises(probe.CheckBusy):
                probe.run_checks([{"id": 1, "host": "192.168.0.1", "port": 4370, "password": 0}], self.NOW_IST)
        finally:
            probe._run_lock.release()
        # and the lock is free again afterwards
        with mock.patch("api.device_probe.probe_device", return_value={"status": "reachable"}):
            probe.run_checks([{"id": 1, "host": "192.168.0.1", "port": 4370, "password": 0}], self.NOW_IST)

    def test_a_device_that_hangs_is_given_up_on_so_the_request_cannot_overrun(self):
        def slow(host, *a):
            if host == "192.168.0.2":
                import time as t

                t.sleep(1.0)
            return {"status": "reachable"}

        with (
            mock.patch("api.device_probe.probe_device", side_effect=slow),
            mock.patch.object(probe, "CHECK_BUDGET_SECONDS", 0.2),
        ):
            out = probe.run_checks(
                [
                    {"id": 1, "host": "192.168.0.1", "port": 4370, "password": 0},
                    {"id": 2, "host": "192.168.0.2", "port": 4370, "password": 0},
                ],
                self.NOW_IST,
            )
        self.assertEqual(out[1]["status"], "reachable")
        self.assertEqual(out[2]["status"], "timeout")
        self.assertIn("did not finish", out[2]["error"])
        self.assertFalse(probe._run_lock.locked())

    def test_a_probe_that_raises_becomes_an_error_result_for_that_device_only(self):
        def boom(host, *a):
            if host == "192.168.0.2":
                raise RuntimeError("kaboom")
            return {"status": "reachable"}

        with mock.patch("api.device_probe.probe_device", side_effect=boom):
            out = probe.run_checks(
                [
                    {"id": 1, "host": "192.168.0.1", "port": 4370, "password": 0},
                    {"id": 2, "host": "192.168.0.2", "port": 4370, "password": 0},
                ],
                self.NOW_IST,
            )
        self.assertEqual((out[1]["status"], out[2]["status"]), ("reachable", "error"))


# ─── the verdict ──────────────────────────────────────────────────────────────────────────────────────────────────────


def reached(detail=None, **kw):
    return {
        "status": "reachable",
        "latencyMs": 8.0,
        "error": "",
        "ageSeconds": 60,
        "detail": {**GOOD_DETAIL, **(detail or {})},
        **kw,
    }


GOOD_DETAIL = {
    "serial": "SN1",
    "ip": "192.168.0.59",
    "gateway": "192.168.0.254",
    "dns": "8.8.8.8",
    "dhcp": False,
    "serverUrl": "api.uktextiles.in",
    "serverPort": None,
    "admsEnabled": True,
    "timeZoneMinutes": 330,
    "clockSkewSeconds": 2,
}


def verdict(**ev):
    base = {
        "state": "never",
        "host": "192.168.0.59",
        "port": 4370,
        "serverOnCloud": True,
        "serverHost": "api.uktextiles.in",
    }
    return diag.diagnose({**base, **ev})


def states(v):
    return {layer["key"]: layer["state"] for layer in v["layers"]}


class DiagnosisTests(TestCase):
    def test_every_layer_is_always_reported_in_the_same_order(self):
        keys = [layer["key"] for layer in verdict()["layers"]]
        self.assertEqual(keys, ["device", "lan", "firewall", "port", "api", "railway", "ip_config", "timeout", "auth"])

    def test_a_connected_device_is_fine_everywhere(self):
        v = verdict(state="connected", lastContactAgeSeconds=12, remoteIp="203.0.113.7", pushDelaySeconds=4)
        self.assertEqual(set(states(v).values()), {"ok"})
        self.assertEqual(states(v)["firewall"], "ok")
        self.assertIn("203.0.113.7", [l for l in v["layers"] if l["key"] == "firewall"][0]["finding"])
        self.assertTrue(v["headline"].startswith("Connected"))
        self.assertEqual(v["problems"], [])

    def test_a_device_nobody_has_checked_says_what_to_do(self):
        v = verdict()
        self.assertIn("Nothing has been received", v["headline"])
        self.assertEqual(states(v)["device"], "unknown")

    def test_from_the_cloud_the_factory_network_cannot_be_judged_and_that_is_said(self):
        v = verdict(probe={"status": "timeout", "error": "No answer within 3 seconds", "ageSeconds": 5})
        self.assertEqual(states(v)["lan"], "na")
        self.assertEqual(states(v)["device"], "unknown")
        self.assertEqual(states(v)["timeout"], "problem")
        self.assertIn("cloud", [l for l in v["layers"] if l["key"] == "lan"][0]["finding"])

    def test_one_device_silent_while_others_answer_points_at_that_device_and_its_cable(self):
        v = verdict(
            serverOnCloud=False,
            serverHost="192.168.0.5:8000",
            probe={"status": "timeout", "error": "x", "ageSeconds": 5},
            lanAnyReachable=True,
        )
        self.assertEqual((states(v)["device"], states(v)["lan"]), ("problem", "problem"))

    def test_nothing_answering_on_a_local_server_blames_the_server_side_first(self):
        v = verdict(
            serverOnCloud=False,
            serverHost="localhost:8000",
            probe={"status": "timeout", "error": "x", "ageSeconds": 5},
            lanAnyReachable=False,
        )
        self.assertEqual(states(v)["lan"], "problem")
        self.assertEqual(states(v)["device"], "unknown")

    def test_a_device_with_no_dns_is_named_as_the_reason_it_never_finds_the_server(self):
        v = verdict(probe=reached({"dns": "0.0.0.0"}))
        self.assertEqual(states(v)["ip_config"], "problem")
        self.assertEqual(v["headlineLayer"], "ip_config")
        self.assertIn("DNS", v["headline"])
        self.assertIn("api.uktextiles.in", v["headline"])
        self.assertEqual(states(v)["firewall"], "warn")  # the firewall cannot be judged until this is fixed

    def test_a_device_with_no_gateway_cannot_leave_the_network(self):
        v = verdict(probe=reached({"gateway": "0.0.0.0"}))
        self.assertEqual(states(v)["ip_config"], "problem")
        self.assertIn("gateway", v["headline"])

    def test_a_device_sending_to_the_wrong_port_is_a_port_problem(self):
        v = verdict(probe=reached({"serverPort": 81}))
        self.assertEqual(states(v)["port"], "problem")
        self.assertIn("81", v["headline"])
        self.assertIn("443", v["headline"])

    def test_the_first_thing_to_fix_is_the_headline_and_all_problems_are_listed(self):
        v = verdict(probe=reached({"dns": "0.0.0.0", "serverPort": 81}))
        self.assertEqual(v["headlineLayer"], "ip_config")
        self.assertEqual(v["problems"], ["port", "ip_config"])

    def test_standard_server_ports_and_an_unset_port_are_fine(self):
        for port in (None, 80, 443):
            self.assertEqual(states(verdict(probe=reached({"serverPort": port})))["port"], "ok", port)

    def test_a_correctly_set_up_device_that_never_arrives_points_at_the_firewall(self):
        v = verdict(probe=reached())
        self.assertEqual(states(v)["firewall"], "problem")
        self.assertEqual(v["headlineLayer"], "firewall")
        self.assertIn("443", v["action"])

    def test_the_firewall_cannot_be_judged_without_the_devices_settings(self):
        self.assertEqual(states(verdict())["firewall"], "unknown")

    def test_a_refused_port_is_a_port_problem_and_the_device_is_on(self):
        v = verdict(probe={"status": "refused", "error": "refused", "ageSeconds": 5})
        self.assertEqual((states(v)["port"], states(v)["device"]), ("problem", "ok"))

    def test_a_wrong_comm_password_is_an_authentication_problem(self):
        v = verdict(probe={"status": "auth", "error": "x", "ageSeconds": 5})
        self.assertEqual(states(v)["auth"], "problem")
        self.assertIn("password", v["headline"].lower())

    def test_another_machine_at_the_address_is_caught_by_the_serial_number(self):
        v = verdict(configuredSerial="SN-OTHER", probe=reached())
        self.assertEqual(states(v)["auth"], "problem")
        self.assertIn("SN-OTHER", [l for l in v["layers"] if l["key"] == "auth"][0]["finding"])

    def test_cloud_push_switched_off_on_the_device_is_a_problem(self):
        self.assertEqual(states(verdict(probe=reached({"admsEnabled": False})))["auth"], "problem")

    def test_a_device_pointed_at_a_different_server_than_this_cloud_one_is_a_problem(self):
        v = verdict(probe=reached({"serverUrl": "old.example.com"}))
        self.assertEqual(states(v)["auth"], "problem")
        self.assertIn("old.example.com", v["headline"])

    def test_a_device_that_reports_its_ip_differently_from_settings_is_an_ip_config_problem(self):
        v = verdict(probe=reached({"ip": "192.168.0.60"}))
        self.assertEqual(states(v)["ip_config"], "problem")
        self.assertIn("192.168.0.60", v["headline"])

    def test_dhcp_is_a_warning_not_a_failure(self):
        self.assertEqual(states(verdict(state="connected", probe=reached({"dhcp": True})))["ip_config"], "warn")

    def test_a_wrong_time_zone_or_clock_is_a_warning(self):
        self.assertEqual(states(verdict(state="connected", probe=reached({"timeZoneMinutes": 300})))["auth"], "warn")
        late = states(verdict(state="connected", probe=reached({"clockSkewSeconds": 900})))
        self.assertEqual(late["auth"], "warn")

    def test_slow_connections_and_delayed_punches_are_warnings(self):
        self.assertEqual(states(verdict(state="connected", probe=reached(latencyMs=900.0)))["timeout"], "warn")
        slow = verdict(state="connected", lastContactAgeSeconds=5, pushDelaySeconds=1500)
        self.assertEqual(states(slow)["timeout"], "warn")
        self.assertIn("25 minutes", [l for l in slow["layers"] if l["key"] == "timeout"][0]["finding"])

    def test_a_local_server_cannot_judge_a_device_that_sends_to_the_deployed_one(self):
        v = verdict(serverOnCloud=False, serverHost="localhost:8000", probe=reached())
        self.assertEqual((states(v)["firewall"], states(v)["api"]), ("na", "na"))
        self.assertEqual(v["headlineLayer"], "railway")
        self.assertIn("api.uktextiles.in", v["headline"])
        self.assertEqual(states(v)["railway"], "na")

    def test_a_real_configuration_problem_still_shows_on_a_local_server(self):
        v = verdict(serverOnCloud=False, serverHost="localhost:8000", probe=reached({"dns": "0.0.0.0"}))
        self.assertEqual(v["headlineLayer"], "ip_config")

    def test_an_unreadable_push_is_an_api_problem_unless_the_device_is_connected(self):
        self.assertEqual(
            states(verdict(state="disconnected", lastError="2 attendance lines could not be read"))["api"], "problem"
        )
        self.assertEqual(
            states(verdict(state="connected", lastError="2 attendance lines could not be read"))["api"], "warn"
        )

    def test_a_device_that_was_connected_and_has_gone_quiet_says_since_when(self):
        v = verdict(state="disconnected", lastContactAgeSeconds=7200)
        self.assertEqual(states(v)["device"], "warn")
        self.assertIn("2 hours ago", v["headline"])

    def test_a_switched_off_device_is_not_judged(self):
        v = verdict(state="disabled")
        self.assertEqual(set(states(v).values()), {"na"})

    def test_what_the_device_reported_about_itself_is_used_when_no_check_has_read_it(self):
        v = verdict(reported={"GATEIPAddress": "0.0.0.0", "IPAddress": "192.168.0.59"})
        self.assertEqual(states(v)["ip_config"], "problem")


# ─── the whole payload ────────────────────────────────────────────────────────────────────────────────────────────────


@override_settings(ALLOWED_HOSTS=["*"])
class BuildStatusTests(TestCase):
    def setUp(self):
        self.now = timezone.now()
        self.emp = Employee.objects.create(employee_code="E1", first_name="Asha", last_name="K")

    def build(self, **env):
        from django.test import RequestFactory

        request = RequestFactory().get(STATUS, HTTP_HOST="api.uktextiles.in", HTTP_X_FORWARDED_PROTO="https")
        with mock.patch.dict("os.environ", env, clear=False):
            return build_status(request, now=self.now)

    def by_name(self, payload):
        return {d["name"]: d for d in payload["devices"]}

    def test_each_state_is_counted_and_labelled(self):
        make_device(
            "Live", "192.168.0.1", "S1", last_heartbeat_at=self.now - timedelta(seconds=20), last_push_at=self.now
        )
        make_device("Dropped", "192.168.0.2", "S2", last_heartbeat_at=self.now - timedelta(hours=2))
        make_device("New", "192.168.0.3", "S3")
        make_device("Off", "192.168.0.4", "S4", is_active=False)
        make_device(
            "Broken",
            "192.168.0.5",
            "S5",
            last_error="3 attendance lines in the last push could not be read",
            last_error_at=self.now - timedelta(minutes=5),
        )
        p = self.build()
        d = self.by_name(p)
        self.assertEqual(
            [d[n]["status"] for n in ("Live", "Dropped", "New", "Off", "Broken")],
            ["connected", "disconnected", "disconnected", "disabled", "error"],
        )
        self.assertTrue(d["New"]["neverConnected"])
        self.assertEqual(
            p["summary"],
            {
                "configured": 5,
                "enabled": 4,
                "connected": 1,
                "disconnected": 2,
                "error": 1,
                "unreachable": 0,
                "neverConnected": 2,
                "disabled": 1,
                "punchesToday": 0,
            },
        )

    def test_an_old_error_is_history_not_a_current_error(self):
        make_device(
            last_heartbeat_at=self.now - timedelta(hours=3), last_error="x", last_error_at=self.now - timedelta(days=2)
        )
        self.assertEqual(self.build()["devices"][0]["status"], "disconnected")

    def test_a_failed_pull_from_a_lan_device_is_not_an_error_but_a_wrong_password_is(self):
        make_device(
            "Lan",
            "192.168.0.1",
            "S1",
            last_sync_error="Could not reach device at 192.168.0.1:4370 -timed out.",
            last_sync_error_at=self.now,
        )
        make_device(
            "Pw",
            "192.168.0.2",
            "S2",
            last_sync_error="Could not connect to device: Unauthenticated",
            last_sync_error_at=self.now,
        )
        d = self.by_name(self.build())
        self.assertEqual((d["Lan"]["status"], d["Pw"]["status"]), ("disconnected", "error"))

    def test_todays_punches_are_credited_to_the_device_that_sent_them(self):
        a = make_device("Pushing", "192.168.0.1", "SNA")
        b = make_device("Pulled", "192.168.0.2", "SNB")
        today = ist_today()
        for i, source in enumerate(
            ["biometric:adms:SNA", "biometric:adms:SNA", "biometric:Pulled", "biometric:adms:OTHER", "manual"]
        ):
            AttendanceLog.objects.create(
                employee=self.emp, date=today, punch_time=time(8, i), punch_type="IN", source=source
            )
        AttendanceLog.objects.create(
            employee=self.emp,
            date=today - timedelta(days=1),
            punch_time=time(8, 0),
            punch_type="IN",
            source="biometric:adms:SNA",
        )
        d = self.by_name(self.build())
        self.assertEqual((d["Pushing"]["push"]["punchesToday"], d["Pulled"]["push"]["punchesToday"]), (2, 1))
        self.assertEqual(self.build()["summary"]["punchesToday"], 3)
        self.assertTrue(a and b)

    def test_how_long_punches_take_to_arrive_is_measured_per_device(self):
        d = make_device("Slow", "192.168.0.1", "SNS")
        stamp = timezone.now()
        local = stamp.astimezone(timezone.get_fixed_timezone(330)).replace(tzinfo=None)
        # a punch that happened 20 minutes before it arrived
        log = AttendanceLog.objects.create(
            employee=self.emp,
            date=(local - timedelta(minutes=20)).date(),
            punch_time=(local - timedelta(minutes=20)).time().replace(microsecond=0),
            punch_type="IN",
            source="biometric:adms:SNS",
        )
        AttendanceLog.objects.filter(pk=log.pk).update(created_at=stamp)
        self.now = stamp
        delay = self.by_name(self.build())["Slow"]["push"]["delay"]
        self.assertAlmostEqual(delay["medianSeconds"], 1200, delta=2)
        self.assertEqual((delay["samples"], delay["verdict"]), (1, "delayed"))
        self.assertTrue(d)

    def test_ids_with_no_employee_are_counted_per_device(self):
        make_device("Gate", "192.168.0.1", "SNG")
        UnmatchedPunch.objects.create(device_user_id="10426", device_serial="SNG", punch_count=7)
        UnmatchedPunch.objects.create(device_user_id="10495", device_serial="SNG", punch_count=3)
        UnmatchedPunch.objects.create(device_user_id="999", device_serial="SNG", punch_count=9, resolved=True)
        push = self.build()["devices"][0]["push"]
        self.assertEqual((push["skippedIds"], push["skippedPunches"]), (2, 10))

    def test_senders_nobody_configured_are_listed(self):
        BiometricUnknownPusher.objects.create(
            serial_number="MYSTERY",
            first_seen_at=self.now,
            last_seen_at=self.now,
            last_remote_ip="198.51.100.9",
            contact_count=4,
            punch_count=2,
        )
        unknown = self.build()["unknownPushers"]
        self.assertEqual(
            [(u["serialNumber"], u["lastRemoteIp"], u["punches"]) for u in unknown], [("MYSTERY", "198.51.100.9", 2)]
        )

    def test_the_server_says_what_a_device_must_be_told(self):
        s = self.build(RAILWAY_ENVIRONMENT="production", RAILWAY_GIT_COMMIT_SHA="abcdef1234567")["server"]
        self.assertEqual(
            (s["deployment"], s["host"], s["environment"], s["commit"]),
            ("railway", "api.uktextiles.in", "production", "abcdef1"),
        )
        self.assertEqual(s["deviceSettings"]["serverAddress"], "api.uktextiles.in")
        self.assertEqual((s["deviceSettings"]["serverPort"], s["deviceSettings"]["https"]), (443, True))
        self.assertIn("https://api.uktextiles.in/iclock/cdata", s["admsUrls"])

    def test_a_local_server_shows_the_address_the_devices_are_really_pointed_at(self):
        d = make_device()
        BiometricProbe.objects.create(device=d, checked_at=self.now, status="reachable", detail={**GOOD_DETAIL})
        with mock.patch.dict("os.environ", {}, clear=False):
            for key in ("RAILWAY_ENVIRONMENT", "RAILWAY_PROJECT_ID", "RAILWAY_SERVICE_ID"):
                import os

                os.environ.pop(key, None)
            settings = self.build()["server"]["deviceSettings"]
        self.assertEqual(
            (settings["serverAddress"], settings["serverPort"], settings["https"]), ("api.uktextiles.in", 443, True)
        )
        self.assertIn("local server", settings["note"])

    def test_a_server_that_is_not_on_railway_says_it_is_local(self):
        with mock.patch.dict("os.environ", {}, clear=False):
            for key in ("RAILWAY_ENVIRONMENT", "RAILWAY_PROJECT_ID", "RAILWAY_SERVICE_ID"):
                import os

                os.environ.pop(key, None)
            self.assertEqual(self.build()["server"]["deployment"], "local")

    def test_a_connection_check_shows_in_the_device_and_a_stale_one_is_not_used_as_evidence(self):
        d = make_device()
        BiometricProbe.objects.create(
            device=d,
            checked_at=self.now - timedelta(minutes=2),
            status="reachable",
            latency_ms=12.5,
            detail={**GOOD_DETAIL, "dns": "0.0.0.0"},
            steps=[{"key": "ping", "label": "Ping", "ok": True, "ms": 1.0, "note": ""}],
            icmp_ms=1.0,
        )
        row = self.build()["devices"][0]
        self.assertEqual((row["reach"], row["reachIsFresh"]), ("reachable", True))
        self.assertEqual(row["pull"]["probe"]["latencyMs"], 12.5)
        self.assertEqual(row["pull"]["probe"]["ping"], {"available": True, "ok": True, "ms": 1.0})
        self.assertEqual(row["diagnosis"]["headlineLayer"], "ip_config")
        BiometricProbe.objects.update(checked_at=self.now - timedelta(days=2))
        stale = self.build()["devices"][0]
        self.assertFalse(stale["reachIsFresh"])
        self.assertEqual(stale["reach"], "reachable")  # still shown...
        self.assertNotEqual(stale["diagnosis"]["headlineLayer"], "ip_config")  # ...but no longer a verdict

    def test_unreachable_devices_are_counted_without_being_called_errors(self):
        d = make_device()
        BiometricProbe.objects.create(
            device=d, checked_at=self.now, status="timeout", error="No answer within 3 seconds"
        )
        p = self.build()
        self.assertEqual((p["devices"][0]["status"], p["devices"][0]["reach"]), ("disconnected", "unreachable"))
        self.assertEqual((p["summary"]["unreachable"], p["summary"]["error"]), (1, 0))
        self.assertIs(p["server"]["canReachLan"], False)

    def test_an_empty_system_is_an_empty_payload(self):
        p = self.build()
        self.assertEqual((p["devices"], p["summary"]["configured"], p["server"]["canReachLan"]), ([], 0, None))


class RunCheckTests(TestCase):
    def setUp(self):
        self.device = make_device(connection_config={"password": 0})

    def check(self, result, ids=None):
        with mock.patch("api.device_status.run_checks", return_value={self.device.id: result}):
            return run_check(ids)

    def test_a_result_is_kept_and_a_device_that_answered_is_stamped_reachable(self):
        self.check(
            {
                "status": "reachable",
                "latencyMs": 9.0,
                "icmp": {"available": True, "ok": True, "ms": 1.0},
                "error": "",
                "detail": {"serial": "SN1"},
                "steps": [],
            }
        )
        saved = BiometricProbe.objects.get()
        self.assertEqual((saved.status, saved.latency_ms, saved.icmp_ms), ("reachable", 9.0, 1.0))
        self.device.refresh_from_db()
        self.assertIsNotNone(self.device.last_reachable_at)

    def test_a_failure_is_kept_without_stamping_the_device_reachable(self):
        self.check(
            {"status": "timeout", "latencyMs": None, "icmp": None, "error": "No answer", "detail": None, "steps": []}
        )
        self.device.refresh_from_db()
        self.assertIsNone(self.device.last_reachable_at)
        self.assertEqual(BiometricProbe.objects.get().error, "No answer")

    def test_only_the_latest_checks_of_a_device_are_kept(self):
        for _ in range(PROBE_HISTORY_KEEP + 5):
            self.check(
                {"status": "reachable", "latencyMs": 1.0, "icmp": None, "error": "", "detail": None, "steps": []}
            )
        self.assertEqual(BiometricProbe.objects.filter(device=self.device).count(), PROBE_HISTORY_KEEP)

    def test_a_comm_password_that_is_not_a_number_is_reported_without_connecting(self):
        self.device.connection_config = {"password": "abc"}
        self.device.save()
        with mock.patch("api.device_status.run_checks") as runner:
            out = run_check([self.device.id])
        runner.assert_not_called()
        self.assertEqual(out[self.device.id]["status"], "error")
        self.assertIn("not a number", out[self.device.id]["error"])

    def test_without_ids_only_enabled_devices_are_checked(self):
        off = make_device("Off", "192.168.0.9", "S9", is_active=False)
        with mock.patch("api.device_status.run_checks", return_value={}) as runner:
            run_check(None)
        self.assertEqual([t["id"] for t in runner.call_args.args[0]], [self.device.id])
        with mock.patch("api.device_status.run_checks", return_value={}) as runner:
            run_check([off.id])
        self.assertEqual([t["id"] for t in runner.call_args.args[0]], [off.id])


# ─── who can see it and run it ────────────────────────────────────────────────────────────────────────────────────────


class StatusEndpointTests(TestCase):
    def setUp(self):
        self.admin = headers(username="ds_admin")
        self.device = make_device(connection_config={"password": 0})

    def test_the_status_is_read_by_hr_and_never_contacts_a_device(self):
        with mock.patch("api.device_probe.probe_device") as contact, mock.patch("api.device_probe.tcp_connect") as tcp:
            r = self.client.get(STATUS, **self.admin)
        self.assertEqual(r.status_code, 200)
        contact.assert_not_called()
        tcp.assert_not_called()
        body = r.json()
        self.assertEqual([d["name"] for d in body["devices"]], ["Gate 1"])
        self.assertEqual(
            set(body), {"generatedAt", "server", "summary", "devices", "unknownPushers", "lastPunchAt", "thresholds"}
        )

    def test_it_needs_a_login_and_an_hr_account(self):
        self.assertEqual(self.client.get(STATUS).status_code, 401)
        employee = {"HTTP_AUTHORIZATION": f"Bearer {sign_token({'role': 'employee', 'employeeId': 1})}"}
        self.assertEqual(self.client.get(STATUS, **employee).status_code, 403)

    def test_a_role_that_may_only_view_attendance_sees_the_status_but_cannot_run_a_check(self):
        viewer = headers(super_admin=False, permissions={"attendance": "view"}, username="ds_viewer")
        self.assertEqual(self.client.get(STATUS, **viewer).status_code, 200)
        with mock.patch("api.device_status.run_checks") as runner:
            r = self.client.post(f"{STATUS}/check", {}, content_type="application/json", **viewer)
        self.assertEqual(r.status_code, 403)
        runner.assert_not_called()

    def test_a_role_without_attendance_sees_nothing(self):
        nobody = headers(super_admin=False, permissions={"leave": "edit"}, username="ds_nobody")
        self.assertEqual(self.client.get(STATUS, **nobody).status_code, 403)
        self.assertEqual(self.client.get(f"{STATUS}/{self.device.id}/history", **nobody).status_code, 403)

    def test_an_editor_can_run_a_check_and_it_is_audited(self):
        editor = headers(super_admin=False, permissions={"attendance": "edit"}, username="ds_editor")
        result = {
            "status": "reachable",
            "latencyMs": 3.0,
            "icmp": None,
            "error": "",
            "detail": {"serial": "SN1"},
            "steps": [],
        }
        with mock.patch("api.device_status.run_checks", return_value={self.device.id: result}):
            r = self.client.post(
                f"{STATUS}/check", {"deviceIds": [self.device.id]}, content_type="application/json", **editor
            )
        self.assertEqual(r.status_code, 200, r.content)
        body = r.json()
        self.assertEqual(body["ranDeviceIds"], [self.device.id])
        self.assertEqual(body["status"]["devices"][0]["reach"], "reachable")
        entry = AuditLog.objects.get(action="check", module="attendance")
        self.assertIn("1 device", entry.record_description)

    def test_a_check_with_no_ids_checks_every_enabled_device(self):
        with mock.patch(
            "api.device_status.run_checks",
            return_value={
                self.device.id: {
                    "status": "timeout",
                    "latencyMs": None,
                    "icmp": None,
                    "error": "x",
                    "detail": None,
                    "steps": [],
                }
            },
        ) as runner:
            r = self.client.post(f"{STATUS}/check", {}, content_type="application/json", **self.admin)
        self.assertEqual(r.status_code, 200)
        self.assertEqual(len(runner.call_args.args[0]), 1)

    def test_bad_ids_are_refused(self):
        post = lambda body: self.client.post(f"{STATUS}/check", body, content_type="application/json", **self.admin)  # noqa: E731
        self.assertEqual(post({"deviceIds": "all"}).status_code, 400)
        self.assertEqual(post({"deviceIds": ["x"]}).status_code, 400)
        self.assertEqual(post({"deviceIds": [999999]}).status_code, 404)

    def test_a_check_that_is_already_running_answers_409(self):
        with mock.patch("api.device_status_views.run_check", side_effect=probe.CheckBusy()):
            r = self.client.post(f"{STATUS}/check", {}, content_type="application/json", **self.admin)
        self.assertEqual(r.status_code, 409)
        self.assertIn("already running", r.json()["error"])

    def test_the_history_lists_the_latest_checks_first(self):
        for i, status in enumerate(["timeout", "reachable"]):
            BiometricProbe.objects.create(
                device=self.device,
                checked_at=timezone.now() - timedelta(minutes=10 - i),
                status=status,
                latency_ms=5.0 if status == "reachable" else None,
            )
        body = self.client.get(f"{STATUS}/{self.device.id}/history", **self.admin).json()
        self.assertEqual([c["status"] for c in body["checks"]], ["reachable", "timeout"])
        self.assertEqual(self.client.get(f"{STATUS}/999999/history", **self.admin).status_code, 404)


class SettingsSerialNumberTests(TestCase):
    """The serial number a device pushes under can be set in Settings → Devices, and two devices cannot share one."""

    def setUp(self):
        self.admin = headers(username="ds_settings")

    def create(self, **kw):
        return self.client.post(
            "/api/biometric-devices",
            {"name": "G", "host": "192.168.0.9", **kw},
            content_type="application/json",
            **self.admin,
        )

    def test_a_serial_is_saved_trimmed_and_returned(self):
        r = self.create(serialNumber="  CQIK1  ")
        self.assertEqual(r.status_code, 201, r.content)
        self.assertEqual(r.json()["serialNumber"], "CQIK1")
        self.assertEqual(BiometricDevice.objects.get().serial_number, "CQIK1")

    def test_two_devices_cannot_share_a_serial(self):
        self.create(serialNumber="CQIK1")
        again = self.create(serialNumber="CQIK1", name="H")
        self.assertEqual(again.status_code, 400)
        self.assertIn("already belongs", again.json()["error"])

    def test_editing_a_device_can_set_clear_and_keep_its_own_serial(self):
        d = make_device(serial="")
        url = f"/api/biometric-devices/{d.id}"
        put = lambda body: self.client.put(url, body, content_type="application/json", **self.admin)  # noqa: E731
        self.assertEqual(put({"serialNumber": "NEW1"}).json()["serialNumber"], "NEW1")
        self.assertEqual(
            put({"serialNumber": "NEW1", "name": "Renamed"}).status_code, 200
        )  # its own serial is not a clash
        self.assertEqual(put({"serialNumber": ""}).json()["serialNumber"], "")
        other = make_device("Other", "192.168.0.50", "TAKEN")
        self.assertEqual(put({"serialNumber": other.serial_number}).status_code, 400)

    def test_leaving_the_serial_out_of_an_edit_keeps_it(self):
        d = make_device(serial="KEEP")
        self.client.put(f"/api/biometric-devices/{d.id}", {"name": "X"}, content_type="application/json", **self.admin)
        d.refresh_from_db()
        self.assertEqual(d.serial_number, "KEEP")

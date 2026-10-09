"""Site Connectors, from the HRMS side: pairing, the connector's own endpoints, jobs and operations, devices read and changed
through a connector, manual and scheduled punch reads, and the overview.

The connector itself is a separate program. Here a simulated one stands in: it speaks the same HTTP protocol through the test
client and does the device work with this project's own device code against the fake terminals, so what is under test is the
server's half of the conversation."""

import json
from datetime import date, datetime, timedelta
from unittest import mock

from django.core.cache import cache
from django.db import connection
from django.db.models.signals import post_save
from django.test import TestCase, override_settings
from django.test.utils import CaptureQueriesContext
from django.utils import timezone

from . import connector_auth as ca
from . import device_directory as dd
from . import device_fetch as fetch
from . import device_remote as remote
from . import device_status
from .biometric_sync import BiometricSyncError, _ingest_punches, get_sync_targets
from .connector_auth import new_token, sha256
from .models import (
    Attendance,
    AttendanceLog,
    AuditLog,
    BiometricConnectorJob,
    BiometricConnectorPunch,
    BiometricDevice,
    BiometricDeviceOperation,
    BiometricDeviceUser,
    BiometricFetchRun,
    BiometricSiteConnector,
    Branch,
    Employee,
    UnmatchedPunch,
)
from .tests_device_control import WithDevices, hr_headers

BASE = "/api/attendance/device-control"
API = "/api/connector"


def make_connector(name="Site A", online=True, active=True):
    """A paired connector, and its plain token (which only the connector ever has)."""
    token = new_token()
    now = timezone.now()
    connector = BiometricSiteConnector.objects.create(
        name=name,
        token_hash=sha256(token),
        paired_at=now,
        last_seen_at=now if online else None,
        is_active=active,
    )
    return connector, token


class SimConnector:
    """A connector that lives inside the test: it polls, runs what it is given on the fake terminals and reports back."""

    def __init__(self, client, token, chunk=2):
        self.client = client
        self.token = token
        self.chunk = chunk
        self.cfg_hash = None
        self.config = None
        self.log = []

    def post(self, path, body=None):
        return self.client.post(
            f"{API}{path}",
            json.dumps(body or {}),
            content_type="application/json",
            HTTP_AUTHORIZATION=f"Bearer {self.token}",
        )

    def poll(self, want=4, status=None):
        r = self.post("/poll", {"cfgHash": self.cfg_hash, "want": want, "status": status})
        body = r.json()
        if r.status_code == 200 and body.get("config"):
            self.config, self.cfg_hash = body["config"], body["config"]["hash"]
        return r

    def run_once(self, want=4, status=None) -> int:
        r = self.poll(want, status)
        assert r.status_code == 200, r.content
        jobs = r.json()["jobs"]
        for job in jobs:
            self.execute(job)
        return len(jobs)

    def report(self, job, ok, data=None, code="", message=""):
        self.log.append((job["kind"], ok))
        return self.post(f"/jobs/{job['id']}/result", {"ok": ok, "code": code, "message": message, "data": data})

    def execute(self, job):
        from . import device_client as dc

        t = job["payload"]["target"]
        host, port, pw = t["host"], t["port"], t["password"]
        kind = job["kind"]
        if kind == "probe":
            return self.report(job, True, dc.timed_probe(host, port, pw))
        if kind == "read_users":
            r = dd._read_device(host, port, pw)
            if not r["ok"]:
                return self.report(job, False, code=r["code"], message=r["error"])
            return self.report(
                job, True, {"users": remote.encode_users(r["users"]), "capacity": r["capacity"], "ms": r["ms"]}
            )
        if kind in ("apply_users", "delete_users"):
            if kind == "apply_users":
                specs = [
                    dd.UserSpec(
                        user_id=s["userId"],
                        name=s["name"],
                        privilege=s["privilege"],
                        password=s["password"],
                        card=s["card"],
                        group=s["group"],
                    )
                    for s in job["payload"]["specs"]
                ]
                r = dd._apply_on_device(host, port, pw, specs, job["payload"]["mode"])
            else:
                r = dd._delete_on_device(host, port, pw, job["payload"]["userIds"])
            data = {k: v for k, v in r.items() if k not in ("ok", "code", "error", "users")}
            data["users"] = remote.encode_users(r["users"]) if r.get("users") is not None else None
            return self.report(job, r["ok"], data, code=r.get("code", ""), message=r.get("error", ""))
        if kind == "read_punches":
            since = date.fromisoformat(job["payload"]["since"]) if job["payload"]["since"] else None
            until = date.fromisoformat(job["payload"]["until"]) if job["payload"]["until"] else None
            r = fetch._read_punches(host, port, pw, since, until)
            if not r["ok"]:
                return self.report(job, False, code=r["code"], message=r["error"])
            rows = [{"userId": p.user_id, "at": p.at.isoformat(), "status": p.status} for p in r["punches"]]
            for seq, start in enumerate(range(0, len(rows), self.chunk), start=1):
                self.post(f"/jobs/{job['id']}/punches", {"seq": seq, "punches": rows[start : start + self.chunk]})
            return self.report(
                job, True, {"total": r["total"], "invalid": r["invalid"], "count": len(rows), "ms": r["ms"]}
            )
        raise AssertionError(f"unknown job {kind}")


class ConnectorBase(WithDevices):
    def setUp(self):
        cache.clear()
        self.admin, self.admin_user = hr_headers(username="cn_admin")
        self.connector, self.token = make_connector()
        self.sim = SimConnector(self.client, self.token)

    def get(self, path, headers=None):
        return self.client.get(f"{BASE}{path}", **(headers or self.admin))

    def post(self, path, body, headers=None):
        return self.client.post(f"{BASE}{path}", body, content_type="application/json", **(headers or self.admin))

    def remote_device(self, name="R1", fake=None, **fields):
        return self.add_device(name, fake, connector=self.connector, **fields)

    def finish(self, response):
        """The final answer of a request that may have gone to a connector: poll the operation after the sim ran."""
        assert response.status_code == 202, response.content
        op_id = response.json()["operation"]["id"]
        for _ in range(5):
            self.sim.run_once()
            body = self.get(f"/operations/{op_id}").json()
            if body["status"] != "running":
                return body
        raise AssertionError("the operation never finished")


# ─── pairing and credentials ────────────────────────────────────────────────────────────────────────────────────────────


@override_settings(ALLOWED_HOSTS=["*"])
class PairingTests(TestCase):
    def setUp(self):
        cache.clear()
        self.admin, _ = hr_headers(username="pair_admin")

    def create(self, name="Site A"):
        r = self.client.post(f"{BASE}/connectors", {"name": name}, content_type="application/json", **self.admin)
        self.assertEqual(r.status_code, 201, r.content)
        return r.json()

    def pair(self, code, **extra):
        return self.client.post(
            f"{API}/pair",
            {"code": code, "hostname": "FACTORY-PC", "version": "1.0.0", "os": "Windows 11", **extra},
            content_type="application/json",
        )

    def test_a_code_becomes_a_token_once(self):
        made = self.create()
        self.assertRegex(made["pairingCode"], r"^[A-Z2-9]{4}-[A-Z2-9]{4}$")
        self.assertEqual(made["connector"]["state"], "unpaired")
        r = self.pair(made["pairingCode"])
        self.assertEqual(r.status_code, 200, r.content)
        body = r.json()
        self.assertTrue(body["token"].startswith("ukt_"))
        self.assertEqual((body["name"], body["protocol"]), ("Site A", 1))
        row = BiometricSiteConnector.objects.get(pk=body["connectorId"])
        self.assertEqual(row.token_hash, sha256(body["token"]))
        self.assertNotIn(body["token"], row.token_hash)
        self.assertEqual((row.hostname, row.version, row.pairing_hash), ("FACTORY-PC", "1.0.0", ""))
        # the code does not work a second time
        again = self.pair(made["pairingCode"])
        self.assertEqual((again.status_code, again.json()["error"]), (400, "invalid_code"))

    def test_the_code_is_forgiving_about_how_it_is_typed(self):
        made = self.create()
        typed = made["pairingCode"].lower().replace("-", " ")
        self.assertEqual(self.pair(f"  {typed} ").status_code, 200)

    def test_a_wrong_or_expired_code_is_refused_the_same_way(self):
        made = self.create()
        self.assertEqual(self.pair("AAAA-AAAA").json()["error"], "invalid_code")
        self.assertEqual(self.pair("").json()["error"], "invalid_code")
        BiometricSiteConnector.objects.update(pairing_expires_at=timezone.now() - timedelta(minutes=1))
        self.assertEqual(self.pair(made["pairingCode"]).json()["error"], "invalid_code")

    def test_guessing_codes_is_throttled(self):
        statuses = [self.pair("AAAA-AAAA").status_code for _ in range(12)]
        self.assertEqual(statuses[:10], [400] * 10)
        self.assertEqual(statuses[10:], [429, 429])

    def test_a_switched_off_connector_cannot_pair(self):
        made = self.create()
        BiometricSiteConnector.objects.update(is_active=False)
        self.assertEqual(self.pair(made["pairingCode"]).json()["error"], "invalid_code")

    def test_a_new_code_pairs_again_and_the_old_token_stops_working(self):
        made = self.create()
        first = self.pair(made["pairingCode"]).json()
        again = self.client.post(
            f"{BASE}/connectors/{made['connector']['id']}/pairing", {}, content_type="application/json", **self.admin
        ).json()
        # until the new pairing is done the old token still works
        poll = lambda token: self.client.post(  # noqa: E731
            f"{API}/poll", {}, content_type="application/json", HTTP_AUTHORIZATION=f"Bearer {token}"
        )
        self.assertEqual(poll(first["token"]).status_code, 200)
        second = self.pair(again["pairingCode"]).json()
        self.assertEqual(poll(second["token"]).status_code, 200)
        self.assertEqual(poll(first["token"]).status_code, 401)

    def test_the_endpoints_refuse_a_missing_unknown_or_switched_off_token(self):
        c, token = make_connector("X")
        post = lambda auth: self.client.post(  # noqa: E731
            f"{API}/poll", {}, content_type="application/json", **({"HTTP_AUTHORIZATION": auth} if auth else {})
        )
        self.assertEqual(post(None).status_code, 401)
        self.assertEqual(post("Bearer nonsense").status_code, 401)
        self.assertEqual(post("Bearer " + token).status_code, 200)
        BiometricSiteConnector.objects.filter(pk=c.pk).update(is_active=False)
        r = post("Bearer " + token)
        self.assertEqual((r.status_code, r.json()["error"]), (403, "revoked"))
        # an HR login is not a connector token
        self.assertEqual(post(self.admin["HTTP_AUTHORIZATION"]).status_code, 401)


# ─── managing connectors ───────────────────────────────────────────────────────────────────────────────────────────────


@override_settings(ALLOWED_HOSTS=["*"])
class AdminTests(WithDevices):
    def setUp(self):
        cache.clear()
        self.admin, _ = hr_headers(username="adm_admin")

    def test_adding_a_connector_needs_a_name_and_a_unique_one(self):
        post = lambda body, h=None: self.client.post(  # noqa: E731
            f"{BASE}/connectors", body, content_type="application/json", **(h or self.admin)
        )
        self.assertEqual(post({"name": " "}).status_code, 400)
        self.assertEqual(post({"name": "x" * 81}).status_code, 400)
        self.assertEqual(post({"name": "Site A"}).status_code, 201)
        dup = post({"name": "Site  A"})
        self.assertEqual((dup.status_code, dup.json()["error"]), (400, "There is already a connector with that name."))
        self.assertTrue(AuditLog.objects.filter(module="attendance", record_description__contains="Site A").exists())

    def test_a_role_that_cannot_edit_settings_can_look_but_not_change(self):
        viewer, _ = hr_headers(super_admin=False, permissions={"attendance": "edit"}, username="adm_att")
        post = self.client.post(f"{BASE}/connectors", {"name": "Z"}, content_type="application/json", **viewer)
        self.assertEqual(post.status_code, 403)
        self.assertEqual(self.client.get(f"{BASE}/connectors", **viewer).status_code, 200)
        c, _t = make_connector("A")
        patch = self.client.patch(f"{BASE}/connectors/{c.pk}", {"name": "B"}, content_type="application/json", **viewer)
        self.assertEqual(patch.status_code, 403)
        self.assertEqual(self.client.delete(f"{BASE}/connectors/{c.pk}", **viewer).status_code, 403)

    def test_the_list_says_how_each_connector_and_its_devices_are_and_never_shows_a_secret(self):
        c, token = make_connector("Site A")
        dev, _fake = self.add_device("R1", connector=c)
        remote.merge_status(
            c.pk,
            devices={dev.pk: {"ok": True, "code": "ok", "error": "", "latencyMs": 12.0, "capacity": {"users": 5}}},
            sync={dev.pk: {"at": "2026-10-07T10:00:00", "ok": True, "created": 3}},
            outbox=0,
        )
        body = self.client.get(f"{BASE}/connectors", **self.admin).json()
        self.assertNotIn(token, json.dumps(body))
        self.assertNotIn(sha256(token), json.dumps(body))
        row = body["connectors"][0]
        self.assertEqual((row["name"], row["state"], row["paired"]), ("Site A", "online", True))
        self.assertEqual(row["devices"][0]["connected"], True)
        self.assertEqual(row["devices"][0]["sync"]["created"], 3)

    def test_the_state_follows_how_recently_it_was_heard_from(self):
        c, _t = make_connector("A")
        state = lambda: self.client.get(f"{BASE}/connectors", **self.admin).json()["connectors"][0]["state"]  # noqa: E731
        self.assertEqual(state(), "online")
        BiometricSiteConnector.objects.update(last_seen_at=timezone.now() - timedelta(minutes=5))
        self.assertEqual(state(), "offline")
        BiometricSiteConnector.objects.update(is_active=False)
        self.assertEqual(state(), "off")
        BiometricSiteConnector.objects.update(is_active=True, token_hash="", last_seen_at=None)
        self.assertEqual(state(), "unpaired")

    def test_changing_a_connector_checks_what_it_is_given(self):
        c, _t = make_connector("A")
        patch = lambda body: self.client.patch(  # noqa: E731
            f"{BASE}/connectors/{c.pk}", body, content_type="application/json", **self.admin
        )
        self.assertEqual(patch({"punchSyncMinutes": -1}).status_code, 400)
        self.assertEqual(patch({"punchSyncMinutes": "abc"}).status_code, 400)
        self.assertEqual(patch({"punchSyncDays": 0}).status_code, 400)
        self.assertEqual(patch({"punchSyncDays": 99}).status_code, 400)
        ok = patch({"punchSyncMinutes": 30, "punchSyncDays": 3, "notes": "Gate PC", "name": "Site B"})
        self.assertEqual(ok.status_code, 200, ok.content)
        c.refresh_from_db()
        self.assertEqual((c.punch_sync_minutes, c.punch_sync_days, c.name), (30, 3, "Site B"))
        make_connector("Taken")
        self.assertEqual(patch({"name": "Taken"}).status_code, 400)

    def test_switching_a_connector_off_ends_its_open_jobs_and_finishes_what_waited_for_them(self):
        c, _t = make_connector("A")
        dev, _fake = self.add_device("R1", connector=c)
        req = self.request(None)
        out = dd.start_refresh(req, [dev.pk])
        self.assertIn("operation", out)
        r = self.client.patch(
            f"{BASE}/connectors/{c.pk}", {"isActive": False}, content_type="application/json", **self.admin
        )
        self.assertEqual(r.status_code, 200)
        op = BiometricDeviceOperation.objects.get(pk=out["operation"]["id"])
        self.assertEqual(op.status, "done")
        self.assertFalse(op.final["results"][0]["ok"])
        self.assertEqual(op.final["results"][0]["code"], "revoked")

    def test_removing_a_connector_sends_its_devices_back_to_being_connected_directly(self):
        c, _t = make_connector("A")
        dev, _fake = self.add_device("R1", connector=c)
        r = self.client.delete(f"{BASE}/connectors/{c.pk}", **self.admin)
        self.assertEqual(r.status_code, 204)
        dev.refresh_from_db()
        self.assertIsNone(dev.connector_id)
        self.assertFalse(BiometricSiteConnector.objects.filter(pk=c.pk).exists())
        self.assertTrue(AuditLog.objects.filter(record_description__contains="connected directly: R1").exists())


# ─── the poll ───────────────────────────────────────────────────────────────────────────────────────────────────────────


@override_settings(ALLOWED_HOSTS=["*"])
class PollTests(ConnectorBase):
    def test_a_poll_shows_the_connector_is_there_and_gives_it_its_devices(self):
        dev, _fake = self.remote_device()
        BiometricDevice.objects.filter(pk=dev.pk).update(serial_number="SN-R1")
        other, _o = self.add_device("Direct")
        BiometricSiteConnector.objects.update(last_seen_at=timezone.now() - timedelta(hours=1))
        r = self.sim.poll(
            status={"version": "1.2.3", "hostname": "PC-9", "os": "Windows 11", "uptimeSeconds": 90, "outbox": 4}
        )
        self.assertEqual(r.status_code, 200)
        body = r.json()
        self.assertEqual([d["id"] for d in body["config"]["devices"]], [dev.pk])
        device = body["config"]["devices"][0]
        self.assertEqual(
            (device["host"], device["port"], device["password"], device["serialNumber"]),
            ("127.0.0.1", dev.port, 0, "SN-R1"),
        )
        self.assertEqual((body["config"]["punchSyncMinutes"], body["config"]["punchSyncDays"]), (15, 2))
        self.connector.refresh_from_db()
        self.assertGreater(self.connector.last_seen_at, timezone.now() - timedelta(minutes=1))
        self.assertEqual((self.connector.version, self.connector.hostname), ("1.2.3", "PC-9"))
        self.assertEqual((self.connector.status["uptimeSeconds"], self.connector.status["outbox"]), (90, 4))
        self.assertNotIn(other.pk, [d["id"] for d in body["config"]["devices"]])

    def test_the_settings_come_again_only_when_they_changed(self):
        dev, _fake = self.remote_device()
        self.assertIsNotNone(self.sim.poll().json()["config"])
        self.assertIsNone(self.sim.poll().json()["config"])
        BiometricDevice.objects.filter(pk=dev.pk).update(host="10.0.0.9")
        again = self.sim.poll().json()["config"]
        self.assertEqual(again["devices"][0]["host"], "10.0.0.9")
        self.connector.punch_sync_minutes = 5
        self.connector.save()
        self.assertEqual(self.sim.poll().json()["config"]["punchSyncMinutes"], 5)

    def test_what_it_reports_about_devices_is_kept_cut_down_and_only_for_its_own_devices(self):
        dev, _fake = self.remote_device()
        stranger, _s = self.add_device("Direct")
        self.sim.poll(
            status={
                "devices": {
                    str(dev.pk): {
                        "ok": True,
                        "code": "ok",
                        "latencyMs": 9,
                        "capacity": {"users": 7, "usersCap": 3000, "evil": "x" * 10, "records": 5},
                        "junk": 1,
                    },
                    str(stranger.pk): {"ok": True},
                    "abc": {"ok": True},
                    "999": "not a dict",
                },
                "sync": {str(dev.pk): {"ageSeconds": 120, "ok": True, "created": 2, "huge": {"a": 1}}},
            }
        )
        self.connector.refresh_from_db()
        report = self.connector.status["devices"]
        self.assertEqual(list(report), [str(dev.pk)])
        self.assertEqual(report[str(dev.pk)]["capacity"], {"users": 7, "usersCap": 3000, "records": 5})
        self.assertNotIn("junk", report[str(dev.pk)])
        kept = self.connector.status["sync"][str(dev.pk)]
        self.assertEqual({k: v for k, v in kept.items() if k != "at"}, {"ok": True, "created": 2})
        # the time is the server's own clock counted back from the report, not what the connector's clock said
        age = (timezone.now() - datetime.fromisoformat(kept["at"])).total_seconds()
        self.assertTrue(115 <= age <= 180, age)

    def test_a_poll_hands_out_the_oldest_waiting_jobs_up_to_the_number_asked_for_and_each_only_once(self):
        dev, _fake = self.remote_device()
        jobs = [remote.submit_job(dev, "probe") for _ in range(3)]
        first = self.sim.poll(want=2).json()["jobs"]
        self.assertEqual([j["id"] for j in first], [jobs[0].pk, jobs[1].pk])
        second = self.sim.poll(want=4).json()["jobs"]
        self.assertEqual([j["id"] for j in second], [jobs[2].pk])
        self.assertEqual(self.sim.poll(want=4).json()["jobs"], [])
        self.assertEqual(self.sim.poll(want=0).json()["jobs"], [])
        self.assertEqual(
            set(BiometricConnectorJob.objects.values_list("status", flat=True)), {BiometricConnectorJob.STATUS_RUNNING}
        )

    def test_a_job_carries_the_devices_address_and_comm_key_as_the_server_has_them(self):
        dev, _fake = self.remote_device()
        BiometricDevice.objects.filter(pk=dev.pk).update(connection_config={"password": 1234})
        dev.refresh_from_db()
        remote.submit_job(dev, "read_users")
        job = self.sim.poll().json()["jobs"][0]
        self.assertEqual(job["payload"]["target"], {"host": "127.0.0.1", "port": dev.port, "password": 1234})

    def test_a_connector_never_gets_another_connectors_jobs(self):
        dev, _fake = self.remote_device()
        other, other_token = make_connector("Site B")
        other_dev, _o = self.add_device("B1", connector=other)
        remote.submit_job(other_dev, "probe")
        self.assertEqual(self.sim.poll().json()["jobs"], [])
        theirs = SimConnector(self.client, other_token).poll().json()["jobs"]
        self.assertEqual(len(theirs), 1)
        job = BiometricConnectorJob.objects.get(pk=theirs[0]["id"])
        r = self.sim.post(f"/jobs/{job.pk}/result", {"ok": True, "data": {}})
        self.assertEqual(r.status_code, 404)
        self.assertEqual(self.sim.post(f"/jobs/{job.pk}/punches", {"seq": 1, "punches": []}).status_code, 404)

    def test_a_job_nobody_picked_up_in_time_is_not_handed_out_and_is_given_up_on(self):
        dev, _fake = self.remote_device()
        job = remote.submit_job(dev, "probe")
        BiometricConnectorJob.objects.filter(pk=job.pk).update(expires_at=timezone.now() - timedelta(seconds=1))
        self.assertEqual(self.sim.poll().json()["jobs"], [])
        job.refresh_from_db()
        self.assertEqual((job.status, job.error_code), ("expired", "expired"))
        self.assertEqual(job.payload, {})

    def test_a_job_taken_and_never_reported_is_failed_as_lost(self):
        dev, _fake = self.remote_device()
        job = remote.submit_job(dev, "apply_users", {"mode": "create", "specs": [{"userId": "1", "password": "1234"}]})
        self.sim.poll()
        BiometricConnectorJob.objects.filter(pk=job.pk).update(
            claimed_at=timezone.now()
            - timedelta(seconds=remote.RUNNING_SECONDS["apply_users"] + remote.RUNNING_GRACE_SECONDS + 5)
        )
        remote.expire_jobs()
        job.refresh_from_db()
        self.assertEqual((job.status, job.error_code), ("failed", "lost"))
        self.assertEqual(job.payload, {}, "the passwords it carried are gone")

    def test_a_result_is_taken_once_and_a_late_or_repeated_one_changes_nothing(self):
        dev, _fake = self.remote_device()
        job = remote.submit_job(dev, "probe")
        self.sim.poll()
        first = self.sim.post(f"/jobs/{job.pk}/result", {"ok": True, "data": {"ok": True, "code": "ok"}})
        self.assertEqual((first.status_code, first.json()["accepted"]), (200, True))
        second = self.sim.post(f"/jobs/{job.pk}/result", {"ok": False, "code": "x", "message": "late"})
        self.assertEqual((second.status_code, second.json()["accepted"]), (200, False))
        job.refresh_from_db()
        self.assertEqual(job.status, "succeeded")

    def test_a_result_that_is_not_in_the_expected_form_is_refused(self):
        dev, _fake = self.remote_device()
        job = remote.submit_job(dev, "read_users")
        self.sim.poll()
        self.assertEqual(self.sim.post(f"/jobs/{job.pk}/result", {"ok": True, "data": "text"}).status_code, 400)
        bad = self.sim.post(f"/jobs/{job.pk}/result", {"ok": True, "data": {"users": [{"nope": 1}]}})
        self.assertEqual(bad.status_code, 400)
        job.refresh_from_db()
        self.assertEqual(job.status, "running")


# ─── devices read and changed through a connector ──────────────────────────────────────────────────────────────────────


@override_settings(ALLOWED_HOSTS=["*"])
class RemoteOperationTests(ConnectorBase):
    def setUp(self):
        super().setUp()
        self.dev, self.fake = self.remote_device("R1")
        self.fake.add_user(1, "1001", "Asha K")
        self.fake.add_user(2, "1002", "Ravi S")
        self.asha = self.employee("1001", "Asha", "K")
        self.ravi = self.employee("1002", "Ravi", "S")

    def test_reading_users_waits_for_the_connector_and_then_fills_the_snapshot(self):
        r = self.post("/users/refresh", {"deviceIds": [self.dev.pk]})
        self.assertEqual(r.status_code, 202)
        op = r.json()["operation"]
        self.assertEqual(
            (op["status"], op["pending"][0]["deviceName"], op["pending"][0]["state"]), ("running", "R1", "waiting")
        )
        self.assertEqual(BiometricDeviceUser.objects.count(), 0, "nothing is read until the connector does it")
        self.sim.run_once()
        body = self.get(f"/operations/{op['id']}").json()
        self.assertEqual(body["status"], "done")
        self.assertEqual(
            body["final"]["results"],
            [
                {
                    "deviceId": self.dev.pk,
                    "deviceName": "R1",
                    "ok": True,
                    "count": 2,
                    "ms": body["final"]["results"][0]["ms"],
                }
            ],
        )
        self.assertEqual(sorted(BiometricDeviceUser.objects.values_list("user_id", flat=True)), ["1001", "1002"])
        self.dev.refresh_from_db()
        self.assertIsNotNone(self.dev.users_read_at)
        self.assertEqual(self.dev.capacity["users"], 2)

    def test_the_operation_says_what_it_is_waiting_for_and_when_the_connector_has_started(self):
        op = self.post("/users/refresh", {"deviceIds": [self.dev.pk]}).json()["operation"]
        self.sim.poll()  # takes the job, does not report
        body = self.get(f"/operations/{op['id']}").json()
        self.assertEqual(
            (body["status"], body["pending"][0]["state"], body["pending"][0]["connector"]),
            ("running", "working", "Site A"),
        )

    def test_a_user_is_added_through_the_connector_and_read_back(self):
        r = self.post(
            "/users/push", {"deviceIds": [self.dev.pk], "users": [{"userId": "2001", "name": "New Person", "card": 55}]}
        )
        body = self.finish(r)
        self.assertEqual(body["status"], "done")
        final = body["final"]
        self.assertEqual(final["summary"], {"added": 1, "updated": 0, "failed": 0})
        self.assertEqual(final["results"][0]["added"], ["2001"])
        self.assertEqual(self.fake.user("2001")["name"], "New Person")
        self.assertEqual(self.fake.user("2001")["card"], 55)
        self.assertTrue(BiometricDeviceUser.objects.filter(device=self.dev, user_id="2001").exists())
        self.assertTrue(AuditLog.objects.filter(action="create", record_description__contains="2001").exists())
        job = BiometricConnectorJob.objects.get(kind="apply_users")
        self.assertEqual(job.payload, {}, "a finished job keeps no passwords")

    def test_a_user_is_changed_and_only_the_fields_that_were_sent(self):
        body = self.finish(
            self.post(
                "/users/update", {"deviceIds": [self.dev.pk], "users": [{"userId": "1001", "name": "Asha Renamed"}]}
            )
        )
        self.assertEqual(body["final"]["summary"]["updated"], 1)
        self.assertEqual(self.fake.user("1001")["name"], "Asha Renamed")
        self.assertEqual(self.fake.user("1002")["name"], "Ravi S")

    def test_a_delete_through_the_connector_makes_the_employee_inactive_for_whoever_asked(self):
        body = self.finish(
            self.post("/users/delete", {"deviceIds": [self.dev.pk], "userIds": ["1002"], "markInactive": True})
        )
        final = body["final"]
        self.assertEqual(final["summary"], {"deleted": 1, "failed": 0, "madeInactive": 1})
        self.assertIsNone(self.fake.user("1002"))
        self.ravi.refresh_from_db()
        self.assertEqual(self.ravi.status, "inactive")
        self.assertEqual(Employee.objects.filter(pk=self.ravi.pk).count(), 1, "never deleted")
        self.assertTrue(AuditLog.objects.filter(action="delete", module="attendance").exists())

    def test_the_branch_rules_of_whoever_asked_still_apply_when_the_operation_finishes(self):
        mine = Branch.objects.create(name="Mine", code="CM1")
        theirs = Branch.objects.create(name="Theirs", code="CT1")
        Employee.objects.filter(pk=self.asha.pk).update(branch=mine)
        Employee.objects.filter(pk=self.ravi.pk).update(branch=theirs)
        scoped, _u = hr_headers(
            super_admin=False,
            permissions={"attendance": "edit", "employees": "edit"},
            username="cn_scoped",
            branch=mine,
        )
        r = self.post(
            "/users/delete",
            {"deviceIds": [self.dev.pk], "userIds": ["1001", "1002"], "markInactive": True},
            headers=scoped,
        )
        self.assertEqual(r.status_code, 202)
        op_id = r.json()["operation"]["id"]
        self.sim.run_once()
        # another branch's person was refused before anything was sent
        self.assertIsNotNone(self.fake.user("1002"))
        self.assertIsNone(self.fake.user("1001"))
        final = self.get(f"/operations/{op_id}", headers=scoped).json()["final"]
        self.assertEqual([x["userId"] for x in final["rejected"]], ["1002"])
        self.asha.refresh_from_db()
        self.ravi.refresh_from_db()
        self.assertEqual((self.asha.status, self.ravi.status), ("inactive", "active"))

    def test_a_branch_limited_caller_cannot_follow_someone_elses_operation(self):
        mine = Branch.objects.create(name="Mine2", code="CM2")
        scoped, _u = hr_headers(
            super_admin=False, permissions={"attendance": "edit"}, username="cn_scoped2", branch=mine
        )
        op_id = self.post("/users/refresh", {"deviceIds": [self.dev.pk]}).json()["operation"]["id"]
        self.assertEqual(self.get(f"/operations/{op_id}", headers=scoped).status_code, 404)
        self.assertEqual(self.get(f"/operations/{op_id}").status_code, 200)
        self.assertEqual(self.get("/operations/999999").status_code, 404)

    def test_direct_and_connector_devices_can_be_changed_together(self):
        direct, direct_fake = self.add_device("Direct")
        direct_fake.add_user(1, "1001", "Asha K")
        r = self.post(
            "/users/push", {"deviceIds": [direct.pk, self.dev.pk], "users": [{"userId": "3001", "name": "Both"}]}
        )
        self.assertEqual(r.status_code, 202)
        self.assertIsNotNone(direct_fake.user("3001"), "the direct device was done at once")
        self.assertIsNone(self.fake.user("3001"))
        body = self.finish(r)
        self.assertEqual(body["final"]["summary"]["added"], 2)
        self.assertEqual({e["deviceName"] for e in body["final"]["results"]}, {"Direct", "R1"})
        self.assertIsNotNone(self.fake.user("3001"))

    def test_only_direct_devices_are_still_answered_at_once(self):
        direct, direct_fake = self.add_device("Direct")
        r = self.post("/users/push", {"deviceIds": [direct.pk], "users": [{"userId": "3002", "name": "Now"}]})
        self.assertEqual(r.status_code, 200)
        self.assertNotIn("operation", r.json())

    def test_a_connector_that_is_off_or_not_answering_fails_at_once_with_the_reason_and_changes_nothing(self):
        BiometricSiteConnector.objects.update(last_seen_at=timezone.now() - timedelta(minutes=10))
        r = self.post("/users/push", {"deviceIds": [self.dev.pk], "users": [{"userId": "3003", "name": "X"}]})
        self.assertEqual(r.status_code, 200, "nothing to wait for")
        entry = r.json()["results"][0]
        self.assertEqual((entry["ok"], entry["code"]), (False, "connector_offline"))
        self.assertIn("Site A", entry["error"])
        self.assertIn("last heard from", entry["error"])
        self.assertFalse(BiometricConnectorJob.objects.exists())
        self.assertIsNone(self.fake.user("3003"))
        BiometricSiteConnector.objects.update(is_active=False)
        again = self.post("/users/refresh", {"deviceIds": [self.dev.pk]})
        self.assertEqual(again.json()["results"][0]["code"], "connector_off")

    def test_a_connector_that_never_answers_ends_the_operation_as_failed_not_as_waiting_for_ever(self):
        op = self.post("/users/delete", {"deviceIds": [self.dev.pk], "userIds": ["1001"]}).json()["operation"]
        BiometricConnectorJob.objects.update(expires_at=timezone.now() - timedelta(seconds=1))
        body = self.get(f"/operations/{op['id']}").json()
        self.assertEqual(body["status"], "done")
        entry = body["final"]["results"][0]
        self.assertEqual((entry["ok"], entry["code"]), (False, "expired"))
        self.assertIn("Nothing was changed", entry["error"])
        self.assertIsNotNone(self.fake.user("1001"))

    def test_a_job_that_was_taken_and_lost_says_the_device_may_have_been_changed(self):
        op = self.post("/users/delete", {"deviceIds": [self.dev.pk], "userIds": ["1001"], "markInactive": True}).json()[
            "operation"
        ]
        self.sim.poll()
        BiometricConnectorJob.objects.update(
            claimed_at=timezone.now()
            - timedelta(seconds=remote.RUNNING_SECONDS["delete_users"] + remote.RUNNING_GRACE_SECONDS + 5)
        )
        body = self.get(f"/operations/{op['id']}").json()
        entry = body["final"]["results"][0]
        self.assertEqual(entry["code"], "lost")
        self.assertIn("may or may not have been changed", entry["error"])
        self.asha.refresh_from_db()
        self.assertEqual(self.asha.status, "active", "nobody is made inactive on a guess")

    def test_a_failure_the_connector_reports_is_that_devices_failure_and_the_others_still_go_through(self):
        down, down_fake = self.remote_device("R2")
        down_fake.mute = True
        body = self.finish(
            self.post("/users/push", {"deviceIds": [self.dev.pk, down.pk], "users": [{"userId": "4001", "name": "X"}]})
        )
        by_name = {e["deviceName"]: e for e in body["final"]["results"]}
        self.assertTrue(by_name["R1"]["ok"])
        self.assertFalse(by_name["R2"]["ok"])
        self.assertIn(by_name["R2"]["code"], ("timeout", "protocol", "lost", "unreachable"))
        self.assertIsNotNone(self.fake.user("4001"))

    def test_a_partial_result_from_a_lost_connection_is_kept(self):
        self.fake.drop_after_writes = 1
        body = self.finish(
            self.post(
                "/users/push",
                {
                    "deviceIds": [self.dev.pk],
                    "users": [
                        {"userId": "5001", "name": "A"},
                        {"userId": "5002", "name": "B"},
                        {"userId": "5003", "name": "C"},
                    ],
                },
            )
        )
        entry = body["final"]["results"][0]
        self.assertFalse(entry["ok"])
        self.assertEqual({f["userId"] for f in entry["failed"]}, {"5001", "5002", "5003"})
        self.assertIsNotNone(self.fake.user("5001"))

    def test_two_reports_arriving_together_finish_the_operation_once(self):
        d2, f2 = self.remote_device("R2")
        f2.add_user(1, "1001", "Asha K")
        op = self.post("/users/refresh", {"deviceIds": [self.dev.pk, d2.pk]}).json()["operation"]
        jobs = self.sim.poll().json()["jobs"]
        for job in jobs:
            self.sim.execute(job)
        self.assertTrue(remote.maybe_finalize(op["id"]) is False, "already finished by the last report")
        self.assertEqual(BiometricDeviceOperation.objects.get(pk=op["id"]).status, "done")
        self.assertEqual(BiometricDeviceUser.objects.filter(device=d2).count(), 1)

    def test_an_old_finished_operation_is_cleaned_up_and_a_running_one_is_not(self):
        done = BiometricDeviceOperation.objects.create(kind="refresh", status="done")
        running = BiometricDeviceOperation.objects.create(kind="refresh", status="running")
        BiometricDeviceOperation.objects.update(created_at=timezone.now() - timedelta(days=30))
        remote.prune_operations()
        self.assertFalse(BiometricDeviceOperation.objects.filter(pk=done.pk).exists())
        self.assertTrue(BiometricDeviceOperation.objects.filter(pk=running.pk).exists())

    def test_a_comm_key_that_is_not_a_number_is_refused_before_a_job_is_made(self):
        BiometricDevice.objects.filter(pk=self.dev.pk).update(connection_config={"password": "abc"})
        r = self.post("/users/refresh", {"deviceIds": [self.dev.pk]})
        self.assertEqual(r.status_code, 200)
        self.assertEqual(r.json()["results"][0]["code"], "config")
        self.assertFalse(BiometricConnectorJob.objects.exists())

    def test_a_switched_off_device_is_not_changed_through_a_connector_either(self):
        BiometricDevice.objects.filter(pk=self.dev.pk).update(is_active=False)
        r = self.post("/users/push", {"deviceIds": [self.dev.pk], "users": [{"userId": "6001", "name": "X"}]})
        self.assertEqual(r.json()["results"][0]["code"], "disabled")
        self.assertFalse(BiometricConnectorJob.objects.exists())


# ─── the overview ───────────────────────────────────────────────────────────────────────────────────────────────────────


@override_settings(ALLOWED_HOSTS=["*"])
class OverviewTests(ConnectorBase):
    def setUp(self):
        super().setUp()
        self.dev, self.fake = self.remote_device("R1")

    def overview(self, fresh=False):
        r = self.get("/overview" + ("?fresh=1" if fresh else ""))
        self.assertEqual(r.status_code, 200, r.content)
        return r.json()

    def row(self, body):
        return next(d for d in body["devices"] if d["id"] == self.dev.pk)

    def test_a_device_behind_a_connector_shows_what_the_connector_reported_and_who_reaches_it(self):
        self.sim.poll(
            status={
                "devices": {
                    str(self.dev.pk): {
                        "ok": True,
                        "code": "ok",
                        "latencyMs": 8.5,
                        "capacity": {"users": 12, "usersCap": 3000},
                    }
                }
            }
        )
        row = self.row(self.overview())
        self.assertEqual(row["connection"]["state"], "connected")
        self.assertEqual(row["connection"]["latencyMs"], 8.5)
        self.assertEqual(row["via"], {"id": self.connector.pk, "name": "Site A", "online": True})
        self.assertEqual(row["capacity"]["users"], 12)

    def test_what_the_connector_cannot_reach_shows_with_its_reason(self):
        self.sim.poll(
            status={
                "devices": {
                    str(self.dev.pk): {"ok": False, "code": "timeout", "error": "The device stopped answering."}
                }
            }
        )
        row = self.row(self.overview())
        self.assertEqual((row["connection"]["state"], row["connection"]["code"]), ("disconnected", "timeout"))
        self.assertEqual(row["connection"]["reason"], "The device stopped answering.")

    def test_before_the_connector_has_checked_the_device_and_when_it_is_silent_the_page_says_why(self):
        row = self.row(self.overview())
        self.assertEqual(row["connection"]["code"], "pending")
        BiometricSiteConnector.objects.update(last_seen_at=timezone.now() - timedelta(minutes=10))
        row = self.row(self.overview())
        self.assertEqual(row["connection"]["code"], "connector_offline")
        self.assertIn("Site A", row["connection"]["reason"])
        self.assertFalse(row["via"]["online"])

    def test_a_fresh_check_asks_the_connector_to_look_once_and_its_answer_is_kept(self):
        self.overview(fresh=True)
        self.overview(fresh=True)
        self.assertEqual(BiometricConnectorJob.objects.filter(kind="probe").count(), 1, "not one per click")
        self.sim.run_once()
        row = self.row(self.overview())
        self.assertEqual(row["connection"]["state"], "connected")
        self.assertGreater(row["capacity"]["usersCap"], 0)
        self.assertEqual(BiometricConnectorJob.objects.get(kind="probe").status, "succeeded")

    def test_no_job_is_made_for_a_connector_that_is_not_there(self):
        BiometricSiteConnector.objects.update(last_seen_at=timezone.now() - timedelta(minutes=10))
        self.overview(fresh=True)
        self.assertFalse(BiometricConnectorJob.objects.exists())

    def test_a_switched_off_device_is_not_probed(self):
        BiometricDevice.objects.filter(pk=self.dev.pk).update(is_active=False)
        self.overview(fresh=True)
        self.assertFalse(BiometricConnectorJob.objects.exists())
        self.assertEqual(self.row(self.overview())["connection"]["state"], "disabled")


# ─── punches: a manual fetch, and the connector's own schedule ────────────────────────────────────────────────────────────


def at(day, hour=9, minute=0, second=0):
    return datetime(2026, 10, day, hour, minute, second)


@override_settings(ALLOWED_HOSTS=["*"])
class RemoteFetchTests(ConnectorBase):
    def setUp(self):
        super().setUp()
        self.dev, self.fake = self.remote_device("R1")
        self.asha = self.employee("1001", "Asha", "K")
        for uid, code in enumerate(("1001", "9001"), start=1):
            self.fake.add_user(uid, code, code)
        for day in (5, 6):
            self.fake.add_punch("1001", at(day, 9), 0)
            self.fake.add_punch("1001", at(day, 18), 1)
        self.fake.add_punch("9001", at(6, 9, 10), 0)

    def run_fetch(self, mode="update"):
        run = BiometricFetchRun.objects.create(
            mode=mode,
            status="running",
            started_by="Tester",
            range_label="Last 7 days",
            date_from=date(2026, 10, 1),
            date_to=date(2026, 10, 7),
            device_ids=[self.dev.pk],
            results=[{"deviceId": self.dev.pk, "deviceName": "R1", "status": "reading"}],
        )
        with mock.patch.object(fetch, "_idle", lambda seconds: self.sim.run_once()):
            fetch.execute_run(run.pk)
        run.refresh_from_db()
        return run, run.results[0]

    def test_a_preview_reads_through_the_connector_and_changes_nothing(self):
        run, result = self.run_fetch("preview")
        self.assertEqual(run.status, "done")
        self.assertEqual(
            (result["status"], result["inRange"], result["matched"], result["new"], result["created"]),
            ("done", 5, 4, 4, 0),
        )
        self.assertEqual(result["unmatchedIds"], 1)
        self.assertEqual(AttendanceLog.objects.count(), 0)
        self.assertFalse(BiometricConnectorPunch.objects.exists(), "the staged punches are removed")

    def test_an_update_writes_the_new_punches_once(self):
        run, result = self.run_fetch("update")
        self.assertEqual((result["created"], result["new"]), (4, 4))
        self.assertEqual(AttendanceLog.objects.filter(employee=self.asha).count(), 4)
        again_run, again = self.run_fetch("update")
        self.assertEqual((again["created"], again["alreadyInHrms"]), (0, 4))
        self.assertEqual(AttendanceLog.objects.filter(employee=self.asha).count(), 4)
        self.dev.refresh_from_db()
        self.assertIsNotNone(self.dev.last_synced_at)

    def test_a_connector_that_is_off_fails_that_device_only_and_the_run_ends(self):
        BiometricSiteConnector.objects.update(last_seen_at=timezone.now() - timedelta(minutes=10))
        run, result = self.run_fetch("preview")
        self.assertEqual((result["status"], result["code"]), ("failed", "connector_offline"))
        self.assertEqual(run.status, "failed")

    def test_a_device_the_connector_cannot_read_is_that_devices_failure(self):
        self.fake.mute = True
        run, result = self.run_fetch("preview")
        self.assertEqual(result["status"], "failed")
        self.assertEqual(run.status, "failed")

    def test_punches_that_did_not_all_arrive_are_not_written(self):
        job_data = {}

        def lossy(seconds):
            for job in self.sim.poll().json()["jobs"]:
                rows = [{"userId": "1001", "at": at(6, 9).isoformat(), "status": 0}]
                self.sim.post(f"/jobs/{job['id']}/punches", {"seq": 1, "punches": rows})
                self.sim.report(job, True, {"total": 5, "invalid": 0, "count": 5, "ms": 1})
                job_data["done"] = True

        run = BiometricFetchRun.objects.create(
            mode="update",
            status="running",
            started_by="T",
            range_label="x",
            date_from=None,
            date_to=None,
            device_ids=[self.dev.pk],
            results=[{"deviceId": self.dev.pk, "deviceName": "R1", "status": "reading"}],
        )
        with mock.patch.object(fetch, "_idle", lossy):
            fetch.execute_run(run.pk)
        run.refresh_from_db()
        self.assertEqual(run.results[0]["code"], "incomplete")
        self.assertEqual(AttendanceLog.objects.count(), 0)

    def test_a_resent_chunk_is_not_stored_twice(self):
        job = remote.submit_job(self.dev, "read_punches", {"since": None, "until": None})
        self.sim.poll()
        rows = [{"userId": "1001", "at": at(6, 9).isoformat(), "status": 0}]
        first = self.sim.post(f"/jobs/{job.pk}/punches", {"seq": 1, "punches": rows}).json()
        again = self.sim.post(f"/jobs/{job.pk}/punches", {"seq": 1, "punches": rows}).json()
        self.assertEqual((first["stored"], again["stored"]), (True, False))
        self.assertEqual(BiometricConnectorPunch.objects.filter(job=job).count(), 1)

    def test_punches_are_only_taken_for_a_job_that_is_waiting_for_them(self):
        job = remote.submit_job(self.dev, "read_punches", {"since": None, "until": None})
        rows = [{"userId": "1001", "at": at(6, 9).isoformat(), "status": 0}]
        self.assertEqual(
            self.sim.post(f"/jobs/{job.pk}/punches", {"seq": 1, "punches": rows}).status_code, 409, "not claimed yet"
        )
        self.sim.poll()
        for bad in (
            {"seq": 0, "punches": rows},
            {"seq": 1, "punches": "x"},
            {"seq": 1, "punches": [{"userId": "", "at": "2026-10-06T09:00:00"}]},
            {"seq": 1, "punches": [{"userId": "1", "at": "garbage"}]},
        ):
            self.assertEqual(self.sim.post(f"/jobs/{job.pk}/punches", bad).status_code, 400, bad)
        probe = remote.submit_job(self.dev, "probe")
        self.sim.poll()
        self.assertEqual(self.sim.post(f"/jobs/{probe.pk}/punches", {"seq": 1, "punches": rows}).status_code, 409)
        too_many = [{"userId": "1", "at": "2026-10-06T09:00:00", "status": 0}] * (remote.PUNCH_CHUNK_MAX + 1)
        self.assertEqual(self.sim.post(f"/jobs/{job.pk}/punches", {"seq": 1, "punches": too_many}).status_code, 400)


@override_settings(ALLOWED_HOSTS=["*"])
class ScheduledPunchTests(ConnectorBase):
    def setUp(self):
        super().setUp()
        self.dev, self.fake = self.remote_device("R1")
        self.asha = self.employee("1001", "Asha", "K")
        self.ravi = self.employee("1002", "Ravi", "S")

    def send(self, rows, device=None, **extra):
        return self.sim.post("/punches", {"deviceId": (device or self.dev).pk, "punches": rows, **extra})

    def row(self, code, when, status=0):
        return {"userId": code, "at": when.isoformat(), "status": status}

    def test_punches_are_written_to_the_hrms_like_a_manual_update(self):
        r = self.send(
            [
                self.row("1001", at(6, 9)),
                self.row("1001", at(6, 18), 1),
                self.row("1002", at(6, 9, 5)),
                self.row("7777", at(6, 9, 6)),
            ]
        )
        body = r.json()
        self.assertEqual(
            (r.status_code, body["created"], body["matched"], body["new"], body["unmatchedIds"]), (200, 3, 3, 3, 1)
        )
        logs = AttendanceLog.objects.filter(employee=self.asha).order_by("punch_time")
        self.assertEqual([(l.punch_type, l.source) for l in logs], [("IN", "biometric:R1"), ("OUT", "biometric:R1")])
        self.dev.refresh_from_db()
        self.assertIsNotNone(self.dev.last_synced_at)

    def test_reading_the_same_window_again_or_a_punch_the_device_also_pushed_adds_nothing(self):
        rows = [self.row("1001", at(6, 9)), self.row("1001", at(6, 18), 1)]
        self.send(rows)
        again = self.send(rows).json()
        self.assertEqual((again["created"], again["alreadyInHrms"]), (0, 2))
        AttendanceLog.objects.filter(employee=self.asha, punch_time=at(6, 9).time()).update(
            punch_type="OUT", source="biometric:adms"
        )
        pushed = self.send([self.row("1001", at(6, 9))]).json()
        self.assertEqual((pushed["created"], pushed["alreadyInHrms"]), (0, 1))
        self.assertEqual(AttendanceLog.objects.filter(employee=self.asha).count(), 2)

    def test_an_empty_read_is_a_sign_of_life_and_nothing_else(self):
        r = self.send([])
        self.assertEqual((r.status_code, r.json()["created"]), (200, 0))
        self.dev.refresh_from_db()
        self.assertIsNotNone(self.dev.last_synced_at)

    def test_only_its_own_devices_and_well_formed_punches_are_taken(self):
        other, _f = self.add_device("Direct")
        self.assertEqual(self.send([self.row("1001", at(6, 9))], device=other).status_code, 404)
        self.assertEqual(self.sim.post("/punches", {"punches": []}).status_code, 400)
        self.assertEqual(self.sim.post("/punches", {"deviceId": "x", "punches": []}).status_code, 400)
        self.assertEqual(self.send([{"userId": "1001", "at": "nope"}]).status_code, 400)
        self.assertEqual(self.send("text").status_code, 400)
        self.assertEqual(AttendanceLog.objects.count(), 0)

    def test_a_connector_that_is_switched_off_cannot_send_punches(self):
        BiometricSiteConnector.objects.update(is_active=False)
        self.assertEqual(self.send([self.row("1001", at(6, 9))]).status_code, 403)

    def test_inactive_employees_and_unknown_ids_are_not_recorded(self):
        Employee.objects.filter(pk=self.ravi.pk).update(status="inactive")
        body = self.send([self.row("1002", at(6, 9)), self.row("1001", at(6, 9))]).json()
        self.assertEqual((body["created"], body["unmatchedIds"]), (1, 1))


# ─── the Attendance page's own sync, and Settings → Devices ───────────────────────────────────────────────────────────────


@override_settings(ALLOWED_HOSTS=["*"])
class SyncAndSettingsTests(ConnectorBase):
    def test_the_attendance_pages_sync_leaves_connector_devices_to_their_connector(self):
        behind, _f = self.remote_device("Behind")
        direct, _d = self.add_device("Direct")
        self.assertEqual([t["id"] for t in get_sync_targets("all")], [direct.pk])
        self.assertEqual([t["id"] for t in get_sync_targets([direct.pk, behind.pk])], [direct.pk])
        for ask in (behind.pk, [behind.pk]):
            with self.assertRaises(BiometricSyncError) as caught:
                get_sync_targets(ask)
            self.assertIn("Site Connector", str(caught.exception))
            self.assertIn("Behind", str(caught.exception))

    def test_settings_devices_can_be_assigned_to_a_connector_and_back(self):
        make = self.client.post(
            "/api/biometric-devices",
            {"name": "Gate", "host": "192.168.0.5", "port": 4370, "connectorId": self.connector.pk},
            content_type="application/json",
            **self.admin,
        )
        self.assertEqual(make.status_code, 201, make.content)
        self.assertEqual(make.json()["connectorId"], self.connector.pk)
        pk = make.json()["id"]
        listed = self.client.get("/api/biometric-devices", **self.admin).json()
        self.assertEqual(next(d for d in listed if d["id"] == pk)["connectorId"], self.connector.pk)
        back = self.client.put(
            f"/api/biometric-devices/{pk}", {"connectorId": None}, content_type="application/json", **self.admin
        )
        self.assertEqual(back.json()["connectorId"], None)
        untouched = self.client.put(
            f"/api/biometric-devices/{pk}", {"name": "Gate 2"}, content_type="application/json", **self.admin
        )
        self.assertEqual(untouched.json()["connectorId"], None)
        again = self.client.put(
            f"/api/biometric-devices/{pk}",
            {"connectorId": self.connector.pk},
            content_type="application/json",
            **self.admin,
        )
        self.assertEqual(again.json()["connectorId"], self.connector.pk)

    def test_a_connector_that_does_not_exist_is_refused(self):
        bad = self.client.post(
            "/api/biometric-devices", {"name": "G", "connectorId": 99999}, content_type="application/json", **self.admin
        )
        self.assertEqual(bad.status_code, 400)
        worse = self.client.post(
            "/api/biometric-devices", {"name": "G", "connectorId": "abc"}, content_type="application/json", **self.admin
        )
        self.assertEqual(worse.status_code, 400)
        self.assertFalse(BiometricDevice.objects.filter(name="G").exists())


# ─── what the independent review found (the HRMS half) ─────────────────────────────────────────────────────────────────


class OneDevice(ConnectorBase):
    """A connector with one device (two people on it, and an employee for each), and shortcuts for the three-step dance."""

    def setUp(self):
        super().setUp()
        self.dev, self.fake = self.remote_device("R1")
        self.fake.add_user(1, "1001", "Asha K")
        self.fake.add_user(2, "1002", "Ravi S")
        self.asha = self.employee("1001", "Asha", "K")
        self.ravi = self.employee("1002", "Ravi", "S")

    def start_delete(self, mark=True, ids=("1002",)):
        r = self.post("/users/delete", {"deviceIds": [self.dev.pk], "userIds": list(ids), "markInactive": mark})
        self.assertEqual(r.status_code, 202, r.content)
        return r.json()["operation"]["id"]

    def claim(self):
        jobs = self.sim.poll().json()["jobs"]
        self.assertEqual(len(jobs), 1)
        return jobs[0]

    def age_running(self, kind, extra=5):
        """Make every running job look as if it was taken long enough ago to be given up on."""
        BiometricConnectorJob.objects.filter(status="running").update(
            claimed_at=timezone.now()
            - timedelta(seconds=remote.RUNNING_SECONDS[kind] + remote.RUNNING_GRACE_SECONDS + extra)
        )


@override_settings(ALLOWED_HOSTS=["*"])
class OperationRecoveryTests(OneDevice):
    def test_an_operation_whose_jobs_have_all_closed_is_finished_by_the_next_look_even_if_nobody_finished_it(self):
        op_id = self.start_delete()
        job = self.claim()
        with mock.patch.object(remote, "maybe_finalize", return_value=False):
            self.sim.execute(job)  # the worker "died" between closing the job and finishing the operation
        self.assertEqual(BiometricDeviceOperation.objects.get(pk=op_id).status, "running")
        body = self.get(f"/operations/{op_id}").json()
        self.assertEqual(body["status"], "done")
        self.assertEqual(body["final"]["summary"]["deleted"], 1)

    def test_the_same_is_done_by_the_connectors_next_poll_when_nobody_looks(self):
        op_id = self.start_delete()
        job = self.claim()
        with mock.patch.object(remote, "maybe_finalize", return_value=False):
            self.sim.execute(job)
        BiometricDeviceOperation.objects.filter(pk=op_id).update(created_at=timezone.now() - timedelta(minutes=2))
        self.sim.poll()
        self.assertEqual(BiometricDeviceOperation.objects.get(pk=op_id).status, "done")

    def test_a_device_deleted_while_an_operation_waits_does_not_leave_it_running_for_ever(self):
        op_id = self.start_delete()
        BiometricDevice.objects.filter(pk=self.dev.pk).delete()
        body = self.get(f"/operations/{op_id}").json()
        self.assertEqual(body["status"], "done")

    def test_a_finish_that_fails_undoes_what_it_had_done_and_says_what_the_devices_reported(self):
        op_id = self.start_delete()
        job = self.claim()

        def made_inactive_then_failed(request, removed_from):
            Employee.objects.filter(pk=self.ravi.pk).update(status="inactive")
            raise RuntimeError("boom")

        with mock.patch.object(dd, "_make_inactive", made_inactive_then_failed):
            self.sim.execute(job)
        op = BiometricDeviceOperation.objects.get(pk=op_id)
        self.assertEqual(op.status, "failed")
        self.assertIn("could not be finished", op.error)
        self.ravi.refresh_from_db()
        self.assertEqual(self.ravi.status, "active", "what the failed finish had done was undone")
        entry = AuditLog.objects.filter(record_description__contains="could not be recorded").first()
        self.assertIsNotNone(entry)
        self.assertIn("1 deleted", entry.record_description)

    def test_a_job_has_its_running_time_counted_from_when_it_was_taken_not_from_when_it_was_queued(self):
        job = remote.submit_job(self.dev, "apply_users", {"mode": "create", "specs": []})
        BiometricConnectorJob.objects.filter(pk=job.pk).update(created_at=timezone.now() - timedelta(minutes=30))
        self.sim.poll()  # taken just now, long after it was queued
        BiometricConnectorJob.objects.filter(pk=job.pk).update(expires_at=timezone.now() - timedelta(minutes=20))
        remote.expire_jobs()
        job.refresh_from_db()
        self.assertEqual(job.status, "running", "a connector that took it late still gets its full time")
        self.age_running("apply_users")
        remote.expire_jobs()
        job.refresh_from_db()
        self.assertEqual((job.status, job.error_code), ("failed", "lost"))

    def test_a_change_made_after_the_job_was_given_up_on_is_recorded_and_the_device_read_again(self):
        op_id = self.start_delete(mark=False)
        job = self.claim()
        self.age_running("delete_users")
        remote.expire_jobs()
        self.assertEqual(self.get(f"/operations/{op_id}").json()["final"]["results"][0]["code"], "lost")
        data = {"deleted": ["1002"], "users": [], "capacity": {"users": 1, "usersCap": 3000}}
        r = self.sim.post(f"/jobs/{job['id']}/result", {"ok": True, "data": data})
        self.assertEqual((r.status_code, r.json()["accepted"]), (200, False))
        self.assertTrue(
            AuditLog.objects.filter(record_description__contains="Late report from site connector").exists()
        )
        resync = BiometricConnectorJob.objects.filter(kind="read_users", operation__isnull=True)
        self.assertEqual(resync.count(), 1, "the device is read again")
        # what that read finds is kept as the device's users, though no operation waits for it
        self.sim.execute(self.claim())
        self.assertEqual(
            sorted(BiometricDeviceUser.objects.filter(device=self.dev).values_list("user_id", flat=True)),
            ["1001", "1002"],
        )
        again = self.sim.post(f"/jobs/{job['id']}/result", {"ok": True, "data": data})
        self.assertEqual(BiometricConnectorJob.objects.filter(kind="read_users", operation__isnull=True).count(), 1)
        self.assertEqual(again.status_code, 200)

    def test_switching_the_connector_off_while_a_job_runs_says_the_device_may_have_been_changed(self):
        op_id = self.start_delete()
        self.claim()
        self.client.patch(
            f"{BASE}/connectors/{self.connector.pk}", {"isActive": False}, content_type="application/json", **self.admin
        )
        entry = self.get(f"/operations/{op_id}").json()["final"]["results"][0]
        self.assertEqual(entry["code"], "lost")
        self.assertIn("may or may not have been changed", entry["error"])

    def test_two_changes_to_one_device_are_never_handed_out_together_or_while_another_runs(self):
        self.post("/users/delete", {"deviceIds": [self.dev.pk], "userIds": ["1001"]})
        self.post("/users/delete", {"deviceIds": [self.dev.pk], "userIds": ["1002"]})
        first = self.sim.poll(want=4).json()["jobs"]
        self.assertEqual(len(first), 1, "only one of the two changes")
        self.assertEqual(self.sim.poll(want=4).json()["jobs"], [], "and the second waits while the first runs")
        self.sim.execute(first[0])
        self.assertEqual(len(self.sim.poll(want=4).json()["jobs"]), 1)

    def test_reads_are_not_held_back_by_a_change_on_the_same_device(self):
        self.post("/users/delete", {"deviceIds": [self.dev.pk], "userIds": ["1001"]})
        remote.submit_job(self.dev, "probe")
        kinds = sorted(j["kind"] for j in self.sim.poll(want=4).json()["jobs"])
        self.assertEqual(kinds, ["delete_users", "probe"])

    def test_a_start_that_fails_part_way_leaves_nothing_behind(self):
        second, _f = self.remote_device("R2")
        real, calls = remote.submit_job, []

        def flaky(device, kind, payload=None, operation=None):
            calls.append(device.pk)
            if len(calls) == 2:
                raise RuntimeError("database hiccup")
            return real(device, kind, payload, operation)

        with mock.patch.object(remote, "submit_job", flaky), self.assertRaises(RuntimeError):
            remote.start_operation(
                self.request(),
                "refresh",
                {"deviceIds": [self.dev.pk, second.pk]},
                {},
                [(self.dev, "read_users", {}), (second, "read_users", {})],
            )
        self.assertFalse(BiometricDeviceOperation.objects.exists())
        self.assertFalse(BiometricConnectorJob.objects.exists())

    def test_the_users_a_finished_operation_read_are_not_kept_in_it(self):
        op_id = self.post("/users/refresh", {"deviceIds": [self.dev.pk]}).json()["operation"]["id"]
        self.sim.execute(self.claim())
        op = BiometricDeviceOperation.objects.get(pk=op_id)
        self.assertEqual(op.status, "done")
        self.assertTrue(all("users" not in r for r in op.results.values()))
        self.assertTrue(
            all("users" not in (j.result or {}) for j in BiometricConnectorJob.objects.filter(operation=op))
        )

    def test_old_operations_jobs_and_staged_punches_are_cleaned_up_by_the_polls_nobody_asked_for(self):
        old = BiometricDeviceOperation.objects.create(kind="refresh", status="done")
        job = remote.submit_job(self.dev, "read_punches", {"since": None, "until": None})
        BiometricConnectorPunch.objects.create(
            job=job, user_id="1001", punch_date=date(2026, 10, 6), punch_time=at(6, 9).time(), status=0
        )
        BiometricConnectorJob.objects.filter(pk=job.pk).update(status="succeeded")
        stamp = timezone.now() - timedelta(days=30)
        BiometricDeviceOperation.objects.filter(pk=old.pk).update(created_at=stamp)
        BiometricConnectorJob.objects.filter(pk=job.pk).update(created_at=stamp)
        cache.clear()
        self.sim.poll()
        self.assertFalse(BiometricDeviceOperation.objects.filter(pk=old.pk).exists())
        self.assertFalse(BiometricConnectorJob.objects.filter(pk=job.pk).exists())
        self.assertFalse(BiometricConnectorPunch.objects.exists())


@override_settings(ALLOWED_HOSTS=["*"])
class ResultTrustTests(OneDevice):
    def test_results_that_are_not_in_the_expected_form_are_refused_before_anything_is_changed(self):
        op_id = self.start_delete()
        job = self.claim()
        for bad in (
            {"deleted": "1002"},
            {"deleted": [1002]},
            {"deleted": ["1002"], "skipped": "x"},
            {"deleted": ["1002"], "capacity": "x"},
            {"deleted": ["1002"], "users": [{"nope": 1}]},
            {"deleted": ["1002"], "failed": [{"error": "no id"}]},
        ):
            r = self.sim.post(f"/jobs/{job['id']}/result", {"ok": True, "data": bad})
            self.assertEqual(r.status_code, 400, bad)
        self.assertEqual(BiometricConnectorJob.objects.get(pk=job["id"]).status, "running")
        self.assertEqual(BiometricDeviceOperation.objects.get(pk=op_id).status, "running")

    def test_a_read_that_says_it_worked_but_does_not_carry_the_users_cannot_wipe_the_snapshot(self):
        BiometricDeviceUser.objects.create(device=self.dev, uid=1, user_id="1001", name="Asha", read_at=timezone.now())
        self.post("/users/refresh", {"deviceIds": [self.dev.pk]})
        job = self.claim()
        for bad in ({}, {"users": []}, {"capacity": {}}, {"users": [], "capacity": "x"}):
            r = self.sim.post(f"/jobs/{job['id']}/result", {"ok": True, "data": bad})
            self.assertEqual(r.status_code, 400, bad)
        self.assertTrue(BiometricDeviceUser.objects.filter(device=self.dev, user_id="1001").exists())
        self.assertEqual(BiometricConnectorJob.objects.get(pk=job["id"]).status, "running")

    def test_what_a_result_says_about_people_nobody_asked_about_is_not_believed(self):
        other = self.employee("1003", "Other", "Person")
        op_id = self.start_delete(mark=True, ids=("1002",))
        job = self.claim()
        data = {
            "deleted": ["1002", "1003"],
            "absent": ["1001"],
            "users": [],
            "capacity": {"users": 0, "usersCap": 3000},
        }
        self.assertEqual(self.sim.post(f"/jobs/{job['id']}/result", {"ok": True, "data": data}).status_code, 200)
        entry = self.get(f"/operations/{op_id}").json()["final"]["results"][0]
        self.assertEqual((entry["deleted"], entry["absent"]), (["1002"], []))
        for emp, status in ((self.asha, "active"), (other, "active"), (self.ravi, "inactive")):
            emp.refresh_from_db()
            self.assertEqual(emp.status, status, emp.employee_code)

    def test_a_user_said_to_be_deleted_who_is_still_in_the_list_the_device_returned_is_not_deleted(self):
        op_id = self.start_delete()
        job = self.claim()
        still = {
            "uid": 2,
            "userId": "1002",
            "name": "Ravi",
            "privilege": 0,
            "card": 0,
            "hasPassword": False,
            "group": "",
        }
        data = {"deleted": ["1002"], "users": [still], "capacity": {"users": 1, "usersCap": 3000}}
        self.sim.post(f"/jobs/{job['id']}/result", {"ok": True, "data": data})
        self.assertEqual(self.get(f"/operations/{op_id}").json()["final"]["results"][0]["deleted"], [])
        self.ravi.refresh_from_db()
        self.assertEqual(self.ravi.status, "active")

    def test_an_add_is_only_believed_for_the_users_that_were_asked_for(self):
        r = self.post("/users/push", {"deviceIds": [self.dev.pk], "users": [{"userId": "2001", "name": "New"}]})
        op_id = r.json()["operation"]["id"]
        job = self.claim()
        data = {"added": ["2001", "9999"], "updated": ["1001"], "users": [], "capacity": {"users": 0, "usersCap": 3000}}
        self.sim.post(f"/jobs/{job['id']}/result", {"ok": True, "data": data})
        entry = self.get(f"/operations/{op_id}").json()["final"]["results"][0]
        self.assertEqual((entry["added"], entry["updated"]), (["2001"], []))


@override_settings(ALLOWED_HOSTS=["*"])
class ReportTrustTests(OneDevice):
    def overview_row(self):
        r = self.get("/overview")
        self.assertEqual(r.status_code, 200, r.content)
        return next(d for d in r.json()["devices"] if d["id"] == self.dev.pk)

    def test_a_status_with_an_odd_clock_or_capacity_cannot_break_the_overview(self):
        self.sim.poll(
            status={
                "devices": {
                    str(self.dev.pk): {
                        "ok": True,
                        "code": "ok",
                        "deviceTime": "2026-10-09T09:00:00+05:30",
                        "capacity": "x",
                        "latencyMs": "fast",
                    }
                }
            }
        )
        row = self.overview_row()
        self.assertEqual(row["connection"]["state"], "connected")
        self.assertIsNone(row["connection"]["latencyMs"])

    def test_a_probe_result_goes_through_the_same_cleaning(self):
        job = remote.submit_job(self.dev, "probe")
        self.sim.poll()
        data = {"ok": True, "code": "ok", "capacity": {"users": 3, "evil": "x" * 5000}, "deviceTime": "garbage"}
        self.assertEqual(self.sim.post(f"/jobs/{job.pk}/result", {"ok": True, "data": data}).status_code, 200)
        self.connector.refresh_from_db()
        report = self.connector.status["devices"][str(self.dev.pk)]
        self.assertEqual(report["capacity"], {"users": 3})
        self.assertIsNone(report["deviceTime"])
        self.assertEqual(self.get("/overview").status_code, 200)

    def test_a_report_the_connector_has_stopped_refreshing_is_not_how_the_device_is(self):
        self.sim.poll(status={"devices": {str(self.dev.pk): {"ok": True, "code": "ok", "ageSeconds": 900}}})
        row = self.overview_row()
        self.assertEqual(row["connection"]["code"], "pending")
        self.assertIn("has not checked this device for", row["connection"]["reason"])
        self.sim.poll(status={"devices": {str(self.dev.pk): {"ok": True, "code": "ok", "ageSeconds": 5}}})
        self.assertEqual(self.overview_row()["connection"]["state"], "connected")

    def test_the_time_of_a_report_is_the_servers_not_the_connectors(self):
        self.sim.poll(
            status={"devices": {str(self.dev.pk): {"ok": True, "code": "ok", "checkedAt": "1999-01-01T00:00:00"}}}
        )
        self.assertEqual(self.overview_row()["connection"]["state"], "connected")

    def test_biometric_device_status_does_not_call_a_connector_device_unreachable_for_being_behind_one(self):
        out = device_status.run_check([self.dev.pk])
        self.assertEqual(out[self.dev.pk]["status"], "error", "not checked yet is not 'unreachable'")
        self.sim.poll(
            status={"devices": {str(self.dev.pk): {"ok": True, "code": "ok", "latencyMs": 9, "capacity": {"users": 1}}}}
        )
        with mock.patch.object(device_status, "run_checks", side_effect=AssertionError("the server must not probe it")):
            out = device_status.run_check([self.dev.pk])
        self.assertEqual(out[self.dev.pk]["status"], "reachable")
        self.dev.refresh_from_db()
        self.assertIsNotNone(self.dev.last_reachable_at)

    def test_a_stale_report_is_not_stamped_as_the_device_having_been_reachable_just_now(self):
        self.sim.poll(status={"devices": {str(self.dev.pk): {"ok": True, "code": "ok", "ageSeconds": 900}}})
        device_status.run_check([self.dev.pk])
        self.dev.refresh_from_db()
        self.assertIsNone(self.dev.last_reachable_at)


@override_settings(ALLOWED_HOSTS=["*"])
class ConnectorRequestTests(OneDevice):
    def raw(self, path, body, **extra):
        return self.client.post(
            f"{API}{path}", body, content_type="application/json", HTTP_AUTHORIZATION=f"Bearer {self.token}", **extra
        )

    def test_a_body_that_is_too_large_is_refused_before_it_is_read(self):
        big = json.dumps({"status": {"version": "x" * 3_300_000}})
        self.assertEqual(self.raw("/poll", big).status_code, 413)

    def test_a_json_list_instead_of_an_object_is_never_a_server_error(self):
        job = remote.submit_job(self.dev, "read_punches", {"since": None, "until": None})
        self.sim.poll()
        for path in ("/poll", f"/jobs/{job.pk}/punches", "/punches", f"/jobs/{job.pk}/result"):
            self.assertLess(self.raw(path, "[1, 2]").status_code, 500, path)
        paired = self.client.post(f"{API}/pair", "[1, 2]", content_type="application/json")
        self.assertEqual(paired.status_code, 400)

    def test_the_pairing_throttle_cannot_be_beaten_by_writing_a_different_address_each_time(self):
        statuses = [
            self.client.post(
                f"{API}/pair",
                {"code": "AAAA-AAAA"},
                content_type="application/json",
                HTTP_X_FORWARDED_FOR=f"6.6.6.{i}, 203.0.113.9",
            ).status_code
            for i in range(12)
        ]
        self.assertEqual(statuses[:10], [400] * 10)
        self.assertEqual(statuses[10:], [429, 429])

    def test_a_pairing_code_is_kept_as_a_keyed_hash_and_pairing_is_audited(self):
        made = self.client.post(
            f"{BASE}/connectors", {"name": "cn_keyed"}, content_type="application/json", **self.admin
        ).json()
        row = BiometricSiteConnector.objects.get(pk=made["connector"]["id"])
        self.assertNotEqual(
            row.pairing_hash, sha256(ca.normalize_code(made["pairingCode"])), "not a plain hash of a code"
        )
        self.assertEqual(row.pairing_hash, ca.pairing_digest(made["pairingCode"]))
        paired = self.client.post(
            f"{API}/pair", {"code": made["pairingCode"], "hostname": "PC-7"}, content_type="application/json"
        )
        self.assertEqual(paired.status_code, 200, paired.content)
        self.assertTrue(AuditLog.objects.filter(record_description__contains="“cn_keyed” was paired").exists())

    def test_a_branch_limited_user_sees_that_connectors_exist_but_not_where_they_are_and_cannot_change_them(self):
        mine = Branch.objects.create(name="Mine", code="RB1")
        scoped, _u = hr_headers(
            super_admin=False,
            permissions={"attendance": "edit", "settings": "edit"},
            username="cn_rscoped",
            branch=mine,
        )
        BiometricSiteConnector.objects.filter(pk=self.connector.pk).update(
            hostname="SECRET-PC", last_remote_ip="9.9.9.9"
        )
        row = self.client.get(f"{BASE}/connectors", **scoped).json()["connectors"][0]
        self.assertEqual((row["hostname"], row["lastRemoteIp"], row["devices"][0]["host"]), (None, None, ""))
        self.assertEqual(row["name"], self.connector.name)
        calls = (
            lambda: self.client.post(f"{BASE}/connectors", {"name": "x"}, content_type="application/json", **scoped),
            lambda: self.client.patch(
                f"{BASE}/connectors/{self.connector.pk}", {"isActive": False}, content_type="application/json", **scoped
            ),
            lambda: self.client.delete(f"{BASE}/connectors/{self.connector.pk}", **scoped),
            lambda: self.client.post(
                f"{BASE}/connectors/{self.connector.pk}/pairing", {}, content_type="application/json", **scoped
            ),
        )
        for call in calls:
            self.assertEqual(call().status_code, 403)
        self.assertTrue(BiometricSiteConnector.objects.filter(pk=self.connector.pk, is_active=True).exists())

    def test_only_a_real_true_or_false_switches_a_connector(self):
        for bad in (None, "yes", 1, "false"):
            r = self.client.patch(
                f"{BASE}/connectors/{self.connector.pk}",
                {"isActive": bad},
                content_type="application/json",
                **self.admin,
            )
            self.assertEqual(r.status_code, 400, bad)
        self.connector.refresh_from_db()
        self.assertTrue(self.connector.is_active)

    def test_changing_a_connector_writes_only_what_was_changed(self):
        saved = []

        def note(sender, update_fields=None, **kwargs):
            saved.append(update_fields)

        post_save.connect(note, sender=BiometricSiteConnector)
        self.addCleanup(post_save.disconnect, note, sender=BiometricSiteConnector)
        r = self.client.patch(
            f"{BASE}/connectors/{self.connector.pk}",
            {"name": "cn_renamed"},
            content_type="application/json",
            **self.admin,
        )
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(
            saved, [frozenset({"name"})], "a whole-row save could undo what the connector has just reported"
        )


@override_settings(ALLOWED_HOSTS=["*"])
class PunchIngestTests(ConnectorBase):
    def setUp(self):
        super().setUp()
        self.dev, self.fake = self.remote_device("R1")
        self.asha = self.employee("1001", "Asha", "K")

    def send(self, rows, **extra):
        return self.sim.post("/punches", {"deviceId": self.dev.pk, "punches": rows, **extra})

    def row(self, code, when, status=0):
        return {"userId": code, "at": when if isinstance(when, str) else when.isoformat(), "status": status}

    def test_a_time_with_a_zone_is_converted_to_the_factorys_time(self):
        r = self.send([self.row("1001", "2026-10-06T03:30:00+00:00")])
        self.assertEqual(r.json()["created"], 1)
        log = AttendanceLog.objects.get(employee=self.asha)
        self.assertEqual((str(log.date), str(log.punch_time)), ("2026-10-06", "09:00:00"))

    def test_a_status_outside_zero_to_255_is_refused_not_a_server_error(self):
        self.assertEqual(self.send([self.row("1001", at(6, 9), 70000)]).status_code, 400)

    def test_punches_with_an_impossible_time_are_not_written(self):
        year = timezone.now().year
        rows = [
            self.row("1001", "1970-01-01T00:00:00"),
            self.row("1001", f"{year + 3}-01-01T00:00:00"),
            self.row("1001", at(6, 9)),
        ]
        self.assertEqual(self.send(rows).json()["created"], 1)
        self.assertEqual(AttendanceLog.objects.filter(employee=self.asha).count(), 1)

    def test_a_chunk_larger_than_the_server_takes_is_refused_before_it_is_parsed(self):
        too_many = [self.row("1001", at(6, 9))] * (remote.PUNCH_CHUNK_MAX + 1)
        self.assertEqual(self.send(too_many).status_code, 400)

    def test_a_switched_off_device_is_acknowledged_but_its_punches_are_not_recorded(self):
        BiometricDevice.objects.filter(pk=self.dev.pk).update(is_active=False)
        r = self.send([self.row("1001", at(6, 9))])
        self.assertEqual((r.status_code, r.json()["created"]), (200, 0))
        self.assertIn("switched off", r.json()["ignored"])
        self.assertEqual(AttendanceLog.objects.count(), 0)

    def test_an_id_with_no_employee_is_noted_once_for_the_skipped_view(self):
        self.send([self.row("7777", at(6, 9)), self.row("7777", at(6, 10)), self.row("1001", at(6, 9))])
        self.assertEqual(UnmatchedPunch.objects.filter(device_user_id="7777").count(), 1)

    def test_a_catch_up_of_hundreds_of_punches_takes_a_handful_of_queries_not_ten_each(self):
        rows = [self.row("1001", datetime(2026, 10, 6) + timedelta(seconds=i * 60)) for i in range(300)]
        with CaptureQueriesContext(connection) as queries:
            r = self.send(rows)
        self.assertEqual(r.json()["created"], 300)
        self.assertLess(len(queries), 40, f"{len(queries)} queries for 300 punches")
        self.assertEqual(AttendanceLog.objects.filter(employee=self.asha).count(), 300)
        self.assertTrue(Attendance.objects.filter(employee=self.asha, date="2026-10-06", present=True).exists())
        again = self.send(rows).json()
        self.assertEqual((again["created"], again["alreadyInHrms"]), (0, 300))

    def test_the_employee_table_is_read_once_per_request_whatever_the_number_of_punches(self):
        for i in range(5):
            self.employee(f"20{i}", "P", str(i))
        rows = [self.row(f"20{i % 5}", datetime(2026, 10, 6, 6) + timedelta(minutes=i)) for i in range(50)]
        with CaptureQueriesContext(connection) as queries:
            self.send(rows)
        reads = [q for q in queries if 'FROM "employees"' in q["sql"] or "FROM employees" in q["sql"]]
        self.assertLessEqual(len(reads), 2, [q["sql"][:80] for q in reads])

    def test_a_day_already_held_as_absent_is_marked_present_by_a_new_punch(self):
        Attendance.objects.create(employee=self.asha, date="2026-10-06", present=False)
        self.send([self.row("1001", at(6, 9))])
        self.assertTrue(Attendance.objects.get(employee=self.asha, date="2026-10-06").present)

    def test_the_bulk_path_writes_the_same_rows_as_the_one_sync_biometric_uses(self):
        ravi = self.employee("1002", "Ravi", "S")
        plain = _ingest_punches([("1002", date(2026, 10, 6), at(6, 9).time(), "IN")], None, "biometric:R1")
        self.send([self.row("1001", at(6, 9))])
        a = AttendanceLog.objects.get(employee=self.asha)
        b = AttendanceLog.objects.get(employee=ravi)
        self.assertEqual(plain["created"], 1)
        self.assertEqual((a.date, a.punch_time, a.punch_type, a.source), (b.date, b.punch_time, b.punch_type, b.source))
        self.assertEqual(
            Attendance.objects.get(employee=self.asha).present, Attendance.objects.get(employee=ravi).present
        )

    def test_punches_for_a_job_are_only_taken_while_it_is_running_and_within_the_chunk_limit(self):
        job = remote.submit_job(self.dev, "read_punches", {"since": None, "until": None})
        self.sim.poll()
        row = [self.row("1001", "2026-10-06T09:00:00")]
        over = self.sim.post(f"/jobs/{job.pk}/punches", {"seq": remote.MAX_PUNCH_CHUNKS + 1, "punches": row})
        self.assertEqual(over.status_code, 409)
        self.sim.post(f"/jobs/{job.pk}/result", {"ok": True, "data": {"count": 0, "total": 0, "invalid": 0}})
        self.assertEqual(self.sim.post(f"/jobs/{job.pk}/punches", {"seq": 1, "punches": row}).status_code, 409)
        self.assertFalse(BiometricConnectorPunch.objects.filter(job=job).exists())

    def test_a_job_that_vanishes_while_a_fetch_waits_is_that_devices_failure_not_the_runs(self):
        job = remote.submit_job(self.dev, "read_punches", {"since": None, "until": None})
        BiometricConnectorJob.objects.filter(pk=job.pk).delete()
        closed = list(remote.wait_for_jobs([job], sleep=lambda s: None))
        self.assertEqual((closed[0].status, closed[0].error_code), ("failed", "removed"))
        self.assertFalse(remote.collect_punches(closed[0])["ok"])

    def test_a_count_that_is_not_a_number_is_that_devices_failure(self):
        job = remote.submit_job(self.dev, "read_punches", {"since": None, "until": None})
        BiometricConnectorJob.objects.filter(pk=job.pk).update(status="succeeded", result={"count": "many"})
        job.refresh_from_db()
        out = remote.collect_punches(job)
        self.assertEqual((out["ok"], out["code"]), (False, "invalid"))

    def test_when_every_enabled_device_is_behind_a_connector_the_attendance_page_says_so(self):
        with self.assertRaises(BiometricSyncError) as caught:
            get_sync_targets("all")
        self.assertIn("Every enabled device is read by a Site Connector", str(caught.exception))

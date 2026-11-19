"""
Gate monitor credentials and sessions (gate_credentials.py), the session check in auth.require_gate_device, the old
POST gate-devices/login now opening a session, and the HR gate admin's password / switch-off paths.

Run via: DATABASE_URL="" DB_HOST=localhost DB_TEST_NAME=test_uktex_<you> py -3 manage.py test api.tests_gate_credentials
"""

from __future__ import annotations

from datetime import timedelta
from unittest import mock

import bcrypt
from django.core.cache import cache
from django.test import TestCase, override_settings
from django.utils import timezone

from . import approval_workflow as approval
from . import gate_credentials as gc
from .auth import require_gate_device
from .jwt_utils import sign_token, verify_token
from .models import Branch, GateDevice, GateLoginAttempt, GateSession, HRUser

UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36"


class FakeRequest:
    """What gate_credentials reads from a request: META (user agent, address) and the bearer header."""

    def __init__(self, token: str | None = None, ip: str = "10.1.2.3"):
        self.META = {"HTTP_USER_AGENT": UA, "REMOTE_ADDR": ip}
        self.headers = {"Authorization": f"Bearer {token}"} if token else {}


class GateFixture(TestCase):
    def setUp(self):
        self.branch = Branch.objects.create(name="Cred Unit")
        self.gate = self.make_gate("Gate 1", "gate1", "secret-one")
        self.other = self.make_gate("Gate 2", "gate2", "secret-two")

    def make_gate(self, name, username, password):
        gate = GateDevice(name=name, branch=self.branch, username=username, login_token=f"tok-{username}")
        gc.set_gate_password(gate, password)
        gate.save()
        return gate

    def session(self, gate=None):
        return gc.new_gate_session(gate or self.gate, FakeRequest())


class PasswordTests(GateFixture):
    def test_the_hash_checks_and_the_stored_copy_reveals_the_same_password(self):
        self.assertTrue(bcrypt.checkpw(b"secret-one", self.gate.password_hash.encode()))
        self.assertNotIn("secret-one", self.gate.password_encrypted)
        self.assertEqual(gc.reveal_gate_password(self.gate), "secret-one")
        self.assertTrue(gc.password_viewable(self.gate))
        self.assertTrue(gc.check_gate_password(self.gate, "secret-one"))
        self.assertFalse(gc.check_gate_password(self.gate, "secret-two"))

    def test_it_does_not_save_unless_told(self):
        gc.set_gate_password(self.gate, "changed-1")
        self.gate.refresh_from_db()
        self.assertEqual(gc.reveal_gate_password(self.gate), "secret-one")
        gc.set_gate_password(self.gate, "changed-2", save=True)
        self.gate.refresh_from_db()
        self.assertEqual(gc.reveal_gate_password(self.gate), "changed-2")
        self.assertTrue(gc.check_gate_password(self.gate, "changed-2"))

    def test_a_gate_from_before_has_nothing_to_show(self):
        old = GateDevice.objects.create(
            name="Old", branch=self.branch, username="old", password_hash="x", login_token="tok-old"
        )
        self.assertIsNone(gc.reveal_gate_password(old))
        self.assertFalse(gc.password_viewable(old))
        self.assertFalse(gc.check_gate_password(old, "anything"))  # an unusable hash is a "no", not a crash
        self.assertFalse(gc.check_gate_password(self.gate, ""))

    def test_garbage_or_another_secret_reveals_nothing(self):
        self.gate.password_encrypted = "not-a-fernet-token"
        self.assertIsNone(gc.reveal_gate_password(self.gate))
        self.gate.refresh_from_db()
        with override_settings(JWT_SECRET="a-different-secret-for-this-test"):
            self.assertIsNone(gc.reveal_gate_password(self.gate))


class SessionTests(GateFixture):
    def test_a_session_is_labelled_from_the_browser(self):
        s = self.session()
        self.assertEqual(len(s.sid), 32)
        self.assertEqual(s.device_label, "Chrome on Windows")
        self.assertEqual(s.ip_address, "10.1.2.3")
        self.assertIsNone(s.revoked_at)
        self.assertIsNotNone(s.last_seen_at)

    def test_the_token_carries_gsid_not_jti_and_lasts_30_days(self):
        s = self.session()
        payload = verify_token(gc.gate_token(self.gate, s))
        self.assertEqual(payload["role"], "gate_device")
        self.assertEqual(payload["deviceId"], self.gate.id)
        self.assertEqual(payload["gsid"], s.sid)
        self.assertNotIn("jti", payload)
        left = payload["exp"] - timezone.now().timestamp()
        self.assertGreater(left, timedelta(days=29, hours=23).total_seconds())
        self.assertLessEqual(left, timedelta(days=30).total_seconds() + 5)
        self.assertFalse(gc.token_expires_soon(payload))
        self.assertTrue(gc.token_expires_soon({**payload, "exp": payload["exp"] - 16 * 86400}))
        self.assertTrue(gc.token_expires_soon({}))

    def test_the_session_must_be_open_and_of_this_gate(self):
        s = self.session()
        self.assertEqual(gc.session_for_token({"gsid": s.sid}, self.gate), s)
        self.assertIsNone(gc.session_for_token({"gsid": s.sid}, self.other))
        self.assertIsNone(gc.session_for_token({}, self.gate))
        self.assertIsNone(gc.session_for_token({"gsid": 12}, self.gate))
        self.assertTrue(gc.end_gate_session(s))
        self.assertFalse(gc.end_gate_session(s))
        s.refresh_from_db()
        self.assertEqual(s.revoked_reason, GateSession.REVOKED_LOGOUT)
        self.assertIsNone(gc.session_for_token({"gsid": s.sid}, self.gate))

    def test_last_seen_is_written_at_most_once_a_minute(self):
        s = self.session()
        first = s.last_seen_at
        gc.touch_session(s)
        s.refresh_from_db()
        self.assertEqual(s.last_seen_at, first)
        later = first + timedelta(seconds=61)
        with mock.patch("api.gate_credentials.timezone.now", return_value=later):
            gc.touch_session(s)
        s.refresh_from_db()
        self.assertEqual(s.last_seen_at, later)

    def test_revoking_ends_every_open_session_of_that_gate_only(self):
        a, b, theirs = self.session(), self.session(), self.session(self.other)
        gc.end_gate_session(b)
        self.assertEqual(gc.revoke_gate_sessions(self.gate, GateSession.REVOKED_HR_SIGNED_OUT), 1)
        a.refresh_from_db(), b.refresh_from_db(), theirs.refresh_from_db()
        self.assertEqual(a.revoked_reason, GateSession.REVOKED_HR_SIGNED_OUT)
        self.assertEqual(b.revoked_reason, GateSession.REVOKED_LOGOUT)  # already ended: untouched
        self.assertIsNone(theirs.revoked_at)
        self.assertEqual(list(gc.open_sessions([self.gate.id, self.other.id])), [theirs])


class LockoutTests(GateFixture):
    def wrong(self, username="gate1", n=1):
        for _ in range(n):
            gate, outcome = gc.check_gate_login(FakeRequest(), username, "nope")
            self.assertEqual(outcome, gc.LOGIN_WRONG)

    def test_five_wrong_tries_lock_the_username_and_record_every_try(self):
        self.wrong(n=4)
        self.assertFalse(gc.login_locked_out("gate1"))
        self.wrong("  GATE1 ")  # the same username, however typed
        self.assertTrue(gc.login_locked_out("Gate1"))
        gate, outcome = gc.check_gate_login(FakeRequest(), "gate1", "secret-one")
        self.assertEqual((gate, outcome), (None, gc.LOGIN_LOCKED))
        self.assertEqual(gc.LOGIN_ERRORS[gc.LOGIN_LOCKED][0], 429)
        self.assertEqual(GateLoginAttempt.objects.filter(username="gate1").count(), 5)  # not while locked
        self.assertFalse(gc.login_locked_out("gate2"))

    def test_a_correct_sign_in_in_between_resets_the_count(self):
        self.wrong(n=4)
        self.assertEqual(gc.check_gate_login(FakeRequest(), "gate1", "secret-one")[1], gc.LOGIN_OK)
        self.wrong(n=4)
        self.assertFalse(gc.login_locked_out("gate1"))

    def test_the_lock_ends_after_15_minutes(self):
        self.wrong(n=5)
        GateLoginAttempt.objects.update(created_at=timezone.now() - timedelta(minutes=16))
        self.assertFalse(gc.login_locked_out("gate1"))

    def test_an_hr_change_to_the_gate_ends_the_lock(self):
        self.wrong(n=5)
        self.gate.updated_at = timezone.now() + timedelta(seconds=1)
        self.gate.save(update_fields=["updated_at"])
        self.assertFalse(gc.login_locked_out("gate1"))
        self.assertEqual(gc.check_gate_login(FakeRequest(), "gate1", "secret-one")[1], gc.LOGIN_OK)

    def test_an_unknown_username_locks_too_and_an_empty_one_is_never_recorded(self):
        self.wrong("nobody", n=5)
        self.assertTrue(gc.login_locked_out("nobody"))
        self.assertEqual(gc.check_gate_login(FakeRequest(), "", "x"), (None, gc.LOGIN_WRONG))
        self.assertEqual(gc.check_gate_login(FakeRequest(), None, None), (None, gc.LOGIN_WRONG))
        self.assertFalse(GateLoginAttempt.objects.filter(username="").exists())

    def test_a_switched_off_gate_is_told_apart_and_counts_as_a_failed_try(self):
        self.gate.is_active = False
        self.gate.save(update_fields=["is_active"])
        gate, outcome = gc.check_gate_login(FakeRequest(), "gate1", "secret-one")
        self.assertEqual((gate, outcome), (self.gate, gc.LOGIN_SWITCHED_OFF))
        self.assertEqual(gc.LOGIN_ERRORS[outcome], (403, "This gate is switched off. Ask HR to switch it on."))
        self.assertFalse(GateLoginAttempt.objects.get(username="gate1").success)

    def test_sign_in_opens_a_session_and_stamps_the_last_login(self):
        gate, outcome = gc.check_gate_login(FakeRequest(ip="10.9.9.9"), "Gate1", "secret-one")
        self.assertEqual(outcome, gc.LOGIN_OK)
        session, token = gc.start_gate_session(gate, FakeRequest())
        self.assertEqual(verify_token(token)["gsid"], session.sid)
        self.gate.refresh_from_db()
        self.assertIsNotNone(self.gate.last_login_at)
        attempt = GateLoginAttempt.objects.get()
        self.assertEqual((attempt.username, attempt.ip_address, attempt.success), ("gate1", "10.9.9.9", True))


class SignInHardeningTests(GateFixture):
    """S2 / S3 (19 Nov 2026): equal timing for unknown usernames, tries counted under the gate's own username and
    written before the password check, old tries pruned."""

    def test_an_unknown_username_still_costs_one_bcrypt_check(self):
        with mock.patch.object(gc.bcrypt, "checkpw", wraps=bcrypt.checkpw) as checkpw:
            self.assertEqual(gc.check_gate_login(FakeRequest(), "nobody-here", "whatever"), (None, gc.LOGIN_WRONG))
        checkpw.assert_called_once()
        self.assertEqual(checkpw.call_args[0][1], gc._DUMMY_HASH)
        # a gate with no usable password costs the same
        GateDevice.objects.filter(pk=self.other.pk).update(password_hash="")
        with mock.patch.object(gc.bcrypt, "checkpw", wraps=bcrypt.checkpw) as checkpw:
            self.assertEqual(gc.check_gate_login(FakeRequest(), "gate2", "secret-two")[1], gc.LOGIN_WRONG)
        checkpw.assert_called_once()

    def test_a_try_for_a_known_gate_counts_under_its_own_username(self):
        # whatever text found the gate, the try is the gate's (its stored username, lower case)
        GateDevice.objects.filter(pk=self.gate.pk).update(username="Gate1")
        gate = GateDevice.objects.get(pk=self.gate.pk)
        with mock.patch.object(gc, "_gate_by_username", lambda name: gate):
            for _ in range(5):
                gc.check_gate_login(FakeRequest(), "front-gate-typed-otherwise", "nope")
        self.assertEqual(set(GateLoginAttempt.objects.values_list("username", flat=True)), {"gate1"})
        self.assertTrue(gc.login_locked_out("gate1"))
        self.assertEqual(gc.check_gate_login(FakeRequest(), "GATE1", "secret-one")[1], gc.LOGIN_LOCKED)

    def test_the_try_is_written_before_the_password_check(self):
        seen = []

        def check(gate, raw):
            seen.append(list(GateLoginAttempt.objects.values_list("username", "success")))
            return raw == "secret-one"

        with mock.patch.object(gc, "check_gate_password", check):
            self.assertEqual(gc.check_gate_login(FakeRequest(), "gate1", "nope")[1], gc.LOGIN_WRONG)
            self.assertEqual(gc.check_gate_login(FakeRequest(), "gate1", "secret-one")[1], gc.LOGIN_OK)
        # each check already saw its own try, as a failure, so tries sent at the same moment see each other
        self.assertEqual(seen, [[("gate1", False)], [("gate1", False), ("gate1", False)]])
        self.assertEqual(list(GateLoginAttempt.objects.order_by("id").values_list("success", flat=True)), [False, True])

    def test_a_success_removes_tries_older_than_30_days(self):
        for _ in range(3):
            gc.record_login_attempt("someone-else", "1.1.1.1", False)
        old, recent = list(GateLoginAttempt.objects.order_by("id"))[:2]
        GateLoginAttempt.objects.filter(pk=old.pk).update(created_at=timezone.now() - timedelta(days=31))
        GateLoginAttempt.objects.filter(pk=recent.pk).update(created_at=timezone.now() - timedelta(days=29))
        gc.check_gate_login(FakeRequest(), "gate1", "nope")
        self.assertTrue(GateLoginAttempt.objects.filter(pk=old.pk).exists())  # only a success prunes
        self.assertEqual(gc.check_gate_login(FakeRequest(), "gate1", "secret-one")[1], gc.LOGIN_OK)
        self.assertFalse(GateLoginAttempt.objects.filter(pk=old.pk).exists())
        self.assertTrue(GateLoginAttempt.objects.filter(pk=recent.pk).exists())


class RequireGateDeviceTests(GateFixture):
    def call(self, token):
        @require_gate_device
        def view(request):
            return request

        return view(FakeRequest(token))

    def test_a_session_token_passes_and_names_its_session(self):
        session = self.session()
        request = self.call(gc.gate_token(self.gate, session))
        self.assertEqual(request.gate_device, self.gate)
        self.assertEqual(request.gate_session, session)

    def test_an_ended_session_is_refused_with_session_ended(self):
        session = self.session()
        token = gc.gate_token(self.gate, session)
        gc.revoke_gate_sessions(self.gate, GateSession.REVOKED_PASSWORD_CHANGED)
        response = self.call(token)
        self.assertEqual(response.status_code, 401)
        self.assertEqual(response.data["code"], "session_ended")

    def test_another_gates_session_or_an_unknown_one_is_refused(self):
        theirs = self.session(self.other)
        forged = sign_token({"role": "gate_device", "deviceId": self.gate.id, "gateName": "x", "gsid": theirs.sid})
        self.assertEqual(self.call(forged).status_code, 401)
        unknown = sign_token({"role": "gate_device", "deviceId": self.gate.id, "gateName": "x", "gsid": "f" * 32})
        self.assertEqual(self.call(unknown).status_code, 401)

    def test_a_token_from_before_sessions_is_refused_as_an_ended_sign_in(self):
        # 19 Nov 2026: a token without gsid names no session HR could end, so it is refused (S6)
        legacy = sign_token({"role": "gate_device", "deviceId": self.gate.id, "gateName": self.gate.name})
        response = self.call(legacy)
        self.assertEqual(response.status_code, 401)
        self.assertEqual(
            response.data, {"error": "This gate's sign-in has ended. Sign in again.", "code": "session_ended"}
        )

    def test_a_switched_off_gate_is_refused_even_with_an_open_session(self):
        token = gc.gate_token(self.gate, self.session())
        GateDevice.objects.filter(pk=self.gate.pk).update(is_active=False)
        response = self.call(token)
        self.assertEqual(response.status_code, 403)
        self.assertEqual(response.data["code"], "gate_revoked")

    def test_a_request_touches_last_seen(self):
        session = self.session()
        GateSession.objects.filter(pk=session.pk).update(last_seen_at=timezone.now() - timedelta(minutes=5))
        self.call(gc.gate_token(self.gate, session))
        session.refresh_from_db()
        self.assertLess(timezone.now() - session.last_seen_at, timedelta(seconds=30))


class OldLoginEndpointTests(GateFixture):
    def setUp(self):
        super().setUp()
        cache.clear()  # the per-address sign-in throttle
        self.addCleanup(cache.clear)

    def login(self, username, password):
        return self.client.post(
            "/api/gate-devices/login",
            {"username": username, "password": password},
            content_type="application/json",
            HTTP_USER_AGENT=UA,
        )

    def test_it_keeps_its_keys_and_now_opens_a_session(self):
        response = self.login("gate1", "secret-one")
        self.assertEqual(response.status_code, 200)
        body = response.json()
        self.assertEqual(set(body), {"token", "gateId", "gateName"})
        session = GateSession.objects.get(gate=self.gate)
        self.assertEqual(verify_token(body["token"])["gsid"], session.sid)
        # and the token works on the kiosk's own endpoints
        log = self.client.get("/api/gate-devices/scan-log", HTTP_AUTHORIZATION=f"Bearer {body['token']}")
        self.assertEqual(log.status_code, 200)

    def test_wrong_and_switched_off_keep_the_old_401_and_five_wrong_lock(self):
        self.assertEqual(self.login("gate1", "nope").json(), {"error": "Invalid username or password"})
        GateDevice.objects.filter(pk=self.other.pk).update(is_active=False)
        self.assertEqual(self.login("gate2", "secret-two").status_code, 401)
        for _ in range(4):
            self.assertEqual(self.login("gate1", "nope").status_code, 401)
        response = self.login("gate1", "secret-one")
        self.assertEqual(response.status_code, 429)
        self.assertIn("Too many wrong tries", response.json()["error"])
        self.assertFalse(GateSession.objects.filter(gate=self.gate).exists())


class HrGateAdminTests(GateFixture):
    def setUp(self):
        super().setUp()
        approval.clear_cache()
        admin = HRUser.objects.create(username="gate_cred_admin", password_hash="x", is_super_admin=True)
        self.hr = {"HTTP_AUTHORIZATION": f"Bearer {sign_token({'role': 'hr', 'hrUserId': admin.id})}"}

    def put(self, gate, body):
        return self.client.put(f"/api/gate-devices/{gate.id}", body, content_type="application/json", **self.hr)

    def test_a_new_gate_password_can_be_shown_and_the_answer_is_unchanged(self):
        response = self.client.post(
            "/api/gate-devices",
            {"name": "Gate 3", "username": "gate3", "password": "secret-three", "branchId": self.branch.id},
            content_type="application/json",
            **self.hr,
        )
        self.assertEqual(response.status_code, 201)
        # every key of the old answer is still there (Manage Gates added more: tests_gate_admin)
        self.assertLessEqual(
            {"id", "name", "branchId", "branchName", "username", "isActive", "loginToken", "createdBy", "createdAt"}
            | {"lastLoginAt"},
            set(response.json()),
        )
        self.assertNotIn("secret-three", response.content.decode())
        gate = GateDevice.objects.get(username="gate3")
        self.assertEqual(gc.reveal_gate_password(gate), "secret-three")
        listed = self.client.get("/api/gate-devices", **self.hr)
        self.assertNotIn(gate.password_encrypted, listed.content.decode())

    def test_a_password_reset_is_viewable_and_signs_the_gate_out(self):
        keep = self.session(self.other)
        self.session()
        response = self.put(self.gate, {"password": "fresh-pass"})
        self.assertEqual(response.status_code, 200)
        self.gate.refresh_from_db()
        self.assertEqual(gc.reveal_gate_password(self.gate), "fresh-pass")
        self.assertIsNotNone(self.gate.updated_at)
        self.assertEqual(
            list(GateSession.objects.filter(gate=self.gate).values_list("revoked_reason", flat=True)),
            [GateSession.REVOKED_PASSWORD_CHANGED],
        )
        keep.refresh_from_db()
        self.assertIsNone(keep.revoked_at)
        self.assertEqual(self.put(self.gate, {"password": "short"}).status_code, 400)

    def test_switching_a_gate_off_signs_it_out_and_a_rename_does_not(self):
        session = self.session()
        self.assertEqual(self.put(self.gate, {"name": "Gate One"}).status_code, 200)
        session.refresh_from_db()
        self.assertIsNone(session.revoked_at)
        self.assertEqual(self.put(self.gate, {"isActive": False}).json()["isActive"], False)
        session.refresh_from_db()
        self.assertEqual(session.revoked_reason, GateSession.REVOKED_DEACTIVATED)

    def test_get_of_one_gate_answers_with_its_sessions(self):
        # built by Manage Gates (tests_gate_admin covers the rest)
        response = self.client.get(f"/api/gate-devices/{self.gate.id}", **self.hr)
        self.assertEqual(response.status_code, 200)
        self.assertIn("sessions", response.json())

"""
Reception -per-desk login onto Visitor data, plus the visitor-gate-form
extension that resolves "whom you're meeting" to a real Employee by phone
number and notifies them. Mirrors tests_gate_scanner.py's conventions:
call the (already-decorated) view functions directly via APIRequestFactory
rather than exercising them through urls.py, and test the pure helper
functions (here, _find_employee_by_phone) directly.

Run via: python manage.py test api.tests_reception -v 2
"""
from django.test import TestCase
from rest_framework.test import APIRequestFactory

from .auth import require_reception_device
from .jwt_utils import sign_token
from .models import Branch, Department, Employee, GateQRCode, ReceptionDevice, Visitor, VisitorVisit
from .outpass_visitor_views import (
    _find_employee_by_phone, visitor_check_employee_phone, visitor_gate_new, visitor_gate_repeat,
)
from .reception_views import reception_summary, reception_visits


class _DeskReq:
    META = {"HTTP_USER_AGENT": "test", "REMOTE_ADDR": "10.0.0.1"}


def _desk_session_token(desk) -> str:
    """A desk token with its own session (a token without rsid is refused since 19 Nov 2026)."""
    from .reception_credentials import desk_token, new_desk_session

    return desk_token(desk, new_desk_session(desk, _DeskReq()))


class FindEmployeeByPhoneTests(TestCase):
    def setUp(self):
        self.dept = Department.objects.create(name="Reception QA Dept")
        self.emp = Employee.objects.create(
            employee_code="RECTEST_EMP1", first_name="Host", last_name="Employee",
            employment_type="staff", status="active", department=self.dept, phone="98765 43210",
        )

    def test_exact_match(self):
        found = _find_employee_by_phone("98765 43210")
        self.assertEqual(found.id, self.emp.id)

    def test_digits_only_match_ignores_formatting(self):
        found = _find_employee_by_phone("+91-9876543210")
        self.assertEqual(found.id, self.emp.id)

    def test_no_match_returns_none(self):
        self.assertIsNone(_find_employee_by_phone("00000 00000"))

    def test_blank_phone_returns_none(self):
        self.assertIsNone(_find_employee_by_phone(""))

    def test_short_digit_string_does_not_false_positive(self):
        # A too-short input must never fall through to a tail-match against
        # a real number that happens to share a few trailing digits.
        self.assertIsNone(_find_employee_by_phone("10"))


class VisitorGateEmployeeLinkTests(TestCase):
    """visitor_gate_new / visitor_gate_repeat with a resolved meetingEmployeeId
    -verifies the VisitorVisit.meeting_employee FK gets set, and that
    notification attempts (SMTP/WhatsApp unconfigured in tests) fail
    silently rather than blocking check-in."""

    def setUp(self):
        self.branch = Branch.objects.create(name="Reception QA Branch")
        self.qr = GateQRCode.get_or_create_for(self.branch, GateQRCode.KIND_VISITOR)
        self.dept = Department.objects.create(name="Reception QA Dept 2")
        self.emp = Employee.objects.create(
            employee_code="RECTEST_EMP2", first_name="Meeting", last_name="Target",
            employment_type="staff", status="active", department=self.dept,
            phone="91234 56789", email="target@example.com",
        )
        self.factory = APIRequestFactory()

    def test_check_employee_phone_resolves_match(self):
        request = self.factory.post(
            f"/api/visitor/gate/{self.qr.token}/check-employee-phone", {"phone": "9123456789"}, format="json",
        )
        response = visitor_check_employee_phone(request, self.qr.token)
        self.assertEqual(response.status_code, 200)
        self.assertTrue(response.data["found"])
        self.assertEqual(response.data["employee"]["id"], self.emp.id)
        self.assertEqual(response.data["employee"]["department"], "Reception QA Dept 2")

    def test_check_employee_phone_no_match(self):
        request = self.factory.post(
            f"/api/visitor/gate/{self.qr.token}/check-employee-phone", {"phone": "00000000"}, format="json",
        )
        response = visitor_check_employee_phone(request, self.qr.token)
        self.assertEqual(response.status_code, 200)
        self.assertFalse(response.data["found"])

    def test_new_visitor_links_meeting_employee_and_does_not_crash_on_notify(self):
        request = self.factory.post(f"/api/visitor/gate/{self.qr.token}/new", {
            "name": "Vishal Visitor", "phone": "70000 00001", "whomToMeet": "Meeting Target",
            "purpose": "Delivery", "meetingEmployeeId": self.emp.id,
        }, format="json")
        response = visitor_gate_new(request, self.qr.token)
        self.assertEqual(response.status_code, 201)

        visit = VisitorVisit.objects.get(visitor__phone="70000 00001")
        self.assertEqual(visit.meeting_employee_id, self.emp.id)
        # No SMTP/WhatsApp configured in the test environment -both sends
        # must fail silently rather than raising, and never mark "notified".
        self.assertIsNone(visit.notified_email_at)
        self.assertIsNone(visit.notified_whatsapp_at)

    def test_new_visitor_without_employee_id_leaves_fk_null(self):
        request = self.factory.post(f"/api/visitor/gate/{self.qr.token}/new", {
            "name": "No Link Visitor", "phone": "70000 00002", "whomToMeet": "General enquiry",
            "purpose": "Walk-in",
        }, format="json")
        response = visitor_gate_new(request, self.qr.token)
        self.assertEqual(response.status_code, 201)
        visit = VisitorVisit.objects.get(visitor__phone="70000 00002")
        self.assertIsNone(visit.meeting_employee_id)

    def test_repeat_visitor_links_meeting_employee(self):
        visitor = Visitor.objects.create(name="Returning Person", phone="70000 00003")
        # "Already visited" is for someone who has visited THIS branch before (per-branch identity, 19 Nov 2026)
        VisitorVisit.objects.create(
            visitor=visitor, branch=self.branch, whom_to_meet="Someone", purpose="First visit",
            visitor_name="Returning Person",
        )
        request = self.factory.post(f"/api/visitor/gate/{self.qr.token}/repeat", {
            "phone": "70000 00003", "whomToMeet": "Meeting Target", "purpose": "Follow-up",
            "meetingEmployeeId": self.emp.id,
        }, format="json")
        response = visitor_gate_repeat(request, self.qr.token)
        self.assertEqual(response.status_code, 201)
        visit = VisitorVisit.objects.filter(visitor=visitor).latest("visited_at")
        self.assertEqual(visit.meeting_employee_id, self.emp.id)

    def test_new_visitor_with_bogus_employee_id_is_ignored_not_errored(self):
        request = self.factory.post(f"/api/visitor/gate/{self.qr.token}/new", {
            "name": "Bogus Link Visitor", "phone": "70000 00004", "whomToMeet": "Someone",
            "purpose": "Walk-in", "meetingEmployeeId": 999999,
        }, format="json")
        response = visitor_gate_new(request, self.qr.token)
        self.assertEqual(response.status_code, 201)
        visit = VisitorVisit.objects.get(visitor__phone="70000 00004")
        self.assertIsNone(visit.meeting_employee_id)


class ReceptionDeviceRevocationTests(TestCase):
    """Mirrors tests_gate_scanner.py::GateDeviceRevocationTests exactly, for
    ReceptionDevice/require_reception_device instead of GateDevice."""

    def setUp(self):
        self.branch = Branch.objects.create(name="Reception QA Branch 2")
        self.device = ReceptionDevice.objects.create(
            name="Front Desk", branch=self.branch, username="reception1",
            password_hash="x", login_token="rtok1",
        )

    def test_require_reception_device_rejects_deactivated_desk(self):
        token = _desk_session_token(self.device)
        self.device.is_active = False
        self.device.save(update_fields=["is_active"])

        seen = {}

        @require_reception_device
        def view(request):
            seen["called"] = True
            return "ok"

        class FakeRequest:
            headers = {"Authorization": f"Bearer {token}"}

        result = view(FakeRequest())
        self.assertNotIn("called", seen)
        self.assertEqual(result.status_code, 403)

    def test_require_reception_device_accepts_active_desk(self):
        token = _desk_session_token(self.device)

        @require_reception_device
        def view(request):
            return request.reception_device.name

        class FakeRequest:
            headers = {"Authorization": f"Bearer {token}"}

        self.assertEqual(view(FakeRequest()), "Front Desk")


class ReceptionDashboardScopingTests(TestCase):
    """reception_summary / reception_visits must only ever show the
    authenticated desk's own branch -mirrors the same reasoning as
    tests_gate_scanner.py's per-gate scoping of gate_scan_log."""

    def setUp(self):
        self.branch_a = Branch.objects.create(name="Reception QA Branch A")
        self.branch_b = Branch.objects.create(name="Reception QA Branch B")
        self.device_a = ReceptionDevice.objects.create(
            name="Desk A", branch=self.branch_a, username="reception_a",
            password_hash="x", login_token="rtok_a",
        )
        visitor_a = Visitor.objects.create(name="Visitor A", phone="80000 00001")
        visitor_b = Visitor.objects.create(name="Visitor B", phone="80000 00002")
        VisitorVisit.objects.create(visitor=visitor_a, branch=self.branch_a, whom_to_meet="Someone", purpose="Test")
        VisitorVisit.objects.create(visitor=visitor_b, branch=self.branch_b, whom_to_meet="Someone", purpose="Test")

        self.factory = APIRequestFactory()

    def _auth_request(self, path: str):
        token = _desk_session_token(self.device_a)
        return self.factory.get(path, HTTP_AUTHORIZATION=f"Bearer {token}")

    def test_summary_only_counts_own_branch(self):
        response = reception_summary(self._auth_request("/api/reception-devices/summary"))
        self.assertEqual(response.data["today"], 1)

    def test_visits_only_lists_own_branch(self):
        response = reception_visits(self._auth_request("/api/reception-devices/visits?range=month"))
        self.assertEqual(response.data["total"], 1)
        self.assertEqual(response.data["items"][0]["name"], "Visitor A")


# ═══ The shared desk sign-in (/reception-login) and its sessions, 18 Nov 2026 ═══════════════════════════════════════
# Mirrors tests_gate_monitor.py for desks: reception_credentials.py + reception_views login / me / logout and
# auth.require_reception_device's session check.

from datetime import timedelta as _timedelta  # noqa: E402

from django.core.cache import cache as _cache  # noqa: E402
from django.utils import timezone as _tz  # noqa: E402

from . import gate_credentials as _gc  # noqa: E402
from . import reception_credentials as _rc  # noqa: E402
from .jwt_utils import verify_token as _verify  # noqa: E402
from .models import GateDevice, HRUser, ReceptionLoginAttempt, ReceptionSession  # noqa: E402

_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36"


class _Req:
    META = {"HTTP_USER_AGENT": _UA, "REMOTE_ADDR": "10.9.8.7"}
    headers: dict = {}


class DeskSignInTests(TestCase):
    def setUp(self):
        _cache.clear()  # the per-address sign-in throttle
        self.addCleanup(_cache.clear)
        self.branch = Branch.objects.create(name="Desk Unit")
        self.desk = ReceptionDevice(
            name="Front Desk", branch=self.branch, username="front.desk", login_token="tok-front", location="Lobby",
        )
        _rc.set_desk_password(self.desk, "secret-one")
        self.desk.save()
        admin = HRUser.objects.create(username="desk_admin", password_hash="x", is_super_admin=True)
        hr_token = sign_token({"role": "hr", "hrUserId": admin.id})
        self.hr = {"HTTP_AUTHORIZATION": f"Bearer {hr_token}"}

    def login(self, username, password):
        return self.client.post(
            "/api/reception-devices/login", {"username": username, "password": password},
            content_type="application/json", HTTP_USER_AGENT=_UA,
        )

    def auth(self, token):
        return {"HTTP_AUTHORIZATION": f"Bearer {token}"}

    def token_for(self, desk=None):
        _session, token = _rc.start_desk_session(desk or self.desk, _Req())
        return token

    def hr_put(self, body):
        return self.client.put(
            f"/api/reception-devices/{self.desk.id}", body, content_type="application/json", **self.hr,
        )

    # ── 19 Nov 2026: equal timing, tries under the desk's own username written before the check, pruning (S2/S3) ──
    def test_an_unknown_username_costs_a_bcrypt_check_and_tries_are_written_first(self):
        from unittest import mock

        import bcrypt

        with mock.patch.object(_gc.bcrypt, "checkpw", wraps=bcrypt.checkpw) as checkpw:
            self.assertEqual(self.login("no.such.desk", "whatever").status_code, 401)
        checkpw.assert_called_once()
        seen = []

        def check(desk, raw):
            seen.append(list(ReceptionLoginAttempt.objects.filter(username="front.desk").values_list("success", flat=True)))
            return raw == "secret-one"

        ReceptionDevice.objects.filter(pk=self.desk.pk).update(username="Front.Desk")
        with mock.patch.object(_rc, "check_desk_password", check):
            self.assertEqual(self.login("  FRONT.desk ", "secret-one").status_code, 200)
        self.assertEqual(seen, [[False]])  # written (as a failure) before the password check
        self.assertEqual(
            list(ReceptionLoginAttempt.objects.filter(username="front.desk").values_list("success", flat=True)), [True]
        )
        old = ReceptionLoginAttempt.objects.create(username="someone", ip_address=None, success=False)
        ReceptionLoginAttempt.objects.filter(pk=old.pk).update(created_at=_tz.now() - _timedelta(days=31))
        self.assertEqual(self.login("front.desk", "secret-one").status_code, 200)
        self.assertFalse(ReceptionLoginAttempt.objects.filter(pk=old.pk).exists())  # pruned by a success

    # ── sign-in ──
    def test_a_right_password_opens_a_session_and_says_which_desk(self):
        r = self.login("front.desk", "secret-one")
        self.assertEqual(r.status_code, 200, r.content)
        body = r.json()
        self.assertEqual(set(body), {"token", "deviceId", "deskName", "desk"})
        self.assertEqual((body["deviceId"], body["deskName"]), (self.desk.id, "Front Desk"))
        self.assertEqual(
            body["desk"], {"id": self.desk.id, "name": "Front Desk", "branchName": "Desk Unit", "location": "Lobby"}
        )
        claims = _verify(body["token"])
        session = ReceptionSession.objects.get(desk=self.desk)
        self.assertEqual(
            (claims["role"], claims["deviceId"], claims["rsid"]), ("reception_device", self.desk.id, session.sid)
        )
        self.assertNotIn("jti", claims)
        self.assertNotIn("gsid", claims)
        self.assertGreater(claims["exp"] - _tz.now().timestamp(), 29 * 86400)
        self.assertIn("Chrome", session.device_label)
        self.desk.refresh_from_db()
        self.assertIsNotNone(self.desk.last_login_at)
        self.assertTrue(ReceptionLoginAttempt.objects.filter(username="front.desk", success=True).exists())
        self.assertNotIn("secret-one", r.content.decode())

    def test_the_username_is_not_case_sensitive(self):
        self.assertEqual(self.login("  FRONT.Desk ", "secret-one").status_code, 200)

    def test_wrong_password_or_unknown_desk_is_401_and_recorded(self):
        r = self.login("front.desk", "nope")
        self.assertEqual(r.status_code, 401)
        self.assertEqual(r.json(), {"error": "Wrong username or password.", "code": "wrong"})
        self.assertEqual(self.login("nobody", "secret-one").status_code, 401)
        self.assertEqual(ReceptionLoginAttempt.objects.filter(success=False).count(), 2)
        self.assertFalse(ReceptionSession.objects.exists())

    def test_a_switched_off_desk_is_403_with_the_right_password(self):
        ReceptionDevice.objects.filter(pk=self.desk.pk).update(is_active=False)
        r = self.login("front.desk", "secret-one")
        self.assertEqual(r.status_code, 403)
        self.assertEqual(r.json()["error"], "This desk is switched off. Ask HR to switch it on.")
        self.assertEqual(r.json()["code"], "switched_off")
        self.assertEqual(self.login("front.desk", "nope").status_code, 401)  # a wrong password says nothing more

    def test_missing_fields_are_400_and_not_an_attempt(self):
        self.assertEqual(self.login("", "secret-one").status_code, 400)
        self.assertEqual(self.login("front.desk", "").status_code, 400)
        self.assertFalse(ReceptionLoginAttempt.objects.exists())

    def test_five_wrong_tries_lock_the_username_until_hr_changes_the_desk(self):
        for _ in range(5):
            self.assertEqual(self.login("front.desk", "nope").status_code, 401)
        r = self.login("front.desk", "secret-one")
        self.assertEqual(r.status_code, 429)
        self.assertEqual(
            r.json()["error"], "Too many wrong tries. Wait 15 minutes or ask HR to reset the password."
        )
        self.assertEqual(self.hr_put({"password": "fresh-pass"}).status_code, 200)
        self.assertEqual(self.login("front.desk", "fresh-pass").status_code, 200)

    def test_desk_and_gate_attempts_are_counted_apart(self):
        gate = GateDevice(name="Main Gate", branch=self.branch, username="front.desk", login_token="tok-gate")
        _gc.set_gate_password(gate, "gate-pass")
        gate.save()
        for _ in range(5):
            _gc.record_login_attempt("front.desk", "1.2.3.4", False)
        self.assertTrue(_gc.login_locked_out("front.desk"))
        self.assertEqual(self.login("front.desk", "secret-one").status_code, 200)

    # ── me / logout ──
    def test_me_says_who_and_renews_a_token_with_less_than_15_days_left(self):
        token = self.token_for()
        body = self.client.get("/api/reception-devices/me", **self.auth(token)).json()
        self.assertEqual(set(body), {"desk", "session", "expiresAt"})  # 30 days left: nothing new
        self.assertEqual(body["desk"]["name"], "Front Desk")
        self.assertEqual(set(body["session"]), {"id", "deviceLabel", "createdAt", "lastSeenAt"})
        sid = _verify(token)["rsid"]
        short = sign_token(
            {"role": "reception_device", "deviceId": self.desk.id, "deskName": "Front Desk", "rsid": sid},
            expires_in=_timedelta(days=10),
        )
        body = self.client.get("/api/reception-devices/me", **self.auth(short)).json()
        self.assertIn("token", body)
        fresh = _verify(body["token"])
        self.assertEqual(fresh["rsid"], sid)
        self.assertGreater(fresh["exp"] - _tz.now().timestamp(), 29 * 86400)
        self.assertNotIn(sid, self.client.get("/api/reception-devices/me", **self.auth(token)).content.decode())

    def test_an_old_token_without_a_session_is_refused_as_an_ended_sign_in(self):
        # 19 Nov 2026: a token without rsid names no session HR could end, so every desk call refuses it (S6)
        legacy = sign_token({"role": "reception_device", "deviceId": self.desk.id, "deskName": "Front Desk"})
        ended = {"error": "This desk's sign-in has ended. Sign in again.", "code": "session_ended"}
        for method, path in (("get", "me"), ("post", "logout"), ("get", "summary"), ("get", "visits")):
            response = getattr(self.client, method)(f"/api/reception-devices/{path}", **self.auth(legacy))
            self.assertEqual((response.status_code, response.json()), (401, ended), path)

    def test_logout_ends_only_this_browser(self):
        mine, other = self.token_for(), self.token_for()
        self.assertEqual(self.client.post("/api/reception-devices/logout", **self.auth(mine)).status_code, 204)
        r = self.client.get("/api/reception-devices/summary", **self.auth(mine))
        self.assertEqual(r.status_code, 401)
        self.assertEqual(r.json(), {"error": "This desk's sign-in has ended. Sign in again.", "code": "session_ended"})
        self.assertEqual(self.client.get("/api/reception-devices/summary", **self.auth(other)).status_code, 200)
        self.assertEqual(
            ReceptionSession.objects.filter(revoked_reason=ReceptionSession.REVOKED_LOGOUT).count(), 1
        )

    def test_a_session_of_another_desk_is_refused(self):
        other = ReceptionDevice.objects.create(
            name="Other", branch=self.branch, username="other.desk", password_hash="x", login_token="tok-o"
        )
        session = _rc.new_desk_session(other, _Req())
        forged = sign_token({"role": "reception_device", "deviceId": self.desk.id, "rsid": session.sid})
        self.assertEqual(self.client.get("/api/reception-devices/me", **self.auth(forged)).status_code, 401)

    # ── HR ends it ──
    def test_hr_reset_username_change_switch_off_and_sign_out_end_the_desk_session(self):
        cases = [
            ({"password": "another-pass"}, 401, "session_ended"),
            ({"username": "lobby.desk"}, 401, "session_ended"),
            ({"isActive": False}, 403, "desk_revoked"),
        ]
        for body, status, code in cases:
            token = self.token_for()
            self.assertEqual(self.hr_put(body).status_code, 200, body)
            r = self.client.get("/api/reception-devices/me", **self.auth(token))
            self.assertEqual((r.status_code, r.json().get("code")), (status, code), body)
            ReceptionDevice.objects.filter(pk=self.desk.pk).update(is_active=True)
        token = self.token_for()
        r = self.client.post(f"/api/reception-devices/{self.desk.id}/sign-out", **self.hr)
        self.assertEqual(r.json(), {"signedOut": 1})
        self.assertEqual(self.client.get("/api/reception-devices/me", **self.auth(token)).status_code, 401)

    def test_a_deleted_desk_is_refused(self):
        token = self.token_for()
        self.assertEqual(self.client.delete(f"/api/reception-devices/{self.desk.id}", **self.hr).status_code, 204)
        r = self.client.get("/api/reception-devices/summary", **self.auth(token))
        self.assertEqual((r.status_code, r.json()["code"]), (403, "desk_revoked"))

    # ── the wall between desk and HR tokens ──
    def test_hr_and_gate_tokens_are_refused_on_desk_endpoints_and_desk_tokens_on_hr_ones(self):
        for path in ("/api/reception-devices/me", "/api/reception-devices/summary", "/api/reception-devices/visits"):
            self.assertEqual(self.client.get(path, **self.hr).status_code, 403, path)
        gate = GateDevice(name="G", branch=self.branch, username="g.gate", login_token="tok-g")
        _gc.set_gate_password(gate, "gate-pass")
        gate.save()
        _s, gate_token = _gc.start_gate_session(gate, _Req())
        self.assertEqual(self.client.get("/api/reception-devices/me", **self.auth(gate_token)).status_code, 403)
        desk = self.auth(self.token_for())
        self.assertEqual(self.client.get("/api/reception-devices", **desk).status_code, 403)
        self.assertEqual(self.client.get("/api/visitor/records", **desk).status_code, 403)
        self.assertEqual(self.client.get("/api/gate-monitor/me", **desk).status_code, 403)

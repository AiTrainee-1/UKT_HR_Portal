"""The Employee Web App's "remember this browser" sign-in (owner 2026-11-25, employee_sessions.remember_browser).

A browser sign-in also gets the session token in an HttpOnly cookie sent only to /api/auth/; POST /auth/session/restore
signs the browser back in from it when the page lost its stored token. Same session: logout / HR ending it applies.
"""

import bcrypt
from django.core.cache import cache
from django.test import TestCase

from . import employee_sessions
from .models import Employee, EmployeeLoginSession

PASSWORD = "Secret#123"
WEB = "http://localhost:5173"  # in the default CORS_ALLOWED_ORIGINS
COOKIE = employee_sessions.WEB_COOKIE


def _hash(raw: str) -> str:
    return bcrypt.hashpw(raw.encode(), bcrypt.gensalt(rounds=4)).decode()


class WebSessionCookieTests(TestCase):
    def setUp(self):
        cache.clear()
        self.addCleanup(cache.clear)
        self.emp = Employee.objects.create(
            employee_code="WS100", first_name="Ravi", last_name="S", status="active", password_hash=_hash(PASSWORD)
        )

    def login(self, **headers):
        return self.client.post(
            "/api/auth/employee-login",
            {"identifier": "WS100", "password": PASSWORD},
            content_type="application/json",
            **headers,
        )

    def restore(self):
        return self.client.post("/api/auth/session/restore", {}, content_type="application/json", HTTP_ORIGIN=WEB)

    def test_a_browser_sign_in_sets_a_private_cookie_for_the_auth_endpoints_only(self):
        r = self.login(HTTP_ORIGIN=WEB)
        self.assertEqual(r.status_code, 200)
        c = r.cookies[COOKIE]
        self.assertEqual(c.value, r.json()["token"])
        self.assertTrue(c["httponly"])
        self.assertEqual(c["path"], "/api/auth/")
        self.assertGreater(int(c["max-age"]), 170 * 24 * 3600)

    def test_the_phone_app_never_gets_it(self):
        # no Origin header (the mobile app) or an origin that is not the web app
        self.assertNotIn(COOKIE, self.login().cookies)
        self.assertNotIn(COOKIE, self.login(HTTP_ORIGIN="https://evil.example").cookies)

    def test_a_browser_that_lost_its_token_is_signed_back_in_to_the_same_session(self):
        first = self.login(HTTP_ORIGIN=WEB).json()
        r = self.restore()
        self.assertEqual(r.status_code, 200)
        body = r.json()
        self.assertEqual((body["employeeId"], body["role"], body["accountStatus"]), (self.emp.id, "employee", "active"))
        self.assertEqual(EmployeeLoginSession.objects.filter(employee=self.emp).count(), 1)  # no new session
        me = self.client.get("/api/auth/me", HTTP_AUTHORIZATION=f"Bearer {body['token']}")
        self.assertEqual(me.status_code, 200)
        self.assertTrue(first["token"])

    def test_no_cookie_no_session(self):
        r = self.restore()
        self.assertEqual(r.status_code, 401)
        self.assertEqual(r.json()["code"], "no_session")

    def test_logout_ends_it_for_good_and_deletes_the_cookie(self):
        token = self.login(HTTP_ORIGIN=WEB).json()["token"]
        out = self.client.post("/api/auth/logout", {}, HTTP_AUTHORIZATION=f"Bearer {token}", HTTP_ORIGIN=WEB)
        self.assertEqual(out.status_code, 200)
        self.assertEqual(out.cookies[COOKIE].value, "")  # deleted
        # even a browser that kept a copy of the cookie cannot come back in
        self.client.cookies[COOKIE] = token
        r = self.restore()
        self.assertEqual((r.status_code, r.json()["code"]), (401, "ended"))

    def test_hr_ending_the_sessions_ends_it_too(self):
        self.login(HTTP_ORIGIN=WEB)
        employee_sessions.end_all(self.emp, "hr")
        self.assertEqual(self.restore().status_code, 401)

    def test_renewing_the_token_renews_the_cookie(self):
        token = self.login(HTTP_ORIGIN=WEB).json()["token"]
        r = self.client.post("/api/auth/refresh", {}, HTTP_AUTHORIZATION=f"Bearer {token}", HTTP_ORIGIN=WEB)
        self.assertEqual(r.status_code, 200)
        self.assertEqual(r.cookies[COOKIE].value, r.json()["token"])

    def test_an_inactive_account_comes_back_marked_inactive(self):
        self.login(HTTP_ORIGIN=WEB)
        Employee.objects.filter(pk=self.emp.pk).update(status="inactive")
        r = self.restore()
        self.assertEqual((r.status_code, r.json()["accountStatus"]), (200, "inactive"))

    def test_a_forged_cookie_is_refused(self):
        self.client.cookies[COOKIE] = "not-a-token"
        r = self.restore()
        self.assertEqual((r.status_code, r.json()["code"]), (401, "expired"))


from .tests_otp import OtpBase  # noqa: E402  (the WhatsApp code fixture)


class WebSessionAfterOtpSignInTests(OtpBase):
    def test_a_browser_signed_in_with_a_code_is_remembered_and_never_asked_for_a_new_code(self):
        r, code = self.request_code()
        self.assertEqual(r.status_code, 200)
        login = self.client.post(
            "/api/auth/otp/login", {"employeeCode": "E100", "otp": code}, content_type="application/json", HTTP_ORIGIN=WEB
        )
        self.assertEqual(login.status_code, 200)
        self.assertEqual(login.cookies[COOKIE].value, login.json()["token"])
        back = self.client.post("/api/auth/session/restore", {}, content_type="application/json", HTTP_ORIGIN=WEB)
        self.assertEqual((back.status_code, back.json()["employeeId"]), (200, self.emp.id))

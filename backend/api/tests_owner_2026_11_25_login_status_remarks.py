"""
Owner brief 2026-11-25 (mobile app round):
  * employee sign-in says exactly what is wrong: an employee code HRMS does not know ("unknown_employee"), a wrong
    password ("wrong_password"), no password yet ("no_password") - each with its own sentence;
  * the sign-in replies and GET /auth/me carry `accountStatus` ("active" | "inactive"), so the app can block an inactive
    account (and sign it out after 30 seconds); an inactive employee can still sign in and still reach /auth/me;
  * a Department Head's rejection from the mobile Approvals tab needs its reason (400 "remark_required") in EVERY
    category, an approval never needs one.

Run via: python manage.py test api.tests_owner_2026_11_25_login_status_remarks
"""

import bcrypt
from django.core.cache import cache
from django.test import TestCase

from . import approval_workflow as approval
from .jwt_utils import sign_token
from .models import DepartmentManager, Employee, ManagerEmployeeAssignment
from .tests_hr_requests import HubFixture, _employee

PASSWORD = "correct-horse-1"


def _hash(raw: str) -> str:
    return bcrypt.hashpw(raw.encode(), bcrypt.gensalt(rounds=4)).decode()


class EmployeeLoginMessagesTests(TestCase):
    def setUp(self):
        cache.clear()  # the per-IP throttles count in the cache
        self.addCleanup(cache.clear)
        self.emp = Employee.objects.create(
            employee_code="LG100", first_name="Asha", last_name="Kumar", status="active", password_hash=_hash(PASSWORD)
        )

    def login(self, identifier, password):
        return self.client.post(
            "/api/auth/employee-login", {"identifier": identifier, "password": password}, content_type="application/json"
        )

    def test_an_unknown_employee_code_says_so(self):
        r = self.login("NOPE-1", PASSWORD)
        self.assertEqual(r.status_code, 401)
        self.assertEqual(
            r.json(), {"error": "This employee code does not exist in HRMS.", "code": "unknown_employee"}
        )

    def test_a_wrong_password_says_so(self):
        r = self.login("LG100", "wrong-password")
        self.assertEqual(r.status_code, 401)
        self.assertEqual(r.json(), {"error": "Incorrect password.", "code": "wrong_password"})

    def test_no_password_yet_keeps_its_message_with_a_code(self):
        Employee.objects.filter(pk=self.emp.pk).update(password_hash="")
        r = self.login("LG100", PASSWORD)
        self.assertEqual(r.status_code, 401)
        self.assertEqual(r.json()["code"], "no_password")
        self.assertEqual(r.json()["error"], "No password set. Please set your password first.")

    def test_a_good_sign_in_keeps_its_shape_and_says_the_account_is_active(self):
        r = self.login("LG100", PASSWORD)
        self.assertEqual(r.status_code, 200, r.content)
        body = r.json()
        self.assertEqual(
            (body["role"], body["employeeId"], body["name"], body["accountStatus"], body["employeeStatus"]),
            ("employee", self.emp.id, "Asha Kumar", "active", "active"),
        )
        self.assertTrue(body["token"])

    def test_an_inactive_employee_still_signs_in_and_is_told_inactive(self):
        Employee.objects.filter(pk=self.emp.pk).update(status="inactive")
        r = self.login("LG100", PASSWORD)
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual((r.json()["accountStatus"], r.json()["employeeStatus"]), ("inactive", "inactive"))
        # /auth/me still answers for the inactive account, and says so
        me = self.client.get("/api/auth/me", HTTP_AUTHORIZATION=f"Bearer {r.json()['token']}")
        self.assertEqual(me.status_code, 200, me.content)
        self.assertEqual((me.json()["employeeId"], me.json()["accountStatus"]), (self.emp.id, "inactive"))
        # signing out works too
        out = self.client.post("/api/auth/logout", HTTP_AUTHORIZATION=f"Bearer {r.json()['token']}")
        self.assertEqual(out.status_code, 200)

    def test_auth_me_follows_the_status_while_signed_in(self):
        token = self.login("LG100", PASSWORD).json()["token"]
        auth = {"HTTP_AUTHORIZATION": f"Bearer {token}"}
        self.assertEqual(self.client.get("/api/auth/me", **auth).json()["accountStatus"], "active")
        for raw in ("inactive", "terminated", "resigned", ""):
            Employee.objects.filter(pk=self.emp.pk).update(status=raw)
            self.assertEqual(self.client.get("/api/auth/me", **auth).json()["accountStatus"], "inactive", raw)
        Employee.objects.filter(pk=self.emp.pk).update(status="Active ")
        self.assertEqual(self.client.get("/api/auth/me", **auth).json()["accountStatus"], "active")

    def test_hr_tokens_get_no_account_status(self):
        token = sign_token({"role": "hr", "hrUserId": 999999, "name": "HR"})
        me = self.client.get("/api/auth/me", HTTP_AUTHORIZATION=f"Bearer {token}")
        self.assertNotIn("accountStatus", me.json())


class DepartmentHeadRejectionNeedsItsReasonTests(HubFixture):
    """Every PATCH the mobile Approvals tab decides with: a rejection without its reason is refused (400 remark_required)
    and changes nothing; the same rejection with the reason goes through."""

    URLS = {
        "leave": ("/api/manager/leave-requests/{}/status", "status"),
        "permission": ("/api/manager/permissions/{}/status", "status"),
        "casual_leave": ("/api/manager/casual-leaves/{}/status", "status"),
        "attendance_correction": ("/api/manager/attendance-requests/{}/status", "status"),
        "missing_punch": ("/api/manager/missing-punch-requests/{}/status", "status"),
        "on_duty": ("/api/manager/on-duty-sessions/{}/status", "status"),
        "outpass": ("/api/manager/outpass-requests/{}/status", "status"),
        "holiday_work": ("/api/manager/holiday-work/{}/status", "status"),
        "resignation": ("/api/manager/resignations/{}/action", "action"),
    }

    def setUp(self):
        super().setUp()
        self.boss = _employee("RQB", self.ho, self.cutting)
        self.manager = DepartmentManager.objects.create(employee=self.boss)
        ManagerEmployeeAssignment.objects.create(manager=self.manager, employee=self.asha)
        self.auth = {"HTTP_AUTHORIZATION": f"Bearer {sign_token({'role': 'employee', 'employeeId': self.boss.id})}"}

    def patch(self, url, body):
        return self.client.patch(url, body, content_type="application/json", **self.auth)

    def test_every_category_refuses_a_rejection_without_its_reason(self):
        made = self.one_of_each()
        checked = []
        for kind, (pattern, key) in self.URLS.items():
            obj = made[kind]
            workflow = "attendance_correction" if kind == "attendance_correction" else kind
            if not approval.can_act(workflow, obj, approval.HOD, for_actor=False):
                continue  # HR's default pipeline gives the head no step here: nothing to decide
            reject = "reject" if key == "action" else "rejected"
            url = pattern.format(obj.id)
            before = type(obj).objects.get(pk=obj.pk).status
            for comment in (None, "", "  ", "no"):
                body = {key: reject} if comment is None else {key: reject, "comment": comment}
                with self.subTest(kind=kind, comment=comment):
                    r = self.patch(url, body)
                    self.assertEqual((r.status_code, r.json().get("code")), (400, approval.REJECT_REMARK_CODE), r.content)
                    self.assertEqual(r.json()["error"], approval.REJECT_REMARK_MESSAGE)
            self.assertEqual(type(obj).objects.get(pk=obj.pk).status, before, kind)
            r = self.patch(url, {key: reject, "comment": "Not this week"})
            self.assertEqual(r.status_code, 200, (kind, r.content))
            checked.append(kind)
        # the default pipelines give the Department Head a step in every category: the check ran for all nine
        self.assertEqual(checked, list(self.URLS))

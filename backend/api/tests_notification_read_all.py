"""Notifications: Mark all read in ONE request (HR and employees), the unread count, and the resignations status list.

App health audit 2026-11-05: HR's "Mark all read" sent one request per unread message (each followed by a reload of the
whole list) and took the single-worker server down; the sidebar polled every unread message (up to 2,000) every 12 s
just to show a count.
"""

from django.test import TestCase

from .jwt_utils import sign_token
from .models import Branch, Employee, HRUser, Notification, ResignationRequest, Role


def _bearer(payload: dict) -> dict:
    return {"HTTP_AUTHORIZATION": f"Bearer {sign_token(payload)}"}


class MarkAllReadTests(TestCase):
    @classmethod
    def setUpTestData(cls):
        cls.b1 = Branch.objects.create(name="Unit A", code="NRA")
        cls.b2 = Branch.objects.create(name="Unit B", code="NRB")

        def emp(code, branch):
            return Employee.objects.create(
                employee_code=code, first_name=code, last_name="T", employment_type="staff", status="active",
                branch=branch,
            )  # fmt: skip

        cls.a1, cls.a2, cls.b = emp("NR1", cls.b1), emp("NR2", cls.b1), emp("NR3", cls.b2)
        cls.admin = HRUser.objects.create(username="nr_admin", password_hash="x", is_super_admin=True)
        role = Role.objects.create(name="nr_branch", permissions={"notifications": "edit"})
        cls.branch_hr = HRUser.objects.create(username="nr_branch", password_hash="x", role=role, branch=cls.b1)

    def setUp(self):
        for e in (self.a1, self.a1, self.a2, self.b):
            Notification.objects.create(employee=e, type="general", message=f"hello {e.employee_code}")

    def hr(self, user):
        return _bearer({"role": "hr", "hrUserId": user.id})

    def unread(self, emp=None):
        qs = Notification.objects.filter(is_read=False)
        return qs.filter(employee=emp).count() if emp else qs.count()

    def test_hr_marks_every_notification_it_can_see_in_one_request(self):
        r = self.client.patch("/api/notifications/mark-all-read", **self.hr(self.admin))
        self.assertEqual(r.status_code, 200)
        self.assertEqual(r.json(), {"updated": 4})
        self.assertEqual(self.unread(), 0)

    def test_a_branch_hr_marks_only_its_branch(self):
        r = self.client.patch("/api/notifications/mark-all-read", **self.hr(self.branch_hr))
        self.assertEqual(r.json(), {"updated": 3})
        self.assertEqual((self.unread(self.a1), self.unread(self.a2), self.unread(self.b)), (0, 0, 1))

    def test_an_employee_marks_only_their_own(self):
        r = self.client.patch(
            "/api/notifications/mark-all-read", **_bearer({"role": "employee", "employeeId": self.a1.id})
        )
        self.assertEqual(r.json(), {"updated": 2})
        self.assertEqual((self.unread(self.a1), self.unread()), (0, 2))

    def test_the_unread_count_is_a_number_scoped_like_the_list(self):
        url = "/api/notifications?unreadOnly=true&countOnly=1"
        self.assertEqual(self.client.get(url, **self.hr(self.admin)).json(), {"count": 4})
        self.assertEqual(self.client.get(url, **self.hr(self.branch_hr)).json(), {"count": 3})
        Notification.objects.filter(employee=self.a2).update(is_read=True)
        self.assertEqual(self.client.get(url, **self.hr(self.admin)).json(), {"count": 3})
        # the list itself is unchanged
        self.assertEqual(len(self.client.get("/api/notifications?unreadOnly=true", **self.hr(self.admin)).json()), 3)


class ResignationStatusListTests(TestCase):
    def test_several_statuses_comma_separated(self):
        admin = HRUser.objects.create(username="rs_admin", password_hash="x", is_super_admin=True)
        for i, status in enumerate(("pending", "dept_approved", "approved", "rejected")):
            e = Employee.objects.create(
                employee_code=f"RS{i}", first_name="R", last_name=str(i), employment_type="staff", status="active"
            )
            ResignationRequest.objects.create(employee=e, status=status, reason="x")
        auth = _bearer({"role": "hr", "hrUserId": admin.id})
        got = self.client.get("/api/recruitment/resignations?status=pending,dept_approved", **auth).json()
        self.assertEqual(sorted(r["status"] for r in got), ["dept_approved", "pending"])
        one = self.client.get("/api/recruitment/resignations?status=approved", **auth).json()
        self.assertEqual([r["status"] for r in one], ["approved"])  # one status works as before

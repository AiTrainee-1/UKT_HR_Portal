"""
Employee Enquiries (2026-11-24): the mobile app raises them, HR handles them as a to-do list, the employee is pushed.

Run via: python manage.py test api.tests_enquiries -v 2
"""

from django.test import TestCase
from rest_framework.test import APIClient

from .jwt_utils import sign_token
from .models import Branch, Employee, Enquiry, HRUser, Notification
from .notification_targets import target_for


def _employee(code: str, branch) -> Employee:
    return Employee.objects.create(
        employee_code=code, first_name="Emp", last_name=code, status="active", employment_type="staff",
        join_date="2020-01-01", branch=branch,
    )


class EnquiryTests(TestCase):
    def setUp(self):
        self.branch = Branch.objects.create(name="Enq HO", code="ENQ-HO")
        self.emp = _employee("ENQ1", self.branch)
        self.other = _employee("ENQ2", self.branch)
        self.hr = HRUser.objects.create(username="enq_admin", password_hash="x", is_super_admin=True, full_name="Meena HR")
        self.client = APIClient()

    def as_emp(self, emp=None):
        return {"HTTP_AUTHORIZATION": "Bearer " + sign_token({"role": "employee", "employeeId": (emp or self.emp).id})}

    def as_hr(self):
        return {"HTTP_AUTHORIZATION": "Bearer " + sign_token({"role": "hr", "hrUserId": self.hr.id, "name": "Meena HR"})}

    def raise_one(self, subject="PF amount looks wrong", emp=None):
        r = self.client.post(
            "/api/my/enquiries", {"category": "salary", "subject": subject, "message": "For October"},
            format="json", **self.as_emp(emp),
        )
        self.assertEqual(r.status_code, 201, r.content)
        return r.json()

    def test_an_employee_raises_and_lists_only_their_own(self):
        mine = self.raise_one()
        self.raise_one("Someone else's", emp=self.other)
        self.assertEqual(mine["status"], "pending")
        rows = self.client.get("/api/my/enquiries", **self.as_emp()).json()
        self.assertEqual([r["subject"] for r in rows], ["PF amount looks wrong"])

    def test_validation(self):
        r = self.client.post("/api/my/enquiries", {"category": "salary", "subject": "Hi"}, format="json", **self.as_emp())
        self.assertEqual(r.status_code, 400)
        r = self.client.post("/api/my/enquiries", {"category": "nope", "subject": "Hello"}, format="json", **self.as_emp())
        self.assertEqual(r.status_code, 400)
        r = self.client.post("/api/my/enquiries", {"subject": "Hello"}, format="json", **self.as_hr())
        self.assertEqual(r.status_code, 403)

    def test_hr_works_through_them_and_the_employee_is_told(self):
        e = self.raise_one()
        self.raise_one("Bank letter", emp=self.other)
        body = self.client.get("/api/enquiries?status=pending", **self.as_hr()).json()
        self.assertEqual(body["counts"], {"pending": 2, "onHold": 0, "done": 0, "all": 2})
        self.assertEqual(body["items"][0]["employee"]["employeeCode"], "ENQ1")  # oldest first: a to-do list

        r = self.client.patch(f"/api/enquiries/{e['id']}", {"status": "on_hold", "reply": "Checking with payroll"},
                              format="json", **self.as_hr())
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual((r.json()["status"], r.json()["hrReply"], r.json()["handledBy"]),
                         ("on_hold", "Checking with payroll", "Meena HR"))
        note = Notification.objects.get(employee=self.emp, type="enquiry")
        self.assertIn("on hold", note.message)
        self.assertEqual(target_for(note)["kind"], "enquiry")
        self.assertEqual(target_for(note)["id"], e["id"])

        r = self.client.patch(f"/api/enquiries/{e['id']}", {"status": "done"}, format="json", **self.as_hr())
        self.assertIsNotNone(r.json()["doneAt"])
        self.assertEqual(len(r.json()["history"]), 2)
        self.assertEqual(Notification.objects.filter(employee=self.emp, type="enquiry").count(), 2)
        summary = self.client.get("/api/enquiries/summary", **self.as_hr()).json()
        self.assertEqual((summary["pending"], summary["done"]), (1, 1))
        self.assertEqual(summary["latest"]["subject"], "Bank letter")

        # nothing changed, nothing sent
        self.client.patch(f"/api/enquiries/{e['id']}", {"status": "done"}, format="json", **self.as_hr())
        self.assertEqual(Notification.objects.filter(employee=self.emp, type="enquiry").count(), 2)

    def test_an_employee_cannot_use_the_hr_side(self):
        e = self.raise_one()
        self.assertEqual(self.client.get("/api/enquiries", **self.as_emp()).status_code, 403)
        self.assertEqual(
            self.client.patch(f"/api/enquiries/{e['id']}", {"status": "done"}, format="json", **self.as_emp()).status_code,
            403,
        )
        self.assertEqual(Enquiry.objects.get(pk=e["id"]).status, "pending")

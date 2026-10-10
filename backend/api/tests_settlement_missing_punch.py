"""Settlement and Missing Punch list contracts. The redesigned HR pages filter by branch, employee type and whether the
employee has left, so both lists now also send those fields; every field they sent before must still be there.

Run via: python manage.py test api.tests_settlement_missing_punch -v 2
"""

from datetime import date, time
from decimal import Decimal

from django.db import connection
from django.test import TestCase
from django.test.utils import CaptureQueriesContext

from .jwt_utils import sign_token
from .models import Advance, Branch, Department, Employee, HRUser, MissingPunchRequest


def _bearer(payload: dict) -> dict:
    return {"HTTP_AUTHORIZATION": f"Bearer {sign_token(payload)}"}


class ListContractTests(TestCase):
    def setUp(self):
        admin, _ = HRUser.objects.get_or_create(
            username="settle_admin", defaults={"password_hash": "x", "is_super_admin": True}
        )
        self.hr = _bearer({"role": "hr", "hrUserId": admin.id, "name": "Admin"})
        self.branch = Branch.objects.create(name="Tiruppur Unit")
        dept = Department.objects.create(name="Stitching")
        self.emp = Employee.objects.create(
            employee_code="ST1",
            first_name="Asha",
            last_name="Kumar",
            status="active",
            employment_type="production",
            department=dept,
            branch=self.branch,
            join_date="2020-01-01",
        )
        self.advance = Advance.objects.create(
            employee=self.emp, advance_type="general", amount=Decimal("5000"), outstanding=Decimal("5000")
        )
        self.punch = MissingPunchRequest.objects.create(
            employee=self.emp,
            date=date(2026, 9, 1),
            punch_time=time(9, 5),
            punch_type="IN",
            punch_slot="morning_in",
            reason="Forgot",
            status="pending_hr",
        )

    def get(self, path):
        return self.client.get(path, **self.hr)

    # ── Settlement ──

    def test_advances_carry_the_employee_branch_type_and_status(self):
        rows = self.get("/api/advances").json()
        row = next(r for r in rows if r["id"] == self.advance.id)
        self.assertEqual(row["employeeBranch"], "Tiruppur Unit")
        self.assertEqual(row["employeeBranchId"], self.branch.id)
        self.assertEqual(row["employeeType"], "production")
        self.assertEqual(row["employeeStatus"], "active")

    def test_advances_still_carry_every_field_older_clients_read(self):
        row = self.get(f"/api/advances/{self.advance.id}").json()
        for key in (
            "id", "employeeId", "employeeCode", "employeeName", "employeeDepartment", "employeeDesignation",
            "employeePhone", "employeeEmail", "advanceType", "amount", "purpose", "status", "approvedBy",
            "approvedAt", "disbursedAt", "repaymentStartMonth", "repaymentStartYear", "repaymentMonths",
            "emiAmount", "totalRepaid", "outstanding", "notes", "createdAt", "updatedAt", "repayments",
        ):  # fmt: skip
            self.assertIn(key, row)
        self.assertEqual((row["employeeDepartment"], row["amount"], row["outstanding"]), ("Stitching", 5000.0, 5000.0))

    def test_an_employee_without_a_branch_sends_null_not_an_error(self):
        self.emp.branch = None
        self.emp.status = "inactive"
        self.emp.save()
        row = self.get("/api/advances").json()[0]
        self.assertEqual(
            (row["employeeBranch"], row["employeeBranchId"], row["employeeStatus"]), (None, None, "inactive")
        )

    def test_the_list_does_not_query_the_branch_once_per_advance(self):
        with CaptureQueriesContext(connection) as one:
            self.get("/api/advances")
        for n in range(4):
            Advance.objects.create(
                employee=self.emp,
                advance_type="term",
                amount=Decimal("1000"),
                outstanding=Decimal("1000"),
                purpose=str(n),
            )
        with CaptureQueriesContext(connection) as five:
            self.get("/api/advances")
        self.assertEqual(len(one), len(five))

    # ── Missing Punch ──

    def test_missing_punch_requests_carry_the_branch(self):
        rows = self.get("/api/missing-punch-requests?status=all").json()
        row = next(r for r in rows if r["id"] == self.punch.id)
        self.assertEqual((row["branch"], row["branchId"]), ("Tiruppur Unit", self.branch.id))

    def test_missing_punch_requests_still_carry_every_field_older_clients_read(self):
        row = self.get("/api/missing-punch-requests?status=all").json()[0]
        for key in (
            "id", "employeeId", "employeeCode", "employeeName", "department", "designation", "date", "punchTime",
            "punchType", "punchSlot", "reason", "status", "hodReviewedBy", "hodReviewComment", "hodReviewedAt",
            "hrReviewedBy", "hrReviewComment", "hrReviewedAt", "createdAt", "approval",
        ):  # fmt: skip
            self.assertIn(key, row)
        self.assertEqual((row["punchTime"], row["status"]), ("09:05", "pending_hr"))

    def test_hr_decides_with_a_comment_and_it_is_recorded(self):
        r = self.client.patch(
            f"/api/missing-punch-requests/{self.punch.id}/status",
            data={"status": "approved", "comment": "checked the gate log"},
            content_type="application/json",
            **self.hr,
        )
        self.assertEqual(r.status_code, 200, r.content)
        body = r.json()
        self.assertEqual((body["status"], body["hrReviewComment"]), ("approved", "checked the gate log"))
        self.assertTrue(body["hrReviewedAt"])

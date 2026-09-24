"""
Who can read / change what.

Every case here is a horizontal-privilege or wrong-token-type hole that used to
be open: an employee token reading a colleague's payroll, attendance, leave or
dashboard; a QR-pass token (tea-break, outpass) working as a login; anyone
resetting an employee's password; a department head re-deciding or approving
their own requests.

Run via: python manage.py test api.tests_access_control -v 2
"""

from datetime import date, timedelta
from decimal import Decimal

import bcrypt
from django.test import TestCase

from .jwt_utils import sign_token
from .models import (
    Attendance,
    DepartmentManager,
    Employee,
    EmployeePermission,
    HRUser,
    LeaveRequest,
    ManagerEmployeeAssignment,
    Notification,
    OutpassRequest,
    Payroll,
)


def _bearer(payload: dict, **kw) -> dict:
    return {"HTTP_AUTHORIZATION": f"Bearer {sign_token(payload, **kw)}"}


def _hr():
    # permission_middleware rejects an HR token whose account doesn't exist, so
    # the token has to point at a real (super-admin, hence unscoped) HRUser.
    admin, _ = HRUser.objects.get_or_create(
        username="acl_admin",
        defaults={"password_hash": "x", "is_super_admin": True},
    )
    return _bearer({"role": "hr", "hrUserId": admin.id})


def _emp(emp_id: int):
    return _bearer({"role": "employee", "employeeId": emp_id})


def _employee(code: str, **kw) -> Employee:
    return Employee.objects.create(
        employee_code=code,
        first_name=code,
        last_name="Test",
        employment_type="staff",
        status="active",
        **kw,
    )


class _Base(TestCase):
    @classmethod
    def setUpTestData(cls):
        cls.alice = _employee("ACL_A", phone="9000000001")
        cls.bob = _employee("ACL_B", phone="9000000002")
        for e, amount in ((cls.alice, "20000.00"), (cls.bob, "90000.00")):
            Payroll.objects.create(
                employee=e,
                salary_mode="monthly",
                month=1,
                year=2026,
                base_salary=Decimal(amount),
                gross_salary=Decimal(amount),
                final_salary=Decimal(amount),
            )
            Attendance.objects.create(employee=e, date="2026-01-05", present=True)
            LeaveRequest.objects.create(
                employee=e,
                start_date="2026-02-01",
                end_date="2026-02-01",
                reason=f"{e.employee_code} private reason",
            )


class PayrollAndAttendanceIsolationTests(_Base):
    def test_employee_cannot_read_another_employees_salary(self):
        r = self.client.get(f"/api/salary-records?employeeId={self.bob.id}", **_emp(self.alice.id))
        self.assertEqual(r.status_code, 200)
        self.assertEqual({row["employeeId"] for row in r.json()}, {self.alice.id})
        self.assertNotIn(90000.0, [row["amount"] for row in r.json()])

    def test_employee_salary_without_employee_id_returns_own(self):
        r = self.client.get("/api/salary-records", **_emp(self.alice.id))
        self.assertEqual(r.status_code, 200)
        self.assertEqual({row["employeeId"] for row in r.json()}, {self.alice.id})

    def test_hr_can_read_any_salary(self):
        r = self.client.get(f"/api/salary-records?employeeId={self.bob.id}", **_hr())
        self.assertEqual(r.status_code, 200)
        self.assertEqual([row["amount"] for row in r.json()], [90000.0])

    def test_salary_requires_login(self):
        self.assertEqual(self.client.get(f"/api/salary-records?employeeId={self.bob.id}").status_code, 401)

    def test_attendance_list_only_returns_own_rows_for_employee(self):
        r = self.client.get("/api/attendance", **_emp(self.alice.id))
        self.assertEqual(r.status_code, 200)
        self.assertEqual({row["employeeId"] for row in r.json()}, {self.alice.id})

    def test_attendance_employee_id_param_cannot_widen_scope(self):
        r = self.client.get(f"/api/attendance?employeeId={self.bob.id}", **_emp(self.alice.id))
        self.assertEqual({row["employeeId"] for row in r.json()}, {self.alice.id})

    def test_hr_sees_all_attendance(self):
        r = self.client.get("/api/attendance", **_hr())
        self.assertEqual({row["employeeId"] for row in r.json()}, {self.alice.id, self.bob.id})

    def test_dashboard_summary_ignores_other_employee_id(self):
        r = self.client.get(f"/api/dashboard/employee-summary?employeeId={self.bob.id}", **_emp(self.alice.id))
        self.assertEqual(r.status_code, 200)
        self.assertEqual(r.json()["employeeId"], self.alice.id)

    def test_dashboard_summary_hr_needs_an_employee_id(self):
        self.assertEqual(self.client.get("/api/dashboard/employee-summary", **_hr()).status_code, 400)
        r = self.client.get(f"/api/dashboard/employee-summary?employeeId={self.bob.id}", **_hr())
        self.assertEqual(r.json()["employeeId"], self.bob.id)


class LeaveIsolationTests(_Base):
    def test_leave_list_only_returns_own_requests(self):
        r = self.client.get("/api/leave-requests", **_emp(self.alice.id))
        self.assertEqual(r.status_code, 200)
        self.assertEqual({row["employeeId"] for row in r.json()}, {self.alice.id})

    def test_leave_list_filters_cannot_reach_a_colleague(self):
        for qs in (f"employeeId={self.bob.id}", f"employeeCode={self.bob.employee_code}"):
            r = self.client.get(f"/api/leave-requests?{qs}", **_emp(self.alice.id))
            self.assertEqual({row["employeeId"] for row in r.json()}, {self.alice.id}, qs)
            self.assertNotIn("ACL_B private reason", str(r.json()))

    def test_hr_sees_all_leave(self):
        r = self.client.get("/api/leave-requests", **_hr())
        self.assertEqual({row["employeeId"] for row in r.json()}, {self.alice.id, self.bob.id})

    def test_employee_cannot_file_leave_for_someone_else(self):
        r = self.client.post(
            "/api/leave-requests",
            {"employeeId": self.bob.id, "startDate": "2026-03-01"},
            content_type="application/json",
            **_emp(self.alice.id),
        )
        self.assertEqual(r.status_code, 403)
        self.assertFalse(LeaveRequest.objects.filter(employee=self.bob, start_date="2026-03-01").exists())

    def test_employee_leave_is_always_filed_for_the_token_owner(self):
        r = self.client.post(
            "/api/leave-requests",
            {"startDate": "2026-03-01"},
            content_type="application/json",
            **_emp(self.alice.id),
        )
        self.assertEqual(r.status_code, 201)
        self.assertEqual(r.json()["employeeId"], self.alice.id)

    def test_employee_can_file_leave_for_self_explicitly(self):
        r = self.client.post(
            "/api/leave-requests",
            {"employeeId": self.alice.id, "startDate": "2026-03-02"},
            content_type="application/json",
            **_emp(self.alice.id),
        )
        self.assertEqual(r.status_code, 201)

    def test_employee_cannot_self_approve_a_permission(self):
        r = self.client.post(
            "/api/permissions",
            {"employeeId": self.alice.id, "date": "2026-03-03", "status": "approved"},
            content_type="application/json",
            **_emp(self.alice.id),
        )
        self.assertEqual(r.status_code, 201)
        self.assertEqual(EmployeePermission.objects.get(pk=r.json()["id"]).status, "pending")

    def test_hr_can_create_a_decided_permission(self):
        r = self.client.post(
            "/api/permissions",
            {"employeeId": self.alice.id, "date": "2026-03-04", "status": "approved"},
            content_type="application/json",
            **_hr(),
        )
        self.assertEqual(r.status_code, 201)
        self.assertEqual(EmployeePermission.objects.get(pk=r.json()["id"]).status, "approved")

    def test_employee_cannot_file_a_request_in_anyones_name(self):
        body = {"employeeId": self.bob.id, "subject": "hi", "requestType": "other"}
        r = self.client.post("/api/employee-requests", body, content_type="application/json", **_emp(self.alice.id))
        self.assertEqual(r.status_code, 403)


class TokenTypeTests(_Base):
    """QR-pass and kiosk tokens share the signing key but are not logins."""

    def _assert_rejected(self, token_payload, url="/api/salary-records?employeeId=1"):
        r = self.client.get(url, **_bearer(token_payload))
        self.assertEqual(r.status_code, 403, token_payload)

    def test_tea_break_token_is_not_a_login(self):
        self._assert_rejected({"role": "tea_break", "employeeId": self.alice.id}, "/api/notifications")
        self._assert_rejected({"role": "tea_break", "employeeId": self.alice.id})

    def test_outpass_tokens_are_not_logins(self):
        self._assert_rejected({"role": "outpass_pass", "requestId": 1}, "/api/notifications")
        self._assert_rejected({"role": "outpass_return", "requestId": 1}, "/api/notifications")

    def test_device_tokens_are_not_logins(self):
        self._assert_rejected({"role": "gate_device", "deviceId": 1}, "/api/notifications")
        self._assert_rejected({"role": "reception_device", "deviceId": 1}, "/api/notifications")

    def test_token_without_a_role_is_rejected(self):
        self._assert_rejected({"employeeId": self.alice.id}, "/api/notifications")

    def test_employee_and_hr_tokens_still_pass(self):
        self.assertEqual(self.client.get("/api/notifications", **_emp(self.alice.id)).status_code, 200)
        self.assertEqual(self.client.get("/api/notifications", **_hr()).status_code, 200)

    def test_hr_only_endpoints_reject_employee_tokens(self):
        self.assertEqual(self.client.get("/api/employees", **_emp(self.alice.id)).status_code, 403)

    def test_employee_cannot_plant_a_notification(self):
        r = self.client.post(
            "/api/notifications",
            {"employeeId": self.bob.id, "message": "fake"},
            content_type="application/json",
            **_emp(self.alice.id),
        )
        self.assertEqual(r.status_code, 403)
        self.assertFalse(Notification.objects.filter(employee=self.bob).exists())


class PasswordTests(TestCase):
    def setUp(self):
        self.fresh = _employee("PW_NEW", phone="9111111111")
        self.existing = _employee("PW_OLD", phone="9222222222")
        self.existing.password_hash = bcrypt.hashpw(b"original-pass", bcrypt.gensalt(rounds=4)).decode()
        self.existing.save()
        self.other = _employee("PW_OTHER", phone="9333333333")

    def _set(self, identifier, password, **headers):
        return self.client.post(
            "/api/auth/set-password",
            {"identifier": identifier, "password": password},
            content_type="application/json",
            **headers,
        )

    def test_first_time_setup_needs_no_login(self):
        r = self._set(self.fresh.employee_code, "brand-new-pass")
        self.assertEqual(r.status_code, 200)
        self.fresh.refresh_from_db()
        self.assertTrue(bcrypt.checkpw(b"brand-new-pass", self.fresh.password_hash.encode()))

    def test_stranger_cannot_overwrite_an_existing_password(self):
        before = Employee.objects.get(pk=self.existing.pk).password_hash
        r = self._set(self.existing.employee_code, "attacker-pass")
        self.assertEqual(r.status_code, 403)
        self.assertEqual(Employee.objects.get(pk=self.existing.pk).password_hash, before)

    def test_another_employees_token_cannot_overwrite_it(self):
        r = self._set(self.existing.employee_code, "attacker-pass", **_emp(self.other.id))
        self.assertEqual(r.status_code, 403)

    def test_a_qr_token_cannot_overwrite_it(self):
        token = _bearer({"role": "tea_break", "employeeId": self.existing.id}, expires_in=timedelta(days=3650))
        self.assertEqual(self._set(self.existing.employee_code, "attacker-pass", **token).status_code, 403)

    def test_owner_can_change_their_own_password(self):
        r = self._set(self.existing.employee_code, "my-new-password", **_emp(self.existing.id))
        self.assertEqual(r.status_code, 200)
        self.existing.refresh_from_db()
        self.assertTrue(bcrypt.checkpw(b"my-new-password", self.existing.password_hash.encode()))

    def test_short_or_missing_password_rejected(self):
        self.assertEqual(self._set(self.fresh.employee_code, "short").status_code, 400)
        self.assertEqual(self._set("", "long-enough-pass").status_code, 400)

    def test_employee_login_requires_both_fields(self):
        r = self.client.post("/api/auth/employee-login", {"identifier": "PW_OLD"}, content_type="application/json")
        self.assertEqual(r.status_code, 400)


class ManagerApprovalTests(TestCase):
    @classmethod
    def setUpTestData(cls):
        cls.head = _employee("MGR_HEAD")
        cls.member = _employee("MGR_MEMBER")
        cls.manager = DepartmentManager.objects.create(employee=cls.head)
        ManagerEmployeeAssignment.objects.create(manager=cls.manager, employee=cls.member)
        # The head is also (mis)assigned to themselves, e.g. via their own department.
        ManagerEmployeeAssignment.objects.create(manager=cls.manager, employee=cls.head)

    def _patch(self, url, status="approved"):
        return self.client.patch(url, {"status": status}, content_type="application/json", **_emp(self.head.id))

    def _leave(self, employee, **kw):
        return LeaveRequest.objects.create(
            employee=employee,
            start_date="2026-04-01",
            end_date="2026-04-01",
            **kw,
        )

    def test_head_can_decide_a_team_members_pending_leave(self):
        leave = self._leave(self.member)
        r = self._patch(f"/api/manager/leave-requests/{leave.id}/status")
        self.assertEqual(r.status_code, 200)
        leave.refresh_from_db()
        self.assertEqual((leave.status, leave.approver_role), ("approved", "dept_head"))

    def test_head_cannot_flip_an_already_decided_leave(self):
        leave = self._leave(self.member, status="rejected", approved_by="HR", approver_role="hr")
        r = self._patch(f"/api/manager/leave-requests/{leave.id}/status")
        self.assertEqual(r.status_code, 400)
        leave.refresh_from_db()
        self.assertEqual((leave.status, leave.approver_role), ("rejected", "hr"))

    def test_head_cannot_approve_their_own_leave(self):
        leave = self._leave(self.head)
        r = self._patch(f"/api/manager/leave-requests/{leave.id}/status")
        self.assertEqual(r.status_code, 403)
        leave.refresh_from_db()
        self.assertEqual(leave.status, "pending")

    def test_head_cannot_approve_their_own_permission(self):
        perm = EmployeePermission.objects.create(employee=self.head, date=date(2026, 4, 2))
        r = self._patch(f"/api/manager/permissions/{perm.id}/status")
        self.assertEqual(r.status_code, 403)
        perm.refresh_from_db()
        self.assertEqual(perm.status, "pending")

    def test_head_cannot_flip_an_already_decided_permission(self):
        perm = EmployeePermission.objects.create(employee=self.member, date=date(2026, 4, 2), status="approved")
        self.assertEqual(self._patch(f"/api/manager/permissions/{perm.id}/status", "rejected").status_code, 400)
        perm.refresh_from_db()
        self.assertEqual(perm.status, "approved")

    def test_outpass_cannot_be_redecided_and_creates_one_record(self):
        req = OutpassRequest.objects.create(employee=self.member, destination="Bank", reason="Personal")
        url = f"/api/manager/outpass-requests/{req.id}/status"
        self.assertEqual(self._patch(url).status_code, 200)
        self.assertEqual(self._patch(url).status_code, 400)
        self.assertEqual(self._patch(url, "rejected").status_code, 400)
        req.refresh_from_db()
        self.assertEqual(req.status, "approved")

    def test_head_cannot_approve_their_own_outpass(self):
        req = OutpassRequest.objects.create(employee=self.head, destination="Bank", reason="Personal")
        self.assertEqual(self._patch(f"/api/manager/outpass-requests/{req.id}/status").status_code, 403)
        req.refresh_from_db()
        self.assertEqual(req.status, "pending")

    def test_non_manager_employee_cannot_approve(self):
        leave = self._leave(self.member)
        r = self.client.patch(
            f"/api/manager/leave-requests/{leave.id}/status",
            {"status": "approved"},
            content_type="application/json",
            **_emp(self.member.id),
        )
        self.assertEqual(r.status_code, 403)

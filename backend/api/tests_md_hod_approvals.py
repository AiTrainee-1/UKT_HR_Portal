"""MD portal · HOD approvals (/api/md/approvals/, md_portal/hod_approvals.py).

Run:  DATABASE_URL= DB_TEST_NAME=test_uktex_md_hod python manage.py test api.tests_md_hod_approvals --noinput

  MD department:        Suresh Raj W9 is a Department Head; he oversees Asha Kumar W1 (Stitching).
  Stitching department: Priya Devi W7 is a Department Head too (not one of the MD's); she oversees Ravi W2.
"""

from datetime import date, time
from decimal import Decimal

from django.test import TestCase

from . import approval_workflow as approval
from .approval_workflow import HOD, HR, Step
from .jwt_utils import sign_token
from .md_portal import hod_approvals as H
from .models import (
    AttendanceOverrideRequest,
    AuditLog,
    CasualLeaveRequest,
    Department,
    DepartmentManager,
    Employee,
    EmployeePermission,
    HolidayWorkClaim,
    HRUser,
    LeaveRequest,
    ManagerEmployeeAssignment,
    MissingPunchRequest,
    OnDutySession,
    OutpassRequest,
    PayrollSettings,
    ResignationRequest,
)
from .tests_md_support import make_md, md_headers

HOD_THEN_HR = (Step((HOD,), True), Step((HR,), True))
URL = "/api/md/approvals/hods"


def bearer(claims: dict) -> dict:
    return {"HTTP_AUTHORIZATION": f"Bearer {sign_token(claims)}"}


class Base(TestCase):
    def setUp(self):
        super().setUp()
        approval.clear_cache()
        self.addCleanup(approval.clear_cache)
        self.md = make_md()
        PayrollSettings.get()  # the settings row every real database has (the reads below are read-only)
        self.md_dept = Department.objects.create(name="MD")
        self.stitching = Department.objects.create(name="Stitching")
        self.boss = self.employee("W9", "Suresh", "Raj", self.md_dept)
        self.emp = self.employee("W1", "Asha", "Kumar", self.stitching)
        self.manager = DepartmentManager.objects.create(employee=self.boss)
        ManagerEmployeeAssignment.objects.create(manager=self.manager, employee=self.emp)
        self.priya = self.employee("W7", "Priya", "Devi", self.stitching)
        self.ravi = self.employee("W2", "Ravi", "S", self.stitching)
        self.other_manager = DepartmentManager.objects.create(employee=self.priya)
        ManagerEmployeeAssignment.objects.create(manager=self.other_manager, employee=self.ravi)

    def employee(self, code, first, last, dept) -> Employee:
        return Employee.objects.create(
            employee_code=code,
            first_name=first,
            last_name=last,
            status="active",
            employment_type="staff",
            join_date="2020-01-01",
            department=dept,
        )

    def get(self, path, **params):
        return self.client.get(path, params, **md_headers(self.md))

    def decide(self, manager_id=None, **body):
        return self.client.post(
            f"{URL}/{manager_id or self.manager.id}/decide",
            body,
            content_type="application/json",
            **md_headers(self.md),
        )

    def leave(self, emp=None, **extra) -> LeaveRequest:
        return LeaveRequest.objects.create(
            employee=emp or self.emp,
            type="casual",
            start_date="2026-09-06",
            end_date="2026-09-06",
            approval_trail=[],
            reason="Family",
            **extra,
        )

    def missing_punch(self, emp=None) -> MissingPunchRequest:
        return MissingPunchRequest.objects.create(
            employee=emp or self.emp,
            date=date(2026, 9, 1),
            punch_time=time(9, 0),
            punch_type="IN",
            reason="Forgot",
            status="pending_hod",
            approval_trail=[],
        )

    def one_of_every_kind(self, emp=None):
        emp = emp or self.emp
        self.leave(emp)
        EmployeePermission.objects.create(
            employee=emp,
            date=date(2026, 9, 10),
            permission_time=time(9, 30),
            reason="Bank",
            type="morning_late_in",
            approval_trail=[],
        )
        ResignationRequest.objects.create(employee=emp, reason="Moving", approval_trail=[])
        AttendanceOverrideRequest.objects.create(employee=emp, date=date(2026, 9, 1), reason="x", approval_trail=[])
        CasualLeaveRequest.objects.create(employee=emp, date=date(2026, 9, 20), reason="x", approval_trail=[])
        HolidayWorkClaim.objects.create(
            employee=emp, work_date=date(2026, 9, 13), shifts=Decimal("0.50"), approval_trail=[]
        )
        OnDutySession.objects.create(employee=emp, destination="ABC Traders", status="pending_hod", approval_trail=[])
        self.missing_punch(emp)
        OutpassRequest.objects.create(employee=emp, destination="Bank", reason="x", approval_trail=[])


class WhoIsListedTests(Base):
    def test_only_the_heads_of_the_md_department_are_listed_with_what_they_can_decide_now(self):
        self.one_of_every_kind()
        self.leave(self.ravi)  # Priya's, not the MD's
        body = self.get(URL).json()
        self.assertEqual([h["id"] for h in body["hods"]], [self.manager.id])
        hod = body["hods"][0]
        self.assertEqual((hod["name"], hod["code"], hod["department"]), ("Suresh Raj", "W9", "MD"))
        self.assertEqual(hod["pending"], {"leave": 2, "permission": 2, "other": 5, "total": 9})
        self.assertEqual(hod["oversees"]["people"], 1)
        self.assertTrue(all(hod["rights"].values()))
        self.assertEqual([d["name"] for d in body["mdDepartments"]], ["MD"])

    def test_the_list_follows_user_management_on_the_very_next_request(self):
        self.assertEqual(len(self.get(URL).json()["hods"]), 1)
        # a new head joins the MD department -> a new tab
        self.priya.department = self.md_dept
        self.priya.save()
        self.assertEqual({h["code"] for h in self.get(URL).json()["hods"]}, {"W9", "W7"})
        # a head is switched off in User Management -> the tab goes
        self.manager.is_active = False
        self.manager.save()
        self.assertEqual([h["code"] for h in self.get(URL).json()["hods"]], ["W7"])
        # and one who moves out of the MD department goes too
        self.priya.department = self.stitching
        self.priya.save()
        self.assertEqual(self.get(URL).json()["hods"], [])

    def test_the_department_name_is_matched_whatever_its_case_and_in_full(self):
        for name, listed in (("md", True), ("Managing Director", True), ("MD Office", False), ("CMD", False)):
            self.md_dept.name = name
            self.md_dept.save()
            self.assertEqual(len(self.get(URL).json()["hods"]), 1 if listed else 0, name)

    def test_nobody_but_the_md_may_call_any_of_it(self):
        admin = HRUser.objects.create(
            username="hodapp_admin", password_hash="x", is_super_admin=True, full_name="Admin"
        )
        others = (
            bearer({"role": "hr", "hrUserId": admin.id}),
            bearer({"role": "employee", "employeeId": self.boss.id}),
            {},
        )
        leave = self.leave()
        for who in others:
            self.assertIn(self.client.get(URL, **who).status_code, (401, 403))
            self.assertIn(self.client.get(f"{URL}/{self.manager.id}", **who).status_code, (401, 403))
            r = self.client.post(
                f"{URL}/{self.manager.id}/decide",
                {"kind": "leave", "id": leave.id, "decision": "approved"},
                content_type="application/json",
                **who,
            )
            self.assertIn(r.status_code, (401, 403))
        leave.refresh_from_db()
        self.assertEqual(leave.status, "pending")


class RequestsTests(Base):
    def test_every_kind_waiting_for_the_head_is_one_list_in_one_shape(self):
        self.one_of_every_kind()
        body = self.get(f"{URL}/{self.manager.id}").json()
        self.assertEqual(body["status"], "pending")
        self.assertEqual(body["counts"], {"leave": 2, "permission": 2, "other": 5, "total": 9})
        self.assertEqual(sorted(i["kind"] for i in body["items"]), sorted(H.KINDS))
        for i in body["items"]:
            self.assertEqual(i["employee"]["code"], "W1", i["kind"])
            self.assertEqual(i["employee"]["name"], "Asha Kumar", i["kind"])
            self.assertEqual((i["state"], i["canApprove"], i["canReject"]), ("pending", True, True), i["kind"])
            self.assertEqual(i["statusLabel"], "Waiting for the Department Head", i["kind"])
            self.assertTrue(i["title"], i["kind"])
            self.assertEqual(i["key"], f"{i['kind']}-{i['id']}")
        by_kind = {i["kind"]: i for i in body["items"]}
        self.assertEqual(by_kind["missing_punch"]["detail"], "IN at 09:00")
        self.assertEqual(by_kind["holiday_work"]["detail"], "0.5 shifts")
        self.assertEqual(by_kind["on_duty"]["detail"], "ABC Traders")
        self.assertEqual(by_kind["leave"]["from"], "2026-09-06")

    def test_another_heads_requests_and_the_heads_own_are_not_listed(self):
        self.leave(self.ravi)
        ManagerEmployeeAssignment.objects.create(manager=self.manager, employee=self.boss)
        self.leave(self.boss)
        self.assertEqual(self.get(f"{URL}/{self.manager.id}").json()["items"], [])

    def test_the_history_filters(self):
        self.leave(status="approved", approved_by="Suresh Raj", approver_role="dept_head")
        self.leave(status="rejected")
        self.missing_punch()
        states = {
            s: [i["state"] for i in self.get(f"{URL}/{self.manager.id}", status=s).json()["items"]] for s in H.STATUSES
        }
        self.assertEqual(states["pending"], ["pending"])
        self.assertEqual(states["approved"], ["approved"])
        self.assertEqual(states["rejected"], ["rejected"])
        self.assertEqual(sorted(states["all"]), ["approved", "pending", "rejected"])
        self.assertEqual(self.get(f"{URL}/{self.manager.id}", status="maybe").status_code, 400)

    def test_a_head_who_is_not_the_mds_is_a_404(self):
        for pk in (self.other_manager.id, 999999):
            r = self.get(f"{URL}/{pk}")
            self.assertEqual((r.status_code, r.json()["code"]), (404, "not_md_hod"), pk)

    def test_a_kind_the_head_may_not_decide_is_shown_without_buttons_and_says_why(self):
        self.missing_punch()
        self.manager.can_approve_missing_punch = False
        self.manager.save()
        # the head's own list leaves a kind they may not decide out entirely (as their app does)
        self.assertEqual(self.get(f"{URL}/{self.manager.id}").json()["items"], [])
        self.assertFalse(self.get(URL).json()["hods"][0]["rights"]["missing_punch"])
        self.leave()
        self.manager.can_approve_leaves = False
        self.manager.save()
        item = self.get(f"{URL}/{self.manager.id}").json()["items"][0]  # leaves are listed whatever the switch says
        self.assertEqual((item["kind"], item["canApprove"], item["canReject"]), ("leave", False, False))
        self.assertIn("switched off in User Management", item["blockedReason"])


class DecideTests(Base):
    def test_the_md_approves_at_the_heads_step_through_the_heads_own_code(self):
        leave = self.leave()
        r = self.decide(kind="leave", id=leave.id, decision="approved", comment="Fine")
        self.assertEqual(r.status_code, 200, r.content)
        body = r.json()
        self.assertEqual(body["actor"], "Test MD (MD, for Suresh Raj)")
        self.assertEqual(
            (body["item"]["state"], body["item"]["decidedBy"]), ("approved", "Test MD (MD, for Suresh Raj)")
        )
        leave.refresh_from_db()
        self.assertEqual(
            (leave.status, leave.approver_role, leave.approved_by), ("approved", "dept_head", body["actor"])
        )
        self.assertEqual(leave.approval_trail[-1]["role"], HOD)
        log = AuditLog.objects.filter(module="md_approvals").get()
        self.assertEqual((log.action, log.record_id, log.hr_user_id), ("approve", leave.id, self.md.id))
        self.assertIn("Department Head's step", log.record_description)

    def test_a_two_step_pipeline_moves_on_to_hr_and_leaves_the_heads_list(self):
        approval.save_config("leave", steps=HOD_THEN_HR, actor="test")
        leave = self.leave()
        item = self.decide(kind="leave", id=leave.id, decision="approved").json()["item"]
        self.assertEqual(
            (item["state"], item["waitingFor"], item["statusLabel"]), ("pending", ["hr"], "Waiting for HR")
        )
        self.assertFalse(item["canApprove"])
        leave.refresh_from_db()
        self.assertEqual(leave.status, "pending")
        # the head's own app and this page agree that it has left the head's desk
        hod_app = self.client.get(
            "/api/manager/pending-requests", **bearer({"role": "employee", "employeeId": self.boss.id})
        ).json()
        self.assertEqual((hod_app["leaveRequests"], hod_app["totalPending"]), ([], 0))
        self.assertEqual(self.get(f"{URL}/{self.manager.id}").json()["items"], [])
        # and deciding it again at the head's step is refused by the pipeline
        self.assertEqual(self.decide(kind="leave", id=leave.id, decision="approved").status_code, 400)

    def test_rejecting_a_missing_punch(self):
        req = self.missing_punch()
        item = self.decide(kind="missing_punch", id=req.id, decision="rejected", comment="No proof").json()["item"]
        self.assertEqual(item["state"], "rejected")
        req.refresh_from_db()
        self.assertEqual(req.status, "rejected")
        self.assertEqual(AuditLog.objects.filter(module="md_approvals").get().action, "reject")

    def test_a_resignation_stays_filed_under_the_head(self):
        r = ResignationRequest.objects.create(employee=self.emp, reason="Moving", approval_trail=[])
        item = self.decide(kind="resignation", id=r.id, decision="approved").json()["item"]
        r.refresh_from_db()
        self.assertEqual((r.status, r.dept_head_id), ("dept_approved", self.boss.id))  # HR still decides (default)
        self.assertEqual(item["waitingFor"], ["hr"])
        self.emp.refresh_from_db()
        self.assertEqual(self.emp.status, "active")

    def test_a_switched_off_right_refuses_and_changes_nothing(self):
        leave = self.leave()
        self.manager.can_approve_leaves = False
        self.manager.save()
        r = self.decide(kind="leave", id=leave.id, decision="approved")
        self.assertEqual((r.status_code, r.json()["code"]), (403, "hod_right_off"))
        leave.refresh_from_db()
        self.assertEqual(leave.status, "pending")
        self.assertFalse(AuditLog.objects.filter(module="md_approvals").exists())

    def test_requests_outside_the_heads_scope_or_heads_outside_the_md_department_are_refused(self):
        theirs = self.leave(self.ravi)
        self.assertEqual(self.decide(kind="leave", id=theirs.id, decision="approved").status_code, 403)
        self.assertEqual(
            self.decide(self.other_manager.id, kind="leave", id=theirs.id, decision="approved").status_code, 404
        )
        self.assertEqual(self.decide(kind="leave", id=987654, decision="approved").status_code, 404)
        theirs.refresh_from_db()
        self.assertEqual(theirs.status, "pending")
        self.assertFalse(AuditLog.objects.filter(module="md_approvals").exists())

    def test_a_bad_body_is_a_400(self):
        leave = self.leave()
        for body in (
            {"kind": "bonus", "id": leave.id, "decision": "approved"},
            {"kind": "leave", "id": "x", "decision": "approved"},
            {"kind": "leave", "id": leave.id, "decision": "maybe"},
            {},
        ):
            self.assertEqual(self.decide(**body).status_code, 400, body)
        leave.refresh_from_db()
        self.assertEqual(leave.status, "pending")

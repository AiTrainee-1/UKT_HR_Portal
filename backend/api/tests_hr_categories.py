"""
HR Manager / HR Assistant account categories (api/hr_access.py): the permission matrix.

What must never change: Admin accounts (on the old "edit = approve" rule), the Managing Director and the Super Admin.
What is new: approving is a right of its own (Role.approvals + per-account changes), an HR Assistant can never approve a
missing punch or an attendance edit (and the API refuses to grant it), branch scope on every HR decision, the HR Assistant
activity view, and the Super Admin alone manages accounts and categories.

Run via: DATABASE_URL="" DB_HOST=localhost python manage.py test api.tests_hr_categories
"""

from datetime import date, time
from unittest import mock

from django.test import TestCase

from . import approval_workflow as approval
from . import hr_access
from .jwt_utils import sign_token
from .models import (
    Advance,
    AttendanceOverrideRequest,
    AuditLog,
    Branch,
    CasualLeaveRequest,
    Employee,
    EmployeePermission,
    EmployeeRequest,
    HRUser,
    LeaveRequest,
    MissingPunchRequest,
    OutpassRequest,
    Payroll,
    ResignationRequest,
    Role,
)
from .permission_registry import effective_permissions

ALL_KINDS = list(hr_access.APPROVAL_KEYS)
# the kinds of 2026-11-10, as the starter roles were seeded with them (migration 0146)
STORED_KINDS = (
    "leave",
    "permission",
    "casual_leave",
    "missing_punch",
    "attendance_correction",
    "on_duty",
    "on_duty_punch",
    "outpass",
    "request",
    "resignation",
    "advance",
)


def bearer(user: HRUser, **extra) -> dict:
    payload = {"role": "hr", "hrUserId": user.id, "name": user.full_name or user.username, **extra}
    return {"HTTP_AUTHORIZATION": f"Bearer {sign_token(payload)}"}


class Matrix(TestCase):
    """Two branches, an employee in each, and one account of every kind."""

    @classmethod
    def setUpTestData(cls):
        cls.unit_a = Branch.objects.create(name="Unit A", code="UA")
        cls.unit_b = Branch.objects.create(name="Unit B", code="UB")
        cls.emp_a = Employee.objects.create(
            employee_code="HC1", first_name="Asha", last_name="Kumar", status="active", employment_type="staff",
            branch=cls.unit_a, join_date="2020-01-01",
        )  # fmt: skip
        cls.emp_b = Employee.objects.create(
            employee_code="HC2", first_name="Bala", last_name="Raj", status="active", employment_type="staff",
            branch=cls.unit_b, join_date="2020-01-01",
        )  # fmt: skip

        work = {
            "dashboard": "view",
            "employees": "view",
            "payroll": "edit",
            "leave": "edit",
            "requests": "edit",
            "casual_leave": "edit",
            "missing_punch": "edit",  # can EDIT the module, but editing never means approving
            "attendance": "edit",
            "settlement": "hidden",
            "settings": "hidden",
        }
        cls.assistant_role = Role.objects.create(
            name="Asst test", category="hr_assistant", permissions=work,
            approvals={"leave": True, "permission": True, "casual_leave": False},
        )  # fmt: skip
        # a role for any account that DOES switch on the two approvals an assistant may never have
        cls.generous_role = Role.objects.create(
            name="Generous test", permissions=work, approvals={k: True for k in ALL_KINDS}
        )
        cls.manager_role = Role.objects.create(
            name="Mgr test", category="hr_manager",
            permissions={**work, "settlement": "edit", "recruitment": "edit", "geo_attendance": "edit"},
            approvals={k: True for k in ALL_KINDS},
        )  # fmt: skip
        # the old kind of role: no approvals map, so approve = edit on the module
        cls.legacy_role = Role.objects.create(name="Clerk test", permissions=work)
        cls.legacy_view_role = Role.objects.create(
            name="Viewer test", permissions={"leave": "view", "missing_punch": "view", "requests": "view"}
        )

        def account(username, **kw):
            return HRUser.objects.create(username=username, password_hash="x", full_name=username.title(), **kw)

        cls.super_admin = account("hc_root", is_super_admin=True)
        cls.admin = account("hc_admin", role=cls.legacy_role)
        cls.admin_view = account("hc_viewer", role=cls.legacy_view_role)
        cls.md = account("hc_md", is_md=True)
        cls.assistant = account("hc_asst", category="hr_assistant", role=cls.assistant_role, branch=cls.unit_a)
        cls.assistant_generous = account("hc_asst2", category="hr_assistant", role=cls.generous_role, branch=cls.unit_a)
        cls.assistant_b = account("hc_asst_b", category="hr_assistant", role=cls.assistant_role, branch=cls.unit_b)
        cls.manager = account("hc_mgr", category="hr_manager", role=cls.manager_role, branch=cls.unit_a)

    def setUp(self):
        approval.clear_cache()
        self.addCleanup(approval.clear_cache)

    # ── helpers ──

    def call(self, user, method, path, body=None, **extra):
        return getattr(self.client, method)(path, body or {}, content_type="application/json", **bearer(user, **extra))

    def missing_punch(self, emp=None):
        # the default pipeline is HOD then HR: this one has the HOD's approval, so it waits for HR
        return MissingPunchRequest.objects.create(
            employee=emp or self.emp_a, date=date(2026, 10, 5), punch_time=time(9, 0), punch_type="IN", reason="forgot",
            status="pending_hr", approval_trail=[{"role": "hod", "decision": "approved", "by": "Suresh"}],
        )  # fmt: skip

    def leave(self, emp=None):
        return LeaveRequest.objects.create(
            employee=emp or self.emp_a, type="casual", start_date="2026-10-06", end_date="2026-10-06", approval_trail=[]
        )

    def correction(self, emp=None):
        return AttendanceOverrideRequest.objects.create(
            employee=emp or self.emp_a, date=date(2026, 10, 3), previous_values={}, requested_values={"typeLabel": "Present"},
            reason="late card", requested_by="HR", approval_trail=[{"role": "hod", "decision": "approved", "by": "Suresh"}],
        )  # fmt: skip

    def assert_refused(self, response, code="approval_not_permitted"):
        self.assertEqual(response.status_code, 403, response.content)
        body = response.json()
        # the permission middleware answers {"error": "permission_denied", "message": ...}; the views {"error", "code"}
        self.assertEqual(body.get("code") or body.get("error"), code, response.content)


class LegacyAccountsUnchanged(Matrix):
    def test_every_existing_style_account_stays_on_the_old_rule(self):
        for user in (self.admin, self.admin_view, self.md, self.super_admin):
            self.assertFalse(hr_access.uses_explicit_approvals(user), user.username)
        self.assertEqual(effective_permissions(self.admin), self.legacy_role.permissions)
        # approve = edit on the module that owns the request, kind by kind
        approvals = hr_access.effective_approvals(self.admin)
        for kind in hr_access.APPROVAL_KINDS:
            level = self.legacy_role.permissions.get(kind.module.split(".")[0], "hidden")
            self.assertEqual(approvals[kind.key], level == "edit", kind.key)

    def test_admin_with_edit_approves_missing_punch_and_leave_as_before(self):
        mp = self.missing_punch()
        r = self.call(self.admin, "patch", f"/api/missing-punch-requests/{mp.id}/status", {"status": "approved"})
        self.assertEqual(r.status_code, 200, r.content)
        mp.refresh_from_db()
        self.assertEqual(mp.status, "approved")
        lv = self.leave()
        r = self.call(self.admin, "patch", f"/api/leave-requests/{lv.id}/status", {"status": "rejected"})
        self.assertEqual(r.status_code, 200, r.content)

    def test_admin_with_view_only_is_refused_by_the_module_check_as_before(self):
        mp = self.missing_punch()
        r = self.call(self.admin_view, "patch", f"/api/missing-punch-requests/{mp.id}/status", {"status": "approved"})
        self.assert_refused(r, "permission_denied")
        # ...and the list still shows HR's turn the way it always did (the view-only lock hides the buttons)
        rows = self.call(self.admin_view, "get", "/api/missing-punch-requests?status=pending").json()
        self.assertTrue(rows[0]["approval"]["canAct"]["hr"])

    def test_admin_approvals_follow_edit(self):
        me = self.call(self.admin, "get", "/api/auth/me").json()
        self.assertEqual((me["category"], me["approvalMode"], me["displayCategory"]), ("admin", "legacy", "admin"))
        self.assertTrue(me["approvals"]["missing_punch"])
        self.assertFalse(me["approvals"]["advance_general"] or me["approvals"]["advance_term"])  # settlement hidden
        self.assertEqual(me["lockedApprovals"], [])

    def test_md_unchanged(self):
        me = self.call(self.md, "get", "/api/auth/me").json()
        self.assertEqual((me["displayCategory"], me["approvalMode"]), ("md", "legacy"))
        self.assertFalse(me["approvals"]["leave"])  # the MD only views leave (MD_VIEW_ONLY)
        self.assertTrue(me["approvals"]["missing_punch"])  # MD_HR_GRANTS edit
        lv = self.leave()
        self.assert_refused(
            self.call(self.md, "patch", f"/api/leave-requests/{lv.id}/status", {"status": "approved"}),
            "permission_denied",
        )
        mp = self.missing_punch()
        r = self.call(self.md, "patch", f"/api/missing-punch-requests/{mp.id}/status", {"status": "approved"})
        self.assertEqual(r.status_code, 200, r.content)

    def test_super_admin_approves_everything(self):
        self.assertTrue(all(hr_access.effective_approvals(self.super_admin).values()))
        corr = self.correction()
        r = self.call(self.super_admin, "patch", f"/api/attendance/override-requests/{corr.id}", {"status": "rejected"})
        self.assertEqual(r.status_code, 200, r.content)
        me = self.call(self.super_admin, "get", "/api/auth/me").json()
        self.assertEqual((me["displayCategory"], me["categoryLabel"]), ("super_admin", "Super Admin"))


class AssistantRules(Matrix):
    def test_assistant_with_payroll_edit_can_edit_payroll(self):
        p = Payroll.objects.create(
            employee=self.emp_a, salary_mode="monthly", month=8, year=2026, base_salary=10000, gross_salary=10000,
            final_salary=10000,
        )  # fmt: skip
        r = self.call(self.assistant, "patch", f"/api/payroll/{p.id}", {"bonus": 250})
        self.assertEqual(r.status_code, 200, r.content)
        p.refresh_from_db()
        self.assertEqual(p.bonus, 250)
        # the change is in the activity trail, stamped with the account
        row = AuditLog.objects.filter(hr_user_id=self.assistant.id, module="payroll").latest("id")
        self.assertEqual((row.action, row.record_id), ("update", p.id))
        self.assertEqual(row.new_values, {"request": {"bonus": 250}})

    def test_assistant_never_approves_missing_punch_even_when_the_role_says_yes(self):
        for user in (self.assistant, self.assistant_generous):
            mp = self.missing_punch()
            r = self.call(user, "patch", f"/api/missing-punch-requests/{mp.id}/status", {"status": "approved"})
            self.assert_refused(r)
            self.assertIn("HR Assistants can't approve missing-punch", r.json()["error"])
            mp.refresh_from_db()
            self.assertEqual(mp.status, "pending_hr")
            r = self.call(user, "patch", f"/api/missing-punch-requests/{mp.id}/status", {"status": "rejected"})
            self.assert_refused(r)
        self.assertFalse(hr_access.effective_approvals(self.assistant_generous)["missing_punch"])

    def test_with_view_only_the_refusal_still_says_why(self):
        # the starter role gives assistants View on Missing Punch: the middleware answers with the approval reason
        role = Role.objects.create(
            name="Viewer asst", category="hr_assistant", permissions={"missing_punch": "view"}, approvals={}
        )
        HRUser.objects.filter(pk=self.assistant.pk).update(role=role)
        mp = self.missing_punch()
        r = self.call(self.assistant, "patch", f"/api/missing-punch-requests/{mp.id}/status", {"status": "approved"})
        self.assert_refused(r)
        self.assertIn("HR Assistants can't approve missing-punch", r.json()["error"])
        self.assert_refused(
            self.call(self.assistant, "delete", f"/api/missing-punch-requests/{mp.id}/status"), "permission_denied"
        )

    def test_assistant_never_approves_attendance_edits_but_may_propose_them(self):
        corr = self.correction()
        for user in (self.assistant, self.assistant_generous):
            r = self.call(user, "patch", f"/api/attendance/override-requests/{corr.id}", {"status": "approved"})
            self.assert_refused(r)
        corr.refresh_from_db()
        self.assertEqual(corr.status, "pending")
        # the engine refuses too, for any caller that reaches it with an assistant behind it
        token = hr_access.set_actor(self.assistant_generous)
        try:
            with self.assertRaises(approval.ApprovalError) as ctx:
                approval.decide("attendance_correction", corr, approval.HR, "approved", actor="x")
            self.assertEqual((ctx.exception.status, ctx.exception.code), (403, "approval_not_permitted"))
        finally:
            hr_access.reset_actor(token)
        # editing attendance (a proposal) is still allowed: it is refused for having no HOD, not for permission
        r = self.call(
            self.assistant, "post", "/api/attendance/override", {"employeeId": self.emp_a.id, "date": "2026-10-04"}
        )
        self.assertNotEqual(r.status_code, 403, r.content)

    def test_the_api_refuses_to_grant_a_locked_approval(self):
        url = f"/api/hr-users/{self.assistant.id}"
        r = self.call(self.super_admin, "put", url, {"permissionOverrides": {"approvals": {"missing_punch": True}}})
        self.assertEqual((r.status_code, r.json()["code"]), (400, "approval_locked"), r.content)
        r = self.call(
            self.super_admin, "put", url, {"permissionOverrides": {"approvals": {"attendance_correction": True}}}
        )
        self.assertEqual(r.status_code, 400)
        r = self.call(self.super_admin, "post", "/api/roles", {"name": "Bad asst", "category": "hr_assistant",
                                                                "approvals": {"missing_punch": True}})  # fmt: skip
        self.assertEqual((r.status_code, r.json()["code"]), (400, "approval_locked"))
        r = self.call(
            self.super_admin,
            "put",
            f"/api/roles/{self.assistant_role.id}",
            {"approvals": {"attendance_correction": True}},
        )
        self.assertEqual(r.status_code, 400)
        # switching them OFF is fine
        r = self.call(self.super_admin, "put", url, {"permissionOverrides": {"approvals": {"missing_punch": False}}})
        self.assertEqual(r.status_code, 200, r.content)

    def test_assistant_approves_leave_and_permission_only_if_granted(self):
        lv = self.leave()
        r = self.call(self.assistant, "patch", f"/api/leave-requests/{lv.id}/status", {"status": "approved"})
        self.assertEqual(r.status_code, 200, r.content)
        perm = EmployeePermission.objects.create(
            employee=self.emp_a, date=date(2026, 10, 7), type="morning_late_in", approval_trail=[]
        )
        r = self.call(self.assistant, "put", f"/api/permissions/{perm.id}", {"status": "approved"})
        self.assertEqual(r.status_code, 200, r.content)
        cl = CasualLeaveRequest.objects.create(employee=self.emp_a, date=date(2026, 10, 8), approval_trail=[])
        r = self.call(self.assistant, "patch", f"/api/casual-leaves/{cl.id}", {"status": "approved"})
        self.assert_refused(r)  # casual leave: edit yes, approve no
        # the decisions are logged as approvals, stamped with the account
        self.assertEqual(AuditLog.objects.filter(hr_user_id=self.assistant.id, action="approve").count(), 2)

    def test_editing_is_not_approving_on_mixed_endpoints(self):
        # recording a permission that is already approved is a decision
        no_perm_role = Role.objects.create(name="No perm approve", permissions=self.assistant_role.permissions,
                                           approvals={"leave": True}, category="hr_assistant")  # fmt: skip
        HRUser.objects.filter(pk=self.assistant.pk).update(role=no_perm_role)
        r = self.call(self.assistant, "post", "/api/permissions",
                      {"employeeId": self.emp_a.id, "date": "2026-10-09", "type": "morning_late_in", "status": "approved"})  # fmt: skip
        self.assert_refused(r)
        # a general request: "in review" is handling it, "approved" is deciding it
        er = EmployeeRequest.objects.create(
            employee=self.emp_a, request_type="general", subject="Letter", description="x"
        )
        self.assertEqual(
            self.call(
                self.assistant, "put", f"/api/employee-requests/{er.id}/action", {"status": "in_review"}
            ).status_code,
            200,
        )
        self.assert_refused(
            self.call(self.assistant, "put", f"/api/employee-requests/{er.id}/action", {"status": "approved"})
        )
        # a revision of a decision (approved -> rejected) is a decision too
        perm = EmployeePermission.objects.create(
            employee=self.emp_a, date=date(2026, 10, 10), type="morning_late_in", status="approved", approval_trail=[]
        )
        self.assert_refused(self.call(self.assistant, "put", f"/api/permissions/{perm.id}", {"status": "rejected"}))
        # ...while a type / comment change is only an edit
        r = self.call(self.assistant, "put", f"/api/permissions/{perm.id}", {"hrComment": "seen"})
        self.assertEqual(r.status_code, 200, r.content)

    def test_canact_is_false_where_not_permitted_and_counts_follow(self):
        self.missing_punch()
        rows = self.call(self.assistant, "get", "/api/missing-punch-requests?status=pending").json()
        block = rows[0]["approval"]
        self.assertEqual(
            (block["canAct"]["hr"], block["canReject"]["hr"], block["hrTurn"], block["hrPermitted"]),
            (False, False, True, False),
        )
        rows = self.call(self.manager, "get", "/api/missing-punch-requests?status=pending").json()
        self.assertTrue(rows[0]["approval"]["canAct"]["hr"])
        # the Requests hub: the kind is still listed, says it can't be approved, and the HR queue still counts it
        hub = self.call(self.assistant, "get", "/api/hr-requests").json()
        kinds = {k["key"]: k for k in hub["kinds"]}
        self.assertFalse(kinds["missing_punch"]["canApprove"])
        self.assertTrue(kinds["leave"]["canApprove"])
        self.assertEqual(kinds["missing_punch"]["waitingHr"], 1)
        # the attendance edits waiting for HR: none for an assistant, one for the manager
        self.correction()
        self.assertEqual(self.call(self.assistant, "get", "/api/attendance/override-requests?waiting=hr").json(), [])
        self.assertEqual(len(self.call(self.manager, "get", "/api/attendance/override-requests?waiting=hr").json()), 1)
        # the dashboard's pending leave count: an account without the leave approval counts none
        self.leave()
        self.assertEqual(self.call(self.assistant, "get", "/api/dashboard/hr-summary").json()["pendingLeaves"], 1)
        HRUser.objects.filter(pk=self.assistant.pk).update(permission_overrides={"approvals": {"leave": False}})
        self.assertEqual(self.call(self.assistant, "get", "/api/dashboard/hr-summary").json()["pendingLeaves"], 0)

    def test_auth_me_reports_category_and_locks_from_the_database_not_the_token(self):
        me = self.call(self.assistant, "get", "/api/auth/me", category="admin").json()
        self.assertEqual(
            (me["category"], me["categoryLabel"], me["approvalMode"]), ("hr_assistant", "HR Assistant", "explicit")
        )
        self.assertEqual(me["lockedApprovals"], ["attendance_correction", "missing_punch"])
        self.assertTrue(me["approvals"]["leave"])
        self.assertFalse(me["approvals"]["missing_punch"])
        # a token claiming another category changes nothing
        r = self.call(self.assistant, "get", "/api/hr-activity", category="hr_manager")
        self.assertEqual(r.status_code, 403)


class Overrides(Matrix):
    def put_overrides(self, user, overrides):
        r = self.call(self.super_admin, "put", f"/api/hr-users/{user.id}", {"permissionOverrides": overrides})
        self.assertEqual(r.status_code, 200, r.content)
        return r.json()

    def test_an_override_adds_and_removes_an_approval(self):
        body = self.put_overrides(self.assistant, {"approvals": {"casual_leave": True, "leave": False}})
        self.assertEqual(
            body["permissionOverrides"], {"modules": {}, "approvals": {"casual_leave": True, "leave": False}}
        )
        cl = CasualLeaveRequest.objects.create(employee=self.emp_a, date=date(2026, 10, 8), approval_trail=[])
        self.assertEqual(
            self.call(self.assistant, "patch", f"/api/casual-leaves/{cl.id}", {"status": "approved"}).status_code, 200
        )
        lv = self.leave()
        self.assert_refused(
            self.call(self.assistant, "patch", f"/api/leave-requests/{lv.id}/status", {"status": "approved"})
        )

    def test_an_override_adds_and_removes_a_module(self):
        self.assert_refused(self.call(self.assistant, "get", "/api/advances"), "permission_denied")
        self.put_overrides(self.assistant, {"modules": {"settlement": "edit", "payroll": "hidden"}})
        self.assertEqual(self.call(self.assistant, "get", "/api/advances").status_code, 200)
        self.assert_refused(self.call(self.assistant, "get", "/api/payroll"), "permission_denied")
        # settlement edit, but approving an advance is still its own right (the role does not give it)
        adv = Advance.objects.create(employee=self.emp_a, advance_type="general", amount=1000, outstanding=1000)
        self.assertEqual(
            self.call(self.assistant, "put", f"/api/advances/{adv.id}", {"notes": "checked"}).status_code, 200
        )
        self.assert_refused(self.call(self.assistant, "put", f"/api/advances/{adv.id}", {"status": "approved"}))

    def test_a_section_override_takes_its_sub_modules_with_it(self):
        role = Role.objects.create(name="Sub test", permissions={"employees": "edit", "employees.branches": "view"},
                                   category="hr_manager", approvals={})  # fmt: skip
        HRUser.objects.filter(pk=self.manager.pk).update(
            role=role, permission_overrides={"modules": {"employees": "hidden"}}
        )
        self.manager.refresh_from_db()
        perms = effective_permissions(self.manager)
        self.assertEqual((perms["employees"], perms.get("employees.branches")), ("hidden", None))

    def test_only_manager_and_assistant_accounts_carry_overrides(self):
        r = self.call(
            self.super_admin,
            "put",
            f"/api/hr-users/{self.admin.id}",
            {"permissionOverrides": {"modules": {"payroll": "hidden"}}},
        )
        self.assertEqual(r.status_code, 400)
        r = self.call(
            self.super_admin,
            "put",
            f"/api/hr-users/{self.assistant.id}",
            {"permissionOverrides": {"modules": {"nope": "edit"}}},
        )
        self.assertEqual(r.status_code, 400)

    def test_hidden_module_is_refused_on_direct_get_and_post(self):
        self.assert_refused(self.call(self.assistant, "get", "/api/advances"), "permission_denied")
        r = self.call(
            self.assistant,
            "post",
            "/api/advances",
            {"employeeId": self.emp_a.id, "amount": 10, "advanceType": "general"},
        )
        self.assert_refused(r, "permission_denied")
        self.assert_refused(self.call(self.assistant, "get", "/api/backup"), "permission_denied")

    def test_view_plus_approve_decides_but_cannot_edit(self):
        role = Role.objects.create(name="Approver test", category="hr_manager", permissions={"leave": "view"},
                                   approvals={"leave": True})  # fmt: skip
        HRUser.objects.filter(pk=self.manager.pk).update(role=role)
        lv = self.leave()
        r = self.call(self.manager, "patch", f"/api/leave-requests/{lv.id}/status", {"status": "approved"})
        self.assertEqual(r.status_code, 200, r.content)
        other = self.leave()
        r = self.call(self.manager, "patch", f"/api/leave-requests/{other.id}/status", {"hrComment": "noted"})
        self.assert_refused(r, "permission_denied")  # a comment is an edit
        self.assert_refused(self.call(self.manager, "post", "/api/leave-types", {"name": "X"}), "permission_denied")


class ManagerScope(Matrix):
    def test_manager_approves_what_assistants_cannot_within_the_branch(self):
        mp = self.missing_punch()
        r = self.call(self.manager, "patch", f"/api/missing-punch-requests/{mp.id}/status", {"status": "approved"})
        self.assertEqual(r.status_code, 200, r.content)
        corr = self.correction()
        r = self.call(self.manager, "patch", f"/api/attendance/override-requests/{corr.id}", {"status": "rejected"})
        self.assertEqual(r.status_code, 200, r.content)

    def test_manager_cannot_decide_another_branchs_requests(self):
        mp = self.missing_punch(self.emp_b)
        r = self.call(self.manager, "patch", f"/api/missing-punch-requests/{mp.id}/status", {"status": "approved"})
        self.assertEqual(r.status_code, 404, r.content)
        lv = self.leave(self.emp_b)
        self.assertEqual(
            self.call(self.manager, "patch", f"/api/leave-requests/{lv.id}/status", {"status": "approved"}).status_code,
            404,
        )
        out = OutpassRequest.objects.create(employee=self.emp_b, destination="Bank", reason="x", approval_trail=[])
        self.assertEqual(
            self.call(
                self.manager, "put", f"/api/outpass-requests/{out.id}/hr-status", {"status": "approved"}
            ).status_code,
            404,
        )
        res = ResignationRequest.objects.create(
            employee=self.emp_b, reason="x", status="dept_approved",
            approval_trail=[{"role": "hod", "decision": "approved", "by": "S"}],
        )  # fmt: skip
        self.assertEqual(
            self.call(
                self.manager, "patch", f"/api/recruitment/resignations/{res.id}/action", {"action": "approve"}
            ).status_code,
            404,
        )
        mp.refresh_from_db()
        self.assertEqual(mp.status, "pending_hr")

    def test_account_endpoints_are_super_admin_only(self):
        for method, path in (
            ("get", "/api/hr-users"),
            ("post", "/api/hr-users"),
            ("put", f"/api/hr-users/{self.assistant.id}"),
            ("put", f"/api/hr-users/{self.manager.id}"),
            ("delete", f"/api/hr-users/{self.assistant.id}"),
            ("get", "/api/roles"),
            ("post", "/api/roles"),
            ("put", f"/api/roles/{self.manager_role.id}"),
            ("get", "/api/audit-logs"),
        ):
            r = self.call(self.manager, method, path, {"category": "admin", "isActive": False, "name": "x"})
            self.assertEqual(r.status_code, 403, f"{method} {path}")
        self.manager.refresh_from_db()
        self.assistant.refresh_from_db()
        self.assertEqual((self.manager.category, self.assistant.is_active), ("hr_manager", True))


class AccountManagement(Matrix):
    def test_super_admin_creates_accounts_of_each_category(self):
        r = self.call(self.super_admin, "post", "/api/hr-users",
                      {"username": "hc_new", "password": "Passw0rd!", "category": "hr_assistant", "roleId": self.assistant_role.id,
                       "permissionOverrides": {"approvals": {"casual_leave": True}}})  # fmt: skip
        self.assertEqual(r.status_code, 201, r.content)
        body = r.json()
        self.assertEqual((body["category"], body["categoryLabel"], body["permissionOverrides"]["approvals"]),
                         ("hr_assistant", "HR Assistant", {"casual_leave": True}))  # fmt: skip
        log = AuditLog.objects.filter(module="user_management", record_id=body["id"]).latest("id")
        self.assertEqual((log.action, log.new_values["category"]), ("create", "hr_assistant"))
        self.assertEqual(log.hr_user_id, self.super_admin.id)
        # the default is an Admin account, exactly as before
        r = self.call(self.super_admin, "post", "/api/hr-users", {"username": "hc_plain", "password": "Passw0rd!"})
        self.assertEqual(r.json()["category"], "admin")

    def test_a_role_made_for_one_category_fits_only_that_category(self):
        r = self.call(self.super_admin, "post", "/api/hr-users",
                      {"username": "hc_bad", "password": "Passw0rd!", "category": "hr_manager", "roleId": self.assistant_role.id})  # fmt: skip
        self.assertEqual(r.status_code, 400)
        self.assertIn("HR Assistant", r.json()["error"])
        r = self.call(self.super_admin, "put", f"/api/hr-users/{self.admin.id}", {"roleId": self.manager_role.id})
        self.assertEqual(r.status_code, 400)
        # a role used by assistants cannot become a managers' role
        r = self.call(self.super_admin, "put", f"/api/roles/{self.generous_role.id}", {"category": "hr_manager"})
        self.assertEqual(r.status_code, 400)

    def test_the_super_admin_and_the_md_stay_admin_accounts(self):
        for user in (self.super_admin, self.md):
            r = self.call(self.super_admin, "put", f"/api/hr-users/{user.id}", {"category": "hr_manager"})
            self.assertEqual(r.status_code, 400, user.username)
        r = self.call(self.super_admin, "put", f"/api/hr-users/{self.manager.id}", {"isMd": True, "branchId": None})
        self.assertEqual(r.status_code, 400)

    def test_deactivating_and_changing_category_is_logged_with_old_and_new_values(self):
        r = self.call(self.super_admin, "put", f"/api/hr-users/{self.assistant.id}", {"isActive": False})
        self.assertEqual(r.status_code, 200)
        log = AuditLog.objects.filter(module="user_management", record_id=self.assistant.id).latest("id")
        self.assertEqual((log.old_values, log.new_values), ({"isActive": True}, {"isActive": False}))
        self.assertIn("deactivated", log.record_description)
        # a deactivated account is refused at once
        self.assertEqual(self.call(self.assistant, "get", "/api/auth/me").status_code, 200)  # auth/me is exempt...
        self.assertEqual(
            self.call(self.assistant, "get", "/api/payroll").status_code, 401
        )  # ...every gated call is not
        HRUser.objects.filter(pk=self.assistant_generous.pk).update(
            permission_overrides={"approvals": {"advance": True}}
        )
        r = self.call(
            self.super_admin, "put", f"/api/hr-users/{self.assistant_generous.id}", {"category": "hr_manager"}
        )
        self.assertEqual(r.status_code, 200, r.content)
        log = AuditLog.objects.filter(module="user_management", record_id=self.assistant_generous.id).latest("id")
        self.assertEqual((log.old_values["category"], log.new_values["category"]), ("hr_assistant", "hr_manager"))

    def test_role_approvals_round_trip_and_null_keeps_the_old_rule(self):
        r = self.call(self.super_admin, "post", "/api/roles", {"name": "Plain", "permissions": {"leave": "edit"}})
        self.assertEqual((r.status_code, r.json()["approvals"], r.json()["category"]), (201, None, ""))
        rid = r.json()["id"]
        r = self.call(self.super_admin, "put", f"/api/roles/{rid}", {"approvals": {"leave": False}})
        self.assertEqual(r.json()["approvals"], {"leave": False})
        r = self.call(self.super_admin, "put", f"/api/roles/{rid}", {"approvals": None})
        self.assertIsNone(r.json()["approvals"])
        self.assertEqual(
            self.call(self.super_admin, "put", f"/api/roles/{rid}", {"approvals": {"nope": True}}).status_code, 400
        )
        log = AuditLog.objects.filter(module="user_management", record_id=rid, action="update").order_by("id").first()
        self.assertEqual(log.new_values, {"approvals": {"leave": False}})

    def test_the_two_starter_roles_exist_with_their_defaults(self):
        manager = Role.objects.get(name="HR Manager - default")
        assistant = Role.objects.get(name="HR Assistant - default")
        self.assertEqual((manager.category, assistant.category), ("hr_manager", "hr_assistant"))
        self.assertTrue(all(manager.approvals[k] for k in STORED_KINDS))
        self.assertEqual({k for k, v in assistant.approvals.items() if v}, {"leave", "permission"})
        self.assertFalse(assistant.approvals["missing_punch"] or assistant.approvals["attendance_correction"])
        for key in ("payroll", "attendance", "leave", "requests", "compensation"):
            self.assertEqual(assistant.permissions[key], "edit", key)
        self.assertEqual((assistant.permissions["settings"], manager.permissions["settings"]), ("hidden", "hidden"))
        self.assertEqual(manager.permissions["user_management"], "hidden")


class AssistantActivity(Matrix):
    def setUp(self):
        super().setUp()
        p = Payroll.objects.create(
            employee=self.emp_a,
            salary_mode="monthly",
            month=8,
            year=2026,
            base_salary=1,
            gross_salary=1,
            final_salary=1,
        )
        self.call(self.assistant, "patch", f"/api/payroll/{p.id}", {"bonus": 5, "password": "secret"})
        q = Payroll.objects.create(
            employee=self.emp_b,
            salary_mode="monthly",
            month=8,
            year=2026,
            base_salary=1,
            gross_salary=1,
            final_salary=1,
        )
        self.call(self.assistant_b, "patch", f"/api/payroll/{q.id}", {"bonus": 7})

    def test_manager_sees_only_assistants_of_the_branch_and_secrets_are_dropped(self):
        r = self.call(self.manager, "get", "/api/hr-activity")
        self.assertEqual(r.status_code, 200, r.content)
        body = r.json()
        self.assertEqual({a["username"] for a in body["accounts"]}, {"hc_asst", "hc_asst2"})
        self.assertEqual({row["username"] for row in body["results"]}, {"hc_asst"})
        row = body["results"][0]
        self.assertEqual((row["module"], row["action"]), ("payroll", "update"))
        self.assertEqual(row["newValues"], {"request": {"bonus": 5}})  # the password key never reaches the trail
        self.assertFalse(body["canSeeManagers"])
        self.assertEqual(self.call(self.manager, "get", "/api/hr-activity?category=hr_manager").status_code, 403)

    def test_manager_sees_only_modules_it_can_open(self):
        HRUser.objects.filter(pk=self.manager.pk).update(permission_overrides={"modules": {"payroll": "hidden"}})
        rows = self.call(self.manager, "get", "/api/hr-activity").json()["results"]
        self.assertEqual(rows, [])

    def test_super_admin_sees_everyone_and_others_are_refused(self):
        body = self.call(self.super_admin, "get", "/api/hr-activity").json()
        self.assertEqual({row["username"] for row in body["results"]}, {"hc_asst", "hc_asst_b"})
        self.assertTrue(body["canSeeManagers"])
        filtered = self.call(self.super_admin, "get", f"/api/hr-activity?accountId={self.assistant_b.id}").json()
        self.assertEqual({row["username"] for row in filtered["results"]}, {"hc_asst_b"})
        for user in (self.assistant, self.admin, self.md):
            self.assertEqual(self.call(user, "get", "/api/hr-activity").status_code, 403, user.username)

    def test_admin_changes_are_not_logged_by_the_new_trail(self):
        p = Payroll.objects.create(
            employee=self.emp_a,
            salary_mode="monthly",
            month=9,
            year=2026,
            base_salary=1,
            gross_salary=1,
            final_salary=1,
        )
        before = AuditLog.objects.count()
        self.assertEqual(self.call(self.admin, "patch", f"/api/payroll/{p.id}", {"bonus": 1}).status_code, 200)
        self.assertEqual(AuditLog.objects.count(), before)


class HelperRules(TestCase):
    def test_catalogue(self):
        # 2026-11-11: "request" became one kind per request type and "advance" general / term; the payroll month,
        # OT, bonus, interview and screening decisions got switches of their own (permission-inventory.md)
        self.assertEqual(
            hr_access.APPROVAL_KEYS,
            ("leave", "permission", "casual_leave", "missing_punch", "attendance_correction", "on_duty", "on_duty_punch",
             "outpass", "request_leave", "request_salary_enquiry", "request_shift_correction", "request_advance",
             "request_permission", "request_general", "resignation", "interview_result", "resume_decision",
             "advance_general", "advance_term", "payroll_hold", "payroll_add", "payroll_finalize", "payroll_mark_paid",
             "payroll_release", "payroll_mark_cleared", "compensation_ot", "bonus_status"),
        )  # fmt: skip
        self.assertEqual(set(hr_access.ASSISTANT_LOCKED), {"missing_punch", "attendance_correction"})
        for kind in hr_access.APPROVAL_KINDS:
            if kind.replaces:
                approval.definition(kind.replaces)  # a request type / an advance type: its workflow is the old kind's
            elif not kind.needs_edit:
                approval.definition(kind.key)  # every request kind is a real workflow
        for pattern, _method, kind in hr_access.DECISION_ROUTES:
            self.assertTrue(kind in hr_access.KIND_BY_KEY or kind in hr_access.ALIASES, pattern)

    def test_decision_routes(self):
        self.assertEqual(hr_access.decision_kind("missing-punch-requests/4/status", "PATCH"), "missing_punch")
        self.assertIsNone(hr_access.decision_kind("missing-punch-requests/4/status", "DELETE"))
        self.assertIsNone(hr_access.decision_kind("missing-punch-requests", "PATCH"))
        self.assertEqual(hr_access.decision_kind("advances/9", "PUT"), "advance")

    def test_unknown_category_is_read_as_the_most_restricted(self):
        user = HRUser(username="x", category="boss")
        self.assertEqual(hr_access.category_of(user), "hr_assistant")

    def test_no_actor_means_no_change(self):
        self.assertTrue(hr_access.actor_may_approve("missing_punch"))
        self.assertIsNone(hr_access.actor_refusal("missing_punch"))

    @mock.patch("api.hr_access.current_actor")
    def test_legacy_actor_keeps_the_screens_unchanged(self, current):
        role = Role(name="r", permissions={"missing_punch": "view"})
        current.return_value = HRUser(username="x", role=role)
        self.assertTrue(hr_access.actor_may_approve("missing_punch"))  # display unchanged for the old rule
        self.assertIsNotNone(hr_access.actor_refusal("missing_punch"))  # but deciding still needs edit

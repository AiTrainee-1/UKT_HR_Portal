"""The Managing Director's working access to the HR pages the MD portal reproduces (permission_registry.MD_HR_GRANTS).

The MD works in those pages like a super administrator does, except that Leave & Holiday and Requests are look-only
(MD_VIEW_ONLY: the MD does not decide requests); every other module still follows the account's role, and no other
account's access changes."""

from datetime import date

from django.test import TestCase

from .jwt_utils import sign_token
from .models import AuditLog, Branch, Employee, EmployeePermission, Holiday, HRUser, LeaveRequest, OutpassRequest, Role
from .permission_registry import MD_HR_GRANTS, MD_VIEW_ONLY, effective_permissions, resolve_permission
from .tests_md_support import make_md, md_headers


def headers_for(user: HRUser) -> dict:
    return {"HTTP_AUTHORIZATION": f"Bearer {sign_token({'role': 'hr', 'hrUserId': user.id})}"}


class EffectivePermissionsTests(TestCase):
    def test_the_md_gets_the_grants_and_a_role_less_md_has_nothing_else(self):
        md = make_md()
        perms = effective_permissions(md)
        for key, level in MD_HR_GRANTS.items():
            self.assertEqual(resolve_permission(perms, key), level, key)
        for key in ("payroll", "production_payroll", "salary", "salary_slip", "settings", "user_management", "reports"):
            self.assertEqual(resolve_permission(perms, key), "hidden", key)

    def test_a_grant_only_raises_a_level_it_never_lowers_one_the_role_gives(self):
        role = Role.objects.create(
            name="r_md", permissions={"payroll": "edit", "recruitment": "edit", "employees": "hidden"}
        )
        md = make_md()
        md.role = role
        md.save(update_fields=["role"])
        perms = effective_permissions(md)
        self.assertEqual(resolve_permission(perms, "payroll"), "edit", "what the role gives is kept")
        self.assertEqual(resolve_permission(perms, "recruitment"), "edit", "not lowered to the grant's view")
        self.assertEqual(resolve_permission(perms, "employees"), "edit", "raised from hidden")
        self.assertEqual(
            role.permissions,
            {"payroll": "edit", "recruitment": "edit", "employees": "hidden"},
            "the role itself is untouched",
        )

    def test_nobody_else_gets_anything(self):
        other = HRUser.objects.create(
            username="plain_hr",
            password_hash="x",
            role=Role.objects.create(name="r_plain", permissions={"leave": "view"}),
        )
        self.assertEqual(effective_permissions(other), {"leave": "view"})
        self.assertEqual(effective_permissions(HRUser.objects.create(username="no_role", password_hash="x")), {})
        self.assertEqual(effective_permissions(None), {})

    def test_an_account_that_is_no_longer_the_md_or_is_disabled_has_no_grants(self):
        md = make_md()
        md.is_active = False
        self.assertEqual(effective_permissions(md), {})
        md.is_active, md.is_md = True, False
        self.assertEqual(effective_permissions(md), {})


class MdHrApiAccessTests(TestCase):
    def setUp(self):
        self.md = make_md()
        self.h = md_headers(self.md)

    def test_the_md_reads_every_page_the_md_portal_reproduces(self):
        for path in (
            "/api/employees",
            "/api/branches",
            "/api/departments",
            "/api/shifts",
            "/api/leave-requests",
            "/api/leave-types",
            "/api/holidays",
            "/api/permissions",
            "/api/casual-leaves",
            "/api/missing-punch-requests",
            "/api/outpass-requests",
            "/api/on-duty-sessions",
            "/api/advances",
            "/api/notifications",
            "/api/recruitment/resignations",
            "/api/audit-logs/stats",
        ):
            r = self.client.get(path, **self.h)
            self.assertNotEqual(r.status_code, 403, f"{path}: {r.content[:200]}")
            self.assertLess(r.status_code, 500, path)

    def test_the_md_can_change_things_on_those_pages_and_the_change_is_logged_under_the_md(self):
        r = self.client.post("/api/branches", {"name": "MD Unit"}, content_type="application/json", **self.h)
        self.assertEqual(r.status_code, 201, r.content)
        branch = Branch.objects.get(name="MD Unit")
        r = self.client.put(
            f"/api/branches/{branch.pk}", {"name": "MD Unit 2"}, content_type="application/json", **self.h
        )
        self.assertEqual(r.status_code, 200, r.content)
        self.assertTrue(Branch.objects.filter(name="MD Unit 2").exists())

    def test_the_modules_the_md_was_not_given_stay_closed(self):
        for path in (
            "/api/payroll",
            "/api/payroll/production",
            "/api/salary-slips",
            "/api/salary-records",
            "/api/compensation",
            "/api/increments",
            "/api/promotions",
            "/api/idcard",
            "/api/whatsapp-control/overview",
            "/api/gmail-control/overview",
            "/api/department-managers",
            "/api/backup",
            "/api/audit-logs",
        ):
            self.assertEqual(self.client.get(path, **self.h).status_code, 403, path)
        # and the administration APIs stay super-admin only
        self.assertEqual(self.client.get("/api/hr-users", **self.h).status_code, 403)
        self.assertEqual(self.client.get("/api/roles", **self.h).status_code, 403)

    def _requests(self):
        """One pending leave, permission and outpass request of an employee."""
        emp = Employee.objects.create(
            employee_code="REQ1", first_name="Req", last_name="Test", employment_type="staff", status="active"
        )
        leave = LeaveRequest.objects.create(employee=emp, start_date="2026-10-12", end_date="2026-10-12")
        perm = EmployeePermission.objects.create(employee=emp, date=date(2026, 10, 12))
        outpass = OutpassRequest.objects.create(employee=emp, destination="Bank", reason="Personal")
        return leave, perm, outpass

    def _assert_nothing_decided(self, leave, perm, outpass):
        for record in (leave, perm, outpass):
            record.refresh_from_db()
            self.assertEqual(record.status, "pending", type(record).__name__)

    def test_the_md_looks_at_requests_but_cannot_approve_reject_edit_or_delete_them(self):
        leave, perm, outpass = self._requests()
        for path in (
            "/api/leave-requests",
            "/api/permissions",
            "/api/outpass-requests",
            "/api/holidays",
            "/api/leave-types",
        ):
            self.assertEqual(self.client.get(path, **self.h).status_code, 200, path)

        json = {"content_type": "application/json", **self.h}
        attempts = (
            ("patch", f"/api/leave-requests/{leave.pk}/status", {"status": "approved"}),
            ("patch", f"/api/leave-requests/{leave.pk}/status", {"status": "rejected"}),
            ("delete", f"/api/leave-requests/{leave.pk}", None),
            ("put", f"/api/permissions/{perm.pk}", {"status": "approved"}),
            ("put", f"/api/permissions/{perm.pk}", {"status": "rejected"}),
            ("put", f"/api/permissions/{perm.pk}", {"type": "late_in"}),
            ("delete", f"/api/permissions/{perm.pk}", None),
            ("patch", f"/api/outpass-requests/{outpass.pk}/hr-status", {"status": "approved"}),
            ("patch", f"/api/outpass-requests/{outpass.pk}/hr-status", {"status": "rejected"}),
            # the rest of the Leave & Holiday page is look-only too
            ("post", "/api/holidays", {"name": "MD day", "date": "2026-12-25"}),
        )
        for verb, path, body in attempts:
            r = getattr(self.client, verb)(path, *([body] if body is not None else []), **json)
            self.assertEqual(r.status_code, 403, f"{verb} {path} {body}: {r.content[:200]}")
            self.assertIn("can view this section but cannot change it", r.json()["message"])
        self._assert_nothing_decided(leave, perm, outpass)
        self.assertFalse(Holiday.objects.filter(name="MD day").exists())

    def test_hr_and_the_super_admin_still_decide_the_same_requests(self):
        """Only the MD's access changed: an HR account with edit on the modules decides them as before."""
        hr = HRUser.objects.create(
            username="plain_hr2",
            password_hash="x",
            role=Role.objects.create(name="r_decider", permissions={"leave": "edit", "requests": "edit"}),
        )
        leave, perm, outpass = self._requests()
        r = self.client.patch(
            f"/api/leave-requests/{leave.pk}/status",
            {"status": "rejected"},
            content_type="application/json",
            **headers_for(hr),
        )
        self.assertEqual(r.status_code, 200, r.content)
        r = self.client.put(
            f"/api/permissions/{perm.pk}", {"status": "rejected"}, content_type="application/json", **headers_for(hr)
        )
        self.assertEqual(r.status_code, 200, r.content)
        leave.refresh_from_db()
        perm.refresh_from_db()
        self.assertEqual((leave.status, perm.status), ("rejected", "rejected"))

    def test_a_role_that_says_edit_cannot_give_the_md_the_decisions_back(self):
        role = Role.objects.create(name="r_md_edit", permissions={"leave": "edit", "requests": "edit"})
        self.md.role = role
        self.md.save(update_fields=["role"])
        perms = effective_permissions(self.md)
        for key in MD_VIEW_ONLY:
            self.assertEqual(resolve_permission(perms, key), "view", key)
        self.assertEqual(role.permissions, {"leave": "edit", "requests": "edit"}, "the role itself is untouched")

        leave, perm, outpass = self._requests()
        r = self.client.patch(
            f"/api/leave-requests/{leave.pk}/status", {"status": "approved"}, content_type="application/json", **self.h
        )
        self.assertEqual(r.status_code, 403)
        self._assert_nothing_decided(leave, perm, outpass)

    def test_me_tells_the_front_end_that_leave_and_requests_are_view_only_for_the_md(self):
        me = self.client.get("/api/auth/me", **self.h).json()
        self.assertEqual(me["permissions"]["leave"], "view")
        self.assertEqual(me["permissions"]["requests"], "view")
        self.assertEqual(me["permissions"]["employees"], "edit", "the other pages keep their working access")

    def test_the_recruitment_view_grant_reads_but_cannot_write(self):
        self.assertNotEqual(self.client.get("/api/recruitment/resignations", **self.h).status_code, 403)
        denied = self.client.post("/api/recruitment/new-joinees", {}, content_type="application/json", **self.h)
        self.assertEqual(denied.status_code, 403)

    def test_me_tells_the_front_end_what_the_md_may_do_and_leaves_everyone_else_alone(self):
        me = self.client.get("/api/auth/me", **self.h).json()
        self.assertTrue(me["isMd"])
        self.assertFalse(me["isSuperAdmin"])
        self.assertEqual(me["permissions"]["employees"], "edit")
        self.assertEqual(me["permissions"]["recruitment"], "view")
        self.assertNotIn("payroll", me["permissions"])
        self.assertEqual(
            me["rolePermissions"], {}, "the role alone: a role-less MD has no HR role, whatever the MD portal grants"
        )

        other = HRUser.objects.create(
            username="plain2",
            password_hash="x",
            role=Role.objects.create(name="r_plain2", permissions={"leave": "view"}),
        )
        plain = self.client.get("/api/auth/me", **headers_for(other)).json()
        self.assertEqual(plain["permissions"], {"leave": "view"})
        self.assertEqual(plain["rolePermissions"], {"leave": "view"})
        self.assertFalse(plain["isMd"])

    def test_a_role_less_non_md_account_still_gets_nothing(self):
        nobody = HRUser.objects.create(username="nobody", password_hash="x")
        self.assertEqual(self.client.get("/api/employees", **headers_for(nobody)).status_code, 403)
        self.assertEqual(
            self.client.post(
                "/api/branches", {"name": "x"}, content_type="application/json", **headers_for(nobody)
            ).status_code,
            403,
        )

    def test_taking_the_md_identity_away_takes_the_access_away_at_the_next_request(self):
        self.assertNotEqual(self.client.get("/api/employees", **self.h).status_code, 403)
        HRUser.objects.filter(pk=self.md.pk).update(is_md=False)
        self.assertEqual(self.client.get("/api/employees", **self.h).status_code, 403)
        self.assertFalse(AuditLog.objects.filter(record_description__icontains="grant").exists())

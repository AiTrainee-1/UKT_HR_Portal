"""
Holiday / Sunday work compensation: HR raises a claim, the Department Head approves it, the shifts reach the balance.

Covers the HR endpoints (raise / list / eligible / withdraw), the approval path through the Department Head's own endpoints,
the rules that refuse a claim, the switches, permissions and branch scope, the new `holiday_work` approval workflow, and the
`canApproveCompensation` HOD switch in the manager APIs.

Run via: python manage.py test api.tests_holiday_work -v 2
"""

from datetime import date, time
from decimal import Decimal
from unittest import mock

from django.db import connection
from django.test import TestCase
from django.test.utils import CaptureQueriesContext

from . import approval_workflow as approval
from . import whatsapp_approvals
from .jwt_utils import sign_token
from .models import (
    Attendance,
    AttendanceDayRecord,
    AttendanceLog,
    AuditLog,
    Branch,
    CompensationConfig,
    CompensationLedger,
    Department,
    DepartmentManager,
    Employee,
    HolidayWorkClaim,
    HRUser,
    ManagerDepartmentAssignment,
    ManagerEmployeeAssignment,
    Notification,
    PayrollSettings,
    Role,
)

TODAY = date(2026, 10, 14)  # a Wednesday
SUNDAY = date(2026, 10, 11)
HOLIDAY = date(2026, 10, 2)  # a Friday, declared below
BASE = "/api/compensation/holiday-work"


def _bearer(payload: dict) -> dict:
    return {"HTTP_AUTHORIZATION": f"Bearer {sign_token(payload)}"}


def _hr_user(username, permissions=None, branch=None, super_admin=False) -> HRUser:
    role = None
    if permissions is not None:
        role = Role.objects.create(name=f"role_{username}", permissions=permissions)
    return HRUser.objects.create(
        username=username,
        password_hash="x",
        full_name=username.title(),
        role=role,
        branch=branch,
        is_super_admin=super_admin,
    )


def _hr_headers(user: HRUser) -> dict:
    return _bearer({"role": "hr", "hrUserId": user.id, "name": user.full_name})


def _employee(code, branch=None, department=None, kind="staff", status="active", **kw) -> Employee:
    return Employee.objects.create(
        employee_code=code,
        first_name=code,
        last_name="Hw",
        employment_type=kind,
        status=status,
        branch=branch,
        department=department,
        **kw,
    )


def _punch(emp, day, when_in=time(9, 0), when_out=time(17, 30)):
    AttendanceLog.objects.get_or_create(
        employee=emp, date=day, punch_time=when_in, punch_type="IN", defaults={"source": "biometric"}
    )
    AttendanceLog.objects.get_or_create(
        employee=emp, date=day, punch_time=when_out, punch_type="OUT", defaults={"source": "biometric"}
    )


class HolidayWorkBase(TestCase):
    def setUp(self):
        approval.clear_cache()
        self.addCleanup(approval.clear_cache)
        for target in ("api.holiday_work_views.ist_today",):
            patch = mock.patch(target, return_value=TODAY)
            patch.start()
            self.addCleanup(patch.stop)
        settings = PayrollSettings.get()
        settings.compensation_feature_enabled = True
        settings.save()
        CompensationConfig.objects.update_or_create(pk=1, defaults={"holiday_work_enabled": True})

        self.ho = Branch.objects.create(name="HW Head Office", code="HWHO", is_head_office=True)
        self.u2 = Branch.objects.create(name="HW Unit 2", code="HWU2")
        self.cutting = Department.objects.create(name="HW Cutting", branch=self.ho)
        self.sewing = Department.objects.create(name="HW Sewing", branch=self.u2)
        self.asha = _employee("HW1", self.ho, self.cutting)
        self.ravi = _employee("HW2", self.ho, self.cutting)
        self.mani = _employee("HW3", self.u2, self.sewing)
        self.prod = _employee("HWP", self.ho, self.cutting, kind="production")
        self.gone = _employee("HWX", self.ho, self.cutting, status="inactive")
        self.boss = _employee("HWB", self.ho, self.cutting, phone="9000000001")
        self.manager = DepartmentManager.objects.create(employee=self.boss)
        ManagerDepartmentAssignment.objects.create(manager=self.manager, department=self.cutting)
        self.hod = _bearer({"role": "employee", "employeeId": self.boss.id})
        self.asha_token = _bearer({"role": "employee", "employeeId": self.asha.id})
        from .models import Holiday

        Holiday.objects.create(name="Gandhi Jayanti", date=HOLIDAY)

        self.admin_user = _hr_user("hw_admin", super_admin=True)
        self.admin = _hr_headers(self.admin_user)
        self.view_only = _hr_headers(_hr_user("hw_view", {"compensation": "view"}))
        self.no_access = _hr_headers(_hr_user("hw_none", {"leave": "edit"}))
        self.ho_hr_user = _hr_user("hw_ho", {"compensation": "edit"}, branch=self.ho)
        self.ho_hr = _hr_headers(self.ho_hr_user)

        for emp in (self.asha, self.ravi, self.mani, self.prod, self.gone, self.boss):
            _punch(emp, SUNDAY)
        _punch(self.asha, HOLIDAY)

    # request helpers
    def post(self, body, who=None, path=BASE):
        return self.client.post(path, body, content_type="application/json", **(who or self.admin))

    def get(self, path=BASE, who=None, **params):
        return self.client.get(path, params, **(who or self.admin))

    def delete(self, path, who=None):
        return self.client.delete(path, **(who or self.admin))

    def patch_hod(self, claim, body, who=None):
        return self.client.patch(
            f"/api/manager/holiday-work/{claim}/status", body, content_type="application/json", **(who or self.hod)
        )

    def raise_claim(self, emp=None, work_date=SUNDAY, shifts=0.5, reason="Dispatch rush", who=None):
        response = self.post(
            {
                "employeeId": (emp or self.asha).id,
                "workDate": work_date.isoformat(),
                "shifts": shifts,
                "reason": reason,
            },
            who,
        )
        self.assertEqual(response.status_code, 201, response.content)
        return HolidayWorkClaim.objects.get(pk=response.json()["claims"][0]["id"])


# ═════════════════════════════ raising a claim ═════════════════════════════


class RaiseClaimTests(HolidayWorkBase):
    def test_hr_raises_a_claim_for_a_sunday_and_it_waits_for_the_department_head(self):
        r = self.post({"employeeId": self.asha.id, "workDate": "2026-10-11", "shifts": 0.5, "reason": "Dispatch rush"})
        self.assertEqual(r.status_code, 201, r.content)
        body = r.json()
        self.assertEqual(body["created"], 1)
        row = body["claims"][0]
        self.assertEqual(
            (row["employeeCode"], row["workDate"], row["dayKind"], row["shifts"], row["status"]),
            ("HW1", "2026-10-11", "sunday", 0.5, "pending"),
        )
        self.assertEqual((row["requestedBy"], row["hodName"], row["credited"]), ("Hw_Admin", "HWB Hw", False))
        self.assertEqual(row["approval"]["waitingFor"], ["hod"])
        self.assertEqual((row["approval"]["canAct"]["hod"], row["approval"]["canAct"]["hr"]), (True, False))
        claim = HolidayWorkClaim.objects.get()
        self.assertEqual((claim.status, claim.approval_trail, claim.reason), ("pending", [], "Dispatch rush"))
        self.assertFalse(CompensationLedger.objects.exists())  # nothing is credited before the HOD decides

    def test_a_claim_nobody_can_decide_yet_comes_with_a_warning(self):
        r = self.post({"employeeId": self.asha.id, "workDate": "2026-10-11", "shifts": 1, "reason": "x"})
        self.assertEqual(r.json()["warnings"], [])
        # no Department Head for the employee
        r = self.post({"employeeId": self.mani.id, "workDate": "2026-10-11", "shifts": 1, "reason": "x"})
        self.assertEqual(r.status_code, 201)
        self.assertIn("has no Department Head assigned", r.json()["warnings"][0])
        self.assertIsNone(r.json()["claims"][0]["hodName"])
        # a head is not their own approver
        r = self.post({"employeeId": self.boss.id, "workDate": "2026-10-11", "shifts": 1, "reason": "x"})
        self.assertIn("never decides their own claim", r.json()["warnings"][0])
        # a head whose profile may not approve compensation
        self.manager.can_approve_compensation = False
        self.manager.save()
        r = self.post({"employeeId": self.ravi.id, "workDate": "2026-10-11", "shifts": 1, "reason": "x"})
        self.assertIn("cannot approve compensation", r.json()["warnings"][0])
        self.assertIn("HWB Hw", r.json()["warnings"][0])

    def test_the_department_head_is_told_and_the_action_is_audited(self):
        claim = self.raise_claim()
        note = Notification.objects.get(employee=self.boss)
        self.assertEqual(note.type, "holiday_work")
        self.assertIn("waiting for your approval", note.message)
        log = AuditLog.objects.get(module="compensation", action="create", record_id=claim.id)
        self.assertIn("HW1", log.record_description)
        self.assertEqual(log.new_values["reason"], "Dispatch rush")

    def test_a_head_is_not_told_about_their_own_claim(self):
        r = self.post({"employeeId": self.boss.id, "workDate": "2026-10-11", "shifts": 1, "reason": "x"})
        self.assertEqual(r.status_code, 201, r.content)
        # HR still hears that nobody can decide it
        self.assertIn("never decides their own claim", r.json()["warnings"][0])
        # the head cannot decide it (PATCH is a 403): a "waiting for your approval" notice would open an empty list
        self.assertFalse(Notification.objects.filter(employee=self.boss).exists())
        self.assertFalse(Notification.objects.filter(type="holiday_work").exists())  # and nobody is told in their place
        # an ordinary claim still reaches the head
        self.raise_claim(self.asha)
        self.assertEqual(Notification.objects.filter(employee=self.boss, type="holiday_work").count(), 1)

    def test_a_head_under_another_head_has_that_other_head_told(self):
        other = _employee("HWO", self.u2, self.sewing)
        other_manager = DepartmentManager.objects.create(employee=other)
        ManagerEmployeeAssignment.objects.create(manager=other_manager, employee=self.boss)
        self.raise_claim(self.boss)
        (note,) = Notification.objects.filter(type="holiday_work")
        self.assertEqual(note.employee_id, other.id)
        self.assertIn("HWB Hw's holiday-work compensation claim", note.message)

    def test_a_head_without_the_compensation_switch_is_not_told(self):
        self.manager.can_approve_compensation = False
        self.manager.save()
        self.raise_claim(self.asha)
        self.assertFalse(Notification.objects.filter(type="holiday_work").exists())

    def test_a_declared_holiday_counts_like_a_sunday(self):
        r = self.post({"employeeId": self.asha.id, "workDate": "2026-10-02", "shifts": 1, "reason": "Festival shift"})
        self.assertEqual(r.status_code, 201, r.content)
        row = r.json()["claims"][0]
        self.assertEqual((row["dayKind"], row["holidayName"], row["shifts"]), ("holiday", "Gandhi Jayanti", 1.0))

    def test_every_one_of_the_four_amounts_is_accepted_and_nothing_else(self):
        for day, amount in (
            (date(2026, 10, 4), 0.25),
            (date(2026, 9, 27), "0.50"),
            (date(2026, 9, 20), 0.75),
            (SUNDAY, 1),
        ):
            _punch(self.ravi, day)
            r = self.post({"employeeId": self.ravi.id, "workDate": day.isoformat(), "shifts": amount, "reason": "x"})
            self.assertEqual(r.status_code, 201, (amount, r.content))
        self.assertEqual(
            sorted(str(c.shifts) for c in HolidayWorkClaim.objects.filter(employee=self.ravi)),
            ["0.25", "0.50", "0.75", "1.00"],
        )
        for bad in (0.3, 0, 2, -1, "half", True, [1]):
            r = self.post({"employeeId": self.asha.id, "workDate": "2026-10-11", "shifts": bad, "reason": "x"})
            self.assertEqual(r.status_code, 400, bad)
            self.assertIn("shifts must be 0.25, 0.50, 0.75 or 1", r.json()["error"])
        r = self.post({"employeeId": self.asha.id, "workDate": "2026-10-11", "reason": "x"})
        self.assertEqual((r.status_code, "shifts is required" in r.json()["error"]), (400, True))
        self.assertEqual(HolidayWorkClaim.objects.filter(employee=self.asha).count(), 0)

    def test_a_working_day_is_refused(self):
        r = self.post({"employeeId": self.asha.id, "workDate": "2026-10-12", "shifts": 1, "reason": "x"})
        self.assertEqual(r.status_code, 400)
        self.assertIn("neither a Sunday nor a declared holiday", r.json()["error"])

    def test_a_date_that_has_not_happened_yet_is_refused(self):
        r = self.post({"employeeId": self.asha.id, "workDate": "2026-10-18", "shifts": 1, "reason": "x"})
        self.assertEqual((r.status_code, "has not happened yet" in r.json()["error"]), (400, True))

    def test_the_age_limit_is_45_days_inclusive(self):
        _punch(self.asha, date(2026, 8, 30))  # exactly 45 days before today: still allowed
        _punch(self.asha, date(2026, 8, 23))  # 52 days
        ok = self.post({"employeeId": self.asha.id, "workDate": "2026-08-30", "shifts": 1, "reason": "x"})
        self.assertEqual(ok.status_code, 201, ok.content)
        old = self.post({"employeeId": self.asha.id, "workDate": "2026-08-23", "shifts": 1, "reason": "x"})
        self.assertEqual(old.status_code, 400)
        self.assertIn("last 45 days", old.json()["error"])

    def test_workdate_must_be_a_date(self):
        for bad in (None, "", "tomorrow", "2026-13-40", 5):
            r = self.post({"employeeId": self.asha.id, "workDate": bad, "shifts": 1, "reason": "x"})
            self.assertEqual(r.status_code, 400, bad)

    def test_a_reason_is_required_and_bounded(self):
        r = self.post({"employeeId": self.asha.id, "workDate": "2026-10-11", "shifts": 1, "reason": "  "})
        self.assertEqual((r.status_code, "reason" in r.json()["error"].lower()), (400, True))
        r = self.post({"employeeId": self.asha.id, "workDate": "2026-10-11", "shifts": 1, "reason": "x" * 501})
        self.assertEqual(r.status_code, 400)

    def test_the_work_has_to_be_on_record(self):
        AttendanceLog.objects.filter(employee=self.ravi).delete()
        r = self.post({"employeeId": self.ravi.id, "workDate": "2026-10-11", "shifts": 1, "reason": "x"})
        self.assertEqual(r.status_code, 400)
        self.assertIn("no punches or attendance", r.json()["error"])
        # a manual attendance entry marked present is a record of the work
        Attendance.objects.create(employee=self.ravi, date="2026-10-11", present=True)
        self.assertEqual(
            self.post({"employeeId": self.ravi.id, "workDate": "2026-10-11", "shifts": 1, "reason": "x"}).status_code,
            201,
        )
        # so is a present day record (an approved correction); an absent one is not
        AttendanceDayRecord.objects.create(employee=self.mani, date=date(2026, 10, 4), status="absent")
        AttendanceLog.objects.filter(employee=self.mani).delete()
        r = self.post({"employeeId": self.mani.id, "workDate": "2026-10-04", "shifts": 1, "reason": "x"})
        self.assertEqual(r.status_code, 400)
        AttendanceDayRecord.objects.filter(employee=self.mani).update(status="present")
        self.assertEqual(
            self.post({"employeeId": self.mani.id, "workDate": "2026-10-04", "shifts": 1, "reason": "x"}).status_code,
            201,
        )

    def test_a_production_employee_and_an_inactive_one_are_refused(self):
        for emp, fragment in ((self.prod, "production"), (self.gone, "not an active")):
            r = self.post({"employeeId": emp.id, "workDate": "2026-10-11", "shifts": 1, "reason": "x"})
            self.assertEqual(r.status_code, 400, emp.employee_code)
            self.assertIn(fragment, r.json()["error"])
        self.assertFalse(HolidayWorkClaim.objects.exists())

    def test_an_unknown_employee_is_a_404(self):
        r = self.post({"employeeId": 999999, "workDate": "2026-10-11", "shifts": 1, "reason": "x"})
        self.assertEqual(r.status_code, 404)

    def test_one_open_claim_per_employee_per_date(self):
        claim = self.raise_claim()
        again = self.post({"employeeId": self.asha.id, "workDate": "2026-10-11", "shifts": 1, "reason": "again"})
        self.assertEqual(again.status_code, 400)
        self.assertIn("already has a claim", again.json()["error"])
        self.assertIn("pending", again.json()["error"])
        self.patch_hod(claim.id, {"status": "approved"})
        again = self.post({"employeeId": self.asha.id, "workDate": "2026-10-11", "shifts": 1, "reason": "again"})
        self.assertEqual((again.status_code, "approved" in again.json()["error"]), (400, True))
        self.assertEqual(HolidayWorkClaim.objects.filter(employee=self.asha).count(), 1)

    def test_a_rejected_claim_can_be_raised_again(self):
        claim = self.raise_claim()
        self.assertEqual(self.patch_hod(claim.id, {"status": "rejected", "comment": "Not worked"}).status_code, 200)
        r = self.post({"employeeId": self.asha.id, "workDate": "2026-10-11", "shifts": 1, "reason": "Corrected"})
        self.assertEqual(r.status_code, 201, r.content)
        self.assertEqual(HolidayWorkClaim.objects.filter(employee=self.asha).count(), 2)

    def test_several_employees_at_once_or_none_at_all(self):
        r = self.post(
            {"employeeIds": [self.asha.id, self.ravi.id], "workDate": "2026-10-11", "shifts": 0.75, "reason": "x"}
        )
        self.assertEqual((r.status_code, r.json()["created"]), (201, 2))
        self.assertEqual(sorted(c["employeeCode"] for c in r.json()["claims"]), ["HW1", "HW2"])
        HolidayWorkClaim.objects.all().delete()
        AttendanceLog.objects.filter(employee=self.ravi).delete()  # Ravi has no work on record
        r = self.post(
            {"employeeIds": [self.asha.id, self.ravi.id], "workDate": "2026-10-11", "shifts": 0.75, "reason": "x"}
        )
        self.assertEqual(r.status_code, 400)
        self.assertEqual([p["employeeId"] for p in r.json()["problems"]], [self.ravi.id])
        self.assertFalse(HolidayWorkClaim.objects.exists())  # nothing was raised for Asha either

    def test_items_carry_their_own_shifts(self):
        r = self.post(
            {
                "workDate": "2026-10-11",
                "reason": "x",
                "shifts": 1,
                "items": [{"employeeId": self.asha.id, "shifts": 0.25}, {"employeeId": self.ravi.id}],
            }
        )
        self.assertEqual(r.status_code, 201, r.content)
        got = {c["employeeCode"]: c["shifts"] for c in r.json()["claims"]}
        self.assertEqual(got, {"HW1": 0.25, "HW2": 1.0})
        for body in (
            {"workDate": "2026-10-11", "reason": "x", "shifts": 1, "items": []},
            {"workDate": "2026-10-11", "reason": "x", "shifts": 1},
        ):
            self.assertEqual(self.post(body).status_code, 400)

    def test_an_employee_id_list_must_be_a_list_of_ids(self):
        for bad in ("1,2", [1, "x"], [None]):
            r = self.post({"employeeIds": bad, "workDate": "2026-10-11", "shifts": 1, "reason": "x"})
            self.assertEqual(r.status_code, 400, bad)

    def test_a_request_covers_at_most_200_employees(self):
        r = self.post({"employeeIds": list(range(1, 202)), "workDate": "2026-10-11", "shifts": 1, "reason": "x"})
        self.assertEqual((r.status_code, "at most 200" in r.json()["error"]), (400, True))


# ═════════════════════════════ switches, permissions, scope ═════════════════════════════


class GateTests(HolidayWorkBase):
    body = {"employeeId": None, "workDate": "2026-10-11", "shifts": 1, "reason": "x"}

    def attempt(self, who=None):
        return self.post({**self.body, "employeeId": self.asha.id}, who)

    def test_the_master_switch_refuses_changes_but_never_reads(self):
        claim = self.raise_claim()
        settings = PayrollSettings.get()
        settings.compensation_feature_enabled = False
        settings.save()
        self.assertEqual(self.attempt().status_code, 403)
        self.assertEqual(self.delete(f"{BASE}/{claim.id}").status_code, 403)
        self.assertEqual(self.get().status_code, 200)
        self.assertEqual(self.get(f"{BASE}/eligible", date="2026-10-11").status_code, 200)
        self.assertEqual(self.get(f"{BASE}/{claim.id}").status_code, 200)
        self.assertFalse(self.get().json()["enabled"]["master"])

    def test_the_holiday_work_switch_refuses_changes_but_never_reads(self):
        claim = self.raise_claim()
        CompensationConfig.objects.filter(pk=1).update(holiday_work_enabled=False)
        r = self.attempt()
        self.assertEqual((r.status_code, r.json()["code"]), (403, "feature_disabled"))
        self.assertIn("Settings > Compensation", r.json()["error"])
        self.assertEqual(self.delete(f"{BASE}/{claim.id}").status_code, 403)
        listed = self.get().json()
        self.assertEqual(
            (listed["count"], listed["enabled"]["holidayWork"], listed["enabled"]["canRaise"]), (1, False, False)
        )

    def test_switching_the_workflow_off_stops_new_claims_only(self):
        claim = self.raise_claim()
        approval.save_config("holiday_work", enabled=False, actor="test")
        r = self.attempt(self.admin)
        self.assertEqual((r.status_code, r.json()["code"]), (403, "workflow_disabled"))
        # the claim already waiting can still be decided by the Department Head, and withdrawn by HR
        ok = self.patch_hod(claim.id, {"status": "approved"})
        self.assertEqual(ok.status_code, 200, ok.content)
        self.assertEqual(CompensationLedger.objects.count(), 1)
        approval.save_config("holiday_work", enabled=True, actor="test")
        second = self.raise_claim(self.ravi)
        approval.save_config("holiday_work", enabled=False, actor="test")
        self.assertEqual(self.delete(f"{BASE}/{second.id}").status_code, 204)

    def test_a_role_without_the_compensation_module_is_refused_everywhere(self):
        for response in (
            self.get(who=self.no_access),
            self.get(f"{BASE}/eligible", who=self.no_access, date="2026-10-11"),
            self.attempt(self.no_access),
        ):
            self.assertEqual(response.status_code, 403)
            self.assertEqual(response.json()["error"], "permission_denied")

    def test_a_view_only_role_can_read_but_not_write(self):
        claim = self.raise_claim()
        self.assertEqual(self.get(who=self.view_only).status_code, 200)
        self.assertEqual(self.get(f"{BASE}/eligible", who=self.view_only, date="2026-10-11").status_code, 200)
        self.assertEqual(self.get(f"{BASE}/{claim.id}", who=self.view_only).status_code, 200)
        self.assertEqual(self.attempt(self.view_only).status_code, 403)
        self.assertEqual(self.delete(f"{BASE}/{claim.id}", who=self.view_only).status_code, 403)
        self.assertEqual(HolidayWorkClaim.objects.count(), 1)

    def test_an_employee_token_is_not_hr(self):
        for response in (
            self.get(who=self.hod),
            self.client.post(BASE, self.body, content_type="application/json", **self.hod),
        ):
            self.assertEqual(response.status_code, 403)
            self.assertEqual(response.json()["error"], "HR access required")

    def test_no_token_is_a_401(self):
        self.assertEqual(self.client.get(BASE).status_code, 401)
        self.assertEqual(self.client.get(f"{BASE}/eligible", {"date": "2026-10-11"}).status_code, 401)

    def test_a_branch_scoped_hr_user_only_reaches_their_own_branch(self):
        r = self.post({"employeeId": self.mani.id, "workDate": "2026-10-11", "shifts": 1, "reason": "x"}, self.ho_hr)
        self.assertEqual(r.status_code, 404)  # another branch's employee does not exist for them
        own = self.raise_claim(self.asha, who=self.ho_hr)
        other_branch = HolidayWorkClaim.objects.create(
            employee=self.mani, work_date=SUNDAY, shifts=Decimal("1.00"), reason="x", approval_trail=[]
        )
        seen = {c["id"] for c in self.get(who=self.ho_hr).json()["results"]}
        self.assertEqual(seen, {own.id})
        everything = {c["id"] for c in self.get().json()["results"]}
        self.assertEqual(everything, {own.id, other_branch.id})
        self.assertEqual(self.get(f"{BASE}/{other_branch.id}", who=self.ho_hr).status_code, 404)
        self.assertEqual(self.delete(f"{BASE}/{other_branch.id}", who=self.ho_hr).status_code, 404)
        rows = self.get(f"{BASE}/eligible", who=self.ho_hr, date="2026-10-11").json()["employees"]
        self.assertNotIn("HW3", [e["employeeCode"] for e in rows])
        self.assertEqual(
            self.get(f"{BASE}/eligible", who=self.ho_hr, date="2026-10-11", employeeId=self.mani.id).status_code, 404
        )


# ═════════════════════════════ list, eligible, withdraw ═════════════════════════════


class ListTests(HolidayWorkBase):
    def test_the_list_shows_claims_with_their_progress_and_a_summary(self):
        a = self.raise_claim(self.asha, shifts=0.5)
        b = self.raise_claim(self.ravi, shifts=1)
        self.patch_hod(b.id, {"status": "approved"})
        body = self.get(month=10, year=2026).json()
        self.assertEqual((body["count"], body["month"], body["year"]), (2, 10, 2026))
        self.assertEqual(
            body["summary"],
            {"pending": 1, "approved": 1, "rejected": 0, "approvedShifts": 1.0, "pendingShifts": 0.5},
        )
        by_id = {c["id"]: c for c in body["results"]}
        self.assertEqual(by_id[a.id]["approval"]["steps"][0]["state"], "pending")
        self.assertEqual(
            (by_id[b.id]["status"], by_id[b.id]["credited"], by_id[b.id]["reviewedBy"]), ("approved", True, "HWB Hw")
        )
        self.assertEqual(by_id[b.id]["approval"]["steps"][0]["state"], "approved")
        self.assertTrue(body["enabled"]["canRaise"])

    def test_filters(self):
        pending = self.raise_claim(self.asha)
        rejected = self.raise_claim(self.ravi)
        self.patch_hod(rejected.id, {"status": "rejected", "comment": "No"})
        self.assertEqual([c["id"] for c in self.get(status="pending").json()["results"]], [pending.id])
        self.assertEqual([c["id"] for c in self.get(status="waiting").json()["results"]], [pending.id])
        self.assertEqual([c["id"] for c in self.get(status="rejected").json()["results"]], [rejected.id])
        self.assertEqual(self.get(status="bogus").status_code, 400)
        self.assertEqual(self.get(employeeId=self.ravi.id).json()["count"], 1)
        self.assertEqual(self.get(departmentId=self.sewing.id).json()["count"], 0)
        # the month is the month of the WORK date
        self.assertEqual(self.get(month=9, year=2026).json()["count"], 0)
        self.assertEqual(self.get(month=13).status_code, 400)
        self.assertEqual(self.get(month="x").status_code, 400)
        self.assertEqual(self.get(year=2026).json()["count"], 2)  # a whole year

    def test_the_list_is_bounded_whatever_the_number_of_claims(self):
        self.raise_claim(self.asha)
        with CaptureQueriesContext(connection) as small:
            self.get(month=10, year=2026)
        for i in range(30):
            emp = _employee(f"HWQ{i}", self.ho, self.cutting)
            _punch(emp, SUNDAY)
            HolidayWorkClaim.objects.create(
                employee=emp, work_date=SUNDAY, shifts=Decimal("0.50"), reason="x", approval_trail=[]
            )
        with CaptureQueriesContext(connection) as large:
            body = self.get(month=10, year=2026).json()
        self.assertEqual(body["count"], 31)
        self.assertEqual(len(large), len(small))

    def test_limit_truncates(self):
        for i in range(3):
            emp = _employee(f"HWL{i}", self.ho, self.cutting)
            HolidayWorkClaim.objects.create(
                employee=emp, work_date=SUNDAY, shifts=Decimal("0.50"), reason="x", approval_trail=[]
            )
        body = self.get(month=10, year=2026, limit=2).json()
        self.assertEqual((len(body["results"]), body["count"], body["truncated"]), (2, 3, True))


class EligibleTests(HolidayWorkBase):
    def eligible(self, day="2026-10-11", **params):
        r = self.get(f"{BASE}/eligible", date=day, **params)
        self.assertEqual(r.status_code, 200, r.content)
        return r.json()

    def test_lists_the_staff_who_worked_that_sunday_with_their_punches(self):
        body = self.eligible()
        self.assertEqual((body["dayKind"], body["claimable"], body["message"]), ("sunday", True, None))
        codes = [e["employeeCode"] for e in body["employees"]]
        self.assertEqual(codes, ["HW1", "HW2", "HW3", "HWB"])  # staff and active only: no production, no inactive
        asha = body["employees"][0]
        self.assertEqual(
            (asha["punchCount"], asha["firstPunch"], asha["lastPunch"], asha["spanMinutes"], asha["eligible"]),
            (2, "09:00", "17:30", 510, True),
        )
        self.assertEqual(body["counts"], {"worked": 4, "eligible": 4})
        self.assertEqual(body["maxAgeDays"], 45)

    def test_someone_with_a_claim_says_why_they_cannot_be_claimed_again(self):
        claim = self.raise_claim(self.asha)
        row = next(e for e in self.eligible()["employees"] if e["employeeCode"] == "HW1")
        self.assertFalse(row["eligible"])
        self.assertIn("already has a claim", row["reason"])
        self.assertEqual(
            (row["claim"]["id"], row["claim"]["status"], row["claim"]["shifts"]), (claim.id, "pending", 0.5)
        )
        self.assertEqual(self.eligible()["counts"]["eligible"], 3)

    def test_asking_about_one_employee_explains_a_missing_one(self):
        AttendanceLog.objects.filter(employee=self.ravi).delete()
        body = self.eligible(employeeId=self.ravi.id)
        row = body["employees"][0]
        self.assertEqual((len(body["employees"]), row["eligible"], row["punchCount"]), (1, False, 0))
        self.assertIn("no punches or attendance", row["reason"])
        prod = self.eligible(employeeId=self.prod.id)["employees"][0]
        self.assertIn("production", prod["reason"])
        self.assertEqual(self.get(f"{BASE}/eligible", date="2026-10-11", employeeId=999999).status_code, 404)

    def test_a_weekday_has_nobody_to_claim_for(self):
        body = self.eligible("2026-10-12")
        self.assertEqual((body["dayKind"], body["claimable"], body["employees"]), (None, False, []))
        self.assertIn("neither a Sunday nor a declared holiday", body["message"])

    def test_a_holiday_and_a_too_old_date(self):
        holiday = self.eligible("2026-10-02")
        self.assertEqual(
            (holiday["dayKind"], holiday["holidayName"], holiday["claimable"]), ("holiday", "Gandhi Jayanti", True)
        )
        self.assertEqual([e["employeeCode"] for e in holiday["employees"]], ["HW1"])
        old = self.eligible("2026-08-23")
        self.assertFalse(old["claimable"])
        self.assertIn("last 45 days", old["message"])
        future = self.eligible("2026-10-18")
        self.assertIn("has not happened yet", future["message"])

    def test_a_date_is_required(self):
        for params in ({}, {"date": "nope"}):
            self.assertEqual(self.get(f"{BASE}/eligible", **params).status_code, 400)

    def test_manual_attendance_and_present_day_records_count_as_work(self):
        Attendance.objects.create(employee=self.prod, date="2026-10-04", present=True)
        AttendanceDayRecord.objects.create(employee=self.ravi, date=date(2026, 10, 4), status="present")
        Attendance.objects.create(employee=self.asha, date="2026-10-04", present=True)
        body = self.eligible("2026-10-04")
        self.assertEqual(sorted(e["employeeCode"] for e in body["employees"]), ["HW1", "HW2"])  # production left out

    def test_the_department_filter(self):
        body = self.eligible(departmentId=self.sewing.id)
        self.assertEqual([e["employeeCode"] for e in body["employees"]], ["HW3"])

    def test_the_listing_is_bounded_whatever_the_number_of_employees(self):
        with CaptureQueriesContext(connection) as small:
            self.eligible()
        for i in range(40):
            emp = _employee(f"HWE{i}", self.ho, self.cutting)
            _punch(emp, SUNDAY)
        with CaptureQueriesContext(connection) as large:
            body = self.eligible()
        self.assertEqual(body["counts"]["worked"], 44)
        self.assertEqual(len(large), len(small))


class WithdrawTests(HolidayWorkBase):
    def test_hr_can_withdraw_a_claim_that_is_still_waiting(self):
        claim = self.raise_claim()
        r = self.delete(f"{BASE}/{claim.id}")
        self.assertEqual(r.status_code, 204)
        self.assertFalse(HolidayWorkClaim.objects.exists())
        log = AuditLog.objects.get(module="compensation", action="delete", record_id=claim.id)
        self.assertEqual(log.old_values["shifts"], "0.50")
        # the Department Head no longer has it, and it can be raised again
        listed = self.client.get("/api/manager/pending-requests", **self.hod).json()
        self.assertEqual(listed["holidayWorkClaims"], [])
        self.raise_claim()

    def test_a_decided_claim_cannot_be_withdrawn(self):
        approved = self.raise_claim(self.asha)
        self.patch_hod(approved.id, {"status": "approved"})
        rejected = self.raise_claim(self.ravi)
        self.patch_hod(rejected.id, {"status": "rejected"})
        for claim in (approved, rejected):
            r = self.delete(f"{BASE}/{claim.id}")
            self.assertEqual(r.status_code, 400)
            self.assertIn("still waiting", r.json()["error"])
        self.assertEqual(HolidayWorkClaim.objects.count(), 2)
        self.assertEqual(CompensationLedger.objects.count(), 1)  # the credit is untouched

    def test_withdrawing_an_unknown_claim_is_a_404(self):
        self.assertEqual(self.delete(f"{BASE}/999999").status_code, 404)


# ═════════════════════════════ the Department Head decides ═════════════════════════════


class DepartmentHeadTests(HolidayWorkBase):
    def test_the_claim_appears_in_the_heads_lists_and_counts(self):
        claim = self.raise_claim()
        me = self.client.get("/api/manager/me", **self.hod).json()
        self.assertTrue(me["canApproveCompensation"])
        self.assertEqual((me["pendingCompensationCount"], me["pendingApprovalsCount"]), (1, 1))
        listed = self.client.get("/api/manager/pending-requests", **self.hod).json()
        self.assertEqual([c["id"] for c in listed["holidayWorkClaims"]], [claim.id])
        self.assertEqual(listed["totalPending"], 1)
        row = listed["holidayWorkClaims"][0]
        self.assertEqual(
            (row["employeeCode"], row["shifts"], row["status"], row["reason"]), ("HW1", 0.5, "pending", "Dispatch rush")
        )
        self.assertEqual(row["approval"]["waitingFor"], ["hod"])
        self.assertEqual(row["hodName"], "HWB Hw")
        self.assertIn("holiday_work", listed["approvalWorkflows"])

    def test_approval_credits_the_balance_exactly_once(self):
        claim = self.raise_claim(shifts=0.75)
        r = self.patch_hod(claim.id, {"status": "approved", "comment": "Verified"})
        self.assertEqual(r.status_code, 200, r.content)
        body = r.json()
        self.assertEqual(
            (body["status"], body["credited"], body["reviewedBy"], body["reviewComment"]),
            ("approved", True, "HWB Hw", "Verified"),
        )
        entry = CompensationLedger.objects.get()
        self.assertEqual(
            (
                entry.employee_id,
                entry.entry_type,
                entry.shifts,
                entry.date,
                entry.source,
                entry.claim_id,
                entry.created_by,
            ),
            (self.asha.id, "credit", Decimal("0.75"), SUNDAY, "holiday_work", claim.id, "HWB Hw"),
        )
        claim.refresh_from_db()
        self.assertEqual(
            (claim.status, claim.approval_trail[0]["role"], claim.approval_trail[0]["decision"]),
            ("approved", "hod", "approved"),
        )
        self.assertIsNotNone(claim.reviewed_at)
        self.assertEqual(body["hodName"], "HWB Hw")
        # the employee is told
        note = Notification.objects.get(employee=self.asha, type="compensation")
        self.assertIn("approved by your Department Head", note.message)
        self.assertIn("0.75 shift was added to your compensation balance", note.message)

    def test_a_second_approval_is_refused_and_credits_nothing_more(self):
        claim = self.raise_claim()
        self.assertEqual(self.patch_hod(claim.id, {"status": "approved"}).status_code, 200)
        again = self.patch_hod(claim.id, {"status": "approved"})
        self.assertEqual(again.status_code, 400)
        self.assertIn("already approved", again.json()["error"])
        flip = self.patch_hod(claim.id, {"status": "rejected"})
        self.assertEqual(flip.status_code, 400)
        self.assertEqual(CompensationLedger.objects.count(), 1)
        claim.refresh_from_db()
        self.assertEqual(claim.status, "approved")

    def test_the_credit_helper_is_idempotent_and_the_engine_decides_once(self):
        from .holiday_work_views import credit_balance, decide_claim

        claim = self.raise_claim()
        decide_claim(claim.id, approval.HOD, "approved", actor="Boss")
        with self.assertRaises(approval.ApprovalError):
            decide_claim(claim.id, approval.HOD, "approved", actor="Boss")
        claim.refresh_from_db()
        credit_balance(claim, "Boss")
        credit_balance(claim, "Boss")
        self.assertEqual(CompensationLedger.objects.filter(claim=claim).count(), 1)

    def test_a_rejection_keeps_the_reason_and_credits_nothing(self):
        claim = self.raise_claim()
        r = self.patch_hod(claim.id, {"status": "rejected", "comment": "He was on leave"})
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(
            (r.json()["status"], r.json()["reviewComment"], r.json()["credited"]),
            ("rejected", "He was on leave", False),
        )
        claim.refresh_from_db()
        self.assertEqual(
            (claim.status, claim.review_comment, claim.reviewed_by), ("rejected", "He was on leave", "HWB Hw")
        )
        self.assertEqual(claim.approval_trail[0]["comment"], "He was on leave")
        self.assertFalse(CompensationLedger.objects.exists())
        note = Notification.objects.get(employee=self.asha, type="compensation")
        self.assertIn("was rejected by your Department Head", note.message)
        # a rejection is final
        self.assertEqual(self.patch_hod(claim.id, {"status": "approved"}).status_code, 400)
        self.assertFalse(CompensationLedger.objects.exists())

    def test_a_claim_already_waiting_can_still_be_decided_while_the_switches_are_off(self):
        claim = self.raise_claim()
        settings = PayrollSettings.get()
        settings.compensation_feature_enabled = False
        settings.save()
        CompensationConfig.objects.filter(pk=1).update(holiday_work_enabled=False)
        # the claim was raised legitimately: only NEW claims are stopped, and the balance it earns is inert until HR redeems it
        r = self.patch_hod(claim.id, {"status": "approved"})
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(CompensationLedger.objects.count(), 1)

    def test_the_status_must_be_approved_or_rejected(self):
        claim = self.raise_claim()
        for bad in (None, "pending", "maybe", ""):
            r = self.patch_hod(claim.id, {"status": bad})
            self.assertEqual(r.status_code, 400, bad)
        self.assertEqual(HolidayWorkClaim.objects.get().status, "pending")

    def test_a_head_without_the_compensation_switch_cannot_decide_or_see_it(self):
        claim = self.raise_claim()
        self.manager.can_approve_compensation = False
        self.manager.save()
        r = self.patch_hod(claim.id, {"status": "approved"})
        self.assertEqual((r.status_code, r.json()["code"]), (403, "APPROVE_COMPENSATION_DISABLED"))
        me = self.client.get("/api/manager/me", **self.hod).json()
        self.assertEqual(
            (me["canApproveCompensation"], me["pendingCompensationCount"], me["pendingApprovalsCount"]), (False, 0, 0)
        )
        listed = self.client.get("/api/manager/pending-requests", **self.hod).json()
        self.assertEqual((listed["holidayWorkClaims"], listed["totalPending"]), ([], 0))
        self.assertEqual(HolidayWorkClaim.objects.get().status, "pending")
        self.assertFalse(CompensationLedger.objects.exists())

    def test_another_heads_employee_is_out_of_scope(self):
        claim = self.raise_claim(self.asha)
        outsider = _employee("HWO", self.u2, self.sewing)
        DepartmentManager.objects.create(employee=outsider)
        token = _bearer({"role": "employee", "employeeId": outsider.id})
        r = self.patch_hod(claim.id, {"status": "approved"}, token)
        self.assertEqual((r.status_code, r.json()["error"]), (403, "This request is not in your approval scope"))
        self.assertEqual(self.patch_hod(999999, {"status": "approved"}).status_code, 404)

    def test_an_employee_who_is_not_a_head_cannot_decide(self):
        claim = self.raise_claim()
        r = self.patch_hod(claim.id, {"status": "approved"}, self.asha_token)
        self.assertEqual((r.status_code, r.json()["error"]), (403, "Not a department manager"))

    def test_a_head_never_decides_a_claim_about_themselves(self):
        claim = self.raise_claim(self.boss)
        r = self.patch_hod(claim.id, {"status": "approved"})
        self.assertEqual(r.status_code, 403)
        self.assertFalse(CompensationLedger.objects.exists())
        me = self.client.get("/api/manager/me", **self.hod).json()
        self.assertEqual(me["pendingCompensationCount"], 0)

    def test_hr_is_not_part_of_the_pipeline(self):
        claim = self.raise_claim()
        self.assertFalse(approval.can_act("holiday_work", claim, approval.HR))
        self.assertTrue(approval.can_act("holiday_work", claim, approval.HOD))
        with self.assertRaises(approval.ApprovalError) as ctx:
            approval.decide("holiday_work", claim, approval.HR, "approved", actor="Meena")
        self.assertEqual(ctx.exception.code, "role_not_in_pipeline")
        # and HR's own endpoints have no way to decide it
        self.assertEqual(
            self.client.patch(
                f"{BASE}/{claim.id}", {"status": "approved"}, content_type="application/json", **self.admin
            ).status_code,
            405,
        )

    def test_the_head_assigned_individually_decides_too(self):
        outsider = _employee("HWI", self.u2, self.sewing)
        ManagerEmployeeAssignment.objects.create(manager=self.manager, employee=outsider)
        _punch(outsider, SUNDAY)
        claim = self.raise_claim(outsider)
        self.assertEqual(self.patch_hod(claim.id, {"status": "approved"}).status_code, 200)

    def test_the_whatsapp_message_goes_out_on_a_final_decision(self):
        with mock.patch.object(whatsapp_approvals, "notify_decision") as notify:
            first = self.raise_claim(self.asha)
            second = self.raise_claim(self.ravi)
            self.patch_hod(first.id, {"status": "approved"})
            self.patch_hod(second.id, {"status": "rejected", "comment": "No"})
        self.assertEqual(
            [c.args[:3] for c in notify.call_args_list],
            [("holiday_work", first, "approved"), ("holiday_work", second, "rejected")],
        )
        self.assertEqual(notify.call_args_list[0].kwargs["role"], "dept_head")

    def test_the_whatsapp_builder_describes_the_claim(self):
        claim = self.raise_claim(shifts=0.5, reason="Dispatch rush")
        summary = whatsapp_approvals._BUILDERS["holiday_work"](claim)
        self.assertEqual((summary.request_type, summary.ref_id), ("Holiday Work Compensation", claim.id))
        self.assertIn("Sunday work: 0.5 shift", summary.details)
        self.assertIn("Dispatch rush", summary.details)


# ═════════════════════════════ the workflow definition and the hub ═════════════════════════════


class WorkflowDefinitionTests(HolidayWorkBase):
    def test_the_definition_is_fixed_and_hod_only(self):
        defn = approval.definition("holiday_work")
        self.assertEqual(
            (defn.requested_by, defn.allowed_roles, defn.editable, defn.hod_flag, defn.group),
            ("HR", (approval.HOD,), False, "can_approve_compensation", "Leave & attendance"),
        )
        self.assertEqual(defn.default_steps, (approval.Step((approval.HOD,), True),))
        self.assertTrue(defn.fixed_note)
        self.assertIn("HR cannot raise new holiday-work claims", defn.on_off_effect)
        self.assertTrue(hasattr(DepartmentManager, defn.hod_flag))
        self.assertEqual(approval.project_status("holiday_work", (approval.HOD,)), "pending")

    def test_the_configuration_page_lists_it_and_only_lets_it_be_switched_off(self):
        rows = {w["key"]: w for w in self.client.get("/api/approval-workflows", **self.admin).json()["workflows"]}
        row = rows["holiday_work"]
        self.assertEqual(
            (row["path"], row["editable"], row["hodSwitch"]), ("HR → HOD", False, "Can approve compensation")
        )
        self.assertEqual((row["waiting"]["total"], row["canDisable"]), (0, True))
        refused = self.client.put(
            "/api/approval-workflows/holiday_work",
            {"steps": [{"roles": ["hr"]}]},
            content_type="application/json",
            **self.admin,
        )
        self.assertEqual(refused.status_code, 400)
        self.assertIn("is fixed", refused.json()["error"])
        self.raise_claim()
        off = self.client.put(
            "/api/approval-workflows/holiday_work", {"enabled": False}, content_type="application/json", **self.admin
        )
        self.assertEqual((off.status_code, off.json()["enabled"], off.json()["waiting"]["hod"]), (200, False, 1))

    def test_every_workflow_the_md_portal_tracks_exists(self):
        from .md_portal.analytics.requests import KIND_BY_KEY

        self.assertIn("holiday_work", KIND_BY_KEY)
        self.assertEqual(KIND_BY_KEY["holiday_work"].raised_by, "hr")
        for kind in KIND_BY_KEY.values():
            self.assertIn(kind.workflow, approval.BY_KEY)

    def test_the_md_requests_analysis_counts_the_claims(self):
        from .md_portal.analytics.requests import KINDS, requests_summary, requests_waiting
        from .md_portal.common import Scope, period_for_preset

        approved = self.raise_claim(self.asha)
        self.patch_hod(approved.id, {"status": "approved"})
        self.raise_claim(self.ravi)
        waiting = requests_waiting(Scope(), kind="holiday_work")
        self.assertEqual((waiting["total"], waiting["mdCanDecide"]), (1, 0))  # only the Department Head decides it
        self.assertEqual(waiting["byKind"][0]["withDepartmentHead"], 1)
        summary = requests_summary(Scope(), period_for_preset("this_month", date.today()), kind="holiday_work")
        self.assertEqual(summary["kind"], "holiday_work")
        self.assertEqual(summary["metrics"]["submitted"]["value"], 2)
        self.assertEqual(summary["metrics"]["approved"]["value"], 1)
        # an HR-raised kind does not count as the employee "asking a lot"
        self.assertNotIn("holiday_work", [k.key for k in KINDS if k.raised_by == "employee"])

    def test_the_whatsapp_catalogue_has_a_switch_for_it(self):
        from . import whatsapp_catalog

        self.assertEqual(whatsapp_catalog.APPROVAL_MODULES["holiday_work"], "Holiday Work Compensation")


class RequestsHubTests(HolidayWorkBase):
    def hub(self, who=None, **params):
        r = self.client.get("/api/hr-requests", params, **(who or self.admin))
        self.assertEqual(r.status_code, 200, r.content)
        return r.json()

    def test_hr_sees_the_claim_and_who_it_waits_for(self):
        claim = self.raise_claim()
        body = self.hub()
        kinds = {k["key"]: k for k in body["kinds"]}
        self.assertEqual(
            (
                kinds["holiday_work"]["label"],
                kinds["holiday_work"]["mode"],
                kinds["holiday_work"]["waiting"],
                kinds["holiday_work"]["waitingHod"],
                kinds["holiday_work"]["waitingHr"],
            ),
            ("Holiday / Sunday work", "link", 1, 1, 0),
        )
        self.assertEqual(kinds["holiday_work"]["pipeline"], "HR → HOD")
        row = next(i for i in body["items"] if i["kind"] == "holiday_work")
        self.assertEqual(
            (row["id"], row["status"], row["queue"], row["employee"]["code"]), (claim.id, "pending", "hod", "HW1")
        )
        self.assertEqual(row["reason"], "Dispatch rush")
        self.assertIn("0.5 shift", row["summary"])
        self.assertIsNone(row["decided"])

    def test_a_decided_claim_shows_who_decided_it(self):
        claim = self.raise_claim()
        self.patch_hod(claim.id, {"status": "rejected", "comment": "Not on site"})
        row = next(i for i in self.hub(kind="holiday_work")["items"] if i["id"] == claim.id)
        self.assertEqual(row["status"], "rejected")
        self.assertEqual(
            (row["decided"]["by"], row["decided"]["role"], row["decided"]["comment"]), ("HWB Hw", "hod", "Not on site")
        )

    def test_a_role_without_the_compensation_module_does_not_see_the_kind(self):
        self.raise_claim()
        no_comp = _hr_headers(_hr_user("hw_leave_only", {"leave": "edit", "requests": "view"}))
        keys = [k["key"] for k in self.hub(no_comp)["kinds"]]
        self.assertNotIn("holiday_work", keys)
        with_comp = _hr_headers(_hr_user("hw_comp_view", {"compensation": "view", "requests": "view"}))
        self.assertIn("holiday_work", [k["key"] for k in self.hub(with_comp)["kinds"]])

    def test_the_hub_is_branch_scoped(self):
        HolidayWorkClaim.objects.create(
            employee=self.mani, work_date=SUNDAY, shifts=Decimal("1.00"), reason="x", approval_trail=[]
        )
        ho_user = _hr_headers(_hr_user("hw_ho_hub", {"compensation": "view", "requests": "view"}, branch=self.ho))
        scoped = self.hub(ho_user)
        self.assertEqual([i for i in scoped["items"] if i["kind"] == "holiday_work"], [])
        self.assertEqual(len([i for i in self.hub()["items"] if i["kind"] == "holiday_work"]), 1)


# ═════════════════════════════ the HOD permission switch in the manager APIs ═════════════════════════════


class HodSwitchTests(HolidayWorkBase):
    def test_the_switch_is_serialised_created_and_updated(self):
        listed = self.client.get("/api/department-managers", **self.admin).json()
        self.assertTrue(next(m for m in listed if m["id"] == self.manager.id)["canApproveCompensation"])
        detail = self.client.get(f"/api/department-managers/{self.manager.id}", **self.admin).json()
        self.assertTrue(detail["canApproveCompensation"])
        off = self.client.put(
            f"/api/department-managers/{self.manager.id}",
            {"canApproveCompensation": False},
            content_type="application/json",
            **self.admin,
        )
        self.assertEqual((off.status_code, off.json()["canApproveCompensation"]), (200, False))
        self.manager.refresh_from_db()
        self.assertFalse(self.manager.can_approve_compensation)
        # the other switches are untouched by it
        self.assertTrue(self.manager.can_approve_attendance)
        on = self.client.put(
            f"/api/department-managers/{self.manager.id}",
            {"canApproveCompensation": True},
            content_type="application/json",
            **self.admin,
        )
        self.assertTrue(on.json()["canApproveCompensation"])

    def test_a_new_head_defaults_to_on_and_can_start_off(self):
        a = _employee("HWN1", self.ho, self.cutting)
        b = _employee("HWN2", self.ho, self.cutting)
        made = self.client.post(
            "/api/department-managers", {"employeeId": a.id}, content_type="application/json", **self.admin
        )
        self.assertEqual((made.status_code, made.json()["canApproveCompensation"]), (201, True))
        made = self.client.post(
            "/api/department-managers",
            {"employeeId": b.id, "canApproveCompensation": False},
            content_type="application/json",
            **self.admin,
        )
        self.assertEqual((made.status_code, made.json()["canApproveCompensation"]), (201, False))

    def test_the_default_for_a_row_inserted_by_an_older_release_is_on(self):
        with connection.cursor() as cursor:
            cursor.execute(
                "INSERT INTO department_managers (employee_id, can_approve_leaves, can_approve_permissions, "
                "can_approve_resignations, can_approve_attendance, can_approve_casual_leave, can_approve_on_duty, "
                "can_approve_missing_punch, is_active, created_at) VALUES (%s, true, true, true, true, true, true, true, true, now())",
                [self.asha.id],
            )
        self.assertTrue(DepartmentManager.objects.get(employee=self.asha).can_approve_compensation)

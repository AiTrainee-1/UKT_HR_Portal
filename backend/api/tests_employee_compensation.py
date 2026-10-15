"""
The employee apps' APIs: GET /api/employee/compensation (what was detected for me and what HR assigned me) and
GET /api/employee/hod (my Department Head and what that HOD can approve).

Run via: python manage.py test api.tests_employee_compensation -v 2
"""

from datetime import date, time, timedelta
from decimal import Decimal
from unittest import mock

from django.db import connection
from django.test import TestCase
from django.test.utils import CaptureQueriesContext

from . import approval_workflow as approval
from .attendance_final import _holiday_dates_for_month
from .jwt_utils import sign_token
from .models import (
    AttendanceDayRecord,
    Branch,
    CompensationConfig,
    CompensationDayAnnouncement,
    CompensationLeaveCredit,
    CompensationLedger,
    Department,
    DepartmentManager,
    Designation,
    Employee,
    EmployeeShiftAssignment,
    Holiday,
    HolidayWorkClaim,
    HRUser,
    ManagerDepartmentAssignment,
    ManagerEmployeeAssignment,
    ManagerEmployeeExclusion,
    OvertimeRecord,
    PayrollSettings,
    ShiftTemplate,
)

TODAY = date(2026, 10, 14)  # a Wednesday
COMP = "/api/employee/compensation"
HOD = "/api/employee/hod"
STUCK = "No Department Head can decide this yet: contact HR"


def _bearer(payload: dict) -> dict:
    return {"HTTP_AUTHORIZATION": f"Bearer {sign_token(payload)}"}


def _employee(code, branch=None, department=None, kind="staff", status="active", **kw) -> Employee:
    return Employee.objects.create(
        employee_code=code,
        first_name=code,
        last_name="Ec",
        employment_type=kind,
        status=status,
        branch=branch,
        department=department,
        **kw,
    )


def _as(emp) -> dict:
    return _bearer({"role": "employee", "employeeId": emp.id})


class EmployeeBase(TestCase):
    def setUp(self):
        approval.clear_cache()
        self.addCleanup(approval.clear_cache)
        _holiday_dates_for_month.cache_clear()
        self.addCleanup(_holiday_dates_for_month.cache_clear)
        patch = mock.patch("api.employee_compensation_views.ist_today", return_value=TODAY)
        patch.start()
        self.addCleanup(patch.stop)
        settings = PayrollSettings.get()
        settings.compensation_feature_enabled = True
        settings.hr_contact_name = "HR Desk"
        settings.hr_contact_phone = "0421 430 0800"
        settings.save()
        CompensationConfig.objects.update_or_create(
            pk=1,
            defaults={
                "allowance_enabled": True,
                "allowance_effective_from": date(2026, 1, 1),
                "shift_enabled": True,
                "relaxation_enabled": True,
                "pay_enabled": True,
                "windows_enabled": True,
                "holiday_work_enabled": True,
                "birthday_enabled": True,
                "birthday_effective_from": date(2026, 1, 1),
            },
        )
        self.ho = Branch.objects.create(name="EC Head Office", code="ECHO", is_head_office=True)
        self.u2 = Branch.objects.create(name="EC Unit 2", code="ECU2")
        self.cutting = Department.objects.create(name="EC Cutting", branch=self.ho)
        self.sewing = Department.objects.create(name="EC Sewing", branch=self.u2)
        self.asha = _employee("EC1", self.ho, self.cutting)
        self.ravi = _employee("EC2", self.ho, self.cutting)
        self.mani = _employee("EC3", self.u2, self.sewing)
        self.prod = _employee("ECP", self.ho, self.cutting, kind="production")
        self.hr = _bearer(
            {
                "role": "hr",
                "hrUserId": HRUser.objects.create(username="ec_admin", password_hash="x", is_super_admin=True).id,
            }
        )

    def comp(self, emp=None, who=None):
        r = self.client.get(COMP, **(who or _as(emp or self.asha)))
        self.assertEqual(r.status_code, 200, r.content)
        return r.json()

    def items(self, body, kind=None):
        return [i for i in body["items"] if kind is None or i["kind"] == kind]

    def head_for(self, department, code="ECH", **flags) -> DepartmentManager:
        """A Department Head (a staff employee of the department) who holds the whole department."""
        boss = _employee(code, self.ho, department)
        manager = DepartmentManager.objects.create(employee=boss, **flags)
        ManagerDepartmentAssignment.objects.create(manager=manager, department=department)
        return manager


# ═════════════════════════════ /api/employee/compensation ═════════════════════════════


class AccessTests(EmployeeBase):
    def test_only_an_employee_token_gets_an_answer(self):
        self.assertEqual(self.client.get(COMP).status_code, 401)
        r = self.client.get(COMP, **self.hr)
        self.assertEqual((r.status_code, "sign in as an employee" in r.json()["error"]), (403, True))
        gone = _bearer({"role": "employee", "employeeId": 999999})
        self.assertEqual(self.client.get(COMP, **gone).status_code, 404)
        qr = _bearer({"role": "tea_break", "employeeId": self.asha.id})
        self.assertEqual(self.client.get(COMP, **qr).status_code, 403)
        self.assertEqual(self.client.post(COMP, {}, content_type="application/json", **_as(self.asha)).status_code, 405)

    def test_a_production_employee_gets_a_disabled_empty_answer(self):
        OvertimeRecord.objects.create(
            employee=self.prod,
            date=date(2026, 10, 12),
            last_punch_out=time(19, 0),
            ot_minutes=90,
            status="auto",
            ot_type="allowance",
            allowance_minutes=30,
        )
        HolidayWorkClaim.objects.create(
            employee=self.prod, work_date=date(2026, 10, 11), shifts=Decimal("1.00"), approval_trail=[]
        )
        body = self.comp(self.prod)
        self.assertEqual(
            (
                body["isStaff"],
                body["items"],
                body["balanceShifts"],
                body["askHr"],
                body["todayAllowance"],
                body["tomorrowAllowance"],
            ),
            (False, [], 0.0, None, None, None),
        )
        self.assertFalse(any(body["enabled"].values()))
        self.assertIn("staff", body["message"])

    def test_the_answer_has_the_documented_shape(self):
        body = self.comp()
        self.assertEqual(
            sorted(body),
            sorted(
                [
                    "isStaff",
                    "enabled",
                    "balanceShifts",
                    "items",
                    "todayAllowance",
                    "tomorrowAllowance",
                    "askHr",
                    "message",
                ]
            ),
        )
        self.assertEqual(
            sorted(body["enabled"]),
            sorted(["master", "allowance", "shift", "relaxation", "pay", "windows", "holidayWork", "birthday", "any"]),
        )
        self.assertTrue(all(body["enabled"].values()))
        self.assertEqual(
            (body["isStaff"], body["items"], body["balanceShifts"], body["message"]), (True, [], 0.0, None)
        )


class FlagsAndAskHrTests(EmployeeBase):
    def test_the_flags_follow_the_switches(self):
        CompensationConfig.objects.filter(pk=1).update(pay_enabled=False, windows_enabled=False)
        enabled = self.comp()["enabled"]
        self.assertEqual(
            (enabled["pay"], enabled["windows"], enabled["relaxation"], enabled["any"]), (False, False, True, True)
        )
        settings = PayrollSettings.get()
        settings.compensation_feature_enabled = False
        settings.save()
        enabled = self.comp()["enabled"]
        self.assertFalse(any(enabled.values()))

    def test_the_ask_request_for_compensation_tab_explains_and_gives_the_hr_contact(self):
        ask = self.comp()["askHr"]
        self.assertEqual(ask["title"], "Ask Request for Compensation")
        self.assertIn("contact HR", ask["text"])
        self.assertEqual(len(ask["points"]), 5)
        self.assertTrue(any("automatic" in p for p in ask["points"]))
        self.assertTrue(any("Sunday or a company holiday" in p for p in ask["points"]))
        self.assertEqual(
            (
                ask["contact"]["label"],
                ask["contact"]["phone"],
                ask["contact"]["phoneDial"],
                ask["contact"]["hasContact"],
            ),
            ("HR Desk", "0421 430 0800", "04214300800", True),
        )

    def test_the_points_only_describe_what_is_switched_on(self):
        CompensationConfig.objects.filter(pk=1).update(
            allowance_enabled=False, shift_enabled=False, windows_enabled=False, birthday_enabled=False
        )
        points = self.comp()["askHr"]["points"]
        self.assertEqual(len(points), 1)
        self.assertIn("Sunday", points[0])
        CompensationConfig.objects.filter(pk=1).update(holiday_work_enabled=False)
        self.assertEqual(
            self.comp()["askHr"]["points"], ["Compensation is not switched on yet. Contact HR for any question."]
        )

    def test_without_an_hr_contact_the_card_still_answers(self):
        settings = PayrollSettings.get()
        settings.hr_contact_name = ""
        settings.hr_contact_phone = ""
        settings.save()
        contact = self.comp()["askHr"]["contact"]
        self.assertEqual((contact["hasContact"], contact["phone"], contact["label"]), (False, "", "HR Department"))


class BalanceTests(EmployeeBase):
    def test_the_balance_is_credits_less_redemptions_plus_legacy_credits(self):
        CompensationLedger.objects.create(
            employee=self.asha,
            entry_type="credit",
            shifts=Decimal("1.00"),
            date=date(2026, 10, 4),
            source="holiday_work",
        )
        CompensationLedger.objects.create(
            employee=self.asha,
            entry_type="credit",
            shifts=Decimal("0.50"),
            date=date(2026, 10, 11),
            source="holiday_work",
        )
        CompensationLedger.objects.create(
            employee=self.asha, entry_type="debit", shifts=Decimal("0.25"), date=date(2026, 10, 13), source="redemption"
        )
        CompensationLeaveCredit.objects.create(employee=self.asha)  # available: one shift
        CompensationLeaveCredit.objects.create(employee=self.asha)
        CompensationLeaveCredit.objects.create(employee=self.asha, status="used", used_date=date(2026, 10, 1))
        CompensationLedger.objects.create(
            employee=self.ravi,
            entry_type="credit",
            shifts=Decimal("1.00"),
            date=date(2026, 10, 4),
            source="holiday_work",
        )
        self.assertEqual(self.comp()["balanceShifts"], 3.25)
        self.assertEqual(self.comp(self.ravi)["balanceShifts"], 1.0)
        self.assertEqual(self.comp(self.mani)["balanceShifts"], 0.0)


class ItemTests(EmployeeBase):
    def test_the_allowance_of_the_employees_own_ot_days(self):
        OvertimeRecord.objects.create(
            employee=self.asha,
            date=date(2026, 10, 12),
            shift_end_time=time(17, 30),
            last_punch_out=time(18, 40),
            ot_minutes=70,
            status="auto",
            ot_type="allowance",
            allowance_minutes=30,
        )
        AttendanceDayRecord.objects.create(
            employee=self.asha,
            date=date(2026, 10, 13),
            status="present",
            compensation_kind="ot_allowance",
            compensation_minutes=18,
            compensation_note="Arrived 09:48: 18 minutes of your allowance used",
        )
        OvertimeRecord.objects.create(
            employee=self.asha,
            date=date(2026, 10, 9),
            last_punch_out=time(19, 30),
            ot_minutes=120,
            status="auto",
            ot_type="allowance",
            allowance_minutes=60,
        )
        AttendanceDayRecord.objects.create(employee=self.asha, date=date(2026, 10, 12), status="present")
        OvertimeRecord.objects.create(  # someone else's: never shown
            employee=self.ravi,
            date=date(2026, 10, 12),
            last_punch_out=time(19, 0),
            ot_minutes=90,
            status="auto",
            ot_type="allowance",
            allowance_minutes=30,
        )
        items = self.items(self.comp(), "ot_allowance")
        self.assertEqual(
            [(i["date"], i["status"], i["minutes"], i["minutesUsed"], i["used"], i["group"]) for i in items],
            [
                ("2026-10-12", "used", 30, 18, True, "detected"),
                ("2026-10-09", "not_used", 60, None, False, "detected"),
            ],
        )
        self.assertEqual(items[0]["title"], "Late-in allowance earned: 30 minutes")
        self.assertIn("18 minutes of your allowance used", items[0]["detail"])
        self.assertIn("nothing to claim", items[1]["detail"])
        self.assertEqual(items[1]["statusLabel"], "Not used")

    def test_ot_that_hr_has_not_assigned_is_detected_and_ot_that_it_has_is_assigned(self):
        OvertimeRecord.objects.create(
            employee=self.asha,
            date=date(2026, 10, 6),
            last_punch_out=time(20, 50),
            ot_minutes=200,
            status="detected",
            ot_type="shift",
            suggested_shifts=Decimal("0.25"),
        )
        OvertimeRecord.objects.create(
            employee=self.asha,
            date=date(2026, 10, 5),
            last_punch_out=time(23, 30),
            ot_minutes=360,
            status="announced",
            ot_type="shift",
            compensation_type="relaxation",
            shifts=Decimal("0.50"),
            claim_date=date(2026, 10, 20),
            announced_by="Meena",
        )
        OvertimeRecord.objects.create(
            employee=self.asha,
            date=date(2026, 10, 2),
            last_punch_out=time(23, 30),
            ot_minutes=360,
            status="announced",
            ot_type="shift",
            compensation_type="relaxation",
            shifts=Decimal("0.75"),
            claim_date=date(2026, 10, 9),
        )
        OvertimeRecord.objects.create(
            employee=self.asha,
            date=date(2026, 10, 1),
            last_punch_out=time(2, 30),
            ot_minutes=500,
            status="announced",
            ot_type="shift",
            compensation_type="pay",
            shifts=Decimal("1.00"),
            claim_date=date(2026, 10, 2),
        )
        OvertimeRecord.objects.create(
            employee=self.asha,
            date=date(2026, 9, 28),
            last_punch_out=time(20, 0),
            ot_minutes=150,
            status="rejected",
            ot_type="shift",
        )
        body = self.comp()
        detected = self.items(body, "ot_shift")[0]
        self.assertEqual(
            (detected["status"], detected["group"], detected["shifts"], detected["minutes"], detected["date"]),
            ("detected", "detected", 0.25, 200, "2026-10-06"),
        )
        self.assertIn("contact HR", detected["detail"])
        relax = {i["date"]: i for i in self.items(body, "ot_shift_relaxation")}
        self.assertEqual(
            (relax["2026-10-20"]["status"], relax["2026-10-20"]["shifts"], relax["2026-10-20"]["group"]),
            ("scheduled", 0.5, "assigned"),
        )
        self.assertEqual((relax["2026-10-09"]["status"], relax["2026-10-09"]["shifts"]), ("not_applied", 0.75))
        # once the engine has topped the day up it carries the marker, and then the employee sees it as applied
        AttendanceDayRecord.objects.create(
            employee=self.asha, date=date(2026, 10, 9), status="present", compensation_kind="relaxation"
        )
        relax = {i["date"]: i for i in self.items(self.comp(), "ot_shift_relaxation")}
        self.assertEqual(relax["2026-10-09"]["status"], "applied")
        self.assertIn("20 Oct 2026", relax["2026-10-20"]["detail"])
        pay = self.items(body, "ot_shift_pay")
        self.assertEqual([(i["date"], i["status"], i["shifts"]) for i in pay], [("2026-10-02", "assigned", 1.0)])
        self.assertNotIn("2026-09-28", [i["date"] for i in body["items"]])  # a rejected record is not listed

    def test_a_record_from_before_the_overhaul_still_shows_with_one_shift(self):
        OvertimeRecord.objects.create(
            employee=self.asha,
            date=date(2026, 10, 1),
            last_punch_out=time(20, 0),
            ot_minutes=150,
            status="announced",
            compensation_type="pay",
        )
        OvertimeRecord.objects.create(
            employee=self.asha,
            date=date(2026, 10, 3),
            last_punch_out=time(20, 0),
            ot_minutes=150,
            status="announced",
            compensation_type="relaxation",
        )
        body = self.comp()
        pay = self.items(body, "ot_shift_pay")[0]
        self.assertEqual((pay["shifts"], pay["legacy"], pay["status"]), (1.0, True, "assigned"))
        relax = self.items(body, "ot_shift_relaxation")[0]
        self.assertEqual((relax["shifts"], relax["legacy"]), (1.0, True))

    def test_holiday_work_claims_with_their_status(self):
        self.head_for(self.cutting)  # a head who can decide: the claim is simply waiting for them
        HolidayWorkClaim.objects.create(
            employee=self.asha,
            work_date=date(2026, 10, 11),
            shifts=Decimal("0.50"),
            reason="Dispatch",
            requested_by="Meena",
            approval_trail=[],
        )
        HolidayWorkClaim.objects.create(
            employee=self.asha,
            work_date=date(2026, 10, 4),
            shifts=Decimal("1.00"),
            status="approved",
            reviewed_by="Boss",
            approval_trail=[],
        )
        HolidayWorkClaim.objects.create(
            employee=self.asha,
            work_date=date(2026, 9, 27),
            shifts=Decimal("0.25"),
            status="rejected",
            reviewed_by="Boss",
            review_comment="You were on leave",
            approval_trail=[],
        )
        HolidayWorkClaim.objects.create(
            employee=self.ravi, work_date=date(2026, 10, 11), shifts=Decimal("1.00"), approval_trail=[]
        )
        items = self.items(self.comp(), "holiday_work")
        self.assertEqual(
            [(i["date"], i["status"], i["shifts"], i["group"]) for i in items],
            [
                ("2026-10-11", "pending_hod", 0.5, "assigned"),
                ("2026-10-04", "approved", 1.0, "assigned"),
                ("2026-09-27", "rejected", 0.25, "assigned"),
            ],
        )
        self.assertEqual(items[0]["statusLabel"], "Waiting for your Department Head")
        self.assertEqual(items[0]["title"], "Sunday work: 0.50 shift")
        self.assertIn("waiting for your Department Head to approve", items[0]["detail"])
        self.assertIn("Dispatch", items[0]["detail"])
        self.assertIn("added to your compensation balance", items[1]["detail"])
        self.assertEqual(items[2]["detail"], "Not approved by Boss. You were on leave.")

    def test_a_claim_on_a_declared_holiday_says_holiday(self):
        Holiday.objects.create(name="Gandhi Jayanti", date=date(2026, 10, 2))
        HolidayWorkClaim.objects.create(
            employee=self.asha, work_date=date(2026, 10, 2), shifts=Decimal("1.00"), approval_trail=[]
        )
        self.assertEqual(self.items(self.comp(), "holiday_work")[0]["title"], "Holiday work: 1.00 shift")

    def claim_item(self, emp=None):
        return self.items(self.comp(emp), "holiday_work")[0]

    def test_a_claim_with_no_department_head_does_not_say_it_waits_for_one(self):
        HolidayWorkClaim.objects.create(
            employee=self.asha,
            work_date=date(2026, 10, 11),
            shifts=Decimal("0.50"),
            reason="Dispatch",
            approval_trail=[],
        )  # nobody holds the Cutting department here
        item = self.claim_item()
        # the status word stays (both apps tone pending_hod as "needs attention"): only the words are honest
        self.assertEqual(item["status"], "pending_hod")
        self.assertEqual(item["statusLabel"], "No Department Head can decide this yet: contact HR")
        self.assertIn("you have no Department Head assigned", item["detail"])
        self.assertIn("contact HR", item["detail"])
        self.assertNotIn("waiting for your Department Head", item["detail"])
        self.assertTrue(item["detail"].endswith("Reason: Dispatch."))

    def test_a_head_who_may_not_approve_compensation_cannot_decide_the_claim_either(self):
        head = self.head_for(self.cutting, can_approve_compensation=False)
        HolidayWorkClaim.objects.create(
            employee=self.asha, work_date=date(2026, 10, 11), shifts=Decimal("0.50"), approval_trail=[]
        )
        item = self.claim_item()
        self.assertEqual((item["status"], item["statusLabel"]), ("pending_hod", STUCK))
        self.assertIn("your Department Head ECH Ec is not allowed to approve compensation", item["detail"])
        self.assertNotIn("waiting for your Department Head", item["detail"])
        # switched on again, the claim is simply waiting for a head who can decide it
        head.can_approve_compensation = True
        head.save()
        item = self.claim_item()
        self.assertEqual(item["statusLabel"], "Waiting for your Department Head")
        self.assertIn("waiting for your Department Head to approve it", item["detail"])

    def test_a_department_heads_own_claim_cannot_be_decided_by_anybody(self):
        head = self.head_for(self.cutting)  # holds Cutting, and sits in it: the head of their own department
        HolidayWorkClaim.objects.create(
            employee=head.employee, work_date=date(2026, 10, 11), shifts=Decimal("1.00"), approval_trail=[]
        )
        item = self.claim_item(head.employee)
        self.assertEqual((item["status"], item["statusLabel"]), ("pending_hod", STUCK))
        self.assertIn("you are a Department Head yourself", item["detail"])
        self.assertIn("another Department Head", item["detail"])
        self.assertNotIn("waiting for your Department Head", item["detail"])

    def test_the_settings_switches_do_not_make_a_waiting_claim_undecidable(self):
        self.head_for(self.cutting)
        HolidayWorkClaim.objects.create(
            employee=self.asha, work_date=date(2026, 10, 11), shifts=Decimal("0.50"), approval_trail=[]
        )
        CompensationConfig.objects.filter(pk=1).update(holiday_work_enabled=False)
        # the head still can (manager_update_holiday_work_status never looks at the switch): the wording stays plain
        self.assertEqual(self.claim_item()["statusLabel"], "Waiting for your Department Head")

    def test_a_decided_claim_keeps_its_own_wording_whoever_the_head_is(self):
        HolidayWorkClaim.objects.create(
            employee=self.asha,
            work_date=date(2026, 10, 4),
            shifts=Decimal("1.00"),
            status="approved",
            reviewed_by="Boss",
            approval_trail=[],
        )
        HolidayWorkClaim.objects.create(
            employee=self.asha,
            work_date=date(2026, 9, 27),
            shifts=Decimal("0.25"),
            status="rejected",
            reviewed_by="Boss",
            approval_trail=[],
        )
        items = self.items(self.comp(), "holiday_work")  # no head at all now
        self.assertEqual(
            [(i["status"], i["statusLabel"]) for i in items], [("approved", "Approved"), ("rejected", "Not approved")]
        )
        self.assertIn("Approved by Boss", items[0]["detail"])

    def test_an_allowance_nobody_used_is_available_while_its_window_is_open_and_not_used_after(self):
        def allowance(day):
            return OvertimeRecord.objects.create(
                employee=self.asha,
                date=day,
                shift_end_time=time(17, 30),
                last_punch_out=time(19, 0),
                ot_minutes=90,
                status="auto",
                ot_type="allowance",
                allowance_minutes=30,
            )

        allowance(TODAY)  # its window runs 10 days
        allowance(date(2026, 10, 9))  # a later OT day (today) ends its window: today, so it is still open
        allowance(date(2026, 10, 1))  # ended on the 9th; nobody punched in between, so there is no worked day either
        allowance(date(2026, 9, 20))  # ended on the 30th of September with nothing used
        items = {i["date"]: i for i in self.items(self.comp(), "ot_allowance")}
        self.assertEqual(
            {d: (i["status"], i["statusLabel"], i["used"]) for d, i in items.items()},
            {
                "2026-10-14": ("available", "Available", False),
                "2026-10-09": ("available", "Available", False),
                "2026-10-01": ("not_used", "Not used", False),
                "2026-09-20": ("not_used", "Not used", False),
            },
        )
        self.assertIn("nothing to claim", items["2026-10-14"]["detail"])
        # an allowance that a day carries the marker of stays used
        AttendanceDayRecord.objects.create(
            employee=self.asha,
            date=date(2026, 10, 10),
            status="present",
            compensation_kind="ot_allowance",
            compensation_minutes=12,
        )
        self.assertEqual(
            {i["date"]: i["status"] for i in self.items(self.comp(), "ot_allowance")}["2026-10-09"], "used"
        )

    def test_a_redemption_is_told_in_words_and_never_with_hrs_internal_note(self):
        CompensationLedger.objects.create(
            employee=self.asha,
            entry_type="debit",
            shifts=Decimal("0.25"),
            date=date(2026, 10, 12),
            source="redemption",
            note="Redeemed on 2026-10-12",  # what HR's redeem endpoint really writes
        )
        legacy = CompensationLeaveCredit.objects.create(employee=self.asha, status="used", used_date=date(2026, 10, 7))
        CompensationLedger.objects.create(
            employee=self.asha,
            entry_type="debit",
            shifts=Decimal("1.00"),
            date=date(2026, 10, 7),
            source="legacy_credit",
            note=f"Alternative Day credit {legacy.id} used",
        )
        items = {i["date"]: i for i in self.items(self.comp(), "redemption")}
        self.assertEqual(
            items["2026-10-12"]["detail"], "HR used 0.25 shift of your compensation balance for Monday 12 Oct 2026."
        )
        self.assertEqual(
            items["2026-10-07"]["detail"],
            "HR used your earlier Alternative Day credit (1.00 shift) for Wednesday 7 Oct 2026.",
        )
        for item in items.values():
            self.assertNotIn("2026-10", item["detail"])  # no raw ISO date
            self.assertNotIn("Redeemed on", item["detail"])
        self.assertNotIn(f"credit {legacy.id} used", items["2026-10-07"]["detail"])  # no internal credit id

    def test_redemptions_and_old_history_are_bounded(self):
        CompensationLedger.objects.create(
            employee=self.asha,
            entry_type="debit",
            shifts=Decimal("0.50"),
            date=date(2026, 10, 9),
            source="redemption",
            note="Compensation day",
        )
        CompensationLedger.objects.create(
            employee=self.asha, entry_type="debit", shifts=Decimal("1.00"), date=date(2026, 5, 1), source="redemption"
        )
        HolidayWorkClaim.objects.create(
            employee=self.asha, work_date=date(2026, 5, 3), shifts=Decimal("1.00"), approval_trail=[]
        )
        body = self.comp()
        taken = self.items(body, "redemption")
        self.assertEqual(
            [(i["date"], i["shifts"], i["group"], i["status"]) for i in taken],
            [("2026-10-09", 0.5, "balance", "taken")],
        )
        self.assertEqual(self.items(body, "holiday_work"), [])  # older than the 90 days shown

    def test_company_windows_that_cover_me(self):
        everyone = CompensationDayAnnouncement.objects.create(
            date=date(2026, 10, 16), kind="late_in", allowed_time=time(10, 30), reason="Rain", announced_by="Meena"
        )
        used = CompensationDayAnnouncement.objects.create(
            date=date(2026, 10, 13),
            kind="early_out",
            allowed_time=time(16, 0),
            leave_until_time=time(16, 0),
            reason="Power cut",
        )
        missed = CompensationDayAnnouncement.objects.create(
            date=date(2026, 10, 12), kind="late_in", allowed_time=time(10, 0), reason="Strike"
        )
        today = CompensationDayAnnouncement.objects.create(
            date=TODAY, kind="late_in", allowed_time=time(9, 45), reason="Traffic"
        )
        old = CompensationDayAnnouncement.objects.create(
            date=date(2026, 9, 1), kind="late_in", allowed_time=time(10, 0), reason="Old"
        )
        far = CompensationDayAnnouncement.objects.create(
            date=date(2027, 3, 1), kind="late_in", allowed_time=time(10, 0), reason="Far"
        )
        other_branch = CompensationDayAnnouncement.objects.create(
            date=date(2026, 10, 17), kind="late_in", allowed_time=time(10, 0), branch=self.u2
        )
        other_dept = CompensationDayAnnouncement.objects.create(
            date=date(2026, 10, 18), kind="late_in", allowed_time=time(10, 0), department=self.sewing
        )
        mine_dept = CompensationDayAnnouncement.objects.create(
            date=date(2026, 10, 19), kind="early_out", allowed_time=time(15, 0), department=self.cutting
        )
        not_listed = CompensationDayAnnouncement.objects.create(
            date=date(2026, 10, 20), kind="late_in", allowed_time=time(10, 0)
        )
        not_listed.employees.set([self.ravi])
        listed = CompensationDayAnnouncement.objects.create(
            date=date(2026, 10, 21), kind="early_out", allowed_time=time(15, 30)
        )
        listed.employees.set([self.asha])
        AttendanceDayRecord.objects.create(
            employee=self.asha, date=date(2026, 10, 13), status="present", compensation_kind="window_early_out"
        )
        AttendanceDayRecord.objects.create(employee=self.asha, date=date(2026, 10, 12), status="present")
        items = {i["key"]: i for i in self.items(self.comp()) if i["group"] == "company"}
        self.assertEqual(
            sorted(items),
            sorted(f"win-{a.id}" for a in (everyone, used, missed, today, mine_dept, listed)),
        )
        self.assertNotIn(f"win-{old.id}", items)
        self.assertNotIn(f"win-{far.id}", items)
        for hidden in (other_branch, other_dept, not_listed):
            self.assertNotIn(f"win-{hidden.id}", items)
        self.assertEqual(
            {k: (v["kind"], v["status"], v["time"]) for k, v in items.items()},
            {
                f"win-{everyone.id}": ("window_late_in", "upcoming", "10:30"),
                f"win-{used.id}": ("window_early_out", "used", "16:00"),
                f"win-{missed.id}": ("window_late_in", "not_used", "10:00"),
                f"win-{today.id}": ("window_late_in", "today", "09:45"),
                f"win-{mine_dept.id}": ("window_early_out", "upcoming", "15:00"),
                f"win-{listed.id}": ("window_early_out", "upcoming", "15:30"),
            },
        )
        self.assertEqual(items[f"win-{everyone.id}"]["title"], "Company late-in window: arrive by 10:30")
        self.assertIn("Reason: Rain", items[f"win-{everyone.id}"]["detail"])
        self.assertEqual(items[f"win-{used.id}"]["used"], True)

    def test_windows_are_hidden_while_the_feature_is_off(self):
        CompensationDayAnnouncement.objects.create(
            date=date(2026, 10, 16), kind="late_in", allowed_time=time(10, 30), reason="Rain"
        )
        self.assertEqual(len(self.items(self.comp(), "window_late_in")), 1)
        CompensationConfig.objects.filter(pk=1).update(windows_enabled=False)
        self.assertEqual(self.items(self.comp(), "window_late_in"), [])

    def test_birthday_leave_upcoming_and_this_year(self):
        self.asha.date_of_birth = date(1990, 12, 25)  # Friday this year, still to come
        self.asha.save()
        items = self.items(self.comp(), "birthday")
        self.assertEqual(
            [(i["date"], i["status"], i["group"]) for i in items], [("2026-12-25", "upcoming", "birthday")]
        )
        self.assertEqual(items[0]["title"], "Birthday leave (paid)")
        # a birthday that has passed this year shows (applied or not) together with next year's
        self.asha.date_of_birth = date(1990, 3, 10)
        self.asha.save()
        AttendanceDayRecord.objects.create(
            employee=self.asha, date=date(2026, 3, 10), status="present", compensation_kind="birthday"
        )
        items = self.items(self.comp(), "birthday")
        self.assertEqual(
            [(i["date"], i["status"]) for i in items], [("2027-03-10", "upcoming"), ("2026-03-10", "applied")]
        )
        # a paid birthday never touches the balance: no shift amount, so no "1 shift" chip in the apps
        self.assertEqual([i["shifts"] for i in items], [None, None])
        AttendanceDayRecord.objects.filter(employee=self.asha).delete()
        self.assertEqual(self.items(self.comp(), "birthday")[1]["status"], "not_applied")

    def test_a_birthday_today_says_today(self):
        self.asha.date_of_birth = date(1990, 10, 14)
        self.asha.save()
        item = self.items(self.comp(), "birthday")[0]
        self.assertEqual((item["date"], item["status"], item["statusLabel"]), ("2026-10-14", "today", "Today"))

    def test_a_birthday_on_a_sunday_is_not_a_benefit(self):
        self.asha.date_of_birth = date(1990, 10, 18)  # Sunday
        self.asha.save()
        item = self.items(self.comp(), "birthday")[0]
        self.assertEqual((item["status"], item["statusLabel"]), ("not_applicable", "Not applicable"))
        self.assertIn("weekly off", item["detail"])

    def test_a_saturday_off_birthday_and_a_birthday_before_joining_are_not_applicable(self):
        shift = ShiftTemplate.objects.create(
            name="EC Day", shift_type="staff", start_time=time(9, 0), end_time=time(17, 30)
        )
        EmployeeShiftAssignment.objects.create(
            employee=self.asha, shift=shift, effective_from=date(2026, 1, 1), saturday_off=True
        )
        self.asha.date_of_birth = date(1990, 10, 17)  # Saturday 17 October 2026
        self.asha.save()
        item = self.items(self.comp(), "birthday")[0]
        self.assertEqual(
            (item["status"], "day off on this employee's shift" in item["detail"]), ("not_applicable", True)
        )
        EmployeeShiftAssignment.objects.filter(employee=self.asha).update(saturday_off=False)
        self.assertEqual(self.items(self.comp(), "birthday")[0]["status"], "upcoming")
        self.asha.date_of_birth = date(1990, 12, 25)
        self.asha.join_date = "2027-01-05"
        self.asha.save()
        item = self.items(self.comp(), "birthday")[0]
        self.assertEqual((item["status"], "joined on 2027-01-05" in item["detail"]), ("not_applicable", True))

    def test_birthday_items_need_the_feature_and_a_date_of_birth(self):
        self.assertEqual(self.items(self.comp(), "birthday"), [])  # no date of birth on record
        self.asha.date_of_birth = date(1990, 12, 25)
        self.asha.save()
        CompensationConfig.objects.filter(pk=1).update(birthday_enabled=False)
        self.assertEqual(self.items(self.comp(), "birthday"), [])
        CompensationConfig.objects.filter(pk=1).update(birthday_enabled=True, birthday_effective_from=date(2027, 1, 1))
        self.assertEqual(self.items(self.comp(), "birthday")[0]["status"], "not_applicable")

    def test_items_are_newest_first_and_only_mine(self):
        OvertimeRecord.objects.create(
            employee=self.asha,
            date=date(2026, 10, 1),
            last_punch_out=time(19, 0),
            ot_minutes=90,
            status="auto",
            ot_type="allowance",
            allowance_minutes=30,
        )
        HolidayWorkClaim.objects.create(
            employee=self.asha, work_date=date(2026, 10, 11), shifts=Decimal("1.00"), approval_trail=[]
        )
        CompensationLedger.objects.create(
            employee=self.asha, entry_type="debit", shifts=Decimal("0.50"), date=date(2026, 10, 6), source="redemption"
        )
        HolidayWorkClaim.objects.create(
            employee=self.ravi, work_date=date(2026, 10, 12), shifts=Decimal("1.00"), approval_trail=[]
        )
        CompensationLedger.objects.create(
            employee=self.ravi, entry_type="debit", shifts=Decimal("1.00"), date=date(2026, 10, 13), source="redemption"
        )
        dates = [i["date"] for i in self.comp()["items"]]
        self.assertEqual(dates, ["2026-10-11", "2026-10-06", "2026-10-01"])
        self.assertEqual(dates, sorted(dates, reverse=True))
        for item in self.comp()["items"]:
            for key in (
                "key",
                "kind",
                "group",
                "date",
                "title",
                "detail",
                "status",
                "statusLabel",
                "shifts",
                "minutes",
                "minutesUsed",
                "used",
            ):
                self.assertIn(key, item)


class NextDayAllowanceTests(EmployeeBase):
    def setUp(self):
        super().setUp()
        shift = ShiftTemplate.objects.create(
            name="EC Day", shift_type="staff", start_time=time(9, 0), end_time=time(17, 30), grace_period_minutes=15
        )
        EmployeeShiftAssignment.objects.create(employee=self.asha, shift=shift, effective_from=date(2026, 1, 1))

    def ot(self, emp, day, minutes=30):
        return OvertimeRecord.objects.create(
            employee=emp,
            date=day,
            shift_end_time=time(17, 30),
            last_punch_out=time(19, 0),
            ot_minutes=90,
            status="auto",
            ot_type="allowance",
            allowance_minutes=minutes,
        )

    def test_todays_ot_gives_tomorrows_allowance_with_the_latest_on_time_arrival(self):
        self.ot(self.asha, TODAY, 60)
        body = self.comp()
        tomorrow = body["tomorrowAllowance"]
        self.assertEqual(
            (tomorrow["date"], tomorrow["minutes"], tomorrow["workDate"], tomorrow["onTimeUntil"]),
            ("2026-10-15", 60, "2026-10-14", "10:15"),  # 09:00 + 60 minutes + the shift's own 15 minutes of grace
        )
        self.assertIn("up to 60 minutes later", tomorrow["note"])
        self.assertIsNone(body["todayAllowance"])

    def test_yesterdays_ot_gives_todays_allowance(self):
        self.ot(self.asha, date(2026, 10, 13), 30)
        body = self.comp()
        self.assertEqual(
            (body["todayAllowance"]["date"], body["todayAllowance"]["minutes"], body["todayAllowance"]["onTimeUntil"]),
            ("2026-10-14", 30, "09:45"),
        )
        self.assertIsNone(body["tomorrowAllowance"])

    def test_over_a_sunday_and_a_declared_holiday_it_waits_for_the_next_working_day(self):
        Holiday.objects.create(name="Festival", date=date(2026, 10, 19))
        self.ot(self.asha, date(2026, 10, 16), 30)  # Friday
        with mock.patch("api.employee_compensation_views.ist_today", return_value=date(2026, 10, 16)):
            body = self.comp()
        # Saturday is a working day for this shift, Sunday is off and so is the declared holiday on Monday
        self.assertEqual(body["tomorrowAllowance"]["date"], "2026-10-17")
        EmployeeShiftAssignment.objects.filter(employee=self.asha).update(saturday_off=True)
        with mock.patch("api.employee_compensation_views.ist_today", return_value=date(2026, 10, 16)):
            body = self.comp()
        self.assertEqual(body["tomorrowAllowance"]["date"], "2026-10-20")  # Saturday, Sunday and the Monday holiday off

    def test_a_saturday_off_shift_pushes_it_to_monday(self):
        EmployeeShiftAssignment.objects.filter(employee=self.asha).update(saturday_off=True)
        self.ot(self.asha, date(2026, 10, 16), 30)  # Friday
        with mock.patch("api.employee_compensation_views.ist_today", return_value=date(2026, 10, 16)):
            body = self.comp()
        self.assertEqual(body["tomorrowAllowance"]["date"], "2026-10-19")

    def test_a_working_saturday_gets_it_on_saturday(self):
        self.ot(self.asha, date(2026, 10, 16), 30)
        with mock.patch("api.employee_compensation_views.ist_today", return_value=date(2026, 10, 16)):
            body = self.comp()
        self.assertEqual(body["tomorrowAllowance"]["date"], "2026-10-17")

    def test_nothing_when_the_feature_is_off_or_not_yet_effective(self):
        self.ot(self.asha, TODAY, 60)
        CompensationConfig.objects.filter(pk=1).update(allowance_effective_from=date(2026, 10, 16))
        self.assertIsNone(self.comp()["tomorrowAllowance"])
        CompensationConfig.objects.filter(pk=1).update(allowance_effective_from=date(2026, 10, 15))
        self.assertIsNotNone(self.comp()["tomorrowAllowance"])  # the effective day itself counts
        CompensationConfig.objects.filter(pk=1).update(allowance_enabled=False)
        self.assertIsNone(self.comp()["tomorrowAllowance"])
        # the record itself is still listed: it is history
        self.assertEqual(len(self.items(self.comp(), "ot_allowance")), 1)

    def test_a_zero_minute_allowance_and_other_peoples_ot_give_nothing(self):
        self.ot(self.asha, TODAY, 0)
        self.ot(self.ravi, TODAY, 60)
        self.assertIsNone(self.comp()["tomorrowAllowance"])

    def test_no_shift_means_no_arrival_time_but_still_the_allowance(self):
        self.ot(self.ravi, TODAY, 30)
        tomorrow = self.comp(self.ravi)["tomorrowAllowance"]
        self.assertEqual((tomorrow["minutes"], tomorrow["onTimeUntil"]), (30, None))


class QueryCountTests(EmployeeBase):
    def seed(self, first_day, days):
        for i in range(days):
            day = first_day + timedelta(days=i)
            OvertimeRecord.objects.create(
                employee=self.asha,
                date=day,
                last_punch_out=time(19, 0),
                ot_minutes=90,
                status="auto",
                ot_type="allowance",
                allowance_minutes=30,
            )
            HolidayWorkClaim.objects.create(
                employee=self.asha, work_date=day, shifts=Decimal("0.50"), approval_trail=[]
            )
            CompensationLedger.objects.create(employee=self.asha, entry_type="debit", shifts=Decimal("0.25"), date=day)
            CompensationDayAnnouncement.objects.create(date=day, kind="late_in", allowed_time=time(10, 0), reason="x")

    def test_a_busy_employee_costs_a_bounded_number_of_queries(self):
        self.asha.date_of_birth = date(1990, 12, 25)
        self.asha.save()
        self.seed(date(2026, 9, 14), 30)  # the last month: one record a day
        self.comp()  # the engine caches the holiday calendar per month: measure the warm answer
        with CaptureQueriesContext(connection) as month:
            body = self.comp()
        self.assertGreater(len(body["items"]), 100)
        self.seed(date(2026, 8, 5), 40)  # forty more days of history
        with CaptureQueriesContext(connection) as more:
            body = self.comp()
        self.assertGreater(len(body["items"]), 200)
        self.assertEqual(len(more), len(month))
        self.assertLessEqual(len(more), 45)


# ═════════════════════════════ /api/employee/hod ═════════════════════════════


class HodBase(EmployeeBase):
    def setUp(self):
        super().setUp()
        self.boss = _employee(
            "ECB",
            self.ho,
            self.cutting,
            phone="9000000001",
            email="boss@example.com",
            photo_url="/media/boss.jpg",
        )
        self.boss.designation = Designation.objects.create(title="Cutting Manager", department=self.cutting)
        self.boss.save()
        self.manager = DepartmentManager.objects.create(employee=self.boss)
        ManagerDepartmentAssignment.objects.create(manager=self.manager, department=self.cutting)

    def hod(self, emp=None, who=None):
        r = self.client.get(HOD, **(who or _as(emp or self.asha)))
        self.assertEqual(r.status_code, 200, r.content)
        return r.json()

    def approvals(self, body):
        return {a["key"]: a for a in body["approvals"]}


class HodCardTests(HodBase):
    def test_the_assigned_head_with_their_details(self):
        body = self.hod()
        self.assertTrue(body["assigned"])
        self.assertEqual(
            (
                body["name"],
                body["phone"],
                body["email"],
                body["photoUrl"],
                body["designation"],
                body["department"],
                body["branch"],
            ),
            (
                "ECB Ec",
                "9000000001",
                "boss@example.com",
                "/media/boss.jpg",
                "Cutting Manager",
                "EC Cutting",
                "EC Head Office",
            ),
        )
        self.assertEqual((body["employeeCode"], body["employeeId"], body["message"]), ("ECB", self.boss.id, None))
        self.assertEqual((body["hrContact"]["label"], body["hrContact"]["phone"]), ("HR Desk", "0421 430 0800"))
        self.assertEqual(body["contactNote"], "For any question about approvals, contact HR.")

    def test_every_approval_the_head_can_give_with_its_label_and_path(self):
        approvals = self.hod()["approvals"]
        self.assertEqual(
            [a["key"] for a in approvals],
            [
                "leave",
                "permission",
                "casual_leave",
                "missing_punch",
                "on_duty",
                "attendance_correction",
                "resignation",
                "outpass",
                "holiday_work",
            ],
        )
        by_key = {a["key"]: a for a in approvals}
        self.assertTrue(all(a["canApprove"] for a in approvals))
        self.assertTrue(all(a["reason"] is None for a in approvals))
        self.assertEqual(by_key["leave"]["label"], "Leave")
        self.assertEqual(by_key["holiday_work"]["label"], "Holiday / Sunday work compensation")
        self.assertEqual((by_key["holiday_work"]["requestedBy"], by_key["holiday_work"]["path"]), ("HR", "HR → HOD"))
        self.assertEqual(by_key["leave"]["path"], "Employee → HOD or HR")
        self.assertEqual(by_key["attendance_correction"]["requestedBy"], "HR")

    def test_the_per_person_switches_are_honoured(self):
        self.manager.can_approve_leaves = False
        self.manager.can_approve_compensation = False
        self.manager.can_approve_missing_punch = False
        self.manager.save()
        by_key = self.approvals(self.hod())
        for key in ("leave", "holiday_work", "missing_punch"):
            self.assertEqual(
                (by_key[key]["canApprove"], by_key[key]["reason"]),
                (False, "Not enabled for your Department Head."),
                key,
            )
        self.assertTrue(by_key["permission"]["canApprove"])
        # outpass shares the permissions switch
        self.manager.can_approve_permissions = False
        self.manager.save()
        by_key = self.approvals(self.hod())
        self.assertEqual((by_key["permission"]["canApprove"], by_key["outpass"]["canApprove"]), (False, False))

    def test_a_workflow_that_is_off_or_without_the_head_is_not_available(self):
        approval.save_config("leave", enabled=False, actor="t")
        approval.save_config("permission", steps=(approval.Step((approval.HR,), True),), actor="t")
        by_key = self.approvals(self.hod())
        self.assertEqual((by_key["leave"]["canApprove"], by_key["leave"]["reason"]), (False, "Switched off by HR."))
        self.assertEqual(
            (by_key["permission"]["canApprove"], by_key["permission"]["reason"]), (False, "HR decides this one.")
        )
        self.assertEqual(by_key["permission"]["path"], "Employee → HR")
        self.assertTrue(by_key["casual_leave"]["canApprove"])
        approval.save_config("holiday_work", enabled=False, actor="t")
        self.assertEqual(self.approvals(self.hod())["holiday_work"]["reason"], "Switched off by HR.")

    def test_holiday_work_can_still_be_decided_while_the_compensation_switches_are_off(self):
        # The switches only stop HR raising NEW claims; a claim already waiting is still decided by the head (the manager
        # endpoints never look at them), so the card must not say "cannot approve".
        CompensationConfig.objects.filter(pk=1).update(holiday_work_enabled=False)
        item = self.approvals(self.hod())["holiday_work"]
        self.assertEqual(item["canApprove"], True)
        self.assertIn("switched off", item["reason"])
        self.assertIn("HR cannot raise new claims", item["reason"])
        self.assertIn("already waiting can still be decided", item["reason"])
        CompensationConfig.objects.filter(pk=1).update(holiday_work_enabled=True)
        settings = PayrollSettings.get()
        settings.compensation_feature_enabled = False
        settings.save()
        item = self.approvals(self.hod())["holiday_work"]
        self.assertEqual((item["canApprove"], item["reason"] is not None), (True, True))
        # back on: no reason is needed
        settings.compensation_feature_enabled = True
        settings.save()
        item = self.approvals(self.hod())["holiday_work"]
        self.assertEqual((item["canApprove"], item["reason"]), (True, None))

    def test_the_card_agrees_with_what_the_head_can_really_do_while_the_switch_is_off(self):
        # the same claim, decided through the head's own endpoint, with the switch off: 200 and a credit
        claim = HolidayWorkClaim.objects.create(
            employee=self.asha, work_date=date(2026, 10, 11), shifts=Decimal("0.50"), approval_trail=[]
        )
        CompensationConfig.objects.filter(pk=1).update(holiday_work_enabled=False)
        self.assertTrue(self.approvals(self.hod())["holiday_work"]["canApprove"])
        r = self.client.patch(
            f"/api/manager/holiday-work/{claim.id}/status",
            {"status": "approved"},
            content_type="application/json",
            **_as(self.boss),
        )
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(CompensationLedger.objects.filter(claim=claim).count(), 1)

    def test_the_other_reasons_still_win_over_the_switch(self):
        CompensationConfig.objects.filter(pk=1).update(holiday_work_enabled=False)
        self.manager.can_approve_compensation = False
        self.manager.save()
        item = self.approvals(self.hod())["holiday_work"]
        self.assertEqual((item["canApprove"], item["reason"]), (False, "Not enabled for your Department Head."))
        self.manager.can_approve_compensation = True
        self.manager.save()
        approval.save_config("holiday_work", enabled=False, actor="t")
        item = self.approvals(self.hod())["holiday_work"]
        self.assertEqual((item["canApprove"], item["reason"]), (False, "Switched off by HR."))

    def test_a_production_employee_has_a_head_too_without_the_staff_only_approvals(self):
        body = self.hod(self.prod)
        self.assertTrue(body["assigned"])
        self.assertEqual(body["name"], "ECB Ec")
        keys = [a["key"] for a in body["approvals"]]
        self.assertNotIn("casual_leave", keys)
        self.assertNotIn("holiday_work", keys)
        self.assertIn("leave", keys)


class HodAssignmentTests(HodBase):
    def test_an_individual_assignment_beats_the_department(self):
        other = _employee("ECO", self.ho, self.cutting)
        other_manager = DepartmentManager.objects.create(employee=other)
        ManagerEmployeeAssignment.objects.create(manager=other_manager, employee=self.asha)
        self.assertEqual(self.hod()["name"], "ECO Ec")
        self.assertEqual(self.hod(self.ravi)["name"], "ECB Ec")  # the rest of the department keep the department's head

    def test_a_removed_employee_has_no_head_until_another_one_holds_the_department(self):
        ManagerEmployeeExclusion.objects.create(manager=self.manager, employee=self.asha)
        body = self.hod()
        self.assertEqual((body["assigned"], body["name"], body["approvals"]), (False, None, []))
        self.assertIn("do not have a Department Head assigned", body["message"])
        self.assertEqual(self.hod(self.ravi)["name"], "ECB Ec")

    def test_no_head_at_all_is_a_friendly_answer(self):
        body = self.hod(self.mani)  # another branch's department: nobody holds it
        self.assertEqual(
            (body["assigned"], body["name"], body["phone"], body["photoUrl"], body["approvals"]),
            (False, None, None, None, []),
        )
        self.assertIn("contact HR", body["message"])
        self.assertEqual(body["hrContact"]["phone"], "0421 430 0800")

    def test_an_inactive_head_is_not_the_head(self):
        self.manager.is_active = False
        self.manager.save()
        self.assertFalse(self.hod()["assigned"])

    def test_a_head_is_not_their_own_head(self):
        body = self.hod(self.boss)
        self.assertEqual((body["assigned"], body.get("isSelf")), (False, True))
        self.assertIn("Department Head yourself", body["message"])
        # a head's holiday-work claim is a Department-Head-only workflow: HR cannot decide it, so the page must not say so
        self.assertNotIn("HR decides your own requests", body["message"])
        self.assertIn("only a Department Head can decide", body["message"])
        self.assertIn("another Department Head", body["message"])
        self.assertIn("ask HR", body["message"])
        self.assertEqual(body["approvals"], [])
        # unless somebody else has them individually
        other = _employee("ECO", self.ho, self.cutting)
        ManagerEmployeeAssignment.objects.create(
            manager=DepartmentManager.objects.create(employee=other), employee=self.boss
        )
        again = self.hod(self.boss)
        self.assertEqual((again["assigned"], again["name"]), (True, "ECO Ec"))

    def test_only_my_own_head_is_returned(self):
        mine = self.hod(self.asha)
        theirs = self.hod(self.mani)
        self.assertNotEqual(mine["name"], theirs["name"])

    def test_only_an_employee_token_gets_an_answer(self):
        self.assertEqual(self.client.get(HOD).status_code, 401)
        r = self.client.get(HOD, **self.hr)
        self.assertEqual((r.status_code, "sign in as an employee" in r.json()["error"]), (403, True))
        self.assertEqual(self.client.get(HOD, **_bearer({"role": "employee", "employeeId": 999999})).status_code, 404)
        self.assertEqual(self.client.post(HOD, {}, content_type="application/json", **_as(self.asha)).status_code, 405)

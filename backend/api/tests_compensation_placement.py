"""
Compensation days on a chosen date (owner brief 2026-11-28, compensation_placement.py + compensation_placement_views.py):
HR picks, on a calendar, the day a Shift (Type 2) / Overtime (OT shift credit) / Sunday / Holiday work compensation, or the
balance, is taken on; the Department Head approves, then HR; only HR's approval writes the ledger and gives the day.

Covers: the calendar (days off, the window, a day already holding something, how much a day can take, what is left), every
source (a credit claim, the balance, a Type 2 OT record and a Sunday worked placed at once, partly), the two-step route
(the head's list, not your turn, HR's decision, the Requests hub kind), refusals, and that the employees' own use requests
keep the one-step pipeline.

The attendance of past days is stored by hand here (refresh_days is a no-op) and every approval is on a day still to come,
so the attendance engine is never run; the approval's evidence refresh is off (the OT record has no punches behind it) and
the quarters credit is pinned to 0.75 (tests_compensation_claims does the same).

Run via: python manage.py test api.tests_compensation_placement
"""

from datetime import date, time
from decimal import Decimal
from unittest import mock

from django.test import TestCase

from . import approval_workflow as approval
from . import compensation_claims as claims
from . import compensation_effects as effects
from . import compensation_placement as places
from .jwt_utils import sign_token
from .models import (
    AttendanceDayRecord,
    AttendanceLog,
    Branch,
    CompensationConfig,
    CompensationLedger,
    Department,
    DepartmentManager,
    Employee,
    Holiday,
    HolidayWorkClaim,
    HRUser,
    ManagerDepartmentAssignment,
    OvertimeRecord,
    PayrollSettings,
)

TODAY = date(2026, 11, 25)  # a Wednesday
CLAIMS_FROM = date(2026, 11, 1)
SUNDAY = date(2026, 11, 22)  # worked
OT_DAY = date(2026, 11, 23)  # Monday, a Type 2 OT
HOLIDAY = date(2026, 12, 4)  # a Friday, declared below
FUTURE = date(2026, 12, 2)  # a Wednesday still to come
FUTURE2 = date(2026, 12, 3)
PAST_ABSENT = date(2026, 11, 18)  # Wednesday, stored Absent
PAST_PRESENT = date(2026, 11, 19)  # Thursday, stored Present
PAST_HALF = date(2026, 11, 20)  # Friday, stored Half Day

TODAY_PATCHES = (
    "api.clock.ist_today",
    "api.compensation_claims.ist_today",
    "api.compensation_claims_views.ist_today",
    "api.compensation_placement_views.ist_today",
    "api.compensation_apply.ist_today",
    "api.holiday_work_views.ist_today",
    "api.request_window.ist_today",
)


def _bearer(payload: dict) -> dict:
    return {"HTTP_AUTHORIZATION": f"Bearer {sign_token(payload)}"}


def _employee(code, branch, department, kind="staff") -> Employee:
    return Employee.objects.create(
        employee_code=code,
        first_name=code,
        last_name="Pl",
        employment_type=kind,
        status="active",
        branch=branch,
        department=department,
    )


def _punch(emp, day):
    AttendanceLog.objects.create(employee=emp, date=day, punch_time=time(9, 0), punch_type="IN", source="biometric")
    AttendanceLog.objects.create(employee=emp, date=day, punch_time=time(17, 0), punch_type="OUT", source="biometric")


def _day(emp, d, status, shifts):
    AttendanceDayRecord.objects.create(
        employee=emp,
        date=d,
        status=status,
        shifts_earned=Decimal(shifts),
        is_half_shift=status == AttendanceDayRecord.STATUS_HALF,
        total_punches=0 if status == AttendanceDayRecord.STATUS_ABSENT else 2,
        first_punch=None if status == AttendanceDayRecord.STATUS_ABSENT else time(9, 0),
        source="auto",
    )


class PlacementBase(TestCase):
    def setUp(self):
        from .attendance_final import _holiday_dates_for_month

        approval.clear_cache()
        self.addCleanup(approval.clear_cache)
        _holiday_dates_for_month.cache_clear()
        self.addCleanup(_holiday_dates_for_month.cache_clear)
        for target in TODAY_PATCHES:
            patch = mock.patch(target, return_value=TODAY)
            patch.start()
            self.addCleanup(patch.stop)
        for obj, name, value in (
            (effects, "staff_ot_credit", Decimal("0.75")),
            (effects, "quarter_rule_applies", True),
            (claims, "_refresh_evidence", None),
            (places, "refresh_days", None),
        ):
            patch = mock.patch.object(obj, name, return_value=value)
            patch.start()
            self.addCleanup(patch.stop)

        settings = PayrollSettings.get()
        settings.compensation_feature_enabled = True
        settings.save()
        CompensationConfig.objects.update_or_create(
            pk=1,
            defaults={
                "holiday_work_enabled": True,
                "allowance_enabled": True,
                "shift_enabled": True,
                "relaxation_enabled": True,
                "pay_enabled": True,
                "claims_from": CLAIMS_FROM,
                "ot_quarter_rule_history": [],
            },
        )
        Holiday.objects.create(name="Test Festival", date=HOLIDAY)
        self.ho = Branch.objects.create(name="PL Head Office", code="PLHO", is_head_office=True)
        self.dept = Department.objects.create(name="PL Cutting", branch=self.ho)
        self.lonely = Department.objects.create(name="PL Lonely", branch=self.ho)
        self.asha = _employee("PL1", self.ho, self.dept)
        self.nohod = _employee("PL2", self.ho, self.lonely)
        self.prod = _employee("PLP", self.ho, self.dept, kind="production")
        self.boss = _employee("PLB", self.ho, self.dept)
        manager = DepartmentManager.objects.create(employee=self.boss, can_approve_compensation=True)
        ManagerDepartmentAssignment.objects.create(manager=manager, department=self.dept)

        self.admin_user = HRUser.objects.create(
            username="pl_admin", password_hash="x", full_name="Pl Admin", is_super_admin=True
        )
        self.admin = _bearer({"role": "hr", "hrUserId": self.admin_user.id, "name": "Pl Admin"})
        self.hod = _bearer({"role": "employee", "employeeId": self.boss.id})
        self.asha_t = _bearer({"role": "employee", "employeeId": self.asha.id})

        _punch(self.asha, SUNDAY)
        _punch(self.nohod, SUNDAY)
        _day(self.asha, PAST_ABSENT, AttendanceDayRecord.STATUS_ABSENT, "0")
        _day(self.asha, PAST_PRESENT, AttendanceDayRecord.STATUS_PRESENT, "1")
        _day(self.asha, PAST_HALF, AttendanceDayRecord.STATUS_HALF, "0.5")
        self.ot = OvertimeRecord.objects.create(
            employee=self.asha,
            date=OT_DAY,
            shift_end_time=time(18, 0),
            last_punch_out=time(23, 0),
            ot_minutes=300,
            ot_type=OvertimeRecord.OT_TYPE_SHIFT,
            status=OvertimeRecord.STATUS_DETECTED,
            suggested_shifts=Decimal("0.75"),
        )

    # ── helpers ──
    def credit(self, emp=None, shifts="1.00", day=SUNDAY) -> HolidayWorkClaim:
        """An approved Sunday-work credit (and its ledger credit), as the Department Head's approval writes it."""
        claim = HolidayWorkClaim.objects.create(
            employee=emp or self.asha,
            kind=HolidayWorkClaim.KIND_HOLIDAY_WORK,
            work_date=day,
            shifts=Decimal(shifts),
            status=HolidayWorkClaim.STATUS_APPROVED,
            approval_trail=[{"role": "hod", "decision": "approved", "by": "PLB", "at": None}],
        )
        claims.credit_or_debit(claim, "PLB")
        return claim

    def calendar(self, source="balance", month="2026-12", emp=None, who=None):
        return self.client.get(
            "/api/compensation/placements/calendar",
            {"employeeId": (emp or self.asha).id, "month": month, "source": source},
            **(who or self.admin),
        )

    def place(self, source, use_date, shifts, emp=None, **extra):
        body = {
            "employeeId": (emp or self.asha).id,
            "source": source,
            "useDate": use_date.isoformat(),
            "shifts": shifts,
        }
        body.update(extra)
        return self.client.post("/api/compensation/placements", body, content_type="application/json", **self.admin)

    def hod_decide(self, claim_id, decision="approved"):
        body = {"status": decision}
        if decision == "rejected":
            body["comment"] = "Not this day, sorry"
        with self.captureOnCommitCallbacks(execute=True):
            return self.client.patch(
                f"/api/manager/holiday-work/{claim_id}/status", body, content_type="application/json", **self.hod
            )

    def hr_decide(self, claim_id, decision="approved"):
        body = {"status": decision}
        if decision == "rejected":
            body["comment"] = "Not this day, sorry"
        with self.captureOnCommitCallbacks(execute=True):
            return self.client.patch(
                f"/api/compensation/placements/{claim_id}/decision", body, content_type="application/json", **self.admin
            )

    @staticmethod
    def days(res) -> dict:
        return {d["date"]: d for d in res.json()["days"]}


class CalendarTests(PlacementBase):
    def test_days_off_window_and_amounts(self):
        self.credit()
        res = self.calendar("balance", "2026-12")
        self.assertEqual(res.status_code, 200, res.content)
        body = res.json()
        self.assertEqual(body["source"]["type"], "balance")
        self.assertEqual(body["source"]["left"], 1.0)
        self.assertEqual(body["month"]["key"], "2026-12")
        self.assertEqual(body["approvalPath"], "HR → HOD → HR")
        days = self.days(res)
        self.assertEqual(days["2026-12-06"]["status"], "off_day")  # Sunday
        self.assertFalse(days["2026-12-06"]["selectable"])
        self.assertEqual(days["2026-12-04"]["label"], "Test Festival")
        self.assertFalse(days["2026-12-04"]["selectable"])
        wed = days[FUTURE.isoformat()]
        self.assertTrue(wed["selectable"])
        self.assertEqual(wed["amounts"], [0.25, 0.5, 0.75, 1.0])
        self.assertEqual(wed["suggested"], 1.0)

    def test_past_days_take_only_what_they_did_not_earn(self):
        self.credit()
        days = self.days(self.calendar("balance", "2026-11"))
        self.assertEqual(days[PAST_ABSENT.isoformat()]["amounts"], [0.25, 0.5, 0.75, 1.0])
        self.assertEqual(days[PAST_HALF.isoformat()]["amounts"], [0.25, 0.5])
        self.assertIn("at most 0.50", days[PAST_HALF.isoformat()]["reason"])
        present = days[PAST_PRESENT.isoformat()]
        self.assertFalse(present["selectable"])
        self.assertIn("present", present["reason"])

    def test_what_is_left_limits_the_amounts(self):
        claim = self.credit(shifts="0.50")
        days = self.days(self.calendar(f"claim:{claim.id}"))
        self.assertEqual(days[FUTURE.isoformat()]["amounts"], [0.25, 0.5])

    def test_window(self):
        self.credit()
        far = self.calendar("balance", "2027-04")
        self.assertEqual(far.status_code, 400)
        res = self.calendar("balance", "2026-10")
        self.assertEqual(res.status_code, 200)
        days = self.days(res)
        self.assertEqual(days["2026-10-07"]["status"], "out_of_window")  # 49 days back
        self.assertIsNone(res.json()["month"]["prev"])

    def test_sources_say_what_they_give(self):
        ot = self.calendar(f"overtime:{self.ot.id}").json()["source"]
        self.assertEqual((ot["compType"], ot["total"], ot["placesAtOnce"], ot["canPlace"]), ("shift", 0.75, True, True))
        hw = self.calendar(f"holiday_work:{SUNDAY.isoformat()}").json()["source"]
        self.assertEqual(
            (hw["compType"], hw["compTypeLabel"], hw["creditFixed"]), ("sunday", "Sunday compensation", False)
        )
        none = self.calendar("balance").json()["source"]
        self.assertFalse(none["canPlace"])
        self.assertIn("no compensation balance", none["refusal"])

    def test_staff_only_and_branch_scope(self):
        self.assertEqual(self.calendar(emp=self.prod).status_code, 403)
        other = Branch.objects.create(name="PL Unit 9", code="PLU9")
        hr = HRUser.objects.create(
            username="pl_u9", password_hash="x", full_name="U9", branch=other, is_super_admin=False
        )
        res = self.calendar(who=_bearer({"role": "hr", "hrUserId": hr.id}))
        self.assertIn(res.status_code, (403, 404))


class PlaceFromCreditTests(PlacementBase):
    def test_hod_then_hr_then_the_day_is_given(self):
        source = self.credit()
        res = self.place({"type": "claim", "id": source.id}, FUTURE, 0.5)
        self.assertEqual(res.status_code, 201, res.content)
        data = res.json()["claim"]
        self.assertEqual((data["kind"], data["hrStep"], data["stage"]), ("use_balance", True, "hod"))
        self.assertEqual(
            (data["useDate"], data["useShifts"], data["sourceClaimId"]), (FUTURE.isoformat(), 0.5, source.id)
        )
        self.assertEqual(data["compType"], "sunday")
        self.assertEqual(data["statusLabel"], "Waiting for the Department Head")
        cid = data["id"]

        pending = self.client.get("/api/manager/pending-requests", **self.hod).json()
        self.assertIn(cid, [c["id"] for c in pending["holidayWorkClaims"]])
        # HR cannot go first
        self.assertEqual(self.hr_decide(cid).status_code, 400)

        res = self.hod_decide(cid)
        self.assertEqual(res.status_code, 200, res.content)
        claim = HolidayWorkClaim.objects.get(pk=cid)
        self.assertEqual(claim.status, "pending")
        self.assertEqual(places.stage(claim), "hr")
        self.assertFalse(CompensationLedger.objects.filter(claim=claim).exists())
        # gone from the head's list, and the head cannot decide it again
        pending = self.client.get("/api/manager/pending-requests", **self.hod).json()
        self.assertNotIn(cid, [c["id"] for c in pending["holidayWorkClaims"]])
        self.assertEqual(self.hod_decide(cid).status_code, 400)

        res = self.hr_decide(cid)
        self.assertEqual(res.status_code, 200, res.content)
        claim.refresh_from_db()
        self.assertEqual(claim.status, "approved")
        debit = CompensationLedger.objects.get(claim=claim, entry_type="debit")
        self.assertEqual((debit.shifts, debit.date), (Decimal("0.50"), FUTURE))
        left = claims.claim_json(claims.claim_queryset().get(pk=source.id), for_role="hr")
        self.assertEqual((left["placed"], left["leftToPlace"]), (0.5, 0.5))
        # the day now holds it: the calendar refuses another placement there
        days = self.days(self.calendar(f"claim:{source.id}"))
        self.assertEqual(days[FUTURE.isoformat()]["status"], "placed")

    def test_requests_hub_lists_it_for_hr_once_the_head_approved(self):
        source = self.credit()
        cid = self.place({"type": "claim", "id": source.id}, FUTURE, 1.0).json()["claim"]["id"]
        hub = self.client.get("/api/hr-requests", {"kind": "compensation_placement"}, **self.admin).json()
        item = next(i for i in hub["items"] if i["id"] == cid)
        self.assertEqual(item["kind"], "compensation_placement")
        self.assertFalse(item["approval"]["canAct"]["hr"])
        self.hod_decide(cid)
        hub = self.client.get("/api/hr-requests", {"kind": "compensation_placement"}, **self.admin).json()
        item = next(i for i in hub["items"] if i["id"] == cid)
        self.assertTrue(item["approval"]["canAct"]["hr"])
        self.assertEqual(item["label"], "Sunday compensation")
        # not listed among the head-only compensation claims
        other = self.client.get("/api/hr-requests", {"kind": "holiday_work"}, **self.admin).json()
        self.assertNotIn(cid, [i["id"] for i in other["items"]])

    def test_a_rejection_by_the_head_is_final_and_writes_nothing(self):
        source = self.credit()
        cid = self.place({"type": "claim", "id": source.id}, FUTURE, 1.0).json()["claim"]["id"]
        self.assertEqual(self.hod_decide(cid, "rejected").status_code, 200)
        claim = HolidayWorkClaim.objects.get(pk=cid)
        self.assertEqual(claim.status, "rejected")
        self.assertFalse(CompensationLedger.objects.filter(claim=claim).exists())
        # the credit is free to place again
        again = self.place({"type": "claim", "id": source.id}, FUTURE, 1.0)
        self.assertEqual(again.status_code, 201, again.content)

    def test_from_the_balance_as_a_whole(self):
        self.credit()
        res = self.place({"type": "balance"}, FUTURE, 0.75)
        self.assertEqual(res.status_code, 201, res.content)
        data = res.json()["claim"]
        self.assertEqual((data["compType"], data["sourceClaimId"]), ("balance", None))
        figures = claims.balance_figures([self.asha.id])[self.asha.id]
        self.assertEqual(figures["pending"], Decimal("0.75"))  # held while it waits


class PlaceAtOnceTests(PlacementBase):
    def test_type2_overtime_is_credited_and_given_on_the_day(self):
        res = self.place({"type": "overtime", "id": self.ot.id}, FUTURE, 0.75)
        self.assertEqual(res.status_code, 201, res.content)
        data = res.json()["claim"]
        self.assertEqual((data["kind"], data["hrStep"], data["compType"]), ("ot_shift", True, "shift"))
        self.assertEqual((data["useDate"], data["useShifts"], data["shifts"]), (FUTURE.isoformat(), 0.75, 0.75))
        cid = data["id"]
        self.hod_decide(cid)
        self.assertFalse(CompensationLedger.objects.filter(claim_id=cid).exists())
        self.assertEqual(self.hr_decide(cid).status_code, 200)
        entries = {e.entry_type: e for e in CompensationLedger.objects.filter(claim_id=cid)}
        self.assertEqual((entries["credit"].shifts, entries["credit"].date), (Decimal("0.75"), OT_DAY))
        self.assertEqual((entries["debit"].shifts, entries["debit"].date), (Decimal("0.75"), FUTURE))
        self.ot.refresh_from_db()
        self.assertEqual(self.ot.status, OvertimeRecord.STATUS_ANNOUNCED)
        self.assertEqual(claims.balance_figures([self.asha.id])[self.asha.id]["available"], Decimal("0"))
        claim = HolidayWorkClaim.objects.get(pk=cid)
        self.assertEqual(claims.status_label(claim), "Approved: given on Wednesday 2 Dec 2026")

    def test_a_sunday_worked_placed_in_part_leaves_the_rest_in_the_balance(self):
        res = self.place({"type": "holiday_work", "date": SUNDAY.isoformat()}, FUTURE2, 0.5, creditShifts=1.0)
        self.assertEqual(res.status_code, 201, res.content)
        cid = res.json()["claim"]["id"]
        self.hod_decide(cid)
        self.hr_decide(cid)
        figures = claims.balance_figures([self.asha.id])[self.asha.id]
        self.assertEqual(
            (figures["earned"], figures["used"], figures["available"]), (Decimal("1"), Decimal("0.5"), Decimal("0.5"))
        )
        source = claims.claim_json(claims.claim_queryset().get(pk=cid), for_role="hr")
        self.assertEqual((source["placed"], source["leftToPlace"]), (0.5, 0.5))

    def test_a_record_with_an_open_claim_cannot_be_placed(self):
        claims.create_claim(
            employee=self.asha,
            kind=HolidayWorkClaim.KIND_OT_SHIFT,
            date=OT_DAY,
            overtime_record=self.ot,
            reason="",
            raised_by_role="employee",
            raised_by_name="PL1",
        )
        res = self.place({"type": "overtime", "id": self.ot.id}, FUTURE, 0.75)
        self.assertEqual(res.status_code, 400)
        self.assertEqual(res.json()["code"], "already_claimed")


class RefusalTests(PlacementBase):
    def test_days_that_cannot_take_it(self):
        source = self.credit()
        sunday = self.place({"type": "claim", "id": source.id}, date(2026, 12, 6), 0.5)
        self.assertEqual((sunday.status_code, sunday.json()["code"]), (400, "date_not_allowed"))
        holiday = self.place({"type": "claim", "id": source.id}, HOLIDAY, 0.5)
        self.assertEqual(holiday.json()["code"], "date_not_allowed")
        half = self.place({"type": "claim", "id": source.id}, PAST_HALF, 0.75)
        self.assertEqual(half.json()["code"], "date_not_allowed")
        self.assertIn("at most 0.50", half.json()["error"])

    def test_more_than_is_left_and_one_placement_a_day(self):
        source = self.credit(shifts="0.50")
        self.assertEqual(self.place({"type": "claim", "id": source.id}, FUTURE, 0.75).status_code, 409)
        self.assertEqual(self.place({"type": "claim", "id": source.id}, FUTURE, 0.25).status_code, 201)
        second = self.place({"type": "claim", "id": source.id}, FUTURE, 0.25)
        self.assertEqual(second.status_code, 400)
        self.assertEqual(second.json()["code"], "date_not_allowed")

    def test_no_department_head_production_and_switched_off(self):
        source = self.credit(emp=self.nohod)
        res = self.place({"type": "claim", "id": source.id}, FUTURE, 1.0, emp=self.nohod)
        self.assertEqual((res.status_code, res.json()["code"]), (409, "no_hod"))
        self.assertEqual(self.place({"type": "balance"}, FUTURE, 1.0, emp=self.prod).status_code, 403)
        approval.save_config(places.WORKFLOW, enabled=False)
        approval.clear_cache()
        mine = self.credit(day=date(2026, 11, 15))
        off = self.place({"type": "claim", "id": mine.id}, FUTURE, 1.0)
        self.assertEqual((off.status_code, off.json()["code"]), (403, "switched_off"))

    def test_someone_elses_credit_and_a_pending_credit(self):
        other = self.credit(emp=self.nohod)
        self.assertEqual(self.place({"type": "claim", "id": other.id}, FUTURE, 1.0).status_code, 404)
        pending = HolidayWorkClaim.objects.create(
            employee=self.asha, kind="holiday_work", work_date=date(2026, 11, 15), shifts=1, status="pending"
        )
        res = self.place({"type": "claim", "id": pending.id}, FUTURE, 1.0)
        self.assertEqual((res.status_code, res.json()["code"]), (400, "not_approved"))

    def test_approval_is_refused_when_the_day_changed(self):
        source = self.credit()
        cid = self.place({"type": "claim", "id": source.id}, FUTURE, 1.0).json()["claim"]["id"]
        self.hod_decide(cid)
        # HR marked the day by hand as a full paid day meanwhile
        AttendanceDayRecord.objects.create(
            employee=self.asha, date=FUTURE, status="present", shifts_earned=Decimal("1"), source="manual"
        )
        res = self.hr_decide(cid)
        self.assertEqual(res.status_code, 409, res.content)
        self.assertEqual(res.json()["code"], "claim_refused")


class OneStepUnchangedTests(PlacementBase):
    def test_the_employees_own_use_request_is_still_the_head_alone(self):
        self.credit()
        res = self.client.post(
            "/api/employee/compensation/use",
            {"date": "2026-11-26", "shifts": 0.5, "reason": "Family function"},  # the apps' request window: this month
            content_type="application/json",
            **self.asha_t,
        )
        self.assertEqual(res.status_code, 201, res.content)
        cid = HolidayWorkClaim.objects.get(kind="use_balance", employee=self.asha).id
        claim = HolidayWorkClaim.objects.get(pk=cid)
        self.assertFalse(claim.hr_step)
        self.assertEqual(claim.approval_workflow_key, "holiday_work")
        self.assertEqual(self.hod_decide(cid).status_code, 200)
        claim.refresh_from_db()
        self.assertEqual(claim.status, "approved")
        self.assertTrue(CompensationLedger.objects.filter(claim=claim, entry_type="debit").exists())
        # HR has no step on it
        self.assertEqual(self.hr_decide(cid).status_code, 404)

    def test_routing_is_per_row(self):
        plain = HolidayWorkClaim(hr_step=False)
        placed = HolidayWorkClaim(hr_step=True)
        self.assertEqual(approval.routed_key("holiday_work", plain), "holiday_work")
        self.assertEqual(approval.routed_key("holiday_work", placed), "compensation_placement")
        self.assertEqual(approval.routed_key("leave", placed), "leave")  # another table's workflow is never re-routed

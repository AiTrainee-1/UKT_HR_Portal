"""
Birthday Compensation on a chosen date (owner brief 2026-11-25): a worked birthday gives 1.00 day the employee (or HR)
places on days of the birthday month (a full day or a half, two halves may go on two dates), approved by the Department
Head then HR, then paid by the attendance engine like a Casual Leave.

The real attendance engine throughout (tests_comp_fix_v.EngineClaimsBase: "today" is Thursday 12 March 2026, the 08:30-17:30
shift with the first half ending 13:00 and a 60 min lunch, the employee's birthday Thursday 5 March, their Department Head
VFXB). birthday_claims_from is 1 March so the March birthday follows the new birthday rule. WhatsApp is never sent.

  A. entitlement: worked / half day worked / not worked (paid leave) / a day off / upcoming / no date of birth / lapsed
  B. eligible dates: every kind of day, the birthday, other months, Payroll Done, Casual Leave, a day HR set by hand
  C. raising: halves on two dates, holds and release (withdraw, reject), the database's own guard, HR for an employee
  D. approval: HOD then HR (both mandatory), HOD reject, HR reject, a rejection needs its reason, HR's approval right,
     the re-check at approval (the day was worked meanwhile, the birthday no longer worked), Payroll Done
  E. the engine: full / first / second half on absent, half-day and future days, covered-half marks lifted, a manual day
     released, the marker and its note
  F. one benefit per birthday: the automatic paid leave, old credit claims kept and readable, new credit claims refused
  G. the surfaces: Requests hub, manager lists / counts / decision, mobile Approvals, MD portal, HoD's tab, the HR
     Birthdays list, the employee compensation page, the 45-day automatic rejection, branch scoping, notifications

Run via: DB_TEST_NAME=test_uktex_bday python manage.py test api.tests_birthday_compensation --noinput
"""

from datetime import date, time, timedelta
from decimal import Decimal
from unittest import mock

from django.utils import timezone

from . import approval_workflow as approval
from . import birthday_compensation as rules
from . import tests_compensation_engine as base
from .attendance_final import _holiday_dates_for_month, compute_range_records
from .models import (
    AttendanceDayRecord,
    BirthdayCompensationUse,
    Branch,
    CasualLeaveRequest,
    CompensationLedger,
    EmployeeShiftAssignment,
    Holiday,
    HolidayWorkClaim,
    HRUser,
    LeaveRequest,
    Notification,
    PayrollSettings,
    Role,
)
from .tests_comp_fix_v import ENGINE_TODAY, EngineClaimsBase
from .tests_compensation_claims import _emp_token, _hr, _hr_user

SUN1 = date(2026, 3, 1)
MON = date(2026, 3, 2)
TUE = date(2026, 3, 3)
WED = date(2026, 3, 4)
BIRTHDAY = date(2026, 3, 5)  # Thursday
FRI = date(2026, 3, 6)
SAT = date(2026, 3, 7)
SUN = date(2026, 3, 8)
MON2 = date(2026, 3, 9)
TUE2 = date(2026, 3, 10)
WED2 = date(2026, 3, 11)
TODAY = ENGINE_TODAY  # Thursday 12 March
FRI2 = date(2026, 3, 13)
MON3 = date(2026, 3, 16)
TUE3 = date(2026, 3, 17)
APRIL = date(2026, 4, 2)

TODAY_TARGETS = (
    "api.birthday_compensation_service.ist_today",
    "api.birthday_compensation_views.ist_today",
    "api.compensation_birthday_views.ist_today",
)

EMP_URL = "/api/employee/compensation/birthday"
EMP_USES = "/api/employee/compensation/birthday/uses"
HR_URL = "/api/compensation/birthday-compensation"
HR_USES = "/api/compensation/birthday-compensation/uses"


class BirthdayCompBase(EngineClaimsBase):
    CODE = "BDC1"

    def setUp(self):
        super().setUp()
        for target in TODAY_TARGETS:
            patch = mock.patch(target, return_value=TODAY)
            patch.start()
            self.addCleanup(patch.stop)
        self.decision_wa = mock.patch("api.whatsapp_approvals.notify_decision", return_value=None)
        self.notify_decision = self.decision_wa.start()
        self.addCleanup(self.decision_wa.stop)
        hod_wa = mock.patch("api.whatsapp_hod.request_waiting", return_value=None)
        hod_wa.start()
        self.addCleanup(hod_wa.stop)
        # the birthday rule of 2026-11-19 for March birthdays (birthday_claims_from, migration 0185)
        base.set_config(birthday_claims_from=SUN1)
        self.ho = Branch.objects.create(name="BDC Head Office", code="BDCHO", is_head_office=True)
        self.u2 = Branch.objects.create(name="BDC Unit 2", code="BDCU2")
        self.dept.branch = self.ho
        self.dept.save()
        for emp in (self.emp, self.boss):
            emp.branch = self.ho
            emp.save()
        self.admin_user = _hr_user("bdc_admin", super_admin=True)
        self.admin = _hr(self.admin_user)
        self.emp_t = _emp_token(self.emp)
        self.hod_t = _emp_token(self.boss)
        self.worked(BIRTHDAY, time(17, 30))  # worked the birthday by default

    # ── helpers ──
    def entitlement(self, today=TODAY, refresh=True, **kw):
        return rules.entitlement(self.emp, BIRTHDAY, today, refresh=refresh, **kw)

    def options(self, today=TODAY):
        return {o.date: o for o in self.entitlement(today).options}

    def mine(self, **params):
        response = self.client.get(EMP_URL, params, **self.emp_t)
        self.assertEqual(response.status_code, 200, response.content)
        return response.json()

    def place(self, use_date, portion="full", reason="", token=None):
        return self.client.post(
            EMP_USES,
            {"useDate": use_date.isoformat(), "portion": portion, "reason": reason},
            content_type="application/json",
            **(token or self.emp_t),
        )

    def placed(self, use_date, portion="full"):
        response = self.place(use_date, portion)
        self.assertEqual(response.status_code, 201, response.content)
        return BirthdayCompensationUse.objects.get(pk=response.json()["id"])

    def hod_decide(self, use, decision="approved", comment=None):
        body = {"status": decision}
        if comment is not None or decision == "rejected":
            body["comment"] = comment if comment is not None else "Not this day, please choose another"
        response = self.client.patch(
            f"/api/manager/birthday-compensation/{use.pk}/status", body, content_type="application/json", **self.hod_t
        )
        return response

    def hr_decide(self, use, decision="approved", comment=None, headers=None):
        body = {"status": decision}
        if comment is not None or decision == "rejected":
            body["comment"] = comment if comment is not None else "Payroll is closing, choose another day"
        return self.client.patch(
            f"{HR_USES}/{use.pk}/decision", body, content_type="application/json", **(headers or self.admin)
        )

    def approve_both(self, use):
        r1 = self.hod_decide(use)
        self.assertEqual(r1.status_code, 200, r1.content)
        r2 = self.hr_decide(use)
        self.assertEqual(r2.status_code, 200, r2.content)
        use.refresh_from_db()
        return r2.json()

    def day(self, d):
        compute_range_records(self.emp, d, d, PayrollSettings.get())
        return self.stored(d)


# ═════════════════════════════ A. entitlement ═════════════════════════════


class EntitlementTests(BirthdayCompBase):
    def test_a_worked_birthday_gives_one_day_to_place_in_its_month(self):
        ent = self.entitlement()
        self.assertEqual(
            (ent.state, ent.worked, ent.total, ent.available), ("available", True, Decimal("1.00"), Decimal("1.00"))
        )
        self.assertTrue(ent.can_place, ent.place_message)
        self.assertEqual((ent.month_start, ent.month_end), (date(2026, 3, 1), date(2026, 3, 31)))
        # the birthday itself stays the normal worked day (no credit, no marker)
        rec = self.stored(BIRTHDAY)
        self.assertEqual((rec.status, rec.shifts_earned, rec.compensation_kind), ("present", Decimal("1.00"), ""))

    def test_a_half_day_worked_on_the_birthday_counts_as_worked_and_nothing_is_automatic(self):
        self.punch(BIRTHDAY, time(8, 30), time(13, 0))  # the morning only
        ent = self.entitlement()
        self.assertEqual((ent.state, ent.available), ("available", Decimal("1.00")))
        rec = self.stored(BIRTHDAY)
        self.assertEqual((rec.status, rec.shifts_earned, rec.compensation_kind), ("half_shift", Decimal("0.50"), ""))

    def test_a_birthday_not_worked_is_paid_birthday_leave_with_nothing_to_place(self):
        self.punch(BIRTHDAY)
        ent = self.entitlement()
        self.assertEqual((ent.state, ent.total, ent.can_place), ("paid_leave", Decimal("0.00"), False))
        self.assertEqual(self.stored(BIRTHDAY).compensation_kind, "birthday")
        r = self.place(MON3)
        self.assertEqual((r.status_code, r.json()["code"]), (400, "not_eligible"), r.content)

    def test_a_birthday_on_a_day_off_gives_nothing(self):
        self.emp.date_of_birth = date(1990, 3, 8)  # Sunday 8 March 2026
        self.emp.save()
        ent = rules.entitlement(self.emp, SUN, TODAY, refresh=True)
        self.assertEqual((ent.state, ent.can_place), ("off_day", False))

    def test_a_birthday_still_to_come_cannot_be_placed_yet(self):
        self.emp.date_of_birth = date(1990, 3, 20)
        self.emp.save()
        ent = rules.entitlement(self.emp, date(2026, 3, 20), TODAY, refresh=True)
        self.assertEqual(ent.state, "upcoming")
        r = self.place(MON3)
        self.assertEqual((r.status_code, r.json()["code"]), (400, "not_yet"), r.content)

    def test_todays_birthday_can_be_placed_as_soon_as_it_is_worked(self):
        engine_today = mock.patch("api.attendance_final.ist_today", return_value=TODAY)
        engine_today.start()
        self.addCleanup(engine_today.stop)
        self.emp.date_of_birth = date(1990, 3, 12)
        self.emp.save()
        self.punch(TODAY)
        self.assertEqual(rules.entitlement(self.emp, TODAY, TODAY, refresh=True).state, "upcoming")
        self.punch(TODAY, time(8, 30))
        self.assertEqual(rules.entitlement(self.emp, TODAY, TODAY, refresh=True).state, "available")

    def test_after_the_month_what_was_not_placed_lapses(self):
        april = date(2026, 4, 1)
        self.placed(TUE, "first_half")
        ent = self.entitlement(today=april)
        self.assertEqual(
            (ent.state, ent.held, ent.available, ent.lapsed),
            ("lapsed", Decimal("0.50"), Decimal("0.00"), Decimal("0.50")),
        )
        with mock.patch("api.birthday_compensation_service.ist_today", return_value=april):
            r = self.place(MON3, "second_half")
        self.assertEqual((r.status_code, r.json()["code"]), (400, "lapsed"), r.content)

    def test_no_date_of_birth_and_production_are_refused(self):
        self.emp.date_of_birth = None
        self.emp.save()
        body = self.mine()
        self.assertEqual((body["state"], body["canPlace"]), ("not_eligible", False))
        self.assertIn("date of birth", body["message"])
        prod = self.new_staff("BDCP", employment_type="production", date_of_birth=date(1990, 3, 5))
        body = self.client.get(EMP_URL, **_emp_token(prod)).json()
        self.assertFalse(body["isStaff"])
        r = self.place(MON3, token=_emp_token(prod))
        self.assertEqual((r.status_code, r.json()["code"]), (403, "not_staff"))

    def test_the_switches_stop_new_placements(self):
        base.set_config(birthday_enabled=False)
        r = self.place(MON3)
        self.assertEqual((r.status_code, r.json()["code"]), (403, "switched_off"))
        base.set_config(birthday_enabled=True)
        approval.save_config("birthday_compensation", enabled=False)
        r = self.place(MON3)
        self.assertEqual((r.status_code, r.json()["code"]), (403, "switched_off"))

    def test_the_employee_endpoint_answers_the_whole_month(self):
        body = self.mine()
        self.assertEqual(body["birthday"], "2026-03-05")
        self.assertEqual(body["state"], "available")
        self.assertEqual(body["days"], {"total": 1.0, "held": 0.0, "used": 0.0, "available": 1.0, "lapsed": 0.0})
        self.assertEqual(body["month"]["label"], "March 2026")
        self.assertEqual(body["lapsesOn"], "2026-03-31")
        self.assertEqual(len(body["eligibleDates"]), 31)
        self.assertEqual(body["approvalPath"], "Employee or HR → HOD → HR")
        self.assertTrue(body["canPlace"])
        self.assertEqual(self.client.get(EMP_URL, **self.admin).status_code, 403)  # an HR token is not an employee


# ═════════════════════════════ B. eligible dates ═════════════════════════════


class EligibleDatesTests(BirthdayCompBase):
    def setUp(self):
        super().setUp()
        self.worked(MON, time(17, 30))  # present
        self.punch(TUE)  # absent
        lt = LeaveRequest.objects.create(
            employee=self.emp, start_date=WED.isoformat(), end_date=WED.isoformat(), type="casual", status="approved"
        )
        self.leave = lt
        self.punch(FRI, time(8, 30), time(13, 0))  # half day: the morning
        self.punch(MON2, time(14, 0), time(17, 30))  # half day: the evening
        Holiday.objects.create(name="Local festival", date=WED2)
        _holiday_dates_for_month.cache_clear()

    def test_each_kind_of_day(self):
        days = self.options()
        self.assertEqual(days[BIRTHDAY].portions, ())
        self.assertIn("birthday itself", days[BIRTHDAY].reason)
        self.assertEqual(days[SUN1].portions, ())
        self.assertIn("Sunday", days[SUN].reason)
        self.assertEqual(days[WED2].portions, ())
        self.assertIn("Local festival", days[WED2].reason)
        self.assertEqual(days[MON].portions, ())
        self.assertIn("present", days[MON].reason)
        self.assertEqual((days[TUE].status, days[TUE].portions), ("absent", ("full", "first_half", "second_half")))
        self.assertEqual((days[WED].status, days[WED].portions), ("on_leave", ("full", "first_half", "second_half")))
        # a half day takes the MISSED half or a full day (the Casual Leave carry-forward rule)
        self.assertEqual(
            (days[FRI].worked, days[FRI].portions, days[FRI].suggested),
            ("morning", ("second_half", "full"), "second_half"),
        )
        self.assertEqual((days[MON2].worked, days[MON2].portions), ("evening", ("first_half", "full")))
        self.assertEqual(days[FRI].halves, {"first": "08:30-13:00", "second": "14:00-17:30"})
        # still to come: anything
        self.assertEqual((days[MON3].status, days[MON3].portions), ("future", ("full", "first_half", "second_half")))
        # today with no punch yet counts as still to come; with a punch it is judged by its punches
        self.assertEqual(days[TODAY].status, "today")

    def test_an_off_saturday_and_a_day_before_joining(self):
        EmployeeShiftAssignment.objects.filter(employee=self.emp).update(saturday_off=True)
        self.emp.join_date = "2026-03-03"
        self.emp.save()
        days = self.options()
        self.assertEqual(days[SAT].portions, ())
        self.assertIn("Saturday", days[SAT].reason)
        self.assertEqual(days[MON].portions, ())
        self.assertIn("joined", days[MON].reason)

    def test_a_day_hr_set_by_hand_takes_a_full_day_only(self):
        self.day(TUE)
        AttendanceDayRecord.objects.filter(employee=self.emp, date=TUE).update(source="manual", status="absent")
        self.assertEqual(self.options()[TUE].portions, ("full",))

    def test_casual_leave_or_a_compensation_day_off_blocks_the_day(self):
        CasualLeaveRequest.objects.create(employee=self.emp, date=TUE, reason="rest", status="pending")
        HolidayWorkClaim.objects.create(
            employee=self.emp, kind="use_balance", work_date=MON3, shifts=Decimal("1.00"), status="pending"
        )
        days = self.options()
        self.assertEqual(days[TUE].portions, ())
        self.assertIn("Casual Leave", days[TUE].reason)
        self.assertEqual(days[MON3].portions, ())
        self.assertIn("compensation balance", days[MON3].reason)

    def test_other_months_and_the_birthday_itself_are_refused(self):
        r = self.place(APRIL)
        self.assertEqual((r.status_code, r.json()["code"]), (400, "not_eligible"))
        self.assertIn("birthday month (March 2026)", r.json()["error"])
        r = self.place(BIRTHDAY)
        self.assertEqual((r.status_code, r.json()["code"]), (400, "date_not_allowed"))
        r = self.place(SUN)
        self.assertEqual((r.status_code, r.json()["code"]), (400, "date_not_allowed"))
        r = self.place(MON)
        self.assertEqual((r.status_code, r.json()["code"]), (400, "date_not_allowed"))
        self.assertIn("present", r.json()["error"])
        r = self.place(FRI, "first_half")  # the morning was worked: only the second half or a full day
        self.assertEqual((r.status_code, r.json()["code"]), (400, "date_not_allowed"))
        self.assertIn("only a second half or full day", r.json()["error"])

    def test_payroll_done_closes_the_month(self):
        self.entitlement()  # the month worked out before it was closed (a finalized month is never worked out again)
        self.lock_march()
        days = self.options()
        self.assertTrue(all(not o.selectable for o in days.values()))
        self.assertIn("Payroll Done", days[TUE].reason)
        r = self.place(TUE)
        self.assertEqual((r.status_code, r.json()["code"]), (409, "locked"), r.content)


# ═════════════════════════════ C. raising, holds and release ═════════════════════════════


class RaiseAndHoldTests(BirthdayCompBase):
    def setUp(self):
        super().setUp()
        self.punch(TUE)

    def test_two_halves_on_two_dates_then_nothing_left(self):
        first = self.placed(TUE, "first_half")
        self.assertEqual((first.days, first.status, first.birthday), (Decimal("0.50"), "pending", BIRTHDAY))
        ent = self.entitlement()
        self.assertEqual((ent.held, ent.available), (Decimal("0.50"), Decimal("0.50")))
        days = {o.date: o for o in ent.options}
        # the other half of Tuesday is still free; a full day no longer fits anywhere
        self.assertEqual(days[TUE].portions, ("second_half",))
        self.assertEqual(days[MON3].portions, ("first_half", "second_half"))
        r = self.place(MON3, "full")
        self.assertEqual((r.status_code, r.json()["code"]), (409, "nothing_left"))
        self.placed(MON3, "second_half")
        ent = self.entitlement()
        self.assertEqual((ent.state, ent.held, ent.available), ("placed", Decimal("1.00"), Decimal("0.00")))
        r = self.place(TUE3, "first_half")
        self.assertEqual((r.status_code, r.json()["code"]), (409, "nothing_left"))

    def test_two_halves_of_the_same_date_make_a_full_day_and_the_same_half_twice_is_refused(self):
        self.placed(TUE, "first_half")
        r = self.place(TUE, "first_half")
        self.assertEqual(r.status_code, 400, r.content)
        self.placed(TUE, "second_half")
        self.assertEqual(self.entitlement().available, Decimal("0.00"))

    def test_the_database_refuses_two_open_uses_of_one_half(self):
        from django.db import IntegrityError, transaction

        BirthdayCompensationUse.objects.create(
            employee=self.emp, birthday=BIRTHDAY, use_date=TUE, portion="full", days=Decimal("1.00")
        )
        with self.assertRaises(IntegrityError), transaction.atomic():
            BirthdayCompensationUse.objects.create(
                employee=self.emp, birthday=BIRTHDAY, use_date=TUE, portion="second_half", days=Decimal("0.50")
            )
        # a rejected one never blocks
        BirthdayCompensationUse.objects.update(status="rejected")
        BirthdayCompensationUse.objects.create(
            employee=self.emp, birthday=BIRTHDAY, use_date=TUE, portion="second_half", days=Decimal("0.50")
        )

    def test_withdrawing_frees_the_day_and_only_my_own(self):
        use = self.placed(TUE)
        self.assertEqual(self.entitlement().available, Decimal("0.00"))
        r = self.client.delete(f"{EMP_USES}/{use.pk}", **self.emp_t)
        self.assertEqual((r.status_code, r.json()["status"]), (200, "withdrawn"), r.content)
        self.assertEqual(self.entitlement().available, Decimal("1.00"))
        r = self.client.delete(f"{EMP_USES}/{use.pk}", **self.emp_t)
        self.assertEqual((r.status_code, r.json()["code"]), (400, "not_pending"))
        # HR placed one: the employee cannot withdraw it, HR can
        hr_use = self.client.post(
            HR_USES,
            {"employeeId": self.emp.id, "useDate": TUE.isoformat(), "portion": "full"},
            content_type="application/json",
            **self.admin,
        )
        self.assertEqual(hr_use.status_code, 201, hr_use.content)
        pk = hr_use.json()["id"]
        self.assertEqual(hr_use.json()["raisedByRole"], "hr")
        r = self.client.delete(f"{EMP_USES}/{pk}", **self.emp_t)
        self.assertEqual((r.status_code, r.json()["code"]), (403, "not_yours"))
        r = self.client.delete(f"{HR_USES}/{pk}", **self.admin)
        self.assertEqual((r.status_code, r.json()["status"]), (200, "withdrawn"))
        # someone else's use is not found for the employee
        other = self.new_staff("BDC2", department=self.dept, date_of_birth=date(1990, 3, 5), branch=self.ho)
        r = self.client.delete(f"{EMP_USES}/{pk}", **_emp_token(other))
        self.assertEqual(r.status_code, 404)

    def test_a_rejection_frees_its_part(self):
        use = self.placed(TUE)
        r = self.hod_decide(use, "rejected")
        self.assertEqual((r.status_code, r.json()["status"]), (200, "rejected"), r.content)
        self.assertEqual(self.entitlement().available, Decimal("1.00"))
        self.placed(TUE)  # the same day again

    def test_no_department_head_who_may_approve_compensation(self):
        self.manager.can_approve_compensation = False
        self.manager.save()
        r = self.place(TUE)
        self.assertEqual((r.status_code, r.json()["code"]), (409, "no_hod"))
        self.assertFalse(self.mine()["canPlace"])

    def test_hr_chooses_the_date_for_the_employee(self):
        body = self.client.get(HR_URL, {"employeeId": self.emp.id}, **self.admin).json()
        self.assertEqual((body["state"], body["employeeCode"]), ("available", "BDC1"))
        self.assertTrue(next(d for d in body["eligibleDates"] if d["date"] == "2026-03-03")["selectable"])
        r = self.client.post(
            HR_USES,
            {
                "employeeId": self.emp.id,
                "useDate": TUE.isoformat(),
                "portion": "second_half",
                "reason": "Asked at desk",
            },
            content_type="application/json",
            **self.admin,
        )
        self.assertEqual(r.status_code, 201, r.content)
        self.assertEqual((r.json()["requestedBy"], r.json()["reason"]), ("Bdc_Admin", "Asked at desk"))
        note = Notification.objects.filter(employee=self.emp, type="birthday_compensation").first()
        self.assertIsNotNone(note)
        self.assertIn("HR placed your Birthday Compensation", note.message)
        listing = self.client.get(HR_USES, {"status": "waiting_hod"}, **self.admin).json()
        self.assertEqual((listing["total"], listing["summary"]["byStatus"]["pending"]), (1, 1))
        self.assertEqual(listing["summary"]["pendingDays"], 0.5)

    def test_a_view_only_hr_role_reads_but_cannot_place(self):
        view = _hr(_hr_user("bdc_view", {"compensation": "view"}))
        self.assertEqual(self.client.get(HR_URL, {"employeeId": self.emp.id}, **view).status_code, 200)
        r = self.client.post(
            HR_USES,
            {"employeeId": self.emp.id, "useDate": TUE.isoformat(), "portion": "full"},
            content_type="application/json",
            **view,
        )
        self.assertEqual(r.status_code, 403, r.content)


# ═════════════════════════════ D. approval ═════════════════════════════


class ApprovalTests(BirthdayCompBase):
    def setUp(self):
        super().setUp()
        self.punch(TUE)
        self.use = self.placed(TUE)

    def test_the_department_head_then_hr(self):
        # HR cannot go first: the Department Head's step is mandatory
        r = self.hr_decide(self.use)
        self.assertEqual((r.status_code, r.json()["code"]), (400, "not_your_turn"), r.content)
        r = self.hod_decide(self.use)
        self.assertEqual(r.status_code, 200, r.content)
        body = r.json()
        self.assertEqual((body["status"], body["statusKey"]), ("pending", "pending_hr"))
        self.assertEqual(body["approval"]["waitingFor"], ["hr"])
        self.assertEqual(self.stored(TUE).status, "absent")  # nothing changes before HR
        # the employee is told the step (in-app), WhatsApp only at the end
        self.assertTrue(
            Notification.objects.filter(
                employee=self.emp, type="birthday_compensation", source="approval_progress"
            ).exists()
        )
        self.notify_decision.assert_not_called()
        r = self.hr_decide(self.use)
        self.assertEqual(r.status_code, 200, r.content)
        body = r.json()
        self.assertEqual(
            (body["status"], body["hodReviewedBy"], body["hrReviewedBy"]), ("approved", "Comp VFXB", "Bdc_Admin")
        )
        self.notify_decision.assert_called_once()
        self.assertEqual(self.notify_decision.call_args.args[:3], ("birthday_compensation", mock.ANY, "approved"))
        rec = self.stored(TUE)
        self.assertEqual(
            (rec.status, rec.shifts_earned, rec.compensation_kind), ("present", Decimal("1.00"), "birthday_comp")
        )
        self.assertEqual(
            rec.compensation_note, "Birthday compensation (birthday 5 Mar): the whole day paid, no leave balance used"
        )
        self.assertEqual(self.entitlement().used, Decimal("1.00"))

    def test_the_head_rejects_with_a_reason(self):
        r = self.client.patch(
            f"/api/manager/birthday-compensation/{self.use.pk}/status",
            {"status": "rejected"},
            content_type="application/json",
            **self.hod_t,
        )
        self.assertEqual((r.status_code, r.json()["code"]), (400, "remark_required"))
        r = self.hod_decide(self.use, "rejected", "Busy week")
        self.assertEqual(
            (r.status_code, r.json()["status"], r.json()["hodReviewComment"]), (200, "rejected", "Busy week")
        )
        self.notify_decision.assert_called_once()
        r = self.hr_decide(self.use)
        self.assertEqual(r.status_code, 400)  # already decided

    def test_hr_rejects_after_the_head_approved(self):
        self.hod_decide(self.use)
        r = self.hr_decide(self.use, "rejected", "Closing the month")
        self.assertEqual((r.status_code, r.json()["status"]), (200, "rejected"))
        self.assertEqual(self.stored(TUE).status, "absent")
        self.assertEqual(self.entitlement().available, Decimal("1.00"))

    def test_hr_needs_the_approval_right(self):
        self.hod_decide(self.use)
        # the switch set off: refused, even with Edit on the page
        role = Role.objects.create(
            name="bdc_editor", permissions={"compensation": "edit"}, approvals={"birthday_compensation": False}
        )
        user = HRUser.objects.create(username="bdc_editor", password_hash="x", full_name="Ed", role=role)
        r = self.hr_decide(self.use, headers=_hr(user))
        self.assertEqual((r.status_code, r.json().get("code")), (403, "approval_not_permitted"), r.content)
        # View only on the page: refused whatever the switch says (an extra right on top of Edit, never instead of it)
        viewer_role = Role.objects.create(
            name="bdc_viewer", permissions={"compensation": "view"}, approvals={"birthday_compensation": True}
        )
        viewer = HRUser.objects.create(username="bdc_viewer", password_hash="x", full_name="Vi", role=viewer_role)
        self.assertEqual(self.hr_decide(self.use, headers=_hr(viewer)).status_code, 403)
        # a role that never set the new switch keeps "edit = approve" (needs_edit), like every role before it
        role.approvals = {}
        role.save()
        r = self.hr_decide(self.use, headers=_hr(HRUser.objects.get(pk=user.pk)))
        self.assertEqual((r.status_code, r.json()["hrReviewedBy"]), (200, "Ed"), r.content)

    def test_a_day_worked_meanwhile_is_refused_at_approval(self):
        self.hod_decide(self.use)
        self.worked(TUE, time(17, 30))  # punches corrected: Tuesday was worked after all
        r = self.hr_decide(self.use)
        self.assertEqual((r.status_code, r.json()["code"]), (409, "use_refused"), r.content)
        self.assertIn("present", r.json()["error"])

    def test_a_birthday_no_longer_worked_is_refused_at_approval(self):
        self.punch(BIRTHDAY)
        r = self.hod_decide(self.use)
        self.assertEqual((r.status_code, r.json()["code"]), (409, "use_refused"), r.content)
        self.assertIn("no longer shows the birthday", r.json()["error"])

    def test_payroll_done_refuses_the_approval(self):
        self.hod_decide(self.use)
        self.lock_march()
        r = self.hr_decide(self.use)
        self.assertEqual((r.status_code, r.json()["code"]), (409, "use_refused"))
        self.assertIn("Payroll Done", r.json()["error"])
        # a rejection still works
        self.assertEqual(self.hr_decide(self.use, "rejected").status_code, 200)

    def test_the_master_switch_off_refuses_an_approval_but_not_a_rejection(self):
        ps = PayrollSettings.get()
        ps.compensation_feature_enabled = False
        ps.save()
        r = self.hod_decide(self.use)
        self.assertEqual((r.status_code, r.json()["code"]), (409, "use_refused"))
        self.assertEqual(self.hod_decide(self.use, "rejected").status_code, 200)

    def test_a_withdrawn_request_cannot_be_decided(self):
        self.client.delete(f"{EMP_USES}/{self.use.pk}", **self.emp_t)
        r = self.hod_decide(self.use)
        self.assertEqual((r.status_code, r.json()["code"]), (409, "withdrawn"))

    def test_the_head_never_decides_outside_their_scope_and_hr_only_in_its_branch(self):
        stranger = self.new_staff("BDCX", branch=self.u2)
        other_manager = self.manager.__class__.objects.create(employee=stranger)
        r = self.client.patch(
            f"/api/manager/birthday-compensation/{self.use.pk}/status",
            {"status": "approved"},
            content_type="application/json",
            **_emp_token(other_manager.employee),
        )
        self.assertEqual(r.status_code, 403)
        u2_hr = _hr(_hr_user("bdc_u2", {"compensation": "edit"}, branch=self.u2))
        self.hod_decide(self.use)
        self.assertEqual(self.hr_decide(self.use, headers=u2_hr).status_code, 404)
        self.assertEqual(self.client.get(f"{HR_USES}/{self.use.pk}", **u2_hr).status_code, 404)
        self.assertEqual(self.client.get(HR_USES, **u2_hr).json()["total"], 0)
        self.assertEqual(self.client.get(HR_URL, {"employeeId": self.emp.id}, **u2_hr).status_code, 404)


# ═════════════════════════════ E. the engine on the day ═════════════════════════════


class EngineTests(BirthdayCompBase):
    def approved(self, d, portion):
        use = BirthdayCompensationUse.objects.create(
            employee=self.emp,
            birthday=BIRTHDAY,
            use_date=d,
            portion=portion,
            days=rules.PORTION_DAYS[portion],
            status="approved",
            approval_trail=[],
        )
        return use

    def test_a_first_half_on_an_absent_day_pays_half(self):
        self.punch(TUE)
        self.approved(TUE, "first_half")
        rec = self.day(TUE)
        self.assertEqual(
            (rec.status, rec.shifts_earned, rec.compensation_kind), ("half_shift", Decimal("0.50"), "birthday_comp")
        )
        self.assertIn("the first half paid", rec.compensation_note)

    def test_the_missed_half_of_a_half_day_makes_it_a_full_day_and_lifts_its_mark(self):
        self.punch(FRI, time(8, 30), time(13, 0))  # the morning only
        before = self.day(FRI)
        self.assertEqual((before.status, before.shifts_earned), ("half_shift", Decimal("0.50")))
        self.approved(FRI, "second_half")
        rec = self.day(FRI)
        self.assertEqual((rec.status, rec.shifts_earned, rec.early_leave), ("present", Decimal("1.00"), False))
        self.assertIn("the second half paid", rec.compensation_note)

    def test_a_first_half_on_an_evening_half_day_lifts_the_late_mark(self):
        self.punch(MON2, time(14, 0), time(17, 30))
        self.approved(MON2, "first_half")
        rec = self.day(MON2)
        self.assertEqual((rec.status, rec.shifts_earned, rec.is_late), ("present", Decimal("1.00"), False))

    def test_a_future_day_is_paid_when_it_comes(self):
        use = self.placed(MON3)
        self.approve_both(use)
        self.assertFalse(AttendanceDayRecord.objects.filter(employee=self.emp, date=MON3).exists())  # not computed yet
        self.punch(MON3)
        rec = self.day(MON3)  # the day comes, nobody punched
        self.assertEqual(
            (rec.status, rec.shifts_earned, rec.compensation_kind), ("present", Decimal("1.00"), "birthday_comp")
        )

    def test_a_future_first_half_with_a_late_arrival_is_not_late(self):
        self.approved(MON3, "first_half")
        self.punch(MON3, time(9, 40), time(17, 30))  # came in late, worked the afternoon
        rec = self.day(MON3)
        self.assertEqual((rec.status, rec.shifts_earned, rec.is_late), ("present", Decimal("1.00"), False))

    def test_two_halves_on_one_date_pay_the_whole_day(self):
        self.punch(TUE)
        self.approved(TUE, "first_half")
        self.approved(TUE, "second_half")
        rec = self.day(TUE)
        self.assertEqual((rec.status, rec.shifts_earned), ("present", Decimal("1.00")))
        self.assertIn("the whole day paid", rec.compensation_note)

    def test_a_day_hr_fixed_by_hand_is_released_by_the_approval(self):
        self.punch(TUE)
        self.day(TUE)
        AttendanceDayRecord.objects.filter(employee=self.emp, date=TUE).update(
            source="manual", status="absent", override_note="HR: absent"
        )
        use = self.placed(TUE)
        self.approve_both(use)
        rec = self.stored(TUE)
        self.assertEqual((rec.source, rec.status, rec.shifts_earned), ("auto", "present", Decimal("1.00")))

    def test_a_pending_or_rejected_use_pays_nothing(self):
        self.punch(TUE)
        use = self.placed(TUE)
        self.assertEqual(self.day(TUE).status, "absent")
        use.status = "rejected"
        use.save()
        self.assertEqual(self.day(TUE).status, "absent")

    def test_a_production_worker_is_never_touched(self):
        from . import compensation_engine as comp

        prod = self.new_staff("BDCP2", employment_type="production")
        context = comp.CompContext(master=True, birthday_uses={(prod.pk, TUE): object()})
        self.assertIsNone(comp.birthday_use_on(prod, TUE, context))


# ═════════════════════════════ F. one benefit per birthday ═════════════════════════════


class OneBenefitTests(BirthdayCompBase):
    def test_an_approved_use_keeps_an_unworked_birthday_from_also_becoming_paid_leave(self):
        self.punch(TUE)
        self.approve_both(self.placed(TUE))
        self.punch(BIRTHDAY)  # the birthday's punches corrected away afterwards
        rec = self.day(BIRTHDAY)
        self.assertNotEqual(rec.compensation_kind, "birthday")
        self.assertEqual(rec.status, "absent")
        ent = self.entitlement()
        self.assertEqual((ent.state, ent.used, ent.can_place), ("placed", Decimal("1.00"), False))

    def test_an_old_credit_claim_is_kept_and_nothing_can_be_placed(self):
        claim = HolidayWorkClaim.objects.create(
            employee=self.emp,
            kind="birthday",
            work_date=BIRTHDAY,
            shifts=Decimal("1.00"),
            status="pending",
            raised_by_role="employee",
            approval_trail=[],
        )
        ent = self.entitlement()
        self.assertEqual((ent.state, ent.can_place), ("credit_claim", False))
        r = self.place(MON3)
        self.assertEqual((r.status_code, r.json()["code"]), (409, "credit_claimed"))
        # the old claim is still decided (and credited) as before
        status, body = self.hod(claim.pk)
        self.assertEqual((status, body["status"]), (200, "approved"), body)
        self.assertTrue(CompensationLedger.objects.filter(claim=claim, entry_type="credit").exists())
        self.assertEqual(self.mine()["state"], "credit_claim")

    def test_a_new_birthday_credit_claim_is_refused_with_a_pointer_to_the_date(self):
        r = self.raise_({"kind": "birthday", "date": BIRTHDAY.isoformat()})
        self.assertEqual((r.status_code, r.json()["code"]), (400, "use_birthday_compensation"), r.content)
        self.assertIn("Birthday Compensation", r.json()["error"])
        self.assertFalse(HolidayWorkClaim.objects.filter(kind="birthday").exists())

    def test_a_rejected_old_credit_claim_lets_the_compensation_be_placed(self):
        HolidayWorkClaim.objects.create(
            employee=self.emp,
            kind="birthday",
            work_date=BIRTHDAY,
            shifts=Decimal("1.00"),
            status="rejected",
            raised_by_role="employee",
            approval_trail=[],
        )
        self.assertEqual(self.entitlement().state, "available")

    def test_casual_leave_on_an_unworked_birthday_with_an_approved_use_is_not_free(self):
        from . import cl_balance

        self.punch(TUE)
        self.approve_both(self.placed(TUE))
        self.punch(BIRTHDAY)
        free = cl_balance.new_rule_birthdays([(self.emp.pk, self.emp.date_of_birth, "staff", BIRTHDAY)])
        self.assertEqual(free, set())


# ═════════════════════════════ G. the surfaces ═════════════════════════════


class SurfaceTests(BirthdayCompBase):
    def setUp(self):
        super().setUp()
        self.punch(TUE)
        self.use = self.placed(TUE, "first_half")

    def test_the_head_is_told_and_lists_it_with_a_count(self):
        note = Notification.objects.filter(employee=self.boss, type="birthday_compensation").first()
        self.assertIsNotNone(note)
        self.assertIn("waiting for your approval", note.message)
        me = self.client.get("/api/manager/me", **self.hod_t).json()
        self.assertEqual((me["pendingBirthdayCompensationCount"], me["pendingApprovalsCount"]), (1, 1))
        pending = self.client.get("/api/manager/pending-requests", **self.hod_t).json()
        self.assertEqual([u["id"] for u in pending["birthdayCompensationUses"]], [self.use.pk])
        self.assertEqual(pending["totalPending"], 1)
        row = pending["birthdayCompensationUses"][0]
        self.assertEqual((row["portion"], row["days"], row["approval"]["canAct"]["hod"]), ("first_half", 0.5, True))
        # after the head's approval it waits for HR: no longer in the head's pending list
        self.hod_decide(self.use)
        self.assertEqual(
            self.client.get("/api/manager/pending-requests", **self.hod_t).json()["birthdayCompensationUses"], []
        )

    def test_the_mobile_approvals_history(self):
        summary = self.client.get("/api/manager/requests/summary", **self.hod_t).json()
        cat = next(c for c in summary["categories"] if c["key"] == "birthday_compensation")
        self.assertEqual((cat["pending"], cat["approved"]), (1, 0))
        self.hod_decide(self.use)
        listed = self.client.get(
            "/api/manager/requests", {"category": "birthdayCompensation", "status": "approved"}, **self.hod_t
        ).json()
        self.assertEqual([i["id"] for i in listed["items"]], [self.use.pk])
        self.assertEqual(listed["items"][0]["outcome"]["state"], "in_progress")

    def test_the_md_portal_decides_at_the_heads_step(self):
        from .md_portal import hod_approvals

        raw = hod_approvals.requests_payload(self.manager, "pending")
        item = next(i for i in raw["items"] if i["kind"] == "birthday_compensation")
        self.assertEqual((item["id"], item["canApprove"], item["from"]), (self.use.pk, True, "2026-03-03"))
        self.assertEqual(item["requested"]["label"], "Placed on")
        response = hod_approvals.deciders()["birthday_compensation"](
            self.manager, self.use.pk, "approved", None, "Md (MD, for VFXB)", None
        )
        self.assertEqual(response.status_code, 200, response.data)
        self.use.refresh_from_db()
        self.assertEqual((self.use.status, self.use.hod_reviewed_by), ("pending", "Md (MD, for VFXB)"))

    def test_the_requests_hub_lists_it_by_the_day_it_is_placed_on_and_hr_decides_it(self):
        body = self.client.get(
            "/api/hr-requests",
            {"kind": "birthday_compensation", "from": "2026-03-03", "to": "2026-03-03"},
            **self.admin,
        ).json()
        kind = next(k for k in body["kinds"] if k["key"] == "birthday_compensation")
        self.assertEqual((kind["mode"], kind["waitingHod"], kind["canApprove"]), ("quick", 1, True))
        self.assertEqual([i["id"] for i in body["items"]], [self.use.pk])
        self.assertEqual(body["items"][0]["queue"], "hod")
        other_day = self.client.get(
            "/api/hr-requests",
            {"kind": "birthday_compensation", "from": "2026-03-04", "to": "2026-03-04"},
            **self.admin,
        ).json()
        self.assertEqual(other_day["items"], [])
        self.hod_decide(self.use)
        body = self.client.get("/api/hr-requests", {"kind": "birthday_compensation"}, **self.admin).json()
        self.assertEqual(body["items"][0]["queue"], "hr")
        self.assertEqual(self.hr_decide(self.use).status_code, 200)
        body = self.client.get("/api/hr-requests", {"kind": "birthday_compensation"}, **self.admin).json()
        self.assertEqual((body["items"][0]["status"], body["items"][0]["decided"]["role"]), ("approved", "hr"))
        # a withdrawn one is not listed
        other = self.placed(TUE, "second_half")
        self.client.delete(f"{EMP_USES}/{other.pk}", **self.emp_t)
        body = self.client.get("/api/hr-requests", {"kind": "birthday_compensation"}, **self.admin).json()
        self.assertEqual([i["id"] for i in body["items"]], [self.use.pk])

    def test_the_hods_tab_of_the_requests_page(self):
        from . import hod_pending

        found = hod_pending.collect([self.manager])[self.manager.id]
        self.assertEqual([u.pk for u in found.items["birthday_compensation"]], [self.use.pk])
        row = hod_pending.item_json(
            next(c for c in hod_pending.CATEGORIES if c.key == "birthday_compensation"), self.use, TODAY
        )
        self.assertEqual(
            (row["forText"], row["summary"]), ("03 Mar 2026", "Birthday Compensation · first half (birthday 5 Mar)")
        )

    def test_the_hr_birthdays_list_says_what_the_birthday_gives_now(self):
        body = self.client.get(
            "/api/compensation/birthdays", {"period": "month", "date": "2026-03-05"}, **self.admin
        ).json()
        row = next(r for r in body["results"] if r["employeeCode"] == "BDC1")
        self.assertEqual((row["outcome"], row["claimable"], row["canPlace"]), ("comp_to_place", False, True))
        block = row["birthdayCompensation"]
        self.assertEqual((block["state"], block["held"], block["available"]), ("available", 0.5, 0.5))
        self.assertEqual([u["id"] for u in block["uses"]], [self.use.pk])
        self.assertEqual(body["outcomeCounts"]["comp_to_place"], 1)
        # an unworked birthday is still the automatic paid leave
        other = self.new_staff("BDCN", department=self.dept, branch=self.ho, date_of_birth=date(1990, 3, 5))
        self.punch(BIRTHDAY, emp=other)
        body = self.client.get(
            "/api/compensation/birthdays", {"period": "month", "date": "2026-03-05"}, **self.admin
        ).json()
        row = next(r for r in body["results"] if r["employeeCode"] == "BDCN")
        self.assertEqual((row["outcome"], row["birthdayCompensation"]["state"]), ("paid_leave", None))

    def test_the_employee_compensation_page_shows_it(self):
        body = self.client.get("/api/employee/compensation", **self.emp_t).json()
        item = next(i for i in body["items"] if i["kind"] == "birthday_compensation")
        self.assertEqual((item["status"], item["claimable"], item["canPlace"]), ("available", False, True))
        self.assertEqual(item["birthdayCompensation"]["held"], 0.5)

    def test_the_45_day_automatic_rejection(self):
        from .request_auto_reject import service as auto

        BirthdayCompensationUse.objects.filter(pk=self.use.pk).update(
            created_at=timezone.make_aware(timezone.datetime(2026, 1, 10, 12, 0)) - timedelta(days=0)
        )
        with mock.patch("api.request_auto_reject.service.ist_today", return_value=TODAY):
            summary = auto.run(today=TODAY)
        self.assertEqual(summary["byKind"].get("birthday_compensation"), 1, summary)
        self.use.refresh_from_db()
        self.assertEqual((self.use.status, self.use.hr_reviewed_by), ("rejected", "Automatic rejection"))
        self.assertTrue(self.use.approval_trail[-1]["auto"])
        self.notify_decision.assert_not_called()  # no WhatsApp: the phone only
        self.assertTrue(Notification.objects.filter(employee=self.emp, related_module="birthday_compensation").exists())
        self.assertEqual(self.entitlement().available, Decimal("1.00"))

    def test_the_punch_based_daily_list_shows_the_paid_day(self):
        # the second half of the same Tuesday too: the whole day is Birthday Compensation, no punch at all
        other = self.placed(TUE, "second_half")
        self.approve_both(self.use)
        self.approve_both(other)
        rows = {
            r["employeeCode"]: r
            for r in self.client.get("/api/attendance/daily", {"date": "2026-03-03"}, **self.admin).json()
        }
        row = rows["BDC1"]
        # a paid day with no punch reads like a paid birthday leave there (not Absent), with its marker and note
        self.assertEqual(
            (row["status"], row["compensationKind"], row["totalPunches"]), ("on_leave", "birthday_comp", 0)
        )
        self.assertIn("Birthday compensation", row["compensationNote"])

    def test_the_workflow_is_fixed_hod_then_hr(self):
        cfg = approval.get_config("birthday_compensation")
        self.assertEqual([s.roles for s in cfg.steps], [("hod",), ("hr",)])
        self.assertFalse(approval.definition("birthday_compensation").editable)
        r = self.client.put(
            "/api/approval-workflows/birthday_compensation",
            {"steps": [{"roles": ["hr"]}]},
            content_type="application/json",
            **self.admin,
        )
        self.assertEqual(r.status_code, 400)

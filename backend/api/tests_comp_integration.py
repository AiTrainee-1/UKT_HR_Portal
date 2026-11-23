"""
Compensation claims integration fixes (2026-11-19): the regressions found when the claim workflow was put together.

  * bad ids are a 400 on every claims endpoint (never a misleading 404);
  * the HOD decision's audit line says what happened to the balance for every claim kind;
  * a casual leave on a new-rule birthday uses no CL balance (cl_balance);
  * the staff next-morning rule has an early-arrival guard (shift_engine);
  * today's birthday is judged normally until the day is over (attendance_final);
  * the employee-facing birthday texts describe the new rule (employee_compensation_views, mobile_pay_compensation).

Run via: python manage.py test api.tests_comp_integration
"""

from __future__ import annotations

from datetime import date, datetime, time
from decimal import Decimal
from unittest import mock

from django.test import TestCase

from . import cl_balance
from . import compensation_effects as effects
from . import tests_compensation_claims_engine as engine
from .models import (
    AuditLog,
    Branch,
    CasualLeaveRequest,
    CompensationConfig,
    CompensationLedger,
    Department,
    Employee,
    Holiday,
    HolidayWorkClaim,
    PayrollSettings,
)
from .clock import FACTORY_TZ
from .employee_compensation_views import BIRTHDAY_PAID_TEXT, BIRTHDAY_RULE_TEXT, BIRTHDAY_TODAY_TEXT
from .shift_engine import staff_next_morning_day_cutoff_secs
from .tests_compensation_claims import (
    OT_ALLOW_DAY,
    OT_SHIFT_DAY,
    SUNDAY,
    USE_DAY,
    ClaimsBase,
)

HUGE = "99999999999999999999999"


# ═════════════════════════════ bad ids are a 400 everywhere ═════════════════════════════


class BadIdTests(ClaimsBase):
    def test_list_filters_refuse_an_id_the_database_cannot_hold(self):
        for path in ("/api/compensation/claims", "/api/compensation/ledger", "/api/compensation/balance"):
            for name in ("departmentId", "branchId"):
                for bad in ("abc", "1.5", HUGE, "-3"):
                    r = self.get(path, **{name: bad})
                    self.assertEqual(r.status_code, 400, (path, name, bad))
        for bad in ("abc", HUGE, "0"):
            r = self.get("/api/compensation/balance", employeeId=bad)
            self.assertEqual(r.status_code, 400, bad)
            r = self.get("/api/compensation/claims", employeeId=bad)
            self.assertEqual(r.status_code, 400, bad)

    def test_hr_raise_refuses_bad_employee_and_record_ids(self):
        for item in (
            {"employeeId": HUGE},
            {"employeeId": 1e300},
            {"employeeId": [self.asha.id]},
            {"employeeId": self.asha.id, "overtimeRecordId": HUGE},
            {"employeeId": self.asha.id, "overtimeRecordId": 2.5},
        ):
            r = self.hr_claim({"kind": "ot_shift", "date": OT_SHIFT_DAY.isoformat(), "reason": "x", "items": [item]})
            self.assertEqual(r.status_code, 400, item)
        self.assertFalse(HolidayWorkClaim.objects.exists())

    def test_hr_use_refuses_a_bad_employee_id(self):
        for bad in (HUGE, "abc", True, 0):
            r = self.hr_use({"employeeId": bad, "date": USE_DAY.isoformat(), "shifts": 0.5, "reason": "x"})
            self.assertEqual(r.status_code, 400, bad)

    def test_employee_claim_refuses_a_bad_overtime_record_id(self):
        r = self.emp_claim({"kind": "ot_shift", "date": OT_SHIFT_DAY.isoformat(), "overtimeRecordId": HUGE})
        self.assertEqual(r.status_code, 400)
        self.assertFalse(HolidayWorkClaim.objects.exists())


# ═════════════════════════════ the HOD decision's audit line ═════════════════════════════


class HodAuditTextTests(ClaimsBase):
    def _log(self, claim):
        return AuditLog.objects.filter(module="compensation", record_id=claim.id).latest("id")

    def test_credit_kinds_say_added_to_the_compensation_balance(self):
        claim = self.made(
            self.emp_claim(
                {"kind": "ot_shift", "date": OT_SHIFT_DAY.isoformat(), "overtimeRecordId": self.shift_rec.id}
            )
        )
        self.assertEqual(self.decide(claim.id).status_code, 200)
        text = self._log(claim).record_description
        self.assertIn("0.75 shift added to the compensation balance", text)
        self.assertIn("(credit)", text)

    def test_a_use_request_says_taken_from_the_balance(self):
        self.credit(self.asha)
        claim = self.made(self.emp_use({"date": USE_DAY.isoformat(), "shifts": 0.5, "reason": "x"}))
        self.assertEqual(self.decide(claim.id).status_code, 200)
        text = self._log(claim).record_description
        self.assertIn("0.50 shift taken from the compensation balance", text)
        self.assertIn("(debit)", text)
        self.assertNotIn("added to", text)

    def test_an_allowance_names_its_minutes_and_no_shift(self):
        claim = self.made(
            self.emp_claim(
                {"kind": "ot_allowance", "date": OT_ALLOW_DAY.isoformat(), "overtimeRecordId": self.allow_rec.id}
            )
        )
        self.assertEqual(self.decide(claim.id).status_code, 200)
        text = self._log(claim).record_description
        self.assertIn("30 min late-in allowance for the next working day", text)
        self.assertNotIn("shift", text.split(" of ")[-1])

    def test_a_rejection_adds_nothing(self):
        claim = self.made(
            self.emp_claim(
                {"kind": "ot_shift", "date": OT_SHIFT_DAY.isoformat(), "overtimeRecordId": self.shift_rec.id}
            )
        )
        self.assertEqual(self.decide(claim.id, "rejected", comment="Not needed").status_code, 200)
        text = self._log(claim).record_description
        self.assertIn("rejected", text)
        self.assertNotIn("added to the compensation balance", text)


# ═════════════════════════════ a Casual Leave on a new-rule birthday uses no balance ═════════════════════════════


class CasualLeaveOnBirthdayTests(TestCase):
    """cl_balance counts Casual Leave from the CasualLeaveRequest rows: one dated on a NEW-rule birthday (on/after
    claims_from, birthday on, staff, not an off day) is a paid birthday leave, so it is listed but never counted."""

    BIRTHDAY = date(2026, 11, 20)  # a Friday, after the CL cut-over (2026-11-02)
    OTHER = date(2026, 11, 24)  # a Tuesday

    def setUp(self):
        from .attendance_final import _holiday_dates_for_month

        _holiday_dates_for_month.cache_clear()  # cached per month across tests
        # these tests follow the 12-days-a-year policy (Settings -> Casual Leave, allocation yearly)
        from .models import CasualLeavePolicy

        CasualLeavePolicy.objects.update_or_create(pk=1, defaults={"allocation": "yearly"})
        self.addCleanup(_holiday_dates_for_month.cache_clear)
        settings = PayrollSettings.get()
        settings.compensation_feature_enabled = True
        settings.cl_balance_since = date(2026, 11, 2)
        settings.save()
        CompensationConfig.objects.update_or_create(
            pk=1, defaults={"birthday_enabled": True, "birthday_effective_from": None, "claims_from": date(2026, 11, 1)}
        )
        branch = Branch.objects.create(name="CLB Head Office", code="CLBHO", is_head_office=True)
        dept = Department.objects.create(name="CLB Cutting", branch=branch)
        self.emp = Employee.objects.create(
            employee_code="CLB1",
            first_name="Bday",
            last_name="Cl",
            employment_type="staff",
            status="active",
            branch=branch,
            department=dept,
            date_of_birth=date(1991, 11, 20),
        )
        self.prod = Employee.objects.create(
            employee_code="CLB2",
            first_name="Prod",
            last_name="Cl",
            employment_type="production",
            status="active",
            branch=branch,
            department=dept,
            date_of_birth=date(1991, 11, 20),
        )

    def cl(self, emp, day, portion="full", status="approved"):
        return CasualLeaveRequest.objects.create(employee=emp, date=day, portion=portion, status=status)

    def remaining(self, emp=None):
        return cl_balance.balance(emp or self.emp, 2026)["remaining"]

    def test_a_full_day_casual_leave_on_the_birthday_uses_no_balance(self):
        self.cl(self.emp, self.BIRTHDAY)
        self.cl(self.emp, self.OTHER, portion="first_half", status="pending")
        block = cl_balance.balance(self.emp, 2026)
        self.assertEqual((block["used"], block["pending"], block["remaining"]), (0, 0.5, 11.5))
        held = cl_balance.parts([self.emp.id], self.BIRTHDAY, self.BIRTHDAY)[self.emp.id]
        self.assertEqual([(p.birthday, p.counts(date(2026, 11, 2))) for p in held], [(True, False)])
        self.assertTrue(held[0].to_json()["birthday"])
        # the Casual Leave request itself is untouched
        self.assertEqual(CasualLeaveRequest.objects.get(date=self.BIRTHDAY).status, "approved")

    def test_a_half_day_casual_leave_on_the_birthday_uses_no_balance_either(self):
        self.cl(self.emp, self.BIRTHDAY, portion="second_half", status="pending")
        self.assertEqual(self.remaining(), 12)
        november = cl_balance.month_usage(self.emp, 2026)[10]
        self.assertEqual((november["used"], november["pending"], november["beforeCutOver"]), (0, 0, 0))
        self.assertEqual([(p["birthday"], p["counted"]) for p in november["parts"]], [(True, False)])

    def test_the_history_lists_it_without_taking_a_day(self):
        self.cl(self.emp, self.BIRTHDAY)
        story = cl_balance.history(self.emp, 2026, today=date(2026, 11, 25))
        line = story["entries"][-1]
        self.assertEqual((line["change"], line["balanceAfter"], line["birthday"]), (0, 12, True))
        self.assertIn("paid birthday leave, no balance used", line["text"])

    def test_old_rule_birthdays_switch_off_and_production_still_count(self):
        self.cl(self.emp, self.BIRTHDAY)
        self.cl(self.prod, self.BIRTHDAY)
        self.assertEqual(self.remaining(self.prod), 11)  # production: no birthday benefit
        CompensationConfig.objects.filter(pk=1).update(claims_from=date(2026, 11, 21))  # the birthday is old-rule
        self.assertEqual(self.remaining(), 11)
        CompensationConfig.objects.filter(pk=1).update(claims_from=date(2026, 11, 1), birthday_enabled=False)
        self.assertEqual(self.remaining(), 11)
        CompensationConfig.objects.filter(pk=1).update(birthday_enabled=True)
        PayrollSettings.objects.update(compensation_feature_enabled=False)
        self.assertEqual(self.remaining(), 11)

    def test_a_birthday_on_a_holiday_still_counts(self):
        from .attendance_final import _holiday_dates_for_month

        Holiday.objects.create(name="Local festival", date=self.BIRTHDAY)
        _holiday_dates_for_month.cache_clear()
        self.cl(self.emp, self.BIRTHDAY)
        self.assertEqual(self.remaining(), 11)

    def test_no_extra_query_without_a_birthday(self):
        self.cl(self.emp, self.OTHER)
        with self.assertNumQueries(2):
            cl_balance.parts([self.emp.id], date(2026, 11, 1), date(2026, 11, 30))


# ═════════════════════════════ the staff next-morning early-arrival guard ═════════════════════════════


class NextMorningArrivalGuardTests(engine.ClaimsEngineBase):
    """shift_engine: the cut-off for a working day D+1 is the earlier of staff_next_morning_cutoff and D+1's shift start
    minus first_punch_pre_shift_buffer_hours (2 h by default)."""

    CODE = "CIG1"

    def setUp(self):
        super().setUp()
        self.early = engine.base.make_shift(
            name="Early 06:00", start_time=time(6, 0), end_time=time(15, 0), first_half_end=time(10, 30)
        )
        self.dawn = self.new_staff("CIG2", shift=self.early)

    def test_the_day_cutoff_helper(self):
        ps = PayrollSettings.get()
        self.assertEqual(staff_next_morning_day_cutoff_secs(ps, self.shift), 6 * 3600)  # 08:30 - 2 h: 06:00 stands
        self.assertEqual(staff_next_morning_day_cutoff_secs(ps, self.early), 4 * 3600)  # 06:00 - 2 h = 04:00
        self.assertEqual(staff_next_morning_day_cutoff_secs(ps, self.early, next_day_off=True), 6 * 3600)
        self.assertEqual(staff_next_morning_day_cutoff_secs(ps, None), 6 * 3600)
        self.settings(first_punch_pre_shift_buffer_hours=Decimal("7"))
        self.assertEqual(staff_next_morning_day_cutoff_secs(PayrollSettings.get(), self.early), 0)

    def test_an_0830_shift_keeps_0600(self):
        self.log(engine.MON, time(8, 30), time(13, 0), time(14, 0))  # open
        self.log(engine.TUE, time(5, 45), time(8, 30), time(17, 30))
        self.assertEqual(self.rec(engine.MON).last_punch, time(5, 45))
        self.assertEqual(self.rec(engine.TUE).first_punch, time(8, 30))

    def test_a_0600_shift_gets_0400_so_an_early_arrival_stays_the_days_own(self):
        self.log(engine.MON, time(6, 0), time(10, 30), time(11, 30), emp=self.dawn)  # open (forgot the exit)
        self.log(engine.TUE, time(5, 15), time(10, 30), time(11, 30), time(15, 0), emp=self.dawn)
        mon = self.rec(engine.MON, emp=self.dawn)
        self.assertEqual(mon.last_punch, time(11, 30))
        tue = self.rec(engine.TUE, emp=self.dawn)
        self.assertEqual((tue.first_punch, tue.last_punch), (time(5, 15), time(15, 0)))
        self.assertFalse(tue.is_late)

    def test_a_0600_shift_still_closes_the_night_before_0400(self):
        self.log(engine.MON, time(6, 0), time(10, 30), time(11, 30), emp=self.dawn)
        self.log(engine.TUE, time(3, 30), time(5, 55), time(10, 30), time(11, 30), time(15, 0), emp=self.dawn)
        self.assertEqual(self.rec(engine.MON, emp=self.dawn).last_punch, time(3, 30))
        self.assertEqual(self.rec(engine.TUE, emp=self.dawn).first_punch, time(5, 55))

    def test_an_off_day_expects_no_arrival(self):
        # Saturday open, Sunday 05:15: Sunday is an off day, so the plain 06:00 cut-off closes Saturday
        self.log(engine.SAT, time(6, 0), time(10, 30), time(11, 30), emp=self.dawn)
        self.log(engine.SUN, time(5, 15), emp=self.dawn)
        self.assertEqual(self.rec(engine.SAT, emp=self.dawn).last_punch, time(5, 15))

    def test_days_before_the_from_date_keep_the_old_rule(self):
        # old grace rule: 15:00 + 12 h = 03:00 (capped at 06:00 - 2 h = 04:00); the pair (MON, TUE) is before the
        # from-date, so Tuesday's 03:30 stays Tuesday's although the new rule (04:00) would have closed Monday with it
        self.settings(staff_next_morning_from=engine.WED, last_punch_post_shift_grace_hours=Decimal("12"))
        self.log(engine.MON, time(6, 0), time(10, 30), time(11, 30), emp=self.dawn)
        self.log(engine.TUE, time(3, 30), time(10, 30), time(11, 30), time(15, 0), emp=self.dawn)
        self.log(engine.WED, time(6, 0), time(10, 30), time(11, 30), emp=self.dawn)
        self.log(engine.THU, time(3, 30), time(10, 30), time(11, 30), time(15, 0), emp=self.dawn)
        self.assertEqual(self.rec(engine.MON, emp=self.dawn).last_punch, time(11, 30))
        self.assertEqual(self.rec(engine.TUE, emp=self.dawn).first_punch, time(3, 30))
        self.assertEqual(self.rec(engine.WED, emp=self.dawn).last_punch, time(3, 30))
        self.assertEqual(self.rec(engine.THU, emp=self.dawn).first_punch, time(10, 30))


class NextMorningArrivalGuardStrictTests(NextMorningArrivalGuardTests):
    MODE = "strict"


# ═════════════════════════════ today's birthday is judged normally until it is over ═════════════════════════════


class TodaysBirthdayTests(engine.ClaimsEngineBase):
    """attendance_final: a new-rule birthday with no punch becomes paid birthday leave only once the day is over (before
    today, IST). Today it is a normal day stored as provisional until midnight, so attendance_refresh.refresh_provisional
    relabels it the next day (recompute_stale_days never would: an absent day has no punch to make it stale)."""

    CODE = "CIB1"

    def setUp(self):
        super().setUp()
        self.on(birthday_enabled=True)
        self.emp.date_of_birth = date(1990, 3, 5)  # Thursday 5 March 2026
        self.emp.save()

    def on_day(self, today):
        patches = [
            mock.patch("api.attendance_final.ist_today", return_value=today),
            mock.patch("api.clock.ist_today", return_value=today),  # compensation_effects imports it lazily
        ]
        for p in patches:
            p.start()
            self.addCleanup(p.stop)
        return patches

    def stop(self, patches):
        for p in patches:
            p.stop()

    def test_today_with_no_punch_is_not_paid_leave_yet(self):
        self.on_day(engine.THU)
        r = self.rec(engine.THU)
        self.assertEqual((r.status, r.shifts_earned, r.compensation_kind), ("absent", Decimal("0.00"), ""))
        self.assertEqual(r.provisional_until, datetime(2026, 3, 6, tzinfo=FACTORY_TZ))
        out = effects.birthday_outcome(self.emp, engine.THU)
        self.assertEqual((out["outcome"], out["claimable"]), (effects.BIRTHDAY_UPCOMING, False))
        self.assertIn("no punch yet", out["message"])

    def test_the_refresh_relabels_it_the_next_day(self):
        patches = self.on_day(engine.THU)
        self.rec(engine.THU)
        self.stop(patches)
        self.on_day(engine.FRI)
        from .attendance_refresh import refresh_provisional
        from .overtime import recompute_stale_days

        # the stale-punch pass does not see it (no punch at all) ...
        self.assertEqual(recompute_stale_days(engine.THU, engine.FRI), 0)
        self.assertEqual(self.stored(engine.THU).compensation_kind, "")
        # ... the provisional pass does (its moment, midnight, has passed)
        self.assertEqual(refresh_provisional(), 1)
        r = self.stored(engine.THU)
        self.assertEqual((r.status, r.shifts_earned, r.compensation_kind), ("present", Decimal("1.00"), "birthday"))
        self.assertIsNone(r.provisional_until)
        self.assertEqual(effects.birthday_outcome(self.emp, engine.THU)["outcome"], effects.BIRTHDAY_PAID_LEAVE)

    def test_a_punch_later_today_makes_it_a_worked_birthday(self):
        self.on_day(engine.THU)
        self.rec(engine.THU)
        self.worked(engine.THU, time(17, 30))
        r = self.rec(engine.THU)
        self.assertEqual((r.status, r.compensation_kind), ("present", ""))
        self.assertEqual(effects.birthday_outcome(self.emp, engine.THU)["outcome"], "credit_claimable")

    def test_a_past_birthday_is_still_paid_leave(self):
        self.on_day(engine.FRI)
        r = self.rec(engine.THU)
        self.assertEqual((r.status, r.compensation_kind), ("present", "birthday"))
        self.assertIsNone(r.provisional_until)


# ═════════════════════════════ the employee-facing birthday texts ═════════════════════════════


class EmployeeBirthdayTextTests(TodaysBirthdayTests):
    """GET /api/employee/compensation (_birthday_items) and the mobile year history (mobile_pay_compensation) describe the
    new rule for a birthday on/after claims_from; older birthdays keep the automatic wording; kinds and keys unchanged."""

    CODE = "CIT1"

    def on_day(self, today):
        patches = super().on_day(today)
        for target in ("api.compensation_claims.ist_today", "api.employee_compensation_views.ist_today"):
            p = mock.patch(target, return_value=today)
            p.start()
            self.addCleanup(p.stop)
            patches.append(p)
        return patches

    def birthday_item(self, today):
        from .compensation_shared import holiday_names, switches
        from .employee_compensation_views import _birthday_items
        from .models import CompensationConfig, EmployeeShiftAssignment

        self.on_day(today)
        items = _birthday_items(
            self.emp,
            today,
            lambda d: holiday_names(d, d),
            CompensationConfig.get(),
            switches()["master"],
            list(EmployeeShiftAssignment.objects.filter(employee=self.emp)),
        )
        return next(i for i in items if i["key"] == "bd-2026-03-05")

    def history_item(self, today):
        from .mobile_pay_compensation import history_for

        self.on_day(today)
        return next(i for i in history_for(self.emp, 2026, today)["items"] if i["key"] == "bd-2026-03-05")

    def test_an_upcoming_birthday_explains_the_rule(self):
        item = self.birthday_item(engine.WED)
        self.assertEqual((item["kind"], item["status"]), ("birthday", "upcoming"))
        self.assertEqual(item["detail"], BIRTHDAY_RULE_TEXT)
        self.assertNotIn("whether you come", item["detail"])
        self.assertEqual(item["title"], "Birthday: a normal working day")

    def test_today_says_it_is_decided_when_the_day_is_over(self):
        item = self.birthday_item(engine.THU)
        self.assertEqual((item["kind"], item["status"]), ("birthday", "today"))
        self.assertEqual(item["detail"], BIRTHDAY_TODAY_TEXT)

    def test_an_absent_birthday_is_paid_birthday_leave(self):
        item = self.birthday_item(engine.FRI)
        self.assertEqual(
            (item["kind"], item["status"], item["title"]), ("birthday", "applied", "Birthday leave (paid)")
        )
        self.assertEqual(item["detail"], BIRTHDAY_PAID_TEXT)

    def test_an_older_birthday_keeps_the_automatic_wording(self):
        engine.base.set_config(claims_from=engine.FRI)
        item = self.birthday_item(engine.WED)
        self.assertEqual((item["kind"], item["status"]), ("birthday", "upcoming"))
        self.assertIn("whether you come to work or not", item["detail"])
        self.assertEqual(self.history_item(engine.WED)["sourceLabel"], "Automatic")

    def test_the_history_chip_says_what_decided_it(self):
        item = self.history_item(engine.FRI)
        self.assertEqual((item["kind"], item["source"], item["givenByHr"]), ("birthday", "automatic", False))
        self.assertEqual(item["sourceLabel"], "Automatic: not at work on your birthday")
        self.assertEqual(self.history_item(engine.WED)["sourceLabel"], "Decided by your attendance on the day")

    def test_a_worked_birthday_with_a_claim(self):
        self.worked(engine.THU, time(17, 30))
        self.rec(engine.THU)
        self.claim("birthday", engine.THU, status="pending", shifts="1.00")
        item = self.history_item(engine.FRI)
        self.assertEqual((item["kind"], item["source"]), ("birthday_credit", "automatic"))
        self.assertEqual(item["sourceLabel"], "Claimed: waiting for your Department Head")
        self.assertEqual(item["claim"]["status"], "pending")

    # the inherited attendance tests are not repeated here
    test_today_with_no_punch_is_not_paid_leave_yet = None
    test_the_refresh_relabels_it_the_next_day = None
    test_a_punch_later_today_makes_it_a_worked_birthday = None
    test_a_past_birthday_is_still_paid_leave = None


# ═════════════════════════════ contract additions found by the cross-check ═════════════════════════════


class SummaryKeyTests(ClaimsBase):
    """Additive keys the HR tiles read: claims summary.creditedShifts, balance summary.withBalance, ledger
    summary.countedDebitShifts (the old keys keep their meaning)."""

    def approved(self, emp, kind, day, shifts):
        return HolidayWorkClaim.objects.create(
            employee=emp, kind=kind, work_date=day, shifts=Decimal(shifts), status="approved", raised_by_role="hr"
        )

    def test_claims_summary_credited_shifts_leaves_out_use_requests(self):
        self.approved(self.asha, "holiday_work", SUNDAY, "1.00")
        self.approved(self.ravi, "use_balance", USE_DAY, "0.50")
        summary = self.get("/api/compensation/claims").json()["summary"]
        self.assertEqual((summary["approvedShifts"], summary["creditedShifts"]), (1.5, 1.0))

    def test_balance_summary_with_balance_counts_only_shifts_left(self):
        self.credit(self.asha)
        self.credit(self.ravi, "0.50")
        CompensationLedger.objects.create(
            employee=self.ravi, entry_type="debit", shifts=Decimal("0.50"), date=USE_DAY, source="redemption"
        )
        summary = self.get("/api/compensation/balance").json()["summary"]
        self.assertEqual((summary["employees"], summary["withBalance"]), (2, 1))

    def test_ledger_summary_counted_debits_skip_legacy_mirrors(self):
        self.credit(self.asha)
        for source, shifts in (("legacy_credit", "1.00"), ("redemption", "0.50")):
            CompensationLedger.objects.create(
                employee=self.asha, entry_type="debit", shifts=Decimal(shifts), date=USE_DAY, source=source
            )
        summary = self.get("/api/compensation/ledger").json()["summary"]
        self.assertEqual((summary["debitShifts"], summary["countedDebitShifts"]), (1.5, 0.5))


class HistorySourceTests(TestCase):
    """mobile_pay_compensation._tag: what HR did not give is not labelled "Given by HR"."""

    def tag(self, **item):
        from .mobile_pay_compensation import _tag

        return _tag({"date": "2026-10-11", "status": "claimable", **item}, CompensationConfig.get())

    def test_a_worked_sunday_still_to_claim_is_detected(self):
        out = self.tag(kind="holiday_work", key="hwd-2026-10-11", claim=None)
        self.assertEqual((out["source"], out["givenByHr"]), ("automatic", False))
        self.assertEqual(out["sourceLabel"], "Detected: you worked this day")

    def test_a_claim_the_employee_raised(self):
        out = self.tag(
            kind="holiday_work", key="hw-5", status="approved", claim={"raisedByRole": "employee", "status": "approved"}
        )
        self.assertEqual(
            (out["source"], out["sourceLabel"]), ("automatic", "Claimed by you, approved by your Department Head")
        )
        out = self.tag(kind="use_balance", key="hw-6", claim={"raisedByRole": "employee", "status": "pending"})
        self.assertEqual(out["sourceLabel"], "Asked by you: waiting for your Department Head")

    def test_hr_raised_claims_stay_given_by_hr(self):
        out = self.tag(
            kind="holiday_work", key="hw-7", status="approved", claim={"raisedByRole": "hr", "status": "approved"}
        )
        self.assertEqual((out["source"], out["sourceLabel"], out["givenByHr"]), ("hr", "Given by HR", True))


class OtCreditRuleTests(engine.OtListClaimTests):
    """GET /api/compensation/ot rows say which rule their Type 2 credit follows (creditRule), so the HR page shows the
    ladder suggestion for a row before claims_from or with the quarters rule off instead of "Below a quarter"."""

    CODE = "CIO1"

    def test_quarters_on_and_after_the_claims_date(self):
        _body, rows = self.rows()
        self.assertEqual((rows["2026-03-04"]["creditRule"], rows["2026-03-04"]["creditShifts"]), ("quarters", 0.5))

    def test_ladder_when_the_quarters_rule_is_off(self):
        engine.base.set_config(ot_quarter_rule=False)
        _body, rows = self.rows()
        self.assertEqual((rows["2026-03-04"]["creditRule"], rows["2026-03-04"]["creditShifts"]), ("ladder", None))

    def test_ladder_before_the_claims_date(self):
        engine.base.set_config(claims_from=engine.base.MON2)
        _body, rows = self.rows()
        row = rows["2026-03-04"]
        self.assertEqual((row["creditRule"], row["creditShifts"], row["claimRules"]), ("ladder", None, False))

    # the inherited list tests run in tests_compensation_claims_engine
    test_rows_carry_the_claim_facts = None
    test_without_a_department_head_nothing_is_claimable_and_the_row_says_why = None
    test_an_open_claim_shows_and_blocks_pay = None
    test_after_the_claims_date_hr_may_only_pay = None
    test_the_allowance_status_follows_the_claim = None

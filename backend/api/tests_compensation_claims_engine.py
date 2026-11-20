"""The attendance / detection side of the 2026-11-19 compensation claim workflow (BE-2): the staff next-morning cut-off
(shift_engine), the Type 1 allowance only after an approved claim (compensation_engine / attendance_final), Type 2 by the
quarters rule (overtime.classify_day / compensation_rules.quarter_credit), the birthday as a normal working day (absent =
paid birthday leave), compensation_effects (after_claim_decided, check_claim_effects, staff_ot_credit, birthday_outcome),
the HR OT list / assign additions and the new settings keys.

Run via: python manage.py test api.tests_compensation_claims_engine -v 2

Same fixtures as tests_compensation_engine (shift 08:30-17:30, 60 min lunch = 480 working minutes, so a quarter is 2 h;
March 2026, Monday 2 March is the OT day). The effective dates are SET EXPLICITLY (the test-DB time bomb: migration 0166
stamps them with the real date of the run): CompensationConfig.claims_from and PayrollSettings.staff_next_morning_from are
1 March 2026 unless a test moves them.
"""

from datetime import date, time, timedelta
from decimal import Decimal
from unittest import mock

from django.utils import timezone

from . import approval_workflow as approval
from . import compensation_effects as effects
from . import compensation_rules as rules
from . import tests_compensation_engine as base
from .attendance_final import compute_day_record, compute_range_records
from .clock import ist_today
from .models import (
    AttendanceDayRecord,
    AttendanceLog,
    CasualLeaveRequest,
    CompensationConfig,
    CompensationLedger,
    Department,
    DepartmentManager,
    Employee,
    HolidayWorkClaim,
    LeaveRequest,
    ManagerDepartmentAssignment,
    OvertimeRecord,
    PayrollMonthClose,
    PayrollSettings,
)
from .overtime import detect_overtime_for_month, sync_overtime

MON, TUE, WED, THU, FRI, SAT, SUN = base.MON, base.TUE, base.WED, base.THU, base.FRI, base.SAT, base.SUN
CLAIMS_FROM = date(2026, 3, 1)


class ClaimsEngineBase(base.CompBase):
    CODE = "CCE1"

    def setUp(self):
        super().setUp()
        approval.clear_cache()
        self.addCleanup(approval.clear_cache)
        ps = PayrollSettings.get()
        ps.staff_next_morning_enabled = True
        ps.staff_next_morning_from = CLAIMS_FROM
        ps.staff_next_morning_cutoff = time(6, 0)
        ps.save()
        self.config = base.set_config(claims_from=CLAIMS_FROM, ot_quarter_rule=True)

    def settings(self, **fields) -> PayrollSettings:
        ps = PayrollSettings.get()
        for name, value in fields.items():
            setattr(ps, name, value)
        ps.save()
        return ps

    def log(self, d, *times, emp=None):
        """Add punches on `d` without touching any other day (base.punch clears d and d + 1)."""
        for t in times:
            AttendanceLog.objects.create(employee=emp or self.emp, date=d, punch_time=t, punch_type="IN", source="test")

    def claim(self, kind, d, status="approved", record=None, minutes=None, shifts="0.00", emp=None):
        return HolidayWorkClaim.objects.create(
            employee=emp or self.emp,
            kind=kind,
            work_date=d,
            shifts=Decimal(shifts),
            status=status,
            overtime_record=record,
            minutes=minutes,
            raised_by_role="employee",
        )

    def allowance_record(self, d=MON, minutes=30, extra=75, emp=None):
        return OvertimeRecord.objects.create(
            employee=emp or self.emp,
            date=d,
            shift_end_time=time(17, 30),
            last_punch_out=time(18, 45),
            ot_minutes=extra,
            ot_type=OvertimeRecord.OT_TYPE_ALLOWANCE,
            status=OvertimeRecord.STATUS_AUTO,
            allowance_minutes=minutes,
        )

    def lock_march(self):
        PayrollMonthClose.objects.create(month=3, year=2026, finalized_at=timezone.now(), finalized_by="test")


# ── the staff next-morning cut-off ──────────────────────────────────────────


class NextMorningRuleTests(ClaimsEngineBase):
    def test_an_open_day_takes_the_next_mornings_early_punch_as_its_overtime(self):
        self.log(MON, time(8, 30), time(13, 0), time(14, 0))  # three punches: a session is open
        self.log(TUE, time(2, 10), time(8, 30), time(17, 30))
        mon = self.rec(MON)
        self.assertEqual(mon.last_punch, time(2, 10))
        self.assertEqual(mon.ot_extra_minutes, (24 * 60 + 2 * 60 + 10) - (17 * 60 + 30))  # 17:30 -> 02:10 next day
        self.assertEqual((mon.status, mon.shifts_earned), ("present", Decimal("1.00")))
        tue = self.rec(TUE)
        self.assertEqual((tue.first_punch, tue.total_punches), (time(8, 30), 3))  # total_punches counts the raw punches
        self.assertFalse(tue.is_late)

    def test_a_closed_day_leaves_an_early_punch_to_the_next_day(self):
        self.log(MON, time(8, 30), time(13, 0), time(14, 0), time(17, 40))  # four punches: closed
        self.log(TUE, time(5, 30), time(17, 30))
        self.assertEqual(self.rec(MON).last_punch, time(17, 40))
        self.assertEqual(self.rec(TUE).first_punch, time(5, 30))

    def test_a_punch_at_the_cutoff_is_the_next_days_own(self):
        self.log(MON, time(8, 30), time(13, 0), time(14, 0))
        self.log(TUE, time(6, 0), time(17, 30))
        self.assertEqual(self.rec(MON).last_punch, time(14, 0))
        self.assertEqual(self.rec(TUE).first_punch, time(6, 0))

    def test_the_cutoff_is_a_setting(self):
        # 07:00, but the early-arrival guard of Tuesday's 08:30 shift (2 h pre-shift buffer) keeps it at 06:30
        self.settings(staff_next_morning_cutoff=time(7, 0))
        self.log(MON, time(8, 30), time(13, 0), time(14, 0))
        self.log(TUE, time(6, 20), time(8, 35), time(17, 30))
        self.assertEqual(self.rec(MON).last_punch, time(6, 20))
        self.assertEqual(self.rec(TUE).first_punch, time(8, 35))

    def test_a_double_tap_before_the_cutoff_goes_with_it(self):
        self.log(MON, time(8, 30), time(13, 0), time(14, 0))
        self.log(TUE, time(2, 10), time(2, 11), time(8, 30), time(17, 30))
        self.assertEqual(self.rec(MON).last_punch, time(2, 11))
        self.assertEqual(self.rec(TUE).first_punch, time(8, 30))

    def test_an_even_day_does_not_take_a_forgotten_exit_any_more(self):
        # the old grace rule would have taken 01:00 (Monday has no punch after its 17:30 end); the cut-off rule only
        # closes an OPEN session
        self.log(MON, time(8, 30), time(13, 0))
        self.log(TUE, time(1, 0), time(8, 30), time(17, 30))
        self.assertEqual(self.rec(MON).last_punch, time(13, 0))
        self.assertEqual(self.rec(TUE).first_punch, time(1, 0))

    def test_switched_off_the_old_grace_rule_decides(self):
        self.settings(staff_next_morning_enabled=False, last_punch_post_shift_grace_hours=Decimal("9"))
        self.log(MON, time(8, 30), time(13, 0))
        self.log(TUE, time(1, 0), time(8, 30), time(17, 30))
        self.assertEqual(self.rec(MON).last_punch, time(1, 0))
        self.assertEqual(self.rec(TUE).first_punch, time(8, 30))

    def test_before_the_from_date_the_old_rule_stands_and_after_it_the_new_one(self):
        self.settings(staff_next_morning_from=WED, last_punch_post_shift_grace_hours=Decimal("9"))
        self.log(MON, time(8, 30), time(13, 0))  # even; pair (MON, TUE) is before the from-date: old rule
        self.log(TUE, time(1, 0), time(8, 30), time(17, 30))
        self.log(WED, time(8, 30), time(13, 0))  # even; pair (WED, THU) is on the from-date: new rule
        self.log(THU, time(1, 0), time(8, 30), time(17, 30))
        self.assertEqual(self.rec(MON).last_punch, time(1, 0))
        self.assertEqual(self.rec(WED).last_punch, time(13, 0))
        self.assertEqual(self.rec(THU).first_punch, time(1, 0))

    def test_one_day_a_range_and_the_month_agree_along_a_run_of_nights(self):
        self.log(MON, time(8, 30), time(13, 0), time(14, 0))  # open: takes Tuesday 02:00
        self.log(TUE, time(2, 0), time(8, 30), time(13, 0), time(14, 0))  # own = 3 after 02:00 went: open again
        self.log(WED, time(3, 0), time(5, 45), time(17, 30))  # both early punches go to Tuesday
        self.log(THU, time(5, 50), time(17, 30))  # Wednesday's own (17:30) is one punch: open, takes 05:50
        single = {
            d: (r.first_punch, r.last_punch, r.ot_extra_minutes) for d in (MON, TUE, WED, THU) for r in [self.rec(d)]
        }
        AttendanceDayRecord.objects.all().delete()
        ranged = {
            r.date: (r.first_punch, r.last_punch, r.ot_extra_minutes)
            for r in compute_range_records(self.emp, MON, THU, PayrollSettings.get())
        }
        AttendanceDayRecord.objects.all().delete()
        month = {d: (r.first_punch, r.last_punch, r.ot_extra_minutes) for d, r in self.month().items()}
        for d in (MON, TUE, WED, THU):
            self.assertEqual(single[d], ranged[d], d)
            self.assertEqual(single[d], month[d], d)
        self.assertEqual(single[TUE][1], time(5, 45))
        self.assertEqual(single[WED][:2], (time(17, 30), time(5, 50)))

    def test_a_production_employee_is_never_touched(self):
        prod = self.new_staff("CCEP", employment_type="production")
        from .shift_engine import resolve_day_punch_logs

        own = [AttendanceLog(employee=prod, date=TUE, punch_time=time(2, 0))]
        self.assertIs(resolve_day_punch_logs(prod, TUE, own, PayrollSettings.get()), own)


class NextMorningStrictModeTests(NextMorningRuleTests):
    MODE = "strict"


# ── the quarters rule ───────────────────────────────────────────────────────


class QuarterRuleTests(ClaimsEngineBase):
    def test_working_minutes_takes_the_lunch_off_and_handles_overnight(self):
        self.assertEqual(rules.working_minutes(time(8, 30), time(17, 30), 60), 480)
        self.assertEqual(rules.working_minutes(time(22, 0), time(6, 0), 30), 450)
        self.assertEqual(rules.working_minutes(None, time(6, 0), 30), 0)

    def test_quarters_are_rounded_down_and_capped(self):
        q = rules.quarter_credit
        self.assertEqual(q(119, 480), Decimal("0.00"))
        self.assertEqual(q(120, 480), Decimal("0.25"))
        self.assertEqual(q(239, 480), Decimal("0.25"))
        self.assertEqual(q(240, 480), Decimal("0.50"))
        self.assertEqual(q(360, 480), Decimal("0.75"))
        self.assertEqual(q(480, 480), Decimal("1.00"))
        self.assertEqual(q(900, 480), Decimal("1.00"))
        self.assertEqual(q(300, 0), Decimal("0.00"))

    def test_staff_ot_credit_uses_the_employees_own_shift(self):
        self.assertEqual(effects.staff_ot_credit(self.emp, MON, 240), Decimal("0.50"))
        long_shift = base.make_shift(name="Long", start_time=time(9, 0), end_time=time(20, 0))  # 600 working minutes
        other = self.new_staff("CCE2", shift=long_shift)
        self.assertEqual(effects.staff_ot_credit(other, MON, 240), Decimal("0.25"))

    def test_staff_ot_credit_is_zero_before_the_claims_date_with_the_rule_off_and_for_production(self):
        self.assertEqual(effects.staff_ot_credit(self.emp, date(2026, 2, 27), 480), Decimal("0.00"))
        prod = self.new_staff("CCEP", employment_type="production")
        self.assertEqual(effects.staff_ot_credit(prod, MON, 480), Decimal("0.00"))
        base.set_config(ot_quarter_rule=False)
        self.assertEqual(effects.staff_ot_credit(self.emp, MON, 480), Decimal("0.00"))


# ── Type 2 detection by the quarters rule ───────────────────────────────────


class Type2DetectionTests(ClaimsEngineBase):
    def setUp(self):
        super().setUp()
        self.on(allowance_enabled=True, shift_enabled=True, relaxation_enabled=True, pay_enabled=True)

    def detect(self):
        self.month()
        return {r.date: r for r in detect_overtime_for_month(2026, 3)}

    def test_a_quarter_of_the_shift_is_type_2_with_the_quarters_credit(self):
        self.worked(MON, time(19, 30))  # 120 minutes = a quarter of 480
        self.worked(TUE, time(23, 30))  # 360 minutes = 0.75 (the old ladder said 0.50 for 23:30)
        rows = self.detect()
        self.assertEqual((rows[MON].ot_type, rows[MON].status), ("shift", "detected"))
        self.assertEqual(rows[MON].suggested_shifts, Decimal("0.25"))
        self.assertEqual(rows[TUE].suggested_shifts, Decimal("0.75"))

    def test_below_a_quarter_is_type_1_by_the_allowance_rules(self):
        self.worked(MON, time(19, 29))  # 119 minutes
        row = self.detect()[MON]
        self.assertEqual((row.ot_type, row.status, row.allowance_minutes), ("allowance", "auto", 30))

    def test_below_a_quarter_of_a_long_shift_the_allowance_needs_no_threshold(self):
        long_shift = base.make_shift(name="Long", start_time=time(7, 0), end_time=time(20, 0))  # 720: quarter = 180
        other = self.new_staff("CCE3", shift=long_shift)
        self.punch(MON, time(7, 0), time(13, 0), time(14, 0), time(22, 40), emp=other)  # 160 > the old 150 threshold
        self.month(emp=other)
        row = OvertimeRecord.objects.get(employee=other, date=MON) if detect_overtime_for_month(2026, 3) else None
        self.assertEqual((row.ot_type, row.allowance_minutes), ("allowance", 60))

    def test_before_the_claims_date_the_threshold_and_ladder_stand(self):
        base.set_config(claims_from=WED)
        self.worked(MON, time(19, 30))  # 120 minutes: Type 1 under the old rule
        self.worked(TUE, time(23, 30))  # 360 minutes: ladder 0.50
        rows = self.detect()
        self.assertEqual((rows[MON].ot_type, rows[MON].allowance_minutes), ("allowance", 60))
        self.assertEqual(rows[TUE].suggested_shifts, Decimal("0.50"))

    def test_with_the_quarters_rule_off_the_ladder_decides(self):
        base.set_config(ot_quarter_rule=False)
        self.worked(TUE, time(23, 30))
        self.assertEqual(self.detect()[TUE].suggested_shifts, Decimal("0.50"))

    def test_a_row_with_an_approved_claim_is_never_changed_or_pruned(self):
        self.worked(MON, time(18, 45))
        row = self.detect()[MON]
        self.assertEqual(row.allowance_minutes, 30)
        self.claim("ot_allowance", MON, status="approved", record=row, minutes=30)
        self.worked(MON, time(19, 30))  # now a quarter: Type 2 would replace the Type 1 row
        self.detect()
        row.refresh_from_db()
        self.assertEqual((row.ot_type, row.allowance_minutes), ("allowance", 30))
        self.worked(MON, time(17, 30))  # no OT at all any more: an unclaimed row would be pruned
        self.month()
        sync_overtime(date(2026, 3, 1), date(2026, 3, 31))
        self.assertTrue(OvertimeRecord.objects.filter(pk=row.pk).exists())

    def test_a_row_with_a_pending_or_rejected_claim_follows_its_day(self):
        # security review 2026-11-19: a pending claim no longer freezes its evidence; the approval re-checks it
        for status in ("pending", "rejected"):
            with self.subTest(status=status):
                self.worked(MON, time(18, 45))
                row = self.detect()[MON]
                claim = self.claim("ot_allowance", MON, status=status, record=row, minutes=30)
                self.worked(MON, time(19, 30))  # a quarter now: the row becomes the Type 2 candidate it is
                self.detect()
                row.refresh_from_db()
                self.assertEqual((row.ot_type, row.suggested_shifts), ("shift", Decimal("0.25")))
                self.worked(MON, time(17, 30))  # no OT any more: pruned, the claim loses its record
                self.month()
                sync_overtime(date(2026, 3, 1), date(2026, 3, 31))
                self.assertFalse(OvertimeRecord.objects.filter(pk=row.pk).exists())
                claim.refresh_from_db()
                self.assertIsNone(claim.overtime_record_id)
                claim.delete()


# ── Type 1 only after an approved claim ─────────────────────────────────────


class Type1ClaimTests(ClaimsEngineBase):
    def setUp(self):
        super().setUp()
        self.on(allowance_enabled=True, shift_enabled=True)
        self.worked(MON, time(18, 45))  # 75 minutes: a 30 minute allowance
        self.log(TUE, time(8, 55), time(13, 0), time(14, 0), time(17, 30))  # late by 15 minutes after 08:40
        self.record = self.allowance_record()

    def test_without_a_claim_the_arrival_is_late(self):
        r = self.rec(TUE)
        self.assertTrue(r.is_late)
        self.assertEqual(r.compensation_kind, "")

    def test_a_pending_claim_changes_nothing(self):
        self.claim("ot_allowance", MON, status="pending", record=self.record, minutes=30)
        self.assertTrue(self.rec(TUE).is_late)

    def test_an_approved_claim_applies_the_allowance(self):
        self.claim("ot_allowance", MON, record=self.record, minutes=30)
        r = self.rec(TUE)
        self.assertFalse(r.is_late)
        self.assertEqual((r.compensation_kind, r.compensation_minutes), ("ot_allowance", 15))
        self.assertIn("30 min late-in allowance", r.compensation_note)
        month = self.month()[TUE]
        self.assertEqual((month.is_late, month.compensation_kind), (False, "ot_allowance"))

    def test_before_the_claims_date_the_allowance_stays_automatic(self):
        base.set_config(claims_from=WED)
        r = self.rec(TUE)
        self.assertFalse(r.is_late)
        self.assertEqual(r.compensation_kind, "ot_allowance")

    def test_approving_after_the_day_re_derives_the_stored_day(self):
        self.assertTrue(self.rec(TUE).is_late)
        claim = self.claim("ot_allowance", MON, record=self.record, minutes=30)
        self.assertIsNone(effects.check_claim_effects(claim))
        effects.after_claim_decided(claim)
        self.assertFalse(AttendanceDayRecord.objects.get(employee=self.emp, date=TUE).is_late)

    def test_a_manual_next_day_refuses_the_approval_and_is_never_rewritten(self):
        stored = self.rec(TUE)
        stored.source = "manual"
        stored.save()
        claim = self.claim("ot_allowance", MON, record=self.record, minutes=30)
        self.assertIn("by hand", effects.check_claim_effects(claim))
        effects.after_claim_decided(claim)
        self.assertTrue(AttendanceDayRecord.objects.get(employee=self.emp, date=TUE).is_late)

    def test_a_locked_month_refuses_the_approval_and_is_never_rewritten(self):
        self.assertTrue(self.rec(TUE).is_late)
        self.lock_march()
        claim = self.claim("ot_allowance", MON, record=self.record, minutes=30)
        self.assertIn("Payroll Done", effects.check_claim_effects(claim))
        effects.after_claim_decided(claim)
        self.assertTrue(AttendanceDayRecord.objects.get(employee=self.emp, date=TUE).is_late)

    def test_the_next_working_day_skips_an_off_saturday_and_the_sunday(self):
        off_sat = base.make_shift(name="Off Sat")
        other = self.new_staff("CCE4", shift=off_sat)
        other.shift_assignments.update(saturday_off=True)
        self.assertEqual(effects.next_working_day(other, FRI), base.MON2)
        self.assertEqual(effects.next_working_day(self.emp, MON), TUE)


# ── the birthday as a normal working day ────────────────────────────────────


class BirthdayClaimRuleTests(ClaimsEngineBase):
    def setUp(self):
        super().setUp()
        self.on(birthday_enabled=True)
        self.emp.date_of_birth = date(1990, 3, 5)  # Thursday 5 March 2026
        self.emp.save()

    def assertPaidLeave(self, r, why="no punch"):
        self.assertEqual((r.status, r.shifts_earned, r.compensation_kind), ("present", Decimal("1.00"), "birthday"))
        self.assertTrue(r.compensation_note.startswith("Birthday leave"))
        self.assertIn(why, r.compensation_note)

    def test_absent_on_the_birthday_is_paid_birthday_leave(self):
        self.assertPaidLeave(self.rec(THU))
        self.assertEqual(effects.birthday_outcome(self.emp, THU)["outcome"], effects.BIRTHDAY_PAID_LEAVE)

    def test_approved_leave_on_the_birthday_is_paid_birthday_leave(self):
        LeaveRequest.objects.create(
            employee=self.emp, start_date=THU.isoformat(), end_date=THU.isoformat(), status="approved"
        )
        r = compute_range_records(self.emp, THU, THU, PayrollSettings.get())[0]
        self.assertPaidLeave(r, why="approved leave")

    def test_a_half_day_casual_leave_without_a_punch_is_one_paid_birthday(self):
        CasualLeaveRequest.objects.create(employee=self.emp, date=THU, portion="first_half", status="approved")
        r = compute_range_records(self.emp, THU, THU, PayrollSettings.get())[0]
        self.assertPaidLeave(r)

    def test_a_worked_birthday_is_a_normal_day_with_a_credit_to_claim(self):
        self.worked(THU, time(17, 40), first=time(9, 5))
        r = self.rec(THU)
        self.assertTrue(r.is_late)  # judged normally: no more "no detection on the birthday"
        self.assertEqual(r.compensation_kind, "")
        out = effects.birthday_outcome(self.emp, THU)
        self.assertEqual(
            (out["outcome"], out["base"], out["claimable"]), ("credit_claimable", "credit_claimable", True)
        )
        self.assertEqual(out["shifts"], Decimal("1.00"))

    def test_a_half_day_worked_is_a_normal_half_day(self):
        self.punch(THU, time(8, 30), time(12, 30))
        r = self.rec(THU)
        self.assertEqual((r.status, r.compensation_kind), ("half_shift", ""))
        self.assertEqual(effects.birthday_outcome(self.emp, THU)["outcome"], "credit_claimable")

    def test_the_claim_states_replace_the_credit_and_a_rejected_one_may_be_claimed_again(self):
        self.worked(THU, time(17, 30))
        self.rec(THU)
        claim = self.claim("birthday", THU, status="pending", shifts="1.00")
        out = effects.birthday_outcome(self.emp, THU)
        self.assertEqual((out["outcome"], out["base"], out["claimable"]), ("credit_pending", "credit_claimable", False))
        self.assertEqual(out["claim"]["id"], claim.id)
        claim.status = "approved"
        claim.save()
        self.assertEqual(effects.birthday_outcome(self.emp, THU)["outcome"], "credit_approved")
        claim.status = "rejected"
        claim.save()
        out = effects.birthday_outcome(self.emp, THU)
        self.assertEqual((out["outcome"], out["base"], out["claimable"]), ("credit_rejected", "credit_claimable", True))

    def test_a_birthday_leave_stored_in_the_morning_follows_a_later_punch(self):
        self.assertPaidLeave(self.rec(THU))
        self.worked(THU, time(17, 30))  # the punches arrive after the morning's computation
        # a plain read never rewrites the stored day (security review 2026-11-19): it answers from the row as it is
        self.assertEqual(effects.birthday_outcome(self.emp, THU)["outcome"], "paid_leave")
        self.assertEqual(AttendanceDayRecord.objects.get(employee=self.emp, date=THU).compensation_kind, "birthday")
        # a caller that may write works it out again
        out = effects.birthday_outcome(self.emp, THU, refresh=True)
        self.assertEqual(out["outcome"], "credit_claimable")
        self.assertEqual(AttendanceDayRecord.objects.get(employee=self.emp, date=THU).compensation_kind, "")

    def test_before_the_claims_date_the_old_automatic_rule_stands(self):
        base.set_config(claims_from=FRI)
        self.worked(THU, time(17, 40), first=time(9, 5))
        r = self.rec(THU)
        self.assertEqual(
            (r.status, r.shifts_earned, r.compensation_kind, r.is_late), ("present", Decimal("1.00"), "birthday", False)
        )
        self.assertEqual(effects.birthday_outcome(self.emp, THU)["outcome"], "old_rule")

    def test_off_days_upcoming_and_not_eligible(self):
        self.emp.date_of_birth = date(1990, 3, 8)  # Sunday 8 March 2026
        self.emp.save()
        self.assertEqual(effects.birthday_outcome(self.emp, SUN)["outcome"], "off_day")
        self.assertEqual(effects.birthday_outcome(self.emp, THU)["outcome"], "not_eligible")
        ahead = ist_today() + timedelta(days=1)
        while ahead.weekday() >= 5:
            ahead += timedelta(days=1)
        self.emp.date_of_birth = (
            ahead.replace(year=1990) if not (ahead.month == 2 and ahead.day == 29) else date(1990, 3, 1)
        )
        self.emp.save()
        if ahead.month != 2 or ahead.day != 29:
            self.assertEqual(effects.birthday_outcome(self.emp, ahead)["outcome"], "upcoming")
        prod = self.new_staff("CCEP", employment_type="production", date_of_birth=date(1990, 3, 5))
        self.assertEqual(effects.birthday_outcome(prod, THU)["outcome"], "not_eligible")

    def test_a_birthday_switched_off_gives_nothing(self):
        base.set_config(birthday_enabled=False)
        self.assertEqual(self.rec(THU).status, "absent")
        self.assertEqual(effects.birthday_outcome(self.emp, THU)["outcome"], "not_eligible")

    def test_many_birthdays_cost_a_fixed_number_of_queries(self):
        others = [self.new_staff(f"CCB{i}", date_of_birth=date(1990, 3, 5)) for i in range(4)]
        for emp in [self.emp, *others]:
            self.worked(THU, time(17, 30), emp=emp)
            self.rec(THU, emp=emp)
        with self.assertNumQueries(6):
            out = effects.birthday_outcomes([(e, THU) for e in [self.emp, *others]])
        self.assertEqual({o["outcome"] for o in out.values()}, {"credit_claimable"})


# ── using the balance ───────────────────────────────────────────────────────


class UseBalanceEffectsTests(ClaimsEngineBase):
    def test_an_approved_day_off_tops_the_day_up(self):
        self.punch(WED, time(8, 30), time(12, 30))  # a half day: 0.50
        self.assertEqual(self.rec(WED).shifts_earned, Decimal("0.50"))
        claim = self.claim("use_balance", WED, shifts="0.50")
        self.assertIsNone(effects.check_claim_effects(claim))
        CompensationLedger.objects.create(
            employee=self.emp, entry_type="debit", shifts=Decimal("0.50"), date=WED, source="redemption", claim=claim
        )
        effects.after_claim_decided(claim)
        stored = AttendanceDayRecord.objects.get(employee=self.emp, date=WED)
        self.assertEqual((stored.shifts_earned, stored.compensation_kind), (Decimal("1.00"), "relaxation"))

    def test_the_day_rules_and_the_lock_refuse(self):
        self.assertIn(
            "Sunday", effects.check_claim_effects(self.claim("use_balance", SUN, status="pending", shifts="1.00"))
        )
        self.worked(THU, time(17, 30))
        self.assertIn(
            "full paid day",
            effects.check_claim_effects(self.claim("use_balance", THU, status="pending", shifts="0.50")),
        )
        self.lock_march()
        self.assertIn(
            "Payroll Done", effects.check_claim_effects(self.claim("use_balance", WED, status="pending", shifts="0.50"))
        )

    def test_credit_kinds_never_refuse_and_a_rejection_changes_nothing(self):
        claim = self.claim("holiday_work", SUN, shifts="1.00")
        self.assertIsNone(effects.check_claim_effects(claim))
        rejected = self.claim("use_balance", WED, status="rejected", shifts="0.50")
        effects.after_claim_decided(rejected)
        self.assertFalse(AttendanceDayRecord.objects.filter(employee=self.emp, date=WED).exists())


# ── the HR OT list and assign ───────────────────────────────────────────────


class OtListClaimTests(ClaimsEngineBase):
    def setUp(self):
        super().setUp()
        self.on(allowance_enabled=True, shift_enabled=True, relaxation_enabled=True, pay_enabled=True)
        self.headers = base.hr_headers()
        # "today" for the list: a few days after the March OT (a claim can only be raised within 45 days)
        patch = mock.patch("api.compensation_views.ist_today", return_value=date(2026, 3, 20))
        patch.start()
        self.addCleanup(patch.stop)
        self.dept = Department.objects.create(name="CCE Dept")
        self.emp.department = self.dept
        self.emp.save()
        self.worked(MON, time(18, 45))  # Type 1: 30 minutes
        self.worked(WED, time(21, 30))  # 240 minutes: Type 2, 0.50
        self.month()  # the stored days detection reads

    def add_hod(self):
        boss = self.new_staff("CCEB")
        manager = DepartmentManager.objects.create(employee=boss)
        ManagerDepartmentAssignment.objects.create(manager=manager, department=self.dept)

    def rows(self):
        body = self.client.get("/api/compensation/ot", {"month": 3, "year": 2026}, **self.headers).json()
        return body, {r["date"]: r for r in body["results"] if r["employeeCode"] == self.CODE}

    def test_rows_carry_the_claim_facts(self):
        self.add_hod()
        body, rows = self.rows()
        self.assertEqual(body["config"]["claimsFrom"], "2026-03-01")
        allowance, shift = rows["2026-03-02"], rows["2026-03-04"]
        self.assertEqual(
            (allowance["otType"], allowance["statusLabel"], allowance["appliesOn"]),
            ("allowance", "Detected", "2026-03-03"),
        )
        self.assertEqual((shift["otType"], shift["creditShifts"], shift["shiftMinutes"]), ("shift", 0.5, 480))
        self.assertIsNone(allowance["creditShifts"])
        self.assertTrue(allowance["claimRules"])
        self.assertTrue(shift["claimable"])
        self.assertIsNone(shift["claim"])

    def test_without_a_department_head_nothing_is_claimable_and_the_row_says_why(self):
        _body, rows = self.rows()
        self.assertFalse(rows["2026-03-04"]["claimable"])
        self.assertIn("Department Head", rows["2026-03-04"]["claimProblem"])

    def test_an_open_claim_shows_and_blocks_pay(self):
        self.add_hod()
        _body, rows = self.rows()
        record = OvertimeRecord.objects.get(pk=rows["2026-03-04"]["id"])
        claim = self.claim("ot_shift", WED, status="pending", record=record, shifts="0.50")
        _body, rows = self.rows()
        row = rows["2026-03-04"]
        self.assertFalse(row["claimable"])
        self.assertFalse(row["canAssign"])
        self.assertEqual(
            (row["claim"]["id"], row["claim"]["status"], row["claim"]["raisedByRole"]),
            (claim.id, "pending", "employee"),
        )
        r = self.client.post(
            "/api/compensation/ot/assign",
            {"mode": "pay", "records": [{"employeeId": self.emp.id, "date": "2026-03-04"}]},
            content_type="application/json",
            **self.headers,
        )
        self.assertEqual(r.status_code, 409, r.content)
        self.assertIn("never both", r.json()["error"])
        record.refresh_from_db()
        self.assertEqual(record.status, "detected")

    def test_after_the_claims_date_hr_may_only_pay(self):
        self.rows()
        r = self.client.post(
            "/api/compensation/ot/assign",
            {
                "mode": "relaxation",
                "records": [{"employeeId": self.emp.id, "date": "2026-03-04", "claimDate": "2026-03-05"}],
            },
            content_type="application/json",
            **self.headers,
        )
        self.assertEqual(r.status_code, 400)
        self.assertIn("can only pay", r.json()["error"])
        r = self.client.post(
            "/api/compensation/ot/assign",
            {"mode": "pay", "records": [{"employeeId": self.emp.id, "date": "2026-03-04"}]},
            content_type="application/json",
            **self.headers,
        )
        self.assertEqual(r.status_code, 200, r.content)

    def test_the_allowance_status_follows_the_claim(self):
        self.add_hod()
        _body, rows = self.rows()
        self.assertEqual(rows["2026-03-02"]["allowanceStatus"], "not_used")
        record = OvertimeRecord.objects.get(pk=rows["2026-03-02"]["id"])
        claim = self.claim("ot_allowance", MON, status="pending", record=record, minutes=30)
        self.assertEqual(self.rows()[1]["2026-03-02"]["allowanceStatus"], "pending")
        claim.status = "approved"
        claim.save()
        self.log(TUE, time(8, 55), time(17, 30))
        effects.after_claim_decided(claim)
        self.assertEqual(self.rows()[1]["2026-03-02"]["allowanceStatus"], "used")


# ── the settings keys ───────────────────────────────────────────────────────


class ClaimSettingsTests(ClaimsEngineBase):
    def setUp(self):
        super().setUp()
        self.headers = base.hr_headers()

    def put_payroll(self, **body):
        return self.client.put("/api/payroll-settings", body, content_type="application/json", **self.headers)

    def test_the_compensation_settings_show_the_claims_date_and_the_quarters_rule(self):
        for path in ("/api/compensation/settings", "/api/compensation/config"):
            body = self.client.get(path, **self.headers).json()
            self.assertEqual(body["claims"]["from"], "2026-03-01")
            self.assertTrue(body["shift"]["quarterRule"])
            self.assertIn("quarters", body["shift"]["quarterRuleHelp"])
        # the claims date moves forward only (final round 2026-11-19): a later date is saved, an earlier one refused
        patch = mock.patch("api.compensation_settings_views.ist_today", return_value=date(2026, 3, 20))
        patch.start()
        self.addCleanup(patch.stop)
        r = self.client.put(
            "/api/compensation/settings",
            {"shift": {"quarterRule": False}, "claims": {"from": "2027-01-01"}},
            content_type="application/json",
            **self.headers,
        )
        self.assertEqual(r.status_code, 200, r.content)
        self.assertFalse(r.json()["shift"]["quarterRule"])
        self.assertEqual(r.json()["claims"]["from"], "2027-01-01")
        self.assertTrue(any("quarters rule" in w for w in r.json()["warnings"]))
        r = self.client.put(
            "/api/compensation/settings",
            {"claims": {"from": "2026-12-01"}},
            content_type="application/json",
            **self.headers,
        )
        self.assertEqual(r.status_code, 400, r.content)
        self.assertEqual(CompensationConfig.get().claims_from, date(2027, 1, 1))
        r = self.client.put(
            "/api/compensation/settings",
            {"shift": {"quarterRule": "no"}},
            content_type="application/json",
            **self.headers,
        )
        self.assertEqual(r.status_code, 400)

    def test_the_staff_next_morning_keys(self):
        # the API dates every change by the IST day (and refuses a from-date before it): pinned inside March 2026
        today = date(2026, 3, 20)
        patch = mock.patch("api.clock.ist_today", return_value=today)
        patch.start()
        self.addCleanup(patch.stop)
        body = self.client.get("/api/payroll-settings", **self.headers).json()
        self.assertEqual(
            (body["staffNextMorningEnabled"], body["staffNextMorningCutoff"], body["staffNextMorningFrom"]),
            (True, "06:00", "2026-03-01"),
        )
        r = self.put_payroll(staffNextMorningCutoff="07:15")
        self.assertEqual((r.status_code, r.json()["staffNextMorningCutoff"]), (200, "07:15"))
        # the 07:15 cut-off applies from the day it was set; before it, from the start, 06:00 stands
        self.assertEqual(
            r.json()["staffNextMorningHistory"],
            [
                {"from": "2026-03-01", "enabled": True, "cutoff": "06:00"},
                {"from": today.isoformat(), "enabled": True, "cutoff": "07:15"},
            ],
        )
        for bad in ("12:01", "00:00", "7", "25:00", None):
            self.assertEqual(self.put_payroll(staffNextMorningCutoff=bad).status_code, 400, bad)
        self.assertEqual(self.put_payroll(staffNextMorningFrom="2026-02-01").status_code, 400)  # only forward
        self.assertEqual(self.put_payroll(staffNextMorningFrom="2026-03-10").status_code, 400)  # never into the past
        self.assertEqual(self.put_payroll(staffNextMorningFrom=None).status_code, 400)  # never cleared
        r = self.put_payroll(staffNextMorningFrom="2026-04-01")
        self.assertEqual((r.status_code, r.json()["staffNextMorningFrom"]), (200, "2026-04-01"))
        self.assertEqual(self.put_payroll(staffNextMorningEnabled="yes").status_code, 400)
        self.assertEqual(self.put_payroll(staffNextMorningEnabled=False).json()["staffNextMorningEnabled"], False)
        r = self.put_payroll(staffNextMorningEnabled=True)
        # back on: the start date stays; while it is still ahead every change is dated from it (an entry dated today
        # would start the rule before its from-date) and replaces the entries from that date on
        self.assertEqual(r.json()["staffNextMorningFrom"], "2026-04-01")
        self.assertEqual(
            r.json()["staffNextMorningHistory"], [{"from": "2026-04-01", "enabled": True, "cutoff": "07:15"}]
        )
        from .models import AuditLog

        self.assertTrue(AuditLog.objects.filter(record_description__icontains="next-morning").exists())

    def test_a_branch_login_cannot_change_the_company_wide_rule(self):
        from .models import Branch
        from .tests_compensation_ot import branch_login

        branch = Branch.objects.create(name="CCE Unit", code="CCEU")
        r = self.client.put(
            "/api/payroll-settings",
            {"staffNextMorningCutoff": "07:00"},
            content_type="application/json",
            **branch_login(branch),
        )
        self.assertEqual(r.status_code, 403)
        self.assertEqual(PayrollSettings.get().staff_next_morning_cutoff, time(6, 0))


class EmployeeFixtureTests(ClaimsEngineBase):
    def test_the_fixture_dates(self):
        self.assertEqual([d.weekday() for d in (MON, TUE, WED, THU, FRI, SAT, SUN)], [0, 1, 2, 3, 4, 5, 6])
        self.assertEqual(Employee.objects.get(pk=self.emp.pk).employment_type, "staff")
        self.assertEqual(compute_day_record(self.emp, MON, settings=PayrollSettings.get()).status, "absent")


# ── review fixes (2026-11-19) ───────────────────────────────────────────────


class ReviewFixBirthdayTests(ClaimsEngineBase):
    """Security #1 (engine) / #3, correctness #1 / #2 / #10: one benefit per birthday, reads never write, a Casual Leave
    is free only on a birthday nobody worked, a rejected Casual Leave leaves an unworked birthday paid."""

    def setUp(self):
        super().setUp()
        self.on(birthday_enabled=True)
        self.emp.date_of_birth = date(1990, 3, 5)  # Thursday 5 March 2026
        self.emp.save()

    def test_an_approved_birthday_credit_is_never_also_a_paid_birthday_leave(self):
        self.worked(THU, time(17, 30))
        self.rec(THU)
        self.claim("birthday", THU, status="approved", shifts="1.00")
        AttendanceLog.objects.filter(employee=self.emp, date=THU).delete()  # the punches were corrected away
        r = self.rec(THU)
        self.assertEqual((r.status, r.shifts_earned, r.compensation_kind), ("absent", Decimal("0.00"), ""))

    def test_a_birthday_list_read_never_rewrites_a_view_only_or_locked_day(self):
        from .tests_compensation_claims import _hr, _hr_user

        view_only = _hr(_hr_user("rev_bd_view", {"compensation": "view"}))
        admin = base.hr_headers()
        stored = AttendanceDayRecord.objects.create(
            employee=self.emp, date=THU, status="absent", shifts_earned=Decimal("0")
        )
        self.log(THU, time(8, 30), time(17, 30))  # punches that arrived after the day was stored
        params = {"period": "month", "date": THU.isoformat()}

        def now():
            return AttendanceDayRecord.objects.get(pk=stored.pk)

        r = self.client.get("/api/compensation/birthdays", params, **view_only)
        self.assertEqual(r.status_code, 200)
        self.assertEqual((now().status, now().shifts_earned), ("absent", Decimal("0.00")))  # a view-only read: no write
        self.lock_march()
        self.assertEqual(self.client.get("/api/compensation/birthdays", params, **admin).status_code, 200)
        self.assertEqual(now().status, "absent")  # Payroll Done: never rewritten, whoever reads
        PayrollMonthClose.objects.all().delete()
        self.client.get("/api/compensation/birthdays", params, **admin)
        self.assertEqual(now().status, "present")  # a login that may edit works the stale day out

    def test_a_casual_leave_is_free_only_on_a_birthday_nobody_worked(self):
        from . import cl_balance

        CasualLeaveRequest.objects.create(employee=self.emp, date=THU, portion="first_half", status="approved")

        def held():
            return cl_balance.parts([self.emp.id], date(2026, 1, 1), date(2026, 12, 31))[self.emp.id]

        self.assertEqual([p.birthday for p in held()], [True])  # not worked: paid birthday leave, no balance used
        self.log(THU, time(14, 0), time(17, 35))  # worked the second half
        self.assertEqual([p.birthday for p in held()], [False])  # worked: the Casual Leave counts like any other
        r = compute_range_records(self.emp, THU, THU, PayrollSettings.get())[0]
        self.assertEqual(r.compensation_kind, "")
        self.assertEqual(effects.birthday_outcome(self.emp, THU)["outcome"], "credit_claimable")

    def test_a_rejected_casual_leave_leaves_an_unworked_birthday_paid(self):
        from .casual_leave_views import _write_attendance_for_cl

        cl = CasualLeaveRequest.objects.create(employee=self.emp, date=THU, portion="full", status="rejected")
        _write_attendance_for_cl(cl, "HOD")
        r = AttendanceDayRecord.objects.get(employee=self.emp, date=THU)
        self.assertEqual(
            (r.status, r.shifts_earned, r.source, r.compensation_kind), ("present", Decimal("1.00"), "auto", "birthday")
        )
        self.assertEqual(effects.birthday_outcome(self.emp, THU)["outcome"], "paid_leave")

    def test_a_manual_verdict_clears_the_marker_and_a_stale_marker_is_not_trusted(self):
        from .casual_leave_views import _write_attendance_for_cl

        self.log(THU, time(8, 30), time(17, 30))
        self.rec(THU)
        cl = CasualLeaveRequest.objects.create(employee=self.emp, date=THU, portion="full", status="rejected")
        _write_attendance_for_cl(cl, "HOD")  # worked, so an ordinary rejected Casual Leave: manual on_leave
        r = AttendanceDayRecord.objects.get(employee=self.emp, date=THU)
        self.assertEqual((r.source, r.status, r.compensation_kind, r.compensation_note), ("manual", "on_leave", "", ""))
        # a row some other hand left with the marker but less than a full day is not a paid birthday leave
        AttendanceDayRecord.objects.filter(pk=r.pk).update(compensation_kind="birthday")
        AttendanceLog.objects.filter(employee=self.emp, date=THU).delete()
        self.assertNotEqual(effects.birthday_outcome(self.emp, THU)["outcome"], "paid_leave")


class ReviewFixOtTests(ClaimsEngineBase):
    """Correctness #3 / #11c: under the quarters rule below a quarter is nothing (never the ladder); an approved Type 1
    claim follows the master switch only."""

    def record(self, minutes, suggested="0.50", d=MON):
        return OvertimeRecord.objects.create(
            employee=self.emp,
            date=d,
            shift_end_time=time(17, 30),
            last_punch_out=time(19, 10),
            ot_minutes=minutes,
            ot_type=OvertimeRecord.OT_TYPE_SHIFT,
            status=OvertimeRecord.STATUS_DETECTED,
            suggested_shifts=Decimal(suggested),
        )

    def test_below_a_quarter_under_the_quarters_rule_is_no_credit(self):
        from . import compensation_claims as claims_mod

        self.on(shift_enabled=True)
        rec = self.record(100)  # 100 min of a 480 min shift: below a quarter
        self.assertEqual(claims_mod.ot_credit(rec), Decimal("0.00"))
        self.assertEqual(claims_mod.ot_credit(self.record(250, d=TUE)), Decimal("0.50"))  # the quarters credit
        base.set_config(ot_quarter_rule=False)  # the rule off: the ladder's suggestion
        self.assertEqual(claims_mod.ot_credit(OvertimeRecord.objects.get(pk=rec.pk)), Decimal("0.50"))
        base.set_config(ot_quarter_rule=True, claims_from=WED)  # before the claims date: the ladder
        self.assertEqual(claims_mod.ot_credit(OvertimeRecord.objects.get(pk=rec.pk)), Decimal("0.50"))

    def test_an_approved_allowance_claim_follows_the_master_switch_only(self):
        self.on(allowance_enabled=True, shift_enabled=True)
        self.worked(MON, time(18, 45))
        self.log(TUE, time(8, 55), time(13, 0), time(14, 0), time(17, 30))  # late by 15 minutes
        record = self.allowance_record()
        self.claim("ot_allowance", MON, record=record, minutes=30)
        base.set_config(allowance_enabled=False)  # Type 1 switched off after the HOD granted it
        r = self.rec(TUE)
        self.assertEqual((r.is_late, r.compensation_kind), (False, "ot_allowance"))
        self.settings(compensation_feature_enabled=False)  # the master switch stops everything
        self.assertTrue(self.rec(TUE).is_late)


class ReviewFixHistoryTests(ClaimsEngineBase):
    """Correctness #4: the staff next-morning rule and the quarters rule keep a dated history, so a change in Settings
    never re-judges a day before it."""

    def setUp(self):
        super().setUp()
        self.headers = base.hr_headers()

    def resolved(self, d):
        from .shift_engine import resolve_day_punch_logs

        logs = list(AttendanceLog.objects.filter(employee=self.emp, date=d).order_by("punch_time"))
        return [
            p.punch_time.strftime("%H:%M") for p in resolve_day_punch_logs(self.emp, d, logs, PayrollSettings.get())
        ]

    def put_payroll(self, today, **body):
        with mock.patch("api.clock.ist_today", return_value=today):
            r = self.client.put("/api/payroll-settings", body, content_type="application/json", **self.headers)
        self.assertEqual(r.status_code, 200, r.content)
        return r.json()

    def test_switching_the_next_morning_rule_off_keeps_the_days_before_it(self):
        self.log(WED, time(8, 30))  # left open
        self.log(THU, time(5, 30), time(8, 30), time(17, 30))
        self.log(FRI, time(8, 30))  # left open
        self.log(SAT, time(5, 30), time(8, 30), time(17, 30))
        self.assertEqual(self.resolved(WED), ["08:30", "05:30"])
        body = self.put_payroll(FRI, staffNextMorningEnabled=False)
        self.assertEqual(
            body["staffNextMorningHistory"],
            [
                {"from": CLAIMS_FROM.isoformat(), "enabled": True, "cutoff": "06:00"},
                {"from": FRI.isoformat(), "enabled": False, "cutoff": "06:00"},
            ],
        )
        self.assertEqual(self.resolved(WED), ["08:30", "05:30"])  # judged before the change: unchanged
        self.assertEqual(self.resolved(THU), ["08:30", "17:30"])
        self.assertEqual(self.resolved(FRI), ["08:30"])  # from the change: the old rule (05:30 is not 02:30 or earlier)
        # switched back on the next week: the days while it was off stay off
        self.put_payroll(base.MON2, staffNextMorningEnabled=True)
        self.assertEqual(self.resolved(FRI), ["08:30"])

    def test_a_new_cut_off_applies_from_the_day_it_is_set(self):
        self.log(WED, time(8, 30))
        self.log(THU, time(5, 30), time(8, 30), time(17, 30))
        self.log(FRI, time(8, 30))
        self.log(SAT, time(5, 30), time(8, 30), time(17, 30))
        self.put_payroll(FRI, staffNextMorningCutoff="05:00")
        self.assertEqual(self.resolved(WED), ["08:30", "05:30"])  # 06:00 was in force for Wednesday
        self.assertEqual(self.resolved(FRI), ["08:30"])  # 05:30 is after Friday's 05:00

    def test_switching_the_quarters_rule_off_keeps_the_days_before_it(self):
        self.on(allowance_enabled=True, shift_enabled=True, relaxation_enabled=True, pay_enabled=True)
        self.worked(MON, time(19, 30))  # 120 minutes: a quarter
        self.worked(THU, time(19, 30))
        with mock.patch("api.compensation_settings_views.ist_today", return_value=WED):
            r = self.client.put(
                "/api/compensation/settings",
                {"shift": {"quarterRule": False}},
                content_type="application/json",
                **self.headers,
            )
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(
            r.json()["shift"]["quarterRuleHistory"],
            [{"from": CLAIMS_FROM.isoformat(), "on": True}, {"from": WED.isoformat(), "on": False}],
        )
        self.month()
        rows = {row.date: row for row in detect_overtime_for_month(2026, 3)}
        self.assertEqual((rows[MON].ot_type, rows[MON].suggested_shifts), ("shift", Decimal("0.25")))  # quarters
        self.assertEqual((rows[THU].ot_type, rows[THU].allowance_minutes), ("allowance", 60))  # the old threshold

    def test_the_history_helpers(self):
        from .settings_history import appended, entry_on, moved_start

        history = [{"from": "2026-03-01", "on": True}]
        self.assertIsNone(entry_on(history, date(2026, 2, 28)))  # before every entry: the old rule
        history = appended(history, {"on": False}, date(2026, 3, 4))
        history = appended(history, {"on": True}, date(2026, 3, 4))  # the last change of a day wins
        self.assertEqual(history, [{"from": "2026-03-01", "on": True}, {"from": "2026-03-04", "on": True}])
        history = appended(history, {"on": False}, date(2026, 3, 9))
        self.assertFalse(entry_on(history, date(2026, 3, 10))["on"])
        self.assertEqual(
            moved_start(history, date(2026, 3, 5)),
            [{"from": "2026-03-05", "on": True}, {"from": "2026-03-09", "on": False}],
        )
        self.assertEqual(entry_on([{"from": None, "on": True}], date(2000, 1, 1)), {"from": None, "on": True})


class ReviewFixNightTests(ClaimsEngineBase):
    """Correctness #7 / #8: a punch on day D re-judges D + 1 too (staff), and a double tap counts once in the odd / even
    decision."""

    def test_a_double_tap_exit_does_not_leave_the_day_open(self):
        self.log(MON, time(8, 30), time(13, 0), time(14, 0), time(17, 40), time(17, 42))  # the exit pressed twice
        self.log(TUE, time(5, 45), time(8, 30), time(17, 30))
        self.assertEqual(self.rec(MON).last_punch, time(17, 42))
        self.assertEqual(self.rec(TUE).first_punch, time(5, 45))  # Tuesday's own early arrival

    def test_saving_a_punch_re_judges_the_next_day_too(self):
        from .attendance_refresh import refresh_after_punches

        self.log(WED, time(8, 30), time(13, 0), time(14, 0))  # left open
        self.log(THU, time(5, 30), time(8, 30), time(17, 30))
        compute_range_records(self.emp, WED, THU, PayrollSettings.get())
        self.assertEqual(self.stored(THU).first_punch, time(8, 30))  # 05:30 ended Wednesday
        self.log(WED, time(17, 40))  # Wednesday's exit arrives late: Wednesday is closed now
        with mock.patch("api.attendance_refresh.ist_today", return_value=date(2026, 3, 10)):
            self.assertEqual(refresh_after_punches([(self.emp.id, WED)]), 1)
        self.assertEqual(self.stored(THU).first_punch, time(5, 30))

    def test_the_stale_pass_re_judges_the_next_day_too(self):
        from .overtime import recompute_stale_days

        self.log(WED, time(8, 30), time(13, 0), time(14, 0))
        self.log(THU, time(5, 30), time(8, 30), time(17, 30))
        compute_range_records(self.emp, WED, THU, PayrollSettings.get())
        self.log(WED, time(17, 40))
        recompute_stale_days(MON, FRI, employee_ids=[self.emp.id])
        self.assertEqual(self.stored(THU).first_punch, time(5, 30))


class ReviewFixReportTests(ClaimsEngineBase):
    """Correctness #9: the Compensation reports agree with Credits / Balance."""

    def test_credited_ot_and_every_ledger_credit_are_reported(self):
        self.on(shift_enabled=True, relaxation_enabled=True, holiday_work_enabled=True, birthday_enabled=True)
        record = OvertimeRecord.objects.create(
            employee=self.emp,
            date=MON,
            shift_end_time=time(17, 30),
            last_punch_out=time(21, 30),
            ot_minutes=240,
            ot_type=OvertimeRecord.OT_TYPE_SHIFT,
            status=OvertimeRecord.STATUS_ANNOUNCED,
            compensation_type=OvertimeRecord.TYPE_RELAXATION,
            shifts=Decimal("0.50"),
            claim_date=None,  # credited to the balance (an approved claim)
        )
        CompensationLedger.objects.create(
            employee=self.emp,
            entry_type="credit",
            shifts=Decimal("0.50"),
            date=MON,
            source="ot_shift",
            overtime_record=record,
        )
        CompensationLedger.objects.create(
            employee=self.emp, entry_type="credit", shifts=Decimal("1.00"), date=THU, source="birthday"
        )
        r = self.client.get(
            "/api/compensation/reports",
            {"period": "month", "date": MON.isoformat(), "type": "ot_shift_relaxation,holiday_work"},
            **base.hr_headers(),
        )
        self.assertEqual(r.status_code, 200, r.content)
        sections = {s["type"]: s for s in r.json()["sections"]}
        relax = sections["ot_shift_relaxation"]
        self.assertEqual([(row["workDate"], row["status"]) for row in relax["rows"]], [(MON.isoformat(), "credited")])
        self.assertEqual(relax["summary"]["credited"], 1)
        work = sections["holiday_work"]
        self.assertEqual(
            sorted((c["date"], c["shifts"], c["reason"]) for c in work["credits"]),
            [(MON.isoformat(), 0.5, "OT shift credit"), (THU.isoformat(), 1.0, "Birthday credit")],
        )
        self.assertEqual(work["summary"]["creditedShifts"], 1.5)

"""Penalty Early Out (owner 2026-11-13): leaving MORE than early_out_penalty_minutes (75) before the shift end takes
early_out_penalty_deduction (0.25) of a shift off the day, separately from the late pool; leaving early by up to that many
minutes stays an ordinary Evening Early-Out. Plus: today's evening edge is judged only once the shift is over.

Run via: python manage.py test api.tests_penalty_early_out
"""

from datetime import date, datetime, time
from decimal import Decimal
from types import SimpleNamespace
from unittest import mock

from django.test import TestCase

from . import attendance_refresh
from .attendance_final import compute_day_record, late_pool_summary, penalty_early_out_check
from .clock import FACTORY_TZ
from .jwt_utils import sign_token
from .models import (
    AttendanceDayRecord,
    AttendanceLog,
    Branch,
    Employee,
    EmployeePermission,
    EmployeeShiftAssignment,
    HRUser,
    PayrollSettings,
    Role,
    ShiftTemplate,
)
from .payroll_views import _generate_staff_payroll

DAY = date(2026, 10, 20)  # a Tuesday
TODAY = date(2026, 11, 13)  # a Friday


def _bearer(payload: dict) -> dict:
    return {"HTTP_AUTHORIZATION": f"Bearer {sign_token(payload)}"}


def _admin():
    admin, _ = HRUser.objects.get_or_create(
        username="penalty_admin", defaults={"password_hash": "x", "is_super_admin": True}
    )
    return admin


def secs(hh, mm):
    return hh * 3600 + mm * 60


class RuleTests(TestCase):
    """penalty_early_out_check alone: shift 09:00-18:00, grace 10."""

    shift = SimpleNamespace(start_time=time(9, 0), end_time=time(18, 0), grace_period_minutes=10)

    def settings(self, **kw):
        base = dict(
            early_out_penalty_enabled=True,
            early_out_penalty_minutes=75,
            early_out_penalty_deduction=Decimal("0.25"),
            early_out_penalty_from="shift_end",
        )
        base.update(kw)
        return SimpleNamespace(**base)

    def test_exactly_the_minutes_is_not_a_penalty_one_more_is(self):
        self.assertEqual(penalty_early_out_check(secs(16, 45), self.shift, self.settings())[:2], (False, 75))
        hit, minutes, why = penalty_early_out_check(secs(16, 44), self.shift, self.settings())
        self.assertEqual((hit, minutes), (True, 76))
        self.assertIn("Penalty Early Out: last punch 16:44 is 76 min before the shift end 18:00", why)
        self.assertIn("0.25 shift deducted", why)

    def test_a_punch_counts_as_its_own_minute(self):
        self.assertEqual(penalty_early_out_check(secs(16, 45) + 59, self.shift, self.settings())[:2], (False, 75))

    def test_switched_off_it_still_says_how_early_but_never_penalises(self):
        self.assertEqual(
            penalty_early_out_check(secs(15, 0), self.shift, self.settings(early_out_penalty_enabled=False)),
            (False, 180, None),
        )

    def test_measured_from_the_early_out_deadline(self):
        s = self.settings(early_out_penalty_from="deadline")  # 18:00 - 10 = 17:50
        self.assertEqual(penalty_early_out_check(secs(16, 35), self.shift, s)[:2], (False, 75))
        hit, minutes, why = penalty_early_out_check(secs(16, 34), self.shift, s)
        self.assertEqual((hit, minutes), (True, 76))
        self.assertIn("Early-Out deadline", why)

    def test_an_announced_early_out_has_no_grace(self):
        announced = SimpleNamespace(
            start_time=time(9, 0), end_time=time(16, 10), grace_period_minutes=10
        )  # 16:00 + grace
        self.assertEqual(
            penalty_early_out_check(secs(14, 45), announced, self.settings(), window_early=time(16, 0))[:2], (False, 75)
        )
        self.assertTrue(penalty_early_out_check(secs(14, 44), announced, self.settings(), window_early=time(16, 0))[0])

    def test_a_shift_past_midnight_is_never_judged(self):
        night = SimpleNamespace(start_time=time(22, 0), end_time=time(6, 0), grace_period_minutes=10)
        self.assertEqual(penalty_early_out_check(secs(23, 0), night, self.settings()), (False, 0, None))


class EngineBase(TestCase):
    def setUp(self):
        ps = PayrollSettings.get()
        ps.attendance_mode = "simple"
        ps.morning_late_in_enabled = True
        ps.evening_early_out_enabled = True
        ps.early_out_penalty_enabled = True
        ps.early_out_penalty_minutes = 75
        ps.early_out_penalty_deduction = Decimal("0.25")
        ps.early_out_penalty_from = "shift_end"
        ps.early_out_penalty_in_late_pool = False
        ps.compensation_feature_enabled = False
        ps.save()
        self.shift = ShiftTemplate.objects.create(
            name="Penalty Shift",
            shift_type="staff",
            start_time=time(9, 0),
            end_time=time(18, 0),
            grace_period_minutes=10,
            first_half_end=time(13, 0),
            lunch_duration_minutes=60,
            lunch_grace_minutes=10,
        )
        self.emp = self.staff("PE1")

    def staff(self, code):
        emp = Employee.objects.create(
            employee_code=code,
            first_name="Pen",
            last_name=code,
            employment_type="staff",
            status="active",
            salary_amount=Decimal("27000"),
        )
        EmployeeShiftAssignment.objects.create(employee=emp, shift=self.shift, effective_from=date(2026, 1, 1))
        return emp

    def set(self, **kw):
        PayrollSettings.objects.filter(pk=PayrollSettings.get().pk).update(**kw)

    def punch(self, d, *times, emp=None):
        AttendanceLog.objects.filter(employee=emp or self.emp, date=d).delete()
        for t in times:
            AttendanceLog.objects.create(employee=emp or self.emp, date=d, punch_time=t, punch_type="IN", source="test")

    def judge(self, d=DAY, emp=None):
        return compute_day_record(emp or self.emp, d, settings=PayrollSettings.get())


class EngineTests(EngineBase):
    def test_leaving_more_than_75_min_early_loses_a_quarter_and_is_not_a_pool_mark(self):
        self.punch(DAY, time(9, 0), time(16, 30))
        rec = self.judge()
        self.assertEqual(
            (
                rec.status,
                rec.shifts_earned,
                rec.penalty_early_out,
                rec.penalty_deduction,
                rec.early_leave,
                rec.early_out_minutes,
            ),
            ("present", Decimal("0.75"), True, Decimal("0.25"), False, 90),
        )
        self.assertIn("Penalty Early Out", rec.late_reason)
        self.assertNotIn("Evening Early-Out", rec.late_reason)
        self.assertEqual(late_pool_summary([rec], 0, PayrollSettings.get())["early_out"], 0)

    def test_leaving_early_within_75_minutes_stays_an_ordinary_early_out(self):
        self.punch(DAY, time(9, 0), time(16, 45))
        rec = self.judge()
        self.assertEqual(
            (rec.shifts_earned, rec.penalty_early_out, rec.early_leave, rec.early_out_minutes),
            (Decimal("1.00"), False, True, 75),
        )
        self.assertEqual(late_pool_summary([rec], 0, PayrollSettings.get())["early_out"], 1)

    def test_the_penalty_works_with_the_early_out_switch_off(self):
        self.set(evening_early_out_enabled=False)
        self.punch(DAY, time(9, 0), time(16, 30))
        rec = self.judge()
        self.assertEqual((rec.shifts_earned, rec.penalty_early_out, rec.early_leave), (Decimal("0.75"), True, False))
        self.punch(DAY, time(9, 0), time(17, 0))
        rec = self.judge()
        self.assertEqual(
            (rec.shifts_earned, rec.penalty_early_out, rec.early_leave, rec.early_out_minutes),
            (Decimal("1.00"), False, False, 0),
        )

    def test_switched_off_nothing_changes(self):
        self.set(early_out_penalty_enabled=False)
        self.punch(DAY, time(9, 0), time(16, 30))
        rec = self.judge()
        self.assertEqual(
            (rec.shifts_earned, rec.penalty_early_out, rec.penalty_deduction, rec.early_leave, rec.early_out_minutes),
            (Decimal("1.00"), False, Decimal("0.00"), True, 90),
        )

    def test_settings_can_also_count_it_in_the_late_pool(self):
        self.set(early_out_penalty_in_late_pool=True)
        self.punch(DAY, time(9, 0), time(16, 30))
        rec = self.judge()
        self.assertEqual((rec.shifts_earned, rec.penalty_early_out, rec.early_leave), (Decimal("0.75"), True, True))
        self.assertIn("late pool", rec.late_reason)
        self.assertEqual(late_pool_summary([rec], 0, PayrollSettings.get())["early_out"], 1)

    def test_a_half_day_is_not_also_a_penalty(self):
        self.punch(DAY, time(9, 0), time(13, 0))  # nothing at/after 14:30
        rec = self.judge()
        self.assertEqual((rec.status, rec.shifts_earned, rec.penalty_early_out), ("half_shift", Decimal("0.50"), False))

    def test_a_quarter_arrival_and_a_penalty_both_come_off(self):
        self.punch(DAY, time(10, 40), time(16, 30))
        rec = self.judge()
        self.assertEqual(
            (rec.arrival_zone, rec.penalty_early_out, rec.shifts_earned), ("quarter", True, Decimal("0.50"))
        )

    def test_an_approved_evening_early_out_permission_moves_the_end_first(self):
        EmployeePermission.objects.create(
            employee=self.emp, date=DAY, type=EmployeePermission.TYPE_EVENING_EARLY_OUT, status="approved"
        )
        self.punch(DAY, time(9, 0), time(16, 30))  # 30 min before the permitted 17:00
        rec = self.judge()
        self.assertEqual((rec.penalty_early_out, rec.shifts_earned), (False, Decimal("1.00")))
        self.punch(DAY, time(9, 0), time(15, 30))  # 90 min before 17:00
        rec = self.judge()
        self.assertEqual((rec.penalty_early_out, rec.shifts_earned, rec.early_out_minutes), (True, Decimal("0.75"), 90))
        self.assertIn("approved Evening Early-Out permission", rec.late_reason)

    def test_own_minutes_and_deduction(self):
        self.set(early_out_penalty_minutes=30, early_out_penalty_deduction=Decimal("0.50"))
        self.punch(DAY, time(9, 0), time(17, 20))
        rec = self.judge()
        self.assertEqual(
            (rec.penalty_early_out, rec.shifts_earned, rec.penalty_deduction), (True, Decimal("0.50"), Decimal("0.50"))
        )

    def test_measured_from_the_deadline(self):
        self.set(early_out_penalty_from="deadline")
        self.punch(DAY, time(9, 0), time(16, 35))
        self.assertFalse(self.judge().penalty_early_out)
        self.punch(DAY, time(9, 0), time(16, 34))
        self.assertTrue(self.judge().penalty_early_out)

    def test_a_single_punch_is_never_judged(self):
        self.punch(DAY, time(15, 0))
        self.assertFalse(self.judge().penalty_early_out)


class TodayTests(EngineBase):
    """Today the evening edge waits for the end of the shift (18:00 + 10 min grace)."""

    def at(self, hh, mm):
        mock.patch.stopall()
        for target, value in (
            ("api.attendance_final.ist_today", TODAY),
            ("api.attendance_final.ist_now", datetime(2026, 11, 13, hh, mm)),
        ):
            patch = mock.patch(target, return_value=value)
            patch.start()
            self.addCleanup(patch.stop)

    def test_a_lunch_punch_is_neither_an_early_out_nor_a_penalty(self):
        self.at(13, 5)
        self.punch(TODAY, time(9, 0), time(13, 0))
        rec = self.judge(TODAY)
        self.assertEqual(
            (rec.status, rec.early_leave, rec.penalty_early_out, rec.shifts_earned),
            ("present", False, False, Decimal("1.00")),
        )
        self.assertEqual(rec.provisional_until, datetime(2026, 11, 13, 18, 11, tzinfo=FACTORY_TZ))

    def test_the_penalty_is_decided_once_the_shift_is_over(self):
        self.punch(TODAY, time(9, 0), time(15, 0))
        self.at(16, 0)
        rec = self.judge(TODAY)
        self.assertEqual((rec.penalty_early_out, rec.shifts_earned), (False, Decimal("1.00")))
        self.at(18, 10)  # the grace's last minute still counts as the shift
        self.assertFalse(self.judge(TODAY).penalty_early_out)
        self.at(18, 11)
        rec = self.judge(TODAY)
        self.assertEqual(
            (rec.penalty_early_out, rec.shifts_earned, rec.provisional_until), (True, Decimal("0.75"), None)
        )

    def test_the_background_pass_judges_a_provisional_day_after_its_shift(self):
        self.punch(TODAY, time(9, 0), time(15, 0))
        self.at(16, 0)
        self.judge(TODAY)
        self.assertEqual(attendance_refresh.refresh_provisional(), 0, "not due before 18:11")

        self.at(18, 30)
        with mock.patch("django.utils.timezone.now", return_value=datetime(2026, 11, 13, 18, 30, tzinfo=FACTORY_TZ)):
            self.assertEqual(attendance_refresh.refresh_provisional(), 1)
            rec = AttendanceDayRecord.objects.get(employee=self.emp, date=TODAY)
            self.assertEqual(
                (rec.penalty_early_out, rec.shifts_earned, rec.provisional_until), (True, Decimal("0.75"), None)
            )
            self.assertEqual(attendance_refresh.refresh_provisional(), 0, "final now: nothing left to do")

    def test_a_morning_only_day_becomes_a_half_day_in_the_background(self):
        self.punch(TODAY, time(9, 0))
        self.at(11, 0)
        self.assertEqual(self.judge(TODAY).status, "present")
        self.at(19, 0)
        with mock.patch("django.utils.timezone.now", return_value=datetime(2026, 11, 13, 19, 0, tzinfo=FACTORY_TZ)):
            attendance_refresh.refresh_provisional()
        self.assertEqual(AttendanceDayRecord.objects.get(employee=self.emp, date=TODAY).status, "half_shift")


class PayrollTests(EngineBase):
    def test_the_penalty_is_in_the_paid_days_and_shown_on_its_own(self):
        self.punch(DAY, time(9, 0), time(16, 30))
        self.punch(date(2026, 10, 21), time(9, 0), time(18, 5))
        b = _generate_staff_payroll(self.emp, 10, 2026)["slip"].breakdown_details
        days = {d["date"]: d for d in b["days"]}
        self.assertEqual((days["2026-10-20"]["shiftsCompleted"], days["2026-10-20"]["isPenaltyEarlyOut"]), (0.75, True))
        self.assertEqual(days["2026-10-20"]["earlyOutMinutes"], 90)
        self.assertEqual(b["summary"]["workedDays"], 1.75)
        self.assertEqual((b["summary"]["penaltyEarlyOutDays"], b["summary"]["penaltyEarlyOutShifts"]), (1, 0.25))
        block = b["penaltyEarlyOut"]
        self.assertEqual((block["days"], block["shifts"], block["amount"]), (1, 0.25, 250.0))  # 27000 / 27 = 1000 a day
        self.assertEqual(b["deductions"]["lateSummary"]["earlyOutCount"], 0)
        self.assertEqual(b["deductions"]["total"], 0.0, "the penalty is in the paid days, never deducted a second time")


class SettingsApiTests(TestCase):
    def put(self, body, hdr=None):
        return self.client.put(
            "/api/payroll-settings",
            body,
            content_type="application/json",
            **(hdr or _bearer({"role": "hr", "hrUserId": _admin().id})),
        )

    def test_defaults_are_off_75_minutes_a_quarter(self):
        body = self.client.get("/api/payroll-settings", **_bearer({"role": "hr", "hrUserId": _admin().id})).json()
        self.assertEqual(
            [
                body[k]
                for k in (
                    "earlyOutPenaltyEnabled",
                    "earlyOutPenaltyMinutes",
                    "earlyOutPenaltyDeduction",
                    "earlyOutPenaltyFrom",
                    "earlyOutPenaltyInLatePool",
                )
            ],
            [False, 75, 0.25, "shift_end", False],
        )

    def test_a_valid_set_is_saved(self):
        r = self.put(
            {
                "earlyOutPenaltyEnabled": True,
                "earlyOutPenaltyMinutes": 90,
                "earlyOutPenaltyDeduction": 0.5,
                "earlyOutPenaltyFrom": "deadline",
                "earlyOutPenaltyInLatePool": True,
            }
        )
        self.assertEqual(r.status_code, 200, r.content)
        ps = PayrollSettings.get()
        self.assertEqual(
            (
                ps.early_out_penalty_enabled,
                ps.early_out_penalty_minutes,
                ps.early_out_penalty_deduction,
                ps.early_out_penalty_from,
                ps.early_out_penalty_in_late_pool,
            ),
            (True, 90, Decimal("0.50"), "deadline", True),
        )

    def test_nonsense_is_refused_and_nothing_is_saved(self):
        for body in (
            {"earlyOutPenaltyMinutes": 0},
            {"earlyOutPenaltyMinutes": 721},
            {"earlyOutPenaltyMinutes": "abc"},
            {"earlyOutPenaltyDeduction": 0},
            {"earlyOutPenaltyDeduction": 1.5},
            {"earlyOutPenaltyDeduction": 0.255},
            {"earlyOutPenaltyFrom": "lunch"},
            {"earlyOutPenaltyEnabled": "yes"},
            {"earlyOutPenaltyInLatePool": 1},
        ):
            self.assertEqual(self.put(body).status_code, 400, body)
        ps = PayrollSettings.get()
        self.assertEqual(
            (ps.early_out_penalty_enabled, ps.early_out_penalty_minutes, ps.early_out_penalty_from),
            (False, 75, "shift_end"),
        )

    def test_a_branch_login_cannot_change_it(self):
        branch = Branch.objects.create(name="Penalty Unit")
        role = Role.objects.create(name="Penalty Editor", permissions={"settings.attendance": "edit"})
        user = HRUser.objects.create(
            username="penalty_branch", password_hash="x", role=role, branch=branch, is_super_admin=False
        )
        for body in (
            {"earlyOutPenaltyEnabled": True},
            {"earlyOutPenaltyMinutes": 30},
            {"earlyOutPenaltyDeduction": 0.5},
        ):
            r = self.put(body, _bearer({"role": "hr", "hrUserId": user.id}))
            self.assertEqual(r.status_code, 403, body)
            self.assertEqual(r.json()["error"], "company_wide_rule")
        self.assertFalse(PayrollSettings.get().early_out_penalty_enabled)


class ReportTests(EngineBase):
    def test_the_penalty_early_out_report_lists_the_day_and_its_amount(self):
        self.punch(DAY, time(9, 0), time(16, 30))
        self.punch(date(2026, 10, 21), time(9, 0), time(16, 50))  # ordinary early-out: not listed
        self.judge()
        self.judge(date(2026, 10, 21))
        r = self.client.get(
            "/api/reports/run/penalty-early-out",
            {"dateFrom": "2026-10-01", "dateTo": "2026-10-31"},
            **_bearer({"role": "hr", "hrUserId": _admin().id}),
        )
        self.assertEqual(r.status_code, 200, r.content[:500])
        rows = [row for row in r.json()["rows"] if "_kind" not in row]
        self.assertEqual(len(rows), 1)
        row = rows[0]
        self.assertEqual(
            (
                row["date"],
                row["earlyMinutes"],
                row["shiftDeducted"],
                row["amount"],
                row["shiftsEarned"],
                row["inLatePool"],
            ),
            ("2026-10-20", 90, 0.25, 250.0, 0.75, "Not counted"),
        )

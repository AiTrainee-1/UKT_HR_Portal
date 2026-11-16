"""
The Report Log register's day card (owner 2026-11-16): beside the day's punches, the detected shift, the earned-shift
breakdown and the detections. Production arithmetic comes from production_shift_rules.explain_day, which must always
agree with evaluate_day (the one that decides the day); staff steps must always add up to the stored credit.

Run via: python manage.py test api.tests_report_log_day_detail --keepdb
"""

from datetime import date, time
from decimal import Decimal
from types import SimpleNamespace

from django.test import SimpleTestCase, TestCase

from . import production_shift_rules as psr
from .jwt_utils import sign_token
from .models import AttendanceDayRecord, AttendanceLog, Employee, EmployeeShiftAssignment, HRUser, ShiftTemplate
from .report_log_day_detail import detections, earned_breakdown
from .tests_production_shift_rules import SUN, WED, S, ruleset


def _sum(steps) -> Decimal:
    return sum((Decimal(s["shifts"]) for s in steps if s["kind"] in ("base", "minus", "plus", "pair")), Decimal("0"))


class ExplainDayTests(SimpleTestCase):
    """explain_day shows evaluate_day's own arithmetic, pair by pair."""

    def explain(self, punches, d=WED):
        return psr.explain_day(ruleset(), d, [S(p) for p in punches])

    def test_it_always_agrees_with_evaluate_day(self):
        rs = ruleset()
        for punches, d in [
            (["08:30", "17:45"], WED),
            (["08:30", "12:45", "13:30", "20:00"], WED),
            (["08:52", "15:30"], WED),
            (["21:00", "05:30+"], WED),
            (["08:30", "12:45", "13:30"], WED),
            (["08:30", "17:00"], SUN),
            (["08:30", "23:59"], SUN),
        ]:
            with self.subTest(punches=punches):
                secs = [S(p) for p in punches]
                decided = psr.evaluate_day(rs, d, secs)
                shown = psr.explain_day(rs, d, secs)
                self.assertEqual(shown["shifts"], f"{decided['shifts_earned']:.2f}")
                self.assertEqual(shown["group"], decided["rule_group"])
                self.assertEqual(shown["note"], decided["rule_note"])

    def test_each_pair_with_the_shift_it_adds(self):
        shown = self.explain(["08:30", "12:45", "13:30", "20:00"])
        self.assertEqual([(p["in"], p["out"]) for p in shown["pairs"]], [("08:30", "12:45"), ("13:30", "20:00")])
        self.assertEqual(len(shown["pairs"]), 2)
        self.assertEqual(sum(Decimal(p["shifts"]) for p in shown["pairs"]), Decimal(shown["pairTotal"]))
        self.assertIsNone(shown["unpaired"])
        self.assertEqual(shown["start"], "08:30")

    def test_an_unpaired_last_punch_and_a_next_morning_exit(self):
        self.assertEqual(self.explain(["08:30", "12:45", "13:30"])["unpaired"], "13:30")
        night = self.explain(["21:00", "05:30+"])
        self.assertTrue(night["pairs"][0]["outNextDay"])
        self.assertEqual(night["shifts"], "1.50")

    def test_no_punch_or_no_group_gives_nothing(self):
        self.assertIsNone(psr.explain_day(ruleset(), WED, []))


def _rec(**over):
    base = dict(
        shifts_earned=Decimal("1.00"), status="present", arrival_zone="on_time", source="auto", override_note=None,
        penalty_early_out=False, penalty_deduction=Decimal("0"), early_out_minutes=0, is_half_day_leave=False,
        compensation_kind="", compensation_note="", is_compensation_day=False, provisional_until=None, is_late=False,
        late_reason=None, early_leave=False, is_half_shift=False, morning_permission_applied=False,
        evening_permission_applied=False, morning_permission_excess=False, evening_permission_excess=False,
        middle_permission_today=False, ot_extra_minutes=0, employee=SimpleNamespace(employment_type="staff"),
    )
    base.update(over)
    return SimpleNamespace(**base)


SETTINGS = SimpleNamespace(arrival_quarter_deduction=Decimal("0.25"))


class StaffBreakdownTests(SimpleTestCase):
    def test_a_full_day(self):
        earned = earned_breakdown(_rec(), SETTINGS, None)
        self.assertEqual(earned["method"], "staff")
        self.assertEqual([(s["label"], s["shifts"]) for s in earned["steps"]], [("Full day", "1.00")])
        self.assertEqual(earned["total"], "1.00")

    def test_quarter_shift_and_penalty_early_out_add_up_to_the_stored_credit(self):
        rec = _rec(
            shifts_earned=Decimal("0.50"), arrival_zone="quarter", penalty_early_out=True,
            penalty_deduction=Decimal("0.25"), early_out_minutes=90,
        )
        earned = earned_breakdown(rec, SETTINGS, None)
        self.assertEqual(
            [(s["label"], s["shifts"]) for s in earned["steps"]],
            [
                ("Full day", "1.00"),
                ("Arrived after the Late window (quarter shift)", "-0.25"),
                ("Penalty Early Out (90 min early)", "-0.25"),
            ],
        )
        self.assertEqual(_sum(earned["steps"]), Decimal(earned["total"]))

    def test_whatever_came_after_is_one_adjustment_so_it_always_adds_up(self):
        rec = _rec(status="half_shift", shifts_earned=Decimal("1.00"), compensation_kind="relaxation")
        earned = earned_breakdown(rec, SETTINGS, None)
        self.assertEqual(earned["steps"][0]["shifts"], "0.50")
        self.assertEqual(earned["steps"][-1], {"label": "Adjusted (compensation)", "shifts": "+0.50", "kind": "plus"})
        self.assertEqual(_sum(earned["steps"]), Decimal("1.00"))

    def test_a_day_set_by_hr(self):
        earned = earned_breakdown(_rec(source="manual", override_note="Machine fault"), SETTINGS, None)
        self.assertEqual(earned["method"], "manual")
        self.assertEqual(earned["note"], "Machine fault")


class ProductionStepsTests(SimpleTestCase):
    def test_pairs_shown_rounded_get_their_exact_sum_when_they_differ(self):
        from .report_log_day_detail import _production_steps

        explained = {
            "pairs": [
                {"in": "03:00", "out": "08:37", "countedIn": "03:00", "countedOut": "08:37", "outNextDay": False, "shifts": "0.01"},
                {"in": "12:46", "out": "13:36", "countedIn": "12:46", "countedOut": "13:36", "outNextDay": False, "shifts": "0.01"},
                {"in": "21:03", "out": "05:31", "countedIn": "21:03", "countedOut": "05:30", "outNextDay": True, "shifts": "1.48"},
            ],
            "unpaired": None, "minimumApplied": False, "minimumCredit": "0.00", "pairTotal": "1.51",
            "shifts": "1.51", "maxShifts": "3.00", "roundingStep": "0.01",
        }
        steps = _production_steps(explained)
        self.assertEqual(steps[2]["label"], "21:03 – 05:31 (next day), counted 21:03 – 05:30")
        self.assertEqual(steps[-1], {"label": "The pairs together, before rounding each", "shifts": "1.51", "kind": "note"})


class DetectionTests(SimpleTestCase):
    def test_what_the_engine_flagged(self):
        rec = _rec(
            is_late=True, late_reason="Late morning: arrived 09:40, deadline 09:15", early_leave=True,
            early_out_minutes=20, evening_permission_excess=True, ot_extra_minutes=45,
            compensation_kind="ot_allowance", compensation_note="Arrived 09:47, inside the 30 min allowance.",
        )
        found = {d["key"]: d for d in detections(rec, None)}
        self.assertEqual(found["late"]["detail"], "Late morning: arrived 09:40, deadline 09:15")
        self.assertEqual(found["early_out"]["detail"], "Left 20 min early")
        self.assertIn("permission_evening_excess", found)
        self.assertEqual(found["ot"]["detail"], "45 min")
        self.assertEqual(found["compensation"]["tone"], "good")

    def test_a_clean_day_has_none(self):
        self.assertEqual(detections(_rec(), None), [])


class DayCardEndpointTests(TestCase):
    """The day-punches answer carries the detail beside the punches."""

    def setUp(self):
        self.admin = HRUser.objects.create(username="dd_admin", password_hash="x", is_super_admin=True)
        shift = ShiftTemplate.objects.create(
            name="General", shift_type="staff", start_time=time(9, 0), end_time=time(18, 0), grace_period_minutes=15,
            first_half_end=time(13, 30), lunch_duration_minutes=60, lunch_grace_minutes=10,
        )
        self.emp = Employee.objects.create(
            employee_code="DD-1", first_name="Devi", last_name="D", employment_type="staff", status="active",
        )
        EmployeeShiftAssignment.objects.create(employee=self.emp, shift=shift, effective_from=date(2020, 1, 1))
        for t in (time(8, 55), time(18, 5)):
            AttendanceLog.objects.create(employee=self.emp, date=date(2026, 8, 3), punch_time=t, punch_type="IN")

    def test_the_card_has_the_shift_the_breakdown_and_the_detections(self):
        resp = self.client.get(
            "/api/attendance/report-log/day-punches",
            {"employeeId": self.emp.id, "date": "2026-08-03"},
            HTTP_AUTHORIZATION=f"Bearer {sign_token({'role': 'hr', 'hrUserId': self.admin.id})}",
        )
        self.assertEqual(resp.status_code, 200, resp.content)
        data = resp.json()
        self.assertEqual(data["count"], 2)
        self.assertEqual(data["shift"]["name"], "General")
        self.assertEqual((data["shift"]["start"], data["shift"]["end"], data["shift"]["graceMinutes"]), ("09:00", "18:00", 15))
        rec = AttendanceDayRecord.objects.get(employee=self.emp, date=date(2026, 8, 3))
        self.assertEqual(data["earned"]["total"], f"{rec.shifts_earned:.2f}")
        self.assertEqual(data["earned"]["method"], "staff")
        self.assertEqual(_sum(data["earned"]["steps"]), Decimal(data["earned"]["total"]))
        self.assertIsInstance(data["detections"], list)

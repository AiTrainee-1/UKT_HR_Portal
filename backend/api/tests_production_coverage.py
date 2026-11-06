"""
Production pay-cycle changes (owner, 2026-11-06): an employee moved between Weekly, BiWeekly and Monthly is never paid
twice for the same working day and never loses one (production_coverage.py).

Calendar (2026; "today" is 10 March, so every period below has ended):
    Weekly    Monday weeks         2-8 Feb, 9-15 Feb, 16-22 Feb, 23 Feb-1 Mar, 2-8 Mar
    BiWeekly  first period 9 Feb   26 Jan-8 Feb, 9-22 Feb, 23 Feb-8 Mar
    Monthly   first period 2 Feb   5 Jan-1 Feb, 2 Feb-1 Mar   (four weeks)
Every worker earns 1 shift a day at Rs 500, so N paid days are N x 500.

Run via: python manage.py test api.tests_production_coverage -v 2
"""

from collections import Counter
from datetime import date, timedelta
from decimal import Decimal

from django.test import SimpleTestCase

from .models import Advance, AdvanceRepayment, AttendanceDayRecord, Branch, Employee, Payroll, Role, SalarySlip
from .payroll_views import _generate_production_payroll
from .production_coverage import (
    PeriodPlan,
    day_count,
    factor_json,
    fmt_range,
    merge,
    monthly_factor,
    parse_ranges,
    plan_period,
    spans_of_row,
    subtract,
)
from .tests_production_cycles import CycleDbTestCase, _hr, _row, _settings, _shifts, _worker

D = date
CYCLES_FEB = {
    "weekly": {"weekStart": "monday"},
    "biweekly": {"weekStart": "monday", "anchorDate": "2026-02-09"},
    "monthly": {"weekStart": "monday", "anchorDate": "2026-02-02"},
}
GEN = "/api/payroll/production/generate"
ASSIGN = "/api/employees/production/assign"
PREVIEW = "/api/employees/production/cycle-change-preview"


def _span(pk, start, end, cycle, status="pending", ranges=None):
    return spans_of_row(
        payroll_id=pk,
        salary_mode="shift",
        month=end.month,
        year=end.year,
        period_start=start,
        period_end=end,
        paid_ranges=ranges,
        pay_cycle=cycle,
        status=status,
    )


def _staff_span(pk, month, year, status="paid"):
    return spans_of_row(
        payroll_id=pk,
        salary_mode="monthly",
        month=month,
        year=year,
        period_start=None,
        period_end=None,
        paid_ranges=None,
        pay_cycle=None,
        status=status,
    )


def _iso(*pairs):
    return [{"from": a.isoformat(), "to": b.isoformat()} for a, b in pairs]


# ─────────────────────────────────────────────────────────────────────────────
#  The pure rules
# ─────────────────────────────────────────────────────────────────────────────


class RangeMathTests(SimpleTestCase):
    def test_merge_joins_overlapping_and_touching_ranges(self):
        self.assertEqual(
            merge([(D(2026, 2, 9), D(2026, 2, 15)), (D(2026, 2, 2), D(2026, 2, 8)), (D(2026, 2, 20), D(2026, 2, 21))]),
            [(D(2026, 2, 2), D(2026, 2, 15)), (D(2026, 2, 20), D(2026, 2, 21))],
        )

    def test_subtract_leaves_the_uncovered_parts(self):
        whole = (D(2026, 2, 2), D(2026, 3, 1))
        self.assertEqual(
            subtract(whole, [(D(2026, 2, 9), D(2026, 2, 22))]),
            [(D(2026, 2, 2), D(2026, 2, 8)), (D(2026, 2, 23), D(2026, 3, 1))],
        )
        self.assertEqual(subtract(whole, [(D(2026, 1, 1), D(2026, 3, 31))]), [])
        self.assertEqual(subtract(whole, []), [whole])

    def test_paid_ranges_are_read_defensively(self):
        raw = [{"from": "2026-02-09", "to": "2026-02-15"}, {"from": "bad"}, {"to": "2026-02-01"}, "x"]
        self.assertEqual(parse_ranges(raw), [(D(2026, 2, 9), D(2026, 2, 15))])
        self.assertEqual(parse_ranges(None), [])
        self.assertEqual(day_count([(D(2026, 2, 2), D(2026, 2, 8)), (D(2026, 2, 20), D(2026, 2, 20))]), 8)

    def test_dates_are_written_for_people(self):
        self.assertEqual(fmt_range(D(2026, 11, 9), D(2026, 11, 29)), "9 Nov – 29 Nov 2026")
        self.assertEqual(fmt_range(D(2025, 12, 29), D(2026, 1, 4)), "29 Dec 2025 – 4 Jan 2026")
        self.assertEqual(fmt_range(D(2026, 11, 9), D(2026, 11, 9)), "9 Nov 2026")


class PlanTests(SimpleTestCase):
    S, E = D(2026, 2, 2), D(2026, 3, 1)  # the Monthly period

    def test_no_history_pays_the_whole_period_as_an_ordinary_run(self):
        plan = plan_period([], self.S, self.E, "monthly")
        self.assertTrue(plan.is_plain)
        self.assertIsNone(plan.stored_ranges())
        self.assertIsNone(plan.note())
        self.assertEqual((plan.paid_days, plan.period_days), (28, 28))

    def test_the_row_being_generated_again_is_left_out(self):
        own = _span(7, self.S, self.E, "monthly", ranges=_iso((D(2026, 2, 9), D(2026, 3, 1))))
        weekly = _span(3, D(2026, 2, 2), D(2026, 2, 8), "weekly", status="paid")
        plan = plan_period([*own, *weekly], self.S, self.E, "monthly")
        self.assertEqual(plan.pay_ranges, [(D(2026, 2, 9), D(2026, 3, 1))])
        self.assertEqual([(p.start, p.end, p.row.payroll_id) for p in plan.already_paid], [(self.S, D(2026, 2, 8), 3)])
        self.assertEqual(plan.stored_ranges(), _iso((D(2026, 2, 9), D(2026, 3, 1))))

    def test_days_paid_in_the_middle_leave_two_pay_ranges(self):
        biweekly = _span(4, D(2026, 2, 9), D(2026, 2, 22), "biweekly")
        plan = plan_period(biweekly, self.S, self.E, "monthly")
        self.assertEqual(plan.pay_ranges, [(D(2026, 2, 2), D(2026, 2, 8)), (D(2026, 2, 23), D(2026, 3, 1))])
        self.assertEqual(plan.paid_days, 14)
        self.assertFalse(plan.catch_up)  # nothing was paid before the period

    def test_a_gap_after_another_cycle_is_caught_up_but_not_after_the_same_cycle(self):
        monthly = _span(1, D(2026, 1, 5), D(2026, 2, 1), "monthly")
        week = (D(2026, 2, 16), D(2026, 2, 22))
        moved = plan_period(monthly, *week, "weekly")
        self.assertEqual(
            [(c.start, c.end, c.row.cycle) for c in moved.catch_up], [(D(2026, 2, 2), D(2026, 2, 15), "monthly")]
        )
        self.assertEqual(moved.paid_ranges, [(D(2026, 2, 2), D(2026, 2, 22))])
        self.assertEqual((moved.pay_days, moved.catch_up_days, moved.paid_days), (7, 14, 21))
        # the same cycle skipping a week is an ordinary gap: that week is generated on its own, never added
        weekly = _span(2, D(2026, 2, 2), D(2026, 2, 8), "weekly")
        same = plan_period(weekly, *week, "weekly")
        self.assertTrue(same.is_plain)

    def test_after_a_row_from_before_the_cycles_the_gap_is_only_reported(self):
        legacy = _span(1, D(2026, 1, 5), D(2026, 1, 18), None)
        plan = plan_period(legacy, D(2026, 2, 2), D(2026, 2, 8), "weekly")
        self.assertTrue(plan.is_plain)
        self.assertEqual((plan.legacy_gap.start, plan.legacy_gap.end), (D(2026, 1, 19), D(2026, 2, 1)))
        self.assertIn("not added automatically", plan.note())

    def test_a_staff_month_covers_the_whole_calendar_month_and_its_gap_is_caught_up(self):
        january = _staff_span(9, 1, 2026)
        plan = plan_period(january, D(2026, 1, 26), D(2026, 2, 1), "weekly")
        self.assertEqual(plan.pay_ranges, [(D(2026, 2, 1), D(2026, 2, 1))])
        self.assertEqual(plan.already_paid[0].json()["kind"], "staff")
        december = _staff_span(8, 12, 2025)
        later = plan_period(december, D(2026, 2, 2), D(2026, 2, 8), "weekly")
        self.assertEqual([(c.start, c.end) for c in later.catch_up], [(D(2026, 1, 1), D(2026, 2, 1))])
        self.assertEqual(later.catch_up[0].json()["fromLabel"], "Staff Payroll")

    def test_a_fully_paid_period_is_refused_naming_the_payroll_that_paid_it(self):
        monthly = _span(5, self.S, self.E, "monthly", status="paid")
        plan = plan_period(monthly, D(2026, 2, 9), D(2026, 2, 22), "biweekly")
        self.assertTrue(plan.refused)
        self.assertEqual(
            plan.refusal_reason(),
            "Already paid: every day of 9 Feb – 22 Feb 2026 is already in the Monthly payroll for 2 Feb – 1 Mar 2026 "
            "(Cleared). Nothing is paid twice.",
        )

    def test_a_plan_from_bare_ranges_splits_catch_up_from_pay_days(self):
        plan = PeriodPlan.from_ranges(
            D(2026, 2, 16), D(2026, 2, 22), [(D(2026, 2, 2), D(2026, 2, 15)), (D(2026, 2, 16), D(2026, 2, 22))]
        )
        self.assertEqual(plan.pay_ranges, [(D(2026, 2, 16), D(2026, 2, 22))])
        self.assertEqual(plan.catch_up_ranges, [(D(2026, 2, 2), D(2026, 2, 15))])
        self.assertTrue(PeriodPlan.from_ranges(D(2026, 2, 2), D(2026, 2, 8), [(D(2026, 2, 2), D(2026, 2, 8))]).is_plain)


class MonthlyFactorTests(SimpleTestCase):
    def test_an_ordinary_row_keeps_its_cycles_factor(self):
        for cycle, factor in (("weekly", 4), ("biweekly", 2), ("monthly", 1), (None, 2)):
            self.assertEqual(monthly_factor(cycle), factor)
            self.assertIsInstance(monthly_factor(cycle), int)

    def test_a_part_period_is_scaled_by_its_own_days(self):
        self.assertEqual(monthly_factor("monthly", 21), Decimal(28) / Decimal(21))
        self.assertEqual(monthly_factor("monthly", 14), Decimal(2))
        self.assertEqual(monthly_factor("weekly", 21), Decimal(28) / Decimal(21))  # 7 days + 14 catch-up days
        self.assertEqual(monthly_factor("weekly", 7), 4)  # as many days as the cycle: unchanged
        self.assertEqual(factor_json(monthly_factor("monthly", 21)), 1.3333)
        self.assertEqual(factor_json(monthly_factor("monthly", 14)), 2)
        self.assertEqual(factor_json(4), 4)


# ─────────────────────────────────────────────────────────────────────────────
#  The six moves, end to end through the cycle endpoints
# ─────────────────────────────────────────────────────────────────────────────


class _MoveCase(CycleDbTestCase):
    def setUp(self):
        super().setUp()
        _settings(prod_cycles=CYCLES_FEB)

    def gen(self, cycle, start=None, end=None, emp=None, regenerate=False, expect=201):
        body = {"cycle": cycle}
        if start:
            body.update(periodStart=start.isoformat(), periodEnd=end.isoformat())
        if emp is not None:
            body["employeeIds"] = [emp.id]
        if regenerate:
            body["regenerate"] = True
        r = self.post(GEN, body)
        self.assertEqual(r.status_code, expect, r.content[:400])
        return r.json()

    def move(self, emp, cycle):
        r = self.post(ASSIGN, {"employeeIds": [emp.id], "cycle": cycle})
        self.assertEqual(r.json()["updated"], 1, r.content)

    def row(self, emp, start, end) -> Payroll:
        return Payroll.objects.get(employee=emp, period_start=start, period_end=end)

    def slip(self, emp, start, end) -> dict:
        return SalarySlip.objects.get(employee=emp, period_start=start, period_end=end).breakdown_details

    def assert_each_day_paid_once(self, emp, first, last):
        """Every day first..last is paid by exactly one payroll row, and no other day is paid at all."""
        paid = Counter()
        for p in Payroll.objects.filter(employee=emp, period_start__isnull=False):
            ranges = parse_ranges(p.paid_ranges) or [(p.period_start, p.period_end)]
            for a, b in ranges:
                day = a
                while day <= b:
                    paid[day] += 1
                    day += timedelta(days=1)
        expected = {first + timedelta(days=i) for i in range((last - first).days + 1)}
        self.assertEqual(set(paid), expected)
        self.assertEqual({d: n for d, n in paid.items() if n != 1}, {})

    def total_gross(self, emp) -> Decimal:
        return sum((p.gross_salary for p in Payroll.objects.filter(employee=emp)), Decimal("0"))


class SixMovesTests(_MoveCase):
    def test_weekly_to_biweekly_after_two_weekly_payrolls(self):
        w = _worker("WB1", cycle="weekly")
        _shifts(w, D(2026, 1, 26), D(2026, 3, 8))
        self.gen("weekly", D(2026, 2, 2), D(2026, 2, 8), w)
        self.gen("weekly", D(2026, 2, 9), D(2026, 2, 15), w)
        self.move(w, "biweekly")

        body = self.gen("biweekly", D(2026, 2, 9), D(2026, 2, 22), w)
        self.assertEqual(body["generated"], 1)
        cov = body["partialDetails"][0]["coverage"]
        self.assertEqual(cov["payRanges"], _iso((D(2026, 2, 16), D(2026, 2, 22))))
        self.assertEqual(
            [(p["from"], p["to"], p["cycle"]) for p in cov["alreadyPaid"]], [("2026-02-09", "2026-02-15", "weekly")]
        )
        row = self.row(w, D(2026, 2, 9), D(2026, 2, 22))
        self.assertEqual((row.gross_salary, row.total_working_days), (Decimal("3500.00"), 7))  # 16-22 Feb only
        self.assertEqual(row.paid_ranges, _iso((D(2026, 2, 16), D(2026, 2, 22))))
        bd = self.slip(w, D(2026, 2, 9), D(2026, 2, 22))
        self.assertEqual((bd["summary"]["totalDays"], bd["summary"]["periodDays"]), (7, 14))
        self.assertEqual((bd["dateFrom"], bd["dateTo"]), ("2026-02-16", "2026-02-22"))
        self.assertEqual([d["date"] for d in bd["days"]][0], "2026-02-16")

        # the next BiWeekly period is an ordinary one
        self.gen("biweekly", D(2026, 2, 23), D(2026, 3, 8), w)
        nxt = self.row(w, D(2026, 2, 23), D(2026, 3, 8))
        self.assertEqual((nxt.gross_salary, nxt.paid_ranges), (Decimal("7000.00"), None))
        self.assert_each_day_paid_once(w, D(2026, 2, 2), D(2026, 3, 8))
        self.assertEqual(self.total_gross(w), Decimal("17500.00"))  # 35 days x 500, every day once

    def test_weekly_to_monthly_pays_only_the_rest_of_the_month(self):
        w = _worker("WM1", cycle="weekly")
        _shifts(w, D(2026, 2, 2), D(2026, 3, 1))
        self.gen("weekly", D(2026, 2, 2), D(2026, 2, 8), w)
        self.move(w, "monthly")
        self.gen("monthly", D(2026, 2, 2), D(2026, 3, 1), w)
        row = self.row(w, D(2026, 2, 2), D(2026, 3, 1))
        self.assertEqual((row.gross_salary, row.pay_cycle), (Decimal("10500.00"), "monthly"))  # 9 Feb - 1 Mar = 21 days
        self.assertEqual(row.paid_ranges, _iso((D(2026, 2, 9), D(2026, 3, 1))))
        self.assertIn("2 Feb – 8 Feb 2026 already paid on Weekly", row.notes)
        self.assert_each_day_paid_once(w, D(2026, 2, 2), D(2026, 3, 1))
        self.assertEqual(self.total_gross(w), Decimal("14000.00"))  # 28 x 500

    def test_biweekly_to_weekly_refuses_weeks_already_paid(self):
        b = _worker("BW1", cycle="biweekly")
        _shifts(b, D(2026, 2, 2), D(2026, 3, 1))
        self.gen("biweekly", D(2026, 2, 9), D(2026, 2, 22), b)
        self.move(b, "weekly")
        refused = self.gen("weekly", D(2026, 2, 16), D(2026, 2, 22), b)
        self.assertEqual((refused["generated"], refused["skipped"]), (0, 1))
        self.assertEqual(
            refused["skippedDetails"][0]["reason"],
            "Already paid: every day of 16 Feb – 22 Feb 2026 is already in the BiWeekly payroll for 9 Feb – 22 Feb 2026 "
            "(pending). Nothing is paid twice.",
        )
        self.assertFalse(Payroll.objects.filter(employee=b, period_start=D(2026, 2, 16)).exists())
        self.gen("weekly", D(2026, 2, 2), D(2026, 2, 8), b)
        self.gen("weekly", D(2026, 2, 23), D(2026, 3, 1), b)
        for start, end in ((D(2026, 2, 2), D(2026, 2, 8)), (D(2026, 2, 23), D(2026, 3, 1))):
            row = self.row(b, start, end)
            self.assertEqual((row.gross_salary, row.paid_ranges), (Decimal("3500.00"), None))
        self.assert_each_day_paid_once(b, D(2026, 2, 2), D(2026, 3, 1))
        self.assertEqual(self.total_gross(b), Decimal("14000.00"))

    def test_biweekly_to_monthly_pays_the_days_on_both_sides(self):
        b = _worker("BM1", cycle="biweekly")
        _shifts(b, D(2026, 2, 2), D(2026, 3, 1))
        self.gen("biweekly", D(2026, 2, 9), D(2026, 2, 22), b)
        self.move(b, "monthly")
        body = self.gen("monthly", D(2026, 2, 2), D(2026, 3, 1), b)
        self.assertEqual(
            body["partialDetails"][0]["coverage"]["payRanges"],
            _iso((D(2026, 2, 2), D(2026, 2, 8)), (D(2026, 2, 23), D(2026, 3, 1))),
        )
        row = self.row(b, D(2026, 2, 2), D(2026, 3, 1))
        self.assertEqual((row.gross_salary, row.total_working_days), (Decimal("7000.00"), 14))
        self.assertEqual(self.slip(b, D(2026, 2, 2), D(2026, 3, 1))["deductions"]["monthlyEquivalentFactor"], 2)
        self.assert_each_day_paid_once(b, D(2026, 2, 2), D(2026, 3, 1))
        self.assertEqual(self.total_gross(b), Decimal("14000.00"))

    def test_monthly_to_weekly_catches_up_the_days_no_cycle_paid(self):
        # the owner's example: the next Monthly period was never generated, the employee moved to Weekly while Weekly
        # had already reached 16-22 Feb -> 2-15 Feb would be paid by neither cycle, so they are added to that week
        m = _worker("MW1", cycle="monthly")
        other = _worker("MW2", cycle="weekly")
        for emp in (m, other):
            _shifts(emp, D(2026, 1, 5), D(2026, 3, 1))
        self.gen("monthly", D(2026, 1, 5), D(2026, 2, 1), m)
        self.gen("weekly", D(2026, 2, 9), D(2026, 2, 15), other)  # Weekly's pointer is now 16-22 Feb
        self.move(m, "weekly")

        body = self.gen("weekly", emp=m)  # no period: the next due one
        self.assertEqual((body["periodStart"], body["periodEnd"]), ("2026-02-16", "2026-02-22"))
        cov = body["partialDetails"][0]["coverage"]
        self.assertEqual(
            [(c["from"], c["to"], c["fromCycle"], c["days"]) for c in cov["catchUp"]],
            [("2026-02-02", "2026-02-15", "monthly", 14)],
        )
        row = self.row(m, D(2026, 2, 16), D(2026, 2, 22))
        self.assertEqual((row.gross_salary, row.total_working_days), (Decimal("10500.00"), 21))  # 7 + 14 catch-up
        self.assertEqual(row.paid_ranges, _iso((D(2026, 2, 2), D(2026, 2, 22))))
        bd = self.slip(m, D(2026, 2, 16), D(2026, 2, 22))
        self.assertEqual(
            (bd["dateFrom"], bd["periodStart"], bd["summary"]["totalDays"]), ("2026-02-02", "2026-02-16", 21)
        )
        self.assertEqual(len(bd["days"]), 21)

        # the caught-up week cannot be paid again on its own; the next week is ordinary
        again = self.gen("weekly", D(2026, 2, 2), D(2026, 2, 8), m)
        self.assertIn("already in the Weekly payroll for 16 Feb – 22 Feb 2026", again["skippedDetails"][0]["reason"])
        self.gen("weekly", D(2026, 2, 23), D(2026, 3, 1), m)
        self.assertIsNone(self.row(m, D(2026, 2, 23), D(2026, 3, 1)).paid_ranges)
        self.assert_each_day_paid_once(m, D(2026, 1, 5), D(2026, 3, 1))
        self.assertEqual(self.total_gross(m), Decimal("28000.00"))  # 56 days x 500

    def test_monthly_to_biweekly_after_a_cleared_month(self):
        m = _worker("MB1", cycle="monthly")
        _shifts(m, D(2026, 2, 2), D(2026, 3, 8))
        self.gen("monthly", D(2026, 2, 2), D(2026, 3, 1), m)
        Payroll.objects.filter(employee=m).update(status="paid")
        self.move(m, "biweekly")
        refused = self.gen("biweekly", D(2026, 2, 9), D(2026, 2, 22), m)
        self.assertIn("the Monthly payroll for 2 Feb – 1 Mar 2026 (Cleared)", refused["skippedDetails"][0]["reason"])
        body = self.gen("biweekly", D(2026, 2, 23), D(2026, 3, 8), m)
        cov = body["partialDetails"][0]["coverage"]
        self.assertEqual(cov["payRanges"], _iso((D(2026, 3, 2), D(2026, 3, 8))))
        self.assertEqual(
            [(p["from"], p["to"], p["cycle"], p["status"]) for p in cov["alreadyPaid"]],
            [("2026-02-23", "2026-03-01", "monthly", "paid")],
        )
        self.assertEqual(self.row(m, D(2026, 2, 23), D(2026, 3, 8)).gross_salary, Decimal("3500.00"))
        month = self.row(m, D(2026, 2, 2), D(2026, 3, 1))
        self.assertEqual((month.status, month.gross_salary), ("paid", Decimal("14000.00")))  # untouched
        self.assert_each_day_paid_once(m, D(2026, 2, 2), D(2026, 3, 8))


# ─────────────────────────────────────────────────────────────────────────────
#  Generating again, money details, the views
# ─────────────────────────────────────────────────────────────────────────────


class RegenerationTests(_MoveCase):
    def setUp(self):
        super().setUp()
        self.w = _worker("RG1", cycle="weekly")
        _shifts(self.w, D(2026, 2, 2), D(2026, 3, 1))
        self.gen("weekly", D(2026, 2, 2), D(2026, 2, 8), self.w)
        self.move(self.w, "monthly")
        self.gen("monthly", D(2026, 2, 2), D(2026, 3, 1), self.w)
        self.month = (D(2026, 2, 2), D(2026, 3, 1))

    def test_generating_again_gives_the_same_days_pending_or_cleared(self):
        first = self.row(self.w, *self.month)
        self.gen("monthly", *self.month, self.w, regenerate=True)
        again = self.row(self.w, *self.month)
        self.assertEqual((again.gross_salary, again.paid_ranges), (first.gross_salary, first.paid_ranges))
        Payroll.objects.filter(pk=first.pk).update(status="paid")
        # a day the Weekly payroll paid changes: the Monthly payroll does not care; a day it pays changes: it follows
        AttendanceDayRecord.objects.filter(employee=self.w, date=D(2026, 2, 3)).update(shifts_earned=Decimal("2.00"))
        AttendanceDayRecord.objects.filter(employee=self.w, date=D(2026, 2, 10)).update(shifts_earned=Decimal("1.50"))
        body = self.gen("monthly", *self.month, self.w, regenerate=True)
        self.assertEqual(body["generated"], 1)
        cleared = self.row(self.w, *self.month)
        self.assertEqual((cleared.status, cleared.gross_salary), ("paid", Decimal("10750.00")))  # 20 + 1.5 shifts
        self.assertEqual(cleared.paid_ranges, _iso((D(2026, 2, 9), D(2026, 3, 1))))
        week = self.row(self.w, D(2026, 2, 2), D(2026, 2, 8))
        self.assertEqual(week.gross_salary, Decimal("3500.00"))  # never touched
        self.assert_each_day_paid_once(self.w, D(2026, 2, 2), D(2026, 3, 1))

    def test_a_plain_run_leaves_existing_payroll_alone_cleared_or_not(self):
        Payroll.objects.filter(employee=self.w, period_start=self.month[0]).update(status="paid")
        body = self.gen("monthly", *self.month)
        self.assertEqual((body["generated"], body["alreadyGenerated"], body["skipped"]), (0, 1, 0))


class PinnedOrdinaryRunTests(_MoveCase):
    def test_an_ordinary_run_is_exactly_what_it_was(self):
        w = _worker("PN1", cycle="weekly")
        _shifts(w, D(2026, 2, 2), D(2026, 2, 8))
        body = self.gen("weekly", D(2026, 2, 2), D(2026, 2, 8), w)
        self.assertEqual(body["partialDetails"], [])
        row = self.row(w, D(2026, 2, 2), D(2026, 2, 8))
        self.assertIsNone(row.paid_ranges)
        self.assertEqual(
            (row.total_working_days, row.present_days, row.gross_salary, row.deductions, row.final_salary, row.status),
            (7, Decimal("7.0"), Decimal("3500.00"), Decimal("0.00"), Decimal("3500.00"), "pending"),
        )
        self.assertEqual(row.notes, "Production period (2026-02-02 to 2026-02-08): 7.00 shifts x Rs500.00 = Rs3500.00.")
        bd = self.slip(w, D(2026, 2, 2), D(2026, 2, 8))
        self.assertEqual((bd["dateFrom"], bd["dateTo"]), ("2026-02-02", "2026-02-08"))
        self.assertEqual(
            bd["summary"], {"totalDays": 7, "periodDays": 7, "daysWorked": 7, "daysAbsent": 0, "totalShifts": 7.0}
        )
        self.assertEqual(
            (bd["payRanges"], bd["alreadyPaid"], bd["catchUp"]), (_iso((D(2026, 2, 2), D(2026, 2, 8))), [], [])
        )
        self.assertEqual(bd["deductions"]["monthlyEquivalentFactor"], 4)
        self.assertIsInstance(bd["deductions"]["monthlyEquivalentFactor"], int)

    def test_the_engine_gives_the_same_figures_with_or_without_the_whole_period_as_its_days(self):
        a, b = _worker("PN2", cycle="weekly", co_emp_enabled=True), _worker("PN3", cycle="weekly", co_emp_enabled=True)
        _settings(
            prod_esi_rules=[
                {"id": "e1", "label": "ESI", "basis": "total", "minAmount": 0, "maxAmount": 21000, "ratePercent": 0.75}
            ]
        )
        for emp in (a, b):
            _shifts(emp, D(2026, 2, 2), D(2026, 2, 8))
        one = _generate_production_payroll(a, D(2026, 2, 2), D(2026, 2, 8), pay_cycle="weekly")
        two = _generate_production_payroll(
            b, D(2026, 2, 2), D(2026, 2, 8), pay_cycle="weekly", pay_ranges=[(D(2026, 2, 2), D(2026, 2, 8))]
        )
        fields = ("gross_salary", "deductions", "final_salary", "total_working_days", "present_days", "paid_ranges")
        self.assertEqual([getattr(one["payroll"], f) for f in fields], [getattr(two["payroll"], f) for f in fields])
        self.assertEqual(one["slip"].esi_deduction, two["slip"].esi_deduction)


class StatutoryAndAdvanceTests(_MoveCase):
    ESI_12K = [{"id": "e1", "label": "ESI", "basis": "total", "minAmount": 0, "maxAmount": 12000, "ratePercent": 0.75}]

    def test_a_part_period_is_judged_on_its_month_equivalent(self):
        _settings(prod_esi_rules=self.ESI_12K)
        w = _worker("SF1", cycle="weekly", co_emp_enabled=True)
        _shifts(w, D(2026, 2, 2), D(2026, 3, 1))
        self.gen("weekly", D(2026, 2, 2), D(2026, 2, 8), w)
        self.move(w, "monthly")
        self.gen("monthly", D(2026, 2, 2), D(2026, 3, 1), w)
        slip = SalarySlip.objects.get(employee=w, period_start=D(2026, 2, 2), period_end=D(2026, 3, 1))
        ded = slip.breakdown_details["deductions"]
        # 21 days pay 10,500; scaled to 28 days that is 14,000 a month: above the 12,000 ESI ceiling
        self.assertEqual((ded["monthlyEquivalentFactor"], ded["monthlyEquivalent"]), (1.3333, 14000.0))
        self.assertEqual(slip.esi_deduction, Decimal("0.00"))
        # the same 10,500 earned over a whole four weeks is 10,500 a month, and ESI applies
        m = _worker("SF2", cycle="monthly", per_shift="375.00", co_emp_enabled=True)
        _shifts(m, D(2026, 2, 2), D(2026, 3, 1))
        self.gen("monthly", D(2026, 2, 2), D(2026, 3, 1), m)
        whole = SalarySlip.objects.get(employee=m, period_start=D(2026, 2, 2))
        self.assertEqual(
            (whole.gross_salary, whole.breakdown_details["deductions"]["monthlyEquivalentFactor"]),
            (Decimal("10500.00"), 1),
        )
        self.assertGreater(whole.esi_deduction, 0)

    def test_an_advance_instalment_is_never_deducted_twice_across_a_move(self):
        w = _worker("AD1", cycle="weekly")
        _shifts(w, D(2026, 2, 2), D(2026, 3, 1))
        adv = Advance.objects.create(
            employee=w,
            advance_type="general",
            amount=Decimal("1000"),
            status="approved",
            total_repaid=Decimal("0"),
            outstanding=Decimal("1000"),
        )
        AdvanceRepayment.objects.create(advance=adv, month=3, year=2026, amount=Decimal("1000"))
        self.gen("weekly", D(2026, 2, 23), D(2026, 3, 1), w)  # ends in March: takes March's instalment
        week = self.row(w, D(2026, 2, 23), D(2026, 3, 1))
        self.assertEqual(week.deductions, Decimal("1000.00"))
        self.move(w, "monthly")
        self.gen("monthly", D(2026, 2, 2), D(2026, 3, 1), w)  # also ends in March, pays 2-22 Feb
        month = self.row(w, D(2026, 2, 2), D(2026, 3, 1))
        self.assertEqual((month.gross_salary, month.deductions), (Decimal("10500.00"), Decimal("0.00")))
        self.gen("monthly", D(2026, 2, 2), D(2026, 3, 1), w, regenerate=True)
        self.assertEqual(self.row(w, D(2026, 2, 2), D(2026, 3, 1)).deductions, Decimal("0.00"))
        again = _generate_production_payroll(w, D(2026, 2, 23), D(2026, 3, 1), pay_cycle="weekly")["payroll"]
        self.assertEqual(again.deductions, Decimal("1000.00"))  # the week keeps what it took
        adv.refresh_from_db()
        self.assertEqual(adv.total_repaid, Decimal("1000.00"))
        self.assertEqual(sum(p.deductions for p in Payroll.objects.filter(employee=w)), Decimal("1000.00"))


class StaffToProductionTests(_MoveCase):
    def staff_month(self, emp, month, year):
        return Payroll.objects.create(
            employee=emp,
            salary_mode="monthly",
            month=month,
            year=year,
            base_salary=15000,
            gross_salary=15000,
            final_salary=15000,
            status="paid",
        )

    def test_days_of_a_staff_month_are_not_paid_again_on_production(self):
        e = _worker("ST1", cycle="weekly")
        _shifts(e, D(2026, 1, 26), D(2026, 2, 8))
        self.staff_month(e, 1, 2026)
        body = self.gen("weekly", D(2026, 1, 26), D(2026, 2, 1), e)
        cov = body["partialDetails"][0]["coverage"]
        self.assertEqual(cov["payRanges"], _iso((D(2026, 2, 1), D(2026, 2, 1))))
        self.assertEqual([p["label"] for p in cov["alreadyPaid"]], ["Staff Payroll"])
        self.assertEqual(self.row(e, D(2026, 1, 26), D(2026, 2, 1)).gross_salary, Decimal("500.00"))

    def test_a_month_no_payroll_paid_after_the_staff_one_is_caught_up(self):
        e = _worker("ST2", cycle="weekly")
        _shifts(e, D(2026, 1, 1), D(2026, 2, 8))
        self.staff_month(e, 12, 2025)
        self.gen("weekly", D(2026, 2, 2), D(2026, 2, 8), e)
        row = self.row(e, D(2026, 2, 2), D(2026, 2, 8))
        self.assertEqual(row.paid_ranges, _iso((D(2026, 1, 1), D(2026, 2, 8))))
        self.assertEqual(row.gross_salary, Decimal("19500.00"))  # 32 catch-up days + 7


class ReadViewsTests(_MoveCase):
    def setUp(self):
        super().setUp()
        self.w = _worker("RV1", cycle="weekly")
        self.full = _worker("RV2", cycle="weekly")
        for emp in (self.w, self.full):
            _shifts(emp, D(2026, 2, 2), D(2026, 3, 1))
        self.gen("weekly", D(2026, 2, 2), D(2026, 2, 8), self.w)
        _row(self.full, D(2026, 2, 2), D(2026, 3, 1), cycle=None)  # an old row already covering the whole month
        self.move(self.w, "monthly")
        self.move(self.full, "monthly")
        self.q = "cycle=monthly&periodStart=2026-02-02&periodEnd=2026-03-01"

    def test_the_roster_shows_which_days_each_employee_is_paid(self):
        # the old row is for this exact period: it IS the employee's payroll for it, not another payroll
        body = self.get(f"/api/payroll/production/period-status?{self.q}").json()
        by = {e["employeeCode"]: e for e in body["employees"]}
        cov = by["RV1"]["coverage"]
        self.assertEqual((cov["partial"], cov["payDays"], cov["periodDays"]), (True, 21, 28))
        self.assertEqual(cov["alreadyPaid"][0]["label"], "Weekly")
        self.assertIsNone(by["RV1"]["blockedReason"])
        self.assertIsNotNone(by["RV2"]["payroll"])

    def test_a_fully_paid_employee_is_blocked_with_the_reason_and_the_skip_check_lists_part_payers(self):
        Payroll.objects.filter(employee=self.full).delete()
        _row(self.full, D(2026, 1, 26), D(2026, 3, 8), cycle=None)
        body = self.get(f"/api/payroll/production/period-status?{self.q}").json()
        by = {e["employeeCode"]: e for e in body["employees"]}
        self.assertTrue(by["RV2"]["blockedReason"].startswith("Already paid: every day of 2 Feb – 1 Mar 2026"))
        self.assertEqual(body["counts"]["blocked"], 1)
        check = self.get(f"/api/payroll/production/skip-check?{self.q}").json()
        self.assertEqual(Payroll.objects.filter(period_start=D(2026, 2, 2), period_end=D(2026, 3, 1)).count(), 0)
        self.assertEqual([p["employeeCode"] for p in check["partial"]], ["RV1"])
        self.assertEqual([s["employeeCode"] for s in check["skipped"]], ["RV2"])

    def test_the_details_page_names_the_days_paid_elsewhere(self):
        self.gen("monthly", D(2026, 2, 2), D(2026, 3, 1), self.w)
        row = self.row(self.w, D(2026, 2, 2), D(2026, 3, 1))
        body = self.get(f"/api/payroll/production/{row.id}/details").json()
        self.assertTrue(body["coverage"]["partial"])
        self.assertEqual((body["coverage"]["paidDays"], body["coverage"]["periodDays"]), (21, 28))
        named = {o["date"]: o["name"] for o in body["offDays"]}
        self.assertEqual(named.get("2026-02-03"), "Already paid on Weekly")
        self.assertEqual(body["summary"]["totalDays"], 21)
        self.assertEqual(body["summary"]["periodDays"], 28)
        listed = self.get("/api/payroll/production?cycle=monthly").json()
        self.assertEqual(
            next(r for r in listed if r["id"] == row.id)["paidRanges"], _iso((D(2026, 2, 9), D(2026, 3, 1)))
        )


# ─────────────────────────────────────────────────────────────────────────────
#  The warning shown before a move
# ─────────────────────────────────────────────────────────────────────────────


class PreviewTests(_MoveCase):
    def preview(self, ids, cycle, headers=None):
        return self.get(f"{PREVIEW}?ids={','.join(str(i) for i in ids)}&cycle={cycle}", headers)

    def test_no_payroll_history_means_no_warning(self):
        fresh = _worker("PV1", cycle="weekly")
        body = self.preview([fresh.id], "monthly").json()
        emp = body["employees"][0]
        self.assertEqual((emp["warn"], emp["message"], emp["lastPayroll"]), (False, None, None))
        self.assertEqual(emp["payRanges"], _iso((D(2026, 2, 2), D(2026, 3, 1))))
        self.assertEqual(body["warnCount"], 0)

    def test_the_owners_sentence_with_the_real_cycles_and_dates(self):
        w = _worker("PV2", cycle="weekly")
        _shifts(w, D(2026, 2, 2), D(2026, 2, 8))
        self.gen("weekly", D(2026, 2, 2), D(2026, 2, 8), w)
        before = Payroll.objects.count()
        body = self.preview([w.id], "monthly").json()
        self.assertEqual(Payroll.objects.count(), before)  # a preview writes nothing
        emp = body["employees"][0]
        self.assertTrue(emp["warn"])
        self.assertEqual(
            emp["message"],
            "This employee was previously assigned to Weekly Payroll, and payroll has already been generated for the "
            "previous period (2 Feb – 8 Feb 2026). If you change the payroll category to Monthly, the system will "
            "calculate salary only for the remaining unpaid days (9 Feb – 1 Mar 2026). Previously generated salary "
            "will not be calculated or paid again.",
        )
        self.assertEqual(emp["lastPayroll"]["cycle"], "weekly")
        self.assertEqual(emp["nextPeriod"], {"start": "2026-02-02", "end": "2026-03-01"})
        self.assertEqual(emp["alreadyPaid"][0]["to"], "2026-02-08")
        self.assertEqual(self.preview([w.id], "weekly").json()["employees"][0]["warn"], False)  # not a change

    def test_catch_up_and_a_bulk_list_where_only_people_with_history_warn(self):
        m = _worker("PV3", cycle="monthly")
        fresh = _worker("PV4", cycle="monthly")
        other = _worker("PV5", cycle="weekly")
        _shifts(m, D(2026, 1, 5), D(2026, 2, 1))
        _shifts(other, D(2026, 2, 9), D(2026, 2, 15))
        self.gen("monthly", D(2026, 1, 5), D(2026, 2, 1), m)
        self.gen("weekly", D(2026, 2, 9), D(2026, 2, 15), other)
        body = self.preview([m.id, fresh.id], "weekly").json()
        by = {e["employeeCode"]: e for e in body["employees"]}
        self.assertEqual((by["PV3"]["warn"], by["PV4"]["warn"], body["warnCount"]), (True, False, 1))
        self.assertEqual(by["PV3"]["catchUp"][0]["from"], "2026-02-02")
        self.assertIn(
            "2 Feb – 15 Feb 2026 were not paid on Monthly and fall before the first Weekly period "
            "(16 Feb – 22 Feb 2026), so they are added to that first Weekly payroll as catch-up days.",
            by["PV3"]["message"],
        )

    def test_taking_someone_off_their_cycle_and_a_cycle_not_set_up(self):
        w = _worker("PV6", cycle="weekly")
        _row(w, D(2026, 2, 2), D(2026, 2, 8), cycle="weekly")
        off = self.preview([w.id], "unassigned").json()["employees"][0]
        self.assertTrue(off["warn"])
        self.assertIn("If you take this employee off their pay cycle", off["message"])
        self.assertIsNone(off["nextPeriod"])
        _settings(prod_cycles={"weekly": {"weekStart": "monday"}})
        body = self.preview([w.id], "biweekly").json()
        self.assertIsNone(body["nextPeriod"])
        self.assertIn("Set the first period start date for BiWeekly", body["configError"])
        self.assertIn("Set the first period start date for BiWeekly", body["employees"][0]["message"])

    def test_permission_scope_and_bad_requests(self):
        w = _worker("PV7", cycle="weekly")
        viewer = _hr(
            "cov_viewer", super_admin=False, role=Role.objects.create(name="EV", permissions={"employees": "view"})
        )
        self.assertEqual(self.preview([w.id], "monthly", viewer).status_code, 403)
        mine, other = Branch.objects.create(name="Mine", code="MIN"), Branch.objects.create(name="Other", code="OTH")
        editor = _hr(
            "cov_branch",
            super_admin=False,
            role=Role.objects.create(name="EE", permissions={"employees": "edit"}),
            branch=mine,
        )
        a, b = _worker("PV8", branch=mine), _worker("PV9", branch=other)
        body = self.preview([a.id, b.id], "monthly", editor).json()
        self.assertEqual([e["employeeId"] for e in body["employees"]], [a.id])
        self.assertEqual([s["employeeId"] for s in body["skipped"]], [b.id])
        for query in ("ids=&cycle=weekly", "ids=x&cycle=weekly", f"ids={w.id}&cycle=daily"):
            self.assertEqual(self.get(f"{PREVIEW}?{query}").status_code, 400, query)
        staff = Employee.objects.create(employee_code="PVS", first_name="S", last_name="T", employment_type="staff")
        self.assertEqual(self.preview([staff.id], "weekly").json()["skipped"][0]["employeeId"], staff.id)

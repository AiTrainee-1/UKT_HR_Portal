"""MD portal: Payroll Analysis (md_portal/analytics/payroll.py + routes/payroll.py).

The fixtures are small and HAND-COMPUTABLE: every figure asserted here can be recomputed from the slips below.

THE SCENARIO (August and September 2026; "today" is pinned to Monday 12 October 2026, the salary day is the 5th)

  staff (monthly salary, working days 26)                    Aug gross   Sep gross  (+ overtime)   what happened
  S1 Stitching/Unit 1  Supervisor   26,000                   26,000      26,000     +1,000 OT       overtime in Sep
  S2 Stitching/Unit 1  Operator     20,000 -> 22,000         20,000      20,307.69  (24 of 26 days) increment + 2 days lost
  S3 Cutting/Unit 1    Operator     18,000                   18,000      18,000                     slip generated before month end
  S4 Accounts/Unit 2   Supervisor   40,000                   40,000      -                          left (inactive)
  S5 Accounts/Unit 2   Operator     30,000                   -           15,000     (13 of 26 days) joined in Sep
  S6 Accounts/Unit 2   (none)       no snapshot on the slip  10,000      9,000                      cannot be split: "Other"
  production (rate per shift)
  P1 Stitching/Unit 1  Operator     500 -> 520               12,500 (12+13 shifts)  12,480 (12+12)   two pay periods a month
  P2 Cutting/Unit 1    Operator     400                      8,000 (20 shifts)      8,800 (22)

  Aug gross 134,500.00  Sep gross 110,587.69 (7 people each month)  ->  change -23,912.31
  bridge: joined +15,000.00, left -40,000.00, pay rate +2,480.00 (S2 +2,000, P1 +480), overtime +1,000.00,
          attendance -1,392.31 (S2 -1,692.31, P1 -500, P2 +800), one-offs 0, other -1,000.00 (S6)
  Sep deductions 2,195.00 (S1 PF 1,560, S2 late 500, S3 ESI 135), net pay 108,392.69
"""

import json
from datetime import date, datetime
from decimal import Decimal
from unittest import mock

from django.db import connection
from django.test import override_settings
from django.test.utils import CaptureQueriesContext

from .clock import FACTORY_TZ
from .md_portal import common as C
from .md_portal.analytics import payroll as P
from .md_portal.assistant import registry
from .md_portal.common import MdParamError, Scope, read_only_db
from .models import (
    Advance,
    AdvanceRepayment,
    Bonus,
    Branch,
    Department,
    Designation,
    Employee,
    HRUser,
    Payroll,
    PayrollSettings,
    SalarySlip,
)
from .tests_md_support import MdApiTestCase, md_headers

TODAY = date(2026, 10, 12)  # a Monday; the salary day (the 5th) is a week past
AUG, SEP, OCT = (2026, 8), (2026, 9), (2026, 10)
BASE = "/api/md/payroll/"
_SERIAL = iter(range(1, 10_000_000))


def D(value) -> Decimal:
    return Decimal(str(value))


def at(year, month, day, hour=9, minute=0) -> datetime:
    """A factory wall-clock moment as an aware datetime."""
    return datetime(year, month, day, hour, minute, tzinfo=FACTORY_TZ)


def make_slip(
    emp,
    ym,
    gross,
    *,
    ot=0,
    basic=None,
    hra=0,
    allow=0,
    incentives=0,
    bonuses=0,
    pf=0,
    esi=0,
    adv=0,
    late=0,
    net=None,
    monthly=None,
    eff=None,
    working=26,
    absent=0,
    shifts=None,
    rate=None,
    period=None,
    paid=False,
    snapshot=True,
    generated=None,
    paid_at=None,
):
    """A salary slip shaped like the payroll engine's (same columns, same breakdown snapshot keys), with its Payroll row.
    ``gross`` is the slip's gross_salary (before overtime). A production slip has a ``period`` (start, end) and ``shifts``."""
    gross, ot = D(gross), D(ot)
    deductions = D(pf) + D(esi) + D(adv) + D(late)
    production = period is not None
    if basic is None:
        basic = gross if production else gross / 2
    net = D(net) if net is not None else gross + ot - deductions
    if production:
        breakdown = {
            "type": "production",
            "salaryPerShift": float(rate or 0),
            "summary": {"totalShifts": float(shifts), "totalDays": (period[1] - period[0]).days + 1},
            "earnings": {"totalShifts": float(shifts), "salaryPerShift": float(rate or 0), "grossSalary": float(gross)},
            "deductions": {"pf": float(pf), "esi": float(esi), "advances": float(adv), "lateShiftPenalty": None},
        }
        present = D(shifts)
        working_days = (period[1] - period[0]).days + 1
    else:
        paid_days = float(eff if eff is not None else working)
        breakdown = {
            "type": "staff",
            "summary": {"totalWorkingDays": working, "effectivePaidDays": paid_days},
            "earnings": {
                "monthlySalary": float(monthly if monthly is not None else gross),
                "grossSalary": float(gross),
            },
            "deductions": {"pf": float(pf), "esi": float(esi), "advances": float(adv), "lateShiftPenalty": float(late)},
        }
        present = D(paid_days)
        working_days = working
    serial = next(_SERIAL)
    slip = SalarySlip.objects.create(
        employee=emp,
        month=ym[1],
        year=ym[0],
        slip_number=f"T/{emp.employee_code}/{serial}",
        basic=D(basic),
        hra=D(hra),
        allowances=D(allow),
        incentives=D(incentives),
        bonuses=D(bonuses),
        ot_amount=ot,
        gross_salary=gross,
        pf_deduction=D(pf),
        esi_deduction=D(esi),
        advance_deduction=D(adv),
        other_deductions=D(late),
        total_deductions=deductions,
        net_salary=net,
        working_days=working_days,
        present_days=present,
        absent_days=D(absent),
        breakdown_details=breakdown if snapshot else None,
        period_start=period[0] if production else None,
        period_end=period[1] if production else None,
    )
    payroll = Payroll.objects.create(
        employee=emp,
        salary_mode="shift" if production else "monthly",
        month=ym[1],
        year=ym[0],
        base_salary=gross,
        gross_salary=gross,
        final_salary=net,
        status="paid" if paid else "pending",
        period_start=period[0] if production else None,
        period_end=period[1] if production else None,
    )
    if generated is not None:  # auto_now_add / auto_now cannot be set on create: update() bypasses them
        SalarySlip.objects.filter(pk=slip.pk).update(generated_at=generated)
        Payroll.objects.filter(pk=payroll.pk).update(updated_at=paid_at or generated)
    elif paid_at is not None:
        Payroll.objects.filter(pk=payroll.pk).update(updated_at=paid_at)
    return slip


def make_employee(code, first, kind, dept, branch, desig=None, salary=None, rate=None, status="active", join_date=None):
    return Employee.objects.create(
        employee_code=code,
        first_name=first,
        last_name="Test" if kind == "staff" else "Prod",
        employment_type=kind,
        department=dept,
        branch=branch,
        designation=desig,
        salary_amount=D(salary) if salary is not None else None,
        salary_per_shift=D(rate) if rate is not None else None,
        status=status,
        join_date=join_date,
    )


class PayrollBase(MdApiTestCase):
    """The organisation and the clock: units, departments, designations, the pinned date."""

    @classmethod
    def setUpTestData(cls):
        cls.u1 = Branch.objects.create(name="Unit 1", code="U1")
        cls.u2 = Branch.objects.create(name="Unit 2", code="U2")
        cls.stitching = Department.objects.create(name="Stitching", branch=cls.u1)
        cls.cutting = Department.objects.create(name="Cutting", branch=cls.u1)
        cls.accounts = Department.objects.create(name="Accounts", branch=cls.u2)
        cls.operator = Designation.objects.create(title="Operator")
        cls.supervisor = Designation.objects.create(title="Supervisor")

    def setUp(self):
        super().setUp()
        patcher = mock.patch.object(P, "_today", return_value=TODAY)
        patcher.start()
        self.addCleanup(patcher.stop)

    def api(self, endpoint, **params):
        response = self.get(BASE + endpoint, **params)
        self.assertEqual(response.status_code, 200, response.content[:400])
        return response.json()


class ScenarioBase(PayrollBase):
    """The August / September 2026 scenario of the module docstring."""

    @classmethod
    def setUpTestData(cls):
        super().setUpTestData()
        e = make_employee
        cls.s1 = e("S1", "Asha", "staff", cls.stitching, cls.u1, cls.supervisor, salary=26000, join_date="2020-01-10")
        cls.s2 = e("S2", "Bala", "staff", cls.stitching, cls.u1, cls.operator, salary=22000, join_date="2021-03-01")
        cls.s3 = e("S3", "Chitra", "staff", cls.cutting, cls.u1, cls.operator, salary=18000, join_date="2019-07-15")
        cls.s4 = e("S4", "Dev", "staff", cls.accounts, cls.u2, cls.supervisor, salary=40000, status="inactive")
        cls.s5 = e("S5", "Esha", "staff", cls.accounts, cls.u2, cls.operator, salary=30000, join_date="2026-09-12")
        cls.s6 = e("S6", "Farook", "staff", cls.accounts, cls.u2, None, salary=10000, join_date="2018-05-05")
        cls.p1 = e("P1", "Gita", "production", cls.stitching, cls.u1, cls.operator, rate=520)
        cls.p2 = e("P2", "Hari", "production", cls.cutting, cls.u1, cls.operator, rate=400)

        sep_gen = at(2026, 10, 1)  # after September ended: not provisional
        aug_gen = at(2026, 9, 2)
        # ── August (everything paid) ──
        make_slip(
            cls.s1,
            AUG,
            26000,
            basic=13000,
            hra=5200,
            allow=7800,
            pf=1560,
            paid=True,
            generated=aug_gen,
            paid_at=at(2026, 9, 6),
        )
        make_slip(
            cls.s2,
            AUG,
            20000,
            basic=10000,
            hra=4000,
            allow=6000,
            adv=2000,
            paid=True,
            generated=aug_gen,
            paid_at=at(2026, 9, 6),
        )
        make_slip(
            cls.s3,
            AUG,
            18000,
            basic=9000,
            hra=3600,
            allow=5400,
            esi=135,
            paid=True,
            generated=aug_gen,
            paid_at=at(2026, 9, 6),
        )
        make_slip(
            cls.s4, AUG, 40000, basic=20000, hra=8000, allow=12000, paid=True, generated=aug_gen, paid_at=at(2026, 9, 6)
        )
        make_slip(cls.s6, AUG, 10000, basic=10000, snapshot=False, paid=True, generated=aug_gen, paid_at=at(2026, 9, 6))
        make_slip(
            cls.p1,
            AUG,
            6000,
            period=(date(2026, 8, 1), date(2026, 8, 14)),
            shifts=12,
            rate=500,
            paid=True,
            generated=aug_gen,
            paid_at=at(2026, 9, 6),
        )
        make_slip(
            cls.p1,
            AUG,
            6500,
            period=(date(2026, 8, 15), date(2026, 8, 31)),
            shifts=13,
            rate=500,
            paid=True,
            generated=aug_gen,
            paid_at=at(2026, 9, 6),
        )
        make_slip(
            cls.p2,
            AUG,
            8000,
            period=(date(2026, 8, 1), date(2026, 8, 31)),
            shifts=20,
            rate=400,
            paid=True,
            generated=aug_gen,
            paid_at=at(2026, 9, 6),
        )
        # ── September (S1 and S2 are marked paid; S3's slip was generated before the month ended) ──
        make_slip(
            cls.s1,
            SEP,
            26000,
            ot=1000,
            basic=13000,
            hra=5200,
            allow=7800,
            pf=1560,
            paid=True,
            generated=sep_gen,
            paid_at=at(2026, 10, 6, 10),
        )
        make_slip(
            cls.s2,
            SEP,
            "20307.69",
            monthly=22000,
            eff=24,
            basic="10153.85",
            hra="4061.54",
            allow="6092.30",
            late=500,
            paid=True,
            generated=sep_gen,
            paid_at=at(2026, 10, 6, 10),
        )
        make_slip(cls.s3, SEP, 18000, basic=9000, hra=3600, allow=5400, esi=135, generated=at(2026, 9, 25))
        make_slip(cls.s5, SEP, 15000, monthly=30000, eff=13, basic=7500, hra=3000, allow=4500, generated=sep_gen)
        make_slip(cls.s6, SEP, 9000, basic=9000, snapshot=False, absent=1, generated=sep_gen)
        make_slip(
            cls.p1, SEP, 6240, period=(date(2026, 9, 1), date(2026, 9, 14)), shifts=12, rate=520, generated=sep_gen
        )
        make_slip(
            cls.p1, SEP, 6240, period=(date(2026, 9, 15), date(2026, 9, 30)), shifts=12, rate=520, generated=sep_gen
        )
        make_slip(
            cls.p2, SEP, 8800, period=(date(2026, 9, 1), date(2026, 9, 30)), shifts=22, rate=400, generated=sep_gen
        )
        # people with no September slip: S7 should have one (flagged), S8 joined after the month, S9 has no salary
        cls.s7 = e("S7", "Ilan", "staff", cls.cutting, cls.u1, cls.operator, salary=16000, join_date="2026-01-05")
        cls.s8 = e("S8", "Jaya", "staff", cls.cutting, cls.u1, cls.operator, salary=16000, join_date="2026-10-03")
        cls.s9 = e("S9", "Kumar", "staff", cls.cutting, cls.u1, cls.operator, join_date="2025-02-02")


def near(test, actual, expected, places=2, msg=None):
    test.assertAlmostEqual(actual, expected, places=places, msg=msg)


class SummaryTests(ScenarioBase):
    def test_the_default_month_is_the_latest_closed_month(self):
        body = self.api("summary")
        self.assertEqual((body["month"], body["monthLabel"], body["hasData"]), ("2026-09", "Sep 2026", True))
        self.assertTrue(body["monthEnded"])
        self.assertFalse(body["requested"])
        self.assertEqual(body["scope"]["description"], "All units · all departments · staff and production")

    def test_the_figures_of_september(self):
        t = self.api("summary", month="2026-09")["totals"]
        near(self, t["grossPay"], 110587.69)
        near(self, t["salaryEarned"], 109587.69)
        near(self, t["overtimePay"], 1000.00)
        near(self, t["totalDeductions"], 2195.00)
        near(self, t["netPay"], 108392.69)
        self.assertEqual((t["headcount"], t["slips"]), (7, 8))  # P1 has two period slips and counts once
        near(self, t["costPerHead"], 15798.24)  # 110,587.69 / 7
        near(self, t["overtimeSharePct"], 0.9, places=1)
        near(self, t["lopDays"], 16.0, places=1)  # S2 2 + S5 13 + S6 1 (absent days: no snapshot)
        near(self, t["bonusAndOneOffs"], 0)

    def test_employer_cost_is_the_report_centres_estimate(self):
        t = self.api("summary", month="2026-09")["totals"]
        # employer PF 12% of S1's basic 13,000 = 1,560; employer ESI 3.25% of S3's gross 18,000 = 585
        near(self, t["employerStatutory"], 2145.00)
        near(self, t["employerCost"], 112732.69)
        near(self, t["employerCostPerHead"], 16104.67)  # 112,732.69 / 7

    def test_comparison_with_the_previous_month(self):
        body = self.api("summary", month="2026-09")
        prev = body["previous"]
        self.assertEqual((prev["month"], prev["label"]), ("2026-08", "Aug 2026"))
        near(self, prev["totals"]["grossPay"], 134500.00)
        near(self, prev["totals"]["netPay"], 130805.00)
        self.assertEqual(prev["totals"]["headcount"], 7)
        gross = body["change"]["grossPay"]
        near(self, gross["abs"], -23912.31)
        near(self, gross["pct"], -17.8, places=1)
        self.assertEqual(body["change"]["headcount"]["abs"], 0)
        near(self, body["change"]["overtimeSharePct"]["abs"], 0.9, places=1)  # percentage points

    def test_the_same_month_last_year_is_null_when_there_is_no_data(self):
        body = self.api("summary", month="2026-09")
        self.assertIsNone(body["lastYear"])  # null, not zero
        self.assertIsNone(body["changeLastYear"])

    def test_the_same_month_last_year_when_it_exists(self):
        make_slip(self.s1, (2025, 9), 24000, paid=True, generated=at(2025, 10, 2))
        body = self.api("summary", month="2026-09")
        near(self, body["lastYear"]["totals"]["grossPay"], 24000.00)
        near(self, body["changeLastYear"]["grossPay"]["abs"], 110587.69 - 24000.00)

    def test_staff_and_production_are_separated_by_the_slip(self):
        by = self.api("summary", month="2026-09")["byType"]
        near(self, by["staff"]["grossPay"], 89307.69)
        self.assertEqual(by["staff"]["headcount"], 5)
        near(self, by["production"]["grossPay"], 21280.00)
        self.assertEqual(by["production"]["headcount"], 2)
        near(self, by["production"]["overtimePay"], 0)

    def test_the_payment_status_of_the_month(self):
        st = self.api("summary", month="2026-09")["status"]
        self.assertEqual(st["state"], "part_paid")
        self.assertEqual((st["slips"], st["paidSlips"], st["unpaidSlips"]), (8, 2, 6))
        near(self, st["unpaidNet"], 63145.00)  # S3 17,865 + S5 15,000 + S6 9,000 + P1 12,480 + P2 8,800
        self.assertEqual(st["provisionalSlips"], 1)  # S3's slip was generated on 25 Sep
        self.assertFalse(st["final"])
        self.assertEqual(st["generatedAt"], "2026-10-01T09:00:00")
        self.assertEqual(st["paidAt"], "2026-10-06T10:00:00")

    def test_provisional_staff_slips_are_called_out(self):
        notes = self.api("summary", month="2026-09")["notes"]
        self.assertTrue(
            any("1 staff slip for Sep 2026 was generated before the month ended" in n for n in notes), notes
        )

    def test_august_is_fully_paid_and_final(self):
        st = self.api("summary", month="2026-08")["status"]
        self.assertEqual(st["state"], "paid")
        self.assertTrue(st["final"])
        self.assertEqual(st["unpaidSlips"], 0)

    def test_a_month_without_payroll_says_so_and_has_no_figures(self):
        body = self.api("summary", month="2026-06")
        self.assertFalse(body["hasData"])
        self.assertIsNone(body["totals"])
        self.assertIsNone(body["previous"])
        self.assertIsNone(body["change"])
        self.assertTrue(any("No salary slips exist for Jun 2026" in n for n in body["notes"]))

    def test_an_unusable_month_is_a_400_with_a_message(self):
        r = self.get(BASE + "summary", month="September")
        self.assertEqual(r.status_code, 400)
        self.assertIn("not a month", r.json()["error"])

    def test_every_figure_has_provenance(self):
        ids = {p["id"] for p in self.api("summary")["provenance"]}
        for needed in (
            "payroll-source",
            "gross-pay",
            "net-pay",
            "employer-cost",
            "headcount",
            "cost-per-head",
            "overtime",
        ):
            self.assertIn(needed, ids)

    def test_money_is_two_places_and_json_plain(self):
        body = self.api("summary", month="2026-09")
        json.dumps(body)  # no Decimal or date objects
        for key in ("grossPay", "netPay", "costPerHead"):
            self.assertEqual(round(body["totals"][key], 2), body["totals"][key])


class TrendTests(ScenarioBase):
    def test_twelve_months_ending_at_the_month_with_gaps_not_zeros(self):
        body = self.api("trend")
        rows = body["months"]
        self.assertEqual(len(rows), 12)
        self.assertEqual((rows[0]["month"], rows[-1]["month"]), ("2025-10", "2026-09"))
        empty = rows[0]
        self.assertFalse(empty["hasData"])
        for key in ("grossPay", "netPay", "headcount", "costPerHead", "overtimePay", "overtimeSharePct"):
            self.assertIsNone(empty[key], key)  # no payroll: null, never 0
        aug, sep = rows[-2], rows[-1]
        near(self, aug["grossPay"], 134500.00)
        near(self, sep["grossPay"], 110587.69)
        near(self, sep["netPay"], 108392.69)
        self.assertEqual((aug["headcount"], sep["headcount"]), (7, 7))
        near(self, aug["costPerHead"], 19214.29)  # 134,500 / 7
        near(self, sep["overtimeSharePct"], 0.9, places=1)
        self.assertEqual(aug["overtimeSharePct"], 0.0)  # a real zero: payroll existed and had no overtime

    def test_states_and_provisional_slips_per_month(self):
        rows = {r["month"]: r for r in self.api("trend")["months"]}
        self.assertEqual((rows["2026-08"]["state"], rows["2026-09"]["state"]), ("paid", "part_paid"))
        self.assertEqual((rows["2026-08"]["provisionalSlips"], rows["2026-09"]["provisionalSlips"]), (0, 1))
        self.assertEqual(rows["2026-07"]["state"], "no_data")  # before payroll began

    def test_average_highest_and_lowest(self):
        body = self.api("trend")
        near(self, body["average"], 122543.845, places=1)  # (134,500.00 + 110,587.69) / 2
        self.assertEqual(body["highest"]["month"], "2026-08")
        self.assertEqual(body["lowest"]["month"], "2026-09")

    def test_the_window_can_be_shorter_and_ends_at_the_chosen_month(self):
        rows = self.api("trend", months=3, month="2026-08")["months"]
        self.assertEqual([r["month"] for r in rows], ["2026-06", "2026-07", "2026-08"])
        self.assertEqual([r["hasData"] for r in rows], [False, False, True])

    def test_an_absurd_window_is_clamped_not_an_error(self):
        self.assertEqual(len(self.api("trend", months=500)["months"]), 36)
        self.assertEqual(len(self.api("trend", months=1)["months"]), 2)
        r = self.get(BASE + "trend", months="many")
        self.assertEqual(r.status_code, 400)


class BridgeTests(ScenarioBase):
    def steps(self, body):
        return {s["id"]: s for s in body["steps"]}

    def test_the_steps_with_their_amounts_and_people(self):
        body = self.api("bridge", month="2026-09")
        self.assertTrue(body["available"])
        self.assertEqual((body["month"], body["previousMonth"]), ("2026-09", "2026-08"))
        s = self.steps(body)
        near(self, s["joined"]["amount"], 15000.00)  # S5
        near(self, s["left"]["amount"], -40000.00)  # S4
        near(
            self, s["rate"]["amount"], 2480.00
        )  # S2 +2,000 (22,000 vs 20,000) and P1 +480 (rate 520 vs 500 on 24 shifts)
        near(self, s["overtime"]["amount"], 1000.00)  # S1
        near(self, s["attendance"]["amount"], -1392.31)  # S2 -1,692.31, P1 -500, P2 +800
        near(self, s["oneoffs"]["amount"], 0.00)
        near(self, s["other"]["amount"], -1000.00)  # S6: no snapshot, so 9,000 vs 10,000 cannot be split
        self.assertEqual(
            {k: v["people"] for k, v in s.items()},
            {"joined": 1, "left": 1, "rate": 2, "overtime": 1, "attendance": 3, "oneoffs": 0, "other": 1},
        )

    def test_the_steps_add_up_to_the_change_exactly(self):
        body = self.api("bridge", month="2026-09")
        total = sum(D(s["amount"]) for s in body["steps"])
        self.assertEqual(total, D(body["end"]["amount"]) - D(body["start"]["amount"]))  # to the paisa, no tolerance
        self.assertEqual(D(body["sumOfSteps"]), total)
        near(self, body["end"]["amount"] - body["start"]["amount"], -23912.31)
        self.assertEqual(body["change"]["abs"], round(body["end"]["amount"] - body["start"]["amount"], 2))

    def test_the_bridge_starts_and_ends_at_the_summary_figures(self):
        bridge = self.api("bridge", month="2026-09")
        summary = self.api("summary", month="2026-09")
        near(self, bridge["end"]["amount"], summary["totals"]["grossPay"])
        near(self, bridge["start"]["amount"], summary["previous"]["totals"]["grossPay"])
        self.assertEqual(bridge["start"]["label"], "Aug 2026 gross pay")
        self.assertEqual(bridge["end"]["label"], "Sep 2026 gross pay")

    def test_the_main_driver_is_the_biggest_step(self):
        body = self.api("bridge", month="2026-09")
        self.assertEqual(body["mainDriver"]["id"], "left")
        near(self, body["mainDriver"]["amount"], -40000.00)

    def test_a_note_says_who_could_not_be_split(self):
        notes = self.api("bridge", month="2026-09")["notes"]
        self.assertTrue(any("1 staff slip for Sep 2026 has no saved calculation breakdown" in n for n in notes), notes)
        self.assertTrue(any("generated before the month ended" in n for n in notes), notes)  # S3 is provisional

    def test_no_previous_month_means_no_bridge_and_says_why(self):
        body = self.api("bridge", month="2026-08")  # July has no payroll
        self.assertFalse(body["available"])
        self.assertEqual(body["steps"], [])
        self.assertIn("no payroll for Jul 2026", body["reason"])
        self.assertTrue(body["provenance"])

    def test_a_third_production_period_is_called_out(self):
        make_slip(
            self.p2,
            SEP,
            400,
            period=(date(2026, 9, 1), date(2026, 9, 10)),
            shifts=1,
            rate=400,
            generated=at(2026, 10, 1),
        )
        body = self.api("bridge", month="2026-09")
        self.assertEqual(body["productionPeriods"], {"previous": 2, "current": 3})
        self.assertTrue(
            any("3 production pay periods ended in Sep 2026 against 2 in Aug 2026" in n for n in body["notes"])
        )
        total = sum(D(s["amount"]) for s in body["steps"])
        self.assertEqual(total, D(body["end"]["amount"]) - D(body["start"]["amount"]))

    def test_one_offs_on_the_slip_are_their_own_step(self):
        SalarySlip.objects.filter(employee=self.s1, year=2026, month=9).update(
            incentives=D(500), gross_salary=D(26500), net_salary=D(27940)
        )
        body = self.api("bridge", month="2026-09")
        s = self.steps(body)
        near(self, s["oneoffs"]["amount"], 500.00)
        self.assertEqual(s["oneoffs"]["people"], 1)
        near(self, s["attendance"]["amount"], -1392.31)  # unchanged: the incentive is not an attendance matter
        total = sum(D(x["amount"]) for x in body["steps"])
        self.assertEqual(total, D(body["end"]["amount"]) - D(body["start"]["amount"]))

    def test_a_person_who_changed_between_staff_and_production_goes_to_other(self):
        ghost = make_employee("G1", "Mani", "staff", self.stitching, self.u1, self.operator, salary=15000)
        make_slip(ghost, AUG, 15000, generated=at(2026, 9, 2))
        make_slip(
            ghost,
            SEP,
            9000,
            period=(date(2026, 9, 1), date(2026, 9, 30)),
            shifts=18,
            rate=500,
            generated=at(2026, 10, 1),
        )
        body = self.api("bridge", month="2026-09")
        s = self.steps(body)
        near(self, s["other"]["amount"], -1000.00 + (9000 - 15000))  # S6's -1,000 plus the mover's -6,000
        self.assertEqual(
            s["joined"]["people"], 1
        )  # the mover is NOT counted as a joiner: they were on payroll in August
        total = sum(D(x["amount"]) for x in body["steps"])
        self.assertEqual(total, D(body["end"]["amount"]) - D(body["start"]["amount"]))

    def test_a_production_worker_with_no_shifts_last_month_is_all_attendance(self):
        late = make_employee("P3", "Ivan", "production", self.cutting, self.u1, self.operator, rate=400)
        make_slip(
            late, AUG, 0, period=(date(2026, 8, 1), date(2026, 8, 31)), shifts=0, rate=400, generated=at(2026, 9, 2)
        )
        make_slip(
            late, SEP, 2000, period=(date(2026, 9, 1), date(2026, 9, 30)), shifts=5, rate=400, generated=at(2026, 10, 1)
        )
        s = self.steps(self.api("bridge", month="2026-09"))
        near(self, s["attendance"]["amount"], -1392.31 + 2000)  # all of the 2,000 is shifts worked, none is rate
        near(self, s["rate"]["amount"], 2480.00)

    def test_provenance_explains_the_order_and_the_residual(self):
        prov = {p["id"]: p for p in self.api("bridge", month="2026-09")["provenance"]}
        self.assertIn("joined + left + pay rate + overtime + attendance + one-offs + other", prov["bridge"]["formula"])
        self.assertTrue(any("residual" in c for c in prov["bridge-split"]["caveats"]))


class DepartmentTests(ScenarioBase):
    def test_departments_are_ranked_by_cost_with_the_change_on_last_month(self):
        body = self.api("departments", month="2026-09")
        rows = {d["name"]: d for d in body["departments"]}
        self.assertEqual([d["name"] for d in body["departments"]], ["Stitching", "Cutting", "Accounts"])
        st = rows["Stitching"]
        near(self, st["grossPay"], 59787.69)  # S1 27,000 + S2 20,307.69 + P1 12,480
        self.assertEqual((st["headcount"], st["unit"]), (3, "Unit 1"))
        near(self, st["costPerHead"], 19929.23)
        near(self, st["overtimePay"], 1000.00)
        near(self, st["overtimeSharePct"], 1.7, places=1)
        near(self, st["lopDays"], 2.0, places=1)  # S2's two days; production has none
        near(self, st["previous"]["grossPay"], 58500.00)
        near(self, st["change"]["grossPay"]["abs"], 1287.69)
        near(self, st["change"]["grossPay"]["pct"], 2.2, places=1)
        near(self, rows["Cutting"]["grossPay"], 26800.00)
        near(self, rows["Accounts"]["grossPay"], 24000.00)
        near(self, rows["Accounts"]["change"]["grossPay"]["pct"], -52.0, places=1)
        near(self, rows["Accounts"]["lopDays"], 14.0, places=1)  # S5 13 + S6 1 (absent days: no snapshot)

    def test_shares_add_up_and_the_total_matches_the_summary(self):
        body = self.api("departments", month="2026-09")
        near(self, sum(d["sharePct"] for d in body["departments"]), 100.0, places=0)
        near(self, body["total"]["grossPay"], 110587.69)
        near(self, sum(d["grossPay"] for d in body["departments"]), body["total"]["grossPay"])
        self.assertEqual(sum(d["headcount"] for d in body["departments"]), body["total"]["headcount"])

    def test_units(self):
        units = {u["name"]: u for u in self.api("departments", month="2026-09")["units"]}
        near(self, units["Unit 1"]["grossPay"], 86587.69)
        self.assertEqual(units["Unit 1"]["headcount"], 5)
        near(self, units["Unit 2"]["grossPay"], 24000.00)
        near(self, units["Unit 2"]["change"]["grossPay"]["abs"], -26000.00)

    def test_staff_and_production_blocks(self):
        types = {t["id"]: t for t in self.api("departments", month="2026-09")["types"]}
        near(self, types["staff"]["grossPay"], 89307.69)
        near(self, types["production"]["grossPay"], 21280.00)
        self.assertEqual((types["staff"]["headcount"], types["production"]["headcount"]), (5, 2))
        self.assertIsNone(types["production"]["lopDays"])  # production has no loss-of-pay days: null, not 0
        near(self, types["production"]["previous"]["grossPay"], 20500.00)

    def test_the_list_is_capped(self):
        body = self.api("departments", month="2026-09", limit=2)
        self.assertEqual((len(body["departments"]), body["departmentsTotal"]), (2, 3))
        self.assertTrue(any("2 highest-cost of 3 departments" in n for n in body["notes"]))

    def test_people_with_no_department_are_unassigned(self):
        drifter = make_employee("D1", "Lata", "staff", None, self.u1, None, salary=11000)
        make_slip(drifter, SEP, 11000, generated=at(2026, 10, 1))
        names = [d["name"] for d in self.api("departments", month="2026-09")["departments"]]
        self.assertIn("Unassigned", names)


class DistributionTests(ScenarioBase):
    def test_net_pay_bands_count_people_not_slips(self):
        body = self.api("distribution", month="2026-09")
        bands = {b["label"]: b for b in body["bands"]}
        self.assertEqual(bands["Under ₹10k"]["count"], 2)  # S6 9,000 and P2 8,800
        self.assertEqual(bands["₹10k–15k"]["count"], 1)  # P1 12,480 (two slips, one person)
        self.assertEqual(bands["₹15k–20k"]["count"], 3)  # S5 15,000, S3 17,865, S2 19,807.69
        self.assertEqual(bands["₹25k–30k"]["count"], 1)  # S1 25,440
        self.assertEqual(sum(b["count"] for b in body["bands"]), 7)
        self.assertEqual(bands["Nil or negative"]["count"], 0)  # the empty bands stay, so the shape is honest

    def test_bands_by_type(self):
        bands = {b["label"]: b for b in self.api("distribution", month="2026-09")["bands"]}
        self.assertEqual((bands["Under ₹10k"]["staff"], bands["Under ₹10k"]["production"]), (1, 1))
        self.assertEqual((bands["₹10k–15k"]["staff"], bands["₹10k–15k"]["production"]), (0, 1))

    def test_summary_statistics(self):
        st = self.api("distribution", month="2026-09")["stats"]
        self.assertEqual(st["people"], 7)
        near(self, st["median"], 15000.00)
        near(self, st["average"], 15484.67)  # 108,392.69 / 7
        near(self, st["lowest"], 8800.00)
        near(self, st["highest"], 25440.00)
        self.assertEqual(st["belowTenThousand"], 2)

    def test_cost_by_designation_is_ranked_and_capped(self):
        body = self.api("distribution", month="2026-09", limit=2)
        self.assertEqual([d["designation"] for d in body["byDesignation"]], ["Operator", "Supervisor"])
        self.assertEqual(body["designationsTotal"], 3)  # Operator, Supervisor, and S6 with none
        op = body["byDesignation"][0]
        near(self, op["grossPay"], 74587.69)
        self.assertEqual(op["headcount"], 5)
        near(self, op["averageGrossPay"], 14917.54)

    def test_the_same_role_in_two_departments_is_one_row(self):
        # each department keeps its own "Operator" record; the MD means the role
        cutting_operator = Designation.objects.create(title=" operator", department=self.cutting)
        Employee.objects.filter(pk__in=[self.s3.pk, self.p2.pk]).update(designation=cutting_operator)
        body = self.api("distribution", month="2026-09")
        names = [d["designation"] for d in body["byDesignation"]]
        self.assertEqual(sorted(names), ["No designation", "Operator", "Supervisor"])
        self.assertEqual(body["designationsTotal"], 3)
        op = next(d for d in body["byDesignation"] if d["designation"] == "Operator")
        near(self, op["grossPay"], 74587.69)  # exactly what the two records came to together
        self.assertEqual(op["headcount"], 5)

    def test_only_aggregates_no_people(self):
        text = json.dumps(self.api("distribution", month="2026-09"))
        for name in ("Asha", "Bala", "Chitra", "S1", "Farook"):
            self.assertNotIn(name, text)


class ComponentsTests(ScenarioBase):
    def test_earnings_by_head_with_the_previous_month(self):
        body = self.api("components", month="2026-09")
        earn = {e["id"]: e for e in body["earnings"]}
        near(self, earn["basic"]["amount"], 69933.85)
        near(self, earn["hra"]["amount"], 15861.54)
        near(self, earn["allowances"]["amount"], 23792.30)
        near(self, earn["overtime"]["amount"], 1000.00)
        self.assertNotIn("oneoffs", earn)  # zero in both months: left out
        self.assertNotIn("other-earnings", earn)  # the heads add up to salary earned exactly
        near(self, earn["overtime"]["previous"], 0.0)
        near(self, sum(e["amount"] for e in body["earnings"]), body["grossPay"]["amount"])
        near(self, body["grossPay"]["amount"], 110587.69)

    def test_deductions_by_head(self):
        body = self.api("components", month="2026-09")
        ded = {d["id"]: d for d in body["deductions"]}
        near(self, ded["pf"]["amount"], 1560.00)
        near(self, ded["esi"]["amount"], 135.00)
        near(self, ded["late"]["amount"], 500.00)  # S2's late-arrival penalty, from the slip's own figure
        near(self, ded["advance"]["amount"], 0.0)
        near(self, ded["advance"]["previous"], 2000.00)  # S2's August instalment
        near(self, ded["advance"]["change"]["abs"], -2000.00)
        self.assertNotIn("other-deductions", ded)
        near(self, body["totalDeductions"]["amount"], 2195.00)
        near(self, sum(d["amount"] for d in body["deductions"]), 2195.00)

    def test_net_pay_reconciles_with_gross_less_deductions(self):
        body = self.api("components", month="2026-09")
        near(self, body["netPay"]["amount"], 108392.69)
        near(self, body["grossPay"]["amount"] - body["totalDeductions"]["amount"], body["netPay"]["amount"])
        self.assertEqual(body["netGap"], 0.0)
        self.assertFalse(any("differs from gross pay less deductions" in n for n in body["notes"]))

    def test_a_slip_that_does_not_add_up_is_reported(self):
        SalarySlip.objects.filter(employee=self.s1, year=2026, month=9).update(net_salary=D(20000))
        body = self.api("components", month="2026-09")
        near(self, body["netGap"], 5440.00)
        self.assertTrue(any("differs from gross pay less deductions by ₹5,440.00" in n for n in body["notes"]))

    def test_employer_estimates_and_statutory_dues(self):
        body = self.api("components", month="2026-09")
        emp = {e["id"]: e for e in body["employer"]}
        near(self, emp["employer-pf"]["amount"], 1560.00)  # 12% of S1's basic 13,000
        near(self, emp["employer-esi"]["amount"], 585.00)  # 3.25% of S3's gross 18,000
        near(self, body["employerCost"]["amount"], 112732.69)
        near(self, body["statutoryDue"], 3840.00)  # PF 1,560 + ESI 135 + employer 2,145

    def test_what_is_still_payable(self):
        pay = self.api("components", month="2026-09")["payable"]
        self.assertEqual(pay["slips"], 6)
        near(self, pay["netPay"], 63145.00)

    def test_the_statutory_bonus_is_shown_apart_from_the_slips(self):
        for emp, amount, status in (
            (self.s1, 5000, "calculated"),
            (self.s2, 3000, "approved"),
            (self.s3, 2000, "paid"),
        ):
            Bonus.objects.create(
                employee=emp,
                financial_year="2026-27",
                records_considered=6,
                calculation_base=D(amount * 10),
                bonus_percent_applied=D(10),
                bonus_amount=D(amount),
                status=status,
            )
        Bonus.objects.create(
            employee=self.s1,
            financial_year="2025-26",
            records_considered=12,
            calculation_base=D(1),
            bonus_percent_applied=D(10),
            bonus_amount=D(999),
            status="paid",
        )  # another year: not counted
        bonus = self.api("components", month="2026-09")["statutoryBonus"]
        self.assertEqual(bonus["financialYear"], "2026-27")
        near(self, bonus["calculated"]["amount"], 5000.00)
        near(self, bonus["approved"]["amount"], 3000.00)
        near(self, bonus["paid"]["amount"], 2000.00)
        near(self, bonus["total"], 10000.00)
        near(self, bonus["notPaid"], 8000.00)

    def test_no_bonus_rows_means_null(self):
        self.assertIsNone(self.api("components", month="2026-09")["statutoryBonus"])

    def test_the_financial_year_follows_the_bonus_start_month_setting(self):
        PayrollSettings.objects.create(
            pk=1, bonus_fy_start_month=10
        )  # FY starts in October: September 2026 is in 2025-26
        Bonus.objects.create(
            employee=self.s1,
            financial_year="2025-26",
            records_considered=6,
            calculation_base=D(1),
            bonus_percent_applied=D(10),
            bonus_amount=D(700),
            status="calculated",
        )
        self.assertEqual(self.api("components", month="2026-09")["statutoryBonus"]["financialYear"], "2025-26")


class StatusTests(ScenarioBase):
    def test_the_state_of_every_month(self):
        body = self.api("status")
        months = {m["month"]: m for m in body["months"]}
        self.assertEqual((body["months"][0]["month"], body["months"][-1]["month"]), ("2025-11", "2026-10"))
        self.assertEqual(months["2026-07"]["state"], "no_data")  # before payroll began: not a failure
        self.assertEqual(months["2026-08"]["state"], "paid")
        self.assertEqual(months["2026-09"]["state"], "part_paid")
        self.assertEqual(
            months["2026-10"]["state"], "not_started"
        )  # this month: nothing generated yet, which is normal
        self.assertEqual(months["2026-09"]["stateLabel"], "Part paid")

    def test_which_month_the_page_opens_on(self):
        body = self.api("status")
        self.assertEqual((body["defaultMonth"], body["latestClosedMonth"]), ("2026-09", "2026-09"))
        self.assertEqual(body["available"], ["2026-09", "2026-08"])  # newest first, only months with slips
        self.assertEqual((body["today"], body["currentMonth"]), ("2026-10-12", "2026-10"))

    def test_the_salary_day_comes_from_settings_and_defaults_to_the_5th(self):
        self.assertEqual(self.api("status")["payDay"], 5)
        PayrollSettings.objects.create(pk=1, pay_day=10)
        self.assertEqual(self.api("status")["payDay"], 10)

    def test_a_month_still_running_is_in_progress_and_never_the_default(self):
        make_slip(self.s1, OCT, 26000, generated=at(2026, 10, 10))
        body = self.api("status")
        oct_ = {m["month"]: m for m in body["months"]}["2026-10"]
        self.assertEqual((oct_["state"], oct_["provisionalSlips"], oct_["monthEnded"]), ("in_progress", 1, False))
        self.assertEqual(body["defaultMonth"], "2026-09")  # a running month understates pay: not the default
        self.assertEqual(body["available"][0], "2026-10")  # but the MD can open it
        summary = self.api("summary", month="2026-10")
        self.assertFalse(summary["monthEnded"])
        self.assertTrue(any("has not ended" in n for n in summary["notes"]), summary["notes"])

    def test_a_month_that_ended_without_payroll_is_not_generated(self):
        with mock.patch.object(P, "_today", return_value=date(2026, 11, 12)):
            months = {m["month"]: m for m in self.api("status")["months"]}
        self.assertEqual(months["2026-10"]["state"], "not_generated")

    def test_paid_means_the_word_paid_whatever_its_case(self):
        Payroll.objects.filter(employee=self.s3, year=2026, month=9).update(status="  PAID ")
        self.assertEqual(self.api("summary", month="2026-09")["status"]["paidSlips"], 3)

    def test_a_production_slip_pairs_with_the_row_of_its_pay_period(self):
        Payroll.objects.filter(employee=self.p1, period_start=date(2026, 9, 15)).update(status="paid")
        status = self.api("summary", month="2026-09")["status"]
        self.assertEqual(status["paidSlips"], 3)  # only P1's second period, not both
        near(self, status["unpaidNet"], 63145.00 - 6240.00)

    def test_a_month_is_final_when_paid_and_not_provisional(self):
        for emp in (self.s3, self.s5, self.s6, self.p1, self.p2):
            Payroll.objects.filter(employee=emp, year=2026, month=9).update(status="paid")
        SalarySlip.objects.filter(employee=self.s3, year=2026, month=9).update(generated_at=at(2026, 10, 2))
        Payroll.objects.filter(employee=self.s3, year=2026, month=9).update(updated_at=at(2026, 10, 2))
        status = self.api("summary", month="2026-09")["status"]
        self.assertEqual((status["state"], status["provisionalSlips"], status["final"]), ("paid", 0, True))

    def test_provisional_counting_matches_the_report_centres_own_rule(self):
        from .reporting.definitions.payroll_statutory_common import provisional_slip_ids

        make_slip(self.s1, OCT, 26000, generated=at(2026, 10, 10))  # a running month: every staff slip is provisional
        Payroll.objects.filter(employee=self.s2, year=2026, month=9).update(updated_at=at(2026, 10, 8))  # regenerated
        mine = {m["month"]: m["provisionalSlips"] for m in self.api("status")["months"]}
        for ym in (AUG, SEP, OCT):
            slips = list(SalarySlip.objects.filter(year=ym[0], month=ym[1], week_number__isnull=True))
            theirs = provisional_slip_ids(slips, ym[0], ym[1], TODAY)
            self.assertEqual(mine[f"{ym[0]}-{ym[1]:02d}"], len(theirs), ym)

    def test_the_status_of_a_scope_counts_only_its_slips(self):
        body = self.api("status", branch="Unit 2")
        sep = {m["month"]: m for m in body["months"]}["2026-09"]
        self.assertEqual((sep["slips"], sep["unpaidSlips"]), (2, 2))  # S5 and S6


class ExceptionsBase(PayrollBase):
    """One department of staff, built so that each kind of exception has exactly the people listed in the docstring."""

    @classmethod
    def setUpTestData(cls):
        super().setUpTestData()
        cls.packing = Department.objects.create(name="Packing", branch=cls.u1)
        e = make_employee
        gen_aug, gen_sep = at(2026, 9, 2), at(2026, 10, 1)

        def staff(code, aug, sep, **kw):
            emp = e(
                code, code.lower(), "staff", cls.packing, cls.u1, cls.operator, salary=20000, join_date="2020-01-01"
            )
            if aug is not None:
                make_slip(emp, AUG, aug, generated=gen_aug)
            if sep is not None:
                make_slip(emp, SEP, sep, generated=gen_sep, **kw)
            return emp

        cls.normal = [staff(f"K{i}", 20000, 20000) for i in range(1, 7)]
        cls.k7 = staff("K7", 20000, 70000)  # outlier (3.5x the median) and a swing (+250%)
        cls.k8 = staff("K8", 12000, 12000, adv=15000)  # net pay -3,000
        cls.k9 = staff("K9", 10000, 10000, adv=10000)  # net pay 0
        cls.k10 = staff("K10", 18000, 18000)  # a second September slip is added below: duplicate (and +100%)
        make_slip(cls.k10, SEP, 18000, generated=gen_sep)
        cls.k11 = staff("K11", 8000, 8000, eff=0)  # gross pay for zero days
        cls.k15 = staff("K15", 30000, 21000)  # -30% (9,000)
        cls.k16 = staff("K16", 3000, 1500)  # -50% (1,500)
        cls.k17 = staff("K17", 1000, 500)  # -50% but only 500: below the 1,000 floor
        cls.k12 = e(
            "K12", "k12", "staff", cls.packing, cls.u1, cls.operator, salary=18000, join_date="2026-01-01"
        )  # no slip
        cls.k13 = e(
            "K13", "k13", "staff", cls.packing, cls.u1, cls.operator, salary=18000, join_date="2026-10-05"
        )  # joined after
        cls.k14 = e(
            "K14", "k14", "staff", cls.packing, cls.u1, cls.operator, join_date="2025-02-02"
        )  # no salary on file
        cls.k18 = e(
            "K18", "k18", "production", cls.packing, cls.u1, cls.operator, rate=400
        )  # production never generated
        cls.left = e(
            "K19", "k19", "staff", cls.packing, cls.u1, cls.operator, salary=18000, status="inactive"
        )  # not active


class ExceptionsTests(ExceptionsBase):
    def kinds(self, body):
        return {k["id"]: k["count"] for k in body["kinds"]}

    def test_every_kind_finds_exactly_its_people(self):
        body = self.api("exceptions", month="2026-09", limit=100)
        self.assertEqual(
            self.kinds(body),
            {
                "negative-net": 1,
                "duplicate-slip": 1,
                "zero-net": 1,
                "paid-zero-days": 1,
                "no-slip": 1,
                "pay-outlier": 1,
                "pay-swing": 4,
            },
        )
        by_kind = {}
        for r in body["rows"]:
            by_kind.setdefault(r["kind"], []).append(r["code"])
        self.assertEqual(by_kind["negative-net"], ["K8"])
        self.assertEqual(by_kind["zero-net"], ["K9"])
        self.assertEqual(by_kind["duplicate-slip"], ["K10"])
        self.assertEqual(by_kind["paid-zero-days"], ["K11"])
        self.assertEqual(
            by_kind["no-slip"], ["K12"]
        )  # K13 joined after the month, K14 has no salary, K19 is not active
        self.assertEqual(by_kind["pay-outlier"], ["K7"])
        self.assertEqual(sorted(by_kind["pay-swing"]), ["K10", "K15", "K16", "K7"])  # K17 moved by under the floor
        self.assertEqual((body["total"], body["people"]), (10, 8))

    def test_the_most_severe_come_first_then_the_biggest(self):
        rows = self.api("exceptions", month="2026-09", limit=100)["rows"]
        self.assertEqual(
            [(r["severity"], r["kind"]) for r in rows[:2]],
            [("critical", "negative-net"), ("critical", "duplicate-slip")],
        )
        self.assertEqual([r["kind"] for r in rows[2:6]], ["zero-net", "paid-zero-days", "no-slip", "pay-outlier"])
        swings = [r["code"] for r in rows if r["kind"] == "pay-swing"]
        self.assertEqual(swings, ["K7", "K10", "K15", "K16"])  # biggest gross pay first

    def test_a_person_row_carries_who_and_the_amounts(self):
        rows = {r["code"] + ":" + r["kind"]: r for r in self.api("exceptions", month="2026-09", limit=100)["rows"]}
        neg = rows["K8:negative-net"]
        self.assertEqual((neg["name"], neg["department"], neg["type"]), ("k8 Test", "Packing", "Staff"))
        self.assertIsInstance(neg["employeeId"], int)
        near(self, neg["grossPay"], 12000.00)
        near(self, neg["netPay"], -3000.00)
        self.assertEqual(neg["detail"], "Deductions of ₹15,000.00 exceed gross pay of ₹12,000.00.")
        self.assertEqual(
            rows["K9:zero-net"]["detail"], "Net pay is zero (gross pay ₹10,000.00, deductions ₹10,000.00)."
        )
        self.assertEqual(
            rows["K10:duplicate-slip"]["detail"],
            "2 staff slips for the same month: this person's pay is counted 2 times in the totals.",
        )
        self.assertEqual(
            rows["K11:paid-zero-days"]["detail"],
            "Gross pay of ₹8,000.00 on a slip that counts no days or shifts worked.",
        )
        self.assertIsNone(rows["K12:no-slip"]["grossPay"])
        self.assertEqual(
            rows["K12:no-slip"]["detail"], "Active employee with a salary on file and no salary slip for Sep 2026."
        )
        out = rows["K7:pay-outlier"]
        self.assertEqual(out["detail"], "Gross pay ₹70,000 is 3.5 times the staff median of ₹20,000 in Packing.")
        self.assertEqual(out["compare"], {"label": "Department median", "amount": 20000.0})
        swing = rows["K15:pay-swing"]
        self.assertEqual(swing["detail"], "Gross pay down 30%: ₹30,000 last month, ₹21,000 this month.")
        self.assertEqual(swing["changePct"], -30.0)
        self.assertEqual(swing["compare"], {"label": "Aug 2026 gross pay", "amount": 30000.0})

    def test_the_list_is_capped_but_the_counts_are_not(self):
        body = self.api("exceptions", month="2026-09", limit=3)
        self.assertEqual((len(body["rows"]), body["shown"], body["total"], body["matching"]), (3, 3, 10, 10))
        self.assertEqual(self.kinds(body)["pay-swing"], 4)

    def test_one_kind_can_be_asked_for(self):
        body = self.api("exceptions", month="2026-09", kind="pay-swing", limit=100)
        self.assertEqual({r["kind"] for r in body["rows"]}, {"pay-swing"})
        self.assertEqual((body["matching"], body["total"]), (4, 10))

    def test_an_unknown_kind_is_a_400_that_says_what_is_allowed(self):
        r = self.get(BASE + "exceptions", kind="gossip")
        self.assertEqual(r.status_code, 400)
        self.assertIn("pay-swing", r.json()["error"])

    def test_the_thresholds_are_shown(self):
        body = self.api("exceptions", month="2026-09")
        self.assertEqual(
            body["thresholds"],
            {"variancePct": 25.0, "varianceMinRupees": 1000.0, "outlierMultiple": 3.0, "outlierMinPeers": 5},
        )
        text = " ".join(" ".join([p["definition"], *p["filters"]]) for p in body["provenance"])
        self.assertIn("25%", text)
        self.assertIn("3 times the median", text)

    def test_notes_say_what_was_left_out(self):
        notes = self.api("exceptions", month="2026-09")["notes"]
        self.assertTrue(any("1 active employee has no salary on file" in n for n in notes), notes)
        self.assertTrue(
            any("belongs to a kind of payroll (staff or production) that has not been generated" in n for n in notes),
            notes,
        )

    def test_a_department_too_small_for_a_median_has_no_outliers(self):
        small = Department.objects.create(name="Tiny", branch=self.u1)
        for i, gross in enumerate((10000, 10000, 10000, 90000)):  # 4 peers: under the minimum of 5
            emp = make_employee(f"T{i}", f"t{i}", "staff", small, self.u1, self.operator, salary=gross)
            make_slip(emp, SEP, gross, generated=at(2026, 10, 1))
        body = self.api("exceptions", month="2026-09", kind="pay-outlier", limit=100)
        self.assertEqual([r["code"] for r in body["rows"]], ["K7"])

    def test_a_running_month_is_not_checked_for_missing_slips(self):
        with mock.patch.object(P, "_today", return_value=date(2026, 9, 20)):
            body = self.api("exceptions", month="2026-09", limit=100)
        self.assertEqual(self.kinds(body)["no-slip"], 0)
        self.assertTrue(any("has not ended" in n for n in body["notes"]))

    def test_production_pay_is_not_compared_when_a_different_number_of_periods_ended(self):
        r1 = make_employee("R1", "r1", "production", self.packing, self.u1, self.operator, rate=500)
        make_slip(
            r1, AUG, 3000, period=(date(2026, 8, 1), date(2026, 8, 14)), shifts=6, rate=500, generated=at(2026, 9, 2)
        )
        make_slip(
            r1, AUG, 3000, period=(date(2026, 8, 15), date(2026, 8, 31)), shifts=6, rate=500, generated=at(2026, 9, 2)
        )
        for start, end in ((1, 10), (11, 20), (21, 30)):  # three periods in September: +50% only because of that
            make_slip(
                r1,
                SEP,
                3000,
                period=(date(2026, 9, start), date(2026, 9, end)),
                shifts=6,
                rate=500,
                generated=at(2026, 10, 1),
            )
        body = self.api("exceptions", month="2026-09", limit=100)
        self.assertNotIn("R1", [r["code"] for r in body["rows"] if r["kind"] == "pay-swing"])
        self.assertTrue(any("Production pay of 1 people was not compared" in n for n in body["notes"]), body["notes"])
        # production payroll now exists for the month, so the production employee with no slip IS a finding
        self.assertIn("K18", [r["code"] for r in body["rows"] if r["kind"] == "no-slip"])

    def test_no_slip_ignores_an_employee_whose_salary_is_missing_or_who_has_left(self):
        codes = [r["code"] for r in self.api("exceptions", month="2026-09", kind="no-slip", limit=100)["rows"]]
        self.assertEqual(codes, ["K12"])

    def test_names_are_in_the_standard_person_key(self):
        row = self.api("exceptions", month="2026-09")["rows"][0]
        self.assertIn("name", row)


class AdvancesBase(ScenarioBase):
    """Advances (today 12 Oct 2026, month September 2026)."""

    @classmethod
    def setUpTestData(cls):
        super().setUpTestData()

        def advance(emp, kind, amount, approved, status="approved", emi=0):
            return Advance.objects.create(
                employee=emp,
                advance_type=kind,
                amount=D(amount),
                status=status,
                approved_at=approved,
                emi_amount=D(emi),
                outstanding=D(amount),
            )

        def repay(adv, year, month, amount, processed):
            return AdvanceRepayment.objects.create(
                advance=adv, year=year, month=month, amount=D(amount), is_processed=processed
            )

        # fully repaid but still marked approved: no balance, so not counted
        cls.adv1 = advance(cls.s1, "term", 30000, at(2026, 3, 1), emi=5000)
        for month in range(4, 10):
            repay(
                cls.adv1, 2026, month, 5000, True
            )  # April to September: the September one is "recovered in the month"
        # given in September, first instalment due in October (not overdue)
        cls.adv2 = advance(cls.s2, "general", 12000, at(2026, 9, 5))
        repay(cls.adv2, 2026, 10, 12000, False)
        # term loan: February to July deducted, August and September missed (overdue)
        cls.adv3 = advance(cls.s3, "term", 40000, at(2026, 1, 10), emi=5000)
        for month in range(2, 8):
            repay(cls.adv3, 2026, month, 5000, True)
        for month in (8, 9):
            repay(cls.adv3, 2026, month, 5000, False)
        # held by someone who has left, long overdue
        cls.adv4 = advance(cls.s4, "general", 8000, at(2025, 6, 1))
        repay(cls.adv4, 2025, 7, 8000, False)
        cls.adv5 = advance(cls.s5, "general", 5000, None, status="pending")  # not sanctioned: no balance
        cls.adv6 = advance(cls.s6, "general", 6000, at(2026, 5, 1), status="closed")
        repay(cls.adv6, 2026, 6, 6000, True)


class AdvancesTests(AdvancesBase):
    def test_outstanding_is_the_sanctioned_amount_less_instalments_deducted(self):
        out = self.api("advances", month="2026-09")["outstanding"]
        near(self, out["amount"], 30000.00)  # adv2 12,000 + adv3 10,000 + adv4 8,000
        self.assertEqual((out["advances"], out["borrowers"]), (3, 3))
        near(self, out["average"], 10000.00)
        self.assertEqual(out["general"], {"amount": 20000.0, "advances": 2})
        self.assertEqual(out["term"], {"amount": 10000.0, "advances": 1})

    def test_new_and_recovered_in_the_month(self):
        body = self.api("advances", month="2026-09")
        self.assertEqual(body["newThisMonth"], {"amount": 12000.0, "count": 1, "people": 1})  # adv2, sanctioned 5 Sep
        self.assertEqual(body["recoveredThisMonth"], {"amount": 5000.0, "count": 1, "people": 1})  # adv1's September
        near(self, body["netMovement"], 7000.00)

    def test_overdue_instalments_are_those_of_an_earlier_month_not_deducted(self):
        overdue = self.api("advances", month="2026-09")["overdue"]
        near(self, overdue["amount"], 18000.00)  # adv3 Aug + Sep (10,000) and adv4 Jul 2025 (8,000)
        self.assertEqual((overdue["count"], overdue["people"]), (3, 2))  # October's instalment is not yet overdue

    def test_what_is_held_by_people_who_have_left(self):
        left = self.api("advances", month="2026-09")["exEmployees"]
        self.assertEqual(left, {"amount": 8000.0, "borrowers": 1})

    def test_ageing_buckets(self):
        rows = {a["label"]: a for a in self.api("advances", month="2026-09")["ageing"]}
        self.assertEqual((TODAY - date(2026, 9, 5)).days, 37)
        self.assertEqual(rows["31 to 90 days"], {"label": "31 to 90 days", "amount": 12000.0, "advances": 1})
        self.assertEqual(rows["181 days to a year"]["amount"], 10000.0)  # 275 days
        self.assertEqual(rows["Over a year"]["amount"], 8000.0)  # 498 days
        self.assertEqual(rows["Up to 30 days"]["amount"], 0.0)
        near(self, sum(a["amount"] for a in rows.values()), 30000.00)

    def test_the_slip_deduction_is_a_cross_check_not_the_source(self):
        body = self.api("advances", month="2026-09")
        near(self, body["deductedOnSlips"], 0.0)  # no September slip carries an advance deduction
        near(self, body["recoveryGap"], -5000.00)
        self.assertTrue(
            any(
                "deducted ₹0.00 for advances but the instalments marked recovered add up to ₹5,000.00" in n
                for n in body["notes"]
            )
        )

    def test_it_is_scoped_by_unit_and_by_type(self):
        near(
            self, self.api("advances", month="2026-09", branch="Unit 2")["outstanding"]["amount"], 8000.00
        )  # adv4 only
        near(self, self.api("advances", month="2026-09", type="production")["outstanding"]["amount"], 0.0)

    def test_an_advance_with_no_approval_date_ages_from_when_it_was_requested(self):
        Advance.objects.filter(pk=self.adv2.pk).update(approved_at=None, created_at=at(2026, 6, 1))
        rows = {a["label"]: a for a in self.api("advances", month="2026-09")["ageing"]}
        self.assertEqual(rows["91 to 180 days"]["amount"], 12000.0)  # 133 days

    def test_no_advances_is_a_real_zero_with_no_average(self):
        Advance.objects.all().delete()
        body = self.api("advances", month="2026-09")
        self.assertFalse(body["hasData"])
        self.assertEqual(body["outstanding"]["amount"], 0.0)
        self.assertIsNone(body["outstanding"]["average"])
        self.assertTrue(any("No advances" in n for n in body["notes"]))


class EmptyDatabaseTests(PayrollBase):
    """A company with no slips yet: a clear 'no payroll processed yet', never zeros."""

    ENDPOINTS = (
        "summary",
        "trend",
        "bridge",
        "departments",
        "distribution",
        "components",
        "advances",
        "exceptions",
        "status",
        "attention",
    )

    def test_every_endpoint_answers_and_none_divides_by_zero(self):
        for endpoint in self.ENDPOINTS:
            with self.subTest(endpoint=endpoint):
                body = self.api(endpoint)
                self.assertTrue(body["provenance"], "even an empty answer explains itself")
                self.assertIn("generatedAt", body)
                json.dumps(body)

    def test_the_summary_has_no_figures_and_says_so(self):
        body = self.api("summary")
        self.assertFalse(body["hasData"])
        self.assertIsNone(body["month"])
        self.assertIsNone(body["totals"])
        self.assertIn("No payroll has been processed yet", " ".join(body["notes"]))

    def test_nothing_is_zero_that_means_no_data(self):
        self.assertEqual(self.api("trend")["months"], [])
        self.assertIsNone(self.api("trend")["average"])
        self.assertFalse(self.api("bridge")["available"])
        self.assertEqual(self.api("departments")["departments"], [])
        self.assertIsNone(self.api("distribution")["stats"])
        self.assertEqual(self.api("exceptions")["rows"], [])
        self.assertEqual(self.api("attention")["items"], [])

    def test_the_status_is_empty_not_failing(self):
        body = self.api("status")
        self.assertEqual((body["available"], body["defaultMonth"], body["latestClosedMonth"]), ([], None, None))
        self.assertEqual({m["state"] for m in body["months"]}, {"no_data"})  # no payroll yet is not "not generated"

    def test_a_named_month_with_nothing_in_it_is_still_a_clean_answer(self):
        for endpoint in self.ENDPOINTS:
            with self.subTest(endpoint=endpoint):
                self.api(endpoint, month="2026-09")


class ScopeTests(ScenarioBase):
    def sep(self, **scope):
        return self.api("summary", month="2026-09", **scope)["totals"]

    def test_unit_by_name_and_by_id(self):
        near(self, self.sep(branch="Unit 2")["grossPay"], 24000.00)  # S5 15,000 + S6 9,000
        near(self, self.sep(branch=str(self.u2.id))["grossPay"], 24000.00)
        self.assertEqual(self.sep(branch="Unit 2")["headcount"], 2)

    def test_department(self):
        near(self, self.sep(department="Stitching")["grossPay"], 59787.69)
        near(self, self.sep(department="Cutting")["grossPay"], 26800.00)

    def test_staff_and_production_follow_the_slip(self):
        near(self, self.sep(type="staff")["grossPay"], 89307.69)
        near(self, self.sep(type="production")["grossPay"], 21280.00)
        self.assertEqual(self.sep(type="production")["headcount"], 2)

    def test_unit_department_and_type_together(self):
        near(self, self.sep(branch="Unit 1", type="staff")["grossPay"], 65307.69)  # S1 + S2 + S3
        near(self, self.sep(branch="Unit 1", department="Stitching", type="production")["grossPay"], 12480.00)  # P1

    def test_a_person_who_changed_type_keeps_the_kind_of_each_slip(self):
        Employee.objects.filter(pk=self.p1.pk).update(
            employment_type="staff"
        )  # P1 is staff NOW; their slips are production
        near(self, self.sep(type="production")["grossPay"], 21280.00)
        near(self, self.sep(type="staff")["grossPay"], 89307.69)

    def test_the_previous_month_follows_the_same_scope(self):
        prev = self.api("summary", month="2026-09", branch="Unit 2")["previous"]["totals"]
        near(self, prev["grossPay"], 50000.00)  # S4 40,000 + S6 10,000

    def test_every_endpoint_takes_the_scope(self):
        for endpoint in (
            "trend",
            "bridge",
            "departments",
            "distribution",
            "components",
            "advances",
            "exceptions",
            "attention",
        ):
            with self.subTest(endpoint=endpoint):
                body = self.api(endpoint, month="2026-09", branch="Unit 2", type="staff")
                self.assertEqual(body["scope"]["employmentType"], "staff")
                self.assertEqual(body["scope"]["branchIds"], [self.u2.id])

    def test_the_bridge_of_a_unit(self):
        steps = {s["id"]: s for s in self.api("bridge", month="2026-09", branch="Unit 2")["steps"]}
        near(self, steps["joined"]["amount"], 15000.00)
        near(self, steps["left"]["amount"], -40000.00)
        near(self, steps["other"]["amount"], -1000.00)
        near(self, steps["rate"]["amount"], 0.0)

    def test_unknown_names_are_a_400_the_assistant_can_correct(self):
        r = self.get(BASE + "summary", department="Rocketry")
        self.assertEqual(r.status_code, 400)
        self.assertIn("No department called", r.json()["error"])
        self.assertEqual(self.get(BASE + "summary", type="contract").status_code, 400)

    def test_a_near_miss_is_matched_and_reported(self):
        body = self.api("summary", month="2026-09", department="Stiching")
        near(self, body["totals"]["grossPay"], 59787.69)
        self.assertTrue(any("Matched department 'Stiching' to 'Stitching'" in n for n in body["notes"]))

    def test_a_scope_with_no_payroll_is_a_clean_empty_answer(self):
        lonely = Branch.objects.create(name="Unit 3")
        body = self.api("summary", branch=str(lonely.id))
        self.assertFalse(body["hasData"])
        self.assertIsNone(body["totals"])


class YearBoundaryTests(PayrollBase):
    """December to January: the previous month, the 12-month window and the provisional rule all cross a new year."""

    DEC, JAN = (2025, 12), (2026, 1)

    def setUp(self):
        super().setUp()
        patcher = mock.patch.object(P, "_today", return_value=date(2026, 2, 10))
        patcher.start()
        self.addCleanup(patcher.stop)
        self.emp = make_employee("Y1", "Yash", "staff", self.stitching, self.u1, self.operator, salary=10000)
        self.emp2 = make_employee("Y2", "Yami", "staff", self.stitching, self.u1, self.operator, salary=10000)
        make_slip(self.emp, self.DEC, 10000, generated=at(2026, 1, 3), paid=True)  # generated after December ended
        make_slip(self.emp, self.JAN, 11000, generated=at(2026, 2, 2), paid=True)
        make_slip(self.emp2, self.DEC, 10000, generated=at(2025, 12, 20))  # generated BEFORE December ended

    def test_the_previous_month_of_january_is_december_of_the_year_before(self):
        body = self.api("summary", month="2026-01")
        self.assertEqual((body["previous"]["month"], body["previous"]["label"]), ("2025-12", "Dec 2025"))
        near(self, body["totals"]["grossPay"], 11000.00)
        near(self, body["previous"]["totals"]["grossPay"], 20000.00)  # both people were paid in December
        near(self, body["change"]["grossPay"]["abs"], -9000.00)

    def test_the_bridge_crosses_the_new_year(self):
        body = self.api("bridge", month="2026-01")
        self.assertEqual((body["previousMonth"], body["previousLabel"]), ("2025-12", "Dec 2025"))
        steps = {s["id"]: s for s in body["steps"]}
        near(self, steps["left"]["amount"], -10000.00)  # Yami was not paid in January
        near(self, steps["rate"]["amount"], 1000.00)  # Yash's contract salary went from 10,000 to 11,000
        self.assertEqual(sum(D(s["amount"]) for s in body["steps"]), D("-9000.00"))

    def test_the_twelve_month_window_crosses_the_new_year_in_order(self):
        months = [m["month"] for m in self.api("trend", month="2026-02")["months"]]
        self.assertEqual(months[0], "2025-03")
        self.assertEqual(months[9:11], ["2025-12", "2026-01"])
        self.assertEqual(months[-1], "2026-02")

    def test_provisional_is_judged_against_the_month_end_across_the_year(self):
        dec = self.api("summary", month="2025-12")["status"]
        self.assertEqual(dec["provisionalSlips"], 1)  # Yami's slip, generated on 20 December
        jan = self.api("summary", month="2026-01")["status"]
        self.assertEqual(jan["provisionalSlips"], 0)  # generated on 2 February: after January ended
        self.assertEqual(dec["state"], "part_paid")
        self.assertEqual(jan["state"], "paid")

    def test_the_same_month_last_year_is_found_across_the_year(self):
        make_slip(self.emp, (2027, 1), 12000, generated=at(2027, 2, 2), paid=True)
        with mock.patch.object(P, "_today", return_value=date(2027, 2, 10)):
            body = self.api("summary", month="2027-01")
            self.assertEqual(
                self.api("summary", month="2026-01")["lastYear"], None
            )  # January 2025: no payroll, so null
        self.assertEqual((body["lastYear"]["month"], body["lastYear"]["label"]), ("2026-01", "Jan 2026"))
        near(self, body["changeLastYear"]["grossPay"]["abs"], 1000.00)  # 12,000 against 11,000
        near(self, body["changeLastYear"]["grossPay"]["pct"], 9.1, places=1)


class ParameterTests(ScenarioBase):
    def test_a_month_without_a_leading_zero_is_understood(self):
        self.assertEqual(self.api("summary", month="2026-9")["month"], "2026-09")

    def test_a_limit_that_is_not_a_number_is_a_400_that_says_so(self):
        r = self.get(BASE + "exceptions", limit="lots")
        self.assertEqual(r.status_code, 400)
        self.assertIn("'limit' must be a whole number", r.json()["error"])

    def test_a_limit_out_of_range_is_clamped(self):
        self.assertEqual(self.api("exceptions", month="2026-09", limit=0)["shown"], 1)
        self.assertLessEqual(len(self.api("exceptions", month="2026-09", limit=5000)["rows"]), 100)

    def test_legacy_weekly_production_slips_are_left_out_everywhere(self):
        SalarySlip.objects.create(
            employee=self.p1,
            month=9,
            year=2026,
            week_number=2,
            slip_number="LEGACY/1",
            basic=D(99999),
            gross_salary=D(99999),
            net_salary=D(99999),
        )
        summary = self.api("summary", month="2026-09")
        near(self, summary["totals"]["grossPay"], 110587.69)
        self.assertEqual(summary["status"]["slips"], 8)
        near(self, self.api("trend")["months"][-1]["grossPay"], 110587.69)
        self.assertEqual(
            self.api("exceptions", month="2026-09", limit=100)["total"], 1
        )  # S7's missing slip, nothing new


class RandomisedReconciliationTests(PayrollBase):
    """Messy data on purpose: leavers, joiners, duplicates, several production periods, slips with no snapshot, people
    who change kind, one-offs, awkward paise. The bridge must still add up to the paisa, and the summary, trend and
    departments must all agree with an independent sum of the slips."""

    def build(self, seed):
        import random

        rng = random.Random(seed)
        depts = [self.stitching, self.cutting, self.accounts]
        self.slip_rows = []
        for i in range(70):
            kind = rng.choice(["staff", "staff", "production"])
            emp = make_employee(
                f"R{seed}-{i}", f"r{i}", kind, rng.choice(depts), self.u1, self.operator, salary=20000, rate=450
            )
            presence = rng.choice(["both", "both", "both", "aug", "sep"])
            for ym, present in ((AUG, presence in ("both", "aug")), (SEP, presence in ("both", "sep"))):
                if not present:
                    continue
                slip_kind = kind if rng.random() > 0.08 else ("production" if kind == "staff" else "staff")
                for n in range(
                    rng.choice([1, 1, 1, 2, 3]) if slip_kind == "production" else rng.choice([1, 1, 1, 1, 2])
                ):
                    cents = f"{rng.randint(0, 99):02d}"
                    gross = D(f"{rng.randint(4000, 60000)}.{cents}")
                    extra = {
                        "ot": D(f"{rng.randint(0, 3000)}.{rng.randint(0, 99):02d}")
                        if slip_kind == "staff" and rng.random() < 0.3
                        else 0,
                        "incentives": D(f"{rng.randint(0, 500)}.00") if rng.random() < 0.1 else 0,
                        "snapshot": rng.random() > 0.15,
                    }
                    if slip_kind == "production":
                        start = date(ym[0], ym[1], 1 + n * 8)
                        make_slip(
                            emp,
                            ym,
                            gross,
                            period=(start, date(ym[0], ym[1], 7 + n * 8)),
                            shifts=D(f"{rng.randint(5, 26)}.{rng.choice(['00', '25', '50', '75'])}"),
                            rate=D(f"{rng.randint(300, 600)}.{cents}"),
                            generated=at(ym[0], ym[1] + 1, 2) if ym[1] < 12 else at(ym[0] + 1, 1, 2),
                            **extra,
                        )
                    else:
                        make_slip(
                            emp,
                            ym,
                            gross,
                            monthly=gross + D(f"{rng.randint(0, 5000)}.{cents}"),
                            eff=rng.choice([26, 25.5, 24, 20, 13]),
                            generated=at(ym[0], ym[1] + 1, 2),
                            **extra,
                        )

    def sums(self, ym):
        rows = SalarySlip.objects.filter(year=ym[0], month=ym[1], week_number__isnull=True)
        return sum((s.gross_salary + s.ot_amount for s in rows), Decimal("0"))

    def test_the_bridge_adds_up_to_the_paisa_whatever_the_data(self):
        for seed in (1, 2, 3):
            with self.subTest(seed=seed):
                SalarySlip.objects.all().delete()
                Payroll.objects.all().delete()
                self.build(seed)
                body = self.api("bridge", month="2026-09")
                steps = sum((D(s["amount"]) for s in body["steps"]), Decimal("0"))
                self.assertEqual(D(body["start"]["amount"]), self.sums(AUG))
                self.assertEqual(D(body["end"]["amount"]), self.sums(SEP))
                self.assertEqual(steps, self.sums(SEP) - self.sums(AUG))
                self.assertEqual(D(body["sumOfSteps"]), steps)
                self.assertEqual(sum(1 for s in body["steps"] if s["people"] > 0 and s["id"] == "joined"), 1)

    def test_summary_trend_and_departments_agree_with_the_slips(self):
        self.build(11)
        expected = self.sums(SEP)
        near(self, self.api("summary", month="2026-09")["totals"]["grossPay"], float(expected))
        trend = {m["month"]: m for m in self.api("trend")["months"]}
        near(self, trend["2026-09"]["grossPay"], float(expected))
        near(self, trend["2026-08"]["grossPay"], float(self.sums(AUG)))
        departments = self.api("departments", month="2026-09")
        near(self, sum(d["grossPay"] for d in departments["departments"]), float(expected), places=1)
        near(self, sum(t["grossPay"] for t in departments["types"]), float(expected), places=1)
        near(self, sum(u["grossPay"] for u in departments["units"]), float(expected), places=1)


class TypeGapTests(ScenarioBase):
    """Staff and production payroll are generated separately: a month with staff slips and no production slips (while last
    month had production) understates cost, and every production worker would otherwise look like a leaver."""

    def drop_production(self):
        SalarySlip.objects.filter(year=2026, month=9, period_start__isnull=False).delete()
        Payroll.objects.filter(year=2026, month=9, period_start__isnull=False).delete()

    def test_a_kind_of_payroll_not_generated_yet_is_called_out(self):
        self.drop_production()
        body = self.api("summary", month="2026-09")
        self.assertEqual(body["typeGaps"], [{"type": "production", "headcount": 2, "grossPay": 20500.0}])
        self.assertEqual(list(body["byType"]), ["staff"])
        self.assertTrue(
            any(
                "No production slips exist for Sep 2026, although Aug 2026 had 2 people on production payroll (₹20,500)"
                in n
                for n in body["notes"]
            ),
            body["notes"],
        )

    def test_nothing_is_called_out_when_both_kinds_have_slips(self):
        self.assertEqual(self.api("summary", month="2026-09")["typeGaps"], [])

    def test_the_bridge_says_they_appear_as_leavers(self):
        self.drop_production()
        body = self.api("bridge", month="2026-09")
        self.assertTrue(any("No production slips exist for Sep 2026" in n for n in body["notes"]), body["notes"])
        steps = {s["id"]: s for s in body["steps"]}
        self.assertEqual(steps["left"]["people"], 3)  # S4 and the two production workers
        total = sum(D(s["amount"]) for s in body["steps"])
        self.assertEqual(total, D(body["end"]["amount"]) - D(body["start"]["amount"]))

    def test_a_month_still_running_is_not_a_gap(self):
        self.drop_production()
        with mock.patch.object(P, "_today", return_value=date(2026, 9, 20)):
            self.assertEqual(self.api("summary", month="2026-09")["typeGaps"], [])

    def test_the_attention_list_names_it(self):
        self.drop_production()
        items = {i["id"]: i for i in P.insights(today=TODAY)}
        gap = items["payroll.incomplete-production"]
        self.assertEqual(gap["title"], "Production payroll for Sep 2026 has not been generated")
        self.assertEqual((gap["severity"], gap["metric"]), ("warning", "2 people"))
        self.assertIn("Aug 2026 had 2 production people (₹20,500)", gap["detail"])

    def test_a_scope_of_one_kind_cannot_have_a_gap(self):
        self.drop_production()
        self.assertEqual(self.api("summary", month="2026-09", type="staff")["typeGaps"], [])


class PermissionTests(PayrollBase):
    """Only the MD reaches payroll; tests_md_identity also walks the whole URL table."""

    def test_nobody_else_can_read_any_payroll_route(self):
        from .md_portal.routes import payroll as routes

        admin = HRUser.objects.create(username="root", password_hash="x", is_super_admin=True)
        clerk = HRUser.objects.create(username="clerk", password_hash="x")
        for route in routes.urlpatterns:
            url = BASE + str(route.pattern)
            with self.subTest(url=url):
                self.assertEqual(self.client.get(url).status_code, 401)
                for user in (admin, clerk):
                    self.assertEqual(self.client.get(url, **md_headers(user)).status_code, 403, user.username)
                self.assertEqual(self.client.get(url, **md_headers(self.md)).status_code, 200)

    def test_the_routes_are_read_only(self):
        for method in ("post", "put", "patch", "delete"):
            r = getattr(self.client, method)(BASE + "summary", **md_headers(self.md))
            self.assertEqual(r.status_code, 405, method)


TOOL_NAMES = {
    "payroll_summary",
    "payroll_trend",
    "payroll_bridge",
    "payroll_by_department",
    "payroll_components",
    "payroll_advances",
    "payroll_exceptions",
    "payroll_status",
}


class ToolsTests(AdvancesBase):
    def setUp(self):
        super().setUp()
        registry.clear_cache()
        self.tools = registry.collect_tools()

    def run_tool(self, name, args=None):
        with read_only_db():
            return self.tools[name].run(dict(args or {}))

    def test_the_payroll_tools_are_registered(self):
        self.assertEqual({n for n, t in self.tools.items() if t.page == "payroll"}, TOOL_NAMES)
        self.assertGreaterEqual(len(TOOL_NAMES), 5)

    def test_every_tool_runs_read_only_returns_plain_json_with_provenance_and_stays_small(self):
        for name in sorted(TOOL_NAMES):
            with self.subTest(tool=name):
                result = self.run_tool(name)
                text = json.dumps(result)  # plain JSON: no Decimal, no date
                self.assertLess(len(text), 20_000, "a tool result must be compact")
                self.assertTrue(result["provenance"])
                json.dumps(self.tools[name].declaration())

    def test_descriptions_say_what_the_money_is_and_when_to_use_the_tool(self):
        self.assertIn("rupees", self.tools["payroll_summary"].description)
        self.assertIn("latest CLOSED month", self.tools["payroll_summary"].properties["month"]["description"])
        self.assertIn("add up exactly", self.tools["payroll_bridge"].description)
        self.assertIn("no 'finalised' switch", self.tools["payroll_status"].description)
        self.assertIn("TDS", self.tools["payroll_components"].description)

    def test_the_summary_tool_gives_the_same_numbers_as_the_page(self):
        tool = self.run_tool("payroll_summary")
        page = self.api("summary")
        self.assertEqual(tool["totals"], page["totals"])
        self.assertEqual((tool["month"], tool["monthLabel"]), ("2026-09", "Sep 2026"))
        near(self, self.run_tool("payroll_summary", {"month": "2026-08"})["totals"]["grossPay"], 134500.00)

    def test_a_tool_takes_the_unit_department_and_type(self):
        near(self, self.run_tool("payroll_summary", {"branch": "Unit 2"})["totals"]["grossPay"], 24000.00)
        near(self, self.run_tool("payroll_summary", {"type": "production"})["totals"]["grossPay"], 21280.00)

    def test_numbers_the_model_sends_as_text_are_understood(self):
        self.assertEqual(len(self.run_tool("payroll_trend", {"months": "3"})["months"]), 3)
        self.assertEqual(len(self.run_tool("payroll_by_department", {"limit": "2"})["departments"]), 2)

    def test_the_exceptions_tool_names_people_in_the_standard_key_and_is_capped(self):
        result = self.run_tool("payroll_exceptions", {"limit": 1})
        self.assertLessEqual(len(result["rows"]), 1)
        self.assertEqual(self.tools["payroll_exceptions"].person_fields, ("name",))
        only = self.run_tool("payroll_exceptions", {"kind": "no-slip", "limit": 25})
        self.assertEqual([r["code"] for r in only["rows"]], ["S7"])

    def test_a_bad_value_is_an_error_the_model_can_correct(self):
        with self.assertRaises(MdParamError):
            self.run_tool("payroll_summary", {"month": "last month"})
        with self.assertRaises(MdParamError):
            self.run_tool("payroll_exceptions", {"kind": "gossip"})
        with self.assertRaises(MdParamError):
            self.run_tool("payroll_summary", {"department": "Rocketry"})

    def test_the_bridge_tool_names_the_main_driver(self):
        result = self.run_tool("payroll_bridge")
        self.assertEqual(result["mainDriver"]["id"], "left")
        self.assertEqual(
            sum(D(s["amount"]) for s in result["steps"]), D(result["end"]["amount"]) - D(result["start"]["amount"])
        )

    def test_the_advances_and_status_tools(self):
        near(self, self.run_tool("payroll_advances")["outstanding"]["amount"], 30000.00)
        status = self.run_tool("payroll_status", {"months": 3})
        self.assertEqual([m["month"] for m in status["months"]], ["2026-08", "2026-09", "2026-10"])

    def test_no_tool_has_a_period_parameter_payroll_is_monthly(self):
        for name in TOOL_NAMES:
            self.assertNotIn("period", self.tools[name].properties)
            self.assertNotIn("from", self.tools[name].properties)


class InsightsTests(AdvancesBase):
    def test_at_most_five_most_severe_first_in_the_dashboard_contract(self):
        with read_only_db():  # the Dashboard may call it anywhere: it must never write
            items = P.insights(today=TODAY)
        self.assertLessEqual(len(items), 5)
        order = {"critical": 0, "warning": 1, "info": 2, "good": 3}
        self.assertEqual([order[i["severity"]] for i in items], sorted(order[i["severity"]] for i in items))
        for item in items:
            self.assertEqual(set(item), {"id", "severity", "title", "detail", "metric", "page", "ask"})
            self.assertEqual(item["page"], "payroll")
            self.assertTrue(item["ask"].endswith("?"))
            self.assertTrue(item["id"].startswith("payroll."))
        json.dumps(items)

    def test_the_salary_day_has_passed_and_the_month_is_not_marked_paid(self):
        items = {i["id"]: i for i in P.insights(today=TODAY)}
        unpaid = items["payroll.unpaid-2026-09"]
        self.assertEqual(unpaid["title"], "6 of 8 slips for Sep 2026 are not marked paid")
        self.assertEqual(unpaid["severity"], "warning")  # seven days late: critical only beyond a week
        self.assertEqual(unpaid["metric"], "₹63,145")
        self.assertIn("Salary day was the 5th, 7 days ago", unpaid["detail"])

    def test_more_than_a_week_late_is_critical(self):
        with mock.patch.object(P, "_today", return_value=date(2026, 10, 20)):
            items = {i["id"]: i for i in P.insights(today=date(2026, 10, 20))}
        self.assertEqual(items["payroll.unpaid-2026-09"]["severity"], "critical")

    def test_a_month_not_generated_after_the_salary_day(self):
        with mock.patch.object(P, "_today", return_value=date(2026, 11, 20)):
            items = {i["id"]: i for i in P.insights(today=date(2026, 11, 20))}
        gap = items["payroll.not-generated-2026-10"]
        self.assertEqual((gap["severity"], gap["title"]), ("critical", "Payroll for Oct 2026 has not been generated"))
        self.assertEqual(gap["metric"], "15 days late")

    def test_provisional_slips_after_the_month_closed(self):
        items = {i["id"]: i for i in P.insights(today=TODAY)}
        self.assertEqual(
            items["payroll.provisional-2026-09"]["title"],
            "1 staff slips for Sep 2026 were generated before the month ended",
        )

    def test_a_big_fall_in_cost_names_the_main_driver_and_asks_to_check_nobody_was_missed(self):
        items = {i["id"]: i for i in P.insights(today=TODAY)}
        drop = items["payroll.cost-drop"]
        self.assertEqual(drop["title"], "Payroll cost fell 17.8% to ₹1.1 L in Sep 2026")
        self.assertIn("Mainly left payroll (-₹40,000)", drop["detail"])
        self.assertIn("Check nobody was left off payroll", drop["detail"])
        self.assertEqual(drop["metric"], "-17.8%")

    def test_a_big_rise_is_critical_beyond_fifteen_percent(self):
        for emp, gross in ((self.s1, 60000), (self.s3, 60000)):
            SalarySlip.objects.filter(employee=emp, year=2026, month=9).update(
                gross_salary=D(gross), net_salary=D(gross)
            )
        item = {i["id"]: i for i in P.insights(today=TODAY)}["payroll.cost-jump"]
        self.assertEqual(item["severity"], "critical")
        self.assertTrue(item["title"].startswith("Payroll cost rose"))

    def test_exceptions_are_counted(self):
        item = {i["id"]: i for i in P.insights(today=TODAY)}["payroll.exceptions"]
        self.assertEqual(item["title"], "1 payroll exception in Sep 2026")  # S7 has no September slip
        self.assertEqual(item["metric"], "1 person")
        self.assertEqual(item["detail"], "1 with no salary slip.")
        self.assertEqual(item["severity"], "warning")

    def test_a_month_of_only_big_swings_is_information_not_a_warning(self):
        # a bonus month: everyone's pay moved, and nothing is wrong with any one slip
        counts = {kind: 0 for kind in P.EXCEPTION_KINDS} | {"pay-swing": 127}
        with mock.patch.object(P, "_exceptions", return_value={"total": 127, "people": 127, "counts": counts}):
            item = {i["id"]: i for i in P._attention(P._context(Scope(), None, TODAY))}["payroll.exceptions"]
        self.assertEqual(item["severity"], "info")
        self.assertEqual(item["title"], "127 payroll exceptions in Sep 2026")
        self.assertEqual(item["detail"], "127 with a large change on last month.")
        self.assertEqual(item["metric"], "127 people")

    def test_advances_growing_and_held_by_people_who_left(self):
        items = {i["id"]: i for i in P.insights(today=TODAY)}
        grew = items.get("payroll.advances")
        left = items.get("payroll.advances-ex-employees")
        if grew is None or left is None:  # the cap of five may cut the lowest-priority ones: ask for all
            full = {i["id"]: i for i in P._attention(P._context(Scope(), None, TODAY))}
            grew, left = full["payroll.advances"], full["payroll.advances-ex-employees"]
        self.assertEqual(grew["title"], "Advances outstanding grew ₹7,000 in Sep 2026")
        self.assertEqual(left["title"], "₹8,000 of advances is held by people who have left")

    def test_cost_per_head_falling_is_good_news(self):
        full = {i["id"]: i for i in P._attention(P._context(Scope(), None, TODAY))}
        good = full["payroll.cost-per-head"]
        self.assertEqual((good["severity"], good["title"]), ("good", "Cost per head fell 17.8% to ₹15,798"))

    def test_overtime_rising_is_flagged(self):
        SalarySlip.objects.filter(employee=self.s1, year=2026, month=9).update(ot_amount=D(9000))
        full = {i["id"]: i for i in P._attention(P._context(Scope(), None, TODAY))}
        ot = full["payroll.overtime"]
        self.assertEqual(ot["severity"], "warning")
        self.assertIn("Overtime is 7.6% of payroll in Sep 2026 (₹9,000)", ot["title"])
        self.assertIn("Up from 0.0% in Aug 2026", ot["detail"])

    def test_nothing_to_say_on_an_empty_database(self):
        SalarySlip.objects.all().delete()
        self.assertEqual(P.insights(today=TODAY), [])

    def test_the_page_attention_list_follows_the_scope_and_month(self):
        body = self.api("attention", month="2026-09", branch="Unit 2")
        ids = {i["id"] for i in body["items"]}
        self.assertIn("payroll.cost-drop", ids)  # Unit 2: 50,000 -> 24,000
        self.assertEqual(body["month"], "2026-09")


class HeadlineTests(ScenarioBase):
    def test_the_dashboard_strip(self):
        with read_only_db():
            h = P.headline(today=TODAY)
        self.assertEqual([k["id"] for k in h["kpis"]], ["payroll-gross", "payroll-cost-per-head", "payroll-overtime"])
        gross, per_head, overtime = h["kpis"]
        near(self, gross["value"], 110587.69)
        self.assertEqual((gross["format"], gross["page"], gross["label"]), ("inr_compact", "payroll", "Payroll cost"))
        self.assertEqual(gross["sub"], "Sep 2026 · 7 people paid")
        near(self, per_head["value"], 15798.24)
        near(self, overtime["value"], 1000.00)
        self.assertEqual(overtime["sub"], "0.9% of payroll")

    def test_cost_going_down_is_the_good_direction(self):
        for kpi in P.headline(today=TODAY)["kpis"]:
            self.assertEqual(kpi["delta"]["good"], "down", kpi["id"])
        delta = P.headline(today=TODAY)["kpis"][0]["delta"]
        near(self, delta["abs"], -23912.31)
        near(self, delta["pct"], -17.8, places=1)

    def test_twelve_month_sparklines_with_gaps(self):
        spark = P.headline(today=TODAY)["kpis"][0]["spark"]
        self.assertEqual(len(spark), 12)
        self.assertEqual(spark[:10], [None] * 10)  # no payroll before August: a gap, not zero
        near(self, spark[10], 134500.00)
        near(self, spark[11], 110587.69)

    def test_it_describes_the_latest_closed_month_not_the_running_one(self):
        make_slip(self.s1, OCT, 26000, generated=at(2026, 10, 10))
        gross = P.headline(today=TODAY)["kpis"][0]
        near(self, gross["value"], 110587.69)
        self.assertTrue(gross["sub"].startswith("Sep 2026"))

    def test_provenance_and_json(self):
        h = P.headline(today=TODAY)
        self.assertTrue(h["provenance"])
        json.dumps(h)

    def test_an_empty_database_has_no_value_not_zero(self):
        SalarySlip.objects.all().delete()
        h = P.headline(today=TODAY)
        self.assertIsNone(h["kpis"][0]["value"])
        self.assertEqual(h["kpis"][0]["sub"], "No payroll processed yet")


def build_company(n_staff, n_production, branch, dept, desig, *, prefix="B"):
    """A lot of employees with August and September slips, built with bulk inserts (fast)."""
    employees = [
        Employee(
            employee_code=f"{prefix}{i}",
            first_name=f"{prefix}{i}",
            last_name="Test",
            employment_type="staff" if i < n_staff else "production",
            department=dept,
            branch=branch,
            designation=desig,
            salary_amount=D(20000 + (i % 7) * 1000) if i < n_staff else None,
            salary_per_shift=D(450) if i >= n_staff else None,
            join_date="2020-01-01",
        )
        for i in range(n_staff + n_production)
    ]
    Employee.objects.bulk_create(employees)
    employees = list(Employee.objects.filter(employee_code__startswith=prefix).order_by("id"))
    slips, payrolls = [], []
    for ym, generated in ((AUG, at(2026, 9, 2)), (SEP, at(2026, 10, 1))):
        for i, emp in enumerate(employees):
            staff = emp.employment_type == "staff"
            gross = D(emp.salary_amount if staff else 400 * (20 + i % 5))
            start, end = (None, None) if staff else (date(ym[0], ym[1], 1), date(ym[0], ym[1], 28))
            slips.append(
                SalarySlip(
                    employee=emp,
                    month=ym[1],
                    year=ym[0],
                    slip_number=f"BULK/{prefix}/{ym[0]}{ym[1]}/{i}",
                    basic=gross / 2,
                    hra=gross / 5,
                    allowances=gross - gross / 2 - gross / 5,
                    gross_salary=gross,
                    ot_amount=D(500) if staff and i % 5 == 0 else D(0),
                    pf_deduction=D(600) if staff else D(0),
                    total_deductions=D(600) if staff else D(0),
                    net_salary=gross - (600 if staff else 0),
                    working_days=26,
                    present_days=D(26),
                    breakdown_details={
                        "type": "staff" if staff else "production",
                        "summary": {"effectivePaidDays": 25.0, "totalShifts": 22.0},
                        "earnings": {"monthlySalary": float(emp.salary_amount or 0)},
                        "deductions": {"lateShiftPenalty": 0.0},
                    },
                    period_start=start,
                    period_end=end,
                )
            )
            payrolls.append(
                Payroll(
                    employee=emp,
                    salary_mode="monthly" if staff else "shift",
                    month=ym[1],
                    year=ym[0],
                    base_salary=gross,
                    gross_salary=gross,
                    final_salary=gross,
                    status="paid" if ym == AUG else "pending",
                    period_start=start,
                    period_end=end,
                )
            )
    SalarySlip.objects.bulk_create(slips)
    Payroll.objects.bulk_create(payrolls)
    return employees


class QueryCountTests(ScenarioBase):
    ENDPOINTS = (
        ("summary", {}),
        ("trend", {}),
        ("bridge", {}),
        ("departments", {}),
        ("distribution", {}),
        ("components", {}),
        ("advances", {}),
        ("exceptions", {"limit": 100}),
        ("status", {}),
    )

    def count(self, endpoint, params):
        with CaptureQueriesContext(connection) as queries:
            r = self.get(BASE + endpoint, **params)
        self.assertEqual(r.status_code, 200, r.content[:300])
        return len(queries)

    def test_the_number_of_queries_does_not_grow_with_the_number_of_people(self):
        small = {e: self.count(e, p) for e, p in self.ENDPOINTS}
        build_company(60, 20, self.u1, self.stitching, self.operator)
        large = {e: self.count(e, p) for e, p in self.ENDPOINTS}
        self.assertEqual(small, large)

    def test_the_attention_list_stays_within_a_ceiling_however_big_the_company(self):
        before = self.count("attention", {})
        build_company(60, 20, self.u1, self.stitching, self.operator)
        after = self.count("attention", {})
        self.assertLess(before, 70)
        self.assertLess(after, 70)

    def test_the_scope_does_not_change_the_query_count(self):
        build_company(40, 10, self.u1, self.cutting, self.operator)
        plain = self.count("summary", {})
        self.assertEqual(
            self.count("summary", {"branch": "Unit 1", "department": "Cutting", "type": "staff"}), plain + 2
        )  # the unit and the department are looked up by name


class SpeedTests(PayrollBase):
    """Target: under 1.5 s per endpoint with 250 employees and two months of slips."""

    def test_every_endpoint_is_fast_on_a_big_company(self):
        import time

        build_company(200, 50, self.u1, self.stitching, self.operator)
        for endpoint in (
            "summary",
            "trend",
            "bridge",
            "departments",
            "distribution",
            "components",
            "advances",
            "exceptions",
            "status",
            "attention",
        ):
            started = time.monotonic()
            r = self.get(BASE + endpoint, limit=100) if endpoint == "exceptions" else self.get(BASE + endpoint)
            took = time.monotonic() - started
            self.assertEqual(r.status_code, 200, endpoint)
            self.assertLess(took, 1.5, f"{endpoint} took {took:.2f}s")
        summary = self.api("summary", month="2026-09")["totals"]
        self.assertEqual(summary["headcount"], 250)

    def test_the_dashboard_functions_are_cheap_and_read_only(self):
        import time

        build_company(200, 50, self.u1, self.stitching, self.operator)
        for name, call in (
            ("insights", lambda: P.insights(today=TODAY)),
            ("headline", lambda: P.headline(today=TODAY)),
        ):
            started = time.monotonic()
            with read_only_db():  # the database itself refuses a write here
                call()
            took = time.monotonic() - started
            self.assertLess(took, 1.0, f"{name} took {took:.2f}s")


class CacheSafetyTests(ScenarioBase):
    """The page's functions are cached and return the SAME dict to every caller; the assistant's privacy layer edits a
    tool result in place, so a tool must hand out a private copy."""

    @override_settings(MD_ANALYTICS_CACHE_SECONDS=60)
    def test_a_tool_result_can_be_edited_without_touching_the_cache(self):
        C.CACHE.clear()
        self.addCleanup(C.CACHE.clear)
        registry.clear_cache()
        spec = registry.collect_tools()["payroll_exceptions"]
        with read_only_db():
            result = spec.run({"kind": "no-slip", "limit": 5})
        self.assertEqual(result["rows"][0]["name"], "Ilan Test")
        result["rows"][0]["name"] = "Employee #7"  # what the privacy layer does
        cached = P.payroll_exceptions(Scope(), None, 5, "no-slip")  # the very entry the tool read
        self.assertEqual(cached["rows"][0]["name"], "Ilan Test")

    @override_settings(MD_ANALYTICS_CACHE_SECONDS=60)
    def test_the_cache_serves_the_same_answer_for_the_same_question(self):
        C.CACHE.clear()
        self.addCleanup(C.CACHE.clear)
        with CaptureQueriesContext(connection) as first:
            P.payroll_summary(Scope(), "2026-09")
        with CaptureQueriesContext(connection) as second:
            P.payroll_summary(Scope(), "2026-09")
        self.assertGreater(len(first), 0)
        self.assertEqual(len(second), 0)


class ReportCentreConsistencyTests(ScenarioBase):
    """The same month through the Report Center's own reports: the numbers must agree to the paisa."""

    def setUp(self):
        super().setUp()
        patcher = mock.patch("api.reporting.filters.ist_today", return_value=TODAY)
        patcher.start()
        self.addCleanup(patcher.stop)
        self.admin = HRUser.objects.create(username="rc_admin", password_hash="x", is_super_admin=True)

    def report(self, report_id, **params):
        r = self.client.get(f"/api/reports/run/{report_id}", params, **md_headers(self.admin))
        self.assertEqual(r.status_code, 200, r.content[:400])
        return r.json()

    def test_department_salary_cost_agrees_with_the_summary(self):
        totals = self.report("department-salary-cost", period="2026-09")["totals"]
        mine = self.api("summary", month="2026-09")["totals"]
        near(self, totals["totalEarnings"], mine["grossPay"])
        near(self, totals["otAmount"], mine["overtimePay"])
        near(self, totals["totalDeductions"], mine["totalDeductions"])
        near(self, totals["netPay"], mine["netPay"])
        near(self, totals["employerCost"], mine["employerCost"])
        near(self, totals["employerEstimate"], mine["employerStatutory"])
        self.assertEqual(totals["headcount"], mine["headcount"])

    def test_each_department_row_agrees(self):
        rows = {
            r["department"]: r
            for r in self.report("department-salary-cost", period="2026-09")["rows"]
            if r.get("_kind") is None
        }
        for dept in self.api("departments", month="2026-09")["departments"]:
            row = rows[dept["name"]]
            near(self, row["totalEarnings"], dept["grossPay"], msg=dept["name"])
            near(self, row["employerCost"], dept["employerCost"], msg=dept["name"])
            self.assertEqual(row["headcount"], dept["headcount"], dept["name"])

    def test_the_month_by_month_comparison_agrees_with_the_trend(self):
        rows = {r["monthLabel"]: r for r in self.report("payroll-month-comparison", financialYear="2026-27")["rows"]}
        for month in self.api("trend")["months"]:
            if not month["hasData"]:
                continue
            row = rows[month["label"]]
            near(self, row["totalEarnings"], month["grossPay"], msg=month["label"])
            near(self, row["netPay"], month["netPay"], msg=month["label"])
            self.assertEqual(row["employeesPaid"], month["headcount"], month["label"])


def _manual_day(emp, d, shifts="1.00"):
    from .models import AttendanceDayRecord

    return AttendanceDayRecord.objects.create(
        employee=emp, date=d, status="present", shifts_earned=Decimal(shifts), is_half_shift=False, source="manual"
    )


class EngineContractTests(PayrollBase):
    """Slips made by the REAL payroll engines: proves the snapshot keys the bridge and the loss-of-pay figures read
    (earnings.monthlySalary, summary.effectivePaidDays, summary.totalShifts) are the ones the engine writes, and that
    a bridge built on engine output reconciles. February 2026 has 24 Mon-Sat working days and March 2026 has 26."""

    def setUp(self):
        super().setUp()
        from .payroll_views import _build_working_days, _generate_production_payroll, _generate_staff_payroll

        patcher = mock.patch.object(P, "_today", return_value=date(2026, 4, 10))
        patcher.start()
        self.addCleanup(patcher.stop)
        settings = PayrollSettings.get()
        settings.staff_payroll_rules_enabled = False
        settings.prod_payroll_rules_enabled = False
        settings.attendance_mode = "simple"
        settings.compensation_feature_enabled = False
        settings.save()

        self.staff = make_employee("E1", "Engine", "staff", self.stitching, self.u1, self.operator, salary=24000)
        self.worker = make_employee("E2", "Worker", "production", self.stitching, self.u1, self.operator, rate=500)
        for d in _build_working_days(2, 2026, False, set()):
            _manual_day(self.staff, d)
        _generate_staff_payroll(self.staff, 2, 2026)
        Employee.objects.filter(pk=self.staff.pk).update(salary_amount=D(26000))  # an increment before March payroll
        self.staff.refresh_from_db()
        for d in _build_working_days(3, 2026, False, set())[:22]:  # 22 of March's 26 working days
            _manual_day(self.staff, d)
        _generate_staff_payroll(self.staff, 3, 2026)
        for day in range(2, 8):  # six shifts in February's period, five in March's
            _manual_day(self.worker, date(2026, 2, day))
        for day in range(2, 7):
            _manual_day(self.worker, date(2026, 3, day))
        _generate_production_payroll(self.worker, date(2026, 2, 2), date(2026, 2, 8))
        _generate_production_payroll(self.worker, date(2026, 3, 2), date(2026, 3, 8))

    def test_the_engine_writes_the_snapshot_the_analytics_read(self):
        feb = SalarySlip.objects.get(employee=self.staff, year=2026, month=2)
        mar = SalarySlip.objects.get(employee=self.staff, year=2026, month=3)
        self.assertEqual(feb.breakdown_details["earnings"]["monthlySalary"], 24000.0)
        self.assertEqual(mar.breakdown_details["earnings"]["monthlySalary"], 26000.0)
        self.assertEqual(mar.breakdown_details["summary"]["effectivePaidDays"], 22.0)
        prod = SalarySlip.objects.get(employee=self.worker, year=2026, month=3)
        self.assertEqual(prod.breakdown_details["summary"]["totalShifts"], 5.0)
        near(self, float(feb.gross_salary), 24000.00)
        near(self, float(mar.gross_salary), 22000.00)  # 26,000 x 22/26
        near(self, float(prod.gross_salary), 2500.00)

    def test_the_bridge_of_engine_slips_splits_rate_from_attendance_and_reconciles(self):
        body = self.api("bridge", month="2026-03")
        steps = {s["id"]: s for s in body["steps"]}
        near(self, body["start"]["amount"], 27000.00)  # 24,000 + 3,000
        near(self, body["end"]["amount"], 24500.00)  # 22,000 + 2,500
        near(self, steps["rate"]["amount"], 2000.00)  # the increment: 26,000 vs 24,000
        near(
            self, steps["attendance"]["amount"], -4500.00
        )  # staff: -4,000 (26,000 - 22,000 lost to absence, vs none); production -500
        near(self, steps["other"]["amount"], 0.0)  # nothing is left over when every slip has its snapshot
        self.assertEqual(sum(D(s["amount"]) for s in body["steps"]), D("-2500.00"))

    def test_loss_of_pay_days_come_from_the_engines_effective_days(self):
        t = self.api("summary", month="2026-03")["totals"]
        near(self, t["lopDays"], 4.0, places=1)  # 26 working days less 22 paid; the production slip has none
        near(self, self.api("summary", month="2026-02")["totals"]["lopDays"], 0.0, places=1)

    def test_the_status_reads_the_engines_payroll_rows(self):
        Payroll.objects.filter(employee=self.staff, month=3, year=2026).update(status="paid")
        st = self.api("summary", month="2026-03")["status"]
        self.assertEqual((st["slips"], st["paidSlips"], st["state"]), (2, 1, "part_paid"))

"""MD portal: PRODUCTION payroll analytics (md_portal/analytics/payroll_production.py, routes/payroll.py production/*),
checked figure by figure against a small HAND-COMPUTABLE factory, against HR's own Production Salary Statement and
against the TypeScript contract (frontend/src/pages/md/payroll-dashboard/types.ts, the Prod* types).

THE SCENARIO ("today" is pinned to Thursday 12 November 2026)

  Workers (production): W1 Kavi Stitching/Unit 1 BiWeekly 500 a shift; W2 Mani Cutting/Unit 2 BiWeekly 400; W3 Ravi
  Stitching/Unit 1 BiWeekly 450, has LEFT (inactive); W4 Selvi Stitching/Unit 1 Weekly 600; W5 Nila Cutting/Unit 2
  BiWeekly 400, joined 28 Oct (a new joiner); W6 Arun Stitching/Unit 1, no cycle. S1 is staff (never on this side).

  BiWeekly
    P0 24 Sep - 7 Oct (generated before the cycles: nothing stamped, the worker is BiWeekly now): W2 10 shifts = 4,000,
       marked paid one by one (no close): state Paid
    P1 8 - 21 Oct, Payroll Done 23 Oct, Mark as Paid 25 Oct (paid on 25 Oct): W1 12 shifts = 6,000; W2 10 = 4,000 less
       an advance of 500 = 3,500; W3 11 x 450 = 4,950. Gross 14,950, net 14,450, cost 14,950
    P2 22 Oct - 4 Nov, Payroll Done 6 Nov, not paid: W1 13 shifts = 6,500, Excess 1,000 and Detection 200 (bonus 800),
       late penalty 250, ESI 49 (employer ESI 3.25% of 6,500 = 211.25), net 7,001, 2 late days, Cleared; W2 12 x 400 =
       4,800; W3 10 x 450 = 4,500; W5 5 x 400 = 2,000 PARKED in New Joiners (out of every figure).
       Gross 15,800, bonus 800, deductions 299, net 16,301, employer 211.25, cost 16,811.25; 35 shifts
  Weekly: W4 26 Oct - 1 Nov 6 shifts = 3,600 (paid one by one) and 2 - 8 Nov 5 shifts = 3,000
  No pay cycle: W6 1 - 14 Aug 8 x 300 = 2,400

  Production months (the month a period ENDS in): Aug 2,400; Oct 4,000 + 14,450 = 18,450 net; Nov 16,301 + 3,600 +
  3,000 = 22,901 net
"""

import time as clock
from datetime import date, datetime
from decimal import Decimal
from unittest import mock

from django.db import connection
from django.test.utils import CaptureQueriesContext

from .clock import FACTORY_TZ
from .md_portal.analytics import payroll as P
from .md_portal.analytics import payroll_production as PR
from .md_portal.common import MdParamError, Scope, read_only_db
from .models import Branch, Department, Employee, HRUser, Payroll, ProductionPeriodClose, SalarySlip
from .tests_md_payroll_people import _TsContract, near
from .tests_md_support import MdApiTestCase, md_headers

TODAY = date(2026, 11, 12)
BASE = "/api/md/payroll/production/"
P0 = (date(2026, 9, 24), date(2026, 10, 7))
P1 = (date(2026, 10, 8), date(2026, 10, 21))
P2 = (date(2026, 10, 22), date(2026, 11, 4))
WK1 = (date(2026, 10, 26), date(2026, 11, 1))
WK2 = (date(2026, 11, 2), date(2026, 11, 8))
AUG = (date(2026, 8, 1), date(2026, 8, 14))
_SERIAL = iter(range(1, 10_000_000))


def D(value) -> Decimal:
    return Decimal(str(value))


def at(year, month, day, hour=9, minute=0) -> datetime:
    return datetime(year, month, day, hour, minute, tzinfo=FACTORY_TZ)


def period_slip(
    emp,
    period,
    *,
    shifts,
    rate,
    absent=0,
    cycle="biweekly",
    stamp=True,
    late=0,
    esi=0,
    adv=0,
    excess=0,
    detection=0,
    late_days=0,
    cleared=False,
    paid_at=None,
    parked="",
):
    """A production period payslip and its payroll row, shaped like payroll_views._generate_production_payroll's."""
    start, end = period
    span = (end - start).days + 1
    gross = D(shifts) * D(rate)
    bonus = D(excess) - D(detection)
    ded = D(late) + D(esi) + D(adv)
    net = gross + bonus - ded
    days = [
        {"date": f"{start.isoformat()}", "day": "Thursday", "status": "present", "shiftsEarned": 1.0, "isLate": True}
        for _ in range(late_days)
    ] + [
        {"date": f"{end.isoformat()}", "day": "Wednesday", "status": "present", "shiftsEarned": 1.0, "isLate": False}
        for _ in range(span - late_days)
    ]
    breakdown = {
        "type": "production",
        "salaryPerShift": float(rate),
        "days": days,
        "summary": {
            "totalDays": span,
            "periodDays": span,
            "daysWorked": span - absent,
            "daysAbsent": absent,
            "totalShifts": float(shifts),
        },
        "earnings": {"totalShifts": float(shifts), "salaryPerShift": float(rate), "grossSalary": float(gross)},
        "deductions": {"esi": float(esi), "advances": float(adv), "lateShiftPenalty": float(late), "total": float(ded)},
        "excess": {"excess": float(excess), "detection": float(detection), "net": float(bonus)},
        "netSalary": float(net),
    }
    stamped = {"pay_cycle": cycle} if stamp else {}
    SalarySlip.objects.create(
        employee=emp,
        month=end.month,
        year=end.year,
        slip_number=f"T/{emp.employee_code}/{next(_SERIAL)}",
        basic=gross,
        gross_salary=gross,
        bonuses=bonus,
        esi_deduction=D(esi),
        advance_deduction=D(adv),
        other_deductions=D(late),
        total_deductions=ded,
        net_salary=net,
        working_days=span,
        present_days=D(shifts),
        absent_days=D(absent),
        period_start=start,
        period_end=end,
        breakdown_details=breakdown,
        **stamped,
    )
    return Payroll.objects.create(
        employee=emp,
        salary_mode="shift",
        month=end.month,
        year=end.year,
        base_salary=gross,
        gross_salary=gross,
        deductions=ded,
        bonus=bonus,
        final_salary=net,
        status="paid" if cleared else "pending",
        period_start=start,
        period_end=end,
        payment_status="paid" if paid_at else "not_paid",
        payment_paid_at=paid_at,
        new_joiner_parked=bool(parked),
        parked_reason=parked,
        **stamped,
    )


class Base(MdApiTestCase):
    @classmethod
    def setUpTestData(cls):
        cls.u1 = Branch.objects.create(name="Unit 1", code="U1")
        cls.u2 = Branch.objects.create(name="Unit 2", code="U2")
        cls.stitching = Department.objects.create(name="Stitching", branch=cls.u1, category="production")
        cls.cutting = Department.objects.create(name="Cutting", branch=cls.u2, category="production")
        cls.accounts = Department.objects.create(name="Accounts", branch=cls.u2, category="staff")

        def worker(code, first, dept, branch, cycle, rate, status="active", join="2020-01-01"):
            return Employee.objects.create(
                employee_code=code,
                first_name=first,
                last_name="Prod",
                employment_type="production",
                department=dept,
                branch=branch,
                status=status,
                join_date=join,
                production_pay_cycle=cycle,
                salary_per_shift=D(rate),
            )

        cls.w1 = worker("W1", "Kavi", cls.stitching, cls.u1, "biweekly", 500)
        cls.w2 = worker("W2", "Mani", cls.cutting, cls.u2, "biweekly", 400)
        cls.w3 = worker("W3", "Ravi", cls.stitching, cls.u1, "biweekly", 450, status="inactive")
        cls.w4 = worker("W4", "Selvi", cls.stitching, cls.u1, "weekly", 600)
        cls.w5 = worker("W5", "Nila", cls.cutting, cls.u2, "biweekly", 400, join="2026-10-28")
        cls.w6 = worker("W6", "Arun", cls.stitching, cls.u1, None, 300)
        cls.s1 = Employee.objects.create(
            employee_code="S1",
            first_name="Sara",
            last_name="Staff",
            employment_type="staff",
            department=cls.accounts,
            branch=cls.u2,
            status="active",
            salary_amount=D(20000),
        )
        SalarySlip.objects.create(
            employee=cls.s1, month=10, year=2026, slip_number="T/S1/10", gross_salary=D(20000), net_salary=D(20000)
        )
        Payroll.objects.create(
            employee=cls.s1,
            salary_mode="monthly",
            month=10,
            year=2026,
            base_salary=D(20000),
            gross_salary=D(20000),
            final_salary=D(20000),
        )

        period_slip(cls.w2, P0, shifts=10, rate=400, stamp=False, paid_at=at(2026, 10, 9))
        paid_p1 = at(2026, 10, 25, 11)
        period_slip(cls.w1, P1, shifts=12, rate=500, absent=2, cleared=True, paid_at=paid_p1)
        period_slip(cls.w2, P1, shifts=10, rate=400, adv=500, cleared=True, paid_at=paid_p1)
        period_slip(cls.w3, P1, shifts=11, rate=450, cleared=True, paid_at=paid_p1)
        ProductionPeriodClose.objects.create(
            cycle="biweekly",
            period_start=P1[0],
            period_end=P1[1],
            finalized_at=at(2026, 10, 23, 10),
            finalized_by="Priya",
            paid_at=paid_p1,
            paid_by="Priya",
            paid_on=date(2026, 10, 25),
        )
        period_slip(
            cls.w1, P2, shifts=13, rate=500, excess=1000, detection=200, late=250, esi=49, late_days=2, cleared=True
        )
        period_slip(cls.w2, P2, shifts=12, rate=400)
        period_slip(cls.w3, P2, shifts=10, rate=450, absent=4)
        period_slip(cls.w5, P2, shifts=5, rate=400, parked=Payroll.PARKED_NEW_JOINER)
        ProductionPeriodClose.objects.create(
            cycle="biweekly", period_start=P2[0], period_end=P2[1], finalized_at=at(2026, 11, 6), finalized_by="Priya"
        )
        period_slip(cls.w4, WK1, shifts=6, rate=600, cycle="weekly", paid_at=at(2026, 11, 3))
        period_slip(cls.w4, WK2, shifts=5, rate=600, cycle="weekly")
        period_slip(cls.w6, AUG, shifts=8, rate=300, stamp=False)

    def setUp(self):
        super().setUp()
        patcher = mock.patch.object(P, "_today", return_value=TODAY)
        patcher.start()
        self.addCleanup(patcher.stop)

    def api(self, endpoint, **params):
        response = self.get(BASE + endpoint, **params)
        self.assertEqual(response.status_code, 200, response.content[:400])
        body = response.json()
        body.pop("tookMs", None)
        return body

    @staticmethod
    def period(p):
        return {"periodStart": p[0].isoformat(), "periodEnd": p[1].isoformat()}


# ─────────────────────────────────────────────────────────────────────────────
#  1. overview
# ─────────────────────────────────────────────────────────────────────────────


class OverviewTests(Base):
    def test_the_default_is_the_main_cycle_and_its_latest_ended_period(self):
        body = self.api("overview")
        self.assertEqual((body["cycle"], body["cycleLabel"]), ("biweekly", "BiWeekly"))
        self.assertEqual(body["period"]["key"], "2026-10-22_2026-11-04")
        self.assertEqual(body["period"]["label"], "22 Oct - 4 Nov 2026")
        self.assertEqual([c["cycle"] for c in body["cycles"]], ["weekly", "biweekly", "none"])
        biweekly = next(c for c in body["cycles"] if c["cycle"] == "biweekly")
        # W1, W2 and W5 are on BiWeekly now (W3 has left)
        self.assertEqual((biweekly["periods"], biweekly["assigned"], biweekly["latestEnd"]), (3, 3, "2026-11-04"))
        self.assertEqual(
            [(p["key"], p["state"], p["slips"]) for p in body["periods"]],
            [
                ("2026-10-22_2026-11-04", "finalized", 3),  # the parked new joiner is not a payslip of the period
                ("2026-10-08_2026-10-21", "paid", 3),
                ("2026-09-24_2026-10-07", "paid", 1),  # nothing stamped: the worker's cycle now; paid one by one
            ],
        )

    def test_the_period_figure_by_figure(self):
        cur = self.api("overview")["current"]
        self.assertEqual((cur["employees"], cur["slips"], cur["shifts"]), (3, 3, 35.0))
        near(self, cur["grossPay"], 15800)
        self.assertEqual((cur["excess"], cur["detection"], cur["bonus"]), (1000.0, 200.0, 800.0))
        self.assertEqual(
            cur["deductions"],
            {"pf": 0.0, "esi": 49.0, "tds": 0.0, "advance": 0.0, "late": 250.0, "other": 0.0, "total": 299.0},
        )
        near(self, cur["netPaid"], 16301)
        near(self, cur["employerPfEsi"], 211.25)
        near(self, cur["companyCost"], 16811.25)
        near(self, cur["averageRatePerShift"], 451.43)  # 15,800 / 35
        near(self, cur["averageNetPerWorker"], 5433.67)
        self.assertEqual((cur["daysWorked"], cur["daysAbsent"], cur["daysPaid"]), (38.0, 4.0, 42.0))
        near(self, cur["attendancePct"], 90.5, places=1)

    def test_where_the_period_stands(self):
        st = self.api("overview")["status"]
        self.assertEqual((st["state"], st["label"], st["locked"]), ("finalized", "Payroll Done", True))
        self.assertEqual((st["finalizedAt"], st["finalizedBy"], st["paidAt"]), ("2026-11-06T09:00:00", "Priya", None))
        self.assertEqual(st["paymentPendingDays"], 6)
        self.assertEqual((st["slips"], st["paidSlips"], st["unpaidSlips"], st["clearedSlips"]), (3, 0, 3, 1))
        near(self, st["unpaidNet"], 16301)
        self.assertEqual(st["parked"], {"count": 1, "newJoiners": 1, "movedIn": 0, "net": 2000.0})
        self.assertEqual((st["leftSince"], st["leftSinceNet"]), (1, 4500.0))
        self.assertIn("Payroll Done on 6 Nov 2026: payment pending for 6 days", st["detail"])
        self.assertIn("1 worker waiting in New Joiners", st["detail"])
        p1 = self.api("overview", cycle="biweekly", **self.period(P1))["status"]
        self.assertEqual((p1["state"], p1["paidOn"], p1["daysToPay"], p1["paidBy"]), ("paid", "2026-10-25", 2, "Priya"))
        self.assertEqual(p1["detail"], "Paid on 25 Oct 2026, 2 days after Payroll Done.")

    def test_the_period_before_and_the_change(self):
        body = self.api("overview")
        self.assertEqual(body["previous"]["key"], "2026-10-08_2026-10-21")
        near(self, body["previous"]["companyCost"], 14950)
        near(self, body["previous"]["netPaid"], 14450)
        self.assertEqual(body["change"]["companyCost"], {"abs": 1861.25, "pct": 12.4})
        self.assertEqual(body["change"]["netPaid"], {"abs": 1851.0, "pct": 12.8})
        self.assertEqual(body["change"]["deductions"], {"abs": -201.0, "pct": -40.2})
        self.assertEqual(set(body["change"]), set(PR.CHANGE_KEYS))
        self.assertTrue(any("1 worker paid in this period has left since" in n for n in body["notes"]), body["notes"])

    def test_the_trend_of_the_cycle_oldest_first(self):
        trend = self.api("overview")["trend"]
        self.assertEqual([t["key"][:10] for t in trend], ["2026-09-24", "2026-10-08", "2026-10-22"])
        self.assertEqual([t["netPaid"] for t in trend], [4000.0, 14450.0, 16301.0])
        self.assertEqual(len(self.api("overview", periods=2)["trend"]), 2)

    def test_the_production_months_and_the_year(self):
        body = self.api("overview")
        months = {m["month"]: m for m in body["months"]}
        self.assertEqual(list(months), ["2026-08", "2026-10", "2026-11"])
        self.assertEqual((months["2026-10"]["netPaid"], months["2026-10"]["periods"]), (18450.0, 2))
        nov = months["2026-11"]
        near(self, nov["netPaid"], 22901)
        self.assertEqual(
            [(c["cycle"], c["netPaid"], c["employees"]) for c in nov["cycles"]],
            [("weekly", 6600.0, 1), ("biweekly", 16301.0, 3)],
        )
        self.assertEqual(months["2026-08"]["cycles"][0]["cycle"], "none")
        yearly = body["yearly"]
        self.assertEqual((yearly["current"]["from"], yearly["current"]["to"]), ("2026-01", "2026-11"))
        near(self, yearly["current"]["netPaid"], 2400 + 18450 + 22901)
        self.assertIsNone(yearly["previous"])
        self.assertIsNone(yearly["change"])

    def test_another_cycle_and_period(self):
        weekly = self.api("overview", cycle="weekly")
        self.assertEqual((weekly["period"]["key"], weekly["current"]["netPaid"]), ("2026-11-02_2026-11-08", 3000.0))
        self.assertEqual(weekly["status"]["state"], "generated")
        older = self.api("overview", cycle="weekly", **self.period(WK1))
        self.assertEqual(older["status"]["state"], "paid")  # its one payslip is marked paid (no close)
        none = self.api("overview", cycle="none")
        self.assertEqual((none["cycleLabel"], none["current"]["grossPay"]), ("No pay cycle", 2400.0))

    def test_a_period_with_no_payroll_and_a_cycle_with_none(self):
        body = self.api("overview", cycle="biweekly", periodStart="2026-11-05", periodEnd="2026-11-18")
        self.assertIsNone(body["current"])
        self.assertEqual(len(body["periods"]), 3)
        self.assertTrue(any("There is no BiWeekly payroll for 5 Nov - 18 Nov 2026" in n for n in body["notes"]))
        monthly = self.api("overview", cycle="monthly")
        self.assertIsNone(monthly["period"])
        self.assertTrue(any("No Monthly payroll" in n for n in monthly["notes"]))

    def test_the_unit_and_department_filters(self):
        u2 = self.api("overview", branch=str(self.u2.id))
        self.assertEqual((u2["cycle"], u2["current"]["employees"], u2["current"]["netPaid"]), ("biweekly", 1, 4800.0))
        self.assertEqual(u2["status"]["parked"]["count"], 1)  # Nila works in Unit 2
        self.assertEqual(u2["scope"], {"branch": "Unit 2", "department": None, "type": "production"})
        stitching = self.api("overview", department="Stitching")
        near(self, stitching["current"]["netPaid"], 7001 + 4500)
        self.assertEqual(stitching["status"]["parked"]["count"], 0)

    def test_the_department_options_are_production_ones(self):
        names = [d["name"] for d in self.api("overview")["departments"]]
        self.assertEqual(names, ["Cutting", "Stitching"])  # Accounts is a staff department

    def test_bad_parameters_are_400s(self):
        self.assertEqual(self.get(BASE + "overview", cycle="daily").status_code, 400)
        self.assertEqual(self.get(BASE + "overview", periodStart="2026-10-22").status_code, 400)
        self.assertEqual(self.get(BASE + "overview", periodStart="x", periodEnd="y").status_code, 400)
        self.assertEqual(self.get(BASE + "overview", periodStart="2026-11-04", periodEnd="2026-10-22").status_code, 400)
        self.assertEqual(self.get(BASE + "overview", periods="many").status_code, 400)


# ─────────────────────────────────────────────────────────────────────────────
#  2. departments
# ─────────────────────────────────────────────────────────────────────────────


class DepartmentTests(Base):
    def test_every_department_of_the_period_with_the_period_before(self):
        body = self.api("departments")
        self.assertEqual(body["period"]["key"], "2026-10-22_2026-11-04")
        self.assertEqual(body["previousPeriod"]["key"], "2026-10-08_2026-10-21")
        rows = {r["department"]: r for r in body["rows"]}
        self.assertEqual([r["department"] for r in body["rows"]], ["Stitching", "Cutting"])
        st = rows["Stitching"]
        self.assertEqual((st["unit"], st["employees"], st["shifts"]), ("Unit 1", 2, 23.0))
        near(self, st["companyCost"], 12011.25)
        near(self, st["netPaid"], 11501)
        near(self, st["sharePct"], 71.4, places=1)
        self.assertEqual((st["previousCompanyCost"], st["previousNetPaid"]), (10950.0, 10950.0))
        self.assertEqual(st["change"], {"abs": 1061.25, "pct": 9.7})
        cut = rows["Cutting"]
        self.assertEqual((cut["companyCost"], cut["change"]), (4800.0, {"abs": 800.0, "pct": 20.0}))
        near(self, sum(r["companyCost"] for r in body["rows"]), body["totals"]["companyCost"])

    def test_no_period_is_a_clean_answer(self):
        body = self.api("departments", cycle="monthly")
        self.assertEqual((body["rows"], body["period"]), ([], None))
        self.assertTrue(body["notes"])


# ─────────────────────────────────────────────────────────────────────────────
#  3. people
# ─────────────────────────────────────────────────────────────────────────────


class PeopleTests(Base):
    def rows(self, **params):
        return self.api("people", **params)["rows"]

    def test_one_row_per_worker_of_the_period(self):
        body = self.api("people")
        self.assertEqual(body["total"], 3)  # Nila is parked in New Joiners
        self.assertEqual([r["code"] for r in body["rows"]], ["W1", "W2", "W3"])
        kavi = body["rows"][0]
        self.assertEqual(
            (kavi["ratePerShift"], kavi["shifts"], kavi["lateDays"], kavi["daysPaid"], kavi["periodDays"]),
            (500.0, 13.0, 2, 14.0, 14.0),
        )
        self.assertEqual(
            (kavi["grossPay"], kavi["excess"], kavi["detection"], kavi["bonus"]), (6500.0, 1000.0, 200.0, 800.0)
        )
        self.assertEqual((kavi["deductions"]["total"], kavi["netPaid"]), (299.0, 7001.0))
        near(self, kavi["companyCost"], 7511.25)
        self.assertEqual((kavi["cleared"], kavi["paymentStatus"]), (True, "not_paid"))
        self.assertEqual(body["rows"][2]["status"], "inactive")  # Ravi has left: still the period's cost

    def test_search_sort_and_paging(self):
        self.assertEqual([r["code"] for r in self.rows(q="mani")], ["W2"])
        self.assertEqual([r["code"] for r in self.rows(q="w3")], ["W3"])
        self.assertEqual([r["code"] for r in self.rows(sort="netPaid", dir="desc")], ["W1", "W2", "W3"])
        self.assertEqual([r["code"] for r in self.rows(sort="daysAbsent", dir="desc")][0], "W3")
        self.assertEqual([r["code"] for r in self.rows(sort="lateDays", dir="desc")][0], "W1")
        for sort in PR.SORTS:
            self.assertEqual(len(self.rows(sort=sort)), 3, sort)
        page = self.api("people", page=2, pageSize=2)
        self.assertEqual(([r["code"] for r in page["rows"]], page["total"]), (["W3"], 3))
        near(self, page["totals"]["netPaid"], 16301)  # every match, not just this page
        body = self.api("people", q="nobody")
        self.assertEqual((body["total"], body["rows"]), (0, []))
        self.assertTrue(any("Nobody matches 'nobody'" in n for n in body["notes"]))

    def test_bad_sort_or_direction_is_a_400(self):
        r = self.get(BASE + "people", sort="salary")
        self.assertEqual(r.status_code, 400)
        self.assertIn("netPaid", r.json()["error"])
        self.assertEqual(self.get(BASE + "people", dir="up").status_code, 400)


# ─────────────────────────────────────────────────────────────────────────────
#  4. one worker
# ─────────────────────────────────────────────────────────────────────────────


class PersonTests(Base):
    def test_a_workers_periods_newest_first_with_the_days(self):
        body = self.api(f"people/{self.w1.id}")
        self.assertEqual(
            {k: body["employee"][k] for k in ("code", "name", "type", "cycle", "cycleLabel", "ratePerShift")},
            {
                "code": "W1",
                "name": "Kavi Prod",
                "type": "production",
                "cycle": "biweekly",
                "cycleLabel": "BiWeekly",
                "ratePerShift": 500.0,
            },
        )
        p2, p1 = body["periods"]
        self.assertEqual(
            (p2["key"], p2["state"], p2["cleared"], p2["paymentStatus"]),
            ("2026-10-22_2026-11-04", "finalized", True, "not_paid"),
        )
        self.assertEqual((p2["netPaid"], p2["bonus"], p2["lateDays"], len(p2["days"])), (7001.0, 800.0, 2, 14))
        self.assertEqual(p2["days"][0]["late"], True)
        self.assertEqual(
            (p1["state"], p1["paymentStatus"], p1["paymentPaidAt"]), ("paid", "paid", "2026-10-25T11:00:00")
        )
        near(self, body["totals"]["netPaid"], 7001 + 6000)
        self.assertEqual(len(self.api(f"people/{self.w1.id}", periods=1)["periods"]), 1)

    def test_a_parked_worker_has_no_periods_and_a_note(self):
        body = self.api(f"people/{self.w5.id}")
        self.assertEqual(body["periods"], [])
        self.assertTrue(any("Waiting in New Joiners" in n and "22 Oct - 4 Nov 2026" in n for n in body["notes"]))

    def test_an_unknown_worker_is_a_404(self):
        r = self.get(BASE + "people/999999")
        self.assertEqual(r.status_code, 404)
        self.assertEqual(self.get(BASE + f"people/{self.w1.id}", periods="x").status_code, 400)


# ─────────────────────────────────────────────────────────────────────────────
#  the HRMS's own figures, read-only, bounded, MD only
# ─────────────────────────────────────────────────────────────────────────────


class RuleTests(Base):
    def test_the_period_matches_hrs_production_salary_statement(self):
        """HR's Production Salary Statement of P2 lists the period's main payroll of ACTIVE workers: W1 and W2. The MD
        figure is the same plus the worker who has left since (W3, reported as leftSince)."""
        admin = HRUser.objects.create(username="stmt_admin", password_hash="x", is_super_admin=True)
        r = self.client.get(
            "/api/payroll/production/salary-statement",
            {"cycle": "biweekly", **self.period(P2)},
            **md_headers(admin),
        )
        self.assertEqual(r.status_code, 200, r.content[:300])
        statement = {row["values"]["code"]: row["values"] for g in r.json()["groups"] for row in g["rows"]}
        self.assertEqual(sorted(statement), ["W1", "W2"])
        people = {row["code"]: row for row in self.api("people")["rows"]}
        for code, line in statement.items():
            with self.subTest(code=code):
                near(self, people[code]["netPaid"], line["net"])
                near(self, people[code]["grossPay"] + people[code]["bonus"], line["eSalary"])
                near(self, people[code]["deductions"]["total"], line["totalDeduction"])
                self.assertEqual(people[code]["shifts"], line["shifts"])
        status = self.api("overview")["status"]
        near(self, sum(line["net"] for line in statement.values()) + status["leftSinceNet"], 16301)

    def test_staff_payslips_are_never_on_this_side(self):
        body = self.api("people", q="sara")
        self.assertEqual(body["total"], 0)
        self.assertNotIn("Accounts", [d["name"] for d in self.api("overview")["departments"]])

    def test_a_parked_worker_counts_once_added(self):
        Payroll.objects.filter(employee=self.w5).update(new_joiner_parked=False, parked_reason="")
        cur = self.api("overview")["current"]
        self.assertEqual((cur["employees"], cur["netPaid"]), (4, 18301.0))

    def test_the_payroll_analysis_leaves_parked_production_out_too(self):
        st = P._month_states(Scope(employment_type="production"), [(2026, 11)], TODAY, [(2026, 11)])[(2026, 11)]
        self.assertEqual(st["productionParked"], 1)
        self.assertEqual(P._slips(Scope(employment_type="production"), [(2026, 11)]).count(), 5)  # Nila left out

    def test_every_endpoint_is_read_only_and_bounded(self):
        with read_only_db():
            PR.production_overview(PR.production_scope(Scope()))
            PR.production_departments(PR.production_scope(Scope()))
            PR.production_people(PR.production_scope(Scope()))
            PR.production_person(self.w1.id)
        endpoints = ("overview", "departments", "people", f"people/{self.w1.id}")

        def counts():
            out = {}
            for endpoint in endpoints:
                with CaptureQueriesContext(connection) as queries:
                    self.api(endpoint)
                out[endpoint] = len(queries)
            return out

        small = counts()
        for i in range(25):  # twenty-five more workers in the period
            emp = Employee.objects.create(
                employee_code=f"X{i}",
                first_name=f"x{i}",
                last_name="Prod",
                employment_type="production",
                department=self.stitching,
                branch=self.u1,
                status="active",
                production_pay_cycle="biweekly",
            )
            period_slip(emp, P2, shifts=10, rate=400, late_days=1)
        self.assertEqual(counts(), small)  # a fixed number of queries, however many workers
        self.assertLessEqual(max(small.values()), 16)

    def test_the_routes_are_locked_to_the_md_and_get_only(self):
        clerk = HRUser.objects.create(username="prod_clerk", password_hash="x")
        for url in ("overview", "departments", "people", f"people/{self.w1.id}"):
            with self.subTest(url=url):
                self.assertEqual(self.client.get(BASE + url).status_code, 401)
                self.assertEqual(self.client.get(BASE + url, **md_headers(clerk)).status_code, 403)
                self.assertEqual(self.client.post(BASE + url, **md_headers(self.md)).status_code, 405)

    def test_a_bad_parameter_is_an_error_the_caller_can_read(self):
        with self.assertRaises(MdParamError):
            PR.production_people(PR.production_scope(Scope()), None, None, None, "salary")
        with self.assertRaises(MdParamError):
            PR.normalise_cycle("fortnightly")


class EmptyTests(MdApiTestCase):
    def test_nothing_generated_is_a_clean_answer(self):
        for endpoint in ("overview", "departments", "people"):
            with self.subTest(endpoint=endpoint):
                r = self.get(BASE + endpoint)
                self.assertEqual(r.status_code, 200)
                body = r.json()
                self.assertIsNone(body["period"])
                self.assertTrue(body["notes"])


# ─────────────────────────────────────────────────────────────────────────────
#  the TypeScript contract
# ─────────────────────────────────────────────────────────────────────────────


class ContractTests(Base):
    def check(self, body, type_name):
        for attempt in range(3):  # another agent may be rewriting the contract file
            try:
                contract = _TsContract()
                break
            except AssertionError:
                if attempt == 2:
                    raise
                clock.sleep(0.5)
        self.assertIn(type_name, contract.types)
        self.assertEqual(contract.errors(body, ("ref", type_name)), [])

    def test_overview(self):
        self.check(self.api("overview"), "ProdOverviewResponse")
        self.check(self.api("overview", cycle="monthly"), "ProdOverviewResponse")
        self.check(
            self.api("overview", cycle="biweekly", periodStart="2026-11-05", periodEnd="2026-11-18"),
            "ProdOverviewResponse",
        )

    def test_departments(self):
        self.check(self.api("departments"), "ProdDepartmentsResponse")
        self.check(self.api("departments", cycle="monthly"), "ProdDepartmentsResponse")

    def test_people(self):
        self.check(self.api("people"), "ProdPeopleResponse")
        self.check(self.api("people", q="nobody"), "ProdPeopleResponse")

    def test_person(self):
        for emp in (self.w1, self.w5, self.w6):
            with self.subTest(emp=emp.employee_code):
                self.check(self.api(f"people/{emp.id}"), "ProdPersonResponse")

    def test_an_empty_company(self):
        SalarySlip.objects.all().delete()
        self.check(self.api("overview"), "ProdOverviewResponse")
        self.check(self.api("departments"), "ProdDepartmentsResponse")
        self.check(self.api("people"), "ProdPeopleResponse")

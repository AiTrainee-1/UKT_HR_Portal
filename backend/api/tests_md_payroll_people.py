"""MD portal: the employee-focused Payroll page (md_portal/analytics/payroll_people.py, routes/payroll.py), checked figure
by figure against a small HAND-COMPUTABLE company and against the TypeScript contract
(frontend/src/pages/md/payroll-dashboard/types.ts).

THE SCENARIO (September 2026 with August before it; "today" is pinned to Monday 12 October 2026)

  A1 Asha  staff, Stitching / Unit 1   salary 26,000, 26 company days (daily rate 1,000)
           Sep: 24 days paid (22 present + 2 holidays) -> earned 24,000, loss of pay 2,000; overtime 1,000; late 300 +
                permission 200 = late 500; PF 1,560 on PF wages 13,000 (employer PF 12% = 1,560); net 22,940;
                Casual Leave: a full day on 10 Sep (present, 1 shift) + a half day on 11 Sep (present, half shift) = 1.5
                days (= 1,500); a CL on 12 Sep (an absent day) and a pending one on 15 Sep do not count. Cleared (verified,
                not paid). HR added a bonus of 500 and raised the deductions by 200 afterwards: adjustment +300
           Aug: 26 of 26 days, earned 26,000, net 26,000; August was finalized and marked paid
  B2 Bala  staff, Accounts / Unit 2    salary 20,000, 25 company days: all paid -> earned 20,000; ESI 150 on 10,000
                (employer ESI 3.25% = 325); advance 1,000; net 18,850; ON HOLD. Aug 20,000
  C3 Chitra staff, Accounts / Unit 2   joined 15 Sep: a September slip of 8,000, but HR has not added her to the payroll
                (parked): left out of every figure
  D4 Dev   staff, Stitching / Unit 1   has LEFT (inactive): Sep 10,000 of 10,000 over 26 days, still September's cost
  P1 Gita  production, Stitching / Unit 1, 500 a shift: Sep 1-14 (12 shifts, 12 worked, 2 absent: 6,000, cleared) and
                15-30 (13 shifts, 13 worked, 3 absent, late 100: 6,500, net 6,400) -> one person-month of 12,500;
                Aug 1-31: 16 shifts = 8,000, cleared

  September: 4 employees; earned 66,500; actual (staff) 56,000; loss of pay 2,000; late 600; attendance deduction 2,600;
             overtime 1,000; deductions 3,310 (PF 1,560, ESI 150, advance 1,000, late 600); net 64,190; employer PF/ESI
             1,885; company cost 69,385; CL 1.5 days / 1,500; working days 107, paid days 100, LOP days 7
  August:    3 employees; earned 54,000; company cost 54,000
"""

import json
import re
import time as clock
from datetime import date, datetime
from decimal import Decimal
from pathlib import Path
from unittest import mock

from django.db import connection
from django.test.utils import CaptureQueriesContext

from .clock import FACTORY_TZ
from .md_portal.analytics import payroll as P
from .md_portal.analytics import payroll_people as PP
from .md_portal.common import MdParamError, Scope, read_only_db
from .models import (
    Branch,
    CasualLeaveRequest,
    Department,
    Designation,
    Employee,
    HRUser,
    Payroll,
    PayrollMonthClose,
    SalarySlip,
)
from .payroll_insights import casual_leave_days
from .tests_md_support import MdApiTestCase, md_headers

TODAY = date(2026, 10, 12)
AUG, SEP = (2026, 8), (2026, 9)
BASE = "/api/md/payroll/"
CENT = Decimal("0.01")
_SERIAL = iter(range(1, 10_000_000))


def D(value) -> Decimal:
    return Decimal(str(value))


def at(year, month, day, hour=9, minute=0) -> datetime:
    return datetime(year, month, day, hour, minute, tzinfo=FACTORY_TZ)


def staff_slip(
    emp,
    ym,
    *,
    monthly,
    company,
    paid,
    present=None,
    holidays=0,
    late_days=0,
    late=0,
    permission=0,
    ot=0,
    pf=0,
    esi=0,
    adv=0,
    pf_wages=None,
    days=(),
    cleared=False,
    payment_paid=None,
    on_hold=False,
    parked=False,
    hr_bonus=0,
    hr_deduction_change=0,
):
    """A staff slip shaped like the engine's (payroll_views._generate_staff_payroll) and its Payroll row."""
    daily = D(monthly) / D(company)
    gross = (daily * D(paid)).quantize(CENT)
    ded = D(late) + D(permission) + D(pf) + D(esi) + D(adv)
    net = gross + D(ot) - ded
    deductions = {
        "pf": float(pf),
        "esi": float(esi),
        "tds": 0.0,
        "advances": float(adv),
        "lateShiftPenalty": float(late),
        "permissionPenalty": float(permission),
        "total": float(ded),
    }
    if pf_wages is not None:
        deductions["statutory"] = {"category": "co_emp", "pfWages": float(pf_wages)}
    breakdown = {
        "type": "staff",
        "days": list(days),
        "summary": {
            "totalWorkingDays": company,
            "companyDays": company,
            "presentDays": present if present is not None else paid,
            "holidayDays": holidays,
            "lateDays": late_days,
            "effectivePaidDays": float(paid),
        },
        "earnings": {"monthlySalary": float(monthly), "dailyRate": float(daily), "grossSalary": float(gross)},
        "deductions": deductions,
    }
    SalarySlip.objects.create(
        employee=emp,
        month=ym[1],
        year=ym[0],
        slip_number=f"T/{emp.employee_code}/{next(_SERIAL)}",
        basic=gross / 2,
        hra=D(0),
        allowances=gross / 2,
        gross_salary=gross,
        ot_amount=D(ot),
        pf_deduction=D(pf),
        esi_deduction=D(esi),
        advance_deduction=D(adv),
        other_deductions=D(late) + D(permission),
        total_deductions=ded,
        net_salary=net,
        working_days=company,
        present_days=D(present if present is not None else paid),
        breakdown_details=breakdown,
    )
    return Payroll.objects.create(
        employee=emp,
        salary_mode="monthly",
        month=ym[1],
        year=ym[0],
        base_salary=D(monthly),
        gross_salary=gross,
        ot_amount=D(ot),
        deductions=ded + D(hr_deduction_change),
        bonus=D(hr_bonus),
        final_salary=net + D(hr_bonus) - D(hr_deduction_change),
        status="paid" if cleared else "pending",
        on_hold=on_hold,
        new_joiner_parked=parked,
        payment_status="paid" if payment_paid else "not_paid",
        payment_paid_at=payment_paid,
    )


def production_slip(emp, ym, start, end, *, shifts, rate, worked, absent, late=None, cycle="biweekly", cleared=False):
    """A production period slip (payroll_views._generate_production_payroll's shape) and its Payroll row."""
    gross = D(shifts) * D(rate)
    ded = D(late or 0)
    span = (end - start).days + 1
    SalarySlip.objects.create(
        employee=emp,
        month=ym[1],
        year=ym[0],
        slip_number=f"T/{emp.employee_code}/{next(_SERIAL)}",
        basic=gross,
        gross_salary=gross,
        total_deductions=ded,
        other_deductions=ded,
        net_salary=gross - ded,
        working_days=span,
        present_days=D(shifts),
        absent_days=D(absent),
        period_start=start,
        period_end=end,
        pay_cycle=cycle,
        breakdown_details={
            "type": "production",
            "salaryPerShift": float(rate),
            "summary": {
                "totalDays": span,
                "periodDays": span,
                "daysWorked": worked,
                "daysAbsent": absent,
                "totalShifts": float(shifts),
            },
            "earnings": {"totalShifts": float(shifts), "salaryPerShift": float(rate), "grossSalary": float(gross)},
            "deductions": {"lateShiftPenalty": float(late) if late is not None else None, "total": float(ded)},
        },
    )
    return Payroll.objects.create(
        employee=emp,
        salary_mode="shift",
        month=ym[1],
        year=ym[0],
        base_salary=gross,
        gross_salary=gross,
        deductions=ded,
        final_salary=gross - ded,
        status="paid" if cleared else "pending",
        period_start=start,
        period_end=end,
        pay_cycle=cycle,
    )


def day(iso, status="present", shifts=1.0):
    return {"date": iso, "status": status, "shiftsCompleted": shifts}


def near(test, actual, expected, places=2, msg=None):
    test.assertAlmostEqual(actual, expected, places=places, msg=msg)


class Base(MdApiTestCase):
    @classmethod
    def setUpTestData(cls):
        cls.u1 = Branch.objects.create(name="Unit 1", code="U1")
        cls.u2 = Branch.objects.create(name="Unit 2", code="U2")
        cls.stitching = Department.objects.create(name="Stitching", branch=cls.u1)
        cls.accounts = Department.objects.create(name="Accounts", branch=cls.u2)
        cls.operator = Designation.objects.create(title="Operator")
        cls.supervisor = Designation.objects.create(title="Supervisor")

        def emp(code, first, kind, dept, branch, desig, status="active", join="2020-01-01", **extra):
            return Employee.objects.create(
                employee_code=code,
                first_name=first,
                last_name="Test" if kind == "staff" else "Prod",
                employment_type=kind,
                department=dept,
                branch=branch,
                designation=desig,
                status=status,
                join_date=join,
                **extra,
            )

        cls.a1 = emp("A1", "Asha", "staff", cls.stitching, cls.u1, cls.supervisor, salary_amount=D(26000))
        cls.b2 = emp("B2", "Bala", "staff", cls.accounts, cls.u2, cls.operator, salary_amount=D(20000))
        cls.c3 = emp("C3", "Chitra", "staff", cls.accounts, cls.u2, cls.operator, join="2026-09-15")
        cls.d4 = emp("D4", "Dev", "staff", cls.stitching, cls.u1, cls.operator, status="inactive")
        cls.p1 = emp("P1", "Gita", "production", cls.stitching, cls.u1, cls.operator, salary_per_shift=D(500))

        # ── August: finalized and marked paid (staff); production cleared ──
        paid_aug = at(2026, 9, 6)
        staff_slip(cls.a1, AUG, monthly=26000, company=26, paid=26, cleared=True, payment_paid=paid_aug)
        staff_slip(cls.b2, AUG, monthly=20000, company=25, paid=25, cleared=True, payment_paid=paid_aug)
        production_slip(
            cls.p1, AUG, date(2026, 8, 1), date(2026, 8, 31), shifts=16, rate=500, worked=16, absent=15, cleared=True
        )
        PayrollMonthClose.objects.create(
            month=8, year=2026, finalized_at=at(2026, 9, 5, 18), finalized_by="HR", paid_at=paid_aug, paid_by="HR"
        )

        # ── September: open ──
        cls.a1_sep = staff_slip(
            cls.a1,
            SEP,
            monthly=26000,
            company=26,
            paid=24,
            present=22,
            holidays=2,
            late_days=3,
            late=300,
            permission=200,
            ot=1000,
            pf=1560,
            pf_wages=13000,
            days=[
                day("2026-09-10"),
                day("2026-09-11", shifts=0.5),
                day("2026-09-12", status="absent", shifts=0.0),
                day("2026-09-15"),
            ],
            cleared=True,
            hr_bonus=500,
            hr_deduction_change=200,
        )
        staff_slip(cls.b2, SEP, monthly=20000, company=25, paid=25, esi=150, adv=1000, pf_wages=10000, on_hold=True)
        staff_slip(cls.c3, SEP, monthly=16000, company=26, paid=13, parked=True)
        staff_slip(cls.d4, SEP, monthly=10000, company=26, paid=26)
        production_slip(
            cls.p1, SEP, date(2026, 9, 1), date(2026, 9, 14), shifts=12, rate=500, worked=12, absent=2, cleared=True
        )
        production_slip(
            cls.p1, SEP, date(2026, 9, 15), date(2026, 9, 30), shifts=13, rate=500, worked=13, absent=3, late=100
        )
        for d, portion, status in (
            (date(2026, 9, 10), "full", "approved"),
            (date(2026, 9, 11), "first_half", "approved"),
            (date(2026, 9, 12), "full", "approved"),  # an absent day: no CL is paid on it
            (date(2026, 9, 15), "full", "pending"),  # not approved
        ):
            CasualLeaveRequest.objects.create(employee=cls.a1, date=d, portion=portion, status=status)

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


# ─────────────────────────────────────────────────────────────────────────────
#  1. monthly
# ─────────────────────────────────────────────────────────────────────────────


class MonthlyTests(Base):
    def test_september_figure_by_figure(self):
        cur = self.api("monthly", month="2026-09")["current"]
        self.assertEqual((cur["month"], cur["label"], cur["employees"]), ("2026-09", "Sep 2026", 4))
        near(self, cur["earnedSalary"], 66500)
        near(self, cur["actualSalary"], 56000)  # the three staff salaries; production has none
        near(self, cur["lossOfPay"], 2000)  # Asha's 2 unpaid days
        near(self, cur["lateDeduction"], 600)  # Asha's late 300 + permission 200, Gita's late 100
        near(self, cur["attendanceDeduction"], 2600)
        near(self, cur["overtime"], 1000)
        near(self, cur["bonus"], 0)
        self.assertEqual(
            cur["deductions"],
            {"pf": 1560.0, "esi": 150.0, "tds": 0.0, "advance": 1000.0, "late": 600.0, "other": 0.0, "total": 3310.0},
        )
        near(self, cur["netPaid"], 64190)
        near(self, cur["employerPfEsi"], 1885)  # 12% of 13,000 + 3.25% of 10,000
        near(self, cur["companyCost"], 69385)
        self.assertEqual((cur["clDays"], cur["clAmount"]), (1.5, 1500.0))
        self.assertEqual((cur["workingDays"], cur["paidDays"], cur["lopDays"]), (107.0, 100.0, 7.0))

    def test_the_months_the_previous_month_and_the_change(self):
        body = self.api("monthly", month="2026-09", months=3)
        self.assertEqual([m["month"] for m in body["months"]], ["2026-08", "2026-09"])  # July: before payroll began
        prev = body["previous"]
        self.assertEqual((prev["month"], prev["employees"]), ("2026-08", 3))
        near(self, prev["companyCost"], 54000)
        self.assertEqual(body["change"]["companyCost"], {"abs": 15385.0, "pct": 28.5})
        self.assertEqual(body["change"]["employees"], {"abs": 1.0, "pct": 33.3})
        self.assertEqual(set(body["change"]), set(PP.CHANGE_KEYS))
        self.assertEqual(body["available"], ["2026-09", "2026-08"])

    def test_the_default_month_is_the_latest_with_slips(self):
        body = self.api("monthly")
        self.assertEqual((body["month"], body["current"]["month"]), ("2026-09", "2026-09"))

    def test_the_default_month_is_the_last_complete_one_not_a_month_still_running(self):
        # on 15 Sep, September's slips are provisional (the days to come count as absent): the page opens on August,
        # as the rest of the payroll analytics does; September can still be picked
        with mock.patch.object(P, "_today", return_value=date(2026, 9, 15)):
            for endpoint in ("monthly", "department-breakdown", "people"):
                self.assertEqual(self.api(endpoint)["month"], "2026-08", endpoint)
            self.assertEqual(self.api("monthly", month="2026-09")["month"], "2026-09")

    def test_the_status_in_words(self):
        status = self.api("monthly", month="2026-09")["current"]["status"]
        # staff still open, one production period cleared: part of the month is paid
        self.assertEqual((status["state"], status["label"]), ("part_paid", "Part paid"))
        self.assertIn("4 of 5 slips are not paid yet (₹58,190)", status["detail"])
        self.assertIn("1 salary on hold.", status["detail"])
        self.assertIn("1 new joiner waiting to be added to the payroll.", status["detail"])
        aug = self.api("monthly", month="2026-08")["current"]["status"]
        self.assertEqual(
            (aug["state"], aug["detail"]), ("paid", "Marked as paid on 6 Sep 2026, 1 day after Payroll Done.")
        )

    def test_a_month_with_no_payroll_has_no_row_and_says_so(self):
        body = self.api("monthly", month="2026-07")
        self.assertIsNone(body["current"])
        self.assertIsNone(body["change"])
        self.assertTrue(any("No salary slips exist for Jul 2026" in n for n in body["notes"]))

    def test_months_is_clamped_and_a_bad_value_is_a_400(self):
        self.assertEqual(len(self.api("monthly", month="2026-09", months=500)["months"]), 2)
        self.assertEqual(self.get(BASE + "monthly", months="many").status_code, 400)
        self.assertEqual(self.get(BASE + "monthly", month="September").status_code, 400)


# ─────────────────────────────────────────────────────────────────────────────
#  2. department breakdown
# ─────────────────────────────────────────────────────────────────────────────


class DepartmentTests(Base):
    def test_every_department_with_its_figures_and_the_month_before(self):
        body = self.api("department-breakdown", month="2026-09")
        rows = {r["department"]: r for r in body["rows"]}
        self.assertEqual([r["department"] for r in body["rows"]], ["Stitching", "Accounts"])  # costliest first
        st = rows["Stitching"]
        self.assertEqual((st["unit"], st["employees"]), ("Unit 1", 3))  # Asha, Gita and Dev (who has left)
        near(self, st["earnedSalary"], 46500)
        near(self, st["companyCost"], 49060)
        near(self, st["averageEarned"], 15500)
        near(self, st["averageNetPaid"], 15113.33)
        near(self, st["attendancePct"], 91.5, places=1)  # 75 paid of 82 working days
        near(self, st["sharePct"], 70.7, places=1)
        near(self, st["previousCompanyCost"], 34000)
        self.assertEqual(st["change"], {"abs": 15060.0, "pct": 44.3})
        acc = rows["Accounts"]
        near(self, acc["companyCost"], 20325)  # Bala (held) 20,000 + employer ESI 325; Chitra is not payroll yet
        self.assertEqual((acc["employees"], acc["attendancePct"]), (1, 100.0))
        near(self, sum(r["companyCost"] for r in body["rows"]), body["totals"]["companyCost"])
        near(self, body["totals"]["companyCost"], 69385)
        near(self, body["totals"]["averageEarned"], 16625)  # 66,500 / 4

    def test_a_department_filter_and_a_type(self):
        body = self.api("department-breakdown", month="2026-09", type="production")
        self.assertEqual([(r["department"], r["employees"]) for r in body["rows"]], [("Stitching", 1)])
        self.assertIsNone(body["rows"][0]["actualSalary"])
        body = self.api("department-breakdown", month="2026-09", department="Accounts")
        self.assertEqual([r["department"] for r in body["rows"]], ["Accounts"])
        self.assertEqual(body["scope"], {"branch": None, "department": "Accounts", "type": None})


# ─────────────────────────────────────────────────────────────────────────────
#  3. people
# ─────────────────────────────────────────────────────────────────────────────


class PeopleTests(Base):
    def rows(self, **params):
        return self.api("people", month="2026-09", **params)["rows"]

    def test_one_row_per_employee_with_the_production_periods_added_up(self):
        body = self.api("people", month="2026-09")
        self.assertEqual(body["total"], 4)  # Chitra is a new joiner HR has not added: not here
        self.assertEqual([r["code"] for r in body["rows"]], ["A1", "B2", "D4", "P1"])  # by name: Asha, Bala, Dev, Gita
        gita = body["rows"][3]
        self.assertEqual((gita["type"], gita["periods"], gita["employees"]), ("production", 2, 1))
        near(self, gita["earnedSalary"], 12500)
        near(self, gita["netPaid"], 12400)
        self.assertIsNone(gita["actualSalary"])
        self.assertIsNone(gita["lossOfPay"])
        near(self, gita["attendanceDeduction"], 100)  # production: the late deduction only
        self.assertEqual((gita["workingDays"], gita["paidDays"], gita["lopDays"]), (30.0, 25.0, 5.0))
        self.assertEqual(gita["paymentStatus"], "not_paid")  # one of its two periods is not cleared
        self.assertEqual(gita["clDays"], 0.0)

    def test_the_figures_of_a_staff_member(self):
        asha = self.rows(q="asha")[0]
        self.assertEqual(
            (asha["department"], asha["unit"], asha["designation"], asha["type"], asha["status"]),
            ("Stitching", "Unit 1", "Supervisor", "staff", "active"),
        )
        near(self, asha["actualSalary"], 26000)
        near(self, asha["earnedSalary"], 24000)
        near(self, asha["lossOfPay"], 2000)
        near(self, asha["attendanceDeduction"], 2500)
        near(self, asha["companyCost"], 26560)  # 24,000 + 1,000 overtime + 1,560 employer PF
        self.assertEqual((asha["clDays"], asha["clAmount"]), (1.5, 1500.0))
        self.assertEqual((asha["onHold"], asha["paymentStatus"], asha["periods"]), (False, "not_paid", 0))
        bala = self.rows(q="Bala")[0]
        self.assertTrue(bala["onHold"])
        dev = self.rows(q="dev")[0]
        self.assertEqual(dev["status"], "inactive")  # has left, still September's cost

    def test_search_by_name_or_code(self):
        self.assertEqual([r["code"] for r in self.rows(q="GITA")], ["P1"])
        self.assertEqual([r["code"] for r in self.rows(q="b2")], ["B2"])
        self.assertEqual([r["code"] for r in self.rows(q="test")], ["A1", "B2", "D4"])  # last names
        body = self.api("people", month="2026-09", q="nobody")
        self.assertEqual((body["total"], body["rows"]), (0, []))
        self.assertTrue(any("Nobody matches 'nobody'" in n for n in body["notes"]))

    def test_sorting(self):
        self.assertEqual([r["code"] for r in self.rows(sort="companyCost", dir="desc")], ["A1", "B2", "P1", "D4"])
        self.assertEqual([r["code"] for r in self.rows(sort="actualSalary")], ["D4", "B2", "A1", "P1"])
        self.assertEqual([r["code"] for r in self.rows(sort="actualSalary", dir="desc")], ["A1", "B2", "D4", "P1"])
        self.assertEqual([r["code"] for r in self.rows(sort="code", dir="desc")], ["P1", "D4", "B2", "A1"])
        self.assertEqual([r["code"] for r in self.rows(sort="clDays", dir="desc")][0], "A1")
        self.assertEqual([r["code"] for r in self.rows(sort="deductions", dir="desc")][:2], ["A1", "B2"])
        self.assertEqual([r["department"] for r in self.rows(sort="department")], ["Accounts"] + ["Stitching"] * 3)
        for sort in PP.SORTS:
            self.assertEqual(len(self.rows(sort=sort)), 4, sort)

    def test_paging_and_totals_of_every_match(self):
        body = self.api("people", month="2026-09", page=2, pageSize=2)
        self.assertEqual((body["page"], body["pageSize"], body["total"]), (2, 2, 4))
        self.assertEqual([r["code"] for r in body["rows"]], ["D4", "P1"])
        near(self, body["totals"]["companyCost"], 69385)  # every match, not just this page
        self.assertEqual(body["totals"]["employees"], 4)
        self.assertEqual(self.api("people", month="2026-09", page=9)["rows"], [])
        self.assertEqual(self.api("people", month="2026-09", pageSize=5000)["pageSize"], PP.PAGE_SIZE_MAX)

    def test_bad_sort_or_direction_is_a_400_that_says_what_is_allowed(self):
        r = self.get(BASE + "people", sort="salary")
        self.assertEqual(r.status_code, 400)
        self.assertIn("companyCost", r.json()["error"])
        self.assertEqual(self.get(BASE + "people", dir="up").status_code, 400)
        self.assertEqual(self.get(BASE + "people", page="first").status_code, 400)

    def test_the_scope_filters(self):
        self.assertEqual([r["code"] for r in self.rows(branch="Unit 2")], ["B2"])
        self.assertEqual([r["code"] for r in self.rows(type="production")], ["P1"])
        self.assertEqual([r["code"] for r in self.rows(department="Stitching", type="staff")], ["A1", "D4"])
        body = self.api("people", month="2026-09", branch=str(self.u1.id))
        self.assertEqual(body["scope"], {"branch": "Unit 1", "department": None, "type": None})
        self.assertEqual(body["total"], 3)

    def test_monthly_totals_are_the_people_added_up(self):
        people = self.api("people", month="2026-09", pageSize=100)
        monthly = self.api("monthly", month="2026-09")["current"]
        for key in ("earnedSalary", "netPaid", "companyCost", "attendanceDeduction", "clAmount", "lossOfPay"):
            near(self, sum(r[key] or 0 for r in people["rows"]), monthly[key], msg=key)
        self.assertEqual(people["totals"], {k: v for k, v in monthly.items() if k not in ("month", "label", "status")})


# ─────────────────────────────────────────────────────────────────────────────
#  4. one employee
# ─────────────────────────────────────────────────────────────────────────────


class PersonTests(Base):
    def person(self, emp, **params):
        return self.api(f"people/{emp.id}", **params)

    def test_a_staff_members_history_newest_first(self):
        body = self.person(self.a1)
        self.assertEqual(
            body["employee"],
            {
                "id": self.a1.id,
                "code": "A1",
                "name": "Asha Test",
                "department": "Stitching",
                "unit": "Unit 1",
                "designation": "Supervisor",
                "type": "staff",
                "status": "active",
                "joinDate": "2020-01-01",
                "monthlySalary": 26000.0,
            },
        )
        sep, aug = body["months"]
        self.assertEqual((sep["month"], aug["month"]), ("2026-09", "2026-08"))
        self.assertEqual(
            (sep["dailyRate"], sep["presentDays"], sep["holidayDays"], sep["lateDays"]), (1000.0, 22.0, 2.0, 3.0)
        )
        self.assertEqual(sep["adjustment"], 300.0)  # HR's bonus 500 less the 200 HR added to the deductions
        self.assertIsNone(aug["adjustment"])
        self.assertEqual((sep["clDays"], sep["clAmount"], sep["lopDays"]), (1.5, 1500.0, 2.0))
        self.assertEqual(
            sep["status"],
            {
                "state": "generated",
                "label": "Generated, still open",
                "detail": "Verified by HR (Cleared), not paid yet.",
            },
        )
        self.assertEqual((sep["paymentStatus"], sep["paymentPaidAt"], sep["onHold"]), ("not_paid", None, False))
        self.assertEqual(aug["status"], {"state": "paid", "label": "Paid", "detail": "Paid on 6 Sep 2026."})
        self.assertEqual((aug["paymentStatus"], aug["paymentPaidAt"]), ("paid", "2026-09-06T09:00:00"))
        self.assertEqual(sep["periods"], [])
        near(self, body["totals"]["earnedSalary"], 24000 + 26000)
        self.assertEqual(body["totals"]["employees"], 1)

    def test_a_production_workers_months_list_their_periods(self):
        sep = self.person(self.p1)["months"][0]
        self.assertEqual(
            sep["periods"],
            [
                {
                    "start": "2026-09-01",
                    "end": "2026-09-14",
                    "cycle": "biweekly",
                    "netPaid": 6000.0,
                    "shifts": 12.0,
                    "ratePerShift": 500.0,
                },
                {
                    "start": "2026-09-15",
                    "end": "2026-09-30",
                    "cycle": "biweekly",
                    "netPaid": 6400.0,
                    "shifts": 13.0,
                    "ratePerShift": 500.0,
                },
            ],
        )
        self.assertEqual(sep["status"]["state"], "part_paid")  # one of the two periods cleared
        self.assertIsNone(sep["dailyRate"])
        self.assertIsNone(self.person(self.p1)["employee"]["monthlySalary"])

    def test_held_and_left(self):
        bala = self.person(self.b2)["months"][0]
        self.assertEqual((bala["onHold"], bala["status"]["state"]), (True, "on_hold"))
        self.assertEqual(self.person(self.d4)["employee"]["status"], "inactive")
        self.assertEqual(len(self.person(self.d4)["months"]), 1)

    def test_a_parked_new_joiner_has_no_months_and_a_note(self):
        body = self.person(self.c3)
        self.assertEqual(body["months"], [])
        self.assertTrue(any("Not in the payroll yet" in n and "Sep 2026" in n for n in body["notes"]), body["notes"])

    def test_months_limits_the_history(self):
        self.assertEqual([m["month"] for m in self.person(self.a1, months=1)["months"]], ["2026-09"])

    def test_an_unknown_employee_is_a_404(self):
        r = self.get(BASE + "people/999999")
        self.assertEqual(r.status_code, 404)
        self.assertIn("no employee", r.json()["error"])
        self.assertEqual(self.get(BASE + f"people/{self.a1.id}", months="x").status_code, 400)


# ─────────────────────────────────────────────────────────────────────────────
#  the rules each figure follows
# ─────────────────────────────────────────────────────────────────────────────


class RuleTests(Base):
    def test_casual_leave_is_the_salary_statements_own_rule(self):
        mine = PP._casual_leave([self.a1.id, self.b2.id], [SEP, AUG])
        self.assertEqual(mine[(self.a1.id, 2026, 9)], casual_leave_days([self.a1.id], 2026, 9)[self.a1.id])
        admin = HRUser.objects.create(username="cl_admin", password_hash="x", is_super_admin=True)
        r = self.client.get("/api/payroll/salary-statement", {"month": 9, "year": 2026}, **md_headers(admin))
        self.assertEqual(r.status_code, 200, r.content[:300])
        statement = {row["values"]["code"]: row["values"] for g in r.json()["groups"] for row in g["rows"]}
        self.assertEqual(statement["A1"]["cl"], 1.5)  # the CL column
        asha = self.api("people", month="2026-09", q="asha")["rows"][0]
        self.assertEqual(asha["clDays"], statement["A1"]["cl"])

    def test_cl_is_never_more_than_the_paid_days(self):
        SalarySlip.objects.filter(employee=self.a1, month=9).update(
            breakdown_details={
                **SalarySlip.objects.get(employee=self.a1, month=9).breakdown_details,
                "summary": {"companyDays": 26, "effectivePaidDays": 1.0, "presentDays": 1},
            }
        )
        self.assertEqual(self.api("people", month="2026-09", q="asha")["rows"][0]["clDays"], 1.0)

    def test_a_new_joiner_counts_once_added_to_the_payroll(self):
        Payroll.objects.filter(employee=self.c3, month=9).update(
            new_joiner_parked=False, added_to_payroll_at=at(2026, 10, 3)
        )
        body = self.api("people", month="2026-09")
        self.assertEqual(body["total"], 5)
        near(self, body["totals"]["earnedSalary"], 66500 + 8000)

    def test_a_slip_without_a_calculation_loses_nothing(self):
        SalarySlip.objects.filter(employee=self.d4, month=9).update(breakdown_details=None)
        dev = self.api("people", month="2026-09", q="dev")["rows"][0]
        self.assertEqual((dev["actualSalary"], dev["lossOfPay"]), (10000.0, 0.0))
        self.assertEqual((dev["workingDays"], dev["paidDays"]), (26.0, 26.0))  # from the slip's own columns

    def test_staff_figures_agree_with_the_payroll_analysis(self):
        for scope in (Scope(), Scope(employment_type="staff"), Scope(employment_type="production")):
            with self.subTest(scope=scope.employment_type):
                mine = PP.payroll_monthly(scope, "2026-09")["current"]
                theirs = P._summary(P._context(scope, "2026-09"))["totals"]
                self.assertEqual(mine["earnedSalary"], theirs["salaryEarned"])
                self.assertEqual(mine["netPaid"], theirs["netPay"])
                self.assertEqual(mine["deductions"]["total"], theirs["totalDeductions"])
                self.assertEqual(mine["employees"], theirs["headcount"])
                near(self, mine["companyCost"], theirs["employerCost"])

    def test_every_endpoint_is_read_only_and_bounded(self):
        with read_only_db():  # the database itself refuses a write here
            PP.payroll_monthly(Scope(), "2026-09")
            PP.payroll_department_breakdown(Scope(), "2026-09")
            PP.payroll_people(Scope(), "2026-09")
            PP.payroll_person(self.a1.id)
        endpoints = ("monthly", "department-breakdown", "people", f"people/{self.a1.id}")

        def counts():
            out = {}
            for endpoint in endpoints:
                with CaptureQueriesContext(connection) as queries:
                    self.api(endpoint, month="2026-09")
                out[endpoint] = len(queries)
            return out

        small = counts()
        for i in range(30):  # thirty more people, each with a slip and an approved Casual Leave day
            emp = Employee.objects.create(
                employee_code=f"X{i}",
                first_name=f"x{i}",
                last_name="Test",
                employment_type="staff",
                department=self.stitching,
                branch=self.u1,
                status="active",
            )
            staff_slip(emp, SEP, monthly=26000, company=26, paid=26, days=[day("2026-09-10")])
            CasualLeaveRequest.objects.create(employee=emp, date=date(2026, 9, 10), portion="full", status="approved")
        self.assertEqual(counts(), small)  # a fixed number of queries, however many people
        self.assertLessEqual(max(small.values()), 15)

    def test_the_routes_are_locked_to_the_md_and_get_only(self):
        clerk = HRUser.objects.create(username="clerk", password_hash="x")
        for url in ("monthly", "department-breakdown", "people", f"people/{self.a1.id}"):
            with self.subTest(url=url):
                self.assertEqual(self.client.get(BASE + url).status_code, 401)
                self.assertEqual(self.client.get(BASE + url, **md_headers(clerk)).status_code, 403)
                self.assertEqual(self.client.post(BASE + url, **md_headers(self.md)).status_code, 405)

    def test_a_bad_parameter_is_an_error_the_caller_can_read(self):
        with self.assertRaises(MdParamError):
            PP.payroll_people(Scope(), "2026-09", None, "salary")


class EmptyTests(MdApiTestCase):
    def test_nothing_processed_is_a_clean_answer(self):
        for endpoint in ("monthly", "department-breakdown", "people"):
            with self.subTest(endpoint=endpoint):
                r = self.get(BASE + endpoint)
                self.assertEqual(r.status_code, 200)
                body = r.json()
                self.assertIsNone(body["month"])
                self.assertTrue(body["notes"])


# ─────────────────────────────────────────────────────────────────────────────
#  the TypeScript contract, read as text
# ─────────────────────────────────────────────────────────────────────────────

_CONTRACT = Path(__file__).resolve().parents[2] / "frontend" / "src" / "pages" / "md" / "payroll-dashboard" / "types.ts"
_TOKEN = re.compile(r'\s*("(?:[^"\\]|\\.)*"|[A-Za-z_]\w*|\d+|[{}\[\]()<>|&:;,?=])')


def _read_contract() -> str:
    """The contract as text (another agent may be rewriting it: a failed read is retried a few times)."""
    for attempt in range(6):
        try:
            return _CONTRACT.read_text(encoding="utf-8")
        except OSError:
            if attempt == 5:
                raise
            clock.sleep(0.25)
    raise AssertionError("unreachable")


class _TsParser:
    """One TypeScript type expression: object literals, unions, intersections, arrays, string literals, primitives,
    Record<K, V>, Partial<...> and references to declared types (the subset the contract uses)."""

    def __init__(self, text: str):
        self.tokens, position = [], 0
        text = text.rstrip()
        while position < len(text):
            match = _TOKEN.match(text, position)
            if match is None:
                raise AssertionError(f"Cannot read the contract near {text[position : position + 40]!r}")
            self.tokens.append(match.group(1))
            position = match.end()
        self.i = 0

    def peek(self, offset=0):
        return self.tokens[self.i + offset] if self.i + offset < len(self.tokens) else None

    def take(self, expected=None):
        token = self.tokens[self.i]
        if expected is not None and token != expected:
            raise AssertionError(f"Contract: expected {expected!r} but found {token!r}")
        self.i += 1
        return token

    def parse_type(self):
        if self.peek() == "|":
            self.take()
        alternatives = [self.parse_intersection()]
        while self.peek() == "|":
            self.take()
            alternatives.append(self.parse_intersection())
        return alternatives[0] if len(alternatives) == 1 else ("union", alternatives)

    def parse_intersection(self):
        parts = [self.parse_postfix()]
        while self.peek() == "&":
            self.take()
            parts.append(self.parse_postfix())
        return parts[0] if len(parts) == 1 else ("inter", parts)

    def parse_postfix(self):
        node = self.parse_primary()
        while self.peek() == "[" and self.peek(1) == "]":
            self.take()
            self.take()
            node = ("array", node)
        return node

    def parse_primary(self):
        token = self.take()
        if token == "{":
            members = {}
            while self.peek() != "}":
                key = self.take().strip('"')
                optional = self.peek() == "?"
                if optional:
                    self.take()
                self.take(":")
                members[key] = (optional, self.parse_type())
                if self.peek() in (";", ","):
                    self.take()
            self.take("}")
            return ("obj", members)
        if token == "(":
            node = self.parse_type()
            self.take(")")
            return node
        if token.startswith('"'):
            return ("lit", json.loads(token))
        if token in ("string", "number", "boolean", "null"):
            return ("prim", token)
        if self.peek() == "<":
            self.take()
            args = [self.parse_type()]
            while self.peek() == ",":
                self.take()
                args.append(self.parse_type())
            self.take(">")
            if token == "Record":
                return ("record", args[0], args[1], False)
            if token == "Partial" and args[0][0] == "record":
                return ("record", args[0][1], args[0][2], True)
            raise AssertionError(f"Contract: generic {token} is not supported by the test reader")
        return ("ref", token)


class _TsContract:
    def __init__(self):
        text = re.sub(r"/\*.*?\*/", "", _read_contract(), flags=re.S)
        text = re.sub(r"//[^\n]*", "", text)
        self.types = {}
        for match in re.finditer(r"(?m)^export type (\w+) =", text):
            end = text.find("\nexport ", match.end())
            body = text[match.end() : end if end != -1 else len(text)].strip().rstrip(";")
            self.types[match.group(1)] = _TsParser(body).parse_type()

    def _members(self, node):
        if node[0] == "ref":
            return self._members(self.types[node[1]])
        if node[0] == "obj":
            return dict(node[1])
        if node[0] == "inter":
            merged = {}
            for part in node[1]:
                got = self._members(part)
                if got is None:
                    return None
                merged.update(got)
            return merged
        return None

    def _literals(self, node):
        if node[0] == "lit":
            return [node[1]]
        if node[0] == "ref":
            return self._literals(self.types[node[1]])
        if node[0] == "union":
            out = []
            for alt in node[1]:
                got = self._literals(alt)
                if got is None:
                    return None
                out += got
            return out
        return None

    def errors(self, value, node, path="$"):
        kind = node[0]
        if kind == "prim":
            ok = {
                "string": isinstance(value, str),
                "number": isinstance(value, (int, float)) and not isinstance(value, bool),
                "boolean": isinstance(value, bool),
                "null": value is None,
            }[node[1]]
            return [] if ok else [f"{path}: {value!r} is not a {node[1]}"]
        if kind == "lit":
            return [] if value == node[1] else [f"{path}: {value!r} is not {node[1]!r}"]
        if kind == "ref":
            if node[1] not in self.types:
                return [f"{path}: the contract has no type {node[1]}"]
            return self.errors(value, self.types[node[1]], path)
        if kind == "array":
            if not isinstance(value, list):
                return [f"{path}: {type(value).__name__} is not a list"]
            return [e for n, item in enumerate(value[:40]) for e in self.errors(item, node[1], f"{path}[{n}]")]
        if kind == "union":
            attempts = [self.errors(value, alt, path) for alt in node[1]]
            if any(not attempt for attempt in attempts):
                return []
            return [f"{path}: {value!r} fits none of the alternatives ({attempts[0][0] if attempts[0] else ''})"]
        if kind == "record":
            if not isinstance(value, dict):
                return [f"{path}: not an object"]
            allowed = self._literals(node[1])
            problems = []
            if allowed is not None:
                if not node[3]:
                    problems += [f"{path}: missing key {k!r}" for k in allowed if k not in value]
                problems += [f"{path}: unexpected key {k!r}" for k in value if k not in allowed]
            for key, item in value.items():
                problems += self.errors(item, node[2], f"{path}.{key}")
            return problems
        members = self._members(node)
        if members is None:
            return [f"{path}: cannot check {kind}"]
        if not isinstance(value, dict):
            return [f"{path}: {type(value).__name__} is not an object"]
        problems = []
        for key, (optional, member) in members.items():
            if key not in value:
                if not optional:
                    problems.append(f"{path}: missing required key {key!r}")
                continue
            problems += self.errors(value[key], member, f"{path}.{key}")
        problems += [f"{path}: the contract does not declare {key!r}" for key in value if key not in members]
        return problems


class ContractTests(Base):
    """Every response, key by key and type by type, against payroll-dashboard/types.ts."""

    def check(self, body, type_name):
        contract = _TsContract()
        self.assertIn(type_name, contract.types)
        self.assertEqual(contract.errors(body, ("ref", type_name)), [])

    def test_monthly(self):
        self.check(self.api("monthly", month="2026-09"), "PayMonthlyResponse")
        self.check(self.api("monthly", month="2026-07"), "PayMonthlyResponse")

    def test_department_breakdown(self):
        self.check(self.api("department-breakdown", month="2026-09"), "PayDepartmentsResponse")

    def test_people(self):
        self.check(self.api("people", month="2026-09"), "PayPeopleResponse")
        self.check(self.api("people", month="2026-09", q="nobody"), "PayPeopleResponse")

    def test_person(self):
        for emp in (self.a1, self.p1, self.c3):
            with self.subTest(emp=emp.employee_code):
                self.check(self.api(f"people/{emp.id}"), "PayPersonResponse")

    def test_an_empty_company(self):
        SalarySlip.objects.all().delete()
        self.check(self.api("monthly"), "PayMonthlyResponse")
        self.check(self.api("department-breakdown"), "PayDepartmentsResponse")
        self.check(self.api("people"), "PayPeopleResponse")

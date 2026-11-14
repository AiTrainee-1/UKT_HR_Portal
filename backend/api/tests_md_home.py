"""MD portal · the Dashboard under the welcome card (md_portal/analytics/home.py, GET /api/md/dashboard/home).

Run:  DB_TEST_NAME=test_uktex_md_home python manage.py test api.tests_md_home --noinput

One small company whose figures can be counted by hand. Today is Monday 2026-10-05, 12:00.

  Unit A: staff S1 S2 S3, production P1 P2 (joining date "01-01-45640": an Excel serial an old import left)
  Unit B: staff T1, F1 (joins 2026-10-20)          no unit: staff N1          X1 inactive (never counted)

  Today: S1 and T1 punched, P1 punched, N1 only at 03:00 (before the day starts: not in); S2 approved CL;
         S3 approved leave 5-6 Oct.
  Due today: staff S1 S2 S3 T1 N1 (F1 has not joined), production P1 P2.
     staff       5 due: present 2 (S1, T1), CL 1 (S2), absent 2 (S3 on leave, N1)
     production  2 due: present 1 (P1), absent 1 (P2)
     everyone    7 due: present 3, CL 1, absent 3 of which 1 on leave
  Yesterday was a Sunday: nobody due.
  Payroll: September S1 20,000 (staff) + P1 10,000 (production, its pay period in September); October S1 5,000 so far.
"""

from contextlib import ExitStack, contextmanager
from datetime import date, datetime, time
from decimal import Decimal
from unittest import mock

from django.db import connection
from django.test.utils import CaptureQueriesContext

from .md_portal.analytics import home as H
from .md_portal.analytics import payroll as P
from .models import (
    AttendanceLog,
    Branch,
    CasualLeaveRequest,
    Employee,
    HRUser,
    LeaveRequest,
    SalarySlip,
)
from .tests_md_support import MdApiTestCase, md_headers

TODAY = date(2026, 10, 5)  # a Monday
URL = "/api/md/dashboard/home"


@contextmanager
def at(day: date = TODAY, hour: int = 12):
    now = datetime.combine(day, time(hour, 0))
    with ExitStack() as stack:
        for target, name, value in ((H, "ist_today", day), (H, "ist_now", now), (P, "_today", day)):
            stack.enter_context(mock.patch.object(target, name, return_value=value))
        yield


def slip(emp, year, month, gross, period=None):
    gross = Decimal(str(gross))
    return SalarySlip.objects.create(
        employee=emp,
        month=month,
        year=year,
        slip_number=f"H/{emp.employee_code}/{year}{month:02d}",
        basic=gross / 2,
        hra=Decimal(0),
        allowances=Decimal(0),
        incentives=Decimal(0),
        bonuses=Decimal(0),
        ot_amount=Decimal(0),
        gross_salary=gross,
        pf_deduction=Decimal(0),
        esi_deduction=Decimal(0),
        advance_deduction=Decimal(0),
        other_deductions=Decimal(0),
        total_deductions=Decimal("100"),
        net_salary=gross - Decimal("100"),
        working_days=26,
        present_days=Decimal(26),
        absent_days=Decimal(0),
        period_start=period[0] if period else None,
        period_end=period[1] if period else None,
        breakdown_details={"type": "production" if period else "staff", "summary": {}, "earnings": {}},
    )


class HomeTests(MdApiTestCase):
    def setUp(self):
        super().setUp()
        a = Branch.objects.create(name="Unit A")
        b = Branch.objects.create(name="Unit B")

        def emp(code, kind="staff", branch=None, join="2024-01-01", status="active"):
            return Employee.objects.create(
                employee_code=code,
                first_name=code,
                last_name="",
                employment_type=kind,
                status=status,
                branch=branch,
                join_date=join,
                salary_amount=Decimal("26000"),
            )

        self.s1, self.s2, self.s3 = emp("S1", branch=a), emp("S2", branch=a), emp("S3", branch=a)
        self.p1 = emp("P1", "production", a, join="01-01-45640")
        self.p2 = emp("P2", "production", a, join="01-01-45894")
        self.t1, self.f1 = emp("T1", branch=b), emp("F1", branch=b, join="2026-10-20")
        self.n1 = emp("N1")
        emp("X1", branch=a, status="inactive")

        for e, t in ((self.s1, time(9, 0)), (self.t1, time(9, 5)), (self.p1, time(8, 30)), (self.n1, time(3, 0))):
            AttendanceLog.objects.create(employee=e, date=TODAY, punch_time=t, punch_type="IN", source="test")
        CasualLeaveRequest.objects.create(employee=self.s2, date=TODAY, status="approved")
        LeaveRequest.objects.create(
            employee=self.s3, type="casual", start_date="2026-10-05", end_date="2026-10-06", status="approved"
        )
        slip(self.s1, 2026, 9, 20000)
        slip(self.p1, 2026, 9, 10000, period=(date(2026, 9, 1), date(2026, 9, 30)))
        slip(self.s1, 2026, 10, 5000)

    def answer(self):
        with at():
            r = self.get(URL)
        self.assertEqual(r.status_code, 200, r.content[:500])
        return r.json()

    def test_employees_by_kind_and_unit(self):
        e = self.answer()["employees"]
        self.assertEqual((e["total"], e["staff"], e["production"]), (8, 6, 2))
        self.assertEqual(
            [(u["name"], u["staff"], u["production"], u["total"]) for u in e["units"]],
            [("Unit A", 3, 2, 5), ("Unit B", 2, 0, 2), ("No unit", 1, 0, 1)],
        )

    def test_today_present_absent_with_leave_and_cl(self):
        a = self.answer()["attendance"]
        pick = lambda c: (c["expected"], c["present"], c["cl"], c["absent"], c["onLeave"])  # noqa: E731
        self.assertEqual(pick(a), (7, 3, 1, 3, 1))
        self.assertEqual(pick(a["staff"]), (5, 2, 1, 2, 1))
        self.assertEqual(pick(a["production"]), (2, 1, 0, 1, 0))
        self.assertEqual(a["presentPct"], 42.9)
        self.assertTrue(a["provisional"])
        units = {u["name"]: pick(u) for u in a["units"]}
        self.assertEqual(units, {"Unit A": (5, 2, 1, 2, 1), "Unit B": (1, 1, 0, 0, 0), "No unit": (1, 0, 0, 1, 0)})

    def test_production_with_a_broken_joining_date_is_counted_and_the_page_is_told(self):
        body = self.answer()
        self.assertEqual(body["attendance"]["production"]["expected"], 2)
        self.assertEqual(len(body["notes"]), 1)
        self.assertIn("2 active employee(s) have a joining date that is not a real date", body["notes"][0])

    def test_fourteen_days_with_the_sunday_empty_and_today_last(self):
        trend = self.answer()["attendance"]["trend"]
        self.assertEqual(len(trend), 14)
        self.assertEqual((trend[0]["date"], trend[-1]["date"]), ("2026-09-22", "2026-10-05"))
        self.assertTrue(trend[-1]["today"])
        self.assertEqual(trend[-1]["present"], 3)
        sunday = next(d for d in trend if d["date"] == "2026-10-04")
        self.assertEqual((sunday["expected"], sunday["present"], sunday["absent"]), (0, 0, 0))
        saturday = next(d for d in trend if d["date"] == "2026-10-03")
        # nobody punched on Saturday: everybody due was absent (F1 had not joined, X1 is inactive)
        self.assertEqual((saturday["staff"]["expected"], saturday["staff"]["absent"]), (5, 5))

    def test_six_months_of_payroll_with_the_split_and_the_running_month(self):
        months = self.answer()["payroll"]["months"]
        self.assertEqual(
            [m["month"] for m in months], ["2026-05", "2026-06", "2026-07", "2026-08", "2026-09", "2026-10"]
        )
        sep, octo = months[-2], months[-1]
        self.assertEqual(
            (sep["figures"]["grossPay"], sep["staff"]["grossPay"], sep["production"]["grossPay"]), (30000, 20000, 10000)
        )
        self.assertEqual(sep["figures"]["netPay"], 29800)
        self.assertEqual(sep["figures"]["headcount"], 2)
        self.assertFalse(sep["current"])
        self.assertTrue(octo["current"])
        self.assertEqual((octo["state"], octo["figures"]["grossPay"], octo["production"]), ("in_progress", 5000, None))
        self.assertIsNone(months[0]["figures"])

    def test_a_handful_of_queries_however_many_people(self):
        with at(), CaptureQueriesContext(connection) as q:
            self.get(URL)
        self.assertLess(len(q), 25)

    def test_only_the_md_may_read_it(self):
        hr = HRUser.objects.create(username="plain_hr_home", password_hash="x", is_super_admin=True)
        with at():
            r = self.client.get(URL, **md_headers(hr))
        self.assertEqual(r.status_code, 403)

    def test_unit_and_counts_add_up(self):
        a = self.answer()["attendance"]
        for block in [a, a["staff"], a["production"], *a["units"], *a["trend"]]:
            self.assertEqual(block["present"] + block["cl"] + block["absent"], block["expected"])
            self.assertLessEqual(block["onLeave"], block["absent"])

    def test_gender_by_kind_with_the_unrecorded_counted_apart(self):
        Employee.objects.filter(employee_code__in=["S1", "S2", "P1"]).update(gender="male")
        Employee.objects.filter(employee_code__in=["S3", "P2"]).update(gender="Female")
        g = self.answer()["employees"]["gender"]
        self.assertEqual(g["staff"], {"male": 2, "female": 1, "other": 0, "notRecorded": 3, "total": 6})
        self.assertEqual(g["production"], {"male": 1, "female": 1, "other": 0, "notRecorded": 0, "total": 2})
        self.assertEqual((g["all"]["male"], g["all"]["female"], g["all"]["total"]), (3, 2, 8))

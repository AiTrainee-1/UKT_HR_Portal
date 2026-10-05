"""MD portal · Employees (md_portal/analytics/employees.py and routes/employees.py).

One small company, built once, whose every figure can be recomputed by hand from the comments below. Today is Monday
2026-10-05 (the factory's date, frozen in both the analytics module and ``common`` so presets resolve the same way).

    Unit1: Accounts (ACC), Cutting (CUT), Stitching (STI1)        Unit2: Stitching (STI2)   <- same name as STI1

    code  who                 type        dept  joined      left / how                         notes
    A1    Anita Raman         staff       ACC   2019-10-12  active                             F, born 1990-05-10
    A2    Arun Kumar          staff       ACC   2021-10-05  active                             M, born 1985-10-08, 5 years TODAY
    A3    Balu Chandran       staff       CUT   2016-03-01  active                             M, born 1992-11-20
    A4    Chitra Devi         production  STI1  2026-09-10  active                             F, born 2000-10-07, probation to 10-20
    A5    Divya Priya         production  STI1  2026-09-25  active                             F, born 2001-03-03, probation to 09-30
    A6    Elango Raj          production  STI2  2026-08-15  active                             M, born 1996-07-07, probation to 11-15
    A7    Farida Banu         production  STI2  (none)      active                             F, born 1988-01-30, NO join date
    A8    Ganesh Babu         production  CUT   2024-01-10  active                             M, born 1980-12-12
    A9    Hari Haran          staff       STI2  2023-06-01  active                             no gender, no date of birth
    L1    Ilango Selvam       production  STI1  2026-07-20  2026-09-12 resignation (LWD)       "better salary offer"
    L2    Jaya Lakshmi        production  STI1  2026-08-01  2026-09-20 resignation (approved)  "family problem"
    L3    Karthik Subbu       staff       ACC   2018-01-15  2026-09-30 resignation (LWD)       "health issues"
    L4    Lakshmi Narayan     production  CUT   2025-01-01  2026-09-15 deactivated, no resignation (approximate)
    L5    Mani Maran          production  STI2  2026-06-01  2026-08-20 resignation (LWD)       "better opportunity elsewhere"
    L6    Nithya Sri          staff       CUT   (none)      2026-09-05 resignation (LWD)       "Not interested"

Headcount at the end of a day = joined by then + people with no join date - left by then (a leaver drops out ON the
exit date): 2026-04-30: 9 | 05-31: 9 | 06-30: 10 | 07-31: 11 | 08-31: 12 | 09-30: 9 | today (10-05): 9 = the 9 active.
"""

import json
import time
from contextlib import contextmanager
from datetime import UTC, date, datetime
from unittest import mock

from django.db import connection
from django.test import SimpleTestCase, TestCase
from django.test.utils import CaptureQueriesContext
from rest_framework.test import APIRequestFactory

from .clock import FACTORY_TZ
from .md_portal import common as C
from .md_portal.analytics import employees as E
from .md_portal.assistant import registry
from .models import (
    AttendanceDayRecord,
    Branch,
    Department,
    DepartmentHeadcount,
    Designation,
    Employee,
    EmployeeDocument,
    EmployeeShiftAssignment,
    Holiday,
    HRUser,
    LeaveBalance,
    LeaveType,
    Promotion,
    ResignationRequest,
    SalaryIncrement,
    ShiftTemplate,
)
from .tests_md_support import MdApiTestCase, md_headers

TODAY = date(2026, 10, 5)  # a Monday


@contextmanager
def frozen(today: date = TODAY):
    """The factory's date, as the analytics and the period presets both read it."""
    with mock.patch.object(C, "ist_today", return_value=today), mock.patch.object(E, "ist_today", return_value=today):
        yield


def at(y: int, m: int, d: int, hour: int = 10) -> datetime:
    return datetime(y, m, d, hour, 0, tzinfo=FACTORY_TZ)


def period(**params) -> C.Period:
    return C.resolve_period(params, today=TODAY)


EVERYONE = C.Scope()


def build_company(cls) -> None:
    """The company in the module docstring, on ``cls`` (a TestCase class)."""
    cls.u1 = Branch.objects.create(name="Unit1", code="U1")
    cls.u2 = Branch.objects.create(name="Unit2", code="U2")
    cls.acc = Department.objects.create(name="Accounts", branch=cls.u1)
    cls.cut = Department.objects.create(name="Cutting", branch=cls.u1)
    cls.sti1 = Department.objects.create(name="Stitching", branch=cls.u1)
    cls.sti2 = Department.objects.create(name="Stitching", branch=cls.u2)
    cls.d_accountant = Designation.objects.create(title="Accountant", department=cls.acc)
    cls.d_master = Designation.objects.create(title="Cutting Master", department=cls.cut)
    cls.d_operator = Designation.objects.create(title="Operator", department=cls.sti1)
    cls.d_super = Designation.objects.create(title="Supervisor", department=cls.sti2)

    def mk(code, first, last, kind, dept, desig, gender, dob, joined, status="active", **extra):
        return Employee.objects.create(
            employee_code=code,
            first_name=first,
            last_name=last,
            employment_type=kind,
            department=dept,
            branch=dept.branch,
            designation=desig,
            gender=gender,
            date_of_birth=dob,
            join_date=joined,
            status=status,
            **extra,
        )

    cls.a1 = mk("A1", "Anita", "Raman", "staff", cls.acc, cls.d_accountant, "female", date(1990, 5, 10), "2019-10-12")
    cls.a2 = mk("A2", "Arun", "Kumar", "staff", cls.acc, cls.d_accountant, "male", date(1985, 10, 8), "2021-10-05")
    cls.a3 = mk("A3", "Balu", "Chandran", "staff", cls.cut, cls.d_master, "male", date(1992, 11, 20), "2016-03-01")
    cls.a4 = mk(
        "A4", "Chitra", "Devi", "production", cls.sti1, cls.d_operator, "female", date(2000, 10, 7), "2026-09-10",
        probation_end_date=date(2026, 10, 20),
    )  # fmt: skip
    cls.a5 = mk(
        "A5", "Divya", "Priya", "production", cls.sti1, cls.d_operator, "female", date(2001, 3, 3), "2026-09-25",
        probation_end_date=date(2026, 9, 30),
    )  # fmt: skip
    cls.a6 = mk(
        "A6", "Elango", "Raj", "production", cls.sti2, cls.d_operator, "male", date(1996, 7, 7), "2026-08-15",
        probation_end_date=date(2026, 11, 15),
    )  # fmt: skip
    cls.a7 = mk("A7", "Farida", "Banu", "production", cls.sti2, cls.d_operator, "female", date(1988, 1, 30), "")
    cls.a8 = mk("A8", "Ganesh", "Babu", "production", cls.cut, cls.d_operator, "male", date(1980, 12, 12), "2024-01-10")
    cls.a9 = mk("A9", "Hari", "Haran", "staff", cls.sti2, cls.d_super, None, None, "2023-06-01")

    def left(code, first, last, kind, dept, desig, gender, joined, **resignation):
        emp = mk(code, first, last, kind, dept, desig, gender, None, joined, status="inactive")
        if resignation:
            ResignationRequest.objects.create(employee=emp, status="approved", **resignation)
        return emp

    cls.l1 = left(
        "L1", "Ilango", "Selvam", "production", cls.sti1, cls.d_operator, "male", "2026-07-20",
        last_working_date=date(2026, 9, 12), reason="better salary offer",
    )  # fmt: skip
    cls.l2 = left(
        "L2", "Jaya", "Lakshmi", "production", cls.sti1, cls.d_operator, "female", "2026-08-01",
        approved_at=at(2026, 9, 20), reason="family problem",
    )  # fmt: skip
    cls.l3 = left(
        "L3", "Karthik", "Subbu", "staff", cls.acc, cls.d_accountant, "male", "2018-01-15",
        last_working_date=date(2026, 9, 30), reason="health issues",
    )  # fmt: skip
    cls.l4 = left("L4", "Lakshmi", "Narayan", "production", cls.cut, cls.d_operator, "female", "2025-01-01")
    Employee.objects.filter(pk=cls.l4.pk).update(updated_at=at(2026, 9, 15, 12))  # a plain deactivation: approximate
    cls.l5 = left(
        "L5", "Mani", "Maran", "production", cls.sti2, cls.d_operator, "male", "2026-06-01",
        last_working_date=date(2026, 8, 20), reason="better opportunity elsewhere",
    )  # fmt: skip
    cls.l6 = left(
        "L6", "Nithya", "Sri", "staff", cls.cut, cls.d_master, "female", "",
        last_working_date=date(2026, 9, 5), reason="Not interested",
    )  # fmt: skip
    for dept, required in ((cls.acc, 3), (cls.cut, 2), (cls.sti2, 1)):
        DepartmentHeadcount.objects.create(department=dept, required_count=required)


class EmployeesTestCase(MdApiTestCase):
    """The small company, today frozen at TODAY, the MD signed in."""

    @classmethod
    def setUpTestData(cls):
        build_company(cls)

    def setUp(self):
        super().setUp()
        self.enterContext(frozen())

    def get_ok(self, path: str, **params) -> dict:
        r = self.get(path, **params)
        self.assertEqual(r.status_code, 200, r.content[:400])
        return r.json()


def by_label(rows: list[dict], key: str = "label") -> dict:
    return {r[key]: r for r in rows}


# ─── pure logic (no database) ────────────────────────────────────────────────────────────────────────────────


class ReasonGroupingTests(SimpleTestCase):
    def test_the_first_group_that_matches_wins_and_the_survey_answer_is_read_first(self):
        cases = {
            "better salary offer": "better_pay",
            "Got a job in another company": "better_pay",
            "family problem": "personal",
            "Getting married next month": "personal",
            "health issues": "health",
            "Surgery for my mother": "health",  # health outranks family
            "going for higher studies": "studies",
            "start my own business": "business",
            "Retirement": "retirement",
            "work pressure from the supervisor": "workplace",
            "relocating to my native village": "relocation",
            "Not interested": "other",
            "": "none",
            None: "none",
            "   ": "none",
        }
        for text, group in cases.items():
            self.assertEqual(E.classify_reason(text), group, text)
        self.assertEqual(E.classify_reason("family matters", "better pay"), "personal")  # survey answer first
        self.assertEqual(E.classify_reason("???", "better pay"), "better_pay")  # else the resignation reason
        self.assertEqual(E.classify_reason(None, "xyz"), "other")
        self.assertEqual(set(E.REASON_LABELS), {k for k, _l, _p in E.REASON_GROUPS} | {"other", "none"})


class RollTests(SimpleTestCase):
    def people(self, spans):
        """spans: (joined, left) pairs; joined None = no usable join date."""
        return [
            E.Person(
                id=i, code=f"P{i}", name=f"P{i}", kind="staff", active=left is None, gender="male", dob=None,
                dept_id=None, desig_id=None, branch_id=None, joined=joined, left=left, exit_basis=None,
                reason_survey=None, reason_text=None, probation_end=None, confirmed_on=None,
            )
            for i, (joined, left) in enumerate(spans)
        ]  # fmt: skip

    def test_headcount_and_flows_follow_the_rule_that_a_leaver_drops_out_on_the_exit_date(self):
        roll = E.Roll(
            self.people(
                [
                    (date(2026, 1, 1), None),
                    (date(2026, 3, 10), date(2026, 3, 20)),  # joins and leaves inside March
                    (date(2026, 3, 20), None),
                    (None, None),  # no join date: here since before
                    (None, date(2026, 3, 1)),  # no join date, left 1 March
                ]
            )
        )
        self.assertEqual(roll.headcount(date(2025, 12, 31)), 2)  # the two with no join date
        self.assertEqual(roll.headcount(date(2026, 2, 28)), 3)  # + the 1 Jan joiner; the 1 March leaver is still here
        self.assertEqual(roll.headcount(date(2026, 3, 1)), 2)  # gone ON the exit date
        self.assertEqual(roll.headcount(date(2026, 3, 19)), 3)
        self.assertEqual(roll.headcount(date(2026, 3, 20)), 3)  # one leaves, one joins that day
        self.assertEqual(roll.joined(date(2026, 3, 1), date(2026, 3, 31)), 2)
        self.assertEqual(roll.left(date(2026, 3, 1), date(2026, 3, 31)), 2)
        for first, last in ((date(2026, 1, 1), date(2026, 3, 31)), (date(2026, 3, 11), date(2026, 3, 20))):
            opening = roll.headcount(first - date.resolution)
            self.assertEqual(opening + roll.joined(first, last) - roll.left(first, last), roll.headcount(last))

    def test_bands(self):
        self.assertEqual([E._age_band(a) for a in (None, 17, 18, 25, 26, 35, 36, 45, 46, 55, 56, 70)], [
            None, "Under 18", "18-25", "18-25", "26-35", "26-35", "36-45", "36-45", "46-55", "46-55", "56+", "56+",
        ])  # fmt: skip
        self.assertEqual([E._tenure_band(y) for y in (0, 1, 2, 3, 4, 5, 9, 10, 25)], [
            "Under 1 year", "1-3 years", "1-3 years", "3-5 years", "3-5 years", "5-10 years", "5-10 years", "10+ years", "10+ years",
        ])  # fmt: skip

    def test_buckets_clip_to_the_period(self):
        month = E._buckets(date(2025, 11, 15), date(2026, 2, 10), "month")
        self.assertEqual([(k, a.isoformat(), b.isoformat()) for k, _l, a, b in month], [
            ("2025-11", "2025-11-15", "2025-11-30"), ("2025-12", "2025-12-01", "2025-12-31"),
            ("2026-01", "2026-01-01", "2026-01-31"), ("2026-02", "2026-02-01", "2026-02-10"),
        ])  # fmt: skip
        week = E._buckets(date(2026, 9, 6), date(2026, 10, 5), "week")
        self.assertEqual(len(week), 5)
        self.assertEqual((week[0][2].isoformat(), week[0][3].isoformat()), ("2026-09-06", "2026-09-12"))
        self.assertEqual((week[-1][2].isoformat(), week[-1][3].isoformat()), ("2026-10-04", "2026-10-05"))
        self.assertEqual(len(E._buckets(date(2026, 10, 1), date(2026, 10, 5), "day")), 5)
        self.assertEqual(E._buckets(date(2026, 10, 5), date(2026, 10, 4), "month"), [])
        self.assertEqual(
            [E._grain_for(d) for d in (1, 14, 15, 100, 101, 365)], ["day", "day", "week", "week", "month", "month"]
        )


# ─── summary ─────────────────────────────────────────────────────────────────────────────────────────────────


class SummaryTests(EmployeesTestCase):
    def test_september_by_hand(self):
        body = self.get_ok("/api/md/employees/summary", month="2026-09")
        self.assertEqual(body["period"]["label"], "Sep 2026")
        hc = body["headcount"]
        self.assertEqual((hc["current"], hc["staff"], hc["production"], hc["other"]), (9, 4, 5, 0))
        self.assertEqual((hc["opening"], hc["closing"]), (12, 9))  # 31 Aug and 30 Sep
        self.assertEqual(hc["change"], {"abs": -3.0, "pct": -25.0})
        self.assertEqual(body["joiners"]["count"], 2)  # A4 (10 Sep), A5 (25 Sep)
        self.assertEqual(body["leavers"]["count"], 5)  # L1, L2, L3, L4, L6 (L5 left in August)
        self.assertEqual(body["leavers"]["approximate"], 1)  # L4: deactivated without a resignation
        self.assertEqual(body["net"]["count"], -3)
        self.assertEqual(12 + body["joiners"]["count"] - body["leavers"]["count"], hc["closing"])  # the identity
        att = body["attrition"]
        self.assertEqual(att["averageHeadcount"], 10.5)  # (12 + 9) / 2
        self.assertEqual(att["pct"], 47.6)  # 5 / 10.5
        self.assertEqual(
            att["annualisedPct"], 579.4
        )  # 5 / 10.5 x 100 = 47.619..., x 365 / 30 days (scaled from the exact rate)
        self.assertEqual(body["earlyAttrition"]["count"], 2)  # L1 after 54 days, L2 after 50
        self.assertEqual(body["earlyAttrition"]["pctOfLeavers"], 40.0)

    def test_the_previous_period_is_the_same_length_just_before(self):
        body = self.get_ok("/api/md/employees/summary", month="2026-09")
        self.assertEqual((body["previousPeriod"]["start"], body["previousPeriod"]["end"]), ("2026-08-02", "2026-08-31"))
        # 2 Aug - 31 Aug: A6 joined (15 Aug; L2's 1 Aug is a day outside), L5 left (20 Aug); 12 -> 12
        self.assertEqual((body["joiners"]["previous"], body["leavers"]["previous"], body["net"]["previous"]), (1, 1, 0))
        self.assertEqual(body["attrition"]["previousPct"], 8.3)  # 1 / 12
        self.assertEqual(body["attrition"]["change"], {"abs": 39.3, "pct": 473.5})
        self.assertEqual(body["joiners"]["change"], {"abs": 1.0, "pct": 100.0})
        self.assertEqual(body["earlyAttrition"]["previous"], 1)  # L5 after 80 days
        self.assertEqual(body["earlyAttrition"]["change"], {"abs": 1.0, "pct": 100.0})

    def test_a_period_ends_inclusive_on_both_sides(self):
        # 20 Sep (L2 left) to 30 Sep (L3 left): both ends count, and so does A5's 25 Sep join in between
        body = self.get_ok("/api/md/employees/summary", **{"from": "2026-09-20", "to": "2026-09-30"})
        self.assertEqual((body["joiners"]["count"], body["leavers"]["count"]), (1, 2))
        one_day = self.get_ok("/api/md/employees/summary", **{"from": "2026-09-30", "to": "2026-09-30"})
        self.assertEqual((one_day["leavers"]["count"], one_day["period"]["days"]), (1, 1))  # L3 on his exit date
        self.assertEqual(one_day["attrition"]["annualisedPct"], None)  # a day is never scaled to a year

    def test_a_period_across_a_year_boundary(self):
        body = self.get_ok("/api/md/employees/summary", **{"from": "2025-12-20", "to": "2026-01-10"})
        self.assertEqual((body["period"]["days"], body["period"]["label"]), (22, "20 Dec 2025 – 10 Jan 2026"))
        self.assertEqual((body["joiners"]["count"], body["leavers"]["count"]), (0, 0))
        # winter: A1 A2 A3 A8 A9 L3 L4 had joined (7), plus A7 and L6 with no join date: 9 on both sides of New Year
        self.assertEqual((body["headcount"]["opening"], body["headcount"]["closing"]), (9, 9))
        self.assertEqual(body["attrition"]["pct"], 0.0)
        self.assertIsNone(body["attrition"]["annualisedPct"])  # 22 days is too short to scale up to a year
        longer = self.get_ok("/api/md/employees/summary", **{"from": "2025-12-20", "to": "2026-01-16"})  # 28 days
        self.assertEqual((longer["period"]["days"], longer["attrition"]["annualisedPct"]), (28, 0.0))  # 0 stays 0

    def test_tenure_gender_and_age(self):
        body = self.get_ok("/api/md/employees/summary", period="last_30_days")
        end = date(2026, 10, 5)
        joined = [date(2019, 10, 12), date(2021, 10, 5), date(2016, 3, 1), date(2026, 9, 10), date(2026, 9, 25),
                  date(2026, 8, 15), date(2024, 1, 10), date(2023, 6, 1)]  # fmt: skip
        self.assertEqual(body["tenure"]["averageYears"], round(sum((end - j).days for j in joined) / 8 / 365.25, 1))
        self.assertEqual(body["tenure"]["unknown"], 1)  # A7 has no join date
        self.assertEqual(body["gender"], {
            "male": 4, "female": 4, "other": 0, "unspecified": 1, "recorded": 8, "femalePct": 50.0,
        })  # fmt: skip
        self.assertEqual(body["age"], {"average": 34.0, "known": 8})  # 36 40 33 25 25 30 38 45

    def test_the_tenure_comparison_is_read_on_the_last_day_of_the_previous_period(self):
        body = self.get_ok("/api/md/employees/summary", month="2026-09")
        then = date(2026, 8, 31)
        joined = [date(2019, 10, 12), date(2021, 10, 5), date(2016, 3, 1), date(2026, 8, 15), date(2024, 1, 10),
                  date(2023, 6, 1), date(2026, 7, 20), date(2026, 8, 1), date(2018, 1, 15), date(2025, 1, 1)]  # fmt: skip
        self.assertEqual(body["tenure"]["previousYears"], round(sum((then - j).days for j in joined) / 10 / 365.25, 1))
        # on 31 Aug A7 and L6 had no join date; "unknown" is counted on the last day of the period (30 Sep): only A7
        self.assertEqual(body["tenure"]["unknown"], 1)
        end = date(2026, 9, 30)
        now = [date(2019, 10, 12), date(2021, 10, 5), date(2016, 3, 1), date(2026, 9, 10), date(2026, 9, 25),
               date(2026, 8, 15), date(2024, 1, 10), date(2023, 6, 1)]  # fmt: skip
        self.assertEqual(body["tenure"]["averageYears"], round(sum((end - j).days for j in now) / 8 / 365.25, 1))

    def test_provenance_explains_the_figures_and_the_reconstruction(self):
        body = self.get_ok("/api/md/employees/summary", month="2026-09")
        ids = {p["id"] for p in body["provenance"]}
        self.assertTrue(
            {"headcount", "reconstructed-headcount", "joiners-leavers", "attrition", "early-attrition"} <= ids
        )
        attrition = next(p for p in body["provenance"] if p["id"] == "attrition")
        self.assertIn("leavers ÷ ((opening headcount + closing headcount) ÷ 2) × 100", attrition["formula"])
        self.assertTrue(
            any("Report Center" in c and "exit rate" in c for c in attrition["caveats"])
        )  # why the two differ
        recon = next(p for p in body["provenance"] if p["id"] == "reconstructed-headcount")
        self.assertTrue(any("no headcount history" in c for c in recon["caveats"]))
        notes = " ".join(body["notes"])
        self.assertIn("2 people have a missing or unusable join date", notes)  # A7 and L6
        self.assertIn("1 of the 5 leavers in this period have only an approximate exit date", notes)

    def test_a_period_that_has_not_started_is_empty_not_wrong(self):
        body = self.get_ok("/api/md/employees/summary", **{"from": "2026-11-01", "to": "2026-11-30"})
        self.assertEqual((body["joiners"]["count"], body["leavers"]["count"]), (0, 0))
        self.assertIsNone(body["attrition"]["pct"])
        self.assertIsNone(body["headcount"]["opening"])
        self.assertIn("has not started yet", " ".join(body["notes"]))

    def test_a_period_that_runs_into_the_future_stops_at_today(self):
        body = self.get_ok("/api/md/employees/summary", **{"from": "2026-10-01", "to": "2026-10-31"})
        self.assertEqual(body["period"]["end"], "2026-10-05")
        self.assertEqual(body["period"]["days"], 5)
        self.assertEqual(body["headcount"]["closing"], 9)  # today's reconstruction is the number of active people

    def test_today_reconstructs_to_exactly_the_active_headcount(self):
        body = self.get_ok("/api/md/employees/summary", period="this_month")
        self.assertEqual(body["headcount"]["closing"], body["headcount"]["current"])

    def test_scope_unit_department_and_type(self):
        unit2 = self.get_ok("/api/md/employees/summary", month="2026-09", branch="Unit2")
        self.assertEqual(unit2["headcount"]["current"], 3)  # A6, A7, A9
        self.assertEqual((unit2["headcount"]["opening"], unit2["headcount"]["closing"]), (3, 3))
        self.assertEqual((unit2["joiners"]["count"], unit2["leavers"]["count"]), (0, 0))
        self.assertEqual(unit2["attrition"]["pct"], 0.0)
        self.assertEqual(unit2["scope"]["description"], "Unit2 · all departments · staff and production")

        stitching = self.get_ok("/api/md/employees/summary", month="2026-09", department="Stitching")  # both units
        self.assertEqual(stitching["headcount"]["current"], 5)  # A4, A5, A6, A7, A9
        self.assertEqual(stitching["leavers"]["count"], 2)  # L1, L2 (L5 left in August)

        staff = self.get_ok("/api/md/employees/summary", month="2026-09", type="staff")
        self.assertEqual(
            (staff["headcount"]["current"], staff["headcount"]["staff"], staff["headcount"]["production"]), (4, 4, 0)
        )
        self.assertEqual(
            (staff["headcount"]["opening"], staff["headcount"]["closing"]), (6, 4)
        )  # A1 A2 A3 A9 L3 L6 -> 4
        self.assertEqual((staff["joiners"]["count"], staff["leavers"]["count"]), (0, 2))  # L3, L6
        self.assertEqual(staff["attrition"]["pct"], 40.0)  # 2 / 5

        both = self.get_ok(
            "/api/md/employees/summary", month="2026-09", branch="Unit1", department="Stitching", type="production"
        )
        self.assertEqual(both["headcount"]["current"], 2)  # A4, A5
        self.assertEqual(both["leavers"]["count"], 2)  # L1, L2
        self.assertEqual((both["headcount"]["opening"], both["headcount"]["closing"]), (2, 2))
        self.assertEqual(both["attrition"]["pct"], 100.0)

    def test_a_bad_parameter_is_a_400_with_the_reason(self):
        for params in ({"period": "fortnight"}, {"department": "Quantum Physics"}, {"type": "contract"}):
            r = self.get("/api/md/employees/summary", **params)
            self.assertEqual(r.status_code, 400, params)
            self.assertTrue(r.json()["error"])

    def test_the_default_period_is_the_last_12_months(self):
        body = self.get_ok("/api/md/employees/summary")
        self.assertEqual((body["period"]["start"], body["period"]["end"]), ("2025-11-01", "2026-10-05"))

    def test_the_numbers_are_plain_json_and_money_free(self):
        text = json.dumps(self.get_ok("/api/md/employees/summary", month="2026-09"))
        self.assertNotIn("salary", text.lower())


class SummaryEdgeCases(MdApiTestCase):
    def setUp(self):
        super().setUp()
        self.enterContext(frozen())

    def test_an_empty_company_answers_with_nulls_not_zeros_or_errors(self):
        for path in ("summary", "composition", "movement", "attrition", "milestones", "insights", "directory"):
            r = self.get(f"/api/md/employees/{path}", period="last_30_days")
            self.assertEqual(r.status_code, 200, f"{path}: {r.content[:300]}")
        body = self.get("/api/md/employees/summary", period="last_30_days").json()
        self.assertEqual(body["headcount"]["current"], 0)
        self.assertIsNone(body["attrition"]["pct"])  # no headcount: "no data", never 0%
        self.assertIsNone(body["tenure"]["averageYears"])
        self.assertIsNone(body["age"]["average"])
        self.assertIsNone(body["gender"]["femalePct"])
        self.assertIsNone(body["earlyAttrition"]["pctOfLeavers"])
        composition = self.get("/api/md/employees/composition").json()
        self.assertEqual((composition["total"], composition["staffing"]["planned"]), (0, False))
        self.assertTrue(all(row["pct"] is None for row in composition["byType"]))

    def test_inconsistent_join_dates_are_placed_by_the_documented_rules(self):
        unit = Branch.objects.create(name="Unit1")
        dept = Department.objects.create(name="Cutting", branch=unit)
        junk = ["", "not a date", "9999-12-31", "1900-01-01", "2026-12-25"]  # missing, unreadable, absurd x2, future
        for i, text in enumerate(junk):
            Employee.objects.create(
                employee_code=f"J{i}", first_name="J", last_name=str(i), department=dept, branch=unit, join_date=text
            )
        e = Employee.objects.create(
            employee_code="X1", first_name="Exit", last_name="Before", department=dept, branch=unit,
            join_date="2026-09-20", status="inactive",
        )  # fmt: skip
        Employee.objects.filter(pk=e.pk).update(
            updated_at=at(2026, 9, 1)
        )  # deactivated (approximate) before he "joined"
        body = self.get("/api/md/employees/summary", month="2026-09").json()
        self.assertEqual(body["headcount"]["current"], 5)
        quality = body["dataQuality"]
        self.assertEqual((quality["noJoinDate"], quality["futureJoinDate"], quality["exitBeforeJoin"]), (4, 1, 1))
        self.assertEqual(quality["unplaced"], 6)
        # unusable join dates are "here since before": everyone is on the rolls all through September, no joiners
        self.assertEqual((body["headcount"]["opening"], body["headcount"]["closing"]), (6, 5))
        self.assertEqual(
            (body["joiners"]["count"], body["leavers"]["count"]), (0, 1)
        )  # the exit-before-join leaver counts as a leaver
        self.assertEqual(body["headcount"]["closing"], body["headcount"]["current"])
        self.assertIsNone(body["tenure"]["averageYears"])  # nobody here has a usable join date

    def test_a_last_working_day_still_ahead_counts_as_today(self):
        unit = Branch.objects.create(name="Unit1")
        dept = Department.objects.create(name="Cutting", branch=unit)
        Employee.objects.create(
            employee_code="S1", first_name="Stays", last_name="On", department=dept, branch=unit, join_date="2020-01-01"
        )
        e = Employee.objects.create(
            employee_code="S2", first_name="Serving", last_name="Notice", department=dept, branch=unit,
            join_date="2020-01-01", status="inactive",
        )  # fmt: skip
        ResignationRequest.objects.create(employee=e, status="approved", last_working_date=date(2026, 10, 30))
        body = self.get("/api/md/employees/summary", period="this_month").json()
        self.assertEqual(
            (body["leavers"]["count"], body["headcount"]["closing"], body["headcount"]["current"]), (1, 1, 1)
        )

    def test_a_rejoiner_is_dated_by_the_exit_after_the_latest_join(self):
        unit = Branch.objects.create(name="Unit1")
        dept = Department.objects.create(name="Cutting", branch=unit)
        e = Employee.objects.create(
            employee_code="R1", first_name="Re", last_name="Joiner", department=dept, branch=unit,
            join_date="2025-06-01", status="inactive",
        )  # fmt: skip
        ResignationRequest.objects.create(
            employee=e, status="approved", last_working_date=date(2024, 12, 31)
        )  # an old stint
        ResignationRequest.objects.create(employee=e, status="approved", last_working_date=date(2026, 9, 10))
        ResignationRequest.objects.create(employee=e, status="rejected", last_working_date=date(2026, 9, 25))
        body = self.get("/api/md/employees/summary", month="2026-09").json()
        self.assertEqual(body["leavers"]["count"], 1)
        ex = self.get("/api/md/employees/attrition", month="2026-09").json()
        self.assertEqual(ex["early"]["count"], 0)  # 2025-06-01 -> 2026-09-10 is over a year
        self.assertEqual(ex["tenureAtExit"][2], {"key": "1to3", "label": "1-3 years", "count": 1, "pct": 100.0})


# ─── composition ─────────────────────────────────────────────────────────────────────────────────────────────


class CompositionTests(EmployeesTestCase):
    def test_who_works_here_today(self):
        body = self.get_ok("/api/md/employees/composition")
        self.assertEqual(body["total"], 9)
        types = by_label(body["byType"])
        self.assertEqual((types["Staff"]["count"], types["Staff"]["pct"]), (4, 44.4))
        self.assertEqual((types["Production"]["count"], types["Production"]["pct"]), (5, 55.6))
        self.assertNotIn("Other", types)
        units = by_label(body["byUnit"])
        self.assertEqual((units["Unit1"]["count"], units["Unit1"]["staff"], units["Unit1"]["production"]), (6, 3, 3))
        self.assertEqual((units["Unit2"]["count"], units["Unit2"]["staff"], units["Unit2"]["production"]), (3, 1, 2))
        self.assertEqual([r["label"] for r in body["byUnit"]], ["Unit1", "Unit2"])  # biggest first

    def test_departments_with_the_same_name_in_two_units_are_told_apart(self):
        body = self.get_ok("/api/md/employees/composition")
        depts = by_label(body["byDepartment"])
        self.assertEqual(set(depts), {"Accounts", "Cutting", "Stitching (Unit1)", "Stitching (Unit2)"})
        self.assertEqual(
            {k: v["count"] for k, v in depts.items()},
            {"Accounts": 2, "Cutting": 2, "Stitching (Unit1)": 2, "Stitching (Unit2)": 3},
        )
        self.assertEqual(depts["Stitching (Unit2)"]["unit"], "Unit2")
        self.assertEqual(body["byDepartment"][0]["label"], "Stitching (Unit2)")  # the biggest
        self.assertEqual(body["departmentsTotal"], 4)

    def test_the_biggest_groups_then_other(self):
        body = self.get_ok("/api/md/employees/composition", limit=2)
        depts = body["byDepartment"]
        self.assertEqual(len(depts), 3)
        self.assertEqual(
            depts[-1],
            {
                "id": None,
                "label": "Other (2)",
                "count": 4,
                "other": True,
                "staff": 1,
                "production": 3,
                "pct": 44.4,
            },
        )  # Cutting (A3 staff, A8 production) + Stitching (Unit1) (A4, A5 production)
        designations = self.get_ok("/api/md/employees/composition", limit=2)["byDesignation"]
        self.assertEqual(
            [(r["label"], r["count"]) for r in designations], [("Operator", 5), ("Accountant", 2), ("Other (2)", 2)]
        )
        self.assertEqual(
            self.get_ok("/api/md/employees/composition", limit=99)["byDesignation"][-1]["label"], "Supervisor"
        )

    def test_gender_age_and_length_of_service(self):
        body = self.get_ok("/api/md/employees/composition")
        self.assertEqual({r["key"]: r["count"] for r in body["byGender"]}, {"male": 4, "female": 4, "unspecified": 1})
        ages = {r["label"]: r["count"] for r in body["byAgeBand"]}
        self.assertEqual(
            ages, {"Under 18": 0, "18-25": 2, "26-35": 2, "36-45": 4, "46-55": 0, "56+": 0, "Not recorded": 1}
        )
        tenure = {r["label"]: r["count"] for r in body["byTenureBand"]}
        self.assertEqual(
            tenure,
            {"Under 1 year": 3, "1-3 years": 1, "3-5 years": 1, "5-10 years": 2, "10+ years": 1, "Not known": 1},
        )
        self.assertEqual(sum(tenure.values()), 9)

    def test_planned_against_actual_staff(self):
        staffing = self.get_ok("/api/md/employees/composition")["staffing"]
        self.assertTrue(staffing["planned"])
        self.assertEqual(
            (staffing["required"], staffing["actual"], staffing["vacancies"], staffing["departmentsBelow"]),
            (6, 4, 2, 2),
        )
        rows = staffing["rows"]
        self.assertEqual(
            [r["label"] for r in rows], ["Accounts", "Cutting", "Stitching (Unit2)"]
        )  # biggest gap first, then name
        # the plan counts STAFF only: Cutting has A3 (staff) and A8 (production); only A3 counts against its plan of 2
        self.assertEqual(
            [(r["required"], r["actual"], r["gap"], r["fillPct"]) for r in rows],
            [(3, 2, 1, 66.7), (2, 1, 1, 50.0), (1, 1, 0, 100.0)],
        )

    def test_the_staffing_plan_follows_the_scope_and_is_not_shown_for_production(self):
        unit2 = self.get_ok("/api/md/employees/composition", branch="Unit2")["staffing"]
        self.assertEqual([r["label"] for r in unit2["rows"]], ["Stitching (Unit2)"])
        production = self.get_ok("/api/md/employees/composition", type="production")
        self.assertEqual(production["staffing"]["rows"], [])
        self.assertIn("staff only", " ".join(production["notes"]))
        self.assertEqual(production["total"], 5)

    def test_no_plan_set_says_so(self):
        DepartmentHeadcount.objects.all().delete()
        body = self.get_ok("/api/md/employees/composition")
        self.assertEqual((body["staffing"]["planned"], body["staffing"]["rows"]), (False, []))
        self.assertIn("No required headcount is set", " ".join(body["notes"]))

    def test_a_zero_plan_is_not_a_plan(self):
        DepartmentHeadcount.objects.filter(department=self.acc).update(required_count=0)
        labels = [r["label"] for r in self.get_ok("/api/md/employees/composition")["staffing"]["rows"]]
        self.assertNotIn("Accounts", labels)

    def test_the_scope_narrows_every_breakdown(self):
        body = self.get_ok("/api/md/employees/composition", branch="Unit1", department="Stitching")
        self.assertEqual(body["total"], 2)
        self.assertEqual([r["label"] for r in body["byUnit"]], ["Unit1"])
        self.assertEqual(
            body["byDepartment"][0]["label"], "Stitching (Unit1)"
        )  # the label does not depend on the scope

    def test_provenance_names_the_plan_and_the_bands(self):
        ids = {p["id"] for p in self.get_ok("/api/md/employees/composition")["provenance"]}
        self.assertEqual(ids, {"composition", "age-tenure-bands", "staffing-plan"})


# ─── movement ────────────────────────────────────────────────────────────────────────────────────────────────


class MovementTests(EmployeesTestCase):
    def test_five_months_in_monthly_steps_and_the_headcount_line(self):
        body = self.get_ok("/api/md/employees/movement", **{"from": "2026-05-01", "to": "2026-09-30"})
        self.assertEqual(body["grain"], "month")  # 153 days
        pts = body["points"]
        self.assertEqual([p["key"] for p in pts], ["2026-05", "2026-06", "2026-07", "2026-08", "2026-09"])
        self.assertEqual([p["joiners"] for p in pts], [0, 1, 1, 2, 2])  # L5 | L1 | L2 + A6 | A4 + A5
        self.assertEqual([p["leavers"] for p in pts], [0, 0, 0, 1, 5])  # L5 | L1 L2 L3 L4 L6
        self.assertEqual([p["net"] for p in pts], [0, 1, 1, 1, -3])
        self.assertEqual([p["headcount"] for p in pts], [9, 10, 11, 12, 9])  # at each month end
        self.assertEqual(body["totals"], {"joiners": 6, "leavers": 6, "net": 0, "opening": 9, "closing": 9})
        self.assertEqual(pts[0]["label"], "May 2026")
        # the line is built from the steps: opening + running net = headcount
        running = body["totals"]["opening"]
        for p in pts:
            running += p["net"]
            self.assertEqual(running, p["headcount"])

    def test_a_short_period_is_shown_in_weeks_or_days(self):
        weeks = self.get_ok("/api/md/employees/movement", period="last_30_days")  # 6 Sep - 5 Oct
        self.assertEqual(weeks["grain"], "week")
        self.assertEqual(len(weeks["points"]), 5)
        self.assertEqual(weeks["points"][0]["start"], "2026-09-06")
        # steps of 7 days from the first day of the period; (step start, joiners, leavers). L6 left on 5 Sep: before it.
        self.assertEqual([(p["start"], p["joiners"], p["leavers"]) for p in weeks["points"]], [
            ("2026-09-06", 1, 1),  # A4 joined 10 Sep, L1 left 12 Sep
            ("2026-09-13", 0, 1),  # L4 left 15 Sep
            ("2026-09-20", 1, 1),  # A5 joined 25 Sep, L2 left 20 Sep
            ("2026-09-27", 0, 1),  # L3 left 30 Sep
            ("2026-10-04", 0, 0),
        ])  # fmt: skip
        self.assertEqual(weeks["totals"], {"joiners": 2, "leavers": 4, "net": -2, "opening": 11, "closing": 9})
        day = self.get_ok("/api/md/employees/movement", period="this_month")  # 1-5 Oct: five days, one step each
        self.assertEqual((day["grain"], len(day["points"])), ("day", 5))
        self.assertEqual(day["points"][0]["label"], "01 Oct")

    def test_months_across_a_year_boundary_are_clipped_to_the_period(self):
        body = self.get_ok("/api/md/employees/movement", **{"from": "2025-10-15", "to": "2026-02-10"})  # 119 days
        self.assertEqual(body["grain"], "month")
        self.assertEqual([p["key"] for p in body["points"]], ["2025-10", "2025-11", "2025-12", "2026-01", "2026-02"])
        self.assertEqual(
            [p["start"] for p in body["points"]],
            ["2025-10-15", "2025-11-01", "2025-12-01", "2026-01-01", "2026-02-01"],
        )
        self.assertEqual(body["points"][-1]["end"], "2026-02-10")
        self.assertEqual([p["label"] for p in body["points"]][:3], ["Oct 2025", "Nov 2025", "Dec 2025"])
        self.assertTrue(all(p["joiners"] == 0 and p["leavers"] == 0 for p in body["points"]))
        self.assertEqual({p["headcount"] for p in body["points"]}, {9})  # unchanged all winter: 7 placed + A7 + L6

    def test_a_period_of_88_days_across_new_year_is_in_weeks(self):
        body = self.get_ok("/api/md/employees/movement", **{"from": "2025-11-15", "to": "2026-02-10"})
        self.assertEqual((body["grain"], len(body["points"])), ("week", 13))
        self.assertEqual(body["points"][-1]["start"], "2026-02-07")  # the last step is the 4 days 7-10 Feb

    def test_the_scope_filters_the_movement(self):
        body = self.get_ok("/api/md/employees/movement", **{"from": "2026-05-01", "to": "2026-09-30"}, branch="Unit2")
        self.assertEqual([p["joiners"] for p in body["points"]], [0, 1, 0, 1, 0])  # L5 (June), A6 (August)
        self.assertEqual([p["leavers"] for p in body["points"]], [0, 0, 0, 1, 0])  # L5 (August)
        self.assertEqual([p["headcount"] for p in body["points"]], [2, 3, 3, 3, 3])  # A7 + A9, then L5, A6

    def test_the_caveat_is_in_the_provenance(self):
        body = self.get_ok("/api/md/employees/movement", period="last_90_days")
        caveats = " ".join(body["provenance"][0]["caveats"])
        self.assertIn("no headcount history", caveats)
        self.assertIn("today's department", caveats)

    def test_a_future_period_has_no_points(self):
        body = self.get_ok("/api/md/employees/movement", **{"from": "2026-11-01", "to": "2026-11-30"})
        self.assertEqual(body["points"], [])
        self.assertIn("has not started yet", " ".join(body["notes"]))


# ─── attrition ───────────────────────────────────────────────────────────────────────────────────────────────


class AttritionTests(EmployeesTestCase):
    def test_september_by_department_unit_and_type(self):
        body = self.get_ok("/api/md/employees/attrition", month="2026-09")
        self.assertEqual(
            body["company"], {"leavers": 5, "averageHeadcount": 10.5, "attritionPct": 47.6, "annualisedPct": 579.4}
        )
        depts = by_label(body["byDepartment"])
        # opening (31 Aug) / closing (30 Sep) of each department's people, average, leavers
        self.assertEqual(
            (
                depts["Stitching (Unit1)"]["leavers"],
                depts["Stitching (Unit1)"]["averageHeadcount"],
                depts["Stitching (Unit1)"]["attritionPct"],
            ),
            (2, 2.0, 100.0),
        )
        self.assertEqual(
            (depts["Cutting"]["leavers"], depts["Cutting"]["averageHeadcount"], depts["Cutting"]["attritionPct"]),
            (2, 3.0, 66.7),
        )
        self.assertEqual(
            (depts["Accounts"]["leavers"], depts["Accounts"]["averageHeadcount"], depts["Accounts"]["attritionPct"]),
            (1, 2.5, 40.0),
        )
        self.assertNotIn("Stitching (Unit2)", depts)  # nobody left in September
        self.assertEqual(
            [r["label"] for r in body["byDepartment"]], ["Stitching (Unit1)", "Cutting", "Accounts"]
        )  # highest first
        self.assertEqual((body["departmentsWithLeavers"], body["departmentsTotal"]), (3, 4))
        self.assertEqual(sum(r["leavers"] for r in body["byDepartment"]), body["company"]["leavers"])

        units = by_label(body["byUnit"])
        self.assertEqual(
            (units["Unit1"]["leavers"], units["Unit1"]["averageHeadcount"], units["Unit1"]["attritionPct"]),
            (5, 7.5, 66.7),
        )
        self.assertEqual((units["Unit2"]["leavers"], units["Unit2"]["attritionPct"]), (0, 0.0))  # shown next to Unit1
        kinds = by_label(body["byType"])
        self.assertEqual(
            (kinds["Staff"]["leavers"], kinds["Staff"]["averageHeadcount"], kinds["Staff"]["attritionPct"]),
            (2, 5.0, 40.0),
        )
        self.assertEqual(
            (
                kinds["Production"]["leavers"],
                kinds["Production"]["averageHeadcount"],
                kinds["Production"]["attritionPct"],
            ),
            (3, 5.5, 54.5),
        )
        self.assertNotIn("Other", kinds)

    def test_how_long_leavers_stayed(self):
        body = self.get_ok("/api/md/employees/attrition", month="2026-09")
        tenure = {r["key"]: r["count"] for r in body["tenureAtExit"]}
        # L1 54 days, L2 50 days | L4 1 year 8 months | L3 8 years | L6 has no join date
        self.assertEqual(tenure, {"early": 2, "under1y": 0, "1to3": 1, "3to5": 0, "5plus": 1, "unknown": 1})
        self.assertEqual(sum(tenure.values()), body["company"]["leavers"])
        self.assertEqual(body["tenureAtExit"][0]["pct"], 40.0)

    def test_the_90_day_line_is_inclusive(self):
        unit = Branch.objects.create(name="Unit3")
        dept = Department.objects.create(name="Packing", branch=unit)
        for code, joined, lwd in (("E90", "2026-06-01", date(2026, 8, 30)), ("E91", "2026-06-01", date(2026, 8, 31))):
            e = Employee.objects.create(
                employee_code=code,
                first_name=code,
                last_name="T",
                department=dept,
                branch=unit,
                join_date=joined,
                status="inactive",
            )
            ResignationRequest.objects.create(employee=e, status="approved", last_working_date=lwd)
        body = self.get_ok("/api/md/employees/attrition", month="2026-08", branch="Unit3")
        self.assertEqual((date(2026, 8, 30) - date(2026, 6, 1)).days, 90)
        self.assertEqual(body["early"]["count"], 1)  # day 90 is early, day 91 is not
        self.assertEqual(body["early"]["items"][0]["code"], "E90")

    def test_the_reasons_people_gave(self):
        body = self.get_ok("/api/md/employees/attrition", month="2026-09")
        reasons = [(r["label"], r["count"], r["pct"]) for r in body["reasons"]]
        self.assertEqual(reasons, [
            ("Better pay or opportunity", 1, 20.0), ("Health", 1, 20.0), ("Family or personal reasons", 1, 20.0),
            ("Other reasons", 1, 20.0), ("No reason recorded", 1, 20.0),
        ])  # fmt: skip
        self.assertEqual(sum(r["count"] for r in body["reasons"]), 5)
        # the keyword grouping is declared a guide, not data
        caveat = next(p for p in body["provenance"] if p["id"] == "leaving-reasons")["caveats"][0]
        self.assertIn("keyword match", caveat)

    def test_the_survey_answer_outranks_the_resignation_reason(self):
        ResignationRequest.objects.filter(employee=self.l1).update(survey_q1_answer="work pressure and management")
        reasons = {r["key"]: r["count"] for r in self.get_ok("/api/md/employees/attrition", month="2026-09")["reasons"]}
        self.assertEqual(reasons["workplace"], 1)
        self.assertNotIn("better_pay", reasons)

    def test_people_who_left_within_90_days_are_listed_newest_first(self):
        body = self.get_ok("/api/md/employees/attrition", month="2026-09")
        early = body["early"]
        self.assertEqual((early["count"], early["pctOfLeavers"]), (2, 40.0))
        first, second = early["items"]
        self.assertEqual(
            (first["code"], first["name"], first["left"], first["joined"], first["days"]),
            ("L2", "Jaya Lakshmi", "2026-09-20", "2026-08-01", 50),
        )
        self.assertEqual((second["code"], second["left"], second["days"]), ("L1", "2026-09-12", 54))
        self.assertEqual(
            (first["department"], first["unit"], first["designation"]), ("Stitching (Unit1)", "Unit1", "Operator")
        )
        self.assertEqual(
            (first["reason"], second["reason"]), ("Family or personal reasons", "Better pay or opportunity")
        )
        self.assertEqual((first["approximate"], second["approximate"]), (False, False))
        self.assertEqual(
            self.get_ok("/api/md/employees/attrition", month="2026-09", limit=1)["early"]["items"][0]["code"], "L2"
        )

    def test_approximate_exit_dates_are_declared(self):
        body = self.get_ok("/api/md/employees/attrition", month="2026-09")
        self.assertEqual(body["approximateExits"], 1)
        self.assertIn("1 of the 5 leavers in this period have only an approximate exit date", " ".join(body["notes"]))
        august = self.get_ok("/api/md/employees/attrition", month="2026-08")
        self.assertEqual((august["approximateExits"], august["company"]["leavers"]), (0, 1))  # L5

    def test_scope_narrows_attrition(self):
        body = self.get_ok("/api/md/employees/attrition", month="2026-09", branch="Unit1", type="staff")
        self.assertEqual(body["company"]["leavers"], 2)  # L3, L6
        self.assertEqual(body["company"]["averageHeadcount"], 4.0)  # A1 A2 A3 L3 L6 -> opening 5, closing 3
        self.assertEqual(body["company"]["attritionPct"], 50.0)
        self.assertEqual([r["label"] for r in body["byType"]], ["Staff"])

    def test_no_hot_spot_in_a_small_team(self):
        body = self.get_ok("/api/md/employees/attrition", month="2026-09")
        self.assertEqual(body["hotspots"], [])  # Stitching (Unit1) is at 100% but 2 people is noise
        self.assertFalse(any(r["hotspot"] for r in body["byDepartment"]))


class HotSpotTests(MdApiTestCase):
    """Sewing: 12 stay and 4 leave (attrition 28.6% against 9.9% across the company); Packing: 36 stay and 1 leaves."""

    def setUp(self):
        super().setUp()
        self.enterContext(frozen())
        unit = Branch.objects.create(name="Unit1")
        sewing = Department.objects.create(name="Sewing", branch=unit)
        packing = Department.objects.create(name="Packing", branch=unit)

        def crew(dept, prefix, stays, exits):
            people = [
                Employee(employee_code=f"{prefix}{i}", first_name=prefix, last_name=str(i), department=dept, branch=unit,
                         employment_type="production", join_date="2020-01-01")
                for i in range(stays)
            ]  # fmt: skip
            gone = [
                Employee(employee_code=f"{prefix}x{i}", first_name=prefix, last_name=f"x{i}", department=dept, branch=unit,
                         employment_type="production", join_date="2020-01-01", status="inactive")
                for i in range(len(exits))
            ]  # fmt: skip
            Employee.objects.bulk_create(people + gone)
            ResignationRequest.objects.bulk_create(
                [
                    ResignationRequest(
                        employee=Employee.objects.get(employee_code=f"{prefix}x{i}"),
                        status="approved",
                        last_working_date=day,
                    )
                    for i, day in enumerate(exits)
                ]
            )

        crew(sewing, "S", 12, [date(2026, 8, 1), date(2026, 8, 15), date(2026, 9, 1), date(2026, 9, 15)])
        crew(packing, "P", 36, [date(2026, 8, 10)])

    def test_a_department_far_above_the_company_is_flagged(self):
        body = self.get("/api/md/employees/attrition", period="last_90_days").json()  # 8 Jul - 5 Oct
        self.assertEqual(body["company"]["leavers"], 5)
        self.assertEqual(
            (body["company"]["averageHeadcount"], body["company"]["attritionPct"]), (50.5, 9.9)
        )  # 53 -> 48
        rows = by_label(body["byDepartment"])
        self.assertEqual((rows["Sewing"]["averageHeadcount"], rows["Sewing"]["attritionPct"]), (14.0, 28.6))  # 16 -> 12
        self.assertEqual(
            (rows["Packing"]["averageHeadcount"], rows["Packing"]["attritionPct"]), (36.5, 2.7)
        )  # 37 -> 36
        self.assertTrue(rows["Sewing"]["hotspot"])  # 28.6 >= 1.5 x 9.9, 4 leavers, average 14
        self.assertFalse(rows["Packing"]["hotspot"])
        self.assertEqual([r["label"] for r in body["hotspots"]], ["Sewing"])

    def test_insights_report_it_with_the_numbers_in_the_title(self):
        items = E.insights(today=TODAY)
        hot = next(i for i in items if i["id"].startswith("employees.attrition-hotspot"))
        self.assertEqual(hot["severity"], "warning")  # double the company rate, but only 4 leavers (critical needs 5)
        self.assertEqual(hot["title"], "Sewing attrition is 28.6%, against 9.9% across the company")
        self.assertEqual((hot["metric"], hot["page"]), ("28.6%", "employees"))
        self.assertIn("4 people left from an average of 14", hot["detail"])
        self.assertTrue(hot["ask"])
        self.assertLessEqual(len(items), 5)

    def test_a_fifth_leaver_makes_it_critical(self):
        e = Employee.objects.create(employee_code="Sx9", first_name="S", last_name="x9", employment_type="production",
                                    department=Department.objects.get(name="Sewing"), join_date="2020-01-01", status="inactive")  # fmt: skip
        ResignationRequest.objects.create(employee=e, status="approved", last_working_date=date(2026, 9, 20))
        hot = next(i for i in E.insights(today=TODAY) if i["id"].startswith("employees.attrition-hotspot"))
        self.assertEqual(hot["severity"], "critical")

    def test_the_page_exceptions_follow_the_chosen_period_and_scope(self):
        body = self.get("/api/md/employees/insights", period="last_90_days").json()
        self.assertEqual(body["items"][0]["severity"], "warning")
        self.assertTrue(body["items"][0]["id"].startswith("employees.attrition-hotspot"))
        quiet = self.get("/api/md/employees/insights", month="2026-09", department="Packing").json()
        self.assertFalse(any(i["id"].startswith("employees.attrition-hotspot") for i in quiet["items"]))


# ─── milestones ──────────────────────────────────────────────────────────────────────────────────────────────


class MilestonesTests(EmployeesTestCase):
    def test_work_anniversaries_of_five_years_or_more(self):
        body = self.get_ok("/api/md/employees/milestones")
        ann = body["anniversaries"]
        self.assertEqual((ann["minYears"], ann["total"], ann["today"]), (5, 2, 1))
        self.assertEqual(
            [(i["code"], i["date"], i["years"]) for i in ann["items"]],
            [("A2", "2026-10-05", 5), ("A1", "2026-10-12", 7)],
        )
        self.assertEqual(ann["items"][0]["joined"], "2021-10-05")
        self.assertEqual(body["windowDays"], 30)

    def test_the_look_ahead_decides_who_is_listed(self):
        self.assertEqual(self.get_ok("/api/md/employees/milestones", days=1)["anniversaries"]["total"], 1)  # today only
        self.assertEqual(
            self.get_ok("/api/md/employees/milestones", days=7)["anniversaries"]["total"], 1
        )  # A1 is on the 12th
        self.assertEqual(self.get_ok("/api/md/employees/milestones", days=8)["anniversaries"]["total"], 2)
        far = self.get_ok("/api/md/employees/milestones", days=90)["anniversaries"]  # to 2 Jan: nobody else
        self.assertEqual(far["total"], 2)
        self.assertEqual(self.get_ok("/api/md/employees/milestones", days=500)["windowDays"], 90)  # capped

    def test_birthdays_show_the_day_but_never_the_age(self):
        body = self.get_ok("/api/md/employees/milestones")
        bd = body["birthdays"]
        self.assertEqual((bd["windowDays"], bd["total"]), (7, 2))
        self.assertEqual([(i["code"], i["date"]) for i in bd["items"]], [("A4", "2026-10-07"), ("A2", "2026-10-08")])
        text = json.dumps(bd)
        self.assertNotIn("1985", text)
        self.assertNotIn("2000-10-07", text)
        self.assertNotIn("age", text.lower().replace("manage", ""))
        self.assertEqual(self.get_ok("/api/md/employees/milestones", birthdayDays=30)["birthdays"]["total"], 2)
        self.assertEqual(
            self.get_ok("/api/md/employees/milestones", birthdayDays=3)["birthdays"]["total"], 1
        )  # 5-7 Oct: A4
        self.assertEqual(
            self.get_ok("/api/md/employees/milestones", birthdayDays=2)["birthdays"]["total"], 0
        )  # 5-6 Oct

    def test_a_29_february_anniversary_is_marked_on_the_28th_in_other_years(self):
        Employee.objects.filter(pk=self.a3.pk).update(join_date="2016-02-29", date_of_birth=date(1992, 2, 29))
        body = E.milestones(EVERYONE, days=30, birthday_days=10, today=date(2026, 2, 20))  # 2026 is not a leap year
        self.assertEqual(
            [(i["code"], i["date"], i["years"]) for i in body["anniversaries"]["items"]], [("A3", "2026-02-28", 10)]
        )
        self.assertEqual([(i["code"], i["date"]) for i in body["birthdays"]["items"]], [("A3", "2026-02-28")])
        leap = E.milestones(EVERYONE, days=30, birthday_days=10, today=date(2028, 2, 20))  # 2028 is
        self.assertEqual([i["date"] for i in leap["anniversaries"]["items"]], ["2028-02-29"])

    def test_probation_uses_only_recorded_dates(self):
        prob = self.get_ok("/api/md/employees/milestones")["probation"]
        self.assertEqual((prob["recorded"], prob["dueSoon"], prob["pendingConfirmation"]), (3, 1, 1))
        self.assertEqual(
            [(i["code"], i["date"]) for i in prob["items"]], [("A4", "2026-10-20")]
        )  # A6 ends 15 Nov: later than 30 days
        Employee.objects.filter(pk=self.a5.pk).update(
            confirmation_date=date(2026, 9, 28)
        )  # confirmed: no longer pending
        self.assertEqual(self.get_ok("/api/md/employees/milestones")["probation"]["pendingConfirmation"], 0)

    def test_what_is_missing_is_said(self):
        Employee.objects.update(probation_end_date=None)
        body = self.get_ok("/api/md/employees/milestones")
        notes = " ".join(body["notes"])
        self.assertIn("No probation end dates are recorded", notes)
        self.assertIn("1 of 9 people have no date of birth", notes)

    def test_leavers_have_no_milestones_and_scope_applies(self):
        Employee.objects.filter(pk=self.a1.pk).update(status="inactive")
        self.assertEqual(
            [i["code"] for i in self.get_ok("/api/md/employees/milestones")["anniversaries"]["items"]], ["A2"]
        )
        unit2 = self.get_ok("/api/md/employees/milestones", branch="Unit2")
        self.assertEqual((unit2["anniversaries"]["total"], unit2["birthdays"]["total"]), (0, 0))

    def test_the_list_is_capped(self):
        body = self.get_ok("/api/md/employees/milestones", limit=1)
        self.assertEqual((body["anniversaries"]["total"], len(body["anniversaries"]["items"])), (2, 1))


# ─── directory ───────────────────────────────────────────────────────────────────────────────────────────────


class DirectoryTests(EmployeesTestCase):
    def test_a_page_of_the_active_people_by_name(self):
        body = self.get_ok("/api/md/employees/directory")
        self.assertEqual((body["total"], body["page"], body["pages"], body["pageSize"]), (9, 1, 1, 25))
        self.assertEqual(
            [r["code"] for r in body["rows"]], ["A1", "A2", "A3", "A4", "A5", "A6", "A7", "A8", "A9"]
        )  # first names
        row = body["rows"][0]
        self.assertEqual(row, {
            "id": self.a1.id, "name": "Anita Raman", "code": "A1", "designation": "Accountant", "department": "Accounts",
            "unit": "Unit1", "type": "staff", "joinDate": "2019-10-12", "tenure": "6y 11m", "tenureYears": 6.9,
            "status": "active", "leftOn": None,
        })  # fmt: skip

    def test_no_pay_in_the_directory(self):
        Employee.objects.update(salary_amount=45000, salary_per_shift=900, initial_salary=30000)
        text = json.dumps(self.get_ok("/api/md/employees/directory")).lower()
        for word in ("salary", "45000", "900.0", "30000", "bank", "pf_number", "phone", "email", "photo"):
            self.assertNotIn(word, text)

    def test_paging(self):
        first = self.get_ok("/api/md/employees/directory", pageSize=4)
        self.assertEqual((first["total"], first["pages"], len(first["rows"])), (9, 3, 4))
        last = self.get_ok("/api/md/employees/directory", pageSize=4, page=3)
        self.assertEqual([r["code"] for r in last["rows"]], ["A9"])
        beyond = self.get_ok("/api/md/employees/directory", pageSize=4, page=99)
        self.assertEqual((beyond["page"], [r["code"] for r in beyond["rows"]]), (3, ["A9"]))  # clamped to the last page
        self.assertEqual(
            self.get_ok("/api/md/employees/directory", pageSize=5000)["pageSize"], 100
        )  # never more than 100
        self.assertEqual(self.get("/api/md/employees/directory", page="two").status_code, 400)

    def test_search_by_name_or_code_word_by_word(self):
        def codes(**p):
            return [r["code"] for r in self.get_ok("/api/md/employees/directory", **p)["rows"]]

        self.assertEqual(codes(q="anita"), ["A1"])
        self.assertEqual(codes(q="ARUN KUMAR"), ["A2"])
        self.assertEqual(codes(q="raj elango"), ["A6"])  # any order
        self.assertEqual(codes(q="a7"), ["A7"])
        self.assertEqual(codes(q="  "), codes())  # blank means no search
        self.assertEqual(codes(q="zzz"), [])
        # "an" is inside Anita/Raman, Chandran, Elango, Banu, Ganesh, Haran, Ilango, Narayan and Mani/Maran
        self.assertEqual(codes(q="an", status="all"), ["A1", "A3", "A6", "A7", "A8", "A9", "L1", "L4", "L5"])
        self.assertEqual(codes(q="an"), ["A1", "A3", "A6", "A7", "A8", "A9"])  # active only by default

    def test_status_filter(self):
        self.assertEqual(self.get_ok("/api/md/employees/directory", status="inactive")["total"], 6)
        self.assertEqual(self.get_ok("/api/md/employees/directory", status="all")["total"], 15)
        left = {r["code"]: r for r in self.get_ok("/api/md/employees/directory", status="inactive")["rows"]}
        self.assertEqual((left["L3"]["status"], left["L3"]["leftOn"]), ("inactive", "2026-09-30"))
        self.assertEqual(left["L3"]["tenure"], "8y 8m")  # to the exit date, not to today
        self.assertEqual(left["L4"]["leftOn"], "2026-09-15")
        self.assertIsNone(left["L6"]["joinDate"])
        self.assertIsNone(left["L6"]["tenure"])
        self.assertEqual(self.get("/api/md/employees/directory", status="gone").status_code, 400)

    def test_filters_unit_department_type_designation(self):
        def codes(**p):
            return [r["code"] for r in self.get_ok("/api/md/employees/directory", **p)["rows"]]

        self.assertEqual(codes(branch="Unit2"), ["A6", "A7", "A9"])
        self.assertEqual(codes(department="Stitching"), ["A4", "A5", "A6", "A7", "A9"])
        self.assertEqual(codes(department="Stitching", branch="Unit1"), ["A4", "A5"])
        self.assertEqual(codes(type="staff"), ["A1", "A2", "A3", "A9"])
        self.assertEqual(codes(designation="operator"), ["A4", "A5", "A6", "A7", "A8"])  # any case
        self.assertEqual(codes(designation=str(self.d_master.id)), ["A3"])  # or the id
        self.assertEqual(codes(designation="Operator", type="production", branch="Unit1"), ["A4", "A5", "A8"])

    def test_sorting(self):
        def codes(**p):
            return [r["code"] for r in self.get_ok("/api/md/employees/directory", **p)["rows"]]

        self.assertEqual(codes(sort="code", dir="desc")[:3], ["A9", "A8", "A7"])
        self.assertEqual(codes(sort="joined", dir="desc")[:3], ["A5", "A4", "A6"])  # newest first; A7 (no date) last
        self.assertEqual(codes(sort="joined", dir="desc")[-1], "A7")
        self.assertEqual(codes(sort="joined", dir="asc")[:2], ["A3", "A1"])
        self.assertEqual(codes(sort="department")[:2], ["A1", "A2"])  # Accounts first
        self.assertEqual(self.get("/api/md/employees/directory", sort="salary").status_code, 400)

    def test_the_designations_on_offer_for_the_filter(self):
        options = self.get_ok("/api/md/employees/directory")["options"]["designations"]
        self.assertEqual(options[0], "Operator")  # the most common first
        self.assertEqual(set(options), {"Operator", "Accountant", "Cutting Master", "Supervisor"})

    def test_provenance_lists_the_filters_used(self):
        body = self.get_ok("/api/md/employees/directory", q="an", status="all", designation="Operator", branch="Unit1")
        filters = body["provenance"][0]["filters"]
        self.assertIn("Status: all", filters)
        self.assertIn("Search: an", filters)
        self.assertIn("Designation: Operator", filters)


# ─── one person ──────────────────────────────────────────────────────────────────────────────────────────────


class ProfileTests(EmployeesTestCase):
    def setUp(self):
        super().setUp()
        Promotion.objects.create(
            employee=self.a1, previous_designation=self.d_master, new_designation=self.d_accountant,
            previous_department=self.cut, new_department=self.acc, effective_date=date(2023, 4, 1),
        )  # fmt: skip
        SalaryIncrement.objects.create(
            employee=self.a1, previous_salary=41234, new_salary=44527.72, percent=8, effective_date=date(2024, 4, 1)
        )
        SalaryIncrement.objects.create(
            employee=self.a1, previous_salary=44527.72, new_salary=48000, percent=7.8, effective_date=date(2025, 4, 1)
        )
        lt = LeaveType.objects.create(name="Test Leave", code="TST", max_days_per_year=12)
        LeaveBalance.objects.create(employee=self.a1, leave_type=lt, year=2026, allocated=12, used=2.5, remaining=9.5)
        LeaveBalance.objects.create(employee=self.a1, leave_type=lt, year=2025, allocated=12, used=12, remaining=0)

    def day(self, y, m, d, status="present", **kw):
        return AttendanceDayRecord(employee=self.a1, date=date(y, m, d), status=status, **kw)

    def test_the_story_of_one_person(self):
        body = self.get_ok(f"/api/md/employees/employee/{self.a1.id}")
        self.assertTrue(body["found"])
        p = body["profile"]
        self.assertEqual((p["name"], p["code"], p["status"], p["type"]), ("Anita Raman", "A1", "active", "staff"))
        self.assertEqual((p["designation"], p["department"], p["unit"]), ("Accountant", "Accounts", "Unit1"))
        self.assertEqual((p["joinDate"], p["tenure"], p["tenureYears"]), ("2019-10-12", "6y 11m", 6.9))
        self.assertEqual((p["gender"], p["ageBand"]), ("female", "36-45"))
        self.assertNotIn("dateOfBirth", p)
        events = [(e["type"], e["date"], e["title"], e["detail"]) for e in body["history"]]
        self.assertEqual(events, [
            ("increment", "2025-04-01", "Increment given", "7.8%"),
            ("increment", "2024-04-01", "Increment given", "8%"),
            ("promotion", "2023-04-01", "Promoted to Accountant · Moved to Accounts", "From Cutting Master · Cutting"),
            ("joined", "2019-10-12", "Joined the company", None),
        ])  # fmt: skip

    def test_no_pay_anywhere_in_the_profile(self):
        Employee.objects.filter(pk=self.a1.pk).update(
            salary_amount=48817, salary_per_shift=777.77, initial_salary=41234
        )
        text = json.dumps(self.get_ok(f"/api/md/employees/employee/{self.a1.id}")).lower()
        for secret in (
            "48817",
            "44527",
            "41234",
            "777.77",
            "salary_",
            "bank_account",
            "bank_name",
            "ifsc",
            "uan_",
            "password",
            "phone",
            "email",
        ):
            self.assertNotIn(secret, text, secret)
        self.assertNotIn('"salary', text)  # no field about pay at all (the increment is only a percentage)
        self.assertNotIn("previous_salary", text)

    def test_a_leaver_has_an_exit_and_a_reason(self):
        body = self.get_ok(f"/api/md/employees/employee/{self.l1.id}")
        p = body["profile"]
        self.assertEqual((p["status"], p["leftOn"], p["exitApproximate"]), ("inactive", "2026-09-12", False))
        self.assertEqual(p["leavingReason"], "Better pay or opportunity")
        self.assertEqual(
            p["leavingReasonText"], "better salary offer"
        )  # the page may show the words; the assistant may not
        self.assertEqual(
            (p["tenure"], p["tenureYears"]), ("1m", 0.1)
        )  # joined 20 Jul, left 12 Sep: counted to the exit
        exit_event = body["history"][0]
        self.assertEqual(
            (exit_event["type"], exit_event["date"], exit_event["title"]), ("exit", "2026-09-12", "Left the company")
        )
        self.assertEqual(exit_event["detail"], "Better pay or opportunity")

    def test_a_plain_deactivation_says_the_date_is_approximate(self):
        body = self.get_ok(f"/api/md/employees/employee/{self.l4.id}")
        self.assertEqual((body["profile"]["leftOn"], body["profile"]["exitApproximate"]), ("2026-09-15", True))
        self.assertEqual(body["profile"]["leavingReason"], "No reason recorded")
        self.assertEqual(body["history"][0]["title"], "Deactivated (date approximate)")

    def test_attendance_over_the_last_90_days_read_like_the_report_center(self):
        # the window is the 90 completed days before today: 7 Jul .. 4 Oct 2026. A1 is staff with no Saturday-off roster.
        AttendanceDayRecord.objects.bulk_create(
            [self.day(2026, 9, d) for d in (1, 2, 3, 4, 7, 8)]  # Tue-Fri, Mon, Tue: six present
            + [self.day(2026, 9, 9, "half_shift")]
            + [self.day(2026, 9, 10, "absent"), self.day(2026, 9, 11, "absent")]
            + [self.day(2026, 9, 14, "on_leave"), self.day(2026, 9, 15, "holiday")]
            + [self.day(2026, 9, 16, is_late=True), self.day(2026, 9, 17, "half_shift", is_late=True)]
            + [self.day(2026, 9, 6, "absent")]  # a Sunday: never a scheduled day for staff, so never an absence
        )
        att = self.get_ok(f"/api/md/employees/employee/{self.a1.id}")["attendance"]
        self.assertEqual((att["from"], att["to"]), ("2026-07-07", "2026-10-04"))
        self.assertEqual((att["presentDays"], att["halfDays"], att["absentDays"], att["leaveDays"]), (7, 2, 2, 1))
        self.assertEqual(
            att["attendancePct"], 72.7
        )  # (7 + 0.5 x 2) / (7 + 2 + 2) = 8 / 11; leave and the holiday are left out
        self.assertEqual(att["lateDays"], 2)  # the late present day and the late half day
        self.assertEqual(att["recordedDays"], 14)
        self.assertEqual(att["coveragePct"], 15.6)  # 14 records over 90 days: most of those days were never opened

    def test_a_staff_saturday_off_is_not_an_absence(self):
        shift = ShiftTemplate.objects.create(name="General", start_time="09:00", end_time="17:30")
        EmployeeShiftAssignment.objects.create(
            employee=self.a1, shift=shift, effective_from=date(2026, 1, 1), saturday_off=True
        )
        Holiday.objects.create(name="Test Day", date=date(2026, 9, 15))
        AttendanceDayRecord.objects.bulk_create(
            [
                self.day(2026, 9, 1),  # Tue present
                self.day(2026, 9, 2),  # Wed present
                self.day(2026, 9, 5, "absent"),  # Sat with a Saturday-off roster: off, not absent
                self.day(2026, 9, 3, "absent"),  # Thu absent: counts
                self.day(2026, 9, 15, "holiday"),
            ]
        )
        att = self.get_ok(f"/api/md/employees/employee/{self.a1.id}")["attendance"]
        self.assertEqual((att["presentDays"], att["absentDays"]), (2, 1))
        self.assertEqual(att["attendancePct"], 66.7)  # 2 / (2 + 1)
        self.assertEqual(att["recordedDays"], 5)

    def test_a_saturday_without_a_saturday_off_roster_is_a_working_day(self):
        AttendanceDayRecord.objects.bulk_create([self.day(2026, 9, 5, "absent"), self.day(2026, 9, 2)])
        att = self.get_ok(f"/api/md/employees/employee/{self.a1.id}")["attendance"]
        self.assertEqual((att["presentDays"], att["absentDays"], att["attendancePct"]), (1, 1, 50.0))

    def test_production_sundays_and_holidays_are_not_scheduled(self):
        sunday_absent = AttendanceDayRecord(employee=self.a8, date=date(2026, 9, 6), status="absent")
        AttendanceDayRecord.objects.bulk_create(
            [
                AttendanceDayRecord(employee=self.a8, date=date(2026, 9, 1), status="present"),
                AttendanceDayRecord(employee=self.a8, date=date(2026, 9, 2), status="absent"),
                sunday_absent,  # Sunday: weekly off for production in this view
                AttendanceDayRecord(employee=self.a8, date=date(2026, 9, 7), status="absent"),  # Monday, a holiday
            ]
        )
        Holiday.objects.create(name="Local Day", date=date(2026, 9, 7))
        att = self.get_ok(f"/api/md/employees/employee/{self.a8.id}")["attendance"]
        self.assertEqual((att["presentDays"], att["absentDays"], att["attendancePct"]), (1, 1, 50.0))

    def test_half_days_count_half_and_leave_is_not_absence(self):
        AttendanceDayRecord.objects.bulk_create(
            [
                self.day(2026, 9, 1),
                self.day(2026, 9, 2, "half_shift"),
                self.day(2026, 9, 3, "on_leave"),
                self.day(2026, 9, 4, "absent", is_late=False),
            ]
        )
        att = self.get_ok(f"/api/md/employees/employee/{self.a1.id}")["attendance"]
        self.assertEqual((att["presentDays"], att["halfDays"], att["absentDays"], att["leaveDays"]), (1, 1, 1, 1))
        self.assertEqual(att["attendancePct"], 50.0)  # (1 + 0.5) / (1 + 1 + 1); leave is left out
        self.assertEqual(att["lateDays"], 0)

    def test_late_days_and_coverage(self):
        AttendanceDayRecord.objects.bulk_create(
            [self.day(2026, 9, 1, is_late=True), self.day(2026, 9, 2, is_late=True), self.day(2026, 9, 3)]
        )
        att = self.get_ok(f"/api/md/employees/employee/{self.a1.id}")["attendance"]
        self.assertEqual((att["lateDays"], att["recordedDays"]), (2, 3))
        self.assertEqual(att["coveragePct"], 3.3)  # 3 of 90 days: attendance has barely been opened, and it says so

    def test_no_attendance_is_null_not_zero(self):
        att = self.get_ok(f"/api/md/employees/employee/{self.a1.id}")["attendance"]
        self.assertIsNone(att["attendancePct"])
        self.assertEqual((att["recordedDays"], att["presentDays"]), (0, 0))

    def test_a_leaver_is_read_over_the_90_days_up_to_his_exit_date(self):
        AttendanceDayRecord.objects.create(employee=self.l3, date=date(2026, 9, 1), status="present")
        AttendanceDayRecord.objects.create(employee=self.l3, date=date(2026, 9, 29), status="present")
        AttendanceDayRecord.objects.create(employee=self.l3, date=date(2026, 10, 2), status="absent")  # after he left
        att = self.get_ok(f"/api/md/employees/employee/{self.l3.id}")["attendance"]
        self.assertEqual((att["from"], att["to"]), ("2026-07-03", "2026-09-30"))  # his last working day, 30 Sep
        self.assertEqual((att["presentDays"], att["absentDays"]), (2, 0))  # the 2 Oct row is outside the window

    def test_leave_balance_this_year_only(self):
        body = self.get_ok(f"/api/md/employees/employee/{self.a1.id}")
        self.assertEqual(
            body["leaveBalance"], [{"type": "Test Leave", "allocated": 12.0, "used": 2.5, "remaining": 9.5}]
        )

    def test_an_unknown_employee_is_a_404(self):
        missing = self.get("/api/md/employees/employee/999999")
        self.assertEqual(missing.status_code, 404)
        self.assertIn("no employee", missing.json()["error"])
        self.assertEqual(
            self.get("/api/md/employees/employee/abc").status_code, 404
        )  # not even a number: no such route

    def test_required_documents_on_file_are_counted_not_shown(self):
        for category in ("pan_card", "aadhaar_card", "offer_letter"):  # an offer letter is not one of the required ones
            EmployeeDocument.objects.create(
                employee=self.a1, category=category, file="docs/x.pdf", original_filename="secret-name.pdf"
            )
        docs = self.get_ok(f"/api/md/employees/employee/{self.a1.id}")["documents"]
        self.assertEqual(docs, {
            "required": 6, "onFile": 2,
            "missing": ["Educational Certificates", "Voter ID or Birth Certificate", "Bank Passbook", "Staff Letter"],
        })  # fmt: skip
        self.assertNotIn("secret-name", json.dumps(self.get_ok(f"/api/md/employees/employee/{self.a1.id}")))
        production = self.get_ok(f"/api/md/employees/employee/{self.a8.id}")["documents"]
        self.assertEqual((production["required"], production["onFile"]), (6, 0))
        self.assertEqual(production["missing"][-1], "Production Employee Documents")  # the type-specific one

    def test_the_reporting_manager_is_named(self):
        Employee.objects.filter(pk=self.a2.pk).update(reporting_manager=self.a1)
        self.assertEqual(self.get_ok(f"/api/md/employees/employee/{self.a2.id}")["profile"]["reportsTo"], "Anita Raman")
        self.assertIsNone(self.get_ok(f"/api/md/employees/employee/{self.a1.id}")["profile"]["reportsTo"])

    def test_provenance_says_what_the_attendance_is_and_what_is_left_out(self):
        prov = self.get_ok(f"/api/md/employees/employee/{self.a1.id}")["provenance"][0]
        self.assertIn("(present days + ½ × half days)", prov["formula"])
        self.assertTrue(any("percentage only" in c for c in prov["caveats"]))


# ─── insights and the Dashboard headline ─────────────────────────────────────────────────────────────────────


class InsightTests(EmployeesTestCase):
    def test_early_attrition_needs_three_people(self):
        ids = [i["id"] for i in self.get_ok("/api/md/employees/insights", month="2026-09")["items"]]
        self.assertNotIn("employees.early-attrition", ids)  # L1 and L2 only
        e = Employee.objects.create(employee_code="E3", first_name="Third", last_name="Early", department=self.sti1, branch=self.u1,
                                    join_date="2026-08-20", status="inactive")  # fmt: skip
        ResignationRequest.objects.create(employee=e, status="approved", last_working_date=date(2026, 9, 28))
        items = self.get_ok("/api/md/employees/insights", month="2026-09")["items"]
        early = next(i for i in items if i["id"] == "employees.early-attrition")
        self.assertEqual(early["title"], "3 people left within 90 days of joining")
        self.assertEqual((early["severity"], early["metric"], early["page"]), ("warning", "3", "employees"))
        self.assertIn("That is 50% of everyone who left", early["detail"])  # 3 of 6

    def test_a_shrinking_workforce_and_rising_attrition_are_named(self):
        items = {i["id"]: i for i in self.get_ok("/api/md/employees/insights", month="2026-09")["items"]}
        # September: 12 -> 9 is -3 people (25%) but the rule needs at least 5 fewer people
        self.assertNotIn("employees.headcount-falling", items)
        # 5 leavers (47.6%) against August's 1 (8.3%)
        rising = items["employees.attrition-rising"]
        self.assertEqual(rising["title"], "Attrition rose to 47.6% from 8.3%")
        self.assertEqual(rising["severity"], "warning")

    def test_staffing_gap_and_long_service_news(self):
        items = {i["id"]: i for i in self.get_ok("/api/md/employees/insights", month="2026-09")["items"]}
        gap = items["employees.staffing-gap"]
        self.assertEqual(gap["title"], "Cutting has 1 staff against 2 planned")  # the lowest fill (50%)
        self.assertEqual((gap["severity"], gap["metric"]), ("warning", "-1"))  # under 80% filled
        self.assertIn("2 departments are below their planned staff, 2 vacancies in all.", gap["detail"])
        good = items["employees.long-service"]
        self.assertEqual((good["severity"], good["metric"]), ("good", "2"))
        self.assertEqual(good["title"], "2 people complete 5+ years of service in the next 30 days")

    def test_most_severe_first_and_at_most_five_for_the_dashboard(self):
        order = {"critical": 0, "warning": 1, "info": 2, "good": 3}
        items = E.insights(today=TODAY)
        self.assertLessEqual(len(items), 5)
        self.assertEqual([order[i["severity"]] for i in items], sorted(order[i["severity"]] for i in items))
        for item in items:
            self.assertEqual(set(item), {"id", "severity", "title", "detail", "metric", "page", "ask"})
            self.assertIn(item["severity"], order)
            self.assertEqual(item["page"], "employees")

    def test_a_fast_growing_department_is_good_to_know(self):
        unit = Branch.objects.create(name="Unit3")
        dept = Department.objects.create(name="Packing", branch=unit)
        for i in range(6):
            Employee.objects.create(
                employee_code=f"K{i}",
                first_name="K",
                last_name=str(i),
                department=dept,
                branch=unit,
                join_date="2020-01-01",
            )
        for i in range(4):
            Employee.objects.create(
                employee_code=f"N{i}",
                first_name="N",
                last_name=str(i),
                department=dept,
                branch=unit,
                join_date="2026-09-0%d" % (i + 1),
            )
        # 6 -> 10 is +4 (67%): under the 5 people needed; two more joiners make it +6
        items = self.get_ok("/api/md/employees/insights", month="2026-09", branch="Unit3")["items"]
        self.assertFalse(any(i["id"].startswith("employees.fast-growth") for i in items))
        for i in range(2):
            Employee.objects.create(
                employee_code=f"M{i}",
                first_name="M",
                last_name=str(i),
                department=dept,
                branch=unit,
                join_date="2026-09-1%d" % i,
            )
        grown = next(
            i
            for i in self.get_ok("/api/md/employees/insights", month="2026-09", branch="Unit3")["items"]
            if i["id"].startswith("employees.fast-growth")
        )
        self.assertEqual(grown["title"], "Packing grew from 6 to 12 people in Sep 2026")
        self.assertEqual((grown["severity"], grown["metric"]), ("info", "+6"))

    def test_new_joiners_missing_documents_need_three_people(self):
        # joined in the last 30 days (6 Sep - 5 Oct): A4 (10 Sep) and A5 (25 Sep), neither with a document
        ids = [i["id"] for i in self.get_ok("/api/md/employees/insights", month="2026-09")["items"]]
        self.assertNotIn("employees.documents-pending", ids)
        third = Employee.objects.create(employee_code="N3", first_name="Third", last_name="Joiner", department=self.cut, branch=self.u1,
                                        employment_type="staff", join_date="2026-09-20")  # fmt: skip
        found = {i["id"]: i for i in self.get_ok("/api/md/employees/insights", month="2026-09")["items"]}
        item = found["employees.documents-pending"]
        self.assertEqual(item["title"], "3 of 3 people who joined in the last 30 days are missing required documents")
        self.assertEqual((item["severity"], item["metric"]), ("info", "3"))
        for category in (
            "pan_card",
            "aadhaar_card",
            "educational_certificate",
            "voter_id_or_birth_certificate",
            "bank_passbook",
            "staff_letter",
        ):
            EmployeeDocument.objects.create(
                employee=third, category=category, file="docs/x.pdf", original_filename="x.pdf"
            )
        found = {i["id"]: i for i in self.get_ok("/api/md/employees/insights", month="2026-09")["items"]}
        self.assertNotIn(
            "employees.documents-pending", found
        )  # complete now: only 2 of 3 are short, under the three needed

    def test_confirmations_overdue_need_five_people(self):
        for i in range(5):
            Employee.objects.create(employee_code=f"C{i}", first_name="C", last_name=str(i), department=self.acc, branch=self.u1, join_date="2026-01-01",
                                    probation_end_date=date(2026, 4, 1))  # fmt: skip
        items = {i["id"]: i for i in self.get_ok("/api/md/employees/insights", month="2026-09")["items"]}
        self.assertEqual(
            items["employees.confirmations-overdue"]["title"],
            "6 people are past their probation end date and not confirmed",
        )  # A5 + 5

    def test_the_empty_period_has_nothing_to_flag_but_the_calendar_still_speaks(self):
        body = self.get_ok("/api/md/employees/insights", **{"from": "2026-11-01", "to": "2026-11-30"})
        self.assertEqual(body["items"], [])


class HeadlineTests(EmployeesTestCase):
    def test_the_dashboard_cards(self):
        head = E.headline(today=TODAY)
        self.assertEqual(
            [k["id"] for k in head["kpis"]],
            ["employees.headcount", "employees.attrition-12m", "employees.joiners-leavers"],
        )
        kpi = {k["id"]: k for k in head["kpis"]}
        for k in kpi.values():
            self.assertEqual(k["page"], "employees")
            self.assertIn(k["format"], ("number", "pct", "text"))

        hc = kpi["employees.headcount"]
        self.assertEqual((hc["value"], hc["sub"]), (9, "Staff 4 · Production 5"))
        # 30 days ago is 5 Sep: 13 had joined (L5 included) and L5 (20 Aug) and L6 (5 Sep, the exit date) were gone: 11
        self.assertEqual(hc["delta"], {"abs": -2, "pct": -18.2, "good": "up"})
        self.assertEqual(len(hc["spark"]), 12)  # the end of each of the last 12 months, the last one is today
        self.assertEqual(hc["spark"][-3:], [12, 9, 9])  # 31 Aug, 30 Sep, today
        self.assertEqual(hc["spark"][:7], [9] * 7)  # Nov 2025 - May 2026: nothing moved

        # last 12 months: opening 9 (31 Oct 2025), closing 9, six leavers -> 6 / 9 = 66.7%; the 12 months before: none left
        att = kpi["employees.attrition-12m"]
        self.assertEqual((att["value"], att["sub"]), (66.7, "6 left in the last 12 months"))
        self.assertEqual(att["delta"], {"abs": 66.7, "pct": None, "good": "down"})  # pct is None: nothing to divide by
        self.assertEqual(att["spark"], [0] * 9 + [1, 5, 0])  # leavers per month, Nov 2025 ... Oct 2026

        month = kpi["employees.joiners-leavers"]
        self.assertEqual((month["value"], month["sub"]), (0, "0 joined · 0 left"))  # 1-5 Oct: nothing yet
        self.assertIsNone(month["delta"])
        self.assertEqual(len(month["spark"]), 12)
        self.assertEqual(month["spark"][-3:], [1, -3, 0])  # net per month: August +1, September +2 -5, October 0

    def test_each_headline_card_can_be_explained(self):
        head = E.headline(today=TODAY)
        self.assertEqual({p["id"] for p in head["provenance"]}, {"headcount", "attrition"})
        json.dumps(head)  # plain JSON

    def test_an_empty_company_has_a_headline_too(self):
        Employee.objects.all().delete()
        head = E.headline(today=TODAY)
        kpi = {k["id"]: k for k in head["kpis"]}
        self.assertEqual(kpi["employees.headcount"]["value"], 0)
        self.assertIsNone(kpi["employees.attrition-12m"]["value"])  # no data, never 0%
        self.assertEqual(kpi["employees.attrition-12m"]["delta"], {"abs": None, "pct": None, "good": "down"})


# ─── the rules at their boundaries ───────────────────────────────────────────────────────────────────────────


class RuleBoundaryTests(SimpleTestCase):
    def test_a_hot_spot_needs_all_four_things_at_once(self):
        hot = E._is_hotspot
        self.assertTrue(hot(15.0, 3, 10.0, 10.0))  # exactly 1.5x the company, 3 leavers, an average of 10: in
        self.assertFalse(hot(14.9, 3, 10.0, 10.0))  # a hair under 1.5x
        self.assertFalse(hot(30.0, 2, 10.0, 10.0))  # only 2 leavers
        self.assertFalse(hot(30.0, 3, 9.9, 10.0))  # a team too small to read anything into
        self.assertFalse(hot(30.0, 3, 10.0, 0.0))  # the company lost nobody: nothing to be above
        self.assertFalse(hot(30.0, 3, 10.0, None))
        self.assertFalse(hot(None, 3, 10.0, 10.0))  # a department with nobody on the rolls has no rate

    def test_the_period_reads_naturally_in_a_sentence(self):
        def phrase(preset, label):
            return E._within(C.Period(date(2026, 9, 1), date(2026, 9, 30), preset, label))

        self.assertEqual(phrase("month", "Sep 2026"), "in Sep 2026")
        self.assertEqual(phrase("custom", "01 Sep – 15 Sep 2026"), "in 01 Sep – 15 Sep 2026")
        self.assertEqual(phrase("last_12_months", "Last 12 months"), "in the last 12 months")
        self.assertEqual(phrase("last_90_days", "Last 90 days"), "in the last 90 days")
        self.assertEqual(phrase("this_month", "This month"), "this month")
        self.assertEqual(phrase("last_month", "Last month"), "last month")
        self.assertEqual(phrase("today", "Today"), "today")
        self.assertEqual(phrase("this_fy", "This financial year"), "this financial year")


class ExceptionBoundaryTests(MdApiTestCase):
    def setUp(self):
        super().setUp()
        self.enterContext(frozen())
        self.unit = Branch.objects.create(name="Unit1")
        self.dept = Department.objects.create(name="Big", branch=self.unit)

    def crew(self, stays: int, exits: int, tag: str, kind: str = "production") -> None:
        """``stays`` people who stay and ``exits`` who leave on 1, 2, 3 ... September 2026 (all joined in 2020)."""
        people = [
            Employee(employee_code=f"{tag}{i}", first_name=tag, last_name=str(i), department=self.dept, branch=self.unit,
                     employment_type=kind, join_date="2020-01-01")
            for i in range(stays)
        ]  # fmt: skip
        gone = [
            Employee(employee_code=f"{tag}x{i}", first_name=tag, last_name=f"x{i}", department=self.dept, branch=self.unit,
                     employment_type=kind, join_date="2020-01-01", status="inactive")
            for i in range(exits)
        ]  # fmt: skip
        Employee.objects.bulk_create(people + gone)
        ResignationRequest.objects.bulk_create(
            [
                ResignationRequest(
                    employee=Employee.objects.get(employee_code=f"{tag}x{i}"), status="approved",
                    last_working_date=date(2026, 9, 1 + i),
                )
                for i in range(exits)
            ]
        )  # fmt: skip

    def ids(self, **params) -> dict:
        items = self.get("/api/md/employees/insights", month="2026-09", **params).json()["items"]
        return {i["id"]: i for i in items}

    def test_a_workforce_that_shrinks_by_five_and_three_percent_is_flagged(self):
        self.crew(100, 6, "A")  # 106 -> 100: -6, 5.7%
        found = self.ids()["employees.headcount-falling"]
        self.assertEqual(found["title"], "Headcount fell by 6 to 100 in Sep 2026")
        self.assertEqual((found["severity"], found["metric"]), ("warning", "-6"))
        self.assertEqual(found["detail"], "0 joined and 6 left, from 106 at the start.")

    def test_fewer_than_five_fewer_people_is_not_a_fall_however_big_the_share(self):
        self.crew(20, 4, "B")  # 24 -> 20: 16.7% but only 4 people
        self.assertNotIn("employees.headcount-falling", self.ids())

    def test_five_fewer_people_under_three_percent_is_not_a_fall(self):
        self.crew(200, 5, "C")  # 205 -> 200: 2.4%
        self.assertNotIn("employees.headcount-falling", self.ids())

    def test_attrition_that_rose_needs_five_leavers_and_two_points(self):
        self.crew(100, 5, "D")  # September: 5 / 102.5 = 4.9%; August: nobody left
        self.assertIn("employees.attrition-rising", self.ids())
        Employee.objects.all().delete()
        self.crew(100, 4, "E")  # four leavers: not enough people to call it a trend
        self.assertNotIn("employees.attrition-rising", self.ids())

    def test_a_small_gap_is_information_and_a_big_one_is_a_warning(self):
        dept = Department.objects.create(name="Plan", branch=self.unit)
        DepartmentHeadcount.objects.create(department=dept, required_count=10)
        for i in range(9):
            Employee.objects.create(employee_code=f"P{i}", first_name="P", last_name=str(i), department=dept, branch=self.unit,
                                    employment_type="staff", join_date="2020-01-01")  # fmt: skip
        gap = self.ids(department="Plan")["employees.staffing-gap"]
        self.assertEqual((gap["title"], gap["severity"]), ("Plan has 9 staff against 10 planned", "info"))  # 90% filled
        Employee.objects.filter(employee_code__in=["P0", "P1"]).update(status="inactive")
        gap = self.ids(department="Plan")["employees.staffing-gap"]
        self.assertEqual((gap["title"], gap["severity"]), ("Plan has 7 staff against 10 planned", "warning"))  # 70%
        Employee.objects.create(employee_code="PX", first_name="P", last_name="X", department=dept, branch=self.unit,
                                employment_type="staff", join_date="2020-01-01")  # fmt: skip
        Employee.objects.create(employee_code="PY", first_name="P", last_name="Y", department=dept, branch=self.unit,
                                employment_type="staff", join_date="2020-01-01")  # fmt: skip
        Employee.objects.create(employee_code="PZ", first_name="P", last_name="Z", department=dept, branch=self.unit,
                                employment_type="staff", join_date="2020-01-01")  # fmt: skip
        self.assertNotIn("employees.staffing-gap", self.ids(department="Plan"))  # 7 + 3 = 10 of 10: the plan is met

    def test_a_clean_up_of_inactive_records_is_named_for_what_it_is(self):
        self.crew(20, 0, "G")
        stamp = at(2026, 9, 14, 12)
        for i in range(6):  # six people deactivated by hand on 14 Sep: no resignation, so the date is the edit date
            e = Employee.objects.create(employee_code=f"Gx{i}", first_name="G", last_name=f"x{i}", department=self.dept, branch=self.unit,
                                        join_date="2020-01-01", status="inactive")  # fmt: skip
            Employee.objects.filter(pk=e.pk).update(updated_at=stamp)
        found = self.ids()["employees.bulk-deactivation"]
        self.assertEqual(found["title"], "6 people were switched to inactive on 14 Sep with no resignation")
        self.assertEqual((found["severity"], found["metric"]), ("warning", "6"))  # all 6 leavers of the month: 100%
        self.assertIn("That is 100% of the 6 leavers in Sep 2026.", found["detail"])
        # five is the least that counts as a clean-up; four is just four people
        Employee.objects.filter(employee_code="Gx0").delete()
        self.assertIn("employees.bulk-deactivation", self.ids())
        Employee.objects.filter(employee_code="Gx1").delete()
        self.assertNotIn("employees.bulk-deactivation", self.ids())

    def test_exits_with_a_resignation_are_never_called_a_clean_up(self):
        self.crew(20, 6, "H")  # six resignations, a different last working day each
        self.assertNotIn("employees.bulk-deactivation", self.ids())

    def test_a_team_below_the_minimum_is_not_a_hot_spot_however_bad(self):
        small = Department.objects.create(name="Tiny", branch=self.unit)
        for i in range(2):  # 2 stay, 4 leave: a 133% rate in a team of four on average
            Employee.objects.create(
                employee_code=f"T{i}",
                first_name="T",
                last_name=str(i),
                department=small,
                branch=self.unit,
                join_date="2020-01-01",
            )
        for i in range(4):
            e = Employee.objects.create(employee_code=f"Tx{i}", first_name="T", last_name=f"x{i}", department=small, branch=self.unit,
                                        join_date="2020-01-01", status="inactive")  # fmt: skip
            ResignationRequest.objects.create(employee=e, status="approved", last_working_date=date(2026, 9, 2 + i))
        self.crew(100, 1, "F")  # the rest of the company barely moves
        self.assertFalse(any(k.startswith("employees.attrition-hotspot") for k in self.ids()))


class ExitDateTimeZoneTests(MdApiTestCase):
    """Stored times are UTC; the factory's day is the Tirupur one. 19:00 UTC on 30 Sep is 00:30 on 1 Oct in Tirupur."""

    def setUp(self):
        super().setUp()
        self.enterContext(frozen())
        unit = Branch.objects.create(name="Unit1")
        dept = Department.objects.create(name="Cutting", branch=unit)
        Employee.objects.create(
            employee_code="B", first_name="Stays", last_name="On", department=dept, branch=unit, join_date="2020-01-01"
        )
        self.gone = Employee.objects.create(
            employee_code="G", first_name="Gone", last_name="Soon", department=dept, branch=unit, join_date="2020-01-01", status="inactive"
        )  # fmt: skip

    def leavers(self, **params) -> int:
        return self.get("/api/md/employees/summary", **params).json()["leavers"]["count"]

    def test_a_deactivation_just_after_midnight_in_the_factory_falls_on_the_factory_day(self):
        Employee.objects.filter(pk=self.gone.pk).update(updated_at=datetime(2026, 9, 30, 19, 0, tzinfo=UTC))
        self.assertEqual(self.leavers(month="2026-09"), 0)
        self.assertEqual(self.leavers(month="2026-10"), 1)
        row = next(
            r for r in self.get("/api/md/employees/directory", status="inactive").json()["rows"] if r["code"] == "G"
        )
        self.assertEqual(row["leftOn"], "2026-10-01")

    def test_an_approval_time_is_read_in_the_factory_day_too(self):
        ResignationRequest.objects.create(
            employee=self.gone, status="approved", approved_at=datetime(2026, 9, 30, 19, 0, tzinfo=UTC)
        )
        self.assertEqual((self.leavers(month="2026-09"), self.leavers(month="2026-10")), (0, 1))

    def test_a_last_working_date_is_a_calendar_date_and_is_not_shifted(self):
        ResignationRequest.objects.create(
            employee=self.gone,
            status="approved",
            last_working_date=date(2026, 9, 30),
            approved_at=datetime(2026, 9, 30, 19, 0, tzinfo=UTC),
        )
        self.assertEqual((self.leavers(month="2026-09"), self.leavers(month="2026-10")), (1, 0))


# ─── the assistant's tools ───────────────────────────────────────────────────────────────────────────────────


class ToolTests(EmployeesTestCase):
    def tool(self, name: str):
        return registry.collect_tools()[name]

    def test_the_module_offers_seven_documented_tools(self):
        names = [t.name for t in E.TOOLS]
        self.assertEqual(names, [
            "workforce_headcount", "workforce_composition", "workforce_movement", "workforce_attrition",
            "workforce_milestones", "workforce_find_employees", "workforce_employee_profile",
        ])  # fmt: skip
        for spec in E.TOOLS:
            self.assertEqual(spec.page, "employees")
            self.assertGreaterEqual(len(spec.description), 120, spec.name)
        named = {
            "workforce_attrition",
            "workforce_milestones",
            "workforce_find_employees",
            "workforce_employee_profile",
        }
        for spec in E.TOOLS:  # the tools whose answers carry people's names say so for the privacy layer
            self.assertEqual("name" in spec.person_fields, spec.name in named, spec.name)
        registry.clear_cache()
        self.assertTrue(set(names) <= set(registry.collect_tools()))

    def test_headcount_tool_quotes_the_page_number(self):
        with frozen():
            result = self.tool("workforce_headcount").run({"month": "2026-09"})
        page = self.get_ok("/api/md/employees/summary", month="2026-09")
        self.assertEqual(result["attrition"], page["attrition"])
        self.assertEqual(result["headcount"], page["headcount"])
        self.assertTrue(result["provenance"])

    def test_the_tools_take_period_and_scope(self):
        with frozen():
            unit2 = self.tool("workforce_headcount").run({"month": "2026-09", "branch": "Unit2"})
            composition = self.tool("workforce_composition").run({"department": "Accounts", "limit": 3})
            movement = self.tool("workforce_movement").run({"from": "2026-05-01", "to": "2026-09-30"})
            attrition = self.tool("workforce_attrition").run({"month": "2026-09", "limit": "1"})
        self.assertEqual(unit2["headcount"]["current"], 3)
        self.assertEqual(composition["total"], 2)
        self.assertEqual([p["headcount"] for p in movement["points"]], [9, 10, 11, 12, 9])
        self.assertEqual(len(attrition["early"]["items"]), 1)  # limit "1" arrives as text and is coerced
        for bad in ({"period": "fortnight"}, {"type": "contract"}):
            with frozen(), self.assertRaises(C.MdParamError):
                self.tool("workforce_headcount").run(bad)

    def test_default_period_of_the_tools_is_the_last_12_months(self):
        with frozen():
            result = self.tool("workforce_movement").run({})
        self.assertEqual(result["period"]["preset"], "last_12_months")

    def test_find_employees_returns_at_most_ten_and_never_pay(self):
        for i in range(12):
            Employee.objects.create(employee_code=f"Z{i:02d}", first_name="Zed", last_name=str(i), department=self.acc, branch=self.u1,
                                    designation=self.d_accountant, salary_amount=50000)  # fmt: skip
        with frozen():
            result = self.tool("workforce_find_employees").run({"query": "zed", "limit": 50})
            exact = self.tool("workforce_find_employees").run({"query": "Z03"})
            inactive = self.tool("workforce_find_employees").run({"status": "inactive", "department": "Cutting"})
        self.assertEqual((result["total"], len(result["rows"])), (12, 10))
        self.assertEqual([r["code"] for r in exact["rows"]], ["Z03"])
        self.assertEqual(sorted(r["code"] for r in inactive["rows"]), ["L4", "L6"])
        self.assertNotIn("salary", json.dumps(result).lower())
        self.assertIn("name", self.tool("workforce_find_employees").person_fields)

    def test_profile_by_code_or_id_and_not_found(self):
        with frozen():
            by_code = self.tool("workforce_employee_profile").run({"code": "a1"})
            by_id = self.tool("workforce_employee_profile").run({"id": self.a1.id})
            missing = self.tool("workforce_employee_profile").run({"code": "NOBODY"})
            neither = self.tool("workforce_employee_profile").run({})
        self.assertEqual(by_code["profile"], by_id["profile"])
        self.assertEqual(by_code["profile"]["name"], "Anita Raman")
        self.assertFalse(missing["found"])
        self.assertFalse(neither["found"])
        self.assertTrue(missing["provenance"])  # every tool answer can be explained

    def test_the_assistant_gets_the_reason_group_not_the_words(self):
        with frozen():
            profile = self.tool("workforce_employee_profile").run({"code": "L1"})["profile"]
        self.assertEqual(profile["leavingReason"], "Better pay or opportunity")
        self.assertIsNone(profile["leavingReasonText"])

    def test_the_assistant_is_never_given_anything_drawn_from_a_date_of_birth(self):
        with frozen():
            milestones = self.tool("workforce_milestones").run({})
            profile = self.tool("workforce_employee_profile").run({"code": "A1"})["profile"]
            page_profile = E.employee_profile(employee_id=self.a1.id, today=TODAY)["profile"]
        self.assertEqual(
            (milestones["birthdays"]["total"], milestones["birthdays"]["items"]), (2, [])
        )  # counted, not listed
        self.assertTrue(milestones["birthdays"]["namesWithheld"])
        self.assertEqual(milestones["anniversaries"]["total"], 2)  # the rest is unchanged
        self.assertIsNone(profile["ageBand"])
        self.assertEqual(page_profile["ageBand"], "36-45")  # the MD's own page still shows it
        self.assertEqual(self.get_ok("/api/md/employees/milestones")["birthdays"]["items"][0]["code"], "A4")
        self.assertIn(
            "reportsTo", self.tool("workforce_employee_profile").person_fields
        )  # a name outside the standard keys

    def test_milestone_tool_limits_the_list(self):
        with frozen():
            result = self.tool("workforce_milestones").run({"days": 30, "limit": 1})
        self.assertEqual((result["anniversaries"]["total"], len(result["anniversaries"]["items"])), (2, 1))

    def test_every_tool_result_is_plain_json_and_small(self):
        with frozen():
            for spec in E.TOOLS:
                text = json.dumps(spec.run(dict(spec.example)))
                self.assertLess(len(text), 60_000, spec.name)


# ─── who may call it, and that it never writes ───────────────────────────────────────────────────────────────

ROUTES = (
    "summary", "composition", "movement", "attrition", "milestones", "insights", "directory", "employee/1",
)  # fmt: skip


class AccessTests(TestCase):
    def setUp(self):
        self.md = HRUser.objects.create(username="md", password_hash="x", is_md=True)
        self.admin = HRUser.objects.create(username="root", password_hash="x", is_super_admin=True)
        self.clerk = HRUser.objects.create(username="clerk", password_hash="x")
        self.enterContext(frozen())

    def call(self, path, user=None, method="get"):
        extra = md_headers(user) if user else {}
        return getattr(self.client, method)(f"/api/md/employees/{path}", **extra)

    def test_nobody_but_the_md_gets_anything(self):
        for path in ROUTES:
            self.assertEqual(self.call(path, self.admin).status_code, 403, f"{path} as a super admin")
            self.assertEqual(self.call(path, self.clerk).status_code, 403, f"{path} as an HR user")
            self.assertEqual(self.call(path).status_code, 401, f"{path} signed out")

    def test_the_md_reaches_every_route(self):
        Employee.objects.create(employee_code="E1", first_name="One", last_name="Person")
        employee_id = Employee.objects.get(employee_code="E1").id
        for path in ROUTES:
            path = path.replace("employee/1", f"employee/{employee_id}")
            self.assertEqual(self.call(path, self.md).status_code, 200, path)

    def test_only_get_is_allowed(self):
        for path in ROUTES:
            for method in ("post", "put", "patch", "delete"):
                self.assertEqual(self.call(path, self.md, method).status_code, 405, f"{method} {path}")

    def test_no_route_writes_a_thing(self):
        """Every view runs inside the read-only database guard, so a write would raise: all routes answer 200 on data."""
        build_company(type("Holder", (), {}))  # the company, on a throwaway holder
        counts = {
            m: m.objects.count()
            for m in (Employee, Branch, Department, ResignationRequest, DepartmentHeadcount, HRUser)
        }
        for path in ROUTES:
            path = path.replace("employee/1", f"employee/{Employee.objects.first().id}")
            self.assertEqual(self.call(path, self.md).status_code, 200, path)
        self.assertEqual(counts, {m: m.objects.count() for m in counts})

    def test_the_url_table_has_exactly_the_routes_documented(self):
        from .md_portal.routes import employees as routes

        self.assertEqual(
            sorted(str(p.pattern) for p in routes.urlpatterns),
            sorted(
                [
                    "summary",
                    "composition",
                    "movement",
                    "attrition",
                    "milestones",
                    "insights",
                    "directory",
                    "employee/<int:employee_id>",
                ]
            ),
        )


# ─── fast: the number of queries does not grow with the number of people ─────────────────────────────────────


def populate(n: int, tag: str) -> None:
    """n active people and n/2 leavers across three departments (bulk, so the fixture itself is fast)."""
    unit = Branch.objects.create(name=f"U-{tag}")
    depts = [Department.objects.create(name=f"D{i}-{tag}", branch=unit) for i in range(3)]
    desigs = [Designation.objects.create(title=f"T{i}-{tag}", department=depts[i]) for i in range(3)]
    people = [
        Employee(
            employee_code=f"{tag}{i}", first_name=f"Name{i}", last_name=tag, department=depts[i % 3], branch=unit,
            designation=desigs[i % 3], employment_type="production" if i % 2 else "staff",
            gender="female" if i % 3 else "male", date_of_birth=date(1980 + i % 20, 1 + i % 12, 1 + i % 28),
            join_date=f"20{15 + i % 11}-{1 + i % 12:02d}-{1 + i % 28:02d}",
            probation_end_date=date(2026, 10, 1 + i % 28) if i % 5 == 0 else None,
        )
        for i in range(n)
    ]  # fmt: skip
    gone = [
        Employee(
            employee_code=f"{tag}x{i}", first_name=f"Gone{i}", last_name=tag, department=depts[i % 3], branch=unit,
            employment_type="production", join_date="2024-01-01", status="inactive",
        )
        for i in range(n // 2)
    ]  # fmt: skip
    Employee.objects.bulk_create(people + gone)
    ResignationRequest.objects.bulk_create(
        [
            ResignationRequest(
                employee=e, status="approved", last_working_date=date(2026, 9, 1 + i % 28), reason="better pay"
            )
            for i, e in enumerate(Employee.objects.filter(employee_code__startswith=f"{tag}x"))
        ]
    )
    for d in depts:
        DepartmentHeadcount.objects.create(department=d, required_count=n)


class QueryCountTests(MdApiTestCase):
    """Compare a small company with one six times larger: the endpoints must ask the database the same questions."""

    def setUp(self):
        super().setUp()
        self.enterContext(frozen())

    def queries(self, path: str, **params) -> int:
        with CaptureQueriesContext(connection) as ctx:
            r = self.get(path, **params)
        self.assertEqual(r.status_code, 200, f"{path}: {r.content[:300]}")
        return len(ctx)

    def test_the_heavy_endpoints_do_not_query_per_person(self):
        populate(10, "a")
        paths = {
            "summary": {"period": "last_12_months"},
            "composition": {},
            "movement": {"period": "last_12_months"},
            "attrition": {"period": "last_90_days"},
            "milestones": {},
            "insights": {"period": "last_90_days"},
            "directory": {"status": "all", "pageSize": 100},
        }
        small = {p: self.queries(f"/api/md/employees/{p}", **q) for p, q in paths.items()}
        populate(60, "b")
        large = {p: self.queries(f"/api/md/employees/{p}", **q) for p, q in paths.items()}
        self.assertEqual(small, large)
        for path, n in large.items():
            self.assertLessEqual(n, 16, f"{path} asks the database {n} times")  # a small fixed number

    def test_the_profile_does_not_query_per_record(self):
        populate(5, "p")
        emp = Employee.objects.filter(employee_code="p1").first()
        AttendanceDayRecord.objects.bulk_create(
            [
                AttendanceDayRecord(
                    employee=emp, date=date(2026, 9, 1 + i), status="absent" if i % 3 == 0 else "present"
                )
                for i in range(28)
            ]
        )
        few = self.queries(f"/api/md/employees/employee/{emp.id}")
        AttendanceDayRecord.objects.bulk_create(
            [
                AttendanceDayRecord(
                    employee=emp, date=date(2026, 8, 1 + i), status="absent" if i % 3 == 0 else "on_leave"
                )
                for i in range(28)
            ]
        )
        for i in range(10):
            Promotion.objects.create(employee=emp, effective_date=date(2020 + i // 3, 1 + i, 1))
            SalaryIncrement.objects.create(
                employee=emp, previous_salary=100, new_salary=110, percent=10, effective_date=date(2020, 1 + i, 1)
            )
        many = self.queries(f"/api/md/employees/employee/{emp.id}")
        self.assertEqual(few, many)
        self.assertLessEqual(many, 18)  # sign-in, the person, 3 lookups, history, leave, documents, attendance + roster

    def test_250_people_answer_quickly(self):
        populate(250, "q")
        for path, params in (
            ("summary", {"period": "last_12_months"}),
            ("composition", {}),
            ("movement", {"period": "last_12_months"}),
            ("attrition", {"period": "last_12_months"}),
            ("directory", {"status": "all"}),
            ("insights", {"period": "last_12_months"}),
            ("milestones", {}),
        ):
            started = time.monotonic()
            self.assertEqual(self.get(f"/api/md/employees/{path}", **params).status_code, 200)
            self.assertLess(
                time.monotonic() - started, 3.0, path
            )  # the target is 1.5 s; the margin is for a busy machine


class DirectCallTests(EmployeesTestCase):
    """The analytics are plain functions: callable without HTTP, with today passed in."""

    def test_summary_without_http(self):
        body = E.summary(EVERYONE, period(month="2026-09"), today=TODAY)
        self.assertEqual(body["joiners"]["count"], 2)
        self.assertEqual(
            set(body) & {"generatedAt", "period", "scope", "provenance", "notes"},
            {"generatedAt", "period", "scope", "provenance", "notes"},
        )

    def test_a_scope_object_works_the_same_as_the_query_string(self):
        scope = C.resolve_scope({"branch": "Unit2"})
        self.assertEqual(E.composition(scope, today=TODAY)["total"], 3)

    def test_rows_are_json_without_a_default_encoder(self):
        for body in (
            E.summary(EVERYONE, period(month="2026-09"), today=TODAY),
            E.composition(EVERYONE, today=TODAY),
            E.movement(EVERYONE, period(month="2026-09"), today=TODAY),
            E.attrition(EVERYONE, period(month="2026-09"), today=TODAY),
            E.milestones(EVERYONE, today=TODAY),
            E.directory(EVERYONE, today=TODAY),
            E.employee_profile(employee_id=self.a1.id, today=TODAY),
        ):
            json.dumps(body)

    def test_a_request_factory_view_call_is_read_only_too(self):
        from .md_portal.routes import employees as routes

        request = APIRequestFactory().get("/api/md/employees/summary", {"month": "2026-09"}, **md_headers(self.md))
        self.assertEqual(routes.summary(request).status_code, 200)

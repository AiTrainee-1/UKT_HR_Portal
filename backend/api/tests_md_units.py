"""MD portal: Branches (md_portal/analytics/units.py, routes/units.py).

Every figure asserted here is recomputed by hand from the world below, never copied from the output.

THE WORLD (September 2026). "Today" is Monday 14 Sep, 12:00. The period measured is the week Mon 7 .. Sun 13 Sep; the one
before it is Mon 31 Aug .. Sun 6 Sep. Production works Monday to Saturday (Sunday is a weekly off), so a letter string is
Monday..Saturday ("P" present, "p" present and late, "H" half day, "A" absent, a space = no record). Nobody is a staff
member with day records: staff only carry headcount, overtime and pay.

    Unit A   Stitching: A1, A2 (production), A4 (staff)   Cutting: A3 (production)   A5 production, LEFT on Thu 10 Sep
    Unit B   Finishing: B1, B2 (production), B3 (staff, joined Tue 8 Sep)
    Head Office (seeded by a migration) has nobody.   Everyone joined 2025-01-01 unless said.

    Week W (7..13 Sep)                     scheduled  present  half  absent  late
      A1 PPPPPP                                6         6      0      0      0
      A2 PpPAPP                                6         5      0      1      1
      A3 PAAPHP                                6         3      1      2      0
      A5 PPPP  (rows end with the exit)        4         4      0      0      0
      Unit A                                  22        18      1      3      1   attendance 18.5/22 = 84.1  absence 13.6  late 1/19 = 5.3
      B1 PPAAPP                                6         4      0      2      0
      B2 PAAAPA                                6         2      0      4      0
      Unit B                                  12         6      0      6      0   attendance 50.0  absence 50.0  late 0.0
      Company                                 34        24      1      9      1   attendance 24.5/34 = 72.1  absence 26.5  late 1/25 = 4.0

    Week P (31 Aug..6 Sep): A1 PPPPPP, A2 PPPPPP, A3 PPPPPA, A5 PPPPPP -> A 24 scheduled, 23 present, 1 absent (95.8, 4.2)
                            B1 PPPPPP, B2 PPAPPP -> B 12 scheduled, 11 present, 1 absent (91.7, 8.3); company 34/36 = 94.4, 5.6

    Overtime (W): A4 8 Sep 90 min, 9 Sep 60 min (+ a REJECTED 300 min on 11 Sep, left out) = 2.5 h; B3 10 Sep 120 min = 2.0 h.
                  P: A4 2 Sep 60 min = 1.0 h; B none.  Staff: A 1, B 1 -> per staff member A 2.5, B 2.0; company 4.5 / 2 = 2.25.
    Attrition, 12 months to 14 Sep 2026: A opens with 5, closes with 4 (A5 left), average 4.5, 1 leaver = 22.2 %; B opens 2,
        closes 3 (B3 joined), 0 leavers = 0.0 %; company 7 -> 7, 1 / 7.0 = 14.3 %.
    Tenure today (days / 365.25): A 4 people x 621 days -> 1.7 years; B (621 + 621 + 6) / 3 = 416 days -> 1.1; company 1.5.
    Pay (slips): Aug 2026 is the latest closed month. A5's slip is in it (she left in September).
        Aug  A1 20,000  A2 18,000  A3 16,000  A4 30,000 (+2,000 overtime)  A5 15,000 -> A 101,000 for 5 people (20,200 each)
             B1 14,000  B2 12,000                                           -> B 26,000 for 2 people (13,000 each)
             company 127,000 for 7 people = 18,142.86 each
        Jul  A 99,000 (5 people, 19,800 each), B 26,000 (2, 13,000): company 125,000, 17,857.14 each
"""

from contextlib import contextmanager
from datetime import date, datetime, time, timedelta
from unittest import mock

from django.db import connection
from django.test import SimpleTestCase
from django.test.utils import CaptureQueriesContext

from .md_portal.analytics import attendance as A
from .md_portal.analytics import employees as E
from .md_portal.analytics import payroll as P
from .md_portal.analytics import units as U
from .md_portal.assistant import registry
from .md_portal.common import MdParamError, Period, Scope, period_for_preset, read_only_db, resolve_period, resolve_scope
from .models import (
    AttendanceDayRecord,
    Branch,
    Department,
    Employee,
    HRUser,
    OvertimeRecord,
    ResignationRequest,
    SalarySlip,
)
from .tests_md_support import MdApiTestCase, md_headers

TODAY = date(2026, 9, 14)
W = {"from": "2026-09-07", "to": "2026-09-13"}
P_WEEK = {"from": "2026-08-31", "to": "2026-09-06"}
BASE = "/api/md/units"
ROUTES = ("summary", "rank", "trend", "profile", "attention")
_SERIAL = iter(range(1, 1_000_000))

STATUS = {"P": "present", "p": "present", "H": "half_shift", "A": "absent"}


@contextmanager
def at(day: date = TODAY, hour: int = 12):
    """Freeze the factory clock: today is ``day`` and it is ``hour`` o'clock."""
    now = datetime.combine(day, time(hour, 0))
    with (
        mock.patch.object(A, "ist_today", return_value=day),
        mock.patch.object(A, "ist_now", return_value=now),
        mock.patch.object(E, "ist_today", return_value=day),
        mock.patch.object(P, "_today", return_value=day),
        mock.patch.object(U, "ist_today", return_value=day),
        mock.patch("api.md_portal.common.ist_today", return_value=day),
        mock.patch("api.md_portal.common.ist_now", return_value=now),
    ):
        yield


def d(day: int, month: int = 9) -> date:
    return date(2026, month, day)


def mark(emp: Employee, start: date, codes: str) -> None:
    rows = [
        AttendanceDayRecord(
            employee=emp, date=start + timedelta(days=i), status=STATUS[ch], is_late=(ch == "p"), is_informed=None
        )
        for i, ch in enumerate(codes)
        if ch != " "
    ]
    AttendanceDayRecord.objects.bulk_create(rows)


def make_employee(code, dept, branch, kind="production", join="2025-01-01", status="active") -> Employee:
    return Employee.objects.create(
        employee_code=code,
        first_name=code,
        last_name="Test",
        department=dept,
        branch=branch,
        employment_type=kind,
        join_date=join,
        status=status,
    )


def slip(emp: Employee, year: int, month: int, gross: int, ot: int = 0) -> None:
    SalarySlip.objects.create(
        employee=emp,
        month=month,
        year=year,
        slip_number=f"U/{emp.employee_code}/{next(_SERIAL)}",
        gross_salary=gross,
        ot_amount=ot,
        net_salary=gross + ot,
    )


def overtime(emp: Employee, day: date, minutes: int, status: str = "detected") -> None:
    OvertimeRecord.objects.create(employee=emp, date=day, last_punch_out=time(19, 0), ot_minutes=minutes, status=status)


class World(MdApiTestCase):
    """The shared fixture (see the module docstring)."""

    @classmethod
    def setUpTestData(cls):
        cls.unit_a = Branch.objects.create(name="Unit A", code="UA")
        cls.unit_b = Branch.objects.create(name="Unit B", code="UB")
        cls.stitching = Department.objects.create(name="Stitching", branch=cls.unit_a)
        cls.cutting = Department.objects.create(name="Cutting", branch=cls.unit_a)
        cls.finishing = Department.objects.create(name="Finishing", branch=cls.unit_b)
        cls.a1 = make_employee("A1", cls.stitching, cls.unit_a)
        cls.a2 = make_employee("A2", cls.stitching, cls.unit_a)
        cls.a3 = make_employee("A3", cls.cutting, cls.unit_a)
        cls.a4 = make_employee("A4", cls.stitching, cls.unit_a, "staff")
        cls.a5 = make_employee("A5", cls.stitching, cls.unit_a, status="inactive")
        ResignationRequest.objects.create(employee=cls.a5, status="approved", last_working_date=d(10))
        cls.b1 = make_employee("B1", cls.finishing, cls.unit_b)
        cls.b2 = make_employee("B2", cls.finishing, cls.unit_b)
        cls.b3 = make_employee("B3", cls.finishing, cls.unit_b, "staff", join="2026-09-08")

        mark(cls.a1, d(7), "PPPPPP")
        mark(cls.a2, d(7), "PpPAPP")
        mark(cls.a3, d(7), "PAAPHP")
        mark(cls.a5, d(7), "PPPP")
        mark(cls.b1, d(7), "PPAAPP")
        mark(cls.b2, d(7), "PAAAPA")
        mark(cls.a1, d(31, 8), "PPPPPP")
        mark(cls.a2, d(31, 8), "PPPPPP")
        mark(cls.a3, d(31, 8), "PPPPPA")
        mark(cls.a5, d(31, 8), "PPPPPP")
        mark(cls.b1, d(31, 8), "PPPPPP")
        mark(cls.b2, d(31, 8), "PPAPPP")

        overtime(cls.a4, d(8), 90)
        overtime(cls.a4, d(9), 60)
        overtime(cls.a4, d(11), 300, "rejected")
        overtime(cls.b3, d(10), 120)
        overtime(cls.a4, d(2), 60)

        for month, with_ot in ((7, False), (8, True)):
            slip(cls.a1, 2026, month, 20000)
            slip(cls.a2, 2026, month, 18000)
            slip(cls.a3, 2026, month, 16000)
            slip(cls.a4, 2026, month, 30000, 2000 if with_ot else 0)
            slip(cls.a5, 2026, month, 15000)
            slip(cls.b1, 2026, month, 14000)
            slip(cls.b2, 2026, month, 12000)

    def api(self, route="summary", params=W, **extra):
        with at():
            r = self.get(f"{BASE}/{route}", **params, **extra)
        self.assertEqual(r.status_code, 200, r.content)
        return r.json()

    def summary(self, params=W, **extra):
        return self.api("summary", params, **extra)

    def rows(self, **kw):
        return {r["name"]: r for r in self.summary(**kw)["rows"]}


def v(row, metric):
    return row["metrics"][metric]["value"]


# ─── access ──────────────────────────────────────────────────────────────────────────────────────────────────────


class AccessTests(World):
    def test_only_the_md_gets_in(self):
        root = HRUser.objects.create(username="root", password_hash="x", is_super_admin=True)
        for route in ROUTES:
            url = f"{BASE}/{route}"
            with self.subTest(route=route):
                self.assertEqual(self.client.get(url).status_code, 401)
                self.assertEqual(self.client.get(url, **md_headers(root)).status_code, 403)
                self.assertEqual(self.get(url).status_code, 200)

    def test_the_views_are_read_only(self):
        for route in ROUTES:
            with self.subTest(route=route), at():
                self.assertEqual(self.client.post(f"{BASE}/{route}", {}, **md_headers(self.md)).status_code, 405)

    def test_the_analytics_run_inside_the_read_only_guard(self):
        with at(), read_only_db():
            U.units_summary(Scope(), resolve_period(W))
            U.units_trend(Scope(), resolve_period(W), "attendancePct")
            U.unit_profile(Scope(), resolve_period(W), "Unit A")
            U.units_attention(Scope(), resolve_period(W))


# ─── the summary: one row per unit, every figure recomputed by hand ──────────────────────────────────────────────


class SummaryTests(World):
    def test_a_row_per_unit_biggest_first_and_the_empty_head_office_left_out(self):
        body = self.summary()
        self.assertEqual([r["name"] for r in body["rows"]], ["Unit A", "Unit B"])
        self.assertEqual(body["unitCount"], 2)
        left_out = Branch.objects.exclude(name__in=["Unit A", "Unit B"]).count()
        self.assertGreaterEqual(left_out, 1)  # the Head Office that a migration seeds
        self.assertIn(f"{left_out} {'unit has' if left_out == 1 else 'units have'} no employees", " ".join(body["notes"]))
        self.assertEqual(body["period"]["label"], "07 Sep – 13 Sep 2026")
        self.assertEqual(body["measured"], {"start": "2026-09-07", "end": "2026-09-13", "days": 7})
        self.assertEqual(body["previous"], {"start": "2026-08-31", "end": "2026-09-06", "days": 7})

    def test_headcount_with_its_staff_and_production_split(self):
        rows = self.rows()
        self.assertEqual((rows["Unit A"]["headcount"], rows["Unit A"]["staff"], rows["Unit A"]["production"]), (4, 1, 3))
        self.assertEqual((rows["Unit B"]["headcount"], rows["Unit B"]["staff"], rows["Unit B"]["production"]), (3, 1, 2))
        a = rows["Unit A"]["metrics"]["headcount"]
        self.assertEqual((a["value"], a["reference"], a["sharePct"], a["rank"], a["of"]), (4, 7, 57.1, 1, 2))
        self.assertEqual(rows["Unit B"]["metrics"]["headcount"]["sharePct"], 42.9)
        self.assertEqual(self.summary()["company"]["headcount"], 7)

    def test_attendance_absenteeism_and_lateness_are_the_pooled_day_records(self):
        body, rows = self.summary(), self.rows()
        company = body["company"]["metrics"]
        self.assertEqual((company["attendancePct"], company["absenteeismPct"], company["latePct"]), (72.1, 26.5, 4.0))
        self.assertEqual((v(rows["Unit A"], "attendancePct"), v(rows["Unit A"], "absenteeismPct")), (84.1, 13.6))
        self.assertEqual(v(rows["Unit A"], "latePct"), 5.3)
        self.assertEqual((v(rows["Unit B"], "attendancePct"), v(rows["Unit B"], "absenteeismPct")), (50.0, 50.0))
        self.assertEqual(v(rows["Unit B"], "latePct"), 0.0)  # worked days, none late: a real 0, not "no data"

    def test_the_difference_from_the_company_the_rank_and_the_verdict(self):
        rows = self.rows()
        a, b = rows["Unit A"]["metrics"], rows["Unit B"]["metrics"]
        self.assertEqual((a["attendancePct"]["diff"], a["attendancePct"]["rank"], a["attendancePct"]["verdict"]), (12.0, 1, "better"))
        self.assertEqual((b["attendancePct"]["diff"], b["attendancePct"]["rank"], b["attendancePct"]["verdict"]), (-22.1, 2, "worse"))
        # a LOW figure is the good one for absenteeism and lateness: rank 1 is the lowest
        self.assertEqual((a["absenteeismPct"]["rank"], b["absenteeismPct"]["rank"]), (1, 2))
        self.assertEqual((a["latePct"]["rank"], b["latePct"]["rank"]), (2, 1))
        self.assertEqual((a["latePct"]["diff"], a["latePct"]["verdict"]), (1.3, "worse"))
        self.assertEqual((b["latePct"]["diff"], b["latePct"]["verdict"]), (-4.0, "better"))
        self.assertEqual(a["attendancePct"]["reference"], 72.1)

    def test_the_change_against_the_previous_period(self):
        rows = self.rows()
        a, b = rows["Unit A"]["metrics"], rows["Unit B"]["metrics"]
        self.assertEqual((a["attendancePct"]["previous"], a["attendancePct"]["delta"]), (95.8, -11.7))
        self.assertEqual((b["attendancePct"]["previous"], b["attendancePct"]["delta"]), (91.7, -41.7))
        self.assertEqual((a["absenteeismPct"]["previous"], a["absenteeismPct"]["delta"]), (4.2, 9.4))
        self.assertEqual((a["latePct"]["previous"], a["latePct"]["delta"]), (0.0, 5.3))
        company = self.summary()["company"]["previous"]
        self.assertEqual((company["attendancePct"], company["absenteeismPct"], company["overtimeHours"]), (94.4, 5.6, 1.0))

    def test_overtime_hours_leave_out_rejected_days_and_are_compared_per_staff_member(self):
        rows = self.rows()
        a, b = rows["Unit A"]["metrics"], rows["Unit B"]["metrics"]
        self.assertEqual((a["overtimeHours"]["value"], b["overtimeHours"]["value"]), (2.5, 2.0))
        self.assertEqual((a["overtimeHours"]["previous"], b["overtimeHours"]["previous"]), (1.0, 0.0))
        self.assertEqual((a["overtimeHours"]["sharePct"], b["overtimeHours"]["sharePct"]), (55.6, 44.4))
        self.assertEqual((a["overtimePerHead"]["value"], b["overtimePerHead"]["value"]), (2.5, 2.0))
        self.assertEqual(self.summary()["company"]["metrics"]["overtimePerHead"], 2.25)
        self.assertEqual((a["overtimePerHead"]["verdict"], b["overtimePerHead"]["verdict"]), ("worse", "better"))
        self.assertTrue(self.summary()["otTracked"])

    def test_movement_attrition_and_tenure(self):
        rows = self.rows()
        a, b = rows["Unit A"]["metrics"], rows["Unit B"]["metrics"]
        self.assertEqual((a["joiners"]["value"], b["joiners"]["value"]), (0, 1))
        self.assertEqual((a["leavers"]["value"], b["leavers"]["value"]), (1, 0))
        self.assertEqual((a["leavers"]["previous"], b["joiners"]["previous"]), (0, 0))
        self.assertEqual((a["attritionPct"]["value"], b["attritionPct"]["value"]), (22.2, 0.0))
        self.assertEqual((a["attritionPct"]["rank"], b["attritionPct"]["rank"]), (2, 1))
        self.assertEqual((a["avgTenureYears"]["value"], b["avgTenureYears"]["value"]), (1.7, 1.1))
        company = self.summary()["company"]["metrics"]
        self.assertEqual((company["attritionPct"], company["avgTenureYears"], company["joiners"], company["leavers"]), (14.3, 1.5, 1, 1))
        self.assertEqual((a["avgTenureYears"]["diff"], a["avgTenureYears"]["diffPct"]), (0.2, 13.3))
        self.assertEqual(self.summary()["attrition"]["label"], "Last 12 months")

    def test_payroll_is_the_latest_closed_month_from_the_salary_slips(self):
        body, rows = self.summary(), self.rows()
        self.assertEqual(body["payrollMonth"]["key"], "2026-08")
        self.assertEqual(body["payrollMonth"]["label"], "Aug 2026")
        a, b = rows["Unit A"]["metrics"], rows["Unit B"]["metrics"]
        self.assertEqual((a["payrollCost"]["value"], b["payrollCost"]["value"]), (101000.0, 26000.0))
        self.assertEqual((a["payrollCost"]["previous"], b["payrollCost"]["previous"]), (99000.0, 26000.0))
        self.assertEqual((a["costPerHead"]["value"], b["costPerHead"]["value"]), (20200.0, 13000.0))
        company = body["company"]["metrics"]
        self.assertEqual((company["payrollCost"], company["costPerHead"]), (127000.0, 18142.86))
        self.assertEqual((a["costPerHead"]["diff"], a["costPerHead"]["diffPct"]), (2057.14, 11.3))
        self.assertIsNone(a["costPerHead"]["verdict"])  # whether a higher cost per person is bad is not for us to say
        self.assertEqual(a["payrollCost"]["sharePct"], 79.5)

    def test_the_metric_definitions_travel_with_the_answer(self):
        defs = {m["id"]: m for m in self.summary()["metrics"]}
        self.assertEqual(list(defs), list(U.METRIC_IDS))
        self.assertEqual((defs["attendancePct"]["good"], defs["attendancePct"]["rankBy"], defs["attendancePct"]["format"]), ("up", "best", "pct"))
        self.assertEqual((defs["absenteeismPct"]["good"], defs["absenteeismPct"]["rankBy"]), ("down", "best"))
        self.assertEqual((defs["headcount"]["kind"], defs["headcount"]["rankBy"], defs["headcount"]["good"]), ("total", "largest", None))
        self.assertEqual(defs["payrollCost"]["format"], "inr_compact")

    def test_the_best_and_weakest_unit_on_every_figure(self):
        leaders = self.summary()["leaders"]
        self.assertEqual(leaders["attendancePct"]["best"], {"id": self.unit_a.id, "name": "Unit A", "value": 84.1})
        self.assertEqual(leaders["attendancePct"]["worst"]["name"], "Unit B")
        self.assertEqual((leaders["latePct"]["best"]["name"], leaders["latePct"]["worst"]["name"]), ("Unit B", "Unit A"))

    def test_the_plain_english_summary_is_written_from_the_numbers(self):
        sentences = {s["id"]: s for s in self.summary()["briefing"]["sentences"]}
        self.assertEqual(
            sentences["units"]["text"], "The company has 2 units and 7 active people; Unit A is the largest with 4 (57%)."
        )
        self.assertEqual(
            sentences["attendance"]["text"],
            "Attendance (07 Sep – 13 Sep 2026) was 72.1%: Unit A led at 84.1% and Unit B trailed at 50.0%, 22.1 points below the company figure.",
        )
        self.assertEqual(sentences["attendance"]["tone"], "neutral")  # Unit B has 3 people: too small to call out (see the rule)
        self.assertEqual(
            sentences["absence"]["text"], "Unit B has the highest absenteeism at 50.0%, against 26.5% for the company."
        )
        self.assertEqual(
            sentences["overtime"]["text"], "Unit A worked the most overtime: 2.5 hours, 55.6% of the company's 4.5."
        )
        self.assertEqual(
            sentences["attrition"]["text"], "Over the last 12 months Unit A lost 22.2% of its people, against 14.3% for the company."
        )
        self.assertEqual(
            sentences["payroll"]["text"], "In Aug 2026, Unit A cost the most per person, ₹20,200 against ₹18,143 for the company."
        )
        self.assertEqual((sentences["attendance"]["page"], sentences["attrition"]["page"], sentences["payroll"]["page"]), ("attendance", "employees", "payroll"))
        self.assertIn("Compare our units", self.summary()["briefing"]["ask"])

    def test_every_figure_says_how_it_is_made(self):
        ids = {p["id"] for p in self.summary()["provenance"]}
        self.assertTrue(
            {"units-comparison", "attendance-pct", "absenteeism-pct", "late-pct", "overtime-hours", "unit-headcount", "unit-attrition", "unit-payroll"}
            <= ids
        )

    def test_the_summary_is_json_plain(self):
        import json

        json.dumps(self.summary())


# ─── the same number means the same thing on every page ──────────────────────────────────────────────────────────


class SharedDefinitionTests(World):
    def test_a_unit_figure_equals_the_figure_the_other_pages_give_for_that_unit(self):
        rows = self.rows()
        period = resolve_period(W)
        with at():
            company_att = A.attendance_summary(Scope(), period)["metrics"]
            att_units = {u["name"]: u for u in A.attendance_by_department(Scope(), period)["units"]}
            one_unit = A.attendance_summary(resolve_scope({"branch": "Unit B"}), period)["metrics"]
            attrition = {r["label"]: r for r in E.attrition(Scope(), period_for_preset("last_12_months", TODAY), today=TODAY)["byUnit"]}
            pay_units = {u["name"]: u for u in P.payroll_departments(Scope(), None)["units"]}
            headcount = E.summary(Scope(), period, today=TODAY)["headcount"]["current"]
        company = self.summary()["company"]["metrics"]
        self.assertEqual(company["attendancePct"], company_att["attendancePct"]["value"])
        self.assertEqual(company["absenteeismPct"], company_att["absenteeismPct"]["value"])
        self.assertEqual(company["latePct"], company_att["latePct"]["value"])
        self.assertEqual(company["overtimeHours"], company_att["overtimeHours"]["value"])
        self.assertEqual(self.summary()["company"]["headcount"], headcount)
        for name in ("Unit A", "Unit B"):
            self.assertEqual(v(rows[name], "attendancePct"), att_units[name]["attendancePct"])
            self.assertEqual(v(rows[name], "absenteeismPct"), att_units[name]["absenteeismPct"])
            self.assertEqual(v(rows[name], "latePct"), att_units[name]["latePct"])
            self.assertEqual(v(rows[name], "overtimeHours"), att_units[name]["overtimeHours"])
            self.assertEqual(v(rows[name], "attritionPct"), attrition[name]["attritionPct"])
            self.assertEqual(v(rows[name], "payrollCost"), pay_units[name]["grossPay"])
            self.assertEqual(v(rows[name], "costPerHead"), pay_units[name]["costPerHead"])
        # and the unit filter gives the same answer as the unit's row: it is the whole company of that selection
        self.assertEqual(v(rows["Unit B"], "attendancePct"), one_unit["attendancePct"]["value"])


# ─── scope ───────────────────────────────────────────────────────────────────────────────────────────────────────


class ScopeTests(World):
    def test_a_unit_filter_leaves_that_unit_and_it_is_the_company(self):
        body = self.summary(branch="Unit B")
        self.assertEqual([r["name"] for r in body["rows"]], ["Unit B"])
        self.assertEqual(body["scope"]["branchIds"], [self.unit_b.id])
        row = body["rows"][0]["metrics"]
        self.assertEqual(row["attendancePct"]["value"], 50.0)
        self.assertEqual(row["attendancePct"]["reference"], 50.0)
        self.assertEqual((row["attendancePct"]["diff"], row["attendancePct"]["rank"], row["attendancePct"]["of"]), (0.0, 1, 1))
        self.assertEqual(row["headcount"]["sharePct"], 100.0)

    def test_a_small_typo_in_the_unit_name_is_forgiven_and_said(self):
        body = self.summary(branch="unit b")
        self.assertEqual([r["name"] for r in body["rows"]], ["Unit B"])
        self.assertFalse([n for n in body["notes"] if n.startswith("Matched")])  # an exact match (ignoring case) says nothing
        body = self.summary(branch="Unti B")
        self.assertEqual([r["name"] for r in body["rows"]], ["Unit B"])
        self.assertIn("Matched unit 'Unti B' to 'Unit B'.", body["notes"])

    def test_an_unknown_unit_is_a_readable_400(self):
        with at():
            r = self.get(f"{BASE}/summary", branch="Nowhere", **W)
        self.assertEqual(r.status_code, 400)
        self.assertIn("No unit called 'Nowhere'", r.json()["error"])

    def test_a_department_filter_follows_the_department_in_every_unit(self):
        body = self.summary(department="Stitching")
        self.assertEqual([r["name"] for r in body["rows"]], ["Unit A"])  # only Unit A has a Stitching
        # Stitching: A1 6/6, A2 5/6, A5 4/4 -> 15 present of 16 scheduled
        self.assertEqual(v(body["rows"][0], "attendancePct"), 93.8)
        self.assertEqual(body["rows"][0]["headcount"], 3)  # A1, A2, A4 (A5 has left)

    def test_a_type_filter_compares_staff_or_production_only(self):
        production = self.summary(type="production")
        self.assertEqual({r["name"]: r["headcount"] for r in production["rows"]}, {"Unit A": 3, "Unit B": 2})
        self.assertEqual(production["company"]["metrics"]["attendancePct"], 72.1)  # the day records are all production
        staff = self.summary(type="staff")
        self.assertEqual({r["name"]: r["headcount"] for r in staff["rows"]}, {"Unit A": 1, "Unit B": 1})
        self.assertIsNone(staff["company"]["metrics"]["attendancePct"])  # no staff day records exist: "no data", never 0
        self.assertIsNone(staff["rows"][0]["metrics"]["attendancePct"]["value"])
        self.assertIsNone(staff["rows"][0]["metrics"]["attendancePct"]["rank"])
        self.assertEqual(staff["company"]["metrics"]["overtimeHours"], 4.5)

    def test_people_with_no_unit_are_a_row_of_their_own_so_the_company_adds_up(self):
        n1 = make_employee("N1", None, None)
        mark(n1, d(7), "PPPPP ")
        body = self.summary()
        rows = {r["name"]: r for r in body["rows"]}
        self.assertEqual(set(rows), {"Unit A", "Unit B", "No unit"})
        self.assertIsNone(rows["No unit"]["id"])
        self.assertEqual((rows["No unit"]["headcount"], v(rows["No unit"], "attendancePct")), (1, 100.0))
        self.assertEqual(body["company"]["headcount"], 8)
        self.assertEqual(body["company"]["metrics"]["attendancePct"], 75.6)  # (24.5 + 5) / (34 + 5)
        self.assertEqual(rows["No unit"]["metrics"]["payrollCost"]["value"], None)  # no slips: no data


# ─── periods ─────────────────────────────────────────────────────────────────────────────────────────────────────


class PeriodTests(World):
    def test_a_single_day_period_includes_both_ends(self):
        body = self.summary({"from": "2026-09-07", "to": "2026-09-07"})
        rows = {r["name"]: r for r in body["rows"]}
        # Monday 7 Sep: A1 A2 A3 A5 all present (4 of 4), B1 B2 present (2 of 2)
        self.assertEqual((v(rows["Unit A"], "attendancePct"), v(rows["Unit B"], "attendancePct")), (100.0, 100.0))
        self.assertEqual(body["company"]["metrics"]["attendancePct"], 100.0)
        self.assertEqual(body["previous"], {"start": "2026-09-06", "end": "2026-09-06", "days": 1})  # a Sunday: no records
        self.assertIsNone(rows["Unit A"]["metrics"]["attendancePct"]["previous"])

    def test_the_last_day_with_records_is_counted_and_the_day_before_the_first_is_not(self):
        body = self.summary({"from": "2026-09-08", "to": "2026-09-08"})  # Tuesday
        rows = {r["name"]: r for r in body["rows"]}
        self.assertEqual(v(rows["Unit A"], "attendancePct"), 75.0)  # A1 P, A2 p, A3 A, A5 P
        self.assertEqual(v(rows["Unit B"], "attendancePct"), 50.0)  # B1 P, B2 A
        self.assertEqual(v(rows["Unit A"], "latePct"), 25.0)  # one late of four worked

    def test_today_is_never_part_of_a_rate(self):
        body = self.summary({"from": "2026-09-13", "to": "2026-09-14"})  # Sunday + today (Monday)
        self.assertEqual(body["measured"], {"start": "2026-09-13", "end": "2026-09-13", "days": 1})
        self.assertIsNone(body["company"]["metrics"]["attendancePct"])  # a Sunday: nobody is scheduled
        body = self.summary(period="today")
        self.assertIsNone(body["measured"])
        self.assertIsNone(body["company"]["metrics"]["attendancePct"])
        self.assertIsNone(body["rows"][0]["metrics"]["overtimeHours"]["value"])  # nothing measured: not "0 hours"
        self.assertIn("still running", " ".join(body["notes"]))
        self.assertEqual(body["rows"][0]["headcount"], 4)  # headcount is today's: still there

    def test_a_period_that_has_not_started_counts_no_joiners_or_leavers(self):
        body = self.summary({"from": "2026-09-20", "to": "2026-09-26"})
        self.assertIsNone(body["rows"][0]["metrics"]["joiners"]["value"])
        self.assertIsNone(body["rows"][0]["metrics"]["leavers"]["value"])

    def test_leavers_and_joiners_belong_to_the_period_of_their_date(self):
        week_of_exit = self.rows(params={"from": "2026-09-10", "to": "2026-09-10"})  # A5's last working day
        self.assertEqual(week_of_exit["Unit A"]["metrics"]["leavers"]["value"], 1)
        day_after = self.rows(params={"from": "2026-09-11", "to": "2026-09-13"})
        self.assertEqual(day_after["Unit A"]["metrics"]["leavers"]["value"], 0)
        day_before = self.rows(params={"from": "2026-09-08", "to": "2026-09-09"})
        self.assertEqual(day_before["Unit B"]["metrics"]["joiners"]["value"], 1)  # B3 joined on the 8th, inclusive

    def test_a_long_period_has_no_previous_comparison_and_says_so(self):
        body = self.summary({"from": "2026-01-01", "to": "2026-09-13"})  # 256 days
        self.assertIsNone(body["previous"])
        self.assertIsNone(body["rows"][0]["metrics"]["attendancePct"]["previous"])
        self.assertIn("previous period is not shown", " ".join(body["notes"]))

    def test_a_bad_period_is_a_readable_400(self):
        with at():
            r = self.get(f"{BASE}/summary", period="fortnight")
        self.assertEqual(r.status_code, 400)
        self.assertIn("Unknown period", r.json()["error"])


# ─── ranking ─────────────────────────────────────────────────────────────────────────────────────────────────────


class RankingRules(SimpleTestCase):
    def test_equal_figures_share_a_rank_and_the_next_one_skips(self):
        att = U.METRIC_BY_ID["attendancePct"]
        self.assertEqual(U._ranks({1: 90.0, 2: 90.0, 3: 80.0}, att), {1: 1, 2: 1, 3: 3})
        absent = U.METRIC_BY_ID["absenteeismPct"]
        self.assertEqual(U._ranks({1: 5.0, 2: 2.0, 3: 2.0, 4: 9.0}, absent), {2: 1, 3: 1, 1: 3, 4: 4})

    def test_a_unit_with_no_figure_is_not_ranked_at_all(self):
        att = U.METRIC_BY_ID["attendancePct"]
        self.assertEqual(U._ranks({1: 90.0, 2: None, 3: 80.0}, att), {1: 1, 3: 2})
        self.assertEqual(U._ranks({1: None}, att), {})

    def test_a_size_is_ranked_largest_first_even_when_fewer_is_better_news(self):
        self.assertEqual(U._ranks({1: 4, 2: 9, 3: 9}, U.METRIC_BY_ID["leavers"]), {2: 1, 3: 1, 1: 3})
        self.assertEqual(U._ranks({1: 4, 2: 9}, U.METRIC_BY_ID["headcount"]), {2: 1, 1: 2})

    def test_a_per_person_figure_with_a_good_direction_is_ranked_best_first(self):
        self.assertEqual(U._ranks({1: 2.5, 2: 2.0}, U.METRIC_BY_ID["overtimePerHead"]), {2: 1, 1: 2})
        self.assertEqual(U._ranks({1: 1.7, 2: 1.1}, U.METRIC_BY_ID["avgTenureYears"]), {1: 1, 2: 2})
        self.assertEqual(U._ranks({1: 20200.0, 2: 13000.0}, U.METRIC_BY_ID["costPerHead"]), {1: 1, 2: 2})


class TiedUnits(MdApiTestCase):
    def test_two_units_with_the_same_attendance_both_rank_first(self):
        units = [Branch.objects.create(name=n, code=c) for n, c in (("Unit C", "UC"), ("Unit D", "UD"), ("Unit E", "UE"))]
        for unit, codes in zip(units, ("PPPPPP", "PPPPPP", "PPAAPP")):
            dept = Department.objects.create(name="Floor", branch=unit)
            mark(make_employee(f"T{unit.code}", dept, unit), d(7), codes)
        with at():
            body = self.get(f"{BASE}/summary", **W).json()
            ranked = self.get(f"{BASE}/rank", metric="attendancePct", **W).json()
        rows = {r["name"]: r["metrics"]["attendancePct"] for r in body["rows"]}
        self.assertEqual((rows["Unit C"]["rank"], rows["Unit D"]["rank"], rows["Unit E"]["rank"]), (1, 1, 3))
        self.assertEqual((rows["Unit E"]["value"], rows["Unit E"]["of"]), (66.7, 3))
        self.assertEqual([(r["rank"], r["name"]) for r in ranked["rows"]], [(1, "Unit C"), (1, "Unit D"), (3, "Unit E")])


class RankEndpointTests(World):
    def test_units_ranked_on_one_figure_best_first(self):
        body = self.api("rank", metric="absenteeismPct")
        self.assertEqual(body["metric"]["id"], "absenteeismPct")
        self.assertEqual([(r["rank"], r["name"], r["value"]) for r in body["rows"]], [(1, "Unit A", 13.6), (2, "Unit B", 50.0)])
        self.assertEqual((body["reference"], body["rows"][1]["diff"], body["rows"][1]["verdict"]), (26.5, 23.5, "worse"))
        self.assertEqual(body["total"], 2)

    def test_a_size_is_ranked_largest_first_and_a_limit_cuts_the_list(self):
        body = self.api("rank", metric="payrollCost", limit=1)
        self.assertEqual([(r["rank"], r["name"], r["value"]) for r in body["rows"]], [(1, "Unit A", 101000.0)])
        self.assertEqual(body["total"], 2)
        self.assertEqual(body["rows"][0]["sharePct"], 79.5)

    def test_an_unknown_figure_lists_the_ones_there_are(self):
        with at():
            r = self.get(f"{BASE}/rank", metric="happiness", **W)
        self.assertEqual(r.status_code, 400)
        self.assertIn("attendancePct", r.json()["error"])

    def test_the_figure_name_is_forgiving_about_case(self):
        self.assertEqual(self.api("rank", metric="ATTENDANCEPCT")["metric"]["id"], "attendancePct")


# ─── over time ───────────────────────────────────────────────────────────────────────────────────────────────────


class TrendTests(World):
    def series(self, body):
        return {u["name"]: u["values"] for u in body["units"]}

    def test_attendance_by_day_for_every_unit_and_the_company(self):
        body = self.api("trend", metric="attendancePct")
        self.assertEqual(body["granularity"], "day")
        # Sunday has no day records: no bucket
        self.assertEqual([b["key"] for b in body["buckets"]], ["2026-09-07", "2026-09-08", "2026-09-09", "2026-09-10", "2026-09-11", "2026-09-12"])
        self.assertEqual(body["buckets"][0]["label"], "07 Sep")
        series = self.series(body)
        self.assertEqual(series["Unit A"], [100.0, 75.0, 75.0, 75.0, 83.3, 100.0])
        self.assertEqual(series["Unit B"], [100.0, 50.0, 0.0, 0.0, 100.0, 50.0])
        self.assertEqual(body["company"], [100.0, 66.7, 50.0, 50.0, 90.0, 80.0])
        self.assertEqual(body["metric"]["id"], "attendancePct")

    def test_absenteeism_and_lateness_by_day(self):
        absent = self.api("trend", metric="absenteeismPct")
        self.assertEqual(self.series(absent)["Unit A"], [0.0, 25.0, 25.0, 25.0, 0.0, 0.0])
        self.assertEqual(absent["company"][2], 50.0)
        late = self.api("trend", metric="latePct")
        self.assertEqual(self.series(late)["Unit A"], [0.0, 25.0, 0.0, 0.0, 0.0, 0.0])
        self.assertEqual(late["company"], [0.0, 16.7, 0.0, 0.0, 0.0, 0.0])

    def test_a_long_period_is_drawn_by_week(self):
        body = self.api("trend", {"from": "2026-06-01", "to": "2026-09-13"}, metric="attendancePct")
        self.assertEqual(body["granularity"], "week")
        self.assertEqual([b["key"] for b in body["buckets"]], ["2026-08-31", "2026-09-07"])  # weeks start on Monday
        series = self.series(body)
        self.assertEqual((series["Unit A"], series["Unit B"]), ([95.8, 84.1], [91.7, 50.0]))
        self.assertEqual(body["company"], [94.4, 72.1])

    def test_overtime_by_day_leaves_out_rejected_days(self):
        body = self.api("trend", metric="overtimeHours")
        self.assertEqual([b["key"] for b in body["buckets"]], ["2026-09-08", "2026-09-09", "2026-09-10"])
        series = self.series(body)
        self.assertEqual((series["Unit A"], series["Unit B"]), ([1.5, 1.0, 0.0], [0.0, 0.0, 2.0]))
        self.assertEqual(body["company"], [1.5, 1.0, 2.0])

    def test_headcount_joiners_and_leavers_by_day(self):
        head = self.series(self.api("trend", metric="headcount"))
        self.assertEqual(head["Unit A"], [5, 5, 5, 4, 4, 4, 4])  # A5 is a leaver from her last day, the 10th
        self.assertEqual(head["Unit B"], [2, 3, 3, 3, 3, 3, 3])
        self.assertEqual(self.api("trend", metric="headcount")["company"], [7, 8, 8, 7, 7, 7, 7])
        self.assertEqual(self.series(self.api("trend", metric="joiners"))["Unit B"], [0, 1, 0, 0, 0, 0, 0])
        self.assertEqual(self.series(self.api("trend", metric="leavers"))["Unit A"], [0, 0, 0, 1, 0, 0, 0])

    def test_payroll_by_month_for_the_last_twelve_closed_months(self):
        body = self.api("trend", metric="payrollCost")
        self.assertEqual(body["granularity"], "month")
        self.assertEqual(len(body["buckets"]), 12)
        self.assertEqual((body["buckets"][0]["key"], body["buckets"][-1]["key"]), ("2025-09", "2026-08"))
        series = self.series(body)
        self.assertEqual(series["Unit A"], [None] * 10 + [99000.0, 101000.0])
        self.assertEqual(series["Unit B"], [None] * 10 + [26000.0, 26000.0])
        self.assertEqual(body["company"][-2:], [125000.0, 127000.0])
        per_head = self.api("trend", metric="costPerHead")
        self.assertEqual(self.series(per_head)["Unit A"][-2:], [19800.0, 20200.0])

    def test_a_figure_with_no_history_is_a_readable_400(self):
        with at():
            r = self.get(f"{BASE}/trend", metric="attritionPct", **W)
        self.assertEqual(r.status_code, 400)
        self.assertIn("attendancePct", r.json()["error"])

    def test_today_alone_has_nothing_to_draw(self):
        body = self.api("trend", {"period": "today"}, metric="attendancePct")
        self.assertEqual((body["buckets"], body["company"]), ([], []))
        self.assertEqual([u["values"] for u in body["units"]], [[], []])


# ─── one unit and its departments ────────────────────────────────────────────────────────────────────────────────


class ProfileTests(World):
    def test_a_unit_against_the_company_and_its_departments_against_the_unit(self):
        body = self.api("profile", branch="Unit A")
        self.assertEqual(body["unit"]["name"], "Unit A")
        self.assertEqual(v(body["row"], "attendancePct"), 84.1)
        self.assertEqual(body["row"]["metrics"]["attendancePct"]["reference"], 72.1)  # the company, not the unit
        self.assertEqual(body["company"]["metrics"]["attendancePct"], 72.1)
        deps = body["departments"]
        self.assertEqual(deps["referenceLabel"], "Unit A")
        rows = {r["name"]: r for r in deps["rows"]}
        self.assertEqual(set(rows), {"Stitching", "Cutting"})
        # Stitching: A1 6/6, A2 5/6, A5 4/4 = 15 of 16 -> 93.8; Cutting: A3 3 + 0.5 of 6 = 58.3
        self.assertEqual((v(rows["Stitching"], "attendancePct"), v(rows["Cutting"], "attendancePct")), (93.8, 58.3))
        stitching = rows["Stitching"]["metrics"]["attendancePct"]
        self.assertEqual((stitching["reference"], stitching["diff"], stitching["rank"]), (84.1, 9.7, 1))
        self.assertEqual(rows["Cutting"]["metrics"]["attendancePct"]["diff"], -25.8)
        self.assertEqual((rows["Stitching"]["headcount"], rows["Cutting"]["headcount"]), (3, 1))
        self.assertEqual(deps["total"], 2)

    def test_the_departments_pay_overtime_and_attrition(self):
        rows = {r["name"]: r for r in self.api("profile", branch="Unit A")["departments"]["rows"]}
        # Stitching: A1 20,000 + A2 18,000 + A4 30,000 + 2,000 overtime + A5 15,000 = 85,000 for 4 people; Cutting: A3 16,000
        self.assertEqual((v(rows["Stitching"], "payrollCost"), v(rows["Cutting"], "payrollCost")), (85000.0, 16000.0))
        self.assertEqual(v(rows["Stitching"], "costPerHead"), 21250.0)
        self.assertEqual((v(rows["Stitching"], "overtimeHours"), v(rows["Cutting"], "overtimeHours")), (2.5, 0.0))
        self.assertEqual((v(rows["Stitching"], "overtimePerHead"), v(rows["Cutting"], "overtimePerHead")), (2.5, None))  # no staff
        self.assertEqual((v(rows["Stitching"], "attritionPct"), v(rows["Cutting"], "attritionPct")), (28.6, 0.0))  # 1 / 3.5

    def test_the_unit_is_found_by_the_unit_argument_too_with_a_typo_forgiven(self):
        with at():
            body = U.unit_profile(Scope(), resolve_period(W), "unti b", today=TODAY)
        self.assertEqual(body["unit"]["name"], "Unit B")
        self.assertIn("Matched unit 'unti b' to 'Unit B'.", body["notes"])
        self.assertEqual({r["name"] for r in body["departments"]["rows"]}, {"Finishing"})

    def test_without_a_unit_the_answer_lists_the_units_to_choose_from(self):
        body = self.api("profile")
        self.assertIsNone(body["unit"])
        self.assertEqual([u["name"] for u in body["units"]], ["Unit A", "Unit B"])
        self.assertIn("Name a unit", " ".join(body["notes"]))

    def test_a_unit_nobody_works_in_says_so(self):
        empty = Branch.objects.create(name="Unit Z", code="UZ")
        body = self.api("profile", branch=str(empty.id))
        self.assertEqual(body["unit"]["name"], "Unit Z")
        self.assertIsNone(body["row"])
        self.assertIn("no employees", " ".join(body["notes"]))

    def test_an_unknown_unit_is_a_readable_400(self):
        with at():
            r = self.get(f"{BASE}/profile", branch="Nowhere", **W)
        self.assertEqual(r.status_code, 400)


# ─── needs your attention ────────────────────────────────────────────────────────────────────────────────────────


class AttentionTests(World):
    def items(self, **kw):
        return {i["id"]: i for i in self.api("attention", **kw)["items"]}

    def test_a_unit_far_below_the_company_on_attendance_is_critical_once_it_is_big_enough_to_call_out(self):
        self.assertEqual(self.items(), {})  # both units have fewer than 5 people: too small to name
        with mock.patch.object(U, "MIN_UNIT_HEADCOUNT", 3):
            item = self.items()["units.attendance-gap"]
        self.assertEqual(item["severity"], "critical")
        self.assertEqual(item["title"], "Unit B attendance is 22.1 points below the company average")
        self.assertEqual(item["metric"], "-22.1 pts")
        self.assertEqual(item["page"], "branches")
        self.assertIn("50% against 72.1% for the company".replace("50%", "50%"), item["detail"])
        self.assertIn("Unit B", item["ask"])

    def test_a_gap_under_the_critical_mark_is_a_warning(self):
        with mock.patch.object(U, "MIN_UNIT_HEADCOUNT", 3), mock.patch.object(U, "GAP_CRITICAL_PTS", 30.0):
            self.assertEqual(self.items()["units.attendance-gap"]["severity"], "warning")

    def test_late_arrivals_far_above_the_company(self):
        with mock.patch.object(U, "MIN_UNIT_HEADCOUNT", 3), mock.patch.object(U, "LATE_GAP_PTS", 1.0):
            item = self.items()["units.late-gap"]
        self.assertEqual(item["title"], "Unit A late arrivals are 5.3%, 1.3 points above the company")
        self.assertEqual(item["severity"], "warning")

    def test_overtime_far_above_the_units_own_normal(self):
        # recent: 2.5 h in 7 days; the 90 days before it: 1.0 h (A4 on 2 Sep). Per day: (2.5 / 7) / (1.0 / 90) = 32.1 times
        self.assertNotIn("units.overtime-spike", self.items())  # under the 8-hour floor
        with mock.patch.object(U, "OT_SPIKE_MIN_HOURS", 1.0):
            item = self.items()["units.overtime-spike"]
        self.assertEqual(item["title"], "Unit A overtime is 32.1x its 90-day average")
        self.assertEqual(item["metric"], "2.5 h")
        self.assertNotIn("Unit B", item["title"])  # B has no overtime history: nothing to compare with

    def test_an_attrition_hot_spot_needs_enough_leavers_and_people(self):
        self.assertNotIn("units.attrition", self.items())
        with mock.patch.object(U, "ATTRITION_MIN_LEAVERS", 1), mock.patch.object(U, "ATTRITION_MIN_AVERAGE", 4):
            item = self.items()["units.attrition"]
        self.assertEqual(item["title"], "Unit A lost 22.2% of its people in 12 months, against 14.3% for the company")
        self.assertEqual(item["severity"], "warning")

    def test_findings_come_most_severe_first_and_the_list_is_capped(self):
        with mock.patch.object(U, "MIN_UNIT_HEADCOUNT", 3), mock.patch.object(U, "LATE_GAP_PTS", 1.0), mock.patch.object(U, "OT_SPIKE_MIN_HOURS", 1.0):
            items = self.api("attention")["items"]
        severities = [i["severity"] for i in items]
        self.assertEqual(severities, sorted(severities, key=lambda s: U._SEVERITY_RANK[s]))
        self.assertEqual(items[0]["id"], "units.attendance-gap")
        self.assertLessEqual(len(items), U.ATTENTION_LIMIT)

    def test_nothing_wrong_is_good_news_or_a_note_about_the_spread(self):
        for unit in (self.unit_a, self.unit_b):
            AttendanceDayRecord.objects.filter(employee__branch=unit).update(status="present", is_late=False)
        with mock.patch.object(U, "MIN_UNIT_HEADCOUNT", 3):
            items = self.items()
        self.assertEqual(list(items), ["units.aligned"])
        self.assertEqual(items["units.aligned"]["severity"], "good")
        self.assertIn("within 0.1 points", items["units.aligned"]["title"])

    def test_the_rules_are_explained(self):
        entry = self.api("attention")["provenance"][0]
        self.assertEqual(entry["id"], "units-attention")
        self.assertIn("3 points", entry["definition"])


class InsightsAndHeadlineTests(World):
    def test_the_dashboard_exceptions_look_at_the_last_30_days_company_wide(self):
        with at(), mock.patch.object(U, "MIN_UNIT_HEADCOUNT", 3):
            items = U.insights(today=TODAY)
        # 30 days to the 13th: A 41.5 of 46 = 90.2, B 17 of 24 = 70.8, company 58.5 of 70 = 83.6 -> B is 12.8 under
        self.assertEqual(items[0]["id"], "units.attendance-gap")
        self.assertEqual(items[0]["title"], "Unit B attendance is 12.8 points below the company average")
        self.assertEqual(items[0]["severity"], "critical")
        for item in items:
            self.assertEqual(set(item), {"id", "severity", "title", "detail", "metric", "page", "ask"})
            self.assertEqual(item["page"], "branches")
        self.assertLessEqual(len(items), 5)

    def test_the_headline_cards(self):
        with at():
            head = U.headline(today=TODAY)
        count, weakest = head["kpis"]
        self.assertEqual((count["id"], count["value"], count["format"], count["page"]), ("units.count", 2, "number", "branches"))
        self.assertEqual(count["sub"], "7 active people · largest: Unit A (4)")
        self.assertEqual((weakest["id"], weakest["value"], weakest["format"]), ("units.weakest-attendance", 70.8, "pct"))
        self.assertEqual(weakest["sub"], "Unit B · best: Unit A 90.2% · last 30 days")
        self.assertIsNone(weakest["delta"])  # no records in the 30 days before: nothing to compare with
        self.assertTrue(head["provenance"])
        self.assertLessEqual(len(head["kpis"]), 3)

    def test_the_brief_endpoint_serves_both(self):
        with at(), mock.patch.object(U, "MIN_UNIT_HEADCOUNT", 3):
            body = self.get("/api/md/brief/branches").json()
        self.assertEqual(body["domain"], "units")
        self.assertEqual([k["id"] for k in body["kpis"]], ["units.count", "units.weakest-attendance"])
        self.assertEqual(body["insights"][0]["id"], "units.attendance-gap")
        self.assertFalse([n for n in body["notes"] if "could not" in n])

    def test_a_single_unit_has_no_weakest_card(self):
        with at():
            head = U.headline(today=TODAY) if False else None
        Branch.objects.exclude(pk=self.unit_a.pk).update(is_active=False)  # (only changes a flag: units still exist)
        Employee.objects.filter(branch=self.unit_b).delete()
        with at():
            head = U.headline(today=TODAY)
        self.assertEqual([k["id"] for k in head["kpis"]], ["units.count"])
        self.assertEqual(head["kpis"][0]["value"], 1)


# ─── an empty company ────────────────────────────────────────────────────────────────────────────────────────────


class EmptyCompanyTests(MdApiTestCase):
    def test_nothing_divides_by_zero_and_no_data_is_null_not_zero(self):
        with at():
            body = self.get(f"{BASE}/summary", **W).json()
        self.assertEqual((body["rows"], body["unitCount"], body["leaders"]), ([], 0, {}))
        company = body["company"]
        self.assertEqual(company["headcount"], 0)
        for metric in ("attendancePct", "absenteeismPct", "latePct", "attritionPct", "avgTenureYears", "payrollCost", "costPerHead", "overtimePerHead"):
            self.assertIsNone(company["metrics"][metric], metric)
        self.assertEqual(body["briefing"]["sentences"], [])
        self.assertTrue(body["provenance"])  # the explanations are still there
        self.assertIsNone(body["payrollMonth"])
        self.assertIn("No payroll has been processed", " ".join(body["notes"]))

    def test_every_route_answers_on_an_empty_database(self):
        with at():
            for route in ROUTES:
                with self.subTest(route=route):
                    r = self.get(f"{BASE}/{route}", **W)
                    self.assertEqual(r.status_code, 200, r.content)
            trend = self.get(f"{BASE}/trend", metric="payrollCost", **W).json()
            self.assertEqual(trend["buckets"], [])
            attention = self.get(f"{BASE}/attention", **W).json()
            self.assertEqual(attention["items"], [])
            profile = self.get(f"{BASE}/profile", **W).json()
            self.assertEqual(profile["units"], [])

    def test_the_dashboard_pieces_are_empty_not_broken(self):
        with at():
            self.assertEqual(U.insights(today=TODAY), [])
            head = U.headline(today=TODAY)
        self.assertEqual([k["id"] for k in head["kpis"]], ["units.count"])
        self.assertEqual(head["kpis"][0]["value"], 0)

    def test_a_company_that_never_ran_attendance_or_payroll(self):
        unit = Branch.objects.create(name="Unit Q", code="UQ")
        make_employee("Q1", None, unit)
        with at():
            body = self.get(f"{BASE}/summary", **W).json()
        row = body["rows"][0]["metrics"]
        self.assertEqual(body["rows"][0]["headcount"], 1)
        self.assertIsNone(row["attendancePct"]["value"])
        self.assertIsNone(row["costPerHead"]["value"])
        self.assertIsNone(row["overtimeHours"]["value"])  # overtime detection is off and nothing is on record: not tracked
        self.assertFalse(body["otTracked"])


# ─── the assistant's tools ───────────────────────────────────────────────────────────────────────────────────────


class ToolTests(World):
    def run_tool(self, name, **args):
        spec = registry.all_tools()[name]
        with at(), read_only_db():
            return spec.run(args)

    def test_the_tools_are_registered_with_descriptions_that_say_when_to_use_them(self):
        tools = {n: s for n, s in registry.all_tools().items() if s.page == "branches"}
        self.assertEqual(set(tools), {"units_compare", "units_rank", "unit_profile", "units_trend", "units_attention"})
        for name, spec in tools.items():
            with self.subTest(tool=name):
                self.assertGreaterEqual(len(spec.description), 100)
                self.assertTrue(spec.default_period)
        self.assertIn("metric", tools["units_rank"].properties)
        self.assertIn("unit", tools["unit_profile"].properties)

    def test_compare_returns_the_same_numbers_as_the_page(self):
        result = self.run_tool("units_compare", period="last_7_days")
        self.assertEqual({r["name"] for r in result["rows"]}, {"Unit A", "Unit B"})
        self.assertTrue(result["provenance"])
        with at():
            page = U.units_summary(Scope(), resolve_period({"period": "last_7_days"}))
        self.assertEqual(result["rows"], page["rows"])

    def test_rank_orders_the_units_and_takes_a_unit_scope(self):
        result = self.run_tool("units_rank", metric="costPerHead", **W)
        self.assertEqual([(r["rank"], r["name"], r["value"]) for r in result["rows"]], [(1, "Unit A", 20200.0), (2, "Unit B", 13000.0)])
        one = self.run_tool("units_rank", metric="attendancePct", branch="Unit B", **W)
        self.assertEqual([r["name"] for r in one["rows"]], ["Unit B"])
        with self.assertRaises(MdParamError):
            self.run_tool("units_rank", metric="vibes", **W)

    def test_the_profile_tool_takes_a_unit_by_name(self):
        result = self.run_tool("unit_profile", unit="Unit B", **W)
        self.assertEqual(result["unit"]["name"], "Unit B")
        self.assertEqual({r["name"] for r in result["departments"]["rows"]}, {"Finishing"})
        listing = self.run_tool("unit_profile", **W)
        self.assertIsNone(listing["unit"])
        self.assertEqual([u["name"] for u in listing["units"]], ["Unit A", "Unit B"])
        with self.assertRaises(MdParamError):
            self.run_tool("unit_profile", unit="Nowhere", **W)

    def test_the_trend_tool_draws_one_figure_by_unit(self):
        result = self.run_tool("units_trend", metric="attendancePct", **W)
        self.assertEqual(result["units"][0]["values"], [100.0, 75.0, 75.0, 75.0, 83.3, 100.0])
        with self.assertRaises(MdParamError):
            self.run_tool("units_trend", metric="attritionPct", **W)

    def test_the_attention_tool(self):
        with mock.patch.object(U, "MIN_UNIT_HEADCOUNT", 3):
            result = self.run_tool("units_attention", **W)
        self.assertEqual(result["items"][0]["id"], "units.attendance-gap")

    def test_every_result_is_plain_json_with_provenance(self):
        import json

        for name in ("units_compare", "units_rank", "unit_profile", "units_trend", "units_attention"):
            with self.subTest(tool=name):
                result = self.run_tool(name, unit="Unit A") if name == "unit_profile" else self.run_tool(name)
                json.dumps(result)
                self.assertTrue(result["provenance"])
                self.assertLess(len(json.dumps(result)), 60_000)


# ─── the cost of asking ──────────────────────────────────────────────────────────────────────────────────────────


class QueryBudgetTests(MdApiTestCase):
    """Every endpoint reads the database a fixed number of times, however many units and people there are."""

    CEILING = 80

    def populate(self, tag: str, units: int, people: int) -> None:
        for u in range(units):
            unit = Branch.objects.create(name=f"{tag}{u}", code=f"{tag}{u}")
            dept = Department.objects.create(name="Floor", branch=unit)
            for p in range(people):
                emp = make_employee(f"{tag}{u}x{p}", dept, unit, "production" if p % 2 else "staff")
                mark(emp, d(7), "PPAPPP")
                mark(emp, d(31, 8), "PPPPPA")
                slip(emp, 2026, 8, 10000 + p, 100)
                overtime(emp, d(9), 60)

    def counts(self, **extra):
        out = {}
        for route in ROUTES:
            params = {"branch": extra["branch"]} if route == "profile" else {}
            with at(), CaptureQueriesContext(connection) as ctx:
                r = self.get(f"{BASE}/{route}", **W, **params)
            self.assertEqual(r.status_code, 200, r.content)
            out[route] = len(ctx)
        return out

    def test_the_number_of_queries_does_not_depend_on_the_number_of_units_or_people(self):
        self.populate("s", units=2, people=3)
        small = self.counts(branch="s0")
        self.populate("m", units=6, people=8)
        large = self.counts(branch="s0")
        for route in ROUTES:
            with self.subTest(route=route):
                self.assertLessEqual(large[route], small[route] + 1, (small, large))
                self.assertLess(large[route], self.CEILING)

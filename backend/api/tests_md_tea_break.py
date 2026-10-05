"""MD portal, Tea Break: every figure recomputed by hand from a small company.

Run:  DB_TEST_NAME=test_uktex_tea_break python manage.py test api.tests_md_tea_break --noinput

The GOLDEN company (times are Indian time; NOW is Tue 15-Sep-2026 15:30; the allowance is 15 minutes):

  Units       Unit 1, Unit 2
  Departments Cutting (U1), Stitching (U1), Stitching (U2: same name, one department of the company), Admin (U1)
  Employees   A Cutting/U1 staff        B Cutting/U1 production      C Stitching/U1 production
              D Stitching/U2 production E Admin/U1 staff             F Stitching/U1 production (resigned)
              G no department, no unit, staff (active, never scans)
  Shifts      Morning (U1), Evening (U1), Morning (U2: same name as U1's)
              A: Morning(U1)      B: Morning(U1) to 04-Sep, then Evening     C: Evening, and from 08-Sep ALSO Morning(U1)
              (two assignments overlap: the later start wins)              D: Morning(U2)
              E: none             F: Morning(U1) 01..05-Sep only             G: none

THE PERIOD UNDER TEST is 01-Sep..14-Sep (14 days); the previous period is 18-Aug..31-Aug. Breaks, out -> in:

  A  a1 09-02 10:00->10:10 (10)  a2 09-02 15:00->15:15:29 (15, on time)  a3 09-03 10:00->10:15:31 (16, over 1)
     a4 09-04 10:05->10:20 (15)  a5 09-05 10:00->10:35 (35, over 20)     o2 09-12 11:00 never closed
  B  b1 09-02 10:30->10:47:30 (17.5 -> 18, over 3)   b2 09-03 10:30->10:46:30 (16.5 -> 16 half-even, over 1)
     b3 09-04 10:30->10:55 (25, over 10)  b4 09-05 10:30->11:00 (30, over 15)  b5 09-08 10:30->10:40 (10)
  C  c1 09-02 10:00->10:20 (20, over 5)   c2 09-03 10:00->10:30 (30, over 15)  c3 09-04 10:00->10:25 (25, over 10)
     c4 09-05 10:00->10:12 (12)  c5 09-06 10:00->11:00 (60, over 45: the longest a real break can be)
     c6 09-07 10:00->11:00:29 (60, over 45)  c7 09-08 10:00->11:00:31 (61: a missed scan, not measured)
     c8 09-09 10:00->12:30 (150, not measured)  o3 09-13 12:00 never closed
  D  d1 09-02 10:00->10:12 (12)  d2 09-03 10:00->10:14 (14)  d3 09-04 16:00->16:30 (30, over 15)
     d4 09-14 23:50->09-15 00:10 (20, over 5; belongs to 14-Sep)
  E  e1 09-01 00:00->00:10 (10; the first instant of the period)   e3 09-10 10:00->10:15 (15)
  F  f1 09-05 10:00->10:25 (25, over 10)   f2 09-06 10:00->10:10 (10)

  Outside the period: d5 09-15 00:00->00:05 (belongs to 15-Sep; UTC date is 14-Sep), o1 B 09-15 15:00 open (in progress),
  o4 C 09-15 13:00 open (150 min: not returned).
  Previous period: p1 A 08-20 (10)  p2 A 08-21 (20, over 5)  p3 B 08-20 (30, over 15)  p4 C 08-21 (12)  p5 C 08-22 (14)
  p6 D 08-25 (50, over 35)  p7 B 08-18 00:00->00:10 (10)  e2 E 08-31 23:59:59->09-01 00:20 (20, over 5; starts in the
  previous period)  p8 B 08-17 23:59:59 (one second before the previous period: in neither).

HAND TOTALS for the period (28 breaks = 24 measured + 2 not measured (c7, c8) + 2 never closed (o2, o3)):
  measured 24, overruns 14, minutes lost 200 (A 21, B 29, C 120, D 20, F 10), measured minutes 533 -> average 22.2,
  overrun rate 14/24 = 58.3 %, within allowance 41.7 %, 6 employees, 13 of 14 days with a scan (nothing on 11-Sep).
  Previous period: 8 breaks, 8 measured, 4 overruns, lost 60, minutes 166 -> 20.8 average, 50.0 %.
"""

import json
import random
from datetime import date, datetime, timedelta
from datetime import time as dtime
from datetime import timezone as dt_timezone
from unittest import mock

from django.db import connection
from django.test import SimpleTestCase, TestCase
from django.test.utils import CaptureQueriesContext

from .clock import FACTORY_TZ
from .jwt_utils import sign_token
from .md_portal.analytics import tea_break as tea
from .md_portal.assistant import registry
from .md_portal.common import MdParamError, Scope, read_only_db, resolve_period
from .models import (
    Branch,
    Department,
    Employee,
    EmployeeShiftAssignment,
    HRUser,
    Role,
    ShiftTemplate,
    TeaBreakLog,
    TeaBreakRule,
)
from .reporting.definitions import gate_visitor_tea_common as TC
from .tests_md_support import MdApiTestCase, make_md, md_headers

NOW = datetime(2026, 9, 15, 10, 0, tzinfo=dt_timezone.utc)  # 15:30 IST on Tuesday 15 Sep 2026
TODAY = date(2026, 9, 15)
P = {"from": "2026-09-01", "to": "2026-09-14"}  # the period under test; the previous one is 2026-08-18..2026-08-31
ROUTES = ["summary", "trend", "departments", "shifts", "heatmap", "offenders", "rule", "attention"]


def ist(month, day, hh=0, mm=0, ss=0, year=2026):
    return datetime(year, month, day, hh, mm, ss, tzinfo=FACTORY_TZ)


def by_label(response):
    return {r["label"]: r for r in response["rows"]}


def freeze_clock(test):
    patcher = mock.patch.object(TC, "now_utc", return_value=NOW)
    patcher.start()
    test.addCleanup(patcher.stop)


def build_golden(cls):
    """The company in the module docstring."""
    cls.u1 = Branch.objects.create(name="Unit 1", code="TU1")
    cls.u2 = Branch.objects.create(name="Unit 2", code="TU2")
    cls.cutting = Department.objects.create(name="Cutting", branch=cls.u1)
    cls.stitch1 = Department.objects.create(name="Stitching", branch=cls.u1)
    cls.stitch2 = Department.objects.create(name="Stitching", branch=cls.u2)
    cls.admin_dept = Department.objects.create(name="Admin", branch=cls.u1)

    def emp(code, first, dept, branch, kind, status="active"):
        return Employee.objects.create(
            employee_code=code,
            first_name=first,
            last_name="Test",
            department=dept,
            branch=branch,
            employment_type=kind,
            status=status,
        )

    cls.A = emp("A", "Asha", cls.cutting, cls.u1, "staff")
    cls.B = emp("B", "Babu", cls.cutting, cls.u1, "production")
    cls.C = emp("C", "Chitra", cls.stitch1, cls.u1, "production")
    cls.D = emp("D", "Dinesh", cls.stitch2, cls.u2, "production")
    cls.E = emp("E", "Esha", cls.admin_dept, cls.u1, "staff")
    cls.F = emp("F", "Farook", cls.stitch1, cls.u1, "production", status="resigned")
    cls.G = emp("G", "Gita", None, None, "staff")

    TeaBreakRule.objects.create(pk=1, allowed_minutes=15)
    TeaBreakRule.objects.filter(pk=1).update(updated_at=ist(9, 3, 12, 0))

    def shift(name, branch, kind, start, end):
        return ShiftTemplate.objects.create(name=name, branch=branch, shift_type=kind, start_time=start, end_time=end)

    cls.morning1 = shift("Morning", cls.u1, "staff", dtime(9, 0), dtime(17, 30))
    cls.evening = shift("Evening", cls.u1, "production", dtime(14, 0), dtime(22, 0))
    cls.morning2 = shift("Morning", cls.u2, "production", dtime(7, 0), dtime(15, 30))

    def assign(e, s, start, end=None):
        EmployeeShiftAssignment.objects.create(employee=e, shift=s, effective_from=start, effective_to=end)

    assign(cls.A, cls.morning1, date(2026, 8, 1))
    assign(cls.B, cls.morning1, date(2026, 8, 1), date(2026, 9, 4))
    assign(cls.B, cls.evening, date(2026, 9, 5))
    assign(cls.C, cls.evening, date(2026, 8, 1))
    assign(cls.C, cls.morning1, date(2026, 9, 8))  # overlaps the open-ended Evening one: the later start wins
    assign(cls.D, cls.morning2, date(2026, 8, 1))
    assign(cls.F, cls.morning1, date(2026, 9, 1), date(2026, 9, 5))

    def brk(e, out, back=None):
        return TeaBreakLog.objects.create(employee=e, out_at=out, in_at=back)

    A, B, C, D, E, F = cls.A, cls.B, cls.C, cls.D, cls.E, cls.F
    # ── the period under test
    brk(A, ist(9, 2, 10, 0), ist(9, 2, 10, 10))
    brk(A, ist(9, 2, 15, 0), ist(9, 2, 15, 15, 29))
    brk(A, ist(9, 3, 10, 0), ist(9, 3, 10, 15, 31))
    brk(A, ist(9, 4, 10, 5), ist(9, 4, 10, 20))
    brk(A, ist(9, 5, 10, 0), ist(9, 5, 10, 35))
    brk(A, ist(9, 12, 11, 0))  # o2
    brk(B, ist(9, 2, 10, 30), ist(9, 2, 10, 47, 30))
    brk(B, ist(9, 3, 10, 30), ist(9, 3, 10, 46, 30))
    brk(B, ist(9, 4, 10, 30), ist(9, 4, 10, 55))
    brk(B, ist(9, 5, 10, 30), ist(9, 5, 11, 0))
    brk(B, ist(9, 8, 10, 30), ist(9, 8, 10, 40))
    brk(C, ist(9, 2, 10, 0), ist(9, 2, 10, 20))
    brk(C, ist(9, 3, 10, 0), ist(9, 3, 10, 30))
    brk(C, ist(9, 4, 10, 0), ist(9, 4, 10, 25))
    brk(C, ist(9, 5, 10, 0), ist(9, 5, 10, 12))
    brk(C, ist(9, 6, 10, 0), ist(9, 6, 11, 0))
    brk(C, ist(9, 7, 10, 0), ist(9, 7, 11, 0, 29))
    brk(C, ist(9, 8, 10, 0), ist(9, 8, 11, 0, 31))
    brk(C, ist(9, 9, 10, 0), ist(9, 9, 12, 30))
    brk(C, ist(9, 13, 12, 0))  # o3
    brk(D, ist(9, 2, 10, 0), ist(9, 2, 10, 12))
    brk(D, ist(9, 3, 10, 0), ist(9, 3, 10, 14))
    brk(D, ist(9, 4, 16, 0), ist(9, 4, 16, 30))
    brk(D, ist(9, 14, 23, 50), ist(9, 15, 0, 10))
    brk(E, ist(9, 1, 0, 0), ist(9, 1, 0, 10))
    brk(E, ist(9, 10, 10, 0), ist(9, 10, 10, 15))
    brk(F, ist(9, 5, 10, 0), ist(9, 5, 10, 25))
    brk(F, ist(9, 6, 10, 0), ist(9, 6, 10, 10))
    # ── outside it, on 15-Sep (today)
    brk(D, ist(9, 15, 0, 0), ist(9, 15, 0, 5))
    brk(B, ist(9, 15, 15, 0))  # o1: 30 minutes ago, in progress
    brk(C, ist(9, 15, 13, 0))  # o4: 150 minutes ago, not returned
    # ── the previous period
    brk(A, ist(8, 20, 10, 0), ist(8, 20, 10, 10))
    brk(A, ist(8, 21, 10, 0), ist(8, 21, 10, 20))
    brk(B, ist(8, 20, 10, 0), ist(8, 20, 10, 30))
    brk(C, ist(8, 21, 10, 0), ist(8, 21, 10, 12))
    brk(C, ist(8, 22, 10, 0), ist(8, 22, 10, 14))
    brk(D, ist(8, 25, 10, 0), ist(8, 25, 10, 50))
    brk(E, ist(8, 31, 23, 59, 59), ist(9, 1, 0, 20))  # e2
    brk(B, ist(8, 18, 0, 0), ist(8, 18, 0, 10))  # p7: the first instant of the previous period
    brk(B, ist(8, 17, 23, 59, 59), ist(8, 18, 0, 10))  # p8: one second earlier, in neither period


class GoldenBase(MdApiTestCase):
    @classmethod
    def setUpTestData(cls):
        build_golden(cls)

    def setUp(self):
        super().setUp()
        freeze_clock(self)

    def api(self, name, **params):
        merged = {**P, **params}
        r = self.get(f"/api/md/tea-break/{name}", **merged)
        self.assertEqual(r.status_code, 200, r.content)
        return r.json()


# ═════════════════════════════════════════════════════════════════════════════════════════════════════════════════
# summary
# ═════════════════════════════════════════════════════════════════════════════════════════════════════════════════


class SummaryTests(GoldenBase):
    def test_the_figures_equal_the_hand_count(self):
        s = self.api("summary")
        m = s["metrics"]
        self.assertEqual(s["allowedMinutes"], 15)
        self.assertEqual((m["breaks"]["value"], m["breaks"]["previous"]), (28, 8))
        self.assertEqual((m["employees"]["value"], m["employees"]["previous"]), (6, 5))
        self.assertEqual((m["measured"]["value"], m["measured"]["previous"]), (24, 8))
        self.assertEqual((m["avgMinutes"]["value"], m["avgMinutes"]["previous"]), (22.2, 20.8))
        self.assertEqual((m["overruns"]["value"], m["overruns"]["previous"]), (14, 4))
        self.assertEqual((m["overrunPct"]["value"], m["overrunPct"]["previous"]), (58.3, 50.0))
        self.assertEqual((m["compliancePct"]["value"], m["compliancePct"]["previous"]), (41.7, 50.0))
        self.assertEqual((m["minutesLost"]["value"], m["minutesLost"]["previous"]), (200, 60))
        self.assertEqual(s["hoursLost"], 3.3)
        self.assertEqual(s["withinAllowance"], 10)

    def test_changes_against_the_previous_period(self):
        m = self.api("summary")["metrics"]
        self.assertEqual(m["breaks"]["change"], {"abs": 20, "pct": 250.0})
        self.assertEqual(m["overrunPct"]["change"], {"abs": 8.3, "pct": 16.6})  # percentage figures change in points
        self.assertEqual(m["minutesLost"]["change"], {"abs": 140, "pct": 233.3})
        self.assertEqual(m["compliancePct"]["change"]["abs"], -8.3)

    def test_the_previous_period_is_the_same_length_just_before(self):
        s = self.api("summary")
        self.assertEqual(
            (s["period"]["start"], s["period"]["end"], s["period"]["days"]), ("2026-09-01", "2026-09-14", 14)
        )
        prev = s["previousPeriod"]
        self.assertEqual((prev["start"], prev["end"], prev["days"]), ("2026-08-18", "2026-08-31", 14))

    def test_coverage_says_how_complete_the_scans_are(self):
        c = self.api("summary")["coverage"]
        self.assertEqual(c["activeEmployees"], 6)  # A B C D E G; F has resigned
        self.assertEqual(c["employeesScanning"], 5)  # G never scans, F is not active
        self.assertEqual(c["participationPct"], 83.3)
        self.assertEqual((c["daysWithScans"], c["daysInPeriod"]), (13, 14))
        self.assertEqual((c["breaks"], c["measured"], c["longCompleted"], c["noReturn"]), (28, 24, 2, 2))
        self.assertEqual((c["unmeasured"], c["unmeasuredPct"]), (4, 14.3))
        self.assertEqual(
            c["breaks"], c["measured"] + c["longCompleted"] + c["noReturn"]
        )  # nothing lost, nothing counted twice

    def test_the_notes_say_what_was_left_out(self):
        notes = " ".join(self.api("summary")["notes"])
        self.assertIn("5 of 6 active employees (83%) scanned at least one break", notes)
        self.assertIn("4 of 28 breaks (14%) could not be measured", notes)
        self.assertIn("2 lasted over 60 minutes", notes)
        self.assertIn("2 have no return scan", notes)

    def test_the_rounding_rule_matches_the_hr_page(self):
        """15m29s is 15 (on time), 15m31s is 16 (over 1); 16m30s rounds to 16 like Python, not 17 like SQL ROUND."""
        daily = {p["date"]: p for p in self.api("trend")["points"]}
        self.assertEqual(
            (daily["2026-09-02"]["overruns"], daily["2026-09-02"]["minutesLost"]), (2, 8)
        )  # a2 on time; b1 3 + c1 5
        self.assertEqual(
            (daily["2026-09-03"]["overruns"], daily["2026-09-03"]["minutesLost"]), (3, 17)
        )  # a3 1 + b2 1 + c2 15

    def test_a_break_of_exactly_sixty_minutes_is_measured_and_sixty_one_is_not(self):
        daily = {p["date"]: p for p in self.api("trend")["points"]}
        self.assertEqual((daily["2026-09-06"]["measured"], daily["2026-09-06"]["minutesLost"]), (2, 45))  # c5: 60 min
        self.assertEqual((daily["2026-09-07"]["measured"], daily["2026-09-07"]["minutesLost"]), (1, 45))  # c6: 60m29s
        self.assertEqual(
            (daily["2026-09-08"]["breaks"], daily["2026-09-08"]["measured"]), (2, 1)
        )  # c7: 60m31s is left out

    def test_leavers_breaks_stay_in_the_history(self):
        daily = {p["date"]: p for p in self.api("trend")["points"]}
        self.assertEqual(daily["2026-09-05"]["breaks"], 4)  # a5 b4 c4 and f1 (F has resigned)

    def test_a_scoped_summary_answers_only_for_that_part_of_the_company(self):
        unit2 = self.api("summary", branch="Unit 2")
        self.assertEqual(unit2["metrics"]["breaks"]["value"], 4)
        self.assertEqual(unit2["metrics"]["overruns"]["value"], 2)
        self.assertEqual(unit2["metrics"]["minutesLost"]["value"], 20)
        self.assertEqual(unit2["coverage"]["activeEmployees"], 1)  # D only
        self.assertEqual(unit2["scope"]["description"], "Unit 2 · all departments · staff and production")

    def test_provenance_explains_every_figure(self):
        s = self.api("summary")
        ids = [p["id"] for p in s["provenance"]]
        for wanted in (
            "tea-breaks",
            "tea-overrun",
            "tea-minutes-lost",
            "tea-average",
            "tea-compliance",
            "tea-coverage",
        ):
            self.assertIn(wanted, ids)
        by_id = {p["id"]: p for p in s["provenance"]}
        self.assertEqual(by_id["tea-breaks"]["rows"], 28)
        self.assertEqual(by_id["tea-overrun"]["rows"], 24)
        self.assertEqual(by_id["tea-minutes-lost"]["rows"], 14)
        self.assertIn("15 minutes", by_id["tea-overrun"]["definition"])
        self.assertIn("Report Center", " ".join(by_id["tea-overrun"]["caveats"]))
        for entry in s["provenance"]:
            self.assertEqual(
                set(entry), {"id", "title", "dataset", "definition", "formula", "rows", "filters", "caveats"}
            )

    def test_today_in_the_period_is_flagged_as_partial(self):
        today = self.api("summary", **{"from": "2026-09-15", "to": "2026-09-15"})
        self.assertIn("Today is still in progress", " ".join(today["notes"]))
        self.assertNotIn("Today is still in progress", " ".join(self.api("summary")["notes"]))

    def test_open_breaks_today_are_in_progress_or_not_returned(self):
        s = self.api("summary", **{"from": "2026-09-15", "to": "2026-09-15"})
        c = s["coverage"]
        self.assertEqual(
            (c["breaks"], c["measured"], c["noReturn"], c["inProgress"], c["longCompleted"]), (3, 1, 2, 1, 0)
        )
        self.assertEqual(s["metrics"]["avgMinutes"]["value"], 5.0)  # d5: 00:00 -> 00:05
        self.assertEqual(s["metrics"]["overruns"]["value"], 0)
        self.assertEqual(s["metrics"]["overrunPct"]["value"], 0.0)  # a real 0 %, not "no data"
        self.assertEqual(s["metrics"]["minutesLost"]["value"], 0)


# ═════════════════════════════════════════════════════════════════════════════════════════════════════════════════
# period edges
# ═════════════════════════════════════════════════════════════════════════════════════════════════════════════════


class PeriodEdgeTests(GoldenBase):
    def breaks(self, start, end):
        return self.api("summary", **{"from": start, "to": end})["metrics"]["breaks"]["value"]

    def test_both_ends_are_inclusive_and_a_break_belongs_to_the_day_it_started(self):
        self.assertEqual(self.breaks("2026-09-01", "2026-09-01"), 1)  # e1 at 00:00:00; e2 started on 31-Aug
        self.assertEqual(self.breaks("2026-08-31", "2026-08-31"), 1)  # e2 23:59:59 -> 00:20 next day
        self.assertEqual(self.breaks("2026-09-14", "2026-09-14"), 1)  # d4 23:50 -> 00:10; d5 starts on 15-Sep
        self.assertEqual(self.breaks("2026-09-15", "2026-09-15"), 3)  # d5 (UTC date 14-Sep), o1, o4
        self.assertEqual(self.breaks("2026-08-17", "2026-08-17"), 1)  # p8, one second before the previous period

    def test_the_overnight_break_counts_as_14_sep(self):
        s = self.api("summary", **{"from": "2026-09-14", "to": "2026-09-14"})
        self.assertEqual(s["metrics"]["overruns"]["value"], 1)
        self.assertEqual(s["metrics"]["minutesLost"]["value"], 5)

    def test_previous_period_edges(self):
        prev = self.api("summary", **{"from": "2026-08-18", "to": "2026-08-31"})["metrics"]
        self.assertEqual(prev["breaks"]["value"], 8)  # p7 on the first instant, e2 on the last day, never p8
        self.assertEqual(prev["overruns"]["value"], 4)

    def test_a_period_crossing_a_month_boundary(self):
        s = self.api("summary", **{"from": "2026-08-30", "to": "2026-09-02"})
        self.assertEqual(s["metrics"]["breaks"]["value"], 1 + 1 + 5)  # e2; e1; a1 a2 b1 c1 d1
        self.assertEqual(s["previousPeriod"]["start"], "2026-08-26")
        self.assertEqual(s["previousPeriod"]["end"], "2026-08-29")

    def test_a_period_crossing_a_year_boundary(self):
        # a break that starts at 23:50 on 31-Dec belongs to 2025, one that starts at 00:05 on 1-Jan to 2026
        TeaBreakLog.objects.create(employee=self.A, out_at=ist(12, 31, 23, 50, year=2025), in_at=ist(1, 1, 0, 0))
        TeaBreakLog.objects.create(employee=self.A, out_at=ist(1, 1, 0, 5), in_at=ist(1, 1, 0, 30))
        TeaBreakLog.objects.create(
            employee=self.A, out_at=ist(12, 29, 10, 0, year=2025), in_at=ist(12, 29, 10, 10, year=2025)
        )
        s = self.api("summary", **{"from": "2025-12-31", "to": "2026-01-01"})
        self.assertEqual(s["metrics"]["breaks"]["value"], 2)
        self.assertEqual(s["metrics"]["overruns"]["value"], 1)  # the 25-minute one; the 10-minute one is on time
        self.assertEqual(s["metrics"]["minutesLost"]["value"], 10)
        self.assertEqual((s["previousPeriod"]["start"], s["previousPeriod"]["end"]), ("2025-12-29", "2025-12-30"))
        self.assertEqual(s["metrics"]["breaks"]["previous"], 1)

    def test_a_whole_month(self):
        s = self.get("/api/md/tea-break/summary", month="2026-09").json()
        self.assertEqual(s["period"]["label"], "Sep 2026")
        self.assertEqual(s["metrics"]["breaks"]["value"], 28 + 3)  # the period under test plus 15-Sep


# ═════════════════════════════════════════════════════════════════════════════════════════════════════════════════
# scope
# ═════════════════════════════════════════════════════════════════════════════════════════════════════════════════


class ScopeTests(GoldenBase):
    def counts(self, **scope):
        s = self.api("summary", **scope)
        m = s["metrics"]
        return m["breaks"]["value"], m["overruns"]["value"], m["minutesLost"]["value"]

    def test_everyone(self):
        self.assertEqual(self.counts(), (28, 14, 200))

    def test_a_unit(self):
        self.assertEqual(self.counts(branch="Unit 1"), (24, 12, 180))
        self.assertEqual(self.counts(branch="Unit 2"), (4, 2, 20))

    def test_a_department_name_covers_every_unit_that_has_one(self):
        self.assertEqual(self.counts(department="Stitching"), (15, 8, 150))  # C D and the leaver F
        self.assertEqual(self.counts(department="Stitching", branch="Unit 1"), (11, 6, 130))  # C and F only

    def test_staff_and_production(self):
        self.assertEqual(self.counts(type="staff"), (8, 2, 21))
        self.assertEqual(self.counts(type="production"), (20, 12, 179))

    def test_combined_filters(self):
        self.assertEqual(self.counts(department="Cutting", type="production"), (5, 4, 29))  # B alone

    def test_a_scope_with_no_breaks_has_no_rates(self):
        s = self.api("summary", department="Admin", type="production")
        self.assertEqual(s["metrics"]["breaks"]["value"], 0)
        self.assertIsNone(s["metrics"]["overrunPct"]["value"])
        self.assertIsNone(s["metrics"]["minutesLost"]["value"])
        self.assertIn("No tea-break scans were recorded", " ".join(s["notes"]))

    def test_a_typo_is_matched_and_said(self):
        s = self.api("summary", department="stiching")
        self.assertEqual(s["metrics"]["breaks"]["value"], 15)
        self.assertIn("Matched department 'stiching' to 'Stitching'.", s["notes"])

    def test_the_scope_applies_to_every_endpoint(self):
        for name in ("trend", "departments", "shifts", "heatmap", "offenders"):
            body = self.api(name, branch="Unit 2")
            self.assertEqual(body["scope"]["description"], "Unit 2 · all departments · staff and production", name)
        self.assertEqual(sum(r["breaks"] for r in self.api("departments", branch="Unit 2")["rows"]), 4)
        self.assertEqual(sum(r["breaks"] for r in self.api("shifts", branch="Unit 2")["rows"]), 4)
        self.assertEqual(sum(p["breaks"] for p in self.api("trend", branch="Unit 2")["points"]), 4)
        self.assertEqual(self.api("heatmap", branch="Unit 2")["totalBreaks"], 4)
        self.assertEqual(self.api("offenders", branch="Unit 2", min=1)["overrunners"], 1)  # D


# ═════════════════════════════════════════════════════════════════════════════════════════════════════════════════
# trend
# ═════════════════════════════════════════════════════════════════════════════════════════════════════════════════

DAILY = {  # date: (breaks, measured, overruns, minutes lost, overrun %)
    "2026-09-01": (1, 1, 0, 0, 0.0),
    "2026-09-02": (5, 5, 2, 8, 40.0),
    "2026-09-03": (4, 4, 3, 17, 75.0),
    "2026-09-04": (4, 4, 3, 35, 75.0),
    "2026-09-05": (4, 4, 3, 45, 75.0),
    "2026-09-06": (2, 2, 1, 45, 50.0),
    "2026-09-07": (1, 1, 1, 45, 100.0),
    "2026-09-08": (2, 1, 0, 0, 0.0),
    "2026-09-09": (1, 0, 0, None, None),
    "2026-09-10": (1, 1, 0, 0, 0.0),
    "2026-09-11": (0, 0, 0, None, None),
    "2026-09-12": (1, 0, 0, None, None),
    "2026-09-13": (1, 0, 0, None, None),
    "2026-09-14": (1, 1, 1, 5, 100.0),
}


class TrendTests(GoldenBase):
    def test_every_day_equals_the_hand_count_and_empty_days_have_no_rate(self):
        t = self.api("trend")
        self.assertEqual(t["granularity"], "day")
        got = {
            p["date"]: (p["breaks"], p["measured"], p["overruns"], p["minutesLost"], p["overrunPct"])
            for p in t["points"]
        }
        self.assertEqual(got, DAILY)

    def test_the_seven_day_average_pools_the_days_instead_of_averaging_percentages(self):
        points = {p["date"]: p for p in self.api("trend")["points"]}
        # 09-07: measured 1+5+4+4+4+2+1 = 21, overruns 0+2+3+3+3+1+1 = 13 -> 61.9 (not the mean of the daily %s)
        self.assertEqual(points["2026-09-07"]["maOverrunPct"], 61.9)
        self.assertEqual(points["2026-09-07"]["maMinutesLost"], 27.9)  # (0+8+17+35+45+45+45) / 7
        # 09-14: only d4 and e3.. in 09-08..09-14: measured 3, overruns 1
        self.assertEqual(points["2026-09-14"]["maOverrunPct"], 33.3)
        self.assertEqual(points["2026-09-14"]["maMinutesLost"], 0.7)  # 5 / 7

    def test_the_first_days_average_reaches_back_before_the_period(self):
        first = self.api("trend")["points"][0]
        # window 08-26..09-01 holds e2 (08-31, an overrun of 5 minutes) and e1: 1 overrun of 2 measured
        self.assertEqual(first["maOverrunPct"], 50.0)
        self.assertEqual(first["maMinutesLost"], 0.7)

    def test_the_worst_day_needs_enough_breaks(self):
        self.assertIsNone(self.api("trend")["worstDay"])  # no day has the 10 measured breaks it takes
        with mock.patch.object(tea, "MIN_DAY_BREAKS", 4):
            worst = self.api("trend")["worstDay"]
        self.assertEqual((worst["date"], worst["minutesLost"], worst["overrunPct"]), ("2026-09-05", 45, 75.0))

    def test_better_or_worse_needs_enough_breaks_on_both_sides(self):
        m = self.api("trend")["momentum"]
        self.assertEqual(m["verdict"], "unclear")  # only 3 measured breaks in 08-Sep..14-Sep
        self.assertEqual((m["current"]["start"], m["current"]["end"]), ("2026-09-08", "2026-09-14"))
        self.assertEqual((m["previous"]["start"], m["previous"]["end"]), ("2026-09-01", "2026-09-07"))
        self.assertEqual((m["current"]["measured"], m["previous"]["measured"]), (3, 21))
        with mock.patch.object(tea, "MIN_SAMPLE_BREAKS", 3):
            m = self.api("trend")["momentum"]
        self.assertEqual(m["verdict"], "better")
        self.assertEqual((m["current"]["overrunPct"], m["previous"]["overrunPct"]), (33.3, 61.9))
        self.assertEqual(m["overrunPctChange"]["abs"], -28.6)
        self.assertEqual(m["current"]["minutesLost"], 5)
        self.assertEqual(m["previous"]["minutesLost"], 195)
        self.assertTrue(m["text"].startswith("Getting better: 33.3% of breaks ran over in the 7 days to 14 Sep"))

    def test_a_long_period_is_rolled_up_by_week(self):
        t = self.api("trend", **{"from": "2026-06-01", "to": "2026-09-14"})
        self.assertEqual(t["granularity"], "week")
        self.assertEqual(len(t["points"]), 16)  # fifteen full weeks and Monday 14-Sep
        week = {p["date"]: p for p in t["points"]}
        full = week["2026-08-31"]
        self.assertEqual((full["days"], full["breaks"], full["measured"], full["overruns"]), (7, 21, 21, 13))
        self.assertEqual((full["minutesLost"], full["overrunPct"]), (155, 61.9))  # e2 5 + the first week's 150
        last_full = week["2026-09-07"]
        self.assertEqual((last_full["breaks"], last_full["measured"], last_full["overruns"]), (7, 3, 1))
        self.assertEqual((last_full["minutesLost"], last_full["overrunPct"]), (45, 33.3))
        partial = week["2026-09-14"]
        self.assertEqual((partial["days"], partial["breaks"], partial["minutesLost"]), (1, 1, 5))
        self.assertIsNone(full["maOverrunPct"])  # a week is already a 7-day figure
        self.assertEqual(t["momentum"]["windowDays"], 7)

    def test_a_single_day_period_still_has_its_neighbours_for_the_verdict(self):
        t = self.api("trend", **{"from": "2026-09-14", "to": "2026-09-14"})
        self.assertEqual(len(t["points"]), 1)
        self.assertEqual(t["momentum"]["current"]["start"], "2026-09-08")


# ═════════════════════════════════════════════════════════════════════════════════════════════════════════════════
# departments, units, staff vs production
# ═════════════════════════════════════════════════════════════════════════════════════════════════════════════════


class RankingTests(GoldenBase):
    def test_departments_by_name_ranked_by_minutes_lost(self):
        d = self.api("departments")
        self.assertEqual(d["by"], "department")
        self.assertEqual([r["label"] for r in d["rows"]], ["Stitching", "Cutting", "Admin", "No department"])
        rows = by_label(d)
        s = rows["Stitching"]  # C, D (two units) and the leaver F
        self.assertEqual((s["breaks"], s["measured"], s["overruns"], s["minutesLost"]), (15, 12, 8, 150))
        self.assertEqual((s["avgMinutes"], s["overrunPct"], s["shareOfLostPct"]), (26.5, 66.7, 75.0))
        self.assertEqual((s["headcount"], s["employees"], s["participationPct"]), (2, 3, 100.0))  # F scanned but left
        c = rows["Cutting"]
        self.assertEqual((c["breaks"], c["measured"], c["overruns"], c["minutesLost"]), (11, 10, 6, 50))
        self.assertEqual((c["avgMinutes"], c["overrunPct"], c["shareOfLostPct"]), (19.0, 60.0, 25.0))
        a = rows["Admin"]
        self.assertEqual((a["breaks"], a["measured"], a["overruns"], a["minutesLost"]), (2, 2, 0, 0))
        self.assertEqual((a["avgMinutes"], a["overrunPct"], a["shareOfLostPct"]), (12.5, 0.0, 0.0))

    def test_a_department_nobody_scans_in_is_listed_without_a_rate(self):
        none = by_label(self.api("departments"))["No department"]  # G is active and never scans
        self.assertEqual((none["breaks"], none["headcount"], none["participationPct"]), (0, 1, 0.0))
        self.assertIsNone(none["overrunPct"])
        self.assertIsNone(none["minutesLost"])
        self.assertIsNone(none["avgMinutes"])
        self.assertEqual(none["key"], tea.NONE_KEY)

    def test_change_against_the_previous_period(self):
        rows = by_label(self.api("departments"))
        self.assertEqual(rows["Stitching"]["previous"], {"breaks": 3, "overrunPct": 33.3, "minutesLost": 35})
        self.assertEqual(rows["Stitching"]["change"]["overrunPct"], {"abs": 33.4, "pct": 100.3})
        self.assertEqual(rows["Stitching"]["change"]["minutesLost"], {"abs": 115, "pct": 328.6})
        self.assertEqual(rows["Cutting"]["change"]["overrunPct"]["abs"], 10.0)  # 60.0 against 50.0
        self.assertEqual(rows["Admin"]["previous"], {"breaks": 1, "overrunPct": 100.0, "minutesLost": 5})
        self.assertEqual(rows["Admin"]["change"]["overrunPct"]["abs"], -100.0)
        self.assertIsNone(rows["No department"]["change"]["overrunPct"])  # no rate on either side

    def test_small_samples_are_marked(self):
        d = self.api("departments")
        self.assertEqual(d["minSample"], 20)
        self.assertTrue(all(r["lowSample"] for r in d["rows"]))
        with mock.patch.object(tea, "MIN_SAMPLE_BREAKS", 12):
            rows = by_label(self.api("departments"))
        self.assertFalse(rows["Stitching"]["lowSample"])  # 12 measured
        self.assertTrue(rows["Cutting"]["lowSample"])  # 10 measured

    def test_the_overall_average_is_the_scope_wide_rate(self):
        avg = self.api("departments")["average"]
        self.assertEqual(
            (avg["overrunPct"], avg["avgMinutes"], avg["measured"], avg["minutesLost"]), (58.3, 22.2, 24, 200)
        )

    def test_units(self):
        d = self.api("departments", by="unit")
        rows = by_label(d)
        self.assertEqual(set(rows), {"Unit 1", "Unit 2", "No unit"})
        u1, u2 = rows["Unit 1"], rows["Unit 2"]
        self.assertEqual((u1["breaks"], u1["measured"], u1["overruns"], u1["minutesLost"]), (24, 20, 12, 180))
        self.assertEqual((u1["avgMinutes"], u1["overrunPct"]), (22.9, 60.0))
        self.assertEqual((u2["breaks"], u2["measured"], u2["overruns"], u2["minutesLost"]), (4, 4, 2, 20))
        self.assertEqual((u2["avgMinutes"], u2["overrunPct"], u2["headcount"]), (19.0, 50.0, 1))
        self.assertEqual(d["rows"][0]["label"], "Unit 1")

    def test_staff_and_production(self):
        rows = by_label(self.api("departments", by="type"))
        staff, production = rows["Staff"], rows["Production"]
        self.assertEqual((staff["breaks"], staff["measured"], staff["overruns"], staff["minutesLost"]), (8, 7, 2, 21))
        self.assertEqual((staff["avgMinutes"], staff["overrunPct"]), (16.6, 28.6))
        self.assertEqual(
            (production["breaks"], production["measured"], production["overruns"], production["minutesLost"]),
            (20, 17, 12, 179),
        )
        self.assertEqual((production["avgMinutes"], production["overrunPct"]), (24.5, 70.6))
        self.assertEqual((staff["key"], production["key"]), ("staff", "production"))

    def test_every_view_adds_up_to_the_same_totals(self):
        summary = self.api("summary")["metrics"]
        for by in ("department", "unit", "type"):
            rows = self.api("departments", by=by, limit=25)["rows"]
            self.assertEqual(sum(r["breaks"] for r in rows), summary["breaks"]["value"], by)
            self.assertEqual(sum(r["overruns"] for r in rows), summary["overruns"]["value"], by)
            self.assertEqual(sum(r["minutesLost"] or 0 for r in rows), summary["minutesLost"]["value"], by)
        rows = self.api("shifts", limit=25)["rows"]
        self.assertEqual(sum(r["breaks"] for r in rows), summary["breaks"]["value"])
        self.assertEqual(sum(r["minutesLost"] or 0 for r in rows), summary["minutesLost"]["value"])

    def test_lists_are_capped_and_say_so(self):
        d = self.api("departments", limit=2)
        self.assertEqual((len(d["rows"]), d["total"], d["truncated"]), (2, 4, True))
        self.assertEqual([r["label"] for r in d["rows"]], ["Stitching", "Cutting"])
        self.assertFalse(self.api("departments", limit=25)["truncated"])
        self.assertEqual(len(self.api("departments", limit=999)["rows"]), 4)  # clamped to 25, not an error

    def test_a_bad_grouping_is_a_readable_error(self):
        r = self.get("/api/md/tea-break/departments", **P, by="weather")
        self.assertEqual(r.status_code, 400)
        self.assertIn("'by' must be one of", r.json()["error"])
        r = self.get("/api/md/tea-break/departments", **P, limit="many")
        self.assertEqual(r.status_code, 400)
        self.assertIn("'limit' must be a whole number", r.json()["error"])


# ═════════════════════════════════════════════════════════════════════════════════════════════════════════════════
# shifts
# ═════════════════════════════════════════════════════════════════════════════════════════════════════════════════


class ShiftTests(GoldenBase):
    def test_breaks_count_under_the_shift_in_force_the_day_they_started(self):
        d = self.api("shifts")
        rows = by_label(d)
        self.assertEqual(set(rows), {"Morning (Unit 1)", "Evening", "Morning (Unit 2)", "No shift assigned"})
        m1, ev, m2, none = (
            rows["Morning (Unit 1)"],
            rows["Evening"],
            rows["Morning (Unit 2)"],
            rows["No shift assigned"],
        )
        # Morning U1: A 6 breaks (2 over, 21 lost) + B's three before 05-Sep (3 over, 14) + C's three from 08-Sep (not
        # measured) + F's 05-Sep break (1 over, 10)
        self.assertEqual((m1["breaks"], m1["measured"], m1["overruns"], m1["minutesLost"]), (13, 9, 6, 45))
        self.assertEqual((m1["avgMinutes"], m1["overrunPct"]), (19.4, 66.7))
        self.assertEqual(m1["employees"], 4)  # A B C F
        # Evening: B's two from 05-Sep + C's six before 08-Sep
        self.assertEqual((ev["breaks"], ev["measured"], ev["overruns"], ev["minutesLost"]), (8, 8, 6, 135))
        self.assertEqual((ev["avgMinutes"], ev["overrunPct"]), (30.9, 75.0))
        self.assertEqual(ev["employees"], 2)
        self.assertEqual((m2["breaks"], m2["measured"], m2["overruns"], m2["minutesLost"]), (4, 4, 2, 20))
        self.assertEqual((m2["avgMinutes"], m2["overrunPct"]), (19.0, 50.0))
        # E has no assignment; F's 06-Sep break is after her assignment ended
        self.assertEqual((none["breaks"], none["measured"], none["overruns"], none["minutesLost"]), (3, 3, 0, 0))
        self.assertEqual((none["avgMinutes"], none["overrunPct"]), (11.7, 0.0))
        self.assertEqual(none["employees"], 2)
        self.assertEqual(
            [r["label"] for r in d["rows"]], ["Evening", "Morning (Unit 1)", "Morning (Unit 2)", "No shift assigned"]
        )

    def test_two_assignments_that_overlap_resolve_to_the_later_start(self):
        """C is on Evening (open-ended) AND on Morning from 08-Sep: c1..c6 belong to Evening, c7 c8 o3 to Morning."""
        rows = by_label(self.api("shifts", department="Stitching", branch="Unit 1"))  # C and the leaver F
        self.assertEqual(rows["Evening"]["breaks"], 6)  # c1..c6
        self.assertEqual(rows["Morning"]["breaks"], 4)  # c7 c8 o3, and F's 05-Sep break (F's assignment ended that day)
        self.assertEqual(rows["No shift assigned"]["breaks"], 1)  # F's 06-Sep break: her assignment has ended

    def test_a_shift_change_in_mid_period_moves_the_breaks_by_date(self):
        # B: 02, 03, 04-Sep -> Morning (3 overruns, 14 lost); 05-Sep and 08-Sep -> Evening (1 overrun, 15 lost)
        only_b = by_label(self.api("shifts", department="Cutting", type="production"))
        self.assertEqual((only_b["Morning"]["breaks"], only_b["Morning"]["minutesLost"]), (3, 14))
        self.assertEqual((only_b["Evening"]["breaks"], only_b["Evening"]["minutesLost"]), (2, 15))

    def test_shift_names_shared_by_two_units_are_told_apart_and_timings_shown(self):
        rows = by_label(self.api("shifts"))
        self.assertEqual(rows["Morning (Unit 1)"]["sub"], "09:00–17:30 · Staff")
        self.assertEqual(rows["Morning (Unit 2)"]["sub"], "07:00–15:30 · Production")
        self.assertEqual(rows["Evening"]["sub"], "14:00–22:00 · Production")
        self.assertEqual(rows["Evening"]["key"], str(self.evening.id))
        self.assertEqual(rows["No shift assigned"]["key"], tea.NONE_KEY)
        self.assertIsNone(rows["Evening"]["headcount"])

    def test_change_against_the_previous_period(self):
        rows = by_label(self.api("shifts"))
        # previous: Morning U1 = p1 p2 p3 p7, Evening = p4 p5, Morning U2 = p6, none = e2
        self.assertEqual(rows["Morning (Unit 1)"]["previous"], {"breaks": 4, "overrunPct": 50.0, "minutesLost": 20})
        self.assertEqual(rows["Evening"]["previous"], {"breaks": 2, "overrunPct": 0.0, "minutesLost": 0})
        self.assertEqual(rows["Morning (Unit 2)"]["previous"], {"breaks": 1, "overrunPct": 100.0, "minutesLost": 35})
        self.assertEqual(rows["No shift assigned"]["previous"], {"breaks": 1, "overrunPct": 100.0, "minutesLost": 5})
        self.assertEqual(rows["Evening"]["change"]["overrunPct"], {"abs": 75.0, "pct": None})  # from 0.0: no percent

    def test_a_long_run_of_unassigned_employees_is_mentioned(self):
        notes = " ".join(self.api("shifts")["notes"])
        self.assertIn("3 of 28 breaks are by employees with no shift assigned that day", notes)

    def test_the_provenance_explains_the_attribution(self):
        ids = {p["id"]: p for p in self.api("shifts")["provenance"]}
        self.assertIn("overlap", ids["tea-shift"]["definition"])
        self.assertIn("later", ids["tea-shift"]["definition"])


# ═════════════════════════════════════════════════════════════════════════════════════════════════════════════════
# heat map
# ═════════════════════════════════════════════════════════════════════════════════════════════════════════════════


class HeatmapTests(GoldenBase):
    def cell(self, body, weekday, slot):
        found = [c for c in body["cells"] if (c["weekday"], c["slot"]) == (weekday, slot)]
        return found[0] if found else None

    def test_cells_equal_the_hand_count(self):
        h = self.api("heatmap")
        self.assertEqual(h["totalBreaks"], 28)
        self.assertEqual(sum(c["breaks"] for c in h["cells"]), 28)
        # Thursday 10:00: a3 c2 d2 (03-Sep) and e3 (10-Sep): two overruns (a3 1 + c2 15 = 16 lost)
        thu = self.cell(h, 3, 20)
        self.assertEqual((thu["breaks"], thu["measured"], thu["overruns"], thu["minutesLost"]), (4, 4, 2, 16))
        # Saturday 10:00: a5 c4 f1: two overruns (20 + 10)
        sat = self.cell(h, 5, 20)
        self.assertEqual((sat["breaks"], sat["measured"], sat["overruns"], sat["minutesLost"]), (3, 3, 2, 30))
        # 10:29 and 10:30 fall in different slots: a4 started 10:05, b-breaks at 10:30
        self.assertEqual(self.cell(h, 4, 20)["breaks"], 2)  # Friday: a4 (10:05) c3 (10:00)
        self.assertEqual(self.cell(h, 4, 21)["breaks"], 1)  # Friday: b3 (10:30)
        self.assertEqual(self.cell(h, 4, 32)["breaks"], 1)  # Friday 16:00: d3

    def test_a_cell_with_too_few_measured_breaks_has_a_count_but_no_rate(self):
        h = self.api("heatmap")
        thu = self.cell(h, 3, 20)
        self.assertEqual(h["minCellBreaks"], 5)
        self.assertIsNone(thu["overrunPct"])
        with mock.patch.object(tea, "MIN_CELL_BREAKS", 4):
            thu = self.cell(self.api("heatmap"), 3, 20)
        self.assertEqual(thu["overrunPct"], 50.0)

    def test_the_grid_spans_the_slots_that_have_breaks(self):
        h = self.api("heatmap")
        self.assertEqual(h["slots"][0], {"index": 0, "label": "00:00"})  # e1 at midnight
        self.assertEqual(h["slots"][-1], {"index": 47, "label": "23:30"})  # d4 at 23:50
        self.assertEqual(len(h["slots"]), 48)
        self.assertEqual(h["weekdays"], ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"])
        mon_late = self.cell(h, 0, 47)
        self.assertEqual((mon_late["breaks"], mon_late["overruns"]), (1, 1))  # d4: Monday 14-Sep 23:50

    def test_the_busiest_slots_and_weekdays(self):
        h = self.api("heatmap")
        self.assertEqual(
            [(s["label"], s["breaks"]) for s in h["busiestSlots"]], [("10:00", 17), ("10:30", 5), ("00:00", 1)]
        )
        self.assertEqual(h["busiestSlots"][0]["sharePct"], 60.7)
        days = {d["label"]: d["breaks"] for d in h["byWeekday"]}
        self.assertEqual(days, {"Mon": 2, "Tue": 3, "Wed": 6, "Thu": 5, "Fri": 4, "Sat": 5, "Sun": 3})

    def test_the_worst_cells_are_named_only_when_they_have_a_rate(self):
        self.assertEqual(self.api("heatmap")["worstCells"], [])  # no cell has 5 measured breaks
        with mock.patch.object(tea, "MIN_CELL_BREAKS", 3):
            worst = self.api("heatmap")["worstCells"]
        self.assertEqual((worst[0]["weekday"], worst[0]["label"], worst[0]["overrunPct"]), ("Sat", "10:00", 66.7))

    def test_peak_times_for_the_assistant_leave_the_grid_out(self):
        peak = tea.tea_peak_times(Scope(), resolve_period(P))
        self.assertNotIn("cells", peak)
        self.assertEqual(peak["busiestSlots"][0]["label"], "10:00")

    def test_night_breaks_are_in_their_own_hours_by_indian_time_not_utc(self):
        h = self.api("heatmap", **{"from": "2026-09-15", "to": "2026-09-15"})
        # d5 starts 00:00 IST on Tuesday 15-Sep (UTC says Monday 14-Sep 18:30)
        cell = self.cell(h, 1, 0)
        self.assertEqual(cell["breaks"], 1)


# ═════════════════════════════════════════════════════════════════════════════════════════════════════════════════
# offenders
# ═════════════════════════════════════════════════════════════════════════════════════════════════════════════════


class OffenderTests(GoldenBase):
    def test_repeat_overrunners_with_their_worst_case(self):
        o = self.api("offenders")
        self.assertEqual((o["threshold"], o["total"], o["overrunners"]), (3, 2, 5))
        self.assertEqual([r["employeeCode"] for r in o["rows"]], ["C", "B"])  # 5 overruns, then 4
        c, b = o["rows"]
        self.assertEqual(c["employeeName"], "Chitra Test")
        self.assertEqual((c["department"], c["unit"], c["type"]), ("Stitching", "Unit 1", "Production"))
        self.assertEqual((c["breaks"], c["measured"], c["overruns"], c["overrunPct"]), (9, 6, 5, 83.3))
        self.assertEqual((c["minutesLost"], c["averageOverBy"]), (120, 24.0))
        # c5 and c6 are both 60 minutes; the earlier one (06-Sep) is the worst case
        self.assertEqual((c["worstMinutes"], c["worstOverBy"], c["worstDate"]), (60, 45, "2026-09-06"))
        self.assertEqual((b["breaks"], b["measured"], b["overruns"], b["overrunPct"]), (5, 5, 4, 80.0))
        self.assertEqual(b["minutesLost"], 29)
        self.assertEqual((b["worstMinutes"], b["worstOverBy"], b["worstDate"]), (30, 15, "2026-09-05"))  # b4

    def test_how_much_of_the_lost_time_they_account_for(self):
        o = self.api("offenders")
        self.assertEqual(o["minutesLostByRepeaters"], 149)  # 120 + 29 of the 200 lost
        self.assertEqual(o["shareOfMinutesLostPct"], 74.5)

    def test_the_threshold_is_a_parameter(self):
        o = self.api("offenders", min=2)
        self.assertEqual(
            [r["employeeCode"] for r in o["rows"]], ["C", "B", "A", "D"]
        )  # A and D tie on 2: more lost first
        self.assertEqual(o["total"], 4)
        o = self.api("offenders", min=1)
        self.assertEqual(o["total"], 5)  # F overran once
        self.assertEqual(self.api("offenders", min=6)["total"], 0)

    def test_the_list_is_capped(self):
        o = self.api("offenders", limit=1)
        self.assertEqual((len(o["rows"]), o["total"], o["truncated"]), (1, 2, True))

    def test_nobody_is_named_unless_they_overran_repeatedly(self):
        names = {r["employeeCode"] for r in self.api("offenders")["rows"]}
        self.assertEqual(names, {"B", "C"})  # A and D overran twice, E never

    def test_provenance_states_the_threshold(self):
        entry = {p["id"]: p for p in self.api("offenders")["provenance"]}["tea-repeat"]
        self.assertIn("at least 3 times", entry["definition"])
        self.assertIn("3", entry["formula"])


# ═════════════════════════════════════════════════════════════════════════════════════════════════════════════════
# the rule, an empty database, permissions, parameters
# ═════════════════════════════════════════════════════════════════════════════════════════════════════════════════


class RuleTests(MdApiTestCase):
    def test_the_rule_in_plain_words(self):
        TeaBreakRule.objects.create(pk=1, allowed_minutes=12)
        TeaBreakRule.objects.filter(pk=1).update(updated_at=ist(9, 3, 12, 0))
        r = self.get("/api/md/tea-break/rule").json()
        self.assertEqual((r["allowedMinutes"], r["isDefault"], r["updatedAt"]), (12, False, "2026-09-03"))
        self.assertEqual((r["missedScanMinutes"], r["notReturnedMinutes"], r["leftOpenHours"]), (60, 60, 12))
        self.assertFalse(r["hasGrace"])
        self.assertFalse(r["hasWindows"])
        text = " ".join(r["statements"])
        self.assertIn("up to 12 minutes", text)
        self.assertIn("no grace period", text)
        self.assertIn("a 15-minute break with 12 allowed loses 3 minutes", text)
        self.assertIn("longer than 60 minutes", text)
        self.assertIn("do not affect attendance or payroll", text)
        self.assertEqual(r["provenance"][0]["id"], "tea-rule")
        self.assertNotIn("period", r)  # the rule has no period or scope

    def test_without_a_saved_rule_the_default_is_used_and_nothing_is_created(self):
        self.assertEqual(TeaBreakRule.objects.count(), 0)
        r = self.get("/api/md/tea-break/rule").json()
        self.assertEqual((r["allowedMinutes"], r["isDefault"], r["updatedAt"]), (15, True, None))
        self.assertIn("No tea-break rule has been saved yet", " ".join(r["notes"]))
        self.get("/api/md/tea-break/summary", period="last_7_days")
        self.get("/api/md/tea-break/attention", period="last_7_days")
        self.assertEqual(TeaBreakRule.objects.count(), 0)  # a read never writes (TeaBreakRule.get() would have)

    def test_an_allowance_at_the_missed_scan_cut_off_cannot_measure_overruns_and_says_so(self):
        TeaBreakRule.objects.create(pk=1, allowed_minutes=60)
        r = self.get("/api/md/tea-break/rule").json()
        self.assertIn("no break can be counted as an overrun", " ".join(r["notes"]))


class EmptyDatabaseTests(MdApiTestCase):
    """Nothing in the database: no division by zero, "no data" is null and never 0."""

    def setUp(self):
        super().setUp()
        freeze_clock(self)

    def api(self, name, **params):
        r = self.get(f"/api/md/tea-break/{name}", **{**P, **params})
        self.assertEqual(r.status_code, 200, r.content)
        return r.json()

    def test_summary(self):
        s = self.api("summary")
        m = s["metrics"]
        self.assertEqual((m["breaks"]["value"], m["employees"]["value"], m["overruns"]["value"]), (0, 0, 0))
        for key in ("avgMinutes", "overrunPct", "compliancePct", "minutesLost"):
            self.assertIsNone(m[key]["value"], key)
            self.assertIsNone(m[key]["change"], key)
        self.assertIsNone(s["hoursLost"])
        self.assertIsNone(s["withinAllowance"])
        self.assertIsNone(s["coverage"]["participationPct"])
        self.assertIsNone(s["coverage"]["unmeasuredPct"])
        self.assertIn("No tea-break scans were recorded", " ".join(s["notes"]))

    def test_every_other_endpoint(self):
        t = self.api("trend")
        self.assertEqual(len(t["points"]), 14)
        self.assertTrue(
            all(p["breaks"] == 0 and p["overrunPct"] is None and p["minutesLost"] is None for p in t["points"])
        )
        self.assertEqual(t["momentum"]["verdict"], "unclear")
        self.assertIsNone(t["worstDay"])
        self.assertEqual(self.api("departments")["rows"], [])
        self.assertEqual(self.api("shifts")["rows"], [])
        h = self.api("heatmap")
        self.assertEqual((h["cells"], h["slots"], h["busiestSlots"], h["totalBreaks"]), ([], [], [], 0))
        o = self.api("offenders")
        self.assertEqual((o["rows"], o["total"], o["overrunners"]), ([], 0, 0))
        self.assertIsNone(o["shareOfMinutesLostPct"])
        self.assertEqual(self.api("attention")["items"], [])

    def test_the_dashboard_pieces(self):
        self.assertEqual(tea.insights(today=TODAY), [])
        h = tea.headline(today=TODAY)
        self.assertEqual([k["id"] for k in h["kpis"]], ["tea-break.overrun-pct", "tea-break.minutes-lost"])
        for kpi in h["kpis"]:
            self.assertIsNone(kpi["value"])
            self.assertIsNone(kpi["delta"])
            self.assertEqual(len(kpi["spark"]), 14)
            self.assertTrue(all(v is None for v in kpi["spark"]))
        self.assertIn("No tea-break scans", h["kpis"][0]["sub"])

    def test_employees_but_no_scans_show_zero_participation(self):
        branch = Branch.objects.create(name="Unit 1", code="U1")
        Employee.objects.create(employee_code="Z1", first_name="Z", last_name="One", branch=branch)
        s = self.api("summary")
        self.assertEqual((s["coverage"]["activeEmployees"], s["coverage"]["participationPct"]), (1, 0.0))


class PermissionTests(TestCase):
    def test_only_the_md_gets_through_on_every_route(self):
        md = make_md()
        admin = HRUser.objects.create(username="root", password_hash="x", is_super_admin=True)
        role = Role.objects.create(name="Wide", permissions={"employees": "edit", "payroll": "edit", "reports": "edit"})
        clerk = HRUser.objects.create(username="clerk", password_hash="x", role=role)
        employee = Employee.objects.create(
            employee_code="E1", first_name="A", last_name="B", branch=Branch.objects.create(name="HO")
        )
        emp_token = sign_token({"role": "employee", "employeeId": employee.id, "name": "A B"})
        for route in ROUTES:
            url = f"/api/md/tea-break/{route}"
            self.assertEqual(self.client.get(url, **md_headers(md)).status_code, 200, route)
            self.assertEqual(self.client.get(url, **md_headers(admin)).status_code, 403, route)
            self.assertEqual(self.client.get(url, **md_headers(clerk)).status_code, 403, route)
            self.assertEqual(self.client.get(url, HTTP_AUTHORIZATION=f"Bearer {emp_token}").status_code, 403, route)
            self.assertEqual(self.client.get(url).status_code, 401, route)
            self.assertEqual(self.client.post(url, **md_headers(md)).status_code, 405, route)

    def test_the_md_loses_access_the_moment_the_identity_is_taken_away(self):
        md = make_md()
        url = "/api/md/tea-break/rule"
        self.assertEqual(self.client.get(url, **md_headers(md)).status_code, 200)
        HRUser.objects.filter(pk=md.pk).update(is_md=False)
        self.assertEqual(self.client.get(url, **md_headers(md)).status_code, 403)


class ParameterTests(MdApiTestCase):
    def test_bad_requests_are_400_with_a_readable_message(self):
        cases = [
            ({"period": "fortnight"}, "Unknown period"),
            ({"from": "2026-09-01"}, "both"),
            ({"from": "2026-09-10", "to": "2026-09-01"}, "before"),
            ({"department": "Quantum Physics"}, "No department called"),
            ({"branch": "Nowhere"}, "No unit called"),
            ({"type": "contract"}, "staff or production"),
        ]
        for route in [r for r in ROUTES if r != "rule"]:  # the rule has no period or scope to get wrong
            for params, text in cases:
                r = self.get(f"/api/md/tea-break/{route}", **params)
                self.assertEqual(r.status_code, 400, (route, params))
                self.assertIn(text, r.json()["error"])

    def test_the_default_period_is_the_last_30_days(self):
        s = self.get("/api/md/tea-break/summary").json()
        self.assertEqual(s["period"]["preset"], "last_30_days")
        self.assertEqual(s["period"]["days"], 30)


# ═════════════════════════════════════════════════════════════════════════════════════════════════════════════════
# needs your attention, the Dashboard's insights and headline
# ═════════════════════════════════════════════════════════════════════════════════════════════════════════════════

CUR = date(2026, 9, 9)  # a day in 08-Sep..14-Sep, the last 7 complete days before TODAY
PREV = date(2026, 9, 2)  # a day in 01-Sep..07-Sep, the 7 days before them


class ExceptionsBase(TestCase):
    """Small windows on purpose: the minimum sample is lowered where a test says so.

    Stitching (X1 X2, the Evening shift) and Cutting (Y1 Y2, the Morning shift) in Unit 1, plus Z1..Z6 who never scan
    (so 4 of 10 active employees scan = 40 %).
    """

    def setUp(self):
        super().setUp()
        freeze_clock(self)
        self.unit = Branch.objects.create(name="Unit 1", code="U1")
        self.stitching = Department.objects.create(name="Stitching", branch=self.unit)
        self.cutting = Department.objects.create(name="Cutting", branch=self.unit)
        TeaBreakRule.objects.create(pk=1, allowed_minutes=15)
        self.evening = ShiftTemplate.objects.create(
            name="Evening", branch=self.unit, shift_type="production", start_time=dtime(14, 0), end_time=dtime(22, 0)
        )
        self.morning = ShiftTemplate.objects.create(
            name="Morning", branch=self.unit, shift_type="staff", start_time=dtime(9, 0), end_time=dtime(17, 30)
        )

        def emp(code, dept, kind):
            return Employee.objects.create(
                employee_code=code,
                first_name=code,
                last_name="Test",
                department=dept,
                branch=self.unit,
                employment_type=kind,
            )

        self.x1, self.x2 = emp("X1", self.stitching, "production"), emp("X2", self.stitching, "production")
        self.y1, self.y2 = emp("Y1", self.cutting, "staff"), emp("Y2", self.cutting, "staff")
        for e, s in (
            (self.x1, self.evening),
            (self.x2, self.evening),
            (self.y1, self.morning),
            (self.y2, self.morning),
        ):
            EmployeeShiftAssignment.objects.create(employee=e, shift=s, effective_from=date(2026, 8, 1))
        self.silent = [emp(f"Z{i}", self.cutting, "staff") for i in range(1, 7)]

    def add(self, employee, day, *minutes):
        """Completed breaks of the given lengths (minutes, fractions allowed) on one day, starting 08:00 every 90 min."""
        start = datetime(day.year, day.month, day.day, 8, 0, tzinfo=FACTORY_TZ)
        for i, m in enumerate(minutes):
            out = start + timedelta(minutes=90 * i)
            TeaBreakLog.objects.create(employee=employee, out_at=out, in_at=out + timedelta(minutes=m))

    def add_open(self, employee, day, hour=18):
        TeaBreakLog.objects.create(
            employee=employee, out_at=datetime(day.year, day.month, day.day, hour, 0, tzinfo=FACTORY_TZ)
        )

    def alarming_world(self):
        """Last 7 days: 12 measured, 4 overruns (33.3 %); the 7 days before: 12 measured, 2 overruns (16.7 %)."""
        self.add(self.x1, date(2026, 9, 9), 20, 25, 10)
        self.add(self.x2, date(2026, 9, 9), 30, 12)
        self.add(self.x2, date(2026, 9, 10), 18)
        self.add(self.y1, date(2026, 9, 9), 10, 12, 14)
        self.add(self.y1, date(2026, 9, 10), 70)  # longer than 60 minutes: not measured
        self.add(self.y2, date(2026, 9, 10), 10, 15, 9)
        self.add_open(self.y2, date(2026, 9, 9))  # never closed: not measured
        self.add(self.x1, date(2026, 9, 2), 10, 12, 9)
        self.add(self.x2, date(2026, 9, 2), 20, 25, 11)
        self.add(self.y1, date(2026, 9, 3), 10, 11, 8)
        self.add(self.y2, date(2026, 9, 3), 12, 13, 9)

    def ids(self, items):
        return [i["id"] for i in items]


class ExceptionTests(ExceptionsBase):
    def test_what_the_mds_dashboard_is_told(self):
        self.alarming_world()
        with mock.patch.object(tea, "MIN_SAMPLE_BREAKS", 6):
            items = tea.insights(today=TODAY)
        # critical first (in the order found), then the warning, then information; five at most
        self.assertEqual(
            self.ids(items),
            ["tea-break.trend", "tea-break.department", "tea-break.shift", "tea-break.overall", "tea-break.coverage"],
        )
        self.assertEqual([i["severity"] for i in items], ["critical", "critical", "critical", "warning", "info"])
        for item in items:
            self.assertEqual(set(item), {"id", "severity", "title", "detail", "metric", "page", "ask"})
            self.assertEqual(item["page"], "tea-break")
            self.assertTrue(item["ask"].endswith("?"))
        by_id = {i["id"]: i for i in items}
        self.assertEqual(by_id["tea-break.trend"]["title"], "Break overruns rose to 33% from 17%")
        self.assertEqual(by_id["tea-break.trend"]["metric"], "+16.6 pts")
        self.assertEqual(
            by_id["tea-break.department"]["title"], "Stitching breaks run over 67% of the time, against 33% overall"
        )
        self.assertEqual(
            by_id["tea-break.shift"]["title"], "The Evening shift breaks run over 67% of the time, against 33% overall"
        )
        self.assertEqual(by_id["tea-break.overall"]["title"], "33% of tea breaks ran over the 15-minute allowance")
        self.assertEqual(by_id["tea-break.overall"]["metric"], "33 min lost")
        self.assertIn("4 of 12 breaks ran over", by_id["tea-break.overall"]["detail"])
        self.assertEqual(by_id["tea-break.coverage"]["title"], "Only 40% of employees scanned a tea break")

    def test_the_page_gets_the_same_findings_for_its_own_period_and_scope(self):
        self.alarming_world()
        with mock.patch.object(tea, "MIN_SAMPLE_BREAKS", 6):
            period = resolve_period({"from": "2026-09-08", "to": "2026-09-14"})
            body = tea.tea_attention(Scope(), period)
        self.assertEqual(len(body["items"]), 6)  # the page shows up to six: the two information items too
        self.assertEqual(self.ids(body["items"])[-1], "tea-break.unmeasured")
        self.assertIn("tea-attention", [p["id"] for p in body["provenance"]])

    def test_too_few_breaks_never_raise_an_alarm(self):
        self.alarming_world()
        items = tea.insights(today=TODAY)  # the real minimum (20 measured breaks) is not met
        self.assertEqual(self.ids(items), ["tea-break.coverage", "tea-break.unmeasured"])

    def test_a_group_must_be_clearly_worse_than_the_overall_rate(self):
        """Everyone overruns about the same: nobody is singled out."""
        for e in (self.x1, self.x2, self.y1, self.y2):
            self.add(e, date(2026, 9, 9), 20, 10, 10)  # 1 overrun in 3 for everybody: 33.3 % each
            self.add(e, date(2026, 9, 2), 20, 10, 10)
        with mock.patch.object(tea, "MIN_SAMPLE_BREAKS", 6):
            items = tea.insights(today=TODAY)
        self.assertEqual(self.ids(items), ["tea-break.overall", "tea-break.coverage"])

    def everyone_scans_in_the_last_week(self):
        """Z1..Z6 take one on-time break each in the last 7 days, so all 10 active employees have scanned."""
        for z in self.silent:
            self.add(z, date(2026, 9, 9), 10)

    def test_improvement_is_good_news(self):
        for e in (self.x1, self.x2, self.y1, self.y2):
            self.add(e, date(2026, 9, 9), 10, 12, 9)  # no overruns in the last 7 days...
        self.everyone_scans_in_the_last_week()
        self.add(self.silent[0], date(2026, 9, 10), 20)  # ...but one, by someone with no shift: 19 measured, 1 over
        for e in (self.x1, self.x2):
            self.add(e, date(2026, 9, 2), 20, 25, 30)  # six overruns of the 12 measured the week before: 50 %
        for e in (self.y1, self.y2):
            self.add(e, date(2026, 9, 2), 10, 12, 9)
        with mock.patch.object(tea, "MIN_SAMPLE_BREAKS", 6):
            items = tea.insights(today=TODAY)
        self.assertEqual(self.ids(items), ["tea-break.trend"])
        self.assertEqual(items[0]["severity"], "good")
        self.assertEqual(items[0]["title"], "Break overruns fell to 5% from 50%")
        self.assertEqual(items[0]["metric"], "-44.7 pts")

    def test_a_quiet_week_says_so(self):
        for e in (self.x1, self.x2, self.y1, self.y2):
            self.add(e, date(2026, 9, 9), 10, 12, 9)
            self.add(e, date(2026, 9, 2), 10, 12, 9)
        self.add(self.x1, date(2026, 9, 10), 20)  # one overrun in the last week...
        self.add(self.x1, date(2026, 9, 3), 20)  # ...and one the week before: no change worth a word
        self.everyone_scans_in_the_last_week()  # 19 measured, 1 overrun: 5.3 %
        with mock.patch.object(tea, "MIN_SAMPLE_BREAKS", 6):
            items = tea.insights(today=TODAY)
        self.assertEqual(self.ids(items), ["tea-break.healthy"])
        self.assertEqual(items[0]["severity"], "good")
        self.assertEqual(items[0]["title"], "No tea-break exceptions: 5% of breaks ran over the allowance")

    def test_repeat_overrunners_are_counted_without_names(self):
        for day in (9, 10, 11):
            self.add(self.x1, date(2026, 9, day), 30)  # three overruns of 15 minutes
        for z in self.silent:
            self.add(z, date(2026, 9, 3), 10)
        for e in (self.x2, self.y1, self.y2):
            self.add(e, date(2026, 9, 9), 10)
        items = tea.insights(today=TODAY)
        repeat = [i for i in items if i["id"] == "tea-break.repeat"][0]
        self.assertEqual(repeat["title"], "1 person overran their break 3 or more times")
        self.assertEqual(repeat["severity"], "warning")  # they account for all the lost time
        self.assertIn("100%", repeat["detail"])
        self.assertNotIn("X1", repeat["title"] + repeat["detail"])  # people are named on the page, not on the Dashboard

    def test_unmeasured_records_and_thin_coverage_are_reported_as_information(self):
        self.alarming_world()
        items = {i["id"]: i for i in tea.insights(today=TODAY)}
        self.assertEqual(items["tea-break.unmeasured"]["title"], "14% of tea-break records could not be measured")
        self.assertEqual(items["tea-break.unmeasured"]["severity"], "info")

    def test_the_headline_cards(self):
        self.alarming_world()
        h = tea.headline(today=TODAY)
        rate, lost = h["kpis"]
        self.assertEqual(
            (rate["id"], rate["label"], rate["format"], rate["value"]),
            ("tea-break.overrun-pct", "Break overruns", "pct", 33.3),
        )
        self.assertEqual(rate["delta"], {"abs": 16.6, "pct": 99.4, "good": "down"})
        self.assertEqual(rate["page"], "tea-break")
        self.assertIn("4 of 12 breaks ran over 15 min", rate["sub"])
        self.assertIn("08 Sep to 14 Sep", rate["sub"])
        self.assertEqual(
            rate["spark"],
            [None, 33.3, 0.0, None, None, None, None, None, 37.5, 25.0, None, None, None, None],
        )
        self.assertEqual((lost["id"], lost["format"], lost["value"]), ("tea-break.minutes-lost", "minutes", 33))
        self.assertEqual(lost["delta"], {"abs": 18, "pct": 120.0, "good": "down"})
        self.assertEqual(lost["spark"], [None, 15, 0, None, None, None, None, None, 30, 3, None, None, None, None])
        self.assertEqual([p["id"] for p in h["provenance"]], ["tea-overrun", "tea-minutes-lost", "tea-previous"])

    def test_the_headline_uses_complete_days_only(self):
        """Today's half-finished day must not flatter or hurt the week: the window ends yesterday."""
        self.add(self.x1, TODAY, 40)
        h = tea.headline(today=TODAY)
        self.assertIsNone(h["kpis"][0]["value"])
        self.assertEqual(tea.headline(today=TODAY + timedelta(days=1))["kpis"][0]["value"], 100.0)


# ═════════════════════════════════════════════════════════════════════════════════════════════════════════════════
# the assistant's tools
# ═════════════════════════════════════════════════════════════════════════════════════════════════════════════════


class ToolTests(GoldenBase):
    NAMES = {
        "tea_break_summary",
        "tea_break_breakdown",
        "tea_break_offenders",
        "tea_break_trend",
        "tea_break_peak_times",
        "tea_break_rule",
    }

    def tool(self, name):
        return registry.collect_tools()[name]

    def test_the_tools_are_registered_and_described_for_the_model(self):
        tools = registry.collect_tools()
        self.assertTrue(self.NAMES <= set(tools))
        for name in self.NAMES:
            spec = tools[name]
            self.assertEqual(spec.page, "tea-break")
            self.assertGreaterEqual(len(spec.description), 120, name)
        self.assertIn("period", self.tool("tea_break_summary").properties)
        self.assertNotIn("period", self.tool("tea_break_rule").properties)
        self.assertNotIn("branch", self.tool("tea_break_rule").properties)  # the rule is the same for everyone

    def test_summary_tool_is_the_same_number_as_the_page(self):
        result = self.tool("tea_break_summary").run({"from": P["from"], "to": P["to"]})
        self.assertEqual(result["metrics"]["minutesLost"]["value"], 200)
        self.assertEqual(result["metrics"]["overrunPct"]["value"], 58.3)
        self.assertTrue(result["provenance"])
        json.dumps(result)  # plain JSON, no dates or Decimals

    def test_breakdown_tool_groups_by_department_unit_type_or_shift(self):
        spec = self.tool("tea_break_breakdown")
        base = {"from": P["from"], "to": P["to"]}
        self.assertEqual(spec.run(base)["by"], "department")
        self.assertEqual(spec.run({**base, "by": "unit"})["by"], "unit")
        self.assertEqual(spec.run({**base, "by": "type"})["by"], "type")
        shifts = spec.run({**base, "by": "shift", "limit": 2})
        self.assertEqual(shifts["by"], "shift")
        self.assertEqual([r["label"] for r in shifts["rows"]], ["Evening", "Morning (Unit 1)"])
        with self.assertRaises(MdParamError):
            spec.run({**base, "by": "planet"})
        self.assertEqual(len(spec.run({**base, "limit": 500})["rows"]), 4)  # clamped to the maximum

    def test_offenders_tool_names_people_in_the_standard_key(self):
        result = self.tool("tea_break_offenders").run({"from": P["from"], "to": P["to"], "min_overruns": 4})
        self.assertEqual([r["employeeName"] for r in result["rows"]], ["Chitra Test", "Babu Test"])
        self.assertNotIn("name", result["rows"][0])
        self.assertEqual(result["threshold"], 4)

    def test_no_non_person_field_uses_a_name_key(self):
        """The assistant pseudonymises the standard person keys: a department or shift called "name" would be hidden."""
        for name in self.NAMES - {"tea_break_rule"}:
            text = json.dumps(self.tool(name).run({"from": P["from"], "to": P["to"]}))
            for key in ('"name":', '"fullName":', '"userName":', '"visitorName":', '"managerName":'):
                self.assertNotIn(key, text, (name, key))

    def test_trend_and_peak_time_tools(self):
        trend = self.tool("tea_break_trend").run({"from": P["from"], "to": P["to"]})
        self.assertEqual(len(trend["points"]), 14)
        self.assertEqual(trend["momentum"]["verdict"], "unclear")
        peak = self.tool("tea_break_peak_times").run({"from": P["from"], "to": P["to"]})
        self.assertEqual(peak["busiestSlots"][0]["label"], "10:00")
        self.assertNotIn("cells", peak)

    def test_rule_tool(self):
        rule = self.tool("tea_break_rule").run({})
        self.assertEqual(rule["allowedMinutes"], 15)
        self.assertTrue(rule["statements"])

    def test_every_tool_runs_read_only(self):
        for name in self.NAMES:
            with read_only_db():
                result = self.tool(name).run({"from": P["from"], "to": P["to"]})
            self.assertTrue(result["provenance"], name)


# ═════════════════════════════════════════════════════════════════════════════════════════════════════════════════
# agreement with the Report Center (the same rule must give the same numbers)
# ═════════════════════════════════════════════════════════════════════════════════════════════════════════════════


class ReportCenterParityTests(GoldenBase):
    """The Report Center's tea-break reports with "Leave out long / unclosed breaks" switched on use exactly the
    breaks this page measures, so their totals must equal the page's."""

    def setUp(self):
        super().setUp()
        self.root = HRUser.objects.create(username="rc_root", password_hash="x", is_super_admin=True)

    def report(self, rid, **params):
        query = {"dateFrom": P["from"], "dateTo": P["to"], "excludeSuspect": "true", **params}
        query = {k: v for k, v in query.items() if v is not None}  # excludeSuspect=None switches the filter off
        r = self.client.get(f"/api/reports/run/{rid}", query, **md_headers(self.root))
        self.assertEqual(r.status_code, 200, r.content[:400])
        return r.json()

    def test_totals_by_employee(self):
        rows = self.report("tea-break-employee-summary")["rows"]
        s = self.api("summary")["metrics"]
        self.assertEqual(sum(r["overtime"] for r in rows), s["overruns"]["value"])
        self.assertEqual(sum(r["overMinutesTotal"] for r in rows), s["minutesLost"]["value"])
        self.assertEqual(sum(r["completed"] for r in rows), s["measured"]["value"])
        self.assertEqual(
            round(sum(r["totalMinutes"] for r in rows) / sum(r["completed"] for r in rows), 1), s["avgMinutes"]["value"]
        )
        per_person = {r["employeeCode"]: r for r in rows}
        for offender in self.api("offenders", min=1)["rows"]:
            theirs = per_person[offender["employeeCode"]]
            self.assertEqual(theirs["overtime"], offender["overruns"])
            self.assertEqual(theirs["overMinutesTotal"], offender["minutesLost"])

    def test_every_day_of_the_daily_trend(self):
        rows = {r["date"]: r for r in self.report("tea-break-daily-trend")["rows"]}
        for point in self.api("trend")["points"]:
            theirs = rows[point["date"]]
            self.assertEqual(theirs["overtime"], point["overruns"], point["date"])
            self.assertEqual(theirs["overtimePct"], point["overrunPct"], point["date"])

    def test_staff_and_production_and_units(self):
        by_type = {r["group"]: r for r in self.report("tea-break-department-summary", groupBy="employmentType")["rows"]}
        ours = by_label(self.api("departments", by="type"))
        for label in ("Staff", "Production"):
            self.assertEqual(by_type[label]["overtime"], ours[label]["overruns"], label)
            self.assertEqual(by_type[label]["overtimePct"], ours[label]["overrunPct"], label)
        by_unit = {r["group"]: r for r in self.report("tea-break-department-summary", groupBy="branch")["rows"]}
        ours = by_label(self.api("departments", by="unit"))
        for label in ("Unit 1", "Unit 2"):
            self.assertEqual(by_unit[label]["overtime"], ours[label]["overruns"], label)
            self.assertEqual(
                round(by_unit[label]["avgMinutes"], 1), ours[label]["avgMinutes"], label
            )  # they keep 2 places

    def test_without_the_switch_the_report_counts_the_missed_scans_as_overtime(self):
        """That is the one difference, and the page says so: 2 breaks over 60 minutes are not in the page's overruns."""
        rows = self.report("tea-break-employee-summary", excludeSuspect=None)["rows"]
        self.assertEqual(sum(r["overtime"] for r in rows), 14 + 2)
        self.assertEqual(self.api("summary")["coverage"]["longCompleted"], 2)


# ═════════════════════════════════════════════════════════════════════════════════════════════════════════════════
# an independent check: random data, every endpoint against a plain-Python recomputation
# ═════════════════════════════════════════════════════════════════════════════════════════════════════════════════


class OracleTests(TestCase):
    """Builds a messy company (overlapping shifts, leavers, overnight and half-minute breaks, open breaks) and
    recomputes every figure in plain Python with the HR page's own ``tea_metrics``. A disagreement means either the SQL
    or the grouping is wrong."""

    ALLOWED = 15

    @classmethod
    def setUpTestData(cls):
        rng = random.Random(20260905)
        cls.rng = rng
        u1 = Branch.objects.create(name="Unit 1", code="OU1")
        u2 = Branch.objects.create(name="Unit 2", code="OU2")
        depts = [
            Department.objects.create(name="Cutting", branch=u1),
            Department.objects.create(name="Sewing", branch=u1),
            Department.objects.create(name="Sewing", branch=u2),
            Department.objects.create(name="Packing", branch=u2),
        ]
        TeaBreakRule.objects.create(pk=1, allowed_minutes=cls.ALLOWED)
        shifts = [
            ShiftTemplate.objects.create(name="Day", branch=u1, start_time=dtime(8, 0), end_time=dtime(16, 0)),
            ShiftTemplate.objects.create(name="Day", branch=u2, start_time=dtime(7, 0), end_time=dtime(15, 0)),
            ShiftTemplate.objects.create(name="Night", branch=u1, start_time=dtime(20, 0), end_time=dtime(5, 0)),
        ]
        cls.employees = []
        for i in range(18):
            dept = rng.choice(depts)
            cls.employees.append(
                Employee.objects.create(
                    employee_code=f"O{i:02d}",
                    first_name=f"First{i}",
                    last_name="Last",
                    department=None if i == 17 else dept,
                    branch=None if i == 17 else dept.branch,
                    employment_type=rng.choice(["staff", "production"]),
                    status="resigned" if i in (3, 11) else "active",
                )
            )
        for e in cls.employees:
            for _ in range(rng.choice([0, 1, 2, 3])):
                start = date(2026, 7, 15) + timedelta(days=rng.randint(0, 50))
                end = None if rng.random() < 0.5 else start + timedelta(days=rng.randint(0, 25))
                EmployeeShiftAssignment.objects.create(
                    employee=e, shift=rng.choice(shifts), effective_from=start, effective_to=end
                )
        rows = []
        for _ in range(900):
            e = rng.choice(cls.employees)
            day = date(2026, 7, 20) + timedelta(days=rng.randint(0, 56))  # 20-Jul .. 14-Sep
            hour = rng.choice([0, 1, 2, 9, 10, 10, 10, 11, 12, 15, 15, 16, 22, 23])
            out = datetime(
                day.year,
                day.month,
                day.day,
                hour,
                rng.choice([0, 5, 29, 30, 31, 45, 59]),
                rng.choice([0, 0, 30]),
                tzinfo=FACTORY_TZ,
            )
            kind = rng.random()
            if kind < 0.10:
                back = None
            elif kind < 0.20:
                back = out + timedelta(minutes=rng.randint(61, 240), seconds=rng.choice([0, 29, 31]))
            elif kind < 0.30:
                back = out + timedelta(minutes=rng.randint(40, 60), seconds=rng.choice([0, 29, 30, 31]))
            else:
                back = out + timedelta(minutes=rng.randint(2, 24), seconds=rng.choice([0, 29, 30, 31]))
            rows.append(TeaBreakLog(employee=e, out_at=out, in_at=back))
        TeaBreakLog.objects.bulk_create(rows)

    def setUp(self):
        freeze_clock(self)
        self.md = make_md()

    # ── the oracle
    def facts(self, start, end, keep=lambda e: True, allowed=None):
        """One dict per break that started on a day in [start, end] by an employee kept by `keep`."""
        allowed = allowed or self.ALLOWED
        out = []
        for b in TeaBreakLog.objects.select_related("employee__department", "employee__branch"):
            if not keep(b.employee):
                continue
            local = b.out_at.astimezone(FACTORY_TZ)
            if not (start <= local.date() <= end):
                continue
            taken, _ = TC.tea_metrics(b.out_at, b.in_at, allowed, NOW)
            completed = b.in_at is not None
            measured = completed and taken <= 60
            overrun = measured and taken > allowed
            out.append(
                {
                    "emp": b.employee,
                    "day": local.date(),
                    "local": local,
                    "taken": taken,
                    "measured": measured,
                    "overrun": overrun,
                    "long": completed and taken > 60,
                    "open": not completed,
                    "lost": taken - allowed if overrun else 0,
                }
            )
        return out

    @staticmethod
    def figures(facts):
        measured = [f for f in facts if f["measured"]]
        over = [f for f in facts if f["overrun"]]
        return {
            "breaks": len(facts),
            "measured": len(measured),
            "overruns": len(over),
            "lost": sum(f["lost"] for f in over) if measured else None,
            "avg": round(sum(f["taken"] for f in measured) / len(measured), 1) if measured else None,
            "pct": round(100.0 * len(over) / len(measured), 1) if measured else None,
            "long": sum(f["long"] for f in facts),
            "open": sum(f["open"] for f in facts),
            "people": len({f["emp"].id for f in facts}),
        }

    def api(self, name, **params):
        r = self.client.get(f"/api/md/tea-break/{name}", params, **md_headers(self.md))
        self.assertEqual(r.status_code, 200, r.content)
        return r.json()

    def shift_on(self, employee_id, day):
        best = None
        for a in EmployeeShiftAssignment.objects.filter(employee_id=employee_id):
            if a.effective_from <= day and (a.effective_to is None or a.effective_to >= day):
                if best is None or (a.effective_from, a.id) > (best.effective_from, best.id):
                    best = a
        return best.shift_id if best else 0

    CASES = [
        ({"from": "2026-08-01", "to": "2026-08-31"}, {}, lambda e: True),
        ({"from": "2026-07-20", "to": "2026-09-14"}, {}, lambda e: True),
        (
            {"from": "2026-08-20", "to": "2026-09-02"},
            {"type": "production"},
            lambda e: e.employment_type == "production",
        ),
        (
            {"from": "2026-08-10", "to": "2026-09-10"},
            {"department": "Sewing"},
            lambda e: e.department is not None and e.department.name == "Sewing",
        ),
        (
            {"from": "2026-09-01", "to": "2026-09-07"},
            {"branch": "Unit 2"},
            lambda e: e.branch is not None and e.branch.name == "Unit 2",
        ),
    ]

    def window(self, params):
        """(start, end, (previous start, previous end)): the previous period has the same length and ends the day
        before this one starts."""
        start, end = date.fromisoformat(params["from"]), date.fromisoformat(params["to"])
        length = (end - start).days + 1
        return start, end, (start - timedelta(days=length), start - timedelta(days=1))

    def test_summary_and_its_previous_period(self):
        for params, scope, keep in self.CASES:
            start, end, (pstart, pend) = self.window(params)
            body = self.api("summary", **params, **scope)
            m = body["metrics"]
            for facts, side in ((self.facts(start, end, keep), "value"), (self.facts(pstart, pend, keep), "previous")):
                f = self.figures(facts)
                label = (params, scope, side)
                self.assertEqual(m["breaks"][side], f["breaks"], label)
                self.assertEqual(m["measured"][side], f["measured"], label)
                self.assertEqual(m["overruns"][side], f["overruns"], label)
                self.assertEqual(m["minutesLost"][side], f["lost"], label)
                self.assertEqual(m["avgMinutes"][side], f["avg"], label)
                self.assertEqual(m["overrunPct"][side], f["pct"], label)
                self.assertEqual(m["employees"][side], f["people"], label)
            f = self.figures(self.facts(start, end, keep))
            cov = body["coverage"]
            self.assertEqual((cov["longCompleted"], cov["noReturn"]), (f["long"], f["open"]))
            self.assertEqual(cov["breaks"], cov["measured"] + cov["longCompleted"] + cov["noReturn"])

    def test_every_allowance_gives_the_same_answer_as_the_hand_rule(self):
        """Odd and even allowances round differently in SQL (half-to-even at x.5 minutes), and 59 / 60 sit right at
        the missed-scan cut-off: all of them must agree with the HR page's own per-break rule."""
        params = {"from": "2026-07-20", "to": "2026-09-14"}
        start, end = date(2026, 7, 20), date(2026, 9, 14)
        for allowed in (1, 10, 14, 15, 16, 20, 45, 59, 60, 90):
            TeaBreakRule.objects.filter(pk=1).update(allowed_minutes=allowed)
            f = self.figures(self.facts(start, end, allowed=allowed))
            m = self.api("summary", **params)["metrics"]
            self.assertEqual(m["overruns"]["value"], f["overruns"], allowed)
            self.assertEqual(m["minutesLost"]["value"], f["lost"], allowed)
            self.assertEqual(m["overrunPct"]["value"], f["pct"], allowed)
            self.assertEqual(
                m["measured"]["value"], f["measured"], allowed
            )  # the allowance never changes what is measured
            top = self.api("offenders", **params, min=1, limit=25)["rows"]
            self.assertEqual(sum(r["minutesLost"] for r in top), f["lost"] or 0, allowed)
        self.assertEqual(
            self.api("summary", **params)["metrics"]["overruns"]["value"], 0
        )  # allowed 90: nothing can overrun

    def test_departments_units_and_types(self):
        key = {
            "department": lambda e: e.department.name if e.department else None,
            "unit": lambda e: e.branch.name if e.branch else None,
            "type": lambda e: e.employment_type,
        }
        labels = {"staff": "Staff", "production": "Production"}
        for params, scope, keep in self.CASES:
            start, end, (pstart, pend) = self.window(params)
            for by, get in key.items():
                body = self.api("departments", **params, **scope, by=by, limit=25)
                facts = self.facts(start, end, keep)
                expected = {}
                for f in facts:
                    expected.setdefault(get(f["emp"]), []).append(f)
                previous = {}
                for f in self.facts(pstart, pend, keep):
                    previous.setdefault(get(f["emp"]), []).append(f)
                got = {r["key"]: r for r in body["rows"]}
                for grp, group in expected.items():
                    row = got[tea.NONE_KEY if grp is None else grp]
                    f = self.figures(group)
                    label = (params, scope, by, grp)
                    self.assertEqual(
                        (row["breaks"], row["measured"], row["overruns"]),
                        (f["breaks"], f["measured"], f["overruns"]),
                        label,
                    )
                    self.assertEqual(
                        (row["minutesLost"], row["avgMinutes"], row["overrunPct"]),
                        (f["lost"], f["avg"], f["pct"]),
                        label,
                    )
                    self.assertEqual(row["employees"], f["people"], label)
                    p = self.figures(previous.get(grp, []))
                    self.assertEqual(
                        row["previous"],
                        {"breaks": p["breaks"], "overrunPct": p["pct"], "minutesLost": p["lost"]},
                        label,
                    )
                    if by == "type":
                        self.assertEqual(row["label"], labels[grp])
                # a group with people but no breaks is listed too, without a rate
                for row in body["rows"]:
                    if row["breaks"] == 0:
                        self.assertIsNone(row["overrunPct"])
                        self.assertIsNone(row["minutesLost"])
                headcount = Employee.objects.filter(status="active")
                active = {}
                for e in headcount.select_related("department", "branch"):
                    if keep(e):
                        active[get(e)] = active.get(get(e), 0) + 1
                for grp, n in active.items():
                    self.assertEqual(
                        got[tea.NONE_KEY if grp is None else grp]["headcount"], n, (params, scope, by, grp)
                    )

    def test_shifts(self):
        for params, scope, keep in self.CASES:
            start, end, _ = self.window(params)
            body = self.api("shifts", **params, **scope, limit=25)
            expected = {}
            for f in self.facts(start, end, keep):
                expected.setdefault(self.shift_on(f["emp"].id, f["day"]), []).append(f)
            got = {r["key"]: r for r in body["rows"]}
            self.assertEqual(set(got), {tea.NONE_KEY if k == 0 else str(k) for k in expected}, (params, scope))
            for shift_id, group in expected.items():
                row = got[tea.NONE_KEY if shift_id == 0 else str(shift_id)]
                f = self.figures(group)
                self.assertEqual(
                    (row["breaks"], row["measured"], row["overruns"]),
                    (f["breaks"], f["measured"], f["overruns"]),
                    (params, shift_id),
                )
                self.assertEqual(
                    (row["minutesLost"], row["avgMinutes"], row["overrunPct"], row["employees"]),
                    (f["lost"], f["avg"], f["pct"], f["people"]),
                    (params, shift_id),
                )

    def test_heatmap(self):
        for params, scope, keep in self.CASES:
            start, end, _ = self.window(params)
            body = self.api("heatmap", **params, **scope)
            expected = {}
            for f in self.facts(start, end, keep):
                slot = f["local"].hour * 2 + (1 if f["local"].minute >= 30 else 0)
                expected.setdefault((f["local"].weekday(), slot), []).append(f)
            got = {(c["weekday"], c["slot"]): c for c in body["cells"]}
            self.assertEqual(set(got), set(expected), (params, scope))
            for cell, group in expected.items():
                f = self.figures(group)
                row = got[cell]
                self.assertEqual(
                    (row["breaks"], row["measured"], row["overruns"], row["minutesLost"]),
                    (f["breaks"], f["measured"], f["overruns"], f["lost"]),
                    (params, cell),
                )
                self.assertEqual(row["overrunPct"], f["pct"] if f["measured"] >= 5 else None, (params, cell))

    def test_offenders(self):
        for params, scope, keep in self.CASES:
            start, end, _ = self.window(params)
            body = self.api("offenders", **params, **scope, limit=25, min=2)
            by_emp = {}
            for f in self.facts(start, end, keep):
                by_emp.setdefault(f["emp"].employee_code, []).append(f)
            expected = []
            for code, group in by_emp.items():
                f = self.figures(group)
                if f["overruns"] >= 2:
                    worst = max((g for g in group if g["overrun"]), key=lambda g: (g["taken"], -g["local"].timestamp()))
                    expected.append((code, f["overruns"], f["lost"], worst["taken"], worst["day"].isoformat()))
            expected.sort(key=lambda t: (-t[1], -t[2], t[0]))
            self.assertEqual(
                [
                    (r["employeeCode"], r["overruns"], r["minutesLost"], r["worstMinutes"], r["worstDate"])
                    for r in body["rows"]
                ],
                expected[:25],
                (params, scope),
            )
            self.assertEqual(body["total"], len(expected))

    def test_the_daily_trend(self):
        for params, scope, keep in self.CASES:
            start, end, _ = self.window(params)
            body = self.api("trend", **params, **scope)
            per_day = {}
            for f in self.facts(start - timedelta(days=6), end, keep):
                per_day.setdefault(f["day"], []).append(f)
            for point in body["points"]:
                day = date.fromisoformat(point["date"])
                f = self.figures(per_day.get(day, []))
                self.assertEqual(
                    (point["breaks"], point["measured"], point["overruns"]),
                    (f["breaks"], f["measured"], f["overruns"]),
                    (params, scope, day),
                )
                self.assertEqual(
                    (point["minutesLost"], point["overrunPct"]), (f["lost"], f["pct"]), (params, scope, day)
                )
                window = [x for d, xs in per_day.items() if day - timedelta(days=6) <= d <= day for x in xs]
                w = self.figures(window)
                self.assertEqual(point["maOverrunPct"], w["pct"], (params, scope, day))
                self.assertEqual(
                    point["maMinutesLost"],
                    round(w["lost"] / 7, 1) if w["lost"] is not None else None,
                    (params, scope, day),
                )


# ═════════════════════════════════════════════════════════════════════════════════════════════════════════════════
# the shape of every response (frontend/src/pages/md/tea-break/types.ts mirrors these: change both together)
# ═════════════════════════════════════════════════════════════════════════════════════════════════════════════════

ENVELOPE = {"generatedAt", "period", "scope", "provenance", "notes", "tookMs"}
GROUP_ROW = {
    "key", "label", "sub", "headcount", "employees", "participationPct", "breaks", "measured", "avgMinutes",
    "overruns", "overrunPct", "minutesLost", "shareOfLostPct", "lowSample", "previous", "change",
}  # fmt: skip


class ShapeTests(GoldenBase):
    def keys(self, body, *extra):
        return set(body) - ENVELOPE, set(extra)

    def test_summary(self):
        s = self.api("summary")
        self.assertEqual(
            set(s) - ENVELOPE,
            {"allowedMinutes", "metrics", "hoursLost", "withinAllowance", "previousPeriod", "coverage"},
        )
        self.assertEqual(
            set(s["metrics"]),
            {"breaks", "employees", "measured", "avgMinutes", "overruns", "overrunPct", "compliancePct", "minutesLost"},
        )
        self.assertEqual(set(s["metrics"]["breaks"]), {"value", "previous", "change"})
        self.assertEqual(set(s["metrics"]["breaks"]["change"]), {"abs", "pct"})
        self.assertEqual(
            set(s["coverage"]),
            {
                "activeEmployees", "employeesScanning", "participationPct", "daysWithScans", "daysInPeriod", "breaks",
                "measured", "longCompleted", "noReturn", "inProgress", "unmeasured", "unmeasuredPct",
            },
        )  # fmt: skip
        self.assertEqual(set(s["previousPeriod"]), {"start", "end", "preset", "label", "days"})

    def test_attention(self):
        with mock.patch.object(tea, "MIN_SAMPLE_BREAKS", 3):
            body = self.api("attention")
        self.assertEqual(set(body) - ENVELOPE, {"items"})
        self.assertTrue(body["items"])
        for item in body["items"]:
            self.assertEqual(set(item), {"id", "severity", "title", "detail", "metric", "page", "ask"})

    def test_trend(self):
        t = self.api("trend")
        self.assertEqual(set(t) - ENVELOPE, {"allowedMinutes", "granularity", "points", "momentum", "worstDay"})
        self.assertEqual(
            set(t["points"][0]),
            {"date", "days", "breaks", "measured", "overruns", "overrunPct", "minutesLost", "avgMinutes", "maOverrunPct", "maMinutesLost"},
        )  # fmt: skip
        m = t["momentum"]
        self.assertEqual(
            set(m), {"windowDays", "verdict", "text", "current", "previous", "overrunPctChange", "minutesLostChange"}
        )
        self.assertEqual(set(m["current"]), {"start", "end", "breaks", "measured", "overrunPct", "minutesLost"})
        with mock.patch.object(tea, "MIN_DAY_BREAKS", 4):
            worst = self.api("trend")["worstDay"]
        self.assertEqual(set(worst), {"date", "overrunPct", "overruns", "measured", "minutesLost"})

    def test_rankings(self):
        for name in ("departments", "shifts"):
            body = self.api(name)
            self.assertEqual(
                set(body) - ENVELOPE,
                {"by", "allowedMinutes", "rows", "total", "truncated", "average", "minSample"},
                name,
            )
            self.assertEqual(set(body["rows"][0]), GROUP_ROW, name)
            self.assertEqual(set(body["average"]), {"overrunPct", "avgMinutes", "measured", "minutesLost"})
            self.assertEqual(set(body["rows"][0]["previous"]), {"breaks", "overrunPct", "minutesLost"})
            self.assertEqual(set(body["rows"][0]["change"]), {"overrunPct", "minutesLost"})

    def test_heatmap(self):
        h = self.api("heatmap")
        self.assertEqual(
            set(h) - ENVELOPE,
            {"allowedMinutes", "weekdays", "slots", "cells", "totalBreaks", "minCellBreaks", "busiestSlots", "worstCells", "byWeekday"},
        )  # fmt: skip
        self.assertEqual(set(h["slots"][0]), {"index", "label"})
        self.assertEqual(
            set(h["cells"][0]), {"weekday", "slot", "breaks", "measured", "overruns", "overrunPct", "minutesLost"}
        )
        self.assertEqual(set(h["busiestSlots"][0]), {"slot", "label", "breaks", "sharePct"})
        self.assertEqual(
            set(h["byWeekday"][0]), {"weekday", "label", "breaks", "measured", "overruns", "overrunPct", "minutesLost"}
        )
        with mock.patch.object(tea, "MIN_CELL_BREAKS", 3):
            worst = self.api("heatmap")["worstCells"][0]
        self.assertEqual(set(worst), {"weekday", "slot", "label", "overrunPct", "measured", "minutesLost"})

    def test_offenders(self):
        o = self.api("offenders")
        self.assertEqual(
            set(o) - ENVELOPE,
            {"allowedMinutes", "threshold", "total", "overrunners", "rows", "truncated", "minutesLostByRepeaters", "shareOfMinutesLostPct"},
        )  # fmt: skip
        self.assertEqual(
            set(o["rows"][0]),
            {
                "employeeCode", "employeeName", "department", "unit", "type", "breaks", "measured", "overruns",
                "overrunPct", "minutesLost", "averageOverBy", "worstMinutes", "worstOverBy", "worstDate",
            },
        )  # fmt: skip

    def test_rule(self):
        r = self.get("/api/md/tea-break/rule").json()
        self.assertEqual(
            set(r) - ENVELOPE,
            {
                "allowedMinutes", "isDefault", "updatedAt", "missedScanMinutes", "notReturnedMinutes", "leftOpenHours",
                "repeatMinOverruns", "minSampleBreaks", "hasGrace", "hasWindows", "statements",
            },
        )  # fmt: skip

    def test_no_internal_names_in_the_words_the_md_reads(self):
        """Provenance, notes and the rule are read by the MD: no table or field names in them."""
        banned = ("in_at", "out_at", "TeaBreakLog", "TeaBreakRule", "_q(", "tea_break_logs", "QuerySet", "None")
        with mock.patch.object(tea, "MIN_SAMPLE_BREAKS", 3):
            bodies = [
                self.api(n) for n in ("summary", "trend", "departments", "shifts", "heatmap", "offenders", "attention")
            ]
        bodies.append(self.get("/api/md/tea-break/rule").json())
        for body in bodies:
            text = json.dumps(body["provenance"]) + json.dumps(body["notes"]) + json.dumps(body.get("statements", []))
            for word in banned:
                self.assertNotIn(word, text, word)


# ═════════════════════════════════════════════════════════════════════════════════════════════════════════════════
# the small pure pieces
# ═════════════════════════════════════════════════════════════════════════════════════════════════════════════════


class RosterTests(SimpleTestCase):
    """Which shift an employee is on, day by day: the covering assignment with the latest start wins."""

    @staticmethod
    def row(id_, shift_id, start, end=None):
        return {"id": id_, "shift_id": shift_id, "effective_from": start, "effective_to": end}

    def test_the_latest_start_wins_and_the_newer_row_wins_a_tie(self):
        roster = tea._Roster(
            [
                self.row(1, 10, date(2026, 8, 1)),
                self.row(2, 20, date(2026, 9, 8)),
                self.row(3, 30, date(2026, 9, 8)),  # same start as row 2: the newer row wins
            ]
        )
        self.assertEqual(roster.on(date(2026, 8, 31)), 10)
        self.assertEqual(roster.on(date(2026, 9, 7)), 10)
        self.assertEqual(roster.on(date(2026, 9, 8)), 30)
        self.assertEqual(roster.on(date(2026, 7, 31)), 0)  # before any assignment: no shift

    def test_an_assignment_covers_both_of_its_end_days(self):
        roster = tea._Roster([self.row(1, 10, date(2026, 9, 1), date(2026, 9, 5))])
        self.assertEqual([roster.on(date(2026, 9, d)) for d in (1, 5, 6)], [10, 10, 0])

    def test_constant_over_a_period(self):
        roster = tea._Roster([self.row(1, 10, date(2026, 8, 1)), self.row(2, 20, date(2026, 9, 5))])
        self.assertEqual(roster.constant_over(date(2026, 8, 10), date(2026, 9, 4)), 10)
        self.assertEqual(roster.constant_over(date(2026, 9, 5), date(2026, 9, 30)), 20)
        self.assertIsNone(roster.constant_over(date(2026, 9, 4), date(2026, 9, 5)))  # changes on the last day
        self.assertIsNone(roster.constant_over(date(2026, 8, 1), date(2026, 9, 30)))

    def test_the_day_after_an_assignment_ends_is_a_change(self):
        roster = tea._Roster([self.row(1, 10, date(2026, 8, 1), date(2026, 9, 5))])
        self.assertEqual(roster.constant_over(date(2026, 8, 20), date(2026, 9, 5)), 10)
        self.assertIsNone(roster.constant_over(date(2026, 8, 20), date(2026, 9, 6)))  # 06-Sep: no shift any more

    def test_no_assignment_is_one_constant_shift_called_none(self):
        self.assertEqual(tea._Roster([]).constant_over(date(2026, 9, 1), date(2026, 9, 30)), 0)

    def test_a_shift_that_changes_and_changes_back(self):
        roster = tea._Roster([self.row(1, 10, date(2026, 8, 1)), self.row(2, 20, date(2026, 9, 5), date(2026, 9, 6))])
        self.assertIsNone(roster.constant_over(date(2026, 9, 1), date(2026, 9, 30)))
        self.assertEqual([roster.on(date(2026, 9, d)) for d in (4, 5, 6, 7)], [10, 20, 20, 10])


class TextHelperTests(SimpleTestCase):
    def test_indian_grouping(self):
        self.assertEqual(tea._num(1234567), "12,34,567")
        self.assertEqual(tea._num(99999), "99,999")
        self.assertEqual(tea._num(100000), "1,00,000")
        self.assertEqual(tea._num(-1500.56, 1), "-1,500.6")
        self.assertEqual(tea._num(12.0), "12")
        self.assertEqual(tea._num(None), "n/a")

    def test_percentages_and_plurals(self):
        self.assertEqual(tea._p(33.3), "33%")
        self.assertEqual(tea._p(33.35, 1), "33.4%")
        self.assertEqual(tea._p(None), "n/a")
        self.assertEqual((tea._plural(1, "person", "people"), tea._plural(2, "person", "people")), ("person", "people"))

    def test_slot_labels(self):
        self.assertEqual(
            [tea._slot_label(i) for i in (0, 1, 20, 21, 47)], ["00:00", "00:30", "10:00", "10:30", "23:30"]
        )

    def test_whole_number_parameters(self):
        self.assertEqual(tea._int_arg(None, "limit", 10, 1, 25), 10)
        self.assertEqual(tea._int_arg("", "limit", 10, 1, 25), 10)
        self.assertEqual(tea._int_arg("7", "limit", 10, 1, 25), 7)
        self.assertEqual(tea._int_arg(500, "limit", 10, 1, 25), 25)
        self.assertEqual(tea._int_arg(0, "limit", 10, 1, 25), 1)
        with self.assertRaises(MdParamError):
            tea._int_arg("lots", "limit", 10, 1, 25)

    def test_the_thresholds_are_the_ones_the_provenance_quotes(self):
        self.assertEqual(
            (tea.REPEAT_MIN_OVERRUNS, tea.SUSPECT_MINUTES, tea.MIN_SAMPLE_BREAKS, tea.MIN_CELL_BREAKS),
            (3, 60, 20, 5),
        )
        self.assertEqual(
            tea.SUSPECT_MINUTES, TC.SUSPECT_MINUTES
        )  # the same cut-off as the HR page and the Report Center


# ═════════════════════════════════════════════════════════════════════════════════════════════════════════════════
# speed: the number of queries does not grow with the number of breaks, people or shifts
# ═════════════════════════════════════════════════════════════════════════════════════════════════════════════════


class QueryCountTests(TestCase):
    def setUp(self):
        freeze_clock(self)
        self.md = make_md()
        TeaBreakRule.objects.create(pk=1, allowed_minutes=15)
        self.unit = Branch.objects.create(name="Unit 1", code="Q1")
        self.depts = [Department.objects.create(name=f"Dept {i}", branch=self.unit) for i in range(8)]
        self.shifts = [
            ShiftTemplate.objects.create(
                name=f"Shift {i}", branch=self.unit, start_time=dtime(8, 0), end_time=dtime(16, 0)
            )
            for i in range(4)
        ]
        self.made = 0

    def grow(self, employees: int):
        """Add people with assignments and ~20 breaks each on days 1..12 September."""
        people = []
        for _ in range(employees):
            self.made += 1
            people.append(
                Employee(
                    employee_code=f"Q{self.made:04d}",
                    first_name="Q",
                    last_name=str(self.made),
                    department=self.depts[self.made % len(self.depts)],
                    branch=self.unit,
                    employment_type="staff" if self.made % 2 else "production",
                )
            )
        Employee.objects.bulk_create(people)
        people = list(Employee.objects.filter(employee_code__startswith="Q").order_by("id"))[-employees:]
        EmployeeShiftAssignment.objects.bulk_create(
            [
                EmployeeShiftAssignment(
                    employee=e, shift=self.shifts[i % len(self.shifts)], effective_from=date(2026, 8, 1)
                )
                for i, e in enumerate(people)
            ]
        )
        logs = []
        for i, e in enumerate(people):
            for day in range(1, 13):
                for k, minutes in enumerate((9 + (i % 5), 14 + (day % 9))):
                    out = ist(9, day, 10 + 4 * k, (i * 7) % 60)
                    logs.append(TeaBreakLog(employee=e, out_at=out, in_at=out + timedelta(minutes=minutes)))
        TeaBreakLog.objects.bulk_create(logs)

    def count(self, name, **params):
        with CaptureQueriesContext(connection) as ctx:
            r = self.client.get(f"/api/md/tea-break/{name}", {**P, **params}, **md_headers(self.md))
        self.assertEqual(r.status_code, 200, r.content)
        return len(ctx)

    ENDPOINTS = [
        ("summary", {}),
        ("trend", {}),
        ("departments", {}),
        ("departments", {"by": "unit"}),
        ("departments", {"by": "type"}),
        ("shifts", {}),
        ("heatmap", {}),
        ("offenders", {"min": 1}),
        ("attention", {}),
    ]

    def test_no_query_per_row(self):
        self.grow(6)
        with mock.patch.object(tea, "MIN_SAMPLE_BREAKS", 1):  # so the exceptions take the same path on a small company
            small = {(n, tuple(p.items())): self.count(n, **p) for n, p in self.ENDPOINTS}
            self.grow(60)
            large = {(n, tuple(p.items())): self.count(n, **p) for n, p in self.ENDPOINTS}
        self.assertEqual(small, large)
        for key, queries in large.items():
            self.assertLessEqual(queries, 40, key)  # a ceiling too: a handful of aggregate queries, never one per row

    def test_the_rule_is_one_read_plus_the_request_overhead(self):
        empty = self.count("rule")
        self.grow(30)
        self.assertEqual(self.count("rule"), empty)  # the rule does not depend on the data
        self.assertLessEqual(empty, 8)  # sign-in check, the read-only transaction and the rule itself

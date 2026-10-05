"""MD portal: Attendance Analytics (md_portal/analytics/attendance.py, routes/attendance.py).

Every figure asserted here is recomputed by hand from the fixtures below, never copied from the output.

THE WORLD (September 2026; Monday 7 Sep and Monday 31 Aug start the two weeks measured)

    Unit A    Stitching: E1 Asha (staff), E2 Bala (staff), E4 Dev (production)     Cutting: E3 Chitra (staff, Saturday off)
    Head Office  Accounts: E5 Esha (staff)           shift General 09:00-18:00, 15 min grace, 60 min lunch = 8 h a day
    Holiday: Friday 4 Sep.  Staff work Mon-Sat (E3 Mon-Fri); production works every day but Sunday and holidays.

    Week W = Mon 7 .. Sun 13 Sep                     one letter per day, Mon..Sun
        E1  P p A P H P O      (p = present but late, H = half day, A = absent, L = leave, O = off / holiday row)
        E2  P A A A P L O
        E3  P p p P p A O      (the Saturday "A" is a Saturday off: the engine stores it as absent)
        E4  P P H A P P A      (the Sunday "A" is a production Sunday: a weekly off)
        E5  P P P P P P O
      scheduled days (with a record): E1 6, E2 6, E3 5, E4 6, E5 6 = 29
      present 21, half 2, absent 5, leave 1  ->  attendance (21 + 1) / 29 = 75.9 %, absenteeism 5 / 29 = 17.2 %
      late days 4 (E1 1, E3 3) over 23 days worked (21 + 2) = 17.4 %

    Week P = Mon 31 Aug .. Sun 6 Sep (the previous period)
        E1  P P P P O P O      E2  P A A P O P O      E3  P P P P O A O
        E4  P P P H O P A      E5  P P P P O P O
      scheduled 24, present 21, half 1, absent 2  ->  attendance 21.5 / 24 = 89.6 %, absenteeism 8.3 %, no late days
"""

import json
import threading
import time as timer
from contextlib import contextmanager
from datetime import date, datetime, time, timedelta
from datetime import timezone as dt_timezone
from unittest import mock

from django.db import connection
from django.test.utils import CaptureQueriesContext

from .md_portal.analytics import attendance as A
from .md_portal.assistant import registry, shaping
from .md_portal.common import MdParamError, read_only_db
from .models import (
    AttendanceDayRecord,
    AttendanceLog,
    Branch,
    CasualLeaveRequest,
    Department,
    Employee,
    EmployeePermission,
    EmployeeShiftAssignment,
    Holiday,
    HRUser,
    LeaveRequest,
    LeaveType,
    MissingPunchRequest,
    OvertimeRecord,
    PayrollSettings,
    ProductionShiftConfig,
    ResignationRequest,
    ShiftTemplate,
)
from .tests_md_support import MdApiTestCase

W = {"from": "2026-09-07", "to": "2026-09-13"}  # the week measured
P = {"from": "2026-08-31", "to": "2026-09-06"}  # the week before it
TODAY = date(2026, 9, 21)  # a Monday after both weeks
BASE = "/api/md/attendance"

STATUS = {
    "P": "present",
    "p": "present",
    "H": "half_shift",
    "A": "absent",
    "a": "absent",
    "L": "on_leave",
    "O": "holiday",
}


@contextmanager
def at(day: date = TODAY, hour: int = 12):
    """Freeze the factory clock: today is ``day`` and it is ``hour`` o'clock."""
    now = datetime.combine(day, time(hour, 0))
    with (
        mock.patch.object(A, "ist_today", return_value=day),
        mock.patch.object(A, "ist_now", return_value=now),
        mock.patch("api.md_portal.common.ist_today", return_value=day),
        mock.patch("api.md_portal.common.ist_now", return_value=now),
    ):
        yield


def mark(emp: Employee, start: date, codes: str) -> None:
    """One day record per letter from ``start``: P present, p present and late, H half day, A absent, a absent but
    informed, L on leave, O holiday / weekly off; a space or '-' leaves the day without a record."""
    rows = []
    for i, ch in enumerate(codes):
        if ch in " -":
            continue
        rows.append(
            AttendanceDayRecord(
                employee=emp,
                date=start + timedelta(days=i),
                status=STATUS[ch],
                is_late=(ch == "p"),
                is_informed=True if ch == "a" else None,
            )
        )
    AttendanceDayRecord.objects.bulk_create(rows)


def first_punch(emp: Employee, day: date, at_time: time) -> None:
    AttendanceDayRecord.objects.filter(employee=emp, date=day).update(first_punch=at_time)


def d(day: int, month: int = 9) -> date:
    return date(2026, month, day)


def make_employee(code, first, last, dept, branch, etype="staff", **kw) -> Employee:
    kw.setdefault("join_date", "2025-01-01")
    return Employee.objects.create(
        employee_code=code,
        first_name=first,
        last_name=last,
        department=dept,
        branch=branch,
        employment_type=etype,
        **kw,
    )


class World(MdApiTestCase):
    """The shared fixture (see the module docstring). Subclasses add what they need and read ``self.e1`` ... ``e5``."""

    @classmethod
    def setUpTestData(cls):
        cls.unit_a = Branch.objects.create(name="Unit A", code="UA")
        cls.head_office = Branch.objects.get(code="HO")  # a migration seeds the Head Office branch in every database
        cls.stitching = Department.objects.create(name="Stitching", branch=cls.unit_a)
        cls.cutting = Department.objects.create(name="Cutting", branch=cls.unit_a)
        cls.accounts = Department.objects.create(name="Accounts", branch=cls.head_office)
        cls.shift = ShiftTemplate.objects.create(
            name="General",
            shift_type="staff",
            start_time=time(9),
            end_time=time(18),
            grace_period_minutes=15,
            first_half_end=time(13, 30),
            lunch_duration_minutes=60,
        )
        cls.e1 = make_employee("T001", "Asha", "Kumar", cls.stitching, cls.unit_a)
        cls.e2 = make_employee("T002", "Bala", "Raj", cls.stitching, cls.unit_a)
        cls.e3 = make_employee("T003", "Chitra", "Devi", cls.cutting, cls.unit_a)
        cls.e4 = make_employee("T004", "Dev", "Prakash", cls.stitching, cls.unit_a, "production")
        cls.e5 = make_employee("T005", "Esha", "Mani", cls.accounts, cls.head_office)
        for emp in (cls.e1, cls.e2, cls.e3, cls.e5):
            EmployeeShiftAssignment.objects.create(
                employee=emp, shift=cls.shift, effective_from=date(2026, 1, 1), saturday_off=(emp is cls.e3)
            )
        Holiday.objects.create(name="Test Holiday", date=d(4))

        mark(cls.e1, d(7), "PpAPHPO")
        mark(cls.e2, d(7), "PAAAPLO")
        mark(cls.e3, d(7), "PppPpAO")
        mark(cls.e4, d(7), "PPHAPPA")
        mark(cls.e5, d(7), "PPPPPPO")
        mark(cls.e1, d(31, 8), "PPPPOPO")
        mark(cls.e2, d(31, 8), "PAAPOPO")
        mark(cls.e3, d(31, 8), "PPPPOAO")
        mark(cls.e4, d(31, 8), "PPPHOPA")
        mark(cls.e5, d(31, 8), "PPPPOPO")
        first_punch(cls.e1, d(8), time(9, 40))  # 40 min after the 09:00 start
        first_punch(cls.e3, d(8), time(9, 20))  # 20
        first_punch(cls.e3, d(9), time(9, 30))  # 30
        first_punch(cls.e3, d(11), time(9, 50))  # 50  -> 140 minutes over 4 late days

    def summary(self, params=W, **extra):
        with at():
            r = self.get(f"{BASE}/summary", **params, **extra)
        self.assertEqual(r.status_code, 200, r.content)
        return r.json()

    def metrics(self, params=W, **extra):
        return self.summary(params, **extra)["metrics"]


# ─── access ──────────────────────────────────────────────────────────────────────────────────────────────────────

ROUTES = ("summary", "trend", "departments", "weekday", "heatmap", "exceptions", "overtime", "leave", "day")


class AccessTests(World):
    def test_only_the_md_gets_in(self):
        root = HRUser.objects.create(username="root", password_hash="x", is_super_admin=True)
        from .tests_md_support import md_headers

        for route in ROUTES:
            url = f"{BASE}/{route}"
            with self.subTest(route=route):
                self.assertEqual(self.client.get(url).status_code, 401)
                self.assertEqual(self.client.get(url, **md_headers(root)).status_code, 403)
                self.assertEqual(self.client.post(url, **md_headers(self.md)).status_code, 405)
                self.assertEqual(self.get(url).status_code, 200)

    def test_a_bad_parameter_is_a_400_that_says_why(self):
        cases = [
            ("summary", {"period": "fortnight"}, "Unknown period"),
            ("trend", {"branch": "Nowhere"}, "No unit called"),
            ("exceptions", {"limit": "many"}, "'limit' must be a whole number"),
            ("day", {"date": "next tuesday"}, "not a date"),
            ("departments", {"type": "contract"}, "staff or production"),
        ]
        for route, params, text in cases:
            with self.subTest(route=route):
                r = self.get(f"{BASE}/{route}", **params)
                self.assertEqual(r.status_code, 400)
                self.assertIn(text, r.json()["error"])

    def test_a_day_that_has_not_happened_is_refused(self):
        with at():
            r = self.get(f"{BASE}/day", date="2026-09-22")
        self.assertEqual(r.status_code, 400)
        self.assertIn("has not happened yet", r.json()["error"])


# ─── the headline figures ────────────────────────────────────────────────────────────────────────────────────────


class SummaryTests(World):
    def test_the_week_in_numbers(self):
        s = self.summary()
        m = s["metrics"]
        self.assertEqual(s["period"]["days"], 7)
        self.assertEqual(s["measured"], {"start": "2026-09-07", "end": "2026-09-13", "days": 7})
        self.assertEqual(s["previous"], {"start": "2026-08-31", "end": "2026-09-06", "days": 7})
        self.assertEqual(m["attendancePct"]["value"], 75.9)  # (21 + 0.5 x 2) / 29
        self.assertEqual(m["absenteeismPct"]["value"], 17.2)  # 5 / 29
        self.assertEqual(m["latePct"]["value"], 17.4)  # 4 / 23
        self.assertEqual(m["avgLateMinutes"]["value"], 35.0)  # (40 + 20 + 30 + 50) / 4
        self.assertEqual(m["halfDays"]["value"], 2)
        self.assertEqual(m["leaveDays"]["value"], 1)
        self.assertEqual(m["scheduledDays"]["value"], 29)
        self.assertEqual(m["coveragePct"]["value"], 100.0)
        self.assertEqual(
            s["counts"],
            {
                "present": 21,
                "half": 2,
                "absent": 5,
                "leave": 1,
                "late": 4,
                "worked": 23,
                "scheduledWithRecord": 29,
                "workedOnDaysOff": 0,
                "informedAbsences": 0,
                "overtimeDays": 0,
            },
        )

    def test_each_figure_carries_the_previous_period_and_the_change(self):
        m = self.metrics()
        att = m["attendancePct"]
        self.assertEqual((att["previous"], att["good"]), (89.6, "up"))  # 21.5 / 24
        self.assertEqual(att["delta"], {"abs": -13.7, "pct": -15.3})
        ab = m["absenteeismPct"]
        self.assertEqual((ab["previous"], ab["good"]), (8.3, "down"))  # 2 / 24
        self.assertEqual(ab["delta"], {"abs": 8.9, "pct": 107.2})
        late = m["latePct"]
        self.assertEqual(late["previous"], 0.0)  # no late day last week: a real zero, not "no data"
        self.assertEqual(late["delta"], {"abs": 17.4, "pct": None})  # no % change against a base of 0
        self.assertIsNone(m["avgLateMinutes"]["previous"])  # nobody was late, so there is no average to compare
        self.assertIsNone(m["avgLateMinutes"]["delta"])
        self.assertEqual(m["halfDays"]["delta"], {"abs": 1, "pct": 100.0})
        self.assertEqual(m["leaveDays"]["delta"], {"abs": 1, "pct": None})
        self.assertEqual(m["scheduledDays"]["previous"], 24)

    def test_the_sparklines_follow_the_trend(self):
        m = self.metrics()
        # Mon..Sat, worked out day by day in TrendTests
        self.assertEqual(m["attendancePct"]["spark"], [100.0, 80.0, 50.0, 60.0, 90.0, 75.0])
        self.assertEqual(m["absenteeismPct"]["spark"], [0.0, 20.0, 40.0, 40.0, 0.0, 0.0])

    def test_coverage_says_how_many_scheduled_days_have_a_record(self):
        AttendanceDayRecord.objects.filter(employee=self.e2, date__in=[d(8), d(9)]).delete()
        AttendanceDayRecord.objects.filter(employee=self.e5, date=d(10)).delete()
        s = self.summary()
        cov = s["coverage"]
        self.assertEqual((cov["expectedDays"], cov["recordedDays"], cov["missingDays"]), (29, 26, 3))
        self.assertEqual(cov["coveragePct"], 89.7)  # 26 / 29
        self.assertTrue(cov["partial"])
        self.assertEqual(
            cov["worstDays"],
            [  # the dates HR should open first: lowest coverage, then the earlier date
                {"date": "2026-09-08", "expected": 5, "recorded": 4, "coveragePct": 80.0},
                {"date": "2026-09-09", "expected": 5, "recorded": 4, "coveragePct": 80.0},
                {"date": "2026-09-10", "expected": 5, "recorded": 4, "coveragePct": 80.0},
            ],
        )
        self.assertTrue(any("89.7%" in n and "26 of 29" in n for n in s["notes"]), s["notes"])
        # the figures cover only the days that exist: three rows are gone (E2's two absences and E5's present day)
        self.assertEqual(s["counts"]["scheduledWithRecord"], 26)
        self.assertEqual((s["counts"]["present"], s["counts"]["absent"]), (20, 3))

    def test_a_week_nobody_processed_is_empty_not_zero(self):
        s = self.summary({"from": "2026-07-06", "to": "2026-07-12"})
        m = s["metrics"]
        for key in (
            "attendancePct",
            "absenteeismPct",
            "latePct",
            "avgLateMinutes",
            "halfDays",
            "leaveDays",
            "overtimeHours",
        ):
            self.assertIsNone(m[key]["value"], key)
        self.assertEqual(m["coveragePct"]["value"], 0.0)  # people were expected and nobody has a record
        self.assertEqual(m["scheduledDays"]["value"], 29)  # E1, E2, E4, E5 six days each, E3 five (Saturday off)
        self.assertTrue(any("No attendance day records exist" in n for n in s["notes"]))

    def test_every_figure_explains_itself(self):
        s = self.summary()
        ids = {p["id"] for p in s["provenance"]}
        self.assertEqual(
            ids,
            {
                "attendance-pct",
                "absenteeism-pct",
                "late-pct",
                "avg-late-minutes",
                "overtime-hours",
                "half-days",
                "missing-punches",
                "leave-days",
                "scheduled-days",
                "coverage",
            },
        )
        by_id = {p["id"]: p for p in s["provenance"]}
        self.assertEqual(by_id["attendance-pct"]["rows"], 29)
        self.assertIn("(full days + 0.5 × half days)", by_id["attendance-pct"]["formula"])
        self.assertIn("Monthly Attendance Summary", " ".join(by_id["attendance-pct"]["caveats"]))
        self.assertIn("Absentee Analysis", " ".join(by_id["absenteeism-pct"]["caveats"]))
        self.assertEqual(by_id["avg-late-minutes"]["rows"], 4)


# ─── scope ───────────────────────────────────────────────────────────────────────────────────────────────────────


class ScopeTests(World):
    def test_one_unit(self):
        # Unit A = E1 E2 E3 E4: scheduled 6 + 6 + 5 + 6 = 23; present 4 + 2 + 5 + 4 = 15, half 1 + 1, absent 1 + 3 + 1, leave 1
        m = self.metrics({**W, "branch": "Unit A"})
        self.assertEqual(m["scheduledDays"]["value"], 23)
        self.assertEqual(m["attendancePct"]["value"], 69.6)  # (15 + 1) / 23
        self.assertEqual(m["absenteeismPct"]["value"], 21.7)  # 5 / 23
        self.assertEqual(m["attendancePct"]["previous"], 86.8)  # (16 + 0.5) / 19 in the week before

    def test_one_department_covers_every_unit_that_has_it(self):
        # Stitching = E1 E2 E4: scheduled 18, present 10, half 2, absent 5, leave 1; late 1 (E1) over 12 days worked
        m = self.metrics({**W, "department": "stitching"})  # the case does not matter
        self.assertEqual(m["scheduledDays"]["value"], 18)
        self.assertEqual(m["attendancePct"]["value"], 61.1)  # 11 / 18
        self.assertEqual(m["absenteeismPct"]["value"], 27.8)  # 5 / 18
        self.assertEqual(m["latePct"]["value"], 8.3)  # 1 / 12
        self.assertEqual(m["avgLateMinutes"]["value"], 40.0)

    def test_production_only(self):
        m = self.metrics({**W, "type": "production"})  # E4: P P H A P P over six days, a Sunday off
        self.assertEqual(m["scheduledDays"]["value"], 6)
        self.assertEqual(m["attendancePct"]["value"], 75.0)  # 4.5 / 6
        self.assertEqual(m["absenteeismPct"]["value"], 16.7)  # 1 / 6
        self.assertEqual(m["latePct"]["value"], 0.0)
        self.assertEqual(m["halfDays"]["value"], 1)

    def test_staff_only(self):
        # E1 E2 E3 E5: scheduled 23, present 17, half 1, absent 4, leave 1
        m = self.metrics({**W, "type": "staff"})
        self.assertEqual(m["scheduledDays"]["value"], 23)
        self.assertEqual(m["attendancePct"]["value"], 76.1)  # 17.5 / 23
        self.assertEqual(m["absenteeismPct"]["value"], 17.4)  # 4 / 23

    def test_a_scope_with_nobody_in_it_has_no_figures(self):
        Department.objects.create(name="Empty", branch=self.unit_a)
        m = self.metrics({**W, "department": "Empty"})
        for key, metric in m.items():
            self.assertIsNone(metric["value"], key)

    def test_a_department_the_unit_does_not_have_is_a_400(self):
        r = self.get(f"{BASE}/summary", **W, branch="Unit A", department="Accounts")
        self.assertEqual(r.status_code, 400)
        self.assertIn("No department called 'Accounts'", r.json()["error"])

    def test_a_typo_is_matched_and_the_assumption_is_reported(self):
        s = self.summary({**W, "department": "stiching"})
        self.assertEqual(s["scope"]["description"], "All units · Stitching · staff and production")
        self.assertIn("Matched department 'stiching' to 'Stitching'.", s["notes"])


# ─── trend ───────────────────────────────────────────────────────────────────────────────────────────────────────


def point(day, att, absent, late, present, half, gone, leave, late_n, expected):
    return {
        "date": day,
        "days": 1,
        "attendancePct": att,
        "absentPct": absent,
        "latePct": late,
        "present": present,
        "half": half,
        "absent": gone,
        "leave": leave,
        "late": late_n,
        "expected": expected,
        "rostered": expected,
        "coveragePct": 100.0,
    }


class TrendTests(World):
    def trend(self, params=W):
        with at():
            r = self.get(f"{BASE}/trend", **params)
        self.assertEqual(r.status_code, 200, r.content)
        return r.json()

    def test_one_point_per_working_day_worked_out_by_hand(self):
        t = self.trend()
        self.assertEqual(t["granularity"], "day")
        self.assertEqual(
            t["points"],
            [
                point("2026-09-07", 100.0, 0.0, 0.0, 5, 0, 0, 0, 0, 5),
                point("2026-09-08", 80.0, 20.0, 50.0, 4, 0, 1, 0, 2, 5),  # E2 absent; E1 and E3 late of the 4 who came
                point("2026-09-09", 50.0, 40.0, 33.3, 3, 1, 2, 0, 1, 5),  # (2 + 0.5) / 5; E3 late of 3
                point("2026-09-10", 60.0, 40.0, 0.0, 3, 0, 2, 0, 0, 5),
                point("2026-09-11", 90.0, 0.0, 20.0, 5, 1, 0, 0, 1, 5),  # (4 + 0.5) / 5; E3 late of 5
                point("2026-09-12", 75.0, 0.0, 0.0, 3, 0, 0, 1, 0, 4),  # E3's Saturday off is nobody's absence
            ],
        )  # Sunday 13 has no point: nobody is scheduled
        self.assertEqual(t["average"], {"attendancePct": 75.9, "absentPct": 17.2, "latePct": 17.4})

    def test_a_working_day_nobody_processed_is_a_gap_not_a_zero(self):
        AttendanceDayRecord.objects.filter(date=d(8)).delete()
        tuesday = next(p for p in self.trend()["points"] if p["date"] == "2026-09-08")
        self.assertIsNone(tuesday["attendancePct"])
        self.assertIsNone(tuesday["latePct"])
        self.assertEqual((tuesday["expected"], tuesday["rostered"], tuesday["coveragePct"]), (0, 5, 0.0))

    def test_a_long_period_is_shown_week_by_week(self):
        t = self.trend({"from": "2026-07-01", "to": "2026-09-13"})  # 75 days
        self.assertEqual(t["granularity"], "week")
        self.assertTrue(any("one week" in n for n in t["notes"]))
        by_week = {p["date"]: p for p in t["points"]}
        self.assertTrue(all(date.fromisoformat(k).weekday() == 0 for k in by_week))  # weeks start on Monday
        week_w, week_p = by_week["2026-09-07"], by_week["2026-08-31"]
        self.assertEqual((week_w["attendancePct"], week_w["absentPct"], week_w["latePct"]), (75.9, 17.2, 17.4))
        self.assertEqual((week_w["days"], week_w["expected"], week_w["rostered"]), (6, 29, 29))
        self.assertEqual((week_p["attendancePct"], week_p["absentPct"]), (89.6, 8.3))  # Friday 4 Sep is a holiday
        self.assertEqual(week_p["days"], 5)
        quiet = by_week["2026-07-06"]  # nothing was processed that week
        self.assertIsNone(quiet["attendancePct"])
        self.assertEqual(quiet["coveragePct"], 0.0)

    def test_up_to_62_days_stays_daily(self):
        self.assertEqual(self.trend({"from": "2026-07-14", "to": "2026-09-13"})["granularity"], "day")  # 62 days
        self.assertEqual(self.trend({"from": "2026-07-13", "to": "2026-09-13"})["granularity"], "week")  # 63

    def test_today_is_not_a_point(self):
        mark(self.e5, d(14), "PPPPPPO")
        mark(self.e5, d(21), "A")  # today's row, computed at 9 am: nobody has arrived yet
        t = self.trend({"from": "2026-09-14", "to": "2026-09-21"})
        self.assertEqual(t["points"][-1]["date"], "2026-09-19")
        self.assertEqual(len(t["points"]), 6)
        self.assertTrue(any("Today is still running" in n for n in t["notes"]))


# ─── weekday pattern and heatmaps ────────────────────────────────────────────────────────────────────────────────


class WeekdayTests(World):
    def test_attendance_by_weekday_and_the_monday_effect(self):
        with at():
            body = self.get(f"{BASE}/weekday", **W).json()
        rows = {w["name"]: w for w in body["weekdays"]}
        self.assertEqual(list(rows), ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat"])  # nobody is scheduled on Sundays
        self.assertEqual(
            [
                (w["attendancePct"], w["absentPct"], w["latePct"], w["absent"], w["scheduledDays"])
                for w in rows.values()
            ],
            [
                (100.0, 0.0, 0.0, 0, 5),
                (80.0, 20.0, 50.0, 1, 5),
                (50.0, 40.0, 33.3, 2, 5),
                (60.0, 40.0, 0.0, 2, 5),
                (90.0, 0.0, 20.0, 0, 5),
                (75.0, 0.0, 0.0, 0, 4),
            ],
        )
        self.assertEqual(body["lowest"]["name"], "Wed")
        # Monday: 0 % absent. The other days: 5 absences in 24 scheduled days = 20.8 %
        self.assertEqual(
            body["mondayEffect"], {"mondayAbsentPct": 0.0, "otherDaysAbsentPct": 20.8, "gapPts": -20.8, "mondays": 1}
        )
        self.assertEqual(
            body["heatmap"],
            {
                "weeks": ["2026-09-07"],
                "weekdays": ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat"],
                "values": [[100.0], [80.0], [50.0], [60.0], [90.0], [75.0]],
            },
        )

    def test_the_grid_has_a_column_per_week_and_a_gap_on_a_holiday(self):
        with at():
            body = self.get(f"{BASE}/weekday", **{"from": "2026-08-31", "to": "2026-09-13"}).json()
        grid = body["heatmap"]
        self.assertEqual(grid["weeks"], ["2026-08-31", "2026-09-07"])
        # week of 31 Aug: Mon 5 of 5, Tue/Wed 4 of 5 (E2 absent), Thu (4 + 0.5) / 5, Fri a holiday, Sat 4 of 4
        self.assertEqual(
            grid["values"],
            [[100.0, 100.0], [80.0, 80.0], [80.0, 50.0], [90.0, 60.0], [None, 90.0], [100.0, 75.0]],
        )

    def test_the_grid_shows_the_latest_weeks_when_the_period_is_longer(self):
        with at(), mock.patch.object(A, "HEATMAP_MAX_WEEKS", 1):
            body = self.get(f"{BASE}/weekday", **{"from": "2026-08-31", "to": "2026-09-13"}).json()
        self.assertEqual(body["heatmap"]["weeks"], ["2026-09-07"])
        self.assertTrue(any("last 1 weeks" in n for n in body["notes"]))


class HeatmapTests(World):
    def heatmap(self, params=W):
        with at():
            return self.get(f"{BASE}/heatmap", **params).json()

    def test_departments_by_day_worst_first(self):
        h = self.heatmap()
        self.assertEqual(
            h["departments"], ["Stitching", "Accounts", "Cutting"]
        )  # 61.1 %, then the two at 100 % by name
        self.assertEqual(h["days"], [f"2026-09-{n:02d}" for n in range(7, 13)])
        # Stitching = E1 E2 E4. Mon PPP, Tue P A P, Wed A A H, Thu P A A, Fri H P P, Sat P L P
        self.assertEqual(h["values"][0], [100.0, 66.7, 16.7, 33.3, 83.3, 66.7])
        self.assertEqual(h["values"][1], [100.0] * 6)  # Accounts: E5 present every day
        self.assertEqual(h["values"][2], [100.0, 100.0, 100.0, 100.0, 100.0, None])  # Cutting: E3 has Saturday off
        self.assertEqual((h["totalDepartments"], h["shownDepartments"], h["capped"]), (3, 3, False))

    def test_the_grid_is_capped_and_says_so(self):
        with at(), mock.patch.object(A, "HEATMAP_MAX_DAYS", 2), mock.patch.object(A, "HEATMAP_MAX_DEPARTMENTS", 1):
            h = self.get(f"{BASE}/heatmap", **W).json()
        self.assertEqual(h["days"], ["2026-09-11", "2026-09-12"])  # the latest working days
        self.assertEqual(h["departments"], ["Stitching"])
        self.assertTrue(h["capped"])
        self.assertTrue(any("last 2 working days" in n for n in h["notes"]))
        self.assertTrue(any("lowest attendance are shown, of 3" in n for n in h["notes"]))


# ─── departments, units, staff against production ────────────────────────────────────────────────────────────────


class DepartmentTests(World):
    def departments(self, params=W, **extra):
        with at():
            r = self.get(f"{BASE}/departments", **params, **extra)
        self.assertEqual(r.status_code, 200, r.content)
        return r.json()

    def test_the_ranking_lowest_attendance_first(self):
        body = self.departments()
        self.assertEqual(body["baseline"], {"attendancePct": 75.9, "absenteeismPct": 17.2, "latePct": 17.4})
        names = [r["name"] for r in body["departments"]]
        self.assertEqual(names, ["Stitching", "Accounts", "Cutting"])
        stitching = body["departments"][0]
        self.assertEqual(stitching["headcount"], 3)
        self.assertEqual(
            (stitching["scheduledDays"], stitching["attendancePct"], stitching["absenteeismPct"]),
            (18, 61.1, 27.8),  # 11 / 18 and 5 / 18
        )
        self.assertEqual((stitching["latePct"], stitching["halfDays"], stitching["absentDays"]), (8.3, 2, 5))
        # the week before: E1 5 of 5, E2 3 + 2 absent, E4 4 + a half day -> 12.5 / 15 and 2 / 15, no late day in 13 worked
        self.assertEqual(stitching["previous"], {"attendancePct": 83.3, "absenteeismPct": 13.3, "latePct": 0.0})
        self.assertEqual(
            stitching["delta"], {"attendancePct": -22.2, "absenteeismPct": 14.5, "latePct": 8.3}
        )  # in percentage points
        self.assertEqual(stitching["spark"], [None] * 6 + [83.3, 61.1])  # eight 7-day windows, the period last
        self.assertEqual(stitching["gapPts"], -14.8)  # 61.1 - 75.9
        cutting = body["departments"][2]
        self.assertEqual(
            (cutting["attendancePct"], cutting["latePct"], cutting["headcount"]), (100.0, 60.0, 1)
        )  # 3 / 5

    def test_a_department_well_below_the_company_is_flagged(self):
        self.assertFalse(self.departments()["departments"][0]["belowBaseline"])  # 3 people: too few to judge
        with mock.patch.object(A, "BASELINE_MIN_HEADCOUNT", 3):
            body = self.departments()
        self.assertEqual([r["name"] for r in body["departments"] if r["belowBaseline"]], ["Stitching"])
        self.assertEqual(self.departments()["belowBaselineRule"], {"gapPts": 3.0, "minHeadcount": 5})  # the real rule

    def test_units_and_staff_against_production(self):
        body = self.departments()
        units = {u["name"]: u for u in body["units"]}
        self.assertEqual(
            (units["Unit A"]["attendancePct"], units["Unit A"]["headcount"], units["Unit A"]["latePct"]),
            (69.6, 4, 23.5),  # 16 / 23; 4 late days over 17 worked
        )
        self.assertEqual(units["Unit A"]["id"], self.unit_a.id)  # the page narrows the scope by this id
        self.assertEqual(units["Head Office"]["attendancePct"], 100.0)
        types = {t["key"]: t for t in body["types"]}
        self.assertEqual([t["name"] for t in body["types"]], ["Production", "Staff"])  # lowest attendance first
        self.assertEqual((types["staff"]["attendancePct"], types["staff"]["headcount"]), (76.1, 4))
        self.assertEqual((types["production"]["attendancePct"], types["production"]["headcount"]), (75.0, 1))

    def test_the_limit_caps_the_ranking_and_says_how_many_there_are(self):
        body = self.departments(limit=2)
        self.assertEqual([r["name"] for r in body["departments"]], ["Stitching", "Accounts"])
        self.assertEqual((body["total"], body["limit"]), (3, 2))
        self.assertTrue(any("lowest attendance are shown, of 3" in n for n in body["notes"]))
        self.assertEqual(self.departments(limit=999)["limit"], A.DEPARTMENT_LIMIT_MAX)  # clamped, not refused

    def test_a_department_with_people_but_no_records_is_listed_without_numbers(self):
        mine = Department.objects.create(name="Packing", branch=self.unit_a)
        make_employee("T009", "Gita", "Rao", mine, self.unit_a)
        row = next(r for r in self.departments()["departments"] if r["name"] == "Packing")
        self.assertEqual((row["headcount"], row["scheduledDays"], row["hasRecords"]), (1, 0, False))
        self.assertIsNone(row["attendancePct"])

    def test_the_same_department_name_in_two_units_is_one_row(self):
        other = Department.objects.create(name="Stitching", branch=self.head_office)
        make_employee("T010", "Hema", "Lal", other, self.head_office)
        names = [r["name"] for r in self.departments()["departments"]]
        self.assertEqual(names.count("Stitching"), 1)
        row = next(r for r in self.departments()["departments"] if r["name"] == "Stitching")
        self.assertEqual(row["headcount"], 4)


# ─── who counts: the rules the Report Center follows, applied here ────────────────────────────────────────────────


class WhoCountsTests(World):
    def test_work_on_a_day_off_is_not_in_the_attendance_denominators(self):
        AttendanceDayRecord.objects.filter(employee=self.e4, date=d(13)).update(status="present")  # worked a Sunday
        s = self.summary()
        self.assertEqual(s["counts"]["workedOnDaysOff"], 1)
        self.assertEqual(s["metrics"]["attendancePct"]["value"], 75.9)  # unchanged: Sunday is not a scheduled day
        self.assertEqual(s["metrics"]["scheduledDays"]["value"], 29)
        self.assertEqual(s["counts"]["worked"], 24)
        self.assertEqual(s["metrics"]["latePct"]["value"], 16.7)  # 4 late days of 24 days worked

    def test_an_absent_row_on_a_holiday_is_not_an_absence(self):
        AttendanceDayRecord.objects.filter(employee=self.e1, date=d(4)).update(status="absent")  # 4 Sep is a holiday
        self.assertEqual(self.metrics()["absenteeismPct"]["previous"], 8.3)  # still 2 / 24

    def test_a_leaver_without_a_last_day_counts_until_the_last_day_they_worked(self):
        gone = make_employee("T006", "Hari", "Om", self.cutting, self.unit_a, status="inactive")
        mark(gone, d(7), "PPPAAAO")  # worked Mon-Wed, then absent: the engine kept computing after they left
        m = self.metrics()
        self.assertEqual(m["scheduledDays"]["value"], 32)  # 29 + three days
        self.assertEqual(m["absenteeismPct"]["value"], 15.6)  # still 5 absences: 5 / 32
        self.assertEqual(m["attendancePct"]["value"], 78.1)  # (24 + 1) / 32
        self.assertEqual(m["coveragePct"]["value"], 100.0)

    def test_a_leaver_with_an_approved_last_day_counts_until_that_day(self):
        gone = make_employee("T006", "Hari", "Om", self.cutting, self.unit_a, status="inactive")
        ResignationRequest.objects.create(employee=gone, status="approved", last_working_date=d(11))
        mark(gone, d(7), "PPPAAAO")  # absent Thu and Fri (until the last day), Saturday is after it
        m = self.metrics()
        self.assertEqual(m["scheduledDays"]["value"], 34)  # 29 + Mon-Fri
        self.assertEqual(m["absenteeismPct"]["value"], 20.6)  # 7 / 34
        self.assertEqual(m["attendancePct"]["value"], 73.5)  # 25 / 34

    def test_a_joiner_is_not_absent_before_the_joining_date(self):
        new = make_employee("T007", "Ila", "Jay", self.cutting, self.unit_a, join_date="2026-09-09")
        mark(new, d(7), "AAPPPPO")  # the engine marks the two days before joining absent
        m = self.metrics()
        self.assertEqual(m["scheduledDays"]["value"], 33)  # 29 + Wed-Sat
        self.assertEqual(m["absenteeismPct"]["value"], 15.2)  # 5 / 33
        self.assertEqual(m["coveragePct"]["value"], 100.0)

    def test_informed_absences_are_counted_apart(self):
        mark(self.e5, d(14), "aaPPPPO")
        s = self.summary({"from": "2026-09-14", "to": "2026-09-20"})
        self.assertEqual((s["counts"]["absent"], s["counts"]["informedAbsences"]), (2, 2))

    def test_a_day_with_no_shift_for_a_late_arrival_has_no_minutes(self):
        EmployeeShiftAssignment.objects.filter(employee=self.e3).delete()  # E3 has no shift any more
        s = self.summary()
        self.assertEqual(s["metrics"]["avgLateMinutes"]["value"], 40.0)  # only E1's 40 minutes can be worked out
        self.assertIn("3 late days could not be measured", " ".join(s["provenance"][3]["caveats"]))


# ─── period edges ────────────────────────────────────────────────────────────────────────────────────────────────


class PeriodEdgeTests(World):
    def test_both_ends_of_a_period_are_included(self):
        m = self.metrics({"from": "2026-09-07", "to": "2026-09-08"})
        # Monday: 5 present. Tuesday: 4 present, E2 absent -> 10 scheduled days, 9 present, 1 absent
        self.assertEqual(m["scheduledDays"]["value"], 10)
        self.assertEqual((m["attendancePct"]["value"], m["absenteeismPct"]["value"]), (90.0, 10.0))
        # previous = the two days before: Sat 5 Sep (E1 E2 E4 E5 present; E3 has the day off) and a Sunday
        self.assertEqual((m["attendancePct"]["previous"], m["scheduledDays"]["previous"]), (100.0, 4))
        self.assertEqual(m["attendancePct"]["delta"], {"abs": -10.0, "pct": -10.0})

    def test_a_single_day_with_nothing_scheduled_the_day_before(self):
        s = self.summary({"from": "2026-09-07", "to": "2026-09-07"})
        m = s["metrics"]
        self.assertEqual(m["attendancePct"]["value"], 100.0)
        self.assertEqual(s["previous"], {"start": "2026-09-06", "end": "2026-09-06", "days": 1})  # a Sunday
        for key in ("attendancePct", "absenteeismPct", "coveragePct", "scheduledDays"):
            self.assertIsNone(m[key]["previous"], key)  # nobody was scheduled: no figure, not 0
            self.assertIsNone(m[key]["delta"], key)

    def test_a_period_across_a_year_end(self):
        Holiday.objects.create(name="New Year", date=date(2026, 1, 1))
        mark(self.e5, date(2025, 12, 29), "PPAOPPO")  # Mon Tue Wed, Thu 1 Jan a holiday, Fri Sat, Sun
        s = self.summary({"from": "2025-12-29", "to": "2026-01-04", "department": "Accounts"})
        m = s["metrics"]
        self.assertEqual(m["scheduledDays"]["value"], 5)  # the holiday and the Sunday are not scheduled
        self.assertEqual((m["attendancePct"]["value"], m["absenteeismPct"]["value"]), (80.0, 20.0))
        self.assertEqual(s["previous"]["start"], "2025-12-22")
        self.assertIsNone(m["attendancePct"]["previous"])  # nothing was processed in the week before
        self.assertEqual((m["scheduledDays"]["previous"], m["coveragePct"]["previous"]), (6, 0.0))

    def test_today_is_left_out_and_shown_live(self):
        mark(self.e5, d(14), "PPPPPPO")
        mark(self.e5, d(21), "A")  # today's row, computed early: nobody has arrived yet
        s = self.summary({"from": "2026-09-14", "to": "2026-09-21", "department": "Accounts"})
        self.assertEqual(s["measured"], {"start": "2026-09-14", "end": "2026-09-20", "days": 7})
        self.assertEqual(s["metrics"]["attendancePct"]["value"], 100.0)  # today's absent row is not in it
        self.assertEqual(s["metrics"]["absenteeismPct"]["value"], 0.0)
        self.assertTrue(any("Today is still running" in n for n in s["notes"]))
        self.assertIsNotNone(s["live"])  # the period includes today
        self.assertIsNone(self.summary(W)["live"])  # this one does not

    def test_a_period_that_is_only_today_has_no_figures_but_the_live_count(self):
        s = self.summary({"period": "today"})
        self.assertIsNone(s["measured"])
        self.assertEqual(s["metrics"], {})
        self.assertEqual(s["live"]["date"], "2026-09-21")
        self.assertTrue(any("no completed day yet" in n for n in s["notes"]))

    def test_yesterday_a_sunday_has_nobody_scheduled(self):
        s = self.summary({"period": "yesterday"})
        self.assertEqual(s["measured"]["start"], "2026-09-20")
        self.assertIsNone(s["metrics"]["attendancePct"]["value"])
        self.assertEqual(s["coverage"]["expectedDays"], 0)

    def test_the_presets_follow_the_factory_clock(self):
        s = self.summary({"period": "last_month"})
        self.assertEqual((s["period"]["start"], s["period"]["end"]), ("2026-08-01", "2026-08-31"))

    def test_a_period_too_long_to_compare_has_no_previous_figures(self):
        s = self.summary({"from": "2026-01-01", "to": "2026-09-13"})  # 256 days
        self.assertIsNone(s["previous"])
        self.assertIsNone(s["metrics"]["attendancePct"]["previous"])
        self.assertTrue(any("not shown for periods longer than 190 days" in n for n in s["notes"]))


# ─── exceptions ──────────────────────────────────────────────────────────────────────────────────────────────────


class ExceptionRulesTests(MdApiTestCase):
    """Nine people in one department over three weeks, Mon 24 Aug .. Sat 12 Sep (Sundays are weekly offs).

    letter string per person, 7 characters a week, Mon..Sun; 18 working days each
    Arun    APPPPPO APPPPPO APPPPP    absent every Monday (24 Aug, 31 Aug, 7 Sep)
    Bala    PPPPPPO PPPPPPO PPPAAA    absent Thu-Sat 10-12 Sep: still absent on the last day
    Chitra  PPPPPPO PPPPPPO PaaaPP    absent Tue-Thu 8-10 Sep, all three marked informed by HR
    Dev     PPPPPPO PPPPPAO AAPPPP    absent Sat 5 Sep, then Mon 7 and Tue 8 Sep: a Sunday in between
    Esha    PPPPPPO PPPPPPO PA-AAP    absent Tue 8, no record Wed 9, absent Thu 10 and Fri 11 Sep
    Farid   PPPPPPO PPPPPPO ppppPP    late Mon-Thu 7-10 Sep (09:30, 09:30, 09:50, 10:10 for a 09:00 start)
    Gita    PPPPPPO PPPPPPO pppPPP    late three times
    Hari    all present               three missing-punch requests
    Ila     all present               two missing-punch requests
    """

    WINDOW = {"from": "2026-08-24", "to": "2026-09-12"}

    @classmethod
    def setUpTestData(cls):
        cls.unit = Branch.objects.create(name="Unit A", code="UA")
        cls.sewing = Department.objects.create(name="Sewing", branch=cls.unit)
        cls.shift = ShiftTemplate.objects.create(
            name="General",
            shift_type="staff",
            start_time=time(9),
            end_time=time(18),
            grace_period_minutes=15,
            first_half_end=time(13, 30),
            lunch_duration_minutes=60,
        )
        week1, week2 = "PPPPPPO", "PPPPPPO"
        patterns = {
            "Arun": "APPPPPOAPPPPPOAPPPPP",
            "Bala": week1 + week2 + "PPPAAA",
            "Chitra": week1 + week2 + "PaaaPP",
            "Dev": week1 + "PPPPPAO" + "AAPPPP",
            "Esha": week1 + week2 + "PA-AAP",
            "Farid": week1 + week2 + "ppppPP",
            "Gita": week1 + week2 + "pppPPP",
            "Hari": week1 + week2 + "PPPPPP",
            "Ila": week1 + week2 + "PPPPPP",
        }
        cls.people = {}
        for i, (name, codes) in enumerate(patterns.items(), start=1):
            emp = make_employee(f"X{i:03d}", name, "Test", cls.sewing, cls.unit)
            EmployeeShiftAssignment.objects.create(employee=emp, shift=cls.shift, effective_from=date(2026, 1, 1))
            mark(emp, d(24, 8), codes)
            cls.people[name] = emp
        for day, when in ((7, time(9, 30)), (8, time(9, 30)), (9, time(9, 50)), (10, time(10, 10))):
            first_punch(cls.people["Farid"], d(day), when)  # 30, 30, 50 and 70 minutes after 09:00

        def request(name, day, status):
            MissingPunchRequest.objects.create(
                employee=cls.people[name], date=day, punch_time=time(9), punch_type="IN", reason="forgot", status=status
            )

        request("Hari", d(1), "pending_hod")
        request("Hari", d(3), "approved")
        request("Hari", d(8), "rejected")
        request("Ila", d(2), "pending_hr")
        request("Ila", d(4), "approved")

    def exceptions(self, **extra):
        with at():
            r = self.get(f"{BASE}/exceptions", **self.WINDOW, **extra)
        self.assertEqual(r.status_code, 200, r.content)
        return r.json()

    def names(self, block):
        return [r["name"].split()[0] for r in block["rows"]]

    def test_chronic_absentees_three_days_and_a_tenth_of_their_days(self):
        body = self.exceptions()
        block = body["chronicAbsentees"]
        # Esha has 3 absences in 17 days with a record (17.6 %); the other four 3 in 18 (16.7 %): ties by name
        self.assertEqual((block["total"], self.names(block)), (5, ["Esha", "Arun", "Bala", "Chitra", "Dev"]))
        esha = block["rows"][0]
        self.assertEqual(
            (esha["absentDays"], esha["scheduledDays"], esha["absentPct"], esha["informedDays"], esha["leaveDays"]),
            (3, 17, 17.6, 0, 0),
        )
        self.assertEqual(esha["dates"], ["2026-09-11", "2026-09-10", "2026-09-08"])  # newest first
        self.assertEqual(
            (esha["name"], esha["code"], esha["department"], esha["unit"]), ("Esha Test", "X005", "Sewing", "Unit A")
        )
        self.assertEqual(esha["employeeId"], self.people["Esha"].id)
        chitra = block["rows"][3]
        self.assertEqual((chitra["absentDays"], chitra["informedDays"]), (3, 3))  # informed, but still absent days

    def test_habitual_late_comers_with_how_late(self):
        block = self.exceptions()["habitualLate"]
        self.assertEqual((block["total"], self.names(block)), (1, ["Farid"]))  # Gita: 3 lates is under the line
        farid = block["rows"][0]
        self.assertEqual((farid["lateDays"], farid["workedDays"], farid["latePct"]), (4, 18, 22.2))
        self.assertEqual(farid["avgLateMinutes"], 45.0)  # (30 + 30 + 50 + 70) / 4
        self.assertEqual(farid["dates"], ["2026-09-10", "2026-09-09", "2026-09-08", "2026-09-07"])

    def test_long_unexplained_absences_the_ongoing_one_first(self):
        block = self.exceptions()["longAbsences"]
        self.assertEqual((block["total"], self.names(block)), (2, ["Bala", "Dev"]))
        bala, dev = block["rows"]
        self.assertEqual(
            (bala["streakDays"], bala["from"], bala["to"], bala["ongoing"], bala["lastWorked"]),
            (3, "2026-09-10", "2026-09-12", True, "2026-09-09"),
        )
        # a Sunday between two absences does not break the run: Sat 5, (Sun 6), Mon 7, Tue 8
        self.assertEqual(
            (dev["streakDays"], dev["from"], dev["to"], dev["ongoing"], dev["lastWorked"]),
            (3, "2026-09-05", "2026-09-08", False, "2026-09-12"),
        )

    def test_a_missing_record_breaks_a_run_and_an_informed_absence_explains_it(self):
        names = self.names(self.exceptions()["longAbsences"])
        self.assertNotIn("Esha", names)  # absent 8th, then no record on the 9th, then 10th and 11th: runs of 1 and 2
        self.assertNotIn("Chitra", names)  # three days in a row, but HR marked them informed

    def test_frequent_missing_punch_requests(self):
        block = self.exceptions()["missingPunches"]
        self.assertEqual((block["total"], self.names(block)), (1, ["Hari"]))  # Ila has two: under the line
        hari = block["rows"][0]
        self.assertEqual((hari["requests"], hari["pending"], hari["approved"], hari["rejected"]), (3, 1, 1, 1))
        self.assertEqual(hari["dates"], ["2026-09-08", "2026-09-03", "2026-09-01"])

    def test_absent_mostly_on_the_day_after_a_day_off(self):
        block = self.exceptions()["afterOffAbsences"]
        self.assertEqual((block["total"], self.names(block)), (1, ["Arun"]))  # Dev: 1 of 3 on a Monday is not a pattern
        arun = block["rows"][0]
        self.assertEqual(
            (arun["absences"], arun["afterOffAbsences"], arun["mondayAbsences"], arun["sharePct"]), (3, 3, 3, 100.0)
        )
        self.assertEqual(arun["dates"], ["2026-09-07", "2026-08-31", "2026-08-24"])

    def test_the_monday_effect(self):
        # Mondays: 4 absences in 27 scheduled days (Arun 3, Dev 1) = 14.8 %; the other days 11 in 134 = 8.2 %
        self.assertEqual(
            self.exceptions()["mondayEffect"],
            {"mondayAbsentPct": 14.8, "otherDaysAbsentPct": 8.2, "gapPts": 6.6, "mondays": 3},
        )

    def test_counts_and_the_thresholds_behind_them(self):
        body = self.exceptions()
        self.assertEqual(
            body["counts"],
            {
                "chronicAbsentees": 5,
                "habitualLate": 1,
                "longAbsences": 2,
                "ongoingAbsences": 1,
                "missingPunches": 1,
                "afterOffAbsences": 1,
                "belowBaseline": 0,
                "punchRequests": 5,
            },
        )
        self.assertEqual(body["thresholds"]["chronicAbsent"], {"minDays": 3, "minPctOfScheduledDays": 10.0})
        self.assertEqual(body["thresholds"]["habitualLate"], {"minDays": 4, "minPctOfWorkedDays": 15.0})
        self.assertEqual(body["thresholds"]["longAbsence"], {"minDays": 3})
        self.assertEqual(body["thresholds"]["afterOff"], {"minAbsences": 3, "minSharePct": 60.0})
        self.assertEqual(body["thresholds"]["missingPunches"], {"minRequests": 3})
        ids = {p["id"] for p in body["provenance"]}
        self.assertEqual(
            ids,
            {
                "exceptions-absence",
                "exceptions-late",
                "exceptions-punches",
                "exceptions-after-off",
                "exceptions-baseline",
            },
        )
        text = " ".join(p["definition"] for p in body["provenance"])
        self.assertIn("3 or more unplanned absence days", text)  # the thresholds are quoted where the MD reads them
        self.assertIn("10% of the person's scheduled days", text)

    def test_the_list_is_capped_with_the_full_count_beside_it(self):
        block = self.exceptions(limit=2)["chronicAbsentees"]
        self.assertEqual((len(block["rows"]), block["total"]), (2, 5))
        self.assertEqual(len(self.exceptions(limit=999)["chronicAbsentees"]["rows"]), 5)  # clamped to 25, 5 exist

    def test_needs_your_attention_most_severe_first_with_the_numbers_in_the_titles(self):
        items = self.exceptions()["attention"]
        self.assertEqual(
            [(i["id"], i["severity"]) for i in items],
            [
                ("attendance.long-absence", "warning"),  # critical only when a run still going is 7+ days
                ("attendance.chronic-absentees", "warning"),
                ("attendance.monday-effect", "info"),
                ("attendance.after-off-pattern", "info"),
                ("attendance.habitual-late", "info"),
                ("attendance.missing-punches", "info"),
                ("attendance.coverage-gap", "info"),
            ],
        )
        by_id = {i["id"]: i for i in items}
        self.assertEqual(
            by_id["attendance.long-absence"]["title"],
            "2 employees have been absent 3+ days in a row without explanation",
        )
        self.assertEqual(by_id["attendance.long-absence"]["metric"], "2")
        self.assertIn("1 of them is still absent", by_id["attendance.long-absence"]["detail"])
        self.assertEqual(by_id["attendance.chronic-absentees"]["title"], "5 employees were absent on 3+ unplanned days")
        self.assertEqual(
            by_id["attendance.monday-effect"]["title"],
            "Mondays are the worst day: 14.8% absent against 8.2% on other days",
        )
        self.assertEqual(
            by_id["attendance.coverage-gap"]["title"], "Attendance records are missing for 0.6% of scheduled days"
        )
        for item in items:
            self.assertTrue(item["ask"], item["id"])  # every finding has a question for the assistant
            self.assertIsNone(item["page"])  # the page lists these on itself

    def test_a_run_of_seven_that_is_still_going_is_critical(self):
        # Hari is absent Sat 5 Sep and Mon-Sat 7-12 Sep: seven days with the Sunday between them bridged
        AttendanceDayRecord.objects.filter(
            employee=self.people["Hari"], date__in=[d(5), d(7), d(8), d(9), d(10), d(11), d(12)]
        ).update(status="absent")
        items = self.exceptions()["attention"]
        self.assertEqual(items[0]["id"], "attendance.long-absence")
        self.assertEqual(items[0]["severity"], "critical")

    def test_an_empty_scope_has_empty_lists(self):
        Department.objects.create(name="Empty", branch=self.unit)
        with at():
            body = self.get(f"{BASE}/exceptions", **self.WINDOW, department="Empty").json()
        for key in (
            "chronicAbsentees",
            "habitualLate",
            "longAbsences",
            "missingPunches",
            "afterOffAbsences",
            "belowBaseline",
        ):
            self.assertEqual(body[key], {"total": 0, "rows": []}, key)
        self.assertEqual(body["attention"], [])
        self.assertIsNone(body["mondayEffect"])


class ExceptionsAgainstTheCompanyTests(World):
    def test_a_department_well_below_the_company_is_listed(self):
        with at(), mock.patch.object(A, "BASELINE_MIN_HEADCOUNT", 3):
            body = self.get(f"{BASE}/exceptions", **W).json()
        block = body["belowBaseline"]
        self.assertEqual(block["total"], 1)
        row = block["rows"][0]
        self.assertEqual(
            (row["name"], row["attendancePct"], row["gapPts"], row["headcount"]), ("Stitching", 61.1, -14.8, 3)
        )
        item = next(i for i in body["attention"] if i["id"] == "attendance.dept-below-baseline")
        self.assertEqual(item["title"], "1 department is well below the company's attendance")
        self.assertIn("Stitching is at 61.1% against 75.9% for the company", item["detail"])

    def test_the_week_in_exceptions(self):
        with at():
            body = self.get(f"{BASE}/exceptions", **W).json()
        # E2: three absences in 6 scheduled days (50 %) on 8, 9 and 10 Sep, the 12th on leave
        self.assertEqual([r["name"] for r in body["chronicAbsentees"]["rows"]], ["Bala Raj"])
        row = body["chronicAbsentees"]["rows"][0]
        self.assertEqual((row["absentDays"], row["scheduledDays"], row["absentPct"], row["leaveDays"]), (3, 6, 50.0, 1))
        long_run = body["longAbsences"]["rows"][0]
        self.assertEqual((long_run["name"], long_run["streakDays"], long_run["ongoing"]), ("Bala Raj", 3, False))
        self.assertEqual(body["habitualLate"]["total"], 0)  # E3's three lates are one short of 4
        self.assertEqual(body["afterOffAbsences"]["total"], 0)


# ─── overtime ────────────────────────────────────────────────────────────────────────────────────────────────────


def add_overtime(emp, day, minutes, status, kind=None):
    return OvertimeRecord.objects.create(
        employee=emp, date=day, last_punch_out=time(20), ot_minutes=minutes, status=status, compensation_type=kind
    )


class OvertimeTests(World):
    def setUp(self):
        super().setUp()
        settings = PayrollSettings.get()
        settings.ot_detection_enabled = True
        settings.save()
        add_overtime(self.e1, d(9), 120, "announced", "pay")
        add_overtime(self.e1, d(10), 90, "detected")
        add_overtime(self.e3, d(8), 60, "rejected")  # HR refused it: not in any figure
        add_overtime(self.e5, d(11), 180, "announced", "relaxation")
        add_overtime(self.e2, d(2, 9), 60, "announced", "pay")  # the week before

    def overtime(self, params=W, **extra):
        with at():
            r = self.get(f"{BASE}/overtime", **params, **extra)
        self.assertEqual(r.status_code, 200, r.content)
        return r.json()

    def test_hours_against_the_previous_period(self):
        body = self.overtime()
        self.assertEqual(body["totalHours"], 6.5)  # (120 + 90 + 180) / 60, the rejected hour left out
        self.assertEqual((body["previousHours"], body["delta"]), (1.0, {"abs": 5.5, "pct": 550.0}))
        self.assertEqual((body["days"], body["employees"]), (3, 2))
        self.assertEqual(
            body["decisions"],
            {
                "announcedPay": {"days": 1, "hours": 2.0},
                "announcedRelaxation": {"days": 1, "hours": 3.0},
                "detected": {"days": 1, "hours": 1.5},
                "rejected": {"days": 1, "hours": 1.0},
            },
        )
        self.assertEqual(body["tracking"], {"featureEnabled": True, "detectionEnabled": True})

    def test_by_department_and_the_people_with_the_most(self):
        body = self.overtime()
        self.assertEqual(
            body["byDepartment"],
            [
                {"name": "Stitching", "hours": 3.5, "days": 2, "employees": 1, "sharePct": 53.8},  # 210 of 390 minutes
                {"name": "Accounts", "hours": 3.0, "days": 1, "employees": 1, "sharePct": 46.2},
            ],
        )
        first, second = body["topEarners"]
        self.assertEqual((first["name"], first["code"], first["hours"], first["days"]), ("Asha Kumar", "T001", 3.5, 2))
        self.assertEqual(
            (second["name"], second["department"], second["unit"]), ("Esha Mani", "Accounts", "Head Office")
        )
        self.assertEqual(body["earnersTotal"], 2)

    def test_the_trend_has_a_zero_for_a_working_day_without_overtime(self):
        trend = self.overtime()["trend"]
        self.assertEqual(trend["granularity"], "day")
        self.assertEqual(
            [(p["date"], p["hours"], p["employees"]) for p in trend["points"]],
            [
                ("2026-09-07", 0.0, 0),
                ("2026-09-08", 0.0, 0),  # E3's rejected hour is not overtime
                ("2026-09-09", 2.0, 1),
                ("2026-09-10", 1.5, 1),
                ("2026-09-11", 3.0, 1),
                ("2026-09-12", 0.0, 0),
            ],
        )

    def test_overtime_as_a_share_of_the_hours_staff_were_scheduled(self):
        body = self.overtime()
        # staff days with a record: E1 6 + E2 6 + E3 5 + E5 6 = 23, each a 09:00-18:00 shift less an hour's lunch = 8 h
        self.assertEqual(body["scheduledHours"], 184.0)
        self.assertEqual(body["pctOfScheduledHours"], 3.5)  # 6.5 / 184

    def test_overtime_by_limit(self):
        body = self.overtime(limit=1)
        self.assertEqual(len(body["topEarners"]), 1)
        self.assertEqual(body["earnersTotal"], 2)

    def test_the_summary_shows_the_same_hours(self):
        m = self.metrics()
        self.assertEqual(m["overtimeHours"]["value"], 6.5)
        self.assertEqual(m["overtimeHours"]["previous"], 1.0)
        self.assertEqual(m["overtimeHours"]["good"], "down")
        self.assertEqual(self.summary()["counts"]["overtimeDays"], 3)

    def test_a_department_row_carries_its_overtime(self):
        with at():
            rows = {r["name"]: r for r in self.get(f"{BASE}/departments", **W).json()["departments"]}
        self.assertEqual((rows["Stitching"]["overtimeHours"], rows["Accounts"]["overtimeHours"]), (3.5, 3.0))
        self.assertEqual(rows["Cutting"]["overtimeHours"], 0.0)

    def test_overtime_is_not_tracked_when_the_feature_is_switched_off(self):
        settings = PayrollSettings.get()
        settings.compensation_feature_enabled = False
        settings.save()
        body = self.overtime()
        self.assertIsNone(body["totalHours"])
        self.assertTrue(any("Compensation feature is switched off" in n for n in body["notes"]))
        self.assertIsNone(self.metrics()["overtimeHours"]["value"])

    def test_nothing_found_is_zero_when_detection_is_on_and_unknown_when_it_is_off(self):
        OvertimeRecord.objects.all().delete()
        self.assertEqual(self.overtime()["totalHours"], 0.0)  # tracked, and none
        self.assertEqual(self.metrics()["overtimeHours"]["value"], 0.0)
        settings = PayrollSettings.get()
        settings.ot_detection_enabled = False
        settings.save()
        body = self.overtime()
        self.assertIsNone(body["totalHours"])  # nobody is looking for overtime: not "no overtime"
        self.assertTrue(any("detection is switched off" in n for n in body["notes"]))
        self.assertIsNone(self.metrics()["overtimeHours"]["value"])

    def test_staff_without_a_shift_are_left_out_of_the_scheduled_hours(self):
        EmployeeShiftAssignment.objects.filter(employee=self.e5).delete()
        body = self.overtime()
        self.assertEqual(body["scheduledHours"], 136.0)  # 17 days x 8 h
        self.assertTrue(any("no shift assignment" in n for n in body["notes"]))

    def test_the_explanation_names_what_overtime_is_and_where_the_money_is(self):
        by_id = {p["id"]: p for p in self.overtime()["provenance"]}
        self.assertEqual(set(by_id), {"overtime-hours", "overtime-share", "overtime-decisions"})
        self.assertIn("Payroll Analysis", " ".join(by_id["overtime-hours"]["caveats"]))


# ─── leave, permissions, approvals waiting ───────────────────────────────────────────────────────────────────────


def aged(obj, days_before_today):
    """Make a request look like it was filed ``days_before_today`` days before the frozen today (10:00 factory time)."""
    when = datetime.combine(TODAY - timedelta(days=days_before_today), time(4, 30), tzinfo=dt_timezone.utc)
    type(obj).objects.filter(pk=obj.pk).update(created_at=when)
    return obj


class LeaveTests(World):
    def setUp(self):
        super().setUp()
        self.cl = LeaveType.objects.get(code="CL")
        self.sl = LeaveType.objects.get(code="SL")

    def leave_request(self, emp, start, end, kind, status="approved", half=False):
        return LeaveRequest.objects.create(
            employee=emp,
            leave_type_ref=kind,
            type="casual",
            start_date=start,
            end_date=end,
            total_days=0.5 if half else 1,
            is_half_day=half,
            half_day_slot="morning" if half else None,
            status=status,
        )

    def leave(self, params=W):
        with at():
            r = self.get(f"{BASE}/leave", **params)
        self.assertEqual(r.status_code, 200, r.content)
        return r.json()

    def test_leave_days_by_type_against_the_previous_period(self):
        self.leave_request(self.e2, "2026-09-12", "2026-09-12", self.cl)
        self.leave_request(self.e2, "2026-09-12", "2026-09-12", self.cl)  # a duplicate request: the day counts once
        self.leave_request(self.e4, "2026-09-09", "2026-09-10", self.cl)  # production: attendance ignores leave
        self.leave_request(self.e3, "2026-09-08", "2026-09-08", self.sl, half=True)  # half a day
        self.leave_request(
            self.e1, "2026-09-12", "2026-09-14", self.sl
        )  # Sat, Sun, Mon: Sunday skipped, Monday is outside
        self.leave_request(self.e5, "2026-09-01", "2026-09-01", self.sl)  # the week before
        self.leave_request(self.e5, "2026-09-09", "2026-09-09", self.sl, status="rejected")  # not approved: not counted
        CasualLeaveRequest.objects.create(employee=self.e1, date=d(7), status="approved")  # a paid day
        body = self.leave()
        self.assertEqual(
            [(r["name"], r["days"], r["requests"]) for r in body["byType"]],
            [("Sick Leave", 1.5, 2), ("Casual Leave", 1.0, 1), ("Casual leave (paid day)", 1.0, 1)],
        )
        self.assertEqual(body["totalDays"], 3.5)
        self.assertEqual((body["previousDays"], body["delta"]), (1.0, {"abs": 2.5, "pct": 250.0}))
        self.assertEqual((body["employeesOnLeave"], body["casualLeaveDays"]), (3, 1))  # E1, E2, E3

    def test_permissions_taken_and_waiting(self):
        for emp, day, kind, status in (
            (self.e1, d(8), "morning_late_in", "approved"),
            (self.e3, d(9), "middle_permission", "approved"),
            (self.e3, d(10), "morning_late_in", "pending"),
            (self.e2, d(2), "evening_early_out", "approved"),  # the week before
        ):
            EmployeePermission.objects.create(employee=emp, date=day, type=kind, status=status)
        perms = self.leave()["permissions"]
        self.assertEqual((perms["approved"], perms["previousApproved"]), (2, 1))
        self.assertEqual(perms["delta"], {"abs": 1, "pct": 100.0})
        self.assertEqual(
            perms["byType"], [{"type": "Middle one-hour", "count": 1}, {"type": "Morning late-in", "count": 1}]
        )

    def test_approvals_waiting_and_how_long_the_oldest_has_waited(self):
        aged(self.leave_request(self.e3, "2026-09-25", "2026-09-25", self.sl, status="pending"), 20)
        aged(self.leave_request(self.e1, "2026-09-26", "2026-09-26", self.cl, status="pending"), 3)
        aged(EmployeePermission.objects.create(employee=self.e2, date=d(10), status="pending"), 7)
        aged(CasualLeaveRequest.objects.create(employee=self.e5, date=d(30), status="pending"), 1)
        aged(
            MissingPunchRequest.objects.create(
                employee=self.e1, date=d(9), punch_time=time(9), punch_type="IN", reason="x", status="pending_hr"
            ),
            5,
        )
        aged(
            MissingPunchRequest.objects.create(
                employee=self.e1, date=d(10), punch_time=time(9), punch_type="IN", reason="x", status="approved"
            ),
            9,
        )  # decided: not waiting
        body = self.leave()
        pending = {p["kind"]: p for p in body["pending"]}
        self.assertEqual(
            (pending["leave"]["count"], pending["leave"]["oldestDays"], pending["leave"]["oldestOn"]),
            (2, 20, "2026-09-01"),
        )
        self.assertEqual((pending["permission"]["count"], pending["permission"]["oldestDays"]), (1, 7))
        self.assertEqual((pending["casual_leave"]["count"], pending["casual_leave"]["oldestDays"]), (1, 1))
        self.assertEqual((pending["missing_punch"]["count"], pending["missing_punch"]["oldestDays"]), (1, 5))
        self.assertEqual((body["pendingTotal"], body["oldestPendingDays"]), (5, 20))

    def test_nothing_waiting_has_no_age(self):
        body = self.leave()
        self.assertEqual(body["pendingTotal"], 0)
        self.assertIsNone(body["oldestPendingDays"])
        self.assertTrue(all(p["oldestDays"] is None for p in body["pending"]))

    def test_the_pending_snapshot_follows_the_scope(self):
        aged(self.leave_request(self.e3, "2026-09-25", "2026-09-25", self.sl, status="pending"), 10)
        aged(self.leave_request(self.e5, "2026-09-26", "2026-09-26", self.sl, status="pending"), 4)
        with at():
            body = self.get(f"{BASE}/leave", **W, branch="Head Office").json()
        self.assertEqual({p["kind"]: p["count"] for p in body["pending"]}["leave"], 1)  # only E5's
        self.assertEqual(body["oldestPendingDays"], 4)

    def test_a_period_with_no_leave_is_a_zero(self):
        body = self.leave()
        self.assertEqual((body["totalDays"], body["byType"]), (0.0, []))


# ─── one day ─────────────────────────────────────────────────────────────────────────────────────────────────────


def group(rows, name):
    return next(r for r in rows if r["name"] == name)


class DayTests(World):
    def day(self, **params):
        with at():
            r = self.get(f"{BASE}/day", **params)
        self.assertEqual(r.status_code, 200, r.content)
        return r.json()

    def test_a_past_day_by_unit_department_and_type(self):
        body = self.day(date="2026-09-09")  # Wed: E1 absent, E2 absent, E3 late, E4 half day, E5 present
        self.assertEqual((body["weekday"], body["isToday"], body["provisional"]), ("Wed", False, False))
        self.assertEqual(body["source"], "attendance day records")
        totals = body["totals"]
        self.assertEqual(
            (totals["expected"], totals["present"], totals["half"], totals["absent"], totals["leave"], totals["late"]),
            (5, 3, 1, 2, 0, 1),
        )
        self.assertEqual((totals["attendancePct"], totals["absentPct"], totals["notRecorded"]), (50.0, 40.0, 0))
        units = body["byUnit"]
        self.assertEqual([u["name"] for u in units], ["Unit A", "Head Office"])  # the most absent first
        unit_a = units[0]
        self.assertEqual((unit_a["expected"], unit_a["present"], unit_a["absent"], unit_a["late"]), (4, 2, 2, 1))
        self.assertEqual((unit_a["attendancePct"], unit_a["absentPct"], unit_a["id"]), (37.5, 50.0, self.unit_a.id))
        departments = body["byDepartment"]
        self.assertEqual([x["name"] for x in departments], ["Stitching", "Accounts", "Cutting"])
        stitching = departments[0]
        self.assertEqual(
            (stitching["expected"], stitching["present"], stitching["half"], stitching["absent"]), (3, 1, 1, 2)
        )
        self.assertEqual((stitching["attendancePct"], stitching["absentPct"]), (16.7, 66.7))
        self.assertEqual(group(departments, "Cutting")["late"], 1)
        by_type = {t["name"]: t for t in body["byType"]}
        self.assertEqual((by_type["Staff"]["expected"], by_type["Staff"]["absent"]), (4, 2))
        self.assertEqual((by_type["Production"]["present"], by_type["Production"]["half"]), (1, 1))

    def test_employees_nobody_processed_are_not_recorded(self):
        AttendanceDayRecord.objects.filter(employee=self.e1, date=d(9)).delete()
        body = self.day(date="2026-09-09")
        totals = body["totals"]
        self.assertEqual((totals["expected"], totals["notRecorded"]), (4, 1))
        self.assertEqual(group(body["byUnit"], "Unit A")["notRecorded"], 1)
        self.assertEqual(body["coverage"]["coveragePct"], 80.0)
        self.assertTrue(any("4 of 5 employees scheduled that day" in n for n in body["notes"]))

    def test_a_weekly_off_has_nobody_scheduled(self):
        body = self.day(date="2026-09-13")  # a Sunday
        self.assertFalse(body["isWorkingDay"])
        self.assertEqual(body["totals"]["expected"], 0)
        self.assertTrue(any("Nobody was scheduled" in n for n in body["notes"]))

    def test_people_who_work_a_day_off_are_counted_apart(self):
        AttendanceDayRecord.objects.filter(employee=self.e4, date=d(13)).update(status="present")
        body = self.day(date="2026-09-13")
        self.assertEqual(body["totals"]["workedDayOff"], 1)
        self.assertFalse(body["isWorkingDay"])
        self.assertTrue(any("1 person worked anyway" in n for n in body["notes"]))

    def test_yesterday_and_the_words_for_dates(self):
        self.assertEqual(self.day(date="yesterday")["date"], "2026-09-20")
        self.assertEqual(self.day()["date"], "2026-09-20")  # the default is yesterday
        self.assertEqual(self.day(date="today")["date"], "2026-09-21")

    def test_the_day_follows_the_scope(self):
        body = self.day(date="2026-09-09", department="Stitching")
        self.assertEqual((body["totals"]["expected"], body["totals"]["absent"]), (3, 2))
        self.assertEqual([u["name"] for u in body["byUnit"]], ["Unit A"])

    def test_the_departments_are_capped_by_limit(self):
        self.assertEqual(len(self.day(date="2026-09-09", limit=2)["byDepartment"]), 2)


class LiveTodayTests(World):
    """Today is Monday 21 Sep: all five are scheduled. Punches come from the raw punch log."""

    def punch(self, emp, at_time, day=TODAY):
        AttendanceLog.objects.create(employee=emp, date=day, punch_time=at_time, punch_type="IN", source="biometric")

    def live(self, **params):
        with at():
            r = self.get(f"{BASE}/day", date="today", **params)
        self.assertEqual(r.status_code, 200, r.content)
        return r.json()

    def test_who_is_in_so_far(self):
        self.punch(self.e1, time(9, 5))
        self.punch(self.e2, time(9, 10))
        self.punch(self.e4, time(8, 20))
        self.punch(self.e5, time(3, 30))  # before 05:00: the previous day's late exit, not an arrival
        LeaveRequest.objects.create(
            employee=self.e3,
            type="casual",
            start_date="2026-09-20",
            end_date="2026-09-22",
            total_days=3,
            status="approved",
        )
        body = self.live()
        self.assertEqual((body["isToday"], body["provisional"]), (True, True))
        self.assertEqual(body["source"], "punches so far today")
        self.assertEqual(body["asOf"], "2026-09-21T12:00:00")
        totals = body["totals"]
        # in: E1 E2 E4; on approved leave: E3; not in yet: E5 (whose only punch was at 03:30)
        self.assertEqual((totals["expected"], totals["present"], totals["leave"], totals["absent"]), (5, 3, 1, 1))
        self.assertEqual(totals["attendancePct"], 60.0)
        self.assertIsNone(totals["late"])  # lateness is not known until the day record is computed
        self.assertTrue(any("'absent' here means 'not in yet'" in n for n in body["notes"]))
        self.assertEqual([u["name"] for u in body["byUnit"]], ["Head Office", "Unit A"])  # who is missing most first
        self.assertEqual((group(body["byUnit"], "Unit A")["present"], group(body["byUnit"], "Unit A")["leave"]), (3, 1))
        self.assertEqual(group(body["byType"], "Production")["present"], 1)

    def test_production_has_no_leave_and_half_day_leave_is_not_a_day_off(self):
        LeaveRequest.objects.create(
            employee=self.e4,
            type="casual",
            start_date="2026-09-21",
            end_date="2026-09-21",
            total_days=1,
            status="approved",
        )  # production: the engine ignores it
        LeaveRequest.objects.create(
            employee=self.e1,
            type="casual",
            start_date="2026-09-21",
            end_date="2026-09-21",
            total_days=0.5,
            is_half_day=True,
            half_day_slot="morning",
            status="approved",
        )
        totals = self.live()["totals"]
        self.assertEqual((totals["leave"], totals["absent"]), (0, 5))  # nobody has punched: all five not in yet

    def test_approved_casual_leave_today_is_leave(self):
        CasualLeaveRequest.objects.create(employee=self.e5, date=TODAY, status="approved")
        self.assertEqual(self.live()["totals"]["leave"], 1)

    def test_a_saturday_off_a_sunday_and_a_holiday(self):
        with at(d(12)):  # Saturday: E3 has it off
            body = self.get(f"{BASE}/day", date="today").json()
        self.assertEqual(body["totals"]["expected"], 4)
        with at(d(13)):  # Sunday
            body = self.get(f"{BASE}/day", date="today").json()
        self.assertFalse(body["isWorkingDay"])
        self.assertEqual(body["totals"]["expected"], 0)
        self.assertTrue(any("Nobody is scheduled" in n for n in body["notes"]))
        Holiday.objects.create(name="Today only", date=TODAY)
        self.assertEqual(self.live()["totals"]["expected"], 0)

    def test_joiners_and_leavers_and_people_who_left(self):
        make_employee("T020", "Late", "Joiner", self.cutting, self.unit_a, join_date="2026-09-22")  # joins tomorrow
        make_employee("T021", "Gone", "Away", self.cutting, self.unit_a, status="inactive")
        gone_soon = make_employee("T022", "Last", "Week", self.cutting, self.unit_a)
        ResignationRequest.objects.create(employee=gone_soon, status="approved", last_working_date=d(18))
        self.assertEqual(self.live()["totals"]["expected"], 5)  # none of the three is expected today

    def test_a_punch_on_a_day_off_is_not_an_arrival(self):
        self.punch(self.e3, time(9, 0), day=d(12))
        with at(d(12)):
            body = self.get(f"{BASE}/day", date="today").json()
        self.assertEqual(body["totals"]["workedDayOff"], 1)  # E3 came in on her Saturday off
        self.assertEqual(body["totals"]["present"], 0)

    def test_the_summary_carries_the_live_count_when_the_period_includes_today(self):
        self.punch(self.e1, time(9, 5))
        s = self.summary({"period": "last_7_days"})
        self.assertEqual((s["live"]["expected"], s["live"]["present"], s["live"]["attendancePct"]), (5, 1, 20.0))
        self.assertTrue(s["live"]["provisional"])


# ─── the assistant's tools ───────────────────────────────────────────────────────────────────────────────────────

EXPECTED_TOOLS = {
    "attendance_summary",
    "attendance_trend",
    "attendance_by_department",
    "attendance_exceptions",
    "attendance_overtime",
    "attendance_leave",
    "attendance_on_date",
    "attendance_compare_periods",
}


class ToolTests(World):
    def run_tool(self, name, **args):
        spec = registry.collect_tools()[name]
        with at(), read_only_db():
            out = spec.run(args)
        json.dumps(out)  # plain JSON: no dates, no Decimals
        return out

    def test_the_tools_are_registered_and_described_for_a_model(self):
        tools = registry.collect_tools()
        self.assertTrue(EXPECTED_TOOLS <= set(tools))
        for name in EXPECTED_TOOLS:
            spec = tools[name]
            self.assertEqual(spec.page, "attendance")
            self.assertGreaterEqual(len(spec.description), 150, name)  # says when to use it and what comes back
            self.assertIn("Use it for", spec.description, name)

    def test_a_tool_returns_the_number_on_the_page(self):
        params = {**W, "department": "Stitching"}
        page = self.summary(params)
        out = self.run_tool("attendance_summary", **params)
        self.assertEqual(out["metrics"], page["metrics"])
        self.assertEqual(out["metrics"]["attendancePct"]["value"], 61.1)
        self.assertEqual(out["provenance"], page["provenance"])  # the assistant quotes the same explanation

    def test_the_tools_that_take_a_limit_clamp_it(self):
        self.assertEqual(len(self.run_tool("attendance_by_department", **W, limit="2")["departments"]), 2)
        out = self.run_tool("attendance_exceptions", **W, limit=99)
        self.assertEqual(len(out["chronicAbsentees"]["rows"]), 1)  # 15 at most, one exists
        default = registry.collect_tools()["attendance_exceptions"]
        self.assertEqual(default.properties["limit"]["maximum"], 15)

    def test_the_day_tool_answers_how_many_were_absent_in_a_department(self):
        out = self.run_tool("attendance_on_date", date="2026-09-09", department="stitching")
        self.assertEqual((out["totals"]["expected"], out["totals"]["absent"]), (3, 2))
        self.assertEqual(self.run_tool("attendance_on_date")["date"], "2026-09-20")  # yesterday by default
        with self.assertRaises(MdParamError):
            self.run_tool("attendance_on_date", date="2026-12-31")

    def test_the_comparison_tool_puts_two_periods_side_by_side(self):
        out = self.run_tool(
            "attendance_compare_periods", period_a="2026-08-31..2026-09-06", period_b="2026-09-07..2026-09-13"
        )
        self.assertEqual((out["a"]["metrics"]["attendancePct"], out["b"]["metrics"]["attendancePct"]), (89.6, 75.9))
        self.assertEqual(out["differences"]["attendancePct"], {"abs": -13.7, "pct": -15.3})  # B minus A
        self.assertEqual(out["differences"]["absenteeismPct"], {"abs": 8.9, "pct": 107.2})
        self.assertEqual(out["a"]["metrics"]["halfDays"], 1)
        self.assertEqual(out["b"]["metrics"]["halfDays"], 2)
        self.assertEqual(out["notes"], [])

    def test_two_periods_of_different_length_say_to_compare_percentages(self):
        out = self.run_tool(
            "attendance_compare_periods", period_a="2026-09-07..2026-09-08", period_b="2026-09-07..2026-09-13"
        )
        self.assertTrue(any("different lengths" in n for n in out["notes"]))

    def test_a_period_is_named_in_the_ways_a_person_would(self):
        today = TODAY
        last_month = A.period_from_text("last_month", today)
        self.assertEqual((last_month.start, last_month.end), (d(1, 8), d(31, 8)))
        month = A.period_from_text("2026-09", today)
        self.assertEqual((month.start, month.end), (d(1), d(30)))
        for text in ("2026-09-01..2026-09-15", "2026-09-01 to 2026-09-15", "2026-09-01/2026-09-15"):
            span = A.period_from_text(text, today)
            self.assertEqual((span.start, span.end), (d(1), d(15)), text)
        for bad in ("", "last fortnight", "2026-13", "2026-09-15..2026-09-01"):
            with self.assertRaises(MdParamError, msg=bad):
                A.period_from_text(bad, today)

    def test_every_tool_runs_inside_the_read_only_guard_and_explains_itself(self):
        for name in EXPECTED_TOOLS:
            args = {"period_a": "last_month", "period_b": "this_month"} if name == "attendance_compare_periods" else {}
            out = self.run_tool(name, **args)
            self.assertTrue(out["provenance"], name)
            self.assertIn("generatedAt", out)

    def test_what_the_model_is_sent_stays_small(self):
        """The engine trims a tool result to about 6,000 characters (assistant/shaping.py); check the figures and the
        top of each list survive the trim, so the answer is not built on a stump."""
        for name in sorted(EXPECTED_TOOLS):
            args = (
                {"period_a": "last_month", "period_b": "this_month"}
                if name == "attendance_compare_periods"
                else dict(W)
            )
            out = self.run_tool(name, **args)
            compact = shaping.compact(out)
            self.assertLessEqual(len(json.dumps(compact, default=str)), shaping.MAX_CHARS, name)
        summary = shaping.compact(self.run_tool("attendance_summary", **W))
        self.assertEqual(summary["metrics"]["attendancePct"]["value"], 75.9)
        self.assertTrue(summary["caveats"])  # the caveats survive: the model must not hide them


# ─── a read creates nothing ──────────────────────────────────────────────────────────────────────────────────────


class ReadOnlyTests(MdApiTestCase):
    def test_no_endpoint_creates_a_settings_row_on_an_empty_database(self):
        before = (PayrollSettings.objects.count(), ProductionShiftConfig.objects.count())
        for route in ROUTES:
            with at():
                self.assertEqual(self.get(f"{BASE}/{route}").status_code, 200, route)
        with at(), read_only_db():
            A.insights(today=TODAY)
            A.headline(today=TODAY)
        self.assertEqual((PayrollSettings.objects.count(), ProductionShiftConfig.objects.count()), before)

    def test_an_empty_database_is_empty_everywhere_never_zero(self):
        with at():
            s = self.get(f"{BASE}/summary").json()
            body = {route: self.get(f"{BASE}/{route}").json() for route in ROUTES}
        for key, metric in s["metrics"].items():
            self.assertIsNone(metric["value"], key)
        self.assertEqual(body["trend"]["points"], [])
        self.assertEqual(body["departments"]["departments"], [])
        self.assertEqual(body["heatmap"]["departments"], [])
        self.assertEqual(body["weekday"]["weekdays"], [])
        self.assertEqual(body["exceptions"]["attention"], [])
        self.assertEqual(body["overtime"]["byDepartment"], [])
        self.assertEqual(body["leave"]["pendingTotal"], 0)
        self.assertEqual(body["day"]["totals"]["expected"], 0)
        with at():
            self.assertEqual(A.insights(today=TODAY), [])


# ─── for the Dashboard ───────────────────────────────────────────────────────────────────────────────────────────


def working_days(start: date, end: date):
    day = start
    while day <= end:
        if day.weekday() != 6:
            yield day
        day += timedelta(days=1)


BASELINE_ABSENCES = [d(17, 6), d(18, 6), d(19, 6), d(22, 6), d(23, 6), d(24, 6), d(25, 6), d(26, 6), d(29, 6), d(30, 6)]


class InsightsBase(MdApiTestCase):
    """Ten people in Sewing (Unit A) with a day record on every working day from Tue 16 Jun to Sat 19 Sep, today being
    Monday 21 Sep. The 90 days before the last 7 hold ONE absence each (10 in 770 scheduled days = 1.3 %)."""

    def setUp(self):
        super().setUp()
        self.unit = Branch.objects.create(name="Unit A", code="UA")
        self.sewing = Department.objects.create(name="Sewing", branch=self.unit)

    def staff(self, count=10, dept=None, prefix="S"):
        dept = dept or self.sewing
        Employee.objects.bulk_create(
            [
                Employee(
                    employee_code=f"{prefix}{i:03d}",
                    first_name=f"{prefix}{i}",
                    last_name="Test",
                    department=dept,
                    branch=self.unit,
                    employment_type="staff",
                    join_date="2025-01-01",
                )
                for i in range(count)
            ]
        )
        return list(Employee.objects.filter(employee_code__startswith=prefix).order_by("employee_code"))

    def records(self, people, absences=None, start=d(16, 6), end=d(20)):
        absences = absences or {}
        rows = []
        for i, emp in enumerate(people):
            gone = set(absences.get(i, ()))
            for day in working_days(start, end):
                rows.append(AttendanceDayRecord(employee=emp, date=day, status="absent" if day in gone else "present"))
        AttendanceDayRecord.objects.bulk_create(rows)

    def punch_in(self, people, count, day=TODAY):
        AttendanceLog.objects.bulk_create(
            [
                AttendanceLog(employee=emp, date=day, punch_time=time(9, 0), punch_type="IN", source="biometric")
                for emp in people[:count]
            ]
        )

    def insights(self, **kw):
        with at(), read_only_db():
            return A.insights(today=TODAY, **kw)

    def spike_world(self):
        people = self.staff()
        absences = {i: [BASELINE_ABSENCES[i]] + ([d(14 + i)] if i < 6 else []) for i in range(10)}
        self.records(people, absences)
        self.punch_in(people, 10)
        return people


class InsightTests(InsightsBase):
    def test_a_department_far_above_its_own_normal(self):
        self.spike_world()
        items = self.insights()
        self.assertEqual([i["id"] for i in items], ["attendance.dept-spike"])
        item = items[0]
        # last 7 days: 6 absences in 60 scheduled days = 10 %. The 90 days before: 10 in 770 = 1.3 %, so 7.7 times
        self.assertEqual(item["title"], "Sewing absenteeism is 10%, 7.7× its 90-day average (1.3%)")
        self.assertEqual(item["detail"], "6 unplanned absence days in the last 7 days across 10 employees.")
        self.assertEqual((item["severity"], item["metric"], item["page"]), ("critical", "10%", "attendance"))
        self.assertEqual(item["ask"], "Why is absenteeism high in Sewing over the last 7 days, and who is absent?")
        self.assertEqual(
            set(item), {"id", "severity", "title", "detail", "metric", "page", "ask"}
        )  # the Dashboard's shape

    def test_a_department_that_is_always_like_this_is_not_a_spike(self):
        people = self.staff()
        days = list(working_days(d(16, 6), d(13)))  # the 77 working days of the baseline
        absences = {i: days[i::17] for i in range(10)}  # 49 absences in 770 days: a normal 6.4 %
        for i in range(5):
            absences[i] = absences[i] + [
                d(14 + i)
            ]  # five more in the last week: 5 in 60 = 8.3 %, only 1.3 times its norm
        self.records(people, absences)
        self.punch_in(people, 10)
        self.assertEqual(self.insights(), [])  # a 1.5 times rise is needed, however high the rate already is

    def test_a_small_department_or_a_small_rise_is_not_a_spike(self):
        people = self.staff(count=7)  # under the 8 people a department needs for the rate to mean anything
        self.records(people, {i: [d(14 + i)] for i in range(6)})
        self.punch_in(people, 7)
        self.assertEqual(self.insights(), [])

    def test_a_rise_that_is_still_below_the_floor_is_not_a_spike(self):
        people = self.staff()
        self.records(people, {0: [d(14)], 1: [d(15)], 2: [d(16)], 3: [d(17)]})  # 4 absence days: under the 5 required
        self.punch_in(people, 10)
        self.assertEqual(self.insights(), [])

    def test_a_unit_under_85_percent_so_far_today(self):
        people = self.staff()
        self.records(people)
        self.punch_in(people, 5)  # five of ten in
        items = self.insights()
        self.assertEqual([i["id"] for i in items], ["attendance.unit-low-today"])
        self.assertEqual(items[0]["title"], "Unit A is at 50% attendance so far today")
        self.assertEqual(
            items[0]["detail"],
            "5 of 10 scheduled people have punched in; 5 are not in yet (provisional: the day is still running).",
        )
        self.assertEqual((items[0]["severity"], items[0]["metric"]), ("warning", "50%"))

    def test_not_before_the_morning_rush_is_over(self):
        people = self.staff()
        self.records(people)
        self.punch_in(people, 5)
        with at(TODAY, hour=9), read_only_db():
            self.assertEqual(A.insights(), [])  # nine o'clock: people are still arriving
        with at(TODAY, hour=12), read_only_db():
            self.assertEqual([i["id"] for i in A.insights()], ["attendance.unit-low-today"])

    def test_a_small_unit_is_not_judged_on_one_morning(self):
        people = self.staff(count=6)
        self.records(people)
        self.assertEqual(self.insights(), [])  # nobody has punched, but six people are too few

    def test_people_still_absent_after_three_days_in_a_row(self):
        people = self.staff()
        self.records(people, {0: [d(17), d(18), d(19)]})  # Thu-Sat; the Sunday is a weekly off
        self.punch_in(people, 10)
        items = self.insights()
        self.assertEqual(
            [(i["id"], i["severity"]) for i in items],
            [("attendance.long-absence", "warning"), ("attendance.chronic-absentees", "info")],
        )
        self.assertEqual(items[0]["title"], "1 employee has been absent 3+ days in a row and is still out")
        self.assertEqual(items[0]["metric"], "1")
        self.assertEqual(items[1]["title"], "1 employee was absent on 3+ unplanned days in the last 30 days")

    def test_a_week_and_more_of_absence_is_critical(self):
        people = self.staff()
        gone = [
            d(10),
            d(11),
            d(12),
            d(14),
            d(15),
            d(16),
            d(17),
            d(18),
            d(19),
        ]  # Thu 10 .. Sat 19 Sep, bridging a Sunday
        self.records(people, {0: gone})
        self.punch_in(people, 10)
        item = next(i for i in self.insights() if i["id"] == "attendance.long-absence")
        self.assertEqual(item["severity"], "critical")  # nine days, and still out

    def test_an_absence_that_has_ended_is_not_a_finding_for_the_dashboard(self):
        people = self.staff()
        self.records(
            people, {0: [d(10), d(11), d(12)]}
        )  # back at work since: the Dashboard only shows runs still going
        self.punch_in(people, 10)
        self.assertEqual([i["id"] for i in self.insights()], ["attendance.chronic-absentees"])

    def test_records_missing_for_a_large_share_of_days(self):
        people = self.staff()
        self.records(people)
        self.punch_in(people, 10)
        AttendanceDayRecord.objects.filter(employee__in=people[:3], date__gte=d(22, 8)).delete()  # 3 x 25 days of 250
        items = self.insights()
        self.assertEqual([i["id"] for i in items], ["attendance.coverage-gap"])
        self.assertEqual(
            items[0]["title"], "Attendance records are missing for 30% of scheduled days in the last 30 days"
        )
        self.assertEqual(items[0]["severity"], "warning")  # under 75 %
        self.assertEqual(items[0]["metric"], "70.0%")
        self.assertIn("175 of 250 employee-days", items[0]["detail"])

    def test_good_news_when_attendance_clearly_improved(self):
        people = self.staff()
        before = [
            d(23, 7),
            d(24, 7),
            d(25, 7),
            d(27, 7),
            d(28, 7),
            d(29, 7),
            d(30, 7),
            d(31, 7),
            d(1, 8),
            d(3, 8),
            d(4, 8),
            d(5, 8),
            d(6, 8),
        ]
        # 13 absences in the 260 scheduled days of the 30 days before = 95 %; the last 30 days: nobody absent = 100 %
        self.records(
            people,
            {
                0: before[:3],
                1: before[3:6],
                2: before[6:9],
                3: before[9:10],
                4: before[10:11],
                5: before[11:12],
                6: before[12:13],
            },
        )
        self.punch_in(people, 10)
        items = self.insights()
        self.assertEqual([i["id"] for i in items], ["attendance.improved"])
        self.assertEqual(items[0]["title"], "Attendance rose 5 points to 100%")
        self.assertEqual((items[0]["severity"], items[0]["detail"]), ("good", "Against 95% in the previous 30 days."))

    def test_most_severe_first_and_at_most_five(self):
        people = self.spike_world()
        AttendanceDayRecord.objects.filter(employee=people[6], date__gte=d(10), date__lte=d(19)).exclude(
            date=d(13)
        ).update(status="absent")
        items = self.insights()
        ranks = [{"critical": 0, "warning": 1, "info": 2, "good": 3}[i["severity"]] for i in items]
        self.assertEqual(ranks, sorted(ranks))
        self.assertEqual(items[0]["severity"], "critical")
        with mock.patch.object(A, "INSIGHT_LIMIT", 1):
            self.assertEqual(len(self.insights()), 1)
        self.assertLessEqual(len(items), 5)

    def test_no_people_no_insights(self):
        self.assertEqual(self.insights(), [])

    def test_the_numbers_are_the_pages_own(self):
        """The Dashboard's 'chronic absentees' is the page's list for the same 30 days."""
        people = self.staff()
        self.records(people, {0: [d(17), d(18), d(19)], 1: [d(1), d(2), d(3)]})
        self.punch_in(people, 10)
        item = next(i for i in self.insights() if i["id"] == "attendance.chronic-absentees")
        with at():
            page = self.get(f"{BASE}/exceptions", **{"from": "2026-08-22", "to": "2026-09-20"}).json()
        self.assertEqual(item["metric"], str(page["chronicAbsentees"]["total"]))


class HeadlineTests(World):
    """World rows run 31 Aug - 13 Sep. Today is Tuesday 29 Sep, so the 30 days are 31 Aug - 28 Sep and the 29 days before
    them are 2 - 30 Aug, where only E5 has records (all present, Mon-Sat, four weeks)."""

    def setUp(self):
        super().setUp()
        for start in (3, 10, 17, 24):
            mark(self.e5, d(start, 8), "PPPPPPO")

    def headline(self, today=d(29)):
        with at(today), read_only_db():
            return A.headline(today=today)

    def test_the_three_cards(self):
        for emp in (self.e1, self.e2, self.e3):
            AttendanceLog.objects.create(employee=emp, date=d(29), punch_time=time(9, 0), punch_type="IN", source="x")
        h = self.headline()
        self.assertEqual([k["id"] for k in h["kpis"]], ["attendance-today", "absenteeism-30d", "late-30d"])
        today, absent, late = h["kpis"]
        self.assertEqual(
            (today["label"], today["value"], today["format"], today["page"]),
            ("Attendance today", 60.0, "pct", "attendance"),
        )
        self.assertEqual(today["sub"], "3 of 5 in so far · provisional, the day is running")
        self.assertIsNone(today["delta"])  # a half-finished day is not compared with anything
        # 31 Aug - 28 Sep: 7 absences in 53 scheduled days = 13.2 %; 4 late days in 45 worked = 8.9 %
        self.assertEqual(
            (absent["value"], absent["format"], absent["delta"]),
            (13.2, "pct", {"abs": 13.2, "pct": None, "good": "down"}),
        )
        self.assertEqual((late["value"], late["delta"]), (8.9, {"abs": 8.9, "pct": None, "good": "down"}))
        self.assertEqual(absent["sub"], "0% in the previous 30 days")
        self.assertEqual(absent["spark"][:5], [0.0, 20.0, 20.0, 0.0, 0.0])  # 31 Aug .. 5 Sep: 4 Sep is a holiday
        self.assertGreater(len(today["spark"]), 5)

    def test_it_follows_the_contract_the_dashboard_reads(self):
        h = self.headline()
        self.assertEqual(set(h), {"kpis", "provenance"})
        for kpi in h["kpis"]:
            self.assertEqual(set(kpi), {"id", "label", "value", "format", "sub", "delta", "spark", "page"})
            self.assertIn(kpi["format"], ("number", "pct", "inr_compact", "minutes", "text"))
        self.assertEqual({p["id"] for p in h["provenance"]}, {"live-today", "absenteeism-pct", "late-pct"})

    def test_a_weekly_off_says_so_instead_of_a_zero(self):
        h = self.headline(today=d(27))  # a Sunday
        self.assertIsNone(h["kpis"][0]["value"])
        self.assertEqual(h["kpis"][0]["sub"], "Weekly off or holiday today")

    def test_an_empty_database_has_empty_cards(self):
        Employee.objects.all().delete()
        h = self.headline()
        self.assertEqual([k["value"] for k in h["kpis"]], [None, None, None])
        self.assertTrue(all(k["delta"] is None for k in h["kpis"]))


# ─── more edges ──────────────────────────────────────────────────────────────────────────────────────────────────


class MoreEdgeTests(World):
    def test_a_month_still_running_covers_the_days_that_are_over(self):
        s = self.summary({"month": "2026-09"})
        self.assertEqual((s["period"]["label"], s["period"]["end"]), ("Sep 2026", "2026-09-30"))
        self.assertEqual(s["measured"], {"start": "2026-09-01", "end": "2026-09-20", "days": 20})  # today is the 21st
        self.assertIsNotNone(s["live"])  # the month includes today
        m = s["metrics"]
        # 1-6 Sep (a week with a holiday, 4 Sep) and 7-13 Sep: scheduled 19 + 29 = 48, present 16 + 21 = 37, half 1 + 2,
        # absent 2 + 5; 14-19 Sep have no records, so coverage is 48 of 77
        self.assertEqual((m["scheduledDays"]["value"], m["attendancePct"]["value"]), (77, 80.2))  # (37 + 1.5) / 48
        self.assertEqual(m["absenteeismPct"]["value"], 14.6)  # 7 / 48
        self.assertEqual(m["coveragePct"]["value"], 62.3)  # 48 / 77

    def test_a_period_too_long_to_compare_has_no_previous_leave_or_overtime(self):
        long_period = {"from": "2026-01-01", "to": "2026-09-13"}
        with at():
            leave = self.get(f"{BASE}/leave", **long_period).json()
            overtime = self.get(f"{BASE}/overtime", **long_period).json()
        self.assertIsNone(leave["previousDays"])
        self.assertIsNone(leave["delta"])
        self.assertIsNone(overtime["previousHours"])
        self.assertIsNone(overtime["delta"])

    def test_people_with_no_department_or_unit_have_a_row_of_their_own(self):
        stray = Employee.objects.create(
            employee_code="T099", first_name="Jaya", last_name="Nair", employment_type="staff", join_date="2025-01-01"
        )
        mark(stray, d(7), "PPPPPPO")
        with at():
            body = self.get(f"{BASE}/departments", **W).json()
        dept = next(r for r in body["departments"] if r["name"] == "Unassigned")
        unit = next(r for r in body["units"] if r["name"] == "No unit")
        self.assertEqual((dept["attendancePct"], dept["headcount"]), (100.0, 1))
        self.assertIsNone(unit["id"])  # there is no unit to narrow the page to

    def test_the_people_in_a_list_carry_who_to_talk_to(self):
        with at():
            row = self.get(f"{BASE}/exceptions", **W).json()["chronicAbsentees"]["rows"][0]
        self.assertTrue(set(row) >= {"employeeId", "name", "code", "department", "unit"})
        self.assertEqual((row["employeeId"], row["code"]), (self.e2.id, "T002"))


# ─── the explanation of today's live count ───────────────────────────────────────────────────────────────────────


class LiveProvenanceTests(World):
    def test_a_period_that_includes_today_explains_the_live_count(self):
        s = self.summary({"period": "last_7_days"})
        self.assertIn("live-today", {p["id"] for p in s["provenance"]})
        self.assertNotIn("live-today", {p["id"] for p in self.summary(W)["provenance"]})
        entry = next(p for p in s["provenance"] if p["id"] == "live-today")
        self.assertIn("Provisional", " ".join(entry["caveats"]))
        self.assertIn("Punches before 05:00", " ".join(entry["caveats"]))

    def test_a_period_that_is_only_today_still_explains_it(self):
        s = self.summary({"period": "today"})
        self.assertEqual([p["id"] for p in s["provenance"]], ["live-today"])


# ─── the frame is built once for the nine requests of a page load ────────────────────────────────────────────────


class FrameCacheTests(MdApiTestCase):
    """A page load asks for nine endpoints with the same period and scope at the same moment. They must share one
    frame (one read and one judging of the day records), not build nine."""

    def setUp(self):
        super().setUp()
        A._FRAMES.clear()
        self.addCleanup(A._FRAMES.clear)

    def build(self, calls, delay=0.0):
        def fake(scope, start, end, today):
            calls.append((start, end))
            timer.sleep(delay)
            return object()

        return mock.patch.object(A, "_build_frame", side_effect=fake)

    def test_the_same_window_is_built_once_and_served_from_the_cache(self):
        calls: list = []
        scope = A.Scope()
        with self.settings(MD_ANALYTICS_CACHE_SECONDS=60), self.build(calls):
            first = A.get_frame(scope, d(1), d(7), TODAY)
            second = A.get_frame(scope, d(1), d(7), TODAY)
            self.assertIs(first, second)
            self.assertEqual(len(calls), 1)
            A.get_frame(scope, d(1), d(8), TODAY)  # another window
            A.get_frame(A.Scope(employment_type="staff"), d(1), d(7), TODAY)  # another scope
            A.get_frame(scope, d(1), d(7), TODAY + timedelta(days=1))  # another day: yesterday's frame is stale
            self.assertEqual(len(calls), 4)

    def test_nine_requests_at_once_build_it_once(self):
        calls: list = []
        results: list = []
        scope = A.Scope()
        with self.settings(MD_ANALYTICS_CACHE_SECONDS=60), self.build(calls, delay=0.15):
            threads = [
                threading.Thread(target=lambda: results.append(A.get_frame(scope, d(1), d(7), TODAY))) for _ in range(9)
            ]
            for t in threads:
                t.start()
            for t in threads:
                t.join()
        self.assertEqual(len(calls), 1)
        self.assertEqual(len(results), 9)
        self.assertEqual(len({id(r) for r in results}), 1)

    def test_nothing_is_cached_when_the_cache_is_off(self):
        calls: list = []
        with self.settings(MD_ANALYTICS_CACHE_SECONDS=0), self.build(calls):
            A.get_frame(A.Scope(), d(1), d(7), TODAY)
            A.get_frame(A.Scope(), d(1), d(7), TODAY)
        self.assertEqual(len(calls), 2)


# ─── the queries do not grow with the data ───────────────────────────────────────────────────────────────────────


class Population:
    """Builds a company of ``staff`` + ``production`` people over 14 days (Mon 31 Aug .. Sun 13 Sep), every kind of fact
    the endpoints read: absences, half days, late arrivals with a first punch, leave, overtime, missing punches,
    permissions, casual leave, shifts (a third with Saturday off) and punches today."""

    def __init__(self, prefix: str, staff: int, production: int, dept_count: int = 2):
        self.unit = Branch.objects.get_or_create(code="QU", defaults={"name": "Unit Q"})[0]
        self.depts = [
            Department.objects.get_or_create(name=f"Dept {i}", branch=self.unit)[0] for i in range(dept_count)
        ]
        self.shift = ShiftTemplate.objects.get_or_create(
            name="Q General",
            defaults=dict(
                shift_type="staff",
                start_time=time(9),
                end_time=time(18),
                grace_period_minutes=15,
                first_half_end=time(13, 30),
                lunch_duration_minutes=60,
            ),
        )[0]
        kinds = [("staff", i) for i in range(staff)] + [("production", i) for i in range(production)]
        Employee.objects.bulk_create(
            [
                Employee(
                    employee_code=f"{prefix}{kind[:1].upper()}{i:04d}",
                    first_name=f"{prefix}{kind[:1]}{i}",
                    last_name="Test",
                    department=self.depts[(i + n) % dept_count],
                    branch=self.unit,
                    employment_type=kind,
                    join_date="2025-01-01",
                )
                for n, (kind, i) in enumerate(kinds)
            ]
        )
        self.people = list(Employee.objects.filter(employee_code__startswith=prefix).order_by("employee_code"))
        self.staff = [e for e in self.people if e.employment_type == "staff"]

    def fill(self, start: date, end: date, today_punches: int = 0):
        EmployeeShiftAssignment.objects.bulk_create(
            [
                EmployeeShiftAssignment(
                    employee=e, shift=self.shift, effective_from=date(2026, 1, 1), saturday_off=(i % 3 == 0)
                )
                for i, e in enumerate(self.staff)
            ]
        )
        rows = []
        for n, emp in enumerate(self.people):
            for k, day in enumerate(working_days(start, end)):
                step = (n + k) % 11
                status = {0: "absent", 1: "half_shift", 2: "on_leave"}.get(step, "present")
                rows.append(
                    AttendanceDayRecord(
                        employee=emp,
                        date=day,
                        status=status,
                        is_late=step in (3, 4),
                        first_punch=time(9, 40) if step in (3, 4) else None,
                    )
                )
        AttendanceDayRecord.objects.bulk_create(rows, batch_size=2000)
        OvertimeRecord.objects.bulk_create(
            [
                OvertimeRecord(
                    employee=e,
                    date=d(9),
                    last_punch_out=time(20),
                    ot_minutes=90,
                    status="announced",
                    compensation_type="pay",
                )
                for i, e in enumerate(self.staff)
                if i % 3 == 1
            ]
        )
        MissingPunchRequest.objects.bulk_create(
            [
                MissingPunchRequest(
                    employee=e, date=d(8), punch_time=time(9), punch_type="IN", reason="x", status="pending_hod"
                )
                for i, e in enumerate(self.people)
                if i % 4 == 0
            ]
        )
        EmployeePermission.objects.bulk_create(
            [
                EmployeePermission(
                    employee=e, date=d(9), type="morning_late_in", status="approved" if i % 2 else "pending"
                )
                for i, e in enumerate(self.people)
                if i % 5 == 0
            ]
        )
        casual = LeaveType.objects.get(code="CL")
        LeaveRequest.objects.bulk_create(
            [
                LeaveRequest(
                    employee=e,
                    leave_type_ref=casual,
                    type="casual",
                    start_date="2026-09-08",
                    end_date="2026-09-09",
                    total_days=2,
                    status="approved" if i % 2 else "pending",
                )
                for i, e in enumerate(self.staff)
                if i % 6 == 0
            ]
        )
        CasualLeaveRequest.objects.bulk_create(
            [
                CasualLeaveRequest(employee=e, date=d(10), status="approved")
                for i, e in enumerate(self.staff)
                if i % 7 == 0
            ]
        )
        AttendanceLog.objects.bulk_create(
            [
                AttendanceLog(employee=e, date=TODAY, punch_time=time(9, 1), punch_type="IN", source="biometric")
                for e in self.people[:today_punches]
            ]
        )


class QueryCountTests(MdApiTestCase):
    """Every endpoint reads the database a fixed number of times, however many people and days there are."""

    ENDPOINTS = ROUTES
    CEILING = 45

    def count(self, route, **params):
        with at(), CaptureQueriesContext(connection) as ctx:
            r = self.get(f"{BASE}/{route}", **params)
        self.assertEqual(r.status_code, 200, r.content)
        return len(ctx)

    def counts(self, **extra):
        out = {}
        for route in self.ENDPOINTS:
            out[route] = self.count(route, **W, **extra) if route != "day" else self.count(route, date="2026-09-09")
        out["day (today)"] = self.count("day", date="today")
        out["summary (this week)"] = self.count("summary", period="last_7_days")
        return out

    def test_the_number_of_queries_does_not_depend_on_the_number_of_people(self):
        small = Population("a", staff=6, production=3)
        small.fill(d(31, 8), d(13), today_punches=4)
        before = self.counts()
        large = Population("b", staff=60, production=30, dept_count=4)
        large.fill(d(31, 8), d(13), today_punches=40)
        after = self.counts()
        self.assertEqual(before, after, "a query count that grows with the data is a query in a loop")
        for route, n in after.items():
            self.assertLessEqual(n, self.CEILING, route)

    def test_nor_on_the_length_of_the_period(self):
        people = Population("c", staff=12, production=4)
        people.fill(d(1, 6), d(13))  # a hundred days
        short = self.count("exceptions", **{"from": "2026-09-07", "to": "2026-09-13"})
        long = self.count("exceptions", **{"from": "2026-06-01", "to": "2026-09-13"})
        self.assertEqual(short, long)
        self.assertEqual(
            self.count("departments", **{"from": "2026-09-07", "to": "2026-09-13"}),
            self.count("departments", **{"from": "2026-06-01", "to": "2026-09-13"}),
        )


class PerformanceTests(MdApiTestCase):
    """250 employees x 120 days: the brief's target is under 1.5 seconds an endpoint. The ceiling here is looser (a test
    machine is slower than a server) and exists to catch an accidental quadratic loop, not to benchmark."""

    CEILING_SECONDS = 4.0
    LONG = {"from": "2026-05-17", "to": "2026-09-13"}  # 120 days

    @classmethod
    def setUpTestData(cls):
        cls.population = Population("p", staff=215, production=35, dept_count=10)
        cls.population.fill(d(17, 5), d(13), today_punches=200)

    def timed(self, route, **params):
        started = timer.perf_counter()
        with at():
            r = self.get(f"{BASE}/{route}", **params)
        elapsed = timer.perf_counter() - started
        self.assertEqual(r.status_code, 200, r.content)
        self.assertLess(elapsed, self.CEILING_SECONDS, f"{route} took {elapsed:.2f}s")
        return elapsed

    def test_every_endpoint_on_250_people_and_120_days(self):
        self.assertEqual(len(self.population.people), 250)
        self.assertGreater(AttendanceDayRecord.objects.count(), 24_000)
        timings = {route: self.timed(route, **self.LONG, limit=25) for route in ROUTES if route != "day"}
        timings["day"] = self.timed("day", date="2026-09-09")
        timings["day (today)"] = self.timed("day", date="today")
        print(
            "\n  attendance endpoints, 250 people x 120 days (seconds): "
            + ", ".join(f"{k} {v:.2f}" for k, v in timings.items())
        )

    def test_the_dashboard_exports_are_fast_too(self):
        started = timer.perf_counter()
        with at(), read_only_db():
            A.insights(today=TODAY)
            insights_seconds = timer.perf_counter() - started
            A.headline(today=TODAY)
        self.assertLess(insights_seconds, self.CEILING_SECONDS)
        self.assertLess(timer.perf_counter() - started, 2 * self.CEILING_SECONDS)


# ─── END OF TESTS (batches are added above this line) ────────────────────────────────────────────────────────────

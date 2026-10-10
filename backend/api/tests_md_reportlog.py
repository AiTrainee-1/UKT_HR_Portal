"""MD portal, Report Log: every figure recomputed by hand from a small company.

Run:  DB_TEST_NAME=test_uktex_reportlog python manage.py test api.tests_md_reportlog --noinput

What "Report Log" means here: HR's Daily Report lists the people who were absent on a day and HR marks each one
Informed or Not informed (AttendanceDayRecord.is_informed True / False; NULL = not yet marked). The report itself is
exported in the browser, so the only record of reports being produced is the audit trail's Report Center exports.

THE WORLD (September 2026; today is Monday 21 Sep; Monday 7 Sep and Monday 31 Aug start the two weeks measured)

    Unit A   Stitching: E1 Asha, E2 Bala (staff), E4 Dev (production)     Cutting: E3 Chitra (staff, Saturday off)
    Head Office  Accounts: E5 Esha (staff)         Holiday: Friday 4 Sep.  Staff work Mon-Sat (E3 Mon-Fri); production
    works every day but Sunday and holidays.

    Week W = Mon 7 .. Sun 13 Sep      one letter per day, Mon..Sun  (P present, A absent not marked, a absent Informed,
        E1  P P a A n P O                                             n absent Not informed, O holiday / weekly off)
        E2  P A A A P P O      (the Saturday "A" of E3 is a Saturday off and the Sunday "A" of E4 a production Sunday:
        E3  n P P P P A O       neither is an absence)
        E4  P A P a P P A
        E5  P P P P P P O
      absences 9: E1 3 (Informed, not marked, Not informed), E2 3 (not marked), E3 1 (Not informed), E4 2 (not marked,
      Informed) -> Informed 2, Not informed 2, not marked 5; followed up 4 / 9 = 44.4 %.
      By day: Mon 1 | Tue 2 (both not marked: a GAP DAY) | Wed 2 (1 marked) | Thu 3 (1 marked) | Fri 1 | Sat 0 | Sun 0.

    Week P = Mon 31 Aug .. Sun 6 Sep (the previous period; Friday 4 Sep is the holiday)
        E1  P a n P O P O      E2  A P P P O P O      E3  P P P P O A O      E4  P P P P O P A      E5  P P P P O P O
      absences 3: Informed 1 (E1 Tue), Not informed 1 (E1 Wed), not marked 1 (E2 Mon) -> followed up 2 / 3 = 66.7 %.

AUDIT TRAIL (action "export"; times are Indian time). Attendance reports = Report Center exports of the Attendance
group + Attendance Search punch exports.
    In W:  x1 Ravi Mon 7 00:00:00 (the first instant) Late Coming Summary    x2 Priya Tue 8 10:15 Daily Attendance Register
           x3 Priya Wed 9 10:20 Daily Attendance Register   x4 Ravi Wed 9 15:00 Late Coming Summary
           x5 Priya Thu 10 11:00 punch export (Attendance Search)   x6 Priya Fri 11 a PAYROLL report (not attendance)
           x7 Ravi Sat 12 a bonus register export (not attendance)  x8 Priya Sun 13 23:50 Daily Attendance Register
      attendance 6 (Priya 4, Ravi 2), on 5 days (7, 8, 9, 10, 13); all exports 8.
    Outside: x9 Ravi Mon 14 00:10 (the next day; 13 Sep in UTC), an "update" audit row on Tue 8 (not an export),
    p5 Ravi Sun 30 Aug 23:59:59 (one second before the previous period).
    In P:  p4 Priya Mon 31 Aug 00:00:00, p1 Priya Tue 1, p2 Priya Wed 2, p3 Ravi Thu 3 -> attendance 4 (Priya 3,
           Ravi 1) on 4 days; all exports 4.
"""

import json
from datetime import date, datetime, timedelta
from datetime import time as dtime
from unittest import mock

from django.db import connection
from django.test import SimpleTestCase, TestCase
from django.test.utils import CaptureQueriesContext

from .clock import FACTORY_TZ
from .jwt_utils import sign_token
from .md_portal.analytics import reportlog as rl
from .md_portal.assistant import registry
from .md_portal.common import MdParamError, Scope, read_only_db, resolve_period
from .models import (
    AttendanceDayRecord,
    AuditLog,
    Branch,
    Department,
    Employee,
    EmployeeShiftAssignment,
    Holiday,
    HRUser,
    Role,
    ShiftTemplate,
)
from .reporting.registry import all_specs
from .tests_md_support import MdApiTestCase, make_md, md_headers

TODAY = date(2026, 9, 21)
W = {"from": "2026-09-07", "to": "2026-09-13"}  # the week measured
P = {"from": "2026-08-31", "to": "2026-09-06"}  # the week before it
BASE = "/api/md/reportlog"
ROUTES = ["summary", "briefing", "trend", "gaps", "departments", "exports", "attention"]

STATUS = {
    "P": ("present", None),
    "A": ("absent", None),
    "a": ("absent", True),
    "n": ("absent", False),
    "O": ("holiday", None),
}

ATTENDANCE_1 = "Daily Attendance Register"
ATTENDANCE_2 = "Late Coming Summary (Counts)"


def spec_title(category: str) -> str:
    return next(s.title for s in all_specs() if s.category == category)


def ist(month, day, hh=0, mm=0, ss=0, year=2026):
    return datetime(year, month, day, hh, mm, ss, tzinfo=FACTORY_TZ)


def d(day: int, month: int = 9) -> date:
    return date(2026, month, day)


def frozen(test):
    patcher = mock.patch.object(rl, "ist_today", return_value=TODAY)
    patcher.start()
    test.addCleanup(patcher.stop)


def mark(emp: Employee, start: date, codes: str) -> None:
    rows = []
    for i, ch in enumerate(codes):
        status, informed = STATUS[ch]
        rows.append(
            AttendanceDayRecord(employee=emp, date=start + timedelta(days=i), status=status, is_informed=informed)
        )
    AttendanceDayRecord.objects.bulk_create(rows)


def audit(when: datetime, who: str, module: str, description: str, action: str = "export") -> AuditLog:
    row = AuditLog.objects.create(
        user_type="hr", user_name=who, action=action, module=module, record_description=description
    )
    AuditLog.objects.filter(pk=row.pk).update(created_at=when)
    return row


def report_export(when: datetime, who: str, title: str, rows: int = 120) -> AuditLog:
    """What the Report Center writes (reporting/views.py reports_export)."""
    return audit(
        when,
        who,
        "reports",
        f"{title} - XLSX - {rows} rows - Month: 2026-09",
    )


def make_employee(code, first, dept, branch, kind="staff", **kw) -> Employee:
    return Employee.objects.create(
        employee_code=code,
        first_name=first,
        last_name="Test",
        department=dept,
        branch=branch,
        employment_type=kind,
        join_date="2025-01-01",
        **kw,
    )


def build_world(cls):
    cls.unit_a = Branch.objects.create(name="Unit A", code="RA")
    cls.head_office = Branch.objects.get(code="HO")  # a migration seeds the Head Office branch in every database
    cls.stitching = Department.objects.create(name="Stitching", branch=cls.unit_a)
    cls.cutting = Department.objects.create(name="Cutting", branch=cls.unit_a)
    cls.accounts = Department.objects.create(name="Accounts", branch=cls.head_office)
    cls.shift = ShiftTemplate.objects.create(
        name="General",
        shift_type="staff",
        start_time=dtime(9),
        end_time=dtime(18),
        grace_period_minutes=15,
        first_half_end=dtime(13, 30),
        lunch_duration_minutes=60,
    )
    cls.e1 = make_employee("T001", "Asha", cls.stitching, cls.unit_a)
    cls.e2 = make_employee("T002", "Bala", cls.stitching, cls.unit_a)
    cls.e3 = make_employee("T003", "Chitra", cls.cutting, cls.unit_a)
    cls.e4 = make_employee("T004", "Dev", cls.stitching, cls.unit_a, "production")
    cls.e5 = make_employee("T005", "Esha", cls.accounts, cls.head_office)
    for emp in (cls.e1, cls.e2, cls.e3, cls.e5):
        EmployeeShiftAssignment.objects.create(
            employee=emp, shift=cls.shift, effective_from=date(2026, 1, 1), saturday_off=(emp is cls.e3)
        )
    Holiday.objects.create(name="Test Holiday", date=d(4))
    mark(cls.e1, d(7), "PPaAnPO")
    mark(cls.e2, d(7), "PAAAPPO")
    mark(cls.e3, d(7), "nPPPPAO")
    mark(cls.e4, d(7), "PAPaPPA")
    mark(cls.e5, d(7), "PPPPPPO")
    mark(cls.e1, d(31, 8), "PanPOPO")
    mark(cls.e2, d(31, 8), "APPPOPO")
    mark(cls.e3, d(31, 8), "PPPPOAO")
    mark(cls.e4, d(31, 8), "PPPPOPA")
    mark(cls.e5, d(31, 8), "PPPPOPO")

    cls.payroll_title = spec_title("payroll")
    t1, t2 = ATTENDANCE_1, ATTENDANCE_2
    report_export(ist(9, 7, 0, 0, 0), "Ravi", t2)  # x1
    report_export(ist(9, 8, 10, 15), "Priya", t1)  # x2
    report_export(ist(9, 9, 10, 20), "Priya", t1)  # x3
    report_export(ist(9, 9, 15, 0), "Ravi", t2)  # x4
    audit(ist(9, 10, 11, 0), "Priya", "attendance", "Exported 800 punches")  # x5
    report_export(ist(9, 11, 10, 30), "Priya", cls.payroll_title)  # x6
    audit(ist(9, 12, 9, 0), "Ravi", "bonus", "Exported bonus register for FY 2026 (40 record(s))")  # x7
    report_export(ist(9, 13, 23, 50), "Priya", t1)  # x8
    report_export(ist(9, 14, 0, 10), "Ravi", t1)  # x9
    audit(ist(9, 8, 12, 0), "Priya", "reports", f"{t1} - XLSX - 3 rows", action="update")  # not an export
    report_export(ist(8, 30, 23, 59, 59), "Ravi", t2)  # p5
    report_export(ist(8, 31, 0, 0, 0), "Priya", t1)  # p4
    report_export(ist(9, 1, 10, 0), "Priya", t1)  # p1
    report_export(ist(9, 2, 10, 0), "Priya", t1)  # p2
    report_export(ist(9, 3, 10, 5), "Ravi", t2)  # p3


class World(MdApiTestCase):
    @classmethod
    def setUpTestData(cls):
        build_world(cls)

    def setUp(self):
        super().setUp()
        frozen(self)

    def api(self, name, params=W, **extra):
        r = self.get(f"{BASE}/{name}", **params, **extra)
        self.assertEqual(r.status_code, 200, r.content)
        return r.json()

    def metrics(self, params=W, **extra):
        return self.api("summary", params, **extra)["metrics"]


def values(metrics, *keys):
    return tuple((metrics[k]["value"], metrics[k]["previous"]) for k in keys)


# ═════════════════════════════════════════════════════════════════════════════════════════════════════════════════
# summary
# ═════════════════════════════════════════════════════════════════════════════════════════════════════════════════


class SummaryTests(World):
    def test_the_week_in_numbers(self):
        s = self.api("summary")
        m = s["metrics"]
        self.assertEqual(s["measured"], {"start": "2026-09-07", "end": "2026-09-13", "days": 7})
        self.assertEqual(s["previous"], {"start": "2026-08-31", "end": "2026-09-06", "days": 7})
        self.assertEqual(values(m, "absences", "informed", "notInformed", "unmarked"), ((9, 3), (2, 1), (2, 1), (5, 1)))
        self.assertEqual(values(m, "reviewedPct", "notInformedPct"), ((44.4, 66.7), (22.2, 33.3)))
        self.assertEqual(s["gapDays"], 1)

    def test_a_saturday_off_and_a_production_sunday_are_not_absences(self):
        # E3's Saturday and E4's Sunday are stored as "absent" by the engine; the Report Center's rule leaves them out
        self.assertEqual(self.metrics()["absences"]["value"], 9)
        self.assertEqual(self.metrics(branch="Unit A", department="Cutting")["absences"]["value"], 1)  # Monday only

    def test_changes_against_the_previous_period(self):
        m = self.metrics()
        self.assertEqual(m["absences"]["change"], {"abs": 6, "pct": 200.0})
        self.assertEqual(m["unmarked"]["change"], {"abs": 4, "pct": 400.0})
        self.assertEqual(m["reviewedPct"]["change"]["abs"], -22.3)  # percentage figures change in points

    def test_the_exports_on_record(self):
        s = self.api("summary")
        m = s["metrics"]
        self.assertEqual(
            values(m, "exports", "exportsAll", "exporters", "exportDays"), ((6, 4), (8, 4), (2, 2), (5, 4))
        )
        self.assertEqual(m["exports"]["change"], {"abs": 2, "pct": 50.0})
        self.assertEqual(
            s["latestExport"],
            {"at": "2026-09-13T23:50:00", "userName": "Priya", "report": ATTENDANCE_1},
        )

    def test_the_previous_period_is_the_same_length_just_before(self):
        s = self.api("summary")
        self.assertEqual((s["previousPeriod"]["start"], s["previousPeriod"]["end"]), ("2026-08-31", "2026-09-06"))
        self.assertEqual(s["period"]["days"], 7)

    def test_the_provenance_explains_every_figure(self):
        s = self.api("summary")
        ids = [p["id"] for p in s["provenance"]]
        self.assertEqual(
            ids,
            ["reportlog-absences", "reportlog-followup", "reportlog-gaps", "reportlog-exports", "reportlog-previous"],
        )
        rows = {p["id"]: p["rows"] for p in s["provenance"]}
        self.assertEqual((rows["reportlog-absences"], rows["reportlog-exports"]), (9, 6))
        text = json.dumps(s["provenance"])
        self.assertIn("NOT recorded", text)  # the Report Log page's own exports
        self.assertIn("whole company", text.lower())

    def test_what_the_data_cannot_tell_is_said(self):
        s = self.api("summary")
        self.assertEqual(len(s["unknowns"]), 5)
        joined = " ".join(s["unknowns"])
        for fragment in ("Report Log page itself", "sent", "late", "failed", "who made it"):
            self.assertIn(fragment, joined)

    def test_the_attendance_coverage_is_reported(self):
        cov = self.api("summary")["coverage"]
        self.assertEqual(cov["coveragePct"], 100.0)

    def test_a_period_that_includes_today_leaves_today_out(self):
        s = self.get(f"{BASE}/summary", **{"from": "2026-09-14", "to": "2026-09-21"}).json()
        self.assertEqual(s["measured"]["end"], "2026-09-20")
        self.assertIn("Today is still running", " ".join(s["notes"]))

    def test_a_period_with_no_completed_day_has_no_absence_figures(self):
        s = self.get(f"{BASE}/summary", **{"from": "2026-09-21", "to": "2026-09-21"}).json()
        self.assertIsNone(s["measured"])
        self.assertIsNone(s["metrics"]["absences"]["value"])
        self.assertIsNone(s["metrics"]["reviewedPct"]["value"])
        self.assertIn("no completed day yet", " ".join(s["notes"]))


# ═════════════════════════════════════════════════════════════════════════════════════════════════════════════════
# periods and scope
# ═════════════════════════════════════════════════════════════════════════════════════════════════════════════════


class PeriodEdgeTests(World):
    def exports(self, start, end):
        r = self.get(f"{BASE}/summary", **{"from": start, "to": end}).json()
        return r["metrics"]["exports"]["value"]

    def test_exports_belong_to_the_indian_day_at_both_ends(self):
        self.assertEqual(self.exports("2026-09-07", "2026-09-07"), 1)  # x1 at 00:00:00 IST (06-Sep in UTC)
        self.assertEqual(self.exports("2026-09-06", "2026-09-06"), 0)
        self.assertEqual(self.exports("2026-09-13", "2026-09-13"), 1)  # x8 at 23:50 IST
        self.assertEqual(self.exports("2026-09-14", "2026-09-14"), 1)  # x9 at 00:10 IST (13-Sep in UTC)
        self.assertEqual(self.exports("2026-08-30", "2026-08-30"), 1)  # p5, one second before the previous period
        self.assertEqual(self.exports("2026-08-31", "2026-08-31"), 1)  # p4, the first instant of 31-Aug

    def test_previous_period_edges(self):
        m = self.metrics()
        self.assertEqual(m["exports"]["previous"], 4)  # p5 is one second too early: it is in neither period

    def test_both_ends_of_the_absence_window_are_inclusive(self):
        one = lambda day: self.metrics({"from": day, "to": day})["absences"]["value"]  # noqa: E731
        self.assertEqual((one("2026-09-07"), one("2026-09-08"), one("2026-09-12"), one("2026-09-13")), (1, 2, 0, 0))

    def test_a_period_crossing_a_month_boundary(self):
        m = self.metrics({"from": "2026-08-31", "to": "2026-09-08"})
        self.assertEqual(m["absences"]["value"], 3 + 1 + 2)  # all of P, plus Mon 7 (1) and Tue 8 (2)

    def test_a_whole_month(self):
        r = self.get(f"{BASE}/summary", month="2026-09").json()
        self.assertEqual((r["period"]["start"], r["period"]["end"]), ("2026-09-01", "2026-09-30"))
        self.assertEqual(r["measured"]["end"], "2026-09-20")
        self.assertEqual(r["metrics"]["absences"]["value"], 2 + 9)  # Tue 1 and Wed 2 of P, then all of W


class ScopeTests(World):
    def figures(self, **scope):
        m = self.metrics(**scope)
        return (m["absences"]["value"], m["informed"]["value"], m["notInformed"]["value"], m["unmarked"]["value"])

    def test_everyone(self):
        self.assertEqual(self.figures(), (9, 2, 2, 5))

    def test_a_unit(self):
        self.assertEqual(self.figures(branch="Unit A"), (9, 2, 2, 5))
        self.assertEqual(self.figures(branch="Head Office"), (0, 0, 0, 0))

    def test_a_department(self):
        self.assertEqual(self.figures(department="Stitching"), (8, 2, 1, 5))
        self.assertEqual(self.figures(department="Cutting"), (1, 0, 1, 0))

    def test_staff_and_production(self):
        self.assertEqual(self.figures(type="staff"), (7, 1, 2, 4))
        self.assertEqual(self.figures(type="production"), (2, 1, 0, 1))

    def test_combined_filters(self):
        self.assertEqual(self.figures(branch="Unit A", department="Stitching", type="production"), (2, 1, 0, 1))

    def test_a_scope_with_nothing_has_no_rates(self):
        m = self.metrics(branch="Head Office")
        self.assertEqual(m["absences"]["value"], 0)
        self.assertIsNone(m["reviewedPct"]["value"])
        self.assertIsNone(m["notInformedPct"]["value"])

    def test_a_typo_is_matched_and_said(self):
        s = self.api("summary", department="Stiching")
        self.assertIn("Matched department 'Stiching' to 'Stitching'", " ".join(s["notes"]))
        self.assertEqual(s["metrics"]["absences"]["value"], 8)

    def test_exports_are_company_wide_whatever_the_scope_and_it_is_said(self):
        s = self.api("summary", department="Cutting")
        self.assertEqual(s["metrics"]["exports"]["value"], 6)
        self.assertIn("whole company", " ".join(s["notes"]))
        self.assertNotIn("whole company", " ".join(self.api("summary")["notes"]))

    def test_the_scope_applies_to_every_absence_endpoint(self):
        scope = {"department": "Cutting"}
        self.assertEqual(sum(p["absences"] for p in self.api("trend", **scope)["points"]), 1)
        self.assertEqual(self.api("gaps", **scope)["gapDayCount"], 0)
        self.assertEqual([r["label"] for r in self.api("departments", **scope)["rows"]], ["Cutting"])


# ═════════════════════════════════════════════════════════════════════════════════════════════════════════════════
# trend and the gap calendar
# ═════════════════════════════════════════════════════════════════════════════════════════════════════════════════


class TrendTests(World):
    def test_every_day_equals_the_hand_count(self):
        t = self.api("trend")
        self.assertEqual(t["granularity"], "day")
        got = [
            (p["date"][8:], p["absences"], p["informed"], p["notInformed"], p["unmarked"], p["exports"])
            for p in t["points"]
        ]
        self.assertEqual(
            got,
            [
                ("07", 1, 0, 1, 0, 1),
                ("08", 2, 0, 0, 2, 1),
                ("09", 2, 1, 0, 1, 2),
                ("10", 3, 1, 0, 2, 1),
                ("11", 1, 0, 1, 0, 0),  # x6 is a payroll report: not an attendance export
                ("12", 0, 0, 0, 0, 0),
                ("13", 0, 0, 0, 0, 1),
            ],
        )
        by_day = {p["date"]: p for p in t["points"]}
        self.assertEqual(by_day["2026-09-07"]["reviewedPct"], 100.0)
        self.assertEqual(by_day["2026-09-08"]["reviewedPct"], 0.0)
        self.assertEqual(by_day["2026-09-10"]["reviewedPct"], 33.3)
        self.assertIsNone(by_day["2026-09-12"]["reviewedPct"])  # no absences: no rate

    def test_the_days_add_up_to_the_summary(self):
        t = self.api("trend")
        m = self.metrics()
        self.assertEqual(sum(p["absences"] for p in t["points"]), m["absences"]["value"])
        self.assertEqual(sum(p["unmarked"] for p in t["points"]), m["unmarked"]["value"])
        self.assertEqual(sum(p["exports"] for p in t["points"]), m["exports"]["value"])

    def test_today_and_later_days_have_no_absence_figures(self):
        t = self.get(f"{BASE}/trend", **{"from": "2026-09-19", "to": "2026-09-22"}).json()
        by_day = {p["date"]: p for p in t["points"]}
        self.assertEqual(by_day["2026-09-20"]["absences"], 0)  # complete day, nobody absent
        self.assertIsNone(by_day["2026-09-21"]["absences"])  # today is still running
        self.assertIsNone(by_day["2026-09-22"]["absences"])

    def test_a_long_period_is_rolled_up_by_week(self):
        t = self.get(f"{BASE}/trend", **{"from": "2026-06-29", "to": "2026-09-13"}).json()  # 77 days
        self.assertEqual(t["granularity"], "week")
        self.assertEqual(t["points"][0]["date"], "2026-06-29")  # a Monday
        self.assertEqual(sum(p["days"] for p in t["points"]), 77)
        weeks = {p["date"]: p for p in t["points"]}
        self.assertEqual((weeks["2026-08-31"]["absences"], weeks["2026-08-31"]["exports"]), (3, 4))
        self.assertEqual((weeks["2026-09-07"]["absences"], weeks["2026-09-07"]["exports"]), (9, 6))
        self.assertEqual(weeks["2026-08-24"]["exports"], 1)  # p5, on Sunday 30 Aug

    def test_a_period_of_nothing_is_zeros_not_missing(self):
        t = self.get(f"{BASE}/trend", **{"from": "2026-07-01", "to": "2026-07-05"}).json()
        self.assertTrue(all(p["absences"] == 0 and p["exports"] == 0 for p in t["points"]))


class GapTests(World):
    def test_the_gap_calendar_equals_the_hand_count(self):
        g = self.api("gaps")
        got = [
            (x["date"][8:], x["weekday"], x["absences"], x["informed"], x["notInformed"], x["unmarked"], x["exports"])
            for x in g["days"]
        ]
        self.assertEqual(
            got,
            [
                ("07", "Mon", 1, 0, 1, 0, 1),
                ("08", "Tue", 2, 0, 0, 2, 1),
                ("09", "Wed", 2, 1, 0, 1, 2),
                ("10", "Thu", 3, 1, 0, 2, 1),
                ("11", "Fri", 1, 0, 1, 0, 0),
                ("12", "Sat", 0, 0, 0, 0, 0),
                ("13", "Sun", 0, 0, 0, 0, 1),
            ],
        )

    def test_the_days_nobody_made_the_call(self):
        g = self.api("gaps")
        self.assertEqual(g["gapDays"], [{"date": "2026-09-08", "weekday": "Tue", "absences": 2, "unmarked": 2}])
        self.assertEqual((g["gapDayCount"], g["minAbsences"]), (1, 2))
        self.assertEqual((g["daysWithAbsences"], g["daysFullyMarked"]), (5, 2))  # Mon 7 and Fri 11 are fully marked

    def test_one_absence_on_a_day_is_not_a_gap(self):
        # P: Mon 31 Aug has one unmarked absence only
        g = self.api("gaps", P)
        self.assertEqual(g["gapDayCount"], 0)

    def test_a_marked_day_stops_being_a_gap(self):
        AttendanceDayRecord.objects.filter(employee=self.e2, date=d(8)).update(is_informed=True)
        self.assertEqual(self.api("gaps")["gapDayCount"], 0)

    def test_the_calendar_shows_the_latest_days_only_when_the_period_is_long(self):
        g = self.get(f"{BASE}/gaps", **{"from": "2026-04-01", "to": "2026-09-13"}).json()
        self.assertEqual(len(g["days"]), rl.CALENDAR_MAX_DAYS)
        self.assertTrue(g["truncated"])
        self.assertEqual(g["days"][-1]["date"], "2026-09-13")
        self.assertIn(f"latest {rl.CALENDAR_MAX_DAYS} days", " ".join(g["notes"]))
        self.assertEqual(g["gapDayCount"], 1)  # the gap days are counted over the whole period


# ═════════════════════════════════════════════════════════════════════════════════════════════════════════════════
# follow-up by department, unit and type
# ═════════════════════════════════════════════════════════════════════════════════════════════════════════════════


def by_label(response):
    return {r["label"]: r for r in response["rows"]}


class BreakdownTests(World):
    def test_departments_ranked_by_absences_nobody_marked(self):
        r = self.api("departments")
        self.assertEqual([x["label"] for x in r["rows"]], ["Stitching", "Cutting"])
        s = by_label(r)["Stitching"]
        self.assertEqual((s["absences"], s["informed"], s["notInformed"], s["unmarked"]), (8, 2, 1, 5))
        self.assertEqual((s["reviewedPct"], s["unmarkedPct"], s["notInformedPct"]), (37.5, 62.5, 12.5))
        self.assertEqual(s["headcount"], 3)
        self.assertFalse(s["lowSample"])
        self.assertEqual(s["previous"], {"absences": 3, "reviewedPct": 66.7})
        self.assertEqual(s["change"]["absences"], {"abs": 5, "pct": 166.7})
        self.assertEqual(s["change"]["reviewedPct"]["abs"], -29.2)
        c = by_label(r)["Cutting"]
        self.assertEqual((c["absences"], c["reviewedPct"], c["lowSample"]), (1, 100.0, True))
        self.assertEqual(c["previous"], {"absences": 0, "reviewedPct": None})
        self.assertIsNone(c["change"]["reviewedPct"])  # no previous rate to compare with

    def test_units(self):
        r = self.api("departments", by="unit")
        self.assertEqual([(x["label"], x["absences"], x["unmarked"]) for x in r["rows"]], [("Unit A", 9, 5)])

    def test_staff_and_production(self):
        r = self.api("departments", by="type")
        self.assertEqual(
            [(x["label"], x["absences"], x["unmarked"]) for x in r["rows"]], [("Staff", 7, 4), ("Production", 2, 1)]
        )

    def test_the_overall_average_is_the_whole_selection(self):
        a = self.api("departments")["average"]
        self.assertEqual((a["absences"], a["unmarked"], a["reviewedPct"]), (9, 5, 44.4))

    def test_groups_without_absences_are_left_out(self):
        self.assertNotIn("Accounts", by_label(self.api("departments")))

    def test_lists_are_capped_and_say_so(self):
        r = self.api("departments", limit=1)
        self.assertEqual((len(r["rows"]), r["total"], r["truncated"]), (1, 2, True))
        self.assertEqual(len(self.api("departments", limit=500)["rows"]), 2)

    def test_a_bad_grouping_is_a_readable_error(self):
        r = self.get(f"{BASE}/departments", **W, by="planet")
        self.assertEqual(r.status_code, 400)
        self.assertIn("'by' must be one of", r.json()["error"])
        self.assertEqual(self.get(f"{BASE}/departments", **W, limit="many").status_code, 400)


# ═════════════════════════════════════════════════════════════════════════════════════════════════════════════════
# who exports attendance reports
# ═════════════════════════════════════════════════════════════════════════════════════════════════════════════════


class ExportTests(World):
    def test_who_exports_and_how_often(self):
        e = self.api("exports")
        t = e["totals"]
        self.assertEqual(
            (t["attendance"], t["all"], t["otherReports"], t["exporters"], t["days"], t["daysInPeriod"]),
            (6, 8, 2, 2, 5, 7),
        )
        self.assertEqual((t["previousAttendance"], t["change"]), (4, {"abs": 2, "pct": 50.0}))
        self.assertEqual(
            e["byUser"],
            [
                {"userName": "Priya", "exports": 4, "days": 4, "sharePct": 66.7, "lastAt": "2026-09-13T23:50:00"},
                {"userName": "Ravi", "exports": 2, "days": 2, "sharePct": 33.3, "lastAt": "2026-09-09T15:00:00"},
            ],
        )
        self.assertEqual(e["usersTotal"], 2)

    def test_which_reports(self):
        e = self.api("exports")
        self.assertEqual(
            [(r["report"], r["exports"], r["sharePct"]) for r in e["byReport"]],
            [(ATTENDANCE_1, 3, 50.0), (ATTENDANCE_2, 2, 33.3), ("Attendance Search (punch export)", 1, 16.7)],
        )

    def test_the_latest_exports(self):
        latest = self.api("exports")["latest"]
        self.assertEqual(
            [(x["at"], x["userName"], x["report"]) for x in latest],
            [
                ("2026-09-13T23:50:00", "Priya", ATTENDANCE_1),
                ("2026-09-10T11:00:00", "Priya", "Attendance Search (punch export)"),
                ("2026-09-09T15:00:00", "Ravi", ATTENDANCE_2),
                ("2026-09-09T10:20:00", "Priya", ATTENDANCE_1),
                ("2026-09-08T10:15:00", "Priya", ATTENDANCE_1),
            ],
        )

    def test_only_attendance_reports_count(self):
        # a payroll report (x6), a bonus register (x7) and a change to a report (not an export) are not attendance exports
        titles = rl._attendance_titles()
        self.assertEqual(len(titles), len(set(titles)))
        self.assertNotIn(self.payroll_title, titles)
        self.assertEqual(self.api("exports")["totals"]["all"] - self.api("exports")["totals"]["attendance"], 2)

    def test_every_attendance_report_of_the_report_center_is_recognised(self):
        before = self.api("exports", {"from": "2026-10-01", "to": "2026-10-01"})["totals"]["attendance"]
        titles = rl._attendance_titles()
        self.assertEqual(len(titles), len([s for s in all_specs() if s.category == "attendance"]))
        for i, title in enumerate(titles):
            report_export(ist(10, 1, 9, i % 60), "Priya", title)
        report_export(ist(10, 1, 9, 59), "Priya", "Some Unknown Report")
        t = self.api("exports", {"from": "2026-10-01", "to": "2026-10-01"})["totals"]
        self.assertEqual((before, t["attendance"], t["all"]), (0, len(titles), len(titles) + 1))

    def test_the_real_report_center_export_is_recognised(self):
        """The audit entry the Report Center really writes ("<title> - XLSX - n rows - ...") is counted."""
        admin = HRUser.objects.create(username="rootrl", password_hash="x", is_super_admin=True)
        token = sign_token({"role": "hr", "hrUserId": admin.id})
        today = datetime.now(FACTORY_TZ).date().isoformat()
        r = self.client.get(
            "/api/reports/export/absentee-list-daily",
            {"fmt": "xlsx", "dateFrom": today, "dateTo": today},
            HTTP_AUTHORIZATION=f"Bearer {token}",
        )
        self.assertEqual(r.status_code, 200, r.content[:300])
        row = AuditLog.objects.filter(action="export", module="reports").order_by("-id").first()
        self.assertTrue(row.record_description.startswith("Daily Absentee / Leave List - XLSX - "))
        counted = AuditLog.objects.filter(pk=row.pk).filter(rl._attendance_q(rl._attendance_titles())).count()
        self.assertEqual(counted, 1)

    def test_the_list_is_capped(self):
        e = self.api("exports", limit=1)
        self.assertEqual((len(e["byUser"]), e["usersTotal"], len(e["byReport"]), e["reportsTotal"]), (1, 2, 1, 3))

    def test_a_user_with_no_name_is_unknown(self):
        report_export(ist(9, 9, 12, 0), "", ATTENDANCE_1)
        users = {u["userName"]: u["exports"] for u in self.api("exports")["byUser"]}
        self.assertEqual(users["Unknown"], 1)

    def test_the_report_log_pages_own_exports_are_said_to_be_missing(self):
        e = self.api("exports")
        self.assertIn("Report Log page itself", " ".join(e["notes"]))
        self.assertEqual(len(e["unknowns"]), 5)

    def test_a_period_with_no_exports_says_so(self):
        e = self.api("exports", {"from": "2026-07-01", "to": "2026-07-05"})
        self.assertEqual((e["byUser"], e["byReport"], e["latest"]), ([], [], []))
        self.assertIsNone(e["totals"]["change"])
        self.assertIn("No attendance report export is on record", " ".join(e["notes"]))

    def test_exports_do_not_depend_on_the_scope(self):
        self.assertEqual(self.api("exports", department="Cutting")["totals"]["attendance"], 6)


# ═════════════════════════════════════════════════════════════════════════════════════════════════════════════════
# the empty database
# ═════════════════════════════════════════════════════════════════════════════════════════════════════════════════


class EmptyDatabaseTests(MdApiTestCase):
    """Nothing in the database: no division by zero, "no data" is null and never 0."""

    def setUp(self):
        super().setUp()
        frozen(self)

    def api(self, name, **params):
        r = self.get(f"{BASE}/{name}", **{**W, **params})
        self.assertEqual(r.status_code, 200, r.content)
        return r.json()

    def test_summary(self):
        s = self.api("summary")
        m = s["metrics"]
        for key in (
            "absences",
            "informed",
            "notInformed",
            "unmarked",
            "exports",
            "exportsAll",
            "exporters",
            "exportDays",
        ):
            self.assertEqual((m[key]["value"], m[key]["previous"]), (0, 0), key)
        for key in ("reviewedPct", "notInformedPct"):
            self.assertIsNone(m[key]["value"], key)
            self.assertIsNone(m[key]["change"], key)
        self.assertEqual((s["gapDays"], s["latestExport"]), (0, None))

    def test_every_other_endpoint(self):
        t = self.api("trend")
        self.assertEqual(len(t["points"]), 7)
        self.assertTrue(all(p["absences"] == 0 and p["exports"] == 0 and p["reviewedPct"] is None for p in t["points"]))
        g = self.api("gaps")
        self.assertEqual((g["gapDays"], g["gapDayCount"], g["daysWithAbsences"]), ([], 0, 0))
        self.assertEqual(self.api("departments")["rows"], [])
        e = self.api("exports")
        self.assertEqual((e["totals"]["attendance"], e["byUser"], e["byReport"], e["latest"]), (0, [], [], []))
        self.assertEqual(self.api("attention")["items"], [])
        self.assertIn("no absences", self.api("briefing")["text"])

    def test_the_dashboard_pieces(self):
        self.assertEqual(rl.insights(today=TODAY), [])
        h = rl.headline(today=TODAY)
        self.assertEqual(
            [k["id"] for k in h["kpis"]], ["reportlog.reviewed-pct", "reportlog.not-informed", "reportlog.exports"]
        )
        self.assertIsNone(h["kpis"][0]["value"])
        self.assertEqual((h["kpis"][1]["value"], h["kpis"][2]["value"]), (0, 0))
        self.assertTrue(all(k["delta"] is None for k in h["kpis"]))
        self.assertIn("No absences", h["kpis"][0]["sub"])


# ═════════════════════════════════════════════════════════════════════════════════════════════════════════════════
# needs your attention, the plain-English summary and the Dashboard's pieces
# ═════════════════════════════════════════════════════════════════════════════════════════════════════════════════


class ExceptionTests(World):
    def items(self, params=W, **extra):
        r = self.get(f"{BASE}/attention", **params, **extra)
        self.assertEqual(r.status_code, 200, r.content)
        return {i["id"]: i for i in r.json()["items"]}

    def test_the_findings_for_the_golden_week(self):
        items = self.items()
        self.assertEqual(list(items), ["reportlog.unmarked"])
        u = items["reportlog.unmarked"]
        self.assertEqual(u["severity"], "warning")
        self.assertEqual(u["title"], "5 of 9 absences have no Informed / Not informed call")
        self.assertEqual(u["metric"], "44%")
        self.assertEqual(u["page"], "report-log")
        self.assertTrue(u["ask"] and u["detail"])

    def test_it_is_critical_only_with_enough_absences_and_a_very_low_rate(self):
        AttendanceDayRecord.objects.filter(is_informed__isnull=False).update(is_informed=None)  # nothing marked: 0 %
        self.assertEqual(
            self.items()["reportlog.unmarked"]["severity"], "warning"
        )  # 9 absences are too few for critical
        with mock.patch.object(rl, "CRITICAL_MIN_ABSENCES", 9):
            self.assertEqual(self.items()["reportlog.unmarked"]["severity"], "critical")

    def test_too_few_absences_are_not_a_finding(self):
        with mock.patch.object(rl, "MIN_ABSENCES", 10):
            self.assertEqual(self.items(), {})

    def test_two_gap_days_are_a_finding(self):
        for who in (self.e1, self.e2):
            AttendanceDayRecord.objects.create(
                employee=who, date=d(14), status="absent"
            )  # Monday 14 Sep, nobody marked
        items = self.items({"from": "2026-09-07", "to": "2026-09-20"})
        self.assertEqual(items["reportlog.gap-days"]["title"], "2 days had 2+ absences and nobody made the call")
        self.assertEqual(items["reportlog.gap-days"]["severity"], "warning")

    def test_a_high_not_informed_share_is_a_finding(self):
        AttendanceDayRecord.objects.filter(employee=self.e2, date__gte=d(8), date__lte=d(10)).update(is_informed=False)
        items = self.items()
        self.assertEqual(items["reportlog.not-informed"]["title"], "56% of absences were marked Not informed")
        self.assertEqual(items["reportlog.not-informed"]["metric"], "5")

    def test_a_department_with_most_absences_unmarked_is_a_hot_spot(self):
        # Cutting has one absence only; give the company a better rate than Stitching's 62.5 % unmarked
        for day in (7, 8, 9, 10, 11):
            AttendanceDayRecord.objects.create(
                employee=self.e5, date=d(day) + timedelta(days=7), status="absent", is_informed=True
            )
        items = self.items({"from": "2026-09-07", "to": "2026-09-20"})
        hot = items["reportlog.hot-spot"]
        self.assertEqual(hot["title"], "Stitching: 5 of 8 absences have no call")
        self.assertEqual(hot["severity"], "info")

    def test_exports_that_stopped_are_news(self):
        items = self.items({"from": "2026-09-17", "to": "2026-09-30"})  # 14 days, none on record; 7 in the 14 before
        self.assertEqual(items["reportlog.exports-stopped"]["severity"], "info")
        self.assertIn("Report Log page itself", items["reportlog.exports-stopped"]["detail"])
        self.assertNotIn("reportlog.exports-stopped", self.items())  # the golden week has exports

    def test_good_news_only_when_everything_is_followed_up(self):
        AttendanceDayRecord.objects.filter(status="absent", is_informed__isnull=True).update(is_informed=True)
        items = self.items()
        self.assertEqual(list(items), ["reportlog.healthy"])
        self.assertEqual(items["reportlog.healthy"]["severity"], "good")
        self.assertEqual(items["reportlog.healthy"]["title"], "Absences are being followed up: 100% have a call")

    def test_findings_are_most_severe_first_and_capped_at_six(self):
        for who in (self.e1, self.e2):
            AttendanceDayRecord.objects.create(employee=who, date=d(14), status="absent")
        r = self.get(f"{BASE}/attention", **{"from": "2026-09-07", "to": "2026-09-20"}).json()
        ranks = [{"critical": 0, "warning": 1, "info": 2, "good": 3}[i["severity"]] for i in r["items"]]
        self.assertEqual(ranks, sorted(ranks))
        self.assertLessEqual(len(r["items"]), 6)

    def test_the_provenance_states_the_thresholds(self):
        text = json.dumps(self.api("attention")["provenance"])
        for fragment in ("50%", "20%", "15+", "30%", "60%", "1.25"):
            self.assertIn(fragment, text)


class DashboardPieceTests(World):
    def test_insights_are_company_wide_and_at_most_five(self):
        items = rl.insights(today=date(2026, 9, 14))  # the 14 complete days 31 Aug .. 13 Sep
        self.assertLessEqual(len(items), 5)
        self.assertTrue(all(set(i) == {"id", "severity", "title", "detail", "metric", "page", "ask"} for i in items))
        self.assertTrue(all(i["id"].startswith("reportlog.") and i["page"] == "report-log" for i in items))
        ranks = [{"critical": 0, "warning": 1, "info": 2, "good": 3}[i["severity"]] for i in items]
        self.assertEqual(ranks, sorted(ranks))

    def test_the_headline_cards(self):
        h = rl.headline(today=date(2026, 9, 14))  # last 7 complete days = W, the 7 before = P
        k = {x["id"]: x for x in h["kpis"]}
        self.assertEqual(list(k), ["reportlog.reviewed-pct", "reportlog.not-informed", "reportlog.exports"])
        r = k["reportlog.reviewed-pct"]
        self.assertEqual((r["value"], r["format"], r["page"]), (44.4, "pct", "report-log"))
        self.assertEqual(r["delta"], {"abs": -22.3, "pct": -33.4, "good": "up"})
        self.assertEqual(r["sub"], "4 of 9 absences marked · 07 Sep to 13 Sep")
        self.assertEqual(
            r["spark"], [0.0, 100.0, 100.0, None, None, None, None, 100.0, 0.0, 50.0, 33.3, 100.0, None, None]
        )
        n = k["reportlog.not-informed"]
        self.assertEqual((n["value"], n["format"]), (2, "number"))
        self.assertEqual(n["delta"], {"abs": 1, "pct": 100.0, "good": "down"})
        self.assertEqual(n["sub"], "5 more not yet marked · 07 Sep to 13 Sep")
        self.assertEqual(n["spark"], [0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0])
        e = k["reportlog.exports"]
        self.assertEqual(e["value"], 6)
        self.assertEqual(e["delta"], {"abs": 2, "pct": 50.0, "good": None})
        self.assertTrue(h["provenance"])

    def test_the_headline_uses_complete_days_only(self):
        # on Tuesday 15 Sep the last 7 complete days are Tue 8 .. Mon 14, so Monday 7 (E3's Not informed) drops out
        h = rl.headline(today=date(2026, 9, 15))
        k = {x["id"]: x for x in h["kpis"]}
        self.assertEqual(k["reportlog.not-informed"]["value"], 1)  # E1's Friday only


class PageBriefTests(World):
    """The strip above the MD's copy of the page is /api/md/brief/<page id>: this module's headline() and insights()."""

    def test_the_brief_serves_the_headline_cards_and_the_exceptions(self):
        r = self.get("/api/md/brief/report-log")
        self.assertEqual(r.status_code, 200, r.content)
        body = r.json()
        self.assertEqual(body["domain"], "reportlog")
        self.assertEqual(
            [k["id"] for k in body["kpis"]], ["reportlog.reviewed-pct", "reportlog.not-informed", "reportlog.exports"]
        )
        self.assertLessEqual(len(body["insights"]), 5)
        self.assertEqual(body["notes"], [])  # nothing failed: the figures are simply for the last complete days


class BriefingTests(World):
    def test_the_sentences_are_built_from_the_figures(self):
        b = self.api("briefing")
        by_id = {s["id"]: s for s in b["sentences"]}
        self.assertEqual(list(by_id), ["followup", "gaps", "where", "exports", "limits"])
        self.assertEqual(
            by_id["followup"]["text"],
            "07 Sep – 13 Sep 2026: 9 absences on scheduled days; 44% have an Informed (2) or Not informed (2) mark, 5 still unmarked.",
        )
        self.assertEqual(by_id["followup"]["tone"], "bad")
        self.assertEqual(
            by_id["gaps"]["text"],
            "1 day had 2+ absences with nothing marked, so the Daily Report was probably not worked then.",
        )
        self.assertEqual(by_id["where"]["text"], "Stitching has the most unmarked absences: 5 of its 8.")
        self.assertEqual(
            by_id["exports"]["text"],
            "6 attendance report exports are on record for 07 sep – 13 sep 2026, by 2 people on 5 of 7 days.",
        )
        self.assertIn("not recorded", by_id["limits"]["text"])
        self.assertEqual(b["text"], " ".join(s["text"] for s in b["sentences"]))
        self.assertIn("Report Log", b["ask"])

    def test_every_figure_in_the_sentences_is_on_the_page(self):
        b = self.api("briefing")
        m = self.metrics()
        self.assertIn(f"{m['absences']['value']} absences", b["text"])
        self.assertIn(f"{m['exports']['value']} attendance report exports", b["text"])


# ═════════════════════════════════════════════════════════════════════════════════════════════════════════════════
# access, parameters and the assistant's tools
# ═════════════════════════════════════════════════════════════════════════════════════════════════════════════════


class PermissionTests(TestCase):
    def test_only_the_md_gets_through_on_every_route(self):
        md = make_md()
        admin = HRUser.objects.create(username="root", password_hash="x", is_super_admin=True)
        role = Role.objects.create(name="Wide", permissions={"employees": "edit", "payroll": "edit", "reports": "edit"})
        clerk = HRUser.objects.create(username="clerk", password_hash="x", role=role)
        employee = Employee.objects.create(
            employee_code="E1", first_name="A", last_name="B", branch=Branch.objects.create(name="Unit Z")
        )
        emp_token = sign_token({"role": "employee", "employeeId": employee.id, "name": "A B"})
        for route in ROUTES:
            url = f"{BASE}/{route}"
            self.assertEqual(self.client.get(url, **md_headers(md)).status_code, 200, route)
            self.assertEqual(self.client.get(url, **md_headers(admin)).status_code, 403, route)
            self.assertEqual(self.client.get(url, **md_headers(clerk)).status_code, 403, route)
            self.assertEqual(self.client.get(url, HTTP_AUTHORIZATION=f"Bearer {emp_token}").status_code, 403, route)
            self.assertEqual(self.client.get(url).status_code, 401, route)
            self.assertEqual(self.client.post(url, **md_headers(md)).status_code, 405, route)

    def test_the_md_loses_access_the_moment_the_identity_is_taken_away(self):
        md = make_md()
        url = f"{BASE}/exports"
        self.assertEqual(self.client.get(url, **md_headers(md)).status_code, 200)
        HRUser.objects.filter(pk=md.pk).update(is_md=False)
        self.assertEqual(self.client.get(url, **md_headers(md)).status_code, 403)

    def test_nothing_is_written(self):
        """Every route runs inside the read-only transaction; reading the report log never marks or logs anything."""
        before = (AttendanceDayRecord.objects.count(), AuditLog.objects.count())
        md = make_md()
        for route in ROUTES:
            self.client.get(f"{BASE}/{route}", **md_headers(md))
        self.assertEqual((AttendanceDayRecord.objects.count(), AuditLog.objects.count()), before)


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
        for route in ROUTES:
            for params, text in cases:
                if route == "exports" and text in ("No department called", "No unit called", "staff or production"):
                    continue  # the exports are company-wide: they take no scope
                r = self.get(f"{BASE}/{route}", **params)
                self.assertEqual(r.status_code, 400, (route, params))
                self.assertIn(text, r.json()["error"])

    def test_the_default_period_is_the_last_30_days(self):
        s = self.get(f"{BASE}/summary").json()
        self.assertEqual(s["period"]["preset"], "last_30_days")
        self.assertEqual(s["period"]["days"], 30)


class ToolTests(World):
    NAMES = {
        "report_log_summary",
        "report_log_trend",
        "report_log_followup_by_group",
        "report_log_gap_days",
        "report_log_exports",
    }

    def tool(self, name):
        return registry.collect_tools()[name]

    def test_the_tools_are_registered_and_described_for_the_model(self):
        tools = registry.collect_tools()
        self.assertTrue(self.NAMES <= set(tools))
        for name in self.NAMES:
            spec = tools[name]
            self.assertEqual(spec.page, "report-log")
            self.assertGreaterEqual(len(spec.description), 120, name)
        self.assertIn("branch", self.tool("report_log_summary").properties)
        self.assertNotIn("branch", self.tool("report_log_exports").properties)  # the audit trail has no unit
        self.assertIn("period", self.tool("report_log_exports").properties)

    def test_summary_tool_is_the_same_number_as_the_page(self):
        result = self.tool("report_log_summary").run({"from": W["from"], "to": W["to"]})
        self.assertEqual(result["metrics"]["absences"]["value"], 9)
        self.assertEqual(result["metrics"]["reviewedPct"]["value"], 44.4)
        self.assertEqual(len(result["unknowns"]), 5)
        json.dumps(result)  # plain JSON, no dates or Decimals

    def test_breakdown_tool(self):
        spec = self.tool("report_log_followup_by_group")
        base = {"from": W["from"], "to": W["to"]}
        self.assertEqual(spec.run(base)["by"], "department")
        self.assertEqual(spec.run({**base, "by": "type"})["rows"][0]["label"], "Staff")
        with self.assertRaises(MdParamError):
            spec.run({**base, "by": "planet"})

    def test_exports_tool_names_people_in_the_standard_key(self):
        result = self.tool("report_log_exports").run({"from": W["from"], "to": W["to"]})
        self.assertEqual([r["userName"] for r in result["byUser"]], ["Priya", "Ravi"])
        self.assertIn("userName", registry.collect_tools()["report_log_exports"].person_fields)

    def test_trend_and_gap_tools(self):
        self.assertEqual(len(self.tool("report_log_trend").run({"from": W["from"], "to": W["to"]})["points"]), 7)
        g = self.tool("report_log_gap_days").run({"from": W["from"], "to": W["to"]})
        self.assertEqual(g["gapDayCount"], 1)

    def test_no_non_person_field_uses_a_name_key(self):
        """The assistant pseudonymises the standard person keys: a department or report called "name" would be hidden."""
        for name in self.NAMES:
            text = json.dumps(self.tool(name).run({"from": W["from"], "to": W["to"]}))
            for key in ('"name":', '"fullName":', '"visitorName":', '"managerName":', '"employeeName":'):
                self.assertNotIn(key, text, (name, key))

    def test_every_tool_runs_read_only(self):
        for name in self.NAMES:
            with read_only_db():
                result = self.tool(name).run({"from": W["from"], "to": W["to"]})
            self.assertTrue(result["provenance"], name)


# ═════════════════════════════════════════════════════════════════════════════════════════════════════════════════
# helpers and the query budget
# ═════════════════════════════════════════════════════════════════════════════════════════════════════════════════


class HelperTests(SimpleTestCase):
    def test_numbers_use_indian_grouping(self):
        self.assertEqual(rl._num(1234567), "12,34,567")
        self.assertEqual(rl._num(None), "n/a")
        self.assertEqual(rl._p(None), "n/a")
        self.assertEqual(rl._p(44.44, 1), "44.4%")

    def test_a_count_must_be_a_number(self):
        self.assertEqual(rl._int_arg("7", "limit", 10, 1, 25), 7)
        self.assertEqual(rl._int_arg(500, "limit", 10, 1, 25), 25)
        with self.assertRaises(MdParamError):
            rl._int_arg("many", "limit", 10, 1, 25)

    def test_the_share_of_a_tally(self):
        self.assertEqual(
            rl._share([10, 3, 2, 5]),
            {
                "absences": 10,
                "informed": 3,
                "notInformed": 2,
                "unmarked": 5,
                "reviewedPct": 50.0,
                "notInformedPct": 20.0,
                "unmarkedPct": 50.0,
            },
        )
        self.assertIsNone(rl._share([0, 0, 0, 0])["reviewedPct"])


class QueryCountTests(TestCase):
    def setUp(self):
        frozen(self)
        self.md = make_md()
        self.unit = Branch.objects.create(name="Unit Q", code="QQ")
        self.depts = [Department.objects.create(name=f"Dept {i}", branch=self.unit) for i in range(5)]
        self.shift = ShiftTemplate.objects.create(
            name="General", shift_type="staff", start_time=dtime(9), end_time=dtime(18), grace_period_minutes=15
        )
        self.made = 0

    def grow(self, employees: int):
        """Add people, each with a mix of absences (informed, not informed, unmarked) from 1 to 13 September, and exports."""
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
                    join_date="2025-01-01",
                )
            )
        Employee.objects.bulk_create(people)
        people = list(Employee.objects.filter(employee_code__startswith="Q").order_by("id"))[-employees:]
        EmployeeShiftAssignment.objects.bulk_create(
            [EmployeeShiftAssignment(employee=e, shift=self.shift, effective_from=date(2026, 1, 1)) for e in people]
        )
        rows, logs = [], []
        for i, e in enumerate(people):
            for day in range(1, 14):
                absent = (i + day) % 3 == 0
                rows.append(
                    AttendanceDayRecord(
                        employee=e,
                        date=d(day),
                        status="absent" if absent else "present",
                        is_informed=(None, True, False)[(i + day) % 3] if absent else None,
                    )
                )
            logs.append(
                AuditLog(
                    user_type="hr",
                    user_name=f"HR {i % 4}",
                    action="export",
                    module="attendance",
                    record_description="Exported 5 punches",
                )
            )
            logs.append(
                AuditLog(
                    user_type="hr",
                    user_name=f"HR {i % 4}",
                    action="export",
                    module="reports",
                    record_description=f"{ATTENDANCE_1} - XLSX - 3 rows",
                )
            )
        AttendanceDayRecord.objects.bulk_create(rows)
        AuditLog.objects.bulk_create(logs)

    def count(self, name, **params):
        with CaptureQueriesContext(connection) as ctx:
            r = self.client.get(f"{BASE}/{name}", {**W, **params}, **md_headers(self.md))
        self.assertEqual(r.status_code, 200, r.content)
        return len(ctx)

    ENDPOINTS = [
        ("summary", {}),
        ("briefing", {}),
        ("trend", {}),
        ("gaps", {}),
        ("departments", {}),
        ("departments", {"by": "unit"}),
        ("departments", {"by": "type"}),
        ("exports", {"limit": 25}),
        ("attention", {}),
    ]

    def test_no_query_per_row(self):
        self.grow(6)
        small = {(n, tuple(p.items())): self.count(n, **p) for n, p in self.ENDPOINTS}
        self.grow(60)
        large = {(n, tuple(p.items())): self.count(n, **p) for n, p in self.ENDPOINTS}
        self.assertEqual(small, large)
        for key, queries in large.items():
            self.assertLessEqual(queries, 60, key)  # a ceiling too: a handful of aggregate queries, never one per row

    def test_the_dashboard_pieces_do_not_grow_either(self):
        self.grow(6)
        with CaptureQueriesContext(connection) as small_ctx:
            rl.insights(today=date(2026, 9, 14))
            rl.headline(today=date(2026, 9, 14))
        self.grow(60)
        with CaptureQueriesContext(connection) as large_ctx:
            rl.insights(today=date(2026, 9, 14))
            rl.headline(today=date(2026, 9, 14))
        self.assertEqual(len(small_ctx), len(large_ctx))


class ScopeObjectTests(SimpleTestCase):
    def test_exports_take_no_scope(self):
        import inspect

        self.assertNotIn("scope", inspect.signature(rl.reportlog_exports).parameters)
        self.assertEqual(Scope().is_everyone(), True)
        self.assertEqual(resolve_period({"from": "2026-09-07", "to": "2026-09-13"}).days, 7)

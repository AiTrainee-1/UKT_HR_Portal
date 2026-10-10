"""MD portal, Geo Attendance: every figure recomputed by hand from a small company.

Run:  DB_TEST_NAME=test_uktex_geo python manage.py test api.tests_md_geo --noinput

The GOLDEN company (times are Indian time; NOW is Tue 15-Sep-2026 15:30; the clock is frozen):

  Units       Unit 1 (geofence centre 11.0000, 77.0000, radius 200 m), Unit 2 (no location set)
  Departments Sales (U1), Stores (U1), Sales (U2: same name, one department of the company), Admin (U1)
  Employees   A Sales/U1 staff   B Sales/U1 production   C Stores/U1 production   D Sales/U2 production
              E Admin/U1 staff   F Sales/U1 production (resigned)   G no department, no unit, staff (never goes out)
              (6 active people: A B C D E G)

THE PERIOD UNDER TEST is 01-Sep..14-Sep (14 days); the previous period is 18-Aug..31-Aug.

SESSIONS (requested at, status, hours from request to the final decision):
  s1 A 09-02 08:00 completed (3 h)       s2 A 09-03 08:30 rejected (30 h)      s3 A 09-04 08:00 rejected (2 h)
  s4 B 09-02 09:00 completed (24 h: HOD 3 h, HR 24 h)   s5 B 09-05 09:00 active, never ended (3 h): still open
  s6 C 09-02 07:00 completed (2 h), ended 23:30 = 16.5 h open     s7 E 09-08 10:00 pending HR, never ended
  s8 D 09-03 09:00 completed, decided by the Department Head only (12 h)   s9 F 09-06 09:00 completed (1 h)
  s10 D 09-14 23:50 completed (10 h; requested on 14-Sep although it is 15-Sep in UTC)
  Outside: s11 A 09-15 00:05 pending HOD (open; 15-Sep in Tirupur but 14-Sep in UTC), s13 C 09-15 09:30 active (open),
  s12 B 08-31 23:59:59 (previous period, the last second), p1 A 08-20, p2 B 08-21, p3 B 08-25 rejected (previous period).
  -> 10 sessions, 6 people (A B C D E F), 5 active people; 7 approved (6 completed + 1 active), 2 rejected, 1 pending HR.
  Decision hours 1 2 2 3 3 10 12 24 30: median 3, p90 25.2, within 24 h 8 of 9.

PUNCHES (status; distance from the unit; every punch is made at its own time and decided the stated hours later):
  s1 pa1 09-02 09:10 approved 5 km (2 h)      pa2 09-02 13:10 approved 5 km (24 h)
  s2 pa3 09-03 09:00 voided (30 km)           s3 pa4 09-04 09:00 rejected by HR 5 km (2 h)    pa5 09-04 18:00 voided 5 km
  s4 pb1 09-02 09:10 approved 1 km (3 h)      pb2 09-02 22:30 approved 1 km, SIMULATED GPS, odd hour (24 h)
  s5 pb3 09-05 09:30 pending 75 km            pb4 09-05 04:30 pending 250 km, SIMULATED GPS, odd hour
  s6 pc1 09-02 07:10 approved at the unit (2 h)
  s8 pd1 09-03 09:15 approved (12 h)          pd2 09-03 17:45 approved (48 h)     (Unit 2 has no location: unknown distance)
  s9 pf1 09-06 10:05 approved 5 km (1 h)      s10 pd3 09-14 23:52 pending (odd hour, unknown distance)
  Outside: pg1 C 09-15 10:00 pending (today); previous period: q1 A 08-20 approved, q2 B 08-21 approved, q3 B 08-25 voided.
  -> 14 punches: 8 approved, 1 rejected, 2 voided, 3 pending; 2 simulated; 1 far (over 100 km); 3 at odd hours;
  3 unplaced; decision hours 1 2 2 2 3 12 24 24 48 (9 decided): median 3, p90 28.8, within 24 h 8 of 9.

OFFICE GEO PUNCHES (source geo:auto): E 09-02 (2) + 09-03 (1), G 09-02 (1) = 4 in the period (a biometric punch is not
counted); A 08-20 (1) in the previous period; E 09-15 (today, outside).

LIVE (now): open sessions s5 (B, left open), s7 (E, left open), s11 (A, today, awaiting approval), s13 (C, today, approved).
C's phone reported 20 minutes ago from 5 km away; A's 90 minutes ago (no signal); B and E are not tracked.
"""

import json
from datetime import date, datetime, timedelta
from datetime import time as dtime
from datetime import timezone as dt_timezone
from unittest import mock

from django.db import connection
from django.test import SimpleTestCase, TestCase
from django.test.utils import CaptureQueriesContext

from . import geo_attendance_views as GV
from .clock import FACTORY_TZ
from .geo_utils import haversine_distance_m
from .jwt_utils import sign_token
from .md_portal.analytics import geo
from .md_portal.assistant import registry
from .md_portal.common import MdParamError, Scope, read_only_db, resolve_period
from .models import (
    AttendanceLog,
    Branch,
    Department,
    Employee,
    HRUser,
    LiveLocationPing,
    OnDutyPunchVerification,
    OnDutySession,
    Role,
)
from .tests_md_support import MdApiTestCase, make_md, md_headers

NOW = datetime(2026, 9, 15, 10, 0, tzinfo=dt_timezone.utc)  # 15:30 IST on Tuesday 15 Sep 2026
TODAY = date(2026, 9, 15)
P = {"from": "2026-09-01", "to": "2026-09-14"}  # the period under test; the previous one is 2026-08-18..2026-08-31
ROUTES = [
    "summary",
    "briefing",
    "trend",
    "verification",
    "departments",
    "people",
    "reach",
    "unusual",
    "live",
    "attention",
]

LAT0, LNG0 = 11.0, 77.0  # Unit 1's geofence centre
# latitude offsets from the centre that are about 1, 5, 30, 75 and 250 km away
LAT_1KM, LAT_5KM, LAT_30KM, LAT_75KM, LAT_250KM = 0.009, 0.045, 0.27, 0.675, 2.25
VOID = "Voided automatically -the On-Duty request was rejected by HR."


def ist(month, day, hh=0, mm=0, ss=0, year=2026):
    return datetime(year, month, day, hh, mm, ss, tzinfo=FACTORY_TZ)


def freeze_clock(test):
    patcher = mock.patch.object(geo, "now_utc", return_value=NOW)
    patcher.start()
    test.addCleanup(patcher.stop)


def make_session(
    emp, created, status, *, started=None, ended=None, completed=None, hod_at=None, hr_at=None, destination="Site visit"
):
    s = OnDutySession.objects.create(
        employee=emp,
        destination=destination,
        branch=emp.branch,
        status=status,
        started_at=started,
        employee_ended_at=ended,
        completed_at=completed,
        hod_reviewed_at=hod_at,
        hod_reviewed_by="Dept Head" if hod_at else None,
        hr_reviewed_at=hr_at,
        hr_reviewed_by="HR Priya" if hr_at else None,
    )
    OnDutySession.objects.filter(pk=s.pk).update(created_at=created)
    return s


def make_punch(
    session,
    day,
    hh,
    mm,
    number,
    lat,
    status,
    *,
    lng=LNG0,
    mocked=False,
    decided_after_hours=None,
    comment=None,
):
    created = datetime.combine(day, dtime(hh, mm), tzinfo=FACTORY_TZ)
    reviewed = created + timedelta(hours=decided_after_hours) if decided_after_hours is not None else None
    v = OnDutyPunchVerification.objects.create(
        session=session,
        employee=session.employee,
        punch_date=day,
        punch_time=dtime(hh, mm),
        punch_type="IN" if number % 2 else "OUT",
        punch_number=number,
        latitude=lat,
        longitude=lng,
        accuracy_m=12.0,
        is_mocked=mocked,
        photo="on_duty_punch_verifications/test.jpg",
        status=status,
        hr_reviewed_by="HR Priya" if reviewed else None,
        hr_reviewed_at=reviewed,
        hr_review_comment=comment,
    )
    OnDutyPunchVerification.objects.filter(pk=v.pk).update(created_at=created)
    return v


def build_golden(cls):
    """The company in the module docstring."""
    cls.u1 = Branch.objects.create(
        name="Unit 1", code="GU1", geofence_lat=LAT0, geofence_lng=LNG0, geofence_radius_m=200
    )
    cls.u2 = Branch.objects.create(name="Unit 2", code="GU2", geofence_lat=None, geofence_lng=None)
    cls.sales1 = Department.objects.create(name="Sales", branch=cls.u1)
    cls.stores = Department.objects.create(name="Stores", branch=cls.u1)
    cls.sales2 = Department.objects.create(name="Sales", branch=cls.u2)
    cls.admin_dept = Department.objects.create(name="Admin", branch=cls.u1)

    def emp(code, first, dept, branch, kind, status="active", tracked=False):
        return Employee.objects.create(
            employee_code=code,
            first_name=first,
            last_name="Test",
            department=dept,
            branch=branch,
            employment_type=kind,
            status=status,
            location_tracking_enabled=tracked,
        )

    cls.A = emp("A", "Asha", cls.sales1, cls.u1, "staff", tracked=True)
    cls.B = emp("B", "Babu", cls.sales1, cls.u1, "production")
    cls.C = emp("C", "Chitra", cls.stores, cls.u1, "production", tracked=True)
    cls.D = emp("D", "Dinesh", cls.sales2, cls.u2, "production")
    cls.E = emp("E", "Esha", cls.admin_dept, cls.u1, "staff")
    cls.F = emp("F", "Farook", cls.sales1, cls.u1, "production", status="resigned")
    cls.G = emp("G", "Gita", None, None, "staff")

    S = OnDutySession
    # ── the period ──
    s1 = make_session(cls.A, ist(9, 2, 8), S.STATUS_COMPLETED, started=ist(9, 2, 8), hr_at=ist(9, 2, 11))
    s2 = make_session(cls.A, ist(9, 3, 8, 30), S.STATUS_REJECTED, hr_at=ist(9, 4, 14, 30))
    s3 = make_session(cls.A, ist(9, 4, 8), S.STATUS_REJECTED, hr_at=ist(9, 4, 10))
    s4 = make_session(
        cls.B, ist(9, 2, 9), S.STATUS_COMPLETED, started=ist(9, 2, 9), hod_at=ist(9, 2, 12), hr_at=ist(9, 3, 9)
    )
    s5 = make_session(cls.B, ist(9, 5, 9), S.STATUS_ACTIVE, started=ist(9, 5, 9), hr_at=ist(9, 5, 12))
    s6 = make_session(
        cls.C,
        ist(9, 2, 7),
        S.STATUS_COMPLETED,
        started=ist(9, 2, 7),
        ended=ist(9, 2, 23, 30),
        completed=ist(9, 2, 23, 30),
        hr_at=ist(9, 2, 9),
    )
    s7 = make_session(cls.E, ist(9, 8, 10), S.STATUS_PENDING_HR, hod_at=ist(9, 8, 11))
    s8 = make_session(cls.D, ist(9, 3, 9), S.STATUS_COMPLETED, started=ist(9, 3, 9), hod_at=ist(9, 3, 21))
    s9 = make_session(cls.F, ist(9, 6, 9), S.STATUS_COMPLETED, started=ist(9, 6, 9), hr_at=ist(9, 6, 10))
    s10 = make_session(
        cls.D,
        ist(9, 14, 23, 50),
        S.STATUS_COMPLETED,
        started=ist(9, 14, 23, 50),
        ended=ist(9, 14, 23, 55),
        hr_at=ist(9, 15, 9, 50),
    )
    # ── outside the period ──
    s11 = make_session(cls.A, ist(9, 15, 0, 5), S.STATUS_PENDING_HOD)
    s13 = make_session(cls.C, ist(9, 15, 9, 30), S.STATUS_ACTIVE, started=ist(9, 15, 9, 30), hr_at=ist(9, 15, 9, 45))
    make_session(cls.B, ist(8, 31, 23, 59, 59), S.STATUS_COMPLETED, started=ist(8, 31, 23, 59), hr_at=ist(9, 1, 9))
    p1 = make_session(cls.A, ist(8, 20, 8), S.STATUS_COMPLETED, started=ist(8, 20, 8), hr_at=ist(8, 20, 10))
    p2 = make_session(cls.B, ist(8, 21, 8), S.STATUS_COMPLETED, started=ist(8, 21, 8), hr_at=ist(8, 21, 10))
    p3 = make_session(cls.B, ist(8, 25, 8), S.STATUS_REJECTED, hr_at=ist(8, 25, 10))
    cls.sessions = {
        k: v
        for k, v in dict(
            s1=s1, s2=s2, s3=s3, s4=s4, s5=s5, s6=s6, s7=s7, s8=s8, s9=s9, s10=s10, s11=s11, s13=s13
        ).items()
    }

    A_, R_, V_, N_ = (
        OnDutyPunchVerification.STATUS_APPROVED,
        OnDutyPunchVerification.STATUS_REJECTED,
        OnDutyPunchVerification.STATUS_REJECTED,
        OnDutyPunchVerification.STATUS_PENDING,
    )
    d = lambda m, day: date(2026, m, day)  # noqa: E731
    make_punch(s1, d(9, 2), 9, 10, 1, LAT0 + LAT_5KM, A_, decided_after_hours=2)  # pa1
    make_punch(s1, d(9, 2), 13, 10, 2, LAT0 + LAT_5KM, A_, decided_after_hours=24)  # pa2
    make_punch(s2, d(9, 3), 9, 0, 1, LAT0 + LAT_30KM, V_, decided_after_hours=23.5, comment=VOID)  # pa3
    make_punch(s3, d(9, 4), 9, 0, 1, LAT0 + LAT_5KM, R_, decided_after_hours=2, comment="Photo unclear")  # pa4
    make_punch(s3, d(9, 4), 18, 0, 2, LAT0 + LAT_5KM, V_, decided_after_hours=2, comment=VOID)  # pa5
    make_punch(s4, d(9, 2), 9, 10, 1, LAT0 + LAT_1KM, A_, decided_after_hours=3)  # pb1
    make_punch(s4, d(9, 2), 22, 30, 2, LAT0 + LAT_1KM, A_, mocked=True, decided_after_hours=24)  # pb2
    make_punch(s5, d(9, 5), 9, 30, 1, LAT0 + LAT_75KM, N_)  # pb3
    make_punch(s5, d(9, 5), 4, 30, 2, LAT0 + LAT_250KM, N_, mocked=True)  # pb4
    make_punch(s6, d(9, 2), 7, 10, 1, LAT0, A_, decided_after_hours=2)  # pc1
    make_punch(s8, d(9, 3), 9, 15, 1, 12.0, A_, lng=78.0, decided_after_hours=12)  # pd1
    make_punch(s8, d(9, 3), 17, 45, 2, 12.0, A_, lng=78.0, decided_after_hours=48)  # pd2
    make_punch(s9, d(9, 6), 10, 5, 1, LAT0 + LAT_5KM, A_, decided_after_hours=1)  # pf1
    make_punch(s10, d(9, 14), 23, 52, 1, 12.0, N_, lng=78.0)  # pd3
    make_punch(s13, d(9, 15), 10, 0, 1, LAT0 + LAT_5KM, N_)  # pg1 (today)
    make_punch(p1, d(8, 20), 9, 0, 1, LAT0 + LAT_5KM, A_, decided_after_hours=4)  # q1
    make_punch(p2, d(8, 21), 9, 0, 1, LAT0 + LAT_5KM, A_, decided_after_hours=4)  # q2
    make_punch(p3, d(8, 25), 9, 0, 1, LAT0 + LAT_5KM, V_, decided_after_hours=2, comment=VOID)  # q3

    def office(e, day, hh, mm, kind="IN", source="geo:auto"):
        AttendanceLog.objects.create(employee=e, date=day, punch_time=dtime(hh, mm), punch_type=kind, source=source)

    office(cls.E, d(9, 2), 8, 55)
    office(cls.E, d(9, 2), 17, 30, "OUT")
    office(cls.E, d(9, 3), 8, 50)
    office(cls.G, d(9, 2), 9, 0)
    office(cls.G, d(9, 2), 9, 5, source="biometric:zk")  # a different source: not an office geo punch
    office(cls.A, d(8, 20), 8, 59)
    office(cls.E, d(9, 15), 8, 50)

    def ping(e, when, lat, lng, mocked=False):
        row = LiveLocationPing.objects.create(
            employee=e, latitude=lat, longitude=lng, accuracy_m=10.0, is_mocked=mocked
        )
        LiveLocationPing.objects.filter(pk=row.pk).update(recorded_at=when)

    ping(cls.C, ist(9, 15, 15, 10), LAT0 + LAT_5KM, LNG0)  # 20 minutes ago
    ping(cls.A, ist(9, 15, 14, 0), LAT0 + LAT_30KM, LNG0)  # 90 minutes ago
    ping(cls.A, ist(9, 15, 13, 0), LAT0 + LAT_75KM, LNG0)  # older: the newest one wins


class GoldenBase(MdApiTestCase):
    @classmethod
    def setUpTestData(cls):
        build_golden(cls)

    def setUp(self):
        super().setUp()
        freeze_clock(self)

    def api(self, name, **params):
        merged = {**P, **params}
        r = self.get(f"/api/md/geo/{name}", **merged)
        self.assertEqual(r.status_code, 200, r.content)
        return r.json()


# ═════════════════════════════════════════════════════════════════════════════════════════════════════════════════
# summary
# ═════════════════════════════════════════════════════════════════════════════════════════════════════════════════


class SummaryTests(GoldenBase):
    def test_the_figures_equal_the_hand_count(self):
        s = self.api("summary")
        m = s["metrics"]
        self.assertEqual((m["sessions"]["value"], m["sessions"]["previous"]), (10, 4))
        self.assertEqual((m["people"]["value"], m["people"]["previous"]), (6, 2))
        self.assertEqual((m["punches"]["value"], m["punches"]["previous"]), (14, 3))
        self.assertEqual((m["officePunches"]["value"], m["officePunches"]["previous"]), (4, 1))
        self.assertEqual((m["verifiedPct"]["value"], m["verifiedPct"]["previous"]), (57.1, 66.7))
        self.assertEqual((m["rejectedPct"]["value"], m["rejectedPct"]["previous"]), (21.4, 33.3))
        self.assertEqual(m["pendingPunches"]["value"], 3)
        self.assertEqual(m["medianVerifyHours"]["value"], 3.0)
        self.assertEqual(m["mockedPunches"]["value"], 2)
        self.assertEqual(m["farPunches"]["value"], 1)
        self.assertEqual(m["oddPunches"]["value"], 3)
        self.assertEqual(s["officePeople"], 2)

    def test_changes_against_the_previous_period(self):
        m = self.api("summary")["metrics"]
        self.assertEqual(m["sessions"]["change"], {"abs": 6, "pct": 150.0})
        self.assertEqual(m["punches"]["change"], {"abs": 11, "pct": 366.7})
        self.assertEqual(m["verifiedPct"]["change"]["abs"], -9.6)  # percentage figures change in points

    def test_participation_counts_only_people_who_are_still_here(self):
        s = self.api("summary")
        # A B C D E went out and are active; F went out but has left: 5 of the 6 active employees
        self.assertEqual(s["headcount"], 6)
        self.assertEqual(s["participationPct"], 83.3)

    def test_the_previous_period_is_the_same_length_just_before(self):
        s = self.api("summary")
        self.assertEqual((s["previousPeriod"]["start"], s["previousPeriod"]["end"]), ("2026-08-18", "2026-08-31"))
        self.assertEqual(s["period"]["days"], 14)

    def test_provenance_explains_every_figure(self):
        s = self.api("summary")
        ids = {p["id"] for p in s["provenance"]}
        self.assertEqual(
            ids,
            {
                "geo-sessions",
                "geo-punches",
                "geo-office-punches",
                "geo-verification",
                "geo-turnaround",
                "geo-distance",
                "geo-previous",
            },
        )
        for entry in s["provenance"]:
            self.assertTrue(entry["definition"], entry["id"])
        rows = {p["id"]: p["rows"] for p in s["provenance"]}
        self.assertEqual((rows["geo-sessions"], rows["geo-punches"], rows["geo-office-punches"]), (10, 14, 4))
        self.assertIn(
            "refused", " ".join(next(p for p in s["provenance"] if p["id"] == "geo-office-punches")["caveats"])
        )

    def test_leavers_stay_in_the_history(self):
        self.assertEqual(
            self.api("summary", department="Sales")["metrics"]["sessions"]["value"], 8
        )  # F's session is in
        self.assertEqual(self.api("summary", type="production")["metrics"]["sessions"]["value"], 6)  # B2 C1 D2 F1

    def test_a_period_that_includes_today_is_flagged_partial(self):
        s = self.get("/api/md/geo/summary", **{"from": "2026-09-10", "to": "2026-09-15"}).json()
        self.assertIn("Today is still in progress", " ".join(s["notes"]))
        self.assertNotIn("Today is still in progress", " ".join(self.api("summary")["notes"]))

    def test_the_database_distance_agrees_with_the_standard_haversine(self):
        """The distance is measured in SQL for every punch; it must equal geo_utils.haversine_distance_m."""
        rows = (
            OnDutyPunchVerification.objects.filter(employee=self.B)
            .annotate(dist_m=geo._distance_m())
            .values("latitude", "longitude", "dist_m")
        )
        self.assertEqual(len(rows), 6)  # pb1..pb4 and q2 / q3
        for r in rows:
            expected = haversine_distance_m(float(r["latitude"]), float(r["longitude"]), LAT0, LNG0)
            self.assertAlmostEqual(r["dist_m"], expected, delta=1.0)

    def test_the_void_marker_is_the_one_the_application_writes(self):
        """A rejected request voids its punches with a fixed comment: this module recognises voided punches by it."""
        session = self.sessions["s7"]  # pending HR, no punches: give it one, then void it the way HR's rejection does
        v = make_punch(session, date(2026, 9, 8), 10, 30, 1, LAT0, OnDutyPunchVerification.STATUS_PENDING)
        GV._void_session_punches(session, "HR Priya", "HR")
        v.refresh_from_db()
        self.assertTrue(v.hr_review_comment.startswith(geo.VOID_COMMENT_PREFIX))
        self.assertEqual(geo.geo_verification(Scope(), resolve_period(P))["punches"]["voided"], 3)

    def test_the_constants_follow_the_application(self):
        self.assertEqual(geo.OFFICE_SOURCE, "geo:auto")
        self.assertEqual(geo.DEFAULT_RADIUS_M, GV.DEFAULT_RADIUS_M)
        self.assertEqual(set(geo.PUNCHABLE_STATUSES), set(GV.PUNCHABLE_STATUSES))


# ═════════════════════════════════════════════════════════════════════════════════════════════════════════════════
# periods
# ═════════════════════════════════════════════════════════════════════════════════════════════════════════════════


class PeriodEdgeTests(GoldenBase):
    def count_sessions(self, start, end):
        r = self.get("/api/md/geo/summary", **{"from": start, "to": end}).json()
        return r["metrics"]["sessions"]["value"]

    def test_both_ends_are_inclusive_and_a_session_belongs_to_the_day_it_was_requested(self):
        self.assertEqual(self.count_sessions("2026-08-31", "2026-08-31"), 1)  # the last second of 31-Aug (Tirupur)
        self.assertEqual(self.count_sessions("2026-09-01", "2026-09-01"), 0)
        self.assertEqual(self.count_sessions("2026-09-02", "2026-09-02"), 3)  # s1 s4 s6
        self.assertEqual(self.count_sessions("2026-09-14", "2026-09-14"), 1)  # s10: 23:50 in Tirupur, still 14-Sep

    def test_a_session_just_after_midnight_in_tirupur_is_the_next_day_whatever_utc_says(self):
        self.assertEqual(self.count_sessions("2026-09-15", "2026-09-15"), 2)  # s11 (00:05 IST = 14-Sep in UTC) and s13
        self.assertEqual(self.count_sessions("2026-09-14", "2026-09-14"), 1)

    def test_previous_period_edges(self):
        s = self.get("/api/md/geo/summary", **{"from": "2026-09-01", "to": "2026-09-07"}).json()
        self.assertEqual((s["previousPeriod"]["start"], s["previousPeriod"]["end"]), ("2026-08-25", "2026-08-31"))
        self.assertEqual(s["metrics"]["sessions"]["previous"], 2)  # p3 (25-Aug) and s12 (the last second of 31-Aug)

    def test_a_period_crossing_a_month_boundary(self):
        self.assertEqual(self.count_sessions("2026-08-30", "2026-09-02"), 4)  # s12, s1, s4, s6

    def test_a_whole_month(self):
        r = self.get("/api/md/geo/summary", month="2026-08").json()
        self.assertEqual((r["period"]["start"], r["period"]["end"]), ("2026-08-01", "2026-08-31"))
        self.assertEqual(r["metrics"]["sessions"]["value"], 4)


# ═════════════════════════════════════════════════════════════════════════════════════════════════════════════════
# scope
# ═════════════════════════════════════════════════════════════════════════════════════════════════════════════════


class ScopeTests(GoldenBase):
    def figures(self, **scope):
        m = self.api("summary", **scope)["metrics"]
        return (m["sessions"]["value"], m["people"]["value"], m["punches"]["value"], m["officePunches"]["value"])

    def test_everyone(self):
        self.assertEqual(self.figures(), (10, 6, 14, 4))

    def test_a_unit(self):
        self.assertEqual(self.figures(branch="Unit 2"), (2, 1, 3, 0))  # D only
        self.assertEqual(self.figures(branch="Unit 1"), (8, 5, 11, 3))  # office: E's three; G has no unit

    def test_a_department_name_covers_every_unit_that_has_one(self):
        self.assertEqual(self.figures(department="Sales"), (8, 4, 13, 0))  # A B D F

    def test_staff_and_production(self):
        self.assertEqual(self.figures(type="staff"), (4, 2, 5, 4))  # A (3) + E (1); office: E and G
        self.assertEqual(self.figures(type="production"), (6, 4, 9, 0))  # B C D F

    def test_combined_filters(self):
        self.assertEqual(self.figures(branch="Unit 1", department="Sales", type="production"), (3, 2, 5, 0))

    def test_a_scope_with_nothing_has_no_rates(self):
        m = self.api("summary", branch="Unit 2", department="Sales", type="staff")["metrics"]
        self.assertEqual(m["sessions"]["value"], 0)
        self.assertIsNone(m["verifiedPct"]["value"])
        self.assertIsNone(m["medianVerifyHours"]["value"])

    def test_a_typo_is_matched_and_said(self):
        s = self.api("summary", department="Sals")
        self.assertIn("Matched department 'Sals' to 'Sales'", " ".join(s["notes"]))
        self.assertEqual(s["metrics"]["sessions"]["value"], 8)

    def test_the_scope_applies_to_every_endpoint(self):
        scope = {"branch": "Unit 2"}
        self.assertEqual(self.api("trend", **scope)["points"][1]["sessions"], 0)  # 02-Sep: nobody in Unit 2
        self.assertEqual(self.api("verification", **scope)["sessions"]["requested"], 2)
        self.assertEqual([r["label"] for r in self.api("departments", **scope)["rows"]], ["Sales"])
        self.assertEqual([r["employeeCode"] for r in self.api("people", **scope)["rows"]], ["D"])
        self.assertEqual(self.api("reach", **scope)["punches"], 3)
        self.assertEqual([r["sessionId"] for r in self.api("unusual", **scope)["rows"]], [self.sessions["s10"].id])
        self.assertEqual(self.api("live", **scope)["rows"], [])


# ═════════════════════════════════════════════════════════════════════════════════════════════════════════════════
# trend
# ═════════════════════════════════════════════════════════════════════════════════════════════════════════════════


class TrendTests(GoldenBase):
    def test_every_day_equals_the_hand_count(self):
        t = self.api("trend")
        self.assertEqual(t["granularity"], "day")
        self.assertEqual(len(t["points"]), 14)
        by_day = {p["date"]: p for p in t["points"]}
        d2 = by_day["2026-09-02"]
        self.assertEqual(
            (d2["sessions"], d2["punches"], d2["approved"], d2["rejected"], d2["pending"]), (3, 5, 5, 0, 0)
        )
        self.assertEqual(d2["officePunches"], 3)  # E twice and G once
        d4 = by_day["2026-09-04"]
        self.assertEqual(
            (d4["sessions"], d4["punches"], d4["approved"], d4["rejected"]), (1, 2, 0, 2)
        )  # pa4 + voided pa5
        d5 = by_day["2026-09-05"]
        self.assertEqual((d5["sessions"], d5["punches"], d5["pending"]), (1, 2, 2))
        self.assertEqual(sum(p["sessions"] for p in t["points"]), 10)
        self.assertEqual(sum(p["punches"] for p in t["points"]), 14)
        self.assertEqual(sum(p["officePunches"] for p in t["points"]), 4)

    def test_days_with_nothing_are_zero_not_missing(self):
        t = self.api("trend")
        by_day = {p["date"]: p for p in t["points"]}
        self.assertEqual((by_day["2026-09-01"]["sessions"], by_day["2026-09-01"]["punches"]), (0, 0))

    def test_the_seven_day_average_reaches_back_before_the_period(self):
        t = self.api("trend")
        by_day = {p["date"]: p for p in t["points"]}
        # 01-Sep: the 7 days 26-Aug..01-Sep hold no session (s12 is 31-Aug 23:59:59 = 1) -> 1 / 7
        self.assertEqual(by_day["2026-09-01"]["maSessions"], round(1 / 7, 1))
        # 07-Sep: 01..07 Sep = s1 s4 s6 (02), s2 s8 (03), s3 (04), s5 (05), s9 (06) = 8 -> 8 / 7
        self.assertEqual(by_day["2026-09-07"]["maSessions"], round(8 / 7, 1))

    def test_the_busiest_day(self):
        self.assertEqual(self.api("trend")["busiestDay"], {"date": "2026-09-02", "sessions": 3, "punches": 5})

    def test_rising_or_falling_compares_the_last_seven_days_with_the_seven_before(self):
        m = self.api("trend")["momentum"]
        # 08..14 Sep: s7, s10 = 2; 01..07 Sep: 8 sessions
        self.assertEqual((m["current"]["sessions"], m["previous"]["sessions"]), (2, 8))
        self.assertEqual(m["verdict"], "falling")
        self.assertIn("falling", m["text"])

    def test_too_little_to_say_is_said(self):
        m = self.get("/api/md/geo/trend", **{"from": "2026-08-15", "to": "2026-08-22"}).json()["momentum"]
        self.assertEqual(m["verdict"], "unclear")

    def test_a_long_period_is_rolled_up_by_week(self):
        t = self.get("/api/md/geo/trend", **{"from": "2026-06-29", "to": "2026-09-14"}).json()  # 78 days
        self.assertEqual(t["granularity"], "week")
        self.assertTrue(all(p["maSessions"] is None for p in t["points"]))
        self.assertEqual(t["points"][0]["date"], "2026-06-29")  # a Monday
        self.assertEqual(sum(p["sessions"] for p in t["points"]), 14)  # 10 in September + 4 in August
        self.assertEqual(sum(p["days"] for p in t["points"]), 78)
        self.assertIsNone(t["busiestDay"])


# ═════════════════════════════════════════════════════════════════════════════════════════════════════════════════
# verification
# ═════════════════════════════════════════════════════════════════════════════════════════════════════════════════


class VerificationTests(GoldenBase):
    def test_where_requests_and_punches_stand(self):
        v = self.api("verification")
        self.assertEqual(
            v["sessions"],
            {
                "requested": 10,
                "awaitingHod": 0,
                "awaitingHr": 1,
                "approved": 7,
                "active": 1,
                "completed": 6,
                "rejected": 2,
            },
        )
        self.assertEqual(v["punches"], {"captured": 14, "approved": 8, "rejected": 1, "voided": 2, "pending": 3})
        self.assertEqual((v["verifiedPct"], v["rejectedPct"]), (57.1, 21.4))

    def test_the_four_states_add_up_to_the_punches_captured(self):
        p = self.api("verification")["punches"]
        self.assertEqual(p["approved"] + p["rejected"] + p["voided"] + p["pending"], p["captured"])

    def test_how_long_hr_takes_to_decide_a_punch(self):
        t = self.api("verification")["decisionTime"]["punches"]
        # decided by HR (voided ones are left out): 1 2 2 2 3 12 24 24 48 hours
        self.assertEqual(t["decided"], 9)
        self.assertEqual(t["medianHours"], 3.0)
        self.assertEqual(t["p90Hours"], 28.8)
        self.assertEqual(t["within24hPct"], 88.9)

    def test_how_long_a_request_takes_to_decide(self):
        t = self.api("verification")["decisionTime"]["requests"]
        # 1 2 2 3 3 10 12 24 30 hours: s8 was decided by the Department Head alone, s4 by HR after the Department Head
        self.assertEqual(t["decided"], 9)
        self.assertEqual(t["medianHours"], 3.0)
        self.assertEqual(t["p90Hours"], 25.2)
        self.assertEqual(t["within24hPct"], 88.9)

    def test_what_is_waiting_right_now_ignores_the_period(self):
        b = self.api("verification", **{"from": "2026-08-18", "to": "2026-08-19"})["backlog"]
        # pb3 pb4 (captured 05-Sep) pd3 (14-Sep 23:52) pg1 (today 10:00)
        self.assertEqual((b["pendingPunches"], b["pendingSessions"]), (4, 2))
        self.assertEqual(b["oldestPunchHours"], 251.0)  # pb4: 05-Sep 04:30 to 15-Sep 15:30
        self.assertEqual(b["oldestSessionHours"], 173.5)  # s7: 08-Sep 10:00
        self.assertEqual((b["overduePunches"], b["overdueSessions"]), (2, 1))
        buckets = {x["label"]: (x["punches"], x["sessions"]) for x in b["ageBuckets"]}
        self.assertEqual(
            buckets,
            {"Under a day": (2, 1), "1 to 2 days": (0, 0), "2 to 7 days": (0, 0), "Over a week": (2, 1)},
        )

    def test_nothing_decided_has_no_timing(self):
        v = self.api("verification", branch="Unit 2", department="Sales", type="staff")
        self.assertIsNone(v["decisionTime"]["punches"]["medianHours"])
        self.assertIsNone(v["decisionTime"]["punches"]["within24hPct"])
        self.assertIsNone(v["verifiedPct"])


# ═════════════════════════════════════════════════════════════════════════════════════════════════════════════════
# who goes out
# ═════════════════════════════════════════════════════════════════════════════════════════════════════════════════


def by_label(response):
    return {r["label"]: r for r in response["rows"]}


class BreakdownTests(GoldenBase):
    def test_departments_by_name_ranked_by_sessions(self):
        r = self.api("departments")
        self.assertEqual([x["label"] for x in r["rows"]], ["Sales", "Stores", "Admin"])
        sales = by_label(r)["Sales"]
        self.assertEqual((sales["sessions"], sales["people"], sales["punches"]), (8, 4, 13))
        self.assertEqual(sales["headcount"], 3)  # A B D are active; F has left
        self.assertEqual(sales["participationPct"], 100.0)  # 3 active people out of 3
        self.assertEqual(sales["shareOfSessionsPct"], 80.0)
        self.assertEqual(sales["sessionsPerPerson"], 2.0)
        self.assertEqual((sales["rejectedSessions"], sales["rejectedPunches"], sales["mockedPunches"]), (2, 3, 2))
        self.assertEqual(sales["farPunches"], 1)
        self.assertEqual(sales["previous"]["sessions"], 4)
        self.assertEqual(sales["change"]["sessions"], {"abs": 4, "pct": 100.0})
        self.assertEqual(by_label(r)["Stores"]["sessions"], 1)
        self.assertEqual(by_label(r)["Admin"]["punches"], 0)

    def test_units(self):
        r = self.api("departments", by="unit")
        self.assertEqual([(x["label"], x["sessions"]) for x in r["rows"]], [("Unit 1", 8), ("Unit 2", 2)])

    def test_staff_and_production(self):
        r = self.api("departments", by="type")
        self.assertEqual([(x["label"], x["sessions"]) for x in r["rows"]], [("Production", 6), ("Staff", 4)])

    def test_groups_nobody_went_out_from_are_left_out(self):
        # G has no department and no unit and never goes out: no "No department" row, no "No unit" row
        self.assertNotIn("No department", by_label(self.api("departments")))
        self.assertNotIn("No unit", by_label(self.api("departments", by="unit")))
        r = self.api("departments", by="unit", branch="Unit 1")
        self.assertEqual([(x["label"], x["sessions"]) for x in r["rows"]], [("Unit 1", 8)])
        self.assertEqual(by_label(self.api("departments"))["Admin"]["headcount"], 1)

    def test_the_overall_average(self):
        a = self.api("departments")["average"]
        self.assertEqual((a["sessions"], a["people"]), (10, 6))
        self.assertEqual(a["sessionsPerPerson"], 1.7)
        self.assertEqual(a["participationPct"], 83.3)

    def test_small_samples_are_marked(self):
        r = by_label(self.api("departments"))
        self.assertFalse(r["Sales"]["lowSample"])
        self.assertTrue(r["Stores"]["lowSample"])

    def test_lists_are_capped_and_say_so(self):
        r = self.api("departments", limit=2)
        self.assertEqual((len(r["rows"]), r["total"], r["truncated"]), (2, 3, True))
        self.assertEqual(len(self.api("departments", limit=500)["rows"]), 3)  # clamped to the maximum

    def test_a_bad_grouping_is_a_readable_error(self):
        r = self.get("/api/md/geo/departments", **P, by="planet")
        self.assertEqual(r.status_code, 400)
        self.assertIn("'by' must be one of", r.json()["error"])
        r = self.get("/api/md/geo/departments", **P, limit="many")
        self.assertEqual(r.status_code, 400)


class PeopleTests(GoldenBase):
    def test_who_goes_out_most(self):
        r = self.api("people")
        self.assertEqual([x["employeeCode"] for x in r["rows"]], ["A", "B", "D", "C", "E", "F"])
        a, b, d = r["rows"][0], r["rows"][1], r["rows"][2]
        self.assertEqual((a["sessions"], a["daysOut"], a["lastDate"]), (3, 3, "2026-09-04"))
        self.assertEqual((a["rejectedSessions"], a["punches"], a["rejectedPunches"]), (2, 5, 1))
        self.assertEqual(
            (b["sessions"], b["punches"], b["mockedPunches"], b["farPunches"], b["oddPunches"]), (2, 4, 2, 1, 2)
        )
        self.assertEqual((d["punches"], d["oddPunches"], d["farPunches"]), (3, 1, 0))
        self.assertEqual(a["employeeName"], "Asha Test")
        self.assertEqual((a["department"], a["unit"], a["type"]), ("Sales", "Unit 1", "Staff"))
        self.assertEqual((r["total"], r["frequent"], r["frequentMin"]), (6, 0, 5))

    def test_the_threshold_is_a_parameter(self):
        r = self.api("people", min=2)
        self.assertEqual([x["employeeCode"] for x in r["rows"]], ["A", "B", "D"])
        self.assertEqual(r["threshold"], 2)
        self.assertEqual(self.api("people", min=4)["rows"], [])

    def test_the_list_is_capped(self):
        r = self.api("people", limit=2)
        self.assertEqual((len(r["rows"]), r["total"], r["truncated"]), (2, 6, True))

    def test_frequent_means_five_sessions_or_more(self):
        for day in range(8, 13):  # five more sessions for C in September: six in all
            make_session(self.C, ist(9, day, 9), OnDutySession.STATUS_COMPLETED)
        r = self.api("people")
        self.assertEqual(r["rows"][0]["employeeCode"], "C")
        self.assertTrue(r["rows"][0]["frequent"])
        self.assertEqual(r["frequent"], 1)

    def test_nobody_out_is_an_empty_list_with_a_note(self):
        r = self.get("/api/md/geo/people", **{"from": "2026-07-01", "to": "2026-07-05"}).json()
        self.assertEqual((r["rows"], r["total"]), ([], 0))
        self.assertIn("Nobody went on duty", " ".join(r["notes"]))


class ReachTests(GoldenBase):
    def test_punches_by_distance_from_the_unit(self):
        r = self.api("reach")
        bands = {b["key"]: b for b in r["bands"]}
        self.assertEqual(
            {k: b["punches"] for k, b in bands.items()},
            {
                "at_unit": 1,  # pc1
                "upto_2": 2,  # pb1 pb2 (1 km)
                "upto_10": 5,  # pa1 pa2 pa4 pa5 pf1 (5 km)
                "upto_50": 1,  # pa3 (30 km)
                "upto_100": 1,  # pb3 (75 km)
                "beyond": 1,  # pb4 (250 km)
                "unknown": 3,  # pd1 pd2 pd3: Unit 2 has no location
            },
        )
        self.assertEqual(sum(b["punches"] for b in r["bands"]), r["punches"])
        self.assertEqual(r["punches"], 14)
        self.assertEqual(bands["upto_10"]["sharePct"], 35.7)
        self.assertEqual(bands["upto_10"]["people"], 2)  # A and F
        self.assertEqual((r["farPunches"], r["farPeople"], r["unknownPunches"], r["farKm"]), (1, 1, 3, 100.0))
        self.assertEqual(r["farthestKm"], round(haversine_distance_m(LAT0 + LAT_250KM, LNG0, LAT0, LNG0) / 1000, 1))
        self.assertIn("no location set", " ".join(r["notes"]))

    def test_the_bands_are_named_for_the_reader(self):
        labels = [b["label"] for b in self.api("reach")["bands"]]
        self.assertEqual(
            labels,
            [
                "At the unit",
                "Up to 2 km",
                "2 to 10 km",
                "10 to 50 km",
                "50 to 100 km",
                "Over 100 km",
                "Unit has no location",
            ],
        )

    def test_a_punch_inside_the_radius_is_at_the_unit_and_one_just_outside_is_not(self):
        s = self.sessions["s6"]
        # 150 m north of the centre (inside the 200 m radius) and 250 m (outside it)
        make_punch(s, date(2026, 9, 9), 9, 0, 1, LAT0 + 0.00135, OnDutyPunchVerification.STATUS_PENDING)
        make_punch(s, date(2026, 9, 9), 10, 0, 2, LAT0 + 0.00225, OnDutyPunchVerification.STATUS_PENDING)
        bands = {b["key"]: b["punches"] for b in self.api("reach")["bands"]}
        self.assertEqual((bands["at_unit"], bands["upto_2"]), (2, 3))

    def test_a_unit_with_no_radius_uses_the_default(self):
        Branch.objects.filter(pk=self.u1.pk).update(geofence_radius_m=None)
        s = self.sessions["s6"]
        make_punch(s, date(2026, 9, 9), 9, 0, 1, LAT0 + 0.00135, OnDutyPunchVerification.STATUS_PENDING)  # 150 m
        bands = {b["key"]: b["punches"] for b in self.api("reach")["bands"]}
        self.assertEqual(bands["at_unit"], 2)  # the default radius is 200 m


# ═════════════════════════════════════════════════════════════════════════════════════════════════════════════════
# unusual
# ═════════════════════════════════════════════════════════════════════════════════════════════════════════════════


class UnusualTests(GoldenBase):
    def test_the_counts_of_each_reason(self):
        c = self.api("unusual")["counts"]
        self.assertEqual(
            c,
            {
                "sessionsFlagged": 6,
                "mockedSessions": 2,  # s4 s5
                "farSessions": 1,  # s5
                "oddSessions": 3,  # s4 s5 s10
                "longSessions": 3,  # s5 (open 10 days) s6 (16.5 h) s7 (open)
                "staleSessions": 2,  # s5 s7: still open from an earlier day
                "rejectedPunchSessions": 1,  # s3
                "repeatRejectedPeople": 1,  # A
            },
        )

    def test_the_sessions_listed_worst_first_with_their_reasons(self):
        rows = self.api("unusual")["rows"]
        ids = {name: s.id for name, s in self.sessions.items()}
        self.assertEqual(
            [r["sessionId"] for r in rows],
            [ids["s5"], ids["s4"], ids["s7"], ids["s6"], ids["s3"], ids["s10"]],
        )
        self.assertEqual(
            [r["severity"] for r in rows], ["critical", "critical", "warning", "warning", "warning", "info"]
        )
        s5 = rows[0]
        self.assertEqual([x["code"] for x in s5["reasons"]], ["mocked", "far", "odd", "long", "stale"])
        self.assertEqual((s5["employeeCode"], s5["employeeName"], s5["date"]), ("B", "Babu Test", "2026-09-05"))
        self.assertIn("1 punch", s5["reasons"][0]["label"])
        self.assertIn("farthest 250 km", s5["reasons"][1]["label"])
        s6 = rows[3]
        self.assertEqual([x["code"] for x in s6["reasons"]], ["long"])
        self.assertIn("16.5 h", s6["reasons"][0]["label"])

    def test_a_voided_punch_is_not_a_rejection_by_hr(self):
        rows = {r["sessionId"]: r for r in self.api("unusual")["rows"]}
        self.assertNotIn(self.sessions["s2"].id, rows)  # its punch was voided with the request
        self.assertIn(self.sessions["s3"].id, rows)  # HR rejected pa4 on its own

    def test_repeated_rejections(self):
        r = self.api("unusual")["repeatRejected"]
        self.assertEqual(len(r), 1)
        self.assertEqual(
            (r[0]["employeeCode"], r[0]["rejectedSessions"], r[0]["rejectedPunches"], r[0]["rejections"]),
            ("A", 2, 1, 3),
        )

    def test_one_rejection_is_not_repeated(self):
        OnDutySession.objects.filter(pk=self.sessions["s2"].pk).update(status=OnDutySession.STATUS_COMPLETED)
        self.assertEqual(self.api("unusual")["counts"]["repeatRejectedPeople"], 1)  # s3 + pa4 are still two
        # a punch voided with its request is not a second rejection
        OnDutyPunchVerification.objects.filter(hr_review_comment="Photo unclear").update(hr_review_comment=VOID)
        self.assertEqual(self.api("unusual")["counts"]["repeatRejectedPeople"], 0)

    def test_the_list_is_capped_but_the_counts_are_not(self):
        r = self.api("unusual", limit=2)
        self.assertEqual((len(r["rows"]), r["truncated"], r["counts"]["sessionsFlagged"]), (2, True, 6))

    def test_the_thresholds_are_stated(self):
        t = self.api("unusual")["thresholds"]
        self.assertEqual(
            t,
            {"longSessionHours": 16, "farKm": 100.0, "oddFromHour": 22, "oddBeforeHour": 5, "repeatMinRejections": 2},
        )
        text = json.dumps(self.api("unusual")["provenance"])
        for fragment in ("16 hours", "100 km", "22:00", "05:00"):
            self.assertIn(fragment, text)

    def test_a_clean_period_says_so(self):
        r = self.get("/api/md/geo/unusual", **{"from": "2026-08-18", "to": "2026-08-31"}).json()
        self.assertEqual((r["rows"], r["repeatRejected"], r["counts"]["sessionsFlagged"]), ([], [], 0))
        self.assertIn("Nothing unusual", " ".join(r["notes"]))

    def test_odd_hours_are_by_the_factory_clock_at_both_ends(self):
        s = self.sessions["s6"]
        for hh, mm, flagged in ((21, 59, 0), (22, 0, 1), (4, 59, 1), (5, 0, 0)):
            OnDutyPunchVerification.objects.filter(session=s).exclude(punch_number=1).delete()
            make_punch(s, date(2026, 9, 10), hh, mm, 2, LAT0, OnDutyPunchVerification.STATUS_PENDING)
            odd = self.api("summary", branch="Unit 1", department="Stores")["metrics"]["oddPunches"]["value"]
            self.assertEqual(odd, flagged, (hh, mm))


# ═════════════════════════════════════════════════════════════════════════════════════════════════════════════════
# live
# ═════════════════════════════════════════════════════════════════════════════════════════════════════════════════


class LiveTests(GoldenBase):
    def test_who_is_on_duty_now(self):
        r = self.api("live")
        self.assertEqual(r["asOf"], "2026-09-15T15:30:00")
        self.assertEqual(
            (r["onDutyNow"], r["leftOpen"], r["awaitingApproval"], r["withSignal"], r["noSignal"]), (2, 2, 2, 1, 1)
        )
        self.assertEqual((r["total"], r["truncated"], r["activeHeadcount"]), (4, False, 6))
        self.assertEqual(r["outPct"], 66.7)  # B E A C of the 6 active employees
        self.assertEqual([x["employeeCode"] for x in r["rows"]], ["B", "E", "A", "C"])  # longest out first

    def test_each_person_out(self):
        rows = {x["employeeCode"]: x for x in self.api("live")["rows"]}
        c = rows["C"]
        self.assertEqual(
            (c["since"], c["minutesOut"], c["stale"], c["approved"]), ("2026-09-15T09:30:00", 360, False, True)
        )
        self.assertEqual((c["punchesToday"], c["pendingPunches"], c["lastPunch"]), (1, 1, "10:00"))
        self.assertEqual((c["tracked"], c["lastSeen"], c["minutesSinceSeen"]), (True, "2026-09-15T15:10:00", 20))
        self.assertEqual(
            c["distanceFromUnitKm"], round(haversine_distance_m(LAT0 + LAT_5KM, LNG0, LAT0, LNG0) / 1000, 1)
        )
        a = rows["A"]
        self.assertEqual((a["approved"], a["stale"], a["minutesSinceSeen"]), (False, False, 90))
        self.assertEqual(a["lastSeen"], "2026-09-15T14:00:00")  # the newest ping, not the 13:00 one
        b, e = rows["B"], rows["E"]
        self.assertEqual((b["stale"], b["approved"], b["lastSeen"], b["tracked"]), (True, True, None, False))
        self.assertEqual((e["stale"], e["approved"]), (True, False))
        self.assertEqual(c["employeeName"], "Chitra Test")
        self.assertEqual(c["destination"], "Site visit")

    def test_a_session_the_employee_ended_is_not_open(self):
        self.assertNotIn("D", [x["employeeCode"] for x in self.api("live")["rows"]])  # s10 was ended

    def test_the_list_is_capped(self):
        with mock.patch.object(geo, "LIVE_MAX", 2):
            r = geo.geo_live(Scope())
        self.assertEqual((len(r["rows"]), r["total"], r["truncated"]), (2, 4, True))

    def test_gps_positions_are_never_returned(self):
        text = json.dumps(self.api("live"))
        for key in ("latitude", "longitude"):
            self.assertNotIn(key, text)
        text = json.dumps(self.api("unusual")) + json.dumps(self.api("people"))
        for key in ("latitude", "longitude"):
            self.assertNotIn(key, text)

    def test_nobody_out_is_a_note_not_an_error(self):
        OnDutySession.objects.update(employee_ended_at=NOW)
        r = self.api("live")
        self.assertEqual((r["rows"], r["onDutyNow"], r["outPct"]), ([], 0, 0.0))
        self.assertIn("Nobody has an open", " ".join(r["notes"]))


# ═════════════════════════════════════════════════════════════════════════════════════════════════════════════════
# the empty database
# ═════════════════════════════════════════════════════════════════════════════════════════════════════════════════


class EmptyDatabaseTests(MdApiTestCase):
    """Nothing in the database: no division by zero, "no data" is null and never 0."""

    def setUp(self):
        super().setUp()
        freeze_clock(self)

    def api(self, name, **params):
        r = self.get(f"/api/md/geo/{name}", **{**P, **params})
        self.assertEqual(r.status_code, 200, r.content)
        return r.json()

    def test_summary(self):
        s = self.api("summary")
        m = s["metrics"]
        for key in ("sessions", "people", "punches", "officePunches", "pendingPunches", "mockedPunches"):
            self.assertEqual((m[key]["value"], m[key]["previous"]), (0, 0), key)
        for key in ("verifiedPct", "rejectedPct", "medianVerifyHours"):
            self.assertIsNone(m[key]["value"], key)
            self.assertIsNone(m[key]["change"], key)
        self.assertIsNone(s["participationPct"])
        self.assertIn("No on-duty sessions", " ".join(s["notes"]))

    def test_every_other_endpoint(self):
        t = self.api("trend")
        self.assertEqual(len(t["points"]), 14)
        self.assertTrue(all(p["sessions"] == 0 and p["punches"] == 0 for p in t["points"]))
        self.assertEqual((t["momentum"]["verdict"], t["busiestDay"]), ("unclear", None))
        v = self.api("verification")
        self.assertEqual(v["punches"]["captured"], 0)
        self.assertIsNone(v["verifiedPct"])
        self.assertEqual((v["backlog"]["pendingPunches"], v["backlog"]["oldestPunchHours"]), (0, None))
        self.assertEqual(self.api("departments")["rows"], [])
        self.assertEqual(self.api("people")["rows"], [])
        r = self.api("reach")
        self.assertEqual((r["punches"], r["farthestKm"]), (0, None))
        self.assertTrue(all(b["sharePct"] is None for b in r["bands"]))
        u = self.api("unusual")
        self.assertEqual((u["rows"], u["repeatRejected"]), ([], []))
        self.assertEqual(self.api("live")["rows"], [])
        self.assertEqual(self.api("attention")["items"], [])
        self.assertIn("No on-duty sessions", self.api("briefing")["text"])

    def test_the_dashboard_pieces(self):
        self.assertEqual(geo.insights(today=TODAY), [])
        h = geo.headline(today=TODAY)
        self.assertEqual([k["id"] for k in h["kpis"]], ["geo.on-duty-now", "geo.sessions", "geo.awaiting-hr"])
        self.assertEqual([k["value"] for k in h["kpis"]], [0, 0, 0])
        self.assertEqual(len(h["kpis"][1]["spark"]), 14)
        self.assertIsNone(h["kpis"][1]["delta"])

    def test_employees_but_nobody_out_show_zero_participation(self):
        branch = Branch.objects.create(name="Unit 1", code="U1")
        Employee.objects.create(employee_code="Z1", first_name="Z", last_name="One", branch=branch)
        s = self.api("summary")
        self.assertEqual((s["headcount"], s["participationPct"]), (1, 0.0))


# ═════════════════════════════════════════════════════════════════════════════════════════════════════════════════
# needs your attention, the plain-English summary and the Dashboard's pieces
# ═════════════════════════════════════════════════════════════════════════════════════════════════════════════════


class ExceptionTests(GoldenBase):
    def items(self):
        # every finding, not only the six the page shows
        return {i["id"]: i for i in geo._exceptions(Scope(), resolve_period(P), limit=20)}

    def test_the_findings_for_the_golden_period_most_severe_first(self):
        items = self.api("attention")["items"]
        self.assertEqual(
            [i["id"] for i in items],
            [
                "geo.backlog",
                "geo.mocked",
                "geo.rejections",
                "geo.stale",
                "geo.far",
                "geo.long",
            ],  # the 7th (odd hours) is cut
        )
        self.assertEqual([i["severity"] for i in items], ["critical", "warning", "warning", "warning", "info", "info"])
        for i in items:
            self.assertEqual(i["page"], "geo-attendance")
            self.assertTrue(i["ask"] and i["title"] and i["detail"])

    def test_each_finding_says_the_number(self):
        items = self.items()
        self.assertEqual(items["geo.backlog"]["title"], "2 punches and 1 request waiting more than 2 days for HR")
        self.assertIn("10.5 days", items["geo.backlog"]["detail"])
        self.assertEqual(items["geo.mocked"]["title"], "2 on-duty punches used a simulated GPS location")
        self.assertIn("1 person", items["geo.mocked"]["detail"])
        self.assertEqual(items["geo.rejections"]["title"], "1 person had 2 or more on-duty rejections")
        self.assertEqual(items["geo.stale"]["title"], "2 on-duty sessions are still open after their day")
        self.assertEqual(items["geo.far"]["title"], "1 on-duty punch was more than 100 km from the unit")
        self.assertEqual(items["geo.long"]["title"], "3 on-duty sessions ran longer than 16 hours")

    def test_a_simulated_location_is_critical_from_three_punches(self):
        make_punch(
            self.sessions["s6"], date(2026, 9, 9), 9, 0, 1, LAT0, OnDutyPunchVerification.STATUS_PENDING, mocked=True
        )
        self.assertEqual(self.items()["geo.mocked"]["severity"], "critical")

    def test_the_backlog_is_critical_only_past_a_week(self):
        OnDutyPunchVerification.objects.filter(status="pending", punch_date=date(2026, 9, 5)).update(
            created_at=ist(9, 12, 10)
        )
        OnDutySession.objects.filter(pk=self.sessions["s7"].pk).update(created_at=ist(9, 12, 10))
        item = self.items()["geo.backlog"]
        self.assertEqual(item["severity"], "warning")  # the oldest has now waited 3.2 days

    def test_slow_verification_needs_enough_decisions(self):
        OnDutyPunchVerification.objects.filter(hr_reviewed_at__isnull=False).exclude(
            hr_review_comment__startswith="Voided"
        ).update(hr_reviewed_at=ist(9, 20, 12))
        self.assertIn("geo.slow", self.items())
        with mock.patch.object(geo, "MIN_DECIDED", 100):
            self.assertNotIn("geo.slow", self.items())

    def test_a_high_rejection_rate_is_flagged(self):
        OnDutyPunchVerification.objects.filter(status="approved").update(
            status="rejected", hr_review_comment="Bad photo"
        )
        item = self.items()["geo.rejection-rate"]
        self.assertEqual(item["severity"], "warning")
        self.assertEqual(item["metric"], "78.6%")  # 11 of 14
        self.assertEqual(item["title"], "78.6% of on-duty punches were rejected")

    def test_a_surge_in_requests_is_news(self):
        for day in range(2, 14):
            make_session(self.G, ist(9, day, 9), OnDutySession.STATUS_COMPLETED)  # 12 more: 22 against 4
        item = self.items()["geo.surge"]
        self.assertEqual((item["severity"], item["metric"]), ("info", "+18"))
        self.assertEqual(item["title"], "On-duty requests rose to 22 from 4")

    def test_a_quiet_period_is_good_news_only_when_there_is_something_to_report(self):
        items = self.get("/api/md/geo/attention", **{"from": "2026-08-18", "to": "2026-08-31"}).json()["items"]
        self.assertEqual(
            [(i["id"], i["severity"]) for i in items], [("geo.backlog", "critical")]
        )  # the backlog is global
        OnDutyPunchVerification.objects.filter(status="pending").delete()
        OnDutySession.objects.filter(status__in=["pending_hod", "pending_hr"]).delete()
        items = self.get("/api/md/geo/attention", **{"from": "2026-08-18", "to": "2026-08-31"}).json()["items"]
        self.assertEqual([(i["id"], i["severity"]) for i in items], [("geo.healthy", "good")])

    def test_the_provenance_states_the_thresholds(self):
        text = json.dumps(self.api("attention")["provenance"])
        for fragment in ("48 hours", "7 days", "2+", "16 hours", "100 km"):
            self.assertIn(fragment, text)


class DashboardPieceTests(GoldenBase):
    def test_insights_are_company_wide_and_at_most_five(self):
        items = geo.insights(today=TODAY)  # the last 30 days to 15-Sep
        self.assertLessEqual(len(items), 5)
        self.assertEqual(items[0]["severity"], "critical")
        self.assertTrue(all(set(i) == {"id", "severity", "title", "detail", "metric", "page", "ask"} for i in items))
        self.assertTrue(all(i["id"].startswith("geo.") and i["page"] == "geo-attendance" for i in items))
        ranks = [{"critical": 0, "warning": 1, "info": 2, "good": 3}[i["severity"]] for i in items]
        self.assertEqual(ranks, sorted(ranks))

    def test_the_headline_cards(self):
        h = geo.headline(today=TODAY)
        k = {x["id"]: x for x in h["kpis"]}
        self.assertEqual(set(k), {"geo.on-duty-now", "geo.sessions", "geo.awaiting-hr"})
        now = k["geo.on-duty-now"]
        self.assertEqual((now["value"], now["format"], now["page"]), (2, "number", "geo-attendance"))
        self.assertEqual(now["sub"], "2 awaiting approval · 1 with no location signal")
        s = k["geo.sessions"]
        # the last 7 complete days (08..14 Sep): s7 and s10; the 7 before (01..07 Sep): eight
        self.assertEqual(s["value"], 2)
        self.assertEqual(s["delta"], {"abs": -6, "pct": -75.0, "good": None})
        self.assertEqual(s["spark"], [0, 3, 2, 1, 1, 1, 0, 1, 0, 0, 0, 0, 0, 1])
        self.assertIn("08 Sep to 14 Sep", s["sub"])
        w = k["geo.awaiting-hr"]
        self.assertEqual(w["value"], 4)
        self.assertEqual(w["sub"], "The oldest has waited 10.5 days")
        self.assertTrue(h["provenance"])

    def test_the_headline_uses_complete_days_only(self):
        # a day later the "last 7 complete days" are 09-09..09-15 (s10, s11 and s13)
        h = geo.headline(today=TODAY + timedelta(days=1))
        k = {x["id"]: x for x in h["kpis"]}
        self.assertEqual(k["geo.sessions"]["value"], 3)  # 09-09..09-15: s10, s11, s13


class PageBriefTests(GoldenBase):
    """The strip above the MD's copy of the page is /api/md/brief/<page id>: this module's headline() and insights()."""

    def test_the_brief_serves_the_headline_cards_and_the_exceptions(self):
        r = self.get("/api/md/brief/geo-attendance")
        self.assertEqual(r.status_code, 200, r.content)
        body = r.json()
        self.assertEqual(body["domain"], "geo")
        self.assertEqual([k["id"] for k in body["kpis"]], ["geo.on-duty-now", "geo.sessions", "geo.awaiting-hr"])
        self.assertEqual(body["kpis"][0]["value"], 2)
        self.assertLessEqual(len(body["insights"]), 5)
        ids = [i["id"] for i in body["insights"]]
        self.assertEqual(ids[0], "geo.backlog")
        self.assertIn("geo.mocked", ids)
        self.assertEqual(body["notes"], [])


class BriefingTests(GoldenBase):
    def test_the_sentences_are_built_from_the_figures(self):
        b = self.api("briefing")
        by_id = {s["id"]: s for s in b["sentences"]}
        self.assertEqual(list(by_id), ["volume", "verification", "where", "unusual", "now"])
        self.assertEqual(
            by_id["volume"]["text"],
            "01 Sep – 14 Sep 2026: 10 on-duty sessions by 6 people (up 150% on the previous 14 days), 14 on-duty "
            "punches and 4 office geo punches.",
        )
        self.assertEqual(
            by_id["verification"]["text"],
            "HR has verified 57% of the on-duty punches, rejected 3, 3 still waiting; HR typically decides in 3.0 hours.",
        )
        self.assertEqual(by_id["verification"]["tone"], "bad")  # two punches wait more than two days
        self.assertEqual(by_id["where"]["text"], "Sales has the most on-duty sessions: 8 (80% of all), by 4 people.")
        self.assertEqual(
            by_id["unusual"]["text"],
            "Worth a look: 2 punches with simulated GPS, 1 punch over 100 km from the unit, 2 sessions left open "
            "past their day, 1 person with repeated rejections.",
        )
        self.assertEqual(
            by_id["now"]["text"],
            "Right now 2 people are on duty (2 awaiting approval, 1 with no location signal).",
        )
        self.assertEqual(b["text"], " ".join(s["text"] for s in b["sentences"]))
        self.assertIn("geo attendance", b["ask"])

    def test_every_figure_in_the_sentences_is_on_the_page(self):
        b = self.api("briefing")
        s = self.api("summary")["metrics"]
        self.assertIn(f"{s['sessions']['value']} on-duty sessions", b["text"])
        self.assertIn(f"{s['punches']['value']} on-duty punches", b["text"])


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
            employee_code="E1", first_name="A", last_name="B", branch=Branch.objects.create(name="HO")
        )
        emp_token = sign_token({"role": "employee", "employeeId": employee.id, "name": "A B"})
        for route in ROUTES:
            url = f"/api/md/geo/{route}"
            self.assertEqual(self.client.get(url, **md_headers(md)).status_code, 200, route)
            self.assertEqual(self.client.get(url, **md_headers(admin)).status_code, 403, route)
            self.assertEqual(self.client.get(url, **md_headers(clerk)).status_code, 403, route)
            self.assertEqual(self.client.get(url, HTTP_AUTHORIZATION=f"Bearer {emp_token}").status_code, 403, route)
            self.assertEqual(self.client.get(url).status_code, 401, route)
            self.assertEqual(self.client.post(url, **md_headers(md)).status_code, 405, route)

    def test_the_md_loses_access_the_moment_the_identity_is_taken_away(self):
        md = make_md()
        url = "/api/md/geo/live"
        self.assertEqual(self.client.get(url, **md_headers(md)).status_code, 200)
        HRUser.objects.filter(pk=md.pk).update(is_md=False)
        self.assertEqual(self.client.get(url, **md_headers(md)).status_code, 403)

    def test_nothing_is_written(self):
        """Every route runs inside the read-only transaction: the database refuses a write."""
        before = (OnDutySession.objects.count(), OnDutyPunchVerification.objects.count())
        md = make_md()
        for route in ROUTES:
            self.client.get(f"/api/md/geo/{route}", **md_headers(md))
        self.assertEqual((OnDutySession.objects.count(), OnDutyPunchVerification.objects.count()), before)


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
        for route in [r for r in ROUTES if r != "live"]:  # the live picture has no period to get wrong
            for params, text in cases:
                r = self.get(f"/api/md/geo/{route}", **params)
                self.assertEqual(r.status_code, 400, (route, params))
                self.assertIn(text, r.json()["error"])
        for params, text in cases[3:]:  # but it does take a unit, a department and a type
            r = self.get("/api/md/geo/live", **params)
            self.assertEqual(r.status_code, 400, params)
            self.assertIn(text, r.json()["error"])

    def test_the_default_period_is_the_last_30_days(self):
        s = self.get("/api/md/geo/summary").json()
        self.assertEqual(s["period"]["preset"], "last_30_days")
        self.assertEqual(s["period"]["days"], 30)


class ToolTests(GoldenBase):
    NAMES = {
        "geo_attendance_summary",
        "geo_attendance_trend",
        "geo_verification_status",
        "geo_attendance_breakdown",
        "geo_frequent_people",
        "geo_unusual_sessions",
        "geo_distance_from_unit",
        "geo_on_duty_now",
    }

    def tool(self, name):
        return registry.collect_tools()[name]

    def test_the_tools_are_registered_and_described_for_the_model(self):
        tools = registry.collect_tools()
        self.assertTrue(self.NAMES <= set(tools))
        self.assertLessEqual(len(self.NAMES), 8)
        for name in self.NAMES:
            spec = tools[name]
            self.assertEqual(spec.page, "geo-attendance")
            self.assertGreaterEqual(len(spec.description), 120, name)
        self.assertIn("period", self.tool("geo_attendance_summary").properties)
        self.assertNotIn("period", self.tool("geo_on_duty_now").properties)
        self.assertIn("branch", self.tool("geo_on_duty_now").properties)

    def test_summary_tool_is_the_same_number_as_the_page(self):
        result = self.tool("geo_attendance_summary").run({"from": P["from"], "to": P["to"]})
        self.assertEqual(result["metrics"]["sessions"]["value"], 10)
        self.assertEqual(result["metrics"]["verifiedPct"]["value"], 57.1)
        self.assertTrue(result["provenance"])
        json.dumps(result)  # plain JSON, no dates or Decimals

    def test_breakdown_tool_groups_by_department_unit_or_type(self):
        spec = self.tool("geo_attendance_breakdown")
        base = {"from": P["from"], "to": P["to"]}
        self.assertEqual(spec.run(base)["by"], "department")
        self.assertEqual(spec.run({**base, "by": "unit"})["by"], "unit")
        self.assertEqual(spec.run({**base, "by": "type", "limit": 1})["rows"][0]["label"], "Production")
        with self.assertRaises(MdParamError):
            spec.run({**base, "by": "planet"})

    def test_frequent_people_tool_names_people_in_the_standard_key(self):
        result = self.tool("geo_frequent_people").run({"from": P["from"], "to": P["to"], "min_sessions": 2})
        self.assertEqual([r["employeeName"] for r in result["rows"]], ["Asha Test", "Babu Test", "Dinesh Test"])
        self.assertNotIn("name", result["rows"][0])

    def test_unusual_tool(self):
        result = self.tool("geo_unusual_sessions").run({"from": P["from"], "to": P["to"], "limit": 3})
        self.assertEqual(len(result["rows"]), 3)
        self.assertEqual(result["counts"]["mockedSessions"], 2)

    def test_verification_distance_and_trend_tools(self):
        v = self.tool("geo_verification_status").run({"from": P["from"], "to": P["to"]})
        self.assertEqual(v["punches"]["pending"], 3)
        d = self.tool("geo_distance_from_unit").run({"from": P["from"], "to": P["to"]})
        self.assertEqual(d["farPunches"], 1)
        t = self.tool("geo_attendance_trend").run({"from": P["from"], "to": P["to"]})
        self.assertEqual(len(t["points"]), 14)

    def test_the_live_tool_takes_no_period(self):
        result = self.tool("geo_on_duty_now").run({"branch": "Unit 1"})
        self.assertEqual(result["onDutyNow"], 2)
        self.assertEqual(self.tool("geo_on_duty_now").run({"branch": "Unit 2"})["rows"], [])

    def test_the_free_text_destination_is_not_sent_to_the_assistant(self):
        """An employee types the destination; it can name people or places, and what the assistant gets leaves the server.
        The MD's page shows it, the tools do not."""
        page = self.api("live")
        self.assertTrue(all("destination" in r for r in page["rows"]))
        tool = self.tool("geo_on_duty_now").run({})
        self.assertEqual([r["employeeCode"] for r in tool["rows"]], [r["employeeCode"] for r in page["rows"]])
        self.assertNotIn("destination", json.dumps(tool))
        unusual = self.tool("geo_unusual_sessions").run({"from": P["from"], "to": P["to"]})
        self.assertTrue(unusual["rows"])
        self.assertNotIn("destination", json.dumps(unusual))
        self.assertIn("destination", json.dumps(self.api("unusual")))

    def test_no_non_person_field_uses_a_name_key(self):
        """The assistant pseudonymises the standard person keys: a department or unit called "name" would be hidden."""
        for name in self.NAMES:
            text = json.dumps(self.tool(name).run({"from": P["from"], "to": P["to"]}))
            for key in ('"name":', '"fullName":', '"userName":', '"visitorName":', '"managerName":'):
                self.assertNotIn(key, text, (name, key))

    def test_every_tool_runs_read_only(self):
        for name in self.NAMES:
            with read_only_db():
                result = self.tool(name).run({"from": P["from"], "to": P["to"]})
            self.assertTrue(result["provenance"], name)


# ═════════════════════════════════════════════════════════════════════════════════════════════════════════════════
# helpers and the query budget
# ═════════════════════════════════════════════════════════════════════════════════════════════════════════════════


class TextHelperTests(SimpleTestCase):
    def test_numbers_use_indian_grouping(self):
        self.assertEqual(geo._num(1234567), "12,34,567")
        self.assertEqual(geo._num(None), "n/a")
        self.assertEqual(geo._p(None), "n/a")
        self.assertEqual(geo._p(57.14, 1), "57.1%")

    def test_waiting_times_are_read_as_hours_or_days(self):
        self.assertEqual(geo._hours_text(5.4), "5.4 hours")
        self.assertEqual(geo._hours_text(251), "10.5 days")
        self.assertEqual(geo._hours_text(None), "n/a")

    def test_a_count_must_be_a_number(self):
        self.assertEqual(geo._int_arg("7", "limit", 10, 1, 25), 7)
        self.assertEqual(geo._int_arg(None, "limit", 10, 1, 25), 10)
        self.assertEqual(geo._int_arg(500, "limit", 10, 1, 25), 25)
        with self.assertRaises(MdParamError):
            geo._int_arg("many", "limit", 10, 1, 25)

    def test_the_far_edge_is_the_last_band_edge(self):
        self.assertEqual(geo.BAND_EDGES_KM[-1], geo.FAR_KM)


class QueryCountTests(TestCase):
    def setUp(self):
        freeze_clock(self)
        self.md = make_md()
        self.unit = Branch.objects.create(name="Unit 1", code="Q1", geofence_lat=LAT0, geofence_lng=LNG0)
        self.depts = [Department.objects.create(name=f"Dept {i}", branch=self.unit) for i in range(6)]
        self.made = 0

    def grow(self, employees: int):
        """Add people with ~3 sessions each (6 punches) on days 1..12 September, pings and office punches."""
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
                    location_tracking_enabled=bool(self.made % 2),
                )
            )
        Employee.objects.bulk_create(people)
        people = list(Employee.objects.filter(employee_code__startswith="Q").order_by("id"))[-employees:]
        sessions = []
        for i, e in enumerate(people):
            for k in range(3):
                day = 1 + (i + k * 4) % 12
                status = (
                    OnDutySession.STATUS_PENDING_HR,
                    OnDutySession.STATUS_COMPLETED,
                    OnDutySession.STATUS_REJECTED,
                )[(i + k) % 3]
                sessions.append(OnDutySession(employee=e, destination=f"Site {k}", branch=self.unit, status=status))
        OnDutySession.objects.bulk_create(sessions)
        made = list(OnDutySession.objects.filter(employee__in=people))
        for i, s in enumerate(made):
            s.created_at = ist(9, 1 + i % 12, 9)
        OnDutySession.objects.bulk_update(made, ["created_at"])
        punches, pings, logs = [], [], []
        for i, s in enumerate(made):
            day = date(2026, 9, 1 + i % 12)
            for n in (1, 2):
                punches.append(
                    OnDutyPunchVerification(
                        session=s,
                        employee=s.employee,
                        punch_date=day,
                        punch_time=dtime(9 + 6 * (n - 1) + i % 3, 0),
                        punch_type="IN" if n == 1 else "OUT",
                        punch_number=n,
                        latitude=LAT0 + 0.01 * (i % 40),
                        longitude=LNG0,
                        photo="x.jpg",
                        is_mocked=(i % 17 == 0),
                        status=("pending", "approved", "rejected")[i % 3],
                        hr_reviewed_at=NOW if i % 3 else None,
                    )
                )
        OnDutyPunchVerification.objects.bulk_create(punches)
        for i, e in enumerate(people):
            pings.append(LiveLocationPing(employee=e, latitude=LAT0 + 0.05, longitude=LNG0))
            logs.append(
                AttendanceLog(
                    employee=e,
                    date=date(2026, 9, 1 + i % 12),
                    punch_time=dtime(8, 50),
                    punch_type="IN",
                    source="geo:auto",
                )
            )
        LiveLocationPing.objects.bulk_create(pings)
        AttendanceLog.objects.bulk_create(logs)
        OnDutySession.objects.filter(employee__in=people[::2]).update(status=OnDutySession.STATUS_ACTIVE)

    def count(self, name, **params):
        with CaptureQueriesContext(connection) as ctx:
            r = self.client.get(f"/api/md/geo/{name}", {**P, **params}, **md_headers(self.md))
        self.assertEqual(r.status_code, 200, r.content)
        return len(ctx)

    ENDPOINTS = [
        ("summary", {}),
        ("briefing", {}),
        ("trend", {}),
        ("verification", {}),
        ("departments", {}),
        ("departments", {"by": "unit"}),
        ("departments", {"by": "type"}),
        ("people", {"limit": 25}),
        ("reach", {}),
        ("unusual", {"limit": 25}),
        ("live", {}),
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
            geo.insights(today=TODAY)
            geo.headline(today=TODAY)
        self.grow(60)
        with CaptureQueriesContext(connection) as large_ctx:
            geo.insights(today=TODAY)
            geo.headline(today=TODAY)
        self.assertEqual(len(small_ctx), len(large_ctx))

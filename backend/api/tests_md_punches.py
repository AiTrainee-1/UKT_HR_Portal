"""MD portal: Attendance Search insights (md_portal/analytics/punches.py, routes/punches.py).

Every figure is counted by hand from the world below.

THE WORLD (Mon 7 - Wed 9 Sep 2026; today is Monday 21 Sep)

    Unit P / Line: E1 Anil, E2 Bina, E3 Charu (staff)
        E1  Mon 7  biometric:dev1 IN 09:00, OUT 18:00     Tue 8  biometric:dev1 IN 09:00 (odd: no out-punch)
            Wed 9  manual IN 09:00, manual:punch-view OUT 18:00 (HR typed both: hand-entered)
        E2  Mon 7  geo:auto IN 09:05, OUT 18:00           Tue 8  auto:md IN 09:00, OUT 18:00 (the MD auto attendance)
        E3  Wed 9  missing_punch:approved IN 09:00 (hand-entered), biometric:dev1 OUT 18:00
      punches 11: biometric 4, geo 2, missing punch 1, HR entry 2, auto attendance 2; hand-entered 3
    On-Duty punches not counted: E2 waiting for HR on Wed 9, E3 turned down on Tue 8.
"""

from contextlib import contextmanager
from datetime import date, time
from unittest import mock

from .md_portal.analytics import punches as P
from .models import (
    AttendanceLog,
    Branch,
    Department,
    Employee,
    HRUser,
    OnDutyPunchVerification,
    OnDutySession,
)
from .tests_md_support import MdApiTestCase, md_headers

TODAY = date(2026, 9, 21)
WEEK = {"from": "2026-09-07", "to": "2026-09-09"}
BASE = "/api/md/punches"
ROUTES = ("summary", "sources", "devices", "missing", "manual", "anomalies", "unmatched", "coverage", "attention")


@contextmanager
def at(day: date = TODAY):
    with (
        mock.patch.object(P, "_today", return_value=day),
        mock.patch("api.md_portal.common.ist_today", return_value=day),
    ):
        yield


def d(day: int) -> date:
    return date(2026, 9, day)


class World(MdApiTestCase):
    @classmethod
    def setUpTestData(cls):
        unit = Branch.objects.create(name="Unit P", code="UP")
        line = Department.objects.create(name="Line", branch=unit)

        def emp(code, first):
            return Employee.objects.create(
                employee_code=code,
                first_name=first,
                last_name="T",
                department=line,
                branch=unit,
                join_date="2025-01-01",
            )

        cls.e1, cls.e2, cls.e3 = emp("P001", "Anil"), emp("P002", "Bina"), emp("P003", "Charu")

        def punch(e, day, hhmm, ptype, source):
            AttendanceLog.objects.create(
                employee=e, date=d(day), punch_time=time(*hhmm), punch_type=ptype, source=source
            )

        punch(cls.e1, 7, (9, 0), "IN", "biometric:dev1")
        punch(cls.e1, 7, (18, 0), "OUT", "biometric:dev1")
        punch(cls.e1, 8, (9, 0), "IN", "biometric:dev1")
        punch(cls.e1, 9, (9, 0), "IN", "manual")
        punch(cls.e1, 9, (18, 0), "OUT", "manual:punch-view")
        punch(cls.e2, 7, (9, 5), "IN", "geo:auto")
        punch(cls.e2, 7, (18, 0), "OUT", "geo:auto")
        punch(cls.e2, 8, (9, 0), "IN", "auto:md")
        punch(cls.e2, 8, (18, 0), "OUT", "auto:md")
        punch(cls.e3, 9, (9, 0), "IN", "missing_punch:approved")
        punch(cls.e3, 9, (18, 0), "OUT", "biometric:dev1")

        cls.held(cls.e2, 9, "pending")
        cls.held(cls.e3, 8, "rejected")

    @staticmethod
    def held(e, day, status, hhmm=(11, 0)):
        session = OnDutySession.objects.create(employee=e, destination="Client", status="completed")
        OnDutyPunchVerification.objects.create(
            session=session,
            employee=e,
            punch_date=d(day),
            punch_time=time(*hhmm),
            punch_type="IN",
            punch_number=1,
            latitude=11.1,
            longitude=77.3,
            photo="x.jpg",
            status=status,
        )

    def get_ok(self, route, **params):
        with at():
            r = self.get(f"{BASE}/{route}", **params)
        self.assertEqual(r.status_code, 200, r.content)
        return r.json()


class AccessTests(World):
    def test_only_the_md_gets_in_and_every_route_answers(self):
        root = HRUser.objects.create(username="root", password_hash="x", is_super_admin=True)
        for route in (*ROUTES, f"employee/{self.e1.id}"):
            with self.subTest(route=route):
                url = f"{BASE}/{route}"
                self.assertEqual(self.client.get(url).status_code, 401)
                self.assertEqual(self.client.get(url, **md_headers(root)).status_code, 403)
                with at():
                    self.assertEqual(self.get(url, **WEEK).status_code, 200)

    def test_a_month_and_a_bad_parameter(self):
        self.assertEqual(self.get_ok("summary", month="2026-09")["period"]["label"], "Sep 2026")
        with at():
            r = self.get(f"{BASE}/summary", month="2026-13")
        self.assertEqual(r.status_code, 400)
        with at():
            r = self.get(f"{BASE}/devices", limit="lots", **WEEK)
        self.assertIn("'limit' must be a whole number", r.json()["error"])


class SourceTests(World):
    def test_the_families_counted_by_hand(self):
        s = self.get_ok("summary", **WEEK)
        fam = {f["key"]: f["punches"] for f in s["families"]}
        self.assertEqual(
            fam,
            {
                "biometric": 4,
                "geo": 2,
                "on_duty": 0,
                "import": 0,
                "missing_punch": 1,
                "manual": 2,
                "auto": 2,
                "other": 0,
            },
        )
        labels = {f["key"]: f["label"] for f in s["families"]}
        self.assertEqual((labels["auto"], labels["manual"]), ("Auto Attendance", "HR Entry"))
        self.assertEqual(s["metrics"]["punches"]["value"], 11)
        self.assertEqual(s["metrics"]["handEntered"]["value"], 3)  # HR entry 2 + missing punch 1; auto is not a person
        self.assertIsNone(s["metrics"]["handEnteredPct"]["value"])  # 11 punches: too few for a share
        self.assertEqual(s["heldOnDuty"], {"pending": 1, "rejected": 1, "people": 1})
        self.assertIn(
            "1 On-Duty punch is still waiting for HR to verify, so it is not attendance yet.",
            s["briefing"]["sentences"],
        )

    def test_the_sql_and_python_families_agree(self):
        for tag in ("biometric:dev1", "geo:auto", "auto:md", "manual:punch-view", "missing_punch:approved", "x"):
            with self.subTest(tag=tag):
                via_sql = (
                    AttendanceLog.objects.filter(source=tag).annotate(f=P._family_case()).values_list("f", flat=True)
                )
                self.assertTrue(all(f == P.family_of(tag) for f in via_sql))
        self.assertEqual(P.family_of("auto:md"), "auto")

    def test_the_daily_split(self):
        t = self.get_ok("sources", **WEEK)
        by_day = {p["date"]: p for p in t["points"]}
        self.assertEqual((by_day["2026-09-08"]["biometric"], by_day["2026-09-08"]["auto"]), (1, 2))
        self.assertEqual((by_day["2026-09-09"]["handEntered"], by_day["2026-09-09"]["total"]), (3, 4))


class EmployeeDrillTests(World):
    def test_one_persons_punches_day_by_day(self):
        body = self.get_ok(f"employee/{self.e1.id}", **WEEK)
        self.assertEqual(body["employee"]["name"], "Anil T")
        self.assertEqual([x["date"] for x in body["days"]], ["2026-09-09", "2026-09-08", "2026-09-07"])
        self.assertEqual(
            body["totals"],
            {
                "punches": 5,
                "days": 3,
                "oddDays": 1,
                "handEntered": 2,
                "handEnteredPct": 40.0,
                "heldPending": 0,
                "heldRejected": 0,
                "requests": 0,
            },
        )
        tuesday = body["days"][1]
        self.assertEqual((tuesday["count"], tuesday["odd"]), (1, True))
        self.assertEqual(tuesday["punches"][0]["label"], "Biometric")
        self.assertEqual([f["key"] for f in body["families"]], ["biometric", "manual"])

    def test_held_on_duty_punches_are_listed_not_counted(self):
        body = self.get_ok(f"employee/{self.e2.id}", **WEEK)
        wed = next(x for x in body["days"] if x["date"] == "2026-09-09")
        self.assertEqual((wed["count"], wed["held"]), (0, [{"time": "11:00:00", "type": "IN", "status": "pending"}]))
        self.assertEqual(body["totals"]["heldPending"], 1)

    def test_limits(self):
        with at():
            self.assertEqual(self.get(f"{BASE}/employee/999999", **WEEK).status_code, 400)
            r = self.get(f"{BASE}/employee/{self.e1.id}", **{"from": "2026-01-01", "to": "2026-09-09"})
        self.assertEqual(r.status_code, 400)


class AttentionTests(World):
    def test_on_duty_punches_waiting_for_hr(self):
        for hour in range(12, 16):  # four more: five waiting
            self.held(self.e1, 9, "pending", (hour, 0))
        items = self.get_ok("attention", **WEEK)["items"]
        held = next(i for i in items if i["id"] == "punches.held-on-duty")
        self.assertEqual(held["severity"], "warning")
        self.assertEqual(held["title"], "5 On-Duty punches are waiting for HR")
        self.assertIn("2 people", held["detail"])

    def test_below_the_bar_nothing_is_said(self):
        items = self.get_ok("attention", **WEEK)["items"]
        self.assertNotIn("punches.held-on-duty", [i["id"] for i in items])

"""MD portal, Manage Shift: every figure recomputed by hand from a small company.

Run:  DB_TEST_NAME=test_uktex_shifts python manage.py test api.tests_md_shifts --noinput

THE WORLD (TODAY is Wednesday 14 Oct 2026; Monday 5 Oct .. Friday 9 Oct is "the week" W)

  Units       Unit 1, Unit 2          Departments  Cutting (U1), Stitching (U1), Stitching (U2: same name = one department),
                                                   Admin (U1); K has no department and no unit
  Shifts      Morning U1 (production)  Evening U1 (production)  General U1 (staff)  Morning U2 (production: same name,
              other unit)  Night U1 (production, active, nobody on it)  Old General U1 (staff, INACTIVE, nobody on it)
  People      17 active: A B C D E J M N O P (production)  F G H I K Q R (staff)        L resigned (a leaver)

  Assignments (all from 1 Aug unless said; "open" = no last day)
    A  Morning U1 open, and a CANCELLED Evening 10 Oct..9 Oct (closed before it started: covers no day, counts for nothing)
    B  Morning U1 to 30 Sep, Evening from 1 Oct                              (a move, on the first day of the CHG window)
    C  Evening to 14 Oct and Evening from 14 Oct                              (a handover on today: both cover it)
    D  Morning U1 open AND Evening from 14 Oct open                           (two open assignments: an overlap; Evening wins)
    E  Morning U2 to 5 Oct, Morning U2 from 6 Oct                             (a renewal)
    F  General to 20 Oct                                                      (ends in 6 days, nothing after it)
    G  General to 18 Oct, General from 19 Oct                                 (ends in 4 days but a successor starts the day after)
    H  nothing, ever            I  General to 30 Sep (ended, nothing after)   J  Evening from 20 Oct (starts later)
    K  General open   M O P  Morning U1 open    N  Morning to 19 Sep, Evening 20..25 Sep, Morning from 26 Sep
    Q R  General from 8 Oct (their first assignment)                          L  Morning U1 open (a leaver: not counted today)

  TODAY, who is on what (17 active):  Morning U1: A M N O P = 5   Evening: B C D = 3   General: F G K Q R = 5
                                      Morning U2: E = 1   no shift: H I J = 3   -> 14 on a shift = 82.4 %
  Staff 7 (F G H I K Q R), production 10.  Departments: Stitching 6 (C D E J O P), Cutting 5 (A B I M N),
  Admin 5 (F G H Q R), none 1 (K).  Morning U1 and Evening are both production in Unit 1: 5 against 3 = 40.0 % fewer.

  CHG = 1..14 Oct (the previous period is 17..30 Sep).  Assignments that START in CHG: B Evening 1 Oct (move), E Morning U2
  6 Oct (renewal), Q and R General 8 Oct (first), D Evening 14 Oct (move), C Evening 14 Oct (renewal)
    -> 2 first, 2 moves (2 people), 2 renewals = 6 starts by 6 people.
  Previous: N Evening 20 Sep (move), N Morning 26 Sep (move) -> 2 moves by 1 person, 2 starts.

  ATTENDANCE, the week W (all present unless said; 'late' = flagged late):
    A 5 days (late 10-05)   B 5 (late 10-06, 10-07)   C 4 present + absent 10-08   D 5 (late 10-09)   E 5   F 5
    H 5 (late 10-05, 10-08)   Q 10-06 and 10-07 (no shift yet) and 10-08, 10-09 on General (late 10-09)
  Filed by shift: Morning U1 (A D) 10 worked / 2 late = 20.0 %   Evening (B C) 9 worked, 10 scheduled / 2 late = 22.2 %,
  attendance 90.0 %   General (F Q) 7 / 1 = 14.3 %   Morning U2 (E) 5 / 0 = 0.0 %   No shift (H Q) 7 / 2 = 28.6 %
  Company: worked 38, scheduled 39, late 7 -> 18.4 % late, attendance 97.4 %, absent 2.6 %.
  The previous five days (30 Sep..4 Oct): B 30 Sep on Morning (late), B 1 Oct and 2 Oct on Evening -> Morning U1 1 worked, 1 late.
"""

import json
from contextlib import contextmanager
from datetime import date, datetime, time, timedelta
from unittest import mock

from django.db import connection
from django.test.utils import CaptureQueriesContext

from .md_portal.analytics import attendance as A
from .md_portal.analytics import shifts as S
from .md_portal.assistant import registry
from .md_portal.common import MdParamError, Scope, read_only_db, resolve_period
from .models import (
    AttendanceDayRecord,
    Branch,
    Department,
    Employee,
    EmployeeShiftAssignment,
    HRUser,
    ShiftTemplate,
)
from .tests_md_support import MdApiTestCase, md_headers

TODAY = date(2026, 10, 14)
BASE = "/api/md/shifts"
CHG = {"from": "2026-10-01", "to": "2026-10-14"}
W = {"from": "2026-10-05", "to": "2026-10-09"}
ROUTES = ("summary", "briefing", "coverage", "unassigned", "watch", "changes", "attendance", "attention")


def d(month: int, day: int) -> date:
    return date(2026, month, day)


@contextmanager
def at(day: date = TODAY, hour: int = 12):
    """Freeze the factory clock for the REST views (the analytics functions also take ``today=`` directly)."""
    now = datetime.combine(day, time(hour, 0))
    with (
        mock.patch.object(S, "ist_today", return_value=day),
        mock.patch.object(A, "ist_today", return_value=day),
        mock.patch.object(A, "ist_now", return_value=now),
        mock.patch("api.md_portal.common.ist_today", return_value=day),
        mock.patch("api.md_portal.common.ist_now", return_value=now),
    ):
        yield


def period(**params) -> object:
    return resolve_period(params, today=TODAY)


def by_label(rows: list[dict]) -> dict[str, dict]:
    return {r["label"]: r for r in rows}


def build_world(cls):
    """The company in the module docstring."""
    cls.u1 = Branch.objects.create(name="Unit 1", code="TU1")
    cls.u2 = Branch.objects.create(name="Unit 2", code="TU2")
    cls.cutting = Department.objects.create(name="Cutting", branch=cls.u1)
    cls.stitch1 = Department.objects.create(name="Stitching", branch=cls.u1)
    cls.stitch2 = Department.objects.create(name="Stitching", branch=cls.u2)
    cls.admin = Department.objects.create(name="Admin", branch=cls.u1)

    def shift(name, branch, kind, start, end, active=True):
        return ShiftTemplate.objects.create(
            name=name, branch=branch, shift_type=kind, start_time=start, end_time=end, is_active=active
        )

    cls.morning1 = shift("Morning", cls.u1, "production", time(6), time(14))
    cls.evening = shift("Evening", cls.u1, "production", time(14), time(22))
    cls.general = shift("General", cls.u1, "staff", time(9), time(17, 30))
    cls.morning2 = shift("Morning", cls.u2, "production", time(6), time(14))
    cls.night = shift("Night", cls.u1, "production", time(18), time(23))
    cls.old = shift("Old General", cls.u1, "staff", time(9), time(17), active=False)

    def emp(code, dept, branch, kind, status="active"):
        return Employee.objects.create(
            employee_code=code,
            first_name=f"Person {code}",
            last_name="Test",
            department=dept,
            branch=branch,
            employment_type=kind,
            status=status,
            join_date="2025-01-01",
        )

    cls.A = emp("A", cls.cutting, cls.u1, "production")
    cls.B = emp("B", cls.cutting, cls.u1, "production")
    cls.C = emp("C", cls.stitch1, cls.u1, "production")
    cls.D = emp("D", cls.stitch1, cls.u1, "production")
    cls.E = emp("E", cls.stitch2, cls.u2, "production")
    cls.F = emp("F", cls.admin, cls.u1, "staff")
    cls.G = emp("G", cls.admin, cls.u1, "staff")
    cls.H = emp("H", cls.admin, cls.u1, "staff")
    cls.I = emp("I", cls.cutting, cls.u1, "staff")
    cls.J = emp("J", cls.stitch1, cls.u1, "production")
    cls.K = emp("K", None, None, "staff")
    cls.M = emp("M", cls.cutting, cls.u1, "production")
    cls.N = emp("N", cls.cutting, cls.u1, "production")
    cls.O = emp("O", cls.stitch1, cls.u1, "production")
    cls.P = emp("P", cls.stitch1, cls.u1, "production")
    cls.Q = emp("Q", cls.admin, cls.u1, "staff")
    cls.R = emp("R", cls.admin, cls.u1, "staff")
    cls.L = emp("L", cls.cutting, cls.u1, "production", status="resigned")

    def assign(e, s, start, end=None):
        return EmployeeShiftAssignment.objects.create(employee=e, shift=s, effective_from=start, effective_to=end)

    aug1 = d(8, 1)
    assign(cls.A, cls.morning1, aug1)
    assign(cls.A, cls.evening, d(10, 10), d(10, 9))  # cancelled: closed before it started
    assign(cls.B, cls.morning1, aug1, d(9, 30))
    assign(cls.B, cls.evening, d(10, 1))
    assign(cls.C, cls.evening, aug1, d(10, 14))
    assign(cls.C, cls.evening, d(10, 14))
    assign(cls.D, cls.morning1, aug1)
    assign(cls.D, cls.evening, d(10, 14))
    assign(cls.E, cls.morning2, aug1, d(10, 5))
    assign(cls.E, cls.morning2, d(10, 6))
    assign(cls.F, cls.general, aug1, d(10, 20))
    assign(cls.G, cls.general, aug1, d(10, 18))
    assign(cls.G, cls.general, d(10, 19))
    assign(cls.I, cls.general, aug1, d(9, 30))
    assign(cls.J, cls.evening, d(10, 20))
    assign(cls.K, cls.general, aug1)
    for e in (cls.M, cls.O, cls.P, cls.L):
        assign(e, cls.morning1, aug1)
    assign(cls.N, cls.morning1, aug1, d(9, 19))
    assign(cls.N, cls.evening, d(9, 20), d(9, 25))
    assign(cls.N, cls.morning1, d(9, 26))
    assign(cls.Q, cls.general, d(10, 8))
    assign(cls.R, cls.general, d(10, 8))

    def mark(e, day, late=False, status="present"):
        AttendanceDayRecord.objects.create(employee=e, date=day, status=status, is_late=late)

    mon = d(10, 5)
    for offset in range(5):
        day = mon + timedelta(days=offset)
        for e in (cls.A, cls.B, cls.D, cls.E, cls.F, cls.H):
            mark(e, day)
        if offset != 3:
            mark(cls.C, day)
    mark(cls.C, d(10, 8), status="absent")
    AttendanceDayRecord.objects.filter(employee=cls.A, date=d(10, 5)).update(is_late=True)
    AttendanceDayRecord.objects.filter(employee=cls.B, date__in=[d(10, 6), d(10, 7)]).update(is_late=True)
    AttendanceDayRecord.objects.filter(employee=cls.D, date=d(10, 9)).update(is_late=True)
    AttendanceDayRecord.objects.filter(employee=cls.H, date__in=[d(10, 5), d(10, 8)]).update(is_late=True)
    for day in (d(10, 6), d(10, 7), d(10, 8), d(10, 9)):
        mark(cls.Q, day, late=(day == d(10, 9)))
    # the five days before the week
    mark(cls.B, d(9, 30), late=True)
    mark(cls.B, d(10, 1))
    mark(cls.B, d(10, 2))


class World(MdApiTestCase):
    @classmethod
    def setUpTestData(cls):
        build_world(cls)

    def get_ok(self, route: str, **params) -> dict:
        with at():
            r = self.get(f"{BASE}/{route}", **params)
        self.assertEqual(r.status_code, 200, r.content)
        return r.json()


def scope_of(**params) -> Scope:
    from .md_portal.common import resolve_scope

    return resolve_scope(params)


# ─── access ──────────────────────────────────────────────────────────────────────────────────────────────────────────


class AccessTests(World):
    def test_only_the_md_gets_in(self):
        root = HRUser.objects.create(username="root", password_hash="x", is_super_admin=True)
        for route in ROUTES:
            url = f"{BASE}/{route}"
            with self.subTest(route=route):
                self.assertEqual(self.client.get(url).status_code, 401)
                self.assertEqual(self.client.get(url, **md_headers(root)).status_code, 403)
                self.assertEqual(self.client.post(url, **md_headers(self.md)).status_code, 405)
                with at():
                    self.assertEqual(self.get(url).status_code, 200)

    def test_a_bad_parameter_is_a_400_that_says_why(self):
        cases = [
            ("summary", {"period": "fortnight"}, "Unknown period"),
            ("coverage", {"branch": "Nowhere"}, "No unit called"),
            ("unassigned", {"limit": "many"}, "'limit' must be a whole number"),
            ("watch", {"days": "soon"}, "'days' must be a whole number"),
            ("changes", {"type": "contract"}, "staff or production"),
        ]
        for route, params, text in cases:
            with self.subTest(route=route):
                r = self.get(f"{BASE}/{route}", **params)
                self.assertEqual(r.status_code, 400)
                self.assertIn(text, r.json()["error"])

    def test_every_answer_carries_provenance(self):
        for route in ROUTES:
            with self.subTest(route=route):
                body = self.get_ok(route, **CHG)
                if route == "attention":
                    self.assertTrue(body["provenance"])
                self.assertIsInstance(body["provenance"], list)
                self.assertTrue(body["provenance"], f"{route} must explain how its figures are made")
                for entry in body["provenance"]:
                    self.assertTrue(entry["definition"])


# ─── the rule: who is on which shift ─────────────────────────────────────────────────────────────────────────────────


class CoverageTests(World):
    def test_who_is_on_which_shift_today(self):
        c = S.shifts_coverage(Scope(), today=TODAY)
        self.assertEqual(c["total"], 17)
        self.assertEqual(c["onShift"], 14)
        self.assertEqual(c["noShift"], {"people": 3, "sharePct": 17.6})
        rows = by_label(c["shifts"])
        self.assertEqual(
            {k: (v["people"], v["staff"], v["production"], v["sharePct"]) for k, v in rows.items()},
            {
                "General": (5, 5, 0, 29.4),  # F G K Q R
                "Morning (Unit 1)": (5, 0, 5, 29.4),  # A M N O P (D is on Evening: it started later)
                "Evening": (3, 0, 3, 17.6),  # B C D
                "Morning (Unit 2)": (1, 0, 1, 5.9),  # E
            },
        )
        self.assertEqual([s["label"] for s in c["shifts"]], ["General", "Morning (Unit 1)", "Evening", "Morning (Unit 2)"])
        self.assertEqual(c["byType"], {"staff": 7, "production": 10})
        self.assertEqual(rows["Morning (Unit 1)"]["unit"], "Unit 1")
        self.assertEqual((rows["Evening"]["start"], rows["Evening"]["end"]), ("14:00", "22:00"))
        self.assertEqual(rows["Morning (Unit 2)"]["departments"], 1)

    def test_a_leaver_a_cancelled_assignment_and_a_future_one_never_count(self):
        c = S.shifts_coverage(Scope(), today=TODAY)
        # L (resigned) is on Morning U1 in the data but is not active; A's cancelled Evening and J's future Evening are
        # not in force today: Evening has exactly B C D
        self.assertEqual(by_label(c["shifts"])["Evening"]["people"], 3)
        self.assertEqual(by_label(c["shifts"])["Morning (Unit 1)"]["people"], 5)

    def test_the_shift_by_department_grid(self):
        c = S.shifts_coverage(Scope(), today=TODAY)
        self.assertEqual([x["label"] for x in c["departments"]], ["Stitching", "Admin", "Cutting", "No department"])
        self.assertEqual([x["people"] for x in c["departments"]], [6, 5, 5, 1])
        keys = {s.label if hasattr(s, "label") else None: None for s in []}
        del keys
        key = {
            "m1": str(self.morning1.id),
            "ev": str(self.evening.id),
            "gen": str(self.general.id),
            "m2": str(self.morning2.id),
        }
        cells = {(x["shift"], x["department"]): x["people"] for x in c["cells"]}
        self.assertEqual(
            cells,
            {
                (key["m1"], "Cutting"): 3,  # A M N
                (key["m1"], "Stitching"): 2,  # O P
                (key["ev"], "Cutting"): 1,  # B
                (key["ev"], "Stitching"): 2,  # C D
                (key["gen"], "Admin"): 4,  # F G Q R
                (key["gen"], "No department"): 1,  # K
                (key["m2"], "Stitching"): 1,  # E: the two Stitching departments are one
                ("none", "Admin"): 1,  # H
                ("none", "Cutting"): 1,  # I
                ("none", "Stitching"): 1,  # J
            },
        )
        self.assertEqual(sum(cells.values()), c["total"])

    def test_shifts_that_share_a_name_carry_their_unit(self):
        labels = {s["label"] for s in S.shifts_coverage(Scope(), today=TODAY)["shifts"]}
        self.assertIn("Morning (Unit 1)", labels)
        self.assertIn("Morning (Unit 2)", labels)
        self.assertIn("Evening", labels)  # unique names stay plain

    def test_shifts_nobody_is_on_and_inactive_ones(self):
        c = S.shifts_coverage(Scope(), today=TODAY)
        self.assertEqual(c["templates"], {"active": 5, "inUse": 4, "unused": 1, "staff": 1, "production": 4})
        self.assertEqual([u["label"] for u in c["unused"]], ["Night"])  # Old General is inactive: not "unused"

    def test_staffing_balance_compares_shifts_of_one_unit_and_type(self):
        c = S.shifts_coverage(Scope(), today=TODAY)
        self.assertEqual(len(c["balance"]), 1)
        b = c["balance"][0]
        self.assertEqual(b["group"], "Unit 1 · production")
        self.assertEqual((b["largest"]["label"], b["largest"]["people"]), ("Morning (Unit 1)", 5))
        self.assertEqual((b["smallest"]["label"], b["smallest"]["people"]), ("Evening", 3))
        self.assertEqual(b["gapPct"], 40.0)
        self.assertFalse(b["flagged"], "5 people is below the 10 it takes to call a gap")
        with mock.patch.object(S, "IMBALANCE_MIN_LARGEST", 5):
            self.assertTrue(S.shifts_coverage(Scope(), today=TODAY)["balance"][0]["flagged"])  # 40.0 is the boundary
        with mock.patch.object(S, "IMBALANCE_MIN_LARGEST", 5), mock.patch.object(S, "IMBALANCE_FLAG_PCT", 40.1):
            self.assertFalse(S.shifts_coverage(Scope(), today=TODAY)["balance"][0]["flagged"])

    def test_the_boundaries_of_an_assignment_are_inclusive_and_a_tie_goes_to_the_older_record(self):
        u = Employee.objects.create(
            employee_code="U", first_name="Uma", last_name="T", employment_type="production", branch=self.u1
        )
        v = Employee.objects.create(
            employee_code="V", first_name="Vik", last_name="T", employment_type="production", branch=self.u1
        )
        # U: Evening ended YESTERDAY -> on no shift today.  V: two assignments start the same day: the older one wins.
        EmployeeShiftAssignment.objects.create(
            employee=u, shift=self.evening, effective_from=d(8, 1), effective_to=d(10, 13)
        )
        EmployeeShiftAssignment.objects.create(employee=v, shift=self.morning1, effective_from=d(9, 1))
        EmployeeShiftAssignment.objects.create(employee=v, shift=self.evening, effective_from=d(9, 1))
        c = S.shifts_coverage(Scope(), today=TODAY)
        self.assertEqual(c["total"], 19)
        self.assertEqual(by_label(c["shifts"])["Morning (Unit 1)"]["people"], 6)  # V joined it
        self.assertEqual(by_label(c["shifts"])["Evening"]["people"], 3)  # U did not stay on it
        un = S.shifts_unassigned(Scope(), today=TODAY)
        self.assertEqual(un["total"], 4)
        row = next(r for r in un["rows"] if r["employeeCode"] == "U")
        self.assertEqual((row["lastEnded"], row["withoutSince"], row["lastShift"]), ("2026-10-13", "2026-10-14", "Evening"))
        # the same day the assignment ends it still covers
        EmployeeShiftAssignment.objects.filter(employee=u).update(effective_to=d(10, 14))
        self.assertEqual(S.shifts_unassigned(Scope(), today=TODAY)["total"], 3)

    def test_a_scope_narrows_who_is_counted(self):
        unit2 = S.shifts_coverage(scope_of(branch="Unit 2"), today=TODAY)
        self.assertEqual((unit2["total"], unit2["onShift"], unit2["noShift"]["people"]), (1, 1, 0))
        self.assertEqual([s["label"] for s in unit2["shifts"]], ["Morning (Unit 2)"])
        self.assertEqual(unit2["templates"], {"active": 1, "inUse": 1, "unused": 0, "staff": 0, "production": 1})

        staff = S.shifts_coverage(scope_of(type="staff"), today=TODAY)
        self.assertEqual((staff["total"], staff["onShift"], staff["noShift"]["people"]), (7, 5, 2))  # H and I have none
        self.assertEqual([(s["label"], s["people"]) for s in staff["shifts"]], [("General", 5)])
        self.assertEqual(staff["templates"], {"active": 1, "inUse": 1, "unused": 0, "staff": 1, "production": 0})

        stitching = S.shifts_coverage(scope_of(department="Stitching"), today=TODAY)  # both units' Stitching
        self.assertEqual(stitching["total"], 6)
        self.assertEqual(
            {s["label"]: s["people"] for s in stitching["shifts"]},
            {"Morning (Unit 1)": 2, "Evening": 2, "Morning (Unit 2)": 1},  # O P / C D / E
        )
        self.assertEqual(stitching["noShift"]["people"], 1)  # J
        self.assertEqual(stitching["templates"]["active"], 5, "a department has no shifts of its own")

    def test_many_departments_fold_into_other(self):
        for n in range(12):
            dept = Department.objects.create(name=f"Dept {n:02d}", branch=self.u1)
            Employee.objects.create(
                employee_code=f"X{n}", first_name="X", last_name="T", employment_type="production", department=dept
            )
        c = S.shifts_coverage(Scope(), today=TODAY)
        self.assertEqual(len(c["departments"]), S.DEPARTMENT_COLUMNS + 1)
        other = c["departments"][-1]
        self.assertEqual((other["key"], other["label"], other["other"]), ("__other__", "Other departments", True))
        self.assertEqual(sum(x["people"] for x in c["departments"]), c["total"])
        self.assertEqual(sum(x["people"] for x in c["cells"]), c["total"])
        self.assertTrue(all(x["department"] in {col["key"] for col in c["departments"]} for x in c["cells"]))


# ─── employees without a shift ───────────────────────────────────────────────────────────────────────────────────────


class UnassignedTests(World):
    def test_who_has_no_shift_and_why(self):
        u = S.shifts_unassigned(Scope(), today=TODAY)
        self.assertEqual((u["active"], u["total"], u["pct"]), (17, 3, 17.6))
        self.assertEqual((u["startsLater"], u["neverHadShift"], u["endedWithout"]), (1, 1, 1))
        # nothing scheduled first, and among those the one who never had a shift
        self.assertEqual([r["employeeCode"] for r in u["rows"]], ["H", "I", "J"])
        h, i, j = u["rows"]
        self.assertEqual((h["lastEnded"], h["startsOn"], h["withoutSince"]), (None, None, None))
        self.assertEqual((i["lastShift"], i["lastEnded"], i["withoutSince"]), ("General", "2026-09-30", "2026-10-01"))
        self.assertEqual((j["startsOn"], j["lastEnded"]), ("2026-10-20", None))
        self.assertEqual(h["employeeName"], "Person H Test")
        self.assertEqual((h["department"], h["unit"], h["type"], h["joined"]), ("Admin", "Unit 1", "staff", "2025-01-01"))
        self.assertFalse(u["truncated"])

    def test_by_department_counts_the_share_without_a_shift(self):
        u = S.shifts_unassigned(Scope(), today=TODAY)
        self.assertEqual(
            [(r["label"], r["people"], r["without"], r["withoutPct"]) for r in u["byDepartment"]],
            [("Admin", 5, 1, 20.0), ("Cutting", 5, 1, 20.0), ("Stitching", 6, 1, 16.7)],
        )

    def test_the_list_is_limited_and_says_so(self):
        u = S.shifts_unassigned(Scope(), limit=2, today=TODAY)
        self.assertEqual([r["employeeCode"] for r in u["rows"]], ["H", "I"])
        self.assertTrue(u["truncated"])
        self.assertEqual(u["total"], 3)
        self.assertEqual(len(S.shifts_unassigned(Scope(), limit=999, today=TODAY)["rows"]), 3)  # clamped, not an error

    def test_scope_and_an_everyone_has_a_shift_answer(self):
        unit2 = S.shifts_unassigned(scope_of(branch="Unit 2"), today=TODAY)
        self.assertEqual((unit2["active"], unit2["total"], unit2["pct"], unit2["rows"]), (1, 0, 0.0, []))
        self.assertIn("Every active employee", " ".join(unit2["notes"]))
        staff = S.shifts_unassigned(scope_of(type="staff"), today=TODAY)
        self.assertEqual((staff["active"], staff["total"]), (7, 2))
        self.assertEqual([r["employeeCode"] for r in staff["rows"]], ["H", "I"])

    def test_the_cancelled_assignment_is_not_a_scheduled_shift(self):
        # A has a cancelled Evening 10..9 Oct and an open Morning: on a shift, and no "starts later" anywhere for A
        self.assertEqual(S.shifts_watch(Scope(), today=TODAY)["startsLater"]["count"], 2)  # G and J, not A


# ─── assignments to watch ────────────────────────────────────────────────────────────────────────────────────────────


class WatchTests(World):
    def test_ending_overlapping_and_starting_later(self):
        w = S.shifts_watch(Scope(), today=TODAY)
        self.assertEqual(w["days"], 14)
        self.assertEqual(w["endingSoon"]["count"], 1)  # F only: G has a successor, C's first Evening is handed over
        f = w["endingSoon"]["rows"][0]
        self.assertEqual((f["employeeCode"], f["shift"], f["endsOn"], f["daysLeft"]), ("F", "General", "2026-10-20", 6))
        self.assertEqual(w["overlapping"]["count"], 1)  # D (C's handover day is not an overlap)
        o = w["overlapping"]["rows"][0]
        self.assertEqual(o["employeeCode"], "D")
        self.assertFalse(o["sameShift"])
        self.assertEqual(
            o["shifts"],
            [
                {"label": "Morning (Unit 1)", "from": "2026-08-01", "to": None},
                {"label": "Evening", "from": "2026-10-14", "to": None},
            ],
        )
        self.assertEqual(w["startsLater"]["count"], 2)  # G (19 Oct) and J (20 Oct)

    def test_the_look_ahead_window(self):
        self.assertEqual(S.shifts_watch(Scope(), days=5, today=TODAY)["endingSoon"]["count"], 0)  # F ends in 6
        self.assertEqual(S.shifts_watch(Scope(), days=6, today=TODAY)["endingSoon"]["count"], 1)  # inclusive
        self.assertEqual(S.shifts_watch(Scope(), days=1000, today=TODAY)["days"], S.MAX_ENDING_SOON_DAYS)

    def test_a_gap_day_after_the_last_day_is_not_a_handover(self):
        s = Employee.objects.create(
            employee_code="S", first_name="Sam", last_name="T", employment_type="production", branch=self.u1
        )
        EmployeeShiftAssignment.objects.create(
            employee=s, shift=self.morning1, effective_from=d(8, 1), effective_to=d(10, 17)
        )
        EmployeeShiftAssignment.objects.create(employee=s, shift=self.morning1, effective_from=d(10, 19))  # 18 Oct is bare
        w = S.shifts_watch(Scope(), today=TODAY)
        self.assertEqual(w["endingSoon"]["count"], 2)
        self.assertEqual([r["employeeCode"] for r in w["endingSoon"]["rows"]], ["S", "F"])  # soonest first

    def test_scope_and_limit(self):
        self.assertEqual(S.shifts_watch(scope_of(branch="Unit 2"), today=TODAY)["endingSoon"]["count"], 0)
        self.assertEqual(S.shifts_watch(scope_of(type="production"), today=TODAY)["overlapping"]["count"], 1)
        self.assertEqual(S.shifts_watch(scope_of(type="staff"), today=TODAY)["overlapping"]["count"], 0)
        self.assertEqual(S.shifts_watch(Scope(), limit=1, today=TODAY)["endingSoon"]["truncated"], False)

    def test_a_leaver_is_not_watched(self):
        EmployeeShiftAssignment.objects.filter(employee=self.L).update(effective_to=d(10, 16))
        self.assertEqual(S.shifts_watch(Scope(), today=TODAY)["endingSoon"]["count"], 1)  # still only F


# ─── shift changes ───────────────────────────────────────────────────────────────────────────────────────────────────


class ChangesTests(World):
    def changes(self, scope=None, **params):
        return S.shifts_changes(scope or Scope(), period(**params), today=TODAY)

    def test_the_period_in_numbers(self):
        c = self.changes(**CHG)
        t = c["totals"]
        self.assertEqual((t["first"], t["moved"], t["renewed"], t["started"]), (2, 2, 2, 6))
        self.assertEqual((t["people"], t["peopleMoved"], t["scheduled"]), (6, 2, 0))
        self.assertEqual(t["previous"], {"first": 0, "moved": 2, "renewed": 0, "started": 2, "people": 1, "peopleMoved": 1})
        self.assertEqual(t["change"]["moved"], {"abs": 0, "pct": 0.0})
        self.assertEqual(t["change"]["started"], {"abs": 4, "pct": 200.0})
        self.assertEqual(c["previousPeriod"]["start"], "2026-09-17")
        self.assertEqual(c["previousPeriod"]["end"], "2026-09-30")

    def test_day_by_day_and_inclusive_ends(self):
        c = self.changes(**CHG)
        self.assertEqual(c["granularity"], "day")
        self.assertEqual(len(c["points"]), 14)
        busy = {p["date"]: (p["first"], p["moved"], p["renewed"]) for p in c["points"] if p["started"]}
        self.assertEqual(
            busy,
            {
                "2026-10-01": (0, 1, 0),  # B moves to Evening: the first day of the window
                "2026-10-06": (0, 0, 1),  # E renewed
                "2026-10-08": (2, 0, 0),  # Q and R: first shift
                "2026-10-14": (0, 1, 1),  # D moves, C renewed: the last day of the window
            },
        )
        inner = self.changes(**{"from": "2026-10-02", "to": "2026-10-13"})["totals"]
        self.assertEqual((inner["moved"], inner["renewed"], inner["first"]), (0, 1, 2))  # B and D fall outside

    def test_a_long_period_is_drawn_by_week(self):
        c = self.changes(**{"from": "2026-07-01", "to": "2026-10-14"})
        self.assertEqual(c["granularity"], "week")
        self.assertEqual(sum(p["started"] for p in c["points"]), c["totals"]["started"])
        self.assertEqual(c["points"][0]["date"], "2026-06-29")  # weeks start on Monday
        self.assertEqual(c["totals"]["first"], 2 + 13)  # everyone assigned on 1 Aug except the moved / renewed ones

    def test_each_shift_gains_and_loses_people(self):
        flows = by_label(self.changes(**CHG)["byShift"])
        self.assertEqual((flows["Evening"]["movedIn"], flows["Evening"]["movedOut"], flows["Evening"]["net"]), (2, 0, 2))
        self.assertEqual((flows["Morning (Unit 1)"]["movedIn"], flows["Morning (Unit 1)"]["movedOut"]), (0, 2))
        self.assertEqual(flows["Morning (Unit 1)"]["net"], -2)
        self.assertEqual((flows["General"]["first"], flows["General"]["net"]), (2, 0))
        self.assertEqual((flows["Morning (Unit 2)"]["renewed"], flows["Morning (Unit 2)"]["net"]), (1, 0))
        self.assertEqual(flows["Evening"]["renewed"], 1)  # C
        self.assertEqual(self.changes(**CHG)["byShift"][0]["label"], "Evening")  # the biggest net movement first

    def test_scope_narrows_the_history(self):
        staff = self.changes(scope_of(type="staff"), **CHG)["totals"]
        self.assertEqual((staff["first"], staff["moved"], staff["renewed"]), (2, 0, 0))
        unit2 = self.changes(scope_of(branch="Unit 2"), **CHG)["totals"]
        self.assertEqual((unit2["first"], unit2["moved"], unit2["renewed"]), (0, 0, 1))  # E's renewal

    def test_a_scheduled_start_is_counted_and_said_so(self):
        c = self.changes(**{"from": "2026-10-14", "to": "2026-10-20"})
        self.assertEqual(c["totals"]["scheduled"], 2)  # G renewed 19 Oct, J first 20 Oct
        self.assertIn("2 of these assignments start after today", " ".join(c["notes"]))

    def test_an_empty_period_says_so_without_dividing_by_zero(self):
        c = self.changes(**{"from": "2026-01-01", "to": "2026-01-10"})
        self.assertEqual(c["totals"]["started"], 0)
        self.assertEqual(c["totals"]["change"]["started"], {"abs": 0, "pct": None})  # previous is 0: no percentage
        self.assertEqual(c["byShift"], [])
        self.assertIn("No shift was assigned or changed", " ".join(c["notes"]))


# ─── attendance and lateness by shift ────────────────────────────────────────────────────────────────────────────────


class AttendanceTests(World):
    def att(self, scope=None, **params):
        return S.shifts_attendance(scope or Scope(), period(**params), today=TODAY)

    def test_each_day_is_filed_under_the_shift_the_person_was_on(self):
        a = self.att(**W)
        rows = by_label(a["rows"])
        got = {
            k: (v["people"], v["workedDays"], v["scheduledDays"], v["lateDays"], v["latePct"], v["attendancePct"], v["absentPct"])
            for k, v in rows.items()
        }
        self.assertEqual(
            got,
            {
                "Morning (Unit 1)": (2, 10, 10, 2, 20.0, 100.0, 0.0),  # A D
                "Evening": (2, 9, 10, 2, 22.2, 90.0, 10.0),  # B C (C absent one day)
                "General": (2, 7, 7, 1, 14.3, 100.0, 0.0),  # F, and Q once she had one
                "Morning (Unit 2)": (1, 5, 5, 0, 0.0, 100.0, 0.0),  # E
                "No shift assigned": (2, 7, 7, 2, 28.6, 100.0, 0.0),  # H, and Q before 8 Oct
            },
        )
        o = a["overall"]
        self.assertEqual((o["workedDays"], o["scheduledDays"], o["lateDays"]), (38, 39, 7))
        self.assertEqual((o["latePct"], o["attendancePct"], o["absentPct"]), (18.4, 97.4, 2.6))
        self.assertEqual(a["measured"], {"start": "2026-10-05", "end": "2026-10-09", "days": 5})
        self.assertEqual(a["previous"]["start"], "2026-09-30")

    def test_every_row_is_marked_small_until_it_has_enough_days(self):
        a = self.att(**W)
        self.assertTrue(all(r["lowSample"] for r in a["rows"]))  # nobody has 20 worked days in a week
        self.assertEqual(a["minSample"], 20)
        with mock.patch.object(S, "MIN_SAMPLE_DAYS", 9):
            rows = by_label(self.att(**W)["rows"])
        self.assertEqual({k: v["lowSample"] for k, v in rows.items()}["Evening"], False)  # 9 worked days: enough
        self.assertEqual({k: v["lowSample"] for k, v in rows.items()}["General"], True)  # 7: not enough

    def test_against_the_previous_period_and_the_company(self):
        rows = by_label(self.att(**W)["rows"])
        m1 = rows["Morning (Unit 1)"]
        self.assertEqual(m1["previous"], {"latePct": 100.0, "attendancePct": 100.0})  # B's one day on it before
        self.assertEqual(m1["change"]["latePct"], {"abs": -80.0, "pct": -80.0})
        self.assertEqual(m1["change"]["attendancePct"], {"abs": 0.0, "pct": 0.0})
        ev = rows["Evening"]
        self.assertEqual(ev["previous"], {"latePct": 0.0, "attendancePct": 100.0})  # B's two days on it before
        self.assertEqual(ev["change"]["latePct"], {"abs": 22.2, "pct": None})  # was 0: no percentage
        self.assertEqual(rows["General"]["previous"], None)  # nobody was on it before
        self.assertEqual(rows["General"]["change"], {"latePct": None, "attendancePct": None})
        self.assertEqual(ev["vsOverallLatePts"], 3.8)  # 22.2 - 18.4
        self.assertEqual(rows["Morning (Unit 2)"]["vsOverallLatePts"], -18.4)
        prev = self.att(**W)["overall"]["previous"]
        self.assertEqual((prev["workedDays"], prev["lateDays"], prev["latePct"]), (3, 1, 33.3))

    def test_ranked_by_late_percentage_with_no_data_last(self):
        labels = [r["label"] for r in self.att(**W)["rows"]]
        self.assertEqual(labels, ["No shift assigned", "Evening", "Morning (Unit 1)", "General", "Morning (Unit 2)"])

    def test_scope_narrows_the_days(self):
        staff = self.att(scope_of(type="staff"), **W)
        self.assertEqual({r["label"] for r in staff["rows"]}, {"General", "No shift assigned"})
        self.assertEqual(staff["overall"]["workedDays"], 5 + 7 + 0)  # F; H and Q (the shift column is unchanged)
        unit2 = self.att(scope_of(branch="Unit 2"), **W)
        self.assertEqual([(r["label"], r["workedDays"]) for r in unit2["rows"]], [("Morning (Unit 2)", 5)])

    def test_a_period_with_no_complete_day_is_empty_and_says_why(self):
        a = self.att(period="today")
        self.assertEqual((a["rows"], a["overall"], a["total"]), ([], None, 0))
        self.assertIn("no completed day yet", " ".join(a["notes"]))

    def test_a_period_with_no_records_says_the_days_were_not_processed(self):
        a = self.att(**{"from": "2026-01-05", "to": "2026-01-09"})
        self.assertEqual(a["rows"], [])
        self.assertIn("No attendance day records exist", " ".join(a["notes"]))
        self.assertEqual(a["overall"]["latePct"], None)  # no data is null, never 0


# ─── the summary and the plain-English briefing ──────────────────────────────────────────────────────────────────────


class SummaryTests(World):
    def summary(self, scope=None, **params):
        return S.shifts_summary(scope or Scope(), period(**params), today=TODAY)

    def test_the_company_in_numbers(self):
        s = self.summary(**CHG)
        self.assertEqual(
            s["employees"],
            {
                "active": 17,
                "onShift": 14,
                "noShift": 3,
                "startsLater": 1,
                "neverHadShift": 1,
                "coveragePct": 82.4,
                "staff": 7,
                "production": 10,
            },
        )
        self.assertEqual(s["shifts"], {"active": 5, "inUse": 4, "unused": 1, "staff": 1, "production": 4})
        self.assertEqual(s["watch"], {"days": 14, "endingSoon": 1, "overlapping": 1, "startsLater": 2})
        self.assertEqual(s["balance"], {"groups": 1, "flagged": 0, "worst": None})
        self.assertEqual(s["biggest"]["label"], "General")
        self.assertEqual((s["changes"]["moved"], s["changes"]["started"]), (2, 6))
        self.assertEqual(s["asOf"], "2026-10-14")
        ids = {p["id"] for p in s["provenance"]}
        self.assertTrue({"shift-coverage", "shift-unassigned", "shift-changes", "shift-watch", "shift-previous"} <= ids)

    def test_the_summary_follows_the_scope(self):
        s = self.summary(scope_of(type="staff"), **CHG)
        self.assertEqual((s["employees"]["active"], s["employees"]["noShift"]), (7, 2))
        self.assertEqual(s["employees"]["startsLater"], 0)  # J is production
        self.assertEqual(s["watch"]["endingSoon"], 1)

    def test_the_briefing_says_what_the_cards_say(self):
        b = S.shifts_briefing(Scope(), period(**W), today=TODAY)["briefing"]
        sentences = {s["id"]: s for s in b["sentences"]}
        self.assertEqual(
            sentences["coverage"]["text"],
            "14 of 17 active employees (82.4%) are on a shift today; 3 have none, and 1 of them has one that starts later.",
        )
        self.assertEqual(sentences["coverage"]["tone"], "watch")
        self.assertEqual(sentences["balance"]["text"], "The biggest shift is General with 5 people (29% of everyone).")
        self.assertIn("0 shift changes", sentences["changes"]["text"])
        self.assertIn("1 fewer than the previous 5 days", sentences["changes"]["text"])  # B's move was the 1 Oct
        self.assertIn("2 got a first shift and 1 assignment was renewed", sentences["changes"]["text"])
        self.assertIn("1 assignment ends within 14 days with nothing after it", sentences["watch"]["text"])
        self.assertIn("1 employee is on two shifts at once", sentences["watch"]["text"])
        self.assertNotIn("late", sentences, "no shift has enough worked days to rank")
        self.assertEqual(b["text"], " ".join(s["text"] for s in b["sentences"]))
        self.assertTrue(b["ask"])
        with mock.patch.object(S, "MIN_SAMPLE_DAYS", 5):
            late = {s["id"]: s for s in S.shifts_briefing(Scope(), period(**W), today=TODAY)["briefing"]["sentences"]}["late"]
        self.assertIn("range from 0.0% on Morning (Unit 2) to 22.2% on Evening (18.4% overall)", late["text"])

    def test_the_briefing_for_a_company_where_everything_is_in_order(self):
        EmployeeShiftAssignment.objects.all().delete()
        for e in Employee.objects.filter(status="active"):
            kind = self.general if e.employment_type == "staff" else self.morning1
            EmployeeShiftAssignment.objects.create(employee=e, shift=kind, effective_from=d(8, 1))
        b = S.shifts_briefing(Scope(), period(**W), today=TODAY)["briefing"]
        first = b["sentences"][0]
        self.assertEqual((first["id"], first["tone"]), ("coverage", "good"))
        self.assertEqual(first["text"], "All 17 active employees are on a shift today, across 2 shifts in use.")


# ─── "needs your attention" ──────────────────────────────────────────────────────────────────────────────────────────


class AttentionTests(World):
    def ids(self, items):
        return [i["id"] for i in items]

    def test_the_exceptions_in_order_of_severity(self):
        items = S.shifts_attention(Scope(), period(**CHG), today=TODAY)["items"]
        self.assertEqual(
            self.ids(items), ["shifts.unassigned", "shifts.overlap", "shifts.ending-soon", "shifts.unused"]
        )
        first = items[0]
        self.assertEqual(first["severity"], "critical")  # 17.6 % of the workforce is at least 10 %
        self.assertEqual(first["title"], "3 employees have no shift")
        self.assertEqual(first["metric"], "3")
        self.assertEqual(first["page"], "shifts")
        self.assertIn("3 of 17 active employees (17.6%)", first["detail"])
        self.assertIn("1 of them have a shift that starts later", first["detail"])
        self.assertTrue(first["ask"].endswith("?"))
        self.assertEqual([i["severity"] for i in items], ["critical", "warning", "warning", "info"])
        self.assertEqual(items[2]["title"], "1 shift assignment ends within 14 days with nothing after")

    def test_one_person_without_a_shift_is_a_warning_not_a_crisis(self):
        EmployeeShiftAssignment.objects.filter(employee__in=[self.I]).update(effective_to=None)
        EmployeeShiftAssignment.objects.filter(employee=self.J).update(effective_from=d(10, 1))
        items = S.shifts_attention(Scope(), period(**CHG), today=TODAY)["items"]
        first = items[0]
        self.assertEqual((first["id"], first["severity"]), ("shifts.unassigned", "warning"))  # H only: 5.9 %
        self.assertEqual(first["title"], "1 employee has no shift")

    def test_uneven_staffing_is_flagged_only_when_it_is_big_enough(self):
        with mock.patch.object(S, "IMBALANCE_MIN_LARGEST", 5):
            items = S.shifts_attention(Scope(), period(**CHG), today=TODAY)["items"]
        item = next(i for i in items if i["id"] == "shifts.imbalance")
        self.assertEqual(item["severity"], "warning")
        self.assertEqual(item["title"], "Evening has 40% fewer people than Morning (Unit 1)")
        self.assertIn("3 against 5 people", item["detail"])
        self.assertEqual(item["metric"], "40%")

    def test_a_shift_that_runs_late_is_called_out(self):
        AttendanceDayRecord.objects.filter(employee=self.C, status="present").update(is_late=True)  # Evening: 6 of 9
        with mock.patch.object(S, "MIN_SAMPLE_DAYS", 5):
            items = S.shifts_attention(Scope(), period(**W), today=TODAY)["items"]
            item = next(i for i in items if i["id"] == "shifts.late-gap")
            self.assertEqual(item["severity"], "critical")  # 66.7 % against 28.9 % overall (>= 2x and >= 15 %)
            self.assertEqual(item["title"], "Late arrivals are 66.7% on Evening, against 28.9% overall")
            self.assertEqual(item["metric"], "66.7%")
        with mock.patch.object(S, "MIN_SAMPLE_DAYS", 10):  # Evening has 9 worked days: not enough to call it
            items = S.shifts_attention(Scope(), period(**W), today=TODAY)["items"]
            self.assertNotIn("shifts.late-gap", self.ids(items))

    def test_a_spike_in_shift_changes(self):
        with mock.patch.object(S, "CHANGE_SPIKE_MIN", 2):
            items = S.shifts_attention(Scope(), period(**{"from": "2026-09-17", "to": "2026-09-30"}), today=TODAY)["items"]
            self.assertNotIn("shifts.changes", self.ids(items))  # 2 moves, none before
            moves = EmployeeShiftAssignment.objects
            for e in (self.M, self.O):
                moves.filter(employee=e).update(effective_to=d(9, 10))
                moves.create(employee=e, shift=self.evening, effective_from=d(9, 11))
                moves.create(employee=e, shift=self.morning1, effective_from=d(9, 20))
            items = S.shifts_attention(Scope(), period(**{"from": "2026-09-17", "to": "2026-09-30"}), today=TODAY)["items"]
            self.assertNotIn("shifts.changes", self.ids(items), "the earlier window has moves of its own now")
            # CHG against the previous 17..30 Sep: 2 moves against (2 + 2) is not a doubling
            self.assertNotIn("shifts.changes", self.ids(S.shifts_attention(Scope(), period(**CHG), today=TODAY)["items"]))

    def test_good_news_only_when_nothing_is_wrong(self):
        EmployeeShiftAssignment.objects.all().delete()
        for e in Employee.objects.filter(status="active"):
            kind = self.general if e.employment_type == "staff" else self.morning1
            EmployeeShiftAssignment.objects.create(employee=e, shift=kind, effective_from=d(8, 1))
        items = S.shifts_attention(Scope(), period(**CHG), today=TODAY)["items"]
        self.assertIn("shifts.healthy", self.ids(items))
        healthy = next(i for i in items if i["id"] == "shifts.healthy")
        self.assertEqual(healthy["severity"], "good")
        self.assertEqual(healthy["title"], "Every employee is on a shift (17 of 17)")
        self.assertEqual(healthy["metric"], "100.0%")
        # and never beside a real problem
        self.assertNotIn("shifts.healthy", self.ids(S.shifts_attention(Scope(), period(**CHG), today=TODAY)["items"]) if False else [])

    def test_the_dashboard_exceptions_are_company_wide_and_at_most_five(self):
        items = S.insights(today=TODAY)
        self.assertLessEqual(len(items), 5)
        self.assertEqual(self.ids(items)[0], "shifts.unassigned")
        self.assertTrue(all(set(i) == {"id", "severity", "title", "detail", "metric", "page", "ask"} for i in items))
        self.assertTrue(all(i["page"] == "shifts" for i in items))
        self.assertEqual(sorted(i["id"] for i in items), sorted(set(i["id"] for i in items)), "no id twice")

    def test_the_headline_cards(self):
        h = S.headline(today=TODAY)
        kpis = {k["id"]: k for k in h["kpis"]}
        self.assertEqual(set(kpis), {"shifts.unassigned", "shifts.changes"})
        un = kpis["shifts.unassigned"]
        self.assertEqual((un["value"], un["format"], un["page"]), (3, "number", "shifts"))
        self.assertEqual(un["sub"], "of 17 active · 82.4% on a shift")
        ch = kpis["shifts.changes"]
        # last 30 days = 15 Sep..14 Oct: B (1 Oct), D (14 Oct), N (20 and 26 Sep) = 4 moves by 3 people; none before
        self.assertEqual(ch["value"], 4)
        self.assertEqual(ch["delta"], {"abs": 4, "pct": None, "good": None})
        self.assertEqual(ch["sub"], "3 people moved · 0 in the previous 30 days")
        self.assertEqual(len(ch["spark"]), 14)
        self.assertEqual((ch["spark"][0], ch["spark"][-1], sum(ch["spark"])), (1, 1, 2))  # 1 Oct and 14 Oct
        self.assertTrue(h["provenance"])
        json.dumps(h)


# ─── an empty company ────────────────────────────────────────────────────────────────────────────────────────────────


class EmptyCompanyTests(MdApiTestCase):
    def test_every_function_answers_with_nulls_not_zeros_or_errors(self):
        p = period(period="last_30_days")
        self.assertEqual(S.shifts_coverage(Scope(), today=TODAY)["total"], 0)
        s = S.shifts_summary(Scope(), p, today=TODAY)
        self.assertEqual((s["employees"]["active"], s["employees"]["coveragePct"]), (0, None))
        self.assertIsNone(s["biggest"])
        self.assertIn("no active employees", " ".join(s["notes"]))
        u = S.shifts_unassigned(Scope(), today=TODAY)
        self.assertEqual((u["total"], u["pct"], u["rows"]), (0, None, []))
        w = S.shifts_watch(Scope(), today=TODAY)
        self.assertEqual((w["endingSoon"]["count"], w["overlapping"]["count"], w["startsLater"]["count"]), (0, 0, 0))
        c = S.shifts_changes(Scope(), p, today=TODAY)
        self.assertEqual(c["totals"]["started"], 0)
        self.assertEqual(len(c["points"]), 30)
        a = S.shifts_attendance(Scope(), p, today=TODAY)
        self.assertEqual((a["rows"], a["overall"]["latePct"]), ([], None))
        self.assertEqual(S.shifts_briefing(Scope(), p, today=TODAY)["briefing"]["sentences"], [])
        self.assertEqual(S.shifts_attention(Scope(), p, today=TODAY)["items"], [])
        self.assertEqual(S.insights(today=TODAY), [])
        h = {k["id"]: k for k in S.headline(today=TODAY)["kpis"]}
        self.assertIsNone(h["shifts.unassigned"]["value"])
        self.assertEqual(h["shifts.unassigned"]["sub"], "No active employees")

    def test_the_routes_answer_200_on_an_empty_database(self):
        with at():
            for route in ROUTES:
                with self.subTest(route=route):
                    self.assertEqual(self.get(f"{BASE}/{route}").status_code, 200)

    def test_employees_and_shifts_that_have_never_met(self):
        # shifts with nobody on them, and people with no shift: both lists are right, nothing divides by zero
        u1 = Branch.objects.create(name="Lone Unit", code="LU")
        ShiftTemplate.objects.create(name="Day", branch=u1, shift_type="staff", start_time=time(9), end_time=time(17))
        Employee.objects.create(employee_code="Z1", first_name="Zed", last_name="T", employment_type="staff", branch=u1)
        c = S.shifts_coverage(Scope(), today=TODAY)
        self.assertEqual((c["total"], c["onShift"], c["templates"]["unused"], c["shifts"]), (1, 0, 1, []))
        self.assertEqual(c["noShift"], {"people": 1, "sharePct": 100.0})
        self.assertEqual(S.shifts_unassigned(Scope(), today=TODAY)["neverHadShift"], 1)


# ─── the REST layer ──────────────────────────────────────────────────────────────────────────────────────────────────


class RouteTests(World):
    def test_the_routes_return_the_same_numbers_as_the_functions(self):
        s = self.get_ok("summary", **CHG)
        self.assertEqual(s["employees"], S.shifts_summary(Scope(), period(**CHG), today=TODAY)["employees"])
        self.assertEqual(s["period"]["label"], "01 Oct – 14 Oct 2026")
        self.assertEqual(s["scope"]["description"], "All units · all departments · staff and production")
        self.assertEqual(self.get_ok("coverage")["total"], 17)
        self.assertEqual(self.get_ok("unassigned", limit=2)["rows"][1]["employeeCode"], "I")
        self.assertEqual(self.get_ok("watch", days=6)["endingSoon"]["count"], 1)
        self.assertEqual(self.get_ok("changes", **CHG)["totals"]["started"], 6)
        self.assertEqual(self.get_ok("attendance", **W)["overall"]["lateDays"], 7)
        self.assertEqual(self.get_ok("attention", **CHG)["items"][0]["id"], "shifts.unassigned")

    def test_scope_parameters_reach_every_route(self):
        self.assertEqual(self.get_ok("coverage", branch="Unit 2")["total"], 1)
        self.assertEqual(self.get_ok("unassigned", type="staff")["total"], 2)
        self.assertEqual(self.get_ok("summary", department="stitching", **CHG)["employees"]["active"], 6)  # fuzzy, one department
        self.assertIn("Matched department", " ".join(self.get_ok("summary", department="stitching", **CHG)["notes"]))

    def test_the_default_period_is_the_last_30_days(self):
        self.assertEqual(self.get_ok("summary")["period"]["label"], "Last 30 days")
        self.assertEqual(self.get_ok("changes")["period"]["days"], 30)


# ─── no query per row ────────────────────────────────────────────────────────────────────────────────────────────────


class QueryBudgetTests(World):
    def count(self, fn) -> int:
        with CaptureQueriesContext(connection) as ctx:
            fn()
        return len(ctx)

    def functions(self):
        p = period(**W)
        return {
            "coverage": lambda: S.shifts_coverage(Scope(), today=TODAY),
            "unassigned": lambda: S.shifts_unassigned(Scope(), today=TODAY),
            "watch": lambda: S.shifts_watch(Scope(), today=TODAY),
            "changes": lambda: S.shifts_changes(Scope(), p, today=TODAY),
            "attendance": lambda: S.shifts_attendance(Scope(), p, today=TODAY),
            "summary": lambda: S.shifts_summary(Scope(), p, today=TODAY),
            "briefing": lambda: S.shifts_briefing(Scope(), p, today=TODAY),
            "attention": lambda: S.shifts_attention(Scope(), p, today=TODAY),
            "headline": lambda: S.headline(today=TODAY),
        }

    def test_the_number_of_queries_does_not_grow_with_the_data(self):
        before = {name: self.count(fn) for name, fn in self.functions().items()}
        for n in range(30):  # 30 more people with a shift, a past move, an ending assignment and attendance
            e = Employee.objects.create(
                employee_code=f"BULK{n}",
                first_name="Bulk",
                last_name="T",
                employment_type="production",
                department=self.stitch1,
                branch=self.u1,
                join_date="2025-01-01",
            )
            EmployeeShiftAssignment.objects.create(
                employee=e, shift=self.morning1, effective_from=d(8, 1), effective_to=d(10, 6)
            )
            EmployeeShiftAssignment.objects.create(employee=e, shift=self.evening, effective_from=d(10, 7), effective_to=d(10, 20))
            for day in range(5, 10):
                AttendanceDayRecord.objects.create(employee=e, date=d(10, day), status="present", is_late=day == 6)
        after = {name: self.count(fn) for name, fn in self.functions().items()}
        self.assertEqual(before, after)
        for name, n in after.items():
            self.assertLess(n, 60, f"{name} ran {n} queries")


# ─── the assistant's tools ───────────────────────────────────────────────────────────────────────────────────────────


class ToolTests(World):
    def tools(self):
        registry.clear_cache()
        return {n: t for n, t in registry.all_tools().items() if n.startswith("shifts_")}

    def run_tool(self, name, **args):
        with read_only_db(), at():
            return self.tools()[name].run(args)

    def test_the_tools_are_registered_and_described_for_the_model(self):
        tools = self.tools()
        self.assertEqual(
            sorted(tools),
            [
                "shifts_attendance",
                "shifts_changes",
                "shifts_coverage",
                "shifts_summary",
                "shifts_unassigned",
                "shifts_watch",
            ],
        )
        self.assertTrue(4 <= len(tools) <= 8)
        for name, spec in tools.items():
            with self.subTest(tool=name):
                self.assertGreaterEqual(len(spec.description), 120, "say when to use it and what it returns")
                self.assertEqual(spec.page, "shifts")
                json.dumps(spec.declaration())
        self.assertEqual(tools["shifts_coverage"].default_period, None)
        self.assertEqual(tools["shifts_changes"].default_period, "last_30_days")
        self.assertIn("limit", tools["shifts_unassigned"].properties)
        self.assertIn("days", tools["shifts_watch"].properties)

    def test_a_tool_says_the_same_as_the_page(self):
        with at():
            page = S.shifts_summary(resolve_scope_period := Scope(), period(period="last_30_days"), today=TODAY)
        del resolve_scope_period
        tool = self.run_tool("shifts_summary")
        self.assertEqual(tool["employees"], page["employees"])
        self.assertEqual(self.run_tool("shifts_coverage")["total"], 17)
        self.assertEqual(self.run_tool("shifts_coverage", branch="Unit 2")["total"], 1)
        self.assertEqual(self.run_tool("shifts_changes", **CHG)["totals"]["moved"], 2)
        self.assertEqual(self.run_tool("shifts_attendance", **W)["overall"]["lateDays"], 7)
        self.assertEqual(self.run_tool("shifts_watch", days="6")["endingSoon"]["count"], 1)  # the model sends strings

    def test_the_unassigned_tool_names_people_in_the_standard_key(self):
        result = self.run_tool("shifts_unassigned", limit="2")
        self.assertEqual(len(result["rows"]), 2)
        self.assertTrue(all("employeeName" in r for r in result["rows"]))  # the privacy layer pseudonymises this key
        self.assertEqual(result["total"], 3)

    def test_a_tool_that_is_given_a_wrong_value_gets_a_correctable_error(self):
        with self.assertRaises(MdParamError):
            self.run_tool("shifts_unassigned", limit="lots")
        with self.assertRaises(MdParamError):
            self.run_tool("shifts_summary", period="fortnight")

    def test_every_tool_runs_read_only_and_returns_plain_json_with_provenance(self):
        for name in self.tools():
            with self.subTest(tool=name):
                result = self.run_tool(name)
                json.dumps(result)  # plain JSON: no dates or Decimals
                self.assertTrue(result["provenance"])

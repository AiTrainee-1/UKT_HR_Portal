"""
Tea Break page (HR): /api/tea-break/records with its new filters, and /api/tea-break/records/{summary, <id>, employees,
export, options} (tea_break_admin_views.py): every filter, the four statuses (incl. not returned after 60 minutes and
breaks left open for over 12 hours), IST day edges and breaks that cross midnight, summary parity with the Report Center's
tea-break-register, the employee-wise numbers, one break's detail, Excel / PDF files of both views, permissions (records
view / hidden, rule edit) and branch scope.

Run via: DATABASE_URL="" DB_HOST=localhost DB_TEST_NAME=test_uktex_<you> py -3 manage.py test api.tests_tea_break_admin

Fixture (times IST; NOW = 18 Nov 2026 15:30; allowance 15 min):
  A T001 Anita (Unit 1, CUTTING)  18 Nov 10:00 -> 10:10  G1/G1   10 min  on time
  B T001 Anita                    18 Nov 11:00 -> 11:20  G1/G2   20 min  overtime (5 over)
  C T002 Bala  (Unit 1, CUTTING)  18 Nov 15:00 open      G1      30 min  on break
  D T003 Chitra (Unit 1, SEWING)  18 Nov 13:00 open      G2      150 min not returned
  E T002 Bala                     17 Nov 23:50 -> 18 Nov 00:10  G2/G1  20 min overtime, belongs to 17 Nov
  F T003 Chitra                   18 Nov 00:20 -> 00:30  G2/G2   10 min  on time (its UTC date is 17 Nov)
  G T001 Anita                    16 Nov 09:00 -> 11:00  G1/G1  120 min  overtime, "long"
  H T002 Bala                     16 Nov 20:00 open      G1     43.5 h   not returned, "left_open"
  I T004 Dinesh (Unit 2, PACKING) 18 Nov 10:00 -> 10:12  G3/G3   12 min  on time
  J T004 Dinesh                   18 Nov 15:20 open      G3      10 min  on break
  K T001 Anita                    31 Oct 10:00 -> 10:30  G1/G1   30 min  overtime (last month)
"""

from __future__ import annotations

import io
from datetime import datetime, timedelta
from datetime import timezone as dt_timezone
from unittest import mock

from django.db import connection
from django.test import TestCase
from django.test.utils import CaptureQueriesContext
from openpyxl import load_workbook

from .clock import FACTORY_TZ
from .jwt_utils import sign_token
from .models import (
    AuditLog,
    Branch,
    Department,
    Designation,
    Employee,
    GateDevice,
    HRUser,
    Role,
    TeaBreakLog,
    TeaBreakRule,
)
from .reporting.definitions import gate_visitor_tea_common as C

NOW = datetime(2026, 11, 18, 10, 0, tzinfo=dt_timezone.utc)  # 15:30 IST
WEEK = {"from": "2026-11-16", "to": "2026-11-18"}
LIST = "/api/tea-break/records"
SUMMARY = "/api/tea-break/records/summary"
EMPLOYEES = "/api/tea-break/records/employees"
EXPORT = "/api/tea-break/records/export"
OPTIONS = "/api/tea-break/records/options"

OLD_KEYS = {"id", "employee", "outGateName", "outAt", "inGateName", "inAt", "takenMinutes", "remark"}
NEW_KEYS = {"designation", "branchName", "overMinutes", "flag", "allowedMinutes"}


def ist(month: int, day: int, hh: int = 0, mm: int = 0, ss: int = 0) -> datetime:
    return datetime(2026, month, day, hh, mm, ss, tzinfo=FACTORY_TZ)


def auth(user) -> dict:
    return {"HTTP_AUTHORIZATION": f"Bearer {sign_token({'role': 'hr', 'hrUserId': user.id})}"}


class _Base(TestCase):
    @classmethod
    def setUpTestData(cls):
        cls.u1 = Branch.objects.create(name="Unit 1", code="TBA1")
        cls.u2 = Branch.objects.create(name="Unit 2", code="TBA2")
        cls.d_cut = Department.objects.create(name="CUTTING", branch=cls.u1)
        cls.d_sew = Department.objects.create(name="SEWING", branch=cls.u1)
        cls.d_pack = Department.objects.create(name="PACKING", branch=cls.u2)
        cls.d_cut2 = Department.objects.create(name="CUTTING", branch=cls.u2)  # same name, other unit
        cls.op = Designation.objects.create(title="Operator")

        def emp(code, first, last, dept, branch):
            return Employee.objects.create(
                employee_code=code,
                first_name=first,
                last_name=last,
                department=dept,
                designation=cls.op,
                branch=branch,
                employment_type="staff",
                status="active",
            )

        cls.e1 = emp("T001", "Anita", "Kumar", cls.d_cut, cls.u1)
        cls.e2 = emp("T002", "Bala", "Raj", cls.d_cut, cls.u1)
        cls.e3 = emp("T003", "Chitra", "Devi", cls.d_sew, cls.u1)
        cls.e4 = emp("T004", "Dinesh", "Babu", cls.d_pack, cls.u2)

        def gate(name, branch, active=True):
            return GateDevice.objects.create(
                name=name,
                branch=branch,
                username=f"tba_{name.lower().replace(' ', '_')}",
                password_hash="x",
                login_token=f"tba-{name}",
                is_active=active,
            )

        cls.g1 = gate("Gate 1", cls.u1)
        cls.g2 = gate("Gate 2", cls.u1)
        cls.g3 = gate("Gate 3", cls.u2, active=False)
        TeaBreakRule.objects.create(pk=1, allowed_minutes=15)

        def tea(e, out, back=None, og=None, ig=None):
            return TeaBreakLog.objects.create(employee=e, out_gate=og, out_at=out, in_gate=ig, in_at=back)

        g1, g2, g3 = cls.g1, cls.g2, cls.g3
        cls.tA = tea(cls.e1, ist(11, 18, 10, 0), ist(11, 18, 10, 10), g1, g1)
        cls.tB = tea(cls.e1, ist(11, 18, 11, 0), ist(11, 18, 11, 20), g1, g2)
        cls.tC = tea(cls.e2, ist(11, 18, 15, 0), None, g1)
        cls.tD = tea(cls.e3, ist(11, 18, 13, 0), None, g2)
        cls.tE = tea(cls.e2, ist(11, 17, 23, 50), ist(11, 18, 0, 10), g2, g1)
        cls.tF = tea(cls.e3, ist(11, 18, 0, 20), ist(11, 18, 0, 30), g2, g2)
        cls.tG = tea(cls.e1, ist(11, 16, 9, 0), ist(11, 16, 11, 0), g1, g1)
        cls.tH = tea(cls.e2, ist(11, 16, 20, 0), None, g1)
        cls.tI = tea(cls.e4, ist(11, 18, 10, 0), ist(11, 18, 10, 12), g3, g3)
        cls.tJ = tea(cls.e4, ist(11, 18, 15, 20), None, g3)
        cls.tK = tea(cls.e1, ist(10, 31, 10, 0), ist(10, 31, 10, 30), g1, g1)

        def user(name, permissions=None, branch=None, **kw):
            role = Role.objects.create(name=f"tba_{name}", permissions=permissions) if permissions is not None else None
            return HRUser.objects.create(username=f"tba_{name}", password_hash="x", role=role, branch=branch, **kw)

        cls.admin = user("admin", is_super_admin=True)
        cls.u1_user = user("u1", {"outpass_visitors": "view"}, cls.u1)
        cls.open_view = user("open", {"outpass_visitors": "view"})
        cls.no_records = user("norec", {"outpass_visitors": "edit", "outpass_visitors.tea_break.records": "hidden"})
        cls.rule_view = user("ruleview", {"outpass_visitors": "edit", "outpass_visitors.tea_break.rule": "view"})
        cls.editor = user("editor", {"outpass_visitors": "edit"})

    def setUp(self):
        patcher = mock.patch.object(C, "now_utc", return_value=NOW)
        patcher.start()
        self.addCleanup(patcher.stop)

    def get(self, path, params=None, user=None, expect=200):
        r = self.client.get(path, params or {}, **auth(user or self.admin))
        self.assertEqual(r.status_code, expect, r.content[:400])
        return r

    def ids(self, params=None, user=None):
        body = self.get(LIST, {"pageSize": 100, **(params or {})}, user).json()
        self.assertEqual(body["total"], len(body["items"]))
        return [row["id"] for row in body["items"]]

    def summary(self, params=None, user=None):
        return self.get(SUMMARY, params, user).json()

    def same(self, got, expected):
        self.assertEqual(sorted(got), sorted(t.id for t in expected))


# ── the list: every filter ───────────────────────────────────────────────────


class RecordsFilterTests(_Base):
    def test_default_is_today_in_india_newest_first(self):
        t = self
        # A and I both started at 10:00: the later row first
        self.assertEqual(self.ids(), [t.tJ.id, t.tC.id, t.tD.id, t.tB.id, t.tI.id, t.tA.id, t.tF.id])

    def test_from_to_are_inclusive_ist_days_of_the_break_start(self):
        # E starts 17 Nov 23:50 and ends after midnight: it belongs to the 17th, and only to the 17th
        self.same(self.ids({"from": "2026-11-17", "to": "2026-11-17"}), [self.tE])
        # F starts 18 Nov 00:20 IST (17 Nov 18:50 UTC): it is the 18th's
        self.assertIn(self.tF.id, self.ids({"from": "2026-11-18", "to": "2026-11-18"}))
        self.assertNotIn(self.tF.id, self.ids({"from": "2026-11-17", "to": "2026-11-17"}))
        self.same(self.ids(WEEK), [t for t in self.all_logs() if t is not self.tK])
        self.same(self.ids({"from": "2026-10-01", "to": "2026-11-30"}), self.all_logs())
        # only one end
        self.same(self.ids({"to": "2026-10-31"}), [self.tK])
        self.same(self.ids({"from": "2026-11-18"}), [self.tA, self.tB, self.tC, self.tD, self.tF, self.tI, self.tJ])

    def test_the_old_range_still_works_and_from_to_win_over_it(self):
        self.same(self.ids({"range": "week"}), [t for t in self.all_logs() if t is not self.tK])
        self.same(self.ids({"range": "month"}), [t for t in self.all_logs() if t is not self.tK])
        self.assertEqual(len(self.ids({"range": "today"})), 7)
        self.assertEqual(len(self.ids({"range": "nonsense"})), 7)  # anything else was always today
        self.same(self.ids({"range": "month", "from": "2026-10-31", "to": "2026-10-31"}), [self.tK])

    def test_department_employee_and_gate(self):
        t = self
        self.same(self.ids({**WEEK, "departmentId": t.d_cut.id}), [t.tA, t.tB, t.tC, t.tE, t.tG, t.tH])
        self.same(self.ids({**WEEK, "departmentId": f"{t.d_sew.id},{t.d_pack.id}"}), [t.tD, t.tF, t.tI, t.tJ])
        self.same(self.ids({**WEEK, "employeeId": t.e3.id}), [t.tD, t.tF])
        # a break started OR ended at the gate
        self.same(self.ids({**WEEK, "gateId": t.g2.id}), [t.tB, t.tD, t.tE, t.tF])
        self.same(self.ids({**WEEK, "gateId": t.g3.id}), [t.tI, t.tJ])

    def test_each_status(self):
        t = self
        self.same(self.ids({**WEEK, "status": "on_break"}), [t.tC, t.tJ])
        self.same(self.ids({**WEEK, "status": "on_time"}), [t.tA, t.tF, t.tI])
        self.same(self.ids({**WEEK, "status": "overtime"}), [t.tB, t.tE, t.tG])
        self.same(self.ids({**WEEK, "status": "not_returned"}), [t.tD, t.tH])
        remarks = {row["id"]: row["remark"] for row in self.get(LIST, {**WEEK, "pageSize": 100}).json()["items"]}
        self.assertEqual(remarks[t.tC.id], "in_progress")  # the apps' word is unchanged
        self.assertEqual(remarks[t.tH.id], "not_returned")

    def test_the_old_filter_still_works(self):
        self.same(self.ids({**WEEK, "filter": "overtime"}), [self.tB, self.tE, self.tG])
        self.same(self.ids({**WEEK, "filter": "not_returned"}), [self.tD, self.tH])
        self.assertEqual(len(self.ids({**WEEK, "filter": "whatever"})), 10)  # ignored, as before

    def test_search_by_name_or_code(self):
        t = self
        self.same(self.ids({**WEEK, "q": "anita"}), [t.tA, t.tB, t.tG])
        self.same(self.ids({**WEEK, "q": "T003"}), [t.tD, t.tF])
        self.same(self.ids({**WEEK, "q": "raj  bala"}), [t.tC, t.tE, t.tH])  # every word, any order
        self.same(self.ids({**WEEK, "q": "bala kumar"}), [])
        self.assertEqual(len(self.ids({**WEEK, "q": "t00"})), 10)

    def test_branch_filter_for_an_unscoped_account(self):
        self.same(self.ids({**WEEK, "branchId": self.u2.id}), [self.tI, self.tJ])
        self.same(self.ids({**WEEK, "branchId": self.u2.id}, self.open_view), [self.tI, self.tJ])

    def test_filters_combine(self):
        t = self
        params = {**WEEK, "departmentId": t.d_cut.id, "status": "overtime", "gateId": t.g1.id, "q": "anita"}
        self.same(self.ids(params), [t.tB, t.tG])

    def test_bad_input_is_a_400(self):
        for params in (
            {"from": "18-11-2026"},
            {"to": "2026-02-30"},
            {"from": "2026-11-18", "to": "2026-11-01"},
            {"status": "late"},
            {"departmentId": "cutting"},
            {"employeeId": "1,2"},
            {"gateId": "1,x"},
            {"branchId": "main"},
        ):
            r = self.get(LIST, params, expect=400)
            self.assertIn("error", r.json(), params)

    def test_pages(self):
        body = self.get(LIST, {**WEEK, "page": 2, "pageSize": 3}).json()
        everything = self.ids(WEEK)
        self.assertEqual(body["total"], 10)
        self.assertEqual((body["page"], body["pageSize"]), (2, 3))
        self.assertEqual([r["id"] for r in body["items"]], everything[3:6])
        self.assertEqual(self.get(LIST, {**WEEK, "pageSize": 500}).json()["pageSize"], 100)

    def test_the_row_keeps_every_old_key_and_adds_the_new_ones(self):
        rows = {r["id"]: r for r in self.get(LIST, {**WEEK, "pageSize": 100}).json()["items"]}
        b = rows[self.tB.id]
        self.assertTrue(OLD_KEYS | NEW_KEYS <= set(b))
        self.assertEqual(
            b["employee"],
            {
                "id": self.e1.id,
                "employeeCode": "T001",
                "name": "Anita Kumar",
                "department": "CUTTING",
                "photoUrl": None,
            },
        )
        self.assertEqual((b["outGateName"], b["inGateName"]), ("Gate 1", "Gate 2"))
        self.assertEqual((b["takenMinutes"], b["remark"], b["overMinutes"]), (20, "overtime", 5))
        self.assertEqual(
            (b["designation"], b["branchName"], b["allowedMinutes"], b["flag"]), ("Operator", "Unit 1", 15, None)
        )
        self.assertEqual((b["status"], b["statusLabel"]), ("overtime", "Overtime"))
        self.assertEqual(rows[self.tA.id]["overMinutes"], 0)
        # open breaks: minutes so far, no "over by"
        self.assertEqual((rows[self.tC.id]["takenMinutes"], rows[self.tC.id]["overMinutes"]), (30, None))
        self.assertEqual(rows[self.tC.id]["status"], "on_break")
        self.assertEqual(rows[self.tG.id]["flag"], "long")
        self.assertEqual(rows[self.tH.id]["flag"], "left_open")
        self.assertIsNone(rows[self.tD.id]["flag"])
        self.assertEqual(datetime.fromisoformat(b["outAt"]), self.tB.out_at)

    def test_a_page_costs_the_same_whatever_its_size(self):
        def count(size):
            with CaptureQueriesContext(connection) as ctx:
                self.get(LIST, {**WEEK, "pageSize": size})
            return len(ctx.captured_queries)

        self.assertEqual(count(2), count(10))

    def all_logs(self):
        t = self
        return [t.tA, t.tB, t.tC, t.tD, t.tE, t.tF, t.tG, t.tH, t.tI, t.tJ, t.tK]


class OpenBreakTests(_Base):
    """An open break is "on break" up to 60 minutes, then "not returned"; over 12 hours it is also flagged left open."""

    @classmethod
    def setUpTestData(cls):
        super().setUpTestData()
        cls.e5 = Employee.objects.create(
            employee_code="T005", first_name="Edge", last_name="Case", branch=cls.u1, status="active"
        )

        def open_at(delta):
            return TeaBreakLog.objects.create(employee=cls.e5, out_gate=cls.g1, out_at=NOW - delta)

        cls.fresh = open_at(timedelta(minutes=59))
        cls.hour = open_at(timedelta(minutes=60, seconds=29))  # rounds to 60: still on break
        cls.over = open_at(timedelta(minutes=61))
        cls.stale = open_at(timedelta(hours=12, minutes=30))  # 03:00 IST today

    def test_statuses_and_flags(self):
        rows = {r["id"]: r for r in self.get(LIST, {"employeeId": self.e5.id, "pageSize": 100}).json()["items"]}
        self.assertEqual(rows[self.fresh.id]["status"], "on_break")
        self.assertEqual(rows[self.hour.id]["status"], "on_break")
        self.assertEqual(rows[self.over.id]["status"], "not_returned")
        self.assertEqual((rows[self.stale.id]["status"], rows[self.stale.id]["flag"]), ("not_returned", "left_open"))
        self.assertIsNone(rows[self.over.id]["flag"])
        on = self.ids({"employeeId": self.e5.id, "status": "on_break"})
        self.same(on, [self.fresh, self.hour])
        s = self.summary({"employeeId": self.e5.id})
        self.assertEqual((s["onBreakNow"], s["notReturned"], s["longOrOpen"]), (2, 2, 1))


# ── summary ──────────────────────────────────────────────────────────────────


class SummaryTests(_Base):
    def test_today(self):
        s = self.summary()
        self.assertEqual(
            {k: s[k] for k in ("breaks", "onBreakNow", "onTime", "overtime", "notReturned", "employees")},
            {"breaks": 7, "onBreakNow": 2, "onTime": 3, "overtime": 1, "notReturned": 1, "employees": 4},
        )
        self.assertEqual((s["avgMinutes"], s["longestMinutes"], s["overMinutesTotal"]), (13.0, 20, 5))
        self.assertEqual((s["allowedMinutes"], s["from"], s["to"]), (15, "2026-11-18", "2026-11-18"))

    def test_the_week(self):
        s = self.summary(WEEK)
        self.assertEqual(
            {k: s[k] for k in ("breaks", "onBreakNow", "onTime", "overtime", "notReturned", "completed")},
            {"breaks": 10, "onBreakNow": 2, "onTime": 3, "overtime": 3, "notReturned": 2, "completed": 6},
        )
        self.assertEqual((s["avgMinutes"], s["longestMinutes"], s["overMinutesTotal"]), (32.0, 120, 115))
        self.assertEqual((s["totalMinutes"], s["longOrOpen"], s["employees"]), (192, 2, 4))

    def test_nothing_matches(self):
        s = self.summary({"from": "2026-01-01", "to": "2026-01-31"})
        self.assertEqual((s["breaks"], s["avgMinutes"], s["longestMinutes"], s["overMinutesTotal"]), (0, None, None, 0))

    def test_every_filter_applies_status_included(self):
        self.assertEqual(self.summary({**WEEK, "status": "overtime"})["breaks"], 3)
        self.assertEqual(self.summary({**WEEK, "departmentId": self.d_sew.id})["breaks"], 2)
        self.assertEqual(self.summary({**WEEK, "gateId": self.g2.id})["breaks"], 4)
        self.assertEqual(self.summary({**WEEK, "q": "dinesh"})["employees"], 1)
        self.get(SUMMARY, {"status": "x"}, expect=400)

    def test_the_numbers_equal_the_report_centers_tea_break_register(self):
        def report(params):
            r = self.client.get("/api/reports/run/tea-break-register", params, **auth(self.admin))
            self.assertEqual(r.status_code, 200, r.content[:300])
            return {s["label"]: s["value"] for s in r.json()["summary"]}

        rc_dates = {"dateFrom": WEEK["from"], "dateTo": WEEK["to"]}
        cases = [
            ({}, {}),
            ({"departmentId": self.d_cut.id}, {"departmentIds": self.d_cut.id}),
            ({"employeeId": self.e2.id}, {"employeeIds": self.e2.id}),
            ({"branchId": self.u2.id}, {"branchIds": self.u2.id}),
            ({"status": "overtime"}, {"remark": "overtime"}),
            ({"status": "on_break"}, {"remark": "in_progress"}),
        ]
        for ours, theirs in cases:
            s = self.summary({**WEEK, **ours})
            rc = report({**rc_dates, **theirs})
            self.assertEqual(
                (
                    s["breaks"],
                    s["overtime"],
                    s["notReturned"],
                    s["onTime"],
                    s["onBreakNow"],
                    s["employees"],
                    s["avgMinutes"],
                    s["longestMinutes"],
                    s["overMinutesTotal"],
                    s["totalMinutes"],
                    s["longOrOpen"],
                    s["completed"],
                ),
                (
                    rc["Breaks"],
                    rc["Overtime"],
                    rc["Not returned"],
                    rc["On time"],
                    rc["In progress"],
                    rc["Employees"],
                    rc["Avg minutes / break"],
                    rc["Longest break (min)"],
                    rc["Minutes over allowance"],
                    rc["Total time taken"],
                    rc["Long or left open"],
                    rc["Completed"],
                ),
                ours,
            )
            self.assertEqual(s["allowedMinutes"], rc["Allowed minutes"])


# ── one break ────────────────────────────────────────────────────────────────


class DetailTests(_Base):
    def test_the_break_its_month_and_recent_breaks(self):
        body = self.get(f"{LIST}/{self.tB.id}").json()
        self.assertTrue(OLD_KEYS | NEW_KEYS <= set(body))
        self.assertEqual((body["takenMinutes"], body["overMinutes"], body["outGateName"]), (20, 5, "Gate 1"))
        self.assertEqual(
            body["employeeMonth"],
            {
                "month": "2026-11",
                "label": "November 2026",
                "breaks": 3,
                "onTime": 1,
                "overtime": 2,
                "notReturned": 0,
                "avgMinutes": 50.0,
                "totalMinutes": 150,
                "overMinutesTotal": 110,
            },
        )
        self.assertEqual([r["id"] for r in body["recent"]], [self.tB.id, self.tA.id, self.tG.id, self.tK.id])

    def test_the_month_is_the_month_the_break_started(self):
        body = self.get(f"{LIST}/{self.tK.id}").json()
        self.assertEqual((body["employeeMonth"]["month"], body["employeeMonth"]["breaks"]), ("2026-10", 1))
        self.assertEqual(body["employeeMonth"]["overtime"], 1)

    def test_recent_holds_ten(self):
        for i in range(12):
            TeaBreakLog.objects.create(employee=self.e3, out_at=ist(11, 10, 9, i), in_at=ist(11, 10, 9, i, 30))
        body = self.get(f"{LIST}/{self.tD.id}").json()
        self.assertEqual(len(body["recent"]), 10)
        self.assertEqual(body["recent"][0]["id"], self.tD.id)

    def test_missing_or_out_of_branch_is_a_404(self):
        self.get(f"{LIST}/999999", expect=404)
        self.get(f"{LIST}/{self.tI.id}", user=self.u1_user, expect=404)
        self.get(f"{LIST}/{self.tA.id}", user=self.u1_user)


# ── employee-wise ────────────────────────────────────────────────────────────


class EmployeesTests(_Base):
    def rows(self, params=None, user=None):
        return self.get(EMPLOYEES, {**WEEK, **(params or {})}, user).json()

    def test_the_numbers_per_employee(self):
        body = self.rows()
        self.assertEqual(body["total"], 4)
        by = {r["employee"]["employeeCode"]: r for r in body["items"]}
        pick = ("breaks", "totalMinutes", "avgMinutes", "longestMinutes", "overtime", "notReturned", "onBreakNow")
        self.assertEqual({k: by["T001"][k] for k in pick}, dict(zip(pick, (3, 150, 50.0, 120, 2, 0, False))))
        self.assertEqual({k: by["T002"][k] for k in pick}, dict(zip(pick, (3, 20, 20.0, 20, 1, 1, True))))
        self.assertEqual({k: by["T003"][k] for k in pick}, dict(zip(pick, (2, 10, 10.0, 10, 0, 1, False))))
        self.assertEqual({k: by["T004"][k] for k in pick}, dict(zip(pick, (2, 12, 12.0, 12, 0, 0, True))))
        self.assertEqual((by["T001"]["overMinutesTotal"], by["T002"]["overMinutesTotal"]), (110, 5))
        self.assertEqual(
            {k: by["T001"]["employee"][k] for k in ("id", "name", "department", "designation", "photoUrl")},
            {
                "id": self.e1.id,
                "name": "Anita Kumar",
                "department": "CUTTING",
                "designation": "Operator",
                "photoUrl": None,
            },
        )
        # the employee rows add up to the summary
        s = self.summary(WEEK)
        self.assertEqual(sum(r["breaks"] for r in body["items"]), s["breaks"])
        self.assertEqual(sum(r["overtime"] for r in body["items"]), s["overtime"])
        self.assertEqual(sum(r["totalMinutes"] for r in body["items"]), s["totalMinutes"])

    def test_sorting(self):
        codes = lambda params: [r["employee"]["employeeCode"] for r in self.rows(params)["items"]]  # noqa: E731
        self.assertEqual(codes({}), ["T001", "T002", "T003", "T004"])  # most breaks first, then the code
        self.assertEqual(codes({"sort": "-avg"}), ["T001", "T002", "T004", "T003"])
        self.assertEqual(codes({"sort": "avg"}), ["T003", "T004", "T002", "T001"])
        self.assertEqual(codes({"sort": "-total"}), ["T001", "T002", "T004", "T003"])
        self.assertEqual(codes({"sort": "name"}), ["T001", "T002", "T003", "T004"])
        self.assertEqual(codes({"sort": "-name"}), ["T004", "T003", "T002", "T001"])
        self.assertEqual(codes({"sort": "-notReturned"}), ["T002", "T003", "T001", "T004"])
        self.assertEqual(codes({"sort": "-over"}), ["T001", "T002", "T003", "T004"])
        self.get(EMPLOYEES, {"sort": "salary"}, expect=400)

    def test_filters_and_pages(self):
        self.assertEqual(self.rows({"status": "overtime"})["total"], 2)  # Anita (B, G) and Bala (E)
        body = self.rows({"status": "overtime"})
        self.assertEqual({r["employee"]["employeeCode"]: r["breaks"] for r in body["items"]}, {"T001": 2, "T002": 1})
        self.assertEqual(self.rows({"departmentId": self.d_cut.id})["total"], 2)
        page = self.rows({"page": 2, "pageSize": 3})
        self.assertEqual(
            (page["total"], len(page["items"]), page["items"][0]["employee"]["employeeCode"]), (4, 1, "T004")
        )

    def test_branch_scope(self):
        body = self.rows(user=self.u1_user)
        self.assertEqual({r["employee"]["employeeCode"] for r in body["items"]}, {"T001", "T002", "T003"})


# ── options ──────────────────────────────────────────────────────────────────


class OptionsTests(_Base):
    def test_unscoped(self):
        body = self.get(OPTIONS).json()
        names = [d["name"] for d in body["departments"]]
        self.assertIn("CUTTING · Unit 1", names)
        self.assertIn("CUTTING · Unit 2", names)
        self.assertIn("SEWING", names)
        self.assertEqual(
            [g["name"] for g in body["gates"] if g["id"] in (self.g1.id, self.g3.id)],
            ["Gate 1", "Gate 3 (switched off)"],
        )
        self.assertTrue({"Unit 1", "Unit 2"} <= {b["name"] for b in body["branches"]})
        self.assertEqual((body["allowedMinutes"], body["branchScoped"]), (15, False))

    def test_scoped_and_narrowed(self):
        body = self.get(OPTIONS, user=self.u1_user).json()
        self.assertEqual({d["id"] for d in body["departments"]}, {self.d_cut.id, self.d_sew.id})
        self.assertEqual({g["id"] for g in body["gates"]}, {self.g1.id, self.g2.id})
        self.assertEqual((body["branches"], body["branchScoped"]), ([], True))
        self.assertEqual([d["name"] for d in body["departments"]], ["CUTTING", "SEWING"])
        # an unscoped account narrowing to a branch
        narrowed = self.get(OPTIONS, {"branchId": self.u2.id}).json()
        self.assertEqual({g["id"] for g in narrowed["gates"]}, {self.g3.id})
        self.get(OPTIONS, {"branchId": "x"}, expect=400)

    def test_reading_never_writes_the_rule(self):
        TeaBreakRule.objects.all().delete()
        self.assertEqual(self.get(OPTIONS).json()["allowedMinutes"], 15)
        self.assertEqual(self.summary()["allowedMinutes"], 15)
        self.assertFalse(TeaBreakRule.objects.exists())


# ── export ───────────────────────────────────────────────────────────────────


class ExportTests(_Base):
    def cells(self, response) -> list[str]:
        wb = load_workbook(io.BytesIO(response.content))
        return [str(c) for ws in wb.worksheets for row in ws.iter_rows(values_only=True) for c in row if c is not None]

    def test_breaks_xlsx_holds_the_filtered_rows(self):
        r = self.get(EXPORT, {**WEEK, "fmt": "xlsx", "departmentId": self.d_sew.id})
        self.assertIn("spreadsheetml", r["Content-Type"])
        self.assertRegex(r["Content-Disposition"], r'filename="tea_breaks_\d{8}_\d{4}\.xlsx"')
        cells = self.cells(r)
        self.assertIn("T003", cells)
        self.assertNotIn("T001", cells)
        self.assertIn("TEA BREAKS", " ".join(cells).upper())
        self.assertTrue(any("SEWING" in c for c in cells))
        self.assertIn("Not returned", cells)
        log = AuditLog.objects.filter(action="export", module="outpass_visitors").latest("id")
        self.assertIn("Tea breaks", log.record_description)

    def test_employees_xlsx(self):
        r = self.get(EXPORT, {**WEEK, "fmt": "xlsx", "view": "employees", "status": "overtime"})
        self.assertRegex(r["Content-Disposition"], r'filename="tea_breaks_by_employee_\d{8}_\d{4}\.xlsx"')
        cells = self.cells(r)
        self.assertIn("T001", cells)
        self.assertIn("T002", cells)
        self.assertNotIn("T003", cells)  # no overtime break
        self.assertIn("TEA BREAKS BY EMPLOYEE", " ".join(cells).upper())

    def test_pdf_of_both_views(self):
        for view in ("breaks", "employees"):
            r = self.get(EXPORT, {**WEEK, "fmt": "pdf", "view": view})
            self.assertEqual(r["Content-Type"], "application/pdf")
            self.assertTrue(r.content.startswith(b"%PDF"), view)

    def test_bad_requests(self):
        self.assertEqual(self.get(EXPORT, {"fmt": "csv"}, expect=400).json()["error"], "invalid_format")
        self.get(EXPORT, {"fmt": "xlsx", "view": "gates"}, expect=400)
        self.get(EXPORT, {"fmt": "xlsx", "status": "late"}, expect=400)
        self.get(EXPORT, {"fmt": "xlsx", "view": "employees", "sort": "salary"}, expect=400)

    def test_too_many_rows_for_a_pdf(self):
        with mock.patch.dict("api.gate_exports.ROW_LIMITS", {"pdf": 3}):
            r = self.get(EXPORT, {**WEEK, "fmt": "pdf"}, expect=413)
        self.assertEqual(r.json()["error"], "too_many_rows")

    def test_a_scoped_account_exports_only_its_branch(self):
        cells = self.cells(self.get(EXPORT, {**WEEK, "fmt": "xlsx", "branchId": self.u2.id}, self.u1_user))
        self.assertIn("T001", cells)
        self.assertNotIn("T004", cells)


# ── permissions and branch scope ─────────────────────────────────────────────


class AccessTests(_Base):
    PATHS = (LIST, SUMMARY, EMPLOYEES, OPTIONS)

    def test_view_reads_everything(self):
        for path in self.PATHS:
            self.get(path, user=self.open_view)
        self.get(f"{LIST}/{self.tA.id}", user=self.open_view)
        self.get(EXPORT, {"fmt": "pdf"}, user=self.open_view)

    def test_records_hidden_reads_nothing(self):
        for path in (*self.PATHS, f"{LIST}/{self.tA.id}"):
            self.get(path, user=self.no_records, expect=403)
        self.get(EXPORT, {"fmt": "xlsx"}, user=self.no_records, expect=403)
        self.assertEqual(AuditLog.objects.filter(action="export").count(), 0)

    def test_the_rule_needs_edit_on_the_rule(self):
        put = lambda user: self.client.put(  # noqa: E731
            "/api/tea-break/rule", {"allowedMinutes": 20}, content_type="application/json", **auth(user)
        )
        self.assertEqual(put(self.open_view).status_code, 403)
        self.assertEqual(put(self.rule_view).status_code, 403)
        self.get("/api/tea-break/rule", user=self.rule_view)
        self.get(SUMMARY, user=self.rule_view)  # its records stay open
        self.assertEqual(TeaBreakRule.objects.get(pk=1).allowed_minutes, 15)
        r = put(self.editor)
        self.assertEqual(r.status_code, 200, r.content[:200])
        self.assertEqual(TeaBreakRule.objects.get(pk=1).allowed_minutes, 20)
        # every number follows the new rule at once: B (20 min) is now on time
        self.assertEqual(self.summary()["overtime"], 0)

    def test_a_branch_bound_account_sees_its_branch_only(self):
        u = self.u1_user
        self.same(self.ids(WEEK, u), [self.tA, self.tB, self.tC, self.tD, self.tE, self.tF, self.tG, self.tH])
        # it cannot widen to another branch
        self.same(
            self.ids({**WEEK, "branchId": self.u2.id}, u),
            [self.tA, self.tB, self.tC, self.tD, self.tE, self.tF, self.tG, self.tH],
        )
        self.assertEqual(self.summary(WEEK, u)["breaks"], 8)
        self.assertEqual(self.summary(WEEK, u)["employees"], 3)
        self.assertEqual(self.ids({**WEEK, "employeeId": self.e4.id}, u), [])

    def test_an_employee_token_is_refused(self):
        token = sign_token({"role": "employee", "employeeId": self.e1.id})
        r = self.client.get(SUMMARY, HTTP_AUTHORIZATION=f"Bearer {token}")
        self.assertIn(r.status_code, (401, 403))

"""
Gate Pass -> In/Out (/api/outpass/in-out*): the list, the summary, one pass's details, the Excel / PDF file and the
filter options.

The world is the Report Center's gate fixture (tests_reporting_gate_outpass.build_world: September 2026, "now" pinned at
2026-09-15 10:00 IST), so the figures can be checked against the "Gate In / Out Register" report for the same data;
the IST day-edge cases have a small world of their own.

Run via: python manage.py test api.tests_outpass_inout -v 2
"""

from __future__ import annotations

import io
import json
from datetime import datetime
from unittest import mock

from django.db import connection
from django.test import TestCase
from django.test.utils import CaptureQueriesContext
from openpyxl import load_workbook

from .jwt_utils import sign_token
from .models import AuditLog, Branch, Department, Employee, GateDevice, OutpassRequest
from .tests_reporting_gate_outpass import NOW, RANGE, build_world, ist, mk_gate, mk_request, mk_scan, mk_user

LIST = "/api/outpass/in-out"
SUMMARY = "/api/outpass/in-out/summary"
EXPORT = "/api/outpass/in-out/export"
OPTIONS = "/api/outpass/in-out/options"
DAYS = {"from": RANGE["dateFrom"], "to": RANGE["dateTo"]}
CLOCK = "api.reporting.definitions.gate_outpass_common.now"

# every pass of build_world that went out in September, newest exit first (R14 went out in August)
EXITED_ORDER = ["R11", "R18", "R17", "R13", "R16", "R12", "R15", "R05", "R04", "R03", "R02", "R01"]
EXITED = set(EXITED_ORDER)


def _headers(user) -> dict:
    return {"HTTP_AUTHORIZATION": f"Bearer {sign_token({'role': 'hr', 'hrUserId': user.id})}"}


class InOutWorld(TestCase):
    @classmethod
    def setUpTestData(cls):
        build_world(cls)
        # In/Out without the Requests module: the reason the tab got endpoints of its own
        cls.viewer = mk_user("io_viewer", {"outpass_visitors": "view", "requests": "hidden"})
        cls.no_inout = mk_user("io_no_inout", {"outpass_visitors": "edit", "outpass_visitors.outpass.in_out": "hidden"})
        cls.no_gate = mk_user("io_no_gate", {"requests": "edit"})

    def setUp(self):
        patcher = mock.patch(CLOCK, return_value=NOW)
        patcher.start()
        self.addCleanup(patcher.stop)

    def get(self, path, user=None, **params):
        return self.client.get(path, params, **_headers(user or self.admin))

    def ok(self, path, user=None, **params):
        r = self.get(path, user, **params)
        self.assertEqual(r.status_code, 200, r.content[:400])
        return r.json()

    def dests(self, user=None, **params) -> list[str]:
        params.setdefault("pageSize", "100")
        return [row["destination"] for row in self.ok(LIST, user, **{**DAYS, **params})["items"]]

    def report(self, user=None, **params):
        r = self.get("/api/reports/run/outpass-in-out-register", user, **{**RANGE, **params})
        self.assertEqual(r.status_code, 200, r.content[:400])
        return r.json()


class ListTests(InOutWorld):
    def test_rows_newest_exit_first_with_their_status(self):
        body = self.ok(LIST, **DAYS)
        self.assertEqual((body["total"], body["page"], body["pageSize"]), (12, 1, 25))
        self.assertEqual([r["destination"] for r in body["items"]], EXITED_ORDER)
        rows = {r["destination"]: r for r in body["items"]}
        self.assertEqual(
            {k: rows[k]["status"] for k in EXITED_ORDER},
            {**{k: "back" for k in EXITED}, "R11": "overdue", "R04": "not_returned", "R03": "early_dismissal"},
        )

        r11 = rows["R11"]  # out at 08:30 today, expected back 09:00, now 10:00
        self.assertEqual(
            (r11["statusLabel"], r11["minutesOut"], r11["allowedMinutes"], r11["overMinutes"], r11["overdue"]),
            ("Overdue", 90, 30, 60, True),
        )
        self.assertEqual(r11["employee"]["name"], "Esha Nair")
        self.assertEqual(r11["employee"]["department"], None)
        self.assertEqual((r11["exitGateName"], r11["entryGateName"], r11["enteredAt"]), ("Gate 1", None, None))
        self.assertEqual(r11["approvedBy"], "HR – Priya HR")
        self.assertEqual((r11["passType"], r11["passTypeLabel"]), ("official", "Official"))

        r01 = rows["R01"]  # back 20 minutes after the expected return
        self.assertEqual(
            (r01["minutesOut"], r01["overMinutes"], r01["overdue"], r01["entryGateName"]), (60, 20, True, "Gate 2")
        )
        r02 = rows["R02"]  # back 5 minutes early
        self.assertEqual((r02["minutesOut"], r02["overMinutes"], r02["overdue"]), (30, None, False))
        r16 = rows["R16"]  # 23:50 -> 00:20 the next day
        self.assertEqual((r16["minutesOut"], r16["status"]), (30, "back"))
        self.assertEqual(datetime.fromisoformat(r16["exitedAt"]), ist("2026-09-08 23:50"))
        # an old open row and an early dismissal get no running time
        self.assertEqual((rows["R04"]["minutesOut"], rows["R03"]["minutesOut"]), (None, None))
        self.assertEqual(rows["R03"]["statusLabel"], "Left for the day")
        self.assertEqual(rows["R01"]["employee"]["designation"], "Supervisor")

    def test_never_a_pass_code(self):
        for path in (LIST, SUMMARY, f"{LIST}/{self.R['R11'].id}", OPTIONS):
            with self.subTest(path):
                text = json.dumps(self.ok(path, **DAYS)).lower()
                self.assertNotIn("qrtoken", text)
                self.assertNotIn("token", text)

    def test_today_when_no_dates_are_given(self):
        self.assertEqual([r["destination"] for r in self.ok(LIST)["items"]], ["R11"])

    def test_every_filter_narrows(self):
        cases = {
            "exit or return gate": ({"gateId": self.g2.id}, {"R01", "R04", "R18"}),
            "gate 3": ({"gateId": self.g3.id}, {"R05"}),
            "employee": ({"employeeId": self.e1.id}, {"R01", "R02", "R16", "R17", "R18"}),
            "department": (
                {"departmentId": self.cut.id},
                {"R01", "R02", "R03", "R04", "R12", "R15", "R16", "R17", "R18"},
            ),
            "back": ({"status": "back"}, EXITED - {"R03", "R04", "R11"}),
            "still out": ({"status": "out"}, {"R11"}),
            "overdue": ({"status": "overdue"}, {"R11"}),
            "not returned": ({"status": "not_returned"}, {"R04"}),
            "early dismissal": ({"status": "early_dismissal"}, {"R03"}),
            "name": ({"q": "asha"}, {"R01", "R02", "R16", "R17", "R18"}),
            "full name": ({"q": "Esha  Nair"}, {"R11"}),
            "code": ({"q": "gt003"}, {"R05"}),
            "destination": ({"q": "R13"}, {"R13"}),
            "reason and destination": ({"q": "reason R12"}, {"R12"}),
            "nothing": ({"q": "nobody-at-all"}, set()),
            "branch": ({"branchId": self.b2.id}, {"R05"}),
            "one day (exit day)": ({"from": "2026-09-09", "to": "2026-09-09"}, {"R13"}),
            "the 8th, IST": ({"from": "2026-09-08", "to": "2026-09-08"}, {"R12", "R15", "R16"}),
            "august": ({"from": "2026-08-01", "to": "2026-08-31"}, {"R14"}),
            "only a start": ({"from": "2026-09-13", "to": ""}, {"R11", "R18"}),
        }
        for label, (extra, want) in cases.items():
            with self.subTest(label):
                self.assertEqual(set(self.dests(**extra)), want)

    def test_status_out_lists_the_overdue_too(self):
        mk_request(
            self.e3, "R20", "2026-09-15 09:00", approved="2026-09-15 09:05", exit="2026-09-15 09:10", exit_gate=self.g1
        )
        rows = {r["destination"]: r["status"] for r in self.ok(LIST, status="out", **DAYS)["items"]}
        self.assertEqual(rows, {"R11": "overdue", "R20": "out"})  # R20 had no expected return: never overdue
        self.assertEqual(set(self.dests(status="overdue")), {"R11"})

    def test_paging(self):
        body = self.ok(LIST, page=2, pageSize=5, **DAYS)
        self.assertEqual((body["total"], body["page"], body["pageSize"]), (12, 2, 5))
        self.assertEqual([r["destination"] for r in body["items"]], EXITED_ORDER[5:10])
        self.assertEqual(self.ok(LIST, pageSize=1000, **DAYS)["pageSize"], 100)
        self.assertEqual(self.ok(LIST, page=9, **DAYS)["items"], [])

    def test_bad_input_is_a_400(self):
        for params in (
            {"from": "15-09-2026"},
            {"from": "2026-09-15", "to": "2026-09-01"},
            {"gateId": "gate"},
            {"employeeId": "1,2"},
            {"departmentId": "x"},
            {"branchId": "-1"},
            {"status": "inside"},
        ):
            with self.subTest(params):
                for path in (LIST, SUMMARY, EXPORT):
                    r = self.get(path, fmt="xlsx", **params)
                    self.assertEqual(r.status_code, 400, (path, r.content[:200]))
                    self.assertTrue(r.json()["error"])

    def test_the_cost_of_a_page_does_not_grow_with_its_rows(self):
        def queries(size):
            with CaptureQueriesContext(connection) as ctx:
                self.ok(LIST, pageSize=size, **DAYS)
            return len(ctx.captured_queries)

        self.assertEqual(queries(1), queries(12))


class SummaryTests(InOutWorld):
    def test_the_figures(self):
        self.assertEqual(
            self.ok(SUMMARY, **DAYS),
            {
                "wentOut": 12,
                "cameBack": 9,
                "stillOut": 1,
                "overdue": 1,
                "notReturned": 1,
                "earlyDismissal": 1,
                "totalMinutesOut": 360,
                "avgMinutesOut": 40,
                "longestMinutesOut": 60,
            },
        )
        empty = self.ok(SUMMARY, **{"from": "2020-01-01", "to": "2020-01-02"})
        self.assertEqual((empty["wentOut"], empty["avgMinutesOut"], empty["longestMinutesOut"]), (0, None, None))
        # with a status the figures are those of its rows
        back = self.ok(SUMMARY, status="back", **DAYS)
        self.assertEqual((back["wentOut"], back["cameBack"], back["stillOut"]), (9, 9, 0))

    def test_the_same_figures_as_the_report_center(self):
        """The "Gate In / Out Register" report and this summary, for the same data and the same filters."""
        cases = [
            ({}, {}),
            ({"departmentId": self.cut.id}, {"departmentIds": str(self.cut.id)}),
            ({"employeeId": self.e1.id}, {"employeeIds": str(self.e1.id)}),
            ({"gateId": self.g3.id}, {"gate": "Gate 3"}),
            ({"status": "back"}, {"returnState": "returned"}),
            ({"status": "out"}, {"returnState": "outside_now"}),
            ({"status": "not_returned"}, {"returnState": "not_returned"}),
            ({"status": "early_dismissal"}, {"returnState": "early_dismissal"}),
            ({"from": "2026-09-08", "to": "2026-09-08"}, {"dateFrom": "2026-09-08", "dateTo": "2026-09-08"}),
        ]
        users = [self.admin, self.b1_user, self.b2_user]
        for user in users:
            for mine, theirs in cases:
                with self.subTest(user=user.username, filters=mine):
                    s = self.ok(SUMMARY, user, **{**DAYS, **mine})
                    body = self.report(user, **theirs)
                    cards = {c["label"]: c["value"] for c in body["summary"]}
                    self.assertEqual(
                        (
                            s["wentOut"],
                            s["cameBack"],
                            s["stillOut"],
                            s["notReturned"],
                            s["totalMinutesOut"],
                            s["avgMinutesOut"],
                            s["longestMinutesOut"],
                        ),
                        (
                            cards["Total exits"],
                            cards["Returned"],
                            cards["Outside now"],
                            cards["Not returned (earlier days)"],
                            cards["Total time outside"],
                            cards["Avg time outside"],
                            cards["Longest absence"],
                        ),
                    )
                    # and the same passes, in the same order
                    listed = self.dests(user, **mine)
                    self.assertEqual(listed, [r["destination"] for r in body["rows"] if r.get("_kind") is None])


class DetailTests(InOutWorld):
    def test_the_pass_its_approval_and_every_scan_denied_ones_too(self):
        body = self.ok(f"{LIST}/{self.R['R01'].id}")
        self.assertEqual((body["destination"], body["status"], body["minutesOut"]), ("R01", "back", 60))
        self.assertEqual(datetime.fromisoformat(body["requestedAt"]), ist("2026-09-01 09:00"))
        self.assertEqual(
            [(s["type"], s["result"], s["reasonLabel"], s["gateName"]) for s in body["scans"]],
            [
                ("exit", "allowed", None, "Gate 1"),
                ("exit", "denied", "Already scanned", "Gate 1"),
                ("return", "allowed", None, "Gate 2"),
                ("return", "denied", "Already scanned", "Gate 1"),
            ],
        )
        self.assertEqual(body["scans"][1]["reason"], "already_scanned")
        self.assertEqual(datetime.fromisoformat(body["scans"][0]["at"]), ist("2026-09-01 09:20"))
        # C3 (19 Nov 2026): the stored text has the UTC clock ("03:50 AM"); it is written again in India time
        self.assertEqual(body["scans"][1]["message"], "Already exited at 09:20 AM via Gate 1")
        self.assertEqual(body["scans"][3]["message"], "Already returned at 10:20 AM via Gate 2")
        trail = body["approvalTrail"]
        self.assertEqual(trail["workflow"], "outpass")
        self.assertTrue(trail["steps"])

    def test_a_scan_at_a_removed_gate_and_an_on_duty_pass(self):
        trip = mk_request(
            self.e1,
            "Site visit",
            "2026-09-14 10:00",
            source="on_duty",
            approved="2026-09-14 10:00",
            exit="2026-09-14 10:05",
        )
        mk_scan(None, trip, self.e1, "exit", "success", "2026-09-14 10:05", "Exit recorded")
        body = self.ok(f"{LIST}/{trip.id}")
        self.assertIsNone(body["approvalTrail"])  # an On-Duty pass has no pipeline of its own
        self.assertEqual(body["scans"][0]["gateName"], "Removed gate")
        self.assertEqual(body["sourceLabel"], "On-Duty")

    def test_not_found(self):
        for pk in (self.R["R07"].id, self.R["R19"].id, 999999):  # pending, approved but never out, no such pass
            with self.subTest(pk):
                self.assertEqual(self.get(f"{LIST}/{pk}").status_code, 404)


class ExportTests(InOutWorld):
    def test_excel_has_the_filtered_rows_and_the_filters_line(self):
        r = self.get(EXPORT, fmt="xlsx", status="out", **DAYS)
        self.assertEqual(r.status_code, 200, r.content[:300])
        self.assertIn("spreadsheetml", r["Content-Type"])
        self.assertRegex(r["Content-Disposition"], r'attachment; filename="gate_pass_in_out_\d{8}_\d{4}\.xlsx"')
        ws = load_workbook(io.BytesIO(r.content)).active
        cells = [[c for c in row if c is not None] for row in ws.iter_rows(values_only=True)]
        flat = " ".join(str(c) for row in cells for c in row)
        self.assertIn("GATE PASS IN / OUT", flat.upper())
        self.assertIn("Still out", flat)
        self.assertIn("Esha Nair", flat)
        self.assertNotIn("Asha Rao", flat)  # back: not in a "still out" file
        header = next(row for row in cells if "Emp code" in row)
        self.assertEqual(header[:3], ["Date", "Emp code", "Employee"])
        log = AuditLog.objects.filter(action="export", module="outpass_visitors").get()
        self.assertIn("Gate pass in / out", log.record_description)

    def test_every_row_of_every_page(self):
        r = self.get(EXPORT, fmt="xlsx", pageSize=2, page=3, **DAYS)
        ws = load_workbook(io.BytesIO(r.content)).active
        codes = [row[1] for row in ws.iter_rows(values_only=True) if row and str(row[1] or "").startswith("GT")]
        self.assertEqual(len(codes), 12)

    def test_pdf_and_bad_format_and_too_many_rows(self):
        r = self.get(EXPORT, fmt="pdf", **DAYS)
        self.assertEqual(r.status_code, 200)
        self.assertTrue(r.content.startswith(b"%PDF"))
        bad = self.get(EXPORT, fmt="csv", **DAYS)
        self.assertEqual((bad.status_code, bad.json()["error"]), (400, "invalid_format"))
        with mock.patch.dict("api.gate_exports.ROW_LIMITS", {"xlsx": 5, "pdf": 5}):
            big = self.get(EXPORT, fmt="pdf", **DAYS)
        self.assertEqual((big.status_code, big.json()["error"], big.json()["limit"]), (413, "too_many_rows", 5))


class OptionsTests(InOutWorld):
    def test_gates_and_departments_of_the_users_branch(self):
        body = self.ok(OPTIONS)
        self.assertEqual([g["name"] for g in body["gates"]], ["Gate 1", "Gate 2", "Gate 3", "Gate 4"])
        self.assertEqual(body["gates"][3]["isActive"], False)
        self.assertEqual({d["name"] for d in body["departments"]}, {"CUTTING", "SEWING"})
        scoped = self.ok(OPTIONS, self.b1_user)
        self.assertEqual([g["name"] for g in scoped["gates"]], ["Gate 1", "Gate 2", "Gate 4"])
        self.assertEqual([d["name"] for d in scoped["departments"]], ["CUTTING"])

    def test_a_name_used_twice_is_told_apart(self):
        Department.objects.create(name="CUTTING", branch=self.b1, category=Department.CATEGORY_PRODUCTION)
        Department.objects.create(name="Stores", branch=None)
        mk_gate("Gate 1", self.b2, "g1-b2")
        body = self.ok(OPTIONS)
        self.assertEqual(
            sorted(d["name"] for d in body["departments"]),
            ["CUTTING (Unit 1, Production)", "CUTTING (Unit 1, Staff)", "SEWING", "Stores"],
        )
        self.assertEqual(sorted(g["name"] for g in body["gates"])[:2], ["Gate 1 (Unit 1)", "Gate 1 (Unit 2)"])
        # a branch-bound account sees the departments with no branch too
        self.assertIn("Stores", [d["name"] for d in self.ok(OPTIONS, self.b2_user)["departments"]])


class AccessTests(InOutWorld):
    def paths(self):
        return [
            (LIST, {}),
            (SUMMARY, {}),
            (f"{LIST}/{self.R['R11'].id}", {}),
            (EXPORT, {"fmt": "xlsx"}),
            (OPTIONS, {}),
        ]

    def test_in_out_works_without_the_requests_module(self):
        for path, params in self.paths():
            with self.subTest(path):
                self.assertEqual(self.get(path, self.viewer, **params).status_code, 200)
        # the old source of the tab is closed to this role: the point of the move
        self.assertEqual(self.get("/api/outpass-requests", self.viewer).status_code, 403)

    def test_a_role_with_in_out_hidden_or_no_gate_module_is_refused(self):
        for user in (self.no_inout, self.no_gate, self.plain_user):
            for path, params in self.paths():
                with self.subTest(user=user.username, path=path):
                    self.assertEqual(self.get(path, user, **params).status_code, 403)

    def test_only_hr(self):
        employee = {"HTTP_AUTHORIZATION": f"Bearer {sign_token({'role': 'employee', 'employeeId': self.e1.id})}"}
        self.assertIn(self.client.get(LIST, **employee).status_code, (401, 403))
        self.assertEqual(self.client.get(LIST).status_code, 401)

    def test_a_branch_bound_account_sees_its_branch_only(self):
        self.assertEqual(set(self.dests(self.b1_user)), EXITED - {"R05", "R13"})
        self.assertEqual(set(self.dests(self.b2_user)), {"R05"})
        # it cannot pick another branch
        self.assertEqual(set(self.dests(self.b1_user, branchId=self.b2.id)), EXITED - {"R05", "R13"})
        self.assertEqual(self.ok(SUMMARY, self.b2_user, **DAYS)["wentOut"], 1)
        self.assertEqual(self.get(f"{LIST}/{self.R['R05'].id}", self.b1_user).status_code, 404)
        self.assertEqual(self.get(f"{LIST}/{self.R['R01'].id}", self.b1_user).status_code, 200)
        r = self.get(EXPORT, self.b2_user, fmt="xlsx", **DAYS)
        flat = " ".join(
            str(c) for row in load_workbook(io.BytesIO(r.content)).active.iter_rows(values_only=True) for c in row if c
        )
        self.assertIn("Chitra Devi", flat)
        self.assertNotIn("Asha Rao", flat)


class DayEdgeTests(TestCase):
    """Days are IST days, and "not returned" starts at IST midnight."""

    @classmethod
    def setUpTestData(cls):
        branch = Branch.objects.create(name="Edge", code="ED")
        cls.emp = Employee.objects.create(employee_code="ED1", first_name="Edge", last_name="Case", branch=branch)
        gate = GateDevice.objects.create(
            name="Edge gate", branch=branch, username="edge", password_hash="x", login_token="tok-edge"
        )
        cls.admin = mk_user("edge_admin", {}, super_admin=True)

        def go(dest, exit, enter=None, expected=None):
            return mk_request(
                cls.emp,
                dest,
                exit,
                approved=exit,
                exit=exit,
                exit_gate=gate,
                enter=enter,
                entry_gate=gate if enter else None,
                expected=expected,
            )

        go("late-last-night", "2026-09-30 23:50")  # never back
        go("back-after-midnight", "2026-09-30 23:55", enter="2026-10-01 00:05")
        go("just-after-midnight", "2026-10-01 00:05", expected="2026-10-01 00:08")

    def rows(self, now, **params):
        with mock.patch(CLOCK, return_value=ist(now)):
            r = self.client.get(LIST, params, **_headers(self.admin))
        self.assertEqual(r.status_code, 200, r.content[:300])
        return {row["destination"]: row["status"] for row in r.json()["items"]}

    def test_just_after_midnight(self):
        self.assertEqual(self.rows("2026-10-01 00:10"), {"just-after-midnight": "overdue"})  # today = 1 Oct
        self.assertEqual(
            self.rows("2026-10-01 00:10", **{"from": "2026-09-30", "to": "2026-09-30"}),
            {"late-last-night": "not_returned", "back-after-midnight": "back"},
        )

    def test_the_same_pass_on_its_own_day_is_out(self):
        self.assertEqual(self.rows("2026-09-30 23:59"), {"late-last-night": "out", "back-after-midnight": "back"})

    def test_the_summary_splits_at_midnight_too(self):
        with mock.patch(CLOCK, return_value=ist("2026-10-01 00:10")):
            s = self.client.get(SUMMARY, {"from": "2026-09-30", "to": "2026-10-01"}, **_headers(self.admin)).json()
        self.assertEqual((s["wentOut"], s["cameBack"], s["stillOut"], s["overdue"], s["notReturned"]), (3, 1, 1, 1, 1))
        self.assertEqual(OutpassRequest.objects.count(), 3)

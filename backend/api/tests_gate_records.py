"""
The unified gate record list (gate_records.py): gate-pass scans and tea breaks merged in SQL, newest first, with every
filter, the counts, pagination, branch scope by the GATE's branch, IST day edges, and photos as signed links.

Run via: DATABASE_URL="" DB_HOST=localhost DB_TEST_NAME=test_uktex_<you> py -3 manage.py test api.tests_gate_records
"""

from __future__ import annotations

import base64
from datetime import date, datetime
from types import SimpleNamespace
from unittest import mock

from django.http import QueryDict
from django.test import TestCase

from . import gate_records as gr
from .clock import FACTORY_TZ
from .employee_photo import photo_links
from .models import (
    Branch,
    Department,
    Employee,
    GateDevice,
    OutpassGateScan,
    OutpassRequest,
    TeaBreakLog,
)

PHOTO = "data:image/png;base64," + base64.b64encode(b"\x89PNG\r\n\x1a\n" + b"0" * 40).decode()


def ist(day: int, hour: int, minute: int = 0, second: int = 0) -> datetime:
    """An instant on a November 2026 IST wall clock."""
    return datetime(2026, 11, day, hour, minute, second, tzinfo=FACTORY_TZ)


class RecordsFixture(TestCase):
    def setUp(self):
        self.unit1 = Branch.objects.create(name="GR Unit 1")
        self.unit2 = Branch.objects.create(name="GR Unit 2")
        self.dept = Department.objects.create(name="GR Weaving", branch=self.unit1)
        self.g1 = self.gate("GR Gate 1", self.unit1)
        self.g2 = self.gate("GR Gate 2", self.unit1)
        self.g3 = self.gate("GR Gate 3", self.unit2)
        self.ravi = self.person("GR001", "Ravi", "Kumar", photo_url=PHOTO)
        self.asha = self.person("GR002", "Asha", "Devi")
        self.bank = OutpassRequest.objects.create(
            employee=self.ravi, destination="Canara Bank", reason="cash", status="approved"
        )
        self.post = OutpassRequest.objects.create(
            employee=self.asha, destination="Post office", reason="letter", status="approved"
        )
        # 10 Nov (IST), oldest first
        self.exit_ok = self.scan(self.g1, self.ravi, self.bank, "exit", "success", ist(10, 9, 0), "Exit recorded")
        self.tea = TeaBreakLog.objects.create(
            employee=self.asha, out_gate=self.g2, out_at=ist(10, 10, 0), in_gate=self.g1, in_at=ist(10, 10, 12)
        )
        self.denied = self.scan(
            self.g1, self.asha, self.post, "exit", "expired", ist(10, 11, 0), "This Outpass has expired."
        )
        self.ret_ok = self.scan(self.g2, self.ravi, self.bank, "entry", "success", ist(10, 12, 0), "Return recorded")
        self.forged = self.scan(
            self.g1, None, None, "exit", "invalid_qr", ist(10, 13, 0), "This QR code is not recognized."
        )
        self.other_unit = self.scan(self.g3, self.asha, None, "exit", "success", ist(10, 14, 0), "Exit recorded")
        self.open_tea = TeaBreakLog.objects.create(employee=self.ravi, out_gate=self.g1, out_at=ist(10, 15, 0))

    def gate(self, name, branch):
        return GateDevice.objects.create(
            name=name, branch=branch, username=name.lower().replace(" ", "_"), password_hash="x", login_token=name
        )

    def person(self, code, first, last, **fields):
        return Employee.objects.create(
            employee_code=code,
            first_name=first,
            last_name=last,
            status="active",
            employment_type="staff",
            branch=self.unit1,
            department=self.dept,
            **fields,
        )

    def scan(self, gate, emp, req, scan_type, result, at, message):
        row = OutpassGateScan.objects.create(
            gate=gate, employee=emp, outpass_request=req, scan_type=scan_type, result=result, message=message
        )
        OutpassGateScan.objects.filter(pk=row.pk).update(scanned_at=at)  # scanned_at is auto_now_add
        row.refresh_from_db()
        return row

    def ids(self, **kwargs):
        kwargs.setdefault("page_size", 100)
        return [r["id"] for r in gr.records_page(None, **kwargs)["items"]]


class UnionTests(RecordsFixture):
    def test_every_source_merged_newest_first(self):
        self.assertEqual(
            self.ids(),
            [
                f"teaout-{self.open_tea.id}",
                f"scan-{self.other_unit.id}",
                f"scan-{self.forged.id}",
                f"scan-{self.ret_ok.id}",
                f"scan-{self.denied.id}",
                f"teain-{self.tea.id}",
                f"teaout-{self.tea.id}",
                f"scan-{self.exit_ok.id}",
            ],
        )

    def test_the_row_shape(self):
        items = {r["id"]: r for r in gr.records_page(None)["items"]}
        exit_row = items[f"scan-{self.exit_ok.id}"]
        self.assertEqual(
            set(exit_row),
            {"id", "at", "type", "result", "reason", "reasonLabel", "message", "gateId", "gateName", "employee"}
            | {"destination", "passId", "minutes"},
        )
        self.assertEqual(
            (exit_row["type"], exit_row["result"], exit_row["reason"], exit_row["reasonLabel"]),
            ("exit", "allowed", None, None),
        )
        self.assertEqual((exit_row["gateId"], exit_row["gateName"]), (self.g1.id, "GR Gate 1"))
        self.assertEqual((exit_row["destination"], exit_row["passId"]), ("Canara Bank", self.bank.id))
        self.assertEqual(exit_row["message"], "Exit recorded")
        self.assertEqual(datetime.fromisoformat(exit_row["at"]), ist(10, 9, 0))
        self.assertEqual(
            exit_row["employee"],
            {
                "id": self.ravi.id,
                "employeeCode": "GR001",
                "name": "Ravi Kumar",
                "department": "GR Weaving",
                "photoUrl": photo_links([self.ravi.id])[self.ravi.id],
            },
        )
        self.assertIn(f"/api/employees/{self.ravi.id}/photo?v=", exit_row["employee"]["photoUrl"])  # a signed link

        ret = items[f"scan-{self.ret_ok.id}"]
        self.assertEqual((ret["type"], ret["result"]), ("return", "allowed"))
        denied = items[f"scan-{self.denied.id}"]
        self.assertEqual(
            (denied["result"], denied["reason"], denied["reasonLabel"]), ("denied", "expired", "Pass expired")
        )
        tea_out, tea_in = items[f"teaout-{self.tea.id}"], items[f"teain-{self.tea.id}"]
        self.assertEqual((tea_out["type"], tea_out["gateName"], tea_out["minutes"]), ("tea_out", "GR Gate 2", None))
        self.assertEqual(tea_out["message"], "Tea break started")
        self.assertEqual((tea_in["type"], tea_in["gateName"], tea_in["minutes"]), ("tea_in", "GR Gate 1", 12))
        self.assertEqual(tea_in["message"], "Tea break ended after 12 min")
        self.assertEqual(tea_in["result"], "allowed")
        self.assertIsNone(tea_in["passId"])

    def test_a_denied_scan_with_no_employee(self):
        row = next(r for r in gr.records_page(None)["items"] if r["id"] == f"scan-{self.forged.id}")
        self.assertIsNone(row["employee"])
        self.assertEqual((row["reason"], row["reasonLabel"]), ("invalid_qr", "QR not recognised"))
        self.assertIsNone(row["destination"])

    def test_the_whole_answer_never_carries_a_photo(self):
        self.assertNotIn("data:", str(gr.records_page(None)))

    def test_a_removed_gate_shows_without_a_name(self):
        self.g2.delete()
        items = {r["id"]: r for r in gr.records_page(None)["items"]}
        self.assertEqual(
            (items[f"teaout-{self.tea.id}"]["gateId"], items[f"teaout-{self.tea.id}"]["gateName"]), (None, None)
        )


class FilterTests(RecordsFixture):
    def test_gate_one_or_a_comma_list_or_ids(self):
        g2_only = {f"teaout-{self.tea.id}", f"scan-{self.ret_ok.id}"}
        self.assertEqual(set(self.ids(gate_ids=self.g2.id)), g2_only)
        self.assertEqual(set(self.ids(gate_ids=str(self.g2.id))), g2_only)
        both = set(self.ids(gate_ids=f"{self.g2.id},{self.g3.id}"))
        self.assertEqual(both, g2_only | {f"scan-{self.other_unit.id}"})
        self.assertEqual(set(self.ids(gate_ids=[self.g2.id, self.g3.id])), both)
        self.assertEqual(gr.records_page(None, gate_ids=[])["items"], [])

    def test_type(self):
        self.assertEqual(
            set(self.ids(type="exit")),
            {
                f"scan-{self.exit_ok.id}",
                f"scan-{self.denied.id}",
                f"scan-{self.forged.id}",
                f"scan-{self.other_unit.id}",
            },
        )
        self.assertEqual(self.ids(type="return"), [f"scan-{self.ret_ok.id}"])
        self.assertEqual(self.ids(type="tea_in"), [f"teain-{self.tea.id}"])
        self.assertEqual(
            self.ids(type="tea_out,tea_in"),
            [f"teaout-{self.open_tea.id}", f"teain-{self.tea.id}", f"teaout-{self.tea.id}"],
        )
        self.assertEqual(self.ids(type=["return", "tea_in"]), [f"scan-{self.ret_ok.id}", f"teain-{self.tea.id}"])

    def test_result(self):
        self.assertEqual(self.ids(result="denied"), [f"scan-{self.forged.id}", f"scan-{self.denied.id}"])
        allowed = self.ids(result="allowed")
        self.assertEqual(len(allowed), 6)
        self.assertNotIn(f"scan-{self.denied.id}", allowed)
        self.assertEqual(self.ids(result="expired"), [f"scan-{self.denied.id}"])
        self.assertEqual(self.ids(result="denied", type="tea_out"), [])

    def test_search_by_name_code_and_destination(self):
        ravi = {f"scan-{self.exit_ok.id}", f"scan-{self.ret_ok.id}", f"teaout-{self.open_tea.id}"}
        self.assertEqual(set(self.ids(q="ravi")), ravi)
        self.assertEqual(set(self.ids(q="gr001")), ravi)
        self.assertEqual(set(self.ids(q="ravi kumar")), ravi)  # every word must match
        self.assertEqual(self.ids(q="ravi devi"), [])
        self.assertEqual(set(self.ids(q="canara")), {f"scan-{self.exit_ok.id}", f"scan-{self.ret_ok.id}"})
        self.assertEqual(set(self.ids(q="Post")), {f"scan-{self.denied.id}"})

    def test_branch_scope_is_the_gates_branch(self):
        unit2 = {f"scan-{self.other_unit.id}"}
        self.assertEqual({r["id"] for r in gr.records_page(self.unit2.id)["items"]}, unit2)
        scoped = SimpleNamespace(hr_branch_id=self.unit2.id)
        self.assertEqual([r["id"] for r in gr.records_page(scoped)["items"]], [f"scan-{self.other_unit.id}"])
        # a scoped user cannot widen or switch with branch_id, nor reach another branch's gate by id
        self.assertEqual([r["id"] for r in gr.records_page(scoped, branch_id=self.unit1.id)["items"]], list(unit2))
        self.assertEqual(gr.records_page(scoped, gate_ids=self.g1.id)["items"], [])
        # an unscoped user may narrow
        self.assertEqual(len(gr.records_page(SimpleNamespace(), branch_id=self.unit1.id)["items"]), 7)

    def test_a_removed_gates_rows_reach_only_unscoped_unfiltered_users(self):
        self.g1.delete()
        self.assertIn(f"scan-{self.forged.id}", self.ids())
        self.assertNotIn(f"scan-{self.forged.id}", self.ids(branch_id=self.unit1.id))
        self.assertNotIn(f"scan-{self.forged.id}", [r["id"] for r in gr.records_page(self.unit1.id)["items"]])

    def test_ist_day_edges(self):
        late = self.scan(self.g1, self.ravi, self.bank, "exit", "already_scanned", ist(9, 23, 59, 59), "Already")
        early = self.scan(self.g1, self.ravi, self.bank, "exit", "already_scanned", ist(11, 0, 0, 0), "Already")
        day10 = set(self.ids(date_from="2026-11-10", date_to="2026-11-10"))
        self.assertNotIn(f"scan-{late.id}", day10)
        self.assertNotIn(f"scan-{early.id}", day10)
        self.assertEqual(len(day10), 8)
        self.assertEqual(self.ids(date_from=date(2026, 11, 9), date_to=date(2026, 11, 9)), [f"scan-{late.id}"])
        self.assertEqual(self.ids(date_from="2026-11-11"), [f"scan-{early.id}"])
        self.assertIn(f"scan-{late.id}", self.ids(date_to="2026-11-09"))
        self.assertNotIn(f"scan-{self.exit_ok.id}", self.ids(date_to="2026-11-09"))

    def test_a_tea_break_counts_on_the_day_of_each_leg(self):
        TeaBreakLog.objects.filter(pk=self.tea.pk).update(out_at=ist(9, 23, 50), in_at=ist(10, 0, 5))
        self.assertEqual(self.ids(date_from="2026-11-09", date_to="2026-11-09"), [f"teaout-{self.tea.id}"])
        self.assertIn(f"teain-{self.tea.id}", self.ids(date_from="2026-11-10", date_to="2026-11-10"))
        row = next(r for r in gr.records_page(None)["items"] if r["id"] == f"teain-{self.tea.id}")
        self.assertEqual(row["minutes"], 15)

    def test_bad_values_are_refused_plainly(self):
        for kwargs in (
            {"date_from": "10-11-2026"},
            {"date_from": "2026-11-11", "date_to": "2026-11-10"},
            {"type": "lunch"},
            {"result": "maybe"},
            {"gate_ids": "1,x"},
        ):
            with self.subTest(kwargs=kwargs), self.assertRaises(gr.BadParam):
                gr.records_page(None, **kwargs)


class PagingAndCountTests(RecordsFixture):
    def test_pages(self):
        everything = self.ids()
        first = gr.records_page(None, page=1, page_size=3)
        second = gr.records_page(None, page=2, page_size=3)
        last = gr.records_page(None, page=3, page_size=3)
        self.assertEqual((first["total"], first["page"], first["pageSize"]), (8, 1, 3))
        self.assertEqual([r["id"] for r in first["items"] + second["items"] + last["items"]], everything)
        self.assertEqual(len(last["items"]), 2)
        self.assertEqual(gr.records_page(None, page=4, page_size=3)["items"], [])
        self.assertEqual(gr.records_page(None, page_size=1000)["pageSize"], gr.MAX_PAGE_SIZE)
        self.assertEqual(gr.records_page(None, page=0)["page"], 1)

    def test_counts_ignore_type_and_result_but_keep_the_rest(self):
        expected = {"exits": 2, "returns": 1, "teaOut": 2, "teaIn": 1, "denied": 2, "total": 8}
        self.assertEqual(gr.records_page(None)["counts"], expected)
        narrowed = gr.records_page(None, type="tea_in", result="allowed")
        self.assertEqual((narrowed["total"], narrowed["counts"]), (1, expected))
        self.assertEqual(
            gr.records_page(None, gate_ids=self.g1.id)["counts"],
            {"exits": 1, "returns": 0, "teaOut": 1, "teaIn": 1, "denied": 2, "total": 5},
        )
        self.assertEqual(gr.record_counts(None, q="asha")["total"], 4)

    def test_a_page_costs_a_fixed_number_of_queries(self):
        # union count + the page + 3 count queries + employees + gates + photo links
        with self.assertNumQueries(8):
            gr.records_page(None, page_size=5)


class ExportAndHelperTests(RecordsFixture):
    def test_export_rows_are_flat_and_in_ist(self):
        rows = gr.records_for_export(None, gate_ids=self.g1.id, page=3, page_size=1)  # paging is ignored
        self.assertEqual(len(rows), 5)
        self.assertEqual(set(rows[0]), {c["key"] for c in gr.EXPORT_COLUMNS})
        exit_row = rows[-1]
        self.assertEqual(exit_row["at"], "2026-11-10 09:00")
        self.assertEqual(
            (exit_row["gate"], exit_row["type"], exit_row["result"], exit_row["employeeName"]),
            ("GR Gate 1", "Exit", "Allowed", "Ravi Kumar"),
        )
        forged = next(r for r in rows if r["reason"])
        self.assertEqual(forged["result"], "Denied")
        self.assertEqual(len(gr.records_for_export(None, limit=3)), 3)
        self.g1.delete()
        self.assertIn(gr.REMOVED_GATE, {r["gate"] for r in gr.records_for_export(None)})

    def test_params_from_query(self):
        qd = QueryDict(
            f"gateId={self.g1.id},{self.g2.id}&from=2026-11-01&to=2026-11-10&type=exit&result=denied&q= ravi "
            "&branchId=4&page=2&pageSize=10"
        )
        params = gr.params_from_query(qd)
        self.assertEqual(params["gate_ids"], (self.g1.id, self.g2.id))
        self.assertEqual((params["date_from"], params["date_to"]), (date(2026, 11, 1), date(2026, 11, 10)))
        self.assertEqual((params["type"], params["result"], params["q"]), (("exit",), "denied", "ravi"))
        self.assertEqual((params["branch_id"], params["page"], params["page_size"]), (4, 2, 10))
        kiosk = gr.params_from_query(qd, allow_gate=False, allow_branch=False)
        self.assertNotIn("gate_ids", kiosk)
        self.assertNotIn("branch_id", kiosk)
        self.assertEqual(gr.records_page(None, **params)["total"], 0)
        with self.assertRaises(gr.BadParam):
            gr.params_from_query(QueryDict("from=yesterday"))

    def test_describe_filters(self):
        self.assertEqual(
            gr.describe_filters(
                gate_names=["GR Gate 1"],
                date_from="2026-11-01",
                date_to="2026-11-10",
                type="exit",
                result="denied",
                q="ravi",
            ),
            [
                ("Gate", "GR Gate 1"),
                ("Dates", "01-Nov-2026 to 10-Nov-2026"),
                ("Type", "Exit"),
                ("Result", "Denied"),
                ("Search", "ravi"),
            ],
        )
        self.assertEqual(
            gr.describe_filters(date_from="2026-11-10", date_to="2026-11-10"),
            [("Gate", "All gates"), ("Date", "10-Nov-2026")],
        )
        self.assertEqual(gr.counts_summary({"exits": 3})[0], {"label": "Exits", "value": 3})


class PerGateTests(RecordsFixture):
    def test_gate_counts(self):
        counts = gr.gate_counts([self.g1.id, self.g2.id, self.g3.id], "2026-11-10", "2026-11-10")
        self.assertEqual(
            counts[self.g1.id], {"exits": 1, "returns": 0, "teaOut": 1, "teaIn": 1, "denied": 2, "total": 5}
        )
        self.assertEqual(
            counts[self.g2.id], {"exits": 0, "returns": 1, "teaOut": 1, "teaIn": 0, "denied": 0, "total": 2}
        )
        self.assertEqual(counts[self.g3.id]["total"], 1)
        quiet = self.gate("GR Gate 4", self.unit1)
        self.assertEqual(gr.gate_counts([quiet.id])[quiet.id]["total"], 0)
        self.assertEqual(gr.gate_counts([self.g1.id], "2026-11-11", None)[self.g1.id]["total"], 0)
        self.assertEqual(gr.gate_counts([]), {})

    def test_last_activity(self):
        last = gr.gate_last_activity([self.g1.id, self.g2.id])
        self.assertEqual(last[self.g1.id], ist(10, 15, 0))
        self.assertEqual(last[self.g2.id], ist(10, 12, 0))
        self.assertEqual(gr.gate_last_activity([]), {})

    def test_today_at_a_gate(self):
        OutpassRequest.objects.filter(pk=self.bank.pk).update(exit_gate=self.g1, exited_at=ist(10, 9, 0))
        OutpassRequest.objects.filter(pk=self.post.pk).update(
            exit_gate=self.g1, exited_at=ist(10, 9, 30), entry_gate=self.g1, entered_at=ist(10, 10, 0)
        )
        with mock.patch("api.gate_records.ist_today", return_value=date(2026, 11, 10)):
            today = gr.gate_summary([self.g1.id])
        self.assertEqual(
            today,
            {
                "exits": 1,
                "returns": 0,
                "teaOut": 1,
                "teaIn": 1,
                "denied": 2,
                "total": 5,
                "passesOutNow": 1,
                "teaOutNow": 1,
                "outNow": 2,
            },
        )
        with mock.patch("api.gate_records.ist_today", return_value=date(2026, 11, 11)):
            self.assertEqual(gr.gate_summary([self.g1.id])["total"], 0)
        self.assertEqual(gr.gate_summary([], "2026-11-10", "2026-11-10")["outNow"], 0)


class RefusedTeaScanTests(RecordsFixture):
    """C1 (19 Nov 2026): a tea-break code refused by a gate that does not take tea breaks is a denied scan of type
    "tea": the records list it as a denied tea break ("tea_out"), never as an exit."""

    def setUp(self):
        super().setUp()
        self.refused = self.scan(
            self.g1,
            self.ravi,
            None,
            "tea",
            "not_allowed_here",
            ist(10, 16, 0),
            "This gate does not take tea-break scans.",
        )

    def test_it_is_a_denied_tea_row(self):
        row = next(r for r in gr.records_page(None)["items"] if r["id"] == f"scan-{self.refused.id}")
        self.assertEqual(
            (row["type"], row["result"], row["reason"], row["reasonLabel"], row["message"]),
            (
                "tea_out",
                "denied",
                "not_allowed_here",
                "Not allowed at this gate",
                "This gate does not take tea-break scans.",
            ),
        )

    def test_the_tea_filters_include_it_and_exit_never_does(self):
        tea = self.ids(type="tea_out")
        self.assertIn(f"scan-{self.refused.id}", tea)
        self.assertIn(f"teaout-{self.tea.id}", tea)
        self.assertIn(f"scan-{self.refused.id}", self.ids(type="tea_out,tea_in", result="denied"))
        self.assertEqual(self.ids(type="tea_out", result="denied"), [f"scan-{self.refused.id}"])
        self.assertEqual(self.ids(type="tea_out", result="not_allowed_here"), [f"scan-{self.refused.id}"])
        self.assertNotIn(f"scan-{self.refused.id}", self.ids(type="exit"))
        self.assertNotIn(f"scan-{self.refused.id}", self.ids(type="exit,return"))
        self.assertNotIn(f"scan-{self.refused.id}", self.ids(type="tea_out", result="allowed"))
        self.assertIn(f"scan-{self.refused.id}", self.ids())  # every type

    def test_it_counts_as_denied_not_as_an_exit(self):
        counts = gr.record_counts(None, gate_ids=self.g1.id, date_from="2026-11-10", date_to="2026-11-10")
        self.assertEqual((counts["exits"], counts["denied"]), (1, 3))
        exported = [r for r in gr.records_for_export(None, gate_ids=self.g1.id) if r["result"] == "Denied"]
        self.assertIn(("Tea break out", "Not allowed at this gate"), [(r["type"], r["reason"]) for r in exported])


class AlreadyScannedTextTests(RecordsFixture):
    """C3 (19 Nov 2026): the "already scanned" text is in India time, also for a row stored with the UTC clock."""

    def test_a_stored_utc_text_is_written_again_in_india_time(self):
        OutpassRequest.objects.filter(pk=self.bank.pk).update(exit_gate=self.g1, exited_at=ist(10, 15, 45))
        stored = self.scan(
            self.g2,
            self.ravi,
            self.bank,
            "exit",
            "already_scanned",
            ist(10, 16, 0),
            "Already exited at 10:15 AM via GR Gate 1",
        )
        row = next(r for r in gr.records_page(None)["items"] if r["id"] == f"scan-{stored.id}")
        self.assertEqual(row["message"], "Already exited at 03:45 PM via GR Gate 1")
        flat = next(r for r in gr.records_for_export(None, gate_ids=self.g2.id) if r["reason"] == "Already scanned")
        self.assertEqual(flat["message"], "Already exited at 03:45 PM via GR Gate 1")
        self.assertEqual(gr.already_scanned_message(True, ist(10, 0, 5), None), "Already returned at 12:05 AM")


class OutNowTests(RecordsFixture):
    def test_out_now_leaves_early_dismissal_passes_out(self):
        # C4 (19 Nov 2026): an early-dismissal pass is not expected back, like In/Out's "Still out"
        OutpassRequest.objects.filter(pk=self.bank.pk).update(exit_gate=self.g1, exited_at=ist(10, 9, 0))
        OutpassRequest.objects.filter(pk=self.post.pk).update(
            exit_gate=self.g1, exited_at=ist(10, 9, 30), pass_type=OutpassRequest.PASS_TYPE_EARLY_DISMISSAL
        )
        with mock.patch("api.gate_records.ist_today", return_value=date(2026, 11, 10)):
            today = gr.gate_summary([self.g1.id])
        self.assertEqual((today["passesOutNow"], today["teaOutNow"], today["outNow"]), (1, 1, 2))

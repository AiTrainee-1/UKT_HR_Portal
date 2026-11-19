"""
The shared Excel / PDF helper of the gate pages (gate_exports.py): real files from the Report Center writers, the row
limits (413), a bad format (400), the file name and the audit row.

Run via: DATABASE_URL="" DB_HOST=localhost DB_TEST_NAME=test_uktex_<you> py -3 manage.py test api.tests_gate_exports
"""

from __future__ import annotations

import io
import re
from datetime import datetime
from types import SimpleNamespace
from unittest import mock

from django.test import TestCase
from openpyxl import load_workbook
from rest_framework.test import APIRequestFactory

from . import gate_exports as ge
from .clock import FACTORY_TZ
from .models import AuditLog

COLUMNS = [
    {"key": "at", "label": "Date and time", "type": "datetime"},
    {"key": "day", "label": "Day", "type": "date"},
    {"key": "name", "label": "Employee", "type": "text"},
    {"key": "count", "label": "Scans", "type": "int"},
    {"key": "minutes", "label": "Break minutes", "type": "minutes"},
]


def rows(n: int) -> list[dict]:
    at = datetime(2026, 11, 18, 9, 5, tzinfo=FACTORY_TZ)
    return [
        {"at": at, "day": at.date(), "name": f"Person {i}", "count": i, "minutes": None if i % 2 else 12, "extra": "x"}
        for i in range(1, n + 1)
    ]


class FileResponseTests(TestCase):
    def setUp(self):
        request = APIRequestFactory().get("/api/gate-devices/records/export")
        request.jwt_user = {"role": "hr", "name": "Export Tester"}
        self.request = request

    def make(self, fmt, data, **kwargs):
        kwargs.setdefault("filters_text", [("Gate", "Gate 1"), ("Dates", "01-Nov-2026 to 18-Nov-2026")])
        return ge.file_response(
            self.request,
            slug="Gate records - Gate 1",
            title="Gate records",
            columns=COLUMNS,
            rows=data,
            fmt=fmt,
            **kwargs,
        )

    def test_an_excel_file_with_every_row(self):
        response = self.make("XLSX", rows(3), summary=[{"label": "Exits", "value": 3}])
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response["Content-Type"], ge.XLSX_MIME)
        self.assertRegex(
            response["Content-Disposition"], r'^attachment; filename="gate_records_gate_1_\d{8}_\d{4}\.xlsx"$'
        )
        self.assertEqual(response["Cache-Control"], "no-store")
        sheet = load_workbook(io.BytesIO(response.content)).active
        values = [[c for c in row] for row in sheet.iter_rows(values_only=True)]
        header_at = next(i for i, r in enumerate(values) if r and r[0] == "Date and time")
        self.assertEqual(list(values[header_at]), ["Date and time", "Day", "Employee", "Scans", "Break minutes"])
        data = values[header_at + 1 : header_at + 4]
        self.assertEqual([r[2] for r in data], ["Person 1", "Person 2", "Person 3"])
        self.assertEqual([r[3] for r in data], [1, 2, 3])
        self.assertEqual(data[0][0], datetime(2026, 11, 18, 9, 5))  # IST wall clock, a real Excel date-time
        self.assertEqual([r[4] for r in data], [None, 12, None])
        text = " ".join(str(c) for r in values for c in r if c)
        self.assertIn("GATE RECORDS", text)
        self.assertIn("Gate: Gate 1", text)
        self.assertIn("Export Tester", text)

    def test_a_pdf_file(self):
        response = self.make("pdf", rows(4), summary={"Exits": 4, "Denied": 0})
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response["Content-Type"], ge.PDF_MIME)
        self.assertTrue(response.content.startswith(b"%PDF"))
        self.assertTrue(response["Content-Disposition"].endswith('.pdf"'))

    def test_an_empty_file_is_still_a_file(self):
        self.assertTrue(self.make("pdf", []).content.startswith(b"%PDF"))
        self.assertEqual(self.make("xlsx", [], filters_text="").status_code, 200)

    def test_too_many_rows_is_a_413_and_no_file(self):
        with mock.patch.dict(ge.ROW_LIMITS, {"pdf": 3, "xlsx": 5}):
            pdf = self.make("pdf", rows(4))
            xlsx = self.make("xlsx", rows(6))
            fine = self.make("xlsx", rows(5))
        for response, limit in ((pdf, 3), (xlsx, 5)):
            self.assertEqual(response.status_code, 413)
            self.assertEqual(
                response.data,
                {"error": "too_many_rows", "message": "Too many rows for one file. Narrow the dates.", "limit": limit},
            )
        self.assertEqual(fine.status_code, 200)
        self.assertEqual(ge.ROW_LIMITS, {"xlsx": 30_000, "pdf": 5_000})

    def test_a_bad_format_is_a_400(self):
        for fmt in ("csv", "", None):
            with self.subTest(fmt=fmt):
                response = self.make(fmt, rows(1))
                self.assertEqual(response.status_code, 400)
                self.assertEqual(response.data["error"], "invalid_format")

    def test_every_file_is_audit_logged_and_a_failure_is_not(self):
        self.make("xlsx", rows(2))
        log = AuditLog.objects.get()
        self.assertEqual((log.action, log.module, log.user_name), ("export", "outpass_visitors", "Export Tester"))
        self.assertIn("Gate records - XLSX - 2 rows", log.record_description)
        self.assertIn("Gate: Gate 1", log.record_description)
        self.make("pdf", rows(1), log_module="tea_break_test", log_description="Tea breaks, 1 row")
        self.assertEqual(AuditLog.objects.filter(module="tea_break_test").get().record_description, "Tea breaks, 1 row")
        with mock.patch("api.gate_exports.build_xlsx", side_effect=RuntimeError("boom")):
            failed = self.make("xlsx", rows(1))
        self.assertEqual(failed.status_code, 500)
        self.assertEqual(failed.data["error"], "export_failed")
        self.assertEqual(AuditLog.objects.count(), 2)

    def test_the_filters_line_from_a_string(self):
        self.assertEqual(ge._filters("Gate: Gate 1 | Type: Exit"), [("Gate", "Gate 1"), ("Type", "Exit")])
        self.assertEqual(ge._filters("today only"), [("Filters", "today only")])
        self.assertEqual(ge._filters(""), [])

    def test_a_gate_monitor_file_names_the_gate(self):
        request = APIRequestFactory().get("/api/gate-monitor/records/export")
        request.jwt_user = {"role": "gate_device", "deviceId": 1, "gateName": "Old name"}
        request.gate_device = SimpleNamespace(name="Gate 1")
        self.assertEqual(ge._generated_by(request), "Gate monitor - Gate 1")

    def test_an_unknown_column_type_is_a_programming_error(self):
        with self.assertRaises(ValueError):
            ge.build_file(title="x", columns=[{"key": "a", "label": "A", "type": "money"}], rows=[], fmt="xlsx")

    def test_the_slug_is_safe(self):
        response = ge.file_response(
            self.request, slug="../../etc/passwd", title="T", columns=COLUMNS, rows=[], fmt="xlsx"
        )
        name = re.search(r'filename="([^"]+)"', response["Content-Disposition"]).group(1)
        self.assertTrue(name.startswith("etc_passwd_"))

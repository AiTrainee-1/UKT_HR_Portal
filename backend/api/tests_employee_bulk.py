"""Bulk employee upload / update (employee_bulk_views.py): the Staff and Production layouts, the per-row report, the
check-only preview, and what happens to employees who are missing from an update file (never anything unasked)."""

import io
import json
from decimal import Decimal

import openpyxl
from django.core.files.uploadedfile import SimpleUploadedFile
from django.test import SimpleTestCase, TestCase

from . import salary_split
from .employee_bulk_views import (
    EMPLOYEE_UPLOAD_HEADERS,
    PRODUCTION_UPLOAD_HEADERS,
    SPLIT_HEADERS,
    STAFF_UPLOAD_HEADERS,
    STATUS_HEADER,
)
from .jwt_utils import sign_token
from .models import AttendanceDayRecord, AuditLog, Branch, Department, Employee, HRUser

STAFF_EXPORT = STAFF_UPLOAD_HEADERS + [STATUS_HEADER]
PRODUCTION_EXPORT = PRODUCTION_UPLOAD_HEADERS + [STATUS_HEADER]


def _sheet(headers, rows):
    wb = openpyxl.Workbook()
    ws = wb.active
    ws.append(headers)
    for row in rows:
        ws.append(row)
    buf = io.BytesIO()
    wb.save(buf)
    return SimpleUploadedFile("employees.xlsx", buf.getvalue(), content_type="application/vnd.ms-excel")


def _row(headers, **cells):
    row = {h: None for h in headers}
    row.update(cells)
    return [row[h] for h in headers]


class LayoutTests(SimpleTestCase):
    def test_staff_has_the_salary_columns_and_production_the_per_shift_one(self):
        for header in ("Salary Type", "Salary Amount", *SPLIT_HEADERS):
            self.assertIn(header, STAFF_UPLOAD_HEADERS)
            self.assertNotIn(header, PRODUCTION_UPLOAD_HEADERS)
        self.assertIn("Salary Per Shift", PRODUCTION_UPLOAD_HEADERS)
        self.assertNotIn("Salary Per Shift", STAFF_UPLOAD_HEADERS)

    def test_neither_layout_has_an_employment_type_column_the_section_decides_it(self):
        self.assertNotIn("Employment Type", STAFF_UPLOAD_HEADERS)
        self.assertNotIn("Employment Type", PRODUCTION_UPLOAD_HEADERS)
        self.assertIn("Employment Type", EMPLOYEE_UPLOAD_HEADERS)  # the older combined sheet still has it

    def test_both_start_with_the_same_identity_and_job_columns_and_end_with_the_same_personal_ones(self):
        self.assertEqual(STAFF_UPLOAD_HEADERS[:11], PRODUCTION_UPLOAD_HEADERS[:11])
        self.assertEqual(STAFF_UPLOAD_HEADERS[-12:], PRODUCTION_UPLOAD_HEADERS[-12:])


class Base(TestCase):
    def setUp(self):
        user, _ = HRUser.objects.get_or_create(
            username="bulk_admin", defaults={"password_hash": "x", "is_super_admin": True}
        )
        self.hr = {"HTTP_AUTHORIZATION": f"Bearer {sign_token({'role': 'hr', 'hrUserId': user.id})}"}
        self.branch = Branch.objects.create(name="Head Office")
        self.dept = Department.objects.create(name="Stitching", branch=self.branch)

    def person(self, code, kind="staff", status="active", **extra):
        defaults = dict(
            employee_code=code,
            first_name=f"First{code}",
            last_name="Last",
            phone="9000000000",
            employment_type=kind,
            status=status,
            branch=self.branch,
            department=self.dept,
            salary_type="monthly",
            salary_amount="24000" if kind == "staff" else None,
            salary_per_shift="400" if kind == "production" else None,
        )
        defaults.update(extra)
        return Employee.objects.create(**defaults)

    def upload(self, headers, rows, **fields):
        return self.client.post("/api/employees/bulk-upload", {"file": _sheet(headers, rows), **fields}, **self.hr)

    def update(self, headers, rows, **fields):
        return self.client.post("/api/employees/bulk-update", {"file": _sheet(headers, rows), **fields}, **self.hr)

    def staff_row(self, code, **cells):
        base = {
            "Employee Code": code,
            "First Name": "Asha",
            "Last Name": code,
            "Branch": "Head Office",
            "Salary Amount": 24000,
        }
        return _row(STAFF_UPLOAD_HEADERS, **{**base, **cells})

    def production_row(self, code, **cells):
        base = {
            "Employee Code": code,
            "First Name": "Ravi",
            "Last Name": code,
            "Branch": "Head Office",
            "Salary Per Shift": 450,
        }
        return _row(PRODUCTION_UPLOAD_HEADERS, **{**base, **cells})

    def by_row(self, body):
        return {r["row"]: r for r in body["rows"]}


class CreateTests(Base):
    def test_a_staff_sheet_creates_staff_with_the_automatic_split(self):
        r = self.upload(STAFF_UPLOAD_HEADERS, [self.staff_row("S1")], category="staff")
        self.assertEqual(r.status_code, 201, r.content)
        emp = Employee.objects.get(employee_code="S1")
        self.assertEqual((emp.employment_type, emp.status), ("staff", "active"))
        parts = salary_split.breakup_of(emp)
        self.assertEqual(sum(parts[c] for c in salary_split.FIRST_PORTION), Decimal("12000.00"))  # half of 24,000
        self.assertEqual(r.json()["counts"]["created"], 1)

    def test_a_production_sheet_creates_production_paid_per_shift(self):
        r = self.upload(PRODUCTION_UPLOAD_HEADERS, [self.production_row("P1")], category="production")
        self.assertEqual(r.status_code, 201, r.content)
        emp = Employee.objects.get(employee_code="P1")
        self.assertEqual(emp.employment_type, "production")
        self.assertEqual(str(emp.salary_per_shift), "450.00")

    def test_a_production_sheet_in_the_staff_section_is_refused_with_a_clear_message(self):
        r = self.upload(PRODUCTION_UPLOAD_HEADERS, [self.production_row("P2")], category="staff")
        self.assertEqual(r.status_code, 400)
        self.assertEqual(r.json()["error"], "invalid_template")
        self.assertIn("Production sheet", r.json()["message"])
        self.assertFalse(Employee.objects.filter(employee_code="P2").exists())

    def test_the_older_combined_sheet_still_works_without_a_section_and_must_agree_with_one(self):
        cells = {"Employee Code": "L1", "First Name": "Old", "Employment Type": "Production", "Branch": "Head Office"}
        r = self.upload(EMPLOYEE_UPLOAD_HEADERS, [_row(EMPLOYEE_UPLOAD_HEADERS, **cells)])
        self.assertEqual(r.json()["created"], 1, r.json())
        self.assertEqual(Employee.objects.get(employee_code="L1").employment_type, "production")
        clash = self.upload(
            EMPLOYEE_UPLOAD_HEADERS,
            [_row(EMPLOYEE_UPLOAD_HEADERS, **{**cells, "Employee Code": "L2"})],
            category="staff",
        )
        row = self.by_row(clash.json())[2]
        self.assertEqual(row["status"], "invalid")
        self.assertIn("Production employee", row["messages"][0])
        self.assertFalse(Employee.objects.filter(employee_code="L2").exists())

    def test_every_outcome_is_reported_per_row_with_its_reason(self):
        self.person("EXISTS", first_name="Meena", last_name="Raj")
        rows = [
            self.staff_row("NEW1"),
            self.staff_row("EXISTS"),  # already in the system
            self.staff_row("NEW1"),  # twice in the file
            self.staff_row("BAD1", Gender="Robot"),
            self.staff_row(
                "BAD2", **{"Branch": "Head Office", "Salary Amount": 43000, "Basic": 1}
            ),  # a split that is not 50/50
            self.staff_row("SAMPLE001"),
            self.staff_row(""),
            [None] * len(STAFF_UPLOAD_HEADERS),  # blank: not a record at all
        ]
        body = self.upload(STAFF_UPLOAD_HEADERS, rows, category="staff").json()
        got = self.by_row(body)
        self.assertEqual(
            [got[n]["status"] for n in sorted(got)],
            ["created", "duplicate", "duplicate", "invalid", "invalid", "skipped", "invalid"],
        )
        self.assertIn("already exists (Meena Raj, Staff, Active)", got[3]["messages"][0])
        self.assertIn("repeated: first on row 2", got[4]["messages"][0])
        self.assertIn("Gender must be Male, Female or Other", got[5]["messages"][0])
        self.assertIn("Sample row", got[7]["messages"][0])
        self.assertEqual(
            body["counts"],
            {
                "created": 1,
                "updated": 0,
                "unchanged": 0,
                "duplicate": 2,
                "invalid": 3,
                "failed": 0,
                "skipped": 1,
                "notFound": 0,
            },
        )
        # the older summary fields are still there, for any client that reads them
        self.assertEqual((body["created"], body["failed"], body["sampleRowsSkipped"]), (1, 5, 1))
        self.assertTrue(body["errors"][0].startswith("Row 3: "))

    def test_missing_pay_is_a_warning_not_an_error(self):
        body = self.upload(
            PRODUCTION_UPLOAD_HEADERS, [self.production_row("P3", **{"Salary Per Shift": None})], category="production"
        ).json()
        row = self.by_row(body)[2]
        self.assertEqual(row["status"], "created")
        self.assertIn("Salary Per Shift is blank", row["warnings"][0])


class NumbersInTheSheetTests(Base):
    """Excel turns a code or a phone number into a number when it is converted or retyped; that must not matter."""

    def test_codes_and_phones_that_are_numbers_read_the_same_as_text(self):
        self.person("2950", phone="8870139942")
        cells = {"Employee Code": 2950.0, "Phone": 8870139999.0, "Bank Account": 123456789012345}
        r = self.update(STAFF_EXPORT, [_row(STAFF_EXPORT, **cells)], category="staff", employeeStatus="active")
        body = r.json()
        self.assertEqual(self.by_row(body)[2]["status"], "updated", body)
        emp = Employee.objects.get(employee_code="2950")
        self.assertEqual((emp.phone, emp.bank_account), ("8870139999", "123456789012345"))

    def test_a_new_employee_whose_code_and_phone_are_numbers(self):
        row = self.staff_row("0", **{"Employee Code": 30099.0, "Phone": 9876543210.0})
        r = self.upload(STAFF_UPLOAD_HEADERS, [row], category="staff")
        self.assertEqual(r.json()["counts"]["created"], 1, r.json())
        emp = Employee.objects.get(employee_code="30099")
        self.assertEqual(emp.phone, "9876543210")

    def test_the_same_number_twice_is_a_duplicate_whatever_its_type(self):
        rows = [self.staff_row("0", **{"Employee Code": 777.0}), self.staff_row("777")]
        body = self.upload(STAFF_UPLOAD_HEADERS, rows, category="staff").json()
        self.assertEqual([r["status"] for r in body["rows"]], ["created", "duplicate"])


class PreviewTests(Base):
    def test_a_check_reports_exactly_what_an_import_would_do_and_writes_nothing(self):
        rows = [self.staff_row("C1"), self.staff_row("C2", Gender="Robot")]
        before_audit = AuditLog.objects.count()
        body = self.upload(STAFF_UPLOAD_HEADERS, rows, category="staff", mode="preview").json()
        self.assertTrue(body["preview"])
        self.assertEqual((body["counts"]["created"], body["counts"]["invalid"]), (1, 1))
        self.assertFalse(Employee.objects.filter(employee_code="C1").exists())
        self.assertEqual(AuditLog.objects.count(), before_audit)
        # importing for real gives the same report
        real = self.upload(STAFF_UPLOAD_HEADERS, rows, category="staff").json()
        self.assertFalse(real["preview"])
        self.assertEqual(real["counts"], body["counts"])
        self.assertTrue(Employee.objects.filter(employee_code="C1").exists())

    def test_a_check_of_an_update_changes_nothing_either(self):
        self.person("U1")
        r = self.update(
            STAFF_EXPORT,
            [_row(STAFF_EXPORT, **{"Employee Code": "U1", "Phone": "9111111111"})],
            category="staff",
            employeeStatus="active",
            mode="preview",
        )
        self.assertEqual(self.by_row(r.json())[2]["status"], "updated")
        self.assertEqual(Employee.objects.get(employee_code="U1").phone, "9000000000")


class UpdateTests(Base):
    def test_each_row_says_updated_unchanged_or_why_it_could_not_be(self):
        self.person("A1")
        self.person("A2")
        self.person("PR1", kind="production")
        self.person("OLD1", status="inactive")
        rows = [
            _row(STAFF_EXPORT, **{"Employee Code": "A1", "Phone": "9222222222"}),
            _row(STAFF_EXPORT, **{"Employee Code": "A2"}),
            _row(STAFF_EXPORT, **{"Employee Code": "GHOST"}),
            _row(STAFF_EXPORT, **{"Employee Code": "PR1"}),
            _row(STAFF_EXPORT, **{"Employee Code": "OLD1"}),
            _row(STAFF_EXPORT, **{"Employee Code": "A1", "Phone": "9"}),
            _row(STAFF_EXPORT, **{"Employee Code": "A2", "Gender": "Robot"}),
        ]
        body = self.update(STAFF_EXPORT, rows, category="staff", employeeStatus="active").json()
        got = self.by_row(body)
        self.assertEqual(got[2]["status"], "updated")
        self.assertEqual(got[2]["changes"], ["Phone"])
        self.assertEqual(got[3]["status"], "unchanged")
        self.assertEqual(got[4]["status"], "not_found")
        self.assertEqual(got[5]["status"], "invalid")
        self.assertIn("Production active employees", got[5]["messages"][0])
        self.assertEqual(got[6]["status"], "invalid")
        self.assertIn("Staff inactive employees", got[6]["messages"][0])
        self.assertEqual(got[7]["status"], "duplicate")
        self.assertEqual(got[8]["status"], "duplicate")
        self.assertEqual(Employee.objects.get(employee_code="A1").phone, "9222222222")
        self.assertEqual(body["counts"]["updated"], 1)
        self.assertEqual(body["counts"]["notFound"], 1)

    def test_the_status_column_makes_someone_inactive_or_active_again(self):
        self.person("S1")
        self.person("S2", status="inactive")
        r = self.update(
            STAFF_EXPORT,
            [_row(STAFF_EXPORT, **{"Employee Code": "S1", "Status": "Inactive"})],
            category="staff",
            employeeStatus="active",
        )
        self.assertEqual(self.by_row(r.json())[2]["changes"], ["Status"])
        self.assertEqual(Employee.objects.get(employee_code="S1").status, "inactive")
        r = self.update(
            STAFF_EXPORT,
            [_row(STAFF_EXPORT, **{"Employee Code": "S2", "Status": "Active"})],
            category="staff",
            employeeStatus="inactive",
        )
        self.assertEqual(Employee.objects.get(employee_code="S2").status, "active")
        bad = self.update(
            STAFF_EXPORT,
            [_row(STAFF_EXPORT, **{"Employee Code": "S2", "Status": "Gone"})],
            category="staff",
            employeeStatus="active",
        )
        self.assertIn("Status must be Active or Inactive", self.by_row(bad.json())[2]["messages"][0])

    def test_the_kind_cannot_be_changed_from_a_section(self):
        self.person("K1")
        cells = {"Employee Code": "K1", "Employment Type": "Production"}
        r = self.update(
            EMPLOYEE_UPLOAD_HEADERS, [_row(EMPLOYEE_UPLOAD_HEADERS, **cells)], category="staff", employeeStatus="active"
        )
        self.assertEqual(self.by_row(r.json())[2]["status"], "invalid")
        self.assertEqual(Employee.objects.get(employee_code="K1").employment_type, "staff")

    def test_without_a_section_the_older_update_behaves_as_before(self):
        self.person("O1")
        self.person("O2")
        r = self.update(
            EMPLOYEE_UPLOAD_HEADERS, [_row(EMPLOYEE_UPLOAD_HEADERS, **{"Employee Code": "O1", "Phone": "9333333333"})]
        )
        body = r.json()
        self.assertEqual((body["updated"], body["unchanged"]), (1, 0))
        self.assertEqual(body["missing"], [])  # nobody is "missing" from a file that is not a list of anyone
        self.assertEqual(Employee.objects.filter(status="active").count(), 2)


class MissingEmployeesTests(Base):
    def setUp(self):
        super().setUp()
        for code in ("M1", "M2", "M3"):
            self.person(code)
        self.person("MP1", kind="production")
        self.person("MI1", status="inactive")
        self.file_rows = [_row(STAFF_EXPORT, **{"Employee Code": "M1"})]  # only M1 is in the file

    def run_update(self, **fields):
        return self.update(STAFF_EXPORT, self.file_rows, category="staff", employeeStatus="active", **fields)

    def test_the_check_lists_who_is_missing_among_the_same_kind_only_and_changes_nothing(self):
        AttendanceDayRecord.objects.create(
            employee=Employee.objects.get(employee_code="M2"), date="2026-09-01", status="present"
        )
        body = self.run_update(mode="preview").json()
        self.assertEqual([m["code"] for m in body["missing"]], ["M2", "M3"])  # not production MP1, not inactive MI1
        self.assertEqual(body["missing"][0]["dataCounts"], {"attendance": 1, "payroll": 0, "leaves": 0})
        self.assertEqual(body["scope"], {"category": "staff", "employeeStatus": "active", "total": 3, "inFile": 1})
        self.assertEqual(Employee.objects.filter(status="active", employment_type="staff").count(), 3)

    def test_by_default_nobody_is_touched(self):
        body = self.run_update().json()
        self.assertEqual(body["counts"]["kept"], 2)
        self.assertEqual(Employee.objects.filter(status="active", employment_type="staff").count(), 3)
        self.assertEqual({m["result"] for m in body["missing"]}, {"Left unchanged"})

    def test_make_inactive_keeps_the_person_and_all_their_data(self):
        AttendanceDayRecord.objects.create(
            employee=Employee.objects.get(employee_code="M2"), date="2026-09-01", status="present"
        )
        body = self.run_update(missingAction="inactive").json()
        self.assertEqual(body["counts"]["madeInactive"], 2)
        self.assertEqual(Employee.objects.get(employee_code="M2").status, "inactive")
        self.assertEqual(Employee.objects.get(employee_code="M1").status, "active")
        self.assertEqual(AttendanceDayRecord.objects.count(), 1)

    def test_delete_needs_an_explicit_confirmation(self):
        refused = self.run_update(missingAction="delete")
        self.assertEqual(refused.status_code, 400)
        self.assertIn("confirmDelete", refused.json()["error"])
        self.assertEqual(Employee.objects.filter(employment_type="staff", status="active").count(), 3)

    def test_confirmed_delete_removes_the_person_and_their_data(self):
        AttendanceDayRecord.objects.create(
            employee=Employee.objects.get(employee_code="M2"), date="2026-09-01", status="present"
        )
        body = self.run_update(missingAction="delete", confirmDelete="true").json()
        self.assertEqual(body["counts"]["deleted"], 2)
        self.assertFalse(Employee.objects.filter(employee_code__in=["M2", "M3"]).exists())
        self.assertEqual(AttendanceDayRecord.objects.count(), 0)
        self.assertTrue(Employee.objects.filter(employee_code__in=["M1", "MP1", "MI1"]).count() == 3)
        self.assertTrue(AuditLog.objects.filter(action="delete", record_description__contains="M2").exists())

    def test_each_person_can_have_their_own_decision(self):
        decisions = json.dumps({"M2": "inactive", "M3": "delete"})
        body = self.run_update(missingDecisions=decisions, confirmDelete="true").json()
        self.assertEqual((body["counts"]["madeInactive"], body["counts"]["deleted"]), (1, 1))
        self.assertEqual(Employee.objects.get(employee_code="M2").status, "inactive")
        self.assertFalse(Employee.objects.filter(employee_code="M3").exists())

    def test_a_check_ignores_decisions_and_never_deletes(self):
        self.run_update(mode="preview", missingAction="delete", confirmDelete="true")
        self.assertEqual(Employee.objects.filter(employment_type="staff", status="active").count(), 3)

    def test_for_inactive_employees_the_choices_are_keep_or_delete_only(self):
        self.person("MI2", status="inactive")
        rows = [_row(STAFF_EXPORT, **{"Employee Code": "MI1"})]
        wrong = self.update(STAFF_EXPORT, rows, category="staff", employeeStatus="inactive", missingAction="inactive")
        self.assertEqual(wrong.status_code, 400)
        ok = self.update(
            STAFF_EXPORT,
            rows,
            category="staff",
            employeeStatus="inactive",
            missingAction="delete",
            confirmDelete="true",
        )
        self.assertEqual(ok.json()["counts"]["deleted"], 1)
        self.assertFalse(Employee.objects.filter(employee_code="MI2").exists())
        self.assertTrue(Employee.objects.filter(employee_code="MI1").exists())

    def test_an_unknown_choice_is_refused_before_anything_changes(self):
        r = self.run_update(missingAction="vanish")
        self.assertEqual(r.status_code, 400)
        r = self.run_update(missingDecisions="not json")
        self.assertEqual(r.status_code, 400)
        r = self.run_update(missingDecisions=json.dumps({"M2": "teleport"}))
        self.assertEqual(r.status_code, 400)

    def test_a_file_with_no_employee_rows_never_lists_everyone_as_missing(self):
        r = self.update(STAFF_EXPORT, [], category="staff", employeeStatus="active", mode="preview")
        self.assertEqual(r.json()["missing"], [])

    def test_someone_in_the_file_who_failed_validation_is_not_missing(self):
        rows = [
            _row(STAFF_EXPORT, **{"Employee Code": "M1"}),
            _row(STAFF_EXPORT, **{"Employee Code": "M2", "Gender": "Robot"}),
        ]
        body = self.update(STAFF_EXPORT, rows, category="staff", employeeStatus="active", mode="preview").json()
        self.assertEqual([m["code"] for m in body["missing"]], ["M3"])

"""
Endpoint Sharing: the dataset catalog (api/shared_datasets.py).

What is pinned here
-------------------
* The catalog is a whitelist: no field key or column carries a hard-excluded word (password, token, otp, aadhaar, pan, bank,
  uan, pf, esi, photo, secret ...), none of the columns is a known sensitive model column, every column really exists on the
  real model, every declared type / sensitivity is valid, and a deliberately bad definition is a start-up error.
* Every getter reads ONLY the columns it declares (proved with a recording wrapper over a real row), returns exactly the
  declared type, and a page costs a constant number of queries (1 row == 60 rows) for every dataset with every field selected.
* The row query never reads an unshared column: the SQL names none of the hard-excluded columns.
* The filters: typed strict ASCII parsers (tables of good and hostile values: SQL text, unicode digits, NUL, huge numbers),
  unknown / locked / required / default rules, the date-range limits (31 / 7 days), and the semantics of each dataset's
  filters against real rows.
* Units: money is a two-decimal number, dates ISO, times HH:MM:SS, text dates normalised, device serials never leave.

Run via: python manage.py test api.tests_shared_datasets
"""

import re
from datetime import date, time
from decimal import Decimal

from django.db import connection, models
from django.test import SimpleTestCase, TestCase
from django.test.utils import CaptureQueriesContext

from . import shared_datasets as sd
from .models import (
    AttendanceDayRecord,
    AttendanceLog,
    Branch,
    Department,
    Designation,
    Employee,
    Holiday,
    LeaveRequest,
    LeaveType,
    Payroll,
)

#: columns that must never be shared, by (model, column): the schema's real sensitive columns
HARD_EXCLUDED_COLUMNS = {
    "password_hash",
    "bank_name",
    "bank_account",
    "bank_ifsc",
    "id_proof",
    "pf_number",
    "esi_number",
    "uan_number",
    "photo_url",
    "biometric_device_id",
    "emergency_contact",
    "last_mobile_login_at",
    "password_updated_at",
    "co_emp_enabled",
    "location_tracking_enabled",
    "father_name",
    "mother_name",
    "blood_group",
    "initial_salary",
}

#: field-key words the spec names as never exposed
SPEC_WORDS = ("password", "token", "otp", "aadhaar", "pan", "bank", "uan", "pf", "esi", "photo", "secret")


def resolve_column(model, column: str) -> models.Field:
    """The real model field a column path ("employee__department__name") ends at (FieldDoesNotExist if it is made up)."""
    current = model
    field = None
    for part in column.split("__"):
        field = current._meta.get_field(part)
        if field.is_relation:
            current = field.related_model
    return field


class CatalogTests(SimpleTestCase):
    def test_the_v1_datasets_exist(self):
        self.assertEqual(
            set(sd.DATASETS),
            {
                "employees",
                "departments",
                "branches",
                "designations",
                "attendance-days",
                "attendance-punches",
                "leave-requests",
                "holidays",
                "payroll-summary",
            },
        )

    def test_no_field_or_column_is_named_like_a_secret(self):
        for ds in sd.DATASETS.values():
            self.assertEqual(sd.excluded_names_in(ds), [], ds.key)
            for f in ds.fields:
                for name in (f.key, *f.columns):
                    low = name.lower()
                    words = sd.name_words(name)
                    for bad in SPEC_WORDS:
                        self.assertNotIn(bad, words, f"{ds.key}.{f.key} -> {name}")
                    for bad in ("password", "token", "secret", "aadhaar", "photo"):
                        self.assertNotIn(bad, low, f"{ds.key}.{f.key} -> {name}")

    def test_the_word_check_is_whole_words_not_substrings(self):
        self.assertFalse(sd.name_words("company") & sd.EXCLUDED_WORDS)
        self.assertFalse(sd.name_words("expandedStatus") & sd.EXCLUDED_WORDS)
        for bad in ("bankAccount", "bank_account", "pfNumber", "uan_number", "aadhaarNo", "password_hash", "photoUrl"):
            self.assertTrue(sd.name_words(bad) & sd.EXCLUDED_WORDS, bad)

    def test_a_bad_definition_is_a_start_up_error(self):
        bad_field = sd.Field("bankAccount", "x", "string", sd.BASIC, "x", ("bank_account",), lambda o: o.bank_account)
        bad = sd.Dataset("bad", "Bad", "x", lambda: None, (bad_field,), (), ("id",), 10, category_neutral=True)
        self.assertTrue(sd.excluded_names_in(bad))
        original = dict(sd.DATASETS)
        sd.DATASETS["bad"] = bad
        try:
            with self.assertRaises(RuntimeError):
                sd._verify_catalog()
        finally:
            sd.DATASETS.clear()
            sd.DATASETS.update(original)
        sd._verify_catalog()

    def test_types_and_sensitivities_are_valid_and_labelled(self):
        for ds in sd.DATASETS.values():
            self.assertTrue(ds.label and ds.description, ds.key)
            self.assertTrue(1 <= ds.max_page_size <= 1000, ds.key)
            for f in ds.fields:
                self.assertIn(f.type, sd.FIELD_TYPES, f"{ds.key}.{f.key}")
                self.assertIn(f.sensitivity, sd.SENSITIVITIES, f"{ds.key}.{f.key}")
                self.assertTrue(f.label and f.description, f"{ds.key}.{f.key}")
                self.assertRegex(f.key, r"^[a-z][A-Za-z0-9]*$", f"{ds.key}.{f.key} is camelCase")
            for flt in ds.filters:
                self.assertIn(flt.type, sd.FILTER_TYPES, f"{ds.key}.{flt.key}")

    def test_sample_values_have_the_declared_type(self):
        kinds = {
            "string": str,
            "integer": int,
            "number": (int, float),
            "boolean": bool,
            "date": str,
            "datetime": str,
            "time": str,
        }
        for ds in sd.DATASETS.values():
            for f in ds.fields:
                if f.sample is not None:
                    self.assertIsInstance(f.sample, kinds[f.type], f"{ds.key}.{f.key}")

    def test_every_column_is_a_real_column_and_none_is_a_known_secret(self):
        for ds in sd.DATASETS.values():
            model = ds.base().model
            for f in ds.fields:
                for column in f.columns:
                    field = resolve_column(model, column)  # raises FieldDoesNotExist for a made-up column
                    self.assertNotIn(field.name, HARD_EXCLUDED_COLUMNS, f"{ds.key}.{f.key} -> {column}")
                    self.assertNotIn(field.attname, HARD_EXCLUDED_COLUMNS, f"{ds.key}.{f.key} -> {column}")
                    self.assertNotEqual(field.model.__name__, "HRUser", f"{ds.key}.{f.key}")

    def test_hr_user_models_are_never_reachable(self):
        hr_models = {"HRUser", "Role", "LoginSession", "AuditLog", "HrLoginAttempt"}
        for ds in sd.DATASETS.values():
            model = ds.base().model
            self.assertNotIn(model.__name__, hr_models)
            for f in ds.fields:
                for column in f.columns:
                    self.assertNotIn(resolve_column(model, column).model.__name__, hr_models, f"{ds.key}.{f.key}")

    def test_every_filter_names_real_behaviour_and_enum_defaults_are_allowed(self):
        for ds in sd.DATASETS.values():
            for flt in ds.filters:
                self.assertTrue(callable(flt.apply), f"{ds.key}.{flt.key}")
                if flt.type == "enum":
                    self.assertTrue(flt.values)
                    if flt.default:
                        self.assertIn(flt.default, flt.values)

    def test_date_range_datasets_require_both_dates(self):
        days = sd.ATTENDANCE_DAYS
        self.assertEqual(days.date_range, ("dateFrom", "dateTo", 31))
        self.assertTrue(sd.filter_map(days)["dateFrom"].required and sd.filter_map(days)["dateTo"].required)
        punches = sd.ATTENDANCE_PUNCHES
        self.assertEqual(punches.date_range, ("dateFrom", "dateTo", 7))
        self.assertTrue(sd.filter_map(punches)["dateFrom"].required and sd.filter_map(punches)["dateTo"].required)
        self.assertTrue(sd.filter_map(sd.PAYROLL_SUMMARY)["month"].required)

    def test_the_employees_dataset_says_it_ignores_the_external_flag_unless_asked(self):
        # Employee.co_emp_enabled ("visible to an external application", default off) is the owner's existing opt-in flag;
        # the employees dataset shares every matching employee unless the optional visibleToExternal filter is used
        flt = sd.filter_map(sd.EMPLOYEES)["visibleToExternal"]
        self.assertEqual((flt.type, flt.values, flt.default, flt.required), ("boolean", ("true", "false"), None, False))
        self.assertIn("visible to external", sd.EMPLOYEES.description.lower())
        self.assertIn("including those not marked", sd.EMPLOYEES.description)
        self.assertIn("visibleToExternal", sd.EMPLOYEES.description)
        self.assertIn("visible to external", flt.description.lower())
        for ds in sd.DATASETS.values():
            if ds.key != "employees":
                self.assertNotIn("visibleToExternal", sd.filter_map(ds))
        # the flag itself is still never a shared field
        self.assertNotIn("co_emp_enabled", {c for f in sd.EMPLOYEES.fields for c in f.columns})
        shown = next(d for d in sd.catalog_json()["datasets"] if d["key"] == "employees")
        shown_filter = next(f for f in shown["filters"] if f["key"] == "visibleToExternal")
        self.assertEqual(shown_filter["type"], "boolean")
        self.assertEqual(shown_filter["values"], ["true", "false"])

    def test_a_boolean_filter_must_declare_true_and_false(self):
        bad = sd.Dataset(
            "bad",
            "Bad",
            "x",
            lambda: None,
            (sd.Field("id", "Id", "integer", sd.BASIC, "x", ("id",), lambda o: o.id),),
            (sd.Filter("flag", "Flag", "boolean", "x", values=("yes", "no"), apply=lambda q, v: q),),
            ("id",),
            10,
            category_neutral=True,
        )
        original = dict(sd.DATASETS)
        sd.DATASETS["bad"] = bad
        try:
            with self.assertRaises(RuntimeError):
                sd._verify_catalog()
        finally:
            sd.DATASETS.clear()
            sd.DATASETS.update(original)
        sd._verify_catalog()

    def test_the_catalog_json_for_the_ui(self):
        body = sd.catalog_json()
        self.assertEqual([d["key"] for d in body["datasets"]], list(sd.DATASETS))
        self.assertGreaterEqual(len(body["hardExcluded"]), 7)
        text = " ".join(body["hardExcluded"]).lower()
        for word in ("password", "aadhaar", "pan", "bank", "uan", "pf", "esi", "photo"):
            self.assertIn(word, text)
        for d in body["datasets"]:
            for f in d["fields"]:
                self.assertEqual(set(f), {"key", "label", "type", "sensitivity", "description"})
            for flt in d["filters"]:
                self.assertEqual(set(flt), {"key", "label", "type", "required", "description", "values", "default"})
        self.assertEqual(set(body["sensitivityLevels"]), {"basic", "personal", "financial"})
        for d in body["datasets"]:
            self.assertEqual(d["categoryScope"], "neutral" if d["key"] == "holidays" else "employee", d["key"])

    def test_sensitivity_of_the_spec_fields(self):
        emp = sd.field_map(sd.EMPLOYEES)
        for key in ("phone", "email", "gender", "dateOfBirth", "address"):
            self.assertEqual(emp[key].sensitivity, sd.PERSONAL, key)
        for key in ("salaryAmount", "salaryPerShift", "salaryType"):
            self.assertEqual(emp[key].sensitivity, sd.FINANCIAL, key)
        for key in ("employeeCode", "firstName", "lastName", "fullName", "status", "department", "joinDate"):
            self.assertEqual(emp[key].sensitivity, sd.BASIC, key)
        pay = sd.field_map(sd.PAYROLL_SUMMARY)
        for key in ("grossPay", "netPay", "totalDeductions"):
            self.assertEqual(pay[key].sensitivity, sd.FINANCIAL, key)
        self.assertEqual(sd.field_map(sd.LEAVE_REQUESTS)["reason"].sensitivity, sd.PERSONAL)
        self.assertEqual(
            sd.sensitive_fields(sd.EMPLOYEES, ["employeeCode", "phone", "salaryAmount", "nope"]),
            ["phone", "salaryAmount"],
        )

    def test_effective_fields_keeps_order_drops_unknown_and_duplicates(self):
        self.assertEqual(
            sd.effective_fields(sd.EMPLOYEES, ["lastName", "bank_account", "employeeCode", "lastName", 5, None]),
            ["lastName", "employeeCode"],
        )
        self.assertEqual(sd.effective_fields(sd.EMPLOYEES, "employeeCode"), [])
        self.assertEqual(sd.effective_fields(sd.EMPLOYEES, None), [])
        self.assertIsNone(sd.get_dataset("nope"))
        self.assertIsNone(sd.get_dataset(["employees"]))


class FilterParsingTests(SimpleTestCase):
    def parse(self, dataset, supplied=None, locked=None):
        return sd.parse_filters(dataset, supplied or {}, locked or {})

    def bad(self, dataset, supplied=None, locked=None, param=None):
        with self.assertRaises(sd.FilterError) as ctx:
            self.parse(dataset, supplied, locked)
        if param is not None:
            self.assertEqual(ctx.exception.param, param)
        self.assertTrue(ctx.exception.message.endswith("."))
        return ctx.exception

    def test_defaults_and_types(self):
        v = self.parse(sd.EMPLOYEES)
        self.assertEqual(v, {"status": "active"})
        v = self.parse(
            sd.EMPLOYEES,
            {"status": "all", "employmentType": "staff", "departmentId": "3", "branchId": "2", "employeeCode": "UK-01"},
        )
        self.assertEqual(
            v, {"status": "all", "employmentType": "staff", "departmentId": 3, "branchId": 2, "employeeCode": "UK-01"}
        )
        v = self.parse(sd.ATTENDANCE_DAYS, {"dateFrom": "2026-10-01", "dateTo": "2026-10-31"})
        self.assertEqual(v["dateFrom"], date(2026, 10, 1))
        self.assertEqual(self.parse(sd.PAYROLL_SUMMARY, {"month": "2026-09"})["month"], (2026, 9))
        self.assertEqual(self.parse(sd.HOLIDAYS, {"year": "2026"}), {"year": 2026})

    def test_hostile_and_malformed_values_are_refused(self):
        hostile = {
            "departmentId": [
                "0",
                "-1",
                "1.5",
                "1e3",
                " 1",
                "1 ",
                "1\n",
                "٣",
                "１２",
                "2147483648",
                "9999999999",
                "1; DROP TABLE employees",
                "1 OR 1=1",
                "",
                "0x10",
                "NaN",
                "\x00",
            ],
            "employeeCode": [
                "x' OR '1'='1",
                "a;b",
                "a\x00b",
                "é",
                "UK 01\n",
                "-- ",
                "a" * 41,
                "",
                " lead",
                "trail ",
                "a%b",
                "a'b",
                'a"b',
                "a<b>",
                "ab\r\nX: 1",
                "ａｂ",
            ],
            "status": ["ACTIVE", "active ", "all;", "", "*", "%", "a' OR '1", "активный"],
            "employmentType": ["Staff", "contract", "staff,production", ""],
        }
        for key, values in hostile.items():
            for value in values:
                with self.subTest(key=key, value=value):
                    self.bad(sd.EMPLOYEES, {key: value}, param=key)

    def test_the_boolean_filter_takes_exactly_true_or_false(self):
        self.assertEqual(self.parse(sd.EMPLOYEES), {"status": "active"})  # absent: no restriction, nothing added
        self.assertEqual(self.parse(sd.EMPLOYEES, {"visibleToExternal": "true"})["visibleToExternal"], True)
        self.assertEqual(self.parse(sd.EMPLOYEES, {"visibleToExternal": "false"})["visibleToExternal"], False)
        self.assertEqual(self.parse(sd.EMPLOYEES, {}, {"visibleToExternal": "true"})["visibleToExternal"], True)
        for value in (
            "TRUE",
            "True",
            "1",
            "0",
            "yes",
            "no",
            "on",
            "",
            "true ",
            " true",
            "tru",
            "true\n",
            "ｔｒｕｅ",
            "٠",
        ):
            with self.subTest(value=value):
                err = self.bad(sd.EMPLOYEES, {"visibleToExternal": value}, param="visibleToExternal")
                self.assertIn("true or false" if value else "needs a value", err.message)
        for locked in (True, False, 1, 0, ["true"], "maybe"):
            with self.subTest(locked=locked):
                self.bad(sd.EMPLOYEES, {}, {"visibleToExternal": locked}, param="visibleToExternal")
        err = self.bad(
            sd.EMPLOYEES, {"visibleToExternal": "false"}, {"visibleToExternal": "true"}, param="visibleToExternal"
        )
        self.assertIn("fixed", err.message)  # a locked filter cannot be switched off by the caller

    def test_dates_months_and_years_are_strict(self):
        for value in (
            "2026-13-01",
            "2026-02-30",
            "26-10-01",
            "2026-1-1",
            "2026/10/01",
            "20261001",
            "2026-10-01T00",
            "",
            "٢٠٢٦-١٠-٠١",
            "2026-10-01\n",
            "1999-12-31",
            "2101-01-01",
            "0000-01-01",
        ):
            with self.subTest(date=value):
                self.bad(sd.ATTENDANCE_DAYS, {"dateFrom": value, "dateTo": "2026-10-02"}, param="dateFrom")
        for value in ("2026-00", "2026-13", "2026", "26-09", "2026-9", "2026-09-01", "1999-12", "٢٠٢٦-٠٩", ""):
            with self.subTest(month=value):
                self.bad(sd.PAYROLL_SUMMARY, {"month": value}, param="month")
        for value in ("1999", "2101", "26", "20260", "٢٠٢٦", "2026.0", " 2026", "-2026"):
            with self.subTest(year=value):
                self.bad(sd.HOLIDAYS, {"year": value}, param="year")

    def test_unknown_parameters_are_refused_and_named_safely(self):
        err = self.bad(sd.EMPLOYEES, {"statuss": "active"}, param="statuss")
        self.assertIn("statuss", err.message)
        err = self.bad(sd.EMPLOYEES, {"x\x00<script>é": "1"})
        self.assertNotIn("<", err.message.split("'")[1])  # echoed name is plain ASCII, no markup
        self.assertNotIn("\x00", err.message)
        self.assertNotIn("é", err.message)
        long_name = "a" * 500
        err = self.bad(sd.EMPLOYEES, {long_name: "1"})
        self.assertLess(len(err.message), 100)

    def test_required_filters(self):
        self.bad(sd.ATTENDANCE_DAYS, {}, param="dateFrom")
        self.bad(sd.ATTENDANCE_DAYS, {"dateFrom": "2026-10-01"}, param="dateTo")
        self.bad(sd.ATTENDANCE_DAYS, {"dateTo": "2026-10-01"}, param="dateFrom")
        self.bad(sd.ATTENDANCE_PUNCHES, {}, param="dateFrom")
        self.bad(sd.PAYROLL_SUMMARY, {}, param="month")
        self.parse(sd.HOLIDAYS)  # nothing required
        self.parse(sd.LEAVE_REQUESTS)

    def test_date_range_limits(self):
        ok = {"dateFrom": "2026-10-01", "dateTo": "2026-10-31"}
        self.assertEqual(len(self.parse(sd.ATTENDANCE_DAYS, ok)), 2)  # 31 days inclusive is allowed
        self.bad(sd.ATTENDANCE_DAYS, {"dateFrom": "2026-10-01", "dateTo": "2026-11-01"}, param="dateTo")  # 32 days
        self.bad(sd.ATTENDANCE_DAYS, {"dateFrom": "2026-10-05", "dateTo": "2026-10-04"}, param="dateTo")
        self.parse(sd.ATTENDANCE_DAYS, {"dateFrom": "2026-10-05", "dateTo": "2026-10-05"})
        self.parse(sd.ATTENDANCE_PUNCHES, {"dateFrom": "2026-10-01", "dateTo": "2026-10-07"})  # 7 days
        self.bad(sd.ATTENDANCE_PUNCHES, {"dateFrom": "2026-10-01", "dateTo": "2026-10-08"}, param="dateTo")  # 8 days
        # leap day: Feb 2028 has 29 days, still fine inside a 31-day window
        self.parse(sd.ATTENDANCE_DAYS, {"dateFrom": "2028-02-01", "dateTo": "2028-03-02"})
        self.bad(sd.ATTENDANCE_DAYS, {"dateFrom": "2028-02-01", "dateTo": "2028-03-03"}, param="dateTo")

    def test_a_locked_filter_cannot_be_overridden_and_replaces_the_default(self):
        err = self.bad(sd.EMPLOYEES, {"status": "all"}, {"status": "inactive"}, param="status")
        self.assertIn("fixed", err.message)
        self.assertEqual(self.parse(sd.EMPLOYEES, {}, {"status": "inactive"}), {"status": "inactive"})
        self.assertEqual(self.parse(sd.EMPLOYEES, {}, {"departmentId": 7})["departmentId"], 7)  # a JSON number
        locked_dates = {"dateFrom": "2026-10-01", "dateTo": "2026-10-07"}
        self.assertEqual(len(self.parse(sd.ATTENDANCE_DAYS, {}, locked_dates)), 2)
        # a caller can still add the other (unlocked) filters
        self.assertEqual(self.parse(sd.EMPLOYEES, {"branchId": "2"}, {"status": "all"})["branchId"], 2)

    def test_preview_defaults_fill_only_missing_required_filters(self):
        filled = sd.preview_defaults(sd.ATTENDANCE_DAYS, {}, {})
        self.assertEqual(set(filled), {"dateFrom", "dateTo"})
        self.parse(sd.ATTENDANCE_DAYS, filled)  # valid
        filled = sd.preview_defaults(sd.ATTENDANCE_PUNCHES, {}, {})
        self.parse(sd.ATTENDANCE_PUNCHES, filled)
        self.assertRegex(sd.preview_defaults(sd.PAYROLL_SUMMARY, {}, {})["month"], r"^\d{4}-\d{2}$")
        given = {"dateFrom": "2026-01-01", "dateTo": "2026-01-02"}
        self.assertEqual(sd.preview_defaults(sd.ATTENDANCE_DAYS, given, {}), given)
        self.assertEqual(sd.preview_defaults(sd.ATTENDANCE_DAYS, {}, {"dateFrom": "2026-01-01"}).get("dateFrom"), None)
        self.assertEqual(sd.preview_defaults(sd.EMPLOYEES, {}, {}), {})

    def test_numbers_that_arrive_as_json_numbers_are_handled(self):
        flt = sd.filter_map(sd.EMPLOYEES)["departmentId"]
        self.assertEqual(sd.parse_filter_value(flt, 12), 12)
        for bad in (True, False, 1.5, None, [1], {"a": 1}):
            with self.assertRaises(sd.FilterError):
                sd.parse_filter_value(flt, bad)


class Seeded(TestCase):
    """One row of every dataset's model, with canary text in every column that must never leave."""

    CANARY = "CANARY-SECRET-9f3a"

    @classmethod
    def setUpTestData(cls):
        cls.branch = Branch.objects.create(name="SDS Head", code="SDSHO", address=cls.CANARY, phone=cls.CANARY)
        cls.branch2 = Branch.objects.create(name="SDS Unit Two", code="SDSU2")
        cls.dept = Department.objects.create(name="SDS Stitching", branch=cls.branch, description=cls.CANARY)
        cls.dept2 = Department.objects.create(name="SDS Cutting", branch=cls.branch2)
        cls.desig = Designation.objects.create(title="SDS Supervisor", department=cls.dept, level="senior")
        cls.emp = Employee.objects.create(
            employee_code="UK001",
            first_name="Asha",
            last_name="Kumar",
            gender="female",
            date_of_birth=date(1994, 2, 11),
            email="asha@example.com",
            phone="9876543210",
            address="12 Mill Road",
            employment_type="staff",
            department=cls.dept,
            designation=cls.desig,
            branch=cls.branch,
            salary_type="monthly",
            salary_amount=Decimal("25000.5"),
            salary_per_shift=Decimal("650"),
            status="active",
            join_date="2024-06-03",
            # never shared
            password_hash=cls.CANARY + "-hash",
            bank_name=cls.CANARY + "-bank",
            bank_account=cls.CANARY + "-acct",
            bank_ifsc=cls.CANARY + "-ifsc",
            id_proof=cls.CANARY + "-aadhaar",
            pf_number=cls.CANARY + "-pf",
            esi_number=cls.CANARY + "-esi",
            uan_number=cls.CANARY + "-uan",
            photo_url=cls.CANARY + "-photo",
            biometric_device_id=cls.CANARY + "-bio",
            emergency_contact=cls.CANARY + "-emerg",
            father_name=cls.CANARY + "-father",
            blood_group="O+",
            initial_salary=Decimal("11111.11"),
        )
        cls.emp2 = Employee.objects.create(
            employee_code="UK002",
            first_name="Ravi",
            last_name="S",
            employment_type="production",
            status="inactive",
            department=cls.dept2,
            branch=cls.branch2,
            join_date="not a date",
            salary_per_shift=Decimal("700"),
        )
        cls.day = AttendanceDayRecord.objects.create(
            employee=cls.emp,
            date=date(2026, 10, 14),
            status="present",
            first_punch=time(8, 29, 41),
            last_punch=time(17, 46, 10),
            shifts_earned=Decimal("1.00"),
            is_late=True,
            compensation_kind="birthday",
            compensation_note=cls.CANARY + "-note",
            late_reason=cls.CANARY + "-reason",
            override_note=cls.CANARY + "-override",
        )
        AttendanceDayRecord.objects.create(employee=cls.emp2, date=date(2026, 10, 14), status="absent")
        cls.punch = AttendanceLog.objects.create(
            employee=cls.emp,
            date=date(2026, 10, 14),
            punch_time=time(8, 29, 41),
            punch_type="IN",
            source="biometric:adms:SERIAL-" + cls.CANARY,
        )
        AttendanceLog.objects.create(
            employee=cls.emp2, date=date(2026, 10, 13), punch_time=time(9, 0), punch_type="IN", source="manual"
        )
        cls.leave_type = LeaveType.objects.create(name="Casual Leave", code="CL-T")
        cls.leave = LeaveRequest.objects.create(
            employee=cls.emp,
            leave_type_ref=cls.leave_type,
            start_date="2026-10-20",
            end_date="2026-10-21",
            total_days=Decimal("2.0"),
            status="approved",
            reason="Family function",
            hr_comment=cls.CANARY + "-hrcomment",
            approved_by=cls.CANARY + "-approver",
        )
        cls.leave_legacy = LeaveRequest.objects.create(
            employee=cls.emp2, type="sick", start_date="2026-11-01", end_date="bad", status="pending"
        )
        Holiday.objects.create(
            name="SDS Deepavali", date=date(2026, 10, 20), holiday_type="national", description=cls.CANARY
        )
        Holiday.objects.create(name="SDS New Year", date=date(2027, 1, 1), holiday_type="company")
        cls.payroll = Payroll.objects.create(
            employee=cls.emp,
            salary_mode="monthly",
            month=9,
            year=2026,
            base_salary=Decimal("25000"),
            gross_salary=Decimal("25000.50"),
            deductions=Decimal("1800"),
            bonus=Decimal("500"),
            final_salary=Decimal("23700.5"),
            present_days=Decimal("26.0"),
            notes=cls.CANARY + "-notes",
        )
        Payroll.objects.create(
            employee=cls.emp2,
            salary_mode="shift",
            month=9,
            year=2026,
            period_start=date(2026, 9, 1),
            period_end=date(2026, 9, 7),
            base_salary=Decimal("700"),
            gross_salary=Decimal("4900"),
            final_salary=Decimal("4900"),
            present_days=Decimal("7"),
        )

    def rows(self, dataset, supplied=None, locked=None, fields=None):
        fields = fields if fields is not None else [f.key for f in dataset.fields]
        values = sd.parse_filters(dataset, supplied or {}, locked or {})
        qs = sd.build_queryset(dataset, values, fields)
        return sd.shape_rows(dataset, fields, list(qs))

    def full_filters(self, dataset):
        return {
            "attendance-days": {"dateFrom": "2026-10-01", "dateTo": "2026-10-31"},
            "attendance-punches": {"dateFrom": "2026-10-10", "dateTo": "2026-10-16"},
            "payroll-summary": {"month": "2026-09"},
        }.get(dataset.key, {})


class GetterTests(Seeded):
    def test_every_dataset_returns_exactly_the_declared_fields_and_no_canary(self):
        for ds in sd.DATASETS.values():
            with self.subTest(dataset=ds.key):
                rows = self.rows(ds, self.full_filters(ds), {"status": "all"} if ds.key == "employees" else None)
                self.assertTrue(rows, ds.key)
                declared = [f.key for f in ds.fields]
                for row in rows:
                    self.assertEqual(list(row), declared)
                self.assertNotIn(self.CANARY, repr(rows))
                self.assertNotIn("SERIAL", repr(rows))

    def test_a_subset_returns_only_the_subset_in_the_saved_order(self):
        rows = self.rows(sd.EMPLOYEES, fields=["lastName", "employeeCode"])
        self.assertEqual(rows[0], {"lastName": "Kumar", "employeeCode": "UK001"})
        self.assertEqual(list(rows[0]), ["lastName", "employeeCode"])

    def test_getters_read_only_the_columns_they_declare(self):
        """Wrap a real row in a recorder: the attribute paths each getter touches must be inside its declared columns."""

        class Spy:
            def __init__(self, obj, path, seen):
                object.__setattr__(self, "_o", obj)
                object.__setattr__(self, "_p", path)
                object.__setattr__(self, "_s", seen)

            def __getattr__(self, name):
                value = getattr(self._o, name)
                path = (*self._p, name)
                if isinstance(value, models.Model):
                    return Spy(value, path, self._s)
                if not self._o._meta.get_field(name).is_relation:  # a relation that is not set is the join itself
                    self._s.add("__".join(path))
                return value

        for ds in sd.DATASETS.values():
            fields = [f.key for f in ds.fields]
            values = sd.parse_filters(ds, self.full_filters(ds), {"status": "all"} if ds.key == "employees" else {})
            objs = list(sd.build_queryset(ds, values, fields))
            self.assertTrue(objs, ds.key)
            for f in ds.fields:
                seen: set[str] = set()
                for obj in objs:
                    f.get(Spy(obj, (), seen))
                declared = set(f.columns)
                self.assertLessEqual(
                    seen, declared, f"{ds.key}.{f.key} reads {seen - declared} that it does not declare"
                )
                self.assertTrue(seen, f"{ds.key}.{f.key} reads nothing")

    def test_values_have_the_declared_json_types(self):
        kinds = {
            "string": (str, type(None)),
            "integer": (int, type(None)),
            "number": (int, float, type(None)),
            "boolean": (bool,),
            "date": (str, type(None)),
            "datetime": (str, type(None)),
            "time": (str, type(None)),
        }
        for ds in sd.DATASETS.values():
            rows = self.rows(ds, self.full_filters(ds), {"status": "all"} if ds.key == "employees" else None)
            for f in ds.fields:
                for row in rows:
                    self.assertIsInstance(row[f.key], kinds[f.type], f"{ds.key}.{f.key}")
                    if f.type == "date" and row[f.key]:
                        self.assertRegex(row[f.key], r"^\d{4}-\d{2}-\d{2}$")
                    if f.type == "time" and row[f.key]:
                        self.assertRegex(row[f.key], r"^\d{2}:\d{2}:\d{2}$")

    def test_units_and_formats(self):
        emp = self.rows(sd.EMPLOYEES, {"employeeCode": "UK001"}, {"status": "all"})[0]
        self.assertEqual(emp["fullName"], "Asha Kumar")
        self.assertEqual(emp["salaryAmount"], 25000.5)
        self.assertEqual(emp["salaryPerShift"], 650.0)
        self.assertEqual(emp["dateOfBirth"], "1994-02-11")
        self.assertEqual(emp["joinDate"], "2024-06-03")
        self.assertEqual(
            (emp["department"], emp["designation"], emp["branch"]), ("SDS Stitching", "SDS Supervisor", "SDS Head")
        )
        other = self.rows(sd.EMPLOYEES, {"employeeCode": "UK002"}, {"status": "all"})[0]
        self.assertIsNone(other["joinDate"])  # "not a date" is not guessed at
        self.assertIsNone(other["salaryAmount"])
        self.assertIsNone(other["designation"])
        day = self.rows(
            sd.ATTENDANCE_DAYS, {"dateFrom": "2026-10-14", "dateTo": "2026-10-14", "employeeCode": "UK001"}
        )[0]
        self.assertEqual(day["firstPunch"], "08:29:41")
        self.assertEqual(day["lastPunch"], "17:46:10")
        self.assertEqual(day["shiftsEarned"], 1.0)
        self.assertEqual((day["isLate"], day["earlyLeave"], day["isHalfShift"]), (True, False, False))
        self.assertEqual(day["compensationKind"], "birthday")
        absent = self.rows(
            sd.ATTENDANCE_DAYS, {"dateFrom": "2026-10-14", "dateTo": "2026-10-14", "employeeCode": "UK002"}
        )[0]
        self.assertIsNone(absent["firstPunch"])
        self.assertIsNone(absent["compensationKind"])
        pay = self.rows(sd.PAYROLL_SUMMARY, {"month": "2026-09", "employmentType": "staff"})[0]
        self.assertEqual((pay["grossPay"], pay["totalDeductions"], pay["netPay"]), (25000.5, 1800.0, 23700.5))
        self.assertEqual((pay["month"], pay["year"], pay["periodStart"]), (9, 2026, None))
        prod = self.rows(sd.PAYROLL_SUMMARY, {"month": "2026-09", "employmentType": "production"})[0]
        self.assertEqual((prod["periodStart"], prod["periodEnd"], prod["paidDays"]), ("2026-09-01", "2026-09-07", 7.0))

    def test_a_device_serial_never_leaves_only_the_kind_of_source(self):
        rows = self.rows(sd.ATTENDANCE_PUNCHES, {"dateFrom": "2026-10-10", "dateTo": "2026-10-16"})
        self.assertEqual({r["source"] for r in rows}, {"biometric", "manual"})
        for raw, kind in (
            ("biometric:adms:X1", "biometric"),
            ("biometric", "biometric"),
            ("geo:auto", "geo"),
            ("on_duty:approved", "on_duty"),
            ("missing_punch:approved", "missing_punch"),
            ("manual", "manual"),
            ("import-from-excel", "other"),
            ("", "other"),
            (None, "other"),
        ):
            self.assertEqual(sd._source_category(raw), kind)

    def test_leave_dates_stored_as_text_are_normalised(self):
        rows = {r["employeeCode"]: r for r in self.rows(sd.LEAVE_REQUESTS)}
        self.assertEqual(rows["UK001"]["startDate"], "2026-10-20")
        self.assertEqual(rows["UK001"]["leaveType"], "Casual Leave")
        self.assertEqual(rows["UK001"]["days"], 2.0)
        self.assertEqual(rows["UK002"]["leaveType"], "sick")  # no leave type row: the stored word
        self.assertIsNone(rows["UK002"]["endDate"])  # not an ISO date
        self.assertEqual(sd._text_date("2026-10-20T10:00:00"), "2026-10-20")
        for bad in (None, "", "2026-13-01", "20/10/2026", 5):
            self.assertIsNone(sd._text_date(bad))

    def test_the_row_query_never_reads_an_unshared_column(self):
        names = [
            "password_hash",
            "bank_account",
            "bank_name",
            "bank_ifsc",
            "id_proof",
            "pf_number",
            "esi_number",
            "uan_number",
            "photo_url",
            "biometric_device_id",
            "emergency_contact",
            "compensation_note",
            "late_reason",
            "override_note",
            "hr_comment",
            "approved_by",
            "notes",
            "initial_salary",
        ]
        for ds in sd.DATASETS.values():
            fields = [f.key for f in ds.fields]
            values = sd.parse_filters(ds, self.full_filters(ds), {})
            sql = str(sd.build_queryset(ds, values, fields).query)
            for name in names:
                self.assertNotIn(f'"{name}"', sql, f"{ds.key} selects {name}")

    def test_a_subset_loads_only_its_columns(self):
        sql = str(sd.build_queryset(sd.EMPLOYEES, {}, ["employeeCode"]).query)
        self.assertIn('"employee_code"', sql)
        for name in ("salary_amount", "phone", "email", "first_name"):
            self.assertNotIn(f'"{name}"', sql)
        sql = str(sd.build_queryset(sd.EMPLOYEES, {}, ["employeeCode", "department"]).query)
        self.assertIn('"departments"."name"', sql)
        self.assertNotIn('"branches"', sql)


class QueryCountTests(Seeded):
    def count_queries(self, ds, fields):
        values = sd.parse_filters(ds, self.full_filters(ds), {"status": "all"} if ds.key == "employees" else {})
        with CaptureQueriesContext(connection) as ctx:
            qs = sd.build_queryset(ds, values, fields)
            qs.count()
            rows = sd.shape_rows(ds, fields, list(qs[0:500]))
        return len(ctx), len(rows)

    def grow(self, n):
        """Add n more employees, each with one row in every employee-linked dataset."""
        emps = [
            Employee(
                employee_code=f"BULK{i:04d}",
                first_name="B",
                last_name=str(i),
                department=self.dept,
                designation=self.desig,
                branch=self.branch,
                status="active",
            )
            for i in range(n)
        ]
        Employee.objects.bulk_create(emps)
        emps = list(Employee.objects.filter(employee_code__startswith="BULK"))
        AttendanceDayRecord.objects.bulk_create(
            [AttendanceDayRecord(employee=e, date=date(2026, 10, 14), status="present") for e in emps]
        )
        AttendanceLog.objects.bulk_create(
            [
                AttendanceLog(
                    employee=e, date=date(2026, 10, 14), punch_time=time(9, 0), punch_type="IN", source="manual"
                )
                for e in emps
            ]
        )
        LeaveRequest.objects.bulk_create(
            [
                LeaveRequest(employee=e, leave_type_ref=self.leave_type, start_date="2026-10-20", end_date="2026-10-20")
                for e in emps
            ]
        )
        Payroll.objects.bulk_create(
            [
                Payroll(
                    employee=e, salary_mode="monthly", month=9, year=2026, base_salary=1, gross_salary=1, final_salary=1
                )
                for e in emps
            ]
        )
        Department.objects.bulk_create([Department(name=f"D{i}", branch=self.branch) for i in range(n)])
        Branch.objects.bulk_create([Branch(name=f"B{i}", code=f"BC{i}") for i in range(n)])
        Designation.objects.bulk_create([Designation(title=f"T{i}", department=self.dept) for i in range(n)])
        Holiday.objects.bulk_create([Holiday(name=f"H{i}", date=date(2026, 10, 1 + i % 28)) for i in range(n)])

    def test_a_page_costs_the_same_number_of_queries_for_one_row_and_for_sixty(self):
        before = {}
        for ds in sd.DATASETS.values():
            fields = [f.key for f in ds.fields]
            q, rows = self.count_queries(ds, fields)
            self.assertGreaterEqual(rows, 1, ds.key)
            before[ds.key] = (q, rows)
        self.grow(60)
        for ds in sd.DATASETS.values():
            fields = [f.key for f in ds.fields]
            q, rows = self.count_queries(ds, fields)
            self.assertGreaterEqual(rows, 30, ds.key)
            self.assertEqual(q, before[ds.key][0], f"{ds.key}: {before[ds.key]} -> {(q, rows)}")
            self.assertEqual(q, 2, ds.key)  # one count, one page


class FilterSemanticsTests(Seeded):
    def codes(self, dataset, supplied=None, locked=None):
        return [r["employeeCode"] for r in self.rows(dataset, supplied, locked, fields=["employeeCode"])]

    def test_employees(self):
        self.assertEqual(self.codes(sd.EMPLOYEES), ["UK001"])  # active is the default
        self.assertEqual(self.codes(sd.EMPLOYEES, {"status": "inactive"}), ["UK002"])
        self.assertEqual(self.codes(sd.EMPLOYEES, {"status": "all"}), ["UK001", "UK002"])
        self.assertEqual(self.codes(sd.EMPLOYEES, {"status": "all", "employmentType": "production"}), ["UK002"])
        self.assertEqual(self.codes(sd.EMPLOYEES, {"status": "all", "departmentId": str(self.dept2.id)}), ["UK002"])
        self.assertEqual(self.codes(sd.EMPLOYEES, {"status": "all", "branchId": str(self.branch.id)}), ["UK001"])
        self.assertEqual(self.codes(sd.EMPLOYEES, {"status": "all", "employeeCode": "UK002"}), ["UK002"])
        self.assertEqual(self.codes(sd.EMPLOYEES, {"employeeCode": "uk002"}), [])  # exact, case-sensitive
        self.assertEqual(self.codes(sd.EMPLOYEES, {"status": "all", "departmentId": "99999"}), [])

    def test_the_employees_external_flag_is_an_optional_narrowing_filter(self):
        Employee.objects.filter(pk=self.emp2.pk).update(co_emp_enabled=True)  # UK002: inactive, opted in
        everyone = {"status": "all"}
        self.assertEqual(self.codes(sd.EMPLOYEES, everyone), ["UK001", "UK002"])  # the flag is ignored by default
        self.assertEqual(self.codes(sd.EMPLOYEES, {**everyone, "visibleToExternal": "false"}), ["UK001", "UK002"])
        self.assertEqual(self.codes(sd.EMPLOYEES, {**everyone, "visibleToExternal": "true"}), ["UK002"])
        self.assertEqual(self.codes(sd.EMPLOYEES, {"visibleToExternal": "true"}), [])  # opted in but not active
        self.assertEqual(self.codes(sd.EMPLOYEES, {"status": "inactive"}, {"visibleToExternal": "true"}), ["UK002"])
        self.assertEqual(self.codes(sd.EMPLOYEES, everyone, {"visibleToExternal": "true"}), ["UK002"])
        Employee.objects.filter(pk=self.emp.pk).update(co_emp_enabled=True)
        self.assertEqual(self.codes(sd.EMPLOYEES, everyone, {"visibleToExternal": "true"}), ["UK001", "UK002"])
        Employee.objects.update(co_emp_enabled=False)
        self.assertEqual(self.codes(sd.EMPLOYEES, everyone, {"visibleToExternal": "true"}), [])

    def test_the_external_flag_is_only_ever_used_to_filter_never_read_or_shown(self):
        Employee.objects.filter(pk=self.emp.pk).update(co_emp_enabled=True)
        values = sd.parse_filters(sd.EMPLOYEES, {}, {"visibleToExternal": "true"})
        qs = sd.build_queryset(sd.EMPLOYEES, values, ["employeeCode", "firstName"])
        sql, params = qs.query.sql_with_params()
        select_list, where = sql.split(" FROM ", 1)[0], sql.split(" WHERE ", 1)[1]
        self.assertNotIn("co_emp_enabled", select_list)
        self.assertIn("co_emp_enabled", where)
        self.assertNotIn(
            "true", sql.lower().split(" where ", 1)[1].replace("co_emp_enabled", "")
        )  # no value text in the SQL
        for row in self.rows(sd.EMPLOYEES, {}, {"visibleToExternal": "true"}):
            self.assertEqual(set(row), {f.key for f in sd.EMPLOYEES.fields})
            self.assertNotIn("coEmpEnabled", row)

    def test_attendance_days(self):
        window = {"dateFrom": "2026-10-14", "dateTo": "2026-10-14"}
        self.assertEqual(self.codes(sd.ATTENDANCE_DAYS, window), ["UK001", "UK002"])
        self.assertEqual(self.codes(sd.ATTENDANCE_DAYS, {**window, "employmentType": "production"}), ["UK002"])
        self.assertEqual(self.codes(sd.ATTENDANCE_DAYS, {**window, "branchId": str(self.branch.id)}), ["UK001"])
        self.assertEqual(self.codes(sd.ATTENDANCE_DAYS, {**window, "departmentId": str(self.dept2.id)}), ["UK002"])
        self.assertEqual(self.codes(sd.ATTENDANCE_DAYS, {"dateFrom": "2026-10-15", "dateTo": "2026-10-20"}), [])
        self.assertEqual(self.codes(sd.ATTENDANCE_DAYS, {"dateFrom": "2026-10-10", "dateTo": "2026-10-13"}), [])

    def test_attendance_punches(self):
        window = {"dateFrom": "2026-10-13", "dateTo": "2026-10-14"}
        self.assertEqual(self.codes(sd.ATTENDANCE_PUNCHES, window), ["UK002", "UK001"])  # ordered by date then time
        self.assertEqual(self.codes(sd.ATTENDANCE_PUNCHES, {**window, "employeeCode": "UK001"}), ["UK001"])
        self.assertEqual(self.codes(sd.ATTENDANCE_PUNCHES, {**window, "departmentId": str(self.dept2.id)}), ["UK002"])

    def test_leave_overlap(self):
        self.assertEqual(self.codes(sd.LEAVE_REQUESTS, {"dateFrom": "2026-10-21", "dateTo": "2026-10-25"}), ["UK001"])
        self.assertEqual(self.codes(sd.LEAVE_REQUESTS, {"dateFrom": "2026-10-22", "dateTo": "2026-10-25"}), [])
        self.assertEqual(self.codes(sd.LEAVE_REQUESTS, {"dateFrom": "2026-10-01", "dateTo": "2026-10-19"}), [])
        self.assertEqual(self.codes(sd.LEAVE_REQUESTS, {"dateTo": "2026-10-20"}), ["UK001"])
        self.assertEqual(self.codes(sd.LEAVE_REQUESTS, {"status": "pending"}), ["UK002"])
        self.assertEqual(self.codes(sd.LEAVE_REQUESTS, {"status": "approved"}), ["UK001"])
        self.assertEqual(self.codes(sd.LEAVE_REQUESTS, {"employeeCode": "UK001"}), ["UK001"])
        self.assertEqual(self.codes(sd.LEAVE_REQUESTS), ["UK002", "UK001"])  # newest start first

    def test_holidays_and_payroll(self):
        names = lambda supplied: [  # noqa: E731
            r["name"] for r in self.rows(sd.HOLIDAYS, supplied, fields=["name"]) if r["name"].startswith("SDS")
        ]
        self.assertEqual(names({"year": "2026"}), ["SDS Deepavali"])
        self.assertEqual(names({"year": "2027"}), ["SDS New Year"])
        self.assertEqual(names({}), ["SDS Deepavali", "SDS New Year"])
        self.assertEqual(names({"year": "2030"}), [])
        self.assertEqual(self.rows(sd.HOLIDAYS, {"year": "2030"}, fields=["name"]), [])
        self.assertEqual(self.codes(sd.PAYROLL_SUMMARY, {"month": "2026-09"}), ["UK001", "UK002"])
        self.assertEqual(self.codes(sd.PAYROLL_SUMMARY, {"month": "2026-09", "employmentType": "staff"}), ["UK001"])
        self.assertEqual(self.codes(sd.PAYROLL_SUMMARY, {"month": "2026-10"}), [])

    def test_org_datasets(self):
        mine = lambda rows, key: [r for r in rows if str(r[key]).startswith("SDS")]  # noqa: E731
        depts = mine(self.rows(sd.DEPARTMENTS), "name")
        self.assertEqual([d["name"] for d in depts], ["SDS Cutting", "SDS Stitching"])
        self.assertEqual(depts[1]["branch"], "SDS Head")
        self.assertEqual(set(depts[0]), {"id", "name", "branch"})
        self.assertEqual([b["name"] for b in mine(self.rows(sd.BRANCHES), "name")], ["SDS Head", "SDS Unit Two"])
        self.assertEqual(
            mine(self.rows(sd.DESIGNATIONS), "title"),
            [{"id": self.desig.id, "title": "SDS Supervisor", "department": "SDS Stitching", "level": "senior"}],
        )
        self.assertNotIn(self.CANARY, repr(self.rows(sd.BRANCHES)) + repr(self.rows(sd.DEPARTMENTS)))

    def test_ordering_is_deterministic_with_ties(self):
        for ds in sd.DATASETS.values():
            self.assertTrue(ds.ordering[-1] in ("id", "-id"), f"{ds.key} has a unique tie-breaker")


class SqlAsDataTests(Seeded):
    def test_filter_values_reach_the_database_as_parameters(self):
        """Even a value that merely looks like SQL (it cannot pass the parsers) never becomes SQL text."""
        flt = sd.filter_map(sd.EMPLOYEES)["employeeCode"]
        value = sd.parse_filter_value(flt, "UK-01/B.2")
        qs = sd.build_queryset(sd.EMPLOYEES, {"employeeCode": value}, ["employeeCode"])
        sql, params = qs.query.sql_with_params()
        self.assertNotIn("UK-01", sql)
        self.assertIn("UK-01/B.2", params)
        for hostile in ("' OR 1=1 --", "UK001'; DROP TABLE employees; --", "%", "\\"):
            with self.assertRaises(sd.FilterError):
                sd.parse_filter_value(flt, hostile)
        self.assertTrue(re.fullmatch(r"[A-Za-z0-9._/-]", "-"))

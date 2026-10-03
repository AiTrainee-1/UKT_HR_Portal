"""Salary split: the mandatory 50% + 50% breakdown of an employee's salary (salary_split.py).

Three layers: the rules on their own (worked examples that the frontend tests repeat, so a form and the server can
never disagree), the API that saves a split (create, edit, increments, bulk upload / bulk update), and the promise
that nothing else moves: payroll gives the same result with or without a split."""

import io
import random
from decimal import Decimal

import openpyxl
from django.core.files.uploadedfile import SimpleUploadedFile
from django.test import SimpleTestCase, TestCase

from . import salary_split as ss
from .employee_bulk_views import EMPLOYEE_UPLOAD_HEADERS, LEGACY_UPLOAD_HEADERS, SPLIT_HEADERS
from .jwt_utils import sign_token
from .models import Branch, Employee, HRUser, Payroll, SalaryIncrement
from .payroll_views import _generate_staff_payroll

D = Decimal

# (salary, first portion Basic/DA/Retaining, second portion Other/Petrol/HRA/Special/CA) -also in salary-split.test.ts
WORKED_EXAMPLES = [
    ("43000", ["7166.67", "7166.67", "7166.66"], ["4300.00"] * 5),
    ("24000", ["4000.00"] * 3, ["2400.00"] * 5),
    ("25000.50", ["4166.75"] * 3, ["2500.05"] * 5),
    ("1000.01", ["166.67"] * 3, ["100.00"] * 5),
    ("7", ["1.17", "1.17", "1.16"], ["0.70"] * 5),
    ("0.01", ["0.01", "0.00", "0.00"], ["0.00"] * 5),
]


def parts_of(first, second):
    return {c: D(v) for c, v in zip(ss.COMPONENTS, [*first, *second])}


def payload(first, second):
    return {ss.JSON_KEYS[c]: str(v) for c, v in parts_of(first, second).items()}


class RuleTests(SimpleTestCase):
    def test_the_components_are_the_ones_asked_for_in_the_right_portions(self):
        self.assertEqual([ss.LABELS[c] for c in ss.FIRST_PORTION], ["Basic", "DA", "Retaining Allowance"])
        self.assertEqual(
            [ss.LABELS[c] for c in ss.SECOND_PORTION],
            ["Other Allowance", "Petrol Allowance", "HRA", "Special Allowance", "CA"],
        )
        self.assertEqual(len(ss.COMPONENTS), 8)
        self.assertEqual(len(set(ss.COLUMN_NAMES)), 8)

    def test_worked_examples(self):
        for total, first, second in WORKED_EXAMPLES:
            self.assertEqual(ss.default_split(D(total)), parts_of(first, second), total)
            self.assertIsNone(ss.validate(D(total), ss.default_split(D(total))), total)

    def test_the_default_split_always_adds_up_exactly_and_is_a_valid_split(self):
        rng = random.Random(7)
        totals = list(range(1, 2500)) + [rng.randrange(1, 10**9) for _ in range(3000)]
        for paise in totals:
            total = D(paise) / 100
            parts = ss.default_split(total)
            values = [ss.to_paise(parts[c]) for c in ss.COMPONENTS]
            self.assertEqual(sum(values), paise, paise)
            self.assertEqual(sum(values[:3]), (paise + 1) // 2, paise)  # the odd paisa goes to the first portion
            self.assertTrue(all(v >= 0 for v in values), paise)
            self.assertIsNone(ss.validate(total, parts), paise)

    def test_validate_names_the_portion_that_is_wrong(self):
        good = parts_of(["7166.67", "7166.67", "7166.66"], ["4300.00"] * 5)
        moved = dict(good, basic=D("8166.67"), other_allowance=D("3300.00"))
        message = ss.validate(D("43000"), moved)
        self.assertIn("First portion (Basic + DA + Retaining Allowance) is ₹22,500.00", message)
        self.assertIn("must be 50% of the salary (₹21,500.00)", message)
        second_short = dict(good, ca=D("4200.00"))
        self.assertIn("Second portion", ss.validate(D("43000"), second_short))
        self.assertIn("₹21,400.00", ss.validate(D("43000"), second_short))

    def test_an_odd_paisa_may_sit_in_either_portion(self):
        first_heavy = parts_of(["166.67", "166.67", "166.67"], ["100.00"] * 5)  # 500.01 + 500.00
        second_heavy = parts_of(["166.67", "166.67", "166.66"], ["100.00", "100.00", "100.00", "100.00", "100.01"])
        for parts in (first_heavy, second_heavy):
            self.assertIsNone(ss.validate(D("1000.01"), parts))
        # ...but not both (each is within a paisa of half, yet together they are a paisa over), and not neither
        both = ss.validate(D("1000.01"), parts_of(["166.67"] * 3, ["100.01", "100.00", "100.00", "100.00", "100.00"]))
        self.assertIn("must equal the salary exactly", both)
        neither = ss.validate(D("1000.01"), parts_of(["166.66"] * 3, ["100.00"] * 5))
        self.assertIn("First portion", neither)

    def test_negative_amounts_are_refused(self):
        parts = dict(ss.default_split(D("24000")), da=D("-1.00"))
        self.assertEqual(ss.validate(D("24000"), parts), "DA cannot be negative.")

    def test_rescale_keeps_the_shape_inside_each_portion(self):
        old = parts_of(["15000", "5000", "0"], ["10000", "2000", "8000", "0", "0"])  # for 40,000
        self.assertIsNone(ss.validate(D("40000"), old))
        doubled = ss.rescale(old, D("80000"))
        self.assertEqual(doubled, parts_of(["30000", "10000", "0"], ["20000", "4000", "16000", "0", "0"]))
        odd = ss.rescale(old, D("41234.57"))
        self.assertIsNone(ss.validate(D("41234.57"), odd))
        self.assertGreater(odd["basic"], odd["da"])
        self.assertEqual(odd["retaining_allowance"], D("0.00"))
        self.assertEqual(odd["special_allowance"], D("0.00"))

    def test_an_unedited_automatic_split_stays_automatic_when_the_salary_changes(self):
        for old_total, new_total in (("43000", "86000"), ("24000", "25000.01"), ("7", "1234.56")):
            scaled = ss.rescale(ss.default_split(D(old_total)), D(new_total))
            self.assertEqual(scaled, ss.default_split(D(new_total)), (old_total, new_total))

    def test_rescale_of_a_portion_that_was_all_zero_shares_equally_and_of_nothing_uses_the_default(self):
        old = parts_of(["0", "0", "0"], ["10", "10", "10", "10", "10"])
        scaled = ss.rescale(old, D("24000"))
        self.assertEqual([scaled[c] for c in ss.FIRST_PORTION], [D("4000.00")] * 3)
        self.assertEqual(ss.rescale(None, D("24000")), ss.default_split(D("24000")))
        self.assertEqual(ss.rescale({}, D("24000")), ss.default_split(D("24000")))

    def test_parse_breakup(self):
        parts, error = ss.parse_breakup(payload(*WORKED_EXAMPLES[0][1:]))
        self.assertIsNone(error)
        self.assertEqual(parts["basic"], D("7166.67"))
        # numbers, ints and numeric strings are all fine
        ok = payload(*WORKED_EXAMPLES[1][1:])
        ok["basic"], ok["da"] = 4000, 4000.0
        self.assertIsNone(ss.parse_breakup(ok)[1])
        cases = {
            "not an object": ("x", "must be an object"),
            "missing key": (
                {k: v for k, v in payload(*WORKED_EXAMPLES[1][1:]).items() if k != "hra"},
                "missing: HRA",
            ),
        }
        for name, (raw, text) in cases.items():
            self.assertIn(text, ss.parse_breakup(raw)[1], name)
        base = payload(*WORKED_EXAMPLES[1][1:])
        for value, text in (
            (None, "must be an amount"),
            ("", "must be an amount"),
            ("  ", "must be an amount"),
            (True, "must be an amount"),
            ("abc", "must be a number"),
            ("NaN", "must be a number"),
            ("Infinity", "must be a number"),
            ("-1", "cannot be negative"),
            ("12.345", "at most two decimal places"),
            ("100000000", "too large"),
        ):
            self.assertIn(text, ss.parse_breakup(dict(base, basic=value))[1], repr(value))

    def test_resolve(self):
        total = D("43000")
        good = ss.default_split(total)
        # submitted and valid
        parts, error = ss.resolve(total, payload(*WORKED_EXAMPLES[0][1:]), None, total_changed=True)
        self.assertEqual((parts, error), (good, None))
        # submitted but not 50/50
        bad = payload(*WORKED_EXAMPLES[0][1:])
        bad["basic"] = "9000.00"
        self.assertIn("First portion", ss.resolve(total, bad, good, total_changed=False)[1])
        # nothing submitted: default for a new salary, re-scaled for a changed one, kept for an unchanged one
        self.assertEqual(ss.resolve(total, None, None, total_changed=True)[0], good)
        self.assertEqual(ss.resolve(D("86000"), None, good, total_changed=True)[0], ss.default_split(D("86000")))
        self.assertEqual(ss.resolve(total, None, good, total_changed=False)[0], good)
        # no salary, no split
        self.assertEqual(ss.resolve(None, None, good, total_changed=True), (None, None))
        self.assertEqual(ss.resolve(D("0"), None, good, total_changed=True), (None, None))
        self.assertIn(
            "needs a salary amount", ss.resolve(None, payload(*WORKED_EXAMPLES[0][1:]), None, total_changed=True)[1]
        )


# ── the API ───────────────────────────────────────────────────────────────────


def _hr():
    user, _ = HRUser.objects.get_or_create(
        username="split_admin", defaults={"password_hash": "x", "is_super_admin": True}
    )
    return {"HTTP_AUTHORIZATION": f"Bearer {sign_token({'role': 'hr', 'hrUserId': user.id})}"}


class ApiBase(TestCase):
    def setUp(self):
        self.hr = _hr()
        self.branch = Branch.objects.create(name="Head Office")

    def post(self, path, body):
        return self.client.post(path, body, content_type="application/json", **self.hr)

    def patch(self, path, body):
        return self.client.patch(path, body, content_type="application/json", **self.hr)

    def new(self, code="S1", **extra):
        body = {
            "employeeCode": code,
            "firstName": "Asha",
            "lastName": "Kumar",
            "phone": "9000000001",
            "employmentType": "staff",
            "salaryType": "monthly",
            "branchId": self.branch.id,
            **extra,
        }
        return self.post("/api/employees", body)

    def stored(self, code="S1"):
        return Employee.objects.get(employee_code=code)

    def split_of(self, code="S1"):
        return ss.breakup_of(self.stored(code))


class CreateTests(ApiBase):
    def test_a_salary_without_a_split_gets_the_automatic_one_for_monthly_and_weekly(self):
        for code, salary_type in (("M1", "monthly"), ("W1", "weekly")):
            r = self.new(code, salaryType=salary_type, salaryAmount=43000)
            self.assertEqual(r.status_code, 201, r.content)
            self.assertEqual(self.split_of(code), ss.default_split(D("43000")), salary_type)
            self.assertEqual(r.json()["salaryBreakup"]["basic"], 7166.67)
            self.assertEqual(r.json()["salaryBreakup"]["retainingAllowance"], 7166.66)
            self.assertEqual(r.json()["salaryBreakup"]["ca"], 4300.0)
            self.assertEqual(self.stored(code).salary_type, salary_type)

    def test_an_edited_split_that_is_still_50_50_is_kept_as_typed(self):
        first, second = ["21500.00", "0.00", "0.00"], ["1000.00", "1000.00", "10000.00", "9000.00", "500.00"]
        r = self.new("E1", salaryAmount=43000, salaryBreakup=payload(first, second))
        self.assertEqual(r.status_code, 201, r.content)
        self.assertEqual(self.split_of("E1"), parts_of(first, second))

    def test_a_split_that_is_not_50_50_is_refused_and_nothing_is_created(self):
        first, second = ["20000.00", "0.00", "0.00"], ["4300.00"] * 5  # 20,000 + 21,500
        r = self.new("E2", salaryAmount=43000, salaryBreakup=payload(first, second))
        self.assertEqual(r.status_code, 400)
        self.assertIn("First portion (Basic + DA + Retaining Allowance) is ₹20,000.00", r.json()["error"])
        self.assertFalse(Employee.objects.filter(employee_code="E2").exists())

    def test_a_malformed_split_is_refused(self):
        for bad in ("x", {"basic": "1"}, dict(payload(*WORKED_EXAMPLES[1][1:]), da="-5")):
            r = self.new("E3", salaryAmount=24000, salaryBreakup=bad)
            self.assertEqual(r.status_code, 400, bad)
        self.assertFalse(Employee.objects.filter(employee_code="E3").exists())

    def test_a_split_without_a_salary_is_refused(self):
        r = self.new("E4", salaryBreakup=payload(*WORKED_EXAMPLES[1][1:]))
        self.assertEqual(r.status_code, 400)
        self.assertIn("needs a salary amount", r.json()["error"])

    def test_a_production_employee_paid_per_shift_has_no_split(self):
        r = self.new("P1", employmentType="production", salaryPerShift=500)
        self.assertEqual(r.status_code, 201, r.content)
        self.assertIsNone(r.json()["salaryBreakup"])
        self.assertIsNone(self.split_of("P1"))

    def test_the_salary_amount_itself_is_stored_exactly_as_before(self):
        self.new("E5", salaryAmount=43000)
        emp = self.stored("E5")
        self.assertEqual((emp.salary_amount, emp.salary_type), (D("43000.00"), "monthly"))


class EditTests(ApiBase):
    def setUp(self):
        super().setUp()
        self.new("S1", salaryAmount=43000)
        self.emp = self.stored()

    def url(self):
        return f"/api/employees/{self.emp.id}"

    def test_a_valid_edited_split_is_saved(self):
        first, second = ["10000.00", "5000.00", "6500.00"], ["4300.00"] * 5
        r = self.patch(self.url(), {"salaryAmount": 43000, "salaryBreakup": payload(first, second)})
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(self.split_of(), parts_of(first, second))

    def test_an_invalid_edit_is_refused_and_nothing_at_all_is_saved(self):
        first, second = ["10000.00", "5000.00", "6500.00"], ["4300.00", "4300.00", "4300.00", "4300.00", "4000.00"]
        before = self.split_of()
        r = self.patch(
            self.url(), {"firstName": "Renamed", "salaryAmount": 43000, "salaryBreakup": payload(first, second)}
        )
        self.assertEqual(r.status_code, 400)
        self.assertIn("Second portion", r.json()["error"])
        self.emp.refresh_from_db()
        self.assertEqual((self.emp.first_name, self.split_of()), ("Asha", before))

    def test_a_new_salary_alone_rescales_the_split_keeping_its_shape(self):
        # for 82,000: first 41,000 = 30,000 + 10,000 + 1,000, second 41,000 all in Other Allowance
        first, second = ["30000.00", "10000.00", "1000.00"], ["41000.00", "0.00", "0.00", "0.00", "0.00"]
        self.assertEqual(
            self.patch(self.url(), {"salaryAmount": 82000, "salaryBreakup": payload(first, second)}).status_code, 200
        )
        r = self.patch(self.url(), {"salaryAmount": 41000})
        self.assertEqual(r.status_code, 200, r.content)
        split = self.split_of()
        self.assertIsNone(ss.validate(D("41000"), split))
        self.assertEqual(split["basic"], D("15000.00"))
        self.assertEqual(split["da"], D("5000.00"))
        self.assertEqual(split["retaining_allowance"], D("500.00"))
        self.assertEqual(split["other_allowance"], D("20500.00"))
        self.assertEqual(self.stored().salary_amount, D("41000.00"))

    def test_an_unchanged_salary_and_unrelated_edits_leave_the_split_alone(self):
        before = self.split_of()
        self.assertEqual(self.patch(self.url(), {"phone": "9111111111"}).status_code, 200)
        self.assertEqual(self.patch(self.url(), {"salaryAmount": 43000}).status_code, 200)
        self.assertEqual(self.split_of(), before)

    def test_switching_between_monthly_and_weekly_keeps_the_split(self):
        before = self.split_of()
        r = self.patch(self.url(), {"salaryType": "weekly"})
        self.assertEqual(r.status_code, 200)
        self.assertEqual((self.stored().salary_type, self.split_of()), ("weekly", before))

    def test_clearing_the_salary_clears_the_split_and_a_split_with_no_salary_is_refused(self):
        r = self.patch(self.url(), {"salaryAmount": None})
        self.assertEqual(r.status_code, 200, r.content)
        self.assertIsNone(self.split_of())
        r = self.patch(self.url(), {"salaryBreakup": payload(*WORKED_EXAMPLES[1][1:])})
        self.assertEqual(r.status_code, 400)

    def test_an_employee_who_never_had_a_split_gets_one_when_their_salary_is_saved(self):
        Employee.objects.filter(pk=self.emp.pk).update(**{c: None for c in ss.COLUMN_NAMES})
        self.assertIsNone(self.split_of())
        self.assertEqual(self.patch(self.url(), {"phone": "9222222222"}).status_code, 200)
        self.assertIsNone(self.split_of())  # an edit that doesn't touch the salary changes nothing
        self.patch(self.url(), {"salaryAmount": 50000})
        self.assertEqual(self.split_of(), ss.default_split(D("50000")))

    def test_the_split_is_returned_by_the_read_endpoints(self):
        body = self.client.get(self.url(), **self.hr).json()
        self.assertEqual(body["salaryBreakup"]["basic"], 7166.67)
        listed = self.client.get("/api/employees", **self.hr).json()
        row = next(e for e in listed if e["employeeCode"] == "S1")
        self.assertIn("salaryBreakup", row)

    def test_an_employee_without_a_split_reads_as_null(self):
        Employee.objects.filter(pk=self.emp.pk).update(**{c: None for c in ss.COLUMN_NAMES})
        self.assertIsNone(self.client.get(self.url(), **self.hr).json()["salaryBreakup"])


class IncrementTests(ApiBase):
    def test_an_increment_moves_the_split_with_the_salary(self):
        self.new("S1", salaryAmount=40000)
        emp = self.stored()
        first, second = ["10000.00", "8000.00", "2000.00"], ["20000.00", "0.00", "0.00", "0.00", "0.00"]
        self.patch(f"/api/employees/{emp.id}", {"salaryAmount": 40000, "salaryBreakup": payload(first, second)})
        r = self.post("/api/increments", {"employeeId": emp.id, "percent": 10})
        self.assertEqual(r.status_code, 201, r.content)
        emp.refresh_from_db()
        self.assertEqual(emp.salary_amount, D("44000.00"))
        split = ss.breakup_of(emp)
        self.assertIsNone(ss.validate(D("44000"), split))
        self.assertEqual(
            (split["basic"], split["da"], split["retaining_allowance"]), (D("11000.00"), D("8800.00"), D("2200.00"))
        )
        self.assertEqual(split["other_allowance"], D("22000.00"))
        self.assertEqual(SalaryIncrement.objects.filter(employee=emp).count(), 1)

    def test_an_increment_for_an_employee_with_no_split_gives_them_the_default(self):
        self.new("S1", salaryAmount=40000)
        emp = self.stored()
        Employee.objects.filter(pk=emp.pk).update(**{c: None for c in ss.COLUMN_NAMES})
        self.assertEqual(self.post("/api/increments", {"employeeId": emp.id, "amount": 2000}).status_code, 201)
        emp.refresh_from_db()
        self.assertEqual(ss.breakup_of(emp), ss.default_split(D("42000")))


# ── bulk upload / bulk update ─────────────────────────────────────────────────


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


class BulkTests(ApiBase):
    def upload(self, headers, rows, path="/api/employees/bulk-upload"):
        return self.client.post(path, {"file": _sheet(headers, rows)}, **self.hr)

    def base_cells(self, code, **extra):
        return dict(
            {
                "Employee Code": code,
                "First Name": "Bulk",
                "Last Name": code,
                "Phone": "9000000002",
                "Employment Type": "Staff",
                "Branch": "Head Office",
                "Salary Type": "Monthly",
                "Salary Amount": 43000,
            },
            **extra,
        )

    def test_the_template_now_ends_with_the_eight_split_columns(self):
        self.assertEqual(EMPLOYEE_UPLOAD_HEADERS[: len(LEGACY_UPLOAD_HEADERS)], LEGACY_UPLOAD_HEADERS)
        self.assertEqual(
            SPLIT_HEADERS,
            [
                "Basic",
                "DA",
                "Retaining Allowance",
                "Other Allowance",
                "Petrol Allowance",
                "HRA",
                "Special Allowance",
                "CA",
            ],
        )
        self.assertEqual(EMPLOYEE_UPLOAD_HEADERS[-8:], SPLIT_HEADERS)

    def test_a_row_with_the_split_blank_gets_the_automatic_one(self):
        r = self.upload(EMPLOYEE_UPLOAD_HEADERS, [_row(EMPLOYEE_UPLOAD_HEADERS, **self.base_cells("B1"))])
        self.assertEqual(r.status_code, 201, r.content)
        self.assertEqual((r.json()["created"], r.json()["failed"]), (1, 0), r.json())
        self.assertEqual(self.split_of("B1"), ss.default_split(D("43000")))

    def test_a_typed_split_is_used_and_a_bad_one_fails_only_its_row(self):
        good = self.base_cells(
            "B2",
            Basic=21500,
            DA=0,
            **{
                "Retaining Allowance": 0,
                "Other Allowance": 4300,
                "Petrol Allowance": 4300,
                "HRA": 4300,
                "Special Allowance": 4300,
                "CA": 4300,
            },
        )
        bad = self.base_cells(
            "B3",
            Basic=30000,
            DA=0,
            **{
                "Retaining Allowance": 0,
                "Other Allowance": 4300,
                "Petrol Allowance": 4300,
                "HRA": 4300,
                "Special Allowance": 4300,
                "CA": 4300,
            },
        )
        r = self.upload(
            EMPLOYEE_UPLOAD_HEADERS, [_row(EMPLOYEE_UPLOAD_HEADERS, **good), _row(EMPLOYEE_UPLOAD_HEADERS, **bad)]
        )
        body = r.json()
        self.assertEqual((body["created"], body["failed"]), (1, 1), body)
        self.assertIn("Row 3:", body["errors"][0])
        self.assertIn("First portion", body["errors"][0])
        self.assertEqual(self.split_of("B2")["basic"], D("21500.00"))
        self.assertFalse(Employee.objects.filter(employee_code="B3").exists())

    def test_blank_cells_in_a_partly_filled_split_count_as_zero(self):
        cells = self.base_cells("B4", Basic=21500, **{"Other Allowance": 21500})
        r = self.upload(EMPLOYEE_UPLOAD_HEADERS, [_row(EMPLOYEE_UPLOAD_HEADERS, **cells)])
        self.assertEqual(r.json()["created"], 1, r.json())
        split = self.split_of("B4")
        self.assertEqual(
            (split["basic"], split["da"], split["other_allowance"], split["ca"]),
            (D("21500.00"), D("0.00"), D("21500.00"), D("0.00")),
        )

    def test_spreadsheet_numbers_with_stray_decimals_are_rounded_to_the_paisa(self):
        cells = self.base_cells(
            "B5",
            **{"Salary Amount": 25000},
            Basic=12500 / 3,
            DA=12500 / 3,
            **{"Retaining Allowance": 12500 - 2 * round(12500 / 3, 2)},
            **{"Other Allowance": 2500, "Petrol Allowance": 2500, "HRA": 2500, "Special Allowance": 2500, "CA": 2500},
        )
        r = self.upload(EMPLOYEE_UPLOAD_HEADERS, [_row(EMPLOYEE_UPLOAD_HEADERS, **cells)])
        self.assertEqual(r.json()["created"], 1, r.json())
        self.assertEqual(self.split_of("B5")["basic"], D("4166.67"))

    def test_a_split_typed_without_a_salary_amount_fails_the_row(self):
        cells = self.base_cells("B6", **{"Salary Amount": None}, Basic=100)
        r = self.upload(EMPLOYEE_UPLOAD_HEADERS, [_row(EMPLOYEE_UPLOAD_HEADERS, **cells)])
        self.assertEqual(r.json()["failed"], 1)
        self.assertIn("needs a salary amount", r.json()["errors"][0])

    def test_a_template_downloaded_before_the_split_columns_still_uploads(self):
        r = self.upload(
            LEGACY_UPLOAD_HEADERS,
            [_row(LEGACY_UPLOAD_HEADERS, **self.base_cells("B7", **{"Salary Type": "Weekly", "Salary Amount": 6000}))],
        )
        self.assertEqual(r.status_code, 201, r.content)
        self.assertEqual(r.json()["created"], 1, r.json())
        self.assertEqual(self.split_of("B7"), ss.default_split(D("6000")))
        self.assertEqual(self.stored("B7").salary_type, "weekly")

    def test_a_template_with_any_other_columns_is_still_refused(self):
        r = self.upload(EMPLOYEE_UPLOAD_HEADERS[:-1], [])
        self.assertEqual(r.status_code, 400)
        self.assertEqual(r.json()["error"], "invalid_template")
        r = self.upload(list(reversed(EMPLOYEE_UPLOAD_HEADERS)), [])
        self.assertEqual(r.status_code, 400)

    def test_production_rows_are_untouched(self):
        cells = {
            "Employee Code": "B8",
            "First Name": "Per",
            "Last Name": "Shift",
            "Phone": "9000000003",
            "Employment Type": "Production",
            "Branch": "Head Office",
            "Salary Per Shift": 500,
        }
        r = self.upload(EMPLOYEE_UPLOAD_HEADERS, [_row(EMPLOYEE_UPLOAD_HEADERS, **cells)])
        self.assertEqual(r.json()["created"], 1, r.json())
        self.assertIsNone(self.split_of("B8"))


class BulkUpdateTests(ApiBase):
    def setUp(self):
        super().setUp()
        self.new("U1", salaryAmount=43000)
        self.original = self.split_of("U1")

    def update(self, headers, **cells):
        cells = dict({"Employee Code": "U1"}, **cells)
        return self.client.post(
            "/api/employees/bulk-update", {"file": _sheet(headers, [_row(headers, **cells)])}, **self.hr
        )

    def export_row(self):
        emp = self.stored("U1")
        cells = {"Employee Code": "U1", "Salary Amount": float(emp.salary_amount)}
        for header, c in zip(SPLIT_HEADERS, ss.COMPONENTS):
            cells[header] = float(getattr(emp, ss.COLUMNS[c]))
        return cells

    def test_an_export_uploaded_back_unchanged_changes_nothing(self):
        r = self.update(EMPLOYEE_UPLOAD_HEADERS, **self.export_row())
        self.assertEqual((r.json()["updated"], r.json()["unchanged"]), (0, 1), r.json())
        self.assertEqual(self.split_of("U1"), self.original)

    def test_a_new_salary_with_the_old_split_still_in_the_sheet_rescales_instead_of_failing(self):
        cells = self.export_row()
        cells["Salary Amount"] = 50000
        r = self.update(EMPLOYEE_UPLOAD_HEADERS, **cells)
        body = r.json()
        self.assertEqual((body["updated"], body["failed"]), (1, 0), body)
        self.assertIn("Salary Split", body["changes"][0])
        self.assertEqual(self.stored("U1").salary_amount, D("50000.00"))
        split = self.split_of("U1")
        self.assertIsNone(ss.validate(D("50000"), split))
        self.assertLessEqual(abs(split["basic"] - D("8333.33")), D("0.01"))
        self.assertLessEqual(abs(split["ca"] - D("5000.00")), D("0.00"))

    def test_a_new_salary_alone_rescales(self):
        r = self.update(LEGACY_UPLOAD_HEADERS, **{"Salary Amount": 60000})
        self.assertEqual(r.json()["updated"], 1, r.json())
        split = self.split_of("U1")
        self.assertIsNone(ss.validate(D("60000"), split))
        self.assertLessEqual(abs(split["da"] - D("10000.00")), D("0.01"))

    def test_a_typed_split_replaces_the_stored_one_when_it_is_valid(self):
        cells = {
            "Employee Code": "U1",
            "Basic": 21500,
            "DA": 0,
            "Retaining Allowance": 0,
            "Other Allowance": 10000,
            "Petrol Allowance": 1500,
            "HRA": 5000,
            "Special Allowance": 3000,
            "CA": 2000,
        }
        r = self.update(EMPLOYEE_UPLOAD_HEADERS, **cells)
        self.assertEqual(r.json()["updated"], 1, r.json())
        self.assertEqual(self.split_of("U1")["basic"], D("21500.00"))
        self.assertEqual(self.split_of("U1")["hra"], D("5000.00"))

    def test_a_typed_split_that_is_not_50_50_fails_its_row_and_changes_nothing(self):
        cells = {
            "Employee Code": "U1",
            "Salary Amount": 43000,
            "First Name": "Changed",
            "Basic": 1,
            "DA": 1,
            "Retaining Allowance": 1,
            "Other Allowance": 1,
            "Petrol Allowance": 1,
            "HRA": 1,
            "Special Allowance": 1,
            "CA": 1,
        }
        r = self.update(EMPLOYEE_UPLOAD_HEADERS, **cells)
        self.assertEqual(r.json()["failed"], 1, r.json())
        self.assertIn("First portion", r.json()["errors"][0])
        self.assertEqual((self.stored("U1").first_name, self.split_of("U1")), ("Asha", self.original))

    def test_rows_that_touch_no_salary_leave_the_split_alone(self):
        r = self.update(EMPLOYEE_UPLOAD_HEADERS, **{"Phone": "9333333333"})
        self.assertEqual(r.json()["updated"], 1, r.json())
        self.assertEqual(self.split_of("U1"), self.original)


# ── nothing else moves ────────────────────────────────────────────────────────


class PayrollUnaffectedTests(TestCase):
    """The split is descriptive. Payroll runs on salary_amount, so a split (even a wildly different one) or no
    split at all must produce the same payslip to the paisa."""

    def _staff(self, code, **extra):
        return Employee.objects.create(
            employee_code=code,
            first_name=code,
            last_name="S",
            employment_type="staff",
            status="active",
            salary_type="monthly",
            salary_amount=D("24000.00"),
            **extra,
        )

    def test_payroll_is_identical_with_no_split_the_default_split_and_an_odd_one(self):
        from .tests_payroll_engine import MONTH, WORKING_DAYS, YEAR, _configure, _present_all

        _configure(
            staff_payroll_rules_enabled=False,
            pf_rate=D("12"),
            esi_rate=D("0.75"),
            esi_applicable_below=D("21000"),
            attendance_mode="simple",
            compensation_feature_enabled=True,
        )
        plain = self._staff("NOSPLIT")
        default = self._staff("DEFAULT", **{ss.COLUMNS[c]: v for c, v in ss.default_split(D("24000")).items()})
        odd = self._staff(
            "ODD",
            **{ss.COLUMNS[c]: v for c, v in parts_of(["23000", "500", "500"], ["0", "0", "0", "0", "12000"]).items()},
        )
        results = {}
        for emp in (plain, default, odd):
            _present_all(emp, WORKING_DAYS[:20])
            p = _generate_staff_payroll(emp, MONTH, YEAR)["payroll"]
            results[emp.employee_code] = (p.gross_salary, p.deductions, p.final_salary, p.base_salary)
        self.assertEqual(results["NOSPLIT"], results["DEFAULT"])
        self.assertEqual(results["NOSPLIT"], results["ODD"])
        self.assertEqual(results["NOSPLIT"][0], D("20000.00"))
        self.assertEqual(Payroll.objects.count(), 3)


class CorrectedNamesTests(ApiBase):
    """RHA is HRA and Retention Allowance is Retaining Allowance everywhere, and nothing that used the old names breaks:
    the database columns are untouched, an older client or script is still understood, and so is an older template."""

    def test_the_two_components_carry_the_right_names_in_code_labels_and_json(self):
        self.assertIn("hra", ss.SECOND_PORTION)
        self.assertIn("retaining_allowance", ss.FIRST_PORTION)
        self.assertEqual((ss.LABELS["hra"], ss.LABELS["retaining_allowance"]), ("HRA", "Retaining Allowance"))
        self.assertEqual((ss.JSON_KEYS["hra"], ss.JSON_KEYS["retaining_allowance"]), ("hra", "retainingAllowance"))
        self.assertEqual(
            (ss.COLUMNS["hra"], ss.COLUMNS["retaining_allowance"]), ("salary_hra", "salary_retaining_allowance")
        )
        for old in ("rha", "retention_allowance"):
            self.assertNotIn(old, ss.COMPONENTS)
        self.assertNotIn("RHA", ss.LABELS.values())

    def test_the_database_columns_did_not_move(self):
        # Only the Python names changed: no data moves, and the release still running keeps reading the same columns.
        self.assertEqual(Employee._meta.get_field("salary_hra").column, "salary_rha")
        self.assertEqual(Employee._meta.get_field("salary_retaining_allowance").column, "salary_retention_allowance")

    def test_the_api_speaks_only_the_new_names(self):
        r = self.new("N1", salaryAmount=43000)
        self.assertEqual(r.status_code, 201, r.content)
        keys = set(r.json()["salaryBreakup"])
        self.assertEqual(
            keys,
            {"basic", "da", "retainingAllowance", "otherAllowance", "petrolAllowance", "hra", "specialAllowance", "ca"},
        )

    def test_a_split_sent_with_the_old_names_is_still_understood(self):
        first, second = ["21500.00", "0.00", "0.00"], ["1000.00", "1000.00", "10000.00", "9000.00", "500.00"]
        old = {ss.JSON_KEYS[c]: str(v) for c, v in parts_of(first, second).items()}
        old["retentionAllowance"] = old.pop("retainingAllowance")
        old["rha"] = old.pop("hra")
        r = self.new("O1", salaryAmount=43000, salaryBreakup=old)
        self.assertEqual(r.status_code, 201, r.content)
        self.assertEqual(self.split_of("O1"), parts_of(first, second))
        self.assertEqual(r.json()["salaryBreakup"]["hra"], 10000.0)  # and it answers in the new names

    def test_when_both_names_are_sent_the_new_one_wins(self):
        first, second = ["21500.00", "0.00", "0.00"], ["1000.00", "1000.00", "10000.00", "9000.00", "500.00"]
        both = payload(first, second)
        both["rha"] = "123456.00"  # stale and wrong: ignored
        self.assertEqual(self.new("O2", salaryAmount=43000, salaryBreakup=both).status_code, 201)
        self.assertEqual(self.split_of("O2")["hra"], D("10000.00"))

    def test_an_error_names_the_component_by_its_new_name(self):
        gone = {k: v for k, v in payload(*WORKED_EXAMPLES[1][1:]).items() if k != "hra"}
        r = self.new("O3", salaryAmount=24000, salaryBreakup=gone)
        self.assertEqual(r.status_code, 400)
        self.assertIn("missing: HRA", r.json()["error"])

    def test_the_stored_values_are_read_back_through_the_new_attributes(self):
        self.new("O4", salaryAmount=43000)
        emp = self.stored("O4")
        self.assertEqual((emp.salary_hra, emp.salary_retaining_allowance), (D("4300.00"), D("7166.66")))
        self.assertFalse(hasattr(emp, "salary_rha"))
        self.assertFalse(hasattr(emp, "salary_retention_allowance"))


class OlderTemplatesStillUploadTests(ApiBase):
    """A sheet downloaded before the names were corrected has the headers RHA and Retention Allowance."""

    upload = BulkTests.upload  # the same helpers, without re-running BulkTests' own tests
    base_cells = BulkTests.base_cells

    OLD = [{"HRA": "RHA", "Retaining Allowance": "Retention Allowance"}.get(h, h) for h in EMPLOYEE_UPLOAD_HEADERS]

    def test_the_old_headers_are_read_as_the_new_ones_on_upload_and_on_update(self):
        self.assertIn("RHA", self.OLD)
        self.assertIn("Retention Allowance", self.OLD)
        cells = self.base_cells(
            "T1",
            Basic=21500,
            DA=0,
            **{
                "Retention Allowance": 0,
                "Other Allowance": 4300,
                "Petrol Allowance": 4300,
                "RHA": 4300,
                "Special Allowance": 4300,
                "CA": 4300,
            },
        )
        r = self.upload(self.OLD, [_row(self.OLD, **cells)])
        self.assertEqual((r.status_code, r.json()["created"], r.json()["failed"]), (201, 1, 0), r.content)
        split = ss.breakup_of(Employee.objects.get(employee_code="T1"))
        self.assertEqual(
            (split["hra"], split["retaining_allowance"], split["basic"]), (D("4300.00"), D("0.00"), D("21500.00"))
        )

        # the same file through "update existing" (the export of that time) changes one split cell
        cells["RHA"] = 4400
        cells["Other Allowance"] = 4200
        r = self.upload(self.OLD, [_row(self.OLD, **cells)], path="/api/employees/bulk-update")
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(r.json()["counts"]["updated"], 1, r.json())
        self.assertEqual(ss.breakup_of(Employee.objects.get(employee_code="T1"))["hra"], D("4400.00"))

    def test_the_new_headers_are_what_a_template_has_now(self):
        self.assertIn("HRA", EMPLOYEE_UPLOAD_HEADERS)
        self.assertIn("Retaining Allowance", EMPLOYEE_UPLOAD_HEADERS)
        self.assertNotIn("RHA", EMPLOYEE_UPLOAD_HEADERS)
        self.assertNotIn("Retention Allowance", EMPLOYEE_UPLOAD_HEADERS)

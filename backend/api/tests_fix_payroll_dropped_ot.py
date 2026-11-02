"""The one-off correction for payroll rows the old edit damaged (management command fix_payroll_dropped_ot)."""

from decimal import Decimal
from io import StringIO

from django.core.management import call_command
from django.test import TestCase

from api.models import AuditLog, Employee, Payroll


def _emp(code):
    return Employee.objects.create(
        employee_code=code, first_name=code, last_name="Staff", employment_type="staff", status="active",
        salary_type="monthly", salary_amount=Decimal("20000"),
    )  # fmt: skip


def _payroll(emp, final, ot="1700", bonus="0", deductions="1000", month=9, status="paid"):
    return Payroll.objects.create(
        employee=emp, salary_mode="monthly", month=month, year=2026, base_salary=Decimal("20000"),
        gross_salary=Decimal("20000"), ot_amount=Decimal(ot), bonus=Decimal(bonus), deductions=Decimal(deductions),
        final_salary=Decimal(final), status=status,
    )  # fmt: skip


def _run(*args):
    out = StringIO()
    call_command("fix_payroll_dropped_ot", *args, stdout=out)
    return out.getvalue()


class FixPayrollDroppedOtTests(TestCase):
    def setUp(self):
        # damaged by "Mark as Paid": 20,000 - 1,000 instead of 20,000 + 1,700 - 1,000
        self.damaged = _payroll(_emp("D1"), "19000.00")
        # damaged by a bonus edit: 20,000 + 500 - 1,000, OT 1,700 missing
        self.damaged_bonus = _payroll(_emp("D2"), "19500.00", bonus="500", month=8)
        # correct rows and rows HR changed some other way are never touched
        self.correct = _payroll(_emp("OK1"), "20700.00")
        self.no_ot = _payroll(_emp("OK2"), "19000.00", ot="0")
        self.other_edit = _payroll(_emp("OK3"), "18000.00")

    def test_dry_run_lists_only_the_damaged_rows_and_changes_nothing(self):
        out = _run()
        self.assertIn("D1", out)
        self.assertIn("D2", out)
        for code in ("OK1", "OK2", "OK3"):
            self.assertNotIn(f" {code} ", out)
        self.assertIn("2 record(s); overtime to put back: Rs. 3400.00", out)
        self.assertIn("DRY RUN", out)
        self.damaged.refresh_from_db()
        self.assertEqual(self.damaged.final_salary, Decimal("19000.00"))
        self.assertFalse(AuditLog.objects.exists())

    def test_apply_puts_the_overtime_back_with_a_note_and_an_audit_entry(self):
        out = _run("--apply", "--noinput")
        self.assertIn("Corrected 2 payroll record(s).", out)
        self.damaged.refresh_from_db()
        self.damaged_bonus.refresh_from_db()
        self.assertEqual(self.damaged.final_salary, Decimal("20700.00"))
        self.assertEqual(self.damaged_bonus.final_salary, Decimal("21200.00"))
        self.assertEqual(self.damaged.status, "paid")
        self.assertIn("Overtime Rs. 1700.00 put back: final salary 19000.00 -> 20700.00", self.damaged.notes)
        for p, before in ((self.correct, "20700.00"), (self.no_ot, "19000.00"), (self.other_edit, "18000.00")):
            p.refresh_from_db()
            self.assertEqual(p.final_salary, Decimal(before))
        log = AuditLog.objects.get(record_id=self.damaged.pk)
        self.assertEqual((log.module, log.action, log.user_name), ("payroll", "update", "fix_payroll_dropped_ot"))
        self.assertEqual((log.old_values, log.new_values["finalSalary"]), ({"finalSalary": 19000.0}, 20700.0))
        self.assertEqual(AuditLog.objects.count(), 2)

    def test_running_it_again_finds_nothing(self):
        _run("--apply", "--noinput")
        self.assertIn("Nothing to correct", _run())

    def test_month_filter(self):
        out = _run("--year", "2026", "--month", "8")
        self.assertIn("D2", out)
        self.assertNotIn("D1", out)

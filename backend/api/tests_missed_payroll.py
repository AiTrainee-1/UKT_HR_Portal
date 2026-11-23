"""HR -> Payroll -> Missed Payroll (owner 2026-11-23): who the regular payroll missed and why, figures exactly the regular
engines' (worked out and rolled back), Generate / Clear / Done / Paid, Done writing into the month's payroll (a held row
replaced and released, no second row), the main pages leaving those rows alone (no rework, no bank file, no Mark as Paid,
remark on the statement), production paying only days no payroll pays, rights and the three files.

Run via: DB_TEST_NAME=test_uktex_missed python manage.py test api.tests_missed_payroll
"""

from datetime import date
from decimal import Decimal
from unittest import mock

from django.db import transaction
from django.test import TestCase
from django.utils import timezone

from . import payroll_month_workflow as month_workflow
from . import production_coverage as coverage
from .attendance_final import _holiday_dates_for_month
from .missed_payroll import engine
from .models import (
    Advance,
    AdvanceRepayment,
    Branch,
    Department,
    Employee,
    HRUser,
    MissedPayroll,
    Notification,
    Payroll,
    PayrollMonthClose,
    Role,
    SalarySlip,
)
from .payroll_statement_views import _workflow_remarks
from .payroll_views import MISSED_PAYROLL_OWNS, PayrollSkip, _generate_staff_payroll
from .permission_registry import resolve_module
from .tests_payroll_engine import MONTH, WORKING_DAYS, YEAR, _configure, _day, _present_all, _production, _staff
from .tests_salary_slip_center import _payroll_figures, _token

URL = "/api/missed-payroll/"


class _Base(TestCase):
    def setUp(self):
        _configure(
            staff_pf_rules=[],
            staff_esi_rules=[],
            late_free_allowance=3,
            permission_monthly_cap=3,
            attendance_mode="simple",
        )
        self.addCleanup(_holiday_dates_for_month.cache_clear)
        _holiday_dates_for_month.cache_clear()
        # the paid notification runs at once in tests (it waits for the commit and a thread otherwise)
        pin = mock.patch.object(month_workflow, "run_in_background", lambda job, name: job())
        pin.start()
        self.addCleanup(pin.stop)
        self.head = Branch.objects.create(name="MP Head Office", code="MP_HO", is_head_office=True)
        self.unit = Branch.objects.create(name="MP Unit 7", code="Unit7")
        dept = Department.objects.create(name="ACCOUNTS", branch=self.head)
        self.admin = HRUser.objects.create(username="mp_admin", password_hash="x", is_super_admin=True)
        bank = {"bank_account": "123456789012", "bank_ifsc": "HDFC0000001", "bank_name": "HDFC"}
        self.a = _staff(code="MPA", salary="26000.00", branch=self.head, department=dept, **bank)
        self.b = _staff(code="MPB", salary="0", branch=self.head)
        self.c = _staff(code="MPC", salary="22000.00", branch=self.unit, join_date=date(YEAR, MONTH, 10).isoformat())
        self.d = _staff(code="MPD", salary="20000.00", branch=self.head, **bank)
        self.e = _staff(code="MPE", salary="21000.00", branch=self.head)
        self.f = _staff(code="MPF", salary="19000.00", branch=self.head)
        for emp in (self.a, self.b, self.c, self.d, self.e, self.f):
            _present_all(emp)
        Employee.objects.filter(pk=self.f.pk).update(status="inactive")
        self.f.refresh_from_db()
        # D: worked out by the Staff Payroll, then put on Hold; E: in the payroll, not Cleared
        _generate_staff_payroll(self.d, MONTH, YEAR)
        Payroll.objects.filter(employee=self.d).update(on_hold=True, hold_changed_by="Meena")
        _generate_staff_payroll(self.e, MONTH, YEAR)
        self.auth = _token(self.admin)

    def get(self, path, auth=None, **params):
        return self.client.get(URL + path, params, **(auth or self.auth))

    def post(self, path, body, auth=None):
        return self.client.post(URL + path, body, content_type="application/json", **(auth or self.auth))

    def act(self, action, *emps, kind="staff", auth=None, **extra):
        body = {"kind": kind, "month": MONTH, "year": YEAR, "employeeIds": [e.id for e in emps], **extra}
        return self.post(action, body, auth)

    def rows(self, kind="staff"):
        r = self.get("employees", kind=kind, month=MONTH, year=YEAR)
        self.assertEqual(r.status_code, 200, r.content)
        return {row["code"]: row for row in r.json()["employees"]}

    def entry(self, emp, kind="staff"):
        return MissedPayroll.objects.get(employee=emp, kind=kind, month=MONTH, year=YEAR)

    def through_done(self, emp, kind="staff"):
        self.assertEqual(self.act("generate", emp, kind=kind).json()["skipped"], [])
        self.assertEqual(self.act("clear", emp, kind=kind).json()["refused"], [])
        r = self.act("done", emp, kind=kind)
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(r.json()["refused"], [])
        return self.entry(emp, kind)


class StaffListTests(_Base):
    def test_every_reason_the_payroll_missed_someone(self):
        rows = self.rows()
        got = {code: rows[code]["category"] for code in ("MPA", "MPB", "MPC", "MPD", "MPE", "MPF")}
        self.assertEqual(
            got,
            {
                "MPA": "not_generated",
                "MPB": "no_salary",
                "MPC": "new_joiner",
                "MPD": "on_hold",
                "MPE": "not_cleared",
                "MPF": "inactive",
            },
        )
        self.assertTrue(rows["MPA"]["canGenerate"])
        self.assertFalse(rows["MPB"]["canGenerate"])
        self.assertIn("salary", rows["MPB"]["cannotGenerate"])
        self.assertFalse(rows["MPE"]["canGenerate"])  # in the payroll already: generating here would pay twice
        self.assertEqual(rows["MPD"]["payroll"]["onHold"], True)
        self.assertEqual(rows["MPF"]["status"], "inactive")

    def test_someone_paid_by_the_payroll_and_cleared_is_not_listed(self):
        Payroll.objects.filter(employee=self.e).update(status=Payroll.STATUS_PAID)
        self.assertNotIn("MPE", self.rows())

    def test_the_permission_key_guards_the_api(self):
        self.assertEqual(resolve_module("missed-payroll/employees"), "missed_payroll")
        self.assertEqual(resolve_module("missed-payroll/download/bank-file"), "missed_payroll")


class GenerateTests(_Base):
    def test_the_figures_are_the_staff_payrolls_and_nothing_is_saved(self):
        payrolls, slips = Payroll.objects.count(), SalarySlip.objects.count()
        r = self.act("generate", self.a)
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(r.json()["skipped"], [])
        entry = self.entry(self.a)
        expected = _payroll_figures(self.a)
        self.assertEqual(entry.net, expected["net"])
        self.assertEqual(Decimal(entry.figures["slip"]["gross_salary"]), expected["gross"])
        self.assertEqual((entry.status, entry.category, entry.replaces_id), ("generated", "not_generated", None))
        self.assertEqual((Payroll.objects.count(), SalarySlip.objects.count()), (payrolls, slips))

    def test_no_salary_and_in_the_payroll_are_refused_with_the_reason(self):
        out = self.act("generate", self.b, self.e).json()
        self.assertEqual(out["generated"], [])
        reasons = {s["employeeCode"]: s["reason"] for s in out["skipped"]}
        self.assertIn("salary", reasons["MPB"])
        self.assertIn("Payroll Details", reasons["MPE"])

    def test_again_replaces_a_generated_entry_but_not_a_cleared_one(self):
        self.act("generate", self.a)
        Employee.objects.filter(pk=self.a.pk).update(salary_amount=Decimal("30000.00"))
        self.act("generate", self.a)
        entry = self.entry(self.a)
        self.assertEqual(Decimal(entry.figures["payroll"]["base_salary"]), Decimal("30000.00"))
        self.assertIsNotNone(entry.regenerated_at)
        self.act("clear", self.a)
        out = self.act("generate", self.a).json()
        self.assertIn("Cleared", out["skipped"][0]["reason"])
        self.act("unclear", self.a)
        self.assertEqual(self.act("generate", self.a).json()["skipped"], [])

    def test_discard_drops_a_generated_entry(self):
        self.act("generate", self.a)
        self.assertEqual(len(self.act("discard", self.a).json()["done"]), 1)
        self.assertFalse(MissedPayroll.objects.exists())


class DoneTests(_Base):
    def test_done_needs_clear_first(self):
        self.act("generate", self.a)
        out = self.act("done", self.a).json()
        self.assertEqual(out["done"], [])
        self.assertIn("Clear it first", out["refused"][0]["reason"])

    def test_done_writes_the_month_row_and_slip(self):
        entry = self.through_done(self.a)
        p = Payroll.objects.get(employee=self.a, month=MONTH, year=YEAR)
        self.assertEqual(entry.payroll_id, p.id)
        self.assertEqual(
            (p.source, p.status, p.on_hold, p.payment_status), ("missed_payroll", "paid", False, "not_paid")
        )
        self.assertEqual(p.final_salary, entry.net)
        self.assertTrue(month_workflow.staff_month(MONTH, YEAR).filter(month_workflow.MAIN_PAYROLL_Q, pk=p.pk).exists())
        slip = SalarySlip.objects.get(employee=self.a, month=MONTH, year=YEAR)
        self.assertEqual(slip.net_salary, entry.net)
        self.assertEqual(entry.status, "done")
        # listed as processed, under the category it was generated for
        row = self.rows()["MPA"]
        self.assertEqual((row["category"], row["entry"]["status"]), ("not_generated", "done"))

    def test_a_held_salary_is_recalculated_and_released_into_the_month(self):
        held = Payroll.objects.get(employee=self.d)
        entry = self.through_done(self.d)
        self.assertEqual(entry.replaces_id, held.id)
        self.assertEqual(Payroll.objects.filter(employee=self.d).count(), 1)  # no second row
        held.refresh_from_db()
        self.assertEqual((held.on_hold, held.source, held.status), (False, "missed_payroll", "paid"))
        self.assertEqual(held.final_salary, entry.net)

    def test_a_new_joiner_with_no_row_is_added(self):
        entry = self.through_done(self.c)
        p = Payroll.objects.get(pk=entry.payroll_id)
        self.assertFalse(p.new_joiner_parked)
        self.assertIsNotNone(p.added_to_payroll_at)

    def test_done_is_refused_when_the_payroll_made_a_row_meanwhile(self):
        self.act("generate", self.a)
        self.act("clear", self.a)
        _generate_staff_payroll(self.a, MONTH, YEAR)  # the Staff Payroll generated them after all
        out = self.act("done", self.a).json()
        self.assertEqual(out["done"], [])
        self.assertIn("now has a payroll", out["refused"][0]["reason"])
        self.assertEqual(self.entry(self.a).status, "cleared")

    def test_the_advance_instalment_is_taken_once_at_done(self):
        adv = Advance.objects.create(
            employee=self.a,
            advance_type="general",
            amount=Decimal("3000"),
            status="approved",
            total_repaid=Decimal("0"),
            outstanding=Decimal("3000"),
        )
        rep = AdvanceRepayment.objects.create(advance=adv, month=MONTH, year=YEAR, amount=Decimal("1000"))
        self.act("generate", self.a)
        rep.refresh_from_db()
        self.assertFalse(rep.is_processed)  # generating saves nothing
        self.assertEqual(Decimal(self.entry(self.a).figures["slip"]["advance_deduction"]), Decimal("1000.00"))
        self.act("clear", self.a)
        self.act("done", self.a)
        rep.refresh_from_db()
        adv.refresh_from_db()
        self.assertTrue(rep.is_processed)
        self.assertEqual(adv.outstanding, Decimal("2000"))

    def test_done_and_paid_need_a_login_for_all_units(self):
        role = Role.objects.create(name="Unit payroll", permissions={"payroll": "edit"})
        unit_hr = HRUser.objects.create(username="mp_unit", password_hash="x", role=role, branch=self.unit)
        auth = _token(unit_hr)
        self.assertEqual(self.act("generate", self.c, auth=auth).status_code, 200)
        self.act("clear", self.c, auth=auth)
        self.assertEqual(self.act("done", self.c, auth=auth).status_code, 403)
        self.assertEqual(self.act("paid", self.c, auth=auth).status_code, 403)
        # a unit login only sees its own unit
        self.assertEqual(set(self.rows_for(auth)), {"MPC"})

    def rows_for(self, auth):
        r = self.get("employees", auth=auth, kind="staff", month=MONTH, year=YEAR)
        return {row["code"] for row in r.json()["employees"]}


class MainPagesLeaveItAloneTests(_Base):
    def test_the_staff_engine_never_works_it_out_again(self):
        self.through_done(self.a)
        with self.assertRaises(PayrollSkip) as caught:
            with transaction.atomic():
                _generate_staff_payroll(self.a, MONTH, YEAR)
        self.assertEqual(str(caught.exception), MISSED_PAYROLL_OWNS)

    def test_payroll_details_cannot_change_it(self):
        p = Payroll.objects.get(pk=self.through_done(self.a).payroll_id)
        r = self.client.patch(
            f"/api/payroll/{p.id}", {"status": "pending"}, content_type="application/json", **self.auth
        )
        self.assertEqual(r.status_code, 409)
        self.assertIn("Missed Payroll", r.json()["error"])

    def test_the_months_mark_as_paid_leaves_it_to_this_page(self):
        p = Payroll.objects.get(pk=self.through_done(self.a).payroll_id)
        PayrollMonthClose.objects.create(month=MONTH, year=YEAR, finalized_at=timezone.now(), finalized_by="Meena")
        _close, ids = month_workflow.mark_paid(MONTH, YEAR, "Meena")
        self.assertNotIn(p.id, ids)
        p.refresh_from_db()
        self.assertEqual(p.payment_status, "not_paid")
        self.assertEqual(month_workflow.payroll_flags(p)["source"], "missed_payroll")

    def test_the_statement_says_missed_payroll(self):
        p = Payroll.objects.get(pk=self.through_done(self.a).payroll_id)
        self.assertEqual(_workflow_remarks(p, ""), "MISSED PAYROLL")


class PaidTests(_Base):
    def test_paid_marks_the_payment_and_tells_the_employee_once(self):
        entry = self.through_done(self.a)
        r = self.act("paid", self.a, paidOn="2026-11-20")
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(r.json()["notified"], 1)
        p = Payroll.objects.get(pk=entry.payroll_id)
        self.assertEqual(p.payment_status, "paid")
        entry.refresh_from_db()
        self.assertEqual((entry.status, entry.paid_on), ("paid", date(2026, 11, 20)))
        self.assertEqual(Notification.objects.filter(employee=self.a, type="salary_slip").count(), 1)
        again = self.act("paid", self.a).json()
        self.assertEqual(again["done"], [])
        self.assertEqual(Notification.objects.filter(employee=self.a, type="salary_slip").count(), 1)

    def test_paid_needs_done_and_a_real_day(self):
        self.act("generate", self.a)
        self.assertIn("Done", self.act("paid", self.a).json()["refused"][0]["reason"])
        self.assertEqual(self.act("paid", self.a, paidOn="2999-01-01").status_code, 400)


class FilesTests(_Base):
    def ids(self, *emps):
        return ",".join(str(e.id) for e in emps)

    def test_statement_report_and_bank_file(self):
        self.act("generate", self.a, self.d)
        params = {"kind": "staff", "month": MONTH, "year": YEAR, "ids": self.ids(self.a, self.d)}
        pdf = self.get("download/statement", **params)
        self.assertEqual((pdf.status_code, pdf["Content-Type"]), (200, "application/pdf"))
        xlsx = self.get("download/statement", fmt="xlsx", **params)
        self.assertEqual(xlsx.status_code, 200)
        self.assertEqual(self.get("download/report", **params).status_code, 200)
        check = self.get("bank-check", **params).json()
        self.assertEqual(check["included"], [])
        self.assertTrue(all("Not Done" in row["reason"] for row in check["leftOut"]))
        self.assertEqual(self.get("download/bank-file", **params).status_code, 409)
        self.act("clear", self.a)
        self.act("done", self.a)
        check = self.get("bank-check", **params).json()
        self.assertEqual([row["code"] for row in check["included"]], ["MPA"])
        bank = self.get("download/bank-file", **params)
        self.assertEqual(bank.status_code, 200)

    def test_one_entrys_figures(self):
        self.act("generate", self.a)
        body = self.get("entry", id=self.entry(self.a).id).json()
        self.assertEqual(body["employee"]["code"], "MPA")
        self.assertTrue(body["earnings"])
        self.assertEqual(body["statement"]["status"], "GENERATED")


class ProductionTests(_Base):
    def setUp(self):
        super().setUp()
        self.p = _production(code="MPP", branch=self.unit, bank_account="5555", bank_ifsc="ICIC0000001")
        self.q = _production(code="MPQ", per_shift="0", branch=self.unit)
        self.r = _production(code="MPR", branch=self.unit)
        for emp in (self.p, self.q, self.r):
            for d in WORKING_DAYS[:8]:
                _day(emp, d)
        # R: the Production Payroll already paid (a draft) the first half of the month
        first, last = engine.month_bounds(MONTH, YEAR)
        Payroll.objects.create(
            employee=self.r,
            salary_mode=Payroll.SALARY_MODE_SHIFT,
            month=MONTH,
            year=YEAR,
            period_start=first,
            period_end=date(YEAR, MONTH, 14),
            pay_cycle="biweekly",
            base_salary=Decimal("0"),
            gross_salary=Decimal("0"),
            final_salary=Decimal("0"),
        )
        self.last = last

    def test_the_list_and_the_days_no_payroll_pays(self):
        rows = self.rows("production")
        self.assertEqual(rows["MPP"]["category"], "not_generated")
        self.assertEqual(rows["MPQ"]["category"], "no_salary")
        self.assertEqual(rows["MPP"]["payDays"]["days"], self.last.day)
        self.assertEqual(rows["MPR"]["payDays"]["ranges"][0][0], date(YEAR, MONTH, 15).isoformat())

    def test_done_adds_one_row_for_the_month_and_it_is_final(self):
        entry = self.through_done(self.p, kind="production")
        p = Payroll.objects.get(pk=entry.payroll_id)
        self.assertEqual((p.period_start, p.period_end), engine.month_bounds(MONTH, YEAR))
        self.assertEqual(p.source, "missed_payroll")
        self.assertEqual(p.gross_salary, Decimal("4000.00"))  # 8 shifts x 500
        spans = coverage.spans_for_employee(self.p.id)
        self.assertTrue(spans and all(s.row.final for s in spans))
        # nothing of the month is left to pay now
        self.assertNotIn("MPP", {c for c, r in self.rows("production").items() if r["entry"] is None})

    def test_a_worker_paid_by_a_draft_for_their_worked_days_is_not_missed(self):
        # R worked only in the first half, which the draft pays: only listed to check (the draft is not Cleared)
        self.assertEqual(self.rows("production")["MPR"]["category"], "not_cleared")

    def test_only_the_days_no_payroll_pays_are_paid(self):
        later = [d for d in WORKING_DAYS if d.day >= 16][:3]
        for d in later:
            _day(self.r, d)
        self.assertEqual(self.rows("production")["MPR"]["category"], "not_generated")
        self.assertEqual(self.act("generate", self.r, kind="production").json()["skipped"], [])
        entry = self.entry(self.r, kind="production")
        self.assertEqual(entry.figures["payRanges"], [[date(YEAR, MONTH, 15).isoformat(), self.last.isoformat()]])
        # the first half is the draft's: only the three days worked after it are paid here
        self.assertEqual(entry.gross, Decimal("1500.00"))

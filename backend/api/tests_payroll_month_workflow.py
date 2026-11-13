"""Staff Payroll month workflow (owner 2026-11-10): Hold / Unhold, new joiners parked until "Add to payroll", Payroll Done
(the month is locked for good), Mark as Paid (payment status + one phone notification per employee), the employee apps
saying Paid only after that, and the release-and-pay of a held / new employee after the lock. No payroll figure ever
changes because of any of it.

Run via: python manage.py test api.tests_payroll_month_workflow
"""

import json
from datetime import date, timedelta
from decimal import Decimal
from unittest import mock

from django.test import TestCase
from django.utils import timezone

from . import payroll_month_workflow as wf
from .attendance_final import _holiday_dates_for_month
from .clock import FACTORY_TZ
from .jwt_utils import sign_token
from .models import (
    AttendanceDayRecord,
    Branch,
    Department,
    Employee,
    HRUser,
    Notification,
    Payroll,
    PayrollMonthClose,
    PayrollSettings,
    PushToken,
    Role,
    SalarySlip,
)
from .payroll_views import _build_working_days, _generate_staff_payroll

MONTH, YEAR = 9, 2026  # September 2026: in the past, so every day of it has been computed
LABEL = "September 2026"
DAYS = _build_working_days(MONTH, YEAR, False, set())
EXPO = "api.signals.requests.post"
FIGURES = ("gross_salary", "deductions", "bonus", "ot_amount", "final_salary", "present_days", "absent_days")


def _hdr(user: HRUser) -> dict:
    return {"HTTP_AUTHORIZATION": f"Bearer {sign_token({'role': 'hr', 'hrUserId': user.id})}"}


def _emp_hdr(emp: Employee) -> dict:
    return {"HTTP_AUTHORIZATION": f"Bearer {sign_token({'role': 'employee', 'employeeId': emp.id})}"}


def _figures(p: Payroll) -> tuple:
    p.refresh_from_db()
    return tuple(getattr(p, f) for f in FIGURES)


def _run_now(job, name):
    """payroll_month_workflow.run_in_background in tests: the job runs at once, inside the test's transaction."""
    job()


class WorkflowBase(TestCase):
    @classmethod
    def setUpTestData(cls):
        ps = PayrollSettings.get()
        ps.staff_pf_rules, ps.staff_esi_rules, ps.attendance_mode = [], [], "simple"
        ps.late_deduction_slabs = []
        ps.save()
        cls.ho = Branch.objects.create(name="WF Head Office", code="WFHO", is_head_office=True)
        cls.unit = Branch.objects.create(name="WF Unit One", code="WFU1")
        cls.dept = Department.objects.create(name="WF Accounts", branch=cls.ho)
        cls.admin = HRUser.objects.create(username="wf_admin", password_hash="x", is_super_admin=True)
        editor = Role.objects.create(name="WF Payroll editor", permissions={"payroll": "edit"})
        viewer = Role.objects.create(name="WF Payroll viewer", permissions={"payroll": "view"})
        cls.company_editor = HRUser.objects.create(username="wf_editor", password_hash="x", role=editor)
        cls.unit_editor = HRUser.objects.create(username="wf_unit", password_hash="x", role=editor, branch=cls.unit)
        cls.viewer = HRUser.objects.create(username="wf_viewer", password_hash="x", role=viewer)

    def setUp(self):
        self.addCleanup(_holiday_dates_for_month.cache_clear)
        patcher = mock.patch.object(wf, "run_in_background", side_effect=_run_now)
        patcher.start()
        self.addCleanup(patcher.stop)
        expo = mock.patch(EXPO)
        self.expo = expo.start()
        self.addCleanup(expo.stop)

    # ── data ──────────────────────────────────────────────────────────────
    def staff(self, code, salary="30000.00", branch=None, join=None, present=True, **kw):
        emp = Employee.objects.create(
            employee_code=code,
            first_name=code,
            last_name="Worker",
            employment_type="staff",
            status="active",
            salary_type="monthly",
            salary_amount=Decimal(salary),
            department=self.dept,
            branch=branch or self.ho,
            join_date=join,
            bank_account=f"ACC{code}",
            bank_ifsc="HDFC0000001",
            bank_name="HDFC",
            **kw,
        )
        if present:
            for d in DAYS:
                AttendanceDayRecord.objects.create(
                    employee=emp, date=d, status="present", shifts_earned=Decimal("1.00"), source="manual"
                )
        return emp

    def payroll(self, emp) -> Payroll:
        return Payroll.objects.get(employee=emp, month=MONTH, year=YEAR, week_number=None)

    # ── calls ─────────────────────────────────────────────────────────────
    def post(self, url, body=None, user=None):
        return self.client.post(
            url, data=json.dumps(body or {}), content_type="application/json", **_hdr(user or self.admin)
        )

    def get(self, url, user=None):
        return self.client.get(url, **_hdr(user or self.admin))

    def generate(self, user=None):
        return self.post("/api/payroll/generate", {"month": MONTH, "year": YEAR}, user)

    def hold(self, p, hold=True, user=None):
        return self.post(f"/api/payroll/{p.pk}/hold", {"hold": hold}, user)

    def finalize(self, user=None):
        return self.post("/api/payroll/month-finalize", {"month": MONTH, "year": YEAR}, user)

    def mark_paid(self, user=None):
        return self.post("/api/payroll/month-paid", {"month": MONTH, "year": YEAR}, user)

    def listed(self, user=None) -> set:
        r = self.get(f"/api/payroll?month={MONTH}&year={YEAR}", user)
        self.assertEqual(r.status_code, 200, r.content[:300])
        return {row["employeeCode"] for row in r.json()}

    def statement(self) -> dict:
        r = self.get(f"/api/payroll/salary-statement?month={MONTH}&year={YEAR}")
        self.assertEqual(r.status_code, 200, r.content[:300])
        return {row["values"]["code"]: row["values"] for g in r.json()["groups"] for row in g["rows"]}

    def report(self, section: str = "") -> dict:
        extra = f"&section={section}" if section else ""
        r = self.get(f"/api/reports/run/hr-salary-statement?period={YEAR}-{MONTH:02d}{extra}")
        self.assertEqual(r.status_code, 200, r.content[:300])
        body = r.json()
        return {"rows": {row["code"]: row for row in body["rows"] if not row.get("_kind")}, "notes": body["notes"]}

    def skipped(self, user=None) -> dict:
        r = self.get(f"/api/payroll/month-skipped?month={MONTH}&year={YEAR}", user)
        self.assertEqual(r.status_code, 200, r.content[:300])
        body = r.json()
        return {k: [row["employeeCode"] for row in body[k]] for k in ("onHold", "newJoiners", "paidSeparately")}

    def status(self, user=None) -> dict:
        r = self.get(f"/api/payroll/month-status?month={MONTH}&year={YEAR}", user)
        self.assertEqual(r.status_code, 200, r.content[:300])
        return r.json()


# ─────────────────────────────────────────────────────────────────────────────
#  Hold / Unhold
# ─────────────────────────────────────────────────────────────────────────────


class HoldTests(WorkflowBase):
    def setUp(self):
        super().setUp()
        self.asha, self.ravi = self.staff("WF_ASHA"), self.staff("WF_RAVI", "24000.00")
        self.assertEqual(self.generate().status_code, 201)
        self.p = self.payroll(self.asha)

    def test_hold_moves_the_salary_out_of_the_records_and_bank_file_but_keeps_it_on_the_statement(self):
        before = _figures(self.p)
        r = self.hold(self.p)
        self.assertEqual(r.status_code, 200, r.content)
        self.assertTrue(r.json()["onHold"])
        self.assertEqual(r.json()["holdChangedBy"], "HR")
        # the records, their totals and the bank file are built from /api/payroll: the held salary is not there
        self.assertEqual(self.listed(), {"WF_RAVI"})
        # the Salary Statement (screen and Report Center) still lists it, with HOLD in Remarks
        self.assertEqual(self.statement()["WF_ASHA"]["remarks"], "HOLD")
        self.assertEqual(self.statement()["WF_RAVI"]["remarks"], "")
        report = self.report()
        self.assertEqual(report["rows"]["WF_ASHA"]["remarks"], "HOLD")
        self.assertTrue(any("ON HOLD" in n for n in report["notes"]))
        # Skipped Employees lists it under On hold, with its figures
        self.assertEqual(self.skipped()["onHold"], ["WF_ASHA"])
        row = self.get(f"/api/payroll/month-skipped?month={MONTH}&year={YEAR}").json()["onHold"][0]
        self.assertEqual(row["finalSalary"], float(self.p.final_salary))
        self.assertEqual(row["bankAccount"], "ACCWF_ASHA")
        self.assertEqual(_figures(self.p), before)

    def test_unhold_puts_it_back(self):
        self.hold(self.p)
        r = self.hold(self.p, False)
        self.assertEqual(r.status_code, 200)
        self.assertFalse(r.json()["onHold"])
        self.assertEqual(self.listed(), {"WF_ASHA", "WF_RAVI"})
        self.assertEqual(self.skipped()["onHold"], [])
        self.assertEqual(self.statement()["WF_ASHA"]["remarks"], "")

    def test_a_hold_survives_generating_the_month_again_and_no_figure_changes(self):
        before = _figures(self.p)
        self.hold(self.p)
        self.assertEqual(self.generate().status_code, 201)
        self.p.refresh_from_db()
        self.assertTrue(self.p.on_hold)
        self.assertEqual(_figures(self.p), before)
        self.assertEqual(self.listed(), {"WF_RAVI"})

    def test_hold_needs_a_true_or_false(self):
        self.assertEqual(self.post(f"/api/payroll/{self.p.pk}/hold", {"hold": "yes"}).status_code, 400)

    def test_a_view_only_role_cannot_hold(self):
        self.assertEqual(self.hold(self.p, user=self.viewer).status_code, 403)
        self.p.refresh_from_db()
        self.assertFalse(self.p.on_hold)

    def test_a_unit_login_holds_only_its_own_unit(self):
        other = self.staff("WF_UNIT", branch=self.unit)
        self.generate()
        self.assertEqual(self.hold(self.p, user=self.unit_editor).status_code, 404)  # head office: not theirs
        self.assertEqual(self.hold(self.payroll(other), user=self.unit_editor).status_code, 200)

    def test_hold_and_unhold_are_in_the_activity_log(self):
        from .models import AuditLog

        self.hold(self.p)
        self.hold(self.p, False)
        texts = list(AuditLog.objects.filter(module="payroll").values_list("record_description", flat=True))
        self.assertTrue(any(t.startswith("Held the September 2026 salary of WF_ASHA") for t in texts), texts)
        self.assertTrue(any(t.startswith("Released the hold on") for t in texts), texts)


# ─────────────────────────────────────────────────────────────────────────────
#  New joiners
# ─────────────────────────────────────────────────────────────────────────────


class NewJoinerTests(WorkflowBase):
    def setUp(self):
        super().setUp()
        self.old = self.staff("WF_OLD", join="2025-04-01")
        self.new = self.staff("WF_NEW", join="2026-09-14")
        self.assertEqual(self.generate().status_code, 201)
        self.p = self.payroll(self.new)

    def test_a_join_date_in_the_month_parks_the_payroll_calculated_as_usual(self):
        self.assertTrue(self.p.new_joiner_parked)
        self.assertFalse(self.payroll(self.old).new_joiner_parked)
        # calculated exactly as the engine always did: the same as a straight engine run for the same employee
        figures = _figures(self.p)
        with mock.patch.object(wf, "park_if_new_joiner"):
            _generate_staff_payroll(self.new, MONTH, YEAR)
        self.assertEqual(_figures(self.p), figures)
        self.assertTrue(SalarySlip.objects.filter(employee=self.new, month=MONTH, year=YEAR).exists())

    def test_a_parked_new_joiner_is_in_no_list_but_skipped(self):
        self.assertEqual(self.listed(), {"WF_OLD"})
        self.assertNotIn("WF_NEW", self.statement())
        report = self.report()
        self.assertNotIn("WF_NEW", report["rows"])
        self.assertTrue(any("1 new joiner(s)" in n for n in report["notes"]), report["notes"])
        self.assertEqual(self.skipped()["newJoiners"], ["WF_NEW"])
        issues = self.get(f"/api/payroll/issues?month={MONTH}&year={YEAR}").json()["issues"]
        self.assertFalse(any(i.get("payrollId") == self.p.pk for i in issues))

    def test_add_to_payroll_brings_them_in_and_regeneration_keeps_them_in(self):
        r = self.post(f"/api/payroll/{self.p.pk}/add-to-payroll")
        self.assertEqual(r.status_code, 200, r.content)
        self.assertFalse(r.json()["newJoinerParked"])
        self.assertIsNotNone(r.json()["addedToPayrollAt"])
        self.assertEqual(self.listed(), {"WF_OLD", "WF_NEW"})
        self.assertIn("WF_NEW", self.statement())
        figures = _figures(self.p)
        self.assertEqual(self.generate().status_code, 201)
        self.p.refresh_from_db()
        self.assertFalse(self.p.new_joiner_parked)
        self.assertEqual(_figures(self.p), figures)
        self.assertEqual(self.skipped()["newJoiners"], [])

    def test_a_parked_new_joiner_cannot_be_held(self):
        self.assertEqual(self.hold(self.p).status_code, 400)

    def test_an_unreadable_join_date_is_not_new(self):
        self.assertFalse(wf.is_new_joiner(Employee(join_date="soon"), MONTH, YEAR))
        self.assertTrue(wf.is_new_joiner(Employee(join_date="14/09/2026"), MONTH, YEAR))
        self.assertFalse(wf.is_new_joiner(Employee(join_date="2026-08-31"), MONTH, YEAR))


# ─────────────────────────────────────────────────────────────────────────────
#  Payroll Done: who may press it, and the lock
# ─────────────────────────────────────────────────────────────────────────────


class FinalizeTests(WorkflowBase):
    def setUp(self):
        super().setUp()
        self.asha = self.staff("WF_ASHA")
        self.generate()

    def test_a_whole_company_login_with_edit_rights_finalizes(self):
        r = self.finalize(self.company_editor)
        self.assertEqual(r.status_code, 201, r.content)
        body = r.json()
        self.assertEqual((body["state"], body["locked"], body["finalizedBy"]), ("finalized", True, "HR"))
        close = PayrollMonthClose.objects.get(month=MONTH, year=YEAR)
        self.assertEqual(close.snapshot["inPayroll"], 1)
        self.assertIsNotNone(close.last_computed_at)

    def test_a_unit_login_and_a_view_only_role_cannot(self):
        self.assertEqual(self.finalize(self.unit_editor).status_code, 403)
        self.assertEqual(self.finalize(self.viewer).status_code, 403)
        self.assertFalse(PayrollMonthClose.objects.exists())
        unit = self.status(self.unit_editor)
        self.assertFalse(unit["can"]["finalize"])
        self.assertFalse(unit["wholeCompany"])
        self.assertTrue(self.status()["can"]["finalize"])
        self.assertFalse(self.status(self.viewer)["can"]["finalize"])

    def test_twice_or_with_no_payroll_is_refused(self):
        self.assertEqual(self.finalize().status_code, 201)
        self.assertEqual(self.finalize().status_code, 409)
        r = self.post("/api/payroll/month-finalize", {"month": 3, "year": 2026})
        self.assertEqual(r.status_code, 409)
        self.assertIn("generate it before", r.json()["error"])

    def test_not_while_a_payroll_run_is_writing(self):
        from . import payroll_progress

        self.assertTrue(payroll_progress.try_begin_run())
        try:
            self.assertEqual(self.finalize().status_code, 409)
        finally:
            payroll_progress.end_run()

    def test_it_is_in_the_activity_log(self):
        from .models import AuditLog

        self.finalize()
        self.assertTrue(
            AuditLog.objects.filter(
                record_description__startswith="Payroll Done: finalized and locked the September 2026"
            ).exists()
        )


class LockTests(WorkflowBase):
    def setUp(self):
        super().setUp()
        self.asha, self.held = self.staff("WF_ASHA"), self.staff("WF_HELD")
        self.new = self.staff("WF_NEW", join="2026-09-20")
        self.generate()
        self.p, self.h, self.n = self.payroll(self.asha), self.payroll(self.held), self.payroll(self.new)
        self.hold(self.h)
        self.figures = {p.pk: _figures(p) for p in (self.p, self.h, self.n)}
        self.assertEqual(self.finalize().status_code, 201)

    def tearDown(self):
        for p in (self.p, self.h, self.n):
            self.assertEqual(_figures(p), self.figures[p.pk], "a locked month's figures never change")

    def assertLocked(self, r):
        self.assertEqual(r.status_code, 409, r.content)
        self.assertIn("locked", r.json()["error"])

    def test_generating_the_month_again_is_refused(self):
        self.assertLocked(self.generate())

    def test_the_engine_itself_refuses_to_write_a_locked_month(self):
        with self.assertRaises(wf.MonthLocked):
            _generate_staff_payroll(self.asha, MONTH, YEAR)

    def test_bonus_deductions_and_mark_as_cleared_are_refused(self):
        for body in ({"bonus": 500}, {"deductions": 10}, {"status": "paid"}, {"notes": "x"}):
            r = self.client.patch(
                f"/api/payroll/{self.p.pk}", data=json.dumps(body), content_type="application/json", **_hdr(self.admin)
            )
            self.assertLocked(r)
        self.p.refresh_from_db()
        self.assertEqual(self.p.status, Payroll.STATUS_PENDING)

    def test_hold_unhold_and_add_to_payroll_are_refused(self):
        self.assertLocked(self.hold(self.p))
        self.assertLocked(self.hold(self.h, False))
        self.assertLocked(self.post(f"/api/payroll/{self.n.pk}/add-to-payroll"))
        self.h.refresh_from_db()
        self.n.refresh_from_db()
        self.assertTrue(self.h.on_hold)
        self.assertTrue(self.n.new_joiner_parked)

    def test_the_skip_check_still_answers_and_lists_who_has_no_payroll(self):
        late = self.staff("WF_LATE")  # joined the staff after the month was finalized: no payroll, never generated now
        r = self.get(f"/api/payroll/skip-check?month={MONTH}&year={YEAR}&fresh=1")
        self.assertEqual(r.status_code, 200)
        body = r.json()
        self.assertTrue(body["locked"])
        self.assertEqual([s["employeeCode"] for s in body["skipped"]], ["WF_LATE"])
        self.assertIn("finalized", body["skipped"][0]["reason"])
        self.assertFalse(Payroll.objects.filter(employee=late).exists())

    def test_another_month_and_production_payroll_are_not_locked(self):
        r = self.post("/api/payroll/generate", {"month": 8, "year": 2026})
        self.assertEqual(r.status_code, 201)
        prod = Employee.objects.create(
            employee_code="WF_PROD",
            first_name="P",
            last_name="W",
            employment_type="production",
            status="active",
            salary_per_shift=Decimal("500"),
        )
        row = Payroll.objects.create(
            employee=prod,
            salary_mode="shift",
            month=MONTH,
            year=YEAR,
            period_start=date(2026, 9, 1),
            period_end=date(2026, 9, 7),
            base_salary=0,
            gross_salary=Decimal("500"),
            final_salary=Decimal("500"),
        )
        r = self.client.patch(
            f"/api/payroll/{row.pk}",
            data=json.dumps({"status": "paid"}),
            content_type="application/json",
            **_hdr(self.admin),
        )
        self.assertEqual(r.status_code, 200)

    def test_the_month_status_says_locked_and_what_can_still_be_done(self):
        s = self.status()
        self.assertEqual(s["state"], "finalized")
        self.assertEqual(
            s["can"],
            {
                "finalize": False,
                "markPaid": True,
                "hold": False,
                "addToPayroll": False,
                "releaseAndPay": True,
                "markCleared": False,  # added 2026-11-11 (a finalized month refuses Mark as Cleared: 409)
            },
        )
        self.assertEqual(s["counts"]["onHold"], 1)
        self.assertEqual(s["counts"]["newJoiners"], 1)
        self.assertEqual(s["snapshot"]["inPayroll"], 1)
        # one employee's own rows (what the details page reads) still list the held payroll, with its flags
        own = self.get(f"/api/payroll?employeeId={self.held.pk}&month={MONTH}&year={YEAR}").json()
        self.assertEqual(len(own), 1)
        self.assertTrue(own[0]["onHold"])


# ─────────────────────────────────────────────────────────────────────────────
#  Mark as Paid, the push, and the employee side
# ─────────────────────────────────────────────────────────────────────────────


class MarkPaidTests(WorkflowBase):
    def setUp(self):
        super().setUp()
        self.asha, self.ravi = self.staff("WF_ASHA"), self.staff("WF_RAVI", "24000.00")
        self.held, self.new = self.staff("WF_HELD"), self.staff("WF_NEW", join="2026-09-10")
        self.gone = self.staff("WF_GONE")
        self.generate()
        self.hold(self.payroll(self.held))
        Employee.objects.filter(pk=self.gone.pk).update(status="inactive")
        # Cleared (HR's check) on Asha only
        self.client.patch(
            f"/api/payroll/{self.payroll(self.asha).pk}",
            data=json.dumps({"status": "paid"}),
            content_type="application/json",
            **_hdr(self.admin),
        )
        self.figures = {e.pk: _figures(self.payroll(e)) for e in (self.asha, self.ravi, self.held, self.new)}

    def test_only_after_payroll_done(self):
        r = self.mark_paid()
        self.assertEqual(r.status_code, 409)
        self.assertIn("Payroll Done first", r.json()["error"])

    def test_every_employee_in_the_main_payroll_is_paid_and_notified_once(self):
        self.finalize()
        r = self.mark_paid()
        self.assertEqual(r.status_code, 200, r.content)
        body = r.json()
        self.assertEqual((body["state"], body["employeesPaid"], body["daysToPay"]), ("paid", 2, 0))
        paid = {p.employee.employee_code: p.payment_status for p in Payroll.objects.select_related("employee")}
        self.assertEqual(paid["WF_ASHA"], "paid")
        self.assertEqual(paid["WF_RAVI"], "paid")  # not Cleared, still paid: paying does not need Cleared
        self.assertEqual(paid["WF_HELD"], "not_paid")
        self.assertEqual(paid["WF_NEW"], "not_paid")
        self.assertEqual(paid["WF_GONE"], "not_paid")
        notes = Notification.objects.filter(source=wf.SALARY_PAID_SOURCE)
        self.assertEqual(sorted(n.employee.employee_code for n in notes), ["WF_ASHA", "WF_RAVI"])
        n = notes.first()
        self.assertEqual((n.title, n.message), ("Salary Paid", "Your salary for September 2026 has been paid."))
        self.assertNotIn("₹", n.message)
        self.assertNotRegex(n.message, r"\d{3,},|\d{4,}\.")  # no amount
        # a retry never notifies twice
        self.assertEqual(wf.notify_salary_paid([self.payroll(self.asha).pk, self.payroll(self.ravi).pk]), 0)
        self.assertEqual(Notification.objects.filter(employee=self.asha, source=wf.SALARY_PAID_SOURCE).count(), 1)
        self.assertEqual(self.mark_paid().status_code, 409)
        for e in (self.asha, self.ravi, self.held, self.new):
            self.assertEqual(_figures(self.payroll(e)), self.figures[e.pk])

    def test_the_push_goes_to_the_phone_without_the_amount(self):
        PushToken.objects.create(employee=self.asha, token="ExponentPushToken[wf]")
        self.expo.return_value.ok = True
        self.expo.return_value.json.return_value = {"data": [{"status": "ok", "id": "t1"}]}
        self.finalize()
        self.mark_paid()
        sent = [c.kwargs["json"] for c in self.expo.call_args_list]
        self.assertEqual(len(sent), 1)
        self.assertEqual(sent[0][0]["title"], "Salary Paid")
        self.assertEqual(sent[0][0]["body"], "Your salary for September 2026 has been paid.")

    def test_the_salary_paid_push_can_be_switched_off_on_mobile_messages(self):
        from . import mobile_messages

        self.assertIn(wf.SALARY_PAID_SOURCE, mobile_messages.valid_keys())

    def test_a_unit_login_cannot_mark_paid_and_sees_the_status(self):
        self.finalize()
        self.assertEqual(self.mark_paid(self.unit_editor).status_code, 403)
        self.assertEqual(self.mark_paid(self.viewer).status_code, 403)
        unit = self.status(self.unit_editor)
        self.assertEqual(unit["state"], "finalized")
        self.assertFalse(unit["can"]["markPaid"])

    def test_the_timeline_and_days_to_pay(self):
        self.finalize()
        close = PayrollMonthClose.objects.get()
        close.finalized_at = timezone.now() - timedelta(days=3, hours=2)
        close.save()
        self.mark_paid()
        s = self.status()
        self.assertEqual(s["daysToPay"], 3)
        self.assertIsNotNone(s["paidAt"])
        self.assertIsNotNone(s["firstGeneratedAt"])
        self.assertEqual(s["paidBy"], "HR")

    def test_mark_as_paid_is_in_the_activity_log(self):
        from .models import AuditLog

        self.finalize()
        self.mark_paid()
        self.assertTrue(
            AuditLog.objects.filter(
                record_description__startswith="Marked the September 2026 staff payroll as Paid: 2"
            ).exists()
        )


class EmployeeSideTests(WorkflowBase):
    def setUp(self):
        super().setUp()
        self.asha = self.staff("WF_ASHA")
        self.generate()
        self.p = self.payroll(self.asha)

    def insights_payroll(self):
        r = self.client.get(f"/api/my/salary-insights?year={YEAR}", **_emp_hdr(self.asha))
        self.assertEqual(r.status_code, 200, r.content[:300])
        period = next(p for p in r.json()["periods"] if p["payroll"])
        return period["payroll"]

    def records_status(self):
        r = self.client.get("/api/salary-records", **_emp_hdr(self.asha))
        return r.json()[0]["status"]

    def dashboard_status(self):
        r = self.client.get("/api/dashboard/employee-summary", **_emp_hdr(self.asha))
        return r.json()["recentSalaries"][0]["status"]

    def test_cleared_alone_is_not_paid_and_paid_shows_after_mark_as_paid(self):
        self.client.patch(
            f"/api/payroll/{self.p.pk}",
            data=json.dumps({"status": "paid"}),
            content_type="application/json",
            **_hdr(self.admin),
        )
        block = self.insights_payroll()
        self.assertEqual((block["status"], block["statusLabel"]), ("pending", "Not paid yet"))
        self.assertEqual(self.records_status(), "pending")
        self.assertEqual(self.dashboard_status(), "pending")
        # HR still sees Cleared
        r = self.get(f"/api/salary-records?employeeId={self.asha.pk}")
        self.assertEqual(r.json()[0]["status"], "paid")

        self.finalize()
        self.mark_paid()
        block = self.insights_payroll()
        self.assertEqual((block["status"], block["statusLabel"]), ("paid", "Paid"))
        self.assertEqual(self.records_status(), "paid")
        self.assertEqual(self.dashboard_status(), "paid")

    def test_the_notification_opens_the_month_slip(self):
        self.finalize()
        self.mark_paid()
        r = self.client.get("/api/notifications", **_emp_hdr(self.asha))
        rows = r.json() if isinstance(r.json(), list) else r.json().get("results", [])
        paid = next(n for n in rows if n.get("title") == "Salary Paid")
        slip = SalarySlip.objects.get(employee=self.asha, month=MONTH, year=YEAR)
        self.assertEqual(paid["target"]["kind"], "salary_slip")
        self.assertEqual(paid["target"]["id"], slip.pk)


# ─────────────────────────────────────────────────────────────────────────────
#  After the lock: release and pay one held / new employee
# ─────────────────────────────────────────────────────────────────────────────


class ReleaseAndPayTests(WorkflowBase):
    def setUp(self):
        super().setUp()
        self.asha, self.held = self.staff("WF_ASHA"), self.staff("WF_HELD")
        self.new = self.staff("WF_NEW", join="2026-09-21")
        self.generate()
        self.h, self.n = self.payroll(self.held), self.payroll(self.new)
        self.hold(self.h)
        self.figures = {p.pk: _figures(p) for p in (self.h, self.n)}

    def release(self, p, user=None):
        return self.post(f"/api/payroll/{p.pk}/release-and-pay", user=user)

    def test_not_before_payroll_done(self):
        r = self.release(self.h)
        self.assertEqual(r.status_code, 409)
        self.assertIn("Unhold", r.json()["error"])

    def test_a_held_employee_is_released_paid_and_notified_on_their_own(self):
        self.finalize()
        self.mark_paid()
        r = self.release(self.h)
        self.assertEqual(r.status_code, 200, r.content)
        row = r.json()
        self.assertEqual((row["onHold"], row["releasedFrom"], row["paymentStatus"]), (False, "hold", "paid"))
        self.assertEqual(row["bankAccount"], "ACCWF_HELD")  # the one-person bank file is built from this row
        self.assertIsNotNone(row["paymentPaidAt"])
        self.assertEqual(Notification.objects.filter(employee=self.held, source=wf.SALARY_PAID_SOURCE).count(), 1)
        # not back in the month's records / bank file: paid with a file of its own, listed under Paid separately
        self.assertEqual(self.listed(), {"WF_ASHA"})
        self.assertEqual(self.skipped(), {"onHold": [], "newJoiners": ["WF_NEW"], "paidSeparately": ["WF_HELD"]})
        self.assertTrue(self.statement()["WF_HELD"]["remarks"].startswith("PAID SEPARATELY "))
        self.assertEqual(self.release(self.h).status_code, 409)  # only once
        self.assertEqual(_figures(self.h), self.figures[self.h.pk])

    def test_a_parked_new_joiner_can_be_released_before_the_month_is_paid_too(self):
        self.finalize()
        r = self.release(self.n)
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(r.json()["releasedFrom"], "new_joiner")
        # a new joiner was never in the month's payroll: paid on their own, they stay off its statement and are on the
        # Skipped Employees statement as PAID SEPARATELY
        self.assertNotIn("WF_NEW", self.statement())
        self.assertNotIn("WF_NEW", self.report()["rows"])
        self.assertTrue(self.report("skipped")["rows"]["WF_NEW"]["remarks"].startswith("PAID SEPARATELY "))
        self.assertEqual(self.status()["counts"]["paidSeparately"], 1)
        # Mark as Paid later does not pay or notify them again
        self.mark_paid()
        self.assertEqual(Notification.objects.filter(employee=self.new, source=wf.SALARY_PAID_SOURCE).count(), 1)
        self.assertEqual(_figures(self.n), self.figures[self.n.pk])

    def test_someone_neither_held_nor_parked_cannot_be_released(self):
        self.finalize()
        self.assertEqual(self.release(self.payroll(self.asha)).status_code, 409)

    def test_only_a_whole_company_login(self):
        self.finalize()
        self.assertEqual(self.release(self.h, self.unit_editor).status_code, 403)
        self.assertEqual(self.release(self.h, self.viewer).status_code, 403)
        self.h.refresh_from_db()
        self.assertTrue(self.h.on_hold)

    def test_it_is_in_the_activity_log(self):
        from .models import AuditLog

        self.finalize()
        self.release(self.h)
        self.assertTrue(
            AuditLog.objects.filter(record_description__startswith="Released and paid the September 2026").exists()
        )


class SkippedStatementTests(WorkflowBase):
    """Payroll > Skipped Employees > Export: the Report Center's own Salary Statement (same columns, files and rounding)
    with ONLY the skipped employees that have a payroll; the month's statement is the main payroll + the held salaries."""

    def setUp(self):
        super().setUp()
        self.asha, self.ravi = self.staff("WF_ASHA"), self.staff("WF_RAVI", "24000.00")
        self.held, self.held2 = self.staff("WF_HELD"), self.staff("WF_HELD2")
        self.new, self.new2 = self.staff("WF_NEW", join="2026-09-10"), self.staff("WF_NEW2", join="2026-09-25")
        self.generate()
        self.hold(self.payroll(self.held))
        self.hold(self.payroll(self.held2))

    def test_the_skipped_statement_lists_exactly_the_held_and_the_new_joiners(self):
        rows = self.report("skipped")["rows"]
        self.assertEqual(sorted(rows), ["WF_HELD", "WF_HELD2", "WF_NEW", "WF_NEW2"])
        self.assertEqual(rows["WF_HELD"]["remarks"], "HOLD")
        self.assertEqual(rows["WF_NEW"]["remarks"], "NEW JOINER, JOINED 10-09")
        # the figures are the payroll's own, as on the month's statement
        main = self.report()["rows"]
        self.assertEqual(rows["WF_HELD"]["net"], main["WF_HELD"]["net"])
        self.assertEqual(rows["WF_HELD"]["net"], float(self.payroll(self.held).final_salary))

    def test_the_months_statement_is_unchanged_main_payroll_and_held_never_a_new_joiner(self):
        body = self.report()
        self.assertEqual(sorted(body["rows"]), ["WF_ASHA", "WF_HELD", "WF_HELD2", "WF_RAVI"])
        self.assertTrue(any("2 new joiner(s)" in n for n in body["notes"]), body["notes"])
        # the two never share a row except a held salary (owner: held people are on the month's statement with HOLD)
        skipped = set(self.report("skipped")["rows"])
        self.assertEqual(skipped & set(body["rows"]), {"WF_HELD", "WF_HELD2"})

    def test_after_the_lock_the_released_are_paid_separately_on_the_skipped_statement(self):
        self.finalize()
        self.post(f"/api/payroll/{self.payroll(self.held).pk}/release-and-pay")
        self.post(f"/api/payroll/{self.payroll(self.new).pk}/release-and-pay")
        rows = self.report("skipped")["rows"]
        self.assertEqual(sorted(rows), ["WF_HELD", "WF_HELD2", "WF_NEW", "WF_NEW2"])
        paid = self.payroll(self.held).payment_paid_at.astimezone(FACTORY_TZ)
        self.assertEqual(rows["WF_HELD"]["remarks"], f"PAID SEPARATELY {paid:%d-%m-%Y}")
        self.assertTrue(rows["WF_NEW"]["remarks"].startswith("PAID SEPARATELY "))
        self.assertEqual(rows["WF_HELD2"]["remarks"], "HOLD")
        self.assertEqual(rows["WF_NEW2"]["remarks"], "NEW JOINER, JOINED 25-09")
        main = self.report()["rows"]
        self.assertEqual(sorted(main), ["WF_ASHA", "WF_HELD", "WF_HELD2", "WF_RAVI"])

    def test_the_skipped_statement_files_download_and_say_which_list_they_are(self):
        for fmt in ("xlsx", "pdf"):
            r = self.get(f"/api/reports/export/hr-salary-statement?fmt={fmt}&period={YEAR}-{MONTH:02d}&section=skipped")
            self.assertEqual(r.status_code, 200, r.content[:300])
        body = self.get(f"/api/reports/run/hr-salary-statement?period={YEAR}-{MONTH:02d}&section=skipped").json()
        self.assertIn(("Employees", "Skipped Employees only"), [tuple(f.values()) for f in body["filters"]])
        self.assertEqual(
            self.get("/api/reports/run/hr-salary-statement?period=2026-09&section=nonsense").status_code, 400
        )

    def test_nobody_skipped_says_so(self):
        for emp in (self.held, self.held2):
            self.hold(self.payroll(emp), False)
        for emp in (self.new, self.new2):
            self.post(f"/api/payroll/{self.payroll(emp).pk}/add-to-payroll")
        body = self.get(f"/api/reports/run/hr-salary-statement?period={YEAR}-{MONTH:02d}&section=skipped").json()
        self.assertEqual([r for r in body["rows"] if not r.get("_kind")], [])
        self.assertIn(
            "No employee of this month and selection is on hold, a new joiner or paid separately.", body["notes"]
        )


class FlagsInTheRowTests(WorkflowBase):
    def test_every_row_says_where_it_stands(self):
        self.staff("WF_ASHA")
        self.generate()
        row = self.get(f"/api/payroll?month={MONTH}&year={YEAR}").json()[0]
        for key in (
            "onHold",
            "holdChangedAt",
            "holdChangedBy",
            "newJoinerParked",
            "addedToPayrollAt",
            "addedToPayrollBy",
            "paymentStatus",
            "paymentPaidAt",
            "paymentPaidBy",
            "releasedFrom",
        ):
            self.assertIn(key, row)
        self.assertEqual(row["paymentStatus"], "not_paid")

    def test_bad_month_is_a_400(self):
        self.assertEqual(self.get("/api/payroll/month-status?month=13&year=2026").status_code, 400)
        self.assertEqual(self.post("/api/payroll/month-paid", {"month": "x"}).status_code, 400)

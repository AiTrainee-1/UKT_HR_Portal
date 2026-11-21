"""Staff Payroll page, owner brief 2026-11-20: the Excess tab (Excess = added to the earned salary, Detection = taken off
it, mandatory remarks, history), the fix of amounts disappearing on Generate again, the Payroll tab's Not included view
and the Payslip tab's list / PDF.

Run via: python manage.py test api.tests_payroll_excess
"""

import importlib
from datetime import date
from decimal import Decimal

from django.apps import apps as django_apps
from django.test import TestCase
from django.utils import timezone

from . import payroll_month_workflow as month_workflow
from .attendance_final import _holiday_dates_for_month
from .jwt_utils import sign_token
from .models import (
    Employee,
    HRUser,
    Payroll,
    PayrollExcessEntry,
    PayrollExcessHistory,
    ProductionPeriodClose,
    Role,
    SalarySlip,
)
from .payroll_views import _generate_production_payroll, _generate_staff_payroll
from .permission_registry import resolve_module
from .salary_slip_figures import figures
from .tests_payroll_engine import MONTH, WORKING_DAYS, YEAR, _configure, _day, _present_all, _production, _staff

EXCESS = "/api/payroll-excess/"


def _token(user) -> dict:
    return {"HTTP_AUTHORIZATION": f"Bearer {sign_token({'role': 'hr', 'hrUserId': user.id, 'name': user.username})}"}


class _Base(TestCase):
    def setUp(self):
        _configure(staff_pf_rules=[], staff_esi_rules=[], late_free_allowance=3, attendance_mode="simple")
        self.addCleanup(_holiday_dates_for_month.cache_clear)
        _holiday_dates_for_month.cache_clear()
        self.admin = HRUser.objects.create(username="excess_admin", password_hash="x", is_super_admin=True)
        self.auth = _token(self.admin)

    def post(self, path, body, auth=None):
        return self.client.post(EXCESS + path, body, content_type="application/json", **(auth or self.auth))

    def add(self, emps, kind="excess", amount="2000", remark="Festival incentive", auth=None, month=MONTH, year=YEAR):
        body = {"month": month, "year": year, "kind": kind, "amount": amount, "remark": remark,
                "employeeIds": [e.id for e in emps]}  # fmt: skip
        return self.post("entries", body, auth)

    def payroll(self, emp) -> Payroll:
        return Payroll.objects.get(employee=emp, month=MONTH, year=YEAR, week_number=None)


class ExcessReachesThePayrollTests(_Base):
    def test_excess_added_before_generation_is_in_the_earned_salary(self):
        emp = _staff(code="EX_A", salary="15000.00")
        _present_all(emp)
        self.assertEqual(self.add([emp]).status_code, 200)
        _generate_staff_payroll(emp, MONTH, YEAR)
        p = self.payroll(emp)
        # earned 15,000 + excess 2,000 = 17,000; the engine's own figures are untouched
        self.assertEqual(
            (p.gross_salary, p.bonus, p.final_salary), (Decimal("15000.00"), Decimal("2000.00"), Decimal("17000.00"))
        )
        slip = SalarySlip.objects.get(employee=emp, month=MONTH, year=YEAR)
        self.assertEqual((slip.bonuses, slip.net_salary), (Decimal("2000.00"), Decimal("17000.00")))
        self.assertEqual(slip.breakdown_details["excess"], {"excess": 2000.0, "detection": 0.0, "net": 2000.0})

    def test_added_after_generation_shows_at_once_and_survives_generate_again(self):
        emp = _staff(code="EX_B", salary="15000.00")
        _present_all(emp)
        _generate_staff_payroll(emp, MONTH, YEAR)
        body = self.add([emp]).json()
        self.assertEqual(body["payrollUpdated"], 1)
        self.assertEqual(self.payroll(emp).final_salary, Decimal("17000.00"))
        # the reported bug: Generate again used to reset the bonus to 0
        _generate_staff_payroll(emp, MONTH, YEAR)
        _generate_staff_payroll(emp, MONTH, YEAR)
        p = self.payroll(emp)
        self.assertEqual((p.bonus, p.final_salary), (Decimal("2000.00"), Decimal("17000.00")))

    def test_detection_takes_off_and_both_add_up(self):
        emp = _staff(code="EX_C", salary="15000.00")
        _present_all(emp)
        _generate_staff_payroll(emp, MONTH, YEAR)
        self.add([emp], amount="2000")
        self.add([emp], kind="detection", amount="500", remark="Uniform not returned")
        p = self.payroll(emp)
        self.assertEqual((p.bonus, p.final_salary), (Decimal("1500.00"), Decimal("16500.00")))
        fig = figures(SalarySlip.objects.get(employee=emp, month=MONTH, year=YEAR))
        lines = dict(fig.earnings)
        self.assertEqual(lines["Excess (added by HR)"], Decimal("2000.00"))
        self.assertEqual(lines["Detection (taken off by HR)"], Decimal("-500.00"))
        self.assertEqual(fig.net, Decimal("16500.00"))

    def test_change_and_remove_write_history_and_move_the_net(self):
        emp = _staff(code="EX_D", salary="15000.00")
        _present_all(emp)
        _generate_staff_payroll(emp, MONTH, YEAR)
        entry_id = self.add([emp]).json()["created"][0]["id"]
        res = self.client.patch(f"{EXCESS}entries/{entry_id}", {"amount": 2500, "remark": "Corrected by MD"},
                                content_type="application/json", **self.auth)  # fmt: skip
        self.assertEqual(res.status_code, 200, res.content)
        self.assertEqual(self.payroll(emp).final_salary, Decimal("17500.00"))
        self.assertEqual(self.post("remove", {"entryIds": [entry_id], "remark": "Added by mistake"}).status_code, 200)
        self.assertEqual((self.payroll(emp).bonus, self.payroll(emp).final_salary), (0, Decimal("15000.00")))
        self.assertEqual(PayrollExcessEntry.objects.get(pk=entry_id).status, "removed")
        history = self.client.get(EXCESS + "history", {"month": MONTH, "year": YEAR}, **self.auth).json()["items"]
        self.assertEqual([h["action"] for h in history], ["removed", "changed", "added"])
        changed = history[1]
        self.assertEqual((changed["previousAmount"], changed["newAmount"]), (2000.0, 2500.0))
        self.assertEqual((changed["payrollNetBefore"], changed["payrollNetAfter"]), (17000.0, 17500.0))
        self.assertEqual(changed["remark"], "Corrected by MD")
        self.assertEqual(changed["by"], "excess_admin")
        # nothing is counted twice: the bonus is set from the entries, never added to
        _generate_staff_payroll(emp, MONTH, YEAR)
        self.assertEqual(self.payroll(emp).final_salary, Decimal("15000.00"))

    def test_remarks_amounts_and_kinds_are_checked(self):
        emp = _staff(code="EX_E")
        self.assertIn("remark", self.add([emp], remark=" ").json()["error"])
        self.assertIn("more than zero", self.add([emp], amount="0").json()["error"])
        self.assertIn("Excess or Detection", self.add([emp], kind="bonus").json()["error"])
        entry_id = self.add([emp]).json()["created"][0]["id"]
        res = self.client.patch(f"{EXCESS}entries/{entry_id}", {"amount": 3000}, content_type="application/json",
                                **self.auth)  # fmt: skip
        self.assertEqual(res.status_code, 400)
        self.assertEqual(self.post("remove", {"entryIds": [entry_id], "remark": ""}).status_code, 400)
        self.assertEqual(PayrollExcessHistory.objects.count(), 1)

    def test_only_payable_staff_can_get_one(self):
        ok = _staff(code="EX_OK")
        prod = _production(code="EX_PROD")
        gone = _staff(code="EX_GONE")
        Employee.objects.filter(pk=gone.pk).update(status="inactive")
        nosal = _staff(code="EX_NOSAL")
        Employee.objects.filter(pk=nosal.pk).update(salary_amount=None)
        later = _staff(code="EX_LATER", join_date=f"{YEAR}-{MONTH + 1:02d}-03")
        body = self.add([ok, prod, gone, nosal, later]).json()
        self.assertEqual([e["employeeId"] for e in body["created"]], [ok.id])
        reasons = {r["employeeId"]: r["reason"] for r in body["refused"]}
        self.assertEqual(reasons[prod.id], "Production employee: not on the Staff Payroll")
        self.assertEqual(reasons[gone.id], "Inactive employee")
        self.assertEqual(reasons[nosal.id], "No monthly salary on the profile")
        self.assertTrue(reasons[later.id].startswith("Joined after"))
        self.assertEqual(body["created"][0]["source"], "bulk")

    def test_future_and_locked_months_are_refused(self):
        emp = _staff(code="EX_F")
        _present_all(emp)
        self.assertEqual(self.add([emp], month=12, year=2099).status_code, 400)
        _generate_staff_payroll(emp, MONTH, YEAR)
        month_workflow.finalize(MONTH, YEAR, "tester")
        res = self.add([emp])
        self.assertEqual(res.status_code, 409)
        self.assertFalse(PayrollExcessEntry.objects.exists())

    def test_the_payroll_patch_no_longer_sets_a_staff_bonus(self):
        emp = _staff(code="EX_PATCH")
        _present_all(emp)
        p = _generate_staff_payroll(emp, MONTH, YEAR)["payroll"]
        res = self.client.patch(f"/api/payroll/{p.id}", {"bonus": 999}, content_type="application/json", **self.auth)
        self.assertEqual(res.status_code, 400)
        self.assertIn("Excess tab", res.json()["error"])
        # an old client re-sending the same bonus with a deduction change still works
        res = self.client.patch(f"/api/payroll/{p.id}", {"bonus": 0, "notes": "checked"}, content_type="application/json",
                                **self.auth)  # fmt: skip
        self.assertEqual(res.status_code, 200)

    def test_month_view_groups_by_department_with_payroll_figures(self):
        a = _staff(code="EX_M1", salary="15000.00")
        b = _staff(code="EX_M2", salary="20000.00")
        _present_all(a)
        _generate_staff_payroll(a, MONTH, YEAR)
        self.add([a, b], amount="1000")
        self.add([a], kind="detection", amount="200", remark="Canteen dues")
        body = self.client.get(EXCESS + "month", {"month": MONTH, "year": YEAR}, **self.auth).json()
        self.assertEqual(body["summary"], {"employees": 2, "entries": 3, "excessTotal": 2000.0, "detectionTotal": 200.0,
                                           "net": 1800.0})  # fmt: skip
        rows = {r["code"]: r for d in body["departments"] for r in d["rows"]}
        self.assertEqual((rows["EX_M1"]["earnedSalary"], rows["EX_M1"]["earnedWithExcess"]), (15000.0, 15800.0))
        self.assertTrue(rows["EX_M1"]["inPayroll"])
        self.assertIsNone(rows["EX_M2"]["payrollId"])
        self.assertTrue(body["canEdit"])
        options = {o["code"]: o for o in body["employeeOptions"]}
        self.assertTrue(options["EX_M1"]["eligible"])

    def test_view_only_reads_but_cannot_change(self):
        role = Role.objects.create(name="Excess viewer", permissions={"payroll": "view", "salary": "view"})
        viewer = HRUser.objects.create(username="excess_viewer", password_hash="x", role=role)
        auth = _token(viewer)
        self.assertEqual(self.client.get(EXCESS + "month", {"month": MONTH, "year": YEAR}, **auth).status_code, 200)
        self.assertEqual(self.add([_staff(code="EX_V")], auth=auth).status_code, 403)
        self.assertEqual(resolve_module("payroll-excess/month"), "salary")
        self.assertEqual(resolve_module("payroll/not-included"), "payroll.not_included")
        self.assertEqual(resolve_module("payslips/staff/pdf"), "salary_slip")

    def test_existing_bonuses_are_carried_over_by_the_migration(self):
        emp = _staff(code="EX_MIG")
        _present_all(emp)
        p = _generate_staff_payroll(emp, MONTH, YEAR)["payroll"]
        Payroll.objects.filter(pk=p.pk).update(bonus=Decimal("750.00"))
        migration = importlib.import_module("api.migrations.0171_payroll_excess_entries")
        migration.carry_existing_bonuses(django_apps, None)
        entry = PayrollExcessEntry.objects.get(employee=emp)
        self.assertEqual((entry.kind, entry.amount, entry.source), ("excess", Decimal("750.00"), "migrated"))
        _generate_staff_payroll(emp, MONTH, YEAR)
        self.assertEqual(self.payroll(emp).bonus, Decimal("750.00"))


class NotIncludedAndPayslipsTests(_Base):
    def setUp(self):
        super().setUp()
        self.paid = _staff(code="NI_PAID", salary="15000.00")
        self.held = _staff(code="NI_HELD", salary="15000.00")
        self.new = _staff(code="NI_NEW", salary="15000.00", join_date=WORKING_DAYS[3].isoformat())
        self.gone = _staff(code="NI_GONE")
        Employee.objects.filter(pk=self.gone.pk).update(status="inactive")
        self.nosal = _staff(code="NI_NOSAL")
        Employee.objects.filter(pk=self.nosal.pk).update(salary_amount=None)
        self.missing = _staff(code="NI_MISSING", salary="12000.00")
        self.prod = _production(code="NI_PROD")
        for emp in (self.paid, self.held, self.new):
            _present_all(emp)
            _generate_staff_payroll(emp, MONTH, YEAR)
        month_workflow.set_hold(self.payroll(self.held), True, "tester")

    def test_every_excluded_employee_has_a_reason(self):
        res = self.client.get("/api/payroll/not-included", {"month": MONTH, "year": YEAR}, **self.auth)
        self.assertEqual(res.status_code, 200, res.content)
        body = res.json()
        self.assertTrue(body["generated"])
        rows = {r["code"]: r for r in body["employees"]}
        self.assertNotIn("NI_PAID", rows)
        self.assertEqual(rows["NI_HELD"]["reasonCode"], "on_hold")
        self.assertEqual(rows["NI_NEW"]["reasonCode"], "new_joiner")
        self.assertEqual(rows["NI_GONE"]["reasonCode"], "inactive")
        self.assertEqual(rows["NI_NOSAL"]["reasonCode"], "no_salary")
        self.assertEqual(rows["NI_MISSING"]["reasonCode"], "not_generated")
        self.assertEqual(rows["NI_PROD"]["reasonCode"], "production")
        self.assertEqual(rows["NI_HELD"]["payrollId"], self.payroll(self.held).id)
        self.assertEqual(body["summary"]["byReason"]["on_hold"], 1)

    def test_payslips_list_only_the_month_payroll(self):
        self.add([self.paid], amount="1000")
        res = self.client.get("/api/payslips/staff", {"month": MONTH, "year": YEAR}, **self.auth)
        self.assertEqual(res.status_code, 200, res.content)
        body = res.json()
        self.assertEqual([r["code"] for r in body["rows"]], ["NI_PAID"])
        row = body["rows"][0]
        self.assertEqual((row["excess"], row["detection"], row["eSalary"], row["net"]), (1000.0, 0.0, 16000.0, 16000.0))
        self.assertIn({"label": "Excess (added by HR)", "amount": 1000.0}, row["earnings"])
        self.assertEqual(body["summary"]["employees"], 1)
        pid = row["payrollId"]
        for layout in ("single", "double"):
            pdf = self.client.get("/api/payslips/staff/pdf", {"month": MONTH, "year": YEAR, "ids": str(pid),
                                                              "layout": layout}, **self.auth)  # fmt: skip
            self.assertEqual(pdf.status_code, 200, pdf.content[:200])
            self.assertTrue(pdf.content.startswith(b"%PDF"))
        held_id = self.payroll(self.held).id
        refused = self.client.get("/api/payslips/staff/pdf", {"month": MONTH, "year": YEAR, "ids": str(held_id)},
                                  **self.auth)  # fmt: skip
        self.assertEqual(refused.status_code, 404)


# ─────────────────────────────────────────────────────────────────────────────
#  Production Payroll: the same, per pay period of a cycle
# ─────────────────────────────────────────────────────────────────────────────

PROD = "/api/production-payroll-excess/"
START, END = date(2026, 2, 2), date(2026, 2, 8)  # one Monday-Sunday week of February 2026
PERIOD = {"cycle": "weekly", "periodStart": START.isoformat(), "periodEnd": END.isoformat()}


def _worker(code, per_shift="500.00", cycle="weekly", days=5):
    emp = _production(code=code, per_shift=per_shift)
    Employee.objects.filter(pk=emp.pk).update(production_pay_cycle=cycle)
    emp.refresh_from_db()
    for d in WORKING_DAYS[:days]:
        if START <= d <= END:
            _day(emp, d)
    return emp


class ProductionExcessTests(_Base):
    def setUp(self):
        super().setUp()
        _configure(prod_pf_rules=[], prod_esi_rules=[], prod_late_detection_enabled=False)

    def padd(self, emps, kind="excess", amount="300", remark="Target bonus", auth=None):
        body = {**PERIOD, "kind": kind, "amount": amount, "remark": remark, "employeeIds": [e.id for e in emps]}
        return self.client.post(PROD + "entries", body, content_type="application/json", **(auth or self.auth))

    def generate(self, emp):
        return _generate_production_payroll(emp, START, END, pay_cycle="weekly")["payroll"]

    def test_excess_reaches_the_period_payroll_and_survives_generate_again(self):
        emp = _worker("PX_A")
        self.assertEqual(self.padd([emp]).status_code, 200)
        p = self.generate(emp)
        self.assertEqual(
            (p.gross_salary, p.bonus, p.final_salary), (Decimal("2500.00"), Decimal("300.00"), Decimal("2800.00"))
        )
        self.padd([emp], kind="detection", amount="100", remark="Damaged material")
        p.refresh_from_db()
        self.assertEqual((p.bonus, p.final_salary), (Decimal("200.00"), Decimal("2700.00")))
        p = self.generate(emp)
        self.assertEqual((p.bonus, p.final_salary), (Decimal("200.00"), Decimal("2700.00")))
        slip = SalarySlip.objects.get(employee=emp, period_start=START, period_end=END)
        self.assertEqual(slip.breakdown_details["excess"], {"excess": 300.0, "detection": 100.0, "net": 200.0})
        # a staff month of the same calendar month knows nothing of it
        self.assertEqual(PayrollExcessEntry.objects.filter(period_start__isnull=True).count(), 0)

    def test_only_this_cycles_workers_and_never_staff(self):
        ok = _worker("PX_OK")
        other = _worker("PX_OTHER", cycle="monthly")
        staff = _staff(code="PX_STAFF")
        noshift = _worker("PX_NOSHIFT")
        Employee.objects.filter(pk=noshift.pk).update(salary_per_shift=None)
        body = self.padd([ok, other, staff, noshift]).json()
        self.assertEqual([e["employeeId"] for e in body["created"]], [ok.id])
        reasons = {r["employeeId"]: r["reason"] for r in body["refused"]}
        self.assertEqual(reasons[other.id], "On the Monthly cycle")
        self.assertEqual(reasons[staff.id], "Staff employee: not on the Production Payroll")
        self.assertEqual(reasons[noshift.id], "No salary per shift on the profile")
        self.assertEqual(body["created"][0]["periodStart"], START.isoformat())

    def test_period_overview_history_and_locked_period(self):
        emp = _worker("PX_V")
        self.generate(emp)
        entry_id = self.padd([emp]).json()["created"][0]["id"]
        body = self.client.get(PROD + "period", PERIOD, **self.auth).json()
        self.assertEqual((body["cycle"], body["summary"]["excessTotal"]), ("weekly", 300.0))
        row = body["departments"][0]["rows"][0]
        self.assertEqual((row["earnedSalary"], row["earnedWithExcess"], row["inPayroll"]), (2500.0, 2800.0, True))
        # the staff page does not list a production entry, and its routes refuse it
        staff_month = self.client.get(EXCESS + "month", {"month": 2, "year": 2026}, **self.auth).json()
        self.assertEqual(staff_month["summary"]["entries"], 0)
        res = self.client.patch(
            f"{EXCESS}entries/{entry_id}", {"amount": 1, "remark": "wrong page"}, content_type="application/json",
            **self.auth,
        )  # fmt: skip
        self.assertEqual(res.status_code, 404)
        history = self.client.get(PROD + "history", PERIOD, **self.auth).json()["items"]
        self.assertEqual([(h["action"], h["cycle"]) for h in history], [("added", "weekly")])
        ProductionPeriodClose.objects.create(
            cycle="weekly", period_start=START, period_end=END, finalized_at=timezone.now()
        )
        self.assertEqual(self.padd([emp]).status_code, 409)
        res = self.client.post(
            PROD + "remove", {"entryIds": [entry_id], "remark": "Too late"}, content_type="application/json",
            **self.auth,
        )  # fmt: skip
        self.assertEqual(res.status_code, 409)

    def test_the_production_patch_no_longer_sets_a_bonus(self):
        emp = _worker("PX_PATCH")
        p = self.generate(emp)
        res = self.client.patch(
            f"/api/payroll/production/{p.id}", {"bonus": 50}, content_type="application/json", **self.auth
        )
        self.assertEqual(res.status_code, 400)
        self.assertIn("Excess tab", res.json()["error"])

    def test_not_included_and_payslips_of_the_period(self):
        paid = _worker("PX_PAID")
        _worker("PX_MONTHLY", cycle="monthly")
        gone = _worker("PX_GONE")
        Employee.objects.filter(pk=gone.pk).update(status="inactive")
        _staff(code="PX_STAFFER")
        self.generate(paid)
        self.padd([paid], amount="250")
        res = self.client.get("/api/payroll/production/not-included", PERIOD, **self.auth)
        self.assertEqual(res.status_code, 200, res.content)
        rows = {r["code"]: r for r in res.json()["employees"]}
        self.assertNotIn("PX_PAID", rows)
        self.assertEqual(rows["PX_MONTHLY"]["reasonCode"], "other_cycle")
        self.assertEqual(rows["PX_GONE"]["reasonCode"], "inactive")
        self.assertEqual(rows["PX_STAFFER"]["reasonCode"], "staff")
        slips = self.client.get("/api/payslips/production", PERIOD, **self.auth)
        self.assertEqual(slips.status_code, 200, slips.content)
        body = slips.json()
        self.assertEqual([r["code"] for r in body["rows"]], ["PX_PAID"])
        row = body["rows"][0]
        self.assertEqual((row["excess"], row["eSalary"], row["net"]), (250.0, 2750.0, 2750.0))
        self.assertIn({"label": "Excess (added by HR)", "amount": 250.0}, row["earnings"])
        pdf = self.client.get("/api/payslips/production/pdf", {**PERIOD, "ids": str(row["payrollId"])}, **self.auth)
        self.assertEqual(pdf.status_code, 200, pdf.content[:200])
        self.assertTrue(pdf.content.startswith(b"%PDF"))
        self.assertEqual(resolve_module("production-payroll-excess/period"), "production_payroll.salary")
        self.assertEqual(resolve_module("payroll/production/not-included"), "production_payroll.payroll.not_included")
        self.assertEqual(resolve_module("payslips/production/pdf"), "production_payroll.payslip")

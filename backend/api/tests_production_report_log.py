"""
Production Report Log (owner 2026-11-16): /api/attendance/production-report-log answers the staff Report Log's three modes
(summary, detail, daily), its register (/sheet) and its Informed call (/day-informed) for
production employees only, at addresses of their own so a role can be given one page and not the other. The staff
addresses keep answering exactly as before.

Run via: python manage.py test api.tests_production_report_log --keepdb
"""

from datetime import date, time

from django.test import TestCase

from .jwt_utils import sign_token
from .models import (
    AttendanceDayRecord,
    AttendanceLog,
    Employee,
    EmployeeShiftAssignment,
    HRUser,
    Role,
    ShiftTemplate,
)

DAY = date(2026, 8, 3)  # a Monday
BASE = "/api/attendance/production-report-log"
STAFF = "/api/attendance/report-log"


def _bearer(user: HRUser) -> dict:
    return {"HTTP_AUTHORIZATION": f"Bearer {sign_token({'role': 'hr', 'hrUserId': user.id})}"}


class ProductionReportLogTests(TestCase):
    def setUp(self):
        self.admin = HRUser.objects.create(username="prl_admin", password_hash="x", is_super_admin=True)
        self.shift = ShiftTemplate.objects.create(
            name="PRL Shift",
            shift_type="staff",
            start_time=time(9, 0),
            end_time=time(18, 0),
            grace_period_minutes=15,
            first_half_end=time(13, 30),
            lunch_duration_minutes=60,
            lunch_grace_minutes=10,
        )
        self.staff = self._emp("PRL-S1", "staff", punch=time(9, 5))
        self.staff_absent = self._emp("PRL-S2", "staff", punch=None)
        self.worker = self._emp("PRL-P1", "production", punch=time(9, 5))
        self.worker_absent = self._emp("PRL-P2", "production", punch=None)
        self.left = self._emp("PRL-P3", "production", punch=time(9, 0), status="inactive")

    def _emp(self, code, kind, punch, status="active"):
        emp = Employee.objects.create(
            employee_code=code, first_name=code, last_name="Test", employment_type=kind, status=status,
        )
        EmployeeShiftAssignment.objects.create(employee=emp, shift=self.shift, effective_from=date(2020, 1, 1))
        if punch is not None:
            AttendanceLog.objects.create(employee=emp, date=DAY, punch_time=punch, punch_type="IN", source="test")
            AttendanceLog.objects.create(employee=emp, date=DAY, punch_time=time(18, 0), punch_type="IN", source="test")
        return emp

    def get(self, url, user=None, status=200, **params):
        resp = self.client.get(url, params, **_bearer(user or self.admin))
        self.assertEqual(resp.status_code, status, resp.content)
        return resp.json()

    # ── whose rows ──

    def test_the_daily_report_lists_active_production_employees_only(self):
        rows = {r["employeeCode"]: r for r in self.get(BASE, date=DAY.isoformat())["rows"]}
        self.assertEqual(set(rows), {"PRL-P1", "PRL-P2"})
        self.assertEqual(rows["PRL-P1"]["firstPunch"], "09:05")
        self.assertEqual(rows["PRL-P2"]["status"], "absent")
        # and the staff address still lists staff only
        staff_rows = {r["employeeCode"] for r in self.get(STAFF, date=DAY.isoformat())["rows"]}
        self.assertEqual(staff_rows, {"PRL-S1", "PRL-S2"})

    def test_the_month_summary_lists_production_employees_only(self):
        codes = {e["employeeCode"] for e in self.get(BASE, month=8, year=2026)["employees"]}
        self.assertEqual(codes, {"PRL-P1", "PRL-P2"})
        self.assertEqual({e["employeeCode"] for e in self.get(STAFF, month=8, year=2026)["employees"]}, {"PRL-S1", "PRL-S2"})

    def test_the_register_lists_production_employees_only(self):
        sheet = self.get(f"{BASE}/sheet", dateFrom="2026-08-01", dateTo="2026-08-07")
        self.assertEqual({e["employeeCode"] for e in sheet["employees"]}, {"PRL-P1", "PRL-P2"})
        self.assertEqual(len(sheet["dates"]), 7)
        # the 3rd: one of the two production employees came in
        self.assertEqual(sheet["strength"][sheet["dates"].index(DAY.isoformat())], 1)

    def test_the_register_keeps_the_staff_rules_for_its_range(self):
        self.get(f"{BASE}/sheet", status=400, dateFrom="2026-08-01", dateTo="2026-09-15")
        self.get(f"{BASE}/sheet", status=400, dateFrom="2026-08-01")

    def test_one_employees_month_is_for_a_production_employee_only(self):
        detail = self.get(BASE, month=8, year=2026, employeeId=self.worker.id)
        self.assertEqual(detail["employee"]["code"], "PRL-P1")
        self.get(BASE, status=404, month=8, year=2026, employeeId=self.staff.id)
        # the staff address answers for anyone, as it always has
        self.assertEqual(self.get(STAFF, month=8, year=2026, employeeId=self.worker.id)["employee"]["code"], "PRL-P1")

    # ── Informed / Not informed ──

    def test_the_informed_call_marks_a_production_employee_and_refuses_staff(self):
        url = f"{BASE}/day-informed"
        body = {"employeeId": self.worker_absent.id, "date": DAY.isoformat(), "isInformed": True}
        resp = self.client.patch(url, body, content_type="application/json", **_bearer(self.admin))
        self.assertEqual(resp.status_code, 200, resp.content)
        self.assertTrue(AttendanceDayRecord.objects.get(employee=self.worker_absent, date=DAY).is_informed)
        rows = {r["employeeCode"]: r for r in self.get(BASE, date=DAY.isoformat())["rows"]}
        self.assertTrue(rows["PRL-P2"]["isInformed"])

        staff_body = {"employeeId": self.staff_absent.id, "date": DAY.isoformat(), "isInformed": True}
        resp = self.client.patch(url, staff_body, content_type="application/json", **_bearer(self.admin))
        self.assertEqual(resp.status_code, 404)
        self.assertFalse(
            AttendanceDayRecord.objects.filter(employee=self.staff_absent, date=DAY, is_informed=True).exists()
        )

    # ── who may open it ──

    def _user(self, permissions):
        role = Role.objects.create(name=f"PRL role {Role.objects.count()}", permissions=permissions)
        return HRUser.objects.create(username=f"prl_user_{Role.objects.count()}", password_hash="x", role=role)

    def test_a_role_with_nothing_set_gets_what_it_has_on_the_staff_report_log(self):
        allowed = self._user({"attendance": "view"})
        self.get(BASE, user=allowed, date=DAY.isoformat())
        hidden = self._user({"attendance": "edit", "attendance.report_log": "hidden"})
        self.get(BASE, user=hidden, status=403, date=DAY.isoformat())
        self.get(f"{BASE}/sheet", user=hidden, status=403, dateFrom="2026-08-01", dateTo="2026-08-07")

    def test_an_unset_page_follows_the_staff_report_log_page_for_changes_too(self):
        # the staff Report Log only viewable: the production Informed call is refused too
        user = self._user({"attendance": "edit", "attendance.report_log": "view"})
        body = {"employeeId": self.worker_absent.id, "date": DAY.isoformat(), "isInformed": True}
        resp = self.client.patch(f"{BASE}/day-informed", body, content_type="application/json", **_bearer(user))
        self.assertEqual(resp.status_code, 403)
        # its own key set: it decides
        user = self._user({
            "attendance": "edit",
            "attendance.report_log": "view",
            "attendance.production_report_log": "edit",
        })
        resp = self.client.patch(f"{BASE}/day-informed", body, content_type="application/json", **_bearer(user))
        self.assertEqual(resp.status_code, 200, resp.content)

    def test_the_production_page_can_be_given_without_the_staff_one(self):
        user = self._user({
            "attendance": "hidden",
            "attendance.report_log": "hidden",
            "attendance.production_report_log": "view",
        })
        self.get(BASE, user=user, date=DAY.isoformat())
        self.get(f"{BASE}/sheet", user=user, dateFrom="2026-08-01", dateTo="2026-08-07")
        self.get(STAFF, user=user, status=403, date=DAY.isoformat())
        # view only: the Informed call is a change, so it is refused
        body = {"employeeId": self.worker_absent.id, "date": DAY.isoformat(), "isInformed": True}
        resp = self.client.patch(f"{BASE}/day-informed", body, content_type="application/json", **_bearer(user))
        self.assertEqual(resp.status_code, 403)


class ProductionRegisterByPayCycleTests(TestCase):
    """?payCycle= on the production register: the cycle's own pay period (the grid production payroll uses) and the
    workers on that cycle only (owner 2026-11-16: "weekly, biweekly, monthly like payroll")."""

    def setUp(self):
        from .models import PayrollSettings

        ps = PayrollSettings.get()
        ps.prod_cycles = {
            "weekly": {"weekStart": "monday"},
            "biweekly": {"weekStart": "monday", "anchorDate": "2026-07-27"},
            "monthly": {"weekStart": "monday", "anchorDate": "2026-07-27"},
        }
        ps.save()
        self.admin = HRUser.objects.create(username="prc_admin", password_hash="x", is_super_admin=True)
        self.weekly = self._emp("PRC-W", "production", "weekly")
        self.biweekly = self._emp("PRC-B", "production", "biweekly")
        self.monthly = self._emp("PRC-M", "production", "monthly")
        self.unassigned = self._emp("PRC-U", "production", None)
        self.staff = self._emp("PRC-S", "staff", None)

    def _emp(self, code, kind, cycle):
        return Employee.objects.create(
            employee_code=code, first_name=code, last_name="Test", employment_type=kind, status="active",
            production_pay_cycle=cycle,
        )

    def sheet(self, status=200, url=f"{BASE}/sheet", **params):
        resp = self.client.get(url, params, **_bearer(self.admin))
        self.assertEqual(resp.status_code, status, resp.content)
        return resp.json()

    def test_weekly_is_the_week_that_holds_the_date_and_its_workers(self):
        data = self.sheet(payCycle="weekly", around="2026-08-05")  # a Wednesday
        self.assertEqual(data["period"]["periodStart"], "2026-08-03")
        self.assertEqual(data["period"]["periodEnd"], "2026-08-09")
        self.assertEqual(data["period"]["cycle"], "weekly")
        self.assertEqual((data["dateFrom"], data["dateTo"]), ("2026-08-03", "2026-08-09"))
        self.assertEqual(len(data["dates"]), 7)
        self.assertEqual([e["employeeCode"] for e in data["employees"]], ["PRC-W"])

    def test_biweekly_and_monthly_follow_their_anchor(self):
        bi = self.sheet(payCycle="biweekly", around="2026-08-05")
        self.assertEqual((bi["dateFrom"], bi["dateTo"]), ("2026-07-27", "2026-08-09"))
        self.assertEqual([e["employeeCode"] for e in bi["employees"]], ["PRC-B"])
        mo = self.sheet(payCycle="monthly", around="2026-08-30")
        self.assertEqual((mo["dateFrom"], mo["dateTo"]), ("2026-08-24", "2026-09-20"))
        self.assertEqual(len(mo["dates"]), 28)
        self.assertEqual([e["employeeCode"] for e in mo["employees"]], ["PRC-M"])

    def test_the_period_is_the_payroll_pages_period(self):
        from .production_period import resolve_cycle_period
        from .models import PayrollSettings

        start, end = resolve_cycle_period(date(2026, 8, 12), PayrollSettings.get(), "biweekly")
        data = self.sheet(payCycle="biweekly", around="2026-08-12")
        self.assertEqual((data["dateFrom"], data["dateTo"]), (start.isoformat(), end.isoformat()))

    def test_auto_opens_the_cycle_with_the_most_workers_and_every_cycle_is_counted(self):
        self._emp("PRC-B2", "production", "biweekly")
        data = self.sheet(payCycle="auto", around="2026-08-05")
        self.assertEqual(data["period"]["cycle"], "biweekly")
        self.assertEqual(data["period"]["cycleCounts"], {"weekly": 1, "biweekly": 2, "monthly": 1})
        self.assertEqual({e["employeeCode"] for e in data["employees"]}, {"PRC-B", "PRC-B2"})
        # a tie opens the first of them (weekly before biweekly before monthly)
        Employee.objects.filter(employee_code="PRC-B2").update(status="inactive")
        self.assertEqual(self.sheet(payCycle="auto", around="2026-08-05")["period"]["cycle"], "weekly")

    def test_bad_input_and_the_staff_address_are_refused(self):
        self.sheet(status=400, payCycle="fortnightly")
        self.sheet(status=400, payCycle="weekly", around="not-a-date")
        self.sheet(status=400, url="/api/attendance/report-log/sheet", payCycle="weekly")
        self.sheet(status=400, url="/api/attendance/report-log/sheet", payCycle="auto")

    def test_without_a_pay_cycle_it_is_the_plain_date_range_as_before(self):
        data = self.sheet(dateFrom="2026-08-01", dateTo="2026-08-07")
        self.assertNotIn("period", data)
        self.assertEqual({e["employeeCode"] for e in data["employees"]}, {"PRC-W", "PRC-B", "PRC-M", "PRC-U"})


class DayPunchesTests(TestCase):
    """GET .../day-punches: every punch of one employee's day for the register's day card (a click on a day), in time
    order, however many there are, with the count; each address answers for its own kind of employee only."""

    def setUp(self):
        self.admin = HRUser.objects.create(username="dp_admin", password_hash="x", is_super_admin=True)
        self.staff = Employee.objects.create(
            employee_code="DP-S", first_name="Devi", last_name="Staff", employment_type="staff", status="active",
        )
        self.worker = Employee.objects.create(
            employee_code="DP-P", first_name="Kavi", last_name="Worker", employment_type="production", status="active",
        )
        # six punches, saved out of order, two from another source
        for t, source in [
            (time(13, 2, 5), "device"), (time(8, 31, 40), "device"), (time(18, 4), "device"),
            (time(13, 45, 12), "mobile"), (time(10, 15), "device"), (time(10, 40), "mobile"),
        ]:
            AttendanceLog.objects.create(employee=self.staff, date=DAY, punch_time=t, punch_type="IN", source=source)
        AttendanceLog.objects.create(employee=self.staff, date=date(2026, 8, 4), punch_time=time(9, 0), punch_type="IN")
        AttendanceLog.objects.create(employee=self.worker, date=DAY, punch_time=time(8, 0), punch_type="IN")

    def get(self, url, status=200, **params):
        resp = self.client.get(url, params, **_bearer(self.admin))
        self.assertEqual(resp.status_code, status, resp.content)
        return resp.json()

    def test_every_punch_of_the_day_in_time_order_with_the_count(self):
        data = self.get(f"{STAFF}/day-punches", employeeId=self.staff.id, date=DAY.isoformat())
        self.assertEqual(data["count"], 6)
        self.assertEqual(
            [p["time"] for p in data["punches"]],
            ["08:31:40", "10:15:00", "10:40:00", "13:02:05", "13:45:12", "18:04:00"],
        )
        self.assertEqual([p["type"] for p in data["punches"]], ["IN", "OUT", "IN", "OUT", "IN", "OUT"])
        self.assertEqual(data["punches"][2]["source"], "mobile")
        self.assertIn("sourceLabel", data["punches"][0])
        self.assertEqual((data["employeeCode"], data["employeeName"], data["date"]), ("DP-S", "Devi Staff", "2026-08-03"))

    def test_a_day_without_punches_is_an_empty_list(self):
        data = self.get(f"{STAFF}/day-punches", employeeId=self.staff.id, date="2026-08-05")
        self.assertEqual((data["count"], data["punches"]), (0, []))

    def test_each_address_answers_for_its_own_kind_only(self):
        data = self.get(f"{BASE}/day-punches", employeeId=self.worker.id, date=DAY.isoformat())
        self.assertEqual([p["time"] for p in data["punches"]], ["08:00:00"])
        self.get(f"{BASE}/day-punches", status=404, employeeId=self.staff.id, date=DAY.isoformat())
        self.get(f"{STAFF}/day-punches", status=404, employeeId=self.worker.id, date=DAY.isoformat())

    def test_bad_input_is_refused(self):
        self.get(f"{STAFF}/day-punches", status=400, employeeId=self.staff.id)
        self.get(f"{STAFF}/day-punches", status=400, employeeId=self.staff.id, date="03-08-2026")
        self.get(f"{STAFF}/day-punches", status=404, employeeId="abc", date=DAY.isoformat())

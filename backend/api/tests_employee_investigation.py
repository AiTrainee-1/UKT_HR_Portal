"""Employees -> Investigation (owner 2026-11-23): continuous absence in calendar days, the unit's no-data days left out,
approved leave listed but never auto-inactivated, Keep active until the employee attends again, Mark inactive, Make active
again, the nightly Auto Trigger and its switch, the detail calendar, rights.

Run via: DB_TEST_NAME=test_uktex_investigation python manage.py test api.tests_employee_investigation
"""

from datetime import date, time, timedelta
from unittest import mock

from django.test import TestCase

from .investigation import engine, service
from .models import (
    AttendanceLog,
    AuditLog,
    Branch,
    Employee,
    EmployeeInvestigation,
    HRUser,
    InvestigationSettings,
    LeaveRequest,
    Role,
)
from .permission_registry import resolve_module
from .tests_salary_slip_center import _token

TODAY = date(2026, 3, 20)  # a Friday
URL = "/api/employee-investigation/"
PINNED = (
    "api.investigation.engine.ist_today",
    "api.investigation.service.ist_today",
    "api.investigation.views.ist_today",
)


def day(n: int) -> date:
    """n days before TODAY."""
    return TODAY - timedelta(days=n)


class _Base(TestCase):
    def setUp(self):
        for target in PINNED:
            pin = mock.patch(target, return_value=TODAY)
            pin.start()
            self.addCleanup(pin.stop)
        self.ho = Branch.objects.create(name="Inv HO", code="INV_HO")
        self.unit = Branch.objects.create(name="Inv Unit 2", code="INV_U2")
        self.admin = HRUser.objects.create(username="inv_admin", password_hash="x", is_super_admin=True)
        self.auth = _token(self.admin)
        # five colleagues in each unit who come every day (so a unit's normal day has punches)
        for branch, prefix in ((self.ho, "HOC"), (self.unit, "U2C")):
            for i in range(5):
                emp = self.emp(f"{prefix}{i}", branch)
                for n in range(1, 60):
                    if branch == self.unit and self.unit_gap(day(n)):
                        continue
                    self.punch(emp, day(n))
        self.a = self.emp("INVA", self.ho)  # away 40 days -> the 30 list, due tonight
        self.punch(self.a, day(41))
        self.b = self.emp("INVB", self.ho, kind="production")  # away 20 days -> the 15 list
        self.punch(self.b, day(21))
        self.c = self.emp("INVC", self.ho)  # away 40 days, every working day approved leave
        self.punch(self.c, day(41))
        LeaveRequest.objects.create(
            employee=self.c,
            type="medical",
            start_date=day(40).isoformat(),
            end_date=day(1).isoformat(),
            status="approved",
            reason="surgery",
        )
        self.e = self.emp("INVE", self.ho, join=day(60))  # joined 60 days ago, never attended
        self.f = self.emp("INVF", self.unit)  # away 40 days, but the unit's punches did not arrive on 12 working days
        self.punch(self.f, day(41))
        self.g = self.emp("INVG", self.ho)  # comes every day
        self.punch(self.g, day(1))

    @staticmethod
    def unit_gap(d: date) -> bool:
        """Unit 2's device was down from 10 to 25 days ago (working days only matter)."""
        return day(25) <= d <= day(10)

    @staticmethod
    def emp(code, branch, kind="staff", join=None):
        return Employee.objects.create(
            employee_code=code,
            first_name=code,
            last_name="Test",
            employment_type=kind,
            status="active",
            branch=branch,
            join_date=(join or date(2024, 1, 15)).isoformat(),
        )

    @staticmethod
    def punch(emp, d):
        AttendanceLog.objects.create(employee=emp, date=d, punch_time=time(9, 0), punch_type="IN", source="test")

    def spell(self, emp):
        return engine.spells([emp])[emp.id]

    def get(self, path, auth=None, **params):
        return self.client.get(URL + path, params, **(auth or self.auth))

    def post(self, path, body, auth=None):
        return self.client.post(URL + path, body, content_type="application/json", **(auth or self.auth))


class RuleTests(_Base):
    def test_calendar_days_since_the_last_attended_day(self):
        a = self.spell(self.a)
        self.assertEqual((a.last_attended, a.start, a.calendar_days, a.absent_days), (day(41), day(40), 40, 40))
        self.assertEqual(a.bucket, "30")
        b = self.spell(self.b)
        self.assertEqual((b.calendar_days, b.bucket), (20, "15"))
        self.assertIsNone(self.spell(self.g).bucket)

    def test_the_units_no_data_days_are_not_counted_as_away(self):
        f = self.spell(self.f)
        working_gaps = [d for d in f.gap_days]
        self.assertTrue(working_gaps)
        self.assertTrue(all(d.weekday() != 6 and day(25) <= d <= day(10) for d in working_gaps))
        self.assertEqual(f.absent_days, 40 - len(working_gaps))
        self.assertEqual(f.bucket, "15")  # 40 calendar days, but under 30 once the outage is left out
        self.assertFalse(engine.auto_due(f, None, 30)[0])

    def test_approved_leave_for_every_working_day_is_listed_but_never_auto(self):
        c = self.spell(self.c)
        self.assertEqual(c.bucket, "30")
        self.assertTrue(c.covered_by_leave)
        due, why = engine.auto_due(c, None, 30)
        self.assertFalse(due)
        self.assertIn("approved leave", why)

    def test_never_attended_counts_from_the_join_date_and_is_never_auto(self):
        e = self.spell(self.e)
        self.assertTrue(e.never_attended)
        self.assertEqual((e.start, e.calendar_days), (day(60), 60))
        self.assertIn("No attendance ever recorded", engine.auto_due(e, None, 30)[1])

    def test_a_spreadsheet_serial_join_date_is_read_as_its_date(self):
        Employee.objects.filter(pk=self.b.pk).update(join_date="01-01-45640")  # 14 Dec 2024
        self.b.refresh_from_db()
        self.assertEqual(self.spell(self.b).calendar_days, 20)  # not hidden by a "year 4564" join date

    def test_the_lists(self):
        r = self.get("list", bucket="30")
        self.assertEqual(r.status_code, 200, r.content)
        rows = {row["code"]: row for row in r.json()["employees"]}
        self.assertEqual(set(rows), {"INVA", "INVC", "INVE"})
        self.assertTrue(rows["INVA"]["autoTonight"])
        self.assertFalse(rows["INVC"]["autoTonight"])
        self.assertTrue(rows["INVC"]["coveredByLeave"])
        fifteen = {row["code"]: row for row in self.get("list", bucket="15").json()["employees"]}
        self.assertEqual(set(fifteen), {"INVB", "INVF"})
        self.assertEqual(fifteen["INVB"]["kind"], "production")
        self.assertEqual(
            set(r["code"] for r in self.get("list", bucket="15", kind="staff").json()["employees"]), {"INVF"}
        )
        summary = self.get("summary").json()
        self.assertEqual((summary["d15"], summary["d30"], summary["tonight"]), (2, 3, 1))


class DecisionTests(_Base):
    def test_mark_inactive_needs_a_reason_and_is_recorded(self):
        self.assertEqual(self.post("inactivate", {"employeeIds": [self.b.id], "reason": ""}).status_code, 400)
        r = self.post("inactivate", {"employeeIds": [self.b.id], "reason": "No reply to calls", "bucket": "15"})
        self.assertEqual(r.status_code, 200, r.content)
        self.b.refresh_from_db()
        self.assertEqual(self.b.status, "inactive")
        d = EmployeeInvestigation.objects.get(employee=self.b)
        self.assertEqual((d.action, d.bucket, d.absent_days, d.last_attended), ("inactivated", "15", 20, day(21)))
        self.assertEqual(d.by, "inv_admin")
        self.assertNotIn("INVB", {row["code"] for row in self.get("list", bucket="15").json()["employees"]})

    def test_keep_active_holds_until_they_attend_again(self):
        r = self.post(
            "keep-active", {"employeeIds": [self.a.id], "reason": "Long medical leave agreed", "bucket": "30"}
        )
        self.assertEqual(r.status_code, 200, r.content)
        self.assertNotIn(self.a.id, [e.id for e, _s in service.due_tonight()])
        row = {x["code"]: x for x in self.get("list", bucket="30").json()["employees"]}["INVA"]
        self.assertTrue(row["keptActive"])
        self.assertIn("Kept active", row["autoWhyNot"])
        # they come back on day 5 and are away again: a new absence, the old Keep active no longer holds
        self.punch(self.a, day(5))
        spell = self.spell(self.a)
        self.assertEqual(spell.start, day(4))
        self.assertFalse(engine.kept_for_spell(engine.decisions([self.a.id]).get(self.a.id), spell))


class AutoTriggerTests(_Base):
    def test_the_nightly_run_inactivates_only_who_is_due(self):
        summary = service.auto_run()
        self.assertEqual(summary["inactivated"], 1)
        statuses = dict(Employee.objects.filter(employee_code__startswith="INV").values_list("employee_code", "status"))
        self.assertEqual(statuses["INVA"], "inactive")
        for code in ("INVB", "INVC", "INVE", "INVF", "INVG"):
            self.assertEqual(statuses[code], "active", code)
        d = EmployeeInvestigation.objects.get(employee=self.a)
        self.assertEqual((d.action, d.by, d.absent_days), ("auto_inactivated", "Auto Trigger", 40))
        self.assertEqual(InvestigationSettings.objects.get().last_run_summary["inactivated"], 1)
        self.assertTrue(AuditLog.objects.filter(module="employees", user_name="Auto Trigger").exists())
        # nothing to do the next night
        self.assertEqual(service.auto_run()["inactivated"], 0)

    def test_the_switch_turns_it_off(self):
        r = self.client.put(URL + "settings", {"autoEnabled": False}, content_type="application/json", **self.auth)
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(service.auto_run(), {"ran": False, "reason": "switched off"})
        self.a.refresh_from_db()
        self.assertEqual(self.a.status, "active")
        role = Role.objects.create(name="Unit HR", permissions={"employees": "edit"})
        unit_hr = HRUser.objects.create(username="inv_unit", password_hash="x", role=role, branch=self.unit)
        r = self.client.put(URL + "settings", {"autoEnabled": True}, content_type="application/json", **_token(unit_hr))
        self.assertEqual(r.status_code, 403)

    def test_make_active_again_keeps_them_active_for_this_absence(self):
        service.auto_run()
        r = self.post("reactivate", {"employeeIds": [self.a.id], "reason": "Came back with a medical letter"})
        self.assertEqual(r.status_code, 200, r.content)
        self.a.refresh_from_db()
        self.assertEqual(self.a.status, "active")
        self.assertEqual(service.auto_run()["inactivated"], 0)
        body = self.get("auto").json()
        entry = next(h for h in body["history"] if h["employee"]["code"] == "INVA")
        self.assertEqual(entry["since"]["action"], "reactivated")
        self.assertEqual(entry["employee"]["status"], "active")

    def test_run_now_runs_the_rules_at_once_even_when_switched_off(self):
        InvestigationSettings.objects.update_or_create(pk=1, defaults={"auto_enabled": False})
        r = self.post("run-now", {})
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual((r.json()["summary"]["inactivated"], r.json()["summary"]["runBy"]), (1, "inv_admin"))
        self.a.refresh_from_db()
        self.assertEqual(self.a.status, "inactive")
        d = EmployeeInvestigation.objects.get(employee=self.a)
        self.assertEqual((d.action, d.by), ("auto_inactivated", "Auto Trigger (Run now by inv_admin)"))
        role = Role.objects.create(name="Unit HR run", permissions={"employees": "edit"})
        unit_hr = HRUser.objects.create(username="inv_unit_run", password_hash="x", role=role, branch=self.unit)
        self.assertEqual(self.post("run-now", {}, auth=_token(unit_hr)).status_code, 403)

    def test_mark_inactive_from_the_tonight_list(self):
        r = self.post("inactivate", {"employeeIds": [self.a.id], "reason": "Resigned by phone", "bucket": "auto"})
        self.assertEqual(r.status_code, 200, r.content)
        d = EmployeeInvestigation.objects.get(employee=self.a)
        self.assertEqual((d.action, d.bucket), ("inactivated", "auto"))
        self.assertEqual(self.get("auto").json()["tonight"], [])

    def test_the_auto_view_says_who_goes_tonight(self):
        body = self.get("auto").json()
        self.assertEqual([r["code"] for r in body["tonight"]], ["INVA"])
        self.assertTrue(body["settings"]["autoEnabled"])
        self.assertEqual(body["settings"]["runAt"], "01:00")


class DetailTests(_Base):
    def test_the_days_leave_and_punches(self):
        body = self.get("detail", employeeId=self.c.id).json()
        kinds = {d["kind"] for d in body["calendar"]}
        self.assertIn("leave", kinds)
        self.assertEqual(body["leaves"][0]["status"], "approved")
        self.assertEqual(body["punches"][0]["date"], day(41).isoformat())
        gaps = {d["kind"] for d in self.get("detail", employeeId=self.f.id).json()["calendar"]}
        self.assertIn("no_data", gaps)

    def test_the_permission_key(self):
        self.assertEqual(resolve_module("employee-investigation/list"), "employees.investigation")
        self.assertEqual(resolve_module("employee-investigation/settings"), "employees.investigation")

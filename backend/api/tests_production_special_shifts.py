"""
Production shifts on Manage Shifts (owner 2026-11-16): the Settings -> Production Shifts groups are the default
production shifts; a SPECIAL shift (its own times and Earned Shift table) is made on Manage Shifts and judges AND pays only
the workers assigned to it, on its dates and days. Settings never shows, saves or deletes a special shift.

Run via: python manage.py test api.tests_production_special_shifts --keepdb
"""

from datetime import date, time
from decimal import Decimal
from unittest import mock

from . import production_shift_rules as psr
from .attendance_final import compute_day_record
from .models import (
    AttendanceLog,
    Employee,
    ProductionShiftConfig,
    ProductionShiftGroup,
    ProductionSpecialShiftAssignment,
)
from .tests_production_shift_rules_api import TODAY, Base, role_headers

OVERVIEW = "/api/shifts/production"
SPECIAL = OVERVIEW + "/special"
SETTINGS = "/api/production-shift-rules"
WED = date(2026, 10, 21)  # a Wednesday after the rules start (2026-10-14)
SUN = date(2026, 10, 25)


def early_shift(**over) -> dict:
    """07:00 start, 15:00 standard departure, one row: leave at 15:00 = 1.00 shift (Monday to Saturday)."""
    body = {
        "label": "Early special",
        "appliesOn": "mon_sat",
        "startTime": "07:00",
        "mainOutTime": "15:00",
        "mainOutNextDay": False,
        "enabled": True,
        "rules": [{"label": "", "outTime": "15:00", "outNextDay": False, "shiftValue": 1.00, "enabled": True}],
    }
    body.update(over)
    return body


class SpecialBase(Base):
    def setUp(self):
        super().setUp()
        patcher = mock.patch("api.production_special_shifts_views.ist_today", return_value=TODAY)
        patcher.start()
        self.addCleanup(patcher.stop)
        self.worker = self.emp("PS-1")
        self.other = self.emp("PS-2")

    def emp(self, code, kind="production"):
        return Employee.objects.create(
            employee_code=code, first_name=code, last_name="W", employment_type=kind, status="active"
        )

    def punch(self, emp, d, *times):
        for t in times:
            AttendanceLog.objects.create(employee=emp, date=d, punch_time=t, punch_type="IN", source="test")

    def overview(self, headers=None):
        r = self.client.get(OVERVIEW, **(headers or self.headers))
        self.assertEqual(r.status_code, 200, r.content)
        return r.json()

    def create(self, body=None, headers=None, status=201):
        r = self.client.post(SPECIAL, body or early_shift(), content_type="application/json", **(headers or self.headers))
        self.assertEqual(r.status_code, status, r.content)
        return r.json()

    def special_id(self, label="Early special"):
        return ProductionShiftGroup.objects.get(is_special=True, label=label).id

    def assign(self, gid, ids, start, end=None, status=201, headers=None):
        body = {"employeeIds": ids, "effectiveFrom": start}
        if end:
            body["effectiveTo"] = end
        r = self.client.post(
            f"{SPECIAL}/{gid}/assign", body, content_type="application/json", **(headers or self.headers)
        )
        self.assertEqual(r.status_code, status, r.content)
        return r.json()


class OverviewTests(SpecialBase):
    def test_the_settings_groups_are_the_default_production_shifts(self):
        data = self.overview()
        self.assertEqual([g["label"] for g in data["defaults"]], ["Day shift", "Night shift", "Sunday shift"])
        day = data["defaults"][0]
        self.assertEqual((day["startTime"], day["mainOutTime"]), ("08:30", "20:00"))
        self.assertTrue(day["rules"])
        self.assertEqual(data["graceMinutes"], 5)
        self.assertTrue(data["breaks"])
        self.assertEqual(data["special"], [])
        self.assertEqual(data["roster"]["production"], 2)


class SpecialCrudTests(SpecialBase):
    def test_a_special_shift_is_made_here_and_settings_never_sees_or_deletes_it(self):
        data = self.create()
        self.assertEqual([s["label"] for s in data["special"]], ["Early special"])
        self.assertEqual(data["special"][0]["rules"][0]["shiftValue"], 1.0)
        # Settings: only the defaults, and saving it (with a change) keeps the special shift
        doc = self.client.get(SETTINGS, **self.headers).json()
        self.assertNotIn("Early special", [g["label"] for g in doc["groups"]])
        doc = {k: v for k, v in doc.items() if k not in ("updatedAt", "updatedBy", "warnings", "legacy", "version")}
        doc["graceMinutes"] = 6
        r = self.client.put(SETTINGS, doc, content_type="application/json", **self.headers)
        self.assertEqual(r.status_code, 200, r.content)
        self.assertTrue(ProductionShiftGroup.objects.filter(is_special=True, label="Early special").exists())

    def test_it_is_checked_like_a_settings_group(self):
        bad = early_shift(
            rules=[
                {"outTime": "11:00", "outNextDay": False, "shiftValue": 0.75, "enabled": True},
                {"outTime": "15:00", "outNextDay": False, "shiftValue": 0.50, "enabled": True},
            ]
        )
        r = self.create(bad, status=400)
        self.assertIn("can only stay the same or go up", r["error"])
        r = self.create(early_shift(rules=[]), status=400)
        self.assertIn("rule", r["error"])

    def test_a_change_to_settings_that_would_break_a_special_shift_is_refused(self):
        self.create(early_shift(rules=[{"outTime": "15:00", "outNextDay": False, "shiftValue": 0.50, "enabled": True}]))
        doc = self.client.get(SETTINGS, **self.headers).json()
        doc = {k: v for k, v in doc.items() if k not in ("updatedAt", "updatedBy", "warnings", "legacy", "version")}
        doc["minCredit"] = 0.75  # the defaults all pay at least 1.00; the special one only 0.50
        r = self.client.put(SETTINGS, doc, content_type="application/json", **self.headers)
        self.assertEqual(r.status_code, 400, r.content)
        self.assertIn("special shift Early special", r.json()["error"])

    def test_edit_and_delete(self):
        self.create()
        gid = self.special_id()
        r = self.client.put(
            f"{SPECIAL}/{gid}", early_shift(label="Early 7-3"), content_type="application/json", **self.headers
        )
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(r.json()["special"][0]["label"], "Early 7-3")
        r = self.client.delete(f"{SPECIAL}/{gid}", **self.headers)
        self.assertEqual(r.status_code, 200, r.content)
        self.assertFalse(ProductionShiftGroup.objects.filter(id=gid).exists())

    def test_one_that_had_workers_is_deleted_only_once_confirmed_and_takes_them_off(self):
        self.create()
        gid = self.special_id()
        self.assign(gid, [self.worker.id], "2026-10-10")  # started (today is 2026-10-14)
        r = self.client.delete(f"{SPECIAL}/{gid}", **self.headers)
        self.assertEqual(r.status_code, 409)
        self.assertEqual(r.json()["code"], "special_in_use")
        self.assertEqual(r.json()["workers"], 1)
        self.assertIn("10 Oct 2026 to 14 Oct 2026", r.json()["error"])
        self.assertTrue(ProductionShiftGroup.objects.filter(id=gid).exists())
        r = self.client.delete(f"{SPECIAL}/{gid}?force=1", **self.headers)
        self.assertEqual(r.status_code, 200, r.content)
        self.assertFalse(ProductionShiftGroup.objects.filter(id=gid).exists())
        self.assertFalse(ProductionSpecialShiftAssignment.objects.filter(employee=self.worker).exists())
        self.assertIn("back on the default production shifts", r.json()["warnings"][0])

    def test_branch_logins_and_roles_without_the_feature_cannot_change_them(self):
        from .models import Branch

        branch = Branch.objects.create(name="PS Unit", code="PSU")
        self.create(headers=role_headers({"shifts": "edit"}, branch=branch), status=403)
        self.create(headers=role_headers({"shifts": "view"}), status=403)
        self.create(headers=role_headers({"shifts": "edit", "shifts.production_special": "hidden"}), status=403)
        self.create(headers=role_headers({"shifts": "edit"}))


class AssignmentTests(SpecialBase):
    def setUp(self):
        super().setUp()
        self.create()
        self.gid = self.special_id()

    def test_the_assigned_worker_is_judged_and_paid_by_it_on_its_days_only(self):
        for d in (WED, SUN):
            self.punch(self.worker, d, time(7, 0), time(15, 0))
            self.punch(self.other, d, time(7, 0), time(15, 0))
        before = compute_day_record(self.worker, WED).shifts_earned
        self.assign(self.gid, [self.worker.id], "2026-10-20")
        wed = compute_day_record(self.worker, WED)
        self.assertEqual(wed.shifts_earned, Decimal("1.00"))
        self.assertNotEqual(before, Decimal("1.00"))  # the default Day shift (08:30) pays less for 07:00-15:00
        # the other worker keeps the defaults; the special one is Monday-Saturday, so Sunday is the Sunday shift
        self.assertEqual(compute_day_record(self.other, WED).shifts_earned, before)
        sunday_default = compute_day_record(self.other, SUN).shifts_earned
        self.assertEqual(compute_day_record(self.worker, SUN).shifts_earned, sunday_default)

    def test_the_engine_picks_it_only_inside_the_assignment(self):
        self.assign(self.gid, [self.worker.id], "2026-10-20", "2026-10-22")
        ruleset = psr.load_ruleset(ProductionShiftConfig.get())

        def pick(d):
            return psr.select_group(ruleset, d, 8 * 3600 + 30 * 60, self.worker.id)

        self.assertEqual(pick(date(2026, 10, 21)).label, "Early special")
        self.assertEqual(pick(date(2026, 10, 19)).label, "Day shift")
        self.assertEqual(pick(date(2026, 10, 23)).label, "Day shift")
        self.assertEqual(psr.select_group(ruleset, date(2026, 10, 21), 8 * 3600 + 30 * 60, self.other.id).label, "Day shift")

    def test_a_running_assignment_is_ended_by_a_later_one_and_an_overlap_is_refused(self):
        self.create(early_shift(label="Late special", startTime="10:00", mainOutTime="18:00",
                                rules=[{"outTime": "18:00", "outNextDay": False, "shiftValue": 1.00, "enabled": True}]))
        late = self.special_id("Late special")
        self.assign(self.gid, [self.worker.id], "2026-10-20")
        data = self.assign(late, [self.worker.id], "2026-11-01")
        first = ProductionSpecialShiftAssignment.objects.get(group_id=self.gid)
        self.assertEqual(first.effective_to, date(2026, 10, 31))
        self.assertEqual(data["assigned"], 1)
        r = self.assign(self.gid, [self.worker.id], "2026-10-25", status=409)
        self.assertEqual(r["code"], "special_overlap")

    def test_end_remove_and_who_can_be_assigned(self):
        staff = self.emp("PS-S", kind="staff")
        r = self.assign(self.gid, [staff.id], "2026-10-20", status=400)
        self.assertIn("production", r["error"])
        self.assign(self.gid, [self.worker.id], "2026-10-10")  # started (today is 2026-10-14)
        self.assign(self.gid, [self.other.id], "2026-10-30")  # upcoming
        started = ProductionSpecialShiftAssignment.objects.get(employee=self.worker)
        upcoming = ProductionSpecialShiftAssignment.objects.get(employee=self.other)
        base = OVERVIEW + "/special-assignments"
        r = self.client.delete(f"{base}/{started.id}", **self.headers)
        self.assertEqual(r.status_code, 409)  # started: needs the confirmation
        self.assertEqual(r.json()["code"], "assignment_started")
        r = self.client.post(f"{base}/{started.id}/end", {"lastDay": "2026-10-12"},
                             content_type="application/json", **self.headers)
        self.assertEqual(r.status_code, 200, r.content)
        started.refresh_from_db()
        self.assertEqual(started.effective_to, date(2026, 10, 12))
        self.assertTrue(r.json()["warnings"])  # past days are worked out again
        r = self.client.delete(f"{base}/{upcoming.id}", **self.headers)
        self.assertEqual(r.status_code, 200, r.content)
        self.assertFalse(ProductionSpecialShiftAssignment.objects.filter(id=upcoming.id).exists())

    def test_the_overview_lists_who_is_on_it(self):
        self.assign(self.gid, [self.worker.id], "2026-10-10")
        special = self.overview()["special"][0]
        self.assertEqual(special["activeCount"], 1)
        self.assertEqual(special["assignments"][0]["employeeCode"], "PS-1")
        self.assertEqual(special["assignments"][0]["state"], "active")
        self.assertTrue(special["everAssigned"])

    def test_a_started_assignment_can_be_removed_once_confirmed_and_its_days_go_back_to_the_defaults(self):
        self.punch(self.worker, WED, time(7, 0), time(15, 0))
        default = compute_day_record(self.worker, WED).shifts_earned
        self.assign(self.gid, [self.worker.id], "2026-10-20")
        self.assertEqual(compute_day_record(self.worker, WED).shifts_earned, Decimal("1.00"))
        a = ProductionSpecialShiftAssignment.objects.get(employee=self.worker)
        url = f"{OVERVIEW}/special-assignments/{a.id}"
        with mock.patch("api.production_special_shifts_views.ist_today", return_value=date(2026, 10, 22)):
            r = self.client.delete(url, **self.headers)
            self.assertEqual(r.status_code, 409)
            r = self.client.delete(url + "?force=1", **self.headers)
        self.assertEqual(r.status_code, 200, r.content)
        self.assertIn("20 Oct 2026 to 22 Oct 2026", r.json()["warnings"][0])
        self.assertFalse(ProductionSpecialShiftAssignment.objects.filter(id=a.id).exists())
        self.assertEqual(compute_day_record(self.worker, WED).shifts_earned, default)

"""
Compensation Leave, parts A and C: the company-announced late-in / early-out windows API and the birthday list,
plus how the punch-based Attendance daily list shows a birthday / relaxation day.

Run via: python manage.py test api.tests_compensation_windows_birthdays -v 2
"""

from datetime import date, time
from decimal import Decimal

from django.db import connection
from django.test import TestCase
from django.test.utils import CaptureQueriesContext
from unittest import mock

from . import approval_workflow as approval
from .jwt_utils import sign_token
from .models import (
    AttendanceDayRecord,
    AttendanceLog,
    AuditLog,
    Branch,
    CompensationConfig,
    CompensationDayAnnouncement,
    Department,
    Employee,
    Holiday,
    HRUser,
    LeaveRequest,
    OvertimeRecord,
    PayrollSettings,
    Role,
)

TODAY = date(2026, 10, 14)  # a Wednesday
TOMORROW = date(2026, 10, 15)
WINDOWS = "/api/compensation/windows"
BIRTHDAYS = "/api/compensation/birthdays"


def _bearer(payload: dict) -> dict:
    return {"HTTP_AUTHORIZATION": f"Bearer {sign_token(payload)}"}


def _hr(username, permissions=None, branch=None, super_admin=False) -> dict:
    role = Role.objects.create(name=f"role_{username}", permissions=permissions) if permissions is not None else None
    user = HRUser.objects.create(
        username=username,
        password_hash="x",
        full_name=username.title(),
        role=role,
        branch=branch,
        is_super_admin=super_admin,
    )
    return _bearer({"role": "hr", "hrUserId": user.id, "name": user.full_name})


def _employee(code, branch=None, department=None, kind="staff", status="active", dob=None) -> Employee:
    return Employee.objects.create(
        employee_code=code,
        first_name=code,
        last_name="Wb",
        employment_type=kind,
        status=status,
        branch=branch,
        department=department,
        date_of_birth=dob,
    )


class LeaveBase(TestCase):
    def setUp(self):
        approval.clear_cache()
        self.addCleanup(approval.clear_cache)
        for target in ("api.compensation_windows_views.ist_today", "api.compensation_birthday_views.ist_today"):
            patch = mock.patch(target, return_value=TODAY)
            patch.start()
            self.addCleanup(patch.stop)
        settings = PayrollSettings.get()
        settings.compensation_feature_enabled = True
        settings.save()
        CompensationConfig.objects.update_or_create(
            pk=1,
            defaults={"windows_enabled": True, "birthday_enabled": True, "birthday_effective_from": date(2026, 1, 1)},
        )
        self.ho = Branch.objects.create(name="WB Head Office", code="WBHO", is_head_office=True)
        self.u2 = Branch.objects.create(name="WB Unit 2", code="WBU2")
        self.cutting = Department.objects.create(name="WB Cutting", branch=self.ho)
        self.finishing = Department.objects.create(name="WB Finishing", branch=self.ho)
        self.sewing = Department.objects.create(name="WB Sewing", branch=self.u2)
        self.asha = _employee("WB1", self.ho, self.cutting)
        self.ravi = _employee("WB2", self.ho, self.finishing)
        self.mani = _employee("WB3", self.u2, self.sewing)
        self.prod = _employee("WBP", self.ho, self.cutting, kind="production")
        self.gone = _employee("WBX", self.ho, self.cutting, status="inactive")
        self.admin = _hr("wb_admin", super_admin=True)
        self.view_only = _hr("wb_view", {"compensation": "view"})
        self.no_access = _hr("wb_none", {"leave": "edit"})
        self.ho_hr = _hr("wb_ho", {"compensation": "edit"}, branch=self.ho)

    def post(self, body, who=None, path=WINDOWS):
        return self.client.post(path, body, content_type="application/json", **(who or self.admin))

    def get(self, path=WINDOWS, who=None, **params):
        return self.client.get(path, params, **(who or self.admin))

    def delete(self, path, who=None):
        return self.client.delete(path, **(who or self.admin))

    def announce(self, kind="late_in", day=TOMORROW, at="10:30", reason="Heavy rain", who=None, **extra):
        r = self.post({"date": day.isoformat(), "kind": kind, "time": at, "reason": reason, **extra}, who)
        self.assertEqual(r.status_code, 201, r.content)
        return r.json()


# ═════════════════════════════ announced windows ═════════════════════════════


class AnnounceTests(LeaveBase):
    def test_a_late_in_window_for_all_staff(self):
        body = self.announce("late_in", at="10:30")
        self.assertEqual(
            (body["date"], body["kind"], body["kindLabel"], body["time"], body["reason"], body["announcedBy"]),
            ("2026-10-15", "late_in", "Late-in", "10:30", "Heavy rain", "Wb_Admin"),
        )
        # active staff only: Asha, Ravi, Mani (not the production employee, not the inactive one)
        self.assertEqual((body["covers"], body["allStaff"], body["canDelete"]), (3, True, True))
        ann = CompensationDayAnnouncement.objects.get()
        self.assertEqual(
            (ann.kind, ann.allowed_time, ann.leave_until_time, ann.branch_id), ("late_in", time(10, 30), None, None)
        )

    def test_an_early_out_window_keeps_its_time_where_the_engine_already_reads_the_cut_off(self):
        body = self.announce("early_out", at="16:00")
        ann = CompensationDayAnnouncement.objects.get(pk=body["id"])
        self.assertEqual((ann.kind, ann.allowed_time, ann.leave_until_time), ("early_out", time(16, 0), time(16, 0)))
        self.assertEqual(body["time"], "16:00")

    def test_it_is_audited(self):
        body = self.announce()
        log = AuditLog.objects.get(module="compensation", action="create", record_id=body["id"])
        self.assertIn("late-in window for 2026-10-15 at 10:30", log.record_description)
        self.assertIn("3 staff", log.record_description)

    def test_today_is_allowed_yesterday_and_a_far_future_date_are_not(self):
        self.assertEqual(
            self.post({"date": "2026-10-14", "kind": "late_in", "time": "10:00", "reason": "x"}).status_code, 201
        )
        r = self.post({"date": "2026-10-13", "kind": "late_in", "time": "10:00", "reason": "x"})
        self.assertEqual((r.status_code, "today or a later date" in r.json()["error"]), (400, True))
        far = self.post({"date": "2027-06-01", "kind": "late_in", "time": "10:00", "reason": "x"})
        self.assertEqual((far.status_code, "180 days" in far.json()["error"]), (400, True))
        edge = self.post({"date": "2027-04-12", "kind": "early_out", "time": "10:00", "reason": "x"})  # today + 180
        self.assertEqual(edge.status_code, 201, edge.content)

    def test_validation(self):
        base = {"date": "2026-10-15", "kind": "late_in", "time": "10:30", "reason": "Rain"}
        cases = (
            ({"date": None}, "date must be a date"),
            ({"date": "soon"}, "date must be a date"),
            ({"kind": "day"}, "kind must be late_in"),
            ({"kind": None}, "kind must be late_in"),
            ({"time": ""}, "time is required"),
            ({"time": None}, "time is required"),
            ({"time": "ten"}, "time must be a time"),
            ({"time": "25:00"}, "time must be a time"),
            ({"reason": " "}, "Give a reason"),
            ({"reason": "x" * 301}, "at most 300"),
        )
        for change, fragment in cases:
            r = self.post({**base, **change})
            self.assertEqual(r.status_code, 400, change)
            self.assertIn(fragment, r.json()["error"], change)
        self.assertFalse(CompensationDayAnnouncement.objects.exists())

    def test_a_time_may_carry_seconds(self):
        self.assertEqual(self.announce(at="10:30:00")["time"], "10:30")

    def test_one_window_of_a_kind_per_person_per_date(self):
        first = self.announce("late_in", at="10:30")
        r = self.post({"date": "2026-10-15", "kind": "late_in", "time": "11:00", "reason": "again"})
        self.assertEqual(r.status_code, 400)
        self.assertIn("already announced for", r.json()["error"])
        self.assertIn("10:30", r.json()["error"])
        self.assertIn("covers 3 of the same people", r.json()["error"])
        # a different kind, or another date, is fine
        self.announce("early_out", at="16:00")
        self.announce("late_in", day=date(2026, 10, 16), at="11:00")
        self.assertEqual(CompensationDayAnnouncement.objects.count(), 3)
        # once the first is removed the date is free again
        self.assertEqual(self.delete(f"{WINDOWS}/{first['id']}").status_code, 204)
        self.announce("late_in", at="11:00")

    def test_scoped_announcements_clash_only_when_they_share_a_person(self):
        self.announce("late_in", branchId=self.ho.id, departmentId=self.cutting.id)
        self.announce("late_in", branchId=self.ho.id, departmentId=self.finishing.id)  # other people: fine
        self.announce("late_in", branchId=self.u2.id)  # another branch: fine
        clash = self.post(
            {"date": "2026-10-15", "kind": "late_in", "time": "09:30", "reason": "x", "branchId": self.ho.id}
        )
        self.assertEqual(clash.status_code, 400)  # the whole head office overlaps both of its departments
        everyone = self.post({"date": "2026-10-15", "kind": "late_in", "time": "09:30", "reason": "x"})
        self.assertEqual(everyone.status_code, 400)

    def test_a_listed_employee_clashes_with_a_window_that_already_covers_them(self):
        self.announce("late_in", employeeIds=[self.asha.id])
        again = self.post(
            {
                "date": "2026-10-15",
                "kind": "late_in",
                "time": "09:30",
                "reason": "x",
                "employeeIds": [self.asha.id, self.ravi.id],
            }
        )
        self.assertEqual((again.status_code, "covers 1 of the same person" in again.json()["error"]), (400, True))
        self.announce("late_in", employeeIds=[self.ravi.id], at="09:30")

    def test_scope_checks(self):
        base = {"date": "2026-10-15", "kind": "late_in", "time": "10:30", "reason": "x"}
        self.assertEqual(self.post({**base, "branchId": 999999}).status_code, 404)
        self.assertEqual(self.post({**base, "departmentId": 999999}).status_code, 404)
        wrong = self.post({**base, "branchId": self.ho.id, "departmentId": self.sewing.id})
        self.assertEqual((wrong.status_code, "does not belong to that branch" in wrong.json()["error"]), (400, True))
        both = self.post({**base, "employeeIds": [self.asha.id], "branchId": self.ho.id})
        self.assertEqual((both.status_code, "not both" in both.json()["error"]), (400, True))
        for bad in ([self.prod.id], [self.gone.id], [999999], ["x"], "1"):
            r = self.post({**base, "employeeIds": bad})
            self.assertEqual(r.status_code, 400, bad)
        self.assertFalse(CompensationDayAnnouncement.objects.exists())

    def test_nobody_covered_is_refused(self):
        empty = Department.objects.create(name="WB Empty", branch=self.ho)
        r = self.post(
            {"date": "2026-10-15", "kind": "late_in", "time": "10:30", "reason": "x", "departmentId": empty.id}
        )
        self.assertEqual((r.status_code, "nobody to announce for" in r.json()["error"]), (400, True))

    def test_a_branch_scoped_user_announces_for_their_own_branch_only(self):
        body = self.announce(who=self.ho_hr)
        self.assertEqual((body["branchId"], body["covers"], body["allStaff"]), (self.ho.id, 2, False))
        other = self.post(
            {"date": "2026-10-16", "kind": "late_in", "time": "10:30", "reason": "x", "branchId": self.u2.id},
            self.ho_hr,
        )
        self.assertEqual(other.status_code, 403)
        mine = self.post(
            {"date": "2026-10-16", "kind": "late_in", "time": "10:30", "reason": "x", "branchId": self.ho.id},
            self.ho_hr,
        )
        self.assertEqual(mine.status_code, 201)
        foreign = self.post(
            {"date": "2026-10-17", "kind": "late_in", "time": "10:30", "reason": "x", "employeeIds": [self.mani.id]},
            self.ho_hr,
        )
        self.assertEqual(foreign.status_code, 400)  # Mani is in another branch
        mine_listed = self.post(
            {"date": "2026-10-17", "kind": "late_in", "time": "10:30", "reason": "x", "employeeIds": [self.asha.id]},
            self.ho_hr,
        )
        self.assertEqual((mine_listed.status_code, mine_listed.json()["branchId"]), (201, None))


class AnnounceInputTests(LeaveBase):
    def test_a_huge_list_of_employees_is_refused(self):
        r = self.post(
            {
                "date": TOMORROW.isoformat(),
                "kind": "late_in",
                "time": "10:30",
                "reason": "Rain",
                "employeeIds": list(range(501)),
            }
        )
        self.assertEqual(r.status_code, 400, r.content)
        self.assertIn("at most 500", r.json()["error"])
        self.assertFalse(CompensationDayAnnouncement.objects.exists())

    def test_an_infinite_number_in_the_body_is_a_400_not_a_crash(self):
        r = self.client.post(
            WINDOWS,
            '{"date": "%s", "kind": "late_in", "time": "10:30", "reason": "Rain", "employeeIds": [1e999]}'
            % TOMORROW.isoformat(),
            content_type="application/json",
            **self.admin,
        )
        self.assertEqual(r.status_code, 400, r.content)


class WindowGateTests(LeaveBase):
    body = {"date": "2026-10-15", "kind": "late_in", "time": "10:30", "reason": "Rain"}

    def test_the_master_switch_and_the_windows_switch_refuse_changes_but_never_reads(self):
        made = self.announce()
        settings = PayrollSettings.get()
        settings.compensation_feature_enabled = False
        settings.save()
        self.assertEqual(self.post(self.body).status_code, 403)
        self.assertEqual(self.delete(f"{WINDOWS}/{made['id']}").status_code, 403)
        listed = self.get().json()
        self.assertEqual(
            (listed["count"], listed["enabled"]["windows"], listed["enabled"]["master"]), (1, False, False)
        )
        settings.compensation_feature_enabled = True
        settings.save()
        CompensationConfig.objects.filter(pk=1).update(windows_enabled=False)
        r = self.post(self.body)
        self.assertEqual((r.status_code, r.json()["code"]), (403, "feature_disabled"))
        self.assertIn("Settings > Compensation", r.json()["error"])
        self.assertEqual(self.delete(f"{WINDOWS}/{made['id']}").status_code, 403)
        self.assertEqual(self.get().status_code, 200)
        self.assertEqual(CompensationDayAnnouncement.objects.count(), 1)

    def test_permissions(self):
        made = self.announce()
        for who in (self.no_access,):
            for response in (self.get(who=who), self.post(self.body, who), self.delete(f"{WINDOWS}/{made['id']}", who)):
                self.assertEqual((response.status_code, response.json()["error"]), (403, "permission_denied"))
        self.assertEqual(self.get(who=self.view_only).status_code, 200)
        self.assertEqual(self.post(self.body, self.view_only).status_code, 403)
        self.assertEqual(self.delete(f"{WINDOWS}/{made['id']}", self.view_only).status_code, 403)
        employee = _bearer({"role": "employee", "employeeId": self.asha.id})
        self.assertEqual(self.get(who=employee).status_code, 403)
        self.assertEqual(self.client.get(WINDOWS).status_code, 401)


class DeleteTests(LeaveBase):
    def test_only_a_future_window_can_be_removed(self):
        future = self.announce(day=TOMORROW)
        today = self.announce(day=TODAY, at="09:30")
        self.assertEqual((future["canDelete"], today["canDelete"]), (True, False))
        r = self.delete(f"{WINDOWS}/{today['id']}")
        self.assertEqual((r.status_code, "today or a past date" in r.json()["error"]), (400, True))
        past = CompensationDayAnnouncement.objects.create(
            date=date(2026, 10, 1), kind="late_in", allowed_time=time(10, 0), reason="x"
        )
        self.assertEqual(self.delete(f"{WINDOWS}/{past.id}").status_code, 400)
        self.assertEqual(self.delete(f"{WINDOWS}/{future['id']}").status_code, 204)
        self.assertEqual(CompensationDayAnnouncement.objects.count(), 2)
        log = AuditLog.objects.get(module="compensation", action="delete", record_id=future["id"])
        self.assertEqual(log.old_values["time"], "10:30")

    def test_a_legacy_day_exemption_and_an_unknown_id_are_not_windows(self):
        legacy = CompensationDayAnnouncement.objects.create(date=date(2026, 10, 20), reason="Festival")
        self.assertEqual(self.delete(f"{WINDOWS}/{legacy.id}").status_code, 404)
        self.assertEqual(self.delete(f"{WINDOWS}/999999").status_code, 404)
        self.assertTrue(CompensationDayAnnouncement.objects.filter(pk=legacy.id).exists())

    def test_a_branch_scoped_user_cannot_remove_a_company_wide_window(self):
        company = self.announce(day=date(2026, 10, 16))
        mine = self.announce(day=date(2026, 10, 16), kind="early_out", at="16:00", who=self.ho_hr)
        theirs = self.announce(day=date(2026, 10, 17), branchId=self.u2.id)
        self.assertEqual(self.delete(f"{WINDOWS}/{company['id']}", self.ho_hr).status_code, 403)
        self.assertEqual(self.delete(f"{WINDOWS}/{theirs['id']}", self.ho_hr).status_code, 403)
        self.assertEqual(self.delete(f"{WINDOWS}/{mine['id']}", self.ho_hr).status_code, 204)
        self.assertEqual(self.delete(f"{WINDOWS}/{company['id']}").status_code, 204)  # unscoped HR can


class WindowListTests(LeaveBase):
    def test_the_list_shows_windows_newest_first_and_hides_the_legacy_kind_by_default(self):
        a = self.announce(day=date(2026, 10, 16), at="10:00")
        b = self.announce("early_out", day=date(2026, 10, 20), at="15:30")
        legacy = CompensationDayAnnouncement.objects.create(
            date=date(2026, 10, 18), reason="Festival", leave_until_time=time(13, 0)
        )
        body = self.get().json()
        self.assertEqual([w["id"] for w in body["results"]], [b["id"], a["id"]])
        self.assertEqual((body["count"], body["today"], body["enabled"]["canAnnounce"]), (2, "2026-10-14", True))
        everything = self.get(kind="all").json()["results"]
        self.assertEqual([w["id"] for w in everything], [b["id"], legacy.id, a["id"]])
        row = next(w for w in everything if w["id"] == legacy.id)
        self.assertEqual((row["kind"], row["time"], row["canDelete"]), ("day", "13:00", False))
        self.assertEqual([w["id"] for w in self.get(kind="early_out").json()["results"]], [b["id"]])
        self.assertEqual([w["id"] for w in self.get(kind="day").json()["results"]], [legacy.id])
        self.assertEqual(self.get(kind="nonsense").status_code, 400)

    def test_filters(self):
        self.announce(day=date(2026, 10, 16))
        CompensationDayAnnouncement.objects.create(
            date=date(2026, 9, 1), kind="late_in", allowed_time=time(10, 0), reason="Old"
        )
        self.assertEqual(self.get(month=10, year=2026).json()["count"], 1)
        self.assertEqual(self.get(month=9, year=2026).json()["count"], 1)
        self.assertEqual(self.get(date="2026-10-16").json()["count"], 1)
        self.assertEqual(self.get(upcoming=1).json()["count"], 1)
        self.assertEqual(self.get(date="nope").status_code, 400)
        self.assertEqual(self.get(limit=1).json()["truncated"], True)

    def test_covers_follows_the_scope(self):
        company = self.announce(day=date(2026, 10, 16))
        dept = self.announce(day=date(2026, 10, 17), branchId=self.ho.id, departmentId=self.cutting.id)
        listed = self.announce(day=date(2026, 10, 19), employeeIds=[self.asha.id, self.mani.id])
        self.assertEqual((company["covers"], dept["covers"], listed["covers"]), (3, 1, 2))
        self.assertEqual(
            (listed["employeeCount"], sorted(listed["employeeIds"])), (2, sorted([self.asha.id, self.mani.id]))
        )
        scoped = {w["id"]: w for w in self.get(who=self.ho_hr).json()["results"]}
        self.assertEqual(scoped[company["id"]]["covers"], 2)  # only their branch's staff are counted for them

    def test_a_branch_scoped_user_sees_their_branch_and_the_company_wide_ones(self):
        company = self.announce(day=date(2026, 10, 16))
        other_branch = self.announce(day=date(2026, 10, 17), branchId=self.u2.id)
        mani_only = self.announce(day=date(2026, 10, 19), employeeIds=[self.mani.id])
        mine = self.announce(day=date(2026, 10, 20), branchId=self.ho.id)
        seen = {w["id"] for w in self.get(who=self.ho_hr).json()["results"]}
        self.assertEqual(seen, {company["id"], mine["id"]})
        self.assertNotIn(other_branch["id"], seen)
        self.assertNotIn(mani_only["id"], seen)

    def test_the_list_is_bounded_whatever_the_number_of_windows(self):
        self.announce(day=date(2026, 10, 16))
        with CaptureQueriesContext(connection) as small:
            self.get()
        for day in range(17, 28):
            CompensationDayAnnouncement.objects.create(
                date=date(2026, 10, day), kind="late_in", allowed_time=time(10, 0), reason="x"
            )
        with CaptureQueriesContext(connection) as large:
            self.assertEqual(self.get().json()["count"], 12)
        self.assertEqual(len(large), len(small))


class LegacyRoutesTests(LeaveBase):
    def test_the_old_compensation_day_routes_keep_working(self):
        r = self.client.post(
            "/api/compensation/leave-days",
            {"date": "2030-01-15", "leaveUntilTime": "14:00", "reason": "Festival"},
            content_type="application/json",
            **self.admin,
        )
        self.assertEqual(r.status_code, 201, r.content)
        ann = CompensationDayAnnouncement.objects.get()
        self.assertEqual((ann.kind, ann.allowed_time, ann.leave_until_time), ("day", None, time(14, 0)))
        listed = self.client.get("/api/compensation/leave-days", **self.admin).json()
        self.assertEqual(listed["count"], 1)
        self.assertEqual(self.client.delete(f"/api/compensation/leave-days/{ann.id}", **self.admin).status_code, 204)

    def test_a_window_is_also_visible_in_the_old_list(self):
        made = self.announce(day=date(2026, 10, 30))
        old = self.client.get("/api/compensation/leave-days", **self.admin).json()["results"]
        self.assertEqual([w["id"] for w in old], [made["id"]])
        # the keys the old screen reads are all still there
        for key in (
            "id",
            "date",
            "leaveUntilTime",
            "branch",
            "department",
            "employeeIds",
            "employeeCount",
            "reason",
            "announcedBy",
        ):
            self.assertIn(key, old[0])


# ═════════════════════════════ the birthday list ═════════════════════════════


class BirthdayTests(LeaveBase):
    def setUp(self):
        super().setUp()
        self.asha.date_of_birth = date(1990, 10, 14)  # today
        self.asha.save()
        self.ravi.date_of_birth = date(1992, 10, 12)  # Monday of this week
        self.ravi.save()
        self.mani.date_of_birth = date(1988, 10, 18)  # Sunday of this week (a day off)
        self.mani.save()
        self.boss = _employee("WBB", self.ho, self.cutting, dob=date(1985, 10, 20))  # next week, this month
        self.prod.date_of_birth = date(1995, 10, 14)
        self.prod.save()
        self.gone.date_of_birth = date(1995, 10, 14)
        self.gone.save()
        _employee("WBN", self.ho, self.cutting)  # no date of birth at all

    def listing(self, period="today", day=None, who=None, **params):
        r = self.get(BIRTHDAYS, who, period=period, **({"date": day} if day else {}), **params)
        self.assertEqual(r.status_code, 200, r.content)
        return r.json()

    def codes(self, body):
        return [(r["employeeCode"], r["birthday"]) for r in body["results"]]

    def test_today_lists_only_todays_staff_birthdays(self):
        body = self.listing()
        self.assertEqual(self.codes(body), [("WB1", "2026-10-14")])  # no production, no inactive, no one without a date
        self.assertEqual(
            (body["period"], body["from"], body["to"], body["date"]),
            ("today", "2026-10-14", "2026-10-14", "2026-10-14"),
        )
        row = body["results"][0]
        self.assertEqual(
            (row["benefits"], row["reason"], row["weekday"], row["department"]), (True, None, "Wednesday", "WB Cutting")
        )
        self.assertEqual((body["count"], body["benefitCount"]), (1, 1))
        self.assertNotIn("dateOfBirth", row)  # the list shows the birthday, not the birth year

    def test_the_week_is_monday_to_sunday_and_a_sunday_birthday_does_not_benefit(self):
        body = self.listing("week")
        self.assertEqual((body["from"], body["to"]), ("2026-10-12", "2026-10-18"))
        self.assertEqual(self.codes(body), [("WB2", "2026-10-12"), ("WB1", "2026-10-14"), ("WB3", "2026-10-18")])
        sunday = body["results"][2]
        self.assertEqual((sunday["benefits"], sunday["weekday"]), (False, "Sunday"))
        self.assertIn("weekly off", sunday["reason"])
        self.assertEqual((body["count"], body["benefitCount"]), (3, 2))

    def test_the_week_edges(self):
        # Sunday 18 Oct belongs to the week that started on Monday 12 Oct; Monday 19 Oct starts the next one
        sunday = self.listing("week", "2026-10-18")
        self.assertEqual((sunday["from"], sunday["to"]), ("2026-10-12", "2026-10-18"))
        monday = self.listing("week", "2026-10-19")
        self.assertEqual((monday["from"], monday["to"]), ("2026-10-19", "2026-10-25"))
        self.assertEqual(self.codes(monday), [("WBB", "2026-10-20")])
        before = self.listing("week", "2026-10-11")  # Sunday 11 Oct: week of 5-11 Oct
        self.assertEqual(self.codes(before), [])

    def test_the_month_and_its_ends(self):
        body = self.listing("month")
        self.assertEqual((body["from"], body["to"]), ("2026-10-01", "2026-10-31"))
        self.assertEqual([c[0] for c in self.codes(body)], ["WB2", "WB1", "WB3", "WBB"])
        for day, expected in (
            ("2026-10-01", ("2026-10-01", "2026-10-31")),
            ("2026-10-31", ("2026-10-01", "2026-10-31")),
        ):
            edge = self.listing("month", day)
            self.assertEqual((edge["from"], edge["to"]), expected)
        _employee("WBE1", self.ho, self.cutting, dob=date(1990, 10, 31))
        _employee("WBE2", self.ho, self.cutting, dob=date(1990, 11, 1))
        _employee("WBE3", self.ho, self.cutting, dob=date(1990, 9, 30))
        codes = [c[0] for c in self.codes(self.listing("month"))]
        self.assertIn("WBE1", codes)
        self.assertNotIn("WBE2", codes)
        self.assertNotIn("WBE3", codes)

    def test_a_29_february_birthday_is_the_28th_in_a_year_without_one(self):
        leap = _employee("WBL", self.ho, self.cutting, dob=date(2000, 2, 29))
        body = self.listing("month", "2026-02-10")
        self.assertEqual(self.codes(body), [("WBL", "2026-02-28")])
        self.assertEqual(self.listing("today", "2026-02-28")["count"], 1)
        self.assertEqual(self.listing("today", "2026-03-01")["count"], 0)
        self.assertEqual(self.listing("today", "2026-02-27")["count"], 0)
        # in a leap year it is the 29th, and never also the 28th
        self.assertEqual(self.codes(self.listing("month", "2028-02-10")), [("WBL", "2028-02-29")])
        self.assertEqual(self.listing("today", "2028-02-28")["count"], 0)
        self.assertEqual(self.listing("today", "2028-02-29")["count"], 1)
        self.assertEqual(leap.employee_code, "WBL")

    def test_a_week_that_straddles_the_new_year(self):
        _employee("WBY1", self.ho, self.cutting, dob=date(1991, 12, 29))
        _employee("WBY2", self.ho, self.cutting, dob=date(1991, 1, 2))
        _employee("WBY3", self.ho, self.cutting, dob=date(1991, 1, 4))
        body = self.listing("week", "2026-12-31")
        self.assertEqual((body["from"], body["to"]), ("2026-12-28", "2027-01-03"))
        self.assertEqual(self.codes(body), [("WBY1", "2026-12-29"), ("WBY2", "2027-01-02")])

    def test_the_switches_decide_who_benefits_and_say_why_not(self):
        CompensationConfig.objects.filter(pk=1).update(birthday_enabled=False)
        row = self.listing()["results"][0]
        self.assertEqual(
            (row["benefits"], row["reason"]), (False, "Birthday leave is switched off in Settings > Compensation.")
        )
        self.assertFalse(self.listing()["enabled"]["birthday"])
        CompensationConfig.objects.filter(pk=1).update(
            birthday_enabled=True, birthday_effective_from=date(2026, 10, 15)
        )
        row = self.listing()["results"][0]
        self.assertEqual((row["benefits"], row["reason"]), (False, "Birthday leave only applies from 2026-10-15."))
        CompensationConfig.objects.filter(pk=1).update(birthday_effective_from=date(2026, 10, 14))
        self.assertTrue(self.listing()["results"][0]["benefits"])  # the effective date itself counts
        settings = PayrollSettings.get()
        settings.compensation_feature_enabled = False
        settings.save()
        row = self.listing()["results"][0]
        self.assertEqual((row["benefits"], "switched off in Settings > Payroll" in row["reason"]), (False, True))
        self.assertFalse(self.listing()["enabled"]["master"])

    def test_a_saturday_off_shift_and_a_birthday_before_joining_do_not_benefit(self):
        from .models import EmployeeShiftAssignment, ShiftTemplate

        shift = ShiftTemplate.objects.create(
            name="WB Day", shift_type="staff", start_time=time(9, 0), end_time=time(17, 30)
        )
        off = _employee("WBS1", self.ho, self.cutting, dob=date(1990, 10, 17))  # a Saturday this year
        working = _employee("WBS2", self.ho, self.cutting, dob=date(1990, 10, 17))
        EmployeeShiftAssignment.objects.create(
            employee=off, shift=shift, effective_from=date(2026, 1, 1), saturday_off=True
        )
        EmployeeShiftAssignment.objects.create(employee=working, shift=shift, effective_from=date(2026, 1, 1))
        rows = {r["employeeCode"]: r for r in self.listing("today", "2026-10-17")["results"]}
        self.assertEqual((rows["WBS1"]["benefits"], rows["WBS2"]["benefits"]), (False, True))
        self.assertIn("day off on this employee's shift", rows["WBS1"]["reason"])
        # an employee who joined after the birthday (this year) is not given the day either
        late = _employee("WBJ", self.ho, self.cutting, dob=date(1990, 10, 14))
        late.join_date = "2026-10-20"
        late.save()
        row = next(r for r in self.listing()["results"] if r["employeeCode"] == "WBJ")
        self.assertEqual((row["benefits"], "joined on 2026-10-20" in row["reason"]), (False, True))
        late.join_date = "20/10/2026"  # the other spellings of the join date are read too
        late.save()
        self.assertFalse(next(r for r in self.listing()["results"] if r["employeeCode"] == "WBJ")["benefits"])
        late.join_date = "2026-10-14"  # the joining day itself counts
        late.save()
        self.assertTrue(next(r for r in self.listing()["results"] if r["employeeCode"] == "WBJ")["benefits"])

    def test_a_declared_holiday_is_a_day_off_already(self):
        Holiday.objects.create(name="Local festival", date=date(2026, 10, 14))
        row = self.listing()["results"][0]
        self.assertEqual(
            (row["benefits"], row["reason"]),
            (False, "Local festival is a declared holiday, so the day is already off."),
        )

    def test_the_days_attendance_comes_from_its_stored_record(self):
        self.assertEqual(
            [self.listing()["results"][0][k] for k in ("attendanceStatus", "applied", "compensationKind")],
            [None, False, None],
        )
        AttendanceDayRecord.objects.create(
            employee=self.asha,
            date=TODAY,
            status="present",
            shifts_earned="1.00",
            first_punch=time(10, 40),
            last_punch=time(16, 0),
            compensation_kind="birthday",
        )
        row = self.listing()["results"][0]
        self.assertEqual(
            (row["attendanceStatus"], row["applied"], row["compensationKind"], row["firstPunch"], row["shiftsEarned"]),
            ("present", True, "birthday", "10:40", 1.0),
        )
        AttendanceDayRecord.objects.filter(employee=self.asha).update(
            compensation_kind="", status="absent", shifts_earned=0
        )
        row = self.listing()["results"][0]
        self.assertEqual((row["attendanceStatus"], row["applied"], row["compensationKind"]), ("absent", False, None))

    def test_filters_and_scope(self):
        week = self.listing("week", departmentId=self.finishing.id)
        self.assertEqual([c[0] for c in self.codes(week)], ["WB2"])
        self.assertEqual([c[0] for c in self.codes(self.listing("week", branchId=self.u2.id))], ["WB3"])
        scoped = self.listing("week", who=self.ho_hr)
        self.assertEqual([c[0] for c in self.codes(scoped)], ["WB2", "WB1"])  # Mani is in another branch
        # a scoped user asking for another branch gets nothing, not an error
        self.assertEqual(self.listing("week", who=self.ho_hr, branchId=self.u2.id)["count"], 0)

    def test_bad_parameters(self):
        self.assertEqual(self.get(BIRTHDAYS, period="year").status_code, 400)
        self.assertEqual(self.get(BIRTHDAYS, date="31/10/2026").status_code, 400)
        self.assertEqual(self.get(BIRTHDAYS, departmentId="x").status_code, 400)
        self.assertEqual(self.get(BIRTHDAYS, branchId="x").status_code, 400)

    def test_it_only_reads(self):
        before = (
            AttendanceDayRecord.objects.count(),
            Employee.objects.count(),
            CompensationDayAnnouncement.objects.count(),
        )
        self.listing("month")
        self.assertEqual(
            before,
            (
                AttendanceDayRecord.objects.count(),
                Employee.objects.count(),
                CompensationDayAnnouncement.objects.count(),
            ),
        )
        self.assertEqual(
            self.client.post(BIRTHDAYS, {}, content_type="application/json", **self.admin).status_code, 405
        )

    def test_permissions(self):
        self.assertEqual(self.get(BIRTHDAYS, self.no_access).status_code, 403)
        self.assertEqual(self.get(BIRTHDAYS, self.view_only).status_code, 200)
        self.assertEqual(self.client.get(BIRTHDAYS).status_code, 401)
        employee = _bearer({"role": "employee", "employeeId": self.asha.id})
        self.assertEqual(self.get(BIRTHDAYS, employee).status_code, 403)

    def test_a_large_company_is_a_fixed_number_of_queries(self):
        _employee("WBSAT", self.ho, self.cutting, dob=date(1990, 10, 17))  # a Saturday: the shift assignment is read
        with CaptureQueriesContext(connection) as small:
            self.listing("month")
        people = [
            Employee(
                employee_code=f"WBQ{i}",
                first_name="Q",
                last_name=str(i),
                employment_type="staff",
                status="active",
                branch=self.ho,
                department=self.cutting,
                date_of_birth=date(1990, 10, 1 + i % 28),
            )
            for i in range(250)
        ]
        Employee.objects.bulk_create(people)
        with CaptureQueriesContext(connection) as large:
            body = self.listing("month")
        self.assertEqual(body["count"], 255)
        self.assertEqual(len(large), len(small))
        self.assertLessEqual(len(large), 12)


# ═════════════════ the punch-based Attendance daily list ═════════════════


class DailyListTests(LeaveBase):
    """GET /api/attendance/daily lists punches, so a paid birthday leave / a relaxation day must not read as Absent."""

    DAILY = "/api/attendance/daily"

    def setUp(self):
        super().setUp()
        self.asha.date_of_birth = date(1990, 10, 14)  # today
        self.asha.save()

    def rows(self, day=TODAY, who=None):
        r = self.get(self.DAILY, who, date=day.isoformat())
        self.assertEqual(r.status_code, 200, r.content)
        return {row["employeeCode"]: row for row in r.json()}

    def punch(self, emp, *times, day=TODAY):
        for t in times:
            AttendanceLog.objects.create(employee=emp, date=day, punch_time=t, punch_type="IN", source="test")

    def test_a_birthday_without_punches_is_not_absent(self):
        rows = self.rows()
        asha = rows["WB1"]
        self.assertEqual((asha["status"], asha["compensationKind"], asha["totalPunches"]), ("on_leave", "birthday", 0))
        self.assertIn("Birthday", asha["compensationNote"])
        ravi = rows["WB2"]  # nobody else changes
        self.assertEqual((ravi["status"], ravi["compensationKind"], ravi["compensationNote"]), ("absent", None, None))
        for row in rows.values():  # one contract for every row
            self.assertIn("compensationKind", row)
            self.assertIn("compensationMinutes", row)
            self.assertIn("compensationNote", row)

    def test_a_birthday_with_punches_stays_present_and_keeps_the_marker(self):
        self.punch(self.asha, time(9, 40), time(18, 0))  # very late: no detection on a birthday
        row = self.rows()["WB1"]
        self.assertEqual((row["status"], row["compensationKind"], row["totalPunches"]), ("present", "birthday", 2))

    def test_the_switches_take_the_marker_away(self):
        CompensationConfig.objects.filter(pk=1).update(birthday_enabled=False)
        row = self.rows()["WB1"]
        self.assertEqual((row["status"], row["compensationKind"]), ("absent", None))
        CompensationConfig.objects.filter(pk=1).update(birthday_enabled=True)
        self.assertEqual(self.rows()["WB1"]["status"], "on_leave")
        settings = PayrollSettings.get()
        settings.compensation_feature_enabled = False
        settings.save()
        row = self.rows()["WB1"]
        self.assertEqual((row["status"], row["compensationKind"]), ("absent", None))

    def test_only_active_staff(self):
        self.prod.date_of_birth = date(1995, 10, 14)
        self.prod.save()
        rows = self.rows()
        self.assertEqual((rows["WBP"]["status"], rows["WBP"]["compensationKind"]), ("absent", None))
        self.assertNotIn("WBX", rows)  # inactive employees are not listed at all

    def test_a_birthday_on_an_approved_leave_day_stays_on_leave(self):
        LeaveRequest.objects.create(
            employee=self.asha, type="casual", start_date="2026-10-14", end_date="2026-10-14", status="approved"
        )
        row = self.rows()["WB1"]
        self.assertEqual((row["status"], row["compensationKind"]), ("on_leave", "birthday"))

    def test_a_relaxation_day_is_not_absent_either(self):
        OvertimeRecord.objects.create(
            employee=self.ravi,
            date=date(2026, 10, 9),
            last_punch_out=time(21, 0),
            ot_minutes=210,
            status="announced",
            compensation_type="relaxation",
            ot_type="shift",
            shifts=Decimal("0.50"),
            claim_date=TODAY,
        )
        row = self.rows()["WB2"]
        self.assertEqual((row["status"], row["compensationKind"]), ("on_leave", "relaxation"))
        self.assertIn("0.50 shift", row["compensationNote"])

    def test_only_the_affected_employees_go_through_the_day_engine(self):
        self.rows()
        self.assertEqual(
            list(AttendanceDayRecord.objects.filter(date=TODAY).values_list("employee__employee_code", flat=True)),
            ["WB1"],
        )

    def test_a_large_roster_is_a_fixed_number_of_queries(self):
        self.rows()  # the first call writes asha's day record; measure the steady state
        with CaptureQueriesContext(connection) as small:
            self.rows()
        Employee.objects.bulk_create(
            [
                Employee(
                    employee_code=f"WBD{i}",
                    first_name="D",
                    last_name=str(i),
                    employment_type="staff",
                    status="active",
                    branch=self.ho,
                    department=self.cutting,
                    date_of_birth=date(1990, 10, 1 + i % 13),
                )
                for i in range(250)
            ]
        )
        with CaptureQueriesContext(connection) as large:
            rows = self.rows()
        self.assertEqual(len(rows), 254)  # four active people + 250 (the inactive one is not listed)
        self.assertEqual(len(large), len(small))

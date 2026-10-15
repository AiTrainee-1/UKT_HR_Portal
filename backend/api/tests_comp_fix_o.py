"""Fixes of the adversarial review, group O: the OT detection write path, the legacy HR routes (branch scope, row locks,
no double spend of a legacy credit), bad input answered with a 400, and the additive `allowanceStatus` key.

Run via: python manage.py test api.tests_comp_fix_o -v 2

Same fixtures as tests_compensation_ot: shift 08:30-17:30, March 2026 (Monday 2 March is day one).
"""

from datetime import date, time
from decimal import Decimal
from unittest import mock

from django.db import IntegrityError, connection, transaction
from django.test.utils import CaptureQueriesContext

from . import overtime
from . import tests_compensation_engine as base
from . import tests_compensation_ot as ot
from . import tests_employee_compensation as ec
from . import tests_holiday_work as hw
from .models import (
    AttendanceDayRecord,
    AttendanceLog,
    AuditLog,
    Branch,
    CompensationConfig,
    CompensationDayAnnouncement,
    CompensationLeaveCredit,
    CompensationLedger,
    Employee,
    EmployeeShiftAssignment,
    HolidayWorkClaim,
    HRUser,
    OvertimeRecord,
    PayrollSettings,
    Role,
)
from .overtime import detect_overtime_for_month

MON, TUE, WED, THU, FRI = base.MON, base.TUE, base.WED, base.THU, base.FRI


def writes(captured) -> list[str]:
    """The INSERT / UPDATE / DELETE statements among the captured queries."""
    return [q["sql"] for q in captured if q["sql"].lstrip().upper().startswith(("INSERT", "UPDATE", "DELETE"))]


# ── detection: a read never overwrites what HR decided ──────────────────────


class DetectionWritePathTests(ot.OtBase):
    def test_a_second_pass_writes_nothing(self):
        self.candidate(time(21, 30))
        self.worked(TUE, time(18, 30))
        self.rec(TUE)
        self.get_list()
        with CaptureQueriesContext(connection) as ctx:
            detect_overtime_for_month(2026, 3)
            self.get_list()
        self.assertEqual(writes(ctx.captured_queries), [])

    def test_an_assignment_made_after_the_snapshot_is_never_overwritten(self):
        rec = self.candidate(time(21, 30))
        self.worked(MON, time(23, 0))  # the day changed, so the pass wants to refresh the row
        self.rec(MON)
        real = overtime._snapshot

        def snapshot_then_hr_assigns(*args, **kwargs):
            snap = real(*args, **kwargs)  # the pass has read the row as "detected" ...
            self.assertEqual(
                self.assign([self.item(shifts=0.5, claimDate=str(THU))]).status_code, 200
            )  # ... and HR decides
            return snap

        with mock.patch("api.overtime._snapshot", side_effect=snapshot_then_hr_assigns):
            detect_overtime_for_month(2026, 3)
        rec.refresh_from_db()
        self.assertEqual(
            (rec.status, rec.compensation_type, str(rec.shifts), rec.claim_date),
            ("announced", "relaxation", "0.50", THU),
        )
        self.assertEqual(rec.ot_minutes, 240)  # the decided row is exactly as HR left it

    def test_a_rejection_made_after_the_snapshot_is_never_reverted(self):
        rec = self.candidate(time(21, 30))
        self.worked(MON, time(23, 0))
        self.rec(MON)
        real = overtime._snapshot

        def snapshot_then_hr_rejects(*args, **kwargs):
            snap = real(*args, **kwargs)
            self.assertEqual(self.post("/ot/reject", {"records": [self.item()]}).json(), {"rejected": 1})
            return snap

        with mock.patch("api.overtime._snapshot", side_effect=snapshot_then_hr_rejects):
            detect_overtime_for_month(2026, 3)
        rec.refresh_from_db()
        self.assertEqual(rec.status, "rejected")

    def test_a_candidate_assigned_after_the_snapshot_is_not_deleted_as_stale(self):
        rec = self.candidate(time(21, 30))
        self.worked(MON, time(17, 0))  # the day no longer qualifies: the undecided row is stale
        self.rec(MON)
        real = overtime._snapshot

        def snapshot_then_hr_assigns(*args, **kwargs):
            snap = real(*args, **kwargs)
            self.assertEqual(self.assign([self.item(shifts=0.5, claimDate=str(THU))]).status_code, 200)
            return snap

        with mock.patch("api.overtime._snapshot", side_effect=snapshot_then_hr_assigns):
            detect_overtime_for_month(2026, 3)
        rec.refresh_from_db()  # still there, still assigned
        self.assertEqual(rec.status, "announced")

    def test_two_first_passes_do_not_collide_on_the_same_day(self):
        self.candidate(time(21, 30))
        with mock.patch(
            "api.overtime._snapshot", return_value={}
        ):  # a pass that has not seen the row another just made
            detect_overtime_for_month(2026, 3)
        self.assertEqual(OvertimeRecord.objects.filter(employee=self.emp, date=MON).count(), 1)

    def test_a_view_only_role_reads_and_writes_nothing(self):
        self.worked(MON, time(21, 30))
        self.rec(MON)
        role = Role.objects.create(name="Comp Viewer", permissions={"compensation": "view"})
        user = HRUser.objects.create(username="cv_o", password_hash="x", role=role)
        viewer = base.bearer({"role": "hr", "hrUserId": user.id, "name": "Viewer"})
        body = self.client.get(ot.LIST, {"month": 3, "year": 2026}, **viewer)
        self.assertEqual((body.status_code, body.json()["results"]), (200, []))
        self.assertEqual(OvertimeRecord.objects.count(), 0)
        self.assertEqual(self.get_list().json()["count"], 1)  # an editor's visit brings the rows up to date
        self.assertEqual(self.client.get(ot.LIST, {"month": 3, "year": 2026}, **viewer).json()["count"], 1)

    def test_the_old_private_helper_is_still_importable(self):
        from api.overtime import _ot_minutes_for  # the md_demo generator imports it

        self.assertEqual(_ot_minutes_for(time(19, 30), time(17, 30)), 120)


# ── detection runs without anybody opening the OT page ──────────────────────


class ScheduledAndLazyDetectionTests(ot.OtBase):
    def test_the_scheduled_pass_re_derives_the_day_and_creates_the_rows(self):
        self.worked(MON, time(21, 30))  # punches only: nobody opened an attendance page, so there is no stored day yet
        self.assertFalse(AttendanceDayRecord.objects.filter(employee=self.emp).exists())
        first = overtime.run_detection_job(today=TUE)
        self.assertEqual((first["skipped"], first["recomputed"], first["created"]), (False, 1, 1))
        row = self.rec_of(self.CODE, MON)
        self.assertEqual((row.ot_type, row.status, str(row.suggested_shifts)), ("shift", "detected", "0.50"))
        again = overtime.run_detection_job(today=TUE)  # nothing new: nothing recomputed, nothing written
        self.assertEqual((again["recomputed"], again["created"], again["updated"], again["deleted"]), (0, 0, 0, 0))

    def test_a_late_punch_after_the_day_was_computed_is_picked_up(self):
        self.worked(MON, time(17, 40))
        self.rec(MON)
        self.assertEqual(OvertimeRecord.objects.count(), 0)
        self.worked(MON, time(19, 0))  # the evening punches arrive after the stored day was last computed
        result = overtime.run_detection_job(today=TUE)
        self.assertEqual(result["recomputed"], 1)
        self.assertEqual(self.rec_of(self.CODE, MON).ot_type, "allowance")

    def test_the_scheduled_pass_does_nothing_while_the_switches_are_off(self):
        self.worked(MON, time(21, 30))
        ps = PayrollSettings.get()
        ps.compensation_feature_enabled = False
        ps.save()
        self.assertEqual(overtime.run_detection_job(today=TUE), {"skipped": True})
        ps.compensation_feature_enabled = True
        ps.save()
        base.set_config(allowance_enabled=False, shift_enabled=False)
        self.assertEqual(overtime.run_detection_job(today=TUE), {"skipped": True})
        self.assertFalse(AttendanceDayRecord.objects.exists())
        self.assertEqual(OvertimeRecord.objects.count(), 0)

    def test_the_employees_own_refresh_creates_only_their_rows_and_prunes_nothing(self):
        other = self.new_staff("OT9")
        self.worked(MON, time(21, 30))
        self.worked(MON, time(21, 30), emp=other)
        stale = OvertimeRecord.objects.create(
            employee=self.emp,
            date=TUE,
            last_punch_out=time(19, 0),
            ot_minutes=90,
            status="auto",
            ot_type="allowance",
            allowance_minutes=30,
        )  # no stored day behind it: the scheduled pass would prune it, the employee's own refresh must not
        result = overtime.refresh_employee_overtime(self.emp, today=TUE)
        self.assertEqual((result.created, result.deleted), (1, 0))
        self.assertTrue(OvertimeRecord.objects.filter(employee=self.emp, date=MON).exists())
        self.assertFalse(OvertimeRecord.objects.filter(employee=other).exists())
        self.assertTrue(OvertimeRecord.objects.filter(pk=stale.pk).exists())


# ── legacy routes go through the same gates as the new ones ─────────────────


class LegacyRouteTests(ot.OtBase):
    def legacy_credit(self, emp=None):
        emp = emp or self.emp
        record = OvertimeRecord.objects.create(
            employee=emp,
            date=WED,
            last_punch_out=time(20, 0),
            ot_minutes=150,
            status="announced",
            compensation_type="relaxation",
        )
        return CompensationLeaveCredit.objects.create(employee=emp, source_overtime_record=record)

    def redeem_credit(self, credit, d, headers=None):
        return self.client.post(
            f"/api/compensation/credits/{credit.id}/redeem",
            {"date": str(d)},
            content_type="application/json",
            **(headers or self.headers),
        )

    def test_a_branch_login_cannot_announce_reject_or_redeem_another_branchs_records(self):
        north, south = Branch.objects.create(name="North", code="N"), Branch.objects.create(name="South", code="S")
        a = self.new_staff("AN1", branch=north)
        self.candidate(time(22, 0), emp=a)
        credit = self.legacy_credit(a)
        other = ot.branch_login(south)
        records = [self.item(emp=a)]
        self.assertEqual(
            self.post("/ot/announce", {"records": records, "compensationType": "pay"}, other).json()["announced"], 0
        )
        self.assertEqual(self.post("/ot/reject", {"records": records}, other).json(), {"rejected": 0})
        self.assertEqual(self.redeem_credit(credit, THU, other).status_code, 404)
        credit.refresh_from_db()
        self.assertEqual(credit.status, "available")
        self.assertEqual(self.rec_of("AN1", MON).status, "detected")
        own = ot.branch_login(north)  # the owner branch may do all three
        self.assertEqual(
            self.post("/ot/announce", {"records": records, "compensationType": "pay"}, own).json()["announced"], 1
        )
        self.assertEqual(self.redeem_credit(credit, THU, own).status_code, 200)

    def test_announce_needs_type_2_switched_on_for_a_type_2_record(self):
        self.candidate(time(21, 30))
        base.set_config(shift_enabled=False)
        r = self.post("/ot/announce", {"records": [self.item()], "compensationType": "pay"})
        self.assertEqual(r.json()["announced"], 0)
        self.assertEqual(self.rec_of(self.CODE, MON).status, "detected")
        base.set_config(shift_enabled=True)
        self.assertEqual(
            self.post("/ot/announce", {"records": [self.item()], "compensationType": "pay"}).json()["announced"], 1
        )

    def test_announce_and_reject_are_audited_record_by_record(self):
        self.candidate(time(21, 30))
        self.candidate(time(22, 0), d=TUE)
        self.post("/ot/announce", {"records": [self.item()], "compensationType": "pay"})
        self.post("/ot/reject", {"records": [self.item(d=TUE)]})
        announce = AuditLog.objects.get(action="announce", module="compensation")
        reject = AuditLog.objects.get(action="reject", module="compensation")
        self.assertEqual(
            (announce.record_id, reject.record_id), (self.rec_of(self.CODE, MON).id, self.rec_of(self.CODE, TUE).id)
        )
        self.assertIn(self.CODE, announce.record_description)
        self.assertEqual(announce.new_values["date"], str(MON))

    def test_a_legacy_credit_cannot_be_spent_twice(self):
        credit = self.legacy_credit()
        spent = self.client.post(
            "/api/compensation/balance/redeem",
            {"employeeId": self.emp.id, "date": str(THU), "shifts": 1},
            content_type="application/json",
            **self.headers,
        )
        self.assertEqual(
            spent.status_code, 201, spent.content
        )  # the balance redemption took the shift the credit counts for
        again = self.redeem_credit(credit, FRI)
        self.assertEqual(again.status_code, 400)
        self.assertIn("no longer be redeemed", again.json()["error"])
        credit.refresh_from_db()
        self.assertEqual(credit.status, "available")
        self.assertFalse(AttendanceDayRecord.objects.filter(employee=self.emp, date=FRI, source="manual").exists())
        self.assertEqual(CompensationLedger.objects.filter(source="legacy_credit").count(), 0)

    def test_a_legacy_credit_of_a_production_employee_is_refused(self):
        prod = Employee.objects.create(
            employee_code="PRO7", first_name="Pro", last_name="Duction", employment_type="production", status="active"
        )
        credit = self.legacy_credit(prod)
        r = self.redeem_credit(credit, THU)
        self.assertEqual(r.status_code, 400)
        self.assertIn("staff employees only", r.json()["error"])
        credit.refresh_from_db()
        self.assertEqual(credit.status, "available")


# ── bad input is a 400, never a crash ───────────────────────────────────────


class BadInputTests(ot.OtBase):
    def test_assign_skips_ids_that_are_not_numbers(self):
        self.candidate(time(21, 30))
        r = self.assign(
            [{"employeeId": [1], "date": str(MON)}, {"employeeId": {"a": 1}, "date": str(MON)}, "x"], mode="pay"
        )
        self.assertEqual(r.status_code, 400)
        self.assertEqual(len(r.json()["skipped"]), 3)

    def test_assign_takes_a_bounded_number_of_records(self):
        r = self.assign([{"employeeId": 1, "date": str(MON)}] * 201, mode="pay")
        self.assertEqual(r.status_code, 400)
        self.assertIn("At most 200", r.json()["error"])

    def test_the_balance_and_credit_lists_refuse_an_id_that_is_not_a_number(self):
        for bad in ("abc", "1e999", "99999999999999999999999"):
            for path in ("/api/compensation/balance", "/api/compensation/credits"):
                r = self.client.get(path, {"employeeId": bad}, **self.headers)
                self.assertEqual(r.status_code, 400, (path, bad))

    def test_a_redemption_with_a_bad_employee_id_is_a_400(self):
        for body in (
            '{"employeeId": "abc", "date": "2026-03-05", "shifts": 1}',
            '{"employeeId": [1], "date": "2026-03-05", "shifts": 1}',
            '{"employeeId": 1e999, "date": "2026-03-05", "shifts": 1}',
        ):
            r = self.client.post(
                "/api/compensation/balance/redeem", body, content_type="application/json", **self.headers
            )
            self.assertEqual(r.status_code, 400, body)
        r = self.client.post("/api/compensation/balance/redeem", "[1]", content_type="application/json", **self.headers)
        self.assertEqual(r.status_code, 404)

    def test_the_ot_list_refuses_a_year_the_calendar_cannot_hold(self):
        for year in (0, 99999, 1999, 2101):
            self.assertEqual(self.get_list(year=year).status_code, 400, year)

    def test_announce_and_reject_ignore_a_bad_date_or_item(self):
        junk = [{"employeeId": self.emp.id, "date": "abc"}, "x", 5, {"employeeId": "abc", "date": str(MON)}]
        self.assertEqual(self.post("/ot/announce", {"records": junk}).json()["announced"], 0)
        self.assertEqual(self.post("/ot/reject", {"records": junk}).json(), {"rejected": 0})
        self.assertEqual(self.post("/ot/announce", {"records": "x"}).status_code, 400)
        self.assertEqual(self.post("/ot/reject", {"records": "x"}).status_code, 400)

    def test_a_credit_redemption_with_a_bad_date_is_a_400(self):
        record = OvertimeRecord.objects.create(
            employee=self.emp,
            date=MON,
            last_punch_out=time(20, 0),
            ot_minutes=150,
            status="announced",
            compensation_type="relaxation",
        )
        credit = CompensationLeaveCredit.objects.create(employee=self.emp, source_overtime_record=record)
        r = self.client.post(
            f"/api/compensation/credits/{credit.id}/redeem",
            {"date": "abc"},
            content_type="application/json",
            **self.headers,
        )
        self.assertEqual(r.status_code, 400)


# ── the additive `allowanceStatus` key of the OT list ───────────────────────


class AllowanceStatusTests(ot.OtBase):
    def test_used_not_used_and_pending(self):
        self.worked(MON, time(18, 30))  # 60 minutes: a Type 1 row, allowance 30
        self.worked(TUE, time(17, 40), first=time(9, 5))  # arrives inside the allowance
        self.rec(MON)
        self.rec(TUE)
        row = self.rows()[(self.CODE, str(MON))]
        self.assertEqual((row["allowanceUsed"], row["allowanceStatus"]), (True, "used"))
        self.worked(TUE, time(17, 40), first=time(8, 35))  # on time: the allowance is not needed
        self.rec(TUE)
        row = self.rows()[(self.CODE, str(MON))]
        self.assertEqual((row["allowanceUsed"], row["allowanceStatus"]), (False, "not_used"))
        with mock.patch("api.compensation_views.ist_today", return_value=MON):  # Tuesday has not come yet
            row = self.rows()[(self.CODE, str(MON))]
        self.assertEqual((row["allowanceUsed"], row["allowanceStatus"]), (False, "pending"))

    def test_other_rows_carry_no_allowance_status(self):
        self.candidate(time(21, 30))
        row = self.rows()[(self.CODE, str(MON))]
        self.assertEqual((row["otType"], row["allowanceUsed"], row["allowanceStatus"]), ("shift", None, None))

    def test_a_window_that_won_the_day_does_not_hide_the_use_of_the_allowance(self):
        self.worked(MON, time(18, 30))  # allowance 30 minutes
        self.announce(TUE, "late_in", time(10, 0))  # the window's marker outranks the allowance's on that day
        base.set_config(windows_enabled=True)
        self.worked(TUE, time(17, 40), first=time(10, 20))
        self.rec(MON)
        self.rec(TUE)
        row = self.rows()[(self.CODE, str(MON))]
        self.assertEqual((row["allowanceUsed"], row["allowanceStatus"]), (True, "used"))


# ── the legacy /leave-days routes go through the windows rules ───────────────


class LegacyLeaveDayTests(ot.OtBase):
    def setUp(self):
        super().setUp()
        patcher = mock.patch("api.compensation_views.ist_today", return_value=MON)
        patcher.start()
        self.addCleanup(patcher.stop)
        self.north = Branch.objects.create(name="North", code="N")
        self.south = Branch.objects.create(name="South", code="S")

    def delete(self, ann, headers=None):
        return self.client.delete(f"/api/compensation/leave-days/{ann.id}", **(headers or self.headers))

    def create(self, body, headers=None):
        return self.client.post(
            "/api/compensation/leave-days", body, content_type="application/json", **(headers or self.headers)
        )

    def test_a_branch_login_cannot_remove_a_company_wide_or_another_branchs_announcement(self):
        company = CompensationDayAnnouncement.objects.create(date=TUE, reason="All")
        theirs = CompensationDayAnnouncement.objects.create(date=TUE, reason="South", branch=self.south)
        north = ot.branch_login(self.north)
        south = ot.branch_login(self.south)
        self.assertEqual(self.delete(company, south).status_code, 403)
        self.assertEqual(self.delete(theirs, north).status_code, 403)
        self.assertEqual(CompensationDayAnnouncement.objects.count(), 2)
        self.assertEqual(self.delete(theirs, south).status_code, 204)
        self.assertEqual(self.delete(company).status_code, 204)  # an unscoped login may remove a company-wide one

    def test_a_window_is_removed_at_the_windows_route_not_here(self):
        window = CompensationDayAnnouncement.objects.create(
            date=TUE, kind="late_in", allowed_time=time(10, 0), reason="x"
        )
        r = self.delete(window)
        self.assertEqual(r.status_code, 404)
        self.assertIn("/api/compensation/windows", r.json()["error"])
        self.assertTrue(CompensationDayAnnouncement.objects.filter(pk=window.pk).exists())

    def test_todays_announcement_cannot_be_removed_by_indias_calendar(self):
        today = CompensationDayAnnouncement.objects.create(date=MON, reason="Today")
        self.assertEqual(self.delete(today).status_code, 400)
        later = CompensationDayAnnouncement.objects.create(date=TUE, reason="Tomorrow")
        self.assertEqual(self.delete(later).status_code, 204)

    def test_a_branch_login_creates_a_branch_announcement_never_a_company_wide_one(self):
        north = ot.branch_login(self.north)
        r = self.create({"date": str(TUE), "reason": "Festival"}, north)
        self.assertEqual(r.status_code, 201, r.content)
        self.assertEqual(CompensationDayAnnouncement.objects.get().branch_id, self.north.id)
        r = self.create({"date": str(TUE), "branchId": self.south.id}, north)
        self.assertEqual(r.status_code, 403)

    def test_an_unknown_employee_is_a_400_and_leaves_no_row_behind(self):
        r = self.create({"date": str(TUE), "employeeIds": [999999]})
        self.assertEqual(r.status_code, 400)
        self.assertEqual(CompensationDayAnnouncement.objects.count(), 0)  # an empty list would mean "everybody"
        prod = Employee.objects.create(
            employee_code="PRO8", first_name="Pro", last_name="Duction", employment_type="production", status="active"
        )
        self.assertEqual(self.create({"date": str(TUE), "employeeIds": [prod.id]}).status_code, 400)
        self.assertEqual(self.create({"date": str(TUE), "employeeIds": [self.emp.id]}).status_code, 201)

    def test_bad_dates_and_times_are_a_400(self):
        self.assertEqual(self.create({"date": "abc"}).status_code, 400)
        self.assertEqual(self.create({"date": str(TUE), "leaveUntilTime": "late"}).status_code, 400)
        self.assertEqual(self.create({"date": str(TUE), "branchId": "x"}).status_code, 400)
        self.assertEqual(self.create({"date": str(TUE), "leaveUntilTime": "16:00"}).status_code, 201)

    def test_the_list_shows_a_branch_login_its_own_and_the_company_wide_ones(self):
        CompensationDayAnnouncement.objects.create(date=TUE, reason="All")
        CompensationDayAnnouncement.objects.create(date=TUE, reason="North", branch=self.north)
        CompensationDayAnnouncement.objects.create(date=TUE, reason="South", branch=self.south)
        r = self.client.get("/api/compensation/leave-days", **ot.branch_login(self.north))
        self.assertEqual(sorted(a["reason"] for a in r.json()["results"]), ["All", "North"])
        self.assertEqual(len(self.client.get("/api/compensation/leave-days", **self.headers).json()["results"]), 3)
        self.assertEqual(
            self.client.get("/api/compensation/leave-days", {"year": "abc"}, **self.headers).status_code, 400
        )


# ── Settings -> Compensation: the save, the audit trail, the warnings ───────


class SettingsFixTests(base.CompBase):
    CODE = "SF1"
    URL = "/api/compensation/settings"
    TODAY = date(2026, 10, 14)

    def setUp(self):
        super().setUp()
        self.headers = base.hr_headers()
        patcher = mock.patch("api.compensation_settings_views.ist_today", return_value=self.TODAY)
        patcher.start()
        self.addCleanup(patcher.stop)

    def put(self, body):
        return self.client.put(self.URL, body, content_type="application/json", **self.headers)

    def test_updated_at_is_null_until_somebody_saves(self):
        body = self.client.get(self.URL, **self.headers).json()
        self.assertEqual((body["updatedBy"], body["updatedAt"]), (None, None))
        self.put({"windows": {"enabled": True}})
        body = self.client.get(self.URL, **self.headers).json()
        self.assertEqual(body["updatedBy"], "Asha HR")
        self.assertIsNotNone(body["updatedAt"])

    def test_an_allowance_threshold_the_column_cannot_hold_is_a_400(self):
        rule = {"label": "x", "enabled": True, "minExtraMinutes": 3000000000, "allowanceMinutes": 30}
        r = self.put({"allowanceRules": [rule]})
        self.assertEqual(r.status_code, 400)
        self.assertIn("at most 1440", r.json()["error"])
        for body in (
            '{"allowanceRules": [{"enabled": true, "minExtraMinutes": 1e999, "allowanceMinutes": 30}]}',
            '{"allowanceRules": [{"enabled": true, "minExtraMinutes": 60, "allowanceMinutes": 1e999}]}',
            '{"shiftRules": [{"untilMinutes": 1e999, "shifts": 1}]}',
            '{"shift": {"minExtraMinutes": 1e999}}',
        ):
            r = self.client.put(self.URL, body, content_type="application/json", **self.headers)
            self.assertEqual(r.status_code, 400, body)
        self.assertEqual(self.put({"allowanceRules": [{**rule, "minExtraMinutes": 1440}]}).status_code, 200)

    def test_a_rules_only_save_keeps_the_old_and_the_new_table_in_the_audit_trail(self):
        two_hours = CompensationConfig.objects.first() and base.CompensationRule.objects.get(
            kind="allowance", min_extra_minutes=120
        )
        rows = [
            {
                "id": r.id,
                "label": r.label,
                "enabled": r.enabled,
                "minExtraMinutes": r.min_extra_minutes,
                "allowanceMinutes": 240 if r.id == two_hours.id else r.allowance_minutes,
            }
            for r in base.CompensationRule.objects.filter(kind="allowance").order_by("sort_order", "id")
        ]
        self.assertEqual(self.put({"allowanceRules": rows}).status_code, 200)
        log = AuditLog.objects.filter(module="compensation_settings").latest("id")
        old = {r["id"]: r for r in log.old_values["allowanceRules"]}
        new = {r["id"]: r for r in log.new_values["allowanceRules"]}
        self.assertEqual((old[two_hours.id]["allowanceMinutes"], new[two_hours.id]["allowanceMinutes"]), (60, 240))
        self.assertNotIn("shiftRules", log.new_values)  # only the table that changed

    def test_the_settings_row_is_read_for_update_so_two_saves_cannot_undo_each_other(self):
        with CaptureQueriesContext(connection) as ctx:
            self.put({"windows": {"enabled": True}})
        locked = [
            q["sql"] for q in ctx.captured_queries if "FOR UPDATE" in q["sql"] and "compensation_config" in q["sql"]
        ]
        self.assertTrue(locked)
        # a save that read the row before another one committed must not write that old copy back
        stale = CompensationConfig.objects.get(pk=1)
        CompensationConfig.objects.filter(pk=1).update(birthday_enabled=True, birthday_effective_from=self.TODAY)
        with mock.patch.object(CompensationConfig, "get", return_value=stale):
            self.assertEqual(self.put({"holidayWork": {"enabled": True}}).status_code, 200)
        config = CompensationConfig.objects.get(pk=1)
        self.assertEqual((config.birthday_enabled, config.holiday_work_enabled), (True, True))

    def test_switching_off_and_on_again_warns_what_it_does_to_days_already_judged(self):
        r = self.put({"birthday": {"enabled": True, "effectiveFrom": "2026-03-01"}})
        self.assertEqual(r.json()["warnings"], [])
        r = self.put({"birthday": {"enabled": False}})
        self.assertIn("switched off", r.json()["warnings"][0])
        r = self.put({"birthday": {"enabled": True}})
        self.assertIn("was on before, from 2026-03-01", r.json()["warnings"][0])
        r = self.put({"birthday": {"enabled": False}})
        r = self.put({"birthday": {"enabled": True, "effectiveFrom": "2026-03-01"}})  # naming the date keeps the days
        self.assertEqual(r.json()["warnings"], [])
        self.assertIn(
            "switched off",
            self.put({"windows": {"enabled": True}})
            and self.put({"windows": {"enabled": False}}).json()["warnings"][0],
        )


# ── holiday-work: the any-month list, the database's own guards, the audit trail ──


class HolidayWorkFixTests(hw.HolidayWorkBase):
    def test_pending_claims_of_any_month_can_be_listed(self):
        now = self.raise_claim(self.asha, hw.SUNDAY)
        older = HolidayWorkClaim.objects.create(
            employee=self.ravi, work_date=date(2026, 9, 6), shifts=Decimal("0.50"), reason="x", approval_trail=[]
        )
        done = HolidayWorkClaim.objects.create(
            employee=self.ravi, work_date=date(2026, 8, 2), shifts=Decimal("1.00"), status="approved", approval_trail=[]
        )
        default = self.get().json()
        self.assertEqual([c["id"] for c in default["results"]], [now.id])  # unchanged: this month only
        self.assertEqual((default["month"], default["year"]), (10, 2026))
        every = self.get(status="pending", anyMonth="1").json()
        self.assertEqual({c["id"] for c in every["results"]}, {now.id, older.id})
        self.assertEqual((every["month"], every["year"], every["count"]), (None, None, 2))
        self.assertEqual(every["summary"]["pending"], 2)
        self.assertEqual(done.id in {c["id"] for c in self.get(anyMonth="1").json()["results"]}, True)
        # an explicit month still wins over anyMonth
        self.assertEqual(
            [c["id"] for c in self.get(status="pending", anyMonth="1", month=9, year=2026).json()["results"]],
            [older.id],
        )

    def test_the_database_refuses_a_second_open_claim_and_a_second_credit(self):
        claim = self.raise_claim(self.asha, hw.SUNDAY)
        with self.assertRaises(IntegrityError), transaction.atomic():
            HolidayWorkClaim.objects.create(
                employee=self.asha, work_date=hw.SUNDAY, shifts=Decimal("0.25"), approval_trail=[]
            )
        HolidayWorkClaim.objects.create(
            employee=self.asha, work_date=hw.SUNDAY, shifts=Decimal("0.25"), status="rejected", approval_trail=[]
        )  # a rejected one can sit beside it
        CompensationLedger.objects.create(
            employee=self.asha,
            entry_type="credit",
            shifts=Decimal("0.50"),
            date=hw.SUNDAY,
            source="holiday_work",
            claim=claim,
        )
        with self.assertRaises(IntegrityError), transaction.atomic():
            CompensationLedger.objects.create(
                employee=self.asha,
                entry_type="credit",
                shifts=Decimal("0.50"),
                date=hw.SUNDAY,
                source="holiday_work",
                claim=claim,
            )
        record = OvertimeRecord.objects.create(
            employee=self.asha, date=hw.SUNDAY, last_punch_out=time(20, 0), ot_minutes=150, status="announced"
        )
        CompensationLedger.objects.create(
            employee=self.asha,
            entry_type="credit",
            shifts=Decimal("0.50"),
            date=hw.SUNDAY,
            source="ot_shift",
            overtime_record=record,
        )
        with self.assertRaises(IntegrityError), transaction.atomic():
            CompensationLedger.objects.create(
                employee=self.asha,
                entry_type="credit",
                shifts=Decimal("0.50"),
                date=hw.SUNDAY,
                source="ot_shift",
                overtime_record=record,
            )

    def test_a_clash_the_checks_missed_is_a_400_and_raises_nothing(self):
        self.raise_claim(self.asha, hw.SUNDAY)
        with mock.patch("api.holiday_work_views.open_claims", return_value={}):  # the checks do not see the open claim
            r = self.post(
                {"employeeId": self.asha.id, "workDate": hw.SUNDAY.isoformat(), "shifts": 1, "reason": "again"}
            )
        self.assertEqual(r.status_code, 400)
        self.assertIn("already has a claim", r.json()["error"])
        self.assertEqual(HolidayWorkClaim.objects.count(), 1)

    def test_an_employee_id_of_infinity_is_a_400(self):
        for body in (
            '{"employeeId": 1e999, "workDate": "2026-10-11", "shifts": 1, "reason": "x"}',
            '{"employeeIds": [1e999], "workDate": "2026-10-11", "shifts": 1, "reason": "x"}',
            '{"items": [{"employeeId": 1e999}], "workDate": "2026-10-11", "shifts": 1, "reason": "x"}',
        ):
            r = self.client.post(hw.BASE, body, content_type="application/json", **self.admin)
            self.assertEqual(r.status_code, 400, body)

    def test_the_department_heads_decision_is_in_the_audit_trail(self):
        claim = self.raise_claim(self.asha, hw.SUNDAY, shifts=0.5)
        self.assertEqual(self.patch_hod(claim.id, {"status": "approved"}).status_code, 200)
        log = AuditLog.objects.get(action="approve", module="compensation")
        entry = CompensationLedger.objects.get(claim=claim)
        self.assertEqual((log.record_id, log.user_type), (claim.id, "employee"))
        self.assertEqual((log.new_values["ledgerEntryId"], log.new_values["status"]), (entry.id, "approved"))
        self.assertIn("added to the compensation balance", log.record_description)
        other = self.raise_claim(self.ravi, hw.SUNDAY, shifts=1)
        self.patch_hod(other.id, {"status": "rejected", "comment": "No"})
        self.assertEqual(AuditLog.objects.filter(action="reject", module="compensation", record_id=other.id).count(), 1)


# ── the employee's own page keeps their OT rows in step ─────────────────────


class EmployeeRefreshTests(ec.EmployeeBase):
    def test_the_employee_sees_their_own_overtime_without_hr_opening_anything(self):
        base.seed_default_rules()
        EmployeeShiftAssignment.objects.create(
            employee=self.asha, shift=base.make_shift(), effective_from=date(2026, 1, 1)
        )
        yesterday = date(2026, 10, 13)
        for t in (time(8, 25), time(13, 0), time(14, 0), time(19, 0)):
            AttendanceLog.objects.create(
                employee=self.asha, date=yesterday, punch_time=t, punch_type="IN", source="test"
            )
        AttendanceLog.objects.create(
            employee=self.ravi, date=yesterday, punch_time=time(19, 0), punch_type="IN", source="test"
        )
        self.assertFalse(OvertimeRecord.objects.exists())
        body = self.comp()
        item = self.items(body, "ot_allowance")[0]
        # an automatic allowance that nothing has used yet and whose window is open reads "Available", not "Waiting"
        self.assertEqual((item["date"], item["minutes"], item["status"]), ("2026-10-13", 30, "available"))
        self.assertEqual((body["todayAllowance"]["date"], body["todayAllowance"]["minutes"]), ("2026-10-14", 30))
        self.assertEqual(OvertimeRecord.objects.filter(employee=self.ravi).count(), 0)  # nobody else's rows

    def test_a_failing_refresh_never_takes_the_page_down(self):
        with mock.patch("api.employee_compensation_views.refresh_employee_overtime", side_effect=RuntimeError("boom")):
            self.assertEqual(self.client.get(ec.COMP, **ec._as(self.asha)).status_code, 200)


# ── the scheduled job ───────────────────────────────────────────────────────


class SchedulerTests(ot.OtBase):
    def test_the_job_is_registered_but_never_started_by_the_tests(self):
        from . import overtime_scheduler

        fake = mock.MagicMock()
        fake.running = False
        with mock.patch.object(overtime_scheduler, "get_scheduler", return_value=fake):
            overtime_scheduler.start_scheduler_if_needed()
        self.assertEqual(fake.add_job.call_args.kwargs["id"], "overtime_detection")
        self.assertEqual(fake.add_job.call_args.kwargs["max_instances"], 1)

    def test_a_failing_pass_is_logged_not_raised(self):
        from . import overtime_scheduler

        with (
            mock.patch("django.db.close_old_connections"),
            mock.patch("api.overtime.run_detection_job", side_effect=RuntimeError("boom")),
            self.assertLogs("api.overtime_scheduler", level="ERROR"),
        ):
            overtime_scheduler._run()

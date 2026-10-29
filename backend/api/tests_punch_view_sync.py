"""
Punch View: the Excel round trip now SYNCHRONISES the system with the uploaded file (additions, updates, deletions).

* a download carries a hidden "Export record" sheet listing the punch IDs it held;
* an upload deletes the punches that were in that record and are no longer in the sheet, only when asked to
  (``deleteMissing=1``), and only after a ``preview=1`` that changes nothing;
* a punch that was never in the download (arrived later, or outside its filter) is never touched;
* columns kept for display may be dropped from the sheet, the columns that identify a punch may not.

Run via: python manage.py test api.tests_punch_view_sync -v 2
"""

import io
from datetime import date, time

from django.core.files.uploadedfile import SimpleUploadedFile
from django.test import TestCase
from openpyxl import Workbook, load_workbook

from .jwt_utils import sign_token
from .models import (
    Attendance,
    AttendanceDayRecord,
    AttendanceLog,
    AuditLog,
    Branch,
    Department,
    Designation,
    Employee,
    AttendanceOverrideRequest,
    HRUser,
    PayrollSettings,
    PunchViewHistory,
    Role,
)

D1 = date(2026, 10, 5)
D2 = date(2026, 10, 6)


def hdr(user: HRUser) -> dict:
    return {"HTTP_AUTHORIZATION": f"Bearer {sign_token({'role': 'hr', 'hrUserId': user.id})}"}


def at(text: str) -> time:
    return time(*[int(x) for x in text.split(":")])


class SyncBase(TestCase):
    @classmethod
    def setUpTestData(cls):
        cls.b1 = Branch.objects.create(name="Unit 1", code="U1")
        cls.b2 = Branch.objects.create(name="Unit 2", code="U2")
        d1 = Department.objects.create(name="STORES", branch=cls.b1)
        d2 = Department.objects.create(name="PACKING", branch=cls.b2)
        des = Designation.objects.create(title="CLERK", department=d1, level="junior")

        def mk(code, first, dept):
            return Employee.objects.create(
                employee_code=code, first_name=first, last_name="X", department=dept, branch=dept.branch,
                employment_type="staff", designation=des,
            )  # fmt: skip

        cls.e1 = mk("188", "Murugan", d1)
        cls.e2 = mk("189", "Kumar", d1)
        cls.e3 = mk("P5", "Pooja", d2)
        cls.admin = HRUser.objects.create(username="hr_admin", password_hash="x", is_super_admin=True)
        role = Role.objects.create(name="att", permissions={"attendance": "edit"})
        cls.unit1 = HRUser.objects.create(username="u1", password_hash="x", role=role, branch=cls.b1)

    def setUp(self):
        self.p = {}
        for key, emp, day, t, kind in [
            ("a", self.e1, D1, "09:00:00", "IN"),
            ("b", self.e1, D1, "13:00:00", "OUT"),
            ("c", self.e1, D2, "09:05:00", "IN"),
            ("d", self.e2, D1, "09:10:00", "IN"),
            ("x", self.e3, D1, "09:15:00", "IN"),
        ]:
            self.p[key] = AttendanceLog.objects.create(
                employee=emp, date=day, punch_time=at(t), punch_type=kind, source="biometric:HO"
            )

    # ── helpers ──
    def download(self, user=None, **params):
        r = self.client.get("/api/attendance/punches/export", params, **hdr(user or self.admin))
        self.assertEqual(r.status_code, 200)
        return load_workbook(io.BytesIO(r.content))

    @staticmethod
    def as_upload(wb) -> SimpleUploadedFile:
        buf = io.BytesIO()
        wb.save(buf)
        return SimpleUploadedFile("punches.xlsx", buf.getvalue(), content_type="application/octet-stream")

    def upload(self, wb, user=None, expect=200, **flags):
        r = self.client.post(
            "/api/attendance/punches/import", {"file": self.as_upload(wb), **flags}, **hdr(user or self.admin)
        )
        self.assertEqual(r.status_code, expect, r.content[:400])
        return r.json()

    @staticmethod
    def drop_row(wb, punch_id):
        ws = wb["Punches"]
        for row in range(2, ws.max_row + 1):
            if ws.cell(row, 1).value == punch_id:
                ws.delete_rows(row)
                return
        raise AssertionError(f"punch {punch_id} not in the sheet")

    def ids(self):
        return set(AttendanceLog.objects.values_list("pk", flat=True))


class PunchSyncTests(SyncBase):
    # ── the download ──
    def test_the_download_carries_a_hidden_record_of_the_punches_it_lists(self):
        wb = self.download()
        self.assertEqual(wb.sheetnames, ["Punches", "Export record"])
        self.assertEqual(wb["Export record"].sheet_state, "hidden")
        self.assertEqual(wb.active.title, "Punches")
        listed = [r[0] for r in wb["Export record"].iter_rows(min_row=2, max_col=1, values_only=True) if r[0]]
        self.assertEqual(sorted(listed), sorted(p.pk for p in self.p.values()))

    def test_the_record_lists_only_what_the_filter_showed(self):
        wb = self.download(employmentType="staff", dateFrom=str(D2), dateTo=str(D2))
        listed = [r[0] for r in wb["Export record"].iter_rows(min_row=2, max_col=1, values_only=True) if r[0]]
        self.assertEqual(listed, [self.p["c"].pk])

    # ── deleting rows ──
    def test_a_row_removed_from_the_sheet_is_deleted_after_the_preview(self):
        wb = self.download()
        self.drop_row(wb, self.p["b"].pk)
        preview = self.upload(wb, preview="1")
        self.assertEqual((preview["toDelete"], preview["deleted"], preview["canDelete"]), (1, 0, True))
        self.assertEqual(preview["deleteSample"][0]["punchTime"], "13:00:00")
        self.assertEqual(self.ids(), {p.pk for p in self.p.values()})  # the preview changed nothing

        done = self.upload(wb, deleteMissing="1")
        self.assertEqual(done["deleted"], 1)
        self.assertNotIn(self.p["b"].pk, self.ids())
        self.assertEqual(len(self.ids()), 4)
        log = AuditLog.objects.filter(action="delete").latest("id")
        self.assertIn("1 punch", log.record_description)
        self.assertEqual(log.old_values["total"], 1)

    def test_without_the_delete_flag_nothing_is_deleted_but_the_rest_is_applied(self):
        wb = self.download()
        self.drop_row(wb, self.p["b"].pk)
        ws = wb["Punches"]
        ws.cell(2, 6).value = "09:30:00"  # the first row now: edit a time
        out = self.upload(wb)
        self.assertEqual((out["deleted"], out["skippedDeletes"], out["updated"]), (0, 1, 1))
        self.assertIn(self.p["b"].pk, self.ids())

    def test_a_file_without_the_record_sheet_can_never_delete(self):
        wb = self.download()
        del wb["Export record"]
        self.drop_row(wb, self.p["b"].pk)
        out = self.upload(wb, deleteMissing="1")
        self.assertEqual((out["canDelete"], out["toDelete"], out["deleted"]), (False, 0, 0))
        self.assertEqual(len(self.ids()), 5)

    def test_a_punch_that_was_not_in_the_download_is_left_alone(self):
        wb = self.download(dateFrom=str(D1), dateTo=str(D1))
        late = AttendanceLog.objects.create(
            employee=self.e1, date=D1, punch_time=at("17:00:00"), punch_type="OUT", source="biometric:HO"
        )  # arrived after the download, inside its range
        outside = self.p["c"]  # outside the download's dates
        out = self.upload(wb, deleteMissing="1")
        self.assertEqual((out["toDelete"], out["deleted"]), (0, 0))
        self.assertTrue({late.pk, outside.pk} <= self.ids())

    def test_a_rejected_row_is_not_treated_as_a_deletion(self):
        wb = self.download()
        ws = wb["Punches"]
        ws.cell(2, 5).value = "not a date"  # the row stays, but its date is bad
        out = self.upload(wb, deleteMissing="1")
        self.assertEqual(out["errorCount"], 1)
        self.assertEqual((out["toDelete"], out["deleted"]), (0, 0))
        self.assertEqual(len(self.ids()), 5)

    def test_removing_every_row_is_flagged_so_the_page_can_insist_on_a_confirmation(self):
        wb = self.download()
        ws = wb["Punches"]
        ws.delete_rows(2, ws.max_row)
        out = self.upload(wb, preview="1")
        self.assertEqual((out["toDelete"], out["deleteAll"]), (5, True))

    def test_a_hand_edited_record_sheet_is_not_trusted(self):
        wb = self.download()
        wb["Export record"]["A2"].value = "all of them"
        out = self.upload(wb, deleteMissing="1")
        self.assertEqual((out["canDelete"], out["deleted"]), (False, 0))

    def test_a_branch_login_cannot_delete_another_branchs_punch(self):
        wb = self.download()  # downloaded by the admin: lists both units
        self.drop_row(wb, self.p["x"].pk)  # Unit 2's punch
        self.drop_row(wb, self.p["d"].pk)  # Unit 1's punch
        out = self.upload(wb, user=self.unit1, deleteMissing="1")
        self.assertEqual(out["deleted"], 1)
        self.assertIn(self.p["x"].pk, self.ids())
        self.assertNotIn(self.p["d"].pk, self.ids())

    def test_an_unchanged_file_changes_nothing(self):
        before = self.ids()
        out = self.upload(self.download(), deleteMissing="1")
        self.assertEqual((out["updated"], out["created"], out["deleted"], out["unchanged"]), (0, 0, 0, 5))
        self.assertEqual(self.ids(), before)

    def test_adding_a_row_updating_a_row_and_deleting_a_row_in_one_upload(self):
        wb = self.download()
        self.drop_row(wb, self.p["x"].pk)
        ws = wb["Punches"]
        ws.cell(2, 6).value = "09:01:00"
        ws.append([None, "188", "", "", "2026-10-07", "09:00:00", "IN", ""])
        out = self.upload(wb, deleteMissing="1")
        self.assertEqual((out["updated"], out["created"], out["deleted"]), (1, 1, 1))
        self.assertTrue(AttendanceLog.objects.filter(employee=self.e1, date=date(2026, 10, 7)).exists())
        self.assertFalse(AttendanceLog.objects.filter(pk=self.p["x"].pk).exists())
        self.assertTrue(Attendance.objects.filter(employee=self.e1, date="2026-10-07").exists())

    # ── columns ──
    def test_the_display_columns_may_be_removed_from_the_sheet(self):
        wb = self.download()
        ws = wb["Punches"]
        ws.delete_cols(8)  # Source
        ws.delete_cols(4)  # Department
        ws.delete_cols(3)  # Employee Name
        out = self.upload(wb, deleteMissing="1")
        self.assertEqual((out["errorCount"], out["updated"], out["deleted"], out["unchanged"]), (0, 0, 0, 5))
        self.assertEqual(AttendanceLog.objects.get(pk=self.p["a"].pk).source, "biometric:HO")  # the system keeps it

    def test_the_columns_that_identify_a_punch_may_not_be_removed(self):
        wb = self.download()
        wb["Punches"].delete_cols(6)  # Punch Time
        out = self.upload(wb, expect=400)
        self.assertIn("Punch Time", out["error"])
        self.assertEqual(len(self.ids()), 5)

    def test_an_unknown_column_is_refused(self):
        wb = Workbook()
        wb.active.append(["Punch ID", "Employee Code", "Date", "Punch Time", "Punch Type", "Colour"])
        out = self.upload(wb, expect=400)
        self.assertIn("Colour", out["error"])

    def test_the_columns_may_be_reordered(self):
        wb = Workbook()
        wb.active.title = "Punches"
        wb.active.append(["Punch Type", "Punch Time", "Date", "Employee Code", "Punch ID"])
        wb.active.append(["IN", "09:02:00", "2026-10-05", "188", self.p["a"].pk])
        out = self.upload(wb)
        self.assertEqual((out["updated"], out["errorCount"]), (1, 0))
        self.assertEqual(AttendanceLog.objects.get(pk=self.p["a"].pk).punch_time, time(9, 2))


class PresentMarkTests(SyncBase):
    """A day whose punches were deleted must stop showing Present (the legacy present mark every punch writes is cleared)."""

    def mark(self, emp, day, **kw):
        return Attendance.objects.update_or_create(employee=emp, date=str(day), defaults={"present": True, **kw})[0]

    def present(self, emp, day):
        return Attendance.objects.filter(employee=emp, date=str(day), present=True).exists()

    def test_deleting_every_punch_of_a_day_clears_that_days_present_mark_and_keeps_the_others(self):
        PayrollSettings.get()
        self.mark(self.e1, D1)
        self.mark(self.e1, D2)
        wb = self.download(employmentType="staff", search="188")
        self.drop_row(wb, self.p["c"].pk)  # the only punch of D2
        out = self.upload(wb, deleteMissing="1")
        self.assertEqual(out["deleted"], 1)
        self.assertGreaterEqual(out["marksCleared"], 1)
        self.assertFalse(self.present(self.e1, D2), "a day with no punch is not Present")
        self.assertTrue(self.present(self.e1, D1), "a day that still has punches stays Present")

    def test_a_day_that_loses_only_some_punches_stays_present(self):
        self.mark(self.e1, D1)
        wb = self.download(search="188")
        self.drop_row(wb, self.p["b"].pk)  # D1 keeps its 09:00
        self.upload(wb, deleteMissing="1")
        self.assertTrue(self.present(self.e1, D1))

    def test_a_mark_somebody_entered_by_hand_is_never_removed(self):
        self.mark(self.e1, D2, hours_worked=8)
        self.mark(self.e2, D2, notes="approved by HOD")
        wb = self.download()
        self.drop_row(wb, self.p["c"].pk)
        self.upload(wb, deleteMissing="1")
        self.assertTrue(self.present(self.e1, D2))
        self.assertTrue(self.present(self.e2, D2))

    def test_a_present_mark_left_behind_by_an_earlier_deletion_is_cleaned_up_by_the_next_import(self):
        stale = date(2026, 10, 7)
        self.mark(self.e1, stale)  # no punch on this day (deleted before the fix)
        wb = self.download(search="188", dateFrom=str(D1), dateTo="2026-10-09")
        out = self.upload(wb, deleteMissing="1")
        self.assertEqual((out["deleted"], out["marksCleared"]), (0, 1))
        self.assertFalse(self.present(self.e1, stale))

    def test_a_punch_moved_to_another_day_clears_the_day_it_left(self):
        self.mark(self.e1, D2)
        self.mark(self.e1, D1)
        wb = self.download(search="188")
        ws = wb["Punches"]
        for row in range(2, ws.max_row + 1):
            if ws.cell(row, 1).value == self.p["c"].pk:
                ws.cell(row, 5).value = "2026-10-01"  # D2's only punch moves to D1
        out = self.upload(wb)
        self.assertEqual(out["updated"], 1)
        self.assertFalse(self.present(self.e1, D2))
        self.assertTrue(self.present(self.e1, D1))

    def test_the_stored_attendance_of_the_day_is_worked_out_again(self):
        PayrollSettings.get()
        AttendanceDayRecord.objects.create(employee=self.e1, date=D2, status="present", source="auto")
        self.mark(self.e1, D2)
        wb = self.download(search="188")
        self.drop_row(wb, self.p["c"].pk)
        out = self.upload(wb, deleteMissing="1")
        self.assertEqual(out["daysRefreshed"], 1)
        record = AttendanceDayRecord.objects.get(employee=self.e1, date=D2)
        self.assertNotEqual(record.status, "present")

    def test_a_day_hr_set_by_hand_keeps_what_hr_set(self):
        PayrollSettings.get()
        AttendanceDayRecord.objects.create(employee=self.e1, date=D2, status="present", source="manual")
        wb = self.download(search="188")
        self.drop_row(wb, self.p["c"].pk)
        self.upload(wb, deleteMissing="1")
        self.assertEqual(AttendanceDayRecord.objects.get(employee=self.e1, date=D2).status, "present")


class HistoryTests(SyncBase):
    """Everything an upload changes is written to the History, with the status changes it causes."""

    def setUp(self):
        super().setUp()
        PayrollSettings.get()

    def history(self, **kw):
        return list(PunchViewHistory.objects.filter(**kw).order_by("id"))

    def test_an_upload_writes_a_row_for_every_punch_added_edited_and_deleted(self):
        wb = self.download(search="188")
        self.drop_row(wb, self.p["b"].pk)  # delete 13:00 OUT
        ws = wb["Punches"]
        ws.cell(2, 6).value = "09:01:00"  # edit the first row's time
        ws.append([None, "188", "", "", "2026-10-09", "09:00:00", "IN", ""])  # add a punch
        out = self.upload(wb, deleteMissing="1")
        self.assertEqual((out["updated"], out["created"], out["deleted"]), (1, 1, 1))
        rows = self.history(via="import")
        self.assertEqual(
            sorted(r.action for r in rows if r.action.startswith("punch_")),
            ["punch_added", "punch_deleted", "punch_edited"],
        )
        deleted = next(r for r in rows if r.action == "punch_deleted")
        self.assertEqual(
            (deleted.employee_code, deleted.details["before"]["time"], deleted.details["before"]["type"]),
            ("188", "13:00:00", "OUT"),
        )
        edited = next(r for r in rows if r.action == "punch_edited")
        self.assertEqual((edited.details["before"]["time"], edited.details["after"]["time"]), ("09:00:00", "09:01:00"))
        self.assertEqual(len({r.batch for r in rows}), 1)
        self.assertTrue(all(r.actor_name for r in rows))

    def test_a_preview_and_an_unchanged_file_write_nothing(self):
        wb = self.download()
        self.drop_row(wb, self.p["b"].pk)
        self.upload(wb, preview="1")
        self.assertEqual(PunchViewHistory.objects.count(), 0)
        self.upload(self.download(), deleteMissing="1")
        self.assertEqual(PunchViewHistory.objects.count(), 0)

    def test_a_day_that_stops_being_present_is_written_as_a_status_change(self):
        AttendanceDayRecord.objects.create(employee=self.e1, date=D2, status="present", source="auto", shifts_earned=1)
        Attendance.objects.create(employee=self.e1, date=str(D2), present=True)
        wb = self.download(search="188")
        self.drop_row(wb, self.p["c"].pk)  # D2's only punch
        self.upload(wb, deleteMissing="1")
        auto = self.history(action="status_auto")
        self.assertEqual(len(auto), 1)
        self.assertEqual((auto[0].date, auto[0].details["before"]["status"]), (D2, "present"))
        self.assertNotEqual(auto[0].details["after"]["status"], "present")


class DayStatusTests(SyncBase):
    URL = "/api/attendance/punches/day-status"

    def setUp(self):
        super().setUp()
        PayrollSettings.get()

    def post(self, body, user=None, expect=200):
        r = self.client.post(self.URL, body, content_type="application/json", **hdr(user or self.admin))
        self.assertEqual(r.status_code, expect, r.content[:300])
        return r.json()

    def test_a_day_can_be_set_present_half_day_or_absent_and_goes_to_the_history(self):
        for status, shifts in (("present", "1.00"), ("half_shift", "0.50"), ("absent", "0.00")):
            out = self.post({"code": "188", "date": str(D1), "status": status, "note": "checked by HR"})
            self.assertEqual(
                (out["day"]["status"], out["day"]["source"], out["day"]["shifts"]), (status, "manual", shifts)
            )
            rec = AttendanceDayRecord.objects.get(employee=self.e1, date=D1)
            self.assertEqual((rec.status, rec.source, rec.override_note), (status, "manual", "checked by HR"))
        rows = list(PunchViewHistory.objects.filter(action="status_set").order_by("id"))
        self.assertEqual(len(rows), 3)
        self.assertEqual(rows[-1].details["after"]["status"], "absent")
        self.assertEqual(rows[-1].details["before"]["status"], "half_shift")
        self.assertEqual(rows[-1].note, "checked by HR")

    def test_a_reason_is_needed_for_a_status_but_not_to_go_back_to_automatic(self):
        self.post({"code": "188", "date": str(D1), "status": "absent"}, expect=400)
        self.post({"code": "188", "date": str(D1), "status": "absent", "note": "ab"}, expect=400)
        self.assertEqual(PunchViewHistory.objects.count(), 0)
        self.post({"code": "188", "date": str(D1), "status": "absent", "note": "no show"})
        out = self.post({"code": "188", "date": str(D1), "status": "auto"})
        self.assertEqual(out["day"]["source"], "auto")
        self.assertEqual(PunchViewHistory.objects.filter(action="status_reset").count(), 1)

    def test_a_manual_status_survives_a_recompute_and_a_pending_edit_is_overtaken(self):
        from .attendance_final import compute_range_records

        req = AttendanceOverrideRequest.objects.create(
            employee=self.e1, date=D1, previous_values={}, requested_values={}, reason="x", requested_by="HR",
            approval_trail=[],
        )  # fmt: skip
        self.post({"code": "188", "date": str(D1), "status": "absent", "note": "no show"})
        compute_range_records(self.e1, D1, D1, PayrollSettings.get())
        self.assertEqual(AttendanceDayRecord.objects.get(employee=self.e1, date=D1).status, "absent")
        req.refresh_from_db()
        self.assertEqual(req.status, AttendanceOverrideRequest.STATUS_REJECTED)

    def test_a_bad_request_is_refused(self):
        self.post({"code": "188", "date": str(D1), "status": "on_leave", "note": "nope nope"}, expect=400)
        self.post({"code": "NOBODY", "date": str(D1), "status": "absent", "note": "nope nope"}, expect=404)
        self.post({"code": "188", "date": "2999-01-01", "status": "absent", "note": "nope nope"}, expect=400)
        self.post({"code": "188", "date": "not a date", "status": "absent", "note": "nope nope"}, expect=400)

    def test_reading_a_day_gives_its_status_and_who_set_it(self):
        self.post({"code": "188", "date": str(D1), "status": "half_shift", "note": "left early"})
        body = self.client.get(self.URL, {"code": "188", "date": str(D1)}, **hdr(self.admin)).json()
        self.assertEqual(
            (body["name"], body["status"], body["source"], body["overrideNote"]),
            ("Murugan X", "half_shift", "manual", "left early"),
        )
        self.assertEqual(body["punchCount"], 2)

    def test_a_branch_login_only_reaches_its_own_branch_and_a_view_only_role_cannot_set(self):
        self.post(
            {"code": "P5", "date": str(D1), "status": "absent", "note": "other unit"}, user=self.unit1, expect=404
        )
        role = Role.objects.create(name="viewer", permissions={"attendance": "view"})
        viewer = HRUser.objects.create(username="viewer", password_hash="x", role=role)
        self.post({"code": "188", "date": str(D1), "status": "absent", "note": "view only"}, user=viewer, expect=403)
        r = self.client.get(self.URL, {"code": "188", "date": str(D1)}, **hdr(viewer))
        self.assertEqual(r.status_code, 200)

    def test_the_list_carries_each_days_stored_status(self):
        self.post({"code": "188", "date": str(D1), "status": "half_shift", "note": "half"})
        r = self.client.get("/api/attendance/punches", {"search": "188"}, **hdr(self.admin))
        rows = r.json()["results"]
        first = next(x for x in rows if x["date"] == str(D1))
        self.assertEqual((first["dayStatus"]["status"], first["dayStatus"]["label"]), ("half_shift", "Half Day"))
        other = next(x for x in rows if x["date"] == str(D2))
        self.assertIsNone(other["dayStatus"])


class HistoryListTests(SyncBase):
    URL = "/api/attendance/punches/history"

    def setUp(self):
        super().setUp()
        PayrollSettings.get()
        for code, status in (("188", "absent"), ("189", "half_shift"), ("P5", "present")):
            r = self.client.post(
                DayStatusTests.URL,
                {"code": code, "date": str(D1), "status": status, "note": "because"},
                content_type="application/json",
                **hdr(self.admin),
            )
            self.assertEqual(r.status_code, 200, r.content[:200])

    def get(self, user=None, **params):
        r = self.client.get(self.URL, params, **hdr(user or self.admin))
        self.assertEqual(r.status_code, 200, r.content[:300])
        return r.json()

    def test_newest_first_and_filtered(self):
        body = self.get()
        self.assertEqual((body["total"], body["items"][0]["employeeCode"]), (3, "P5"))
        self.assertEqual([i["employeeCode"] for i in self.get(q="murugan")["items"]], ["188"])
        self.assertEqual([i["employeeCode"] for i in self.get(q="189")["items"]], ["189"])
        self.assertEqual(self.get(action="status_set")["total"], 3)
        self.assertEqual(self.get(action="punch_deleted")["total"], 0)
        self.assertEqual(self.get(dayFrom="2026-10-06")["total"], 0)
        self.assertEqual(self.get(dayFrom="2026-10-05", dayTo="2026-10-05")["total"], 3)
        today = date.today().isoformat()
        self.assertEqual(self.get(**{"from": today, "to": today})["total"], 3)
        self.assertEqual(self.get(**{"from": "2999-01-01"})["total"], 0)

    def test_paging(self):
        body = self.get(pageSize=2)
        self.assertEqual((len(body["items"]), body["total"]), (2, 3))
        self.assertEqual(len(self.get(pageSize=2, page=2)["items"]), 1)

    def test_an_item_says_who_what_before_and_after(self):
        item = self.get(q="188")["items"][0]
        self.assertEqual(
            (item["action"], item["actionLabel"], item["date"], item["note"]),
            ("status_set", "Status set by hand", str(D1), "because"),
        )
        self.assertEqual(item["after"]["status"], "absent")
        self.assertTrue(item["actorName"])

    def test_a_branch_login_sees_only_its_branch_and_bad_filters_are_refused(self):
        self.assertEqual({i["employeeCode"] for i in self.get(user=self.unit1)["items"]}, {"188", "189"})
        for bad in ({"from": "x"}, {"page": "x"}, {"employeeId": "x"}):
            r = self.client.get(self.URL, bad, **hdr(self.admin))
            self.assertEqual(r.status_code, 400)

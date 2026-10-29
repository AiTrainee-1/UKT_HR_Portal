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
from .models import AuditLog, Attendance, AttendanceLog, Branch, Department, Designation, Employee, HRUser, Role

D1 = date(2026, 10, 5)
D2 = date(2026, 10, 6)


def hdr(user: HRUser) -> dict:
    return {"HTTP_AUTHORIZATION": f"Bearer {sign_token({'role': 'hr', 'hrUserId': user.id})}"}


def at(text: str) -> time:
    return time(*[int(x) for x in text.split(":")])


class PunchSyncTests(TestCase):
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

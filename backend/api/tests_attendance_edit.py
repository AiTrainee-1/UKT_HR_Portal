"""
Attendance Edit: every attendance change is HOD first, then HR, for every attendance type; the day is written only when both
have approved, and stays exactly as it was until then.

Run via: python manage.py test api.tests_attendance_edit -v 2
"""

from datetime import date, time
from unittest import mock

from . import attendance_edit as edit
from .models import (
    AttendanceDayRecord,
    AttendanceLog,
    BiometricDevice,
    AttendanceOverrideRequest,
    Branch,
    DepartmentManager,
    Employee,
    HRUser,
    ManagerEmployeeAssignment,
    PayrollSettings,
    PunchViewHistory,
    Role,
)
from .tests_approval_workflow import Base, _bearer

DAY = date(2026, 9, 1)
ALL_TYPES = [
    "present", "half_day", "full_day", "quarter_shift", "three_quarter_shift",
    "compensation", "sunday_compensation", "ot_compensation", "absent", "on_leave", "holiday",
]  # fmt: skip


class EditBase(Base):
    def setUp(self):
        super().setUp()
        PayrollSettings.get()
        # "today" for the attendance engine, so 1 September 2026 is a day that has passed
        p = mock.patch("api.growth_views.ist_today", return_value=date(2026, 9, 28))
        p.start()
        self.addCleanup(p.stop)
        p = mock.patch("api.clock.ist_today", return_value=date(2026, 9, 28))
        p.start()
        self.addCleanup(p.stop)
        AttendanceDayRecord.objects.create(employee=self.emp, date=DAY, status="absent", shifts_earned=0, source="auto")

    def propose(self, kind="present", day=DAY, **extra):
        body = {"employeeId": self.emp.id, "date": str(day), "type": kind, "note": "device missed the punch", **extra}
        return self.send("post", "/api/attendance/override", body)

    def hod_ok(self, pk, status="approved"):
        return self.as_hod("patch", f"/api/manager/attendance-requests/{pk}/status", {"status": status})

    def hr_ok(self, pk, status="approved", comment=None):
        return self.send("patch", f"/api/attendance/override-requests/{pk}", {"status": status, "comment": comment})

    def record(self):
        return AttendanceDayRecord.objects.get(employee=self.emp, date=DAY)

    def approve_both(self, kind, **extra):
        r = self.propose(kind, **extra)
        self.assertEqual(r.status_code, 202, r.content)
        pk = r.json()["request"]["id"]
        self.assertEqual(self.hod_ok(pk).status_code, 200)
        done = self.hr_ok(pk)
        self.assertEqual(done.status_code, 200, done.content)
        return pk


class CatalogueTests(EditBase):
    def test_every_attendance_type_of_the_hrms_is_offered(self):
        self.assertEqual([t["key"] for t in edit.catalogue()], ALL_TYPES)
        by = {t["key"]: t for t in edit.catalogue()}
        self.assertEqual((by["present"]["status"], by["present"]["shifts"]), ("present", "1.00"))
        self.assertEqual((by["half_day"]["status"], by["half_day"]["shifts"]), ("half_shift", "0.50"))
        self.assertEqual(by["full_day"]["shifts"], "1.00")
        self.assertEqual(by["quarter_shift"]["shifts"], "0.25")
        self.assertEqual(by["three_quarter_shift"]["shifts"], "0.75")
        for k in ("compensation", "sunday_compensation", "ot_compensation"):
            self.assertEqual(by[k]["shiftChoices"], ["0.25", "0.50", "0.75", "1.00"], k)
            self.assertTrue(by[k]["compensation"], k)

    def test_the_context_endpoint_gives_the_page_everything(self):
        r = self.send("get", f"/api/attendance/edit-context?employeeId={self.emp.id}&date={DAY}")
        self.assertEqual(r.status_code, 200, r.content)
        body = r.json()
        self.assertEqual([t["key"] for t in body["types"]], ALL_TYPES)
        self.assertEqual(body["employee"]["code"], "W1")
        self.assertEqual(body["hod"]["name"], "Suresh Raj")
        self.assertTrue(body["hod"]["code"])
        self.assertEqual(body["day"]["status"], "absent")
        self.assertEqual([s["roles"] for s in body["pipeline"]["steps"]], [["hod"], ["hr"]])
        self.assertEqual(body["pipeline"]["path"], "HR → HOD → HR")
        self.propose("present")
        again = self.send("get", f"/api/attendance/edit-context?employeeId={self.emp.id}&date={DAY}").json()
        self.assertEqual(len(again["requests"]), 1)
        self.assertEqual(again["requests"][0]["approval"]["waitingFor"], ["hod"])
        self.assertEqual(again["requests"][0]["typeLabel"], "Present")


class EveryTypeNeedsBothApprovalsTests(EditBase):
    EXPECT = {
        "present": ("present", "1.00"),
        "full_day": ("present", "1.00"),
        "half_day": ("half_shift", "0.50"),
        "quarter_shift": ("present", "0.25"),
        "three_quarter_shift": ("present", "0.75"),
        "compensation": ("present", "1.00"),
        "sunday_compensation": ("present", "1.00"),
        "ot_compensation": ("present", "1.00"),
        "absent": ("absent", "0.00"),
        "on_leave": ("on_leave", "0.00"),
        "holiday": ("holiday", "0.00"),
    }

    def test_no_type_changes_the_day_until_the_hod_and_then_hr_have_approved(self):
        for kind, (status, shifts) in self.EXPECT.items():
            with self.subTest(kind):
                AttendanceDayRecord.objects.filter(employee=self.emp, date=DAY).delete()
                AttendanceDayRecord.objects.create(
                    employee=self.emp, date=DAY, status="absent", shifts_earned=0, source="auto"
                )
                r = self.propose(kind)
                self.assertEqual(r.status_code, 202, r.content)
                pk = r.json()["request"]["id"]
                self.assertEqual(self.record().status, "absent")  # pending: unchanged
                self.assertEqual(self.hr_ok(pk).status_code, 400)  # HR cannot jump the queue
                self.assertEqual(self.record().status, "absent")
                self.assertEqual(self.hod_ok(pk).json()["approval"]["waitingFor"], ["hr"])
                self.assertEqual(self.record().status, "absent")  # the HOD alone changes nothing
                self.assertEqual(self.record().source, "auto")
                self.assertEqual(self.hr_ok(pk).status_code, 200)
                rec = self.record()
                self.assertEqual((rec.status, f"{rec.shifts_earned:.2f}", rec.source), (status, shifts, "manual"))
                self.assertEqual(
                    [e["role"] for e in AttendanceOverrideRequest.objects.get(pk=pk).approval_trail], ["hod", "hr"]
                )

    def test_the_hod_rejecting_ends_it_and_nothing_changes(self):
        pk = self.propose("present").json()["request"]["id"]
        self.assertEqual(self.hod_ok(pk, "rejected").json()["status"], "rejected")
        self.assertEqual(self.record().status, "absent")
        self.assertEqual(self.hr_ok(pk).status_code, 400)  # nothing left to approve

    def test_hr_rejecting_after_the_hod_ends_it_and_nothing_changes(self):
        pk = self.propose("present").json()["request"]["id"]
        self.hod_ok(pk)
        self.assertEqual(self.hr_ok(pk, "rejected", "not convinced").json()["status"], "rejected")
        self.assertEqual((self.record().status, self.record().source), ("absent", "auto"))

    def test_a_compensation_day_carries_its_marker_and_the_chosen_amount(self):
        self.approve_both("sunday_compensation", shifts="0.50")
        rec = self.record()
        self.assertEqual((rec.status, f"{rec.shifts_earned:.2f}"), ("present", "0.50"))
        self.assertEqual(rec.compensation_kind, "relaxation")
        self.assertIn("Sunday Compensation", rec.compensation_note)
        self.assertIn("Sunday Compensation", rec.override_note)

    def test_a_plain_type_clears_an_old_marker(self):
        AttendanceDayRecord.objects.filter(employee=self.emp, date=DAY).update(
            compensation_kind="birthday", compensation_note="old"
        )
        self.approve_both("present")
        self.assertEqual(self.record().compensation_kind, "")

    def test_approval_is_written_to_the_punch_view_history(self):
        self.approve_both("half_day")
        row = PunchViewHistory.objects.get(action="status_set")
        self.assertEqual(
            (row.employee_code, row.details["before"]["status"], row.details["after"]["status"]),
            ("W1", "absent", "half_shift"),
        )
        self.assertIn("approved by", row.note)


class ProposalRulesTests(EditBase):
    def test_a_reason_a_known_type_and_a_valid_amount_are_required(self):
        self.assertEqual(self.propose("present", note="").status_code, 400)
        self.assertEqual(self.propose("present", note="ab").status_code, 400)
        self.assertEqual(self.propose("nonsense").status_code, 400)
        self.assertEqual(self.propose("compensation", shifts="0.40").status_code, 400)
        self.assertEqual(self.propose("compensation", shifts="abc").status_code, 400)
        self.assertEqual(AttendanceOverrideRequest.objects.count(), 0)

    def test_a_day_that_has_not_come_cannot_be_proposed(self):
        self.assertEqual(self.propose("present", day=date(2026, 12, 1)).status_code, 400)

    def test_without_a_department_head_it_cannot_be_submitted(self):
        ManagerEmployeeAssignment.objects.filter(employee=self.emp).delete()
        r = self.propose("present")
        self.assertEqual((r.status_code, r.json()["code"]), (400, "no_hod"))
        self.assertEqual(AttendanceOverrideRequest.objects.count(), 0)

    def test_a_head_has_no_one_to_approve_their_own_change(self):
        ManagerEmployeeAssignment.objects.get_or_create(manager=self.manager, employee=self.boss)
        r = self.send(
            "post",
            "/api/attendance/override",
            {"employeeId": self.boss.id, "date": str(DAY), "type": "present", "note": "forgot to punch"},
        )
        self.assertEqual((r.status_code, r.json()["code"]), (400, "no_hod"))

    def test_the_workflow_cannot_be_switched_off_or_edited(self):
        from . import approval_workflow as approval

        self.configure("attendance_correction", enabled=False)
        self.assertTrue(approval.get_config("attendance_correction").enabled)
        self.assertEqual(self.propose("present").status_code, 202)
        steps, error = approval.validate_steps(approval.definition("attendance_correction"), [{"roles": ["hr"]}])
        self.assertIsNone(steps)
        self.assertIn("fixed", error)

    def test_a_newer_proposal_replaces_the_one_still_waiting(self):
        first = self.propose("present").json()["request"]["id"]
        second = self.propose("half_day").json()["request"]["id"]
        self.assertEqual(AttendanceOverrideRequest.objects.get(pk=first).status, "rejected")
        self.assertEqual(AttendanceOverrideRequest.objects.get(pk=second).status, "pending")

    def test_an_older_client_still_goes_through_the_same_approval(self):
        r = self.send(
            "post",
            "/api/attendance/override",
            {"employeeId": self.emp.id, "date": str(DAY), "status": "present", "note": "old client"},
        )
        self.assertEqual(r.status_code, 202)
        self.assertEqual(self.record().status, "absent")
        self.assertEqual(r.json()["request"]["approval"]["waitingFor"], ["hod"])


class QueueAndAccessTests(EditBase):
    def test_the_lists_show_who_each_request_waits_for(self):
        pk = self.propose("present").json()["request"]["id"]
        hod_list = self.send("get", "/api/attendance/override-requests?waiting=hod").json()
        hr_list = self.send("get", "/api/attendance/override-requests?waiting=hr").json()
        self.assertEqual(([r["id"] for r in hod_list], hr_list), ([pk], []))
        self.hod_ok(pk)
        self.assertEqual(self.send("get", "/api/attendance/override-requests?waiting=hod").json(), [])
        self.assertEqual(
            [r["id"] for r in self.send("get", "/api/attendance/override-requests?waiting=hr").json()], [pk]
        )

    def test_a_view_only_role_cannot_decide(self):
        pk = self.propose("present").json()["request"]["id"]
        self.hod_ok(pk)
        role = Role.objects.create(name="viewer", permissions={"attendance": "view"})
        viewer = HRUser.objects.create(username="viewer", password_hash="x", role=role)
        who = _bearer({"role": "hr", "hrUserId": viewer.id, "name": "Viewer"})
        r = self.send("patch", f"/api/attendance/override-requests/{pk}", {"status": "approved"}, who)
        self.assertEqual(r.status_code, 403)
        self.assertEqual(self.record().status, "absent")

    def test_a_branch_login_cannot_decide_another_branchs_request(self):
        pk = self.propose("present").json()["request"]["id"]
        self.hod_ok(pk)
        other = Branch.objects.create(name="Other", code="OT")
        Employee.objects.filter(pk=self.emp.pk).update(branch=other)
        mine = Branch.objects.create(name="Mine", code="MN")
        role = Role.objects.create(name="att", permissions={"attendance": "edit"})
        user = HRUser.objects.create(username="branchhr", password_hash="x", role=role, branch=mine)
        who = _bearer({"role": "hr", "hrUserId": user.id, "name": "Branch HR"})
        r = self.send("patch", f"/api/attendance/override-requests/{pk}", {"status": "approved"}, who)
        self.assertEqual(r.status_code, 404)
        self.assertEqual(self.send("get", "/api/attendance/override-requests", None, who).json(), [])
        ctx = self.send("get", f"/api/attendance/edit-context?employeeId={self.emp.id}&date={DAY}", None, who)
        self.assertEqual(ctx.status_code, 404)

    def test_an_hod_without_the_attendance_switch_cannot_approve(self):
        DepartmentManager.objects.filter(pk=self.manager.pk).update(can_approve_attendance=False)
        pk = self.propose("present").json()["request"]["id"]
        self.assertEqual(self.hod_ok(pk).status_code, 403)
        self.assertEqual(self.record().status, "absent")

    def test_a_decided_request_cannot_be_decided_again(self):
        pk = self.approve_both("present")
        self.assertEqual(self.hr_ok(pk, "rejected").status_code, 400)
        self.assertEqual(self.record().status, "present")


class DayPunchesTests(EditBase):
    def test_the_context_lists_every_punch_of_the_day_with_where_it_came_from(self):
        BiometricDevice.objects.create(name="Head Office", host="10.0.0.1", serial_number="SN9")
        for at, kind, source in (
            (time(9, 3), "IN", "biometric:adms:SN9"),
            (time(13, 0), "OUT", "biometric:HO"),
            (time(13, 40), "IN", "manual:punch-view"),
            (time(18, 5), "OUT", "geo:auto"),
            (time(8, 0), "IN", "manual"),
        ):
            AttendanceLog.objects.create(employee=self.emp, date=DAY, punch_time=at, punch_type=kind, source=source)
        AttendanceLog.objects.create(
            employee=self.emp, date=date(2026, 9, 2), punch_time=time(9, 0), punch_type="IN", source="biometric:HO"
        )  # another day: not listed
        body = self.send("get", f"/api/attendance/edit-context?employeeId={self.emp.id}&date={DAY}").json()
        rows = [(p["time"], p["type"], p["sourceLabel"], p["device"]) for p in body["punches"]]
        self.assertEqual(
            rows,
            [
                ("08:00:00", "IN", "HR Entry", None),
                ("09:03:00", "IN", "Biometric", "Head Office"),
                ("13:00:00", "OUT", "Biometric", "HO"),
                ("13:40:00", "IN", "Punch View", "Punch View upload"),
                ("18:05:00", "OUT", "Geo Punch", None),
            ],
        )
        self.assertEqual(body["punches"][1]["source"], "biometric:adms:SN9")

    def test_a_day_without_punches_has_an_empty_list_and_the_edit_flag_follows_the_role(self):
        body = self.send("get", f"/api/attendance/edit-context?employeeId={self.emp.id}&date={DAY}").json()
        self.assertEqual((body["punches"], body["canEdit"]), ([], True))
        role = Role.objects.create(name="viewer2", permissions={"attendance": "view"})
        viewer = HRUser.objects.create(username="viewer2", password_hash="x", role=role)
        who = _bearer({"role": "hr", "hrUserId": viewer.id, "name": "Viewer"})
        seen = self.send("get", f"/api/attendance/edit-context?employeeId={self.emp.id}&date={DAY}", None, who).json()
        self.assertFalse(seen["canEdit"])

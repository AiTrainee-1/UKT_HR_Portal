"""
My Requests + "remind the approver" (mobile HOD Assignment): mobile_reminder_views.py.

Run via: DATABASE_URL= DB_TEST_NAME=uktex_test_remind python manage.py test api.tests_mobile_reminders
"""

from datetime import date, time, timedelta
from decimal import Decimal
from unittest import mock

from django.test import TestCase
from django.utils import timezone

from . import approval_workflow as approval
from . import mobile_messages
from .approval_workflow import HOD
from .jwt_utils import sign_token
from .models import (
    Advance,
    ApprovalReminder,
    AttendanceOverrideRequest,
    CasualLeaveRequest,
    DepartmentManager,
    Employee,
    EmployeePermission,
    EmployeeRequest,
    HRUser,
    LeaveRequest,
    ManagerEmployeeAssignment,
    MissingPunchRequest,
    MobileMessageSettings,
    Notification,
    OnDutySession,
    OutpassRequest,
    PushToken,
    ResignationRequest,
)

LIST = "/api/my/pending-requests"
EXPO = "api.signals.requests.post"
OPENING = "Sir, please review this request and provide your approval."


def _bearer(payload: dict) -> dict:
    return {"HTTP_AUTHORIZATION": f"Bearer {sign_token(payload)}"}


def _expo_ok(post):
    post.return_value = mock.Mock(ok=True, status_code=200, json=lambda: {"data": [{"status": "ok"}]})


def remind_url(module: str, pk: int) -> str:
    return f"{LIST}/{module}/{pk}/remind"


class Base(TestCase):
    def setUp(self):
        approval.clear_cache()
        self.addCleanup(approval.clear_cache)
        self.emp = Employee.objects.create(
            employee_code="R1", first_name="Asha", last_name="Kumar", status="active", employment_type="staff"
        )
        self.boss = Employee.objects.create(
            employee_code="R9", first_name="Ravi", last_name="Shankar", status="active", employment_type="staff"
        )
        self.other = Employee.objects.create(
            employee_code="R2", first_name="Bala", last_name="Murugan", status="active", employment_type="staff"
        )
        self.manager = DepartmentManager.objects.create(employee=self.boss)
        ManagerEmployeeAssignment.objects.create(manager=self.manager, employee=self.emp)
        self.me = _bearer({"role": "employee", "employeeId": self.emp.id})
        self.them = _bearer({"role": "employee", "employeeId": self.other.id})
        hr = HRUser.objects.create(username="rem_hr", password_hash="x", is_super_admin=True, full_name="Meena")
        self.hr = _bearer({"role": "hr", "hrUserId": hr.id, "name": "Meena"})

    def leave(self, emp=None, **kw):
        values = dict(type="casual", start_date="2026-11-03", end_date="2026-11-03", total_days=1, approval_trail=[])
        values.update(kw)
        return LeaveRequest.objects.create(employee=emp or self.emp, **values)

    def missing_punch(self, emp=None, **kw):
        values = dict(
            date=date(2026, 10, 30),
            punch_time=time(9, 5),
            punch_type="IN",
            reason="Forgot",
            status="pending_hod",
            approval_trail=[],
        )
        values.update(kw)
        return MissingPunchRequest.objects.create(employee=emp or self.emp, **values)

    def get_list(self, who=None):
        r = self.client.get(LIST, **(who or self.me))
        self.assertEqual(r.status_code, 200, r.content)
        return r.json()

    def remind(self, module, pk, who=None):
        return self.client.post(remind_url(module, pk), {}, content_type="application/json", **(who or self.me))

    def item(self, body, key):
        return next(i for i in body["items"] if i["key"] == key)


class ListingTests(Base):
    def test_every_kind_the_employee_raises_is_listed_and_nothing_else(self):
        waiting = {
            f"leave-{self.leave().id}",
            f"missing_punch-{self.missing_punch().id}",
            "permission-%d"
            % EmployeePermission.objects.create(
                employee=self.emp,
                date=date(2026, 10, 30),
                permission_time=time(9, 0),
                type="morning_late_in",
                approval_trail=[],
            ).id,
            f"casual_leave-{CasualLeaveRequest.objects.create(employee=self.emp, date=date(2026, 11, 4), approval_trail=[]).id}",
            "on_duty-%d"
            % OnDutySession.objects.create(employee=self.emp, destination="Tiruppur mill", approval_trail=[]).id,
            "outpass-%d"
            % OutpassRequest.objects.create(
                employee=self.emp, destination="Bank", reason="Cheque", approval_trail=[]
            ).id,
            "resignation-%d"
            % ResignationRequest.objects.create(employee=self.emp, reason="Moving", approval_trail=[]).id,
            "request-%d"
            % EmployeeRequest.objects.create(
                employee=self.emp, request_type="general", subject="Salary certificate", description="For a bank loan"
            ).id,
            "advance-%d"
            % Advance.objects.create(
                employee=self.emp, advance_type="general", amount=Decimal("5000"), applied_by="employee"
            ).id,
        }
        # not waiting, not raised by the employee, or not this employee's
        self.leave(status="approved")
        self.missing_punch(status="rejected")
        OutpassRequest.objects.create(employee=self.emp, destination="Site", reason="On-Duty", source="on_duty")
        Advance.objects.create(employee=self.emp, advance_type="general", amount=Decimal("1000"))  # HR entered it
        EmployeeRequest.objects.create(
            employee=self.emp, request_type="general", subject="x", description="y", status="more_info"
        )
        self.leave(emp=self.other)

        body = self.get_list()
        self.assertEqual({i["key"] for i in body["items"]}, waiting)
        self.assertEqual(body["count"], len(waiting))
        self.assertEqual(body["cooldownHours"], 24)
        row = self.item(body, next(k for k in waiting if k.startswith("leave-")))
        self.assertEqual((row["moduleLabel"], row["title"]), ("Leave", "Casual Leave"))
        self.assertIn("2026-11-03", row["summary"])
        self.assertTrue(row["canRemind"])
        self.assertIsNone(row["lastRemindedAt"])
        advance = self.item(body, next(k for k in waiting if k.startswith("advance-")))
        self.assertIn("5,000", advance["summary"])
        self.assertEqual(advance["stage"], "Waiting for HR")

    def test_stage_text_follows_the_pipeline(self):
        leave = self.leave()  # out of the box: "HOD or HR", one step
        mp = self.missing_punch()  # HOD, then HR
        body = self.get_list()
        row = self.item(body, f"leave-{leave.id}")
        self.assertEqual(row["stage"], "Waiting for your Department Head (Ravi Shankar) or HR")
        self.assertEqual(row["approver"], {"role": "hod", "name": "Ravi Shankar", "label": "Department Head"})
        self.assertEqual([s["label"] for s in row["steps"]], ["Department Head or HR"])
        row = self.item(body, f"missing_punch-{mp.id}")
        self.assertEqual(row["stage"], "Waiting for your Department Head (Ravi Shankar)")
        self.assertEqual(
            [(s["label"], s["state"]) for s in row["steps"]], [("Department Head", "pending"), ("HR", "waiting")]
        )
        self.assertEqual(row["trail"], [])

    def test_a_request_the_head_approved_now_waits_for_hr_and_shows_the_trail(self):
        mp = self.missing_punch()
        approval.decide("missing_punch", mp, HOD, "approved", actor="Ravi Shankar", comment="ok")
        mp.status = "pending_hr"
        mp.save()
        row = self.item(self.get_list(), f"missing_punch-{mp.id}")
        self.assertEqual(row["stage"], "Waiting for HR")
        self.assertEqual(row["approver"]["role"], "hr")
        self.assertEqual([s["state"] for s in row["steps"]], ["approved", "pending"])
        self.assertEqual(row["currentStep"], 1)
        self.assertEqual(len(row["trail"]), 1)
        self.assertEqual((row["trail"][0]["roleLabel"], row["trail"][0]["by"]), ("Department Head", "Ravi Shankar"))

    def test_a_head_not_allowed_to_approve_this_kind_leaves_it_to_hr(self):
        self.manager.can_approve_leaves = False
        self.manager.save()
        leave = self.leave()
        row = self.item(self.get_list(), f"leave-{leave.id}")
        self.assertEqual(row["stage"], "Waiting for HR")

    def test_no_head_on_a_head_only_step_says_so(self):
        ManagerEmployeeAssignment.objects.all().delete()
        mp = self.missing_punch()
        row = self.item(self.get_list(), f"missing_punch-{mp.id}")
        self.assertIn("none can approve it yet", row["stage"])
        self.assertEqual(row["approver"]["role"], "hr")

    def test_a_switched_off_workflow_still_lists_what_is_already_waiting(self):
        leave = self.leave()
        approval.save_config("leave", enabled=False, actor="test")
        row = self.item(self.get_list(), f"leave-{leave.id}")
        self.assertFalse(row["workflowEnabled"])
        self.assertTrue(row["canRemind"])

    def test_isolation_and_hr_tokens(self):
        mine = self.leave()
        theirs = self.leave(emp=self.other)
        self.assertEqual({i["id"] for i in self.get_list()["items"]}, {mine.id})
        self.assertEqual({i["id"] for i in self.get_list(self.them)["items"]}, {theirs.id})
        self.assertEqual(self.client.get(LIST, **self.hr).status_code, 403)
        self.assertEqual(self.client.get(LIST).status_code, 401)


class RemindTests(Base):
    def test_reminding_the_head_makes_an_in_app_notice_and_a_push(self):
        PushToken.objects.create(employee=self.boss, token="ExponentPushToken[boss]")
        leave = self.leave()
        with mock.patch(EXPO) as post:
            _expo_ok(post)
            r = self.remind("leave", leave.id)
        self.assertEqual(r.status_code, 200, r.content)
        body = r.json()
        self.assertEqual(body["sentTo"], "hod")
        self.assertEqual(body["push"], "sent")
        self.assertEqual(body["message"], "Reminder sent to Ravi Shankar (Department Head).")
        self.assertFalse(body["item"]["canRemind"])
        self.assertEqual(body["item"]["reminderCount"], 1)
        self.assertGreater(body["item"]["remindInSeconds"], 23 * 3600)
        self.assertEqual(post.call_count, 1)

        note = Notification.objects.get(employee=self.boss)
        self.assertEqual(note.title, "Reminder: request waiting")
        self.assertTrue(note.message.startswith(OPENING))
        self.assertIn("Asha Kumar (R1)", note.message)
        self.assertIn("2026-11-03", note.message)
        self.assertEqual((note.source, note.type, note.related_module), ("approval_reminder", "approval_reminder", ""))
        rem = ApprovalReminder.objects.get()
        self.assertEqual(
            (rem.employee_id, rem.module, rem.request_id, rem.sent_to),
            (self.emp.id, "leave", leave.id, f"hod:{self.boss.id}"),
        )
        # the employee gets no notice of their own
        self.assertFalse(Notification.objects.filter(employee=self.emp).exists())

    def test_a_head_with_no_phone_still_gets_the_in_app_notice(self):
        r = self.remind("missing_punch", self.missing_punch().id)
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(r.json()["push"], "no_device")
        self.assertIn("no phone registered", r.json()["message"])
        self.assertTrue(Notification.objects.filter(employee=self.boss, source="approval_reminder").exists())

    def test_hr_can_switch_the_reminder_push_off(self):
        PushToken.objects.create(employee=self.boss, token="ExponentPushToken[boss]")
        MobileMessageSettings.objects.update_or_create(pk=1, defaults={"disabled_types": ["approval_reminder"]})
        with mock.patch(EXPO) as post:
            r = self.remind("leave", self.leave().id)
        self.assertEqual(r.json()["push"], "off")
        self.assertEqual(post.call_count, 0)
        self.assertTrue(Notification.objects.filter(employee=self.boss).exists())

    def test_once_a_day_per_request(self):
        leave = self.leave()
        other_leave = self.leave(start_date="2026-11-05", end_date="2026-11-05")
        self.assertEqual(self.remind("leave", leave.id).status_code, 200)
        r = self.remind("leave", leave.id)
        self.assertEqual(r.status_code, 429)
        body = r.json()
        self.assertEqual(body["code"], "too_soon")
        self.assertRegex(body["error"], r"You can remind again in (23|24) h \d+ m")
        self.assertIsNotNone(body["nextReminderAt"])
        self.assertTrue(r.has_header("Retry-After"))
        self.assertEqual(ApprovalReminder.objects.filter(request_id=leave.id).count(), 1)
        # another request is its own count
        self.assertEqual(self.remind("leave", other_leave.id).status_code, 200)
        row = self.item(self.get_list(), f"leave-{leave.id}")
        self.assertFalse(row["canRemind"])
        self.assertIsNotNone(row["nextReminderAt"])
        # a day later it opens again
        ApprovalReminder.objects.filter(request_id=leave.id).update(
            created_at=timezone.now() - timedelta(hours=24, minutes=1)
        )
        self.assertTrue(self.item(self.get_list(), f"leave-{leave.id}")["canRemind"])
        self.assertEqual(self.remind("leave", leave.id).status_code, 200)
        self.assertEqual(ApprovalReminder.objects.filter(request_id=leave.id).count(), 2)

    def test_hr_is_reminded_when_hr_holds_the_step(self):
        req = EmployeeRequest.objects.create(
            employee=self.emp, request_type="general", subject="Letter", description="x"
        )
        r = self.remind("request", req.id)
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(r.json()["sentTo"], "hr")
        self.assertEqual(r.json()["message"], "Reminder sent to HR. HR will see it on the Requests page.")
        self.assertEqual(ApprovalReminder.objects.get().sent_to, "hr")
        self.assertFalse(Notification.objects.exists())

        rows = self.client.get("/api/hr/approval-reminders", **self.hr).json()["reminders"]
        self.assertEqual([(x["key"], x["employeeName"]) for x in rows], [(f"request-{req.id}", "Asha Kumar")])
        req.status = "approved"
        req.save()
        self.assertEqual(self.client.get("/api/hr/approval-reminders", **self.hr).json()["reminders"], [])
        self.assertEqual(self.client.get("/api/hr/approval-reminders", **self.me).status_code, 403)

    def test_no_head_who_can_decide_falls_back_to_hr(self):
        ManagerEmployeeAssignment.objects.all().delete()
        r = self.remind("missing_punch", self.missing_punch().id)
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(r.json()["sentTo"], "hr")
        self.assertIn("no Department Head who can approve", r.json()["message"])
        self.assertFalse(Notification.objects.exists())

    def test_a_switched_off_workflow_can_still_be_reminded(self):
        leave = self.leave()
        approval.save_config("leave", enabled=False, actor="test")
        self.assertEqual(self.remind("leave", leave.id).status_code, 200)

    def test_only_the_owner_and_only_while_waiting(self):
        theirs = self.leave(emp=self.other)
        self.assertEqual(self.remind("leave", theirs.id).status_code, 404)
        self.assertEqual(self.remind("leave", theirs.id, self.hr).status_code, 403)
        done = self.leave(status="approved")
        r = self.remind("leave", done.id)
        self.assertEqual((r.status_code, r.json()["code"]), (409, "already_decided"))
        self.assertEqual(self.remind("holiday_work", 1).status_code, 404)
        self.assertEqual(self.remind("leave", 999999).status_code, 404)
        hr_entered = Advance.objects.create(employee=self.emp, advance_type="general", amount=Decimal("100"))
        self.assertEqual(self.remind("advance", hr_entered.id).status_code, 409)
        self.assertFalse(ApprovalReminder.objects.exists())


class MobileMessagesControlTests(TestCase):
    def test_the_reminder_has_its_own_switch(self):
        rows = {row["key"]: row for row in mobile_messages.controls()}
        self.assertIn("approval_reminder", rows)
        self.assertEqual(
            (rows["approval_reminder"]["kind"], rows["approval_reminder"]["group"]), ("message", "approvals")
        )
        self.assertIn("approval_reminder", mobile_messages.valid_keys())

    def test_the_log_names_and_filters_it(self):
        emp = Employee.objects.create(employee_code="L1", first_name="A", last_name="B", status="active")
        Notification.objects.create(employee=emp, type="leave", title="t", message="m", source="approval_reminder")
        hr = HRUser.objects.create(username="rem_hr2", password_hash="x", is_super_admin=True)
        auth = _bearer({"role": "hr", "hrUserId": hr.id, "name": "x"})
        r = self.client.get("/api/mobile-app/messages/log", {"kind": "approval_reminder"}, **auth)
        self.assertEqual(r.status_code, 200, r.content)
        rows = r.json()
        rows = rows.get("items", rows) if isinstance(rows, dict) else rows
        self.assertEqual([x["kind"] for x in rows], ["Approval reminder"])


class HrAttendanceEditTests(Base):
    """Attendance changes HR proposed for the employee (workflow attendance_correction: Department Head, then HR)."""

    def edit(self, emp=None, **kw):
        values = dict(
            date=date(2026, 10, 8),
            previous_values={"status": "absent", "shiftsEarned": 0},
            requested_values={
                "status": "present",
                "typeLabel": "Present",
                "shiftsEarned": 1,
                "firstPunch": "09:00",
                "lastPunch": "18:00",
                "isLate": True,
            },
            reason="Device was down",
            requested_by="Meena",
            approval_trail=[],
        )
        values.update(kw)
        return AttendanceOverrideRequest.objects.create(employee=emp or self.emp, **values)

    def test_a_waiting_hr_edit_is_listed_and_marked_as_raised_by_hr(self):
        mine = self.edit()
        self.edit(emp=self.other)
        leave = self.leave()
        body = self.get_list()
        self.assertEqual({i["key"] for i in body["items"]}, {f"attendance_correction-{mine.id}", f"leave-{leave.id}"})
        row = self.item(body, f"attendance_correction-{mine.id}")
        self.assertEqual((row["raisedBy"], row["raisedByLabel"], row["raisedByName"]), ("hr", "Raised by HR", "Meena"))
        self.assertEqual(row["reason"], "Device was down")
        self.assertEqual(
            row["change"]["text"], "2026-10-08: Absent (0.00 shift) → Present (1.00 shift), 09:00 to 18:00, marked Late"
        )
        self.assertEqual((row["change"]["fromLabel"], row["change"]["toLabel"]), ("Absent", "Present"))
        self.assertEqual(row["stage"], "Waiting for your Department Head (Ravi Shankar)")
        self.assertEqual([s["label"] for s in row["steps"]], ["Department Head", "HR"])
        self.assertTrue(row["canRemind"])
        self.assertIn({"label": "Raised by", "value": "Meena"}, row["details"])
        own = self.item(body, f"leave-{leave.id}")
        self.assertEqual((own["raisedBy"], own["raisedByName"], own["change"]), ("employee", None, None))

    def test_after_the_head_approves_it_waits_for_hr(self):
        req = self.edit()
        approval.decide("attendance_correction", req, HOD, "approved", actor="Ravi Shankar")
        req.save()
        row = self.item(self.get_list(), f"attendance_correction-{req.id}")
        self.assertEqual(row["stage"], "Waiting for HR")

    def test_the_employee_can_remind_the_head_about_it(self):
        req = self.edit()
        r = self.remind("attendance_correction", req.id)
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(r.json()["sentTo"], "hod")
        note = Notification.objects.get(employee=self.boss)
        self.assertTrue(note.message.startswith(OPENING))
        self.assertIn("Attendance correction (raised by HR)", note.message)
        self.assertEqual(note.type, "approval_reminder")
        self.assertEqual(self.remind("attendance_correction", req.id).status_code, 429)
        # someone else's edit cannot be reminded
        theirs = self.edit(emp=self.other)
        self.assertEqual(self.remind("attendance_correction", theirs.id).status_code, 404)

    def test_recently_decided_hr_edits_are_shown_separately(self):
        now = timezone.now()
        approved = self.edit(status="approved", reviewed_by="Meena", reviewed_at=now - timedelta(days=2))
        approved.approval_trail = [
            {"role": "hod", "decision": "approved", "by": "Ravi Shankar", "at": (now - timedelta(days=3)).isoformat()},
            {"role": "hr", "decision": "approved", "by": "Meena", "at": (now - timedelta(days=2)).isoformat()},
        ]
        approved.save()
        rejected = self.edit(
            date=date(2026, 10, 9), status="rejected", review_comment="Punches are there", reviewed_at=now
        )
        old = self.edit(date=date(2026, 9, 1), status="approved", reviewed_at=now - timedelta(days=40))
        AttendanceOverrideRequest.objects.filter(pk=old.pk).update(created_at=now - timedelta(days=41))
        self.edit(emp=self.other, date=date(2026, 10, 10), status="approved", reviewed_at=now)
        pending = self.edit(date=date(2026, 10, 11))

        body = self.get_list()
        self.assertEqual(body["recentDays"], 30)
        recent = body["recentHrEdits"]
        self.assertEqual([r["id"] for r in recent], [rejected.id, approved.id])
        self.assertEqual((recent[0]["statusLabel"], recent[0]["comment"]), ("Rejected", "Punches are there"))
        self.assertEqual(
            (recent[1]["statusLabel"], recent[1]["decidedBy"], recent[1]["decidedByRole"]), ("Approved", "Meena", "hr")
        )
        self.assertEqual(recent[1]["raisedBy"], "hr")
        self.assertIn("Present", recent[1]["change"]["text"])
        self.assertEqual({i["id"] for i in body["items"] if i["module"] == "attendance_correction"}, {pending.id})

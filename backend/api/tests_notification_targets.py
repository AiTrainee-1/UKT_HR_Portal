"""Where a notification's View button leads (notification_targets.py): one test per kind of notification and dedupe-key
pattern (old rows too), the reminder and salary-slip lookups, the push payload, and GET /api/notifications carrying `target`
at a fixed number of queries.

Run via: DATABASE_URL= DB_TEST_NAME=uktex_test_notiftarget python manage.py test api.tests_notification_targets
"""

from datetime import date
from unittest import mock

from django.db import connection
from django.test import SimpleTestCase, TestCase
from django.test.utils import CaptureQueriesContext

from . import approval_workflow as approval
from . import push_messages, whatsapp_approvals, whatsapp_catalog, whatsapp_notifications, whatsapp_service
from .jwt_utils import sign_token
from .models import (
    ApprovalReminder,
    DepartmentManager,
    Employee,
    HRUser,
    LeaveRequest,
    ManagerEmployeeAssignment,
    Notification,
    OnDutySession,
    OutpassRequest,
    PushToken,
    SalarySlip,
)
from .notification_targets import KINDS, build_context, target_for

EXPO = "api.signals.requests.post"
ROLES = {"self", "approver"}
MONTH_NAMES = (
    "January",
    "February",
    "March",
    "April",
    "May",
    "June",
    "July",
    "August",
    "September",
    "October",
    "November",
    "December",
)


def _n(**kw) -> Notification:
    """An unsaved notification, the way a list hands one over."""
    values = {"employee_id": 1, "type": "general", "title": "", "message": "", "source": "", "related_module": ""}
    values.update(kw)
    values.setdefault("dedupe_key", "")
    return Notification(**values)


def T(kind, label, *, id=None, day=None, role="self", category=None) -> dict:
    return {"kind": kind, "id": id, "date": day, "role": role, "category": category, "label": label}


def APPROVALS(category, *, id=None, day=None) -> dict:
    return T("approvals", "Open approvals", id=id, day=day, role="approver", category=category)


def _bearer(payload: dict) -> dict:
    return {"HTTP_AUTHORIZATION": f"Bearer {sign_token(payload)}"}


def _expo_ok(post):
    post.return_value = mock.Mock(ok=True, status_code=200, json=lambda: {"data": [{"status": "ok"}]})


# ── the mapping itself: no database, so a list never pays a query per row for these ───────────────────────────────


class WhatsAppKeyTests(SimpleTestCase):
    """Rows made by push_messages.announce: dedupe_key "wa:<the WhatsApp message's key>"."""

    def target(self, **kw):
        t = target_for(_n(**kw), {})
        if t is not None:
            self.assertIn(t["kind"], KINDS)
            self.assertIn(t["role"], ROLES)
        return t

    def test_an_approval_decision_opens_the_request_on_its_own_page(self):
        one_day = "Your request has been approved.\n\n📅 Date: 30 Oct 2026\n📋 Request: x"
        cases = (
            ("leave", "leave", "leave", "View leave request", "2026-10-30", None),
            ("permission", "permission", "permission", "View permission request", "2026-10-30", None),
            ("casual_leave", "casual_leave", "casual_leave", "View casual leave", "2026-10-30", None),
            ("missing_punch", "missing_punch", "missing_punch", "View missing punch request", "2026-10-30", None),
            ("outpass", "outpass", "outpass", "View outpass request", None, None),
            (
                "attendance_correction",
                "attendance",
                "my_requests",
                "View attendance change",
                "2026-10-30",
                "attendance",
            ),
            ("holiday_work", "compensation", "compensation", "View compensation", "2026-10-30", None),
            ("resignation", "resignation", "resignation", "View resignation", None, None),
            ("advance", "advance", "advance", "View advance", None, None),
            ("request", "employee_request", "request", "View request", None, None),
        )
        for module, ntype, kind, label, day, category in cases:
            for decision, source in (("approved", "approval_approved"), ("rejected", "approval_rejected")):
                with self.subTest(module=module, decision=decision):
                    self.assertEqual(
                        self.target(
                            type=ntype,
                            source=source,
                            related_module=module,
                            message=one_day,
                            dedupe_key=f"wa:approval:{module}:42:{decision}",
                        ),
                        T(kind, label, id=42, day=day, category=category),
                    )

    def test_a_leave_range_has_no_single_date(self):
        t = self.target(
            type="leave",
            source="approval_approved",
            related_module="leave",
            message="📅 Date: 26 Sep 2026 to 27 Sep 2026",
            dedupe_key="wa:approval:leave:7:approved",
        )
        self.assertEqual(t, T("leave", "View leave request", id=7))

    def test_an_approval_message_without_a_key_still_opens_its_page(self):
        # a decision announced before the key existed, or HR's edited wording without the Date line
        self.assertEqual(
            self.target(type="permission", source="approval_rejected", related_module="permission", message="Sorry."),
            T("permission", "View permission request"),
        )
        # no workflow on the row: its type, else My Requests
        self.assertEqual(
            self.target(type="leave", source="approval_approved", message="ok"), T("leave", "View leave request")
        )
        self.assertEqual(
            self.target(type="approval", source="approval_approved", message="ok"), T("my_requests", "View my requests")
        )

    def test_geo_attendance_decisions_open_the_on_duty_session(self):
        for key, source in (("wa:geo:15", "geo_approval"), ("wa:geo:15:rejected", "geo_rejection")):
            with self.subTest(key=key):
                self.assertEqual(
                    self.target(type="on_duty", source=source, related_module="on_duty", dedupe_key=key),
                    T("on_duty", "View On-Duty", id=15),
                )

    def test_a_geo_punch_decision_opens_that_punch_and_its_day(self):
        for key, source in (
            ("wa:geopunch:88", "geo_punch_approval"),
            ("wa:geopunch:88:rejected", "geo_punch_rejection"),
        ):
            with self.subTest(key=key):
                self.assertEqual(
                    self.target(
                        type="on_duty",
                        source=source,
                        related_module="on_duty_punch",
                        message="Your Geo Attendance Check-In has been approved.\n\n📅 Date: 25 Sep 2026\n🕐 Time: 9:12 AM",
                        dedupe_key=key,
                    ),
                    T("geo_punch", "View Geo Punch", id=88, day="2026-09-25"),
                )

    def test_a_whole_session_of_punches_decided_at_once_opens_the_session(self):
        self.assertEqual(
            self.target(
                type="on_duty",
                source="geo_punch_approval",
                related_module="on_duty_punch",
                dedupe_key="wa:geopunches:15:approved:59273011",
            ),
            T("on_duty", "View On-Duty", id=15),
        )

    def test_a_gate_movement_opens_the_gate_pass(self):
        for key, source in (("wa:gate:out:9", "outpass_gate_out"), ("wa:gate:in:9", "outpass_gate_in")):
            with self.subTest(key=key):
                self.assertEqual(
                    self.target(type="outpass", source=source, related_module="outpass", dedupe_key=key),
                    T("outpass", "View gate pass", id=9),
                )

    def test_a_gate_qr_form_record_is_not_an_outpass_request_so_it_has_no_id(self):
        self.assertEqual(
            self.target(
                type="outpass", source="outpass_gate_out", related_module="outpass", dedupe_key="wa:gate:record:3"
            ),
            T("outpass", "View gate pass"),
        )

    def test_attendance_alerts_open_the_day_they_are_about(self):
        # whatsapp_alerts.run_alerts: f"{tag}:{day.iso}:{emp.id}"
        for tag, source in (
            ("late", "late_alert"),
            ("absent", "absent_alert"),
            ("four2", "four_punch_alert"),
            ("missing3", "missing_punch_alert"),
        ):
            with self.subTest(tag=tag):
                self.assertEqual(
                    self.target(type="attendance", source=source, dedupe_key=f"wa:{tag}:2026-10-31:7"),
                    T("attendance", "View attendance for 31 Oct", day="2026-10-31"),
                )

    def test_an_on_duty_punch_reminder_opens_the_geo_punch_for_that_day(self):
        self.assertEqual(
            self.target(type="attendance", source="on_duty_punch_reminder", dedupe_key="wa:duty1:2026-11-02:7"),
            T("geo_punch", "View Geo Punch", day="2026-11-02"),
        )

    def test_an_alert_without_a_key_reads_the_date_line_of_its_wording(self):
        self.assertEqual(
            self.target(
                type="attendance", source="late_alert", message="Hi Asha, you are late.\n\n📅 Date: 05 Oct 2026"
            ),
            T("attendance", "View attendance for 5 Oct", day="2026-10-05"),
        )
        self.assertEqual(self.target(type="attendance", source="absent_alert"), T("attendance", "View attendance"))

    def test_documents_open_their_page(self):
        for source, kind, label in (
            ("id_card", "id_card", "View ID card"),
            ("offer_letter", "documents", "View documents"),
            ("experience_letter", "documents", "View documents"),
            ("resignation_letter", "documents", "View documents"),
            ("other", "documents", "View documents"),
        ):
            with self.subTest(source=source):
                self.assertEqual(self.target(type=source, source=source, message="Attached."), T(kind, label))

    def test_a_salary_slip_without_its_lookup_opens_the_slips(self):
        self.assertEqual(
            self.target(
                type="salary_slip", source="salary_slip", message="Your salary slip for August 2026 is attached."
            ),
            T("salary_slip", "View salary slip"),
        )

    def test_nothing_to_open(self):
        self.assertIsNone(self.target(type="visitors", source="visitor_notification", message="You have a visitor."))
        self.assertIsNone(self.target(type="general", source="manual", title="Hello", message="Canteen closed today."))
        self.assertIsNone(self.target(type="general", message="Welcome to UKTextiles."))
        self.assertIsNone(self.target(type="something_new", message="?"))

    def test_a_message_added_to_the_catalogue_later_follows_its_module(self):
        new = whatsapp_catalog.MessageType(key="pf_statement", label="PF Statement", module="documents", body="x")
        with mock.patch.dict(whatsapp_catalog.TYPES, {"pf_statement": new}):
            self.assertEqual(self.target(type="pf_statement", source="pf_statement"), T("documents", "View documents"))

    def test_an_unknown_key_falls_back_on_the_source(self):
        self.assertEqual(
            self.target(type="attendance", source="late_alert", dedupe_key="wa:something-else"),
            T("attendance", "View attendance"),
        )
        self.assertEqual(
            self.target(
                type="leave",
                source="approval_approved",
                related_module="leave",
                dedupe_key="wa:approval:leave:not-a-number:approved",
            ),
            T("leave", "View leave request"),
        )


class InAppNoticeTests(SimpleTestCase):
    """Rows made with Notification.objects.create (no catalogue source), today's and the older one-liners."""

    def target(self, ntype, message, **kw):
        t = target_for(_n(type=ntype, message=message, **kw), {})
        if t is not None:
            self.assertIn(t["kind"], KINDS)
        return t

    def test_a_department_head_asked_to_decide_gets_approvals_of_that_category(self):
        # approval_workflow.notify_hod_of_request: f"{name}'s {what} is waiting for your approval."
        for ntype, what, category, day in (
            ("leave", "leave request", "leave", None),
            ("permission", "permission request", "permission", None),
            ("casual_leave", "Casual Leave request", "casual_leave", None),
            ("outpass", "Outpass request", "outpass", None),
            ("on_duty", "On-Duty request", "on_duty", None),
            ("resignation", "resignation request", "resignation", None),
            ("attendance_correction", "attendance change for 2026-10-01 (Present)", "attendance", "2026-10-01"),
            ("holiday_work", "holiday-work compensation claim for Sunday 12 Oct 2026", "holiday_work", "2026-10-12"),
        ):
            with self.subTest(ntype=ntype):
                self.assertEqual(
                    self.target(ntype, f"Suresh Raj's {what} is waiting for your approval."),
                    APPROVALS(category, day=day),
                )

    def test_the_older_department_head_notices(self):
        self.assertEqual(
            self.target("missing_punch", "JOSHY. G submitted a Missing Punch request for 2026-08-28."),
            APPROVALS("missing_punch", day="2026-08-28"),
        )
        self.assertEqual(
            self.target("on_duty", "SUBBURAJ. M submitted an On-Duty request -Hdfc mod registeration, coimbatore"),
            APPROVALS("on_duty"),
        )
        self.assertEqual(
            self.target("on_duty", "PRADEEP S submitted an On-Duty Check-In request — Site visit"), APPROVALS("on_duty")
        )
        self.assertEqual(
            self.target("resignation", "Asha Kumar has submitted a resignation request. Please review it."),
            APPROVALS("resignation"),
        )

    def test_the_two_hr_raised_kinds_are_only_ever_sent_to_the_head(self):
        self.assertEqual(self.target("holiday_work", "A claim needs a look."), APPROVALS("holiday_work"))
        self.assertEqual(self.target("attendance_correction", "x"), APPROVALS("attendance"))

    def test_the_employee_told_how_their_own_request_moved(self):
        # approval_workflow.stage_notice / notice_for, and the older wordings of the same notices
        cases = (
            (
                "missing_punch",
                "Your Missing Punch request for 2026-08-28 was approved by your Department Head and is now awaiting HR approval.",
                T("missing_punch", "View missing punch request", day="2026-08-28"),
            ),
            (
                "permission",
                "Your permission request for 2026-08-06 was approved.",
                T("permission", "View permission request", day="2026-08-06"),
            ),
            (
                "casual_leave",
                "Your Casual Leave request for 2026-10-08 was approved by HR.",
                T("casual_leave", "View casual leave", day="2026-10-08"),
            ),
            (
                "leave",
                "Your leave request (2026-07-28 → 2026-07-28) has been approved.",
                T("leave", "View leave request", day="2026-07-28"),
            ),
            (
                "leave",
                "Your leave request (2026-09-04 to 2026-09-06) was approved by your Department Head and is now awaiting HR approval.",
                T("leave", "View leave request"),
            ),
            (
                "attendance",
                "Your attendance change for 2026-10-23 was approved by your Department Head and is now awaiting HR approval.",
                T("my_requests", "View attendance change", day="2026-10-23", category="attendance"),
            ),
            (
                "attendance",
                "Your attendance correction request for 2026-09-02 was approved.",
                T("my_requests", "View attendance change", day="2026-09-02", category="attendance"),
            ),
            (
                "compensation",
                "Your holiday-work compensation claim for Sunday 12 Oct 2026 was approved by your Department Head.",
                T("compensation", "View compensation", day="2026-10-12"),
            ),
            ("outpass", "Your Outpass request for Dominos was Approved.", T("outpass", "View outpass request")),
            (
                "on_duty",
                "Your On-Duty request for Abc textiles was approved by your Department Head and is now awaiting HR approval.",
                T("on_duty", "View On-Duty"),
            ),
            (
                "on_duty",
                "Your On-Duty session ended automatically -all 4 punches for the day are in.",
                T("on_duty", "View On-Duty"),
            ),
            (
                "on_duty",
                "Your On-Duty session for Ukt was closed automatically at the end of the day.",
                T("on_duty", "View On-Duty"),
            ),
            (
                "resignation",
                "Your resignation request has been reviewed and approved by your Department Head. It is now with HR for final approval.",
                T("resignation", "View resignation"),
            ),
            ("employee_request", "Your request 'Salary certificate' is now in progress.", T("request", "View request")),
            (
                "employee_request",
                "New Salary Certificate submitted by Asha Kumar: 'For the bank'",
                T("request", "View request"),
            ),
            ("attendance", "Your attendance was updated.", T("attendance", "View attendance")),
        )
        for ntype, message, expected in cases:
            with self.subTest(message=message):
                self.assertEqual(self.target(ntype, message), expected)

    def test_types_of_pages_nothing_sends_today(self):
        for ntype, kind, label in (
            ("chat", "chat", "Open chat"),
            ("shift", "shift", "View shift"),
            ("holiday", "holidays", "View holidays"),
            ("profile", "profile", "View profile"),
            ("salary_slip", "salary_slip", "View salary slip"),
            ("SALARY_SLIP", "salary_slip", "View salary slip"),
        ):
            with self.subTest(ntype=ntype):
                self.assertEqual(self.target(ntype, "x"), T(kind, label))

    def test_a_reminder_whose_row_is_gone_still_opens_approvals(self):
        message = (
            "Sir, please review this request and provide your approval.\nAsha (R1) - Permission: 2026-10-31 at 11:00."
        )
        self.assertEqual(
            self.target("approval_reminder", message, source="approval_reminder", dedupe_key="reminder:999"),
            APPROVALS(None, day="2026-10-31"),
        )
        # the first reminders were typed by their module
        self.assertEqual(
            self.target("permission", message, source="approval_reminder", dedupe_key="reminder:999"),
            APPROVALS("permission", day="2026-10-31"),
        )

    def test_a_reminder_with_its_row_opens_that_request_in_approvals(self):
        n = _n(
            type="approval_reminder",
            source="approval_reminder",
            dedupe_key="reminder:5",
            message="provide your approval",
        )
        self.assertEqual(target_for(n, {"reminders": {5: ("missing_punch", 31)}}), APPROVALS("missing_punch", id=31))
        self.assertEqual(target_for(n, {"reminders": {5: ("attendance_correction", 8)}}), APPROVALS("attendance", id=8))
        # a kind with no Department Head step has no category, and an id alone would be ambiguous
        self.assertEqual(target_for(n, {"reminders": {5: ("advance", 8)}}), APPROVALS(None))

    def test_a_row_it_cannot_read_gets_no_target_and_is_logged(self):
        with self.assertLogs("api.notification_targets", "ERROR"):
            self.assertIsNone(target_for(object(), {}))


# ── the real producers: the rows they make carry the right target ────────────────────────────────────────────────


class Base(TestCase):
    def setUp(self):
        approval.clear_cache()
        self.addCleanup(approval.clear_cache)
        self.emp = Employee.objects.create(
            employee_code="NT1", first_name="Asha", last_name="Kumar", status="active", employment_type="staff"
        )
        self.boss = Employee.objects.create(
            employee_code="NT9", first_name="Ravi", last_name="Shankar", status="active", employment_type="staff"
        )
        self.manager = DepartmentManager.objects.create(employee=self.boss)
        ManagerEmployeeAssignment.objects.create(manager=self.manager, employee=self.emp)
        self.me = _bearer({"role": "employee", "employeeId": self.emp.id})
        self.head = _bearer({"role": "employee", "employeeId": self.boss.id})
        hr = HRUser.objects.create(username="nt_hr", password_hash="x", is_super_admin=True, full_name="Meena")
        self.hr = _bearer({"role": "hr", "hrUserId": hr.id, "name": "Meena"})

    def leave(self, **kw):
        values = dict(
            type="casual", start_date=date(2026, 11, 3), end_date=date(2026, 11, 3), total_days=1, approval_trail=[]
        )
        values.update(kw)
        return LeaveRequest.objects.create(employee=self.emp, **values)

    def only(self, emp) -> Notification:
        return Notification.objects.get(employee=emp)


class ProducerTests(Base):
    def test_a_final_leave_decision(self):
        leave = self.leave()
        whatsapp_approvals.notify_decision("leave", leave, "approved", approver="Meena", role="hr")
        self.assertEqual(
            target_for(self.only(self.emp)), T("leave", "View leave request", id=leave.id, day="2026-11-03")
        )

    def test_an_on_duty_decision(self):
        session = OnDutySession.objects.create(employee=self.emp, destination="Erode mill", approval_trail=[])
        whatsapp_notifications.notify_geo_session_rejected(session, "Meena", comment="Not today")
        self.assertEqual(target_for(self.only(self.emp)), T("on_duty", "View On-Duty", id=session.id))

    def test_a_gate_out(self):
        req = OutpassRequest.objects.create(employee=self.emp, destination="Bank", reason="Cheque", approval_trail=[])
        whatsapp_notifications.notify_gate_out(req)
        self.assertEqual(target_for(self.only(self.emp)), T("outpass", "View gate pass", id=req.id))

    def test_a_late_alert_under_the_alert_jobs_key(self):
        whatsapp_service.send_notification(
            self.emp,
            "late_alert",
            {"employee_name": "Asha", "date": "31 Oct 2026", "status": "Late"},
            dedupe_key=f"late:2026-10-31:{self.emp.id}",
            asynchronous=False,
        )
        self.assertEqual(
            target_for(self.only(self.emp)), T("attendance", "View attendance for 31 Oct", day="2026-10-31")
        )

    def test_the_head_is_told_a_request_reached_them_and_the_employee_how_it_moved(self):
        approval.notify_hod_of_request("leave", self.emp, "leave request")
        self.assertEqual(target_for(self.only(self.boss)), APPROVALS("leave"))

        outcome = approval.Outcome(kind="advanced", role=approval.HOD, decision="approved", waiting=(approval.HR,))
        what = "Missing Punch request for 2026-10-30"
        approval.stage_notice(self.emp, "missing_punch", approval.notice_for(what, outcome), outcome)
        self.assertEqual(
            target_for(self.only(self.emp)), T("missing_punch", "View missing punch request", day="2026-10-30")
        )

    def test_a_reminder_opens_the_request_in_the_heads_approvals(self):
        leave = self.leave()
        r = self.client.post(
            f"/api/my/pending-requests/leave/{leave.id}/remind", {}, content_type="application/json", **self.me
        )
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(target_for(self.only(self.boss)), APPROVALS("leave", id=leave.id, day="2026-11-03"))

    def test_a_message_hr_typed_opens_nothing(self):
        r = self.client.post(
            "/api/mobile-app/messages/send",
            {"employeeId": self.emp.id, "title": "Canteen", "message": "Closed today."},
            content_type="application/json",
            **self.hr,
        )
        self.assertEqual(r.status_code, 201, r.content)
        self.assertIsNone(target_for(self.only(self.emp)))


class SalarySlipTests(Base):
    def slip(self, month, year, number, **kw):
        return SalarySlip.objects.create(employee=self.emp, month=month, year=year, slip_number=number, **kw)

    def announce(self, month_year: str):
        text = f"💰 *Salary Slip*\n\nHello Asha,\n\nYour salary slip for *{month_year}* is attached.\n\nRegards,\nUK Textiles HRMS"
        return push_messages.announce(self.emp, "salary_slip", text)

    def test_the_slip_of_the_month_the_message_names(self):
        aug = self.slip(8, 2026, "S-AUG")
        self.slip(9, 2026, "S-SEP")
        self.assertEqual(target_for(self.announce("August 2026")), T("salary_slip", "View salary slip", id=aug.id))

    def test_no_id_when_the_month_has_several_slips_or_none(self):
        self.slip(8, 2026, "W1", week_number=1)
        self.slip(8, 2026, "W2", week_number=2)
        self.assertEqual(target_for(self.announce("August 2026")), T("salary_slip", "View salary slip"))
        self.assertEqual(target_for(self.announce("March 2025")), T("salary_slip", "View salary slip"))

    def test_another_employees_slip_is_never_named(self):
        other = Employee.objects.create(employee_code="NT2", first_name="Bala", last_name="M", status="active")
        SalarySlip.objects.create(employee=other, month=8, year=2026, slip_number="S-OTHER")
        self.assertEqual(target_for(self.announce("August 2026")), T("salary_slip", "View salary slip"))

    def test_the_context_of_a_page_is_two_queries_at_most(self):
        self.slip(8, 2026, "S-AUG")
        rem = ApprovalReminder.objects.create(employee=self.emp, module="leave", request_id=4, sent_to="hod:1")
        rows = [self.announce("August 2026"), self.announce("September 2026")]
        rows.append(
            Notification.objects.create(
                employee=self.boss,
                type="approval_reminder",
                source="approval_reminder",
                dedupe_key=f"reminder:{rem.id}",
            )
        )
        rows.append(Notification.objects.create(employee=self.emp, type="leave", message="Your leave was approved."))
        with self.assertNumQueries(2):
            context = build_context(rows)
        with self.assertNumQueries(0):
            for n in rows:
                target_for(n, context)
        with self.assertNumQueries(0):
            build_context([rows[-1]])


# ── the API ──────────────────────────────────────────────────────────────────────────────────────────────────────────


class EndpointTests(Base):
    def make_page(self, n: int) -> None:
        """n of each: a reminder to the head, a salary slip message, an approval decision, a manual message."""
        start = Notification.objects.filter(employee=self.boss, source="salary_slip").count()
        for i in range(start, start + n):
            rem = ApprovalReminder.objects.create(employee=self.emp, module="leave", request_id=100 + i, sent_to="hod")
            Notification.objects.create(
                employee=self.boss,
                type="approval_reminder",
                source="approval_reminder",
                message="Sir, please review this request and provide your approval.",
                dedupe_key=f"reminder:{rem.id}",
            )
            month, year = i % 12 + 1, 2020 + i // 12
            SalarySlip.objects.create(employee=self.boss, month=month, year=year, slip_number=f"NT-{i}")
            Notification.objects.create(
                employee=self.boss,
                type="salary_slip",
                source="salary_slip",
                message=f"Your salary slip for {MONTH_NAMES[month - 1]} {year} is attached.",
            )
            Notification.objects.create(
                employee=self.boss,
                type="leave",
                source="approval_approved",
                related_module="leave",
                message="📅 Date: 03 Nov 2026",
                dedupe_key=f"wa:approval:leave:{500 + i}:approved",
            )
            Notification.objects.create(employee=self.boss, type="general", source="manual", message="Hello")

    def get(self, url="/api/notifications", who=None):
        r = self.client.get(url, **(who or self.head))
        self.assertEqual(r.status_code, 200, r.content)
        return r.json()

    def test_every_row_carries_its_target(self):
        self.make_page(1)
        rows = self.get()
        self.assertEqual(len(rows), 4)
        by_type = {row["type"]: row["target"] for row in rows}
        rem = ApprovalReminder.objects.get()
        slip = SalarySlip.objects.get()
        self.assertEqual(by_type["approval_reminder"], APPROVALS("leave", id=rem.request_id))
        self.assertEqual(by_type["salary_slip"], T("salary_slip", "View salary slip", id=slip.id))
        self.assertEqual(by_type["leave"], T("leave", "View leave request", id=500, day="2026-11-03"))
        self.assertIsNone(by_type["general"])
        # the rest of the row is unchanged
        self.assertEqual(
            set(rows[0]),
            {"id", "employeeId", "employeeName", "type", "title", "message", "isRead", "createdAt", "target"},
        )
        self.assertEqual(rows[0]["employeeName"], "Ravi Shankar")

    def test_a_page_carries_them_too(self):
        self.make_page(2)
        body = self.get("/api/notifications?page=1&pageSize=3")
        self.assertEqual(body["total"], 8)
        self.assertEqual(len(body["items"]), 3)
        self.assertTrue(all("target" in row for row in body["items"]))
        targets = [row["target"] for row in self.get("/api/notifications?page=1&pageSize=50")["items"]]
        self.assertEqual(sum(1 for t in targets if t and t["kind"] == "approvals" and t["id"]), 2)
        self.assertEqual(sum(1 for t in targets if t and t["kind"] == "salary_slip" and t["id"]), 2)

    def test_the_number_of_queries_does_not_grow_with_the_list(self):
        self.make_page(2)
        self.get()  # anything a first request warms up once is not counted
        with CaptureQueriesContext(connection) as small:
            self.assertEqual(len(self.get()), 8)
        self.make_page(6)
        with CaptureQueriesContext(connection) as large:
            self.assertEqual(len(self.get()), 32)
        self.assertEqual(len(large.captured_queries), len(small.captured_queries))
        with CaptureQueriesContext(connection) as paged_small:
            self.get("/api/notifications?page=1&pageSize=4")
        with CaptureQueriesContext(connection) as paged_large:
            self.get("/api/notifications?page=1&pageSize=30")
        self.assertEqual(len(paged_large.captured_queries), len(paged_small.captured_queries))

    def test_marking_one_read_returns_it_with_its_target(self):
        n = Notification.objects.create(
            employee=self.emp, type="permission", message="Your permission request for 2026-08-06 was approved."
        )
        r = self.client.patch(f"/api/notifications/{n.id}/read", **self.me)
        self.assertEqual(r.status_code, 200, r.content)
        self.assertTrue(r.json()["isRead"])
        self.assertEqual(r.json()["target"], T("permission", "View permission request", day="2026-08-06"))

    def test_hr_creating_one_gets_it_back_with_its_target(self):
        r = self.client.post(
            "/api/notifications",
            {"employeeId": self.emp.id, "type": "general", "message": "Hello"},
            content_type="application/json",
            **self.hr,
        )
        self.assertEqual(r.status_code, 201, r.content)
        self.assertIsNone(r.json()["target"])
        self.assertEqual(r.json()["employeeName"], "Asha Kumar")


class PushTests(Base):
    def test_the_push_carries_kind_id_and_category(self):
        PushToken.objects.create(employee=self.boss, token="ExponentPushToken[boss]")
        leave = self.leave()
        with mock.patch(EXPO) as post:
            _expo_ok(post)
            r = self.client.post(
                f"/api/my/pending-requests/leave/{leave.id}/remind", {}, content_type="application/json", **self.me
            )
        self.assertEqual(r.status_code, 200, r.content)
        note = self.only(self.boss)
        self.assertEqual(
            post.call_args.kwargs["json"][0]["data"],
            {
                "type": "approval_reminder",
                "notificationId": note.id,
                "target": {"kind": "approvals", "id": leave.id, "category": "leave"},
            },
        )

    def test_a_push_with_nothing_to_open_has_no_target(self):
        PushToken.objects.create(employee=self.emp, token="ExponentPushToken[me]")
        with mock.patch(EXPO) as post:
            _expo_ok(post)
            n = Notification.objects.create(employee=self.emp, type="general", source="manual", message="Hello")
        self.assertEqual(post.call_args.kwargs["json"][0]["data"], {"type": "general", "notificationId": n.id})

    def test_a_day_alert_push(self):
        PushToken.objects.create(employee=self.emp, token="ExponentPushToken[me]")
        with mock.patch(EXPO) as post:
            _expo_ok(post)
            n = push_messages.announce(
                self.emp,
                "missing_punch_alert",
                "📝 *Missing Punch*\n\nHi.",
                dedupe_key=f"missing1:2026-11-02:{self.emp.id}",
            )
        self.assertEqual(
            post.call_args.kwargs["json"][0]["data"],
            {
                "type": "attendance",
                "notificationId": n.id,
                "target": {"kind": "attendance", "id": None, "category": None},
            },
        )

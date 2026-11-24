"""
Mobile round 2026-11-24: employee sign-in sessions, idempotent writes (offline queue), withdraw my request, my HR
tickets, On-Duty gate pass at submission, named punch slots, and offline On-Duty captures.

Run via: python manage.py test api.tests_mobile_round_20261124 -v 2
"""

from datetime import date, time, timedelta

from django.test import TestCase
from django.utils import timezone
from rest_framework.test import APIClient

from . import employee_sessions
from .clock import FACTORY_TZ
from .geo_attendance_views import expected_slot_times, resolve_on_duty_session
from .jwt_utils import sign_token
from .models import (
    Branch, CasualLeaveRequest, Employee, EmployeeLoginSession, EmployeePermission, EmployeeRequest,
    EmployeeShiftAssignment, IdempotentRequest, LeaveRequest, MissingPunchRequest, OnDutyPunchVerification,
    OnDutySession, OutpassRequest, ShiftTemplate,
)
from .outpass_request_views import _outpass_request_json


def _employee(code: str, branch=None, **extra) -> Employee:
    return Employee.objects.create(
        employee_code=code, first_name="Test", last_name=code, status="active", employment_type="staff",
        join_date="2020-01-01", branch=branch, **extra,
    )


class Base(TestCase):
    def setUp(self):
        super().setUp()
        self.branch = Branch.objects.create(name="Mobile HO", code="MOB-HO")
        self.emp = _employee("MOB1", self.branch)
        self.other = _employee("MOB2", self.branch)
        self.client = APIClient()

    def legacy_headers(self, emp=None) -> dict:
        """A token of the old kind (no session): 7 days, no jti."""
        emp = emp or self.emp
        return {"HTTP_AUTHORIZATION": "Bearer " + sign_token({"role": "employee", "employeeId": emp.id, "name": "x"})}

    def session_headers(self, emp=None) -> dict:
        token = employee_sessions.issue_token(None, emp or self.emp)
        return {"HTTP_AUTHORIZATION": f"Bearer {token}"}

    def call(self, method, path, body=None, headers=None, fmt="json", **extra):
        fn = getattr(self.client, method)
        kwargs = {**(headers or self.legacy_headers()), **extra}
        if body is not None:
            return fn(path, body, format=fmt, **kwargs)
        return fn(path, **kwargs)


# ── Sessions ──────────────────────────────────────────────────────────────


class EmployeeSessionTests(Base):
    def test_a_session_token_works_until_logout_then_is_refused(self):
        headers = self.session_headers()
        self.assertEqual(self.call("get", "/api/auth/me", headers=headers).status_code, 200)
        self.assertEqual(self.call("post", "/api/auth/logout", {}, headers=headers).status_code, 200)
        r = self.call("get", "/api/auth/me", headers=headers)
        self.assertEqual(r.status_code, 401)
        self.assertEqual(r.json()["error"], "Session revoked")
        row = EmployeeLoginSession.objects.get(employee=self.emp)
        self.assertEqual(row.revoked_reason, "logout")

    def test_refresh_keeps_the_same_session(self):
        headers = self.session_headers()
        r = self.call("post", "/api/auth/refresh", {}, headers=headers)
        self.assertEqual(r.status_code, 200, r.content)
        new_headers = {"HTTP_AUTHORIZATION": "Bearer " + r.json()["token"]}
        self.assertEqual(self.call("get", "/api/auth/me", headers=new_headers).status_code, 200)
        self.assertEqual(EmployeeLoginSession.objects.filter(employee=self.emp).count(), 1)
        # ending the session ends every token of it
        self.call("post", "/api/auth/logout", {}, headers=new_headers)
        self.assertEqual(self.call("get", "/api/auth/me", headers=headers).status_code, 401)
        self.assertEqual(self.call("post", "/api/auth/refresh", {}, headers=headers).status_code, 401)

    def test_a_legacy_token_is_upgraded_into_a_session(self):
        r = self.call("post", "/api/auth/refresh", {}, headers=self.legacy_headers())
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(EmployeeLoginSession.objects.filter(employee=self.emp, revoked_at__isnull=True).count(), 1)

    def test_ending_all_sessions(self):
        headers = self.session_headers()
        self.assertEqual(employee_sessions.end_all(self.emp, "hr"), 1)
        self.assertEqual(self.call("get", "/api/auth/me", headers=headers).status_code, 401)


# ── Idempotency ───────────────────────────────────────────────────────────


class IdempotencyTests(Base):
    BODY = {"requestType": "general", "subject": "Need my Form 16", "description": "For tax filing"}

    def test_the_same_write_twice_is_done_once(self):
        first = self.call("post", "/api/employee-requests", self.BODY, HTTP_IDEMPOTENCY_KEY="key-abcdef-123")
        second = self.call("post", "/api/employee-requests", self.BODY, HTTP_IDEMPOTENCY_KEY="key-abcdef-123")
        self.assertEqual(first.status_code, 201, first.content)
        self.assertEqual(second.status_code, 201)
        self.assertEqual(second["Idempotent-Replayed"], "true")
        self.assertEqual(first.json()["id"], second.json()["id"])
        self.assertEqual(EmployeeRequest.objects.filter(employee=self.emp).count(), 1)

    def test_keys_are_per_person(self):
        self.call("post", "/api/employee-requests", self.BODY, HTTP_IDEMPOTENCY_KEY="key-shared-1")
        self.call("post", "/api/employee-requests", self.BODY, headers=self.legacy_headers(self.other),
                  HTTP_IDEMPOTENCY_KEY="key-shared-1")
        self.assertEqual(EmployeeRequest.objects.count(), 2)

    def test_a_key_reused_for_another_path_is_refused(self):
        self.call("post", "/api/employee-requests", self.BODY, HTTP_IDEMPOTENCY_KEY="key-reuse-12")
        r = self.call("post", "/api/permissions", {"date": "2026-11-24"}, HTTP_IDEMPOTENCY_KEY="key-reuse-12")
        self.assertEqual(r.status_code, 422)

    def test_a_final_refusal_is_replayed_and_a_retryable_one_is_not_kept(self):
        bad = {"requestType": "general", "subject": "x"}
        r1 = self.call("post", "/api/employee-requests", bad, HTTP_IDEMPOTENCY_KEY="key-bad-1234")
        r2 = self.call("post", "/api/employee-requests", bad, HTTP_IDEMPOTENCY_KEY="key-bad-1234")
        self.assertEqual((r1.status_code, r2.status_code), (400, 400))
        self.assertEqual(r2["Idempotent-Replayed"], "true")
        # no token: passed through untouched, nothing remembered
        anon = self.client.post("/api/employee-requests", self.BODY, format="json", HTTP_IDEMPOTENCY_KEY="key-anon-123")
        self.assertEqual(anon.status_code, 401)
        self.assertFalse(IdempotentRequest.objects.filter(key="key-anon-123").exists())

    def test_without_the_header_nothing_changes(self):
        self.call("post", "/api/employee-requests", self.BODY)
        self.call("post", "/api/employee-requests", self.BODY)
        self.assertEqual(EmployeeRequest.objects.filter(employee=self.emp).count(), 2)
        self.assertEqual(IdempotentRequest.objects.count(), 0)


# ── Withdraw + my HR tickets ──────────────────────────────────────────────


class WithdrawTests(Base):
    def url(self, module, pk):
        return f"/api/my/requests/{module}/{pk}/withdraw"

    def test_own_pending_requests_can_be_withdrawn(self):
        leave = LeaveRequest.objects.create(employee=self.emp, start_date="2026-11-28", end_date="2026-11-28")
        perm = EmployeePermission.objects.create(employee=self.emp, date=date(2026, 11, 28))
        cl = CasualLeaveRequest.objects.create(employee=self.emp, date=date(2026, 11, 28))
        for module, obj in (("leave", leave), ("permission", perm), ("casual_leave", cl)):
            r = self.call("post", self.url(module, obj.pk), {})
            self.assertEqual(r.status_code, 200, r.content)
            self.assertTrue(r.json()["withdrawn"])
            self.assertFalse(type(obj).objects.filter(pk=obj.pk).exists())

    def test_a_request_half_way_through_its_pipeline_can_still_be_withdrawn(self):
        leave = LeaveRequest.objects.create(
            employee=self.emp, start_date="2026-11-28", end_date="2026-11-28", status="pending",
            approval_trail=[{"role": "hod", "decision": "approved", "by": "Head", "at": timezone.now().isoformat()}],
        )
        self.assertEqual(self.call("post", self.url("leave", leave.pk), {}).status_code, 200)

    def test_a_decided_request_cannot_be_withdrawn(self):
        leave = LeaveRequest.objects.create(
            employee=self.emp, start_date="2026-11-28", end_date="2026-11-28", status="approved"
        )
        r = self.call("post", self.url("leave", leave.pk), {})
        self.assertEqual(r.status_code, 409)
        self.assertEqual(r.json()["code"], "not_pending")
        self.assertTrue(LeaveRequest.objects.filter(pk=leave.pk).exists())

    def test_someone_elses_request_is_not_found(self):
        leave = LeaveRequest.objects.create(employee=self.other, start_date="2026-11-28", end_date="2026-11-28")
        self.assertEqual(self.call("post", self.url("leave", leave.pk), {}).status_code, 404)
        self.assertTrue(LeaveRequest.objects.filter(pk=leave.pk).exists())

    def test_sensitive_kinds_are_not_withdrawable(self):
        mp = MissingPunchRequest.objects.create(
            employee=self.emp, date=date(2026, 11, 20), punch_time=time(9, 0), punch_slot="punch1", reason="x"
        ) if hasattr(MissingPunchRequest, "punch_slot") else None
        for module in ("missing_punch", "on_duty", "outpass"):
            r = self.call("post", self.url(module, mp.pk if mp else 1), {})
            self.assertEqual(r.status_code, 400)
            self.assertEqual(r.json()["code"], "not_withdrawable")


class MyHrTicketsTests(Base):
    def test_an_employee_lists_only_their_own_tickets(self):
        EmployeeRequest.objects.create(employee=self.emp, request_type="general", subject="Mine", description="")
        EmployeeRequest.objects.create(employee=self.other, request_type="general", subject="Theirs", description="")
        r = self.call("get", "/api/employee-requests")
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual([row["subject"] for row in r.json()], ["Mine"])

    def test_the_mobile_apps_snake_case_body_is_read(self):
        r = self.call("post", "/api/employee-requests", {"request_type": "general", "subject": "Need my Form 16"})
        self.assertEqual(r.status_code, 201, r.content)

    def test_a_short_subject_is_refused(self):
        self.assertEqual(
            self.call("post", "/api/employee-requests", {"requestType": "general", "subject": "Hi"}).status_code, 400
        )


# ── On-Duty: gate pass at submission, named slots, offline captures ─────────


class OnDutyGatePassTests(Base):
    def submit(self, destination="Client site, Tiruppur"):
        r = self.call("post", "/api/on-duty-sessions/request", {"destination": destination})
        self.assertEqual(r.status_code, 201, r.content)
        return OnDutySession.objects.get(pk=r.json()["sessionId"]), r.json()

    def test_the_pass_is_raised_at_submission_but_has_no_qr_until_approved(self):
        session, body = self.submit()
        passes = OutpassRequest.objects.filter(on_duty_session=session)
        self.assertEqual(passes.count(), 1)
        gate_pass = passes.get()
        self.assertEqual(gate_pass.status, "pending")
        self.assertEqual(gate_pass.source, "on_duty")
        self.assertEqual(body["gatePass"]["id"], gate_pass.id)
        data = _outpass_request_json(gate_pass)
        self.assertEqual(data["scanStatus"], "not_applicable")
        self.assertIsNone(data["qrToken"])
        self.assertEqual(data["onDutySessionId"], session.id)
        # the On-Duty page gets the same card
        status = self.call("get", "/api/on-duty-sessions/status").json()
        self.assertEqual(status["gatePass"]["id"], gate_pass.id)
        # the QR comes with the final approval
        resolve_on_duty_session(session, "hr", "approved", "HR Person", None)
        gate_pass.refresh_from_db()
        data = _outpass_request_json(gate_pass)
        self.assertEqual(data["scanStatus"], "pending_exit")
        self.assertTrue(data["qrToken"])

    def test_a_second_session_is_refused_while_one_is_open(self):
        self.submit()
        r = self.call("post", "/api/on-duty-sessions/request", {"destination": "Another place"})
        self.assertEqual(r.status_code, 409)

    def test_approval_approves_the_same_pass_and_rejection_voids_it(self):
        session, _ = self.submit()
        resolve_on_duty_session(session, "hr", "approved", "HR Person", None)
        passes = OutpassRequest.objects.filter(on_duty_session=session)
        self.assertEqual(passes.count(), 1)
        self.assertEqual(passes.get().status, "approved")
        self.assertIsNotNone(passes.get().outpass_record_id)

        self.call("post", "/api/on-duty-sessions/complete", {})
        session2, _ = self.submit("Supplier visit")
        resolve_on_duty_session(session2, "hr", "rejected", "HR Person", "Not needed")
        gate_pass = OutpassRequest.objects.get(on_duty_session=session2)
        self.assertEqual(gate_pass.status, "rejected")
        self.assertEqual(_outpass_request_json(gate_pass)["scanStatus"], "not_applicable")
        self.assertIsNone(_outpass_request_json(gate_pass)["qrToken"])

    def test_hr_cannot_decide_an_on_duty_pass_on_its_own(self):
        session, _ = self.submit()
        gate_pass = OutpassRequest.objects.get(on_duty_session=session)
        from .models import HRUser

        hr = HRUser.objects.create(username="mob_admin", password_hash="x", is_super_admin=True, full_name="Admin")
        headers = {"HTTP_AUTHORIZATION": "Bearer " + sign_token({"role": "hr", "hrUserId": hr.id, "name": "Admin"})}
        r = self.call("put", f"/api/outpass-requests/{gate_pass.pk}/hr-status", {"status": "approved"}, headers=headers)
        self.assertEqual(r.status_code, 409, r.content)
        self.assertEqual(r.json()["code"], "decided_with_on_duty")
        gate_pass.refresh_from_db()
        self.assertEqual(gate_pass.status, "pending")
        # HR's queue of passes to decide leaves it out; the employee's own list shows it
        hr_list = self.call("get", "/api/outpass-requests?status=pending", headers=headers).json()
        self.assertNotIn(gate_pass.id, [row["id"] for row in hr_list])
        mine = self.call("get", "/api/outpass-requests").json()
        self.assertIn(gate_pass.id, [row["id"] for row in mine])


class OnDutySlotTests(Base):
    def test_slots_have_names_and_expected_times_from_the_shift(self):
        shift = ShiftTemplate.objects.create(
            name="General", start_time=time(9, 0), end_time=time(18, 0), first_half_end=time(13, 0),
            lunch_duration_minutes=45, shift_type="staff",
        )
        EmployeeShiftAssignment.objects.create(employee=self.emp, shift=shift, effective_from=date(2020, 1, 1))
        times, source = expected_slot_times(self.emp, date(2026, 11, 24))
        self.assertEqual(source, "shift")
        self.assertEqual(times, {1: time(9, 0), 2: time(13, 0), 3: time(13, 45), 4: time(18, 0)})

        self.call("post", "/api/on-duty-sessions/request", {"destination": "Site"})
        slots = self.call("get", "/api/on-duty-sessions/status").json()["punchSlots"]
        self.assertEqual([s["name"] for s in slots], ["Morning Punch", "Lunch Out", "Lunch In", "Night Punch"])
        self.assertEqual([s["expectedTime"] for s in slots], ["09:00", "13:00", "13:45", "18:00"])

    def test_without_a_shift_the_usual_day_is_used(self):
        times, source = expected_slot_times(self.emp, date(2026, 11, 24))
        self.assertEqual(source, "default")
        self.assertEqual(times[1], time(9, 0))


class OfflineCaptureTests(Base):
    PHOTO = b"\xff\xd8\xff\xe0" + b"0" * 200

    def punch(self, **fields):
        from django.core.files.uploadedfile import SimpleUploadedFile

        body = {
            "latitude": "11.0", "longitude": "77.0", "photo": SimpleUploadedFile("a.jpg", self.PHOTO, "image/jpeg"),
            "photo2": SimpleUploadedFile("b.jpg", self.PHOTO, "image/jpeg"), **fields,
        }
        return self.call("post", "/api/on-duty-sessions/punch", body, fmt="multipart")

    def test_a_queued_punch_is_recorded_at_its_capture_time(self):
        session = OnDutySession.objects.create(employee=self.emp, destination="Site", branch=self.branch)
        captured = timezone.now() - timedelta(minutes=30)
        r = self.punch(capturedAt=captured.isoformat(), sessionId=str(session.id), punchNumber="4")
        self.assertEqual(r.status_code, 201, r.content)
        v = OnDutyPunchVerification.objects.get(pk=r.json()["verificationId"])
        local = captured.astimezone(FACTORY_TZ)
        self.assertEqual(v.punch_time.replace(microsecond=0), local.time().replace(microsecond=0))
        self.assertEqual(v.punch_number, 4)

    def test_a_capture_in_the_future_or_after_the_session_is_refused(self):
        session = OnDutySession.objects.create(employee=self.emp, destination="Site", branch=self.branch)
        future = timezone.now() + timedelta(hours=1)
        self.assertEqual(self.punch(capturedAt=future.isoformat(), sessionId=str(session.id)).status_code, 400)
        session.employee_ended_at = timezone.now() - timedelta(hours=1)
        session.save()
        later = timezone.now() - timedelta(minutes=5)
        r = self.punch(capturedAt=later.isoformat(), sessionId=str(session.id))
        self.assertEqual(r.status_code, 409)
        self.assertEqual(r.json()["code"], "session_ended")

    def test_a_punch_queued_before_its_queued_request_reached_the_server_finds_that_session(self):
        captured = timezone.now() - timedelta(minutes=20)
        if captured.astimezone(FACTORY_TZ).date() != timezone.now().astimezone(FACTORY_TZ).date():
            self.skipTest("too close to midnight")
        session = OnDutySession.objects.create(employee=self.emp, destination="Site", branch=self.branch)
        r = self.punch(capturedAt=captured.isoformat(), punchNumber="1")
        self.assertEqual(r.status_code, 201, r.content)
        self.assertEqual(OnDutyPunchVerification.objects.get(pk=r.json()["verificationId"]).session_id, session.id)

    def test_ending_an_already_ended_session_again_is_harmless(self):
        session = OnDutySession.objects.create(employee=self.emp, destination="Site", branch=self.branch)
        first = self.call("post", "/api/on-duty-sessions/complete", {"sessionId": session.id})
        self.assertEqual(first.status_code, 200, first.content)
        again = self.call("post", "/api/on-duty-sessions/complete", {"sessionId": session.id})
        self.assertEqual(again.status_code, 200, again.content)
        self.assertTrue(again.json()["alreadyEnded"])


# ── QR only after approval at the gate, and OT punches ─────────────────────


class GateRefusesAPendingPassTests(Base):
    def test_pass_presentable_needs_an_approval(self):
        from .outpass_request_views import pass_presentable, pass_window

        session = OnDutySession.objects.create(employee=self.emp, destination="Site", branch=self.branch)
        gate_pass = OutpassRequest.objects.create(
            employee=self.emp, destination="Site", reason="Site", status="pending", source="on_duty",
            on_duty_session=session,
        )
        self.assertFalse(pass_presentable(gate_pass))
        self.assertEqual(pass_window(gate_pass), (None, None))
        manual = OutpassRequest.objects.create(employee=self.emp, destination="Bank", reason="Cash")
        self.assertFalse(pass_presentable(manual))


class OvertimePunchTests(OfflineCaptureTests):
    def open_session(self):
        r = self.call("post", "/api/on-duty-sessions/request", {"destination": "Client site"})
        self.assertEqual(r.status_code, 201, r.content)
        return OnDutySession.objects.get(pk=r.json()["sessionId"])

    def ot(self, **fields):
        from django.core.files.uploadedfile import SimpleUploadedFile

        body = {
            "latitude": "11.0", "longitude": "77.0", "photo": SimpleUploadedFile("a.jpg", self.PHOTO, "image/jpeg"),
            "photo2": SimpleUploadedFile("b.jpg", self.PHOTO, "image/jpeg"), **fields,
        }
        return self.call("post", "/api/on-duty-sessions/ot-punch", body, fmt="multipart")

    def test_ot_punches_need_the_four_first(self):
        self.open_session()
        r = self.ot()
        self.assertEqual(r.status_code, 409)
        self.assertEqual(r.json()["code"], "regular_punches_missing")

    def test_the_4th_punch_keeps_the_session_open_when_asked_and_ot_punches_follow(self):
        from .models import AttendanceLog, OnDutyOvertimePunch

        session = self.open_session()
        for n in (1, 2, 3):
            self.assertEqual(self.punch(punchNumber=str(n)).status_code, 201)
        fourth = self.punch(punchNumber="4", autoEnd="false")
        self.assertEqual(fourth.status_code, 201, fourth.content)
        self.assertTrue(fourth.json()["allPunchesIn"])
        self.assertFalse(fourth.json()["sessionEnded"])
        session.refresh_from_db()
        self.assertIsNone(session.employee_ended_at)

        first = self.ot()
        second = self.ot()
        self.assertEqual((first.status_code, second.status_code), (201, 201), first.content)
        self.assertEqual([first.json()["otPunch"]["sequence"], second.json()["otPunch"]["sequence"]], [1, 2])
        self.assertEqual(OnDutyOvertimePunch.objects.filter(session=session).count(), 2)
        self.assertFalse(AttendanceLog.objects.filter(employee=self.emp).exists())  # never attendance

        status = self.call("get", "/api/on-duty-sessions/status").json()
        self.assertEqual(len(status["otPunches"]), 2)
        self.assertTrue(status["regularPunchesDone"])

        resolve_on_duty_session(session, "hr", "approved", "HR Person", None)
        self.assertEqual(
            set(OnDutyOvertimePunch.objects.filter(session=session).values_list("status", flat=True)), {"approved"}
        )

    def test_an_old_app_still_ends_the_session_at_the_4th_punch(self):
        session = self.open_session()
        for n in (1, 2, 3, 4):
            r = self.punch(punchNumber=str(n))
        self.assertTrue(r.json()["sessionEnded"])
        session.refresh_from_db()
        self.assertIsNotNone(session.employee_ended_at)

    def test_a_rejected_request_rejects_its_ot_punches(self):
        from .models import OnDutyOvertimePunch

        session = self.open_session()
        for n in (1, 2, 3):
            self.punch(punchNumber=str(n))
        self.punch(punchNumber="4", autoEnd="false")
        self.ot()
        resolve_on_duty_session(session, "hr", "rejected", "HR Person", "Not needed")
        self.assertEqual(OnDutyOvertimePunch.objects.get(session=session).status, "rejected")


class OvertimeDetectionWithOtPunchTests(TestCase):
    def test_a_later_ot_punch_extends_the_day_only_when_later(self):
        from .overtime import with_ot_punch

        shift = ShiftTemplate(name="G", start_time=time(9, 0), end_time=time(18, 0), shift_type="staff")
        self.assertEqual(with_ot_punch(30, time(18, 30), time(20, 0), shift), (120, time(20, 0)))
        self.assertEqual(with_ot_punch(30, time(18, 30), time(18, 10), shift), (30, time(18, 30)))
        self.assertEqual(with_ot_punch(0, time(17, 0), None, shift), (0, time(17, 0)))


class HrSeesOvertimePunchesTests(OvertimePunchTests):
    def test_the_hr_list_and_photo_carry_the_ot_punches(self):
        from .models import HRUser

        self.open_session()
        for n in (1, 2, 3):
            self.punch(punchNumber=str(n))
        self.punch(punchNumber="4", autoEnd="false")
        ot = self.ot().json()["otPunch"]
        hr = HRUser.objects.create(username="mob_ot_admin", password_hash="x", is_super_admin=True, full_name="Admin")
        headers = {"HTTP_AUTHORIZATION": "Bearer " + sign_token({"role": "hr", "hrUserId": hr.id, "name": "Admin"})}
        rows = self.call("get", "/api/on-duty-sessions?status=all", headers=headers).json()
        row = next(r for r in rows if r["employeeId"] == self.emp.id)
        self.assertEqual([p["sequence"] for p in row["otPunches"]], [1])
        self.assertEqual(self.call("get", f"/api/on-duty-overtime-punches/{ot['id']}/photo", headers=headers).status_code, 200)
        other = {"HTTP_AUTHORIZATION": "Bearer " + sign_token({"role": "employee", "employeeId": self.other.id})}
        self.assertEqual(self.call("get", f"/api/on-duty-overtime-punches/{ot['id']}/photo", headers=other).status_code, 403)


class AttendanceDaySheetTests(OvertimePunchTests):
    def test_each_day_lists_every_punch_with_its_source_and_the_shift_it_earned(self):
        from .models import AttendanceLog

        today = timezone.now().astimezone(FACTORY_TZ).date()
        AttendanceLog.objects.create(
            employee=self.emp, date=today, punch_time=time(8, 58), punch_type="IN", source="biometric"
        )
        AttendanceLog.objects.create(
            employee=self.emp, date=today, punch_time=time(13, 0), punch_type="OUT", source="geo:auto"
        )
        self.open_session()
        self.punch(punchNumber="3")  # an On-Duty punch still waiting for HR
        self.punch(punchNumber="4", autoEnd="false")
        self.ot()
        body = self.call(
            "get", f"/api/attendance/employee/{self.emp.id}?month={today.month}&year={today.year}"
        ).json()
        day = next(r for r in body["records"] if r["date"] == today.isoformat())
        kinds = [p["kind"] for p in day["allPunches"]]
        self.assertEqual(kinds[:2], ["biometric", "geo"])
        self.assertIn("on_duty", kinds)
        self.assertIn("ot", kinds)
        ot = next(p for p in day["allPunches"] if p["kind"] == "ot")
        self.assertFalse(ot["counted"])
        self.assertIn("shiftsEarned", day)
        self.assertEqual(len(day["punches"]), 2)  # the old list is unchanged: attendance punches only

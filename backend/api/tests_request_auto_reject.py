"""
Settings -> Auto-Reject Requests (owner 2026-11-24): every request nobody decided within N days (45) of being submitted is
rejected automatically, nightly and by Run now; resignations never are.

  A. every kind: the module's own rejected status and stamps, the trail entry, the side effects (On-Duty punches voided and
     tracking ended, the Casual Leave day's attendance), resignations and decided requests never touched
  B. the employee: the in-app notice + phone push a manual rejection gives, and no WhatsApp at all
  C. the age: counted from the India day it was submitted, exactly N days is not due, N + 1 is; days changed; switch off
  D. safety: a request decided meanwhile is left alone, a second run rejects nothing, one failure does not stop the run,
     a finalized payroll month keeps its attendance, the Casual Leave / compensation holds are freed
  E. the endpoints: config + due preview, validation, who may change / run, branch scoping, history, Activity Logs

Run via: DB_TEST_NAME=test_uktex_autorej python manage.py test api.tests_request_auto_reject --noinput
"""

from datetime import date, datetime, time, timedelta, timezone as dt_timezone
from decimal import Decimal
from unittest import mock

from django.test import SimpleTestCase
from django.utils import timezone

from . import compensation_claims, cl_balance
from .clock import FACTORY_TZ, ist_today
from .jwt_utils import sign_token
from .models import (
    AdvanceDecision,
    AttendanceDayRecord,
    AttendanceLog,
    AttendanceOverrideRequest,
    AuditLog,
    AutoRejectedRequest,
    CasualLeaveRequest,
    EmployeePermission,
    EmployeeRequest,
    HolidayWorkClaim,
    HRUser,
    LeaveRequest,
    Notification,
    OnDutyPunchVerification,
    OnDutySession,
    OutpassRequest,
    PayrollMonthClose,
    RequestAutoRejectSettings,
    ResignationRequest,
    Role,
    WhatsAppMessageLog,
)
from .request_auto_reject import engine, scheduler, service
from .tests_hr_requests import HubFixture

TODAY = date(2026, 11, 24)
AUTO = "Automatic rejection"
CONFIG = "/api/request-auto-reject/config"
RUN_NOW = "/api/request-auto-reject/run-now"
HISTORY = "/api/request-auto-reject/history"


def at_ist(day: date, hh: int = 12, mm: int = 0, ss: int = 0) -> datetime:
    return datetime.combine(day, time(hh, mm, ss), tzinfo=FACTORY_TZ)


def age(obj, days: int, today: date = TODAY, hh: int = 12, mm: int = 0, ss: int = 0):
    """Make `obj` submitted `days` India days before `today` (at hh:mm:ss India time)."""
    type(obj).objects.filter(pk=obj.pk).update(created_at=at_ist(today - timedelta(days=days), hh, mm, ss))
    obj.refresh_from_db()
    return obj


def bearer(user: HRUser, name: str = "Meena") -> dict:
    return {"HTTP_AUTHORIZATION": f"Bearer {sign_token({'role': 'hr', 'hrUserId': user.id, 'name': name})}"}


class AutoRejectBase(HubFixture):
    """The hub's fixture (two branches, Asha at the head office, Ravi at Unit 2) with every WhatsApp entry point mocked."""

    def setUp(self):
        super().setUp()
        self.wa = {}
        for target in (
            "api.whatsapp_service.send_notification",
            "api.whatsapp_approvals.notify_decision",
            "api.whatsapp_notifications.notify_geo_session_rejected",
            "api.whatsapp_notifications.notify_geo_punch_rejected",
            "api.whatsapp_hod.request_waiting",
        ):
            patcher = mock.patch(target)
            self.wa[target] = patcher.start()
            self.addCleanup(patcher.stop)
        track = mock.patch("api.geo_tracking.sessions.end_track_for_session")
        self.end_track = track.start()
        self.addCleanup(track.stop)

    def assert_no_whatsapp(self):
        for target, m in self.wa.items():
            self.assertFalse(m.called, f"{target} must not be called")
        self.assertEqual(WhatsAppMessageLog.objects.count(), 0)

    def old_of_each(self, emp=None, days: int = 50):
        made = self.one_of_each(emp)
        for obj in made.values():
            age(obj, days)
        return made

    def go(self, **kw):
        kw.setdefault("today", TODAY)
        return service.run(**kw)

    def last_trail(self, obj):
        obj.refresh_from_db()
        return obj.approval_trail[-1]


# ───────────────────────────── A. every kind ─────────────────────────────


class EveryKindTests(AutoRejectBase):
    def test_every_kind_but_resignation_is_rejected_the_way_its_module_rejects_it(self):
        made = self.old_of_each()
        summary = self.go()
        # the On-Duty punch of the One-Duty request is voided with it (and listed on its own history row)
        self.assertEqual(summary["rejected"], 12)
        self.assertEqual(summary["failed"], 0)
        self.assertEqual(set(summary["byKind"]), set(engine.AUTO_KINDS))
        remark = "Automatically rejected: no decision within 45 days of being submitted (submitted 5 Oct 2026)."

        for key, obj in made.items():
            obj.refresh_from_db()
            if key == "resignation":
                self.assertEqual(obj.status, "pending", "a resignation is never rejected automatically")
                continue
            self.assertEqual(obj.status, "rejected", key)

        leave = made["leave"]
        self.assertEqual((leave.approved_by, leave.approver_role, leave.hr_comment), (AUTO, "hr", remark))
        perm = made["permission"]
        self.assertEqual((perm.approved_by, perm.approver_role, perm.hr_comment), (AUTO, "hr", remark))
        cl = made["casual_leave"]
        self.assertEqual((cl.reviewed_by, cl.reviewer_role, cl.review_comment), (AUTO, "hr", remark))
        self.assertIsNotNone(cl.reviewed_at)
        mp = made["missing_punch"]
        self.assertEqual((mp.hr_reviewed_by, mp.hr_review_comment), (AUTO, remark))
        self.assertIsNone(mp.hod_reviewed_by, "no Department Head decision is faked")
        self.assertFalse(AttendanceLog.objects.filter(employee=self.asha, date=mp.date).exists(), "no punch written")
        od = made["on_duty"]
        self.assertEqual((od.hr_reviewed_by, od.hr_review_comment), (AUTO, remark))
        self.assertIsNone(od.hod_reviewed_by)
        ac = made["attendance_correction"]
        self.assertEqual((ac.reviewed_by, ac.review_comment), (AUTO, remark))
        hw = made["holiday_work"]
        self.assertEqual((hw.reviewed_by, hw.review_comment), (AUTO, remark))
        self.assertFalse(hw.ledger_entries.exists(), "nothing credited")
        op = made["outpass"]
        self.assertEqual((op.approved_by, op.approver_role, op.review_comment), (AUTO, "hr", remark))
        self.assertIsNone(op.outpass_record_id, "no pass issued")
        self.assertIsNone(op.approved_at)
        rq = made["request"]
        self.assertEqual((rq.handled_by, rq.hr_notes), (AUTO, remark))
        self.assertIsNotNone(rq.handled_at)
        adv = made["advance"]
        self.assertEqual((adv.approved_by, adv.decision_remark), (AUTO, remark))
        self.assertIsNotNone(adv.decided_at)
        decision = AdvanceDecision.objects.get(advance=adv)
        self.assertEqual((decision.action, decision.actor_name, decision.remark), ("rejected", AUTO, remark))
        self.assertEqual(decision.requested_amount, Decimal("5000"))
        self.assertIsNone(decision.approved_amount)

    def test_the_trail_says_hr_rejected_it_automatically_with_the_remark(self):
        made = self.old_of_each()
        self.go()
        for key in (
            "leave",
            "permission",
            "casual_leave",
            "missing_punch",
            "on_duty",
            "attendance_correction",
            "holiday_work",
            "outpass",
        ):
            entry = self.last_trail(made[key])
            self.assertEqual(entry["role"], "hr", key)
            self.assertEqual(entry["decision"], "rejected", key)
            self.assertEqual(entry["by"], AUTO, key)
            self.assertIs(entry["auto"], True, key)
            self.assertTrue(entry["at"], key)
            self.assertTrue(entry["comment"].startswith("Automatically rejected: no decision within 45 days"), key)
            self.assertNotIn("runBy", entry, "the nightly run is nobody")

    def test_the_requests_hub_shows_the_automatic_decision(self):
        made = self.old_of_each()
        self.go()
        items = self.body(status="rejected")["items"]
        leave = next(i for i in items if i["kind"] == "leave" and i["id"] == made["leave"].id)
        self.assertEqual(leave["decided"]["by"], AUTO)
        self.assertEqual(leave["decided"]["role"], "hr")
        self.assertIn("45 days", leave["decided"]["comment"])

    def test_an_on_duty_request_voids_its_waiting_punches_and_ends_tracking(self):
        made = self.old_of_each()
        self.go()
        punch = made["on_duty_punch"]
        punch.refresh_from_db()
        self.assertEqual(punch.status, "rejected")
        self.assertEqual(punch.hr_reviewed_by, AUTO)
        self.assertIn("automatic rejection", punch.hr_review_comment)
        self.end_track.assert_called_once()
        session, reason = self.end_track.call_args.args
        self.assertEqual((session.pk, reason), (made["on_duty"].pk, "rejected"))
        rows = {r.kind: r for r in AutoRejectedRequest.objects.filter(kind__in=("on_duty", "on_duty_punch"))}
        self.assertEqual(rows["on_duty"].effects["voidedPunches"], 1)
        self.assertEqual(rows["on_duty_punch"].effects["voidedWith"], {"kind": "on_duty", "id": made["on_duty"].pk})
        self.assertFalse(AttendanceLog.objects.filter(employee=self.asha).exists(), "a voided punch never counts")

    def test_a_waiting_punch_of_an_approved_on_duty_request_is_rejected_on_its_own(self):
        session = OnDutySession.objects.create(
            employee=self.asha, destination="Mill", branch=self.ho, status="active", approval_trail=[]
        )
        punch = age(
            OnDutyPunchVerification.objects.create(
                session=session,
                employee=self.asha,
                punch_date=date(2026, 10, 1),
                punch_time=time(9, 0),
                punch_type="IN",
                punch_number=1,
                latitude=11.1,
                longitude=77.3,
                photo="on_duty_punch_verifications/y.jpg",
            ),
            60,
        )
        self.go()
        punch.refresh_from_db()
        session.refresh_from_db()
        self.assertEqual((punch.status, punch.hr_reviewed_by), ("rejected", AUTO))
        self.assertIn("45 days", punch.hr_review_comment)
        self.assertEqual(session.status, "active", "the On-Duty request itself was approved: it stays")
        note = Notification.objects.get(employee=self.asha, source="geo_punch_rejection")
        self.assertEqual(note.dedupe_key, f"wa:geopunch:{punch.pk}:rejected")
        self.assert_no_whatsapp()

    def test_a_rejected_casual_leave_day_becomes_leave_as_the_module_writes_it(self):
        made = self.old_of_each()
        self.go()
        record = AttendanceDayRecord.objects.get(employee=self.asha, date=made["casual_leave"].date)
        self.assertEqual((record.status, record.source), ("on_leave", "manual"))
        self.assertEqual(record.override_note, "Casual Leave rejected -marked as leave")
        self.assertEqual(record.override_by, AUTO)
        row = AutoRejectedRequest.objects.get(kind="casual_leave")
        self.assertEqual(row.effects["attendance"], "written")

    def test_resignations_and_decided_requests_are_never_touched(self):
        res = age(ResignationRequest.objects.create(employee=self.asha, reason="moving", status="dept_approved"), 200)
        approved = age(
            LeaveRequest.objects.create(
                employee=self.asha, start_date="2026-08-01", end_date="2026-08-01", type="casual", status="approved"
            ),
            100,
        )
        rejected = age(
            EmployeePermission.objects.create(
                employee=self.asha, date=date(2026, 8, 3), reason="x", type="morning_late_in", status="rejected"
            ),
            100,
        )
        handled = age(
            EmployeeRequest.objects.create(
                employee=self.asha, request_type="general", subject="done", description="x", status="approved"
            ),
            100,
        )
        on_duty_outpass = age(
            OutpassRequest.objects.create(
                employee=self.asha, destination="Site", reason="on duty", source="on_duty", status="pending"
            ),
            100,
        )
        summary = self.go()
        self.assertEqual(summary["rejected"], 0)
        for obj, status in (
            (res, "dept_approved"),
            (approved, "approved"),
            (rejected, "rejected"),
            (handled, "approved"),
            (on_duty_outpass, "pending"),
        ):
            obj.refresh_from_db()
            self.assertEqual(obj.status, status)
        self.assertEqual(AutoRejectedRequest.objects.count(), 0)

    def test_every_hub_kind_but_resignation_has_a_rejector(self):
        from .hr_requests_views import BY_KEY

        self.assertEqual(set(BY_KEY) - set(engine.NEVER_AUTO), set(engine.AUTO_KINDS))
        self.assertEqual(set(service.REJECTORS), set(engine.AUTO_KINDS))
        self.assertLess(engine.AUTO_KINDS.index("on_duty"), engine.AUTO_KINDS.index("on_duty_punch"))


# ───────────────────────────── B. telling the employee ─────────────────────────────


class NotificationTests(AutoRejectBase):
    def test_the_notice_and_push_of_a_manual_rejection_but_no_whatsapp(self):
        made = self.old_of_each()
        self.go()
        self.assert_no_whatsapp()
        notes = {n.related_module: n for n in Notification.objects.filter(employee=self.asha)}
        for key in (
            "leave",
            "permission",
            "casual_leave",
            "missing_punch",
            "attendance_correction",
            "holiday_work",
            "outpass",
            "request",
            "advance",
        ):
            note = notes[key]
            self.assertEqual(note.source, "approval_rejected", key)
            self.assertEqual(note.dedupe_key, f"wa:approval:{key}:{made[key].pk}:rejected", key)
            self.assertIn("rejected", note.title.lower(), key)
            self.assertIn("Automatically rejected", note.message, key)
            self.assertIn("Rejected by: Automatic rejection", note.message, key)
        od = notes["on_duty"]
        self.assertEqual((od.source, od.dedupe_key), ("geo_rejection", f"wa:geo:{made['on_duty'].pk}:rejected"))
        self.assertIn("1 punch(es) you recorded under it were not counted", od.message)
        # one notice for the On-Duty request; its voided punch gets none of its own (as when HR rejects it)
        self.assertFalse(Notification.objects.filter(source="geo_punch_rejection").exists())
        self.assertFalse(Notification.objects.filter(related_module="resignation").exists())
        for row in AutoRejectedRequest.objects.exclude(kind="on_duty_punch"):
            self.assertIs(row.effects.get("notified"), True, row.kind)

    def test_a_manual_rejection_afterwards_does_not_repeat_the_push(self):
        made = self.old_of_each()
        self.go()
        from . import push_messages, whatsapp_approvals

        leave = made["leave"]
        leave.refresh_from_db()
        employee, doc, params, key = whatsapp_approvals.decision_message("leave", leave, "rejected", approver="X")
        self.assertIsNone(push_messages.announce(employee, doc, related_module="leave", dedupe_key=key, params=params))


# ───────────────────────────── C. the age ─────────────────────────────


class AgeTests(AutoRejectBase):
    def leave(self, emp=None):
        return LeaveRequest.objects.create(
            employee=emp or self.asha, start_date="2026-10-01", end_date="2026-10-01", type="casual"
        )

    def test_exactly_n_days_is_not_due_and_n_plus_one_is(self):
        exactly = age(self.leave(), 45)
        older = age(self.leave(), 46)
        self.assertEqual(engine.days_waiting(exactly.created_at, TODAY), 45)
        self.assertFalse(engine.is_due(exactly.created_at, 45, TODAY))
        self.assertTrue(engine.is_due(older.created_at, 45, TODAY))
        self.go()
        exactly.refresh_from_db()
        older.refresh_from_db()
        self.assertEqual((exactly.status, older.status), ("pending", "rejected"))
        self.assertEqual(AutoRejectedRequest.objects.get().days_waited, 46)
        # the next day the other one is due too
        self.go(today=TODAY + timedelta(days=1))
        exactly.refresh_from_db()
        self.assertEqual(exactly.status, "rejected")

    def test_the_day_is_the_india_day_it_was_submitted(self):
        # 00:00:00 India time of the 45th day back is the first moment of a day that has waited only 45 days
        first_moment = age(self.leave(), 45, hh=0, mm=0, ss=0)
        # 23:59:59 India time of the 46th day back (18:29:59 UTC that day) has waited 46 days
        last_moment = age(self.leave(), 46, hh=23, mm=59, ss=59)
        # 00:30 India time is still the evening before in UTC: it counts as the India day
        early = age(self.leave(), 45, hh=0, mm=30)
        self.assertEqual(early.created_at.astimezone(dt_timezone.utc).date(), TODAY - timedelta(days=46))
        self.go()
        for obj, status in ((first_moment, "pending"), (last_moment, "rejected"), (early, "pending")):
            obj.refresh_from_db()
            self.assertEqual(obj.status, status)
        self.assertEqual(engine.cutoff(45, TODAY), at_ist(date(2026, 10, 10), 0))

    def test_the_number_of_days_is_the_saved_one(self):
        leave = age(self.leave(), 35)
        self.assertEqual(self.go()["rejected"], 0)
        RequestAutoRejectSettings.objects.update_or_create(pk=1, defaults={"days": 30})
        summary = self.go()
        self.assertEqual((summary["rejected"], summary["days"]), (1, 30))
        leave.refresh_from_db()
        self.assertEqual(leave.status, "rejected")
        self.assertIn("within 30 days", leave.hr_comment)
        self.assertEqual(AutoRejectedRequest.objects.get().days_setting, 30)

    def test_switched_off_the_nightly_run_does_nothing(self):
        leave = age(self.leave(), 90)
        RequestAutoRejectSettings.objects.update_or_create(pk=1, defaults={"enabled": False})
        self.assertEqual(service.nightly(), {"ran": False, "reason": "switched off"})
        leave.refresh_from_db()
        self.assertEqual(leave.status, "pending")
        self.assertFalse(AutoRejectedRequest.objects.exists())
        RequestAutoRejectSettings.objects.filter(pk=1).update(enabled=True)
        summary = service.nightly()
        leave.refresh_from_db()
        self.assertEqual((summary["rejected"], leave.status), (1, "rejected"))
        line = AuditLog.objects.get(user_type="system", user_name=AUTO)
        self.assertIn("1 waiting request(s) rejected", line.record_description)

    def test_on_by_default_with_45_days(self):
        row = service.settings_row()
        self.assertEqual((row.enabled, row.days), (True, 45))
        self.assertEqual(scheduler.RUN_AT, "01:30")


# ───────────────────────────── D. safety ─────────────────────────────


class SafetyTests(AutoRejectBase):
    def test_a_request_decided_meanwhile_or_no_longer_old_enough_is_left_alone(self):
        leave = age(LeaveRequest.objects.create(employee=self.asha, start_date="2026-09-01", end_date="2026-09-01"), 60)
        LeaveRequest.objects.filter(pk=leave.pk).update(status="approved", approved_by="Meena")
        self.assertEqual(service.reject_one("leave", leave.pk, days=45, today=TODAY), [])
        leave.refresh_from_db()
        self.assertEqual((leave.status, leave.approved_by), ("approved", "Meena"))
        recent = age(LeaveRequest.objects.create(employee=self.asha, start_date="2026-11-01", end_date="2026-11-01"), 3)
        self.assertEqual(service.reject_one("leave", recent.pk, days=45, today=TODAY), [])
        # the run's list said due, the row said otherwise by the time it was locked: counted as skipped
        with mock.patch.object(
            engine, "due_ids", side_effect=lambda key, *a, **k: [leave.pk] if key == "leave" else []
        ):
            summary = self.go()
        self.assertEqual((summary["rejected"], summary["skipped"]), (0, 1))
        self.assertFalse(AutoRejectedRequest.objects.exists())

    def test_a_second_run_rejects_nothing(self):
        self.old_of_each()
        first = self.go()
        rows = AutoRejectedRequest.objects.count()
        notes = Notification.objects.count()
        second = self.go()
        self.assertEqual(first["rejected"], 12)
        self.assertEqual((second["rejected"], second["skipped"], second["failed"]), (0, 0, 0))
        self.assertEqual(AutoRejectedRequest.objects.count(), rows)
        self.assertEqual(Notification.objects.count(), notes)

    def test_one_failure_is_logged_and_the_run_goes_on(self):
        made = self.old_of_each()

        def broken(obj, ctx):
            obj.status = "rejected"
            obj.save()
            raise RuntimeError("boom")

        with (
            mock.patch.dict(service.REJECTORS, {"permission": broken}),
            self.assertLogs("api.request_auto_reject.service", "ERROR"),
        ):
            summary = self.go()
        self.assertEqual(summary["failed"], 1)
        self.assertEqual(summary["failures"][0]["kind"], "permission")
        self.assertIn("boom", summary["failures"][0]["error"])
        made["permission"].refresh_from_db()
        self.assertEqual(made["permission"].status, "pending", "nothing of a failed rejection is kept")
        made["leave"].refresh_from_db()
        self.assertEqual(made["leave"].status, "rejected", "the others are still rejected")
        self.assertEqual(summary["rejected"], 11)
        self.assertFalse(AutoRejectedRequest.objects.filter(kind="permission").exists())
        self.assertEqual(service.settings_row().last_run_result["failed"], 1)

    def test_a_finalized_payroll_month_keeps_its_attendance_and_the_request_is_still_rejected(self):
        cl = age(CasualLeaveRequest.objects.create(employee=self.asha, date=date(2026, 9, 15), reason="rest"), 70)
        PayrollMonthClose.objects.create(month=9, year=2026, finalized_at=timezone.now(), finalized_by="Meena")
        self.go()
        cl.refresh_from_db()
        self.assertEqual(cl.status, "rejected")
        self.assertFalse(AttendanceDayRecord.objects.filter(employee=self.asha, date=cl.date).exists())
        row = AutoRejectedRequest.objects.get(kind="casual_leave")
        self.assertEqual(row.effects["attendance"], "skipped")
        self.assertIn("Payroll Done", row.effects["attendanceNote"])
        self.assertEqual(service.settings_row().last_run_result["attendanceSkipped"], 1)

    def test_a_failed_attendance_write_is_recorded_and_the_rejection_stands(self):
        cl = age(CasualLeaveRequest.objects.create(employee=self.asha, date=date(2026, 9, 16), reason="rest"), 70)
        with (
            mock.patch("api.casual_leave_views._write_attendance_for_cl", side_effect=RuntimeError("engine down")),
            self.assertLogs("api.request_auto_reject.service", "ERROR"),
        ):
            self.go()
        cl.refresh_from_db()
        self.assertEqual(cl.status, "rejected")
        row = AutoRejectedRequest.objects.get(kind="casual_leave")
        self.assertEqual(row.effects["attendance"], "failed")
        self.assertIn("engine down", row.effects["attendanceNote"])

    def test_the_casual_leave_held_by_a_waiting_request_or_proposal_is_freed(self):
        cl = age(CasualLeaveRequest.objects.create(employee=self.asha, date=date(2026, 10, 6), reason="rest"), 50)
        proposal = age(
            AttendanceOverrideRequest.objects.create(
                employee=self.asha,
                date=date(2026, 10, 7),
                requested_values={"option": "casual_leave", "status": "present"},
                previous_values={"status": "absent"},
                approval_trail=[],
            ),
            50,
        )
        held = lambda: cl_balance.parts([self.asha.id], date(2026, 1, 1), date(2026, 12, 31))[self.asha.id]  # noqa: E731
        self.assertEqual(
            sorted((p.kind, p.request_id) for p in held()),
            [("attendance_correction", proposal.id), ("casual_leave", cl.id)],
        )
        self.go()
        self.assertEqual(held(), [])

    def test_the_compensation_balance_held_by_a_use_request_or_an_attendance_edit_is_freed(self):
        from .attendance_edit import _pending_edit_use

        use = age(
            HolidayWorkClaim.objects.create(
                employee=self.asha,
                work_date=date(2026, 10, 9),
                shifts=Decimal("1.00"),
                kind=HolidayWorkClaim.KIND_USE_BALANCE,
                approval_trail=[],
            ),
            50,
        )
        edit = age(
            AttendanceOverrideRequest.objects.create(
                employee=self.asha,
                date=date(2026, 10, 10),
                requested_values={"useBalance": True, "useShifts": "0.50", "status": "present"},
                approval_trail=[],
            ),
            50,
        )
        self.assertEqual(compensation_claims.pending_use([self.asha.id]), {self.asha.id: Decimal("1.00")})
        self.assertEqual(_pending_edit_use(self.asha), Decimal("0.50"))
        self.go()
        use.refresh_from_db()
        edit.refresh_from_db()
        self.assertEqual((use.status, edit.status), ("rejected", "rejected"))
        self.assertEqual(compensation_claims.pending_use([self.asha.id]), {})
        self.assertEqual(_pending_edit_use(self.asha), Decimal("0"))

    def test_other_requests_keep_the_notes_hr_wrote_before(self):
        rq = age(
            EmployeeRequest.objects.create(
                employee=self.asha,
                request_type="general",
                subject="ID card",
                description="x",
                status="more_info",
                hr_notes="Send a photo",
            ),
            50,
        )
        self.go()
        rq.refresh_from_db()
        self.assertEqual(rq.status, "rejected")
        self.assertTrue(rq.hr_notes.startswith("Send a photo\n\nAutomatically rejected"))


# ───────────────────────────── E. the endpoints ─────────────────────────────


class EndpointTests(AutoRejectBase):
    def setUp(self):
        super().setUp()
        self.today = ist_today()

    def old(self, emp, days=50):
        return age(
            LeaveRequest.objects.create(employee=emp, start_date="2026-10-01", end_date="2026-10-01", type="casual"),
            days,
            today=self.today,
        )

    def user(self, name, permissions, branch=None):
        role = Role.objects.create(name=f"ar_{name}", permissions=permissions)
        return HRUser.objects.create(username=f"ar_{name}", password_hash="x", role=role, branch=branch)

    def call(self, method, url, data=None, user=None, **params):
        who = bearer(user or self.admin)
        if method == "get":
            return self.client.get(url, params, **who)
        return getattr(self.client, method)(url, data or {}, content_type="application/json", **who)

    def test_config_says_the_rule_and_lists_what_is_due(self):
        a = self.old(self.asha)
        self.old(self.ravi, days=10)
        body = self.call("get", CONFIG).json()
        self.assertEqual((body["enabled"], body["days"], body["runAt"]), (True, 45, "01:30"))
        self.assertEqual(body["limits"], {"min": 7, "max": 365, "default": 45})
        self.assertEqual([k["key"] for k in body["neverRejected"]], ["resignation"])
        self.assertEqual(len(body["kinds"]), 12)
        self.assertTrue(body["canChange"] and body["canRun"])
        due = body["due"]
        self.assertEqual((due["total"], due["byKind"], due["days"], due["saved"]), (1, {"leave": 1}, 45, True))
        item = due["items"][0]
        self.assertEqual((item["kind"], item["id"], item["daysWaiting"]), ("leave", a.id, 50))
        self.assertEqual(item["employee"]["code"], "RQ1")
        self.assertTrue(item["what"] and item["summary"])
        # another number of days, before it is saved
        preview = self.call("get", CONFIG, days=7).json()["due"]
        self.assertEqual((preview["total"], preview["days"], preview["saved"]), (2, 7, False))
        self.assertEqual(self.call("get", CONFIG, days=3).status_code, 400)

    def test_an_on_duty_punch_due_with_its_request_says_so(self):
        made = self.one_of_each()
        for obj in made.values():
            age(obj, 50, today=self.today)
        items = {i["kind"]: i for i in self.call("get", CONFIG).json()["due"]["items"]}
        self.assertEqual(items["on_duty_punch"]["voidedWith"], {"kind": "on_duty", "id": made["on_duty"].id})
        self.assertNotIn("resignation", items)

    def test_saving_the_switch_and_the_days_with_their_bounds(self):
        r = self.call("put", CONFIG, {"enabled": False, "days": 30})
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual((r.json()["enabled"], r.json()["days"]), (False, 30))
        row = RequestAutoRejectSettings.objects.get(pk=1)
        self.assertEqual((row.enabled, row.days, row.updated_by), (False, 30, "Meena"))
        log = AuditLog.objects.filter(module="settings").latest("id")
        self.assertIn("Auto-Reject Requests: switched off; days 45 -> 30", log.record_description)
        for bad in ({"days": 6}, {"days": 366}, {"days": "abc"}, {"days": True}, {"days": 10.5}, {"enabled": "yes"}):
            r = self.call("put", CONFIG, bad)
            self.assertEqual(r.status_code, 400, bad)
            self.assertTrue(r.json()["errors"], bad)
        self.assertEqual(self.call("put", CONFIG, {"days": "60"}).json()["days"], 60)

    def test_who_may_look_change_and_run(self):
        viewer = self.user("viewer", {"settings": "view"})
        editor = self.user("editor", {"settings": "edit"})
        tab_view = self.user("tab_view", {"settings": "edit", "settings.request_auto_reject": "view"})
        hidden = self.user("hidden", {"settings": "edit", "settings.request_auto_reject": "hidden"})
        branch_editor = self.user("branch", {"settings": "edit"}, branch=self.u2)
        self.assertEqual(self.call("get", CONFIG, user=viewer).status_code, 200)
        self.assertFalse(self.call("get", CONFIG, user=viewer).json()["canRun"])
        self.assertEqual(self.call("put", CONFIG, {"days": 30}, user=viewer).status_code, 403)
        self.assertEqual(self.call("post", RUN_NOW, user=viewer).status_code, 403)
        self.assertEqual(self.call("put", CONFIG, {"days": 30}, user=tab_view).status_code, 403)
        self.assertEqual(self.call("post", RUN_NOW, user=tab_view).status_code, 403)
        self.assertEqual(self.call("get", CONFIG, user=hidden).status_code, 403)
        self.assertEqual(self.call("put", CONFIG, {"days": 30}, user=editor).status_code, 200)
        # one company-wide rule: a branch login may look and run (for its branch) but not change it
        body = self.call("get", CONFIG, user=branch_editor).json()
        self.assertEqual((body["canChange"], body["canRun"], body["branchScoped"]), (False, True, True))
        self.assertEqual(self.call("put", CONFIG, {"days": 40}, user=branch_editor).status_code, 403)
        self.assertEqual(RequestAutoRejectSettings.objects.get(pk=1).days, 30)

    def test_run_now_rejects_what_is_due_and_says_who_ran_it(self):
        a = self.old(self.asha)
        RequestAutoRejectSettings.objects.update_or_create(pk=1, defaults={"enabled": False})
        r = self.call("post", RUN_NOW)
        self.assertEqual(r.status_code, 200, r.content)
        body = r.json()
        self.assertEqual((body["summary"]["rejected"], body["summary"]["runBy"]), (1, "Meena"))
        self.assertEqual(body["config"]["due"]["total"], 0)
        self.assertEqual(body["config"]["lastRunBy"], "Meena")
        a.refresh_from_db()
        self.assertEqual((a.status, a.approved_by), ("rejected", AUTO))
        self.assertEqual(a.approval_trail[-1]["runBy"], "Meena")
        row = AutoRejectedRequest.objects.get()
        self.assertEqual((row.trigger, row.run_by), ("run_now", "Meena"))
        log = AuditLog.objects.filter(module="settings", action="reject").latest("id")
        self.assertIn("Auto-Reject Requests run now: 1 waiting request(s) rejected (Leave 1)", log.record_description)
        self.assert_no_whatsapp()

    def test_a_branch_login_sees_and_runs_its_own_branch_only(self):
        a = self.old(self.asha)
        b = self.old(self.ravi)
        branch_editor = self.user("branch2", {"settings": "edit"}, branch=self.u2)
        due = self.call("get", CONFIG, user=branch_editor).json()["due"]
        self.assertEqual([i["id"] for i in due["items"]], [b.id])
        self.assertEqual(self.call("post", RUN_NOW, user=branch_editor).json()["summary"]["rejected"], 1)
        a.refresh_from_db()
        b.refresh_from_db()
        self.assertEqual((a.status, b.status), ("pending", "rejected"))
        self.call("post", RUN_NOW)
        history = self.call("get", HISTORY, user=branch_editor).json()
        self.assertEqual([i["requestId"] for i in history["items"]], [b.id])
        self.assertEqual(self.call("get", HISTORY).json()["total"], 2)

    def test_history_is_paged_newest_first_and_says_what_and_by_whom(self):
        made = self.one_of_each()
        for obj in made.values():
            age(obj, 50, today=self.today)
        self.call("post", RUN_NOW)
        first = self.call("get", HISTORY, pageSize=5).json()
        self.assertEqual((first["total"], first["pages"], len(first["items"])), (12, 3, 5))
        item = first["items"][0]
        for name in ("kind", "kindLabel", "employee", "what", "summary", "submittedAt", "rejectedAt", "remark", "by"):
            self.assertIn(name, item)
        self.assertEqual(item["by"], "Run now by Meena")
        self.assertEqual(item["daysWaited"], 50)
        od = self.call("get", HISTORY, kind="on_duty").json()["items"][0]
        self.assertIn("1 waiting On-Duty punch voided", od["effectsText"])
        self.assertIn("Geo tracking ended", od["effectsText"])
        self.assertEqual(self.call("get", HISTORY, kind="resignation").status_code, 400)
        self.assertEqual(self.call("get", HISTORY, trigger="nightly").json()["total"], 0)
        self.assertEqual(self.call("get", HISTORY, page="x").status_code, 400)


class SchedulerTests(SimpleTestCase):
    def test_the_job_runs_every_night_at_01_30_india_time(self):
        fake = mock.Mock()
        scheduler.add_job(fake)
        kwargs = fake.add_job.call_args.kwargs
        self.assertEqual((kwargs["hour"], kwargs["minute"], kwargs["timezone"]), (1, 30, "Asia/Kolkata"))
        self.assertEqual(kwargs["id"], "request_auto_reject")
        self.assertEqual(kwargs["max_instances"], 1)

    def test_the_job_never_raises(self):
        with (
            mock.patch.object(service, "nightly", side_effect=RuntimeError("db down")),
            self.assertLogs("api.request_auto_reject.scheduler", "ERROR"),
        ):
            scheduler._run()  # logged, not raised

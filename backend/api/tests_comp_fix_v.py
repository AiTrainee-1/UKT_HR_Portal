"""Regression tests of the compensation claim workflow's final fix round (2026-11-19), from the adversarial verification
(comp2_verify_result.md): every item there that was "partially" fixed, every new issue and every coverage gap the lead
decided, each pinned by a test that failed before the fix.

  * the approval refreshes its own evidence (security #1): the day is worked out again and its OT row brought in step
    before an OT / holiday-work claim is approved; a birthday's stale present day is worked out again (correctness #5)
  * a birthday credit stays decidable with the switches off (security #2); an approved credit is shown as approved
    whatever the day shows now
  * one "was the birthday worked?" reading (compensation_effects.worked_days) for Casual Leave and the birthday outcome;
    an approved birthday credit never also makes a Casual Leave free (correctness #1 / #2)
  * an approved claim is never pruned by a detection pass that read its snapshot before the approval (the lock-then-
    recheck in overtime.sync_overtime)
  * refresh rights need Edit on the page's own key; the withdrawn code; the HOD dedupe key carries the amount; canRaise
    follows the Claims sub-tab's Edit right; HR Pay follows the quarters rule; the Birthdays 'applied' flag; the report's
    legacy credits; the HOD reason prefix for old app builds; holiday work on an off Saturday; the claims date forward
    only; a typed leave on an unworked birthday uses no balance; an older Compensation Day can be removed.

Run via: python manage.py test api.tests_comp_fix_v
"""

from datetime import date, time
from decimal import Decimal
from unittest import mock

from django.db.models import Q
from django.utils import timezone

from . import cl_balance
from . import compensation_claims as claims
from . import compensation_effects as effects
from . import tests_compensation_claims_engine as eng
from . import tests_compensation_engine as base
from .attendance_final import compute_range_records
from .casual_leave_views import _write_attendance_for_cl
from .models import (
    AttendanceDayRecord,
    AttendanceLog,
    CasualLeaveRequest,
    CompensationConfig,
    CompensationDayAnnouncement,
    CompensationLeaveCredit,
    CompensationLedger,
    Department,
    DepartmentManager,
    EmployeeShiftAssignment,
    HolidayWorkClaim,
    LeaveBalance,
    LeaveRequest,
    LeaveType,
    ManagerDepartmentAssignment,
    Notification,
    OvertimeRecord,
    PayrollMonthClose,
    PayrollSettings,
    ShiftTemplate,
)
from .overtime import detect_overtime_for_month, refresh_employee_overtime, run_detection_job, sync_overtime
from .tests_compensation_claims import (
    BIRTHDAY,
    CLAIMS_FROM,
    OT_ALLOW_DAY,
    OT_SHIFT_DAY,
    SUNDAY,
    TODAY,
    TODAY_PATCHES,
    USE_DAY,
    ClaimsBase,
    _emp_token,
    _hr,
    _hr_user,
    _punch,
)

MON, TUE, WED, THU, FRI, SAT, SUN = eng.MON, eng.TUE, eng.WED, eng.THU, eng.FRI, eng.SAT, eng.SUN
ENGINE_TODAY = date(2026, 3, 12)
REAL_BIRTHDAY_OUTCOME = effects.birthday_outcome
REAL_STAFF_OT_CREDIT = effects.staff_ot_credit
REAL_QUARTER_RULE_APPLIES = effects.quarter_rule_applies
CLAIMS_KEY = "compensation.leave.holiday_work.claims"


# ═════════════════════════════ the real engine: the approval's own evidence ═════════════════════════════


class EngineClaimsBase(eng.ClaimsEngineBase):
    """The real engine, detection and compensation_effects (only "today" and outbound WhatsApp are patched); the employee
    claims from the app and their Department Head decides (HOD PATCH) or the MD decides for them."""

    CODE = "VFX1"

    def setUp(self):
        super().setUp()
        for target in (*TODAY_PATCHES, "api.clock.ist_today"):
            patch = mock.patch(target, return_value=ENGINE_TODAY)
            patch.start()
            self.addCleanup(patch.stop)
        wa = mock.patch("api.whatsapp_service.send_notification", return_value=None)
        wa.start()
        self.addCleanup(wa.stop)
        self.on(
            allowance_enabled=True,
            shift_enabled=True,
            relaxation_enabled=True,
            pay_enabled=True,
            holiday_work_enabled=True,
            birthday_enabled=True,
        )
        self.dept = Department.objects.create(name="VFX Dept")
        self.emp.department = self.dept
        self.emp.date_of_birth = date(1990, 3, 5)  # Thursday 5 March 2026
        self.emp.save()
        self.boss = self.new_staff("VFXB", department=self.dept)
        self.manager = DepartmentManager.objects.create(employee=self.boss)
        ManagerDepartmentAssignment.objects.create(manager=self.manager, department=self.dept)

    def raise_(self, body):
        return self.client.post(
            "/api/employee/compensation/claims",
            {"reason": "Worked late", **body},
            content_type="application/json",
            **_emp_token(self.emp),
        )

    def made(self, response):
        self.assertEqual(response.status_code, 201, response.content)
        return HolidayWorkClaim.objects.get(pk=response.json()["id"])

    def hod(self, claim_id, decision="approved"):
        body = {"status": decision}
        if decision == "rejected":
            body["comment"] = "Not approved this time"  # a rejection needs its reason (2026-11-21)
        with self.captureOnCommitCallbacks(execute=True):
            response = self.client.patch(
                f"/api/manager/holiday-work/{claim_id}/status",
                body,
                content_type="application/json",
                **_emp_token(self.boss),
            )
        return response.status_code, response.json()

    def md(self, claim_id, decision="approved"):
        from .md_portal import hod_approvals

        with self.captureOnCommitCallbacks(execute=True):
            response = hod_approvals.deciders()["holiday_work"](
                self.manager, claim_id, decision, "md", "Md (MD, for VFXB)", None
            )
        return response.status_code, response.data

    def decide_both(self, claim_id):
        return [self.hod(claim_id), self.md(claim_id)]

    def detect(self):
        return {r.date: r for r in detect_overtime_for_month(2026, 3) if r.employee_id == self.emp.id}

    def punch_view_fix(self, d, *times, next_date_times=()):
        """What a Punch View correction does: the punches change, the touched day is worked out again, no OT sync."""
        self.punch(d, *times, next_date_times=next_date_times)
        compute_range_records(self.emp, d, d, PayrollSettings.get())

    def refused(self, outcome):
        status, body = outcome
        self.assertEqual((status, body.get("code")), (409, "claim_refused"), body)
        return body["error"]


class OtShiftEvidenceTests(EngineClaimsBase):
    def setUp(self):
        super().setUp()
        self.worked(MON, time(23, 30))  # 360 min past 17:30 = 0.75 by quarters (480 min shift)
        self.month()
        self.row = self.detect()[MON]
        self.claim = self.made(
            self.raise_({"kind": "ot_shift", "date": MON.isoformat(), "overtimeRecordId": self.row.id})
        )
        self.assertEqual(self.claim.shifts, Decimal("0.75"))

    def test_a_correction_before_any_detection_pass_is_refused(self):
        self.punch_view_fix(MON, time(8, 30), time(13, 0), time(14, 0), time(17, 30))  # no OT at all now
        for outcome in self.decide_both(self.claim.id):
            self.refused(outcome)
        self.assertFalse(CompensationLedger.objects.filter(claim=self.claim).exists())
        self.assertFalse(OvertimeRecord.objects.filter(pk=self.row.pk).exists())
        self.claim.refresh_from_db()
        self.assertEqual(self.claim.status, HolidayWorkClaim.STATUS_PENDING)
        self.assertEqual(self.hod(self.claim.id, "rejected")[0], 200)

    def test_punches_deleted_and_the_day_never_worked_out_again(self):
        """A big Punch View import that skipped the refresh: the stored day still shows the overtime."""
        AttendanceLog.objects.filter(employee=self.emp, date=MON, punch_time=time(23, 30)).delete()
        self.refused(self.hod(self.claim.id))
        self.assertFalse(CompensationLedger.objects.filter(claim=self.claim).exists())

    def test_the_employee_page_sync_does_not_let_it_through(self):
        self.punch_view_fix(MON, time(8, 30), time(13, 0), time(14, 0), time(17, 30))
        refresh_employee_overtime(self.emp, today=ENGINE_TODAY)
        self.refused(self.hod(self.claim.id))

    def test_a_previous_month_claim_the_scheduled_job_no_longer_syncs(self):
        self.punch_view_fix(MON, time(8, 30), time(13, 0), time(14, 0), time(17, 30))
        with mock.patch("api.overtime.ist_today", return_value=date(2026, 4, 10)):
            run_detection_job(today=date(2026, 4, 10))
        self.refused(self.hod(self.claim.id))

    def test_less_overtime_now_is_refused(self):
        self.punch_view_fix(MON, time(8, 30), time(13, 0), time(14, 0), time(19, 30))  # 120 min = 0.25
        error = self.refused(self.hod(self.claim.id))
        self.assertIn("now earns 0.25 shift", error)

    def test_a_row_that_became_a_type_1_allowance_says_it_changed_not_that_hr_decided(self):
        self.punch_view_fix(MON, time(8, 30), time(13, 0), time(14, 0), time(18, 45))  # 75 min: Type 1 (status auto)
        error = self.refused(self.hod(self.claim.id))
        self.assertIn("changed since the claim was raised", error)
        self.assertNotIn("HR already decided", error)

    def test_more_overtime_now_still_credits_what_was_claimed(self):
        self.punch_view_fix(MON, time(8, 30), time(13, 0), time(14, 0), next_date_times=(time(2, 0),))
        status, body = self.hod(self.claim.id)
        self.assertEqual(status, 200, body)
        self.assertEqual(CompensationLedger.objects.get(claim=self.claim).shifts, Decimal("0.75"))

    def test_unchanged_punches_approve(self):
        status, body = self.hod(self.claim.id)
        self.assertEqual(status, 200, body)
        self.assertTrue(body["credited"])

    def test_a_locked_month_is_never_worked_out_again(self):
        AttendanceLog.objects.filter(employee=self.emp, date=MON, punch_time=time(23, 30)).delete()
        before = AttendanceDayRecord.objects.get(employee=self.emp, date=MON).updated_at
        self.lock_march()
        self.hod(self.claim.id)
        self.assertEqual(AttendanceDayRecord.objects.get(employee=self.emp, date=MON).updated_at, before)
        self.assertTrue(OvertimeRecord.objects.filter(pk=self.row.pk).exists())


class OtShiftEvidenceStrictTests(OtShiftEvidenceTests):
    MODE = "strict"
    CODE = "VFX2"


class OtAllowanceEvidenceTests(EngineClaimsBase):
    def setUp(self):
        super().setUp()
        self.worked(WED, time(18, 45))  # 75 min -> 30 min allowance
        self.month()
        self.row = self.detect()[WED]
        self.claim = self.made(
            self.raise_({"kind": "ot_allowance", "date": WED.isoformat(), "overtimeRecordId": self.row.id})
        )

    def test_a_correction_before_any_detection_pass_is_refused(self):
        self.punch_view_fix(WED, time(8, 30), time(13, 0), time(14, 0), time(17, 30))
        for outcome in self.decide_both(self.claim.id):
            self.refused(outcome)

    def test_the_same_allowance_still_approves(self):
        self.punch_view_fix(WED, time(8, 30), time(13, 0), time(14, 0), time(19, 0))  # 90 min: still 30
        status, body = self.hod(self.claim.id)
        self.assertEqual(status, 200, body)


class HolidayWorkEvidenceTests(EngineClaimsBase):
    def setUp(self):
        super().setUp()
        self.punch(SUN, time(9, 0), time(14, 0))
        compute_range_records(self.emp, SUN, SUN, PayrollSettings.get())
        self.claim = self.made(self.raise_({"kind": "holiday_work", "date": SUN.isoformat()}))

    def test_punches_deleted_without_the_day_worked_out_again_is_refused(self):
        AttendanceLog.objects.filter(employee=self.emp, date=SUN).delete()  # the stored day still says present
        for outcome in self.decide_both(self.claim.id):
            self.refused(outcome)

    def test_punches_kept_approves(self):
        self.assertEqual(self.hod(self.claim.id)[0], 200)


class BirthdayEvidenceTests(EngineClaimsBase):
    def setUp(self):
        super().setUp()
        self.worked(THU, time(17, 30))
        compute_range_records(self.emp, THU, THU, PayrollSettings.get())
        self.claim = self.made(self.raise_({"kind": "birthday", "date": THU.isoformat()}))

    def test_punches_deleted_without_the_day_worked_out_again_is_refused(self):
        """correctness #5: a stored 'present' day with no punch any more is stale and worked out again."""
        AttendanceLog.objects.filter(employee=self.emp, date=THU).delete()
        for outcome in self.decide_both(self.claim.id):
            self.refused(outcome)

    def test_an_approved_credit_shows_as_approved_after_its_punches_went(self):
        self.assertEqual(self.hod(self.claim.id)[0], 200)
        self.punch_view_fix(THU)
        out = effects.birthday_outcome(self.emp, THU, refresh=True)
        self.assertEqual(out["outcome"], effects.BIRTHDAY_CREDIT_APPROVED)
        self.assertEqual(out["base"], effects.BIRTHDAY_NOT_ELIGIBLE)
        self.assertFalse(out["claimable"])

    def test_an_approved_credit_never_also_makes_a_full_casual_leave_free(self):
        self.assertEqual(self.hod(self.claim.id)[0], 200)
        self.punch_view_fix(THU)
        cl = CasualLeaveRequest.objects.create(employee=self.emp, date=THU, portion="full", status="approved")
        _write_attendance_for_cl(cl, "HOD")
        held = cl_balance.parts([self.emp.id], date(2026, 1, 1), date(2026, 12, 31))[self.emp.id]
        self.assertEqual([p.birthday for p in held if p.date == THU], [False])

    def test_an_approved_credit_never_also_makes_a_half_casual_leave_free(self):
        self.assertEqual(self.hod(self.claim.id)[0], 200)
        self.punch(THU)
        CasualLeaveRequest.objects.create(employee=self.emp, date=THU, portion="first_half", status="approved")
        compute_range_records(self.emp, THU, THU, PayrollSettings.get())
        held = cl_balance.parts([self.emp.id], date(2026, 1, 1), date(2026, 12, 31))[self.emp.id]
        self.assertEqual([p.birthday for p in held if p.date == THU], [False])

    def test_the_credit_stays_decidable_with_the_switches_off(self):
        """security #2: the approval re-check reads the attendance without the master / birthday switch."""
        base.set_config(birthday_enabled=False)
        status, body = self.hod(self.claim.id)
        self.assertEqual(status, 200, body)

    def test_the_credit_stays_decidable_with_the_master_switch_off(self):
        self.settings(compensation_feature_enabled=False)
        status, body = self.md(self.claim.id)
        self.assertEqual(status, 200, body)


class BirthdayEvidenceStrictTests(BirthdayEvidenceTests):
    MODE = "strict"
    CODE = "VFX3"


# ═════════════════════════════ one "was the birthday worked?" reading ═════════════════════════════


class BirthdayWorkedTests(eng.ClaimsEngineBase):
    """correctness #1 / #2: Casual Leave on the birthday and the birthday outcome read the day the same way."""

    CODE = "VFX4"

    def setUp(self):
        super().setUp()
        ps = PayrollSettings.get()
        ps.staff_next_morning_history = []
        ps.save()
        self.on(birthday_enabled=True)
        self.emp.date_of_birth = date(1990, 3, 5)
        self.emp.save()

    def held(self):
        return cl_balance.parts([self.emp.id], date(2026, 1, 1), date(2026, 12, 31))[self.emp.id]

    def balance(self):
        cut_over = date(2026, 1, 1)
        return cl_balance.balance_json(cl_balance.ledger(self.emp, 2026, cut_over=cut_over), cut_over)

    def outcome(self):
        return effects.birthday_outcome(self.emp, THU, refresh=True)

    def closing_punch_only(self):
        """Wednesday left open; Thursday's only punch (05:30) closes it by the next-morning rule."""
        self.log(WED, time(8, 30), time(13, 0), time(14, 0))
        self.log(THU, time(5, 30))

    def test_the_helper_reads_a_closing_punch_as_not_worked(self):
        self.closing_punch_only()
        self.assertFalse(effects.day_worked(self.emp, THU))
        self.assertTrue(effects.day_worked(self.emp, WED))

    def test_a_casual_leave_approved_in_advance_then_worked_counts_and_gives_the_credit(self):
        cl = CasualLeaveRequest.objects.create(employee=self.emp, date=THU, portion="full", status="approved")
        _write_attendance_for_cl(cl, "HOD")
        self.worked(THU, time(17, 35))
        compute_range_records(self.emp, THU, THU, PayrollSettings.get())  # the manual row is never recomputed
        out = self.outcome()
        self.assertEqual(self.balance()["used"], 1)
        self.assertEqual((out["outcome"], out["claimable"]), (effects.BIRTHDAY_CREDIT_CLAIMABLE, True))

    def test_a_pending_casual_leave_on_a_closing_punch_only_birthday_is_free(self):
        self.closing_punch_only()
        compute_range_records(self.emp, WED, THU, PayrollSettings.get())
        CasualLeaveRequest.objects.create(employee=self.emp, date=THU, portion="full", status="pending")
        self.assertEqual(self.stored(THU).compensation_kind, "birthday")
        self.assertEqual(self.balance()["pending"], 0)

    def test_a_half_casual_leave_on_a_closing_punch_only_birthday_is_free(self):
        self.closing_punch_only()
        CasualLeaveRequest.objects.create(employee=self.emp, date=THU, portion="first_half", status="approved")
        compute_range_records(self.emp, WED, THU, PayrollSettings.get())
        self.assertEqual(self.balance()["used"], 0)

    def test_a_full_casual_leave_on_a_closing_punch_only_birthday_is_free_and_paid_leave(self):
        self.closing_punch_only()
        compute_range_records(self.emp, WED, THU, PayrollSettings.get())
        cl = CasualLeaveRequest.objects.create(employee=self.emp, date=THU, portion="full", status="approved")
        _write_attendance_for_cl(cl, "HOD")
        out = self.outcome()
        self.assertEqual(self.balance()["used"], 0)
        self.assertEqual((out["outcome"], out["claimable"]), (effects.BIRTHDAY_PAID_LEAVE, False))

    def test_a_rejected_casual_leave_on_a_closing_punch_only_birthday_stays_paid_birthday_leave(self):
        self.closing_punch_only()
        compute_range_records(self.emp, WED, THU, PayrollSettings.get())
        cl = CasualLeaveRequest.objects.create(employee=self.emp, date=THU, portion="full", status="rejected")
        _write_attendance_for_cl(cl, "HOD")
        rec = self.stored(THU)
        self.assertEqual(
            (rec.status, rec.shifts_earned, rec.compensation_kind), ("present", Decimal("1.00"), "birthday")
        )


class BirthdayWorkedStrictTests(BirthdayWorkedTests):
    MODE = "strict"
    CODE = "VFX5"


class TypedLeaveOnTheBirthdayTests(eng.ClaimsEngineBase):
    """Decision 4: approved leave on a new-rule birthday that was not worked uses no leave balance."""

    CODE = "VFX6"

    def setUp(self):
        super().setUp()
        self.on(birthday_enabled=True)
        self.emp.date_of_birth = date(1990, 3, 5)
        self.emp.save()
        self.leave_type = LeaveType.objects.create(name="Sick Leave", code="VFSL")
        self.balance = LeaveBalance.objects.create(
            employee=self.emp, leave_type=self.leave_type, year=2026, allocated=5, used=0, remaining=5
        )

    def approve(self, start, end, days):
        from .leave_request_views import _deduct_leave_balance

        leave = LeaveRequest.objects.create(
            employee=self.emp,
            type="Sick Leave",
            leave_type_ref=self.leave_type,
            start_date=start.isoformat(),
            end_date=end.isoformat(),
            total_days=days,
            status="approved",
            reason="x",
        )
        _deduct_leave_balance(leave)
        self.balance.refresh_from_db()
        return Decimal(str(self.balance.used))

    def test_a_one_day_leave_on_the_unworked_birthday_uses_nothing(self):
        self.assertEqual(self.approve(THU, THU, 1), Decimal("0"))

    def test_a_leave_over_the_birthday_uses_the_other_days(self):
        self.assertEqual(self.approve(WED, FRI, 3), Decimal("2"))

    def test_a_leave_on_a_worked_birthday_uses_the_balance(self):
        self.worked(THU, time(17, 30))
        self.assertEqual(self.approve(THU, THU, 1), Decimal("1"))

    def test_before_the_claims_date_the_balance_is_used_as_before(self):
        base.set_config(claims_from=date(2026, 3, 10))
        self.assertEqual(self.approve(THU, THU, 1), Decimal("1"))


# ═════════════════════════════ detection never undoes an approval ═════════════════════════════


class StaleSnapshotTests(eng.ClaimsEngineBase):
    """A detection pass whose snapshot (and NOT EXISTS subquery) predates an approval must leave the approved row alone:
    sync_overtime locks the rows first and asks for approved claims again (the READ COMMITTED race of an ot_allowance
    approval, which never writes its row). Simulated: the pass's own claim checks are blinded."""

    CODE = "VFX7"

    def test_an_approved_allowance_row_is_neither_pruned_nor_changed(self):
        self.on(allowance_enabled=True, shift_enabled=True, relaxation_enabled=True, pay_enabled=True)
        self.worked(MON, time(18, 45))
        self.month()
        row = {r.date: r for r in detect_overtime_for_month(2026, 3)}[MON]
        self.claim("ot_allowance", MON, record=row, minutes=row.allowance_minutes)
        self.punch(MON, time(8, 30), time(13, 0), time(14, 0), time(17, 30))  # the day no longer has OT
        self.month()
        with (
            mock.patch("api.overtime._claimed_record_ids", return_value=set()),
            mock.patch("api.overtime._has_claim", return_value=Q(pk__in=[])),
        ):
            sync_overtime(MON, MON, prune=True)
        self.assertTrue(OvertimeRecord.objects.filter(pk=row.pk).exists())


# ═════════════════════════════ the claims side (the attendance side pinned) ═════════════════════════════


class BirthdayReadsTests(ClaimsBase):
    def setUp(self):
        super().setUp()
        patch = mock.patch.object(effects, "birthday_outcome", REAL_BIRTHDAY_OUTCOME)
        patch.start()
        self.addCleanup(patch.stop)

    def test_a_birthdays_view_role_with_compensation_edit_never_rewrites_the_day(self):
        limited = _hr(_hr_user("vfx_lim", {"compensation": "edit", "compensation.leave.birthdays": "view"}))
        AttendanceDayRecord.objects.create(
            employee=self.asha, date=BIRTHDAY, status="absent", shifts_earned=Decimal("0"), source="auto"
        )
        _punch(self.asha, BIRTHDAY)
        before = AttendanceDayRecord.objects.get(employee=self.asha, date=BIRTHDAY).updated_at
        for path, extra in (("/api/compensation/birthdays", {}), ("/api/compensation/reports", {"type": "birthday"})):
            response = self.client.get(path, {"period": "month", "date": BIRTHDAY.isoformat(), **extra}, **limited)
            self.assertEqual(response.status_code, 200, response.content)
        self.assertEqual(AttendanceDayRecord.objects.get(employee=self.asha, date=BIRTHDAY).updated_at, before)
        # an editor of the page works it out (the control)
        self.client.get("/api/compensation/birthdays", {"period": "month", "date": BIRTHDAY.isoformat()}, **self.admin)
        self.assertNotEqual(AttendanceDayRecord.objects.get(employee=self.asha, date=BIRTHDAY).updated_at, before)

    def test_applied_follows_the_outcome_not_a_stale_marker(self):
        AttendanceDayRecord.objects.create(
            employee=self.asha,
            date=BIRTHDAY,
            status="on_leave",
            shifts_earned=Decimal("0"),
            source="manual",
            compensation_kind="birthday",
        )
        rows = self.get("/api/compensation/birthdays", period="month", date=BIRTHDAY.isoformat()).json()["results"]
        row = next(r for r in rows if r["employeeId"] == self.asha.id)
        self.assertNotEqual(row["outcome"], effects.BIRTHDAY_PAID_LEAVE)
        self.assertFalse(row["applied"])
        report = self.get("/api/compensation/reports", period="month", date=BIRTHDAY.isoformat(), type="birthday")
        statuses = [r["status"] for r in report.json()["sections"][0]["rows"] if r["employeeId"] == self.asha.id]
        self.assertNotIn("applied", statuses)


class DecisionAnswersTests(ClaimsBase):
    def test_a_claim_withdrawn_before_the_click_answers_the_withdrawn_code(self):
        claim = self.made(self.emp_claim({"kind": "holiday_work", "date": SUNDAY.isoformat(), "reason": "x"}))
        self.assertEqual(
            self.client.delete(f"/api/employee/compensation/claims/{claim.id}", **self.asha_t).status_code, 204
        )
        response = self.decide(claim.id)
        self.assertEqual(response.status_code, 404)
        self.assertEqual(response.json()["code"], "withdrawn")

    def test_the_hod_reads_what_a_claim_really_is(self):
        """Old app builds read every row as holiday work: the reason says what it is (and holiday work is unchanged)."""
        self.credit(self.asha)
        self.made(self.emp_use({"date": USE_DAY.isoformat(), "shifts": 0.5, "reason": "family function"}))
        self.made(self.emp_claim({"kind": "holiday_work", "date": SUNDAY.isoformat(), "reason": "Dispatch"}))
        self.made(
            self.emp_claim(
                {"kind": "ot_allowance", "date": OT_ALLOW_DAY.isoformat(), "overtimeRecordId": self.allow_rec.id}
            )
        )
        rows = {
            r["kind"]: r
            for r in self.client.get("/api/manager/pending-requests", **self.hod).json()["holidayWorkClaims"]
        }
        self.assertEqual(
            rows["use_balance"]["reason"],
            "Use of compensation balance (a day off taken from the balance): family function",
        )
        self.assertTrue(
            rows["ot_allowance"]["reason"].startswith("OT late-in allowance (nothing is added to the balance)")
        )
        self.assertEqual(rows["holiday_work"]["reason"], "Dispatch")
        # HR's own list keeps the employee's words
        hr_rows = {r["kind"]: r for r in self.get("/api/compensation/claims", anyMonth=1).json()["items"]}
        self.assertEqual(hr_rows["use_balance"]["reason"], "family function")


class HodDedupeTests(ClaimsBase):
    def waiting(self):
        return Notification.objects.filter(employee=self.boss, source="approval_waiting").count()

    def test_a_claim_raised_again_with_other_figures_is_told_again(self):
        def raise_with(shifts):
            response = self.hr_claim(
                {
                    "kind": "ot_shift",
                    "date": OT_SHIFT_DAY.isoformat(),
                    "reason": "x",
                    "items": [{"employeeId": self.asha.id, "overtimeRecordId": self.shift_rec.id, "shifts": shifts}],
                }
            )
            self.assertEqual(response.status_code, 201, response.content)
            return response.json()["claims"][0]["id"]

        first = raise_with("0.75")
        self.assertEqual(self.client.delete(f"/api/compensation/claims/{first}", **self.admin).status_code, 204)
        second = raise_with("0.75")
        self.assertEqual(self.waiting(), 1)  # the same claim again: told once
        self.assertEqual(self.client.delete(f"/api/compensation/claims/{second}", **self.admin).status_code, 204)
        raise_with("0.50")
        self.assertEqual(self.waiting(), 2)  # different figures: told again

    def test_the_key_carries_the_amount(self):
        one = HolidayWorkClaim(employee=self.asha, kind="ot_allowance", work_date=OT_ALLOW_DAY, shifts=0, minutes=30)
        two = HolidayWorkClaim(employee=self.asha, kind="ot_allowance", work_date=OT_ALLOW_DAY, shifts=0, minutes=45)
        self.assertNotEqual(claims.hod_dedupe(one), claims.hod_dedupe(two))


class RaiseRightTests(ClaimsBase):
    def enabled(self, who):
        response = self.client.get("/api/compensation/holiday-work/eligible", {"date": SUNDAY.isoformat()}, **who)
        self.assertEqual(response.status_code, 200, response.content)
        return response.json()["enabled"]

    def test_can_raise_needs_edit_on_the_claims_sub_tab(self):
        who = _hr(
            _hr_user(
                "vfx_rz",
                {"compensation": "view", "compensation.leave.holiday_work.raise": "edit", CLAIMS_KEY: "view"},
            )
        )
        refused = self.enabled(who)
        self.assertFalse(refused["canRaise"])
        self.assertIn("Edit on Compensation > Leave > Holiday work > Claims", refused["raiseProblem"])
        allowed = self.enabled(self.admin)
        self.assertEqual((allowed["canRaise"], allowed["raiseProblem"]), (True, None))
        strip = self.get("/api/compensation/holiday-work/month", who=who, month=10, year=2026).json()
        self.assertFalse(strip["enabled"]["canRaise"])


class OtPayQuartersTests(ClaimsBase):
    def setUp(self):
        super().setUp()
        self._patch("staff_ot_credit", new=REAL_STAFF_OT_CREDIT)
        self._patch("quarter_rule_applies", new=REAL_QUARTER_RULE_APPLIES)
        self.shift = base.make_shift(name="VFX 480")  # 08:30-17:30, 60 min lunch = 480 working minutes
        EmployeeShiftAssignment.objects.create(employee=self.asha, shift=self.shift, effective_from=date(2020, 1, 1))

    def record(self, day, minutes):
        return OvertimeRecord.objects.create(
            employee=self.asha,
            date=day,
            shift_end_time=time(17, 30),
            last_punch_out=time(19, 10),
            ot_minutes=minutes,
            ot_type=OvertimeRecord.OT_TYPE_SHIFT,
            status=OvertimeRecord.STATUS_DETECTED,
            suggested_shifts=Decimal("0.75"),
        )

    def pay(self, day):
        return self.client.post(
            "/api/compensation/ot/assign",
            {"records": [{"employeeId": self.asha.id, "date": day.isoformat()}], "mode": "pay"},
            content_type="application/json",
            **self.admin,
        )

    def ot_row(self, rec):
        # a view-only login: the list never syncs detection (that would prune these hand-made rows)
        rows = self.get("/api/compensation/ot", who=self.view_only, month=10, year=2026).json()["results"]
        return next(r for r in rows if r["id"] == rec.id)

    def test_below_a_quarter_there_is_nothing_to_pay(self):
        rec = self.record(date(2026, 10, 6), 100)
        self.assertIsNone(self.ot_row(rec)["suggestedShifts"])
        self.pay(rec.date)
        rec.refresh_from_db()
        self.assertEqual((rec.status, rec.shifts), (OvertimeRecord.STATUS_DETECTED, None))

    def test_pay_defaults_to_the_quarters_credit(self):
        rec = self.record(date(2026, 10, 6), 300)  # 300 / 480 = 0.625 -> 0.50 (the ladder said 0.75)
        self.assertEqual(self.ot_row(rec)["suggestedShifts"], 0.5)
        response = self.pay(rec.date)
        self.assertEqual(response.status_code, 200, response.content)
        rec.refresh_from_db()
        self.assertEqual(rec.shifts, Decimal("0.50"))


class ReportLedgerTests(ClaimsBase):
    def report(self):
        response = self.get("/api/compensation/reports", period="month", date=TODAY.isoformat(), type="holiday_work")
        self.assertEqual(response.status_code, 200, response.content)
        return response.json()["sections"][0]

    def test_earlier_alternative_day_credits_are_reported(self):
        rec = OvertimeRecord.objects.create(
            employee=self.ravi,
            date=date(2026, 10, 5),
            shift_end_time=time(17, 30),
            last_punch_out=time(18, 45),
            ot_minutes=75,
            ot_type=OvertimeRecord.OT_TYPE_ALLOWANCE,
            status=OvertimeRecord.STATUS_ANNOUNCED,
            compensation_type=OvertimeRecord.TYPE_RELAXATION,
        )
        legacy = CompensationLeaveCredit.objects.create(employee=self.ravi, source_overtime_record=rec)
        section = self.report()
        rows = [c for c in section["credits"] if c.get("legacyCreditId") == legacy.id]
        self.assertEqual(
            [(r["workDate"], r["shifts"], r["reason"]) for r in rows],
            [("2026-10-05", 1.0, "Earlier Alternative Day credit")],
        )
        self.assertEqual((section["summary"]["legacyCredits"], section["summary"]["legacyCreditShifts"]), (1, 1.0))
        led = self.get("/api/compensation/ledger", month=10, year=2026).json()["summary"]
        self.assertEqual(section["summary"]["creditedShifts"], led["creditShifts"])

    def test_a_legacy_mirror_debit_is_not_counted_as_used(self):
        CompensationLedger.objects.create(
            employee=self.asha, entry_type="debit", shifts=Decimal("1.00"), date=USE_DAY, source="legacy_credit"
        )
        CompensationLedger.objects.create(
            employee=self.asha, entry_type="debit", shifts=Decimal("0.50"), date=USE_DAY, source="redemption"
        )
        summary = self.report()["summary"]
        led = self.get("/api/compensation/ledger", month=10, year=2026).json()["summary"]
        self.assertEqual(summary["redeemedShifts"], led["debitShifts"])
        self.assertEqual(summary["countedRedeemedShifts"], led["countedDebitShifts"])
        self.assertEqual(summary["countedRedeemedShifts"], 0.5)


class OffSaturdayTests(ClaimsBase):
    """Coverage gap: working one's own off Saturday is holiday work (owner decision 4)."""

    SAT = date(2026, 10, 10)

    def setUp(self):
        super().setUp()
        shift = ShiftTemplate.objects.create(name="VFX day", start_time=time(9, 0), end_time=time(18, 0))
        EmployeeShiftAssignment.objects.create(
            employee=self.ravi, shift=shift, effective_from=date(2026, 1, 1), saturday_off=True
        )
        EmployeeShiftAssignment.objects.create(
            employee=self.asha, shift=shift, effective_from=date(2026, 1, 1), saturday_off=False
        )
        _punch(self.ravi, self.SAT)
        _punch(self.asha, self.SAT)

    def raise_for(self, emp):
        return self.hr_claim(
            {
                "kind": "holiday_work",
                "date": self.SAT.isoformat(),
                "reason": "Dispatch",
                "items": [{"employeeId": emp.id}],
            }
        )

    def test_hr_raises_it_and_the_rows_say_off_saturday(self):
        response = self.raise_for(self.ravi)
        self.assertEqual(response.status_code, 201, response.content)
        row = response.json()["claims"][0]
        self.assertEqual((row["dayKind"], row["holidayName"]), ("off_saturday", "Off Saturday"))

    def test_a_working_saturday_is_refused(self):
        response = self.raise_for(self.asha)
        self.assertEqual(response.status_code, 400, response.content)
        self.assertIn("off Saturday", response.json()["error"])

    def test_the_employee_can_claim_it(self):
        items = self.client.get("/api/employee/compensation", **_emp_token(self.ravi)).json()["items"]
        found = [i for i in items if i.get("date") == self.SAT.isoformat() and i.get("kind") == "holiday_work"]
        self.assertEqual(len(found), 1)
        self.assertTrue(found[0]["claimable"])
        self.assertIn("Off Saturday", found[0]["title"])
        response = self.emp_claim(
            {"kind": "holiday_work", "date": self.SAT.isoformat(), "reason": "x"}, who=_emp_token(self.ravi)
        )
        self.assertEqual(response.status_code, 201, response.content)
        refused = self.emp_claim({"kind": "holiday_work", "date": self.SAT.isoformat(), "reason": "x"})
        self.assertEqual(refused.status_code, 400)

    def test_the_raise_strip_and_the_eligible_list(self):
        days = self.get("/api/compensation/holiday-work/month", month=10, year=2026).json()["days"]
        sat = next(d for d in days if d["date"] == self.SAT.isoformat())
        self.assertEqual((sat["kind"], sat["kindLabel"], sat["worked"]), ("off_saturday", "Off Saturday", 1))
        self.assertFalse(any(d["date"] == "2026-10-17" for d in days))  # nobody worked it: no other Saturday shows
        body = self.get("/api/compensation/holiday-work/eligible", date=self.SAT.isoformat()).json()
        self.assertEqual(body["dayKind"], "off_saturday")
        self.assertEqual([e["employeeId"] for e in body["employees"]], [self.ravi.id])


class ClaimsDateTests(ClaimsBase):
    """Coverage gap: the claims date is editable, forward only (owner decision 6)."""

    def put(self, value, today=TODAY):
        with mock.patch("api.compensation_settings_views.ist_today", return_value=today):
            return self.client.put(
                "/api/compensation/settings", {"claims": {"from": value}}, content_type="application/json", **self.admin
            )

    def test_forward_is_saved_and_audited(self):
        from .models import AuditLog

        response = self.put("2026-12-01")
        self.assertEqual(response.status_code, 200, response.content)
        self.assertEqual(CompensationConfig.get().claims_from, date(2026, 12, 1))
        self.assertEqual(response.json()["claims"]["from"], "2026-12-01")
        self.assertTrue(response.json()["warnings"])
        self.assertTrue(AuditLog.objects.filter(new_values__claims_from="2026-12-01").exists())

    def test_earlier_past_and_cleared_are_refused(self):
        for value in ("2026-09-01", "2026-10-10", None, "", "soon"):
            response = self.put(value)
            self.assertEqual(response.status_code, 400, (value, response.content))
        self.assertEqual(CompensationConfig.get().claims_from, CLAIMS_FROM)

    def test_unchanged_is_fine_and_min_from_is_the_later_of_saved_and_today(self):
        self.assertEqual(self.put(CLAIMS_FROM.isoformat()).status_code, 200)
        with mock.patch("api.compensation_settings_views.ist_today", return_value=TODAY):
            body = self.get("/api/compensation/settings").json()
        self.assertEqual(body["claims"]["minFrom"], TODAY.isoformat())


class LegacyAnnouncementTests(ClaimsBase):
    """Coverage gap: an older Compensation Day (kind 'day') can be removed like a window."""

    def setUp(self):
        super().setUp()
        CompensationConfig.objects.filter(pk=1).update(windows_enabled=True)
        self.ann = CompensationDayAnnouncement.objects.create(date=date(2026, 10, 5), kind="day", reason="Festival")
        for target in ("api.compensation_windows_views.ist_today", "api.compensation_views.ist_today"):
            patch = mock.patch(target, return_value=TODAY)
            patch.start()
            self.addCleanup(patch.stop)

    def row(self, who=None):
        body = self.get("/api/compensation/windows", who=who, kind="all", month=10, year=2026).json()
        return next(x for x in body.get("items", body.get("results", [])) if x["id"] == self.ann.id)

    def test_it_can_be_removed(self):
        row = self.row()
        self.assertEqual((row["canDelete"], row["deleteBlockedReason"]), (True, None))
        response = self.client.delete(f"/api/compensation/windows/{self.ann.id}", **self.admin)
        self.assertEqual(response.status_code, 204, response.content)
        self.assertFalse(CompensationDayAnnouncement.objects.filter(pk=self.ann.pk).exists())

    def test_the_row_says_why_not(self):
        self.assertIn("view Compensation", self.row(self.view_only)["deleteBlockedReason"])
        PayrollMonthClose.objects.create(month=10, year=2026, finalized_at=timezone.now(), finalized_by="t")
        row = self.row()
        self.assertFalse(row["canDelete"])
        self.assertIn("is done", row["deleteBlockedReason"])
        self.assertEqual(self.client.delete(f"/api/compensation/windows/{self.ann.id}", **self.admin).status_code, 409)

"""
Attendance Edit, every attendance feature (owner brief 2026-11-24): each approved edit writes its own module's record, the
Department Head then HR approve every edit, a day whose payroll is finalized cannot change, and an approval applies exactly
once.

  compensation types -> an approved use_balance claim + its ledger debit, the day topped up (the balance is checked when
                        HR proposes it, held while it waits, and checked again when HR approves it)
  on_duty            -> a completed OnDutySession for the day (no outpass), the day a worked On-Duty day
  leave              -> an approved LeaveRequest, the day On Leave
  missing_punch      -> an approved MissingPunchRequest + the punch, the day judged again
  early_out          -> the Early-Out mark set / taken away
  penalty_waiver     -> the Penalty Early-Out deduction added back
  ot_pay             -> the detected Type 2 overtime set to Pay

Run via: DB_TEST_NAME=test_uktex_alloptions python manage.py test api.tests_attendance_edit_all_options
"""

from datetime import date, time
from decimal import Decimal

from django.utils import timezone

from . import attendance_edit as edit
from .clock import FACTORY_TZ
from .compensation_apply import balance_of
from .models import (
    AttendanceDayRecord,
    AttendanceLog,
    AttendanceOverrideRequest,
    CompensationConfig,
    CompensationLedger,
    Employee,
    HolidayWorkClaim,
    LeaveRequest,
    MissingPunchRequest,
    OnDutySession,
    OutpassRequest,
    OvertimeRecord,
    PayrollMonthClose,
)
from .payroll_calendar import calendar_extras
from .tests_attendance_edit_round import RoundBase, _stored


class Base(RoundBase):
    def context(self, d):
        r = self.send("get", f"/api/attendance/edit-context?employeeId={self.emp.id}&date={d}")
        self.assertEqual(r.status_code, 200, r.content)
        return r.json()

    def items(self, d):
        return {g["key"]: g["items"] for g in self.context(d)["options"]}

    def item(self, d, group, key=None):
        found = self.items(d)[group]
        return next(i for i in found if i["key"] == (key or group))

    def credit(self, shifts="1.00", emp=None):
        return CompensationLedger.objects.create(
            employee=emp or self.emp,
            entry_type=CompensationLedger.ENTRY_CREDIT,
            shifts=Decimal(shifts),
            date=date(2026, 11, 1),
            source="holiday_work",
            note="test credit",
        )

    def refused(self, r, words):
        self.assertEqual(r.status_code, 400, r.content)
        self.assertIn(words, r.json()["error"])

    def values(self, pk):
        return AttendanceOverrideRequest.objects.get(pk=pk).requested_values


# ═════════════════════════════ compensation ═════════════════════════════


class CompensationUsesTheBalanceTests(Base):
    D = date(2026, 11, 10)

    def test_the_dialog_offers_only_what_the_balance_and_the_day_can_take(self):
        comp = self.item(self.D, "compensation")
        self.assertFalse(comp["available"])
        self.assertIn("0.00 shift", comp["unavailableReason"])
        self.assertFalse(comp["worked"])  # the day is topped up from the balance, not typed in
        self.credit("0.50")
        body = self.context(self.D)
        comp = next(i for g in body["options"] if g["key"] == "compensation" for i in g["items"])
        self.assertTrue(comp["available"])
        self.assertEqual(comp["shiftChoices"], ["0.25", "0.50"])
        self.assertEqual((comp["balanceAvailable"], comp["dayShifts"]), (0.5, "0.00"))
        self.assertEqual(body["compensationBalance"]["available"], 0.5)

    def test_an_approved_compensation_edit_is_a_day_off_from_the_balance(self):
        self.credit("1.00")
        pk = self.approve_both(self.D, "ot_compensation", shifts="0.75")
        claim = HolidayWorkClaim.objects.get(employee=self.emp, kind=HolidayWorkClaim.KIND_USE_BALANCE)
        self.assertEqual(
            (claim.status, claim.work_date, f"{claim.shifts:.2f}", claim.raised_by_role),
            ("approved", self.D, "0.75", "hr"),
        )
        self.assertTrue(all(e.get("via") == "attendance_correction" for e in claim.approval_trail))
        self.assertEqual([e["role"] for e in claim.approval_trail], ["hod", "hr"])
        debit = CompensationLedger.objects.get(claim=claim, entry_type=CompensationLedger.ENTRY_DEBIT)
        self.assertEqual((f"{debit.shifts:.2f}", debit.date), ("0.75", self.D))
        self.assertEqual(balance_of(self.emp), Decimal("0.25"))
        rec = self.record(self.D)
        self.assertEqual((f"{rec.shifts_earned:.2f}", rec.compensation_kind), ("0.75", "relaxation"))
        values = self.values(pk)
        self.assertEqual((values["claimId"], values["useShifts"]), (claim.id, "0.75"))
        self.assertTrue(values["appliedAt"])

    def test_more_than_the_balance_or_the_day_is_refused_and_production_has_none(self):
        self.credit("0.25")
        self.refused(self.propose(self.D, "compensation", shifts="0.50"), "At most 0.25 shift")
        worker = Employee.objects.create(
            employee_code="P7", first_name="Ravi", last_name="M", status="active", employment_type="production",
            join_date="2020-01-01",
        )  # fmt: skip
        r = self.propose(self.D, "compensation", emp=worker, shifts="0.25")
        self.assertEqual(r.status_code, 400)  # production has no compensation (or no HOD): never a request
        self.assertFalse(AttendanceOverrideRequest.objects.exists())

    def test_waiting_edits_hold_the_balance(self):
        self.credit("0.50")
        self.assertEqual(self.propose(self.D, "compensation", shifts="0.50").status_code, 202)
        self.refused(self.propose(date(2026, 11, 11), "compensation", shifts="0.50"), "0.00 shift")
        # a new edit of the SAME day replaces the waiting one, so its hold is free for it
        self.assertEqual(self.propose(self.D, "compensation", shifts="0.25").status_code, 202)

    def test_the_balance_is_checked_again_when_hr_approves(self):
        self.credit("0.50")
        pk = self.propose(self.D, "compensation", shifts="0.50").json()["request"]["id"]
        self.assertEqual(self.hod_says(pk).status_code, 200)
        CompensationLedger.objects.create(
            employee=self.emp, entry_type="debit", shifts=Decimal("0.50"), date=date(2026, 11, 2), source="redemption"
        )  # the balance was used on the Compensation page meanwhile
        r = self.hr_says(pk)
        self.assertEqual((r.status_code, r.json()["code"]), (409, "edit_refused"))
        self.assertIn("0.00 shift", r.json()["error"])  # the balance is gone: nothing to use
        self.assertEqual(AttendanceOverrideRequest.objects.get(pk=pk).status, "pending")
        self.assertFalse(HolidayWorkClaim.objects.exists())

    def test_an_older_waiting_proposal_is_applied_the_old_way(self):
        # a compensation edit proposed before 2026-11-24 carries no "useBalance": a marked manual day, balance untouched
        values = edit.resolve({"type": "compensation", "shifts": "0.50", "note": "older client"})
        req = AttendanceOverrideRequest.objects.create(
            employee=self.emp, date=self.D, previous_values={}, requested_values=values, requested_by="HR",
            approval_trail=[{"role": "hod", "decision": "approved", "by": "Suresh"}],
        )  # fmt: skip
        edit.finalize(req, "Meena")
        rec = self.record(self.D)
        self.assertEqual(
            (rec.source, f"{rec.shifts_earned:.2f}", rec.compensation_kind), ("manual", "0.50", "relaxation")
        )
        self.assertFalse(HolidayWorkClaim.objects.exists())


# ═════════════════════════════ On-Duty ═════════════════════════════


class OnDutyRecordTests(Base):
    D = date(2026, 11, 6)

    def test_an_on_duty_edit_adds_a_completed_on_duty_record_on_the_day(self):
        pk = self.approve_both(self.D, "on_duty", destination="Buyer visit, Tiruppur")
        session = OnDutySession.objects.get(employee=self.emp)
        self.assertEqual((session.status, session.destination), ("completed", "Buyer visit, Tiruppur"))
        self.assertIsNotNone(session.employee_ended_at)  # never live: no geo punches, tracks or live map
        self.assertEqual(session.created_at.astimezone(FACTORY_TZ).date(), self.D)  # reports keyed on it: the day
        self.assertEqual(session.started_at.astimezone(FACTORY_TZ).date(), self.D)
        self.assertTrue(all(e.get("via") == "attendance_correction" for e in session.approval_trail))
        self.assertTrue(session.hod_reviewed_by and session.hr_reviewed_by)
        self.assertFalse(OutpassRequest.objects.exists())
        self.assertEqual(self.values(pk)["onDutySessionId"], session.id)
        rec = self.record(self.D)
        self.assertEqual((rec.status, f"{rec.shifts_earned:.2f}", rec.primary_source), ("present", "1.00", "On-Duty"))
        days, _off, _sync = calendar_extras(self.emp, date(2026, 11, 1), date(2026, 11, 30), [_stored(self.D)])
        self.assertEqual(days[0]["onDuty"]["state"], "verified")  # the edit's record counts as worked, not "no punches"
        self.assertEqual(days[0]["onDuty"]["destination"], "Buyer visit, Tiruppur")

    def test_approving_twice_writes_one_record(self):
        pk = self.approve_both(self.D, "on_duty")
        edit.finalize(AttendanceOverrideRequest.objects.get(pk=pk), "Meena")
        self.assertEqual(OnDutySession.objects.filter(employee=self.emp).count(), 1)
        self.assertEqual(OnDutySession.objects.get().destination, edit.HR_EDIT_DESTINATION)


# ═════════════════════════════ Leave ═════════════════════════════


class LeaveOptionTests(Base):
    D = date(2026, 11, 11)

    def test_the_dialog_offers_the_reasons_and_the_portions_the_day_allows(self):
        leave = self.item(self.D, "leave")
        self.assertEqual([c["value"] for c in leave["choices"]], ["sick", "emergency", "personal", "other"])
        portions = {p["value"]: p for p in leave["portions"]}
        self.assertTrue(portions["full"]["available"])
        self.assertFalse(portions["first_half"]["available"])  # an absent day is not a half day
        self.assertIn("half day", portions["first_half"]["unavailableReason"])

    def test_a_full_day_leave_is_an_approved_leave_and_the_day_is_on_leave(self):
        pk = self.approve_both(self.D, "leave", choice="sick", portion="full")
        leave = LeaveRequest.objects.get(employee=self.emp)
        self.assertEqual(
            (leave.status, leave.start_date, leave.end_date, f"{leave.total_days}", leave.is_half_day),
            ("approved", "2026-11-11", "2026-11-11", "1.0", False),
        )
        self.assertEqual((leave.reason_category, leave.type), ("sick", "Leave"))
        self.assertTrue(all(e.get("via") == "attendance_correction" for e in leave.approval_trail))
        self.assertEqual(self.values(pk)["leaveRequestId"], leave.id)
        rec = self.record(self.D)
        self.assertEqual((rec.status, f"{rec.shifts_earned:.2f}"), ("on_leave", "0.00"))
        self.assertEqual(self.values(pk)["typeLabel"], "Leave · Sick Leave")

    def test_a_day_with_punches_cannot_be_a_full_day_leave(self):
        self.punch(self.D, time(9, 0), time(18, 0))
        self.refused(self.propose(self.D, "leave", choice="personal", portion="full"), "has punches")
        portions = {p["value"]: p for p in self.item(self.D, "leave")["portions"]}
        self.assertFalse(portions["full"]["available"])

    def test_the_rules_of_the_leave_form(self):
        self.refused(self.propose(self.D, "leave", portion="full"), "Choose the reason")
        self.refused(self.propose(self.D, "leave", choice="sick", portion="first_half"), "half day")
        LeaveRequest.objects.create(
            employee=self.emp, start_date="2026-11-10", end_date="2026-11-12", total_days=3, status="pending"
        )
        self.refused(self.propose(self.D, "leave", choice="sick", portion="full"), "waiting for approval")
        self.refused(self.propose(date(2026, 11, 8), "leave", choice="sick", portion="full"), "a Sunday")


# ═════════════════════════════ Missing punch ═════════════════════════════


class MissingPunchOptionTests(Base):
    D = date(2026, 11, 12)

    def test_an_approved_missing_punch_edit_adds_its_request_and_the_punch(self):
        self.punch(self.D, time(9, 0))
        pk = self.approve_both(self.D, "missing_punch", choice="evening_out", punchTime="18:05")
        mp = MissingPunchRequest.objects.get(employee=self.emp)
        self.assertEqual(
            (mp.status, mp.punch_time, mp.punch_type, mp.punch_slot),
            ("approved", time(18, 5), "OUT", "evening_out"),
        )
        self.assertTrue(mp.hod_reviewed_by and mp.hr_reviewed_by)
        log = AttendanceLog.objects.get(employee=self.emp, date=self.D, punch_time=time(18, 5))
        self.assertEqual((log.punch_type, log.source), ("OUT", "missing_punch:approved"))
        self.assertEqual(self.values(pk)["missingPunchId"], mp.id)
        self.assertEqual(self.record(self.D).status, "present")

    def test_a_day_hr_fixed_by_hand_is_judged_again_with_the_punch(self):
        self.punch(self.D, time(9, 0))
        AttendanceDayRecord.objects.update_or_create(
            employee=self.emp, date=self.D, defaults={"status": "absent", "shifts_earned": 0, "source": "manual"}
        )
        self.approve_both(self.D, "missing_punch", choice="evening_out", punchTime="18:00")
        rec = self.record(self.D)
        self.assertEqual((rec.source, rec.status), ("auto", "present"))

    def test_a_time_is_needed_and_a_punch_already_there_is_refused(self):
        self.refused(self.propose(self.D, "missing_punch", choice="morning_in"), "time of the missing punch")
        self.refused(self.propose(self.D, "missing_punch", choice="morning_in", punchTime="25:00"), "time")
        self.refused(self.propose(self.D, "missing_punch", punchTime="09:00"), "which punch is missing")
        AttendanceLog.objects.create(employee=self.emp, date=self.D, punch_time=time(18, 5), punch_type="OUT")
        self.refused(
            self.propose(self.D, "missing_punch", choice="evening_out", punchTime="18:05"), "already has an OUT punch"
        )

    def test_the_employees_own_waiting_request_for_that_punch_comes_first(self):
        MissingPunchRequest.objects.create(
            employee=self.emp, date=self.D, punch_time=time(9, 2), punch_type="IN", punch_slot="morning_in",
            reason="forgot", status=MissingPunchRequest.STATUS_PENDING_HOD,
        )  # fmt: skip
        slots = {c["value"]: c for c in self.item(self.D, "missing_punch")["choices"]}
        self.assertFalse(slots["morning_in"]["available"])
        self.assertTrue(slots["evening_out"]["available"])
        self.refused(self.propose(self.D, "missing_punch", choice="morning_in", punchTime="09:02"), "waiting")


# ═════════════════════════════ Early-Out ═════════════════════════════


class EarlyOutOptionTests(Base):
    D = date(2026, 11, 13)

    def test_mark_and_unmark(self):
        self.punch(self.D, time(9, 0), time(18, 0))
        self.approve_both(self.D, "early_out", choice="mark")
        rec = self.record(self.D)
        self.assertEqual((rec.early_leave, rec.source), (True, "manual"))
        choices = {c["value"]: c for c in self.item(self.D, "early_out")["choices"]}
        self.assertFalse(choices["mark"]["available"])
        self.approve_both(self.D, "early_out", choice="unmark")
        self.assertFalse(self.record(self.D).early_leave)

    def test_what_cannot_be_marked(self):
        self.refused(self.propose(self.D, "early_out", choice="mark"), "not a worked day")
        self.refused(self.propose(self.D, "early_out", choice="unmark"), "not marked Early-Out")
        self.refused(self.propose(self.D, "early_out"), "Mark as Early-Out or Unmark Early-Out")


# ═════════════════════════════ Penalty waiver ═════════════════════════════


class PenaltyWaiverTests(Base):
    D = date(2026, 11, 16)

    def penalised(self):
        AttendanceDayRecord.objects.update_or_create(
            employee=self.emp,
            date=self.D,
            defaults={
                "status": "present",
                "shifts_earned": Decimal("0.75"),
                "penalty_early_out": True,
                "penalty_deduction": Decimal("0.25"),
                "early_out_minutes": 90,
                "first_punch": time(9, 0),
                "last_punch": time(16, 30),
                "source": "manual",
            },
        )

    def test_the_waiver_adds_the_deduction_back(self):
        self.penalised()
        item = self.item(self.D, "penalty_waiver")
        self.assertTrue(item["available"])
        self.assertEqual((item["shifts"], item["penaltyMinutes"]), ("0.25", 90))
        pk = self.approve_both(self.D, "penalty_waiver")
        rec = self.record(self.D)
        self.assertEqual(
            (f"{rec.shifts_earned:.2f}", rec.penalty_early_out, f"{rec.penalty_deduction:.2f}"), ("1.00", False, "0.00")
        )
        self.assertEqual(self.values(pk)["waivedShifts"], "0.25")

    def test_a_day_with_no_penalty_has_nothing_to_waive(self):
        self.assertFalse(self.item(self.D, "penalty_waiver")["available"])
        self.refused(self.propose(self.D, "penalty_waiver"), "no Penalty Early-Out deduction")


# ═════════════════════════════ OT pay ═════════════════════════════


class OtPayOptionTests(Base):
    D = date(2026, 11, 17)

    def setUp(self):
        super().setUp()
        cfg = CompensationConfig.get()
        cfg.shift_enabled = True
        cfg.pay_enabled = True
        cfg.save()

    def detected(self):
        self.punch(self.D, time(9, 0), time(20, 0))
        edit.fresh_day(self.emp, self.D)
        rec, _ = OvertimeRecord.objects.update_or_create(
            employee=self.emp,
            date=self.D,
            defaults={
                "last_punch_out": time(20, 0),
                "ot_minutes": 120,
                "status": OvertimeRecord.STATUS_DETECTED,
                "ot_type": OvertimeRecord.OT_TYPE_SHIFT,
                "suggested_shifts": Decimal("0.25"),
            },
        )
        return rec

    def test_detected_overtime_is_paid(self):
        rec = self.detected()
        item = self.item(self.D, "ot_pay")
        self.assertTrue(item["available"], item["unavailableReason"])
        self.assertEqual(item["otMinutes"], 120)
        pk = self.approve_both(self.D, "ot_pay", shifts="0.50")
        rec.refresh_from_db()
        self.assertEqual(
            (rec.status, rec.compensation_type, f"{rec.shifts:.2f}", rec.claim_date),
            ("announced", "pay", "0.50", None),
        )
        self.assertIn(f"attendance edit #{pk}", rec.notes)
        self.assertTrue(rec.announced_by)

    def test_nothing_detected_or_a_claim_on_it_is_refused(self):
        self.refused(self.propose(self.D, "ot_pay", shifts="0.50"), "No overtime was detected")
        rec = self.detected()
        HolidayWorkClaim.objects.create(
            employee=self.emp, work_date=self.D, shifts=Decimal("0.25"), kind=HolidayWorkClaim.KIND_OT_SHIFT,
            overtime_record=rec, status=HolidayWorkClaim.STATUS_PENDING,
        )  # fmt: skip
        self.refused(self.propose(self.D, "ot_pay", shifts="0.50"), "cannot also be paid")

    def test_an_amount_is_needed(self):
        self.detected()
        self.refused(self.propose(self.D, "ot_pay"), "how much overtime")


# ═════════════════════════════ Payroll Done ═════════════════════════════


class PayrollDoneLockTests(Base):
    D = date(2026, 11, 3)

    def close(self):
        PayrollMonthClose.objects.create(month=11, year=2026, finalized_at=timezone.now(), finalized_by="Meena")

    def test_a_finalized_month_cannot_be_edited(self):
        self.close()
        r = self.propose(self.D, "present")
        self.assertEqual((r.status_code, r.json()["code"]), (409, "locked"))
        self.assertIn("Payroll Done", r.json()["error"])
        body = self.context(self.D)
        self.assertTrue(body["locked"]["locked"])
        self.assertFalse(any(i["available"] for g in body["options"] for i in g["items"]))
        reset = self.send(
            "post", "/api/attendance/override", {"employeeId": self.emp.id, "date": str(self.D), "reset": True}
        )
        self.assertEqual(reset.status_code, 409)

    def test_an_edit_waiting_when_the_month_closes_cannot_be_approved(self):
        pk = self.propose(self.D, "present").json()["request"]["id"]
        self.assertEqual(self.hod_says(pk).status_code, 200)
        self.close()
        r = self.hr_says(pk)
        self.assertEqual((r.status_code, r.json()["code"]), (409, "edit_refused"))
        self.assertEqual(AttendanceOverrideRequest.objects.get(pk=pk).status, "pending")
        self.assertEqual(edit.fresh_day(self.emp, self.D).status, "absent")

    def test_the_department_head_cannot_approve_it_either(self):
        pk = self.propose(self.D, "present").json()["request"]["id"]
        self.close()
        r = self.hod_says(pk)
        self.assertEqual((r.status_code, r.json()["code"]), (409, "edit_refused"))
        # a rejection is still possible: it changes nothing
        self.assertEqual(self.hod_says(pk, "rejected", "month closed").status_code, 200)

    def test_an_open_month_is_not_locked(self):
        self.assertIsNone(edit.lock_refusal(self.emp, self.D))
        self.assertFalse(self.context(self.D)["locked"]["locked"])


# ═════════════════════════════ exactly once ═════════════════════════════


class ApplyOnceTests(Base):
    D = date(2026, 11, 9)

    def test_a_second_final_approval_applies_nothing_again(self):
        self.credit("1.00")
        pk = self.approve_both(self.D, "compensation", shifts="0.50")
        req = AttendanceOverrideRequest.objects.get(pk=pk)
        edit.finalize(req, "Meena again")
        self.assertEqual(HolidayWorkClaim.objects.count(), 1)
        self.assertEqual(CompensationLedger.objects.filter(entry_type="debit").count(), 1)
        self.assertEqual(balance_of(self.emp), Decimal("0.50"))
        self.assertEqual(req.requested_values["claimId"], HolidayWorkClaim.objects.get().id)  # the stored values

    def test_a_leave_edit_approved_twice_is_one_leave(self):
        pk = self.approve_both(self.D, "leave", choice="other", portion="full")
        edit.finalize(AttendanceOverrideRequest.objects.get(pk=pk), "Meena")
        self.assertEqual(LeaveRequest.objects.filter(employee=self.emp).count(), 1)

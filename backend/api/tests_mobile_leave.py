"""
Mobile pages round 2026-10-31, Leave slice: half-day Casual Leave and the leave form's reason category.

Owner decisions pinned here:
  1. The month's one Casual Leave is EITHER one full day OR two half-days (first / second half of the shift) on any dates
     of that month (both halves may be the same date). A pending/approved full CL blocks halves and vice versa; at most
     two halves; the same date cannot hold the same half twice. A half-day CL pays half a day; the other half of that day
     counts by the punches exactly as it does for a Half-Day Leave.
  2. Sick / Emergency / Personal / Other = a reason category saved on the leave request. It changes neither the leave type
     nor any balance. Older clients that send none keep working.

Run via: DATABASE_URL= DB_TEST_NAME=uktex_test_leave python manage.py test api.tests_mobile_leave
"""

from datetime import date, time
from decimal import Decimal
from unittest import mock

from django.test import TestCase

from . import approval_workflow as approval
from .attendance_final import compute_day_record, compute_month_records
from .jwt_utils import sign_token
from .models import (
    AttendanceDayRecord,
    AttendanceLog,
    CasualLeaveRequest,
    Employee,
    EmployeeShiftAssignment,
    HRUser,
    LeaveBalance,
    LeaveRequest,
    LeaveType,
    PayrollSettings,
    ShiftTemplate,
)

TODAY = date(2026, 10, 15)  # a Thursday


def _bearer(payload: dict) -> dict:
    return {"HTTP_AUTHORIZATION": f"Bearer {sign_token(payload)}"}


class _Staff(TestCase):
    """A staff employee on a 09:00-18:00 shift (simple mode), eligible for Casual Leave, with every clock pinned."""

    def setUp(self):
        approval.clear_cache()
        for target in (
            "api.casual_leave_views.ist_today",
            "api.request_window.ist_today",
            "api.attendance_final.ist_today",
        ):
            pin = mock.patch(target, return_value=TODAY)
            pin.start()
            self.addCleanup(pin.stop)
        settings = PayrollSettings.get()
        settings.attendance_mode = "simple"
        settings.save()
        self.shift = ShiftTemplate.objects.create(
            name="ML Day Shift",
            shift_type="staff",
            start_time=time(9, 0),
            end_time=time(18, 0),
            grace_period_minutes=15,
            first_half_end=time(13, 0),
            lunch_duration_minutes=60,
        )
        self.emp = self.staff("ML1")
        self.admin = HRUser.objects.create(username="ml_admin", password_hash="x", is_super_admin=True)
        self.hr = _bearer({"role": "hr", "hrUserId": self.admin.id})

    def staff(self, code, kind="staff"):
        emp = Employee.objects.create(
            employee_code=code,
            first_name=code,
            last_name="Leave",
            employment_type=kind,
            status="active",
            join_date="2024-01-01",
        )
        EmployeeShiftAssignment.objects.create(employee=emp, shift=self.shift, effective_from=date(2020, 1, 1))
        return emp

    def me(self, emp=None):
        return _bearer({"role": "employee", "employeeId": (emp or self.emp).id})

    def punch(self, d, *times, emp=None):
        for t in times:
            AttendanceLog.objects.create(employee=emp or self.emp, date=d, punch_time=t, punch_type="IN", source="test")

    def cl(self, d, portion="full", status="approved", emp=None):
        return CasualLeaveRequest.objects.create(
            employee=emp or self.emp, date=d, portion=portion, status=status, approval_trail=[]
        )

    def post_cl(self, d, portion=None, who=None):
        body = {"date": d}
        if portion is not None:
            body["portion"] = portion
        return self.client.post("/api/casual-leaves", body, content_type="application/json", **(who or self.me()))


# ── 1. The attendance engine ──────────────────────────────────────────────────


class HalfCasualLeaveDayTests(_Staff):
    def day(self, d, half_cl=None, half_leave=None):
        return compute_day_record(
            self.emp,
            d,
            settings=PayrollSettings.get(),
            leave_dates=set(),
            holiday_dates=set(),
            half_day_leave_dates=half_leave,
            half_cl_dates=half_cl,
        )

    def test_a_full_cl_is_unchanged_a_manual_paid_present_day(self):
        from .casual_leave_views import _write_attendance_for_cl

        d = date(2026, 10, 6)
        self.punch(d, time(9, 40), time(16, 0))  # late and early: none of it counts on a CL day
        cl = self.cl(d, "full")
        _write_attendance_for_cl(cl, "hr")
        rec = AttendanceDayRecord.objects.get(employee=self.emp, date=d)
        self.assertEqual((rec.status, rec.source, rec.shifts_earned), ("present", "manual", Decimal("1.00")))
        self.assertEqual((rec.is_late, rec.early_leave, rec.is_half_shift), (False, False, False))
        self.assertEqual(rec.override_note, "Casual Leave (paid) -approved")

    def test_first_half_cl_with_the_afternoon_worked_is_a_full_paid_day_and_not_late(self):
        d = date(2026, 10, 6)
        self.punch(d, time(14, 0), time(18, 5))
        rec = self.day(d, half_cl={d: {"first_half"}})
        self.assertEqual((rec.status, rec.shifts_earned, rec.is_half_shift), ("present", Decimal("1.00"), False))
        self.assertFalse(rec.is_late)
        self.assertFalse(rec.is_half_day_leave)  # it is Casual Leave, not a Half-Day Leave request
        self.assertEqual(rec.source, "auto")  # the punches stay in charge of the other half

    def test_second_half_cl_with_the_morning_worked_is_a_full_paid_day_and_no_early_out(self):
        d = date(2026, 10, 7)
        self.punch(d, time(9, 5), time(13, 0))
        rec = self.day(d, half_cl={d: {"second_half"}})
        self.assertEqual((rec.status, rec.shifts_earned), ("present", Decimal("1.00")))
        self.assertFalse(rec.early_leave)

    def test_second_half_cl_does_not_excuse_a_late_morning(self):
        d = date(2026, 10, 8)
        self.punch(d, time(9, 45), time(13, 0))  # inside the Late window: the morning they still owed was late
        rec = self.day(d, half_cl={d: {"second_half"}})
        self.assertEqual((rec.status, rec.shifts_earned), ("present", Decimal("1.00")))
        self.assertTrue(rec.is_late)

    def test_half_cl_with_no_punches_for_the_other_half_gives_what_a_half_day_leave_gives(self):
        # a Half-Day Leave day today: one half by the punches, the leave half unpaid -> Half Day 0.50
        leave_day = date(2026, 10, 9)
        self.punch(leave_day, time(14, 0), time(18, 0))
        half_leave = self.day(leave_day, half_leave={leave_day: LeaveRequest.HALF_DAY_MORNING})
        self.assertEqual((half_leave.status, half_leave.shifts_earned), ("half_shift", Decimal("0.50")))
        # a half-day CL with nothing worked: only the CL half is paid -> the same Half Day 0.50
        cl_day = date(2026, 10, 12)
        rec = self.day(cl_day, half_cl={cl_day: {"first_half"}})
        self.assertEqual((rec.status, rec.shifts_earned), (half_leave.status, half_leave.shifts_earned))
        self.assertTrue(rec.is_half_shift)
        # the other half is still unpaid, exactly as a Half-Day Leave's no-show would be (absent, nothing earned)
        no_show = self.day(date(2026, 10, 13), half_leave={date(2026, 10, 13): LeaveRequest.HALF_DAY_MORNING})
        self.assertEqual((no_show.status, no_show.shifts_earned), ("absent", Decimal("0.00")))

    def test_working_only_the_cl_half_is_not_paid_twice(self):
        d = date(2026, 10, 13)
        self.punch(d, time(9, 0), time(12, 30))  # came in for the morning they had taken as CL, left at lunch
        rec = self.day(d, half_cl={d: {"first_half"}})
        self.assertEqual((rec.status, rec.shifts_earned), ("half_shift", Decimal("0.50")))

    def test_a_day_worked_in_full_stays_one_day(self):
        d = date(2026, 10, 14)
        self.punch(d, time(9, 0), time(18, 0))
        rec = self.day(d, half_cl={d: {"second_half"}})
        self.assertEqual((rec.status, rec.shifts_earned), ("present", Decimal("1.00")))

    def test_both_halves_on_one_date_are_a_full_paid_day(self):
        d = date(2026, 10, 14)
        rec = self.day(d, half_cl={d: {"first_half", "second_half"}})
        self.assertEqual((rec.status, rec.shifts_earned, rec.is_half_shift), ("present", Decimal("1.00"), False))

    def test_a_sunday_is_left_alone(self):
        d = date(2026, 10, 11)  # Sunday, no punches
        rec = self.day(d, half_cl={d: {"first_half"}})
        self.assertEqual(rec.status, "holiday")

    def test_the_month_computation_reads_approved_half_cls_and_ignores_pending_or_rejected_ones(self):
        worked = date(2026, 10, 6)
        self.punch(worked, time(14, 0), time(18, 0))
        self.cl(worked, "first_half", "approved")
        waiting = date(2026, 10, 7)
        self.punch(waiting, time(14, 0), time(18, 0))
        self.cl(waiting, "second_half", "pending")
        records = {r.date: r for r in compute_month_records(self.emp, 2026, 10)}
        self.assertEqual((records[worked].status, records[worked].shifts_earned), ("present", Decimal("1.00")))
        self.assertEqual(records[waiting].status, "half_shift")  # nothing decided yet: the punches alone

    def test_a_production_employee_is_never_touched(self):
        prod = self.staff("MLP1", kind="production")
        d = date(2026, 10, 6)
        CasualLeaveRequest.objects.create(employee=prod, date=d, portion="first_half", status="approved")
        rec = compute_day_record(
            prod,
            d,
            settings=PayrollSettings.get(),
            leave_dates=set(),
            holiday_dates=set(),
            half_cl_dates={d: {"first_half"}},
        )
        self.assertEqual(rec.status, "absent")


class HalfCasualLeaveDecisionTests(_Staff):
    def decide(self, cl, status):
        r = self.client.patch(
            f"/api/casual-leaves/{cl.id}", {"status": status}, content_type="application/json", **self.hr
        )
        self.assertEqual(r.status_code, 200, r.content)
        return r.json()

    def test_approving_a_half_cl_recomputes_the_day_instead_of_fixing_it(self):
        d = date(2026, 10, 13)
        self.punch(d, time(14, 0), time(18, 0))
        compute_month_records(self.emp, 2026, 10)  # the day as it stood: a Half Day
        self.assertEqual(AttendanceDayRecord.objects.get(employee=self.emp, date=d).status, "half_shift")
        cl = self.cl(d, "first_half", "pending")
        body = self.decide(cl, "approved")
        self.assertEqual(body["portion"], "first_half")
        rec = AttendanceDayRecord.objects.get(employee=self.emp, date=d)
        self.assertEqual((rec.status, rec.shifts_earned, rec.source), ("present", Decimal("1.00"), "auto"))

    def test_rejecting_a_half_cl_leaves_the_day_to_the_punches(self):
        d = date(2026, 10, 13)
        self.punch(d, time(9, 5), time(13, 0))
        cl = self.cl(d, "second_half", "pending")
        self.decide(cl, "rejected")
        rec = AttendanceDayRecord.objects.get(employee=self.emp, date=d)
        self.assertEqual(
            (rec.status, rec.source), ("half_shift", "auto")
        )  # not the whole-day "on leave" a full one gets

    def test_a_day_hr_fixed_by_hand_is_not_overwritten(self):
        d = date(2026, 10, 13)
        AttendanceDayRecord.objects.create(
            employee=self.emp, date=d, status="absent", shifts_earned=0, source="manual", override_note="HR: absconded"
        )
        cl = self.cl(d, "first_half", "pending")
        self.decide(cl, "approved")
        rec = AttendanceDayRecord.objects.get(employee=self.emp, date=d)
        self.assertEqual((rec.status, rec.source), ("absent", "manual"))

    def test_a_future_date_is_left_for_the_day_itself(self):
        d = date(2026, 10, 20)
        cl = self.cl(d, "first_half", "pending")
        self.decide(cl, "approved")
        self.assertFalse(AttendanceDayRecord.objects.filter(employee=self.emp, date=d).exists())


# ── 2. Submitting Casual Leave ───────────────────────────────────────────────


class CasualLeaveSubmitTests(_Staff):
    def test_portion_defaults_to_a_full_day_for_older_apps(self):
        r = self.post_cl("2026-10-20")
        self.assertEqual(r.status_code, 201, r.content)
        self.assertEqual(r.json()["portion"], "full")
        self.assertEqual(r.json()["portionLabel"], "Full day")
        self.assertEqual(r.json()["days"], 1)

    def test_an_unknown_portion_is_refused_in_plain_words(self):
        r = self.post_cl("2026-10-20", "evening")
        self.assertEqual(r.status_code, 400)
        self.assertEqual(r.json()["error"], "Choose Full day, First half or Second half")

    def test_two_halves_on_different_dates_then_nothing_more(self):
        self.assertEqual(self.post_cl("2026-10-20", "first_half").status_code, 201)
        self.assertEqual(self.post_cl("2026-10-22", "first_half").status_code, 201)
        third = self.post_cl("2026-10-23", "second_half")
        self.assertEqual(third.status_code, 400)
        self.assertIn("Both half-days", third.json()["error"])

    def test_both_halves_of_the_same_date_are_allowed_but_not_the_same_half_twice(self):
        self.assertEqual(self.post_cl("2026-10-20", "first_half").status_code, 201)
        again = self.post_cl("2026-10-20", "first_half")
        self.assertEqual(again.status_code, 400)
        self.assertIn("first half of 20 Oct 2026 is already asked for", again.json()["error"])
        self.assertEqual(self.post_cl("2026-10-20", "second_half").status_code, 201)

    def test_a_full_day_blocks_halves(self):
        self.cl(date(2026, 10, 5), "full", "pending")
        r = self.post_cl("2026-10-20", "second_half")
        self.assertEqual(r.status_code, 400)
        self.assertEqual(r.json()["error"], "Casual Leave already used this month (limit: 1 per month)")

    def test_a_half_blocks_a_full_day_and_says_what_is_left(self):
        self.cl(date(2026, 10, 5), "first_half", "approved")
        r = self.post_cl("2026-10-20", "full")
        self.assertEqual(r.status_code, 400)
        self.assertIn("only the other half-day is left", r.json()["error"])
        self.assertEqual(self.post_cl("2026-10-20", "second_half").status_code, 201)

    def test_a_rejected_part_frees_its_place(self):
        self.cl(date(2026, 10, 5), "full", "rejected")
        self.cl(date(2026, 10, 6), "first_half", "rejected")
        self.assertEqual(self.post_cl("2026-10-20", "full").status_code, 201)

    def test_the_other_rules_still_apply_to_halves(self):
        prod = self.staff("MLP2", kind="production")
        r = self.post_cl("2026-10-20", "first_half", who=self.me(prod))
        self.assertEqual(r.status_code, 400)
        self.assertIn("only for staff", r.json()["error"])
        newcomer = self.staff("MLN1")
        newcomer.join_date = "2026-09-01"
        newcomer.save()
        self.assertEqual(self.post_cl("2026-10-20", "first_half", who=self.me(newcomer)).status_code, 400)
        # the request window: last month is closed on the 15th
        closed = self.post_cl("2026-09-20", "first_half")
        self.assertEqual(closed.status_code, 400)
        self.assertEqual(closed.json().get("code"), "request_window_closed")

    def test_an_employee_list_returns_the_portion_on_every_row(self):
        self.cl(date(2026, 10, 5), "second_half", "approved")
        self.cl(date(2026, 3, 5), "full", "rejected")
        rows = self.client.get("/api/casual-leaves?year=2026", **self.me()).json()
        self.assertEqual(sorted(r["portion"] for r in rows), ["full", "second_half"])
        self.assertEqual(next(r for r in rows if r["portion"] == "second_half")["days"], 0.5)


# ── 3. What the app is told ──────────────────────────────────────────────────


class MyEligibilityTests(_Staff):
    def mine(self):
        r = self.client.get("/api/casual-leaves/my-eligibility", **self.me())
        self.assertEqual(r.status_code, 200, r.content)
        return r.json()

    def this_month(self, body):
        return next(m for m in body["months"] if m["month"] == "2026-10")

    def test_nothing_used_leaves_a_full_day_and_old_keys_stay(self):
        body = self.mine()
        for key in ("eligible", "reason", "year", "yearlyEntitlement", "usedThisYear", "remainingThisYear", "months"):
            self.assertIn(key, body)
        month = self.this_month(body)
        self.assertEqual((month["eligible"], month["left"], month["usedHalves"]), (True, "full", []))
        self.assertEqual(body["shift"]["firstHalfEnd"], "13:00")
        self.assertEqual(body["shift"]["secondHalfStart"], "14:00")
        self.assertEqual((body["shift"]["start"], body["shift"]["end"]), ("09:00", "18:00"))

    def test_one_half_used_leaves_one_half_and_names_it(self):
        self.cl(date(2026, 10, 5), "first_half", "pending")
        body = self.mine()
        month = self.this_month(body)
        self.assertTrue(body["eligible"])
        self.assertEqual(month["left"], "one_half")
        self.assertEqual(month["usedHalves"], [{"date": "2026-10-05", "portion": "first_half"}])
        self.assertEqual(month["usedParts"][0]["status"], "pending")
        # October 2026 is before the yearly balance's cut-over (2026-11-02): its Casual Leave keeps the one-per-month rule
        # and holds nothing of the yearly balance (tests_attendance_edit_round covers the balance)
        self.assertEqual(body["waitingThisYear"], 0)

    def test_two_halves_or_a_full_day_leave_nothing(self):
        self.cl(date(2026, 10, 5), "first_half")
        self.cl(date(2026, 10, 6), "second_half")
        body = self.mine()
        self.assertFalse(body["eligible"])
        self.assertEqual(self.this_month(body)["left"], "nothing")
        self.assertIn("Both half-days", body["reason"])

    def test_the_year_counts_half_days_as_half(self):
        # since 2026-11-02 the year's figures are the yearly balance: only Casual Leave dated on/after the cut-over counts
        self.cl(date(2026, 3, 5), "full")  # before the cut-over: never deducted
        self.cl(date(2026, 11, 5), "full")
        self.cl(date(2026, 11, 6), "first_half")
        self.cl(date(2026, 11, 9), "second_half", "rejected")
        body = self.mine()
        self.assertEqual(body["usedThisYear"], 1.5)
        self.assertEqual(body["remainingThisYear"], 10.5)
        self.assertEqual(body["balance"]["used"], 1.5)

    def test_a_production_employee_has_nothing_left(self):
        prod = self.staff("MLP3", kind="production")
        body = self.client.get("/api/casual-leaves/my-eligibility", **self.me(prod)).json()
        self.assertEqual(self.this_month(body)["left"], "nothing")
        self.assertFalse(body["eligible"])


class BoardTests(_Staff):
    def test_one_half_used_is_still_eligible_for_the_other_half(self):
        self.cl(date(2026, 10, 5), "first_half", "approved")
        body = self.client.get("/api/casual-leaves/eligibility", **self.hr).json()
        row = next(r for r in body["employees"] if r["employeeId"] == self.emp.id)
        self.assertTrue(row["eligible"])
        self.assertTrue(row["usedThisMonth"])
        self.assertEqual(row["left"], "one_half")
        self.assertEqual(row["usedPortion"], "first_half")
        self.assertEqual(row["approvedThisYear"], 0.5)
        self.assertEqual(row["usedParts"][0]["portionLabel"], "Half day (first half)")

    def test_two_halves_are_used_this_month(self):
        self.cl(date(2026, 10, 5), "first_half", "approved")
        self.cl(date(2026, 10, 7), "second_half", "pending")
        body = self.client.get("/api/casual-leaves/eligibility", **self.hr).json()
        row = next(r for r in body["employees"] if r["employeeId"] == self.emp.id)
        self.assertFalse(row["eligible"])
        self.assertEqual(row["reasonCode"], "used_this_month")
        self.assertEqual(row["left"], "nothing")

    def test_the_requests_hub_names_the_half(self):
        self.cl(date(2026, 10, 5), "second_half", "pending")
        body = self.client.get("/api/hr-requests", {"kind": "casual_leave"}, **self.hr).json()
        row = body["items"][0]
        self.assertEqual(row["label"], "Casual Leave · Half day (second half)")
        self.assertIn("second half", row["summary"])

    def test_a_full_day_reads_as_before_in_the_hub(self):
        self.cl(date(2026, 10, 5), "full", "pending")
        row = self.client.get("/api/hr-requests", {"kind": "casual_leave"}, **self.hr).json()["items"][0]
        self.assertEqual((row["label"], row["summary"]), ("Casual Leave", "2026-10-05"))


# ── 4. The leave form's reason category ──────────────────────────────────────


class LeaveReasonCategoryTests(_Staff):
    def apply(self, **extra):
        body = {"startDate": "2026-10-20", "endDate": "2026-10-21", "reason": "Fever and rest", **extra}
        return self.client.post("/api/leave-requests", body, content_type="application/json", **self.me())

    def test_a_category_is_saved_and_returned_with_its_words(self):
        r = self.apply(reasonCategory="sick")
        self.assertEqual(r.status_code, 201, r.content)
        self.assertEqual((r.json()["reasonCategory"], r.json()["reasonCategoryLabel"]), ("sick", "Sick Leave"))
        self.assertEqual(r.json()["type"], "Leave")  # never "casual": Casual Leave is its own request now
        self.assertEqual(LeaveRequest.objects.get(pk=r.json()["id"]).reason_category, "sick")
        listed = self.client.get("/api/leave-requests", **self.me()).json()
        rows = listed["results"] if isinstance(listed, dict) else listed
        self.assertEqual(rows[0]["reasonCategory"], "sick")

    def test_every_category_and_its_words(self):
        words = {"sick": "Sick Leave", "emergency": "Emergency", "personal": "Personal", "other": "Other Reasons"}
        for key, label in words.items():
            r = self.apply(reasonCategory=key)
            self.assertEqual(r.json()["reasonCategoryLabel"], label, key)

    def test_an_unknown_category_is_refused(self):
        r = self.apply(reasonCategory="casual")
        self.assertEqual(r.status_code, 400)
        self.assertEqual(r.json()["error"], "Choose Sick Leave, Emergency, Personal or Other Reasons")

    def test_older_clients_without_a_category_keep_working(self):
        r = self.apply()
        self.assertEqual(r.status_code, 201, r.content)
        self.assertEqual((r.json()["reasonCategory"], r.json()["reasonCategoryLabel"]), ("", None))
        self.assertEqual(r.json()["type"], "casual")  # the old default, untouched

    def test_a_named_leave_type_still_wins(self):
        sick = LeaveType.objects.create(name="ML Sick Leave", code="MLSL")
        r = self.apply(reasonCategory="emergency", leaveTypeId=sick.id)
        self.assertEqual(r.json()["type"], "ML Sick Leave")
        self.assertEqual(r.json()["reasonCategory"], "emergency")

    def test_approving_a_category_request_touches_no_balance(self):
        a = LeaveType.objects.create(name="ML Annual", code="MLAL")
        b = LeaveType.objects.create(name="ML Sick", code="MLSK")
        for lt in (a, b):
            LeaveBalance.objects.create(employee=self.emp, leave_type=lt, year=2026, allocated=10, used=0, remaining=10)
        leave_id = self.apply(reasonCategory="personal").json()["id"]
        r = self.client.patch(
            f"/api/leave-requests/{leave_id}/status", {"status": "approved"}, content_type="application/json", **self.hr
        )
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(r.json()["status"], "approved")
        self.assertEqual(
            sorted(LeaveBalance.objects.filter(employee=self.emp).values_list("remaining", flat=True)),
            [Decimal("10"), Decimal("10")],
        )

    def test_the_requests_hub_shows_the_category(self):
        self.apply(reasonCategory="emergency")
        row = self.client.get("/api/hr-requests", {"kind": "leave"}, **self.hr).json()["items"][0]
        self.assertEqual(row["label"], "Leave · Emergency")

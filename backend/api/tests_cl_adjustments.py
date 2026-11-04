"""
Casual Leave Carry Forward (owner brief 2026-11-04, final form): on the HR Casual Leave page HR turns an employee's ABSENT,
ON LEAVE or HALF DAY days into Casual Leave (a full day or a half each) from the yearly balance, which stays a fixed 12 (no
extra days are ever added).

  - GET  /api/casual-leaves/absent-dates: detection - the month's absent and on-leave days that hold no Casual Leave yet,
    with the leave's name, and the whole month as a calendar (status of every day, which ones can be picked)
  - POST /api/casual-leaves/assign: HR enters the most days and picks that many dates or fewer; only the picked dates
    become approved, paid Casual Leave, the balance goes down by them (even for dates before the 2 Nov cut-over);
    all or nothing, this year up to today, staff with 6 months, within the branch, a reason always
  - GET  /api/casual-leaves/adjustments: the log of those rounds; there is no way to add days any more
  - the Casual Leave module gates it: a view-only login reads but never changes, an employee never reaches it

Run via: DATABASE_URL= DB_TEST_NAME=uktex_test_cladjust python manage.py test api.tests_cl_adjustments
"""

from datetime import date
from decimal import Decimal
from unittest import mock

from .models import (
    AttendanceDayRecord,
    AuditLog,
    Branch,
    CasualLeaveAdjustment,
    CasualLeaveRequest,
    Employee,
    HRUser,
    LeaveRequest,
    Role,
)
from .tests_approval_workflow import _bearer
from .tests_attendance_edit_round import TODAY, RoundBase

LOG = "/api/casual-leaves/adjustments"
ASSIGN = "/api/casual-leaves/assign"
ABSENT = "/api/casual-leaves/absent-dates"


def _hr(user: HRUser) -> dict:
    return _bearer({"role": "hr", "hrUserId": user.id, "name": user.full_name})


def _day(emp, d, status):
    return AttendanceDayRecord.objects.create(
        employee=emp, date=d, status=status, shifts_earned=Decimal("1") if status == "present" else 0
    )


class CarryBase(RoundBase):
    """20 Nov 2026, the balance counted from 2 Nov. Asha (W1) was absent on 6, 7, 9 and 13 October and 17 November, on
    (sick) leave on 14 October, present on 8 October; Bala (W2) absent on 6 October."""

    def setUp(self):
        super().setUp()
        pin = mock.patch("api.cl_adjustment_views.ist_today", return_value=TODAY)
        pin.start()
        self.addCleanup(pin.stop)
        self.bala = Employee.objects.create(
            employee_code="W2",
            first_name="Bala",
            last_name="Murugan",
            status="active",
            employment_type="staff",
            join_date="2021-03-01",
        )
        for d in (date(2026, 10, 6), date(2026, 10, 7), date(2026, 10, 9), date(2026, 10, 13), date(2026, 11, 17)):
            _day(self.emp, d, "absent")
        _day(self.emp, date(2026, 10, 8), "present")
        _day(self.emp, date(2026, 10, 11), "holiday")
        _day(self.emp, date(2026, 10, 14), "on_leave")
        LeaveRequest.objects.create(
            employee=self.emp,
            start_date="2026-10-14",
            end_date="2026-10-14",
            status="approved",
            reason="fever",
            reason_category="sick",
        )
        _day(self.bala, date(2026, 10, 6), "absent")

    def assign(self, items, reason="Absent days covered by carried-forward CL", who=None):
        return self.send("post", ASSIGN, {"reason": reason, "items": items}, who)

    def detect(self, *employees, month=10, who=None):
        ids = ",".join(str(e.id) for e in employees)
        r = self.send("get", f"{ABSENT}?employeeIds={ids}&month={month}&year=2026", who=who)
        self.assertEqual(r.status_code, 200, r.content)
        return r.json()

    def picks(self, *employees, month=10):
        body = self.detect(*employees, month=month)
        return {e["employeeId"]: [d["date"] for d in e["dates"]] for e in body["employees"]}

    def balance(self, emp=None):
        r = self.send("get", f"/api/casual-leaves/history?employeeId={(emp or self.emp).id}&year=2026")
        self.assertEqual(r.status_code, 200, r.content)
        return r.json()["balance"]


class DetectTests(CarryBase):
    def test_finds_the_absent_and_the_on_leave_days(self):
        body = self.detect(self.emp)
        asha = body["employees"][0]
        self.assertEqual([d["date"] for d in asha["absent"]], ["2026-10-06", "2026-10-07", "2026-10-09", "2026-10-13"])
        leave = asha["onLeave"]
        self.assertEqual(
            [(d["date"], d["status"], d["label"], d["portions"], d["suggested"]) for d in leave],
            [("2026-10-14", "on_leave", "On Leave · Sick Leave", ["full", "first_half", "second_half"], "full")],
        )
        self.assertEqual(leave[0]["halves"], {"first": "09:00-13:00", "second": "14:00-18:00"})
        self.assertEqual(
            [d["date"] for d in asha["dates"]],
            ["2026-10-06", "2026-10-07", "2026-10-09", "2026-10-13", "2026-10-14"],
        )
        self.assertEqual(
            (body["monthLabel"], body["assignable"], body["monthEnd"]), ("October 2026", True, "2026-10-31")
        )
        self.assertEqual(asha["balance"]["total"], 12)

    def test_the_month_as_a_calendar(self):
        cal = {c["date"]: c for c in self.detect(self.emp)["employees"][0]["calendar"]}
        self.assertEqual(len(cal), 31)
        self.assertEqual((cal["2026-10-06"]["status"], cal["2026-10-06"]["selectable"]), ("absent", True))
        self.assertEqual((cal["2026-10-14"]["status"], cal["2026-10-14"]["selectable"]), ("on_leave", True))
        self.assertEqual((cal["2026-10-08"]["status"], cal["2026-10-08"]["selectable"]), ("present", False))
        self.assertEqual(cal["2026-10-11"]["label"], "Holiday / week off")
        self.assertEqual(cal["2026-10-20"]["status"], "none")
        november = {c["date"]: c for c in self.detect(self.emp, month=11)["employees"][0]["calendar"]}
        self.assertEqual(november["2026-11-25"]["status"], "future")  # after "today" (20 Nov)
        self.assertTrue(november["2026-11-17"]["selectable"])

    def test_a_day_that_already_has_casual_leave_is_not_offered(self):
        self.cl(date(2026, 10, 9), status="pending")
        self.assertNotIn("2026-10-09", self.picks(self.emp)[self.emp.id])
        cal = {c["date"]: c for c in self.detect(self.emp)["employees"][0]["calendar"]}
        self.assertEqual((cal["2026-10-09"]["status"], cal["2026-10-09"]["selectable"]), ("cl", False))

    def test_several_employees_at_once_within_the_branch(self):
        self.assertEqual(self.picks(self.emp, self.bala)[self.bala.id], ["2026-10-06"])
        north = Branch.objects.create(name="North")
        Employee.objects.filter(pk=self.emp.pk).update(branch=north)
        role = Role.objects.create(name="cladj_north", permissions={"casual_leave": "edit"})
        user = HRUser.objects.create(username="cladj_n", full_name="North", password_hash="x", role=role, branch=north)
        got = self.detect(self.emp, self.bala, who=_hr(user))
        self.assertEqual([e["employeeId"] for e in got["employees"]], [self.emp.id])


class AssignTests(CarryBase):
    def test_only_the_picked_dates_become_casual_leave_and_the_balance_goes_down_by_them(self):
        r = self.assign([{"employeeId": self.emp.id, "limit": 3, "dates": ["2026-10-07", "2026-10-14"]}])
        self.assertEqual(r.status_code, 201, r.content)
        self.assertEqual((r.json()["count"], r.json()["days"]), (1, 2))
        line = r.json()["items"][0]
        self.assertEqual(
            (line["dates"], line["days"], line["balanceBefore"], line["balanceAfter"], line["createdBy"]),
            (["2026-10-07", "2026-10-14"], -2, 12, 10, "Meena"),
        )
        made = CasualLeaveRequest.objects.filter(employee=self.emp).order_by("date")
        self.assertEqual([c.date for c in made], [date(2026, 10, 7), date(2026, 10, 14)])
        self.assertTrue(all(c.status == "approved" and c.portion == "full" for c in made))
        self.assertEqual(made[0].approval_trail[0]["via"], "carry_forward")
        # the picked days (an absent one and a leave one) are paid present days now; the others stay as they were
        days = dict(AttendanceDayRecord.objects.filter(employee=self.emp).values_list("date", "status"))
        self.assertEqual((days[date(2026, 10, 7)], days[date(2026, 10, 14)]), ("present", "present"))
        self.assertEqual((days[date(2026, 10, 6)], days[date(2026, 10, 9)]), ("absent", "absent"))
        rec = AttendanceDayRecord.objects.get(employee=self.emp, date=date(2026, 10, 7))
        self.assertEqual((rec.source, str(rec.shifts_earned)), ("manual", "1.00"))
        # October is before the cut-over, yet these count; the 12 itself never moves
        b = self.balance()
        self.assertEqual((b["total"], b["used"], b["remaining"]), (12, 2, 10))
        self.assertEqual(self.picks(self.emp)[self.emp.id], ["2026-10-06", "2026-10-09", "2026-10-13"])

    def test_the_history_and_the_year_view_tell_them(self):
        self.assign([{"employeeId": self.emp.id, "limit": 1, "dates": ["2026-10-06"]}])
        r = self.send("get", f"/api/casual-leaves/history?employeeId={self.emp.id}&year=2026").json()
        given = [e for e in r["entries"] if e["kind"] == "approved"]
        self.assertEqual(len(given), 1)
        self.assertEqual(given[0]["source"], "hr_assign")
        self.assertRegex(
            given[0]["text"],
            r"^12 → 11 on .*: Casual Leave given by HR for an absent / leave / half day \(Full day, 06 Oct 2026\)$",
        )
        mine = self.as_employee("get", "/api/casual-leaves/my-eligibility").json()
        self.assertEqual((mine["monthsUsage"][9]["used"], mine["monthsUsage"][9]["beforeCutOver"]), (1, 0))
        self.assertEqual((mine["yearlyEntitlement"], mine["remainingThisYear"]), (12, 11))

    def test_november_dates_count_once(self):
        self.assign([{"employeeId": self.emp.id, "limit": 2, "dates": ["2026-11-17"]}])
        b = self.balance()
        self.assertEqual((b["used"], b["remaining"]), (1, 11))

    def test_the_number_is_the_most_that_may_be_picked(self):
        r = self.assign([{"employeeId": self.emp.id, "limit": 1, "dates": ["2026-10-06", "2026-10-07"]}])
        self.assertEqual(r.status_code, 400)
        self.assertEqual(r.json()["problems"][0]["error"], "2 days picked, but the days allow 1 at most.")
        for bad in (0, 32, "x", None, True, 1.25):
            r = self.assign([{"employeeId": self.emp.id, "limit": bad, "dates": ["2026-10-06"]}])
            self.assertEqual(r.status_code, 400, bad)
        r = self.assign([{"employeeId": self.emp.id, "limit": 3, "dates": []}])
        self.assertEqual(r.json()["problems"][0]["error"], "Pick at least one date.")
        self.assertFalse(CasualLeaveRequest.objects.exists())

    def test_only_absent_or_leave_days_without_casual_leave(self):
        r = self.assign([{"employeeId": self.emp.id, "limit": 2, "dates": ["2026-10-06", "2026-10-08"]}])
        self.assertEqual(r.status_code, 400)
        self.assertEqual(
            r.json()["problems"][0]["error"],
            "Not an absent, leave or half day (or it already has Casual Leave): 08 Oct. Pick again.",
        )
        self.assign([{"employeeId": self.emp.id, "limit": 1, "dates": ["2026-10-06"]}])
        again = self.assign([{"employeeId": self.emp.id, "limit": 1, "dates": ["2026-10-06"]}])
        self.assertEqual(again.status_code, 400)
        self.assertEqual(CasualLeaveRequest.objects.count(), 1)

    def test_never_more_dates_than_the_balance_holds(self):
        for n in range(11):
            self.cl(date(2026, 11, 3 + n))
        self.assertEqual(self.balance()["remaining"], 1)
        r = self.assign([{"employeeId": self.emp.id, "limit": 2, "dates": ["2026-10-06", "2026-10-07"]}])
        self.assertEqual(r.status_code, 400)
        self.assertEqual(
            r.json()["problems"][0]["error"], "Only 1 day of Casual Leave left, so 2 days cannot be given."
        )
        ok = self.assign([{"employeeId": self.emp.id, "limit": 2, "dates": ["2026-10-06"]}])
        self.assertEqual(ok.status_code, 201)
        self.assertEqual(self.balance()["remaining"], 0)

    def test_one_refused_employee_saves_nothing_for_anyone(self):
        r = self.assign(
            [
                {"employeeId": self.emp.id, "limit": 1, "dates": ["2026-10-06"]},
                {"employeeId": self.bala.id, "limit": 1, "dates": ["2026-10-07"]},  # Bala was not absent that day
            ]
        )
        self.assertEqual(r.status_code, 400)
        self.assertEqual([p["employeeId"] for p in r.json()["problems"]], [self.bala.id])
        self.assertEqual(r.json()["problems"][0]["employeeName"], "Bala Murugan")
        self.assertFalse(CasualLeaveRequest.objects.exists())
        self.assertEqual(AttendanceDayRecord.objects.get(employee=self.emp, date=date(2026, 10, 6)).status, "absent")
        self.assertFalse(CasualLeaveAdjustment.objects.exists())

    def test_several_employees_each_with_their_own_dates(self):
        r = self.assign(
            [
                {"employeeId": self.emp.id, "limit": 3, "dates": ["2026-10-06", "2026-10-13"]},
                {"employeeId": self.bala.id, "limit": 1, "dates": ["2026-10-06"]},
            ]
        )
        self.assertEqual(r.status_code, 201, r.content)
        self.assertEqual((r.json()["count"], r.json()["days"]), (2, 3))
        self.assertEqual((self.balance()["remaining"], self.balance(self.bala)["remaining"]), (10, 11))

    def test_this_year_up_to_today_staff_with_six_months_only(self):
        r = self.assign([{"employeeId": self.emp.id, "limit": 1, "dates": ["2025-12-30"]}])
        self.assertEqual(r.json()["problems"][0]["error"], "Only dates of 2026 up to today can be given Casual Leave.")
        r = self.assign([{"employeeId": self.emp.id, "limit": 1, "dates": ["2026-11-25"]}])  # after "today" (20 Nov)
        self.assertEqual(r.status_code, 400)
        new = Employee.objects.create(
            employee_code="W5",
            first_name="New",
            last_name="Joiner",
            status="active",
            employment_type="staff",
            join_date="2026-08-01",
        )
        _day(new, date(2026, 10, 6), "absent")
        r = self.assign([{"employeeId": new.id, "limit": 1, "dates": ["2026-10-06"]}])
        self.assertIn("after 6 months of service", r.json()["problems"][0]["error"])
        worker = Employee.objects.create(
            employee_code="P1", first_name="Prod", last_name="Worker", status="active", employment_type="production"
        )
        r = self.assign([{"employeeId": worker.id, "limit": 1, "dates": ["2026-10-06"]}])
        self.assertEqual(r.json()["problems"][0]["error"], "Casual Leave is for staff employees only.")
        self.assertEqual(self.assign([], reason="ok fine").status_code, 400)
        one = [{"employeeId": self.emp.id, "limit": 1, "dates": ["2026-10-06"]}]
        self.assertEqual(self.assign(one, reason="x").status_code, 400)
        self.assertFalse(CasualLeaveRequest.objects.exists())


class FixedTwelveAndLogTests(CarryBase):
    def test_no_days_can_be_added_and_an_old_added_line_counts_for_nothing(self):
        r = self.send("post", LOG, {"reason": "carry forward", "items": [{"employeeId": self.emp.id, "days": 3}]})
        self.assertEqual(r.status_code, 405)
        # a line the first build of the tab wrote ("Add days") is ignored everywhere
        CasualLeaveAdjustment.objects.create(
            employee=self.emp,
            year=2026,
            days=Decimal("3"),
            reason="old",
            balance_before=12,
            balance_after=15,
            kind=CasualLeaveAdjustment.KIND_BALANCE,
        )
        b = self.balance()
        self.assertEqual((b["total"], b["remaining"]), (12, 12))
        self.assertNotIn("adjusted", b)
        self.assertEqual(self.send("get", LOG).json()["total"], 0)
        board = self.send("get", "/api/casual-leaves/eligibility?month=11&year=2026").json()
        self.assertEqual(next(r for r in board["employees"] if r["employeeCode"] == "W1")["balance"]["total"], 12)

    def test_the_log_keeps_each_round_with_its_dates(self):
        self.assign([{"employeeId": self.emp.id, "limit": 3, "dates": ["2026-10-06", "2026-10-09"]}])
        self.assign([{"employeeId": self.bala.id, "limit": 1, "dates": ["2026-10-06"]}], reason="Bala's absent day")
        body = self.send("get", LOG).json()
        self.assertEqual(
            [(i["employeeId"], i["dates"]) for i in body["items"]],
            [(self.bala.id, ["2026-10-06"]), (self.emp.id, ["2026-10-06", "2026-10-09"])],
        )
        self.assertEqual(body["summary"], {"changes": 2, "employees": 2, "days": 3})
        self.assertEqual(self.send("get", f"{LOG}?employeeId={self.emp.id}").json()["total"], 1)
        log = AuditLog.objects.filter(module="casual_leave").order_by("id").first()
        self.assertIn(
            "given 2 days for 06 Oct 2026 (full day), 09 Oct 2026 (full day), 12 → 10 left", log.record_description
        )

    def test_a_view_only_login_or_an_employee_cannot_give_casual_leave(self):
        role = Role.objects.create(name="cladj_viewer", permissions={"casual_leave": "view"})
        viewer = HRUser.objects.create(username="cladj_v", full_name="Viewer", password_hash="x", role=role)
        self.detect(self.emp, who=_hr(viewer))
        self.assertEqual(self.send("get", LOG, who=_hr(viewer)).status_code, 200)
        item = [{"employeeId": self.emp.id, "limit": 1, "dates": ["2026-10-06"]}]
        self.assertEqual(self.assign(item, who=_hr(viewer)).status_code, 403)
        self.assertEqual(self.as_employee("post", ASSIGN, {"reason": "mine", "items": item}).status_code, 403)
        self.assertEqual(self.as_employee("get", f"{ABSENT}?employeeIds={self.emp.id}").status_code, 403)
        self.assertEqual(self.as_employee("get", LOG).status_code, 403)
        other = Role.objects.create(name="cladj_x", permissions={"leave": "edit"})
        nobody = HRUser.objects.create(username="cladj_x", full_name="X", password_hash="x", role=other)
        self.assertEqual(self.send("get", LOG, who=_hr(nobody)).status_code, 403)
        self.assertFalse(CasualLeaveRequest.objects.exists())

    def test_a_branch_login_gives_casual_leave_in_its_own_branch_only(self):
        north, south = Branch.objects.create(name="North"), Branch.objects.create(name="South")
        Employee.objects.filter(pk=self.emp.pk).update(branch=north)
        Employee.objects.filter(pk=self.bala.pk).update(branch=south)
        role = Role.objects.create(name="cladj_branch", permissions={"casual_leave": "edit"})
        user = HRUser.objects.create(
            username="cladj_b", full_name="North HR", password_hash="x", role=role, branch=north
        )
        r = self.assign([{"employeeId": self.bala.id, "limit": 1, "dates": ["2026-10-06"]}], who=_hr(user))
        self.assertEqual(r.json()["problems"][0]["error"], "Employee not found.")
        ok = self.assign([{"employeeId": self.emp.id, "limit": 1, "dates": ["2026-10-06"]}], who=_hr(user))
        self.assertEqual(ok.status_code, 201, ok.content)
        self.assertEqual(ok.json()["items"][0]["createdBy"], "North HR")
        self.assign([{"employeeId": self.bala.id, "limit": 1, "dates": ["2026-10-06"]}])
        mine = self.send("get", LOG, who=_hr(user)).json()["items"]
        self.assertEqual([i["employeeId"] for i in mine], [self.emp.id])


class HalfDayTests(CarryBase):
    """Asha also worked only the morning of 15 October (in 09:00, out 12:30: a Half Day) on the 09:00-18:00 shift (first half
    to 13:00, lunch 60 minutes)."""

    def setUp(self):
        super().setUp()
        from datetime import time

        from .attendance_final import compute_range_records

        self.punch(date(2026, 10, 15), time(9, 0), time(12, 30))
        compute_range_records(self.emp, date(2026, 10, 15), date(2026, 10, 15))
        self.assertEqual(
            AttendanceDayRecord.objects.get(employee=self.emp, date=date(2026, 10, 15)).status, "half_shift"
        )

    def day(self, d):
        return AttendanceDayRecord.objects.get(employee=self.emp, date=d)

    def test_a_half_day_is_detected_with_the_missed_half_suggested(self):
        body = self.detect(self.emp)["employees"][0]
        half = body["halfDay"]
        self.assertEqual(len(half), 1)
        self.assertEqual(
            (half[0]["date"], half[0]["worked"], half[0]["suggested"], half[0]["portions"]),
            ("2026-10-15", "morning", "second_half", ["second_half", "full"]),
        )
        self.assertEqual(half[0]["label"], "Half Day · worked the morning (09:00-12:30)")
        self.assertEqual(half[0]["halves"], {"first": "09:00-13:00", "second": "14:00-18:00"})
        cal = {c["date"]: c for c in body["calendar"]}
        self.assertEqual((cal["2026-10-15"]["status"], cal["2026-10-15"]["selectable"]), ("half_shift", True))
        self.assertIn("2026-10-15", [d["date"] for d in body["dates"]])

    def test_the_missed_half_as_casual_leave_makes_the_day_a_full_paid_day(self):
        r = self.assign(
            [{"employeeId": self.emp.id, "limit": 1, "dates": [{"date": "2026-10-15", "portion": "second_half"}]}]
        )
        self.assertEqual(r.status_code, 201, r.content)
        self.assertEqual((r.json()["days"], r.json()["items"][0]["days"]), (0.5, -0.5))
        self.assertEqual(
            r.json()["items"][0]["parts"],
            [{"date": "2026-10-15", "portion": "second_half", "portionLabel": "Half day (second half)", "days": 0.5}],
        )
        cl = CasualLeaveRequest.objects.get(employee=self.emp, date=date(2026, 10, 15))
        self.assertEqual((cl.status, cl.portion), ("approved", "second_half"))
        rec = self.day(date(2026, 10, 15))
        self.assertEqual((rec.status, str(rec.shifts_earned)), ("present", "1.00"))
        b = self.balance()
        self.assertEqual((b["total"], b["used"], b["remaining"]), (12, 0.5, 11.5))

    def test_the_worked_half_cannot_be_given(self):
        r = self.assign(
            [{"employeeId": self.emp.id, "limit": 1, "dates": [{"date": "2026-10-15", "portion": "first_half"}]}]
        )
        self.assertEqual(r.status_code, 400)
        self.assertEqual(
            r.json()["problems"][0]["error"],
            "15 Oct: the morning was worked, so only the second half (or a full day) can be given.",
        )
        self.assertFalse(CasualLeaveRequest.objects.exists())

    def test_a_full_day_on_a_half_day_is_a_paid_day(self):
        r = self.assign([{"employeeId": self.emp.id, "limit": 1, "dates": [{"date": "2026-10-15", "portion": "full"}]}])
        self.assertEqual(r.status_code, 201, r.content)
        self.assertEqual(self.day(date(2026, 10, 15)).status, "present")
        self.assertEqual(self.balance()["remaining"], 11)

    def test_half_of_an_absent_day_pays_that_half(self):
        r = self.assign(
            [{"employeeId": self.emp.id, "limit": 1, "dates": [{"date": "2026-10-06", "portion": "first_half"}]}]
        )
        self.assertEqual(r.status_code, 201, r.content)
        rec = self.day(date(2026, 10, 6))
        self.assertEqual((rec.status, str(rec.shifts_earned)), ("half_shift", "0.50"))
        self.assertEqual(self.balance()["remaining"], 11.5)

    def test_the_number_counts_half_days_as_half(self):
        mixed = [
            {"date": "2026-10-06", "portion": "full"},
            {"date": "2026-10-15", "portion": "second_half"},
        ]
        r = self.assign([{"employeeId": self.emp.id, "limit": 1, "dates": mixed}])
        self.assertEqual(r.json()["problems"][0]["error"], "1.5 days picked, but the days allow 1 at most.")
        ok = self.assign([{"employeeId": self.emp.id, "limit": 1.5, "dates": mixed}])
        self.assertEqual(ok.status_code, 201, ok.content)
        line = ok.json()["items"][0]
        self.assertEqual((line["days"], line["balanceBefore"], line["balanceAfter"]), (-1.5, 12, 10.5))
        self.assertEqual(self.send("get", LOG).json()["summary"]["days"], 1.5)

    def test_a_day_set_by_hand_takes_a_full_day_only(self):
        AttendanceDayRecord.objects.filter(employee=self.emp, date=date(2026, 10, 9)).update(source="manual")
        day = next(d for d in self.detect(self.emp)["employees"][0]["dates"] if d["date"] == "2026-10-09")
        self.assertEqual((day["portions"], day["manual"], day["halves"]), (["full"], True, None))
        r = self.assign(
            [{"employeeId": self.emp.id, "limit": 1, "dates": [{"date": "2026-10-09", "portion": "first_half"}]}]
        )
        self.assertEqual(
            r.json()["problems"][0]["error"],
            "09 Oct was set by hand on the attendance pages: only a full day of Casual Leave can be given on it.",
        )
        self.assertEqual(
            self.assign(
                [{"employeeId": self.emp.id, "limit": 1, "dates": [{"date": "2026-10-09", "portion": "full"}]}]
            ).status_code,
            201,
        )

    def test_a_bad_portion_or_a_date_twice_is_refused(self):
        r = self.assign(
            [{"employeeId": self.emp.id, "limit": 1, "dates": [{"date": "2026-10-06", "portion": "morning"}]}]
        )
        self.assertEqual(
            r.json()["problems"][0]["error"], "Each date needs a real date and Full day, First half or Second half."
        )
        twice = [{"date": "2026-10-06", "portion": "first_half"}, {"date": "2026-10-06", "portion": "second_half"}]
        r = self.assign([{"employeeId": self.emp.id, "limit": 1, "dates": twice}])
        self.assertEqual(r.json()["problems"][0]["error"], "Each date can be picked once.")
        self.assertFalse(CasualLeaveRequest.objects.exists())

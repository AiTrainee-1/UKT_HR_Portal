"""
HR attendance-edit round (owner brief 2026-11-02):

  A. Casual Leave yearly balance: 12 a calendar year from the cut-over (2026-11-02), half days 0.5, pending holds days, a
     rejected request frees them, unused days lapse on 31 Dec, a fresh 12 on 1 Jan, earlier CL never deducted; any Casual
     Leave while the balance lasts (no more one-per-month after the cut-over); the my-eligibility / board / history /
     policy endpoints.
  B. The new Attendance Edit options (Permission, Late mark / unmark, Casual Leave, On-Duty): the option catalogue, the
     checks when HR proposes one, and what each does once the Department Head and HR have approved it (incl. the payroll
     effect: the permission allowance, the late pool, the Casual Leave balance, an On-Duty present day).
  C. "HR edited this day": the hrEdit block on the HR payroll calendar and on the employee attendance month endpoint, for
     every status.

Run via: DATABASE_URL= DB_TEST_NAME=uktex_test_editround python manage.py test api.tests_attendance_edit_round
"""

from datetime import date, time
from decimal import Decimal
from unittest import mock

from . import approval_workflow as approval
from . import attendance_edit as edit
from . import cl_balance
from .attendance_final import late_pool_summary, permission_cap_status
from .models import (
    AttendanceDayRecord,
    AttendanceLog,
    AttendanceOverrideRequest,
    Branch,
    CasualLeaveRequest,
    Employee,
    EmployeePermission,
    EmployeeShiftAssignment,
    HRUser,
    PayrollSettings,
    Role,
    ShiftTemplate,
)
from .payroll_calendar import calendar_extras
from .tests_approval_workflow import Base, _bearer

TODAY = date(2026, 11, 20)  # a Friday, after the cut-over
CUT_OVER = date(2026, 11, 2)
PINNED = (
    "api.clock.ist_today",
    "api.growth_views.ist_today",
    "api.attendance_final.ist_today",
    "api.attendance_views.ist_today",
    "api.attendance_edit_views.ist_today",
    "api.casual_leave_views.ist_today",
    "api.request_window.ist_today",
    "api.payroll_calendar.ist_today",
)


def _stored(day: date, status="absent", shifts=0.0) -> dict:
    """A day as a payroll's stored breakdown lists it."""
    return {
        "date": day.isoformat(),
        "day": day.strftime("%A"),
        "status": status,
        "firstIn": None,
        "lastOut": None,
        "shifts": shifts,
        "flags": [],
        "note": None,
        "marks": [],
    }


class RoundBase(Base):
    """W1 (staff, joined 2020) with Department Head Suresh Raj, a 09:00-18:00 shift with 10 minutes' grace, simple mode,
    every clock pinned to 20 Nov 2026."""

    def setUp(self):
        super().setUp()
        for target in PINNED:
            pin = mock.patch(target, return_value=TODAY)
            pin.start()
            self.addCleanup(pin.stop)
        ps = PayrollSettings.get()
        ps.attendance_mode = "simple"
        ps.save()
        self.shift = ShiftTemplate.objects.create(
            name="Round Day Shift",
            shift_type="staff",
            start_time=time(9, 0),
            end_time=time(18, 0),
            grace_period_minutes=10,
            first_half_end=time(13, 0),
            lunch_duration_minutes=60,
        )
        EmployeeShiftAssignment.objects.create(employee=self.emp, shift=self.shift, effective_from=date(2020, 1, 1))

    # ── helpers ──
    def punch(self, d, *times, emp=None):
        for t in times:
            AttendanceLog.objects.create(employee=emp or self.emp, date=d, punch_time=t, punch_type="IN", source="test")

    def cl(self, d, portion="full", status="approved", emp=None):
        return CasualLeaveRequest.objects.create(
            employee=emp or self.emp, date=d, portion=portion, status=status, approval_trail=[]
        )

    def post_cl(self, d, portion=None):
        body = {"date": str(d), "reason": "family function"}
        if portion:
            body["portion"] = portion
        return self.as_employee("post", "/api/casual-leaves", body)

    def propose(self, d, kind, emp=None, **extra):
        body = {
            "employeeId": (emp or self.emp).id,
            "date": str(d),
            "type": kind,
            "note": "checked with the HOD",
            **extra,
        }
        return self.send("post", "/api/attendance/override", body)

    def hod_says(self, pk, status="approved", comment=None):
        return self.as_hod(
            "patch", f"/api/manager/attendance-requests/{pk}/status", {"status": status, "comment": comment}
        )

    def hr_says(self, pk, status="approved", comment=None):
        return self.send("patch", f"/api/attendance/override-requests/{pk}", {"status": status, "comment": comment})

    def approve_both(self, d, kind, **extra):
        r = self.propose(d, kind, **extra)
        self.assertEqual(r.status_code, 202, r.content)
        pk = r.json()["request"]["id"]
        self.assertEqual(self.hod_says(pk).status_code, 200)
        done = self.hr_says(pk)
        self.assertEqual(done.status_code, 200, done.content)
        return pk

    def record(self, d, emp=None):
        return AttendanceDayRecord.objects.get(employee=emp or self.emp, date=d)

    def balance(self, year=2026, emp=None):
        return cl_balance.balance(emp or self.emp, year)

    def fill_balance(self, days: int, start=date(2026, 12, 1)):
        """`days` approved full-day Casual Leaves in December (direct rows, the balance only counts them)."""
        for i in range(days):
            self.cl(date(start.year, start.month, start.day + i))


# ═════════════════════════════ A. the yearly balance ═════════════════════════════


class BalanceMathsTests(RoundBase):
    def test_everyone_starts_fresh_at_12_from_the_cut_over(self):
        self.cl(date(2026, 3, 5))  # earlier 2026 Casual Leave: never deducted
        self.cl(date(2026, 10, 30), "first_half", "pending")
        self.cl(date(2026, 11, 1))  # the day before the cut-over
        b = self.balance()
        self.assertEqual(
            (b["total"], b["used"], b["pending"], b["remaining"], b["since"], b["cutOver"], b["tracked"]),
            (12, 0, 0, 12, "2026-11-02", "2026-11-02", True),
        )

    def test_half_days_count_half_pending_holds_days_and_rejected_frees_them(self):
        self.cl(date(2026, 11, 3))
        self.cl(date(2026, 11, 4), "first_half")
        self.cl(date(2026, 11, 5), "second_half", "pending")
        self.cl(date(2026, 11, 6), "full", "rejected")
        b = self.balance()
        self.assertEqual((b["used"], b["pending"], b["remaining"]), (1.5, 0.5, 10))
        CasualLeaveRequest.objects.filter(date=date(2026, 11, 5)).update(status="rejected")
        self.assertEqual(self.balance()["remaining"], 10.5)

    def test_a_new_year_starts_a_fresh_12_and_the_old_one_lapses(self):
        self.cl(date(2026, 12, 28))
        self.cl(date(2027, 1, 4), "first_half")
        self.assertEqual(self.balance(2026)["remaining"], 11)
        b27 = self.balance(2027)
        self.assertEqual((b27["used"], b27["remaining"], b27["since"]), (0.5, 11.5, "2027-01-01"))
        story = cl_balance.history(self.emp, 2026, today=date(2027, 1, 10))
        self.assertEqual(story["entries"][-1]["kind"], "lapsed")
        self.assertEqual(story["entries"][-1]["text"].split(":")[0], "11 → 0 on 31 Dec")

    def test_a_year_wholly_before_the_cut_over_keeps_no_balance(self):
        self.cl(date(2025, 6, 2))
        b = self.balance(2025)
        self.assertEqual((b["tracked"], b["since"], b["used"], b["remaining"]), (False, None, 0, 12))

    def test_the_cut_over_is_a_setting(self):
        self.cl(date(2026, 10, 15))
        self.assertEqual(self.balance()["used"], 0)
        r = self.send("put", "/api/casual-leaves/policy", {"balanceSince": "2026-10-01"})
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(r.json()["balanceSince"], "2026-10-01")
        self.assertEqual(self.balance()["used"], 1)
        self.assertEqual(self.send("get", "/api/casual-leaves/policy").json()["yearlyEntitlement"], 12)
        self.assertEqual(self.send("put", "/api/casual-leaves/policy", {"balanceSince": "soon"}).status_code, 400)

    def test_a_branch_login_cannot_move_the_cut_over(self):
        branch = Branch.objects.create(name="North", code="NO")
        role = Role.objects.create(name="cl-editor", permissions={"casual_leave": "edit"})
        user = HRUser.objects.create(username="branch_cl", password_hash="x", role=role, branch=branch)
        who = _bearer({"role": "hr", "hrUserId": user.id, "name": "Branch HR"})
        r = self.send("put", "/api/casual-leaves/policy", {"balanceSince": "2026-01-01"}, who)
        self.assertEqual(r.status_code, 403)
        self.assertEqual(cl_balance.since(), CUT_OVER)


class YearlyRuleTests(RoundBase):
    def test_several_casual_leaves_in_one_month_while_the_balance_lasts(self):
        self.assertEqual(self.post_cl(date(2026, 11, 5)).status_code, 201)
        self.assertEqual(self.post_cl(date(2026, 11, 6)).status_code, 201)  # one-per-month would refuse this
        self.assertEqual(self.post_cl(date(2026, 11, 9), "first_half").status_code, 201)
        self.assertEqual(self.post_cl(date(2026, 11, 9), "second_half").status_code, 201)  # the other half of a date
        self.assertEqual(self.balance()["pending"], 3)
        self.assertEqual(self.balance()["remaining"], 9)

    def test_one_date_never_holds_the_same_half_twice_or_a_full_day_over_a_half(self):
        self.assertEqual(self.post_cl(date(2026, 11, 9), "first_half").status_code, 201)
        again = self.post_cl(date(2026, 11, 9), "first_half")
        self.assertEqual(again.status_code, 400)
        self.assertIn("first half of 09 Nov 2026 is already asked for", again.json()["error"])
        full = self.post_cl(date(2026, 11, 9), "full")
        self.assertEqual(full.status_code, 400)
        self.assertIn("a full day cannot be added", full.json()["error"])
        self.assertEqual(self.post_cl(date(2026, 11, 10)).status_code, 201)
        self.assertIn("already a full day", self.post_cl(date(2026, 11, 10), "second_half").json()["error"])

    def test_refused_at_zero_and_only_a_half_when_half_is_left(self):
        self.fill_balance(11)
        self.cl(date(2026, 12, 20), "first_half")
        full = self.post_cl(date(2026, 11, 23))
        self.assertEqual(full.status_code, 400)
        self.assertEqual(
            full.json()["error"], "Only half a day of Casual Leave is left for 2026. Choose First half or Second half."
        )
        self.assertEqual(self.post_cl(date(2026, 11, 23), "second_half").status_code, 201)
        none_left = self.post_cl(date(2026, 11, 24), "first_half")
        self.assertEqual(none_left.status_code, 400)
        self.assertEqual(
            none_left.json()["error"], "No Casual Leave left for 2026: all 12 days are used or waiting for approval"
        )

    def test_a_rejected_request_gives_its_days_back(self):
        self.fill_balance(12)
        self.assertEqual(self.post_cl(date(2026, 11, 23)).status_code, 400)
        CasualLeaveRequest.objects.filter(date=date(2026, 12, 1)).update(status="rejected")
        self.assertEqual(self.post_cl(date(2026, 11, 23)).status_code, 201)

    def test_the_staff_and_service_rules_still_apply(self):
        Employee.objects.filter(pk=self.emp.pk).update(join_date="2026-09-01")
        r = self.post_cl(date(2026, 11, 23))
        self.assertEqual(r.status_code, 400)
        self.assertIn("Eligible after 6 months", r.json()["error"])


class EligibilityEndpointTests(RoundBase):
    def mine(self, query=""):
        r = self.as_employee("get", "/api/casual-leaves/my-eligibility" + query)
        self.assertEqual(r.status_code, 200, r.content)
        return r.json()

    def test_my_eligibility_carries_the_balance_the_months_and_keeps_old_keys(self):
        self.cl(date(2026, 11, 3))
        self.cl(date(2026, 11, 4), "first_half", "pending")
        self.cl(date(2026, 3, 10))  # before the cut-over
        body = self.mine()
        for key in ("eligible", "reason", "year", "yearlyEntitlement", "usedThisYear", "remainingThisYear", "months"):
            self.assertIn(key, body)
        self.assertEqual((body["usedThisYear"], body["waitingThisYear"], body["remainingThisYear"]), (1, 0.5, 10.5))
        self.assertEqual(body["balance"]["remaining"], 10.5)
        self.assertEqual(body["rule"], "yearly_balance")
        november = next(m for m in body["monthsUsage"] if m["month"] == "2026-11")
        self.assertEqual((november["used"], november["pending"], november["rule"]), (1, 0.5, "yearly_balance"))
        march = next(m for m in body["monthsUsage"] if m["month"] == "2026-03")
        self.assertEqual((march["used"], march["beforeCutOver"], march["rule"]), (0, 1, "one_per_month"))
        self.assertEqual(len(body["monthsUsage"]), 12)
        month = next(m for m in body["months"] if m["month"] == "2026-11")
        # `left` now reflects the yearly balance: a full day is still free although this month already has Casual Leave
        self.assertEqual(
            (month["eligible"], month["left"], month["rule"], month["remaining"]),
            (True, "full", "yearly_balance", 10.5),
        )
        self.assertEqual(month["usedFullDates"], ["2026-11-03"])
        self.assertEqual(month["usedHalves"], [{"date": "2026-11-04", "portion": "first_half"}])

    def test_left_is_one_half_then_nothing_as_the_balance_runs_out(self):
        self.fill_balance(11)
        self.cl(date(2026, 12, 20), "second_half")
        self.assertEqual(next(m for m in self.mine()["months"] if m["month"] == "2026-11")["left"], "one_half")
        self.cl(date(2026, 12, 21), "first_half", "pending")
        body = self.mine()
        self.assertFalse(body["eligible"])
        self.assertEqual(next(m for m in body["months"] if m["month"] == "2026-11")["left"], "nothing")

    def test_the_hr_board_shows_each_employees_balance(self):
        self.cl(date(2026, 11, 3))
        body = self.send("get", "/api/casual-leaves/eligibility?month=11&year=2026").json()
        row = next(r for r in body["employees"] if r["employeeId"] == self.emp.id)
        self.assertEqual((row["balance"]["used"], row["balance"]["remaining"]), (1, 11))
        self.assertTrue(row["eligible"])  # a CL this month no longer blocks another
        self.assertEqual((row["left"], body["rule"], body["cutOver"]), ("full", "yearly_balance", "2026-11-02"))
        self.fill_balance(11)
        row = next(
            r for r in self.send("get", "/api/casual-leaves/eligibility?month=11&year=2026").json()["employees"]
            if r["employeeId"] == self.emp.id
        )  # fmt: skip
        self.assertEqual((row["eligible"], row["reasonCode"], row["left"]), (False, "no_balance", "nothing"))

    def test_an_older_month_on_the_board_keeps_the_one_per_month_rule(self):
        self.cl(date(2026, 10, 5))
        body = self.send("get", "/api/casual-leaves/eligibility?month=10&year=2026").json()
        row = next(r for r in body["employees"] if r["employeeId"] == self.emp.id)
        self.assertEqual((row["reasonCode"], body["rule"]), ("used_this_month", "one_per_month"))


class HistoryTests(RoundBase):
    def test_the_history_tells_the_balance_as_a_running_story(self):
        approved = self.cl(date(2026, 11, 5))
        rejected = self.cl(date(2026, 11, 9), "first_half", "rejected")
        waiting = self.cl(date(2026, 11, 12), "second_half", "pending")
        r = self.as_employee("get", "/api/casual-leaves/history?year=2026")
        self.assertEqual(r.status_code, 200, r.content)
        body = r.json()
        kinds = [(e["kind"], e["balanceAfter"], e["requestId"]) for e in body["entries"]]
        self.assertEqual(
            kinds,
            [
                ("opening", 12, None),
                ("approved", 11, approved.id),
                ("rejected", 11, rejected.id),
                ("pending", 10.5, waiting.id),
            ],
        )
        self.assertTrue(body["entries"][1]["text"].startswith("12 → 11 on "))
        self.assertIn("Casual Leave approved (Full day, 05 Nov 2026)", body["entries"][1]["text"])
        self.assertEqual(body["balance"]["remaining"], 10.5)
        self.assertEqual(body["entries"][-1]["balanceAfter"], body["balance"]["remaining"])

    def test_hr_reads_an_employees_history_and_an_employee_only_their_own(self):
        self.assertEqual(self.send("get", "/api/casual-leaves/history").status_code, 400)  # HR must name the employee
        r = self.send("get", f"/api/casual-leaves/history?employeeId={self.emp.id}&year=2026")
        self.assertEqual((r.status_code, r.json()["employeeId"]), (200, self.emp.id))
        mine = self.as_employee("get", f"/api/casual-leaves/history?employeeId={self.boss.id}").json()
        self.assertEqual(mine["employeeId"], self.emp.id)  # an employee token always reads its own


# ═════════════════════════════ B. the new edit options ═════════════════════════════


class CatalogueTests(RoundBase):
    def test_the_dialog_gets_every_group_with_its_items_and_sub_choices(self):
        groups = edit.option_catalogue()
        self.assertEqual(
            [g["key"] for g in groups],
            ["worked", "compensation", "not_worked", "permission", "late", "casual_leave", "on_duty"],
        )
        by = {g["key"]: g for g in groups}
        self.assertEqual(
            [i["key"] for i in by["worked"]["items"]],
            ["present", "half_day", "full_day", "quarter_shift", "three_quarter_shift"],
        )
        self.assertEqual(
            [i["key"] for i in by["compensation"]["items"]], ["compensation", "sunday_compensation", "ot_compensation"]
        )
        self.assertEqual([i["key"] for i in by["not_worked"]["items"]], ["absent", "on_leave", "holiday"])
        permission = by["permission"]["items"][0]
        self.assertEqual(
            [c["value"] for c in permission["choices"]], ["morning_late_in", "evening_early_out", "middle_permission"]
        )
        self.assertEqual({c["durationMinutes"] for c in permission["choices"]}, {60})
        self.assertEqual([c["value"] for c in by["late"]["items"][0]["choices"]], ["mark", "unmark"])
        cl = by["casual_leave"]["items"][0]
        self.assertEqual(
            [(c["value"], c["days"], c["shifts"]) for c in cl["choices"]],
            [("full", 1, "1.00"), ("first_half", 0.5, "0.50"), ("second_half", 0.5, "0.50")],
        )
        self.assertEqual(by["on_duty"]["items"][0]["shifts"], "1.00")
        self.assertTrue(all(i["available"] for g in groups for i in g["items"]))
        # the old flat list is unchanged for older pages
        self.assertEqual(len(edit.catalogue()), 11)

    def test_the_context_says_what_can_be_chosen_for_the_day(self):
        d = date(2026, 11, 3)
        self.punch(d, time(9, 30), time(18, 5))  # a late arrival
        body = self.send("get", f"/api/attendance/edit-context?employeeId={self.emp.id}&date={d}").json()
        by = {g["key"]: g["items"][0] for g in body["options"]}
        late = {c["value"]: c for c in by["late"]["choices"]}
        self.assertFalse(late["mark"]["available"])
        self.assertIn("already marked Late", late["mark"]["unavailableReason"])
        self.assertTrue(late["unmark"]["available"])
        self.assertTrue(by["permission"]["available"])
        self.assertEqual(body["clBalance"]["remaining"], 12)
        self.assertIsNone(body["hrEdit"])

    def test_production_has_no_permission_and_no_casual_leave(self):
        worker = Employee.objects.create(
            employee_code="P1", first_name="Ravi", last_name="M", status="active", employment_type="production",
            join_date="2020-01-01",
        )  # fmt: skip
        groups = {g["key"]: g["items"][0] for g in edit.option_catalogue(worker, date(2026, 11, 3), None)}
        self.assertFalse(groups["permission"]["available"])
        self.assertFalse(groups["casual_leave"]["available"])
        self.assertTrue(groups["on_duty"]["available"])


class PermissionOptionTests(RoundBase):
    D = date(2026, 11, 3)

    def test_an_approved_permission_edit_is_an_approved_permission(self):
        self.punch(self.D, time(9, 30), time(18, 5))
        self.assertTrue(edit.fresh_day(self.emp, self.D).is_late)
        r = self.propose(self.D, "permission", choice="morning_late_in")
        self.assertEqual(r.status_code, 202, r.content)
        pk = r.json()["request"]["id"]
        self.assertEqual(EmployeePermission.objects.count(), 0)  # nothing until both have approved
        self.hod_says(pk)
        self.assertEqual(EmployeePermission.objects.count(), 0)
        self.assertEqual(self.hr_says(pk).status_code, 200)
        perm = EmployeePermission.objects.get(employee=self.emp, date=self.D)
        self.assertEqual(
            (perm.type, perm.status, perm.duration_minutes, perm.approved_by),
            ("morning_late_in", "approved", 60, "Meena"),
        )
        self.assertEqual([e["role"] for e in perm.approval_trail], ["hod", "hr"])
        self.assertEqual(AttendanceOverrideRequest.objects.get(pk=pk).requested_values["permissionId"], perm.id)
        # it uses the monthly allowance and excuses the arrival exactly like any approved permission
        self.assertEqual(permission_cap_status(perm, PayrollSettings.get().permission_monthly_cap), "within_cap")
        rec = self.record(self.D)
        self.assertEqual(
            (rec.source, rec.is_late, rec.morning_permission_applied, rec.arrival_zone),
            ("auto", False, True, "excused"),
        )

    def test_beyond_the_monthly_allowance_it_follows_the_same_deduction_rules(self):
        ps = PayrollSettings.get()
        ps.permission_monthly_cap = 1
        ps.save()
        EmployeePermission.objects.create(
            employee=self.emp, date=date(2026, 11, 2), type="evening_early_out", status="approved", approval_trail=[]
        )
        self.punch(self.D, time(9, 30), time(18, 5))
        self.approve_both(self.D, "permission", choice="morning_late_in")
        rec = self.record(self.D)
        self.assertEqual((rec.is_late, rec.morning_permission_excess), (True, True))
        pool = late_pool_summary([rec], 2, PayrollSettings.get())
        self.assertEqual(
            (pool["late_in"], pool["excess_permissions"], pool["total"]), (0, 1, 1)
        )  # one incident, not two

    def test_the_employees_own_waiting_request_of_that_type_is_the_one_approved(self):
        mine = EmployeePermission.objects.create(
            employee=self.emp, date=self.D, type="Late In", status="pending", approval_trail=[]
        )
        r = self.propose(self.D, "permission", choice="morning_late_in")
        self.assertEqual(r.status_code, 400)  # HR is told to decide that request instead
        self.assertIn("waiting for approval", r.json()["error"])
        mine.delete()
        pk = self.propose(self.D, "permission", choice="morning_late_in").json()["request"]["id"]
        again = EmployeePermission.objects.create(
            employee=self.emp, date=self.D, type="morning_late_in", status="pending", approval_trail=[]
        )  # asked for while the edit waited
        self.hod_says(pk)
        self.hr_says(pk)
        self.assertEqual(EmployeePermission.objects.filter(employee=self.emp, date=self.D).count(), 1)
        again.refresh_from_db()
        self.assertEqual(again.status, "approved")

    def test_the_checks_when_hr_proposes_it(self):
        self.assertEqual(self.propose(self.D, "permission").status_code, 400)  # no type
        self.assertEqual(self.propose(self.D, "permission", choice="nap").status_code, 400)
        EmployeePermission.objects.create(
            employee=self.emp, date=self.D, type="evening_early_out", status="approved", approval_trail=[]
        )
        r = self.propose(self.D, "permission", permissionType="Early Out")  # an alias of the field and of the type
        self.assertEqual(r.status_code, 400)
        self.assertIn("already has an approved Evening Early-Out permission", r.json()["error"])
        self.assertEqual(self.propose(self.D, "permission", choice="middle_permission").status_code, 202)

    def test_a_rejected_permission_edit_creates_nothing(self):
        pk = self.propose(self.D, "permission", choice="middle_permission").json()["request"]["id"]
        self.hod_says(pk, "rejected", "not needed")
        self.assertFalse(EmployeePermission.objects.exists())


class LateOptionTests(RoundBase):
    D = date(2026, 11, 4)

    def test_mark_as_late_counts_in_the_late_pool(self):
        self.punch(self.D, time(8, 55), time(18, 5))
        self.assertFalse(edit.fresh_day(self.emp, self.D).is_late)
        pk = self.approve_both(self.D, "late", choice="mark")
        rec = self.record(self.D)
        self.assertEqual(
            (rec.source, rec.is_late, rec.status, f"{rec.shifts_earned:.2f}"), ("manual", True, "present", "1.00")
        )
        self.assertIn("Marked Late by HR", rec.late_reason)
        self.assertEqual(late_pool_summary([rec], 0, PayrollSettings.get())["late_in"], 1)
        self.assertEqual(AttendanceOverrideRequest.objects.get(pk=pk).requested_values["typeLabel"], "Mark as Late")

    def test_unmark_late_stops_it_counting(self):
        self.punch(self.D, time(9, 30), time(18, 5))
        self.assertTrue(edit.fresh_day(self.emp, self.D).is_late)
        self.approve_both(self.D, "late", choice="unmark")
        rec = self.record(self.D)
        self.assertEqual((rec.source, rec.is_late), ("manual", False))
        self.assertNotIn("Morning Late-In", rec.late_reason or "")
        self.assertEqual(late_pool_summary([rec], 0, PayrollSettings.get())["late_in"], 0)

    def test_nothing_to_mark_or_unmark_is_refused(self):
        absent = self.propose(self.D, "late", choice="mark")  # no punches: an absent day
        self.assertEqual(absent.status_code, 400)
        self.assertIn("not a worked day (Absent)", absent.json()["error"])
        self.punch(self.D, time(8, 55), time(18, 5))
        self.assertIn("not marked Late", self.propose(self.D, "late", choice="unmark").json()["error"])
        self.assertEqual(self.propose(self.D, "late", choice="later").status_code, 400)


class CasualLeaveOptionTests(RoundBase):
    D = date(2026, 11, 5)

    def test_an_approved_casual_leave_edit_is_an_approved_casual_leave_that_uses_the_balance(self):
        r = self.propose(self.D, "casual_leave", choice="full")
        self.assertEqual(r.status_code, 202, r.content)
        pk = r.json()["request"]["id"]
        # while it waits it holds a day of the balance (as pending), and nothing is written yet
        self.assertEqual((self.balance()["pending"], self.balance()["remaining"]), (1, 11))
        self.assertFalse(CasualLeaveRequest.objects.exists())
        self.hod_says(pk)
        self.hr_says(pk)
        cl = CasualLeaveRequest.objects.get(employee=self.emp, date=self.D)
        self.assertEqual((cl.status, cl.portion, cl.reviewed_by, cl.reviewer_role), ("approved", "full", "Meena", "hr"))
        self.assertEqual((self.balance()["used"], self.balance()["pending"], self.balance()["remaining"]), (1, 0, 11))
        rec = self.record(self.D)
        self.assertEqual((rec.status, f"{rec.shifts_earned:.2f}", rec.source), ("present", "1.00", "manual"))
        self.assertTrue(rec.override_note.startswith("Casual Leave"))
        listed = self.send("get", f"/api/casual-leaves?employeeId={self.emp.id}").json()[0]
        self.assertEqual((listed["source"], listed["hrEditRequestId"]), ("hr_edit", pk))
        story = cl_balance.history(self.emp, 2026, today=TODAY)
        self.assertIn("given by HR (attendance edit), approved", story["entries"][-1]["text"])

    def test_a_half_day_casual_leave_edit_pays_the_half_and_counts_the_other_by_punches(self):
        self.punch(self.D, time(8, 55), time(13, 5))  # the morning only
        self.approve_both(self.D, "casual_leave", choice="second_half")
        cl = CasualLeaveRequest.objects.get(employee=self.emp, date=self.D)
        self.assertEqual(cl.portion, "second_half")
        rec = self.record(self.D)
        self.assertEqual((rec.status, f"{rec.shifts_earned:.2f}", rec.source), ("present", "1.00", "auto"))
        self.assertEqual(self.balance()["used"], 0.5)

    def test_refused_when_the_balance_counting_what_waits_is_not_enough(self):
        self.fill_balance(11)
        self.cl(date(2026, 12, 20), "first_half", "pending")
        r = self.propose(self.D, "casual_leave", choice="full")
        self.assertEqual(r.status_code, 400)
        self.assertIn("Only half a day", r.json()["error"])
        self.assertEqual(self.propose(self.D, "casual_leave", choice="first_half").status_code, 202)
        # the waiting edit now holds the last half day: the employee cannot use it as well
        self.assertIn("No Casual Leave left", self.post_cl(date(2026, 11, 23), "first_half").json()["error"])

    def test_a_rejected_edit_frees_the_days_it_held(self):
        self.fill_balance(11)
        pk = self.propose(self.D, "casual_leave", choice="full").json()["request"]["id"]
        self.assertEqual(self.post_cl(date(2026, 11, 23)).status_code, 400)
        self.hod_says(pk, "rejected")
        self.assertEqual(self.post_cl(date(2026, 11, 23)).status_code, 201)
        self.assertFalse(CasualLeaveRequest.objects.filter(date=self.D).exists())

    def test_a_newer_proposal_for_the_same_day_replaces_the_waiting_one(self):
        self.fill_balance(11)
        first = self.propose(self.D, "casual_leave", choice="full")
        self.assertEqual(first.status_code, 202)
        second = self.propose(self.D, "casual_leave", choice="first_half")  # the full day it replaces must not count
        self.assertEqual(second.status_code, 202, second.content)
        self.assertEqual(AttendanceOverrideRequest.objects.get(pk=first.json()["request"]["id"]).status, "rejected")

    def test_staff_only_and_no_same_half_twice(self):
        worker = Employee.objects.create(
            employee_code="P2", first_name="Mani", last_name="K", status="active", employment_type="production",
            join_date="2020-01-01",
        )  # fmt: skip
        from .models import ManagerEmployeeAssignment

        ManagerEmployeeAssignment.objects.create(manager=self.manager, employee=worker)
        self.assertEqual(self.propose(self.D, "casual_leave", emp=worker, choice="full").status_code, 400)
        self.cl(self.D, "first_half", "pending")
        r = self.propose(self.D, "casual_leave", choice="first_half")
        self.assertEqual(r.status_code, 400)
        self.assertIn("first half of 05 Nov 2026", r.json()["error"])
        self.assertEqual(self.propose(self.D, "casual_leave").status_code, 400)  # no portion chosen


class OnDutyOptionTests(RoundBase):
    D = date(2026, 11, 6)

    def test_an_approved_on_duty_edit_is_a_present_on_duty_day(self):
        self.assertEqual(edit.fresh_day(self.emp, self.D).status, "absent")
        pk = self.approve_both(self.D, "on_duty", destination="Buyer visit, Tiruppur")
        rec = self.record(self.D)
        self.assertEqual(
            (rec.status, f"{rec.shifts_earned:.2f}", rec.source, rec.primary_source, rec.is_late, rec.early_leave),
            ("present", "1.00", "manual", "On-Duty", False, False),
        )
        days, _off, _sync = calendar_extras(self.emp, date(2026, 11, 1), date(2026, 11, 30), [_stored(self.D)])
        self.assertEqual(days[0]["onDuty"]["state"], "verified")
        self.assertEqual(days[0]["onDuty"]["destination"], "Buyer visit, Tiruppur")
        self.assertIn("on_duty", days[0]["marks"])
        self.assertEqual((days[0]["hrEdit"]["option"], days[0]["hrEdit"]["requestId"]), ("on_duty", pk))

    def test_a_late_day_made_on_duty_is_no_longer_late(self):
        self.punch(self.D, time(9, 30), time(17, 0))
        self.approve_both(self.D, "on_duty")
        self.assertEqual(late_pool_summary([self.record(self.D)], 0, PayrollSettings.get())["total"], 0)


class OldTypesStillWorkTests(RoundBase):
    def test_a_worked_type_carries_its_group_and_applies_as_before(self):
        d = date(2026, 11, 9)
        pk = self.approve_both(d, "half_day")
        req = AttendanceOverrideRequest.objects.get(pk=pk)
        self.assertEqual(req.requested_values["option"], "worked")
        self.assertEqual((self.record(d).status, self.record(d).source), ("half_shift", "manual"))


# ═════════════════════════════ C. "HR edited this day" ═════════════════════════════


class HrEditTests(RoundBase):
    START, END = date(2026, 11, 1), date(2026, 11, 30)

    def extras(self, *days):
        listed, off, _sync = calendar_extras(self.emp, self.START, self.END, [_stored(d) for d in days])
        return {d["date"]: d for d in listed}, {o["date"]: o for o in off}

    def employee_month(self):
        r = self.as_employee("get", f"/api/attendance/employee/{self.emp.id}?month=11&year=2026")
        self.assertEqual(r.status_code, 200, r.content)
        return {row["date"]: row for row in r.json()["records"]}

    def test_every_status_on_the_payroll_calendar_and_the_employee_month(self):
        waiting_hod, waiting_hr, applied, rejected, untouched = (date(2026, 11, d) for d in (3, 4, 5, 6, 9))
        self.propose(waiting_hod, "present")
        self.hod_says(self.propose(waiting_hr, "present").json()["request"]["id"])
        self.approve_both(applied, "present")
        self.hod_says(
            self.propose(rejected, "present").json()["request"]["id"], "rejected", "the punches say otherwise"
        )

        listed, _off = self.extras(waiting_hod, waiting_hr, applied, rejected, untouched)
        mine = self.employee_month()
        for day in (listed, mine):
            self.assertEqual(day[str(waiting_hod)]["hrEdit"]["status"], "waiting_hod")
            self.assertEqual(day[str(waiting_hod)]["hrEdit"]["stageLabel"], "Waiting for Department Head (Suresh Raj)")
            self.assertEqual(day[str(waiting_hr)]["hrEdit"]["status"], "waiting_hr")
            self.assertTrue(
                day[str(waiting_hr)]["hrEdit"]["stageLabel"].startswith(
                    "Waiting for HR (Department Head Suresh Raj approved on "
                )
            )
            got = day[str(applied)]["hrEdit"]
            self.assertEqual((got["status"], got["decidedBy"]), ("applied", "Meena"))
            self.assertTrue(
                got["stageLabel"].startswith("Applied - approved by Suresh Raj (Department Head) and Meena (HR) on ")
            )
            self.assertEqual(
                (got["from"], got["to"], got["option"]),
                ({"label": "Absent", "shifts": 0.0}, {"label": "Present", "shifts": 1.0}, "worked"),
            )
            self.assertEqual((got["raisedBy"], got["reason"]), ("Meena", "checked with the HOD"))
            no = day[str(rejected)]["hrEdit"]
            self.assertEqual((no["status"], no["decidedBy"]), ("rejected", "Suresh Raj"))
            self.assertIn("the punches say otherwise", no["stageLabel"])
        self.assertNotIn("hrEdit", listed[str(untouched)])  # the payroll calendar leaves the key out on an unedited day
        self.assertIsNone(mine[str(untouched)]["hrEdit"])  # the employee month sends null
        self.assertEqual(set(mine[str(applied)]["hrEdit"]), set(HR_EDIT_KEYS))

    def test_the_latest_edit_of_the_day_is_the_one_shown(self):
        d = date(2026, 11, 3)
        self.propose(d, "present")
        second = self.propose(d, "half_day").json()["request"]["id"]
        listed, _off = self.extras(d)
        self.assertEqual(
            (listed[str(d)]["hrEdit"]["requestId"], listed[str(d)]["hrEdit"]["to"]["label"]), (second, "Half Day")
        )

    def test_an_off_day_carries_it_too(self):
        sunday = date(2026, 11, 8)
        self.approve_both(sunday, "on_duty")
        _listed, off = self.extras()
        self.assertEqual(off[str(sunday)]["hrEdit"]["status"], "applied")
        self.assertEqual(off[str(sunday)]["attendance"]["hrEdit"]["option"], "on_duty")

    def test_putting_the_day_back_to_automatic_takes_the_mark_away(self):
        d = date(2026, 11, 3)
        self.approve_both(d, "present")
        r = self.send("post", "/api/attendance/override", {"employeeId": self.emp.id, "date": str(d), "reset": True})
        self.assertEqual(r.status_code, 200, r.content)
        listed, _off = self.extras(d)
        self.assertNotIn("hrEdit", listed[str(d)])
        self.assertIsNone(self.employee_month()[str(d)]["hrEdit"])

    def test_the_new_options_read_plainly(self):
        d = date(2026, 11, 3)
        self.punch(d, time(9, 30), time(18, 5))
        self.propose(d, "permission", choice="morning_late_in")
        got = self.employee_month()[str(d)]["hrEdit"]
        self.assertEqual(
            (got["option"], got["typeLabel"], got["to"]["shifts"]), ("permission", "Permission · Morning Late-In", None)
        )
        ctx = self.send("get", f"/api/attendance/edit-context?employeeId={self.emp.id}&date={d}").json()
        self.assertEqual(ctx["hrEdit"]["status"], "waiting_hod")
        self.assertEqual(ctx["requests"][0]["option"], "permission")

    def test_the_typescript_contract_once_the_screens_declare_it(self):
        from .tests_payroll_insights import _TS_FILES, _TsContract, _read_frontend

        path = _TS_FILES / "payroll-insights.ts"
        if not path.exists() or "export type HrEdit " not in _read_frontend(path):
            self.skipTest("the frontend does not declare HrEdit yet")
        d = date(2026, 11, 3)
        self.approve_both(d, "present")
        listed, _off = self.extras(d)
        self.assertEqual(_TsContract().errors(listed[str(d)]["hrEdit"], ("ref", "HrEdit")), [])


HR_EDIT_KEYS = (
    "requestId",
    "status",
    "stageLabel",
    "from",
    "to",
    "option",
    "type",
    "typeLabel",
    "reason",
    "comment",
    "raisedBy",
    "raisedAt",
    "decidedBy",
    "decidedAt",
)


class WorkflowTextTests(RoundBase):
    def test_the_casual_leave_pipeline_describes_the_yearly_balance(self):
        self.assertIn("12 days a year", approval.definition("casual_leave").purpose)
        self.assertEqual(cl_balance.ENTITLEMENT, 12)
        self.assertEqual(cl_balance.PORTION_DAYS["first_half"], Decimal("0.5"))

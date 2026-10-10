"""
Casual Leave board (GET /api/casual-leaves/eligibility) and the employee fields the Leave and Casual Leave pages filter
on. The board answers three questions for a month: who has taken CL, who still can, and who cannot and why. Its answer
must never disagree with what a submission is checked with (check_cl_eligibility).

Run via: python manage.py test api.tests_leave_casual_overview -v 2
"""

from datetime import date
from unittest import mock

from django.test import SimpleTestCase, TestCase

from .casual_leave_views import board_reference_date, eligible_from
from .jwt_utils import sign_token
from .models import (
    Branch,
    CasualLeaveRequest,
    Department,
    Employee,
    EmployeePermission,
    HRUser,
    LeaveRequest,
    Role,
)

TODAY = date(2026, 10, 15)


def _bearer(payload: dict) -> dict:
    return {"HTTP_AUTHORIZATION": f"Bearer {sign_token(payload)}"}


class EligibleFromTests(SimpleTestCase):
    def test_six_calendar_months_after_joining(self):
        self.assertEqual(eligible_from(date(2026, 4, 15)), date(2026, 10, 15))
        self.assertEqual(eligible_from(date(2025, 12, 1)), date(2026, 6, 1))
        self.assertEqual(eligible_from(date(2026, 1, 31)), date(2026, 7, 31))

    def test_joining_on_a_day_the_target_month_lacks_moves_to_the_first_day_that_counts_six_months(self):
        # 31 Aug + 6 months has no 31 Feb: the count is still five on 28 Feb, six on 1 Mar
        self.assertEqual(eligible_from(date(2026, 8, 31)), date(2027, 3, 1))
        self.assertEqual(eligible_from(date(2023, 8, 31)), date(2024, 3, 1))  # leap year: 29 Feb is still five

    def test_the_date_is_exactly_the_first_one_the_service_count_reaches_six(self):
        from .casual_leave_views import _months_between

        for joined in (date(2026, 4, 15), date(2026, 8, 31), date(2025, 11, 30), date(2026, 2, 28)):
            on = eligible_from(joined)
            self.assertGreaterEqual(_months_between(joined, on), 6, joined)
            self.assertLess(_months_between(joined, date.fromordinal(on.toordinal() - 1)), 6, joined)


class ReferenceDateTests(SimpleTestCase):
    def test_this_month_is_judged_on_today(self):
        self.assertEqual(board_reference_date(2026, 10, TODAY), TODAY)

    def test_a_past_month_is_judged_on_its_last_day(self):
        self.assertEqual(board_reference_date(2026, 9, TODAY), date(2026, 9, 30))
        self.assertEqual(board_reference_date(2026, 2, TODAY), date(2026, 2, 28))

    def test_a_future_month_keeps_the_old_mid_month_day(self):
        self.assertEqual(board_reference_date(2026, 11, TODAY), date(2026, 11, 15))


class BoardTests(TestCase):
    def setUp(self):
        pin = mock.patch("api.casual_leave_views.ist_today", return_value=TODAY)
        pin.start()
        self.addCleanup(pin.stop)
        # the window that limits what an EMPLOYEE may request does not apply to HR, but keep it pinned for the submit checks
        pin2 = mock.patch("api.request_window.ist_today", return_value=TODAY)
        pin2.start()
        self.addCleanup(pin2.stop)
        self.admin = HRUser.objects.create(username="lco_admin", password_hash="x", is_super_admin=True)
        self.hr = _bearer({"role": "hr", "hrUserId": self.admin.id})
        self.ho = Branch.objects.create(name="LCO Head Office", code="LCOHO", is_head_office=True)
        self.u2 = Branch.objects.create(name="LCO Unit 2", code="LCOU2")
        self.cutting = Department.objects.create(name="LCO Cutting", branch=self.ho)

    def emp(self, code, join="2025-01-01", kind="staff", status="active", branch=None, dept=None):
        return Employee.objects.create(
            employee_code=code,
            first_name=code,
            last_name="Lco",
            employment_type=kind,
            status=status,
            join_date=join,
            branch=branch or self.ho,
            department=dept,
        )

    def cl(self, emp, on, status="approved", **extra):
        return CasualLeaveRequest.objects.create(employee=emp, date=on, status=status, approval_trail=[], **extra)

    def board(self, query="", who=None):
        r = self.client.get(f"/api/casual-leaves/eligibility{query}", **(who or self.hr))
        self.assertEqual(r.status_code, 200, r.content)
        return r.json()

    def row(self, body, emp):
        return next(r for r in body["employees"] if r["employeeId"] == emp.id)

    # ── who is eligible ──

    def test_a_long_serving_staff_member_with_no_cl_this_month_is_eligible(self):
        e = self.emp("LCO1", join="2024-03-01")
        row = self.row(self.board(), e)
        self.assertTrue(row["eligible"])
        self.assertIsNone(row["reason"])
        self.assertIsNone(row["reasonCode"])
        self.assertEqual(row["serviceMonths"], 31)
        self.assertEqual(row["employmentType"], "staff")
        self.assertEqual(row["branch"], "LCO Head Office")

    def test_exactly_six_months_today_is_eligible_and_one_day_short_is_not(self):
        on_the_day = self.emp("LCO2", join="2026-04-15")
        a_day_short = self.emp("LCO3", join="2026-04-16")
        body = self.board()
        self.assertTrue(self.row(body, on_the_day)["eligible"])
        short = self.row(body, a_day_short)
        self.assertFalse(short["eligible"])
        self.assertEqual(short["reasonCode"], "under_service")
        self.assertEqual(short["serviceMonths"], 5)
        self.assertEqual(short["reason"], "5/6 months of service")
        self.assertEqual(short["eligibleFrom"], "2026-10-16")  # tomorrow: the page can say when

    def test_the_board_agrees_with_what_a_submission_is_checked_with(self):
        eligible = self.emp("LCO4", join="2026-04-15")
        too_new = self.emp("LCO5", join="2026-04-16")
        body = self.board()
        for emp in (eligible, too_new):
            posted = self.client.post(
                "/api/casual-leaves",
                {"employeeId": emp.id, "date": "2026-10-20"},
                content_type="application/json",
                **self.hr,
            )
            self.assertEqual(posted.status_code == 201, self.row(body, emp)["eligible"], emp.employee_code)

    # ── who is not, and why ──

    def test_production_employees_are_left_out_by_default_and_named_with_scope_all(self):
        p = self.emp("LCO6", kind="production")
        self.assertNotIn(p.id, [r["employeeId"] for r in self.board()["employees"]])
        row = self.row(self.board("?scope=all"), p)
        self.assertFalse(row["eligible"])
        self.assertEqual(row["reasonCode"], "not_staff")
        self.assertIn("only for staff", row["reason"])
        self.assertIsNone(row["eligibleFrom"])  # service length is not what stops them

    def test_inactive_employees_are_not_on_the_board_at_all(self):
        gone = self.emp("LCO7", status="inactive")
        for query in ("", "?scope=all"):
            self.assertNotIn(gone.id, [r["employeeId"] for r in self.board(query)["employees"]])

    def test_a_missing_join_date_is_its_own_reason(self):
        e = self.emp("LCO8", join="")
        row = self.row(self.board(), e)
        self.assertEqual(row["reasonCode"], "no_join_date")
        self.assertIsNone(row["serviceMonths"])
        self.assertIsNone(row["eligibleFrom"])

    def test_a_pending_or_approved_cl_this_month_blocks_another_but_a_rejected_one_does_not(self):
        pending = self.emp("LCO9")
        approved = self.emp("LCO10")
        rejected = self.emp("LCO11")
        p = self.cl(pending, date(2026, 10, 20), "pending")
        a = self.cl(approved, date(2026, 10, 3), "approved", reviewed_by="Meena", reviewer_role="hr")
        self.cl(rejected, date(2026, 10, 4), "rejected")
        body = self.board()
        for emp, req, status in ((pending, p, "pending"), (approved, a, "approved")):
            row = self.row(body, emp)
            self.assertFalse(row["eligible"], emp.employee_code)
            self.assertEqual(row["reasonCode"], "used_this_month")
            self.assertTrue(row["usedThisMonth"])
            self.assertEqual(row["usedStatus"], status)
            self.assertEqual(row["usedRequestId"], req.id)
        self.assertEqual(self.row(body, approved)["usedReviewedBy"], "Meena")
        self.assertEqual(self.row(body, approved)["usedDate"], "2026-10-03")
        self.assertTrue(self.row(body, rejected)["eligible"])

    def test_the_used_requests_pipeline_comes_with_the_row(self):
        e = self.emp("LCO12")
        self.cl(e, date(2026, 10, 9), "pending")
        used = self.row(self.board(), e)["usedApproval"]
        self.assertEqual(used["workflow"], "casual_leave")
        self.assertEqual(sorted(used["waitingFor"]), ["hod", "hr"])

    # ── month boundaries ──

    def test_a_cl_in_another_month_does_not_block_this_one(self):
        e = self.emp("LCO13")
        self.cl(e, date(2026, 9, 30), "approved")
        self.cl(e, date(2026, 11, 1), "pending")
        body = self.board()
        row = self.row(body, e)
        self.assertTrue(row["eligible"])
        self.assertEqual(row["lastClDate"], "2026-09-30")  # the last one on or before the month's end
        self.assertEqual(row["approvedThisYear"], 1)
        # and each of those months sees its own
        sept = self.row(self.board("?month=9&year=2026"), e)
        self.assertTrue(sept["usedThisMonth"])
        self.assertEqual(sept["usedDate"], "2026-09-30")
        nov = self.row(self.board("?month=11&year=2026"), e)
        self.assertTrue(nov["usedThisMonth"])

    def test_a_past_month_judges_service_on_its_last_day(self):
        # joined 15 Mar: six months complete on 15 Sep, so September's board counts them, August's does not
        e = self.emp("LCO14", join="2026-03-15")
        self.assertTrue(self.row(self.board("?month=9&year=2026"), e)["eligible"])
        august = self.row(self.board("?month=8&year=2026"), e)
        self.assertFalse(august["eligible"])
        self.assertEqual(august["reasonCode"], "under_service")
        self.assertEqual(august["eligibleFrom"], "2026-09-15")

    def test_someone_who_qualifies_later_this_month_is_not_eligible_yet(self):
        e = self.emp("LCO15", join="2026-04-20")  # six months on 20 Oct, the board is on 15 Oct
        row = self.row(self.board(), e)
        self.assertFalse(row["eligible"])
        self.assertEqual(row["eligibleFrom"], "2026-10-20")

    def test_a_bad_month_is_a_400_not_a_crash(self):
        for query in ("?month=13", "?month=abc", "?year=99999"):
            self.assertEqual(
                self.client.get(f"/api/casual-leaves/eligibility{query}", **self.hr).status_code, 400, query
            )

    # ── the answer's shape ──

    def test_rows_keep_every_field_older_readers_use_and_eligible_ones_sort_first(self):
        a = self.emp("LCO16", join="2026-09-01")
        b = self.emp("LCO17")
        body = self.board()
        self.assertEqual(body["eligibilityMonths"], 6)
        self.assertEqual((body["month"], body["year"]), (10, 2026))
        for key in (
            "employeeId",
            "employeeCode",
            "employeeName",
            "department",
            "designation",
            "joinDate",
            "serviceMonths",
            "eligible",
            "reason",
            "usedThisMonth",
            "usedStatus",
            "usedDate",
        ):
            self.assertIn(key, self.row(body, a))
        order = [r["employeeId"] for r in body["employees"]]
        self.assertLess(order.index(b.id), order.index(a.id))

    def test_the_counts_add_up(self):
        self.emp("LCO18")
        self.emp("LCO19", join="2026-09-01")
        taken = self.emp("LCO20")
        self.cl(taken, date(2026, 10, 2))
        self.emp("LCO21", kind="production")
        counts = self.board("?scope=all")["counts"]
        self.assertEqual(counts, {"eligible": 1, "notEligible": 3, "usedThisMonth": 1})

    # ── who may ask ──

    def test_an_employee_login_cannot_read_the_board(self):
        e = self.emp("LCO22")
        r = self.client.get("/api/casual-leaves/eligibility", **_bearer({"role": "employee", "employeeId": e.id}))
        self.assertEqual(r.status_code, 403)

    def test_a_branch_scoped_hr_user_only_sees_their_own_branch(self):
        mine = self.emp("LCO23", branch=self.ho)
        theirs = self.emp("LCO24", branch=self.u2)
        role = Role.objects.create(name="lco_role", permissions={"casual_leave": "view"})
        scoped = HRUser.objects.create(username="lco_scoped", password_hash="x", role=role, branch=self.ho)
        who = _bearer({"role": "hr", "hrUserId": scoped.id})
        ids = [r["employeeId"] for r in self.board("?scope=all", who)["employees"]]
        self.assertIn(mine.id, ids)
        self.assertNotIn(theirs.id, ids)

    # ── the lists the pages filter ──

    def test_casual_leave_requests_carry_branch_department_and_type(self):
        e = self.emp("LCO25", branch=self.u2, dept=self.cutting)
        self.cl(e, date(2026, 10, 7), "pending")
        rows = self.client.get("/api/casual-leaves?month=10&year=2026", **self.hr).json()
        mine = next(r for r in rows if r["employeeId"] == e.id)
        self.assertEqual(mine["branch"], "LCO Unit 2")
        self.assertEqual(mine["branchId"], self.u2.id)
        self.assertEqual(mine["departmentId"], self.cutting.id)
        self.assertEqual(mine["department"], "LCO Cutting")
        self.assertEqual(mine["employmentType"], "staff")

    def test_leave_requests_carry_branch_department_and_type(self):
        e = self.emp("LCO26", kind="production", branch=self.u2, dept=self.cutting)
        LeaveRequest.objects.create(
            employee=e, type="sick", start_date="2026-10-05", end_date="2026-10-06", status="pending", approval_trail=[]
        )
        rows = self.client.get("/api/leave-requests", **self.hr).json()
        mine = next(r for r in rows if r["employeeId"] == e.id)
        self.assertEqual(mine["branch"], "LCO Unit 2")
        self.assertEqual(mine["branchId"], self.u2.id)
        self.assertEqual(mine["departmentId"], self.cutting.id)
        self.assertEqual(mine["employmentType"], "production")
        # what was already there is still there
        for key in ("employeeName", "employeeCode", "department", "type", "startDate", "endDate", "status", "approval"):
            self.assertIn(key, mine)

    def test_permissions_carry_branch_department_and_type(self):
        e = self.emp("LCO27", branch=self.u2, dept=self.cutting)
        EmployeePermission.objects.create(employee=e, date=date(2026, 10, 8), status="pending")
        rows = self.client.get("/api/permissions?month=10&year=2026", **self.hr).json()
        mine = next(r for r in rows if r["employeeId"] == e.id)
        self.assertEqual(mine["branch"], "LCO Unit 2")
        self.assertEqual(mine["branchId"], self.u2.id)
        self.assertEqual(mine["departmentId"], self.cutting.id)
        self.assertEqual(mine["employmentType"], "staff")
        for key in ("employeeName", "department", "date", "status", "capStatus", "approval"):
            self.assertIn(key, mine)


class HolidayEditTests(TestCase):
    """Editing a holiday sends its date as text: the reply used to be built from that text and failed with a 500."""

    def test_put_changes_the_holiday_and_answers_with_it(self):
        from .models import Holiday

        admin = HRUser.objects.create(username="lco_hol_admin", password_hash="x", is_super_admin=True)
        h = Holiday.objects.create(name="Founders Day", date=date(2026, 12, 30), holiday_type="national")
        r = self.client.put(
            f"/api/holidays/{h.id}",
            {"name": "Founders Day (moved)", "date": "2026-12-29", "isRecurring": True},
            content_type="application/json",
            **_bearer({"role": "hr", "hrUserId": admin.id}),
        )
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(r.json()["date"], "2026-12-29")
        self.assertEqual(r.json()["name"], "Founders Day (moved)")
        h.refresh_from_db()
        self.assertEqual(h.date, date(2026, 12, 29))
        self.assertTrue(h.is_recurring)

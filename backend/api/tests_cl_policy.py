"""
Casual Leave policy (Settings -> Casual Leave, owner 2026-11-21): nothing about Casual Leave hardcoded.

  A. The monthly allocation (the default): each month adds its days from the month the employee starts; with carry forward
     unused days stay for later months with no monthly limit, without it each month's days end with the month; a month's
     days cannot be used before that month, and a Casual Leave already booked for a later month keeps its days.
  B. Service in months or days; the balance starts on the day the service is complete.
  C. 31 December: unused days lapse, or move into the next year (at most the maximum).
  D. Half days switched off.
  E. GET|PUT /api/casual-leave-policy: validation, partial saves, the audit line, who may change it.
  F. Carry Forward (HR gives absent days as Casual Leave) under the monthly allocation.

Run via: DATABASE_URL= DB_TEST_NAME=test_uktex_clpolicy python manage.py test api.tests_cl_policy
"""

from datetime import date
from decimal import Decimal

from . import cl_balance
from .casual_leave_views import check_cl_eligibility
from .models import AuditLog, Branch, CasualLeavePolicy, HRUser, PayrollSettings, Role
from .tests_approval_workflow import _bearer
from .tests_attendance_edit_round import TODAY, RoundBase
from .tests_cl_adjustments import CarryBase

POLICY = "/api/casual-leave-policy"


def set_policy(**fields):
    """Save the policy (the tests' RoundBase starts from the yearly one)."""
    defaults = {
        "eligibility_basis": "months",
        "eligibility_value": 6,
        "allocation": "monthly",
        "monthly_allocation": Decimal("1"),
        "yearly_allocation": Decimal("12"),
        "carry_forward": True,
        "year_end_carry": False,
        "year_end_carry_max": None,
        "half_day_allowed": True,
    }
    CasualLeavePolicy.objects.update_or_create(pk=1, defaults={**defaults, **fields})


def start_policy_on(day: date):
    ps = PayrollSettings.get()
    ps.cl_balance_since = day
    ps.save()


class MonthlyBase(RoundBase):
    """W1 (joined 2020), today pinned to 20 Nov 2026, the monthly policy (1 day a month, carry forward)."""

    def setUp(self):
        super().setUp()
        set_policy()


class MonthlyAllocationTests(MonthlyBase):
    def test_each_month_adds_its_days_from_the_start(self):
        # the policy starts on 2 Nov 2026: November gives 1, December 1 more
        b = self.balance()
        self.assertEqual((b["allocation"], b["perMonth"], b["total"], b["remaining"]), ("monthly", 1, 1, 1))
        self.assertEqual(b["asOf"], "2026-11")
        december = cl_balance.balance(self.emp, 2026, today=date(2026, 12, 5))
        self.assertEqual((december["total"], december["remaining"]), (2, 2))
        # the old keys stay
        for key in ("used", "pending", "year", "since", "endsOn", "cutOver", "tracked"):
            self.assertIn(key, b)

    def test_carry_forward_has_no_monthly_limit(self):
        start_policy_on(date(2026, 1, 1))
        self.assertEqual(self.balance()["remaining"], 11)  # January to November, nothing used
        for day in (23, 24, 25):
            r = self.post_cl(date(2026, 11, day))
            self.assertEqual(r.status_code, 201, r.content)
        b = self.balance()
        self.assertEqual((b["pending"], b["remaining"]), (3, 8))

    def test_a_month_cannot_use_a_later_months_days(self):
        self.assertEqual(self.post_cl(date(2026, 11, 23)).status_code, 201)
        refused = self.post_cl(date(2026, 11, 24))
        self.assertEqual(refused.status_code, 400)
        self.assertEqual(
            refused.json()["error"],
            "No Casual Leave left for November 2026: every day given so far (1 day a month) is used or waiting for "
            "approval",
        )
        # December still has its own day (asked through HR, the employee window being this month only)
        self.assertEqual(check_cl_eligibility(self.emp, date(2026, 12, 10), "full"), (True, None))

    def test_a_later_booking_keeps_its_days(self):
        # two approved days in December need November's day too, so November has nothing left to give
        self.cl(date(2026, 12, 1))
        self.cl(date(2026, 12, 2))
        self.assertEqual(cl_balance.available_on(self.emp, date(2026, 11, 24)), Decimal("0"))
        ok, why = check_cl_eligibility(self.emp, date(2026, 11, 24), "full")
        self.assertFalse(ok)
        self.assertIn("No Casual Leave left for November 2026", why)

    def test_without_carry_forward_each_month_has_only_its_own_days(self):
        set_policy(carry_forward=False)
        start_policy_on(date(2026, 1, 1))
        self.assertEqual(self.balance()["remaining"], 1)
        self.assertFalse(self.balance()["carryForward"])
        self.assertEqual(self.post_cl(date(2026, 11, 23)).status_code, 201)
        refused = self.post_cl(date(2026, 11, 24), "first_half")
        self.assertEqual(refused.status_code, 400)
        self.assertEqual(
            refused.json()["error"],
            "No Casual Leave left for November 2026: the month's 1 day is used or waiting for approval",
        )
        # nothing builds up, so nothing is left at the year end either
        self.assertEqual(self.balance()["leftAtYearEnd"], 0)

    def test_two_days_a_month(self):
        set_policy(monthly_allocation=Decimal("2"))
        b = self.balance()
        self.assertEqual((b["perMonth"], b["total"], b["remaining"]), (2, 2, 2))
        self.assertEqual(self.post_cl(date(2026, 11, 23)).status_code, 201)
        self.assertEqual(self.post_cl(date(2026, 11, 24)).status_code, 201)
        self.assertEqual(self.post_cl(date(2026, 11, 25)).status_code, 400)

    def test_the_apps_and_the_board_carry_the_policy(self):
        mine = self.as_employee("get", "/api/casual-leaves/my-eligibility").json()
        self.assertEqual(mine["policy"]["allocation"], "monthly")
        self.assertEqual(mine["policy"]["allocationText"], "1 day a month")
        self.assertEqual(mine["policy"]["serviceText"], "6 months of service")
        self.assertTrue(mine["halfDayAllowed"])
        self.assertEqual(mine["yearlyEntitlement"], 2)  # November and December of 2026
        self.assertEqual(mine["remainingThisYear"], 1)
        board = self.send("get", "/api/casual-leaves/eligibility?month=11&year=2026").json()
        self.assertEqual(board["policy"]["eligibilityBasis"], "months")
        self.assertEqual(board["eligibilityMonths"], 6)
        self.assertEqual(board["yearlyEntitlement"], 12)
        row = next(r for r in board["employees"] if r["employeeId"] == self.emp.id)
        self.assertEqual((row["eligible"], row["balance"]["remaining"]), (True, 1))


class ServiceTests(MonthlyBase):
    def test_service_in_days(self):
        set_policy(eligibility_basis="days", eligibility_value=30)
        self.emp.join_date = "2026-11-10"
        self.emp.save()
        self.assertEqual(
            check_cl_eligibility(self.emp, TODAY), (False, "Eligible after 30 days of service (currently 10 days)")
        )
        self.emp.join_date = "2026-10-01"  # 30 days complete on 31 Oct
        self.emp.save()
        self.assertEqual(check_cl_eligibility(self.emp, TODAY, "full"), (True, None))
        board = self.send("get", "/api/casual-leaves/eligibility?month=11&year=2026").json()
        self.assertIsNone(board["eligibilityMonths"])
        self.assertEqual(board["policy"]["serviceText"], "30 days of service")

    def test_the_balance_starts_the_month_the_service_is_complete(self):
        start_policy_on(date(2026, 1, 1))
        self.emp.join_date = "2026-03-15"  # six months on 15 Sep 2026
        self.emp.save()
        b = self.balance()
        self.assertEqual((b["since"], b["total"], b["remaining"]), ("2026-09-15", 3, 3))  # Sep, Oct, Nov
        ok, why = check_cl_eligibility(self.emp, date(2026, 9, 10), "full")
        self.assertFalse(ok)
        self.assertEqual(
            why, "Casual Leave counts from 15 Sep 2026 (6 months of service complete). Choose a later date."
        )

    def test_too_new_on_the_board_says_the_days_in_the_policys_unit(self):
        set_policy(eligibility_basis="days", eligibility_value=180)
        self.emp.join_date = "2026-10-01"
        self.emp.save()
        board = self.send("get", "/api/casual-leaves/eligibility?month=11&year=2026").json()
        row = next(r for r in board["employees"] if r["employeeId"] == self.emp.id)
        self.assertEqual((row["reasonCode"], row["reason"]), ("under_service", "50/180 days of service"))
        self.assertEqual((row["serviceDays"], row["eligibleFrom"]), (50, "2027-03-30"))


class YearEndTests(MonthlyBase):
    def setUp(self):
        super().setUp()
        start_policy_on(date(2026, 1, 1))

    def next_year(self):
        return cl_balance.balance(self.emp, 2027, today=date(2027, 1, 10))

    def test_unused_days_lapse_by_default(self):
        self.assertEqual(cl_balance.balance(self.emp, 2026, today=date(2026, 12, 31))["leftAtYearEnd"], 12)
        b = self.next_year()
        self.assertEqual((b["carriedIn"], b["total"], b["remaining"], b["yearEnd"]), (0, 1, 1, "lapse"))

    def test_unused_days_move_into_the_next_year_up_to_the_maximum(self):
        set_policy(year_end_carry=True, year_end_carry_max=Decimal("5"))
        self.cl(date(2026, 6, 1))  # 11 left at the end of 2026, 5 move
        b = self.next_year()
        self.assertEqual((b["carriedIn"], b["total"], b["remaining"], b["yearEnd"]), (5, 6, 6, "carry"))
        set_policy(year_end_carry=True, year_end_carry_max=None)
        self.assertEqual(self.next_year()["carriedIn"], 11)

    def test_the_yearly_allocation_carries_too(self):
        set_policy(allocation="yearly", year_end_carry=True, year_end_carry_max=Decimal("3"))
        b = self.next_year()
        self.assertEqual((b["carriedIn"], b["total"], b["remaining"]), (3, 15, 15))


class HalfDayTests(MonthlyBase):
    def test_half_days_switched_off(self):
        set_policy(half_day_allowed=False)
        refused = self.post_cl(date(2026, 11, 23), "first_half")
        self.assertEqual(refused.status_code, 400)
        self.assertEqual(refused.json()["error"], "Half-day Casual Leave is switched off. Choose Full day.")
        mine = self.as_employee("get", "/api/casual-leaves/my-eligibility").json()
        self.assertEqual([p["value"] for p in mine["portions"]], ["full"])
        self.assertFalse(mine["halfDayAllowed"])
        self.assertEqual(self.post_cl(date(2026, 11, 23)).status_code, 201)

    def test_half_a_day_left_with_half_days_off_is_nothing_to_ask_for(self):
        set_policy(monthly_allocation=Decimal("0.5"), half_day_allowed=False)
        ok, why = check_cl_eligibility(self.emp, date(2026, 11, 23))
        self.assertFalse(ok)
        self.assertEqual(
            why, "Only half a day of Casual Leave is left for November 2026, and half days are switched off."
        )


class PolicyApiTests(RoundBase):
    def test_reads_the_starting_policy_without_saving_anything(self):
        CasualLeavePolicy.objects.all().delete()
        body = self.send("get", POLICY).json()
        self.assertEqual(
            (body["eligibilityBasis"], body["eligibilityValue"], body["allocation"], body["monthlyAllocation"]),
            ("months", 6, "monthly", 1),
        )
        self.assertEqual((body["carryForward"], body["yearEnd"], body["halfDayAllowed"]), (True, "lapse", True))
        self.assertTrue(body["canEdit"])
        self.assertEqual(body["balanceSince"], "2026-11-02")
        self.assertFalse(CasualLeavePolicy.objects.exists())

    def test_saves_the_whole_policy_and_logs_it(self):
        r = self.send(
            "put",
            POLICY,
            {
                "eligibilityBasis": "days",
                "eligibilityValue": 90,
                "allocation": "monthly",
                "monthlyAllocation": 1.5,
                "carryForward": True,
                "yearEnd": "carry",
                "yearEndCarryMax": 6,
                "halfDayAllowed": True,
                "balanceSince": "2026-10-01",
            },
        )
        self.assertEqual(r.status_code, 200, r.content)
        body = r.json()
        self.assertEqual(
            (body["eligibilityBasis"], body["eligibilityValue"], body["monthlyAllocation"]), ("days", 90, 1.5)
        )
        self.assertEqual((body["yearEnd"], body["yearEndCarryMax"], body["balanceSince"]), ("carry", 6, "2026-10-01"))
        self.assertEqual(body["updatedBy"], "Meena")
        row = CasualLeavePolicy.objects.get(pk=1)
        self.assertEqual(
            (row.eligibility_value, row.monthly_allocation, row.year_end_carry), (90, Decimal("1.5"), True)
        )
        self.assertEqual(cl_balance.since(), date(2026, 10, 1))
        line = AuditLog.objects.filter(module="settings").order_by("-id").first()
        self.assertIn("Casual Leave policy changed", line.record_description)
        self.assertIn("Service needed 6 -> 90", line.record_description)

    def test_a_save_may_send_only_what_changed(self):
        r = self.send("put", POLICY, {"halfDayAllowed": False})
        self.assertEqual(r.status_code, 200, r.content)
        body = r.json()
        self.assertEqual((body["halfDayAllowed"], body["allocation"], body["yearlyAllocation"]), (False, "yearly", 12))

    def test_refuses_what_cannot_work_and_saves_nothing(self):
        before = cl_balance.policy()
        cases = {
            "eligibilityValue": {"eligibilityValue": "six"},
            "monthlyAllocation": {"monthlyAllocation": 0.25},
            "yearlyAllocation": {"yearlyAllocation": 400},
            "carryForward": {"carryForward": "yes"},
            "balanceSince": {"balanceSince": "soon"},
            "yearEndCarryMax": {"yearEnd": "carry", "yearEndCarryMax": -1},
        }
        for field, body in cases.items():
            r = self.send("put", POLICY, body)
            self.assertEqual(r.status_code, 400, (field, r.content))
            self.assertIn(field, r.json()["errors"], field)
        r = self.send("put", POLICY, {"allocation": "monthly", "carryForward": False, "yearEnd": "carry"})
        self.assertEqual(r.status_code, 400)
        self.assertIn("only when they carry forward", r.json()["errors"]["yearEnd"])
        r = self.send("put", POLICY, {"allocation": "monthly", "monthlyAllocation": 1.5, "halfDayAllowed": False})
        self.assertEqual(r.json()["errors"], {"monthlyAllocation": "Half days are switched off: give whole days."})
        self.assertEqual(cl_balance.policy(), before)

    def test_months_or_days_have_their_own_limits(self):
        self.assertEqual(self.send("put", POLICY, {"eligibilityValue": 121}).status_code, 400)
        r = self.send("put", POLICY, {"eligibilityBasis": "days", "eligibilityValue": 365})
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(r.json()["serviceText"], "365 days of service")

    def test_only_a_company_wide_hr_login_may_change_it(self):
        self.assertEqual(self.as_employee("get", POLICY).status_code, 403)
        branch = Branch.objects.create(name="North", code="NO")
        role = Role.objects.create(name="cl-settings", permissions={"settings": "edit"})
        user = HRUser.objects.create(username="branch_settings", password_hash="x", role=role, branch=branch)
        who = _bearer({"role": "hr", "hrUserId": user.id, "name": "Branch HR"})
        self.assertFalse(self.send("get", POLICY, who=who).json()["canEdit"])
        r = self.send("put", POLICY, {"allocation": "monthly"}, who)
        self.assertEqual(r.status_code, 403)
        self.assertEqual(cl_balance.policy().allocation, "yearly")

    def test_a_role_without_the_settings_tab_cannot_change_it(self):
        role = Role.objects.create(
            name="no-cl-settings", permissions={"settings": "edit", "settings.casual_leave": "view"}
        )
        user = HRUser.objects.create(username="cl_viewer", password_hash="x", role=role)
        who = _bearer({"role": "hr", "hrUserId": user.id, "name": "Viewer"})
        self.assertEqual(self.send("get", POLICY, who=who).status_code, 200)
        self.assertEqual(self.send("put", POLICY, {"allocation": "monthly"}, who).status_code, 403)


class CarryForwardMonthlyTests(CarryBase):
    """HR gives absent days as Casual Leave under the monthly policy (start 2 Nov 2026: November has 1 day)."""

    def setUp(self):
        super().setUp()
        set_policy()

    def test_the_picked_days_must_fit_what_is_left_now(self):
        r = self.assign([{"employeeId": self.emp.id, "limit": 2, "dates": ["2026-10-06", "2026-10-07"]}])
        self.assertEqual(r.status_code, 400)
        self.assertEqual(
            r.json()["problems"][0]["error"], "Only 1 day of Casual Leave left, so 2 days cannot be given."
        )
        r = self.assign([{"employeeId": self.emp.id, "limit": 1, "dates": ["2026-10-06"]}])
        self.assertEqual(r.status_code, 201, r.content)
        line = r.json()["items"][0]
        self.assertEqual((line["balanceBefore"], line["balanceAfter"]), (1, 0))

    def test_without_carry_forward_each_month_is_checked_on_its_own(self):
        set_policy(carry_forward=False)
        start_policy_on(date(2026, 10, 1))
        # October's one day for 6 Oct, November's for 17 Nov: both fit
        r = self.assign([{"employeeId": self.emp.id, "limit": 2, "dates": ["2026-10-06", "2026-11-17"]}])
        self.assertEqual(r.status_code, 201, r.content)
        # October has nothing left for 7 Oct
        r = self.assign([{"employeeId": self.emp.id, "limit": 1, "dates": ["2026-10-07"]}])
        self.assertEqual(r.status_code, 400)
        self.assertIn("of October's Casual Leave left", r.json()["problems"][0]["error"])

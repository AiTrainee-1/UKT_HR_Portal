"""
Production Payroll completion (owner 2026-11-16): moving workers between pay cycles, New Joiners, Moved out, and the
Staff-Payroll-style period workflow (Payroll Done -> Mark as Paid) per pay period of each cycle.

What these tests guarantee:

* NO working day is ever paid twice, in every direction (Weekly <-> BiWeekly <-> Monthly <-> Unassigned), through moves,
  regenerations, moving back, catch-up days and a finalized period the worker could not be paid in; and a worker moved
  between two different cycles loses no day (catch-up). Every row pays exactly its days (1 shift a day x Rs 500).
* A move of a worker who already has payroll needs confirm + reason (409 with the facts otherwise) and every move writes a
  ProductionCycleTransfer with what the old cycle paid.
* A new joiner and a worker who moved here are parked in New Joiners (out of the records, totals and statement) until HR
  adds them, and stay added through regeneration; Payroll Done is refused while anyone is parked.
* A period is generated only once it has ENDED (from the day after its last day). Payroll Done locks it for good;
  Mark as Paid records the paid day and pays every included payroll; next-due follows Payroll Done.
* Production rows follow production_payroll permissions on every route (PATCH, breakdown, progress), adjusting cannot make
  "Others" negative and keeps the payslip in step, and the 0151 backfill counts old Cleared as Paid.

Calendar (2026; "today" is 10 March, so every period below has ended):
    Weekly    Monday weeks from 5 Jan               5-11 Jan, 12-18 Jan, ..., 2-8 Mar
    BiWeekly  first period 2 Feb (Monday)           5-18 Jan, 19 Jan-1 Feb, 2-15 Feb, 16 Feb-1 Mar
    Monthly   four weeks, first period 2 Feb         5 Jan-1 Feb, 2 Feb-1 Mar
Every worker earns 1 shift a day at Rs 500, so N paid days are N x 500.

Run via: DATABASE_URL="" DB_TEST_NAME=test_uktex_<you> py -3 manage.py test api.tests_production_period_workflow
"""

from datetime import date, datetime, timedelta
from decimal import Decimal
from importlib import import_module
from unittest.mock import patch

from django.apps import apps as django_apps
from django.utils import timezone

from . import production_period_workflow as wf
from .clock import FACTORY_TZ
from .models import (
    Advance,
    AdvanceRepayment,
    AuditLog,
    Branch,
    Employee,
    Payroll,
    PayrollMonthClose,
    PayrollSettings,
    ProductionCycleTransfer,
    ProductionPeriodClose,
    Role,
    SalarySlip,
)
from .production_coverage import day_count, each_day, parse_ranges
from .production_period import next_cycle_period, resolve_cycle_period
from .tests_production_cycles import TODAY, CycleDbTestCase, _hr, _row, _settings, _shifts, _worker

D = date
GEN = "/api/payroll/production/generate"
ASSIGN = "/api/employees/production/assign"
PREVIEW = "/api/employees/production/cycle-change-preview"
LIST = "/api/payroll/production"
WORKFLOW = "/api/payroll/production/period-workflow"
FINALIZE = "/api/payroll/production/period-finalize"
PAID = "/api/payroll/production/period-paid"
NEW_JOINERS = "/api/payroll/production/new-joiners"
MOVED_OUT = "/api/payroll/production/moved-out"
FIRST_DAY = D(2026, 1, 5)
RATE = Decimal("500")


def iso(day: date) -> str:
    return day.isoformat()


def period_body(cycle, period, **extra):
    return {"cycle": cycle, "periodStart": iso(period[0]), "periodEnd": iso(period[1]), **extra}


def query(cycle, period) -> str:
    return f"cycle={cycle}&periodStart={iso(period[0])}&periodEnd={iso(period[1])}"


def ended_periods(cycle, start=FIRST_DAY, today=TODAY):
    """Every period of the cycle from the one holding `start` up to the last one that has ended before `today`."""
    ps = PayrollSettings.get()
    out = []
    period = resolve_cycle_period(start, ps, cycle)
    while period[1] < today:
        out.append(period)
        period = resolve_cycle_period(period[1] + timedelta(days=1), ps, cycle)
    return out


class WorkflowTestCase(CycleDbTestCase):
    def setUp(self):
        super().setUp()
        patch("api.production_period_workflow.ist_today", return_value=TODAY).start()

    # ── API helpers ──

    def patch_(self, url, body, headers=None):
        return self.client.patch(url, body, content_type="application/json", **(headers or self.admin))

    def gen(self, emp, cycle, period, regenerate=False, expect=201, replace=False):
        body = period_body(cycle, period, employeeIds=[emp.id], regenerate=regenerate, replaceDrafts=replace)
        r = self.post(GEN, body)
        self.assertEqual(r.status_code, expect, r.content)
        return r.json()

    def move(self, emp, cycle, reason="Moved by the test"):
        r = self.post(ASSIGN, {"employeeIds": [emp.id], "cycle": cycle, "confirm": True, "reason": reason})
        self.assertEqual(r.status_code, 200, r.content)
        emp.refresh_from_db()
        return r.json()

    def finalize(self, cycle, period, headers=None):
        return self.post(FINALIZE, period_body(cycle, period), headers)

    # ── the rule this whole module is about ──

    def assert_never_paid_twice(self, emp, *, no_gap=True):
        """Every payroll row of the worker pays its own days only: no day is in two rows, every row's pay is exactly its
        days x Rs 500, and (no_gap) from the first paid day to the last none is missing."""
        seen: dict[date, int] = {}
        for p in Payroll.objects.filter(employee=emp, period_start__isnull=False).order_by("period_start", "id"):
            ranges = parse_ranges(p.paid_ranges) or [(p.period_start, p.period_end)]
            days = list(each_day(ranges))
            for day in days:
                self.assertNotIn(
                    day, seen, f"{day} is paid by payroll {seen.get(day)} and payroll {p.pk} ({p.pay_cycle})"
                )
                seen[day] = p.pk
            self.assertEqual(p.gross_salary, RATE * day_count(ranges), f"payroll {p.pk} pays exactly its days")
            self.assertEqual(p.total_working_days, len(days), f"payroll {p.pk} counts its days")
        if no_gap and seen:
            first, last = min(seen), max(seen)
            missing = [d for d in each_day([(first, last)]) if d not in seen]
            self.assertEqual(missing, [], "a day between the first and the last paid day was never paid")
        return seen


# ─────────────────────────────────────────────────────────────────────────────
#  1. No day is ever paid twice: every direction, regeneration, moving back, catch-up
# ─────────────────────────────────────────────────────────────────────────────


class NeverPaidTwiceTests(WorkflowTestCase):
    def setUp(self):
        super().setUp()
        self.n = 0

    def worker(self, cycle):
        self.n += 1
        emp = _worker(f"NT{self.n}", cycle=cycle)
        _shifts(emp, FIRST_DAY, D(2026, 3, 9))
        return emp

    def generate_all(self, emp, cycle, regenerate=False, before: date | None = None, replace=False):
        """Generate (or generate again) every ended period of `cycle` for the worker, oldest first. A period whose days
        are all paid by a FINAL payroll is refused for the worker (it lands in skipped), and so is one sharing days with
        a draft of another period unless `replace`: that is the rule working."""
        for period in ended_periods(cycle):
            if before is not None and period[1] > before:
                break
            self.gen(emp, cycle, period, regenerate=regenerate, replace=replace)

    def scenario(self, first, second, via_unassigned=False, replace=False, finalize_first=False):
        emp = self.last_emp = self.worker(first)
        # the first cycle pays its first period(s)
        self.generate_all(emp, first, before=D(2026, 2, 1))
        if finalize_first:
            Payroll.objects.filter(employee=emp).update(payment_status=Payroll.PAYMENT_PAID)
        if via_unassigned:
            self.move(emp, None)
        self.move(emp, second)
        self.generate_all(emp, second, replace=replace)
        self.generate_all(emp, second, regenerate=True, replace=replace)
        self.assert_never_paid_twice(emp, no_gap=not replace)
        # and back again: every period of the first cycle generated / generated again, then the second's again
        self.move(emp, first)
        self.generate_all(emp, first, regenerate=True, replace=replace)
        self.assert_never_paid_twice(emp, no_gap=not replace)
        self.move(emp, second)
        self.generate_all(emp, second, regenerate=True, replace=replace)
        return self.assert_never_paid_twice(emp)

    def test_every_direction_between_two_cycles(self):
        for first in ("weekly", "biweekly", "monthly"):
            for second in ("weekly", "biweekly", "monthly"):
                if first == second:
                    continue
                with self.subTest(first=first, second=second):
                    seen = self.scenario(first, second)
                    self.assertEqual(min(seen), FIRST_DAY)

    def test_every_direction_replacing_drafts_and_never_a_final_payroll(self):
        # owner 2026-11-16: drafts (only Generated) are replaced by the period generated over them; a FINAL payroll (paid)
        # never is, and its days stay excluded. Both, in every direction.
        for first in ("weekly", "biweekly", "monthly"):
            for second in ("weekly", "biweekly", "monthly"):
                if first == second:
                    continue
                for finalize_first in (False, True):
                    with self.subTest(first=first, second=second, final=finalize_first):
                        seen = self.scenario(first, second, replace=True, finalize_first=finalize_first)
                        self.assertEqual(min(seen), FIRST_DAY)
                        emp = self.last_emp
                        firsts = Payroll.objects.filter(employee=emp, pay_cycle=first, period_end__lte=D(2026, 2, 1))
                        if finalize_first:
                            self.assertTrue(firsts.exists())  # the paid payroll is never replaced
                            self.assertTrue(all(p.payment_status == "paid" for p in firsts))

    def test_every_direction_through_unassigned(self):
        for first in ("weekly", "biweekly", "monthly"):
            for second in ("weekly", "biweekly", "monthly"):
                if first == second:
                    continue
                with self.subTest(first=first, second=second):
                    self.scenario(first, second, via_unassigned=True)

    def test_off_a_cycle_and_back_to_the_same_one_never_pays_twice(self):
        for cycle in ("weekly", "biweekly", "monthly"):
            with self.subTest(cycle=cycle):
                emp = self.worker(cycle)
                self.generate_all(emp, cycle, before=D(2026, 2, 1))
                self.move(emp, None)
                self.move(emp, cycle)
                self.generate_all(emp, cycle)
                self.generate_all(emp, cycle, regenerate=True)
                # back on the SAME cycle no catch-up is added (days while unassigned are not paid automatically)
                self.assert_never_paid_twice(emp, no_gap=False)

    def test_a_period_finalized_without_the_worker_is_caught_up_in_the_next_one(self):
        other = self.worker("biweekly")
        emp = self.worker("weekly")
        self.gen(emp, "weekly", (D(2026, 1, 5), D(2026, 1, 11)))
        # BiWeekly 5-18 Jan is generated for the others and finalized before the worker moves there
        self.gen(other, "biweekly", (D(2026, 1, 5), D(2026, 1, 18)))
        self.assertEqual(self.finalize("biweekly", (D(2026, 1, 5), D(2026, 1, 18))).status_code, 201)
        self.move(emp, "biweekly")
        refused = self.gen(emp, "biweekly", (D(2026, 1, 5), D(2026, 1, 18)), expect=409)
        self.assertIn("finalized", refused["error"])
        body = self.gen(emp, "biweekly", (D(2026, 1, 19), D(2026, 2, 1)))
        self.assertEqual(body["generated"], 1)
        row = Payroll.objects.get(employee=emp, period_start=D(2026, 1, 19))
        self.assertEqual(parse_ranges(row.paid_ranges), [(D(2026, 1, 12), D(2026, 2, 1))])  # 12-18 Jan caught up
        self.assertEqual(row.gross_salary, RATE * 21)
        self.assert_never_paid_twice(emp)

    def test_a_draft_of_the_old_cycle_is_refused_without_the_flag_and_replaced_with_it_a_final_one_never(self):
        emp = self.worker("monthly")
        self.gen(emp, "monthly", (D(2026, 1, 5), D(2026, 2, 1)))  # a draft (only Generated)
        self.move(emp, "weekly")
        body = self.gen(emp, "weekly", (D(2026, 1, 5), D(2026, 1, 11)))
        self.assertEqual(body["generated"], 0)
        self.assertIn("draft payslip for 5 Jan – 1 Feb 2026 (Monthly)", body["skippedDetails"][0]["reason"])
        # with the flag the draft is replaced: Weekly pays every day, once
        body = self.gen(emp, "weekly", (D(2026, 1, 5), D(2026, 1, 11)), replace=True)
        self.assertEqual((body["generated"], body["replaced"]), (1, 1))
        waiting = body["replacedDetails"][0]["waiting"]
        self.assertEqual(waiting, [{"from": "2026-01-12", "to": "2026-02-01"}])  # wait for their own weeks
        self.assertFalse(Payroll.objects.filter(employee=emp, pay_cycle="monthly").exists())
        self.generate_all(emp, "weekly", replace=True)
        seen = self.assert_never_paid_twice(emp)
        self.assertEqual((min(seen), max(seen)), (FIRST_DAY, D(2026, 3, 8)))
        # a FINAL payroll is never replaced: its days stay excluded
        Payroll.objects.filter(employee=emp, period_start=D(2026, 1, 5)).update(payment_status=Payroll.PAYMENT_PAID)
        self.move(emp, "monthly")
        body = self.gen(emp, "monthly", (D(2026, 1, 5), D(2026, 2, 1)), replace=True)
        self.assertEqual((body["generated"], body["replaced"]), (1, 3))  # 12 Jan - 1 Feb: three weekly drafts
        month = Payroll.objects.get(employee=emp, pay_cycle="monthly")
        self.assertEqual(parse_ranges(month.paid_ranges), [(D(2026, 1, 12), D(2026, 2, 1))])
        self.assertTrue(Payroll.objects.filter(employee=emp, period_start=D(2026, 1, 5), pay_cycle="weekly").exists())
        self.assert_never_paid_twice(emp)


# ─────────────────────────────────────────────────────────────────────────────
#  2. Moving a worker: confirm + reason, the facts, the transfer record
# ─────────────────────────────────────────────────────────────────────────────


class TransferTests(WorkflowTestCase):
    def setUp(self):
        super().setUp()
        self.w = _worker("TR1", cycle="weekly")
        _shifts(self.w, FIRST_DAY, D(2026, 3, 9))
        self.u = _worker("TR2", cycle=None)

    def test_assigning_a_worker_with_no_payroll_needs_no_reason_and_is_recorded(self):
        r = self.post(ASSIGN, {"employeeIds": [self.u.id], "cycle": "biweekly"})
        self.assertEqual(r.status_code, 200, r.content)
        move = ProductionCycleTransfer.objects.get(employee=self.u)
        self.assertEqual((move.from_cycle, move.to_cycle, move.paid_periods), (None, "biweekly", 0))
        self.assertIsNone(move.last_paid_through)
        self.assertEqual(r.json()["moves"][0]["toLabel"], "BiWeekly")

    def test_a_worker_already_paid_cannot_move_without_confirm_and_reason(self):
        self.gen(self.w, "weekly", (D(2026, 1, 5), D(2026, 1, 11)))
        self.gen(self.w, "weekly", (D(2026, 1, 12), D(2026, 1, 18)))
        Payroll.objects.filter(employee=self.w).update(payment_status=Payroll.PAYMENT_PAID)  # paid: FINAL
        for body in (
            {"employeeIds": [self.w.id], "cycle": "biweekly"},
            {"employeeIds": [self.w.id], "cycle": "biweekly", "confirm": True},
            {"employeeIds": [self.w.id], "cycle": "biweekly", "confirm": True, "reason": "   "},
            {"employeeIds": [self.w.id], "cycle": "biweekly", "reason": "no confirm"},
        ):
            r = self.post(ASSIGN, body)
            self.assertEqual(r.status_code, 409, body)
            facts = r.json()["employees"][0]
            self.assertEqual(r.json()["code"], "confirm_cycle_change")
            self.assertEqual((facts["paidThrough"], facts["oldCycle"]["periods"]), ("2026-01-18", 2))
            self.assertEqual(facts["oldCycle"]["net"], 7000.0)
            self.assertIn("up to 18 Jan 2026", facts["message"])
            self.assertIn("will not be paid again", facts["message"])
        self.w.refresh_from_db()
        self.assertEqual(self.w.production_pay_cycle, "weekly")
        self.assertFalse(ProductionCycleTransfer.objects.exists())

        self.move(self.w, "biweekly", reason="Shifted to the fortnightly line")
        move = ProductionCycleTransfer.objects.get(employee=self.w)
        self.assertEqual((move.from_cycle, move.to_cycle), ("weekly", "biweekly"))
        self.assertEqual((move.last_paid_through, move.pays_from), (D(2026, 1, 18), D(2026, 1, 19)))
        self.assertEqual((move.paid_periods, move.paid_net), (2, Decimal("7000.00")))
        self.assertEqual(move.reason, "Shifted to the fortnightly line")
        self.assertTrue(move.changed_by)

    def test_taking_a_paid_worker_off_the_cycle_needs_a_reason_too(self):
        self.gen(self.w, "weekly", (D(2026, 1, 5), D(2026, 1, 11)))
        self.assertEqual(self.post(ASSIGN, {"employeeIds": [self.w.id], "cycle": None}).status_code, 409)
        self.move(self.w, None, reason="Left the line")
        move = ProductionCycleTransfer.objects.get(employee=self.w)
        self.assertEqual((move.from_cycle, move.to_cycle, move.pays_from), ("weekly", None, None))

    def test_the_preview_says_what_was_paid_and_from_when_the_new_cycle_pays(self):
        self.gen(self.w, "weekly", (D(2026, 1, 5), D(2026, 1, 11)))
        body = self.get(f"{PREVIEW}?ids={self.w.id},{self.u.id}&cycle=biweekly").json()
        self.assertTrue(body["needsReason"])
        mine = next(e for e in body["employees"] if e["employeeId"] == self.w.id)
        self.assertTrue(mine["warn"] and mine["needsConfirmation"])
        self.assertEqual((mine["paidThrough"], mine["paysFrom"]), ("2026-01-11", "2026-01-12"))
        # a draft (only Generated): named as such, and what happens to it
        self.assertIn(
            "has 1 draft payslip under Weekly (generated, not finalized: 5 Jan – 11 Jan 2026; ₹3,500 net)",
            mine["message"],
        )
        self.assertIn("replaces it when it is generated", mine["message"])
        self.assertEqual((mine["finalPeriods"], mine["draftPeriods"]), (0, 1))
        self.assertIn("New Joiners", mine["message"])
        other = next(e for e in body["employees"] if e["employeeId"] == self.u.id)
        self.assertFalse(other["warn"])
        self.assertIsNone(other["message"])

    def test_the_list_shows_the_latest_move_and_the_history_endpoint_every_move(self):
        self.move(self.u, "weekly")
        self.move(self.u, "monthly")
        row = next(e for e in self.get("/api/employees/production").json()["employees"] if e["id"] == self.u.id)
        self.assertEqual(
            (row["lastMove"]["fromCycle"], row["lastMove"]["toCycle"], row["moveCount"]), ("weekly", "monthly", 2)
        )
        history = self.get(f"/api/employees/production/{self.u.id}/transfers").json()
        self.assertEqual([m["toCycle"] for m in history["moves"]], ["monthly", "weekly"])

    def test_a_branch_login_cannot_read_another_branchs_transfers(self):
        mine = Branch.objects.create(name="Mine", code="MN")
        role = Role.objects.create(name="Branch Emp", permissions={"employees": "edit"})
        branch_hr = _hr("wf_branch", super_admin=False, role=role, branch=mine)
        self.assertEqual(self.get(f"/api/employees/production/{self.u.id}/transfers", branch_hr).status_code, 404)


# ─────────────────────────────────────────────────────────────────────────────
#  3. New Joiners: parked until added
# ─────────────────────────────────────────────────────────────────────────────

WEEK3 = (D(2026, 1, 19), D(2026, 1, 25))
WEEK4 = (D(2026, 1, 26), D(2026, 2, 1))


class NewJoinerTests(WorkflowTestCase):
    def setUp(self):
        super().setUp()
        self.old = _worker("NJ1", cycle="weekly", join_date="2025-01-01")
        self.new = _worker("NJ2", cycle="weekly", join_date="2026-01-21")
        for emp in (self.old, self.new):
            _shifts(emp, FIRST_DAY, D(2026, 3, 9))

    def run_week(self, period=WEEK3):
        r = self.post(GEN, period_body("weekly", period))
        self.assertEqual(r.status_code, 201, r.content)
        return r.json()

    def codes(self, url):
        return sorted(r["employeeCode"] for r in self.get(url).json())

    def test_a_new_joiner_is_calculated_but_kept_out_until_added(self):
        body = self.run_week()
        self.assertEqual((body["generated"], body["parked"]), (2, 1))
        self.assertEqual([j["employeeCode"] for j in body["newJoinerDetails"]], ["NJ2"])
        row = Payroll.objects.get(employee=self.new, period_start=WEEK3[0])
        self.assertTrue(row.new_joiner_parked)
        self.assertEqual(row.parked_reason, Payroll.PARKED_NEW_JOINER)
        listed = f"{LIST}?{query('weekly', WEEK3)}"
        self.assertEqual(self.codes(listed), ["NJ1"])  # out of the records, totals and bank file
        self.assertEqual(self.codes(listed + "&includeParked=1"), ["NJ1", "NJ2"])
        statement = self.get(f"/api/payroll/production/salary-statement?{query('weekly', WEEK3)}").json()
        self.assertEqual(statement["counts"]["employees"], 1)  # and off the statement
        waiting = self.get(f"{NEW_JOINERS}?{query('weekly', WEEK3)}").json()
        self.assertEqual([w["employeeCode"] for w in waiting["waiting"]], ["NJ2"])
        self.assertEqual(waiting["waiting"][0]["joinedOn"], "2026-01-21")
        self.assertEqual(waiting["waiting"][0]["days"]["eligibleDays"], 7)

        # Payroll Done is refused while anyone is parked
        refused = self.finalize("weekly", WEEK3)
        self.assertEqual(refused.status_code, 409)
        self.assertIn("New Joiners", refused.json()["error"])

        r = self.post(f"{NEW_JOINERS}/add", {"payrollIds": [row.pk]})
        self.assertEqual((r.status_code, r.json()["added"]), (200, 1))
        self.assertEqual(self.codes(listed), ["NJ1", "NJ2"])
        # added survives regeneration
        self.gen(self.new, "weekly", WEEK3, regenerate=True)
        row.refresh_from_db()
        self.assertFalse(row.new_joiner_parked)
        self.assertIsNotNone(row.added_to_payroll_at)
        self.assertEqual(self.finalize("weekly", WEEK3).status_code, 201)

    def test_add_all_and_the_next_period_is_not_parked(self):
        self.run_week()
        r = self.post(f"{NEW_JOINERS}/add", {**period_body("weekly", WEEK3), "all": True})
        self.assertEqual(r.json()["added"], 1)
        self.run_week(WEEK4)
        self.assertFalse(Payroll.objects.get(employee=self.new, period_start=WEEK4[0]).new_joiner_parked)

    def test_a_worker_who_moved_here_is_parked_in_their_first_period_only(self):
        mover = _worker("NJ3", cycle="monthly", join_date="2024-01-01")
        _shifts(mover, FIRST_DAY, D(2026, 3, 9))
        self.gen(mover, "monthly", (D(2026, 1, 5), D(2026, 2, 1)))
        self.move(mover, "weekly")
        status = self.get(
            f"/api/payroll/production/period-status?{query('weekly', (D(2026, 2, 2), D(2026, 2, 8)))}"
        ).json()
        row = next(e for e in status["employees"] if e["employeeCode"] == "NJ3")
        self.assertEqual((row["movedIn"]["cameFrom"], row["movedIn"]["toCycle"]), ("monthly", "weekly"))
        check = self.get(f"/api/payroll/production/skip-check?{query('weekly', (D(2026, 2, 2), D(2026, 2, 8)))}").json()
        self.assertEqual([m["employeeCode"] for m in check["movedIn"]], ["NJ3"])
        body = self.gen(mover, "weekly", (D(2026, 2, 2), D(2026, 2, 8)))
        self.assertEqual(body["movedInDetails"][0]["move"]["cameFromLabel"], "Monthly")
        self.assertEqual(body["movedInDetails"][0]["coverage"]["payDays"], 7)
        first = Payroll.objects.get(employee=mover, period_start=D(2026, 2, 2))
        self.assertEqual((first.new_joiner_parked, first.parked_reason), (True, Payroll.PARKED_TRANSFER))
        waiting = self.get(f"{NEW_JOINERS}?{query('weekly', (D(2026, 2, 2), D(2026, 2, 8)))}").json()["waiting"]
        self.assertEqual(waiting[0]["move"]["fromLabel"], "Monthly")
        self.gen(mover, "weekly", (D(2026, 2, 9), D(2026, 2, 15)))
        self.assertFalse(Payroll.objects.get(employee=mover, period_start=D(2026, 2, 9)).new_joiner_parked)
        # regenerating the first period keeps it parked (it is still their first period after the move)
        self.gen(mover, "weekly", (D(2026, 2, 2), D(2026, 2, 8)), regenerate=True)
        first.refresh_from_db()
        self.assertTrue(first.new_joiner_parked)

    def test_moved_in_days_already_paid_are_excluded_and_reported(self):
        mover = _worker("NJ4", cycle="weekly", join_date="2024-01-01")
        _shifts(mover, FIRST_DAY, D(2026, 3, 9))
        self.gen(mover, "weekly", (D(2026, 1, 5), D(2026, 1, 11)))
        Payroll.objects.filter(employee=mover).update(payment_status=Payroll.PAYMENT_PAID)  # paid: FINAL
        self.move(mover, "biweekly")
        self.gen(mover, "biweekly", (D(2026, 1, 5), D(2026, 1, 18)))
        waiting = self.get(f"{NEW_JOINERS}?{query('biweekly', (D(2026, 1, 5), D(2026, 1, 18)))}").json()["waiting"]
        days = waiting[0]["days"]
        self.assertEqual((days["periodDays"], days["eligibleDays"], days["excludedDays"]), (14, 7, 7))


# ─────────────────────────────────────────────────────────────────────────────
#  4. The period workflow: ended, Payroll Done, Mark as Paid, next due
# ─────────────────────────────────────────────────────────────────────────────

LAST = (D(2026, 3, 2), D(2026, 3, 8))


class PeriodWorkflowTests(WorkflowTestCase):
    def setUp(self):
        super().setUp()
        self.a = _worker("PW1", cycle="weekly")
        self.b = _worker("PW2", cycle="weekly")
        for emp in (self.a, self.b):
            _shifts(emp, FIRST_DAY, D(2026, 3, 9))

    def today(self, day):
        for target in ("api.production_period.ist_today", "api.production_payroll_views.ist_today",
                       "api.production_period_workflow.ist_today"):  # fmt: skip
            patch(target, return_value=day).start()

    def test_a_period_is_generated_only_after_its_last_day(self):
        self.today(D(2026, 3, 8))
        r = self.post(GEN, period_body("weekly", LAST))
        self.assertEqual(r.status_code, 400)
        self.assertIn("has not ended yet", r.json()["error"])
        self.assertIn("9 Mar 2026", r.json()["error"])
        self.assertFalse(self.get(f"{WORKFLOW}?{query('weekly', LAST)}").json()["periodEnded"])
        self.today(D(2026, 3, 9))
        self.assertEqual(self.post(GEN, period_body("weekly", LAST)).status_code, 201)

    def test_the_first_run_never_offers_a_period_ending_today(self):
        self.assertEqual(
            next_cycle_period(PayrollSettings.get(), "weekly", D(2026, 3, 8)), (D(2026, 2, 23), D(2026, 3, 1))
        )

    def test_payroll_done_locks_the_period_for_good(self):
        self.post(GEN, period_body("weekly", LAST))
        status = self.get(f"{WORKFLOW}?{query('weekly', LAST)}").json()
        self.assertEqual((status["state"], status["can"]["finalize"]), ("generated", True))
        r = self.finalize("weekly", LAST)
        self.assertEqual(r.status_code, 201, r.content)
        self.assertEqual((r.json()["state"], r.json()["locked"]), ("finalized", True))
        self.assertEqual(self.finalize("weekly", LAST).status_code, 409)  # no second time, no reopen
        row = Payroll.objects.filter(employee=self.a, period_start=LAST[0]).first()
        for call in (
            lambda: self.post(GEN, period_body("weekly", LAST, regenerate=True)),
            lambda: self.get(f"/api/payroll/production/skip-check?{query('weekly', LAST)}"),
            lambda: self.patch_(f"/api/payroll/production/{row.pk}", {"status": "paid"}),
            lambda: self.patch_(f"/api/payroll/production/{row.pk}", {"bonus": 100}),
            lambda: self.patch_(f"/api/payroll/{row.pk}", {"status": "paid"}),
        ):
            response = call()
            self.assertEqual(response.status_code, 409, response.content)
        row.refresh_from_db()
        self.assertEqual((row.status, row.bonus), ("pending", Decimal("0")))

    def test_mark_as_paid_records_the_day_and_pays_everyone_in_the_payroll(self):
        self.post(GEN, period_body("weekly", LAST))
        self.assertEqual(self.post(PAID, {**period_body("weekly", LAST), "paidOn": "2026-03-09"}).status_code, 409)
        self.finalize("weekly", LAST)
        for bad in ("2026-03-11", "2026-03-01", "soon", ""):
            r = self.post(PAID, {**period_body("weekly", LAST), "paidOn": bad})
            self.assertEqual(r.status_code, 400, bad)
        r = self.post(PAID, {**period_body("weekly", LAST), "paidOn": "2026-03-09"})
        self.assertEqual(r.status_code, 200, r.content)
        body = r.json()
        self.assertEqual((body["state"], body["paidOn"], body["workersPaid"]), ("paid", "2026-03-09", 2))
        rows = Payroll.objects.filter(period_start=LAST[0])
        self.assertEqual(set(rows.values_list("payment_status", flat=True)), {"paid"})
        self.assertEqual(set(rows.values_list("status", flat=True)), {"pending"})  # Cleared stays HR's own check
        self.assertEqual(self.post(PAID, {**period_body("weekly", LAST), "paidOn": "2026-03-09"}).status_code, 409)

    def test_next_due_follows_payroll_done(self):
        week1 = (D(2026, 2, 23), D(2026, 3, 1))
        ps = PayrollSettings.get()
        self.post(GEN, period_body("weekly", week1))
        self.assertEqual(next_cycle_period(ps, "weekly", TODAY), week1)  # still open: still due
        self.finalize("weekly", week1)
        self.assertEqual(next_cycle_period(ps, "weekly", TODAY), LAST)
        periods = self.get("/api/payroll/production/periods?cycle=weekly&back=3").json()["periods"]
        states = {p["periodStart"]: p["state"] for p in periods}
        self.assertEqual((states["2026-02-23"], states["2026-03-02"]), ("finalized", "not_generated"))
        self.assertEqual(next(p for p in periods if p["isNext"])["periodStart"], "2026-03-02")

    def test_a_unit_login_and_a_role_without_the_key_cannot_finalize_or_pay(self):
        self.post(GEN, period_body("weekly", LAST))
        unit = Branch.objects.create(name="Unit", code="U1")
        role = Role.objects.create(name="Unit pay", permissions={"production_payroll": "edit"})
        unit_hr = _hr("wf_unit", super_admin=False, role=role, branch=unit)
        r = self.finalize("weekly", LAST, unit_hr)
        self.assertEqual(r.status_code, 403)
        no_key = Role.objects.create(
            name="No finalize", permissions={"production_payroll": "edit", "production_payroll.finalize": "hidden"}
        )
        self.assertEqual(
            self.finalize("weekly", LAST, _hr("wf_nokey", super_admin=False, role=no_key)).status_code, 403
        )
        viewer = Role.objects.create(name="Pay viewer", permissions={"production_payroll": "view"})
        viewer_hr = _hr("wf_viewer", super_admin=False, role=viewer)
        self.assertEqual(self.finalize("weekly", LAST, viewer_hr).status_code, 403)
        self.assertEqual(self.get(f"{WORKFLOW}?{query('weekly', LAST)}", viewer_hr).status_code, 200)
        self.assertFalse(self.get(f"{WORKFLOW}?{query('weekly', LAST)}", viewer_hr).json()["can"]["finalize"])
        payer = Role.objects.create(
            name="Payer", permissions={"production_payroll": "edit", "production_payroll.mark_paid": "hidden"}
        )
        self.finalize("weekly", LAST)
        r = self.post(
            PAID,
            {**period_body("weekly", LAST), "paidOn": "2026-03-09"},
            _hr("wf_payer", super_admin=False, role=payer),
        )
        self.assertEqual(r.status_code, 403)


# ─────────────────────────────────────────────────────────────────────────────
#  5. Production rows follow production_payroll; adjusting is safe
# ─────────────────────────────────────────────────────────────────────────────


class ProductionRightsTests(WorkflowTestCase):
    def setUp(self):
        super().setUp()
        self.w = _worker("PR1", cycle="weekly")
        _shifts(self.w, FIRST_DAY, D(2026, 3, 9))
        self.post(GEN, period_body("weekly", LAST))
        self.row = Payroll.objects.get(employee=self.w, period_start=LAST[0])

    def role(self, name, permissions):
        return _hr(name, super_admin=False, role=Role.objects.create(name=name, permissions=permissions))

    def test_a_staff_payroll_role_cannot_touch_production_rows(self):
        staff_only = self.role("staffpay", {"payroll": "edit", "production_payroll": "hidden"})
        self.assertEqual(self.patch_(f"/api/payroll/{self.row.pk}", {"status": "paid"}, staff_only).status_code, 403)
        self.assertEqual(self.get(f"/api/payroll/{self.row.pk}/breakdown", staff_only).status_code, 403)
        self.assertEqual(
            self.patch_(f"/api/payroll/production/{self.row.pk}", {"status": "paid"}, staff_only).status_code, 403
        )

    def test_a_production_only_role_can_clear_read_and_follow_the_run(self):
        prod_only = self.role("prodpay", {"production_payroll": "edit", "payroll": "hidden"})
        r = self.patch_(f"/api/payroll/production/{self.row.pk}", {"status": "paid"}, prod_only)
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(r.json()["status"], "paid")
        self.assertEqual(self.get(f"/api/payroll/production/{self.row.pk}/breakdown", prod_only).status_code, 200)
        self.assertEqual(self.get("/api/payroll/production/generate-progress", prod_only).status_code, 200)
        self.assertEqual(self.get("/api/payroll/generate-progress", prod_only).status_code, 403)

    def test_adjust_needs_its_own_key(self):
        no_adjust = self.role("noadj", {"production_payroll": "edit", "production_payroll.adjust": "hidden"})
        self.assertEqual(
            self.patch_(f"/api/payroll/production/{self.row.pk}", {"bonus": 100}, no_adjust).status_code, 403
        )
        self.assertEqual(
            self.patch_(f"/api/payroll/production/{self.row.pk}", {"status": "paid"}, no_adjust).status_code, 200
        )

    def test_deductions_cannot_go_below_what_statutory_and_advance_took_and_the_payslip_follows(self):
        slip = SalarySlip.objects.get(employee=self.w, period_start=LAST[0])
        SalarySlip.objects.filter(pk=slip.pk).update(pf_deduction=Decimal("120.00"), advance_deduction=Decimal("80.00"))
        r = self.patch_(f"/api/payroll/production/{self.row.pk}", {"deductions": 150})
        self.assertEqual(r.status_code, 400)
        self.assertIn("cannot be less than Rs 200.00", r.json()["error"])
        for bad in (-5, "abc", 1.234):
            self.assertEqual(
                self.patch_(f"/api/payroll/production/{self.row.pk}", {"deductions": bad}).status_code, 400
            )
        Payroll.objects.filter(pk=self.row.pk).update(bonus=Decimal("40.00"))  # set before the Excess tab (2026-11-20)
        r = self.patch_(f"/api/payroll/production/{self.row.pk}", {"deductions": 260, "bonus": 40})
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(r.json()["finalSalary"], 3500 + 40 - 260)
        slip.refresh_from_db()
        self.assertEqual(
            (slip.bonuses, slip.total_deductions, slip.other_deductions, slip.net_salary),
            (Decimal("40.00"), Decimal("260.00"), Decimal("60.00"), Decimal("3280.00")),
        )

    def test_a_salary_marked_paid_is_never_changed_or_worked_out_again(self):
        Payroll.objects.filter(pk=self.row.pk).update(payment_status=Payroll.PAYMENT_PAID)
        self.assertEqual(self.patch_(f"/api/payroll/production/{self.row.pk}", {"bonus": 10}).status_code, 409)
        body = self.post(GEN, period_body("weekly", LAST, employeeIds=[self.w.id], regenerate=True)).json()
        self.assertEqual(body["generated"], 0)
        self.assertIn("already marked Paid", body["skippedDetails"][0]["reason"])


# ─────────────────────────────────────────────────────────────────────────────
#  6. Moved out
# ─────────────────────────────────────────────────────────────────────────────


class MovedOutTests(WorkflowTestCase):
    def test_a_worker_who_left_stays_listed_for_two_generations_then_under_show_older(self):
        stayer, mover = _worker("MO1", cycle="weekly"), _worker("MO2", cycle="weekly")
        for emp in (stayer, mover):
            _shifts(emp, FIRST_DAY, D(2026, 3, 9))
        self.gen(mover, "weekly", (D(2026, 1, 5), D(2026, 1, 11)))
        self.gen(mover, "weekly", (D(2026, 1, 12), D(2026, 1, 18)))
        self.move(mover, "monthly", reason="Moved to the monthly team")
        body = self.get(f"{MOVED_OUT}?cycle=weekly").json()
        self.assertEqual(len(body["moves"]), 1)
        out = body["moves"][0]
        self.assertEqual(
            (out["toCycle"], out["reason"], out["paidPeriods"], out["paidNet"]),
            ("monthly", "Moved to the monthly team", 2, 7000.0),
        )
        self.assertEqual(out["lastPayroll"]["periodEnd"], "2026-01-18")
        self.assertEqual(self.get(f"{MOVED_OUT}?cycle=monthly").json()["moves"], [])
        # two weekly generations after the move: hidden, still there under "show older"
        self.gen(stayer, "weekly", (D(2026, 1, 19), D(2026, 1, 25)))
        self.assertEqual(len(self.get(f"{MOVED_OUT}?cycle=weekly").json()["moves"]), 1)
        self.gen(stayer, "weekly", (D(2026, 1, 26), D(2026, 2, 1)))
        hidden = self.get(f"{MOVED_OUT}?cycle=weekly").json()
        self.assertEqual((hidden["moves"], hidden["olderCount"]), ([], 1))
        older = self.get(f"{MOVED_OUT}?cycle=weekly&older=1").json()["moves"]
        self.assertTrue(older[0]["hidden"])


# ─────────────────────────────────────────────────────────────────────────────
#  7. Migration 0151: production Cleared before the workflow counts as Paid
# ─────────────────────────────────────────────────────────────────────────────


class BackfillTests(WorkflowTestCase):
    def test_old_cleared_rows_are_paid_and_fully_cleared_periods_closed(self):
        a, b = _worker("BF1", cycle="weekly"), _worker("BF2", cycle="weekly")
        staff = Employee.objects.create(employee_code="BF3", first_name="S", last_name="T", employment_type="staff")
        done = (D(2026, 2, 2), D(2026, 2, 8))
        half = (D(2026, 2, 9), D(2026, 2, 15))
        for emp in (a, b):
            _row(emp, *done, cycle="weekly", status="paid")
        _row(a, *half, cycle="weekly", status="paid")
        _row(b, *half, cycle=None, status="pending")
        staff_row = Payroll.objects.create(
            employee=staff, salary_mode="monthly", month=2, year=2026, base_salary=1, gross_salary=1, final_salary=1,
            status="paid",
        )  # fmt: skip
        moment = datetime(2026, 2, 10, 18, 30, tzinfo=FACTORY_TZ)
        Payroll.objects.filter(period_start__isnull=False).update(updated_at=moment)

        migration = import_module("api.migrations.0151_production_cleared_paid")
        migration.backfill(django_apps, None)
        migration.backfill(django_apps, None)  # idempotent

        paid = Payroll.objects.filter(payment_status="paid")
        self.assertEqual(paid.count(), 3)  # the three Cleared production rows, never the staff row nor a pending one
        self.assertEqual(set(paid.values_list("payment_paid_by", flat=True)), {"Cleared before the period workflow"})
        self.assertEqual(set(paid.values_list("payment_paid_at", flat=True)), {moment})
        staff_row.refresh_from_db()
        self.assertEqual(staff_row.payment_status, "not_paid")
        close = ProductionPeriodClose.objects.get()
        self.assertEqual((close.cycle, close.period_start, close.paid_on), ("weekly", done[0], D(2026, 2, 10)))
        self.assertEqual((close.finalized_at, close.paid_at), (moment, moment))
        self.assertEqual(wf.state_of(close, 2), "paid")
        self.assertIsNone(wf.period_close("weekly", *half))  # BF2's row there is not Cleared: the period stays open
        self.assertTrue(timezone.is_aware(close.paid_at))


# ─────────────────────────────────────────────────────────────────────────────
#  8. A Generated payslip is a draft (owner 2026-11-16): replaced by the period generated over it
# ─────────────────────────────────────────────────────────────────────────────

MON_W1 = (D(2026, 2, 2), D(2026, 2, 8))
MON_W2 = (D(2026, 2, 9), D(2026, 2, 15))
THU_W = (D(2026, 2, 5), D(2026, 2, 11))
THU_BEFORE = (D(2026, 1, 29), D(2026, 2, 4))
THU_AFTER = (D(2026, 2, 12), D(2026, 2, 18))


def thursday_weeks():
    """The owner changed the Weekly week start to Thursday: the Monday-grid payslips no longer line up."""
    ps = PayrollSettings.get()
    cycles = dict(ps.prod_cycles or {})
    cycles["weekly"] = {"weekStart": "thursday"}
    _settings(prod_cycles=cycles)


class DraftReplaceTests(WorkflowTestCase):
    def setUp(self):
        super().setUp()
        self.a = _worker("DR1", cycle="weekly")
        self.b = _worker("DR2", cycle="weekly")
        for emp in (self.a, self.b):
            _shifts(emp, FIRST_DAY, D(2026, 3, 9))
        # February's advance instalment of A: the Monday week 2-8 Feb (ends in February) deducts it
        self.adv = Advance.objects.create(
            employee=self.a,
            advance_type="general",
            amount=Decimal("1000"),
            status="approved",
            total_repaid=Decimal("0"),
            outstanding=Decimal("1000"),
        )
        self.instalment = AdvanceRepayment.objects.create(advance=self.adv, month=2, year=2026, amount=Decimal("1000"))
        for week in (MON_W1, MON_W2):
            self.post(GEN, period_body("weekly", week))
        self.assertEqual(Payroll.objects.filter(period_start=MON_W1[0]).count(), 2)
        self.instalment.refresh_from_db()
        self.assertTrue(self.instalment.is_processed)
        thursday_weeks()

    def status(self, period=THU_W):
        return self.get(f"/api/payroll/production/period-status?{query('weekly', period)}").json()

    def test_the_new_grid_lists_the_drafts_in_the_way_and_never_blocks_on_them(self):
        body = self.status()
        row = next(e for e in body["employees"] if e["employeeCode"] == "DR1")
        self.assertIsNone(row["blockedReason"])
        self.assertEqual([d["periodLabel"] for d in row["drafts"]], ["2 Feb – 8 Feb 2026", "9 Feb – 15 Feb 2026"])
        self.assertEqual((body["counts"]["drafts"], body["counts"]["draftRows"], body["counts"]["ready"]), (2, 4, 2))
        # without the flag nobody is worked out and nothing is deleted
        refused = self.post(GEN, period_body("weekly", THU_W)).json()
        self.assertEqual((refused["generated"], refused["skipped"]), (0, 2))
        self.assertIn("Replace the overlapping draft payslips", refused["skippedDetails"][0]["reason"])
        self.assertEqual(Payroll.objects.count(), 4)
        dry = self.get(f"/api/payroll/production/skip-check?{query('weekly', THU_W)}&replaceDrafts=1").json()
        self.assertEqual(len(dry["drafts"]), 2)
        self.assertEqual(Payroll.objects.count(), 4)  # a dry run replaces nothing

    def test_generating_the_new_week_replaces_the_drafts_and_the_advance_is_recovered_once(self):
        body = self.post(GEN, period_body("weekly", THU_W, replaceDrafts=True)).json()
        self.assertEqual((body["generated"], body["replaced"]), (2, 4))
        mine = next(r for r in body["replacedDetails"] if r["employeeCode"] == "DR1")
        self.assertEqual(
            mine["waiting"], [{"from": "2026-02-02", "to": "2026-02-04"}, {"from": "2026-02-12", "to": "2026-02-15"}]
        )
        self.assertFalse(Payroll.objects.filter(period_start__in=[MON_W1[0], MON_W2[0]]).exists())
        self.assertFalse(SalarySlip.objects.filter(period_start__in=[MON_W1[0], MON_W2[0]]).exists())
        new = Payroll.objects.get(employee=self.a, period_start=THU_W[0])
        self.assertEqual((new.gross_salary, new.deductions), (RATE * 7, Decimal("1000.00")))  # re-took the instalment
        self.adv.refresh_from_db()
        self.assertEqual(self.adv.total_repaid, Decimal("1000.00"))  # released, then recovered: once
        log = AuditLog.objects.filter(module="payroll", action="delete").latest("id")
        self.assertIn("Replaced 4 draft production payslip(s)", log.record_description)
        self.assertEqual(len(log.old_values["replacedDrafts"]), 2)
        # the days outside the week wait for their own weeks; generating them pays them, never twice, never the advance
        self.post(GEN, period_body("weekly", THU_BEFORE, replaceDrafts=True))
        self.post(GEN, period_body("weekly", THU_AFTER, replaceDrafts=True))
        seen = self.assert_never_paid_twice(self.a)
        self.assertEqual((min(seen), max(seen)), (THU_BEFORE[0], THU_AFTER[1]))
        self.assertEqual(sum(p.deductions for p in Payroll.objects.filter(employee=self.a)), Decimal("1000.00"))
        self.adv.refresh_from_db()
        self.assertEqual(self.adv.total_repaid, Decimal("1000.00"))

    def test_final_payslips_are_never_replaced_and_their_days_stay_excluded(self):
        Payroll.objects.filter(employee=self.a, period_start=MON_W1[0]).update(payment_status=Payroll.PAYMENT_PAID)
        ProductionPeriodClose.objects.create(
            cycle="weekly", period_start=MON_W2[0], period_end=MON_W2[1], finalized_at=timezone.now()
        )
        body = self.post(GEN, period_body("weekly", THU_W, replaceDrafts=True)).json()
        # A: 2-8 Feb is paid, 9-15 Feb is finalized: nothing left to pay in 5-11 Feb; B: 9-15 Feb finalized too
        reasons = {d["employeeCode"]: d["reason"] for d in body["skippedDetails"]}
        self.assertIn("Already paid", reasons["DR1"])
        b_row = Payroll.objects.get(employee=self.b, period_start=THU_W[0])
        self.assertEqual(parse_ranges(b_row.paid_ranges), [(D(2026, 2, 5), D(2026, 2, 8))])
        self.assertEqual(Payroll.objects.filter(employee=self.a).count(), 2)  # both final rows kept
        self.assertTrue(Payroll.objects.filter(employee=self.b, period_start=MON_W2[0]).exists())
        for emp in (self.a, self.b):
            self.assert_never_paid_twice(emp, no_gap=False)

    def test_a_move_replaces_the_drafts_left_on_the_old_cycle(self):
        mover = _worker("DR3", cycle="biweekly")
        _shifts(mover, FIRST_DAY, D(2026, 3, 9))
        self.gen(mover, "biweekly", (D(2026, 2, 2), D(2026, 2, 15)))  # a draft on BiWeekly
        self.move(mover, "weekly")
        status = self.status()
        row = next(e for e in status["employees"] if e["employeeCode"] == "DR3")
        self.assertEqual([d["cycle"] for d in row["drafts"]], ["biweekly"])
        self.gen(mover, "weekly", THU_W, replace=True)
        self.assertFalse(Payroll.objects.filter(employee=mover, pay_cycle="biweekly").exists())
        first = Payroll.objects.get(employee=mover, period_start=THU_W[0])
        self.assertTrue(first.new_joiner_parked)  # their first period after the move: New Joiners
        self.assertEqual(first.gross_salary, RATE * 7)
        self.assert_never_paid_twice(mover, no_gap=False)


class NextDueAfterWeekStartChangeTests(WorkflowTestCase):
    def test_next_due_is_the_current_week_holding_the_old_drafts_first_day(self):
        w = _worker("ND1", cycle="weekly")
        _row(w, D(2026, 2, 23), D(2026, 3, 1), cycle="weekly")  # the latest Monday week, a draft
        thursday_weeks()
        ps = PayrollSettings.get()
        self.assertEqual(next_cycle_period(ps, "weekly", TODAY), (D(2026, 2, 19), D(2026, 2, 25)))

    def test_never_a_week_that_has_not_ended_while_an_ended_one_waits(self):
        w = _worker("ND2", cycle="weekly")
        _row(w, D(2026, 3, 2), D(2026, 3, 8), cycle="weekly")
        ProductionPeriodClose.objects.create(
            cycle="weekly", period_start=D(2026, 3, 2), period_end=D(2026, 3, 8), finalized_at=timezone.now()
        )
        thursday_weeks()
        ps = PayrollSettings.get()
        # after the finalized Monday week comes 5-11 Mar (not ended on 10 Mar): 26 Feb - 4 Mar has ended and waits
        self.assertEqual(next_cycle_period(ps, "weekly", TODAY), (D(2026, 2, 26), D(2026, 3, 4)))
        ProductionPeriodClose.objects.create(
            cycle="weekly", period_start=D(2026, 2, 26), period_end=D(2026, 3, 4), finalized_at=timezone.now()
        )
        # nothing ended is waiting any more: the week after
        self.assertEqual(next_cycle_period(ps, "weekly", TODAY), (D(2026, 3, 5), D(2026, 3, 11)))

    def test_the_periods_of_a_date_range_in_one_call(self):
        body = self.get("/api/payroll/production/periods?cycle=weekly&from=2026-02-01&to=2026-02-28").json()
        starts = [p["periodStart"] for p in body["periods"]]
        self.assertEqual(starts, ["2026-02-23", "2026-02-16", "2026-02-09", "2026-02-02", "2026-01-26"])
        self.assertEqual(self.get("/api/payroll/production/periods?cycle=weekly&from=2026-02-01").status_code, 400)


# ─────────────────────────────────────────────────────────────────────────────
#  9. Unlock a finalized period / month (owner 2026-11-16)
# ─────────────────────────────────────────────────────────────────────────────

UNLOCK = "/api/payroll/production/period-unlock"


class UnlockTests(WorkflowTestCase):
    def setUp(self):
        super().setUp()
        self.w = _worker("UL1", cycle="weekly")
        _shifts(self.w, FIRST_DAY, D(2026, 3, 9))
        self.post(GEN, period_body("weekly", LAST))
        self.assertEqual(self.finalize("weekly", LAST).status_code, 201)

    def test_a_finalized_unpaid_period_unlocks_with_a_reason_and_can_be_finalized_again(self):
        status = self.get(f"{WORKFLOW}?{query('weekly', LAST)}").json()
        self.assertTrue(status["can"]["unlock"])
        self.assertIsNone(status["unlockBlocked"])
        self.assertEqual(self.post(UNLOCK, period_body("weekly", LAST)).status_code, 400)  # no reason
        self.assertEqual(self.post(UNLOCK, period_body("weekly", LAST, reason="  x ")).status_code, 400)
        r = self.post(UNLOCK, period_body("weekly", LAST, reason="Attendance corrected for two workers"))
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual((r.json()["state"], r.json()["locked"]), ("generated", False))
        log = AuditLog.objects.filter(module="payroll", record_description__startswith="Unlocked").latest("id")
        self.assertIn("Attendance corrected for two workers", log.record_description)
        self.assertEqual(log.old_values["reason"], "Attendance corrected for two workers")
        self.assertTrue(log.old_values["finalizedAt"])
        # Generated again: it can be worked out again, then finalized again
        again = self.post(GEN, period_body("weekly", LAST, regenerate=True))
        self.assertEqual((again.status_code, again.json()["generated"]), (201, 1))
        self.assertEqual(self.finalize("weekly", LAST).status_code, 201)
        self.assertEqual(self.post(UNLOCK, period_body("weekly", LAST)).status_code, 400)

    def test_a_paid_period_is_locked_for_good(self):
        self.assertEqual(self.post(PAID, {**period_body("weekly", LAST), "paidOn": "2026-03-09"}).status_code, 200)
        status = self.get(f"{WORKFLOW}?{query('weekly', LAST)}").json()
        self.assertFalse(status["can"]["unlock"])
        self.assertIn("locked for good", status["unlockBlocked"])
        r = self.post(UNLOCK, period_body("weekly", LAST, reason="Change of mind"))
        self.assertEqual(r.status_code, 409)
        self.assertIn("Paid: locked for good", r.json()["error"])

    def test_a_period_with_a_salary_marked_paid_cannot_be_unlocked(self):
        Payroll.objects.filter(employee=self.w, period_start=LAST[0]).update(payment_status=Payroll.PAYMENT_PAID)
        self.assertEqual(self.post(UNLOCK, period_body("weekly", LAST, reason="Recheck")).status_code, 409)

    def test_only_payroll_dones_rights_may_unlock(self):
        unit = Branch.objects.create(name="Unit", code="UU")
        role = Role.objects.create(name="Unit pay unlock", permissions={"production_payroll": "edit"})
        unit_hr = _hr("ul_unit", super_admin=False, role=role, branch=unit)
        self.assertEqual(self.post(UNLOCK, period_body("weekly", LAST, reason="Recheck"), unit_hr).status_code, 403)
        no_key = Role.objects.create(
            name="No unlock", permissions={"production_payroll": "edit", "production_payroll.finalize": "hidden"}
        )
        keyless = _hr("ul_nokey", super_admin=False, role=no_key)
        self.assertEqual(self.post(UNLOCK, period_body("weekly", LAST, reason="Recheck"), keyless).status_code, 403)
        self.assertTrue(wf.is_locked("weekly", *LAST))

    def test_a_period_that_is_not_finalized_has_nothing_to_unlock(self):
        open_week = (D(2026, 2, 23), D(2026, 3, 1))
        self.post(GEN, period_body("weekly", open_week))
        self.assertEqual(self.post(UNLOCK, period_body("weekly", open_week, reason="Recheck")).status_code, 409)


STAFF_UNLOCK = "/api/payroll/month-unlock"


class StaffUnlockTests(WorkflowTestCase):
    def setUp(self):
        super().setUp()
        self.s = Employee.objects.create(
            employee_code="SU1", first_name="Staff", last_name="One", employment_type="staff", status="active"
        )
        self.row = Payroll.objects.create(
            employee=self.s, salary_mode="monthly", month=2, year=2026, base_salary=1, gross_salary=1, final_salary=1
        )
        PayrollMonthClose.objects.create(month=2, year=2026, finalized_at=timezone.now(), finalized_by="HR")

    def test_a_finalized_month_with_nothing_paid_unlocks_with_a_reason(self):
        status = self.get("/api/payroll/month-status?month=2&year=2026").json()
        self.assertTrue(status["can"]["unlock"])
        self.assertEqual(self.post(STAFF_UNLOCK, {"month": 2, "year": 2026}).status_code, 400)
        r = self.post(STAFF_UNLOCK, {"month": 2, "year": 2026, "reason": "Late punches corrected"})
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual((r.json()["state"], r.json()["locked"]), ("open", False))
        self.assertFalse(PayrollMonthClose.objects.exists())
        log = AuditLog.objects.filter(module="payroll", record_description__startswith="Unlocked").latest("id")
        self.assertIn("Late punches corrected", log.record_description)

    def test_a_month_with_anything_paid_stays_locked(self):
        # a held / new employee released and paid separately counts as paid
        Payroll.objects.filter(pk=self.row.pk).update(payment_status=Payroll.PAYMENT_PAID, released_from="hold")
        r = self.post(STAFF_UNLOCK, {"month": 2, "year": 2026, "reason": "Recheck"})
        self.assertEqual(r.status_code, 409)
        self.assertIn("locked for good", r.json()["error"])
        status = self.get("/api/payroll/month-status?month=2&year=2026").json()
        self.assertFalse(status["can"]["unlock"])
        PayrollMonthClose.objects.update(paid_at=timezone.now(), paid_by="HR")
        Payroll.objects.filter(pk=self.row.pk).update(payment_status=Payroll.PAYMENT_NOT_PAID, released_from=None)
        self.assertEqual(self.post(STAFF_UNLOCK, {"month": 2, "year": 2026, "reason": "Recheck"}).status_code, 409)

    def test_staff_unlock_needs_payroll_dones_rights(self):
        unit = Branch.objects.create(name="Unit S", code="US")
        role = Role.objects.create(name="Unit staff pay", permissions={"payroll": "edit"})
        unit_hr = _hr("su_unit", super_admin=False, role=role, branch=unit)
        self.assertEqual(
            self.post(STAFF_UNLOCK, {"month": 2, "year": 2026, "reason": "x y z"}, unit_hr).status_code, 403
        )
        viewer = _hr("su_view", super_admin=False, role=Role.objects.create(name="SV", permissions={"payroll": "view"}))
        self.assertEqual(
            self.post(STAFF_UNLOCK, {"month": 2, "year": 2026, "reason": "x y z"}, viewer).status_code, 403
        )
        self.assertEqual(self.post(STAFF_UNLOCK, {"month": 3, "year": 2026, "reason": "x y z"}).status_code, 409)

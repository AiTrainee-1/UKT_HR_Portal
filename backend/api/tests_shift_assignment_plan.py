"""
Assigning a shift to many employees at once (Manage Shifts): the selection, the preview and the write.

These pin shift_planner.py and the endpoints built on it:

  * selection: employees / departments / designations, each included or excluded; an exclusion always wins;
  * what happens to each person: new, unchanged, conflict (keep or reassign), skipped, blocked, excluded;
  * the write: a reassignment leaves exactly one assignment covering every day (the rule attendance, payroll and the
    Report Center rely on), is idempotent, and is all-or-nothing;
  * shift templates are validated, a shift in use cannot be deleted, and people can be taken off a shift without
    rewriting their past.

Run via: python manage.py test api.tests_shift_assignment_plan -v 2
"""

import json
from datetime import date, time, timedelta
from unittest import mock

from django.test import TestCase

from .clock import ist_today
from .jwt_utils import sign_token
from .models import (
    Branch,
    Department,
    Designation,
    Employee,
    EmployeeShiftAssignment,
    HRUser,
    Role,
    ShiftTemplate,
)
from .shift_engine import _get_assignment_for_date

TODAY = ist_today()
D = TODAY + timedelta(days=3)  # a day in the future, so the usual tests carry no "past date" warning


def _bearer(payload):
    return {"HTTP_AUTHORIZATION": f"Bearer {sign_token(payload)}"}


def _admin():
    user, _ = HRUser.objects.get_or_create(
        username="shift_admin", defaults={"password_hash": "x", "is_super_admin": True, "full_name": "Shift Admin"}
    )
    return _bearer({"role": "hr", "hrUserId": user.id, "name": user.full_name})


def _emp(code, dept=None, desig=None, etype="staff", gender="male", status="active", branch=None):
    return Employee.objects.create(
        employee_code=code,
        first_name=code.title(),
        last_name="T",
        employment_type=etype,
        status=status,
        department=dept,
        designation=desig,
        gender=gender,
        branch=branch,
    )


def _shift(name, stype="staff", start="09:00", end="18:00", gender="all", branch=None, **kw):
    return ShiftTemplate.objects.create(
        name=name,
        shift_type=stype,
        start_time=time.fromisoformat(start),
        end_time=time.fromisoformat(end),
        gender_rule=gender,
        branch=branch,
        **kw,
    )


class _World(TestCase):
    """Two departments (Sewing: A1 A2 A3, Packing: P1 P2), designations Tailor / Helper, a production employee and
    the shifts Morning, Evening, Night-gal (female only) and Prod."""

    def setUp(self):
        self.sewing = Department.objects.create(name="Sewing")
        self.packing = Department.objects.create(name="Packing")
        self.tailor = Designation.objects.create(title="Tailor", department=self.sewing)
        self.helper = Designation.objects.create(title="Helper", department=self.sewing)
        self.a1 = _emp("A1", self.sewing, self.tailor)
        self.a2 = _emp("A2", self.sewing, self.tailor)
        self.a3 = _emp("A3", self.sewing, self.helper)
        self.p1 = _emp("P1", self.packing)
        self.p2 = _emp("P2", self.packing, gender="female")
        self.worker = _emp("W1", self.sewing, etype="production")
        self.left = _emp("L1", self.sewing, status="inactive")
        self.morning = _shift("Morning")
        self.evening = _shift("Evening", start="12:00", end="21:00")
        self.ladies = _shift("Ladies", gender="female")
        self.prod = _shift("Prod", stype="production", start="08:00", end="20:00")

    # ── helpers ──
    def post(self, path, body):
        return self.client.post(
            f"/api/shift-assignments/{path}", json.dumps(body), content_type="application/json", **_admin()
        )

    def body(self, shift=None, day=D, **over):
        out = {"shiftId": (shift or self.morning).id, "effectiveFrom": day.isoformat(), "selection": {}}
        sel = over.pop("selection", None)
        if sel is not None:
            out["selection"] = sel
        out.update(over)
        return out

    def plan(self, **kw):
        r = self.post("plan", self.body(**kw))
        self.assertEqual(r.status_code, 200, r.content)
        return r.json()

    def apply(self, **kw):
        return self.post("apply", self.body(**kw))

    @staticmethod
    def emps(*ids):
        return {"employees": {"include": [e.id for e in ids]}}

    @staticmethod
    def rows(body):
        return {r["employeeCode"]: r for r in body["rows"]}

    @staticmethod
    def states(body):
        return {r["employeeCode"]: r["status"] for r in body["rows"]}

    def give(self, emp, shift, start, end=None, **kw):
        return EmployeeShiftAssignment.objects.create(
            employee=emp, shift=shift, effective_from=start, effective_to=end, **kw
        )

    def covering(self, emp, day):
        return _get_assignment_for_date(emp, day)


class RequestValidationTests(_World):
    def test_the_basics_are_required(self):
        body = self.plan(selection={})
        self.assertFalse(body["ok"])
        self.assertIn("Choose at least one employee, department or designation to include", body["errors"])
        none = self.post("plan", {"selection": self.emps(self.a1)}).json()
        self.assertIn("Choose a shift", none["errors"])
        self.assertIn("Choose the date the shift starts from", none["errors"])

    def test_an_unknown_inactive_or_malformed_request_is_an_error_not_a_crash(self):
        self.assertIn(
            "That shift was not found", self.plan(shift=mock.Mock(id=99999), selection=self.emps(self.a1))["errors"]
        )
        self.morning.is_active = False
        self.morning.save()
        self.assertTrue(any("inactive" in e for e in self.plan(selection=self.emps(self.a1))["errors"]))
        bad = self.client.post(
            "/api/shift-assignments/plan",
            json.dumps({"shiftId": "x", "effectiveFrom": "nope", "selection": {"employees": {"include": ["z"]}}}),
            content_type="application/json",
            **_admin(),
        )
        self.assertEqual(bad.status_code, 200)
        self.assertGreaterEqual(len(bad.json()["errors"]), 2)
        listed = self.client.post(
            "/api/shift-assignments/plan", "[1]", content_type="application/json", **_admin()
        ).json()
        self.assertEqual(listed["errors"][0], "Send a JSON object")

    def test_a_custom_schedule_cannot_run_overnight(self):
        body = self.plan(selection=self.emps(self.a1), customStartTime="10:00", customEndTime="09:00")
        self.assertTrue(any("cannot end before it starts" in e for e in body["errors"]))
        ok = self.plan(selection=self.emps(self.a1), customStartTime="10:00", customEndTime="19:00")
        self.assertTrue(ok["ok"])

    def test_saturday_off_is_for_staff_shifts(self):
        body = self.plan(shift=self.prod, selection=self.emps(self.worker), saturdayOff=True)
        self.assertTrue(any("Saturday off applies to staff shifts only" in e for e in body["errors"]))

    def test_a_past_date_warns_and_a_far_one_is_refused(self):
        past = self.plan(day=TODAY - timedelta(days=5), selection=self.emps(self.a1))
        self.assertTrue(past["ok"])
        self.assertTrue(any("in the past" in w for w in past["warnings"]))
        far = self.plan(day=TODAY + timedelta(days=400), selection=self.emps(self.a1))
        self.assertFalse(far["ok"])
        self.assertFalse(self.plan(selection=self.emps(self.a1))["warnings"])

    def test_decisions_are_validated(self):
        body = self.plan(
            selection=self.emps(self.a1), onConflict="maybe", decisions={"x": "keep", str(self.a1.id): "perhaps"}
        )
        self.assertGreaterEqual(len(body["errors"]), 2)


class SelectionTests(_World):
    def test_employees_departments_and_designations_are_joined(self):
        body = self.plan(
            selection={"employees": {"include": [self.p1.id]}, "departments": {"include": [self.sewing.id]}}
        )
        # Sewing's staff + P1; the production worker is picked up too and then skipped, the inactive one never
        self.assertEqual(set(self.states(body)), {"A1", "A2", "A3", "P1", "W1"})
        body = self.plan(selection={"designations": {"include": [self.tailor.id]}})
        self.assertEqual(set(self.states(body)), {"A1", "A2"})

    def test_each_row_says_how_it_was_selected(self):
        body = self.plan(
            selection={
                "employees": {"include": [self.a1.id]},
                "departments": {"include": [self.sewing.id]},
                "designations": {"include": [self.tailor.id]},
            }
        )
        self.assertEqual(
            self.rows(body)["A1"]["via"], ["Selected directly", "Department: Sewing", "Designation: Tailor"]
        )
        self.assertEqual(self.rows(body)["A3"]["via"], ["Department: Sewing"])

    def test_an_exclusion_always_wins(self):
        sel = {
            "departments": {"include": [self.sewing.id]},
            "designations": {"exclude": [self.helper.id]},
            "employees": {"include": [self.a3.id], "exclude": [self.a2.id]},
        }
        body = self.plan(selection=sel)
        states = self.states(body)
        self.assertEqual((states["A1"], states["A2"], states["A3"]), ("new", "excluded", "excluded"))
        self.assertEqual(self.rows(body)["A2"]["reason"], "Left out: employee excluded")
        self.assertEqual(self.rows(body)["A3"]["reason"], "Left out: designation Helper excluded")
        self.assertEqual(body["counts"]["excluded"], 2)
        self.assertEqual(body["counts"]["selected"], 2)  # A1 and the production worker (skipped); not the two left out

    def test_excluding_a_department(self):
        body = self.plan(
            selection={
                "employees": {"include": [self.a1.id, self.p1.id]},
                "departments": {"exclude": [self.packing.id]},
            }
        )
        self.assertEqual(self.states(body), {"A1": "new", "P1": "excluded"})
        self.assertEqual(self.rows(body)["P1"]["reason"], "Left out: department Packing excluded")

    def test_something_matched_only_by_an_exclusion_is_not_listed(self):
        body = self.plan(selection={"employees": {"include": [self.a1.id], "exclude": [self.p1.id]}})
        self.assertEqual(set(self.states(body)), {"A1"})

    def test_everyone_of_the_shifts_type(self):
        body = self.plan(selection={"includeAll": True})
        self.assertEqual(set(self.states(body)), {"A1", "A2", "A3", "P1", "P2"})  # staff only
        prod = self.plan(shift=self.prod, selection={"includeAll": True, "departments": {"exclude": [self.packing.id]}})
        self.assertEqual(self.states(prod), {"W1": "new"})
        self.assertEqual(self.rows(prod)["W1"]["via"], ["All production employees"])

    def test_inactive_and_unknown_employees_are_never_selected_and_the_loss_is_mentioned(self):
        body = self.plan(selection={"employees": {"include": [self.a1.id, self.left.id, 999999]}})
        self.assertEqual(set(self.states(body)), {"A1"})
        self.assertTrue(any("2 selected employees are not active" in w for w in body["warnings"]))


class ClassificationTests(_World):
    def test_new_and_unchanged(self):
        self.give(self.a2, self.morning, TODAY - timedelta(days=30))
        body = self.plan(selection=self.emps(self.a1, self.a2))
        self.assertEqual(self.states(body), {"A1": "new", "A2": "unchanged"})
        self.assertEqual(self.rows(body)["A2"]["reason"], "Already on this shift")
        c = body["counts"]
        self.assertEqual((c["new"], c["alreadyAssigned"], c["alreadyOnThisShift"], c["willChange"]), (1, 1, 1, 1))

    def test_another_shift_is_a_conflict_that_names_it_and_defaults_to_keep(self):
        self.give(self.a1, self.evening, date(2026, 1, 5))
        row = self.rows(self.plan(selection=self.emps(self.a1)))["A1"]
        self.assertEqual((row["status"], row["action"], row["decision"]), ("conflict", "keep", "keep"))
        self.assertIn("Already on 'Evening' since 2026-01-05", row["reason"])
        self.assertEqual(row["current"]["shiftName"], "Evening")
        self.assertEqual(row["current"]["startTime"], "12:00")

    def test_on_conflict_and_per_employee_decisions(self):
        for e in (self.a1, self.a2, self.a3):
            self.give(e, self.evening, date(2026, 1, 5))
        sel = self.emps(self.a1, self.a2, self.a3)
        body = self.plan(selection=sel, onConflict="reassign", decisions={str(self.a2.id): "keep"})
        acts = {k: r["action"] for k, r in self.rows(body).items()}
        self.assertEqual(acts, {"A1": "reassign", "A2": "keep", "A3": "reassign"})
        self.assertEqual(
            (body["counts"]["willReassign"], body["counts"]["kept"], body["counts"]["conflicts"]), (2, 1, 3)
        )
        body = self.plan(selection=sel, decisions={str(self.a3.id): "reassign"})
        self.assertEqual(
            {k: r["action"] for k, r in self.rows(body).items()}, {"A1": "keep", "A2": "keep", "A3": "reassign"}
        )

    def test_same_shift_with_a_different_schedule_is_a_conflict(self):
        self.give(self.a1, self.morning, date(2026, 1, 5), custom_start_time=time(10, 0), saturday_off=True)
        row = self.rows(self.plan(selection=self.emps(self.a1)))["A1"]
        self.assertEqual(row["status"], "conflict")
        self.assertIn("custom hours 10:00 to default, Saturday off", row["reason"])
        same = self.plan(selection=self.emps(self.a1), customStartTime="10:00", saturdayOff=True)
        self.assertEqual(self.states(same)["A1"], "unchanged")

    def test_a_shift_scheduled_for_later_is_a_conflict(self):
        self.give(self.a1, self.evening, TODAY + timedelta(days=20))
        row = self.rows(self.plan(selection=self.emps(self.a1)))["A1"]
        self.assertEqual(row["status"], "conflict")
        self.assertIn("'Evening' is scheduled from", row["reason"])
        self.assertIsNone(row["current"])
        self.assertEqual(len(row["scheduled"]), 1)

    def test_backdating_over_a_shift_that_already_started_is_blocked(self):
        since = TODAY - timedelta(days=10)
        self.give(self.a1, self.evening, since)
        body = self.plan(day=TODAY - timedelta(days=20), selection=self.emps(self.a1))
        row = self.rows(body)["A1"]
        self.assertEqual(row["status"], "blocked")
        self.assertIn(f"since {since.isoformat()}", row["reason"])
        self.assertEqual(body["counts"]["blocked"], 1)
        self.assertEqual(body["counts"]["willChange"], 0)

    def test_the_shift_must_suit_the_person(self):
        prod_body = self.plan(selection=self.emps(self.a1, self.worker))
        rows = self.rows(prod_body)
        self.assertEqual(rows["W1"]["status"], "skipped")
        self.assertIn("This is a staff shift", rows["W1"]["reason"])
        staff_on_prod = self.rows(self.plan(shift=self.prod, selection=self.emps(self.a1)))["A1"]
        self.assertEqual(staff_on_prod["status"], "skipped")
        self.assertIn("This is a production shift", staff_on_prod["reason"])

    def test_a_gendered_shift_skips_everyone_else(self):
        rows = self.rows(self.plan(shift=self.ladies, selection=self.emps(self.a1, self.p2)))
        self.assertEqual((rows["A1"]["status"], rows["P2"]["status"]), ("skipped", "new"))
        self.assertEqual(rows["A1"]["reason"], "This shift is female only")
        nogender = _emp("N1", gender=None)
        self.assertIn(
            "no gender is recorded",
            self.rows(self.plan(shift=self.ladies, selection=self.emps(nogender)))["N1"]["reason"],
        )

    def test_a_shift_of_another_branch_is_not_given_to_this_branchs_people(self):
        b1, b2 = Branch.objects.create(name="B1"), Branch.objects.create(name="B2")
        shift = _shift("Branch shift", branch=b1)
        mine, theirs = _emp("M1", branch=b1), _emp("T1", branch=b2)
        rows = self.rows(self.plan(shift=shift, selection=self.emps(mine, theirs)))
        self.assertEqual((rows["M1"]["status"], rows["T1"]["status"]), ("new", "skipped"))
        self.assertEqual(rows["T1"]["reason"], "This shift belongs to another branch")

    def test_the_summary_adds_up(self):
        self.give(self.a1, self.morning, date(2026, 1, 5))
        self.give(self.a2, self.evening, date(2026, 1, 5))
        body = self.plan(
            selection={"departments": {"include": [self.sewing.id]}, "employees": {"exclude": [self.a3.id]}},
            onConflict="reassign",
        )
        c = body["counts"]
        self.assertEqual(
            (
                c["matched"],
                c["selected"],
                c["new"],
                c["alreadyOnThisShift"],
                c["conflicts"],
                c["willReassign"],
                c["skipped"],
                c["excluded"],
            ),
            (4, 3, 0, 1, 1, 1, 1, 1),
        )
        self.assertEqual(c["willChange"], 1)


class ApplyTests(_World):
    def test_new_people_get_an_open_assignment_signed_by_the_actor(self):
        r = self.apply(selection={"departments": {"include": [self.sewing.id]}}, notes="from the roster")
        self.assertEqual(r.status_code, 201, r.content)
        body = r.json()
        self.assertEqual(body["applied"]["created"], 3)  # A1 A2 A3; the production worker is skipped
        a = EmployeeShiftAssignment.objects.get(employee=self.a1)
        self.assertEqual(
            (a.shift_id, a.effective_from, a.effective_to, a.notes), (self.morning.id, D, None, "from the roster")
        )
        self.assertEqual(a.assigned_by, "Shift Admin")
        self.assertFalse(EmployeeShiftAssignment.objects.filter(employee=self.worker).exists())
        self.assertEqual(self.rows(body)["A1"]["outcome"], "created")

    def test_a_reassignment_leaves_exactly_one_assignment_covering_each_day(self):
        old = self.give(self.a1, self.evening, date(2026, 1, 5))
        r = self.apply(selection=self.emps(self.a1), onConflict="reassign")
        self.assertEqual(r.status_code, 201, r.content)
        self.assertEqual(r.json()["applied"]["reassigned"], 1)
        old.refresh_from_db()
        self.assertEqual(old.effective_to, D - timedelta(days=1))
        new = EmployeeShiftAssignment.objects.get(employee=self.a1, shift=self.morning)
        self.assertEqual((new.effective_from, new.effective_to), (D, None))
        self.assertEqual(self.covering(self.a1, D - timedelta(days=1)).shift_id, self.evening.id)
        self.assertEqual(self.covering(self.a1, D).shift_id, self.morning.id)
        self.assertEqual(self.covering(self.a1, D + timedelta(days=90)).shift_id, self.morning.id)
        # no two assignments overlap, which is what the Report Center warns about
        a, b = old, new
        self.assertFalse(
            a.effective_from <= (b.effective_to or date.max) and b.effective_from <= (a.effective_to or date.max)
        )

    def test_keep_changes_nothing_for_that_person(self):
        old = self.give(self.a1, self.evening, date(2026, 1, 5))
        r = self.apply(selection=self.emps(self.a1, self.a2))
        self.assertEqual(
            r.json()["applied"],
            {
                "created": 1,
                "reassigned": 0,
                "updated": 0,
                "kept": 1,
                "unchanged": 0,
                "skipped": 0,
                "blocked": 0,
                "excluded": 0,
                "assigned": 1,
            },
        )
        old.refresh_from_db()
        self.assertIsNone(old.effective_to)
        self.assertEqual(EmployeeShiftAssignment.objects.filter(employee=self.a1).count(), 1)
        self.assertEqual(self.rows(r.json())["A1"]["outcome"], "kept")

    def test_a_change_made_on_the_day_the_old_one_started_is_made_in_place(self):
        old = self.give(self.a1, self.evening, D)
        r = self.apply(selection=self.emps(self.a1), onConflict="reassign")
        self.assertEqual(r.json()["applied"]["updated"], 1)
        self.assertEqual(EmployeeShiftAssignment.objects.filter(employee=self.a1).count(), 1)
        old.refresh_from_db()
        self.assertEqual((old.shift_id, old.effective_from, old.effective_to), (self.morning.id, D, None))

    def test_a_schedule_only_change_to_the_same_shift(self):
        old = self.give(self.a1, self.morning, date(2026, 1, 5))
        r = self.apply(selection=self.emps(self.a1), onConflict="reassign", customStartTime="10:00", saturdayOff=True)
        self.assertEqual(r.json()["applied"]["reassigned"], 1)
        new = EmployeeShiftAssignment.objects.get(employee=self.a1, effective_from=D)
        self.assertEqual((new.custom_start_time, new.saturday_off), (time(10, 0), True))
        old.refresh_from_db()
        self.assertEqual(old.effective_to, D - timedelta(days=1))

    def test_a_scheduled_shift_is_cancelled_when_replaced(self):
        later = self.give(self.a1, self.evening, TODAY + timedelta(days=20))
        r = self.apply(selection=self.emps(self.a1), onConflict="reassign")
        self.assertEqual(r.json()["applied"]["created"], 1)  # nothing to move them from
        later.refresh_from_db()
        self.assertLess(later.effective_to, later.effective_from)  # closed before it starts: it covers no day
        for offset in (3, 19, 21, 100):
            self.assertEqual(self.covering(self.a1, TODAY + timedelta(days=offset)).shift_id, self.morning.id)

    def test_doing_it_twice_changes_nothing_the_second_time(self):
        self.give(self.a1, self.evening, date(2026, 1, 5))
        sel = {"departments": {"include": [self.sewing.id]}}
        first = self.apply(selection=sel, onConflict="reassign")
        count = EmployeeShiftAssignment.objects.count()
        second = self.apply(selection=sel, onConflict="reassign")
        self.assertEqual(second.status_code, 200)
        self.assertEqual(second.json()["applied"]["assigned"], 0)
        self.assertEqual(second.json()["applied"]["unchanged"], 3)
        self.assertEqual(EmployeeShiftAssignment.objects.count(), count)
        self.assertEqual(first.json()["applied"]["assigned"], 3)

    def test_blocked_people_are_left_alone_and_the_rest_are_assigned(self):
        since = TODAY - timedelta(days=10)
        blocked = self.give(self.a1, self.evening, since)
        r = self.apply(day=TODAY - timedelta(days=20), selection=self.emps(self.a1, self.a2))
        self.assertEqual(r.status_code, 201)
        self.assertEqual((r.json()["applied"]["blocked"], r.json()["applied"]["created"]), (1, 1))
        blocked.refresh_from_db()
        self.assertEqual((blocked.effective_from, blocked.effective_to), (since, None))
        self.assertEqual(EmployeeShiftAssignment.objects.filter(employee=self.a1).count(), 1)

    def test_errors_write_nothing(self):
        r = self.apply(
            selection={},
        )
        self.assertEqual(r.status_code, 400)
        self.assertFalse(r.json()["ok"])
        r = self.apply(selection=self.emps(self.a1), customStartTime="10:00", customEndTime="09:00")
        self.assertEqual(r.status_code, 400)
        self.assertFalse(EmployeeShiftAssignment.objects.exists())

    def test_all_or_nothing(self):
        self.client.raise_request_exception = False
        from . import shift_planner

        real = shift_planner._write
        calls = {"n": 0}

        def flaky(*a, **kw):
            calls["n"] += 1
            if calls["n"] == 2:
                raise RuntimeError("boom")
            return real(*a, **kw)

        with mock.patch.object(shift_planner, "_write", flaky):
            r = self.apply(selection=self.emps(self.a1, self.a2, self.a3))
        self.assertEqual(r.status_code, 500)
        self.assertFalse(EmployeeShiftAssignment.objects.exists())

    def test_the_apply_uses_a_fresh_plan_not_the_one_the_screen_showed(self):
        sel = self.emps(self.a1)
        shown = self.plan(selection=sel)
        self.assertEqual(self.states(shown)["A1"], "new")
        self.give(self.a1, self.evening, date(2026, 1, 5))  # someone else assigned them meanwhile
        r = self.apply(selection=sel)  # default is keep, never a blind overwrite
        self.assertEqual(r.json()["applied"]["kept"], 1)
        self.assertEqual(EmployeeShiftAssignment.objects.filter(employee=self.a1).count(), 1)

    def test_only_hr_may_plan_or_apply(self):
        emp = _bearer({"role": "employee", "employeeId": self.a1.id})
        for path in ("plan", "apply", "end"):
            r = self.client.post(f"/api/shift-assignments/{path}", "{}", content_type="application/json", **emp)
            self.assertEqual(r.status_code, 403, path)
            self.assertEqual(
                self.client.post(f"/api/shift-assignments/{path}", "{}", content_type="application/json").status_code,
                401,
                path,
            )

    def test_a_branch_admin_can_only_reach_their_own_branch(self):
        b1, b2 = Branch.objects.create(name="B1"), Branch.objects.create(name="B2")
        shift = _shift("B1 shift", branch=b1)
        mine, theirs = _emp("M1", branch=b1), _emp("T1", branch=b2)
        role = Role.objects.create(name="shift_editor", permissions={"shifts": "edit"})
        user = HRUser.objects.create(username="b1_admin", password_hash="x", role=role, branch=b1)
        token = _bearer({"role": "hr", "hrUserId": user.id})
        body = {
            "shiftId": shift.id,
            "effectiveFrom": D.isoformat(),
            "selection": {"employees": {"include": [mine.id, theirs.id]}},
        }
        r = self.client.post("/api/shift-assignments/apply", json.dumps(body), content_type="application/json", **token)
        self.assertEqual(r.status_code, 201, r.content)
        self.assertEqual(set(self.states(r.json())), {"M1"})
        self.assertTrue(any("not active or not in your branch" in w for w in r.json()["warnings"]))
        self.assertFalse(EmployeeShiftAssignment.objects.filter(employee=theirs).exists())
        other = {
            "shiftId": self.morning.id,
            "effectiveFrom": D.isoformat(),
            "selection": {"employees": {"include": [mine.id]}},
        }
        r = self.client.post("/api/shift-assignments/plan", json.dumps(other), content_type="application/json", **token)
        self.assertIn("That shift was not found", r.json()["errors"])  # a shift of no branch is not theirs to use


class TemplateValidationTests(_World):
    def create(self, **over):
        body = {"name": "General", "shiftType": "staff", "startTime": "09:00", "endTime": "18:00", **over}
        return self.client.post("/api/shifts", json.dumps(body), content_type="application/json", **_admin())

    def edit(self, shift, **over):
        return self.client.put(f"/api/shifts/{shift.id}", json.dumps(over), content_type="application/json", **_admin())

    def test_a_valid_shift_is_created_with_the_defaults(self):
        r = self.create()
        self.assertEqual(r.status_code, 201, r.content)
        body = r.json()
        self.assertEqual(
            (body["gracePeriodMinutes"], body["lunchDurationMinutes"], body["genderRule"], body["assignedCount"]),
            (15, 60, "all", 0),
        )

    def test_each_rule_is_reported_against_its_field(self):
        cases = [
            ({"name": "  "}, "name"),
            ({"name": "x" * 81}, "name"),
            ({"shiftType": "night"}, "shiftType"),
            ({"startTime": ""}, "startTime"),
            ({"endTime": "08:00"}, "endTime"),
            ({"endTime": "09:30"}, "endTime"),
            ({"startTime": "9am"}, "startTime"),
            ({"genderRule": "other"}, "genderRule"),
            ({"gracePeriodMinutes": 90}, "gracePeriodMinutes"),
            ({"gracePeriodMinutes": "x"}, "gracePeriodMinutes"),
            ({"firstHalfEnd": "08:00"}, "firstHalfEnd"),
            ({"firstHalfEnd": "18:00"}, "firstHalfEnd"),
            ({"lunchDurationMinutes": 5}, "lunchDurationMinutes"),
            ({"lunchGraceMinutes": 31}, "lunchGraceMinutes"),
            ({"shiftType": "production", "genderRule": "male"}, "genderRule"),
        ]
        for over, field in cases:
            r = self.create(**over)
            self.assertEqual(r.status_code, 400, over)
            self.assertIn(field, r.json()["fieldErrors"], over)
        self.assertEqual(ShiftTemplate.objects.filter(name="General").count(), 0)

    def test_overnight_shifts_are_refused(self):
        r = self.create(startTime="22:00", endTime="06:00")
        self.assertEqual(r.status_code, 400)
        self.assertIn("Overnight", r.json()["fieldErrors"]["endTime"])

    def test_a_name_is_unique_within_its_type_ignoring_case(self):
        self.assertEqual(self.create(name="morning").status_code, 400)
        self.assertEqual(self.create(name="Prod").status_code, 201)  # the production 'Prod' is another type
        shift = ShiftTemplate.objects.get(name="Evening")
        self.assertEqual(self.edit(shift, name="MORNING").status_code, 400)
        self.assertEqual(self.edit(shift, name="Evening").status_code, 200)  # itself is not a clash

    def test_a_production_shift_drops_the_lunch_structure(self):
        r = self.create(
            name="Night prod", shiftType="production", startTime="20:00", endTime="23:30", firstHalfEnd="21:00"
        )
        self.assertEqual(r.status_code, 201, r.content)
        self.assertIsNone(r.json()["firstHalfEnd"])

    def test_editing_is_validated_as_the_whole_shift_it_becomes(self):
        r = self.edit(self.morning, endTime="08:00")
        self.assertEqual(r.status_code, 400)
        self.assertEqual(self.edit(self.morning, gracePeriodMinutes=5).json()["gracePeriodMinutes"], 5)

    def test_a_shift_in_use_keeps_its_type_and_gender_and_stays_active(self):
        self.give(self.a1, self.morning, date(2026, 1, 5))  # male
        self.give(self.p2, self.morning, date(2026, 1, 5))  # female
        self.assertIn("shiftType", self.edit(self.morning, shiftType="production").json()["fieldErrors"])
        r = self.edit(self.morning, genderRule="female")
        self.assertIn("1 employee on this shift is not female", r.json()["fieldErrors"]["genderRule"])
        self.assertIn("isActive", self.edit(self.morning, isActive=False).json()["fieldErrors"])
        self.assertEqual(self.edit(self.evening, isActive=False).status_code, 200)  # nobody on it

    def test_the_list_says_how_many_are_on_each_shift(self):
        self.give(self.a1, self.morning, date(2026, 1, 5))
        self.give(self.a2, self.morning, date(2026, 1, 5))
        self.give(self.a3, self.morning, date(2026, 1, 5), date(2026, 2, 1))  # ended: not counted
        r = self.client.get("/api/shifts", **_admin())
        counts = {s["name"]: s["assignedCount"] for s in r.json()}
        self.assertEqual((counts["Morning"], counts["Evening"]), (2, 0))

    def test_a_shift_in_use_cannot_be_deleted_but_an_unused_one_can(self):
        self.give(self.a1, self.morning, date(2026, 1, 5))
        r = self.client.delete(f"/api/shifts/{self.morning.id}", **_admin())
        self.assertEqual(r.status_code, 409)
        self.assertEqual((r.json()["code"], r.json()["activeAssignments"]), ("shift_in_use", 1))
        self.assertTrue(EmployeeShiftAssignment.objects.filter(employee=self.a1).exists())
        history = self.give(self.a2, self.evening, date(2026, 1, 5), date(2026, 2, 1))
        self.assertEqual(
            self.client.delete(f"/api/shifts/{self.evening.id}", **_admin()).status_code, 409
        )  # history counts
        history.delete()
        self.assertEqual(self.client.delete(f"/api/shifts/{self.evening.id}", **_admin()).status_code, 204)


class AssignmentManagementTests(_World):
    def end(self, ids, **kw):
        return self.post("end", {"assignmentIds": ids, **kw})

    def test_ending_keeps_the_past_and_stops_the_future(self):
        a = self.give(self.a1, self.morning, date(2026, 1, 5))
        r = self.end([a.id], lastDay=TODAY.isoformat())
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual((r.json()["ended"], r.json()["cancelled"]), (1, 0))
        a.refresh_from_db()
        self.assertEqual(a.effective_to, TODAY)
        self.assertEqual(self.covering(self.a1, TODAY).shift_id, self.morning.id)
        self.assertIsNone(self.covering(self.a1, TODAY + timedelta(days=1)))

    def test_the_last_day_defaults_to_today(self):
        a = self.give(self.a1, self.morning, date(2026, 1, 5))
        self.end([a.id])
        a.refresh_from_db()
        self.assertEqual(a.effective_to, TODAY)

    def test_an_assignment_that_has_not_started_is_cancelled(self):
        a = self.give(self.a1, self.morning, TODAY + timedelta(days=10))
        r = self.end([a.id])
        self.assertEqual(r.json()["cancelled"], 1)
        self.assertFalse(EmployeeShiftAssignment.objects.filter(pk=a.pk).exists())

    def test_the_last_day_cannot_precede_a_start_that_has_happened(self):
        a = self.give(self.a1, self.morning, TODAY - timedelta(days=5))
        b = self.give(self.a2, self.morning, date(2026, 1, 5))
        r = self.end([b.id, a.id], lastDay=(TODAY - timedelta(days=9)).isoformat())
        self.assertEqual(r.status_code, 400)
        self.assertIn("the last day cannot be before that", r.json()["error"])
        b.refresh_from_db()
        self.assertIsNone(b.effective_to)  # all or nothing

    def test_unknown_ids_and_bad_input(self):
        self.assertEqual(self.end([999999]).status_code, 400)
        self.assertEqual(self.post("end", {}).status_code, 400)
        self.assertEqual(self.post("end", {"assignmentIds": ["x"]}).status_code, 400)
        a = self.give(self.a1, self.morning, date(2026, 1, 5))
        self.assertEqual(self.end([a.id], lastDay="soon").status_code, 400)

    def test_ending_twice_is_harmless(self):
        a = self.give(self.a1, self.morning, date(2026, 1, 5))
        self.end([a.id])
        again = self.end([a.id])
        self.assertEqual((again.json()["ended"], again.json()["unchanged"]), (0, 1))

    def test_editing_an_assignment_validates_the_schedule_and_the_shift(self):
        a = self.give(self.a1, self.morning, date(2026, 1, 5))

        def put(**body):
            return self.client.put(
                f"/api/shift-assignments/{a.id}", json.dumps(body), content_type="application/json", **_admin()
            )

        self.assertEqual(put(customStartTime="nope").status_code, 400)  # used to be a 500
        self.assertEqual(put(customStartTime="10:00", customEndTime="09:00").status_code, 400)
        self.assertEqual(put(effectiveTo="2025-01-01").status_code, 400)
        self.assertEqual(put(shiftId=self.prod.id).status_code, 400)  # production shift for a staff employee
        self.assertEqual(put(shiftId=self.ladies.id).status_code, 400)  # female only
        ok = put(customStartTime="10:00", customEndTime="19:00", saturdayOff=True, shiftId=self.evening.id)
        self.assertEqual(ok.status_code, 200, ok.content)
        self.assertEqual(
            (ok.json()["shiftName"], ok.json()["customStartTime"], ok.json()["saturdayOff"]), ("Evening", "10:00", True)
        )

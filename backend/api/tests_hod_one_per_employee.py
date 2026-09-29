"""
One HOD per employee.

An employee can be under a Department Head individually (ManagerEmployeeAssignment) or through a
whole department (ManagerDepartmentAssignment). Nothing used to stop the two overlapping, and every
approval screen OR-ed them together, so an employee showed up for several HODs. These tests pin:

  * the rule (hod_scope.py): an individual assignment beats department coverage, the earliest wins
    among equals, and only ACTIVE HODs count;
  * the assignment screens: assigning a department that collides with existing assignments asks
    first, and HR can reassign the employees, keep them where they are, or choose per employee;
  * the approval screens: an employee is approvable by exactly one HOD.

Run via: python manage.py test api.tests_hod_one_per_employee -v 2
"""

from django.test import TestCase

from .hod_scope import (
    coverage,
    department_conflicts,
    effective_manager,
    effective_manager_id,
    manager_may_act_on,
    managed_employee_ids,
    managers_to_notify,
)
from .jwt_utils import sign_token
from .manager_views import _manager_json
from .models import (
    Department,
    DepartmentManager,
    Employee,
    HRUser,
    LeaveRequest,
    ManagerDepartmentAssignment,
    ManagerEmployeeAssignment,
)


def _bearer(payload: dict) -> dict:
    return {"HTTP_AUTHORIZATION": f"Bearer {sign_token(payload)}"}


def _hr():
    admin, _ = HRUser.objects.get_or_create(
        username="hod_admin",
        defaults={"password_hash": "x", "is_super_admin": True},
    )
    return _bearer({"role": "hr", "hrUserId": admin.id})


def _emp_token(emp_id: int):
    return _bearer({"role": "employee", "employeeId": emp_id})


def _employee(code, dept=None, **kw):
    return Employee.objects.create(
        employee_code=code,
        first_name=code.title(),
        last_name="Test",
        employment_type="staff",
        status="active",
        department=dept,
        **kw,
    )


class _World(TestCase):
    """Department Sewing with three staff, two HODs (Asha, Bala) and a spare (Chitra)."""

    def setUp(self):
        self.sewing = Department.objects.create(name="Sewing")
        self.packing = Department.objects.create(name="Packing")
        self.asha = DepartmentManager.objects.create(employee=_employee("ASHA"))
        self.bala = DepartmentManager.objects.create(employee=_employee("BALA"))
        self.chitra = DepartmentManager.objects.create(employee=_employee("CHITRA"))
        self.e1 = _employee("EMP1", self.sewing)
        self.e2 = _employee("EMP2", self.sewing)
        self.e3 = _employee("EMP3", self.sewing)

    def dept(self, m, d):
        return ManagerDepartmentAssignment.objects.create(manager=m, department=d)

    def direct(self, m, e):
        return ManagerEmployeeAssignment.objects.create(manager=m, employee=e)

    def post_dept(self, m, dept, **body):
        return self.client.post(
            f"/api/department-managers/{m.id}/departments",
            {"departmentId": dept.id, **body},
            content_type="application/json",
            **_hr(),
        )


class OneHodRuleTests(_World):
    def test_an_individual_assignment_beats_department_coverage(self):
        self.dept(self.asha, self.sewing)
        self.direct(self.bala, self.e1)
        self.assertEqual(effective_manager_id(self.e1), self.bala.id)
        self.assertEqual(effective_manager_id(self.e2), self.asha.id)
        self.assertNotIn(self.e1.id, managed_employee_ids(self.asha))
        self.assertIn(self.e1.id, managed_employee_ids(self.bala))
        self.assertIn(self.e2.id, managed_employee_ids(self.asha))

    def test_two_holders_of_one_department_the_earliest_wins(self):
        self.dept(self.asha, self.sewing)
        self.dept(self.bala, self.sewing)
        self.assertEqual(effective_manager_id(self.e1), self.asha.id)
        self.assertEqual(managed_employee_ids(self.bala), [])

    def test_two_individual_assignments_the_earliest_wins(self):
        self.direct(self.asha, self.e1)
        self.direct(self.bala, self.e1)
        self.assertEqual(effective_manager_id(self.e1), self.asha.id)
        self.assertEqual(managed_employee_ids(self.bala), [])

    def test_a_deactivated_hod_never_hides_an_employee_from_the_active_one(self):
        self.dept(self.asha, self.sewing)
        self.direct(self.bala, self.e1)
        self.bala.is_active = False
        self.bala.save()
        self.assertEqual(effective_manager_id(self.e1), self.asha.id)
        self.assertIn(self.e1.id, managed_employee_ids(self.asha))

    def test_an_employee_with_no_active_hod_has_none(self):
        self.assertIsNone(effective_manager_id(self.e1))
        self.assertIsNone(effective_manager(self.e1))
        self.assertEqual(managers_to_notify(self.e1, "can_approve_leaves"), [])

    def test_notifications_go_to_the_one_hod_and_only_if_permitted(self):
        self.dept(self.asha, self.sewing)
        self.direct(self.bala, self.e1)
        self.assertEqual([m.id for m in managers_to_notify(self.e1, "can_approve_on_duty")], [self.bala.id])
        self.assertEqual([m.id for m in managers_to_notify(self.e2, "can_approve_on_duty")], [self.asha.id])
        self.bala.can_approve_on_duty = False
        self.bala.save()
        self.assertEqual(managers_to_notify(self.e1, "can_approve_on_duty"), [])  # HR decides; Asha is NOT bypassed to

    def test_only_the_one_hod_may_act_on_an_employee(self):
        self.dept(self.asha, self.sewing)
        self.direct(self.bala, self.e1)
        self.assertTrue(manager_may_act_on(self.bala.employee_id, self.e1))
        self.assertFalse(manager_may_act_on(self.asha.employee_id, self.e1))
        self.assertTrue(manager_may_act_on(self.asha.employee_id, self.e2))

    def test_a_late_joiner_to_the_department_follows_it_automatically(self):
        self.dept(self.asha, self.sewing)
        newcomer = _employee("NEWBIE", self.sewing)
        self.assertEqual(effective_manager_id(newcomer), self.asha.id)
        self.assertIn(newcomer.id, managed_employee_ids(self.asha))

    def test_headcount_and_overlaps_are_reported_per_hod(self):
        self.dept(self.asha, self.sewing)
        self.direct(self.bala, self.e1)
        asha = _manager_json(self.asha, include_assignments=True)
        self.assertEqual(asha["employeeCount"], 2)  # e2, e3
        self.assertNotIn(self.e1.id, asha["assignedEmployeeIds"])
        self.assertEqual(asha["overlapCount"], 1)
        (overlap,) = asha["overlaps"]
        self.assertEqual(overlap["employeeId"], self.e1.id)
        self.assertEqual(overlap["currentManager"]["employeeId"], self.bala.employee_id)
        self.assertEqual(overlap["via"], "direct")
        bala = _manager_json(self.bala, include_assignments=True)
        self.assertEqual((bala["employeeCount"], bala["overlapCount"]), (1, 0))


class DepartmentAssignmentTests(_World):
    def test_a_department_with_no_conflicts_is_assigned_as_before(self):
        r = self.post_dept(self.asha, self.sewing)
        self.assertEqual(r.status_code, 201, r.content)
        self.assertTrue(ManagerDepartmentAssignment.objects.filter(manager=self.asha, department=self.sewing).exists())
        self.assertEqual(r.json()["reassigned"], 0)

    def test_assigning_it_twice_to_the_same_hod_is_still_a_plain_400(self):
        self.dept(self.asha, self.sewing)
        self.assertEqual(self.post_dept(self.asha, self.sewing).status_code, 400)

    def test_employees_already_under_another_hod_are_reported_not_silently_taken(self):
        self.direct(self.bala, self.e1)
        self.direct(self.bala, self.e2)
        r = self.post_dept(self.asha, self.sewing)
        self.assertEqual(r.status_code, 409)
        body = r.json()
        self.assertTrue(body["conflict"])
        self.assertEqual(body["conflictCount"], 2)
        self.assertEqual({c["employeeCode"] for c in body["conflicts"]}, {"EMP1", "EMP2"})
        self.assertTrue(all(c["via"] == "direct" for c in body["conflicts"]))
        self.assertEqual(body["conflicts"][0]["manager"]["employeeId"], self.bala.employee_id)
        self.assertIn("already", body["error"])
        # nothing was changed by asking
        self.assertFalse(ManagerDepartmentAssignment.objects.filter(manager=self.asha).exists())
        self.assertEqual(ManagerEmployeeAssignment.objects.filter(manager=self.bala).count(), 2)

    def test_keep_leaves_the_existing_assignments_unchanged(self):
        self.direct(self.bala, self.e1)
        r = self.post_dept(self.asha, self.sewing, reassign="none")
        self.assertEqual(r.status_code, 201, r.content)
        self.assertEqual((r.json()["reassigned"], r.json()["kept"]), (0, 1))
        self.assertEqual(effective_manager_id(self.e1), self.bala.id)  # stayed with Bala
        self.assertEqual(effective_manager_id(self.e2), self.asha.id)  # the rest of the department is Asha's
        self.assertNotIn(self.e1.id, managed_employee_ids(self.asha))
        self.assertTrue(ManagerEmployeeAssignment.objects.filter(manager=self.bala, employee=self.e1).exists())

    def test_reassign_all_moves_them_here(self):
        self.direct(self.bala, self.e1)
        self.direct(self.bala, self.e2)
        r = self.post_dept(self.asha, self.sewing, reassign="all")
        self.assertEqual(r.status_code, 201, r.content)
        self.assertEqual((r.json()["reassigned"], r.json()["kept"]), (2, 0))
        for e in (self.e1, self.e2, self.e3):
            self.assertEqual(effective_manager_id(e), self.asha.id, e.employee_code)
        self.assertFalse(ManagerEmployeeAssignment.objects.filter(manager=self.bala).exists())

    def test_choosing_per_employee_moves_only_those(self):
        self.direct(self.bala, self.e1)
        self.direct(self.bala, self.e2)
        r = self.post_dept(self.asha, self.sewing, reassign=[self.e1.id])
        self.assertEqual(r.status_code, 201, r.content)
        self.assertEqual(effective_manager_id(self.e1), self.asha.id)
        self.assertEqual(effective_manager_id(self.e2), self.bala.id)
        self.assertEqual((r.json()["reassigned"], r.json()["kept"]), (1, 1))

    def test_an_id_that_is_not_a_conflict_is_ignored_not_trusted(self):
        self.direct(self.bala, self.e1)
        other_dept_emp = _employee("OUTSIDER", self.packing)
        self.direct(self.chitra, other_dept_emp)
        r = self.post_dept(self.asha, self.sewing, reassign=[other_dept_emp.id])
        self.assertEqual(r.status_code, 201, r.content)
        self.assertEqual(effective_manager_id(other_dept_emp), self.chitra.id)  # untouched
        self.assertEqual(effective_manager_id(self.e1), self.bala.id)

    def test_a_department_held_whole_by_another_hod_asks_and_keep_changes_nothing(self):
        self.dept(self.bala, self.sewing)
        r = self.post_dept(self.asha, self.sewing)
        self.assertEqual(r.status_code, 409)
        body = r.json()
        self.assertEqual([h["employeeId"] for h in body["holders"]], [self.bala.employee_id])
        self.assertEqual(body["conflictCount"], 3)
        self.assertTrue(all(c["via"] == "department" for c in body["conflicts"]))
        kept = self.post_dept(self.asha, self.sewing, reassign="none")
        self.assertEqual(kept.status_code, 200, kept.content)
        self.assertFalse(kept.json()["assigned"])
        self.assertTrue(ManagerDepartmentAssignment.objects.filter(manager=self.bala, department=self.sewing).exists())
        self.assertFalse(ManagerDepartmentAssignment.objects.filter(manager=self.asha).exists())

    def test_reassign_all_moves_the_whole_department(self):
        self.dept(self.bala, self.sewing)
        r = self.post_dept(self.asha, self.sewing, reassign="all")
        self.assertEqual(r.status_code, 201, r.content)
        self.assertFalse(ManagerDepartmentAssignment.objects.filter(manager=self.bala).exists())
        for e in (self.e1, self.e2, self.e3):
            self.assertEqual(effective_manager_id(e), self.asha.id)

    def test_moving_a_department_keeps_the_people_you_chose_to_keep_with_their_hod(self):
        self.dept(self.bala, self.sewing)
        r = self.post_dept(self.asha, self.sewing, reassign=[self.e1.id])
        self.assertEqual(r.status_code, 201, r.content)
        self.assertEqual(effective_manager_id(self.e1), self.asha.id)  # reassigned
        self.assertEqual(effective_manager_id(self.e2), self.bala.id)  # kept: pinned to Bala
        self.assertEqual(effective_manager_id(self.e3), self.bala.id)
        self.assertTrue(ManagerEmployeeAssignment.objects.filter(manager=self.bala, employee=self.e2).exists())
        self.assertFalse(ManagerDepartmentAssignment.objects.filter(manager=self.bala).exists())

    def test_a_deactivated_hod_is_not_a_conflict(self):
        self.direct(self.bala, self.e1)
        self.bala.is_active = False
        self.bala.save()
        self.assertEqual(self.post_dept(self.asha, self.sewing).status_code, 201)

    def test_a_head_is_not_a_conflict_for_their_own_department(self):
        head = _employee("HEADSEW", self.sewing)
        head_mgr = DepartmentManager.objects.create(employee=head)
        self.dept(head_mgr, self.sewing)  # a head covering their own department
        conflicts, holders = department_conflicts(self.asha, self.sewing)
        self.assertNotIn(head.id, [c.employee.id for c in conflicts])
        self.assertEqual([h.id for h in holders], [head_mgr.id])

    def test_bad_reassign_values_are_a_400(self):
        self.direct(self.bala, self.e1)
        for bad in ("everyone", 5, {"a": 1}, ["x"]):
            r = self.post_dept(self.asha, self.sewing, reassign=bad)
            self.assertEqual(r.status_code, 400, bad)
        self.assertFalse(ManagerDepartmentAssignment.objects.filter(manager=self.asha).exists())


class IndividualAssignmentTests(_World):
    def _assign(self, m, emp, **extra):
        return self.client.post(
            f"/api/department-managers/{m.id}/employees",
            {"employeeCode": emp.employee_code, **extra},
            content_type="application/json",
            **_hr(),
        )

    def test_moving_a_department_covered_employee_makes_the_new_hod_their_only_hod(self):
        self.dept(self.asha, self.sewing)
        asked = self._assign(self.bala, self.e1)
        self.assertEqual(asked.status_code, 409)
        self.assertEqual(asked.json()["conflictType"], "department")
        self.assertIn("Move them to this HOD", asked.json()["error"])
        done = self._assign(self.bala, self.e1, force=True)
        self.assertEqual(done.status_code, 201, done.content)
        self.assertEqual(effective_manager_id(self.e1), self.bala.id)
        self.assertNotIn(self.e1.id, managed_employee_ids(self.asha))  # no longer double-covered
        self.assertIn(self.e2.id, managed_employee_ids(self.asha))  # Asha keeps the rest


class ApprovalScreensTests(_World):
    def _pending(self, m):
        r = self.client.get("/api/manager/pending-requests", **_emp_token(m.employee_id))
        self.assertEqual(r.status_code, 200, r.content)
        return r.json()

    def _leave(self, emp):
        return LeaveRequest.objects.create(
            employee=emp,
            type="Casual",
            start_date="2026-10-05",
            end_date="2026-10-05",
            reason="test",
            status="pending",
        )

    def test_a_request_reaches_only_the_employees_one_hod(self):
        self.dept(self.asha, self.sewing)
        self.direct(self.bala, self.e1)
        self._leave(self.e1)
        self._leave(self.e2)
        asha = self._pending(self.asha)
        bala = self._pending(self.bala)
        asha_codes = {row["employee"]["employeeCode"] for row in asha["leaveRequests"]}
        bala_codes = {row["employee"]["employeeCode"] for row in bala["leaveRequests"]}
        self.assertEqual(asha_codes, {"EMP2"})
        self.assertEqual(bala_codes, {"EMP1"})

    def test_reassigning_moves_the_pending_request_with_the_employee(self):
        self.direct(self.bala, self.e1)
        self.dept(self.asha, self.sewing)
        self._leave(self.e1)
        self.assertEqual(len(self._pending(self.bala)["leaveRequests"]), 1)
        self.assertEqual(len(self._pending(self.asha)["leaveRequests"]), 0)
        ManagerEmployeeAssignment.objects.filter(manager=self.bala).delete()
        self.assertEqual(len(self._pending(self.bala)["leaveRequests"]), 0)
        self.assertEqual(len(self._pending(self.asha)["leaveRequests"]), 1)

    def test_coverage_helper_agrees_with_what_the_screen_shows(self):
        self.dept(self.asha, self.sewing)
        self.direct(self.bala, self.e1)
        managed, overridden = coverage(self.asha)
        self.assertEqual(set(managed), {self.e2.id, self.e3.id})
        self.assertEqual(overridden, {self.e1.id: self.bala.id})

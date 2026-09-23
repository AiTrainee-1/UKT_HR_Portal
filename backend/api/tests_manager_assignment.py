"""
Regression test for the department-manager "assigned/unassigned" bug found
on the User Management page: an employee covered purely via a whole
DEPARTMENT assignment (ManagerDepartmentAssignment) showed up as
"Unassigned" because _manager_json's assignedEmployeeIds/employeeCount only
counted direct ManagerEmployeeAssignment rows, ignoring department coverage
entirely -inconsistent with manager_pending_requests, which already
correctly ORs both together for the real approval-routing logic.

Also covers the employee-assignment uniqueness check (_find_employee_
assignment_conflict / manager_employee_assignments' conflict+force flow):
an employee must never be actively assigned to two HODs at once.

Run via: python manage.py test api.tests_manager_assignment -v 2
"""
from django.test import TestCase
from rest_framework.test import APIRequestFactory

from .jwt_utils import sign_token
from .models import (
    Department, Employee, DepartmentManager, ManagerDepartmentAssignment,
    ManagerEmployeeAssignment,
)
from .manager_views import _find_employee_assignment_conflict, _manager_json, manager_employee_assignments


class ManagerAssignedEmployeesTests(TestCase):
    def setUp(self):
        self.dept = Department.objects.create(name="Cutting")
        self.other_dept = Department.objects.create(name="Finishing")

        self.hod = Employee.objects.create(
            employee_code="MGRTEST_HOD", first_name="Head", last_name="Of Dept",
            employment_type="staff", status="active",
        )
        self.staff_in_dept = Employee.objects.create(
            employee_code="MGRTEST_STAFF1", first_name="Staff", last_name="InDept",
            employment_type="staff", status="active", department=self.dept,
        )
        self.staff_direct = Employee.objects.create(
            employee_code="MGRTEST_STAFF2", first_name="Staff", last_name="Direct",
            employment_type="staff", status="active", department=self.other_dept,
        )
        self.staff_unrelated = Employee.objects.create(
            employee_code="MGRTEST_STAFF3", first_name="Staff", last_name="Unrelated",
            employment_type="staff", status="active", department=self.other_dept,
        )

        self.manager = DepartmentManager.objects.create(employee=self.hod)
        ManagerDepartmentAssignment.objects.create(manager=self.manager, department=self.dept)
        ManagerEmployeeAssignment.objects.create(manager=self.manager, employee=self.staff_direct)

    def test_department_covered_employee_counted_as_assigned(self):
        data = _manager_json(self.manager)
        self.assertIn(self.staff_in_dept.id, data["assignedEmployeeIds"])

    def test_directly_assigned_employee_still_counted(self):
        data = _manager_json(self.manager)
        self.assertIn(self.staff_direct.id, data["assignedEmployeeIds"])

    def test_unrelated_employee_not_counted(self):
        data = _manager_json(self.manager)
        self.assertNotIn(self.staff_unrelated.id, data["assignedEmployeeIds"])

    def test_employee_count_includes_both_coverage_paths(self):
        data = _manager_json(self.manager)
        self.assertEqual(data["employeeCount"], 2)  # staff_in_dept + staff_direct

    def test_department_count_unaffected(self):
        data = _manager_json(self.manager)
        self.assertEqual(data["departmentCount"], 1)


class EmployeeAssignmentConflictTests(TestCase):
    """_find_employee_assignment_conflict -the pure decision function behind
    manager_employee_assignments' 409 conflict response."""

    def setUp(self):
        self.dept = Department.objects.create(name="Stitching")
        self.other_dept = Department.objects.create(name="Packing")

        self.hod_a = Employee.objects.create(
            employee_code="MGRCONFLICT_HODA", first_name="Alpha", last_name="Head",
            employment_type="staff", status="active",
        )
        self.hod_b = Employee.objects.create(
            employee_code="MGRCONFLICT_HODB", first_name="Beta", last_name="Head",
            employment_type="staff", status="active",
        )
        self.manager_a = DepartmentManager.objects.create(employee=self.hod_a)
        self.manager_b = DepartmentManager.objects.create(employee=self.hod_b)

        self.staff = Employee.objects.create(
            employee_code="MGRCONFLICT_STAFF1", first_name="Staff", last_name="One",
            employment_type="staff", status="active", department=self.other_dept,
        )
        self.dept_staff = Employee.objects.create(
            employee_code="MGRCONFLICT_STAFF2", first_name="Staff", last_name="Two",
            employment_type="staff", status="active", department=self.dept,
        )

    def test_no_conflict_when_unassigned(self):
        conflict_type, other = _find_employee_assignment_conflict(self.staff, self.manager_a)
        self.assertIsNone(conflict_type)
        self.assertIsNone(other)

    def test_direct_conflict_detected(self):
        ManagerEmployeeAssignment.objects.create(manager=self.manager_a, employee=self.staff)
        conflict_type, other = _find_employee_assignment_conflict(self.staff, self.manager_b)
        self.assertEqual(conflict_type, "direct")
        self.assertEqual(other.id, self.manager_a.id)

    def test_department_conflict_detected(self):
        ManagerDepartmentAssignment.objects.create(manager=self.manager_a, department=self.dept)
        conflict_type, other = _find_employee_assignment_conflict(self.dept_staff, self.manager_b)
        self.assertEqual(conflict_type, "department")
        self.assertEqual(other.id, self.manager_a.id)

    def test_no_conflict_against_own_manager(self):
        ManagerEmployeeAssignment.objects.create(manager=self.manager_a, employee=self.staff)
        conflict_type, other = _find_employee_assignment_conflict(self.staff, self.manager_a)
        self.assertIsNone(conflict_type)

    def test_no_conflict_when_other_manager_is_inactive(self):
        ManagerEmployeeAssignment.objects.create(manager=self.manager_a, employee=self.staff)
        self.manager_a.is_active = False
        self.manager_a.save(update_fields=["is_active"])
        conflict_type, other = _find_employee_assignment_conflict(self.staff, self.manager_b)
        self.assertIsNone(conflict_type)

    def test_direct_conflict_takes_priority_over_department_conflict(self):
        ManagerEmployeeAssignment.objects.create(manager=self.manager_a, employee=self.dept_staff)
        third_hod = Employee.objects.create(
            employee_code="MGRCONFLICT_HODC", first_name="Gamma", last_name="Head",
            employment_type="staff", status="active",
        )
        manager_c = DepartmentManager.objects.create(employee=third_hod)
        ManagerDepartmentAssignment.objects.create(manager=manager_c, department=self.dept)

        # dept_staff is directly assigned to manager_a, but manager_c
        # separately covers their whole department too -a genuine, real
        # conflict against manager_c even though manager_a itself isn't the
        # problem. (The view layer short-circuits the narrower "is this
        # employee already assigned to the manager I'm posting to" case
        # before ever calling this function -see manager_employee_
        # assignments' own dedicated check for that.)
        conflict_type, other = _find_employee_assignment_conflict(self.dept_staff, self.manager_a)
        self.assertEqual(conflict_type, "department")
        self.assertEqual(other.id, manager_c.id)

        conflict_type, other = _find_employee_assignment_conflict(self.dept_staff, self.manager_b)
        self.assertEqual(conflict_type, "direct")
        self.assertEqual(other.id, self.manager_a.id)


class EmployeeAssignmentEndpointTests(TestCase):
    """manager_employee_assignments' full POST flow -conflict without force,
    successful reassignment with force, and the "no conflict" happy path."""

    def setUp(self):
        self.hod_a = Employee.objects.create(
            employee_code="MGRENDPOINT_HODA", first_name="Alpha", last_name="Head",
            employment_type="staff", status="active",
        )
        self.hod_b = Employee.objects.create(
            employee_code="MGRENDPOINT_HODB", first_name="Beta", last_name="Head",
            employment_type="staff", status="active",
        )
        self.manager_a = DepartmentManager.objects.create(employee=self.hod_a)
        self.manager_b = DepartmentManager.objects.create(employee=self.hod_b)
        self.staff = Employee.objects.create(
            employee_code="MGRENDPOINT_STAFF1", first_name="Staff", last_name="One",
            employment_type="staff", status="active",
        )
        self.factory = APIRequestFactory()

    def _hr_request(self, data: dict):
        token = sign_token({"role": "hr", "hrUserId": 1})
        return self.factory.post(
            "/api/manager/department-managers/x/employees", data, format="json",
            HTTP_AUTHORIZATION=f"Bearer {token}",
        )

    def test_assign_with_no_existing_conflict_succeeds(self):
        request = self._hr_request({"employeeId": self.staff.id})
        response = manager_employee_assignments(request, self.manager_a.id)
        self.assertEqual(response.status_code, 201)
        self.assertTrue(
            ManagerEmployeeAssignment.objects.filter(manager=self.manager_a, employee=self.staff).exists()
        )

    def test_assign_with_conflict_and_no_force_returns_409(self):
        ManagerEmployeeAssignment.objects.create(manager=self.manager_a, employee=self.staff)
        request = self._hr_request({"employeeId": self.staff.id})
        response = manager_employee_assignments(request, self.manager_b.id)
        self.assertEqual(response.status_code, 409)
        self.assertTrue(response.data["conflict"])
        self.assertEqual(response.data["conflictType"], "direct")
        self.assertEqual(response.data["existingManager"]["id"], self.manager_a.id)
        # Original assignment must be untouched -no reassignment happened.
        self.assertTrue(
            ManagerEmployeeAssignment.objects.filter(manager=self.manager_a, employee=self.staff).exists()
        )
        self.assertFalse(
            ManagerEmployeeAssignment.objects.filter(manager=self.manager_b, employee=self.staff).exists()
        )

    def test_assign_with_conflict_and_force_reassigns_cleanly(self):
        ManagerEmployeeAssignment.objects.create(manager=self.manager_a, employee=self.staff)
        request = self._hr_request({"employeeId": self.staff.id, "force": True})
        response = manager_employee_assignments(request, self.manager_b.id)
        self.assertEqual(response.status_code, 201)
        # Old assignment removed, new one created -never both at once.
        self.assertFalse(
            ManagerEmployeeAssignment.objects.filter(manager=self.manager_a, employee=self.staff).exists()
        )
        self.assertTrue(
            ManagerEmployeeAssignment.objects.filter(manager=self.manager_b, employee=self.staff).exists()
        )
        self.assertEqual(
            ManagerEmployeeAssignment.objects.filter(employee=self.staff).count(), 1,
        )

    def test_reposting_to_the_same_manager_is_a_harmless_no_op_even_with_a_third_party_department_conflict(self):
        """A coincidental, unrelated department-level conflict from a THIRD
        manager must never turn a harmless re-add attempt (employee already
        directly assigned to the manager being posted to) into a 409 -see
        manager_employee_assignments' dedicated "already assigned to this
        manager" short-circuit, added after this exact scenario surfaced."""
        dept = Department.objects.create(name="Weaving")
        self.staff.department = dept
        self.staff.save(update_fields=["department"])
        ManagerEmployeeAssignment.objects.create(manager=self.manager_a, employee=self.staff)
        ManagerDepartmentAssignment.objects.create(manager=self.manager_b, department=dept)

        request = self._hr_request({"employeeId": self.staff.id})
        response = manager_employee_assignments(request, self.manager_a.id)
        self.assertEqual(response.status_code, 400)
        self.assertNotIn("conflict", response.data)

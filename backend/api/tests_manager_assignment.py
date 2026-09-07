"""
Regression test for the department-manager "assigned/unassigned" bug found
on the User Management page: an employee covered purely via a whole
DEPARTMENT assignment (ManagerDepartmentAssignment) showed up as
"Unassigned" because _manager_json's assignedEmployeeIds/employeeCount only
counted direct ManagerEmployeeAssignment rows, ignoring department coverage
entirely -inconsistent with manager_pending_requests, which already
correctly ORs both together for the real approval-routing logic.

Run via: python manage.py test api.tests_manager_assignment -v 2
"""
from django.test import TestCase

from .models import (
    Department, Employee, DepartmentManager, ManagerDepartmentAssignment,
    ManagerEmployeeAssignment,
)
from .manager_views import _manager_json


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

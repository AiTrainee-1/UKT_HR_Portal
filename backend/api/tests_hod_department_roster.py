"""
The employees of an HOD's departments: listed automatically, and removable.

Assigning a department to an HOD covers everyone in it. These tests pin the page that lists those
people (GET .../department-employees) and the carve-out HR uses to take one of them out without
un-assigning the department (POST/DELETE .../excluded-employees, ManagerEmployeeExclusion):

  * the rule (hod_scope.py): a removed employee stops reporting to that HOD, falls to the next active
    holder of the department or to nobody (HR), while an individual assignment still beats it and a
    late joiner to the department still follows it;
  * the endpoints: validation, atomicity, idempotence, restoring, and the housekeeping when a
    department or an individual assignment changes;
  * the approval screens and HOD reports agree with the rule.

Run via: python manage.py test api.tests_hod_department_roster -v 2
"""

import json

from django.test import TestCase

from .hod_scope import (
    coverage,
    department_roster,
    effective_manager_id,
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
    ManagerEmployeeExclusion,
)


def _bearer(payload: dict) -> dict:
    return {"HTTP_AUTHORIZATION": f"Bearer {sign_token(payload)}"}


def _hr():
    admin, _ = HRUser.objects.get_or_create(
        username="roster_admin",
        defaults={"password_hash": "x", "is_super_admin": True},
    )
    return _bearer({"role": "hr", "hrUserId": admin.id})


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
    """Sewing (three staff) held by Asha; Bala and Chitra are spare HODs."""

    def setUp(self):
        self.sewing = Department.objects.create(name="Sewing")
        self.packing = Department.objects.create(name="Packing")
        self.asha = DepartmentManager.objects.create(employee=_employee("ASHA", self.sewing))
        self.bala = DepartmentManager.objects.create(employee=_employee("BALA"))
        self.chitra = DepartmentManager.objects.create(employee=_employee("CHITRA"))
        self.e1 = _employee("EMP1", self.sewing)
        self.e2 = _employee("EMP2", self.sewing)
        self.e3 = _employee("EMP3", self.sewing)
        self.p1 = _employee("PACK1", self.packing)

    def dept(self, m, d):
        return ManagerDepartmentAssignment.objects.create(manager=m, department=d)

    def direct(self, m, e):
        return ManagerEmployeeAssignment.objects.create(manager=m, employee=e)

    def carve(self, m, e):
        return ManagerEmployeeExclusion.objects.create(manager=m, employee=e)

    def call(self, method, path, body=None):
        fn = getattr(self.client, method)
        if body is None:
            return fn(path, **_hr())
        return fn(path, json.dumps(body), content_type="application/json", **_hr())

    def remove(self, m, *emps):
        return self.call(
            "post", f"/api/department-managers/{m.id}/excluded-employees", {"employeeIds": [e.id for e in emps]}
        )

    def restore(self, m, *emps):
        return self.call(
            "delete", f"/api/department-managers/{m.id}/excluded-employees", {"employeeIds": [e.id for e in emps]}
        )

    def roster(self, m):
        r = self.call("get", f"/api/department-managers/{m.id}/department-employees")
        self.assertEqual(r.status_code, 200, r.content)
        return r.json()

    @staticmethod
    def states(roster, dept_name):
        (dept,) = [d for d in roster["departments"] if d["name"] == dept_name]
        return {e["employeeCode"]: e["state"] for e in dept["employees"]}


class RuleTests(_World):
    def test_a_removed_employee_stops_reporting_to_that_hod(self):
        self.dept(self.asha, self.sewing)
        self.carve(self.asha, self.e1)
        self.assertNotIn(self.e1.id, managed_employee_ids(self.asha))
        self.assertIn(self.e2.id, managed_employee_ids(self.asha))
        self.assertIsNone(effective_manager_id(self.e1))
        self.assertEqual(managers_to_notify(self.e1, "can_approve_leaves"), [])  # HR decides

    def test_a_removed_employee_falls_to_the_next_holder_of_the_department(self):
        self.dept(self.asha, self.sewing)
        self.dept(self.bala, self.sewing)
        self.assertEqual(effective_manager_id(self.e1), self.asha.id)
        self.carve(self.asha, self.e1)
        self.assertEqual(effective_manager_id(self.e1), self.bala.id)
        self.assertEqual(effective_manager_id(self.e2), self.asha.id)

    def test_an_individual_assignment_still_beats_a_carve_out(self):
        self.dept(self.asha, self.sewing)
        self.carve(self.asha, self.e1)
        self.direct(self.asha, self.e1)
        self.assertEqual(effective_manager_id(self.e1), self.asha.id)
        self.assertIn(self.e1.id, managed_employee_ids(self.asha))

    def test_it_only_removes_the_person_from_that_hods_coverage(self):
        self.dept(self.asha, self.sewing)
        self.carve(self.asha, self.e1)
        self.direct(self.bala, self.e1)
        self.assertEqual(effective_manager_id(self.e1), self.bala.id)

    def test_someone_joining_the_department_later_still_follows_it(self):
        self.dept(self.asha, self.sewing)
        self.carve(self.asha, self.e1)
        newcomer = _employee("NEWBIE", self.sewing)
        self.assertEqual(effective_manager_id(newcomer), self.asha.id)

    def test_headcount_drops_and_the_person_is_not_counted_as_an_overlap(self):
        self.dept(self.asha, self.sewing)
        self.carve(self.asha, self.e1)
        data = _manager_json(self.asha, include_assignments=True)
        self.assertEqual(data["employeeCount"], 3)  # Asha, e2, e3
        self.assertNotIn(self.e1.id, data["assignedEmployeeIds"])
        self.assertEqual(data["overlapCount"], 0)
        self.assertEqual(data["removedCount"], 1)

    def test_coverage_helper_agrees_with_the_headcount(self):
        self.dept(self.asha, self.sewing)
        self.carve(self.asha, self.e1)
        managed, overridden = coverage(self.asha)
        self.assertEqual(sorted(managed), sorted([self.asha.employee_id, self.e2.id, self.e3.id]))
        self.assertEqual(overridden, {})


class RosterTests(_World):
    def test_assigning_a_department_lists_its_employees_automatically(self):
        self.assertEqual(self.roster(self.asha)["departments"], [])
        self.dept(self.asha, self.sewing)
        data = self.roster(self.asha)
        (dept,) = data["departments"]
        self.assertEqual(dept["name"], "Sewing")
        self.assertEqual({e["employeeCode"] for e in dept["employees"]}, {"ASHA", "EMP1", "EMP2", "EMP3"})
        self.assertEqual(dept["counts"], {"reporting": 3, "removed": 0, "elsewhere": 0, "self": 1})
        # a person who joins the department appears on the next load
        _employee("NEWBIE", self.sewing)
        self.assertIn("NEWBIE", self.states(self.roster(self.asha), "Sewing"))

    def test_each_person_says_where_they_stand(self):
        self.dept(self.asha, self.sewing)
        self.direct(self.bala, self.e2)
        self.carve(self.asha, self.e3)
        data = self.roster(self.asha)
        self.assertEqual(
            self.states(data, "Sewing"),
            {"ASHA": "self", "EMP1": "reporting", "EMP2": "elsewhere", "EMP3": "removed"},
        )
        rows = {e["employeeCode"]: e for e in data["departments"][0]["employees"]}
        self.assertEqual(rows["EMP2"]["via"], "direct")
        self.assertEqual(rows["EMP2"]["manager"]["employeeId"], self.bala.employee_id)
        self.assertIsNone(rows["EMP3"]["manager"])  # nobody picks them up: HR decides
        self.assertEqual(data["departments"][0]["counts"], {"reporting": 1, "removed": 1, "elsewhere": 1, "self": 1})

    def test_a_removed_person_shows_who_picked_them_up(self):
        self.dept(self.asha, self.sewing)
        self.dept(self.bala, self.sewing)
        self.carve(self.asha, self.e1)
        rows = {e["employeeCode"]: e for e in self.roster(self.asha)["departments"][0]["employees"]}
        self.assertEqual(rows["EMP1"]["state"], "removed")
        self.assertEqual(rows["EMP1"]["manager"]["employeeId"], self.bala.employee_id)
        self.assertEqual(rows["EMP1"]["via"], "department")

    def test_an_employee_also_assigned_individually_is_flagged(self):
        self.dept(self.asha, self.sewing)
        self.direct(self.asha, self.e1)
        rows = {e["employeeCode"]: e for e in self.roster(self.asha)["departments"][0]["employees"]}
        self.assertTrue(rows["EMP1"]["individual"])
        self.assertFalse(rows["EMP2"]["individual"])

    def test_every_assigned_department_gets_its_own_list(self):
        self.dept(self.asha, self.sewing)
        self.dept(self.asha, self.packing)
        data = self.roster(self.asha)
        self.assertEqual([d["name"] for d in data["departments"]], ["Sewing", "Packing"])
        self.assertEqual(set(self.states(data, "Packing")), {"PACK1"})

    def test_roster_helper_matches_the_endpoint(self):
        self.dept(self.asha, self.sewing)
        ((dept, entries),) = department_roster(self.asha)
        self.assertEqual(dept.id, self.sewing.id)
        self.assertEqual(len(entries), 4)

    def test_unknown_manager_is_a_404(self):
        self.assertEqual(self.call("get", "/api/department-managers/999999/department-employees").status_code, 404)


class RemoveAndRestoreTests(_World):
    def test_removing_an_employee_takes_them_out_of_the_hods_coverage(self):
        self.dept(self.asha, self.sewing)
        r = self.remove(self.asha, self.e1)
        self.assertEqual(r.status_code, 201, r.content)
        self.assertEqual(r.json()["removed"], 1)
        self.assertTrue(ManagerEmployeeExclusion.objects.filter(manager=self.asha, employee=self.e1).exists())
        self.assertNotIn(self.e1.id, managed_employee_ids(self.asha))
        # still assigned to the department, still in the department
        self.assertTrue(ManagerDepartmentAssignment.objects.filter(manager=self.asha, department=self.sewing).exists())
        self.e1.refresh_from_db()
        self.assertEqual(self.e1.department_id, self.sewing.id)

    def test_several_at_once_and_it_is_idempotent(self):
        self.dept(self.asha, self.sewing)
        self.assertEqual(self.remove(self.asha, self.e1, self.e2).status_code, 201)
        self.assertEqual(ManagerEmployeeExclusion.objects.filter(manager=self.asha).count(), 2)
        again = self.remove(self.asha, self.e1, self.e2)
        self.assertEqual(again.status_code, 200)
        self.assertEqual(ManagerEmployeeExclusion.objects.filter(manager=self.asha).count(), 2)

    def test_the_removed_employees_pending_request_leaves_that_hods_approvals(self):
        def seen_by_asha():
            r = self.client.get(
                "/api/manager/pending-requests", **_bearer({"role": "employee", "employeeId": self.asha.employee_id})
            )
            self.assertEqual(r.status_code, 200, r.content)
            return {row["employee"]["employeeCode"] for row in r.json()["leaveRequests"]}

        self.dept(self.asha, self.sewing)
        leave = LeaveRequest.objects.create(
            employee=self.e1,
            type="Casual",
            start_date="2026-10-05",
            end_date="2026-10-05",
            reason="x",
            status="pending",
        )
        self.assertEqual(seen_by_asha(), {"EMP1"})
        self.remove(self.asha, self.e1)
        self.assertEqual(seen_by_asha(), set())
        self.assertEqual(LeaveRequest.objects.get(pk=leave.pk).status, "pending")  # untouched, now HR's to decide
        self.restore(self.asha, self.e1)
        self.assertEqual(seen_by_asha(), {"EMP1"})

    def test_a_person_outside_the_assigned_departments_is_refused(self):
        self.dept(self.asha, self.sewing)
        r = self.remove(self.asha, self.p1)
        self.assertEqual(r.status_code, 400)
        self.assertIn("not in a department", r.json()["error"])

    def test_the_head_cannot_be_removed_from_their_own_list(self):
        self.dept(self.asha, self.sewing)
        r = self.remove(self.asha, self.asha.employee)
        self.assertEqual(r.status_code, 400)
        self.assertIn("department head", r.json()["error"])

    def test_one_bad_id_changes_nothing(self):
        self.dept(self.asha, self.sewing)
        r = self.remove(self.asha, self.e1, self.p1)
        self.assertEqual(r.status_code, 400)
        self.assertFalse(ManagerEmployeeExclusion.objects.exists())
        missing = self.call(
            "post", f"/api/department-managers/{self.asha.id}/excluded-employees", {"employeeIds": [self.e1.id, 999999]}
        )
        self.assertEqual(missing.status_code, 404)
        self.assertFalse(ManagerEmployeeExclusion.objects.exists())

    def test_it_needs_employee_ids(self):
        self.dept(self.asha, self.sewing)
        url = f"/api/department-managers/{self.asha.id}/excluded-employees"
        self.assertEqual(self.call("post", url, {}).status_code, 400)
        self.assertEqual(self.call("post", url, {"employeeIds": []}).status_code, 400)
        self.assertEqual(self.call("post", url, {"employeeIds": ["abc"]}).status_code, 400)
        self.assertEqual(self.call("post", url, {"employeeId": self.e1.id}).status_code, 201)  # a single id works too

    def test_removing_someone_also_assigned_individually_drops_that_too(self):
        self.dept(self.asha, self.sewing)
        self.direct(self.asha, self.e1)
        r = self.remove(self.asha, self.e1)
        self.assertEqual(r.status_code, 201)
        self.assertEqual(r.json()["alsoUnassigned"], 1)
        self.assertFalse(ManagerEmployeeAssignment.objects.filter(manager=self.asha, employee=self.e1).exists())
        self.assertNotIn(self.e1.id, managed_employee_ids(self.asha))

    def test_unknown_manager_is_a_404(self):
        r = self.call("post", "/api/department-managers/999999/excluded-employees", {"employeeIds": [self.e1.id]})
        self.assertEqual(r.status_code, 404)

    def test_restoring_puts_them_back(self):
        self.dept(self.asha, self.sewing)
        self.remove(self.asha, self.e1)
        r = self.restore(self.asha, self.e1)
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual((r.json()["restored"], r.json()["reportingElsewhere"]), (1, []))
        self.assertIn(self.e1.id, managed_employee_ids(self.asha))
        self.assertEqual(self.states(self.roster(self.asha), "Sewing")["EMP1"], "reporting")

    def test_restoring_says_when_someone_else_now_has_them(self):
        self.dept(self.asha, self.sewing)
        self.remove(self.asha, self.e1)
        self.direct(self.bala, self.e1)
        r = self.restore(self.asha, self.e1)
        self.assertEqual(r.json()["reportingElsewhere"], [self.e1.id])
        self.assertEqual(self.states(self.roster(self.asha), "Sewing")["EMP1"], "elsewhere")

    def test_restoring_someone_who_was_not_removed_is_a_404(self):
        self.dept(self.asha, self.sewing)
        self.assertEqual(self.restore(self.asha, self.e1).status_code, 404)

    def test_removing_the_department_clears_its_carve_outs(self):
        self.dept(self.asha, self.sewing)
        self.dept(self.asha, self.packing)
        self.remove(self.asha, self.e1, self.p1)
        r = self.call(
            "delete", f"/api/department-managers/{self.asha.id}/departments", {"departmentId": self.sewing.id}
        )
        self.assertEqual(r.status_code, 204)
        self.assertEqual(
            set(ManagerEmployeeExclusion.objects.values_list("employee_id", flat=True)), {self.p1.id}
        )  # Packing's carve-out stays
        # giving Sewing back starts with everyone in it
        again = self.call(
            "post", f"/api/department-managers/{self.asha.id}/departments", {"departmentId": self.sewing.id}
        )
        self.assertEqual(again.status_code, 201, again.content)
        self.assertIn(self.e1.id, managed_employee_ids(self.asha))

    def test_assigning_someone_individually_supersedes_the_carve_out(self):
        self.dept(self.asha, self.sewing)
        self.remove(self.asha, self.e1)
        r = self.call("post", f"/api/department-managers/{self.asha.id}/employees", {"employeeId": self.e1.id})
        self.assertEqual(r.status_code, 201, r.content)
        self.assertFalse(ManagerEmployeeExclusion.objects.exists())
        self.assertIn(self.e1.id, managed_employee_ids(self.asha))

    def test_deleting_the_hod_or_the_employee_leaves_no_orphans(self):
        self.dept(self.asha, self.sewing)
        self.remove(self.asha, self.e1)
        self.e1.delete()
        self.assertFalse(ManagerEmployeeExclusion.objects.exists())
        self.remove(self.asha, self.e2)
        self.asha.delete()
        self.assertFalse(ManagerEmployeeExclusion.objects.exists())

    def test_the_hod_list_reports_how_many_were_removed(self):
        self.dept(self.asha, self.sewing)
        self.remove(self.asha, self.e1, self.e2)
        r = self.call("get", "/api/department-managers")
        row = next(m for m in r.json() if m["id"] == self.asha.id)
        self.assertEqual(row["removedCount"], 2)
        self.assertEqual(row["employeeCount"], 2)  # Asha herself and e3


class ReportsAgreeTests(_World):
    def test_the_hod_directory_counts_only_the_people_still_covered(self):
        self.dept(self.asha, self.sewing)
        self.remove(self.asha, self.e1)
        r = self.client.get("/api/reports/run/hod-directory", {"state": "all"}, **_hr())
        self.assertEqual(r.status_code, 200, r.content[:300])
        row = next(x for x in r.json()["rows"] if x["employeeCode"] == "ASHA")
        managed, _ = coverage(self.asha)
        active = set(Employee.objects.filter(id__in=managed, status="active").values_list("id", flat=True))
        self.assertEqual(row["teamSize"], len(active - {self.asha.employee_id}))
        self.assertEqual(row["teamSize"], 2)  # e2, e3

    def test_the_conflict_report_does_not_flag_a_carved_out_holder(self):
        self.dept(self.asha, self.sewing)
        self.dept(self.bala, self.sewing)
        before = self.client.get("/api/reports/run/hod-conflicts", {}, **_hr())
        self.assertEqual(before.status_code, 200, before.content[:300])
        self.remove(self.asha, self.e1, self.e2, self.e3)
        after = self.client.get("/api/reports/run/hod-conflicts", {}, **_hr())
        self.assertEqual(after.status_code, 200, after.content[:300])
        flagged = lambda body: {r["employeeCode"] for r in body.json()["rows"] if not r.get("_kind")}  # noqa: E731
        self.assertTrue({"EMP1", "EMP2", "EMP3"} <= flagged(before))
        self.assertFalse({"EMP1", "EMP2", "EMP3"} & flagged(after))

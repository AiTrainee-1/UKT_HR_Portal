"""Batched lookups on list endpoints (query-performance round, 2026-11-05).

A list must cost the same number of queries whatever the number of its rows, and the batched answer must equal what the
one-row-at-a-time lookup gave: salary slips (leave balances), permissions (monthly-cap positions), On-Duty sessions
(pending punch counts, map punches), Department Heads (assignments), the day's late count and Attendance Search (shift
assignments, punches) and the CTC list (branch settings).

Run via: python manage.py test api.tests_query_batching
"""

from datetime import date, time
from decimal import Decimal

from django.db import connection
from django.test import TestCase
from django.test.utils import CaptureQueriesContext

from .attendance_final import permission_cap_status
from .attendance_views import _late_count
from .jwt_utils import sign_token
from .leave_views import _CapStatusCache
from .manager_views import _manager_json
from .models import (
    AttendanceLog,
    Branch,
    Department,
    DepartmentManager,
    Employee,
    EmployeePermission,
    EmployeeShiftAssignment,
    HRUser,
    LeaveBalance,
    LeaveType,
    ManagerDepartmentAssignment,
    OnDutyPunchVerification,
    OnDutySession,
    PayrollSettings,
    SalarySlip,
    ShiftTemplate,
)
from .salary_slip_views import leave_balances_for, slip_json

MON = date(2026, 10, 12)


def _count(fn):
    """(number of queries fn ran, its result)."""
    with CaptureQueriesContext(connection) as ctx:
        result = fn()
    return len(ctx.captured_queries), result


def _get_count(client, url, headers):
    """(queries of a GET, the response), measured on a second call: the first one also warms per-process caches."""
    client.get(url, **headers)
    return _count(lambda: client.get(url, **headers))


def _hr_headers(username="qb_admin"):
    user, _ = HRUser.objects.get_or_create(username=username, defaults={"password_hash": "x", "is_super_admin": True})
    return {"HTTP_AUTHORIZATION": f"Bearer {sign_token({'role': 'hr', 'hrUserId': user.id})}"}


def _emp_headers(emp):
    return {"HTTP_AUTHORIZATION": f"Bearer {sign_token({'role': 'employee', 'employeeId': emp.id})}"}


def _employee(code, **kw):
    kw.setdefault("employment_type", "staff")
    return Employee.objects.create(employee_code=code, first_name="Q", last_name=code, status="active", **kw)


class SalarySlipBalanceTests(TestCase):
    @classmethod
    def setUpTestData(cls):
        cls.hr = _hr_headers()
        cls.casual = LeaveType.objects.create(name="Casual", code="QBCL")
        cls.sick = LeaveType.objects.create(name="Sick", code="QBSL")

    def add_employees(self, start, n):
        out = []
        for i in range(start, start + n):
            emp = _employee(f"QS{i:02d}")
            for year in (2025, 2026):
                SalarySlip.objects.create(employee=emp, month=10, year=year, slip_number=f"QB/{i}/{year}")
                LeaveBalance.objects.create(
                    employee=emp, leave_type=self.casual, year=year, allocated=12, used=i, remaining=12 - i
                )
                LeaveBalance.objects.create(
                    employee=emp, leave_type=self.sick, year=year, allocated=6, used=1, remaining=5
                )
            out.append(emp)
        return out

    def test_batched_balances_equal_the_single_slip_lookup(self):
        self.add_employees(0, 3)
        _employee("QSNONE")  # no slip: never asked for
        slips = list(SalarySlip.objects.select_related("employee").order_by("id"))
        balances = leave_balances_for(slips)
        for s in slips:
            self.assertEqual(slip_json(s, balances=balances), slip_json(s))
        self.assertEqual([b["leaveCode"] for b in balances[(slips[0].employee_id, 2026)]], ["QBCL", "QBSL"])

    def test_a_slip_without_balances_gets_an_empty_list(self):
        emp = _employee("QSBARE")
        slip = SalarySlip.objects.create(employee=emp, month=10, year=2026, slip_number="QB/BARE")
        self.assertEqual(slip_json(slip, balances=leave_balances_for([slip]))["leaveBalances"], [])

    def test_the_hr_list_costs_the_same_queries_for_more_slips(self):
        self.add_employees(0, 2)
        few, r = _get_count(self.client, "/api/salary-slips", self.hr)
        self.assertEqual((r.status_code, len(r.json())), (200, 4))
        self.add_employees(2, 4)
        many, r = _get_count(self.client, "/api/salary-slips", self.hr)
        self.assertEqual((r.status_code, len(r.json())), (200, 12))
        self.assertEqual(many, few)
        self.assertEqual([b["used"] for b in r.json()[0]["leaveBalances"]], [0.0, 1.0])

    def test_my_salary_slips_cost_the_same_queries_for_more_slips(self):
        emp = self.add_employees(0, 1)[0]
        few, r = _get_count(self.client, "/api/my/salary-slips", _emp_headers(emp))
        self.assertEqual(len(r.json()), 2)
        for month in (7, 8, 9):
            SalarySlip.objects.create(employee=emp, month=month, year=2026, slip_number=f"QB/MINE/{month}")
        many, r = _get_count(self.client, "/api/my/salary-slips", _emp_headers(emp))
        self.assertEqual(len(r.json()), 5)
        self.assertEqual(many, few)
        paged = self.client.get("/api/my/salary-slips?page=1&pageSize=2", **_emp_headers(emp)).json()
        self.assertEqual(len(paged["items"][0]["leaveBalances"]), 2)


class PermissionCapCacheTests(TestCase):
    @classmethod
    def setUpTestData(cls):
        cls.hr = _hr_headers()
        ps = PayrollSettings.get()
        ps.permission_monthly_cap = 2
        ps.save()
        cls.cap = 2

    def add_employee(self, code):
        emp = _employee(code)
        for d, status in (
            (date(2026, 9, 3), "approved"),
            (date(2026, 10, 2), "approved"),
            (date(2026, 10, 2), "approved"),  # same day: the id decides the order
            (date(2026, 10, 9), "pending"),
            (date(2026, 10, 20), "approved"),  # third approved in October: excess at a cap of 2
            (date(2026, 10, 30), "rejected"),
        ):
            EmployeePermission.objects.create(employee=emp, date=d, status=status, type="morning_late_in")
        return emp

    def perms(self):
        return list(EmployeePermission.objects.order_by("-date", "-id"))

    def test_primed_and_unprimed_answers_equal_the_per_row_rule(self):
        for code in ("QP1", "QP2", "QP3"):
            self.add_employee(code)
        perms = self.perms()
        expected = [permission_cap_status(p, self.cap) for p in perms]
        primed = _CapStatusCache(self.cap)
        primed.prime(perms)
        self.assertEqual([primed.status(p) for p in perms], expected)
        lazy = _CapStatusCache(self.cap)
        self.assertEqual([lazy.status(p) for p in perms], expected)
        self.assertIn("excess", expected)
        self.assertIn("within_cap", expected)

    def test_a_primed_page_is_one_query_and_then_none(self):
        for code in ("QP1", "QP2"):
            self.add_employee(code)
        perms = self.perms()
        cache = _CapStatusCache(self.cap)
        n, _ = _count(lambda: cache.prime(perms))
        self.assertEqual(n, 1)
        n, _ = _count(lambda: [cache.status(p) for p in perms])
        self.assertEqual(n, 0)

    def test_an_unprimed_cache_costs_one_query_per_month_not_per_employee(self):
        for code in ("QP1", "QP2", "QP3", "QP4"):
            self.add_employee(code)
        cache = _CapStatusCache(self.cap)
        n, _ = _count(lambda: [cache.status(p) for p in self.perms()][-1])
        self.assertEqual(n, 1 + 2)  # the list itself, then September and October

    def test_the_permissions_list_costs_the_same_queries_for_more_employees(self):
        for code in ("QP1", "QP2"):
            self.add_employee(code)
        few, r = _get_count(self.client, "/api/permissions", self.hr)
        self.assertEqual(len(r.json()), 12)
        for code in ("QP3", "QP4", "QP5"):
            self.add_employee(code)
        many, r = _get_count(self.client, "/api/permissions", self.hr)
        self.assertEqual(len(r.json()), 30)
        self.assertEqual(many, few)
        by_id = {row["id"]: row["capStatus"] for row in r.json()}
        self.assertEqual(by_id, {p.id: permission_cap_status(p, self.cap) for p in EmployeePermission.objects.all()})


class OnDutyListTests(TestCase):
    @classmethod
    def setUpTestData(cls):
        cls.hr = _hr_headers()

    def add_session(self, code, status="pending_hr", punches=(("pending", 2), ("approved", 1), ("pending", 3))):
        emp = _employee(code, location_tracking_enabled=False)
        session = OnDutySession.objects.create(employee=emp, destination="Site", status=status, approval_trail=[])
        for v_status, number in punches:
            OnDutyPunchVerification.objects.create(
                session=session,
                employee=emp,
                punch_date=MON,
                punch_time=time(9 + number, 0),
                punch_type="IN" if number % 2 else "OUT",
                punch_number=number,
                latitude=11.0,
                longitude=77.0,
                photo="x.jpg",
                status=v_status,
            )
        return session

    def test_pending_punch_counts_cost_no_query_per_session(self):
        self.add_session("QO1")
        self.add_session("QO2", punches=())
        few, r = _get_count(self.client, "/api/on-duty-sessions?status=all", self.hr)
        self.assertEqual(sorted(row["pendingPunchCount"] for row in r.json()), [0, 2])
        for code in ("QO3", "QO4", "QO5"):
            self.add_session(code)
        many, r = _get_count(self.client, "/api/on-duty-sessions?status=all", self.hr)
        self.assertEqual(len(r.json()), 5)
        self.assertEqual(many, few)

    def test_a_single_session_still_counts_its_own_pending_punches(self):
        from .geo_attendance_views import _on_duty_session_dict

        session = OnDutySession.objects.get(pk=self.add_session("QO1").pk)
        self.assertEqual(_on_duty_session_dict(session)["pendingPunchCount"], 2)

    def test_the_map_lists_punches_in_order_without_a_query_per_session(self):
        for code in ("QM1", "QM2"):
            self.add_session(code, status="active")
        few, r = _get_count(self.client, "/api/on-duty-map", self.hr)
        employees = r.json()["employees"]
        self.assertEqual(len(employees), 2)
        self.assertEqual([p["punchNumber"] for p in employees[0]["punches"]], [1, 2, 3])
        for code in ("QM3", "QM4", "QM5"):
            self.add_session(code, status="active")
        many, r = _get_count(self.client, "/api/on-duty-map", self.hr)
        self.assertEqual(len(r.json()["employees"]), 5)
        self.assertEqual(many, few)


class DepartmentManagerListTests(TestCase):
    def test_the_list_equals_each_managers_own_json_without_per_manager_assignment_joins(self):
        hr = _hr_headers()
        for i in range(3):
            dept = Department.objects.create(name=f"QD{i}")
            _employee(f"QDM{i}A", department=dept)
            head = _employee(f"QDH{i}", department=dept)
            m = DepartmentManager.objects.create(employee=head)
            ManagerDepartmentAssignment.objects.create(manager=m, department=dept)
        with CaptureQueriesContext(connection) as ctx:
            rows = self.client.get("/api/department-managers", **hr).json()
        self.assertEqual(len(rows), 3)
        joins = [
            q["sql"]
            for q in ctx.captured_queries
            if 'FROM "manager_department_assignments" INNER JOIN "departments"' in q["sql"]
            or 'FROM "manager_employee_assignments" INNER JOIN "employees"' in q["sql"]
        ]
        self.assertEqual(joins, [])
        for row in rows:
            self.assertEqual(row, _manager_json(DepartmentManager.objects.get(pk=row["id"])))
            self.assertEqual(row["departmentCount"], 1)


class ShiftLookupBatchTests(TestCase):
    @classmethod
    def setUpTestData(cls):
        settings = PayrollSettings.get()
        settings.morning_late_in_enabled = True
        settings.save()
        cls.hr = _hr_headers()
        cls.shift = ShiftTemplate.objects.create(
            name="Nine",
            shift_type="staff",
            start_time=time(9, 0),
            end_time=time(18, 0),
            grace_period_minutes=10,
            first_half_end=time(13, 0),
            lunch_duration_minutes=60,
            lunch_grace_minutes=10,
        )
        cls.old_shift = ShiftTemplate.objects.create(
            name="Old", shift_type="staff", start_time=time(10, 0), end_time=time(19, 0), grace_period_minutes=10
        )

    def add_employees(self, start, n, late=True):
        for i in range(start, start + n):
            emp = _employee(f"QL{i:02d}")
            # An older assignment that the newer one replaces from 2026: the latest start in force wins.
            EmployeeShiftAssignment.objects.create(employee=emp, shift=self.old_shift, effective_from=date(2020, 1, 1))
            EmployeeShiftAssignment.objects.create(employee=emp, shift=self.shift, effective_from=date(2026, 1, 1))
            punch = time(9, 20) if late and i % 2 == 0 else time(8, 55)
            AttendanceLog.objects.create(employee=emp, date=MON, punch_time=punch, punch_type="IN", source="test")
            AttendanceLog.objects.create(
                employee=emp, date=MON, punch_time=time(18, 5), punch_type="OUT", source="test"
            )

    def test_the_late_count_costs_the_same_queries_for_more_employees(self):
        self.add_employees(0, 2)
        few, late = _count(lambda: _late_count(MON))
        self.assertEqual(late, 1)
        self.add_employees(2, 4)
        many, late = _count(lambda: _late_count(MON))
        self.assertEqual(late, 3)
        self.assertEqual(many, few)

    def test_attendance_search_costs_the_same_queries_for_more_matches(self):
        self.add_employees(0, 2)
        url = f"/api/attendance/search?query=QL&date={MON.isoformat()}"
        few, r = _get_count(self.client, url, self.hr)
        body = r.json()
        self.assertEqual(body["count"], 2)
        first = body["results"][0]
        self.assertEqual(first["shift"]["name"], "Nine")
        self.assertEqual([p["time"] for p in first["punches"] if p], ["09:20:00", "18:05:00"])
        self.assertEqual(first["totalPunches"], 2)
        self.add_employees(2, 4)
        many, r = _get_count(self.client, url, self.hr)
        self.assertEqual(r.json()["count"], 6)
        self.assertEqual(many, few)


class CompensationListTests(TestCase):
    def test_settings_are_resolved_once_per_branch_not_per_employee(self):
        hr = _hr_headers()
        branches = [Branch.objects.create(name=f"QB{i}", code=f"QB{i}") for i in range(2)]

        def add(start, n):
            for i in range(start, start + n):
                _employee(f"QC{i:02d}", branch=branches[i % 2], salary_amount=Decimal("20000"))

        add(0, 2)
        few, r = _get_count(self.client, "/api/compensation", hr)
        self.assertEqual(r.json()["count"], 2)
        add(2, 6)
        many, r = _get_count(self.client, "/api/compensation", hr)
        self.assertEqual(r.json()["count"], 8)
        self.assertEqual(many, few)

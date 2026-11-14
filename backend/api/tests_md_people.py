"""MD assistant · questions about one employee and the people of one day (md_portal/analytics/people.py).

Run:  DB_TEST_NAME=test_uktex_md_people python manage.py test api.tests_md_people --noinput

Today is Monday 2026-10-05, 12:00.
  Stitching (Unit A): Surya M 30020 (shift 09:00-18:00, grace 10), Surya K 30021, Ravi Kumar 30022
  Cutting (Unit A):   Asha 30030
  Today: Surya M punched 09:25 (15 min late, his day stored as Late), Ravi 09:00; Asha approved CL; Surya K nothing.
  Last week: Surya M absent on Wednesday 30 Sep, leave 1-2 Oct approved; one rejected permission.
  Salary: Surya M September 20,000 earned + 500 overtime, PF 1,200, net 19,300, marked paid.
"""

from contextlib import ExitStack, contextmanager
from datetime import date, time
from decimal import Decimal
from unittest import mock

from .md_portal.analytics import people as PE
from .md_portal.assistant.registry import all_tools
from .md_portal.assistant.routing import declarations_for, select_areas
from .md_portal.common import read_only_db
from .models import (
    AttendanceDayRecord,
    AttendanceLog,
    Branch,
    CasualLeaveRequest,
    Department,
    Employee,
    EmployeePermission,
    EmployeeShiftAssignment,
    LeaveRequest,
    Payroll,
    SalarySlip,
    ShiftTemplate,
)
from .tests_md_support import MdApiTestCase

TODAY = date(2026, 10, 5)


@contextmanager
def at(day: date = TODAY):
    with ExitStack() as stack:
        stack.enter_context(mock.patch.object(PE, "ist_today", return_value=day))
        from .md_portal import common as C

        stack.enter_context(mock.patch.object(C, "ist_today", return_value=day))
        yield


class PeopleTests(MdApiTestCase):
    def setUp(self):
        super().setUp()
        unit = Branch.objects.create(name="Unit A")
        stitching = Department.objects.create(name="Stitching", branch=unit)
        cutting = Department.objects.create(name="Cutting", branch=unit)
        shift = ShiftTemplate.objects.create(
            name="Day",
            shift_type="staff",
            start_time=time(9, 0),
            end_time=time(18, 0),
            grace_period_minutes=10,
            first_half_end=time(13, 0),
            lunch_duration_minutes=60,
            lunch_grace_minutes=10,
        )

        def emp(code, first, last, dept):
            e = Employee.objects.create(
                employee_code=code,
                first_name=first,
                last_name=last,
                department=dept,
                branch=unit,
                employment_type="staff",
                status="active",
                join_date="2024-01-01",
                salary_amount=Decimal("20000"),
                phone="9000000001",
            )
            EmployeeShiftAssignment.objects.create(employee=e, shift=shift, effective_from=date(2024, 1, 1))
            return e

        self.surya = emp("30020", "SURYA", "M", stitching)
        self.surya_k = emp("30021", "SURYA", "K", stitching)
        self.ravi = emp("30022", "RAVI", "KUMAR", stitching)
        self.asha = emp("30030", "ASHA", "", cutting)

        for e, t in ((self.surya, time(9, 25)), (self.ravi, time(9, 0))):
            AttendanceLog.objects.create(employee=e, date=TODAY, punch_time=t, punch_type="IN", source="test")
        AttendanceDayRecord.objects.create(
            employee=self.surya,
            date=TODAY,
            status="present",
            is_late=True,
            shifts_earned=Decimal("1.00"),
            first_punch=time(9, 25),
            late_reason="Morning Late-In: first punch 09:25 is after the deadline 09:10",
        )
        AttendanceDayRecord.objects.create(
            employee=self.ravi, date=TODAY, status="present", shifts_earned=Decimal("1.00"), first_punch=time(9, 0)
        )
        CasualLeaveRequest.objects.create(employee=self.asha, date=TODAY, status="approved")
        AttendanceDayRecord.objects.create(
            employee=self.surya, date=date(2026, 9, 30), status="absent", shifts_earned=Decimal("0")
        )
        LeaveRequest.objects.create(
            employee=self.surya,
            type="sick",
            start_date="2026-10-01",
            end_date="2026-10-02",
            total_days=2,
            status="approved",
        )
        EmployeePermission.objects.create(
            employee=self.surya, date=date(2026, 10, 3), type="morning_late_in", status="rejected"
        )
        SalarySlip.objects.create(
            employee=self.surya,
            month=9,
            year=2026,
            slip_number="P/30020/202609",
            basic=Decimal("10000"),
            hra=Decimal(0),
            allowances=Decimal(0),
            incentives=Decimal(0),
            bonuses=Decimal(0),
            ot_amount=Decimal("500"),
            gross_salary=Decimal("20000"),
            pf_deduction=Decimal("1200"),
            esi_deduction=Decimal(0),
            advance_deduction=Decimal(0),
            other_deductions=Decimal(0),
            total_deductions=Decimal("1200"),
            net_salary=Decimal("19300"),
            working_days=26,
            present_days=Decimal(26),
            absent_days=Decimal(0),
            breakdown_details={
                "summary": {"effectivePaidDays": 26.0, "lateDays": 2},
                "deductions": {"lateShiftPenalty": 0},
            },
        )
        Payroll.objects.create(
            employee=self.surya,
            salary_mode="monthly",
            month=9,
            year=2026,
            base_salary=Decimal("20000"),
            gross_salary=Decimal("20000"),
            deductions=Decimal("1200"),
            final_salary=Decimal("19300"),
            status="paid",
            payment_status="paid",
        )
        self.tools = all_tools()

    def run_tool(self, name, **args):
        with at(), read_only_db():
            return self.tools[name].run(args)

    # finding the person

    def test_a_code_finds_exactly_that_person(self):
        found, others = PE.find_person("30020")
        self.assertEqual((found.pk, others), (self.surya.pk, []))

    def test_a_full_name_finds_the_one_person_and_a_shared_first_name_asks_which(self):
        self.assertEqual(PE.find_person("Surya M")[0].pk, self.surya.pk)
        self.assertEqual(PE.find_person("ravi kumar")[0].pk, self.ravi.pk)
        body = self.run_tool("employee_attendance", employee="Surya")
        self.assertFalse(body["found"])
        self.assertEqual(sorted(m["code"] for m in body["matches"]), ["30020", "30021"])
        self.assertIn("Ask the MD which one", body["note"])

    def test_nobody_is_said_plainly(self):
        body = self.run_tool("employee_leave", employee="Nobody Here")
        self.assertEqual((body["found"], body["matches"]), (False, []))
        self.assertIn("No employee matches", body["note"])

    # one person

    def test_attendance_day_by_day_with_totals(self):
        body = self.run_tool("employee_attendance", employee="30020", period="last_7_days")
        self.assertEqual(body["employee"]["code"], "30020")
        self.assertEqual(body["employee"]["department"], "Stitching")
        days = {d["date"]: d for d in body["days"]}
        self.assertEqual(days["2026-10-05"]["status"], "Present")
        self.assertTrue(days["2026-10-05"]["late"])
        self.assertEqual(days["2026-10-05"]["firstIn"], "09:25")
        self.assertEqual(days["2026-09-30"]["status"], "Absent")
        self.assertEqual(days["2026-10-01"]["status"], "On leave")
        self.assertEqual(days["2026-10-04"]["status"], "Day off")  # a Sunday
        self.assertEqual(body["summary"]["late"], 1)
        self.assertEqual(body["summary"]["onLeave"], 2)
        self.assertNotIn("9000000001", str(body))

    def test_leave_with_casual_leave_and_permissions(self):
        body = self.run_tool("employee_leave", employee="SURYA M", period="last_7_days")
        self.assertEqual(body["summary"]["leaveDaysApproved"], 2.0)
        self.assertEqual(body["leave"][0]["type"], "Sick")
        self.assertEqual(body["permissions"][0]["status"], "rejected")
        asha = self.run_tool("employee_leave", employee="30030", period="today")
        self.assertEqual(asha["summary"]["casualLeaveDaysApproved"], 1.0)

    def test_salary_slips_with_each_deduction(self):
        body = self.run_tool("employee_salary", employee="30020")
        self.assertEqual(body["monthlySalary"], 20000.0)
        slip = body["slips"][0]
        self.assertEqual(
            (slip["month"], slip["grossPay"], slip["deductions"]["pf"], slip["netPay"], slip["markedPaid"]),
            ("2026-09", 20500.0, 1200.0, 19300.0, True),
        )
        # Cleared alone is only "verified" since the 2026-11-10 month workflow: paid is the payment status
        Payroll.objects.filter(employee=self.surya, month=9).update(payment_status="not_paid")
        cleared_only = self.run_tool("employee_salary", employee="30020")["slips"][0]
        self.assertFalse(cleared_only["markedPaid"])
        none = self.run_tool("employee_salary", employee="30022")
        self.assertEqual(none["slips"], [])
        self.assertIn("No salary slip", none["notes"][0])

    # the people of one day

    def test_who_was_late_today_in_a_department(self):
        body = self.run_tool("attendance_people_on_date", status="late", department="Stitching")
        self.assertEqual([(p["name"], p["code"], p["minutesLate"]) for p in body["people"]], [("SURYA M", "30020", 15)])
        self.assertEqual(body["counts"]["due"], 3)
        self.assertEqual(body["counts"]["present"], 2)
        self.assertEqual(body["counts"]["absent"], 1)

    def test_absent_and_cl_lists(self):
        absent = self.run_tool("attendance_people_on_date", status="absent")
        self.assertEqual([p["code"] for p in absent["people"]], ["30021"])
        cl = self.run_tool("attendance_people_on_date", status="cl")
        self.assertEqual([p["code"] for p in cl["people"]], ["30030"])

    def test_the_person_tools_are_always_described_in_full(self):
        declared = {d["name"]: d for d in declarations_for(self.tools, select_areas("what about Surya M?"))}
        for name in ("employee_attendance", "employee_leave", "employee_salary", "attendance_people_on_date"):
            self.assertEqual(declared[name]["description"], self.tools[name].description, name)

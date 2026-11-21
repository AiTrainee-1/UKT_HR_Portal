"""
HR Analytics (/hr/analytics, owner brief 2026-11-21): every check counts the records behind it, thresholds scale with the
period, levels follow the thresholds, the filters narrow the list, and a day whose punches never arrived is no absence.

Run via: python manage.py test api.tests_hr_analytics
"""

from datetime import date, datetime, time, timedelta
from decimal import Decimal

from django.test import TestCase
from django.utils import timezone

from . import approval_workflow as approval
from .clock import FACTORY_TZ
from .hr_analytics import categories as C
from .hr_analytics.collect import _night_minutes
from .hr_analytics.period import Filters
from .jwt_utils import sign_token
from .models import (
    AttendanceDayRecord,
    AttendanceOverrideRequest,
    Branch,
    CasualLeaveRequest,
    Department,
    DepartmentManager,
    Employee,
    EmployeePermission,
    HRUser,
    LeaveRequest,
    ManagerEmployeeAssignment,
    MissingPunchRequest,
    OnDutyPunchVerification,
    OnDutySession,
    Role,
)

OCT = {"from": "2026-10-01", "to": "2026-10-31"}


def _auth(user) -> dict:
    return {"HTTP_AUTHORIZATION": f"Bearer {sign_token({'role': 'hr', 'hrUserId': user.id})}"}


def _at(day: date, hh: int = 9) -> datetime:
    return datetime.combine(day, time(hh, 0), tzinfo=FACTORY_TZ)


class AnalyticsFixture(TestCase):
    def setUp(self):
        approval.clear_cache()
        self.admin = HRUser.objects.create(username="an_admin", password_hash="x", is_super_admin=True)
        self.ho = Branch.objects.create(name="AN Head Office", code="ANHO", is_head_office=True)
        self.u2 = Branch.objects.create(name="AN Unit 2", code="ANU2")
        self.it = Department.objects.create(name="AN IT", branch=self.ho)
        self.sewing = Department.objects.create(name="AN Sewing", branch=self.ho)
        self.asha = self.emp("AN1", "Asha", dept=self.it)
        self.bala = self.emp("AN2", "Bala", dept=self.it)
        self.ravi = self.emp("AN3", "Ravi", kind="production", dept=self.sewing)
        self.mani = self.emp("AN4", "Mani", kind="production", dept=self.sewing)
        self.boss = self.emp("AN9", "Boss", dept=self.it)

    def emp(self, code, first, kind="staff", dept=None, branch=None):
        return Employee.objects.create(
            employee_code=code,
            first_name=first,
            last_name="An",
            employment_type=kind,
            status="active",
            branch=branch or self.ho,
            department=dept,
        )

    def day(self, emp, d, status="present", **kw):
        return AttendanceDayRecord.objects.create(employee=emp, date=d, status=status, **kw)

    def get(self, path, user=None, **params):
        return self.client.get(f"/api/hr-analytics/{path}", params, **_auth(user or self.admin))

    def body(self, path, user=None, **params):
        r = self.get(path, user, **params)
        self.assertEqual(r.status_code, 200, r.content)
        return r.json()

    def emp_row(self, body, emp):
        return next((e for e in body["employees"] if e["id"] == emp.id), None)

    def stamp(self, obj, day: date, hh: int = 9):
        type(obj).objects.filter(pk=obj.pk).update(created_at=_at(day, hh))


class ThresholdAndLevelTests(TestCase):
    def test_a_monthly_threshold_scales_with_the_period(self):
        late = C.by_key("staff", "late")
        month = Filters(type="staff", start=date(2026, 10, 1), end=date(2026, 10, 31))
        week = Filters(type="staff", start=date(2026, 10, 5), end=date(2026, 10, 11))
        quarter = Filters(type="staff", start=date(2026, 8, 1), end=date(2026, 10, 31))
        self.assertEqual((C.threshold(late, month), C.threshold(late, week), C.threshold(late, quarter)), (4, 1, 12))
        custom = Filters(type="staff", start=date(2026, 10, 1), end=date(2026, 10, 31), overrides={"late": 10})
        self.assertEqual(C.threshold(late, custom), 10)

    def test_levels(self):
        f = Filters(type="staff", start=date(2026, 10, 1), end=date(2026, 10, 30))  # 30 days: late threshold 4
        self.assertEqual(C.level({}, "staff", f)[0], "ok")
        self.assertEqual(C.level({"late": 1}, "staff", f)[0], "watch")
        self.assertEqual(C.level({"late": 4}, "staff", f)[:2], ("attention", ["late"]))
        self.assertEqual(C.level({"late": 8}, "staff", f)[0], "high")
        # three flags make it high too
        self.assertEqual(C.level({"leave": 3, "permissions": 4, "missing_punch": 3}, "staff", f)[0], "high")
        # an informational check never raises the level
        pf = Filters(type="production", start=date(2026, 10, 1), end=date(2026, 10, 30))
        self.assertEqual(C.level({"late_details": 40}, "production", pf)[0], "ok")

    def test_night_minutes(self):
        self.assertEqual(_night_minutes(time(21, 0), time(5, 30)), 450)  # 22:00-05:30
        self.assertEqual(_night_minutes(time(8, 30), time(23, 30)), 90)
        self.assertEqual(_night_minutes(time(8, 30), time(17, 45)), 0)
        self.assertEqual(_night_minutes(None, time(23, 0)), 0)


class StaffCheckTests(AnalyticsFixture):
    def test_late_and_missing_punches(self):
        for d in (1, 2, 5, 6, 7):  # five late days; October's threshold is 4
            self.day(self.asha, date(2026, 10, d), is_late=True, first_punch=time(9, 40), late_reason="Bus")
        self.day(self.asha, date(2026, 10, 8), total_punches=1, first_punch=time(9, 2))  # forgot to punch out
        MissingPunchRequest.objects.create(
            employee=self.asha, date=date(2026, 10, 9), punch_time=time(18, 0), punch_type="OUT",
            punch_slot="evening_out", reason="forgot", status="approved", approval_trail=[],
        )  # fmt: skip
        body = self.body("summary", type="staff", **OCT)
        row = self.emp_row(body, self.asha)
        self.assertEqual(row["counts"]["late"], 5)
        self.assertEqual(row["counts"]["missing_punch"], 2)
        self.assertIn("late", row["flags"])
        self.assertEqual(row["level"], "attention")
        late = next(c for c in body["categories"] if c["key"] == "late")
        self.assertEqual((late["threshold"], late["flagged"], late["affected"], late["total"]), (4, 1, 1, 5))
        detail = self.body("category/late", type="staff", **OCT)["employees"][0]
        self.assertEqual(detail["records"][0]["title"], "Late · first punch 09:40")
        self.assertEqual(detail["records"][0]["detail"], "Bus")  # the engine's explanation of the late mark
        self.assertEqual(detail["pattern"]["avgFirstPunch"], "09:40")

    def test_leave_absent_on_leave_permissions_and_edits(self):
        LeaveRequest.objects.create(
            employee=self.bala, start_date="2026-10-12", end_date="2026-10-14", total_days=Decimal("3"),
            type="sick", status="approved", reason="Fever",
        )  # fmt: skip
        CasualLeaveRequest.objects.create(employee=self.bala, date=date(2026, 10, 20), status="approved", reason="Rest")
        self.day(self.bala, date(2026, 10, 13), status="absent")  # absent although the leave was approved
        self.day(self.asha, date(2026, 10, 13))  # others worked that day: the punches did arrive
        for d in (2, 3, 6, 7):  # four: October's threshold is 4
            EmployeePermission.objects.create(
                employee=self.bala, date=date(2026, 10, d), reason="School", status="approved"
            )
        AttendanceOverrideRequest.objects.create(
            employee=self.bala, date=date(2026, 10, 15), reason="device down", requested_values={"status": "present"},
            previous_values={"status": "absent"}, status="approved", approval_trail=[],
        )  # fmt: skip
        row = self.emp_row(self.body("summary", type="staff", **OCT), self.bala)
        self.assertEqual(row["counts"]["leave"], 4)
        self.assertEqual(row["counts"]["absent_on_leave"], 1)
        self.assertEqual(row["counts"]["permissions"], 4)
        self.assertEqual(row["counts"]["attendance_edits"], 1)
        # 4 leave days are over October's threshold of 3
        self.assertEqual(set(row["flags"]), {"leave", "absent_on_leave", "permissions"})

    def test_on_duty_and_on_duty_without_punches(self):
        s = OnDutySession.objects.create(employee=self.asha, destination="Bank", status="completed", approval_trail=[])
        self.stamp(s, date(2026, 10, 10))
        OnDutyPunchVerification.objects.create(
            session=s, employee=self.asha, punch_date=date(2026, 10, 10), punch_time=time(10, 0), punch_type="IN",
            punch_number=1, latitude=11.1, longitude=77.3, photo="x.jpg", status="approved",
        )  # fmt: skip
        full = OnDutySession.objects.create(
            employee=self.asha, destination="Port", status="completed", approval_trail=[]
        )
        self.stamp(full, date(2026, 10, 11))
        for n in range(1, 5):
            OnDutyPunchVerification.objects.create(
                session=full, employee=self.asha, punch_date=date(2026, 10, 11), punch_time=time(9 + n, 0),
                punch_type="IN", punch_number=n, latitude=11.1, longitude=77.3, photo="x.jpg", status="approved",
            )  # fmt: skip
        row = self.emp_row(self.body("summary", type="staff", **OCT), self.asha)
        self.assertEqual(row["counts"]["on_duty"], 2)
        self.assertEqual(row["counts"]["on_duty_no_punch"], 1)
        records = self.body("category/on_duty_no_punch", type="staff", **OCT)["employees"][0]["records"]
        self.assertEqual(records[0]["title"], "1 of 4 punches recorded")

    def test_hod_checks_and_the_hod_view(self):
        manager = DepartmentManager.objects.create(employee=self.boss)
        ManagerEmployeeAssignment.objects.create(manager=manager, employee=self.asha)
        rejected = LeaveRequest.objects.create(
            employee=self.asha, start_date="2026-10-05", end_date="2026-10-05", type="casual", status="rejected",
            approval_trail=[{"role": "hod", "decision": "rejected", "by": "Boss An", "at": _at(date(2026, 10, 2), 10).isoformat(), "comment": "Busy week"}],
        )  # fmt: skip
        self.stamp(rejected, date(2026, 10, 1))
        late_answer = MissingPunchRequest.objects.create(
            employee=self.asha, date=date(2026, 10, 3), punch_time=time(9, 0), punch_type="IN", punch_slot="morning_in",
            status="pending_hr",
            approval_trail=[{"role": "hod", "decision": "approved", "by": "Boss An", "at": _at(date(2026, 10, 7)).isoformat()}],
        )  # fmt: skip
        self.stamp(late_answer, date(2026, 10, 3))  # answered 4 days later
        correction = AttendanceOverrideRequest.objects.create(
            employee=self.asha, date=date(2026, 10, 8), reason="device down", requested_values={"status": "present"},
            previous_values={"status": "absent"}, status="approved",
            approval_trail=[
                {"role": "hr", "decision": "approved", "by": "HR", "at": _at(date(2026, 10, 9)).isoformat()},
                {"role": "hod", "decision": "approved", "by": "Boss An", "at": _at(date(2026, 10, 9), 12).isoformat()},
            ],
        )  # fmt: skip
        self.stamp(correction, date(2026, 10, 9), 8)
        body = self.body("summary", type="staff", **OCT)
        row = self.emp_row(body, self.asha)
        self.assertEqual(row["counts"]["hod_rejected"], 1)
        self.assertEqual(row["counts"]["hod_waiting"], 1)
        self.assertEqual(row["counts"]["hod_corrections"], 1)
        hod = next(h for h in body["hods"] if h["employeeId"] == self.boss.id)
        self.assertEqual((hod["decided"], hod["rejected"]), (3, 1))
        self.assertGreater(hod["avgResponseHours"], 24)
        rec = self.body("category/hod_rejected", type="staff", **OCT)["employees"][0]["records"][0]
        self.assertEqual((rec["reason"], rec["by"]), ("Busy week", "Boss An"))


class ProductionCheckTests(AnalyticsFixture):
    def test_days_off_runs_night_work_and_sundays(self):
        # Ravi: off Tue 6, Wed 7, Thu 8 (a run of 3), Sunday 11 not counted, worked the rest; nights on 13 and 14
        for d in range(1, 16):
            day = date(2026, 10, d)
            if d in (6, 7, 8, 11):
                self.day(self.ravi, day, status="absent")
            elif d in (13, 14):
                self.day(self.ravi, day, first_punch=time(21, 0), last_punch=time(5, 30), total_punches=2)
            else:
                self.day(self.ravi, day, first_punch=time(8, 30), last_punch=time(17, 45), total_punches=2)
            self.day(self.mani, day, first_punch=time(8, 30), last_punch=time(17, 45), total_punches=2)
        body = self.body("summary", type="production", **OCT)
        row = self.emp_row(body, self.ravi)
        self.assertEqual(row["counts"]["leave"], 3)
        self.assertEqual(row["counts"]["continuous_leave"], 1)
        self.assertEqual(row["counts"]["night_work"], 2)
        run = self.body("category/continuous_leave", type="production", **OCT)["employees"][0]["records"][0]
        self.assertEqual(
            (run["date"], run["endDate"], run["title"]), ("2026-10-06", "2026-10-08", "Off 3 working days in a row")
        )
        self.assertIsNone(self.emp_row(body, self.mani))
        self.assertEqual(body["hods"], [])

    def test_a_day_whose_punches_never_arrived_is_no_absence(self):
        for emp in (self.ravi, self.mani):
            self.day(emp, date(2026, 10, 6), status="absent")  # nobody worked: the devices were not synced
            self.day(emp, date(2026, 10, 7), first_punch=time(8, 30), last_punch=time(17, 45), total_punches=2)
        self.day(self.ravi, date(2026, 10, 8), status="absent")
        self.day(self.mani, date(2026, 10, 8), first_punch=time(8, 30), last_punch=time(17, 45), total_punches=2)
        body = self.body("summary", type="production", **OCT)
        self.assertEqual(body["period"]["dataGaps"], ["2026-10-06"])
        self.assertEqual(self.emp_row(body, self.ravi)["counts"], {"leave": 1})
        self.assertIsNone(self.emp_row(body, self.mani))


class FilterAndEndpointTests(AnalyticsFixture):
    def setUp(self):
        super().setUp()
        for emp in (self.asha, self.bala):
            self.day(emp, date(2026, 10, 1), is_late=True, first_punch=time(9, 30))

    def test_search_department_employee_and_branch_scope(self):
        self.assertEqual(self.body("summary", type="staff", q="asha", **OCT)["totals"]["employeesInScope"], 1)
        self.assertEqual(
            self.body("summary", type="staff", departmentId=self.it.id, **OCT)["totals"]["employeesInScope"], 3
        )
        only = self.body("summary", type="staff", employeeId=self.bala.id, **OCT)
        self.assertEqual([e["id"] for e in only["employees"]], [self.bala.id])
        other = self.emp("AN5", "Other", branch=self.u2)
        self.day(other, date(2026, 10, 1), is_late=True)
        role = Role.objects.create(name="an_scoped", permissions={"analytics": "view"})
        scoped = HRUser.objects.create(username="an_branch", password_hash="x", role=role, branch=self.u2)
        self.assertEqual([e["id"] for e in self.body("summary", scoped, type="staff", **OCT)["employees"]], [other.id])

    def test_the_employee_endpoint_and_its_timeline(self):
        d = self.body(f"employee/{self.asha.id}", type="staff", **OCT)
        self.assertEqual(d["counts"], {"late": 1})
        self.assertEqual(d["level"], "watch")
        self.assertEqual(d["timeline"][0]["category"], "late")
        self.assertEqual(set(d["categories"]), {c.key for c in C.STAFF})
        self.assertEqual(self.get(f"employee/{self.ravi.id}", type="staff", **OCT).status_code, 404)  # not staff

    def test_weekly_counts_and_bad_parameters(self):
        weeks = self.body("summary", type="staff", **OCT)["weekly"]
        self.assertEqual(weeks[0]["weekStart"], "2026-09-28")
        self.assertEqual(weeks[0]["counts"], {"late": 2})
        self.assertEqual(self.get("summary", type="nope").status_code, 400)
        self.assertEqual(
            self.get("summary", type="staff", **{"from": "2026-10-10", "to": "2026-10-01"}).status_code, 400
        )
        self.assertEqual(
            self.get("summary", type="staff", **{"from": "2024-01-01", "to": "2026-10-01"}).status_code, 400
        )
        self.assertEqual(self.get("summary", type="staff", t_late="-1").status_code, 400)
        self.assertEqual(self.get("category/night_work", type="staff").status_code, 400)
        self.assertEqual(self.get("category/nope", type="staff").status_code, 404)

    def test_the_default_period_is_this_month_and_never_goes_past_today(self):
        today = timezone.localdate()
        period = self.body("summary", type="staff", to=(today + timedelta(days=40)).isoformat())["period"]
        self.assertLessEqual(period["to"], today.isoformat())

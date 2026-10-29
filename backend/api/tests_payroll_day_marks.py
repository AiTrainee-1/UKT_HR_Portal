"""The attendance categories on the payroll details calendar (payroll_day_marks.py): late, permission, excess permission, On-Duty,
On-Duty punch and missed punch, read from the attendance records, the requests and the punches; nothing is computed or written."""

from datetime import date, datetime, time, timedelta, timezone
from decimal import Decimal
from unittest.mock import patch

from django.test import TestCase

from .jwt_utils import sign_token
from .models import (
    AttendanceDayRecord,
    AttendanceLog,
    Employee,
    EmployeePermission,
    HRUser,
    MissingPunchRequest,
    OnDutySession,
)
from .payroll_day_marks import MARK_KEYS, attach_marks, day_marks
from .payroll_views import _build_working_days, _generate_staff_payroll

IST = timezone(timedelta(hours=5, minutes=30))
MONTH, YEAR = 2, 2026
WORKING = _build_working_days(MONTH, YEAR, False, set())
START, END = date(2026, 2, 1), date(2026, 2, 28)


def _employee(code: str) -> Employee:
    return Employee.objects.create(
        employee_code=code,
        first_name=code,
        last_name="Staff",
        employment_type="staff",
        status="active",
        salary_type="monthly",
        salary_amount=Decimal("24000.00"),
    )


def _record(emp: Employee, day: date, **fields) -> AttendanceDayRecord:
    return AttendanceDayRecord.objects.create(
        employee=emp, date=day, status="present", shifts_earned=Decimal("1.00"), source="manual", **fields
    )


def _log(emp: Employee, day: date, source: str, at: time = time(9, 5)) -> AttendanceLog:
    return AttendanceLog.objects.create(employee=emp, date=day, punch_time=at, punch_type="IN", source=source)


def _session(emp: Employee, status: str, first: date, last: date | None = None, **extra) -> OnDutySession:
    start = datetime.combine(first, time(9, 0), tzinfo=IST)
    ended = datetime.combine(last, time(18, 0), tzinfo=IST) if last else None
    return OnDutySession.objects.create(
        employee=emp,
        destination="Buyer visit",
        status=status,
        started_at=start,
        employee_ended_at=ended,
        completed_at=ended if status == "completed" else None,
        **extra,
    )


class DayMarksTests(TestCase):
    @classmethod
    def setUpTestData(cls):
        cls.emp = _employee("M1")
        cls.other = _employee("M2")
        cls.d = WORKING

    def marks(self, emp=None):
        return day_marks((emp or self.emp).id, START, END)

    def test_a_late_arrival_is_a_late_mark(self):
        _record(self.emp, self.d[1], is_late=True)
        _record(self.emp, self.d[2])
        self.assertEqual(self.marks(), {self.d[1].isoformat(): ["late"]})

    def test_an_approved_permission_is_a_permission_and_a_pending_or_rejected_one_is_nothing(self):
        for day, status in ((self.d[0], "approved"), (self.d[1], "pending"), (self.d[2], "rejected")):
            EmployeePermission.objects.create(employee=self.emp, date=day, status=status, type="middle_permission")
        self.assertEqual(self.marks(), {self.d[0].isoformat(): ["permission"]})

    def test_the_flags_the_late_detection_engine_set_count_as_a_permission_too(self):
        _record(self.emp, self.d[0], morning_permission_applied=True)
        _record(self.emp, self.d[1], evening_permission_applied=True)
        _record(self.emp, self.d[2], middle_permission_today=True)
        self.assertEqual({k: v for k, v in self.marks().items()}, {d.isoformat(): ["permission"] for d in self.d[:3]})

    def test_a_permission_beyond_the_cap_is_an_excess_permission_and_not_a_permission(self):
        _record(self.emp, self.d[3], morning_permission_excess=True, is_late=True)
        EmployeePermission.objects.create(employee=self.emp, date=self.d[3], status="approved", type="morning_late_in")
        self.assertEqual(self.marks(), {self.d[3].isoformat(): ["late", "excess_permission"]})

    def test_a_day_with_a_permission_inside_the_cap_and_one_beyond_it_has_both(self):
        _record(self.emp, self.d[4], morning_permission_applied=True, evening_permission_excess=True)
        self.assertEqual(self.marks(), {self.d[4].isoformat(): ["permission", "excess_permission"]})

    def test_an_approved_missing_punch_request_and_a_punch_that_came_from_one_are_a_missed_punch(self):
        MissingPunchRequest.objects.create(
            employee=self.emp,
            date=self.d[5],
            punch_time=time(9, 0),
            punch_type="IN",
            reason="forgot",
            status="approved",
        )
        MissingPunchRequest.objects.create(
            employee=self.emp,
            date=self.d[6],
            punch_time=time(9, 0),
            punch_type="IN",
            reason="forgot",
            status="pending_hr",
        )
        _log(self.emp, self.d[7], "missing_punch:approved")
        self.assertEqual(
            self.marks(), {self.d[5].isoformat(): ["missed_punch"], self.d[7].isoformat(): ["missed_punch"]}
        )

    def test_an_approved_on_duty_punch_marks_the_day_as_an_on_duty_punch_and_an_on_duty_day(self):
        _log(self.emp, self.d[8], "on_duty:approved")
        _log(self.emp, self.d[8], "on_duty:approved", time(13, 0))
        _log(self.emp, self.d[9], "biometric")
        self.assertEqual(self.marks(), {self.d[8].isoformat(): ["on_duty", "on_duty_punch"]})

    def test_an_approved_on_duty_request_covers_every_day_from_its_start_to_its_end(self):
        _session(self.emp, "completed", date(2026, 2, 10), date(2026, 2, 12))
        self.assertEqual(
            self.marks(),
            {"2026-02-10": ["on_duty"], "2026-02-11": ["on_duty"], "2026-02-12": ["on_duty"]},
        )

    def test_an_on_duty_request_that_is_not_approved_covers_nothing(self):
        _session(self.emp, "pending_hod", date(2026, 2, 10), date(2026, 2, 11))
        _session(self.emp, "rejected", date(2026, 2, 12), date(2026, 2, 13))
        OnDutySession.objects.create(employee=self.emp, destination="x", status="active")  # no start yet
        self.assertEqual(self.marks(), {})

    def test_an_on_duty_request_is_cut_to_the_period_asked_for(self):
        _session(self.emp, "completed", date(2026, 1, 30), date(2026, 2, 2))
        self.assertEqual(self.marks(), {"2026-02-01": ["on_duty"], "2026-02-02": ["on_duty"]})

    def test_a_request_that_is_still_running_covers_up_to_today(self):
        _session(self.emp, "active", date(2026, 2, 20))
        with patch("api.payroll_day_marks.ist_today", return_value=date(2026, 2, 22)):
            self.assertEqual(
                self.marks(), {"2026-02-20": ["on_duty"], "2026-02-21": ["on_duty"], "2026-02-22": ["on_duty"]}
            )

    def test_one_employee_never_sees_anothers_marks(self):
        _record(self.other, self.d[0], is_late=True)
        EmployeePermission.objects.create(employee=self.other, date=self.d[1], status="approved")
        _session(self.other, "completed", date(2026, 2, 10), date(2026, 2, 10))
        self.assertEqual(self.marks(), {})
        self.assertEqual(len(self.marks(self.other)), 3)

    def test_marks_come_in_one_fixed_order_whatever_the_order_they_were_found_in(self):
        day = self.d[2]
        _record(self.emp, day, is_late=True, morning_permission_excess=True, evening_permission_applied=True)
        _log(self.emp, day, "missing_punch:approved")
        _log(self.emp, day, "on_duty:approved", time(12, 0))
        self.assertEqual(
            self.marks()[day.isoformat()],
            ["late", "permission", "excess_permission", "on_duty", "on_duty_punch", "missed_punch"],
        )
        self.assertEqual(list(MARK_KEYS), self.marks()[day.isoformat()])

    def test_the_number_of_queries_does_not_depend_on_the_number_of_days(self):
        for d in self.d:
            _record(self.emp, d, is_late=True)
            EmployeePermission.objects.create(employee=self.emp, date=d, status="approved")
        with self.assertNumQueries(5):
            day_marks(self.emp.id, START, END)

    def test_attach_marks_gives_every_day_a_list_and_asks_nothing_for_no_days(self):
        _record(self.emp, self.d[0], is_late=True)
        days = attach_marks(self.emp.id, [{"date": self.d[0].isoformat()}, {"date": self.d[1].isoformat()}])
        self.assertEqual([d["marks"] for d in days], [["late"], []])
        with self.assertNumQueries(0):
            self.assertEqual(attach_marks(self.emp.id, []), [])


class DetailsEndpointMarksTests(TestCase):
    """The days of GET /api/payroll/<id>/details carry the marks."""

    @classmethod
    def setUpTestData(cls):
        cls.hr = HRUser.objects.create(username="marks_admin", password_hash="x", is_super_admin=True)
        cls.emp = _employee("M9")
        cls.d = WORKING

    def test_each_day_of_the_details_says_which_categories_it_had(self):
        for n, day in enumerate(self.d):
            _record(self.emp, day, is_late=(n == 1))
        EmployeePermission.objects.create(
            employee=self.emp, date=self.d[2], status="approved", type="middle_permission"
        )
        _session(self.emp, "completed", self.d[3], self.d[3])
        with patch("api.attendance_final.ist_today", return_value=date(2026, 12, 31)):
            payroll = _generate_staff_payroll(self.emp, MONTH, YEAR)["payroll"]
        headers = {"HTTP_AUTHORIZATION": f"Bearer {sign_token({'role': 'hr', 'hrUserId': self.hr.id})}"}
        response = self.client.get(f"/api/payroll/{payroll.id}/details", **headers)
        self.assertEqual(response.status_code, 200, response.content[:300])
        by_date = {day["date"]: day["marks"] for day in response.json()["days"]}
        self.assertEqual(by_date[self.d[0].isoformat()], [])
        self.assertEqual(by_date[self.d[1].isoformat()], ["late"])
        self.assertEqual(by_date[self.d[2].isoformat()], ["permission"])
        self.assertEqual(by_date[self.d[3].isoformat()], ["on_duty"])
        self.assertEqual(len(by_date), len(self.d))

"""
"My Insights" on the mobile Home page (owner 2026-11-25): GET /api/my/analytics?months=N (mobile_analytics.py).

Pinned here: employee token only and own data only; every count read from the stored day records / requests / slips
(present, half, absent, leave, holidays, arrivals on time vs late, the average arrival against the day's shift start,
early outs, OT minutes, approved permissions and Casual Leave, On-Duty days by India date, pay per month as the Salary
page shows it); today counts only once punched; days before joining are left out; a fixed handful of queries; nothing
written.

Run via: DB_NAME=UKTex_DB_agentB python manage.py test api.tests_mobile_analytics --noinput
"""

from datetime import date, datetime, time
from decimal import Decimal
from unittest.mock import patch

from django.db import connection
from django.test import TestCase
from django.test.utils import CaptureQueriesContext

from .clock import FACTORY_TZ
from .jwt_utils import sign_token
from .mobile_analytics import month_window
from .models import (
    AttendanceDayRecord,
    CasualLeaveRequest,
    Employee,
    EmployeePermission,
    EmployeeShiftAssignment,
    HRUser,
    OnDutySession,
    SalarySlip,
    ShiftTemplate,
)

URL = "/api/my/analytics"
TODAY = date(2026, 11, 25)


def _employee(code: str, **extra) -> Employee:
    return Employee.objects.create(
        employee_code=code, first_name="Test", last_name=code, status="active", employment_type="staff",
        join_date=extra.pop("join_date", "2020-01-01"), **extra,
    )


def _as(emp) -> dict:
    return {"HTTP_AUTHORIZATION": f"Bearer {sign_token({'role': 'employee', 'employeeId': emp.id})}"}


def _hr() -> dict:
    user, _ = HRUser.objects.get_or_create(
        username="analytics_admin", defaults={"password_hash": "x", "is_super_admin": True}
    )
    return {"HTTP_AUTHORIZATION": f"Bearer {sign_token({'role': 'hr', 'hrUserId': user.id})}"}


def _day(emp, d: date, status: str, first: time | None = None, **extra) -> AttendanceDayRecord:
    return AttendanceDayRecord.objects.create(
        employee=emp, date=d, status=status, first_punch=first,
        shifts_earned=Decimal("1") if status == "present" else Decimal("0"), **extra,
    )


def _ist(y, m, d, hh=10, mm=0) -> datetime:
    return datetime(y, m, d, hh, mm, tzinfo=FACTORY_TZ)


class _Base(TestCase):
    def setUp(self):
        p = patch("api.mobile_analytics_views.ist_today", return_value=TODAY)
        p.start()
        self.addCleanup(p.stop)
        self.emp = _employee("AN1", join_date="2026-06-15")
        self.other = _employee("AN2")
        shift = ShiftTemplate.objects.create(
            name="General", start_time=time(9, 0), end_time=time(18, 0), grace_period_minutes=10
        )
        EmployeeShiftAssignment.objects.create(employee=self.emp, shift=shift, effective_from=date(2026, 1, 1))

    def get(self, headers=None, expect=200, **params):
        res = self.client.get(URL, params, **(headers if headers is not None else _as(self.emp)))
        self.assertEqual(res.status_code, expect, res.content[:400])
        return res.json()

    def month(self, body, y, m) -> dict:
        return next(p for p in body["periods"] if (p["year"], p["month"]) == (y, m))


class AccessTests(_Base):
    def test_needs_an_employee_token(self):
        self.assertEqual(self.client.get(URL).status_code, 401)
        self.get(headers=_hr(), expect=403)

    def test_months_is_checked(self):
        for bad in ("0", "13", "x", "-1", "2.5"):
            self.get(expect=400, months=bad)

    def test_default_six_months_oldest_first(self):
        body = self.get()
        self.assertEqual(body["months"], 6)
        self.assertEqual(body["today"], "2026-11-25")
        self.assertEqual(
            [(p["year"], p["month"]) for p in body["periods"]],
            [(2026, 6), (2026, 7), (2026, 8), (2026, 9), (2026, 10), (2026, 11)],
        )
        self.assertEqual([p["shortLabel"] for p in body["periods"]][-1], "Nov")
        self.assertEqual([p["current"] for p in body["periods"]], [False] * 5 + [True])
        self.assertEqual(body["shift"], {"name": "General", "start": "09:00", "end": "18:00", "graceMinutes": 10})
        self.assertEqual(len(self.get(months="3")["periods"]), 3)

    def test_month_window_crosses_the_year(self):
        self.assertEqual(month_window(date(2026, 2, 3), 4), [(2025, 11), (2025, 12), (2026, 1), (2026, 2)])

    def test_empty_months_are_zero_and_salary_is_null(self):
        june = self.month(self.get(), 2026, 6)
        self.assertEqual(june["days"]["working"], 0)
        self.assertIsNone(june["punctuality"]["avgArrival"])
        self.assertIsNone(june["salary"])


class AttendanceCountTests(_Base):
    def setUp(self):
        super().setUp()
        e = self.emp
        _day(e, date(2026, 10, 1), "present", time(8, 50))
        _day(e, date(2026, 10, 2), "present", time(9, 20), is_late=True)
        _day(e, date(2026, 10, 3), "half_shift", time(13, 30), is_late=True, is_half_shift=True, arrival_zone="second_half")
        _day(e, date(2026, 10, 4), "holiday")
        _day(e, date(2026, 10, 5), "absent")
        _day(e, date(2026, 10, 6), "on_leave")
        _day(e, date(2026, 10, 7), "present", time(9, 0), is_half_day_leave=True, early_leave=True, early_out_minutes=25)
        _day(e, date(2026, 10, 8), "present", time(8, 54), ot_extra_minutes=90)
        _day(e, date(2026, 11, 24), "present", time(9, 5))
        _day(e, TODAY, "absent")  # not punched yet today
        _day(e, date(2026, 6, 10), "present", time(9, 0))  # before joining (15 June)
        _day(e, date(2026, 6, 20), "absent")
        _day(self.other, date(2026, 10, 1), "absent")  # someone else's day never shows

    def test_a_month_of_days(self):
        oct_ = self.month(self.get(), 2026, 10)
        self.assertEqual(
            oct_["days"],
            {"recorded": 8, "working": 7, "present": 4, "half": 1, "absent": 1, "leave": 1.5, "holidays": 1},
        )
        # arrivals: 1st, 2nd, 3rd (second half), 7th, 8th; the second-half arrival stays out of the average
        self.assertEqual(oct_["punctuality"]["arrivals"], 5)
        self.assertEqual(oct_["punctuality"]["onTime"], 3)
        self.assertEqual(oct_["punctuality"]["late"], 2)
        self.assertEqual(oct_["punctuality"]["avgArrivalDelta"], 1.0)  # (-10 + 20 + 0 - 6) / 4
        self.assertEqual(oct_["punctuality"]["avgArrival"], "09:01")
        self.assertEqual(oct_["earlyOut"], {"days": 1, "minutes": 25})
        self.assertEqual(oct_["overtimeMinutes"], 90)

    def test_today_counts_only_once_punched(self):
        nov = self.month(self.get(), 2026, 11)
        self.assertEqual(nov["days"]["recorded"], 1)
        self.assertEqual(nov["days"]["absent"], 0)
        self.assertEqual(nov["punctuality"]["avgArrivalDelta"], 5.0)
        AttendanceDayRecord.objects.filter(employee=self.emp, date=TODAY).update(
            status="present", first_punch=time(9, 1)
        )
        nov = self.month(self.get(), 2026, 11)
        self.assertEqual(nov["days"]["present"], 2)
        self.assertEqual(nov["punctuality"]["onTime"], 2)

    def test_days_before_joining_are_left_out(self):
        june = self.month(self.get(), 2026, 6)
        self.assertEqual(june["days"]["recorded"], 1)
        self.assertEqual(june["days"]["absent"], 1)
        self.assertEqual(june["days"]["present"], 0)

    def test_a_few_queries_and_nothing_written(self):
        before = list(AttendanceDayRecord.objects.order_by("id").values_list("id", "updated_at"))
        with CaptureQueriesContext(connection) as ctx:
            self.get()
        writes = [q["sql"] for q in ctx.captured_queries if q["sql"].lstrip().upper().startswith(("INSERT", "UPDATE", "DELETE"))]
        self.assertEqual(writes, [])
        self.assertLessEqual(len(ctx.captured_queries), 14, [q["sql"][:120] for q in ctx.captured_queries])
        self.assertEqual(list(AttendanceDayRecord.objects.order_by("id").values_list("id", "updated_at")), before)


class RequestCountTests(_Base):
    def test_permissions_casual_leave_and_on_duty(self):
        e = self.emp
        EmployeePermission.objects.create(employee=e, date=date(2026, 10, 2), status="approved")
        EmployeePermission.objects.create(employee=e, date=date(2026, 10, 5), status="pending")
        EmployeePermission.objects.create(employee=e, date=date(2026, 11, 28), status="approved")  # later this month
        EmployeePermission.objects.create(employee=e, date=date(2026, 12, 1), status="approved")  # next month
        EmployeePermission.objects.create(employee=self.other, date=date(2026, 10, 2), status="approved")
        CasualLeaveRequest.objects.create(employee=e, date=date(2026, 10, 9), status="approved")
        CasualLeaveRequest.objects.create(employee=e, date=date(2026, 10, 20), status="approved", portion="first_half")
        CasualLeaveRequest.objects.create(employee=e, date=date(2026, 10, 21), status="rejected")
        for when, status in (
            (_ist(2026, 10, 1, 0, 30), "completed"),  # 30 Sep 19:00 UTC: still 1 October in India
            (_ist(2026, 10, 12, 9), "completed"),
            (_ist(2026, 10, 12, 15), "active"),  # the same day again
            (_ist(2026, 10, 13), "pending_hod"),
            (_ist(2026, 10, 14), "rejected"),
            (_ist(2026, 9, 30, 23, 0), "completed"),
        ):
            s = OnDutySession.objects.create(employee=e, destination="Site", status=status)
            OnDutySession.objects.filter(pk=s.pk).update(created_at=when)
        body = self.get()
        oct_, nov, sep = self.month(body, 2026, 10), self.month(body, 2026, 11), self.month(body, 2026, 9)
        self.assertEqual(oct_["permissions"], 1)
        self.assertEqual(nov["permissions"], 1)
        self.assertEqual(oct_["casualLeave"], 1.5)
        self.assertEqual(oct_["onDutyDays"], 3)
        self.assertEqual(sep["onDutyDays"], 1)


class PayTests(_Base):
    def _slip(self, y, m, number, **extra):
        defaults = dict(
            gross_salary=Decimal("22000"), net_salary=Decimal("21000"), other_deductions=Decimal("500"),
            total_deductions=Decimal("1000"), pf_deduction=Decimal("500"), ot_amount=Decimal("300"),
            working_days=26,
            breakdown_details={
                "type": "staff",
                "earnings": {"monthlySalary": 24000, "dailyRate": 923.08},
                "deductions": {"lateShiftPenalty": 500, "permissionPenalty": 0},
                "summary": {"totalWorkingDays": 26, "effectivePaidDays": 24},
            },
        )
        defaults.update(extra)
        return SalarySlip.objects.create(employee=self.emp, year=y, month=m, slip_number=number, **defaults)

    def test_pay_per_month_as_the_salary_page_shows_it(self):
        self._slip(2026, 10, "AN-OCT")
        self._slip(2026, 5, "AN-MAY")  # before the window
        SalarySlip.objects.create(
            employee=self.other, year=2026, month=10, slip_number="AN2-OCT", gross_salary=Decimal("99"),
            net_salary=Decimal("99"),
        )
        body = self.get()
        self.assertEqual(
            self.month(body, 2026, 10)["salary"],
            {"earned": 22000.0, "lost": 2500.0, "net": 21000.0, "allocated": 24000.0, "otPay": 300.0, "slips": 1},
        )
        self.assertIsNone(self.month(body, 2026, 11)["salary"])

    def test_an_older_slip_without_details_has_no_loss_figure(self):
        Employee.objects.filter(pk=self.emp.pk).update(employment_type="production")
        self._slip(2026, 9, "AN-SEP", breakdown_details=None, week_number=2)
        self._slip(2026, 9, "AN-SEP2", breakdown_details=None, week_number=3)
        sep = self.month(self.get(), 2026, 9)
        self.assertEqual(sep["salary"]["slips"], 2)
        self.assertEqual(sep["salary"]["earned"], 44000.0)
        self.assertIsNone(sep["salary"]["allocated"])

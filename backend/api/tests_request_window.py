"""
The request date window (api/request_window.py): an EMPLOYEE may request dates in the current calendar month only, plus last
month on the 1st and 2nd (the grace days), and a Missing Punch can never be in the future. HR filing on someone's behalf is
never limited. Enforced on the four dated request forms: Leave, Permission (Late-In / Early-Out), Casual Leave and
Missing Punch.

  * SharedVectorTests / PythonOnlyTests: the pure rule, against the same 83 vectors the Employee Web App, the Mobile App and
    the HR portal assert (embedded below, so the repo does not depend on anything outside itself).
  * The endpoint tests pin India's "today" by patching api.request_window.ist_today and POST to the real endpoints with real
    tokens: the boundary days, the 400 body, HR and the Department Head, and the order of the refusals.

Run via: python manage.py test api.tests_request_window -v 2
"""

import time
from datetime import date, timedelta
from types import SimpleNamespace
from unittest import mock

from django.test import SimpleTestCase, TestCase

from . import approval_workflow as approval
from . import request_window as rw
from .jwt_utils import sign_token
from .leave_request_views import _count_leave_days
from .models import (
    CasualLeaveRequest,
    DepartmentManager,
    Employee,
    EmployeePermission,
    HRUser,
    LeaveRequest,
    ManagerEmployeeAssignment,
    MissingPunchRequest,
    Notification,
)

# The shared vectors (request-window-vectors.json): the SAME 83 cases are asserted by the Employee Web App, the Mobile App,
# the HR portal and this backend, so the rule cannot drift. The sentences are the exact user-facing messages.
GRACE_OCTOBER_2026 = (
    "You can only request dates from 1 September 2026 to 31 October 2026. September closes at the end of 2 October."
)
ONLY_OCTOBER_2026 = "You can only request dates in October 2026."
GRACE_JANUARY_2026 = (
    "You can only request dates from 1 December 2025 to 31 January 2026. December closes at the end of 2 January."
)
ONLY_JANUARY_2026 = "You can only request dates in January 2026."
GRACE_MARCH_2026 = (
    "You can only request dates from 1 February 2026 to 31 March 2026. February closes at the end of 2 March."
)
ONLY_MARCH_2026 = "You can only request dates in March 2026."
GRACE_MARCH_2028 = (
    "You can only request dates from 1 February 2028 to 31 March 2028. February closes at the end of 2 March."
)
ONLY_MARCH_2028 = "You can only request dates in March 2028."
ONLY_FEBRUARY_2026 = "You can only request dates in February 2026."
ONLY_FEBRUARY_2028 = "You can only request dates in February 2028."
GRACE_DECEMBER_2026 = (
    "You can only request dates from 1 November 2026 to 31 December 2026. November closes at the end of 2 December."
)
ONLY_DECEMBER_2026 = "You can only request dates in December 2026."
ONLY_NOVEMBER_2026 = "You can only request dates in November 2026."
GRACE_MAY_2026 = "You can only request dates from 1 April 2026 to 31 May 2026. April closes at the end of 2 May."
ONLY_JULY_2026 = "You can only request dates in July 2026."
FUTURE = "Date cannot be in the future."
INVALID = "Choose a valid date."
END_BEFORE_START = "End date must be on or after start date."

GRACE_DAYS_VECTOR = 2

# today, min, max, graceOpen, currentMonth, previousMonth, message, hint
WINDOWS = [
    (
        "2026-10-01",
        "2026-09-01",
        "2026-10-31",
        True,
        "October 2026",
        "September 2026",
        GRACE_OCTOBER_2026,
        "1 September 2026 to 31 October 2026",
    ),
    (
        "2026-10-02",
        "2026-09-01",
        "2026-10-31",
        True,
        "October 2026",
        "September 2026",
        GRACE_OCTOBER_2026,
        "1 September 2026 to 31 October 2026",
    ),
    (
        "2026-10-03",
        "2026-10-01",
        "2026-10-31",
        False,
        "October 2026",
        "September 2026",
        ONLY_OCTOBER_2026,
        "Any day in October 2026",
    ),
    (
        "2026-10-15",
        "2026-10-01",
        "2026-10-31",
        False,
        "October 2026",
        "September 2026",
        ONLY_OCTOBER_2026,
        "Any day in October 2026",
    ),
    (
        "2026-10-31",
        "2026-10-01",
        "2026-10-31",
        False,
        "October 2026",
        "September 2026",
        ONLY_OCTOBER_2026,
        "Any day in October 2026",
    ),
    (
        "2026-01-01",
        "2025-12-01",
        "2026-01-31",
        True,
        "January 2026",
        "December 2025",
        GRACE_JANUARY_2026,
        "1 December 2025 to 31 January 2026",
    ),
    (
        "2026-01-02",
        "2025-12-01",
        "2026-01-31",
        True,
        "January 2026",
        "December 2025",
        GRACE_JANUARY_2026,
        "1 December 2025 to 31 January 2026",
    ),
    (
        "2026-01-03",
        "2026-01-01",
        "2026-01-31",
        False,
        "January 2026",
        "December 2025",
        ONLY_JANUARY_2026,
        "Any day in January 2026",
    ),
    (
        "2026-03-01",
        "2026-02-01",
        "2026-03-31",
        True,
        "March 2026",
        "February 2026",
        GRACE_MARCH_2026,
        "1 February 2026 to 31 March 2026",
    ),
    (
        "2026-03-02",
        "2026-02-01",
        "2026-03-31",
        True,
        "March 2026",
        "February 2026",
        GRACE_MARCH_2026,
        "1 February 2026 to 31 March 2026",
    ),
    (
        "2026-03-03",
        "2026-03-01",
        "2026-03-31",
        False,
        "March 2026",
        "February 2026",
        ONLY_MARCH_2026,
        "Any day in March 2026",
    ),
    (
        "2028-03-01",
        "2028-02-01",
        "2028-03-31",
        True,
        "March 2028",
        "February 2028",
        GRACE_MARCH_2028,
        "1 February 2028 to 31 March 2028",
    ),
    (
        "2028-03-02",
        "2028-02-01",
        "2028-03-31",
        True,
        "March 2028",
        "February 2028",
        GRACE_MARCH_2028,
        "1 February 2028 to 31 March 2028",
    ),
    (
        "2028-03-03",
        "2028-03-01",
        "2028-03-31",
        False,
        "March 2028",
        "February 2028",
        ONLY_MARCH_2028,
        "Any day in March 2028",
    ),
    (
        "2026-02-28",
        "2026-02-01",
        "2026-02-28",
        False,
        "February 2026",
        "January 2026",
        ONLY_FEBRUARY_2026,
        "Any day in February 2026",
    ),
    (
        "2028-02-29",
        "2028-02-01",
        "2028-02-29",
        False,
        "February 2028",
        "January 2028",
        ONLY_FEBRUARY_2028,
        "Any day in February 2028",
    ),
    (
        "2026-12-01",
        "2026-11-01",
        "2026-12-31",
        True,
        "December 2026",
        "November 2026",
        GRACE_DECEMBER_2026,
        "1 November 2026 to 31 December 2026",
    ),
    (
        "2026-12-02",
        "2026-11-01",
        "2026-12-31",
        True,
        "December 2026",
        "November 2026",
        GRACE_DECEMBER_2026,
        "1 November 2026 to 31 December 2026",
    ),
    (
        "2026-12-31",
        "2026-12-01",
        "2026-12-31",
        False,
        "December 2026",
        "November 2026",
        ONLY_DECEMBER_2026,
        "Any day in December 2026",
    ),
    (
        "2026-11-30",
        "2026-11-01",
        "2026-11-30",
        False,
        "November 2026",
        "October 2026",
        ONLY_NOVEMBER_2026,
        "Any day in November 2026",
    ),
    (
        "2026-05-01",
        "2026-04-01",
        "2026-05-31",
        True,
        "May 2026",
        "April 2026",
        GRACE_MAY_2026,
        "1 April 2026 to 31 May 2026",
    ),
    (
        "2026-07-31",
        "2026-07-01",
        "2026-07-31",
        False,
        "July 2026",
        "June 2026",
        ONLY_JULY_2026,
        "Any day in July 2026",
    ),
]

# today, date, error, error with no_future=True
DATES = [
    ("2026-10-01", "2026-09-30", None, None),
    ("2026-10-01", "2026-09-01", None, None),
    ("2026-10-01", "2026-08-31", GRACE_OCTOBER_2026, GRACE_OCTOBER_2026),
    ("2026-10-01", "2026-10-01", None, None),
    ("2026-10-01", "2026-10-31", None, FUTURE),
    ("2026-10-01", "2026-11-01", GRACE_OCTOBER_2026, FUTURE),
    ("2026-10-02", "2026-09-01", None, None),
    ("2026-10-02", "2026-08-31", GRACE_OCTOBER_2026, GRACE_OCTOBER_2026),
    ("2026-10-02", "2026-10-31", None, FUTURE),
    ("2026-10-03", "2026-09-30", ONLY_OCTOBER_2026, ONLY_OCTOBER_2026),
    ("2026-10-03", "2026-09-01", ONLY_OCTOBER_2026, ONLY_OCTOBER_2026),
    ("2026-10-03", "2026-10-01", None, None),
    ("2026-10-03", "2026-10-03", None, None),
    ("2026-10-03", "2026-10-31", None, FUTURE),
    ("2026-10-03", "2026-11-01", ONLY_OCTOBER_2026, FUTURE),
    ("2026-10-31", "2026-10-01", None, None),
    ("2026-10-31", "2026-09-30", ONLY_OCTOBER_2026, ONLY_OCTOBER_2026),
    ("2026-10-31", "2026-11-01", ONLY_OCTOBER_2026, FUTURE),
    ("2026-01-01", "2025-12-01", None, None),
    ("2026-01-01", "2025-12-31", None, None),
    ("2026-01-01", "2025-11-30", GRACE_JANUARY_2026, GRACE_JANUARY_2026),
    ("2026-01-02", "2025-12-15", None, None),
    ("2026-01-03", "2025-12-31", ONLY_JANUARY_2026, ONLY_JANUARY_2026),
    ("2026-01-03", "2026-01-01", None, None),
    ("2026-01-03", "2026-01-31", None, FUTURE),
    ("2026-01-03", "2026-02-01", ONLY_JANUARY_2026, FUTURE),
    ("2026-03-01", "2026-02-01", None, None),
    ("2026-03-01", "2026-02-28", None, None),
    ("2026-03-01", "2026-02-29", INVALID, INVALID),
    ("2026-03-03", "2026-02-28", ONLY_MARCH_2026, ONLY_MARCH_2026),
    ("2028-03-01", "2028-02-29", None, None),
    ("2028-03-01", "2028-02-01", None, None),
    ("2028-03-03", "2028-02-29", ONLY_MARCH_2028, ONLY_MARCH_2028),
    ("2028-02-29", "2028-02-29", None, None),
    ("2028-02-29", "2028-03-01", ONLY_FEBRUARY_2028, FUTURE),
    ("2026-02-28", "2026-02-28", None, None),
    ("2026-02-28", "2026-03-01", ONLY_FEBRUARY_2026, FUTURE),
    ("2026-12-31", "2026-12-31", None, None),
    ("2026-12-31", "2027-01-01", ONLY_DECEMBER_2026, FUTURE),
    ("2026-12-02", "2026-11-01", None, None),
    ("2026-12-03", "2026-11-30", ONLY_DECEMBER_2026, ONLY_DECEMBER_2026),
    ("2026-10-15", "not-a-date", INVALID, INVALID),
    ("2026-10-15", "", INVALID, INVALID),
    ("2026-10-15", "2026-13-01", INVALID, INVALID),
    ("2026-10-15", "2026-02-30", INVALID, INVALID),
    ("2026-10-15", "2026-10-1", INVALID, INVALID),
    ("2026-10-15", "26-10-15", INVALID, INVALID),
]

# today, start, end, error
RANGES = [
    ("2026-10-15", "2026-10-20", "2026-10-22", None),
    ("2026-10-15", "2026-10-30", "2026-11-02", ONLY_OCTOBER_2026),
    ("2026-10-15", "2026-09-30", "2026-10-02", ONLY_OCTOBER_2026),
    ("2026-10-15", "2026-10-22", "2026-10-20", END_BEFORE_START),
    ("2026-10-02", "2026-09-29", "2026-10-02", None),
    ("2026-10-02", "2026-09-30", "2026-09-30", None),
    ("2026-10-03", "2026-09-30", "2026-10-02", ONLY_OCTOBER_2026),
    ("2026-10-03", "2026-10-01", "2026-10-31", None),
    ("2026-10-15", "2026-10-31", "2026-10-31", None),
    ("2026-10-15", "2026-11-01", "2026-11-01", ONLY_OCTOBER_2026),
    ("2026-01-02", "2025-12-30", "2026-01-02", None),
    ("2026-10-15", "2026-10-10", "bad", INVALID),
    ("2026-10-15", "", "2026-10-10", INVALID),
    ("2026-10-02", "2026-10-05", "2026-09-28", END_BEFORE_START),
]


def D(value: str) -> date:
    return date.fromisoformat(value)


def clock(today: str):
    """Pin India's 'today' for the request window (the server is the authority; nothing else reads this clock)."""
    return mock.patch("api.request_window.ist_today", return_value=D(today))


# ═════════════════════════════ the pure rule ═════════════════════════════


class SharedVectorTests(SimpleTestCase):
    def test_the_whole_vector_set_is_here(self):
        self.assertEqual((len(WINDOWS), len(DATES), len(RANGES)), (22, 47, 14))
        self.assertEqual(rw.GRACE_DAYS, GRACE_DAYS_VECTOR)

    def test_windows(self):
        for today, lo, hi, grace_open, current, previous, message, hint in WINDOWS:
            with self.subTest(today=today):
                w = rw.request_window(D(today))
                self.assertEqual(
                    (w.today, w.min, w.max, w.grace_open, w.current_month, w.previous_month),
                    (D(today), D(lo), D(hi), grace_open, current, previous),
                )
                self.assertEqual(rw.window_message(w), message)
                self.assertEqual(rw.window_hint(w), hint)

    def test_single_dates_with_and_without_no_future(self):
        for today, value, error, error_no_future in DATES:
            with self.subTest(today=today, date=value):
                self.assertEqual(rw.check_date(value, D(today)), error)
                self.assertEqual(rw.check_date(value, D(today), no_future=True), error_no_future)

    def test_ranges(self):
        for today, start, end, error in RANGES:
            with self.subTest(today=today, start=start, end=end):
                self.assertEqual(rw.check_range(start, end, D(today)), error)


class PythonOnlyTests(SimpleTestCase):
    TODAY = D("2026-10-15")

    def test_an_iso_date_time_string_is_read_by_its_date(self):
        for value in ("2026-10-20T00:00:00", "2026-10-20T23:59:59+05:30", "2026-10-20 10:30:00"):
            with self.subTest(value=value):
                self.assertIsNone(rw.check_date(value, self.TODAY))
                self.assertEqual(rw.parse_request_date(value), D("2026-10-20"))
        for value in ("2026-11-01T00:00:00", "2026-09-30T23:59:59"):
            with self.subTest(value=value):
                self.assertEqual(rw.check_date(value, self.TODAY), ONLY_OCTOBER_2026)
        self.assertIsNone(rw.check_range("2026-10-20T00:00:00", "2026-10-22T00:00:00", self.TODAY))
        self.assertEqual(rw.check_range("2026-10-30T00:00:00", "2026-11-02T00:00:00", self.TODAY), ONLY_OCTOBER_2026)

    def test_none_and_things_that_are_not_strings_are_not_dates(self):
        for value in (
            None,
            20261015,
            20261015.0,
            True,
            False,
            [],
            ["2026-10-20"],
            {"date": "2026-10-20"},
            b"2026-10-20",
        ):
            with self.subTest(value=value):
                self.assertIsNone(rw.parse_request_date(value))
                self.assertEqual(rw.check_date(value, self.TODAY), INVALID)
                self.assertEqual(rw.check_date(value, self.TODAY, no_future=True), INVALID)
        self.assertEqual(rw.check_range(None, "2026-10-20", self.TODAY), INVALID)
        self.assertEqual(rw.check_range("2026-10-20", None, self.TODAY), INVALID)
        self.assertEqual(rw.check_range(20261020, 20261022, self.TODAY), INVALID)

    def test_unicode_digits_do_not_sneak_through(self):
        for value in (
            "٢٠٢٦-١٠-٢٠",  # Arabic-Indic digits
            "२०२६-१०-२०",  # Devanagari digits
            "２０２６-１０-２０",  # full-width digits
            "2026-10-２０",  # ASCII year and month, full-width day
            "2026-10-2⁰",  # superscript zero
        ):
            with self.subTest(value=ascii(value)):
                self.assertIsNone(rw.parse_request_date(value))
                self.assertEqual(rw.check_date(value, self.TODAY), INVALID)
                self.assertEqual(rw.check_range(value, "2026-10-22", self.TODAY), INVALID)

    def test_whitespace_inside_a_date_does_not_sneak_through(self):
        for value in (
            "2026 -10-20",
            "2026-10- 20",
            "2026-1 0-20",
            "20 26-10-20",
            "2026-10-\t20",
            "2026\n-10-20",
            "",
            " ",
            "\n\t",
        ):
            with self.subTest(value=repr(value)):
                self.assertEqual(rw.check_date(value, self.TODAY), INVALID)

    def test_whitespace_around_a_date_is_trimmed(self):
        for value in (" 2026-10-20", "2026-10-20 ", "\t2026-10-20\n", " 2026-10-20 "):
            with self.subTest(value=repr(value)):
                self.assertEqual(rw.parse_request_date(value), D("2026-10-20"))
                self.assertIsNone(rw.check_date(value, self.TODAY))
        self.assertEqual(rw.check_date(" 2026-11-01 ", self.TODAY), ONLY_OCTOBER_2026)

    def test_impossible_calendar_dates_are_invalid(self):
        for value in ("2026-02-29", "2026-04-31", "2026-00-10", "2026-10-00", "2026-13-01", "0000-01-01"):
            with self.subTest(value=value):
                self.assertIsNone(rw.parse_request_date(value))
        self.assertEqual(rw.parse_request_date("2028-02-29"), D("2028-02-29"))

    def test_without_a_date_the_india_clock_is_used(self):
        with clock("2026-10-02"):
            w = rw.request_window()
            self.assertEqual((w.today, w.min, w.grace_open), (D("2026-10-02"), D("2026-09-01"), True))
            self.assertIsNone(rw.check_date("2026-09-01"))
            self.assertEqual(rw.check_date("2026-08-31"), GRACE_OCTOBER_2026)
        with clock("2026-10-03"):
            self.assertEqual(rw.check_date("2026-09-01"), ONLY_OCTOBER_2026)

    def test_the_window_is_read_every_time_not_once(self):
        with clock("2026-10-02"):
            self.assertIsNone(rw.check_date("2026-09-30"))
        with clock("2026-10-03"):
            self.assertEqual(rw.check_date("2026-09-30"), ONLY_OCTOBER_2026)
        with clock("2026-10-02"):
            self.assertIsNone(rw.check_date("2026-09-30"))

    def test_only_an_employee_token_is_ever_limited(self):
        hr = SimpleNamespace(jwt_user={"role": "hr", "hrUserId": 1})
        nobody = SimpleNamespace()
        for who in (hr, nobody):
            self.assertIsNone(rw.enforce_employee_date(who, "2020-01-01", today=self.TODAY))
            self.assertIsNone(rw.enforce_employee_date(who, "garbage", no_future=True, today=self.TODAY))
            self.assertIsNone(rw.enforce_employee_range(who, "2020-01-01", "2030-01-01", today=self.TODAY))
        employee = SimpleNamespace(jwt_user={"role": "employee", "employeeId": 5})
        self.assertIsNone(rw.enforce_employee_date(employee, "2026-10-20", today=self.TODAY))
        self.assertIsNone(rw.enforce_employee_range(employee, "2026-10-20", "2026-10-22", today=self.TODAY))

    def test_the_refusal_an_employee_gets(self):
        employee = SimpleNamespace(jwt_user={"role": "employee", "employeeId": 5})
        for refused in (
            rw.enforce_employee_date(employee, "2020-01-01", today=self.TODAY),
            rw.enforce_employee_range(employee, "2020-01-01", "2020-01-02", today=self.TODAY),
        ):
            self.assertEqual(refused.status_code, 400)
            self.assertEqual(
                refused.data,
                {
                    "error": ONLY_OCTOBER_2026,
                    "code": "request_window_closed",
                    "earliestDate": "2026-10-01",
                    "latestDate": "2026-10-31",
                    "graceDays": 2,
                },
            )
        in_grace = rw.enforce_employee_date(employee, "2020-01-01", today=D("2026-10-02"))
        self.assertEqual((in_grace.data["error"], in_grace.data["earliestDate"]), (GRACE_OCTOBER_2026, "2026-09-01"))
        future = rw.enforce_employee_date(employee, "2026-10-20", no_future=True, today=self.TODAY)
        self.assertEqual((future.data["error"], future.data["latestDate"]), (FUTURE, "2026-10-31"))


# ═════════════════════════════ the four endpoints ═════════════════════════════


def _bearer(payload: dict) -> dict:
    return {"HTTP_AUTHORIZATION": f"Bearer {sign_token(payload)}"}


def _employee(code: str, employment_type: str = "staff") -> Employee:
    return Employee.objects.create(
        employee_code=code,
        first_name=code,
        last_name="Window",
        status="active",
        employment_type=employment_type,
        join_date="2020-01-01",
    )


class _Base(TestCase):
    def setUp(self):
        super().setUp()
        approval.clear_cache()
        self.addCleanup(approval.clear_cache)
        hr = HRUser.objects.create(username="rw_hr", password_hash="x", is_super_admin=True, full_name="Meena")
        self.hr = _bearer({"role": "hr", "hrUserId": hr.id, "name": "Meena"})
        self.emp = _employee("RW1")
        self.colleague = _employee("RW2")
        self.boss = _employee("RW9")
        manager = DepartmentManager.objects.create(employee=self.boss)
        ManagerEmployeeAssignment.objects.create(manager=manager, employee=self.emp)
        self.emp_auth = _bearer({"role": "employee", "employeeId": self.emp.id})
        self.boss_auth = _bearer({"role": "employee", "employeeId": self.boss.id})


class _EndpointCases:
    """What every one of the four endpoints must do. A subclass names its URL, model and workflow and builds a request body;
    the cases below then walk the window's boundary days against it (India's 'today' pinned for each one)."""

    PATH = ""
    MODEL = None
    WORKFLOW = ""
    NO_FUTURE = False  # Missing Punch: a date after today is refused as "in the future" before the window is looked at

    def body(self, value, emp) -> dict:
        raise NotImplementedError

    def post(self, value, who=None, emp=None):
        body = self.body(value, emp or self.emp)
        return self.client.post(self.PATH, body, content_type="application/json", **(who or self.emp_auth))

    def count(self) -> int:
        return self.MODEL.objects.count()

    def clear(self):
        self.MODEL.objects.all().delete()

    def next_month(self, only_message):
        return FUTURE if self.NO_FUTURE else only_message

    def allowed(self, today, value, who=None, emp=None):
        with clock(today):
            r = self.post(value, who, emp)
        self.assertEqual(r.status_code, 201, f"today {today}, date {value!r}: {r.content!r}")
        self.clear()

    def refused(self, today, value, message, earliest, latest, who=None, emp=None):
        before, notices = self.count(), Notification.objects.count()
        with clock(today):
            r = self.post(value, who, emp)
        self.assertEqual(r.status_code, 400, f"today {today}, date {value!r}: {r.content!r}")
        self.assertEqual(
            r.json(),
            {
                "error": message,
                "code": "request_window_closed",
                "earliestDate": earliest,
                "latestDate": latest,
                "graceDays": 2,
            },
            f"today {today}, date {value!r}",
        )
        self.assertEqual((self.count(), Notification.objects.count()), (before, notices))

    # -- this month, last month, next month --

    def test_any_day_up_to_today_in_this_month_is_allowed(self):
        for value in ("2026-10-01", "2026-10-10", "2026-10-15"):
            self.allowed("2026-10-15", value)

    def test_a_later_day_of_this_month_is_allowed_except_for_a_missing_punch(self):
        if self.NO_FUTURE:
            self.refused("2026-10-15", "2026-10-31", FUTURE, "2026-10-01", "2026-10-31")
        else:
            self.allowed("2026-10-15", "2026-10-31")

    def test_next_month_is_refused(self):
        for today, value in (("2026-10-15", "2026-11-01"), ("2026-10-31", "2026-11-01"), ("2026-10-15", "2026-11-30")):
            self.refused(today, value, self.next_month(ONLY_OCTOBER_2026), "2026-10-01", "2026-10-31")

    def test_last_month_is_refused_after_the_grace_days(self):
        for today in ("2026-10-03", "2026-10-15", "2026-10-31"):
            for value in ("2026-09-30", "2026-09-01"):
                self.refused(today, value, ONLY_OCTOBER_2026, "2026-10-01", "2026-10-31")
        self.refused("2026-10-15", "2025-10-15", ONLY_OCTOBER_2026, "2026-10-01", "2026-10-31")

    def test_last_month_is_still_open_on_the_1st_and_2nd(self):
        for today in ("2026-10-01", "2026-10-02"):
            for value in ("2026-09-01", "2026-09-15", "2026-09-30", "2026-10-01"):
                self.allowed(today, value)
            self.refused(today, "2026-08-31", GRACE_OCTOBER_2026, "2026-09-01", "2026-10-31")
            self.refused(today, "2026-11-01", self.next_month(GRACE_OCTOBER_2026), "2026-09-01", "2026-10-31")

    def test_the_grace_is_over_from_the_3rd(self):
        self.allowed("2026-10-02", "2026-09-30")
        self.refused("2026-10-03", "2026-09-30", ONLY_OCTOBER_2026, "2026-10-01", "2026-10-31")
        self.allowed("2026-10-03", "2026-10-01")

    # -- boundaries --

    def test_month_end(self):
        self.allowed("2026-10-31", "2026-10-31")
        self.allowed("2026-10-31", "2026-10-01")
        self.refused("2026-10-31", "2026-09-30", ONLY_OCTOBER_2026, "2026-10-01", "2026-10-31")
        self.refused("2026-10-31", "2026-11-01", self.next_month(ONLY_OCTOBER_2026), "2026-10-01", "2026-10-31")
        # a 30-day month and a short one
        self.allowed("2026-11-30", "2026-11-30")
        self.refused("2026-11-30", "2026-12-01", self.next_month(ONLY_NOVEMBER_2026), "2026-11-01", "2026-11-30")
        self.allowed("2026-02-28", "2026-02-28")
        self.refused("2026-02-28", "2026-03-01", self.next_month(ONLY_FEBRUARY_2026), "2026-02-01", "2026-02-28")

    def test_january_looks_back_to_december_of_the_year_before(self):
        self.allowed("2026-01-01", "2025-12-31")
        self.allowed("2026-01-02", "2025-12-01")
        self.refused("2026-01-01", "2025-11-30", GRACE_JANUARY_2026, "2025-12-01", "2026-01-31")
        self.refused("2026-01-03", "2025-12-31", ONLY_JANUARY_2026, "2026-01-01", "2026-01-31")
        self.allowed("2026-01-03", "2026-01-01")

    def test_december_ends_the_year(self):
        self.allowed("2026-12-31", "2026-12-31")
        self.refused("2026-12-31", "2027-01-01", self.next_month(ONLY_DECEMBER_2026), "2026-12-01", "2026-12-31")
        self.allowed("2026-12-02", "2026-11-01")
        self.refused("2026-12-03", "2026-11-30", ONLY_DECEMBER_2026, "2026-12-01", "2026-12-31")

    def test_29_february_in_a_leap_year(self):
        self.allowed("2028-03-01", "2028-02-29")
        self.allowed("2028-03-02", "2028-02-01")
        self.refused("2028-03-03", "2028-02-29", ONLY_MARCH_2028, "2028-03-01", "2028-03-31")
        self.allowed("2028-02-29", "2028-02-29")
        self.refused("2028-02-29", "2028-03-01", self.next_month(ONLY_FEBRUARY_2028), "2028-02-01", "2028-02-29")

    # -- who is limited --

    def test_hr_is_never_limited(self):
        for today, value in (
            ("2026-10-15", "2020-01-15"),
            ("2026-10-15", "2025-09-30"),
            ("2026-10-15", "2026-09-30"),
            ("2026-10-15", "2026-11-20"),
            ("2026-10-15", "2030-06-01"),
        ):
            self.allowed(today, value, who=self.hr)

    def test_a_department_head_is_limited_like_anyone_for_their_own_request(self):
        own = {"who": self.boss_auth, "emp": self.boss}
        self.refused("2026-10-15", "2026-09-30", ONLY_OCTOBER_2026, "2026-10-01", "2026-10-31", **own)
        self.refused("2026-10-15", "2026-11-02", self.next_month(ONLY_OCTOBER_2026), "2026-10-01", "2026-10-31", **own)
        self.allowed("2026-10-15", "2026-10-09", **own)
        self.allowed("2026-10-02", "2026-09-30", **own)

    # -- the order of the refusals --

    def test_the_ownership_403_comes_before_the_window(self):
        with clock("2026-10-15"):
            r = self.post("2020-01-01", emp=self.colleague)  # an employee token asking for someone else
        self.assertEqual(r.status_code, 403, r.content)
        self.assertNotEqual(r.json().get("code"), "request_window_closed")
        self.assertEqual(self.count(), 0)

    def test_a_switched_off_workflow_answers_before_the_window(self):
        approval.save_config(self.WORKFLOW, enabled=False, actor="test")
        for who in (self.emp_auth, self.hr):
            with clock("2026-10-15"):
                r = self.post("2020-01-01", who=who)
            self.assertEqual((r.status_code, r.json()["code"]), (403, "workflow_disabled"), r.content)
        self.assertEqual(self.count(), 0)

    def test_dates_that_are_not_dates_answer_400_never_500(self):
        bad_dates = (
            "garbage",
            "2026-13-45",
            "2026-02-29",
            "15/10/2026",
            "2026-10-1",
            20269999,
            12.5,
            ["2026-10-15"],
            {"d": 1},
            True,
        )
        for bad in bad_dates:
            with clock("2026-10-15"):
                r = self.post(bad)
            self.assertEqual(r.status_code, 400, f"{bad!r}: {r.content!r}")
        self.assertEqual(self.count(), 0)

    def test_other_spellings_of_a_date_cannot_get_around_the_window(self):
        # Python also reads 20260930 and 2026-W40-3 as 30 September 2026: the date that is checked is the date that is stored
        for spelling in ("20260930", "2026-W40-3", "20261101", "2026-W45-7"):
            with clock("2026-10-15"):
                r = self.post(spelling)
            self.assertEqual(r.status_code, 400, f"{spelling!r}: {r.content!r}")
        self.assertEqual(self.count(), 0)

    def test_a_missing_date_is_still_the_required_field_400(self):
        for missing in (None, ""):
            with clock("2026-10-15"):
                r = self.post(missing)
            self.assertEqual(r.status_code, 400, r.content)
            self.assertNotEqual(r.json().get("code"), "request_window_closed")
        self.assertEqual(self.count(), 0)


class LeaveWindowTests(_EndpointCases, _Base):
    PATH = "/api/leave-requests"
    MODEL = LeaveRequest
    WORKFLOW = "leave"

    def body(self, value, emp):
        return {"employeeId": emp.id, "startDate": value, "endDate": value, "reason": "Family function"}

    def send(self, today, body, who=None):
        with clock(today):
            return self.client.post(self.PATH, body, content_type="application/json", **(who or self.emp_auth))

    def range(self, today, start, end, who=None, **extra):
        body = {"employeeId": self.emp.id, "startDate": start, "endDate": end, "reason": "Family function", **extra}
        return self.send(today, body, who)

    def test_both_ends_of_a_range_must_be_inside_the_window(self):
        for today, start, end in (
            ("2026-10-15", "2026-10-20", "2026-10-22"),
            ("2026-10-15", "2026-10-01", "2026-10-31"),
            ("2026-10-02", "2026-09-29", "2026-10-02"),  # last month's grace days
            ("2026-01-02", "2025-12-30", "2026-01-02"),
        ):
            r = self.range(today, start, end)
            self.assertEqual(r.status_code, 201, f"{today} {start}..{end}: {r.content!r}")
            self.clear()

    def test_a_range_straddling_the_month_end_is_refused(self):
        for today, start, end, message in (
            ("2026-10-15", "2026-10-30", "2026-11-02", ONLY_OCTOBER_2026),  # ends next month
            ("2026-10-03", "2026-09-30", "2026-10-02", ONLY_OCTOBER_2026),  # starts last month after the grace
            ("2026-10-15", "2026-09-01", "2026-11-30", ONLY_OCTOBER_2026),
            ("2026-10-15", "2026-11-01", "2026-11-03", ONLY_OCTOBER_2026),
            ("2026-10-02", "2026-08-30", "2026-09-02", GRACE_OCTOBER_2026),
            ("2026-10-02", "2026-10-30", "2026-11-02", GRACE_OCTOBER_2026),
            ("2026-12-15", "2026-12-30", "2027-01-02", ONLY_DECEMBER_2026),
        ):
            r = self.range(today, start, end)
            self.assertEqual(r.status_code, 400, f"{today} {start}..{end}: {r.content!r}")
            self.assertEqual(r.json()["error"], message, f"{today} {start}..{end}")
            self.assertEqual(r.json()["code"], "request_window_closed")
        self.assertEqual(self.count(), 0)

    def test_an_end_before_the_start_is_refused_in_the_vector_words(self):
        r = self.range("2026-10-15", "2026-10-22", "2026-10-20")
        self.assertEqual((r.status_code, r.json()["error"]), (400, END_BEFORE_START))
        self.assertEqual(self.count(), 0)

    def test_an_end_date_left_out_means_the_start_date(self):
        ok = self.send("2026-10-15", {"employeeId": self.emp.id, "startDate": "2026-10-20"})
        self.assertEqual(ok.status_code, 201, ok.content)
        self.assertEqual(ok.json()["endDate"], "2026-10-20")
        refused = self.send("2026-10-15", {"employeeId": self.emp.id, "startDate": "2026-09-30"})
        self.assertEqual((refused.status_code, refused.json()["error"]), (400, ONLY_OCTOBER_2026))
        self.assertEqual(self.count(), 1)

    def test_a_half_day_is_one_date(self):
        half = {"isHalfDay": True, "halfDaySlot": "morning"}
        r = self.range("2026-10-15", "2026-10-20", "2026-10-20", **half)
        self.assertEqual(r.status_code, 201, r.content)
        self.assertEqual(float(LeaveRequest.objects.get().total_days), 0.5)
        self.clear()
        self.assertEqual(self.range("2026-10-02", "2026-09-30", "2026-09-30", **half).status_code, 201)  # grace
        self.clear()
        for today, day, message in (
            ("2026-10-15", "2026-09-30", ONLY_OCTOBER_2026),
            ("2026-10-15", "2026-11-01", ONLY_OCTOBER_2026),
            ("2026-10-03", "2026-09-30", ONLY_OCTOBER_2026),
        ):
            r = self.range(today, day, day, isHalfDay=True, halfDaySlot="afternoon")
            self.assertEqual((r.status_code, r.json()["error"]), (400, message), f"{today} {day}")
        self.assertEqual(self.count(), 0)

    def test_the_half_day_rules_are_answered_before_the_window(self):
        r = self.range("2026-10-15", "2026-09-30", "2026-10-01", isHalfDay=True, halfDaySlot="morning")
        self.assertEqual((r.status_code, r.json()["error"]), (400, "A half-day leave request must be for a single day"))
        r = self.range("2026-10-15", "2026-09-30", "2026-09-30", isHalfDay=True, halfDaySlot="evening")
        self.assertEqual((r.status_code, r.json()["error"]), (400, "halfDaySlot must be 'morning' or 'afternoon'"))
        self.assertEqual(self.count(), 0)

    def test_free_text_dates_are_read_by_their_date(self):
        # the leave form has always sent whatever it was given; an ISO date-time is read by its date
        self.assertEqual(self.range("2026-10-15", "2026-10-20T00:00:00", "2026-10-20T00:00:00").status_code, 201)
        self.clear()
        r = self.range("2026-10-15", "2026-09-30T00:00:00", "2026-09-30T00:00:00")
        self.assertEqual((r.status_code, r.json()["error"]), (400, ONLY_OCTOBER_2026))

    def test_a_non_numeric_employee_id_is_a_400_not_a_500(self):
        for bad in ("abc", "12abc", [self.emp.id], {"id": 1}):
            r = self.send("2026-10-15", {"employeeId": bad, "startDate": "2026-10-20", "endDate": "2026-10-20"})
            self.assertEqual(r.status_code, 400, f"{bad!r}: {r.content!r}")
            self.assertEqual(r.json(), {"error": "employeeId must be a number"})
        self.assertEqual(self.count(), 0)

    def test_a_numeric_employee_id_keeps_working_as_a_string_or_a_number(self):
        for own in (str(self.emp.id), self.emp.id):
            r = self.send("2026-10-15", {"employeeId": own, "startDate": "2026-10-20", "endDate": "2026-10-20"})
            self.assertEqual(r.status_code, 201, r.content)
            self.assertEqual(r.json()["employeeId"], self.emp.id)
        r = self.send("2026-10-15", {"employeeId": str(self.colleague.id), "startDate": "2026-10-20"})
        self.assertEqual(r.status_code, 403, r.content)

    def test_an_employee_token_with_no_employee_id_files_for_itself(self):
        r = self.send("2026-10-15", {"startDate": "2026-10-20", "endDate": "2026-10-21"})
        self.assertEqual(r.status_code, 201, r.content)
        self.assertEqual(r.json()["employeeId"], self.emp.id)

    def test_hr_can_still_file_by_employee_code(self):
        r = self.send(
            "2026-10-15", {"employeeCode": "RW1", "startDate": "2020-01-06", "endDate": "2020-01-07"}, self.hr
        )
        self.assertEqual(r.status_code, 201, r.content)
        self.assertEqual(r.json()["employeeId"], self.emp.id)


class LeaveCanonicalDateTests(_Base):
    """What the Leave endpoint STORES and COUNTS for an employee. startDate / endDate are free text columns, and the window
    check reads a date by its first ten characters, so the date that is checked has to be the date that is stored (it used to
    be the raw text: a date-time range was counted as one day and then crashed the attendance pages)."""

    PATH = "/api/leave-requests"
    TODAY = "2026-10-15"

    def send(self, body, who=None):
        with clock(self.TODAY):
            return self.client.post(self.PATH, body, content_type="application/json", **(who or self.emp_auth))

    def range(self, start, end, who=None, **extra):
        body = {"employeeId": self.emp.id, "startDate": start, "endDate": end, "reason": "Family function", **extra}
        return self.send(body, who)

    def raw(self, text, who=None):
        """A raw JSON text, for what json.dumps cannot write: a lone surrogate, 1e999."""
        return self.send(text, who)

    def only_row(self) -> LeaveRequest:
        return LeaveRequest.objects.get()

    def count(self) -> int:
        return LeaveRequest.objects.count()

    def forget(self):
        LeaveRequest.objects.all().delete()

    def assert_window_400(self, r, message=ONLY_OCTOBER_2026):
        self.assertEqual(r.status_code, 400, r.content)
        self.assertEqual((r.json()["error"], r.json()["code"]), (message, "request_window_closed"))

    # -- the stored text --

    def test_the_stored_dates_are_canonical_whatever_the_employee_typed(self):
        for text in (
            " 2026-10-20",
            "2026-10-20 ",
            "\t2026-10-20\n",
            " 2026-10-20 ",
            "2026-10-20T00:00:00",
            "2026-10-20T23:59:59+05:30",
            "2026-10-20 10:30:00",
            "2026-10-20junk",
            "2026-10-20/2026-09-30",
            "2026-10-20\x00",
            "2026-10-20\x00junk",
        ):
            with self.subTest(text=text):
                r = self.range(text, text)
                self.assertEqual(r.status_code, 201, r.content)
                row = self.only_row()
                self.assertEqual(
                    (row.start_date, row.end_date, float(row.total_days)), ("2026-10-20", "2026-10-20", 1.0)
                )
                self.assertEqual((r.json()["startDate"], r.json()["endDate"]), ("2026-10-20", "2026-10-20"))
                self.forget()

    def test_each_end_is_made_canonical_on_its_own(self):
        r = self.range(" 2026-10-20", "2026-10-22T00:00:00")
        self.assertEqual(r.status_code, 201, r.content)
        row = self.only_row()
        self.assertEqual((row.start_date, row.end_date, float(row.total_days)), ("2026-10-20", "2026-10-22", 3.0))

    def test_an_end_left_out_is_the_canonical_start(self):
        r = self.send({"employeeId": self.emp.id, "startDate": "2026-10-20T00:00:00"})
        self.assertEqual(r.status_code, 201, r.content)
        row = self.only_row()
        self.assertEqual((row.start_date, row.end_date), ("2026-10-20", "2026-10-20"))

    def test_a_date_time_range_is_counted_like_the_plain_range(self):
        r = self.range("2026-10-01", "2026-10-31")
        self.assertEqual(r.status_code, 201, r.content)
        plain = self.only_row().total_days
        self.assertEqual(float(plain), 27.0)  # 31 days less the four Sundays
        self.forget()
        for start, end in (
            ("2026-10-01T00:00:00", "2026-10-31T00:00:00"),
            (" 2026-10-01 ", "\t2026-10-31T23:59:59"),
            ("2026-10-01junk", "2026-10-31/2026-09-30"),
        ):
            with self.subTest(start=start, end=end):
                r = self.range(start, end)
                self.assertEqual(r.status_code, 201, r.content)
                row = self.only_row()
                self.assertEqual((row.start_date, row.end_date, row.total_days), ("2026-10-01", "2026-10-31", plain))
                self.forget()

    def test_what_is_stored_can_be_read_back_by_the_attendance_pages(self):
        # employee-shift-stats reads an approved leave's dates with date.fromisoformat: a stored date-time was an HTTP 500
        r = self.range("2026-10-01T00:00:00", "2026-10-31T00:00:00")
        self.assertEqual(r.status_code, 201, r.content)
        LeaveRequest.objects.update(status="approved")
        for who in (self.hr, self.emp_auth):
            stats = self.client.get(
                "/api/attendance/employee-shift-stats",
                {"employee_id": self.emp.id, "month": 10, "year": 2026},
                **who,
            )
            self.assertEqual(stats.status_code, 200, stats.content)

    # -- a NUL or a lone surrogate --

    def test_a_nul_or_a_lone_surrogate_after_the_date_cannot_crash_it(self):
        # json.dumps cannot write a lone surrogate, so these go in as raw JSON escapes
        for suffix in ("\\u0000", "\\ud800", "\\udfff", "x\\u0000\\ud800"):
            with self.subTest(suffix=suffix):
                body = '{"employeeId": %d, "startDate": "2026-10-20%s", "endDate": "2026-10-21%s"}'
                r = self.raw(body % (self.emp.id, suffix, suffix))
                self.assertEqual(r.status_code, 201, r.content)
                row = self.only_row()
                self.assertEqual(
                    (row.start_date, row.end_date, float(row.total_days)), ("2026-10-20", "2026-10-21", 2.0)
                )
                self.forget()

    def test_a_nul_or_a_lone_surrogate_inside_the_date_is_not_a_date(self):
        for text in ("\\ud800026-10-20", "2026-10-\\ud800", "2026-10-2\\u0000", "\\u00002026-10-2"):
            with self.subTest(text=text):
                body = '{"employeeId": %d, "startDate": "%s", "endDate": "2026-10-20"}'
                self.assert_window_400(self.raw(body % (self.emp.id, text)), INVALID)
        self.assertEqual(self.count(), 0)

    # -- the far end of the calendar --

    def test_the_far_end_of_the_calendar_answers_the_window_400_not_a_500(self):
        started = time.monotonic()
        with mock.patch("api.leave_request_views._count_leave_days") as counted:
            for start, end in (
                ("9999-12-31", "9999-12-31"),
                ("2026-10-20", "9999-12-31"),
                ("9999-12-31", "2026-10-20"),
                ("2026-10-01", "9999-12-30"),
                ("0001-01-01", "9999-12-30"),
                ("0001-01-01", "0001-01-01"),
            ):
                with self.subTest(start=start, end=end):
                    self.assert_window_400(self.range(start, end))
            half = {"isHalfDay": True, "halfDaySlot": "morning"}
            self.assert_window_400(self.range("9999-12-31", "9999-12-31", **half))
            # the days of a refused range are never counted
            counted.assert_not_called()
        self.assertEqual(self.count(), 0)
        self.assertLess(time.monotonic() - started, 3.0)  # the widest of these used to burn 2.2 s on its own

    def test_a_switched_off_workflow_answers_403_before_the_days_are_counted(self):
        approval.save_config("leave", enabled=False, actor="test")
        with mock.patch("api.leave_request_views._count_leave_days") as counted:
            for who in (self.emp_auth, self.hr):
                r = self.range("9999-12-31", "9999-12-31", who=who)
                self.assertEqual((r.status_code, r.json()["code"]), (403, "workflow_disabled"), r.content)
            counted.assert_not_called()
        self.assertEqual(self.count(), 0)

    def test_an_allowed_range_is_counted_once_after_the_checks(self):
        with mock.patch("api.leave_request_views._count_leave_days", return_value=4) as counted:
            r = self.range("2026-10-20", "2026-10-22")
        self.assertEqual(r.status_code, 201, r.content)
        counted.assert_called_once_with("2026-10-20", "2026-10-22")
        self.assertEqual(float(self.only_row().total_days), 4.0)

    # -- an employeeId that is not an integer --

    def test_an_employee_id_too_big_to_be_an_integer_is_a_400_not_a_500(self):
        for key in ("employeeId", "employee_id"):
            for number in ("1e999", "-1e999", "1E999"):
                with self.subTest(key=key, number=number):
                    r = self.raw('{"%s": %s, "startDate": "2026-10-20", "endDate": "2026-10-20"}' % (key, number))
                    self.assertEqual((r.status_code, r.json()), (400, {"error": "employeeId must be a number"}))
        self.assertEqual(self.count(), 0)

    # -- the half-day rule --

    def test_the_half_day_rule_reads_the_canonical_dates(self):
        half = {"isHalfDay": True, "halfDaySlot": "morning"}
        for start, end in (
            ("2026-10-20", "2026-10-20T00:00:00"),
            (" 2026-10-20", "2026-10-20junk"),
            ("2026-10-20T08:00:00", "2026-10-20 18:00:00"),
        ):
            with self.subTest(start=start, end=end):
                r = self.range(start, end, **half)
                self.assertEqual(r.status_code, 201, r.content)
                row = self.only_row()
                self.assertEqual(
                    (row.start_date, row.end_date, float(row.total_days)), ("2026-10-20", "2026-10-20", 0.5)
                )
                self.forget()
        for start, end in (("2026-10-20", "2026-10-21T00:00:00"), ("2026-10-20T00:00:00", " 2026-10-21")):
            with self.subTest(start=start, end=end):
                r = self.range(start, end, **half)
                self.assertEqual(
                    (r.status_code, r.json()["error"]), (400, "A half-day leave request must be for a single day")
                )
        self.assertEqual(self.count(), 0)

    # -- HR keeps today's behaviour --

    def test_hr_is_stored_and_counted_exactly_as_typed(self):
        # the canonical rewrite is for an employee token only: HR filing on someone's behalf is untouched
        r = self.range("2026-10-01T00:00:00", "2026-10-31T00:00:00", who=self.hr)
        self.assertEqual(r.status_code, 201, r.content)
        row = self.only_row()
        self.assertEqual(
            (row.start_date, row.end_date, float(row.total_days)), ("2026-10-01T00:00:00", "2026-10-31T00:00:00", 1.0)
        )
        self.forget()
        r = self.range(" 2026-10-20", "2026-10-22junk", who=self.hr)
        self.assertEqual(r.status_code, 201, r.content)
        row = self.only_row()
        self.assertEqual((row.start_date, row.end_date, float(row.total_days)), (" 2026-10-20", "2026-10-22junk", 1.0))
        self.forget()
        r = self.range("2020-01-06", "2020-01-12", who=self.hr)  # Monday to Sunday
        self.assertEqual(r.status_code, 201, r.content)
        row = self.only_row()
        self.assertEqual((row.start_date, row.end_date, float(row.total_days)), ("2020-01-06", "2020-01-12", 6.0))

    def test_hr_half_day_still_compares_the_text_as_typed(self):
        half = {"isHalfDay": True, "halfDaySlot": "morning"}
        r = self.range("2026-10-20", "2026-10-20T00:00:00", who=self.hr, **half)
        self.assertEqual((r.status_code, r.json()["error"]), (400, "A half-day leave request must be for a single day"))
        r = self.range("2026-10-20", "2026-10-20", who=self.hr, **half)
        self.assertEqual(r.status_code, 201, r.content)

    def test_hr_is_no_longer_crashed_by_the_last_day_of_the_calendar(self):
        r = self.range("9999-12-31", "9999-12-31", who=self.hr)
        self.assertEqual(r.status_code, 201, r.content)
        self.assertEqual((self.only_row().start_date, float(self.only_row().total_days)), ("9999-12-31", 1.0))


class CountLeaveDaysTests(SimpleTestCase):
    """_count_leave_days: working days (Monday to Saturday) from the start to the end, both included, at least 1."""

    @staticmethod
    def day_by_day(start: date, end: date) -> int:
        # the original day-by-day count, on ordinals so that it cannot overflow at the end of the calendar
        count = sum(1 for o in range(start.toordinal(), end.toordinal() + 1) if date.fromordinal(o).weekday() != 6)
        return max(1, count)

    def test_it_counts_like_the_day_by_day_count(self):
        first = date(2026, 10, 1)
        for offset in range(14):  # a start on every weekday, twice
            start = first + timedelta(days=offset)
            for length in range(-3, 45):  # an end before the start too
                end = start + timedelta(days=length)
                self.assertEqual(
                    _count_leave_days(start.isoformat(), end.isoformat()),
                    self.day_by_day(start, end),
                    f"{start} .. {end}",
                )

    def test_a_sunday_on_its_own_is_one_day(self):
        self.assertEqual(_count_leave_days("2026-10-04", "2026-10-04"), 1)
        self.assertEqual(_count_leave_days("2026-10-05", "2026-10-04"), 1)  # end before start
        self.assertEqual(_count_leave_days("2026-10-01", "2026-10-31"), 27)

    def test_the_last_day_of_the_calendar_does_not_overflow(self):
        for start, end in (("9999-12-31", "9999-12-31"), ("9999-12-25", "9999-12-31"), ("9990-01-01", "9999-12-31")):
            with self.subTest(start=start, end=end):
                self.assertEqual(
                    _count_leave_days(start, end), self.day_by_day(date.fromisoformat(start), date.fromisoformat(end))
                )

    def test_the_widest_range_is_counted_at_once(self):
        started = time.monotonic()
        counted = _count_leave_days("0001-01-01", "9999-12-31")
        self.assertLess(time.monotonic() - started, 0.5)  # a day-by-day loop took 2.2 s
        first, last = date.min.toordinal(), date.max.toordinal()
        sundays = last // 7 - (first - 1) // 7  # an ordinal that is a multiple of 7 is a Sunday
        self.assertEqual(counted, (last - first + 1) - sundays)

    def test_what_is_not_a_pair_of_dates_is_one_day(self):
        for start, end in (
            (None, None),
            ("", ""),
            ("garbage", "2026-10-20"),
            ("2026-10-20", "garbage"),
            ("2026-10-20T00:00:00", "2026-10-31T00:00:00"),
            ("2026-10-20", "\ud800"),
            ("2026-10-20\x00", "2026-10-21"),
        ):
            with self.subTest(start=start, end=end):
                self.assertEqual(_count_leave_days(start, end), 1)


class PermissionWindowTests(_EndpointCases, _Base):
    PATH = "/api/permissions"
    MODEL = EmployeePermission
    WORKFLOW = "permission"

    def body(self, value, emp):
        return {"employeeId": emp.id, "date": value, "type": "morning_late_in", "reason": "Bus broke down"}

    def send(self, body):
        with clock("2026-10-15"):
            return self.client.post(self.PATH, body, content_type="application/json", **self.emp_auth)

    def test_the_early_out_and_middle_kinds_are_held_to_the_same_window(self):
        for kind in ("evening_early_out", "middle_permission", "Early Out", "Short Leave", "Late In"):
            r = self.send({"employeeId": self.emp.id, "date": "2026-09-30", "type": kind})
            self.assertEqual((r.status_code, r.json()["error"]), (400, ONLY_OCTOBER_2026), kind)
        self.assertEqual(self.count(), 0)

    def test_a_request_with_no_type_is_held_to_the_window_too(self):
        r = self.send({"employeeId": self.emp.id, "date": "2026-09-30"})
        self.assertEqual((r.status_code, r.json()["error"]), (400, ONLY_OCTOBER_2026))
        ok = self.send({"employeeId": self.emp.id, "date": "2026-10-09"})
        self.assertEqual(ok.status_code, 201, ok.content)


class CasualLeaveWindowTests(_EndpointCases, _Base):
    PATH = "/api/casual-leaves"
    MODEL = CasualLeaveRequest
    WORKFLOW = "casual_leave"

    def body(self, value, emp):
        return {"employeeId": emp.id, "date": value, "reason": "Function"}

    def use(self, day: str, status="pending", emp=None):
        CasualLeaveRequest.objects.create(employee=emp or self.emp, date=D(day), status=status, approval_trail=[])

    def production_employee(self):
        production = _employee("RW3", employment_type="production")
        return production, _bearer({"role": "employee", "employeeId": production.id})

    def test_on_the_1st_and_2nd_this_months_casual_leave_does_not_use_up_last_months(self):
        # one per calendar month OF THE REQUESTED DATE
        self.use("2026-10-01")
        with clock("2026-10-02"):
            last_month = self.post("2026-09-30")
            this_month = self.post("2026-10-20")
        self.assertEqual(last_month.status_code, 201, last_month.content)
        self.assertEqual(this_month.status_code, 400, this_month.content)
        self.assertIn("already used this month", this_month.json()["error"])

    def test_after_the_grace_last_month_is_closed_even_if_unused(self):
        self.refused("2026-10-03", "2026-09-30", ONLY_OCTOBER_2026, "2026-10-01", "2026-10-31")

    def test_the_eligibility_rules_still_answer_first(self):
        production, auth = self.production_employee()
        with clock("2026-10-15"):
            r = self.post("2020-01-01", who=auth, emp=production)
        self.assertEqual(
            (r.status_code, r.json()), (400, {"error": "Casual Leave is available only for staff employees"})
        )

    def test_the_months_the_employee_may_pick_in_the_eligibility_check(self):
        def months(today, who=None, query=""):
            with clock(today):
                r = self.client.get("/api/casual-leaves/my-eligibility" + query, **(who or self.emp_auth))
            self.assertEqual(r.status_code, 200, r.content)
            return r.json()

        def entry(month, label, eligible=True, reason=None):
            return {"month": month, "label": label, "eligible": eligible, "reason": reason}

        used = "Casual Leave already used this month (limit: 1 per month)"
        # no grace: this month only
        body = months("2026-10-15")
        self.assertEqual(body["months"], [entry("2026-10", "October 2026")])
        # every key the clients already read is still there, unchanged
        self.assertEqual(
            set(body),
            {"eligible", "reason", "year", "yearlyEntitlement", "usedThisYear", "remainingThisYear", "months"},
        )
        self.assertEqual((body["yearlyEntitlement"], body["usedThisYear"], body["remainingThisYear"]), (12, 0, 12))
        # the grace days: last month first, then this month
        for today in ("2026-10-01", "2026-10-02"):
            self.assertEqual(
                months(today)["months"], [entry("2026-09", "September 2026"), entry("2026-10", "October 2026")]
            )
        self.assertEqual(months("2026-10-03")["months"], [entry("2026-10", "October 2026")])
        # this month's is used: last month's is still free during the grace, this month's is not
        self.use("2026-10-01")
        self.assertEqual(
            months("2026-10-02")["months"],
            [entry("2026-09", "September 2026"), entry("2026-10", "October 2026", False, used)],
        )
        self.assertEqual(months("2026-10-15")["months"], [entry("2026-10", "October 2026", False, used)])
        # last month's is used (an approved one counts as well as a pending one), this month's is free
        self.clear()
        self.use("2026-09-20", status="approved")
        self.assertEqual(
            months("2026-10-02")["months"],
            [entry("2026-09", "September 2026", False, used), entry("2026-10", "October 2026")],
        )
        self.assertEqual(months("2026-10-03")["months"], [entry("2026-10", "October 2026")])
        # a rejected request frees the month
        self.clear()
        self.use("2026-09-20", status="rejected")
        self.assertEqual(months("2026-10-01")["months"][0], entry("2026-09", "September 2026"))
        # January looks back to December of the year before
        self.assertEqual(
            months("2026-01-02")["months"], [entry("2025-12", "December 2025"), entry("2026-01", "January 2026")]
        )
        self.assertEqual(months("2026-01-03")["months"], [entry("2026-01", "January 2026")])
        # HR can read an employee's list too
        self.assertEqual(
            months("2026-10-02", who=self.hr, query=f"?employeeId={self.emp.id}")["months"],
            [entry("2026-09", "September 2026"), entry("2026-10", "October 2026")],
        )

    def test_the_months_of_someone_who_cannot_take_casual_leave_say_why(self):
        _, auth = self.production_employee()
        with clock("2026-10-02"):
            r = self.client.get("/api/casual-leaves/my-eligibility", **auth)
        reason = "Casual Leave is available only for staff employees"
        self.assertEqual(
            r.json()["months"],
            [
                {"month": "2026-09", "label": "September 2026", "eligible": False, "reason": reason},
                {"month": "2026-10", "label": "October 2026", "eligible": False, "reason": reason},
            ],
        )

    def test_the_list_agrees_with_what_the_form_will_accept(self):
        self.use("2026-10-01")
        with clock("2026-10-02"):
            listed = self.client.get("/api/casual-leaves/my-eligibility", **self.emp_auth).json()["months"]
            accepted = {m["month"]: self.post(f"{m['month']}-02").status_code for m in listed}
        self.assertEqual(accepted, {"2026-09": 201, "2026-10": 400})
        self.assertEqual({m["month"]: m["eligible"] for m in listed}, {"2026-09": True, "2026-10": False})


class MissingPunchWindowTests(_EndpointCases, _Base):
    PATH = "/api/missing-punch-requests"
    MODEL = MissingPunchRequest
    WORKFLOW = "missing_punch"
    NO_FUTURE = True

    def body(self, value, emp):
        return {
            "employeeId": emp.id,
            "date": value,
            "punchTime": "09:05",
            "punchSlot": "morning_in",
            "reason": "Machine down",
        }

    def test_today_and_the_days_before_it_are_allowed_but_never_tomorrow(self):
        self.allowed("2026-10-15", "2026-10-15")
        self.allowed("2026-10-15", "2026-10-14")
        self.refused("2026-10-15", "2026-10-16", FUTURE, "2026-10-01", "2026-10-31")
        self.refused("2026-10-15", "2026-10-31", FUTURE, "2026-10-01", "2026-10-31")
        self.refused("2026-10-01", "2026-10-02", FUTURE, "2026-09-01", "2026-10-31")
        self.allowed("2026-10-02", "2026-10-02")
        self.refused("2026-10-31", "2026-11-01", FUTURE, "2026-10-01", "2026-10-31")

    def test_a_future_date_outside_the_month_is_called_future_not_out_of_window(self):
        self.refused("2026-10-15", "2027-03-01", FUTURE, "2026-10-01", "2026-10-31")

    def test_hr_can_file_a_missing_punch_for_any_day(self):
        self.allowed("2026-10-15", "2026-10-16", who=self.hr)
        self.allowed("2026-10-15", "2025-02-03", who=self.hr)

    def test_the_old_form_without_a_punch_slot_is_held_to_the_window_too(self):
        body = {"employeeId": self.emp.id, "date": "2026-09-30", "punchTime": "09:05", "punchType": "IN", "reason": "x"}
        with clock("2026-10-15"):
            r = self.client.post(self.PATH, body, content_type="application/json", **self.emp_auth)
        self.assertEqual((r.status_code, r.json()["error"]), (400, ONLY_OCTOBER_2026))

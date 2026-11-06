"""
The Staff / Production Attendance page (2026-11-06 redesign) reads three things the old page did not:

    GET /api/attendance/daily?date=           every row gains `punches` (every punch of the day with its source) and
                                              `leaveState` + `leave` / `casualLeave` / `onDuty` (additive keys only)
    GET /api/attendance/employee-punches      every punch of one employee's month (the employee search's timeline)
    GET /api/attendance/monthly-summary       one row per employee for the month (the page's monthly report export)

What is pinned here:
  * every punch is listed with its source label, IN / OUT by position (as every other page labels them) and its real date;
    On-Duty punches still held for HR (not in AttendanceLog yet) are listed too, marked counted: false;
  * production night shifts: the closing punch made after midnight is listed on the day the night began, with its own
    date and nextDay; on the next day it is still shown, marked as closing the previous night (counted: false), and a
    double tap is shown as such - nothing a device recorded goes missing, and nothing is counted twice;
  * leaveState: pending leave / Casual Leave = leave_applied, approved leave = on_leave, approved Casual Leave = cl, an
    On-Duty request HR approved = on_duty; the existing `status` (and every other existing key) is unchanged;
  * the extra cost is a constant number of queries, whatever the roster size or the number of days.

Run via: python manage.py test api.tests_attendance_daily_punches -v 2
"""

from datetime import date, datetime, time, timedelta
from decimal import Decimal
from unittest.mock import patch

from django.db import connection
from django.test import TestCase
from django.test.utils import CaptureQueriesContext

from . import tests_production_consumers as _pc
from .attendance_final import compute_month_records, month_summary_from_records
from .clock import FACTORY_TZ
from .jwt_utils import sign_token
from .models import (
    AttendanceLog,
    Branch,
    CasualLeaveRequest,
    Employee,
    HRUser,
    LeaveRequest,
    OnDutyPunchVerification,
    OnDutySession,
    Role,
)

D = date(2026, 2, 3)  # a Tuesday
TODAY = date(2026, 2, 10)


def _t(text: str) -> time:
    parts = [int(x) for x in text.split(":")]
    return time(*parts)


def _staff(code: str, **extra) -> Employee:
    return Employee.objects.create(
        employee_code=code,
        first_name=code,
        last_name="Staff",
        employment_type="staff",
        status="active",
        join_date="2024-01-01",
        **extra,
    )


def _log(emp, d, hhmm, source="biometric:Gate 1", ptype="IN"):
    return AttendanceLog.objects.create(employee=emp, date=d, punch_time=_t(hhmm), punch_type=ptype, source=source)


def _ist(d: date, hhmm: str) -> datetime:
    return datetime.combine(d, _t(hhmm), tzinfo=FACTORY_TZ)


def _session(emp, status, *, started=None, created=None, ended=None, destination="Erode dyeing unit"):
    s = OnDutySession.objects.create(employee=emp, destination=destination, status=status)
    fields = {}
    if started:
        fields["started_at"] = started
    if ended:
        fields["employee_ended_at"] = ended
    if created:
        fields["created_at"] = created
    if fields:
        OnDutySession.objects.filter(pk=s.pk).update(**fields)
        s.refresh_from_db()
    return s


def _verification(session, d, hhmm, status="pending", number=1, ptype="IN"):
    return OnDutyPunchVerification.objects.create(
        session=session,
        employee=session.employee,
        punch_date=d,
        punch_time=_t(hhmm),
        punch_type=ptype,
        punch_number=number,
        latitude=Decimal("11.108500"),
        longitude=Decimal("77.341100"),
        photo="on_duty_punch_verifications/x.jpg",
        status=status,
    )


def _hr_auth(user=None) -> dict:
    user = user or HRUser.objects.create(
        username="dp_admin", password_hash="x", full_name="Dp Admin", is_super_admin=True
    )
    claims = {"role": "hr", "hrUserId": user.id, "name": user.full_name or user.username}
    return {"HTTP_AUTHORIZATION": "Bearer " + sign_token(claims)}


class _Base(TestCase):
    def setUp(self):
        for target in (
            "api.clock.ist_today",
            "api.attendance_views.ist_today",
            "api.attendance_final.ist_today",
            "api.payroll_calendar.ist_today",
        ):
            p = patch(target, return_value=TODAY)
            p.start()
            self.addCleanup(p.stop)
        self.auth = _hr_auth()

    def get(self, path, auth=None, **params):
        r = self.client.get(path, params, **(auth or self.auth))
        self.assertEqual(r.status_code, 200, r.content[:400])
        return r.json()

    def daily(self, d=D) -> dict:
        return {row["employeeCode"]: row for row in self.get("/api/attendance/daily", date=d.isoformat())}


# ═════════════════════════════════════════════════════════════════════════════
#  GET /api/attendance/daily: punches
# ═════════════════════════════════════════════════════════════════════════════


class DailyPunchTests(_Base):
    def test_every_punch_is_listed_with_its_source_and_position_and_the_old_keys_are_unchanged(self):
        emp = _staff("DP1")
        _log(emp, D, "08:31:05")
        _log(emp, D, "13:00:40", source="geo:auto")
        _log(emp, D, "13:45", source="manual")
        _log(emp, D, "18:05", source="on_duty:approved")
        _log(emp, D, "18:30", source="missing_punch:approved")
        row = self.daily()["DP1"]
        self.assertEqual(
            [(p["time"], p["type"], p["sourceLabel"], p["date"]) for p in row["punches"]],
            [
                ("08:31:05", "IN", "Biometric", "2026-02-03"),
                ("13:00:40", "OUT", "Geo Punch", "2026-02-03"),
                ("13:45:00", "IN", "HR Entry", "2026-02-03"),
                ("18:05:00", "OUT", "On-Duty", "2026-02-03"),
                ("18:30:00", "IN", "Missing Punch", "2026-02-03"),
            ],
        )
        self.assertEqual(row["punches"][0]["source"], "biometric:Gate 1")
        # nothing in a staff day is left uncounted, and nothing is on another date
        self.assertTrue(all("counted" not in p and "nextDay" not in p for p in row["punches"]))
        # the existing keys say what they always said
        self.assertEqual(
            (row["status"], row["firstPunch"], row["lastPunch"], row["totalPunches"], row["sourceLabel"]),
            ("present", "08:31", "18:30", 5, "Biometric"),
        )

    def test_a_day_without_punches_has_an_empty_list(self):
        _staff("DP2")
        row = self.daily()["DP2"]
        self.assertEqual(row["punches"], [])
        self.assertEqual(row["status"], "absent")

    def test_on_duty_punches_held_for_hr_are_listed_but_not_counted(self):
        emp = _staff("DP3")
        session = _session(emp, OnDutySession.STATUS_ACTIVE, started=_ist(D, "08:00"))
        _verification(session, D, "09:10", "pending", 1, "IN")
        _verification(session, D, "12:40", "rejected", 2, "OUT")
        other = _staff("DP3B")
        _verification(_session(other, OnDutySession.STATUS_ACTIVE, started=_ist(D, "08:00")), D, "10:00", "approved")
        rows = self.daily()
        punches = rows["DP3"]["punches"]
        self.assertEqual(
            [(p["time"], p["type"], p["counted"], p["verification"], p["sourceLabel"]) for p in punches],
            [
                ("09:10:00", "IN", False, "pending", "On-Duty (awaiting HR)"),
                ("12:40:00", "OUT", False, "rejected", "On-Duty (rejected)"),
            ],
        )
        # not attendance yet: the day's verdict and counts do not move
        self.assertEqual((rows["DP3"]["status"], rows["DP3"]["totalPunches"]), ("absent", 0))
        # an APPROVED verification is an AttendanceLog row (on_duty:approved) - never listed twice from here
        self.assertEqual(rows["DP3B"]["punches"], [])


class ProductionNightPunchTests(_Base):
    def setUp(self):
        super().setUp()
        _pc._ensure_seed()
        _pc._set_rules(_pc.LONG_AGO)
        self.night = _pc._worker("DPN")
        mon, tue, wed = _pc.MON, _pc.TUE, _pc.WED
        _log(self.night, mon, "21:00", source="biometric:Line 2")
        _log(self.night, tue, "05:30", source="biometric:Line 2")
        _log(self.night, tue, "05:32", source="biometric:Line 2")  # a double tap
        _log(self.night, tue, "21:00", source="biometric:Line 2")
        _log(self.night, wed, "05:30", source="biometric:Line 2")

    def test_the_closing_punch_after_midnight_is_on_the_shift_day_with_its_real_date(self):
        row = self.daily(_pc.MON)["DPN"]
        self.assertEqual(
            [(p["date"], p["time"], p["type"], p.get("nextDay", False)) for p in row["punches"]],
            [("2026-02-02", "21:00:00", "IN", False), ("2026-02-03", "05:30:00", "OUT", True)],
        )
        self.assertEqual((row["firstPunch"], row["lastPunch"], row["lastPunchNextDay"]), ("21:00", "05:30", True))

    def test_the_next_day_still_shows_that_punch_and_the_double_tap_but_does_not_count_them(self):
        row = self.daily(_pc.TUE)["DPN"]
        self.assertEqual(
            [(p["date"], p["time"], p["type"], p.get("counted", True), p.get("note")) for p in row["punches"]],
            [
                ("2026-02-03", "05:30:00", "IN", False, "previous_shift"),
                ("2026-02-03", "05:32:00", "IN", False, "double_tap"),
                ("2026-02-03", "21:00:00", "IN", True, None),
                ("2026-02-04", "05:30:00", "OUT", True, None),
            ],
        )
        self.assertEqual(row["totalPunches"], 2)  # the counted ones only, as before
        wed = self.daily(_pc.WED)["DPN"]
        self.assertEqual(
            [(p["time"], p["counted"], p["note"]) for p in wed["punches"]], [("05:30:00", False, "previous_shift")]
        )
        self.assertEqual(wed["status"], "absent")


# ═════════════════════════════════════════════════════════════════════════════
#  GET /api/attendance/daily: leaveState
# ═════════════════════════════════════════════════════════════════════════════


class DailyLeaveStateTests(_Base):
    def setUp(self):
        super().setUp()
        self.none = _staff("DL0")
        self.pending_leave = _staff("DL1")
        LeaveRequest.objects.create(
            employee=self.pending_leave, type="sick", start_date="2026-02-02", end_date="2026-02-04", reason="Fever"
        )
        self.approved_leave = _staff("DL2")
        LeaveRequest.objects.create(
            employee=self.approved_leave,
            type="earned",
            start_date="2026-02-03",
            end_date="2026-02-03",
            status="approved",
        )
        self.cl = _staff("DL3")
        CasualLeaveRequest.objects.create(employee=self.cl, date=D, status="approved", reason="Family function")
        self.cl_pending = _staff("DL4")
        CasualLeaveRequest.objects.create(employee=self.cl_pending, date=D, status="pending")
        self.on_duty = _staff("DL5")
        _session(self.on_duty, OnDutySession.STATUS_ACTIVE, started=_ist(D, "08:10"))
        self.od_requested = _staff("DL6")
        _session(self.od_requested, OnDutySession.STATUS_PENDING_HOD, created=_ist(D, "07:45"))
        self.half = _staff("DL7")
        LeaveRequest.objects.create(
            employee=self.half,
            type="casual",
            start_date="2026-02-03",
            end_date="2026-02-03",
            status="approved",
            is_half_day=True,
            half_day_slot="morning",
            total_days=Decimal("0.5"),
        )
        _log(self.half, D, "14:00")
        # an approved Casual Leave beats a pending leave the same day, and an approved On-Duty beats approved leave
        self.both = _staff("DL8")
        CasualLeaveRequest.objects.create(employee=self.both, date=D, status="approved")
        LeaveRequest.objects.create(employee=self.both, type="sick", start_date="2026-02-03", end_date="2026-02-03")
        self.od_and_leave = _staff("DL9")
        _session(self.od_and_leave, OnDutySession.STATUS_COMPLETED, started=_ist(D, "09:00"), ended=_ist(D, "18:00"))
        LeaveRequest.objects.create(
            employee=self.od_and_leave, type="earned", start_date="2026-02-03", end_date="2026-02-03", status="approved"
        )
        # rejected requests and other days say nothing
        self.rejected = _staff("DLR")
        CasualLeaveRequest.objects.create(employee=self.rejected, date=D, status="rejected")
        LeaveRequest.objects.create(
            employee=self.rejected, type="sick", start_date="2026-02-03", end_date="2026-02-03", status="rejected"
        )
        CasualLeaveRequest.objects.create(employee=self.none, date=D + timedelta(days=1), status="approved")
        _session(self.none, OnDutySession.STATUS_COMPLETED, started=_ist(D - timedelta(days=3), "09:00"))

    def test_each_kind_of_day_has_its_state(self):
        rows = self.daily()
        states = {code: rows[code]["leaveState"] for code in rows}
        self.assertEqual(
            states,
            {
                "DL0": None,
                "DL1": "leave_applied",
                "DL2": "on_leave",
                "DL3": "cl",
                "DL4": "leave_applied",
                "DL5": "on_duty",
                "DL6": None,
                "DL7": "on_leave",
                "DL8": "cl",
                "DL9": "on_duty",
                "DLR": None,
            },
        )

    def test_the_details_say_what_the_request_is(self):
        rows = self.daily()
        self.assertEqual(
            rows["DL1"]["leave"],
            {
                "status": "pending",
                "type": "sick",
                "isHalfDay": False,
                "halfDaySlot": None,
                "startDate": "2026-02-02",
                "endDate": "2026-02-04",
                "reason": "Fever",
            },
        )
        self.assertEqual(
            rows["DL3"]["casualLeave"], {"status": "approved", "portion": "full", "reason": "Family function"}
        )
        self.assertEqual(rows["DL5"]["onDuty"]["state"], "no_punches")
        self.assertEqual(rows["DL5"]["onDuty"]["destination"], "Erode dyeing unit")
        self.assertEqual(rows["DL6"]["onDuty"]["state"], "pending")  # requested, not approved: no leaveState
        self.assertTrue(rows["DL7"]["leave"]["isHalfDay"])
        self.assertEqual(rows["DL7"]["leave"]["halfDaySlot"], "morning")
        for key in ("leave", "casualLeave", "onDuty"):
            self.assertIsNone(rows["DL0"][key], key)

    def test_the_existing_status_is_not_changed_by_any_of_it(self):
        rows = self.daily()
        self.assertEqual(
            {code: rows[code]["status"] for code in ("DL1", "DL2", "DL3", "DL4", "DL5", "DL7")},
            # approved Casual Leave / On-Duty without punches stay "absent" in `status`: only leaveState tells them apart
            {"DL1": "absent", "DL2": "on_leave", "DL3": "absent", "DL4": "absent", "DL5": "absent", "DL7": "present"},
        )

    def test_an_approved_on_duty_day_with_its_verified_punch(self):
        _log(self.on_duty, D, "09:05", source="on_duty:approved")
        row = self.daily()["DL5"]
        self.assertEqual((row["leaveState"], row["onDuty"]["state"], row["status"]), ("on_duty", "verified", "present"))


# ═════════════════════════════════════════════════════════════════════════════
#  Query counts
# ═════════════════════════════════════════════════════════════════════════════


def _count(fn) -> int:
    with CaptureQueriesContext(connection) as ctx:
        fn()
    return len(ctx)


class QueryCountTests(_Base):
    def _fill(self, n, prefix):
        for i in range(n):
            emp = _staff(f"{prefix}{i}")
            _log(emp, D, "08:30")
            _log(emp, D, "17:30", source="geo:auto")
            LeaveRequest.objects.create(employee=emp, type="sick", start_date=str(D), end_date=str(D))
            CasualLeaveRequest.objects.create(employee=emp, date=D, status="approved" if i % 2 else "pending")
            session = _session(emp, OnDutySession.STATUS_ACTIVE, started=_ist(D, "08:00"))
            _verification(session, D, "11:00")

    def test_the_daily_list_costs_the_same_for_three_employees_or_twelve(self):
        def daily():
            self.daily()

        self._fill(3, "QS")
        daily()  # warm-up
        small = _count(daily)
        self._fill(9, "QL")
        daily()
        large = _count(daily)
        self.assertEqual(small, large, (small, large))

    def test_the_month_of_punches_costs_the_same_for_a_quiet_month_or_a_busy_one(self):
        emp = _staff("QM")
        _log(emp, D, "08:30")

        def month():
            self.get("/api/attendance/employee-punches", code="QM", month=2, year=2026)

        quiet = _count(month)
        session = _session(emp, OnDutySession.STATUS_ACTIVE, started=_ist(D, "08:00"))
        for day in range(1, 28):
            d = date(2026, 2, day)
            _log(emp, d, "09:00")
            _log(emp, d, "18:00", source="geo:auto")
            _verification(session, d, "12:00", number=day)
        busy = _count(month)
        self.assertEqual(quiet, busy, (quiet, busy))


# ═════════════════════════════════════════════════════════════════════════════
#  GET /api/attendance/employee-punches
# ═════════════════════════════════════════════════════════════════════════════


class EmployeePunchesTests(_Base):
    def test_a_month_of_every_punch_by_day_with_the_sources_tallied(self):
        emp = _staff("EP1")
        _log(emp, date(2026, 2, 2), "08:29")
        _log(emp, date(2026, 2, 2), "18:01", source="geo:auto")
        _log(emp, date(2026, 2, 3), "08:40", source="biometric:adms")
        _log(emp, date(2026, 1, 31), "08:30")  # another month
        session = _session(emp, OnDutySession.STATUS_ACTIVE, started=_ist(date(2026, 2, 4), "08:00"))
        _verification(session, date(2026, 2, 4), "09:15")
        body = self.get("/api/attendance/employee-punches", code="ep1", month=2, year=2026)
        self.assertEqual(body["employee"]["code"], "EP1")
        self.assertEqual([d["date"] for d in body["days"]], ["2026-02-02", "2026-02-03", "2026-02-04"])
        first = body["days"][0]["punches"]
        self.assertEqual(
            [(p["time"], p["type"], p["sourceLabel"]) for p in first],
            [
                ("08:29:00", "IN", "Biometric"),
                ("18:01:00", "OUT", "Geo Punch"),
            ],
        )
        self.assertEqual(body["days"][2]["punches"][0]["verification"], "pending")
        self.assertEqual((body["totalPunches"], body["countedPunches"]), (4, 3))
        self.assertEqual(
            body["sources"],
            [
                {"label": "Biometric", "count": 2},
                {"label": "Geo Punch", "count": 1},
                {"label": "On-Duty (awaiting HR)", "count": 1},
            ],
        )
        # by id gives the same month
        again = self.get("/api/attendance/employee-punches", employeeId=emp.id, month=2, year=2026)
        self.assertEqual(again["days"], body["days"])

    def test_production_night_shifts_are_listed_on_their_shift_day(self):
        _pc._ensure_seed()
        _pc._set_rules(_pc.LONG_AGO)
        emp = _pc._worker("EPN")
        _log(emp, _pc.MON, "21:00")
        _log(emp, _pc.TUE, "05:30")
        body = self.get("/api/attendance/employee-punches", code="EPN", month=2, year=2026)
        days = {d["date"]: d for d in body["days"]}
        self.assertEqual(
            [(p["date"], p["time"], p["type"], p.get("nextDay", False)) for p in days["2026-02-02"]["punches"]],
            [("2026-02-02", "21:00:00", "IN", False), ("2026-02-03", "05:30:00", "OUT", True)],
        )
        self.assertTrue(days["2026-02-02"]["shiftDay"])
        self.assertEqual(
            [(p["time"], p["counted"], p["note"]) for p in days["2026-02-03"]["punches"]],
            [("05:30:00", False, "previous_shift")],
        )
        self.assertEqual((body["totalPunches"], body["countedPunches"]), (3, 2))

    def test_bad_requests_and_who_may_ask(self):
        emp = _staff("EP2")
        r = self.client.get("/api/attendance/employee-punches", {"month": 2, "year": 2026}, **self.auth)
        self.assertEqual(r.status_code, 400)
        r = self.client.get("/api/attendance/employee-punches", {"code": "NOPE", "month": 2, "year": 2026}, **self.auth)
        self.assertEqual(r.status_code, 404)
        r = self.client.get("/api/attendance/employee-punches", {"code": "EP2", "month": 13, "year": 2026}, **self.auth)
        self.assertEqual(r.status_code, 400)
        token = sign_token({"role": "employee", "employeeId": emp.id})
        r = self.client.get("/api/attendance/employee-punches", {"code": "EP2"}, HTTP_AUTHORIZATION=f"Bearer {token}")
        self.assertEqual(r.status_code, 403)

    def test_a_branch_scoped_login_cannot_read_another_branchs_employee(self):
        home = Branch.objects.create(name="DP Home", code="DPH")
        away = Branch.objects.create(name="DP Away", code="DPA")
        _staff("EP3", branch=away)
        _staff("EP4", branch=home)
        role = Role.objects.create(name="DP Viewer", permissions={"attendance": "view"})
        scoped = HRUser.objects.create(username="dp_scoped", password_hash="x", role=role, branch=home)
        auth = _hr_auth(scoped)
        r = self.client.get("/api/attendance/employee-punches", {"code": "EP3"}, **auth)
        self.assertEqual(r.status_code, 404)
        self.assertEqual(self.get("/api/attendance/employee-punches", auth=auth, code="EP4")["employee"]["code"], "EP4")
        codes = {row["employeeCode"] for row in self.get("/api/attendance/daily", auth=auth, date=D.isoformat())}
        self.assertIn("EP4", codes)
        self.assertNotIn("EP3", codes)


# ═════════════════════════════════════════════════════════════════════════════
#  GET /api/attendance/monthly-summary
# ═════════════════════════════════════════════════════════════════════════════


class MonthlySummaryTests(_Base):
    def setUp(self):
        super().setUp()
        self.emp = _staff("MS1")
        for day in (2, 3, 4):
            _log(self.emp, date(2026, 2, day), "09:00")
            _log(self.emp, date(2026, 2, day), "18:00")
        _log(self.emp, date(2026, 2, 5), "09:00")  # one punch: the engine decides what it is
        LeaveRequest.objects.create(
            employee=self.emp, type="earned", start_date="2026-02-06", end_date="2026-02-06", status="approved"
        )
        CasualLeaveRequest.objects.create(employee=self.emp, date=date(2026, 2, 9), status="approved")
        CasualLeaveRequest.objects.create(
            employee=self.emp, date=date(2026, 2, 10), status="approved", portion="first_half"
        )
        CasualLeaveRequest.objects.create(employee=self.emp, date=date(2026, 2, 20), status="approved")  # after today
        CasualLeaveRequest.objects.create(employee=self.emp, date=date(2026, 2, 11), status="pending")
        _session(
            self.emp,
            OnDutySession.STATUS_COMPLETED,
            started=_ist(date(2026, 2, 7), "09:00"),
            ended=_ist(date(2026, 2, 8), "18:00"),
        )
        self.prod = _pc._worker("MS2")

    def test_one_row_per_employee_with_the_engines_counts(self):
        body = self.get("/api/attendance/monthly-summary", year=2026, month=2, employmentType="staff")
        self.assertEqual(
            (body["year"], body["month"], body["employmentType"], body["asOf"]), (2026, 2, "staff", "2026-02-10")
        )
        rows = {r["employeeCode"]: r for r in body["rows"]}
        self.assertNotIn("MS2", rows)  # production is left out of the staff report
        row = rows["MS1"]
        truth = month_summary_from_records(compute_month_records(self.emp, 2026, 2))
        self.assertEqual(
            (row["present"], row["halfDay"], row["absent"], row["onLeave"], row["late"], row["workingDays"]),
            (
                truth["present"],
                truth["halfShift"],
                truth["absent"],
                truth["onLeave"],
                truth["late"],
                truth["workingDays"],
            ),
        )
        self.assertGreaterEqual(row["present"], 3)
        self.assertEqual(row["onLeave"], 1)
        self.assertEqual(row["cl"], 1.5)  # a full day and a first half up to today; the 20th has not happened
        self.assertEqual(row["onDuty"], 2)  # the 7th and the 8th
        self.assertEqual(row["employmentType"], "staff")

    def test_all_types_and_production(self):
        everyone = {r["employeeCode"] for r in self.get("/api/attendance/monthly-summary", year=2026, month=2)["rows"]}
        self.assertTrue({"MS1", "MS2"} <= everyone)
        prod = self.get("/api/attendance/monthly-summary", year=2026, month=2, employmentType="production")["rows"]
        self.assertEqual([r["employeeCode"] for r in prod], ["MS2"])

    def test_a_bad_type_or_month_is_refused(self):
        for params in ({"year": 2026, "month": 2, "employmentType": "contract"}, {"year": 2026, "month": 0}):
            r = self.client.get("/api/attendance/monthly-summary", params, **self.auth)
            self.assertEqual(r.status_code, 400, params)

    def test_a_month_that_has_not_started_counts_nothing(self):
        rows = self.get("/api/attendance/monthly-summary", year=2026, month=3, employmentType="staff")["rows"]
        row = {r["employeeCode"]: r for r in rows}["MS1"]
        self.assertEqual((row["present"], row["absent"], row["cl"], row["onDuty"]), (0, 0, 0.0, 0))

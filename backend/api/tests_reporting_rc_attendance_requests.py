"""
Report Center 2026-11-19 layout, Attendance category, requests side (reporting/definitions/rc_attendance_requests.py):
leave-report, employee-overall-leave, geo-attendance, on-duty-report and on-duty-punch-details.

Every date is fixed (March 2026; 1 March 2026 is a Sunday) so nothing depends on the day the suite runs, except the
"defaults run" checks, which only need a 200.

Run via: python manage.py test api.tests_reporting_rc_attendance_requests -v 2
"""

import io
from datetime import date, datetime, time, timedelta, timezone as dt_timezone
from decimal import Decimal
from unittest import mock

from django.apps import apps
from django.db import connection
from django.http import QueryDict
from django.test import RequestFactory, TestCase
from django.test.utils import CaptureQueriesContext
from openpyxl import load_workbook

from .geo_utils import haversine_distance_m
from .jwt_utils import sign_token
from .models import (
    AttendanceDayRecord,
    AttendanceLog,
    AttendanceOverrideRequest,
    Branch,
    CasualLeaveRequest,
    CompensationConfig,
    Department,
    Designation,
    DutyTrack,
    Employee,
    EmployeePermission,
    HRUser,
    LeaveRequest,
    LeaveType,
    MissingPunchRequest,
    OnDutyPunchVerification,
    OnDutySession,
    PayrollSettings,
    Role,
)
from .permission_registry import all_module_keys
from .reporting import registry
from .reporting.layout import LAYOUT, is_listed
from .reporting.runner import run_report as engine_run

UTC = dt_timezone.utc
MARCH = {"dateFrom": "2026-03-01", "dateTo": "2026-03-31"}
IDS = ("leave-report", "employee-overall-leave", "geo-attendance", "on-duty-report", "on-duty-punch-details")
SITE = (11.131824, 77.319245)  # branch b1 geofence centre, radius 80 m
NEAR = (Decimal("11.131490"), Decimal("77.318915"))  # ~52 m from the site
FAR = (Decimal("11.200000"), Decimal("77.400000"))  # ~11.6 km away
NO_ONE = "999999999"
ALL_MODULES = {
    "reports": "view",
    "leave": "view",
    "casual_leave": "view",
    "geo_attendance": "view",
    "attendance": "view",
    "missing_punch": "view",
}


def _headers(user):
    return {"HTTP_AUTHORIZATION": f"Bearer {sign_token({'role': 'hr', 'hrUserId': user.id})}"}


def ist(y, m, d, hh=10, mm=0):
    """An IST wall-clock moment as the aware UTC instant the database stores."""
    return datetime(y, m, d, hh, mm, tzinfo=UTC) - timedelta(hours=5, minutes=30)


class _Base(TestCase):
    @classmethod
    def setUpTestData(cls):
        ps = PayrollSettings.get()
        ps.cl_balance_since = date(2026, 3, 10)
        ps.permission_monthly_cap = 3
        ps.save()
        cls.b1 = Branch.objects.create(
            name="RC Unit 1", code="RCU1", geofence_lat=Decimal(str(SITE[0])), geofence_lng=Decimal(str(SITE[1])),
            geofence_radius_m=80,
        )  # fmt: skip
        cls.b2 = Branch.objects.create(name="RC Unit 2", code="RCU2")  # no location configured
        cls.cutting = Department.objects.create(name="RC CUTTING", branch=cls.b1)
        cls.sewing = Department.objects.create(name="RC SEWING", branch=cls.b2)
        cls.operator = Designation.objects.create(title="RC Operator")
        cls.al, _ = LeaveType.objects.get_or_create(code="AL", defaults={"name": "Annual Leave"})
        cls.sl, _ = LeaveType.objects.get_or_create(code="SL", defaults={"name": "Sick Leave"})

        mk = cls.mk
        cls.a = mk("RC_A", "Asha", cls.cutting, cls.b1, date_of_birth=date(1990, 7, 1))
        cls.b = mk("RC_B", "Bala", cls.cutting, cls.b1, date_of_birth=date(1991, 3, 23))
        cls.c = mk("RC_C", "Chitra", cls.sewing, cls.b2)
        # production join dates are stored as '01-01-<Excel serial>' text (the known data trap)
        cls.p = mk("RC_P", "Pavan", cls.cutting, cls.b1, employment_type="production", join_date="01-01-45640")
        cls.g = mk("RC_G", "Gopal", cls.cutting, cls.b1, status="inactive")

        cls.admin = HRUser.objects.create(username="rc_admin", password_hash="x", is_super_admin=True)
        cls.b1_user = HRUser.objects.create(
            username="rc_b1",
            password_hash="x",
            branch=cls.b1,
            role=Role.objects.create(name="rc_b1_role", permissions=dict(ALL_MODULES)),
        )
        cls.seed_leave()
        cls.seed_on_duty()

    @classmethod
    def mk(cls, code, first, dept, branch, **kw):
        kw.setdefault("employment_type", "staff")
        kw.setdefault("salary_amount", Decimal("26000"))
        kw.setdefault("join_date", "2020-01-01")
        return Employee.objects.create(
            employee_code=code,
            first_name=first,
            last_name="Kumar",
            department=dept,
            branch=branch,
            designation=cls.operator,
            **kw,
        )

    @classmethod
    def lr(cls, emp, lt, start, end, total, status, **kw):
        return LeaveRequest.objects.create(
            employee=emp,
            leave_type_ref=lt,
            type=lt.code,
            start_date=start,
            end_date=end,
            total_days=Decimal(str(total)),
            status=status,
            approved_by="Ravi" if status != "pending" else None,
            approver_role="hr" if status != "pending" else None,
            reason="family function",
            **kw,
        )

    @classmethod
    def cl(cls, emp, d, status, portion="full", **kw):
        return CasualLeaveRequest.objects.create(
            employee=emp,
            date=d,
            status=status,
            portion=portion,
            reviewed_by="Ravi" if status != "pending" else None,
            reviewer_role="hr" if status != "pending" else None,
            **kw,
        )

    @classmethod
    def seed_leave(cls):
        a = cls.a
        cls.lr_al1 = cls.lr(a, cls.al, "2026-03-02", "2026-03-04", 3, "approved")
        cls.lr_sl = cls.lr(
            a, cls.sl, "2026-03-16", "2026-03-16", 0.5, "approved", is_half_day=True, half_day_slot="morning"
        )
        cls.lr_al2 = cls.lr(a, cls.al, "2026-03-20", "2026-03-21", 2, "pending")
        cls.lr_al3 = cls.lr(a, cls.al, "2026-03-25", "2026-03-25", 1, "rejected")
        cls.lr(cls.p, cls.al, "2026-03-05", "2026-03-05", 1, "approved")
        cls.lr(cls.c, cls.al, "2026-03-06", "2026-03-06", 1, "approved")
        cls.lr(cls.g, cls.al, "2026-03-27", "2026-03-27", 1, "approved")
        # cut-over 10 March: cl1 is before it (old rule), cl5 is before it but given by HR on Carry Forward (counts)
        cls.cl1 = cls.cl(a, date(2026, 3, 5), "approved")
        cls.cl2 = cls.cl(a, date(2026, 3, 12), "approved", portion="first_half")
        cls.cl3 = cls.cl(a, date(2026, 3, 13), "pending")
        cls.cl4 = cls.cl(a, date(2026, 3, 18), "rejected")
        cls.cl5 = cls.cl(a, date(2026, 3, 9), "approved", approval_trail=[{"via": "carry_forward", "role": "hr"}])
        cls.cl6 = cls.cl(cls.b, date(2026, 3, 23), "approved")  # B's birthday
        CasualLeaveRequest.objects.filter(pk=cls.cl1.pk).update(created_at=ist(2026, 3, 3))
        # a Casual Leave HR proposed on the Attendance Edit page, still waiting (holds 0.5 of A's balance)
        AttendanceOverrideRequest.objects.create(
            employee=a,
            date=date(2026, 3, 26),
            requested_values={"option": "casual_leave", "portion": "second_half"},
            status="pending",
        )
        for d, st, typ in (
            (date(2026, 3, 2), "approved", "morning_late_in"),
            (date(2026, 3, 3), "approved", "evening_early_out"),
            (date(2026, 3, 4), "approved", "middle_permission"),
            (date(2026, 3, 5), "approved", "morning_late_in"),  # the 4th approved one in March: beyond the cap of 3
            (date(2026, 3, 6), "pending", "morning_late_in"),
            (date(2026, 3, 9), "rejected", "evening_early_out"),
        ):
            EmployeePermission.objects.create(employee=a, date=d, status=st, type=typ, permission_time=time(9, 30))
        MissingPunchRequest.objects.create(
            employee=a, date=date(2026, 3, 23), punch_time=time(9, 2), punch_type="IN", punch_slot="morning_in",
            reason="forgot", status="approved",
        )  # fmt: skip
        MissingPunchRequest.objects.create(
            employee=a, date=date(2026, 3, 24), punch_time=time(18, 0), punch_type="OUT", reason="forgot",
            status="pending_hr",
        )  # fmt: skip
        for d, st, shifts in (
            (date(2026, 3, 2), "on_leave", 0),
            (date(2026, 3, 16), "half_shift", Decimal("0.5")),
            (date(2026, 3, 23), "absent", 0),
            (date(2026, 3, 24), "absent", 0),
        ):
            AttendanceDayRecord.objects.create(employee=a, date=d, status=st, shifts_earned=shifts)
        # production: a weekday absence counts, a Sunday one does not
        AttendanceDayRecord.objects.create(employee=cls.p, date=date(2026, 3, 10), status="absent")
        AttendanceDayRecord.objects.create(employee=cls.p, date=date(2026, 3, 15), status="absent")

    @classmethod
    def session(cls, emp, d, status, destination="Client site", **kw):
        s = OnDutySession.objects.create(employee=emp, destination=destination, status=status, branch=emp.branch, **kw)
        OnDutySession.objects.filter(pk=s.pk).update(created_at=ist(d.year, d.month, d.day, 8, 30))
        s.refresh_from_db()
        return s

    @classmethod
    def verify(cls, s, d, t, n, status, where=NEAR, mocked=False, comment=None):
        return OnDutyPunchVerification.objects.create(
            session=s, employee=s.employee, punch_date=d, punch_time=t, punch_type="IN" if n % 2 else "OUT",
            punch_number=n, latitude=where[0], longitude=where[1], accuracy_m=21.5, is_mocked=mocked,
            photo="on_duty_punch_verifications/x.jpg", status=status, hr_review_comment=comment,
            hr_reviewed_by="Ravi" if status != "pending" else None,
        )  # fmt: skip

    @classmethod
    def seed_on_duty(cls):
        a, d11 = cls.a, date(2026, 3, 11)
        cls.s1 = cls.session(a, d11, "completed", hr_reviewed_by="Ravi", hr_reviewed_at=ist(2026, 3, 11, 9))
        cls.v1 = cls.verify(cls.s1, d11, time(10, 30), 1, "approved")
        cls.v2 = cls.verify(cls.s1, d11, time(13, 0), 2, "pending", where=FAR, mocked=True)
        DutyTrack.objects.create(session=cls.s1, employee=a, branch=cls.b1, distance_m=12345.0, stop_count=2)
        cls.s2 = cls.session(
            a, date(2026, 3, 17), "rejected", hod_reviewed_by="Hod", hod_reviewed_at=ist(2026, 3, 17, 9)
        )
        cls.v3 = cls.verify(
            cls.s2, date(2026, 3, 17), time(9, 30), 1, "rejected",
            comment="Voided automatically -the On-Duty request was rejected by HOD.",
        )  # fmt: skip
        cls.s3 = cls.session(a, date(2026, 3, 19), "pending_hod")
        cls.s4 = cls.session(cls.c, date(2026, 3, 12), "completed", hr_reviewed_by="Ravi")
        cls.v4 = cls.verify(cls.s4, date(2026, 3, 12), time(11, 0), 1, "approved", where=FAR)
        cls.s5 = cls.session(cls.p, date(2026, 3, 14), "completed")
        cls.s6 = cls.session(cls.p, date(2026, 3, 21), "completed")
        # punches: A's day (device, the on-duty copy of v1, an office geo punch), B's and C's office geo punches,
        # P's night shift (20:00 on the 14th, 06:00 next morning)
        for emp, d, t, kind, src in (
            (a, d11, time(9, 1), "IN", "biometric:HO"),
            (a, d11, time(10, 30), "IN", "on_duty:approved"),
            (a, d11, time(18, 5), "OUT", "geo:auto"),
            (cls.b, date(2026, 3, 12), time(9, 10), "IN", "geo:auto"),
            (cls.c, date(2026, 3, 12), time(8, 55), "IN", "geo:auto"),
            (cls.p, date(2026, 3, 14), time(20, 0), "IN", "biometric:HO"),
            (cls.p, date(2026, 3, 15), time(6, 0), "IN", "biometric:HO"),
        ):
            AttendanceLog.objects.create(employee=emp, date=d, punch_time=t, punch_type=kind, source=src)
        # stored verdicts: A's on-duty day is a quarter day (0.75), P's night shift day earned 1.25, and an old
        # production day still holds a pre-quarter value (2.72)
        AttendanceDayRecord.objects.create(
            employee=a, date=d11, status="present", shifts_earned=Decimal("0.75"), arrival_zone="quarter"
        )
        AttendanceDayRecord.objects.create(
            employee=cls.p, date=date(2026, 3, 14), status="present", shifts_earned=Decimal("1.25")
        )
        AttendanceDayRecord.objects.create(
            employee=cls.p, date=date(2026, 3, 21), status="present", shifts_earned=Decimal("2.72")
        )

    # ── http helpers ──
    def hr(self, name, perms, **kw):
        return HRUser.objects.create(
            username=name, password_hash="x", role=Role.objects.create(name=name, permissions=perms), **kw
        )

    def get(self, path, user=None, **params):
        return self.client.get(path, params, **_headers(user or self.admin))

    def run_report(self, rid, user=None, **params):
        r = self.get(f"/api/reports/run/{rid}", user, **params)
        self.assertEqual(r.status_code, 200, r.content[:400])
        return r.json()

    def export(self, rid, fmt, user=None, **params):
        return self.get(f"/api/reports/export/{rid}", user, fmt=fmt, **params)

    def data_rows(self, body):
        return [r for r in body["rows"] if r.get("_kind") is None]

    def codes(self, body):
        return [r["employeeCode"] for r in self.data_rows(body)]

    def summary(self, body):
        return {s["label"]: s["value"] for s in body["summary"]}


# ════════════════════════════════════════════════════════════════════════════
#  Registry, catalog, access
# ════════════════════════════════════════════════════════════════════════════


class RegistryTests(_Base):
    def test_ids_are_registered_in_the_attendance_layout_with_real_modules(self):
        self.assertEqual(registry.LOAD_ERRORS, {})
        for rid in IDS:
            spec = registry.get_spec(rid)
            self.assertIsNotNone(spec, rid)
            self.assertEqual(spec.category, "attendance", rid)
            self.assertIn(rid, LAYOUT["attendance"])
            self.assertTrue(is_listed(spec))
            self.assertTrue(spec.modules, rid)
            self.assertTrue(set(spec.modules) <= set(all_module_keys()), rid)
            self.assertLessEqual(len(spec.filters), 8, rid)
            self.assertLess(len(spec.description), 220, rid)
        titles = {registry.get_spec(r).title for r in IDS}
        self.assertEqual(
            titles,
            {
                "Leave Report",
                "Individual Employee Overall Leave Report",
                "Geo Attendance Report",
                "On-Duty Report",
                "On-Duty with Punch Details",
            },
        )

    def test_catalog_lists_them_in_layout_order_and_the_retired_base_stays_hidden(self):
        reports = self.get("/api/reports/catalog").json()["reports"]
        att = [r["id"] for r in reports if r["category"] == "attendance"]
        ours = [i for i in att if i in IDS]
        self.assertEqual(ours, [i for i in LAYOUT["attendance"] if i in IDS])
        self.assertNotIn("on-duty-register", {r["id"] for r in reports})
        self.assertEqual(self.get("/api/reports/run/on-duty-register").status_code, 404)
        overall = next(r for r in reports if r["id"] == "employee-overall-leave")
        emp_filter = next(f for f in overall["filters"] if f["kind"] == "employee")
        self.assertTrue(emp_filter["required"])

    def test_every_report_runs_on_its_defaults(self):
        for rid in IDS:
            with self.subTest(report=rid):
                body = self.run_report(rid)
                self.assertTrue(body["columns"])

    def test_roles_need_an_owning_module(self):
        plain = self.hr("rc_plain", {"reports": "view"})
        for rid in IDS:
            r = self.get(f"/api/reports/run/{rid}", plain)
            self.assertEqual(r.status_code, 403, rid)
            self.assertEqual(r.json()["error"], "report_forbidden", rid)
        geo = self.hr("rc_geo", {"reports": "view", "geo_attendance": "view"})
        for rid in ("geo-attendance", "on-duty-report", "on-duty-punch-details"):
            self.assertEqual(self.get(f"/api/reports/run/{rid}", geo).status_code, 200, rid)
        self.assertEqual(self.get("/api/reports/run/leave-report", geo).status_code, 403)
        hidden = self.hr("rc_hidden", {**ALL_MODULES, "reports.attendance": "hidden"})
        for rid in IDS:
            self.assertEqual(self.get(f"/api/reports/run/{rid}", hidden).status_code, 404, rid)

    def test_reports_never_load_photos_or_password_hashes_and_never_write(self):
        Employee.objects.update(photo_url="data:image/png;base64," + "A" * 5000)
        before = {
            m.__name__: m.objects.count() for m in apps.get_app_config("api").get_models() if m.__name__ != "AuditLog"
        }
        params = {
            "leave-report": MARCH,
            "employee-overall-leave": {"employeeIds": str(self.a.id), "year": "2026"},
            "geo-attendance": MARCH,
            "on-duty-report": MARCH,
            "on-duty-punch-details": MARCH,
        }
        for rid, q in params.items():
            with self.subTest(report=rid):
                with CaptureQueriesContext(connection) as ctx:
                    self.run_report(rid, **q)
                    self.assertEqual(self.export(rid, "xlsx", **q).status_code, 200)
                sqls = [x["sql"] for x in ctx.captured_queries]
                leaks = [q[:120] for q in sqls if '"employees"."photo_url"' in q or '"employees"."password_hash"' in q]
                self.assertEqual(leaks, [])
        after = {
            m.__name__: m.objects.count() for m in apps.get_app_config("api").get_models() if m.__name__ != "AuditLog"
        }
        self.assertEqual({k: (before[k], after[k]) for k in before if before[k] != after[k]}, {})


# ════════════════════════════════════════════════════════════════════════════
#  Leave Report
# ════════════════════════════════════════════════════════════════════════════


class LeaveReportTests(_Base):
    def rows_of(self, body, code):
        return [r for r in self.data_rows(body) if r["employeeCode"] == code]

    def test_rows_cover_leave_requests_and_casual_leave_with_cl_balance_rules(self):
        body = self.run_report("leave-report", **MARCH)
        self.assertEqual(self.codes(body), ["RC_A"] * 9 + ["RC_B", "RC_C", "RC_G", "RC_P"])
        a = self.rows_of(body, "RC_A")
        self.assertEqual(
            [(r["startDate"], r["kind"]) for r in a],
            [
                ("2026-03-02", "Leave"),
                ("2026-03-05", "Casual Leave"),
                ("2026-03-09", "Casual Leave"),
                ("2026-03-12", "Casual Leave"),
                ("2026-03-13", "Casual Leave"),
                ("2026-03-16", "Leave"),
                ("2026-03-18", "Casual Leave"),
                ("2026-03-20", "Leave"),
                ("2026-03-25", "Leave"),
            ],
        )
        by_date = {r["startDate"]: r for r in a}
        self.assertEqual(by_date["2026-03-02"]["leaveType"], "Annual Leave")
        self.assertEqual(by_date["2026-03-02"]["days"], 3.0)
        self.assertEqual(by_date["2026-03-02"]["payEffect"], "Unpaid (LOP)")
        self.assertEqual(by_date["2026-03-02"]["decidedBy"], "Ravi (HR)")
        self.assertIsNone(by_date["2026-03-02"]["clBalance"])
        self.assertEqual(by_date["2026-03-16"]["dayType"], "Half day (morning)")
        self.assertEqual(by_date["2026-03-16"]["daysInPeriod"], 0.5)
        self.assertEqual(by_date["2026-03-20"]["daysInPeriod"], 2.0)  # Fri + Sat
        self.assertIsNone(by_date["2026-03-20"]["decidedBy"])
        # Casual Leave: cl_balance rules
        self.assertEqual(by_date["2026-03-05"]["clBalance"], "Before cut-over (old rule)")
        self.assertEqual(by_date["2026-03-05"]["payEffect"], "Paid (Casual Leave)")
        self.assertEqual(by_date["2026-03-09"]["clBalance"], "Used - HR Carry Forward")
        self.assertEqual(by_date["2026-03-12"]["clBalance"], "Used")
        self.assertEqual(by_date["2026-03-12"]["days"], 0.5)
        self.assertEqual(by_date["2026-03-12"]["dayType"], "Half day (first half)")
        self.assertEqual(by_date["2026-03-12"]["payEffect"], "Half day paid (Casual Leave)")
        self.assertEqual(by_date["2026-03-13"]["clBalance"], "Held (pending)")
        self.assertEqual(by_date["2026-03-13"]["payEffect"], "Awaiting decision")
        self.assertEqual(by_date["2026-03-18"]["clBalance"], "Not used (rejected)")
        self.assertEqual(self.rows_of(body, "RC_P")[0]["payEffect"], "No effect (production)")

    def test_summary_cards_and_the_by_type_section(self):
        body = self.run_report("leave-report", **MARCH)
        s = self.summary(body)
        self.assertEqual(s["Requests"], 13)
        self.assertEqual(s["Approved days"], 10.0)  # A 3 + 1 + 1 + 0.5 + 0.5, B 1, C 1, G 1, P 1
        self.assertEqual(s["Pending days"], 3.0)  # A Fri + Sat leave, one CL
        self.assertEqual(s["Rejected days"], 2.0)
        self.assertEqual(
            s["CL days used from balance"], 2.5
        )  # 0.5 + Carry Forward 1 + B's 1; the pre-cut-over CL is not
        self.assertEqual(s["Employees on approved leave"], 5)
        self.assertEqual(len(body["summary"]), 6)
        self.assertEqual(body["totals"]["days"], 15.0)  # A 6.5 leave + 4.5 CL, B, C, G and P 1 each
        section = body["sections"][0]
        self.assertEqual(section["title"], "By leave type")
        by_type = {r["leaveType"]: r for r in section["rows"]}
        self.assertEqual(by_type["Annual Leave"]["requests"], 6)
        self.assertEqual(by_type["Annual Leave"]["approvedDays"], 6.0)
        self.assertEqual(by_type["Annual Leave"]["pendingDays"], 2.0)
        self.assertEqual(by_type["Annual Leave"]["rejectedDays"], 1.0)
        self.assertEqual(by_type["Annual Leave"]["employees"], 4)
        self.assertEqual(by_type["Sick Leave"]["approvedDays"], 0.5)
        self.assertEqual(by_type["Casual Leave (CL)"]["requests"], 6)
        self.assertEqual(by_type["Casual Leave (CL)"]["approvedDays"], 3.5)
        self.assertEqual(section["rows"][-1]["leaveType"], "Casual Leave (CL)")

    def test_filters_narrow_the_rows(self):
        def n(**kw):
            return len(self.data_rows(self.run_report("leave-report", **{**MARCH, **kw})))

        self.assertEqual(n(status="pending"), 2)
        self.assertEqual(n(status="rejected"), 2)
        self.assertEqual(n(kind="casual"), 6)
        self.assertEqual(n(kind="leave"), 7)
        self.assertEqual(n(employeeStatus="active"), 12)  # Gopal has left
        self.assertEqual(n(employeeStatus="inactive"), 1)
        self.assertEqual(n(employmentType="production"), 1)
        self.assertEqual(n(departmentIds=str(self.sewing.id)), 1)
        self.assertEqual(n(employeeIds=str(self.b.id)), 1)
        self.assertEqual(n(dateFrom="2026-03-20", dateTo="2026-03-20"), 1)  # the Fri-Sat leave overlaps
        self.assertEqual(self.get("/api/reports/run/leave-report", status="nope").status_code, 400)

    def test_a_birthday_casual_leave_uses_no_balance(self):
        CompensationConfig.get()
        with mock.patch("api.cl_balance.new_rule_birthdays", return_value={(self.b.id, date(2026, 3, 23))}) as m:
            body = self.run_report("leave-report", **MARCH)
        m.assert_called_once()
        b = self.rows_of(body, "RC_B")[0]
        self.assertEqual(b["clBalance"], "Not used (birthday leave)")
        self.assertEqual(b["payEffect"], "Paid birthday leave")
        self.assertEqual(self.summary(body)["CL days used from balance"], 1.5)

    def test_the_birthday_check_never_writes_the_compensation_settings_row(self):
        CompensationConfig.objects.all().delete()
        self.run_report("leave-report", **MARCH)  # B's Casual Leave falls on her birthday
        self.assertFalse(CompensationConfig.objects.exists())

    def test_module_gates_inside_the_report(self):
        leave_only = self.hr("rc_leave_only", {"reports": "view", "leave": "view"})
        body = self.run_report("leave-report", leave_only, **MARCH)
        self.assertEqual({r["kind"] for r in self.data_rows(body)}, {"Leave"})
        self.assertTrue(any("Casual Leave is not included" in n for n in body["notes"]))
        cl_only = self.hr("rc_cl_only", {"reports": "view", "casual_leave": "view"})
        body = self.run_report("leave-report", cl_only, **MARCH)
        self.assertEqual({r["kind"] for r in self.data_rows(body)}, {"Casual Leave"})
        self.assertEqual(len(self.data_rows(body)), 6)

    def test_branch_isolation(self):
        body = self.run_report("leave-report", self.b1_user, **MARCH)
        self.assertNotIn("RC_C", self.codes(body))
        self.assertEqual(
            self.data_rows(self.run_report("leave-report", self.b1_user, **MARCH, employeeIds=str(self.c.id))), []
        )
        xl = self.export("leave-report", "xlsx", self.b1_user, **MARCH)
        cells = [
            c.value for ws in load_workbook(io.BytesIO(xl.content)).worksheets for row in ws.iter_rows() for c in row
        ]
        self.assertNotIn("RC_C", cells)

    def test_exports_carry_the_by_type_sheet(self):
        x = self.export("leave-report", "xlsx", **MARCH)
        self.assertEqual(x.status_code, 200)
        wb = load_workbook(io.BytesIO(x.content))
        self.assertIn("By leave type", wb.sheetnames)
        p = self.export("leave-report", "pdf", **MARCH)
        self.assertEqual(p.status_code, 200)
        self.assertTrue(p.content.startswith(b"%PDF"))
        empty = dict(MARCH, employeeIds=NO_ONE)
        self.assertEqual(self.data_rows(self.run_report("leave-report", **empty)), [])
        self.assertEqual(self.export("leave-report", "pdf", **empty).status_code, 200)

    def test_query_count_does_not_grow_with_the_rows(self):
        def count():
            with CaptureQueriesContext(connection) as ctx:
                body = self.run_report("leave-report", **MARCH)
            return len(ctx), len(self.data_rows(body))

        small, n_small = count()
        for i in range(15):
            e = self.mk(f"RC_M{i:02d}", f"Many{i}", self.cutting, self.b1)
            self.lr(e, self.al, "2026-03-10", "2026-03-11", 2, "approved")
            self.cl(e, date(2026, 3, 19), "approved")
        big, n_big = count()
        self.assertGreater(n_big, n_small)
        self.assertLessEqual(big, small + 1, f"{small} -> {big}")
        self.assertLessEqual(big, 25)


# ════════════════════════════════════════════════════════════════════════════
#  Individual Employee Overall Leave Report
# ════════════════════════════════════════════════════════════════════════════


class OverallLeaveTests(_Base):
    def run_for(self, emp, user=None, **kw):
        return self.run_report("employee-overall-leave", user, employeeIds=str(emp.id), year="2026", **kw)

    def item(self, body, name):
        return next(r for r in self.data_rows(body) if r["item"] == name and r["status"] is None)

    def test_without_an_employee_it_asks_for_one_and_two_employees_are_refused(self):
        body = self.run_report("employee-overall-leave")
        self.assertEqual(body["rows"], [])
        self.assertIn("Choose an employee", body["notes"][0])
        r = self.get("/api/reports/run/employee-overall-leave", employeeIds=f"{self.a.id},{self.b.id}")
        self.assertEqual(r.status_code, 400)
        self.assertEqual(r.json().get("field"), "employeeIds")

    def test_summary_part_per_leave_type_cl_balance_permissions_on_duty_missing_punch_and_absent_days(self):
        body = self.run_for(self.a)
        self.assertEqual(body["rows"][0]["_kind"], "subtotal")
        self.assertIn("RC_A", body["rows"][0]["item"])
        al = self.item(body, "Annual Leave (AL)")
        self.assertEqual((al["taken"], al["pending"], al["rejected"]), (3.0, 2.0, 1.0))
        sl = self.item(body, "Sick Leave (SL)")
        self.assertEqual(sl["taken"], 0.5)
        self.assertIn("1 half day", sl["details"])
        cl = self.item(body, "Casual Leave (CL)")
        # approved 1 (before cut-over) + 0.5 + 1 (Carry Forward); pending 1 + 0.5 (HR proposal); rejected 1
        self.assertEqual((cl["taken"], cl["pending"], cl["rejected"]), (2.5, 1.5, 1.0))
        # balance: used 0.5 + 1 (Carry Forward counts whatever its date), pending 1.5 -> 12 - 3 = 9
        self.assertEqual(cl["balance"], 9.0)
        self.assertIn("used 1.5, pending 1.5, left 9", cl["details"])
        self.assertIn("1 given by HR on the Carry Forward tab", cl["details"])
        self.assertIn("1 before the cut-over", cl["details"])
        perm = self.item(body, "Permissions (requests)")
        self.assertEqual((perm["taken"], perm["pending"], perm["rejected"]), (4, 1, 1))
        self.assertIn("1 beyond the monthly cap", perm["details"])
        od = self.item(body, "On-duty days")
        self.assertEqual((od["taken"], od["pending"], od["rejected"]), (1, 1, 1))
        mp = self.item(body, "Missing punch requests")
        self.assertEqual((mp["taken"], mp["pending"], mp["rejected"]), (1, 1, 0))
        self.assertEqual(self.item(body, "Absent days")["taken"], 2)
        self.assertEqual(self.item(body, "On leave days (attendance)")["taken"], 1)
        self.assertEqual(self.item(body, "Half days (attendance)")["taken"], 1)
        s = self.summary(body)
        self.assertEqual(s["Employee"], "RC_A Asha Kumar")
        self.assertEqual(s["Leave days taken"], 6.0)
        self.assertEqual(s["Pending days"], 3.5)
        self.assertEqual(s["Casual Leave left"], 9.0)
        self.assertEqual(s["On-duty days"], 1)
        self.assertEqual(s["Absent days"], 2)

    def test_the_balance_matches_cl_balance(self):
        from . import cl_balance

        body = self.run_for(self.a)
        want = cl_balance.balance(self.a, 2026)
        self.assertEqual(self.item(body, "Casual Leave (CL)")["balance"], float(want["remaining"]))

    def test_every_request_part_lists_each_request_in_date_order(self):
        body = self.run_for(self.a)
        rows = body["rows"]
        split = next(i for i, r in enumerate(rows) if i > 0 and r.get("_kind") == "subtotal")
        self.assertEqual(rows[split]["item"], "Every request in date order (21)")
        requests = rows[split + 1 :]
        self.assertEqual(len(requests), 21)  # 4 leave + 5 CL + 1 HR proposal + 6 permissions + 3 on-duty + 2 missing
        dates = [r["fromDate"] for r in requests]
        self.assertEqual(dates, sorted(dates))
        kinds = {r["kind"] for r in requests}
        self.assertEqual(kinds, {"Leave", "Casual Leave", "Permission", "On-duty", "Missing punch"})
        proposal = next(r for r in requests if r["item"] == "Casual Leave (CL) proposed by HR")
        self.assertEqual((proposal["fromDate"], proposal["days"], proposal["status"]), ("2026-03-26", 0.5, "Pending"))
        excess = [r for r in requests if r["kind"] == "Permission" and "beyond the monthly cap" in r["details"]]
        self.assertEqual([r["fromDate"] for r in excess], ["2026-03-05"])

    def test_production_join_date_text_does_not_hide_absences_and_sundays_are_off(self):
        body = self.run_for(self.p)
        self.assertEqual(self.item(body, "Absent days")["taken"], 1)
        self.assertNotIn("Casual Leave", {r["kind"] for r in self.data_rows(body)})

    def test_branch_isolation_and_department_filter(self):
        body = self.run_for(self.c, self.b1_user)
        self.assertEqual(body["rows"], [])
        self.assertIn("No employee matches", body["notes"][0])
        body = self.run_for(self.a, departmentIds=str(self.sewing.id))
        self.assertEqual(body["rows"], [])

    def test_module_gates_inside_the_report(self):
        user = self.hr("rc_ov_leave", {"reports": "view", "leave": "view"})
        body = self.run_for(self.a, user)
        kinds = {r["kind"] for r in self.data_rows(body)}
        self.assertEqual(kinds, {"Leave", "Permission"})
        self.assertTrue(any("Casual Leave is not included" in n for n in body["notes"]))
        self.assertIsNone(self.summary(body)["Absent days"])

    def test_exports_and_query_budget(self):
        with CaptureQueriesContext(connection) as ctx:
            self.run_for(self.a)
        self.assertLessEqual(len(ctx), 25)
        q = {"employeeIds": str(self.a.id), "year": "2026"}
        x = self.export("employee-overall-leave", "xlsx", **q)
        self.assertEqual(x.status_code, 200)
        ws = load_workbook(io.BytesIO(x.content)).active
        self.assertIn("Every request in date order (21)", [c.value for row in ws.iter_rows() for c in row])
        p = self.export("employee-overall-leave", "pdf", **q)
        self.assertEqual(p.status_code, 200)
        self.assertTrue(p.content.startswith(b"%PDF"))


# ════════════════════════════════════════════════════════════════════════════
#  Geo Attendance Report
# ════════════════════════════════════════════════════════════════════════════


class GeoAttendanceTests(_Base):
    def test_office_geo_punches_and_on_duty_punches_with_location(self):
        body = self.run_report("geo-attendance", **MARCH)
        rows = self.data_rows(body)
        self.assertEqual(len(rows), 7)  # 3 office geo punches + 4 on-duty punches; the on_duty:approved copy is not one
        self.assertEqual([r["punchDate"] for r in rows], sorted(r["punchDate"] for r in rows))
        office = [r for r in rows if r["source"] == "Office geo punch"]
        self.assertEqual(sorted(r["employeeCode"] for r in office), ["RC_A", "RC_B", "RC_C"])
        for r in office:
            self.assertIsNone(r["location"])
            self.assertEqual((r["fence"], r["gps"], r["verification"]), ("Inside", "Genuine", "Accepted"))
        a1030 = [r for r in rows if r["employeeCode"] == "RC_A" and r["punchTime"] == "10:30"]
        self.assertEqual(len(a1030), 1)
        v1 = a1030[0]
        self.assertEqual(v1["source"], "On-duty punch")
        self.assertEqual(v1["location"], "11.131490, 77.318915")
        want = round(haversine_distance_m(float(NEAR[0]), float(NEAR[1]), *SITE))
        self.assertEqual(v1["distanceM"], want)
        self.assertLess(want, 80)
        self.assertEqual((v1["fence"], v1["gps"], v1["verification"]), ("Inside", "Genuine", "Approved"))
        self.assertEqual(v1["accuracyM"], 21.5)
        self.assertEqual(v1["destination"], "Client site")
        v2 = next(r for r in rows if r["employeeCode"] == "RC_A" and r["punchTime"] == "13:00")
        self.assertEqual((v2["fence"], v2["gps"], v2["verification"]), ("Outside", "Mocked", "Pending"))
        self.assertGreater(v2["distanceM"], 10_000)
        v3 = next(r for r in rows if r["punchDate"] == "2026-03-17")
        self.assertEqual(v3["verification"], "Voided")
        v4 = next(r for r in rows if r["employeeCode"] == "RC_C" and r["source"] == "On-duty punch")
        self.assertEqual(v4["fence"], "No site location")
        self.assertIsNone(v4["distanceM"])
        s = self.summary(body)
        self.assertEqual((s["Geo punches"], s["Office geo punches"], s["On-duty punches"]), (7, 3, 4))
        self.assertEqual((s["Waiting for HR"], s["Rejected or voided"], s["Mock GPS"]), (1, 1, 1))

    def test_filters(self):
        def times(**kw):
            return sorted(
                (r["employeeCode"], r["punchTime"])
                for r in self.data_rows(self.run_report("geo-attendance", **MARCH, **kw))
            )

        self.assertEqual(len(times(source="office")), 3)
        self.assertEqual(len(times(source="on_duty")), 4)
        self.assertEqual(times(check="outside"), [("RC_A", "13:00")])
        self.assertEqual(times(check="mocked"), [("RC_A", "13:00")])
        self.assertEqual(times(check="voided"), [("RC_A", "09:30")])
        self.assertEqual(times(check="rejected"), [])
        self.assertEqual(times(check="pending"), [("RC_A", "13:00")])
        self.assertEqual(times(check="approved"), [("RC_A", "10:30"), ("RC_C", "11:00")])
        self.assertEqual(len(times(check="accepted")), 3)
        self.assertEqual(times(source="office", check="pending"), [])
        self.assertEqual(times(employeeIds=str(self.b.id)), [("RC_B", "09:10")])
        self.assertEqual(len(times(employeeStatus="inactive")), 0)

    def test_branch_isolation_and_exports(self):
        body = self.run_report("geo-attendance", self.b1_user, **MARCH)
        self.assertNotIn("RC_C", self.codes(body))
        self.assertEqual(len(self.data_rows(body)), 5)
        for fmt, magic in (("xlsx", b"PK"), ("pdf", b"%PDF")):
            r = self.export("geo-attendance", fmt, **MARCH)
            self.assertEqual(r.status_code, 200)
            self.assertTrue(r.content.startswith(magic))

    def test_row_limit_cuts_and_says_so(self):
        with mock.patch("api.reporting.runner.SCREEN_ROW_LIMIT", 2):
            body = self.run_report("geo-attendance", **MARCH)
        self.assertEqual(body["rowCount"], 2)
        self.assertTrue(body["truncated"])
        self.assertEqual(self.summary(body)["Geo punches"], 2)

    def test_query_count_does_not_grow(self):
        def count():
            with CaptureQueriesContext(connection) as ctx:
                body = self.run_report("geo-attendance", **MARCH)
            return len(ctx), len(self.data_rows(body))

        small, n_small = count()
        for i in range(12):
            e = self.mk(f"RC_G{i:02d}", f"Geo{i}", self.cutting, self.b1)
            AttendanceLog.objects.create(employee=e, date=date(2026, 3, 3), punch_time=time(9, i), source="geo:auto")
            s = self.session(e, date(2026, 3, 4), "completed")
            self.verify(s, date(2026, 3, 4), time(10, i), 1, "approved")
        big, n_big = count()
        self.assertEqual(n_big, n_small + 24)
        self.assertLessEqual(big, small)


# ════════════════════════════════════════════════════════════════════════════
#  On-Duty Report and On-Duty with Punch Details
# ════════════════════════════════════════════════════════════════════════════


class OnDutyTests(_Base):
    def engine(self, rid, **params):
        request = RequestFactory().get("/")
        request.jwt_user = {"hrUserId": self.admin.id}
        q = QueryDict(mutable=True)
        q.update(params)
        return engine_run(request, registry.get_spec(rid), q)

    def test_on_duty_report_shows_the_same_rows_as_the_retired_register(self):
        mine = self.engine("on-duty-report", **MARCH)
        base = self.engine("on-duty-register", **MARCH)
        self.assertEqual([c.key for c in mine.columns], [c.key for c in base.columns])
        self.assertEqual(mine.rows, base.rows)
        self.assertEqual(len(mine.rows), 6)
        s = {x["label"]: x["value"] for x in mine.summary}
        self.assertEqual(s["On-duty requests"], 6)
        self.assertEqual((s["Pending decision"], s["Approved by HR"], s["Rejected"]), (1, 4, 1))
        self.assertEqual(s["Punches captured"], 4)
        filt = self.engine("on-duty-report", status="rejected", **MARCH)
        self.assertEqual([r["employeeCode"] for r in filt.rows], ["RC_A"])
        mocked = next(r for r in mine.rows if r["requestedAt"].startswith("2026-03-11"))
        self.assertEqual(mocked["mockedPunches"], 1)

    def test_on_duty_report_filters_isolation_and_exports(self):
        spec = next(r for r in self.get("/api/reports/catalog").json()["reports"] if r["id"] == "on-duty-report")
        self.assertEqual(
            [f["key"] for f in spec["filters"]],
            [
                "dateRange",
                "branch",
                "department",
                "designation",
                "employmentType",
                "employee",
                "employeeStatus",
                "status",
            ],
        )
        body = self.run_report("on-duty-report", self.b1_user, **MARCH)
        self.assertNotIn("RC_C", self.codes(body))
        for fmt, magic in (("xlsx", b"PK"), ("pdf", b"%PDF")):
            r = self.export("on-duty-report", fmt, **MARCH)
            self.assertEqual(r.status_code, 200)
            self.assertTrue(r.content.startswith(magic))

    def test_punch_details_lists_every_punch_of_the_day_and_the_verification(self):
        body = self.run_report("on-duty-punch-details", **MARCH)
        rows = {(r["employeeCode"], r["dutyDate"]): r for r in self.data_rows(body)}
        self.assertEqual(len(rows), 6)
        a = rows[("RC_A", "2026-03-11")]
        self.assertEqual(
            a["punches"],
            "09:01 Biometric; 10:30 On-duty IN (approved); 13:00 On-duty OUT (pending, mock GPS); 18:05 Geo Punch",
        )
        self.assertEqual((a["approved"], a["pending"], a["rejected"], a["mocked"]), (1, 1, 0, 1))
        self.assertEqual(a["outcome"], "Waiting for HR")
        self.assertEqual((a["dayStatus"], a["shifts"]), ("Present", 0.75))  # the stored quarter day
        self.assertEqual(a["journeyKm"], 12.35)
        self.assertEqual(a["request"], "Completed")
        voided = rows[("RC_A", "2026-03-17")]
        self.assertEqual((voided["outcome"], voided["rejected"], voided["request"]), ("Voided", 1, "Rejected"))
        self.assertEqual(voided["punches"], "09:30 On-duty IN (voided)")
        pending = rows[("RC_A", "2026-03-19")]
        self.assertEqual(
            (pending["outcome"], pending["punches"], pending["dayStatus"]), ("No on-duty punches", None, None)
        )
        night = rows[("RC_P", "2026-03-14")]
        self.assertEqual(night["punches"], "20:00 Biometric")  # the 06:00 punch is on the next calendar date
        self.assertEqual((night["dayStatus"], night["shifts"]), ("Present", 1.25))  # stored shift-day credit
        stale = rows[("RC_P", "2026-03-21")]
        self.assertEqual((stale["dayStatus"], stale["shifts"]), ("Present (out of date)", 2.72))
        self.assertTrue(any("off the quarter grid" in n for n in body["notes"]))
        s = self.summary(body)
        self.assertEqual(
            (s["On-duty days"], s["On-duty punches"], s["Approved"], s["Waiting for HR"], s["Rejected or voided"]),
            (6, 4, 2, 1, 1),
        )
        self.assertEqual(s["Journey tracked (km)"], 12.35)
        self.assertAlmostEqual(
            body["totals"]["shifts"], 4.72, places=2
        )  # 0.75 + 1.25 + 2.72; days with no record are blank

    def test_punch_details_filters_isolation_exports_and_queries(self):
        def codes(user=None, **kw):
            return sorted(self.codes(self.run_report("on-duty-punch-details", user, **MARCH, **kw)))

        self.assertEqual(codes(status="pending_hod"), ["RC_A"])
        self.assertEqual(codes(employmentType="production"), ["RC_P", "RC_P"])
        self.assertNotIn("RC_C", codes(self.b1_user))
        for fmt, magic in (("xlsx", b"PK"), ("pdf", b"%PDF")):
            r = self.export("on-duty-punch-details", fmt, **MARCH)
            self.assertEqual(r.status_code, 200)
            self.assertTrue(r.content.startswith(magic))

        def count():
            with CaptureQueriesContext(connection) as ctx:
                body = self.run_report("on-duty-punch-details", **MARCH)
            return len(ctx), len(self.data_rows(body))

        small, n_small = count()
        for i in range(12):
            e = self.mk(f"RC_D{i:02d}", f"Duty{i}", self.cutting, self.b1)
            s = self.session(e, date(2026, 3, 5), "completed")
            self.verify(s, date(2026, 3, 5), time(10, i), 1, "approved")
            AttendanceLog.objects.create(
                employee=e, date=date(2026, 3, 5), punch_time=time(9, i), source="biometric:HO"
            )
            AttendanceDayRecord.objects.create(employee=e, date=date(2026, 3, 5), status="present", shifts_earned=1)
            DutyTrack.objects.create(session=s, employee=e, distance_m=1000.0)
        big, n_big = count()
        self.assertEqual(n_big, n_small + 12)
        self.assertLessEqual(big, small)
        self.assertLessEqual(big, 25)

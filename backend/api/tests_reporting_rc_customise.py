"""
Report Center -> Customise: the report builder's backend (api/reporting/custom/, model SavedCustomReport).

The data sources (employees / attendance_days / punches / requests / payroll) per permission, the preview, saving /
changing / copying / deleting reports (view vs edit, creator vs super admin), field-level access (field_forbidden, a saved
report opened by a role that cannot see one of its fields), a saved report run and exported through the ordinary
/api/reports/run|export/custom-<id> endpoints, the catalog entry with the saved filter values as defaults, branch
isolation, the query budget, and the owner's example end to end: the "Monthly Employee Performance Report" (code, name,
department, present days, late count, OT hours, leave taken, net salary).

The seed has a staff member with every kind of day (late, a quarter day, a half day, absent, leave, Casual Leave, a
penalty early out, overtime), production workers judged by the shift table (a 1.50-shift day, a quarter day and a night
shift closed the next morning) whose join date is stored as a spreadsheet serial ('01-01-45640'), payrolls of both kinds
(one parked new joiner), requests of the five kinds, and a second unit.

"Today" is pinned to 2026-09-29; the shift table judges every day from 2026-09-01.

Run via: python manage.py test api.tests_reporting_rc_customise -v 2
"""

import importlib
import io
from datetime import date, datetime, time, timedelta
from decimal import Decimal
from unittest.mock import patch

from django.apps import apps as django_apps
from django.db import connection
from django.test import TestCase
from django.test.utils import CaptureQueriesContext
from openpyxl import load_workbook
from rest_framework.request import Request
from rest_framework.test import APIRequestFactory

from .attendance_final import compute_day_record
from .clock import FACTORY_TZ
from .jwt_utils import sign_token
from .models import (
    AttendanceDayRecord,
    AttendanceLog,
    AuditLog,
    Branch,
    CasualLeaveRequest,
    Department,
    Designation,
    Employee,
    EmployeePermission,
    EmployeeShiftAssignment,
    Holiday,
    HRUser,
    LeaveRequest,
    LeaveType,
    MissingPunchRequest,
    OnDutySession,
    Payroll,
    ProductionBreak,
    ProductionShiftConfig,
    ProductionShiftGroup,
    Role,
    SavedCustomReport,
    ShiftTemplate,
)
from .permission_registry import resolve_module
from .reporting.custom.datasets import DATASETS
from .reporting.custom.specs import spec_for_saved
from .reporting.export_xlsx import HEADER_ROW
from .reporting.runner import run_report

TODAY = date(2026, 9, 29)
EFFECTIVE = date(2026, 9, 1)
PERIOD = "2026-09"
MON = date(2026, 9, 21)
TUE, WED = MON + timedelta(days=1), MON + timedelta(days=2)
HOLIDAY = date(2026, 9, 15)
PERFORMANCE = [
    "emp.code", "emp.name", "emp.department", "att.present_days", "att.late_count", "att.ot_hours",
    "att.leave_days", "pay.net",
]  # fmt: skip
BASE = "/api/reports/custom"


def hdr(user: HRUser) -> dict:
    return {"HTTP_AUTHORIZATION": f"Bearer {sign_token({'role': 'hr', 'hrUserId': user.id})}"}


def _ensure_production_seed():
    """The migration seeds the production shift groups and breaks; a TransactionTestCase elsewhere may have flushed them."""
    if not ProductionShiftGroup.objects.filter(is_special=False).exists() or not ProductionBreak.objects.exists():
        ProductionShiftGroup.objects.all().delete()
        ProductionBreak.objects.all().delete()
        importlib.import_module("api.migrations.0121_production_shift_rules").seed(django_apps, None)


def _log(emp, day, *times, source="biometric:dev1"):
    for hh, mm, ss in times:
        AttendanceLog.objects.create(
            employee=emp, date=day, punch_time=time(hh, mm, ss), punch_type="IN", source=source
        )


class _World(TestCase):
    @classmethod
    def setUpTestData(cls):
        _ensure_production_seed()
        # these tests follow the 12-days-a-year policy (Settings -> Casual Leave, allocation yearly)
        from .models import CasualLeavePolicy

        CasualLeavePolicy.objects.update_or_create(pk=1, defaults={"allocation": "yearly"})
        config = ProductionShiftConfig.get()
        config.rules_effective_from = EFFECTIVE
        config.save()
        cls.b1 = Branch.objects.create(name="Unit 1", code="U1")
        cls.b2 = Branch.objects.create(name="Unit 2", code="U2")
        cls.accounts = Department.objects.create(name="ACCOUNTS", branch=cls.b1)
        cls.stitching = Department.objects.create(name="STITCHING", branch=cls.b1)
        cls.cutting = Department.objects.create(name="CUTTING", branch=cls.b2)
        cls.des = Designation.objects.create(title="Executive", department=cls.accounts, level="junior")
        Holiday.objects.create(name="Founders Day", date=HOLIDAY)

        def staff(code, dept, branch, **kw):
            return Employee.objects.create(
                employee_code=code,
                first_name=code,
                last_name="Staff",
                employment_type="staff",
                department=dept,
                branch=branch,
                designation=cls.des,
                status=kw.pop("status", "active"),
                salary_type="monthly",
                salary_amount=Decimal(kw.pop("salary", "26000")),
                join_date=kw.pop("join_date", "2024-01-10"),
                **kw,
            )

        def production(code, join_date):
            return Employee.objects.create(
                employee_code=code,
                first_name=code,
                last_name="Worker",
                employment_type="production",
                department=cls.stitching,
                branch=cls.b1,
                status="active",
                salary_per_shift=Decimal("500"),
                production_pay_cycle="weekly",
                join_date=join_date,
            )

        cls.s1 = staff(
            "C100", cls.accounts, cls.b1, bank_name="State Bank", bank_account="123456789012", phone="9000000001",
            address="12 Mill Road",
        )  # fmt: skip
        cls.s2 = staff("C200", cls.cutting, cls.b2)
        cls.gone = staff("C900", cls.accounts, cls.b1, status="inactive")
        cls.p1 = production("P100", "01-01-45640")  # a spreadsheet serial: 2024-12-14
        cls.n1 = production("P200", "2025-01-01")

        # S1: a 09:00-18:00 shift; one day of every kind
        shift = ShiftTemplate.objects.create(name="General", start_time=time(9, 0), end_time=time(18, 0))
        EmployeeShiftAssignment.objects.create(employee=cls.s1, shift=shift, effective_from=date(2026, 1, 1))

        def day(d, status="present", shifts="1.00", **kw):
            return AttendanceDayRecord.objects.create(
                employee=cls.s1,
                date=d,
                status=status,
                shifts_earned=Decimal(shifts),
                is_half_shift=status == "half_shift",
                source=kw.pop("source", "auto"),
                **kw,
            )

        day(date(2026, 9, 1), first_punch=time(9, 0), last_punch=time(18, 0), arrival_zone="on_time", total_punches=4)
        day(date(2026, 9, 2), is_late=True, first_punch=time(9, 20), last_punch=time(18, 0), arrival_zone="late")
        day(date(2026, 9, 3), shifts="0.75", is_late=True, first_punch=time(10, 0), arrival_zone="quarter")
        day(date(2026, 9, 4), status="half_shift", shifts="0.50", first_punch=time(9, 0), last_punch=time(13, 0))
        day(date(2026, 9, 5), status="absent", shifts="0.00")
        day(date(2026, 9, 7), status="on_leave", shifts="0.00")
        day(date(2026, 9, 8), source="manual", override_note="Casual Leave (paid)")
        day(
            date(2026, 9, 9), shifts="0.75", penalty_early_out=True, penalty_deduction=Decimal("0.25"),
            early_out_minutes=90, first_punch=time(9, 0), last_punch=time(16, 30),
        )  # fmt: skip
        day(date(2026, 9, 10), first_punch=time(9, 0), last_punch=time(20, 0), ot_extra_minutes=120)
        _log(cls.s1, date(2026, 9, 1), (9, 0, 0), (13, 0, 0), (14, 0, 0), (18, 0, 0))
        CasualLeaveRequest.objects.create(employee=cls.s1, date=date(2026, 9, 8), status="approved", reviewed_by="HR")
        CasualLeaveRequest.objects.create(
            employee=cls.s1, date=date(2026, 9, 11), portion="first_half", status="pending"
        )
        sick, _ = LeaveType.objects.get_or_create(code="SL", defaults={"name": "Sick Leave"})
        cls.sick_name = sick.name
        LeaveRequest.objects.create(
            employee=cls.s1, leave_type_ref=sick, start_date="2026-09-07", end_date="2026-09-07", total_days=1,
            status="approved", approved_by="Priya", approver_role="hr", reason="Fever",
        )  # fmt: skip
        EmployeePermission.objects.create(
            employee=cls.s1, date=date(2026, 9, 16), type="morning_late_in", status="approved", approved_by="HR"
        )
        MissingPunchRequest.objects.create(
            employee=cls.s1, date=date(2026, 9, 17), punch_time=time(18, 0), punch_type="OUT", reason="Forgot",
            status="pending_hr",
        )  # fmt: skip
        duty = OnDutySession.objects.create(
            employee=cls.s1, destination="Client visit", status="completed", hr_reviewed_by="Priya"
        )
        # raised on the 18th at 10:00 IST (created_at is set on save)
        OnDutySession.objects.filter(pk=duty.pk).update(
            created_at=datetime(2026, 9, 18, 10, 0, tzinfo=FACTORY_TZ),
            hr_reviewed_at=datetime(2026, 9, 18, 11, 0, tzinfo=FACTORY_TZ),
        )
        AttendanceDayRecord.objects.create(employee=cls.s2, date=date(2026, 9, 1), status="present", shifts_earned=1)

        # Production, judged by the shift table: P100 a 1.50-shift Monday and a quarter Wednesday; P200 two nights, each
        # closed by the next morning's punch
        _log(cls.p1, MON, (8, 29, 40), (12, 45, 0), (13, 30, 0), (20, 0, 3))
        _log(cls.p1, WED, (8, 30, 0), (12, 45, 0), (13, 30, 0), (15, 30, 0))
        _log(cls.n1, MON, (21, 0, 5))
        _log(cls.n1, TUE, (5, 30, 10), (21, 0, 8))
        _log(cls.n1, WED, (5, 31, 0))
        for emp in (cls.p1, cls.n1):
            for d in (MON, TUE, WED):
                compute_day_record(emp, d)

        # Payroll: S1's September (net 23,000.40 -> 23,001 as printed), S2 in the other unit, P100's week ending in
        # September, and P200 parked in New Joiners (not added yet)
        Payroll.objects.create(
            employee=cls.s1, salary_mode="monthly", month=9, year=2026, total_working_days=26,
            present_days=Decimal("23.0"), base_salary=Decimal("26000"), gross_salary=Decimal("24000"),
            ot_amount=Decimal("500"), deductions=Decimal("1499.60"), final_salary=Decimal("23000.40"),
            payment_status="paid",
        )  # fmt: skip
        Payroll.objects.create(
            employee=cls.s2, salary_mode="monthly", month=9, year=2026, total_working_days=26,
            present_days=Decimal("26.0"), base_salary=Decimal("20000"), gross_salary=Decimal("20000"),
            final_salary=Decimal("20000"),
        )  # fmt: skip
        week = {"period_start": date(2026, 9, 14), "period_end": date(2026, 9, 20), "pay_cycle": "weekly"}
        Payroll.objects.create(
            employee=cls.p1, salary_mode="shift", month=9, year=2026, total_working_days=7, present_days=Decimal("6.0"),
            base_salary=Decimal("0"), gross_salary=Decimal("3000"), final_salary=Decimal("3000"), **week,
        )  # fmt: skip
        Payroll.objects.create(
            employee=cls.n1, salary_mode="shift", month=9, year=2026, total_working_days=7, present_days=Decimal("2.0"),
            base_salary=Decimal("0"), gross_salary=Decimal("1000"), final_salary=Decimal("1000"),
            new_joiner_parked=True, **week,
        )  # fmt: skip

        every = {
            "attendance": "view", "employees": "view", "payroll": "view", "production_payroll": "view", "salary": "view",
            "leave": "view", "casual_leave": "view", "requests": "view", "geo_attendance": "view", "missing_punch": "view",
        }  # fmt: skip

        def user(name, perms, **kw):
            role = Role.objects.create(name=name, permissions=perms)
            return HRUser.objects.create(username=name, password_hash="x", full_name=name.title(), role=role, **kw)

        cls.admin = HRUser.objects.create(
            username="hr_admin", password_hash="x", full_name="Admin", is_super_admin=True
        )
        cls.editor = user("editor", {"reports": "edit", **every})
        cls.editor2 = user("editor2", {"reports": "edit", **every})
        cls.viewer = user("viewer", {"reports": "view", **every})
        cls.att_only = user("att_only", {"reports": "edit", "attendance": "view"})
        cls.prod_pay = user("prod_pay", {"reports": "view", "production_payroll": "view"})
        cls.leave_only = user("leave_only", {"reports": "view", "leave": "view"})
        cls.no_custom = user("no_custom", {"reports": "view", "reports.customise": "hidden", **every})
        cls.branch_editor = user("branch_editor", {"reports": "edit", **every}, branch=cls.b1)
        cls.md = HRUser.objects.create(username="md", password_hash="x", full_name="MD", is_md=True)

    def setUp(self):
        for target in (
            "api.reporting.filters.ist_today",
            "api.reporting.views.ist_today",
            "api.reporting.custom.views.ist_today",
        ):
            p = patch(target, return_value=TODAY)
            p.start()
            self.addCleanup(p.stop)

    # ── helpers ──────────────────────────────────────────────────────────────
    def get(self, path, user=None, expect=200, **params):
        r = self.client.get(path, params, **hdr(user or self.admin))
        self.assertEqual(r.status_code, expect, r.content[:500])
        return r

    def send(self, method, path, body=None, user=None, expect=200):
        call = getattr(self.client, method)
        r = call(path, body or {}, content_type="application/json", **hdr(user or self.editor))
        self.assertEqual(r.status_code, expect, r.content[:500])
        return r.json() if r.content and r.status_code != 204 else None

    def preview(self, dataset, fields, user=None, expect=200, **params):
        return self.get(f"{BASE}/preview", user, expect, dataset=dataset, fields=",".join(fields), **params).json()

    def save(self, name="Report", dataset="employees", fields=None, filters=None, sort=None, user=None, expect=201):
        body = {
            "name": name,
            "description": "test",
            "dataset": dataset,
            "fields": fields if fields is not None else ["emp.code", "emp.name"],
            "filters": filters if filters is not None else {"period": PERIOD},
            "sort": sort or [],
        }
        return self.send("post", f"{BASE}/saved", body, user, expect)

    def open_report(self, report_id, user=None, expect=200, **params):
        return self.get(f"/api/reports/run/{report_id}", user, expect, **params).json()

    @staticmethod
    def by(body, key="emp.code") -> dict:
        return {r[key]: r for r in body["rows"] if not r.get("_kind")}


# ═════════════════════════════════════════════════════════════════════════════
#  Data sources per permission
# ═════════════════════════════════════════════════════════════════════════════


class DatasetTests(_World):
    def test_admin_gets_every_data_source_with_typed_fields_and_report_center_filters(self):
        body = self.get(f"{BASE}/datasets").json()
        self.assertTrue(body["canEdit"])
        ids = [d["id"] for d in body["datasets"]]
        self.assertEqual(ids, ["employees", "attendance_days", "punches", "requests", "payroll"])
        grains = {d["id"]: d["grain"] for d in body["datasets"]}
        self.assertEqual(
            grains,
            {
                "employees": "employee",
                "attendance_days": "day",
                "punches": "punch",
                "requests": "request",
                "payroll": "payroll",
            },
        )
        emp = body["datasets"][0]
        self.assertEqual(
            [s["id"] for s in emp["sections"]], ["personal", "employment", "salary", "attendance", "payroll"]
        )
        keys = {f["key"] for s in emp["sections"] for f in s["fields"]}
        self.assertTrue(set(PERFORMANCE) <= keys)
        field = next(f for s in emp["sections"] for f in s["fields"] if f["key"] == "pay.net")
        self.assertEqual((field["type"], field["section"]), ("currency", "payroll"))
        self.assertEqual(emp["filters"][0]["kind"], "period")
        self.assertEqual(emp["filters"][0]["default"], PERIOD)
        kinds = [f["kind"] for f in emp["filters"]]
        self.assertEqual(
            kinds, ["period", "branch", "department", "designation", "employmentType", "employee", "employeeStatus"]
        )
        self.assertTrue(set(emp["defaultFields"]) <= keys)
        days = body["datasets"][1]
        rng = days["filters"][0]
        self.assertEqual((rng["kind"], rng["maxDays"]), ("dateRange", 62))
        self.assertEqual(rng["default"], {"dateFrom": "2026-09-01", "dateTo": "2026-09-29"})

    def test_fields_and_sources_follow_the_role(self):
        body = self.get(f"{BASE}/datasets", self.att_only).json()
        ids = [d["id"] for d in body["datasets"]]
        self.assertEqual(ids, ["employees", "attendance_days", "punches"])  # no payroll, no request kinds
        emp = body["datasets"][0]
        self.assertEqual([s["id"] for s in emp["sections"]], ["personal", "employment", "attendance"])
        keys = {f["key"] for s in emp["sections"] for f in s["fields"]}
        self.assertNotIn("emp.phone", keys)  # personal contact needs Employees
        self.assertIn("att.cl_days", keys)  # Casual Leave days are open to Attendance too
        self.assertNotIn("pay.net", emp["defaultFields"])
        prod = self.get(f"{BASE}/datasets", self.prod_pay).json()
        self.assertEqual([d["id"] for d in prod["datasets"]], ["employees", "payroll"])
        self.assertFalse(prod["canEdit"])
        branch = self.get(f"{BASE}/datasets", self.branch_editor).json()
        self.assertNotIn("branch", [f["kind"] for f in branch["datasets"][0]["filters"]])

    def test_no_customise_access_is_refused_everywhere(self):
        for path in ("datasets", "saved", "preview"):
            r = self.client.get(f"{BASE}/{path}", {"dataset": "employees", "fields": "emp.code"}, **hdr(self.no_custom))
            self.assertEqual(r.status_code, 403, path)

    def test_the_md_reads_but_never_changes(self):
        body = self.get(f"{BASE}/datasets", self.md).json()
        self.assertFalse(body["canEdit"])
        self.assertEqual(len(body["datasets"]), 5)
        self.save(user=self.md, expect=403)
        mine = self.save()
        self.send("delete", f"{BASE}/saved/{mine['id']}", user=self.md, expect=403)
        self.assertEqual(self.open_report(mine["reportId"], self.md)["title"], "Report")


# ═════════════════════════════════════════════════════════════════════════════
#  Preview
# ═════════════════════════════════════════════════════════════════════════════


class PreviewTests(_World):
    def test_preview_is_the_run_payload_with_the_chosen_columns_in_order(self):
        fields = ["emp.name", "emp.code", "att.present_days", "pay.net"]
        body = self.preview("employees", fields, period=PERIOD)
        self.assertEqual([c["key"] for c in body["columns"]], fields)
        self.assertEqual(body["id"], "custom-preview")
        self.assertEqual(body["category"], "customise")
        self.assertEqual(body["limit"], 200)
        for key in ("rows", "totals", "summary", "notes", "rowCount", "truncated", "filters"):
            self.assertIn(key, body)
        rows = self.by(body)
        self.assertEqual(set(rows), {"C100", "C200", "P100", "P200"})  # active only by default
        self.assertEqual(set(rows["C100"]), set(fields))  # nothing but the chosen fields leaves the server
        self.assertEqual(body["totals"]["pay.net"], 23001 + 20000 + 3000)

    def test_preview_caps_at_200_rows(self):
        AttendanceLog.objects.bulk_create(
            AttendanceLog(
                employee=self.s1, date=date(2026, 9, 1 + i // 20), punch_time=time(6, i % 20, 0), punch_type="IN"
            )
            for i in range(260)
        )
        body = self.preview(
            "punches", ["emp.code", "punch.date", "punch.time"], dateFrom="2026-09-01", dateTo="2026-09-30"
        )
        self.assertEqual(body["rowCount"], 200)
        self.assertTrue(body["truncated"])

    def test_preview_sorts(self):
        body = self.preview(
            "employees", ["emp.code", "att.shifts_earned"], period=PERIOD, sort="att.shifts_earned:desc"
        )
        values = [r["att.shifts_earned"] for r in body["rows"]]
        self.assertEqual(values, sorted(values, reverse=True))
        body = self.preview("employees", ["emp.code", "emp.name"], period=PERIOD, sort="emp.code:desc")
        self.assertEqual([r["emp.code"] for r in body["rows"]], ["P200", "P100", "C200", "C100"])

    def test_preview_refusals(self):
        def err(params, user=None, status=400):
            r = self.client.get(f"{BASE}/preview", params, **hdr(user or self.admin))
            self.assertEqual(r.status_code, status, r.content[:300])
            return r.json()

        self.assertEqual(err({"dataset": "nope", "fields": "emp.code"})["error"], "unknown_dataset")
        self.assertEqual(err({"dataset": "employees", "fields": ""})["error"], "invalid_field")
        self.assertEqual(err({"dataset": "employees", "fields": "emp.code,emp.code"})["error"], "invalid_field")
        self.assertEqual(err({"dataset": "employees", "fields": "day.date"})["error"], "invalid_field")
        forbidden = err({"dataset": "employees", "fields": "emp.code,pay.net"}, self.att_only)
        self.assertEqual((forbidden["error"], forbidden["field"]), ("field_forbidden", "fields"))
        self.assertEqual(
            err({"dataset": "employees", "fields": "emp.code", "sort": "emp.name:asc"})["error"], "invalid_sort"
        )
        self.assertEqual(
            err({"dataset": "employees", "fields": "emp.code", "sort": "emp.code:up"})["error"], "invalid_sort"
        )
        bad = err({"dataset": "employees", "fields": "emp.code", "period": "Sept"})
        self.assertEqual((bad["error"], bad["field"]), ("invalid_filter", "period"))
        wide = err(
            {"dataset": "attendance_days", "fields": "emp.code", "dateFrom": "2026-07-01", "dateTo": "2026-09-29"}
        )
        self.assertEqual(wide["field"], "dateTo")
        self.assertEqual(
            err({"dataset": "payroll", "fields": "emp.code"}, self.att_only, 403)["error"], "dataset_forbidden"
        )

    def test_every_data_source_runs_on_its_defaults(self):
        for ds in DATASETS.values():
            body = self.preview(ds.id, list(ds.default_fields))
            self.assertEqual([c["key"] for c in body["columns"]], list(ds.default_fields), ds.id)
            every = [f.key for f in ds.fields]
            body = self.preview(ds.id, every)
            self.assertEqual(len(body["columns"]), len(every), ds.id)


# ═════════════════════════════════════════════════════════════════════════════
#  The data sources' figures
# ═════════════════════════════════════════════════════════════════════════════


class EmployeesFiguresTests(_World):
    def test_staff_month_figures_follow_the_stored_days(self):
        fields = [
            "emp.code", "att.working_days", "att.present_days", "att.half_days", "att.absent_days", "att.leave_days",
            "att.cl_days", "att.cl_balance", "att.late_count", "att.late_minutes", "att.quarter_days", "att.penalty_days",
            "att.shifts_earned", "att.ot_hours", "att.attendance_pct", "att.permissions", "att.missing_punch",
            "att.on_duty_days", "att.worked_hours", "att.extra_shifts",
        ]  # fmt: skip
        row = self.by(self.preview("employees", fields, period=PERIOD))["C100"]
        # 29 days to "today" - 4 Sundays - the holiday on the 15th
        self.assertEqual(row["att.working_days"], 24)
        self.assertEqual(row["att.present_days"], 5)  # the Casual Leave day is not a present day
        self.assertEqual(row["att.half_days"], 1)
        self.assertEqual(row["att.absent_days"], 1)
        self.assertEqual(row["att.leave_days"], 1.0)
        self.assertEqual(row["att.cl_days"], 1.0)
        self.assertEqual(row["att.late_count"], 2)
        self.assertEqual(row["att.late_minutes"], 20 + 60)  # 09:20 and 10:00 against a 09:00 start
        self.assertEqual(row["att.quarter_days"], 1)
        self.assertEqual(row["att.penalty_days"], 1)
        self.assertEqual(row["att.shifts_earned"], 6.0)
        self.assertEqual(row["att.ot_hours"], 2.0)
        # Eff. % as the Staff Attendance Report: shifts earned on working days (the quarter and penalty days 0.75, the
        # half day 0.5, the Casual Leave day 1) over working days
        self.assertEqual(row["att.attendance_pct"], round(6.0 * 100 / 24, 1))
        self.assertEqual(row["att.permissions"], 1)
        self.assertEqual(row["att.missing_punch"], 1)
        self.assertEqual(row["att.on_duty_days"], 1)
        self.assertGreater(row["att.worked_hours"], 0)
        self.assertIsNone(row["att.extra_shifts"])  # staff
        # 12 a year from the cut-over (2 Nov 2026): Casual Leave dated before it does not use the balance
        self.assertEqual(row["att.cl_balance"], 12)

    def test_production_workers_count_by_shift_day_despite_a_serial_join_date(self):
        fields = [
            "emp.code", "emp.join_date", "att.present_days", "att.half_days", "att.shifts_earned", "att.extra_shifts",
            "att.quarter_days", "att.ot_hours",
        ]  # fmt: skip
        rows = self.by(self.preview("employees", fields, period=PERIOD))
        p1, n1 = rows["P100"], rows["P200"]
        self.assertEqual(p1["emp.join_date"], "2024-12-14")
        stored = {r.date: r for r in AttendanceDayRecord.objects.filter(employee=self.p1)}
        self.assertGreater(stored[MON].shifts_earned, 1)  # a day with an extra shift
        self.assertEqual(stored[WED].shifts_earned, Decimal("0.75"))  # a quarter day
        self.assertEqual(p1["att.shifts_earned"], float(sum(r.shifts_earned for r in stored.values())))
        self.assertEqual(p1["att.extra_shifts"], float(stored[MON].shifts_earned - 1))
        quarters = sum(1 for r in stored.values() if (r.shifts_earned * 4) % 2 == 1)
        self.assertGreaterEqual(quarters, 1)
        self.assertEqual(p1["att.quarter_days"], quarters)
        self.assertIsNone(p1["att.ot_hours"])
        nights = AttendanceDayRecord.objects.filter(employee=self.n1, status__in=("present", "half_shift"))
        self.assertEqual(n1["att.present_days"] + n1["att.half_days"], nights.count())
        self.assertGreaterEqual(nights.count(), 2)  # Monday's and Tuesday's nights

    def test_personal_salary_and_employment_fields(self):
        fields = [
            "emp.code", "emp.phone", "emp.address", "emp.service_years", "emp.shift", "emp.type", "emp.branch",
            "sal.monthly", "sal.first_portion", "sal.second_portion", "sal.account_last4", "sal.bank_name",
            "sal.per_shift", "emp.pay_cycle",
        ]  # fmt: skip
        rows = self.by(self.preview("employees", fields, period=PERIOD))
        s1 = rows["C100"]
        self.assertEqual(s1["sal.account_last4"], "********9012")
        self.assertEqual((s1["sal.first_portion"], s1["sal.second_portion"]), (13000.0, 13000.0))
        self.assertEqual(s1["emp.shift"], "General")
        self.assertEqual((s1["emp.type"], s1["emp.branch"]), ("Staff", "Unit 1"))
        self.assertEqual(s1["emp.address"], "12 Mill Road")
        self.assertGreater(s1["emp.service_years"], 2)
        p1 = rows["P100"]
        self.assertEqual((p1["sal.per_shift"], p1["sal.monthly"], p1["emp.pay_cycle"]), (500.0, None, "Weekly"))

    def test_payroll_for_the_month_and_the_status_filter(self):
        rows = self.by(
            self.preview("employees", ["emp.code", "pay.net", "pay.payment_status", "pay.payrolls"], period=PERIOD)
        )
        self.assertEqual((rows["C100"]["pay.net"], rows["C100"]["pay.payment_status"]), (23001.0, "Paid"))
        self.assertEqual((rows["P100"]["pay.net"], rows["P100"]["pay.payment_status"]), (3000.0, "Not paid"))
        self.assertIsNone(rows["P200"]["pay.net"])  # parked in New Joiners: not on the payroll yet
        everyone = self.by(self.preview("employees", ["emp.code"], period=PERIOD, employeeStatus="all"))
        self.assertIn("C900", everyone)


class DaysPunchesTests(_World):
    def test_attendance_days_rows(self):
        fields = [
            "emp.code", "day.date", "day.status", "day.arrival_zone", "day.shifts_earned", "day.first_in", "day.last_out",
            "day.late_minutes", "day.penalty", "day.early_minutes", "day.ot_minutes", "day.type", "day.leave_type",
            "day.shift", "day.flags", "day.entry",
        ]  # fmt: skip
        body = self.preview("attendance_days", fields, dateFrom="2026-09-01", dateTo="2026-09-29")
        rows = {(r["emp.code"], r["day.date"]): r for r in body["rows"]}
        q = rows[("C100", "2026-09-03")]
        self.assertEqual(
            (q["day.arrival_zone"], q["day.shifts_earned"], q["day.late_minutes"]),
            ("Quarter (0.25 shift off)", 0.75, 60),
        )
        pen = rows[("C100", "2026-09-09")]
        self.assertEqual((pen["day.penalty"], pen["day.early_minutes"]), (0.25, 90))
        self.assertEqual(rows[("C100", "2026-09-10")]["day.ot_minutes"], 120)
        self.assertEqual(rows[("C100", "2026-09-08")]["day.status"], "Casual Leave")
        self.assertEqual(rows[("C100", "2026-09-07")]["day.leave_type"], "SL")
        self.assertEqual(rows[("C100", HOLIDAY.isoformat())]["day.type"], "Holiday: Founders Day")
        self.assertEqual(rows[("C100", "2026-09-06")]["day.type"], "Sunday")
        self.assertEqual(rows[("C100", "2026-09-01")]["day.shift"], "General")
        # the night shift: Monday's row has Tuesday morning's punch as its last out
        night = rows[("P200", MON.isoformat())]
        self.assertEqual((night["day.first_in"], night["day.last_out"]), ("21:00", "05:30"))
        self.assertIsNotNone(night["day.shift"])
        self.assertGreater(rows[("P100", MON.isoformat())]["day.shifts_earned"], 1)
        # not processed yet, and nothing before joining / of the other unit for a branch user
        self.assertIn("Not processed", rows[("C100", "2026-09-14")]["day.status"])
        self.assertEqual(rows[("C100", "2026-09-01")]["day.entry"], "Auto")

    def test_day_status_filter(self):
        body = self.preview("attendance_days", ["emp.code", "day.date", "day.status"], dateFrom="2026-09-01",
                            dateTo="2026-09-29", dayStatus="half,absent", employeeIds=str(self.s1.id))  # fmt: skip
        self.assertEqual(sorted(r["day.date"] for r in body["rows"]), ["2026-09-04", "2026-09-05"])

    def test_punches_count_for_their_shift_day(self):
        fields = ["emp.code", "punch.date", "punch.time", "punch.counts_for", "punch.source", "punch.device"]
        body = self.preview(
            "punches", fields, dateFrom=MON.isoformat(), dateTo=WED.isoformat(), employeeIds=str(self.n1.id)
        )
        got = [(r["punch.date"], r["punch.time"], r["punch.counts_for"]) for r in body["rows"]]
        self.assertEqual(
            got,
            [
                ("2026-09-21", "21:00:05", "2026-09-21"),
                ("2026-09-22", "05:30:10", "2026-09-21"),  # closes Monday's night
                ("2026-09-22", "21:00:08", "2026-09-22"),
                ("2026-09-23", "05:31:00", "2026-09-22"),
            ],
        )
        self.assertEqual({r["punch.source"] for r in body["rows"]}, {"Biometric"})
        self.assertEqual({r["punch.device"] for r in body["rows"]}, {"dev1"})


class RequestsPayrollTests(_World):
    def test_requests_of_every_kind(self):
        fields = [
            "emp.code",
            "req.type",
            "req.detail",
            "req.from",
            "req.days",
            "req.hours",
            "req.status",
            "req.decided_by",
        ]
        body = self.preview("requests", fields, dateFrom="2026-09-01", dateTo="2026-09-30", employeeStatus="all")
        types = sorted((r["req.type"], r["req.status"]) for r in body["rows"])
        self.assertEqual(
            types,
            [
                ("Casual Leave", "Approved"), ("Casual Leave", "Pending"), ("Leave", "Approved"), ("Missing punch", "Pending"),
                ("On-duty", "Approved"), ("Permission", "Approved"),
            ],
        )  # fmt: skip
        duty = next(r for r in body["rows"] if r["req.type"] == "On-duty")
        self.assertEqual((duty["req.from"], duty["req.days"], duty["req.decided_by"]), ("2026-09-18", 1.0, "Priya"))
        half = next(r for r in body["rows"] if r["req.type"] == "Casual Leave" and r["req.status"] == "Pending")
        self.assertEqual(half["req.days"], 0.5)
        leave = next(r for r in body["rows"] if r["req.type"] == "Leave")
        self.assertEqual((leave["req.detail"], leave["req.decided_by"]), (self.sick_name, "Priya (HR)"))
        self.assertEqual(next(r for r in body["rows"] if r["req.type"] == "Permission")["req.hours"], 1.0)
        approved = self.preview(
            "requests", fields, dateFrom="2026-09-01", dateTo="2026-09-30", requestStatus="approved"
        )
        self.assertEqual({r["req.status"] for r in approved["rows"]}, {"Approved"})
        only_cl = self.preview(
            "requests", fields, dateFrom="2026-09-01", dateTo="2026-09-30", requestType="casual_leave"
        )
        self.assertEqual({r["req.type"] for r in only_cl["rows"]}, {"Casual Leave"})
        outside = self.preview("requests", fields, requestType="on_duty", dateFrom="2026-09-19", dateTo="2026-09-29")
        self.assertEqual(outside["rows"], [])  # dated by the IST day it was raised

    def test_request_kinds_follow_the_role(self):
        body = self.preview(
            "requests", ["emp.code", "req.type"], self.leave_only, dateFrom="2026-09-01", dateTo="2026-09-30"
        )
        self.assertEqual({r["req.type"] for r in body["rows"]}, {"Leave"})
        self.assertTrue(any("cannot open them" in n for n in body["notes"]))

    def test_payroll_rows(self):
        fields = ["emp.code", "pay.kind", "pay.period", "pay.cycle", "pay.net", "pay.earned", "pay.deductions",
                  "pay.paid_days", "pay.payment_status", "pay.hr_status", "pay.list", "pay.lop_days"]  # fmt: skip
        body = self.preview("payroll", fields, period=PERIOD)
        rows = self.by(body)
        self.assertEqual(set(rows), {"C100", "C200", "P100"})  # P200 is parked
        self.assertTrue(any("parked in New Joiners" in n for n in body["notes"]))
        s1 = rows["C100"]
        self.assertEqual((s1["pay.kind"], s1["pay.period"], s1["pay.cycle"]), ("Staff", "September 2026", "Monthly"))
        self.assertEqual((s1["pay.net"], s1["pay.earned"], s1["pay.deductions"]), (23001.0, 24500.0, 1499.6))
        self.assertEqual((s1["pay.paid_days"], s1["pay.lop_days"]), (23.0, 3.0))
        self.assertEqual((s1["pay.payment_status"], s1["pay.hr_status"], s1["pay.list"]), ("Paid", "Pending", "Main"))
        p1 = rows["P100"]
        self.assertEqual((p1["pay.kind"], p1["pay.cycle"], p1["pay.paid_days"]), ("Production", "Weekly", 6.0))
        paid = self.by(self.preview("payroll", ["emp.code"], period=PERIOD, paymentStatus="paid"))
        self.assertEqual(set(paid), {"C100"})
        staff = self.by(self.preview("payroll", ["emp.code"], period=PERIOD, employmentType="production"))
        self.assertEqual(set(staff), {"P100"})

    def test_production_payroll_role_sees_production_rows_only(self):
        body = self.preview("payroll", ["emp.code", "pay.net"], self.prod_pay, period=PERIOD)
        self.assertEqual(set(self.by(body)), {"P100"})
        self.assertTrue(any("production payroll only" in n for n in body["notes"]))


# ═════════════════════════════════════════════════════════════════════════════
#  Saved reports: create, change, copy, delete
# ═════════════════════════════════════════════════════════════════════════════


class SavedReportTests(_World):
    def test_create_list_open_change_copy_delete(self):
        item = self.save(
            "  Monthly   Employee Performance Report ", fields=PERFORMANCE,
            filters={"period": PERIOD, "departmentIds": [self.accounts.id], "employeeStatus": "all", "junk": "x"},
            sort=[{"key": "att.present_days", "dir": "desc"}],
        )  # fmt: skip
        self.assertEqual(item["name"], "Monthly Employee Performance Report")
        self.assertEqual(item["reportId"], f"custom-{item['id']}")
        self.assertEqual((item["dataset"], item["datasetLabel"]), ("employees", "Employees with month figures"))
        self.assertEqual(item["fields"], PERFORMANCE)
        self.assertEqual(
            item["filters"], {"period": PERIOD, "departmentIds": str(self.accounts.id), "employeeStatus": "all"}
        )
        self.assertEqual(item["sort"], [{"key": "att.present_days", "dir": "desc"}])
        self.assertEqual((item["createdBy"], item["updatedBy"]), ("Editor", "Editor"))
        self.assertTrue(item["canEdit"] and item["canDelete"])
        self.assertTrue(AuditLog.objects.filter(module="reports", action="create", record_id=item["id"]).exists())

        listing = self.get(f"{BASE}/saved", self.viewer).json()
        mine = next(i for i in listing["items"] if i["id"] == item["id"])
        self.assertFalse(listing["canEdit"])
        self.assertFalse(mine["canEdit"] or mine["canDelete"])
        self.assertEqual(self.get(f"{BASE}/saved/{item['id']}", self.viewer).json()["name"], item["name"])

        changed = self.send(
            "put", f"{BASE}/saved/{item['id']}", {"name": "Performance", "description": "monthly"}, self.editor2
        )
        self.assertEqual(
            (changed["name"], changed["description"], changed["updatedBy"]), ("Performance", "monthly", "Editor2")
        )
        self.assertEqual(changed["fields"], PERFORMANCE)  # untouched
        self.assertFalse(changed["canDelete"])  # not the creator
        log = AuditLog.objects.filter(module="reports", action="update", record_id=item["id"]).get()
        self.assertEqual((log.old_values["name"], log.new_values["name"]), (item["name"], "Performance"))

        copy = self.send("post", f"{BASE}/saved/{item['id']}/duplicate", user=self.editor2, expect=201)
        self.assertEqual(copy["name"], "Performance (copy)")
        self.assertEqual(
            (copy["fields"], copy["filters"], copy["sort"]), (changed["fields"], changed["filters"], changed["sort"])
        )
        self.assertEqual(copy["createdBy"], "Editor2")
        self.assertTrue(copy["canDelete"])

        self.send("delete", f"{BASE}/saved/{item['id']}", user=self.editor2, expect=403)  # not theirs
        self.send("delete", f"{BASE}/saved/{copy['id']}", user=self.editor2, expect=204)
        self.send("delete", f"{BASE}/saved/{item['id']}", user=self.admin, expect=204)  # a super admin may
        self.assertFalse(SavedCustomReport.objects.exists())
        self.assertEqual(AuditLog.objects.filter(module="reports", action="delete").count(), 2)
        self.get(f"{BASE}/saved/{item['id']}", expect=404)

    def test_view_only_roles_cannot_change_anything(self):
        item = self.save()
        self.save(user=self.viewer, expect=403)
        self.send("put", f"{BASE}/saved/{item['id']}", {"name": "x"}, self.viewer, expect=403)
        self.send("post", f"{BASE}/saved/{item['id']}/duplicate", user=self.viewer, expect=403)
        self.send("delete", f"{BASE}/saved/{item['id']}", user=self.viewer, expect=403)
        self.assertEqual(SavedCustomReport.objects.count(), 1)

    def test_save_refusals(self):
        self.assertEqual(self.save(name="  ", expect=400)["error"], "invalid_name")
        self.assertEqual(self.save(name="x" * 121, expect=400)["error"], "invalid_name")
        self.assertEqual(self.save(dataset="nope", expect=400)["error"], "unknown_dataset")
        self.assertEqual(self.save(fields=[], expect=400)["error"], "invalid_field")
        self.assertEqual(self.save(fields=["emp.code", 3], expect=400)["error"], "invalid_field")
        bad = self.save(filters={"period": PERIOD, "departmentIds": "x"}, expect=400)
        self.assertEqual((bad["error"], bad["field"]), ("invalid_filter", "departmentIds"))
        self.assertEqual(
            self.save(filters={"dateRange": "someday"}, dataset="punches", expect=400)["error"], "invalid_filter"
        )
        self.assertEqual(self.save(sort=[{"key": "emp.phone", "dir": "asc"}], expect=400)["error"], "invalid_sort")
        forbidden = self.save(fields=["emp.code", "pay.net"], user=self.att_only, expect=400)
        self.assertEqual(forbidden["error"], "field_forbidden")
        self.assertEqual(self.save(dataset="payroll", user=self.att_only, expect=403)["error"], "dataset_forbidden")
        self.assertFalse(SavedCustomReport.objects.exists())

    def test_a_field_the_viewer_cannot_see_is_dropped_and_kept(self):
        item = self.save(fields=["emp.code", "pay.net", "att.present_days"], user=self.admin)
        mine = self.get(f"{BASE}/saved/{item['id']}", self.att_only).json()
        self.assertEqual((mine["fields"], mine["hiddenFields"]), (["emp.code", "att.present_days"], 1))
        body = self.open_report(item["reportId"], self.att_only, period=PERIOD)
        self.assertEqual([c["key"] for c in body["columns"]], ["emp.code", "att.present_days"])
        self.assertTrue(any("Net pay" in n and "not have access" in n for n in body["notes"]))
        # a change by that role keeps the field it could not see, at its place
        changed = self.send(
            "put", f"{BASE}/saved/{item['id']}", {"fields": ["att.present_days", "emp.code"]}, self.att_only
        )
        self.assertEqual(
            SavedCustomReport.objects.get(pk=item["id"]).fields, ["att.present_days", "pay.net", "emp.code"]
        )
        self.assertEqual(changed["fields"], ["att.present_days", "emp.code"])
        # the full report for whoever may see it
        self.assertEqual(len(self.open_report(item["reportId"], self.admin, period=PERIOD)["columns"]), 3)

    def test_changing_the_data_source_needs_its_fields(self):
        item = self.save()
        r = self.send("put", f"{BASE}/saved/{item['id']}", {"dataset": "payroll"}, expect=400)
        self.assertEqual(r["error"], "invalid_field")
        ok = self.send("put", f"{BASE}/saved/{item['id']}", {"dataset": "payroll", "fields": ["emp.code", "pay.net"]})
        self.assertEqual((ok["dataset"], ok["fields"]), ("payroll", ["emp.code", "pay.net"]))

    def test_filters_in_the_form_shape_are_stored_as_query_parameters(self):
        item = self.save(
            dataset="attendance_days",
            fields=["emp.code", "day.date"],
            filters={
                "dateRange": {"dateFrom": "2026-09-01", "dateTo": "2026-09-10"},
                "department": [self.accounts.id, self.stitching.id],
                "dayStatus": ["present", "half"],
                "employeeStatus": "all",
            },
        )
        self.assertEqual(
            item["filters"],
            {
                "dateFrom": "2026-09-01",
                "dateTo": "2026-09-10",
                "departmentIds": f"{self.accounts.id},{self.stitching.id}",
                "employeeStatus": "all",
                "dayStatus": "present,half",
            },
        )
        rolling = self.save(dataset="punches", fields=["emp.code"], filters={"dateRange": "last7", "period": "x"})
        self.assertEqual(rolling["filters"], {"dateRange": "last7"})  # (punches has no month filter)


# ═════════════════════════════════════════════════════════════════════════════
#  A saved report in the Report Center: catalog, run, export, branch isolation
# ═════════════════════════════════════════════════════════════════════════════


class RunExportTests(_World):
    def test_catalog_lists_saved_reports_with_saved_filters_as_defaults(self):
        item = self.save(
            "Accounts staff", fields=PERFORMANCE,
            filters={"period": "2026-08", "departmentIds": str(self.accounts.id), "employeeStatus": "all",
                     "employmentType": "staff"},
        )  # fmt: skip
        days = self.save("Days", dataset="attendance_days", fields=["emp.code", "day.date"],
                         filters={"dateFrom": "2026-09-01", "dateTo": "2026-09-07", "dayStatus": "present,half"})  # fmt: skip
        rolling = self.save("Rolling", dataset="punches", fields=["emp.code"], filters={"dateRange": "lastMonth"})
        body = self.get("/api/reports/catalog", self.viewer).json()
        cats = {c["id"]: c for c in body["categories"]}
        self.assertEqual(cats["customise"]["count"], 3)
        spec = next(r for r in body["reports"] if r["id"] == item["reportId"])
        self.assertEqual(
            (spec["category"], spec["title"], spec["icon"]), ("customise", "Accounts staff", "SlidersHorizontal")
        )
        self.assertEqual([c["key"] for c in spec["columns"]], PERFORMANCE)
        defaults = {f["kind"]: f["default"] for f in spec["filters"]}
        self.assertEqual(defaults["period"], "2026-08")
        self.assertEqual(defaults["department"], [self.accounts.id])
        self.assertEqual((defaults["employeeStatus"], defaults["employmentType"]), ("all", "staff"))
        dspec = next(r for r in body["reports"] if r["id"] == days["reportId"])
        dd = {f["key"]: f["default"] for f in dspec["filters"]}
        self.assertEqual(dd["dateRange"], {"dateFrom": "2026-09-01", "dateTo": "2026-09-07"})
        self.assertEqual(dd["dayStatus"], "present,half")
        rspec = next(r for r in body["reports"] if r["id"] == rolling["reportId"])
        self.assertEqual(rspec["filters"][0]["default"], {"dateFrom": "2026-08-01", "dateTo": "2026-08-31"})
        # a role without the data source does not get it listed; without Customise the category is gone
        listed = {r["id"] for r in self.get("/api/reports/catalog", self.leave_only).json()["reports"]}
        self.assertFalse(listed & {item["reportId"], days["reportId"]})
        none = self.get("/api/reports/catalog", self.no_custom).json()
        self.assertNotIn("customise", {c["id"] for c in none["categories"]})
        self.assertFalse(any(r["id"].startswith("custom-") for r in none["reports"]))

    def test_run_without_filters_uses_the_saved_values(self):
        days = self.save("Days", dataset="attendance_days", fields=["emp.code", "day.date", "day.status"],
                         filters={"dateFrom": "2026-09-01", "dateTo": "2026-09-07", "dayStatus": "half,absent",
                                  "employeeIds": str(self.s1.id)})  # fmt: skip
        body = self.open_report(days["reportId"])
        self.assertEqual(sorted(r["day.date"] for r in body["rows"]), ["2026-09-04", "2026-09-05"])
        self.assertIn({"label": "Date range", "value": "01-Sep-2026 to 07-Sep-2026"}, body["filters"])

    def test_monthly_employee_performance_report_end_to_end(self):
        item = self.save("Monthly Employee Performance Report", fields=PERFORMANCE, filters={"period": PERIOD},
                         sort=[{"key": "emp.code", "dir": "asc"}])  # fmt: skip
        body = self.open_report(item["reportId"], period=PERIOD)
        self.assertEqual(body["title"], "Monthly Employee Performance Report")
        self.assertEqual([c["label"] for c in body["columns"]], [
            "Emp code", "Employee name", "Department", "Present days", "Late days", "OT hours", "Leave days",
            "Net pay (as printed)",
        ])  # fmt: skip
        rows = self.by(body)
        self.assertEqual(list(rows), ["C100", "C200", "P100", "P200"])
        self.assertEqual(
            {k: rows["C100"][k] for k in PERFORMANCE},
            {
                "emp.code": "C100", "emp.name": "C100 Staff", "emp.department": "ACCOUNTS", "att.present_days": 5,
                "att.late_count": 2, "att.ot_hours": 2.0, "att.leave_days": 1.0, "pay.net": 23001.0,
            },
        )  # fmt: skip
        self.assertEqual(rows["P100"]["pay.net"], 3000.0)
        self.assertEqual(body["totals"]["pay.net"], 26001.0 + 20000)

        x = self.get(f"/api/reports/export/{item['reportId']}", fmt="xlsx", period=PERIOD)
        self.assertIn("monthly_employee_performance_report_", x["Content-Disposition"])
        ws = load_workbook(io.BytesIO(x.content)).active
        header = [c.value for c in ws[HEADER_ROW]]
        self.assertEqual(header[:3], ["Emp code", "Employee name", "Department"])
        values = [[c.value for c in row] for row in ws.iter_rows(min_row=HEADER_ROW + 1)]
        self.assertIn(["C100", "C100 Staff", "ACCOUNTS", 5, 2, 2.0, 1.0, 23001.0], [v[:8] for v in values])
        p = self.get(f"/api/reports/export/{item['reportId']}", fmt="pdf", period=PERIOD)
        self.assertTrue(p.content.startswith(b"%PDF"))
        self.assertNotIn(b"1190.55", p.content)  # 8 columns: A4 landscape
        logged = AuditLog.objects.filter(module="reports", action="export")
        self.assertEqual(logged.count(), 2)
        self.assertTrue(all("Monthly Employee Performance Report" in a.record_description for a in logged))

    def test_wide_pdf_is_a3_and_other_reports_keep_their_page(self):
        fields = [f.key for f in DATASETS["employees"].fields if f.section in ("attendance",)][:14]
        item = self.save("Wide", fields=["emp.code", *fields])
        pdf = self.get(f"/api/reports/export/{item['reportId']}", fmt="pdf", period=PERIOD).content
        self.assertIn(b"1190.55", pdf)  # A3 landscape: 1190.55 x 841.89 pt
        from .reporting import export_pdf

        self.assertEqual(export_pdf._page_size.__name__, "_page_size")  # put back after the build

    def test_branch_isolation(self):
        item = self.save(fields=["emp.code", "pay.net"], filters={"period": PERIOD, "employeeStatus": "all"})
        everyone = set(self.by(self.open_report(item["reportId"])))
        self.assertIn("C200", everyone)
        mine = set(self.by(self.open_report(item["reportId"], self.branch_editor)))
        self.assertNotIn("C200", mine)
        self.assertIn("C100", mine)
        # asking for the other unit's employee or department explicitly still returns nothing of it
        for params in ({"employeeIds": str(self.s2.id)}, {"departmentIds": str(self.cutting.id)}):
            for ds, fields in (("employees", ["emp.code"]), ("payroll", ["emp.code"]), ("attendance_days", ["emp.code"]),
                               ("punches", ["emp.code"]), ("requests", ["emp.code"])):  # fmt: skip
                body = self.preview(ds, fields, self.branch_editor, period=PERIOD, **params)
                self.assertEqual(body["rows"], [], (ds, params))

    def test_unknown_custom_ids_and_retired_reports_are_404(self):
        for rid in ("custom-999999", "custom-abc", "custom-", "custom-preview", "punch-log"):
            self.open_report(rid, expect=404)
        item = self.save()
        self.open_report(item["reportId"], self.no_custom, expect=404)  # without Customise it looks non-existent
        # Customise, but none of the data source's modules: forbidden, like any report whose data the role cannot open
        self.assertEqual(self.open_report(item["reportId"], self.leave_only, expect=403)["error"], "report_forbidden")
        # Production Payroll opens the employees source (its identity columns)
        self.open_report(item["reportId"], self.prod_pay)

    def test_permission_tree_maps_the_builder_api(self):
        for path in ("reports/custom/datasets", "reports/custom/preview", "reports/custom/saved", "reports/custom/saved/7",
                     "reports/custom/saved/7/duplicate"):  # fmt: skip
            self.assertEqual(resolve_module(path), "reports.customise", path)
        self.assertEqual(resolve_module("reports/run/custom-7"), "reports")


# ═════════════════════════════════════════════════════════════════════════════
#  Review fixes (2026-11-19): payroll kinds, saved filters, the team library, field access
# ═════════════════════════════════════════════════════════════════════════════


def _role_user(name: str, perms: dict) -> HRUser:
    role = Role.objects.create(name=name, permissions=perms)
    return HRUser.objects.create(username=name, password_hash="x", full_name=name.title(), role=role)


class PayrollKindTests(_World):
    """Production Payroll does not come with Payroll: Customise follows the Salary category (and the Production Payroll
    pages' own API), so a Payroll-only role reads no production pay or rate anywhere in it."""

    def test_payroll_only_role_sees_staff_payrolls_only(self):
        payroll_only = _role_user("payroll_only", {"reports": "edit", "payroll": "view"})
        body = self.preview("payroll", ["emp.code", "pay.kind", "pay.net", "pay.rate"], payroll_only, period=PERIOD)
        self.assertEqual(set(self.by(body)), {"C100", "C200"})
        self.assertEqual({r["pay.kind"] for r in body["rows"] if not r.get("_kind")}, {"Staff"})
        self.assertTrue(any("staff payroll only" in n for n in body["notes"]))
        fields = ["emp.code", "pay.net", "sal.per_shift", "sal.monthly"]
        rows = self.by(self.preview("employees", fields, payroll_only, period=PERIOD))
        self.assertEqual((rows["C100"]["pay.net"], rows["C100"]["sal.monthly"]), (23001.0, 26000.0))
        for code in ("P100", "P200"):
            self.assertIsNone(rows[code]["pay.net"], code)
            self.assertIsNone(rows[code]["sal.per_shift"], code)

    def test_salary_follows_the_kind_of_each_row(self):
        body = self.preview("employees", ["emp.code", "sal.monthly", "sal.per_shift"], self.prod_pay, period=PERIOD)
        rows = self.by(body)
        self.assertEqual(rows["P100"]["sal.per_shift"], 500.0)
        self.assertIsNone(rows["C100"]["sal.monthly"])  # a staff salary needs Salary or Payroll
        self.assertTrue(any("blank for 2 staff employee(s)" in n for n in body["notes"]))
        salary_only = _role_user("salary_only", {"reports": "view", "salary": "view"})
        fields = ["emp.code", "sal.monthly", "sal.per_shift"]
        rows = self.by(self.preview("employees", fields, salary_only, period=PERIOD))
        self.assertEqual((rows["C100"]["sal.monthly"], rows["P100"]["sal.per_shift"]), (26000.0, 500.0))

    def test_saved_net_next_to_the_printed_one(self):
        rows = self.by(self.preview("payroll", ["emp.code", "pay.net", "pay.net_saved"], period=PERIOD))
        self.assertEqual((rows["C100"]["pay.net"], rows["C100"]["pay.net_saved"]), (23001.0, 23000.4))
        body = self.preview("employees", ["emp.code", "pay.net", "pay.net_saved"], period=PERIOD)
        self.assertEqual([c["label"] for c in body["columns"]], ["Emp code", "Net pay (as printed)", "Net pay (saved)"])
        self.assertEqual(self.by(body)["C100"]["pay.net_saved"], 23000.4)

    def test_personal_details_need_the_employees_module(self):
        payroll_only = _role_user("payroll_only2", {"reports": "edit", "payroll": "view"})
        for key in ("emp.gender", "emp.blood_group", "emp.dob", "emp.phone"):
            params = {"dataset": "employees", "fields": f"emp.code,{key}"}
            r = self.client.get(f"{BASE}/preview", params, **hdr(payroll_only))
            self.assertEqual((r.status_code, r.json()["error"]), (400, "field_forbidden"), key)
        keys = {
            f["key"]
            for d in self.get(f"{BASE}/datasets", payroll_only).json()["datasets"]
            for s in d["sections"]
            for f in s["fields"]
        }
        self.assertFalse(keys & {"emp.gender", "emp.blood_group"})
        self.assertIn("emp.join_date", keys)  # employment details stay with the identity columns


class SavedFilterTests(_World):
    """A saved report's filters: left out of a run = the saved value (every kind, files included); sent EMPTY = all."""

    def test_saved_department_is_used_when_a_run_leaves_it_out(self):
        item = self.save(
            "Cutting only", fields=["emp.code"],
            filters={"period": PERIOD, "departmentIds": str(self.cutting.id), "employeeStatus": "all"},
        )  # fmt: skip
        body = self.open_report(item["reportId"])
        self.assertEqual(sorted(self.by(body)), ["C200"])
        self.assertIn({"label": "Department", "value": "CUTTING"}, body["filters"])
        # cleared in the workspace (sent empty): every department
        every = self.open_report(item["reportId"], departmentIds="")
        self.assertEqual(sorted(self.by(every)), ["C100", "C200", "C900", "P100", "P200"])

    def test_saved_employee_type_is_used_when_a_run_leaves_it_out(self):
        item = self.save(
            "Production only",
            fields=["emp.code", "emp.type"],
            filters={"period": PERIOD, "employmentType": "production"},
        )
        self.assertEqual(sorted(self.by(self.open_report(item["reportId"]))), ["P100", "P200"])
        everyone = self.open_report(item["reportId"], employmentType="")
        self.assertEqual(sorted(self.by(everyone)), ["C100", "C200", "P100", "P200"])
        self.assertEqual(sorted(self.by(self.open_report(item["reportId"], employmentType="staff"))), ["C100", "C200"])

    def test_a_viewer_confined_to_one_unit_keeps_their_unit(self):
        item = self.save("Unit 2", fields=["emp.code"], filters={"period": PERIOD, "branchIds": str(self.b2.id)})
        self.assertEqual(sorted(self.by(self.open_report(item["reportId"]))), ["C200"])  # the saved unit
        # the unit filter is not offered to a unit-scoped viewer: their own unit, not an empty report
        mine = self.open_report(item["reportId"], self.branch_editor)
        self.assertEqual(sorted(self.by(mine)), ["C100", "P100", "P200"])

    def test_an_export_without_filters_keeps_the_saved_employee(self):
        item = self.save("One person", fields=["emp.code"], filters={"period": PERIOD, "employeeIds": str(self.s1.id)})
        r = self.get(f"/api/reports/export/{item['reportId']}", fmt="xlsx")
        ws = load_workbook(io.BytesIO(r.content)).active
        codes = {str(row[0].value) for row in ws.iter_rows(min_row=HEADER_ROW + 1) if row[0].value}
        self.assertIn("C100", codes)
        self.assertFalse(codes & {"C200", "P100", "P200"})

    def test_a_saved_select_can_be_widened_to_all(self):
        fields = ["emp.code", "req.type", "req.status"]
        item = self.save(
            "Pending leave", dataset="requests", fields=fields,
            filters={"dateFrom": "2026-09-01", "dateTo": "2026-09-30", "requestType": "leave,casual_leave",
                     "requestStatus": "pending", "employeeStatus": "all"},
        )  # fmt: skip
        saved = self.open_report(item["reportId"])
        self.assertEqual({(r["req.type"], r["req.status"]) for r in saved["rows"]}, {("Casual Leave", "Pending")})
        widened = self.open_report(item["reportId"], requestType="", requestStatus="")
        self.assertEqual(
            {r["req.type"] for r in widened["rows"]},
            {"Casual Leave", "Leave", "Missing punch", "On-duty", "Permission"},
        )
        self.assertEqual({r["req.status"] for r in widened["rows"]}, {"Approved", "Pending"})
        # another choice than the saved one is the request's own
        approved = self.open_report(item["reportId"], requestStatus="approved")
        self.assertEqual(
            {(r["req.type"], r["req.status"]) for r in approved["rows"]},
            {("Casual Leave", "Approved"), ("Leave", "Approved")},
        )

    def test_the_catalog_marks_the_filters_an_empty_value_widens(self):
        item = self.save(
            dataset="requests",
            fields=["emp.code"],
            filters={"requestStatus": "pending", "departmentIds": str(self.accounts.id)},
        )
        spec = next(r for r in self.get("/api/reports/catalog").json()["reports"] if r["id"] == item["reportId"])
        clearable = {f["key"] for f in spec["filters"] if f.get("clearable")}
        self.assertEqual(
            clearable, {"branch", "department", "employmentType", "employee", "requestType", "requestStatus"}
        )
        defaults = {f["key"]: f["default"] for f in spec["filters"]}
        self.assertEqual((defaults["requestStatus"], defaults["department"]), ("pending", [self.accounts.id]))
        # an ordinary report has none
        reports = self.get("/api/reports/catalog").json()["reports"]
        plain = [f for r in reports if not r["id"].startswith("custom-") for f in r["filters"]]
        self.assertTrue(plain)
        self.assertFalse(any(f.get("clearable") for f in plain))


class LibraryAccessTests(_World):
    def test_the_list_holds_only_reports_the_role_can_open(self):
        pay = self.save("Pay", dataset="payroll", fields=["emp.code", "pay.net"], user=self.admin)
        days = self.save("Days", dataset="attendance_days", fields=["emp.code"], filters={}, user=self.admin)
        listed = {i["id"] for i in self.get(f"{BASE}/saved", self.att_only).json()["items"]}
        self.assertEqual(listed, {days["id"]})
        catalog = {r["id"] for r in self.get("/api/reports/catalog", self.att_only).json()["reports"]}
        self.assertNotIn(pay["reportId"], catalog)
        self.assertIn(days["reportId"], catalog)
        everything = {i["id"] for i in self.get(f"{BASE}/saved", self.admin).json()["items"]}
        self.assertEqual(everything, {pay["id"], days["id"]})
        # a copy nobody in that role could open is refused
        r = self.send("post", f"{BASE}/saved/{pay['id']}/duplicate", user=self.att_only, expect=403)
        self.assertEqual(r["error"], "dataset_forbidden")
        self.assertEqual(SavedCustomReport.objects.count(), 2)


# ═════════════════════════════════════════════════════════════════════════════
#  Query budget
# ═════════════════════════════════════════════════════════════════════════════


class QueryBudgetTests(_World):
    BUDGET = 25

    def _count(self, item_id: int, params: dict) -> tuple[int, list[str]]:
        factory = APIRequestFactory()
        raw = factory.get(f"/api/reports/run/custom-{item_id}", params)
        raw.jwt_user = {"role": "hr", "hrUserId": self.admin.id}
        raw.hr_branch_id = None
        request = Request(raw)
        spec = spec_for_saved(request, f"custom-{item_id}")  # (also reads the user: cached for the run)
        with CaptureQueriesContext(connection) as cq:
            run_report(request, spec, request.query_params)
        return len(cq.captured_queries), [q["sql"] for q in cq.captured_queries]

    def _more_people(self, n: int):
        for i in range(n):
            emp = Employee.objects.create(
                employee_code=f"Z{i:03d}", first_name="Z", last_name=str(i), employment_type="staff" if i % 2 else "production",
                department=self.accounts if i % 2 else self.stitching, branch=self.b1, status="active",
                salary_amount=Decimal("15000"), join_date="01-01-45640",
            )  # fmt: skip
            for d in range(1, 29):
                AttendanceDayRecord.objects.create(
                    employee=emp, date=date(2026, 9, d), status="present", shifts_earned=1, is_late=d % 5 == 0
                )
            AttendanceLog.objects.create(employee=emp, date=date(2026, 9, 3), punch_time=time(9, 0), punch_type="IN")
            Payroll.objects.create(
                employee=emp, salary_mode="monthly", month=9, year=2026, base_salary=15000, gross_salary=15000,
                final_salary=15000,
            )  # fmt: skip

    def test_query_count_does_not_grow_with_employees(self):
        perf = self.save(fields=PERFORMANCE, filters={"period": PERIOD})
        every = self.save(fields=[f.key for f in DATASETS["employees"].fields], filters={"period": PERIOD})
        days = self.save(dataset="attendance_days", fields=[f.key for f in DATASETS["attendance_days"].fields],
                         filters={"dateFrom": "2026-09-01", "dateTo": "2026-09-29"})  # fmt: skip
        pay = self.save(
            dataset="payroll", fields=[f.key for f in DATASETS["payroll"].fields], filters={"period": PERIOD}
        )
        punches = self.save(dataset="punches", fields=[f.key for f in DATASETS["punches"].fields],
                            filters={"dateFrom": "2026-09-01", "dateTo": "2026-09-29"})  # fmt: skip
        reqs = self.save(dataset="requests", fields=[f.key for f in DATASETS["requests"].fields],
                         filters={"dateFrom": "2026-09-01", "dateTo": "2026-09-29"})  # fmt: skip
        items = (perf, every, days, pay, punches, reqs)
        before = {i["id"]: self._count(i["id"], {}) for i in items}
        self._more_people(12)
        after = {i["id"]: self._count(i["id"], {}) for i in items}
        for i in items:
            self.assertEqual(before[i["id"]][0], after[i["id"]][0], i["dataset"])
            for sql in after[i["id"]][1]:
                self.assertNotIn('"employees"."photo_url"', sql, i["dataset"])
                self.assertNotIn('"employees"."password_hash"', sql, i["dataset"])
        self.assertLessEqual(after[perf["id"]][0], self.BUDGET)
        for i in (days, pay, punches, reqs):
            self.assertLessEqual(after[i["id"]][0], self.BUDGET, i["dataset"])
        # every field of "employees" at once: still a fixed number (the HOD lookup alone is five)
        self.assertLessEqual(after[every["id"]][0], 30)

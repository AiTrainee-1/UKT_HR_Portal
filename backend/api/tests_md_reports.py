"""The Managing Director's executive reports (reporting/definitions/md_*.py): every figure recomputed by hand from a small
company, and checked against the analytics function it must equal.

Run:  DB_TEST_NAME=test_uktex_reports python manage.py test api.tests_md_reports --noinput

THE COMPANY ("today" is Monday 12 Oct 2026, 12:00 IST; the weeks measured are W = Mon 7 .. Sun 13 Sep and P = Mon 31 Aug ..
Sun 6 Sep; Friday 4 Sep is a holiday)

    Unit A   Stitching: E1 Asha (staff), E2 Bala (staff), E4 Dev (production)     Cutting: E3 Chitra (staff, Saturday off),
                                                                                           E6 Farid (staff, joined Wed 9 Sep)
    Unit B   Accounts: E5 Esha (staff), E7 Gita (staff, joined 1 Jul, last day Thu 10 Sep, approved resignation)
    One letter a day, Mon..Sun:  P present, p present and late, H half day, A absent, L leave, O off / holiday row

    W   E1 PpAPHPO   E2 PAAAPLO   E3 pppPpAO (the Saturday A is the day off)   E4 PPHAPPA (the Sunday A is a weekly off)
        E5 PPPPPPO   E6 --PPPP-   E7 PPPP---
        scheduled days: E1 6  E2 6  E3 5  E4 6  E5 6  E6 4  E7 4 = 37; present 29, half 2, absent 5, leave 1
        attendance (29 + 1) / 37 = 81.1 %, absenteeism 5 / 37 = 13.5 %, late 5 / 31 worked days = 16.1 %
        Stitching 18 days: 61.1 % / 27.8 % / late 1 of 12 = 8.3 %      Cutting 9 days: 100 % / 0 % / late 4 of 9 = 44.4 %
        Accounts 10 days: 100 % / 0 % / 0 %
    P   E1 PPPPOPO   E2 PAAPOPO   E3 PPPPOAO   E4 PPPHOPA   E5 PPPPOPO   E7 PPPPOPO
        Stitching 15 days: 83.3 % / 13.3 % / 0 %     Cutting 4 days: 100 %     Accounts 10 days: 100 %
        company 29 days: 26 + 0.5 present -> 91.4 %, absenteeism 2 / 29 = 6.9 %, late 0 %
    Overtime (hours): W E1 1.5 (detected) E3 0.5 (announced) E2 0.75 REJECTED; P E1 1.0

    Payroll (Aug / Sep 2026, gross is before overtime)     Aug                  Sep
        Stitching   E1 26,000 (PF 1,560)  E2 20,000        E1 26,000 + 1,000 OT (PF 1,560)  E2 24,000      people 2 / 2
        Cutting     E3 18,000                              E3 18,000  E6 9,000                              people 1 / 2
        Accounts    E5 30,000 (PF 1,800)  E7 40,000        E5 30,000 (PF 1,800)  E7 12,000                 people 2 / 2
        Sep: gross 120,000, deductions 3,360, net 116,640, overtime 1,000, cost per head 20,000 (Aug gross 134,000, 5 people)
        Stitching 51,000 / Cutting 27,000 / Accounts 42,000 gross; E1 and E5 slips are marked paid (2 of 6)
    Hiring: open jobs Machine Operator (Stitching, posted 1 Aug) and Accountant (Accounts, posted 20 Sep); E2's resignation
        is pending since 1 Oct; E7's was approved (last day 10 Sep, left 71 days after joining: early attrition)

    Gate and tea (1 Sep .. 13 Sep; the tea-break allowance is 15 minutes)
        visits: Ravi (Unit A, to E1) 2 Sep and 9 Sep, Meena (A, to E3) 3 Sep, Inspector (B, to E5) 4 Sep, Walk-in (A, host
        typed as text) 8 Sep, Guest (A, to E1) 10 Sep 19:30 after hours -> 6 visits, 5 people; by host department Stitching 3,
        Cutting 1, Accounts 1, no employee 1
        outpasses: E1 three returned (30 + 60 + 20 = 110 min), E3 one (45), E5 approved never used, E2 left 9 Sep never returned
        tea (20 breaks each, two a day from 1 Sep): E1 12 x 10 min + 8 x 20 (8 overruns, 40 lost), E2 20 x 10, E3 10 x 10 + 10 x 25
        (10 overruns, 100 lost), E5 20 x 10 -> Stitching 8 of 40 = 20.0 %, Cutting 10 of 20 = 50.0 %, Accounts 0, company 18 of
        80 = 22.5 %, 140 minutes lost
"""

import copy
import io
import re
from contextlib import ExitStack, contextmanager
from datetime import date, datetime, time, timedelta
from datetime import timezone as dt_timezone
from decimal import Decimal
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

from django.apps import apps
from django.db import connection
from django.test import SimpleTestCase, TestCase, override_settings
from django.test.utils import CaptureQueriesContext
from openpyxl import load_workbook

from .clock import FACTORY_TZ
from .md_portal.analytics import attendance as ATT
from .md_portal.analytics import employees as EMP
from .md_portal.analytics import payroll as PAY
from .md_portal.analytics import recruitment as REC
from .md_portal.analytics import tea_break as TEA
from .md_portal.analytics import visitors as VIS
from .md_portal.common import Period, Scope, read_only_db, resolve_period
from .models import (
    AttendanceDayRecord,
    Branch,
    Department,
    Employee,
    EmployeeShiftAssignment,
    Holiday,
    HRUser,
    Job,
    OutpassRequest,
    OvertimeRecord,
    Payroll,
    ResignationRequest,
    Role,
    SalarySlip,
    ShiftTemplate,
    TeaBreakLog,
    TeaBreakRule,
    Visitor,
    VisitorVisit,
)
from .reporting import registry
from .reporting.definitions import md_common as MC
from .reporting.definitions import md_department_scorecard as scorecard_module
from .reporting.definitions import md_sources as MS
from .reporting.definitions.md_executive import MD_REPORT_IDS, REPORTS
from .reporting.export_xlsx import HEADER_ROW
from .reporting.filters import ReportContext
from .reporting.runner import run_report
from .tests_md_support import make_md, md_headers

TODAY = date(2026, 10, 12)
NOW_UTC = datetime(2026, 10, 12, 6, 30, tzinfo=dt_timezone.utc)  # 12:00 IST
W = ("2026-09-07", "2026-09-13")
P = ("2026-08-31", "2026-09-06")
# the two matrices that are too wide for a portrait page (fifteen and eighteen columns) print landscape; the rest are portrait
WIDE = ("md-weekly-workforce", "md-department-scorecard")
SPAN = ("2026-08-31", "2026-09-13")  # P and W together: fourteen days
SEPTEMBER = ("2026-09-01", "2026-09-30")
PERIOD_W = Period(date(2026, 9, 7), date(2026, 9, 13), "custom", "07 Sep - 13 Sep 2026")
PERIOD_P = Period(date(2026, 8, 31), date(2026, 9, 6), "custom", "31 Aug - 06 Sep 2026")
PERIOD_SPAN = Period(date(2026, 8, 31), date(2026, 9, 13), "custom", "31 Aug - 13 Sep 2026")
PERIOD_SEP = Period(date(2026, 9, 1), date(2026, 9, 30), "custom", "01 Sep - 30 Sep 2026")

STATUS = {"P": "present", "p": "present", "H": "half_shift", "A": "absent", "L": "on_leave", "O": "holiday"}
_SERIAL = iter(range(1, 1_000_000))


def RANGE(pair):  # noqa: N802 - reads as a constant table in the tests
    return {"dateFrom": pair[0], "dateTo": pair[1]}


def ist(month, day, hh=0, mm=0, year=2026):
    return datetime(year, month, day, hh, mm, tzinfo=FACTORY_TZ)


@contextmanager
def frozen(day=TODAY):
    """The factory clock stopped at ``day``, 12:00: the report framework and every analytics module read it."""
    local_now = datetime.combine(day, time(12, 0))
    utc_now = datetime.combine(day, time(6, 30), tzinfo=dt_timezone.utc)
    with ExitStack() as stack:
        for target in (
            "api.reporting.filters.ist_today",
            "api.reporting.views.ist_today",
            "api.md_portal.common.ist_today",
            "api.md_portal.analytics.attendance.ist_today",
            "api.md_portal.analytics.employees.ist_today",
            "api.md_portal.analytics.recruitment.ist_today",
            "api.md_portal.analytics.payroll.ist_today",
        ):
            stack.enter_context(mock.patch(target, return_value=day))
        for target in ("api.md_portal.common.ist_now", "api.md_portal.analytics.attendance.ist_now"):
            stack.enter_context(mock.patch(target, return_value=local_now))
        stack.enter_context(mock.patch("api.md_portal.analytics.visitors._now", return_value=utc_now))
        stack.enter_context(
            mock.patch("api.reporting.definitions.gate_visitor_tea_common.now_utc", return_value=utc_now)
        )
        yield


# ─── fixture builders ────────────────────────────────────────────────────────────────────────────────────────────────


def mark(emp, start: date, codes: str) -> None:
    rows = []
    for i, ch in enumerate(codes):
        if ch in " -":
            continue
        rows.append(
            AttendanceDayRecord(
                employee=emp, date=start + timedelta(days=i), status=STATUS[ch], is_late=(ch == "p"), is_informed=None
            )
        )
    AttendanceDayRecord.objects.bulk_create(rows)


def first_punch(emp, day: date, at: time) -> None:
    AttendanceDayRecord.objects.filter(employee=emp, date=day).update(first_punch=at)


def make_employee(code, first, last, dept, branch, kind="staff", **kw) -> Employee:
    kw.setdefault("join_date", "2025-01-01")
    return Employee.objects.create(
        employee_code=code,
        first_name=first,
        last_name=last,
        department=dept,
        branch=branch,
        employment_type=kind,
        **kw,
    )


def tea(emp, minutes: list[int]) -> None:
    """Breaks from 1 Sep, two a day (10:00 and 15:00), each lasting the given minutes."""
    rows = []
    for i, length in enumerate(minutes):
        out = ist(9, 1 + i // 2, 10 if i % 2 == 0 else 15)
        rows.append(TeaBreakLog(employee=emp, out_at=out, in_at=out + timedelta(minutes=length)))
    TeaBreakLog.objects.bulk_create(rows)


def visit(visitor, at: datetime, branch, host=None, whom="Reception", purpose="Meeting") -> None:
    row = VisitorVisit.objects.create(
        visitor=visitor, branch=branch, whom_to_meet=whom, purpose=purpose, meeting_employee=host
    )
    VisitorVisit.objects.filter(pk=row.pk).update(visited_at=at)


def make_pass(emp, requested: datetime, *, exited=None, entered=None, status="approved") -> None:
    row = OutpassRequest.objects.create(
        employee=emp,
        destination="Bank",
        reason="Personal work",
        status=status,
        source="manual",
        pass_type="personal",
        approved_at=requested + timedelta(minutes=5) if status == "approved" else None,
        exited_at=exited,
        entered_at=entered,
    )
    OutpassRequest.objects.filter(pk=row.pk).update(created_at=requested)


def slip(emp, ym, gross, *, ot=0, pf=0, paid=False) -> None:
    """A salary slip shaped like the payroll engine's, with its Payroll row (no calculation snapshot)."""
    gross, ot, pf = Decimal(gross), Decimal(ot), Decimal(pf)
    net = gross + ot - pf
    row = SalarySlip.objects.create(
        employee=emp,
        month=ym[1],
        year=ym[0],
        slip_number=f"R/{emp.employee_code}/{next(_SERIAL)}",
        basic=gross / 2,
        gross_salary=gross,
        ot_amount=ot,
        pf_deduction=pf,
        total_deductions=pf,
        net_salary=net,
        working_days=26,
        present_days=Decimal(26),
    )
    payroll = Payroll.objects.create(
        employee=emp,
        salary_mode="monthly",
        month=ym[1],
        year=ym[0],
        base_salary=gross,
        gross_salary=gross,
        final_salary=net,
        status="paid" if paid else "pending",
    )
    stamp = ist(10, 1, 9)  # generated after both months ended, so no slip is provisional
    SalarySlip.objects.filter(pk=row.pk).update(generated_at=stamp)
    Payroll.objects.filter(pk=payroll.pk).update(updated_at=stamp)


def build_world(cls) -> None:
    """The company in the module docstring."""
    cls.unit_a = Branch.objects.create(name="Unit A", code="RA")
    cls.unit_b = Branch.objects.create(name="Unit B", code="RB")
    cls.stitching = Department.objects.create(name="Stitching", branch=cls.unit_a)
    cls.cutting = Department.objects.create(name="Cutting", branch=cls.unit_a)
    cls.accounts = Department.objects.create(name="Accounts", branch=cls.unit_b)
    cls.shift = shift = ShiftTemplate.objects.create(
        name="General",
        shift_type="staff",
        start_time=time(9),
        end_time=time(18),
        grace_period_minutes=15,
        first_half_end=time(13, 30),
        lunch_duration_minutes=60,
    )
    cls.e1 = make_employee("R001", "Asha", "Kumar", cls.stitching, cls.unit_a)
    cls.e2 = make_employee("R002", "Bala", "Raj", cls.stitching, cls.unit_a)
    cls.e3 = make_employee("R003", "Chitra", "Devi", cls.cutting, cls.unit_a)
    cls.e4 = make_employee("R004", "Dev", "Prakash", cls.stitching, cls.unit_a, "production")
    cls.e5 = make_employee("R005", "Esha", "Mani", cls.accounts, cls.unit_b)
    cls.e6 = make_employee("R006", "Farid", "Khan", cls.cutting, cls.unit_a, join_date="2026-09-09")
    cls.e7 = make_employee("R007", "Gita", "Nair", cls.accounts, cls.unit_b, join_date="2026-07-01", status="inactive")
    for emp, start in ((cls.e1, date(2026, 1, 1)), (cls.e2, date(2026, 1, 1)), (cls.e3, date(2026, 1, 1))):
        EmployeeShiftAssignment.objects.create(
            employee=emp, shift=shift, effective_from=start, saturday_off=(emp is cls.e3)
        )
    EmployeeShiftAssignment.objects.create(employee=cls.e5, shift=shift, effective_from=date(2026, 1, 1))
    EmployeeShiftAssignment.objects.create(employee=cls.e6, shift=shift, effective_from=date(2026, 9, 9))
    EmployeeShiftAssignment.objects.create(employee=cls.e7, shift=shift, effective_from=date(2026, 7, 1))
    Holiday.objects.create(name="Test Holiday", date=date(2026, 9, 4))

    mark(cls.e1, date(2026, 9, 7), "PpAPHPO")
    mark(cls.e2, date(2026, 9, 7), "PAAAPLO")
    mark(cls.e3, date(2026, 9, 7), "pppPpAO")
    mark(cls.e4, date(2026, 9, 7), "PPHAPPA")
    mark(cls.e5, date(2026, 9, 7), "PPPPPPO")
    mark(cls.e6, date(2026, 9, 7), "  PPPP ")
    mark(cls.e7, date(2026, 9, 7), "PPPP   ")
    mark(cls.e1, date(2026, 8, 31), "PPPPOPO")
    mark(cls.e2, date(2026, 8, 31), "PAAPOPO")
    mark(cls.e3, date(2026, 8, 31), "PPPPOAO")
    mark(cls.e4, date(2026, 8, 31), "PPPHOPA")
    mark(cls.e5, date(2026, 8, 31), "PPPPOPO")
    mark(cls.e7, date(2026, 8, 31), "PPPPOPO")
    first_punch(cls.e1, date(2026, 9, 8), time(9, 40))  # 40 minutes after the 09:00 start
    for day, minute in ((7, 20), (8, 30), (9, 50), (11, 40)):  # E3: 20 + 30 + 50 + 40 = 140 minutes over 4 late days
        first_punch(cls.e3, date(2026, 9, day), time(9, minute))

    for emp, day, minutes, status, kind in (
        (cls.e1, 8, 90, "detected", None),
        (cls.e3, 9, 30, "announced", "pay"),
        (cls.e2, 9, 45, "rejected", None),
    ):
        OvertimeRecord.objects.create(
            employee=emp,
            date=date(2026, 9, day),
            last_punch_out=time(19, 30),
            ot_minutes=minutes,
            status=status,
            compensation_type=kind,
        )
    OvertimeRecord.objects.create(
        employee=cls.e1, date=date(2026, 9, 1), last_punch_out=time(19, 0), ot_minutes=60, status="detected"
    )

    resignation = ResignationRequest.objects.create(
        employee=cls.e7,
        reason="Better salary offer",
        last_working_date=date(2026, 9, 10),
        status="approved",
        approved_at=ist(9, 5, 12),
        approved_by="HR",
    )
    ResignationRequest.objects.filter(pk=resignation.pk).update(created_at=ist(9, 1, 10))
    pending = ResignationRequest.objects.create(
        employee=cls.e2, reason="Family reasons", last_working_date=date(2026, 11, 5), status="pending"
    )
    ResignationRequest.objects.filter(pk=pending.pk).update(created_at=ist(10, 1, 10))
    for title, dept, posted, status in (
        ("Machine Operator", cls.stitching, ist(8, 1, 10), "open"),
        ("Accountant", cls.accounts, ist(9, 20, 10), "open"),
        ("Cutter", cls.cutting, ist(8, 5, 10), "closed"),
    ):
        job = Job.objects.create(title=title, department=dept, status=status)
        Job.objects.filter(pk=job.pk).update(created_at=posted)

    AUG, SEP = (2026, 8), (2026, 9)
    slip(cls.e1, AUG, 26000, pf=1560)
    slip(cls.e2, AUG, 20000)
    slip(cls.e3, AUG, 18000)
    slip(cls.e5, AUG, 30000, pf=1800)
    slip(cls.e7, AUG, 40000)
    slip(cls.e1, SEP, 26000, ot=1000, pf=1560, paid=True)
    slip(cls.e2, SEP, 24000)
    slip(cls.e3, SEP, 18000)
    slip(cls.e5, SEP, 30000, pf=1800, paid=True)
    slip(cls.e6, SEP, 9000)
    slip(cls.e7, SEP, 12000)

    TeaBreakRule.objects.create(pk=1, allowed_minutes=15)
    tea(cls.e1, [10] * 12 + [20] * 8)
    tea(cls.e2, [10] * 20)
    tea(cls.e3, [10] * 10 + [25] * 10)
    tea(cls.e5, [10] * 20)

    people = {
        n: Visitor.objects.create(name=name, phone=str(9000000000 + n))
        for n, name in enumerate(["Ravi Supplier", "Meena Courier", "Inspector Raj", "Walk In", "Late Guest"], start=1)
    }
    visit(people[1], ist(9, 2, 10, 15), cls.unit_a, cls.e1, purpose="Fabric sales")
    visit(people[1], ist(9, 9, 11, 0), cls.unit_a, cls.e1, purpose="Fabric sales")
    visit(people[2], ist(9, 3, 14, 0), cls.unit_a, cls.e3, purpose="Delivery")
    visit(people[3], ist(9, 4, 9, 30), cls.unit_b, cls.e5, purpose="Audit")
    visit(people[4], ist(9, 8, 12, 0), cls.unit_a, None, whom="Reception", purpose="Enquiry")
    visit(people[5], ist(9, 10, 19, 30), cls.unit_a, cls.e1, purpose="Meeting")

    make_pass(cls.e1, ist(9, 2, 10, 50), exited=ist(9, 2, 11, 0), entered=ist(9, 2, 11, 30))
    make_pass(cls.e1, ist(9, 3, 10, 50), exited=ist(9, 3, 11, 0), entered=ist(9, 3, 12, 0))
    make_pass(cls.e1, ist(9, 4, 13, 50), exited=ist(9, 4, 14, 0), entered=ist(9, 4, 14, 20))
    make_pass(cls.e3, ist(9, 2, 9, 50), exited=ist(9, 2, 10, 0), entered=ist(9, 2, 10, 45))
    make_pass(cls.e5, ist(9, 8, 10, 0))
    make_pass(cls.e2, ist(9, 9, 14, 50), exited=ist(9, 9, 15, 0))


# ─── plumbing ────────────────────────────────────────────────────────────────────────────────────────────────────────


def request_for(user, branch=None):
    return SimpleNamespace(jwt_user={"hrUserId": user.id}, hr_branch_id=branch)


def by(rows, key="department"):
    return {r[key]: r for r in rows}


def data_rows(rows):
    """The rows of a report without its structural lines (the company's own TOTAL line)."""
    return [r for r in rows if not r.get("_kind")]


def split_company(body):
    """A report payload with the data rows under ``rows`` and the company line (``_kind: total``) under ``totals``."""
    total = next((r for r in body["rows"] if r.get("_kind") == "total"), None)
    return {
        **body,
        "rows": data_rows(body["rows"]),
        "totals": {k: v for k, v in total.items() if k != "_kind"} if total else None,
    }


class World(TestCase):
    """The company, an MD, and ways to run a report in-process (``run``) or through the HTTP API (``get``)."""

    @classmethod
    def setUpTestData(cls):
        build_world(cls)
        cls.md = make_md()
        cls.admin = HRUser.objects.create(username="root", password_hash="x", is_super_admin=True)
        cls.clerk = HRUser.objects.create(
            username="clerk",
            password_hash="x",
            role=Role.objects.create(name="Reports only", permissions={"reports": "view"}),
        )
        cls.plain = HRUser.objects.create(username="plain", password_hash="x")

    def run_md(self, report_id, params=None, purpose="screen", user=None):
        spec = registry.get_spec(report_id)
        with frozen():
            return run_report(request_for(user or self.md), spec, dict(params or {}), purpose=purpose)

    def report(self, report_id, params=None):
        """The payload with the data rows in ``rows`` and the company line in ``totals`` (see ``split_company``)."""
        return split_company(self.run_md(report_id, params).payload())

    def get(self, path, user=None, **params):
        with frozen():
            return self.client.get(path, params, **md_headers(user or self.md))

    def kpis(self, payload):
        return {s["label"]: s["value"] for s in payload["summary"]}


# ─── the pack as registered ──────────────────────────────────────────────────────────────────────────────────────────


class PackTests(SimpleTestCase):
    def test_the_seven_reports_are_registered_once_and_load_cleanly(self):
        registry.ensure_loaded()
        self.assertEqual(registry.LOAD_ERRORS, {})
        self.assertEqual(
            list(MD_REPORT_IDS),
            [
                "md-daily-brief",
                "md-weekly-workforce",
                "md-monthly-payroll",
                "md-attrition-hiring",
                "md-attendance-exceptions",
                "md-department-scorecard",
                "md-gate-discipline",
            ],
        )
        self.assertEqual(len(set(MD_REPORT_IDS)), 7)
        for spec in REPORTS:
            self.assertIs(registry.get_spec(spec.id), spec)

    def test_every_spec_id_is_unique_and_kebab_case_across_the_whole_catalog(self):
        ids = [s.id for s in registry.all_specs()]
        self.assertEqual(len(ids), len(set(ids)))
        for rid in ids:
            self.assertRegex(rid, r"^[a-z0-9]+(-[a-z0-9]+)*$", rid)

    def test_the_specs_are_executive_one_page_reports(self):
        titles = [s.title.strip().lower() for s in registry.all_specs()]
        for spec in REPORTS:
            self.assertTrue(spec.md_only, spec.id)
            self.assertEqual(spec.category, "md", spec.id)
            self.assertEqual(spec.landscape, spec.id in WIDE, spec.id)
            self.assertFalse(spec.super_admin_only, spec.id)
            self.assertTrue(0 < len(spec.description) < 220, spec.id)
            self.assertEqual(titles.count(spec.title.strip().lower()), 1, f"{spec.id}: title is not unique")
            self.assertLessEqual(
                len(spec.columns), 18, f"{spec.id}: more than 18 columns turns the PDF into an A3 sheet"
            )
            self.assertTrue(all(c.key for c in spec.columns))

    def test_every_icon_exists_in_the_frontend_icon_map(self):
        icons_file = Path(__file__).resolve().parents[2] / "frontend/src/pages/hr/report-center/report-icons.ts"
        if not icons_file.exists():
            self.skipTest("the frontend is not checked out next to the backend")
        text = icons_file.read_text(encoding="utf-8")
        block = text[text.index("const ICONS") :]
        known = set(re.findall(r"^\s{2}([A-Za-z0-9]+)[,:]", block[: block.index("};")], re.M))
        for spec in REPORTS:
            self.assertIn(spec.icon, known, f"{spec.id}: icon {spec.icon!r} is not in report-icons.ts ICONS")

    def test_filters_offer_the_documented_choices(self):
        by_id = {s.id: {f.kind: f for f in s.filters} for s in REPORTS}
        for rid in MD_REPORT_IDS:
            self.assertIn("branch", by_id[rid], f"{rid}: no unit filter")
        self.assertEqual(by_id["md-daily-brief"]["dateRange"].max_days, 1)
        self.assertEqual(by_id["md-weekly-workforce"]["dateRange"].max_days, 7)
        self.assertIn("period", by_id["md-monthly-payroll"])
        self.assertIn("department", by_id["md-attendance-exceptions"])


class RagRuleTests(SimpleTestCase):
    """The thresholds, at and either side of their edges."""

    def test_attendance_is_judged_in_points_below_the_company(self):
        company = 90.0
        self.assertEqual(MC.rag_points_below(89.1, company), MC.RAG_GREEN)  # 0.9 under
        self.assertEqual(MC.rag_points_below(89.0, company), MC.RAG_AMBER)  # exactly 1.0 under
        self.assertEqual(MC.rag_points_below(87.1, company), MC.RAG_AMBER)  # 2.9 under
        self.assertEqual(MC.rag_points_below(87.0, company), MC.RAG_RED)  # exactly 3.0 under
        self.assertEqual(MC.rag_points_below(95.0, company), MC.RAG_GREEN)  # better than the company
        self.assertIsNone(MC.rag_points_below(None, company))
        self.assertIsNone(MC.rag_points_below(88.0, None))

    def test_the_rest_are_judged_as_a_multiple_of_the_company(self):
        company = 5.0
        self.assertEqual(MC.rag_ratio_above(5.9, company), MC.RAG_GREEN)  # 1.18x
        self.assertEqual(MC.rag_ratio_above(6.0, company), MC.RAG_AMBER)  # exactly 1.2x
        self.assertEqual(MC.rag_ratio_above(7.4, company), MC.RAG_AMBER)  # 1.48x
        self.assertEqual(MC.rag_ratio_above(7.5, company), MC.RAG_RED)  # exactly 1.5x
        self.assertEqual(MC.rag_ratio_above(0.0, company), MC.RAG_GREEN)
        self.assertIsNone(MC.rag_ratio_above(None, company))
        self.assertIsNone(MC.rag_ratio_above(3.0, None))
        self.assertIsNone(MC.rag_ratio_above(3.0, 0.0), "no status when the company figure is zero")

    def test_the_note_quotes_the_thresholds_in_force(self):
        note = MC.rag_thresholds_note()
        for text in ("1 point", "3 points", "1.2 times", "1.5 times", "20 scheduled days", "20 measured breaks"):
            self.assertIn(text, note)


# ─── who may see and run them ────────────────────────────────────────────────────────────────────────────────────────


class AccessTests(World):
    def catalog_ids(self, user):
        with frozen():
            r = self.client.get("/api/reports/catalog", **md_headers(user))
        self.assertEqual(r.status_code, 200, r.content[:300])
        return r.json()

    def test_the_md_sees_all_seven_under_the_executive_category(self):
        body = self.catalog_ids(self.md)
        listed = {r["id"]: r for r in body["reports"]}
        for rid in MD_REPORT_IDS:
            self.assertIn(rid, listed)
            self.assertEqual(listed[rid]["category"], "md")
            self.assertEqual(listed[rid]["landscape"], rid in WIDE, rid)
        executive = next(c for c in body["categories"] if c["id"] == "md")
        self.assertEqual(executive["count"], 7)

    def test_a_super_admin_and_an_hr_user_with_the_reports_module_do_not_see_them(self):
        for user in (self.admin, self.clerk):
            body = self.catalog_ids(user)
            self.assertFalse({r["id"] for r in body["reports"]} & set(MD_REPORT_IDS), user.username)
            self.assertNotIn("md", {c["id"] for c in body["categories"]}, user.username)

    def test_nobody_but_the_md_can_run_or_export_them(self):
        for rid in MD_REPORT_IDS:
            for user, expected in ((self.admin, 404), (self.clerk, 404), (self.plain, 403)):
                with self.subTest(report=rid, user=user.username):
                    self.assertEqual(self.get(f"/api/reports/run/{rid}", user).status_code, expected)
                    self.assertEqual(self.get(f"/api/reports/export/{rid}", user, fmt="xlsx").status_code, expected)
            self.assertEqual(self.client.get(f"/api/reports/run/{rid}").status_code, 401)
            self.assertEqual(self.get(f"/api/reports/run/{rid}").status_code, 200, rid)

    def test_a_branch_limited_request_cannot_read_another_units_people(self):
        # the MD is company-wide, but the scope still honours a branch if one were ever set on the request
        spec = registry.get_spec("md-attendance-exceptions")
        with frozen():
            out = run_report(request_for(self.md, branch=self.unit_b.id), spec, RANGE(W))
        names = {r["employeeName"] for r in out.rows}
        self.assertNotIn("Bala Raj", names)  # Unit A
        with frozen():
            unrestricted = run_report(request_for(self.md), spec, RANGE(W))
        self.assertIn("Bala Raj", {r["employeeName"] for r in unrestricted.rows})


# ─── 1. MD Daily Brief ───────────────────────────────────────────────────────────────────────────────────────────────


class DailyBriefTests(World):
    DAY = {"dateFrom": "2026-09-09", "dateTo": "2026-09-09"}

    def test_a_past_day_unit_by_unit(self):
        body = self.report("md-daily-brief", self.DAY)
        units = by(body["rows"], "unit")
        self.assertEqual(list(units), ["Unit A", "Unit B"])
        # Wed 9 Sep, Unit A: E1 and E2 absent, E3 late, E4 half day, E6 present -> 3 in, 2 absent, 1 late, (2 + 0.5) / 5
        self.assertEqual(
            units["Unit A"],
            {
                "unit": "Unit A",
                "headcount": 5,
                "present": 3,
                "absent": 2,
                "late": 1,
                "attendancePct": 50.0,
                "visitors": 1,  # Ravi's second visit
                "outpasses": 1,  # E2's pass
                "teaOverruns": 4,  # E1 and E3 each overran twice that day
            },
        )
        self.assertEqual(
            units["Unit B"],
            {
                "unit": "Unit B",
                "headcount": 2,  # Gita leaves the next day
                "present": 2,
                "absent": 0,
                "late": 0,
                "attendancePct": 100.0,
                "visitors": 0,
                "outpasses": 0,
                "teaOverruns": 0,
            },
        )
        self.assertEqual(
            body["totals"],
            {
                "unit": "Company",
                "headcount": 7,
                "present": 5,
                "absent": 2,
                "late": 1,
                "attendancePct": 64.3,  # (4 + 0.5) / 7
                "visitors": 1,
                "outpasses": 1,
                "teaOverruns": 4,
            },
        )

    def test_the_kpi_strip_is_the_company_row(self):
        body = self.report("md-daily-brief", self.DAY)
        self.assertEqual(
            self.kpis(body),
            {
                "Headcount": 7,
                "Present": 5,
                "Absent": 2,
                "Late": 1,
                "Attendance %": 64.3,
                "Visitors": 1,
                "Outpasses": 1,
                "Tea-break overruns": 4,
            },
        )

    def test_figures_equal_the_analytics_functions_for_the_same_day_and_unit(self):
        day = date(2026, 9, 9)
        period = Period(day, day, "custom", "09 Sep 2026")
        with frozen():
            att = ATT.attendance_on_date(Scope(), day)
            gate = VIS.summary(Scope(), period)
            tea_summary = TEA.tea_summary(Scope(), period)
        body = self.report("md-daily-brief", self.DAY)
        t = body["totals"]
        self.assertEqual(t["present"], att["totals"]["present"])
        self.assertEqual(t["absent"], att["totals"]["absent"])
        self.assertEqual(t["late"], att["totals"]["late"])
        self.assertEqual(t["attendancePct"], att["totals"]["attendancePct"])
        self.assertEqual(t["visitors"], gate["visitors"]["visits"]["value"])
        self.assertEqual(t["outpasses"], gate["outpass"]["requests"]["value"])
        self.assertEqual(t["teaOverruns"], tea_summary["metrics"]["overruns"]["value"])
        for row in body["rows"]:
            unit = next(u for u in att["byUnit"] if u["name"] == row["unit"])
            self.assertEqual(
                (row["present"], row["absent"], row["attendancePct"]),
                (unit["present"], unit["absent"], unit["attendancePct"]),
            )

    def test_choosing_a_unit_narrows_every_figure(self):
        body = self.report("md-daily-brief", {**self.DAY, "branchIds": str(self.unit_b.id)})
        self.assertEqual([r["unit"] for r in body["rows"]], ["Unit B"])
        self.assertEqual(body["totals"]["headcount"], 2)
        self.assertEqual(body["totals"]["present"], 2)
        self.assertEqual(body["totals"]["visitors"], 0)
        self.assertEqual(body["totals"]["teaOverruns"], 0)
        self.assertIn("09-Sep-2026", body["filters"][0]["value"])
        self.assertEqual(body["filters"][1], {"label": "Unit", "value": "Unit B"})

    def test_today_is_provisional_and_says_so(self):
        body = self.report("md-daily-brief")  # the default date is today
        self.assertTrue(body["filters"][0]["value"].startswith("12-Oct-2026"), body["filters"])
        company = body["totals"]
        self.assertEqual(company["headcount"], 6)  # E1 E2 E3 E4 E5 E6 are on the rolls today
        self.assertEqual((company["present"], company["absent"]), (0, 6))  # nobody has punched yet: 'not in yet'
        self.assertEqual(company["attendancePct"], 0.0)
        self.assertIsNone(company["late"], "late arrivals are not known until HR's day record exists")
        text = " ".join(body["notes"])
        self.assertIn("not in yet", text)
        self.assertIn("provisional", text)

    def test_what_to_look_at_comes_from_the_modules_findings(self):
        body = self.report("md-daily-brief", self.DAY)
        lines = [n for n in body["notes"] if n.startswith("To look at: ")]
        self.assertTrue(0 < len(lines) <= 6, body["notes"])
        with frozen():
            findings = MS.attention_items(Scope(), resolve_period({"from": "2026-08-11", "to": "2026-09-09"}), TODAY)
        self.assertTrue(findings)
        for line, finding in zip(lines, findings, strict=False):
            self.assertTrue(line.startswith("To look at: " + finding["title"].rstrip(".")), (line, finding["title"]))
        severities = [f["severity"] for f in findings]
        self.assertEqual(severities, sorted(severities, key=lambda v: MS.SEVERITY_RANK[v]), "most severe first")
        self.assertNotIn("good", severities)

    def test_a_future_day_and_a_wider_range_are_refused_with_a_reason(self):
        r = self.get("/api/reports/run/md-daily-brief", dateFrom="2026-10-13", dateTo="2026-10-13")
        self.assertEqual(r.status_code, 400)
        self.assertIn("has not happened yet", r.json()["message"])
        r = self.get("/api/reports/run/md-daily-brief", dateFrom="2026-09-08", dateTo="2026-09-09")
        self.assertEqual(r.status_code, 400)
        self.assertIn("too wide", r.json()["message"])


# ─── 2. Weekly Workforce Summary ─────────────────────────────────────────────────────────────────────────────────────


class WeeklyWorkforceTests(World):
    def test_each_department_with_its_change_on_the_week_before(self):
        body = self.report("md-weekly-workforce", RANGE(W))
        rows = by(body["rows"])
        self.assertEqual(list(rows), ["Accounts", "Cutting", "Stitching"])
        self.assertEqual(
            rows["Stitching"],
            {
                "department": "Stitching",
                "headcount": 3,
                "headcountChange": 0,
                "attendancePct": 61.1,  # (10 + 0.5 x 2) / 18
                "attendanceChange": -22.2,  # 61.1 - 83.3
                "absenteeismPct": 27.8,  # 5 / 18
                "absenteeismChange": 14.5,  # 27.8 - 13.3
                "latePct": 8.3,  # 1 / 12
                "lateChange": 8.3,
                "overtimeHours": 1.5,  # E1's 90 minutes; E2's rejected 45 do not count
                "overtimeChange": 0.5,  # 1.5 - 1.0
                "joiners": 0,
                "joinersChange": 0,
                "leavers": 0,
                "leaversChange": 0,
            },
        )
        self.assertEqual(
            rows["Cutting"],
            {
                "department": "Cutting",
                "headcount": 2,
                "headcountChange": 1,
                "attendancePct": 100.0,
                "attendanceChange": 0.0,
                "absenteeismPct": 0.0,
                "absenteeismChange": 0.0,
                "latePct": 44.4,  # 4 / 9
                "lateChange": 44.4,
                "overtimeHours": 0.5,
                "overtimeChange": 0.5,
                "joiners": 1,  # Farid, Wed 9 Sep
                "joinersChange": 1,
                "leavers": 0,
                "leaversChange": 0,
            },
        )
        self.assertEqual(
            rows["Accounts"],
            {
                "department": "Accounts",
                "headcount": 1,
                "headcountChange": -1,
                "attendancePct": 100.0,
                "attendanceChange": 0.0,
                "absenteeismPct": 0.0,
                "absenteeismChange": 0.0,
                "latePct": 0.0,
                "lateChange": 0.0,
                "overtimeHours": 0.0,
                "overtimeChange": 0.0,
                "joiners": 0,
                "joinersChange": 0,
                "leavers": 1,  # Gita, Thu 10 Sep
                "leaversChange": 1,
            },
        )

    def test_the_company_row_and_kpis(self):
        body = self.report("md-weekly-workforce", RANGE(W))
        self.assertEqual(
            body["totals"],
            {
                "department": "Company",
                "headcount": 6,
                "headcountChange": 0,
                "attendancePct": 81.1,  # 30 / 37
                "attendanceChange": -10.3,  # 81.1 - 91.4
                "absenteeismPct": 13.5,  # 5 / 37
                "absenteeismChange": 6.6,  # 13.5 - 6.9
                "latePct": 16.1,  # 5 / 31
                "lateChange": 16.1,
                "overtimeHours": 2.0,
                "overtimeChange": 1.0,
                "joiners": 1,
                "joinersChange": 1,
                "leavers": 1,
                "leaversChange": 1,
            },
        )
        self.assertEqual(
            self.kpis(body),
            {
                "Headcount": 6,
                "Attendance %": 81.1,
                "Absenteeism %": 13.5,
                "Late %": 16.1,
                "Overtime hours": 2.0,
                "Joiners": 1,
                "Leavers": 1,
            },
        )

    def test_figures_equal_the_attendance_and_employees_pages_for_the_same_week(self):
        with frozen():
            page = ATT.attendance_by_department(Scope(), PERIOD_W, limit=50)
            previous = ATT.attendance_by_department(Scope(), PERIOD_P, limit=50)
            summary = ATT.attendance_summary(Scope(), PERIOD_W)
            movement = EMP.summary(Scope(), PERIOD_W, today=TODAY)
        body = self.report("md-weekly-workforce", RANGE(W))
        rows = by(body["rows"])
        for dept in page["departments"]:
            r = rows[dept["name"]]
            self.assertEqual(r["attendancePct"], dept["attendancePct"], dept["name"])
            self.assertEqual(r["absenteeismPct"], dept["absenteeismPct"], dept["name"])
            self.assertEqual(r["latePct"], dept["latePct"], dept["name"])
            self.assertEqual(r["overtimeHours"], dept["overtimeHours"], dept["name"])
            self.assertEqual(r["attendanceChange"], dept["delta"]["attendancePct"], dept["name"])
            self.assertEqual(r["absenteeismChange"], dept["delta"]["absenteeismPct"], dept["name"])
            self.assertEqual(r["latePct"] - dept["previous"]["latePct"], r["lateChange"], dept["name"])
        for dept in previous["departments"]:
            self.assertEqual(
                round(rows[dept["name"]]["overtimeHours"] - dept["overtimeHours"], 1),
                rows[dept["name"]]["overtimeChange"],
            )
        t = body["totals"]
        for key, metric in (
            ("attendancePct", "attendancePct"),
            ("absenteeismPct", "absenteeismPct"),
            ("latePct", "latePct"),
            ("overtimeHours", "overtimeHours"),
        ):
            self.assertEqual(t[key], summary["metrics"][metric]["value"], key)
        self.assertEqual(t["joiners"], movement["joiners"]["count"])
        self.assertEqual(t["leavers"], movement["leavers"]["count"])
        self.assertEqual(t["headcount"], movement["headcount"]["closing"])

    def test_a_week_that_includes_today_is_cut_at_yesterday_everywhere(self):
        # Mon 12 Oct is today: the week is Wed 7 .. Mon 12 Oct as asked, but only 7 .. 11 Oct are complete days
        body = self.report("md-weekly-workforce", {"dateFrom": "2026-10-06", "dateTo": "2026-10-12"})
        text = " ".join(body["notes"])
        self.assertIn("includes today", text)
        self.assertIn("06 Oct 2026 to 11 Oct 2026", text)
        self.assertIn("previous 6 days (30 Sep 2026 to 05 Oct 2026)", text)

    def test_a_week_with_no_completed_day_is_an_empty_report_with_a_reason(self):
        body = self.report("md-weekly-workforce", {"dateFrom": "2026-10-12", "dateTo": "2026-10-12"})
        self.assertEqual(body["rows"], [])
        self.assertIn("no completed day yet", body["notes"][0])

    def test_a_wider_week_is_refused_and_a_unit_narrows_the_report(self):
        r = self.get("/api/reports/run/md-weekly-workforce", dateFrom="2026-09-01", dateTo="2026-09-13")
        self.assertEqual(r.status_code, 400)
        body = self.report("md-weekly-workforce", {**RANGE(W), "branchIds": str(self.unit_b.id)})
        self.assertEqual([r["department"] for r in body["rows"]], ["Accounts"])
        self.assertEqual(body["totals"]["headcount"], 1)

    def test_the_notes_state_the_data_caveats(self):
        text = " ".join(self.report("md-weekly-workforce", RANGE(W))["notes"])
        for part in (
            "Every change compares with the previous 7 days (31 Aug 2026 to 06 Sep 2026)",
            "no headcount history",
            "day records",
        ):
            self.assertIn(part, text)


# ─── 3. Monthly Payroll Summary ──────────────────────────────────────────────────────────────────────────────────────


class MonthlyPayrollTests(World):
    def test_september_by_department(self):
        body = self.report("md-monthly-payroll", {"period": "2026-09"})
        rows = by(body["rows"])
        self.assertEqual(
            list(rows), ["Stitching", "Accounts", "Cutting"]
        )  # biggest cost first, as the Payroll page ranks
        self.assertEqual(
            rows["Stitching"],
            {
                "department": "Stitching",
                "headcount": 2,
                "grossPay": 51000.0,  # 26,000 + 1,000 overtime + 24,000
                "netPay": 49440.0,  # less E1's PF 1,560
                "deductions": 1560.0,
                "overtimePay": 1000.0,
                "costPerHead": 25500.0,
                "grossChange": 5000.0,  # August: 46,000
                "grossChangePct": 10.9,
            },
        )
        self.assertEqual(
            rows["Accounts"],
            {
                "department": "Accounts",
                "headcount": 2,
                "grossPay": 42000.0,
                "netPay": 40200.0,
                "deductions": 1800.0,
                "overtimePay": 0.0,
                "costPerHead": 21000.0,
                "grossChange": -28000.0,  # August: 70,000
                "grossChangePct": -40.0,
            },
        )
        self.assertEqual(rows["Cutting"]["grossPay"], 27000.0)
        self.assertEqual(rows["Cutting"]["grossChange"], 9000.0)  # August: 18,000
        self.assertEqual(rows["Cutting"]["grossChangePct"], 50.0)
        self.assertEqual(rows["Cutting"]["headcount"], 2)

    def test_the_company_totals_and_kpi_strip(self):
        body = self.report("md-monthly-payroll", {"period": "2026-09"})
        self.assertEqual(
            body["totals"],
            {
                "department": "Company",
                "headcount": 6,
                "grossPay": 120000.0,
                "netPay": 116640.0,
                "deductions": 3360.0,
                "overtimePay": 1000.0,
                "costPerHead": 20000.0,
                "grossChange": -14000.0,  # 134,000 in August
                "grossChangePct": -10.4,
            },
        )
        self.assertEqual(
            self.kpis(body),
            {
                "People paid": 6,
                "Gross pay": 120000.0,
                "Net pay": 116640.0,
                "Deductions": 3360.0,
                "Overtime cost": 1000.0,
                "Cost per head": 20000.0,
                "Gross pay vs last month": -10.4,
                "Payroll status": "Part paid",
            },
        )
        rows = body["rows"]
        self.assertEqual(sum(r["grossPay"] for r in rows), body["totals"]["grossPay"])
        self.assertEqual(sum(r["deductions"] for r in rows), body["totals"]["deductions"])
        self.assertEqual(sum(r["headcount"] for r in rows), body["totals"]["headcount"])

    def test_figures_equal_the_payroll_page_to_the_paisa(self):
        with frozen():
            page = PAY.payroll_departments(Scope(), "2026-09", 25)
            summary = PAY.payroll_summary(Scope(), "2026-09")
        body = self.report("md-monthly-payroll", {"period": "2026-09"})
        rows = by(body["rows"])
        self.assertEqual(len(rows), page["departmentsTotal"])
        for dept in page["departments"]:
            r = rows[dept["name"]]
            for mine, theirs in (
                ("headcount", "headcount"),
                ("grossPay", "grossPay"),
                ("netPay", "netPay"),
                ("overtimePay", "overtimePay"),
                ("costPerHead", "costPerHead"),
            ):
                self.assertEqual(r[mine], dept[theirs], (dept["name"], mine))
            self.assertEqual(r["grossChange"], dept["change"]["grossPay"]["abs"])
            self.assertEqual(r["grossChangePct"], dept["change"]["grossPay"]["pct"])
        t, totals = body["totals"], summary["totals"]
        self.assertEqual(
            (t["grossPay"], t["netPay"], t["deductions"], t["overtimePay"], t["costPerHead"], t["headcount"]),
            (
                totals["grossPay"],
                totals["netPay"],
                totals["totalDeductions"],
                totals["overtimePay"],
                totals["costPerHead"],
                totals["headcount"],
            ),
        )

    def test_the_notes_carry_the_status_and_the_main_drivers_of_the_bridge(self):
        body = self.report("md-monthly-payroll", {"period": "2026-09"})
        text = "\n".join(body["notes"])
        self.assertIn("Payroll status for Sep 2026: Part paid (2 of 6 slips marked paid).", text)
        self.assertIn("Gross pay moved from ₹1,34,000 (Aug 2026) to ₹1,20,000 (Sep 2026): -₹14,000 (-10.4%).", text)
        # Aug -> Sep: Gita's and Bala's pay changes carry no saved calculation, so they sit under Other (-28,000 + 4,000)
        self.assertIn(
            "Main drivers: Other -₹24,000 (2 people); Joined payroll +₹9,000 (1 person); Overtime +₹1,000 (1 person).",
            text,
        )
        self.assertIn("salary slips", text)
        with frozen():
            bridge = PAY.payroll_bridge(Scope(), "2026-09")
        self.assertEqual(bridge["mainDriver"]["label"], "Other")
        self.assertEqual(sum(s["amount"] for s in bridge["steps"]), bridge["change"]["abs"])

    def test_a_month_without_payroll_is_a_clear_empty_report(self):
        body = self.report("md-monthly-payroll", {"period": "2026-07"})
        self.assertEqual(body["rows"], [])
        self.assertIsNone(body["totals"])
        self.assertTrue(any("No salary slips exist for Jul 2026" in n for n in body["notes"]), body["notes"])
        self.assertIsNone(self.kpis(body)["Gross pay"])

    def test_a_unit_narrows_the_month(self):
        body = self.report("md-monthly-payroll", {"period": "2026-09", "branchIds": str(self.unit_b.id)})
        self.assertEqual([r["department"] for r in body["rows"]], ["Accounts"])
        self.assertEqual(body["totals"]["grossPay"], 42000.0)

    def test_a_bad_month_is_a_400(self):
        r = self.get("/api/reports/run/md-monthly-payroll", period="2026-13")
        self.assertEqual(r.status_code, 400)


# ─── 4. Attrition & Hiring Review ────────────────────────────────────────────────────────────────────────────────────


class AttritionHiringTests(World):
    def test_september_by_department(self):
        body = self.report("md-attrition-hiring", RANGE(SEPTEMBER))
        rows = by(body["rows"])
        self.assertEqual(list(rows), ["Accounts", "Cutting", "Stitching"])  # highest attrition first
        self.assertEqual(
            rows["Accounts"],
            {
                "department": "Accounts",
                "opening": 2,  # Esha and Gita on 31 Aug
                "joiners": 0,
                "leavers": 1,  # Gita
                "closing": 1,
                "attritionPct": 66.7,  # 1 / ((2 + 1) / 2)
                "openPositions": 1,  # Accountant
                "pendingResignations": 0,
            },
        )
        self.assertEqual(
            rows["Cutting"],
            {
                "department": "Cutting",
                "opening": 1,
                "joiners": 1,
                "leavers": 0,
                "closing": 2,
                "attritionPct": 0.0,
                "openPositions": 0,  # the Cutter job is closed
                "pendingResignations": 0,
            },
        )
        self.assertEqual(
            rows["Stitching"],
            {
                "department": "Stitching",
                "opening": 3,
                "joiners": 0,
                "leavers": 0,
                "closing": 3,
                "attritionPct": 0.0,
                "openPositions": 1,  # Machine Operator
                "pendingResignations": 1,  # Bala's
            },
        )
        for r in rows.values():
            self.assertEqual(r["opening"] + r["joiners"] - r["leavers"], r["closing"], r["department"])

    def test_the_company_row_kpis_and_early_attrition_note(self):
        body = self.report("md-attrition-hiring", RANGE(SEPTEMBER))
        self.assertEqual(
            body["totals"],
            {
                "department": "Company",
                "opening": 6,
                "joiners": 1,
                "leavers": 1,
                "closing": 6,
                "attritionPct": 16.7,  # 1 / 6
                "openPositions": 2,
                "pendingResignations": 1,
            },
        )
        kpis = self.kpis(body)
        # the exact rate scaled to a year: 1 leaver / 6 average = 16.67 % in 30 days -> 16.67 x 365 / 30 = 202.8
        self.assertEqual(kpis["Attrition, annualised %"], 202.8)
        with frozen():
            self.assertEqual(
                kpis["Attrition, annualised %"],
                EMP.summary(Scope(), PERIOD_SEP, today=TODAY)["attrition"]["annualisedPct"],
            )
        self.assertEqual(kpis["Left within 90 days"], 1)
        text = "\n".join(body["notes"])
        self.assertIn(
            "Early attrition: 1 of 1 leaver (100.0%) left within 90 days of joining: Gita Nair (Accounts, 71 days).",
            text,
        )
        self.assertIn("leavers divided by the average of the opening and closing headcount", text)
        self.assertIn("no headcount history", text)

    def test_figures_equal_the_employees_and_recruitment_pages(self):
        with frozen():
            page = EMP.attrition(Scope(), PERIOD_SEP, limit=25, today=TODAY)
            summary = EMP.summary(Scope(), PERIOD_SEP, today=TODAY)
            hiring = REC.summary(Scope(), PERIOD_SEP, today=TODAY)["current"]
        body = self.report("md-attrition-hiring", RANGE(SEPTEMBER))
        rows = by(body["rows"])
        for dept in page["byDepartment"]:
            r = rows[dept["label"]]
            self.assertEqual(
                (r["leavers"], r["opening"], r["closing"], r["attritionPct"]),
                (dept["leavers"], dept["opening"], dept["closing"], dept["attritionPct"]),
            )
        t = body["totals"]
        self.assertEqual(t["attritionPct"], summary["attrition"]["pct"])
        self.assertEqual((t["joiners"], t["leavers"]), (summary["joiners"]["count"], summary["leavers"]["count"]))
        self.assertEqual(
            (t["opening"], t["closing"]), (summary["headcount"]["opening"], summary["headcount"]["closing"])
        )
        self.assertEqual(t["openPositions"], hiring["openPositions"])
        self.assertEqual(t["pendingResignations"], hiring["resignationsPending"])
        self.assertEqual(sum(r["openPositions"] for r in rows.values()), t["openPositions"])
        self.assertEqual(sum(r["pendingResignations"] for r in rows.values()), t["pendingResignations"])

    def test_a_period_that_has_not_started_is_an_empty_report_with_a_reason(self):
        body = self.report("md-attrition-hiring", {"dateFrom": "2026-11-01", "dateTo": "2026-11-30"})
        self.assertEqual(body["rows"], [])
        self.assertIn("has not started yet", body["notes"][0])

    def test_a_period_that_reaches_past_today_is_cut_at_today(self):
        body = self.report("md-attrition-hiring", {"dateFrom": "2026-10-01", "dateTo": "2026-10-31"})
        self.assertTrue(any("cut at today, 12 Oct 2026" in n for n in body["notes"]), body["notes"])
        self.assertEqual(body["totals"]["joiners"], 0)

    def test_a_period_crossing_a_year_boundary(self):
        Employee.objects.filter(pk=self.e6.pk).update(join_date="2026-01-02")
        Employee.objects.create(
            employee_code="R090",
            first_name="New",
            last_name="Year",
            department=self.cutting,
            branch=self.unit_a,
            employment_type="staff",
            join_date="2025-12-31",
        )
        Employee.objects.create(
            employee_code="R091",
            first_name="Next",
            last_name="Year",
            department=self.cutting,
            branch=self.unit_a,
            employment_type="staff",
            join_date="2026-01-01",
        )
        body = self.report("md-attrition-hiring", {"dateFrom": "2025-12-31", "dateTo": "2026-01-02"})
        cutting = by(body["rows"])["Cutting"]
        self.assertEqual(cutting["joiners"], 3)  # 31 Dec, 1 Jan and 2 Jan are all inside the period
        self.assertEqual(cutting["opening"] + cutting["joiners"] - cutting["leavers"], cutting["closing"])


# ─── 5. Attendance Exceptions ────────────────────────────────────────────────────────────────────────────────────────


class AttendanceExceptionsTests(World):
    def test_the_people_and_their_evidence(self):
        body = self.report("md-attendance-exceptions", RANGE(W))
        self.assertEqual(
            body["rows"],
            [
                {
                    "finding": "Long unexplained absence",
                    "employeeCode": "R002",
                    "employeeName": "Bala Raj",
                    "department": "Stitching",
                    "unit": "Unit A",
                    "days": 3,
                    "outOf": None,
                    "ratePct": None,
                    "evidence": "Absent 08 Sep to 10 Sep; last at work 11 Sep",
                },
                {
                    "finding": "Chronic absentee",
                    "employeeCode": "R002",
                    "employeeName": "Bala Raj",
                    "department": "Stitching",
                    "unit": "Unit A",
                    "days": 3,
                    "outOf": 6,
                    "ratePct": 50.0,
                    "evidence": "Absent 10 Sep, 09 Sep, 08 Sep",
                },
                {
                    "finding": "Habitual late-comer",
                    "employeeCode": "R003",
                    "employeeName": "Chitra Devi",
                    "department": "Cutting",
                    "unit": "Unit A",
                    "days": 4,
                    "outOf": 5,
                    "ratePct": 80.0,
                    "evidence": "Late 11 Sep, 09 Sep, 08 Sep, 07 Sep; 35 minutes late on average",
                },
            ],
        )

    def test_kpis_and_thresholds(self):
        body = self.report("md-attendance-exceptions", RANGE(W))
        self.assertEqual(
            self.kpis(body),
            {
                "Long unexplained absences": 1,
                "Still absent on the last recorded day": 0,
                "Chronic absentees": 1,
                "Habitual late-comers": 1,
            },
        )
        text = " ".join(body["notes"])
        self.assertIn("3 or more absences in a row", text)
        self.assertIn("3 or more unplanned absence days and at least 10% of their scheduled days", text)
        self.assertIn("late on 4 or more days and on at least 15% of the days they worked", text)
        self.assertIn("Today is provisional", text)

    def test_the_people_are_the_attendance_pages_exceptions_for_the_same_period(self):
        with frozen():
            page = ATT.attendance_exceptions(Scope(), PERIOD_W, limit=25)
        body = self.report("md-attendance-exceptions", RANGE(W))
        names = {(r["finding"], r["employeeName"]) for r in body["rows"]}
        expected = (
            {("Long unexplained absence", r["name"]) for r in page["longAbsences"]["rows"]}
            | {("Chronic absentee", r["name"]) for r in page["chronicAbsentees"]["rows"]}
            | {("Habitual late-comer", r["name"]) for r in page["habitualLate"]["rows"]}
        )
        self.assertEqual(names, expected)

    def test_a_department_filter_narrows_the_people(self):
        body = self.report("md-attendance-exceptions", {**RANGE(W), "departmentIds": str(self.cutting.id)})
        self.assertEqual({r["employeeName"] for r in body["rows"]}, {"Chitra Devi"})

    def test_a_clean_period_says_no_one_met_the_rules(self):
        body = self.report("md-attendance-exceptions", RANGE(P))
        self.assertEqual(body["rows"], [])
        self.assertTrue(any("No one met these rules" in n for n in body["notes"]), body["notes"])

    def test_each_list_is_capped_and_the_report_says_so(self):
        # five more people with three unexplained absences in a row: 6 chronic absentees, 6 long absences
        extra = []
        for n in range(5):
            emp = make_employee(f"R1{n}0", f"Extra{n}", "Absent", self.stitching, self.unit_a)
            EmployeeShiftAssignment.objects.create(employee=emp, shift=self.shift, effective_from=date(2026, 1, 1))
            mark(emp, date(2026, 9, 7), "PPPAAAO")
            extra.append(emp)
        body = self.report("md-attendance-exceptions", {**RANGE(W), "perList": "5"})
        findings = [r["finding"] for r in body["rows"]]
        self.assertEqual(findings.count("Long unexplained absence"), 5)
        self.assertEqual(findings.count("Chronic absentee"), 5)
        text = " ".join(body["notes"])
        self.assertIn("Each list is capped at 5 people", text)
        self.assertIn("long unexplained absences: showing 5 of 6", text)
        self.assertIn("chronic absentees: showing 5 of 6", text)
        self.assertEqual(self.kpis(body)["Long unexplained absences"], 6)  # the count is the real one, not the cap

    def test_the_row_limit_is_respected(self):
        spec = registry.get_spec("md-attendance-exceptions")
        with frozen():
            ctx = ReportContext(
                request=request_for(self.md),
                spec=spec,
                params={"date_from": date(2026, 9, 7), "date_to": date(2026, 9, 13), "perList": 15},
                row_limit=2,
            )
            result = spec.run(ctx)
        self.assertEqual(len(result.rows), 2)


# ─── 6. Department Scorecard ─────────────────────────────────────────────────────────────────────────────────────────


class ScorecardTests(World):
    def test_every_department_against_the_company(self):
        body = self.report("md-department-scorecard", RANGE(SPAN))
        rows = by(body["rows"])
        self.assertEqual(list(rows), ["Stitching", "Cutting", "Accounts"])  # most Reds first
        stitching = rows["Stitching"]
        self.assertEqual(
            {k: stitching[k] for k in ("attendancePct", "absenteeismPct", "latePct", "overtimeHours", "costPerHead")},
            {
                "attendancePct": 71.2,  # (22 + 1.5) / 33
                "absenteeismPct": 21.2,  # 7 / 33
                "latePct": 4.0,  # 1 / 25
                "overtimeHours": 2.5,  # 1.5 + 1.0
                "costPerHead": 25500.0,  # September, the latest closed month
            },
        )
        self.assertEqual(
            {k: stitching[k] for k in ("attritionPct", "teaOverrunPct", "outpassHours")},
            {"attritionPct": 0.0, "teaOverrunPct": 20.0, "outpassHours": 1.83},
        )
        self.assertEqual(
            {k: stitching[k] for k in MD_RAG},
            {
                "attendanceRag": "Red",  # 14.4 points under the company's 85.6
                "absenteeismRag": "Red",  # 21.2 is 2.0x the company's 10.6
                "lateRag": "Green",
                "overtimeRag": "Red",  # 0.83 hours a head against the company's 0.5
                "costRag": "Amber",  # 25,500 is 1.275x the company's 20,000
                "attritionRag": None,  # a team averaging 3 people: too small to judge
                "teaRag": "Green",  # 20.0 against 22.5
                "outpassRag": "Amber",  # 0.61 hours a head against 0.43
            },
        )
        self.assertEqual(stitching["redFlags"], 3)

    def test_small_samples_get_no_status_and_the_other_departments(self):
        rows = by(self.report("md-department-scorecard", RANGE(SPAN))["rows"])
        cutting, accounts = rows["Cutting"], rows["Accounts"]
        # Cutting has 13 scheduled days (fewer than 20): its attendance figures show, its statuses do not
        self.assertEqual((cutting["attendancePct"], cutting["absenteeismPct"], cutting["latePct"]), (100.0, 0.0, 30.8))
        self.assertEqual((cutting["attendanceRag"], cutting["absenteeismRag"], cutting["lateRag"]), (None, None, None))
        self.assertEqual((cutting["teaOverrunPct"], cutting["teaRag"]), (50.0, "Red"))  # 50.0 against 22.5
        self.assertEqual(cutting["redFlags"], 1)
        self.assertEqual(
            (accounts["attendanceRag"], accounts["absenteeismRag"], accounts["lateRag"], accounts["teaRag"]),
            ("Green", "Green", "Green", "Green"),
        )
        self.assertIsNone(accounts["outpassHours"], "a pass nobody scanned back in has no length")
        self.assertIsNone(accounts["outpassRag"])
        self.assertEqual(accounts["redFlags"], 0)

    def test_the_threshold_for_small_samples_is_the_documented_one(self):
        with mock.patch.object(scorecard_module, "MIN_SCHEDULED_DAYS", 10):
            cutting = by(self.report("md-department-scorecard", RANGE(SPAN))["rows"])["Cutting"]
        self.assertEqual(
            (cutting["attendanceRag"], cutting["absenteeismRag"], cutting["lateRag"]), ("Green", "Green", "Red")
        )
        self.assertEqual(cutting["redFlags"], 2)  # late (30.8 against 8.6) and tea

    def test_the_company_row_kpis_and_the_notes_document_the_thresholds(self):
        body = self.report("md-department-scorecard", RANGE(SPAN))
        self.assertEqual(
            body["totals"],
            {
                "department": "Company",
                "attendancePct": 85.6,  # 56.5 / 66
                "absenteeismPct": 10.6,  # 7 / 66
                "latePct": 8.6,  # 5 / 58
                "overtimeHours": 3.0,
                "costPerHead": 20000.0,
                "attritionPct": 16.7,
                "teaOverrunPct": 22.5,  # 18 / 80
                "outpassHours": 2.58,  # 155 minutes
                **dict.fromkeys(MD_RAG),  # the company line carries no status
                "redFlags": None,
            },
        )
        kpis = self.kpis(body)
        self.assertEqual((kpis["Departments"], kpis["Departments with a Red"]), (3, 2))
        text = " ".join(body["notes"])
        self.assertIn("Payroll cost per head is for Sep 2026, the latest closed month", text)
        self.assertIn("Amber from 1.2 times the company figure, Red from 1.5 times", text)
        self.assertIn("Amber from 1 point under the company's, Red from 3 points under", text)

    def test_every_measure_equals_the_page_it_comes_from(self):
        with frozen():
            att = ATT.attendance_by_department(Scope(), PERIOD_SPAN, limit=50)
            tea_page = TEA.tea_departments(Scope(), PERIOD_SPAN, by="department", limit=25)
            out_page = VIS.outpass_breakdown(Scope(), PERIOD_SPAN, limit=25)
            pay_page = PAY.payroll_departments(Scope(), "2026-09", 25)
            attrition = EMP.attrition(Scope(), PERIOD_SPAN, limit=25, today=TODAY)
        rows = by(self.report("md-department-scorecard", RANGE(SPAN))["rows"])
        for dept in att["departments"]:
            r = rows[dept["name"]]
            self.assertEqual(
                (r["attendancePct"], r["absenteeismPct"], r["latePct"]),
                (dept["attendancePct"], dept["absenteeismPct"], dept["latePct"]),
            )
            self.assertEqual(r["overtimeHours"], dept["overtimeHours"])
        for dept in tea_page["rows"]:
            self.assertEqual(rows[dept["label"]]["teaOverrunPct"], dept["overrunPct"], dept["label"])
        for dept in out_page["byDepartment"]:
            minutes = dept["minutesOut"]
            expected = None if minutes is None else round(minutes / 60, 2)
            self.assertEqual(rows[dept["department"]]["outpassHours"], expected, dept["department"])
        for dept in pay_page["departments"]:
            self.assertEqual(rows[dept["name"]]["costPerHead"], dept["costPerHead"], dept["name"])
        for dept in attrition["byDepartment"]:
            self.assertEqual(rows[dept["label"]]["attritionPct"], dept["attritionPct"], dept["label"])

    def test_no_payroll_yet_blanks_the_cost_column_and_says_so(self):
        SalarySlip.objects.all().delete()
        Payroll.objects.all().delete()
        body = self.report("md-department-scorecard", RANGE(SPAN))
        self.assertTrue(all(r["costPerHead"] is None and r["costRag"] is None for r in body["rows"]))
        self.assertTrue(any("No payroll has been processed yet" in n for n in body["notes"]), body["notes"])

    def test_a_period_with_no_completed_day_blanks_attendance_not_the_rest(self):
        body = self.report("md-department-scorecard", {"dateFrom": "2026-10-12", "dateTo": "2026-10-12"})
        for r in body["rows"]:
            self.assertIsNone(r["attendancePct"])
            self.assertIsNone(r["attendanceRag"])
        self.assertTrue(any("no completed day yet" in n for n in body["notes"]), body["notes"])


MD_RAG = (
    "attendanceRag",
    "absenteeismRag",
    "lateRag",
    "overtimeRag",
    "costRag",
    "attritionRag",
    "teaRag",
    "outpassRag",
)


class SameNameDepartmentsTests(TestCase):
    """A department name used in two units is one department of the company in the scorecard (as on the pages)."""

    @classmethod
    def setUpTestData(cls):
        cls.md = make_md()
        cls.u1 = Branch.objects.create(name="North", code="N1")
        cls.u2 = Branch.objects.create(name="South", code="S1")
        cls.d1 = Department.objects.create(name="Stitching", branch=cls.u1)
        cls.d2 = Department.objects.create(name="Stitching", branch=cls.u2)
        cls.a = make_employee("S01", "Ann", "North", cls.d1, cls.u1)
        cls.b = make_employee("S02", "Ben", "South", cls.d2, cls.u2)
        shift = ShiftTemplate.objects.create(
            name="General", shift_type="staff", start_time=time(9), end_time=time(18), grace_period_minutes=15
        )
        for emp in (cls.a, cls.b):
            EmployeeShiftAssignment.objects.create(employee=emp, shift=shift, effective_from=date(2026, 1, 1))
        mark(cls.a, date(2026, 9, 7), "PPPPPPO")
        mark(cls.b, date(2026, 9, 7), "PPAAPPO")
        slip(cls.a, (2026, 9), 20000)
        slip(cls.b, (2026, 9), 30000)

    def test_one_row_with_the_units_added_together(self):
        with frozen():
            out = run_report(request_for(self.md), registry.get_spec("md-department-scorecard"), RANGE(W))
        rows = data_rows(out.rows)
        self.assertEqual([r["department"] for r in rows], ["Stitching"])
        self.assertEqual(rows[0]["attendancePct"], 83.3)  # 10 of 12 scheduled days
        self.assertEqual(rows[0]["costPerHead"], 25000.0)  # (20,000 + 30,000) / 2 people

    def test_the_payroll_report_keeps_the_units_apart_and_names_them(self):
        with frozen():
            out = run_report(request_for(self.md), registry.get_spec("md-monthly-payroll"), {"period": "2026-09"})
        self.assertEqual([r["department"] for r in data_rows(out.rows)], ["Stitching (South)", "Stitching (North)"])

    def test_the_attrition_review_labels_the_departments_as_the_employees_page_does(self):
        with frozen():
            out = run_report(request_for(self.md), registry.get_spec("md-attrition-hiring"), RANGE(SEPTEMBER))
        self.assertEqual(
            sorted(r["department"] for r in data_rows(out.rows)), ["Stitching (North)", "Stitching (South)"]
        )


class NoDepartmentTests(TestCase):
    """The modules each spell 'no department' their own way (Unassigned / No department); the reports use one."""

    @classmethod
    def setUpTestData(cls):
        cls.md = make_md()
        shift = ShiftTemplate.objects.create(
            name="General", shift_type="staff", start_time=time(9), end_time=time(18), grace_period_minutes=15
        )
        cls.z = make_employee("Z01", "Zed", "Nobody", None, None)
        EmployeeShiftAssignment.objects.create(employee=cls.z, shift=shift, effective_from=date(2026, 1, 1))
        mark(cls.z, date(2026, 9, 7), "PPPPPPO")
        slip(cls.z, (2026, 9), 10000)
        TeaBreakRule.objects.create(pk=1, allowed_minutes=15)
        tea(cls.z, [10] * 20)
        make_pass(cls.z, ist(9, 8, 10, 50), exited=ist(9, 8, 11, 0), entered=ist(9, 8, 11, 30))

    def run_report(self, rid, params):
        with frozen():
            return split_company(run_report(request_for(self.md), registry.get_spec(rid), params).payload())

    def test_one_row_called_no_department_in_every_report(self):
        weekly = self.run_report("md-weekly-workforce", RANGE(W))
        self.assertEqual([r["department"] for r in weekly["rows"]], ["No department"])
        self.assertEqual(weekly["rows"][0]["attendancePct"], 100.0)
        card = self.run_report("md-department-scorecard", RANGE(W))
        row = card["rows"][0]
        self.assertEqual([r["department"] for r in card["rows"]], ["No department"])
        self.assertEqual(
            (row["attendancePct"], row["costPerHead"], row["teaOverrunPct"], row["outpassHours"]),
            (100.0, 10000.0, 0.0, 0.5),
        )
        gate = self.run_report("md-gate-discipline", RANGE(W))
        row = gate["rows"][0]
        self.assertEqual([r["department"] for r in gate["rows"]], ["No department"])
        self.assertEqual((row["outpasses"], row["hoursOut"], row["teaOverruns"]), (1, 0.5, 0))

    def test_an_employee_with_no_unit_is_the_no_unit_row_of_the_daily_brief(self):
        brief = self.run_report("md-daily-brief", {"dateFrom": "2026-09-08", "dateTo": "2026-09-08"})
        self.assertEqual([r["unit"] for r in brief["rows"]], ["No unit"])
        self.assertEqual((brief["rows"][0]["headcount"], brief["rows"][0]["present"]), (1, 1))


# ─── 7. Gate & Discipline Review ─────────────────────────────────────────────────────────────────────────────────────


class GateDisciplineTests(World):
    def test_by_department(self):
        body = self.report("md-gate-discipline", RANGE(SPAN))
        rows = by(body["rows"])
        self.assertEqual(list(rows), ["Stitching", "Cutting", "Accounts", "Host not matched to an employee"])
        self.assertEqual(
            rows["Stitching"],
            {
                "department": "Stitching",
                "visits": 3,  # Ravi twice, the late guest
                "outpasses": 4,  # E1 x3, E2
                "hoursOut": 1.83,  # 110 minutes
                "notReturned": 1,  # E2
                "teaOverruns": 8,
                "teaOverrunPct": 20.0,
                "teaMinutesLost": 40,
            },
        )
        self.assertEqual(
            rows["Cutting"],
            {
                "department": "Cutting",
                "visits": 1,
                "outpasses": 1,
                "hoursOut": 0.75,
                "notReturned": 0,
                "teaOverruns": 10,
                "teaOverrunPct": 50.0,
                "teaMinutesLost": 100,
            },
        )
        self.assertEqual(
            rows["Accounts"],
            {
                "department": "Accounts",
                "visits": 1,
                "outpasses": 1,
                "hoursOut": None,  # the pass was never used
                "notReturned": 0,
                "teaOverruns": 0,
                "teaOverrunPct": 0.0,
                "teaMinutesLost": 0,
            },
        )
        self.assertEqual(rows["Host not matched to an employee"]["visits"], 1)

    def test_the_company_row_and_kpis(self):
        body = self.report("md-gate-discipline", RANGE(SPAN))
        self.assertEqual(
            body["totals"],
            {
                "department": "Company",
                "visits": 6,
                "outpasses": 6,
                "hoursOut": 2.58,
                "notReturned": 1,
                "teaOverruns": 18,
                "teaOverrunPct": 22.5,
                "teaMinutesLost": 140,
            },
        )
        self.assertEqual(
            self.kpis(body),
            {
                "Visits": 6,
                "Unique visitors": 5,
                "Outpass requests": 6,
                "Outpass hours lost": 2.58,
                "Passes never returned": 1,
                "Tea-break overruns": 18,
                "Tea minutes lost": 140,
                "Repeat outpass users": 1,
                "Repeat tea-break overrunners": 2,
            },
        )
        rows = body["rows"]
        self.assertEqual(sum(r["visits"] for r in rows), body["totals"]["visits"])
        self.assertEqual(sum(r["outpasses"] or 0 for r in rows), body["totals"]["outpasses"])
        self.assertEqual(sum(r["teaOverruns"] or 0 for r in rows), body["totals"]["teaOverruns"])
        self.assertEqual(sum(r["teaMinutesLost"] or 0 for r in rows), body["totals"]["teaMinutesLost"])

    def test_the_repeat_offenders_are_summarised_in_the_notes(self):
        text = "\n".join(self.report("md-gate-discipline", RANGE(SPAN))["notes"])
        self.assertIn(
            "Repeat outpass users (3 or more approved passes): 1 person. Most passes: Asha Kumar (Stitching, 3 passes, 1h 50m out).",
            text,
        )
        self.assertIn("Repeat tea-break overrunners (3 or more overruns): 2 people, 100.0% of the minutes lost.", text)
        self.assertIn("Chitra Devi (Cutting, 10 overruns, 100 minutes lost)", text)
        self.assertIn("Asha Kumar (Stitching, 8 overruns, 40 minutes lost)", text)
        self.assertIn("1 visit was before 8:00 am or from 6:00 pm.", text)
        self.assertIn("no check-out", text)
        self.assertIn("not rupees", text)

    def test_figures_equal_the_gate_and_tea_pages(self):
        with frozen():
            gate = VIS.summary(Scope(), PERIOD_SPAN)
            tea_summary = TEA.tea_summary(Scope(), PERIOD_SPAN)
            exceptions = VIS.exceptions(Scope(), PERIOD_SPAN, limit=25)
            offenders = TEA.tea_offenders(Scope(), PERIOD_SPAN, limit=25)
            hosts = VIS.visitors_breakdown(Scope(), PERIOD_SPAN, limit=25)
            outpass = VIS.outpass_breakdown(Scope(), PERIOD_SPAN, limit=25)
        body = self.report("md-gate-discipline", RANGE(SPAN))
        rows = by(body["rows"])
        t = body["totals"]
        self.assertEqual(t["visits"], gate["visitors"]["visits"]["value"])
        self.assertEqual(t["outpasses"], gate["outpass"]["requests"]["value"])
        self.assertEqual(t["notReturned"], gate["outpass"]["notReturned"]["value"])
        self.assertEqual(t["teaOverruns"], tea_summary["metrics"]["overruns"]["value"])
        self.assertEqual(t["teaMinutesLost"], tea_summary["metrics"]["minutesLost"]["value"])
        self.assertEqual(self.kpis(body)["Repeat outpass users"], exceptions["repeatOutpass"]["total"])
        self.assertEqual(self.kpis(body)["Repeat tea-break overrunners"], offenders["total"])
        for dept in hosts["hostDepartments"]:
            self.assertEqual(rows[dept["department"]]["visits"], dept["visits"], dept["department"])
        for dept in outpass["byDepartment"]:
            self.assertEqual(rows[dept["department"]]["outpasses"], dept["requests"], dept["department"])
            self.assertEqual(rows[dept["department"]]["notReturned"], dept["notReturned"], dept["department"])

    def test_a_unit_narrows_the_visits_the_passes_and_the_breaks(self):
        body = self.report("md-gate-discipline", {**RANGE(SPAN), "branchIds": str(self.unit_b.id)})
        self.assertEqual([r["department"] for r in body["rows"]], ["Accounts"])
        self.assertEqual(body["totals"]["visits"], 1)
        self.assertEqual(body["totals"]["teaOverruns"], 0)


# ─── the adapters give what the pages' own (capped) functions give ──────────────────────────────────────────────────


class AdapterParityTests(World):
    def test_tea_groups_equal_the_pages_department_and_unit_rankings(self):
        with frozen():
            mine = MS.tea_groups(Scope(), PERIOD_SPAN)
            theirs = TEA.tea_departments(Scope(), PERIOD_SPAN, by="department", limit=25)
            units_mine = MS.tea_groups(Scope(), PERIOD_SPAN, "unit")
            units_theirs = TEA.tea_departments(Scope(), PERIOD_SPAN, by="unit", limit=25)
        self.assertEqual(set(mine), {r["label"] for r in theirs["rows"] if r["breaks"]})
        for row in theirs["rows"]:
            if row["breaks"]:
                m = mine[row["label"]]
                self.assertEqual(
                    (m["measured"], m["overruns"], m["overrunPct"], m["minutesLost"], m["avgMinutes"]),
                    (row["measured"], row["overruns"], row["overrunPct"], row["minutesLost"], row["avgMinutes"]),
                )
        for row in units_theirs["rows"]:
            if row["breaks"]:
                self.assertEqual(units_mine[row["label"]]["overruns"], row["overruns"])

    def test_outpass_groups_equal_the_pages_department_ranking(self):
        with frozen():
            mine = MS.outpass_groups(Scope(), PERIOD_SPAN, TODAY)
            theirs = VIS.outpass_breakdown(Scope(), PERIOD_SPAN, limit=25)
        self.assertEqual(theirs["departmentsTotal"], len(mine))
        for row in theirs["byDepartment"]:
            m = mine[row["department"]]
            self.assertEqual(
                (m["requests"], m["returned"], m["minutesOut"], m["notReturned"]),
                (row["requests"], row["returned"], row["minutesOut"], row["notReturned"]),
            )

    def test_visit_groups_equal_the_pages_host_departments(self):
        with frozen():
            mine, unmatched, total = MS.visit_groups(Scope(), PERIOD_SPAN)
            theirs = VIS.visitors_breakdown(Scope(), PERIOD_SPAN, limit=25)
        self.assertEqual(
            {d["department"]: d["visits"] for d in theirs["hostDepartments"]}, {k: v["visits"] for k, v in mine.items()}
        )
        self.assertEqual(unmatched, theirs["hostsNotLinked"]["visits"])
        self.assertEqual(total, theirs["visits"])

    def test_payroll_departments_equal_the_pages_rows_and_add_the_deductions(self):
        with frozen():
            ctx = MS.payroll_context(Scope(), "2026-09", TODAY)
            mine = MS.payroll_departments(ctx)
            theirs = PAY.payroll_departments(Scope(), "2026-09", 25)
        self.assertEqual([m["name"] for m in mine], [t["name"] for t in theirs["departments"]])
        for m, t in zip(mine, theirs["departments"], strict=True):
            for key in ("headcount", "grossPay", "netPay", "overtimePay", "costPerHead", "change"):
                self.assertEqual(m[key], t[key], (t["name"], key))
        self.assertEqual(
            sum(m["totalDeductions"] for m in mine),
            PAY.payroll_summary(Scope(), "2026-09")["totals"]["totalDeductions"],
        )

    def test_the_latest_closed_month_is_september_not_the_running_one(self):
        slip(self.e1, (2026, 10), 26000)  # a slip for October, which is still running on 12 Oct
        with frozen():
            ctx = MS.payroll_context(Scope(), None, TODAY)
        self.assertEqual(ctx.ym, (2026, 9))

    def test_attendance_view_equals_the_pages_department_ranking(self):
        with frozen():
            view = MS.attendance_view(Scope(), PERIOD_SPAN, TODAY)
            page = ATT.attendance_by_department(Scope(), PERIOD_SPAN, limit=50)
        self.assertEqual(set(view.departments), {d["name"] for d in page["departments"]})
        for dept in page["departments"]:
            row = view.departments[dept["name"]]
            self.assertEqual(
                (row["attendancePct"], row["scheduledDays"]), (dept["attendancePct"], dept["scheduledDays"])
            )
        self.assertEqual(view.baseline, page["baseline"])

    def test_hiring_totals_equal_the_recruitment_summary(self):
        with frozen():
            h = MS.hiring(Scope(), PERIOD_SEP, TODAY)
            summary = REC.summary(Scope(), PERIOD_SEP, today=TODAY)["current"]
        self.assertEqual(h.open_total, summary["openPositions"])
        self.assertEqual(h.pending_total, summary["resignationsPending"])
        self.assertEqual((h.open_listed, h.pending_listed), (2, 1))


# ─── exports ─────────────────────────────────────────────────────────────────────────────────────────────────────────

PARAMS = {
    "md-daily-brief": {"dateFrom": "2026-09-09", "dateTo": "2026-09-09"},
    "md-weekly-workforce": RANGE(W),
    "md-monthly-payroll": {"period": "2026-09"},
    "md-attrition-hiring": RANGE(SEPTEMBER),
    "md-attendance-exceptions": RANGE(W),
    "md-department-scorecard": RANGE(SPAN),
    "md-gate-discipline": RANGE(SPAN),
}


class ExportTests(World):
    def test_the_md_can_export_every_report_as_excel_and_pdf(self):
        for rid, params in PARAMS.items():
            with self.subTest(report=rid):
                x = self.get(f"/api/reports/export/{rid}", fmt="xlsx", **params)
                self.assertEqual(x.status_code, 200, x.content[:300])
                self.assertTrue(x.content.startswith(b"PK"), rid)
                self.assertGreater(len(x.content), 3000)
                p = self.get(f"/api/reports/export/{rid}", fmt="pdf", **params)
                self.assertEqual(p.status_code, 200, p.content[:300])
                self.assertTrue(p.content.startswith(b"%PDF"), rid)
                self.assertGreater(len(p.content), 3000)
                self.assertIn("attachment", p["Content-Disposition"])

    def test_the_spreadsheet_matches_the_screen(self):
        for rid, params in PARAMS.items():
            with self.subTest(report=rid):
                screen = self.get(f"/api/reports/run/{rid}", **params).json()
                x = self.get(f"/api/reports/export/{rid}", fmt="xlsx", **params)
                ws = load_workbook(io.BytesIO(x.content)).active
                header = [c.value for c in ws[HEADER_ROW]]
                self.assertEqual(header[: len(screen["columns"])], [c["label"] for c in screen["columns"]])
                first = [ws.cell(row=HEADER_ROW + 1 + i, column=1).value for i in range(len(screen["rows"]))]
                self.assertEqual(first, [r[screen["columns"][0]["key"]] for r in screen["rows"]])
                if screen["rows"][-1].get("_kind") == "total":
                    last = [c.value for c in ws[HEADER_ROW + len(screen["rows"])]]
                    self.assertEqual(last[0], "Company")  # the company line closes the table ...
                    self.assertNotIn("TOTAL", last)  # ... and the exporter does not add a second, empty-looking one
                cells = " ".join(str(c.value) for row in ws.iter_rows() for c in row if c.value is not None)
                for note in screen["notes"][:2]:
                    self.assertIn(note[:40], cells)

    def test_the_pdf_is_an_a4_document_titled_as_the_report_in_the_orientation_of_its_spec(self):
        for rid, params in PARAMS.items():
            with self.subTest(report=rid):
                p = self.get(f"/api/reports/export/{rid}", fmt="pdf", **params)
                box = re.search(rb"/MediaBox \[ 0 0 ([\d.]+) ([\d.]+) \]", p.content)
                self.assertIsNotNone(box)
                width, height = float(box.group(1)), float(box.group(2))
                self.assertEqual(width > height, rid in WIDE, (rid, width, height))
                self.assertAlmostEqual(min(width, height), 595.28, delta=1)  # A4
                self.assertAlmostEqual(max(width, height), 841.89, delta=1)
                self.assertIn(f"/Title ({registry.get_spec(rid).title})".encode(), p.content)
                self.assertEqual(len(re.findall(rb"/Type /Page(?!s)", p.content)), 1, f"{rid}: more than one page")

    def test_the_export_is_audited_as_the_mds(self):
        from .models import AuditLog

        before = AuditLog.objects.count()
        self.get("/api/reports/export/md-daily-brief", fmt="xlsx", **PARAMS["md-daily-brief"])
        self.assertEqual(AuditLog.objects.count(), before + 1)


# ─── no data, no writes, no N+1 ──────────────────────────────────────────────────────────────────────────────────────


class EmptyDatabaseTests(TestCase):
    """A company with nobody in it: every report is a clear empty report, never an error or a division by zero."""

    @classmethod
    def setUpTestData(cls):
        cls.md = make_md()

    def get(self, path, **params):
        with frozen():
            return self.client.get(path, params, **md_headers(self.md))

    def test_every_report_runs_empty_with_its_default_filters(self):
        for rid in MD_REPORT_IDS:
            with self.subTest(report=rid):
                r = self.get(f"/api/reports/run/{rid}")
                self.assertEqual(r.status_code, 200, r.content[:300])
                body = r.json()
                self.assertEqual(body["rows"], [], rid)
                self.assertIsNone(body["totals"], rid)
                self.assertTrue(body["notes"], rid)
                self.assertIsInstance(body["summary"], list)

    def test_no_figure_is_a_made_up_zero_for_no_data(self):
        kpis = {
            s["label"]: s["value"]
            for s in self.get("/api/reports/run/md-weekly-workforce", **RANGE(W)).json()["summary"]
        }
        self.assertEqual(kpis.get("Attendance %"), None)
        brief = {
            s["label"]: s["value"]
            for s in self.get("/api/reports/run/md-daily-brief", dateFrom="2026-09-09", dateTo="2026-09-09").json()[
                "summary"
            ]
        }
        self.assertIsNone(brief["Attendance %"])
        self.assertIsNone(brief["Present"])
        payroll = {
            s["label"]: s["value"]
            for s in self.get("/api/reports/run/md-monthly-payroll", period="2026-09").json()["summary"]
        }
        self.assertIsNone(payroll["Gross pay"])
        scorecard = {
            s["label"]: s["value"]
            for s in self.get("/api/reports/run/md-department-scorecard", **RANGE(SPAN)).json()["summary"]
        }
        self.assertIsNone(scorecard["Payroll cost per head"])
        self.assertEqual(scorecard["Departments"], 0)

    def test_nothing_is_written_even_when_nothing_is_set_up_yet(self):
        """No tea-break rule, no payroll settings, no shift: a report must read the defaults, never create the rows."""
        before = {
            m.__name__: m.objects.count() for m in apps.get_app_config("api").get_models() if m.__name__ != "AuditLog"
        }
        with frozen(), read_only_db():
            for rid in MD_REPORT_IDS:
                run_report(request_for(self.md), registry.get_spec(rid), {})
        after = {
            m.__name__: m.objects.count() for m in apps.get_app_config("api").get_models() if m.__name__ != "AuditLog"
        }
        self.assertEqual(before, after)

    def test_every_report_exports_empty(self):
        for rid in MD_REPORT_IDS:
            with self.subTest(report=rid):
                for fmt, magic in (("xlsx", b"PK"), ("pdf", b"%PDF")):
                    r = self.get(f"/api/reports/export/{rid}", fmt=fmt)
                    self.assertEqual(r.status_code, 200, (rid, fmt, r.content[:300]))
                    self.assertTrue(r.content.startswith(magic))


class SafetyTests(World):
    def test_running_every_report_inside_a_read_only_transaction_never_writes(self):
        before = {
            m.__name__: m.objects.count() for m in apps.get_app_config("api").get_models() if m.__name__ != "AuditLog"
        }
        spec_ids = list(PARAMS)
        with frozen(), read_only_db():
            for rid in spec_ids:
                run_report(request_for(self.md), registry.get_spec(rid), dict(PARAMS[rid]))
        after = {
            m.__name__: m.objects.count() for m in apps.get_app_config("api").get_models() if m.__name__ != "AuditLog"
        }
        self.assertEqual(before, after)

    @override_settings(MD_ANALYTICS_CACHE_SECONDS=60)
    def test_a_report_never_changes_what_the_analytics_cache_hands_out(self):
        """The analytics functions hand the SAME cached dict to every caller (the pages, the assistant, the next report):
        a report that edited it in place would corrupt all of them. With the cache on, run every report and check that
        what the functions return afterwards is what they returned before."""
        from .md_portal import common

        common.CACHE.clear()
        ATT._FRAMES.clear()
        self.addCleanup(common.CACHE.clear)
        self.addCleanup(ATT._FRAMES.clear)
        day = Period(date(2026, 9, 9), date(2026, 9, 9), "custom", "09 Sep 2026")
        probes = [
            (ATT.attendance_on_date, (Scope(), date(2026, 9, 9)), {"limit": 50}),
            (ATT.attendance_exceptions, (Scope(), PERIOD_W), {"limit": 15}),
            (VIS.summary, (Scope(), day), {}),
            (VIS.units, (Scope(), day), {}),
            (VIS.exceptions, (Scope(), PERIOD_SPAN), {"limit": 3}),
            (TEA.tea_summary, (Scope(), PERIOD_SPAN), {}),
            (TEA.tea_departments, (Scope(), day), {"by": "unit", "limit": 25}),
            (TEA.tea_offenders, (Scope(), PERIOD_SPAN), {"limit": 3}),
            (PAY.payroll_summary, (Scope(), "2026-09"), {}),
            (PAY.payroll_bridge, (Scope(), "2026-09"), {}),
            (EMP.attrition, (Scope(), PERIOD_SEP), {"limit": 5, "today": TODAY}),
            (EMP.exceptions, (Scope(), Period(date(2026, 8, 11), date(2026, 9, 9), "custom", "x")), {"today": TODAY}),
            (REC.positions, (Scope(),), {"limit": 100, "today": TODAY}),
            (REC.resignations, (Scope(), PERIOD_SEP), {"limit": 25, "today": TODAY}),
        ]
        with frozen():
            before = [copy.deepcopy(fn(*args, **kwargs)) for fn, args, kwargs in probes]
            for rid, params in PARAMS.items():
                run_report(request_for(self.md), registry.get_spec(rid), dict(params))
            after = [fn(*args, **kwargs) for fn, args, kwargs in probes]
        for (fn, _args, _kwargs), was, now in zip(probes, before, after, strict=True):
            self.assertEqual(was, now, f"{fn.__name__}: a report changed the cached result")


class QueryCountTests(World):
    """The queries a report runs do not grow with the number of departments, people or records."""

    def count(self, rid):
        spec = registry.get_spec(rid)
        with frozen(), CaptureQueriesContext(connection) as queries:
            run_report(request_for(self.md), spec, dict(PARAMS[rid]))
        return len(queries)

    def grow(self):
        shift = self.shift
        for n in range(6):
            unit = self.unit_a if n % 2 == 0 else self.unit_b
            dept = Department.objects.create(name=f"Extra {n}", branch=unit)
            for k in range(3):
                emp = make_employee(f"X{n}{k}", f"Extra{n}", f"Person{k}", dept, unit)
                EmployeeShiftAssignment.objects.create(employee=emp, shift=shift, effective_from=date(2026, 1, 1))
                mark(emp, date(2026, 9, 7), "PPpAPPO")
                mark(emp, date(2026, 8, 31), "PPPPOPO")
                slip(emp, (2026, 8), 15000 + 100 * k)
                slip(emp, (2026, 9), 16000 + 100 * k, ot=100)
                tea(emp, [10, 20, 30, 12])
                visitor = Visitor.objects.create(name=f"Guest {n}{k}", phone=str(8000000000 + n * 10 + k))
                visit(visitor, ist(9, 5, 11, 0), unit, emp)
                make_pass(emp, ist(9, 6, 10, 50), exited=ist(9, 6, 11, 0), entered=ist(9, 6, 11, 30))
            Job.objects.create(title=f"Job {n}", department=dept, status="open")

    def test_the_number_of_queries_does_not_grow_with_the_data(self):
        for rid in PARAMS:  # warm-up: first calls load settings, content types and the like
            self.count(rid)
        small = {rid: self.count(rid) for rid in PARAMS}
        self.grow()
        large = {rid: self.count(rid) for rid in PARAMS}
        for rid in PARAMS:
            with self.subTest(report=rid):
                self.assertLessEqual(
                    large[rid], small[rid] + 2, f"{rid}: {small[rid]} queries before, {large[rid]} after"
                )
                self.assertLess(large[rid], 150, f"{rid} runs {large[rid]} queries")

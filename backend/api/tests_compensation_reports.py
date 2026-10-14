"""
Compensation reports (History & Reports): GET /api/compensation/reports, who benefited from each type, per period.

Run via: python manage.py test api.tests_compensation_reports -v 2
"""

from datetime import date, datetime, time, timedelta, timezone as dt_timezone
from decimal import Decimal
from unittest import mock

from django.db import connection
from django.test import TestCase
from django.test.utils import CaptureQueriesContext

from . import approval_workflow as approval
from .compensation_reports_views import ROW_KEYS, TYPES
from .jwt_utils import sign_token
from .models import (
    AttendanceDayRecord,
    Branch,
    CompensationConfig,
    CompensationDayAnnouncement,
    CompensationLedger,
    Department,
    Employee,
    Holiday,
    HolidayWorkClaim,
    HRUser,
    OvertimeRecord,
    PayrollSettings,
    Role,
    SalarySlip,
)

TODAY = date(2026, 10, 14)  # a Wednesday: its week is Monday 12 - Sunday 18 October
URL = "/api/compensation/reports"


def _bearer(payload: dict) -> dict:
    return {"HTTP_AUTHORIZATION": f"Bearer {sign_token(payload)}"}


def _hr(username, permissions=None, branch=None, super_admin=False) -> dict:
    role = Role.objects.create(name=f"role_{username}", permissions=permissions) if permissions is not None else None
    user = HRUser.objects.create(
        username=username,
        password_hash="x",
        full_name=username.title(),
        role=role,
        branch=branch,
        is_super_admin=super_admin,
    )
    return _bearer({"role": "hr", "hrUserId": user.id, "name": user.full_name})


def _employee(code, branch=None, department=None, kind="staff", dob=None, salary=None) -> Employee:
    return Employee.objects.create(
        employee_code=code,
        first_name=code,
        last_name="Rp",
        employment_type=kind,
        status="active",
        branch=branch,
        department=department,
        date_of_birth=dob,
        salary_amount=salary,
    )


def _ist(year, month, day, hour=10) -> datetime:
    """The instant that is `hour`:00 in India on that date (an aware UTC datetime)."""
    return (datetime(year, month, day, hour, 0) - timedelta(hours=5, minutes=30)).replace(tzinfo=dt_timezone.utc)


def _day(emp, d, status="present", kind="", minutes=0, first=None, last=None, shifts="1.00", note=""):
    return AttendanceDayRecord.objects.create(
        employee=emp,
        date=d,
        status=status,
        compensation_kind=kind,
        compensation_minutes=minutes,
        compensation_note=note,
        first_punch=first,
        last_punch=last,
        shifts_earned=Decimal(shifts),
    )


def _allowance(emp, d, allowance=30, extra=70, status="auto"):
    return OvertimeRecord.objects.create(
        employee=emp,
        date=d,
        shift_end_time=time(17, 30),
        last_punch_out=time(18, 40),
        ot_minutes=extra,
        status=status,
        ot_type="allowance",
        allowance_minutes=allowance,
    )


def _shift_rec(emp, d, mode, claim, shifts="0.50", by="Meena", at=None, status="announced", extra=200):
    return OvertimeRecord.objects.create(
        employee=emp,
        date=d,
        shift_end_time=time(17, 30),
        last_punch_out=time(20, 50),
        ot_minutes=extra,
        status=status,
        ot_type="shift",
        compensation_type=mode,
        shifts=Decimal(shifts),
        suggested_shifts=Decimal(shifts),
        claim_date=claim,
        announced_by=by,
        announced_at=at or _ist(2026, 10, 6),
    )


class ReportBase(TestCase):
    def setUp(self):
        approval.clear_cache()
        self.addCleanup(approval.clear_cache)
        patch = mock.patch("api.compensation_reports_views.ist_today", return_value=TODAY)
        patch.start()
        self.addCleanup(patch.stop)
        settings = PayrollSettings.get()
        settings.compensation_feature_enabled = True
        settings.save()
        CompensationConfig.objects.update_or_create(
            pk=1,
            defaults={
                "allowance_enabled": True,
                "shift_enabled": True,
                "relaxation_enabled": True,
                "pay_enabled": True,
                "windows_enabled": True,
                "holiday_work_enabled": True,
                "birthday_enabled": True,
                "birthday_effective_from": date(2026, 1, 1),
            },
        )
        self.ho = Branch.objects.create(name="RP Head Office", code="RPHO", is_head_office=True)
        self.u2 = Branch.objects.create(name="RP Unit 2", code="RPU2")
        self.cutting = Department.objects.create(name="RP Cutting", branch=self.ho)
        self.finishing = Department.objects.create(name="RP Finishing", branch=self.ho)
        self.sewing = Department.objects.create(name="RP Sewing", branch=self.u2)
        self.asha = _employee("RP1", self.ho, self.cutting, salary=Decimal("30000"))
        self.ravi = _employee("RP2", self.ho, self.finishing, salary=Decimal("24000"))
        self.mani = _employee("RP3", self.u2, self.sewing)
        self.prod = _employee("RPP", self.ho, self.cutting, kind="production")
        self.admin = _hr("rp_admin", super_admin=True)
        self.view_only = _hr("rp_view", {"compensation": "view"})
        self.no_access = _hr("rp_none", {"leave": "edit"})
        self.ho_hr = _hr("rp_ho", {"compensation": "view"}, branch=self.ho)

    def report(self, period="week", day=None, who=None, **params):
        query = {"period": period, **({"date": day} if day else {}), **params}
        r = self.client.get(URL, query, **(who or self.admin))
        self.assertEqual(r.status_code, 200, r.content)
        return r.json()

    def section(self, body, type_):
        return next(s for s in body["sections"] if s["type"] == type_)

    def rows(self, body, type_):
        return self.section(body, type_)["rows"]


# ═════════════════════════════ the shape ═════════════════════════════


class ShapeTests(ReportBase):
    def test_every_type_has_a_section_with_one_set_of_row_keys(self):
        _allowance(self.asha, date(2026, 10, 12))
        _shift_rec(self.asha, date(2026, 10, 5), "relaxation", date(2026, 10, 14))
        _shift_rec(self.ravi, date(2026, 10, 6), "pay", date(2026, 10, 13))
        _day(self.asha, date(2026, 10, 13), kind="window_late_in", minutes=20)
        _day(self.asha, date(2026, 10, 14), kind="window_early_out")
        HolidayWorkClaim.objects.create(
            employee=self.mani, work_date=date(2026, 10, 12), shifts=Decimal("1.00"), approval_trail=[]
        )
        _employee("RPB", self.ho, self.cutting, dob=date(1990, 10, 14))
        body = self.report("week")
        self.assertEqual([s["type"] for s in body["sections"]], list(TYPES))
        self.assertEqual(
            (body["period"], body["from"], body["to"], body["date"], body["types"]),
            ("week", "2026-10-12", "2026-10-18", "2026-10-14", list(TYPES)),
        )
        self.assertEqual(body["rowKeys"], list(ROW_KEYS))
        total = 0
        for s in body["sections"]:
            self.assertTrue(s["label"])
            self.assertIn("summary", s)
            for row in s["rows"]:
                self.assertEqual(sorted(row), sorted(ROW_KEYS), s["type"])
                self.assertEqual(row["type"], s["type"])
                self.assertEqual(row["employmentType"], "staff")
                self.assertTrue(row["statusLabel"])
                total += 1
        self.assertEqual(total, 7)
        self.assertEqual(body["totals"]["rows"], 7)
        self.assertEqual(body["totals"]["employees"], 4)  # Asha (four sections), Ravi, Mani and the birthday

    def test_an_empty_company_reports_empty_sections(self):
        body = self.report("month")
        self.assertEqual(body["totals"], {"rows": 0, "employees": 0})
        self.assertEqual(self.section(body, "ot_allowance")["summary"]["earned"], 0)
        self.assertEqual(self.section(body, "holiday_work")["redemptions"], [])
        self.assertEqual(self.section(body, "birthday")["summary"]["birthdays"], 0)

    def test_sections_know_which_switch_they_depend_on(self):
        CompensationConfig.objects.filter(pk=1).update(windows_enabled=False, pay_enabled=False)
        body = self.report("week")
        enabled = {s["type"]: s["enabled"] for s in body["sections"]}
        self.assertEqual(
            enabled,
            {
                "ot_allowance": True,
                "ot_shift_relaxation": True,
                "ot_shift_pay": False,
                "window_late_in": False,
                "window_early_out": False,
                "holiday_work": True,
                "birthday": True,
            },
        )
        settings = PayrollSettings.get()
        settings.compensation_feature_enabled = False
        settings.save()
        self.assertFalse(any(s["enabled"] for s in self.report("week")["sections"]))
        self.assertEqual(self.client.get(URL, {"period": "week"}, **self.admin).status_code, 200)  # still readable

    def test_the_old_summary_endpoint_keeps_working(self):
        r = self.client.get("/api/compensation/summary", {"month": 10, "year": 2026}, **self.admin)
        self.assertEqual(r.status_code, 200)
        self.assertEqual(
            sorted(r.json()), ["benefiting", "month", "notBenefiting", "paidCost", "pendingCostEstimate", "year"]
        )


# ═════════════════════════════ Type 1: the allowance ═════════════════════════════


class AllowanceTests(ReportBase):
    def test_used_not_used_and_pending(self):
        _allowance(self.asha, date(2026, 10, 12), allowance=30, extra=70)
        _day(
            self.asha,
            date(2026, 10, 13),
            kind="ot_allowance",
            minutes=18,
            first=time(9, 48),
            note="Arrived 09:48: 18 minutes of your allowance used",
        )
        _allowance(self.ravi, date(2026, 10, 12), allowance=60, extra=130)
        _day(self.ravi, date(2026, 10, 13), first=time(9, 0))  # came on the next day, on time: did not need it
        _allowance(self.mani, date(2026, 10, 13), allowance=30)  # nothing worked since
        _allowance(self.prod, date(2026, 10, 12))  # production: never reported
        body = self.report("week")
        rows = self.rows(body, "ot_allowance")
        # an allowance that was used is filed under the morning it was used; the others stay under their OT day
        self.assertEqual(
            [(r["employeeCode"], r["date"], r["status"]) for r in rows],
            [
                ("RP2", "2026-10-12", "not_used"),
                ("RP1", "2026-10-13", "used"),
                ("RP3", "2026-10-13", "pending"),
            ],
        )
        used = rows[1]
        self.assertEqual(
            (
                used["minutes"],
                used["minutesUsed"],
                used["usedOn"],
                used["workDate"],
                used["assignedBy"],
                used["firstPunch"],
            ),
            (30, 18, "2026-10-13", "2026-10-12", "Automatic", "09:48"),
        )
        self.assertIn("18 minutes", used["detail"])
        self.assertEqual((used["amount"], used["shifts"]), (None, None))  # never paid
        self.assertEqual(
            self.section(body, "ot_allowance")["summary"],
            {
                "earned": 3,
                "earnedMinutes": 120,
                "used": 1,
                "usedMinutes": 18,
                "notUsed": 1,
                "pending": 1,
                "employees": 3,
            },
        )

    def test_an_allowance_belongs_to_the_next_working_day_only(self):
        # Monday's OT is used on Tuesday morning; Tuesday's OT is not used on Wednesday morning (they came on time)
        _allowance(self.asha, date(2026, 10, 12))
        _day(self.asha, date(2026, 10, 13), kind="ot_allowance", minutes=10, first=time(9, 40))
        _allowance(self.asha, date(2026, 10, 13))
        _day(self.asha, date(2026, 10, 14), first=time(9, 0))
        rows = self.rows(self.report("week"), "ot_allowance")
        self.assertEqual(
            sorted((r["workDate"], r["status"], r["usedOn"]) for r in rows),
            [
                ("2026-10-12", "used", "2026-10-13"),
                ("2026-10-13", "not_used", None),
            ],
        )

    def test_a_marker_too_long_after_the_ot_day_is_not_that_days_allowance(self):
        _allowance(self.asha, date(2026, 10, 1))
        _day(self.asha, date(2026, 10, 2), first=time(9, 0))
        _day(self.asha, date(2026, 10, 20), kind="ot_allowance", minutes=10)  # 19 days later: someone else's OT day
        rows = self.rows(self.report("month"), "ot_allowance")
        self.assertEqual([(r["status"], r["usedOn"]) for r in rows], [("not_used", None)])

    def test_the_week_over_a_sunday(self):
        # Friday's OT is used on Monday: the employee benefited on Monday, so the row is filed under Monday (the week
        # it was used), still saying it came from Friday's extra work
        _allowance(self.asha, date(2026, 10, 9))
        _day(self.asha, date(2026, 10, 12), kind="ot_allowance", minutes=15)
        self.assertEqual(self.rows(self.report("week", "2026-10-09"), "ot_allowance"), [])  # not the week of the OT day
        used_week = self.rows(self.report("week", "2026-10-12"), "ot_allowance")
        self.assertEqual(
            [(r["date"], r["workDate"], r["usedOn"], r["status"]) for r in used_week],
            [("2026-10-12", "2026-10-09", "2026-10-12", "used")],
        )


# ═════════════════════════════ Type 2: relaxation and pay ═════════════════════════════


class ShiftTests(ReportBase):
    def test_relaxation_rows_by_the_granted_date(self):
        _shift_rec(
            self.asha,
            date(2026, 10, 5),
            "relaxation",
            date(2026, 10, 14),
            shifts="0.50",
            by="Meena",
            at=_ist(2026, 10, 6),
        )
        _day(self.asha, date(2026, 10, 14), kind="relaxation", shifts="1.00")
        _shift_rec(self.ravi, date(2026, 10, 6), "relaxation", date(2026, 10, 16), shifts="0.25")
        _shift_rec(self.mani, date(2026, 10, 7), "relaxation", date(2026, 10, 9), shifts="0.75")
        body = self.report("week")
        rows = self.rows(body, "ot_shift_relaxation")
        self.assertEqual(
            [(r["employeeCode"], r["date"], r["status"], r["shifts"]) for r in rows],
            [
                ("RP1", "2026-10-14", "applied", 0.5),
                ("RP2", "2026-10-16", "scheduled", 0.25),
            ],
        )
        first = rows[0]
        self.assertEqual(
            (
                first["workDate"],
                first["assignedBy"],
                first["grantedOn"],
                first["minutes"],
                first["usedOn"],
                first["amount"],
            ),
            ("2026-10-05", "Meena", "2026-10-06", 200, "2026-10-14", None),
        )
        self.assertEqual(
            self.section(body, "ot_shift_relaxation")["summary"],
            {"records": 2, "shifts": 0.75, "applied": 1, "scheduled": 1, "notApplied": 0, "employees": 2},
        )
        month = self.section(self.report("month"), "ot_shift_relaxation")
        self.assertEqual([r["status"] for r in month["rows"]], ["not_applied", "applied", "scheduled"])
        self.assertEqual(month["summary"]["notApplied"], 1)

    def test_pay_rows_use_the_slips_daily_rate_or_an_estimate(self):
        _shift_rec(self.ravi, date(2026, 10, 6), "pay", date(2026, 10, 13), shifts="0.75")
        SalarySlip.objects.create(
            employee=self.ravi,
            month=10,
            year=2026,
            slip_number="SS/RP2/2026/10",
            ot_amount=Decimal("600.00"),
            breakdown_details={"earnings": {"dailyRate": 800.0, "otAmount": 600.0}},
        )
        _shift_rec(self.asha, date(2026, 10, 5), "pay", date(2026, 10, 12), shifts="1.00")
        body = self.report("week")
        rows = {r["employeeCode"]: r for r in self.rows(body, "ot_shift_pay")}
        self.assertEqual(
            (rows["RP2"]["amount"], rows["RP2"]["amountEstimated"], rows["RP2"]["status"], rows["RP2"]["shifts"]),
            (600.0, False, "in_payroll", 0.75),
        )
        self.assertEqual(
            (rows["RP1"]["amount"], rows["RP1"]["amountEstimated"], rows["RP1"]["status"]),
            (1000.0, True, "pending_payroll"),
        )
        self.assertEqual(
            self.section(body, "ot_shift_pay")["summary"],
            {
                "records": 2,
                "shifts": 1.75,
                "amount": 600.0,
                "estimatedAmount": 1000.0,
                "inPayroll": 1,
                "pendingPayroll": 1,
                "employees": 2,
            },
        )

    def test_a_slip_without_ot_pay_means_payroll_has_not_included_it_yet(self):
        _shift_rec(self.ravi, date(2026, 10, 6), "pay", date(2026, 10, 13), shifts="0.50")
        SalarySlip.objects.create(
            employee=self.ravi,
            month=10,
            year=2026,
            slip_number="SS/RP2/2026/10",
            ot_amount=Decimal("0"),
            breakdown_details={"earnings": {"dailyRate": 800.0}},
        )
        row = self.rows(self.report("week"), "ot_shift_pay")[0]
        self.assertEqual((row["status"], row["amount"], row["amountEstimated"]), ("pending_payroll", 400.0, False))

    def test_only_assigned_type_2_records_are_reported(self):
        _shift_rec(self.asha, date(2026, 10, 5), "relaxation", date(2026, 10, 14), status="detected")
        _shift_rec(self.ravi, date(2026, 10, 6), "pay", date(2026, 10, 13), status="rejected")
        _shift_rec(
            self.mani, date(2026, 10, 7), "pay", date(2026, 10, 13), status="assigned"
        )  # the other spelling counts
        OvertimeRecord.objects.create(  # a record made before the overhaul is not part of these reports
            employee=self.asha,
            date=date(2026, 10, 1),
            last_punch_out=time(20, 0),
            ot_minutes=150,
            status="announced",
            compensation_type="pay",
            claim_date=date(2026, 10, 13),
        )
        body = self.report("week")
        self.assertEqual(self.rows(body, "ot_shift_relaxation"), [])
        self.assertEqual([r["employeeCode"] for r in self.rows(body, "ot_shift_pay")], ["RP3"])


# ═════════════════════════════ announced windows ═════════════════════════════


class WindowTests(ReportBase):
    def setUp(self):
        super().setUp()
        self.late = CompensationDayAnnouncement.objects.create(
            date=date(2026, 10, 13), kind="late_in", allowed_time=time(10, 30), reason="Rain", announced_by="Meena"
        )
        self.early = CompensationDayAnnouncement.objects.create(
            date=date(2026, 10, 14),
            kind="early_out",
            allowed_time=time(16, 0),
            leave_until_time=time(16, 0),
            reason="Power cut",
            announced_by="Meena",
            branch=self.ho,
            department=self.cutting,
        )

    def test_who_used_a_window_with_the_announcements_details(self):
        _day(
            self.asha,
            date(2026, 10, 13),
            kind="window_late_in",
            minutes=25,
            first=time(10, 5),
            note="Arrived 10:05 within the window",
        )
        _day(self.mani, date(2026, 10, 13), kind="window_late_in", first=time(10, 20))
        _day(self.ravi, date(2026, 10, 13), first=time(9, 0))  # on time: did not need it
        _day(self.asha, date(2026, 10, 14), kind="window_early_out", last=time(16, 30))
        body = self.report("week")
        late = self.section(body, "window_late_in")
        self.assertEqual(
            [(r["employeeCode"], r["date"], r["status"]) for r in late["rows"]],
            [
                ("RP1", "2026-10-13", "used"),
                ("RP3", "2026-10-13", "used"),
            ],
        )
        first = late["rows"][0]
        self.assertEqual(
            (
                first["time"],
                first["reason"],
                first["assignedBy"],
                first["minutes"],
                first["firstPunch"],
                first["detail"],
            ),
            ("10:30", "Rain", "Meena", 25, "10:05", "Arrived 10:05 within the window"),
        )
        self.assertEqual(late["summary"], {"announcements": 1, "staffCovered": 3, "used": 2, "employees": 2})
        early = self.section(body, "window_early_out")
        self.assertEqual(
            [(r["employeeCode"], r["time"], r["reason"], r["lastPunch"]) for r in early["rows"]],
            [("RP1", "16:00", "Power cut", "16:30")],
        )
        self.assertEqual(early["summary"], {"announcements": 1, "staffCovered": 1, "used": 1, "employees": 1})

    def test_a_marker_without_its_announcement_is_still_reported(self):
        self.late.delete()
        _day(self.asha, date(2026, 10, 13), kind="window_late_in", minutes=5)
        row = self.rows(self.report("week"), "window_late_in")[0]
        self.assertEqual((row["status"], row["time"], row["reason"], row["assignedBy"]), ("used", None, None, None))

    def test_the_marker_decides_the_type(self):
        _day(self.asha, date(2026, 10, 13), kind="window_early_out")  # an early-out mark on a late-in day
        _day(self.ravi, date(2026, 10, 13), kind="birthday")
        _day(self.mani, date(2026, 10, 13), kind="relaxation")
        body = self.report("week")
        self.assertEqual(self.rows(body, "window_late_in"), [])
        self.assertEqual([r["employeeCode"] for r in self.rows(body, "window_early_out")], ["RP1"])

    def test_an_announcement_scoped_to_listed_employees_matches_them(self):
        listed = CompensationDayAnnouncement.objects.create(
            date=date(2026, 10, 15), kind="late_in", allowed_time=time(11, 0), reason="Audit", announced_by="Sita"
        )
        listed.employees.set([self.ravi])
        _day(self.ravi, date(2026, 10, 15), kind="window_late_in")
        row = self.rows(self.report("week"), "window_late_in")[0]
        self.assertEqual(
            (row["employeeCode"], row["time"], row["reason"], row["assignedBy"]), ("RP2", "11:00", "Audit", "Sita")
        )
        self.assertEqual(self.section(self.report("week"), "window_late_in")["summary"]["staffCovered"], 4)

    def test_production_is_never_reported(self):
        _day(self.prod, date(2026, 10, 13), kind="window_late_in")
        self.assertEqual(self.rows(self.report("week"), "window_late_in"), [])


# ═════════════════════════════ holiday / Sunday work ═════════════════════════════


class HolidayWorkTests(ReportBase):
    def test_claims_with_who_raised_and_who_approved(self):
        approved = HolidayWorkClaim.objects.create(
            employee=self.asha,
            work_date=date(2026, 10, 11),
            shifts=Decimal("0.50"),
            reason="Dispatch",
            status="approved",
            requested_by="Meena",
            reviewed_by="Boss",
            reviewed_at=_ist(2026, 10, 12),
            approval_trail=[],
        )
        CompensationLedger.objects.create(
            employee=self.asha,
            entry_type="credit",
            shifts=Decimal("0.50"),
            date=date(2026, 10, 11),
            source="holiday_work",
            claim=approved,
        )
        HolidayWorkClaim.objects.create(
            employee=self.ravi,
            work_date=date(2026, 10, 4),
            shifts=Decimal("1.00"),
            reason="Festival",
            requested_by="Meena",
            approval_trail=[],
        )
        HolidayWorkClaim.objects.create(
            employee=self.mani,
            work_date=date(2026, 10, 4),
            shifts=Decimal("0.25"),
            status="rejected",
            requested_by="Meena",
            reviewed_by="Sita",
            review_comment="Was on leave",
            approval_trail=[],
        )
        CompensationLedger.objects.create(
            employee=self.asha,
            entry_type="debit",
            shifts=Decimal("0.25"),
            date=date(2026, 10, 12),
            source="redemption",
            created_by="Meena",
            note="Compensation day",
        )
        body = self.report("month")
        section = self.section(body, "holiday_work")
        self.assertEqual(
            [(r["employeeCode"], r["date"], r["status"], r["shifts"]) for r in section["rows"]],
            [
                ("RP2", "2026-10-04", "pending", 1.0),
                ("RP3", "2026-10-04", "rejected", 0.25),
                ("RP1", "2026-10-11", "approved", 0.5),
            ],
        )
        done = section["rows"][2]
        self.assertEqual(
            (done["assignedBy"], done["approvedBy"], done["grantedOn"], done["reason"], done["detail"]),
            ("Meena", "Boss", "2026-10-12", "Dispatch", "Added to the compensation balance."),
        )
        rejected = section["rows"][1]
        self.assertEqual(
            (rejected["approvedBy"], rejected["grantedOn"], rejected["detail"]), (None, None, "Was on leave")
        )
        self.assertEqual(
            section["summary"],
            {
                "claims": 3,
                "pending": 1,
                "approved": 1,
                "rejected": 1,
                "approvedShifts": 0.5,
                "pendingShifts": 1.0,
                "redeemedShifts": 0.25,
                "employees": 3,
            },
        )
        redemption = section["redemptions"][0]
        self.assertEqual(
            (
                redemption["employeeCode"],
                redemption["date"],
                redemption["status"],
                redemption["shifts"],
                redemption["assignedBy"],
            ),
            ("RP1", "2026-10-12", "redeemed", 0.25, "Meena"),
        )

    def test_a_week_with_a_sunday_in_it(self):
        HolidayWorkClaim.objects.create(
            employee=self.asha, work_date=date(2026, 10, 11), shifts=Decimal("1.00"), approval_trail=[]
        )
        self.assertEqual(len(self.rows(self.report("week", "2026-10-07"), "holiday_work")), 1)  # Mon 5 - Sun 11
        self.assertEqual(self.rows(self.report("week", "2026-10-14"), "holiday_work"), [])  # Mon 12 - Sun 18


# ═════════════════════════════ birthday ═════════════════════════════


class BirthdayTests(ReportBase):
    def test_only_those_who_benefit_with_what_happened_on_the_day(self):
        _employee("RPB1", self.ho, self.cutting, dob=date(1990, 10, 14))  # today, nothing stored yet
        applied = _employee("RPB2", self.ho, self.cutting, dob=date(1990, 10, 12))
        _day(applied, date(2026, 10, 12), kind="birthday", first=time(10, 5), last=time(15, 0))
        _employee("RPB3", self.ho, self.cutting, dob=date(1990, 10, 15))  # tomorrow
        missed = _employee("RPB4", self.ho, self.cutting, dob=date(1990, 10, 13))
        _day(missed, date(2026, 10, 13), status="absent", shifts="0.00")  # the day passed without the marker
        _employee("RPB5", self.ho, self.cutting, dob=date(1990, 10, 18))  # a Sunday: already a day off
        body = self.report("week")
        section = self.section(body, "birthday")
        self.assertEqual(
            [(r["employeeCode"], r["date"], r["status"]) for r in section["rows"]],
            [
                ("RPB2", "2026-10-12", "applied"),
                ("RPB4", "2026-10-13", "not_applied"),
                ("RPB1", "2026-10-14", "pending"),
                ("RPB3", "2026-10-15", "pending"),
            ],
        )
        done = section["rows"][0]
        self.assertEqual(
            (done["shifts"], done["usedOn"], done["firstPunch"], done["assignedBy"]),
            (1.0, "2026-10-12", "10:05", "Automatic"),
        )
        self.assertEqual(
            section["summary"],
            {"birthdays": 4, "applied": 1, "pending": 2, "notApplied": 1, "shifts": 1.0, "employees": 4},
        )

    def test_nothing_is_reported_while_the_feature_is_off(self):
        _employee("RPB1", self.ho, self.cutting, dob=date(1990, 10, 14))
        CompensationConfig.objects.filter(pk=1).update(birthday_enabled=False)
        section = self.section(self.report("today"), "birthday")
        self.assertEqual((section["rows"], section["enabled"]), ([], False))

    def test_a_birthday_before_the_effective_date_is_not_a_benefit(self):
        _employee("RPB1", self.ho, self.cutting, dob=date(1990, 10, 14))
        CompensationConfig.objects.filter(pk=1).update(birthday_effective_from=date(2026, 10, 15))
        self.assertEqual(self.rows(self.report("today"), "birthday"), [])

    def test_a_declared_holiday_is_not_a_benefit_and_29_february_follows_the_calendar(self):
        _employee("RPB1", self.ho, self.cutting, dob=date(1990, 10, 14))
        Holiday.objects.create(name="Festival", date=date(2026, 10, 14))
        self.assertEqual(self.rows(self.report("today"), "birthday"), [])
        _employee("RPL", self.ho, self.cutting, dob=date(2000, 2, 29))
        self.assertEqual([r["date"] for r in self.rows(self.report("month", "2026-02-10"), "birthday")], ["2026-02-28"])
        self.assertEqual([r["date"] for r in self.rows(self.report("month", "2028-02-10"), "birthday")], ["2028-02-29"])


# ═════════════════════════════ periods, filters, scope ═════════════════════════════


class PeriodTests(ReportBase):
    def claim_dates(self, period, day):
        return [r["date"] for r in self.rows(self.report(period, day), "ot_shift_relaxation")]

    def make(self, *days):
        for i, d in enumerate(days):
            emp = _employee(f"RPD{i}", self.ho, self.cutting)
            _shift_rec(emp, d, "relaxation", d)

    def test_week_edges_monday_and_sunday(self):
        self.make(date(2026, 10, 11), date(2026, 10, 12), date(2026, 10, 18), date(2026, 10, 19))
        self.assertEqual(self.claim_dates("week", "2026-10-14"), ["2026-10-12", "2026-10-18"])
        self.assertEqual(self.claim_dates("week", "2026-10-12"), ["2026-10-12", "2026-10-18"])  # asking on the Monday
        self.assertEqual(self.claim_dates("week", "2026-10-18"), ["2026-10-12", "2026-10-18"])  # asking on the Sunday
        self.assertEqual(self.claim_dates("week", "2026-10-19"), ["2026-10-19"])
        self.assertEqual(self.claim_dates("week", "2026-10-11"), ["2026-10-11"])

    def test_month_ends(self):
        self.make(date(2026, 9, 30), date(2026, 10, 1), date(2026, 10, 31), date(2026, 11, 1))
        self.assertEqual(self.claim_dates("month", "2026-10-14"), ["2026-10-01", "2026-10-31"])
        self.assertEqual(self.claim_dates("month", "2026-10-01"), ["2026-10-01", "2026-10-31"])
        self.assertEqual(self.claim_dates("month", "2026-10-31"), ["2026-10-01", "2026-10-31"])
        self.assertEqual(self.claim_dates("month", "2026-09-15"), ["2026-09-30"])
        self.assertEqual(self.claim_dates("month", "2026-11-30"), ["2026-11-01"])

    def test_a_month_that_ends_in_february(self):
        self.make(date(2028, 2, 29), date(2028, 3, 1), date(2028, 2, 1))
        self.assertEqual(self.claim_dates("month", "2028-02-10"), ["2028-02-01", "2028-02-29"])
        body = self.report("month", "2028-02-10")
        self.assertEqual((body["from"], body["to"]), ("2028-02-01", "2028-02-29"))

    def test_today_is_one_day(self):
        self.make(date(2026, 10, 13), date(2026, 10, 14), date(2026, 10, 15))
        self.assertEqual(self.claim_dates("today", None), ["2026-10-14"])  # the default date is today
        self.assertEqual(self.claim_dates("today", "2026-10-15"), ["2026-10-15"])
        body = self.report("today")
        self.assertEqual((body["from"], body["to"], body["date"]), ("2026-10-14", "2026-10-14", "2026-10-14"))

    def test_the_default_period_is_today(self):
        r = self.client.get(URL, **self.admin)
        self.assertEqual(r.status_code, 200)
        self.assertEqual((r.json()["period"], r.json()["from"]), ("today", "2026-10-14"))

    def test_bad_parameters(self):
        for params in (
            {"period": "year"},
            {"date": "14/10/2026"},
            {"type": "nope"},
            {"departmentId": "x"},
            {"branchId": "x"},
            {"type": ","},
        ):
            r = self.client.get(URL, params, **self.admin)
            self.assertEqual(r.status_code, 400, params)
            self.assertIn("error", r.json())


class FilterTests(ReportBase):
    def setUp(self):
        super().setUp()
        _shift_rec(self.asha, date(2026, 10, 5), "relaxation", date(2026, 10, 14))
        _shift_rec(self.ravi, date(2026, 10, 6), "relaxation", date(2026, 10, 14))
        _shift_rec(self.mani, date(2026, 10, 7), "relaxation", date(2026, 10, 14))
        _employee("RPB1", self.ho, self.finishing, dob=date(1990, 10, 14))
        HolidayWorkClaim.objects.create(
            employee=self.asha, work_date=date(2026, 10, 12), shifts=Decimal("1.00"), approval_trail=[]
        )

    def codes(self, body, type_="ot_shift_relaxation"):
        return sorted(r["employeeCode"] for r in self.rows(body, type_))

    def test_type_limits_the_sections(self):
        only = self.report("week", type="birthday")
        self.assertEqual([s["type"] for s in only["sections"]], ["birthday"])
        self.assertEqual(only["types"], ["birthday"])
        two = self.report("week", type="holiday_work,ot_shift_relaxation")
        self.assertEqual(
            [s["type"] for s in two["sections"]], ["ot_shift_relaxation", "holiday_work"]
        )  # always the same order
        self.assertEqual(len(self.report("week", type="all")["sections"]), 7)
        self.assertEqual(len(self.report("week", type="")["sections"]), 7)

    def test_department_and_branch(self):
        self.assertEqual(self.codes(self.report("week")), ["RP1", "RP2", "RP3"])
        self.assertEqual(self.codes(self.report("week", departmentId=self.cutting.id)), ["RP1"])
        self.assertEqual(self.codes(self.report("week", branchId=self.u2.id)), ["RP3"])
        self.assertEqual(self.codes(self.report("week", branchId=self.ho.id)), ["RP1", "RP2"])
        self.assertEqual(self.codes(self.report("week", branchId=self.ho.id, departmentId=self.finishing.id)), ["RP2"])
        # the same filters narrow the birthday and holiday sections
        narrowed = self.report("week", departmentId=self.finishing.id)
        self.assertEqual(self.codes(narrowed, "birthday"), ["RPB1"])
        self.assertEqual(self.codes(narrowed, "holiday_work"), [])
        self.assertEqual(narrowed["filters"], {"departmentId": self.finishing.id, "branchId": None})

    def test_a_branch_scoped_user_only_sees_their_branch(self):
        self.assertEqual(self.codes(self.report("week", who=self.ho_hr)), ["RP1", "RP2"])
        self.assertEqual(self.codes(self.report("week", who=self.ho_hr, branchId=self.u2.id)), [])
        self.assertEqual(self.codes(self.report("week", who=self.ho_hr), "birthday"), ["RPB1"])

    def test_production_is_left_out_of_every_section(self):
        _allowance(self.prod, date(2026, 10, 12))
        _shift_rec(self.prod, date(2026, 10, 6), "pay", date(2026, 10, 13))
        _shift_rec(self.prod, date(2026, 10, 7), "relaxation", date(2026, 10, 14))
        _day(self.prod, date(2026, 10, 13), kind="window_late_in")
        _day(self.prod, date(2026, 10, 14), kind="window_early_out")
        HolidayWorkClaim.objects.create(
            employee=self.prod, work_date=date(2026, 10, 12), shifts=Decimal("1.00"), approval_trail=[]
        )
        CompensationLedger.objects.create(
            employee=self.prod, entry_type="debit", shifts=Decimal("1.00"), date=date(2026, 10, 12)
        )
        self.prod.date_of_birth = date(1990, 10, 14)
        self.prod.save()
        body = self.report("week")
        self.assertNotIn("RPP", {r["employeeCode"] for s in body["sections"] for r in s["rows"]})
        self.assertEqual(self.section(body, "holiday_work")["redemptions"], [])


class AccessTests(ReportBase):
    def test_permissions(self):
        self.assertEqual(self.client.get(URL, **self.no_access).status_code, 403)
        self.assertEqual(self.client.get(URL, **self.view_only).status_code, 200)
        self.assertEqual(self.client.get(URL).status_code, 401)
        employee = _bearer({"role": "employee", "employeeId": self.asha.id})
        r = self.client.get(URL, **employee)
        self.assertEqual((r.status_code, r.json()["error"]), (403, "HR access required"))
        self.assertEqual(self.client.post(URL, {}, content_type="application/json", **self.admin).status_code, 405)

    def test_it_only_reads(self):
        _allowance(self.asha, date(2026, 10, 12))
        counts = (OvertimeRecord.objects.count(), AttendanceDayRecord.objects.count(), HolidayWorkClaim.objects.count())
        self.report("month")
        self.assertEqual(
            counts,
            (OvertimeRecord.objects.count(), AttendanceDayRecord.objects.count(), HolidayWorkClaim.objects.count()),
        )


class QueryCountTests(ReportBase):
    def seed(self, people):
        """Rows in every section for each of `people` (bulk-created: the test is about the report's queries)."""
        OvertimeRecord.objects.bulk_create(
            [
                OvertimeRecord(
                    employee=e,
                    date=date(2026, 10, 12),
                    shift_end_time=time(17, 30),
                    last_punch_out=time(18, 40),
                    ot_minutes=70,
                    status="auto",
                    ot_type="allowance",
                    allowance_minutes=30,
                )
                for e in people
            ]
            + [
                OvertimeRecord(
                    employee=e,
                    date=date(2026, 10, 6),
                    shift_end_time=time(17, 30),
                    last_punch_out=time(20, 50),
                    ot_minutes=200,
                    status="announced",
                    ot_type="shift",
                    compensation_type="relaxation" if i % 2 else "pay",
                    shifts=Decimal("0.50"),
                    claim_date=date(2026, 10, 14),
                    announced_by="Meena",
                    announced_at=_ist(2026, 10, 7),
                )
                for i, e in enumerate(people)
            ]
        )
        AttendanceDayRecord.objects.bulk_create(
            [
                AttendanceDayRecord(
                    employee=e,
                    date=date(2026, 10, 13),
                    status="present",
                    compensation_kind="ot_allowance",
                    compensation_minutes=10,
                )
                for e in people
            ]
            + [
                AttendanceDayRecord(
                    employee=e, date=date(2026, 10, 14), status="present", compensation_kind="window_late_in"
                )
                for e in people
            ]
            + [
                AttendanceDayRecord(
                    employee=e, date=date(2026, 10, 15), status="present", compensation_kind="window_early_out"
                )
                for e in people
            ]
        )
        HolidayWorkClaim.objects.bulk_create(
            [
                HolidayWorkClaim(employee=e, work_date=date(2026, 10, 11), shifts=Decimal("0.50"), approval_trail=[])
                for e in people
            ]
        )
        CompensationLedger.objects.bulk_create(
            [
                CompensationLedger(employee=e, entry_type="debit", shifts=Decimal("0.25"), date=date(2026, 10, 13))
                for e in people
            ]
        )

    def test_the_number_of_queries_does_not_depend_on_the_number_of_employees(self):
        CompensationDayAnnouncement.objects.create(
            date=date(2026, 10, 14), kind="late_in", allowed_time=time(10, 0), reason="x"
        )
        small_people = [self.asha, self.ravi, self.mani]
        self.asha.date_of_birth = date(1990, 10, 14)  # so the birthday section does its queries in both runs
        self.asha.save()
        _employee("RPSAT", self.ho, self.cutting, dob=date(1990, 10, 17))  # a Saturday: the shift assignment is read
        self.seed(small_people)
        with CaptureQueriesContext(connection) as small:
            small_body = self.report("month")
        Employee.objects.bulk_create(
            [
                Employee(
                    employee_code=f"RPQ{i}",
                    first_name="Q",
                    last_name=str(i),
                    employment_type="staff",
                    status="active",
                    branch=self.ho,
                    department=self.cutting,
                    salary_amount=Decimal("20000"),
                    date_of_birth=date(1990, 10, 1 + i % 28),
                )
                for i in range(250)
            ]
        )
        big_people = list(Employee.objects.filter(employee_code__startswith="RPQ"))
        self.seed(big_people)
        with CaptureQueriesContext(connection) as large:
            large_body = self.report("month")
        self.assertGreaterEqual(large_body["totals"]["rows"], 250 * 5)
        self.assertGreater(large_body["totals"]["rows"], small_body["totals"]["rows"] * 10)
        self.assertEqual(len(large), len(small))
        self.assertLessEqual(len(large), 45)

"""
Fixes of review group R (the reports and every reader of the compensation data): findings #22 #26 #27 #33 #34 #35
#39 #40 #42 #43 #44 #47 #48 #49 (#36 is the same defect as #47, #45 the same as #35) and the MD late-minutes half of #28.

Run via: python manage.py test api.tests_comp_fix_r -v 2
"""

from datetime import date, time
from decimal import Decimal
from types import SimpleNamespace

from django.test import SimpleTestCase, TestCase

from . import tests_compensation_reports as hist
from . import tests_md_attendance as md_att
from .compensation_reports_views import ROW_KEYS
from .md_portal.analytics import punches as md_punches
from .md_portal.common import Scope
from .models import (
    AttendanceDayRecord,
    Branch,
    CompensationDayAnnouncement,
    Department,
    HRUser,
    OvertimeRecord,
    PayrollSettings,
    SalarySlip,
)
from .payroll_insights import ot_shifts_beyond_days
from .payroll_views import _generate_staff_payroll
from .reporting.definitions.attendance_core_data import late_minutes
from .tests_reporting_payroll_statutory import ANNOUNCED, _headers, _present_all, _staff


def _pay_record(emp, day, shifts, *, ot_type="shift", announced_at=ANNOUNCED):
    """An announced Pay record: Type 2 (`shifts` 0.25 / 0.50 ...) or, with ot_type legacy, one from before the overhaul."""
    return OvertimeRecord.objects.create(
        employee=emp,
        date=day,
        shift_end_time=time(17, 30),
        last_punch_out=time(20, 50),
        ot_minutes=200,
        status="announced",
        compensation_type="pay",
        announced_by="HR One",
        announced_at=announced_at,
        ot_type=ot_type,
        shifts=Decimal(shifts) if shifts is not None else None,
        suggested_shifts=Decimal(shifts) if shifts is not None else None,
    )


class _ReportCenter(TestCase):
    def run_report(self, report_id, **params):
        r = self.client.get(f"/api/reports/run/{report_id}", params, **_headers(self.admin))
        self.assertEqual(r.status_code, 200, r.content[:300])
        return r.json()

    @staticmethod
    def data_rows(body):
        return [r for r in body["rows"] if r.get("_kind") is None]


# ═════════════════════ #33 #44 #26 #35 #45: the Overtime Register / Payment Summary ═════════════════════


class OvertimeReportsTests(_ReportCenter):
    """February 2026 (24 Mon-Sat days, salary 24,000: daily rate 1,000): a Type 2 pay record of 0.25 shift and one old
    whole-day record in the slip (1,250 paid), a Type 1 allowance row, and a 0.50 shift record assigned AFTER payroll."""

    @classmethod
    def setUpTestData(cls):
        ps = PayrollSettings.get()
        ps.attendance_mode = "simple"
        ps.compensation_feature_enabled = True
        ps.ot_detection_enabled = True
        ps.min_wage_rate = Decimal("0")
        ps.save()
        cls.branch = Branch.objects.create(name="FR Unit", code="FRU")
        cls.dept = Department.objects.create(name="FR CUTTING", branch=cls.branch)
        cls.emp = _staff("4001", "24000", cls.dept, cls.branch)
        _present_all(cls.emp)
        _pay_record(cls.emp, date(2026, 2, 2), "0.25")
        OvertimeRecord.objects.create(  # Type 1: the next-day late-in allowance (informational, never paid)
            employee=cls.emp,
            date=date(2026, 2, 3),
            shift_end_time=time(17, 30),
            last_punch_out=time(18, 40),
            ot_minutes=70,
            status="auto",
            ot_type="allowance",
            allowance_minutes=30,
        )
        _pay_record(cls.emp, date(2026, 2, 4), None, ot_type="legacy")  # from before the overhaul: one whole day
        _generate_staff_payroll(cls.emp, 2, 2026)
        _pay_record(cls.emp, date(2026, 2, 5), "0.50")  # assigned after the slip was generated
        cls.admin = HRUser.objects.create(username="fr_admin", password_hash="x", is_super_admin=True)

    FEB = {"dateFrom": "2026-02-01", "dateTo": "2026-02-28"}

    def test_the_slip_pays_shifts_x_the_daily_rate(self):
        slip = SalarySlip.objects.get(employee=self.emp, month=2, year=2026)
        self.assertEqual(slip.ot_amount, Decimal("1250.00"))
        earn = slip.breakdown_details["earnings"]
        self.assertEqual((earn["otDays"], earn["otShifts"]), (2, 1.25))

    def test_the_register_lists_the_type_1_allowance_instead_of_crashing(self):
        body = self.run_report("overtime-register", **self.FEB)  # was a KeyError 'auto' (HTTP 500)
        rows = self.data_rows(body)
        auto = [r for r in rows if r["status"] == "Automatic"]
        self.assertEqual(len(auto), 1)
        self.assertEqual((auto[0]["payableAmount"], auto[0]["outcome"]), (None, "Allowance 30 min"))
        self.assertEqual({s["label"]: s["value"] for s in body["summary"]}["Automatic (allowance)"], 1)
        only = self.data_rows(self.run_report("overtime-register", status="auto", **self.FEB))
        self.assertEqual([r["date"] for r in only], ["2026-02-03"])

    def test_the_register_prices_a_pay_record_by_its_shifts(self):
        body = self.run_report("overtime-register", **self.FEB)
        pay = [r for r in self.data_rows(body) if r["compensationType"] == "Pay"]
        self.assertEqual(
            [(r["date"][-2:], r["payableAmount"]) for r in pay], [("02", 250.0), ("04", 1000.0), ("05", 500.0)]
        )
        # the slip holds 1.25 of the 1.75 shifts assigned for the month
        self.assertEqual({r["outcome"] for r in pay}, {"Partly paid"})
        s = {x["label"]: x["value"] for x in body["summary"]}
        self.assertEqual((s["Payable (where a slip exists)"], s["Pay days awaiting payroll"]), (1750.0, 1))
        self.assertEqual(body["totals"]["payableAmount"], 1750.0)

    def test_the_payment_summary_uses_shifts_for_expected_and_pending_money(self):
        row = self.data_rows(self.run_report("overtime-payment-summary", period="2026-02"))[0]
        self.assertEqual(
            (
                row["announcedPayDays"],
                row["dailyRate"],
                row["expectedOtPay"],
                row["slipOtAmount"],
                row["pendingPayDays"],
                row["pendingPayAmount"],
            ),
            (3, 1000.0, 1750.0, 1250.0, 1, 500.0),
        )

    def test_an_older_slip_without_ot_shifts_still_compares_by_days(self):
        slip = SalarySlip.objects.get(employee=self.emp, month=2, year=2026)
        earn = slip.breakdown_details["earnings"]
        del earn["otShifts"]  # a slip generated before the shift-based rules: otDays only
        slip.save()
        OvertimeRecord.objects.filter(employee=self.emp, date=date(2026, 2, 5)).delete()
        OvertimeRecord.objects.filter(employee=self.emp, date=date(2026, 2, 2)).update(shifts=None, ot_type="legacy")
        pay = [
            r
            for r in self.data_rows(self.run_report("overtime-register", **self.FEB))
            if r["compensationType"] == "Pay"
        ]
        self.assertEqual({(r["outcome"], r["payableAmount"]) for r in pay}, {("Paid in slip", 1000.0)})


# ═════════════════════ #42 #49: the announcements report names windows by kind ═════════════════════


class AnnouncementsReportTests(_ReportCenter):
    @classmethod
    def setUpTestData(cls):
        ps = PayrollSettings.get()
        ps.compensation_feature_enabled = True
        ps.save()
        cls.admin = HRUser.objects.create(username="fr_admin_ann", password_hash="x", is_super_admin=True)

    def test_a_late_in_window_is_not_a_whole_day(self):
        make = CompensationDayAnnouncement.objects.create
        make(date=date(2026, 3, 2), kind="late_in", allowed_time=time(10, 30), reason="Rain", announced_by="HR One")
        make(
            date=date(2026, 3, 3),
            kind="early_out",
            allowed_time=time(16, 0),
            leave_until_time=time(16, 0),
            reason="Power cut",
            announced_by="HR One",
        )
        make(date=date(2026, 3, 4), reason="Festival", announced_by="HR One")  # the legacy kind: a whole day
        body = self.run_report("compensation-day-announcements", when="all")
        rows = {r["date"]: r for r in self.data_rows(body)}
        late = rows["2026-03-02"]
        self.assertEqual(
            (late["releaseType"], late["windowTime"], late["leaveUntilTime"]), ("Late-in window", "10:30", None)
        )
        self.assertEqual(
            (rows["2026-03-03"]["releaseType"], rows["2026-03-03"]["windowTime"]), ("Early-out window", "16:00")
        )
        self.assertEqual((rows["2026-03-04"]["releaseType"], rows["2026-03-04"]["windowTime"]), ("Whole day", None))
        s = {x["label"]: x["value"] for x in body["summary"]}
        self.assertEqual((s["Whole-day"], s["Late-in windows"], s["Early-out windows"]), (1, 1, 1))


# ═════════════════════ #27 #34 #36 #47 and the extra keys: History & Reports ═════════════════════


class HistoryReportTests(hist.ReportBase):
    def test_an_allowance_is_filed_under_the_day_it_was_used_even_when_another_marker_outranks_it(self):
        hist._allowance(self.asha, date(2026, 10, 12), allowance=30, extra=70)
        # a late-in window outranks the allowance as the stored kind; only the minutes say the allowance was used
        hist._day(self.asha, date(2026, 10, 13), kind="window_late_in", minutes=20, first=time(10, 20))
        rows = self.rows(self.report("today", "2026-10-13"), "ot_allowance")
        self.assertEqual(
            [(r["employeeCode"], r["date"], r["workDate"], r["usedOn"], r["status"], r["minutesUsed"]) for r in rows],
            [("RP1", "2026-10-13", "2026-10-12", "2026-10-13", "used", 20)],
        )
        self.assertEqual(self.rows(self.report("today", "2026-10-12"), "ot_allowance"), [])  # benefited on the 13th

    def test_a_pay_record_without_a_claim_date_is_reported_under_its_ot_day(self):
        hist._shift_rec(self.ravi, date(2026, 10, 6), "pay", None, shifts="0.50")
        rows = self.rows(self.report("week", "2026-10-06"), "ot_shift_pay")
        self.assertEqual(
            [(r["employeeCode"], r["date"], r["workDate"], r["shifts"], r["status"], r["amount"]) for r in rows],
            [("RP2", "2026-10-06", "2026-10-06", 0.5, "pending_payroll", 400.0)],
        )

    def test_in_payroll_compares_the_slip_with_everything_assigned_for_the_month(self):
        hist._shift_rec(
            self.ravi, date(2026, 10, 5), "pay", date(2026, 10, 12), shifts="0.50", at=hist._ist(2026, 10, 6)
        )
        hist._shift_rec(
            self.ravi, date(2026, 10, 9), "pay", date(2026, 10, 13), shifts="1.00", at=hist._ist(2026, 10, 10)
        )
        SalarySlip.objects.create(  # generated when only the first one existed: 0.5 shift paid
            employee=self.ravi,
            month=10,
            year=2026,
            slip_number="SS/RP2/2026/10",
            ot_amount=Decimal("500.00"),
            breakdown_details={"earnings": {"dailyRate": 1000.0, "otDays": 1, "otShifts": 0.5, "otAmount": 500.0}},
        )
        body = self.report("week")
        rows = {r["workDate"]: r for r in self.rows(body, "ot_shift_pay")}
        self.assertEqual(
            (rows["2026-10-05"]["status"], rows["2026-10-09"]["status"]), ("in_payroll", "pending_payroll")
        )
        summary = self.section(body, "ot_shift_pay")["summary"]
        self.assertEqual((summary["inPayroll"], summary["pendingPayroll"]), (1, 1))

    def test_rows_say_extra_minutes_and_allowance_minutes_explicitly(self):
        hist._allowance(self.asha, date(2026, 10, 12), allowance=30, extra=70)
        hist._shift_rec(self.ravi, date(2026, 10, 6), "relaxation", date(2026, 10, 14), shifts="0.50", extra=200)
        hist._day(self.asha, date(2026, 10, 13), kind="window_late_in")
        body = self.report("week")
        self.assertEqual(body["rowKeys"][-2:], ["extraMinutes", "allowanceMinutes"])
        self.assertEqual(ROW_KEYS[-2:], ("extraMinutes", "allowanceMinutes"))
        allowance = self.rows(body, "ot_allowance")[0]
        self.assertEqual((allowance["minutes"], allowance["extraMinutes"], allowance["allowanceMinutes"]), (30, 70, 30))
        relaxation = self.rows(body, "ot_shift_relaxation")[0]
        self.assertEqual(
            (relaxation["minutes"], relaxation["extraMinutes"], relaxation["allowanceMinutes"]), (200, 200, None)
        )
        window = self.rows(body, "window_late_in")[0]
        self.assertEqual((window["extraMinutes"], window["allowanceMinutes"]), (None, None))


# ═════════════════════ #39: paid birthday / relaxation days are not "present without punches" ═════════════════════


class PaidWithoutPunchesTests(_ReportCenter):
    @classmethod
    def setUpTestData(cls):
        branch = Branch.objects.create(name="FR Unit 3", code="FR3")
        dept = Department.objects.create(name="FR SEWING", branch=branch)
        cls.emp = _staff("4101", "24000", dept, branch)
        for day, kind in ((date(2026, 8, 12), ""), (date(2026, 8, 13), "birthday"), (date(2026, 8, 14), "relaxation")):
            AttendanceDayRecord.objects.create(
                employee=cls.emp,
                date=day,
                status="present",
                shifts_earned=Decimal("1.00"),
                source="auto",
                compensation_kind=kind,
            )
        cls.admin = HRUser.objects.create(username="fr_admin_punch", password_hash="x", is_super_admin=True)

    def test_the_report_center_flags_only_the_leftover_presence_entry(self):
        body = self.run_report(
            "punch-exceptions", dateFrom="2026-08-12", dateTo="2026-08-14", exceptionType="present_no_punches"
        )
        self.assertEqual([r["date"] for r in self.data_rows(body)], ["2026-08-12"])

    def test_the_md_coverage_counter_leaves_them_out_too(self):
        data = md_punches._coverage_core(Scope(), date(2026, 8, 12), date(2026, 8, 14), {})
        self.assertEqual(data["presentWithoutPunches"], 1)


# ═════════════════════ #40: payroll explanations of fractional OT pay ═════════════════════


class OtPayWordingTests(TestCase):
    def test_shifts_that_are_not_one_day_per_record_are_named(self):
        self.assertEqual(ot_shifts_beyond_days({"otShifts": 0.5}, 2), Decimal("0.5"))  # 2 records of 0.25 shift
        self.assertIsNone(ot_shifts_beyond_days({"otShifts": 2.0}, 2))  # whole days: the old wording stays true
        self.assertIsNone(ot_shifts_beyond_days({"otDays": 2}, 2))  # a slip from before the shift-based rules


# ═════════════════════ #28 (MD half): late minutes with a next-day allowance or a window ═════════════════════


class MdLateMinutesTests(md_att.World):
    def test_minutes_late_start_from_the_start_the_allowance_moved(self):
        # 09:00 start, 30 minutes of allowance used: a 09:50 arrival is 20 minutes late, not 50
        AttendanceDayRecord.objects.filter(employee=self.e1, date=md_att.d(8)).update(
            first_punch=time(9, 50), compensation_kind="ot_allowance", compensation_minutes=30
        )
        self.assertEqual(self.metrics()["avgLateMinutes"]["value"], 30.0)  # (20 + 20 + 30 + 50) / 4

    def test_a_day_whose_start_a_window_moved_is_not_guessed(self):
        AttendanceDayRecord.objects.filter(employee=self.e3, date=md_att.d(11)).update(
            compensation_kind="window_late_in"
        )
        self.assertEqual(self.metrics()["avgLateMinutes"]["value"], 30.0)  # (40 + 20 + 30) / 3, the 50 is left out


# ═════════════════════ #28 (Report Center half): the same minutes in the Late Coming report ═════════════════════


class ReportCenterLateMinutesTests(SimpleTestCase):
    SHIFT = SimpleNamespace(start_time=time(9, 0))
    STAFF = SimpleNamespace(employment_type="staff")

    def rec(self, first, **over):
        base = dict(
            is_late=True,
            first_punch=first,
            morning_permission_applied=False,
            compensation_kind="",
            compensation_minutes=0,
        )
        base.update(over)
        return SimpleNamespace(**base)

    def minutes(self, rec):
        return late_minutes(rec, self.SHIFT, self.STAFF, None)

    def test_a_plain_late_day_counts_from_the_shift_start(self):
        self.assertEqual(self.minutes(self.rec(time(9, 50))), 50)

    def test_a_used_allowance_moves_the_start_later(self):
        self.assertEqual(
            self.minutes(self.rec(time(9, 50), compensation_kind="ot_allowance", compensation_minutes=30)), 20
        )

    def test_a_company_window_day_is_not_measured(self):
        self.assertIsNone(self.minutes(self.rec(time(9, 50), compensation_kind="window_late_in")))

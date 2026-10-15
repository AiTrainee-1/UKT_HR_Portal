"""
Fixes of review group R (the reports and every reader of the compensation data): findings #22 #26 #27 #33 #34 #35
#39 #40 #42 #43 #44 #47 #48 #49 (#36 is the same defect as #47, #45 the same as #35) and the MD late-minutes half of #28.

Run via: python manage.py test api.tests_comp_fix_r -v 2
"""

from datetime import date, time
from decimal import Decimal
from types import SimpleNamespace

from django.test import SimpleTestCase, TestCase

from . import tests_compensation_engine as eng
from . import tests_compensation_reports as hist
from . import tests_md_attendance as md_att
from .attendance_final import compute_range_records, late_pool_summary, month_summary_from_records
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
from .reporting.definitions.attendance_core_data import early_minutes, late_minutes
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


# ═════════ the Report Center attendance reports honour the day's compensation marker (late minutes, counts) ═════════


MAR_FIRST, MAR_LAST = date(2026, 3, 1), date(2026, 3, 14)
FIRST_14 = {"dateFrom": "2026-03-01", "dateTo": "2026-03-14"}
HALF, HALF_MORNING = "½", "½M"  # the muster codes of a half day


class _MarkerMonth(eng.CompBase, _ReportCenter):
    """March 2026 on the 08:30-17:30 shift (10 min grace, first half to 13:00), three staff, every compensation feature on,
    stored through the real attendance engine (days 1-14):

    CE1  Mon 2   worked to 18:30 -> a 30 min next-day allowance
         Tue 3   first punch 09:50: Late even from the allowance-shifted start 09:00 (50 min, 40 past the 09:10 deadline)
         Wed 4   no punches, a 0.50 relaxation -> a paid Half Shift (no punches at all)
         Fri 6   first punch 08:55: a plain Late day (25 min from 08:30)
         Thu 12  no punches, a 1.00 relaxation -> a paid full day
    CE2  Thu 5   BIRTHDAY, punches 11:00 and 12:30 only: still a paid full day, nothing detected
    CE3  Wed 11  an announced late-in 10:30 (no grace): first punch 10:45 is Late against it (the record keeps no start)
         Thu 12  an announced early-out 16:00 (no grace): leaves 15:30, an Early-Out against it, and a Half Shift"""

    def setUp(self):
        super().setUp()
        self.on(allowance_enabled=True, windows_enabled=True, birthday_enabled=True, shift_enabled=True)
        self.admin = HRUser.objects.create(username="fr_admin_marker", password_hash="x", is_super_admin=True)
        self.e1 = self.emp
        self.e2 = self.new_staff("CE2", date_of_birth=date(1990, 3, 5), join_date="2025-01-01")
        self.e3 = self.new_staff("CE3")
        self.worked(eng.MON, time(18, 30), emp=self.e1)
        self.worked(eng.TUE, time(17, 40), emp=self.e1, first=time(9, 50))
        self.worked(eng.FRI, time(17, 40), emp=self.e1, first=time(8, 55))
        self.relax(self.e1, eng.MON, eng.WED, "0.50")
        self.relax(self.e1, eng.TUE, date(2026, 3, 12), "1.00")
        self.punch(eng.THU, time(11, 0), time(12, 30), emp=self.e2)
        self.announce(date(2026, 3, 11), "late_in", time(10, 30))
        self.announce(date(2026, 3, 12), "early_out", time(16, 0))
        self.worked(date(2026, 3, 11), time(18, 30), emp=self.e3, first=time(10, 45))
        self.worked(date(2026, 3, 12), time(15, 30), emp=self.e3, first=time(8, 35))
        for emp in (self.e1, self.e2, self.e3):
            compute_range_records(emp, MAR_FIRST, MAR_LAST, PayrollSettings.get())

    @staticmethod
    def relax(emp, earned, claim, shifts):
        OvertimeRecord.objects.create(
            employee=emp,
            date=earned,
            last_punch_out=time(21, 0),
            ot_minutes=210,
            status="announced",
            compensation_type="relaxation",
            ot_type="shift",
            shifts=Decimal(shifts),
            claim_date=claim,
        )

    def stored_row(self, emp, day):
        return AttendanceDayRecord.objects.get(employee=emp, date=day)

    def month_records(self, emp):
        return list(AttendanceDayRecord.objects.filter(employee=emp, date__gte=MAR_FIRST, date__lte=MAR_LAST))

    def keyed(self, body):
        return {(r["employeeCode"], r["date"]): r for r in self.data_rows(body)}

    def by_code(self, body):
        return {r["employeeCode"]: r for r in self.data_rows(body)}

    def card(self, body, label):
        return next(s["value"] for s in body["summary"] if s["label"] == label)


class MarkerFixtureTests(_MarkerMonth):
    """Guards every figure below: the engine really stored the markers the reports are asked to honour."""

    def test_the_engine_stored_the_markers_the_reports_must_honour(self):
        allowance = self.stored_row(self.e1, eng.TUE)
        self.assertEqual(
            (allowance.is_late, allowance.compensation_kind, allowance.compensation_minutes, allowance.status),
            (True, "ot_allowance", 30, "present"),
        )
        half = self.stored_row(self.e1, eng.WED)
        self.assertEqual(
            (half.status, half.shifts_earned, half.compensation_kind, half.first_punch, half.total_punches),
            ("half_shift", Decimal("0.50"), "relaxation", None, 0),
        )
        full = self.stored_row(self.e1, date(2026, 3, 12))
        self.assertEqual(
            (full.status, full.shifts_earned, full.compensation_kind), ("present", Decimal("1.00"), "relaxation")
        )
        plain = self.stored_row(self.e1, eng.FRI)
        self.assertEqual((plain.is_late, plain.compensation_kind, plain.compensation_minutes), (True, "", 0))
        birthday = self.stored_row(self.e2, eng.THU)
        self.assertEqual(
            (birthday.status, birthday.shifts_earned, birthday.compensation_kind),
            ("present", Decimal("1.00"), "birthday"),
        )
        self.assertFalse(any([birthday.is_late, birthday.early_leave, birthday.is_half_shift, birthday.late_afternoon]))
        late_window = self.stored_row(self.e3, date(2026, 3, 11))
        self.assertEqual((late_window.is_late, late_window.compensation_kind), (True, "window_late_in"))
        early_window = self.stored_row(self.e3, date(2026, 3, 12))
        self.assertEqual((early_window.early_leave, early_window.status), (True, "half_shift"))
        self.assertIn("company-announced early-out", early_window.late_reason)


class LateReportsHonourTheMarkerTests(_MarkerMonth):
    def detail(self, **params):
        return self.run_report("late-coming-detail", **{**FIRST_14, **params})

    def test_exactly_the_days_the_engine_flagged_late_are_listed(self):
        rows = self.keyed(self.detail())
        flagged = {
            (r.employee.employee_code, r.date.isoformat())
            for r in AttendanceDayRecord.objects.filter(is_late=True).select_related("employee")
        }
        self.assertEqual(set(rows), flagged)
        self.assertEqual(flagged, {("CE1", "2026-03-03"), ("CE1", "2026-03-06"), ("CE3", "2026-03-11")})
        # the birthday arrival at 11:00 would be Late on any ordinary day: the engine did not flag it, the report must not
        self.assertNotIn("CE2", {code for code, _day in rows})

    def test_an_allowance_day_is_measured_from_the_start_the_allowance_moved(self):
        row = self.keyed(self.detail())[("CE1", "2026-03-03")]
        self.assertEqual(
            (row["shiftStart"], row["graceMinutes"], row["deadline"], row["firstPunch"]),
            ("09:00", 10, "09:10", "09:50"),
        )
        # 09:50 is 50 minutes after 09:00 (the 08:30 start plus the 30 minute allowance), 40 after the 09:10 deadline
        self.assertEqual((row["lateMinutes"], row["beyondGrace"]), (50, 40))
        self.assertEqual(row["poolStatus"], "Counted")

    def test_a_plain_late_day_is_still_measured_from_the_shift_start(self):
        row = self.keyed(self.detail())[("CE1", "2026-03-06")]
        self.assertEqual(
            (row["shiftStart"], row["deadline"], row["lateMinutes"], row["beyondGrace"]), ("08:30", "08:40", 25, 15)
        )

    def test_an_announced_late_in_day_is_listed_but_not_measured(self):
        body = self.detail()
        row = self.keyed(body)[("CE3", "2026-03-11")]
        self.assertEqual(
            (row["firstPunch"], row["shiftStart"], row["graceMinutes"], row["deadline"]), ("10:45", None, None, None)
        )
        self.assertEqual((row["lateMinutes"], row["beyondGrace"]), (None, None))
        self.assertIn("company-announced late-in 10:30", row["reason"])
        self.assertTrue(any("announced late-in" in n for n in body["notes"]), body["notes"])

    def test_the_cards_count_the_flagged_days_and_measure_only_what_is_known(self):
        body = self.detail()
        self.assertEqual(self.card(body, "Late occurrences"), 3)
        self.assertEqual(self.card(body, "Employees affected"), 2)
        self.assertEqual(self.card(body, "Counted in late pool"), 3)
        self.assertEqual((self.card(body, "Average late (min)"), self.card(body, "Longest late (min)")), (37.5, 50))

    def test_the_minimum_filter_leaves_out_the_day_that_cannot_be_measured(self):
        rows = self.keyed(self.detail(minLate="30"))
        self.assertEqual(set(rows), {("CE1", "2026-03-03")})

    def test_the_monthly_counts_use_the_same_minutes_and_the_engines_pool(self):
        body = self.run_report("late-summary-counts", period="2026-03")
        rows = self.by_code(body)
        ce1 = rows["CE1"]
        self.assertEqual((ce1["lateDays"], ce1["lateIn"]), (2, 2))
        self.assertEqual((ce1["minutesTotal"], ce1["minutesAvg"], ce1["minutesMax"]), (75, 38, 50))
        self.assertEqual(ce1["worstDay"], "2026-03-03")
        ce3 = rows["CE3"]
        self.assertEqual((ce3["lateDays"], ce3["lateIn"], ce3["earlyOut"]), (1, 1, 1))
        # one flagged day that cannot be measured: unknown, never zero and never a guess
        self.assertEqual(
            (ce3["minutesTotal"], ce3["minutesAvg"], ce3["minutesMax"], ce3["worstDay"]), (None, None, None, None)
        )
        ce2 = rows["CE2"]
        self.assertEqual((ce2["lateDays"], ce2["lateIn"], ce2["minutesTotal"]), (0, 0, 0))
        # the same pool the engine (and payroll) computes from the stored days
        for emp in (self.e1, self.e2, self.e3):
            pool = late_pool_summary(self.month_records(emp), 0, PayrollSettings.get())
            row = rows[emp.employee_code]
            self.assertEqual(
                (row["lateIn"], row["earlyOut"], row["poolTotal"]), (pool["late_in"], pool["early_out"], pool["total"])
            )

    def test_the_penalty_breakdown_uses_the_same_pool(self):
        rows = self.by_code(self.run_report("late-penalty-breakdown", period="2026-03"))
        for emp in (self.e1, self.e2, self.e3):
            pool = late_pool_summary(self.month_records(emp), 0, PayrollSettings.get())
            self.assertEqual(rows[emp.employee_code]["poolTotal"], pool["total"], emp.employee_code)

    def test_the_monthly_counts_say_how_many_flagged_days_were_judged_against_an_announced_time(self):
        body = self.run_report("late-summary-counts", period="2026-03")
        # CE3's Mar 11 is the one flagged day judged against the announced 10:30; the early-out day is not a late day
        self.assertTrue(
            any("1 flagged day(s) were judged against a company-announced late-in time" in n for n in body["notes"]),
            body["notes"],
        )
        self.assertEqual(self.by_code(body)["CE3"]["lateDays"], 1)

    def test_the_detail_notes_name_the_announced_day_and_do_not_claim_the_shift_was_missing(self):
        body = self.detail()
        self.assertTrue(
            any("1 row(s) are days with a company-announced late-in time" in n for n in body["notes"]), body["notes"]
        )
        # the announced day has no minutes by design: it is not "a shift that could not be found"
        self.assertFalse(any("show no minutes" in n for n in body["notes"]), body["notes"])

    def test_an_allowance_day_whose_first_punch_is_now_inside_the_deadline_shows_the_moved_start(self):
        # the stored verdict says Late with a 30 minute allowance, but the (edited) record's first punch 09:05 is inside
        # the moved deadline 09:10: nothing can be measured, yet the start the engine used is still 08:30 + 30 minutes
        AttendanceDayRecord.objects.filter(employee=self.e1, date=eng.TUE).update(first_punch=time(9, 5))
        body = self.detail()
        row = self.keyed(body)[("CE1", "2026-03-03")]
        self.assertEqual((row["shiftStart"], row["graceMinutes"], row["firstPunch"]), ("09:00", 10, "09:05"))
        self.assertEqual((row["lateMinutes"], row["deadline"], row["beyondGrace"]), (None, None, None))
        # this one IS a row whose shift was edited after the day was computed: only it is counted as such, the announced
        # day (also without minutes) is not
        self.assertTrue(any("1 row(s) show no minutes" in n for n in body["notes"]), body["notes"])

    def test_an_announced_late_in_that_did_not_change_the_arrival_zone_is_still_not_measured(self):
        day = date(2026, 3, 9)  # a free Monday: the others have no punches that day
        e4 = self.new_staff("CE4")
        self.announce(day, "late_in", time(9, 0))
        self.worked(day, time(18, 0), emp=e4, first=time(9, 20))
        compute_range_records(e4, MAR_FIRST, MAR_LAST, PayrollSettings.get())
        stored = self.stored_row(e4, day)
        # the engine judged 09:20 against the announced 09:00 (no grace) and flagged it Late, but the window did not move
        # the arrival to another zone, so NO marker was stored: only the engine's own reason carries the announcement
        self.assertEqual((stored.is_late, stored.compensation_kind), (True, ""))
        self.assertIn("company-announced late-in", stored.late_reason)
        row = self.keyed(self.detail())[("CE4", "2026-03-09")]
        self.assertEqual(row["firstPunch"], "09:20")
        # measured from the 08:30 shift start that would be 50 minutes: it must stay unknown
        self.assertEqual(
            (row["lateMinutes"], row["shiftStart"], row["graceMinutes"], row["deadline"], row["beyondGrace"]),
            (None, None, None, None, None),
        )
        daily = self.keyed(self.run_report("daily-attendance", **FIRST_14))[("CE4", "2026-03-09")]
        self.assertIn("Announced late-in", daily["flags"])
        self.assertIsNone(daily["lateMinutes"])
        counts = self.by_code(self.run_report("late-summary-counts", period="2026-03"))["CE4"]
        self.assertEqual((counts["lateDays"], counts["minutesTotal"]), (1, None))

    def test_an_announced_early_out_day_is_listed_but_not_measured(self):
        body = self.run_report("early-out", **FIRST_14)
        rows = self.keyed(body)
        self.assertEqual(set(rows), {("CE3", "2026-03-12")})
        row = rows[("CE3", "2026-03-12")]
        self.assertEqual(
            (row["lastPunch"], row["shiftEnd"], row["deadline"], row["earlyMinutes"]), ("15:30", None, None, None)
        )
        self.assertIsNone(self.card(body, "Longest early (min)"))
        self.assertTrue(any("announced early-out" in n for n in body["notes"]), body["notes"])


class LateReportsHonourTheMarkerStrictTests(LateReportsHonourTheMarkerTests):
    """The same days in Strict mode (its own late-reason wording carries the same basis text)."""

    MODE = "strict"


class DayRegistersHonourTheMarkerTests(_MarkerMonth):
    def register(self, report_id):
        return self.keyed(self.run_report(report_id, **FIRST_14))

    def test_the_daily_register_measures_from_the_moved_start_and_explains_the_marker(self):
        rows = self.register("daily-attendance")
        allowance = rows[("CE1", "2026-03-03")]
        self.assertEqual((allowance["status"], allowance["lateMinutes"]), ("Present", 50))
        self.assertIn("Late", allowance["flags"].split("; "))
        self.assertIn("OT allowance used (30 min)", allowance["flags"])
        window = rows[("CE3", "2026-03-11")]
        self.assertEqual((window["status"], window["lateMinutes"]), ("Present", None))
        self.assertIn("Late", window["flags"].split("; "))
        self.assertIn("Announced late-in", window["flags"])
        early = rows[("CE3", "2026-03-12")]
        self.assertEqual((early["status"], early["earlyOutMinutes"]), ("Half Day", None))
        self.assertIn("Announced early-out", early["flags"])

    def test_a_birthday_is_a_paid_present_day_with_nothing_detected(self):
        row = self.register("daily-attendance")[("CE2", "2026-03-05")]
        self.assertEqual((row["status"], row["shiftsEarned"], row["punchCount"]), ("Present", 1.0, 2))
        self.assertEqual((row["lateMinutes"], row["earlyOutMinutes"]), (None, None))
        flags = row["flags"].split("; ")
        self.assertNotIn("Late", flags)
        self.assertNotIn("Early out", flags)
        self.assertIn("Birthday leave", row["flags"])

    def test_a_relaxation_day_is_a_paid_half_day_without_punches(self):
        row = self.register("daily-attendance")[("CE1", "2026-03-04")]
        self.assertEqual((row["status"], row["shiftsEarned"], row["punchCount"]), ("Half Day", 0.5, None))
        self.assertIn("Relaxation (compensation day)", row["flags"])

    def test_the_time_card_agrees_with_the_daily_register(self):
        card = self.register("time-card")
        daily = self.register("daily-attendance")
        for key in (("CE1", "2026-03-03"), ("CE3", "2026-03-11"), ("CE3", "2026-03-12"), ("CE2", "2026-03-05")):
            self.assertEqual(
                (card[key]["lateMinutes"], card[key]["earlyOutMinutes"], card[key]["status"]),
                (daily[key]["lateMinutes"], daily[key]["earlyOutMinutes"], daily[key]["status"]),
                key,
            )
        self.assertEqual(card[("CE1", "2026-03-03")]["lateMinutes"], 50)
        self.assertIn("Announced late-in", card[("CE3", "2026-03-11")]["remarks"])
        self.assertIn("Birthday leave", card[("CE2", "2026-03-05")]["remarks"])


class MonthCountsAgreeWithTheAttendanceSummaryTests(_MarkerMonth):
    """The engine's own month_summary_from_records (what the Attendance pages and payroll aggregate) against the muster,
    the monthly summary, the strength and the eligibility reports, for the same stored days."""

    def engine(self, emp):
        return month_summary_from_records(self.month_records(emp))

    def test_the_birthday_and_the_relaxations_count_as_paid_present_days(self):
        s1, s2 = self.engine(emp=self.e1), self.engine(emp=self.e2)
        # CE1: Mar 2, 3, 6 worked + the full relaxation on 12 = 4 present, the 0.50 relaxation = 1 half day
        self.assertEqual(
            (s1["present"], s1["halfShift"], s1["effectiveDays"], s1["totalShifts"]), (4, 1, "4.5", "4.50")
        )
        self.assertEqual((s2["present"], s2["halfShift"], s2["totalShifts"]), (1, 0, "1.00"))

    def test_the_muster_totals_equal_the_engine_summary(self):
        body = self.run_report("attendance-muster-sheet", **FIRST_14)
        rows = self.by_code(body)
        for emp in (self.e1, self.e2, self.e3):
            s = self.engine(emp)
            row = rows[emp.employee_code]
            self.assertEqual(
                (row["present"], row["half"], row["absent"], row["leave"], row["holiday"], row["late"]),
                (s["present"], s["halfShift"], s["absent"], s["onLeave"], s["holidays"], s["late"]),
                emp.employee_code,
            )
            self.assertEqual((row["effective"], row["shifts"]), (float(s["effectiveDays"]), float(s["totalShifts"])))
        strength = next(r for r in body["rows"] if r.get("employeeName") == "Strength")
        self.assertEqual(strength["d20260305"], 1)  # the birthday is a head present
        self.assertEqual(strength["d20260304"], 1)  # and so is the relaxation half day
        self.assertEqual(strength["d20260312"], 2)  # CE1's full relaxation + CE3's half day

    def test_the_muster_cells_of_the_marker_days(self):
        rows = self.by_code(self.run_report("attendance-muster-sheet", **FIRST_14))
        self.assertEqual(rows["CE2"]["d20260305"], "P")
        self.assertEqual(rows["CE1"]["d20260312"], "P")
        self.assertEqual(rows["CE1"]["d20260303"], "P")
        self.assertEqual(rows["CE3"]["d20260312"], HALF_MORNING)  # a real half day: worked the morning
        # a half day made up by a relaxation has no punches: neither half was worked (the Report Log sheet shows a plain
        # half there, never "half - evening worked")
        self.assertEqual(rows["CE1"]["d20260304"], HALF)

    def test_the_muster_counts_the_days_that_used_a_compensation_in_a_note(self):
        body = self.run_report("attendance-muster-sheet", **FIRST_14)
        notes = [n for n in body["notes"] if n.startswith("Days that used a compensation:")]
        self.assertEqual(len(notes), 1, body["notes"])
        # CE2's birthday, CE1's two relaxation days and its allowance day, CE3's announced late-in and early-out days
        self.assertTrue(
            notes[0].startswith(
                "Days that used a compensation: 1 birthday leave, 2 relaxation, 1 OT allowance, "
                "2 announced late-in / early-out."
            ),
            notes[0],
        )

    def test_the_muster_has_no_compensation_note_when_no_day_carries_a_marker(self):
        # Mon 9 and Tue 10 March: every employee has a stored record (so the days are counted) and none carries a marker
        body = self.run_report("attendance-muster-sheet", dateFrom="2026-03-09", dateTo="2026-03-10")
        self.assertEqual(len(self.data_rows(body)), 3)
        self.assertFalse(any("used a compensation" in n for n in body["notes"]), body["notes"])

    def test_the_monthly_summary_equals_the_engine_summary(self):
        rows = self.by_code(self.run_report("attendance-summary-monthly", period="2026-03"))
        for emp in (self.e1, self.e2, self.e3):
            s = self.engine(emp)
            row = rows[emp.employee_code]
            self.assertEqual(
                (row["presentDays"], row["halfDays"], row["absentDays"], row["leaveDays"], row["lateDays"]),
                (s["present"], s["halfShift"], s["absent"], s["onLeave"], s["late"]),
                emp.employee_code,
            )
            self.assertEqual(row["holidays"] + row["weeklyOff"], s["holidays"], emp.employee_code)
            self.assertEqual(
                (row["effectiveDays"], row["totalShifts"]), (float(s["effectiveDays"]), float(s["totalShifts"]))
            )
        # 26 payroll working days in March; CE1 earned 4.5 of them
        self.assertEqual((rows["CE1"]["workingDays"], rows["CE1"]["attendancePct"]), (26, round(4.5 * 100 / 26, 1)))
        self.assertEqual(rows["CE2"]["attendancePct"], round(1 * 100 / 26, 1))

    def test_the_daily_strength_counts_them_as_heads(self):
        body = self.run_report("department-strength", dateFrom="2026-03-04", dateTo="2026-03-05")
        rows = {r["date"]: r for r in self.data_rows(body)}
        mar4, mar5 = rows["2026-03-04"], rows["2026-03-05"]
        self.assertEqual((mar4["present"], mar4["halfDay"], mar4["absent"]), (0, 1, 2))
        self.assertEqual((mar5["present"], mar5["halfDay"], mar5["absent"]), (1, 0, 2))
        self.assertEqual((mar4["shiftCredit"], mar5["shiftCredit"]), (0.5, 1.0))
        self.assertEqual((mar4["late"], mar5["late"]), (0, 0))

    def test_the_shift_wise_summary_counts_them_too(self):
        body = self.run_report("shift-wise-attendance", dateFrom="2026-03-04", dateTo="2026-03-05")
        rows = {r["date"]: r for r in self.data_rows(body)}
        self.assertEqual((rows["2026-03-04"]["halfDay"], rows["2026-03-04"]["absent"]), (1, 2))
        self.assertEqual((rows["2026-03-05"]["present"], rows["2026-03-05"]["late"]), (1, 0))

    def test_the_absentee_analysis_counts_no_marker_day_as_absent(self):
        rows = self.by_code(self.run_report("absenteeism", **FIRST_14))
        for emp in (self.e1, self.e2, self.e3):
            self.assertEqual(rows[emp.employee_code]["absentDays"], self.engine(emp)["absent"], emp.employee_code)

    def test_perfect_attendance_counts_them_as_worked_days_and_never_as_late(self):
        rows = self.by_code(self.run_report("perfect-attendance", period="2026-03"))
        for emp in (self.e1, self.e2, self.e3):
            s = self.engine(emp)
            row = rows[emp.employee_code]
            self.assertEqual((row["presentDays"], row["halfDays"]), (s["present"], s["halfShift"]))
        self.assertEqual(rows["CE2"]["lateCount"], 0)  # the birthday, arriving at 11:00
        self.assertEqual(rows["CE1"]["lateCount"], 2)  # Mar 3 and Mar 6, the days the engine flagged
        self.assertEqual(rows["CE3"]["lateCount"], 2)  # the announced late-in day and the announced early-out day

    def test_the_form_12_register_counts_the_paid_days_as_days_worked(self):
        rows = self.by_code(self.run_report("form12-adult-workers-register", period="2026-03"))
        for emp in (self.e1, self.e2, self.e3):
            s = self.engine(emp)
            self.assertEqual(rows[emp.employee_code]["daysWorked"], s["present"] + s["halfShift"], emp.employee_code)


class HalfDayReportMarkerTests(_MarkerMonth):
    def test_a_relaxation_half_day_is_not_a_single_punch(self):
        body = self.run_report("half-day", **FIRST_14)
        rows = self.keyed(body)
        relax = rows[("CE1", "2026-03-04")]
        self.assertEqual((relax["firstPunch"], relax["lastPunch"], relax["punchCount"]), (None, None, 0))
        self.assertEqual(
            (relax["cause"], relax["halfWorked"], relax["shiftsEarned"]), ("Compensation relaxation", None, 0.5)
        )
        self.assertIn("Compensation relaxation", relax["note"])
        self.assertEqual(self.card(body, "Single-punch days"), 0)
        early = rows[("CE3", "2026-03-12")]
        self.assertEqual((early["cause"], early["halfWorked"]), ("Left early", "Morning"))

    def test_the_summary_view_counts_the_relaxation_cause(self):
        rows = self.by_code(self.run_report("half-day", view="summary", **FIRST_14))
        self.assertEqual((rows["CE1"]["halfDays"], rows["CE1"]["relaxation"], rows["CE1"]["singlePunch"]), (1, 1, 0))
        self.assertEqual((rows["CE3"]["halfDays"], rows["CE3"]["leftEarly"], rows["CE3"]["relaxation"]), (1, 1, 0))

    def test_the_cause_can_be_filtered(self):
        rows = self.keyed(self.run_report("half-day", cause="relaxation", **FIRST_14))
        self.assertEqual(set(rows), {("CE1", "2026-03-04")})


class WorkedHoursMarkerTests(_MarkerMonth):
    PARAMS = {"dateFrom": "2026-03-02", "dateTo": "2026-03-14"}

    def test_a_paid_birthday_or_relaxation_day_has_no_shortfall(self):
        rows = self.keyed(self.run_report("worked-hours-shortfall", view="daily", **self.PARAMS))
        birthday = rows[("CE2", "2026-03-05")]  # a 1.5 hour day, paid in full by the engine whatever the punches say
        self.assertEqual((birthday["workedHours"], birthday["basis"]), (1.5, "Span"))
        self.assertEqual(
            (birthday["scheduledHours"], birthday["shortfallHours"], birthday["excessHours"]), (None, None, None)
        )
        # the same day, worked normally, is measured against the schedule as ever
        normal = rows[("CE1", "2026-03-06")]
        self.assertEqual((normal["scheduledHours"], normal["workedHours"], normal["shortfallHours"]), (8.0, 7.75, 0.25))
        relaxed = rows[("CE1", "2026-03-04")]
        self.assertEqual(
            (relaxed["basis"], relaxed["workedHours"], relaxed["shortfallHours"]), ("Relaxation (paid)", None, None)
        )
        self.assertEqual(rows[("CE1", "2026-03-12")]["basis"], "Relaxation (paid)")

    def test_a_paid_day_without_punches_is_not_an_unknown_day(self):
        body = self.run_report("worked-hours-shortfall", view="summary", **self.PARAMS)
        ce1 = self.by_code(body)["CE1"]
        # worked Mar 2, 3 and 6; Mar 4 and 12 are relaxation days HR paid without punches: nothing is missing
        self.assertEqual((ce1["daysWorked"], ce1["daysUnknown"]), (3, 0))
        notes = [n for n in body["notes"] if "birthday" in n.lower() and "relaxation" in n.lower()]
        self.assertEqual(len(notes), 1, body["notes"])
        # a birthday is paid in full; a relaxation only tops the day up by what HR granted (a 0.50 one stays a half day)
        self.assertIn("a birthday is paid in full", notes[0])
        self.assertIn("a relaxation tops the day up by what HR granted", notes[0])
        self.assertNotIn("whatever the punches say", notes[0])
        self.assertTrue(notes[0].startswith("3 day(s) are paid birthday leave or relaxation days"), notes[0])

    def test_an_ordinary_present_day_without_punches_is_still_unknown(self):
        AttendanceDayRecord.objects.filter(employee=self.e3, date=eng.MON).update(
            status="present", shifts_earned=Decimal("1.00"), source="auto", total_punches=0
        )
        ce3 = self.by_code(self.run_report("worked-hours-shortfall", view="summary", **self.PARAMS))["CE3"]
        self.assertEqual(ce3["daysUnknown"], 1)


class MarkerReadersUnitTests(SimpleTestCase):
    """The shared readers of the marker, on bare records (nothing to look up)."""

    SHIFT = SimpleNamespace(start_time=time(8, 30), end_time=time(17, 30))
    STAFF = SimpleNamespace(employment_type="staff")

    def rec(self, **over):
        base = dict(
            is_late=True,
            early_leave=False,
            first_punch=time(10, 45),
            last_punch=time(17, 40),
            morning_permission_applied=False,
            evening_permission_applied=False,
            compensation_kind="",
            compensation_minutes=0,
            compensation_note="",
            late_reason=None,
        )
        base.update(over)
        return SimpleNamespace(**base)

    def test_a_window_hidden_behind_a_higher_marker_is_still_a_window(self):
        # the stored kind is only the most important marker: a relaxation outranks the announced late-in
        note = (
            "Company-announced late-in: staff may arrive until 10:30 today (no grace); "
            "Compensation relaxation: 0.25 shift added"
        )
        rec = self.rec(compensation_kind="relaxation", compensation_note=note)
        self.assertIsNone(late_minutes(rec, self.SHIFT, self.STAFF, None))

    def test_a_window_the_marker_does_not_name_is_found_in_the_engines_reason(self):
        # an arrival the window did not move to another zone is not marked, but the engine still judged it against the window
        reason = "Morning Late-In: first punch 10:45 is after 10:30 (company-announced late-in 10:30, no grace)"
        self.assertIsNone(late_minutes(self.rec(late_reason=reason), self.SHIFT, self.STAFF, None))

    def test_a_plain_reason_is_measured(self):
        reason = "Morning Late-In: first punch 10:45 is after the deadline 08:40 (shift start 08:30 + 10 min grace)"
        self.assertEqual(late_minutes(self.rec(late_reason=reason), self.SHIFT, self.STAFF, None), 135)

    def test_an_allowance_under_a_higher_marker_still_moves_the_start(self):
        rec = self.rec(compensation_kind="relaxation", compensation_minutes=30, first_punch=time(9, 50))
        self.assertEqual(late_minutes(rec, self.SHIFT, self.STAFF, None), 50)

    def test_an_announced_early_out_is_not_measured_from_the_shift_end(self):
        reason = "Evening Early-Out: last punch 15:30 is before 16:00 (company-announced early-out 16:00, no grace)"
        rec = self.rec(is_late=False, early_leave=True, last_punch=time(15, 30), late_reason=reason)
        self.assertIsNone(early_minutes(rec, self.SHIFT, self.STAFF, None, None))

    def test_a_plain_early_out_is_measured(self):
        rec = self.rec(is_late=False, early_leave=True, last_punch=time(15, 30), late_reason="Evening Early-Out: ...")
        self.assertEqual(early_minutes(rec, self.SHIFT, self.STAFF, None, None), 120)

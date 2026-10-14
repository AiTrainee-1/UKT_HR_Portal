"""Fixes of the adversarial review of the Compensation overhaul, group E (attendance engine, windows, allowance, alerts,
master switch). One class per finding; each test fails on the code as it was before the fix.

Run via: python manage.py test api.tests_comp_fix_e -v 2
"""

from datetime import date, time, timedelta
from decimal import Decimal

from django.db import connection
from django.test.utils import CaptureQueriesContext

from . import tests_whatsapp_alerts as alerts_base
from .attendance_final import (
    compensation_prefetch_for_range,
    compute_month_records,
    permission_flags_json,
)
from .attendance_views import _late_count
from .clock import ist_today
from .compensation_apply import RelaxationRefused, check_relaxation_day
from .models import (
    AttendanceDayRecord,
    AttendanceLog,
    Branch,
    BranchSettingsOverride,
    CompensationConfig,
    CompensationLedger,
    Employee,
    LeaveRequest,
    OvertimeRecord,
    PayrollSettings,
    ShiftTemplate,
)
from .tests_compensation_engine import (
    FRI,
    MON,
    THU,
    TUE,
    WED,
    CompBase,
    hr_headers,
    make_shift,
    seed_default_rules,
    set_config,
)


# ── #25 / #32 / #55: an announced window only ever relaxes ──────────────────


class WindowsOnlyRelaxTests(CompBase):
    def setUp(self):
        super().setUp()
        self.on(windows_enabled=True)

    def test_a_late_in_stricter_than_the_own_limit_changes_nothing(self):
        self.announce(WED, "late_in", time(8, 0))  # the shift's own on-time limit is 08:40
        self.worked(WED, time(17, 40), first=time(8, 35))
        r = self.rec(WED)
        self.assertEqual(
            (r.is_late, r.arrival_zone, r.shifts_earned, r.compensation_kind), (False, "on_time", Decimal("1.00"), "")
        )
        # later arrivals are judged from the shift's own limits (Quarter-shift after the Late window, 09:40)
        self.worked(WED, time(17, 40), first=time(9, 50))
        r = self.rec(WED)
        self.assertEqual((r.arrival_zone, r.is_late, r.shifts_earned), ("quarter", False, Decimal("0.75")))

    def test_an_early_out_stricter_than_the_own_limit_changes_nothing(self):
        self.announce(WED, "early_out", time(17, 45))  # the shift's own leaving limit is 17:20 (17:30 - 10 grace)
        self.worked(WED, time(17, 20), first=time(8, 35))
        r = self.rec(WED)
        self.assertEqual(
            (r.early_leave, r.status, r.shifts_earned, r.compensation_kind), (False, "present", Decimal("1.00"), "")
        )

    def test_a_company_wide_late_in_relaxes_only_the_shifts_it_is_later_than(self):
        later = make_shift(name="Ten", start_time=time(10, 0), end_time=time(19, 0), first_half_end=time(14, 0))
        other = self.new_staff("WR2", shift=later)
        self.announce(WED, "late_in", time(10, 0))  # later than 08:40, not later than the 10:00 shift's own 10:10
        self.worked(WED, time(17, 40), first=time(9, 55))
        self.worked(WED, time(19, 10), first=time(10, 5), emp=other)
        self.assertEqual(self.rec(WED).compensation_kind, "window_late_in")
        r = self.rec(WED, other)
        self.assertEqual((r.is_late, r.arrival_zone, r.compensation_kind), (False, "on_time", ""))


# ── #9 / #41 / #52: one company-wide master switch ──────────────────────────


class MasterSwitchIsCompanyWideTests(CompBase):
    def setUp(self):
        super().setUp()
        self.branch = Branch.objects.create(name="Branch B")
        self.b_emp = self.new_staff("MB1", branch=self.branch)
        BranchSettingsOverride.objects.create(branch=self.branch, overrides={"compensation_feature_enabled": False})

    def test_a_branch_overlay_never_overrides_the_master_switch(self):
        from .user_settings import settings_for_employee

        self.assertTrue(settings_for_employee(self.b_emp).compensation_feature_enabled)
        BranchSettingsOverride.objects.filter(branch=self.branch).update(
            overrides={"compensation_feature_enabled": False, "pf_rate": "9"}
        )
        self.assertEqual(settings_for_employee(self.b_emp).pf_rate, Decimal("9"))  # other private values still apply

    def test_a_branch_login_cannot_store_it(self):
        from .user_settings import persist_overlay, settings_for_employee

        overlay = settings_for_employee(self.b_emp)
        overlay.compensation_feature_enabled = False
        overlay.ot_detection_enabled = False
        persist_overlay(overlay)
        stored = BranchSettingsOverride.objects.get(branch=self.branch).overrides
        self.assertNotIn("compensation_feature_enabled", stored)
        self.assertNotIn("ot_detection_enabled", stored)

    def test_the_payroll_ot_pay_follows_the_company_switch_for_a_branch_employee(self):
        from .payroll_views import _generate_staff_payroll

        for i in range(2, 32):
            d = date(2026, 3, i)
            if d.weekday() != 6:
                self.worked(d, time(17, 40), first=time(8, 35), emp=self.b_emp)
        OvertimeRecord.objects.create(
            employee=self.b_emp,
            date=date(2026, 3, 3),
            shift_end_time=time(17, 30),
            last_punch_out=time(21, 30),
            ot_minutes=240,
            status="announced",
            compensation_type="pay",
            ot_type="shift",
            shifts=Decimal("0.50"),
        )
        # 26 working days in March 2026: a 26,000 salary has a daily rate of 1,000
        self.assertEqual(_generate_staff_payroll(self.b_emp, 3, 2026)["payroll"].ot_amount, Decimal("500.00"))

    def test_a_branch_login_is_told_plainly_that_the_switch_is_company_wide(self):
        from .tests_compensation_settings import login

        who = login({"settings.payroll": "edit"}, branch=self.branch)
        before = PayrollSettings.get()
        before_type = before.ot_compensation_type
        for body in (
            {"compensationFeatureEnabled": False},
            {"otDetectionEnabled": False},
            {"otThresholdMinutes": 90},
            {"otCompensationType": "relaxation"},
        ):
            r = self.client.put("/api/payroll-settings", body, content_type="application/json", **who)
            self.assertEqual(r.status_code, 403, body)
            self.assertEqual(r.json()["error"], "company_wide_rule")
        ps = PayrollSettings.get()
        self.assertTrue(ps.compensation_feature_enabled)
        self.assertEqual(ps.ot_compensation_type, before_type)

    def test_an_administrator_still_changes_it_for_everyone(self):
        r = self.client.put(
            "/api/payroll-settings",
            {"compensationFeatureEnabled": False},
            content_type="application/json",
            **hr_headers(),
        )
        self.assertEqual(r.status_code, 200, r.content)
        self.assertFalse(PayrollSettings.get().compensation_feature_enabled)


# ── #0: the company-wide compensation facts are read once for a whole loop ──


class SharedContextTests(CompBase):
    def test_a_roster_loop_reads_the_company_wide_facts_once(self):
        emps = [self.emp] + [self.new_staff(f"SC{i}") for i in range(3)]
        settings = PayrollSettings.get()
        for e in emps:
            self.worked(MON, time(17, 40), emp=e)
        for e in emps:
            compute_month_records(e, 2026, 3, settings)  # store every record: the counted runs write nothing

        def run(shared):
            prefetch = (
                compensation_prefetch_for_range(settings, date(2026, 3, 1), date(2026, 3, 31)) if shared else None
            )
            return [compute_month_records(e, 2026, 3, settings, comp_prefetch=prefetch) for e in emps]

        with CaptureQueriesContext(connection) as plain:
            plain_result = run(False)
        with CaptureQueriesContext(connection) as shared:
            shared_result = run(True)

        def summary(result):
            return [[(r.date, r.status, r.shifts_earned, r.compensation_kind) for r in rs] for rs in result]

        self.assertEqual(summary(plain_result), summary(shared_result))
        # config, relaxation, ledger and announcements are no longer re-read for every employee
        self.assertGreaterEqual(len(plain) - len(shared), 3 * (len(emps) - 1), (len(plain), len(shared)))


# ── #1: a roster with late arrivals costs the same however many there are ───


class RosterQueryTests(CompBase):
    def setUp(self):
        super().setUp()
        self.on(allowance_enabled=True)
        self.headers = hr_headers()
        self.batch = 0

    def add_late_employees(self, n):
        self.batch += 1
        for i in range(n):
            e = self.new_staff(f"RQ{self.batch}{i}")
            self.worked(MON, time(18, 30), emp=e)  # 60 extra minutes: a 30 minute allowance for Tuesday
            self.worked(TUE, time(17, 40), emp=e, first=time(9, 5))  # 09:05 is late against 08:40

    def day(self):
        return self.client.get("/api/attendance/report-log", {"date": str(TUE)}, **self.headers).json()

    def steady_queries(self):
        self.day()  # computes and stores every record
        with CaptureQueriesContext(connection) as ctx:
            body = self.day()
        return len(ctx), body

    def test_the_cost_does_not_grow_with_the_number_of_late_arrivals(self):
        self.add_late_employees(2)
        few, _body = self.steady_queries()
        self.add_late_employees(5)
        many, body = self.steady_queries()
        self.assertEqual(few, many)
        rows = [r for r in body["rows"] if r["employeeCode"].startswith("RQ")]
        self.assertEqual(len(rows), 7)
        self.assertTrue(all(r["compensationKind"] == "ot_allowance" and not r["isLate"] for r in rows))


# ── #5 / #54 (a): the attendance sheet's cells ──────────────────────────────


class SheetCellTests(CompBase):
    def setUp(self):
        super().setUp()
        self.headers = hr_headers()

    def cells(self):
        body = self.client.get(
            "/api/attendance/report-log/sheet", {"dateFrom": str(MON), "dateTo": str(FRI)}, **self.headers
        ).json()
        mine = next(e for e in body["employees"] if e["employeeId"] == self.emp.id)
        return {d["date"]: d for d in mine["days"]}

    def test_only_a_marked_day_carries_the_compensation_keys(self):
        self.on(birthday_enabled=True)
        self.emp.date_of_birth = date(1990, 3, 5)  # Thursday
        self.emp.save()
        self.worked(MON, time(17, 40), first=time(8, 35))
        cells = self.cells()
        self.assertFalse({"compensationKind", "compensationMinutes", "compensationNote"} & set(cells[str(MON)]))
        thu = cells[str(THU)]
        self.assertEqual((thu["compensationKind"], thu["compensationMinutes"]), ("birthday", 0))
        self.assertIn("compensationNote", thu)

    def test_a_punchless_relaxation_day_has_no_half_day_period(self):
        CompensationLedger.objects.create(
            employee=self.emp, entry_type="debit", shifts=Decimal("0.50"), date=WED, source="redemption"
        )
        cell = self.cells()[str(WED)]
        self.assertEqual((cell["status"], cell["compensationKind"]), ("half_shift", "relaxation"))
        self.assertIsNone(cell["halfDayPeriod"])

    def test_a_worked_half_day_still_says_which_half(self):
        self.punch(THU, time(8, 30), time(12, 30))  # a morning only
        self.punch(FRI, time(14, 40), time(18, 0))  # an afternoon only
        cells = self.cells()
        self.assertEqual(cells[str(THU)]["halfDayPeriod"], "morning")
        self.assertEqual(cells[str(FRI)]["halfDayPeriod"], "afternoon")


# ── #28: the dashboard's Late count follows the engine's verdict ────────────


class DashboardLateCountTests(CompBase):
    def late_punch(self, d, first):
        for t in (first, time(17, 40)):
            AttendanceLog.objects.create(
                employee=self.emp, date=d, punch_time=t, punch_type=AttendanceLog.PUNCH_IN, source="test"
            )

    def test_a_window_day_is_not_counted_late_once_the_engine_has_judged_it(self):
        self.on(windows_enabled=True)
        self.announce(WED, "late_in", time(10, 0))
        self.late_punch(WED, time(9, 30))  # against the plain shift: Late (08:40 + 60 minutes)
        self.assertEqual(_late_count(WED), 1)  # not judged yet: the raw verdict
        self.rec(WED)
        self.assertEqual(_late_count(WED), 0)

    def test_an_allowance_day_is_not_counted_late_once_the_engine_has_judged_it(self):
        self.on(allowance_enabled=True)
        self.worked(MON, time(18, 30))  # 60 extra minutes: a 30 minute allowance
        self.late_punch(TUE, time(9, 5))
        self.assertEqual(_late_count(TUE), 1)
        self.rec(TUE)
        self.assertEqual(_late_count(TUE), 0)

    def test_a_day_the_engine_calls_late_stays_counted(self):
        self.late_punch(WED, time(9, 30))
        self.rec(WED)
        self.assertEqual(_late_count(WED), 1)


# ── #38 / #57: a relaxation on a FUTURE date is checked like a past one ─────


class FutureRelaxationTests(CompBase):
    def future_wednesday(self):
        d = ist_today() + timedelta(days=14)
        while d.weekday() != 2 or d.day > 27:
            d += timedelta(days=1)
        return d

    def test_a_future_birthday_is_a_full_paid_day(self):
        d = self.future_wednesday()
        self.on(birthday_enabled=True, birthday_effective_from=date(2026, 1, 1))
        self.emp.date_of_birth = date(1990, d.month, d.day)
        self.emp.save()
        with self.assertRaises(RelaxationRefused) as caught:
            check_relaxation_day(self.emp, d, Decimal("0.50"))
        self.assertIn("full paid day", str(caught.exception))
        set_config(birthday_enabled=False)
        self.assertEqual(check_relaxation_day(self.emp, d, Decimal("0.50")), Decimal("0"))

    def test_a_future_day_set_by_hand_keeps_its_shifts(self):
        d = self.future_wednesday()
        AttendanceDayRecord.objects.create(
            employee=self.emp,
            date=d,
            status="present",
            shifts_earned=Decimal("1.00"),
            source="manual",
            override_by="HR",
        )
        with self.assertRaises(RelaxationRefused):
            check_relaxation_day(self.emp, d, Decimal("0.25"))


# ── #46: an approved override clears the compensation marker ────────────────


class OverrideMarkerTests(CompBase):
    def test_an_approved_override_clears_the_compensation_marker(self):
        from .growth_views import apply_override_values

        self.on(birthday_enabled=True)
        self.emp.date_of_birth = date(1990, 3, 5)
        self.emp.save()
        record = self.rec(THU)
        self.assertEqual(record.compensation_kind, "birthday")
        apply_override_values(
            record,
            {
                "status": "absent",
                "isLate": False,
                "isEarlyOut": False,
                "isHalfShift": False,
                "firstPunch": None,
                "lastPunch": None,
                "shiftsEarned": "0.00",
                "note": "by hand",
            },
            "HR",
        )
        record.refresh_from_db()
        self.assertEqual(
            (
                record.source,
                record.status,
                record.compensation_kind,
                record.compensation_minutes,
                record.compensation_note,
            ),
            ("manual", "absent", "", 0, ""),
        )
        self.assertIsNone(permission_flags_json(record)["compensationKind"])


# ── #19: the demo seeder measures overtime like the engine ──────────────────


class DemoVerdictTests(CompBase):
    def test_the_seeder_verdict_imports_and_measures_like_the_engine(self):
        from .management.commands.md_demo.verdicts import staff_verdict

        shift = ShiftTemplate(
            name="V",
            shift_type="staff",
            start_time=time(9, 0),
            end_time=time(18, 0),
            grace_period_minutes=15,
            first_half_end=time(13, 0),
            lunch_duration_minutes=60,
        )
        settings = PayrollSettings.get()
        day = staff_verdict(settings, shift, [time(8, 55), time(13, 0), time(14, 0), time(19, 30)], [])
        self.assertEqual(day.ot_minutes, 90)
        alone = staff_verdict(settings, shift, [time(19, 30)], [])
        self.assertEqual(alone.ot_minutes, 0)  # one punch alone is an arrival, as the engine measures it


# ── #24 / #59: WhatsApp alerts follow birthday leave and the allowance ──────


class CompensationAlertTests(alerts_base.AlertBase):
    PREV = date(2026, 9, 22)  # the working day before WED (23 Sep 2026)

    def setUp(self):
        super().setUp()
        seed_default_rules()
        CompensationConfig.objects.all().delete()
        CompensationConfig.get()

    def test_no_alert_of_any_kind_on_a_paid_birthday(self):
        set_config(birthday_enabled=True, birthday_effective_from=date(2026, 1, 1))
        Employee.objects.filter(pk=self.emp.pk).update(date_of_birth=date(1990, 9, 23))
        other = self.make_employee("A2", "Bala", "Kumar", phone="9000000002")
        self.run_at(alerts_base.WED, 10, 5)  # past the Absent cut-off (09:00 + 60 minutes), nobody has punched
        self.assertFalse(self.logs().filter(employee=self.emp).exists())
        self.assertTrue(self.logs().filter(employee=other).exists())  # the same moment does message a colleague

    def test_a_late_arrival_inside_the_next_day_allowance_gets_no_late_alert(self):
        set_config(allowance_enabled=True, allowance_effective_from=date(2026, 1, 1))
        other = self.make_employee("A2", "Bala", "Kumar", phone="9000000002")
        self.punch(self.emp, self.PREV, "09:00", "13:00", "14:00", "19:00")  # 60 minutes extra: a 30 minute allowance
        self.punch(self.emp, alerts_base.WED, "09:25")  # the plain limit is 09:15, with the allowance 09:45
        self.punch(other, alerts_base.WED, "09:25")  # no extra work yesterday: Late
        self.run_at(alerts_base.WED, 9, 26)
        self.assertEqual(self.logs("late_alert").get().employee, other)

    def test_a_quarter_shift_arrival_the_allowance_makes_late_is_alerted_like_the_engine_marks_it(self):
        set_config(allowance_enabled=True, allowance_effective_from=date(2026, 1, 1))
        self.punch(self.emp, self.PREV, "09:00", "13:00", "14:00", "19:00")
        self.punch(
            self.emp, alerts_base.WED, "10:20"
        )  # plain: after the Late window (10:15); shifted: Late until 10:45
        self.run_at(alerts_base.WED, 10, 21)
        self.assertEqual(self.logs("late_alert").count(), 1)
        self.assertIn("Late By: 35 minutes", self.logs("late_alert").get().message_text)  # 10:20 vs the shifted 09:45


# ── #61: the allowance also covers an afternoon Half-Day Leave ──────────────


class AllowanceHalfDayLeaveTests(CompBase):
    def setUp(self):
        super().setUp()
        self.on(allowance_enabled=True)
        self.worked(MON, time(18, 30))  # 60 extra minutes: a 30 minute allowance for Tuesday

    def half_day_leave(self, slot):
        leave = LeaveRequest(
            employee=self.emp,
            start_date=str(TUE),
            end_date=str(TUE),
            status="approved",
            is_half_day=True,
            half_day_slot=slot,
        )
        leave.type = "casual"
        leave.save()

    def test_an_afternoon_leave_still_owes_a_normal_morning_arrival_the_allowance_covers_it(self):
        self.half_day_leave(LeaveRequest.HALF_DAY_AFTERNOON)
        self.punch(TUE, time(9, 5), time(13, 0))  # 09:05 is after the plain 08:40, inside 08:30 + 30 + 10 grace
        r = self.month()[TUE]
        self.assertEqual((r.is_late, r.compensation_kind), (False, "ot_allowance"))
        self.assertTrue(r.is_half_day_leave)

    def test_a_morning_leave_expects_no_morning_arrival_so_nothing_is_used(self):
        self.half_day_leave(LeaveRequest.HALF_DAY_MORNING)
        self.punch(TUE, time(14, 40), time(18, 0))
        r = self.month()[TUE]
        self.assertEqual(r.compensation_kind, "")

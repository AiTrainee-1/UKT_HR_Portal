"""
Fixes of the compensation-claims verification round, group H (history / punches / switch reads; 2026-11-19):

  * correctness #4: a staff next-morning change while the rule's from-date is still ahead is dated from that from-date,
    and replaces every later-dated history entry (settings_history.appended); a changed from-date can never be in the
    past. The quarters rule's history (the other appended() caller) keeps working the same way.
  * correctness #7: re-judging after a punch change follows the next-morning chain past D + 1 (staff), in
    attendance_refresh.refresh_after_punches, overtime.recompute_stale_days and Punch View's _reconcile_days
    (shift_engine.staff_night_chain_end).
  * security #3 / correctness #10: the stale-day pass (the employee's own GET, the scheduled jobs, the attendance
    refresh) never re-derives a staff day of a Payroll Done month.
  * correctness #11c: an approved Type 1 claim follows the master switch only - not the allowance switch nor its
    effective-from date - in the engine (every attendance path) and in the employee app's today / tomorrow allowance.

Run via: python manage.py test api.tests_comp_fix_h -v 2
"""

from datetime import date, time
from decimal import Decimal
from unittest import mock

from django.test import SimpleTestCase
from django.utils import timezone

from . import compensation_effects as effects
from . import tests_compensation_claims_engine as eng
from . import tests_compensation_engine as base
from .attendance_final import (
    compensation_prefetch_for_day,
    compensation_prefetch_for_range,
    compute_day_record,
    compute_month_records,
    compute_range_records,
)
from .jwt_utils import sign_token
from .models import (
    AttendanceDayRecord,
    AttendanceLog,
    CompensationConfig,
    Employee,
    PayrollMonthClose,
    PayrollSettings,
)
from .settings_history import appended, entry_on
from .shift_engine import resolve_day_punch_logs
from .tests_compensation_claims import OT_ALLOW_DAY, ClaimsBase, _emp_token, _punch

REAL_BIRTHDAY_OUTCOME = effects.birthday_outcome  # read before any test patches it
MON, TUE, WED, THU, FRI, SAT = eng.MON, eng.TUE, eng.WED, eng.THU, eng.FRI, eng.SAT
MON2 = base.MON2
TUE2 = date(2026, 3, 10)
# what migration 0167 seeds in production: one entry from the rule's own start (the test database gets the real date of
# the run instead, so every test sets the histories itself)
SEED_NM = [{"from": "2026-03-01", "enabled": True, "cutoff": "06:00"}]
SEED_Q = [{"from": "2026-03-01", "on": True}]


def facts(r):
    return (r.status, str(r.shifts_earned), r.first_punch, r.last_punch, r.ot_extra_minutes, r.is_late)


def lock(day):
    PayrollMonthClose.objects.get_or_create(month=day.month, year=day.year, defaults={"finalized_at": timezone.now()})


def snap(emp, day):
    r = AttendanceDayRecord.objects.filter(employee=emp, date=day).first()
    if r is None:
        return None
    return (r.status, str(r.shifts_earned), r.compensation_kind, r.total_punches, r.updated_at, r.source)


class HBase(eng.ClaimsEngineBase):
    CODE = "CFH1"

    def setUp(self):
        super().setUp()
        self.headers = base.hr_headers()
        ps = PayrollSettings.get()
        ps.staff_next_morning_history = [dict(e) for e in SEED_NM]
        ps.last_punch_post_shift_grace_hours = Decimal("0")
        ps.save()

    def judge(self, lo=MON, hi=TUE2):
        return {r.date: facts(r) for r in compute_range_records(self.emp, lo, hi, PayrollSettings.get())}

    def resolved(self, d):
        logs = list(AttendanceLog.objects.filter(employee=self.emp, date=d).order_by("punch_time"))
        return [
            p.punch_time.strftime("%H:%M") for p in resolve_day_punch_logs(self.emp, d, logs, PayrollSettings.get())
        ]

    def put_payroll(self, today, expect=200, **body):
        with mock.patch("api.clock.ist_today", return_value=today):
            r = self.client.put("/api/payroll-settings", body, content_type="application/json", **self.headers)
        self.assertEqual(r.status_code, expect, r.content)
        return r.json()

    def put_comp(self, today, body, expect=200):
        with mock.patch("api.compensation_settings_views.ist_today", return_value=today):
            r = self.client.put("/api/compensation/settings", body, content_type="application/json", **self.headers)
        self.assertEqual(r.status_code, expect, r.content)
        return r.json()


# ── correctness #4: the dated next-morning history ──────────────────────────────────────────────────────────────────


class NextMorningHistoryTests(HBase):
    def _future_set(self):
        self.log(FRI, time(8, 30), time(13, 0), time(14, 0))  # open
        self.log(SAT, time(4, 30), time(8, 30), time(17, 30))
        self.log(MON2, time(8, 30), time(13, 0), time(14, 0))  # open
        self.log(TUE2, time(5, 30), time(8, 30), time(17, 30))

    def test_a_cutoff_change_before_a_future_from_date_holds_from_that_date(self):
        self._future_set()
        self.put_payroll(WED, staffNextMorningFrom=MON2.isoformat())  # the rule starts MON2
        body = self.put_payroll(THU, staffNextMorningCutoff="05:00")
        self.assertEqual(
            body["staffNextMorningHistory"], [{"from": MON2.isoformat(), "enabled": True, "cutoff": "05:00"}]
        )
        self.assertEqual(self.resolved(MON2), ["08:30", "13:00", "14:00"])  # 05:30 is after 05:00: TUE2's own
        self.assertEqual(self.resolved(FRI), ["08:30", "13:00", "14:00"])  # before the from-date: the old rule

    def test_switching_off_before_a_future_from_date_holds_from_that_date(self):
        self._future_set()
        self.put_payroll(WED, staffNextMorningFrom=MON2.isoformat())
        body = self.put_payroll(THU, staffNextMorningEnabled=False)
        self.assertFalse(body["staffNextMorningEnabled"])
        self.assertEqual(
            body["staffNextMorningHistory"], [{"from": MON2.isoformat(), "enabled": False, "cutoff": "06:00"}]
        )
        self.assertEqual(self.resolved(MON2), ["08:30", "13:00", "14:00"])  # switched off: the old rule
        self.assertEqual(self.resolved(FRI), ["08:30", "13:00", "14:00"])

    def test_the_from_date_cannot_move_into_the_past(self):
        self.log(MON, time(8, 30), time(13, 0), time(14, 0))  # open
        self.log(TUE, time(5, 30), time(8, 30), time(17, 30))
        self.log(WED, time(8, 30))  # open
        self.log(THU, time(5, 30), time(8, 30), time(17, 30))
        before = self.judge(MON, THU)
        # after the saved 03-01, but before today (MON2): it would re-judge days the rule already judged
        body = self.put_payroll(MON2, expect=400, staffNextMorningFrom="2026-03-06")
        self.assertIn("cannot be in the past", body["error"])
        self.put_payroll(MON2, expect=400, staffNextMorningFrom=None)  # never cleared
        ps = PayrollSettings.get()
        self.assertEqual((ps.staff_next_morning_from, ps.staff_next_morning_history), (eng.CLAIMS_FROM, SEED_NM))
        self.assertEqual(self.judge(MON, THU), before)
        # the saved date sent back unchanged (a whole form saved) is fine, and today or a later day may be chosen
        self.put_payroll(MON2, staffNextMorningFrom=eng.CLAIMS_FROM.isoformat(), staffNextMorningCutoff="06:00")
        self.assertEqual(
            self.put_payroll(MON2, staffNextMorningFrom=MON2.isoformat())["staffNextMorningFrom"], "2026-03-09"
        )


class NextMorningHistoryStrictTests(NextMorningHistoryTests):
    MODE = "strict"
    CODE = "CFH2"


class HistoryHelperTests(SimpleTestCase):
    def test_appended_replaces_every_entry_dated_on_or_after_the_new_one(self):
        history = [
            {"from": None, "on": False},
            {"from": "2026-03-01", "on": True},
            {"from": "2026-03-04", "on": True},
            {"from": "2026-03-09", "on": True},  # e.g. a start moved ahead
        ]
        out = appended(history, {"on": False}, date(2026, 3, 4))
        self.assertEqual(
            out, [{"from": None, "on": False}, {"from": "2026-03-01", "on": True}, {"from": "2026-03-04", "on": False}]
        )
        self.assertFalse(entry_on(out, date(2026, 3, 10))["on"])


class QuarterHistoryTests(HBase):
    CODE = "CFH3"

    def setUp(self):
        super().setUp()
        self.on(allowance_enabled=True, shift_enabled=True, relaxation_enabled=True, pay_enabled=True)

    def kinds(self):
        from .overtime import detect_overtime_for_month

        self.month()
        return {row.date: row.ot_type for row in detect_overtime_for_month(2026, 3)}

    def test_off_then_on_keeps_each_days_rule(self):
        from . import compensation_effects as effects

        base.set_config(ot_quarter_rule_history=[dict(e) for e in SEED_Q])
        self.worked(MON, time(19, 30))  # 120 min: a quarter of the 8 h shift
        self.worked(WED, time(19, 30))
        self.worked(FRI, time(19, 30))
        k0 = self.kinds()
        self.put_comp(TUE, {"shift": {"quarterRule": False}})
        body = self.put_comp(THU, {"shift": {"quarterRule": True}})
        self.assertEqual(
            body["shift"]["quarterRuleHistory"],
            [
                {"from": "2026-03-01", "on": True},
                {"from": "2026-03-03", "on": False},
                {"from": "2026-03-05", "on": True},
            ],
        )
        k1 = self.kinds()
        self.assertEqual((k1[MON], k1[WED], k1[FRI]), (k0[MON], "allowance", "shift"))
        cfg = CompensationConfig.get()
        self.assertEqual(
            [effects.staff_ot_credit(self.emp, d, 120, config=cfg) for d in (MON, WED, FRI)],
            [Decimal("0.25"), Decimal("0"), Decimal("0.25")],
        )
        # the history is read-only through the API
        body = self.put_comp(FRI, {"shift": {"quarterRuleHistory": []}})
        self.assertEqual(len(body["shift"]["quarterRuleHistory"]), 3)

    def test_a_change_before_a_future_claims_date_holds_from_that_date(self):
        # no history yet and a claims date still ahead: the first change seeds the rule as it was from the claims date
        base.set_config(claims_from=MON2, ot_quarter_rule=True)
        self.put_comp(WED, {"shift": {"quarterRule": False}})
        cfg = CompensationConfig.get()
        self.assertEqual(cfg.ot_quarter_rule_history, [{"from": WED.isoformat(), "on": False}])
        self.assertFalse(cfg.ot_quarter_rule_on(TUE2))  # switched off: the change is not lost from the claims date on


# ── correctness #7: the next-morning chain past D + 1 ──────────────────────────────────────────────────────────────


class NightChainTests(HBase):
    CODE = "CFH4"

    def _chain(self):
        # every night's exit is the next calendar day's 01:00 (before the cut-off): a run of open days
        self.log(MON, time(8, 30))
        self.log(TUE, time(1, 0), time(8, 30))
        self.log(WED, time(1, 0), time(8, 30))
        self.log(THU, time(1, 0), time(8, 30), time(17, 30))
        compute_range_records(self.emp, MON, THU, PayrollSettings.get())

    def _stale_days(self, days):
        """The stored days (of `days`) that differ from a fresh computation."""
        stored = {d: facts(self.stored(d)) for d in days}
        AttendanceDayRecord.objects.filter(employee=self.emp, date__in=days).delete()
        fresh = {r.date: facts(r) for r in compute_range_records(self.emp, MON, THU, PayrollSettings.get())}
        return [d.isoformat() for d in days if stored[d] != fresh[d]]

    def test_refresh_after_punches_follows_the_chain(self):
        from .attendance_refresh import refresh_after_punches

        self._chain()
        self.log(MON, time(13, 0))  # Monday is closed now: the whole run of nights flips
        with mock.patch("api.attendance_refresh.ist_today", return_value=TUE2):
            refresh_after_punches([(self.emp.id, MON)])
        self.assertEqual(self._stale_days([TUE, WED, THU]), [])

    def test_the_chain_never_goes_past_today(self):
        from .attendance_refresh import refresh_after_punches

        self._chain()
        thu_before = self.stored(THU).updated_at
        self.log(MON, time(13, 0))
        with mock.patch("api.attendance_refresh.ist_today", return_value=WED):
            refresh_after_punches([(self.emp.id, MON)])
        self.assertEqual(self.stored(THU).updated_at, thu_before)  # tomorrow is never judged ahead of time
        stored = {d: facts(self.stored(d)) for d in (TUE, WED)}  # up to today: re-judged
        AttendanceDayRecord.objects.filter(employee=self.emp, date__in=[TUE, WED]).delete()
        fresh = {r.date: facts(r) for r in compute_range_records(self.emp, MON, WED, PayrollSettings.get())}
        self.assertEqual(stored, {d: fresh[d] for d in (TUE, WED)})

    def test_the_stale_pass_follows_the_chain(self):
        from .overtime import recompute_stale_days

        self._chain()
        self.log(MON, time(13, 0))
        recompute_stale_days(MON, FRI, employee_ids=[self.emp.id])
        self.assertEqual(self._stale_days([TUE, WED, THU]), [])

    def test_punch_view_reconcile_after_a_delete_rejudges_the_next_day(self):
        from .punch_views import _reconcile_days

        self.log(WED, time(8, 30), time(13, 0), time(14, 0), time(17, 40))  # closed
        self.log(THU, time(5, 30), time(8, 30), time(17, 30))
        compute_range_records(self.emp, WED, THU, PayrollSettings.get())
        self.assertEqual(self.stored(THU).first_punch, time(5, 30))
        AttendanceLog.objects.filter(employee=self.emp, date=WED, punch_time=time(17, 40)).delete()  # WED open now
        with mock.patch("api.punch_views.ist_today", return_value=TUE2):
            _reconcile_days({self.emp.pk}, {WED}, (), {(self.emp.pk, WED)})
        self.assertEqual(self.stored(THU).first_punch, time(8, 30))  # 05:30 is Wednesday's overtime now
        self.assertEqual(self.stored(WED).last_punch, time(5, 30))


class NightChainStrictTests(NightChainTests):
    MODE = "strict"
    CODE = "CFH5"


# ── security #3 / correctness #10: no re-derivation inside a Payroll Done month ──────────────────────────────────────


class LockedMonthStalePassTests(HBase):
    CODE = "CFH6"

    def test_a_locked_staff_month_is_left_alone_between_two_open_ones(self):
        from .overtime import recompute_stale_days

        feb, mar, apr = date(2026, 2, 27), date(2026, 3, 2), date(2026, 4, 1)
        for d in (feb, mar, apr):
            AttendanceDayRecord.objects.create(
                employee=self.emp, date=d, status="absent", shifts_earned=Decimal("0"), source="auto"
            )
            self.log(d, time(8, 30), time(17, 30))  # punches newer than the stored day
        lock(mar)
        before = snap(self.emp, mar)
        recompute_stale_days(feb, apr, employee_ids=[self.emp.id])
        self.assertEqual(snap(self.emp, mar), before)
        self.assertEqual(AttendanceDayRecord.objects.filter(employee=self.emp, date=date(2026, 3, 16)).count(), 0)
        self.assertNotEqual(snap(self.emp, feb)[0], "absent")
        self.assertNotEqual(snap(self.emp, apr)[0], "absent")


class LockedMonthEmployeeGetTests(ClaimsBase):
    """The employee's own GET /api/employee/compensation refreshes the last few days (refresh_employee_overtime ->
    recompute_stale_days): never inside a Payroll Done month."""

    def setUp(self):
        super().setUp()
        # the real birthday outcome (ClaimsBase pins it for the claim tests)
        real = mock.patch.object(effects, "birthday_outcome", REAL_BIRTHDAY_OUTCOME)
        real.start()
        self.addCleanup(real.stop)

    def test_a_recent_day_in_a_locked_month_keeps_its_stored_verdict(self):
        day = OT_ALLOW_DAY  # TODAY - 1
        AttendanceLog.objects.filter(employee=self.ravi).delete()
        AttendanceDayRecord.objects.create(
            employee=self.ravi, date=day, status="absent", shifts_earned=Decimal("0"), source="auto"
        )
        _punch(self.ravi, day)
        before = snap(self.ravi, day)
        lock(day)
        r = self.client.get("/api/employee/compensation", **_emp_token(self.ravi))
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(snap(self.ravi, day), before)

    def test_a_recent_birthday_in_a_locked_month_keeps_its_stored_verdict(self):
        day = OT_ALLOW_DAY
        Employee.objects.filter(pk=self.asha.pk).update(date_of_birth=date(1990, 10, 13))
        AttendanceDayRecord.objects.create(
            employee=self.asha, date=day, status="absent", shifts_earned=Decimal("0"), source="auto"
        )
        AttendanceLog.objects.filter(employee=self.asha, date=day).delete()
        _punch(self.asha, day)
        before = snap(self.asha, day)
        lock(day)
        r = self.client.get("/api/employee/compensation", **self.asha_t)
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(snap(self.asha, day), before)
        # control: once the month is open again, the same GET re-derives the day
        PayrollMonthClose.objects.all().delete()
        self.client.get("/api/employee/compensation", **self.asha_t)
        self.assertNotEqual(snap(self.asha, day), before)


# ── correctness #11c: an approved Type 1 claim follows the master switch only ────────────────────────────────────────


class ApprovedAllowanceTests(HBase):
    CODE = "CFH7"

    def setUp(self):
        super().setUp()
        self.on(allowance_enabled=True, shift_enabled=True, relaxation_enabled=True, pay_enabled=True)
        base.set_config(ot_quarter_rule_history=[dict(e) for e in SEED_Q])
        self.worked(MON, time(18, 45))
        self.log(TUE, time(8, 55), time(13, 0), time(14, 0), time(17, 30))  # 15 minutes late
        self.record = self.allowance_record()
        self.claim("ot_allowance", MON, record=self.record, minutes=30)

    def every_path(self):
        """(is_late, compensation_kind) of TUE by every attendance path."""
        ps = PayrollSettings.get()
        single = self.rec(TUE)
        rng = compute_range_records(self.emp, TUE, TUE, ps)[0]
        month = self.month()[TUE]
        loop = {
            r.date: r
            for r in compute_month_records(
                self.emp,
                2026,
                3,
                ps,
                comp_prefetch=compensation_prefetch_for_range(ps, date(2026, 3, 1), date(2026, 3, 31)),
            )
        }[TUE]
        AttendanceDayRecord.objects.filter(employee=self.emp, date=TUE).delete()
        roster = compute_day_record(
            self.emp, TUE, settings=ps, prefetch=compensation_prefetch_for_day(ps, TUE, [self.emp.pk])
        )
        return {
            name: (r.is_late, r.compensation_kind)
            for name, r in (("single", single), ("range", rng), ("month", month), ("loop", loop), ("roster", roster))
        }

    def test_a_granted_claim_survives_the_switch_going_off_and_on_again(self):
        self.put_comp(WED, {"allowance": {"enabled": False}})
        self.put_comp(MON2, {"allowance": {"enabled": True}})  # moves the automatic rule's effective-from to MON2
        self.assertEqual(CompensationConfig.get().allowance_effective_from, MON2)
        for path, got in self.every_path().items():
            self.assertEqual(got, (False, "ot_allowance"), path)
        self.settings(compensation_feature_enabled=False)  # the master switch still stops it
        self.assertTrue(self.rec(TUE).is_late)

    def test_the_automatic_rule_still_keeps_its_effective_from_date(self):
        # an OT day before the claims date follows the automatic rule, which never acts before its effective-from date
        base.set_config(claims_from=MON2)
        self.on(allowance_enabled=True, allowance_effective_from=WED)
        self.assertEqual(self.tue(), (True, ""))

    def tue(self):
        rec = self.rec(TUE)
        return (rec.is_late, rec.compensation_kind)

    def test_the_employee_app_shows_a_granted_allowance_with_the_switch_off(self):
        hdr = {"HTTP_AUTHORIZATION": f"Bearer {sign_token({'role': 'employee', 'employeeId': self.emp.id})}"}
        for target in ("api.employee_compensation_views.ist_today", "api.compensation_claims.ist_today"):
            patch = mock.patch(target, return_value=MON)
            patch.start()
            self.addCleanup(patch.stop)
        on = self.client.get("/api/employee/compensation", **hdr)
        self.assertEqual(on.status_code, 200, on.content)
        self.assertEqual(on.json()["tomorrowAllowance"]["date"], TUE.isoformat())
        base.set_config(allowance_enabled=False, allowance_effective_from=MON2)
        off = self.client.get("/api/employee/compensation", **hdr)
        self.assertEqual(off.json()["tomorrowAllowance"], on.json()["tomorrowAllowance"])
        self.assertEqual(self.tue(), (False, "ot_allowance"))  # what the engine applies
        self.settings(compensation_feature_enabled=False)
        self.assertIsNone(self.client.get("/api/employee/compensation", **hdr).json().get("tomorrowAllowance"))


class ApprovedAllowanceStrictTests(ApprovedAllowanceTests):
    MODE = "strict"
    CODE = "CFH8"

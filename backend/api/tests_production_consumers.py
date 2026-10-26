"""
Production shift rules: every CONSUMER of a production day agrees with the engine.

The engine (production_shift_rules.py + attendance_final.compute_day_record) is tested in tests_production_shift_rules.py.
Here a seeded production roster (a day worker, a day worker who stays to 22:30, a night worker, a day + dinner + 05:30
worker, a Sunday worker, a late arrival, an early leaver and a forgotten out-punch) is read through every screen and
engine that shows or pays a production day, and they must all say the same thing for the same day:

* the stored day record (compute_range_records / compute_day_record),
* the HR daily list (GET /api/attendance/daily), the company summary cards, the employee history, the Attendance Search
  range, the employee shift stats,
* production payroll (days_detail, late detection, pay = sum(shifts) x rate) including a period that spans the
  effective date (legacy days stay legacy, new days use the table),
* the MD portal's average late minutes, the HR manual-override cap and the demo seed's verdict.

It also pins the query counts: the roster loops do not grow with the number of production employees.

Run via: python manage.py test api.tests_production_consumers -v 2
"""

import importlib
from datetime import date, time, timedelta
from decimal import Decimal
from unittest import mock

from django.apps import apps as django_apps
from django.db import connection
from django.test import TestCase
from django.test.utils import CaptureQueriesContext

from . import tests_md_attendance as _md
from .attendance_final import _compute_production, compute_day_record, compute_range_records
from .jwt_utils import sign_token
from .models import (
    AttendanceDayRecord,
    AttendanceLog,
    Employee,
    HRUser,
    PayrollSettings,
    ProductionBreak,
    ProductionShiftConfig,
    ProductionShiftGroup,
    ProductionShiftSegment,
    SalarySlip,
)

_MdWorld = _md.World
MA_W = _md.W
MON = date(2026, 2, 2)  # a Monday
TUE, WED, THU, FRI, SAT, SUN = (MON + timedelta(days=i) for i in range(1, 7))
WEEK = [MON + timedelta(days=i) for i in range(7)]
LONG_AGO = date(2026, 1, 1)
NEVER = date(2099, 1, 1)


def _t(text: str) -> time:
    h, m = text.split(":")
    return time(int(h), int(m))


def _ensure_seed():
    """The migration seeds the three groups and the breaks; a TransactionTestCase elsewhere may have flushed them."""
    if not ProductionShiftGroup.objects.exists() or not ProductionBreak.objects.exists():
        ProductionShiftGroup.objects.all().delete()
        ProductionBreak.objects.all().delete()
        importlib.import_module("api.migrations.0121_production_shift_rules").seed(django_apps, None)


def _set_rules(effective_from, **fields):
    config = ProductionShiftConfig.get()
    config.rules_enabled = True
    config.rules_effective_from = effective_from
    for key, value in fields.items():
        setattr(config, key, value)
    config.save()
    return config


def _worker(code, per_shift="500.00") -> Employee:
    return Employee.objects.create(
        employee_code=code,
        first_name=code,
        last_name="Prod",
        employment_type="production",
        status="active",
        salary_per_shift=Decimal(per_shift),
    )


def _punch(emp, d, hhmm):
    AttendanceLog.objects.create(employee=emp, date=d, punch_time=_t(hhmm), punch_type="IN", source="manual")


def _punches(emp, d, *times):
    for hhmm in times:
        _punch(emp, d, hhmm)


def _hr() -> dict:
    user = HRUser.objects.create(username="pc_admin", password_hash="x", full_name="Pc Admin", is_super_admin=True)
    return {"HTTP_AUTHORIZATION": "Bearer " + sign_token({"role": "hr", "hrUserId": user.id, "name": "Pc Admin"})}


def _hhmm(t):
    return t.strftime("%H:%M") if t else None


# The roster: who punched what, on which day of the week MON..SUN (2026-02-02 .. 2026-02-08).
FULL = ("08:30", "12:45", "13:30", "20:00")
OT = ("08:30", "12:45", "13:30", "22:30")


def seed_roster() -> dict[str, Employee]:
    r = {name: _worker(f"PC_{name}") for name in ("DAY", "OT", "NIGHT", "DINNER", "SUN", "LATE", "EARLY", "FORGOT")}
    for d in (MON, TUE, WED, THU, FRI, SAT):
        _punches(r["DAY"], d, *FULL)  # 1.50 every day
    _punches(r["OT"], MON, *OT)  # 2.00
    _punches(r["OT"], TUE, *OT)
    _punches(r["OT"], WED, *FULL)  # 1.50
    _punches(r["NIGHT"], MON, "21:00")  # 21:00 -> 05:30 next morning: 1.50
    _punches(r["NIGHT"], TUE, "05:30", "21:00")  # 05:30 closes Monday's night; 21:00 opens Tuesday's
    _punches(r["NIGHT"], WED, "05:30")
    _punches(r["DINNER"], WED, *FULL, "21:00")  # day + dinner return, closed by 05:30 on Thursday: 3.00
    _punches(r["DINNER"], THU, "05:30")
    _punches(r["SUN"], SUN, "08:30", "17:00")  # 1.00
    _punches(r["LATE"], TUE, "08:50", "12:45", "13:30", "20:00")  # late: the first 20 minutes are not paid
    _punches(r["EARLY"], THU, "08:30", "12:45", "13:30", "17:30")  # left early
    _punches(r["FORGOT"], WED, "08:30", "12:45", "13:30")  # forgot the out punch: the last one is open
    _punches(r["FORGOT"], THU, *FULL)
    return r


def records_of(emp, d_from=MON, d_to=SUN) -> dict:
    return {rec.date: rec for rec in compute_range_records(emp, d_from, d_to)}


class Base(TestCase):
    def setUp(self):
        _ensure_seed()
        _set_rules(LONG_AGO)
        ps = PayrollSettings.get()
        ps.prod_late_detection_enabled = False
        ps.save()
        self.auth = _hr()

    def get(self, path, **params):
        r = self.client.get(path, params, **self.auth)
        self.assertEqual(r.status_code, 200, r.content)
        return r.json()


# ═════════════════════════════════════════════════════════════════════════════
#  One roster, every screen
# ═════════════════════════════════════════════════════════════════════════════


class RosterAgreementTests(Base):
    def setUp(self):
        super().setUp()
        self.roster = seed_roster()
        self.truth = {name: records_of(emp) for name, emp in self.roster.items()}  # also persists the day records

    # ---- the engine's own answers (hand-checked against the owner's table) --------------------------------------
    def test_the_stored_records_match_the_owners_table(self):
        t = self.truth
        self.assertEqual(t["DAY"][MON].shifts_earned, Decimal("1.50"))
        self.assertEqual(t["OT"][MON].shifts_earned, Decimal("2.00"))
        self.assertEqual(t["OT"][WED].shifts_earned, Decimal("1.50"))
        self.assertEqual(t["NIGHT"][MON].shifts_earned, Decimal("1.50"))
        self.assertEqual(t["NIGHT"][TUE].shifts_earned, Decimal("1.50"))
        self.assertEqual(t["NIGHT"][WED].status, "absent")  # its only punch closed Tuesday's night
        self.assertEqual(t["DINNER"][WED].shifts_earned, Decimal("3.00"))
        self.assertEqual(t["SUN"][SUN].shifts_earned, Decimal("1.00"))
        self.assertTrue(t["LATE"][TUE].is_late)
        self.assertLess(t["LATE"][TUE].shifts_earned, Decimal("1.50"))
        self.assertTrue(t["EARLY"][THU].early_leave)
        self.assertLess(t["EARLY"][THU].shifts_earned, Decimal("1.00"))
        self.assertEqual(t["FORGOT"][WED].shifts_earned, Decimal("0.50"))  # the open third punch is ignored
        self.assertEqual(t["FORGOT"][THU].shifts_earned, Decimal("1.50"))  # Thursday's arrival did not close Wednesday
        self.assertEqual((t["NIGHT"][MON].first_punch, t["NIGHT"][MON].last_punch), (_t("21:00"), _t("05:30")))

    # ---- the HR daily list ---------------------------------------------------------------------------------------
    def test_the_daily_list_agrees_with_the_day_records(self):
        for d in WEEK:
            rows = {row["employeeCode"]: row for row in self.get("/api/attendance/daily", date=d.isoformat())}
            for name, emp in self.roster.items():
                rec = self.truth[name][d]
                row = rows[emp.employee_code]
                with self.subTest(who=name, day=d.isoformat()):
                    if rec.status == "absent":
                        self.assertEqual(row["status"], "absent")
                        self.assertEqual(row["totalPunches"], 0)
                        self.assertNotIn("shiftsEarned", row)
                        continue
                    self.assertEqual(row["status"], "present")
                    self.assertEqual(row["shiftsEarned"], float(rec.shifts_earned))
                    self.assertEqual(row["isLate"], bool(rec.is_late))
                    self.assertEqual(row["isEarlyOut"], bool(rec.early_leave))
                    self.assertEqual(row["firstPunch"], _hhmm(rec.first_punch))
                    self.assertEqual(row["lastPunch"], _hhmm(rec.last_punch))
                    self.assertTrue(row["ruleNote"])

    def test_a_night_workers_closing_punch_is_shown_on_the_shift_day(self):
        row = {r["employeeCode"]: r for r in self.get("/api/attendance/daily", date=MON.isoformat())}["PC_NIGHT"]
        self.assertEqual((row["firstPunch"], row["lastPunch"], row["lastPunchNextDay"]), ("21:00", "05:30", True))
        self.assertEqual(row["totalPunches"], 2)
        self.assertEqual(row["ruleGroup"], "Night shift")
        # ... and on Tuesday the 05:30 punch is not an arrival: Tuesday's own night is 21:00 -> 05:30 (Wednesday)
        row = {r["employeeCode"]: r for r in self.get("/api/attendance/daily", date=TUE.isoformat())}["PC_NIGHT"]
        self.assertEqual((row["firstPunch"], row["lastPunch"]), ("21:00", "05:30"))
        self.assertEqual(row["totalPunches"], 2)

    # ---- the company summary cards -------------------------------------------------------------------------------
    def test_the_company_summary_agrees_with_the_day_records(self):
        for d in (MON, TUE, WED, THU, SUN):
            with mock.patch("api.attendance_views.ist_today", return_value=d):
                body = self.get("/api/attendance/company-summary")
            recs = [self.truth[name][d] for name in self.roster]
            with self.subTest(day=d.isoformat()):
                self.assertEqual(body["totalShiftsEarned"], float(sum(r.shifts_earned or 0 for r in recs)))
                self.assertEqual(body["late"], sum(1 for r in recs if r.is_late))
                self.assertEqual(body["present"], sum(1 for r in recs if r.status == "present"))
                self.assertEqual(body["halfShift"], sum(1 for r in recs if r.status == "half_shift"))
                self.assertEqual(body["absent"], sum(1 for r in recs if r.status == "absent"))

    # ---- employee history, Attendance Search range, shift stats ---------------------------------------------------
    def test_the_history_the_search_range_and_the_stats_agree(self):
        emp = self.roster["NIGHT"]
        history = {
            row["date"]: row for row in self.get(f"/api/attendance/employee/{emp.id}", month=2, year=2026)["records"]
        }
        rng = {
            row["date"]: row
            for row in self.get(
                "/api/attendance/search/range", employeeId=emp.id, startDate=MON.isoformat(), endDate=SUN.isoformat()
            )["days"]
        }
        stats = {
            row["date"]: row
            for row in self.get("/api/attendance/employee-shift-stats", employee_id=emp.id, month=2, year=2026)[
                "dailyLogs"
            ]
        }
        for d in WEEK:
            rec = self.truth["NIGHT"][d]
            key = d.isoformat()
            with self.subTest(day=key):
                self.assertEqual(history[key]["status"], rec.status)
                self.assertEqual(history[key]["firstPunch"], _hhmm(rec.first_punch))
                self.assertEqual(history[key]["lastPunch"], _hhmm(rec.last_punch))
                self.assertEqual(history[key]["isLate"], bool(rec.is_late))
                self.assertEqual(stats[key]["shiftsCompleted"], str(rec.shifts_earned))
                self.assertEqual(rng[key]["status"], rec.status)
        # the punches listed on each day are the SHIFT day's: Monday = 21:00 + 05:30 (next day), Wednesday = none
        self.assertEqual([p["time"] for p in history[MON.isoformat()]["punches"]], ["21:00", "05:30"])
        self.assertTrue(history[MON.isoformat()]["punches"][1]["nextDay"])
        self.assertNotIn("nextDay", history[MON.isoformat()]["punches"][0])
        self.assertEqual(history[WED.isoformat()]["punches"], [])
        self.assertEqual(history[WED.isoformat()]["totalPunches"], 0)
        self.assertEqual([p["time"] for p in rng[MON.isoformat()]["punches"] if p], ["21:00:00", "05:30:00"])
        self.assertTrue(rng[MON.isoformat()]["punches"][1]["nextDay"])
        self.assertEqual([p for p in rng[WED.isoformat()]["punches"] if p], [])

    def test_the_attendance_search_for_one_day_lists_the_shift_days_punches(self):
        body = self.get("/api/attendance/search", query="PC_NIGHT", date=MON.isoformat())
        punches = [p for p in body["results"][0]["punches"] if p]
        self.assertEqual([p["time"] for p in punches], ["21:00:00", "05:30:00"])
        self.assertTrue(punches[1]["nextDay"])
        self.assertEqual(body["results"][0]["totalPunches"], 2)
        # the staff-style raw list is unchanged for a day-shift worker
        body = self.get("/api/attendance/search", query="PC_DAY", date=MON.isoformat())
        self.assertEqual([p["time"] for p in body["results"][0]["punches"] if p], [f"{t}:00" for t in FULL])

    # ---- production payroll ----------------------------------------------------------------------------------------
    def test_payroll_days_detail_agrees_with_the_day_records_and_pay_is_shifts_times_rate(self):
        from .payroll_views import _generate_production_payroll

        for name, emp in self.roster.items():
            result = _generate_production_payroll(emp, MON, SUN, pay_cycle="weekly")
            detail = {row["date"]: row for row in SalarySlip.objects.get(employee=emp).breakdown_details["days"]}
            total = Decimal("0")
            for d in WEEK:
                rec = self.truth[name][d]
                row = detail[d.isoformat()]
                with self.subTest(who=name, day=d.isoformat()):
                    self.assertEqual(row["shiftsEarned"], float(rec.shifts_earned or 0))
                    self.assertEqual(row["status"], rec.status)
                    self.assertEqual(row["isLate"], bool(rec.is_late))
                    self.assertEqual(row["firstPunch"], _hhmm(rec.first_punch))
                    self.assertEqual(row["lastPunch"], _hhmm(rec.last_punch))
                total += rec.shifts_earned or Decimal("0")
            self.assertEqual(result["payroll"].gross_salary, (total * Decimal("500.00")).quantize(Decimal("0.01")))
        night = {
            row["date"]: row for row in SalarySlip.objects.get(employee=self.roster["NIGHT"]).breakdown_details["days"]
        }
        self.assertTrue(night[MON.isoformat()]["lastPunchNextDay"])
        self.assertFalse(night[WED.isoformat()]["lastPunchNextDay"])
        day = {
            row["date"]: row for row in SalarySlip.objects.get(employee=self.roster["DAY"]).breakdown_details["days"]
        }
        self.assertFalse(any(row["lastPunchNextDay"] for row in day.values()))

    def test_production_late_detection_uses_the_day_records_verdict(self):
        from .payroll_views import _generate_production_payroll

        ps = PayrollSettings.get()
        ps.prod_late_detection_enabled = True
        ps.prod_attendance_mode = "simple"
        ps.save()
        # no assigned shift template at all: the earlier template-based check would skip every day
        late = self.roster["LATE"]
        _generate_production_payroll(late, MON, SUN, pay_cycle="weekly")
        slip = SalarySlip.objects.get(employee=late).breakdown_details
        self.assertEqual(slip["deductions"]["lateSummary"]["totalLateCount"], 1)
        tuesday = {row["date"]: row for row in slip["days"]}[TUE.isoformat()]
        self.assertTrue(tuesday["isLate"])
        self.assertIn("Day shift start 08:30 + 5 min grace (08:35)", tuesday["lateReason"])
        # a night worker arriving 21:00 is on time for the NIGHT group (the old 08:30 check would call it hours late)
        night = self.roster["NIGHT"]
        _generate_production_payroll(night, MON, SUN, pay_cycle="weekly")
        self.assertEqual(
            SalarySlip.objects.get(employee=night).breakdown_details["deductions"]["lateSummary"]["totalLateCount"], 0
        )

    def test_strict_mode_early_out_follows_the_records_early_leave_flag(self):
        from .payroll_views import _generate_production_payroll

        ps = PayrollSettings.get()
        ps.prod_late_detection_enabled = True
        ps.prod_attendance_mode = "strict"
        ps.save()
        early = self.roster["EARLY"]
        _generate_production_payroll(early, MON, SUN, pay_cycle="weekly")
        slip = SalarySlip.objects.get(employee=early).breakdown_details
        thursday = {row["date"]: row for row in slip["days"]}[THU.isoformat()]
        self.assertTrue(thursday["isLate"])
        self.assertIn("Last punch 17:30 before Day shift end 20:00 - 5 min grace (19:55)", thursday["lateReason"])
        self.assertEqual(slip["deductions"]["lateSummary"]["totalLateCount"], 1)

    # ---- yesterday's late card -----------------------------------------------------------------------------------
    def test_the_late_card_counts_the_day_records_late_days_not_the_old_template(self):
        body = self.get("/api/attendance/summary", date=WED.isoformat())  # yesterday = Tuesday
        self.assertEqual(body["yesterday"]["late"], 1)  # LATE's 08:50 only; the night worker's 21:00 is on time


class NightSessionGuardTests(Base):
    """The engine's guards on a closing punch are the ones the pages use: the list never disagrees with the record."""

    def _agree(self, emp, d):
        rec = compute_day_record(emp, d)
        row = {r["employeeCode"]: r for r in self.get("/api/attendance/daily", date=d.isoformat())}[emp.employee_code]
        return rec, row

    def test_a_normal_morning_arrival_after_a_forgotten_out_punch_is_not_a_closing_punch(self):
        emp = _worker("NG1")
        _punches(emp, MON, *FULL, "21:00")  # came back after dinner and never punched out
        _punches(
            emp, TUE, "09:00", "12:45", "13:30", "20:00"
        )  # 12 h later: inside the session hours, after the close-by time
        rec, row = self._agree(emp, TUE)
        self.assertEqual(rec.first_punch, _t("09:00"))
        self.assertEqual(row["firstPunch"], "09:00")
        self.assertEqual(row["totalPunches"], 4)
        self.assertEqual(row["shiftsEarned"], float(rec.shifts_earned))
        self.assertTrue(row["isLate"])
        rec, row = self._agree(emp, MON)
        self.assertEqual((row["firstPunch"], row["lastPunch"]), ("08:30", "21:00"))
        self.assertFalse(row["lastPunchNextDay"])
        self.assertEqual(row["shiftsEarned"], float(rec.shifts_earned))

    def test_a_manual_override_day_neither_consumes_nor_is_closed(self):
        emp = _worker("NG2")
        _punches(emp, MON, "21:00")
        _punches(emp, TUE, "05:30")
        AttendanceDayRecord.objects.create(
            employee=emp, date=MON, status="present", shifts_earned=Decimal("1.00"), source="manual", total_punches=1
        )
        rec, row = self._agree(emp, TUE)
        self.assertEqual((rec.first_punch, row["firstPunch"]), (_t("05:30"), "05:30"))  # its own punch: Monday is HR's
        self.assertEqual(row["totalPunches"], 1)
        monday = {r["employeeCode"]: r for r in self.get("/api/attendance/daily", date=MON.isoformat())}["NG2"]
        self.assertEqual((monday["firstPunch"], monday["lastPunch"]), ("21:00", None))  # raw: the override stands

    def test_a_run_of_nights_lines_up_the_same_in_the_list_the_history_and_the_record(self):
        emp = _worker("NG3")
        for i in range(5):  # five nights in a row: 21:00 on each date, 05:30 the next morning
            _punches(emp, MON + timedelta(days=i), "21:00")
            _punches(emp, MON + timedelta(days=i + 1), "05:30")
        history = {
            row["date"]: row for row in self.get(f"/api/attendance/employee/{emp.id}", month=2, year=2026)["records"]
        }
        for i in range(5):
            d = MON + timedelta(days=i)
            rec, row = self._agree(emp, d)
            with self.subTest(night=d.isoformat()):
                self.assertEqual(rec.shifts_earned, Decimal("1.50"))
                self.assertEqual(
                    (row["firstPunch"], row["lastPunch"], row["lastPunchNextDay"]), ("21:00", "05:30", True)
                )
                self.assertEqual([p["time"] for p in history[d.isoformat()]["punches"]], ["21:00", "05:30"])
        self.assertEqual(history[(MON + timedelta(days=5)).isoformat()]["punches"], [])


class LegacyDaysStayLegacyTests(Base):
    """A period that spans the effective date: earlier days are exactly the legacy calculation, later days the table."""

    def test_a_weekly_period_mixes_legacy_and_new_days_and_pays_shifts_times_rate(self):
        from .payroll_views import _generate_production_payroll

        r = seed_roster()
        # 1) everything legacy
        _set_rules(NEVER)
        legacy = {}
        for name, emp in r.items():
            _generate_production_payroll(emp, MON, SUN, pay_cycle="weekly")
            legacy[name] = {row["date"]: row for row in SalarySlip.objects.get(employee=emp).breakdown_details["days"]}
        # 2) the table takes over on Thursday, then the same period is generated again
        _set_rules(THU)
        for name, emp in r.items():
            result = _generate_production_payroll(emp, MON, SUN, pay_cycle="weekly")
            detail = {row["date"]: row for row in SalarySlip.objects.get(employee=emp).breakdown_details["days"]}
            for d in (MON, TUE, WED):  # before the date: identical to the legacy run, field by field
                if name == "NIGHT" and d == WED:
                    continue  # a night's closing punch has no meaning to the legacy calculation; not pinned here
                self.assertEqual(detail[d.isoformat()], legacy[name][d.isoformat()], (name, d))
            total = sum(Decimal(str(row["shiftsEarned"])) for row in detail.values())
            self.assertEqual(result["payroll"].gross_salary, (total * Decimal("500.00")).quantize(Decimal("0.01")))
            self.assertEqual(result["payroll"].present_days, total)
        # hand checks on the days the table judges
        day = {row["date"]: row for row in SalarySlip.objects.get(employee=r["DAY"]).breakdown_details["days"]}
        self.assertEqual(day[THU.isoformat()]["shiftsEarned"], 1.5)
        dinner = {row["date"]: row for row in SalarySlip.objects.get(employee=r["DINNER"]).breakdown_details["days"]}
        self.assertEqual(dinner[WED.isoformat()]["shiftsEarned"], legacy["DINNER"][WED.isoformat()]["shiftsEarned"])
        forgot = {row["date"]: row for row in SalarySlip.objects.get(employee=r["FORGOT"]).breakdown_details["days"]}
        self.assertEqual(forgot[THU.isoformat()]["shiftsEarned"], 1.5)
        early = {row["date"]: row for row in SalarySlip.objects.get(employee=r["EARLY"]).breakdown_details["days"]}
        self.assertEqual(early[THU.isoformat()]["isLate"], False)
        self.assertLess(early[THU.isoformat()]["shiftsEarned"], 1.0)

    def test_the_daily_list_before_the_date_keeps_the_raw_calendar_punches(self):
        emp = _worker("LG1")
        _punches(emp, MON, "21:00")
        _punches(emp, TUE, "05:30")
        _set_rules(WED)
        rows = {r["employeeCode"]: r for r in self.get("/api/attendance/daily", date=TUE.isoformat())}
        self.assertEqual(rows["LG1"]["firstPunch"], "05:30")  # legacy: the calendar date's own punches
        self.assertNotIn("shiftsEarned", rows["LG1"])
        self.assertNotIn(
            "nextDay", str(self.get("/api/attendance/employee/%d" % emp.id, month=2, year=2026)["records"][1])
        )

    def test_a_switched_off_table_changes_nothing(self):
        r = seed_roster()
        _set_rules(LONG_AGO, rules_enabled=False)
        rows = {row["employeeCode"]: row for row in self.get("/api/attendance/daily", date=MON.isoformat())}
        self.assertNotIn("shiftsEarned", rows["PC_DAY"])
        self.assertEqual(rows["PC_NIGHT"]["firstPunch"], "21:00")
        self.assertEqual(rows["PC_NIGHT"]["lastPunch"], None)
        self.assertTrue(r)


class ManualOverrideTests(Base):
    def test_a_day_hr_overrode_by_hand_keeps_its_raw_punches_in_the_list(self):
        emp = _worker("MO1")
        _punches(emp, MON, "08:30", "20:00")
        AttendanceDayRecord.objects.create(
            employee=emp, date=MON, status="present", shifts_earned=Decimal("1.00"), source="manual", total_punches=2
        )
        row = {r["employeeCode"]: r for r in self.get("/api/attendance/daily", date=MON.isoformat())}["MO1"]
        self.assertEqual((row["firstPunch"], row["lastPunch"]), ("08:30", "20:00"))
        self.assertNotIn("shiftsEarned", row)  # the override's value is in the record, not judged again by the list

    def test_the_hr_override_of_a_production_day_keeps_up_to_the_tables_top_value(self):
        from .growth_views import _resolve_override_fields

        emp = _worker("MO2")
        rec = AttendanceDayRecord.objects.create(
            employee=emp, date=MON, status="present", shifts_earned=Decimal("2.50"), source="auto"
        )
        values = _resolve_override_fields(rec, emp, {"status": "present"})
        self.assertEqual(values["shiftsEarned"], "2.50")  # the table is in force: not cut to the old 1.5-shift day
        _set_rules(NEVER)
        values = _resolve_override_fields(rec, emp, {"status": "present"})
        self.assertEqual(values["shiftsEarned"], "1.50")  # before the date: the old cap


# ═════════════════════════════════════════════════════════════════════════════
#  MD portal, demo seed
# ═════════════════════════════════════════════════════════════════════════════


class DemoVerdictTests(Base):
    def test_a_seeded_production_day_in_force_is_the_day_the_engine_computes(self):
        from .management.commands.md_demo.verdicts import production_verdict

        emp = _worker("DM1")
        cases = [
            (MON, ("08:30", "12:45", "13:30", "20:00")),
            (TUE, ("08:38", "12:45", "13:30", "22:30")),  # late under the table's 5-minute grace
            (WED, ("08:30", "12:45", "13:30", "17:30")),  # early
            (SUN, ("08:30", "17:00")),
        ]
        config = ProductionShiftConfig.get()
        segments = list(ProductionShiftSegment.objects.filter(is_active=True))
        for d, times in cases:
            _punches(emp, d, *times)
            rec = compute_day_record(emp, d)
            verdict = production_verdict(config, segments, [_t(x) for x in times], d)
            with self.subTest(day=d.isoformat()):
                self.assertEqual(verdict.status, rec.status)
                self.assertEqual(verdict.shifts, rec.shifts_earned)
                self.assertEqual(verdict.is_late, bool(rec.is_late))
                self.assertEqual(verdict.early_leave, bool(rec.early_leave))
                self.assertEqual((verdict.first_punch, verdict.last_punch), (rec.first_punch, rec.last_punch))

    def test_before_the_effective_date_the_verdict_is_the_legacy_calculation(self):
        from .management.commands.md_demo.verdicts import production_verdict

        _set_rules(NEVER)
        config = ProductionShiftConfig.get()
        segments = list(ProductionShiftSegment.objects.filter(is_active=True))
        times = [_t(x) for x in ("08:30", "12:45", "13:30", "22:30")]
        legacy = _compute_production(None, None, times, None, config, segments)
        verdict = production_verdict(config, segments, times, MON)
        self.assertEqual(verdict.shifts, Decimal(legacy["shifts_earned"]).quantize(Decimal("0.01")))


class MdLateMinutesTests(_MdWorld):
    """The MD portal's average minutes late for a production worker follows the table's group, start and grace."""

    def setUp(self):
        super().setUp()
        _ensure_seed()
        _set_rules(date(2026, 9, 1))  # the table judges the whole week the MD fixture measures (7-13 Sep)

    def avg(self):
        return self.metrics(MA_W)["avgLateMinutes"]["value"]

    def test_production_late_minutes_are_measured_from_the_groups_start_with_the_rules_grace(self):
        # the fixture's four staff late days: 40 + 20 + 30 + 50 = 140 minutes (average 35)
        self.assertEqual(self.avg(), 35.0)
        # a production day flagged late at 08:38: the table's grace is 5 minutes, so it is 8 minutes late (the legacy
        # 10-minute grace could not have measured it at all)
        AttendanceDayRecord.objects.filter(employee=self.e4, date=date(2026, 9, 8)).update(
            is_late=True, first_punch=_t("08:38")
        )
        self.assertEqual(self.avg(), (140 + 8) / 5)
        # a night-group arrival at 21:12 is measured against 21:00, not against 08:30
        AttendanceDayRecord.objects.filter(employee=self.e4, date=date(2026, 9, 9)).update(
            is_late=True, first_punch=_t("21:12")
        )
        self.assertEqual(self.avg(), round((140 + 8 + 12) / 6, 1))
        # a flag the table no longer supports (08:34 is inside the grace) is dropped, never guessed
        AttendanceDayRecord.objects.filter(employee=self.e4, date=date(2026, 9, 8)).update(first_punch=_t("08:34"))
        self.assertEqual(self.avg(), (140 + 12) / 5)

    def test_before_the_effective_date_the_legacy_start_and_ten_minute_grace_still_measure(self):
        _set_rules(NEVER)
        AttendanceDayRecord.objects.filter(employee=self.e4, date=date(2026, 9, 8)).update(
            is_late=True, first_punch=_t("08:50")
        )
        self.assertEqual(self.avg(), (140 + 20) / 5)  # 08:50 - 08:30, past the 08:40 cut-off


# ═════════════════════════════════════════════════════════════════════════════
#  Query counts
# ═════════════════════════════════════════════════════════════════════════════


def _count(fn) -> int:
    with CaptureQueriesContext(connection) as ctx:
        fn()
    return len(ctx)


class QueryCountTests(Base):
    def _fill(self, n, prefix):
        out = []
        for i in range(n):
            emp = _worker(f"{prefix}{i}")
            _punches(emp, MON, *FULL)
            _punches(emp, TUE, "21:00") if i % 2 else None
            _punches(emp, WED, "05:30") if i % 2 else None
            out.append(emp)
        return out

    def _measure(self, call):
        call()  # warm-up: writes the day records, warms the holiday cache
        return _count(call)

    def test_the_company_summary_extra_cost_of_the_rules_is_a_constant_not_per_employee(self):
        def summary():
            with mock.patch("api.attendance_views.ist_today", return_value=TUE):
                self.get("/api/attendance/company-summary")

        self._fill(3, "QA")
        small_new = self._measure(summary)
        _set_rules(NEVER)
        small_old = self._measure(summary)
        extra_small = small_new - small_old
        _set_rules(LONG_AGO)
        self._fill(9, "QB")
        large_new = self._measure(summary)
        _set_rules(NEVER)
        large_old = self._measure(summary)
        extra_large = large_new - large_old
        # the old per-employee growth is not ours; what the rules add must not depend on the roster size
        self.assertEqual(extra_small, extra_large, (extra_small, extra_large))
        self.assertLessEqual(extra_small, 8)

    def test_the_daily_list_costs_the_same_for_three_production_employees_or_twelve(self):
        def daily():
            self.get("/api/attendance/daily", date=TUE.isoformat())

        self._fill(3, "QC")
        small = self._measure(daily)
        self._fill(9, "QD")
        large = self._measure(daily)
        self.assertEqual(small, large, (small, large))

    def test_the_late_card_costs_the_same_for_three_production_employees_or_twelve(self):
        def late():
            self.get("/api/attendance/summary", date=WED.isoformat())

        for emp in self._fill(3, "QE"):
            compute_day_record(emp, TUE)
        small = self._measure(late)
        for emp in self._fill(9, "QF"):
            compute_day_record(emp, TUE)
        large = self._measure(late)
        self.assertEqual(small, large, (small, large))

    def test_the_payroll_loop_costs_the_same_for_every_employee(self):
        from .payroll_views import _generate_production_payroll

        ps = PayrollSettings.get()
        ps.prod_late_detection_enabled = True
        ps.save()
        workers = self._fill(4, "QG")
        config = ProductionShiftConfig.get()
        for w in workers:
            _generate_production_payroll(w, MON, SUN, pay_cycle="weekly", prod_config=config)
        counts = [
            _count(lambda w=w: _generate_production_payroll(w, MON, SUN, pay_cycle="weekly", prod_config=config))
            for w in workers
        ]
        self.assertEqual(len(set(counts)), 1, counts)

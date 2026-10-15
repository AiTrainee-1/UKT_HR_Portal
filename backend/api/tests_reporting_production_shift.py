"""
Report Center x production shift rules (api.production_shift_rules).

From the date the shift-table rules take over, every report that shows a production day must give the numbers the
attendance engine stores for it: shifts earned, late, early, and the punches of the SHIFT DAY (a night worker's closing
punch belongs to the day the shift began). Before that date the legacy calculation stays.

The roster below has every shape the table has to meet; each report is compared with ``compute_day_record`` (the engine
payroll reads) day by day. "Today" is pinned to 2026-09-29 for the date filters.

Run via: python manage.py test api.tests_reporting_production_shift -v 2
"""

import importlib
import io
from datetime import date, time, timedelta
from decimal import Decimal
from unittest.mock import patch

from django.apps import apps as django_apps
from django.db import connection
from django.test import TestCase
from django.test.utils import CaptureQueriesContext
from openpyxl import load_workbook

from .attendance_final import compute_day_record
from .jwt_utils import sign_token
from .models import (
    AttendanceDayRecord,
    AttendanceLog,
    Branch,
    Department,
    Designation,
    Employee,
    HRUser,
    ProductionBreak,
    ProductionShiftConfig,
    ProductionShiftGroup,
    ProductionShiftRule,
    Role,
)
from .reporting.export_xlsx import HEADER_ROW

TODAY = date(2026, 9, 29)
EFFECTIVE = date(2026, 9, 1)  # the shift table judges every day from here
PID = "production-daily-punches"
SID = "production-shift-rules"

MON = date(2026, 9, 21)
TUE, WED, THU, FRI, SAT, SUN = (MON + timedelta(days=i) for i in range(1, 7))
LEGACY_DAY = date(2026, 8, 31)  # a Monday before the rules start


def hdr(user: HRUser) -> dict:
    return {"HTTP_AUTHORIZATION": f"Bearer {sign_token({'role': 'hr', 'hrUserId': user.id})}"}


def _ensure_seed():
    """The migration seeds the three groups and the breaks; a TransactionTestCase elsewhere may have flushed them."""
    if not ProductionShiftGroup.objects.exists() or not ProductionBreak.objects.exists():
        ProductionShiftGroup.objects.all().delete()
        ProductionBreak.objects.all().delete()
        importlib.import_module("api.migrations.0121_production_shift_rules").seed(django_apps, None)


def _set_rules(effective_from=EFFECTIVE, **fields):
    config = ProductionShiftConfig.get()
    config.rules_effective_from = effective_from
    for key, value in fields.items():
        setattr(config, key, value)
    config.save()
    return config


def _log(emp, day, *times):
    for hh, mm, ss in times:
        AttendanceLog.objects.create(
            employee=emp, date=day, punch_time=time(hh, mm, ss), punch_type="IN", source="biometric:dev1"
        )


def _clock(t) -> str:
    return t.strftime("%H:%M:%S")


class _ProductionWorld(TestCase):
    """A production roster over the week 21-27 Sep 2026 (+ a legacy day), judged by the shift table from 1 Sep."""

    @classmethod
    def setUpTestData(cls):
        _ensure_seed()
        cls.config = _set_rules()
        cls.b1 = Branch.objects.create(name="Unit 1", code="U1")
        cls.b2 = Branch.objects.create(name="Unit 2", code="U2")
        cls.dept = Department.objects.create(name="STITCHING", branch=cls.b1)
        cls.dept2 = Department.objects.create(name="PACKING", branch=cls.b2)
        cls.des = Designation.objects.create(title="Operator", department=cls.dept, level="junior")

        def mk(code, **kw):
            kw.setdefault("branch", cls.b1)
            kw.setdefault("department", cls.dept)
            return Employee.objects.create(
                employee_code=code,
                first_name=code,
                last_name="Worker",
                employment_type="production",
                designation=cls.des,
                **kw,
            )

        cls.day_w = mk("D1")  # day shift, one overtime day
        cls.late_w = mk("L1")  # arrives late, leaves early
        cls.night_w = mk("N1")  # nights Mon and Tue, closing punches the next morning
        cls.dinner_w = mk("N2")  # day + dinner + 05:30 the next morning
        cls.sun_w = mk("S1")  # a Sunday worker
        cls.forgot_w = mk("F1")  # forgets the out punch on Wednesday
        cls.manual_w = mk("M1")  # HR entered Wednesday by hand
        cls.other_unit = mk("U9", branch=cls.b2, department=cls.dept2)
        cls.staff = Employee.objects.create(
            employee_code="ST1", first_name="Staff", last_name="Sam", employment_type="staff", branch=cls.b1
        )

        # D1: Mon 08:30-20:00 with lunch (1.50), Tue to 22:30 (2.00), and a legacy-day pattern
        _log(cls.day_w, MON, (8, 29, 40), (12, 45, 5), (13, 30, 10), (20, 0, 3))
        _log(cls.day_w, TUE, (8, 30, 0), (12, 46, 0), (13, 31, 0), (22, 30, 20))
        _log(cls.day_w, LEGACY_DAY, (8, 30, 0), (12, 45, 0), (13, 30, 0), (20, 0, 0))
        # L1: late 08:50 and leaves 17:30 (early, below the 20:00 standard out)
        _log(cls.late_w, MON, (8, 50, 0), (12, 45, 0), (13, 30, 0), (17, 30, 0))
        # N1: night only. Mon 21:00 -> Tue 05:30, Tue 21:00 -> Wed 05:30 (a chain of two nights)
        _log(cls.night_w, MON, (21, 0, 5))
        _log(cls.night_w, TUE, (5, 30, 10), (21, 0, 8))
        _log(cls.night_w, WED, (5, 31, 0))
        # N2: day + dinner + 05:30: 08:30 12:45 13:30 20:00 21:00 then 05:30 next morning
        _log(cls.dinner_w, MON, (8, 30, 0), (12, 45, 0), (13, 30, 0), (20, 0, 0), (21, 0, 30))
        _log(cls.dinner_w, TUE, (5, 30, 0))
        # S1: Sunday 08:30 -> 17:00
        _log(cls.sun_w, SUN, (8, 30, 0), (17, 0, 0))
        # F1: Wednesday no out punch (3 punches); Thursday a normal day (the next morning's arrival must not close it)
        _log(cls.forgot_w, WED, (8, 30, 0), (12, 45, 0), (13, 30, 0))
        _log(cls.forgot_w, THU, (8, 31, 0), (12, 45, 0), (13, 30, 0), (20, 0, 0))
        # M1: Wednesday has punches that would give 1.50, but HR entered 2.50 by hand
        _log(cls.manual_w, WED, (8, 30, 0), (12, 45, 0), (13, 30, 0), (20, 0, 0))
        AttendanceDayRecord.objects.create(
            employee=cls.manual_w,
            date=WED,
            status="present",
            shifts_earned=Decimal("2.50"),
            source="manual",
            override_note="HR entry",
        )
        _log(cls.other_unit, MON, (8, 30, 0), (20, 0, 0))
        _log(cls.staff, MON, (9, 0, 0), (18, 0, 0))

        cls.admin = HRUser.objects.create(username="hr_admin", password_hash="x", is_super_admin=True)

        def user(name, perms, **kw):
            role = Role.objects.create(name=name, permissions={"reports": "view", **perms})
            return HRUser.objects.create(username=name, password_hash="x", role=role, **kw)

        cls.attendance_user = user("hr_att", {"attendance": "view"})
        cls.salary_user = user("hr_sal", {"salary": "view", "payroll": "view"})
        cls.branch_user = user("hr_branch1", {"attendance": "view"}, branch=cls.b1)

    def mk(self, code):
        return Employee.objects.create(
            employee_code=code,
            first_name=code,
            last_name="Worker",
            employment_type="production",
            designation=self.des,
            branch=self.b1,
            department=self.dept,
        )

    def setUp(self):
        p = patch("api.reporting.filters.ist_today", return_value=TODAY)
        p.start()
        self.addCleanup(p.stop)

    def get(self, rid=PID, user=None, expect=200, **params):
        r = self.client.get(f"/api/reports/run/{rid}", params, **hdr(user or self.admin))
        self.assertEqual(r.status_code, expect, r.content[:400])
        return r.json()

    def export(self, rid=PID, fmt="xlsx", user=None, expect=200, **params):
        r = self.client.get(f"/api/reports/export/{rid}", {"fmt": fmt, **params}, **hdr(user or self.admin))
        self.assertEqual(r.status_code, expect, r.content[:400])
        return r

    @staticmethod
    def data(body) -> list[dict]:
        return [r for r in body["rows"] if not r.get("_kind")]

    def by_key(self, body) -> dict:
        return {(r["employeeCode"], r["date"]): r for r in self.data(body)}

    def week(self, **extra) -> dict:
        return self.by_key(self.get(dateFrom=LEGACY_DAY.isoformat(), dateTo="2026-09-27", **extra))


class ShiftDayListingTests(_ProductionWorld):
    def test_a_night_workers_closing_punch_is_listed_on_the_day_the_shift_began(self):
        rows = self.week()
        mon = rows[("N1", "2026-09-21")]
        self.assertEqual(mon["punches"], "21:00:05, 05:30:10 (+1)")
        self.assertEqual((mon["punchCount"], mon["shift"], mon["shiftsEarned"]), (2, "Night shift", 1.5))
        tue = rows[("N1", "2026-09-22")]
        self.assertEqual(tue["punches"], "21:00:08, 05:31:00 (+1)")  # the second night of the chain
        self.assertEqual((tue["punchCount"], tue["shiftsEarned"]), (2, 1.5))

    def test_the_closing_punch_is_not_listed_again_on_the_next_date(self):
        rows = self.week()
        # Wednesday holds only the 05:31 that closes Tuesday's night: no shift began that day
        self.assertNotIn(("N1", "2026-09-23"), rows)
        # and Tuesday does not start with the 05:30 that closed Monday's night
        self.assertTrue(rows[("N1", "2026-09-22")]["punches"].startswith("21:00:08"))

    def test_day_dinner_and_the_next_morning_is_one_shift_day(self):
        row = self.week()[("N2", "2026-09-21")]
        self.assertEqual(row["punches"], "08:30:00, 12:45:00, 13:30:00, 20:00:00, 21:00:30, 05:30:00 (+1)")
        self.assertEqual((row["punchCount"], row["shift"], row["shiftsEarned"]), (6, "Day shift", 3.0))
        self.assertNotIn(("N2", "2026-09-22"), self.week())

    def test_the_hand_computed_rows(self):
        rows = self.week()
        day = rows[("D1", "2026-09-21")]
        self.assertEqual((day["shift"], day["shiftsEarned"], day["late"], day["early"]), ("Day shift", 1.5, None, None))
        self.assertIn("20:00", day["ruleApplied"])
        self.assertEqual(rows[("D1", "2026-09-22")]["shiftsEarned"], 2.0)  # 22:30 earns 2.00
        late = rows[("L1", "2026-09-21")]
        self.assertEqual((late["late"], late["early"]), ("Late", "Early"))
        self.assertLess(late["shiftsEarned"], 1.0)
        sun = rows[("S1", "2026-09-27")]
        self.assertEqual((sun["shift"], sun["shiftsEarned"]), ("Sunday shift", 1.0))

    def test_a_forgotten_out_punch_is_not_closed_by_the_next_mornings_arrival(self):
        rows = self.week()
        wed = rows[("F1", "2026-09-23")]
        self.assertEqual((wed["punches"], wed["punchCount"]), ("08:30:00, 12:45:00, 13:30:00", 3))
        self.assertEqual(wed["shiftsEarned"], 0.5)  # the open last punch is ignored
        self.assertTrue(rows[("F1", "2026-09-24")]["punches"].startswith("08:31:00"))

    def test_a_day_before_the_start_date_is_the_legacy_calculation_listed_by_calendar_date(self):
        row = self.week()[("D1", "2026-08-31")]
        self.assertEqual(row["shift"], "Legacy rules")
        self.assertIn("Previous calculation", row["ruleApplied"])
        self.assertIn("01-Sep-2026", row["ruleApplied"])

    def test_a_day_hr_entered_by_hand_shows_the_value_hr_entered(self):
        row = self.week()[("M1", "2026-09-23")]
        self.assertEqual((row["shift"], row["shiftsEarned"]), ("Manual entry", 2.5))
        self.assertIn("HR", row["ruleApplied"])

    def test_a_double_tap_counts_as_a_stored_punch_but_does_not_break_the_pairing(self):
        _log(self.day_w, THU, (8, 30, 0), (8, 31, 0), (20, 0, 0))  # a double tap on arrival, then the departure
        row = self.week()[("D1", "2026-09-24")]
        self.assertEqual(row["punchCount"], 3)  # every stored punch is counted
        self.assertEqual(row["shiftsEarned"], 1.5)  # but the double tap is not a second "in"

    def test_the_total_line_adds_the_shifts(self):
        body = self.get(dateFrom=MON.isoformat(), dateTo=TUE.isoformat(), employeeIds=str(self.day_w.id))
        total = next(r for r in body["rows"] if r.get("_kind") == "subtotal")
        self.assertEqual(total["shiftsEarned"], 3.5)  # 1.50 + 2.00
        self.assertEqual(body["totals"]["shiftsEarned"], 3.5)  # the grand total does not count the line again
        cards = {c["label"]: c["value"] for c in body["summary"]}
        self.assertEqual(cards["Total shifts earned"], 3.5)

    def test_the_notes_explain_the_shift_day_listing(self):
        text = " ".join(self.get(dateFrom=MON.isoformat(), dateTo=MON.isoformat())["notes"])
        self.assertIn("SHIFT DAY", text)
        self.assertIn("01-Sep-2026", text)
        self.assertIn("never saved by this report", text)

    def test_staff_and_other_units_follow_the_normal_scope_rules(self):
        self.assertNotIn("ST1", {code for code, _d in self.week()})
        mine = {
            code
            for code, _d in self.by_key(self.get(user=self.branch_user, dateFrom="2026-09-21", dateTo="2026-09-27"))
        }
        self.assertNotIn("U9", mine)
        self.assertIn("D1", mine)


class AgreementWithTheEngineTests(_ProductionWorld):
    """The report is a pure read of the same calculation payroll runs: every employee-day must match."""

    def test_every_listed_day_equals_the_engine(self):
        rows = self.week()
        self.assertGreaterEqual(len(rows), 11)
        checked = 0
        for emp in (self.day_w, self.late_w, self.night_w, self.dinner_w, self.sun_w, self.forgot_w, self.manual_w):
            for day in (LEGACY_DAY, *(MON + timedelta(days=i) for i in range(7))):
                row = rows.get((emp.employee_code, day.isoformat()))
                if row is None:
                    continue
                rec = compute_day_record(emp, day)
                label = (emp.employee_code, day.isoformat())
                self.assertEqual(Decimal(str(row["shiftsEarned"])), rec.shifts_earned, label)
                self.assertEqual(row["late"] == "Late", bool(rec.is_late), label)
                self.assertEqual(row["early"] == "Early", bool(rec.early_leave), label)
                texts = row["punches"].split(", ")
                if rec.source == "manual":  # kept exactly as HR entered it: no punch times on the record
                    continue
                self.assertEqual(texts[0].split(" ")[0], _clock(rec.first_punch), label)
                if rec.last_punch is not None:
                    self.assertEqual(texts[-1].split(" ")[0], _clock(rec.last_punch), label)
                checked += 1
        self.assertGreaterEqual(checked, 10)  # the manual day is compared on shifts only above

    def test_the_report_never_writes(self):
        from django.apps import apps

        def counts():
            return {
                m.__name__: m.objects.count()
                for m in apps.get_app_config("api").get_models()
                if m.__name__ != "AuditLog"
            }

        before = counts()
        self.week()
        self.get(rid=SID)
        self.export(dateFrom="2026-09-21", dateTo="2026-09-27")
        self.export(fmt="pdf", dateFrom="2026-09-21", dateTo="2026-09-27")
        self.export(rid=SID)
        self.assertEqual(counts(), before)
        self.assertEqual(AttendanceDayRecord.objects.count(), 1)  # only the manual row seeded above


class CostTests(_ProductionWorld):
    def _queries(self, **params) -> int:
        self.get(**params)  # warm the permission caches
        with CaptureQueriesContext(connection) as q:
            self.get(**params)
        return len(q)

    def test_the_query_count_does_not_grow_with_employees_or_days(self):
        params = {"dateFrom": "2026-09-21", "dateTo": "2026-09-27"}
        before = self._queries(**params)
        for i in range(15):
            emp = self.mk(f"X{i}")
            for d in range(7):
                _log(emp, MON + timedelta(days=d), (8, 30, 0), (12, 45, 0), (13, 30, 0), (20, 0, 0))
            _log(emp, MON, (21, 0, 0))
            _log(emp, TUE, (5, 30, 0))
        self.assertEqual(self._queries(**params), before)
        wider = self._queries(dateFrom="2026-09-01", dateTo="2026-09-29")  # more days, same number of queries
        self.assertEqual(wider, before)
        self.assertGreater(len(self.data(self.get(**params))), 20)

    def test_the_month_cap_and_row_limits_still_apply(self):
        r = self.client.get(
            f"/api/reports/run/{PID}", {"dateFrom": "2026-08-01", "dateTo": "2026-09-29"}, **hdr(self.admin)
        )
        self.assertEqual(r.status_code, 400)
        with patch("api.reporting.runner.XLSX_ROW_LIMIT", 3):
            r = self.client.get(
                f"/api/reports/export/{PID}",
                {"fmt": "xlsx", "dateFrom": "2026-09-21", "dateTo": "2026-09-27"},
                **hdr(self.admin),
            )
        self.assertEqual(r.status_code, 413)


class ExportAgreementTests(_ProductionWorld):
    def test_excel_and_pdf_carry_the_screen_numbers(self):
        params = {"dateFrom": "2026-09-21", "dateTo": "2026-09-27"}
        screen = self.get(**params)
        sheet = load_workbook(io.BytesIO(self.export(**params).content)).active
        header = [c.value for c in sheet[HEADER_ROW]]
        self.assertEqual(header[6:11], ["Shift", "Total Punch Count", "Shifts Earned", "Late", "Early"])
        shifts_col = header.index("Shifts Earned")
        punch_col = header.index("All Punches (exact times)")
        excel = [
            (row[punch_col].value, float(row[shifts_col].value))
            for row in sheet.iter_rows(min_row=HEADER_ROW + 1)
            if row[0].value and row[1].value
        ]
        self.assertEqual(sorted(excel), sorted((r["punches"], r["shiftsEarned"]) for r in self.data(screen)))
        self.assertTrue(self.export(fmt="pdf", **params).content.startswith(b"%PDF"))


class ShiftRulesReportTests(_ProductionWorld):
    def test_it_is_registered_with_the_attendance_module_in_hr_reports(self):
        body = self.client.get("/api/reports/catalog", **hdr(self.admin)).json()
        report = next(r for r in body["reports"] if r["id"] == SID)
        self.assertEqual((report["title"], report["category"]), ("Production Shift Rules", "hr"))
        self.assertEqual(
            [c["label"] for c in report["columns"]],
            ["Type", "Group", "Applies on", "Starts", "Out time", "Shift value", "Detail"],
        )
        self.assertEqual(self.get(rid=SID, user=self.attendance_user)["summary"][0]["value"], 3)
        self.get(rid=SID, user=self.salary_user, expect=403)

    def test_one_row_per_ladder_point_of_every_enabled_group_plus_the_breaks(self):
        body = self.get(rid=SID)
        rules = [r for r in body["rows"] if r["kind"] == "Shift rule"]
        breaks = [r for r in body["rows"] if r["kind"] == "Break"]
        saved = ProductionShiftRule.objects.filter(enabled=True, group__enabled=True).count()
        self.assertEqual((len(rules), len(breaks)), (saved, ProductionBreak.objects.filter(enabled=True).count()))
        day = [(r["outTime"], r["shiftValue"]) for r in rules if r["group"] == "Day shift"]
        self.assertEqual(
            day,
            [
                ("10:30", 0.25),
                ("12:45", 0.5),
                ("15:30", 0.75),
                ("17:45", 1.0),
                ("20:00", 1.5),
                ("22:30", 2.0),
                ("00:30 (next day)", 2.5),
                ("05:30 (next day)", 3.0),
            ],
        )
        night = [(r["starts"], r["outTime"], r["shiftValue"]) for r in rules if r["group"] == "Night shift"]
        self.assertEqual(night, [("21:00", "00:00 (next day)", 0.5), ("21:00", "05:30 (next day)", 1.5)])
        sunday = next(r for r in rules if r["group"] == "Sunday shift")
        self.assertEqual(
            (sunday["appliesOn"], sunday["starts"], sunday["outTime"], sunday["shiftValue"]),
            ("Sunday", "08:30", "17:00", 1.0),
        )
        lunch = next(r for r in breaks if r["group"] == "Lunch")
        self.assertEqual((lunch["starts"], lunch["shiftValue"]), ("12:45", None))
        self.assertIn("45 min", lunch["detail"])

    def test_the_cards_and_notes_state_the_settings_and_the_legacy_rule(self):
        body = self.get(rid=SID)
        cards = {c["label"]: c["value"] for c in body["summary"]}
        self.assertEqual(cards["Enabled groups"], 3)
        self.assertEqual(cards["Grace (min)"], 5)
        self.assertEqual(cards["Applies from"], "2026-09-01")
        self.assertEqual(cards["Full-day value"], 1.0)
        text = " ".join(body["notes"])
        self.assertIn("from 01-Sep-2026 onwards", text)
        self.assertIn("Days before the start date keep the previous calculation", text)
        self.assertIn("10-minute grace", text)  # the legacy grace is described, never changed

    def test_it_equals_the_saved_rules_after_an_edit(self):
        rule = ProductionShiftRule.objects.get(group__label="Day shift", out_time=time(17, 45))
        rule.shift_value = Decimal("1.10")
        rule.save()
        ProductionShiftRule.objects.get(group__label="Day shift", out_time=time(15, 30)).delete()
        ProductionBreak.objects.filter(label="Lunch").update(enabled=False)
        ProductionShiftRule.objects.filter(group__label="Day shift", out_time=time(10, 30)).update(enabled=False)
        body = self.get(rid=SID)
        day = {r["outTime"]: r["shiftValue"] for r in body["rows"] if r["group"] == "Day shift"}
        self.assertEqual(day["17:45"], 1.1)
        self.assertNotIn("15:30", day)
        self.assertNotIn("10:30", day)  # a disabled rule is not listed
        self.assertNotIn("Lunch", [r["group"] for r in body["rows"]])
        self.assertIn("disabled rule(s)", " ".join(body["notes"]))
        self.assertIn("disabled break(s)", " ".join(body["notes"]))

    def test_a_switched_off_rule_set_says_so(self):
        _set_rules(rules_enabled=False)
        self.assertIn("switched OFF", " ".join(self.get(rid=SID)["notes"]))
        ProductionShiftConfig.objects.filter(pk=1).update(rules_enabled=True, rules_effective_from=None)
        self.assertIn("no start date yet", " ".join(self.get(rid=SID)["notes"]))

    def test_screen_equals_excel_and_pdf_renders(self):
        screen = self.get(rid=SID)
        sheet = load_workbook(io.BytesIO(self.export(rid=SID).content)).active
        header = [c.value for c in sheet[HEADER_ROW]]
        self.assertEqual(header, [c["label"] for c in screen["columns"]])
        body = [
            [c.value for c in row] for row in sheet.iter_rows(min_row=HEADER_ROW + 1) if row[0].value and row[1].value
        ]
        self.assertEqual(len(body), len(screen["rows"]))
        for row, shown in zip(body, screen["rows"]):
            self.assertEqual(row[1], shown["group"])
            self.assertEqual(row[4], shown["outTime"])
            self.assertEqual(None if row[5] in (None, "") else float(row[5]), shown["shiftValue"])
        self.assertTrue(self.export(rid=SID, fmt="pdf").content.startswith(b"%PDF"))

    def test_the_rules_are_company_wide_so_a_branch_login_reads_the_same_table(self):
        self.assertEqual(
            [r["group"] for r in self.get(rid=SID, user=self.branch_user)["rows"]],
            [r["group"] for r in self.get(rid=SID)["rows"]],
        )

    def test_it_needs_a_login(self):
        self.assertEqual(self.client.get(f"/api/reports/run/{SID}").status_code, 401)


# ═════════════════════════════════════════════════════════════════════════════
#  The other Report Center reports: they read the day record (or the shared judge) and must agree with the engine
# ═════════════════════════════════════════════════════════════════════════════

ROSTER = ("D1", "L1", "N1", "N2", "S1", "F1", "M1")


class OtherReportsAgreeTests(_ProductionWorld):
    @classmethod
    def setUpTestData(cls):
        super().setUpTestData()

    def setUp(self):
        super().setUp()
        # what the Attendance screens do when somebody opens a day: the engine stores its verdict (the reports read it)
        self.recs = {}
        for emp in Employee.objects.filter(employee_code__in=ROSTER):
            for day in (LEGACY_DAY, *(MON + timedelta(days=i) for i in range(7))):
                self.recs[(emp.employee_code, day)] = compute_day_record(emp, day)

    def daily(self, **extra):
        body = self.get(
            rid="daily-attendance", staffType="production", dateFrom="2026-09-21", dateTo="2026-09-27", **extra
        )
        return {(r["employeeCode"], r["date"]): r for r in body["rows"]}

    def test_the_daily_register_agrees_with_the_engine_for_every_production_day(self):
        rows = self.daily()
        checked = 0
        for (code, day), rec in self.recs.items():
            row = rows.get((code, day.isoformat()))
            if row is None or rec.status == "absent":
                continue
            label = (code, day.isoformat())
            self.assertEqual(Decimal(str(row["shiftsEarned"])), rec.shifts_earned, label)
            self.assertEqual("Late" in (row["flags"] or ""), bool(rec.is_late), label)
            self.assertEqual("Early out" in (row["flags"] or ""), bool(rec.early_leave), label)
            if rec.source != "manual":
                self.assertEqual(row["firstIn"], rec.first_punch.strftime("%H:%M"), label)
                if rec.last_punch is not None:
                    self.assertEqual(row["lastOut"], rec.last_punch.strftime("%H:%M"), label)
            checked += 1
        self.assertGreaterEqual(checked, 9)

    def test_a_night_workers_day_shows_the_closing_punch_on_the_shift_day(self):
        rows = self.daily()
        mon = rows[("N1", "2026-09-21")]
        self.assertEqual((mon["firstIn"], mon["lastOut"], mon["punchCount"]), ("21:00", "05:30", 2))
        self.assertIn("Exit after midnight", mon["flags"])
        self.assertEqual(mon["shiftsEarned"], 1.5)
        dinner = rows[("N2", "2026-09-21")]
        self.assertEqual((dinner["firstIn"], dinner["lastOut"], dinner["punchCount"]), ("08:30", "05:30", 6))
        self.assertEqual(dinner["shiftsEarned"], 3.0)

    def test_late_and_early_minutes_are_measured_from_the_groups_times_with_the_rules_grace(self):
        late = self.daily()[("L1", "2026-09-21")]
        self.assertEqual(late["lateMinutes"], 20)  # 08:50 against the 08:30 start
        self.assertEqual(late["earlyOutMinutes"], 150)  # 17:30 against the 20:00 standard out
        # on time within the 5-minute grace (08:31 is not late), and the legacy 10-minute grace is not used
        self.assertIsNone(self.daily()[("F1", "2026-09-24")]["lateMinutes"])

    def test_late_coming_detail_uses_the_group_start_and_the_rules_grace(self):
        body = self.get(rid="late-coming-detail", dateFrom="2026-08-31", dateTo="2026-09-27")
        rows = {(r["employeeCode"], r["date"]): r for r in body["rows"] if r.get("employeeCode")}
        self.assertEqual(set(rows), {("L1", "2026-09-21")})
        row = rows[("L1", "2026-09-21")]
        self.assertEqual(
            (
                row["shift"],
                row["shiftStart"],
                row["graceMinutes"],
                row["deadline"],
                row["lateMinutes"],
                row["beyondGrace"],
            ),
            ("Production: Day shift", "08:30", 5, "08:35", 20, 15),
        )
        self.assertIn("group's start time", " ".join(body["notes"]))

    def test_a_legacy_day_is_still_measured_against_the_legacy_times(self):
        _log(
            self.late_w, LEGACY_DAY, (8, 45, 0), (20, 0, 0)
        )  # 08:45 is 15 minutes after 08:30: late under the legacy rule
        compute_day_record(self.late_w, LEGACY_DAY)
        # AttendanceDayRecord of that day was stored before the extra punches: recompute it
        rec = AttendanceDayRecord.objects.get(employee=self.late_w, date=LEGACY_DAY)
        self.assertEqual((rec.is_late, rec.source), (True, "auto"))
        row = next(
            r
            for r in self.get(rid="late-coming-detail", dateFrom="2026-08-31", dateTo="2026-08-31")["rows"]
            if r["employeeCode"] == "L1"
        )
        self.assertEqual(
            (row["shift"], row["shiftStart"], row["graceMinutes"], row["lateMinutes"]),
            ("Production (fixed times)", "08:30", 10, 15),
        )

    def test_early_out_detail_uses_the_groups_main_out(self):
        body = self.get(rid="early-out", dateFrom="2026-09-21", dateTo="2026-09-27")
        rows = {(r["employeeCode"], r["date"]): r for r in body["rows"] if r.get("employeeCode")}
        row = rows[("L1", "2026-09-21")]
        self.assertEqual(
            (row["shift"], row["shiftEnd"], row["deadline"], row["earlyMinutes"]),
            ("Production: Day shift", "20:00", "19:55", 150),
        )
        # F1 forgot the out punch on Wednesday: the engine flags the open last punch (13:30) as an early leave. Nobody
        # who left at the standard out is listed, a night worker closing at 05:30 included.
        self.assertEqual({code for code, _d in rows}, {"L1", "F1"})
        self.assertEqual(rows[("F1", "2026-09-23")]["earlyMinutes"], 390)  # 13:30 against 20:00

    def test_the_production_shift_register_equals_the_stored_shifts(self):
        body = self.get(rid="production-shift-register", dateFrom="2026-09-21", dateTo="2026-09-27")
        by_code = {r["employeeCode"]: r for r in body["rows"] if r.get("employeeCode")}
        for code in ROSTER:
            expected = sum(
                float(rec.shifts_earned)
                for (c, day), rec in self.recs.items()
                if c == code and MON <= day <= SUN and rec.status in ("present", "half_shift")
            )
            if code in by_code:
                self.assertEqual(by_code[code]["totalShifts"], round(expected, 2), code)
        self.assertEqual(by_code["N2"]["totalShifts"], 3.0)
        self.assertEqual(by_code["D1"]["totalShifts"], 3.5)
        self.assertEqual(by_code["L1"]["lateDays"], 1)

    def test_the_time_card_and_muster_read_the_same_day(self):
        body = self.get(rid="attendance-muster-sheet", period="2026-09", staffType="production")
        text = " ".join(body["notes"])
        self.assertIn("full-day value", text)


class NightSessionGuardTests(_ProductionWorld):
    """The engine's closing-punch rules (production_shift_rules docstring) as the reports show them."""

    def row(self, code, day, **extra):
        body = self.get(dateFrom=day, dateTo=day, **extra)
        return {r["employeeCode"]: r for r in self.data(body)}.get(code)

    def test_a_long_unbroken_run_of_nights_lines_up_even_when_only_the_last_days_are_asked_for(self):
        worker = self.mk("N3")
        for i in range(16):  # nights 12-27 Sep: 21:00, closed at 05:30 the next morning
            day = date(2026, 9, 12) + timedelta(days=i)
            _log(worker, day, (21, 0, 0))
            _log(worker, day + timedelta(days=1), (5, 30, 0))
        # the 05:30 of the 28th closes the 27th's night; the 13th..28th each carry one 21:00
        for asked in ("2026-09-26", "2026-09-27"):
            row = self.row("N3", asked, employeeIds=str(worker.id))
            self.assertEqual(row["punches"], "21:00:00, 05:30:00 (+1)", asked)
            self.assertEqual((row["punchCount"], row["shiftsEarned"], row["shift"]), (2, 1.5, "Night shift"), asked)
            self.assertEqual(
                compute_day_record(worker, date.fromisoformat(asked)).shifts_earned, Decimal(str(row["shiftsEarned"]))
            )
        # the 12th's own 05:30 (closing the 11th, which has no punches) is a fresh start, not a closing punch
        first = self.row("N3", "2026-09-13", employeeIds=str(worker.id))
        self.assertEqual(first["punches"], "21:00:00, 05:30:00 (+1)")

    def test_a_manual_day_neither_closes_nor_is_closed(self):
        worker = self.mk("N4")
        _log(worker, MON, (21, 0, 0))
        _log(worker, TUE, (5, 30, 0))
        AttendanceDayRecord.objects.create(
            employee=worker, date=TUE, status="present", shifts_earned=Decimal("1.00"), source="manual"
        )
        mon = self.row("N4", "2026-09-21", employeeIds=str(worker.id))
        self.assertEqual((mon["punches"], mon["punchCount"]), ("21:00:00", 1))  # Tuesday is HR's: nothing is taken
        tue = self.row("N4", "2026-09-22", employeeIds=str(worker.id))
        self.assertEqual((tue["shift"], tue["punches"], tue["shiftsEarned"]), ("Manual entry", "05:30:00", 1.0))
        engine = compute_day_record(worker, MON)
        self.assertEqual((engine.total_punches, engine.last_punch), (1, None))  # the engine agrees: a lone punch

    def test_a_night_does_not_cross_the_start_date_of_the_rules(self):
        worker = self.mk("N5")
        _log(worker, LEGACY_DAY, (21, 0, 0))  # 31 Aug: before the rules start
        _log(worker, EFFECTIVE, (5, 30, 0))
        legacy = self.row("N5", "2026-08-31", employeeIds=str(worker.id))
        self.assertEqual((legacy["shift"], legacy["punches"]), ("Legacy rules", "21:00:00"))
        first = self.row("N5", "2026-09-01", employeeIds=str(worker.id))
        self.assertEqual(first["punches"], "05:30:00")  # not taken by the legacy day

    def test_a_morning_arrival_after_a_forgotten_out_punch_is_a_new_day(self):
        worker = self.mk("N6")
        _log(worker, MON, (8, 30, 0), (12, 45, 0), (13, 30, 0))  # forgot the out punch
        _log(worker, TUE, (8, 29, 0), (20, 0, 0))
        self.assertEqual(self.row("N6", "2026-09-21", employeeIds=str(worker.id))["punchCount"], 3)
        self.assertEqual(self.row("N6", "2026-09-22", employeeIds=str(worker.id))["punches"], "08:29:00, 20:00:00")

    def test_the_daily_register_and_the_report_agree_on_a_long_night_run(self):
        worker = self.mk("N7")
        for i in range(12):
            day = date(2026, 9, 10) + timedelta(days=i)
            _log(worker, day, (21, 0, 0))
            _log(worker, day + timedelta(days=1), (5, 30, 0))
        for i in range(12):
            compute_day_record(worker, date(2026, 9, 10) + timedelta(days=i))
        body = self.get(
            rid="daily-attendance",
            staffType="production",
            dateFrom="2026-09-20",
            dateTo="2026-09-21",
            employeeIds=str(worker.id),
        )
        rows = {r["date"]: r for r in body["rows"]}
        for asked in ("2026-09-20", "2026-09-21"):
            self.assertEqual(
                (rows[asked]["firstIn"], rows[asked]["lastOut"], rows[asked]["punchCount"]),
                ("21:00", "05:30", 2),
                asked,
            )
            self.assertEqual(rows[asked]["shiftsEarned"], 1.5)

    def test_the_query_count_stays_flat_when_a_long_night_run_needs_more_history(self):
        params = {"dateFrom": "2026-09-26", "dateTo": "2026-09-27"}
        self.get(**params)
        with CaptureQueriesContext(connection) as q0:
            self.get(**params)
        for n in range(6):
            worker = self.mk(f"NX{n}")
            for i in range(16):
                day = date(2026, 9, 12) + timedelta(days=i)
                _log(worker, day, (21, 0, 0))
                _log(worker, day + timedelta(days=1), (5, 30, 0))
        with CaptureQueriesContext(connection) as q1:
            body = self.get(**params)
        self.assertEqual(len(q1), len(q0) + 1)  # one extra read for the workers on a long run, whatever their number
        self.assertEqual(len([r for r in self.data(body) if r["employeeCode"].startswith("NX")]), 12)

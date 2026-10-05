"""MD portal · Dashboard (md_portal/analytics/dashboard.py and routes/dashboard.py).

Run:  DB_TEST_NAME=test_uktex_dashboard python manage.py test api.tests_md_dashboard --noinput

The Dashboard calculates nothing of its own: it composes what the other pages compute. So two kinds of test.

COMPOSITION, with stand-in modules whose cards and exceptions are written out in the test: which eight cards, how the
exceptions are merged (repeats, severity, turns between pages), what the briefing says word for word, and that one module
failing (an exception, a database error, a slow query, an import error) costs only that module.

THE REAL MODULES, on one small company whose figures can be recomputed by hand. Today is Monday 2026-10-05, 12:00.

  Unit 1: Stitching (S1..S10), Cutting (C1..C4)           Unit 2: Stitching (T1..T10)  <- same department name
  C4 joined on 2026-10-02 (a joiner this month); G (Stitching, Unit 1) resigned, last working day 2026-10-01 (a leaver)

  Punches today: S1..S7 (3 of Unit 1's Stitching are not in), C1..C4, T1..T10.
  Unit 1: 14 scheduled, 11 in, 3 not in = 78.6 %      Unit 2: 10 scheduled, 10 in = 100 %      company 24, 21 in = 87.5 %
  Department "Stitching" (both units): 20 scheduled, 17 in, 3 not in = 85.0 %  <- the weakest department

  Day records: Monday 2026-09-28 only, for all 24: 20 present, 4 absent -> the last 30 days' attendance is 83.3 %.
  Payroll: August 3 slips of 20,000 = 60,000.  September 20,000 + 20,000 + 22,000 + 3,000 overtime = 65,000 (+8.3 %).
  Hiring this month: 1 joined, 1 left (net 0); 24 active people.
"""

import json
from contextlib import ExitStack, contextmanager
from datetime import date, datetime, time, timedelta
from decimal import Decimal
from types import SimpleNamespace
from unittest import mock

from django.db import connection
from django.test import SimpleTestCase, override_settings
from django.test.utils import CaptureQueriesContext

from .md_portal import common as C
from .md_portal.analytics import attendance as A
from .md_portal.analytics import dashboard as D
from .md_portal.analytics import employees as E
from .md_portal.analytics import payroll as P
from .md_portal.assistant import registry
from .md_portal.common import MdParamError, Scope, read_only_db
from .models import (
    AttendanceDayRecord,
    AttendanceLog,
    Branch,
    Department,
    Employee,
    HRUser,
    Payroll,
    ResignationRequest,
    SalarySlip,
)
from .tests_md_support import MdApiTestCase, md_headers

TODAY = date(2026, 10, 5)  # a Monday
BASE = "/api/md/dashboard/"


@contextmanager
def at(day: date = TODAY, hour: int = 12):
    """Freeze the factory clock everywhere the Dashboard and the modules it reads look at it."""
    now = datetime.combine(day, time(hour, 0))
    with ExitStack() as stack:
        for target, name, value in (
            (A, "ist_today", day),
            (A, "ist_now", now),
            (P, "_today", day),
            (E, "ist_today", day),
            (D, "ist_today", day),
            (D, "ist_now", now),
            (C, "ist_today", day),
            (C, "ist_now", now),
        ):
            stack.enter_context(mock.patch.object(target, name, return_value=value))
        yield


# ─── stand-in modules ───────────────────────────────────────────────────────────────────────────────────────────────


def kpi(id_, label, value, fmt="number", page="employees", sub=None, delta=None, spark=None):
    return {
        "id": id_,
        "label": label,
        "value": value,
        "format": fmt,
        "sub": sub,
        "delta": delta,
        "spark": spark,
        "page": page,
    }


def item(id_, severity, title, page, detail=None):
    return {
        "id": id_,
        "severity": severity,
        "title": title,
        "detail": detail,
        "metric": None,
        "page": page,
        "ask": f"Why: {title}?",
    }


def stand_in(kpis=(), insights=(), provenance=(), **extra):
    return SimpleNamespace(
        headline=lambda today=None: {"kpis": list(kpis), "provenance": list(provenance)},
        insights=lambda today=None: list(insights),
        **extra,
    )


def boom(today=None):
    raise RuntimeError("secret internal detail: password=hunter2")


LIVE = {
    "date": "2026-10-05",
    "asOf": None,
    "isWorkingDay": True,
    "expected": 1190,
    "present": 1075,
    "leave": 20,
    "absent": 95,
    "attendancePct": 90.3,
    "byUnit": [
        {"id": 1, "name": "Unit 1", "expected": 700, "present": 595, "leave": 10, "absent": 95, "attendancePct": 85.0},
        {"id": 2, "name": "Unit 2", "expected": 490, "present": 480, "leave": 10, "absent": 0, "attendancePct": 98.0},
    ],
    "byDepartment": [
        {"name": "Stitching", "expected": 400, "present": 330, "leave": 0, "absent": 70, "attendancePct": 82.5},
        {"name": "Cutting", "expected": 300, "present": 300, "leave": 0, "absent": 0, "attendancePct": 100.0},
        {"name": "Admin", "expected": 6, "present": 1, "leave": 0, "absent": 5, "attendancePct": 16.7},
    ],
}

PAYROLL_TREND = {
    "hasData": True,
    "month": "2026-09",
    "months": [
        {"month": "2026-08", "label": "Aug 2026", "hasData": True, "grossPay": 23_000_000.0, "state": "paid"},
        {"month": "2026-09", "label": "Sep 2026", "hasData": True, "grossPay": 24_000_000.0, "state": "generated"},
    ],
}


def world(**overrides):
    """Seven stand-in modules with a full, realistic set of cards and exceptions; a test replaces what it needs."""
    modules = {
        "attendance": stand_in(
            [
                kpi("attendance-today", "Attendance today", 90.3, "pct", "attendance", sub="1,075 of 1,190 in so far"),
                kpi(
                    "absenteeism-30d",
                    "Absenteeism, 30 days",
                    4.2,
                    "pct",
                    "attendance",
                    delta={"abs": 0.4, "pct": 10.5, "good": "down"},
                    spark=[4, 4.1, 4.2],
                ),
                kpi("late-30d", "Late arrivals, 30 days", 6.0, "pct", "attendance"),
            ],
            [
                item(
                    "attendance.dept-spike",
                    "critical",
                    "Stitching absenteeism is 14%, double its 90-day average",
                    "attendance",
                ),
                item("attendance.improved", "good", "Attendance rose 1.8 points to 93.4%", "attendance"),
            ],
            [{"id": "live-today", "title": "In so far today"}, {"id": "absenteeism-pct", "title": "Absenteeism %"}],
            live_today=lambda scope, today: LIVE,
            attendance_trend=lambda scope, period: {"average": {"attendancePct": 93.4}, "points": []},
        ),
        "employees": stand_in(
            [
                kpi(
                    "employees.headcount",
                    "Active headcount",
                    1240,
                    "number",
                    "employees",
                    sub="Staff 310 · Production 930",
                ),
                kpi("employees.attrition-12m", "Attrition (12 months)", 14.2, "pct", "employees"),
                kpi("employees.joiners-leavers", "Joiners vs leavers (this month)", 5, "number", "employees"),
            ],
            [
                item(
                    "employees.hotspot",
                    "warning",
                    "Stitching attrition is 21.4%, against 14.2% across the company",
                    "employees",
                )
            ],
            [{"id": "headcount", "title": "Active headcount"}, {"id": "attrition", "title": "Attrition"}],
            movement=lambda scope, period, today=None: {"totals": {"joiners": 14, "leavers": 9, "net": 5}},
        ),
        "payroll": stand_in(
            [
                kpi("payroll-gross", "Payroll cost", 24_000_000.0, "inr_compact", "payroll"),
                kpi("payroll-cost-per-head", "Cost per head", 19_354.0, "inr_compact", "payroll"),
                kpi("payroll-overtime", "Overtime cost", 1_500_000.0, "inr_compact", "payroll"),
            ],
            [
                item(
                    "payroll.unpaid-2026-09", "warning", "12 of 1,200 slips for Sep 2026 are not marked paid", "payroll"
                )
            ],
            [{"id": "gross-pay", "title": "Gross pay"}, {"id": "overtime", "title": "Overtime"}],
            payroll_trend=lambda scope, month, months: PAYROLL_TREND,
        ),
        "recruitment": stand_in(
            [
                kpi("recruitment.open_positions", "Open positions", 12, "number", "recruitment"),
                kpi("recruitment.joined_this_month", "Joined this month", 14, "number", "recruitment"),
                kpi(
                    "recruitment.pending_resignations",
                    "Resignations awaiting decision",
                    2,
                    "number",
                    "recruitment",
                    sub="Oldest waiting 12 days",
                ),
            ],
            [item("recruitment.stale", "info", "3 positions have been open more than 45 days", "recruitment")],
            [{"id": "open-positions", "title": "Open positions"}],
        ),
        "visitors": stand_in(
            [
                kpi("visitors-today", "Visitors today", 18, "number", "visitors"),
                kpi("outpasses-today", "Outpasses today", 6, "number", "visitors"),
            ],
            [],
            [{"id": "visits", "title": "Visits"}],
        ),
        "tea_break": stand_in(
            [kpi("tea-break.overrun-pct", "Break overruns", 22.5, "pct", "tea-break")],
            [],
            [{"id": "tea-overrun", "title": "Overruns"}],
        ),
        "activity": stand_in(
            [kpi("activity.sensitive", "Sensitive actions", 4, "number", "activity")],
            [item("activity.calm", "good", "Nothing unusual in the system in the last 7 days", "activity")],
            [{"id": "sensitive", "title": "Sensitive actions"}],
        ),
    }
    modules.update(overrides)

    def load(name):
        if name not in modules:
            raise ImportError(f"No module named {name}")
        return modules[name]

    return load


def collected(module: str, items: list[dict]) -> D.Collected:
    src = D.SOURCE_BY_MODULE[module]
    normalise = D._normalise_kpi if items and "format" in items[0] else None
    if normalise:
        return D.Collected(src, [normalise(i, src) for i in items])
    return D.Collected(src, [D._normalise_insight(i, src, n) for n, i in enumerate(items)])


# ─── pure rules ─────────────────────────────────────────────────────────────────────────────────────────────────────


class FormattingTests(SimpleTestCase):
    def test_rupees_are_written_the_way_the_cards_write_them(self):
        cases = {
            0: "₹0",
            45_200: "₹45,200",
            99_999: "₹99,999",
            100_000: "₹1 L",
            1_240_000: "₹12.4 L",
            24_000_000: "₹2.4 Cr",
            12_500_000: "₹1.25 Cr",
            -150_000: "-₹1.5 L",
        }
        for value, text in cases.items():
            self.assertEqual(D.inr_compact(value), text, value)
        self.assertIsNone(D.inr_compact(None))

    def test_indian_grouping(self):
        self.assertEqual(D._indian(1234567), "12,34,567")
        self.assertEqual(D._indian(1234567.5, 1), "12,34,567.5")
        self.assertEqual(D._indian(999), "999")
        self.assertEqual(D._indian(-12345), "-12,345")

    def test_a_card_figure_is_text_by_its_format(self):
        self.assertEqual(D.kpi_display({"value": 91.84, "format": "pct"}), "91.8%")
        self.assertEqual(D.kpi_display({"value": 100.0, "format": "pct"}), "100%")
        self.assertEqual(D.kpi_display({"value": 1240, "format": "number"}), "1,240")
        self.assertEqual(D.kpi_display({"value": 12.5, "format": "number"}), "12.5")
        self.assertEqual(D.kpi_display({"value": 125, "format": "minutes"}), "2h 05m")
        self.assertEqual(D.kpi_display({"value": 45, "format": "minutes"}), "45m")
        self.assertEqual(D.kpi_display({"value": 1234567, "format": "inr"}), "₹12,34,567")
        self.assertEqual(D.kpi_display({"value": "Mixed", "format": "text"}), "Mixed")
        self.assertIsNone(D.kpi_display({"value": None, "format": "pct"}))  # no data is not "0%"


class SharedRules(SimpleTestCase):
    def test_the_dashboard_follows_the_attendance_pages_rules_not_its_own_copy_of_them(self):
        self.assertEqual(D._settled_hour(), A.UNIT_TODAY_AFTER_HOUR)  # "people are still arriving" until this hour
        self.assertEqual(D.WEAKEST_MIN_EXPECTED, A.UNIT_TODAY_MIN_HEADCOUNT)  # a team this small is never "weakest"

    def test_every_source_is_a_real_module_with_the_two_hooks_and_a_real_page(self):
        for source in D.SOURCES:
            module = D._analytics(source.module)
            self.assertTrue(callable(module.headline) and callable(module.insights), source.module)
            self.assertIn(source.page, D.PAGE_BY_ID)


class PickingTheCards(SimpleTestCase):
    def cards(self, *pairs):
        return [
            collected(module, [kpi(i, i, 1, page=D.SOURCE_BY_MODULE[module].page) for i in ids])
            for module, ids in pairs
        ]

    def test_the_eight_in_priority_order_whatever_order_the_modules_answered(self):
        found = self.cards(
            ("visitors", ["outpasses-today", "visitors-today"]),
            ("payroll", ["payroll-cost-per-head", "payroll-overtime", "payroll-gross"]),
            ("recruitment", ["recruitment.open_positions", "recruitment.joined_this_month"]),
            ("employees", ["employees.attrition-12m", "employees.headcount"]),
            ("attendance", ["late-30d", "absenteeism-30d", "attendance-today"]),
        )
        shown = [k["id"] for k in D.pick_kpis(found)]
        self.assertEqual(
            shown,
            [
                "employees.headcount",
                "attendance-today",
                "absenteeism-30d",
                "employees.attrition-12m",
                "payroll-gross",
                "payroll-overtime",
                "recruitment.open_positions",
                "visitors-today",
            ],
        )

    def test_a_missing_module_is_replaced_by_a_reserve_so_the_strip_stays_full(self):
        found = self.cards(
            ("attendance", ["attendance-today", "absenteeism-30d", "late-30d"]),
            ("employees", ["employees.headcount", "employees.attrition-12m"]),
            ("recruitment", ["recruitment.open_positions", "recruitment.pending_resignations"]),
            ("visitors", ["visitors-today", "outpasses-today"]),
            ("tea_break", ["tea-break.overrun-pct"]),
        )  # payroll is down
        shown = [k["id"] for k in D.pick_kpis(found)]
        self.assertEqual(len(shown), 8)
        self.assertNotIn("payroll-gross", shown)
        self.assertEqual(
            shown[:4], ["employees.headcount", "attendance-today", "absenteeism-30d", "employees.attrition-12m"]
        )
        self.assertEqual(shown[4:6], ["recruitment.open_positions", "visitors-today"])  # primaries keep their order
        self.assertEqual(shown[6:], ["late-30d", "recruitment.pending_resignations"])  # then the reserves

    def test_unknown_cards_fill_the_strip_and_a_repeated_id_keeps_the_first(self):
        found = [
            collected("attendance", [kpi("a.one", "One", 1), kpi("a.two", "Two", 2)]),
            collected("employees", [kpi("a.one", "Repeated", 9), kpi("e.three", "Three", 3)]),
        ]
        picked = D.pick_kpis(found)
        self.assertEqual([k["id"] for k in picked], ["a.one", "a.two", "e.three"])
        self.assertEqual(picked[0]["label"], "One")

    def test_at_most_eight_and_malformed_cards_are_dropped(self):
        many = [kpi(f"x.{n}", f"X{n}", n) for n in range(20)]
        self.assertEqual(len(D.pick_kpis([collected("attendance", many)])), 8)
        src = D.SOURCE_BY_MODULE["attendance"]
        self.assertIsNone(D._normalise_kpi({"label": "no id"}, src))
        self.assertIsNone(D._normalise_kpi("nonsense", src))
        self.assertEqual(D._normalise_kpi(kpi("a", "A", 1, page="not-a-page"), src)["page"], "attendance")

    def test_the_modules_own_dict_is_never_edited(self):
        original = kpi("a", "A", 1, delta={"abs": 1, "pct": 2, "good": "up"}, spark=[1, 2])
        copy_of = D._normalise_kpi(original, D.SOURCE_BY_MODULE["attendance"])
        copy_of["delta"]["abs"] = 99
        copy_of["spark"].append(3)
        self.assertEqual(original["delta"]["abs"], 1)
        self.assertEqual(original["spark"], [1, 2])


class MergingTheExceptions(SimpleTestCase):
    def merge(self, **by_module):
        found = [collected(m, items) for m, items in by_module.items()]
        return D.merge_insights(found)

    def test_most_serious_first_whatever_page_it_came_from(self):
        items, total = self.merge(
            attendance=[item("a.good", "good", "G", "attendance"), item("a.info", "info", "I", "attendance")],
            payroll=[item("p.crit", "critical", "C", "payroll"), item("p.warn", "warning", "W", "payroll")],
        )
        self.assertEqual([i["id"] for i in items], ["p.crit", "p.warn", "a.info", "a.good"])
        self.assertEqual(total, 4)

    def test_pages_take_turns_within_a_level_so_one_page_cannot_fill_the_list(self):
        items, total = self.merge(
            attendance=[item(f"a.{n}", "warning", f"Attendance {n}", "attendance") for n in range(5)],
            employees=[item("e.0", "warning", "Employees 0", "employees")],
            payroll=[item("p.0", "warning", "Payroll 0", "payroll"), item("p.1", "warning", "Payroll 1", "payroll")],
        )
        self.assertEqual([i["id"] for i in items], ["a.0", "e.0", "p.0", "a.1", "p.1", "a.2", "a.3", "a.4"])
        self.assertEqual(total, 8)

    def test_repeats_are_removed_by_id_and_by_title(self):
        items, total = self.merge(
            attendance=[item("shared.id", "warning", "First title", "attendance")],
            employees=[item("shared.id", "warning", "Other title", "employees")],
            payroll=[
                item("p.1", "warning", "  first TITLE ", "payroll"),
                item("p.2", "warning", "Different", "payroll"),
            ],
        )
        self.assertEqual([i["id"] for i in items], ["shared.id", "p.2"])
        self.assertEqual(total, 2)

    def test_the_list_is_capped_and_the_total_says_how_many_were_left_out(self):
        many = [item(f"x.{n}", "warning", f"Warning {n}", "attendance") for n in range(12)]
        items, total = self.merge(attendance=many)
        self.assertEqual((len(items), total), (8, 12))
        self.assertEqual(items[0]["id"], "x.0")  # the module's own order is kept

    def test_good_news_is_limited_so_it_cannot_bury_a_problem(self):
        items, total = self.merge(
            attendance=[item(f"g.{n}", "good", f"Good {n}", "attendance") for n in range(5)],
            payroll=[item("p.1", "info", "Info", "payroll")],
        )
        self.assertEqual([i["id"] for i in items], ["p.1", "g.0", "g.1"])
        self.assertEqual(total, 6)

    def test_malformed_items_are_dropped_and_odd_values_repaired(self):
        src = D.SOURCE_BY_MODULE["visitors"]
        self.assertIsNone(D._normalise_insight({"severity": "warning"}, src, 0))
        self.assertIsNone(D._normalise_insight({"title": "  "}, src, 0))
        repaired = D._normalise_insight({"title": "T", "severity": "alarming", "page": "nowhere"}, src, 3)
        self.assertEqual(
            (repaired["severity"], repaired["page"], repaired["id"]), ("info", "visitors", "visitors.item-3")
        )
        self.assertEqual(repaired["module"], "visitors")


def inputs(**kw) -> D.BriefingInputs:
    """A full day: the figures of the stand-in world, settled."""
    cards = {
        "attendance-today": kpi("attendance-today", "A", 90.3, "pct", "attendance"),
        "employees.attrition-12m": kpi("employees.attrition-12m", "Attr", 14.2, "pct"),
        "recruitment.open_positions": kpi("recruitment.open_positions", "Open", 12),
        "recruitment.pending_resignations": kpi(
            "recruitment.pending_resignations", "Waiting", 2, page="recruitment", sub="Oldest waiting 12 days"
        ),
    }
    base = {
        "settled": True,
        "kpis": cards,
        "insights": [
            {
                **item("a.crit", "critical", "Stitching absenteeism is 14%, double its 90-day average", "attendance"),
                "module": "attendance",
            },
            {**item("e.warn", "warning", "Stitching attrition is 21.4%", "employees"), "module": "employees"},
            {**item("p.warn", "warning", "12 slips are not marked paid", "payroll"), "module": "payroll"},
        ],
        "units": {
            "isWorkingDay": True,
            "total": {"expected": 1190, "present": 1075},
            "rows": LIVE["byUnit"],
            "weakestDepartment": {
                "name": "Stitching",
                "expected": 400,
                "present": 330,
                "absent": 70,
                "attendancePct": 82.5,
            },
        },
        "attendance_average": 93.4,
        "payroll": {
            "label": "Sep 2026",
            "gross": 24_000_000.0,
            "state": "generated",
            "previousLabel": "Aug 2026",
            "changePct": 4.3,
        },
        "hiring": {"joiners": 14, "leavers": 9, "net": 5},
    }
    base.update(kw)
    return D.BriefingInputs(**base)


class TheBriefing(SimpleTestCase):
    def lines(self, **kw):
        return {s["id"]: s for s in D.build_briefing(inputs(**kw))["sentences"]}

    def test_a_full_day_reads_like_a_chief_of_staff_and_every_sentence_names_its_page(self):
        briefing = D.build_briefing(inputs())
        texts = [s["text"] for s in briefing["sentences"]]
        self.assertEqual(
            texts,
            [
                "Attendance is 90.3% so far today, 3.1 points below the 30-day average of 93.4%.",
                "Unit 1 is the weakest unit so far today, at 85% (595 of 700 in), and Stitching the weakest department, at 82.5%.",
                "Payroll for Sep 2026 came to ₹2.4 Cr, 4.3% more than Aug 2026.",
                "This month 14 people joined and 9 left (net +5); attrition over the last 12 months is 14.2%, with 12 positions open.",
                "2 resignations are waiting for a decision (oldest waiting 12 days).",
                "The most important item: Stitching absenteeism is 14%, double its 90-day average. 2 other items also need a look.",
            ],
        )
        self.assertEqual(
            [s["page"] for s in briefing["sentences"]],
            ["attendance", "attendance", "payroll", "employees", "recruitment", "attendance"],
        )
        self.assertEqual(
            [s["tone"] for s in briefing["sentences"]], ["watch", "watch", "neutral", "neutral", "watch", "watch"]
        )
        self.assertEqual(briefing["text"], " ".join(texts))
        self.assertEqual(briefing["ask"], D.BRIEFING_QUESTION)
        self.assertTrue(4 <= len(texts) <= 6)

    def test_attendance_against_its_average_in_three_wordings(self):
        def sentence(today, average):
            kpis = dict(inputs().kpis, **{"attendance-today": kpi("attendance-today", "A", today, "pct")})
            return self.lines(kpis=kpis, attendance_average=average)["attendance"]

        self.assertEqual(
            sentence(94.0, 93.4)["text"], "Attendance is 94% so far today, in line with the 30-day average of 93.4%."
        )
        above = sentence(95.4, 93.4)
        self.assertEqual(above["text"], "Attendance is 95.4% so far today, 2 points above the 30-day average of 93.4%.")
        self.assertEqual(above["tone"], "good")
        one = sentence(92.4, 93.4)
        self.assertEqual(one["text"], "Attendance is 92.4% so far today, 1 point below the 30-day average of 93.4%.")
        self.assertEqual(one["tone"], "neutral")
        self.assertEqual(sentence(90.0, 93.4)["tone"], "watch")

    def test_early_in_the_day_it_says_so_and_does_not_compare_units(self):
        lines = self.lines(settled=False)
        self.assertEqual(
            lines["attendance"]["text"],
            "It is still early: 1,075 of 1,190 scheduled people have punched in so far; attendance has averaged 93.4% over the last 30 days.",
        )
        self.assertNotIn("weakest", lines)

    def test_a_weekly_off_is_not_an_attendance_problem(self):
        units = dict(inputs().units, isWorkingDay=False)
        lines = self.lines(units=units)
        self.assertEqual(
            lines["attendance"]["text"],
            "Today is a weekly off or a holiday, so nobody is scheduled; attendance has averaged 93.4% over the last 30 days.",
        )
        self.assertNotIn("weakest", lines)

    def test_without_the_average_or_without_today_it_says_only_what_it_knows(self):
        self.assertEqual(self.lines(attendance_average=None)["attendance"]["text"], "Attendance is 90.3% so far today.")
        no_today = self.lines(kpis={}, attendance_average=93.4)
        self.assertEqual(no_today["attendance"]["text"], "Attendance has averaged 93.4% over the last 30 days.")
        self.assertNotIn("attendance", self.lines(kpis={}, attendance_average=None))

    def test_the_weakest_unit_needs_two_units_enough_people_and_someone_missing(self):
        one_unit = dict(inputs().units, rows=LIVE["byUnit"][:1])
        self.assertEqual(
            self.lines(units=one_unit)["weakest"]["text"],
            "Stitching is the weakest department so far today, at 82.5% (330 of 400 in).",
        )
        everyone_in = dict(
            inputs().units,
            rows=[dict(r, absent=0, attendancePct=100.0) for r in LIVE["byUnit"]],
            weakestDepartment=None,
        )
        self.assertNotIn("weakest", self.lines(units=everyone_in))
        tiny = dict(inputs().units, rows=[dict(r, expected=6) for r in LIVE["byUnit"]], weakestDepartment=None)
        self.assertNotIn("weakest", self.lines(units=tiny))

    def test_payroll_wordings(self):
        base = inputs().payroll
        less = self.lines(payroll=dict(base, changePct=-2.5))["payroll"]["text"]
        self.assertEqual(less, "Payroll for Sep 2026 came to ₹2.4 Cr, 2.5% less than Aug 2026.")
        same = self.lines(payroll=dict(base, changePct=0.0))["payroll"]["text"]
        self.assertEqual(same, "Payroll for Sep 2026 came to ₹2.4 Cr, the same as Aug 2026.")
        first = self.lines(payroll=dict(base, previousLabel=None, changePct=None))["payroll"]["text"]
        self.assertEqual(first, "Payroll for Sep 2026 came to ₹2.4 Cr.")
        running = self.lines(payroll=dict(base, state="in_progress"))["payroll"]["text"]
        self.assertTrue(running.endswith("(the month is still running, so this is provisional)."), running)
        self.assertNotIn("payroll", self.lines(payroll=None))
        self.assertNotIn("payroll", self.lines(payroll=dict(base, gross=None)))

    def test_hiring_wordings(self):
        joined_one = self.lines(hiring={"joiners": 1, "leavers": 3, "net": -2})["hiring"]
        self.assertTrue(
            joined_one["text"].startswith("This month 1 person joined and 3 left (net -2);"), joined_one["text"]
        )
        self.assertEqual(joined_one["tone"], "watch")
        flat = self.lines(hiring={"joiners": 2, "leavers": 2, "net": 0})["hiring"]["text"]
        self.assertIn("2 people joined and 2 left (no net change)", flat)
        cards = dict(inputs().kpis, **{"recruitment.open_positions": kpi("recruitment.open_positions", "Open", 0)})
        self.assertTrue(self.lines(kpis=cards)["hiring"]["text"].endswith(", with no positions open."))
        attrition_only = self.lines(
            hiring=None, kpis={"employees.attrition-12m": inputs().kpis["employees.attrition-12m"]}
        )
        self.assertEqual(attrition_only["hiring"]["text"], "Attrition over the last 12 months is 14.2%.")
        self.assertNotIn("hiring", self.lines(hiring=None, kpis={}))

    def test_resignations_waiting_appear_only_when_there_are_some(self):
        cards = dict(inputs().kpis)
        cards["recruitment.pending_resignations"] = kpi("recruitment.pending_resignations", "W", 1, page="recruitment")
        self.assertEqual(self.lines(kpis=cards)["decisions"]["text"], "1 resignation is waiting for a decision.")
        cards["recruitment.pending_resignations"] = kpi("recruitment.pending_resignations", "W", 0, page="recruitment")
        self.assertNotIn("decisions", self.lines(kpis=cards))

    def test_the_single_most_important_exception(self):
        alone = self.lines(insights=inputs().insights[:1])["exception"]
        self.assertEqual(
            alone["text"], "The most important item: Stitching absenteeism is 14%, double its 90-day average."
        )
        self.assertEqual((alone["page"], alone["tone"]), ("attendance", "watch"))
        info = self.lines(insights=[item("v.1", "info", "3 positions are open too long", "recruitment")])["exception"]
        self.assertEqual(info["text"], "Nothing urgent. For your information: 3 positions are open too long.")
        self.assertEqual(info["page"], "recruitment")
        good = self.lines(insights=[item("a.1", "good", "Attendance rose 1.8 points to 93.4%", "attendance")])[
            "exception"
        ]
        self.assertEqual(good["text"], "Nothing urgent, and some good news: Attendance rose 1.8 points to 93.4%.")
        self.assertEqual(good["tone"], "good")
        none = self.lines(insights=[])["exception"]
        self.assertIn("needs your attention right now", none["text"])
        down = self.lines(insights=[], sources_ok=0)["exception"]
        self.assertEqual(down["text"], "The exception checks could not run just now.")

    def test_an_empty_company_still_gets_an_honest_briefing(self):
        briefing = D.build_briefing(D.BriefingInputs(settled=True))
        self.assertEqual([s["id"] for s in briefing["sentences"]], ["exception"])
        self.assertTrue(briefing["text"])


# ─── composition with stand-in modules ──────────────────────────────────────────────────────────────────────────────


class Composition(MdApiTestCase):
    def setUp(self):
        super().setUp()
        D._MEMO.clear()

    def overview(self, modules=None, **kw):
        with mock.patch.object(D, "_analytics", side_effect=modules or world()):
            return D.overview(today=TODAY, **kw)

    def overview_failing(self, modules, **kw):
        """An overview in which something is MEANT to fail: the failure must be logged (that is where the reason goes)
        and the log line is returned alongside the answer."""
        with self.assertLogs(D.logger.name, level="ERROR") as logs:
            data = self.overview(modules, **kw)
        return data, " | ".join(logs.output)

    def test_the_first_screen_in_one_answer(self):
        data = self.overview()
        self.assertEqual(
            [k["id"] for k in data["kpis"]],
            [
                "employees.headcount",
                "attendance-today",
                "absenteeism-30d",
                "employees.attrition-12m",
                "payroll-gross",
                "payroll-overtime",
                "recruitment.open_positions",
                "visitors-today",
            ],
        )
        first = data["kpis"][0]
        self.assertEqual(
            (first["value"], first["display"], first["page"], first["module"]),
            (1240, "1,240", "employees", "employees"),
        )
        by_id = {k["id"]: k for k in data["kpis"]}
        self.assertEqual(by_id["payroll-gross"]["display"], "₹2.4 Cr")
        self.assertEqual(by_id["absenteeism-30d"]["delta"], {"abs": 0.4, "pct": 10.5, "good": "down"})
        self.assertEqual(by_id["absenteeism-30d"]["spark"], [4, 4.1, 4.2])
        self.assertEqual(data["today"], "2026-10-05")
        self.assertEqual(data["scope"]["description"], "All units · all departments · staff and production")

    def test_exceptions_are_merged_most_serious_first(self):
        data = self.overview()
        self.assertEqual(
            [(i["severity"], i["module"]) for i in data["insights"]],
            [
                ("critical", "attendance"),
                ("warning", "employees"),
                ("warning", "payroll"),
                ("info", "recruitment"),
                ("good", "attendance"),
                ("good", "activity"),
            ],
        )
        self.assertEqual(data["insightsTotal"], 6)
        self.assertEqual(data["insights"][0]["ask"], "Why: Stitching absenteeism is 14%, double its 90-day average?")

    def test_the_briefing_uses_the_same_figures(self):
        data = self.overview()
        self.assertEqual(
            [s["text"] for s in data["briefing"]["sentences"]][:3],
            [
                "Attendance is 90.3% so far today, 3.1 points below the 30-day average of 93.4%.",
                "Unit 1 is the weakest unit so far today, at 85% (595 of 700 in), and Stitching the weakest department, at 82.5%.",
                "Payroll for Sep 2026 came to ₹2.4 Cr, 4.3% more than Aug 2026.",
            ],
        )
        self.assertEqual(len(data["briefing"]["sentences"]), 6)

    def test_today_by_unit_is_the_attendance_pages_own_count_weakest_first(self):
        units = self.overview()["units"]
        self.assertEqual([r["name"] for r in units["rows"]], ["Unit 1", "Unit 2"])
        self.assertEqual(
            units["rows"][0],
            {
                "id": 1,
                "name": "Unit 1",
                "expected": 700,
                "present": 595,
                "late": None,
                "leave": 10,
                "absent": 95,
                "attendancePct": 85.0,
            },
        )
        self.assertEqual(
            units["total"],
            {"expected": 1190, "present": 1075, "late": None, "leave": 20, "absent": 95, "attendancePct": 90.3},
        )
        self.assertFalse(units["lateKnown"])
        self.assertTrue(units["provisional"])
        self.assertEqual(units["weakestDepartment"]["name"], "Stitching")  # Admin is too small to be called weakest
        self.assertEqual(units["weakestDepartment"]["attendancePct"], 82.5)

    def test_each_card_explains_itself_with_its_own_modules_entries(self):
        data = self.overview()
        by_id = {k["id"]: k for k in data["kpis"]}
        self.assertEqual(by_id["attendance-today"]["provenanceIds"], ["attendance:live-today"])
        self.assertEqual(by_id["payroll-overtime"]["provenanceIds"], ["payroll:overtime"])
        self.assertEqual(
            by_id["visitors-today"]["provenanceIds"], ["visitors:visits"]
        )  # not mapped: all of the module's
        ids = {p["id"] for p in data["provenance"]}
        self.assertTrue({"dashboard-kpis", "dashboard-attention", "dashboard-briefing", "dashboard-units"} <= ids)
        self.assertIn("attendance:live-today", ids)
        for card in data["kpis"]:
            for pid in card["provenanceIds"]:
                self.assertIn(pid, ids)

    def test_every_page_answered(self):
        data = self.overview()
        self.assertEqual(set(data["sources"]), {s.module for s in D.SOURCES})
        self.assertTrue(all(s["ok"] and "error" not in s for s in data["sources"].values()))
        self.assertEqual(data["notes"], [])
        self.assertEqual(data["sources"]["payroll"]["title"], "Payroll Analysis")
        self.assertEqual(data["sources"]["tea_break"]["page"], "tea-break")

    def test_a_module_that_raises_costs_only_its_own_cards_and_exceptions(self):
        broken = stand_in()
        broken.headline = boom
        broken.insights = boom
        data, log = self.overview_failing(world(payroll=broken))
        self.assertNotIn("payroll-gross", [k["id"] for k in data["kpis"]])
        self.assertEqual(len(data["kpis"]), 8)  # a reserve took the place
        self.assertEqual([i["module"] for i in data["insights"]].count("payroll"), 0)
        self.assertEqual(data["sources"]["payroll"]["ok"], False)
        self.assertEqual(data["sources"]["payroll"]["error"], "Payroll Analysis could not be loaded just now.")
        self.assertTrue(all(s["ok"] for m, s in data["sources"].items() if m != "payroll"))
        self.assertEqual(data["notes"], ["Payroll Analysis could not be loaded, so what it adds is missing here."])
        self.assertNotIn("hunter2", json.dumps(data))  # the reason stays in the server log ...
        self.assertIn("hunter2", log)  # ... where the people who run the system can read it
        self.assertEqual(data["units"]["total"]["expected"], 1190)  # everything else is intact
        self.assertNotIn("payroll", [s["id"] for s in data["briefing"]["sentences"]])

    def test_a_module_that_cannot_even_be_imported_is_just_another_failure(self):
        loader = world()

        def without_tea(name):
            if name == "tea_break":
                raise ImportError("No module named api.md_portal.analytics.tea_break")
            return loader(name)

        data, _ = self.overview_failing(without_tea)
        self.assertFalse(data["sources"]["tea_break"]["ok"])
        self.assertTrue(data["sources"]["attendance"]["ok"])
        self.assertEqual(len(data["kpis"]), 8)

    def test_a_database_error_in_one_module_does_not_poison_the_others(self):
        def bad_sql(today=None):
            with connection.cursor() as cursor:
                cursor.execute("SELECT * FROM table_that_does_not_exist")

        broken = stand_in()
        broken.headline = bad_sql
        data, _ = self.overview_failing(world(employees=broken))
        # the modules that run AFTER the failure still answered with real queries inside the same transaction
        self.assertFalse(data["sources"]["employees"]["ok"])
        self.assertTrue(all(s["ok"] for m, s in data["sources"].items() if m != "employees"))
        self.assertIn("payroll-gross", [k["id"] for k in data["kpis"]])
        self.assertEqual(data["units"]["total"]["expected"], 1190)

    def test_a_slow_query_becomes_a_failure_instead_of_a_dashboard_that_never_opens(self):
        def slow(today=None):
            with connection.cursor() as cursor:
                cursor.execute("SELECT pg_sleep(2)")

        slowpoke = stand_in()
        slowpoke.headline = slow
        started = datetime.now()
        with mock.patch.object(D, "STATEMENT_TIMEOUT_MS", 150):
            data, _ = self.overview_failing(world(visitors=slowpoke))
        self.assertLess((datetime.now() - started).total_seconds(), 1.5)
        self.assertFalse(data["sources"]["visitors"]["ok"])
        self.assertTrue(data["sources"]["tea_break"]["ok"])

    def test_when_the_time_budget_is_spent_the_rest_are_skipped_not_waited_for(self):
        with mock.patch.object(D, "TOTAL_BUDGET_SECONDS", -1):
            data = self.overview()
        self.assertEqual((data["kpis"], data["insights"], data["insightsTotal"]), ([], [], 0))
        self.assertTrue(all(not s["ok"] and "ran out of time" in s["error"] for s in data["sources"].values()))
        self.assertEqual(data["units"], {"error": "Attendance Analytics was skipped: the Dashboard ran out of time."})
        self.assertEqual([s["id"] for s in data["briefing"]["sentences"]], ["exception"])
        self.assertEqual(data["briefing"]["sentences"][0]["text"], "The exception checks could not run just now.")
        self.assertEqual(len(data["notes"]), len(D.SOURCES))

    def test_the_extras_of_the_briefing_fail_alone_too(self):
        def no_trend(scope, period):
            raise RuntimeError("trend broke")

        attendance = world()("attendance")
        attendance.attendance_trend = no_trend
        data, _ = self.overview_failing(world(attendance=attendance))
        self.assertFalse(data["sources"]["attendance"]["ok"])
        self.assertEqual(
            data["briefing"]["sentences"][0]["text"], "Attendance is 90.3% so far today."
        )  # no 30-day comparison, nothing invented

    def test_units_failing_leaves_an_error_entry_and_the_rest(self):
        def no_live(scope, today):
            raise RuntimeError("live broke")

        attendance = world()("attendance")
        attendance.live_today = no_live
        data, _ = self.overview_failing(world(attendance=attendance))
        self.assertEqual(data["units"], {"error": "Attendance Analytics could not be loaded just now."})
        self.assertEqual(len(data["kpis"]), 8)

    def test_a_unit_scope_narrows_only_the_unit_count_and_says_so(self):
        seen = []
        attendance = world()("attendance")
        attendance.live_today = lambda scope, today: seen.append(scope) or LIVE
        unit = Branch.objects.create(name="Unit 1")
        data = self.overview(world(attendance=attendance), scope=C.resolve_scope({"branch": str(unit.id)}))
        self.assertEqual(seen[0].branch_ids, (unit.id,))
        self.assertEqual(data["scope"]["branchIds"], [unit.id])
        self.assertEqual(
            data["notes"],
            [
                "The cards, exceptions and briefing are for the whole company; today's count by unit is for Unit 1 · all departments · staff and production."
            ],
        )
        self.assertNotIn("weakest", [s["id"] for s in data["briefing"]["sentences"]])

    def test_before_the_morning_rush_is_over_the_briefing_does_not_compare_units(self):
        early = datetime.combine(TODAY, time(8, 30))
        with (
            mock.patch.object(D, "ist_now", return_value=early),
            mock.patch.object(D, "_analytics", side_effect=world()),
        ):
            data = D.overview()  # no pinned date: the clock decides
        self.assertFalse(data["settled"])
        ids = [s["id"] for s in data["briefing"]["sentences"]]
        self.assertNotIn("weakest", ids)
        self.assertTrue(data["briefing"]["sentences"][0]["text"].startswith("It is still early: 1,075 of 1,190"))
        late = datetime.combine(TODAY, time(11, 5))
        D._MEMO.clear()
        with (
            mock.patch.object(D, "ist_now", return_value=late),
            mock.patch.object(D, "_analytics", side_effect=world()),
        ):
            self.assertTrue(D.overview()["settled"])

    def test_the_answer_is_remembered_briefly_but_a_degraded_one_is_not(self):
        calls = []
        modules = world()
        attendance = modules("attendance")
        original = attendance.headline
        attendance.headline = lambda today=None: calls.append(1) or original(today)
        with override_settings(MD_ANALYTICS_CACHE_SECONDS=60), mock.patch.object(D, "_analytics", side_effect=modules):
            D.overview(today=TODAY)
            D.overview(today=TODAY)
            self.assertEqual(len(calls), 1)  # served from the short memory
            D._MEMO.clear()
            payroll = modules("payroll")
            good_headline = payroll.headline
            payroll.headline = boom
            with self.assertLogs(D.logger.name, level="ERROR"):
                degraded = D.overview(today=TODAY)
            self.assertFalse(degraded["sources"]["payroll"]["ok"])
            payroll.headline = good_headline  # the fault clears: Retry must see it at once
            healed = D.overview(today=TODAY)
            self.assertTrue(healed["sources"]["payroll"]["ok"])

    def test_the_cache_is_per_scope_and_per_pinned_date(self):
        calls = []
        modules = world()
        attendance = modules("attendance")
        original = attendance.headline
        attendance.headline = lambda today=None: calls.append(today) or original(today)
        with override_settings(MD_ANALYTICS_CACHE_SECONDS=60), mock.patch.object(D, "_analytics", side_effect=modules):
            D.overview(today=TODAY)
            D.overview(today=TODAY + timedelta(days=1))
            D.overview(today=TODAY, scope=Scope(branch_ids=(1,)))
        self.assertEqual(len(calls), 3)


class Attention(MdApiTestCase):
    def attention(self, **kw):
        with mock.patch.object(D, "_analytics", side_effect=world()):
            return D.attention(today=TODAY, **kw)

    def test_the_merged_list_without_the_rest_of_the_dashboard(self):
        data = self.attention()
        self.assertEqual(
            [i["id"] for i in data["items"]][:3],
            ["attendance.dept-spike", "employees.hotspot", "payroll.unpaid-2026-09"],
        )
        self.assertEqual(data["total"], 6)
        self.assertEqual(len(self.attention(limit=2)["items"]), 2)

    def test_one_page_can_be_asked_for(self):
        data = self.attention(page="payroll")
        self.assertEqual([i["id"] for i in data["items"]], ["payroll.unpaid-2026-09"])
        self.assertEqual(self.attention(page="visitors")["items"], [])

    def test_it_carries_provenance_and_the_failures(self):
        broken = stand_in()
        broken.insights = boom
        with (
            mock.patch.object(D, "_analytics", side_effect=world(activity=broken)),
            self.assertLogs(D.logger.name, "ERROR"),
        ):
            data = D.attention(today=TODAY)
        self.assertEqual([p["id"] for p in data["provenance"]], ["dashboard-attention"])
        self.assertEqual(data["notes"], ["Activity Logs could not be loaded, so what it adds is missing here."])


class TrendsComposition(MdApiTestCase):
    def setUp(self):
        super().setUp()
        D._MEMO.clear()

    def stand_ins(self, **overrides):
        calls = {}

        def attendance_trend(scope, period):
            calls["attendance"] = (scope, period)
            return {
                "generatedAt": "x",
                "scope": {"description": "inner"},
                "period": period.to_json(),
                "granularity": "day",
                "points": [{"date": "2026-10-02", "attendancePct": 91.0}],
                "average": {"attendancePct": 91.0},
                "provenance": [{"id": "attendance-pct"}],
                "notes": ["a note"],
            }

        def payroll_trend(scope, month, months):
            calls["payroll"] = (month, months)
            return {**PAYROLL_TREND, "generatedAt": "x", "provenance": [{"id": "gross-pay"}], "notes": []}

        def movement(scope, period, today=None):
            calls["movement"] = (period, today)
            return {"grain": "month", "points": [], "totals": {"joiners": 5}, "provenance": [], "notes": []}

        modules = {
            "attendance": SimpleNamespace(attendance_trend=attendance_trend),
            "payroll": SimpleNamespace(payroll_trend=payroll_trend),
            "employees": SimpleNamespace(movement=movement),
        }
        modules.update(overrides)

        def load(name):
            if name not in modules:
                raise ImportError(name)
            return modules[name]

        return load, calls

    def test_the_three_charts_are_the_modules_own_trends_for_the_documented_windows(self):
        load, calls = self.stand_ins()
        with mock.patch.object(D, "_analytics", side_effect=load):
            data = D.trends(today=TODAY)
        scope, period = calls["attendance"]
        self.assertEqual(
            (period.start.isoformat(), period.end.isoformat(), period.days), ("2026-09-06", "2026-10-05", 30)
        )
        self.assertEqual(calls["payroll"], (None, 12))  # the latest closed month, 12 months
        movement_period, movement_today = calls["movement"]
        self.assertEqual(
            (movement_period.start.isoformat(), movement_period.end.isoformat()), ("2025-11-01", "2026-10-05")
        )
        self.assertEqual(movement_today, TODAY)
        self.assertEqual(data["attendance"]["average"], {"attendancePct": 91.0})
        self.assertEqual(data["payroll"]["month"], "2026-09")
        self.assertEqual(data["movement"]["totals"], {"joiners": 5})
        self.assertNotIn("generatedAt", data["attendance"])  # the Dashboard's own clock is the one that counts
        self.assertEqual(data["attendance"]["notes"], ["a note"])
        self.assertEqual(data["attendance"]["provenance"], [{"id": "attendance-pct"}])
        self.assertEqual([p["id"] for p in data["provenance"]], ["dashboard-trends"])
        self.assertEqual(data["notes"], [])

    def test_a_chart_that_fails_is_an_error_entry_and_the_others_still_arrive(self):
        def broken(scope, month, months):
            raise RuntimeError("payroll broke")

        load, _ = self.stand_ins(payroll=SimpleNamespace(payroll_trend=broken))
        with mock.patch.object(D, "_analytics", side_effect=load), self.assertLogs(D.logger.name, "ERROR"):
            data = D.trends(today=TODAY)
        self.assertEqual(data["payroll"], {"error": "Payroll Analysis could not be loaded just now."})
        self.assertEqual(data["attendance"]["average"], {"attendancePct": 91.0})
        self.assertEqual(data["movement"]["totals"], {"joiners": 5})
        self.assertEqual(data["notes"], ["Payroll Analysis could not be loaded, so what it adds is missing here."])

    def test_the_scope_reaches_all_three(self):
        load, calls = self.stand_ins()
        scope = Scope(branch_ids=(7,), labels={"branch": "Unit 7"})
        with mock.patch.object(D, "_analytics", side_effect=load):
            data = D.trends(today=TODAY, scope=scope)
        self.assertEqual(calls["attendance"][0].branch_ids, (7,))
        self.assertEqual(data["scope"]["branchIds"], [7])


# ─── the real modules on a small company ────────────────────────────────────────────────────────────────────────────


def make_slip(emp, year, month, gross, ot=0, paid=False):
    gross, ot = Decimal(str(gross)), Decimal(str(ot))
    net = gross + ot
    SalarySlip.objects.create(
        employee=emp,
        month=month,
        year=year,
        slip_number=f"T/{emp.employee_code}/{year}{month:02d}",
        basic=gross / 2,
        hra=Decimal(0),
        allowances=Decimal(0),
        incentives=Decimal(0),
        bonuses=Decimal(0),
        ot_amount=ot,
        gross_salary=gross,
        pf_deduction=Decimal(0),
        esi_deduction=Decimal(0),
        advance_deduction=Decimal(0),
        other_deductions=Decimal(0),
        total_deductions=Decimal(0),
        net_salary=net,
        working_days=26,
        present_days=Decimal(26),
        absent_days=Decimal(0),
        breakdown_details={
            "type": "staff",
            "summary": {"totalWorkingDays": 26, "effectivePaidDays": 26.0},
            "earnings": {"monthlySalary": float(gross), "grossSalary": float(gross)},
            "deductions": {"pf": 0.0, "esi": 0.0, "advances": 0.0, "lateShiftPenalty": 0.0},
        },
    )
    Payroll.objects.create(
        employee=emp,
        salary_mode="monthly",
        month=month,
        year=year,
        base_salary=gross,
        gross_salary=gross,
        final_salary=net,
        status="paid" if paid else "pending",
    )


class Company(MdApiTestCase):
    """The small company in the module docstring."""

    @classmethod
    def setUpTestData(cls):
        cls.u1 = Branch.objects.create(name="Unit 1", code="U1")
        cls.u2 = Branch.objects.create(name="Unit 2", code="U2")
        cls.stitch1 = Department.objects.create(name="Stitching", branch=cls.u1)
        cls.cutting = Department.objects.create(name="Cutting", branch=cls.u1)
        cls.stitch2 = Department.objects.create(name="Stitching", branch=cls.u2)

        def person(code, dept, kind="production", joined="2025-01-01", status="active"):
            return Employee.objects.create(
                employee_code=code,
                first_name=code,
                last_name="Test",
                employment_type=kind,
                department=dept,
                branch=dept.branch,
                join_date=joined,
                status=status,
            )

        cls.s = [person(f"S{n}", cls.stitch1, "staff" if n <= 3 else "production") for n in range(1, 11)]
        cls.c = [person(f"C{n}", cls.cutting) for n in range(1, 4)] + [person("C4", cls.cutting, joined="2026-10-02")]
        cls.t = [person(f"T{n}", cls.stitch2) for n in range(1, 11)]
        cls.leaver = person("G", cls.stitch1, "staff", status="inactive")
        ResignationRequest.objects.create(employee=cls.leaver, status="approved", last_working_date=date(2026, 10, 1))
        everyone = [*cls.s, *cls.c, *cls.t]

        AttendanceLog.objects.bulk_create(
            AttendanceLog(employee=e, date=TODAY, punch_time=time(9, 0), punch_type="IN", source="biometric")
            for e in [*cls.s[:7], *cls.c, *cls.t]
        )
        AttendanceDayRecord.objects.bulk_create(
            AttendanceDayRecord(employee=e, date=date(2026, 9, 28), status="present" if n < 20 else "absent")
            for n, e in enumerate(everyone)
        )
        for ym, amounts in (((2026, 8), (20000, 20000, 20000)), ((2026, 9), (20000, 20000, 22000))):
            for n, (emp, gross) in enumerate(zip(cls.s[:3], amounts)):
                make_slip(emp, *ym, gross, ot=3000 if (ym == (2026, 9) and n == 0) else 0)


class TheRealModules(Company):
    def setUp(self):
        super().setUp()
        D._MEMO.clear()

    def overview(self, **kw):
        with at():
            return D.overview(today=TODAY, **kw)

    def test_today_by_unit_matches_the_hand_count(self):
        units = self.overview()["units"]
        self.assertTrue(units["isWorkingDay"])
        self.assertEqual(
            [
                (r["name"], r["expected"], r["present"], r["absent"], r["leave"], r["attendancePct"])
                for r in units["rows"]
            ],
            [("Unit 1", 14, 11, 3, 0, 78.6), ("Unit 2", 10, 10, 0, 0, 100.0)],
        )
        self.assertEqual(
            units["total"],
            {"expected": 24, "present": 21, "late": None, "leave": 0, "absent": 3, "attendancePct": 87.5},
        )
        self.assertEqual(
            units["weakestDepartment"],
            {"name": "Stitching", "expected": 20, "present": 17, "absent": 3, "attendancePct": 85.0},
        )
        self.assertFalse(units["lateKnown"])  # no day record for today yet: late arrivals are not known

    def test_late_arrivals_appear_once_enough_day_records_for_today_exist(self):
        def record(emp, late):
            AttendanceDayRecord.objects.create(employee=emp, date=TODAY, status="present", is_late=late)

        for e in self.s[:7] + self.c + self.t:
            record(e, late=e.employee_code in ("S1", "S2", "T1"))
        units = self.overview()["units"]
        self.assertTrue(units["lateKnown"])
        self.assertEqual({r["name"]: r["late"] for r in units["rows"]}, {"Unit 1": 2, "Unit 2": 1})
        self.assertEqual(units["total"]["late"], 3)

    def test_a_few_day_records_are_not_enough_to_call_late_arrivals_known(self):
        AttendanceDayRecord.objects.create(employee=self.s[0], date=TODAY, status="present", is_late=True)
        units = self.overview()["units"]
        self.assertFalse(units["lateKnown"])
        self.assertTrue(all(r["late"] is None for r in units["rows"]))

    def test_the_cards_are_the_modules_own_cards(self):
        data = self.overview()
        shown = {k["id"]: k for k in data["kpis"]}
        with at():
            own = {}
            for module in ("attendance", "employees", "payroll", "recruitment", "visitors"):
                for card in D._analytics(module).headline(today=TODAY)["kpis"]:
                    own[card["id"]] = card
        for card_id, card in shown.items():
            self.assertEqual(card["value"], own[card_id]["value"], card_id)
            self.assertEqual(card["label"], own[card_id]["label"], card_id)
            self.assertEqual(card["delta"], own[card_id]["delta"], card_id)
        self.assertEqual(shown["employees.headcount"]["value"], 24)
        self.assertEqual(shown["attendance-today"]["value"], 87.5)
        self.assertEqual(shown["payroll-gross"]["value"], 65000.0)
        self.assertEqual(shown["payroll-gross"]["display"], "₹65,000")
        self.assertEqual(shown["payroll-overtime"]["value"], 3000.0)
        self.assertEqual(shown["payroll-gross"]["delta"], {"abs": 5000.0, "pct": 8.3, "good": "down"})
        self.assertEqual(len(data["kpis"]), 8)
        self.assertTrue(all(s["ok"] for s in data["sources"].values()), data["sources"])

    def test_the_briefing_is_written_from_those_numbers(self):
        sentences = {s["id"]: s["text"] for s in self.overview()["briefing"]["sentences"]}
        self.assertEqual(
            sentences["attendance"], "Attendance is 87.5% so far today, 4.2 points above the 30-day average of 83.3%."
        )
        self.assertEqual(
            sentences["weakest"],
            "Unit 1 is the weakest unit so far today, at 78.6% (11 of 14 in), and Stitching the weakest department, at 85%.",
        )
        self.assertEqual(sentences["payroll"], "Payroll for Sep 2026 came to ₹65,000, 8.3% more than Aug 2026.")
        self.assertTrue(
            sentences["hiring"].startswith("This month 1 person joined and 1 left (no net change);"),
            sentences["hiring"],
        )
        self.assertIn("exception", sentences)

    def test_the_trends_are_the_modules_own(self):
        with at():
            data = D.trends(today=TODAY)
            own_attendance = A.attendance_trend(
                Scope(), C.Period(TODAY - timedelta(days=29), TODAY, "last_30_days", "Last 30 days")
            )
            own_payroll = P.payroll_trend(Scope(), None, 12)
        self.assertEqual(data["attendance"]["average"], own_attendance["average"])
        self.assertEqual(data["attendance"]["average"]["attendancePct"], 83.3)
        self.assertEqual(data["attendance"]["points"], own_attendance["points"])
        self.assertEqual(len(data["payroll"]["months"]), 12)
        self.assertEqual(data["payroll"]["months"], own_payroll["months"])
        last, before = data["payroll"]["months"][-1], data["payroll"]["months"][-2]
        self.assertEqual((last["month"], last["grossPay"], last["headcount"]), ("2026-09", 65000.0, 3))
        self.assertEqual((before["month"], before["grossPay"]), ("2026-08", 60000.0))
        movement = data["movement"]
        self.assertEqual(movement["grain"], "month")
        self.assertEqual(movement["totals"]["joiners"], 1)
        self.assertEqual(movement["totals"]["leavers"], 1)
        self.assertEqual(movement["points"][-1]["label"], "Oct 2026")
        self.assertEqual(movement["points"][-1]["headcount"], 24)
        self.assertEqual(len(movement["points"]), 12)

    def test_a_unit_scope_reaches_the_trends_and_the_unit_count(self):
        scope = C.resolve_scope({"branch": "unit 2"})  # a different case still finds it
        with at():
            trend = D.trends(today=TODAY, scope=scope)
            data = D.overview(today=TODAY, scope=scope)
        self.assertEqual(trend["scope"]["description"], "Unit 2 · all departments · staff and production")
        self.assertEqual(trend["movement"]["points"][-1]["headcount"], 10)
        self.assertEqual([r["name"] for r in data["units"]["rows"]], ["Unit 2"])
        self.assertEqual(data["units"]["total"]["expected"], 10)
        self.assertEqual(data["kpis"][0]["value"], 24)  # the cards stay company-wide, and the note says so
        self.assertTrue(any("whole company" in n for n in data["notes"]))

    def test_the_cost_does_not_grow_with_the_number_of_people(self):
        def queries():
            D._MEMO.clear()
            with at(), CaptureQueriesContext(connection) as ctx:
                D.overview(today=TODAY)
                D.trends(today=TODAY)
            return len(ctx)

        small = queries()
        more = []
        for n in range(60):
            dept = self.stitch2 if n % 2 else self.cutting
            more.append(
                Employee(
                    employee_code=f"X{n}",
                    first_name="X",
                    last_name=str(n),
                    employment_type="production",
                    department=dept,
                    branch=dept.branch,
                    join_date="2025-01-01",
                    status="active",
                )
            )
        Employee.objects.bulk_create(more)
        AttendanceLog.objects.bulk_create(
            AttendanceLog(employee=e, date=TODAY, punch_time=time(9, 5), punch_type="IN", source="biometric")
            for e in Employee.objects.filter(employee_code__startswith="X")[:40]
        )
        self.assertEqual(queries(), small)


class TheAssistantsLookup(Company):
    """What "Brief me" costs the assistant: one lookup, and a result small enough to be cheap on a free quota."""

    def run_tool(self, name):
        D._MEMO.clear()
        registry.clear_cache()
        with at(), read_only_db():
            return registry.all_tools()[name].run({})

    def test_the_briefing_lookup_is_one_small_answer_with_everything_needed(self):
        result = self.run_tool("company_briefing")
        size = len(json.dumps(result))
        self.assertLess(size, 20_000, f"{size} characters is too much to spend on one question")
        self.assertEqual(len(result["kpis"]), 8)
        self.assertGreaterEqual(len(result["briefing"]["sentences"]), 4)
        by_id = {k["id"]: k for k in result["kpis"]}
        self.assertEqual(by_id["employees.headcount"]["display"], "24")
        self.assertEqual(by_id["payroll-gross"]["display"], "₹65,000")
        self.assertEqual(
            (by_id["payroll-gross"]["change"], by_id["payroll-gross"]["changeIs"]), ("+8.3%", "worse")
        )  # cost up is bad news, as the card colours it
        self.assertTrue(all("spark" not in k for k in result["kpis"]))
        self.assertTrue(result["provenance"])

    def test_the_overview_and_attention_lookups_are_small_too(self):
        for name in ("company_overview", "needs_attention"):
            self.assertLess(len(json.dumps(self.run_tool(name))), 20_000, name)


class TheEmptyCompany(MdApiTestCase):
    def setUp(self):
        super().setUp()
        D._MEMO.clear()

    def test_nothing_is_invented_and_nothing_divides_by_zero(self):
        with at():
            data = D.overview(today=TODAY)
            trend = D.trends(today=TODAY)
        self.assertTrue(all(s["ok"] for s in data["sources"].values()), data["sources"])
        values = {k["id"]: k["value"] for k in data["kpis"]}
        self.assertEqual(values["employees.headcount"], 0)
        self.assertIsNone(values.get("attendance-today"))  # nobody scheduled: no reading, not "0%"
        self.assertIsNone(values["payroll-gross"])
        self.assertEqual(data["insights"][0]["module"], "activity")  # silence in the audit trail is itself reported
        self.assertEqual(data["units"]["rows"], [])
        self.assertFalse(data["units"]["isWorkingDay"])
        self.assertIsNone(data["units"]["total"]["attendancePct"])
        self.assertTrue(data["briefing"]["sentences"])
        self.assertNotIn("0.0%", data["briefing"]["text"])
        self.assertEqual(trend["attendance"]["points"], [])
        self.assertFalse(trend["payroll"]["hasData"])
        self.assertEqual(trend["movement"]["totals"]["joiners"], 0)
        json.dumps(data)
        json.dumps(trend)


# ─── the REST routes and the assistant's tools ──────────────────────────────────────────────────────────────────────


class Routes(MdApiTestCase):
    def setUp(self):
        super().setUp()
        D._MEMO.clear()

    def test_the_three_routes_answer_the_md(self):
        for route in ("overview", "trends", "briefing"):
            r = self.get(BASE + route)
            self.assertEqual(r.status_code, 200, (route, r.content))
            body = r.json()
            self.assertIn("generatedAt", body)
            self.assertIn("tookMs", body)
            self.assertTrue(body["provenance"])
        overview = self.get(BASE + "overview").json()
        self.assertEqual(set(overview), {
            "generatedAt", "today", "settled", "kpis", "insights", "insightsTotal", "briefing", "units", "sources",
            "scope", "provenance", "notes", "tookMs",
        })  # fmt: skip

    def test_nobody_else_gets_in(self):
        other = HRUser.objects.create(username="clerk", password_hash="x", full_name="Clerk")
        admin = HRUser.objects.create(username="root", password_hash="x", is_super_admin=True)
        for route in ("overview", "trends", "briefing"):
            for who in (other, admin):
                r = self.client.get(BASE + route, **md_headers(who))
                self.assertEqual(r.status_code, 403, (route, who.username))
            self.assertEqual(self.client.get(BASE + route).status_code, 401, route)

    def test_only_get_is_allowed(self):
        self.assertEqual(self.client.post(BASE + "overview", **md_headers(self.md)).status_code, 405)

    def test_an_unknown_unit_is_a_readable_400(self):
        for route in ("overview", "trends", "briefing"):
            r = self.get(BASE + route, branch="Atlantis")
            self.assertEqual(r.status_code, 400, route)
            self.assertIn("No unit called 'Atlantis'", r.json()["error"])

    def test_a_unit_can_be_named_even_with_a_typo(self):
        Branch.objects.create(name="Unit 1")
        r = self.get(BASE + "overview", branch="unit1")
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(r.json()["scope"]["description"].split(" · ")[0], "Unit 1")
        self.assertTrue(any("Matched unit" in n for n in r.json()["notes"]))

    def test_the_briefing_route_takes_a_limit(self):
        with mock.patch.object(D, "_analytics", side_effect=world()):
            body = self.get(BASE + "briefing", limit=2).json()
            self.assertEqual(len(body["needsAttention"]), 2)
            self.assertEqual(body["needsAttentionTotal"], 6)
            self.assertEqual(len(self.get(BASE + "briefing").json()["needsAttention"]), 5)
            self.assertEqual(len(self.get(BASE + "briefing", limit=500).json()["needsAttention"]), 6)
            self.assertEqual(self.get(BASE + "briefing", limit="many").status_code, 400)

    def test_the_briefing_answer_is_enough_for_one_lookup(self):
        with mock.patch.object(D, "_analytics", side_effect=world()):
            body = self.get(BASE + "briefing").json()
        self.assertEqual(len(body["briefing"]["sentences"]), 6)
        self.assertEqual(len(body["kpis"]), 8)
        first = body["kpis"][0]
        self.assertEqual(set(first), {"id", "label", "value", "display", "sub", "change", "changeIs", "page"})
        absent = next(k for k in body["kpis"] if k["id"] == "absenteeism-30d")
        self.assertEqual((absent["display"], absent["change"], absent["changeIs"]), ("4.2%", "+0.4 points", "worse"))


class Tools(MdApiTestCase):
    NAMES = ("company_briefing", "company_overview", "needs_attention")

    def setUp(self):
        super().setUp()
        D._MEMO.clear()
        registry.clear_cache()

    def run_tool(self, name, **args):
        with mock.patch.object(D, "_analytics", side_effect=world()), read_only_db():
            return registry.all_tools()[name].run(args)

    def test_the_three_tools_are_registered_on_the_dashboard_page(self):
        tools = registry.all_tools()
        for name in self.NAMES:
            self.assertEqual(tools[name].page, "dashboard")
            self.assertFalse(tools[name].uses_scope)  # the Dashboard is company-wide: no unit parameter to ignore
            self.assertIsNone(tools[name].default_period)
            self.assertGreaterEqual(len(tools[name].description), 200)
            self.assertTrue(tools[name].properties, "Gemini rejects a tool with no parameters at all")
            json.dumps(tools[name].declaration())

    def test_the_briefing_tool_costs_one_lookup(self):
        result = self.run_tool("company_briefing")
        self.assertEqual(len(result["briefing"]["sentences"]), 6)
        self.assertEqual(len(result["needsAttention"]), 5)
        self.assertEqual(len(result["kpis"]), 8)
        self.assertTrue(result["provenance"])
        json.dumps(result)
        self.assertEqual(len(self.run_tool("company_briefing", limit=1)["needsAttention"]), 1)

    def test_the_overview_tool_gives_the_page_as_data_without_charts_data(self):
        result = self.run_tool("company_overview", limit=3)
        self.assertEqual(len(result["needsAttention"]), 3)
        self.assertEqual(result["unitsToday"]["total"]["expected"], 1190)
        self.assertNotIn("weakestDepartment", result["unitsToday"])
        self.assertTrue(all("spark" not in k for k in result["kpis"]))
        self.assertEqual({s["ok"] for s in result["sources"].values()}, {True})

    def test_the_attention_tool_can_keep_one_page(self):
        everything = self.run_tool("needs_attention")
        self.assertEqual(everything["total"], 6)
        payroll = self.run_tool("needs_attention", page="payroll")
        self.assertEqual([i["module"] for i in payroll["items"]], ["payroll"])
        with self.assertRaises(MdParamError):
            self.run_tool("needs_attention", page="the-moon")

    def test_a_tool_result_is_a_private_copy(self):
        """The assistant's privacy layer rewrites names inside a result in place: that must never reach the page's data
        (the composed answer is kept for a few seconds and shared by the page and the assistant)."""
        with override_settings(MD_ANALYTICS_CACHE_SECONDS=60):
            for name in ("company_briefing", "company_overview", "needs_attention"):
                D._MEMO.clear()
                first = self.run_tool(name)
                json_before = json.dumps(self.run_tool(name), sort_keys=True)
                text = json.dumps(first)
                self.assertIn("Stitching", text)
                for row in first.get("needsAttention", first.get("items", [])):
                    row["title"] = "@emp-2"
                for line in first.get("briefing", {}).get("sentences", []):
                    line["text"] = "@emp-1 was here"
                for card in first.get("kpis", []):
                    card["label"] = "@emp-3"
                self.assertEqual(json.dumps(self.run_tool(name), sort_keys=True), json_before, name)
                D._MEMO.clear()

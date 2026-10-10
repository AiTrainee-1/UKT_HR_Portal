"""MD portal: Outpass & Visitors (md_portal/analytics/visitors.py, routes/visitors.py).

One small fixture, built so every figure below can be recomputed by hand. The factory clock is pinned to
Mon 2026-10-05 12:00 IST; the period under test is Mon 21 Sep - Sun 4 Oct 2026 (14 days) and the previous period
is 7 - 20 Sep. All times are IST.

People (department, unit, type):  E1 Asha (Stitching, Unit 1, production)   E2 Bala (Stitching, Unit 1, production)
  E3 Chitra (Cutting, Unit 1, production)   E4 Dev (Accounts, Unit 2, staff)   E5 Esha (Stitching, Unit 2, production)
  E6 Farid (no department, Unit 1, staff).  Active headcount: Stitching 3, Cutting 1, Accounts 1, none 1.

Outpass requests (manual unless noted), created -> outcome, minutes out (exit to return scan):
  P1  E1 personal  22 Sep 10:00  returned      30        P2  E1 personal  24 Sep 11:00  returned      60
  P3  E1 official  25 Sep 09:00  returned     150        P4  E1 personal  28 Sep 15:00  returned      30
  P5  E2 personal  23 Sep 10:00  returned      10        P6  E2 early dismissal 26 Sep 16:00  left, not expected back
  P7  E3 personal  29 Sep 13:00  left, NEVER returned    P8  E3 official  1 Oct 09:30  returned      15
  P9  E4 personal  2 Oct 10:00   rejected               P10 E4 personal  3 Oct 14:00  PENDING (46 h at "now")
  P11 E5 (no type) 30 Sep 11:00  returned      30        P12 E5 personal  4 Oct 08:00  approved, never used
  P13 E1 ON-DUTY   27 Sep 10:00  returned     235 (official trip: left out of the figures, counted separately)
  P14 E6 personal  5 Oct 08:00   left today, outside now    P15 E2 personal  5 Oct 09:00  pending (3 h)
  P16 E3 personal  30 Aug 10:00  pending since August (36 days)
  Previous period: Q1 E1 60 min, Q2 E2 30, Q3 E3 rejected, Q4 E4 90, Q5 E5 official 120 (all approved after 10 min).

Visits: V1 Ravi (4 visits to E1 in the period: 22 Sep 10:15 and 14:30, 29 Sep, 2 Oct; sales), V2 Meena (courier,
  "Stores", 23 and 30 Sep), V3 Inspector Raj (labour inspection, E4: 24 Sep, 1 Oct), V4 late guest (25 Sep 19:30, E2),
  V5 early bird (26 Sep 06:45, free-text host), V6 walk-in (28 Sep, E5, family). Previous period: 4 visits by 4 people.
  Today (5 Oct): V7 and V4.  Gate-form exits: F1 (E1, Unit 1, 22 Sep), F2 (nobody, Unit 2, 30 Sep); F0 before.
Gate scans in the period: 3 successful (2 exits, 1 return), 3 refused (expired, not approved, invalid QR).
"""

import json
import time as clock
from datetime import date, datetime, timedelta
from types import SimpleNamespace
from unittest import mock

from django.db import connection
from django.test import SimpleTestCase
from django.test.utils import CaptureQueriesContext

from .clock import FACTORY_TZ
from .md_portal import common
from .md_portal.analytics import tea_break as tea
from .md_portal.analytics import visitors as A
from .md_portal.assistant import registry
from .md_portal.common import MdParamError, Period, Scope, read_only_db
from .reporting import registry as report_registry
from .reporting.runner import run_report
from .models import (
    Branch,
    Department,
    Employee,
    GateDevice,
    HRUser,
    OutpassGateScan,
    OutpassRecord,
    OutpassRequest,
    Role,
    TeaBreakLog,
    TeaBreakRule,
    Visitor,
    VisitorVisit,
)
from .reporting.definitions import gate_visitor_tea_common as TC
from .tests_md_support import MdApiTestCase, md_headers

NOW = datetime(2026, 10, 5, 12, 0, tzinfo=FACTORY_TZ)
TODAY = date(2026, 10, 5)
PERIOD = {"from": "2026-09-21", "to": "2026-10-04"}
BASE = "/api/md/visitors/"
#: The findings about the people who come IN; every other finding is about outpasses (the MD's two pages).
VISITOR_FINDINGS = {"visitors.after-hours": "visitors", "visitors.frequent-visitors": "visitors"}


def ist(month: int, day: int, hour: int = 0, minute: int = 0, year: int = 2026) -> datetime:
    return datetime(year, month, day, hour, minute, tzinfo=FACTORY_TZ)


def make_employee(code, first, last, dept, branch, kind="production", **kw):
    return Employee.objects.create(
        employee_code=code, first_name=first, last_name=last, department=dept, branch=branch, employment_type=kind, **kw
    )


def make_pass(
    emp,
    created,
    *,
    status="approved",
    source="manual",
    pass_type="personal",
    approved_after=timedelta(minutes=10),
    exited=None,
    entered=None,
    destination="Bank",
    reason="Personal work",
):
    approved_at = created + approved_after if status == "approved" and approved_after is not None else None
    req = OutpassRequest.objects.create(
        employee=emp,
        destination=destination,
        reason=reason,
        status=status,
        source=source,
        pass_type=pass_type,
        approved_at=approved_at,
        exited_at=exited,
        entered_at=entered,
    )
    OutpassRequest.objects.filter(pk=req.pk).update(created_at=created)  # created_at is auto_now_add
    return req


def make_visit(visitor, at, *, host=None, whom=None, purpose="Meeting", branch=None):
    whom = whom or (f"{host.first_name} {host.last_name}" if host else "Reception")
    visit = VisitorVisit.objects.create(
        visitor=visitor, branch=branch, whom_to_meet=whom, purpose=purpose, meeting_employee=host
    )
    VisitorVisit.objects.filter(pk=visit.pk).update(visited_at=at)  # visited_at is auto_now_add
    return visit


def make_form(at, *, emp=None, name="Someone", code="X1", destination="Home", branch=None, source="qr"):
    rec = OutpassRecord.objects.create(
        branch=branch, employee=emp, employee_name=name, employee_code=code, destination=destination, source=source
    )
    OutpassRecord.objects.filter(pk=rec.pk).update(submitted_at=at)
    return rec


def make_scan(gate, at, *, emp=None, req=None, scan_type="exit", result="success"):
    scan = OutpassGateScan.objects.create(
        gate=gate, outpass_request=req, employee=emp, scan_type=scan_type, result=result, message=result
    )
    OutpassGateScan.objects.filter(pk=scan.pk).update(scanned_at=at)
    return scan


class GateData(MdApiTestCase):
    """The fixture described in the module docstring, built once per test class."""

    @classmethod
    def setUpTestData(cls):
        cls.u1 = Branch.objects.create(name="Unit 1", code="TU1")
        cls.u2 = Branch.objects.create(name="Unit 2", code="TU2")
        stitch1 = Department.objects.create(name="Stitching", branch=cls.u1)
        stitch2 = Department.objects.create(name="Stitching", branch=cls.u2)
        cutting = Department.objects.create(name="Cutting", branch=cls.u1)
        accounts = Department.objects.create(name="Accounts", branch=cls.u2)
        cls.e1 = make_employee("A1", "Asha", "Rao", stitch1, cls.u1)
        cls.e2 = make_employee("B2", "Bala", "Kumar", stitch1, cls.u1)
        cls.e3 = make_employee("C3", "Chitra", "Devi", cutting, cls.u1)
        cls.e4 = make_employee("D4", "Dev", "Anand", accounts, cls.u2, kind="staff")
        cls.e5 = make_employee("E5", "Esha", "Gupta", stitch2, cls.u2)
        cls.e6 = make_employee("F6", "Farid", "Khan", None, cls.u1, kind="staff")
        cls.left = make_employee("L7", "Gone", "Person", stitch1, cls.u1, status="inactive")

        ex = lambda d, h, m, mins: (ist(*d, h, m), ist(*d, h, m) + timedelta(minutes=mins))  # noqa: E731
        # ── the period: 21 Sep - 4 Oct ──
        e, r = ex((9, 22), 10, 10, 30)
        make_pass(cls.e1, ist(9, 22, 10), approved_after=timedelta(minutes=5), exited=e, entered=r)  # P1
        e, r = ex((9, 24), 11, 30, 60)
        make_pass(cls.e1, ist(9, 24, 11), approved_after=timedelta(minutes=20), exited=e, entered=r)  # P2
        e, r = ex((9, 25), 9, 10, 150)
        make_pass(
            cls.e1, ist(9, 25, 9), pass_type="official", approved_after=timedelta(minutes=2), exited=e, entered=r
        )  # P3
        e, r = ex((9, 28), 15, 15, 30)
        make_pass(cls.e1, ist(9, 28, 15), exited=e, entered=r)  # P4
        e, r = ex((9, 23), 10, 15, 10)
        make_pass(cls.e2, ist(9, 23, 10), exited=e, entered=r)  # P5
        make_pass(
            cls.e2,
            ist(9, 26, 16),
            pass_type="early_dismissal",
            approved_after=timedelta(minutes=5),
            exited=ist(9, 26, 16, 10),
        )  # P6
        make_pass(
            cls.e3, ist(9, 29, 13), approved_after=timedelta(minutes=30), exited=ist(9, 29, 13, 35), destination="Home"
        )  # P7
        e, r = ex((10, 1), 9, 40, 15)
        make_pass(
            cls.e3, ist(10, 1, 9, 30), pass_type="official", approved_after=timedelta(minutes=3), exited=e, entered=r
        )  # P8
        make_pass(cls.e4, ist(10, 2, 10), status="rejected")  # P9
        make_pass(cls.e4, ist(10, 3, 14), status="pending")  # P10
        e, r = ex((9, 30), 12, 5, 30)
        make_pass(
            cls.e5, ist(9, 30, 11), pass_type=None, approved_after=timedelta(minutes=60), exited=e, entered=r
        )  # P11
        make_pass(cls.e5, ist(10, 4, 8), approved_after=timedelta(minutes=15))  # P12: approved, never used
        e, r = ex((9, 27), 10, 5, 235)
        make_pass(
            cls.e1,
            ist(9, 27, 10),
            source="on_duty",
            pass_type=None,
            approved_after=timedelta(0),
            exited=e,
            entered=r,
        )  # P13
        # ── today ──
        make_pass(cls.e6, ist(10, 5, 8), approved_after=timedelta(minutes=5), exited=ist(10, 5, 8, 30))  # P14
        make_pass(cls.e2, ist(10, 5, 9), status="pending")  # P15
        make_pass(cls.e3, ist(8, 30, 10), status="pending")  # P16
        # ── previous period: 7 - 20 Sep ──
        for emp, day, mins, kind in (
            (cls.e1, 10, 60, "personal"),
            (cls.e2, 12, 30, "personal"),
            (cls.e4, 16, 90, "personal"),
            (cls.e5, 18, 120, "official"),
        ):
            e, r = ex((9, day), 10, 15, mins)
            make_pass(emp, ist(9, day, 10), pass_type=kind, exited=e, entered=r)
        make_pass(cls.e3, ist(9, 15, 10), status="rejected")

        # ── visitors ──
        v = {
            n: Visitor.objects.create(name=name, phone=str(9000000000 + i))
            for i, (n, name) in enumerate(
                [
                    (1, "Ravi Supplier"),
                    (2, "Meena Courier"),
                    (3, "Inspector Raj"),
                    (4, "Late Guest"),
                    (5, "Early Bird"),
                    (6, "Walk In"),
                    (7, "New Face"),
                ]
            )
        }
        cls.v = v
        make_visit(v[1], ist(9, 22, 10, 15), host=cls.e1, purpose="Fabric sales presentation", branch=cls.u1)
        make_visit(v[1], ist(9, 22, 14, 30), host=cls.e1, purpose="Fabric sales follow up", branch=cls.u1)
        make_visit(v[1], ist(9, 29, 10, 45), host=cls.e1, purpose="sales quotation", branch=cls.u1)
        make_visit(v[2], ist(9, 23, 11, 5), whom="Stores", purpose="Courier delivery", branch=cls.u1)
        make_visit(v[2], ist(9, 30, 11, 20), whom="Stores", purpose="Courier delivery", branch=cls.u1)
        make_visit(v[3], ist(9, 24, 9, 30), host=cls.e4, purpose="Labour department inspection", branch=cls.u2)
        make_visit(v[4], ist(9, 25, 19, 30), host=cls.e2, purpose="Meeting", branch=cls.u1)
        make_visit(v[5], ist(9, 26, 6, 45), whom="Mr Kumar", purpose="Interview", branch=cls.u1)
        make_visit(v[6], ist(9, 28, 15), host=cls.e5, purpose="Personal visit family", branch=cls.u2)
        make_visit(v[3], ist(10, 1, 9, 45), host=cls.e4, purpose="Audit follow up", branch=cls.u2)
        make_visit(v[1], ist(10, 2, 11), host=cls.e1, purpose="Sales demo", branch=cls.u1)
        # previous period
        make_visit(v[1], ist(9, 8, 10), host=cls.e1, purpose="Sales demo", branch=cls.u1)
        make_visit(v[2], ist(9, 10, 11), whom="Stores", purpose="Courier delivery", branch=cls.u1)
        make_visit(v[3], ist(9, 15, 9, 30), host=cls.e4, purpose="Audit", branch=cls.u2)
        make_visit(v[7], ist(9, 18, 10), whom="Mr Kumar", purpose="Courier", branch=cls.u1)
        # today
        make_visit(v[7], ist(10, 5, 9), whom="Mr Kumar", purpose="Courier", branch=cls.u1)
        make_visit(v[4], ist(10, 5, 10, 30), host=cls.e2, purpose="Meeting", branch=cls.u1)

        # ── gate-form exits and scans ──
        make_form(ist(9, 22, 12), emp=cls.e1, name="Asha Rao", code="A1", branch=cls.u1)  # F1
        make_form(ist(9, 30, 13), emp=None, name="Unknown", code="X99", branch=cls.u2)  # F2
        make_form(ist(9, 10, 12), emp=cls.e2, name="Bala Kumar", code="B2", branch=cls.u1)  # F0 (previous period)
        make_form(ist(9, 22, 12), emp=cls.e1, name="Asha Rao", code="A1", branch=cls.u1, source="request")  # a copy
        g1 = GateDevice.objects.create(name="Gate 1", branch=cls.u1, username="g1", password_hash="x", login_token="t1")
        g2 = GateDevice.objects.create(name="Gate 2", branch=cls.u2, username="g2", password_hash="x", login_token="t2")
        make_scan(g1, ist(9, 22, 10, 10), emp=cls.e1)
        make_scan(g1, ist(9, 22, 10, 40), emp=cls.e1, scan_type="entry")
        make_scan(g1, ist(9, 24, 11, 30), emp=cls.e1)
        make_scan(g1, ist(9, 29, 14), emp=cls.e3, result="expired")
        make_scan(g2, ist(10, 3, 14, 30), emp=cls.e4, result="not_approved")
        make_scan(g2, ist(10, 3, 15), emp=None, result="invalid_qr")

    def setUp(self):
        super().setUp()
        for target, value in (
            ("api.md_portal.analytics.visitors._now", NOW),
            ("api.md_portal.common.ist_today", TODAY),
        ):
            patcher = mock.patch(target, return_value=value)
            patcher.start()
            self.addCleanup(patcher.stop)

    def json(self, endpoint: str, **params):
        r = self.get(BASE + endpoint, **{**PERIOD, **params})
        self.assertEqual(r.status_code, 200, r.content)
        return r.json()


# ─── pure rules ───────────────────────────────────────────────────────────────────────────────────────────────────


class RuleTests(SimpleTestCase):
    def test_purpose_categories(self):
        cases = {
            "Interview for stitching job": "interview",
            "Courier delivery": "delivery",
            "Labour department inspection": "audit",
            "PF office officer": "audit",
            "Buyer visit - sample approval": "buyer",
            "Fabric sales presentation": "supplier",
            "Machine service": "service",
            "Payment of bill": "payment",
            "Family emergency": "personal",
            "Meeting with HR": "meeting",
            "": "other",
            "xyz": "other",
            None: "other",
        }
        for text, key in cases.items():
            self.assertEqual(A.classify_purpose(text)[0], key, text)

    def test_the_first_matching_category_wins_and_short_words_need_a_whole_word(self):
        self.assertEqual(A.classify_purpose("Buyer meeting")[0], "buyer")  # buyer is checked before meeting
        self.assertEqual(A.classify_purpose("vendor payment")[0], "supplier")
        self.assertEqual(A.classify_purpose("taxi driver")[0], "delivery")  # "tax" must not match "taxi"
        self.assertEqual(A.classify_purpose("GST office")[0], "audit")
        self.assertEqual(A.classify_purpose("Jobs enquiry")[0], "interview")  # plural of a short word

    def test_the_threshold_scales_with_the_period(self):
        base = A.REPEAT_OUTPASS_PER_30_DAYS
        self.assertEqual(A.scaled_threshold(base, 1), 3)  # never easier than the rule
        self.assertEqual(A.scaled_threshold(base, 7), 3)
        self.assertEqual(A.scaled_threshold(base, 30), 3)
        self.assertEqual(A.scaled_threshold(base, 31), 3)
        self.assertEqual(A.scaled_threshold(base, 45), 5)  # 4.5 rounds up
        self.assertEqual(A.scaled_threshold(base, 90), 9)

    def test_the_period_reads_inside_a_sentence(self):
        today = TODAY
        pick = lambda preset: A._when(common.period_for_preset(preset, today))  # noqa: E731
        self.assertEqual(pick("last_30_days"), "in the last 30 days")
        self.assertEqual(pick("this_month"), "this month")
        self.assertEqual(pick("yesterday"), "yesterday")
        custom = Period(date(2026, 9, 1), date(2026, 9, 15), "custom", "01 Sep – 15 Sep 2026")
        self.assertEqual(A._when(custom), "between 01 Sep – 15 Sep 2026")
        self.assertEqual(A._when(Period(date(2026, 9, 1), date(2026, 9, 1), "custom", "01 Sep 2026")), "on 01 Sep 2026")

    def test_a_visitor_spike_needs_a_day_far_above_a_typical_one(self):
        d = lambda n: date(2026, 9, n)  # noqa: E731
        calm = {d(i): 3 for i in range(1, 8)}
        self.assertIsNone(A._visitor_spike(calm))
        busy = {**calm, d(9): 9}  # three times typical but under the floor of 10 visits
        self.assertIsNone(A._visitor_spike(busy))
        spike = A._visitor_spike({**calm, d(9): 14})
        self.assertEqual((spike["date"], spike["visits"], spike["typical"]), ("2026-09-09", 14, 3))
        self.assertIsNone(A._visitor_spike({**calm, d(9): 14}, recent_from=d(10)))  # not recent enough
        self.assertIsNone(A._visitor_spike({d(1): 20, d(2): 1}))  # too few busy days to know what is typical

    def test_text_helpers(self):
        self.assertEqual(A._hm(45), "45m")
        self.assertEqual(A._hm(125), "2h 05m")
        self.assertEqual(A._hm(None), "—")
        self.assertEqual(A._wait_text(35), "35 minutes")
        self.assertEqual(A._wait_text(300), "5 hours")
        self.assertEqual(A._wait_text(51960), "36 days 2 hours")
        self.assertEqual(A._clock_label(6), "6:00 am")
        self.assertEqual(A._clock_label(18), "6:00 pm")
        self.assertEqual(A._clock_label(12), "12:00 pm")

    def test_integer_parameters_are_clamped_and_bad_ones_refused(self):
        self.assertEqual(A.int_param({}, "limit", 10, 1, 25), 10)
        self.assertEqual(A.int_param({"limit": "500"}, "limit", 10, 1, 25), 25)
        self.assertEqual(A.int_param({"limit": "0"}, "limit", 10, 1, 25), 1)
        with self.assertRaises(MdParamError):
            A.int_param({"limit": "many"}, "limit", 10, 1, 25)


# ─── the headline figures ─────────────────────────────────────────────────────────────────────────────────────────


class SummaryTests(GateData):
    def test_visitors_with_their_previous_period(self):
        v = self.json("summary")["visitors"]
        self.assertEqual(v["visits"], {"value": 11, "previous": 4, "change": {"abs": 7.0, "pct": 175.0}})
        self.assertEqual(v["uniqueVisitors"], {"value": 6, "previous": 4, "change": {"abs": 2.0, "pct": 50.0}})
        self.assertEqual(v["repeatVisitors"], {"value": 3, "previous": 0, "change": {"abs": 3.0, "pct": None}})
        self.assertEqual(v["afterHours"], {"value": 2, "previous": 0, "change": {"abs": 2.0, "pct": None}})
        self.assertEqual((v["avgPerDay"]["value"], v["avgPerDay"]["previous"]), (0.8, 0.3))  # 11/14 and 4/14
        self.assertEqual(v["peakHour"], {"hour": 11, "label": "11:00–11:59", "visits": 3})
        self.assertEqual(v["peakDay"], {"date": "2026-09-22", "weekday": "Tue", "visits": 2})

    def test_outpass_requests_and_decisions(self):
        o = self.json("summary")["outpass"]
        self.assertEqual(o["requests"], {"value": 12, "previous": 5, "change": {"abs": 7.0, "pct": 140.0}})
        self.assertEqual((o["approved"]["value"], o["approved"]["previous"]), (10, 4))
        self.assertEqual((o["rejected"]["value"], o["rejected"]["previous"]), (1, 1))
        self.assertEqual((o["pending"]["value"], o["pending"]["previous"]), (1, 0))
        # rejected / (approved + rejected): 1/11 and 1/5
        self.assertEqual(
            o["rejectionRatePct"], {"value": 9.1, "previous": 20.0, "change": {"abs": -10.9, "pct": -54.5}}
        )

    def test_the_on_duty_trip_is_counted_apart_and_not_in_the_figures(self):
        o = self.json("summary")["outpass"]
        self.assertEqual((o["onDutyTrips"]["value"], o["onDutyTrips"]["previous"]), (1, 0))
        self.assertEqual(o["minutesOut"]["value"], 325)  # P13's 235 minutes are not in it

    def test_hours_out_return_rate_and_turnaround(self):
        o = self.json("summary")["outpass"]
        self.assertEqual((o["left"]["value"], o["left"]["previous"]), (9, 4))
        self.assertEqual((o["returned"]["value"], o["returned"]["previous"]), (7, 4))
        self.assertEqual((o["notReturned"]["value"], o["notReturned"]["previous"]), (1, 0))
        # 7 returned of (7 returned + 1 never returned); the early dismissal and the unused pass are in neither
        self.assertEqual(o["returnRatePct"], {"value": 87.5, "previous": 100.0, "change": {"abs": -12.5, "pct": -12.5}})
        self.assertEqual(o["minutesOut"], {"value": 325, "previous": 300, "change": {"abs": 25.0, "pct": 8.3}})
        self.assertEqual((o["hoursOut"]["value"], o["hoursOut"]["previous"]), (5.4, 5.0))
        self.assertEqual((o["avgMinutesOut"]["value"], o["avgMinutesOut"]["previous"]), (46, 75))  # 325/7, 300/4
        self.assertEqual(
            (o["turnaroundAvgMinutes"]["value"], o["turnaroundAvgMinutes"]["previous"]), (16, 10)
        )  # 160 minutes over 10 approvals
        self.assertEqual((o["turnaroundMedianMinutes"]["value"], o["turnaroundMedianMinutes"]["previous"]), (10, 10))

    def test_gate_form_exits_count_the_form_only_never_the_copies_of_approved_passes(self):
        o = self.json("summary")["outpass"]
        self.assertEqual((o["gateFormExits"]["value"], o["gateFormExits"]["previous"]), (2, 1))

    def test_live_snapshots_do_not_depend_on_the_period(self):
        o = self.json("summary")["outpass"]
        self.assertEqual(o["outsideNow"], 1)  # P14 left at 08:30 today and is not back
        self.assertEqual(o["waitingNow"], {"waiting": 3, "overOneDay": 2, "oldestMinutes": 51960})
        other = self.json("summary", **{"from": "2026-09-07", "to": "2026-09-20"})["outpass"]
        self.assertEqual((other["outsideNow"], other["waitingNow"]["waiting"]), (1, 3))

    def test_the_envelope_explains_itself(self):
        body = self.json("summary")
        self.assertEqual(body["period"]["days"], 14)
        self.assertEqual(body["previousPeriod"]["start"], "2026-09-07")
        self.assertEqual(body["previousPeriod"]["end"], "2026-09-20")
        ids = {p["id"] for p in body["provenance"]}
        self.assertTrue({"visits", "peak", "passes", "hours-out", "return-rate", "turnaround", "waiting"} <= ids)
        self.assertTrue(any("no check-out" in n for n in body["notes"]))
        hours = next(p for p in body["provenance"] if p["id"] == "hours-out")
        self.assertEqual(hours["rows"], 7)
        self.assertIn("Outpass Summary by Department", hours["definition"])  # cites the Report Center report

    def test_a_period_that_includes_today_says_it_is_in_progress(self):
        body = self.json("summary", **{"from": "2026-10-01", "to": "2026-10-05"})
        self.assertTrue(any("Today is still in progress" in n for n in body["notes"]))
        self.assertFalse(any("in progress" in n for n in self.json("summary")["notes"]))

    def test_low_return_scanning_is_called_out_so_never_returned_is_not_misread(self):
        self.assertFalse(any("scanned back in" in n for n in self.json("summary")["notes"]))  # 7 of 8: fine
        for d in range(22, 34):  # twelve more passes that left and were never scanned back: 7 of 20
            day = ist(9, 22) + timedelta(days=d - 22)
            make_pass(self.e3, day.replace(hour=14), exited=day.replace(hour=15))
        for endpoint in ("summary", "outpass"):
            notes = self.json(endpoint)["notes"]
            note = next(n for n in notes if "scanned back in" in n)
            self.assertIn("Only 35% of the passes that left", note)
            self.assertIn("read 'never returned' as 'return not scanned'", note)

    def test_presets_resolve_against_the_factory_date(self):
        r = self.get(BASE + "summary", period="yesterday")
        self.assertEqual(r.json()["period"]["start"], "2026-10-04")
        self.assertEqual(r.json()["visitors"]["visits"]["value"], 0)  # nobody visited on the 4th


# ─── the trend ────────────────────────────────────────────────────────────────────────────────────────────────────


class TrendTests(GateData):
    def test_a_point_for_every_day_adding_up_to_the_totals(self):
        body = self.json("trend")
        self.assertEqual(body["granularity"], "day")
        self.assertEqual(len(body["points"]), 14)
        self.assertEqual(
            body["totals"],
            {"visits": 11, "passes": 12, "left": 9, "returned": 7, "minutesOut": 325, "gateFormExits": 2},
        )
        by_key = {p["key"]: p for p in body["points"]}
        self.assertEqual(
            by_key["2026-09-22"],
            {
                "key": "2026-09-22",
                "start": "2026-09-22",
                "end": "2026-09-22",
                "days": 1,
                "visits": 2,
                "passes": 1,
                "left": 1,
                "returned": 1,
                "minutesOut": 30,
                "gateFormExits": 1,
            },
        )
        quiet = by_key["2026-09-27"]  # the On-Duty trip day: nothing counted
        self.assertEqual((quiet["visits"], quiet["passes"], quiet["minutesOut"]), (0, 0, 0))

    def test_a_long_period_is_rolled_up_to_weeks(self):
        body = self.json("trend", **{"from": "2026-07-01", "to": "2026-10-04"})  # 96 days
        self.assertEqual(body["granularity"], "week")
        first, last = body["points"][0], body["points"][-1]
        self.assertEqual((first["key"], first["start"], first["days"]), ("2026-06-29", "2026-07-01", 5))  # Wed - Sun
        self.assertEqual((last["key"], last["end"], last["days"]), ("2026-09-28", "2026-10-04", 7))
        self.assertEqual(sum(p["days"] for p in body["points"]), 96)
        self.assertEqual(body["totals"]["visits"], 15)  # 11 + the 4 of the previous period
        self.assertEqual(body["totals"]["passes"], 18)  # P16 (30 Aug) and the five before the period join the 12
        self.assertTrue(any("partial" in c for p in body["provenance"] for c in p["caveats"]))

    def test_a_period_across_a_year_boundary(self):
        body = self.json("trend", **{"from": "2025-12-30", "to": "2026-01-02"})
        self.assertEqual([p["key"] for p in body["points"]], ["2025-12-30", "2025-12-31", "2026-01-01", "2026-01-02"])
        self.assertEqual(body["totals"]["visits"], 0)


# ─── visitors ─────────────────────────────────────────────────────────────────────────────────────────────────────


class VisitorsTests(GateData):
    def test_purposes_are_grouped_by_category_and_say_how_much_is_unmatched(self):
        p = self.json("visitors")["purposes"]
        self.assertEqual(
            [(c["key"], c["visits"]) for c in p["categories"]],
            [("supplier", 4), ("audit", 2), ("delivery", 2), ("personal", 1), ("interview", 1), ("meeting", 1)],
        )
        self.assertEqual(p["categories"][0]["sharePct"], 36.4)  # 4 of 11
        self.assertEqual(p["otherSharePct"], 0.0)
        self.assertEqual(p["otherSamples"], [])
        self.assertEqual(p["typedTop"][0], {"text": "Courier delivery", "visits": 2})

    def test_unmatched_wording_is_kept_so_the_gap_can_be_seen(self):
        visitor = self.v[6]
        make_visit(visitor, ist(9, 21, 10), whom="Reception", purpose="Zxq blorp", branch=self.u1)
        make_visit(visitor, ist(9, 21, 11), whom="Reception", purpose="zxq BLORP", branch=self.u1)
        p = self.json("visitors")["purposes"]
        self.assertEqual(p["categories"][-1]["key"], "other")  # Other always last
        self.assertEqual((p["categories"][-1]["visits"], p["otherSharePct"]), (2, 15.4))  # 2 of 13
        self.assertEqual(len(p["otherSamples"]), 1)  # the two spellings are one wording
        self.assertEqual(
            (p["otherSamples"][0]["text"].lower(), p["otherSamples"][0]["visits"]), ("zxq blorp", 2)
        )  # (which capitals are shown depends on the database's collation)

    def test_host_departments_and_visits_with_no_matched_employee(self):
        body = self.json("visitors")
        self.assertEqual(
            body["hostDepartments"],
            [
                {"department": "Stitching", "visits": 6, "uniqueVisitors": 3, "sharePct": 54.5},
                {"department": "Accounts", "visits": 2, "uniqueVisitors": 1, "sharePct": 18.2},
            ],
        )
        self.assertEqual(body["hostsNotLinked"], {"visits": 3, "sharePct": 27.3})

    def test_the_most_visited_people_include_free_text_hosts(self):
        hosts = self.json("visitors")["topHosts"]
        self.assertEqual(
            [(h["name"], h["visits"], h["linked"]) for h in hosts],
            [
                ("Asha Rao", 4, True),
                ("Dev Anand", 2, True),
                ("Stores", 2, False),
                ("Bala Kumar", 1, True),
                ("Esha Gupta", 1, True),
                ("Mr Kumar", 1, False),
            ],
        )
        first = hosts[0]
        self.assertEqual((first["employeeId"], first["code"], first["department"]), (self.e1.id, "A1", "Stitching"))
        self.assertIsNone(hosts[2]["employeeId"])

    def test_the_limit_caps_every_ranked_list(self):
        body = self.json("visitors", limit=2)
        self.assertEqual(len(body["topHosts"]), 2)
        self.assertEqual(len(body["hostDepartments"]), 2)
        self.assertEqual(len(body["repeatVisitors"]["rows"]), 2)
        self.assertEqual(body["repeatVisitors"]["total"], 3)  # the total is not capped
        self.assertEqual(len(self.json("visitors", limit=999)["topHosts"]), 6)  # clamped to 25, only 6 exist

    def test_repeat_visitors(self):
        rep = self.json("visitors")["repeatVisitors"]
        self.assertEqual((rep["total"], rep["visits"], rep["sharePct"], rep["frequentFrom"]), (3, 8, 72.7, 4))
        self.assertEqual(
            [(r["visitorName"], r["visits"]) for r in rep["rows"]],
            [("Ravi Supplier", 4), ("Inspector Raj", 2), ("Meena Courier", 2)],
        )
        ravi = rep["rows"][0]
        self.assertEqual(ravi["visitorId"], self.v[1].id)
        self.assertEqual(ravi["firstVisitAt"], "2026-09-22T10:15:00")
        self.assertEqual(ravi["lastVisitAt"], "2026-10-02T11:00:00")
        self.assertEqual((ravi["hostsMet"], ravi["lastPurpose"]), (1, "Sales demo"))

    def test_after_hours_and_the_busiest_times(self):
        body = self.json("visitors")
        self.assertEqual(body["afterHours"]["total"], 2)  # 19:30 and 06:45
        self.assertEqual(body["afterHours"]["sharePct"], 18.2)
        self.assertEqual((body["afterHours"]["startHour"], body["afterHours"]["endHour"]), (8, 18))
        self.assertEqual(body["peakHour"]["hour"], 11)
        self.assertEqual(body["busiestWeekday"], {"weekday": "Tue", "visits": 3})

    def test_the_weekday_by_hour_grid(self):
        grid = self.json("visitors")["heatmap"]
        self.assertEqual(grid["weekdays"], ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"])
        self.assertEqual(grid["hours"], list(range(24)))
        v = grid["values"]
        self.assertEqual(
            (v[0][15], v[1][10], v[1][14], v[2][11], v[3][9], v[4][11], v[4][19], v[5][6]), (1, 2, 1, 2, 2, 1, 1, 1)
        )
        self.assertEqual(sum(sum(row) for row in v), 11)
        self.assertEqual((grid["max"], sum(v[6])), (2, 0))  # nothing on a Sunday

    def test_there_is_no_company_and_no_inside_now(self):
        body = self.json("visitors")
        text = json.dumps(body).lower()
        self.assertNotIn("insidenow", text)
        self.assertNotIn("dwell", text)
        self.assertTrue(any("company" in n for n in body["notes"]))
        self.assertTrue(any("no check-out" in n for n in body["notes"]))

    def test_nobody_phone_or_aadhaar_ever_leaves(self):
        text = (
            json.dumps(self.json("visitors")) + json.dumps(self.json("exceptions")) + json.dumps(self.json("activity"))
        )
        self.assertNotIn("90000000", text)  # the fixture's phone numbers all start with it
        self.assertNotIn('"phone"', text)
        self.assertNotIn('"aadhaar', text.lower())


# ─── outpasses ────────────────────────────────────────────────────────────────────────────────────────────────────


class OutpassTests(GateData):
    def test_the_funnel_and_where_the_rest_went(self):
        f = self.json("outpass")["funnel"]
        self.assertEqual((f["requested"], f["approved"], f["left"], f["returned"]), (12, 10, 9, 7))
        self.assertEqual(
            f["dropOffs"],
            {
                "rejected": 1,
                "waiting": 1,
                "approvedNotUsed": 1,
                "outsideNow": 0,
                "notReturned": 1,
                "earlyDismissal": 1,
            },
        )
        self.assertEqual(f["onDutyTrips"], 1)
        # every approved pass is accounted for: left + approved but not used
        self.assertEqual(f["approved"], f["left"] + f["dropOffs"]["approvedNotUsed"])
        self.assertEqual(f["left"], f["returned"] + f["dropOffs"]["notReturned"] + f["dropOffs"]["earlyDismissal"])

    def test_hours_out_by_department_merges_the_same_name_across_units(self):
        rows = self.json("outpass")["byDepartment"]
        self.assertEqual([r["department"] for r in rows], ["Stitching", "Cutting", "Accounts"])
        stitching, cutting, accounts = rows
        self.assertEqual(
            stitching,
            {
                "department": "Stitching",
                "requests": 8,
                "employees": 3,
                "headcount": 3,
                "requestsPer100": 266.7,
                "returned": 6,
                "minutesOut": 310,
                "avgMinutes": 52,  # 310 / 6 = 51.7
                "notReturned": 0,
            },
        )
        self.assertEqual(
            (cutting["requests"], cutting["minutesOut"], cutting["avgMinutes"], cutting["notReturned"]), (2, 15, 15, 1)
        )
        self.assertEqual(
            (accounts["requests"], accounts["minutesOut"], accounts["avgMinutes"]), (2, None, None)
        )  # nobody came back
        self.assertEqual(sum(r["minutesOut"] or 0 for r in rows), 325)
        self.assertEqual(sum(r["requests"] for r in rows), 12)

    def test_the_headcount_is_the_active_staff_only(self):
        rows = {r["department"]: r for r in self.json("outpass")["byDepartment"]}
        self.assertEqual(rows["Stitching"]["headcount"], 3)  # the inactive employee in Stitching is not counted

    def test_reasons_are_the_pass_types(self):
        rows = {r["key"]: r for r in self.json("outpass")["byReason"]}
        self.assertEqual(list(rows), ["official", "personal", "early_dismissal", "unspecified"])
        self.assertEqual(
            {
                k: (v["requests"], v["returned"], v["minutesOut"], v["avgMinutes"], v["sharePct"])
                for k, v in rows.items()
            },
            {
                "official": (2, 2, 165, 83, 16.7),  # 82.5 rounds half up
                "personal": (8, 4, 130, 33, 66.7),  # 32.5
                "early_dismissal": (1, 0, None, None, 8.3),
                "unspecified": (1, 1, 30, 30, 8.3),
            },
        )

    def test_duration_bands(self):
        d = self.json("outpass")["durations"]
        self.assertEqual(
            [(b["key"], b["passes"]) for b in d["buckets"]],
            [("under_15", 1), ("15_30", 1), ("30_60", 3), ("1_2h", 1), ("2_4h", 1), ("over_4h", 0)],
        )
        self.assertEqual((d["measured"], d["medianMinutes"], d["avgMinutes"], d["longestMinutes"]), (7, 30, 46, 150))
        self.assertEqual(d["buckets"][2]["sharePct"], 42.9)

    def test_the_approvals_queue_is_a_live_snapshot_by_age(self):
        a = self.json("outpass")["approvals"]
        self.assertEqual(
            [(b["key"], b["count"]) for b in a["aging"]["buckets"]],
            [("under_1h", 0), ("1_4h", 1), ("4_24h", 0), ("over_24h", 2)],
        )
        self.assertEqual((a["aging"]["waiting"], a["aging"]["overOneDay"], a["aging"]["oldestMinutes"]), (3, 2, 51960))
        self.assertEqual(a["turnaround"], {"avgMinutes": 16, "medianMinutes": 10, "decisions": 10})
        self.assertEqual(a["rejectionRatePct"], 9.1)

    def test_gate_scans_and_refusals(self):
        s = self.json("outpass")["gateScans"]
        self.assertEqual((s["attempts"], s["successful"], s["refused"], s["refusedPct"]), (6, 3, 3, 50.0))
        self.assertEqual(
            [(r["key"], r["count"]) for r in s["byReason"]], [("expired", 1), ("invalid_qr", 1), ("not_approved", 1)]
        )
        self.assertEqual(s["byReason"][0]["label"], "Pass expired")
        self.assertEqual(
            s["byGate"],
            [
                {"gate": "Gate 1", "exits": 2, "returns": 1, "refused": 1},
                {"gate": "Gate 2", "exits": 0, "returns": 0, "refused": 2},
            ],
        )

    def test_totals_match_the_summary(self):
        body = self.json("outpass")
        self.assertEqual(body["totals"]["minutesOut"], 325)
        self.assertEqual(body["totals"]["returnRatePct"], 87.5)
        self.assertEqual(body["requests"], 12)
        self.assertTrue(any("On-Duty trip in this period is official work" in n for n in body["notes"]))

    def test_it_agrees_with_the_report_centers_department_summary(self):
        """The figures the Report Center's 'Outpass Summary by Department' prints for the same dates. That report also
        counts the On-Duty trip (P13, Asha, 235 minutes), so Stitching differs by exactly that trip and the other
        departments match to the minute."""
        spec = report_registry.get_spec("outpass-department-summary")
        request = SimpleNamespace(hr_branch_id=None, jwt_user={"hrUserId": self.md.id})
        query = {"dateFrom": PERIOD["from"], "dateTo": PERIOD["to"], "groupBy": "department"}
        with mock.patch("api.reporting.definitions.gate_outpass_common.now", return_value=NOW):
            rows = run_report(request, spec, query).rows
        # the report keeps a department of the same name in two units apart (and prints the unit); this page merges them
        report = {}
        for r in rows:
            slot = report.setdefault(
                r["group"], {"requests": 0, "minutes": 0, "notReturned": 0, "avg": r["avgOutsideMinutes"]}
            )
            slot["requests"] += r["requests"]
            slot["minutes"] += r["totalOutsideMinutes"] or 0
            slot["notReturned"] += r["notReturned"]
        ours = {r["department"]: r for r in self.json("outpass")["byDepartment"]}
        for department in ("Cutting", "Accounts"):
            self.assertEqual(report[department]["requests"], ours[department]["requests"], department)
            self.assertEqual(report[department]["minutes"], ours[department]["minutesOut"] or 0, department)
            self.assertEqual(report[department]["notReturned"], ours[department]["notReturned"], department)
        self.assertEqual(
            report["Cutting"]["avg"], ours["Cutting"]["avgMinutes"]
        )  # a single-unit department: same average
        self.assertEqual(report["Stitching"]["requests"], ours["Stitching"]["requests"] + 1)
        self.assertEqual(report["Stitching"]["minutes"], ours["Stitching"]["minutesOut"] + 235)


# ─── unit by unit ─────────────────────────────────────────────────────────────────────────────────────────────────


class UnitTests(GateData):
    def test_the_same_measures_unit_by_unit(self):
        rows = self.json("units")["units"]
        self.assertEqual([r["unit"] for r in rows], ["Unit 1", "Unit 2"])  # most time out first
        unit1, unit2 = rows
        self.assertEqual(
            unit1,
            {
                "unitId": self.u1.id,
                "unit": "Unit 1",
                "visits": 8,
                "uniqueVisitors": 4,
                "afterHours": 2,
                "requests": 8,
                "approved": 8,
                "minutesOut": 295,  # P1 30, P2 60, P3 150, P4 30, P5 10, P8 15
                "avgMinutes": 49,  # 295 / 6
                "notReturned": 1,
                "headcount": 4,  # the inactive employee is not counted
                "requestsPer100": 200.0,
            },
        )
        self.assertEqual(
            unit2,
            {
                "unitId": self.u2.id,
                "unit": "Unit 2",
                "visits": 3,
                "uniqueVisitors": 2,
                "afterHours": 0,
                "requests": 4,
                "approved": 2,
                "minutesOut": 30,
                "avgMinutes": 30,
                "notReturned": 0,
                "headcount": 2,
                "requestsPer100": 200.0,
            },
        )

    def test_the_units_add_up_to_the_page(self):
        rows = self.json("units")["units"]
        summary = self.json("summary")
        self.assertEqual(sum(r["visits"] for r in rows), summary["visitors"]["visits"]["value"])
        self.assertEqual(sum(r["requests"] for r in rows), summary["outpass"]["requests"]["value"])
        self.assertEqual(sum(r["minutesOut"] or 0 for r in rows), summary["outpass"]["minutesOut"]["value"])
        self.assertEqual(sum(r["notReturned"] for r in rows), summary["outpass"]["notReturned"]["value"])

    def test_a_chosen_unit_leaves_just_itself(self):
        rows = self.json("units", branch="Unit 2")["units"]
        self.assertEqual([r["unit"] for r in rows], ["Unit 2"])
        self.assertEqual((rows[0]["visits"], rows[0]["requests"]), (3, 4))

    def test_people_and_visits_with_no_unit_are_grouped_not_dropped(self):
        stray = make_employee("N1", "No", "Unit", None, None)
        make_pass(stray, ist(9, 22, 9), exited=ist(9, 22, 9, 5), entered=ist(9, 22, 9, 25))
        make_visit(self.v[6], ist(9, 22, 9), branch=None)
        rows = {r["unit"]: r for r in self.json("units")["units"]}
        self.assertEqual(
            (rows["No unit"]["requests"], rows["No unit"]["minutesOut"], rows["No unit"]["visits"]), (1, 20, 1)
        )
        self.assertIsNone(rows["No unit"]["unitId"])
        self.assertEqual(
            (rows["No unit"]["headcount"], rows["No unit"]["requestsPer100"]), (1, 100.0)
        )  # one active person

    def test_it_is_explained_and_offered_to_the_assistant(self):
        body = self.json("units")
        self.assertIn("units", {p["id"] for p in body["provenance"]})
        with read_only_db():
            result = registry.collect_tools()["outpass_summary"].run({**PERIOD})
        self.assertEqual([r["unit"] for r in result["byUnit"]], ["Unit 1", "Unit 2"])


class PageContractTests(GateData):
    """The cards of the page ask for these explanations by id: every one must exist in that endpoint's provenance."""

    ASKED = {
        "summary": {"visits", "peak", "passes", "hours-out", "return-rate", "waiting", "turnaround", "approvals"},
        "visitors": {"visits", "purposes", "hosts", "repeat-visitors", "after-hours", "heatmap"},
        "outpass": {
            "funnel",
            "return-rate",
            "departments",
            "hours-out",
            "reasons",
            "durations",
            "waiting",
            "turnaround",
            "gate-scans",
        },
        "exceptions": {"exceptions"},
        "trend": {"trend", "hours-out"},
        "activity": {"activity"},
        "units": {"units"},
        "story": {"story", "passes", "hours-out", "return-rate", "waiting"},
        "time-lost": {"time-lost", "hours-out", "tea-minutes-lost"},
    }

    def test_every_explanation_the_page_asks_for_exists(self):
        for endpoint, wanted in self.ASKED.items():
            have = {p["id"] for p in self.json(endpoint)["provenance"]}
            self.assertFalse(wanted - have, f"{endpoint} lacks {sorted(wanted - have)}")

    def test_every_explanation_says_where_the_data_comes_from(self):
        for endpoint in self.ASKED:
            for entry in self.json(endpoint)["provenance"]:
                self.assertTrue(entry["dataset"] and entry["definition"], (endpoint, entry["id"]))

    def test_every_response_is_the_shared_envelope(self):
        for endpoint in self.ASKED:
            body = self.json(endpoint)
            self.assertTrue({"generatedAt", "period", "scope", "provenance", "notes", "tookMs"} <= set(body), endpoint)
            self.assertEqual(body["scope"]["description"], "All units · all departments · staff and production")


# ─── exceptions ───────────────────────────────────────────────────────────────────────────────────────────────────


class ExceptionsTests(GateData):
    def test_repeat_outpass_users_use_approved_passes_and_the_scaled_rule(self):
        e = self.json("exceptions")
        self.assertEqual(e["thresholds"]["repeatOutpass"], {"per30Days": 3, "forThisPeriod": 3, "criticalFrom": 6})
        rep = e["repeatOutpass"]
        self.assertEqual((rep["total"], rep["minimum"]), (1, 3))
        row = rep["rows"][0]
        self.assertEqual(
            row,
            {
                "employeeId": self.e1.id,
                "name": "Asha Rao",
                "code": "A1",
                "department": "Stitching",
                "passes": 4,
                "personal": 3,
                "official": 1,
                "earlyDismissal": 0,
                "notStated": 0,
                "minutesOut": 270,
                "lastPassAt": "2026-09-28T15:00:00",
            },
        )

    def test_a_longer_period_asks_for_more_before_calling_it_repeat(self):
        e = self.json("exceptions", **{"from": "2026-07-08", "to": "2026-10-04"})  # 89 days: 3 x 89/30 = 8.9 -> 9
        self.assertEqual(e["thresholds"]["repeatOutpass"]["forThisPeriod"], 9)
        self.assertEqual(e["repeatOutpass"]["total"], 0)

    def test_never_returned_excludes_early_dismissals_and_unused_passes(self):
        nr = self.json("exceptions")["notReturned"]
        self.assertEqual((nr["total"], nr["neverReturned"], nr["outsideNow"]), (1, 1, 0))
        row = nr["rows"][0]
        self.assertEqual((row["name"], row["code"], row["department"]), ("Chitra Devi", "C3", "Cutting"))
        self.assertEqual(
            (row["state"], row["exitedAt"], row["daysAgo"], row["destination"]),
            ("not_returned", "2026-09-29T13:35:00", 6, "Home"),
        )
        self.assertIsNone(row["minutesOutsideSoFar"])  # no running clock on an old row

    def test_someone_outside_right_now_is_listed_first_with_a_running_time(self):
        nr = self.json("exceptions", **{"from": "2026-09-21", "to": "2026-10-05"})["notReturned"]
        self.assertEqual((nr["total"], nr["neverReturned"], nr["outsideNow"]), (2, 1, 1))
        first = nr["rows"][0]
        self.assertEqual(
            (first["name"], first["state"], first["minutesOutsideSoFar"]), ("Farid Khan", "outside_now", 210)
        )  # 08:30 to 12:00

    def test_long_outpasses_are_far_above_the_typical_one(self):
        lo = self.json("exceptions")["longOutpasses"]
        self.assertEqual((lo["total"], lo["thresholdMinutes"], lo["medianMinutes"]), (1, 120, 30))
        self.assertEqual(
            (lo["rows"][0]["name"], lo["rows"][0]["minutes"], lo["rows"][0]["passType"]), ("Asha Rao", 150, "official")
        )

    def test_the_long_rule_is_twice_the_typical_when_that_is_higher_than_the_floor(self):
        for i in range(8):  # eight passes of 90 minutes: the median becomes 90, so the bar is 180 minutes, not 120
            out = ist(9, 21, 8 + i, 5)
            make_pass(self.e4, ist(9, 21, 8 + i), exited=out, entered=out + timedelta(minutes=90))
        out = ist(9, 22, 8, 5)
        make_pass(self.e4, ist(9, 22, 8), exited=out, entered=out + timedelta(minutes=200))
        lo = self.json("exceptions")["longOutpasses"]
        self.assertEqual((lo["medianMinutes"], lo["thresholdMinutes"]), (90, 180))
        self.assertEqual((lo["total"], lo["rows"][0]["minutes"]), (1, 200))  # Asha's 150 is no longer "far longer"

    def test_approvals_waiting_look_at_all_dates_oldest_first(self):
        w = self.json("exceptions")["approvalsWaiting"]
        self.assertEqual((w["total"], w["pendingTotal"], w["oldestMinutes"]), (2, 3, 51960))
        self.assertEqual([(r["code"], r["waitingMinutes"]) for r in w["rows"]], [("C3", 51960), ("D4", 2760)])
        self.assertEqual(w["rows"][0]["requestedAt"], "2026-08-30T10:00:00")  # before the period, still listed

    def test_after_hours_visits_newest_first(self):
        a = self.json("exceptions")["afterHoursVisits"]
        self.assertEqual(a["total"], 2)
        self.assertEqual(
            [(r["visitorName"], r["visitedAt"]) for r in a["rows"]],
            [("Early Bird", "2026-09-26T06:45:00"), ("Late Guest", "2026-09-25T19:30:00")],
        )
        self.assertEqual((a["rows"][0]["hostName"], a["rows"][0]["hostLinked"]), ("Mr Kumar", False))
        self.assertEqual((a["rows"][1]["hostName"], a["rows"][1]["hostDepartment"]), ("Bala Kumar", "Stitching"))

    def test_unusually_frequent_visitors(self):
        f = self.json("exceptions")["frequentVisitors"]
        self.assertEqual((f["total"], f["minimum"]), (1, 4))
        self.assertEqual((f["rows"][0]["visitorName"], f["rows"][0]["visits"]), ("Ravi Supplier", 4))

    def test_needs_your_attention_is_most_severe_first_with_the_numbers_in_plain_english(self):
        items = self.json("exceptions")["attention"]
        self.assertEqual(
            [(i["id"], i["severity"]) for i in items],
            [
                ("visitors.approvals-waiting", "critical"),  # the oldest has waited over 72 hours
                ("visitors.repeat-outpass", "warning"),
                ("visitors.not-returned", "warning"),
                ("visitors.long-outpass", "warning"),
                ("visitors.after-hours", "info"),
                ("visitors.frequent-visitors", "info"),
            ],
        )
        titles = {i["id"]: i["title"] for i in items}
        self.assertEqual(
            titles["visitors.repeat-outpass"], "1 employee took 3 or more outpasses between 21 Sep – 04 Oct 2026"
        )
        self.assertEqual(
            titles["visitors.approvals-waiting"], "2 outpass requests waiting more than 24 hours for a decision"
        )
        self.assertEqual(
            titles["visitors.not-returned"], "1 outpass taken between 21 Sep – 04 Oct 2026 was never scanned back in"
        )
        self.assertEqual(
            titles["visitors.long-outpass"], "1 outpass lasted 2h 00m or more between 21 Sep – 04 Oct 2026"
        )
        self.assertEqual(
            titles["visitors.after-hours"], "2 visits outside 8:00 am to 6:00 pm between 21 Sep – 04 Oct 2026"
        )
        for item in items:
            self.assertEqual(item["page"], VISITOR_FINDINGS.get(item["id"], "outpass"), item["id"])
            self.assertTrue(item["ask"].endswith("?"))
            self.assertTrue(item["metric"])

    def test_a_serious_repeat_pattern_is_critical(self):
        for i in range(2):  # E1 now has 6 approved passes: twice the rule
            make_pass(self.e1, ist(10, 4, 9 + i))
        item = next(i for i in self.json("exceptions")["attention"] if i["id"] == "visitors.repeat-outpass")
        self.assertEqual(item["severity"], "critical")

    def never_returned(self, days: range):
        for d in days:  # left on an earlier day, no return scan
            make_pass(self.e3, ist(9, d, 14), exited=ist(9, d, 15))

    def test_never_returned_is_critical_when_it_is_many_and_a_real_share(self):
        self.never_returned(range(22, 28))  # 7 never returned against 7 that did come back: half
        item = next(i for i in self.json("exceptions")["attention"] if i["id"] == "visitors.not-returned")
        self.assertEqual(item["severity"], "critical")
        self.assertTrue(item["title"].startswith("7 outpasses taken between"))
        self.assertTrue(item["title"].endswith("were never scanned back in"))
        self.assertEqual(self.json("exceptions")["notReturned"]["sharePct"], 50.0)

    def test_a_handful_out_of_many_returned_passes_is_only_a_warning(self):
        self.never_returned(range(22, 26))  # 5 never returned ...
        for i in range(60):  # ... against 67 that came back (7 + 60): 6.9 %
            out = ist(9, 22, 6) + timedelta(minutes=i)
            make_pass(self.e4, ist(9, 22, 5), exited=out, entered=out + timedelta(minutes=10))
        body = self.json("exceptions")
        item = next(i for i in body["attention"] if i["id"] == "visitors.not-returned")
        self.assertEqual(item["severity"], "warning")
        self.assertEqual((body["notReturned"]["neverReturned"], body["notReturned"]["sharePct"]), (5, 6.9))

    def test_a_visitor_spike_and_good_news_appear_when_they_happen(self):
        for i in range(12):  # 12 visits on one day, against days of 1-2
            make_visit(self.v[6], ist(9, 24, 10, i), host=self.e5, purpose="Meeting", branch=self.u2)
        body = self.json("exceptions")
        spike = next(i for i in body["attention"] if i["id"] == "visitors.visitor-spike")
        self.assertEqual(spike["title"], "13 visitors on Thu 24 Sep, far above a typical day (1)")
        self.assertEqual(spike["severity"], "info")

    def test_improvement_is_reported_when_time_out_falls(self):
        # previous period: a lot of time out; this period: the 325 minutes in the fixture
        for i in range(4):
            e = ist(9, 9 + i, 10)
            make_pass(self.e1, ist(9, 9 + i, 9), exited=e, entered=e + timedelta(hours=5))  # +1200 minutes before
        item = next(i for i in self.json("exceptions")["attention"] if i["id"] == "visitors.hours-down")
        self.assertEqual(item["severity"], "good")
        self.assertEqual(item["title"], "Time out on outpasses fell 78% against the previous 14 days")  # 1500 -> 325
        self.assertEqual(item["detail"], "5h 25m out this period, down from 25h 00m.")

    def test_thresholds_are_in_the_provenance_for_the_screen_and_the_assistant(self):
        body = self.json("exceptions")
        rule = next(p for p in body["provenance"] if p["id"] == "exceptions")
        self.assertIn("3 or more approved passes", rule["definition"])
        self.assertIn("120 minutes", rule["definition"])
        self.assertIn("8:00 am", rule["definition"])


# ─── the activity feed and the day snapshot ───────────────────────────────────────────────────────────────────────


class ActivityTests(GateData):
    def test_newest_first_across_all_three_tables(self):
        body = self.json("activity", pageSize=5)
        self.assertEqual((body["total"], body["counts"]), (25, {"visits": 11, "outpasses": 12, "gateForm": 2}))
        self.assertEqual(
            [(i["kind"], i["at"]) for i in body["items"]],
            [
                ("outpass", "2026-10-04T08:00:00"),  # P12
                ("outpass", "2026-10-03T14:00:00"),  # P10
                ("visit", "2026-10-02T11:00:00"),
                ("outpass", "2026-10-02T10:00:00"),  # P9
                ("visit", "2026-10-01T09:45:00"),
            ],
        )
        self.assertTrue(body["hasMore"])

    def test_paging_walks_the_whole_list_without_repeats(self):
        seen = []
        for page in range(1, 6):
            body = self.json("activity", pageSize=6, page=page)
            seen += [i["id"] for i in body["items"]]
            self.assertEqual(body["hasMore"], page < 5)
        self.assertEqual(len(seen), 25)
        self.assertEqual(len(set(seen)), 25)

    def test_an_outpass_item_says_where_the_pass_ended_up(self):
        items = {i["id"]: i for i in self.json("activity", pageSize=100)["items"] if i["kind"] == "outpass"}
        by_code = {}
        for i in items.values():
            by_code.setdefault(i["code"], []).append(i)
        p7 = next(i for i in by_code["C3"] if i["outcome"] == "not_returned")
        self.assertEqual((p7["outcomeLabel"], p7["destination"], p7["minutesOut"]), ("Never returned", "Home", None))
        p3 = next(i for i in by_code["A1"] if i["passType"] == "official")
        self.assertEqual((p3["outcome"], p3["minutesOut"], p3["exitedAt"]), ("returned", 150, "2026-09-25T09:10:00"))
        outcomes = sorted(i["outcome"] for i in items.values())
        self.assertEqual(outcomes.count("waiting"), 1)
        self.assertEqual(outcomes.count("rejected"), 1)
        self.assertEqual(outcomes.count("approved_unused"), 1)
        self.assertNotIn("on_duty", {i["passType"] for i in items.values()})  # the On-Duty trip is not listed

    def test_search_matches_every_word_somewhere(self):
        sales = self.json("activity", q="sales")
        self.assertEqual(sales["counts"], {"visits": 4, "outpasses": 0, "gateForm": 0})
        asha = self.json("activity", q="asha")  # as the host of 4 visits, the employee of 4 passes, 1 form exit
        self.assertEqual(asha["counts"], {"visits": 4, "outpasses": 4, "gateForm": 1})
        both = self.json("activity", q="asha sales")
        self.assertEqual(both["counts"], {"visits": 4, "outpasses": 0, "gateForm": 0})
        self.assertEqual(self.json("activity", q="nobody by this name")["total"], 0)
        self.assertEqual(self.json("activity", q="stitching")["counts"]["outpasses"], 8)  # by department name

    def test_the_kind_filter(self):
        self.assertEqual(self.json("activity", kind="visits")["total"], 11)
        self.assertEqual(self.json("activity", kind="gate_form")["items"][0]["kind"], "gate_form")
        forms = self.json("activity", kind="gate_form")["items"]
        self.assertEqual(
            [(f["name"], f["matched"], f["department"]) for f in forms],
            [("Unknown", False, None), ("Asha Rao", True, "Stitching")],
        )
        self.assertEqual(self.get(BASE + "activity", **PERIOD, kind="all-of-it").status_code, 400)

    def test_a_page_too_deep_is_refused_with_a_reason(self):
        r = self.get(BASE + "activity", **PERIOD, page=30, pageSize=100)
        self.assertEqual(r.status_code, 400)
        self.assertIn("too deep", r.json()["error"])
        self.assertEqual(self.get(BASE + "activity", **PERIOD, page="x").status_code, 400)
        self.assertEqual(self.json("activity", pageSize=500)["pageSize"], 100)  # clamped, not refused


class DayTests(GateData):
    def test_who_visited_that_day(self):
        body = self.json("day", date="2026-09-22")
        self.assertEqual(
            (body["date"], body["weekday"], body["isToday"], body["isFuture"]), ("2026-09-22", "Tue", False, False)
        )
        v = body["visitors"]
        self.assertEqual((v["visits"], v["uniqueVisitors"], v["afterHours"], v["more"]), (2, 1, 0, 0))
        self.assertEqual(
            [(r["visitorName"], r["at"], r["hostName"]) for r in v["rows"]],
            [
                ("Ravi Supplier", "2026-09-22T14:30:00", "Asha Rao"),
                ("Ravi Supplier", "2026-09-22T10:15:00", "Asha Rao"),
            ],
        )
        o = body["outpass"]
        self.assertEqual((o["requests"], o["left"], o["returned"], o["minutesOut"]), (1, 1, 1, 30))
        self.assertEqual(body["gateFormExits"]["count"], 1)

    def test_the_lists_are_capped_but_the_totals_are_not(self):
        body = self.json("day", date="2026-09-22", limit=1)
        self.assertEqual(
            (len(body["visitors"]["rows"]), body["visitors"]["more"], body["visitors"]["visits"]), (1, 1, 2)
        )

    def test_today_and_the_future(self):
        today = self.json("day", date="2026-10-05")
        self.assertTrue(today["isToday"])
        self.assertEqual(today["visitors"]["visits"], 2)
        self.assertEqual(today["outpass"]["requests"], 2)  # P14 and P15
        future = self.json("day", date="2026-12-25")
        self.assertTrue(future["isFuture"])
        self.assertEqual(future["visitors"]["visits"], 0)
        self.assertTrue(any("not happened yet" in n for n in future["notes"]))

    def test_the_date_is_required_and_must_be_a_date(self):
        self.assertEqual(self.get(BASE + "day").status_code, 400)
        r = self.get(BASE + "day", date="yesterday")
        self.assertEqual(r.status_code, 400)
        self.assertIn("not a date", r.json()["error"])


# ─── scope: unit, department, staff or production ─────────────────────────────────────────────────────────────────


class ScopeTests(GateData):
    def test_a_unit_narrows_the_passes_by_employee_and_the_visits_by_the_gate(self):
        s = self.json("summary", branch="Unit 2")
        self.assertEqual(s["outpass"]["requests"]["value"], 4)  # P9 P10 (Dev) P11 P12 (Esha)
        self.assertEqual((s["outpass"]["approved"]["value"], s["outpass"]["rejected"]["value"]), (2, 1))
        self.assertEqual((s["visitors"]["visits"]["value"], s["visitors"]["uniqueVisitors"]["value"]), (3, 2))
        self.assertEqual(s["outpass"]["gateFormExits"]["value"], 1)  # F2 was typed at Unit 2's QR
        self.assertEqual(s["outpass"]["waitingNow"]["waiting"], 1)  # P10 only: P15 and P16 are Unit 1 staff
        self.assertEqual(s["scope"]["description"], "Unit 2 · all departments · staff and production")

    def test_a_department_name_covers_every_unit_and_visits_follow_the_person_visited(self):
        s = self.json("summary", department="Stitching")
        self.assertEqual(s["outpass"]["requests"]["value"], 8)
        self.assertEqual((s["visitors"]["visits"]["value"], s["visitors"]["uniqueVisitors"]["value"]), (6, 3))
        self.assertTrue(any("matched to an employee" in n for n in s["notes"]))
        self.assertEqual(s["outpass"]["gateFormExits"]["value"], 1)  # the unmatched form exit has no department

    def test_staff_or_production(self):
        staff = self.json("summary", type="staff")
        self.assertEqual(staff["outpass"]["requests"]["value"], 2)  # Dev's two
        self.assertEqual(staff["visitors"]["visits"]["value"], 2)  # visits to Dev
        production = self.json("summary", type="production")
        self.assertEqual(production["outpass"]["requests"]["value"], 10)

    def test_scope_reaches_the_breakdowns_the_exceptions_and_the_scans(self):
        self.assertEqual(
            [r["department"] for r in self.json("outpass", department="Cutting")["byDepartment"]], ["Cutting"]
        )
        self.assertEqual(self.json("outpass", branch="Unit 2")["gateScans"]["attempts"], 2)
        repeat = self.json("exceptions", department="Accounts")["repeatOutpass"]
        self.assertEqual(repeat["total"], 0)
        self.assertEqual(self.json("exceptions", department="Cutting")["notReturned"]["total"], 1)
        self.assertEqual(self.json("exceptions", department="Accounts")["notReturned"]["total"], 0)
        self.assertEqual(self.json("visitors", branch="Unit 2")["visits"], 3)
        self.assertEqual(self.json("activity", branch="Unit 2")["counts"], {"visits": 3, "outpasses": 4, "gateForm": 1})

    def test_an_unknown_unit_or_department_says_what_exists(self):
        r = self.get(BASE + "summary", **PERIOD, department="Quantum Physics")
        self.assertEqual(r.status_code, 400)
        self.assertIn("Stitching", r.json()["error"])
        self.assertEqual(self.get(BASE + "summary", **PERIOD, type="contract").status_code, 400)


# ─── period edges ─────────────────────────────────────────────────────────────────────────────────────────────────


class PeriodEdgeTests(MdApiTestCase):
    """The period is whole IST calendar days, both ends included, whatever the UTC clock says."""

    def setUp(self):
        super().setUp()
        patcher = mock.patch("api.md_portal.analytics.visitors._now", return_value=NOW)
        patcher.start()
        self.addCleanup(patcher.stop)
        self.visitor = Visitor.objects.create(name="Edge", phone="8000000001")
        self.branch = Branch.objects.create(name="Edge Unit", code="EU")

    def visits(self, frm, to):
        r = self.get(BASE + "summary", **{"from": frm, "to": to})
        self.assertEqual(r.status_code, 200, r.content)
        return r.json()["visitors"]["visits"]["value"]

    def test_both_ends_are_inclusive_in_factory_time(self):
        for at in (
            ist(9, 20, 23, 59),  # the day before: out
            ist(9, 21, 0, 0),  # first instant of the first day: in (00:00 IST is 18:30 UTC the day before)
            ist(9, 21, 2, 0),  # 20:30 UTC on the 20th: still the 21st in the factory
            ist(10, 4, 23, 59),  # last minute of the last day: in
            ist(10, 5, 0, 0),  # the next day: out
        ):
            make_visit(self.visitor, at, branch=self.branch)
        self.assertEqual(self.visits("2026-09-21", "2026-10-04"), 3)
        self.assertEqual(self.visits("2026-09-21", "2026-09-21"), 2)  # a one-day period
        self.assertEqual(self.visits("2026-10-05", "2026-10-05"), 1)

    def test_the_previous_period_ends_the_day_before_and_has_the_same_length(self):
        make_visit(self.visitor, ist(9, 20, 12), branch=self.branch)
        make_visit(self.visitor, ist(9, 7, 12), branch=self.branch)
        make_visit(self.visitor, ist(9, 6, 12), branch=self.branch)  # one day too early: not in the previous period
        v = self.get(BASE + "summary", **PERIOD).json()["visitors"]["visits"]
        self.assertEqual((v["value"], v["previous"]), (0, 2))

    def test_a_whole_month_and_a_month_boundary(self):
        make_visit(self.visitor, ist(1, 31, 23, 30, 2026), branch=self.branch)
        make_visit(self.visitor, ist(2, 1, 0, 30, 2026), branch=self.branch)
        jan = self.get(BASE + "summary", month="2026-01").json()
        feb = self.get(BASE + "summary", month="2026-02").json()
        self.assertEqual((jan["period"]["label"], jan["visitors"]["visits"]["value"]), ("Jan 2026", 1))
        self.assertEqual((feb["period"]["label"], feb["visitors"]["visits"]["value"]), ("Feb 2026", 1))
        self.assertEqual(feb["visitors"]["visits"]["previous"], 1)  # the previous 28 days include 31 Jan

    def test_a_period_across_the_new_year_and_its_previous_period(self):
        make_visit(self.visitor, ist(12, 31, 23, 0, 2025), branch=self.branch)
        make_visit(self.visitor, ist(1, 1, 1, 0, 2026), branch=self.branch)
        make_visit(self.visitor, ist(12, 29, 10, 0, 2025), branch=self.branch)
        body = self.get(BASE + "summary", **{"from": "2025-12-31", "to": "2026-01-02"}).json()
        self.assertEqual(body["visitors"]["visits"]["value"], 2)
        self.assertEqual((body["previousPeriod"]["start"], body["previousPeriod"]["end"]), ("2025-12-28", "2025-12-30"))
        self.assertEqual(body["visitors"]["visits"]["previous"], 1)

    def test_an_outpass_belongs_to_the_day_it_was_requested(self):
        emp = make_employee("Z1", "Zed", "Late", None, self.branch)
        make_pass(emp, ist(9, 21, 0, 10))  # 18:40 UTC on the 20th: a 21 Sep request
        make_pass(emp, ist(9, 20, 23, 50))
        o = self.get(BASE + "summary", **{"from": "2026-09-21", "to": "2026-09-21"}).json()["outpass"]
        self.assertEqual(o["requests"]["value"], 1)


# ─── empty database ───────────────────────────────────────────────────────────────────────────────────────────────


class EmptyDatabaseTests(MdApiTestCase):
    """Nothing recorded: no division by zero, "no data" is null (never 0), and every endpoint still answers."""

    def setUp(self):
        super().setUp()
        patcher = mock.patch("api.md_portal.analytics.visitors._now", return_value=NOW)
        patcher.start()
        self.addCleanup(patcher.stop)

    def test_every_endpoint_answers(self):
        for endpoint in ("summary", "trend", "visitors", "outpass", "exceptions", "activity"):
            r = self.get(BASE + endpoint, **PERIOD)
            self.assertEqual(r.status_code, 200, (endpoint, r.content))
        self.assertEqual(self.get(BASE + "day", date="2026-10-04").status_code, 200)

    def test_summary_has_nulls_not_zeros_where_there_is_nothing_to_divide(self):
        body = self.get(BASE + "summary", **PERIOD).json()
        v, o = body["visitors"], body["outpass"]
        self.assertEqual(v["visits"], {"value": 0, "previous": 0, "change": {"abs": 0.0, "pct": None}})
        self.assertIsNone(v["peakHour"])
        self.assertIsNone(v["peakDay"])
        for key in (
            "rejectionRatePct",
            "returnRatePct",
            "minutesOut",
            "hoursOut",
            "avgMinutesOut",
            "turnaroundAvgMinutes",
        ):
            self.assertEqual((o[key]["value"], o[key]["change"]), (None, None), key)
        self.assertEqual(o["requests"]["value"], 0)
        self.assertEqual(
            (o["outsideNow"], o["waitingNow"]), (0, {"waiting": 0, "overOneDay": 0, "oldestMinutes": None})
        )

    def test_breakdowns_are_empty_lists_and_nulls(self):
        v = self.get(BASE + "visitors", **PERIOD).json()
        self.assertEqual(
            (v["visits"], v["purposes"]["categories"], v["topHosts"], v["hostDepartments"]), (0, [], [], [])
        )
        self.assertIsNone(v["purposes"]["otherSharePct"])
        self.assertIsNone(v["busiestWeekday"])
        self.assertEqual(v["heatmap"]["max"], 0)
        o = self.get(BASE + "outpass", **PERIOD).json()
        self.assertEqual((o["requests"], o["byDepartment"], o["byReason"]), (0, [], []))
        self.assertEqual((o["durations"]["measured"], o["durations"]["medianMinutes"]), (0, None))
        self.assertIsNone(o["gateScans"]["refusedPct"])
        self.assertEqual(o["funnel"]["requested"], 0)

    def test_nothing_needs_attention(self):
        e = self.get(BASE + "exceptions", **PERIOD).json()
        self.assertEqual(e["attention"], [])
        self.assertEqual(e["repeatOutpass"], {"total": 0, "minimum": 3, "rows": []})
        self.assertIsNone(e["longOutpasses"]["medianMinutes"])  # too few passes to know what is typical
        self.assertEqual(e["longOutpasses"]["thresholdMinutes"], 120)

    def test_the_trend_is_zeros_and_the_feed_is_empty(self):
        t = self.get(BASE + "trend", **PERIOD).json()
        self.assertEqual(len(t["points"]), 14)
        self.assertEqual(sum(p["visits"] + p["passes"] for p in t["points"]), 0)
        a = self.get(BASE + "activity", **PERIOD).json()
        self.assertEqual((a["total"], a["items"], a["hasMore"]), (0, [], False))

    def test_the_summaries_say_so_when_there_is_nothing_to_summarise(self):
        outpass = self.get(BASE + "story", focus="outpass", **PERIOD).json()
        self.assertEqual(
            [s["text"] for s in outpass["sentences"]],
            [
                "No employee asked for an outpass between 21 Sep – 04 Oct 2026.",
                "Nothing about outpasses needs your attention in this period.",
            ],
        )
        visitors = self.get(BASE + "story", focus="visitors", **PERIOD).json()
        self.assertEqual(
            [s["text"] for s in visitors["sentences"]],
            [
                "Nobody checked in at the gate between 21 Sep – 04 Oct 2026.",
                "Nothing about visitors needs your attention in this period.",
            ],
        )

    def test_time_lost_has_nulls_not_zeros_when_nothing_was_measured(self):
        body = self.get(BASE + "time-lost", **PERIOD).json()
        for key in ("outpassMinutes", "teaMinutes", "togetherMinutes"):
            self.assertEqual((body["totals"][key]["value"], body["totals"][key]["change"]), (None, None), key)
        self.assertEqual(len(body["points"]), 14)
        self.assertEqual(sum(p["outpassMinutes"] + p["teaMinutes"] for p in body["points"]), 0)
        self.assertEqual((body["byDepartment"], body["departmentsTotal"], body["outpassByReason"]), ([], 0, []))

    def test_the_dashboard_hooks_work_on_nothing(self):
        self.assertEqual(A.insights(today=TODAY), [])
        h = A.headline(today=TODAY)
        self.assertEqual([k["id"] for k in h["kpis"]], ["visitors-today", "outpasses-today", "hours-out-week"])
        self.assertEqual(h["kpis"][0]["value"], 0)
        self.assertIsNone(h["kpis"][2]["value"])  # no passes this week: no data, not 0 minutes
        self.assertIsNone(h["kpis"][2]["delta"])


# ─── the Dashboard's hooks ────────────────────────────────────────────────────────────────────────────────────────


class DashboardHookTests(GateData):
    def test_insights_are_the_pages_findings_for_the_last_30_days_top_five(self):
        items = A.insights(today=TODAY)
        self.assertLessEqual(len(items), 5)
        self.assertEqual(
            [(i["id"], i["severity"]) for i in items],
            [
                ("visitors.approvals-waiting", "critical"),
                ("visitors.repeat-outpass", "warning"),
                ("visitors.not-returned", "warning"),
                ("visitors.long-outpass", "warning"),
                ("visitors.after-hours", "info"),
            ],
        )
        titles = {i["id"]: i["title"] for i in items}
        # 30 days to today: Asha (5 approved), Bala (3: Q2, P5, P6) and Esha (3: Q5, P11, P12)
        self.assertEqual(titles["visitors.repeat-outpass"], "3 employees took 3 or more outpasses in the last 30 days")
        self.assertEqual(
            titles["visitors.long-outpass"], "2 outpasses lasted 2h 00m or more in the last 30 days"
        )  # Q5 120, P3 150
        for item in items:
            self.assertEqual(set(item), {"id", "severity", "title", "detail", "metric", "page", "ask"})

    def test_insights_equal_the_pages_attention_for_the_same_period(self):
        page = self.get(BASE + "exceptions", period="last_30_days").json()["attention"]
        self.assertEqual([i["id"] for i in A.insights(today=TODAY)], [i["id"] for i in page][:5])

    def test_headline_cards(self):
        h = A.headline(today=TODAY)
        visitors, outpasses, hours = h["kpis"]
        self.assertEqual((visitors["value"], visitors["sub"], visitors["format"]), (2, "0 yesterday", "number"))
        self.assertEqual(
            (outpasses["value"], outpasses["sub"]), (2, "3 waiting for approval")
        )  # P14, P15 today; 3 pending
        self.assertEqual((hours["value"], hours["format"], hours["sub"]), (0, "minutes", "2 passes since Monday"))
        self.assertEqual(
            hours["delta"], {"abs": -30.0, "pct": -100.0, "good": "down"}
        )  # last Monday: Asha's 30 minutes
        for k in h["kpis"]:
            self.assertEqual(len(k["spark"]), 14)
        self.assertEqual([k["page"] for k in h["kpis"]], ["visitors", "outpass", "outpass"])  # each opens its own page
        self.assertEqual(visitors["spark"][-1], 2)  # today
        self.assertEqual(hours["spark"][:4], [30, 10, 60, 150])  # 22, 23, 24, 25 Sep
        self.assertTrue(h["provenance"])

    def test_headline_on_a_later_day_is_evaluated_as_of_that_day(self):
        h = A.headline(today=date(2026, 10, 2))
        self.assertEqual(h["kpis"][0]["value"], 1)  # Ravi on 2 Oct
        self.assertEqual(len(h["kpis"][0]["spark"]), 14)


# ─── the assistant's tools ────────────────────────────────────────────────────────────────────────────────────────


class ToolTests(GateData):
    def tool(self, name):
        return registry.collect_tools()[name]

    def run_tool(self, name, **args):
        with read_only_db():
            return self.tool(name).run({**PERIOD, **args})

    def test_the_module_offers_its_tools(self):
        names = {t.name for t in A.TOOLS}
        self.assertEqual(
            names,
            {
                "visitors_summary",
                "visitors_breakdown",
                "outpass_summary",
                "outpass_exceptions",
                "gate_trend",
                "gate_activity_on_date",
                "search_gate_activity",
                "time_lost_comparison",
            },
        )
        self.assertTrue(names <= set(registry.collect_tools()))
        for t in A.TOOLS:
            self.assertEqual(t.page, "visitors")

    def test_every_result_is_plain_json_small_and_explained(self):
        for t in A.TOOLS:
            args = {**PERIOD, **t.example} if t.default_period else dict(t.example)
            with read_only_db():
                result = t.run(args)
            text = json.dumps(result)  # no default=: dates and Decimals must already be plain JSON
            self.assertLess(len(text), 20_000, t.name)
            self.assertTrue(result["provenance"], t.name)

    def test_visitors_summary_is_the_visitor_half_only(self):
        r = self.run_tool("visitors_summary")
        self.assertNotIn("outpass", r)
        self.assertEqual(r["visitors"]["visits"]["value"], 11)
        self.assertEqual(r["previousPeriod"]["start"], "2026-09-07")
        self.assertTrue(r["provenance"])
        self.assertIn("no check-out", " ".join(r["notes"]))

    def test_outpass_summary_has_the_figures_the_funnel_and_the_departments(self):
        r = self.run_tool("outpass_summary", limit=2)
        self.assertEqual(r["outpass"]["minutesOut"]["value"], 325)
        self.assertEqual(r["funnel"]["requested"], 12)
        self.assertEqual(len(r["byDepartment"]), 2)  # capped by the limit
        self.assertEqual(r["approvalsQueue"]["overOneDay"], 2)
        self.assertNotIn("byGate", r["gateScans"])

    def test_breakdown_leaves_out_the_grid_the_model_cannot_use(self):
        r = self.run_tool("visitors_breakdown", limit=3)
        self.assertNotIn("heatmap", r)
        self.assertEqual(len(r["topHosts"]), 3)
        self.assertEqual(r["purposes"]["categories"][0]["key"], "supplier")

    def test_exceptions_tool_returns_the_rules_with_the_lists(self):
        r = self.run_tool("outpass_exceptions", limit=1)
        self.assertEqual(len(r["approvalsWaiting"]["rows"]), 1)
        self.assertEqual(r["approvalsWaiting"]["total"], 2)
        self.assertEqual(r["thresholds"]["repeatOutpass"]["forThisPeriod"], 3)

    def test_the_trend_tool_is_compact(self):
        r = self.run_tool("gate_trend")
        self.assertEqual(set(r["points"][0]), {"key", "days", "visits", "passes", "minutesOut"})
        self.assertEqual(r["totals"]["visits"], 11)

    def test_one_day_by_date(self):
        with read_only_db():
            r = self.tool("gate_activity_on_date").run({"date": "2026-09-22", "limit": 5})
        self.assertEqual(r["visitors"]["visits"], 2)
        self.assertEqual(r["visitors"]["rows"][0]["visitorName"], "Ravi Supplier")
        with self.assertRaises(MdParamError):
            with read_only_db():
                self.tool("gate_activity_on_date").run({"date": "last tuesday"})
        with self.assertRaises(MdParamError):
            with read_only_db():
                self.tool("gate_activity_on_date").run({})  # the date is required

    def test_search_by_words_and_kind(self):
        r = self.run_tool("search_gate_activity", query="inspector", kind="visits", limit=5)
        self.assertEqual(r["total"], 2)
        self.assertTrue(all(i["kind"] == "visit" for i in r["items"]))
        self.assertEqual(len(self.run_tool("search_gate_activity", limit=3)["items"]), 3)

    def test_person_fields_are_declared_for_the_privacy_layer(self):
        for name in ("visitors_breakdown", "outpass_exceptions", "gate_activity_on_date", "search_gate_activity"):
            self.assertIn("hostName", self.tool(name).person_fields)

    def test_no_real_name_survives_the_assistants_privacy_layer_and_the_result_stays_small(self):
        from .md_portal.assistant.privacy import Pseudonymizer
        from .md_portal.assistant.shaping import MAX_CHARS, compact

        people = ("Asha Rao", "Bala Kumar", "Chitra Devi", "Dev Anand", "Esha Gupta", "Farid Khan")
        visitors = ("Ravi Supplier", "Meena Courier", "Inspector Raj", "Late Guest", "Early Bird", "Walk In")
        calls = {
            "outpass_exceptions": {},
            "visitors_breakdown": {},
            "outpass_summary": {},
            "gate_activity_on_date": {"date": "2026-09-22"},
            "search_gate_activity": {"query": "a"},
        }
        for name, args in calls.items():
            spec = self.tool(name)
            result = self.run_tool(name, **args) if spec.default_period else spec.run(args)
            safe = Pseudonymizer(enabled=True).protect(result, spec.person_fields)
            text = json.dumps(safe)
            for real in (*people, *visitors):
                self.assertNotIn(real, text, f"{name} leaks {real}")
            self.assertLessEqual(len(json.dumps(compact(safe), default=str)), MAX_CHARS + 500, name)

    def test_the_tools_agree_with_the_pages(self):
        page = self.json("summary")
        tool = self.run_tool("outpass_summary")
        self.assertEqual(tool["outpass"]["requests"], page["outpass"]["requests"])
        self.assertEqual(tool["outpass"]["hoursOut"], page["outpass"]["hoursOut"])


# ─── each page's summary in plain English ─────────────────────────────────────────────────────────────────────────


class StoryTests(GateData):
    def story(self, focus, **params):
        return self.json("story", focus=focus, **params)

    def test_the_outpass_summary_is_made_of_the_pages_own_figures(self):
        body = self.story("outpass")
        self.assertEqual(body["focus"], "outpass")
        self.assertEqual([s["id"] for s in body["sentences"]], ["volume", "time", "control", "attention"])
        self.assertEqual(
            [s["text"] for s in body["sentences"]],
            [
                # 12 requests (5 before): 10 approved, 1 rejected, P10 undecided
                "12 outpass requests were made between 21 Sep – 04 Oct 2026 (up 7 on the previous 14 days): "
                "10 approved, 1 rejected, 1 not yet decided.",
                # 325 minutes over 7 returned passes (46 each); 300 before
                "Employees spent 5h 25m outside the gate on the passes that were scanned back in "
                "(46m each on average; up 25 minutes on the previous 14 days).",
                # 7 returned of 7 + P7 never returned; P14 is outside right now
                "7 of the 8 passes that left were scanned back in (87.5%); 1 never came back, and 1 employee is "
                "outside right now.",
                "The most important item: 2 outpass requests waiting more than 24 hours for a decision. "
                "3 other items also need a look.",
            ],
        )
        self.assertEqual(body["text"], " ".join(s["text"] for s in body["sentences"]))
        self.assertEqual([s["tone"] for s in body["sentences"]], ["neutral", "watch", "watch", "watch"])
        self.assertTrue(body["ask"].startswith("Explain the outpass picture between 21 Sep – 04 Oct 2026"))

    def test_the_visitors_summary_is_made_of_the_pages_own_figures(self):
        body = self.story("visitors")
        self.assertEqual(body["focus"], "visitors")
        self.assertEqual([s["id"] for s in body["sentences"]], ["volume", "peak", "mix", "attention"])
        self.assertEqual(
            [s["text"] for s in body["sentences"]],
            [
                "11 visits by 6 different visitors between 21 Sep – 04 Oct 2026 (up 7 on the previous 14 days), "
                "about 0.8 a day.",
                "The busiest hour is 11:00–11:59 and the busiest day Tue 22 Sep (2 visits).",
                "2 visits were outside 8:00 am to 6:00 pm; 3 visitors came more than once.",
                "Nothing urgent. For your information: 2 visits outside 8:00 am to 6:00 pm between 21 Sep – 04 Oct 2026.",
            ],
        )
        self.assertTrue(body["ask"].startswith("Explain visitor traffic between 21 Sep – 04 Oct 2026"))
        story = next(p for p in body["provenance"] if p["id"] == "story")
        self.assertTrue(any("no check-out" in c for c in story["caveats"]))  # said, not faked

    def test_each_summary_quotes_its_own_half_only(self):
        outpass = " ".join(s["text"] for s in self.story("outpass")["sentences"])
        visitors = " ".join(s["text"] for s in self.story("visitors")["sentences"])
        self.assertNotIn("visits", outpass)
        self.assertNotIn("outpass request", visitors)

    def test_every_figure_in_it_is_the_figure_the_summary_gives(self):
        for scope in ({}, {"department": "Cutting"}, {"branch": self.u2.id}, {"type": "staff"}):
            page = self.json("summary", **scope)
            text = " ".join(s["text"] for s in self.story("outpass", **scope)["sentences"])
            requests = page["outpass"]["requests"]["value"]
            if requests:
                self.assertIn(f"{requests} outpass request", text, scope)
            minutes = page["outpass"]["minutesOut"]["value"]
            if minutes:
                self.assertIn(A._hm(minutes), text, scope)
            visits = page["visitors"]["visits"]["value"]
            vtext = " ".join(s["text"] for s in self.story("visitors", **scope)["sentences"])
            if visits:
                self.assertIn(f"{visits} visit", vtext, scope)

    def test_the_summary_follows_the_period_and_the_selection(self):
        body = self.story("outpass", department="Accounts")  # Dev: one rejected and one pending request
        self.assertEqual(
            body["sentences"][0]["text"],
            "2 outpass requests were made between 21 Sep – 04 Oct 2026 (up 1 on the previous 14 days): "
            "1 rejected, 1 not yet decided.",
        )
        self.assertTrue(body["ask"].endswith("what should I look at first?"))
        self.assertIn("Accounts", body["ask"])

    def test_an_unknown_page_is_a_readable_400(self):
        r = self.get(BASE + "story", focus="tea", **PERIOD)
        self.assertEqual(r.status_code, 400)
        self.assertIn("'focus' must be one of: outpass, visitors", r.json()["error"])

    def test_the_default_page_is_outpass(self):
        self.assertEqual(self.json("story")["focus"], "outpass")


class StoryRuleTests(SimpleTestCase):
    def test_the_attention_sentence_says_what_matters_most_and_how_much_else_there_is(self):
        def item(severity, title):
            return {"severity": severity, "title": title}

        said = lambda items: tea.attention_line(items, "outpasses")  # noqa: E731
        self.assertEqual(
            said([]),
            {"id": "attention", "text": "Nothing about outpasses needs your attention in this period.", "tone": "good"},
        )
        one = said([item("critical", "3 requests are stuck"), item("info", "x")])
        self.assertEqual((one["text"], one["tone"]), ("The most important item: 3 requests are stuck.", "watch"))
        many = said([item("warning", "A"), item("warning", "B"), item("critical", "C")])["text"]
        self.assertEqual(many, "The most important item: A. 2 other items also need a look.")
        two = said([item("warning", "A"), item("warning", "B")])["text"]
        self.assertEqual(two, "The most important item: A. 1 other item also needs a look.")
        good = said([item("good", "Time out fell 20%"), item("info", "x")])
        self.assertEqual(
            (good["text"], good["tone"]), ("Nothing urgent, and some good news: Time out fell 20%.", "good")
        )
        info = said([item("info", "2 visits after hours")])
        self.assertEqual(
            (info["text"], info["tone"]), ("Nothing urgent. For your information: 2 visits after hours.", "neutral")
        )

    def test_numbers_are_written_the_way_the_company_reads_them(self):
        self.assertEqual(A._n(1234567), "12,34,567")
        self.assertEqual(A._n(0.8, 1), "0.8")
        self.assertEqual(A._n(46.0, 1), "46")  # no trailing ".0"
        self.assertEqual(A._n(1500.5, 1), "1,500.5")
        self.assertEqual(A._n(None), "—")

    def test_the_comparison_wording(self):
        period = Period(date(2026, 9, 21), date(2026, 10, 4), "custom", "x")
        self.assertEqual(A._before(period), "the previous 14 days")
        self.assertEqual(A._before(Period(date(2026, 9, 21), date(2026, 9, 21), "custom", "x")), "the day before")
        up = {"change": {"abs": 7.0, "pct": 175.0}}
        self.assertEqual(A._moved(up, "", period), "up 7 on the previous 14 days")
        self.assertEqual(
            A._moved({"change": {"abs": -12.5, "pct": -12.5}}, " points", period, 1),
            "down 12.5 points on the previous 14 days",
        )
        self.assertEqual(A._moved({"change": {"abs": 0.0, "pct": 0.0}}, "", period), "")  # nothing moved
        self.assertEqual(A._moved({"change": None}, "", period), "")  # nothing to compare with


# ─── time lost: outpasses beside tea breaks ───────────────────────────────────────────────────────────────────────


class TimeLostTests(GateData):
    """The tea breaks, on top of the gate fixture (allowance 15 minutes; out -> in, minutes beyond the allowance):
    E1 22 Sep 10:00-10:30 (30, lost 15) and 15:00-15:10 (10);  E2 23 Sep 10:00-10:25 (25, lost 10);  E3 29 Sep
    10:00-10:20 (20, lost 5);  E4 24 Sep 11:00-11:15 (15);  E5 30 Sep 10:00-11:00 (60, lost 45);  and before the period
    E1 10 Sep 10:00-10:20 (20, lost 5).  Lost in the period 75, before it 5."""

    @classmethod
    def setUpTestData(cls):
        super().setUpTestData()
        TeaBreakRule.objects.create(pk=1, allowed_minutes=15)

        def brk(emp, month, day, start, end):
            TeaBreakLog.objects.create(employee=emp, out_at=ist(month, day, *start), in_at=ist(month, day, *end))

        brk(cls.e1, 9, 22, (10, 0), (10, 30))
        brk(cls.e1, 9, 22, (15, 0), (15, 10))
        brk(cls.e2, 9, 23, (10, 0), (10, 25))
        brk(cls.e3, 9, 29, (10, 0), (10, 20))
        brk(cls.e4, 9, 24, (11, 0), (11, 15))
        brk(cls.e5, 9, 30, (10, 0), (11, 0))
        brk(cls.e1, 9, 10, (10, 0), (10, 20))

    def setUp(self):
        super().setUp()
        patcher = mock.patch.object(TC, "now_utc", return_value=NOW)
        patcher.start()
        self.addCleanup(patcher.stop)

    def test_totals_against_the_previous_period(self):
        totals = self.json("time-lost")["totals"]
        self.assertEqual(totals["outpassMinutes"], {"value": 325, "previous": 300, "change": {"abs": 25.0, "pct": 8.3}})
        self.assertEqual(totals["teaMinutes"], {"value": 75, "previous": 5, "change": {"abs": 70.0, "pct": 1400.0}})
        self.assertEqual(
            totals["togetherMinutes"], {"value": 400, "previous": 305, "change": {"abs": 95.0, "pct": 31.1}}
        )

    def test_the_tea_side_is_the_tea_break_pages_own_figure(self):
        mine = self.json("time-lost")["totals"]["teaMinutes"]
        page = self.get("/api/md/tea-break/summary", **PERIOD).json()["metrics"]["minutesLost"]
        self.assertEqual(mine, {k: page[k] for k in ("value", "previous", "change")})

    def test_a_point_for_every_day_adding_up_to_the_totals(self):
        body = self.json("time-lost")
        self.assertEqual((body["granularity"], len(body["points"]), body["allowedMinutes"]), ("day", 14, 15))
        by_key = {p["key"]: p for p in body["points"]}
        self.assertEqual((by_key["2026-09-22"]["outpassMinutes"], by_key["2026-09-22"]["teaMinutes"]), (30, 15))
        self.assertEqual((by_key["2026-09-25"]["outpassMinutes"], by_key["2026-09-25"]["teaMinutes"]), (150, 0))
        self.assertEqual((by_key["2026-09-29"]["outpassMinutes"], by_key["2026-09-29"]["teaMinutes"]), (0, 5))
        self.assertEqual(
            (by_key["2026-09-24"]["outpassMinutes"], by_key["2026-09-24"]["teaMinutes"]), (60, 0)
        )  # E4 on time
        self.assertEqual(sum(p["outpassMinutes"] for p in body["points"]), 325)
        self.assertEqual(sum(p["teaMinutes"] for p in body["points"]), 75)

    def test_a_long_period_is_rolled_up_to_weeks_without_losing_a_minute(self):
        body = self.json("time-lost", **{"from": "2026-07-01", "to": "2026-10-04"})
        self.assertEqual(body["granularity"], "week")
        self.assertEqual(sum(p["days"] for p in body["points"]), 96)
        totals = body["totals"]
        self.assertEqual(sum(p["outpassMinutes"] for p in body["points"]), totals["outpassMinutes"]["value"])
        self.assertEqual(sum(p["teaMinutes"] for p in body["points"]), totals["teaMinutes"]["value"])
        self.assertEqual(body["points"][0]["key"], "2026-06-29")  # the Monday of the first week

    def test_by_department_merges_both_kinds_and_drops_departments_with_nothing(self):
        body = self.json("time-lost")
        self.assertEqual(
            body["byDepartment"],
            [
                {"department": "Stitching", "outpassMinutes": 310, "teaMinutes": 70, "totalMinutes": 380},
                {"department": "Cutting", "outpassMinutes": 15, "teaMinutes": 5, "totalMinutes": 20},
            ],
        )  # Accounts: a rejected and a pending pass and one tea break on time
        self.assertEqual(body["departmentsTotal"], 2)
        short = self.json("time-lost", limit=1)
        self.assertEqual((len(short["byDepartment"]), short["departmentsTotal"]), (1, 2))
        self.assertEqual(sum(d["totalMinutes"] for d in body["byDepartment"]), 400)

    def test_the_kinds_of_outpass_are_listed_so_official_time_is_visible(self):
        reasons = {r["key"]: r["minutesOut"] for r in self.json("time-lost")["outpassByReason"]}
        # P3 150 + P8 15 official; P1, P2, P4, P5 personal; P11 states no type; the early dismissal never came back
        self.assertEqual(reasons, {"official": 165, "personal": 130, "unspecified": 30, "early_dismissal": None})

    def test_the_selection_narrows_both_sides(self):
        body = self.json("time-lost", department="Cutting")
        self.assertEqual((body["totals"]["outpassMinutes"]["value"], body["totals"]["teaMinutes"]["value"]), (15, 5))
        staff = self.json("time-lost", type="staff")  # Dev (rejected, pending, tea on time) and Farid (still out)
        self.assertEqual(
            (staff["totals"]["outpassMinutes"]["value"], staff["totals"]["teaMinutes"]["value"]), (None, 0)
        )

    def test_it_explains_the_two_different_measures(self):
        body = self.json("time-lost")
        entry = next(p for p in body["provenance"] if p["id"] == "time-lost")
        self.assertTrue(any("not the same kind of figure" in c for c in entry["caveats"]))
        self.assertIn("tea-minutes-lost", {p["id"] for p in body["provenance"]})

    def test_the_assistants_tool_gives_the_same_picture(self):
        with read_only_db():
            result = registry.collect_tools()["time_lost_comparison"].run(PERIOD)
        self.assertEqual(result["totals"]["togetherMinutes"]["value"], 400)
        self.assertLessEqual(len(result["byDepartment"]), 8)
        json.dumps(result)  # plain JSON


# ─── who may call it ──────────────────────────────────────────────────────────────────────────────────────────────


class AccessTests(MdApiTestCase):
    ROUTES = ("summary", "trend", "units", "visitors", "outpass", "exceptions", "activity", "day", "story", "time-lost")

    def setUp(self):
        super().setUp()
        self.admin = HRUser.objects.create(username="root", password_hash="x", is_super_admin=True)
        role = Role.objects.create(
            name="Wide", permissions={"employees": "edit", "reports": "edit", "outpass_visitors": "edit"}
        )
        self.clerk = HRUser.objects.create(username="clerk", password_hash="x", role=role)

    def test_only_the_md_gets_in(self):
        for route in self.ROUTES:
            url = BASE + route
            self.assertEqual(self.client.get(url).status_code, 401, route)
            for who in (self.admin, self.clerk):
                self.assertEqual(self.client.get(url, **md_headers(who)).status_code, 403, (route, who.username))
            self.assertIn(
                self.client.get(url, {"date": "2026-10-04"}, **md_headers(self.md)).status_code, (200,), route
            )

    def test_it_is_read_only(self):
        for route in self.ROUTES:
            for method in ("post", "put", "patch", "delete"):
                r = getattr(self.client, method)(BASE + route, **md_headers(self.md))
                self.assertEqual(r.status_code, 405, (route, method))

    def test_the_analytics_never_write(self):
        """Run every function against data inside the database's read-only guard: a write would raise."""
        branch = Branch.objects.create(name="RO", code="RO1")
        emp = make_employee("RO1", "Read", "Only", None, branch)
        make_pass(emp, ist(9, 22, 10), exited=ist(9, 22, 10, 10), entered=ist(9, 22, 10, 40))
        make_visit(Visitor.objects.create(name="RO", phone="7000000001"), ist(9, 22, 11), branch=branch)
        make_form(ist(9, 22, 12), emp=emp, branch=branch)
        scope = Scope()
        period = Period(date(2026, 9, 21), date(2026, 10, 4), "custom", "x")
        with mock.patch("api.md_portal.analytics.visitors._now", return_value=NOW), read_only_db():
            for fn in (
                A.summary,
                A.trend,
                A.visitors_breakdown,
                A.outpass_breakdown,
                A.exceptions,
                A.story,
                A.time_lost,
            ):
                self.assertIsInstance(fn(scope, period), dict, fn.__name__)
            self.assertIsInstance(A.story(scope, period, focus="visitors"), dict)
            self.assertIsInstance(A.activity(scope, period), dict)
            self.assertIsInstance(A.day_snapshot(scope, date(2026, 9, 22)), dict)
            self.assertIsInstance(A.insights(today=TODAY), list)
            self.assertIsInstance(A.headline(today=TODAY), dict)


# ─── speed: the number of queries does not grow with the data ─────────────────────────────────────────────────────


class ScaleTests(MdApiTestCase):
    """The heavy endpoints run a fixed number of queries however many rows there are, and stay fast on a factory-sized
    year (250 employees, 120 days)."""

    ENDPOINTS = ("summary", "trend", "units", "visitors", "outpass", "exceptions", "activity", "story", "time-lost")

    def setUp(self):
        super().setUp()
        patcher = mock.patch("api.md_portal.analytics.visitors._now", return_value=NOW)
        patcher.start()
        self.addCleanup(patcher.stop)
        self.branch = Branch.objects.create(name="Scale Unit", code="SU")
        self.depts = [Department.objects.create(name=f"Dept {i}", branch=self.branch) for i in range(8)]
        self.gate = GateDevice.objects.create(
            name="Gate", branch=self.branch, username="gs", password_hash="x", login_token="ts"
        )

    def grow(self, employees: int, days: int, passes_per_day: int, visits_per_day: int):
        emps = Employee.objects.bulk_create(
            [
                Employee(
                    employee_code=f"S{i}-{employees}-{days}",
                    first_name=f"First{i}",
                    last_name="Last",
                    department=self.depts[i % 8],
                    branch=self.branch,
                )
                for i in range(employees)
            ]
        )
        visitors = Visitor.objects.bulk_create(
            [
                Visitor(name=f"Visitor {i}", phone=f"{days}{employees}{i:05d}")
                for i in range(max(20, visits_per_day * 3))
            ]
        )
        passes, visits, forms, scans = [], [], [], []
        for d in range(days):
            day = ist(10, 4) - timedelta(days=d)
            for k in range(passes_per_day):
                at = day.replace(hour=9 + (k % 8), minute=(k * 7) % 60)
                kind = k % 5
                passes.append(
                    (
                        OutpassRequest(
                            employee=emps[(d * passes_per_day + k) % employees],
                            destination=f"Place {k}",
                            reason="r",
                            status="pending" if kind == 4 else ("rejected" if kind == 3 else "approved"),
                            pass_type=("personal", "official", "early_dismissal", None)[k % 4],
                            approved_at=at + timedelta(minutes=10) if kind < 3 else None,
                            exited_at=at + timedelta(minutes=15) if kind < 2 else None,
                            entered_at=at + timedelta(minutes=15 + 20 * (k % 9)) if kind == 0 else None,
                        ),
                        at,
                    )
                )
            for k in range(visits_per_day):
                visits.append(
                    (
                        VisitorVisit(
                            visitor=visitors[(d * 3 + k) % len(visitors)],
                            branch=self.branch,
                            whom_to_meet=f"Host {k % 6}",
                            purpose=("Sales demo", "Courier", "Interview", "Audit", "xyz abc")[k % 5],
                            meeting_employee=emps[k % employees] if k % 2 else None,
                        ),
                        day.replace(hour=7 + (k * 3) % 13, minute=k % 60),
                    )
                )
            record = OutpassRecord(
                branch=self.branch, employee=emps[d % employees], employee_name="n", employee_code="c", destination="h"
            )
            forms.append((record, day.replace(hour=13)))
            for k in range(3):
                scan = OutpassGateScan(
                    gate=self.gate,
                    employee=emps[(d + k) % employees],
                    scan_type="exit" if k < 2 else "entry",
                    result=("success", "expired", "not_approved")[(d + k) % 3],
                    message="m",
                )
                scans.append((scan, day.replace(hour=10 + k)))
        # created_at, visited_at and submitted_at are auto_now_add: bulk_create stamps "now", so set the real time after
        for model, field, rows in (
            (OutpassRequest, "created_at", passes),
            (VisitorVisit, "visited_at", visits),
            (OutpassRecord, "submitted_at", forms),
            (OutpassGateScan, "scanned_at", scans),
        ):
            made = model.objects.bulk_create([obj for obj, _ in rows])
            for obj, (_, at) in zip(made, rows):
                setattr(obj, field, at)
            model.objects.bulk_update(made, [field], batch_size=500)

    def queries(self, endpoint: str, frm: str = "2026-09-05") -> int:
        with CaptureQueriesContext(connection) as ctx:
            r = self.get(BASE + endpoint, **{"from": frm, "to": "2026-10-04"})
        self.assertEqual(r.status_code, 200, (endpoint, r.content))
        return len(ctx)

    def test_the_query_count_does_not_grow_with_the_data(self):
        """Compared over the same last 30 days, with every kind of finding present in both datasets (an empty list
        skips its follow-up query, which is a fixed cost and not growth): five times the rows, the same queries."""
        self.grow(employees=40, days=40, passes_per_day=5, visits_per_day=5)
        small = {e: self.queries(e) for e in self.ENDPOINTS}
        self.grow(employees=120, days=100, passes_per_day=25, visits_per_day=15)
        large = {e: self.queries(e) for e in self.ENDPOINTS}
        self.assertEqual(small, large)
        for endpoint, n in large.items():
            self.assertLessEqual(n, 40, endpoint)  # a ceiling too, so one never becomes a loop in disguise

    def test_a_factory_year_answers_fast(self):
        self.grow(employees=250, days=120, passes_per_day=25, visits_per_day=15)  # 3,000 passes, 1,800 visits
        params = {"from": "2026-06-07", "to": "2026-10-04"}
        body = self.get(BASE + "summary", **params).json()
        self.assertEqual(body["outpass"]["requests"]["value"], 3000)  # the data is really there
        self.assertEqual(body["visitors"]["visits"]["value"], 1800)
        for endpoint in self.ENDPOINTS:
            started = clock.monotonic()
            r = self.get(BASE + endpoint, **params)
            took = clock.monotonic() - started
            self.assertEqual(r.status_code, 200, endpoint)
            self.assertLess(took, 1.5, f"{endpoint} took {took:.2f}s")  # the target from the brief

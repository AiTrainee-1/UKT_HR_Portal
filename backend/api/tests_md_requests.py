"""MD portal, Requests: every figure recomputed by hand from a small company.

Run:  DB_TEST_NAME=test_uktex_md_requests python manage.py test api.tests_md_requests --noinput

THE WORLD ("now" is Friday 20 Nov 2026 12:00 Indian time; W = Mon 9 .. Sun 15 Nov is measured, P = 2 .. 8 Nov before it)

    Unit A   Stitching: E1 Asha, E2 Bala (staff), E4 Dev (production)      Cutting: E3 Chitra (staff)
    Head Office  Accounts: E5 Esha (staff)
    Every pipeline is the HRMS default: leave / permission / casual leave one step "HOD or HR"; missing punch HOD then HR;
    on-duty punch, other requests and advances HR only; compensation claims the Department Head only.

WAITING NOW (any date)                                  age     band       waits on        HR can act
    w1 leave E1          made Fri 20 Nov 06:00             6 h     under 1 d  either          yes
    w2 missing punch E2  made Wed 18 Nov 12:00 (HOD step)  48 h    1-3 d      Department Head no
    w3 missing punch E3  made Mon 16 Nov 12:00 (HOD done)  96 h    3-7 d      HR              yes
    w4 other request E5  made Tue 10 Nov 12:00 (in review) 240 h   7 d+       HR              yes   <- oldest
    w5 claim E1          made Thu 19 Nov 12:00             24 h    1-3 d      Department Head no    (edge: 24 h is 1-3 d)
    w6 advance E2 30,000 made Fri 13 Nov 12:00             168 h   7 d+       HR              yes   (edge: 7 d is 7 d+)
    w7 on-duty punch E3  made Fri 20 Nov 11:00             1 h     under 1 d  HR              yes
    w8 permission E4     made Thu 19 Nov 18:00             18 h    under 1 d  either          yes
  -> 8 waiting: HR 4, Department Head 2, either 2; HR can act on 6; bands 3 / 2 / 1 / 2; 3 days or more = 3.

DECIDED
    d1 leave E1       made Mon 9 Nov 09:00, approved by HR (Priya) Mon 9 Nov 13:00               4 h
    d2 permission E2  made Tue 10 Nov 10:00, rejected by the HOD Wed 11 Nov 10:00 "Too many  permissions"   24 h
    d3 casual E3      made Thu 12 Nov 08:00, rejected Thu 12 Nov 20:00 "too many permissions"     12 h
    d4 advance E5     made Sat 14 Nov 10:00, approved Sun 15 Nov 10:00 for 15,000 of 20,000 asked  24 h  (partial)
    d5 leave E2       made Tue 3 Nov 10:00 (P), rejected Tue 10 Nov 10:00 with no reason          168 h
    p1 leave E1       made Wed 4 Nov 10:00, approved Wed 4 Nov 12:00                               (decided in P)
    p2 permission E5  made Thu 5 Nov 10:00, rejected Fri 6 Nov 10:00 "Not needed"                 (decided in P)
    o1 leave E3       made Mon 16 Nov 00:00:00, approved Mon 16 Nov 10:00                          (after W)

    Submitted in W: w4, w6, d1, d2, d3, d4 = 6 (P: d5, p1, p2 = 3).
    Decided in W: d1, d2, d3, d4, d5 = 5: approved 2 (40 %), rejected 3 (60 %); hours 4, 12, 24, 24, 168 -> median 24,
    90th percentile 24 + 0.6 x 144 = 110.4; within a day (< 24 h) 2 of 5 = 40 %. Decided in P: p1, p2 = 2.
    Rejections in W: 3, with a reason 2 (one reason, "too many permissions", written two ways), without 1; P: 1.
"""

from datetime import date, datetime
from datetime import time as dtime
from decimal import Decimal
from unittest import mock

from django.db import connection
from django.test.utils import CaptureQueriesContext

from .clock import FACTORY_TZ
from .md_portal.analytics import requests as R
from .md_portal.common import MdParamError, Scope, read_only_db, resolve_period
from .models import (
    Advance,
    Branch,
    CasualLeaveRequest,
    Department,
    Employee,
    EmployeePermission,
    EmployeeRequest,
    HolidayWorkClaim,
    LeaveRequest,
    MissingPunchRequest,
    OnDutyPunchVerification,
    OnDutySession,
)
from .tests_md_support import MdApiTestCase

BASE = "/api/md/requests"
W = {"from": "2026-11-09", "to": "2026-11-15"}
NOW = datetime(2026, 11, 20, 12, 0, tzinfo=FACTORY_TZ)
ROUTES = [
    "summary",
    "waiting",
    "turnaround",
    "breakdown",
    "trend",
    "bottlenecks",
    "unusual",
    "rejections",
    "attention",
    "list",
]


def ist(month, day, hh=0, mm=0, ss=0):
    return datetime(2026, month, day, hh, mm, ss, tzinfo=FACTORY_TZ)


def stamp(obj, when: datetime):
    type(obj).objects.filter(pk=obj.pk).update(created_at=when)


def trail(role, decision, when: datetime, by="Priya", comment=None) -> list[dict]:
    entry = {"role": role, "decision": decision, "by": by, "at": when.isoformat()}
    if comment is not None:
        entry["comment"] = comment
    return [entry]


def make_employee(code, first, dept, branch, kind="staff") -> Employee:
    return Employee.objects.create(
        employee_code=code,
        first_name=first,
        last_name="Test",
        department=dept,
        branch=branch,
        employment_type=kind,
        join_date="2025-01-01",
    )


def leave(emp, made, status="pending", tr=None, start="2026-11-17", end="2026-11-18", **kw):
    row = LeaveRequest.objects.create(
        employee=emp,
        start_date=start,
        end_date=end,
        type="casual",
        total_days=2,
        status=status,
        approval_trail=tr,
        **kw,
    )
    stamp(row, made)
    return row


def build_world(cls):
    cls.unit_a = Branch.objects.create(name="Unit A", code="RA")
    cls.head_office = Branch.objects.get(code="HO")  # a migration seeds the Head Office branch
    cls.stitching = Department.objects.create(name="Stitching", branch=cls.unit_a)
    cls.cutting = Department.objects.create(name="Cutting", branch=cls.unit_a)
    cls.accounts = Department.objects.create(name="Accounts", branch=cls.head_office)
    e1 = cls.e1 = make_employee("R001", "Asha", cls.stitching, cls.unit_a)
    e2 = cls.e2 = make_employee("R002", "Bala", cls.stitching, cls.unit_a)
    e3 = cls.e3 = make_employee("R003", "Chitra", cls.cutting, cls.unit_a)
    e4 = cls.e4 = make_employee("R004", "Dev", cls.stitching, cls.unit_a, "production")
    e5 = cls.e5 = make_employee("R005", "Esha", cls.accounts, cls.head_office)

    # waiting now
    cls.w1 = leave(e1, ist(11, 20, 6), tr=[])
    cls.w2 = MissingPunchRequest.objects.create(
        employee=e2,
        date=date(2026, 11, 17),
        punch_time=dtime(9, 5),
        punch_type="IN",
        reason="forgot",
        status="pending_hod",
    )
    stamp(cls.w2, ist(11, 18, 12))
    cls.w3 = MissingPunchRequest.objects.create(
        employee=e3,
        date=date(2026, 11, 14),
        punch_time=dtime(18, 0),
        punch_type="OUT",
        reason="card failed",
        status="pending_hr",
        approval_trail=trail("hod", "approved", ist(11, 17, 9), by="Head Kumar"),
    )
    stamp(cls.w3, ist(11, 16, 12))
    cls.w4 = EmployeeRequest.objects.create(
        employee=e5, request_type="general", subject="Salary letter", description="For a bank loan", status="in_review"
    )
    stamp(cls.w4, ist(11, 10, 12))
    cls.w5 = HolidayWorkClaim.objects.create(employee=e1, work_date=date(2026, 11, 15), shifts=Decimal("0.5"))
    stamp(cls.w5, ist(11, 19, 12))
    cls.w6 = Advance.objects.create(employee=e2, advance_type="general", amount=Decimal("30000"), status="pending")
    stamp(cls.w6, ist(11, 13, 12))
    session = OnDutySession.objects.create(employee=e3, destination="Buyer office", status="completed")
    stamp(session, ist(10, 1, 9))
    cls.w7 = OnDutyPunchVerification.objects.create(
        session=session,
        employee=e3,
        punch_date=date(2026, 11, 20),
        punch_time=dtime(10, 55),
        punch_type="IN",
        punch_number=1,
        latitude=Decimal("11.1"),
        longitude=Decimal("77.3"),
        photo="x.jpg",
    )
    stamp(cls.w7, ist(11, 20, 11))
    cls.w8 = EmployeePermission.objects.create(
        employee=e4, date=date(2026, 11, 19), type="morning_late_in", approval_trail=[]
    )
    stamp(cls.w8, ist(11, 19, 18))

    # decided
    cls.d1 = leave(e1, ist(11, 9, 9), "approved", trail("hr", "approved", ist(11, 9, 13)))
    cls.d2 = EmployeePermission.objects.create(
        employee=e2,
        date=date(2026, 11, 10),
        type="evening_early_out",
        status="rejected",
        approval_trail=trail("hod", "rejected", ist(11, 11, 10), by="Head Kumar", comment="Too many  permissions"),
    )
    stamp(cls.d2, ist(11, 10, 10))
    cls.d3 = CasualLeaveRequest.objects.create(
        employee=e3,
        date=date(2026, 11, 13),
        status="rejected",
        approval_trail=trail("hr", "rejected", ist(11, 12, 20), comment="too many permissions"),
    )
    stamp(cls.d3, ist(11, 12, 8))
    cls.d4 = Advance.objects.create(
        employee=e5,
        advance_type="term",
        amount=Decimal("15000"),
        requested_amount=Decimal("20000"),
        status="approved",
        approved_by="Priya",
        decided_at=ist(11, 15, 10),
    )
    stamp(cls.d4, ist(11, 14, 10))
    cls.d5 = leave(e2, ist(11, 3, 10), "rejected", trail("hr", "rejected", ist(11, 10, 10)))
    cls.p1 = leave(e1, ist(11, 4, 10), "approved", trail("hr", "approved", ist(11, 4, 12)))
    cls.p2 = EmployeePermission.objects.create(
        employee=e5,
        date=date(2026, 11, 5),
        type="middle_permission",
        status="rejected",
        approval_trail=trail("hr", "rejected", ist(11, 6, 10), comment="Not needed"),
    )
    stamp(cls.p2, ist(11, 5, 10))
    cls.o1 = leave(e3, ist(11, 16, 0, 0, 0), "approved", trail("hr", "approved", ist(11, 16, 10)))


class World(MdApiTestCase):
    @classmethod
    def setUpTestData(cls):
        build_world(cls)

    def setUp(self):
        super().setUp()
        patcher = mock.patch.object(R, "now_utc", return_value=NOW)
        patcher.start()
        self.addCleanup(patcher.stop)

    def api(self, name, params=None, **extra):
        r = self.get(f"{BASE}/{name}", **(W if params is None else params), **extra)
        self.assertEqual(r.status_code, 200, r.content)
        return r.json()


def values(metrics, *keys):
    return tuple((metrics[k]["value"], metrics[k]["previous"]) for k in keys)


class KindsTests(World):
    def test_the_twelve_kinds_of_the_requests_hub(self):
        self.assertEqual(
            R.KIND_KEYS,
            (
                "leave",
                "permission",
                "casual_leave",
                "missing_punch",
                "on_duty",
                "on_duty_punch",
                "outpass",
                "request",
                "resignation",
                "attendance_correction",
                "holiday_work",
                "advance",
            ),
        )
        # the HR page lists every kind now, so "page" is every kind
        self.assertEqual(R.kind_keys("page"), R.KIND_KEYS)
        self.assertEqual(R.KIND_BY_KEY["holiday_work"].label, "Compensation claims")
        with self.assertRaises(MdParamError):
            R.kind_keys("lunch")

    def test_every_compensation_claim_kind_counts(self):
        birthday = HolidayWorkClaim.objects.create(
            employee=self.e3, work_date=date(2026, 11, 18), shifts=Decimal("1"), kind="birthday"
        )
        stamp(birthday, ist(11, 19, 9))
        w = self.api("waiting", {}, kind="holiday_work")
        self.assertEqual((w["total"], w["byKind"][0]["label"]), (2, "Compensation claims"))


class SummaryTests(World):
    def test_waiting_now(self):
        w = self.api("summary")["waiting"]
        self.assertEqual(
            (w["total"], w["withHr"], w["withDepartmentHead"], w["withEither"], w["hrCanDecide"], w["mdCanDecide"]),
            (8, 4, 2, 2, 6, 6),
        )
        self.assertEqual([b["count"] for b in w["buckets"]], [3, 2, 1, 2])
        self.assertEqual(
            (w["threeDaysPlus"], w["sevenDaysPlus"], w["oldestDays"], w["oldestKind"]), (3, 2, 10.0, "request")
        )
        self.assertEqual(w["advanceAmount"], 30000.0)

    def test_the_period_in_numbers(self):
        m = self.api("summary")["metrics"]
        self.assertEqual(values(m, "submitted", "decided", "approved", "rejected"), ((6, 3), (5, 2), (2, 1), (3, 1)))
        self.assertEqual(values(m, "approvalPct", "rejectionPct"), ((40.0, 50.0), (60.0, 50.0)))
        self.assertEqual(m["medianHours"]["value"], 24.0)
        self.assertEqual(m["p90Hours"]["value"], 110.4)
        self.assertEqual(m["withinDayPct"]["value"], 40.0)

    def test_the_briefing_speaks_of_hr_and_department_heads_never_of_the_md_deciding(self):
        sentences = self.api("summary")["briefing"]["sentences"]
        self.assertEqual(
            sentences[0]["text"],
            "8 requests are waiting for a decision: 4 with HR, 2 with Department Heads and 2 that HR or the Department "
            "Head can decide. HR can act on 6 of them now.",
        )
        self.assertNotIn("You can decide", " ".join(s["text"] for s in sentences))

    def test_a_whole_month_is_one_period(self):
        s = self.api("summary", {"month": "2026-11"})
        self.assertEqual(
            (s["period"]["start"], s["period"]["end"], s["period"]["label"]), ("2026-11-01", "2026-11-30", "Nov 2026")
        )
        # made in November: every request but the October on-duty session (which is no request waiting)
        self.assertEqual(s["metrics"]["submitted"]["value"], 16)

    def test_an_empty_company_says_null_not_zero(self):
        for model in (LeaveRequest, EmployeePermission, CasualLeaveRequest, MissingPunchRequest, EmployeeRequest):
            model.objects.all().delete()
        HolidayWorkClaim.objects.all().delete()
        Advance.objects.all().delete()
        OnDutyPunchVerification.objects.all().delete()
        s = self.api("summary")
        self.assertEqual(s["waiting"]["total"], 0)
        self.assertIsNone(s["waiting"]["oldestHours"])
        self.assertIsNone(s["metrics"]["approvalPct"]["value"])
        self.assertIsNone(s["metrics"]["medianHours"]["value"])
        self.assertEqual(s["briefing"]["sentences"][0]["text"], "Nothing is waiting for a decision right now.")
        rj = self.api("rejections")
        self.assertEqual((rj["rejected"]["value"], rj["reasons"]), (0, []))


class ScopeTests(World):
    def test_staff_only_leaves_the_production_permission_out(self):
        self.assertEqual(self.api("summary", type="staff")["waiting"]["total"], 7)

    def test_a_unit(self):
        self.assertEqual(self.api("summary", branch=str(self.head_office.id))["waiting"]["total"], 1)

    def test_a_department(self):
        s = self.api("summary", department="Stitching")
        self.assertEqual((s["waiting"]["total"], s["metrics"]["submitted"]["value"]), (5, 3))

    def test_the_period_edges_are_indian_days(self):
        # o1 was made at the first instant of 16 Nov: not in W, in a period that starts on the 16th
        self.assertEqual(
            self.api("summary", {"from": "2026-11-16", "to": "2026-11-16"})["metrics"]["submitted"]["value"], 2
        )


class RejectionTests(World):
    def test_reasons_written_two_ways_are_one_reason(self):
        rj = self.api("rejections")
        self.assertEqual(values({"r": rj["rejected"]}, "r"), ((3, 1),))
        self.assertEqual((rj["withReason"], rj["withoutReason"]), (2, 1))
        self.assertEqual(len(rj["reasons"]), 1)
        top = rj["reasons"][0]
        self.assertEqual(
            (top["key"], top["reason"], top["count"], top["sharePct"]),
            ("too many permissions", "Too many  permissions", 2, 100.0),
        )
        self.assertEqual([k["key"] for k in top["kinds"]], ["casual_leave", "permission"])
        by_kind = {r["key"]: (r["rejected"], r["decided"], r["withReason"]) for r in rj["byKind"]}
        self.assertEqual(by_kind, {"leave": (1, 2, 0), "permission": (1, 1, 1), "casual_leave": (1, 1, 1)})
        self.assertIn("1 of the 3 rejections in this period has no reason recorded", rj["notes"][0])


class ListTests(World):
    def items(self, **params):
        body = self.api("list", **params)
        return body, [i["key"] for i in body["items"]]

    def test_waiting_oldest_first_with_who_it_waits_on(self):
        body, keys = self.items(status="waiting")
        self.assertEqual(body["total"], 8)
        self.assertEqual(keys[:3], [f"request-{self.w4.id}", f"advance-{self.w6.id}", f"missing_punch-{self.w3.id}"])
        first = body["items"][0]
        self.assertEqual(
            (first["holder"], first["band"], first["ageHours"], first["requested"]), ("hr", "over_7d", 240.0, None)
        )
        self.assertEqual(
            (first["what"], first["reason"], first["reasonLabel"]),
            ("General Query · Salary letter", "For a bank loan", "Description"),
        )

    def test_filters(self):
        self.assertEqual(self.items(status="waiting", holder="hod")[0]["total"], 2)
        self.assertEqual(self.items(status="waiting", holder="either")[0]["total"], 2)
        self.assertEqual(self.items(status="waiting", band="over_7d")[0]["total"], 2)
        self.assertEqual(self.items(status="waiting", band="1_3d")[0]["total"], 2)
        self.assertEqual(self.items(status="waiting", band="aged")[0]["total"], 3)
        self.assertEqual(self.items(status="waiting", dept="Stitching")[0]["total"], 5)
        self.assertEqual(self.items(status="waiting", employee=str(self.e1.id))[0]["total"], 2)
        self.assertEqual(self.items(status="submitted", kind="leave")[1], [f"leave-{self.d1.id}"])
        self.assertEqual(self.items(status="decided", approver="Head Kumar")[1], [f"permission-{self.d2.id}"])

    def test_rejected_with_their_reasons_newest_decision_first(self):
        body, keys = self.items(status="rejected")
        self.assertEqual(keys, [f"casual_leave-{self.d3.id}", f"permission-{self.d2.id}", f"leave-{self.d5.id}"])
        self.assertEqual(
            [i["decisionRemark"] for i in body["items"]], ["too many permissions", "Too many  permissions", None]
        )
        self.assertEqual(self.items(status="rejected", reason="Too many permissions")[0]["total"], 2)

    def test_what_was_asked_and_for_when(self):
        body, _ = self.items(status="decided", kind="leave,casual_leave,advance")
        by_key = {i["key"]: i for i in body["items"]}
        d1 = by_key[f"leave-{self.d1.id}"]
        self.assertEqual(
            d1["requested"],
            {
                "from": "2026-11-17",
                "to": "2026-11-18",
                "note": "2 days",
                "label": "Requested dates",
                "precision": "day",
            },
        )
        self.assertEqual(
            (d1["decidedBy"], d1["decisionHours"], d1["submittedAt"]), ("Priya", 4.0, "2026-11-09T09:00:00")
        )
        d3 = by_key[f"casual_leave-{self.d3.id}"]
        self.assertEqual(d3["requested"]["note"], "full day")
        d4 = by_key[f"advance-{self.d4.id}"]
        self.assertEqual((d4["amount"], d4["requestedAmount"], d4["partial"]), (15000.0, 20000.0, True))

    def test_paging(self):
        body = self.api("list", status="waiting", pageSize=3, page=3)
        self.assertEqual((body["total"], body["pages"], len(body["items"])), (8, 3, 2))
        past = self.api("list", status="waiting", pageSize=3, page=9)
        self.assertEqual((past["total"], past["items"]), (8, []))

    def test_bad_parameters_are_400(self):
        for params in ({"status": "lost"}, {"holder": "boss"}, {"status": "decided", "holder": "hr"}, {"band": "old"}):
            r = self.get(f"{BASE}/list", **W, **params)
            self.assertEqual(r.status_code, 400, params)

    def test_the_number_of_queries_does_not_grow_with_the_rows(self):
        def count():
            with CaptureQueriesContext(connection) as ctx:
                self.api("list", status="waiting")
            return len(ctx.captured_queries)

        before = count()
        for i in range(6):
            leave(self.e2, ist(11, 19, 8, i), tr=[])
            EmployeeRequest.objects.create(employee=self.e3, request_type="general", subject=f"s{i}", description="d")
        self.assertEqual(count(), before)


class UnusualTests(World):
    def test_large_and_partly_approved_advances(self):
        adv = self.api("unusual")["largeAdvances"]
        self.assertEqual((adv["total"], adv["waiting"], adv["waitingAmount"]), (1, 1, 30000.0))
        self.assertEqual(adv["partial"], {"count": 1, "requested": 20000.0, "granted": 15000.0})


class RouteTests(World):
    def test_every_route_answers_with_provenance(self):
        for name in ROUTES:
            body = self.api(name)
            self.assertIn("provenance", body, name)

    def test_only_the_md_gets_in(self):
        r = self.client.get(f"{BASE}/summary")
        self.assertIn(r.status_code, (401, 403))

    def test_the_analytics_run_read_only(self):
        with read_only_db():
            p = resolve_period(W)
            R.requests_summary(Scope(), p)
            R.requests_list(Scope(), p, status="rejected")
            R.requests_rejections(Scope(), p)

    def test_the_dashboard_cards_say_who_holds_requests(self):
        kpis = R.headline(today=NOW.date())["kpis"]
        self.assertEqual(kpis[0]["id"], "requests.waiting")
        self.assertEqual(kpis[0]["sub"].split(" · ")[:2], ["6 with HR", "2 with Department Heads"])


class AttentionTests(World):
    def test_old_requests_are_flagged_with_who_can_act(self):
        items = {i["id"]: i for i in self.api("attention")["items"]}
        aging = items["requests.aging"]
        self.assertEqual(aging["title"], "3 requests have waited 3 days or more")
        self.assertEqual(aging["severity"], "critical")  # two have waited 7 days or more
        self.assertIn("(HR can decide them now)", aging["detail"])

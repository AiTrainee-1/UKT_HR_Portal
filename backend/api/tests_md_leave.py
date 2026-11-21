"""MD portal, Leave & Holiday: every figure recomputed by hand from a small company.

Run:  DB_TEST_NAME=test_uktex_md_leave python manage.py test api.tests_md_leave --noinput

THE WORLD (today is Friday 20 Nov 2026; W = Mon 9 .. Sun 15 Nov is measured, P = Mon 2 .. Sun 8 Nov before it)

    Unit A   Stitching: E1 Asha, E2 Bala (staff), E4 Dev (production)      Cutting: E3 Chitra (staff)
    Head Office  Accounts: E5 Esha (staff)          -> 4 active staff (production has no leave)
    Holiday: Wed 11 Nov.  Working days of W: Mon 9 .. Sat 14 less the holiday = 5; of P: Mon 2 .. Sat 7 = 6.

LEAVE REQUESTS (dates are text)                                        reason    applied   days in W
    L1 E1 approved Mon 9 - Wed 11 (3 days)                              sick      Thu 5     3   (holiday not skipped)
    L2 E2 approved half day (morning) Fri 13                            personal  Fri 13    0.5 (short notice)
    L3 E3 approved Sat 14 - Tue 17 (Sun 15 skipped)                      emergency Sat 14    1   (short notice; clipped)
    L4 E4 approved Tue 10 (production: not counted)                               Sun 1
    L5 E5 rejected Thu 12 "Busy month"                                            Tue 10
    L6 E2 pending Mon 23 - Tue 24                                                 Thu 12    (waiting 8 days)
    L7 E1 approved Tue 3 (1 day)                                                  Mon 2     (P: 1)
CASUAL LEAVE
    C1 E3 approved Thu 12, full day                                                         1
    C2 E5 approved Fri 13, first half                                                       0.5
    C3 E1 approved Mon 28 Sep, given by HR on the Carry Forward tab (counts against 2026 whatever its date)
    C4 E2 pending Wed 25, second half
  -> W: 6 leave days by 4 people; rate 6 / (4 x 5) = 30 %; 1.5 a head.  P: 1 day by 1 person; 1 / (4 x 6) = 4.2 %.
  -> reason groups in W: Sick Leave 3, Casual leave 1.5, Emergency 1, Personal 0.5.
  -> applied in W: L2, L3, L5, L6 = 4 (approved 2, rejected 1, waiting 1; rejection 1 of 3 = 33.3 %; short notice 2 of 4).
  -> Casual Leave 2026 (12 each from 2 Nov): E1 used 1 (carry forward), E2 waiting 0.5, E3 used 1, E5 used 0.5:
     used 2.5 of 48 (5.2 %), waiting 0.5, 2 half days.
PERMISSIONS (monthly cap 3)
    E1 approved Mon 2, Wed 4, Fri 6 (P, within) and Tue 10, Thu 12 (W: the 4th and 5th of November: over the cap)
    E2 approved Wed 11 (Morning Late-In, within), rejected Fri 13 "No reason given"; E3 waiting Sat 14 (Middle One-Hour)
  -> W: 5 asked, 3 approved, 1 rejected, 1 waiting, 2 over the cap (66.7 % of approved), 3 people; P: 3 asked, 0 over.
"""

from datetime import date, datetime
from unittest import mock

from django.db import connection
from django.test.utils import CaptureQueriesContext

from .clock import FACTORY_TZ
from .md_portal.analytics import leave as L
from .md_portal.analytics import leave_data as D
from .md_portal.common import Scope, read_only_db, resolve_period
from .models import Branch, CasualLeaveRequest, Department, Employee, EmployeePermission, Holiday, LeaveRequest
from .tests_md_support import MdApiTestCase

BASE = "/api/md/leave"
TODAY = date(2026, 11, 20)
W = {"from": "2026-11-09", "to": "2026-11-15"}
ROUTES = [
    "summary",
    "briefing",
    "trend",
    "groups",
    "today",
    "balances",
    "permissions",
    "patterns",
    "holidays",
    "approvals",
    "attention",
    "list",
]


def ist(month, day, hh=9):
    return datetime(2026, month, day, hh, 0, tzinfo=FACTORY_TZ)


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


def leave(emp, start, end, status, made, total=1, **kw):
    row = LeaveRequest.objects.create(
        employee=emp, start_date=start, end_date=end, type="casual", total_days=total, status=status, **kw
    )
    LeaveRequest.objects.filter(pk=row.pk).update(created_at=made)
    return row


def casual(emp, day, status="approved", portion="full", trail=None):
    return CasualLeaveRequest.objects.create(
        employee=emp, date=day, status=status, portion=portion, approval_trail=trail
    )


def permission(emp, day, status, kind, comment=None):
    trail = None
    if comment:
        trail = [
            {"role": "hr", "decision": status, "by": "Priya", "at": ist(11, 13, 18).isoformat(), "comment": comment}
        ]
    return EmployeePermission.objects.create(employee=emp, date=day, status=status, type=kind, approval_trail=trail)


def build_world(cls):
    cls.unit_a = Branch.objects.create(name="Unit A", code="LA")
    cls.head_office = Branch.objects.get(code="HO")
    cls.stitching = Department.objects.create(name="Stitching", branch=cls.unit_a)
    cls.cutting = Department.objects.create(name="Cutting", branch=cls.unit_a)
    cls.accounts = Department.objects.create(name="Accounts", branch=cls.head_office)
    e1 = cls.e1 = make_employee("L001", "Asha", cls.stitching, cls.unit_a)
    e2 = cls.e2 = make_employee("L002", "Bala", cls.stitching, cls.unit_a)
    e3 = cls.e3 = make_employee("L003", "Chitra", cls.cutting, cls.unit_a)
    e4 = cls.e4 = make_employee("L004", "Dev", cls.stitching, cls.unit_a, "production")
    e5 = cls.e5 = make_employee("L005", "Esha", cls.accounts, cls.head_office)
    Holiday.objects.create(name="Test Holiday", date=date(2026, 11, 11))

    cls.l1 = leave(e1, "2026-11-09", "2026-11-11", "approved", ist(11, 5), total=3, reason_category="sick")
    cls.l2 = leave(
        e2,
        "2026-11-13",
        "2026-11-13",
        "approved",
        ist(11, 13, 8),
        total=0.5,
        is_half_day=True,
        half_day_slot="morning",
        reason_category="personal",
    )
    cls.l3 = leave(e3, "2026-11-14", "2026-11-17", "approved", ist(11, 14, 8), total=3, reason_category="emergency")
    cls.l4 = leave(e4, "2026-11-10", "2026-11-10", "approved", ist(11, 1))
    cls.l5 = leave(
        e5,
        "2026-11-12",
        "2026-11-12",
        "rejected",
        ist(11, 10),
        approval_trail=[
            {
                "role": "hr",
                "decision": "rejected",
                "by": "Priya",
                "at": ist(11, 11).isoformat(),
                "comment": "Busy month",
            }
        ],
    )
    cls.l6 = leave(e2, "2026-11-23", "2026-11-24", "pending", ist(11, 12), total=2, approval_trail=[])
    cls.l7 = leave(e1, "2026-11-03", "2026-11-03", "approved", ist(11, 2))

    casual(e3, date(2026, 11, 12))
    casual(e5, date(2026, 11, 13), portion="first_half")
    casual(e1, date(2026, 9, 28), trail=[{"role": "hr", "decision": "approved", "via": "carry_forward", "by": "Priya"}])
    casual(e2, date(2026, 11, 25), status="pending", portion="second_half")

    for day in (2, 4, 6, 10, 12):
        permission(e1, date(2026, 11, day), "approved", "evening_early_out")
    permission(e2, date(2026, 11, 11), "approved", "morning_late_in")
    permission(e2, date(2026, 11, 13), "rejected", "evening_early_out", comment="No reason given")
    permission(e3, date(2026, 11, 14), "pending", "middle_permission")


class World(MdApiTestCase):
    @classmethod
    def setUpTestData(cls):
        build_world(cls)

    def setUp(self):
        super().setUp()
        patcher = mock.patch.object(D, "ist_today", return_value=TODAY)
        patcher.start()
        self.addCleanup(patcher.stop)

    def api(self, name, params=None, **extra):
        r = self.get(f"{BASE}/{name}", **(W if params is None else params), **extra)
        self.assertEqual(r.status_code, 200, r.content)
        return r.json()


def values(metrics, *keys):
    return tuple((metrics[k]["value"], metrics[k]["previous"]) for k in keys)


class SummaryTests(World):
    def test_the_week_in_numbers(self):
        s = self.api("summary")
        m = s["metrics"]
        self.assertEqual(values(m, "leaveDays", "employeesOnLeave"), ((6.0, 1.0), (4, 1)))
        self.assertEqual(values(m, "leaveRatePct", "daysPerEmployee"), ((30.0, 4.2), (1.5, 0.25)))
        self.assertEqual(values(m, "applied", "rejectionPct", "shortNoticePct"), ((4, 2), (33.3, 0.0), (50.0, 0.0)))
        self.assertEqual((s["eligibleHeadcount"], s["workingDays"]), (4, 5))
        self.assertEqual((s["pending"]["count"], s["pending"]["oldestDays"]), (1, 8))
        self.assertTrue(any("production employees are not counted" in n for n in s["notes"]))

    def test_a_half_day_of_casual_leave_is_half_a_day(self):
        days = self.api("list", what="days", leaveType="Casual leave")
        self.assertEqual(sorted(i["daysInPeriod"] for i in days["items"]), [0.5, 1.0])

    def test_a_whole_month(self):
        s = self.api("summary", {"month": "2026-11"})
        self.assertEqual((s["period"]["label"], s["metrics"]["leaveDays"]["value"]), ("Nov 2026", 9.0))
        self.assertTrue(any("runs past today" in n for n in s["notes"]))

    def test_scope(self):
        self.assertEqual(self.api("summary", department="Stitching")["metrics"]["leaveRatePct"]["value"], 35.0)
        production = self.api("summary", type="production")
        self.assertEqual(production["metrics"]["leaveDays"]["value"], 0)
        self.assertTrue(any("not applied to production employees" in n for n in production["notes"]))


class GroupTests(World):
    def test_by_the_reason_the_employee_picked(self):
        rows = self.api("groups", by="reason")["rows"]
        self.assertEqual(
            [(r["label"], r["leaveDays"]) for r in rows],
            [
                ("Sick Leave", 3.0),
                ("Casual leave", 1.5),
                ("Emergency", 1.0),
                ("Personal", 0.5),
                ("Reason not picked", 0.0),
            ],
        )

    def test_casual_leave_is_one_type(self):
        rows = {r["label"]: r["leaveDays"] for r in self.api("groups", by="type")["rows"]}
        self.assertEqual(rows["Casual leave"], 1.5)


class BalanceTests(World):
    def test_casual_leave_has_its_own_twelve_day_year(self):
        c = self.api("balances", {})["casual"]
        self.assertEqual((c["entitlement"], c["employees"], c["used"], c["pending"]), (12, 4, 2.5, 0.5))
        self.assertEqual((c["usedPct"], c["halfDays"], c["exhausted"], c["low"]), (5.2, 2, 0, 0))
        self.assertEqual(c["carryForward"], {"employees": 1, "days": 1.0})
        self.assertEqual(c["since"], "2026-11-02")
        lowest = {r["employeeCode"]: (r["used"], r["pending"], r["remaining"]) for r in c["lowest"]}
        self.assertEqual(lowest["L001"], (1.0, 0.0, 11.0))
        self.assertEqual(lowest["L002"], (0.0, 0.5, 11.5))


class PermissionTests(World):
    def test_the_monthly_cap(self):
        p = self.api("permissions")
        self.assertEqual(p["cap"], 3)
        t = p["totals"]
        self.assertEqual(
            (t["requested"], t["approved"], t["rejected"], t["pending"], t["excess"], t["excessPct"], t["people"]),
            (5, 3, 1, 1, 2, 66.7, 3),
        )
        self.assertEqual(values(p["metrics"], "requested", "excess"), ((5, 3), (2, 0)))
        self.assertEqual(
            [(r["label"], r["requested"]) for r in p["byType"]],
            [("Evening Early-Out", 3), ("Middle One-Hour Permission", 1), ("Morning Late-In", 1)],
        )
        self.assertEqual([(r["employeeCode"], r["excess"], r["approved"]) for r in p["overCap"]], [("L001", 2, 2)])

    def test_the_briefing_says_it(self):
        text = {s["id"]: s["text"] for s in self.api("briefing")["sentences"]}
        self.assertEqual(
            text["permissions"],
            "5 permissions dated in 09 Nov – 15 Nov 2026, 3 approved; 2 of the approved went beyond the monthly cap of 3 "
            "and shift nothing.",
        )


class ApprovalTests(World):
    def test_rejection_reasons(self):
        a = self.api("approvals")
        self.assertEqual(
            a["rejectReasons"],
            {
                "rejected": 1,
                "withReason": 1,
                "withoutReason": 0,
                "rows": [{"key": "busy month", "reason": "Busy month", "count": 1, "sharePct": 100.0}],
            },
        )
        self.assertEqual(a["pending"]["rows"][0]["waitingDays"], 8)


class ListTests(World):
    def total(self, **params):
        return self.api("list", **params)["total"]

    def test_requests(self):
        self.assertEqual(self.total(what="requests"), 4)
        rejected = self.api("list", what="requests", status="rejected")["items"]
        self.assertEqual(
            [(i["employeeCode"], i["remark"], i["decidedBy"]) for i in rejected], [("L005", "Busy month", "Priya")]
        )
        self.assertEqual(self.total(what="requests", reason="personal"), 1)
        self.assertEqual(self.total(what="requests", notice="short"), 2)
        waiting = self.api("list", what="requests", status="pending")["items"]
        self.assertEqual([(i["employeeCode"], i["waitingDays"]) for i in waiting], [("L002", 8)])

    def test_days_and_who_is_out(self):
        days = self.api("list", what="days")
        self.assertEqual(days["total"], 5)
        self.assertEqual(days["items"][0]["employeeCode"], "L001")  # the most days first
        self.assertEqual(self.total(what="days", dept="Stitching"), 2)
        self.assertEqual(self.total(what="days", reason="Sick Leave"), 1)
        out = self.api("list", what="out", day="2026-11-13")["items"]
        self.assertEqual(sorted(i["employeeCode"] for i in out), ["L002", "L005"])

    def test_casual_leave_and_permissions(self):
        cf = self.api("list", what="cl", filter="carry_forward")["items"]
        self.assertEqual([(i["employeeCode"], i["carryForwardDates"]) for i in cf], [("L001", ["2026-09-28"])])
        self.assertEqual(self.total(what="cl", filter="used"), 4)
        self.assertEqual(self.total(what="permissions", filter="excess"), 2)
        rejected = self.api("list", what="permissions", status="rejected")["items"]
        self.assertEqual([i["remark"] for i in rejected], ["No reason given"])

    def test_paging_and_bad_parameters(self):
        page = self.api("list", what="days", pageSize=2, page=3)
        self.assertEqual((page["total"], page["pages"], len(page["items"])), (5, 3, 1))
        for params in ({"what": "secrets"}, {"what": "requests", "status": "lost"}):
            self.assertEqual(self.get(f"{BASE}/list", **W, **params).status_code, 400)

    def test_the_number_of_queries_does_not_grow_with_the_rows(self):
        def count():
            with CaptureQueriesContext(connection) as ctx:
                self.api("list", what="days")
            return len(ctx.captured_queries)

        before = count()
        for day in (9, 10, 12):
            leave(self.e5, f"2026-11-{day:02d}", f"2026-11-{day:02d}", "approved", ist(11, 1))
            casual(self.e2, date(2026, 11, day))
        self.assertEqual(count(), before)


class EmptyTests(MdApiTestCase):
    def test_no_data_is_null_not_zero(self):
        s = self.get(f"{BASE}/summary", **W).json()
        self.assertIsNone(s["metrics"]["leaveRatePct"]["value"])
        self.assertIsNone(s["metrics"]["rejectionPct"]["value"])
        p = self.get(f"{BASE}/permissions", **W).json()
        self.assertIsNone(p["totals"]["excessPct"])
        self.assertEqual(self.get(f"{BASE}/list", **W, what="cl").json()["total"], 0)


class RouteTests(World):
    def test_every_route_answers_with_provenance(self):
        for name in ROUTES:
            self.assertIn("provenance", self.api(name), name)

    def test_only_the_md_gets_in(self):
        self.assertIn(self.client.get(f"{BASE}/summary").status_code, (401, 403))

    def test_the_analytics_run_read_only(self):
        with read_only_db():
            p = resolve_period(W)
            L.leave_balances(Scope(), today=TODAY)
            L.leave_permissions(Scope(), p)
            L.leave_list(Scope(), p, what="cl", today=TODAY)

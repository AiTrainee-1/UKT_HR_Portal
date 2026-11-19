"""
Visitors page (HR) and the reception desk's check-out: the filters of visitor/records and visitor/summary, the status of a
visit at the India day edges, registering a visit (new and returning visitor, every validation), check-out (HR and the
desk, once only, own branch only), a visit's detail and history, the People directory, the Excel / PDF export (Aadhaar
never whole), permissions (view-only, hidden, branch scope) and the audit rows.

The clock stands at Wednesday 18 Nov 2026, 11:30 in India (06:00 UTC).

Run via: DATABASE_URL="" DB_HOST=localhost DB_TEST_NAME=test_uktex_gp_c py -3 manage.py test api.tests_visitor_admin -v 1
"""

from __future__ import annotations

import io
from contextlib import ExitStack
from datetime import datetime, timedelta
from unittest.mock import patch

from django.db import connection
from django.test import TestCase
from django.test.utils import CaptureQueriesContext

from . import gate_exports
from . import outpass_visitor_views as ovv
from . import reception_views as rv
from . import visitor_admin_views as vav
from .clock import FACTORY_TZ
from .jwt_utils import sign_token
from .models import (
    AuditLog,
    Branch,
    Department,
    Employee,
    HRUser,
    ReceptionDevice,
    Role,
    Visitor,
    VisitorVisit,
)

AADHAAR = "123456789012"


def ist(day: int, hour: int, minute: int = 0, month: int = 11) -> datetime:
    return datetime(2026, month, day, hour, minute, tzinfo=FACTORY_TZ)


NOW = ist(18, 11, 30)


def bearer(payload: dict) -> dict:
    return {"HTTP_AUTHORIZATION": f"Bearer {sign_token(payload)}"}


class Clock:
    """Stands every clock the visitor views read at `at`."""

    def __init__(self, at: datetime):
        self.at = at
        self.stack = ExitStack()

    def __enter__(self):
        for module in (ovv, vav, rv):
            self.stack.enter_context(patch.object(module, "_now", lambda: self.at))
        # auto_now_add (a visit's check-in time) reads Django's clock
        self.stack.enter_context(patch("django.utils.timezone.now", lambda: self.at))
        return self

    def __exit__(self, *exc):
        self.stack.close()


class Fixture(TestCase):
    @classmethod
    def setUpTestData(cls):
        cls.b1 = Branch.objects.create(name="VA Unit 1", code="VAU1")
        cls.b2 = Branch.objects.create(name="VA Unit 2", code="VAU2")
        cls.d_cut = Department.objects.create(name="VA Cutting")
        cls.d_sew = Department.objects.create(name="VA Sewing")

        def emp(code, first, branch, dept, phone):
            return Employee.objects.create(
                employee_code=code,
                first_name=first,
                last_name="Host",
                employment_type="staff",
                status="active",
                branch=branch,
                department=dept,
                phone=phone,
            )

        cls.host1 = emp("VAH1", "Karthik", cls.b1, cls.d_cut, "90000 11111")
        cls.host2 = emp("VAH2", "Selvam", cls.b1, cls.d_sew, "90000 22222")
        cls.host3 = emp("VAH3", "Meena", cls.b2, cls.d_cut, "90000 33333")

        edit = Role.objects.create(name="va_edit", permissions={"outpass_visitors": "edit"})
        view = Role.objects.create(name="va_view", permissions={"outpass_visitors": "view"})
        other = Role.objects.create(name="va_other", permissions={"employees": "edit"})
        mk = lambda name, **kw: HRUser.objects.create(username=name, password_hash="x", full_name=name, **kw)  # noqa: E731
        cls.admin = mk("va_admin", is_super_admin=True)
        cls.b1_editor = mk("va_b1_edit", role=edit, branch=cls.b1)
        cls.b1_viewer = mk("va_b1_view", role=view, branch=cls.b1)
        cls.b2_editor = mk("va_b2_edit", role=edit, branch=cls.b2)
        cls.open_editor = mk("va_open_edit", role=edit)
        cls.outsider = mk("va_other", role=other)

        cls.desk1 = ReceptionDevice.objects.create(
            name="Front Desk", branch=cls.b1, username="va_desk1", password_hash="x", login_token="va_tok1"
        )
        cls.desk2 = ReceptionDevice.objects.create(
            name="Unit 2 Desk", branch=cls.b2, username="va_desk2", password_hash="x", login_token="va_tok2"
        )

        cls.v1 = Visitor.objects.create(name="Ramesh Kumar", phone="9845012210", aadhaar_number=AADHAAR)
        cls.v2 = Visitor.objects.create(name="Prakash Sharma", phone="94000 00882")
        cls.v3 = Visitor.objects.create(name="Anand Natarajan", phone="9700000554")
        cls.v4 = Visitor.objects.create(name="Dinesh Varma", phone="9100000339")
        cls.v5 = Visitor.objects.create(name="Suresh Joshi", phone="9900000112")

        def visit(visitor, branch, at, *, host=None, out=None, whom="Someone", purpose="Meeting", **kw):
            v = VisitorVisit.objects.create(
                visitor=visitor,
                branch=branch,
                whom_to_meet=whom,
                purpose=purpose,
                meeting_employee=host,
                checked_out_at=out,
                **kw,
            )
            VisitorVisit.objects.filter(pk=v.pk).update(visited_at=at)
            v.refresh_from_db()
            return v

        # unit 1, today: a (inside since 09:12, over 2 h), c (08:30-11:15), e (00:05, just after midnight), g (10:45)
        cls.a = visit(
            cls.v1,
            cls.b1,
            ist(18, 9, 12),
            host=cls.host1,
            whom="Karthik Host",
            purpose="Spindle repair",
            source="hr",
            checked_in_by="Priya",
            company="Apex Spares",
        )
        cls.b = visit(cls.v1, cls.b1, ist(14, 10, 0, month=10), host=cls.host2, out=ist(14, 11, 12, month=10))
        cls.c = visit(cls.v2, cls.b1, ist(18, 8, 30), host=cls.host2, out=ist(18, 11, 15), purpose="Auditing")
        cls.d = visit(cls.v3, cls.b1, ist(17, 23, 50), purpose="Cotton bales")  # yesterday, never checked out
        cls.e = visit(cls.v3, cls.b1, ist(18, 0, 5), purpose="Cotton bales")
        cls.g = visit(
            cls.v5, cls.b1, ist(18, 10, 45), whom="Accounts", purpose="Yarn sample", company="Quality Threads"
        )
        # unit 2, today
        cls.f = visit(cls.v4, cls.b2, ist(18, 10, 5), host=cls.host3, source="reception", checked_in_by="Unit 2 Desk")

    def setUp(self):
        self.clock = Clock(NOW)
        self.clock.__enter__()
        self.addCleanup(self.clock.__exit__, None, None, None)

    def hr(self, user: HRUser, name: str = "Priya HR") -> dict:
        return bearer({"role": "hr", "hrUserId": user.id, "name": name})

    def desk(self, device: ReceptionDevice) -> dict:
        """A desk token with its own session (a token without rsid is refused since 19 Nov 2026)."""
        from types import SimpleNamespace

        from .reception_credentials import desk_token, new_desk_session

        request = SimpleNamespace(META={"HTTP_USER_AGENT": "test", "REMOTE_ADDR": "10.0.0.1"})
        return {"HTTP_AUTHORIZATION": f"Bearer {desk_token(device, new_desk_session(device, request))}"}

    def get(self, url: str, user=None, status: int = 200, **headers):
        response = self.client.get(url, **(headers or self.hr(user or self.b1_editor)))
        self.assertEqual(response.status_code, status, response.content[:400])
        return response.json() if response.get("Content-Type", "").startswith("application/json") else response

    def post(self, url: str, body: dict | None = None, user=None, status: int = 200, **headers):
        response = self.client.post(
            url, body or {}, content_type="application/json", **(headers or self.hr(user or self.b1_editor))
        )
        self.assertEqual(response.status_code, status, response.content[:400])
        return response.json()

    def ids(self, url: str, user=None) -> list[int]:
        return [r["id"] for r in self.get(url, user)["items"]]


# ═══ visitor/records: filters, status, keys ══════════════════════════════════════════════════════════════════════


class RecordsTests(Fixture):
    URL = "/api/visitor/records"

    def test_the_old_range_still_works_and_month_is_the_default(self):
        c, a = self.c.id, self.a.id
        self.assertEqual(self.ids(f"{self.URL}?range=today"), [self.g.id, a, c, self.e.id])
        self.assertEqual(self.ids(f"{self.URL}?range=week"), [self.g.id, a, c, self.e.id, self.d.id])
        self.assertEqual(self.ids(self.URL), [self.g.id, a, c, self.e.id, self.d.id])  # month by default

    def test_from_and_to_are_india_days_at_the_midnight_edge(self):
        # d is 17 Nov 23:50 IST and e is 18 Nov 00:05 IST: both 17 Nov in UTC
        self.assertEqual(self.ids(f"{self.URL}?from=2026-11-17&to=2026-11-17"), [self.d.id])
        self.assertIn(self.e.id, self.ids(f"{self.URL}?from=2026-11-18&to=2026-11-18"))
        self.assertNotIn(self.d.id, self.ids(f"{self.URL}?from=2026-11-18&to=2026-11-18"))
        self.assertEqual(self.ids(f"{self.URL}?from=2026-10-01&to=2026-10-31"), [self.b.id])
        # from / to win over an old range sent with them
        self.assertEqual(self.ids(f"{self.URL}?range=today&from=2026-10-14&to=2026-10-14"), [self.b.id])

    def test_status_filter(self):
        today = f"{self.URL}?from=2026-11-18&to=2026-11-18"
        self.assertEqual(self.ids(f"{today}&status=inside"), [self.g.id, self.a.id, self.e.id])
        self.assertEqual(self.ids(f"{today}&status=checked_out"), [self.c.id])
        self.assertEqual(self.ids(f"{self.URL}?from=2026-11-01&to=2026-11-18&status=not_checked_out"), [self.d.id])

    def test_status_of_each_visit_and_the_new_keys(self):
        items = {r["id"]: r for r in self.get(f"{self.URL}?from=2026-10-01&to=2026-11-18")["items"]}
        self.assertEqual(items[self.a.id]["status"], "inside")
        self.assertEqual(items[self.a.id]["statusLabel"], "Inside")
        self.assertEqual(items[self.a.id]["minutesInside"], 138)  # 09:12 to 11:30
        self.assertEqual(items[self.c.id]["status"], "checked_out")
        self.assertEqual(items[self.c.id]["minutesInside"], 165)
        self.assertEqual(items[self.d.id]["status"], "not_checked_out")
        self.assertEqual(items[self.d.id]["statusLabel"], "Left without check-out")
        self.assertIsNone(items[self.d.id]["minutesInside"])
        self.assertEqual(items[self.e.id]["status"], "inside")
        a = items[self.a.id]
        self.assertEqual(
            (a["source"], a["sourceLabel"], a["checkedInBy"], a["company"], a["peopleCount"], a["visitCount"]),
            ("hr", "Registered by HR", "Priya", "Apex Spares", 1, 2),
        )
        self.assertEqual(items[self.g.id]["sourceLabel"], "QR self check-in")
        for key in (
            "checkedOutAt",
            "checkedOutBy",
            "checkoutSource",
            "vehicleNumber",
            "idProofType",
            "badgeNumber",
            "notes",
            "visitorId",
        ):
            self.assertIn(key, a)
        # every old key is still there
        for key in (
            "name",
            "phone",
            "aadhaar",
            "aadhaarLast4",
            "whyCame",
            "whomToMeet",
            "purpose",
            "branchName",
            "visitedAt",
            "meetingEmployee",
            "notifiedEmailAt",
            "notifiedWhatsappAt",
        ):
            self.assertIn(key, a)
        self.assertEqual(a["meetingEmployee"]["id"], self.host1.id)

    def test_status_at_the_day_edge_one_minute_after_midnight(self):
        with Clock(ist(18, 0, 1)):
            items = {r["id"]: r for r in self.get(f"{self.URL}?from=2026-11-17&to=2026-11-18")["items"]}
        self.assertEqual(items[self.d.id]["status"], "not_checked_out")  # 17 Nov 23:50, the day has ended
        # e (00:05) is "in the future" for this clock but still today: inside
        self.assertEqual(items[self.e.id]["status"], "inside")
        with Clock(ist(17, 23, 59)):
            items = {r["id"]: r for r in self.get(f"{self.URL}?from=2026-11-17&to=2026-11-17")["items"]}
        self.assertEqual(items[self.d.id]["status"], "inside")

    def test_host_department_source_and_search(self):
        month = f"{self.URL}?from=2026-10-01&to=2026-11-18"
        self.assertEqual(self.ids(f"{month}&hostEmployeeId={self.host1.id}"), [self.a.id])
        self.assertEqual(self.ids(f"{month}&departmentId={self.d_sew.id}"), [self.c.id, self.b.id])
        self.assertEqual(self.ids(f"{month}&source=hr"), [self.a.id])
        self.assertEqual(self.ids(f"{month}&source=reception"), [])
        self.assertEqual(self.ids(f"{month}&q=apex"), [self.a.id])
        self.assertEqual(self.ids(f"{month}&q=98450"), [self.a.id, self.b.id])  # the phone (both of Ramesh's visits)
        self.assertEqual(self.ids(f"{month}&q=accounts"), [self.g.id])  # whom to meet
        self.assertEqual(self.ids(f"{month}&q=yarn"), [self.g.id])  # the purpose
        self.assertEqual(self.ids(f"{month}&q=karthik"), [self.a.id])  # the host's name
        self.assertEqual(self.ids(f"{month}&q=kumar spares"), [self.a.id])  # every word must match
        self.assertEqual(self.ids(f"{month}&q=kumar threads"), [])

    def test_branch_scope_and_the_branch_filter(self):
        today = f"{self.URL}?from=2026-11-18&to=2026-11-18"
        self.assertNotIn(self.f.id, self.ids(today))  # unit 1 account
        # a unit 1 account cannot ask for unit 2
        self.assertNotIn(self.f.id, self.ids(f"{today}&branchId={self.b2.id}"))
        self.assertEqual(self.ids(today, self.b2_editor), [self.f.id])
        self.assertEqual(len(self.ids(today, self.admin)), 5)
        self.assertEqual(self.ids(f"{today}&branchId={self.b2.id}", self.admin), [self.f.id])
        self.assertEqual(self.ids(f"{today}&branchId={self.b2.id}&source=reception", self.open_editor), [self.f.id])

    def test_bad_filters_are_a_plain_400(self):
        for query, words in (
            ("from=2026-13-01", "from must be a date"),
            ("from=2026-11-18&to=2026-11-01", "start date"),
            ("status=gone", "status must be"),
            ("source=fax", "source must be"),
            ("hostEmployeeId=abc", "hostEmployeeId must be a number"),
            ("departmentId=1x", "departmentId must be a number"),
        ):
            body = self.get(f"{self.URL}?{query}", status=400)
            self.assertIn(words, body["error"], query)

    def test_a_page_costs_the_same_queries_whatever_its_size(self):
        headers = self.hr(self.admin)
        with CaptureQueriesContext(connection) as one:
            self.client.get(f"{self.URL}?from=2026-10-01&to=2026-11-18&pageSize=2", **headers)
        with CaptureQueriesContext(connection) as seven:
            body = self.client.get(f"{self.URL}?from=2026-10-01&to=2026-11-18&pageSize=50", **headers).json()
        self.assertEqual(len(body["items"]), 7)
        self.assertEqual(len(one.captured_queries), len(seven.captured_queries))

    def test_view_only_may_read_and_a_hidden_role_may_not(self):
        self.get(self.URL, self.b1_viewer)
        self.get(self.URL, self.outsider, status=403)
        self.get("/api/visitor/summary", self.outsider, status=403)


# ═══ visitor/summary ══════════════════════════════════════════════════════════════════════════════════════════════


class SummaryTests(Fixture):
    URL = "/api/visitor/summary"

    def test_unit_1_figures(self):
        s = self.get(f"{self.URL}?from=2026-11-18&to=2026-11-18")
        self.assertEqual(
            {k: s[k] for k in ("today", "thisWeek", "thisMonth", "insideNow", "checkedOutToday", "longStayNow")},
            {"today": 4, "thisWeek": 5, "thisMonth": 5, "insideNow": 3, "checkedOutToday": 1, "longStayNow": 2},
        )
        self.assertEqual(s["repeatThisMonth"], 2)  # Ramesh (October too) and Anand (twice in November)
        self.assertEqual(s["inRange"], {"visits": 4, "checkedOut": 1, "avgMinutes": 165})

    def test_every_branch_for_an_account_not_bound_to_one(self):
        s = self.get(f"{self.URL}?from=2026-11-18&to=2026-11-18", self.admin)
        self.assertEqual((s["today"], s["insideNow"], s["longStayNow"]), (5, 4, 2))
        s = self.get(f"{self.URL}?branchId={self.b2.id}", self.admin)
        self.assertEqual((s["today"], s["insideNow"], s["repeatThisMonth"]), (1, 1, 0))

    def test_the_filters_narrow_the_figures_and_in_range_takes_dates_and_status(self):
        s = self.get(f"{self.URL}?from=2026-10-01&to=2026-11-18&hostEmployeeId={self.host2.id}")
        self.assertEqual((s["today"], s["insideNow"], s["checkedOutToday"]), (1, 0, 1))
        # whole minutes per visit, the mean rounded half up (19 Nov 2026): 118.5 -> 119
        self.assertEqual(s["inRange"], {"visits": 2, "checkedOut": 2, "avgMinutes": 119})
        s = self.get(f"{self.URL}?from=2026-11-18&to=2026-11-18&status=inside")
        self.assertEqual(s["inRange"], {"visits": 3, "checkedOut": 0, "avgMinutes": None})
        self.assertEqual(s["insideNow"], 3)  # the tiles ignore the status filter
        self.get(f"{self.URL}?status=nope", status=400)

    def test_the_host_and_department_options(self):
        s = self.get(f"{self.URL}?options=1")
        self.assertEqual(
            s["options"]["hosts"],
            [
                {"id": self.host1.id, "name": "Karthik Host", "department": "VA Cutting"},
                {"id": self.host2.id, "name": "Selvam Host", "department": "VA Sewing"},
            ],
        )
        self.assertEqual(
            s["options"]["departments"],
            [{"id": self.d_cut.id, "name": "VA Cutting"}, {"id": self.d_sew.id, "name": "VA Sewing"}],
        )
        self.assertNotIn("options", self.get(self.URL))
        hosts = self.get(f"{self.URL}?options=1", self.admin)["options"]["hosts"]
        self.assertEqual([h["name"] for h in hosts], ["Karthik Host", "Meena Host", "Selvam Host"])

    def test_the_old_three_without_any_filter(self):
        s = self.get(self.URL)
        self.assertEqual((s["today"], s["thisWeek"], s["thisMonth"]), (4, 5, 5))
        self.assertEqual(s["inRange"]["visits"], 5)  # this month


# ═══ register ═════════════════════════════════════════════════════════════════════════════════════════════════════


class RegisterTests(Fixture):
    URL = "/api/visitor/visits"

    def setUp(self):
        super().setUp()
        self.notify_patch = patch.object(vav, "_notify_employee_of_visitor")
        self.notify = self.notify_patch.start()
        self.addCleanup(self.notify_patch.stop)

    def body(self, **kw) -> dict:
        data = {
            "name": "Lakshmi Narayan",
            "phone": "98400 55555",
            "whomToMeet": "Accounts",
            "purpose": "Invoice",
        }
        data.update(kw)
        return data

    def test_a_new_visitor_is_checked_in_now(self):
        out = self.post(
            self.URL,
            self.body(
                company="Lotus Mills",
                vehicleNumber="tn 37 ab 1234",
                peopleCount=2,
                idProofType="Driving licence",
                badgeNumber="V-014",
                notes="Carrying samples",
                aadhaarNumber="2222 3333 4444",
                meetingEmployeeId=self.host1.id,
            ),
            status=201,
        )
        visit = VisitorVisit.objects.get(pk=out["id"])
        self.assertEqual(visit.branch_id, self.b1.id)
        self.assertEqual((visit.source, visit.checked_in_by), ("hr", "Priya HR"))
        self.assertEqual(visit.visited_at, NOW)
        self.assertEqual(visit.vehicle_number, "TN 37 AB 1234")
        self.assertEqual(visit.visitor.aadhaar_number, "222233334444")
        self.assertEqual(
            (out["status"], out["company"], out["peopleCount"], out["badgeNumber"], out["visitCount"]),
            ("inside", "Lotus Mills", 2, "V-014", 1),
        )
        self.assertEqual(out["meetingEmployee"]["id"], self.host1.id)
        self.notify.assert_called_once()
        self.assertEqual(self.notify.call_args[0][0].id, visit.id)
        log = AuditLog.objects.get(action="create", module="outpass_visitors", record_id=visit.id)
        self.assertIn("Lakshmi Narayan", log.record_description)
        self.assertNotIn("98400", log.record_description)

    def test_the_host_name_is_used_when_whom_is_blank(self):
        out = self.post(self.URL, self.body(whomToMeet="", meetingEmployeeId=self.host2.id), status=201)
        self.assertEqual(out["whomToMeet"], "Selvam Host")

    def test_a_returning_visitor_reuses_the_row_however_the_phone_is_typed(self):
        before = Visitor.objects.count()
        out = self.post(self.URL, self.body(name="", phone="+91 9400000882"), status=201)
        self.assertEqual(Visitor.objects.count(), before)
        self.assertEqual(out["visitorId"], self.v2.id)
        self.assertEqual(out["name"], "Prakash Sharma")  # no name sent: kept
        self.assertEqual(out["visitCount"], 2)
        out = self.post(self.URL, self.body(name="Prakash S", phone="94000 00882"), status=409)
        self.assertEqual(out["code"], "already_inside")

    def test_a_returning_visitor_with_a_new_name_gives_the_new_visit_that_name(self):
        # 19 Nov 2026: the name is the visit's own; the earlier visit and the shared Visitor row keep theirs
        VisitorVisit.objects.filter(pk=self.g.pk).update(checked_out_at=ist(18, 11, 0))
        out = self.post(self.URL, self.body(name="Suresh J", phone="9900000112"), status=201)
        self.assertEqual(out["name"], "Suresh J")
        self.assertEqual(VisitorVisit.objects.get(pk=out["id"]).visitor_name, "Suresh J")
        self.assertEqual(self.get(f"/api/visitor/visits/{self.g.id}")["name"], "Suresh Joshi")
        self.v5.refresh_from_db()
        self.assertEqual(self.v5.name, "Suresh Joshi")

    def test_someone_already_inside_is_not_registered_twice(self):
        out = self.post(self.URL, self.body(phone="9845012210"), status=409)
        self.assertEqual((out["code"], out["visitId"]), ("already_inside", self.a.id))
        self.assertIn("already inside (checked in at 09:12)", out["error"])
        # at another branch it is a new visit
        self.post(self.URL, self.body(phone="9845012210"), user=self.b2_editor, status=201)

    def test_validation(self):
        for patch_, words in (
            ({"phone": ""}, "phone number"),
            ({"phone": "12-34"}, "at least 6 digits"),
            ({"purpose": " "}, "purpose"),
            ({"whomToMeet": ""}, "whom the visitor is meeting"),
            ({"aadhaarNumber": "1234"}, "12 digits"),
            ({"aadhaarNumber": "1234 5678 90AB"}, "12 digits"),
            ({"peopleCount": 0}, "between 1 and 50"),
            ({"peopleCount": "lots"}, "between 1 and 50"),
            ({"meetingEmployeeId": 999999}, "employee to meet was not found"),
            ({"name": "", "phone": "70000 12345"}, "visitor's name"),
            ({"company": "x" * 121}, "Company is too long"),
        ):
            body = self.post(self.URL, self.body(**patch_), status=400)
            self.assertIn(words, body["error"], patch_)
        self.assertFalse(Visitor.objects.filter(phone="70000 12345").exists())
        self.notify.assert_not_called()

    def test_the_branch_comes_from_the_account_or_the_form(self):
        # a bound account: its own branch, whatever the form says
        out = self.post(self.URL, self.body(branchId=self.b2.id), status=201)
        self.assertEqual(VisitorVisit.objects.get(pk=out["id"]).branch_id, self.b1.id)
        # an account not bound to a branch must choose one
        body = self.post(self.URL, self.body(phone="98400 66666"), user=self.open_editor, status=400)
        self.assertIn("Choose the branch", body["error"])
        self.post(self.URL, self.body(phone="98400 66666", branchId=999999), user=self.open_editor, status=400)
        out = self.post(
            self.URL, self.body(phone="98400 66666", branchId=self.b2.id), user=self.open_editor, status=201
        )
        self.assertEqual(VisitorVisit.objects.get(pk=out["id"]).branch_id, self.b2.id)

    def test_a_failing_message_never_fails_the_check_in(self):
        self.notify.side_effect = RuntimeError("WhatsApp is down")
        with self.assertLogs("api.visitor_admin_views", "ERROR"):
            out = self.post(self.URL, self.body(), status=201)
        self.assertTrue(VisitorVisit.objects.filter(pk=out["id"]).exists())

    def test_the_real_notify_is_best_effort_too(self):
        self.notify_patch.stop()
        with (
            patch.object(ovv, "_send_visitor_whatsapp", side_effect=RuntimeError("down")) as whatsapp,
            patch.object(ovv, "_send_visitor_email", side_effect=RuntimeError("down")),
        ):
            self.post(self.URL, self.body(meetingEmployeeId=self.host1.id), status=201)
        whatsapp.assert_called_once()

    def test_view_only_and_hidden_cannot_register(self):
        self.post(self.URL, self.body(), user=self.b1_viewer, status=403)
        self.post(self.URL, self.body(), user=self.outsider, status=403)
        self.assertFalse(Visitor.objects.filter(phone="98400 55555").exists())


# ═══ detail, history, check-out ══════════════════════════════════════════════════════════════════════════════════


class DetailTests(Fixture):
    def test_the_visit_and_the_visitors_history(self):
        body = self.get(f"/api/visitor/visits/{self.a.id}")
        self.assertEqual(body["id"], self.a.id)
        self.assertEqual([h["id"] for h in body["history"]], [self.a.id, self.b.id])
        self.assertEqual(body["history"][1]["status"], "checked_out")
        self.assertEqual(body["phone"], "9845012210")  # HR sees the phone in full on the drawer

    def test_history_keeps_to_the_branch_and_to_twenty(self):
        other = VisitorVisit.objects.create(visitor=self.v1, branch=self.b2, whom_to_meet="X", purpose="Y")
        self.assertNotIn(other.id, [h["id"] for h in self.get(f"/api/visitor/visits/{self.a.id}")["history"]])
        self.assertIn(other.id, [h["id"] for h in self.get(f"/api/visitor/visits/{self.a.id}", self.admin)["history"]])
        for i in range(25):
            VisitorVisit.objects.create(
                visitor=self.v1, branch=self.b1, whom_to_meet="X", purpose="Y", checked_out_at=NOW
            )
        self.assertEqual(len(self.get(f"/api/visitor/visits/{self.a.id}")["history"]), 20)

    def test_another_branch_or_nothing_is_404(self):
        self.get(f"/api/visitor/visits/{self.f.id}", status=404)
        self.get("/api/visitor/visits/999999", status=404)
        self.get(f"/api/visitor/visits/{self.f.id}", self.b2_editor)


class CheckOutTests(Fixture):
    def url(self, visit) -> str:
        return f"/api/visitor/visits/{visit.id}/check-out"

    def test_hr_checks_out_once(self):
        out = self.post(self.url(self.a), {"note": "Left with the parcel"})
        self.assertEqual((out["status"], out["checkedOutBy"], out["checkoutSource"]), ("checked_out", "Priya HR", "hr"))
        self.assertEqual(datetime.fromisoformat(out["checkedOutAt"]), NOW)
        self.assertEqual(out["minutesInside"], 138)
        self.a.refresh_from_db()
        self.assertEqual(self.a.checked_out_at, NOW)
        self.assertEqual(self.a.notes, "Check-out: Left with the parcel")
        again = self.post(self.url(self.a), status=409)
        self.assertEqual(again["code"], "already_checked_out")
        self.assertIn("already checked out at 11:30", again["error"])
        self.assertTrue(AuditLog.objects.filter(action="update", module="outpass_visitors", record_id=self.a.id))

    def test_a_visit_checked_in_more_than_24_hours_ago_cannot_be_checked_out(self):
        old = VisitorVisit.objects.create(visitor=self.v2, branch=self.b1, whom_to_meet="X", purpose="Y")
        VisitorVisit.objects.filter(pk=old.pk).update(visited_at=ist(17, 11, 30))  # exactly 24 hours before NOW
        self.assertFalse(self.get(f"/api/visitor/visits/{old.id}")["canCheckOut"])
        body = self.post(self.url(old), status=409)
        self.assertEqual(body["code"], "earlier_day")
        self.assertIn("17 Nov 2026 at 11:30, more than 24 hours ago", body["error"])
        old.refresh_from_db()
        self.assertIsNone(old.checked_out_at)
        self.post(f"/api/reception-devices/visits/{old.id}/check-out", status=409, **self.desk(self.desk1))

    def test_a_night_visitor_from_yesterday_evening_can_be_checked_out_after_midnight(self):
        # d came in at 17 Nov 23:50 IST (the day before NOW): under 24 hours ago, so HR and the desk may check it out
        before = self.get(f"/api/visitor/visits/{self.d.id}")
        self.assertEqual((before["status"], before["canCheckOut"]), ("not_checked_out", True))  # status rule kept
        out = self.post(self.url(self.d))
        self.assertEqual((out["status"], out["checkedOutBy"]), ("checked_out", "Priya HR"))
        self.assertEqual(out["minutesInside"], 11 * 60 + 40)
        night = VisitorVisit.objects.create(visitor=self.v4, branch=self.b1, whom_to_meet="X", purpose="Y")
        VisitorVisit.objects.filter(pk=night.pk).update(visited_at=ist(17, 20, 0))
        out = self.post(f"/api/reception-devices/visits/{night.id}/check-out", **self.desk(self.desk1))
        self.assertEqual((out["status"], out["checkoutSource"]), ("checked_out", "reception"))

    def test_another_branch_is_404_and_view_only_is_refused(self):
        self.post(self.url(self.f), status=404)
        self.post(self.url(self.g), user=self.b1_viewer, status=403)
        self.post(self.url(self.g), user=self.outsider, status=403)
        self.g.refresh_from_db()
        self.assertIsNone(self.g.checked_out_at)
        self.post(self.url(self.f), user=self.admin)

    def test_a_long_note_is_refused(self):
        self.post(self.url(self.g), {"note": "x" * 301}, status=400)


class ReceptionCheckOutTests(Fixture):
    def url(self, visit) -> str:
        return f"/api/reception-devices/visits/{visit.id}/check-out"

    def test_the_desk_checks_out_its_own_branch_only(self):
        out = self.post(self.url(self.g), **self.desk(self.desk1))
        self.assertEqual(
            (out["status"], out["checkedOutBy"], out["checkoutSource"]), ("checked_out", "Front Desk", "reception")
        )
        self.post(self.url(self.g), status=409, **self.desk(self.desk1))
        self.post(self.url(self.f), status=404, **self.desk(self.desk1))  # unit 2's visitor
        self.f.refresh_from_db()
        self.assertIsNone(self.f.checked_out_at)
        self.post(self.url(self.f), **self.desk(self.desk2))
        self.assertTrue(AuditLog.objects.filter(action="update", module="outpass_visitors", record_id=self.g.id))

    def test_a_switched_off_desk_or_an_hr_token_is_refused(self):
        ReceptionDevice.objects.filter(pk=self.desk1.pk).update(is_active=False)
        self.post(self.url(self.g), status=403, **self.desk(self.desk1))
        response = self.client.post(self.url(self.g), {}, content_type="application/json", **self.hr(self.admin))
        self.assertIn(response.status_code, (401, 403))
        self.assertEqual(self.client.post(self.url(self.g)).status_code, 401)
        self.g.refresh_from_db()
        self.assertIsNone(self.g.checked_out_at)

    def test_the_desk_list_shows_status_and_the_summary_inside_now(self):
        body = self.get("/api/reception-devices/visits?range=today", **self.desk(self.desk1))
        statuses = {r["id"]: r["status"] for r in body["items"]}
        self.assertEqual(statuses[self.a.id], "inside")
        self.assertEqual(statuses[self.c.id], "checked_out")
        summary = self.get("/api/reception-devices/summary", **self.desk(self.desk1))
        self.assertEqual((summary["today"], summary["insideNow"], summary["checkedOutToday"]), (4, 3, 1))

    def test_the_desk_check_out_records_which_desk(self):
        self.post(self.url(self.g), **self.desk(self.desk1))
        self.g.refresh_from_db()
        self.assertEqual(self.g.checked_out_desk_id, self.desk1.id)
        # HR's check-out names no desk
        self.post(f"/api/visitor/visits/{self.a.id}/check-out")
        self.a.refresh_from_db()
        self.assertIsNone(self.a.checked_out_desk_id)


# ═══ The reception desk registers a walk-in (POST reception-devices/visits), its list, look-ups and file ══════════


class DeskRegisterTests(Fixture):
    URL = "/api/reception-devices/visits"

    def setUp(self):
        super().setUp()
        self.notify_patch = patch.object(vav, "_notify_employee_of_visitor")
        self.notify = self.notify_patch.start()
        self.addCleanup(self.notify_patch.stop)

    def body(self, **kw) -> dict:
        data = {"name": "Lakshmi Narayan", "phone": "98400 55555", "whomToMeet": "Accounts", "purpose": "Invoice"}
        data.update(kw)
        return data

    def test_a_walk_in_is_checked_in_now_at_the_desks_branch(self):
        out = self.post(
            self.URL,
            self.body(company="Lotus Mills", meetingEmployeeId=self.host1.id, branchId=self.b2.id, peopleCount=2),
            status=201,
            **self.desk(self.desk1),
        )
        visit = VisitorVisit.objects.get(pk=out["id"])
        self.assertEqual(visit.branch_id, self.b1.id)  # the desk's branch, whatever the body says
        self.assertEqual((visit.source, visit.checked_in_by), ("reception", "Front Desk"))
        self.assertEqual(visit.checked_in_desk_id, self.desk1.id)
        self.assertIsNone(visit.checked_out_desk_id)
        self.assertEqual(visit.visited_at, NOW)
        self.assertEqual((out["status"], out["sourceLabel"], out["peopleCount"]), ("inside", "Reception desk", 2))
        self.notify.assert_called_once()
        log = AuditLog.objects.get(action="create", module="outpass_visitors", record_id=visit.id)
        self.assertIn("Front Desk", log.record_description)

    def test_a_returning_visitor_is_reused_and_one_still_inside_is_409(self):
        out = self.post(self.URL, self.body(phone="+91 94000 00882", name=""), status=201, **self.desk(self.desk1))
        self.assertEqual(out["visitorId"], self.v2.id)  # Prakash Sharma, same last ten digits
        body = self.post(self.URL, self.body(phone="9845012210"), status=409, **self.desk(self.desk1))
        self.assertEqual((body["code"], body["visitId"]), ("already_inside", self.a.id))

    def test_the_same_checks_as_hr(self):
        self.post(self.URL, self.body(purpose=""), status=400, **self.desk(self.desk1))
        self.post(self.URL, self.body(phone="12"), status=400, **self.desk(self.desk1))
        self.post(self.URL, self.body(aadhaarNumber="1234"), status=400, **self.desk(self.desk1))
        self.post(self.URL, self.body(meetingEmployeeId=999999), status=400, **self.desk(self.desk1))
        self.post(self.URL, self.body(phone="91111 22222", name=""), status=400, **self.desk(self.desk1))
        self.assertFalse(VisitorVisit.objects.filter(source="reception", branch=self.b1).exists())

    def test_a_switched_off_desk_or_an_hr_token_cannot_register(self):
        response = self.client.post(self.URL, self.body(), content_type="application/json", **self.hr(self.admin))
        self.assertEqual(response.status_code, 403)
        ReceptionDevice.objects.filter(pk=self.desk1.pk).update(is_active=False)
        self.post(self.URL, self.body(), status=403, **self.desk(self.desk1))
        self.assertFalse(VisitorVisit.objects.filter(visitor__phone="98400 55555").exists())


class DeskVisitsTests(Fixture):
    def test_the_list_takes_dates_status_and_search_and_never_another_branch(self):
        url = "/api/reception-devices/visits"
        ids = lambda q: [r["id"] for r in self.get(f"{url}?{q}", **self.desk(self.desk1))["items"]]  # noqa: E731
        self.assertEqual(set(ids("")), {self.a.id, self.c.id, self.e.id, self.g.id})  # today by default
        self.assertEqual(set(ids("from=2026-11-17&to=2026-11-17")), {self.d.id})
        self.assertEqual(ids("from=2026-11-18&to=2026-11-18&status=checked_out"), [self.c.id])
        self.assertEqual(ids("range=month&q=ramesh"), [self.a.id])
        self.assertEqual(set(ids(f"branchId={self.b2.id}")), {self.a.id, self.c.id, self.e.id, self.g.id})
        self.assertEqual(ids("range=today&q=dinesh"), [])  # unit 2's visitor
        self.get(f"{url}?from=yesterday", status=400, **self.desk(self.desk1))

    def test_the_desk_file_is_its_branch_only_with_a_masked_aadhaar(self):
        from openpyxl import load_workbook

        response = self.get(
            "/api/reception-devices/visits/export?fmt=xlsx&from=2026-11-18&to=2026-11-18", **self.desk(self.desk1)
        )
        self.assertRegex(response["Content-Disposition"], r'filename="visitors_front_desk_\d{8}_\d{4}\.xlsx"')
        book = load_workbook(io.BytesIO(response.content))
        text = repr([list(r) for r in book.active.iter_rows(values_only=True)])
        self.assertIn("VISITORS - FRONT DESK", text.upper())
        self.assertIn("Ramesh Kumar", text)
        self.assertIn("XXXX XXXX 9012", text)
        self.assertNotIn(AADHAAR, text)
        self.assertNotIn("Dinesh Varma", text)
        self.assertIn("Reception desk - Front Desk", text)  # generated by
        pdf = self.get("/api/reception-devices/visits/export?fmt=pdf", **self.desk(self.desk1))
        self.assertTrue(pdf.content.startswith(b"%PDF"))
        self.get("/api/reception-devices/visits/export?fmt=doc", status=400, **self.desk(self.desk1))
        self.assertTrue(AuditLog.objects.filter(action="export", module="outpass_visitors").exists())

    def test_the_look_ups(self):
        found = self.post("/api/reception-devices/host-lookup", {"phone": "+91 90000 11111"}, **self.desk(self.desk1))
        self.assertEqual((found["found"], found["employee"]["id"]), (True, self.host1.id))
        self.assertEqual(
            self.post("/api/reception-devices/host-lookup", {"phone": "1"}, **self.desk(self.desk1)), {"found": False}
        )
        self.post("/api/reception-devices/host-lookup", {}, status=400, **self.desk(self.desk1))
        known = self.get("/api/reception-devices/visitor-lookup?phone=9845012210", **self.desk(self.desk1))
        self.assertEqual(
            known["visitor"],
            {
                "id": self.v1.id,
                "name": "Ramesh Kumar",
                "visitCount": 2,
                "lastVisitAt": self.a.visited_at.isoformat(),
                "insideNow": True,
                "lastVisitId": self.a.id,
            },
        )
        # a visitor of another branch only is not shown to this desk
        self.assertIsNone(
            self.get("/api/reception-devices/visitor-lookup?phone=9100000339", **self.desk(self.desk1))["visitor"]
        )
        self.assertIsNone(self.get("/api/reception-devices/visitor-lookup?phone=", **self.desk(self.desk1))["visitor"])
        response = self.client.get("/api/reception-devices/visitor-lookup?phone=9845012210", **self.hr(self.admin))
        self.assertEqual(response.status_code, 403)


# ═══ People ═══════════════════════════════════════════════════════════════════════════════════════════════════════


class PeopleTests(Fixture):
    URL = "/api/visitor/people"

    def test_the_directory_of_this_branch(self):
        body = self.get(self.URL)
        self.assertEqual([p["id"] for p in body["items"]], [self.v5.id, self.v1.id, self.v2.id, self.v3.id])
        people = {p["id"]: p for p in body["items"]}
        self.assertEqual(datetime.fromisoformat(people[self.v1.id].pop("lastVisitAt")), ist(18, 9, 12))
        self.assertEqual(
            people[self.v1.id],
            {
                "id": self.v1.id,
                "name": "Ramesh Kumar",
                "phoneMasked": "98•••••210",
                "visitCount": 2,
                "lastHost": "Karthik Host",
                "insideNow": True,
                "lastVisitId": self.a.id,
                "lastCompany": "Apex Spares",
            },
        )
        self.assertFalse(people[self.v2.id]["insideNow"])
        self.assertEqual(people[self.v5.id]["lastHost"], "Accounts")
        self.assertNotIn("9845012210", str(body))  # never the full phone

    def test_search_phone_lookup_and_paging(self):
        self.assertEqual(self.ids(f"{self.URL}?q=ramesh"), [self.v1.id])
        self.assertEqual(self.ids(f"{self.URL}?q=00882"), [self.v2.id])
        self.assertEqual(self.ids(f"{self.URL}?phone=%2B91%2098450%2012210"), [self.v1.id])
        self.assertEqual(self.ids(f"{self.URL}?phone=1234567"), [])
        body = self.get(f"{self.URL}?pageSize=2&page=2")
        self.assertEqual((body["total"], [p["id"] for p in body["items"]]), (4, [self.v2.id, self.v3.id]))

    def test_branch_scope(self):
        self.assertEqual(self.ids(self.URL, self.b2_editor), [self.v4.id])
        self.assertEqual(len(self.ids(self.URL, self.admin)), 5)
        self.assertEqual(self.ids(f"{self.URL}?branchId={self.b2.id}", self.admin), [self.v4.id])
        self.get(self.URL, self.outsider, status=403)
        self.get(self.URL, self.b1_viewer)


# ═══ export ═══════════════════════════════════════════════════════════════════════════════════════════════════════


class ExportTests(Fixture):
    URL = "/api/visitor/export"

    def sheet(self, query: str, user=None):
        from openpyxl import load_workbook

        response = self.get(f"{self.URL}?fmt=xlsx&{query}", user)
        self.assertTrue(response["Content-Disposition"].startswith('attachment; filename="visitors_'))
        book = load_workbook(io.BytesIO(response.content))
        return [[c for c in row] for row in book.active.iter_rows(values_only=True)]

    def test_excel_has_the_filtered_rows_and_a_masked_aadhaar(self):
        rows = self.sheet("from=2026-11-18&to=2026-11-18")
        text = repr(rows)
        self.assertIn("VISITORS", text.upper())
        self.assertIn("XXXX XXXX 9012", text)
        self.assertNotIn(AADHAAR, text)
        self.assertNotIn("5678", text)
        for name in ("Ramesh Kumar", "Prakash Sharma", "Anand Natarajan", "Suresh Joshi"):
            self.assertIn(name, text)
        self.assertNotIn("Dinesh Varma", text)  # unit 2
        self.assertIn("9845012210", text)  # HR sees the phone

    def test_the_filters_reach_the_file(self):
        text = repr(self.sheet("from=2026-11-18&to=2026-11-18&status=checked_out"))
        self.assertIn("Prakash Sharma", text)
        self.assertNotIn("Ramesh Kumar", text)
        self.assertIn("Checked out", text)
        text = repr(self.sheet(f"branchId={self.b2.id}&from=2026-11-18&to=2026-11-18", self.admin))
        self.assertIn("Dinesh Varma", text)
        self.assertNotIn("Ramesh Kumar", text)

    def test_pdf_and_the_audit_row(self):
        response = self.get(f"{self.URL}?fmt=pdf&from=2026-11-18&to=2026-11-18")
        self.assertTrue(response.content.startswith(b"%PDF"))
        self.assertEqual(response["Content-Type"], "application/pdf")
        self.assertTrue(AuditLog.objects.filter(action="export", module="outpass_visitors").exists())

    def test_view_only_may_export_hidden_may_not_bad_input(self):
        self.get(f"{self.URL}?fmt=xlsx", self.b1_viewer)
        self.get(f"{self.URL}?fmt=xlsx", self.outsider, status=403)
        self.assertEqual(self.get(f"{self.URL}?fmt=doc", status=400)["error"], "invalid_format")
        self.get(f"{self.URL}?fmt=xlsx&status=maybe", status=400)

    def test_too_many_rows(self):
        with patch.dict(gate_exports.ROW_LIMITS, {"pdf": 2}):
            body = self.get(f"{self.URL}?fmt=pdf&from=2026-11-18&to=2026-11-18", status=413)
        self.assertEqual(body["error"], "too_many_rows")


class HelpersTests(TestCase):
    def test_mask_phone(self):
        self.assertEqual(ovv.mask_phone("+91 98450 12210"), "98•••••210")
        self.assertEqual(ovv.mask_phone("12345"), "•••45")
        self.assertEqual(ovv.mask_phone(""), "")

    def test_find_visitor_by_phone(self):
        v = Visitor.objects.create(name="P", phone="98765 43210")
        self.assertEqual(ovv.find_visitor_by_phone("98765 43210"), v)
        self.assertEqual(ovv.find_visitor_by_phone("+919876543210"), v)
        self.assertIsNone(ovv.find_visitor_by_phone("43210"))
        self.assertIsNone(ovv.find_visitor_by_phone(""))

    def test_minutes_floor_and_status_labels(self):
        visit = VisitorVisit(visited_at=NOW - timedelta(minutes=59, seconds=59), checked_out_at=NOW)
        self.assertEqual(ovv._minutes_inside(visit, ovv.VISIT_CHECKED_OUT, NOW), 59)
        self.assertEqual(set(ovv.VISIT_STATUS_LABELS), {"inside", "checked_out", "not_checked_out"})


# ═══ 19 Nov 2026 fixes: one branch's register never reads or changes another branch's person (S1), device audit rows
# (S7), one time-inside rule (C2), the chosen branch's visit count (C9) ══════════════════════════════════════════════


class OneBranchRegisterTests(Fixture):
    """Dinesh Varma (v4) has visited unit 2 only; Ramesh Kumar (v1, with an Aadhaar) unit 1 only."""

    def setUp(self):
        super().setUp()
        self.notify_patch = patch.object(vav, "_notify_employee_of_visitor")
        self.notify = self.notify_patch.start()
        self.addCleanup(self.notify_patch.stop)
        Visitor.objects.filter(pk=self.v4.pk).update(aadhaar_number="555566667777")

    def body(self, **kw) -> dict:
        data = {"name": "Typed Name", "phone": "9100000339", "whomToMeet": "Accounts", "purpose": "Invoice"}
        data.update(kw)
        return data

    def assert_v4_untouched(self):
        self.v4.refresh_from_db()
        self.assertEqual((self.v4.name, self.v4.aadhaar_number), ("Dinesh Varma", "555566667777"))

    def test_a_desk_never_receives_or_changes_another_branchs_person(self):
        out = self.post(
            "/api/reception-devices/visits",
            self.body(aadhaarNumber="1111 2222 3333"),
            status=201,
            **self.desk(self.desk1),
        )
        self.assertEqual(
            (out["name"], out["phone"], out["aadhaar"], out["aadhaarLast4"]),
            ("Typed Name", "9100000339", "111122223333", "3333"),
        )
        self.assertNotIn("Dinesh", str(out))
        self.assertNotIn("555566667777", str(out))
        self.assert_v4_untouched()
        self.assertEqual(out["visitorId"], self.v4.id)  # still the one person, by phone
        self.assertEqual(out["visitCount"], 1)  # this branch's visits only
        log = AuditLog.objects.get(action="create", module="outpass_visitors", record_id=out["id"])
        self.assertIn("Typed Name", log.record_description)
        self.assertNotIn("Dinesh", log.record_description)

    def test_without_a_name_someone_new_to_this_branch_is_refused(self):
        body = self.post("/api/reception-devices/visits", self.body(name=""), status=400, **self.desk(self.desk1))
        self.assertIn("visitor's name", body["error"])
        body = self.post("/api/visitor/visits", self.body(name=""), status=400)  # a unit 1 HR account
        self.assertIn("visitor's name", body["error"])
        self.assertFalse(VisitorVisit.objects.filter(visitor=self.v4, branch=self.b1).exists())

    def test_a_branch_bound_hr_account_is_held_to_the_same(self):
        out = self.post("/api/visitor/visits", self.body(), status=201)
        self.assertEqual((out["name"], out["aadhaar"], out["aadhaarLast4"]), ("Typed Name", None, None))
        self.assert_v4_untouched()

    def test_someone_this_branch_knows_gets_this_branchs_own_name_and_aadhaar(self):
        # 19 Nov 2026: a blank field is copied from the person's latest visit at THIS branch (what this branch was told),
        # so the desk sees its own Aadhaar like on its list; the shared Visitor row is never changed
        VisitorVisit.objects.filter(pk=self.a.pk).update(checked_out_at=NOW)  # Ramesh left, comes again
        out = self.post(
            "/api/reception-devices/visits", self.body(name="", phone="9845012210"), status=201, **self.desk(self.desk1)
        )
        self.assertEqual((out["name"], out["aadhaar"], out["aadhaarLast4"]), ("Ramesh Kumar", AADHAAR, "9012"))
        visit = VisitorVisit.objects.get(pk=out["id"])
        self.assertEqual((visit.visitor_name, visit.aadhaar_number), ("Ramesh Kumar", AADHAAR))
        # a new name typed here goes on the new visit only
        VisitorVisit.objects.filter(visitor=self.v1, checked_out_at__isnull=True).update(checked_out_at=NOW)
        out = self.post("/api/visitor/visits", self.body(name="Ramesh K", phone="9845012210"), status=201)
        self.assertEqual((out["name"], out["aadhaar"]), ("Ramesh K", AADHAAR))
        self.v1.refresh_from_db()
        self.assertEqual(self.v1.name, "Ramesh Kumar")

    def test_someone_known_here_and_elsewhere_is_never_changed_by_one_branch(self):
        VisitorVisit.objects.filter(pk=self.a.pk).update(checked_out_at=NOW)
        VisitorVisit.objects.create(visitor=self.v1, branch=self.b2, whom_to_meet="X", purpose="Y", checked_out_at=NOW)
        self.post(
            "/api/visitor/visits",
            self.body(name="Someone Else", phone="9845012210", aadhaarNumber="9999 8888 7777"),
            status=201,
        )
        self.v1.refresh_from_db()
        self.assertEqual((self.v1.name, self.v1.aadhaar_number), ("Ramesh Kumar", AADHAAR))

    def test_the_host_must_work_at_this_branch(self):
        # Meena (host3) works at unit 2
        body = self.post(
            "/api/reception-devices/visits",
            self.body(meetingEmployeeId=self.host3.id),
            status=400,
            **self.desk(self.desk1),
        )
        self.assertEqual(body["error"], "Choose someone from this branch.")
        body = self.post("/api/visitor/visits", self.body(meetingEmployeeId=self.host3.id), status=400)
        self.assertEqual(body["error"], "Choose someone from this branch.")
        self.notify.assert_not_called()
        self.assertFalse(VisitorVisit.objects.filter(meeting_employee=self.host3, branch=self.b1).exists())
        # and the desk's host look-up finds only its own branch's staff
        found = self.post("/api/reception-devices/host-lookup", {"phone": "90000 33333"}, **self.desk(self.desk1))
        self.assertEqual(found, {"found": False})
        found = self.post("/api/reception-devices/host-lookup", {"phone": "90000 33333"}, **self.desk(self.desk2))
        self.assertEqual(found["employee"]["id"], self.host3.id)

    def test_an_hr_account_not_bound_to_a_branch_may_pick_any_host_and_the_name_stays_per_branch(self):
        out = self.post(
            "/api/visitor/visits",
            self.body(name="Dinesh V", branchId=self.b1.id, meetingEmployeeId=self.host3.id),
            user=self.admin,
            status=201,
        )
        self.assertEqual(out["name"], "Dinesh V")
        # 19 Nov 2026: the name is that visit's own; unit 2 still sees what it was told and the shared row is unchanged
        self.assertEqual(self.get(f"/api/visitor/visits/{self.f.id}", self.b2_editor)["name"], "Dinesh Varma")
        self.assert_v4_untouched()


class DeviceAuditActorTests(Fixture):
    def setUp(self):
        super().setUp()
        self.notify_patch = patch.object(vav, "_notify_employee_of_visitor")
        self.notify_patch.start()
        self.addCleanup(self.notify_patch.stop)

    def test_desk_actions_name_the_desk_and_its_branch(self):
        out = self.post(
            "/api/reception-devices/visits",
            {"name": "Walk In", "phone": "98400 77777", "whomToMeet": "Accounts", "purpose": "Invoice"},
            status=201,
            **self.desk(self.desk1),
        )
        self.post(f"/api/reception-devices/visits/{self.g.id}/check-out", **self.desk(self.desk1))
        self.get("/api/reception-devices/visits/export?fmt=xlsx", **self.desk(self.desk1))
        rows = list(AuditLog.objects.filter(module="outpass_visitors").order_by("id"))
        self.assertEqual([r.action for r in rows], ["create", "update", "export"])
        for row in rows:
            self.assertEqual(
                (row.user_name, row.user_type, row.branch_id),
                ("Reception desk - Front Desk", "reception_device", self.b1.id),
            )
        self.assertEqual(rows[0].record_id, out["id"])
        self.assertFalse(AuditLog.objects.filter(user_name="system").exists())


class TimeInsideRuleTests(Fixture):
    """One rule for the row, the summary and the file: whole minutes per visit, the mean rounded half up."""

    def visits(self, *seconds):
        out = []
        for i, s in enumerate(seconds):
            start = ist(16, 9 + i)
            v = VisitorVisit.objects.create(
                visitor=self.v2, branch=self.b1, whom_to_meet="X", purpose="Rule", checked_out_at=start
            )
            VisitorVisit.objects.filter(pk=v.pk).update(visited_at=start, checked_out_at=start + timedelta(seconds=s))
            out.append(v)
        return out

    def test_45_50_and_119_seconds(self):
        self.visits(45, 50, 119)
        rows = self.get("/api/visitor/records?from=2026-11-16&to=2026-11-16&q=rule")["items"]
        self.assertEqual(sorted(r["minutesInside"] for r in rows), [0, 0, 1])
        s = self.get("/api/visitor/summary?from=2026-11-16&to=2026-11-16&q=rule")
        self.assertEqual(s["inRange"], {"visits": 3, "checkedOut": 3, "avgMinutes": 0})  # (0 + 0 + 1) / 3

    def test_the_file_averages_the_rows_whole_minutes_half_up(self):
        self.visits(45, 119)  # 0 and 1 minute: 0.5 -> 1 (Python's round() gave 0)
        s = self.get("/api/visitor/summary?from=2026-11-16&to=2026-11-16&q=rule")
        self.assertEqual(s["inRange"]["avgMinutes"], 1)
        with patch.object(vav, "file_response", wraps=vav.file_response) as made:
            self.get("/api/visitor/export?fmt=xlsx&from=2026-11-16&to=2026-11-16&q=rule")
        kwargs = made.call_args.kwargs
        self.assertEqual(sorted(r["minutes"] for r in kwargs["rows"]), [0, 1])
        average = next(f for f in kwargs["summary"] if f["label"] == "Average time inside")
        self.assertEqual(average["value"], 1)
        self.assertEqual(
            (vav.average_minutes([0, 1]), vav.average_minutes([0, 0, 1]), vav.average_minutes([])), (1, 0, None)
        )


class VisitCountBranchTests(Fixture):
    def test_the_visit_count_follows_the_branch_chosen(self):
        # Ramesh (v1): two visits at unit 1, one more at unit 2
        VisitorVisit.objects.create(visitor=self.v1, branch=self.b2, whom_to_meet="X", purpose="Y")
        url = f"/api/visitor/records?branchId={self.b1.id}&q=ramesh"
        counts = {r["id"]: r["visitCount"] for r in self.get(url, self.admin)["items"]}
        self.assertEqual(counts[self.a.id], 2)  # was 3 (every branch) while the Repeat figure counted unit 1 only
        everywhere = {r["id"]: r["visitCount"] for r in self.get("/api/visitor/records?q=ramesh", self.admin)["items"]}
        self.assertEqual(everywhere[self.a.id], 3)

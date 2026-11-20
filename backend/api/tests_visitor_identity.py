"""
Visitor name and Aadhaar per branch (19 Nov 2026, migration 0165): one phone visits unit A as "Ravi Kumar" (Aadhaar X)
and unit B as "R. Kumar" (Aadhaar Y). Unit A's HR, desk, public QR, files and Report Center only ever see "Ravi Kumar" /
X, unit B only "R. Kumar" / Y, and an HR account not bound to a branch sees each visit with its own name. Registering
at B never changes what A sees; the public QR form, the People directory, a visit's history, the visit counts and the
returning-visitor look-ups keep to the branch; the migration's backfill fills every existing visit from its Visitor row.

The clock stands at Thursday 19 Nov 2026 in India and moves forward between visits.

Run via: DATABASE_URL="" DB_HOST=localhost DB_TEST_NAME=test_uktex_gp_vid py -3 manage.py test api.tests_visitor_identity
"""

from __future__ import annotations

import importlib
import io
import json
from contextlib import ExitStack
from datetime import datetime
from types import SimpleNamespace
from unittest.mock import patch

from django.apps import apps as django_apps
from django.core.cache import cache
from django.db import connection
from django.test import TestCase
from openpyxl import load_workbook

from . import outpass_visitor_views as ovv
from . import reception_views as rv
from . import visitor_admin_views as vav
from . import whatsapp_notifications
from .clock import FACTORY_TZ
from .jwt_utils import sign_token
from .md_portal.analytics import visitors as md_visitors
from .models import Branch, Employee, GateQRCode, HRUser, ReceptionDevice, Role, Visitor, VisitorVisit
from .reception_credentials import desk_token, new_desk_session

PHONE = "98450 11111"
X = "111122223333"  # the Aadhaar given at unit A
Y = "444455556666"  # the Aadhaar given at unit B
NOV = {"dateFrom": "2026-11-01", "dateTo": "2026-11-30"}


def ist(hour: int, minute: int = 0, day: int = 19) -> datetime:
    return datetime(2026, 11, day, hour, minute, tzinfo=FACTORY_TZ)


def text_of_xlsx(content: bytes) -> str:
    book = load_workbook(io.BytesIO(content))
    return repr([list(r) for r in book.active.iter_rows(values_only=True)])


class Clock:
    """Stands every clock the visitor views read (and auto_now_add) at `self.at`, which a test may move."""

    def __init__(self, at: datetime):
        self.at = at
        self.stack = ExitStack()

    def __enter__(self):
        for module in (ovv, vav, rv):
            self.stack.enter_context(patch.object(module, "_now", lambda: self.at))
        self.stack.enter_context(patch("django.utils.timezone.now", lambda: self.at))
        return self

    def __exit__(self, *exc):
        self.stack.close()


class Fixture(TestCase):
    @classmethod
    def setUpTestData(cls):
        cls.a = Branch.objects.create(name="VI Unit A", code="VIA")
        cls.b = Branch.objects.create(name="VI Unit B", code="VIB")
        cls.qr_a = GateQRCode.get_or_create_for(cls.a, GateQRCode.KIND_VISITOR)
        cls.qr_b = GateQRCode.get_or_create_for(cls.b, GateQRCode.KIND_VISITOR)
        role = Role.objects.create(name="vi_edit", permissions={"outpass_visitors": "edit", "reports": "view"})
        mk = lambda name, **kw: HRUser.objects.create(username=name, password_hash="x", full_name=name, **kw)  # noqa: E731
        cls.admin = mk("vi_admin", is_super_admin=True)
        cls.hr_a = mk("vi_hr_a", role=role, branch=cls.a)
        cls.hr_b = mk("vi_hr_b", role=role, branch=cls.b)
        cls.desk_a = ReceptionDevice.objects.create(
            name="Desk A", branch=cls.a, username="vi_desk_a", password_hash="x", login_token="vi_tok_a"
        )
        cls.desk_b = ReceptionDevice.objects.create(
            name="Desk B", branch=cls.b, username="vi_desk_b", password_hash="x", login_token="vi_tok_b"
        )
        cls.host_a = Employee.objects.create(
            employee_code="VIH1",
            first_name="Karthik",
            last_name="Host",
            employment_type="staff",
            status="active",
            branch=cls.a,
            phone="90000 44444",
        )

    def setUp(self):
        cache.clear()  # the public form's per-address throttle counts live in the cache
        self.clock = Clock(ist(9, 0))
        self.clock.__enter__()
        self.addCleanup(self.clock.__exit__, None, None, None)
        notify = patch.object(ovv, "_notify_employee_of_visitor")
        notify.start()
        self.addCleanup(notify.stop)
        # unit A first, through its public QR: "Ravi Kumar", Aadhaar X
        self.assertEqual(self.qr("new", self.qr_a, name="Ravi Kumar", aadhaarNumber=X).status_code, 201)
        self.visit_a = VisitorVisit.objects.get(branch=self.a)
        self.person = self.visit_a.visitor
        # then unit B, which has never seen the phone: "R. Kumar", Aadhaar Y, at 10:00
        self.clock.at = ist(10, 0)
        self.assertEqual(self.qr("new", self.qr_b, name="R. Kumar", aadhaarNumber=Y).status_code, 201)
        self.visit_b = VisitorVisit.objects.get(branch=self.b)

    # ── helpers
    def qr(self, step: str, qr: GateQRCode, **body):
        data = {"phone": PHONE, "whomToMeet": "Accounts", "purpose": "Invoice", **body}
        return self.client.post(f"/api/visitor/gate/{qr.token}/{step}", data, content_type="application/json")

    def hr(self, user: HRUser) -> dict:
        return {
            "HTTP_AUTHORIZATION": f"Bearer {sign_token({'role': 'hr', 'hrUserId': user.id, 'name': user.username})}"
        }

    def desk(self, device: ReceptionDevice) -> dict:
        request = SimpleNamespace(META={"HTTP_USER_AGENT": "test", "REMOTE_ADDR": "10.0.0.9"})
        return {"HTTP_AUTHORIZATION": f"Bearer {desk_token(device, new_desk_session(device, request))}"}

    def get(self, url: str, auth: dict, status: int = 200, **params):
        response = self.client.get(url, params, **auth)
        self.assertEqual(response.status_code, status, response.content[:400])
        return response.json() if response.get("Content-Type", "").startswith("application/json") else response

    def post(self, url: str, body: dict, auth: dict, status: int = 201):
        response = self.client.post(url, body, content_type="application/json", **auth)
        self.assertEqual(response.status_code, status, response.content[:400])
        return response.json()

    def identities(self, items) -> list[tuple]:
        return [(r["name"], r["aadhaar"]) for r in items]

    def records(self, user: HRUser, **params) -> list[dict]:
        return self.get("/api/visitor/records", self.hr(user), range="month", **params)["items"]


# ═══ the public QR form ══════════════════════════════════════════════════════════════════════════════════════════════


class PublicFormTests(Fixture):
    def test_new_at_another_branch_reuses_the_phone_anchor_and_keeps_both_identities(self):
        self.assertEqual(Visitor.objects.filter(phone=PHONE).count(), 1)
        self.assertEqual(self.visit_b.visitor_id, self.person.id)
        self.assertEqual((self.visit_a.visitor_name, self.visit_a.aadhaar_number), ("Ravi Kumar", X))
        self.assertEqual((self.visit_b.visitor_name, self.visit_b.aadhaar_number), ("R. Kumar", Y))
        self.person.refresh_from_db()
        self.assertEqual((self.person.name, self.person.aadhaar_number), ("Ravi Kumar", X))  # the anchor is untouched

    def test_check_phone_and_repeat_keep_to_the_qrs_branch(self):
        # a phone known only at B: A's form says not found, "Already visited" is 404, "New visitor" works
        VisitorVisit.objects.filter(pk=self.visit_a.pk).delete()
        found = self.qr("check-phone", self.qr_a).json()
        self.assertEqual(found, {"found": False})
        self.assertEqual(self.qr("repeat", self.qr_a).status_code, 404)
        self.assertEqual(self.qr("new", self.qr_a, name="Ravi Kumar", aadhaarNumber=X).status_code, 201)
        # each branch's form now names the person as that branch was told
        self.assertEqual(self.qr("check-phone", self.qr_a).json(), {"found": True, "name": "Ravi Kumar"})
        self.assertEqual(self.qr("check-phone", self.qr_b).json(), {"found": True, "name": "R. Kumar"})

    def test_new_is_409_only_for_a_phone_this_branch_knows(self):
        response = self.qr("new", self.qr_a, name="Someone Else")
        self.assertEqual(response.status_code, 409)
        self.assertIn("Already Visited", response.json()["error"])
        self.assertEqual(VisitorVisit.objects.filter(visitor=self.person).count(), 2)

    def test_repeat_copies_the_identity_from_this_branch_only(self):
        self.clock.at = ist(12, 0)
        self.assertEqual(self.qr("repeat", self.qr_a).status_code, 201)
        latest_a = VisitorVisit.objects.filter(branch=self.a).order_by("-visited_at", "-id").first()
        self.assertEqual((latest_a.visitor_name, latest_a.aadhaar_number), ("Ravi Kumar", X))
        self.assertEqual(self.qr("repeat", self.qr_b).status_code, 201)
        latest_b = VisitorVisit.objects.filter(branch=self.b).order_by("-visited_at", "-id").first()
        self.assertEqual((latest_b.visitor_name, latest_b.aadhaar_number), ("R. Kumar", Y))


# ═══ HR, the desk and the files ══════════════════════════════════════════════════════════════════════════════════════


class ReadPathTests(Fixture):
    def test_hr_records_show_each_branchs_own_identity(self):
        self.assertEqual(self.identities(self.records(self.hr_a)), [("Ravi Kumar", X)])
        self.assertEqual(self.identities(self.records(self.hr_b)), [("R. Kumar", Y)])
        # not bound to a branch: every visit, each with its own
        self.assertEqual(self.identities(self.records(self.admin)), [("R. Kumar", Y), ("Ravi Kumar", X)])
        self.assertEqual(self.identities(self.records(self.admin, branchId=self.a.id)), [("Ravi Kumar", X)])
        text = json.dumps(self.records(self.hr_a))
        self.assertNotIn("R. Kumar", text)
        self.assertNotIn(Y, text)

    def test_search_finds_the_name_given_at_the_visit(self):
        self.assertEqual(len(self.records(self.hr_a, q="ravi")), 1)
        self.assertEqual(self.records(self.hr_b, q="ravi"), [])  # B was told "R. Kumar"
        self.assertEqual([r["id"] for r in self.records(self.admin, q="ravi")], [self.visit_a.id])
        self.assertEqual([r["id"] for r in self.records(self.admin, q="r. kumar")], [self.visit_b.id])

    def test_visit_counts_history_and_repeat_figures_keep_to_the_branch(self):
        self.assertEqual([r["visitCount"] for r in self.records(self.hr_a)], [1])
        self.assertEqual([r["visitCount"] for r in self.records(self.admin)], [2, 2])
        detail = self.get(f"/api/visitor/visits/{self.visit_a.id}", self.hr(self.hr_a))
        self.assertEqual((detail["name"], detail["aadhaar"], detail["visitCount"]), ("Ravi Kumar", X, 1))
        self.assertEqual(self.identities(detail["history"]), [("Ravi Kumar", X)])
        self.get(f"/api/visitor/visits/{self.visit_b.id}", self.hr(self.hr_a), status=404)
        everywhere = self.get(f"/api/visitor/visits/{self.visit_a.id}", self.hr(self.admin))
        self.assertEqual(self.identities(everywhere["history"]), [("R. Kumar", Y), ("Ravi Kumar", X)])
        self.assertEqual(self.get("/api/visitor/summary", self.hr(self.hr_a))["repeatThisMonth"], 0)
        self.assertEqual(self.get("/api/visitor/summary", self.hr(self.admin))["repeatThisMonth"], 1)

    def test_people_directory_and_phone_lookup(self):
        def people(user, **params):
            return [
                (p["name"], p["visitCount"], p["lastVisitId"])
                for p in self.get("/api/visitor/people", self.hr(user), **params)["items"]
            ]

        self.assertEqual(people(self.hr_a), [("Ravi Kumar", 1, self.visit_a.id)])
        self.assertEqual(people(self.hr_b), [("R. Kumar", 1, self.visit_b.id)])
        self.assertEqual(people(self.admin), [("R. Kumar", 2, self.visit_b.id)])  # the latest visit anywhere
        self.assertEqual(people(self.admin, branchId=self.a.id), [("Ravi Kumar", 1, self.visit_a.id)])
        self.assertEqual(people(self.hr_a, phone="+91 9845011111"), [("Ravi Kumar", 1, self.visit_a.id)])
        self.assertEqual(people(self.hr_a, q="ravi"), [("Ravi Kumar", 1, self.visit_a.id)])
        self.assertEqual(people(self.hr_b, q="ravi"), [])
        # someone only another branch knows is not found by phone
        VisitorVisit.objects.filter(pk=self.visit_a.pk).delete()
        self.assertEqual(people(self.hr_a, phone=PHONE), [])

    def test_desks_see_and_find_their_own_branchs_identity(self):
        def desk_items(device):
            return self.get("/api/reception-devices/visits", self.desk(device), range="month")["items"]

        self.assertEqual(self.identities(desk_items(self.desk_a)), [("Ravi Kumar", X)])
        self.assertEqual(self.identities(desk_items(self.desk_b)), [("R. Kumar", Y)])
        found = self.get("/api/reception-devices/visitor-lookup", self.desk(self.desk_a), phone=PHONE)["visitor"]
        self.assertEqual((found["name"], found["visitCount"], found["lastVisitId"]), ("Ravi Kumar", 1, self.visit_a.id))
        found = self.get("/api/reception-devices/visitor-lookup", self.desk(self.desk_b), phone=PHONE)["visitor"]
        self.assertEqual((found["name"], found["visitCount"]), ("R. Kumar", 1))

    def test_hr_and_desk_files_carry_each_branchs_own_name_and_masked_aadhaar(self):
        a_text = text_of_xlsx(self.get("/api/visitor/export", self.hr(self.hr_a), fmt="xlsx", range="month").content)
        self.assertIn("Ravi Kumar", a_text)
        self.assertIn("XXXX XXXX 3333", a_text)
        self.assertNotIn("R. Kumar", a_text)
        self.assertNotIn("6666", a_text)
        self.assertNotIn(X, a_text)
        b_text = text_of_xlsx(
            self.get("/api/reception-devices/visits/export", self.desk(self.desk_b), fmt="xlsx", range="month").content
        )
        self.assertIn("R. Kumar", b_text)
        self.assertIn("XXXX XXXX 6666", b_text)
        self.assertNotIn("Ravi Kumar", b_text)
        both = text_of_xlsx(self.get("/api/visitor/export", self.hr(self.admin), fmt="xlsx", range="month").content)
        for expected in ("Ravi Kumar", "R. Kumar", "XXXX XXXX 3333", "XXXX XXXX 6666"):
            self.assertIn(expected, both)

    def test_manage_reception_records_name_the_visit_as_given(self):
        self.clock.at = ist(11, 0)
        self.post(
            "/api/reception-devices/visits",
            {"name": "Desk Typed", "phone": "97000 12345", "whomToMeet": "Accounts", "purpose": "Invoice"},
            self.desk(self.desk_a),
        )
        rows = self.get("/api/reception-devices/records", self.hr(self.hr_a))["items"]
        self.assertEqual([r["visit"]["visitorName"] for r in rows], ["Desk Typed"])

    def test_a_visit_without_its_own_copy_falls_back_to_the_visitor_row(self):
        VisitorVisit.objects.filter(pk=self.visit_b.pk).update(visitor_name=None, aadhaar_number=None)
        self.assertEqual(self.identities(self.records(self.hr_b)), [("Ravi Kumar", X)])


# ═══ registering (HR and the desk) ═══════════════════════════════════════════════════════════════════════════════════


class RegisterTests(Fixture):
    BODY = {"phone": PHONE, "whomToMeet": "Accounts", "purpose": "Invoice"}

    def test_registering_at_b_never_changes_what_a_sees(self):
        VisitorVisit.objects.filter(pk=self.visit_b.pk).update(checked_out_at=ist(10, 30))
        self.clock.at = ist(11, 0)
        out = self.post(
            "/api/visitor/visits",
            {**self.BODY, "name": "Ravi K (B)", "aadhaarNumber": "7777 8888 9999"},
            self.hr(self.hr_b),
        )
        self.assertEqual((out["name"], out["aadhaar"]), ("Ravi K (B)", "777788889999"))
        self.assertEqual(self.identities(self.records(self.hr_a)), [("Ravi Kumar", X)])
        self.assertEqual(self.qr("check-phone", self.qr_a).json(), {"found": True, "name": "Ravi Kumar"})
        found = self.get("/api/reception-devices/visitor-lookup", self.desk(self.desk_a), phone=PHONE)["visitor"]
        self.assertEqual(found["name"], "Ravi Kumar")
        self.person.refresh_from_db()
        self.assertEqual((self.person.name, self.person.aadhaar_number), ("Ravi Kumar", X))

    def test_a_blank_field_is_copied_from_this_branchs_latest_visit_only(self):
        VisitorVisit.objects.filter(pk=self.visit_a.pk).update(checked_out_at=ist(9, 30))
        self.clock.at = ist(11, 0)
        out = self.post("/api/visitor/visits", {**self.BODY, "name": ""}, self.hr(self.hr_a))
        self.assertEqual((out["name"], out["aadhaar"], out["visitCount"]), ("Ravi Kumar", X, 2))
        # the desk at B gets B's identity, never A's (B's visit is still open, so check it out first)
        VisitorVisit.objects.filter(pk=self.visit_b.pk).update(checked_out_at=ist(10, 30))
        out = self.post("/api/reception-devices/visits", {**self.BODY, "name": ""}, self.desk(self.desk_b))
        self.assertEqual((out["name"], out["aadhaar"], out["visitCount"]), ("R. Kumar", Y, 2))

    def test_someone_only_another_branch_knows_needs_a_name(self):
        VisitorVisit.objects.filter(pk=self.visit_b.pk).delete()  # now known at unit A only
        for url, auth, extra in (
            ("/api/visitor/visits", self.hr(self.hr_b), {}),
            ("/api/reception-devices/visits", self.desk(self.desk_b), {}),
            ("/api/visitor/visits", self.hr(self.admin), {"branchId": self.b.id}),  # not bound to a branch: the same
        ):
            body = self.post(url, {**self.BODY, "name": "", **extra}, auth, 400)
            self.assertIn("visitor's name", body["error"])
        self.assertFalse(VisitorVisit.objects.filter(branch=self.b).exists())

    def test_already_inside_names_the_person_as_this_branch_knows_them(self):
        body = self.post("/api/visitor/visits", {**self.BODY, "name": "x"}, self.hr(self.hr_b), 409)
        self.assertEqual((body["code"], body["visitId"]), ("already_inside", self.visit_b.id))
        self.assertTrue(body["error"].startswith("R. Kumar is already inside"))
        body = self.post("/api/reception-devices/visits", {**self.BODY, "name": "x"}, self.desk(self.desk_a), 409)
        self.assertTrue(body["error"].startswith("Ravi Kumar is already inside"))

    def test_the_host_is_told_the_name_given_at_this_visit(self):
        with patch("api.email_service.send_email", return_value=None) as email:
            ovv._send_visitor_email(self.visit_b, self.host_a)
        self.assertEqual(email.call_args.kwargs["params"]["visitor_name"], "R. Kumar")
        with patch.object(whatsapp_notifications.whatsapp_service, "send_notification", return_value=None) as wa:
            whatsapp_notifications.notify_visitor_arrival(self.visit_b, self.host_a)
        args = wa.call_args
        self.assertEqual(args.args[2]["visitor_name"], "R. Kumar")
        self.assertNotIn("contact", args.kwargs)  # Meta's templates carry no contact card (2026-11-20)


# ═══ Report Center and the MD portal ═════════════════════════════════════════════════════════════════════════════════


class ReportTests(Fixture):
    def report(self, rid: str, user: HRUser, **params) -> dict:
        response = self.client.get(f"/api/reports/run/{rid}", {**NOV, **params}, **self.hr(user))
        self.assertEqual(response.status_code, 200, response.content[:400])
        return response.json()

    def test_register_and_notification_reports_show_the_visits_own_identity(self):
        rows = self.report("visitor-register", self.hr_a)["rows"]
        self.assertEqual([(r["visitorName"], r["aadhaarMasked"]) for r in rows], [("Ravi Kumar", "XXXX XXXX 3333")])
        rows = self.report("visitor-register", self.hr_b)["rows"]
        self.assertEqual([(r["visitorName"], r["aadhaarMasked"]) for r in rows], [("R. Kumar", "XXXX XXXX 6666")])
        rows = self.report("visitor-register", self.admin)["rows"]
        self.assertEqual([r["visitorName"] for r in rows], ["Ravi Kumar", "R. Kumar"])
        self.assertEqual(self.report("visitor-register", self.hr_b, q="ravi")["rows"], [])
        self.assertEqual(len(self.report("visitor-register", self.admin, q="ravi")["rows"]), 1)
        # a linked host so the notification report lists the visit
        VisitorVisit.objects.filter(pk=self.visit_b.pk).update(meeting_employee=self.host_a)
        rows = self.report("visitor-notification-delivery", self.admin)["rows"]
        self.assertEqual([r["visitorName"] for r in rows], ["R. Kumar"])

    def test_repeat_visitor_report_names_the_person_as_the_branch_in_view_was_told(self):
        def freq(user, **params):
            return [
                (r["visitorName"], r["aadhaarMasked"], r["visitsInPeriod"])
                for r in self.report("visitor-frequency", user, **params)["rows"]
            ]

        self.assertEqual(freq(self.hr_a), [("Ravi Kumar", "XXXX XXXX 3333", 1)])
        self.assertEqual(freq(self.hr_b), [("R. Kumar", "XXXX XXXX 6666", 1)])
        self.assertEqual(freq(self.admin), [("R. Kumar", "XXXX XXXX 6666", 2)])  # the latest visit in view
        self.assertEqual(freq(self.admin, branchIds=self.a.id), [("Ravi Kumar", "XXXX XXXX 3333", 1)])
        self.assertEqual(freq(self.hr_a, q="ravi"), [("Ravi Kumar", "XXXX XXXX 3333", 1)])
        self.assertEqual(freq(self.hr_b, q="ravi"), [])

    def test_report_files_never_carry_the_other_branchs_identity(self):
        response = self.client.get("/api/reports/export/visitor-register", {"fmt": "xlsx", **NOV}, **self.hr(self.hr_a))
        self.assertEqual(response.status_code, 200)
        text = text_of_xlsx(response.content)
        self.assertIn("Ravi Kumar", text)
        self.assertNotIn("R. Kumar", text)
        self.assertNotIn("6666", text)

    def test_md_lists_name_each_visit_as_given(self):
        qs = VisitorVisit.objects.order_by()  # as md_visitors._visit_qs hands it over
        _n, _visits, rows = md_visitors._repeat_visitor_rows(qs, 1, 10)
        self.assertEqual([r["visitorName"] for r in rows], ["R. Kumar"])  # the latest visit among the rows counted
        _n, _visits, rows = md_visitors._repeat_visitor_rows(qs.filter(branch=self.a), 1, 10)
        self.assertEqual([r["visitorName"] for r in rows], ["Ravi Kumar"])
        feed = md_visitors._with_visit_name(qs).values(*md_visitors.VISIT_FEED_VALUES).order_by("visited_at")
        self.assertEqual([md_visitors._visit_feed_item(r)["visitorName"] for r in feed], ["Ravi Kumar", "R. Kumar"])
        self.assertNotIn(X, json.dumps([md_visitors._visit_feed_item(r) for r in feed], default=str))


# ═══ the migration's backfill ════════════════════════════════════════════════════════════════════════════════════════


class BackfillTests(TestCase):
    def test_every_visit_without_a_name_gets_its_visitors_and_a_visit_with_one_keeps_it(self):
        migration = importlib.import_module("api.migrations.0165_visitor_visit_identity")
        branch = Branch.objects.create(name="VI Backfill", code="VIBF")
        ravi = Visitor.objects.create(name="Ravi Kumar", phone="90000 55555", aadhaar_number=X)
        sita = Visitor.objects.create(name="Sita", phone="90000 66666")
        old_1 = VisitorVisit.objects.create(visitor=ravi, branch=branch, whom_to_meet="A", purpose="p")
        old_2 = VisitorVisit.objects.create(visitor=sita, branch=None, whom_to_meet="B", purpose="p")
        own = VisitorVisit.objects.create(
            visitor=ravi, branch=branch, whom_to_meet="C", purpose="p", visitor_name="R. K", aadhaar_number=None
        )
        with connection.schema_editor() as editor:
            migration.backfill_visit_identity(django_apps, editor)
        got = {v.id: (v.visitor_name, v.aadhaar_number) for v in VisitorVisit.objects.all()}
        self.assertEqual(got[old_1.id], ("Ravi Kumar", X))
        self.assertEqual(got[old_2.id], ("Sita", None))
        self.assertEqual(got[own.id], ("R. K", None))
        # running it again changes nothing
        with connection.schema_editor() as editor:
            migration.backfill_visit_identity(django_apps, editor)
        self.assertEqual({v.id: (v.visitor_name, v.aadhaar_number) for v in VisitorVisit.objects.all()}, got)

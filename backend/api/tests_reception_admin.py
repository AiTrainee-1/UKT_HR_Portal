"""
Manage Reception (reception_admin_views.py, /api/reception-devices* on the HR side): the desk list with its counts, one
desk with its sessions, add / change / delete, reveal-password, sign-out, the tiles (overview), the records (the visits
each desk login checked in and out) and both files. Permissions (edit, view-only, hidden, "See desk passwords" hidden),
branch scope (a branch-bound HR user never reads, reveals, changes or exports another branch's desk), sign-outs on a
password / username change, switching off and Sign out everywhere, the audit trail, the wall between desk and HR tokens,
and that no payload or file ever carries a password, its hash, its encrypted copy, a login token, a phone or an Aadhaar.

Run via: DATABASE_URL="" DB_HOST=localhost DB_TEST_NAME=test_uktex_<you> py -3 manage.py test api.tests_reception_admin
"""

from __future__ import annotations

import io
import json
from datetime import timedelta

from django.db import connection
from django.test import TestCase
from django.test.utils import CaptureQueriesContext
from django.utils import timezone
from openpyxl import load_workbook

from . import reception_credentials as rc
from .clock import ist_today
from .jwt_utils import sign_token
from .models import (
    AuditLog,
    Branch,
    Department,
    Employee,
    HRUser,
    ReceptionDevice,
    ReceptionSession,
    Role,
    Visitor,
    VisitorVisit,
)

UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36"
OLD_KEYS = {
    "id",
    "name",
    "branchId",
    "branchName",
    "username",
    "isActive",
    "loginToken",
    "createdBy",
    "createdAt",
    "lastLoginAt",
}
NEW_KEYS = {
    "location",
    "notes",
    "updatedAt",
    "updatedBy",
    "passwordViewable",
    "activeSessions",
    "lastActivityAt",
    "counts",
}
COUNT_KEYS = {"today", "checkIns", "checkOuts", "total"}
PHONE = "98450 12210"
AADHAAR = "123456789012"


class FakeRequest:
    def __init__(self):
        self.META = {"HTTP_USER_AGENT": UA, "REMOTE_ADDR": "10.9.8.7"}
        self.headers = {}


def hr_bearer(user: HRUser) -> dict:
    claims = {"role": "hr", "hrUserId": user.id, "name": user.full_name or user.username}
    return {"HTTP_AUTHORIZATION": f"Bearer {sign_token(claims)}"}


class ReceptionAdminFixture(TestCase):
    def setUp(self):
        self.unit1 = Branch.objects.create(name="RA Unit 1")
        self.unit2 = Branch.objects.create(name="RA Unit 2")
        self.dept = Department.objects.create(name="RA Accounts")
        self.host = Employee.objects.create(
            employee_code="RA001",
            first_name="Karthik",
            last_name="Raja",
            status="active",
            employment_type="staff",
            branch=self.unit1,
            department=self.dept,
        )
        self.d1 = self.make_desk("Front Desk", "front.desk", "secret-one", self.unit1, location="Main lobby")
        # a desk whose password was set before 18 Nov 2026: a hash only, nothing to show
        self.d2 = ReceptionDevice.objects.create(
            name="Side Desk", branch=self.unit1, username="side.desk", password_hash="x", login_token="tok-side"
        )
        self.d3 = self.make_desk("Far Desk", "far.desk", "secret-three", self.unit2)

        now = timezone.now()
        old = now - timedelta(days=3)
        self.ramesh = Visitor.objects.create(name="Ramesh Kumar", phone=PHONE, aadhaar_number=AADHAAR)
        self.prakash = Visitor.objects.create(name="Prakash Sharma", phone="94000 00882")
        self.anand = Visitor.objects.create(name="Anand Natarajan", phone="97000 00554")
        self.dinesh = Visitor.objects.create(name="Dinesh Varma", phone="91000 00339")
        # d1: today a walk-in it checked in and out; three days ago a walk-in (never checked out); a QR visitor of today
        # it checked out. d3 (the other branch): a walk-in today.
        self.v1 = self.visit(
            self.ramesh,
            self.unit1,
            now,
            in_desk=self.d1,
            out_desk=self.d1,
            out=now,
            company="Apex Spares",
            host=self.host,
            purpose="Spindle repair",
        )
        self.v2 = self.visit(self.prakash, self.unit1, old, in_desk=self.d1, purpose="Audit")
        self.v3 = self.visit(self.anand, self.unit1, now, out_desk=self.d1, out=now, purpose="Cotton bales")
        self.v4 = self.visit(self.dinesh, self.unit2, now, in_desk=self.d3, purpose="Far purpose")
        # a visit no desk touched (HR registered it): never a desk record
        self.visit(self.prakash, self.unit1, now, purpose="HR only")

        self.admin = HRUser.objects.create(
            username="ra_admin", password_hash="x", full_name="Reception Admin", is_super_admin=True
        )
        self.hr = hr_bearer(self.admin)

    def make_desk(self, name, username, password, branch, **fields):
        desk = ReceptionDevice(name=name, branch=branch, username=username, login_token=f"tok-{username}", **fields)
        rc.set_desk_password(desk, password)
        desk.save()
        return desk

    def visit(self, visitor, branch, at, *, in_desk=None, out_desk=None, out=None, host=None, **fields):
        v = VisitorVisit.objects.create(
            visitor=visitor,
            branch=branch,
            whom_to_meet=fields.pop("whom", "Accounts"),
            purpose=fields.pop("purpose", "Meeting"),
            meeting_employee=host,
            checked_in_desk=in_desk,
            checked_out_desk=out_desk,
            checked_out_at=out,
            source="reception" if in_desk else "qr",
            **fields,
        )
        VisitorVisit.objects.filter(pk=v.pk).update(visited_at=at)
        v.refresh_from_db()
        return v

    def user(self, username, permissions, branch=None):
        role = Role.objects.create(name=f"RA {username}", permissions=permissions)
        return hr_bearer(HRUser.objects.create(username=username, password_hash="x", role=role, branch=branch))

    def session(self, desk, seen=None):
        s = rc.new_desk_session(desk, FakeRequest())
        if seen is not None:
            ReceptionSession.objects.filter(pk=s.pk).update(last_seen_at=seen)
            s.refresh_from_db()
        return s

    def desk_auth(self, desk) -> dict:
        _session, token = rc.start_desk_session(desk, FakeRequest())
        return {"HTTP_AUTHORIZATION": f"Bearer {token}"}

    # requests
    def get(self, path, auth=None, **params):
        return self.client.get(f"/api/reception-devices{path}", params, **(auth or self.hr))

    def put(self, desk, body, auth=None):
        return self.client.put(
            f"/api/reception-devices/{desk.id}", json.dumps(body), content_type="application/json", **(auth or self.hr)
        )

    def post(self, path, body=None, auth=None):
        return self.client.post(
            f"/api/reception-devices{path}",
            json.dumps(body or {}),
            content_type="application/json",
            **(auth or self.hr),
        )

    def assert_no_secrets(self, content: bytes | str, *, visitors: bool = True):
        text = content.decode("utf-8", "ignore") if isinstance(content, bytes) else content
        for desk in ReceptionDevice.objects.all():
            if desk.password_hash and desk.password_hash != "x":
                self.assertNotIn(desk.password_hash, text)
            if desk.password_encrypted:
                self.assertNotIn(desk.password_encrypted, text)
            self.assertNotIn(desk.login_token, text)
        for secret in ("secret-one", "secret-three", "password_hash", "password_encrypted", "passwordHash"):
            self.assertNotIn(secret, text)
        if visitors:
            for secret in (AADHAAR, "9012", PHONE, "9845012210", "94000 00882"):
                self.assertNotIn(secret, text)


# ═══ the list ════════════════════════════════════════════════════════════════════════════════════════════════════════


class ListTests(ReceptionAdminFixture):
    def test_every_old_key_stays_and_the_new_ones_come_with_counts(self):
        rows = {d["name"]: d for d in self.get("").json()}
        self.assertEqual(set(rows), {"Front Desk", "Side Desk", "Far Desk"})
        front = rows["Front Desk"]
        self.assertEqual(set(front), OLD_KEYS | NEW_KEYS)
        self.assertEqual(set(front["counts"]), COUNT_KEYS)
        # all time: 2 check-ins (today + 3 days ago), 2 check-outs (today); today: 1 check-in + 2 check-outs
        self.assertEqual(front["counts"], {"today": 3, "checkIns": 2, "checkOuts": 2, "total": 4})
        self.assertEqual(rows["Far Desk"]["counts"], {"today": 1, "checkIns": 1, "checkOuts": 0, "total": 1})
        self.assertEqual(front["location"], "Main lobby")
        self.assertTrue(front["passwordViewable"])
        self.assertFalse(rows["Side Desk"]["passwordViewable"])
        self.assertEqual(rows["Side Desk"]["counts"]["total"], 0)
        self.assertIsNone(rows["Side Desk"]["lastActivityAt"])
        self.assertIsNotNone(front["lastActivityAt"])
        self.assertEqual(front["loginToken"], "tok-front.desk")  # the old dialog's link still works

    def test_active_sessions_count_open_and_recent_ones_only(self):
        self.session(self.d1)
        self.session(self.d1)
        gone = self.session(self.d1)
        rc.end_desk_session(gone)
        self.session(self.d1, seen=timezone.now() - timedelta(days=40))  # its token expired long ago
        rows = {d["name"]: d for d in self.get("").json()}
        self.assertEqual(rows["Front Desk"]["activeSessions"], 2)
        self.assertEqual(rows["Side Desk"]["activeSessions"], 0)

    def test_search_status_and_branch_filters(self):
        names = lambda **p: sorted(d["name"] for d in self.get("", **p).json())  # noqa: E731
        self.assertEqual(names(q="front"), ["Front Desk"])
        self.assertEqual(names(q="far.desk"), ["Far Desk"])
        self.assertEqual(names(q="lobby"), ["Front Desk"])  # location
        self.assertEqual(names(q="unit 2"), ["Far Desk"])  # branch name
        ReceptionDevice.objects.filter(pk=self.d2.pk).update(is_active=False)
        self.assertEqual(names(deskStatus="inactive"), ["Side Desk"])
        self.assertEqual(names(deskStatus="active"), ["Far Desk", "Front Desk"])
        self.assertEqual(names(branchId=self.unit2.id), ["Far Desk"])
        self.assertEqual(self.get("", deskStatus="maybe").status_code, 400)
        self.assertEqual(self.get("", branchId="x").status_code, 400)

    def test_the_list_costs_the_same_queries_for_three_or_ten_desks(self):
        def cost():
            with CaptureQueriesContext(connection) as ctx:
                self.assertEqual(self.get("").status_code, 200)
            return len(ctx.captured_queries)

        few = cost()
        for i in range(7):
            desk = self.make_desk(f"Extra {i}", f"extra{i}", "secret-x", self.unit1)
            self.visit(self.ramesh, self.unit1, timezone.now(), in_desk=desk, out_desk=desk, out=timezone.now())
            self.session(desk)
        self.assertEqual(cost(), few)

    def test_a_branch_bound_user_sees_only_their_branch(self):
        scoped = self.user("ra_scoped", {"outpass_visitors": "edit"}, branch=self.unit1)
        names = sorted(d["name"] for d in self.get("", auth=scoped).json())
        self.assertEqual(names, ["Front Desk", "Side Desk"])
        names = sorted(d["name"] for d in self.get("", auth=scoped, branchId=self.unit2.id).json())
        self.assertEqual(names, ["Front Desk", "Side Desk"])

    def test_no_secret_in_the_list(self):
        self.assert_no_secrets(
            json.dumps([{k: v for k, v in d.items() if k != "loginToken"} for d in self.get("").json()])
        )


# ═══ one desk ════════════════════════════════════════════════════════════════════════════════════════════════════════


class DetailTests(ReceptionAdminFixture):
    def test_detail_is_the_list_entry_plus_its_live_sessions(self):
        live = self.session(self.d1)
        ended = self.session(self.d1)
        rc.end_desk_session(ended)
        body = self.get(f"/{self.d1.id}").json()
        self.assertEqual(set(body), OLD_KEYS | NEW_KEYS | {"sessions"})
        self.assertEqual(body["counts"]["total"], 4)
        self.assertEqual(body["activeSessions"], 1)
        self.assertEqual([s["id"] for s in body["sessions"]], [live.id])
        self.assertEqual(set(body["sessions"][0]), {"id", "deviceLabel", "createdAt", "lastSeenAt"})
        self.assertIn("Chrome", body["sessions"][0]["deviceLabel"])
        raw = self.get(f"/{self.d1.id}").content.decode()
        self.assertNotIn(live.sid, raw)
        self.assertNotIn(self.d1.password_encrypted, raw)

    def test_unknown_and_other_branch_desks_are_not_found(self):
        self.assertEqual(self.get("/999999").status_code, 404)
        scoped = self.user("ra_scoped", {"outpass_visitors": "edit"}, branch=self.unit1)
        self.assertEqual(self.get(f"/{self.d3.id}", auth=scoped).status_code, 404)
        self.assertEqual(self.get(f"/{self.d1.id}", auth=scoped).status_code, 200)


class CreateTests(ReceptionAdminFixture):
    def test_add_a_desk_with_its_details(self):
        r = self.post(
            "",
            {
                "name": "Gate Desk",
                "branchId": self.unit1.id,
                "username": "gate.desk",
                "password": "desk-pass",
                "location": "  Near the main gate ",
                "notes": "Day shift only",
            },
        )
        self.assertEqual(r.status_code, 201, r.content)
        body = r.json()
        self.assertTrue(OLD_KEYS <= set(body))
        self.assertEqual(body["location"], "Near the main gate")
        self.assertEqual(body["notes"], "Day shift only")
        self.assertTrue(body["passwordViewable"])
        self.assertEqual(body["createdBy"], "Reception Admin")
        self.assertEqual(body["counts"], {"today": 0, "checkIns": 0, "checkOuts": 0, "total": 0})
        self.assertNotIn("desk-pass", r.content.decode())
        desk = ReceptionDevice.objects.get(username="gate.desk")
        self.assertEqual(rc.reveal_desk_password(desk), "desk-pass")
        self.assertTrue(rc.check_desk_password(desk, "desk-pass"))
        log = AuditLog.objects.get(action="create", module="outpass_visitors", record_id=desk.id)
        self.assertIn("Gate Desk", log.record_description)
        self.assertNotIn("desk-pass", f"{log.record_description}{log.new_values}")

    def test_bad_input(self):
        base = {"name": "X Desk", "branchId": self.unit1.id, "username": "x.desk", "password": "secret-x"}
        self.assertEqual(self.post("", {**base, "name": ""}).status_code, 400)
        self.assertEqual(self.post("", {**base, "username": "ab"}).status_code, 400)
        self.assertEqual(self.post("", {**base, "username": "has space"}).status_code, 400)
        self.assertEqual(self.post("", {**base, "password": "short"}).status_code, 400)
        self.assertEqual(self.post("", {**base, "location": 7}).status_code, 400)
        self.assertEqual(self.post("", {**base, "branchId": 999999}).status_code, 404)
        self.assertEqual(self.post("", {**base, "username": "FRONT.DESK"}).status_code, 409)
        self.assertEqual(self.post("", base).status_code, 201)

    def test_a_branch_bound_user_always_adds_to_their_own_branch(self):
        scoped = self.user("ra_scoped", {"outpass_visitors": "edit"}, branch=self.unit1)
        r = self.post(
            "",
            {"name": "Own Desk", "branchId": self.unit2.id, "username": "own.desk", "password": "secret-own"},
            auth=scoped,
        )
        self.assertEqual(r.status_code, 201)
        self.assertEqual(r.json()["branchId"], self.unit1.id)


class UpdateTests(ReceptionAdminFixture):
    def test_change_the_details_and_stamp_who_and_when(self):
        r = self.put(self.d1, {"name": "Front Desk A", "location": "Office side", "notes": ""})
        self.assertEqual(r.status_code, 200, r.content)
        body = r.json()
        self.assertEqual((body["name"], body["location"], body["notes"]), ("Front Desk A", "Office side", None))
        self.assertEqual(body["updatedBy"], "Reception Admin")
        self.assertIsNotNone(body["updatedAt"])
        self.assertEqual(body["counts"]["total"], 4)
        log = AuditLog.objects.filter(action="update", record_id=self.d1.id).latest("id")
        self.assertIn("name", log.record_description)
        self.assertEqual(log.old_values["name"], "Front Desk")
        self.assertEqual(log.new_values["name"], "Front Desk A")

    def test_a_rename_keeps_sessions_and_a_new_username_ends_them(self):
        s = self.session(self.d1)
        self.assertEqual(self.put(self.d1, {"name": "Renamed"}).status_code, 200)
        s.refresh_from_db()
        self.assertIsNone(s.revoked_at)
        self.assertEqual(self.put(self.d1, {"username": "FRONT.desk"}).status_code, 200)  # letter case only
        s.refresh_from_db()
        self.assertIsNone(s.revoked_at)
        self.assertEqual(self.put(self.d1, {"username": "lobby.desk"}).status_code, 200)
        s.refresh_from_db()
        self.assertEqual(s.revoked_reason, ReceptionSession.REVOKED_USERNAME_CHANGED)
        self.assertEqual(ReceptionDevice.objects.get(pk=self.d1.pk).username, "lobby.desk")

    def test_a_username_in_use_is_409_whatever_its_case(self):
        self.assertEqual(self.put(self.d1, {"username": "SIDE.DESK"}).status_code, 409)
        self.assertEqual(ReceptionDevice.objects.get(pk=self.d1.pk).username, "front.desk")
        self.assertEqual(self.put(self.d1, {"username": "a b c"}).status_code, 400)

    def test_a_new_password_is_viewable_and_signs_every_browser_out(self):
        s1, s2 = self.session(self.d2), self.session(self.d2)
        other = self.session(self.d1)
        r = self.put(self.d2, {"password": "new-secret"})
        self.assertEqual(r.status_code, 200)
        self.assertTrue(r.json()["passwordViewable"])
        self.assertNotIn("new-secret", r.content.decode())
        for s in (s1, s2):
            s.refresh_from_db()
            self.assertEqual(s.revoked_reason, ReceptionSession.REVOKED_PASSWORD_CHANGED)
        other.refresh_from_db()
        self.assertIsNone(other.revoked_at)
        log = AuditLog.objects.filter(action="update", record_id=self.d2.id).latest("id")
        self.assertIn("password", log.record_description)
        self.assertIn("2 signed-in browsers signed out", log.record_description)
        self.assertEqual(log.new_values, {"password": "changed"})
        self.assertNotIn("new-secret", f"{log.record_description}{log.new_values}")
        self.assertEqual(self.put(self.d2, {"password": "short"}).status_code, 400)

    def test_switching_off_signs_out_and_switching_on_is_logged(self):
        s = self.session(self.d1)
        r = self.put(self.d1, {"isActive": False})
        self.assertFalse(r.json()["isActive"])
        s.refresh_from_db()
        self.assertEqual(s.revoked_reason, ReceptionSession.REVOKED_DEACTIVATED)
        self.assertTrue(
            AuditLog.objects.filter(
                record_id=self.d1.id, record_description__startswith="Switched off reception desk"
            ).exists()
        )
        self.put(self.d1, {"isActive": True})
        self.assertTrue(
            AuditLog.objects.filter(
                record_id=self.d1.id, record_description__startswith="Switched on reception desk"
            ).exists()
        )

    def test_branch_moves(self):
        self.assertEqual(self.put(self.d1, {"branchId": self.unit2.id}).json()["branchId"], self.unit2.id)
        self.assertEqual(self.put(self.d1, {"branchId": 999999}).status_code, 404)
        self.assertEqual(self.put(self.d1, {"branchId": "two"}).status_code, 400)
        scoped = self.user("ra_scoped", {"outpass_visitors": "edit"}, branch=self.unit1)
        self.assertEqual(self.put(self.d2, {"branchId": self.unit2.id}, auth=scoped).status_code, 403)
        self.assertEqual(self.put(self.d2, {"branchId": self.unit1.id, "name": "B"}, auth=scoped).status_code, 200)

    def test_bad_input_and_another_branch(self):
        self.assertEqual(self.put(self.d1, {"name": "  "}).status_code, 400)
        self.assertEqual(self.put(self.d1, {"isActive": "sometimes"}).status_code, 400)
        self.assertEqual(self.put(self.d1, {"location": 5}).status_code, 400)
        scoped = self.user("ra_scoped", {"outpass_visitors": "edit"}, branch=self.unit1)
        self.assertEqual(self.put(self.d3, {"name": "Mine now"}, auth=scoped).status_code, 404)
        self.assertEqual(ReceptionDevice.objects.get(pk=self.d3.pk).name, "Far Desk")

    def test_an_hr_change_ends_a_sign_in_lock(self):
        for _ in range(5):
            rc.record_login_attempt("front.desk", "1.2.3.4", False)
        self.assertTrue(rc.login_locked_out("front.desk"))
        self.put(self.d1, {"password": "fresh-pass"})
        self.assertFalse(rc.login_locked_out("front.desk"))


class DeleteTests(ReceptionAdminFixture):
    def test_delete_keeps_the_visits_and_is_logged(self):
        desk_id = self.d1.id
        r = self.client.delete(f"/api/reception-devices/{desk_id}", **self.hr)
        self.assertEqual(r.status_code, 204)
        self.assertFalse(ReceptionDevice.objects.filter(pk=desk_id).exists())
        self.v1.refresh_from_db()
        self.assertIsNone(self.v1.checked_in_desk_id)  # the visit stays, the desk link is cleared
        self.assertEqual(VisitorVisit.objects.filter(pk__in=[self.v1.pk, self.v2.pk, self.v3.pk]).count(), 3)
        self.assertTrue(AuditLog.objects.filter(action="delete", module="outpass_visitors", record_id=desk_id).exists())

    def test_another_branch_cannot_delete(self):
        scoped = self.user("ra_scoped", {"outpass_visitors": "edit"}, branch=self.unit1)
        self.assertEqual(self.client.delete(f"/api/reception-devices/{self.d3.id}", **scoped).status_code, 404)
        self.assertTrue(ReceptionDevice.objects.filter(pk=self.d3.pk).exists())


# ═══ reveal + sign-out ═══════════════════════════════════════════════════════════════════════════════════════════════


class RevealTests(ReceptionAdminFixture):
    def test_reveal_shows_the_password_and_records_the_view(self):
        r = self.post(f"/{self.d1.id}/reveal-password")
        self.assertEqual(r.status_code, 200)
        self.assertEqual(r.json(), {"password": "secret-one"})
        self.assertEqual(r["Cache-Control"], "no-store")
        log = AuditLog.objects.get(action="view_password", module="outpass_visitors", record_id=self.d1.id)
        self.assertIn("Front Desk", log.record_description)
        self.assertNotIn("secret-one", f"{log.record_description}{log.old_values}{log.new_values}")

    def test_a_desk_set_before_passwords_were_kept_says_not_stored(self):
        r = self.post(f"/{self.d2.id}/reveal-password")
        self.assertEqual(r.status_code, 409)
        self.assertEqual(r.json()["code"], "not_stored")
        self.assertIn("Set a new password", r.json()["error"])
        self.assertFalse(AuditLog.objects.filter(action="view_password").exists())

    def test_another_branch_cannot_reveal(self):
        scoped = self.user(
            "ra_scoped",
            {"outpass_visitors": "edit", "outpass_visitors.visitors.reception_devices.view_password": "edit"},
            branch=self.unit1,
        )
        self.assertEqual(self.post(f"/{self.d3.id}/reveal-password", auth=scoped).status_code, 404)
        self.assertEqual(self.post(f"/{self.d1.id}/reveal-password", auth=scoped).json()["password"], "secret-one")

    def test_see_desk_passwords_hidden_or_view_refuses_even_with_edit_on_desks(self):
        key = "outpass_visitors.visitors.reception_devices.view_password"
        hidden = self.user("ra_nopw", {"outpass_visitors": "edit", key: "hidden"})
        self.assertEqual(self.post(f"/{self.d1.id}/reveal-password", auth=hidden).status_code, 403)
        self.assertEqual(self.put(self.d1, {"name": "Still mine"}, auth=hidden).status_code, 200)
        view = self.user("ra_viewpw", {"outpass_visitors": "edit", key: "view"})
        self.assertEqual(self.post(f"/{self.d1.id}/reveal-password", auth=view).status_code, 403)
        self.assertFalse(AuditLog.objects.filter(action="view_password").exists())


class RevealIsExplicitTests(ReceptionAdminFixture):
    """S4 (19 Nov 2026): "See desk passwords" is off unless a role sets it itself."""

    def test_edit_on_the_page_without_the_key_cannot_reveal_and_with_it_can(self):
        auth = self.user("ra_noexplicit", {"outpass_visitors": "edit"})
        self.assertEqual(self.post(f"/{self.d1.id}/reveal-password", auth=auth).status_code, 403)
        auth = self.user(
            "ra_explicit",
            {"outpass_visitors": "view", "outpass_visitors.visitors.reception_devices.view_password": "edit"},
        )
        self.assertEqual(self.post(f"/{self.d1.id}/reveal-password", auth=auth).json(), {"password": "secret-one"})
        md = HRUser.objects.create(username="ra_md", password_hash="x", full_name="MD", is_md=True)
        self.assertEqual(self.post(f"/{self.d1.id}/reveal-password", auth=hr_bearer(md)).status_code, 403)


class ConcurrentChangeTests(ReceptionAdminFixture):
    """S5 (19 Nov 2026): a PUT writes only the columns it changed."""

    def test_a_rename_does_not_undo_a_password_reset_or_a_switch_off_made_meanwhile(self):
        from unittest import mock

        from . import reception_admin_views as rav

        real = rav._apply_update

        def meanwhile(request, desk, data):
            out = real(request, desk, data)
            ReceptionDevice.objects.filter(pk=desk.pk).update(password_hash="reset-by-someone-else", is_active=False)
            return out

        with mock.patch.object(rav, "_apply_update", meanwhile):
            self.assertEqual(self.put(self.d1, {"name": "Front Desk East"}).status_code, 200)
        self.d1.refresh_from_db()
        self.assertEqual(self.d1.name, "Front Desk East")
        self.assertEqual((self.d1.password_hash, self.d1.is_active), ("reset-by-someone-else", False))


class SignOutTests(ReceptionAdminFixture):
    def test_sign_out_everywhere_ends_every_open_session_of_that_desk(self):
        a, b = self.session(self.d1), self.session(self.d1)
        other = self.session(self.d3)
        self.assertEqual(self.post(f"/{self.d1.id}/sign-out").json(), {"signedOut": 2})
        for s in (a, b):
            s.refresh_from_db()
            self.assertEqual(s.revoked_reason, ReceptionSession.REVOKED_HR_SIGNED_OUT)
        other.refresh_from_db()
        self.assertIsNone(other.revoked_at)
        self.assertEqual(self.post(f"/{self.d1.id}/sign-out").json(), {"signedOut": 0})
        self.assertTrue(
            AuditLog.objects.filter(action="update", record_id=self.d1.id, record_description__contains="Signed out")
        )
        self.assertEqual(self.get(f"/{self.d1.id}").json()["sessions"], [])

    def test_another_branch_cannot_sign_out(self):
        s = self.session(self.d3)
        scoped = self.user("ra_scoped", {"outpass_visitors": "edit"}, branch=self.unit1)
        self.assertEqual(self.post(f"/{self.d3.id}/sign-out", auth=scoped).status_code, 404)
        s.refresh_from_db()
        self.assertIsNone(s.revoked_at)


# ═══ permissions + the wall between desk and HR tokens ═══════════════════════════════════════════════════════════════


class PermissionTests(ReceptionAdminFixture):
    def test_view_only_reads_everything_and_changes_nothing(self):
        view = self.user("ra_view", {"outpass_visitors": "view"})
        for path in ("", f"/{self.d1.id}", "/overview", "/records"):
            self.assertEqual(self.get(path, auth=view).status_code, 200, path)
        self.assertEqual(self.get("/records/export", auth=view, fmt="xlsx").status_code, 200)
        self.assertEqual(self.get("/export", auth=view, fmt="pdf").status_code, 200)
        self.assertEqual(self.put(self.d1, {"name": "Nope"}, auth=view).status_code, 403)
        self.assertEqual(self.post(f"/{self.d1.id}/reveal-password", auth=view).status_code, 403)
        self.assertEqual(self.post(f"/{self.d1.id}/sign-out", auth=view).status_code, 403)
        self.assertEqual(self.client.delete(f"/api/reception-devices/{self.d1.id}", **view).status_code, 403)
        body = {"name": "N", "branchId": self.unit1.id, "username": "nnn", "password": "123456"}
        self.assertEqual(self.post("", body, auth=view).status_code, 403)
        self.assertEqual(ReceptionDevice.objects.get(pk=self.d1.pk).name, "Front Desk")

    def test_hidden_gets_nothing(self):
        hidden = self.user(
            "ra_hidden", {"outpass_visitors": "edit", "outpass_visitors.visitors.reception_devices": "hidden"}
        )
        for path in ("", f"/{self.d1.id}", "/overview", "/records", "/records/export", "/export"):
            self.assertEqual(self.get(path, auth=hidden, fmt="xlsx").status_code, 403, path)
        self.assertEqual(self.post(f"/{self.d1.id}/reveal-password", auth=hidden).status_code, 403)
        # the Visitors page itself still answers them
        self.assertEqual(self.client.get("/api/visitor/summary", **hidden).status_code, 200)

    def test_no_token_and_a_desk_token_on_hr_endpoints(self):
        self.assertEqual(self.client.get("/api/reception-devices/overview").status_code, 401)
        desk = self.desk_auth(self.d1)
        for path in ("", "/overview", "/records", f"/{self.d1.id}"):
            self.assertEqual(self.client.get(f"/api/reception-devices{path}", **desk).status_code, 403, path)
        self.assertEqual(
            self.client.post(f"/api/reception-devices/{self.d1.id}/reveal-password", **desk).status_code, 403
        )
        self.assertEqual(self.client.post(f"/api/reception-devices/{self.d1.id}/sign-out", **desk).status_code, 403)

    def test_an_hr_token_is_refused_on_the_desk_endpoints(self):
        for path in ("/me", "/summary", "/visits", "/visits/export"):
            self.assertEqual(self.get(path, fmt="xlsx").status_code, 403, path)
        self.assertEqual(self.post("/logout").status_code, 403)
        self.assertEqual(
            self.post("/visits", {"phone": "9000000000", "purpose": "x", "whomToMeet": "y"}).status_code, 403
        )


# ═══ the tiles ═══════════════════════════════════════════════════════════════════════════════════════════════════════


class OverviewTests(ReceptionAdminFixture):
    def test_the_tiles(self):
        self.session(self.d1)
        self.session(self.d1, seen=timezone.now() - timedelta(hours=2))  # open but not seen lately
        ReceptionDevice.objects.filter(pk=self.d2.pk).update(is_active=False)
        body = self.get("/overview").json()
        self.assertEqual(
            body,
            {
                "desks": 3,
                "active": 2,
                "signedInNow": 1,
                "checkInsToday": 2,  # v1 (d1) + v4 (d3)
                "checkOutsToday": 2,  # v1 + v3 (d1)
                "checkIns": 3,  # no dates: all time
                "checkOuts": 2,
            },
        )
        today = ist_today().isoformat()
        ranged = self.get("/overview", **{"from": today, "to": today}).json()
        self.assertEqual((ranged["checkIns"], ranged["checkOuts"]), (2, 2))
        self.assertEqual(self.get("/overview", branchId=self.unit2.id).json()["desks"], 1)
        self.assertEqual(self.get("/overview", **{"from": "18-11-2026"}).status_code, 400)

    def test_a_branch_bound_user_counts_their_branch_only(self):
        scoped = self.user("ra_scoped", {"outpass_visitors": "view"}, branch=self.unit1)
        body = self.get("/overview", auth=scoped, branchId=self.unit2.id).json()
        self.assertEqual((body["desks"], body["checkInsToday"], body["checkIns"]), (2, 1, 2))


# ═══ records ═════════════════════════════════════════════════════════════════════════════════════════════════════════


class RecordsTests(ReceptionAdminFixture):
    def records(self, auth=None, **params):
        r = self.get("/records", auth=auth, **params)
        self.assertEqual(r.status_code, 200, r.content)
        return r.json()

    def test_one_desk_with_counts_and_paging(self):
        body = self.records(deskId=self.d1.id, pageSize=3)
        self.assertEqual(body["total"], 4)
        self.assertEqual(len(body["items"]), 3)
        self.assertEqual(body["counts"], {"checkIns": 2, "checkOuts": 2, "total": 4})
        self.assertEqual({r["desk"]["name"] for r in body["items"]}, {"Front Desk"})
        self.assertEqual(len(self.records(deskId=self.d1.id, pageSize=3, page=2)["items"]), 1)
        item = next(r for r in body["items"] if r["id"] == f"in-{self.v1.id}")
        self.assertEqual(set(item), {"id", "at", "type", "typeLabel", "desk", "visit"})
        self.assertEqual((item["type"], item["typeLabel"]), ("check_in", "Check-in"))
        self.assertEqual(
            set(item["visit"]),
            {
                "id",
                "visitorName",
                "company",
                "peopleCount",
                "host",
                "hostDepartment",
                "purpose",
                "badgeNumber",
                "status",
                "statusLabel",
                "visitedAt",
                "checkedOutAt",
                "minutesInside",
                "branchName",
            },
        )
        self.assertEqual(
            (item["visit"]["visitorName"], item["visit"]["company"], item["visit"]["host"], item["visit"]["status"]),
            ("Ramesh Kumar", "Apex Spares", "Karthik Raja", "checked_out"),
        )
        self.assertEqual(item["visit"]["hostDepartment"], "RA Accounts")
        # newest first: the three of today before the one of three days ago
        self.assertEqual(self.records(deskId=self.d1.id)["items"][-1]["id"], f"in-{self.v2.id}")

    def test_every_filter_changes_the_rows(self):
        today = ist_today().isoformat()
        self.assertEqual(self.records(deskId=self.d1.id, **{"from": today, "to": today})["total"], 3)
        self.assertEqual(self.records(deskId=self.d1.id, type="check_in")["total"], 2)
        self.assertEqual(self.records(deskId=self.d1.id, type="check_out")["total"], 2)
        self.assertEqual(self.records(deskId=self.d1.id, q="ramesh")["total"], 2)
        self.assertEqual(self.records(deskId=self.d1.id, q="apex spares")["total"], 2)
        self.assertEqual(self.records(deskId=self.d1.id, q="nobody")["total"], 0)
        self.assertEqual(self.records(deskId=f"{self.d1.id},{self.d3.id}")["total"], 5)
        self.assertEqual(self.records()["total"], 5)  # every desk
        self.assertEqual(self.records(branchId=self.unit2.id)["total"], 1)
        # the counts cover both types whatever ?type says
        self.assertEqual(self.records(deskId=self.d1.id, type="check_in")["counts"]["checkOuts"], 2)

    def test_bad_params_are_400(self):
        for params in ({"from": "yesterday"}, {"type": "lunch"}, {"deskId": "x"}, {"branchId": "y"}):
            self.assertEqual(self.get("/records", **params).status_code, 400, params)
        today = ist_today()
        bad = {"from": today.isoformat(), "to": (today - timedelta(days=1)).isoformat()}
        self.assertEqual(self.get("/records", **bad).status_code, 400)

    def test_a_branch_bound_user_never_reads_another_branch(self):
        scoped = self.user("ra_scoped", {"outpass_visitors": "view"}, branch=self.unit1)
        self.assertEqual(self.records(auth=scoped)["total"], 4)
        self.assertEqual(self.records(auth=scoped, deskId=self.d3.id)["total"], 0)
        self.assertEqual(self.records(auth=scoped, branchId=self.unit2.id)["total"], 4)

    def test_no_secret_no_phone_no_aadhaar_in_the_records(self):
        self.assert_no_secrets(self.get("/records").content)


# ═══ files ═══════════════════════════════════════════════════════════════════════════════════════════════════════════


def workbook_text(content: bytes) -> str:
    wb = load_workbook(io.BytesIO(content), read_only=True)
    cells = []
    for ws in wb.worksheets:
        for row in ws.iter_rows(values_only=True):
            cells.extend(str(v) for v in row if v is not None)
    return "\n".join(cells)


class ExportTests(ReceptionAdminFixture):
    def test_records_xlsx_of_one_desk(self):
        r = self.get("/records/export", fmt="xlsx", deskId=self.d1.id, type="check_in")
        self.assertEqual(r.status_code, 200, r.content[:300])
        self.assertIn("spreadsheetml", r["Content-Type"])
        self.assertRegex(r["Content-Disposition"], r'filename="reception_records_front_desk_\d{8}_\d{4}\.xlsx"')
        text = workbook_text(r.content)
        self.assertIn("RECEPTION RECORDS - FRONT DESK", text.upper())
        self.assertIn("Ramesh Kumar", text)
        self.assertIn("Prakash Sharma", text)
        self.assertNotIn("Anand Natarajan", text)  # a check-out only: type=check_in left it out
        self.assertNotIn("Dinesh Varma", text)
        self.assert_no_secrets(text)
        log = AuditLog.objects.filter(action="export", module="outpass_visitors").latest("id")
        self.assertIn("Reception records - Front Desk", log.record_description)

    def test_records_pdf_of_every_desk(self):
        r = self.get("/records/export", fmt="pdf")
        self.assertEqual(r.status_code, 200)
        self.assertTrue(r.content.startswith(b"%PDF"))
        self.assertRegex(r["Content-Disposition"], r'filename="reception_records_\d{8}_\d{4}\.pdf"')

    def test_records_export_bad_input(self):
        self.assertEqual(self.get("/records/export", fmt="csv").status_code, 400)
        self.assertEqual(self.get("/records/export", fmt="xlsx", type="lunch").status_code, 400)

    def test_a_branch_bound_user_exports_only_their_branch(self):
        scoped = self.user("ra_scoped", {"outpass_visitors": "view"}, branch=self.unit1)
        text = workbook_text(self.get("/records/export", auth=scoped, fmt="xlsx", deskId=self.d3.id).content)
        self.assertNotIn("Far Desk", text)  # not even its name in the title
        self.assertNotIn("Dinesh Varma", text)
        text = workbook_text(self.get("/export", auth=scoped, fmt="xlsx").content)
        self.assertIn("Front Desk", text)
        self.assertNotIn("Far Desk", text)

    def test_the_desk_list_files_have_no_password_and_no_login_link(self):
        self.session(self.d1)
        r = self.get("/export", fmt="xlsx")
        self.assertEqual(r.status_code, 200)
        self.assertRegex(r["Content-Disposition"], r'filename="reception_desks_\d{8}_\d{4}\.xlsx"')
        text = workbook_text(r.content)
        for expected in ("Front Desk", "Side Desk", "Far Desk", "front.desk", "Main lobby", "Switched on"):
            self.assertIn(expected, text)
        self.assert_no_secrets(text)
        pdf = self.get("/export", fmt="pdf")
        self.assertTrue(pdf.content.startswith(b"%PDF"))
        self.assertEqual(self.get("/export", fmt="doc").status_code, 400)

    def test_the_desk_list_file_follows_the_list_filters(self):
        ReceptionDevice.objects.filter(pk=self.d2.pk).update(is_active=False)
        text = workbook_text(self.get("/export", fmt="xlsx", deskStatus="inactive").content)
        self.assertIn("Side Desk", text)
        self.assertNotIn("Front Desk", text)
        text = workbook_text(self.get("/export", fmt="xlsx", q="far").content)
        self.assertIn("Far Desk", text)
        self.assertNotIn("Side Desk", text)

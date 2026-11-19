"""
Manage Gates (gate_admin_views.py, /api/gate-devices*): the gate list with its counts, one gate with its sessions, add /
change / delete, reveal-password, sign-out, the tiles, the records and both files. Permissions (edit, view-only, hidden,
"See gate passwords" hidden), branch scope (a branch-bound HR user never reads, reveals, changes or exports another
branch's gate), sign-outs on a password / username change, switching off and Sign out everywhere, the audit trail, and
that no payload or file ever carries a password, its hash, its encrypted copy or a login token.

Run via: DATABASE_URL="" DB_HOST=localhost DB_TEST_NAME=test_uktex_<you> py -3 manage.py test api.tests_gate_admin
"""

from __future__ import annotations

import io
import json
from datetime import timedelta

from unittest import mock

from django.db import connection
from django.test import TestCase
from django.test.utils import CaptureQueriesContext
from django.utils import timezone
from openpyxl import load_workbook

from . import gate_credentials as gc
from .clock import ist_today
from .jwt_utils import sign_token
from .models import (
    AuditLog,
    Branch,
    Department,
    Employee,
    GateDevice,
    GateSession,
    HRUser,
    OutpassGateScan,
    OutpassRequest,
    Role,
    TeaBreakLog,
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
    "allowOutpass",
    "allowTeaBreak",
    "updatedAt",
    "updatedBy",
    "passwordViewable",
    "activeSessions",
    "lastActivityAt",
    "counts",
}
COUNT_KEYS = {"today", "exits", "returns", "teaOut", "teaIn", "denied", "total"}


class FakeRequest:
    def __init__(self):
        self.META = {"HTTP_USER_AGENT": UA, "REMOTE_ADDR": "10.9.8.7"}
        self.headers = {}


def bearer(user: HRUser) -> dict:
    claims = {"role": "hr", "hrUserId": user.id, "name": user.full_name or user.username}
    return {"HTTP_AUTHORIZATION": f"Bearer {sign_token(claims)}"}


class GateAdminFixture(TestCase):
    def setUp(self):
        self.unit1 = Branch.objects.create(name="GA Unit 1")
        self.unit2 = Branch.objects.create(name="GA Unit 2")
        self.dept = Department.objects.create(name="GA Weaving", branch=self.unit1)
        self.g1 = self.make_gate("Main Gate", "main.gate1", "secret-one", self.unit1, location="Spinning side")
        # a gate whose password was set before 18 Nov 2026: a hash only, nothing to show
        self.g2 = GateDevice.objects.create(
            name="Back Gate", branch=self.unit1, username="back.gate", password_hash="x", login_token="tok-back"
        )
        self.g3 = self.make_gate("Far Gate", "far.gate", "secret-three", self.unit2)
        self.ravi = Employee.objects.create(
            employee_code="GA001",
            first_name="Ravi",
            last_name="Kumar",
            status="active",
            employment_type="staff",
            branch=self.unit1,
            department=self.dept,
        )
        self.pass_ = OutpassRequest.objects.create(
            employee=self.ravi, destination="Canara Bank", reason="cash", status="approved"
        )
        now = timezone.now()
        old = now - timedelta(days=3)
        # g1: today an exit, a return and a denied exit; three days ago one exit; today a tea break out + in
        self.scan(self.g1, "exit", "success", now, "Exit recorded")
        self.scan(self.g1, "entry", "success", now, "Return recorded")
        self.scan(self.g1, "exit", "expired", now, "This Outpass has expired.")
        self.scan(self.g1, "exit", "success", old, "Exit recorded")
        TeaBreakLog.objects.create(employee=self.ravi, out_gate=self.g1, out_at=now, in_gate=self.g1, in_at=now)
        # g3 (the other branch): one exit today
        self.scan(self.g3, "exit", "success", now, "Far exit")

        self.admin = HRUser.objects.create(
            username="ga_admin", password_hash="x", full_name="Gate Admin", is_super_admin=True
        )
        self.hr = bearer(self.admin)

    def make_gate(self, name, username, password, branch, **fields):
        gate = GateDevice(name=name, branch=branch, username=username, login_token=f"tok-{username}", **fields)
        gc.set_gate_password(gate, password)
        gate.save()
        return gate

    def scan(self, gate, scan_type, result, at, message):
        row = OutpassGateScan.objects.create(
            gate=gate,
            employee=self.ravi,
            outpass_request=self.pass_,
            scan_type=scan_type,
            result=result,
            message=message,
        )
        OutpassGateScan.objects.filter(pk=row.pk).update(scanned_at=at)
        return row

    def user(self, username, permissions, branch=None):
        role = Role.objects.create(name=f"GA {username}", permissions=permissions)
        return bearer(HRUser.objects.create(username=username, password_hash="x", role=role, branch=branch))

    def session(self, gate, seen=None):
        s = gc.new_gate_session(gate, FakeRequest())
        if seen is not None:
            GateSession.objects.filter(pk=s.pk).update(last_seen_at=seen)
            s.refresh_from_db()
        return s

    # requests
    def get(self, path, auth=None, **params):
        return self.client.get(f"/api/gate-devices{path}", params, **(auth or self.hr))

    def put(self, gate, body, auth=None):
        return self.client.put(
            f"/api/gate-devices/{gate.id}", json.dumps(body), content_type="application/json", **(auth or self.hr)
        )

    def post(self, path, body=None, auth=None):
        return self.client.post(
            f"/api/gate-devices{path}", json.dumps(body or {}), content_type="application/json", **(auth or self.hr)
        )

    def assert_no_secrets(self, content: bytes | str):
        text = content.decode("utf-8", "ignore") if isinstance(content, bytes) else content
        for gate in GateDevice.objects.all():
            if gate.password_hash and gate.password_hash != "x":
                self.assertNotIn(gate.password_hash, text)
            if gate.password_encrypted:
                self.assertNotIn(gate.password_encrypted, text)
            self.assertNotIn(gate.login_token, text)
        for secret in ("secret-one", "secret-three", "password_hash", "password_encrypted", "passwordHash"):
            self.assertNotIn(secret, text)


# ═══ the list ════════════════════════════════════════════════════════════════════════════════════════════════════════


class ListTests(GateAdminFixture):
    def test_every_old_key_stays_and_the_new_ones_come_with_counts(self):
        rows = {g["name"]: g for g in self.get("").json()}
        self.assertEqual(set(rows), {"Main Gate", "Back Gate", "Far Gate"})
        main = rows["Main Gate"]
        self.assertEqual(set(main), OLD_KEYS | NEW_KEYS)
        self.assertEqual(set(main["counts"]), COUNT_KEYS)
        # all time: 2 exits (today + 3 days ago), 1 return, 1 denied, tea 1 + 1; today: everything but the old exit
        self.assertEqual(
            main["counts"], {"today": 5, "exits": 2, "returns": 1, "teaOut": 1, "teaIn": 1, "denied": 1, "total": 6}
        )
        self.assertEqual(main["location"], "Spinning side")
        self.assertTrue(main["allowOutpass"] and main["allowTeaBreak"])
        self.assertTrue(main["passwordViewable"])
        self.assertFalse(rows["Back Gate"]["passwordViewable"])
        self.assertEqual(rows["Back Gate"]["counts"]["total"], 0)
        self.assertIsNone(rows["Back Gate"]["lastActivityAt"])
        self.assertIsNotNone(main["lastActivityAt"])
        self.assertEqual(main["loginToken"], "tok-main.gate1")  # the old dialog's link still works

    def test_active_sessions_count_open_and_recent_ones_only(self):
        self.session(self.g1)
        self.session(self.g1)
        gone = self.session(self.g1)
        gc.end_gate_session(gone)
        self.session(self.g1, seen=timezone.now() - timedelta(days=40))  # its token expired long ago
        rows = {g["name"]: g for g in self.get("").json()}
        self.assertEqual(rows["Main Gate"]["activeSessions"], 2)
        self.assertEqual(rows["Back Gate"]["activeSessions"], 0)

    def test_search_status_and_branch_filters(self):
        names = lambda **p: sorted(g["name"] for g in self.get("", **p).json())  # noqa: E731
        self.assertEqual(names(q="main"), ["Main Gate"])
        self.assertEqual(names(q="far.gate"), ["Far Gate"])
        self.assertEqual(names(q="spinning"), ["Main Gate"])  # location
        self.assertEqual(names(q="unit 2"), ["Far Gate"])  # branch name
        GateDevice.objects.filter(pk=self.g2.pk).update(is_active=False)
        self.assertEqual(names(status="inactive"), ["Back Gate"])
        self.assertEqual(names(status="active"), ["Far Gate", "Main Gate"])
        self.assertEqual(names(branchId=self.unit2.id), ["Far Gate"])
        self.assertEqual(self.get("", status="maybe").status_code, 400)
        self.assertEqual(self.get("", branchId="x").status_code, 400)

    def test_the_list_costs_the_same_queries_for_two_or_ten_gates(self):
        def cost():
            with CaptureQueriesContext(connection) as ctx:
                self.assertEqual(self.get("").status_code, 200)
            return len(ctx.captured_queries)

        few = cost()
        for i in range(7):
            gate = self.make_gate(f"Extra {i}", f"extra{i}", "secret-x", self.unit1)
            self.scan(gate, "exit", "success", timezone.now(), "Exit")
            self.session(gate)
        self.assertEqual(cost(), few)

    def test_a_branch_bound_user_sees_only_their_branch(self):
        scoped = self.user("ga_scoped", {"outpass_visitors": "edit"}, branch=self.unit1)
        names = sorted(g["name"] for g in self.get("", auth=scoped).json())
        self.assertEqual(names, ["Back Gate", "Main Gate"])
        # asking for the other branch changes nothing for them
        names = sorted(g["name"] for g in self.get("", auth=scoped, branchId=self.unit2.id).json())
        self.assertEqual(names, ["Back Gate", "Main Gate"])

    def test_no_secret_in_the_list(self):
        self.assert_no_secrets(
            json.dumps([{k: v for k, v in g.items() if k != "loginToken"} for g in self.get("").json()])
        )


# ═══ one gate ════════════════════════════════════════════════════════════════════════════════════════════════════════


class DetailTests(GateAdminFixture):
    def test_detail_is_the_list_entry_plus_its_live_sessions(self):
        live = self.session(self.g1)
        ended = self.session(self.g1)
        gc.end_gate_session(ended)
        body = self.get(f"/{self.g1.id}").json()
        self.assertEqual(set(body), OLD_KEYS | NEW_KEYS | {"sessions"})
        self.assertEqual(body["counts"]["total"], 6)
        self.assertEqual(body["activeSessions"], 1)
        self.assertEqual([s["id"] for s in body["sessions"]], [live.id])
        self.assertEqual(set(body["sessions"][0]), {"id", "deviceLabel", "createdAt", "lastSeenAt"})
        self.assertIn("Chrome", body["sessions"][0]["deviceLabel"])
        raw = self.get(f"/{self.g1.id}").content.decode()
        self.assertNotIn(live.sid, raw)
        self.assertNotIn(self.g1.password_encrypted, raw)

    def test_unknown_and_other_branch_gates_are_not_found(self):
        self.assertEqual(self.get("/999999").status_code, 404)
        scoped = self.user("ga_scoped", {"outpass_visitors": "edit"}, branch=self.unit1)
        self.assertEqual(self.get(f"/{self.g3.id}", auth=scoped).status_code, 404)
        self.assertEqual(self.get(f"/{self.g1.id}", auth=scoped).status_code, 200)


class CreateTests(GateAdminFixture):
    def test_add_a_gate_with_its_settings(self):
        r = self.post(
            "",
            {
                "name": "Canteen Gate",
                "branchId": self.unit1.id,
                "username": "canteen.gate",
                "password": "canteen-pass",
                "location": "  Canteen road ",
                "notes": "Night shift only",
                "allowOutpass": False,
            },
        )
        self.assertEqual(r.status_code, 201, r.content)
        body = r.json()
        self.assertTrue(OLD_KEYS <= set(body))
        self.assertEqual(body["location"], "Canteen road")
        self.assertEqual(body["notes"], "Night shift only")
        self.assertFalse(body["allowOutpass"])
        self.assertTrue(body["allowTeaBreak"])
        self.assertTrue(body["passwordViewable"])
        self.assertEqual(body["createdBy"], "Gate Admin")
        self.assertEqual(body["counts"]["total"], 0)
        self.assertNotIn("canteen-pass", r.content.decode())
        gate = GateDevice.objects.get(username="canteen.gate")
        self.assertEqual(gc.reveal_gate_password(gate), "canteen-pass")
        log = AuditLog.objects.get(action="create", module="outpass_visitors", record_id=gate.id)
        self.assertIn("Canteen Gate", log.record_description)
        self.assertNotIn("canteen-pass", f"{log.record_description}{log.new_values}")

    def test_bad_input(self):
        base = {"name": "X Gate", "branchId": self.unit1.id, "username": "x.gate", "password": "secret-x"}
        self.assertEqual(self.post("", {**base, "name": ""}).status_code, 400)
        self.assertEqual(self.post("", {**base, "username": "ab"}).status_code, 400)
        self.assertEqual(self.post("", {**base, "username": "has space"}).status_code, 400)
        self.assertEqual(self.post("", {**base, "password": "short"}).status_code, 400)
        self.assertEqual(self.post("", {**base, "allowOutpass": "perhaps"}).status_code, 400)
        self.assertEqual(self.post("", {**base, "branchId": 999999}).status_code, 404)
        self.assertEqual(self.post("", {**base, "username": "MAIN.GATE1"}).status_code, 409)
        self.assertEqual(self.post("", base).status_code, 201)

    def test_a_branch_bound_user_always_adds_to_their_own_branch(self):
        scoped = self.user("ga_scoped", {"outpass_visitors": "edit"}, branch=self.unit1)
        r = self.post(
            "",
            {"name": "Own Gate", "branchId": self.unit2.id, "username": "own.gate", "password": "secret-own"},
            auth=scoped,
        )
        self.assertEqual(r.status_code, 201)
        self.assertEqual(r.json()["branchId"], self.unit1.id)


class UpdateTests(GateAdminFixture):
    def test_change_the_settings_and_stamp_who_and_when(self):
        r = self.put(
            self.g1,
            {
                "name": "Main Gate A",
                "location": "Office side",
                "notes": "",
                "allowTeaBreak": False,
                "allowOutpass": True,
            },
        )
        self.assertEqual(r.status_code, 200, r.content)
        body = r.json()
        self.assertEqual((body["name"], body["location"], body["notes"]), ("Main Gate A", "Office side", None))
        self.assertFalse(body["allowTeaBreak"])
        self.assertEqual(body["updatedBy"], "Gate Admin")
        self.assertIsNotNone(body["updatedAt"])
        self.assertEqual(body["counts"]["total"], 6)
        log = AuditLog.objects.filter(action="update", record_id=self.g1.id).latest("id")
        self.assertIn("name", log.record_description)
        self.assertEqual(log.old_values["name"], "Main Gate")
        self.assertEqual(log.new_values["name"], "Main Gate A")

    def test_a_rename_keeps_sessions_and_a_new_username_ends_them(self):
        s = self.session(self.g1)
        self.assertEqual(self.put(self.g1, {"name": "Renamed"}).status_code, 200)
        s.refresh_from_db()
        self.assertIsNone(s.revoked_at)
        # only the letter case: still the same sign-in
        self.assertEqual(self.put(self.g1, {"username": "MAIN.gate1"}).status_code, 200)
        s.refresh_from_db()
        self.assertIsNone(s.revoked_at)
        self.assertEqual(self.put(self.g1, {"username": "front.gate"}).status_code, 200)
        s.refresh_from_db()
        self.assertEqual(s.revoked_reason, GateSession.REVOKED_USERNAME_CHANGED)
        self.assertEqual(GateDevice.objects.get(pk=self.g1.pk).username, "front.gate")

    def test_a_username_in_use_is_409_whatever_its_case(self):
        r = self.put(self.g1, {"username": "BACK.GATE"})
        self.assertEqual(r.status_code, 409)
        self.assertEqual(GateDevice.objects.get(pk=self.g1.pk).username, "main.gate1")
        self.assertEqual(self.put(self.g1, {"username": "a b c"}).status_code, 400)

    def test_a_new_password_is_viewable_and_signs_every_browser_out(self):
        s1, s2 = self.session(self.g2), self.session(self.g2)
        other = self.session(self.g1)
        r = self.put(self.g2, {"password": "new-secret"})
        self.assertEqual(r.status_code, 200)
        self.assertTrue(r.json()["passwordViewable"])
        self.assertNotIn("new-secret", r.content.decode())
        for s in (s1, s2):
            s.refresh_from_db()
            self.assertEqual(s.revoked_reason, GateSession.REVOKED_PASSWORD_CHANGED)
        other.refresh_from_db()
        self.assertIsNone(other.revoked_at)
        log = AuditLog.objects.filter(action="update", record_id=self.g2.id).latest("id")
        self.assertIn("password", log.record_description)
        self.assertIn("2 signed-in browsers signed out", log.record_description)
        self.assertNotIn("new-secret", f"{log.record_description}{log.new_values}")
        self.assertEqual(log.new_values, {"password": "changed"})
        self.assertEqual(self.put(self.g2, {"password": "short"}).status_code, 400)

    def test_switching_off_signs_out_and_switching_on_is_logged(self):
        s = self.session(self.g1)
        r = self.put(self.g1, {"isActive": False})
        self.assertFalse(r.json()["isActive"])
        s.refresh_from_db()
        self.assertEqual(s.revoked_reason, GateSession.REVOKED_DEACTIVATED)
        self.assertTrue(
            AuditLog.objects.filter(record_id=self.g1.id, record_description__startswith="Switched off gate").exists()
        )
        self.put(self.g1, {"isActive": True})
        self.assertTrue(
            AuditLog.objects.filter(record_id=self.g1.id, record_description__startswith="Switched on gate").exists()
        )

    def test_branch_moves(self):
        r = self.put(self.g1, {"branchId": self.unit2.id})
        self.assertEqual(r.json()["branchId"], self.unit2.id)
        self.assertEqual(self.put(self.g1, {"branchId": 999999}).status_code, 404)
        self.assertEqual(self.put(self.g1, {"branchId": "two"}).status_code, 400)
        scoped = self.user("ga_scoped", {"outpass_visitors": "edit"}, branch=self.unit1)
        self.assertEqual(self.put(self.g2, {"branchId": self.unit2.id}, auth=scoped).status_code, 403)
        self.assertEqual(self.put(self.g2, {"branchId": self.unit1.id, "name": "B"}, auth=scoped).status_code, 200)
        self.assertEqual(GateDevice.objects.get(pk=self.g2.pk).branch_id, self.unit1.id)

    def test_bad_input_and_another_branch(self):
        self.assertEqual(self.put(self.g1, {"name": "  "}).status_code, 400)
        self.assertEqual(self.put(self.g1, {"allowOutpass": "sometimes"}).status_code, 400)
        self.assertEqual(self.put(self.g1, {"location": 5}).status_code, 400)
        scoped = self.user("ga_scoped", {"outpass_visitors": "edit"}, branch=self.unit1)
        self.assertEqual(self.put(self.g3, {"name": "Mine now"}, auth=scoped).status_code, 404)
        self.assertEqual(GateDevice.objects.get(pk=self.g3.pk).name, "Far Gate")

    def test_an_hr_change_ends_a_sign_in_lock(self):
        for _ in range(5):
            gc.record_login_attempt("main.gate1", "1.2.3.4", False)
        self.assertTrue(gc.login_locked_out("main.gate1"))
        self.put(self.g1, {"password": "fresh-pass"})
        self.assertFalse(gc.login_locked_out("main.gate1"))


class DeleteTests(GateAdminFixture):
    def test_delete_keeps_the_records_and_is_logged(self):
        gate_id = self.g1.id
        r = self.client.delete(f"/api/gate-devices/{gate_id}", **self.hr)
        self.assertEqual(r.status_code, 204)
        self.assertFalse(GateDevice.objects.filter(pk=gate_id).exists())
        self.assertEqual(OutpassGateScan.objects.filter(gate__isnull=True).count(), 4)
        self.assertTrue(AuditLog.objects.filter(action="delete", module="outpass_visitors", record_id=gate_id).exists())

    def test_another_branch_cannot_delete(self):
        scoped = self.user("ga_scoped", {"outpass_visitors": "edit"}, branch=self.unit1)
        self.assertEqual(self.client.delete(f"/api/gate-devices/{self.g3.id}", **scoped).status_code, 404)
        self.assertTrue(GateDevice.objects.filter(pk=self.g3.pk).exists())


# ═══ reveal + sign-out ═══════════════════════════════════════════════════════════════════════════════════════════════


class RevealTests(GateAdminFixture):
    def test_reveal_shows_the_password_and_records_the_view(self):
        r = self.post(f"/{self.g1.id}/reveal-password")
        self.assertEqual(r.status_code, 200)
        self.assertEqual(r.json(), {"password": "secret-one"})
        self.assertEqual(r["Cache-Control"], "no-store")
        log = AuditLog.objects.get(action="view_password", module="outpass_visitors", record_id=self.g1.id)
        self.assertIn("Main Gate", log.record_description)
        self.assertNotIn("secret-one", f"{log.record_description}{log.old_values}{log.new_values}")

    def test_a_gate_set_before_passwords_were_kept_says_not_stored(self):
        r = self.post(f"/{self.g2.id}/reveal-password")
        self.assertEqual(r.status_code, 409)
        self.assertEqual(r.json()["code"], "not_stored")
        self.assertIn("Set a new password", r.json()["error"])
        self.assertFalse(AuditLog.objects.filter(action="view_password").exists())

    def test_another_branch_cannot_reveal(self):
        scoped = self.user(
            "ga_scoped",
            {"outpass_visitors": "edit", "outpass_visitors.outpass.gate_devices.view_password": "edit"},
            branch=self.unit1,
        )
        self.assertEqual(self.post(f"/{self.g3.id}/reveal-password", auth=scoped).status_code, 404)
        self.assertEqual(self.post(f"/{self.g1.id}/reveal-password", auth=scoped).json()["password"], "secret-one")

    def test_see_gate_passwords_hidden_refuses_even_with_edit_on_gates(self):
        auth = self.user(
            "ga_nopw", {"outpass_visitors": "edit", "outpass_visitors.outpass.gate_devices.view_password": "hidden"}
        )
        self.assertEqual(self.post(f"/{self.g1.id}/reveal-password", auth=auth).status_code, 403)
        # the rest of Manage Gates still works for them
        self.assertEqual(self.put(self.g1, {"name": "Still mine"}, auth=auth).status_code, 200)
        view = self.user(
            "ga_viewpw", {"outpass_visitors": "edit", "outpass_visitors.outpass.gate_devices.view_password": "view"}
        )
        self.assertEqual(self.post(f"/{self.g1.id}/reveal-password", auth=view).status_code, 403)
        self.assertFalse(AuditLog.objects.filter(action="view_password").exists())


class RevealIsExplicitTests(GateAdminFixture):
    """S4 (19 Nov 2026): "See gate passwords" is off unless a role sets it itself; edit on the page, the section or the
    devices feature, or the Managing Director's section grant, never includes it. A Super Admin keeps it."""

    def test_edit_on_the_page_without_the_key_cannot_reveal(self):
        for i, perms in enumerate(
            (
                {"outpass_visitors": "edit"},
                {"outpass_visitors.outpass": "edit"},
                {"outpass_visitors": "edit", "outpass_visitors.outpass.gate_devices": "edit"},
            )
        ):
            auth = self.user(f"ga_noexplicit{i}", perms)
            self.assertEqual(self.post(f"/{self.g1.id}/reveal-password", auth=auth).status_code, 403, perms)
            self.assertEqual(self.put(self.g1, {"notes": f"still editable {i}"}, auth=auth).status_code, 200)
        self.assertFalse(AuditLog.objects.filter(action="view_password").exists())

    def test_set_on_the_role_it_reveals_and_a_super_admin_always_can(self):
        auth = self.user(
            "ga_explicit", {"outpass_visitors": "view", "outpass_visitors.outpass.gate_devices.view_password": "edit"}
        )
        self.assertEqual(self.post(f"/{self.g1.id}/reveal-password", auth=auth).json(), {"password": "secret-one"})
        self.assertEqual(self.post(f"/{self.g1.id}/reveal-password").status_code, 200)  # self.hr is a Super Admin

    def test_the_managing_directors_section_grant_does_not_include_it(self):
        md = HRUser.objects.create(username="ga_md", password_hash="x", full_name="MD", is_md=True)
        self.assertEqual(self.post(f"/{self.g1.id}/reveal-password", auth=bearer(md)).status_code, 403)
        self.assertEqual(self.client.get("/api/gate-devices", **bearer(md)).status_code, 200)  # the page itself: yes


class ConcurrentChangeTests(GateAdminFixture):
    """S5 (19 Nov 2026): a PUT writes only the columns it changed, so a change made by someone else between this
    request's read and its save (a password reset, a switch-off) is never undone by a rename."""

    def test_a_rename_does_not_undo_a_password_reset_or_a_switch_off_made_meanwhile(self):
        from . import gate_admin_views as gav

        real = gav._apply_update

        def meanwhile(request, gate, data):
            out = real(request, gate, data)
            # another HR user's reset and switch-off land after this request read the row, before it saves
            GateDevice.objects.filter(pk=gate.pk).update(password_hash="reset-by-someone-else", is_active=False)
            return out

        with mock.patch.object(gav, "_apply_update", meanwhile):
            self.assertEqual(self.put(self.g1, {"name": "Main Gate North"}).status_code, 200)
        self.g1.refresh_from_db()
        self.assertEqual(self.g1.name, "Main Gate North")
        self.assertEqual((self.g1.password_hash, self.g1.is_active), ("reset-by-someone-else", False))
        self.assertIsNotNone(self.g1.updated_at)


class SignOutTests(GateAdminFixture):
    def test_sign_out_everywhere_ends_every_open_session_of_that_gate(self):
        a, b = self.session(self.g1), self.session(self.g1)
        other = self.session(self.g3)
        r = self.post(f"/{self.g1.id}/sign-out")
        self.assertEqual(r.json(), {"signedOut": 2})
        for s in (a, b):
            s.refresh_from_db()
            self.assertEqual(s.revoked_reason, GateSession.REVOKED_HR_SIGNED_OUT)
        other.refresh_from_db()
        self.assertIsNone(other.revoked_at)
        self.assertEqual(self.post(f"/{self.g1.id}/sign-out").json(), {"signedOut": 0})
        self.assertTrue(
            AuditLog.objects.filter(action="update", record_id=self.g1.id, record_description__contains="Signed out")
        )
        self.assertEqual(self.get(f"/{self.g1.id}").json()["sessions"], [])

    def test_another_branch_cannot_sign_out(self):
        s = self.session(self.g3)
        scoped = self.user("ga_scoped", {"outpass_visitors": "edit"}, branch=self.unit1)
        self.assertEqual(self.post(f"/{self.g3.id}/sign-out", auth=scoped).status_code, 404)
        s.refresh_from_db()
        self.assertIsNone(s.revoked_at)


# ═══ permissions ═════════════════════════════════════════════════════════════════════════════════════════════════════


class PermissionTests(GateAdminFixture):
    def test_view_only_reads_everything_and_changes_nothing(self):
        view = self.user("ga_view", {"outpass_visitors": "view"})
        for path in ("", f"/{self.g1.id}", "/summary", "/records"):
            self.assertEqual(self.get(path, auth=view).status_code, 200, path)
        self.assertEqual(self.get("/records/export", auth=view, fmt="xlsx").status_code, 200)
        self.assertEqual(self.get("/export", auth=view, fmt="pdf").status_code, 200)
        self.assertEqual(self.put(self.g1, {"name": "Nope"}, auth=view).status_code, 403)
        self.assertEqual(self.post(f"/{self.g1.id}/reveal-password", auth=view).status_code, 403)
        self.assertEqual(self.post(f"/{self.g1.id}/sign-out", auth=view).status_code, 403)
        self.assertEqual(self.client.delete(f"/api/gate-devices/{self.g1.id}", **view).status_code, 403)
        self.assertEqual(
            self.post(
                "", {"name": "N", "branchId": self.unit1.id, "username": "nnn", "password": "123456"}, auth=view
            ).status_code,
            403,
        )
        self.assertEqual(GateDevice.objects.get(pk=self.g1.pk).name, "Main Gate")

    def test_hidden_gets_nothing(self):
        hidden = self.user("ga_hidden", {"outpass_visitors": "edit", "outpass_visitors.outpass.gate_devices": "hidden"})
        for path in ("", f"/{self.g1.id}", "/summary", "/records", "/records/export", "/export"):
            self.assertEqual(self.get(path, auth=hidden, fmt="xlsx").status_code, 403, path)
        self.assertEqual(self.post(f"/{self.g1.id}/reveal-password", auth=hidden).status_code, 403)

    def test_no_token_and_wrong_token(self):
        self.assertEqual(self.client.get("/api/gate-devices/summary").status_code, 401)
        session = self.session(self.g1)
        gate_auth = {"HTTP_AUTHORIZATION": f"Bearer {gc.gate_token(self.g1, session)}"}
        self.assertEqual(self.client.get("/api/gate-devices/records", **gate_auth).status_code, 403)
        self.assertEqual(
            self.client.post(f"/api/gate-devices/{self.g1.id}/reveal-password", **gate_auth).status_code, 403
        )


# ═══ the tiles ═══════════════════════════════════════════════════════════════════════════════════════════════════════


class SummaryTests(GateAdminFixture):
    def test_the_tiles(self):
        self.session(self.g1)
        self.session(self.g1, seen=timezone.now() - timedelta(hours=2))  # open but not seen lately
        GateDevice.objects.filter(pk=self.g2.pk).update(is_active=False)
        body = self.get("/summary").json()
        self.assertEqual(
            body,
            {
                "gates": 3,
                "active": 2,
                "signedInNow": 1,
                "recordsToday": 6,  # g1: 5 today + g3: 1
                "deniedToday": 1,
                "records": 7,  # no dates: all time
                "denied": 1,
            },
        )
        today = ist_today().isoformat()
        ranged = self.get("/summary", **{"from": today, "to": today}).json()
        self.assertEqual((ranged["records"], ranged["denied"]), (6, 1))
        self.assertEqual(self.get("/summary", branchId=self.unit2.id).json()["gates"], 1)
        self.assertEqual(self.get("/summary", **{"from": "18-11-2026"}).status_code, 400)

    def test_a_branch_bound_user_counts_their_branch_only(self):
        scoped = self.user("ga_scoped", {"outpass_visitors": "view"}, branch=self.unit1)
        body = self.get("/summary", auth=scoped, branchId=self.unit2.id).json()
        self.assertEqual((body["gates"], body["recordsToday"], body["records"]), (2, 5, 6))


# ═══ records ═════════════════════════════════════════════════════════════════════════════════════════════════════════


class RecordsTests(GateAdminFixture):
    def records(self, auth=None, **params):
        r = self.get("/records", auth=auth, **params)
        self.assertEqual(r.status_code, 200, r.content)
        return r.json()

    def test_one_gate_with_counts_and_paging(self):
        body = self.records(gateId=self.g1.id, pageSize=2)
        self.assertEqual(body["total"], 6)
        self.assertEqual(len(body["items"]), 2)
        self.assertEqual(body["counts"]["exits"], 2)
        self.assertEqual(body["counts"]["denied"], 1)
        self.assertEqual({r["gateName"] for r in body["items"]}, {"Main Gate"})
        page3 = self.records(gateId=self.g1.id, pageSize=2, page=3)
        self.assertEqual(len(page3["items"]), 2)
        item = body["items"][0]
        self.assertEqual(
            set(item),
            {"id", "at", "type", "result", "reason", "reasonLabel", "message", "gateId", "gateName", "employee"}
            | {"destination", "passId", "minutes"},
        )

    def test_every_filter_changes_the_rows(self):
        today = ist_today().isoformat()
        self.assertEqual(self.records(gateId=self.g1.id, **{"from": today, "to": today})["total"], 5)
        self.assertEqual(self.records(gateId=self.g1.id, type="exit")["total"], 3)
        self.assertEqual(self.records(gateId=self.g1.id, type="tea_in")["total"], 1)
        self.assertEqual(self.records(gateId=self.g1.id, result="denied")["total"], 1)
        self.assertEqual(self.records(gateId=self.g1.id, result="expired")["total"], 1)
        self.assertEqual(self.records(gateId=self.g1.id, q="canara")["total"], 4)  # the pass scans only
        self.assertEqual(self.records(gateId=self.g1.id, q="nobody")["total"], 0)
        self.assertEqual(self.records(gateId=f"{self.g1.id},{self.g3.id}")["total"], 7)
        self.assertEqual(self.records()["total"], 7)  # every gate
        self.assertEqual(self.records(branchId=self.unit2.id)["total"], 1)

    def test_bad_params_are_400(self):
        for params in ({"from": "yesterday"}, {"type": "lunch"}, {"result": "maybe"}, {"gateId": "x"}):
            self.assertEqual(self.get("/records", **params).status_code, 400, params)
        today = ist_today()
        bad = {"from": today.isoformat(), "to": (today - timedelta(days=1)).isoformat()}
        self.assertEqual(self.get("/records", **bad).status_code, 400)

    def test_a_branch_bound_user_never_reads_another_branch(self):
        scoped = self.user("ga_scoped", {"outpass_visitors": "view"}, branch=self.unit1)
        self.assertEqual(self.records(auth=scoped)["total"], 6)
        self.assertEqual(self.records(auth=scoped, gateId=self.g3.id)["total"], 0)
        self.assertEqual(self.records(auth=scoped, branchId=self.unit2.id)["total"], 6)

    def test_no_secret_in_the_records(self):
        self.assert_no_secrets(self.get("/records").content)


# ═══ files ═══════════════════════════════════════════════════════════════════════════════════════════════════════════


def workbook_text(content: bytes) -> str:
    wb = load_workbook(io.BytesIO(content), read_only=True)
    cells = []
    for ws in wb.worksheets:
        for row in ws.iter_rows(values_only=True):
            cells.extend(str(v) for v in row if v is not None)
    return "\n".join(cells)


class ExportTests(GateAdminFixture):
    def test_records_xlsx_of_one_gate(self):
        r = self.get("/records/export", fmt="xlsx", gateId=self.g1.id, type="exit")
        self.assertEqual(r.status_code, 200, r.content[:300])
        self.assertIn("spreadsheetml", r["Content-Type"])
        self.assertRegex(r["Content-Disposition"], r'filename="gate_records_main_gate_\d{8}_\d{4}\.xlsx"')
        text = workbook_text(r.content)
        self.assertIn("GATE RECORDS - MAIN GATE", text.upper())
        self.assertIn("Exit", text)
        self.assertNotIn("Far exit", text)
        self.assertNotIn("Tea break started", text)  # a tea row's message: type=exit left them out
        self.assert_no_secrets(text)
        log = AuditLog.objects.filter(action="export", module="outpass_visitors").latest("id")
        self.assertIn("Gate records - Main Gate", log.record_description)

    def test_records_pdf_of_every_gate(self):
        r = self.get("/records/export", fmt="pdf")
        self.assertEqual(r.status_code, 200)
        self.assertTrue(r.content.startswith(b"%PDF"))
        self.assertRegex(r["Content-Disposition"], r'filename="gate_records_\d{8}_\d{4}\.pdf"')
        self.assert_no_secrets(r.content)

    def test_records_export_bad_input(self):
        self.assertEqual(self.get("/records/export", fmt="csv").status_code, 400)
        self.assertEqual(self.get("/records/export", fmt="xlsx", type="lunch").status_code, 400)

    def test_a_branch_bound_user_exports_only_their_branch(self):
        scoped = self.user("ga_scoped", {"outpass_visitors": "view"}, branch=self.unit1)
        r = self.get("/records/export", auth=scoped, fmt="xlsx", gateId=self.g3.id)
        self.assertEqual(r.status_code, 200)
        text = workbook_text(r.content)
        self.assertNotIn("Far Gate", text)  # not even its name in the title
        self.assertNotIn("Far exit", text)
        r = self.get("/export", auth=scoped, fmt="xlsx")
        text = workbook_text(r.content)
        self.assertIn("Main Gate", text)
        self.assertNotIn("Far Gate", text)

    def test_the_gate_list_files_have_no_password_and_no_login_link(self):
        self.session(self.g1)
        r = self.get("/export", fmt="xlsx")
        self.assertEqual(r.status_code, 200)
        self.assertRegex(r["Content-Disposition"], r'filename="gates_\d{8}_\d{4}\.xlsx"')
        text = workbook_text(r.content)
        for expected in ("Main Gate", "Back Gate", "Far Gate", "main.gate1", "Spinning side", "Switched on"):
            self.assertIn(expected, text)
        self.assert_no_secrets(text)
        pdf = self.get("/export", fmt="pdf")
        self.assertTrue(pdf.content.startswith(b"%PDF"))
        self.assert_no_secrets(pdf.content)
        self.assertEqual(self.get("/export", fmt="doc").status_code, 400)

    def test_the_gate_list_file_follows_the_list_filters(self):
        GateDevice.objects.filter(pk=self.g2.pk).update(is_active=False)
        text = workbook_text(self.get("/export", fmt="xlsx", status="inactive").content)
        self.assertIn("Back Gate", text)
        self.assertNotIn("Main Gate", text)
        text = workbook_text(self.get("/export", fmt="xlsx", q="far").content)
        self.assertIn("Far Gate", text)
        self.assertNotIn("Back Gate", text)

"""
Gate Monitor (/api/gate-monitor/*, gate_monitor_views.py): the shared gate sign-in, the session it opens (me / refresh /
logout / revocation by HR), the wall between gate and HR tokens, the gate's own records, summary and files (never another
gate's rows, whatever the query says), and scans that honour a gate's allow_outpass / allow_tea_break.

Run via: DATABASE_URL="" DB_HOST=localhost DB_TEST_NAME=test_uktex_<you> py -3 manage.py test api.tests_gate_monitor
"""

from __future__ import annotations

import io
from datetime import timedelta

from django.core.cache import cache
from django.test import TestCase
from django.utils import timezone
from openpyxl import load_workbook

from . import approval_workflow as approval
from . import gate_credentials as gc
from . import gate_qr
from .clock import ist_today
from .jwt_utils import sign_token, verify_token
from .models import (
    Branch,
    Department,
    Employee,
    GateDevice,
    GateLoginAttempt,
    GateSession,
    HRUser,
    OutpassGateScan,
    OutpassRequest,
    TeaBreakLog,
)

UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36"
WRONG = "Wrong username or password."
SWITCHED_OFF = "This gate is switched off. Ask HR to switch it on."


class GateMonitorFixture(TestCase):
    def setUp(self):
        cache.clear()  # the per-address sign-in throttle
        self.addCleanup(cache.clear)
        approval.clear_cache()
        self.branch = Branch.objects.create(name="Monitor Unit")
        self.other_branch = Branch.objects.create(name="Other Unit")
        self.gate = self.make_gate("Main Gate", "main.gate1", "secret-one", location="North wall")
        self.other = self.make_gate("Back Gate", "back.gate2", "secret-two", branch=self.other_branch)
        admin = HRUser.objects.create(username="gate_monitor_admin", password_hash="x", is_super_admin=True)
        self.hr_token = sign_token({"role": "hr", "hrUserId": admin.id})
        dept = Department.objects.create(name="Spinning")
        self.emp = Employee.objects.create(
            employee_code="GM001", first_name="Asha", last_name="Kumar", department=dept, status="active"
        )
        self.emp2 = Employee.objects.create(
            employee_code="GM002", first_name="Ravi", last_name="Shankar", status="active"
        )

    def make_gate(self, name, username, password, branch=None, **extra):
        gate = GateDevice(
            name=name, branch=branch or self.branch, username=username, login_token=f"tok-{username}", **extra
        )
        gc.set_gate_password(gate, password)
        gate.save()
        return gate

    # ── calls ──
    def login(self, username, password):
        return self.client.post(
            "/api/gate-monitor/login",
            {"username": username, "password": password},
            content_type="application/json",
            HTTP_USER_AGENT=UA,
        )

    def token_for(self, gate=None) -> str:
        gate = gate or self.gate
        _session, token = gc.start_gate_session(gate, _Req())
        return token

    def get(self, path, token, **params):
        return self.client.get(path, params, HTTP_AUTHORIZATION=f"Bearer {token}")

    def post(self, path, token, body=None):
        return self.client.post(path, body or {}, content_type="application/json", HTTP_AUTHORIZATION=f"Bearer {token}")

    def hr_put(self, gate, body):
        return self.client.put(
            f"/api/gate-devices/{gate.id}",
            body,
            content_type="application/json",
            HTTP_AUTHORIZATION=f"Bearer {self.hr_token}",
        )

    # ── data ──
    def approved_pass(self, employee=None, **extra) -> OutpassRequest:
        values = dict(
            employee=employee or self.emp,
            destination="Bank, Peelamedu",
            reason="Cash",
            status=OutpassRequest.STATUS_APPROVED,
            approved_at=timezone.now(),
            approver_role="hr",
            approved_by="HR Person",
        )
        values.update(extra)
        return OutpassRequest.objects.create(**values)


class _Req:
    META = {"HTTP_USER_AGENT": UA, "REMOTE_ADDR": "10.9.8.7"}
    headers: dict = {}


class LoginTests(GateMonitorFixture):
    def test_a_right_password_opens_a_session_and_says_which_gate(self):
        response = self.login("main.gate1", "secret-one")
        self.assertEqual(response.status_code, 200)
        body = response.json()
        self.assertEqual(set(body), {"token", "gate"})
        self.assertEqual(
            body["gate"],
            {
                "id": self.gate.id,
                "name": "Main Gate",
                "branchName": "Monitor Unit",
                "location": "North wall",
                "allowOutpass": True,
                "allowTeaBreak": True,
            },
        )
        claims = verify_token(body["token"])
        session = GateSession.objects.get(gate=self.gate)
        self.assertEqual(
            (claims["role"], claims["deviceId"], claims["gsid"]), ("gate_device", self.gate.id, session.sid)
        )
        self.assertNotIn("jti", claims)
        self.assertGreater(claims["exp"] - timezone.now().timestamp(), 29 * 86400)
        self.gate.refresh_from_db()
        self.assertIsNotNone(self.gate.last_login_at)
        self.assertTrue(GateLoginAttempt.objects.get(username="main.gate1").success)
        text = response.content.decode()
        for secret in ("secret-one", self.gate.password_hash, self.gate.password_encrypted, self.gate.login_token):
            self.assertNotIn(secret, text)
        # and the token works on the gate's own endpoints
        self.assertEqual(self.get("/api/gate-monitor/me", body["token"]).status_code, 200)

    def test_the_username_decides_the_gate_and_case_does_not_matter(self):
        response = self.login("  BACK.Gate2 ", "secret-two")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["gate"]["id"], self.other.id)
        self.assertEqual(response.json()["gate"]["branchName"], "Other Unit")

    def test_a_wrong_password_or_an_unknown_username_is_one_plain_401(self):
        for username, password in (("main.gate1", "nope"), ("nobody", "secret-one"), ("main.gate1", "SECRET-ONE")):
            response = self.login(username, password)
            self.assertEqual(response.status_code, 401)
            self.assertEqual(response.json(), {"error": WRONG, "code": gc.LOGIN_WRONG})
        self.assertFalse(GateSession.objects.exists())
        self.assertEqual(GateLoginAttempt.objects.filter(success=False).count(), 3)

    def test_five_wrong_tries_lock_the_gate_for_a_while_even_for_the_right_password(self):
        for _ in range(5):
            self.assertEqual(self.login("main.gate1", "nope").status_code, 401)
        response = self.login("Main.Gate1", "secret-one")
        self.assertEqual(response.status_code, 429)
        self.assertEqual(response.json()["code"], gc.LOGIN_LOCKED)
        self.assertIn(
            "Too many wrong tries. Wait 15 minutes or ask HR to reset the password.", response.json()["error"]
        )
        self.assertFalse(GateSession.objects.filter(gate=self.gate).exists())
        # another gate is not locked
        self.assertEqual(self.login("back.gate2", "secret-two").status_code, 200)
        # HR resetting the password ends the lock
        self.assertEqual(self.hr_put(self.gate, {"password": "fresh-pass"}).status_code, 200)
        self.assertEqual(self.login("main.gate1", "fresh-pass").status_code, 200)

    def test_a_switched_off_gate_says_so_only_to_the_right_password(self):
        GateDevice.objects.filter(pk=self.gate.pk).update(is_active=False)
        response = self.login("main.gate1", "secret-one")
        self.assertEqual(response.status_code, 403)
        self.assertEqual(response.json(), {"error": SWITCHED_OFF, "code": gc.LOGIN_SWITCHED_OFF})
        self.assertEqual(self.login("main.gate1", "nope").json()["error"], WRONG)
        self.assertFalse(GateSession.objects.exists())

    def test_missing_fields_are_400_and_not_counted(self):
        for body in (
            {},
            {"username": "main.gate1"},
            {"username": " ", "password": "x"},
            {"username": 5, "password": "x"},
        ):
            response = self.client.post("/api/gate-monitor/login", body, content_type="application/json")
            self.assertEqual(response.status_code, 400, body)
        self.assertFalse(GateLoginAttempt.objects.exists())

    def test_the_old_gate_scanner_sign_in_still_answers_its_old_keys(self):
        response = self.client.post(
            "/api/gate-devices/login",
            {"username": "main.gate1", "password": "secret-one"},
            content_type="application/json",
        )
        self.assertEqual(set(response.json()), {"token", "gateId", "gateName"})
        self.assertEqual(self.get("/api/gate-monitor/me", response.json()["token"]).status_code, 200)


class MeAndLogoutTests(GateMonitorFixture):
    def test_me_names_the_gate_and_this_sign_in_and_keeps_a_fresh_token(self):
        token = self.token_for()
        response = self.get("/api/gate-monitor/me", token)
        self.assertEqual(response.status_code, 200)
        body = response.json()
        self.assertEqual(body["gate"]["name"], "Main Gate")
        self.assertEqual(body["gate"]["allowTeaBreak"], True)
        self.assertEqual(set(body["session"]), {"id", "deviceLabel", "createdAt", "lastSeenAt"})
        self.assertNotIn("token", body)  # 30 days left: nothing to renew
        self.assertNotIn(GateSession.objects.get(gate=self.gate).sid, response.content.decode())
        self.assertTrue(body["expiresAt"])

    def test_me_renews_a_token_with_less_than_15_days_left_for_the_same_session(self):
        session = gc.new_gate_session(self.gate, _Req())
        old = sign_token(
            {"role": "gate_device", "deviceId": self.gate.id, "gateName": self.gate.name, "gsid": session.sid},
            expires_in=timedelta(days=10),
        )
        body = self.get("/api/gate-monitor/me", old).json()
        self.assertIn("token", body)
        fresh = verify_token(body["token"])
        self.assertEqual(fresh["gsid"], session.sid)
        self.assertGreater(fresh["exp"] - timezone.now().timestamp(), 29 * 86400)
        self.assertEqual(self.get("/api/gate-monitor/me", body["token"]).status_code, 200)
        self.assertEqual(GateSession.objects.filter(gate=self.gate).count(), 1)  # no new session

    def test_a_token_from_before_sessions_is_refused_everywhere(self):
        # 19 Nov 2026: a token without gsid names no session HR could end, so the console is sent to its sign-in page
        legacy = sign_token(
            {"role": "gate_device", "deviceId": self.gate.id, "gateName": self.gate.name}, expires_in=timedelta(hours=2)
        )
        ended = {"error": "This gate's sign-in has ended. Sign in again.", "code": "session_ended"}
        for response in (
            self.get("/api/gate-monitor/me", legacy),
            self.post("/api/gate-monitor/logout", legacy),
            self.get("/api/gate-monitor/summary", legacy),
            self.get("/api/gate-monitor/records", legacy),
            self.get("/api/gate-devices/scan-log", legacy),
        ):
            self.assertEqual((response.status_code, response.json()), (401, ended))
        self.assertFalse(GateSession.objects.exists())

    def test_logout_ends_this_sign_in_only(self):
        token, other_tab = self.token_for(), self.token_for()
        self.assertEqual(self.post("/api/gate-monitor/logout", token).status_code, 204)
        refused = self.get("/api/gate-monitor/me", token)
        self.assertEqual(refused.status_code, 401)
        self.assertEqual(refused.json()["code"], "session_ended")
        self.assertEqual(self.get("/api/gate-monitor/records", token).status_code, 401)
        self.assertEqual(self.post("/api/gate-monitor/scan", token, {"qrToken": "x"}).status_code, 401)
        self.assertEqual(
            list(GateSession.objects.filter(revoked_at__isnull=False).values_list("revoked_reason", flat=True)),
            [GateSession.REVOKED_LOGOUT],
        )
        self.assertEqual(self.get("/api/gate-monitor/me", other_tab).status_code, 200)

    def test_an_hr_password_reset_signs_the_gate_out(self):
        token = self.token_for()
        other_gate = self.token_for(self.other)
        self.assertEqual(self.hr_put(self.gate, {"password": "fresh-pass"}).status_code, 200)
        refused = self.get("/api/gate-monitor/me", token)
        self.assertEqual((refused.status_code, refused.json()["code"]), (401, "session_ended"))
        self.assertEqual(self.get("/api/gate-monitor/me", other_gate).status_code, 200)
        self.assertEqual(self.login("main.gate1", "secret-one").status_code, 401)
        self.assertEqual(self.login("main.gate1", "fresh-pass").status_code, 200)

    def test_switching_the_gate_off_refuses_its_token_at_once(self):
        token = self.token_for()
        self.assertEqual(self.hr_put(self.gate, {"isActive": False}).status_code, 200)
        refused = self.get("/api/gate-monitor/me", token)
        self.assertEqual((refused.status_code, refused.json()["code"]), (403, "gate_revoked"))
        self.assertEqual(self.post("/api/gate-monitor/scan", token, {"qrToken": "x"}).status_code, 403)
        self.assertFalse(OutpassGateScan.objects.exists())

    def test_a_deleted_gate_refuses_its_token(self):
        token = self.token_for()
        GateDevice.objects.filter(pk=self.gate.pk).delete()
        self.assertEqual(self.get("/api/gate-monitor/summary", token).json()["code"], "gate_revoked")


class TokenWallTests(GateMonitorFixture):
    def test_a_gate_token_opens_no_hr_endpoint(self):
        token = self.token_for()
        for path in ("/api/gate-devices", "/api/gate-devices/records", "/api/employees", "/api/tea-break/records"):
            response = self.get(path, token)
            self.assertEqual(response.status_code, 403, path)

    def test_an_hr_token_opens_no_gate_monitor_endpoint(self):
        req = self.approved_pass()
        for method, path in (
            ("get", "/api/gate-monitor/me"),
            ("get", "/api/gate-monitor/summary"),
            ("get", "/api/gate-monitor/records"),
            ("get", "/api/gate-monitor/records/export?fmt=xlsx"),
            ("post", "/api/gate-monitor/logout"),
            ("post", "/api/gate-monitor/scan"),
        ):
            if method == "get":
                response = self.client.get(path, HTTP_AUTHORIZATION=f"Bearer {self.hr_token}")
            else:
                response = self.post(path, self.hr_token, {"qrToken": gate_qr.pass_code(req.id, timedelta(minutes=60))})
            self.assertEqual(response.status_code, 403, path)
            self.assertEqual(response.json()["error"], "This token cannot be used here")
        self.assertFalse(OutpassGateScan.objects.exists())
        req.refresh_from_db()
        self.assertIsNone(req.exited_at)

    def test_no_token_or_a_forged_one_is_401(self):
        self.assertEqual(self.client.get("/api/gate-monitor/me").status_code, 401)
        forged = sign_token({"role": "gate_device", "deviceId": self.gate.id}, expires_in=timedelta(days=-1))
        self.assertEqual(self.get("/api/gate-monitor/me", forged).status_code, 401)
        self.assertEqual(self.get("/api/gate-monitor/me", "not-a-token").status_code, 401)


class RecordsTests(GateMonitorFixture):
    def setUp(self):
        super().setUp()
        now = timezone.now()
        # this gate: an exit, a return, a denied scan, a tea break out and back in
        self.exit_req = self.approved_pass(exit_gate=self.gate, exited_at=now)
        OutpassGateScan.objects.create(
            gate=self.gate,
            outpass_request=self.exit_req,
            employee=self.emp,
            scan_type=OutpassGateScan.SCAN_TYPE_EXIT,
            result=OutpassGateScan.RESULT_SUCCESS,
            message="Exit recorded via Main Gate",
        )
        OutpassGateScan.objects.create(
            gate=self.gate,
            outpass_request=self.exit_req,
            employee=self.emp,
            scan_type=OutpassGateScan.SCAN_TYPE_ENTRY,
            result=OutpassGateScan.RESULT_SUCCESS,
            message="Return recorded via Main Gate",
        )
        OutpassGateScan.objects.create(
            gate=self.gate,
            employee=self.emp2,
            result=OutpassGateScan.RESULT_EXPIRED,
            message="This Outpass has expired.",
        )
        TeaBreakLog.objects.create(
            employee=self.emp2, out_gate=self.gate, out_at=now - timedelta(minutes=20), in_gate=self.gate, in_at=now
        )
        # the other gate: rows this gate must never see
        OutpassGateScan.objects.create(
            gate=self.other,
            employee=self.emp2,
            result=OutpassGateScan.RESULT_SUCCESS,
            message="Exit recorded via Back Gate",
        )
        TeaBreakLog.objects.create(employee=self.emp, out_gate=self.other, out_at=now - timedelta(minutes=5))
        self.token = self.token_for()
        self.today = ist_today().isoformat()

    def records(self, **params):
        response = self.get("/api/gate-monitor/records", self.token, **params)
        self.assertEqual(response.status_code, 200, response.content)
        return response.json()

    def test_only_this_gates_rows_whatever_the_query_says(self):
        for params in ({}, {"gateId": str(self.other.id)}, {"gateId": f"{self.other.id},{self.gate.id}"}):
            for extra in ({}, {"branchId": str(self.other_branch.id)}):
                body = self.records(**params, **extra)
                self.assertEqual(body["total"], 5, (params, extra))
                self.assertEqual({r["gateId"] for r in body["items"]}, {self.gate.id})
                self.assertEqual(
                    body["counts"], {"exits": 1, "returns": 1, "teaOut": 1, "teaIn": 1, "denied": 1, "total": 5}
                )
        self.assertNotIn("Back Gate", str(self.records(gateId=str(self.other.id))))

    def test_the_filters_narrow_the_list(self):
        self.assertEqual([r["type"] for r in self.records(type="exit")["items"]], ["exit", "exit"])
        denied = self.records(result="denied")["items"]
        self.assertEqual([(r["reason"], r["reasonLabel"]) for r in denied], [("expired", "Pass expired")])
        self.assertEqual({r["type"] for r in self.records(type="tea_out,tea_in")["items"]}, {"tea_out", "tea_in"})
        self.assertEqual({r["employee"]["employeeCode"] for r in self.records(q="ravi")["items"]}, {"GM002"})
        self.assertEqual(self.records(**{"from": self.today, "to": self.today})["total"], 5)
        self.assertEqual(self.records(**{"from": "2020-01-01", "to": "2020-01-31"})["total"], 0)
        page = self.records(page="2", pageSize="2")
        self.assertEqual((page["page"], page["pageSize"], len(page["items"]), page["total"]), (2, 2, 2, 5))

    def test_bad_input_is_400(self):
        for params in (
            {"from": "18-11-2026"},
            {"type": "lunch"},
            {"result": "maybe"},
            {"from": "2026-11-18", "to": "2026-11-01"},
        ):
            response = self.get("/api/gate-monitor/records", self.token, **params)
            self.assertEqual(response.status_code, 400, params)
            self.assertIn("error", response.json())

    def test_rows_link_photos_and_never_carry_secrets(self):
        body = self.get("/api/gate-monitor/records", self.token).content.decode()
        for secret in (self.gate.password_hash, self.gate.password_encrypted, self.gate.login_token, self.token):
            self.assertNotIn(secret, body)
        self.assertNotIn("data:image", body)

    def test_summary_is_today_at_this_gate(self):
        response = self.get("/api/gate-monitor/summary", self.token)
        self.assertEqual(response.status_code, 200)
        body = response.json()
        self.assertEqual(
            {k: body[k] for k in ("exits", "returns", "teaOut", "teaIn", "denied", "outNow")},
            {"exits": 1, "returns": 1, "teaOut": 1, "teaIn": 1, "denied": 1, "outNow": 1},
        )
        self.assertEqual(body["date"], self.today)
        other = self.get("/api/gate-monitor/summary", self.token_for(self.other)).json()
        self.assertEqual((other["exits"], other["teaOut"], other["teaOutNow"]), (1, 1, 1))

    def test_excel_holds_this_gates_rows_only_even_when_asked_for_another(self):
        response = self.get(
            "/api/gate-monitor/records/export", self.token, fmt="xlsx", gateId=str(self.other.id), branchId="999"
        )
        self.assertEqual(response.status_code, 200, response.content[:300])
        self.assertIn("spreadsheetml", response["Content-Type"])
        self.assertRegex(response["Content-Disposition"], r'filename="gate_records_main_gate_\d{8}_\d{4}\.xlsx"')
        sheet = load_workbook(io.BytesIO(response.content)).active
        text = "\n".join(str(c) for row in sheet.iter_rows(values_only=True) for c in row if c is not None)
        self.assertIn("GATE RECORDS - MAIN GATE", text.upper())  # the title row
        self.assertIn("Exit recorded via Main Gate", text)
        self.assertIn("Tea break ended", text)
        self.assertNotIn("Back Gate", text)
        for secret in (self.gate.password_hash, self.gate.login_token):
            self.assertNotIn(secret, text)

    def test_the_files_audit_row_names_the_gate_and_its_branch(self):
        # S7 (19 Nov 2026): an action of the gate itself is "Gate - <name>" at the gate's branch, never "system"
        from .models import AuditLog

        self.assertEqual(self.get("/api/gate-monitor/records/export", self.token, fmt="xlsx").status_code, 200)
        row = AuditLog.objects.get(action="export", module="outpass_visitors")
        self.assertEqual(
            (row.user_name, row.user_type, row.branch_id), ("Gate - Main Gate", "gate_device", self.branch.id)
        )

    def test_the_file_follows_the_filters(self):
        response = self.get("/api/gate-monitor/records/export", self.token, fmt="xlsx", result="denied")
        sheet = load_workbook(io.BytesIO(response.content)).active
        text = "\n".join(str(c) for row in sheet.iter_rows(values_only=True) for c in row if c is not None)
        self.assertIn("This Outpass has expired.", text)
        self.assertNotIn("Exit recorded via Main Gate", text)

    def test_pdf_is_a_pdf_and_a_bad_format_is_400(self):
        response = self.get("/api/gate-monitor/records/export", self.token, fmt="pdf")
        self.assertEqual(response.status_code, 200)
        self.assertTrue(response.content.startswith(b"%PDF"))
        self.assertEqual(self.get("/api/gate-monitor/records/export", self.token, fmt="csv").status_code, 400)
        self.assertEqual(self.get("/api/gate-monitor/records/export", self.token).status_code, 400)
        self.assertEqual(
            self.get("/api/gate-monitor/records/export", self.token, fmt="xlsx", type="x").status_code, 400
        )


class ScanAllowFlagTests(GateMonitorFixture):
    def setUp(self):
        super().setUp()
        self.token = self.token_for()

    def scan(self, code, path="/api/gate-monitor/scan"):
        return self.post(path, self.token, {"qrToken": code})

    def test_a_gate_that_takes_everything_scans_like_the_old_endpoint(self):
        req = self.approved_pass()
        response = self.scan(gate_qr.pass_code(req.id, timedelta(minutes=60)))
        self.assertEqual(response.status_code, 200)
        body = response.json()
        self.assertEqual((body["result"], body["scanType"]), ("success", "exit"))
        for key in (
            "message",
            "employee",
            "destination",
            "reason",
            "approvedBy",
            "approvedAt",
            "expiresAt",
            "gateName",
        ):
            self.assertIn(key, body)
        tea = self.scan(gate_qr.tea_code(self.emp.id))
        self.assertEqual((tea.status_code, tea.json()["result"], tea.json()["action"]), (200, "success", "out"))
        again = self.scan(gate_qr.pass_code(req.id, timedelta(minutes=60)))
        self.assertEqual((again.status_code, again.json()["result"]), (409, "already_scanned"))
        bad = self.scan("hello")
        self.assertEqual((bad.status_code, bad.json()["result"]), (400, "invalid_qr"))
        self.assertEqual(self.post("/api/gate-monitor/scan", self.token, {"qrToken": 123}).status_code, 400)

    def test_a_gate_without_gate_passes_refuses_and_logs_them(self):
        GateDevice.objects.filter(pk=self.gate.pk).update(allow_outpass=False)
        req = self.approved_pass()
        for path in ("/api/gate-monitor/scan", "/api/gate-devices/scan"):
            response = self.scan(gate_qr.pass_code(req.id, timedelta(minutes=60)), path)
            self.assertEqual(response.status_code, 403, path)
            body = response.json()
            self.assertEqual(body["result"], "not_allowed_here")
            self.assertEqual(body["message"], "This gate does not take gate passes.")
            self.assertEqual(body["employee"]["employeeCode"], "GM001")
        req.refresh_from_db()
        self.assertIsNone(req.exited_at)
        rows = OutpassGateScan.objects.filter(outpass_request=req)
        self.assertEqual(rows.count(), 2)
        self.assertEqual(set(rows.values_list("result", flat=True)), {OutpassGateScan.RESULT_NOT_ALLOWED_HERE})
        # a return pass is refused as a return
        back = self.approved_pass(exit_gate=self.other, exited_at=timezone.now(), return_qr_generated_at=timezone.now())
        code = gate_qr.return_code(back.id, back.return_qr_generated_at, timedelta(minutes=60))
        self.assertEqual(self.scan(code).json()["scanType"], "entry")
        self.assertEqual(OutpassGateScan.objects.get(outpass_request=back).scan_type, OutpassGateScan.SCAN_TYPE_ENTRY)
        # tea breaks still work at this gate
        self.assertEqual(self.scan(gate_qr.tea_code(self.emp.id)).status_code, 200)
        # and the refusal is in the gate's records, as denied
        denied = self.get("/api/gate-monitor/records", self.token, result="denied").json()["items"]
        self.assertEqual({r["reasonLabel"] for r in denied}, {"Not allowed at this gate"})

    def test_a_gate_without_tea_breaks_refuses_them_and_shows_the_refusal(self):
        GateDevice.objects.filter(pk=self.gate.pk).update(allow_tea_break=False)
        response = self.scan(gate_qr.tea_code(self.emp.id))
        self.assertEqual(response.status_code, 403)
        body = response.json()
        self.assertEqual(
            (body["result"], body["message"], body["employee"]["name"]),
            ("not_allowed_here", "This gate does not take tea-break scans.", "Asha Kumar"),
        )
        self.assertFalse(TeaBreakLog.objects.exists())
        row = OutpassGateScan.objects.get()
        self.assertEqual((row.result, row.employee_id, row.gate_id), ("not_allowed_here", self.emp.id, self.gate.id))
        records = self.get("/api/gate-monitor/records", self.token).json()["items"]
        self.assertEqual(
            [(r["result"], r["message"]) for r in records], [("denied", "This gate does not take tea-break scans.")]
        )
        # gate passes still work here
        req = self.approved_pass()
        self.assertEqual(self.scan(gate_qr.pass_code(req.id, timedelta(minutes=60))).status_code, 200)
        # an unreadable code is still "not recognised", not "not allowed"
        self.assertEqual(self.scan("T.ZZZ.NOPE").json()["result"], "invalid_qr")

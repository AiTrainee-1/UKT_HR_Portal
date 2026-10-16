"""Short signed gate QR codes (gate_qr.py): the code itself, and the gate scanner accepting it (and still the old JWT).

Run via: python manage.py test api.tests_gate_qr -v 2
"""

import time
from datetime import timedelta
from unittest.mock import patch

from django.test import SimpleTestCase, TestCase, override_settings
from django.utils import timezone

from . import gate_qr
from .gate_scanner_views import resolve_gate_scan
from .jwt_utils import sign_token
from .models import Branch, Employee, GateDevice, OutpassGateScan, OutpassRequest
from .outpass_request_views import _outpass_request_json

QR_ALPHANUMERIC = set("0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ $%*+-./:")


class CodeTests(SimpleTestCase):
    def test_a_pass_code_round_trips(self):
        code = gate_qr.pass_code(76, timedelta(minutes=30))
        self.assertEqual(gate_qr.parse(code), {"role": "outpass_pass", "requestId": 76})

    def test_a_return_code_carries_the_generation_instant_exactly(self):
        generated = timezone.now()
        code = gate_qr.return_code(76, generated, timedelta(minutes=60))
        payload = gate_qr.parse(code)
        self.assertEqual((payload["role"], payload["requestId"]), ("outpass_return", 76))
        from datetime import datetime

        self.assertEqual(datetime.fromisoformat(payload["generatedAt"]), generated)  # to the microsecond

    def test_a_tea_code_round_trips_and_does_not_expire(self):
        code = gate_qr.tea_code(1234)
        self.assertEqual(gate_qr.parse(code), {"role": "tea_break", "employeeId": 1234})
        with patch("api.gate_qr.time.time", return_value=time.time() + 3650 * 86400 * 5):
            self.assertEqual(gate_qr.parse(code)["employeeId"], 1234)

    def test_the_codes_are_short_and_qr_alphanumeric(self):
        for code in (
            gate_qr.pass_code(76, timedelta(hours=1)),
            gate_qr.return_code(76, timezone.now(), timedelta(hours=1)),
            gate_qr.tea_code(76),
        ):
            self.assertLess(len(code), 48, code)  # the old JWT was 223 characters
            self.assertTrue(set(code) <= QR_ALPHANUMERIC, code)  # the dense-free QR mode every scanner reads

    def test_a_changed_character_anywhere_is_refused(self):
        code = gate_qr.return_code(76, timezone.now(), timedelta(hours=1))
        for i, ch in enumerate(code):
            if ch == ".":
                continue
            other = "0" if ch != "0" else "1"
            with self.assertRaises(gate_qr.GateQrError, msg=f"position {i}"):
                gate_qr.parse(code[:i] + other + code[i + 1 :])

    def test_another_request_with_the_same_signature_is_refused(self):
        code = gate_qr.pass_code(76, timedelta(hours=1))
        parts = code.split(".")
        forged = ".".join([parts[0], "77", parts[2], parts[3]])  # someone else's request number
        with self.assertRaises(gate_qr.GateQrError):
            gate_qr.parse(forged)

    def test_a_pass_cannot_be_turned_into_another_kind(self):
        code = gate_qr.pass_code(76, timedelta(hours=1))
        for fake_prefix in ("R", "T"):
            with self.assertRaises(gate_qr.GateQrError):
                gate_qr.parse(fake_prefix + code[1:])

    def test_a_code_without_its_signature_or_cut_short_is_refused(self):
        code = gate_qr.pass_code(76, timedelta(hours=1))
        for cut in (code[: code.rindex(".")], code[:-1], code[:10], "P.", "P", "", None, "   "):
            with self.assertRaises(gate_qr.GateQrError):
                gate_qr.parse(cut)

    def test_an_expired_code_is_refused(self):
        code = gate_qr.pass_code(76, timedelta(minutes=5))
        with patch("api.gate_qr.time.time", return_value=time.time() + 600):
            with self.assertRaises(gate_qr.GateQrError):
                gate_qr.parse(code)

    def test_a_scanner_that_lowercases_or_pads_the_text_still_works(self):
        code = gate_qr.pass_code(76, timedelta(hours=1))
        self.assertEqual(gate_qr.parse("  " + code.lower() + "\r\n")["requestId"], 76)

    def test_a_code_made_with_another_secret_is_refused(self):
        with override_settings(JWT_SECRET="another-secret-entirely"):
            code = gate_qr.pass_code(76, timedelta(hours=1))
        with self.assertRaises(gate_qr.GateQrError):
            gate_qr.parse(code)

    def test_the_jwt_signing_key_cannot_forge_a_code(self):
        # the code key is derived for this purpose only: a JWT-style HMAC of the same body is not accepted
        import base64
        import hashlib
        import hmac

        from django.conf import settings

        body = "P.22.2X7K9A"
        raw = hmac.new(settings.JWT_SECRET.encode(), body.encode(), hashlib.sha256).digest()[:12]
        forged = body + "." + base64.b32encode(raw).decode().rstrip("=")
        with self.assertRaises(gate_qr.GateQrError):
            gate_qr.parse(forged)

    def test_hostile_text_never_raises_anything_else(self):
        for text in ("P." + "Z" * 5000, "P.ZZ.ZZ.ZZ.ZZ.ZZ", "R..", "T.%.%", "P.ZZ.ZZ.\x00", "ÄÖ", "P.-1.0.AAA"):
            with self.assertRaises(gate_qr.GateQrError):
                gate_qr.parse(text)

    def test_shape_helpers(self):
        self.assertTrue(gate_qr.looks_like_code(gate_qr.tea_code(5)))
        self.assertFalse(gate_qr.looks_like_code("eyJhbGciOiJIUzI1NiJ9.e30.abc"))
        self.assertTrue(gate_qr.looks_like_cut_jwt("eyJhbGciOiJIUzI1NiJ9.eyJyb2xlIjoieCJ9."))
        self.assertTrue(gate_qr.looks_like_cut_jwt("eyJhbGciOiJIUzI1NiJ9.eyJyb2xlIjoi"))
        self.assertFalse(gate_qr.looks_like_cut_jwt("eyJhbGciOiJIUzI1NiJ9.eyJyb2xlIjoieCJ9.sig"))
        self.assertFalse(gate_qr.looks_like_cut_jwt("garbage"))


class GateScanWithShortCodesTests(TestCase):
    def setUp(self):
        branch = Branch.objects.create(name="QR Unit")
        self.gate = GateDevice.objects.create(
            name="Gate Q", branch=branch, username="gateq", password_hash="x", login_token="tq"
        )
        self.emp = Employee.objects.create(
            employee_code="QR_EMP1", first_name="Qr", last_name="Tester", employment_type="staff", status="active"
        )

    def approved(self, **kw):
        base = dict(
            employee=self.emp,
            destination="Bank",
            reason="Cash",
            status=OutpassRequest.STATUS_APPROVED,
            approved_at=timezone.now(),
            approver_role="hr",
            approved_by="HR",
        )
        base.update(kw)
        return OutpassRequest.objects.create(**base)

    def test_the_exit_code_the_api_gives_is_short_and_records_the_exit(self):
        req = self.approved()
        token = _outpass_request_json(req)["qrToken"]
        self.assertTrue(gate_qr.looks_like_code(token))
        self.assertLess(len(token), 48)
        body, status = resolve_gate_scan(self.gate, token)
        self.assertEqual((status, body["result"]), (200, "success"))
        req.refresh_from_db()
        self.assertIsNotNone(req.exited_at)

    def test_a_used_exit_code_is_refused_the_second_time(self):
        req = self.approved()
        token = _outpass_request_json(req)["qrToken"]
        resolve_gate_scan(self.gate, token)
        body, status = resolve_gate_scan(self.gate, token)
        self.assertEqual((status, body["result"]), (409, "already_scanned"))

    def test_the_old_long_token_still_works_for_a_pass_already_on_a_phone(self):
        req = self.approved()
        old = sign_token({"role": "outpass_pass", "requestId": req.id}, expires_in=timedelta(minutes=30))
        self.assertGreater(len(old), 100)
        body, status = resolve_gate_scan(self.gate, old)
        self.assertEqual((status, body["result"]), (200, "success"))

    def test_a_forged_or_other_request_code_is_not_recognized(self):
        req = self.approved()
        good = gate_qr.pass_code(req.id, timedelta(minutes=30))
        parts = good.split(".")
        for bad in (".".join([parts[0], parts[1], parts[2], "A" * 20]), good[:-3] + "AAA", ".".join(parts[:3])):
            body, status = resolve_gate_scan(self.gate, bad)
            self.assertEqual((status, body["result"]), (400, "invalid_qr"), bad)
        req.refresh_from_db()
        self.assertIsNone(req.exited_at)

    def test_a_cut_long_token_gets_a_scan_again_message_and_is_logged(self):
        req = self.approved()
        old = sign_token({"role": "outpass_pass", "requestId": req.id}, expires_in=timedelta(minutes=30))
        cut = old[: old.rindex(".") + 1]  # exactly what the scanner produced
        body, status = resolve_gate_scan(self.gate, cut)
        self.assertEqual((status, body["result"]), (400, "invalid_qr"))
        self.assertIn("scan it again", body["message"])
        self.assertTrue(
            OutpassGateScan.objects.filter(gate=self.gate, result=OutpassGateScan.RESULT_INVALID_QR).exists()
        )
        req.refresh_from_db()
        self.assertIsNone(req.exited_at)

    def test_garbage_still_says_not_recognized(self):
        body, status = resolve_gate_scan(self.gate, "hello world")
        self.assertEqual((status, body["message"]), (400, "This QR code is not recognized."))

    def exited(self):
        return self.approved(exited_at=timezone.now() - timedelta(minutes=10), exit_gate=self.gate)

    def test_the_return_code_records_the_return(self):
        req = self.exited()
        req.return_qr_generated_at = timezone.now()
        req.save()
        token = _outpass_request_json(req)["returnQrToken"]
        self.assertTrue(gate_qr.looks_like_code(token))
        self.assertLess(len(token), 48)
        body, status = resolve_gate_scan(self.gate, token)
        self.assertEqual((status, body["result"], body["scanType"]), (200, "success", "entry"))
        req.refresh_from_db()
        self.assertIsNotNone(req.entered_at)

    def test_an_older_return_code_is_stale_once_a_newer_one_is_generated(self):
        req = self.exited()
        req.return_qr_generated_at = timezone.now() - timedelta(minutes=5)
        req.save()
        older = _outpass_request_json(req)["returnQrToken"]
        req.return_qr_generated_at = timezone.now()
        req.save()
        newer = _outpass_request_json(req)["returnQrToken"]
        self.assertNotEqual(older, newer)
        body, status = resolve_gate_scan(self.gate, older)
        self.assertEqual((status, body["result"]), (400, "invalid_qr"))
        self.assertIn("newer one", body["message"])
        req.refresh_from_db()
        self.assertIsNone(req.entered_at)
        body, status = resolve_gate_scan(self.gate, newer)
        self.assertEqual((status, body["result"]), (200, "success"))

    def test_the_old_long_return_token_still_checks_its_generation_instant(self):
        req = self.exited()
        req.return_qr_generated_at = timezone.now()
        req.save()
        live = sign_token(
            {"role": "outpass_return", "requestId": req.id, "generatedAt": req.return_qr_generated_at.isoformat()},
            expires_in=timedelta(minutes=30),
        )
        stale = sign_token(
            {
                "role": "outpass_return",
                "requestId": req.id,
                "generatedAt": (req.return_qr_generated_at - timedelta(minutes=1)).isoformat(),
            },
            expires_in=timedelta(minutes=30),
        )
        self.assertEqual(resolve_gate_scan(self.gate, stale)[1], 400)
        self.assertEqual(resolve_gate_scan(self.gate, live)[1], 200)

    def test_the_tea_break_code_identifies_the_employee(self):
        from .tea_break_views import tea_break_qr_token
        from rest_framework.test import APIRequestFactory

        token = sign_token({"role": "employee", "employeeId": self.emp.id})
        response = tea_break_qr_token(
            APIRequestFactory().get("/api/tea-break/qr-token", HTTP_AUTHORIZATION=f"Bearer {token}")
        )
        code = response.data["qrToken"]
        self.assertTrue(gate_qr.looks_like_code(code))
        self.assertLess(len(code), 48)
        self.assertEqual(gate_qr.parse(code), {"role": "tea_break", "employeeId": self.emp.id})
        body, status = resolve_gate_scan(self.gate, code)
        self.assertEqual(status, 200)

    def test_a_tea_code_of_a_missing_employee_is_refused_plainly(self):
        body, status = resolve_gate_scan(self.gate, gate_qr.tea_code(99999999))
        self.assertEqual((status, body["result"]), (404, "invalid_qr"))

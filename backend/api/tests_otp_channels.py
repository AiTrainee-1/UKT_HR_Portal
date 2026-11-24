"""
WhatsApp codes and SMS codes are INDEPENDENT (owner, 2026-11-20): either one alone is enough, both may be on, neither reads
the other's settings, and the apps follow both (GET /api/auth/login-options). Pinned here: the availability matrix (only
WhatsApp / only SMS / both / neither, per purpose), the `channel` an app may ask for, an older app that names none, each
channel's own expiry / cooldown / allowance / attempt limit, "only the newest code works" across channels, and the
lockout rules (password sign-in and first-time activation) with both channels in play.

No provider is contacted: WhatsApp's one send call is faked (tests_otp.WhatsAppOtpMixin) and 2Factor's HTTP call is mocked
(tests_sms_otp), with a guard that fails any real network connection.
"""

from datetime import timedelta
from unittest import mock

import bcrypt
from django.core.cache import cache
from django.test import TestCase, override_settings
from django.utils import timezone

from . import otp_service
from .models import Employee, EmployeeOtp, SmsMessageLog
from .tests_otp import WhatsAppOtpMixin, set_whatsapp_template, sms_settings, whatsapp_settings
from .tests_sms_otp import GET, SMS_CONFIG, NoNetworkMixin, code_in, provider_ok

ALL_PURPOSES = ("login", "reset", "activate")


@override_settings(**SMS_CONFIG)
class ChannelsBase(WhatsAppOtpMixin, NoNetworkMixin, TestCase):
    """Both channels able to deliver and switched on (WhatsApp faked, 2Factor mocked)."""

    def setUp(self):
        super().setUp()
        cache.clear()
        self.addCleanup(cache.clear)
        self.emp = Employee.objects.create(
            employee_code="E100", first_name="Asha", last_name="Kumar", phone="82200 15110", status="active"
        )
        whatsapp_settings(otp_enabled=True)
        sms_settings(otp_enabled=True)

    def post(self, path, body):
        return self.client.post(f"/api/auth/{path}", body, content_type="application/json")

    def options(self):
        return self.client.get("/api/auth/login-options").json()

    def ask(self, channel=None, purpose="login", code="E100"):
        """Ask for a code: (response, the code that went out by either channel or None)."""
        body = {"employeeCode": code, "purpose": purpose}
        if channel is not None:
            body["channel"] = channel
        before = len(self.whatsapp_sent)
        with mock.patch(GET, return_value=provider_ok()) as get:
            r = self.post("otp/request", body)
        if get.called:
            return r, code_in(get.call_args)
        sent = self.whatsapp_sent[before:]
        return r, (sent[-1]["code"] if sent else None)

    def login(self, code):
        return self.post("otp/login", {"employeeCode": "E100", "otp": code})

    def age_codes(self, seconds, **filters):
        EmployeeOtp.objects.filter(**filters).update(created_at=timezone.now() - timedelta(seconds=seconds))


class AvailabilityMatrixTests(ChannelsBase):
    def test_both_on(self):
        body = self.options()
        self.assertEqual(
            body,
            {
                "otpLogin": True,
                "otpReset": True,
                "otpActivate": True,
                "passwordLogin": True,
                "otpChannel": "whatsapp",
                "codeLength": 6,
                "otpChannels": {p: ["whatsapp", "sms"] for p in ALL_PURPOSES},
                "channels": {
                    "whatsapp": {"name": "WhatsApp", "codeLength": 6},
                    "sms": {"name": "SMS", "codeLength": 4},
                },
            },
        )

    def test_only_whatsapp_on(self):
        sms_settings(otp_enabled=False)
        body = self.options()
        self.assertEqual(body["otpChannels"], {p: ["whatsapp"] for p in ALL_PURPOSES})
        self.assertEqual(
            (body["otpChannel"], body["codeLength"], list(body["channels"])), ("whatsapp", 6, ["whatsapp"])
        )

    def test_only_sms_on(self):
        whatsapp_settings(otp_enabled=False)
        body = self.options()
        self.assertEqual(body["otpChannels"], {p: ["sms"] for p in ALL_PURPOSES})
        self.assertEqual((body["otpChannel"], body["codeLength"], list(body["channels"])), ("sms", 4, ["sms"]))

    def test_neither_on(self):
        whatsapp_settings(otp_enabled=False)
        sms_settings(otp_enabled=False)
        body = self.options()
        self.assertEqual(body["otpChannels"], {p: [] for p in ALL_PURPOSES})
        self.assertEqual(
            (body["otpLogin"], body["otpReset"], body["otpActivate"], body["passwordLogin"]),
            (False, False, False, True),
        )
        self.assertEqual((body["otpChannel"], body["codeLength"], body["channels"]), (None, 6, {}))

    def test_each_purpose_is_decided_per_channel(self):
        whatsapp_settings(otp_reset_enabled=False, otp_activate_enabled=False)
        sms_settings(otp_login_enabled=False)
        body = self.options()
        self.assertEqual(body["otpChannels"], {"login": ["whatsapp"], "reset": ["sms"], "activate": ["sms"]})
        self.assertEqual(body["otpChannel"], "whatsapp")  # older apps: the first channel of the login list
        whatsapp_settings(otp_enabled=False)
        body = self.options()
        self.assertEqual(body["otpChannels"], {"login": [], "reset": ["sms"], "activate": ["sms"]})
        self.assertEqual(
            (body["otpLogin"], body["otpReset"], body["otpChannel"], body["codeLength"]), (False, True, "sms", 4)
        )

    def test_one_channel_failing_never_takes_the_other_down(self):
        for why, flip in (
            ("WhatsApp not configured", lambda on: setattr(self, "whatsapp_configured", on)),
            ("WhatsApp master switch off", lambda on: whatsapp_settings(engine_enabled=on)),
            ("WhatsApp template pending", lambda on: set_whatsapp_template("APPROVED" if on else "PENDING")),
        ):
            with self.subTest(why):
                flip(False)
                self.assertEqual(self.options()["otpChannels"]["login"], ["sms"])
                flip(True)
                self.assertEqual(self.options()["otpChannels"]["login"], ["whatsapp", "sms"])
        for why, values in (
            ("2Factor not configured", {"TWOFACTOR_API_KEY": ""}),
            ("SMS not allowed on this machine", {"SMS_ALLOW_SENDING": False}),
        ):
            with self.subTest(why), override_settings(**values):
                self.assertEqual(self.options()["otpChannels"]["login"], ["whatsapp"])
        self.assertEqual(self.options()["otpChannels"]["login"], ["whatsapp", "sms"])

    def test_a_temporary_sms_pause_keeps_sms_listed(self):
        sms_settings(hourly_cap=1)
        SmsMessageLog.objects.create(purpose="login", status="sent", created_at=timezone.now())
        self.assertEqual(self.options()["otpChannels"]["login"], ["whatsapp", "sms"])
        r, _ = self.ask("sms")
        self.assertEqual(r.status_code, 503)  # the request fails with the plain sentence instead
        self.assertEqual(r.json()["otherChannels"], ["whatsapp"])

    def test_the_channel_status_helper_for_the_control_pages(self):
        status = otp_service.channel_status("whatsapp")
        self.assertEqual(
            {k: status[k] for k in ("channel", "enabled", "available", "purposes", "paused", "codeLength")},
            {
                "channel": "whatsapp",
                "enabled": True,
                "available": True,
                "purposes": {p: True for p in ALL_PURPOSES},
                "paused": False,
                "codeLength": 6,
            },
        )
        self.assertEqual(
            (status["templateName"], status["templateStatus"]),
            (otp_service.whatsapp_template_name("login"), "APPROVED"),
        )
        self.assertEqual(status["problems"], {p: [] for p in ALL_PURPOSES})
        set_whatsapp_template("REJECTED")
        whatsapp_settings(otp_reset_enabled=False)
        status = otp_service.channel_status("whatsapp")
        self.assertFalse(status["available"])
        self.assertIn("not approved by Meta (status: REJECTED)", " ".join(status["problems"]["login"]))
        self.assertIn("password reset are switched off", " ".join(status["problems"]["reset"]))
        sms = otp_service.channel_status("sms")
        self.assertEqual((sms["available"], sms["codeLength"], sms["expiryMinutes"]), (True, 4, 5))
        self.assertNotIn("templateName", sms)
        self.assertEqual(otp_service.otp_channels(), {"login": ["sms"], "reset": ["sms"], "activate": ["sms"]})


class ChooseChannelTests(ChannelsBase):
    def test_an_older_app_that_names_no_channel_gets_whatsapp_first(self):
        r, code = self.ask()
        self.assertEqual(r.status_code, 200)
        body = r.json()
        self.assertEqual((body["channel"], body["codeLength"], body["otherChannels"]), ("whatsapp", 6, ["sms"]))
        self.assertEqual(len(code), 6)
        self.assertEqual(self.login(code).status_code, 200)

    def test_with_whatsapp_unavailable_an_older_app_gets_sms(self):
        set_whatsapp_template("PENDING")
        r, code = self.ask()
        self.assertEqual((r.status_code, r.json()["channel"], r.json()["otherChannels"]), (200, "sms", []))
        self.assertEqual(len(code), 4)

    def test_the_employee_can_choose_either_channel(self):
        r, code = self.ask("sms")
        self.assertEqual(r.status_code, 200)
        self.assertEqual(
            {k: r.json()[k] for k in ("channel", "codeLength", "otherChannels", "message")},
            {
                "channel": "sms",
                "codeLength": 4,
                "otherChannels": ["whatsapp"],
                "message": "We've sent a code by SMS to " + "•" * 8 + "5110.",
            },
        )
        self.assertEqual(self.whatsapp_sent, [])
        self.assertEqual(EmployeeOtp.objects.get().channel, "sms")
        self.assertEqual(self.login(code).status_code, 200)
        r, code = self.ask("whatsapp", purpose="reset")
        self.assertEqual((r.json()["channel"], r.json()["otherChannels"]), ("whatsapp", ["sms"]))
        self.assertFalse(SmsMessageLog.objects.filter(purpose="reset").exists())

    def test_a_channel_that_is_not_available_is_a_400_naming_what_is(self):
        sms_settings(otp_enabled=False)
        r, _ = self.ask("sms")
        self.assertEqual(r.status_code, 400)
        self.assertEqual(
            r.json(),
            {
                "error": "SMS codes aren't available right now. Please choose WhatsApp.",
                "message": "SMS codes aren't available right now. Please choose WhatsApp.",
                "code": "channel_unavailable",
                "availableChannels": ["whatsapp"],
            },
        )
        whatsapp_settings(otp_enabled=False)
        r, _ = self.ask("whatsapp")
        self.assertEqual(
            r.json()["error"], "WhatsApp codes aren't available right now. Please use your password or contact HR."
        )
        self.assertEqual(r.json()["availableChannels"], [])
        self.assertFalse(EmployeeOtp.objects.exists())

    def test_an_empty_channel_means_whichever_works(self):
        r = self.post("otp/request", {"employeeCode": "E100", "purpose": "login", "channel": ""})
        self.assertEqual((r.status_code, r.json()["channel"]), (200, "whatsapp"))

    def test_a_failed_whatsapp_send_names_sms_as_the_way_out(self):
        self.whatsapp_ok = False
        r, _ = self.ask("whatsapp")
        self.assertEqual(r.status_code, 502)
        self.assertEqual(r.json()["otherChannels"], ["sms"])
        r, code = self.ask("sms")  # "Didn't get it? Send by SMS instead"
        self.assertEqual(r.status_code, 200)
        self.assertEqual(self.login(code).status_code, 200)


class PerChannelLimitsTests(ChannelsBase):
    def test_each_channel_has_its_own_cooldown(self):
        self.assertEqual(self.ask("whatsapp")[0].status_code, 200)
        r, _ = self.ask("whatsapp")
        self.assertEqual(r.status_code, 429)
        self.assertEqual(r.json()["otherChannels"], ["sms"])
        r, code = self.ask("sms")  # the WhatsApp cooldown does not hold up the SMS
        self.assertEqual(r.status_code, 200)
        self.assertEqual(self.ask("sms")[0].status_code, 429)
        self.assertEqual(self.login(code).status_code, 200)

    def test_only_the_newest_code_works_whichever_channel_sent_it(self):
        _, whatsapp_code = self.ask("whatsapp")
        _, sms_code = self.ask("sms")
        self.assertEqual(self.login(whatsapp_code).status_code, 400)  # replaced by the SMS one
        self.assertEqual(self.login(sms_code).status_code, 200)
        killed = EmployeeOtp.objects.get(channel="whatsapp")
        self.assertEqual(killed.consumed_at, killed.expires_at)  # dead, never "verified"
        self.assertEqual(
            (otp_service.verified_codes("sms").count(), otp_service.verified_codes("whatsapp").count()), (1, 0)
        )

    def test_each_channel_has_its_own_hourly_allowance(self):
        sms_settings(max_requests_per_hour=2, resend_cooldown_seconds=30)
        for _ in range(2):
            self.assertEqual(self.ask("sms")[0].status_code, 200)
            self.age_codes(120, channel="sms")
        r, _ = self.ask("sms")
        self.assertEqual(r.status_code, 429)
        self.assertIn("hour", r.json()["error"])
        self.assertEqual(self.ask("whatsapp")[0].status_code, 200)  # WhatsApp's own 5 an hour are untouched

    def test_each_channel_has_its_own_expiry(self):
        whatsapp_settings(otp_expiry_minutes=9)
        sms_settings(otp_expiry_minutes=3)
        self.assertEqual(self.ask("whatsapp")[0].json()["expiresInSeconds"], 540)
        self.assertEqual(self.ask("sms")[0].json()["expiresInSeconds"], 180)

    def test_each_code_gets_its_own_channels_attempt_limit(self):
        sms_settings(max_attempts_per_code=3)
        _, code = self.ask("whatsapp")
        for _ in range(4):  # more than SMS's 3: a WhatsApp code keeps WhatsApp's 5
            self.assertEqual(self.login("000000" if code != "000000" else "111111").status_code, 400)
        self.assertEqual(self.login(code).status_code, 200)
        _, code = self.ask("sms", purpose="reset")
        for _ in range(3):
            self.post(
                "otp/reset-password",
                {"employeeCode": "E100", "otp": "0000" if code != "0000" else "1111", "password": "long-enough-1"},
            )
        r = self.post("otp/reset-password", {"employeeCode": "E100", "otp": code, "password": "long-enough-1"})
        self.assertEqual(r.status_code, 429)

    def test_the_sms_caps_never_touch_whatsapp(self):
        sms_settings(hourly_cap=1)
        SmsMessageLog.objects.create(purpose="login", status="sent", created_at=timezone.now())
        r, code = self.ask("whatsapp")
        self.assertEqual(r.status_code, 200)
        self.assertEqual(self.login(code).status_code, 200)

    def test_a_malformed_code_names_both_lengths_while_both_channels_are_on(self):
        self.assertEqual(self.login("12345").json()["error"], "Enter the 4 or 6-digit code.")
        sms_settings(otp_enabled=False)
        self.assertEqual(self.login("12345").json()["error"], "Enter the 6-digit code.")


class LockoutTests(ChannelsBase):
    def setUp(self):
        super().setUp()
        self.emp.password_hash = bcrypt.hashpw(b"correct-horse", bcrypt.gensalt(rounds=4)).decode()
        self.emp.save()
        whatsapp_settings(password_login_enabled=False)

    def password_login(self):
        return self.post("employee-login", {"identifier": "E100", "password": "correct-horse"})

    def use_up_the_sms_cap(self):
        sms_settings(hourly_cap=1)
        SmsMessageLog.objects.create(purpose="login", status="sent", created_at=timezone.now())

    def test_password_sign_in_works_whichever_channel_works(self):
        # 2026-11-24: password sign-in is always on (the old "password off" switch no longer refuses it).
        self.assertEqual(self.password_login().status_code, 200)
        self.assertTrue(self.options()["passwordLogin"])
        sms_settings(otp_enabled=False)
        self.assertEqual(self.password_login().status_code, 200)
        sms_settings(otp_enabled=True)
        whatsapp_settings(otp_enabled=False)
        self.assertEqual(self.password_login().status_code, 200)

    def test_a_paused_sms_alone_opens_password_sign_in(self):
        whatsapp_settings(otp_enabled=False)
        self.use_up_the_sms_cap()
        self.assertTrue(self.options()["passwordLogin"])
        self.assertEqual(self.password_login().status_code, 200)

    def test_a_paused_sms_next_to_a_working_whatsapp_keeps_password_open_too(self):
        self.use_up_the_sms_cap()
        self.assertTrue(self.options()["passwordLogin"])  # password sign-in is always on since 2026-11-24
        self.assertEqual(self.password_login().status_code, 200)

    def test_open_while_no_channel_can_send_a_sign_in_code(self):
        for why, values in (
            ("both off", ({"otp_enabled": False}, {"otp_enabled": False})),
            ("both sign-in switches off", ({"otp_login_enabled": False}, {"otp_login_enabled": False})),
        ):
            with self.subTest(why):
                whatsapp_settings(**values[0])
                sms_settings(**values[1])
                self.assertTrue(self.options()["passwordLogin"])
                self.assertEqual(self.password_login().status_code, 200)
                whatsapp_settings(otp_enabled=True, otp_login_enabled=True)
                sms_settings(otp_enabled=True, otp_login_enabled=True)

    def test_activation_needs_a_code_while_either_channel_can_send_one(self):
        fresh = Employee.objects.create(
            employee_code="E900", first_name="New", last_name="Hire", phone="9000000900", status="active"
        )

        def stranger_sets_password():
            return self.post("set-password", {"identifier": "E900", "password": "attacker-pass"})

        r = stranger_sets_password()
        self.assertEqual(r.status_code, 403)
        self.assertEqual(
            r.json()["error"],
            "Please confirm the code we send to your registered mobile number (by WhatsApp or SMS) to set your password.",
        )
        whatsapp_settings(otp_activate_enabled=False)
        self.assertEqual(stranger_sets_password().status_code, 403)  # SMS alone still requires it
        self.use_up_the_sms_cap()
        self.assertEqual(stranger_sets_password().status_code, 403)  # a pause never reopens the open setup
        sms_settings(otp_activate_enabled=False)
        self.assertFalse(otp_service.activation_required())
        self.assertEqual(stranger_sets_password().status_code, 200)  # nobody is locked out
        self.assertTrue(Employee.objects.get(pk=fresh.pk).password_hash)

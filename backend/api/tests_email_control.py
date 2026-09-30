"""Gmail Control: the email catalog, wording, the central send service, the control page API and the
senders that now go through the service. smtplib is always mocked - no test talks to a mail server."""

import re
import smtplib
from datetime import date, timedelta
from unittest import mock

from django.test import TestCase, override_settings
from django.utils import timezone

from . import email_catalog as catalog, email_service
from .jwt_utils import sign_token
from .models import (
    Branch,
    Department,
    EmailMessageLog,
    EmailMessageTemplate,
    EmailSettings,
    Employee,
    HiringRuleSet,
    HRUser,
    PayrollSettings,
    ResignationRequest,
    Role,
    SalarySlip,
    ScreeningCandidate,
    Visitor,
    VisitorVisit,
)

BASE = "/api/gmail-control"
SMTP = "api.email_service.smtplib.SMTP"
SMTP_SSL = "api.email_service.smtplib.SMTP_SSL"


def _hr(username="gc_admin", super_admin=True, role=None, branch=None):
    user, _ = HRUser.objects.get_or_create(
        username=username,
        defaults={"password_hash": "x", "is_super_admin": super_admin, "role": role, "branch": branch},
    )
    return {"HTTP_AUTHORIZATION": f"Bearer {sign_token({'role': 'hr', 'hrUserId': user.id})}"}


def configure_smtp(**overrides):
    ps = PayrollSettings.get()
    values = dict(
        smtp_host="smtp.gmail.com",
        smtp_port=587,
        smtp_username="hr@example.test",
        smtp_password="app-password-1234",
        smtp_from_email="hr@example.test",
        smtp_from_name="Acme HR",
        company_name="Acme Mills",
    )
    values.update(overrides)
    for field, value in values.items():
        setattr(ps, field, value)
    ps.save()
    return ps


def sent_message(server):
    """The EmailMessage handed to send_message on a mocked SMTP server."""
    (msg,), kwargs = server.send_message.call_args
    return msg, kwargs


@override_settings(EMAIL_ALLOW_SENDING=True)
class EmailBase(TestCase):
    def setUp(self):
        self.hr = _hr()
        self.ps = configure_smtp()
        self.asha = Employee.objects.create(
            employee_code="A1", first_name="Asha", last_name="Kumar", email="asha@example.test", status="active"
        )
        self.ravi = Employee.objects.create(
            employee_code="R1", first_name="Ravi", last_name="Nair", email="ravi@example.test", status="active"
        )

    def send(self, email_type="test_email", to="asha@example.test", **kwargs):
        kwargs.setdefault("params", {})
        return email_service.send_email(email_type, to_email=to, ps=self.ps, **kwargs)

    def row(self, emp, email_type="salary_slip", status="sent", **kw):
        return EmailMessageLog.objects.create(
            employee=emp,
            recipient_name=kw.pop("recipient_name", f"{emp.first_name} {emp.last_name}" if emp else ""),
            recipient_email=kw.pop("recipient_email", emp.email if emp else ""),
            email_type=email_type,
            status=status,
            **kw,
        )

    def get(self, path, **params):
        return self.client.get(f"{BASE}/{path}", params, **self.hr)

    def put(self, path, body, headers=None):
        return self.client.put(f"{BASE}/{path}", body, content_type="application/json", **(headers or self.hr))

    def post(self, path, body=None, headers=None):
        return self.client.post(f"{BASE}/{path}", body or {}, content_type="application/json", **(headers or self.hr))


# ── the catalog ───────────────────────────────────────────────────────────────


class CatalogTests(EmailBase):
    def test_every_placeholder_in_the_defaults_is_declared(self):
        for spec in catalog.TYPES.values():
            declared = set(spec.variable_names)
            allowed = declared | ({catalog.DETAILS_TOKEN} if spec.details else set())
            for text in (spec.subject, spec.body, spec.heading):
                used = {t.strip() for t in re.findall(r"\{\{([^{}]*)\}\}", text)}
                self.assertLessEqual(used, allowed, f"{spec.key}: undeclared placeholder in {text!r}")

    def test_details_rows_use_declared_variables(self):
        for spec in catalog.TYPES.values():
            for label, var in spec.details:
                self.assertIn(var, spec.variable_names, f"{spec.key}: {label}")

    def test_keys_modules_and_switches_are_consistent(self):
        columns = {f.name for f in EmailSettings._meta.get_fields()}
        self.assertEqual(len(catalog.TYPES), len(catalog._TYPES))
        for spec in catalog.TYPES.values():
            self.assertIn(spec.module, catalog.MODULES, spec.key)
            self.assertTrue(spec.subject.strip() and spec.body.strip(), spec.key)
        for module, column in catalog.MODULE_SWITCHES.items():
            self.assertIn(module, catalog.MODULES)
            self.assertIn(column, columns)

    def test_every_type_renders_with_its_sample_values_and_nothing_is_left_unfilled(self):
        for key in catalog.TYPES:
            subject, text, html = email_service.render_email(key, catalog.sample_params(key), company="Acme Mills")
            for out in (subject, text, html):
                self.assertNotIn("{{", out, key)
            self.assertNotIn("**", text, key)
            self.assertIn("ACME MILLS", html, key)

    def test_the_salary_slip_defaults_keep_the_wording_employees_already_receive(self):
        subject, text, _html = email_service.render_email(
            "salary_slip",
            {"employee_name": "Asha Kumar", "month_year": "August 2026", "net_salary": "₹24,500.00"},
            company="Acme Mills",
        )
        self.assertEqual(subject, "Salary Slip – August 2026 | Acme Mills")
        self.assertIn("Dear Asha Kumar,", text)
        self.assertIn("Please find attached your salary slip for August 2026.", text)
        self.assertIn("Net amount paid: ₹24,500.00", text)


# ── wording ───────────────────────────────────────────────────────────────────


class RenderTests(EmailBase):
    def test_values_are_html_escaped_but_plain_text_is_not(self):
        _s, text, html = email_service.render_email(
            "visitor_arrival",
            {
                "employee_name": "Asha",
                "visitor_name": "<script>alert(1)</script>",
                "visitor_phone": "1",
                "purpose": "x",
            },
        )
        self.assertNotIn("<script>", html)
        self.assertIn("&lt;script&gt;alert(1)&lt;/script&gt;", html)
        self.assertIn("<script>alert(1)</script>", text)

    def test_wording_written_by_hr_is_escaped_too(self):
        EmailMessageTemplate.objects.create(email_type="test_email", message_body="<b>Hi</b> & welcome **bold**")
        _s, _text, html = email_service.render_email("test_email", {})
        self.assertIn("&lt;b&gt;Hi&lt;/b&gt; &amp; welcome <strong>bold</strong>", html)

    def test_a_line_with_only_empty_placeholders_is_dropped(self):
        EmailMessageTemplate.objects.create(email_type="test_email", message_body="Hello\nNote: {{note}}\nBye")
        _s, text, _h = email_service.render_email("test_email", {"note": ""})
        self.assertEqual(text, "Hello\nBye")

    def test_details_table_goes_where_the_token_is_and_empty_rows_vanish(self):
        params = {"candidate_name": "Meena", "interview_datetime": "Monday 10:30", "location": ""}
        _s, text, html = email_service.render_email("interview_invite", params)
        self.assertIn("Date & Time: Monday 10:30", text)
        self.assertNotIn("Location", text)
        self.assertNotIn("Location", html)
        self.assertLess(text.index("next stage"), text.index("Date & Time"))
        self.assertLess(text.index("Date & Time"), text.index("Please bring"))

    def test_details_table_is_appended_when_the_token_is_removed(self):
        EmailMessageTemplate.objects.create(email_type="visitor_arrival", message_body="Visitor: {{visitor_name}}")
        params = {"employee_name": "A", "visitor_name": "Ravi", "visitor_phone": "98765", "purpose": "Vendor"}
        _s, text, _h = email_service.render_email("visitor_arrival", params)
        self.assertEqual(text, "Visitor: Ravi\n\nPhone: 98765\nPurpose: Vendor")

    def test_a_subject_can_never_carry_a_line_break(self):
        subject, _t, _h = email_service.render_email("visitor_arrival", {"visitor_name": "Ravi\r\nBcc: x@y.test"})
        self.assertNotIn("\n", subject)
        self.assertNotIn("\r", subject)

    def test_saved_subject_and_wording_replace_the_defaults_and_blank_falls_back(self):
        EmailMessageTemplate.objects.create(
            email_type="test_email", subject="Ping from {{company_name}}", message_body="Just checking in."
        )
        subject, text, _h = email_service.render_email("test_email", {}, company="Acme")
        self.assertEqual((subject, text), ("Ping from Acme", "Just checking in."))
        EmailMessageTemplate.objects.filter(email_type="test_email").update(subject="", message_body="")
        subject, text, _h = email_service.render_email("test_email", {}, company="Acme")
        self.assertEqual(subject, "Test email from Acme HRMS")
        self.assertIn("This is a test email", text)

    def test_the_banner_keeps_the_colour_the_letter_always_had(self):
        _s, _t, resignation = email_service.render_email(
            "resignation_letter", catalog.sample_params("resignation_letter")
        )
        _s, _t, slip = email_service.render_email("salary_slip", catalog.sample_params("salary_slip"))
        self.assertIn("#006496", resignation)
        self.assertIn("#0E4B3A", slip)


# ── the central send service ──────────────────────────────────────────────────


class SendTests(EmailBase):
    def test_a_successful_send_talks_smtp_properly_and_is_logged(self):
        with mock.patch(SMTP) as smtp:
            server = smtp.return_value.__enter__.return_value
            log = self.send(
                "salary_slip",
                params={"employee_name": "Asha Kumar", "month_year": "August 2026", "net_salary": "₹1.00"},
                recipient_name="Asha Kumar",
                employee=self.asha,
                attachments=[("slip.pdf", b"%PDF-1.4 fake", "application/pdf")],
                ref_id=7,
                sent_by_id=HRUser.objects.get().id,
            )
        smtp.assert_called_once_with("smtp.gmail.com", 587, timeout=email_service.SMTP_TIMEOUT)
        server.starttls.assert_called_once()
        server.login.assert_called_once_with("hr@example.test", "app-password-1234")
        msg, kwargs = sent_message(server)
        self.assertEqual(kwargs, {"from_addr": "hr@example.test", "to_addrs": ["asha@example.test"]})
        self.assertEqual(msg["To"], "asha@example.test")
        self.assertIn("hr@example.test", msg["From"])
        self.assertIn("Acme HR", msg["From"])
        self.assertEqual(msg["Subject"], "Salary Slip – August 2026 | Acme Mills")
        self.assertEqual(msg.get_content_type(), "multipart/mixed")
        self.assertIn("Please find attached your salary slip", msg.get_body(("plain",)).get_content())
        self.assertIn("<strong>Asha Kumar</strong>", msg.get_body(("html",)).get_content())
        (attachment,) = list(msg.iter_attachments())
        self.assertEqual((attachment.get_filename(), attachment.get_content_type()), ("slip.pdf", "application/pdf"))
        self.assertEqual(attachment.get_content(), b"%PDF-1.4 fake")

        self.assertEqual(log.status, "sent")
        self.assertEqual(
            (log.employee_id, log.recipient_email, log.email_type, log.ref_id, log.attachment_name),
            (self.asha.id, "asha@example.test", "salary_slip", 7, "slip.pdf"),
        )
        self.assertEqual(log.subject, "Salary Slip – August 2026 | Acme Mills")
        self.assertIn("Net amount paid: ₹1.00", log.message_text)
        self.assertEqual(EmailMessageLog.objects.count(), 1)
        self.assertNotIn("app-password-1234", repr(log.__dict__))

    def test_port_465_uses_implicit_ssl_and_no_starttls(self):
        self.ps = configure_smtp(smtp_port=465)
        with mock.patch(SMTP_SSL) as ssl_cls, mock.patch(SMTP) as plain:
            log = self.send()
        self.assertEqual(log.status, "sent")
        plain.assert_not_called()
        server = ssl_cls.return_value.__enter__.return_value
        server.starttls.assert_not_called()
        server.login.assert_called_once()
        server.send_message.assert_called_once()

    def test_a_wrong_password_is_reported_with_the_gmail_app_password_hint(self):
        with mock.patch(SMTP) as smtp:
            smtp.return_value.__enter__.return_value.login.side_effect = smtplib.SMTPAuthenticationError(535, b"bad")
            log = self.send()
        self.assertEqual((log.status, log.http_status), ("failed", 502))
        self.assertIn("SMTP authentication failed. Check username/password.", log.error_message)
        self.assertIn("App Password", log.error_message)

    def test_a_non_gmail_host_gets_no_gmail_hint(self):
        self.ps = configure_smtp(smtp_host="smtp.office365.com")
        with mock.patch(SMTP) as smtp:
            smtp.return_value.__enter__.return_value.login.side_effect = smtplib.SMTPAuthenticationError(535, b"bad")
            log = self.send()
        self.assertEqual(log.error_message, "SMTP authentication failed. Check username/password.")

    def test_a_refused_recipient_and_a_dead_server_are_failed_rows_not_exceptions(self):
        with mock.patch(SMTP) as smtp:
            server = smtp.return_value.__enter__.return_value
            server.send_message.side_effect = smtplib.SMTPRecipientsRefused({"asha@example.test": (550, b"no")})
            refused = self.send()
            smtp.side_effect = ConnectionRefusedError("connection refused")
            down = self.send()
        self.assertEqual((refused.status, refused.http_status), ("failed", 502))
        self.assertEqual(refused.error_message, "The mail server refused the address asha@example.test.")
        self.assertEqual((down.status, down.http_status), ("failed", 502))
        self.assertIn("Failed to send email: connection refused", down.error_message)
        self.assertEqual(EmailMessageLog.objects.filter(status="failed").count(), 2)

    def test_no_address_or_a_malformed_one_never_reaches_smtp(self):
        with mock.patch(SMTP) as smtp:
            for bad in (
                None,
                "",
                "   ",
                "not-an-email",
                "a@b",
                "a@b.test, c@d.test",
                "a@b.test\nBcc: x@y.test",
                "<a@b.test>",
            ):
                log = self.send(to=bad)
                self.assertEqual((log.status, log.http_status), ("failed", 400), repr(bad))
        smtp.assert_not_called()
        self.assertEqual(EmailMessageLog.objects.count(), 8)

    def test_hr_switches_hold_an_email_back_as_blocked(self):
        cases = (
            ("emails_enabled", "All emails are switched off"),
            ("document_emails_enabled", "Documents emails are switched off"),
        )
        for field, reason in cases:
            s = EmailSettings.get()
            setattr(s, field, False)
            s.save()
            with mock.patch(SMTP) as smtp:
                log = self.send("offer_letter", params={"employee_name": "A", "designation": "B"})
            smtp.assert_not_called()
            self.assertEqual((log.status, log.http_status), ("blocked", 400), field)
            self.assertIn(reason, log.error_message)
            setattr(s, field, True)
            s.save()

    def test_a_type_switched_off_on_the_message_text_tab_is_blocked(self):
        EmailMessageTemplate.objects.create(email_type="test_email", is_enabled=False)
        with mock.patch(SMTP) as smtp:
            log = self.send()
        smtp.assert_not_called()
        self.assertEqual(log.status, "blocked")
        self.assertIn("'Test Email' emails are switched off", log.error_message)

    def test_a_module_switch_only_affects_its_own_module(self):
        s = EmailSettings.get()
        s.visitor_emails_enabled = False
        s.save()
        with mock.patch(SMTP):
            documents = self.send("offer_letter", params={"employee_name": "A", "designation": "B"})
            visitors = self.send("visitor_arrival", params={"visitor_name": "V"})
        self.assertEqual((documents.status, visitors.status), ("sent", "blocked"))

    @override_settings(EMAIL_ALLOW_SENDING=False)
    def test_a_development_machine_does_not_send(self):
        with mock.patch(SMTP) as smtp:
            log = self.send()
        smtp.assert_not_called()
        self.assertEqual(log.status, "blocked")
        self.assertIn("development setup", log.error_message)
        self.assertIn("EMAIL_ALLOW_SENDING=true", log.error_message)

    def test_the_default_guard_follows_debug_and_runserver(self):
        with override_settings(EMAIL_ALLOW_SENDING=None, DEBUG=True):
            self.assertFalse(email_service.sending_allowed())
        with override_settings(EMAIL_ALLOW_SENDING=None, DEBUG=False):
            self.assertTrue(email_service.sending_allowed())
            with mock.patch("sys.argv", ["manage.py", "runserver"]):
                self.assertFalse(email_service.sending_allowed())
        with override_settings(EMAIL_ALLOW_SENDING=True, DEBUG=True):
            self.assertTrue(email_service.sending_allowed())

    def test_smtp_not_set_up_is_blocked_with_the_familiar_message(self):
        for blank in ("smtp_host", "smtp_username", "smtp_password"):
            self.ps = configure_smtp(**{blank: ""})
            with mock.patch(SMTP) as smtp:
                log = self.send()
            smtp.assert_not_called()
            self.assertEqual((log.status, log.http_status), ("blocked", 400), blank)
            self.assertEqual(
                log.error_message, "SMTP settings not configured. Please save SMTP settings in Settings first."
            )

    def test_the_daily_limit_holds_back_the_rest_of_the_day(self):
        s = EmailSettings.get()
        s.daily_send_limit = 2
        s.save()
        with mock.patch(SMTP):
            first, second, third = self.send(), self.send(), self.send()
            self.row(self.asha, status="failed")  # failures and blocks don't use up the allowance
        self.assertEqual([m.status for m in (first, second, third)], ["sent", "sent", "blocked"])
        self.assertIn("Today's email limit (2) has been reached", third.error_message)
        # yesterday's mail doesn't count against today
        EmailMessageLog.objects.filter(status="sent").update(created_at=timezone.now() - timedelta(days=2))
        with mock.patch(SMTP):
            self.assertEqual(self.send().status, "sent")

    def test_attachments_are_built_only_for_an_email_that_will_really_go_out(self):
        build = mock.Mock(return_value=[("a.pdf", b"x", "application/pdf")])
        s = EmailSettings.get()
        s.emails_enabled = False
        s.save()
        with mock.patch(SMTP):
            self.assertEqual(self.send(attachments=build).status, "blocked")
            build.assert_not_called()
            s.emails_enabled = True
            s.save()
            log = self.send(attachments=build)
        build.assert_called_once()
        self.assertEqual((log.status, log.attachment_name), ("sent", "a.pdf"))

    def test_a_failing_attachment_builder_is_a_failed_row_not_a_crash(self):
        def boom():
            raise RuntimeError("PDF engine broke")

        with mock.patch(SMTP) as smtp:
            log = self.send(attachments=boom)
        smtp.assert_not_called()
        self.assertEqual((log.status, log.http_status), ("failed", 500))
        self.assertIn("PDF engine broke", log.error_message)

    def test_automatic_mail_that_is_not_attempted_leaves_no_row(self):
        with mock.patch(SMTP) as smtp:
            self.assertIsNone(self.send(to=None, automatic=True))
            self.assertIsNone(self.send(to="bad", automatic=True))
            s = EmailSettings.get()
            s.emails_enabled = False
            s.save()
            self.assertIsNone(self.send(automatic=True))
            s.emails_enabled = True
            s.save()
            self.ps = configure_smtp(smtp_password="")
            self.assertIsNone(self.send(automatic=True))
        smtp.assert_not_called()
        self.assertEqual(EmailMessageLog.objects.count(), 0)

    def test_automatic_mail_that_fails_for_real_is_still_logged(self):
        with mock.patch(SMTP) as smtp:
            smtp.side_effect = TimeoutError("timed out")
            log = self.send(automatic=True)
        self.assertEqual(log.status, "failed")
        self.assertEqual(EmailMessageLog.objects.count(), 1)

    def test_an_unknown_type_is_a_programming_error_not_a_log_row(self):
        with self.assertRaises(ValueError):
            self.send("no_such_email")

    def test_a_row_for_a_deleted_employee_keeps_the_recipient_details(self):
        with mock.patch(SMTP):
            log = self.send(employee=self.ravi, recipient_name="Ravi Nair", to="ravi@example.test")
        self.ravi.delete()
        log.refresh_from_db()
        self.assertIsNone(log.employee_id)
        self.assertEqual((log.recipient_name, log.recipient_email), ("Ravi Nair", "ravi@example.test"))


# ── the control page API ──────────────────────────────────────────────────────


class AccessTests(EmailBase):
    def test_every_endpoint_needs_an_hr_login(self):
        emp_token = {"HTTP_AUTHORIZATION": f"Bearer {sign_token({'role': 'employee', 'employeeId': self.asha.id})}"}
        for method, path in (
            ("get", "overview"),
            ("get", "messages"),
            ("get", "employees"),
            ("get", "settings"),
            ("put", "settings"),
            ("get", "templates"),
            ("put", "templates/salary_slip"),
            ("post", "templates/salary_slip/preview"),
            ("post", "test-email"),
        ):
            self.assertEqual(getattr(self.client, method)(f"{BASE}/{path}").status_code, 401, path)
            self.assertEqual(getattr(self.client, method)(f"{BASE}/{path}", **emp_token).status_code, 403, path)

    def test_view_permission_reads_but_cannot_change_or_send(self):
        role = Role.objects.create(name="Viewer", permissions={"gmail_control": "view"})
        viewer = _hr("viewer", super_admin=False, role=role)
        self.assertEqual(self.client.get(f"{BASE}/overview", **viewer).status_code, 200)
        self.assertEqual(self.put("settings", {"emailsEnabled": False}, viewer).status_code, 403)
        self.assertEqual(self.put("templates/test_email", {"isEnabled": False}, viewer).status_code, 403)
        self.assertEqual(self.post("test-email", {"toEmail": "a@b.test"}, viewer).status_code, 403)
        self.assertTrue(EmailSettings.get().emails_enabled)

    def test_edit_permission_can_change(self):
        role = Role.objects.create(name="Editor", permissions={"gmail_control": "edit"})
        editor = _hr("editor", super_admin=False, role=role)
        self.assertEqual(self.put("settings", {"emailsEnabled": False}, editor).status_code, 200)
        self.assertFalse(EmailSettings.get().emails_enabled)

    def test_a_role_without_the_module_is_locked_out(self):
        role = Role.objects.create(name="Other", permissions={"payroll": "edit", "whatsapp_control": "edit"})
        other = _hr("other", super_admin=False, role=role)
        for path in ("overview", "messages", "settings", "templates", "employees"):
            self.assertEqual(self.client.get(f"{BASE}/{path}", **other).status_code, 403, path)


class OverviewTests(EmailBase):
    def test_counts_by_status_category_and_type(self):
        self.row(self.asha, "salary_slip", "sent")
        self.row(self.asha, "salary_slip", "sent")
        self.row(self.ravi, "offer_letter", "failed", error_message="Failed to send email: boom")
        self.row(self.ravi, "visitor_arrival", "blocked", error_message="switched off")
        self.row(self.ravi, "screening_rejection", "sent")
        body = self.get("overview").json()
        self.assertEqual(body["totals"], {"sent": 3, "failed": 1, "blocked": 1, "total": 5})
        self.assertEqual(body["byCategory"]["documents"], {"sent": 2, "failed": 1, "blocked": 0, "total": 3})
        self.assertEqual(body["byCategory"]["visitors"]["blocked"], 1)
        self.assertEqual(body["byCategory"]["recruitment"]["sent"], 1)
        by_type = {r["emailType"]: r for r in body["byType"]}
        self.assertEqual((by_type["salary_slip"]["total"], by_type["offer_letter"]["failed"]), (2, 1))
        self.assertEqual(body["byType"][0]["emailType"], "salary_slip")
        self.assertEqual(body["today"]["total"], 5)
        self.assertEqual([c["key"] for c in body["categories"]], ["documents", "visitors", "recruitment", "other"])

    def test_recent_failures_carry_the_reason(self):
        self.row(self.ravi, "salary_slip", "failed", error_message="SMTP authentication failed.")
        failure = self.get("overview").json()["recentFailures"][0]
        self.assertEqual((failure["recipientName"], failure["error"]), ("Ravi Nair", "SMTP authentication failed."))

    def test_window_and_daily_series(self):
        old = self.row(self.asha)
        EmailMessageLog.objects.filter(pk=old.pk).update(created_at=timezone.now() - timedelta(days=40))
        self.row(self.asha)
        self.row(self.asha, status="failed")
        self.assertEqual(self.get("overview").json()["totals"]["total"], 2)
        self.assertEqual(self.get("overview", days=60).json()["totals"]["total"], 3)
        daily = self.get("overview").json()["daily"]
        self.assertEqual([(d["total"], d["failed"]) for d in daily], [(2, 1)])
        self.assertEqual(self.get("overview", days="x").status_code, 400)

    def test_config_shows_the_account_but_never_the_password(self):
        config = self.get("overview").json()["config"]
        self.assertEqual(config["provider"], "Gmail (SMTP)")
        self.assertTrue(
            config["isGmail"] and config["smtpConfigured"] and config["configured"] and config["passwordSet"]
        )
        self.assertEqual((config["host"], config["port"], config["security"]), ("smtp.gmail.com", 587, "STARTTLS"))
        self.assertEqual(config["username"], "hr•••@example.test")
        self.assertEqual((config["fromEmail"], config["fromName"]), ("hr@example.test", "Acme HR"))
        self.assertIsNone(config["sendingBlockedReason"])
        self.assertNotIn("app-password-1234", self.client.get(f"{BASE}/overview", **self.hr).content.decode())
        self.assertNotIn("app-password-1234", self.client.get(f"{BASE}/settings", **self.hr).content.decode())

    def test_config_says_why_nothing_can_be_sent(self):
        configure_smtp(smtp_password="")
        config = self.get("overview").json()["config"]
        self.assertFalse(config["smtpConfigured"] or config["passwordSet"] or config["configured"])
        self.assertIn("SMTP settings not configured", config["sendingBlockedReason"])
        configure_smtp(smtp_host="smtp.office365.com", smtp_port=465)
        with override_settings(EMAIL_ALLOW_SENDING=False):
            config = self.get("overview").json()["config"]
        self.assertEqual((config["provider"], config["security"]), ("SMTP mail server", "SSL (port 465)"))
        self.assertTrue(config["smtpConfigured"])
        self.assertFalse(config["configured"] or config["sendingAllowedHere"])
        self.assertIn("development setup", config["sendingBlockedReason"])

    def test_config_reports_todays_count_against_the_limit(self):
        self.row(self.asha)
        self.row(self.asha, status="failed")
        s = EmailSettings.get()
        s.daily_send_limit = 450
        s.save()
        config = self.get("overview").json()["config"]
        self.assertEqual((config["sentToday"], config["dailyLimit"]), (1, 450))


class MessagesTests(EmailBase):
    def setUp(self):
        super().setUp()
        self.m1 = self.row(self.asha, "salary_slip", "sent", subject="Salary Slip – August 2026", ref_id=3)
        self.m2 = self.row(self.ravi, "offer_letter", "failed", subject="Offer of Employment", error_message="boom")
        self.m3 = self.row(self.ravi, "visitor_arrival", "blocked", subject="You have a visitor: Kim")
        self.m4 = self.row(
            None,
            "screening_rejection",
            "sent",
            recipient_name="Meena Iyer",
            recipient_email="meena@example.test",
            subject="Application Update",
        )

    def ids(self, **params):
        return [m["id"] for m in self.get("messages", **params).json()]

    def test_newest_first_and_the_row_shape(self):
        rows = self.get("messages").json()
        self.assertEqual([r["id"] for r in rows], [self.m4.id, self.m3.id, self.m2.id, self.m1.id])
        first = next(r for r in rows if r["id"] == self.m1.id)
        for key, value in {
            "employeeCode": "A1",
            "recipientName": "Asha Kumar",
            "recipientEmail": "asha@example.test",
            "emailType": "salary_slip",
            "typeLabel": "Salary Slip",
            "category": "documents",
            "categoryLabel": "Documents",
            "status": "sent",
            "referenceId": 3,
        }.items():
            self.assertEqual(first[key], value, key)

    def test_a_recipient_who_is_not_an_employee_is_listed_by_name_and_address(self):
        row = next(r for r in self.get("messages").json() if r["id"] == self.m4.id)
        self.assertEqual((row["employeeId"], row["employeeCode"]), (None, None))
        self.assertEqual((row["recipientName"], row["recipientEmail"]), ("Meena Iyer", "meena@example.test"))

    def test_filters(self):
        self.assertEqual(self.ids(status="failed"), [self.m2.id])
        self.assertEqual(self.ids(status="blocked"), [self.m3.id])
        self.assertEqual(self.ids(category="documents"), [self.m2.id, self.m1.id])
        self.assertEqual(self.ids(category="recruitment"), [self.m4.id])
        self.assertEqual(self.ids(type="visitor_arrival"), [self.m3.id])
        self.assertEqual(self.ids(employeeId=self.ravi.id), [self.m3.id, self.m2.id])
        self.assertEqual(self.ids(search="asha"), [self.m1.id])
        self.assertEqual(self.ids(search="R1"), [self.m3.id, self.m2.id])
        self.assertEqual(self.ids(search="meena@example"), [self.m4.id])
        self.assertEqual(self.ids(search="visitor: kim"), [self.m3.id])
        self.assertEqual(self.ids(search="Iyer"), [self.m4.id])

    def test_date_filters_use_whole_days(self):
        EmailMessageLog.objects.filter(pk=self.m1.pk).update(created_at=timezone.now() - timedelta(days=10))
        day = (timezone.now() - timedelta(days=10)).astimezone(email_service.FACTORY_TZ).date().isoformat()
        self.assertEqual(self.ids(dateFrom=day, dateTo=day), [self.m1.id])
        today = date.today().isoformat()
        self.assertNotIn(self.m1.id, self.ids(dateFrom=today))

    def test_bad_filters_are_rejected(self):
        for params in ({"status": "read"}, {"category": "nope"}, {"employeeId": "x"}, {"dateFrom": "13/13/2026"}):
            self.assertEqual(self.get("messages", **params).status_code, 400, params)

    def test_pagination(self):
        page = self.get("messages", page=1, pageSize=3).json()
        self.assertEqual((page["total"], len(page["items"]), page["page"]), (4, 3, 1))
        self.assertEqual(len(self.get("messages", page=2, pageSize=3).json()["items"]), 1)


class EmployeesTabTests(EmailBase):
    def test_counts_per_employee_and_search(self):
        self.row(self.asha)
        self.row(self.asha, status="failed")
        self.row(self.ravi)
        self.row(None, recipient_email="cand@example.test")  # not an employee: not on this tab
        rows = self.get("employees").json()
        by_code = {r["employeeCode"]: r for r in rows}
        self.assertEqual(set(by_code), {"A1", "R1"})
        self.assertEqual((by_code["A1"]["total"], by_code["A1"]["failed"]), (2, 1))
        self.assertEqual(by_code["A1"]["email"], "asha@example.test")
        self.assertEqual([r["employeeCode"] for r in self.get("employees", search="ravi").json()], ["R1"])
        self.assertEqual([r["employeeCode"] for r in self.get("employees", search="asha@example").json()], ["A1"])


class SettingsTests(EmailBase):
    def test_defaults_leave_everything_on_so_nothing_changes_until_hr_acts(self):
        body = self.get("settings").json()
        self.assertTrue(all(f["enabled"] for f in body["features"]))
        self.assertEqual(
            {f["key"] for f in body["features"]},
            {"emailsEnabled", "documentEmailsEnabled", "visitorEmailsEnabled", "recruitmentEmailsEnabled"},
        )
        self.assertEqual({g["key"] for g in body["groups"]}, {"master", "documents", "visitors", "recruitment"})
        self.assertEqual({f["group"] for f in body["features"]}, {g["key"] for g in body["groups"]})
        limit = body["timings"][0]
        self.assertEqual((limit["key"], limit["value"], limit["min"], limit["max"]), ("dailySendLimit", 0, 0, 5000))

    def test_switches_and_the_limit_can_be_changed_and_are_persisted(self):
        body = self.put("settings", {"visitorEmailsEnabled": False, "dailySendLimit": "450"}).json()
        s = EmailSettings.get()
        self.assertFalse(s.visitor_emails_enabled)
        self.assertEqual(s.daily_send_limit, 450)
        self.assertTrue(s.emails_enabled and s.document_emails_enabled)
        feature = next(f for f in body["features"] if f["key"] == "visitorEmailsEnabled")
        self.assertFalse(feature["enabled"])
        self.assertEqual(body["timings"][0]["value"], 450)

    def test_bad_values_are_rejected_and_nothing_is_half_saved(self):
        for body in (
            {"emailsEnabled": "false"},
            {"emailsEnabled": 0},
            {"dailySendLimit": -1},
            {"dailySendLimit": 5001},
            {"dailySendLimit": "many"},
            {"dailySendLimit": True},
            {"dailySendLimit": 1.5},
            {"dailySendLimit": [5]},
        ):
            self.assertEqual(self.put("settings", {"visitorEmailsEnabled": False, **body}).status_code, 400, body)
        s = EmailSettings.get()
        self.assertTrue(s.visitor_emails_enabled)
        self.assertEqual(s.daily_send_limit, 0)

    def test_unknown_keys_are_ignored(self):
        self.assertEqual(self.put("settings", {"smtpPassword": "hacked", "nonsense": 1}).status_code, 200)
        self.assertEqual(PayrollSettings.get().smtp_password, "app-password-1234")


class TemplateTests(EmailBase):
    def test_lists_every_type_with_wording_variables_and_usage(self):
        self.row(self.asha, "salary_slip", "sent")
        self.row(self.asha, "salary_slip", "failed")
        rows = {r["emailType"]: r for r in self.get("templates").json()}
        self.assertEqual(set(rows), set(catalog.TYPES))
        slip = rows["salary_slip"]
        self.assertEqual((slip["total"], slip["failed"]), (2, 1))
        self.assertEqual(slip["defaultSubject"], catalog.TYPES["salary_slip"].subject)
        self.assertEqual(slip["attachment"], "Salary slip (PDF)")
        self.assertFalse(slip["customised"])
        self.assertEqual([v["name"] for v in slip["variables"]][:2], ["employee_name", "month_year"])
        self.assertIn("Acme Mills", slip["previewSubject"])
        self.assertIn("August 2026", slip["preview"])
        self.assertIn("<strong>Asha Kumar</strong>", slip["previewHtml"])
        self.assertEqual(
            rows["resignation_letter"]["details"][0], {"label": "Employee Name", "variable": "employee_name"}
        )
        self.assertEqual(rows["salary_slip"]["details"], [])
        self.assertTrue(slip["moduleEnabled"])
        self.assertIsNone(rows["test_email"]["moduleEnabled"])

    def test_saving_wording_changes_what_is_sent(self):
        r = self.put(
            "templates/salary_slip",
            {"subject": "Payslip {{month_year}}", "messageBody": "Hi {{employee_name}}, slip attached."},
        )
        self.assertEqual(r.status_code, 200, r.content)
        self.assertTrue(r.json()["customised"])
        self.assertEqual(r.json()["previewSubject"], "Payslip August 2026")
        with mock.patch(SMTP) as smtp:
            log = self.send(
                "salary_slip", params={"employee_name": "Asha", "month_year": "March 2026", "net_salary": "1"}
            )
        msg, _ = sent_message(smtp.return_value.__enter__.return_value)
        self.assertEqual(msg["Subject"], "Payslip March 2026")
        self.assertEqual(msg.get_body(("plain",)).get_content().strip(), "Hi Asha, slip attached.")
        self.assertEqual(log.message_text, "Hi Asha, slip attached.")

    def test_clearing_the_wording_goes_back_to_the_default(self):
        self.put("templates/salary_slip", {"subject": "X", "messageBody": "Y"})
        r = self.put("templates/salary_slip", {"subject": "", "messageBody": ""}).json()
        self.assertFalse(r["customised"])
        self.assertEqual(r["previewSubject"], "Salary Slip – August 2026 | Acme Mills")

    def test_a_single_field_can_change_without_touching_the_other(self):
        self.put("templates/salary_slip", {"subject": "Keep me", "messageBody": "Body one"})
        self.put("templates/salary_slip", {"isEnabled": False})
        t = EmailMessageTemplate.objects.get(email_type="salary_slip")
        self.assertEqual((t.subject, t.message_body, t.is_enabled), ("Keep me", "Body one", False))
        self.put("templates/salary_slip", {"messageBody": "Body two"})
        t.refresh_from_db()
        self.assertEqual((t.subject, t.message_body, t.is_enabled), ("Keep me", "Body two", False))

    def test_the_per_type_switch_blocks_sending(self):
        self.assertEqual(self.put("templates/test_email", {"isEnabled": False}).status_code, 200)
        with mock.patch(SMTP) as smtp:
            log = self.send()
        smtp.assert_not_called()
        self.assertEqual(log.status, "blocked")

    def test_unknown_placeholders_are_refused_in_subject_and_body(self):
        for body in (
            {"messageBody": "Hello {{nmae}}"},
            {"subject": "Slip {{month}}"},
            {"messageBody": "Number {{1}}"},
            {"messageBody": "{{ }}"},
            {"messageBody": "Bad {{details}}"},  # salary slip has no details table
            {"subject": "{{details}}"},  # never allowed in a subject
        ):
            r = self.put("templates/salary_slip", body)
            self.assertEqual(r.status_code, 400, body)
            self.assertIn("Unknown placeholder", r.json()["error"])
        self.assertFalse(EmailMessageTemplate.objects.exists())

    def test_the_details_token_is_allowed_only_where_the_type_has_a_table(self):
        r = self.put("templates/visitor_arrival", {"messageBody": "Hi {{employee_name}}\n\n{{details}}"})
        self.assertEqual(r.status_code, 200, r.content)
        r = self.put("templates/visitor_arrival", {"subject": "{{details}}"})
        self.assertEqual(r.status_code, 400)

    def test_limits_and_types(self):
        self.assertEqual(self.put("templates/salary_slip", {"subject": "x" * 201}).status_code, 400)
        self.assertEqual(self.put("templates/salary_slip", {"messageBody": "x" * 5001}).status_code, 400)
        self.assertEqual(self.put("templates/salary_slip", {"subject": ["a"]}).status_code, 400)
        self.assertEqual(self.put("templates/salary_slip", {"messageBody": 5}).status_code, 400)
        self.assertEqual(self.put("templates/salary_slip", {"isEnabled": "no"}).status_code, 400)
        self.assertEqual(self.put("templates/nonsense", {"subject": "x"}).status_code, 400)
        self.assertEqual(self.put("templates/salary_slip", {"subject": "x" * 200}).status_code, 200)

    def test_preview_renders_unsaved_wording_with_sample_values(self):
        r = self.post(
            "templates/interview_invite/preview",
            {"subject": "Come in, {{candidate_name}}", "messageBody": "Hi {{candidate_name}}\n\n{{details}}"},
        ).json()
        self.assertEqual(r["subject"], "Come in, Meena Iyer")
        self.assertIn("Hi Meena Iyer", r["preview"])
        self.assertIn("Date & Time: Monday, 05 October 2026 at 10:30 AM", r["preview"])
        self.assertIn("<table", r["previewHtml"])
        self.assertIsNone(r["error"])
        self.assertFalse(EmailMessageTemplate.objects.exists())

    def test_preview_reports_a_wording_problem_and_falls_back_to_the_default_for_blank(self):
        r = self.post("templates/salary_slip/preview", {"messageBody": "Hi {{oops}}"}).json()
        self.assertIn("Unknown placeholder {{oops}}", r["error"])
        blank = self.post("templates/salary_slip/preview", {}).json()
        self.assertIsNone(blank["error"])
        self.assertIn("Please find attached your salary slip", blank["preview"])
        self.assertEqual(self.post("templates/nonsense/preview", {}).status_code, 400)

    def test_preview_never_lets_html_through(self):
        html = self.post("templates/test_email/preview", {"messageBody": "<img src=x onerror=alert(1)>"}).json()[
            "previewHtml"
        ]
        self.assertNotIn("<img", html)


class TestEmailEndpointTests(EmailBase):
    def test_a_test_email_goes_out_is_logged_and_says_who_sent_it(self):
        with mock.patch(SMTP) as smtp:
            r = self.post("test-email", {"toEmail": " me@example.test "}).json()
        self.assertTrue(r["ok"])
        self.assertEqual((r["status"], r["sentTo"]), ("sent", "me@example.test"))
        msg, kwargs = sent_message(smtp.return_value.__enter__.return_value)
        self.assertEqual(kwargs["to_addrs"], ["me@example.test"])
        self.assertEqual(msg["Subject"], "Test email from Acme Mills HRMS")
        log = EmailMessageLog.objects.get()
        self.assertEqual((log.email_type, log.sent_by.username), ("test_email", "gc_admin"))
        self.assertEqual(r["message"]["id"], log.id)

    def test_a_test_that_cannot_go_out_answers_with_the_reason(self):
        with override_settings(EMAIL_ALLOW_SENDING=False), mock.patch(SMTP) as smtp:
            r = self.post("test-email", {"toEmail": "me@example.test"})
        smtp.assert_not_called()
        self.assertEqual(r.status_code, 200)
        self.assertFalse(r.json()["ok"])
        self.assertEqual(r.json()["status"], "blocked")
        self.assertIn("development setup", r.json()["error"])
        with mock.patch(SMTP) as smtp:
            smtp.return_value.__enter__.return_value.login.side_effect = smtplib.SMTPAuthenticationError(535, b"x")
            r = self.post("test-email", {"toEmail": "me@example.test"}).json()
        self.assertEqual((r["ok"], r["status"]), (False, "failed"))
        self.assertIn("SMTP authentication failed", r["error"])

    def test_an_address_is_required_and_must_look_like_one(self):
        for body in ({}, {"toEmail": ""}, {"toEmail": 5}, {"toEmail": None}):
            self.assertEqual(self.post("test-email", body).status_code, 400, body)
        with mock.patch(SMTP) as smtp:
            r = self.post("test-email", {"toEmail": "not-an-address"}).json()
        smtp.assert_not_called()
        self.assertEqual((r["ok"], r["status"]), (False, "failed"))
        self.assertIn("not a valid email address", r["error"])


class BranchScopeTests(EmailBase):
    def setUp(self):
        super().setUp()
        self.north = Branch.objects.create(name="North")
        self.south = Branch.objects.create(name="South")
        Employee.objects.filter(pk=self.asha.pk).update(branch=self.north)
        Employee.objects.filter(pk=self.ravi.pk).update(branch=self.south)
        role = Role.objects.create(name="North HR", permissions={"gmail_control": "edit"})
        self.north_hr = _hr("north_hr", super_admin=False, role=role, branch=self.north)
        self.asha_row = self.row(self.asha)
        self.ravi_row = self.row(self.ravi)
        self.candidate_row = self.row(
            None,
            "screening_rejection",
            recipient_email="cand@example.test",
            sent_by=HRUser.objects.get(username="north_hr"),
        )
        self.other_candidate = self.row(None, "screening_rejection", recipient_email="cand2@example.test")

    def test_a_branch_login_sees_its_own_employees_and_its_own_non_employee_mail_only(self):
        rows = self.client.get(f"{BASE}/messages", **self.north_hr).json()
        self.assertEqual({r["id"] for r in rows}, {self.asha_row.id, self.candidate_row.id})
        overview = self.client.get(f"{BASE}/overview", **self.north_hr).json()
        self.assertEqual(overview["totals"]["total"], 2)
        emps = self.client.get(f"{BASE}/employees", **self.north_hr).json()
        self.assertEqual([e["employeeCode"] for e in emps], ["A1"])
        templates = {r["emailType"]: r for r in self.client.get(f"{BASE}/templates", **self.north_hr).json()}
        self.assertEqual(templates["salary_slip"]["total"], 1)

    def test_an_unscoped_login_sees_everything(self):
        self.assertEqual(len(self.get("messages").json()), 4)

    def test_a_branch_login_cannot_reach_another_branchs_rows_by_filtering(self):
        rows = self.client.get(f"{BASE}/messages", {"employeeId": self.ravi.id}, **self.north_hr).json()
        self.assertEqual(rows, [])


# ── the senders that now go through the service ───────────────────────────────


class SenderIntegrationTests(EmailBase):
    def slip(self, emp=None, month=2, year=2026, number="SS/1/2026/02"):
        return SalarySlip.objects.create(
            employee=emp or self.asha,
            month=month,
            year=year,
            slip_number=number,
            basic=1000,
            gross_salary=1000,
            net_salary=24500,
            working_days=26,
            present_days=26,
        )

    def call(self, path, body=None):
        return self.client.post(f"/api/{path}", body or {}, content_type="application/json", **self.hr)

    def test_salary_slip_single_email_sends_stamps_and_logs(self):
        slip = self.slip()
        with mock.patch(SMTP) as smtp:
            r = self.call(f"salary-slips/{slip.id}/email")
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(r.json(), {"ok": True, "sentTo": "asha@example.test"})
        slip.refresh_from_db()
        self.assertIsNotNone(slip.emailed_at)
        msg, _ = sent_message(smtp.return_value.__enter__.return_value)
        self.assertEqual(msg["Subject"], "Salary Slip – February 2026 | Acme Mills")
        self.assertIn("₹24,500.00", msg.get_body(("plain",)).get_content())
        (pdf,) = list(msg.iter_attachments())
        self.assertEqual(pdf.get_filename(), "salary_slip_SS/1/2026/02.pdf".replace("/", "/"))
        self.assertTrue(pdf.get_content().startswith(b"%PDF"))
        log = EmailMessageLog.objects.get()
        self.assertEqual((log.email_type, log.ref_id, log.employee_id), ("salary_slip", slip.id, self.asha.id))
        self.assertEqual(log.sent_by.username, "gc_admin")

    def test_salary_slip_email_failures_keep_their_status_codes_and_do_not_stamp(self):
        slip = self.slip()
        no_address = self.slip(self.ravi, number="SS/2/2026/02")
        Employee.objects.filter(pk=self.ravi.pk).update(email="")
        with mock.patch(SMTP) as smtp:
            self.assertEqual(self.call(f"salary-slips/{no_address.id}/email").status_code, 400)
            smtp.return_value.__enter__.return_value.login.side_effect = smtplib.SMTPAuthenticationError(535, b"x")
            r = self.call(f"salary-slips/{slip.id}/email")
        self.assertEqual(r.status_code, 502)
        self.assertIn("SMTP authentication failed", r.json()["error"])
        slip.refresh_from_db()
        self.assertIsNone(slip.emailed_at)
        self.assertEqual(EmailMessageLog.objects.filter(status="failed").count(), 2)

    def test_salary_slip_email_when_hr_switched_documents_off_is_a_400_and_not_stamped(self):
        slip = self.slip()
        s = EmailSettings.get()
        s.document_emails_enabled = False
        s.save()
        with mock.patch(SMTP) as smtp:
            r = self.call(f"salary-slips/{slip.id}/email")
        smtp.assert_not_called()
        self.assertEqual(r.status_code, 400)
        self.assertIn("Documents emails are switched off", r.json()["error"])
        slip.refresh_from_db()
        self.assertIsNone(slip.emailed_at)
        self.assertEqual(EmailMessageLog.objects.get().status, "blocked")

    def test_salary_slip_email_with_smtp_not_set_up_keeps_its_400_and_leaves_no_row(self):
        configure_smtp(smtp_password="")
        slip = self.slip()
        r = self.call(f"salary-slips/{slip.id}/email")
        self.assertEqual(r.status_code, 400)
        self.assertIn("SMTP settings not configured", r.json()["error"])
        self.assertEqual(EmailMessageLog.objects.count(), 0)

    def test_bulk_salary_slip_email_reports_each_outcome_and_logs_each(self):
        ok = self.slip()
        no_address = self.slip(self.ravi, number="SS/2/2026/02")
        Employee.objects.filter(pk=self.ravi.pk).update(email=None)
        with mock.patch(SMTP):
            r = self.call("salary-slips/bulk-email", {"month": 2, "year": 2026})
        self.assertEqual(r.status_code, 200, r.content)
        body = r.json()
        self.assertEqual((body["sent"], body["failed"]), (1, 1))
        self.assertEqual(body["failures"][0]["employeeCode"], "R1")
        self.assertEqual(body["failures"][0]["error"], "No email address on file for this recipient.")
        ok.refresh_from_db()
        no_address.refresh_from_db()
        self.assertIsNotNone(ok.emailed_at)
        self.assertIsNone(no_address.emailed_at)
        self.assertEqual(sorted(EmailMessageLog.objects.values_list("status", flat=True)), ["failed", "sent"])

    def test_bulk_salary_slip_email_with_the_daily_limit_holds_back_the_rest_without_building_pdfs(self):
        self.slip()
        self.slip(self.ravi, number="SS/2/2026/02")
        s = EmailSettings.get()
        s.daily_send_limit = 1
        s.save()
        with (
            mock.patch(SMTP),
            mock.patch("api.company_documents_views.build_salary_slip_pdf", return_value=b"%PDF") as pdf,
        ):
            body = self.call("salary-slips/bulk-email", {"month": 2, "year": 2026}).json()
        self.assertEqual((body["sent"], body["failed"]), (1, 1))
        self.assertIn("email limit (1)", body["failures"][0]["error"])
        self.assertEqual(pdf.call_count, 1)

    def test_offer_letter_email(self):
        with mock.patch(SMTP) as smtp:
            r = self.call(f"employees/{self.asha.id}/offer-letter/email")
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(r.json(), {"ok": True, "sentTo": "asha@example.test", "pdfAttached": True})
        msg, _ = sent_message(smtp.return_value.__enter__.return_value)
        self.assertIn("Offer of Employment", msg["Subject"])
        self.assertEqual(list(msg.iter_attachments())[0].get_filename(), "offer_letter_A1.pdf")
        log = EmailMessageLog.objects.get()
        self.assertEqual((log.email_type, log.attachment_name), ("offer_letter", "offer_letter_A1.pdf"))

    def test_offer_letter_email_to_another_address_and_with_no_address_at_all(self):
        Employee.objects.filter(pk=self.asha.pk).update(email=None)
        self.assertEqual(self.call(f"employees/{self.asha.id}/offer-letter/email").status_code, 400)
        with mock.patch(SMTP) as smtp:
            r = self.call(f"employees/{self.asha.id}/offer-letter/email", {"toEmail": "elsewhere@example.test"})
        self.assertEqual(r.json()["sentTo"], "elsewhere@example.test")
        self.assertEqual(
            sent_message(smtp.return_value.__enter__.return_value)[1]["to_addrs"], ["elsewhere@example.test"]
        )

    def test_id_card_email(self):
        with mock.patch(SMTP) as smtp, mock.patch("api.idcard_render.render_idcard_png", return_value=b"\x89PNGfake"):
            r = self.call("idcard/email", {"employeeId": self.asha.id})
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(r.json(), {"ok": True, "sentTo": "asha@example.test"})
        msg, _ = sent_message(smtp.return_value.__enter__.return_value)
        (png,) = list(msg.iter_attachments())
        self.assertEqual((png.get_filename(), png.get_content_type()), ("idcard-A1.png", "image/png"))
        self.assertEqual(EmailMessageLog.objects.get().email_type, "id_card")

    def test_id_card_email_failure_is_a_502_with_the_reason(self):
        with mock.patch(SMTP) as smtp, mock.patch("api.idcard_render.render_idcard_png", return_value=b"x"):
            smtp.side_effect = OSError("network down")
            r = self.call("idcard/email", {"employeeId": self.asha.id})
        self.assertEqual(r.status_code, 502)
        self.assertIn("network down", r.json()["error"])

    def test_resignation_email_includes_the_details_table_and_the_letter(self):
        dept = Department.objects.create(name="Weaving")
        Employee.objects.filter(pk=self.asha.pk).update(department=dept)
        resignation = ResignationRequest.objects.create(
            employee=self.asha, status="approved", last_working_date=date(2026, 9, 30), approved_by="Meena"
        )
        with mock.patch(SMTP) as smtp:
            r = self.call(f"recruitment/resignations/{resignation.id}/email")
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(r.json()["pdfAttached"], True)
        msg, _ = sent_message(smtp.return_value.__enter__.return_value)
        text = msg.get_body(("plain",)).get_content()
        for line in ("Department: Weaving", "Last Working Day: 30 September 2026", "Approved By: Meena"):
            self.assertIn(line, text)
        self.assertIn("#006496", msg.get_body(("html",)).get_content())
        self.assertEqual(
            list(msg.iter_attachments())[0].get_filename(), f"resignation_acceptance_A1_{resignation.id}.pdf"
        )

    def test_resignation_email_still_needs_an_approved_resignation(self):
        pending = ResignationRequest.objects.create(employee=self.asha, status="pending")
        self.assertEqual(self.call(f"recruitment/resignations/{pending.id}/email").status_code, 400)
        self.assertEqual(EmailMessageLog.objects.count(), 0)

    def visit(self, host):
        branch = Branch.objects.create(name="Gate")
        visitor = Visitor.objects.create(name="Kim Lee", phone="98765 43210")
        return VisitorVisit.objects.create(
            visitor=visitor, branch=branch, whom_to_meet="Asha", purpose="Vendor meeting", meeting_employee=host
        )

    def test_visitor_arrival_email_is_sent_logged_and_stamps_the_visit(self):
        from .outpass_visitor_views import _send_visitor_email

        visit = self.visit(self.asha)
        with mock.patch(SMTP) as smtp:
            _send_visitor_email(visit, self.asha)
        visit.refresh_from_db()
        self.assertIsNotNone(visit.notified_email_at)
        msg, _ = sent_message(smtp.return_value.__enter__.return_value)
        self.assertEqual(msg["Subject"], "You have a visitor: Kim Lee")
        text = msg.get_body(("plain",)).get_content()
        self.assertIn("Kim Lee has arrived at reception to meet you.", text)
        self.assertIn("Phone: 98765 43210", text)
        self.assertIn("Purpose: Vendor meeting", text)
        self.assertEqual(EmailMessageLog.objects.get().email_type, "visitor_arrival")

    def test_visitor_arrival_email_stays_quiet_when_there_is_nothing_to_attempt(self):
        from .outpass_visitor_views import _send_visitor_email

        visit = self.visit(self.asha)
        Employee.objects.filter(pk=self.asha.pk).update(email=None)
        self.asha.refresh_from_db()
        with mock.patch(SMTP) as smtp:
            _send_visitor_email(visit, self.asha)  # no address
            self.asha.email = "asha@example.test"
            s = EmailSettings.get()
            s.visitor_emails_enabled = False
            s.save()
            _send_visitor_email(visit, self.asha)  # switched off by HR
            s.visitor_emails_enabled = True
            s.save()
            configure_smtp(smtp_host="")
            _send_visitor_email(visit, self.asha)  # SMTP not set up
        smtp.assert_not_called()
        visit.refresh_from_db()
        self.assertIsNone(visit.notified_email_at)
        self.assertEqual(EmailMessageLog.objects.count(), 0)

    def test_visitor_arrival_email_that_really_fails_is_logged_and_not_stamped(self):
        from .outpass_visitor_views import _send_visitor_email

        visit = self.visit(self.asha)
        with mock.patch(SMTP) as smtp:
            smtp.side_effect = TimeoutError("timed out")
            _send_visitor_email(visit, self.asha)
        visit.refresh_from_db()
        self.assertIsNone(visit.notified_email_at)
        self.assertEqual(EmailMessageLog.objects.get().status, "failed")

    def candidates(self, **statuses):
        dept = Department.objects.create(name="Cutting")
        rs = HiringRuleSet.objects.create(name="Cutter", department=dept)
        out = {}
        for name, (status, email) in statuses.items():
            out[name] = ScreeningCandidate.objects.create(
                rule_set=rs,
                department=dept,
                resume_file="resumes/x.pdf",
                original_filename="x.pdf",
                candidate_name=name,
                email=email,
                status=status,
                interview_datetime=timezone.now() + timedelta(days=3) if status == "selected" else None,
            )
        return out

    def test_reject_email_all_sends_stamps_and_reports_failures_including_no_address(self):
        c = self.candidates(
            Meena=("rejected", "meena@example.test"), Noah=("rejected", ""), Omar=("selected", "o@x.test")
        )
        with mock.patch(SMTP) as smtp:
            r = self.call("recruitment/resume-screening/candidates/reject-email-all")
        self.assertEqual(r.status_code, 200, r.content)
        body = r.json()
        self.assertEqual(body["sent"], 1)
        self.assertEqual(
            [(f["name"], f["error"]) for f in body["failed"]],
            [("Noah", "No email address on file for this recipient.")],
        )
        c["Meena"].refresh_from_db()
        c["Noah"].refresh_from_db()
        self.assertIsNotNone(c["Meena"].rejection_emailed_at)
        self.assertIsNone(c["Noah"].rejection_emailed_at)
        msg, _ = sent_message(smtp.return_value.__enter__.return_value)
        self.assertEqual(msg["Subject"], "Application Update – Acme Mills")
        self.assertIn("Dear Meena,", msg.get_body(("plain",)).get_content())
        rows = EmailMessageLog.objects.order_by("id")
        self.assertEqual(
            [(m.email_type, m.status, m.recipient_name) for m in rows],
            [
                ("screening_rejection", "sent", "Meena"),
                ("screening_rejection", "failed", "Noah"),
            ],
        )
        self.assertIsNone(rows[0].employee_id)

    def test_reject_email_all_does_not_resend_to_someone_already_told(self):
        self.candidates(Meena=("rejected", "meena@example.test"))
        with mock.patch(SMTP) as smtp:
            self.call("recruitment/resume-screening/candidates/reject-email-all")
            self.call("recruitment/resume-screening/candidates/reject-email-all")
        self.assertEqual(smtp.return_value.__enter__.return_value.send_message.call_count, 1)

    def test_interview_invite_single_and_bulk(self):
        c = self.candidates(Omar=("selected", "omar@example.test"), Pia=("selected", "pia@example.test"))
        when = "2026-10-05T10:30:00+05:30"
        with mock.patch(SMTP) as smtp:
            r = self.call(
                f"recruitment/resume-screening/candidates/{c['Omar'].id}/interview-invite", {"interviewDateTime": when}
            )
            self.assertEqual(r.status_code, 200, r.content)
            msg, _ = sent_message(smtp.return_value.__enter__.return_value)
            text = msg.get_body(("plain",)).get_content()
            self.assertIn("Date & Time: Monday, 05 October 2026 at 10:30 AM", text)
            r = self.call("recruitment/resume-screening/candidates/interview-invite-bulk", {"interviewDateTime": when})
        self.assertEqual(r.json()["sent"], 1)  # Omar was already invited
        c["Omar"].refresh_from_db()
        c["Pia"].refresh_from_db()
        self.assertIsNotNone(c["Omar"].interview_invited_at)
        self.assertIsNotNone(c["Pia"].interview_invited_at)
        self.assertEqual(EmailMessageLog.objects.filter(email_type="interview_invite", status="sent").count(), 2)

    def test_interview_invite_failure_is_a_502_and_the_candidate_stays_uninvited(self):
        c = self.candidates(Omar=("selected", "omar@example.test"))
        with mock.patch(SMTP) as smtp:
            smtp.return_value.__enter__.return_value.login.side_effect = smtplib.SMTPAuthenticationError(535, b"x")
            r = self.call(
                f"recruitment/resume-screening/candidates/{c['Omar'].id}/interview-invite",
                {"interviewDateTime": "2026-10-05T10:30:00+05:30"},
            )
        self.assertEqual(r.status_code, 502)
        c["Omar"].refresh_from_db()
        self.assertIsNone(c["Omar"].interview_invited_at)
        self.assertEqual(EmailMessageLog.objects.get().status, "failed")

    def test_candidate_mail_is_switched_off_by_the_recruitment_switch(self):
        c = self.candidates(Meena=("rejected", "meena@example.test"))
        s = EmailSettings.get()
        s.recruitment_emails_enabled = False
        s.save()
        with mock.patch(SMTP) as smtp:
            body = self.call("recruitment/resume-screening/candidates/reject-email-all").json()
        smtp.assert_not_called()
        self.assertEqual(body["sent"], 0)
        self.assertIn("Recruitment emails are switched off", body["failed"][0]["error"])
        c["Meena"].refresh_from_db()
        self.assertIsNone(c["Meena"].rejection_emailed_at)

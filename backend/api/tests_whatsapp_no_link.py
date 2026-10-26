"""No WhatsApp message carries a link to the Employee Web App.

The owner does not want the link, so: the two approval messages lost their "View request" line and the {{link}}
placeholder, the preview card ("link" type) that used to be sent for the gate messages and the approvals is gone, the
EMPLOYEE_PORTAL_URL / WHATSAPP_LINK_PREVIEW settings and their display on the WhatsApp Control page are gone, and wording
HR saved earlier that still names {{link}} is cleaned by migration 0130 and, if it ever reaches the renderer anyway, loses
the whole line instead of printing the placeholder.

Run via: python manage.py test api.tests_whatsapp_no_link -v 2
"""

import importlib
import inspect
import re
from datetime import timedelta
from pathlib import Path
from unittest import mock

from django.apps import apps as live_apps
from django.conf import settings
from django.test import SimpleTestCase, TestCase, override_settings
from django.utils import timezone

from . import whatsapp_catalog as catalog, whatsapp_notifications, whatsapp_service as svc
from .jwt_utils import sign_token
from .models import Employee, HRUser, OutpassRequest, WhatsAppMessageTemplate

migration = importlib.import_module("api.migrations.0130_whatsapp_strip_portal_link")

CONFIG = dict(
    WACLIENT_INSTANCE_ID="INST1234",
    WACLIENT_ACCESS_TOKEN="tok-secret",
    WHATSAPP_DEFAULT_COUNTRY_CODE="91",
    BACKEND_PUBLIC_URL="https://api.example.test",
)
BASE = "/api/whatsapp-control"
# The only URLs a message may still carry: the map link in the two Geo punch messages (it shows where the punch was
# captured; it is not the Employee Web App).
MAP_LINK_VARIABLES = {("geo_punch_approval", "location"), ("geo_punch_rejection", "location")}

OLD_LINK_LINE = "🔗 View request: {{link}}"


def _ok():
    r = mock.Mock(status_code=200, content=b"x", text="")
    r.json.return_value = {"status": "success", "message_payload": {"key": {"id": "WAID"}}}
    return r


class CatalogueTests(SimpleTestCase):
    """Reads the catalogue the way a grep would: nothing in it may point at the Employee Web App."""

    def test_no_message_wording_names_the_portal_or_carries_the_link_line(self):
        for key, spec in catalog.TYPES.items():
            body = spec.body.lower()
            for banned in ("portal", "🔗", "view request", "{{link}}", "http", "www.", "employee web app"):
                self.assertNotIn(banned, body, f"{key} wording contains {banned!r}")
            self.assertNotIn("{{link", re.sub(r"\s+", "", spec.body), key)

    def test_no_message_offers_a_link_variable(self):
        for key, spec in catalog.TYPES.items():
            self.assertNotIn("link", spec.variable_names, key)
            for variable in spec.variables:
                text = f"{variable.help} {variable.sample}".lower()
                self.assertNotIn("portal", text, f"{key}.{variable.name}")
                if "http" in text:
                    self.assertIn((key, variable.name), MAP_LINK_VARIABLES)
                    self.assertIn("maps.google.com", variable.sample)

    def test_only_the_geo_punch_messages_may_show_an_address_and_it_is_a_map(self):
        carrying = {
            (key, variable.name)
            for key, spec in catalog.TYPES.items()
            for variable in spec.variables
            if "http" in variable.sample
        }
        self.assertEqual(carrying, MAP_LINK_VARIABLES)

    def test_the_two_approval_messages_share_the_variables_they_had_without_the_link(self):
        expected = [
            "employee_name",
            "request_type",
            "date",
            "time",
            "details",
            "approver",
            "comment",
            "requested_on",
            "reason",
        ]
        for key in ("approval_approved", "approval_rejected"):
            self.assertEqual(catalog.get(key).variable_names, expected)

    def test_every_default_message_renders_from_its_samples_without_an_address_apart_from_the_map(self):
        for key, spec in catalog.TYPES.items():
            if not spec.has_wording:
                continue
            text = svc.render_message(spec.body, catalog.sample_params(key), spec.variable_names)
            for url in re.findall(r"https?://\S+", text):
                self.assertTrue(url.startswith("https://maps.google.com/"), f"{key}: {url}")
            self.assertNotIn("View request", text)

    def test_the_link_placeholder_is_retired(self):
        self.assertIn("link", catalog.RETIRED_VARIABLES)
        offered = {name for spec in catalog.TYPES.values() for name in spec.variable_names}
        self.assertEqual(offered & catalog.RETIRED_VARIABLES, set())

    def test_the_settings_and_helpers_that_built_the_link_are_gone(self):
        self.assertFalse(hasattr(settings, "EMPLOYEE_PORTAL_URL"))
        self.assertFalse(hasattr(settings, "WHATSAPP_LINK_PREVIEW"))
        self.assertFalse(hasattr(whatsapp_notifications, "portal_link"))
        self.assertNotIn("link_url", inspect.signature(svc.send_notification).parameters)
        self.assertEqual(list(inspect.signature(svc.send_text_message).parameters), ["to_phone", "text"])
        self.assertEqual(
            list(inspect.signature(svc._deliver).parameters), ["log_id", "phone", "text", "contact", "on_sent"]
        )

    def test_no_backend_source_file_builds_or_reads_the_portal_link_again(self):
        backend = Path(__file__).resolve().parent.parent
        offenders = []
        for path in [*(backend / "api").glob("*.py"), backend / "config" / "settings.py"]:
            if path.name.startswith("tests"):
                continue
            text = path.read_text(encoding="utf-8")
            for needle in ("EMPLOYEE_PORTAL_URL", "WHATSAPP_LINK_PREVIEW", "portal_link", "link_url", '"type": "link"'):
                if needle in text:
                    offenders.append(f"{path.name}: {needle}")
        self.assertEqual(offenders, [])


class RenderTests(SimpleTestCase):
    """Old wording that still names {{link}} must never put the placeholder, an empty label or an address on a phone."""

    def test_the_whole_line_with_the_retired_placeholder_is_dropped(self):
        body = "Hi {{name}}\n🔗 View request: {{link}}\nBye"
        self.assertEqual(svc.render_message(body, {"name": "Asha"}), "Hi Asha\nBye")
        self.assertEqual(svc.render_message("A\nSee {{ link }} and {{name}}\nB", {"name": "Asha"}), "A\nB")

    def test_it_is_dropped_even_when_a_caller_still_passes_an_address(self):
        text = svc.render_message("Hi {{name}}\nOpen: {{link}}\nBye", {"name": "Asha", "link": "https://portal.test/x"})
        self.assertEqual(text, "Hi Asha\nBye")
        self.assertNotIn("http", text)
        # Passed by position through a type that no longer lists it, it is just one more unknown position.
        self.assertEqual(svc.render_message("Hi {{1}}\n{{link}}", ["Asha", "https://portal.test/x"]), "Hi Asha")

    def test_other_wording_is_untouched(self):
        body = "Hello {{name}},\n\nNote: {{note}}\nLinks are fine to mention: link\n\nThanks"
        self.assertEqual(
            svc.render_message(body, {"name": "Asha", "note": "ok"}),
            "Hello Asha,\n\nNote: ok\nLinks are fine to mention: link\n\nThanks",
        )

    def test_a_blank_gap_left_by_the_dropped_line_does_not_double_up(self):
        self.assertEqual(svc.render_message("A\n\n{{link}}\n\nB", {}), "A\n\nB")


@override_settings(**CONFIG)
class EditorTests(TestCase):
    """The template editors refuse {{link}} through the existing unknown-placeholder check."""

    def setUp(self):
        admin = HRUser.objects.create(username="nl_admin", password_hash="x", is_super_admin=True)
        self.hr = {"HTTP_AUTHORIZATION": f"Bearer {sign_token({'role': 'hr', 'hrUserId': admin.id})}"}

    def put(self, path, body):
        return self.client.put(f"{BASE}/{path}", body, content_type="application/json", **self.hr)

    def post(self, path, body):
        return self.client.post(f"{BASE}/{path}", body, content_type="application/json", **self.hr)

    def test_saving_wording_with_the_link_placeholder_is_refused_and_nothing_is_saved(self):
        for key in ("approval_approved", "approval_rejected"):
            r = self.put(f"templates/{key}", {"messageBody": f"Hello {{{{employee_name}}}}\n{OLD_LINK_LINE}"})
            self.assertEqual(r.status_code, 400, key)
            self.assertIn("{{link}}", r.json()["error"])
            self.assertNotIn("portal", r.json()["error"].lower())  # not listed among what HR can use
        self.assertFalse(WhatsAppMessageTemplate.objects.exists())

    def test_the_other_wording_editor_refuses_it_too(self):
        r = self.client.put(
            "/api/whatsapp/templates/salary_slip",
            {"messageBody": "Slip for {{month_year}} {{link}}"},
            content_type="application/json",
            **self.hr,
        )
        self.assertEqual(r.status_code, 400)
        self.assertIn("{{link}}", r.json()["error"])

    def test_the_same_wording_without_the_link_saves(self):
        r = self.put("templates/approval_approved", {"messageBody": "Hello {{employee_name}}, {{reason}}"})
        self.assertEqual(r.status_code, 200)

    def test_the_preview_flags_it_and_shows_the_message_without_the_line(self):
        r = self.post(
            "templates/approval_approved/preview",
            {"messageBody": f"Approved by {{{{approver}}}}\n{OLD_LINK_LINE}\nBye"},
        )
        body = r.json()
        self.assertIn("{{link}}", body["error"])
        self.assertEqual(body["preview"], "Approved by Meena (HR)\nBye")

    def test_the_variables_the_editor_offers_do_not_include_the_link(self):
        rows = {r["documentType"]: r for r in self.client.get(f"{BASE}/templates", **self.hr).json()}
        for key in ("approval_approved", "approval_rejected"):
            row = rows[key]
            self.assertNotIn("link", [v["name"] for v in row["variables"]])
            self.assertNotIn("{{link}}", row["placeholders"])
            self.assertNotIn("{{link", row["defaultMessage"])
            self.assertNotIn("View request", row["defaultMessage"])
            self.assertNotIn("View request", row["preview"])

    def test_a_stored_old_body_still_previews_cleanly_in_the_list(self):
        WhatsAppMessageTemplate.objects.create(
            document_type="approval_rejected", message_body=f"No: {{{{comment}}}}\n{OLD_LINK_LINE}"
        )
        rows = {r["documentType"]: r for r in self.client.get(f"{BASE}/templates", **self.hr).json()}
        self.assertEqual(rows["approval_rejected"]["preview"], "No: Get well soon")

    def test_the_control_page_config_no_longer_reports_a_portal_address_or_link_previews(self):
        config = self.client.get(f"{BASE}/settings", **self.hr).json()["config"]
        self.assertNotIn("employeePortalUrl", config)
        self.assertNotIn("linkPreview", config)
        overview = self.client.get(f"{BASE}/overview", **self.hr).json()["config"]
        self.assertNotIn("employeePortalUrl", overview)
        self.assertNotIn("linkPreview", overview)
        self.assertIn("backgroundSending", overview)  # the rest of the block is still there


class StripLinkLinesTests(SimpleTestCase):
    """The pure part of migration 0130."""

    strip = staticmethod(migration.strip_link_lines)

    def test_the_default_wording_before_the_change_becomes_the_default_wording_now(self):
        for key, note_label in (
            ("approval_approved", "💬 Note: {{comment}}"),
            ("approval_rejected", "📝 Reason: {{comment}}"),
        ):
            now = catalog.get(key).body
            before = now.replace(f"{note_label}\n\n", f"{note_label}\n{OLD_LINK_LINE}\n\n")
            self.assertNotEqual(before, now)
            self.assertEqual(self.strip(before), now, key)

    def test_it_removes_only_the_line_that_holds_the_placeholder(self):
        body = "Hello {{employee_name}}\n\nDetails: {{details}}\nLink -> {{link}} (tap)\nNote: {{comment}}\n\nBye"
        self.assertEqual(self.strip(body), "Hello {{employee_name}}\n\nDetails: {{details}}\nNote: {{comment}}\n\nBye")
        self.assertEqual(self.strip("A\n🔗 {{ link }}\nB"), "A\nB")
        self.assertEqual(self.strip("A\n{{link}} {{link}}\nB"), "A\nB")

    def test_a_double_blank_line_that_the_removal_leaves_is_closed(self):
        self.assertEqual(self.strip("A\n\n{{link}}\n\nB"), "A\n\nB")
        self.assertEqual(self.strip("A\n\n{{link}}"), "A")  # the line was last: no dangling blank line
        self.assertEqual(self.strip("{{link}}\n\nB"), "B")  # the line was first: no leading blank line
        self.assertEqual(self.strip("A\n{{link}}\n\nB"), "A\n\nB")

    def test_blank_lines_that_were_already_there_are_not_touched(self):
        self.assertEqual(self.strip("A\n\n\nB\n{{link}}\nC\n\n\n\nD"), "A\n\n\nB\nC\n\n\n\nD")

    def test_line_endings_are_kept(self):
        self.assertEqual(self.strip("A\r\n{{link}}\r\n\r\nB\r\n"), "A\r\n\r\nB\r\n")
        self.assertEqual(self.strip("A\r\n\r\n{{link}}\r\n\r\nB"), "A\r\n\r\nB")

    def test_wording_without_the_placeholder_is_returned_as_it_is(self):
        for body in ("", "Hello {{employee_name}}", "Link: hello\n\n\nBye  ", "{{links}} {{ Link }} {{1}}", "  \n  "):
            self.assertIs(self.strip(body), body)

    def test_it_is_idempotent(self):
        body = "Hi\n\n🔗 View request: {{link}}\n\nBye"
        once = self.strip(body)
        self.assertEqual(once, "Hi\n\nBye")
        self.assertEqual(self.strip(once), once)

    def test_wording_that_was_only_the_link_becomes_blank_which_means_the_default_wording(self):
        self.assertEqual(self.strip("{{link}}"), "")


class MigrationTests(TestCase):
    """Migration 0130 against stored rows."""

    def make(self, key, body):
        return WhatsAppMessageTemplate.objects.create(document_type=key, message_body=body)

    def bodies(self):
        return {t.document_type: t.message_body for t in WhatsAppMessageTemplate.objects.all()}

    def test_it_strips_the_line_from_a_stored_override_and_touches_nothing_else(self):
        custom = f"Hi {{{{employee_name}}}}\n\nYour {{{{request_type}}}} was approved by {{{{approver}}}}\n{OLD_LINK_LINE}\n\nThanks"
        untouched = "Slip for {{month_year}}\n\n\nRegards"
        self.make("approval_approved", custom)
        self.make("approval_rejected", f"No\n\n{OLD_LINK_LINE}")
        self.make("salary_slip", untouched)
        self.make("id_card", "")
        stamp = timezone.now() - timedelta(days=30)
        WhatsAppMessageTemplate.objects.update(updated_at=stamp)

        migration.forwards(live_apps, None)

        self.assertEqual(
            self.bodies(),
            {
                "approval_approved": "Hi {{employee_name}}\n\nYour {{request_type}} was approved by {{approver}}\n\nThanks",
                "approval_rejected": "No",
                "salary_slip": untouched,
                "id_card": "",
            },
        )
        # HR's "last edited" time does not move because of a clean-up.
        self.assertEqual({t.updated_at for t in WhatsAppMessageTemplate.objects.all()}, {stamp})

    def test_running_it_again_changes_nothing(self):
        self.make("approval_approved", f"A\n{OLD_LINK_LINE}\n\nB")
        migration.forwards(live_apps, None)
        first = self.bodies()
        self.assertEqual(first, {"approval_approved": "A\n\nB"})
        migration.forwards(live_apps, None)
        self.assertEqual(self.bodies(), first)

    def test_it_is_a_no_op_when_nothing_was_customised(self):
        migration.forwards(live_apps, None)
        self.assertFalse(WhatsAppMessageTemplate.objects.exists())

    def test_it_covers_every_message_type_not_only_the_approvals(self):
        self.make("outpass_gate_out", "Out {{employee_name}} {{link}}\nBye")
        migration.forwards(live_apps, None)
        self.assertEqual(self.bodies(), {"outpass_gate_out": "Bye"})

    def test_it_can_be_reversed_without_harm(self):
        operation = migration.Migration.operations[0]
        self.assertIs(operation.reverse_code, migration.migrations.RunPython.noop)

    def test_a_cleaned_body_is_accepted_by_the_editor_and_renders_without_the_line(self):
        self.make("approval_approved", f"Hello {{{{employee_name}}}}\n{OLD_LINK_LINE}\n\nBye")
        migration.forwards(live_apps, None)
        body = WhatsAppMessageTemplate.objects.get(document_type="approval_approved").message_body
        self.assertEqual(body, "Hello {{employee_name}}\n\nBye")
        from .whatsapp_control_views import _wording_error

        self.assertIsNone(_wording_error("approval_approved", body))


@override_settings(**CONFIG)
class GateSenderTests(TestCase):
    """The gate messages used to be sent as a preview card for the portal's outpass page; now they are plain text."""

    def test_gate_out_and_in_are_sent_as_plain_text_without_a_url(self):
        emp = Employee.objects.create(
            employee_code="NL1", first_name="Asha", last_name="Kumar", phone="8220015110", status="active"
        )
        req = OutpassRequest.objects.create(
            employee=emp,
            destination="Bank",
            reason="Deposit cheque",
            pass_type="official",
            status=OutpassRequest.STATUS_APPROVED,
            approver_role="hr",
            approved_by="Meena",
            exited_at=timezone.now() - timedelta(minutes=30),
            entered_at=timezone.now(),
        )
        with mock.patch("api.whatsapp_service.requests.post", return_value=_ok()) as post:
            whatsapp_notifications.notify_gate_out(req)
            whatsapp_notifications.notify_gate_in(req)
        payloads = [c.kwargs["json"] for c in post.call_args_list]
        self.assertEqual(len(payloads), 2)
        for payload in payloads:
            self.assertEqual(payload["type"], "text")
            self.assertNotIn("url", payload)
            self.assertNotIn("http", payload["message"])
        self.assertIn("Gate OUT Recorded", payloads[0]["message"])
        self.assertIn("Gate IN Recorded", payloads[1]["message"])

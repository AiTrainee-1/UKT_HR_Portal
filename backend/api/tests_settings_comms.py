"""Settings -> SMTP / Email and Backup server rules.

The App Password is write-only (GET never returns it, an empty value on PUT keeps the saved one), the mail-server
fields are checked before they are stored, the Google Drive switch needs a folder and a key, and the backup
schedule's weekdays are checked. No mail is sent and no backup is made: smtplib and the scheduler are never reached.
"""

from unittest import mock

from django.test import TestCase

from .jwt_utils import sign_token
from .models import BackupDriveConfig, BackupSchedule, Branch, BranchSettingsOverride, HRUser, PayrollSettings, Role

SETTINGS = "/api/payroll-settings"
DRIVE = "/api/backup/drive"
SCHEDULE = "/api/backup/schedule"
SECRET = "abcd efgh ijkl mnop"
NEW_SECRET = "wxyz wxyz wxyz wxyz"
KEY_JSON = '{"type": "service_account", "client_email": "backup-bot@example.iam.gserviceaccount.com"}'


def _hr(username="scom_admin", super_admin=True, role=None, branch=None):
    user, _ = HRUser.objects.get_or_create(
        username=username,
        defaults={"password_hash": "x", "is_super_admin": super_admin, "role": role, "branch": branch},
    )
    return {"HTTP_AUTHORIZATION": f"Bearer {sign_token({'role': 'hr', 'hrUserId': user.id})}"}


def _login(name, permissions, branch=None):
    role = Role.objects.create(name=name, permissions=permissions)
    return _hr(name.lower().replace(" ", "_"), super_admin=False, role=role, branch=branch)


class SettingsBase(TestCase):
    def setUp(self):
        self.admin = _hr()
        ps = PayrollSettings.get()
        ps.smtp_host = "smtp.before.test"
        ps.smtp_port = 587
        ps.smtp_username = "hr@before.test"
        ps.smtp_password = SECRET
        ps.smtp_from_email = "hr@before.test"
        ps.smtp_from_name = "Before HR"
        ps.save()

    def put(self, body, headers=None):
        return self.client.put(SETTINGS, body, content_type="application/json", **(headers or self.admin))

    def get(self, headers=None):
        return self.client.get(SETTINGS, **(headers or self.admin))

    def row(self):
        return PayrollSettings.objects.get(pk=1)


# -- the App Password is write-only ---------------------------------------------------------------------------


class AppPasswordTests(SettingsBase):
    def test_get_never_returns_the_password_only_whether_one_is_saved(self):
        r = self.get()
        self.assertEqual(r.status_code, 200)
        body = r.json()
        self.assertNotIn("smtpPassword", body)
        self.assertIs(body["smtpPasswordSet"], True)
        self.assertNotIn(SECRET, r.content.decode())
        PayrollSettings.objects.filter(pk=1).update(smtp_password="")
        self.assertIs(self.get().json()["smtpPasswordSet"], False)

    def test_a_login_with_the_smtp_tab_hidden_still_never_receives_it(self):
        # GET /api/payroll-settings is open to every HR login (it feeds every page's sidebar).
        nobody = _login("No Settings", {"settings.smtp": "hidden", "settings": "hidden"})
        r = self.get(nobody)
        self.assertEqual(r.status_code, 200)
        self.assertNotIn("smtpPassword", r.json())
        self.assertNotIn(SECRET, r.content.decode())

    def test_a_save_without_a_password_keeps_the_saved_one(self):
        r = self.put({"smtpFromName": "Acme HR", "smtpHost": "smtp.example.test"})
        self.assertEqual(r.status_code, 200)
        ps = self.row()
        self.assertEqual(ps.smtp_password, SECRET)
        self.assertEqual((ps.smtp_from_name, ps.smtp_host), ("Acme HR", "smtp.example.test"))
        self.assertNotIn(SECRET, r.content.decode())
        self.assertIs(r.json()["smtpPasswordSet"], True)

    def test_an_empty_password_means_keep_it_not_erase_it(self):
        for blank in ("", "   ", None):
            r = self.put({"smtpFromName": "Acme HR", "smtpPassword": blank})
            self.assertEqual(r.status_code, 200, repr(blank))
            self.assertEqual(self.row().smtp_password, SECRET, repr(blank))

    def test_a_new_password_replaces_it_and_is_not_echoed_back(self):
        r = self.put({"smtpPassword": NEW_SECRET})
        self.assertEqual(r.status_code, 200)
        self.assertEqual(self.row().smtp_password, NEW_SECRET)
        self.assertNotIn(NEW_SECRET, r.content.decode())
        self.assertNotIn(SECRET, r.content.decode())
        self.assertNotIn(NEW_SECRET, self.get().content.decode())

    def test_the_first_password_can_be_set_when_none_is_saved(self):
        PayrollSettings.objects.filter(pk=1).update(smtp_password="")
        r = self.put({"smtpPassword": SECRET})
        self.assertEqual(r.status_code, 200)
        self.assertIs(r.json()["smtpPasswordSet"], True)
        self.assertEqual(self.row().smtp_password, SECRET)

    def test_a_branch_login_keeps_the_company_password_and_a_new_one_is_only_its_own(self):
        north = Branch.objects.create(name="North")
        who = _login("North Mail", {"settings.smtp": "edit"}, branch=north)
        seen = self.get(who)
        self.assertNotIn(SECRET, seen.content.decode())
        self.assertIs(seen.json()["smtpPasswordSet"], True)

        r = self.put({"smtpFromName": "North HR", "smtpPassword": ""}, who)
        self.assertEqual(r.status_code, 200)
        self.assertEqual(self.row().smtp_password, SECRET)
        self.assertNotIn("smtp_password", BranchSettingsOverride.objects.get(branch=north).overrides)

        r = self.put({"smtpPassword": NEW_SECRET}, who)
        self.assertEqual(r.status_code, 200)
        self.assertNotIn(NEW_SECRET, r.content.decode())
        self.assertEqual(self.row().smtp_password, SECRET)
        self.assertEqual(BranchSettingsOverride.objects.get(branch=north).overrides["smtp_password"], NEW_SECRET)
        self.assertIs(self.get(who).json()["smtpPasswordSet"], True)

    def test_the_old_settings_page_payload_still_saves(self):
        r = self.put(
            {
                "smtpHost": "smtp.gmail.com",
                "smtpPort": 587,
                "smtpUsername": "hr@example.test",
                "smtpPassword": NEW_SECRET,
                "smtpFromEmail": "hr@example.test",
                "smtpFromName": "UKTextiles HR",
            }
        )
        self.assertEqual(r.status_code, 200)
        ps = self.row()
        self.assertEqual((ps.smtp_host, ps.smtp_port, ps.smtp_username), ("smtp.gmail.com", 587, "hr@example.test"))
        self.assertEqual(ps.smtp_password, NEW_SECRET)

    def test_a_view_only_login_cannot_change_the_password(self):
        viewer = _login("Mail Viewer", {"settings.smtp": "view"})
        self.assertEqual(self.put({"smtpPassword": NEW_SECRET}, viewer).status_code, 403)
        self.assertEqual(self.row().smtp_password, SECRET)


# -- mail-server fields are checked before they are stored ---------------------------------------------------


class SmtpValidationTests(SettingsBase):
    def assert_refused(self, body, message_part):
        r = self.put({"smtpFromName": "Should Not Stick", **body})
        self.assertEqual(r.status_code, 400, (body, r.content))
        self.assertIn(message_part, r.json()["error"])
        ps = self.row()
        self.assertEqual(
            (ps.smtp_host, ps.smtp_port, ps.smtp_username, ps.smtp_from_name),
            ("smtp.before.test", 587, "hr@before.test", "Before HR"),
            f"{body} left something half-saved",
        )

    def test_a_port_outside_1_to_65535_or_not_a_number_is_refused(self):
        for port in (0, -1, 65536, 99999, "0", "70000"):
            self.assert_refused({"smtpPort": port}, "port must be a number from 1 to 65535")
        for port in ("abc", "", None, "58 7"):
            self.assert_refused({"smtpPort": port}, "Invalid value for smtpPort")

    def test_the_usual_ports_are_accepted(self):
        for port, stored in ((25, 25), (465, 465), (587, 587), ("2525", 2525), (65535, 65535), (1, 1)):
            r = self.put({"smtpPort": port})
            self.assertEqual(r.status_code, 200, port)
            self.assertEqual(self.row().smtp_port, stored)

    def test_a_blank_or_malformed_host_is_refused(self):
        for host in ("", "   ", None):
            self.assert_refused({"smtpHost": host}, "host cannot be blank")
        for host in ("smtp gmail.com", "smtp.gmail.com:587", "https://smtp.gmail.com", "hr@gmail.com", "smtp/gmail"):
            self.assert_refused({"smtpHost": host}, "just the server name")

    def test_a_host_is_stored_trimmed(self):
        r = self.put({"smtpHost": "  smtp.example.test  "})
        self.assertEqual(r.status_code, 200)
        self.assertEqual(self.row().smtp_host, "smtp.example.test")
        # An address or a name with digits is a host too (the e2e stack uses 127.0.0.1).
        self.assertEqual(self.put({"smtpHost": "127.0.0.1"}).status_code, 200)
        self.assertEqual(self.row().smtp_host, "127.0.0.1")

    def test_a_blank_username_is_refused_and_a_username_is_stored_trimmed(self):
        for username in ("", "   ", None):
            self.assert_refused({"smtpUsername": username}, "username cannot be blank")
        self.assertEqual(self.put({"smtpUsername": " hr@example.test "}).status_code, 200)
        self.assertEqual(self.row().smtp_username, "hr@example.test")

    def test_fields_that_were_not_sent_are_not_judged(self):
        # An installation whose host was left blank can still save the sender's name on its own.
        PayrollSettings.objects.filter(pk=1).update(smtp_host="", smtp_port=0, smtp_username="")
        r = self.put({"smtpFromName": "Acme HR", "smtpFromEmail": "hr@acme.test"})
        self.assertEqual(r.status_code, 200)
        ps = self.row()
        self.assertEqual(
            (ps.smtp_from_name, ps.smtp_from_email, ps.smtp_host, ps.smtp_port), ("Acme HR", "hr@acme.test", "", 0)
        )

    def test_a_branch_login_gets_the_same_checks_and_stores_nothing_when_refused(self):
        north = Branch.objects.create(name="North")
        who = _login("North Mail", {"settings.smtp": "edit"}, branch=north)
        r = self.put({"smtpHost": "", "smtpFromName": "North HR"}, who)
        self.assertEqual(r.status_code, 400)
        self.assertFalse(BranchSettingsOverride.objects.filter(branch=north).exists())
        self.assertEqual(self.row().smtp_host, "smtp.before.test")


# -- Google Drive: "on" needs a folder and a key --------------------------------------------------------------


class DriveSaveTests(TestCase):
    def setUp(self):
        self.admin = _hr()

    def put(self, body):
        return self.client.put(DRIVE, body, content_type="application/json", **self.admin)

    def test_switching_it_on_without_a_folder_or_a_key_is_refused_and_saves_nothing(self):
        for body in (
            {"isEnabled": True},
            {"isEnabled": True, "folderId": "1AbCDefGhIJklmNoPQRstuVWxyz"},
            {"isEnabled": True, "folderId": "  ", "serviceAccountJson": KEY_JSON},
        ):
            r = self.put(body)
            self.assertEqual(r.status_code, 400, body)
            self.assertIn("folder ID and a service account key", r.json()["error"])
        drive = BackupDriveConfig.get()
        self.assertEqual((drive.is_enabled, drive.folder_id, drive.service_account_json), (False, "", ""))

    def test_on_with_a_folder_and_a_key_saves_and_the_key_is_never_returned(self):
        r = self.put({"isEnabled": True, "folderId": " 1AbC ", "serviceAccountJson": KEY_JSON})
        self.assertEqual(r.status_code, 200)
        self.assertNotIn("client_email", r.content.decode())
        body = r.json()
        self.assertEqual((body["isEnabled"], body["folderId"], body["hasServiceAccountKey"]), (True, "1AbC", True))
        self.assertNotIn("client_email", self.client.get(DRIVE, **self.admin).content.decode())

    def test_a_saved_key_is_kept_when_only_the_folder_changes(self):
        self.assertEqual(
            self.put({"isEnabled": True, "folderId": "old", "serviceAccountJson": KEY_JSON}).status_code, 200
        )
        r = self.put({"isEnabled": True, "folderId": "new"})
        self.assertEqual(r.status_code, 200)
        drive = BackupDriveConfig.get()
        self.assertEqual((drive.folder_id, drive.service_account_json), ("new", KEY_JSON))

    def test_the_folder_and_key_can_be_stored_while_it_is_still_off(self):
        self.assertEqual(self.put({"isEnabled": False, "folderId": "1AbC"}).status_code, 200)
        self.assertEqual(self.put({"isEnabled": False, "serviceAccountJson": KEY_JSON}).status_code, 200)
        self.assertEqual(self.put({"isEnabled": True}).status_code, 200)

    def test_switching_it_off_is_always_allowed_even_for_a_row_saved_before_this_rule(self):
        BackupDriveConfig.objects.filter(pk=1).delete()
        drive = BackupDriveConfig.get()
        drive.is_enabled = True
        drive.save()
        r = self.put({"isEnabled": False})
        self.assertEqual(r.status_code, 200)
        self.assertFalse(BackupDriveConfig.get().is_enabled)


# -- the backup schedule's weekdays ---------------------------------------------------------------------------


@mock.patch("api.backup_views.apply_schedule_to_scheduler")
class ScheduleDaysTests(TestCase):
    def setUp(self):
        self.admin = _hr()

    def put(self, body):
        return self.client.put(SCHEDULE, body, content_type="application/json", **self.admin)

    def test_the_values_the_page_sends_are_saved_as_they_are(self, apply):
        for sent, stored in (
            ("*", "*"),
            ("", "*"),
            ("mon,wed,fri", "mon,wed,fri"),
            ("sat,sun", "sat,sun"),
            ("mon-fri", "mon-fri"),
            ("MON, Wed", "mon,wed"),
            ("sat,sun,sat", "sat,sun"),
        ):
            r = self.put({"isEnabled": True, "time": "02:00", "daysOfWeek": sent})
            self.assertEqual(r.status_code, 200, sent)
            self.assertEqual(r.json()["daysOfWeek"], stored)
            self.assertEqual(BackupSchedule.get().days_of_week, stored)
        self.assertEqual(apply.call_count, 7)

    def test_anything_the_scheduler_would_choke_on_is_refused_and_nothing_is_changed(self, apply):
        self.assertEqual(self.put({"daysOfWeek": "mon,wed"}).status_code, 200)
        apply.reset_mock()
        for bad in ("monday", "mon,xyz", "*,mon", "1,2", "mon;tue", "mon-", ",", "mon,,tue", "every day"):
            r = self.put({"isEnabled": True, "retentionCount": 99, "daysOfWeek": bad})
            self.assertEqual(r.status_code, 400, bad)
            self.assertIn("daysOfWeek", r.json()["error"])
        schedule = BackupSchedule.get()
        self.assertEqual((schedule.days_of_week, schedule.is_enabled), ("mon,wed", False))
        apply.assert_not_called()

    def test_every_accepted_value_is_one_the_real_cron_trigger_builds(self, apply):
        from . import backup_scheduler

        if not backup_scheduler.is_available():
            self.skipTest("apscheduler is not installed")
        from apscheduler.triggers.cron import CronTrigger

        for value in ("*", "mon,wed,fri", "mon-fri", "sat,sun", "sun"):
            CronTrigger(hour=2, minute=0, day_of_week=value, timezone="Asia/Kolkata")
            self.assertEqual(self.put({"daysOfWeek": value}).json()["daysOfWeek"], value)

    def test_the_other_schedule_fields_still_save(self, apply):
        r = self.put({"isEnabled": True, "time": "23:45", "daysOfWeek": "*", "retentionCount": 5})
        self.assertEqual(r.status_code, 200)
        body = r.json()
        self.assertEqual((body["isEnabled"], body["time"], body["retentionCount"]), (True, "23:45", 5))
        self.assertEqual(self.put({"time": "25:99"}).status_code, 400)

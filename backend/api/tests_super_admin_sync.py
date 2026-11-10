"""The Super Admin's login follows ADMIN_USERNAME / ADMIN_PASSWORD from the backend .env (owner 2026-11-10): compared at every
start, the database updated when they differ, nothing written when they match, nobody else touched.

Run via: python manage.py test api.tests_super_admin_sync
"""

import json
from unittest import mock

import bcrypt
from django.test import TestCase, override_settings

from .jwt_utils import sign_token
from .models import AuditLog, HRUser
from .super_admin_sync import CREATED, PROMOTED, UNCHANGED, UPDATED, password_matches, sync_super_admin


def _hash(password: str) -> str:
    return bcrypt.hashpw(password.encode(), bcrypt.gensalt(rounds=4)).decode()


def _login(client, username, password):
    return client.post(
        "/api/auth/hr-login",
        data=json.dumps({"username": username, "password": password}),
        content_type="application/json",
    )


class SyncTests(TestCase):
    def test_creates_the_super_admin_on_the_first_start(self):
        result = sync_super_admin("boss", "Env-Pass-1!")
        self.assertEqual(result.outcome, CREATED)
        admin = HRUser.objects.get(is_super_admin=True)
        self.assertEqual(admin.username, "boss")
        self.assertTrue(password_matches("Env-Pass-1!", admin.password_hash))

    def test_an_existing_user_with_that_username_becomes_the_super_admin(self):
        HRUser.objects.create(username="Boss", password_hash=_hash("old"), is_active=False)
        result = sync_super_admin("boss", "Env-Pass-1!")
        self.assertEqual(result.outcome, PROMOTED)
        admin = HRUser.objects.get()
        self.assertEqual((admin.username, admin.is_super_admin, admin.is_active), ("boss", True, True))

    def test_a_changed_username_and_password_are_written_to_the_super_admin(self):
        admin = HRUser.objects.create(username="admin", password_hash=_hash("old-pass"), is_super_admin=True)
        result = sync_super_admin("newboss", "New-Pass-2!")
        self.assertEqual((result.outcome, result.changed), (UPDATED, ["username", "password"]))
        admin.refresh_from_db()
        self.assertEqual(admin.username, "newboss")
        self.assertTrue(password_matches("New-Pass-2!", admin.password_hash))
        self.assertFalse(password_matches("old-pass", admin.password_hash))
        self.assertEqual(HRUser.objects.count(), 1, "no second account is made")

    def test_only_the_password_changes_when_only_the_password_differs(self):
        admin = HRUser.objects.create(username="admin", password_hash=_hash("old-pass"), is_super_admin=True)
        result = sync_super_admin("admin", "New-Pass-2!")
        self.assertEqual(result.changed, ["password"])
        admin.refresh_from_db()
        self.assertTrue(password_matches("New-Pass-2!", admin.password_hash))

    def test_nothing_is_written_when_everything_already_matches(self):
        stored = _hash("Same-Pass-3!")
        HRUser.objects.create(username="admin", password_hash=stored, is_super_admin=True)
        with mock.patch.object(HRUser, "save") as save:
            result = sync_super_admin("admin", "Same-Pass-3!")
        self.assertEqual((result.outcome, result.changed), (UNCHANGED, []))
        save.assert_not_called()
        self.assertEqual(HRUser.objects.get().password_hash, stored, "the stored hash is not even re-made")
        self.assertFalse(AuditLog.objects.exists())

    def test_a_switched_off_super_admin_is_switched_back_on(self):
        HRUser.objects.create(username="admin", password_hash=_hash("p"), is_super_admin=True, is_active=False)
        result = sync_super_admin("admin", "p")
        self.assertEqual(result.changed, ["active"])
        self.assertTrue(HRUser.objects.get().is_active)

    def test_blank_env_values_change_nothing(self):
        HRUser.objects.create(username="admin", password_hash=_hash("p"), is_super_admin=True)
        self.assertIsNone(sync_super_admin("", "x"))
        self.assertIsNone(sync_super_admin("admin", ""))
        self.assertTrue(password_matches("p", HRUser.objects.get().password_hash))

    def test_other_hr_users_are_never_touched(self):
        other_hash = _hash("their-own")
        other = HRUser.objects.create(username="hr_clerk", password_hash=other_hash, is_active=True)
        HRUser.objects.create(username="admin", password_hash=_hash("old"), is_super_admin=True)
        sync_super_admin("boss", "New-Pass-2!")
        other.refresh_from_db()
        self.assertEqual((other.username, other.password_hash, other.is_super_admin), ("hr_clerk", other_hash, False))

    def test_a_username_that_belongs_to_another_user_is_not_taken_over(self):
        HRUser.objects.create(username="hr_clerk", password_hash=_hash("their-own"))
        admin = HRUser.objects.create(username="admin", password_hash=_hash("old"), is_super_admin=True)
        result = sync_super_admin("HR_Clerk", "New-Pass-2!")
        self.assertTrue(result.username_conflict)
        admin.refresh_from_db()
        self.assertEqual(admin.username, "admin", "two accounts cannot share one username")
        self.assertTrue(password_matches("New-Pass-2!", admin.password_hash), "the password is still synchronised")

    def test_the_change_is_in_the_activity_log_without_the_password(self):
        HRUser.objects.create(username="admin", password_hash=_hash("old"), is_super_admin=True)
        sync_super_admin("boss", "New-Pass-2!")
        entry = AuditLog.objects.get()
        self.assertIn("backend .env", entry.record_description)
        self.assertEqual((entry.old_values, entry.new_values), ({"username": "admin"}, {"username": "boss"}))
        self.assertNotIn("New-Pass-2!", json.dumps([entry.record_description, entry.old_values, entry.new_values]))

    def test_the_synchronised_login_works_on_the_login_page_and_the_old_one_does_not(self):
        HRUser.objects.create(username="admin", password_hash=_hash("old-pass"), is_super_admin=True)
        sync_super_admin("newboss", "New-Pass-2!")
        self.assertEqual(_login(self.client, "newboss", "New-Pass-2!").status_code, 200)
        self.assertEqual(_login(self.client, "admin", "old-pass").status_code, 401)


@override_settings(ADMIN_USERNAME="admin", ADMIN_PASSWORD="Env-Pass-1!")
class PortalTests(TestCase):
    def setUp(self):
        self.admin = HRUser.objects.create(username="admin", password_hash=_hash("Env-Pass-1!"), is_super_admin=True)
        self.clerk = HRUser.objects.create(username="hr_clerk", password_hash=_hash("their-own"))
        self.headers = {"HTTP_AUTHORIZATION": f"Bearer {sign_token({'role': 'hr', 'hrUserId': self.admin.id})}"}

    def _put(self, user, body):
        return self.client.put(
            f"/api/hr-users/{user.id}", data=json.dumps(body), content_type="application/json", **self.headers
        )

    def test_the_super_admins_password_cannot_be_changed_in_the_portal(self):
        r = self._put(self.admin, {"password": "Typed-In-Portal"})
        self.assertEqual(r.status_code, 400)
        self.assertIn(".env", r.json()["error"])
        self.admin.refresh_from_db()
        self.assertTrue(password_matches("Env-Pass-1!", self.admin.password_hash))

    def test_the_super_admins_other_details_and_other_users_passwords_still_can(self):
        self.assertEqual(self._put(self.admin, {"fullName": "The Owner"}).status_code, 200)
        self.assertEqual(self._put(self.clerk, {"password": "New-Clerk-Pass"}).status_code, 200)
        self.clerk.refresh_from_db()
        self.assertTrue(password_matches("New-Clerk-Pass", self.clerk.password_hash))

    def test_the_account_list_says_which_login_comes_from_the_env(self):
        r = self.client.get(f"/api/hr-users/{self.admin.id}", **self.headers)
        self.assertTrue(r.json()["credentialsFromEnv"])
        r = self.client.get(f"/api/hr-users/{self.clerk.id}", **self.headers)
        self.assertFalse(r.json()["credentialsFromEnv"])

    @override_settings(ADMIN_USERNAME="", ADMIN_PASSWORD="")
    def test_without_env_values_the_portal_keeps_its_old_behaviour(self):
        self.assertEqual(self._put(self.admin, {"password": "Typed-In-Portal"}).status_code, 200)

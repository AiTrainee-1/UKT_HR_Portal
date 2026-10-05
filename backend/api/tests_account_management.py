"""Account Management API: roles and HR logins. Role names are unique: creating or renaming onto a name that is taken is
a 400 with a message (renaming used to reach the database and come back as a 500)."""

import json

from django.test import TestCase

from .jwt_utils import sign_token
from .models import HRUser, Role


class RoleNameTests(TestCase):
    def setUp(self):
        admin, _ = HRUser.objects.get_or_create(
            username="am_admin", defaults={"password_hash": "x", "is_super_admin": True}
        )
        self.hr = {"HTTP_AUTHORIZATION": f"Bearer {sign_token({'role': 'hr', 'hrUserId': admin.id})}"}
        self.director = Role.objects.create(name="Director", permissions={"dashboard": "view"})
        self.auditor = Role.objects.create(name="Auditor", permissions={})

    def put(self, role, body):
        return self.client.put(
            f"/api/roles/{role.id}", data=json.dumps(body), content_type="application/json", **self.hr
        )

    def post(self, body):
        return self.client.post("/api/roles", data=json.dumps(body), content_type="application/json", **self.hr)

    def test_renaming_onto_another_roles_name_is_refused_not_a_server_error(self):
        r = self.put(self.auditor, {"name": "Director"})
        self.assertEqual(r.status_code, 400)
        self.assertEqual(r.json()["error"], "Role already exists")
        self.auditor.refresh_from_db()
        self.assertEqual(self.auditor.name, "Auditor")

    def test_the_comparison_ignores_case_and_surrounding_spaces(self):
        self.assertEqual(self.put(self.auditor, {"name": "  director "}).status_code, 400)
        self.assertEqual(self.post({"name": "DIRECTOR"}).status_code, 400)
        self.assertEqual(Role.objects.filter(name__iexact="director").count(), 1)

    def test_a_role_can_keep_its_own_name_and_change_its_permissions(self):
        r = self.put(self.director, {"name": "Director", "permissions": {"dashboard": "edit"}})
        self.assertEqual(r.status_code, 200, r.content)
        self.director.refresh_from_db()
        self.assertEqual(self.director.permissions, {"dashboard": "edit"})

    def test_a_role_can_change_only_the_capitals_of_its_own_name(self):
        self.assertEqual(self.put(self.director, {"name": "DIRECTOR"}).status_code, 200)
        self.director.refresh_from_db()
        self.assertEqual(self.director.name, "DIRECTOR")

    def test_a_new_name_is_saved_trimmed(self):
        r = self.put(self.auditor, {"name": "  Internal Auditor  "})
        self.assertEqual((r.status_code, r.json()["name"]), (200, "Internal Auditor"))

    def test_a_blank_name_is_refused_on_create_and_on_rename(self):
        self.assertEqual(self.post({"name": "   "}).status_code, 400)
        self.assertEqual(self.put(self.auditor, {"name": "  "}).status_code, 400)
        self.auditor.refresh_from_db()
        self.assertEqual(self.auditor.name, "Auditor")

    def test_a_rename_that_sends_no_name_still_works(self):
        r = self.put(self.auditor, {"description": "Reads everything"})
        self.assertEqual(r.status_code, 200)
        self.auditor.refresh_from_db()
        self.assertEqual((self.auditor.name, self.auditor.description), ("Auditor", "Reads everything"))

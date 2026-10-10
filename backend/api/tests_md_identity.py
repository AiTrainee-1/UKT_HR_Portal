"""The Managing Director identity: assigning it from Account Management, the rules around it, what the sign-in and
/auth/me report, and the guarantee that nobody but the MD can reach /api/md/*."""

import json
import re

import bcrypt
from django.db import IntegrityError, transaction
from django.test import TestCase
from django.urls import URLResolver, get_resolver

from .jwt_utils import sign_token
from .models import AuditLog, Branch, Employee, HRUser, Role


def headers_for(user: HRUser) -> dict:
    return {"HTTP_AUTHORIZATION": f"Bearer {sign_token({'role': 'hr', 'hrUserId': user.id})}"}


class Base(TestCase):
    def setUp(self):
        self.admin = HRUser.objects.create(username="root", password_hash="x", is_super_admin=True)
        self.role = Role.objects.create(
            name="Wide", permissions={"employees": "edit", "payroll": "edit", "reports": "edit"}
        )
        self.clerk = HRUser.objects.create(username="clerk", password_hash="x", role=self.role)
        self.person = HRUser.objects.create(username="md.sir", full_name="R. Murugan", password_hash="x")
        self.other = HRUser.objects.create(username="director2", password_hash="x")

    def call(self, method, path, body=None, as_user=None):
        kwargs = headers_for(as_user or self.admin)
        fn = getattr(self.client, method)
        if body is not None:
            return fn(path, data=json.dumps(body), content_type="application/json", **kwargs)
        return fn(path, **kwargs)

    def put(self, user, body, as_user=None):
        return self.call("put", f"/api/hr-users/{user.id}", body, as_user)

    def make_md(self, user=None):
        user = user or self.person
        user.is_md = True
        user.save(update_fields=["is_md"])
        return user


class DatabaseGuaranteeTests(Base):
    def test_the_database_itself_refuses_a_second_md(self):
        self.make_md(self.person)
        with self.assertRaises(IntegrityError), transaction.atomic():
            HRUser.objects.filter(pk=self.other.pk).update(is_md=True)
        self.assertEqual(HRUser.objects.filter(is_md=True).count(), 1)

    def test_any_number_of_accounts_may_be_not_the_md(self):
        self.assertEqual(
            HRUser.objects.filter(is_md=False).count(), HRUser.objects.count()
        )  # a fresh account is not the MD


class AssigningTheMd(Base):
    def test_a_super_admin_makes_an_account_the_md_and_it_is_recorded(self):
        r = self.put(self.person, {"isMd": True})
        self.assertEqual(r.status_code, 200, r.content)
        body = r.json()
        self.assertTrue(body["isMd"])
        self.assertIsNotNone(body["mdAssignedAt"])
        self.person.refresh_from_db()
        self.assertTrue(self.person.is_md)
        self.assertTrue(
            AuditLog.objects.filter(module="user_management", record_description="Assigned MD: md.sir").exists()
        )

    def test_the_md_can_be_taken_away_again(self):
        self.make_md()
        r = self.put(self.person, {"isMd": False})
        self.assertEqual(r.status_code, 200, r.content)
        self.person.refresh_from_db()
        self.assertFalse(self.person.is_md)
        self.assertIsNone(self.person.md_assigned_at)
        self.assertTrue(AuditLog.objects.filter(record_description="Removed MD access from: md.sir").exists())

    def test_an_edit_that_does_not_mention_the_md_leaves_it_alone(self):
        self.make_md()
        self.assertEqual(self.put(self.person, {"fullName": "R. Murugan Sir"}).status_code, 200)
        self.person.refresh_from_db()
        self.assertTrue(self.person.is_md)
        self.assertEqual(self.person.full_name, "R. Murugan Sir")

    def test_a_second_md_is_refused_naming_the_current_one_and_nothing_changes(self):
        self.make_md(self.person)
        r = self.put(self.other, {"isMd": True})
        self.assertEqual(r.status_code, 409)
        self.assertEqual(r.json()["code"], "md_exists")
        self.assertEqual(r.json()["currentMd"]["username"], "md.sir")
        self.other.refresh_from_db()
        self.person.refresh_from_db()
        self.assertEqual((self.other.is_md, self.person.is_md), (False, True))

    def test_replacing_the_md_moves_the_identity_in_one_step(self):
        self.make_md(self.person)
        r = self.put(self.other, {"isMd": True, "replaceMd": True})
        self.assertEqual(r.status_code, 200, r.content)
        self.other.refresh_from_db()
        self.person.refresh_from_db()
        self.assertEqual((self.other.is_md, self.person.is_md), (True, False))
        self.assertEqual(HRUser.objects.filter(is_md=True).count(), 1)
        self.assertTrue(
            AuditLog.objects.filter(
                record_description="Removed MD access from: md.sir (replaced by director2)"
            ).exists()
        )
        self.assertTrue(AuditLog.objects.filter(record_description="Assigned MD: director2").exists())

    def test_a_super_administrator_can_never_be_the_md(self):
        r = self.put(self.admin, {"isMd": True})
        self.assertEqual(r.status_code, 400)
        self.assertIn("super administrator", r.json()["error"])
        self.admin.refresh_from_db()
        self.assertFalse(self.admin.is_md)

    def test_the_md_is_company_wide_so_a_branch_account_cannot_be_one(self):
        branch = Branch.objects.create(name="Unit1")
        self.person.branch = branch
        self.person.save(update_fields=["branch"])
        r = self.put(self.person, {"isMd": True})
        self.assertEqual(r.status_code, 400)
        self.assertIn("whole company", r.json()["error"])

    def test_the_branch_can_be_cleared_in_the_same_request_that_makes_the_md(self):
        branch = Branch.objects.create(name="Unit1")
        self.person.branch = branch
        self.person.save(update_fields=["branch"])
        r = self.put(self.person, {"isMd": True, "branchId": None})
        self.assertEqual(r.status_code, 200, r.content)

    def test_an_md_cannot_afterwards_be_limited_to_a_branch(self):
        self.make_md()
        branch = Branch.objects.create(name="Unit1")
        r = self.put(self.person, {"branchId": branch.id})
        self.assertEqual(r.status_code, 400)
        self.person.refresh_from_db()
        self.assertIsNone(self.person.branch_id)
        # but giving up the MD identity and a branch in one go is fine
        self.assertEqual(self.put(self.person, {"isMd": False, "branchId": branch.id}).status_code, 200)

    def test_a_disabled_account_cannot_be_made_the_md(self):
        self.person.is_active = False
        self.person.save(update_fields=["is_active"])
        r = self.put(self.person, {"isMd": True})
        self.assertEqual(r.status_code, 400)
        self.assertIn("Enable the account", r.json()["error"])

    def test_only_a_super_administrator_can_assign_it(self):
        r = self.put(self.person, {"isMd": True}, as_user=self.clerk)
        self.assertEqual(r.status_code, 403)
        self.person.refresh_from_db()
        self.assertFalse(self.person.is_md)

    def test_an_account_can_be_created_as_the_md(self):
        r = self.call(
            "post", "/api/hr-users", {"username": "newmd", "password": "Passw0rd!x", "fullName": "New MD", "isMd": True}
        )
        self.assertEqual(r.status_code, 201, r.content)
        self.assertTrue(r.json()["isMd"])
        self.assertTrue(HRUser.objects.get(username="newmd").is_md)

    def test_creating_a_second_md_creates_nothing(self):
        self.make_md()
        r = self.call("post", "/api/hr-users", {"username": "newmd", "password": "Passw0rd!x", "isMd": True})
        self.assertEqual(r.status_code, 409)
        self.assertFalse(HRUser.objects.filter(username="newmd").exists())
        r = self.call(
            "post", "/api/hr-users", {"username": "newmd", "password": "Passw0rd!x", "isMd": True, "replaceMd": True}
        )
        self.assertEqual(r.status_code, 201, r.content)
        self.person.refresh_from_db()
        self.assertFalse(self.person.is_md)

    def test_the_list_says_who_the_md_is_and_an_ordinary_account_is_not(self):
        self.make_md()
        accounts = {a["username"]: a for a in self.call("get", "/api/hr-users").json()}
        self.assertTrue(accounts["md.sir"]["isMd"])
        self.assertFalse(accounts["clerk"]["isMd"])
        self.assertFalse(accounts["root"]["isMd"])


class WhatTheSignInReports(Base):
    def test_auth_me_says_isMd_only_for_the_md(self):
        self.make_md()
        me = lambda u: self.client.get("/api/auth/me", **headers_for(u)).json()  # noqa: E731
        self.assertTrue(me(self.person)["isMd"])
        self.assertFalse(me(self.clerk)["isMd"])
        self.assertFalse(me(self.admin)["isMd"])

    def test_the_sign_in_response_carries_the_flag(self):
        hashed = bcrypt.hashpw(b"Passw0rd!x", bcrypt.gensalt(rounds=4)).decode()
        HRUser.objects.filter(pk=self.person.pk).update(password_hash=hashed)
        self.make_md()
        r = self.client.post(
            "/api/auth/hr-login",
            data=json.dumps({"username": "md.sir", "password": "Passw0rd!x"}),
            content_type="application/json",
        )
        self.assertEqual(r.status_code, 200, r.content)
        self.assertTrue(r.json()["isMd"])

    def test_an_employee_token_has_no_md_flag(self):
        emp = Employee.objects.create(
            employee_code="E1", first_name="A", last_name="B", phone="9", branch=Branch.objects.create(name="HO")
        )
        token = sign_token({"role": "employee", "employeeId": emp.id, "name": "A B"})
        me = self.client.get("/api/auth/me", HTTP_AUTHORIZATION=f"Bearer {token}").json()
        self.assertNotIn("isMd", me)


class OnlyTheMdReachesTheMdApi(Base):
    def test_the_md_gets_in_and_is_greeted_by_name(self):
        self.make_md()
        r = self.client.get("/api/md/me", **headers_for(self.person))
        self.assertEqual(r.status_code, 200, r.content)
        body = r.json()
        self.assertEqual((body["username"], body["name"]), ("md.sir", "R. Murugan"))
        self.assertEqual([p["id"] for p in body["pages"]][:3], ["dashboard", "employees", "branches"])
        self.assertIn("serverTime", body)

    def test_everyone_else_is_refused(self):
        self.make_md()
        for who in (self.admin, self.clerk, self.other):
            r = self.client.get("/api/md/me", **headers_for(who))
            self.assertEqual(r.status_code, 403, who.username)

    def test_an_employee_token_and_no_token_are_refused(self):
        self.make_md()
        emp = Employee.objects.create(
            employee_code="E1", first_name="A", last_name="B", phone="9", branch=Branch.objects.create(name="HO")
        )
        token = sign_token({"role": "employee", "employeeId": emp.id, "name": "A B"})
        self.assertEqual(self.client.get("/api/md/me", HTTP_AUTHORIZATION=f"Bearer {token}").status_code, 403)
        self.assertEqual(self.client.get("/api/md/me").status_code, 401)

    def test_taking_the_identity_away_closes_the_door_on_the_very_next_request(self):
        self.make_md()
        self.assertEqual(self.client.get("/api/md/me", **headers_for(self.person)).status_code, 200)
        HRUser.objects.filter(pk=self.person.pk).update(is_md=False)
        self.assertEqual(self.client.get("/api/md/me", **headers_for(self.person)).status_code, 403)

    def test_a_disabled_md_is_refused(self):
        self.make_md()
        HRUser.objects.filter(pk=self.person.pk).update(is_active=False)
        r = self.client.get("/api/md/me", **headers_for(self.person))
        self.assertEqual(r.status_code, 401)  # the permission middleware: account disabled

    def test_a_path_nobody_routed_is_still_locked_by_the_middleware(self):
        """If someone adds /api/md/x and forgets the decorator, the middleware is the second lock."""
        self.make_md()
        for who in (self.admin, self.clerk):
            self.assertEqual(self.client.get("/api/md/not-a-route", **headers_for(who)).status_code, 403, who.username)
        self.assertEqual(
            self.client.get("/api/md/not-a-route", **headers_for(self.person)).status_code, 404
        )  # past the lock

    def test_the_md_does_not_gain_the_hr_portal_by_being_the_md(self):
        """The flag opens /api/md/* and, for the pages the MD portal copies from the HR portal, those pages' modules
        (permission_registry.MD_HR_GRANTS: tests_md_hr_access pins them). The rest of the HR portal still answers to the
        role, and this one has none."""
        self.make_md()
        self.assertNotEqual(self.client.get("/api/employees", **headers_for(self.person)).status_code, 403)
        for path in ("/api/payroll", "/api/salary-slips", "/api/hr-users", "/api/roles", "/api/audit-logs"):
            self.assertEqual(self.client.get(path, **headers_for(self.person)).status_code, 403, path)


def _md_routes() -> list[str]:
    found: list[str] = []

    def walk(patterns, prefix):
        for p in patterns:
            route = prefix + str(p.pattern)
            if isinstance(p, URLResolver):
                walk(p.url_patterns, route)
            else:
                found.append(route)

    walk(get_resolver().url_patterns, "")
    return [r for r in found if r.startswith("api/md/")]


def _concrete(route: str) -> str:
    route = re.sub(r"<int:\w+>", "1", route)
    route = re.sub(r"<uuid:\w+>", "00000000-0000-0000-0000-000000000000", route)
    return "/" + re.sub(r"<\w+:\w+>", "x", route)


class EveryMdRouteIsLocked(Base):
    def test_no_route_under_api_md_answers_anyone_but_the_md(self):
        routes = _md_routes()
        self.assertTrue(routes, "the MD portal has no routes")
        self.make_md()
        outsiders = [self.admin, self.clerk, self.other]
        for route in routes:
            url = _concrete(route)
            for method in ("get", "post", "put", "patch", "delete"):
                self.assertEqual(
                    getattr(self.client, method)(url).status_code in (401, 403, 404, 405),
                    True,
                    (method, url, "no token"),
                )
                for who in outsiders:
                    status = getattr(self.client, method)(url, **headers_for(who)).status_code
                    self.assertIn(status, (403, 405), (method, url, who.username, status))

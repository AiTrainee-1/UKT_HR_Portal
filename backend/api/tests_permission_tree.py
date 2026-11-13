"""
The full permission tree (2026-11-11): every page, tab, sub-tab, feature and approval of the HR portal has its own key.

What these tests guarantee:

* Nothing missed: every API path Django serves maps to a key, or is on API_ALLOWLIST with the reason it is not
  role-controlled (and no allowlist line is stale). The portal's addresses are checked the same way by
  frontend/src/lib/permission-tree.test.ts.
* Nothing changed for existing roles: for many role shapes (every old key at every level, mixtures, HR Manager / HR
  Assistant changes, the Managing Director) every API path resolves to exactly the level it had under the rules of
  2026-11-10 (tests_permission_snapshot.py, the frozen copy), and every approval decision is the same.
* The new keys are enforced: a hidden tab's API is refused, a view-only tab's changes are refused, the view-level keys
  (Requests kinds, report groups, settings sub-tabs) are checked, and every approval kind is checked in its endpoint.

Run via: DATABASE_URL="" DB_HOST=localhost DB_TEST_NAME=test_uktex_<you> py -3 manage.py test api.tests_permission_tree
"""

from __future__ import annotations

import json
import random
import re
from decimal import Decimal
from types import SimpleNamespace

from django.test import SimpleTestCase, TestCase
from django.urls import get_resolver
from django.urls.resolvers import URLPattern, URLResolver

from . import approval_workflow as approval
from . import hr_access, permission_tree
from . import tests_permission_snapshot as old
from .jwt_utils import sign_token
from .models import (
    Advance,
    Applicant,
    Bonus,
    Branch,
    Employee,
    EmployeeRequest,
    HRUser,
    IdCardSettings,
    Job,
    Payroll,
    Role,
)
from .permission_registry import (
    INHERITS,
    URL_MODULE_MAP,
    URL_PATTERNS,
    all_module_keys,
    effective_permissions,
    legacy_module,
    resolve_module,
    resolve_permission,
)

LEVELS = ("hidden", "view", "edit")

# API paths that no role key controls, and why. A path here must NOT be mapped (else it is not ungated), and every line
# must match at least one real path (no stale lines). permission-inventory.md lists the same.
API_ALLOWLIST: tuple[tuple[str, str], ...] = (
    (r"", "the API index"),
    (r"healthz", "uptime probes"),
    (r"auth/.*", "signing in and the current account"),
    (r"shared/[^/]+", "Endpoint Sharing's public call: its own API key, never an HR token"),
    (r"(outpass|visitor)/gate/.*", "the gate QR pages: no login"),
    (r"connector/.*", "the factory Site Connector program: its own key"),
    (r"co-portal/.*", "the CO portal: its own portal key"),
    (r"my/.*", "employee tokens (mobile app, employee portal)"),
    (r"employee/.*", "employee tokens"),
    (r"live-location/ping", "employee tokens"),
    (r"tracking/(state|consent|batch|my-journeys)", "employee tokens"),
    (r"manager/.*", "Department Head (HOD) tokens"),
    (r"md/.*", "the Managing Director only: require_md and the middleware's md/ lock"),
    (r"roles(/\d+)?", "Account Management: require_super_admin"),
    (r"hr-users(/.*)?", "Account Management: require_super_admin / require_master_admin"),
    (r"shared-endpoints(/.*)?", "Settings -> Endpoint Sharing: require_super_admin"),
    (r"hr-activity", "Assistant Activity: the Super Admin and HR Managers, by account type (checked in the view)"),
    (r"approval-summary", "the approval pipelines, no data: read by every app"),
    (
        r"hr/approval-reminders",
        "employees' remind-HR nudges: ungated before 2026-11-11 (permission-inventory.md, Gaps)",
    ),
    (r"payroll-settings", "read by every page; each saved field is checked against its Settings tab (FIELD_GROUPS)"),
    (r"pf-esi-settings", "read by the payroll screens; only the Super Admin changes it (checked in the view)"),
    (r"support-contact", "the HR contact on the sign-in screens: no login"),
    (r"mobile-app/latest-version", "the app's update check: no login"),
    (r"theme-settings(/update)?", "the portal's colours: ungated before 2026-11-11 (permission-inventory.md, Gaps)"),
)


def api_paths() -> list[str]:
    """Every API path Django serves, relative to /api/, with a sample value in place of each parameter."""

    def walk(patterns, prefix=""):
        for p in patterns:
            if isinstance(p, URLResolver):
                yield from walk(p.url_patterns, prefix + str(p.pattern))
            elif isinstance(p, URLPattern):
                yield prefix + str(p.pattern)

    out = []
    for route in walk(get_resolver().url_patterns):
        if not route.startswith("api/"):
            continue
        sample = re.sub(r"<int:[^>]+>", "7", route[len("api/") :])
        sample = re.sub(r"<[^>]+>", "abc", sample)
        out.append(sample.rstrip("/"))
    return sorted(set(out))


def allowlisted(path: str) -> str | None:
    for pattern, why in API_ALLOWLIST:
        if re.fullmatch(pattern, path):
            return why
    return None


def account(role_permissions=None, *, approvals=None, overrides=None, category="admin", is_md=False):
    """An HRUser-like object for the pure resolvers (no database)."""
    role = SimpleNamespace(permissions=role_permissions or {}, approvals=approvals, category="")
    return SimpleNamespace(
        role=role,
        permission_overrides=overrides or {},
        category=category,
        is_md=is_md,
        is_active=True,
        is_super_admin=False,
    )


def old_role_shapes() -> list[dict]:
    """Role permission dicts written with the keys of 2026-11-10 only: what every stored role looks like."""
    keys = old.old_all_module_keys()
    shapes: list[dict] = [{}, {k: "edit" for k in keys}, {k: "view" for k in keys}, {k: "hidden" for k in keys}]
    for k in keys:
        for level in LEVELS:
            shapes.append({k: level})
            parent = k.rpartition(".")[0]
            if parent:
                for other in LEVELS:
                    shapes.append({parent: other, k: level})
    rng = random.Random(20261111)
    for _ in range(250):
        shapes.append({k: rng.choice(LEVELS) for k in keys if rng.random() < 0.4})
    return shapes


# ───────────────────────────── the tree itself ─────────────────────────────


class TreeShape(SimpleTestCase):
    def test_every_key_is_unique_and_its_parent_is_in_the_tree(self):
        keys = all_module_keys()
        self.assertEqual(len(keys), len(set(keys)))
        for key in keys:
            parent = key.rpartition(".")[0]
            if parent:
                self.assertIn(parent, keys, key)
        # every key that existed before is still there (a role's stored key never becomes unknown)
        self.assertLessEqual(set(old.old_all_module_keys()), set(keys))

    def test_every_node_is_complete(self):
        for node, _depth, _parent in permission_tree.iter_display():
            self.assertTrue(node["label"] and node["help"], node["key"])
            self.assertIn(node["type"], ("section", "page", "tab", "subtab", "view", "feature"), node["key"])
            if node.get("locked"):
                self.assertFalse(node.get("api") or node.get("apiPatterns"), node["key"])

    def test_inherits_points_to_a_key_and_never_loops(self):
        keys = set(all_module_keys())
        for key, target in INHERITS.items():
            self.assertIn(target, keys, key)
            self.assertEqual(resolve_permission({target: "view"}, key), "view")
        self.assertEqual(resolve_permission({}, "biometric_connectors.device_control.fetch"), "hidden")

    def test_every_mapped_key_is_in_the_tree(self):
        keys = set(all_module_keys()) | {n["key"] for n in permission_tree.locked_nodes()}
        for prefix, key in URL_MODULE_MAP.items():
            self.assertIn(key, keys, prefix)
        for pattern, key in URL_PATTERNS:
            self.assertIn(key, keys, pattern.pattern)

    def test_the_portal_reads_the_same_tree(self):
        with open(permission_tree.FRONTEND_JSON, encoding="utf-8") as f:
            portal = json.load(f)
        self.assertEqual(
            portal,
            json.loads(json.dumps(permission_tree.export_tree())),
            "frontend/src/lib/permission-tree.json is out of date: run permission_tree.write_json() (see its docstring)",
        )

    def test_counts(self):
        # 55 keys before; every page, tab, sub-tab and feature now (permission-inventory.md has the full list)
        self.assertEqual(len(old.old_all_module_keys()), 55)
        self.assertGreater(len(all_module_keys()), 300)
        self.assertEqual(len(hr_access.APPROVAL_KINDS), 27)


# ───────────────────────────── nothing missed ─────────────────────────────


class Completeness(SimpleTestCase):
    def test_every_api_path_maps_to_a_key_or_is_allowlisted(self):
        missing = [p for p in api_paths() if resolve_module(p) is None and allowlisted(p) is None]
        self.assertEqual(
            missing, [], "map these in permission_tree.py / URL_MODULE_MAP, or allowlist them with a reason"
        )

    def test_the_allowlist_is_honest(self):
        paths = api_paths()
        for pattern, why in API_ALLOWLIST:
            hits = [p for p in paths if re.fullmatch(pattern, p)]
            self.assertTrue(hits, f"stale allowlist line: {pattern} ({why})")
            for p in hits:
                self.assertIsNone(resolve_module(p), f"{p} is mapped AND allowlisted")

    def test_the_parts_of_a_page_resolve_to_their_own_keys(self):
        cases = {
            "payroll/issues": "payroll.issues",
            "payroll/7/details": "payroll.details",
            "payroll/production/7/details": "production_payroll.details",
            "employees/7/offer-letter/pdf": "employees.letters",
            "employees/7/status": "employees.status",
            "tds/employees/7": "employees.co_emp.tds",
            "attendance/report-log/sheet": "attendance.report_log.monthly",
            "attendance/device-control/fetch/start": "biometric_connectors.device_control.fetch",
            "attendance/device-control/employees/7/links": "biometric_connectors.device_control.link_unlink",
            "tracking/journeys/day-map": "geo_attendance.on_duty_map",
            "tracking/journeys/7/export": "geo_attendance.journeys.export",
            "hr/hod-reminders/send": "requests.notify.send",
            "idcard-settings": "settings.idcard",
            "salary-slips/7/whatsapp": "salary_slip.send",
            "recruitment/employee-documents/7/upload": "recruitment.documents.employee.extra",
            "mobile-app-logins/7/reset-password": "mobile_app_login.logins.password",
        }
        for path, key in cases.items():
            self.assertEqual(resolve_module(path), key, path)


# ───────────────────────────── nothing changed for existing roles ─────────────────────────────


class BackwardCompatibility(SimpleTestCase):
    """The old and the new rules give every role the same level on every API path, and the same approvals."""

    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls.paths = [p for p in api_paths() if old.old_resolve_module(p) is not None or resolve_module(p) is not None]

    def assert_same_levels(self, old_perms: dict, new_perms: dict, label: str):
        for path in self.paths:
            old_key, new_key = old.old_resolve_module(path), resolve_module(path)
            self.assertEqual(old_key is None, new_key is None, f"{label}: {path} gated before={old_key} now={new_key}")
            if old_key is None:
                continue
            before = old.old_resolve_permission(old_perms, old_key)
            now = resolve_permission(new_perms, new_key)
            self.assertEqual(before, now, f"{label}: {path} ({old_key} -> {new_key})")

    def test_every_role_shape_keeps_its_level_on_every_api_path(self):
        for i, shape in enumerate(old_role_shapes()):
            self.assert_same_levels(
                old.old_effective_permissions(shape), effective_permissions(account(shape)), f"role #{i} {shape}"
            )

    def test_hr_manager_and_assistant_changes_keep_their_level(self):
        rng = random.Random(7)
        keys = old.old_all_module_keys()
        for i in range(120):
            role = {k: rng.choice(LEVELS) for k in keys if rng.random() < 0.5}
            changes = {k: rng.choice(LEVELS) for k in keys if rng.random() < 0.15}
            for category in ("hr_manager", "hr_assistant"):
                acct = account(role, overrides={"modules": changes}, category=category)
                self.assert_same_levels(
                    old.old_effective_permissions(role, changes),
                    effective_permissions(acct),
                    f"{category} #{i}",
                )

    def test_the_managing_director_keeps_its_level(self):
        for i, shape in enumerate(old_role_shapes()[:200]):
            self.assert_same_levels(
                old.old_effective_permissions(shape, is_md=True),
                effective_permissions(account(shape, is_md=True)),
                f"MD #{i}",
            )

    def test_every_approval_is_the_same(self):
        rng = random.Random(11)
        old_kinds = [k for k, _m in old.OLD_APPROVAL_KINDS]
        maps: list[dict | None] = [None, {k: True for k in old_kinds}, {k: False for k in old_kinds}, {}]
        maps += [{k: rng.random() < 0.5 for k in old_kinds if rng.random() < 0.7} for _ in range(30)]
        shapes = old_role_shapes()[::7]
        for shape in shapes:
            for role_map in maps:
                for category in ("admin", "hr_manager", "hr_assistant"):
                    changes = {k: rng.random() < 0.5 for k in old_kinds if rng.random() < 0.2}
                    if category == "admin":
                        changes = {}
                    acct = account(shape, approvals=role_map, overrides={"approvals": changes}, category=category)
                    perms = old.old_effective_permissions(shape)
                    explicit = role_map is not None or category != "admin"
                    before = old.old_effective_approvals(perms, role_map if explicit else None, changes, category)
                    if category != "admin" and role_map is None:
                        # an HR Manager / Assistant on a role with no switches: the old rule gave edit = approve too
                        before = old.old_effective_approvals(perms, None, changes, category)
                    now = hr_access.effective_approvals(acct)
                    for kind in hr_access.APPROVAL_KINDS:
                        if kind.replaces:
                            expected = before[kind.replaces]
                        elif kind.key in before:
                            expected = before[kind.key]
                        else:
                            # a decision that only ever needed Edit (new switch, never set): edit = may, as before
                            expected = resolve_permission(perms, kind.module) == "edit"
                        self.assertEqual(now[kind.key], expected, f"{kind.key} {shape} {role_map} {changes} {category}")

    def test_the_middleware_still_lets_any_request_type_through_to_the_view(self):
        # DECISION_ROUTES name the old kinds: "may this account approve any request type / any advance"
        acct = account({"requests": "view", "settlement": "view"}, approvals={"request": True, "advance": False})
        self.assertTrue(hr_access.may_approve(acct, "request"))
        self.assertFalse(hr_access.may_approve(acct, "advance"))
        self.assertEqual(hr_access.decision_kind("employee-requests/4/action", "PUT"), "request")


class PureRules(SimpleTestCase):
    def test_an_unset_part_follows_its_page_and_a_set_one_wins(self):
        self.assertEqual(resolve_permission({"payroll": "edit"}, "payroll.issues"), "edit")
        self.assertEqual(
            resolve_permission({"payroll": "edit", "payroll.issues": "hidden"}, "payroll.issues"), "hidden"
        )
        self.assertEqual(resolve_permission({"payroll.issues": "view"}, "payroll"), "hidden")  # never upwards

    def test_a_part_that_belonged_to_another_module_follows_it(self):
        self.assertEqual(resolve_permission({"id_cards": "edit"}, "settings.idcard"), "edit")
        self.assertEqual(
            resolve_permission({"settings": "edit"}, "settings.idcard"), "hidden"
        )  # as before: ID Cards' own
        self.assertEqual(resolve_permission({"attendance": "view"}, "biometric_connectors.device_status"), "view")
        self.assertEqual(
            resolve_permission(
                {"attendance": "edit", "biometric_connectors": "hidden"}, "biometric_connectors.device_status"
            ),
            "hidden",
        )
        self.assertEqual(legacy_module("biometric_connectors.device_control.push"), "attendance")
        self.assertEqual(legacy_module("payroll.issues"), "payroll.issues")

    def test_an_account_change_on_a_section_takes_every_part_with_it(self):
        acct = account(
            {"payroll": "edit", "payroll.issues": "view", "payroll.details": "edit"},
            overrides={"modules": {"payroll": "hidden", "payroll.details": "view"}},
            category="hr_manager",
        )
        perms = effective_permissions(acct)
        self.assertEqual(resolve_permission(perms, "payroll.issues"), "hidden")
        self.assertEqual(resolve_permission(perms, "payroll.details"), "view")

    def test_the_md_view_only_cap_covers_every_part(self):
        perms = effective_permissions(account({"requests.notify": "edit", "leave.holidays": "edit"}, is_md=True))
        self.assertEqual(resolve_permission(perms, "requests.notify"), "view")
        self.assertEqual(resolve_permission(perms, "leave.holidays"), "view")

    def test_kind_for(self):
        er = SimpleNamespace(request_type="salary_enquiry")
        self.assertEqual(hr_access.kind_for("request", er), "request_salary_enquiry")
        self.assertEqual(hr_access.kind_for("request", SimpleNamespace(request_type="nope")), "request_general")
        self.assertEqual(hr_access.kind_for("advance", SimpleNamespace(advance_type="term")), "advance_term")
        self.assertEqual(hr_access.kind_for("advance", SimpleNamespace(advance_type="general")), "advance_general")
        self.assertEqual(hr_access.kind_for("leave", er), "leave")

    def test_an_old_switch_counts_until_the_new_one_is_set(self):
        perms = {"requests": "view"}
        acct = account(perms, approvals={"request": True, "request_shift_correction": False}, category="hr_manager")
        got = hr_access.effective_approvals(acct)
        self.assertTrue(got["request_salary_enquiry"])
        self.assertFalse(got["request_shift_correction"])
        # an account's own old switch beats the role's new ones
        acct = account(perms, approvals={"request_general": True}, overrides={"approvals": {"request": False}})
        acct.category = "hr_manager"
        self.assertFalse(hr_access.effective_approvals(acct)["request_general"])

    def test_an_extra_right_never_works_without_edit(self):
        acct = account({"payroll": "view"}, approvals={"payroll_finalize": True}, category="hr_manager")
        self.assertFalse(hr_access.effective_approvals(acct)["payroll_finalize"])
        acct = account({"payroll": "edit"}, approvals={"leave": True}, category="hr_manager")
        self.assertTrue(hr_access.effective_approvals(acct)["payroll_finalize"])  # never set: edit = may, as before
        acct = account({"payroll": "edit"}, approvals={"payroll_finalize": False}, category="hr_manager")
        self.assertFalse(hr_access.effective_approvals(acct)["payroll_finalize"])

    def test_assistant_locks_still_hold(self):
        acct = account(
            {"missing_punch": "edit", "attendance": "edit"},
            approvals={k: True for k in hr_access.APPROVAL_KEYS},
            category="hr_assistant",
        )
        got = hr_access.effective_approvals(acct)
        self.assertFalse(got["missing_punch"] or got["attendance_correction"])
        self.assertIsNotNone(hr_access.validate_approvals({"missing_punch": True}, category="hr_assistant")[1])
        self.assertIsNone(hr_access.validate_approvals({"request": True, "advance": False})[1])  # an older client


# ───────────────────────────── the server enforces the new keys ─────────────────────────────


def bearer(user: HRUser) -> dict:
    payload = {"role": "hr", "hrUserId": user.id, "name": user.username}
    return {"HTTP_AUTHORIZATION": f"Bearer {sign_token(payload)}"}


class Enforcement(TestCase):
    @classmethod
    def setUpTestData(cls):
        cls.emp = Employee.objects.create(
            employee_code="PT1", first_name="Priya", last_name="Tree", status="active", employment_type="staff",
            join_date="2020-01-01", salary_amount=Decimal("20000"),
        )  # fmt: skip

    def setUp(self):
        approval.clear_cache()
        self.addCleanup(approval.clear_cache)

    def login(self, permissions, approvals=None, category="admin"):
        role = Role.objects.create(name=f"PT role {Role.objects.count()}", permissions=permissions, approvals=approvals)
        return HRUser.objects.create(
            username=f"pt_{Role.objects.count()}", password_hash="x", role=role, category=category
        )

    def call(self, user, method, path, body=None):
        return getattr(self.client, method)(path, body or {}, content_type="application/json", **bearer(user))

    def test_a_hidden_tab_is_refused_and_its_page_still_answers(self):
        user = self.login({"payroll": "edit", "payroll.issues": "hidden"})
        self.assertEqual(self.call(user, "get", "/api/payroll/issues?month=10&year=2026").status_code, 403)
        self.assertEqual(self.call(user, "get", "/api/payroll?month=10&year=2026").status_code, 200)

    def test_a_view_only_tab_reads_but_cannot_change(self):
        IdCardSettings.get()
        user = self.login({"settings": "edit", "settings.idcard": "view"})
        self.assertEqual(self.call(user, "get", "/api/idcard-settings").status_code, 200)
        r = self.call(user, "put", "/api/idcard-settings", {"cardTitle": "x"})
        self.assertEqual((r.status_code, r.json()["error"]), (403, "permission_denied"))

    def test_a_part_that_followed_another_module_still_does(self):
        user = self.login({"id_cards": "view"})  # the old way to see the ID card settings
        self.assertEqual(self.call(user, "get", "/api/idcard-settings").status_code, 200)
        user = self.login({"attendance": "view", "biometric_connectors": "hidden"})
        self.assertEqual(self.call(user, "get", "/api/attendance/biometric-status").status_code, 403)
        self.assertEqual(self.call(user, "get", "/api/attendance/summary").status_code, 200)

    def test_a_feature_with_an_id_in_its_path_is_enforced(self):
        user = self.login({"employees": "edit", "employees.letters": "hidden"})
        r = self.call(user, "get", f"/api/employees/{self.emp.id}/offer-letter/pdf")
        self.assertEqual(r.status_code, 403)
        self.assertEqual(self.call(user, "get", f"/api/employees/{self.emp.id}").status_code, 200)

    def test_a_requests_kind_can_be_hidden_on_its_own(self):
        user = self.login({"requests": "view", "leave": "view", "requests.list.leave": "hidden"})
        body = self.call(user, "get", "/api/hr-requests").json()
        keys = {k["key"] for k in body["kinds"]}
        self.assertNotIn("leave", keys)
        self.assertIn("permission", keys)

    def test_a_settings_sub_tab_can_be_view_only(self):
        user = self.login({"settings": "edit", "settings.payroll.bonus": "view"})
        r = self.call(user, "put", "/api/payroll-settings", {"bonusPercent": 9})
        self.assertEqual(r.status_code, 403)
        self.assertEqual(self.call(user, "put", "/api/payroll-settings", {"basicPercent": 50}).status_code, 200)

    def test_a_report_group_can_be_hidden(self):
        user = self.login(
            {"reports": "view", "employees": "view", "attendance": "view", "reports.attendance": "hidden"}
        )
        body = self.call(user, "get", "/api/reports/catalog").json()
        categories = {c["id"] for c in body["categories"]}
        self.assertNotIn("attendance", categories)
        self.assertIn("employees", categories)


class ApprovalEnforcement(TestCase):
    @classmethod
    def setUpTestData(cls):
        cls.branch = Branch.objects.create(name="PT Unit", code="PTU")
        cls.emp = Employee.objects.create(
            employee_code="PA1", first_name="Arun", last_name="Approve", status="active", employment_type="staff",
            join_date="2020-01-01", branch=cls.branch,
        )  # fmt: skip

    def setUp(self):
        approval.clear_cache()
        self.addCleanup(approval.clear_cache)

    def login(self, permissions, approvals=None, category="hr_manager", overrides=None):
        n = HRUser.objects.count()
        role = Role.objects.create(name=f"PA role {n}", permissions=permissions, approvals=approvals)
        return HRUser.objects.create(
            username=f"pa_{n}", password_hash="x", role=role, category=category, permission_overrides=overrides or {}
        )

    def call(self, user, method, path, body=None):
        return getattr(self.client, method)(path, body or {}, content_type="application/json", **bearer(user))

    def request(self, kind):
        return EmployeeRequest.objects.create(
            employee=self.emp, request_type=kind, subject=f"{kind} please", description="-", status="pending"
        )

    def test_only_the_switched_on_request_type_can_be_decided(self):
        user = self.login({"requests": "edit"}, approvals={"request_salary_enquiry": True})
        ok = self.call(
            user, "put", f"/api/employee-requests/{self.request('salary_enquiry').id}/action", {"status": "approved"}
        )
        self.assertEqual(ok.status_code, 200, ok.content)
        no = self.call(
            user, "put", f"/api/employee-requests/{self.request('shift_correction').id}/action", {"status": "approved"}
        )
        self.assertEqual((no.status_code, no.json()["code"]), (403, "approval_not_permitted"))
        # the list says the same: per row, and "may approve some" for the kind
        rows = self.call(user, "get", "/api/hr-requests?kind=request").json()
        by_type = {i["id"]: i["approval"]["hrPermitted"] for i in rows["items"]}
        self.assertEqual(sorted(by_type.values()), [False, True])
        self.assertTrue(next(k for k in rows["kinds"] if k["key"] == "request")["canApprove"])

    def test_a_role_with_the_old_other_requests_switch_decides_every_type(self):
        user = self.login({"requests": "edit"}, approvals={"request": True})
        for kind in ("leave", "general", "advance"):
            r = self.call(user, "put", f"/api/employee-requests/{self.request(kind).id}/action", {"status": "rejected"})
            self.assertEqual(r.status_code, 200, kind)

    def test_general_and_term_advances_are_separate(self):
        user = self.login({"settlement": "edit"}, approvals={"advance_general": True, "advance_term": False})
        general = Advance.objects.create(employee=self.emp, amount=1000, advance_type="general", status="pending")
        term = Advance.objects.create(
            employee=self.emp, amount=9000, advance_type="term", status="pending", repayment_months=3
        )
        self.assertEqual(self.call(user, "put", f"/api/advances/{general.id}", {"status": "rejected"}).status_code, 200)
        r = self.call(user, "put", f"/api/advances/{term.id}", {"status": "rejected"})
        self.assertEqual((r.status_code, r.json()["code"]), (403, "approval_not_permitted"))

    def test_payroll_done_needs_its_own_switch_on_top_of_edit(self):
        off = self.login({"payroll": "edit"}, approvals={"payroll_finalize": False})
        r = self.call(off, "post", "/api/payroll/month-finalize", {"month": 10, "year": 2026})
        self.assertEqual((r.status_code, r.json()["code"]), (403, "approval_not_permitted"))
        self.assertFalse(
            self.call(off, "get", "/api/payroll/month-status?month=10&year=2026").json()["can"]["finalize"]
        )
        # never set on a role with switches: edit = may, as before (409 here: there is no payroll to finalize)
        before = self.login({"payroll": "edit"}, approvals={"leave": True})
        self.assertEqual(
            self.call(before, "post", "/api/payroll/month-finalize", {"month": 10, "year": 2026}).status_code, 409
        )

    def test_hold_and_mark_as_cleared_have_their_own_switches(self):
        p = Payroll.objects.create(
            employee=self.emp, salary_mode="monthly", month=9, year=2026, base_salary=1, gross_salary=1, final_salary=1
        )
        user = self.login({"payroll": "edit"}, approvals={"payroll_hold": False, "payroll_mark_cleared": False})
        self.assertEqual(self.call(user, "post", f"/api/payroll/{p.id}/hold", {"hold": True}).status_code, 403)
        self.assertEqual(self.call(user, "patch", f"/api/payroll/{p.id}", {"status": "paid"}).status_code, 403)
        self.assertEqual(self.call(user, "patch", f"/api/payroll/{p.id}", {"bonus": 5}).status_code, 200)  # an edit

    def test_bonus_and_interview_decisions_have_their_own_switches(self):
        bonus = Bonus.objects.create(
            employee=self.emp, financial_year="2025-26", records_considered=1, calculation_base=1,
            bonus_percent_applied=Decimal("8.33"), bonus_amount=1,
        )  # fmt: skip
        job = Job.objects.create(title="Tailor")
        applicant = Applicant.objects.create(job=job, name="Kavi", email="k@example.com", phone="1", status="applied")
        user = self.login(
            {"bonus": "edit", "recruitment": "edit"}, approvals={"bonus_status": False, "interview_result": False}
        )
        self.assertEqual(self.call(user, "patch", f"/api/bonus/{bonus.id}", {"status": "approved"}).status_code, 403)
        self.assertEqual(self.call(user, "patch", f"/api/bonus/{bonus.id}", {"notes": "ok"}).status_code, 200)
        r = self.call(user, "patch", f"/api/applicants/{applicant.id}/status", {"status": "selected"})
        self.assertEqual(r.status_code, 403)
        self.assertEqual(
            self.call(user, "patch", f"/api/applicants/{applicant.id}/status", {"status": "attended"}).status_code, 200
        )

    def test_an_assistant_never_approves_missing_punches(self):
        user = self.login(
            {"missing_punch": "edit"}, approvals={k: True for k in hr_access.APPROVAL_KEYS if k != "missing_punch"},
            category="hr_assistant",
        )  # fmt: skip
        self.assertFalse(hr_access.may_approve(user, "missing_punch"))
        self.assertTrue(hr_access.may_approve(user, "request_general") is False)  # requests hidden: nobody approves

    def test_the_starter_roles_are_still_sensible(self):
        manager = HRUser.objects.create(
            username="pa_starter_mgr",
            password_hash="x",
            category="hr_manager",
            role=Role.objects.get(name="HR Manager - default"),
        )
        assistant = HRUser.objects.create(
            username="pa_starter_asst",
            password_hash="x",
            category="hr_assistant",
            role=Role.objects.get(name="HR Assistant - default"),
        )
        mgr = hr_access.effective_approvals(manager)
        asst = hr_access.effective_approvals(assistant)
        # the Manager's old "Other requests" / "Advance" switches cover every request type and both advance types
        for key in hr_access.ALIASES["request"] + hr_access.ALIASES["advance"]:
            self.assertEqual(mgr[key], hr_access.may_approve(manager, key), key)
        self.assertTrue(all(mgr[k] for k in hr_access.ALIASES["request"]))
        self.assertTrue(mgr["missing_punch"] and mgr["attendance_correction"])
        # the Assistant: leave and permission only among the request kinds, never the locked ones
        self.assertTrue(asst["leave"] and asst["permission"])
        self.assertFalse(asst["missing_punch"] or asst["attendance_correction"])
        self.assertFalse(any(asst[k] for k in hr_access.ALIASES["request"]))

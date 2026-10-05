"""MD portal: Activity Logs (analytics/activity.py + routes/activity.py).

The fixtures are small and exact: every figure asserted here can be recomputed by hand from the data built in
``build_standard`` / ``build_sign_ins`` (the comments name each entry, A1..A10, B1..B3, P1..P5, S1.., so a failing
number can be traced to the rows that make it).

Calendar used throughout (factory dates, Asia/Kolkata): Monday 2026-09-28 .. Sunday 2026-10-04 is the period under
test, Monday 2026-09-21 .. Sunday 2026-09-27 the previous one. 2026-10-05 is a Monday.

Run with its own throwaway database:
    DB_TEST_NAME=test_uktex_activity python manage.py test api.tests_md_activity api.tests_md_tools_contract --noinput
"""

import json
import os
import re
import time as _time
import uuid
from datetime import date, datetime, timedelta, timezone as dt_timezone
from pathlib import Path
from unittest import mock

from django.db import connection
from django.test import SimpleTestCase, TestCase
from django.test.utils import CaptureQueriesContext

from .clock import FACTORY_TZ
from .jwt_utils import sign_token
from .md_portal.analytics import activity as A
from .md_portal.assistant import registry
from .md_portal.common import MdParamError, Period, read_only_db
from .md_portal.routes import activity as activity_routes
from .models import AuditLog, Branch, Employee, HRUser, HrLoginAttempt, LoginSession, Role
from .tests_md_support import MdApiTestCase, md_headers

URL = "/api/md/activity/"
WEEK = {"from": "2026-09-28", "to": "2026-10-04"}  # Monday..Sunday: the period under test
PREV_WEEK = {"from": "2026-09-21", "to": "2026-09-27"}
TODAY = date(2026, 10, 5)  # a Monday
EARLY = datetime(2026, 1, 1, 9, 0, tzinfo=FACTORY_TZ)  # when the fixture accounts were "created"


def ist(y, m, d, h=0, mi=0, s=0):
    """An aware datetime on the factory's clock."""
    return datetime(y, m, d, h, mi, s, tzinfo=FACTORY_TZ)


def utc(y, m, d, h=0, mi=0, s=0):
    return datetime(y, m, d, h, mi, s, tzinfo=dt_timezone.utc)


# ─── fixture builders ─────────────────────────────────────────────────────────────────────────────────────────


def log(when, user, action, module, desc=None, user_type="hr"):
    """One audit entry stamped ``when`` (created_at is auto_now_add, so it is set afterwards)."""
    row = AuditLog.objects.create(
        user_type=user_type, user_name=user, action=action, module=module, record_description=desc
    )
    AuditLog.objects.filter(pk=row.pk).update(created_at=when)
    return row


def burst(when, user, action, module, descs):
    """Many audit entries at the same instant, as a bulk upload writes them."""
    rows = AuditLog.objects.bulk_create(
        [AuditLog(user_type="hr", user_name=user, action=action, module=module, record_description=d) for d in descs]
    )
    AuditLog.objects.filter(pk__in=[r.pk for r in rows]).update(created_at=when)
    return rows


def session(user, when, device="Chrome on Windows", revoked=None):
    s = LoginSession.objects.create(hr_user=user, jti=uuid.uuid4().hex, device_label=device)
    LoginSession.objects.filter(pk=s.pk).update(created_at=when, last_seen_at=when, revoked_at=revoked)
    return s


def attempt(username, when, ok=False):
    a = HrLoginAttempt.objects.create(username=username, success=ok)
    HrLoginAttempt.objects.filter(pk=a.pk).update(created_at=when)
    return a


def account(username, full_name=None, role=None, created=EARLY, **flags):
    user = HRUser.objects.create(username=username, full_name=full_name, password_hash="x", role=role, **flags)
    HRUser.objects.filter(pk=user.pk).update(created_at=created)
    return user


def tidy_md(md):
    """The MD account of MdApiTestCase, made a stable old account (its real created_at is 'now')."""
    HRUser.objects.filter(pk=md.pk).update(created_at=EARLY, last_login=ist(2026, 10, 3, 9))


def build_standard(cls):
    """The audit scenario most tests read. See the module docstring for the calendar."""
    cls.payroll_role = Role.objects.create(name="Payroll Officer", permissions={"payroll": "edit", "employees": "view"})
    cls.exec_role = Role.objects.create(name="HR Executive", permissions={"employees": "view"})
    cls.anita = account("anita", "Anita Rao", cls.payroll_role)
    cls.babu = account("babu", "Babu K", cls.exec_role)
    cls.chandra = account("chandra", "Chandra S", is_super_admin=True)

    # ── the period under test: Mon 2026-09-28 .. Sun 2026-10-04 ────────────────────────────────────────────────
    # 00:00:00 IST on Monday is 18:30 UTC on Sunday: the first instant of the period, given in UTC on purpose.
    log(utc(2026, 9, 27, 18, 30), "Chandra S", "update", "employees", "Updated employee E6 -K L")  # A10 night
    log(ist(2026, 9, 28, 10), "Anita Rao", "update", "employees", "Updated employee E1 -A B")  # A1
    log(ist(2026, 9, 28, 11), "Anita Rao", "create", "employees", "Created employee E2 -C D")  # A2
    log(  # A3 payroll-generated (high)
        ist(2026, 9, 29, 9, 30),
        "Anita Rao",
        "create",
        "payroll",
        "Generated staff payroll 9/2026 -250 generated, 0 skipped",
    )
    log(ist(2026, 9, 29, 23, 15), "Babu K", "update", "employees", "Updated employee E3 -E F")  # A4 night
    log(  # A5 account-changed (high), night
        ist(2026, 9, 30, 6, 30), "Chandra S", "update", "user_management", "Updated HR user: babu"
    )
    log(  # A6 md-assigned (critical)
        ist(2026, 10, 1, 14), "Chandra S", "update", "user_management", "Assigned MD: md_test"
    )
    log(  # A7 employee-deleted (high)
        ist(2026, 10, 2, 10), "Babu K", "delete", "employees", "Deleted employee E9 -X Y"
    )
    log(  # A8 report-export (medium); 20:59:59 is still working hours
        ist(2026, 10, 3, 20, 59, 59), "Anita Rao", "export", "reports", "Salary Register - XLSX - 250 rows"
    )
    log(ist(2026, 10, 4, 11), "Babu K", "update", "employees", "Updated employee E4 -G H")  # A9 Sunday
    # one upload, three kinds of change, all in the same minute: B1 120 imports, B2 30 pay changes, B3 20 updates
    at = ist(2026, 10, 2, 16, 10)
    burst(at, "Anita Rao", "create", "employees", [f"Bulk-imported employee C{i} -N{i} X" for i in range(120)])  # B1
    burst(  # B2 bulk-pay-change (high)
        at,
        "Anita Rao",
        "update",
        "employees",
        [f"Bulk-updated employee P{i} -changed Salary Amount" for i in range(30)],
    )
    burst(  # B3 bulk-update (medium)
        at, "Anita Rao", "update", "employees", [f"Bulk-updated employee Q{i} -changed First Name" for i in range(20)]
    )
    # sign-in entries: never actions
    log(ist(2026, 9, 28, 9), "Anita Rao", "login", "auth", "Anita Rao (anita) logged in")
    log(ist(2026, 9, 29, 8, 55), "system", "login_failed", "auth", "Failed login for: anita")
    log(ist(2026, 9, 29, 12), "system", "login_blocked", "auth", "Locked-out login attempt for: ghost")
    # just outside the period: 00:00:00 IST on Monday 2026-10-05, and well before the previous period
    log(utc(2026, 10, 4, 18, 30), "Babu K", "update", "employees", "Updated employee E5 -I J")  # X1
    log(ist(2026, 9, 10, 10), "Anita Rao", "update", "employees", "Updated employee E7 -M N")  # O1

    # ── the previous period: Mon 2026-09-21 .. Sun 2026-09-27 ─────────────────────────────────────────────────
    log(ist(2026, 9, 21, 10), "Anita Rao", "update", "employees", "Updated employee E1 -A B")  # P1
    log(ist(2026, 9, 22, 10), "Anita Rao", "update", "employees", "Updated employee E2 -C D")  # P2
    log(ist(2026, 9, 23, 11), "Babu K", "delete", "employees", "Deleted employee E8 -P Q")  # P3 high
    log(ist(2026, 9, 27, 10), "Babu K", "update", "employees", "Updated employee E3 -E F")  # P4 Sunday
    log(
        ist(2026, 9, 27, 23, 59, 59), "Babu K", "update", "employees", "Updated employee E4 -G H"
    )  # P5 Sunday, last second

    # ── sign-ins (login sessions) ─────────────────────────────────────────────────────────────────────────────
    session(cls.anita, ist(2026, 9, 22, 9))  # S0 previous period
    session(cls.anita, ist(2026, 9, 28, 9))  # S1
    session(cls.babu, ist(2026, 9, 29, 8))  # S3
    session(cls.babu, ist(2026, 9, 29, 10), "Firefox on Windows")  # S4: a second device, while S3 is still open
    session(cls.chandra, ist(2026, 9, 20, 8))  # H0 history before the previous period
    session(cls.chandra, ist(2026, 9, 30, 8))  # S5
    session(cls.anita, ist(2026, 10, 1, 9))  # S2
    session(cls.chandra, ist(2026, 10, 3, 22), "Safari on iPhone")  # S6 a new device for a super admin
    # the MD's own sign-in is made in a test (it needs the MD account, which exists per test), see Standard.setUp

    # ── sign-in attempts ──────────────────────────────────────────────────────────────────────────────────────
    attempt("anita", ist(2026, 9, 29, 8, 55))
    attempt("anita", ist(2026, 9, 29, 8, 56))
    attempt("anita", ist(2026, 9, 29, 8, 57), ok=True)
    for minute in (0, 1, 2):
        attempt("ghost", ist(2026, 9, 30, 10, minute))
    attempt("babu", ist(2026, 10, 1, 9))
    attempt("anita", ist(2026, 9, 21, 9))  # previous period


class Standard(MdApiTestCase):
    """Base for the tests that read the standard scenario."""

    @classmethod
    def setUpTestData(cls):
        build_standard(cls)

    def setUp(self):
        super().setUp()
        tidy_md(self.md)
        session(self.md, ist(2026, 10, 2, 8))  # S7 the MD signs in on Friday

    def api(self, name, **params):
        r = self.get(URL + name, **params)
        self.assertEqual(r.status_code, 200, r.content[:400])
        return r.json()


# ═══ the rule table ════════════════════════════════════════════════════════════════════════════════════════════

#: (action, module, description, the rule that must decide it or None for routine). The descriptions are what the
#: application writes today (grep log_action / build_log_entry) plus the pay modules it may start auditing.
CORPUS = [
    # accounts and access
    ("update", "user_management", "Assigned MD: md.sir", "md-assigned"),
    ("update", "user_management", "ASSIGNED md: md.sir", "md-assigned"),
    ("update", "user_management", "Removed MD access from: md.sir", "md-removed"),
    ("update", "user_management", "Removed MD access from: md.sir (replaced by director2)", "md-removed"),
    ("delete", "user_management", "Deleted HR user: ravi", "account-deleted"),
    ("delete", "user_management", "Deleted role: Clerk", "account-deleted"),
    ("update", "user_management", "Master: ravi -> hidden", "account-master"),
    ("create", "user_management", "Created role: Auditor", "role-changed"),
    ("update", "user_management", "Updated role: 100%_off", "role-changed"),
    ("create", "user_management", "Created HR user: ravi", "account-created"),
    ("update", "user_management", "Updated HR user: ravi", "account-changed"),
    ("update", "mobile_app_login", "Cleared mobile app password for E1 (A B)", "app-password"),
    ("update", "mobile_app_login", "Reset mobile app password for E1 (A B)", "app-password"),
    ("update", "mobile_app_login", "Set mobile app password for E1 (A B)", "app-password"),
    # backup and restore
    ("restore", "settings", "Automated restore started from /tmp/x.zip", "restore-started"),
    ("upload", "settings", "Restore backup uploaded + validated: x.zip", "restore-uploaded"),
    ("update", "settings", "Backup schedule updated", "backup-config"),
    ("update", "settings", "Backup Google Drive config updated", "backup-config"),
    ("backup", "settings", "Full backup created: x.zip (1234 bytes)", "backup-created"),
    # settings and workflow
    ("update", "approval_workflow", "Leave: HOD, then HR (switched OFF)", "workflow-changed"),
    ("reset", "approval_workflow", "Leave: back to the built-in pipeline", "workflow-changed"),
    ("update", "settings", "Universal settings updated", "settings-universal"),
    ("update", "settings", "Personal settings updated (3 field(s) overridden)", "settings-personal"),
    ("update", "settings", "Changed portal theme to 'ocean'", None),
    ("create", "mobile_app_version", "Published mobile app version 3.2", "app-version"),
    ("update", "mobile_app_version", "Updated mobile app version 3.2", "app-version"),
    ("delete", "mobile_app_version", "Deleted mobile app version 3.1", "record-deleted"),
    # payroll and pay
    ("create", "payroll", "Generated staff payroll 9/2026 -250 generated, 0 skipped", "payroll-generated"),
    ("create", "payroll", "Generated production payroll 2026-09-01-2026-09-15 -90 generated", "payroll-generated"),
    ("approve", "payroll", "Approved payroll 9/2026", "payroll-finalised"),
    ("lock", "production_payroll", "Locked production payroll", "payroll-finalised"),
    ("update", "salary", "Edited salary record 12", "pay-record-changed"),
    ("create", "increment", "Added increment", "pay-record-changed"),
    ("create", "promotion", "Promoted E1", "pay-record-changed"),
    ("create", "bonus", "Generated bonus register for FY 2025-26 -240 eligible employee(s)", "bonus-generated"),
    ("announce", "compensation", "Announced 12 OT record(s) as pay", "overtime-decided"),
    ("reject", "compensation", "Rejected 3 OT record(s)", "overtime-decided"),
    ("redeem", "compensation", "Redeemed Alternative Day for E1 on 2026-09-01", None),
    ("create", "compensation", "Announced Compensation Day for 2026-09-20", None),
    ("delete", "compensation", "Removed Compensation Day announcement", "record-deleted"),
    ("update", "employees", "Bulk-updated employee E1 -changed Salary Amount", "bulk-pay-change"),
    ("update", "employees", "Bulk-updated employee E1 -changed Bank Account", "bulk-pay-change"),
    ("update", "employees", "Bulk-updated employee E1 -changed PF Number", "bulk-pay-change"),
    ("update", "employees", "Bulk-updated employee E1 -changed Salary Split, Department", "bulk-pay-change"),
    ("update", "employees", "bulk-updated EMPLOYEE E1 -changed SALARY AMOUNT", "bulk-pay-change"),
    ("update", "employees", "Bulk-updated employee E1 -changed First Name, Phone", "bulk-update"),
    # deletions
    ("delete", "employees", "Deleted employee E9 -X Y (not in the bulk-update file)", "bulk-delete"),
    ("delete", "employees", "Deleted employee E9 -X Y", "employee-deleted"),
    # bulk changes
    ("update", "employees", "Made E9 -X Y Inactive (not in the bulk-update file)", "bulk-inactive"),
    ("create", "employees", "Bulk-imported employee E10 -A B", "bulk-import"),
    ("update", "employees", "Bulk enabled live location tracking for 12 employee(s)", "bulk-tracking"),
    ("update", "employees", "Bulk disabled live location tracking for 12 employee(s)", "bulk-tracking"),
    ("update", "attendance", "Punch View import: 10 updated, 2 created, 0 rejected", "punch-import"),
    # exports
    ("export", "reports", "Salary Register - XLSX - 250 rows - {}", "report-export"),
    ("export", "bonus", "Exported bonus register for FY 2025-26 (240 record(s))", "data-export"),
    ("export", "attendance", "Exported 120 punches", "data-export"),
    ("export", "mobile_app_login", "Exported 90 staff (all) from Mobile App Login", "data-export"),
    # routine: nothing sensitive
    ("create", "employees", "Created employee E1 -A B", None),
    ("update", "employees", "Updated employee E1 -A B", None),
    ("update", "employees", None, None),
    ("update", "attendance", "Resolved unmatched device ID 77", None),
    ("approve", "leave", "Approved leave 12", None),
    ("login", "auth", "Anita (anita) logged in", None),
    ("login_failed", "auth", "Failed login for: anita", None),
    ("login_blocked", "auth", "Locked-out login attempt for: anita", None),
    ("something_new", "a_module_nobody_wrote_yet", "whatever", None),
]


class RuleTableTests(SimpleTestCase):
    def test_the_table_is_well_formed(self):
        ids = [r.id for r in A.RULES]
        self.assertEqual(len(ids), len(set(ids)), "rule ids are unique")
        for r in A.RULES:
            with self.subTest(rule=r.id):
                self.assertIn(r.category, A.CATEGORIES)
                self.assertIn(r.severity, A.SEVERITIES)
                self.assertTrue(r.title and r.title[0].isupper(), "a plain-English title")
                self.assertTrue(r.actions or r.modules or r.starts or r.has or r.has_any, "has a condition")
        self.assertEqual(
            set(A.BURST_RULE_IDS), {"bulk-pay-change", "bulk-delete", "bulk-inactive", "bulk-import", "bulk-update"}
        )
        self.assertTrue(all(A.RULES_BY_ID[i].modules == ("employees",) for i in A.BURST_RULE_IDS))
        for category in A.CATEGORIES:
            self.assertTrue(any(r.category == category for r in A.RULES), f"{category} has rules")

    def test_the_real_vocabulary_is_classified_as_documented(self):
        for action, module, description, expected in CORPUS:
            with self.subTest(description=description, module=module):
                rule = A.classify(action, module, description)
                self.assertEqual(rule.id if rule else None, expected)

    def test_priority_decides_between_rules_that_both_match(self):
        # a bulk upload that deletes employees is critical, not just "an employee was deleted" or "bulk change"
        deleted = A.classify("delete", "employees", "Deleted employee E1 -A B (not in the bulk-update file)")
        self.assertEqual((deleted.id, deleted.severity, deleted.burst), ("bulk-delete", "critical", True))
        # pay fields change the verdict of a bulk update
        self.assertEqual(
            A.classify("update", "employees", "Bulk-updated employee E1 -changed Bank Name").severity, "high"
        )
        self.assertEqual(
            A.classify("update", "employees", "Bulk-updated employee E1 -changed Email").severity, "medium"
        )
        # a pay-module delete is a pay change, an employee delete is a deletion
        self.assertEqual(A.classify("delete", "salary", "x").category, "payroll")
        self.assertEqual(A.classify("delete", "employees", "x").category, "deletion")

    def test_every_severity_and_category_label_is_plain_english(self):
        self.assertEqual(set(A.SEVERITY_LABELS), set(A.SEVERITIES))
        table = A.rule_table()
        self.assertEqual(len(table), len(A.RULES))
        self.assertEqual(table[0]["category"], "access")  # categories in the order the screen lists them
        self.assertEqual(table[0]["severity"], "critical")  # most severe first inside a category

    def test_the_areas_cover_every_module_the_application_audits(self):
        self.assertEqual(A.area_of("employees"), ("employees", "Employees"))
        self.assertEqual(A.area_of("production_payroll")[1], "Payroll & pay")
        self.assertEqual(A.area_of("bonus")[0], "payroll")
        self.assertEqual(A.area_of("user_management")[1], "Accounts & access")
        self.assertEqual(A.area_of("some_new_module"), ("other:some_new_module", "Some new module"))  # never dropped
        self.assertEqual(A.area_of(None)[1], "Other")
        modules_in_mapping = {m for entry in A.area_mapping() for m in entry["modules"]}
        self.assertEqual(modules_in_mapping, set(A.AREAS))

    def test_working_hours_are_a_documented_rule(self):
        self.assertEqual(A.working_hours()["label"], "7 am to 9 pm, Monday to Saturday")
        self.assertEqual(A.working_hours()["weeklyOff"], "Sunday")
        monday, sunday = date(2026, 10, 5), date(2026, 10, 4)
        self.assertEqual(
            [A._after_kind(monday, h) for h in (0, 6, 7, 12, 20, 21, 23)],
            ["night", "night", None, None, None, "night", "night"],
        )
        self.assertEqual({A._after_kind(sunday, h) for h in range(24)}, {"weekend"})  # the whole of Sunday


class RuleParityTests(TestCase):
    """The database classifies with a CASE expression, the tests with ``classify``: they must never disagree."""

    def test_the_database_and_python_decide_the_same(self):
        for action, module, description, _expected in CORPUS:
            AuditLog.objects.create(user_name="x", action=action, module=module, record_description=description)
        decided = {
            (r["action"], r["module"], r["record_description"]): r["rule"]
            for r in AuditLog.objects.annotate(rule=A._rule_case()).values(
                "action", "module", "record_description", "rule"
            )
        }
        self.assertEqual(len(decided), len(CORPUS))
        for action, module, description, expected in CORPUS:
            with self.subTest(description=description, module=module):
                self.assertEqual(decided[(action, module, description)], expected or "")

    def test_like_wildcards_in_what_people_type_are_not_wildcards(self):
        log(ist(2026, 9, 29, 10), "Anita Rao", "update", "user_management", "Updated role: 100%_off")
        log(ist(2026, 9, 29, 11), "Anita Rao", "update", "user_management", "Updated role: Clerk")
        period = Period(date(2026, 9, 28), date(2026, 10, 4), "custom", "28 Sep – 04 Oct 2026")
        total = lambda q: A.activity_sensitive(period, q=q)["total"]  # noqa: E731
        self.assertEqual(total("100%"), 1)
        self.assertEqual(total("%"), 1)  # only the entry that really contains a percent sign
        self.assertEqual(total("_off"), 1)
        self.assertEqual(total("role: Clerk"), 1)
        self.assertEqual(total("role: C_erk"), 0)  # '_' is a character, not "any character"


class VocabularyGuardTests(SimpleTestCase):
    """The rule table is built from what the application writes. If someone starts auditing a new module or action,
    this fails and says where to decide whether it is sensitive (the rule table) and what it is called (AREAS)."""

    CALL = re.compile(r"\b(?:log_action|build_log_entry|_log)\(\s*request,\s*\"(\w+)\",\s*\"(\w+)\"", re.S)
    KNOWN_ACTIONS = {
        "login", "logout", "login_failed", "login_blocked", "create", "update", "delete", "export", "approve",
        "reject", "upload", "restore", "backup", "announce", "redeem", "lock", "reset",
    }  # fmt: skip

    def audited(self):
        api = Path(__file__).resolve().parent
        found = set()
        for path in list(api.glob("*.py")) + list((api / "reporting").glob("views.py")):
            if path.name.startswith("tests") or path.name == "audit_utils.py":
                continue
            for action, module in self.CALL.findall(path.read_text(encoding="utf-8", errors="ignore")):
                found.add((action, module, path.name))
        return found

    def test_the_audit_callers_were_found(self):
        self.assertGreater(len(self.audited()), 25, "the scan should see the application's audit calls")

    def test_every_audited_module_has_an_area(self):
        missing = sorted({m for _a, m, f in self.audited() if m not in A.AREAS})
        self.assertEqual(
            missing,
            [],
            "add these audit modules to AREAS in analytics/activity.py (and to the rule table if sensitive)",
        )

    def test_every_audited_action_is_a_known_one(self):
        unknown = sorted({(a, f) for a, _m, f in self.audited() if a not in self.KNOWN_ACTIONS})
        self.assertEqual(unknown, [], "decide whether these actions are sensitive: analytics/activity.py RULES")


# ═══ the headline figures ══════════════════════════════════════════════════════════════════════════════════════


class SummaryTests(Standard):
    def test_the_figures_of_the_week_recomputed_by_hand(self):
        s = self.api("summary", **WEEK)
        # events: A1 A2 A4 A9 A10 (routine) + A3 A5 A6 A7 A8 (sensitive) + three bulk kinds (B1 B2 B3, one each) = 13
        self.assertEqual(s["actions"]["value"], 13)
        self.assertEqual(s["actions"]["previous"], 5)  # P1..P5
        self.assertEqual(s["actions"]["change"], {"abs": 8, "pct": 160.0})
        # sensitive: critical A6; high A3 A5 A7 B2; medium A8 B1 B3
        self.assertEqual(
            {k: s["sensitive"][k] for k in ("value", "critical", "high", "medium", "previous")},
            {"value": 8, "critical": 1, "high": 4, "medium": 3, "previous": 1},  # previous: P3 only
        )
        # after hours: A4 (Tue 23:15) A5 (Wed 06:30) A10 (Mon 00:00) at night, A9 on Sunday
        self.assertEqual(
            {k: s["afterHours"][k] for k in ("value", "weekend", "night", "previous", "sharePct")},
            {"value": 4, "weekend": 1, "night": 3, "previous": 2, "sharePct": 30.8},  # 4 of 13; P4 P5 were Sunday
        )
        # people: Anita Rao, Babu K, Chandra S act; with the MD's sign-in that is four; previous: Anita + Babu
        self.assertEqual((s["activeUsers"]["value"], s["activeUsers"]["previous"]), (4, 2))
        self.assertEqual(s["activeUsers"]["enabledAccounts"], 4)  # anita babu chandra + the MD
        # sign-ins: S1 S2 S3 S4 S5 S6 S7 = 7; previous S0 only (H0 is before the previous period)
        self.assertEqual((s["signIns"]["value"], s["signIns"]["previous"], s["signIns"]["people"]), (7, 1, 4))
        # failed: anita x2 + ghost x3 + babu x1 = 6; previous anita x1. One blocked attempt in the audit trail.
        f = s["failedSignIns"]
        self.assertEqual((f["value"], f["previous"], f["lockouts"], f["blockedAttempts"]), (6, 1, 0, 1))
        self.assertEqual(s["period"]["days"], 7)
        self.assertEqual((s["previousPeriod"]["start"], s["previousPeriod"]["end"]), ("2026-09-21", "2026-09-27"))
        self.assertEqual(s["workingHours"]["startHour"], 7)
        self.assertEqual(s["notes"], [])

    def test_the_period_edges_are_inclusive_and_in_factory_time(self):
        # A10 is 00:00:00 IST Monday (18:30 UTC Sunday): inside. X1 is 00:00:00 IST the next Monday: outside.
        self.assertEqual(self.api("summary", **WEEK)["actions"]["value"], 13)
        monday_only = self.api("summary", **{"from": "2026-09-28", "to": "2026-09-28"})
        self.assertEqual(monday_only["actions"]["value"], 3)  # A10 A1 A2
        sunday_only = self.api("summary", **{"from": "2026-10-04", "to": "2026-10-04"})
        self.assertEqual(sunday_only["actions"]["value"], 1)  # A9; X1 belongs to Monday 5 October
        monday_after = self.api("summary", **{"from": "2026-10-05", "to": "2026-10-05"})
        self.assertEqual(monday_after["actions"]["value"], 1)  # X1
        self.assertEqual(monday_after["actions"]["previous"], 1)  # Sunday 4 October: A9

    def test_sign_in_entries_are_not_actions(self):
        # the audit trail holds a login, a failed login and a blocked login in this period; none is an action
        self.assertEqual(self.api("summary", **WEEK)["actions"]["value"], 13)
        names = {u["userName"] for u in self.api("users", **WEEK)["users"]}
        self.assertNotIn("system", names)  # failed and blocked sign-ins are logged under "system"

    def test_a_period_crossing_a_month_and_year_boundary(self):
        log(ist(2025, 12, 31, 23, 30), "Anita Rao", "update", "employees", "Updated employee E1 -A B")
        log(ist(2026, 1, 1, 0, 30), "Anita Rao", "update", "employees", "Updated employee E1 -A B")
        log(ist(2026, 1, 2, 9), "Babu K", "delete", "employees", "Deleted employee E2 -C D")
        log(ist(2025, 12, 26, 9), "Babu K", "update", "employees", "Updated employee E3 -E F")  # previous period
        s = self.api("summary", **{"from": "2025-12-30", "to": "2026-01-03"})
        self.assertEqual((s["actions"]["value"], s["actions"]["previous"]), (3, 1))  # previous: 25 Dec .. 29 Dec
        self.assertEqual(s["previousPeriod"]["start"], "2025-12-25")
        self.assertEqual(s["sensitive"]["value"], 1)
        trend = self.api("trend", **{"from": "2025-12-30", "to": "2026-01-03"})
        self.assertEqual([p["date"] for p in trend["points"]][:3], ["2025-12-30", "2025-12-31", "2026-01-01"])
        self.assertEqual([p["actions"] for p in trend["points"]], [0, 1, 1, 1, 0])

    def test_the_provenance_explains_every_figure_and_the_gaps_in_the_audit_trail(self):
        s = self.api("summary", **WEEK)
        ids = {p["id"] for p in s["provenance"]}
        self.assertEqual(ids, {"actions", "active-users", "sensitive", "after-hours", "sign-ins", "failed-sign-ins"})
        actions = next(p for p in s["provenance"] if p["id"] == "actions")
        self.assertEqual(actions["rows"], 180)  # 10 + 170 audit rows: the upload's 170 rows are three actions
        self.assertIn("a bulk upload", actions["formula"])
        self.assertTrue(any("increments, promotions, payroll approvals" in c for c in actions["caveats"]))
        failed = next(p for p in s["provenance"] if p["id"] == "failed-sign-ins")
        self.assertIn("5 failed attempts in a row within 15 minutes", failed["definition"])

    def test_two_accounts_with_the_same_name_count_once_and_are_flagged_in_the_people_table(self):
        account("anita2", "Anita Rao")
        users = self.api("users", **WEEK)
        self.assertEqual(
            users["notes"], ["More than one account shares a name in this list, so their activity is shown together."]
        )
        self.assertNotIn("Anita", " ".join(users["notes"]))  # a note is free text: it must not carry a name
        anita = next(u for u in users["users"] if u["userName"] == "Anita Rao")
        self.assertIsNone(anita["role"])  # which of the two? unknown, so no role is claimed


# ═══ trend, areas, people, heatmap ════════════════════════════════════════════════════════════════════════════


class TrendTests(Standard):
    def test_one_point_per_day_with_every_series(self):
        t = self.api("trend", **WEEK)
        self.assertEqual(t["granularity"], "day")
        days = {p["date"]: p for p in t["points"]}
        self.assertEqual(list(days), [f"2026-09-{d}" for d in (28, 29, 30)] + [f"2026-10-0{d}" for d in (1, 2, 3, 4)])
        by_day = lambda key: [days[d][key] for d in days]  # noqa: E731
        self.assertEqual(
            by_day("actions"), [3, 2, 1, 1, 4, 1, 1]
        )  # A10+A1+A2 | A3+A4 | A5 | A6 | A7+B1+B2+B3 | A8 | A9
        self.assertEqual(by_day("sensitive"), [0, 1, 1, 1, 4, 1, 0])
        self.assertEqual(by_day("afterHours"), [1, 1, 1, 0, 0, 0, 1])
        self.assertEqual(by_day("signIns"), [1, 2, 1, 1, 1, 1, 0])  # S1 | S3 S4 | S5 | S2 | S7 | S6
        self.assertEqual(by_day("failedSignIns"), [0, 2, 3, 1, 0, 0, 0])  # anita x2 | ghost x3 | babu
        # people: Mon Chandra+Anita, Tue Anita+Babu, Wed Chandra, Thu Chandra+Anita(sign-in), Fri Babu+Anita+MD, Sat Anita+Chandra, Sun Babu
        self.assertEqual(by_day("activeUsers"), [2, 2, 1, 2, 3, 2, 1])
        self.assertEqual(t["total"], {"actions": 13, "sensitive": 8})
        self.assertEqual(t["busiest"], {"date": "2026-10-02", "end": "2026-10-02", "actions": 4})
        self.assertEqual(t["averagePerDay"], 1.9)  # 13 / 7

    def test_long_periods_roll_up_to_monday_to_sunday_weeks_clipped_to_the_period(self):
        # 2026-07-01 is a Wednesday; the first bucket is clipped to it and ends on its Sunday, the 5th
        log(ist(2026, 7, 1, 10), "Anita Rao", "update", "employees", "Updated employee E1 -A B")
        log(ist(2026, 7, 5, 22), "Anita Rao", "update", "employees", "Updated employee E1 -A B")  # Sunday
        log(ist(2026, 7, 6, 8), "Anita Rao", "delete", "employees", "Deleted employee E1 -A B")  # next Monday
        t = self.api("trend", **{"from": "2026-07-01", "to": "2026-10-04"})  # 96 days
        self.assertEqual(t["granularity"], "week")
        first, second = t["points"][0], t["points"][1]
        self.assertEqual((first["date"], first["end"], first["actions"]), ("2026-07-01", "2026-07-05", 2))
        self.assertEqual(
            (second["date"], second["end"], second["actions"], second["sensitive"]), ("2026-07-06", "2026-07-12", 1, 1)
        )
        last = t["points"][-1]
        self.assertEqual((last["date"], last["end"]), ("2026-09-28", "2026-10-04"))
        self.assertEqual(last["actions"], 13)
        self.assertEqual(len(t["points"]), 14)  # weeks of 29 Jun .. 28 Sep
        # the three rows above, the week under test (13), the previous week (P1..P5 = 5) and O1 (10 September)
        self.assertEqual(t["total"]["actions"], 3 + 13 + 5 + 1)
        self.assertEqual(sum(p["actions"] for p in t["points"]), t["total"]["actions"], "the weeks add up to the whole")

    def test_a_period_of_exactly_62_days_is_still_daily_and_63_is_weekly(self):
        daily = self.api("trend", **{"from": "2026-08-04", "to": "2026-10-04"})  # 62 days
        weekly = self.api("trend", **{"from": "2026-08-03", "to": "2026-10-04"})  # 63 days
        self.assertEqual((daily["granularity"], len(daily["points"])), ("day", 62))
        self.assertEqual(weekly["granularity"], "week")

    def test_an_empty_stretch_is_zeros_and_no_average(self):
        t = self.api("trend", **{"from": "2026-06-01", "to": "2026-06-03"})
        self.assertEqual([p["actions"] for p in t["points"]], [0, 0, 0])
        self.assertIsNone(t["averagePerDay"])
        self.assertIsNone(t["busiest"])
        self.assertEqual(t["notes"], ["Nothing was recorded for 01 Jun – 03 Jun 2026."])


class AreaTests(Standard):
    def test_actions_by_area_with_the_previous_period_alongside(self):
        r = self.api("modules", **WEEK)
        areas = {a["area"]: a for a in r["areas"]}
        self.assertEqual(
            [a["label"] for a in r["areas"]], ["Employees", "Accounts & access", "Payroll & pay", "Reports & exports"]
        )
        self.assertEqual(
            {k: areas["employees"][k] for k in ("actions", "sharePct", "sensitive", "previous", "people", "change")},
            {
                "actions": 9,
                "sharePct": 69.2,
                "sensitive": 4,
                "previous": 5,
                "people": 3,
                "change": {"abs": 4, "pct": 80.0},
            },
        )
        self.assertEqual(
            (areas["access"]["actions"], areas["access"]["sensitive"], areas["access"]["people"]), (2, 2, 1)
        )
        self.assertEqual(areas["payroll"]["change"], {"abs": 1, "pct": None})  # nothing before: no percentage
        self.assertEqual((r["total"], r["previousTotal"]), (13, 5))
        self.assertAlmostEqual(sum(a["sharePct"] for a in r["areas"]), 100.0, delta=0.2)

    def test_an_area_that_vanished_is_still_shown_with_what_it_was(self):
        log(ist(2026, 9, 24, 10), "Anita Rao", "create", "recruitment", "Created job")  # previous period only
        r = self.api("modules", **WEEK)
        recruitment = next(a for a in r["areas"] if a["area"] == "recruitment")
        self.assertEqual((recruitment["actions"], recruitment["previous"], recruitment["sharePct"]), (0, 1, 0.0))
        self.assertEqual(recruitment["change"], {"abs": -1, "pct": -100.0})

    def test_an_unmapped_module_keeps_its_own_name(self):
        log(ist(2026, 9, 30, 10), "Anita Rao", "update", "brand_new_module", "x")
        labels = [a["label"] for a in self.api("modules", **WEEK)["areas"]]
        self.assertIn("Brand new module", labels)

    def test_the_mapping_is_documented_in_the_provenance(self):
        p = self.api("modules", **WEEK)["provenance"][0]
        self.assertEqual(p["id"], "areas")
        self.assertIn("Payroll & pay = payroll, production_payroll", p["definition"])


class UserTests(Standard):
    def test_the_leaderboard_with_share_sensitive_after_hours_and_last_activity(self):
        r = self.api("users", **WEEK)
        self.assertEqual(
            [u["userName"] for u in r["users"]], ["Anita Rao", "Babu K", "Chandra S"]
        )  # 7, then 3 and 3 by name
        anita, babu, chandra = r["users"]
        self.assertEqual(
            anita,
            {
                "userName": "Anita Rao", "role": "Payroll Officer", "actions": 7, "sharePct": 53.8, "sensitive": 5,
                "afterHours": 0, "signIns": 2, "lastActive": "2026-10-03T20:59:59", "topArea": "Employees",
                "previous": 2, "change": {"abs": 5, "pct": 250.0},
            },
        )  # fmt: skip
        self.assertEqual((babu["actions"], babu["sensitive"], babu["afterHours"], babu["signIns"]), (3, 1, 2, 2))
        self.assertEqual(
            (babu["lastActive"], babu["role"], babu["change"]),
            ("2026-10-04T11:00:00", "HR Executive", {"abs": 0, "pct": 0.0}),
        )
        self.assertEqual(
            (chandra["role"], chandra["topArea"], chandra["previous"]), ("Super admin", "Accounts & access", 0)
        )
        self.assertEqual(chandra["change"], {"abs": 3, "pct": None})
        self.assertEqual((r["totalPeople"], r["total"], r["others"]), (3, 13, None))

    def test_the_limit_shows_the_rest_as_one_line_and_is_clamped(self):
        r = self.api("users", limit=2, **WEEK)
        self.assertEqual([u["userName"] for u in r["users"]], ["Anita Rao", "Babu K"])
        self.assertEqual(r["others"], {"people": 1, "actions": 3})
        self.assertEqual(len(self.api("users", limit=0, **WEEK)["users"]), 1)  # at least one
        self.assertEqual(A._clamp(500, 1, A.RANKED_LIMIT_MAX, 10), 25)  # at most 25
        self.assertEqual(A._clamp(None, 1, 25, 10), 10)

    def test_a_person_with_no_account_has_no_role(self):
        log(ist(2026, 9, 30, 10), "Former Employee", "update", "employees", "Updated employee E1 -A B")
        row = next(u for u in self.api("users", **WEEK)["users"] if u["userName"] == "Former Employee")
        self.assertIsNone(row["role"])

    def test_the_system_actor_is_not_a_person(self):
        log(ist(2026, 9, 30, 10), "system", "update", "settings", "Universal settings updated")
        r = self.api("users", **WEEK)
        self.assertEqual(r["totalPeople"], 3)
        self.assertEqual(self.api("summary", **WEEK)["activeUsers"]["value"], 4)  # system is not an active user


class HeatmapTests(Standard):
    def test_weekday_by_hour_in_factory_time(self):
        h = self.api("heatmap", **WEEK)
        self.assertEqual(
            (h["rows"], h["hours"][0], h["hours"][-1]), (["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"], 0, 23)
        )
        cell = lambda day, hour: h["values"][h["rows"].index(day)][hour]  # noqa: E731
        self.assertEqual(cell("Mon", 0), 1)  # A10: Sunday 18:30 UTC is Monday 00:00 in Tirupur
        self.assertEqual((cell("Mon", 10), cell("Mon", 11), cell("Tue", 9), cell("Tue", 23)), (1, 1, 1, 1))
        self.assertEqual(
            (cell("Wed", 6), cell("Thu", 14), cell("Fri", 10), cell("Sat", 20), cell("Sun", 11)), (1, 1, 1, 1, 1)
        )
        self.assertEqual(cell("Fri", 16), 3)  # the upload: three kinds of change, however many rows
        self.assertEqual(h["total"], 13)
        self.assertEqual(h["peak"], {"weekday": "Fri", "hour": 16, "count": 3})
        self.assertEqual(h["byWeekday"], [3, 2, 1, 1, 4, 1, 1])
        self.assertEqual(h["byHour"][16], 3)
        self.assertEqual(sum(h["byHour"]), 13)
        self.assertEqual(h["afterHours"], {"events": 4, "sharePct": 30.8, "weekend": 1, "night": 3})

    def test_an_empty_period_has_no_peak(self):
        h = self.api("heatmap", **{"from": "2026-06-01", "to": "2026-06-07"})
        self.assertEqual((h["total"], h["peak"]), (0, None))
        self.assertEqual(sum(map(sum, h["values"])), 0)
        self.assertIsNone(h["afterHours"]["sharePct"])  # no actions: not "0%"


class AfterHoursTests(Standard):
    def test_who_works_outside_hours_and_the_latest_cases(self):
        r = self.api("after-hours", **WEEK)
        self.assertEqual((r["events"], r["previous"], r["weekend"], r["night"], r["sharePct"]), (4, 2, 1, 3, 30.8))
        self.assertEqual(r["change"], {"abs": 2, "pct": 100.0})
        self.assertEqual(r["people"], 2)
        babu, chandra = r["byUser"]
        self.assertEqual(
            (babu["userName"], babu["afterHours"], babu["weekend"], babu["night"], babu["sharePct"]),
            ("Babu K", 2, 1, 1, 66.7),
        )
        self.assertEqual(
            (chandra["userName"], chandra["afterHours"], chandra["night"], chandra["sensitive"]), ("Chandra S", 2, 2, 1)
        )
        # newest first: A9 (Sun 11:00), A5 (Wed 06:30), A4 (Tue 23:15), A10 (Mon 00:00)
        self.assertEqual([(c["at"], c["kind"]) for c in r["recent"]], [
            ("2026-10-04T11:00:00", "weekend"), ("2026-09-30T06:30:00", "night"),
            ("2026-09-29T23:15:00", "night"), ("2026-09-28T00:00:00", "night"),
        ])  # fmt: skip
        self.assertEqual(r["recent"][1]["what"], "Account changed (role, unit, status or password)")
        self.assertIsNone(r["recent"][0]["what"])  # a routine action has no sensitive title


# ═══ the sensitive feed and the full feed ═════════════════════════════════════════════════════════════════════


class SensitiveFeedTests(Standard):
    def test_newest_first_with_who_what_and_how_bad(self):
        r = self.api("sensitive", **WEEK)
        self.assertEqual((r["total"], r["page"], r["pageSize"], r["pages"]), (8, 1, 25, 1))
        rows = [(i["title"], i["userName"], i["severity"], i["category"], i["count"]) for i in r["items"]]
        self.assertEqual(rows, [
            ("Report exported", "Anita Rao", "medium", "export", 1),  # A8 Sat 20:59:59
            ("Employee records changed by bulk upload", "Anita Rao", "medium", "bulk", 20),  # B3 Fri 16:10
            ("Salary or bank details changed by bulk upload", "Anita Rao", "high", "payroll", 30),  # B2
            ("Employees added by bulk upload", "Anita Rao", "medium", "bulk", 120),  # B1
            ("Employee deleted", "Babu K", "high", "deletion", 1),  # A7 Fri 10:00
            ("Managing Director access assigned", "Chandra S", "critical", "access", 1),  # A6 Thu 14:00
            ("Account changed (role, unit, status or password)", "Chandra S", "high", "access", 1),  # A5 Wed 06:30
            ("Payroll generated or changed", "Anita Rao", "high", "payroll", 1),  # A3 Tue 09:30
        ])  # fmt: skip
        first, upload = r["items"][0], r["items"][1]
        self.assertEqual(
            (first["at"], first["role"], first["area"], first["afterHours"]),
            ("2026-10-03T20:59:59", "Payroll Officer", "Reports & exports", None),
        )
        self.assertEqual(first["description"], "Salary Register - XLSX - 250 rows")
        self.assertEqual(upload["description"], "20 employee records in one upload")
        self.assertEqual(r["items"][6]["afterHours"], "night")  # A5 at 06:30
        # the filter chips come from the same groups as the KPIs
        cats = {c["id"]: c for c in r["categories"]}
        self.assertEqual(
            {k: cats[k]["count"] for k in cats},
            {"access": 2, "deletion": 1, "payroll": 2, "bulk": 2, "export": 1, "settings": 0, "backup": 0},
        )
        self.assertEqual(
            {k: cats["access"][k] for k in ("critical", "high", "medium")}, {"critical": 1, "high": 1, "medium": 0}
        )
        self.assertEqual(r["bySeverity"], {"critical": 1, "high": 4, "medium": 3})
        self.assertEqual(r["total"], self.api("summary", **WEEK)["sensitive"]["value"])
        self.assertEqual(len(r["rules"]), len(A.RULES))  # the table that decided it is shown with the page

    def test_paging_merges_single_entries_and_bulk_uploads_in_time_order(self):
        titles = []
        for page in (1, 2, 3):
            r = self.api("sensitive", page=page, pageSize=3, **WEEK)
            self.assertEqual((r["total"], r["pages"], r["pageSize"]), (8, 3, 3))
            titles += [i["title"] for i in r["items"]]
        self.assertEqual(len(titles), 8)
        full = [i["title"] for i in self.api("sensitive", **WEEK)["items"]]
        self.assertEqual(titles, full)  # three pages are exactly the one big page
        self.assertEqual(self.api("sensitive", page=4, pageSize=3, **WEEK)["items"], [])

    def test_page_size_is_capped_at_100_and_a_bad_page_is_page_one(self):
        r = self.api("sensitive", pageSize=1000, page=0, **WEEK)
        self.assertEqual((r["pageSize"], r["page"]), (100, 1))
        self.assertEqual(self.api("sensitive", pageSize=0, **WEEK)["pageSize"], 1)

    def test_filter_by_category(self):
        pay = self.api("sensitive", category="payroll", **WEEK)
        self.assertEqual(
            (pay["total"], [i["title"] for i in pay["items"]]),
            (2, ["Salary or bank details changed by bulk upload", "Payroll generated or changed"]),
        )
        self.assertEqual(self.api("sensitive", category="access", **WEEK)["total"], 2)
        self.assertEqual(self.api("sensitive", category="backup", **WEEK)["total"], 0)
        self.assertEqual(self.api("sensitive", category="bulk", **WEEK)["total"], 2)
        # the chips keep showing the whole period while one category is chosen
        self.assertEqual(sum(c["count"] for c in pay["categories"]), 8)
        self.assertEqual(pay["filters"]["category"], "payroll")

    def test_the_category_may_be_written_in_any_letter_case(self):
        r = self.api("sensitive", category=" PAYROLL ", **WEEK)
        self.assertEqual((r["total"], r["filters"]["category"]), (2, "payroll"))

    def test_an_unknown_category_is_refused_naming_the_valid_ones(self):
        r = self.get(URL + "sensitive", category="nope", **WEEK)
        self.assertEqual(r.status_code, 400)
        self.assertIn("access, deletion, payroll, bulk, export, settings, backup", r.json()["error"])

    def test_search_finds_people_wording_areas_and_the_rule_names(self):
        total = lambda **kw: self.api("sensitive", **kw, **WEEK)["total"]  # noqa: E731
        self.assertEqual(total(q="anita"), 5)  # a person, any case
        self.assertEqual(total(q="payroll"), 2)  # the area / the category name: A3 and the pay change B2
        self.assertEqual(total(q="deleted"), 1)  # in the wording (A7) and in the names of the rules
        self.assertEqual(total(q="md_test"), 1)  # the wording of A6
        self.assertEqual(total(q="salary"), 2)  # A8's report name and B2's wording
        self.assertEqual(total(q="nobody at all"), 0)
        self.assertEqual(total(q="  anita  "), 5)  # spaces around are ignored

    def test_filter_by_person(self):
        r = self.api("sensitive", user="babu k", **WEEK)
        self.assertEqual([(i["title"], i["userName"]) for i in r["items"]], [("Employee deleted", "Babu K")])
        self.assertEqual(self.api("sensitive", user="Anita Rao", **WEEK)["total"], 5)
        self.assertEqual(self.api("sensitive", user="Anita", **WEEK)["total"], 0)  # the name as shown, not a fragment

    def test_the_assistant_gets_no_free_text(self):
        compact = A.activity_sensitive(
            Period(date(2026, 9, 28), date(2026, 10, 4), None, "Week"), page_size=10, compact=True
        )
        self.assertEqual(compact["total"], 8)
        for item in compact["items"]:
            self.assertNotIn("description", item)  # a description can name an employee
            self.assertNotIn("action", item)
            self.assertTrue(item["title"])
        self.assertNotIn("rules", compact)

    def test_a_long_description_is_cut(self):
        long = "Salary Register - XLSX - 250 rows - " + "filter=value; " * 80
        log(ist(2026, 10, 4, 12), "Anita Rao", "export", "reports", long)
        newest = self.api("sensitive", **WEEK)["items"][0]
        self.assertTrue(A.TEXT_LIMIT - 3 <= len(newest["description"]) <= A.TEXT_LIMIT)
        self.assertTrue(newest["description"].endswith("…"))
        self.assertTrue(newest["description"].startswith("Salary Register - XLSX - 250 rows - filter=value;"))


class FeedTests(Standard):
    def test_everything_newest_first_and_it_adds_up_to_the_actions(self):
        r = self.api("feed", **WEEK)
        self.assertEqual(r["total"], 13)
        self.assertEqual(r["total"], self.api("summary", **WEEK)["actions"]["value"])  # a drill-down of that figure
        self.assertEqual([i["at"] for i in r["items"]][:2], ["2026-10-04T11:00:00", "2026-10-03T20:59:59"])
        self.assertEqual(r["items"][-1]["at"], "2026-09-28T00:00:00")  # A10 is the last of the week
        first = r["items"][0]  # A9: routine, on a Sunday
        self.assertEqual(
            (first["description"], first["category"], first["title"], first["afterHours"]),
            ("Updated employee E4 -G H", None, None, "weekend"),
        )
        self.assertEqual(sum(1 for i in r["items"] if i["category"]), 8)  # the sensitive ones are marked
        self.assertEqual(sum(i["count"] for i in r["items"]), 13 - 3 + 170, "rows behind the lines: the upload's 170")

    def test_search_and_person_filter(self):
        self.assertEqual(self.api("feed", q="employee E4", **WEEK)["total"], 1)
        self.assertEqual(self.api("feed", user="Chandra S", **WEEK)["total"], 3)
        self.assertEqual(self.api("feed", q="e", user="Chandra S", pageSize=2, **WEEK)["pages"], 2)

    def test_the_feed_never_selects_the_value_columns(self):
        with CaptureQueriesContext(connection) as ctx:
            self.api("feed", **WEEK)
            self.api("sensitive", **WEEK)
        sql = " ".join(q["sql"] for q in ctx.captured_queries)
        self.assertNotIn("old_values", sql)  # they can hold salaries
        self.assertNotIn("new_values", sql)


# ═══ bulk uploads ═════════════════════════════════════════════════════════════════════════════════════════════


class BulkUploadTests(MdApiTestCase):
    """One upload writes one audit row per employee. It must read as one action, not as 250."""

    def setUp(self):
        super().setUp()
        tidy_md(self.md)
        self.period = {"from": "2026-10-01", "to": "2026-10-03"}

    def api(self, name, **params):
        r = self.get(URL + name, **params, **self.period)
        self.assertEqual(r.status_code, 200, r.content[:300])
        return r.json()

    def test_250_rows_are_one_action_and_the_feed_says_how_many(self):
        burst(
            ist(2026, 10, 2, 11, 5),
            "Priya",
            "update",
            "employees",
            [f"Bulk-updated employee E{i} -changed First Name" for i in range(250)],
        )
        log(ist(2026, 10, 2, 12), "Ravi", "update", "employees", "Updated employee E1 -A B")
        s = self.api("summary")
        self.assertEqual(s["actions"]["value"], 2)  # not 251
        self.assertEqual(s["sensitive"]["value"], 1)
        users = {u["userName"]: u for u in self.api("users")["users"]}
        self.assertEqual((users["Priya"]["actions"], users["Ravi"]["actions"]), (1, 1))  # no "hyperactive" account
        self.assertEqual(self.api("heatmap")["total"], 2)
        item = self.api("sensitive")["items"][0]
        self.assertEqual((item["count"], item["description"]), (250, "250 employee records in one upload"))
        self.assertEqual(self.api("feed")["total"], 2)

    def test_two_uploads_in_different_minutes_are_two_actions_and_two_people_in_one_minute_are_two(self):
        names = [f"Bulk-imported employee E{i} -N{i} X" for i in range(10)]
        burst(ist(2026, 10, 2, 11, 5), "Priya", "create", "employees", names)
        burst(ist(2026, 10, 2, 11, 6), "Priya", "create", "employees", names)
        burst(ist(2026, 10, 2, 11, 6, 30), "Ravi", "create", "employees", names)
        self.assertEqual(self.api("summary")["actions"]["value"], 3)
        self.assertEqual(self.api("sensitive")["total"], 3)

    def test_a_bulk_delete_is_critical_and_shows_in_the_exceptions(self):
        burst(
            ist(2026, 10, 2, 11, 5),
            "Priya",
            "delete",
            "employees",
            [f"Deleted employee E{i} -N{i} X (not in the bulk-update file)" for i in range(12)],
        )
        item = self.api("sensitive")["items"][0]
        self.assertEqual((item["severity"], item["category"], item["count"]), ("critical", "deletion", 12))
        found = A.insights(today=date(2026, 10, 3))
        self.assertEqual(found[0]["id"], "activity.critical-events")
        self.assertIn("Employees deleted by a bulk upload by Priya on 02 Oct", found[0]["detail"])
        self.assertIn("1 critical system change in the last 7 days", found[0]["title"])  # one upload, not 12

    def test_an_upload_that_changes_pay_is_separated_from_the_rest(self):
        at = ist(2026, 10, 2, 11, 5)
        burst(
            at, "Priya", "update", "employees", [f"Bulk-updated employee E{i} -changed Salary Amount" for i in range(5)]
        )
        burst(at, "Priya", "update", "employees", [f"Bulk-updated employee F{i} -changed Phone" for i in range(7)])
        r = self.api("sensitive")
        self.assertEqual({i["title"]: i["count"] for i in r["items"]}, {
            "Salary or bank details changed by bulk upload": 5, "Employee records changed by bulk upload": 7,
        })  # fmt: skip


# ═══ sign-ins ═════════════════════════════════════════════════════════════════════════════════════════════════


def build_sign_ins(cls):
    """Accounts, sessions and attempts for the sign-in tests. Period under test: WEEK (2026-09-28 .. 2026-10-04)."""
    payroll = Role.objects.create(name="Payroll Officer", permissions={"payroll": "edit"})
    viewer = Role.objects.create(name="Viewer", permissions={"employees": "view"})
    cls.owner = account("owner", "Owner O", is_super_admin=True)  # privileged: a super admin
    cls.clerk = account("clerk", "Clerk C", viewer)  # not privileged
    cls.pay = account("pay", "Pay P", payroll)  # privileged: can edit payroll
    cls.dora = account(
        "dora", "Dora D", viewer, last_login=ist(2026, 8, 1, 9)
    )  # last sign-in 64 days before the period ends
    cls.newbie = account("newbie", "Newbie N", viewer, created=ist(2026, 9, 20, 9))  # 14 days old, never signed in
    cls.ghosted = account("ghosted", "Ghosted G", viewer, created=ist(2026, 7, 1, 9))  # 95 days old, never signed in
    cls.gone = account("gone", "Gone G", viewer, is_active=False, last_login=ist(2026, 1, 1, 9))  # disabled

    session(cls.owner, ist(2026, 9, 20, 8))  # H0: history
    session(cls.clerk, ist(2026, 9, 22, 9))  # P0: previous period
    session(cls.owner, ist(2026, 9, 30, 8))  # W1
    session(cls.owner, ist(2026, 10, 3, 22), "Safari on iPhone")  # W2: new device, privileged
    session(cls.clerk, ist(2026, 9, 29, 8))  # W3
    session(cls.clerk, ist(2026, 9, 29, 10), "Firefox on Windows")  # W4: new device, while W3 is open
    session(cls.pay, ist(2026, 9, 28, 9), "Edge on Windows", revoked=ist(2026, 9, 28, 9, 30))  # W5 signed out at 09:30
    session(cls.pay, ist(2026, 9, 28, 10), "Edge on Windows")  # W6: W5 had ended, no overlap
    session(cls.pay, ist(2026, 9, 29, 8), "Edge on Windows")  # W7
    session(cls.pay, ist(2026, 9, 29, 21), "Edge on Windows")  # W8: 13 h after W7, whose token had expired at 20:00

    for i in range(6):  # owner: six wrong passwords in a row in six minutes, typed in different cases: a lock-out
        attempt(["owner", "Owner", "OWNER"][i % 3], ist(2026, 9, 29, 11, i))
    log(ist(2026, 9, 29, 11, 6), "system", "login_blocked", "auth", "Locked-out login attempt for: owner")
    for i in range(4):  # clerk: four failures then a success: no lock-out
        attempt("clerk", ist(2026, 9, 30, 9, i))
    attempt("clerk", ist(2026, 9, 30, 9, 5), ok=True)
    for name in ("ghost1", "ghost2", "ghost3"):  # usernames that are not accounts
        attempt(name, ist(2026, 10, 1, 9))
    for i in range(5):  # pay: five failures but spread over 40 minutes: not a lock-out
        attempt("pay", ist(2026, 10, 1, 10, i * 10))
    for minute, ok in ((0, False), (1, False), (2, True), (3, False), (4, False), (5, False), (6, False)):
        attempt("pay", ist(2026, 10, 2, 9, minute), ok=ok)  # a success resets the run: 4 failures after it
    attempt("clerk", ist(2026, 9, 21, 9))  # previous period
    attempt("clerk", ist(2026, 9, 21, 9, 1))


class SignInTests(MdApiTestCase):
    @classmethod
    def setUpTestData(cls):
        build_sign_ins(cls)

    def setUp(self):
        super().setUp()
        tidy_md(self.md)

    def sign_ins(self, **params):
        r = self.get(URL + "sign-ins", **{**WEEK, **params})
        self.assertEqual(r.status_code, 200, r.content[:400])
        return r.json()

    def test_totals_against_the_previous_period(self):
        s = self.sign_ins()
        # W1..W8 = 8 sign-ins by owner (2), clerk (2), pay (4); the previous period had P0 only
        self.assertEqual(
            {k: s["signIns"][k] for k in ("value", "previous", "people")}, {"value": 8, "previous": 1, "people": 3}
        )
        self.assertEqual(s["signIns"]["change"], {"abs": 7, "pct": 700.0})

    def test_sign_ins_per_day_beside_the_failed_attempts(self):
        s = self.sign_ins()
        daily = {d["date"]: d for d in s["daily"]}
        self.assertEqual(s["granularity"], "day")
        # Mon pay W5 W6 | Tue clerk W3 W4 + pay W7 W8 | Wed owner W1 | Thu | Fri | Sat owner W2 | Sun
        self.assertEqual([daily[d]["signIns"] for d in daily], [2, 4, 1, 0, 0, 1, 0])
        # Tue owner x6 | Wed clerk x4 | Thu ghosts x3 + pay x5 | Fri pay x6 (and one success)
        self.assertEqual([daily[d]["failed"] for d in daily], [0, 6, 4, 8, 6, 0, 0])

    def test_per_person_with_devices_and_last_sign_in(self):
        s = self.sign_ins()
        names = [a["userName"] for a in s["accounts"]]
        self.assertEqual(names, ["Pay P", "Clerk C", "Owner O", "Dora D", "Ghosted G", "Newbie N", "Test MD"])
        self.assertEqual(s["totalAccounts"], 7)  # the disabled account that did not sign in is not listed
        rows = {a["userName"]: a for a in s["accounts"]}
        self.assertEqual(
            rows["Owner O"],
            {
                "userName": "Owner O", "role": "Super admin", "privileged": True, "enabled": True, "signIns": 2,
                "devices": ["Chrome on Windows", "Safari on iPhone"], "lastSignIn": "2026-10-03T22:00:00", "daysSince": 1,
                "dormant": False, "newDevices": 1, "peakAtOnce": 1, "overlapping": 0,
            },
        )  # fmt: skip
        self.assertEqual(
            (
                rows["Pay P"]["signIns"],
                rows["Pay P"]["devices"],
                rows["Pay P"]["lastSignIn"],
                rows["Pay P"]["privileged"],
            ),
            (4, ["Edge on Windows"], "2026-09-29T21:00:00", True),
        )
        self.assertFalse(rows["Clerk C"]["privileged"])
        self.assertEqual(rows["Test MD"]["role"], "Managing Director")

    def test_new_devices_flag_only_a_device_the_account_never_used_before(self):
        s = self.sign_ins()
        self.assertEqual(s["newDevicesTotal"], 2)
        self.assertEqual(
            [(d["userName"], d["device"], d["at"], d["privileged"]) for d in s["newDevices"]],
            [
                ("Owner O", "Safari on iPhone", "2026-10-03T22:00:00", True),
                ("Clerk C", "Firefox on Windows", "2026-09-29T10:00:00", False),
            ],
        )
        # nobody's FIRST sign-in is a new device: pay's and the MD's are not listed, and neither is a repeat of Chrome
        self.assertNotIn("Pay P", [d["userName"] for d in s["newDevices"]])
        earlier = self.sign_ins(**{"from": "2026-09-20", "to": "2026-09-20"})  # owner's very first sign-in
        self.assertEqual(earlier["newDevicesTotal"], 0)

    def test_sessions_open_at_the_same_time(self):
        s = self.sign_ins()
        c = s["concurrent"]
        # clerk's W4 began while W3 (08:00, token good until 20:00) was open. pay's W6 began after W5 was signed out and
        # W8 began after W7's token expired: neither overlaps.
        self.assertEqual(c["overlappingSignIns"], 1)
        self.assertEqual(c["accounts"], [{"userName": "Clerk C", "overlapping": 1, "peak": 2}])
        rows = {a["userName"]: a for a in s["accounts"]}
        self.assertEqual((rows["Clerk C"]["overlapping"], rows["Clerk C"]["peakAtOnce"]), (1, 2))
        self.assertEqual((rows["Pay P"]["overlapping"], rows["Pay P"]["peakAtOnce"]), (0, 1))

    def test_who_is_signed_in_right_now_is_a_snapshot_of_open_unexpired_sessions(self):
        with mock.patch.object(A, "_utc_now", return_value=ist(2026, 10, 3, 23)):  # W2 (22:00) is the only open one
            c = self.sign_ins()["concurrent"]
        self.assertEqual(c["liveNow"], {"sessions": 1, "accounts": 1})
        self.assertEqual(c["severalNow"], [])
        with mock.patch.object(A, "_utc_now", return_value=ist(2026, 9, 29, 11)):  # W3 W4 (clerk) and W7 (pay) are open
            c = self.sign_ins()["concurrent"]
        self.assertEqual(c["liveNow"], {"sessions": 3, "accounts": 2})
        self.assertEqual(c["severalNow"], [{"userName": "Clerk C", "sessions": 2}])
        with mock.patch.object(
            A, "_utc_now", return_value=ist(2026, 9, 28, 10, 30)
        ):  # W5 is signed out; only W6 is open
            c = self.sign_ins()["concurrent"]
        self.assertEqual(c["liveNow"], {"sessions": 1, "accounts": 1})
        with mock.patch.object(A, "_utc_now", return_value=ist(2026, 9, 30, 9)):  # W7 expired at 20:00 the day before
            self.assertEqual(
                self.sign_ins()["concurrent"]["liveNow"], {"sessions": 1, "accounts": 1}
            )  # only owner's W1 (08:00)

    def test_failed_attempts_by_username_with_lock_outs(self):
        f = self.sign_ins()["failed"]
        # owner 6 (typed in three cases = one username) + clerk 4 + ghosts 3 + pay 5 and 6 = 24; clerk x2 before
        self.assertEqual((f["value"], f["previous"]), (24, 2))
        self.assertEqual(f["lockouts"], 1)  # only owner: six in a row inside 15 minutes
        self.assertEqual(f["blockedAttempts"], 1)
        self.assertEqual(f["unknownUsernames"], 3)
        by_name = {a["userName"]: a for a in f["accounts"]}
        self.assertEqual([a["userName"] for a in f["accounts"]][:3], ["Pay P", "Owner O", "Clerk C"])  # 11, 6, 4
        self.assertEqual(
            by_name["Owner O"],
            {
                "userName": "Owner O",
                "failures": 6,
                "lastAt": "2026-09-29T11:05:00",
                "knownAccount": True,
                "privileged": True,
                "lockedOut": 1,
            },
        )
        self.assertEqual(
            (by_name["Pay P"]["failures"], by_name["Pay P"]["lockedOut"]), (11, 0)
        )  # 40 minutes apart; a success resets
        self.assertEqual(
            (by_name["Clerk C"]["failures"], by_name["Clerk C"]["lockedOut"]), (4, 0)
        )  # a success resets the run
        # the three names that are not accounts are shown without what was typed, one failure each
        strangers = [a for a in f["accounts"] if not a["knownAccount"]]
        self.assertEqual([(a["userName"], a["failures"], a["privileged"]) for a in strangers], [
            ("Unknown name 1", 1, False), ("Unknown name 2", 1, False), ("Unknown name 3", 1, False),
        ])  # fmt: skip
        self.assertNotIn("ghost", json.dumps(f))

    def test_what_was_typed_for_a_name_that_is_not_an_account_is_never_shown(self):
        # people type their password into the username box: it must not reach a list the MD (or the assistant) reads
        for i in range(6):
            attempt("S3cretPassw0rd!", ist(2026, 10, 3, 9, i))
        s = self.sign_ins()
        tool = registry.collect_tools()["activity_sign_ins"]
        with read_only_db():
            from_tool = tool.run({"from": "2026-09-28", "to": "2026-10-04"})
        everything = json.dumps([s, from_tool, A.insights(today=TODAY), A.activity_attention(today=TODAY)])
        self.assertNotIn("S3cret", everything)
        self.assertNotIn("ghost", everything)
        names = [a["userName"] for a in s["failed"]["accounts"]]
        self.assertEqual(names[:4], ["Pay P", "Owner O", "Unknown name 1", "Clerk C"])  # 11, 6, 6 (typed 'S3..'), 4
        self.assertEqual(s["failed"]["accounts"][2]["lockedOut"], 1)  # it locked out too: six in a row
        self.assertEqual(s["failed"]["lockouts"], 2)
        titles = [i["title"] for i in A.insights(today=TODAY) if i["id"] == "activity.failed-sign-ins"]
        self.assertEqual(titles, ["1 account locked out after repeated wrong passwords"])  # the known one is named

    def test_a_spray_of_guessed_names_cannot_make_the_list_grow(self):
        for i in range(120):  # a credential-stuffing run: 120 different names, two tries each
            for k in range(2):
                attempt(f"spray{i}", ist(2026, 10, 3, 10, k))
        period = Period(date(2026, 9, 28), date(2026, 10, 4), "custom", "28 Sep – 04 Oct 2026")
        rows, unknown, names = A._failed_accounts(period, A._accounts())
        self.assertEqual((unknown, names), (123, 126))  # the 3 ghosts and 120 sprays; plus pay, owner and clerk
        self.assertEqual(len(rows), 3 + A.FAILED_NAMES_SHOWN)  # every account, and only the most-tried strangers
        self.assertEqual({r["userName"] for r in rows if r["knownAccount"]}, {"Pay P", "Owner O", "Clerk C"})
        s = self.sign_ins(limit=25)
        self.assertEqual(s["failed"]["unknownUsernames"], 123)
        self.assertEqual(s["failed"]["value"], 24 + 240)  # the total counts every attempt, shown or not
        self.assertEqual(len(s["failed"]["accounts"]), 25)

    def test_dormant_accounts(self):
        d = self.sign_ins()["dormant"]
        self.assertEqual(d["days"], 30)
        self.assertEqual(d["count"], 2)
        self.assertEqual(
            [(a["userName"], a["daysSince"], a["lastSignIn"]) for a in d["accounts"]],
            [("Ghosted G", None, None), ("Dora D", 64, "2026-08-01T09:00:00")],
        )
        rows = {a["userName"]: a for a in self.sign_ins()["accounts"]}
        self.assertTrue(rows["Dora D"]["dormant"])
        self.assertFalse(rows["Newbie N"]["dormant"])  # 14 days old: not yet

    def test_the_dormant_view_is_as_of_the_period_end_not_today(self):
        s = self.sign_ins(limit=25, **{"from": "2026-08-01", "to": "2026-08-10"})  # in August dora had just signed in
        rows = {a["userName"]: a for a in s["accounts"]}
        self.assertEqual((rows["Dora D"]["dormant"], rows["Dora D"]["daysSince"]), (False, 9))  # 1 Aug .. 10 Aug
        self.assertTrue(rows["Ghosted G"]["dormant"])  # created 1 July: 40 days old and never signed in
        self.assertNotIn("Newbie N", rows)  # the account did not exist yet
        self.assertEqual(rows["Owner O"]["lastSignIn"], None)  # the September sign-ins had not happened

    def test_a_long_period_is_weekly(self):
        s = self.sign_ins(**{"from": "2026-07-01", "to": "2026-10-04"})
        self.assertEqual(s["granularity"], "week")
        self.assertEqual(s["daily"][-1]["date"], "2026-09-28")
        self.assertEqual(sum(d["signIns"] for d in s["daily"]), s["signIns"]["value"])

    def test_the_security_provenance_says_what_a_device_and_privileged_mean(self):
        ids = {p["id"] for p in self.sign_ins()["provenance"]}
        self.assertEqual(ids, {"sign-ins", "failed-sign-ins", "new-devices", "concurrent", "dormant"})
        devices = next(p for p in self.sign_ins()["provenance"] if p["id"] == "new-devices")
        self.assertTrue(any("Privileged" in c for c in devices["caveats"]))

    def test_limit_applies_to_every_ranked_list_and_is_clamped(self):
        s = self.sign_ins(limit=2)
        self.assertEqual((len(s["accounts"]), len(s["newDevices"]), len(s["failed"]["accounts"])), (2, 2, 2))
        self.assertEqual(s["newDevicesTotal"], 2)


class LockoutTests(MdApiTestCase):
    """The app locks a username after 5 failures in a row within 15 minutes (auth_views); the page reports it the same way."""

    def count(self, start=date(2026, 9, 28), end=date(2026, 10, 4)):
        return A._lockouts(start, end)

    def test_the_rule_is_read_from_the_login_view(self):
        from .auth_views import HR_LOCKOUT_THRESHOLD, HR_LOCKOUT_WINDOW_MINUTES

        self.assertEqual(
            (HR_LOCKOUT_THRESHOLD, HR_LOCKOUT_WINDOW_MINUTES), (5, 15)
        )  # the tests below are written for this

    def test_five_in_a_row_inside_the_window_is_a_lock_out_and_four_is_not(self):
        for i in range(4):
            attempt("four", ist(2026, 9, 29, 9, i))
        for i in range(5):
            attempt("five", ist(2026, 9, 29, 9, i * 3))  # 0, 3, 6, 9, 12 minutes: just inside 15
        self.assertEqual([lo.username for lo in self.count()], ["five"])

    def test_five_spread_beyond_the_window_is_not(self):
        for i in range(5):
            attempt("slow", ist(2026, 9, 29, 9, i * 4))  # 0 .. 16 minutes: the first has aged out by the fifth
        self.assertEqual(self.count(), ())

    def test_a_success_resets_the_run(self):
        for minute, ok in ((0, False), (1, False), (2, False), (3, True), (4, False), (5, False), (6, False)):
            attempt("resets", ist(2026, 9, 29, 9, minute), ok=ok)
        self.assertEqual(self.count(), ())

    def test_usernames_are_compared_ignoring_case(self):
        for i, typed in enumerate(["Mixed", "mixed", "MIXED", "mIxEd", "MiXeD"]):
            attempt(typed, ist(2026, 9, 29, 9, i))
        self.assertEqual([lo.username for lo in self.count()], ["mixed"])

    def test_a_run_that_straddles_the_start_belongs_to_the_week_where_it_completed(self):
        # four failures on the 27th (23:56 .. 23:59) and the fifth at 00:00 on the 28th: locked on the 28th
        for minute in (56, 57, 58, 59):
            attempt("edge", ist(2026, 9, 27, 23, minute))
        attempt("edge", ist(2026, 9, 28, 0, 0))
        attempt("edge", ist(2026, 9, 28, 0, 1))  # the sixth cannot really happen (locked) but must not count again
        self.assertEqual([lo.username for lo in self.count()], ["edge"])  # this week: only two failures fall inside it
        self.assertEqual(self.count(date(2026, 9, 21), date(2026, 9, 27)), ())  # last week saw four

    def test_a_run_that_completed_just_before_the_period_is_not_counted_again(self):
        for minute in (55, 56, 57, 58, 59):  # the fifth failure, 23:59 on the 27th, locks the username
            attempt("early", ist(2026, 9, 27, 23, minute))
        attempt("early", ist(2026, 9, 28, 0, 20))
        self.assertEqual(self.count(), ())
        self.assertEqual([lo.username for lo in self.count(date(2026, 9, 21), date(2026, 9, 27))], ["early"])

    def test_two_separate_lock_outs_are_two(self):
        for day in (29, 30):
            for i in range(5):
                attempt("again", ist(2026, 9, day, 9, i))
        self.assertEqual(len(self.count()), 2)


# ═══ what stands out ═══════════════════════════════════════════════════════════════════════════════════════════


class InsightTests(MdApiTestCase):
    """Window: the 7 days 29 Sep .. 5 Oct (today = Monday 5 Oct); the four weeks before are 1 Sep .. 28 Sep."""

    def setUp(self):
        super().setUp()
        tidy_md(self.md)

    def found(self):
        return {i["id"]: i for i in A.insights(today=TODAY)}

    def routine(self, user="Priya", n=3, day=(2026, 10, 1), hour=10):
        for i in range(n):
            log(ist(*day, hour, i), user, "update", "employees", f"Updated employee E{i} -A B")

    def test_nothing_recorded_at_all_is_said_so(self):
        items = A.insights(today=TODAY)
        self.assertEqual([i["id"] for i in items], ["activity.silent"])
        self.assertEqual((items[0]["severity"], items[0]["page"]), ("info", "activity"))

    def test_a_quiet_normal_week_is_a_calm_good_line(self):
        self.routine(n=4)
        items = A.insights(today=TODAY)
        self.assertEqual([(i["id"], i["severity"]) for i in items], [("activity.calm", "good")])
        self.assertIn("4 actions by 1 person", items[0]["detail"])

    def test_a_critical_system_change_comes_first(self):
        log(ist(2026, 10, 3, 14), "Chandra S", "update", "user_management", "Assigned MD: md_test")
        log(ist(2026, 10, 4, 9), "Chandra S", "restore", "settings", "Automated restore started from x.zip")
        found = A.insights(today=TODAY)
        first = found[0]
        self.assertEqual(
            (first["id"], first["severity"], first["metric"]), ("activity.critical-events", "critical", "2")
        )
        self.assertEqual(first["title"], "2 critical system changes in the last 7 days")
        self.assertEqual(
            first["detail"],
            "Database restore started by Chandra S on 04 Oct, Managing Director access assigned by Chandra S on 03 Oct.",
        )
        self.assertEqual((first["page"], bool(first["ask"])), ("activity", True))

    def test_a_critical_change_older_than_a_week_does_not_count(self):
        log(ist(2026, 9, 28, 23, 59), "Chandra S", "update", "user_management", "Assigned MD: md_test")  # day 8
        self.assertNotIn("activity.critical-events", self.found())

    def test_a_spike_in_sensitive_actions_against_the_weeks_before(self):
        for day in (3, 10, 17, 24):  # four sensitive actions in the four weeks before: one a week
            log(ist(2026, 9, day, 10), "Anita Rao", "create", "payroll", "Generated staff payroll 9/2026 -1 generated")
        for i in range(6):  # six this week: 6x the usual
            log(ist(2026, 10, 1, 10, i), "Anita Rao", "export", "reports", "Salary Register - XLSX - 3 rows")
        spike = self.found()["activity.sensitive-spike"]
        self.assertEqual((spike["severity"], spike["metric"]), ("warning", "6"))
        self.assertEqual(spike["title"], "6 sensitive actions in the last 7 days, 6.0× the usual 1.0 a week")
        self.assertEqual(spike["detail"], "Mostly exports & downloads (6).")

    def test_no_spike_below_five_or_below_twice_the_usual(self):
        for i in range(4):  # four: below the floor of five
            log(ist(2026, 10, 1, 10, i), "Anita Rao", "export", "reports", "Salary Register - XLSX - 3 rows")
        self.assertNotIn("activity.sensitive-spike", self.found())
        for day in range(1, 29):  # a busy history: 28 sensitive in four weeks = 7 a week; 6 more now is below 2x
            log(ist(2026, 9, day, 11), "Anita Rao", "export", "reports", "Salary Register - XLSX - 3 rows")
        for i in range(2):
            log(ist(2026, 10, 2, 10, i), "Anita Rao", "export", "reports", "Salary Register - XLSX - 3 rows")
        self.assertNotIn("activity.sensitive-spike", self.found())  # 6 this week against 7 usual

    def test_with_no_history_a_first_burst_needs_ten(self):
        for i in range(9):
            log(ist(2026, 10, 1, 10, i), "Anita Rao", "export", "reports", "Salary Register - XLSX - 3 rows")
        self.assertNotIn("activity.sensitive-spike", self.found())
        log(ist(2026, 10, 1, 10, 30), "Anita Rao", "export", "reports", "Salary Register - XLSX - 3 rows")
        spike = self.found()["activity.sensitive-spike"]
        self.assertEqual(spike["title"], "10 sensitive actions in the last 7 days, none in the four weeks before")

    def test_one_person_working_outside_hours(self):
        for i in range(5):  # five at 22:00, Wednesday
            log(ist(2026, 9, 30, 22, i), "Babu K", "update", "employees", "Updated employee E1 -A B")
        log(
            ist(2026, 10, 4, 11), "Anita Rao", "update", "employees", "Updated employee E2 -A B"
        )  # Sunday, someone else
        item = self.found()["activity.after-hours-user"]
        self.assertEqual(
            (item["severity"], item["metric"]), ("info", "5")
        )  # 5..9 and nothing sensitive: for information
        self.assertEqual(item["title"], "Babu K did 5 actions outside working hours in the last 7 days")
        self.assertEqual(
            item["detail"],
            "Normal hours are 7 am to 9 pm, Monday to Saturday. 0 on Sunday, 5 at night. 1 other person also worked after hours.",
        )

    def test_after_hours_becomes_a_warning_at_ten_or_with_a_sensitive_action(self):
        for i in range(9):
            log(ist(2026, 9, 30, 22, i), "Babu K", "update", "employees", "Updated employee E1 -A B")
        log(ist(2026, 9, 30, 23), "Babu K", "delete", "employees", "Deleted employee E1 -A B")
        item = self.found()["activity.after-hours-user"]
        self.assertEqual(item["severity"], "warning")
        self.assertTrue(item["detail"].endswith("1 of them sensitive."))

    def test_fewer_than_five_after_hours_actions_is_not_worth_saying(self):
        for i in range(4):
            log(ist(2026, 9, 30, 22, i), "Babu K", "update", "employees", "Updated employee E1 -A B")
        self.assertNotIn("activity.after-hours-user", self.found())

    def test_repeated_failed_sign_ins_and_a_lock_out(self):
        account("owner", "Owner O", is_super_admin=True)
        for i in range(6):
            attempt("owner", ist(2026, 10, 2, 9, i))
        for name in ("a", "b"):
            attempt(name, ist(2026, 10, 2, 10))
        item = self.found()["activity.failed-sign-ins"]
        self.assertEqual((item["severity"], item["metric"]), ("warning", "8"))
        self.assertEqual(item["title"], "1 account locked out after repeated wrong passwords")
        self.assertEqual(
            item["detail"],
            "Owner O. 8 failed attempts in all; 2 usernames did not belong to any account (possible guessing).",
        )

    def test_five_failures_on_one_username_without_a_lock_out(self):
        for i in range(5):
            attempt("slowly", ist(2026, 10, 2, 9) + timedelta(minutes=i * 20))
        item = self.found()["activity.failed-sign-ins"]
        self.assertEqual(item["title"], "A name that is not an account failed to sign in 5 times in the last 7 days")
        self.assertNotIn("slowly", json.dumps(item))  # what was typed is never repeated

    def test_failures_spread_over_several_names_and_the_critical_threshold(self):
        for i in range(16):  # four usernames, four failures each: no single name reaches five, no lock-out
            attempt(f"guess{i % 4}", ist(2026, 10, 2, 9, i))
        item = self.found()["activity.failed-sign-ins"]
        self.assertEqual(item["title"], "16 failed sign-ins across 4 usernames in the last 7 days")
        self.assertEqual(item["severity"], "warning")
        for i in range(40):  # forty more names, once each: 56 failures
            attempt(f"other{i}", ist(2026, 10, 3, 9, i))
        self.assertEqual(self.found()["activity.failed-sign-ins"]["severity"], "critical")

    def test_a_few_stray_failures_are_not_an_exception(self):
        attempt("typo", ist(2026, 10, 2, 9))
        attempt("typo", ist(2026, 10, 2, 9, 5))
        self.routine()
        self.assertNotIn("activity.failed-sign-ins", self.found())

    def test_a_privileged_account_on_a_new_device_but_not_a_clerk(self):
        owner = account("owner", "Owner O", is_super_admin=True)
        clerk = account("clerk", "Clerk C", Role.objects.create(name="Viewer", permissions={}))
        for who in (owner, clerk):
            session(who, ist(2026, 9, 1, 9))  # history: Chrome on Windows
            session(who, ist(2026, 10, 3, 9), "Safari on iPhone")
        item = self.found()["activity.new-device"]
        self.assertEqual((item["severity"], item["metric"]), ("warning", "1"))
        self.assertEqual(item["title"], "Owner O (Super admin) signed in from a new device")
        self.assertEqual(item["detail"], "Owner O on Safari on iPhone. Check it was them.")

    def test_a_new_device_before_the_week_is_not_news(self):
        owner = account("owner", "Owner O", is_super_admin=True)
        session(owner, ist(2026, 9, 1, 9))
        session(owner, ist(2026, 9, 20, 9), "Safari on iPhone")  # a fortnight ago
        self.assertNotIn("activity.new-device", self.found())

    def test_an_account_far_busier_than_its_own_usual(self):
        for week in range(4):  # 10 a week for four weeks = 10 usual
            for i in range(10):
                log(ist(2026, 9, 3 + week * 7, 10, i), "Priya", "update", "employees", "Updated employee E1 -A B")
        for i in range(30):
            log(ist(2026, 10, 1, 10, i), "Priya", "update", "employees", "Updated employee E1 -A B")
        item = self.found()["activity.high-volume"]
        self.assertEqual((item["severity"], item["metric"]), ("info", "30"))
        self.assertEqual(item["title"], "Priya made 30 actions in the last 7 days, 3.0× their usual 10 a week")

    def test_a_busy_account_with_no_history_needs_fifty_and_29_is_never_enough(self):
        for i in range(49):
            log(ist(2026, 10, 1, 10, i), "Priya", "update", "employees", "Updated employee E1 -A B")
        self.assertNotIn("activity.high-volume", self.found())
        log(ist(2026, 10, 1, 11), "Priya", "update", "employees", "Updated employee E1 -A B")
        self.assertEqual(
            self.found()["activity.high-volume"]["title"],
            "Priya made 50 actions in the last 7 days, with no earlier activity to compare",
        )

    def test_at_most_five_most_severe_first_and_the_least_important_is_dropped(self):
        owner = account("owner", "Owner O", is_super_admin=True)
        session(owner, ist(2026, 9, 1, 9))
        session(owner, ist(2026, 10, 3, 9), "Safari on iPhone")  # new-device (warning)
        for i in range(6):
            attempt("owner", ist(2026, 10, 2, 9, i))  # failed-sign-ins (warning)
        log(ist(2026, 10, 3, 14), "Chandra S", "update", "user_management", "Assigned MD: md_test")  # critical
        for i in range(
            12
        ):  # after-hours (warning) + sensitive spike (warning, 12 exports) + high volume (info, 50 more)
            log(ist(2026, 10, 1, 22, i), "Babu K", "export", "reports", "Salary Register - XLSX - 3 rows")
        for i in range(40):
            log(ist(2026, 10, 2, 10, i), "Babu K", "update", "employees", "Updated employee E1 -A B")
        items = A.insights(today=TODAY)
        self.assertEqual(len(items), 5)
        self.assertEqual(items[0]["id"], "activity.critical-events")
        self.assertEqual([i["severity"] for i in items], ["critical", "warning", "warning", "warning", "warning"])
        self.assertNotIn("activity.high-volume", [i["id"] for i in items])  # the info line is the one that goes
        for item in items:
            self.assertTrue(item["title"] and item["page"] == "activity" and item["ask"])

    def test_the_page_endpoint_returns_the_same_checks_for_the_last_seven_days(self):
        log(ist(2026, 10, 3, 14), "Chandra S", "update", "user_management", "Assigned MD: md_test")
        with mock.patch.object(A, "ist_today", return_value=TODAY):
            r = self.get(URL + "attention").json()
        self.assertEqual(
            (r["window"]["start"], r["window"]["end"], r["window"]["days"]), ("2026-09-29", "2026-10-05", 7)
        )
        self.assertEqual([i["id"] for i in r["insights"]], ["activity.critical-events"])
        self.assertTrue(r["provenance"])


class HeadlineTests(MdApiTestCase):
    def setUp(self):
        super().setUp()
        tidy_md(self.md)

    def test_three_kpis_with_a_rolling_week_against_the_week_before_and_fourteen_day_sparklines(self):
        # today = Monday 5 Oct: this week = 29 Sep .. 5 Oct, the one before = 22 .. 28 Sep
        log(ist(2026, 10, 1, 10), "Anita Rao", "delete", "employees", "Deleted employee E1 -A B")  # sensitive
        log(ist(2026, 10, 2, 11), "Anita Rao", "export", "reports", "Salary Register - XLSX - 3 rows")  # sensitive
        log(ist(2026, 10, 4, 11), "Babu K", "update", "employees", "Updated employee E2 -A B")  # Sunday: after hours
        log(ist(2026, 9, 24, 10), "Anita Rao", "delete", "employees", "Deleted employee E3 -A B")  # last week's one
        log(ist(2026, 9, 24, 22), "Babu K", "update", "employees", "Updated employee E3 -A B")  # last week, 22:00 night
        log(ist(2026, 9, 10, 10), "Anita Rao", "delete", "employees", "Deleted employee E9 -A B")  # too old to count
        for i in range(3):
            attempt("x", ist(2026, 10, 2, 9, i * 20))
        attempt("x", ist(2026, 9, 25, 9))
        h = A.headline(today=TODAY)
        by_id = {k["id"]: k for k in h["kpis"]}
        self.assertEqual(list(by_id), ["activity.sensitive", "activity.after-hours", "activity.failed-sign-ins"])
        sensitive = by_id["activity.sensitive"]
        self.assertEqual((sensitive["value"], sensitive["format"], sensitive["page"]), (2, "number", "activity"))
        self.assertEqual(sensitive["delta"], {"abs": 1, "pct": 100.0, "good": "down"})  # 1 the week before
        self.assertEqual(len(sensitive["spark"]), 14)
        # 22 Sep .. 5 Oct day by day: the delete of the 24th, then the delete of 1 Oct and the export of 2 Oct
        self.assertEqual(sensitive["spark"], [0, 0, 1, 0, 0, 0, 0] + [0, 0, 1, 1, 0, 0, 0])
        self.assertEqual(sensitive["sub"], "Last 7 days · 1 critical or high")  # the delete is high, the export medium
        after = by_id["activity.after-hours"]
        self.assertEqual((after["value"], after["delta"]["abs"]), (1, 0))  # one this week, one the week before
        failed = by_id["activity.failed-sign-ins"]
        self.assertEqual((failed["value"], failed["delta"]), (3, {"abs": 2, "pct": 200.0, "good": "down"}))
        self.assertEqual(len(failed["spark"]), 14)
        self.assertEqual(sum(failed["spark"][7:]), 3)
        self.assertEqual({p["id"] for p in h["provenance"]}, {"sensitive", "after-hours", "failed-sign-ins"})
        for kpi in h["kpis"]:
            self.assertTrue(kpi["label"] and kpi["sub"])

    def test_an_empty_database_has_zero_counts_and_no_percentage(self):
        h = A.headline(today=TODAY)
        for kpi in h["kpis"]:
            self.assertEqual(
                (kpi["value"], kpi["spark"], kpi["delta"]), (0, [0] * 14, {"abs": 0, "pct": None, "good": "down"})
            )


# ═══ the assistant's tools ═════════════════════════════════════════════════════════════════════════════════════


class ToolTests(Standard):
    def run_tool(self, name, **args):
        spec = registry.collect_tools()[name]
        with read_only_db():
            return spec.run({"from": "2026-09-28", "to": "2026-10-04", **args})

    def test_the_module_offers_six_tools_for_the_activity_page(self):
        names = [t.name for t in A.TOOLS]
        self.assertEqual(
            names,
            [
                "activity_summary",
                "activity_by_area",
                "activity_by_user",
                "activity_sensitive_actions",
                "activity_sign_ins",
                "activity_after_hours",
            ],
        )
        registered = registry.collect_tools()
        for t in A.TOOLS:
            self.assertIs(registered[t.name], t)
            self.assertEqual(t.page, "activity")
            self.assertFalse(t.uses_scope, "scope does not apply to the audit trail")
            self.assertNotIn("branch", t.properties)
            self.assertGreaterEqual(len(t.description), 80)

    def test_summary_is_the_same_number_as_the_page(self):
        tool = self.run_tool("activity_summary")
        page = self.api("summary", **WEEK)
        for key in ("actions", "activeUsers", "sensitive", "afterHours", "signIns", "failedSignIns"):
            self.assertEqual(tool[key], page[key])

    def test_sensitive_actions_tool_filters_and_withholds_free_text(self):
        r = self.run_tool("activity_sensitive_actions", category="deletion", limit=5)
        self.assertEqual([(i["title"], i["userName"]) for i in r["items"]], [("Employee deleted", "Babu K")])
        self.assertTrue(all("description" not in i for i in r["items"]))
        self.assertEqual(r["total"], 1)
        everyone = self.run_tool("activity_sensitive_actions")
        self.assertEqual((everyone["total"], len(everyone["items"]), everyone["pageSize"]), (8, 8, 10))
        mine = self.run_tool("activity_sensitive_actions", user="Anita Rao", limit=2)
        self.assertEqual((mine["total"], len(mine["items"])), (5, 2))

    def test_a_wrong_category_or_a_limit_out_of_range_is_corrected_not_trusted(self):
        with self.assertRaises(MdParamError):
            self.run_tool("activity_sensitive_actions", category="payrolls")
        self.assertEqual(
            self.run_tool("activity_sensitive_actions", category="PAYROLL", limit=999)["pageSize"], 25
        )  # case-insensitive, capped
        self.assertEqual(len(self.run_tool("activity_by_user", limit=0)["users"]), 1)

    def test_by_user_and_by_area_and_after_hours_and_sign_ins(self):
        users = self.run_tool("activity_by_user", limit=2)
        self.assertEqual([u["userName"] for u in users["users"]], ["Anita Rao", "Babu K"])
        self.assertEqual(self.run_tool("activity_by_area")["areas"][0]["label"], "Employees")
        self.assertEqual(self.run_tool("activity_after_hours")["events"], 4)
        self.assertEqual(self.run_tool("activity_sign_ins")["signIns"]["value"], 7)

    def test_results_are_plain_json_and_small(self):
        for spec in A.TOOLS:
            text = json.dumps(self.run_tool(spec.name))
            self.assertLess(len(text), 20_000, spec.name)

    def test_the_default_period_is_the_last_30_days_and_no_scope_is_taken(self):
        spec = registry.collect_tools()["activity_summary"]
        self.assertEqual(spec.default_period, "last_30_days")
        with read_only_db():
            result = spec.run({"branch": "Anywhere"})  # a scope argument is simply not part of this tool
        self.assertEqual(result["period"]["preset"], "last_30_days")


# ═══ empty data, parameters, permission, safety, speed ═════════════════════════════════════════════════════════


ALL_ROUTES = [
    "summary",
    "trend",
    "modules",
    "users",
    "heatmap",
    "sensitive",
    "sign-ins",
    "feed",
    "after-hours",
    "attention",
]


class EmptyDatabaseTests(MdApiTestCase):
    def setUp(self):
        super().setUp()
        tidy_md(self.md)

    def test_every_endpoint_answers_with_nothing_to_show_and_no_division_by_zero(self):
        for name in ALL_ROUTES:
            with self.subTest(route=name):
                r = self.get(URL + name, **WEEK)
                self.assertEqual(r.status_code, 200, r.content[:300])
                body = r.json()
                self.assertTrue(body["provenance"], "every response explains itself")
                self.assertIn("generatedAt", body)

    def test_the_figures_are_zero_counts_and_missing_percentages_are_null(self):
        s = self.get(URL + "summary", **WEEK).json()
        for key in ("actions", "sensitive", "afterHours", "failedSignIns"):
            self.assertEqual((s[key]["value"], s[key]["previous"]), (0, 0))
        self.assertEqual(s["actions"]["change"], {"abs": 0, "pct": None})  # 0 against 0: no percentage
        self.assertIsNone(s["afterHours"]["sharePct"])
        self.assertEqual(s["activeUsers"]["enabledAccounts"], 1)  # the MD
        self.assertEqual(
            s["notes"], ["Nothing was recorded in the audit trail or the sign-in log for 28 Sep – 04 Oct 2026."]
        )
        self.assertEqual(self.get(URL + "users", **WEEK).json()["users"], [])
        self.assertEqual(self.get(URL + "modules", **WEEK).json()["areas"], [])
        sens = self.get(URL + "sensitive", **WEEK).json()
        self.assertEqual((sens["total"], sens["items"], sens["pages"]), (0, [], 1))
        self.assertEqual([c["count"] for c in sens["categories"]], [0] * 7)
        signs = self.get(URL + "sign-ins", **WEEK).json()
        self.assertEqual((signs["signIns"]["value"], signs["newDevices"], signs["failed"]["accounts"]), (0, [], []))
        after = self.get(URL + "after-hours", **WEEK).json()
        self.assertEqual((after["events"], after["byUser"], after["recent"], after["sharePct"]), (0, [], [], None))


class ParamTests(Standard):
    def test_a_bad_period_is_a_readable_400(self):
        r = self.get(URL + "summary", period="fortnight")
        self.assertEqual(r.status_code, 400)
        self.assertIn("Unknown period", r.json()["error"])
        self.assertEqual(self.get(URL + "summary", **{"from": "2026-10-04", "to": "2026-09-01"}).status_code, 400)

    def test_the_default_period_is_the_last_30_days(self):
        s = self.api("summary")
        self.assertEqual(s["period"]["preset"], "last_30_days")
        self.assertEqual(s["period"]["days"], 30)

    def test_a_number_that_is_not_a_number_is_refused(self):
        for name, param in (
            ("sensitive", "page"),
            ("sensitive", "pageSize"),
            ("feed", "page"),
            ("users", "limit"),
            ("sign-ins", "limit"),
            ("after-hours", "limit"),
        ):
            with self.subTest(route=name, param=param):
                r = self.get(URL + name, **{param: "many"}, **WEEK)
                self.assertEqual(r.status_code, 400)
                self.assertIn(f"'{param}' must be a whole number", r.json()["error"])

    def test_a_scope_is_ignored_because_it_does_not_apply(self):
        plain = self.api("summary", **WEEK)["actions"]
        scoped = self.api("summary", branch="Nowhere", department="Nothing", type="staff", **WEEK)
        self.assertEqual(scoped["actions"], plain)
        self.assertNotIn("scope", scoped)

    def test_the_routes_module_lists_every_endpoint(self):
        self.assertEqual([p.pattern._route for p in activity_routes.urlpatterns], ALL_ROUTES)


class PermissionTests(Standard):
    def headers(self, user):
        return {"HTTP_AUTHORIZATION": f"Bearer {sign_token({'role': 'hr', 'hrUserId': user.id})}"}

    def test_only_the_md_gets_in(self):
        admin = HRUser.objects.create(username="root", password_hash="x", is_super_admin=True)
        everything = Role.objects.create(
            name="Everything", permissions={"employees": "edit", "payroll": "edit", "reports": "edit"}
        )
        clerk = HRUser.objects.create(username="clerk9", password_hash="x", role=everything)
        emp = Employee.objects.create(
            employee_code="E1", first_name="A", last_name="B", phone="9", branch=Branch.objects.create(name="HO")
        )
        employee_token = {
            "HTTP_AUTHORIZATION": "Bearer " + sign_token({"role": "employee", "employeeId": emp.id, "name": "A B"})
        }
        for name in ALL_ROUTES:
            with self.subTest(route=name):
                url = URL + name
                self.assertEqual(self.client.get(url).status_code, 401)
                self.assertEqual(self.client.get(url, **employee_token).status_code, 403)
                for who in (admin, clerk):
                    self.assertEqual(self.client.get(url, **self.headers(who)).status_code, 403, who.username)
                self.assertEqual(self.client.get(url, **md_headers(self.md)).status_code, 200)

    def test_the_md_can_only_read(self):
        for name in ALL_ROUTES:
            for method in ("post", "put", "patch", "delete"):
                r = getattr(self.client, method)(URL + name, **md_headers(self.md))
                self.assertEqual(r.status_code, 405, (name, method))

    def test_taking_the_identity_away_closes_the_door(self):
        self.assertEqual(self.get(URL + "summary", **WEEK).status_code, 200)
        HRUser.objects.filter(pk=self.md.pk).update(is_md=False)
        self.assertEqual(self.get(URL + "summary", **WEEK).status_code, 403)


class SafetyTests(Standard):
    def test_nothing_is_written_by_any_endpoint(self):
        before = {m.__name__: m.objects.count() for m in (AuditLog, HRUser, HrLoginAttempt, LoginSession, Role)}
        for name in ALL_ROUTES:
            self.api(name, **WEEK)
        after = {m.__name__: m.objects.count() for m in (AuditLog, HRUser, HrLoginAttempt, LoginSession, Role)}
        self.assertEqual(before, after)

    @staticmethod
    def run_every_analytic():
        """Every public analytics function, once, on the standard week."""
        period = Period(date(2026, 9, 28), date(2026, 10, 4), "custom", "28 Sep – 04 Oct 2026")
        for fn in (
            A.activity_summary,
            A.activity_trend,
            A.activity_by_area,
            A.activity_users,
            A.activity_heatmap,
            A.activity_sign_ins,
            A.activity_after_hours,
            A.activity_sensitive,
            A.activity_feed,
        ):
            fn(period)
        A.insights(today=TODAY)
        A.headline(today=TODAY)
        A.activity_attention(today=TODAY)

    def test_the_analytics_run_under_the_read_only_guard(self):
        with read_only_db():  # a write inside would raise: none of these may write
            self.run_every_analytic()

    def test_no_secret_or_value_column_is_ever_read(self):
        # the analytics themselves (the sign-in layer reads the signed-in account, which is not this module's business)
        with CaptureQueriesContext(connection) as ctx:
            self.run_every_analytic()
        sql = " ".join(q["sql"] for q in ctx.captured_queries).lower()
        self.assertGreater(len(ctx.captured_queries), 20)
        for column in (
            "old_values",
            "new_values",
            "password_hash",
            "master_features",
            "user_agent",
            "jti",
            "ip_address",
        ):
            self.assertFalse(column in sql, f"{column} must not be selected")
        self.assertFalse("select *" in sql)

    def test_a_hidden_account_is_still_counted_the_trail_is_complete(self):
        HRUser.objects.filter(pk=self.babu.pk).update(is_hidden=True)
        self.assertEqual(self.api("summary", **WEEK)["actions"]["value"], 13)
        self.assertEqual(self.api("sign-ins", **WEEK)["signIns"]["value"], 7)
        self.assertIn("Babu K", [u["userName"] for u in self.api("users", **WEEK)["users"]])


def _count_queries(client, md, name, **params):
    with CaptureQueriesContext(connection) as ctx:
        r = client.get(URL + name, params, **md_headers(md))
    assert r.status_code == 200, r.content[:300]
    return len(ctx.captured_queries)


class QueryCountTests(MdApiTestCase):
    """The number of queries must not grow with the number of rows (no query per row, no N+1)."""

    def grow(self, rows, tag):
        """``rows`` audit entries by many people over the week, a bulk upload of ``rows`` employees, sessions and attempts."""
        week = ist(2026, 9, 28)
        users = [account(f"{tag}{i}", f"User {tag}{i}", is_super_admin=(i % 5 == 0)) for i in range(rows // 10 + 2)]
        for i in range(rows):
            when = week + timedelta(days=i % 7, hours=8 + i % 12, minutes=i % 60)
            action, module = [("update", "employees"), ("delete", "employees"), ("export", "reports")][i % 3]
            log(when, users[i % len(users)].full_name, action, module, f"Updated employee E{i} -A B")
        names = [f"Bulk-imported employee C{i} -N{i} X" for i in range(rows)]
        burst(week + timedelta(days=4, hours=16, minutes=10), users[1].full_name, "create", "employees", names)
        for i in range(rows // 2):
            session(
                users[i % len(users)], week + timedelta(days=i % 7, hours=8 + i % 12, minutes=i % 60), f"Device {i % 4}"
            )
            attempt(f"guess{i % 9}", week + timedelta(days=i % 7, hours=9, minutes=i % 60))

    def test_the_queries_per_endpoint_do_not_grow_with_the_data(self):
        tidy_md(self.md)
        self.grow(6, "a")
        small = {name: _count_queries(self.client, self.md, name, **WEEK) for name in ALL_ROUTES}
        self.grow(60, "b")
        self.grow(300, "c")
        large = {name: _count_queries(self.client, self.md, name, **WEEK) for name in ALL_ROUTES}
        for name in ALL_ROUTES:
            with self.subTest(route=name):
                self.assertLessEqual(
                    large[name], small[name] + 2, "a lock-out check may add one or two queries, never one per row"
                )
                self.assertLessEqual(large[name], 24)

    def test_the_pages_of_the_feed_cost_the_same_however_far_you_page(self):
        tidy_md(self.md)
        self.grow(200, "d")
        first = _count_queries(self.client, self.md, "sensitive", page=1, pageSize=10, **WEEK)
        deep = _count_queries(self.client, self.md, "sensitive", page=9, pageSize=10, **WEEK)
        self.assertEqual(first, deep)


def build_year(per_day):
    """``per_day`` audit entries a day for 120 days (from 2026-06-06) by 25 people, plus sessions and attempts."""
    users = [account(f"s{i}", f"Staff {i}", is_super_admin=(i == 0)) for i in range(25)]
    rows = []
    for d in range(120):
        for i in range(per_day):
            kind = i % 10
            rows.append(
                AuditLog(
                    user_type="hr",
                    user_name=f"Staff {i % 25}",
                    module=["employees", "attendance", "payroll", "reports", "settings"][i % 5],
                    action="delete" if kind == 0 else "export" if kind == 1 else "update",
                    record_description="Deleted employee E1 -A B"
                    if kind == 0
                    else "Salary Register - XLSX - 9 rows"
                    if kind == 1
                    else f"Updated employee E{i} -A B",
                )
            )
    AuditLog.objects.bulk_create(rows, batch_size=2000)
    with connection.cursor() as cur:  # spread them over the 120 days and the day (created_at is auto_now_add)
        cur.execute(
            "UPDATE audit_logs SET created_at = %s::timestamptz + (id %% 120) * interval '1 day'"
            " + (id %% 1440) * interval '1 minute'",
            [ist(2026, 6, 6).isoformat()],
        )
    for i in range(300):
        session(users[i % 25], ist(2026, 6, 6) + timedelta(days=i % 120, minutes=i % 700), f"Device {i % 3}")
        attempt(f"guess{i % 20}", ist(2026, 6, 6) + timedelta(days=i % 120, minutes=i % 700))
    return users


class SpeedTests(MdApiTestCase):
    """Roughly the size of 250 employees over 120 days: every endpoint must answer well inside the 1.5 s target."""

    def test_every_endpoint_on_a_year_of_activity(self):
        tidy_md(self.md)
        per_day = int(os.environ.get("MD_SPEED_ROWS_PER_DAY", "120"))  # 14,400 rows over 120 days by default
        build_year(per_day)
        window = {"from": "2026-06-06", "to": "2026-10-03"}
        slowest = 0.0
        for name in ALL_ROUTES:
            started = _time.monotonic()
            r = self.get(URL + name, **window)
            took = _time.monotonic() - started
            self.assertEqual(r.status_code, 200, r.content[:200])
            slowest = max(slowest, took)
            if os.environ.get("MD_SPEED_REPORT"):
                print(f"  {name:12s} {took * 1000:7.0f} ms  ({per_day * 120:,} audit rows)")
            self.assertLess(
                took, 3.0, f"{name} took {took:.2f}s"
            )  # the target is 1.5 s; the margin is for a busy machine
        self.assertGreater(self.get(URL + "summary", **window).json()["actions"]["value"], per_day * 120 * 0.9)

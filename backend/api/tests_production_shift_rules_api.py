"""
Settings -> Production shifts API (production_shift_rules_views.py): GET / PUT /api/production-shift-rules and the
POST /api/production-shift-rules/preview calculator.

What is pinned here
-------------------
* The body: the seeded defaults (the owner's table) as the GET returns them, GET twice equal, PUT of the GET body a no-op
  (nothing written, no audit row, the stored 16:59:59 kept), GET and preview writing nothing, a missing settings row
  never created by a read.
* Every validation rule of the PUT (one plain-sentence 400, nothing saved): scalars, groups, rules, breaks, the
  cross-checks (windows, order, values, paid time, minimum credit).
* Replace semantics: ids update, no id creates, a missing id deletes (a group takes its rules), array order = table order,
  a rule never moves between groups, an omitted array / key is left alone.
* The stale-copy guards: the settings row read FOR UPDATE, a stale row id refused, a stale `expectedVersion` refused,
  a stale `version` sent back ignored.
* Permissions: administrator, edit role, view-only role (reads and previews, cannot save), role without the module,
  branch login (reads, 403 company_wide_settings on a save), no token, employee token; the legacy endpoints unchanged.
* The audit trail (old / new values, nothing for a refused or a no-op save, the vocabulary of the activity pages), the
  warnings, and the preview calculator (golden figures, the old calculation before the start date, nothing written).

Run via: python manage.py test api.tests_production_shift_rules_api -v 2
"""

import copy
import importlib
import json
import random
import re
from datetime import date, datetime, time
from decimal import Decimal
from unittest import mock

from django.apps import apps as django_apps
from django.db import connection
from django.test import TestCase
from django.test.utils import CaptureQueriesContext

from . import production_shift_rules as psr
from .attendance_final import production_day_result
from .jwt_utils import sign_token
from .md_portal.analytics import activity as activity_rules
from .models import (
    AuditLog,
    Branch,
    Employee,
    HRUser,
    Payroll,
    ProductionBreak,
    ProductionShiftConfig,
    ProductionShiftGroup,
    ProductionShiftRule,
    Role,
)
from .permission_registry import READ_ONLY_POST_PATHS, resolve_module
from .reporting.definitions.employees_admin_audit import AUDIT_MODULES

URL = "/api/production-shift-rules"
PREVIEW = URL + "/preview"
EFFECTIVE = date(2026, 10, 14)  # the day the rules start in these tests (a Wednesday)
TODAY = date(2026, 10, 14)  # the mocked "today" of the view
THURSDAY = "2026-10-15"
SUNDAY = "2026-10-18"
READ_ONLY_KEYS = ("updatedAt", "updatedBy", "warnings", "legacy", "version")

_counter = {"n": 0}


def _migration():
    return importlib.import_module("api.migrations.0121_production_shift_rules")


def bearer(payload: dict) -> dict:
    return {"HTTP_AUTHORIZATION": f"Bearer {sign_token(payload)}"}


def admin_headers() -> dict:
    user, _ = HRUser.objects.get_or_create(
        username="psr_admin", defaults={"password_hash": "x", "is_super_admin": True}
    )
    return bearer({"role": "hr", "hrUserId": user.id, "name": "Asha HR"})


def role_headers(permissions: dict, branch=None, name="Perm Test") -> dict:
    _counter["n"] += 1
    role = Role.objects.create(name=f"psr-role-{_counter['n']}", permissions=permissions)
    user = HRUser.objects.create(username=f"psr-user-{_counter['n']}", password_hash="x", role=role, branch=branch)
    return bearer({"role": "hr", "hrUserId": user.id, "name": name})


def snapshot() -> tuple:
    """Every column of every table the PUT can touch (updated_at included: any write moves it) and the audit count."""

    def rows(model):
        return [tuple(getattr(r, f.attname) for f in model._meta.fields) for r in model.objects.order_by("id")]

    return (
        rows(ProductionShiftConfig),
        rows(ProductionShiftGroup),
        rows(ProductionShiftRule),
        rows(ProductionBreak),
        AuditLog.objects.count(),
    )


class Base(TestCase):
    def setUp(self):
        super().setUp()
        if not ProductionShiftGroup.objects.exists() or not ProductionBreak.objects.exists():
            ProductionShiftGroup.objects.all().delete()
            ProductionBreak.objects.all().delete()
            _migration().seed(django_apps, None)  # a TransactionTestCase elsewhere may have flushed the seed
        ProductionShiftConfig.get()
        ProductionShiftConfig.objects.filter(pk=1).update(
            rules_enabled=True,
            rules_effective_from=EFFECTIVE,
            rules_grace_minutes=5,
            rules_min_credit=Decimal("0.00"),
            rules_rounding_step=Decimal("0.01"),
            rules_rounding_mode="nearest",
            rules_full_day_value=Decimal("1.00"),
            rules_night_session_hours=12,
        )
        self.headers = admin_headers()
        patcher = mock.patch("api.production_shift_rules_views.ist_today", return_value=TODAY)
        patcher.start()
        self.addCleanup(patcher.stop)

    # ── calls ──
    def get(self, headers=None):
        return self.client.get(URL, **(headers or self.headers))

    def put(self, body, headers=None):
        return self.client.put(URL, body, content_type="application/json", **(headers or self.headers))

    def preview(self, body, headers=None):
        return self.client.post(PREVIEW, body, content_type="application/json", **(headers or self.headers))

    def body(self):
        return self.get().json()

    def doc(self):
        """The PUT-able document: the GET body without its read-only keys, as a fresh deep copy."""
        return {k: copy.deepcopy(v) for k, v in self.body().items() if k not in READ_ONLY_KEYS}

    # ── shortcuts into a document ──
    @staticmethod
    def group(doc, label):
        return next(g for g in doc["groups"] if g["label"] == label)

    def day(self, doc):
        return self.group(doc, "Day shift")

    def night(self, doc):
        return self.group(doc, "Night shift")

    def sunday(self, doc):
        return self.group(doc, "Sunday shift")

    @staticmethod
    def rule(group, out, next_day=False):
        return next(r for r in group["rules"] if r["outTime"] == out and r["outNextDay"] is next_day)

    @staticmethod
    def brk(doc, label):
        return next(b for b in doc["breaks"] if b["label"] == label)

    # ── assertions ──
    def assertRefused(self, mutate, message_part, status=400):
        doc = self.doc()
        mutate(doc)
        before = snapshot()
        r = self.put(doc)
        self.assertEqual(r.status_code, status, r.content)
        self.assertIn(message_part, r.json()["error"])
        self.assertEqual(snapshot(), before, "a refused save must change nothing")
        return r.json()

    def assertSaved(self, mutate):
        doc = self.doc()
        mutate(doc)
        r = self.put(doc)
        self.assertEqual(r.status_code, 200, r.content)
        return r.json()


# ═══ reading ═══════════════════════════════════════════════════════════════════════════════════════════════════════


class ReadTests(Base):
    def test_the_body_has_exactly_the_contract_shape(self):
        b = self.body()
        self.assertEqual(
            set(b),
            {
                "enabled",
                "effectiveFrom",
                "graceMinutes",
                "minCredit",
                "roundingStep",
                "roundingMode",
                "fullDayValue",
                "nightSessionHours",
                "groups",
                "breaks",
                "updatedAt",
                "updatedBy",
                "warnings",
                "legacy",
                "version",
            },
        )
        self.assertEqual(
            (b["enabled"], b["effectiveFrom"], b["graceMinutes"], b["minCredit"], b["roundingStep"]),
            (True, "2026-10-14", 5, 0.0, 0.01),
        )
        self.assertEqual((b["roundingMode"], b["fullDayValue"], b["nightSessionHours"]), ("nearest", 1.0, 12))
        self.assertEqual(set(b["groups"][0]), {
            "id", "label", "kind", "appliesOn", "startTime", "firstPunchFrom", "firstPunchTo", "mainOutTime",
            "mainOutNextDay", "enabled", "rules",
        })  # fmt: skip
        self.assertEqual(
            set(b["groups"][0]["rules"][0]), {"id", "label", "outTime", "outNextDay", "shiftValue", "enabled"}
        )
        self.assertEqual(set(b["breaks"][0]), {"id", "label", "startTime", "endTime", "enabled"})

    def test_the_seeded_defaults_are_the_owners_table(self):
        b = self.body()
        self.assertEqual([g["label"] for g in b["groups"]], ["Day shift", "Night shift", "Sunday shift"])
        day, night, sunday = b["groups"]
        self.assertEqual(
            (day["kind"], day["appliesOn"], day["startTime"], day["firstPunchFrom"], day["firstPunchTo"]),
            ("day", "mon_sat", "08:30", "04:00", "16:59"),
        )
        self.assertEqual((day["mainOutTime"], day["mainOutNextDay"]), ("20:00", False))
        self.assertEqual(
            [(r["outTime"], r["outNextDay"], r["shiftValue"]) for r in day["rules"]],
            [
                ("10:30", False, 0.25),
                ("12:45", False, 0.5),
                ("15:30", False, 0.75),
                ("17:45", False, 1.0),
                ("20:00", False, 1.5),
                ("22:30", False, 2.0),
                ("00:30", True, 2.5),
                ("05:30", True, 3.0),
            ],
        )
        self.assertEqual(
            (night["kind"], night["appliesOn"], night["startTime"], night["mainOutTime"], night["mainOutNextDay"]),
            ("night", "all", "21:00", "05:30", True),
        )
        self.assertEqual(
            [(r["outTime"], r["outNextDay"], r["shiftValue"]) for r in night["rules"]],
            [("00:00", True, 0.5), ("05:30", True, 1.5)],
        )
        self.assertEqual(
            (sunday["appliesOn"], sunday["startTime"], sunday["mainOutTime"]), ("sunday", "08:30", "17:00")
        )
        self.assertEqual([(r["outTime"], r["shiftValue"]) for r in sunday["rules"]], [("17:00", 1.0)])
        self.assertEqual(
            [(x["label"], x["startTime"], x["endTime"], x["enabled"]) for x in b["breaks"]],
            [
                ("Morning tea", "10:30", "10:45", True),
                ("Lunch", "12:45", "13:30", True),
                ("Afternoon tea", "15:30", "15:45", True),
                ("Evening tea", "17:45", "18:00", True),
                ("Night dinner", "20:00", "21:00", True),
            ],
        )

    def test_the_legacy_calculation_is_echoed_read_only(self):
        self.assertEqual(
            self.body()["legacy"],
            {
                "punch1Time": "08:30",
                "punch2Time": "12:45",
                "punch3Time": "13:30",
                "punch4Time": "20:00",
                "graceMinutes": 10,
            },
        )

    def test_a_fresh_install_has_nobody_who_saved(self):
        b = self.body()
        self.assertEqual((b["updatedBy"], b["updatedAt"]), (None, None))
        self.assertIsInstance(b["version"], str)

    def test_the_seeded_table_has_nothing_to_warn_about(self):
        self.assertEqual(self.body()["warnings"], [])

    def test_get_twice_is_the_same_document(self):
        self.assertEqual(self.get().json(), self.get().json())

    def test_get_and_preview_write_nothing(self):
        before = snapshot()
        with CaptureQueriesContext(connection) as ctx:
            self.assertEqual(self.get().status_code, 200)
            self.assertEqual(self.get().status_code, 200)
            self.assertEqual(self.preview({"punches": ["08:30", "17:00"], "date": THURSDAY}).status_code, 200)
            self.assertEqual(self.preview({"punches": ["08:30", "17:00"], "date": "2026-10-01"}).status_code, 200)
            self.assertEqual(self.preview({"punches": ["bad"]}).status_code, 400)
        writes = [q["sql"][:60] for q in ctx.captured_queries if re.match(r"\s*(INSERT|UPDATE|DELETE)", q["sql"], re.I)]
        self.assertEqual(writes, [])
        self.assertEqual(snapshot(), before)

    def test_a_get_costs_the_same_few_queries_every_time(self):
        counts = []
        for _ in range(3):
            with CaptureQueriesContext(connection) as ctx:
                self.get()
            counts.append(len(ctx.captured_queries))
        self.assertEqual(len(set(counts)), 1, counts)
        self.assertLessEqual(counts[0], 14, counts)

    def test_a_missing_settings_row_is_shown_with_defaults_and_not_created_by_a_read(self):
        ProductionShiftConfig.objects.all().delete()
        b = self.body()
        self.assertEqual((b["enabled"], b["effectiveFrom"], b["graceMinutes"]), (True, None, 5))
        self.assertEqual(
            self.preview({"punches": ["08:30", "20:00"], "date": THURSDAY}).json()["calculation"], "legacy"
        )
        self.assertEqual(ProductionShiftConfig.objects.count(), 0)
        # the first save creates the row and starts the rules today (never in the past)
        self.assertEqual(self.put({"graceMinutes": 6}).status_code, 200)
        config = ProductionShiftConfig.objects.get(pk=1)
        self.assertEqual(config.rules_grace_minutes, 6)
        self.assertIsNotNone(config.rules_effective_from)


class RoundTripTests(Base):
    def test_putting_the_get_body_back_is_a_no_op(self):
        before_state = snapshot()
        body = self.body()
        r = self.put(body)  # the whole GET body, read-only keys and all
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(r.json(), body)
        self.assertEqual(snapshot(), before_state, "nothing written, no audit row, no updated_at moved")

    def test_the_stored_16_59_59_survives_the_round_trip(self):
        day = ProductionShiftGroup.objects.get(label="Day shift")
        self.assertEqual(day.first_punch_to.second, 59)
        self.put(self.body())
        day.refresh_from_db()
        self.assertEqual(day.first_punch_to.second, 59)

    def test_an_edit_leaves_every_untouched_row_alone(self):
        before = snapshot()
        doc = self.doc()
        self.rule(self.day(doc), "17:45")["shiftValue"] = 1.1
        self.assertEqual(self.put(doc).status_code, 200)
        after = snapshot()
        changed_rules = [r for r in after[2] if r not in before[2]]
        self.assertEqual(len(changed_rules), 1)
        self.assertEqual(
            (after[0] != before[0], after[1], after[3]), (False, before[1], before[3])
        )  # config, groups, breaks

    def test_the_answer_to_a_save_is_the_new_document_and_get_agrees(self):
        doc = self.doc()
        doc["graceMinutes"] = 7
        answer = self.put(doc).json()
        self.assertEqual(answer["graceMinutes"], 7)
        self.assertEqual(self.get().json(), answer)

    def test_the_version_changes_with_every_real_change_only(self):
        first = self.body()["version"]
        self.put(self.body())
        self.assertEqual(self.body()["version"], first)
        self.assertEqual(self.put({"graceMinutes": 8}).status_code, 200)
        second = self.body()["version"]
        self.assertNotEqual(second, first)
        self.assertEqual(self.put({"graceMinutes": 5}).status_code, 200)
        self.assertEqual(self.body()["version"], first, "the same document has the same fingerprint")

    def test_partial_bodies_leave_the_rest_alone(self):
        before = self.doc()
        self.assertEqual(self.put({"graceMinutes": 9}).status_code, 200)
        after = self.doc()
        self.assertEqual(after["graceMinutes"], 9)
        before["graceMinutes"] = 9
        self.assertEqual(after, before)


# ═══ the rules of the PUT ══════════════════════════════════════════════════════════════════════════════════════════


class ScalarTests(Base):
    def test_every_setting_is_saved(self):
        doc = self.assertSaved(
            lambda d: d.update(
                enabled=True,
                effectiveFrom="2026-11-01",
                graceMinutes=7,
                minCredit=0.25,
                roundingStep=0.05,
                roundingMode="down",
                fullDayValue=1.25,
                nightSessionHours=10,
            )
        )
        self.assertEqual(
            (doc["effectiveFrom"], doc["graceMinutes"], doc["minCredit"], doc["roundingStep"], doc["roundingMode"]),
            ("2026-11-01", 7, 0.25, 0.05, "down"),
        )
        config = ProductionShiftConfig.objects.get(pk=1)
        self.assertEqual(
            (
                config.rules_effective_from,
                config.rules_grace_minutes,
                config.rules_min_credit,
                config.rules_rounding_step,
                config.rules_rounding_mode,
                config.rules_full_day_value,
                config.rules_night_session_hours,
            ),
            (date(2026, 11, 1), 7, Decimal("0.25"), Decimal("0.05"), "down", Decimal("1.25"), 10),
        )

    def test_the_legacy_columns_are_never_touched_by_a_save(self):
        before = ProductionShiftConfig.objects.get(pk=1)
        self.put({"graceMinutes": 7, "enabled": False, "effectiveFrom": "2026-12-01"})
        after = ProductionShiftConfig.objects.get(pk=1)
        for name in ("punch1_time", "punch2_time", "punch3_time", "punch4_time", "grace_minutes"):
            self.assertEqual(getattr(after, name), getattr(before, name), name)

    def test_the_boundaries_are_accepted(self):
        for body in (
            {"graceMinutes": 0},
            {"graceMinutes": 30},
            {"graceMinutes": 5.0},
            {"nightSessionHours": 1},
            {"nightSessionHours": 24},
            {"minCredit": 0},
            {"minCredit": 1},
            {"fullDayValue": 0.01},
            {"fullDayValue": 9.99},
            {"roundingStep": 0.25},
            {"effectiveFrom": "2000-01-01"},
            {"effectiveFrom": "2100-12-31"},
        ):
            with self.subTest(body=body):
                self.assertEqual(self.put(body).status_code, 200, body)

    def test_every_scalar_problem_is_a_plain_sentence(self):
        cases = [
            ({"enabled": "yes"}, "master switch"),
            ({"enabled": 1}, "master switch"),
            ({"effectiveFrom": "14/10/2026"}, "YYYY-MM-DD"),
            ({"effectiveFrom": 20261014}, "YYYY-MM-DD"),
            ({"effectiveFrom": "2026-10-14T00:00"}, "YYYY-MM-DD"),
            ({"effectiveFrom": "2026-02-30"}, "real date"),
            ({"effectiveFrom": "1999-12-31"}, "between the years 2000 and 2100"),
            ({"effectiveFrom": "2101-01-01"}, "between the years 2000 and 2100"),
            ({"effectiveFrom": None}, "Applies from: choose"),
            ({"effectiveFrom": ""}, "Applies from: choose"),
            ({"graceMinutes": -1}, "Grace minutes"),
            ({"graceMinutes": 31}, "Grace minutes"),
            ({"graceMinutes": 5.5}, "Grace minutes"),
            ({"graceMinutes": "5"}, "Grace minutes"),
            ({"graceMinutes": True}, "Grace minutes"),
            ({"graceMinutes": None}, "Grace minutes"),
            ({"nightSessionHours": 0}, "Night session hours"),
            ({"nightSessionHours": 25}, "Night session hours"),
            ({"nightSessionHours": 11.5}, "Night session hours"),
            ({"minCredit": -0.01}, "Minimum credit"),
            ({"minCredit": 10}, "Minimum credit"),
            ({"minCredit": 0.125}, "Minimum credit"),
            ({"minCredit": "0.5"}, "Minimum credit"),
            ({"minCredit": False}, "Minimum credit"),
            ({"roundingStep": 0.1}, "Rounding step"),
            ({"roundingStep": 0.02}, "Rounding step"),
            ({"roundingStep": "0.05"}, "Rounding step"),
            ({"roundingMode": "up"}, "Rounding mode"),
            ({"roundingMode": None}, "Rounding mode"),
            ({"fullDayValue": 0}, "Full-day value"),
            ({"fullDayValue": -1}, "Full-day value"),
            ({"fullDayValue": 10}, "Full-day value"),
            ({"fullDayValue": 1.005}, "Full-day value"),
        ]
        for body, message in cases:
            with self.subTest(body=body):
                self.assertRefused(lambda d, b=body: d.update(b), message)

    def test_numbers_the_column_cannot_hold_are_refused_not_crashed(self):
        before = snapshot()
        for raw in (
            '{"graceMinutes": 1e999}',
            '{"minCredit": 1e999}',
            '{"fullDayValue": 1e30}',
            '{"nightSessionHours": 99999999999999999999999}',
            '{"groups": [{"id": 1e999}]}',
        ):
            with self.subTest(raw=raw):
                r = self.client.put(URL, raw, content_type="application/json", **self.headers)
                self.assertEqual(r.status_code, 400, raw)
        self.assertEqual(snapshot(), before)

    def test_the_body_must_be_an_object(self):
        for body in ([1, 2], '"text"', "7"):
            r = self.client.put(URL, body, content_type="application/json", **self.headers)
            self.assertEqual(r.status_code, 400)
            self.assertEqual(r.json()["error"], "The body must be a JSON object.")

    def test_switching_on_with_no_date_starts_today_and_a_named_date_is_kept(self):
        self.put({"enabled": False, "effectiveFrom": None})
        self.assertIsNone(self.body()["effectiveFrom"])
        self.assertEqual(self.put({"enabled": True}).json()["effectiveFrom"], TODAY.isoformat())
        self.assertEqual(self.put({"effectiveFrom": "2026-10-01"}).json()["effectiveFrom"], "2026-10-01")
        self.assertEqual(self.put({"enabled": False}).json()["effectiveFrom"], "2026-10-01")  # kept while off
        self.assertEqual(self.put({"enabled": True}).json()["effectiveFrom"], "2026-10-01")  # and when it comes back

    def test_a_date_is_not_needed_while_the_rules_are_off(self):
        self.assertEqual(self.put({"enabled": False, "effectiveFrom": None}).status_code, 200)

    def test_minimum_credit_cannot_exceed_what_a_group_can_pay(self):
        self.assertRefused(lambda d: d.update(minCredit=1.25), "Minimum credit 1.25 is more than the most Sunday shift")
        self.assertEqual(self.put({"minCredit": 1.0}).status_code, 200)


class GroupTests(Base):
    def test_every_group_problem_is_a_plain_sentence(self):
        def fresh_group(**fields):
            base = {"label": "Extra", "startTime": "06:00", "firstPunchFrom": "01:00", "firstPunchTo": "03:00",
                    "rules": [{"outTime": "12:00", "shiftValue": 1}]}  # fmt: skip
            base.update(fields)
            return base

        def add(**fields):
            return lambda d: d["groups"].append(fresh_group(**fields))

        def set_day(**fields):
            return lambda d: self.day(d).update(fields)

        cases = [
            (lambda d: d.update(groups={"a": 1}), "'groups' must be a list"),
            (lambda d: d.update(groups=[5]), "Every shift group must be an object"),
            (lambda d: d["groups"].extend([fresh_group(label=f"G{i}") for i in range(10)]), "at most 12 shift groups"),
            (lambda d: d["groups"].append({"id": 999999, "label": "Ghost"}), "no longer exists"),
            (lambda d: d["groups"].append({"id": "abc", "label": "Ghost"}), "id must be a whole number"),
            (lambda d: d["groups"].append(dict(d["groups"][0])), "same group id is used twice"),
            (add(label=None), "the name is required"),
            (add(label="   "), "the name is required"),
            (add(label="x" * 101), "at most 100 characters"),
            (add(label=5), "the name must be text"),
            (set_day(label=""), "the name is required"),
            (add(kind="weird"), "the kind must be one of"),
            (add(appliesOn="weekdays"), "'appliesOn' must be one of"),
            (add(startTime="6:00"), "start time must be a time written HH:MM"),
            (add(startTime="25:00"), "start time must be a time written HH:MM"),
            (add(startTime="06:60"), "start time must be a time written HH:MM"),
            (add(startTime=None), "start time must be a time written HH:MM"),
            (add(firstPunchFrom="1am"), "first-punch window start must be a time"),
            (add(firstPunchTo=900), "first-punch window end must be a time"),
            (add(firstPunchFrom="05:00", firstPunchTo="04:00"), "first-punch window must not end before it starts"),
            (add(mainOutTime="midday"), "standard departure must be a time"),
            (add(mainOutTime="05:00"), "standard departure 05:00 must be after the start time 06:00"),
            (add(mainOutTime="06:00"), "must be after the start time"),
            (add(enabled="yes"), "'enabled' must be true or false"),
            (add(mainOutNextDay="no", mainOutTime="20:00"), "'mainOutNextDay' must be true or false"),
            (
                set_day(mainOutTime="08:00"),
                "Day shift: the standard departure 08:00 must be after the start time 08:30",
            ),
            (lambda d: self.night(d).update(mainOutTime="21:00", mainOutNextDay=False), "must be after the start time"),
            (add(rules=[]), "switched on but has no enabled rule"),
            (add(rules=[{"outTime": "12:00", "shiftValue": 1, "enabled": False}]), "no enabled rule"),
            (lambda d: self.sunday(d)["rules"].clear(), "Sunday shift is switched on but has no enabled rule"),
        ]
        for mutate, message in cases:
            with self.subTest(message=message):
                self.assertRefused(mutate, message)

    def test_first_punch_windows_of_groups_on_the_same_days_cannot_overlap(self):
        # Night takes any day: a window reaching back to 16:00 meets the Day window (to 16:59) on Monday-Saturday
        r = self.assertRefused(
            lambda d: self.night(d).update(firstPunchFrom="16:00"),
            "Day shift and Night shift both take first punches between 16:00 and 16:59",
        )
        self.assertIn("first-punch windows", r["error"])
        # the Sunday group shares the Day window on purpose: they never apply on the same day
        self.assertEqual(self.put(self.doc()).status_code, 200)
        # but the Sunday group against the all-days Night group does collide
        self.assertRefused(lambda d: self.sunday(d).update(firstPunchTo="18:00"), "Night shift and Sunday shift")

    def test_a_group_that_is_switched_off_does_not_collide(self):
        def mutate(d):
            self.night(d).update(firstPunchFrom="16:00", enabled=False)

        self.assertSaved(mutate)

    def test_the_rules_cannot_be_on_with_no_group_on(self):
        def all_off(d):
            for g in d["groups"]:
                g["enabled"] = False

        self.assertRefused(all_off, "no shift group is switched on")
        self.assertSaved(lambda d: (all_off(d), d.update(enabled=False)))  # off with the groups off is fine

    def test_a_group_can_be_created_with_its_rules(self):
        def mutate(d):
            d["groups"].append(
                {
                    "label": "Saturday half day",
                    "kind": "custom",
                    "appliesOn": "all",
                    "startTime": "06:00",
                    "firstPunchFrom": "02:00",
                    "firstPunchTo": "03:59",
                    "mainOutTime": "14:00",
                    "mainOutNextDay": False,
                    "enabled": True,
                    "rules": [
                        {"label": "Noon", "outTime": "12:00", "shiftValue": 0.75},
                        {"label": "Two", "outTime": "14:00", "shiftValue": 1.0},
                    ],
                }
            )

        answer = self.assertSaved(mutate)
        made = self.group(answer, "Saturday half day")
        self.assertIsInstance(made["id"], int)
        self.assertEqual(
            [(r["label"], r["outTime"], r["outNextDay"], r["shiftValue"], r["enabled"]) for r in made["rules"]],
            [("Noon", "12:00", False, 0.75, True), ("Two", "14:00", False, 1.0, True)],
        )
        self.assertTrue(all(isinstance(r["id"], int) for r in made["rules"]))
        row = ProductionShiftGroup.objects.get(pk=made["id"])
        self.assertEqual((row.order, row.main_out_time, row.kind), (4, time(14, 0), "custom"))

    def test_a_new_group_defaults(self):
        def mutate(d):
            d["groups"].append(
                {"label": "Bare", "startTime": "06:00", "firstPunchFrom": "02:00", "firstPunchTo": "03:59",
                 "rules": [{"outTime": "12:00", "shiftValue": 1}]}
            )  # fmt: skip

        made = self.group(self.assertSaved(mutate), "Bare")
        self.assertEqual(
            (made["kind"], made["appliesOn"], made["mainOutTime"], made["mainOutNextDay"], made["enabled"]),
            ("custom", "mon_sat", None, False, True),
        )
        self.assertEqual(made["rules"][0]["label"], "")

    def test_a_next_day_flag_without_a_departure_time_is_dropped(self):
        def mutate(d):
            g = self.day(d)
            g.update(mainOutTime=None, mainOutNextDay=True)

        made = self.group(self.assertSaved(mutate), "Day shift")
        self.assertEqual((made["mainOutTime"], made["mainOutNextDay"]), (None, False))


class RuleTests(Base):
    def test_every_rule_problem_is_a_plain_sentence(self):
        def day_rules(mutate):
            return lambda d: mutate(self.day(d)["rules"])

        def new_rule(**fields):
            rule = {"label": "New", "outTime": "23:00", "outNextDay": False, "shiftValue": 2.25}
            rule.update(fields)
            return rule

        def append(**fields):
            return day_rules(lambda rules: rules.insert(6, new_rule(**fields)))  # after 22:30, before 00:30 (next day)

        cases = [
            (lambda d: self.day(d).update(rules="x"), "'rules' must be a list"),
            (day_rules(lambda r: r.append(7)), "Every rule must be an object"),
            (day_rules(lambda r: r.extend([new_rule(outTime="23:00")] * 60)), "at most 60 rules"),
            (day_rules(lambda r: r.append({"id": 999999, "outTime": "23:59", "shiftValue": 3})), "no longer exists"),
            (
                day_rules(lambda r: r.append({"id": "x", "outTime": "23:59", "shiftValue": 3})),
                "id must be a whole number",
            ),
            (day_rules(lambda r: r.append(dict(r[0]))), "same rule id is used twice"),
            (append(outTime="21.00"), "leave-by time must be a time written HH:MM"),
            (append(outTime=None), "leave-by time must be a time written HH:MM"),
            (append(outTime="24:00"), "leave-by time must be a time written HH:MM"),
            (append(outNextDay="yes"), "'outNextDay' must be true or false"),
            (append(shiftValue=0), "shift value must be a number more than 0"),
            (append(shiftValue=-1), "shift value must be a number more than 0"),
            (append(shiftValue=10), "at most 9.99"),
            (append(shiftValue=2.255), "at most two decimals"),
            (append(shiftValue="2.25"), "shift value must be a number"),
            (append(shiftValue=None), "shift value must be a number"),
            (append(shiftValue=True), "shift value must be a number"),
            (append(label=5), "the name must be text"),
            (append(label="x" * 101), "at most 100 characters"),
            (append(enabled="yes"), "'enabled' must be true or false"),
        ]
        for mutate, message in cases:
            with self.subTest(message=message):
                self.assertRefused(mutate, message)

    def test_a_rule_at_or_before_the_start_is_refused(self):
        for out in ("08:30", "08:00", "00:00"):
            with self.subTest(out=out):

                def mutate(d, out=out):
                    rules = self.day(d)["rules"]
                    rules.insert(0, {"outTime": out, "shiftValue": 0.1})

                self.assertRefused(mutate, "is not after the start time 08:30")

    def test_the_times_must_go_up_in_the_order_of_the_table(self):
        def swap(d):
            rules = self.day(d)["rules"]
            rules[3], rules[4] = rules[4], rules[3]  # 20:00 before 17:45

        self.assertRefused(swap, "rules must be listed in time order, but 17:45 comes after 20:00")

        def twice(d):
            rules = self.day(d)["rules"]
            rules.insert(4, {"outTime": "17:45", "shiftValue": 1.1})

        self.assertRefused(twice, "two rules leave at 17:45")

        def forgot_next_day(d):  # 00:30 without its next-day flag is BEFORE 22:30
            self.rule(self.day(d), "00:30", True)["outNextDay"] = False

        self.assertRefused(forgot_next_day, "the 00:30 rule is not after the start time 08:30")

    def test_a_next_day_time_goes_after_a_same_day_one(self):
        self.assertEqual(self.put(self.doc()).status_code, 200)  # the seed itself: 22:30, then 00:30 (next day)

    def test_the_values_can_stay_but_never_go_down(self):
        def down(d):
            self.rule(self.day(d), "17:45")["shiftValue"] = 0.5  # the rule before earns 0.75

        self.assertRefused(down, "the 17:45 rule earns 0.50, less than the 15:30 rule before it (0.75)")

        def flat(d):
            self.rule(self.day(d), "22:30")["shiftValue"] = 1.5  # same as 20:00: allowed

        self.assertSaved(flat)

    def test_two_rules_cannot_sit_on_the_same_paid_time(self):
        def lunch_return(d):  # 12:45 and 13:30 are either side of the unpaid lunch
            self.day(d)["rules"].insert(2, {"outTime": "13:30", "shiftValue": 0.5})

        self.assertRefused(lunch_return, "12:45 and 13:30 rules are on the same paid time")

        def inside_lunch(d):
            self.day(d)["rules"].insert(2, {"outTime": "13:00", "shiftValue": 0.5})

        self.assertRefused(inside_lunch, "12:45 and 13:00 rules are on the same paid time")

        def lunch_break_off(d):  # without the break the two times are different paid times
            self.brk(d, "Lunch")["enabled"] = False
            self.day(d)["rules"].insert(2, {"outTime": "13:30", "shiftValue": 0.5})

        self.assertSaved(lunch_break_off)

    def test_a_rule_that_is_switched_off_is_not_checked_against_the_ladder(self):
        def mutate(d):  # out of order, below the one before, on a paid time already used: all fine while it is off
            self.day(d)["rules"].insert(0, {"outTime": "13:00", "shiftValue": 0.1, "enabled": False})
            self.day(d)["rules"].insert(0, {"outTime": "08:00", "shiftValue": 0.1, "enabled": False})

        self.assertSaved(mutate)

    def test_a_group_whose_only_rules_are_off_is_refused_while_the_group_is_on(self):
        def mutate(d):
            self.sunday(d)["rules"][0]["enabled"] = False

        self.assertRefused(mutate, "Sunday shift is switched on but has no enabled rule")

    def test_a_group_that_is_off_may_have_any_ladder(self):
        def mutate(d):
            sunday = self.sunday(d)
            sunday["enabled"] = False
            sunday["rules"] = [{"outTime": "17:00", "shiftValue": 1}, {"outTime": "09:00", "shiftValue": 0.5}]

        self.assertSaved(mutate)

    def test_a_rule_keeps_its_id_and_a_partial_item_keeps_the_rest(self):
        doc = self.doc()
        target = self.rule(self.day(doc), "17:45")
        rule_id = target["id"]
        self.day(doc)["rules"][3] = {"id": rule_id, "enabled": False}
        answer = self.put(doc).json()
        kept = next(r for r in self.day(answer)["rules"] if r["id"] == rule_id)
        self.assertEqual(
            (kept["outTime"], kept["shiftValue"], kept["label"], kept["enabled"]),
            ("17:45", 1.0, target["label"], False),
        )


class BreakTests(Base):
    def test_every_break_problem_is_a_plain_sentence(self):
        def add(**fields):
            row = {"label": "Snack", "startTime": "11:00", "endTime": "11:10"}
            row.update(fields)
            return lambda d: d["breaks"].append(row)

        cases = [
            (lambda d: d.update(breaks="x"), "'breaks' must be a list"),
            (lambda d: d.update(breaks=[3]), "Every break must be an object"),
            (lambda d: d["breaks"].extend([{"startTime": "01:00", "endTime": "01:05"}] * 26), "at most 30 breaks"),
            (
                lambda d: d["breaks"].append({"id": 999999, "startTime": "11:00", "endTime": "11:10"}),
                "no longer exists",
            ),
            (
                lambda d: d["breaks"].append({"id": "x", "startTime": "11:00", "endTime": "11:10"}),
                "id must be a whole number",
            ),
            (lambda d: d["breaks"].append(dict(d["breaks"][0])), "same break id is used twice"),
            (add(startTime="11.00"), "start time must be a time written HH:MM"),
            (add(endTime="9"), "end time must be a time written HH:MM"),
            (add(startTime=None), "start time must be a time written HH:MM"),
            (add(startTime="11:10", endTime="11:00"), "the break must end after it starts"),
            (add(startTime="11:00", endTime="11:00"), "the break must end after it starts"),
            (add(endTime="00:00"), "the break must end after it starts"),  # cannot cross midnight
            (add(label=7), "the name must be text"),
            (add(enabled="yes"), "'enabled' must be true or false"),
            (add(startTime="10:40", endTime="10:50"), "overlaps Morning tea"),
            (add(startTime="12:30", endTime="14:00"), "overlaps Lunch"),
        ]
        for mutate, message in cases:
            with self.subTest(message=message):
                self.assertRefused(mutate, message)

    def test_breaks_that_touch_or_are_switched_off_do_not_overlap(self):
        def touching(d):
            d["breaks"].append({"label": "After tea", "startTime": "18:00", "endTime": "18:15"})

        self.assertSaved(touching)

        def off(d):
            d["breaks"].append({"label": "Spare", "startTime": "10:30", "endTime": "10:45", "enabled": False})

        self.assertSaved(off)

    def test_a_break_can_be_edited_and_removed(self):
        doc = self.doc()
        tea = self.brk(doc, "Morning tea")
        tea["endTime"] = "10:50"
        doc["breaks"] = [b for b in doc["breaks"] if b["label"] != "Night dinner"]
        answer = self.put(doc).json()
        self.assertEqual(self.brk(answer, "Morning tea")["endTime"], "10:50")
        self.assertEqual(self.brk(answer, "Morning tea")["id"], tea["id"])
        self.assertNotIn("Night dinner", [b["label"] for b in answer["breaks"]])
        self.assertFalse(ProductionBreak.objects.filter(label="Night dinner").exists())


# ═══ replace semantics ═════════════════════════════════════════════════════════════════════════════════════════════


class ReplaceTests(Base):
    def test_a_rule_missing_from_the_array_is_deleted(self):
        doc = self.doc()
        gone = self.rule(self.day(doc), "22:30")
        self.day(doc)["rules"] = [r for r in self.day(doc)["rules"] if r["id"] != gone["id"]]
        self.put(doc)
        self.assertFalse(ProductionShiftRule.objects.filter(pk=gone["id"]).exists())
        self.assertEqual(ProductionShiftRule.objects.filter(group__label="Day shift").count(), 7)

    def test_a_rule_without_an_id_is_created_in_its_place(self):
        doc = self.doc()
        self.day(doc)["rules"].insert(5, {"label": "Quarter past eight", "outTime": "21:15", "shiftValue": 1.75})
        answer = self.put(doc).json()
        made = next(r for r in self.day(answer)["rules"] if r["outTime"] == "21:15")
        self.assertIsInstance(made["id"], int)
        self.assertEqual([r["outTime"] for r in self.day(answer)["rules"]][4:7], ["20:00", "21:15", "22:30"])

    def test_a_deleted_group_takes_its_rules_and_the_others_are_untouched(self):
        doc = self.doc()
        sunday = self.sunday(doc)
        sunday_rule = sunday["rules"][0]["id"]
        doc["groups"] = [g for g in doc["groups"] if g["label"] != "Sunday shift"]
        answer = self.put(doc).json()
        self.assertEqual([g["label"] for g in answer["groups"]], ["Day shift", "Night shift"])
        self.assertFalse(ProductionShiftGroup.objects.filter(pk=sunday["id"]).exists())
        self.assertFalse(ProductionShiftRule.objects.filter(pk=sunday_rule).exists())
        self.assertEqual(ProductionShiftRule.objects.count(), 10)

    def test_the_order_of_an_array_is_the_order_of_the_table(self):
        doc = self.doc()
        ids_before = {g["label"]: g["id"] for g in doc["groups"]}
        doc["groups"].reverse()
        doc["breaks"].reverse()
        answer = self.put(doc).json()
        self.assertEqual([g["label"] for g in answer["groups"]], ["Sunday shift", "Night shift", "Day shift"])
        self.assertEqual({g["label"]: g["id"] for g in answer["groups"]}, ids_before, "the ids do not change")
        self.assertEqual([b["label"] for b in answer["breaks"]][0], "Night dinner")
        self.assertEqual([g.order for g in ProductionShiftGroup.objects.order_by("order")], [1, 2, 3])
        self.assertEqual(self.get().json()["groups"], answer["groups"])

    def test_an_omitted_array_is_left_alone(self):
        before = snapshot()
        r = self.put({"graceMinutes": 5})  # no groups, no breaks
        self.assertEqual(r.status_code, 200)
        self.assertEqual(snapshot(), before)

    def test_a_group_sent_without_its_rules_keeps_them(self):
        doc = self.doc()
        for g in doc["groups"]:
            del g["rules"]
        self.day(doc)["label"] = "Day shift (main)"
        answer = self.put(doc).json()
        self.assertEqual(len(answer["groups"][0]["rules"]), 8)
        self.assertEqual(answer["groups"][0]["label"], "Day shift (main)")

    def test_a_rule_can_never_move_to_another_group(self):
        doc = self.doc()
        moved = self.rule(self.sunday(doc), "17:00")
        self.day(doc)["rules"].append(moved)  # a copy of the Sunday rule (its id) in the Day group
        before = snapshot()
        r = self.put(doc)
        self.assertEqual(r.status_code, 400)
        self.assertIn("belongs to another group", r.json()["error"])
        self.assertEqual(snapshot(), before)

    def test_a_new_group_cannot_adopt_an_existing_rule(self):
        doc = self.doc()
        taken = self.rule(self.sunday(doc), "17:00")
        self.sunday(doc)["rules"] = []  # the Sunday group lets go of it
        doc["groups"].append(
            {
                "label": "Thief",
                "startTime": "06:00",
                "firstPunchFrom": "01:00",
                "firstPunchTo": "02:00",
                "rules": [taken],
            }
        )
        r = self.put(doc)
        self.assertEqual(r.status_code, 400)
        self.assertIn("belongs to another group", r.json()["error"])

    def test_the_same_save_can_rename_edit_add_and_delete_at_once(self):
        doc = self.doc()
        self.rule(self.day(doc), "20:00")["label"] = "Main out"
        self.day(doc)["rules"] = [r for r in self.day(doc)["rules"] if r["outTime"] != "10:30"]
        self.day(doc)["label"] = "Day (new name)"
        self.night(doc)["rules"].insert(1, {"outTime": "03:00", "outNextDay": True, "shiftValue": 1.0})
        doc["breaks"].append({"label": "Spare", "startTime": "09:00", "endTime": "09:05"})
        answer = self.put(doc).json()
        self.assertEqual(answer["groups"][0]["label"], "Day (new name)")
        self.assertEqual(len(answer["groups"][0]["rules"]), 7)
        self.assertEqual([r["outTime"] for r in answer["groups"][1]["rules"]], ["00:00", "03:00", "05:30"])
        self.assertEqual(len(answer["breaks"]), 6)
        self.assertEqual(self.get().json()["groups"], answer["groups"])

    def test_the_saved_tables_reach_the_engine(self):
        doc = self.doc()
        self.rule(self.day(doc), "17:45")["shiftValue"] = 1.2
        self.assertEqual(self.put(doc).status_code, 200)
        ruleset = psr.rules_for_day(ProductionShiftConfig.get(), EFFECTIVE)
        result = psr.evaluate_day(ruleset, EFFECTIVE, [psr.time_to_s("08:30"), psr.time_to_s("17:45")])
        self.assertEqual(result["shifts_earned"], Decimal("1.20"))


# ═══ concurrency ═══════════════════════════════════════════════════════════════════════════════════════════════════


class ConcurrencyTests(Base):
    def test_the_settings_row_is_read_for_update_so_two_saves_cannot_undo_each_other(self):
        with CaptureQueriesContext(connection) as ctx:
            self.assertEqual(self.put({"graceMinutes": 7}).status_code, 200)
        locked = [
            q["sql"] for q in ctx.captured_queries if "FOR UPDATE" in q["sql"] and "production_shift_config" in q["sql"]
        ]
        self.assertTrue(locked)
        # a save that read the row before another one committed must not write that old copy back
        stale = ProductionShiftConfig.objects.get(pk=1)
        ProductionShiftConfig.objects.filter(pk=1).update(rules_grace_minutes=9)
        with mock.patch.object(ProductionShiftConfig, "get", return_value=stale):
            self.assertEqual(self.put({"nightSessionHours": 10}).status_code, 200)
        config = ProductionShiftConfig.objects.get(pk=1)
        self.assertEqual((config.rules_grace_minutes, config.rules_night_session_hours), (9, 10))

    def test_a_stale_version_is_refused_and_nothing_is_saved(self):
        stale = self.doc()
        stale["expectedVersion"] = self.body()["version"]
        self.assertEqual(self.put({"graceMinutes": 8}).status_code, 200)  # somebody else saves first
        stale["graceMinutes"] = 12
        before = snapshot()
        r = self.put(stale)
        self.assertEqual(r.status_code, 400)
        self.assertEqual(r.json()["code"], "stale_settings")
        self.assertIn("reload the page", r.json()["error"])
        self.assertEqual(snapshot(), before)
        self.assertEqual(ProductionShiftConfig.objects.get(pk=1).rules_grace_minutes, 8)

    def test_a_current_version_is_accepted_and_the_answer_carries_the_next_one(self):
        doc = self.doc()
        doc["expectedVersion"] = self.body()["version"]
        doc["graceMinutes"] = 8
        answer = self.put(doc).json()
        self.assertNotEqual(answer["version"], doc["expectedVersion"])
        doc2 = self.doc()
        doc2["expectedVersion"] = answer["version"]
        doc2["graceMinutes"] = 9
        self.assertEqual(self.put(doc2).status_code, 200)

    def test_a_save_without_an_expected_version_skips_that_check(self):
        stale = self.doc()
        self.assertEqual(self.put({"graceMinutes": 8}).status_code, 200)
        stale["nightSessionHours"] = 9
        self.assertEqual(self.put(stale).status_code, 200)

    def test_the_version_of_a_get_body_sent_back_is_ignored_so_an_old_body_can_restore_the_table(self):
        original = self.body()  # a whole GET body, `version` and all
        self.assertEqual(self.put({"graceMinutes": 8}).status_code, 200)
        self.assertEqual(self.put({"nightSessionHours": 9}).status_code, 200)
        r = self.put(original)  # an old copy of the table: put back as it was (every row id still exists)
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual({k: v for k, v in r.json().items() if k not in READ_ONLY_KEYS}, self.doc())
        config = ProductionShiftConfig.objects.get(pk=1)
        self.assertEqual((config.rules_grace_minutes, config.rules_night_session_hours), (5, 12))

    def test_a_row_that_somebody_else_deleted_is_refused_with_reload_advice(self):
        doc = self.doc()
        victim = self.rule(self.day(doc), "22:30")
        ProductionShiftRule.objects.filter(pk=victim["id"]).delete()
        before = snapshot()
        r = self.put(doc)  # the stale copy still carries the deleted rule
        self.assertEqual(r.status_code, 400)
        self.assertIn("no longer exists", r.json()["error"])
        self.assertIn("reload the page", r.json()["error"])
        self.assertEqual(snapshot(), before)

    def test_a_stale_copy_with_the_version_does_not_drop_a_rule_somebody_added(self):
        stale = self.doc()
        stale["expectedVersion"] = self.body()["version"]
        extra = ProductionShiftRule.objects.create(
            group=ProductionShiftGroup.objects.get(label="Day shift"),
            label="Added meanwhile",
            out_time=psr.s_to_time(psr.time_to_s("21:15")),
            shift_value=Decimal("1.75"),
            order=99,
        )
        r = self.put(stale)  # replace semantics would delete it; the expected-version guard refuses instead
        self.assertEqual(r.status_code, 400)
        self.assertEqual(r.json()["code"], "stale_settings")
        self.assertTrue(ProductionShiftRule.objects.filter(pk=extra.pk).exists())


# ═══ random documents ══════════════════════════════════════════════════════════════════════════════════════════════


class FuzzTests(Base):
    """Random edits of the document (wrong types, odd values, rows added / dropped / swapped): every one is either saved
    or refused with one sentence, never a crash; a refusal changes nothing; a save reads back exactly as answered, and
    putting what was read back is a no-op."""

    JUNK = [
        None, True, False, 0, 1, -1, 5, 31, 0.5, 1.005, 2.25, 9.99, 10, 99999, "", "x", " ", "08:30", "25:61", "7:5",
        "2026-10-14", "2026-13-40", [], {}, [1], {"a": 1}, 10**30, -(10**30), 1e-9, "٣",
    ]  # fmt: skip
    TIMES = ["00:00", "04:00", "06:15", "08:29", "08:30", "09:00", "12:45", "13:30", "17:45", "20:00", "21:00", "23:59"]

    def reset(self):
        ProductionShiftGroup.objects.all().delete()
        ProductionBreak.objects.all().delete()
        _migration().seed(django_apps, None)

    def mutate(self, rng, doc):
        kind = rng.randrange(14)
        groups, breaks = doc["groups"], doc["breaks"]
        group = rng.choice(groups) if groups else None
        rule = rng.choice(group["rules"]) if group and group["rules"] else None
        brk = rng.choice(breaks) if breaks else None
        if kind == 0:
            key = rng.choice(["enabled", "effectiveFrom", "graceMinutes", "minCredit", "roundingStep", "roundingMode",
                              "fullDayValue", "nightSessionHours"])  # fmt: skip
            doc[key] = rng.choice(self.JUNK)
        elif kind == 1 and group:
            group[rng.choice(["label", "kind", "appliesOn", "enabled", "mainOutNextDay"])] = rng.choice(self.JUNK)
        elif kind == 2 and group:
            group[rng.choice(["startTime", "firstPunchFrom", "firstPunchTo", "mainOutTime"])] = rng.choice(
                self.TIMES + self.JUNK[:12]
            )
        elif kind == 3 and rule:
            rule[rng.choice(["outTime"])] = rng.choice(self.TIMES + self.JUNK[:12])
        elif kind == 4 and rule:
            rule[rng.choice(["shiftValue", "outNextDay", "enabled", "label"])] = rng.choice(
                self.JUNK + [0.25, 0.75, 1.0, 1.5, 3.0, 4.0]
            )
        elif kind == 5 and group:
            group["rules"].insert(
                rng.randrange(len(group["rules"]) + 1),
                {
                    "outTime": rng.choice(self.TIMES),
                    "outNextDay": rng.random() < 0.3,
                    "shiftValue": rng.choice([0.1, 1, 2, 2.75, 5]),
                },
            )
        elif kind == 6 and group and group["rules"]:
            del group["rules"][rng.randrange(len(group["rules"]))]
        elif kind == 7 and len(groups) > 1:
            i, j = rng.sample(range(len(groups)), 2)
            groups[i], groups[j] = groups[j], groups[i]
        elif kind == 8 and group and len(group["rules"]) > 1:
            i, j = rng.sample(range(len(group["rules"])), 2)
            group["rules"][i], group["rules"][j] = group["rules"][j], group["rules"][i]
        elif kind == 9:
            breaks.append(
                {
                    "label": rng.choice(["", "Tea", "x" * 120]),
                    "startTime": rng.choice(self.TIMES),
                    "endTime": rng.choice(self.TIMES),
                    "enabled": rng.random() < 0.8,
                }
            )
        elif kind == 10 and brk:
            brk[rng.choice(["startTime", "endTime", "enabled", "label"])] = rng.choice(self.TIMES + self.JUNK[:12])
        elif kind == 11 and breaks:
            del breaks[rng.randrange(len(breaks))]
        elif kind == 12:
            groups.append(
                {
                    "label": rng.choice(["Extra", "", None]),
                    "startTime": rng.choice(self.TIMES),
                    "firstPunchFrom": rng.choice(self.TIMES),
                    "firstPunchTo": rng.choice(self.TIMES),
                    "appliesOn": rng.choice(["all", "sunday", "mon_sat", "x"]),
                    "rules": [{"outTime": rng.choice(self.TIMES), "shiftValue": rng.choice([0.5, 1, 2])}],
                }
            )
        elif kind == 13 and groups:
            del groups[rng.randrange(len(groups))]

    def test_random_edits_are_saved_or_refused_never_crashed(self):
        rng = random.Random(20261014)
        saved = refused = 0
        for step in range(400):
            if step % 40 == 0:
                self.reset()
            doc = self.doc()
            for _ in range(rng.randrange(1, 4)):
                self.mutate(rng, doc)
            before = snapshot()
            r = self.put(doc)
            self.assertIn(r.status_code, (200, 400), (step, r.status_code, r.content[:300]))
            if r.status_code == 400:
                refused += 1
                self.assertIsInstance(r.json()["error"], str, step)
                self.assertTrue(r.json()["error"], step)
                self.assertEqual(snapshot(), before, f"step {step}: a refusal changed something")
                continue
            saved += 1
            answer = r.json()
            self.assertEqual(
                {k: v for k, v in answer.items() if k != "warnings"},
                {k: v for k, v in self.get().json().items() if k != "warnings"},
                step,
            )
            again_before = snapshot()
            again = self.put(self.get().json())  # what was read, put back: nothing to do
            self.assertEqual(again.status_code, 200, (step, again.content[:300]))
            self.assertEqual(snapshot(), again_before, f"step {step}: putting the read body back wrote something")
        self.assertGreater(saved, 20, (saved, refused))
        self.assertGreater(refused, 100, (saved, refused))


# ═══ permissions ═══════════════════════════════════════════════════════════════════════════════════════════════════


class PermissionTests(Base):
    def test_the_url_is_mapped_to_the_attendance_settings(self):
        self.assertEqual(resolve_module("production-shift-rules"), "settings.attendance")
        self.assertEqual(resolve_module("production-shift-rules/preview"), "settings.attendance")
        self.assertEqual(resolve_module("production-shift-config"), "settings.attendance")
        self.assertEqual(READ_ONLY_POST_PATHS, frozenset({"production-shift-rules/preview"}))

    def test_an_administrator_reads_saves_and_previews(self):
        self.assertEqual(self.get().status_code, 200)
        self.assertEqual(self.put({"graceMinutes": 6}).status_code, 200)
        self.assertEqual(self.preview({"punches": ["08:30", "20:00"], "date": THURSDAY}).status_code, 200)

    def test_a_role_that_may_edit_the_attendance_settings_reads_saves_and_previews(self):
        who = role_headers({"settings.attendance": "edit"})
        self.assertEqual(self.get(who).status_code, 200)
        self.assertEqual(self.put({"graceMinutes": 6}, who).status_code, 200)
        self.assertEqual(self.preview({"punches": ["08:30", "20:00"], "date": THURSDAY}, who).status_code, 200)

    def test_edit_on_the_settings_parent_cascades(self):
        who = role_headers({"settings": "edit"})
        self.assertEqual(self.put({"graceMinutes": 6}, who).status_code, 200)

    def test_a_view_only_role_reads_and_previews_but_cannot_save(self):
        who = role_headers({"settings.attendance": "view"})
        self.assertEqual(self.get(who).status_code, 200)
        self.assertEqual(self.preview({"punches": ["08:30", "20:00"], "date": THURSDAY}, who).status_code, 200)
        before = snapshot()
        r = self.put({"graceMinutes": 6}, who)
        self.assertEqual(r.status_code, 403)
        self.assertEqual(r.json()["error"], "permission_denied")
        self.assertEqual(snapshot(), before)

    def test_view_only_does_not_open_any_other_post(self):
        who = role_headers({"settings.attendance": "view"})
        r = self.client.post(
            "/api/production-shift-segments",
            {"label": "x", "startTime": "08:00", "endTime": "09:00", "shiftValue": 0.25},
            content_type="application/json",
            **who,
        )
        self.assertEqual(r.status_code, 403)
        r = self.client.post(URL + "/other", {}, content_type="application/json", **who)
        self.assertEqual(r.status_code, 403)

    def test_a_role_without_the_module_is_refused_everywhere(self):
        for permissions in ({"employees": "edit"}, {"settings.attendance": "hidden"}, {}):
            who = role_headers(permissions)
            with self.subTest(permissions=permissions):
                self.assertEqual(self.get(who).status_code, 403)
                self.assertEqual(self.put({"graceMinutes": 6}, who).status_code, 403)
                self.assertEqual(self.preview({"punches": ["08:30"], "date": THURSDAY}, who).status_code, 403)

    def test_a_branch_login_may_read_and_preview_but_not_change_company_wide_rules(self):
        north = Branch.objects.create(name="North", code="N")
        who = role_headers({"settings.attendance": "edit"}, branch=north)
        self.assertEqual(self.get(who).status_code, 200)
        self.assertEqual(self.preview({"punches": ["08:30", "20:00"], "date": THURSDAY}, who).status_code, 200)
        before = snapshot()
        r = self.put({"graceMinutes": 6}, who)
        self.assertEqual(r.status_code, 403)
        self.assertEqual(r.json()["code"], "company_wide_settings")
        self.assertIn("whole company", r.json()["error"])
        self.assertEqual(snapshot(), before)

    def test_no_token_is_a_401(self):
        self.assertEqual(self.client.get(URL).status_code, 401)
        self.assertEqual(self.client.put(URL, {}, content_type="application/json").status_code, 401)
        self.assertEqual(self.client.post(PREVIEW, {}, content_type="application/json").status_code, 401)

    def test_an_employee_token_is_not_hr(self):
        who = bearer({"role": "employee", "employeeId": 1})
        self.assertEqual(self.get(who).status_code, 403)
        self.assertEqual(self.put({"graceMinutes": 6}, who).status_code, 403)
        self.assertEqual(self.preview({"punches": ["08:30"]}, who).status_code, 403)

    def test_the_methods_are_what_the_contract_says(self):
        self.assertEqual(self.client.post(URL, {}, content_type="application/json", **self.headers).status_code, 405)
        self.assertEqual(self.client.delete(URL, **self.headers).status_code, 405)
        self.assertEqual(self.client.get(PREVIEW, **self.headers).status_code, 405)
        self.assertEqual(self.client.put(PREVIEW, {}, content_type="application/json", **self.headers).status_code, 405)


class LegacyEndpointTests(Base):
    LEGACY = "/api/production-shift-config"

    def test_the_legacy_config_endpoint_works_as_before(self):
        b = self.client.get(self.LEGACY, **self.headers).json()
        self.assertEqual(
            (b["punch1Time"], b["punch2Time"], b["punch3Time"], b["punch4Time"], b["graceMinutes"]),
            ("08:30", "12:45", "13:30", "20:00", 10),
        )
        self.assertIn("segments", b)
        self.assertEqual(self.client.get("/api/production-shift-segments", **self.headers).status_code, 200)

    def test_editing_the_legacy_punch_times_does_not_touch_the_new_rules_and_is_echoed(self):
        rules_before = {k: v for k, v in self.doc().items()}
        r = self.client.put(
            self.LEGACY,
            {"punch1Time": "09:00", "graceMinutes": 12},
            content_type="application/json",
            **self.headers,
        )
        self.assertEqual(r.status_code, 200)
        self.assertEqual(r.json()["graceMinutes"], 12)
        body = self.body()
        self.assertEqual({k: v for k, v in body.items() if k not in READ_ONLY_KEYS}, rules_before)
        self.assertEqual((body["legacy"]["punch1Time"], body["legacy"]["graceMinutes"]), ("09:00", 12))

    def test_a_save_here_does_not_touch_the_legacy_endpoint_figures(self):
        self.put({"graceMinutes": 7})
        b = self.client.get(self.LEGACY, **self.headers).json()
        self.assertEqual(b["graceMinutes"], 10)


# ═══ the audit trail ═══════════════════════════════════════════════════════════════════════════════════════════════


class AuditTests(Base):
    def entries(self):
        return AuditLog.objects.filter(module="production_shift_rules")

    def test_a_save_is_audited_with_the_old_and_new_values(self):
        self.assertEqual(self.put({"graceMinutes": 7, "roundingMode": "down"}).status_code, 200)
        entry = self.entries().get()
        self.assertEqual((entry.action, entry.user_name, entry.user_type), ("update", "Asha HR", "hr"))
        self.assertEqual(entry.old_values, {"graceMinutes": 5, "roundingMode": "nearest"})
        self.assertEqual(entry.new_values, {"graceMinutes": 7, "roundingMode": "down"})
        self.assertEqual(entry.record_description, "Changed production shift rules: grace minutes, rounding mode")

    def test_a_table_change_keeps_the_old_and_the_new_table(self):
        doc = self.doc()
        self.rule(self.day(doc), "17:45")["shiftValue"] = 1.1
        self.assertEqual(self.put(doc).status_code, 200)
        entry = self.entries().get()
        self.assertEqual(set(entry.new_values), {"groups"})
        old_day = next(g for g in entry.old_values["groups"] if g["label"] == "Day shift")
        new_day = next(g for g in entry.new_values["groups"] if g["label"] == "Day shift")
        old_rule = next(r for r in old_day["rules"] if r["outTime"] == "17:45")
        new_rule = next(r for r in new_day["rules"] if r["outTime"] == "17:45")
        self.assertEqual((old_rule["shiftValue"], new_rule["shiftValue"]), (1.0, 1.1))
        self.assertIn("shift groups and rules", entry.record_description)

    def test_breaks_are_audited_too(self):
        doc = self.doc()
        self.brk(doc, "Lunch")["endTime"] = "13:45"
        self.put(doc)
        entry = self.entries().get()
        self.assertEqual(set(entry.new_values), {"breaks"})
        self.assertIn("breaks", entry.record_description)

    def test_a_refused_save_and_a_no_op_leave_no_audit_row(self):
        self.put({"graceMinutes": 99})
        self.put(self.body())
        self.put({"graceMinutes": 5})
        self.get()
        self.preview({"punches": ["08:30", "20:00"], "date": THURSDAY})
        self.assertEqual(self.entries().count(), 0)

    def test_the_branch_of_a_head_office_login_is_recorded_as_none(self):
        self.put({"graceMinutes": 7})
        self.assertIsNone(self.entries().get().branch_id)

    def test_updated_by_and_at_follow_the_last_save(self):
        self.assertEqual((self.body()["updatedBy"], self.body()["updatedAt"]), (None, None))
        who = role_headers({"settings.attendance": "edit"}, name="Meena HR")
        self.put({"graceMinutes": 7}, who)
        b = self.body()
        self.assertEqual(b["updatedBy"], "Meena HR")
        stamp = datetime.fromisoformat(b["updatedAt"])
        self.assertEqual(stamp.utcoffset().total_seconds(), 5.5 * 3600)  # IST
        self.put({"graceMinutes": 8})
        self.assertEqual(self.body()["updatedBy"], "Asha HR")

    def test_the_activity_pages_know_the_new_module(self):
        self.assertIn("production_shift_rules", dict(AUDIT_MODULES))
        self.assertEqual(activity_rules.area_of("production_shift_rules"), ("settings", "Settings"))
        rule = activity_rules.classify(
            "update", "production_shift_rules", "Changed production shift rules: grace minutes"
        )
        self.assertEqual((rule.id, rule.severity, rule.category), ("production-shift-rules", "high", "settings"))


# ═══ warnings ══════════════════════════════════════════════════════════════════════════════════════════════════════


def make_payroll(period_start: date, period_end: date, code="WARN1") -> Payroll:
    emp = Employee.objects.create(
        employee_code=code, first_name=code, last_name="Worker", employment_type="production", status="active"
    )
    return Payroll.objects.create(
        employee=emp,
        salary_mode="shift",
        month=period_end.month,
        year=period_end.year,
        base_salary=Decimal("500"),
        gross_salary=Decimal("500"),
        final_salary=Decimal("500"),
        period_start=period_start,
        period_end=period_end,
    )


class WarningTests(Base):
    def test_a_start_date_in_the_past_warns_once_when_it_is_set(self):
        r = self.put({"effectiveFrom": "2026-10-01"})
        self.assertEqual(r.status_code, 200)
        self.assertTrue(
            any("2026-10-01, which is in the past" in w for w in r.json()["warnings"]), r.json()["warnings"]
        )
        again = self.put({"effectiveFrom": "2026-10-01"})  # not a change: no new warning, and the GET never repeats it
        self.assertFalse(any("in the past" in w for w in again.json()["warnings"]))
        self.assertFalse(any("in the past" in w for w in self.body()["warnings"]))

    def test_a_date_today_or_later_does_not_warn(self):
        for text in ("2026-10-14", "2026-10-20"):
            r = self.put({"effectiveFrom": text})
            self.assertFalse(any("in the past" in w for w in r.json()["warnings"]), text)

    def test_switching_the_rules_on_again_with_a_past_date_warns(self):
        self.put({"enabled": False})
        self.put({"effectiveFrom": "2026-10-01"})  # off: no warning needed
        r = self.put({"enabled": True})
        self.assertTrue(any("in the past" in w for w in r.json()["warnings"]), r.json()["warnings"])

    def test_payroll_already_generated_for_days_these_rules_judge_warns_when_they_change(self):
        make_payroll(date(2026, 10, 1), date(2026, 10, 15))
        r = self.put({"graceMinutes": 7})
        text = " ".join(r.json()["warnings"])
        self.assertIn("Production payroll up to 2026-10-15 has already been generated", text)
        self.assertIn("regenerate it to apply them", text)
        self.assertEqual(r.status_code, 200)  # advice only: the save happened
        self.assertEqual(ProductionShiftConfig.objects.get(pk=1).rules_grace_minutes, 7)

    def test_the_payroll_warning_needs_a_change_that_matters_and_a_period_the_rules_reach(self):
        make_payroll(date(2026, 10, 1), date(2026, 10, 15))
        # a rename changes no figure
        doc = self.doc()
        self.day(doc)["label"] = "Day (renamed)"
        self.assertFalse(any("already been generated" in w for w in self.put(doc).json()["warnings"]))
        # nothing changed: nothing to say
        self.assertEqual([w for w in self.put(self.body()).json()["warnings"] if "already" in w], [])
        # a payroll that ended before the rules start is not affected
        Payroll.objects.all().delete()
        make_payroll(date(2026, 9, 1), date(2026, 9, 30), code="WARN2")
        self.assertFalse(any("already been generated" in w for w in self.put({"graceMinutes": 8}).json()["warnings"]))

    def test_a_ladder_point_inside_a_break_is_advice_and_not_a_refusal(self):
        def mutate(d):
            rules = self.day(d)["rules"]
            rules[1]["enabled"] = False  # 12:45 off, so 13:00 is a different (and the only) point of that paid time
            rules.insert(2, {"label": "Back from lunch", "outTime": "13:00", "shiftValue": 0.5})

        answer = self.assertSaved(mutate)
        self.assertTrue(
            any(
                "13:00 rule falls inside the Lunch (12:45-13:30), which is unpaid, so it counts as 12:45" in w
                for w in answer["warnings"]
            ),
            answer["warnings"],
        )
        self.assertEqual(answer["warnings"], self.body()["warnings"], "the same advice on the next read")

    def test_a_group_with_no_rule_after_its_departure_is_advice(self):
        def mutate(d):
            d["groups"].append(
                {"label": "Short", "startTime": "06:00", "firstPunchFrom": "01:00", "firstPunchTo": "02:00",
                 "mainOutTime": "14:00", "rules": [{"outTime": "12:00", "shiftValue": 0.5},
                                                   {"outTime": "14:00", "shiftValue": 1}]}
            )  # fmt: skip

        answer = self.assertSaved(mutate)
        self.assertTrue(
            any(w.startswith("Short: there is no rule after the standard departure 14:00") for w in answer["warnings"])
        )
        # advice about what the save touched: the next read does not repeat it
        self.assertFalse(any("no rule after the standard departure" in w for w in self.body()["warnings"]))

    def test_the_cap_advice_names_only_the_groups_the_save_touched(self):
        def edit_sunday(d):
            self.rule(self.sunday(d), "17:00")["label"] = "Sunday full day"

        answer = self.assertSaved(edit_sunday)
        text = " ".join(answer["warnings"])
        self.assertIn("Sunday shift: there is no rule after the standard departure 17:00", text)
        self.assertIn("(the day stays at 1.00)", text)
        self.assertNotIn("Night shift", text)  # its table is just as capped, but this save did not touch it

        def edit_day(d):
            self.rule(self.day(d), "20:00")["label"] = "Main out"

        self.assertEqual(self.assertSaved(edit_day)["warnings"], [])  # the Day ladder goes past its departure

    def test_a_weekday_no_group_covers_is_advice(self):
        def mutate(d):
            self.sunday(d)["enabled"] = False
            self.night(d)["appliesOn"] = "mon_sat"

        answer = self.assertSaved(mutate)
        self.assertTrue(
            any("No enabled shift group applies on Sunday" in w for w in answer["warnings"]), answer["warnings"]
        )
        self.assertFalse(any("No enabled shift group applies on Monday" in w for w in answer["warnings"]))

    def test_a_full_day_value_no_day_can_reach_is_advice(self):
        answer = self.assertSaved(lambda d: d.update(fullDayValue=1.2))
        self.assertTrue(
            any(
                "full-day value 1.20 is more than the most the Sunday shift can pay (1.00)" in w
                for w in answer["warnings"]
            ),
            answer["warnings"],
        )

    def test_switched_off_rules_say_nothing_about_coverage(self):
        def mutate(d):
            d.update(enabled=False)
            self.sunday(d)["enabled"] = False
            self.night(d)["appliesOn"] = "mon_sat"

        answer = self.assertSaved(mutate)
        self.assertFalse(any("No enabled shift group" in w for w in answer["warnings"]))


# ═══ the preview calculator ════════════════════════════════════════════════════════════════════════════════════════


class PreviewTests(Base):
    def calc(self, punches, date_text=THURSDAY, **extra):
        r = self.preview({"punches": punches, "date": date_text, **extra})
        self.assertEqual(r.status_code, 200, r.content)
        return r.json()

    def test_the_answer_has_exactly_the_contract_keys(self):
        a = self.calc(["08:30", "12:45", "13:30", "20:00"])
        self.assertEqual(set(a), {"group", "shifts", "status", "isLate", "earlyLeave", "note", "calculation"})

    def test_the_four_punch_day_is_one_and_a_half_shifts(self):
        a = self.calc(["08:30", "12:45", "13:30", "20:00"])
        self.assertEqual(
            (a["group"], a["shifts"], a["status"], a["isLate"], a["earlyLeave"], a["calculation"]),
            ("Day shift", 1.5, "present", False, False, "rules"),
        )
        self.assertIn("1.50", a["note"])

    def test_the_owners_table_rows(self):
        cases = [
            (["08:30", "10:30"], 0.25),
            (["08:30", "12:45"], 0.5),
            (["08:30", "15:30"], 0.75),
            (["08:30", "17:45"], 1.0),
            (["08:30", "20:00"], 1.5),
            (["08:30", "22:30"], 2.0),
            (["08:30", "12:45", "13:30", "22:30"], 2.0),
            (["08:30", "00:30"], 2.5),
            (["08:30", "05:30"], 3.0),
        ]
        for punches, shifts in cases:
            with self.subTest(punches=punches):
                self.assertEqual(self.calc(punches)["shifts"], shifts)

    def test_the_grace_snaps_a_near_miss_to_the_point(self):
        self.assertEqual(self.calc(["08:30", "17:42"])["shifts"], 1.0)
        between = self.calc(["08:30", "17:40"])
        self.assertLess(between["shifts"], 1.0)
        self.assertEqual(between["status"], "half_shift")

    def test_a_late_first_punch_loses_value_and_is_flagged(self):
        a = self.calc(["09:00", "20:00"])
        self.assertEqual((a["isLate"], a["shifts"]), (True, 1.44))  # 1.50 less the 30 minutes in the first band
        self.assertFalse(self.calc(["08:35", "20:00"])["isLate"])  # inside the 5 minute grace
        self.assertTrue(self.calc(["08:36", "20:00"])["isLate"])

    def test_leaving_before_the_standard_departure_is_flagged(self):
        self.assertTrue(self.calc(["08:30", "15:00"])["earlyLeave"])
        self.assertFalse(self.calc(["08:30", "20:00"])["earlyLeave"])

    def test_the_night_shift_is_typed_across_midnight(self):
        a = self.calc(["21:00", "05:30"])
        self.assertEqual((a["group"], a["shifts"], a["status"]), ("Night shift", 1.5, "present"))
        self.assertEqual(self.calc(["21:00", "00:00"])["shifts"], 0.5)
        full = self.calc(["08:30", "12:45", "13:30", "20:00", "21:00", "05:30"])
        self.assertEqual((full["group"], full["shifts"]), ("Day shift", 3.0))

    def test_sunday_uses_the_sunday_group(self):
        a = self.calc(["08:30", "17:00"], SUNDAY)
        self.assertEqual((a["group"], a["shifts"]), ("Sunday shift", 1.0))
        self.assertEqual(self.calc(["08:30", "20:00"], SUNDAY)["shifts"], 1.0)  # capped until HR adds rows

    def test_no_punches_is_absent_and_one_punch_is_unpaid(self):
        a = self.calc([])
        self.assertEqual((a["status"], a["shifts"], a["group"]), ("absent", 0.0, None))
        one = self.calc(["08:30"])
        self.assertEqual((one["shifts"], one["status"]), (0.0, "half_shift"))
        self.assertIn("only one punch", one["note"])

    def test_a_date_before_the_start_gets_the_old_calculation_and_says_so(self):
        a = self.calc(["08:30", "12:45", "13:30", "20:00"], "2026-10-13")
        self.assertEqual((a["group"], a["calculation"]), ("Old calculation", "legacy"))
        self.assertIn(
            "The new rules start on 2026-10-14, so 2026-10-13 is still judged by the old calculation", a["note"]
        )
        day = date(2026, 10, 13)
        expected = production_day_result(
            day, {day: [psr.time_to_s(t) for t in ("08:30", "12:45", "13:30", "20:00")]}, ruleset=psr.RuleSet()
        )
        self.assertEqual(a["shifts"], float(expected["shifts_earned"]))
        self.assertEqual(a["status"], expected["status"])

    def test_the_old_calculation_ignores_punches_after_midnight(self):
        a = self.calc(["21:00", "05:30"], "2026-10-13")
        self.assertEqual(a["calculation"], "legacy")
        self.assertIn("punches after midnight belong to the next day", a["note"])

    def test_switched_off_rules_are_the_old_calculation(self):
        self.put({"enabled": False})
        a = self.calc(["08:30", "20:00"])
        self.assertEqual((a["group"], a["calculation"]), ("Old calculation", "legacy"))
        self.assertIn("switched off", a["note"])

    def test_it_reads_the_saved_rules_and_ignores_rules_in_the_body(self):
        bogus = [{"label": "x", "startTime": "01:00", "rules": [{"outTime": "02:00", "shiftValue": 9}]}]
        a = self.calc(["08:30", "17:45"], groups=bogus, graceMinutes=0)
        self.assertEqual(a["shifts"], 1.0)
        doc = self.doc()
        self.rule(self.day(doc), "17:45")["shiftValue"] = 1.2
        self.put(doc)
        self.assertEqual(self.calc(["08:30", "17:45"])["shifts"], 1.2)

    def test_the_date_defaults_to_today(self):
        r = self.preview({"punches": ["08:30", "20:00"]})
        self.assertEqual(r.status_code, 200)
        self.assertEqual(r.json()["calculation"], "rules")  # the mocked today is the start day

    def test_a_group_nobody_covers_falls_back_to_the_old_calculation(self):
        def mutate(d):
            self.sunday(d)["enabled"] = False
            self.night(d)["appliesOn"] = "mon_sat"

        self.assertSaved(mutate)
        a = self.calc(["08:30", "17:00"], SUNDAY)
        self.assertEqual((a["group"], a["calculation"]), ("Old calculation", "legacy"))
        self.assertIn("No shift group applies on a Sunday", a["note"])

    def test_every_bad_input_is_a_400_with_a_sentence(self):
        cases = [
            ({"punches": "08:30"}, "'punches' must be a list"),
            ({"punches": [830]}, "'punches' must be a list"),
            ({"punches": None}, "'punches' must be a list"),
            ({}, "'punches' must be a list"),
            ({"punches": ["8.30"]}, "is not a time"),
            ({"punches": ["25:00"]}, "is not a time"),
            ({"punches": ["08:30"] * 25}, "At most 24 punches"),
            ({"punches": ["08:30"], "date": "15/10/2026"}, "'date' must be a date written YYYY-MM-DD"),
            ({"punches": ["08:30"], "date": "2026-02-30"}, "real date"),
            ({"punches": ["08:30"], "date": 5}, "'date' must be a date"),
        ]
        for body, message in cases:
            with self.subTest(body=body):
                r = self.preview(body)
                self.assertEqual(r.status_code, 400, body)
                self.assertIn(message, r.json()["error"])
        self.assertEqual(self.preview([1]).status_code, 400)

    def test_a_double_tap_is_collapsed_before_pairing(self):
        # 08:30, 08:32 (a double tap, under 5 minutes), 20:00: without the rule the pairs would be (08:30, 08:32), 20:00 open
        a = self.calc(["08:30", "08:32", "20:00"])
        self.assertEqual((a["shifts"], a["status"], a["calculation"]), (1.5, "present", "rules"))
        b = self.calc(["08:30", "12:45", "12:47", "13:30", "20:00"])
        self.assertEqual(b["shifts"], self.calc(["08:30", "12:45", "13:30", "20:00"])["shifts"])
        self.assertEqual(self.calc(["08:30", "20:00", "20:03"])["shifts"], 1.5)

    def test_two_punches_five_minutes_apart_are_not_a_double_tap(self):
        a = self.calc(["08:30", "08:35"])
        self.assertEqual(a["status"], "half_shift")
        self.assertLess(a["shifts"], 0.1)

    def test_a_typed_time_with_seconds_is_accepted(self):
        self.assertEqual(self.calc(["08:30:00", "20:00:00"])["shifts"], 1.5)

    def test_the_answer_is_json_numbers(self):
        raw = self.preview({"punches": ["08:30", "20:00"], "date": THURSDAY}).content.decode()
        self.assertIsInstance(json.loads(raw)["shifts"], float)

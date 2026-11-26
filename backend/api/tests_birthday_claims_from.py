"""The birthday-only claims date (owner 2026-11-25, CompensationConfig.birthday_claims_from, migration 0185).

A birthday before claims_from used to follow the old automatic rule (a paid full day whatever the punches, nothing to
claim). Since 2026-11-25 a worked birthday gives Birthday Compensation placed on a chosen date of the birthday month instead
of a credit claim (tests_birthday_compensation); the tests below pin which birthdays follow the new rule. With birthday_claims_from set earlier, the birthdays from that day follow the claim rules: worked = a normal day
plus one 1.00 credit the employee claims by hand (the Department Head approves it), absent = paid birthday leave. OT and
the other claim kinds keep claims_from. The real attendance engine throughout (tests_comp_fix_v.EngineClaimsBase:
today 12 March 2026, claims_from 1 October 2026, the employee's birthday Thursday 5 March).

Run via: python manage.py test api.tests_birthday_claims_from
"""

import importlib
from datetime import date, time
from decimal import Decimal
from types import SimpleNamespace

from django.apps import apps as django_apps

from . import birthday_compensation as bday_comp
from . import compensation_claims as claims
from . import compensation_effects as effects
from . import tests_compensation_engine as base
from .attendance_final import compute_range_records
from .models import AttendanceDayRecord, CompensationConfig, CompensationLedger, HolidayWorkClaim, PayrollSettings
from .tests_comp_fix_v import ENGINE_TODAY, THU, EngineClaimsBase

MON = date(2026, 3, 2)
CLAIMS_FROM = date(2026, 10, 1)  # after the March birthday: without the birthday date it follows the old rule


class BirthdayClaimsFromTests(EngineClaimsBase):
    CODE = "BCF1"

    def setUp(self):
        super().setUp()
        base.set_config(claims_from=CLAIMS_FROM)

    def compute(self, d=THU):
        compute_range_records(self.emp, d, d, PayrollSettings.get())
        return self.stored(d)

    def outcome(self):
        return effects.birthday_outcome(self.emp, THU, refresh=True)

    def birthday_from(self, d):
        return base.set_config(birthday_claims_from=d)

    # ── without the birthday date: unchanged ──

    def test_without_it_a_birthday_before_claims_from_stays_automatic_with_nothing_to_claim(self):
        self.worked(THU, time(17, 30))
        rec = self.compute()
        self.assertEqual((rec.status, rec.shifts_earned, rec.compensation_kind), ("present", Decimal("1.00"), "birthday"))
        self.assertEqual(self.outcome()["outcome"], effects.BIRTHDAY_OLD_RULE)
        r = self.raise_({"kind": "birthday", "date": THU.isoformat()})
        self.assertEqual(r.status_code, 400, r.content)
        self.assertIn("applied automatically", r.json()["error"])

    # ── with it ──

    def test_a_worked_birthday_is_a_normal_day_and_gives_birthday_compensation(self):
        self.birthday_from(date(2026, 3, 1))
        self.worked(THU, time(17, 30), first=time(8, 50))  # late: judged like any day, no birthday cover
        rec = self.compute()
        self.assertNotEqual(rec.compensation_kind, "birthday")
        self.assertTrue(rec.is_late)
        out = self.outcome()
        self.assertEqual(out["outcome"], effects.BIRTHDAY_CREDIT_CLAIMABLE)  # the attendance part: worked
        # 2026-11-25: no credit claim any more; 1.00 day of Birthday Compensation to place in March instead
        r = self.raise_({"kind": "birthday", "date": THU.isoformat()})
        self.assertEqual((r.status_code, r.json()["code"]), (400, "use_birthday_compensation"), r.content)
        ent = bday_comp.entitlement(self.emp, THU, ENGINE_TODAY)
        self.assertEqual((ent.state, ent.available), ("available", Decimal("1.00")))
        self.assertFalse(CompensationLedger.objects.filter(employee=self.emp).exists())

    def test_nothing_is_credited_until_the_employee_claims(self):
        self.birthday_from(date(2026, 3, 1))
        self.worked(THU, time(17, 30))
        self.compute()
        self.outcome()
        self.assertFalse(HolidayWorkClaim.objects.filter(employee=self.emp).exists())
        self.assertFalse(CompensationLedger.objects.filter(employee=self.emp).exists())

    def test_an_absent_birthday_is_paid_birthday_leave(self):
        self.birthday_from(date(2026, 3, 1))
        rec = self.compute()
        self.assertEqual((rec.status, rec.shifts_earned, rec.compensation_kind), ("present", Decimal("1.00"), "birthday"))
        out = self.outcome()
        self.assertEqual((out["outcome"], out["claimable"]), (effects.BIRTHDAY_PAID_LEAVE, False))

    def test_a_worked_day_hr_set_by_hand_still_gives_birthday_compensation(self):
        """The production case: the old automatic birthday was taken off and the worked day kept as an HR override."""
        self.birthday_from(date(2026, 3, 1))
        self.worked(THU, time(17, 30))
        rec = self.compute()
        AttendanceDayRecord.objects.filter(pk=rec.pk).update(source="manual", override_by="HR", compensation_kind="")
        out = self.outcome()
        self.assertEqual((out["outcome"], out["claimable"]), (effects.BIRTHDAY_CREDIT_CLAIMABLE, True))
        # 2026-11-25: it gives Birthday Compensation to place, not a credit
        self.assertEqual(bday_comp.entitlement(self.emp, THU, ENGINE_TODAY).state, "available")

    def test_a_birthday_before_the_birthday_date_keeps_the_old_rule(self):
        self.birthday_from(date(2026, 3, 6))
        self.worked(THU, time(17, 30))
        self.assertEqual(self.compute().compensation_kind, "birthday")
        self.assertEqual(self.outcome()["outcome"], effects.BIRTHDAY_OLD_RULE)
        r = self.raise_({"kind": "birthday", "date": THU.isoformat()})
        self.assertIn("Before Friday 6 Mar 2026", r.json()["error"])

    def test_ot_and_the_late_in_allowance_keep_claims_from(self):
        config = self.birthday_from(date(2026, 3, 1))
        self.assertTrue(config.birthday_claims_apply_on(MON))
        self.assertFalse(config.claims_apply_on(MON))
        self.assertFalse(config.ot_quarter_rule_on(MON))
        ctx = SimpleNamespace(cfg=config)
        self.assertIsNone(claims._old_rule_error(HolidayWorkClaim.KIND_BIRTHDAY, MON, ctx))
        for kind in (HolidayWorkClaim.KIND_OT_ALLOWANCE, HolidayWorkClaim.KIND_OT_SHIFT):
            err = claims._old_rule_error(kind, MON, ctx)
            self.assertIsNotNone(err, kind)
            self.assertIn("Before Thursday 1 Oct 2026", err.message)

    def test_the_hr_birthdays_list_says_when_the_claim_rules_start_and_offers_the_compensation(self):
        self.birthday_from(date(2026, 3, 1))
        self.worked(THU, time(17, 30))
        from unittest import mock

        # the list's own "today" (March is still open: the compensation can be placed)
        with mock.patch("api.compensation_birthday_views.ist_today", return_value=ENGINE_TODAY):
            r = self.client.get(
                "/api/compensation/birthdays", {"period": "month", "date": THU.isoformat()}, **base.hr_headers()
            )
        self.assertEqual(r.status_code, 200, r.content)
        body = r.json()
        self.assertEqual(body["enabled"]["claimsFrom"], "2026-03-01")
        row = next(x for x in body["results"] if x["employeeCode"] == self.CODE)
        self.assertEqual((row["outcome"], row["claimable"], row["applied"]), ("comp_to_place", False, False))
        self.assertEqual(row["birthdayCompensation"]["available"], 1.0)

    def test_the_employee_compensation_page_offers_the_compensation(self):
        from .tests_compensation_claims import _emp_token

        self.birthday_from(date(2026, 3, 1))
        self.worked(THU, time(17, 30))
        r = self.client.get("/api/employee/compensation", **_emp_token(self.emp))
        self.assertEqual(r.status_code, 200, r.content)
        items = [i for i in r.json().get("items", []) if i.get("kind") == "birthday_compensation"]
        self.assertEqual([(i["date"][:10], i["status"]) for i in items], [(THU.isoformat(), "available")])


class BirthdayClaimsFromStrictTests(BirthdayClaimsFromTests):
    MODE = "strict"
    CODE = "BCF2"


class MigrationDataStepTests(EngineClaimsBase):
    CODE = "BCF3"

    def run_step(self):
        module = importlib.import_module("api.migrations.0185_birthday_claims_from")
        module.set_birthday_claims_from(django_apps, None)
        return CompensationConfig.get().birthday_claims_from

    def test_claims_that_started_after_1_november_get_the_birthday_date(self):
        base.set_config(claims_from=date(2026, 11, 19), birthday_claims_from=None)
        self.assertEqual(self.run_step(), date(2026, 11, 1))

    def test_claims_that_started_by_1_november_are_left_alone(self):
        base.set_config(claims_from=date(2026, 10, 1), birthday_claims_from=None)
        self.assertIsNone(self.run_step())

    def test_a_date_already_set_is_never_moved(self):
        base.set_config(claims_from=date(2026, 11, 19), birthday_claims_from=date(2026, 11, 10))
        self.assertEqual(self.run_step(), date(2026, 11, 10))

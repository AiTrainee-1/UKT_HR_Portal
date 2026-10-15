"""Settings -> Compensation API (compensation_settings_views.py): GET / PUT /api/compensation/settings, the read-only
/api/compensation/config, the validation and replace-set rules of the PUT, effective-from handling and the permissions.

Run via: python manage.py test api.tests_compensation_settings -v 2
"""

from datetime import date, time
from decimal import Decimal
from unittest import mock

from django.db import connection
from django.test.utils import CaptureQueriesContext

from . import tests_compensation_engine as base
from .models import (
    AuditLog,
    Branch,
    CompensationConfig,
    CompensationRule,
    HRUser,
    PayrollSettings,
    Role,
    ShiftTemplate,
)

URL = "/api/compensation/settings"
CONFIG = "/api/compensation/config"
TODAY = date(2026, 10, 14)

# the last sentence of the Type 2 ladder warning: the check is advice from the shift templates, never a guarantee
ADVICE = (
    " This is advice only (the settings are saved): the check reads the active staff shift templates, not each "
    "employee's own shift times."
)


def login(permissions: dict, branch=None, name="Perm Test") -> dict:
    role = Role.objects.create(name=f"role-{name}-{len(permissions)}-{Role.objects.count()}", permissions=permissions)
    user = HRUser.objects.create(
        username=f"u-{name}-{HRUser.objects.count()}", password_hash="x", role=role, branch=branch
    )
    return base.bearer({"role": "hr", "hrUserId": user.id, "name": name})


class SettingsBase(base.CompBase):
    CODE = "ST1"

    def setUp(self):
        super().setUp()
        self.headers = base.hr_headers()
        patcher = mock.patch("api.compensation_settings_views.ist_today", return_value=TODAY)
        patcher.start()
        self.addCleanup(patcher.stop)

    def get(self, url=URL, headers=None):
        return self.client.get(url, **(headers or self.headers))

    def put(self, body, headers=None):
        return self.client.put(URL, body, content_type="application/json", **(headers or self.headers))

    def body(self):
        return self.get().json()

    def allowance_rows(self):
        return list(CompensationRule.objects.filter(kind="allowance").order_by("sort_order", "id"))

    def shift_rows(self):
        return list(CompensationRule.objects.filter(kind="shift").order_by("sort_order", "id"))

    def snapshot(self):
        cfg = CompensationConfig.get()
        return (
            {f.name: getattr(cfg, f.name) for f in cfg._meta.fields if f.name != "updated_at"},
            [
                (
                    r.id,
                    r.kind,
                    r.label,
                    r.enabled,
                    r.sort_order,
                    r.min_extra_minutes,
                    r.allowance_minutes,
                    r.until_minutes,
                    r.shifts,
                )
                for r in CompensationRule.objects.order_by("id")
            ],
        )

    def assertRefused(self, body, message_part, status=400):
        before = self.snapshot()
        r = self.put(body)
        self.assertEqual(r.status_code, status, r.content)
        self.assertIn(message_part, r.json()["error"])
        self.assertEqual(self.snapshot(), before, "a refused save must change nothing")


class ReadTests(SettingsBase):
    def test_the_body_has_exactly_the_contract_shape(self):
        b = self.body()
        self.assertEqual(
            set(b),
            {
                "masterEnabled",
                "allowance",
                "shift",
                "windows",
                "holidayWork",
                "birthday",
                "allowanceRules",
                "shiftRules",
                "updatedBy",
                "updatedAt",
            },
        )
        self.assertEqual(b["masterEnabled"], True)
        self.assertEqual(b["allowance"], {"enabled": False, "effectiveFrom": None})
        self.assertEqual(
            b["shift"], {"enabled": False, "minExtraMinutes": 150, "relaxationEnabled": True, "payEnabled": False}
        )
        self.assertEqual(b["windows"], {"enabled": False})
        self.assertEqual(b["holidayWork"], {"enabled": False})
        self.assertEqual(b["birthday"], {"enabled": False, "effectiveFrom": None})

    def test_the_default_rule_tables(self):
        b = self.body()
        self.assertEqual(
            [
                (r["label"], r["minExtraMinutes"], r["allowanceMinutes"], r["enabled"], r["sortOrder"])
                for r in b["allowanceRules"]
            ],
            [
                ("1 hour", 60, 30, True, 1),
                ("1 hour 30 minutes", 90, 30, True, 2),
                ("2 hours", 120, 60, True, 3),
                ("2 hours 30 minutes", 150, 60, True, 4),
            ],
        )
        self.assertEqual(
            [(r["untilMinutes"], r["shifts"], r["enabled"], r["sortOrder"]) for r in b["shiftRules"]],
            [(1260, 0.25, True, 1), (1440, 0.5, True, 2), (1560, 0.75, True, 3), (None, 1.0, True, 4)],
        )
        self.assertTrue(all(isinstance(r["id"], int) for r in b["allowanceRules"] + b["shiftRules"]))
        self.assertEqual(
            set(b["allowanceRules"][0]), {"id", "label", "enabled", "minExtraMinutes", "allowanceMinutes", "sortOrder"}
        )
        self.assertEqual(set(b["shiftRules"][0]), {"id", "label", "enabled", "untilMinutes", "shifts", "sortOrder"})

    def test_master_switch_is_reported_and_does_not_block_reading(self):
        ps = PayrollSettings.get()
        ps.compensation_feature_enabled = False
        ps.save()
        r = self.get()
        self.assertEqual(r.status_code, 200)
        self.assertFalse(r.json()["masterEnabled"])

    def test_the_page_copy_is_identical(self):
        self.assertEqual(self.get(CONFIG).json(), self.get(URL).json())

    def test_updated_by_and_at_after_a_save(self):
        self.assertEqual(self.put({"windows": {"enabled": True}}).status_code, 200)
        b = self.body()
        self.assertEqual(b["updatedBy"], "Asha HR")
        self.assertRegex(b["updatedAt"], r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?\+05:30$")

    def test_a_non_hr_token_is_refused(self):
        emp_headers = base.bearer({"role": "employee", "employeeId": self.emp.id})
        self.assertEqual(self.get(URL, emp_headers).status_code, 403)
        self.assertEqual(self.get(CONFIG, emp_headers).status_code, 403)
        self.assertEqual(self.client.get(URL).status_code, 401)


class WriteTests(SettingsBase):
    def test_a_partial_put_changes_only_what_it_names(self):
        before = self.body()
        r = self.put({"windows": {"enabled": True}, "holidayWork": {"enabled": True}})
        self.assertEqual(r.status_code, 200, r.content)
        after = r.json()
        self.assertEqual((after["windows"], after["holidayWork"]), ({"enabled": True}, {"enabled": True}))
        for key in ("allowance", "shift", "birthday", "allowanceRules", "shiftRules"):
            self.assertEqual(after[key], before[key], key)
        self.assertEqual(after["warnings"], [])

    def test_keys_inside_a_group_are_independent(self):
        self.put({"shift": {"enabled": True, "minExtraMinutes": 180, "payEnabled": True}})
        b = self.body()["shift"]
        self.assertEqual(b, {"enabled": True, "minExtraMinutes": 180, "relaxationEnabled": True, "payEnabled": True})
        self.put({"shift": {"relaxationEnabled": False}})
        self.assertEqual(
            self.body()["shift"],
            {"enabled": True, "minExtraMinutes": 180, "relaxationEnabled": False, "payEnabled": True},
        )

    def test_the_master_switch_off_does_not_block_a_save(self):
        ps = PayrollSettings.get()
        ps.compensation_feature_enabled = False
        ps.save()
        r = self.put({"birthday": {"enabled": True}})
        self.assertEqual(r.status_code, 200, r.content)
        self.assertTrue(CompensationConfig.get().birthday_enabled)

    # ── the settings from before this tab existed follow it (the Report Center and the MD portal still read them) ──
    def test_the_old_ot_settings_follow_the_tab(self):
        def legacy():
            ps = PayrollSettings.get()
            return ps.ot_detection_enabled, ps.ot_threshold_minutes

        self.put({"allowance": {"enabled": False}, "shift": {"enabled": False}})
        self.assertFalse(legacy()[0])
        self.put({"allowance": {"enabled": True}})  # the default allowance rules start at 1 hour
        self.assertEqual(legacy(), (True, 60))
        self.put({"allowance": {"enabled": False}, "shift": {"enabled": True, "minExtraMinutes": 180}})
        self.assertEqual(legacy(), (True, 180))
        self.put({"allowance": {"enabled": True}})  # both on: detection starts at the earlier one
        self.assertEqual(legacy(), (True, 60))
        self.put({"allowance": {"enabled": False}, "shift": {"enabled": False}})
        self.assertFalse(legacy()[0])

    def test_a_refused_save_leaves_the_old_ot_settings_alone(self):
        before = PayrollSettings.get()
        before = (before.ot_detection_enabled, before.ot_threshold_minutes)
        r = self.put({"shift": {"enabled": True, "minExtraMinutes": 0}})
        self.assertEqual(r.status_code, 400)
        after = PayrollSettings.get()
        self.assertEqual((after.ot_detection_enabled, after.ot_threshold_minutes), before)

    # ── effective-from ──
    def test_switching_a_feature_on_stamps_today(self):
        r = self.put({"allowance": {"enabled": True}, "birthday": {"enabled": True}})
        self.assertEqual(r.status_code, 200, r.content)
        b = r.json()
        self.assertEqual(b["allowance"], {"enabled": True, "effectiveFrom": str(TODAY)})
        self.assertEqual(b["birthday"], {"enabled": True, "effectiveFrom": str(TODAY)})

    def test_a_named_date_is_used_even_if_earlier_and_a_later_date_too(self):
        r = self.put(
            {
                "allowance": {"enabled": True, "effectiveFrom": "2026-03-01"},
                "birthday": {"enabled": True, "effectiveFrom": "2026-12-01"},
            }
        )
        b = r.json()
        self.assertEqual(b["allowance"]["effectiveFrom"], "2026-03-01")
        self.assertEqual(b["birthday"]["effectiveFrom"], "2026-12-01")

    def test_switching_off_keeps_the_date_and_switching_on_again_starts_from_today_again(self):
        self.put({"allowance": {"enabled": True, "effectiveFrom": "2026-03-01"}})
        self.put({"allowance": {"enabled": False}})
        self.assertEqual(self.body()["allowance"], {"enabled": False, "effectiveFrom": "2026-03-01"})
        # off -> on without naming a date: the gap while it was off must not be judged retroactively
        self.put({"allowance": {"enabled": True}})
        self.assertEqual(self.body()["allowance"], {"enabled": True, "effectiveFrom": str(TODAY)})

    def test_changing_the_date_of_a_feature_that_is_already_on(self):
        self.put({"birthday": {"enabled": True}})
        self.put({"birthday": {"effectiveFrom": "2026-10-20"}})
        self.assertEqual(self.body()["birthday"], {"enabled": True, "effectiveFrom": "2026-10-20"})

    def test_a_feature_that_is_on_needs_a_date(self):
        self.put({"allowance": {"enabled": True}})
        self.assertRefused({"allowance": {"effectiveFrom": None}}, "effective-from date is required")

    def test_a_feature_that_is_off_may_have_its_date_cleared(self):
        self.put({"allowance": {"enabled": True, "effectiveFrom": "2026-03-01"}})
        self.put({"allowance": {"enabled": False}})
        self.assertEqual(self.put({"allowance": {"effectiveFrom": None}}).status_code, 200)
        self.assertIsNone(self.body()["allowance"]["effectiveFrom"])

    def test_the_effective_from_the_engine_reads_is_the_one_saved(self):
        self.put({"allowance": {"enabled": True, "effectiveFrom": "2026-03-01"}})
        self.worked(base.MON, time(18, 30))
        self.worked(base.TUE, time(17, 40), first=time(9, 5))
        self.assertFalse(self.rec(base.TUE).is_late)
        self.put({"allowance": {"effectiveFrom": "2026-03-03"}})  # the OT day is now before it
        self.assertTrue(self.rec(base.TUE).is_late)

    # ── validation ──
    def test_group_and_value_types(self):
        self.assertRefused({"allowance": "yes"}, "'allowance' must be an object")
        self.assertRefused({"windows": {"enabled": "yes"}}, "'enabled' must be true or false")
        self.assertRefused({"birthday": {"enabled": 1}}, "'enabled' must be true or false")
        self.assertRefused({"allowance": {"enabled": True, "effectiveFrom": "yesterday"}}, "must be a date")
        self.assertRefused({"shift": {"minExtraMinutes": "x"}}, "whole number")
        self.assertRefused({"shift": {"minExtraMinutes": 0}}, "between 1 and 1440")
        self.assertRefused({"shift": {"minExtraMinutes": 1441}}, "between 1 and 1440")
        self.assertRefused({"allowanceRules": "x"}, "must be a list")
        self.assertRefused({"allowanceRules": ["x"]}, "must be an object")
        self.assertEqual(self.client.put(URL, "[1]", content_type="application/json", **self.headers).status_code, 400)

    def test_allowance_rule_validation(self):
        rows = [{"label": "x", "enabled": True, "minExtraMinutes": 60, "allowanceMinutes": 30}]
        self.assertRefused({"allowanceRules": [{**rows[0], "allowanceMinutes": 241}]}, "between 0 and 240")
        self.assertRefused({"allowanceRules": [{**rows[0], "allowanceMinutes": -5}]}, "between 0 and 240")
        self.assertRefused({"allowanceRules": [{**rows[0], "minExtraMinutes": 0}]}, "at least 1")
        self.assertRefused({"allowanceRules": [{**rows[0], "minExtraMinutes": None}]}, "at least 1")
        self.assertRefused({"allowanceRules": [rows[0], {**rows[0], "allowanceMinutes": 45}]}, "both start at 1 hour")
        self.assertRefused({"allowanceRules": [{**rows[0], "label": "x" * 81}]}, "longer than 80")
        self.assertRefused({"allowanceRules": [{**rows[0], "enabled": "no"}]}, "'enabled' must be true or false")
        r = self.put(
            {
                "allowanceRules": [
                    {**rows[0], "allowanceMinutes": 240},
                    {**rows[0], "minExtraMinutes": 61, "allowanceMinutes": 0},
                ]
            }
        )
        self.assertEqual(r.status_code, 200, r.content)

    def test_shift_rule_validation(self):
        ok = [{"untilMinutes": 1260, "shifts": 0.25}, {"untilMinutes": None, "shifts": 1}]
        self.assertEqual(self.put({"shiftRules": ok}).status_code, 200)
        self.assertRefused({"shiftRules": [{"untilMinutes": None, "shifts": 0.3}]}, "0.25, 0.50, 0.75 or 1")
        self.assertRefused({"shiftRules": [{"untilMinutes": None, "shifts": 2}]}, "0.25, 0.50, 0.75 or 1")
        self.assertRefused(
            {
                "shiftRules": [
                    {"untilMinutes": 1440, "shifts": 0.25},
                    {"untilMinutes": 1260, "shifts": 0.5},
                    {"untilMinutes": None, "shifts": 1},
                ]
            },
            "later than the row before it",
        )
        self.assertRefused(
            {
                "shiftRules": [
                    {"untilMinutes": 1260, "shifts": 0.25},
                    {"untilMinutes": 1260, "shifts": 0.5},
                    {"untilMinutes": None, "shifts": 1},
                ]
            },
            "later than the row before it",
        )
        self.assertRefused(
            {"shiftRules": [{"untilMinutes": None, "shifts": 0.25}, {"untilMinutes": 1440, "shifts": 1}]},
            "not the last row",
        )
        self.assertRefused(
            {"shiftRules": [{"untilMinutes": 1260, "shifts": 0.25}, {"untilMinutes": 1440, "shifts": 1}]},
            "must have no time limit",
        )
        self.assertRefused({"shiftRules": [{"untilMinutes": 0, "shifts": 1}]}, "between")
        self.assertRefused({"shiftRules": [{"untilMinutes": 9999, "shifts": 1}]}, "between")

    def test_a_disabled_row_out_of_order_is_fine(self):
        rows = [
            {"untilMinutes": 1440, "shifts": 0.5},
            {"untilMinutes": 1000, "shifts": 0.25, "enabled": False},
            {"untilMinutes": None, "shifts": 1},
        ]
        self.assertEqual(self.put({"shiftRules": rows}).status_code, 200)

    def test_an_enabled_feature_needs_an_enabled_rule(self):
        self.assertRefused({"allowance": {"enabled": True}, "allowanceRules": []}, "no enabled rule")
        self.assertRefused(
            {
                "allowance": {"enabled": True},
                "allowanceRules": [{"minExtraMinutes": 60, "allowanceMinutes": 30, "enabled": False}],
            },
            "no enabled rule",
        )
        self.assertRefused({"shift": {"enabled": True}, "shiftRules": []}, "no enabled shift rule")
        # the same with the rule table untouched but emptied earlier
        self.assertEqual(self.put({"allowanceRules": []}).status_code, 200)  # off: an empty table is allowed
        self.assertRefused({"allowance": {"enabled": True}}, "no enabled rule")
        self.assertRefused(
            {"shift": {"enabled": True, "relaxationEnabled": False, "payEnabled": False}}, "Relaxation, Pay or both"
        )

    def test_an_emptied_table_cannot_be_left_under_a_feature_that_is_on(self):
        self.put({"allowance": {"enabled": True}})
        self.assertRefused({"allowanceRules": []}, "no enabled rule")

    def test_nothing_is_saved_when_any_part_is_wrong(self):
        self.assertRefused(
            {"windows": {"enabled": True}, "allowanceRules": [{"minExtraMinutes": 0, "allowanceMinutes": 30}]},
            "at least 1",
        )
        self.assertFalse(CompensationConfig.get().windows_enabled)

    # ── the rule arrays REPLACE the set ──
    def test_items_with_an_id_are_updated_items_without_one_are_created_missing_ids_are_deleted(self):
        rows = self.body()["allowanceRules"]
        keep_first, keep_second = rows[0], rows[1]
        payload = [
            {**keep_first, "allowanceMinutes": 45, "label": "One hour (edited)"},
            {**keep_second},
            {"label": "New", "minExtraMinutes": 30, "allowanceMinutes": 15},  # created
        ]  # the 2 h and 2 h 30 rows are not in the array: deleted
        r = self.put({"allowanceRules": payload})
        self.assertEqual(r.status_code, 200, r.content)
        after = r.json()["allowanceRules"]
        self.assertEqual(len(after), 3)
        self.assertEqual([x["id"] for x in after[:2]], [keep_first["id"], keep_second["id"]])  # the same rows, kept
        self.assertEqual((after[0]["label"], after[0]["allowanceMinutes"]), ("One hour (edited)", 45))
        self.assertIsNone(next((x for x in after if x["minExtraMinutes"] in (120, 150)), None))
        new = after[2]
        self.assertEqual(
            (new["label"], new["minExtraMinutes"], new["allowanceMinutes"], new["enabled"], new["sortOrder"]),
            ("New", 30, 15, True, 3),
        )
        self.assertNotIn(new["id"], [r["id"] for r in rows])
        self.assertEqual(CompensationRule.objects.filter(kind="allowance").count(), 3)
        self.assertEqual(CompensationRule.objects.filter(kind="shift").count(), 4)  # the other table is untouched

    def test_the_order_sent_is_the_order_of_the_table(self):
        rows = self.body()["shiftRules"]  # 1260, 1440, 1560, no limit
        # an explicit sortOrder decides the table order, whatever order the array arrives in
        sent = [{**r, "sortOrder": i + 1} for i, r in enumerate(rows)]
        ok = self.put({"shiftRules": list(reversed(sent))})
        self.assertEqual(ok.status_code, 200, ok.content)
        self.assertEqual([x["untilMinutes"] for x in ok.json()["shiftRules"]], [1260, 1440, 1560, None])
        self.assertEqual([x["sortOrder"] for x in ok.json()["shiftRules"]], [1, 2, 3, 4])
        # without a sortOrder the array order IS the table order: the open row sent first is refused
        no_sort = [{k: v for k, v in r.items() if k != "sortOrder"} for r in reversed(rows)]
        self.assertRefused({"shiftRules": no_sort}, "not the last row")

    def test_a_blank_label_gets_a_readable_one(self):
        r = self.put(
            {
                "allowanceRules": [{"minExtraMinutes": 45, "allowanceMinutes": 20}],
                "shiftRules": [
                    {"untilMinutes": 1200, "shifts": 0.25},
                    {"untilMinutes": None, "shifts": 1, "label": "  "},
                ],
            }
        )
        b = r.json()
        self.assertEqual(b["allowanceRules"][0]["label"], "45 minutes")
        self.assertEqual([x["label"] for x in b["shiftRules"]], ["Up to 8:00 PM", "No time limit"])

    def test_a_rule_that_belongs_to_the_other_table_or_does_not_exist_is_refused(self):
        shift_id = self.body()["shiftRules"][0]["id"]
        self.assertRefused(
            {"allowanceRules": [{"id": shift_id, "minExtraMinutes": 60, "allowanceMinutes": 30}]}, "no longer exists"
        )
        self.assertRefused(
            {"allowanceRules": [{"id": 99999999, "minExtraMinutes": 60, "allowanceMinutes": 30}]}, "no longer exists"
        )
        a = self.body()["allowanceRules"][0]
        self.assertRefused({"allowanceRules": [a, {**a, "minExtraMinutes": 61}]}, "used twice")

    def test_omitting_the_arrays_leaves_the_rules_alone(self):
        before = self.snapshot()[1]
        self.put({"windows": {"enabled": True}})
        self.assertEqual(self.snapshot()[1], before)

    def test_the_engine_uses_the_saved_rules(self):
        self.put(
            {
                "allowance": {"enabled": True, "effectiveFrom": "2026-03-01"},
                "allowanceRules": [{"label": "Half an hour", "minExtraMinutes": 30, "allowanceMinutes": 15}],
            }
        )
        self.worked(base.MON, time(18, 0))  # 30 minutes
        self.worked(base.TUE, time(17, 40), first=time(8, 55))
        r = self.rec(base.TUE)
        self.assertFalse(r.is_late)  # on time until 08:55 (08:30 + 15 + 10 grace) ... 08:55 is on the limit
        self.assertEqual(r.compensation_kind, "ot_allowance")

    def test_a_warning_when_an_allowance_row_can_never_apply(self):
        r = self.put({"allowance": {"enabled": True}, "shift": {"minExtraMinutes": 120}})
        self.assertEqual(r.status_code, 200)
        warnings = r.json()["warnings"]
        self.assertEqual(len(warnings), 1)
        self.assertIn("2 hours 30 minutes", warnings[0])
        self.assertIn("2 hours", warnings[0])

    def test_saving_is_audited(self):
        self.put({"windows": {"enabled": True}})
        log = AuditLog.objects.filter(module="compensation_settings", action="update").first()
        self.assertIsNotNone(log)
        self.assertIn("windows_enabled", log.record_description)


class LadderReachWarningTests(SettingsBase):
    """The Type 2 ladder is keyed on the day's LAST punch, but the attendance engine attaches a punch stamped on the NEXT
    calendar date to the working day only up to a cut-off (the shift end plus the Forgotten Last-Out Grace, never closer to
    tomorrow's shift start than the pre-shift buffer); every punch on the shift's own date counts. A ladder row that starts
    at or beyond that cut-off can never be earned, and the save says so (advice: it still saves).

    Fixture: shift 08:30-17:30, grace 9 h, buffer 2 h -> a Monday exit counts up to 02:30 on Tuesday (1590 minutes after
    Monday's midnight), so the default ladder (its last row starts at 02:00) is fine.
    """

    CODE = "LR1"

    def setUp(self):
        super().setUp()
        ps = PayrollSettings.get()
        self.assertEqual(
            (ps.last_punch_post_shift_grace_hours, ps.first_punch_pre_shift_buffer_hours),
            (Decimal("9.0"), Decimal("2.0")),
        )

    def engine(self, grace=None, buffer=None):
        ps = PayrollSettings.get()
        if grace is not None:
            ps.last_punch_post_shift_grace_hours = Decimal(str(grace))
        if buffer is not None:
            ps.first_punch_pre_shift_buffer_hours = Decimal(str(buffer))
        ps.save()

    @staticmethod
    def ladder(*untils):
        """A ladder payload: one row per limit named ("Row 1" ...) and a last row, "Later", with no limit."""
        steps = [0.25, 0.5, 0.75, 1]
        rows = [
            {"label": f"Row {i}", "untilMinutes": until, "shifts": steps[min(i - 1, 3)]}
            for i, until in enumerate(untils, start=1)
        ]
        return rows + [{"label": "Later", "untilMinutes": None, "shifts": 1}]

    def save_type2(self, *untils, **shift):
        """Switch Type 2 on (with this ladder when limits are named, else the table as it is) and return the warnings."""
        body = {"shift": {"enabled": True, **shift}}
        if untils:
            body["shiftRules"] = self.ladder(*untils)
        r = self.put(body)
        self.assertEqual(r.status_code, 200, r.content)
        return r.json()["warnings"]

    def test_the_default_ladder_on_the_default_shift_has_nothing_to_warn_about(self):
        self.assertEqual(self.save_type2(), [])
        self.assertNotIn("warnings", self.body())  # the GET body keeps its exact shape

    def test_the_engine_counts_up_to_the_time_the_warning_quotes(self):
        def extra(next_date_punch):
            self.punch(base.MON, time(8, 30), time(13, 0), time(14, 0), next_date_times=[next_date_punch])
            return self.rec(base.MON).ot_extra_minutes

        # 17:30 + 9 h = 02:30: that exit is still Monday's (25 h 30 - 17:30), one minute later it is Tuesday's first punch
        self.assertEqual((extra(time(2, 30)), extra(time(2, 31))), (540, 0))
        # 17:30 + 6 h = 23:30 never reaches Tuesday: nothing stamped Tuesday is Monday's, everything stamped Monday is
        self.engine(grace=6)
        self.worked(base.MON, time(23, 45))
        self.assertEqual(self.rec(base.MON).ot_extra_minutes, 375)
        self.assertEqual(extra(time(0, 30)), 0)
        # tomorrow's 08:30 start less an 8 h buffer = 00:30 caps the 9 h grace
        self.engine(grace=9, buffer=8)
        self.assertEqual((extra(time(0, 30)), extra(time(0, 31))), (420, 0))

    def test_a_row_that_starts_after_the_latest_counted_punch_warns_and_the_save_still_happens(self):
        r = self.put({"shift": {"enabled": True}, "shiftRules": self.ladder(1260, 1440, 1620)})
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(
            r.json()["warnings"],
            [
                "The 'Later' shift row can only be earned by a punch at 3:00 AM (next day) or later, but the latest punch the "
                "system counts for the 5:30 PM shift is 2:30 AM (next day): a later punch counts as the next "
                "morning's first punch (the cut-off comes from Forgotten Last-Out Grace in Settings > Attendance), so "
                "this row cannot be earned." + ADVICE
            ],
        )
        self.assertTrue(CompensationConfig.get().shift_enabled)
        self.assertEqual([x["untilMinutes"] for x in r.json()["shiftRules"]], [1260, 1440, 1620, None])

    def test_the_boundary_is_the_minute_the_engine_stops_counting(self):
        self.assertEqual(
            self.save_type2(1260, 1440, 1589), []
        )  # the last row begins at 02:29: a punch at 02:29 earns it
        # the row starts at 02:30, the last moment the engine counts (a punch AT the cut-off still counts): it is not
        # called unearnable, it is said to need a punch at exactly that time
        (warning,) = self.save_type2(1260, 1440, 1590)
        self.assertIn("so only a punch at exactly 2:30 AM (next day) can earn this row.", warning)
        self.assertNotIn("cannot be earned", warning)
        self.assertNotIn("never", warning)
        (warning,) = self.save_type2(1260, 1440, 1591)
        self.assertIn("can only be earned by a punch at 2:31 AM (next day) or later", warning)
        self.assertIn("so this row cannot be earned.", warning)
        self.assertNotIn("exactly", warning)

    def test_the_boundary_row_with_rows_after_it_says_those_cannot_be_earned(self):
        # Row 3 (from 02:30, until 04:20) is the boundary row; "Later" after it starts even later
        (warning,) = self.save_type2(1260, 1590, 1700)
        self.assertIn("The 'Row 3' shift row can only be earned by a punch at 2:30 AM (next day) or later", warning)
        self.assertIn(
            "so only a punch at exactly 2:30 AM (next day) can earn this row, and the rows after it cannot be earned.",
            warning,
        )

    def test_a_grace_that_ends_before_midnight_leaves_only_the_shifts_own_day(self):
        self.engine(grace=6)  # 17:30 + 6 h = 23:30: no Tuesday punch is Monday's, every Monday punch (to 23:59) is
        self.assertEqual(
            self.save_type2(),
            [
                "The '12:00 AM up to 2:00 AM' shift row can only be earned by a punch at 12:00 AM (next day) or later, but "
                "the latest punch the system counts for the 5:30 PM shift is 11:59 PM: a later punch counts as the "
                "next morning's first punch (the cut-off comes from Forgotten Last-Out Grace in Settings > "
                "Attendance), so this row and the rows after it cannot be earned." + ADVICE
            ],
        )

    def test_a_grace_of_zero_switches_the_reattribution_off_so_nothing_after_midnight_counts(self):
        self.engine(grace=0)
        warnings = self.save_type2()
        self.assertEqual(len(warnings), 1)
        self.assertIn("'12:00 AM up to 2:00 AM'", warnings[0])
        self.assertIn("is 11:59 PM", warnings[0])
        self.assertIn("Forgotten Last-Out Grace", warnings[0])
        self.assertNotIn("Early-Arrival", warnings[0])

    def test_the_buffer_before_tomorrows_shift_start_shortens_the_reach(self):
        self.engine(buffer=8)  # 08:30 less 8 h = 00:30 (1470) instead of 02:30: the default 2:00 AM row is out of reach
        warnings = self.save_type2()
        self.assertEqual(len(warnings), 1)
        self.assertIn("'2:00 AM and later'", warnings[0])
        self.assertIn("is 12:30 AM (next day)", warnings[0])
        self.assertIn("so this row cannot be earned", warnings[0])  # the last row: nothing after it
        # the buffer cap is what binds here: raising the grace changes nothing, so the grace must not be blamed
        self.assertIn(
            "(the cut-off comes from Next-Day Early-Arrival Protection in Settings > Attendance, which reserves the "
            "hours before tomorrow's shift start for tomorrow's own first punch)",
            warnings[0],
        )
        self.assertNotIn("Forgotten Last-Out Grace", warnings[0])

    def test_when_the_grace_and_the_buffer_cap_agree_both_settings_are_named(self):
        # 17:30 + 9 h and 08:30 - 6 h are both 02:30 tomorrow: neither setting alone moves the cut-off
        self.engine(grace=9, buffer=6)
        (warning,) = self.save_type2(1260, 1440, 1590)
        self.assertIn("is 2:30 AM (next day)", warning)
        self.assertIn(
            "comes from both Forgotten Last-Out Grace and Next-Day Early-Arrival Protection in Settings", warning
        )
        # a grace that ends before midnight AND a buffer cap that does too: nothing after midnight counts, both bind
        self.engine(grace=6, buffer=18)
        (warning,) = self.save_type2()
        self.assertIn("is 11:59 PM", warning)
        self.assertIn(
            "comes from both Forgotten Last-Out Grace and Next-Day Early-Arrival Protection in Settings", warning
        )

    def test_the_binding_limit_is_the_one_the_engine_applies_for_each_reach(self):
        # a long grace is shortened by the buffer cap (grace 9 h would reach 02:30, the cap stops at 00:30)
        self.engine(grace=9, buffer=8)
        self.assertIn(
            "comes from Next-Day Early-Arrival Protection in Settings > Attendance, which", self.save_type2()[0]
        )
        # and a short grace is the limit when the cap is further away than the grace
        self.engine(grace=9, buffer=2)
        self.assertEqual(self.save_type2(), [])
        self.engine(grace=6, buffer=2)
        (warning,) = self.save_type2()
        self.assertIn("comes from Forgotten Last-Out Grace in Settings", warning)

    def test_the_warning_says_it_is_advice_from_the_shift_templates(self):
        warnings = self.save_type2(1260, 1440, 1620)
        self.assertTrue(warnings[0].endswith(ADVICE), warnings[0])
        self.assertIn("active staff shift templates", warnings[0])
        self.assertIn("not each employee's own shift times", warnings[0])

    def test_only_enabled_rows_are_the_ladder(self):
        rows = [
            {"label": "A", "untilMinutes": 1260, "shifts": 0.25},
            {"label": "B", "untilMinutes": 1440, "shifts": 0.5},
            {"label": "C", "untilMinutes": 1620, "shifts": 0.75, "enabled": False},
            {"label": "D", "untilMinutes": None, "shifts": 1},
        ]
        r = self.put({"shift": {"enabled": True}, "shiftRules": rows})
        self.assertEqual(r.json()["warnings"], [])  # with C off, D begins at 12:00 AM: reachable
        rows[2]["enabled"] = True
        warnings = self.put({"shiftRules": rows}).json()["warnings"]
        self.assertEqual(len(warnings), 1)
        self.assertIn("The 'D' shift row", warnings[0])

    def test_a_later_ending_shift_can_earn_a_row_the_first_shift_cannot(self):
        base.make_shift(name="Late", start_time=time(11, 0), end_time=time(20, 0))  # 20:00 + 9 h = 05:00
        self.assertEqual(self.save_type2(1260, 1440, 1620), [])
        warnings = self.save_type2(1260, 1440, 1800)
        self.assertEqual(len(warnings), 1)
        self.assertIn("'Later' shift row can only be earned by a punch at 6:00 AM (next day) or later", warnings[0])
        self.assertIn("any staff shift (the furthest is the 8:00 PM shift) is 5:00 AM (next day)", warnings[0])

    def test_a_threshold_so_high_that_even_the_first_row_is_out_of_reach(self):
        warnings = self.save_type2(minExtraMinutes=1000)  # more than 16 h 40 past 17:30: after 10:10 AM tomorrow
        self.assertEqual(
            warnings,
            [
                "Type 2 only starts at 10:11 AM (next day), because it needs more than 16 hours 40 minutes of extra "
                "work after the shift end, so the 'Up to 9:00 PM' shift row (up to 9:00 PM) is never reached. The "
                "latest punch the system counts for the 5:30 PM shift is 2:30 AM (next day): a later punch counts as "
                "the next morning's first punch (the cut-off comes from Forgotten Last-Out Grace in Settings > "
                "Attendance), so this row and the rows after it cannot be earned." + ADVICE
            ],
        )
        # a row never "begins" after its own limit
        self.assertNotIn("begins", warnings[0])
        self.assertNotIn("can only be earned by a punch at", warnings[0])

    def test_a_threshold_that_starts_type_2_exactly_at_the_last_counted_minute(self):
        # 17:30 + 539 minutes + 1 = 02:30 tomorrow: the cut-off itself, so only a punch at exactly that time can earn it
        (warning,) = self.save_type2(minExtraMinutes=539)
        self.assertIn(
            "Type 2 only starts at 2:30 AM (next day), because it needs more than 8 hours 59 minutes", warning
        )
        self.assertIn("so only a punch at exactly 2:30 AM (next day) can earn Type 2 on it.", warning)
        self.assertNotIn("cannot be earned", warning)
        self.assertEqual(self.save_type2(minExtraMinutes=538), [])  # one minute earlier: a punch at 02:29 earns the row

    def test_a_threshold_that_lands_inside_a_row_beyond_the_reach_names_where_the_row_can_be_earned(self):
        # the first row runs up to 09:20 tomorrow, but 17:30 + 600 minutes + 1 puts the first earnable minute at 03:31
        (warning,) = self.save_type2(2000, minExtraMinutes=600)
        self.assertIn("The 'Row 1' shift row can only be earned by a punch at 3:31 AM (next day) or later", warning)
        self.assertIn("so this row and the rows after it cannot be earned.", warning)
        self.assertNotIn("never reached", warning)
        self.assertNotIn("begins", warning)

    def test_production_and_inactive_shifts_are_not_staff_shifts_in_use(self):
        base.make_shift(name="Prod", shift_type="production", start_time=time(8, 30), end_time=time(23, 0))
        base.make_shift(name="Old", start_time=time(10, 0), end_time=time(22, 0), is_active=False)
        warnings = self.save_type2(1260, 1440, 1620)
        self.assertEqual(len(warnings), 1)
        self.assertIn("for the 5:30 PM shift is 2:30 AM", warnings[0])

    def test_no_staff_shift_at_all_means_nothing_to_compare_with(self):
        ShiftTemplate.objects.all().delete()
        self.assertEqual(self.save_type2(1260, 1440, 1620), [])
        # a lone overnight template is no help either: the engine attaches no next-date punch to it
        base.make_shift(name="Night", start_time=time(21, 0), end_time=time(6, 0))
        self.assertEqual(self.save_type2(1260, 1440, 1620), [])

    def test_nothing_is_said_while_shift_compensation_is_off(self):
        r = self.put({"shiftRules": self.ladder(1260, 1440, 1620)})
        self.assertEqual((r.status_code, r.json()["warnings"]), (200, []))
        self.assertFalse(CompensationConfig.get().shift_enabled)
        # switching it on judges the table as saved, although this save does not send it
        warnings = self.put({"shift": {"enabled": True}}).json()["warnings"]
        self.assertEqual(len(warnings), 1)
        self.assertIn("The 'Later' shift row", warnings[0])
        self.assertEqual(self.put({"shift": {"enabled": False}}).json()["warnings"], [])

    def test_it_sits_beside_the_other_warnings_without_replacing_them(self):
        self.engine(grace=6)
        r = self.put({"allowance": {"enabled": True}, "shift": {"enabled": True, "minExtraMinutes": 120}})
        warnings = r.json()["warnings"]
        self.assertEqual(len(warnings), 2)
        self.assertIn("allowance can never apply", warnings[0])
        self.assertIn("shift row can only be earned by a punch at", warnings[1])

    def test_the_check_costs_the_same_however_many_shifts_and_rules_there_are(self):
        self.save_type2(1260, 1440, 1620)

        def cost():
            with CaptureQueriesContext(connection) as ctx:
                self.assertEqual(self.put({"holidayWork": {"enabled": True}}).status_code, 200)
            return len(ctx), sum('"shift_templates"' in q["sql"] for q in ctx.captured_queries)

        self.put({"holidayWork": {"enabled": True}})  # a first save of a change costs a little more than a repeat
        one_shift = cost()
        for n in range(6):
            base.make_shift(name=f"Extra {n}", start_time=time(7 + n, 0), end_time=time(16 + n, 0))
        self.assertEqual(cost(), one_shift)
        self.assertEqual(one_shift[1], 1)  # one query for every shift
        self.save_type2(*range(1000, 1700, 100))  # a ladder of eight rows instead of four
        self.assertEqual(cost(), one_shift)
        # and none at all while Type 2 is off
        self.put({"shift": {"enabled": False}})
        with CaptureQueriesContext(connection) as ctx:
            self.put({"holidayWork": {"enabled": False}})
        self.assertFalse(any('"shift_templates"' in q["sql"] for q in ctx.captured_queries))


class PermissionTests(SettingsBase):
    def test_a_role_with_the_settings_compensation_key_can_read_and_write(self):
        who = login({"settings.compensation": "edit"})
        self.assertEqual(self.get(URL, who).status_code, 200)
        self.assertEqual(self.put({"windows": {"enabled": True}}, who).status_code, 200)

    def test_the_settings_parent_grant_cascades_to_the_tab(self):
        who = login({"settings": "edit"})
        self.assertEqual(self.put({"windows": {"enabled": True}}, who).status_code, 200)

    def test_view_only_reads_but_cannot_write(self):
        who = login({"settings.compensation": "view"})
        self.assertEqual(self.get(URL, who).status_code, 200)
        r = self.put({"windows": {"enabled": True}}, who)
        self.assertEqual(r.status_code, 403)
        self.assertFalse(CompensationConfig.get().windows_enabled)

    def test_the_compensation_page_permission_is_not_enough_for_the_settings_tab(self):
        who = login({"compensation": "edit"})
        self.assertEqual(self.get(URL, who).status_code, 403)
        self.assertEqual(self.put({"windows": {"enabled": True}}, who).status_code, 403)
        # ... but it reads the read-only copy the page uses
        self.assertEqual(self.get(CONFIG, who).status_code, 200)

    def test_the_settings_tab_permission_is_not_enough_for_the_page_copy(self):
        who = login({"settings.compensation": "edit"})
        self.assertEqual(self.get(CONFIG, who).status_code, 403)

    def test_a_role_with_neither_is_refused(self):
        who = login({"payroll": "edit"})
        self.assertEqual(self.get(URL, who).status_code, 403)
        self.assertEqual(self.get(CONFIG, who).status_code, 403)

    def test_a_branch_login_may_read_but_not_change_company_wide_rules(self):
        north = Branch.objects.create(name="North", code="N")
        who = login({"settings.compensation": "edit"}, branch=north)
        self.assertEqual(self.get(URL, who).status_code, 200)
        r = self.put({"windows": {"enabled": True}}, who)
        self.assertEqual(r.status_code, 403)
        self.assertEqual(r.json()["code"], "company_wide_settings")
        self.assertFalse(CompensationConfig.get().windows_enabled)

    def test_the_registry_knows_the_new_tab_and_maps_the_url(self):
        from .permission_registry import MODULE_TREE, all_module_keys, resolve_module, resolve_permission

        self.assertIn("settings.compensation", all_module_keys())
        settings_node = next(n for n in MODULE_TREE if n["key"] == "settings")
        self.assertIn({"key": "settings.compensation", "label": "Compensation"}, settings_node["children"])
        self.assertEqual(resolve_module("compensation/settings"), "settings.compensation")
        self.assertEqual(resolve_module("compensation/config"), "compensation")
        self.assertEqual(resolve_module("compensation/ot/assign"), "compensation")
        self.assertEqual(resolve_permission({"settings": "view"}, "settings.compensation"), "view")
        self.assertEqual(
            resolve_permission({"settings": "view", "settings.compensation": "edit"}, "settings.compensation"), "edit"
        )


class ConfigDefaultsTests(SettingsBase):
    def test_a_missing_config_row_comes_back_with_everything_off(self):
        CompensationConfig.objects.all().delete()
        b = self.body()
        self.assertEqual(
            (b["allowance"]["enabled"], b["shift"]["enabled"], b["windows"]["enabled"], b["birthday"]["enabled"]),
            (False,) * 4,
        )
        self.assertEqual(Decimal(str(b["shiftRules"][0]["shifts"])), Decimal("0.25"))

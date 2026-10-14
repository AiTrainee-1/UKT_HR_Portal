"""Settings -> Compensation API (compensation_settings_views.py): GET / PUT /api/compensation/settings, the read-only
/api/compensation/config, the validation and replace-set rules of the PUT, effective-from handling and the permissions.

Run via: python manage.py test api.tests_compensation_settings -v 2
"""

from datetime import date, time
from decimal import Decimal
from unittest import mock

from . import tests_compensation_engine as base
from .models import AuditLog, Branch, CompensationConfig, CompensationRule, HRUser, PayrollSettings, Role

URL = "/api/compensation/settings"
CONFIG = "/api/compensation/config"
TODAY = date(2026, 10, 14)


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

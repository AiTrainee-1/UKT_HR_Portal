"""The contract every assistant tool must meet (md_portal/assistant/tools_base.py). This walks the registry, so a tool
added by any analytics module is checked automatically: well-formed, runs read-only on an empty database, returns
plain JSON with provenance, stays small."""

import json

from django.test import SimpleTestCase

from .md_portal.assistant import registry
from .md_portal.assistant.tools_base import NAME_PATTERN, ToolSpec, coerce, integer_param, tool
from .md_portal.common import MdParamError, read_only_db
from .md_portal.pages import PAGE_IDS
from .tests_md_support import MdApiTestCase

MAX_RESULT_CHARS = 60_000  # ~15k tokens; the engine trims further, but a tool must not start out this big


class ToolContract(MdApiTestCase):
    def test_every_tool_is_well_formed_and_runs_read_only(self):
        tools = registry.all_tools()
        for name, spec in tools.items():
            with self.subTest(tool=name):
                self.assertRegex(name, NAME_PATTERN)
                self.assertGreaterEqual(len(spec.description), 40, "say when to use it and what it returns")
                self.assertIn(spec.page, PAGE_IDS, "the page that shows the same data")
                json.dumps(spec.declaration())

                missing = [r for r in spec.required if r not in spec.example]
                self.assertFalse(missing, f"give the tool an example= with {missing} so it can be tested")

                with read_only_db():
                    result = spec.run(dict(spec.example))
                self.assertIsInstance(result, dict)
                text = json.dumps(result)  # no default=: dates and Decimals must already be plain JSON
                self.assertLess(len(text), MAX_RESULT_CHARS)
                self.assertIsInstance(result.get("provenance"), list)
                self.assertTrue(result["provenance"], "explain how the figures are made (common.prov)")

    def test_tool_names_are_unique_across_modules(self):
        registry.clear_cache()
        registry.all_tools()  # raises on a duplicate or a malformed name


class FindReports(MdApiTestCase):
    def find(self, query, **kw):
        from .md_portal.assistant.report_tools import FIND_REPORTS

        with read_only_db():
            return FIND_REPORTS.run({"query": query, **kw})

    def test_finds_the_report_that_matches_the_words_asked_for(self):
        result = self.find("overtime by department")
        self.assertGreater(result["matches"], 0)
        self.assertTrue(all("where" in r and r["id"] in r["where"] for r in result["reports"]))
        top = " ".join(r["title"].lower() + " " + r["description"].lower() for r in result["reports"][:3])
        self.assertIn("overtime", top)

    def test_a_small_typo_still_finds_it(self):
        self.assertGreater(self.find("overtme")["matches"], 0)

    def test_nothing_matches_gibberish_and_the_limit_is_respected(self):
        self.assertEqual(self.find("zzzqqq xxyyzz")["reports"], [])
        self.assertLessEqual(len(self.find("attendance", limit=2)["reports"]), 2)

    def test_the_md_only_executive_reports_are_findable_by_the_md(self):
        from .reporting.registry import all_specs

        executive = [s for s in all_specs() if s.md_only]
        for spec in executive:
            titles = [r["title"] for r in self.find(spec.title)["reports"]]
            self.assertIn(spec.title, titles)


class ToolBuilder(SimpleTestCase):
    def build(self, **kw):
        calls = []

        def fn(**kwargs):
            calls.append(kwargs)
            return {"provenance": []}

        spec = tool("sample_tool", "A sample tool used by the tests of the builder itself.", fn, page="dashboard", **kw)
        return spec, calls

    def test_period_and_scope_parameters_are_added_and_resolved(self):
        spec, calls = self.build(period="last_7_days")
        self.assertIn("period", spec.properties)
        self.assertIn("branch", spec.properties)
        spec.run({"period": "this_month"})
        self.assertEqual(calls[0]["period"].preset, "this_month")
        self.assertTrue(calls[0]["scope"].is_everyone())

    def test_a_tool_without_a_period_takes_none(self):
        spec, calls = self.build()
        self.assertNotIn("period", spec.properties)
        spec.run({})
        self.assertNotIn("period", calls[0])

    def test_extra_parameters_are_coerced_defaulted_and_clamped(self):
        spec, calls = self.build(
            extra={"limit": integer_param("How many", minimum=1, maximum=20)}, defaults={"limit": 5}, scope=False
        )
        spec.run({})
        spec.run({"limit": "7"})
        spec.run({"limit": 500})
        spec.run({"limit": 0})
        self.assertEqual([c["limit"] for c in calls], [5, 7, 20, 1])

    def test_a_missing_required_parameter_is_reported(self):
        spec, _ = self.build(extra={"code": {"type": "string", "description": "x"}}, required=("code",), scope=False)
        with self.assertRaises(MdParamError):
            spec.run({})

    def test_a_bad_value_is_a_param_error_the_model_can_correct(self):
        with self.assertRaises(MdParamError):
            coerce("limit", {"type": "integer"}, "many")
        with self.assertRaises(MdParamError):
            coerce("type", {"type": "string", "enum": ["staff", "production"]}, "contract")
        self.assertEqual(coerce("type", {"type": "string", "enum": ["staff", "production"]}, "Staff"), "staff")
        self.assertIs(coerce("flag", {"type": "boolean"}, "yes"), True)

    def test_a_parameter_cannot_clash_with_the_period_and_scope_ones(self):
        with self.assertRaises(ValueError):
            self.build(period="last_7_days", extra={"branch": {"type": "string", "description": "x"}})

    def test_the_declaration_is_what_gemini_expects(self):
        spec, _ = self.build(period="last_30_days")
        decl = spec.declaration()
        self.assertEqual(decl["name"], "sample_tool")
        self.assertEqual(decl["parameters"]["type"], "object")
        self.assertIsInstance(decl, dict) and self.assertIsInstance(spec, ToolSpec)

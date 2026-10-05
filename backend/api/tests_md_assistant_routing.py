"""Describing only the relevant tools in full (md_portal/assistant/routing.py)."""

import json

from django.test import SimpleTestCase

from .md_portal.assistant import engine, registry, routing
from .tests_md_assistant_support import ScriptedClient, make_conversation, sample_tool, submit_reply
from .tests_md_support import MdApiTestCase


class SelectingAreas(SimpleTestCase):
    def areas(self, text, page=None):
        return routing.select_areas(text, page)

    def test_the_words_of_a_question_point_at_its_areas(self):
        self.assertIn("attendance", self.areas("How many absentees did we have last week?"))
        self.assertIn("payroll", self.areas("Why did the salary cost go up?"))
        self.assertIn("visitors", self.areas("How many outpasses were taken?"))
        self.assertIn("tea-break", self.areas("Which department overruns the tea break?"))
        self.assertIn("recruitment", self.areas("How many vacancies are open and who resigned?"))
        self.assertIn("activity", self.areas("Who logged in after hours?"))
        self.assertIn("employees", self.areas("What is our attrition and headcount?"))

    def test_plurals_and_endings_still_match(self):
        self.assertIn("attendance", self.areas("absenteeism and absences, lateness"))
        self.assertIn("recruitment", self.areas("hiring candidates"))

    def test_the_broad_areas_are_always_there_and_so_is_the_page_the_md_is_on(self):
        self.assertEqual(self.areas("hello there"), {"dashboard", "reports"})
        self.assertEqual(self.areas("hello there", "payroll"), {"dashboard", "reports", "payroll"})
        self.assertEqual(self.areas("hello", "not-a-page"), {"dashboard", "reports"})

    def test_a_follow_up_with_no_keywords_rides_on_the_earlier_question_and_the_page(self):
        self.assertIn("payroll", self.areas("Why did payroll change? And by department?"))
        self.assertIn("attendance", self.areas("And by department?", "attendance"))

    def test_at_most_three_matched_areas_are_chosen(self):
        everything = "absent payroll salary visitor tea break hiring vacancy audit log headcount attrition"
        matched = self.areas(everything) - routing.ALWAYS
        self.assertLessEqual(len(matched), routing.MAX_MATCHED_AREAS)


class Declarations(MdApiTestCase):
    def tools(self):
        return {
            "attendance_summary": sample_tool("attendance_summary"),
            "payroll_summary": sample_tool("payroll_summary"),
        }

    def test_selected_tools_are_full_and_the_rest_are_one_line_but_all_are_declared(self):
        tools = self.tools()
        tools["payroll_summary"] = type(tools["payroll_summary"])(
            **{**tools["payroll_summary"].__dict__, "page": "payroll"}
        )
        decls = routing.declarations_for(tools, {"attendance"})
        by_name = {d["name"]: d for d in decls}
        self.assertEqual(set(by_name), {"attendance_summary", "payroll_summary"})
        full, compact = by_name["attendance_summary"], by_name["payroll_summary"]
        self.assertIn("description", full["parameters"]["properties"]["period"])  # explained
        self.assertNotIn("description", compact["parameters"]["properties"]["period"])  # bare
        self.assertLessEqual(len(compact["description"]), routing.SUMMARY_CHARS)
        self.assertEqual(decls[0]["name"], "attendance_summary")  # the relevant ones first

    def test_a_compact_declaration_keeps_what_is_needed_to_call_the_tool(self):
        from .md_portal.assistant.tools_base import integer_param, string_param, tool

        spec = tool(
            "sample_with_params",
            "First sentence of the description. A second sentence that is cut. And a third one.",
            lambda **kw: {},
            page="payroll",
            period="last_30_days",
            extra={"kind": string_param("which kind", enum=["a", "b"]), "limit": integer_param("how many", minimum=1)},
            required=("kind",),
        )
        decl = routing.compact_declaration(spec)
        self.assertEqual(decl["description"], "First sentence of the description.")
        self.assertEqual(decl["parameters"]["required"], ["kind"])
        self.assertEqual(decl["parameters"]["properties"]["kind"], {"type": "string", "enum": ["a", "b"]})
        self.assertEqual(decl["parameters"]["properties"]["limit"], {"type": "integer"})
        json.dumps(decl)

    def test_the_real_tool_list_is_much_smaller_than_describing_everything(self):
        tools = registry.all_tools()
        everything = len(json.dumps([t.declaration() for t in tools.values()]))
        routed = len(
            json.dumps(routing.declarations_for(tools, routing.select_areas("why did payroll change?", "payroll")))
        )
        self.assertLess(routed, everything * 0.7)

    def test_every_real_tool_is_still_declared_exactly_once(self):
        tools = registry.all_tools()
        names = [d["name"] for d in routing.declarations_for(tools, routing.select_areas("absent staff", "attendance"))]
        self.assertEqual(sorted(names), sorted(tools))


class InTheEngine(MdApiTestCase):
    def test_the_request_describes_the_question_s_area_in_full_and_still_offers_the_others(self):
        from .models import MdAssistantSettings  # noqa: F401

        _, pending = make_conversation(self.md, "How was attendance this week?", page_context={"page": "attendance"})
        client = ScriptedClient([submit_reply()])
        tools = {
            "attendance_summary": sample_tool("attendance_summary"),
            "payroll_summary": sample_tool("payroll_summary"),
        }
        tools["payroll_summary"] = type(tools["payroll_summary"])(
            **{**tools["payroll_summary"].__dict__, "page": "payroll"}
        )
        engine.answer_message(pending.id, client=client, tools=tools)
        declared = {d["name"]: d for d in client.calls[0]["tools"]}
        self.assertEqual({"attendance_summary", "payroll_summary", "query_data", "submit_answer"}, set(declared))
        self.assertIn("description", declared["attendance_summary"]["parameters"]["properties"]["period"])
        self.assertNotIn("description", declared["payroll_summary"]["parameters"]["properties"]["period"])

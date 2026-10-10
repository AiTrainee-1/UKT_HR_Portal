"""The assistant's tool loop (md_portal/assistant/engine.py) driven by a scripted Gemini: what it sends, how it runs
tools read-only, the explanation it builds, privacy, limits and every way Gemini can fail."""

from datetime import timedelta
from unittest import mock

from django.utils import timezone

from .md_portal.assistant import engine
from .md_portal.assistant.gemini import GeminiError
from .md_portal.assistant.tools_base import tool
from .md_portal.common import MdParamError, envelope
from .models import Branch, Department, Employee, MdAssistantSettings, MdAssistantUsage, MdMessage
from .tests_md_assistant_support import (
    ScriptedClient,
    call_reply,
    make_conversation,
    sample_tool,
    submit_reply,
    text_reply,
)
from .tests_md_support import MdApiTestCase


class EngineCase(MdApiTestCase):
    def setUp(self):
        super().setUp()
        self.settings = MdAssistantSettings.load()

    def run_question(self, replies, *, tools=None, question="How was attendance?", **message_fields):
        conversation, pending = make_conversation(self.md, question, **message_fields)
        client = ScriptedClient(replies)
        engine.answer_message(
            pending.id, client=client, tools=tools if tools is not None else {"attendance_summary": sample_tool()}
        )
        pending.refresh_from_db()
        return pending, client, conversation


class TheAnswerFlow(EngineCase):
    def test_a_lookup_then_the_answer_with_an_explanation_built_from_what_really_happened(self):
        msg, client, _ = self.run_question(
            [
                call_reply(("attendance_summary", {"period": "last_7_days"})),
                submit_reply(
                    suggested_pages=[
                        {"page": "attendance", "reason": "Detailed breakdown"},
                        {"page": "nowhere", "reason": "x"},
                    ],
                    follow_ups=["And last month?"],
                    assumptions=["Staff and production together."],
                    confidence="high",
                ),
            ]
        )
        self.assertEqual(msg.status, "done", msg.error)
        self.assertEqual(msg.content, "**91.8%** attendance.")
        p = msg.payload
        self.assertEqual(p["spokenSummary"], "Attendance was ninety one point eight percent.")
        self.assertEqual(p["answerType"], "answer")
        # steps come from the real tool call, not the model's say-so
        self.assertEqual([s["tool"] for s in p["steps"]], ["attendance_summary"])
        self.assertTrue(p["steps"][0]["ok"])
        self.assertEqual(p["steps"][0]["period"], "Last 7 days")
        self.assertEqual(p["steps"][0]["rows"], 1200)
        # data used = the tool's provenance
        self.assertEqual(p["dataUsed"][0]["dataset"], "Attendance day records")
        self.assertEqual(p["dataUsed"][0]["formula"], "present ÷ scheduled")
        self.assertIn("Today is provisional.", p["dataUsed"][0]["caveats"])
        # a caveat lowers confidence from the model's "high" to what the evidence supports
        self.assertEqual(p["confidence"], "medium")
        # only real pages are suggested, with their path
        self.assertEqual(
            p["suggestedPages"],
            [
                {
                    "id": "attendance",
                    "title": "Staff Attendance",
                    "path": "/md/attendance/staff",
                    "reason": "Detailed breakdown",
                }
            ],
        )
        self.assertEqual(p["followUps"], ["And last month?"])
        self.assertIn("Staff and production together.", p["assumptions"])
        self.assertEqual(p["reasoning"], ["I looked at attendance."])
        self.assertEqual(p["model"], "gemini-test")
        self.assertEqual(p["usage"]["requests"], 2)
        self.assertEqual(client.requests_made, 2)

    def test_the_second_request_carries_the_models_turn_verbatim_and_a_matching_function_response(self):
        _, client, _ = self.run_question([call_reply(("attendance_summary", {})), submit_reply()])
        second = client.calls[1]["contents"]
        self.assertEqual(second[-2]["role"], "model")
        self.assertEqual(second[-2]["parts"][0]["thoughtSignature"], "sig-abc")  # replayed untouched
        response = second[-1]["parts"][0]["functionResponse"]
        self.assertEqual((second[-1]["role"], response["name"], response["id"]), ("user", "attendance_summary", "c0"))
        self.assertEqual(response["response"]["result"]["attendancePct"], 91.8)
        self.assertNotIn("provenance", response["response"]["result"])  # the explanation stays on the server

    def test_a_period_the_model_did_not_give_is_reported_as_an_assumption(self):
        msg, _, _ = self.run_question([call_reply(("attendance_summary", {})), submit_reply()])
        self.assertTrue(any("no period was given" in a for a in msg.payload["assumptions"]), msg.payload["assumptions"])

    def test_requests_for_several_figures_at_once_are_answered_in_one_turn(self):
        tools = {"attendance_summary": sample_tool(), "attendance_trend": sample_tool("attendance_trend")}
        msg, client, _ = self.run_question(
            [call_reply(("attendance_summary", {}), ("attendance_trend", {})), submit_reply()], tools=tools
        )
        parts = client.calls[1]["contents"][-1]["parts"]
        self.assertEqual([p["functionResponse"]["id"] for p in parts], ["c0", "c1"])
        self.assertEqual(len(msg.payload["steps"]), 2)
        self.assertEqual(client.requests_made, 2)

    def test_an_identical_lookup_is_not_run_twice(self):
        calls = []
        base = sample_tool()
        counting = tool(
            "attendance_summary",
            base.description,
            lambda **kw: calls.append(1) or base.run({}),
            page="attendance",
            period="last_30_days",
        )
        self.run_question(
            [
                call_reply(("attendance_summary", {"period": "today"})),
                call_reply(("attendance_summary", {"period": "today"})),
                submit_reply(),
            ],
            tools={"attendance_summary": counting},
        )
        self.assertEqual(len(calls), 1)

    def test_the_final_round_forces_the_answer_tool(self):
        self.settings.max_tool_rounds = 1
        self.settings.save()
        _, client, _ = self.run_question([call_reply(("attendance_summary", {})), submit_reply()])
        self.assertIsNone(client.calls[0]["allowed"])
        self.assertEqual(client.calls[1]["allowed"], ["submit_answer"])

    def test_history_is_the_earlier_questions_and_answers_only(self):
        conversation, pending = make_conversation(self.md, "How was attendance?")
        MdMessage.objects.filter(pk=pending.pk).update(status="done", content="**91.8%**.")
        MdMessage.objects.create(conversation=conversation, role="user", content="And last month?")
        follow = MdMessage.objects.create(conversation=conversation, role="assistant", status="pending")
        client = ScriptedClient([submit_reply()])
        engine.answer_message(follow.id, client=client, tools={})
        roles = [(c["role"], c["parts"][0]["text"]) for c in client.calls[0]["contents"]]
        self.assertEqual(roles, [("user", "How was attendance?"), ("model", "**91.8%**."), ("user", "And last month?")])

    def test_the_system_prompt_knows_the_page_the_md_is_looking_at(self):
        _, client, _ = self.run_question(
            [submit_reply()],
            page_context={
                "page": "payroll",
                "title": "Payroll Analysis",
                "filters": {"Month": "Sep 2026"},
                "summary": {"Gross": "₹4.2 Cr"},
            },
        )
        system = client.calls[0]["system"]
        self.assertIn("Payroll Analysis", system)
        self.assertIn("Month: Sep 2026", system)
        self.assertIn("Gross: ₹4.2 Cr", system)
        self.assertIn("attendance: Staff Attendance", system)  # the pages it may suggest

    def test_free_text_instead_of_the_answer_tool_is_accepted_with_low_confidence(self):
        msg, _, _ = self.run_question([text_reply("Attendance was good.")])
        self.assertEqual(msg.status, "done")
        self.assertEqual(msg.content, "Attendance was good.")
        self.assertEqual(msg.payload["confidence"], "low")

    def test_a_half_formed_reply_is_retried_once(self):
        msg, client, _ = self.run_question([text_reply("<call:default_api:attendance_summary>"), submit_reply()])
        self.assertEqual(msg.status, "done")
        self.assertEqual(client.requests_made, 2)

    def test_answering_before_the_lookups_came_back_still_gets_every_call_a_response(self):
        msg, client, _ = self.run_question(
            [
                call_reply(
                    ("attendance_summary", {}),
                    (
                        "submit_answer",
                        {"answer_type": "answer", "answer": "early", "spoken_summary": "x", "explanation": []},
                    ),
                ),
                submit_reply(),
            ]
        )
        self.assertEqual(msg.content, "**91.8%** attendance.")
        parts = client.calls[1]["contents"][-1]["parts"]
        self.assertEqual({p["functionResponse"]["name"] for p in parts}, {"attendance_summary", "submit_answer"})


class ToolsAreRunReadOnlyAndFailSoftly(EngineCase):
    def test_a_tool_that_tries_to_write_is_stopped_by_the_database_and_the_model_is_told(self):
        def writer(*, scope, period):
            Branch.objects.create(name="Sneaky", code="SNK")
            return envelope({}, provenance=[])

        sneaky = tool(
            "sneaky_tool",
            "A tool that tries to write to the database, for the test.",
            writer,
            page="dashboard",
            period="today",
        )
        msg, client, _ = self.run_question(
            [
                call_reply(("sneaky_tool", {})),
                submit_reply(answer_type="cannot_answer", answer="Could not look it up."),
            ],
            tools={"sneaky_tool": sneaky},
        )
        self.assertFalse(Branch.objects.filter(code="SNK").exists())
        response = client.calls[1]["contents"][-1]["parts"][0]["functionResponse"]["response"]
        self.assertIn("error", response)
        self.assertFalse(msg.payload["steps"][0]["ok"])
        self.assertEqual(msg.payload["confidence"], "low")

    def test_a_bad_parameter_comes_back_as_an_error_the_model_can_correct(self):
        def strict(*, scope, period):
            raise MdParamError("No department called 'Stiching'.")

        bad = tool(
            "strict_tool",
            "A tool that rejects its parameters, for the test of the loop.",
            strict,
            page="dashboard",
            period="today",
        )
        _, client, _ = self.run_question([call_reply(("strict_tool", {})), submit_reply()], tools={"strict_tool": bad})
        response = client.calls[1]["contents"][-1]["parts"][0]["functionResponse"]["response"]
        self.assertEqual(response, {"error": "No department called 'Stiching'."})

    def test_an_unknown_tool_is_reported_not_crashed_on(self):
        msg, client, _ = self.run_question([call_reply(("does_not_exist", {})), submit_reply()])
        self.assertEqual(msg.status, "done")
        self.assertIn(
            "no tool called", client.calls[1]["contents"][-1]["parts"][0]["functionResponse"]["response"]["error"]
        )

    def test_a_crashing_tool_does_not_fail_the_whole_answer(self):
        def boom(*, scope, period):
            raise RuntimeError("bug")

        crash = tool(
            "crash_tool", "A tool that crashes, for the test of the loop.", boom, page="dashboard", period="today"
        )
        msg, _, _ = self.run_question([call_reply(("crash_tool", {})), submit_reply()], tools={"crash_tool": crash})
        self.assertEqual(msg.status, "done")
        self.assertFalse(msg.payload["steps"][0]["ok"])


class PrivacyInTheLoop(EngineCase):
    def setUp(self):
        super().setUp()
        branch = Branch.objects.create(name="Priv Unit", code="PV1")
        dept = Department.objects.create(name="Stitching", branch=branch)
        self.ravi = Employee.objects.create(
            employee_code="E-007", first_name="Ravi", last_name="Kumar", department=dept, branch=branch
        )

    def test_names_never_reach_gemini_and_come_back_for_the_md(self):
        msg, client, _ = self.run_question(
            [
                call_reply(("attendance_summary", {})),
                lambda request: submit_reply(
                    answer=f"The best-attending person is @emp-{self.ravi.id}.",
                    spoken_summary=f"@emp-{self.ravi.id} leads.",
                ),
            ],
            tools={"attendance_summary": sample_tool(with_person=True)},
            question="How is Ravi Kumar doing?",
        )
        sent = repr(client.calls)
        self.assertNotIn("Ravi", sent)
        self.assertNotIn("98400", sent)  # contact details never go out
        self.assertNotIn("E-007", sent)
        self.assertIn(f"@emp-{self.ravi.id}", sent)
        self.assertEqual(msg.content, "The best-attending person is Ravi Kumar.")
        self.assertEqual(msg.payload["spokenSummary"], "Ravi Kumar leads.")
        self.assertEqual(msg.payload["privacy"]["enabled"], True)

    def test_with_privacy_mode_off_names_pass_but_contact_details_still_do_not(self):
        self.settings.privacy_mode = False
        self.settings.save()
        _, client, _ = self.run_question(
            [call_reply(("attendance_summary", {})), submit_reply()],
            tools={"attendance_summary": sample_tool(with_person=True)},
        )
        sent = repr(client.calls)
        self.assertIn("Ravi Kumar", sent)
        self.assertNotIn("98400", sent)


class WhenGeminiFails(EngineCase):
    def failing(self, kind, text="x"):
        msg, _, _ = self.run_question([GeminiError(kind, text)])
        return msg

    def test_each_failure_becomes_a_plain_message_for_the_md(self):
        cases = {
            "not_configured": "API key is missing",
            "bad_key": "rejected the server's API key",
            "daily_quota": "used today's free Gemini allowance",
            "overloaded": "very busy",
            "timeout": "took too long",
            "network": "could not reach Gemini",
            "blocked": "declined to answer",
            "not_found": "None of the configured Gemini models",
        }
        for kind, expected in cases.items():
            with self.subTest(kind=kind):
                msg = self.failing(kind)
                self.assertEqual(msg.status, "error")
                self.assertIn(expected, msg.error)
                self.assertEqual(msg.payload["errorKind"], kind)

    def test_the_daily_limit_message_says_when_it_resets(self):
        msg = self.failing("daily_quota")
        self.assertRegex(msg.error, r"resets at about \d{1,2}:\d{2} [AP]M IST")

    def test_a_safety_block_in_the_reply_is_reported(self):
        from .md_portal.assistant.gemini import GeminiReply

        msg, _, _ = self.run_question([GeminiReply(model="m", parts=[], finish_reason="SAFETY")])
        self.assertEqual((msg.status, msg.payload["errorKind"]), ("error", "blocked"))

    def test_forced_function_calling_is_dropped_once_if_the_model_refuses_it(self):
        msg, client, _ = self.run_question([GeminiError("bad_request", "tool_config not supported"), submit_reply()])
        self.assertEqual(msg.status, "done")
        self.assertEqual([c["mode"] for c in client.calls], ["ANY", "AUTO"])

    def test_a_server_that_wants_another_role_for_function_results_is_tried_once_with_it(self):
        msg, client, _ = self.run_question(
            [
                call_reply(("attendance_summary", {})),
                GeminiError("bad_request", "Please use a valid role: user, model."),
                submit_reply(),
            ]
        )
        self.assertEqual(msg.status, "done")
        self.assertEqual([c["contents"][-1]["role"] for c in client.calls[1:]], ["user", "function"])

    def test_a_retry_does_not_use_up_a_lookup_round(self):
        self.settings.max_tool_rounds = 1
        self.settings.save()
        msg, client, _ = self.run_question([text_reply(""), call_reply(("attendance_summary", {})), submit_reply()])
        self.assertEqual(msg.status, "done")
        self.assertEqual(client.requests_made, 3)  # the empty reply was retried, the one lookup still happened

    def test_a_model_that_never_finishes_is_stopped(self):
        self.settings.max_tool_rounds = 1
        self.settings.save()
        endless = [call_reply(("attendance_summary", {"period": f"last_{n}_days"})) for n in (7, 30, 90)] * 3
        msg, client, _ = self.run_question(endless)
        self.assertEqual((msg.status, msg.payload["errorKind"]), ("error", "empty"))
        self.assertLessEqual(client.requests_made, 5)

    def test_an_unexpected_crash_is_reported_without_details(self):
        with mock.patch.object(engine, "run_loop", side_effect=RuntimeError("secret detail")):
            conversation, pending = make_conversation(self.md)
            engine.answer_message(pending.id, client=ScriptedClient([]), tools={})
        pending.refresh_from_db()
        self.assertEqual(pending.status, "error")
        self.assertNotIn("secret", pending.error)

    def test_a_disabled_assistant_does_not_call_gemini(self):
        self.settings.enabled = False
        self.settings.save()
        msg, client, _ = self.run_question([])
        self.assertEqual((msg.status, msg.payload["errorKind"]), ("error", "disabled"))
        self.assertEqual(client.calls, [])


class JobBookkeeping(EngineCase):
    def test_a_finished_message_is_not_worked_on_again(self):
        msg, client, conversation = self.run_question([submit_reply()])
        engine.answer_message(msg.id, client=ScriptedClient([]), tools={})  # would raise if it asked Gemini
        self.assertEqual(msg.status, "done")

    def test_a_job_whose_worker_died_is_closed_with_a_clear_message(self):
        _, pending = make_conversation(self.md)
        MdMessage.objects.filter(pk=pending.pk).update(
            status="running", started_at=timezone.now() - timedelta(minutes=10)
        )
        pending.refresh_from_db()
        closed = engine.expire_if_stale(pending)
        self.assertEqual((closed.status, closed.payload["errorKind"]), ("error", "interrupted"))

    def test_a_recent_job_is_left_alone(self):
        _, pending = make_conversation(self.md)
        MdMessage.objects.filter(pk=pending.pk).update(status="running", started_at=timezone.now())
        pending.refresh_from_db()
        self.assertEqual(engine.expire_if_stale(pending).status, "running")

    def test_progress_is_recorded_while_it_works(self):
        msg, _, _ = self.run_question([call_reply(("attendance_summary", {})), submit_reply()])
        labels = [p["label"] for p in msg.payload["progress"]]
        self.assertIn("Reading your question", labels)
        self.assertTrue(any(label.startswith("Looking at attendance summary") for label in labels))
        self.assertTrue(all(p["state"] in ("done", "error") for p in msg.payload["progress"]))

    def test_usage_is_counted_per_model_per_day(self):
        engine.record_usage("gemini-x", call_reply(), None)
        engine.record_usage("gemini-x", call_reply(), None)
        engine.record_usage("gemini-x", None, GeminiError("daily_quota", "limit"))
        row = MdAssistantUsage.objects.get(model="gemini-x")
        self.assertEqual((row.requests, row.prompt_tokens, row.daily_limit_hit), (3, 200, True))
        self.assertEqual(engine.usage_today()["requests"], 3)

    def test_stopping_an_answer_closes_it_and_the_running_job_does_not_overwrite_that(self):
        conversation, pending = make_conversation(self.md)

        def stop_while_gemini_is_thinking(request):
            engine.cancel(MdMessage.objects.get(pk=pending.pk))
            return submit_reply()

        engine.answer_message(pending.id, client=ScriptedClient([stop_while_gemini_is_thinking]), tools={})
        pending.refresh_from_db()
        self.assertEqual(
            (pending.status, pending.error, pending.payload["errorKind"]), ("error", "Stopped.", "cancelled")
        )
        self.assertEqual(pending.content, "")  # the answer that arrived afterwards was discarded

    def test_a_job_stopped_before_its_next_step_makes_no_more_requests(self):
        conversation, pending = make_conversation(self.md)

        def stop_after_the_first_lookup(request):
            engine.cancel(MdMessage.objects.get(pk=pending.pk))
            return call_reply(("attendance_summary", {}))

        client = ScriptedClient([stop_after_the_first_lookup])
        engine.answer_message(pending.id, client=client, tools={"attendance_summary": sample_tool()})
        self.assertEqual(client.requests_made, 1)  # it did not ask Gemini again

    def test_only_an_answer_in_progress_can_be_stopped(self):
        msg, _, _ = self.run_question([submit_reply()])
        self.assertFalse(engine.cancel(msg))
        self.assertEqual(msg.status, "done")

    def test_the_limit_counts_as_hit_only_when_every_model_is_out(self):
        for model in ("gemini-3.5-flash-lite", "gemini-3.1-flash-lite"):
            engine.record_usage(model, None, GeminiError("daily_quota", "limit"))
        self.assertFalse(engine.usage_today()["limitHit"])  # the third model (gemini-3.8-flash) still answers
        engine.record_usage("gemini-3.8-flash", None, GeminiError("daily_quota", "limit"))
        self.assertTrue(engine.usage_today()["limitHit"])
        engine.record_usage("gemini-3.8-flash", call_reply(), None)  # it answered again: no longer exhausted
        self.assertFalse(engine.usage_today()["limitHit"])

    def test_the_model_chain_is_the_primary_then_the_fallbacks_without_repeats(self):
        s = MdAssistantSettings(model="a", fallback_models="b, a ,c,,")
        self.assertEqual(engine.model_chain(s), ["a", "b", "c"])


class TheAnswerIsCleanedUp(EngineCase):
    def test_numbering_and_bullets_the_model_adds_to_the_explanation_are_removed(self):
        msg, _, _ = self.run_question(
            [
                submit_reply(
                    explanation=["1. Checked the exceptions.", "2) Compared with last month.", "- Ranked them.", "  "]
                )
            ]
        )
        self.assertEqual(
            msg.payload["reasoning"], ["Checked the exceptions.", "Compared with last month.", "Ranked them."]
        )

    def test_a_missing_spoken_summary_is_made_from_the_answer(self):
        msg, _, _ = self.run_question(
            [
                call_reply(
                    (
                        "submit_answer",
                        {
                            "answer_type": "answer",
                            "answer": "**14 people** were absent.\n- Stitching had 6.",
                            "explanation": [],
                        },
                    )
                )
            ]
        )
        self.assertEqual(msg.payload["spokenSummary"], "14 people were absent. Stitching had 6.")

    def test_an_empty_answer_becomes_an_honest_cannot_answer(self):
        msg, _, _ = self.run_question(
            [call_reply(("submit_answer", {"answer_type": "answer", "answer": " ", "explanation": []}))]
        )
        self.assertEqual(msg.payload["answerType"], "cannot_answer")

    def test_page_suggestions_are_limited_to_two_distinct_real_pages(self):
        pages = [{"page": p, "reason": "r"} for p in ("payroll", "payroll", "attendance", "employees")]
        msg, _, _ = self.run_question([submit_reply(suggested_pages=pages)])
        self.assertEqual([p["id"] for p in msg.payload["suggestedPages"]], ["payroll", "attendance"])

    def test_a_clarifying_question_has_low_confidence_and_no_data_claims(self):
        msg, _, _ = self.run_question([submit_reply(answer_type="clarification", answer="Which month do you mean?")])
        self.assertEqual(msg.payload["answerType"], "clarification")
        self.assertEqual(msg.payload["confidence"], "low")

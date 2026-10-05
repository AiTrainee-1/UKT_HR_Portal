"""The assistant's HTTP API (md_portal/assistant/views.py, admin_views.py): asking, polling, history, voice upload, and
the super administrator's settings."""

import json
from unittest import mock

from django.core.files.uploadedfile import SimpleUploadedFile
from django.test import TestCase

from .jwt_utils import sign_token
from .md_portal.assistant import engine
from .md_portal.assistant.gemini import GeminiError
from .models import AuditLog, HRUser, MdAssistantSettings, MdConversation, MdMessage
from .tests_md_assistant_support import ScriptedClient, call_reply, sample_tool, submit_reply
from .tests_md_support import make_md, md_headers

ENV = {"GEMINI_API_KEY": "AIzaFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKE12"}


def headers(user):
    return {"HTTP_AUTHORIZATION": f"Bearer {sign_token({'role': 'hr', 'hrUserId': user.id})}"}


class Base(TestCase):
    def setUp(self):
        self.md = make_md()
        self.admin = HRUser.objects.create(username="root", password_hash="x", is_super_admin=True)
        self.clerk = HRUser.objects.create(username="clerk", password_hash="x")
        patcher = mock.patch.dict("os.environ", ENV)
        patcher.start()
        self.addCleanup(patcher.stop)

    def ask(self, question="How was attendance?", client=None, **body):
        client = client or ScriptedClient([call_reply(("attendance_summary", {})), submit_reply()])
        with (
            mock.patch.object(engine, "build_client", return_value=client),
            mock.patch.object(engine, "all_tools", return_value={"attendance_summary": sample_tool()}),
            self.captureOnCommitCallbacks(execute=True),
        ):  # the job starts when the request's transaction commits
            response = self.client.post(
                "/api/md/assistant/ask",
                data=json.dumps({"question": question, **body}),
                content_type="application/json",
                **md_headers(self.md),
            )
        return response, client

    def get(self, path):
        return self.client.get(path, **md_headers(self.md))


class Status(Base):
    def test_ready_when_enabled_and_the_key_is_set(self):
        body = self.get("/api/md/assistant/status").json()
        self.assertTrue(body["ready"])
        self.assertEqual(body["model"], "gemini-3.5-flash-lite")
        self.assertTrue(body["privacyMode"])
        self.assertTrue(body["voice"]["serverTranscription"])
        self.assertIn("requests", body["usage"])
        self.assertNotIn("AIza", json.dumps(body))

    def test_not_ready_without_a_key_or_when_switched_off(self):
        with mock.patch.dict("os.environ", {"GEMINI_API_KEY": ""}):
            body = self.get("/api/md/assistant/status").json()
        self.assertEqual((body["configured"], body["ready"]), (False, False))
        MdAssistantSettings.load()
        MdAssistantSettings.objects.filter(pk=1).update(enabled=False)
        self.assertFalse(self.get("/api/md/assistant/status").json()["ready"])


class Asking(Base):
    def test_a_question_is_accepted_answered_and_can_be_polled(self):
        response, client = self.ask(inputMode="voice", language="en-IN")
        self.assertEqual(response.status_code, 202, response.content)
        ids = response.json()
        message = self.get(f"/api/md/assistant/messages/{ids['messageId']}").json()
        self.assertEqual(message["status"], "done", message)
        self.assertEqual(message["content"], "**91.8%** attendance.")
        self.assertEqual(message["payload"]["steps"][0]["tool"], "attendance_summary")
        self.assertEqual(message["inputMode"], "voice")
        self.assertEqual(message["conversationId"], ids["conversationId"])
        # the question and the answer are stored as the conversation
        detail = self.get(f"/api/md/assistant/conversations/{ids['conversationId']}").json()
        self.assertEqual([m["role"] for m in detail["messages"]], ["user", "assistant"])
        self.assertEqual(detail["messages"][0]["content"], "How was attendance?")
        self.assertEqual(detail["title"], "How was attendance?")

    def test_how_a_spoken_question_was_heard_is_kept_with_it_and_cleaned(self):
        response, _ = self.ask(
            inputMode="voice",
            voice={"language": "ta-IN", "engine": "browser", "confidence": 0.93, "evil": "<script>", "extra": 1},
        )
        question = MdMessage.objects.get(pk=response.json()["userMessageId"])
        self.assertEqual(question.payload, {"voice": {"language": "ta-IN", "engine": "browser", "confidence": 0.93}})
        # nonsense is dropped, and a typed question carries no voice information at all
        bad, _ = self.ask(
            client=ScriptedClient([submit_reply()]),
            inputMode="voice",
            voice={"language": "klingon", "confidence": 7, "engine": "x"},
        )
        self.assertEqual(MdMessage.objects.get(pk=bad.json()["userMessageId"]).payload, {"voice": {}})
        typed, _ = self.ask(client=ScriptedClient([submit_reply()]), voice={"language": "en-IN"})
        self.assertEqual(MdMessage.objects.get(pk=typed.json()["userMessageId"]).payload, {})

    def test_a_follow_up_continues_the_conversation_and_sees_the_earlier_turn(self):
        first, _ = self.ask()
        cid = first.json()["conversationId"]
        second, client = self.ask(
            "And last month?", client=ScriptedClient([submit_reply(answer="Last month: **90%**.")]), conversationId=cid
        )
        self.assertEqual(second.json()["conversationId"], cid)
        texts = [c["parts"][0].get("text") for c in client.calls[0]["contents"]]
        self.assertEqual(texts, ["How was attendance?", "**91.8%** attendance.", "And last month?"])
        self.assertEqual(MdConversation.objects.count(), 1)

    def test_the_page_the_md_is_on_reaches_the_prompt_and_is_cleaned_first(self):
        _, client = self.ask(
            pageContext={
                "page": "payroll",
                "title": "Payroll Analysis",
                "filters": {"Month": "Sep"},
                "summary": {"Gross": "x" * 900},
                "evil": "ignored",
            }
        )
        system = client.calls[0]["system"]
        self.assertIn("Payroll Analysis", system)
        self.assertIn("Month: Sep", system)
        self.assertNotIn("x" * 300, system)  # long values are cut
        stored = MdMessage.objects.filter(role="assistant").first().page_context
        self.assertNotIn("evil", stored)

    def test_bad_requests_are_refused_politely(self):
        for body, status in (
            ({"question": "  "}, 400),
            ({"question": "x" * 2001}, 400),
            ({"question": "hi", "conversationId": 99999}, 404),
        ):
            response = self.client.post(
                "/api/md/assistant/ask", data=json.dumps(body), content_type="application/json", **md_headers(self.md)
            )
            self.assertEqual(response.status_code, status, body)
            self.assertIn("error", response.json())

    def test_without_a_key_or_when_disabled_it_says_so_without_creating_anything(self):
        with mock.patch.dict("os.environ", {"GEMINI_API_KEY": ""}):
            response, _ = self.ask(client=ScriptedClient([]))
        self.assertEqual((response.status_code, response.json()["kind"]), (503, "not_configured"))
        MdAssistantSettings.load()
        MdAssistantSettings.objects.filter(pk=1).update(enabled=False)
        response, _ = self.ask(client=ScriptedClient([]))
        self.assertEqual((response.status_code, response.json()["kind"]), (503, "disabled"))
        self.assertEqual(MdConversation.objects.count(), 0)

    def test_one_question_at_a_time(self):
        conversation = MdConversation.objects.create(user=self.md, title="t")
        MdMessage.objects.create(conversation=conversation, role="user", content="q")
        MdMessage.objects.create(
            conversation=conversation,
            role="assistant",
            status="running",
            started_at=__import__("django.utils.timezone", fromlist=["now"]).now(),
        )
        response, client = self.ask(client=ScriptedClient([]))
        self.assertEqual(response.status_code, 409)
        self.assertEqual(client.calls, [])

    def test_a_gemini_failure_ends_the_message_in_a_readable_error(self):
        response, _ = self.ask(client=ScriptedClient([GeminiError("overloaded", "x")]))
        message = self.get(f"/api/md/assistant/messages/{response.json()['messageId']}").json()
        self.assertEqual(message["status"], "error")
        self.assertIn("very busy", message["error"])


class Stopping(Base):
    def test_the_md_can_stop_an_answer_in_progress_and_only_their_own(self):
        conversation = MdConversation.objects.create(user=self.md, title="t")
        MdMessage.objects.create(conversation=conversation, role="user", content="q")
        running = MdMessage.objects.create(conversation=conversation, role="assistant", status="running")
        response = self.client.post(f"/api/md/assistant/messages/{running.id}/cancel", **md_headers(self.md))
        body = response.json()
        self.assertEqual((response.status_code, body["stopped"], body["status"]), (200, True, "error"))
        self.assertEqual(body["payload"]["errorKind"], "cancelled")
        # asking again is allowed straight away
        again = self.client.post(f"/api/md/assistant/messages/{running.id}/cancel", **md_headers(self.md))
        self.assertFalse(again.json()["stopped"])

    def test_someone_elses_message_cannot_be_stopped(self):
        other = HRUser.objects.create(username="other2", password_hash="x")
        theirs = MdConversation.objects.create(user=other, title="private")
        message = MdMessage.objects.create(conversation=theirs, role="assistant", status="running")
        self.assertEqual(
            self.client.post(f"/api/md/assistant/messages/{message.id}/cancel", **md_headers(self.md)).status_code, 404
        )
        message.refresh_from_db()
        self.assertEqual(message.status, "running")


class History(Base):
    def test_conversations_are_listed_newest_first_and_can_be_deleted(self):
        first, _ = self.ask("First question")
        second, _ = self.ask("Second question", client=ScriptedClient([submit_reply()]))
        listing = self.get("/api/md/assistant/conversations").json()["conversations"]
        self.assertEqual([c["title"] for c in listing], ["Second question", "First question"])
        response = self.client.delete(
            f"/api/md/assistant/conversations/{second.json()['conversationId']}", **md_headers(self.md)
        )
        self.assertEqual(response.status_code, 204)
        self.assertEqual(len(self.get("/api/md/assistant/conversations").json()["conversations"]), 1)
        self.client.delete("/api/md/assistant/conversations", **md_headers(self.md))
        self.assertEqual(MdConversation.objects.count(), 0)
        self.assertEqual(MdMessage.objects.count(), 0)

    def test_someone_elses_conversation_is_not_reachable(self):
        other = HRUser.objects.create(username="other", password_hash="x")
        theirs = MdConversation.objects.create(user=other, title="private")
        message = MdMessage.objects.create(conversation=theirs, role="user", content="secret")
        for path in (f"/api/md/assistant/conversations/{theirs.id}", f"/api/md/assistant/messages/{message.id}"):
            self.assertEqual(self.get(path).status_code, 404)
        self.assertEqual(
            self.client.delete(f"/api/md/assistant/conversations/{theirs.id}", **md_headers(self.md)).status_code, 404
        )
        self.assertTrue(MdConversation.objects.filter(pk=theirs.id).exists())


class Voice(Base):
    def upload(self, content=b"audio-bytes", name="a.webm", content_type="audio/webm;codecs=opus"):
        return self.client.post(
            "/api/md/assistant/transcribe",
            data={"audio": SimpleUploadedFile(name, content, content_type=content_type), "language": "Tamil"},
            **md_headers(self.md),
        )

    def test_a_recording_is_transcribed(self):
        fake = mock.Mock()
        fake.transcribe.return_value = {"text": "show payroll", "language": "en-IN"}
        with mock.patch.object(engine, "build_client", return_value=fake):
            response = self.upload()
        self.assertEqual(response.json(), {"text": "show payroll", "language": "en-IN"})
        args, kwargs = fake.transcribe.call_args
        self.assertEqual((args[0], args[1], kwargs["language_hint"]), (b"audio-bytes", "audio/webm", "Tamil"))

    def test_no_file_or_a_huge_file_is_refused(self):
        self.assertEqual(
            self.client.post("/api/md/assistant/transcribe", data={}, **md_headers(self.md)).status_code, 400
        )
        with mock.patch("api.md_portal.assistant.views.MAX_AUDIO_BYTES", 4):
            self.assertEqual(self.upload(b"too long").status_code, 413)

    def test_a_gemini_failure_is_reported_with_its_kind(self):
        fake = mock.Mock()
        fake.transcribe.side_effect = GeminiError("daily_quota", "limit")
        with mock.patch.object(engine, "build_client", return_value=fake):
            response = self.upload()
        self.assertEqual((response.status_code, response.json()["kind"]), (429, "daily_quota"))


class AdminSettings(Base):
    URL = "/api/hr-users/md-assistant"

    def call(self, method, user, body=None, path=None):
        fn = getattr(self.client, method)
        if body is None:
            return fn(path or self.URL, **headers(user))
        return fn(path or self.URL, data=json.dumps(body), content_type="application/json", **headers(user))

    def test_only_a_super_administrator_can_read_or_change_them(self):
        for user in (self.md, self.clerk):
            self.assertEqual(self.call("get", user).status_code, 403, user.username)
            self.assertEqual(self.call("put", user, {"enabled": False}).status_code, 403, user.username)
            self.assertEqual(self.call("post", user, {}, self.URL + "/test").status_code, 403, user.username)
        self.assertEqual(self.call("get", self.admin).status_code, 200)

    def test_the_key_is_never_in_the_response_only_whether_it_is_set(self):
        body = self.call("get", self.admin).json()
        self.assertTrue(body["keyConfigured"])
        self.assertNotIn("AIza", json.dumps(body))
        self.assertEqual(body["fallbackModels"], ["gemini-3.1-flash-lite", "gemini-3.8-flash"])

    def test_changes_are_saved_validated_and_audited(self):
        response = self.call(
            "put",
            self.admin,
            {
                "model": "gemini-3.8-flash",
                "fallbackModels": ["gemini-3.5-flash-lite"],
                "thinkingLevel": "medium",
                "privacyMode": False,
                "maxToolRounds": 6,
                "requestsPerMinute": 12,
                "enabled": True,
            },
        )
        self.assertEqual(response.status_code, 200, response.content)
        s = MdAssistantSettings.load()
        self.assertEqual(
            (s.model, s.fallback_models, s.thinking_level, s.privacy_mode, s.max_tool_rounds, s.requests_per_minute),
            ("gemini-3.8-flash", "gemini-3.5-flash-lite", "medium", False, 6, 12),
        )
        self.assertEqual(s.updated_by, "root")
        self.assertTrue(AuditLog.objects.filter(module="md_assistant").exists())

    def test_bad_values_are_refused_and_nothing_changes(self):
        for body in (
            {"model": "bad model!"},
            {"fallbackModels": ["ok-model", "no good"]},
            {"thinkingLevel": "extreme"},
            {"maxToolRounds": 99},
            {"requestsPerMinute": "many"},
        ):
            response = self.call("put", self.admin, body)
            self.assertEqual(response.status_code, 400, body)
        self.assertEqual(MdAssistantSettings.load().model, "gemini-3.5-flash-lite")

    def test_the_connection_test_reports_success_and_the_models_the_key_can_use(self):
        fake = mock.Mock()
        fake.configured.return_value = True
        fake.generate.return_value = mock.Mock(model="gemini-3.5-flash-lite", text=lambda: "OK")
        fake.list_models.return_value = ["gemini-3.5-flash-lite", "gemini-3.8-flash"]
        with mock.patch.object(engine, "build_client", return_value=fake):
            body = self.call("post", self.admin, {}, self.URL + "/test").json()
        self.assertTrue(body["ok"])
        self.assertEqual(body["availableModels"], ["gemini-3.5-flash-lite", "gemini-3.8-flash"])

    def test_the_connection_test_reports_a_readable_failure(self):
        fake = mock.Mock()
        fake.configured.return_value = True
        fake.generate.side_effect = GeminiError("bad_key", "nope")
        with mock.patch.object(engine, "build_client", return_value=fake):
            body = self.call("post", self.admin, {}, self.URL + "/test").json()
        self.assertEqual((body["ok"], body["kind"]), (False, "bad_key"))
        self.assertIn("rejected", body["error"])

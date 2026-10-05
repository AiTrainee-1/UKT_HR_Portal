"""The Gemini client (md_portal/assistant/gemini.py): how it talks to Google, classifies errors and falls back."""

import json
from unittest import mock

import requests
from django.test import SimpleTestCase

from .md_portal.assistant import gemini as G


class FakeResponse:
    def __init__(self, status=200, body=None):
        self.status_code = status
        self._body = body

    def json(self):
        if self._body is None:
            raise ValueError("no json")
        return self._body


def ok_body(parts=None, **extra):
    return {
        "candidates": [{"content": {"role": "model", "parts": parts or [{"text": "hi"}]}, "finishReason": "STOP"}],
        "usageMetadata": {"promptTokenCount": 10, "candidatesTokenCount": 3, "thoughtsTokenCount": 2},
        "modelVersion": "gemini-x",
        **extra,
    }


def error_body(code, status, message="m", details=None):
    return {"error": {"code": code, "status": status, "message": message, "details": details or []}}


def quota(quota_id, retry="3s"):
    return [
        {"@type": "type.googleapis.com/google.rpc.QuotaFailure", "violations": [{"quotaId": quota_id}]},
        {"@type": "type.googleapis.com/google.rpc.RetryInfo", "retryDelay": retry},
    ]


class Sequence:
    """session.post replacement: answers from a list of FakeResponse / exceptions, remembers the requests."""

    def __init__(self, *answers):
        self.answers = list(answers)
        self.requests = []

    def post(self, url, headers=None, data=None, timeout=None):
        self.requests.append({"url": url, "headers": headers, "body": json.loads(data), "timeout": timeout})
        answer = self.answers.pop(0)
        if isinstance(answer, Exception):
            raise answer
        return answer


def client(session, *models, sleeps=None, **kw):
    sleeps = sleeps if sleeps is not None else []
    return G.GeminiClient(
        models=list(models) or ["m1"],
        api_key="AIzaFAKEKEYFAKEKEYFAKEKEYFAKEKEY1234",
        base_url="https://example.test/v1beta",
        session=session,
        sleep=sleeps.append,
        limiter=G.RateLimiter(1000),
        **kw,
    )


class RequestShape(SimpleTestCase):
    def test_the_key_goes_in_a_header_never_in_the_url(self):
        s = Sequence(FakeResponse(200, ok_body()))
        client(s).generate(system="sys", contents=[{"role": "user", "parts": [{"text": "q"}]}])
        request = s.requests[0]
        self.assertEqual(request["url"], "https://example.test/v1beta/models/m1:generateContent")
        self.assertIn("AIza", request["headers"]["x-goog-api-key"])
        self.assertNotIn("key=", request["url"])
        self.assertEqual(request["timeout"], G.TIMEOUT)

    def test_body_for_a_gemini_3_model_uses_thinking_level_and_no_sampling_parameters(self):
        c = client(Sequence(), "gemini-3.5-flash-lite", thinking_level="low")
        body = c.build_body(
            "gemini-3.5-flash-lite", system="s", contents=[], tools=[{"name": "t"}], mode="ANY", allowed=["t"]
        )
        self.assertEqual(body["generationConfig"]["thinkingConfig"], {"thinkingLevel": "low"})
        for forbidden in ("temperature", "topP", "topK", "candidateCount"):
            self.assertNotIn(forbidden, body["generationConfig"])
        self.assertEqual(body["toolConfig"]["functionCallingConfig"], {"mode": "ANY", "allowedFunctionNames": ["t"]})
        self.assertEqual(body["systemInstruction"], {"parts": [{"text": "s"}]})

    def test_allowed_function_names_are_only_sent_with_any_or_validated(self):
        c = client(Sequence())
        body = c.build_body("m", system=None, contents=[], tools=[{"name": "t"}], mode="AUTO", allowed=["t"])
        self.assertNotIn("allowedFunctionNames", body["toolConfig"]["functionCallingConfig"])
        self.assertNotIn("systemInstruction", body)

    def test_thinking_depth_by_model_family(self):
        self.assertEqual(
            G.thinking_config("gemini-3.8-flash", "minimal"), {"thinkingLevel": "low"}
        )  # minimal is an error there
        self.assertEqual(G.thinking_config("gemini-3.5-flash-lite", "minimal"), {"thinkingLevel": "minimal"})
        self.assertEqual(G.thinking_config("gemini-3.1-flash-lite", "weird"), {"thinkingLevel": "low"})
        self.assertEqual(G.thinking_config("gemini-2.5-flash", "high"), {"thinkingBudget": 8192})
        self.assertEqual(G.thinking_config("gemini-2.5-pro", "minimal"), {"thinkingBudget": 128})
        self.assertIsNone(G.thinking_config("something-else", "low"))

    def test_a_reply_keeps_the_models_parts_exactly_and_reads_calls_text_and_tokens(self):
        parts = [
            {"functionCall": {"id": "a", "name": "t", "args": {"x": 1}}, "thoughtSignature": "sig"},
            {"text": "thinking...", "thought": True},
            {"text": "hello"},
        ]
        reply = client(Sequence(FakeResponse(200, ok_body(parts)))).generate(contents=[], system=None)
        self.assertEqual(reply.parts, parts)
        self.assertEqual(reply.content(), {"role": "model", "parts": parts})
        self.assertEqual(reply.function_calls(), [{"id": "a", "name": "t", "args": {"x": 1}}])
        self.assertEqual(reply.text(), "hello")  # thought summaries are not the answer
        self.assertEqual(reply.tokens(), (10, 5))

    def test_a_function_response_echoes_the_calls_id_and_name(self):
        part = G.function_response_part({"id": "c9", "name": "t"}, {"result": {"a": 1}})
        self.assertEqual(part, {"functionResponse": {"name": "t", "response": {"result": {"a": 1}}, "id": "c9"}})
        self.assertNotIn("id", G.function_response_part({"id": None, "name": "t"}, {})["functionResponse"])

    def test_no_key_is_reported_before_any_request(self):
        c = G.GeminiClient(models=["m"], api_key="", session=Sequence())
        with self.assertRaises(G.GeminiError) as raised:
            c.generate(contents=[], system=None)
        self.assertEqual(raised.exception.kind, "not_configured")


class ErrorClassification(SimpleTestCase):
    def kind(self, status, body):
        return G.classify_http_error(status, body).kind

    def test_each_documented_failure(self):
        self.assertEqual(
            self.kind(
                400,
                error_body(
                    400,
                    "INVALID_ARGUMENT",
                    "API key not valid. Please pass a valid API key.",
                    [{"@type": "x", "reason": "API_KEY_INVALID"}],
                ),
            ),
            "bad_key",
        )
        self.assertEqual(
            self.kind(400, error_body(400, "FAILED_PRECONDITION", "free tier is not available in your country")),
            "region",
        )
        self.assertEqual(self.kind(400, error_body(400, "INVALID_ARGUMENT", "bad field")), "bad_request")
        self.assertEqual(self.kind(403, error_body(403, "PERMISSION_DENIED")), "bad_key")
        self.assertEqual(self.kind(404, error_body(404, "NOT_FOUND")), "not_found")
        self.assertEqual(self.kind(500, error_body(500, "INTERNAL")), "server")
        self.assertEqual(self.kind(503, error_body(503, "UNAVAILABLE")), "overloaded")
        self.assertEqual(self.kind(504, error_body(504, "DEADLINE_EXCEEDED")), "timeout")
        self.assertEqual(self.kind(418, None), "bad_request")

    def test_a_429_is_per_minute_or_per_day_by_the_quota_id_not_by_the_retry_delay(self):
        per_minute = error_body(
            429, "RESOURCE_EXHAUSTED", "slow down", quota("GenerateRequestsPerMinutePerProjectPerModel-FreeTier", "17s")
        )
        per_day = error_body(
            429, "RESOURCE_EXHAUSTED", "out", quota("GenerateRequestsPerDayPerProjectPerModel-FreeTier", "1s")
        )  # tiny, misleading delay
        a, b = G.classify_http_error(429, per_minute), G.classify_http_error(429, per_day)
        self.assertEqual((a.kind, a.retry_after), ("rate_limited", 17.0))
        self.assertEqual(b.kind, "daily_quota")

    def test_a_key_never_survives_in_a_message(self):
        error = G.GeminiError("x", "bad call AIzaSyAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA end")
        self.assertNotIn("AIza", str(error))
        self.assertIn("[api-key]", str(error))


class RetriesAndFallback(SimpleTestCase):
    def test_a_per_minute_limit_is_waited_out_then_retried(self):
        sleeps = []
        s = Sequence(
            FakeResponse(429, error_body(429, "RESOURCE_EXHAUSTED", "m", quota("PerMinute", "4s"))),
            FakeResponse(200, ok_body()),
        )
        reply = client(s, sleeps=sleeps).generate(contents=[], system=None)
        self.assertEqual(reply.text(), "hi")
        self.assertEqual(len(s.requests), 2)
        self.assertGreaterEqual(sleeps[0], 4.0)

    def test_a_long_per_minute_wait_is_not_worth_it_so_the_next_model_is_tried(self):
        s = Sequence(
            FakeResponse(429, error_body(429, "RESOURCE_EXHAUSTED", "m", quota("PerMinute", "55s"))),
            FakeResponse(200, ok_body()),
        )
        c = client(s, "m1", "m2")
        self.assertEqual(c.generate(contents=[], system=None).text(), "hi")
        self.assertTrue(s.requests[1]["url"].endswith("m2:generateContent"))

    def test_a_daily_limit_skips_to_the_next_model_without_waiting(self):
        sleeps = []
        s = Sequence(
            FakeResponse(429, error_body(429, "RESOURCE_EXHAUSTED", "m", quota("PerDay", "1s"))),
            FakeResponse(200, ok_body()),
        )
        client(s, "m1", "m2", sleeps=sleeps).generate(contents=[], system=None)
        self.assertEqual(sleeps, [])
        self.assertTrue(s.requests[1]["url"].endswith("m2:generateContent"))

    def test_when_every_model_is_out_of_quota_the_error_says_so(self):
        day = FakeResponse(429, error_body(429, "RESOURCE_EXHAUSTED", "m", quota("PerDay")))
        with self.assertRaises(G.GeminiError) as raised:
            client(Sequence(day, day), "m1", "m2").generate(contents=[], system=None)
        self.assertEqual(raised.exception.kind, "daily_quota")

    def test_an_overloaded_model_is_retried_with_backoff_then_replaced(self):
        sleeps = []
        busy = FakeResponse(503, error_body(503, "UNAVAILABLE"))
        s = Sequence(busy, busy, busy, FakeResponse(200, ok_body()))
        client(s, "m1", "m2", sleeps=sleeps).generate(contents=[], system=None)
        self.assertEqual(len(s.requests), 4)
        self.assertEqual(len(sleeps), 2)  # two backoffs on m1, then m2
        self.assertTrue(s.requests[3]["url"].endswith("m2:generateContent"))

    def test_a_missing_model_is_skipped_at_once(self):
        s = Sequence(FakeResponse(404, error_body(404, "NOT_FOUND")), FakeResponse(200, ok_body()))
        self.assertEqual(client(s, "gone", "m2").generate(contents=[], system=None).text(), "hi")

    def test_a_bad_key_stops_everything_because_another_model_cannot_help(self):
        s = Sequence(FakeResponse(403, error_body(403, "PERMISSION_DENIED")))
        with self.assertRaises(G.GeminiError) as raised:
            client(s, "m1", "m2").generate(contents=[], system=None)
        self.assertEqual((raised.exception.kind, len(s.requests)), ("bad_key", 1))

    def test_timeouts_and_network_errors_are_classified(self):
        with self.assertRaises(G.GeminiError) as raised:
            client(Sequence(requests.Timeout(), requests.Timeout(), requests.Timeout()), sleeps=[]).generate(
                contents=[], system=None
            )
        self.assertEqual(raised.exception.kind, "timeout")
        with self.assertRaises(G.GeminiError) as raised:
            client(Sequence(requests.ConnectionError("down AIzaSyAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"))).generate(
                contents=[], system=None
            )
        self.assertEqual(raised.exception.kind, "network")
        self.assertNotIn("AIza", str(raised.exception))

    def test_every_attempt_is_reported_for_the_budget(self):
        seen = []
        s = Sequence(FakeResponse(503, error_body(503, "UNAVAILABLE")), FakeResponse(200, ok_body()))
        client(
            s,
            "m1",
            sleeps=[],
            on_request=lambda model, reply, error: seen.append((model, error.kind if error else "ok")),
        ).generate(contents=[], system=None)
        self.assertEqual(seen, [("m1", "overloaded"), ("m1", "ok")])


class RateLimiterTests(SimpleTestCase):
    def test_it_waits_only_when_the_window_is_full(self):
        now = [0.0]
        slept = []

        def sleep(seconds):
            slept.append(seconds)
            now[0] += seconds

        limiter = G.RateLimiter(2, clock=lambda: now[0], sleep=sleep)
        self.assertEqual(limiter.wait(), 0.0)
        self.assertEqual(limiter.wait(), 0.0)
        waited = limiter.wait()  # the third must wait for the first to leave the 60 s window
        self.assertGreaterEqual(waited, 59.9)
        self.assertEqual(len(slept), 1)


class Transcription(SimpleTestCase):
    def test_audio_goes_as_inline_data_with_the_codec_stripped(self):
        s = Sequence(FakeResponse(200, ok_body([{"text": '{"text": "payroll chart", "language": "en-IN"}'}])))
        result = client(s).transcribe(b"\x00\x01", "audio/webm;codecs=opus", language_hint="Tamil")
        self.assertEqual(result, {"text": "payroll chart", "language": "en-IN"})
        inline = s.requests[0]["body"]["contents"][0]["parts"][1]["inlineData"]
        self.assertEqual(inline["mimeType"], "audio/webm")
        self.assertEqual(inline["data"], "AAE=")
        self.assertIn("Tamil", s.requests[0]["body"]["systemInstruction"]["parts"][0]["text"])

    def test_the_reply_is_parsed_leniently(self):
        self.assertEqual(
            G.parse_transcription('```json\n{"text": "hello", "language": "ta-IN"}\n```'),
            {"text": "hello", "language": "ta-IN"},
        )
        self.assertEqual(G.parse_transcription('{"text": "hi", "language": "klingon"}')["language"], "other")
        self.assertEqual(G.parse_transcription("just words"), {"text": "just words", "language": "other"})
        self.assertEqual(G.parse_transcription(""), {"text": "", "language": "other"})

    def test_the_model_list_keeps_only_generating_gemini_models(self):
        session = mock.Mock()
        session.get.return_value = FakeResponse(
            200,
            {
                "models": [
                    {"name": "models/gemini-3.5-flash-lite", "supportedGenerationMethods": ["generateContent"]},
                    {"name": "models/embedding-001", "supportedGenerationMethods": ["embedContent"]},
                    {"name": "models/gemini-embedding", "supportedGenerationMethods": ["embedContent"]},
                ]
            },
        )
        self.assertEqual(client(session).list_models(), ["gemini-3.5-flash-lite"])

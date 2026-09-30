"""English-language behaviour of the server; the other test modules cover the Japanese default."""

from __future__ import annotations

import json
import os
import unittest
from typing import Any
from unittest.mock import AsyncMock, patch

import httpx
from fastapi.testclient import TestClient

import app as app_module
from lab.backend import INSTRUCTIONS_EN as BACKEND_INSTRUCTIONS_EN, WEATHER_TOOL, WEATHER_TOOL_EN, run_backend
from lab.i18n import current_language, normalize_language, set_language, text, use_language
from lab.jev import ACTION_CRITERIA_EN, INSTRUCTIONS_EN as JEV_INSTRUCTIONS_EN, JevSettings, run_jev
from lab.provider import BackendSettings
from lab.state import STUB_RESULT, STUB_RESULT_EN, TranscriptLab
from lab.weather import SUPPORTED_CITIES, SUPPORTED_CITIES_EN, WeatherInputError, search_weather_for_city
from tests.test_lab import delegation, delta

ORIGIN = "http://localhost:8765"
HEADERS = {"origin": ORIGIN}


class LanguageSelectionTests(unittest.TestCase):
    def test_unknown_languages_fall_back_to_japanese(self) -> None:
        self.assertEqual(normalize_language("en"), "en")
        for value in ("ja", None, "", "EN", "fr", 1):
            self.assertEqual(normalize_language(value), "ja")

    def test_use_language_is_scoped_and_nested(self) -> None:
        self.assertEqual(current_language(), "ja")
        with use_language("en"):
            self.assertEqual(text("日本語", "English"), "English")
            with use_language("ja"):
                self.assertEqual(text("日本語", "English"), "日本語")
            self.assertEqual(current_language(), "en")
        self.assertEqual(current_language(), "ja")

    def test_city_lists_are_parallel(self) -> None:
        self.assertEqual(len(SUPPORTED_CITIES), len(SUPPORTED_CITIES_EN))
        self.assertEqual(SUPPORTED_CITIES_EN[:2], ("Tokyo", "Osaka"))
        self.assertEqual(WEATHER_TOOL["parameters"]["properties"]["city"]["enum"], list(SUPPORTED_CITIES))
        self.assertEqual(WEATHER_TOOL_EN["parameters"]["properties"]["city"]["enum"], list(SUPPORTED_CITIES_EN))

    def test_stub_and_state_errors_follow_the_language(self) -> None:
        with use_language("en"):
            lab = TranscriptLab()
            lab.process(delta("Tokyo"))
            command = lab.process(delegation())
            self.assertEqual(command["content"], STUB_RESULT_EN)
            self.assertIn("in English", STUB_RESULT_EN)
            with self.assertRaisesRegex(ValueError, "The delegation mode must be"):
                TranscriptLab("other")
        self.assertIn("in Japanese", STUB_RESULT)


class EnglishFunctionTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self) -> None:
        set_language("en")

    async def test_function_arguments_use_the_language_city_names(self) -> None:
        with self.assertRaises(WeatherInputError) as caught:
            await search_weather_for_city("大阪")
        self.assertIn("A supported city", str(caught.exception))

    async def test_backend_uses_english_prompt_schema_and_success_prefix(self) -> None:
        settings = BackendSettings("azure", "https://example.openai.azure.com/openai/v1/responses",
                                   "gpt-6-luna", "test-key", "api_key")
        call = {"type": "function_call", "call_id": "call_1", "name": "search_weather",
                "arguments": '{"city":"Osaka","time_scope":"current"}'}
        message = {"type": "message", "role": "assistant",
                   "content": [{"type": "output_text", "text": "It is clear in Osaka."}]}
        responses = [
            {"id": "resp_1", "status": "completed", "model": "gpt-6-luna", "output": [call]},
            {"id": "resp_2", "status": "completed", "model": "gpt-6-luna", "output": [message]},
        ]
        requests: list[dict[str, Any]] = []

        def handler(request: httpx.Request) -> httpx.Response:
            requests.append(json.loads(request.content))
            return httpx.Response(200, json=responses[len(requests) - 1])

        tool = AsyncMock(return_value={"status": "ok", "city": "Osaka", "summary": "Retrieved."})
        client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
        with patch("lab.backend.BackendSettings.from_env", return_value=settings), patch(
            "lab.backend.httpx.AsyncClient", return_value=client
        ), patch("lab.backend.search_weather_for_city", tool):
            answer = await run_backend("USER: Tokyo weather. No, Osaka", AsyncMock())
        self.assertEqual(answer, "Weather information retrieved. It is clear in Osaka.")
        tool.assert_awaited_once_with(city="Osaka", time_scope="current")
        self.assertEqual(requests[0]["instructions"], BACKEND_INSTRUCTIONS_EN)
        self.assertEqual(requests[0]["tools"], [WEATHER_TOOL_EN])
        self.assertTrue(requests[0]["input"][0]["content"].startswith("The following is the conversation"))

    async def test_backend_rejects_japanese_city_names_in_english_sessions(self) -> None:
        settings = BackendSettings("azure", "https://example.openai.azure.com/openai/v1/responses",
                                   "gpt-6-luna", "test-key", "api_key")
        call = {"type": "function_call", "call_id": "call_1", "name": "search_weather",
                "arguments": '{"city":"大阪","time_scope":"current"}'}
        client = httpx.AsyncClient(transport=httpx.MockTransport(lambda request: httpx.Response(
            200, json={"id": "resp_1", "status": "completed", "model": "gpt-6-luna", "output": [call]},
        )))
        tool = AsyncMock()
        with patch("lab.backend.BackendSettings.from_env", return_value=settings), patch(
            "lab.backend.httpx.AsyncClient", return_value=client
        ), patch("lab.backend.search_weather_for_city", tool), self.assertRaisesRegex(
            Exception, "do not match an allowed city"
        ):
            await run_backend("USER: Osaka weather", AsyncMock())
        tool.assert_not_awaited()

    async def run_jev(self, choice: str, confidence: float = 0.9) -> tuple[str, AsyncMock, list[dict]]:
        body = {
            "model": "jev-actual-model",
            "answers": {"action": {
                "type": "choice", "choice": choice, "confidence": confidence,
                "probabilities": {name: 1.0 if name == choice else 0.0 for name in ACTION_CRITERIA_EN},
            }},
            "usage": {"input_tokens": 20, "output_tokens": 5},
        }
        requests: list[dict] = []

        def handler(request: httpx.Request) -> httpx.Response:
            requests.append(json.loads(request.content))
            return httpx.Response(200, json=body)

        tool = AsyncMock(return_value={"status": "ok", "city": "Osaka", "summary": "Weather information retrieved."})
        client = httpx.AsyncClient(transport=httpx.MockTransport(handler), trust_env=False)
        with patch("lab.jev.JevSettings.from_env", return_value=JevSettings("jev-latest", "private-key", 0.75)), patch(
            "lab.jev.httpx.AsyncClient", return_value=client,
        ), patch("lab.jev.search_weather_for_city", tool):
            content = await run_jev(
                "1\n00:00:00,000 --> 00:00:01,000\nUSER: Osaka weather", AsyncMock(),
                current_srt="1\n00:00:00,000 --> 00:00:01,000\nUSER: Osaka weather",
            )
        return content, tool, requests

    async def test_jev_uses_english_choice_ids_and_messages(self) -> None:
        content, tool, requests = await self.run_jev("weather_Osaka_current")
        self.assertEqual(content, "Weather information retrieved.")
        tool.assert_awaited_once_with(city="Osaka", time_scope="current")
        question = requests[0]["questions"]["action"]
        self.assertEqual(question["instructions"], JEV_INSTRUCTIONS_EN)
        self.assertIn("'Osaka, not Tokyo'", JEV_INSTRUCTIONS_EN)
        self.assertIn("weather_Tokyo_current", question["criteria"])
        self.assertNotIn("weather_東京_current", question["criteria"])
        content, tool, _ = await self.run_jev("clarify_city")
        self.assertTrue(content.startswith("Which city's current weather"))
        tool.assert_not_awaited()
        content, tool, _ = await self.run_jev("weather_Osaka_current", confidence=0.5)
        self.assertIn("confidence threshold", content)
        tool.assert_not_awaited()


class EnglishAppTests(unittest.TestCase):
    def setUp(self) -> None:
        self.environment = patch.dict(os.environ, {"LIVE_PROVIDER": "openai", "OPENAI_API_KEY": "test-key"})
        self.environment.start()
        self.addCleanup(self.environment.stop)
        self.client = TestClient(app_module.app, base_url=ORIGIN)
        self.addCleanup(self.client.close)

    def test_config_follows_the_lang_query(self) -> None:
        japanese = self.client.get("/api/config").json()
        self.assertEqual(japanese["language"], "ja")
        self.assertEqual(japanese["instructions"], app_module.INSTRUCTIONS)
        self.assertEqual(japanese["weather_cities"], list(SUPPORTED_CITIES))
        english = self.client.get("/api/config?lang=en").json()
        self.assertEqual(english["language"], "en")
        self.assertEqual(english["instructions"], app_module.INSTRUCTIONS_EN)
        self.assertNotIn("日本語", english["instructions"])
        self.assertEqual(english["weather_cities"], list(SUPPORTED_CITIES_EN))
        self.assertEqual(self.client.get("/api/config?lang=xx").json()["language"], "ja")

    def post_session(self, body: dict[str, Any]) -> dict[str, Any]:
        upstream = httpx.Response(201, json={
            "session": {"id": "live_test"}, "transport": {"type": "webrtc", "sdp": "answer"},
        })
        with patch.dict(os.environ, {"LIVE_RESPONSES_MODEL": "gpt-5.5"}), patch(
            "app.httpx.AsyncClient.post", new_callable=AsyncMock, return_value=upstream
        ) as post:
            response = self.client.post("/api/session", json=body, headers=HEADERS)
        self.assertEqual(response.status_code, 201)
        return post.call_args.kwargs["json"]["session"]

    def test_session_defaults_and_responses_tools_follow_the_language(self) -> None:
        session = self.post_session({"sdp": "offer", "language": "en", "delegation_mode": "responses"})
        self.assertEqual(session["instructions"], app_module.INSTRUCTIONS_EN)
        responses = session["delegation"]["responses"]
        self.assertEqual(responses["instructions"], BACKEND_INSTRUCTIONS_EN)
        self.assertEqual(responses["tools"], [WEATHER_TOOL_EN])
        session = self.post_session({"sdp": "offer", "delegation_mode": "responses"})
        self.assertEqual(session["instructions"], app_module.INSTRUCTIONS)
        self.assertEqual(session["delegation"]["responses"]["tools"], [WEATHER_TOOL])
        self.assertEqual(self.client.post(
            "/api/session", json={"sdp": "offer", "language": "fr"}, headers=HEADERS,
        ).status_code, 422)

    def test_websocket_lang_query_localizes_messages_for_that_connection_only(self) -> None:
        invalid = {"type": "configure_playground", "playground": {"function_name": "other"}}
        with self.client.websocket_connect("ws://localhost:8765/ws?lang=en", headers=HEADERS) as ws:
            ws.receive_json()
            ws.send_json({"type": "event", "event": delta("Tokyo")})
            ws.receive_json()
            ws.send_json({"type": "event", "event": delegation()})
            ws.receive_json()
            self.assertEqual(ws.receive_json()["event"]["content"], STUB_RESULT_EN)
            ws.send_json(invalid)
            self.assertIn("The only executable function", ws.receive_json()["message"])
        with self.client.websocket_connect("ws://localhost:8765/ws", headers=HEADERS) as ws:
            ws.receive_json()
            ws.send_json(invalid)
            self.assertIn("実行可能な関数", ws.receive_json()["message"])


if __name__ == "__main__":
    unittest.main()

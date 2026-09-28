from __future__ import annotations

import copy
import json
import os
import unittest
from unittest.mock import AsyncMock, patch

import httpx

from lab.backend import BackendError, WEATHER_TOOL, run_backend
from lab.provider import BackendSettings
from lab.weather import WeatherServiceError

SETTINGS = BackendSettings("azure", "https://example.openai.azure.com/openai/v1/responses",
                           "gpt-6-luna", "test-key", "api_key")
CALL = {"type": "function_call", "call_id": "call_from_model", "name": "search_weather",
        "arguments": '{"city":"大阪","time_scope":"current"}'}
TEXT = {"type": "message", "role": "assistant",
        "content": [{"type": "output_text", "text": "大阪の天気を取得しました。モデル推定で晴れです。"}]}


def response(output: list, model: str = "gpt-6-luna", status: str = "completed") -> dict:
    return {"id": "resp_1", "status": status, "model": model, "output": output,
            "usage": {"input_tokens": 20, "output_tokens": 10}}


class BackendTests(unittest.IsolatedAsyncioTestCase):
    async def run_flow(self, responses, tool=None):
        self.requests = []
        self.emit = AsyncMock()
        self.tool = tool or AsyncMock(return_value={"status": "ok", "city": "大阪", "summary": "取得しました。"})

        def handler(request: httpx.Request) -> httpx.Response:
            self.requests.append(json.loads(request.content))
            return responses[len(self.requests) - 1]

        client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
        with patch("lab.backend.BackendSettings.from_env", return_value=SETTINGS), patch(
            "lab.backend.httpx.AsyncClient", return_value=client
        ), patch("lab.backend.search_weather_for_city", self.tool):
            return await run_backend("USER: 東京の天気。いえ、大阪", self.emit)

    async def test_model_arguments_drive_function_and_tool_output_round_trip(self) -> None:
        result = await self.run_flow([httpx.Response(200, json=response([CALL])),
                                      httpx.Response(200, json=response([TEXT]))])
        self.assertIn("大阪", result)
        self.tool.assert_awaited_once_with(city="大阪", time_scope="current")
        first, second = self.requests
        self.assertEqual(first["model"], "gpt-6-luna")
        self.assertEqual(first["tools"], [WEATHER_TOOL])
        self.assertFalse(first["store"])
        self.assertEqual(first["reasoning"], {"effort": "none"})
        self.assertIn("USER:", first["input"][0]["content"])
        self.assertEqual(second["input"][-2], CALL)
        self.assertEqual(second["input"][-1]["type"], "function_call_output")
        self.assertEqual(second["input"][-1]["call_id"], CALL["call_id"])
        self.assertEqual(second["tool_choice"], "none")
        stages = [call.args[0] for call in self.emit.call_args_list]
        self.assertEqual(stages, ["model_started", "model_completed", "function_requested",
                                  "function_started", "function_completed", "function_output",
                                  "model_started", "model_completed"])
        requests = [call.kwargs["request_body"] for call in self.emit.call_args_list if call.args[0] == "model_started"]
        self.assertEqual(requests, self.requests)
        self.assertEqual(len(requests[0]["input"]), 1)
        self.assertEqual(len(requests[1]["input"]), 3)
        self.assertNotIn("test-key", json.dumps(requests))
        completed = [call.kwargs for call in self.emit.call_args_list if call.args[0] == "model_completed"]
        self.assertEqual(completed[0]["function_calls"], [CALL])
        self.assertEqual(completed[1]["output_text"], TEXT["content"][0]["text"])

    async def test_clarification_does_not_execute_function(self) -> None:
        message = copy.deepcopy(TEXT)
        message["content"][0]["text"] = "どの都市の天気ですか。"
        self.assertEqual(await self.run_flow([httpx.Response(200, json=response([message]))]),
                         "どの都市の天気ですか。")
        self.tool.assert_not_awaited()
        self.assertEqual(len(self.requests), 1)

    async def test_invalid_calls_never_reach_weather_function(self) -> None:
        for invalid in [
            {**CALL, "name": "eval"}, {**CALL, "call_id": ""},
            {**CALL, "arguments": "oops"},
            {**CALL, "arguments": '{"city":"パリ","time_scope":"current"}'},
            {**CALL, "arguments": '{"city":"東京","time_scope":"current","url":"https://example.com"}'},
        ]:
            with self.subTest(call=invalid), self.assertRaises(BackendError):
                await self.run_flow([httpx.Response(200, json=response([invalid]))])
            self.tool.assert_not_awaited()

    async def test_failed_tool_is_sent_back_as_error_not_success(self) -> None:
        text = await self.run_flow([httpx.Response(200, json=response([CALL])),
                             httpx.Response(200, json=response([TEXT]))],
                            AsyncMock(side_effect=WeatherServiceError("取得に失敗しました。")))
        output = json.loads(self.requests[-1]["input"][-1]["output"])
        self.assertEqual(output["status"], "error")
        self.assertIn("失敗", output["error"])
        self.assertIn("失敗", text)

    async def test_http_error_is_sanitized_and_not_retried(self) -> None:
        with self.assertRaises(BackendError) as error:
            await self.run_flow([httpx.Response(404, json={"error": {
                "code": "DeploymentNotFound", "message": "test-key is private",
            }})])
        self.assertIn("404", str(error.exception))
        self.assertNotIn("test-key", str(error.exception))
        self.assertEqual(len(self.requests), 1)
        self.tool.assert_not_awaited()

    async def test_wrong_model_incomplete_multiple_calls_and_long_text_are_rejected(self) -> None:
        long = copy.deepcopy(TEXT)
        long["content"][0]["text"] = "長" * 200
        for body in [response([CALL], model="gpt-5"), response([CALL], status="incomplete"),
                     response([CALL, CALL]), response([long]), {"unexpected": True}]:
            with self.subTest(body=body), self.assertRaises(BackendError):
                await self.run_flow([httpx.Response(200, json=body)])
            self.tool.assert_not_awaited()

    async def test_backend_configuration_is_independent_of_live_model(self) -> None:
        with patch.dict(os.environ, {
            "AZURE_OPENAI_ENDPOINT": "https://example.openai.azure.com",
            "AZURE_OPENAI_DEPLOYMENT": "live-deployment",
            "AZURE_OPENAI_BACKEND_DEPLOYMENT": "luna-deployment",
            "LIVE_PROVIDER": "openai",
        }):
            settings = BackendSettings.from_env()
        self.assertEqual(settings.model, "luna-deployment")
        self.assertEqual(settings.url, "https://example.openai.azure.com/openai/v1/responses")
        self.assertEqual(settings.provider, "azure")

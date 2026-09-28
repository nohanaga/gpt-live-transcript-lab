from __future__ import annotations

import asyncio
import json
import threading
import unittest
from unittest.mock import AsyncMock, patch

from fastapi.testclient import TestClient

from app import app
from tests.test_app import HEADERS, ORIGIN, WS_URL
from tests.test_lab import delegation, delta
from lab.execution import ResponsesExecutor
from lab.state import TranscriptLab


class ResponsesExecutionTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self) -> None:
        self.lab = TranscriptLab("responses")
        self.lab.configure_playground({"function_name": "search_weather", "backend": "azure"})
        self.messages = []
        self.finished = asyncio.Event()
        self.send_status = "sent"

        async def emit(message):
            self.messages.append(message)
            if message["type"] == "command":
                identifier = message["event"]["event_id"]
                self.lab.command_status(identifier, self.send_status)
                self.executor.confirm(identifier, self.send_status)
            if message.get("stage") in {"responses_continued", "responses_failed", "responses_completed"}:
                self.finished.set()

        self.executor = ResponsesExecutor(self.lab, emit)
        await self.ingest({"type": "session.delegation.created", "event_id": "delegation_response",
                           "offset_ms": 1000, "delegation": {
                               "id": "d1", "target": "responses", "response_id": "resp_1",
                           }})

    async def asyncTearDown(self) -> None:
        await self.executor.cancel()

    async def ingest(self, event):
        self.lab.process(event)
        await self.executor.observe(event)

    async def request_tool(self, name="search_weather"):
        item = {"type": "function_call", "call_id": "call_1", "name": name,
                "arguments": json.dumps({"city": "東京", "time_scope": "current"})}
        await self.ingest({"type": "response.event", "delegation_id": "d1", "event": {
            "type": "response.output_item.done", "response_id": "resp_1", "item": item,
        }})
        completed = {"type": "response.event", "delegation_id": "d1", "event": {
            "type": "response.completed", "response": {
                "id": "resp_1", "status": "completed", "output": [item],
            },
        }}
        await self.ingest(completed)
        await self.ingest(completed)
        await asyncio.wait_for(self.finished.wait(), 2)

    async def test_ledger_is_not_created_recorded_or_consumed(self) -> None:
        self.lab.process(delta("東京の天気"))
        self.assertIsNone(self.lab.ledger)
        self.assertFalse(self.lab.snapshot()["ledger_enabled"])
        self.assertEqual(self.lab.snapshot()["ledger"], [])
        self.assertEqual(self.lab.snapshot()["pending_srt"], "")
        with self.assertRaises(ValueError):
            self.lab.consume()
        with self.assertRaises(ValueError):
            self.lab.configure_playground({"function_name": "search_weather", "backend": "jev"})

    async def test_result_is_sent_once_before_explicit_continuation(self) -> None:
        with patch("lab.execution.search_weather_for_city", new_callable=AsyncMock,
                   return_value={"status": "ok", "summary": "東京の天気情報です。"}) as search:
            await self.request_tool()
        search.assert_awaited_once_with(city="東京", time_scope="current")
        commands = [message["event"] for message in self.messages if message["type"] == "command"]
        self.assertEqual([command["type"] for command in commands], ["response.item.create", "response.create"])
        self.assertEqual(commands[0]["item"]["call_id"], "call_1")
        self.assertEqual(json.loads(commands[0]["item"]["output"])["status"], "ok")
        self.assertEqual(self.lab.handoffs[0]["status"], "awaiting_response")
        await self.ingest({"type": "response.event", "delegation_id": "d1", "event": {
            "type": "response.completed", "response": {"id": "resp_2", "output": []},
        }})
        self.assertEqual(self.lab.handoffs[0]["status"], "completed")

    async def test_disabled_execution_returns_error_without_weather_call(self) -> None:
        self.lab.configure_playground(None)
        with patch("lab.execution.search_weather_for_city", new_callable=AsyncMock) as search:
            await self.request_tool()
        search.assert_not_awaited()
        command = next(message["event"] for message in self.messages if message["type"] == "command")
        self.assertEqual(json.loads(command["item"]["output"])["status"], "error")

    async def test_unknown_function_is_not_executed(self) -> None:
        with patch("lab.execution.search_weather_for_city", new_callable=AsyncMock) as search:
            await self.request_tool("eval")
        search.assert_not_awaited()
        self.assertEqual(self.lab.handoffs[0]["function_call"]["status"], "failed")

    async def test_failed_delivery_never_continues_response(self) -> None:
        self.send_status = "send_failed"
        with patch("lab.execution.search_weather_for_city", new_callable=AsyncMock,
                   return_value={"status": "ok", "summary": "東京の天気情報です。"}):
            await self.request_tool()
        commands = [message["event"]["type"] for message in self.messages if message["type"] == "command"]
        self.assertEqual(commands, ["response.item.create"])
        self.assertEqual(self.lab.handoffs[0]["status"], "failed")

    async def test_cancel_prevents_execution(self) -> None:
        await self.executor.cancel()
        with patch("lab.execution.search_weather_for_city", new_callable=AsyncMock) as search:
            await self.executor.observe({"type": "response.event", "delegation_id": "d1",
                                         "event": {"type": "response.completed"}})
        search.assert_not_awaited()
        self.assertEqual(self.lab.handoffs[0]["status"], "cancelled")


class ExecutionTransportTests(unittest.TestCase):
    def test_search_does_not_block_ledger_and_result_uses_same_delegation(self) -> None:
        entered, release = threading.Event(), threading.Event()

        async def search(context: str, emit) -> str:
            await emit("function_requested", call_id="azure_call_1", function_name="search_weather",
                       arguments={"city": "東京", "time_scope": "current"})
            await emit("function_started")
            entered.set()
            await asyncio.to_thread(release.wait, 5)
            await emit("function_completed", result={"summary": "天気情報を取得しました。"})
            return "天気情報を取得しました。"

        def until(socket, kind: str, request_id: str) -> dict:
            for _ in range(40):
                message = socket.receive_json()
                if message["type"] == kind and message.get("request_id") == request_id:
                    return message
            self.fail(f"No {kind} for {request_id}")

        with patch("lab.execution.run_backend", side_effect=search), TestClient(app, base_url=ORIGIN) as client:
            with client.websocket_connect(WS_URL, headers=HEADERS) as socket:
                socket.receive_json()
                socket.send_json({"type": "reset", "request_id": "0:reset",
                                  "playground": {"function_name": "search_weather"}})
                self.assertEqual(until(socket, "state", "0:reset")["playground"]["function_name"], "search_weather")
                socket.send_json({"type": "event", "request_id": "0:input", "event": delta("東京の天気")})
                until(socket, "state", "0:input")
                socket.send_json({"type": "event", "request_id": "0:delegation", "event": delegation()})
                queued = until(socket, "state", "0:delegation")
                self.assertEqual(queued["handoffs"][0]["status"], "queued")
                try:
                    self.assertTrue(entered.wait(2))
                    socket.send_json({"type": "event", "request_id": "0:later",
                                      "event": delta("ありがとうございます", event_id="later")})
                    later = until(socket, "state", "0:later")
                    self.assertIn("ありがとうございます", later["pending_srt"])
                    self.assertEqual(later["handoffs"][0]["status"], "executing")
                finally:
                    release.set()
                command = until(socket, "command", "0:delegation")["event"]
                self.assertEqual(command["type"], "session.commentary.append")
                self.assertEqual(command["delegation_id"], "d1")
                socket.send_json({"type": "sent", "request_id": "0:sent", "event_id": command["event_id"]})
                until(socket, "state", "0:sent")
                socket.send_json({"type": "event", "request_id": "0:ack", "event": {
                    "type": "session.commentary.appended", "client_event_id": command["event_id"],
                }})
                ack = until(socket, "state", "0:ack")
                self.assertEqual(ack["handoffs"][0]["status"], "acknowledged")
                self.assertEqual(ack["handoffs"][0]["function_call"]["status"], "succeeded")

    def test_bad_configuration_returns_error_and_preserves_previous_setting(self) -> None:
        with TestClient(app, base_url=ORIGIN) as client:
            with client.websocket_connect(WS_URL, headers=HEADERS) as socket:
                socket.receive_json()
                socket.send_json({"type": "configure_playground", "request_id": "0:on",
                                  "playground": {"function_name": "search_weather"}})
                self.assertEqual(socket.receive_json()["playground"]["function_name"], "search_weather")
                socket.send_json({"type": "configure_playground", "request_id": "0:bad",
                                  "playground": {"function_name": "eval", "result": "fake"}})
                self.assertEqual(socket.receive_json()["type"], "error")
                socket.send_json({"type": "event", "request_id": "0:read", "event": delta("東京の天気")})
                self.assertEqual(socket.receive_json()["playground"]["function_name"], "search_weather")

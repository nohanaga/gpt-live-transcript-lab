from __future__ import annotations

import asyncio
import unittest
from unittest.mock import AsyncMock, patch

from lab.backend import BackendError
from lab.execution import DelegationExecutor
from lab.state import TranscriptLab
from tests.test_lab import delegation, delta


class ExecutionTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self) -> None:
        self.lab = TranscriptLab()
        self.lab.configure_playground({"function_name": "search_weather"})
        self.emit = AsyncMock()
        self.executor = DelegationExecutor(self.lab, self.emit)
        self.tool = AsyncMock(return_value={"summary": "天気情報を取得しました。"})
        self.backend = AsyncMock(side_effect=self.model_flow)
        self.patch = patch("lab.execution.run_backend", self.backend)
        self.patch.start()
        self.addCleanup(self.patch.stop)

    async def model_flow(self, context, emit) -> str:
        await emit("model_started", model="gpt-6-luna", model_round=1)
        await emit("model_completed", model="gpt-6-luna", model_round=1, response_id="resp_1")
        await emit("function_requested", call_id="model_call", function_name="search_weather",
                   arguments={"city": "東京", "time_scope": "current"}, response_id="resp_1")
        await emit("function_started")
        result = await self.tool(context)
        await emit("function_completed", result=result)
        return result["summary"]

    async def asyncTearDown(self) -> None:
        await self.executor.cancel()

    def queue(self, text: str, identifier: str = "d1") -> dict:
        self.lab.process(delta(text, event_id=f"text_{identifier}"))
        self.assertIsNone(self.lab.process(delegation(identifier)))
        handoff = self.lab.handoffs[-1]
        self.executor.submit(handoff, "0:request")
        return handoff

    async def finish(self) -> None:
        await asyncio.gather(*self.executor.tasks)

    async def test_ledger_to_model_and_correlated_append(self) -> None:
        handoff = self.queue("東京の天気を検索せよ")
        self.assertEqual(handoff["status"], "queued")
        self.assertIsNone(handoff["command"])
        await self.finish()
        self.assertEqual(self.backend.call_args.args[0], handoff["srt"])
        self.assertIn("USER: 東京の天気を検索せよ", handoff["srt"])
        self.assertEqual(self.lab.ledger.consume_srt(), "")
        self.assertEqual(handoff["function_call"]["id"], "model_call")
        self.assertEqual(handoff["function_call"]["status"], "succeeded")
        self.assertEqual(handoff["backend"]["responses"][0]["id"], "resp_1")
        self.assertEqual(handoff["command"]["delegation_id"], "d1")
        self.assertEqual(handoff["command"]["content"], "天気情報を取得しました。")
        started = next(call.args[0] for call in self.emit.call_args_list
                       if call.args[0].get("stage") == "model_started")
        self.assertEqual(started["ledger_srt"], handoff["srt"])
        self.assertEqual(started["consumed_srt"], handoff["srt"])
        self.assertEqual(started["source_event_ids"], ["text_d1"])
        self.assertIsNone(started["call_id"])
        self.assertTrue(started["execution_id"].startswith("call_"))

    async def test_duplicate_is_idempotent_and_context_keeps_previous_srt(self) -> None:
        first = self.queue("東京の天気")
        await self.finish()
        self.assertIsNone(self.lab.process(delegation()))
        second = self.queue("いえ、大阪", "d2")
        await self.finish()
        self.assertEqual(self.backend.await_count, 2)
        self.assertEqual(self.backend.call_args.args[0], first["srt"] + "\n\n" + second["srt"])
        requests = [call.args[0] for call in self.emit.call_args_list
                    if call.args[0].get("stage") == "model_started"]
        self.assertEqual(requests[0]["source_event_ids"], ["text_d1"])
        self.assertEqual(requests[1]["source_event_ids"], ["text_d1", "text_d2"])
        self.assertEqual(requests[1]["consumed_srt"], second["srt"])
        self.assertEqual(requests[1]["ledger_srt"], first["srt"] + "\n\n" + second["srt"])

    async def test_model_failure_returns_failure_and_never_executes_tool(self) -> None:
        self.backend.side_effect = BackendError("Azure returned HTTP 404.")
        handoff = self.queue("東京の天気")
        await self.finish()
        self.assertEqual(handoff["function_call"]["status"], "not_called")
        self.assertEqual(handoff["backend"]["status"], "failed")
        self.assertIn("失敗", handoff["command"]["content"])
        self.assertIn("404", handoff["error"])
        self.tool.assert_not_awaited()

    async def test_worker_does_not_block_transcripts_and_cancel_sends_no_result(self) -> None:
        entered = asyncio.Event()

        async def slow(context: str) -> dict:
            entered.set()
            await asyncio.Event().wait()
            return {}

        self.tool.side_effect = slow
        handoff = self.queue("東京の天気")
        await entered.wait()
        self.lab.process(delta("いえ、大阪", event_id="later"))
        self.assertIn("大阪", self.lab.snapshot()["pending_srt"])
        await self.executor.cancel()
        self.assertEqual(handoff["status"], "cancelled")
        self.assertIsNone(handoff["command"])

    async def test_late_transcript_wakes_waiting_delegation(self) -> None:
        self.lab.process(delegation())
        handoff = self.lab.handoffs[0]
        self.executor.submit(handoff, "0:request")
        await asyncio.sleep(0)
        self.assertEqual(handoff["status"], "awaiting_transcript")
        self.lab.process(delta("東京の天気"))
        self.executor.transcript_changed.set()
        await self.finish()
        self.assertEqual(handoff["function_call"]["status"], "succeeded")
        started = next(call.args[0] for call in self.emit.call_args_list
                       if call.args[0].get("stage") == "model_started")
        self.assertEqual(started["source_event_ids"], handoff["transcript_event_ids"])
        self.assertTrue(started["source_event_ids"])

    async def test_newer_delegation_suppresses_stale_success(self) -> None:
        entered, release = asyncio.Event(), asyncio.Event()

        async def slow(context: str) -> dict:
            entered.set()
            await release.wait()
            return {"summary": "取得しました。"}

        self.tool.side_effect = slow
        first = self.queue("東京の天気")
        await entered.wait()
        second = self.queue("いえ、大阪", "d2")
        release.set()
        await self.finish()
        self.assertEqual(first["status"], "superseded")
        self.assertIsNone(first["command"])
        self.assertEqual(second["command"]["delegation_id"], "d2")

    async def test_transcript_arriving_before_worker_starts_is_not_lost(self) -> None:
        self.lab.process(delegation())
        handoff = self.lab.handoffs[0]
        self.lab.process(delta("東京の天気"))
        self.executor.submit(handoff, "0:request")
        await self.finish()
        self.assertEqual(handoff["function_call"]["status"], "succeeded")

    async def test_legacy_fake_configuration_is_rejected_without_state_change(self) -> None:
        with self.assertRaises(ValueError):
            self.lab.configure_playground({"function_name": "search_weather", "result": "晴れ"})
        self.assertEqual(self.lab.snapshot()["playground"], {"function_name": "search_weather"})

    async def test_jev_mode_receives_ledger_and_preserves_real_stages(self) -> None:
        self.lab.configure_playground({"function_name": "search_weather", "backend": "jev"})
        decision = {"choice": "weather_tokyo", "confidence": 0.9, "threshold": 0.75,
                    "approved": True, "probabilities": {"weather_tokyo": 0.95, "clarify": 0.05}}

        async def jev_flow(context, emit, *, current_srt) -> str:
            self.assertEqual(context, current_srt)
            await emit("model_started", model="jev-latest", model_round=1, request_body={
                "state": {"ledger_srt": context, "current_srt": current_srt},
                "questions": {"action": {"type": "choice", "criteria": {"weather_tokyo": "東京"}}},
            })
            await emit("model_completed", model="jev-latest", actual_model="jev-test",
                       model_round=1, response_id=None, usage={"input_tokens": 30})
            await emit("decision_evaluated", decision=decision)
            await emit("function_requested", call_id="jev_call_local", function_name="search_weather",
                       arguments={"city": "東京", "time_scope": "current"},
                       selection_source="jev_choice", call_id_source="local")
            await emit("function_started")
            await emit("function_completed", result={"summary": "東京の天気を取得しました。"})
            await emit("result_formatted", content="東京の天気を取得しました。")
            return "東京の天気を取得しました。"

        with patch("lab.execution.run_jev", side_effect=jev_flow) as jev:
            handoff = self.queue("東京の現在の天気")
            await self.finish()
        jev.assert_awaited_once()
        self.backend.assert_not_awaited()
        self.assertEqual(handoff["backend_mode"], "jev")
        self.assertEqual(handoff["backend"]["decision"], decision)
        self.assertEqual(handoff["function_call"]["call_id_source"], "local")
        self.assertEqual(handoff["command"]["content"], "東京の天気を取得しました。")
        messages = [item.args[0] for item in self.emit.call_args_list if item.args[0]["type"] == "execution"]
        self.assertTrue(all(item["provider"] == "jev" for item in messages))
        self.assertNotIn("function_output", [item["stage"] for item in messages])
        self.assertEqual(len(handoff["backend"]["responses"]), 1)
        self.assertIsNone(handoff["backend"]["responses"][0]["id"])

    async def test_jev_clarification_is_not_execution_and_mode_change_is_guarded(self) -> None:
        self.lab.configure_playground({"function_name": "search_weather", "backend": "jev"})

        async def clarify(context, emit, *, current_srt) -> str:
            await emit("no_function_call", content="都市名と現在の天気を明示してください。")
            return "都市名と現在の天気を明示してください。"

        with patch("lab.execution.run_jev", side_effect=clarify):
            handoff = self.queue("天気を教えて")
            with self.assertRaisesRegex(ValueError, "実行中"):
                self.lab.configure_playground({"function_name": "search_weather", "backend": "azure"})
            await self.finish()
        self.assertEqual(handoff["function_call"]["status"], "not_called")
        self.assertIn("都市名", handoff["command"]["content"])
        self.backend.assert_not_awaited()
        self.lab.configure_playground({"function_name": "search_weather", "backend": "azure"})
        self.assertEqual(handoff["backend_mode"], "jev")

    async def test_unknown_backend_is_rejected(self) -> None:
        for backend in ("unknown", None, [], True):
            with self.subTest(backend=backend), self.assertRaises(ValueError):
                self.lab.configure_playground({"function_name": "search_weather", "backend": backend})

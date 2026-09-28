"""Client-owned task execution; the Ledger itself remains unmodified."""

from __future__ import annotations

import asyncio
import json
import logging
from collections.abc import Awaitable, Callable
from time import perf_counter
from typing import Any
from uuid import uuid4

from lab.state import TranscriptLab
from lab.backend import BackendError, run_backend, validate_call
from lab.jev import run_jev
from lab.weather import WeatherInputError, WeatherServiceError, search_weather_for_city

logger = logging.getLogger("transcript_lab")
Emit = Callable[[dict[str, Any]], Awaitable[None]]


class DelegationExecutor:
    def __init__(self, lab: TranscriptLab, emit: Emit) -> None:
        self.lab = lab
        self.emit = emit
        self.tasks: set[asyncio.Task[None]] = set()
        self.lock = asyncio.Lock()
        self.transcript_changed = asyncio.Event()
        self.context: list[str] = []
        self.context_event_ids: list[str] = []
        self.latest_id: str | None = None

    def submit(self, handoff: dict[str, Any], request_id: str | None) -> None:
        self.latest_id = handoff["id"]
        task = asyncio.create_task(self._run(handoff, request_id))
        self.tasks.add(task)
        task.add_done_callback(self._finished)

    def _finished(self, task: asyncio.Task[None]) -> None:
        self.tasks.discard(task)
        if not task.cancelled() and task.exception() is not None:
            logger.error("Delegation result could not be delivered to the inspector.")

    async def cancel(self) -> None:
        for task in self.tasks:
            task.cancel()
        if self.tasks:
            await asyncio.gather(*self.tasks, return_exceptions=True)
        for handoff in self.lab.handoffs:
            if handoff.get("backend_mode") != "responses" and handoff["status"] in {"queued", "awaiting_transcript", "executing"}:
                handoff["status"] = "cancelled"
                if handoff["function_call"]:
                    handoff["function_call"]["status"] = "cancelled"
                if handoff.get("backend"):
                    handoff["backend"]["status"] = "cancelled"

    async def _run(self, handoff: dict[str, Any], request_id: str | None) -> None:
        call = handoff["function_call"]
        execution_id = call["id"]
        backend_mode = handoff.get("backend_mode") or "azure"
        started = perf_counter()

        async def stage(name: str, **detail: Any) -> None:
            await self.emit({
                "type": "execution", "request_id": request_id,
                "stage": name, "delegation_id": handoff["id"],
                "provider": backend_mode,
                "execution_id": execution_id,
                "call_id": call["id"] if call.get("model_selected") else None,
                "function_name": call["name"],
                "event_id": handoff["event_id"],
                "elapsed_ms": (perf_counter() - started) * 1000,
                **detail,
            })
            await self.emit({**self.lab.snapshot(), "request_id": request_id})

        async def backend_stage(name: str, **detail: Any) -> None:
            backend = handoff["backend"]
            if name == "model_started":
                backend.update(model=detail["model"], status="running")
                detail.update(
                    ledger_srt=context, consumed_srt=handoff["srt"],
                    source_event_ids=self.context_event_ids.copy(),
                )
            elif name == "model_completed":
                backend["responses"].append({
                    "id": detail["response_id"], "model": detail["model"],
                    "actual_model": detail.get("actual_model"),
                    "round": detail["model_round"], "usage": detail.get("usage"),
                })
            elif name == "function_requested":
                call.update(id=detail["call_id"], name=detail["function_name"],
                            arguments=detail["arguments"], status="requested", model_selected=True,
                            selection_source=detail.get("selection_source", "function_call"),
                            call_id_source=detail.get("call_id_source", "model"))
            elif name == "decision_evaluated":
                backend["decision"] = detail["decision"]
            elif name == "function_started":
                call["status"] = "executing"
            elif name == "function_completed":
                call.update(status="succeeded", result=detail["result"])
            elif name == "function_failed":
                call.update(status="failed", error=detail["error"])
                handoff["error"] = detail["error"]
            elif name == "no_function_call":
                call["status"] = "not_called"
            await stage(name, **detail)

        try:
            async with self.lock:
                # Consume again only when delegation arrived before caller text.
                # This is a visible bounded wait, not a guessed offset_ms cutoff.
                if "USER:" not in handoff["srt"] and self.latest_id == handoff["id"]:
                    handoff["status"] = "awaiting_transcript"
                    await stage("awaiting_transcript", srt=handoff["srt"])
                    deadline = asyncio.get_running_loop().time() + 2.0
                    while "USER:" not in handoff["srt"]:
                        self.transcript_changed.clear()
                        if self.latest_id != handoff["id"]:
                            break
                        extra, event_ids = self.lab.consume_transcript()
                        if extra:
                            handoff["srt"] = "\n\n".join(filter(None, [handoff["srt"], extra]))
                            handoff["transcript_event_ids"].extend(event_ids)
                        if "USER:" in handoff["srt"]:
                            break
                        remaining = deadline - asyncio.get_running_loop().time()
                        if remaining <= 0:
                            break
                        try:
                            await asyncio.wait_for(self.transcript_changed.wait(), remaining)
                        except TimeoutError:
                            break
                if handoff["srt"]:
                    self.context.append(handoff["srt"])
                    self.context_event_ids.extend(handoff["transcript_event_ids"])
                if self.latest_id != handoff["id"]:
                    handoff["status"] = call["status"] = "superseded"
                    await stage("superseded")
                    return
                context = "\n\n".join(self.context)
                await stage("context", srt=handoff["srt"], backend_context=context,
                            source_event_ids=self.context_event_ids.copy())
                handoff["status"] = "executing"
                call["status"] = "planning"
                handoff["backend"] = {"provider": backend_mode, "status": "running", "responses": []}
                call["input_srt"] = handoff["srt"]
                try:
                    if "USER:" not in handoff["srt"]:
                        raise WeatherInputError("新しい発話がまだ届いていません。都市名と天気の依頼をもう一度お話しください。")
                    if len(context.encode("utf-8")) > 256_000:
                        raise WeatherInputError("会話が長すぎます。記録を保存し、セッションをリセットしてください。")
                    async with asyncio.timeout(90):
                        if backend_mode == "jev":
                            content = await run_jev(context, backend_stage, current_srt=handoff["srt"])
                        else:
                            content = await run_backend(context, backend_stage)
                    handoff["backend"]["status"] = "completed"
                except (WeatherInputError, BackendError, TimeoutError) as error:
                    content = error.spoken if isinstance(error, BackendError) else (
                        str(error) or "バックエンド処理がタイムアウトしました。結果の回答は完了していません。"
                    )
                    handoff["error"] = str(error) or content
                    handoff["backend"].update(status="failed", error=handoff["error"])
                    if call["status"] in {"planning", "requested"}:
                        call["status"] = "not_called"
                    logger.warning("Backend execution failed: %s", type(error).__name__)
                    await stage("backend_failed", error=handoff["error"])
                if self.lab.closed or self.latest_id != handoff["id"]:
                    handoff["status"] = "superseded"
                    await stage("superseded", reason="A newer delegation or session close superseded this result.")
                    return
                command = {
                    "type": "session.commentary.append",
                    "event_id": f"result_{uuid4().hex}",
                    "delegation_id": handoff["id"],
                    "content": content,
                }
                handoff.update(command=command, status="prepared")
                await stage("result_ready", command=command, function_status=call["status"])
                await self.emit({"type": "command", "event": command, "request_id": request_id})
        except asyncio.CancelledError:
            handoff["status"] = "cancelled"
            if handoff.get("backend"):
                handoff["backend"]["status"] = "cancelled"
            if call["status"] in {"queued", "planning", "requested", "executing"}:
                call["status"] = "cancelled"
            raise
        except Exception:
            # Keep background exceptions visible, but never leak credentials or
            # arbitrary upstream bodies into the browser or a spoken response.
            logger.exception("Delegation worker failed")
            handoff.update(status="failed", error="バックエンド処理が失敗しました。サーバーログを確認してください。")
            if call["status"] != "succeeded":
                call["status"] = "failed"
            await stage("backend_failed", error=handoff["error"])


class ResponsesExecutor:
    def __init__(self, lab: TranscriptLab, emit: Emit) -> None:
        self.lab = lab
        self.emit = emit
        self.tasks: set[asyncio.Task[None]] = set()
        self.deliveries: dict[str, asyncio.Future[bool]] = {}
        self.calls: dict[str, dict[str, dict[str, Any]]] = {}
        self.completed: set[tuple[str, str]] = set()
        self.stopped = False

    def _spawn(self, coroutine: Any) -> None:
        task = asyncio.create_task(coroutine)
        self.tasks.add(task)
        task.add_done_callback(self.tasks.discard)

    async def _stage(self, handoff: dict[str, Any], stage: str, **detail: Any) -> None:
        await self.emit({
            "type": "execution", "provider": "responses", "stage": stage,
            "delegation_id": handoff["id"], "response_id": handoff["response_id"],
            **detail,
        })
        await self.emit(self.lab.snapshot())

    def confirm(self, event_id: object, status: str) -> None:
        if isinstance(event_id, str):
            future = self.deliveries.get(event_id)
            if future is not None and not future.done():
                future.set_result(status == "sent")

    async def cancel(self) -> None:
        self.stopped = True
        for future in self.deliveries.values():
            if not future.done():
                future.set_result(False)
        for task in self.tasks:
            task.cancel()
        if self.tasks:
            await asyncio.gather(*self.tasks, return_exceptions=True)
        for handoff in self.lab.handoffs:
            if handoff.get("backend_mode") == "responses" and handoff["status"] in {
                "awaiting_model", "executing", "awaiting_response", "sending_results",
            }:
                handoff["status"] = "cancelled"
                handoff["backend"]["status"] = "cancelled"
                for call in handoff["function_calls"]:
                    if call["status"] == "executing":
                        call["status"] = "cancelled"

    async def observe(self, event: dict[str, Any]) -> None:
        if self.stopped or self.lab.delegation_mode != "responses":
            return
        kind = event["type"]
        if kind == "error":
            error = event.get("error")
            error = error if isinstance(error, dict) else {}
            command_id = event.get("client_event_id") or error.get("event_id") or error.get("client_event_id")
            if command_id:
                self.confirm(command_id, "rejected")
            for item in self.lab.handoffs:
                if item.get("backend_mode") == "responses" and item["status"] not in {"completed", "cancelled", "failed"}:
                    if not command_id or any(record["event"]["event_id"] == command_id for record in item["commands"]):
                        await self._fail(item, "Live API が Responses の処理エラーを通知しました。")
            return
        identifier = event.get("delegation_id")
        if kind == "session.delegation.created":
            identifier = event["delegation"]["id"]
        handoff = next((item for item in self.lab.handoffs if item["id"] == identifier), None)
        if handoff is None or handoff.get("backend_mode") != "responses":
            return
        if kind == "session.delegation.created":
            if identifier not in self.calls:
                self.calls[identifier] = {}
                await self._stage(handoff, "responses_started")
                self._spawn(self._deadline(handoff))
            return
        if kind != "response.event" or handoff["status"] in {"failed", "cancelled", "completed"}:
            return
        nested = event.get("event")
        if not isinstance(nested, dict):
            return
        response = nested.get("response")
        response = response if isinstance(response, dict) else {}
        response_id = response.get("id") or nested.get("response_id") or handoff["response_id"]
        if not isinstance(response_id, str):
            return
        nested_type = nested.get("type")
        if nested_type == "response.created":
            handoff["response_id"] = response_id
            handoff["status"] = "awaiting_model"
            await self._stage(handoff, "responses_started")
        elif nested_type == "response.output_item.done":
            item = nested.get("item")
            if isinstance(item, dict) and item.get("type") == "function_call":
                call_id = item.get("call_id")
                if isinstance(call_id, str) and call_id:
                    self.calls[identifier].setdefault(call_id, {**item, "response_id": response_id})
                else:
                    await self._fail(handoff, "call_id のない関数要求を拒否しました。")
        elif nested_type in {"response.failed", "response.cancelled", "response.incomplete", "error"}:
            await self._fail(handoff, f"Responses の処理が終了しました: {nested_type}")
        elif nested_type == "response.completed":
            key = (identifier, response_id)
            if key in self.completed:
                return
            self.completed.add(key)
            if response.get("status", "completed") != "completed":
                await self._fail(handoff, "Responses が正常完了していません。")
                return
            for item in response.get("output", []):
                if isinstance(item, dict) and item.get("type") == "function_call":
                    call_id = item.get("call_id")
                    if not isinstance(call_id, str) or not call_id:
                        await self._fail(handoff, "call_id のない関数要求を拒否しました。")
                        return
                    self.calls[identifier].setdefault(call_id, {**item, "response_id": response_id})
            pending = [item for item in self.calls[identifier].values()
                       if item["response_id"] == response_id and not item.get("handled")]
            handoff["backend"]["responses"].append({
                "id": response_id, "model": response.get("model"), "usage": response.get("usage"),
            })
            await self._stage(handoff, "responses_round_completed", response=response)
            if pending:
                for item in pending:
                    item["handled"] = True
                self._spawn(self._execute(handoff, pending))
            else:
                handoff["status"] = "completed"
                handoff["backend"]["status"] = "completed"
                await self._stage(handoff, "responses_completed", response=response)

    async def _fail(self, handoff: dict[str, Any], message: str) -> None:
        handoff.update(status="failed", error=message)
        handoff["backend"].update(status="failed", error=message)
        await self._stage(handoff, "responses_failed", error=message)

    async def _deadline(self, handoff: dict[str, Any]) -> None:
        try:
            async with asyncio.timeout(90):
                await asyncio.Future()
        except TimeoutError:
            if handoff["status"] not in {"completed", "failed", "cancelled"}:
                await self._fail(handoff, "Responses の完了を 90 秒以内に確認できませんでした。")

    async def _send(self, handoff: dict[str, Any], command: dict[str, Any]) -> None:
        if self.stopped or self.lab.closed or handoff["status"] in {"failed", "cancelled"}:
            raise BackendError("セッション終了または中断のため送信しません。")
        event_id = f"responses_{uuid4().hex}"
        command["event_id"] = event_id
        record = {"event": command, "status": "pending"}
        handoff["commands"].append(record)
        future = asyncio.get_running_loop().create_future()
        self.deliveries[event_id] = future
        try:
            await self._stage(handoff, "responses_command", command=command)
            await self.emit({"type": "command", "event": command, "protocol": "responses",
                             "delegation_id": handoff["id"]})
            if not await asyncio.wait_for(future, 10):
                raise BackendError("関数結果または続行要求を送信できませんでした。")
        finally:
            self.deliveries.pop(event_id, None)
            if record["status"] == "pending":
                record["status"] = "send_failed"

    async def _execute(self, handoff: dict[str, Any], calls: list[dict[str, Any]]) -> None:
        try:
            if len(handoff["function_calls"]) + len(calls) > 4:
                raise BackendError("1 委譲あたりの関数要求数の上限を超えました。")
            for item in calls:
                if self.stopped or self.lab.closed or handoff["status"] in {"failed", "cancelled"}:
                    return
                call = {"id": item["call_id"], "name": item.get("name"), "status": "requested",
                        "model_selected": True, "arguments": item.get("arguments")}
                handoff["function_calls"].append(call)
                handoff["function_call"] = call
                try:
                    arguments = validate_call(item)
                    call["arguments"] = arguments
                    await self._stage(handoff, "function_requested", call_id=call["id"],
                                      function_name=call["name"], arguments=arguments)
                    if self.lab.snapshot()["playground"] is None:
                        raise WeatherInputError("天気検索は OFF です。検索は実行していません。")
                    if any(previous["status"] == "succeeded" for previous in handoff["function_calls"]):
                        raise WeatherInputError("この委譲の天気検索は実行済みです。追加検索は実行しません。")
                    handoff["status"] = call["status"] = "executing"
                    await self._stage(handoff, "function_started", call_id=call["id"],
                                      function_name=call["name"], arguments=arguments)
                    async with asyncio.timeout(30):
                        result = await search_weather_for_city(**arguments)
                    call.update(status="succeeded", result=result)
                    await self._stage(handoff, "function_completed", call_id=call["id"], result=result)
                except (BackendError, WeatherInputError, WeatherServiceError, TimeoutError) as error:
                    result = {"status": "error", "error": str(error) or "天気検索がタイムアウトしました。"}
                    call.update(status="failed", result=result)
                    await self._stage(handoff, "function_failed", call_id=call["id"], error=result["error"])
                output = json.dumps(result, ensure_ascii=False)
                if len(output.encode("utf-8")) > 24_000:
                    output = json.dumps({"status": "error", "error": "関数結果のサイズ上限を超えました。"}, ensure_ascii=False)
                if handoff["status"] in {"failed", "cancelled"}:
                    return
                handoff["status"] = "sending_results"
                await self._send(handoff, {"type": "response.item.create", "item": {
                    "type": "function_call_output", "call_id": call["id"], "output": output,
                }})
            handoff["status"] = "awaiting_response"
            await self._send(handoff, {"type": "response.create"})
            if handoff["status"] not in {"completed", "failed", "cancelled"}:
                await self._stage(handoff, "responses_continued")
        except asyncio.CancelledError:
            raise
        except Exception as error:
            await self._fail(handoff, str(error) if isinstance(error, BackendError)
                             else "Responses の関数実行または結果送信に失敗しました。")

"""Observable adapter around the unchanged Cookbook Ledger."""

from __future__ import annotations

from copy import deepcopy
from dataclasses import asdict
from typing import Any
from uuid import uuid4

from vendor.openai_cookbook.memory import TranscriptLedger
from lab.timing import OperationTrace

MAX_EVENTS = 5_000
MAX_FRAME_BYTES = 65_536
TRANSCRIPT_TYPES = {
    "session.input_transcript.delta",
    "session.output_transcript.delta",
}
STUB_RESULT = (
    "This is a transcript inspection demo. The backend received the delegation, "
    "but no lookup, decision, or external action was performed. "
    "Jev is not connected. Tell the user briefly in Japanese that this is a demo "
    "and no action has been executed."
)
def validate_playground_config(config: object) -> dict[str, Any] | None:
    if config is None:
        return None
    if (
        not isinstance(config, dict)
        or set(config) - {"function_name", "backend"}
        or config.get("function_name") != "search_weather"
        or config.get("backend", "azure") not in ("azure", "jev")
    ):
        raise ValueError("実行可能な関数は search_weather、判断モードは azure または jev です。模擬の引数・戻り値は指定できません。")
    return dict(config)


def validate_event(event: object) -> dict[str, Any]:
    if not isinstance(event, dict) or not isinstance(event.get("type"), str):
        raise ValueError("An event object with a string type is required.")
    if event["type"] in TRANSCRIPT_TYPES:
        if not isinstance(event.get("event_id"), str) or not event["event_id"]:
            raise ValueError("Transcript deltas require a nonempty event_id.")
        if not isinstance(event.get("delta"), str):
            raise ValueError("Transcript delta must be a string.")
        start, end = event.get("start_ms"), event.get("end_ms")
        if (
            type(start) is not int
            or type(end) is not int
            or not 0 <= start <= end <= 9_007_199_254_740_991
        ):
            raise ValueError("Transcript timestamps must be safe integers: 0 <= start_ms <= end_ms.")
    if event["type"] == "session.delegation.created":
        delegation = event.get("delegation")
        if (
            not isinstance(delegation, dict)
            or not isinstance(delegation.get("id"), str)
            or not delegation["id"]
            or delegation.get("target") not in ("client", "responses")
        ):
            raise ValueError("Delegation requires an id and a client/responses target.")
        if type(event.get("offset_ms")) is not int or event["offset_ms"] < 0:
            raise ValueError("Delegation requires a nonnegative integer offset_ms.")
        if delegation["target"] == "responses" and (
            not isinstance(delegation.get("response_id"), str) or not delegation["response_id"]
        ):
            raise ValueError("Responses delegation requires a response_id.")
    if event["type"] == "response.event":
        nested = event.get("event")
        if not isinstance(nested, dict) or not isinstance(nested.get("type"), str):
            raise ValueError("Responses events require a nested event type.")
        response = nested.get("response")
        if response is not None and (
            not isinstance(response, dict)
            or ("output" in response and not isinstance(response["output"], list))
        ):
            raise ValueError("Responses output must be an array.")
    return event


class TranscriptLab:
    def __init__(self, delegation_mode: str = "client") -> None:
        if delegation_mode not in {"client", "responses"}:
            raise ValueError("委譲モードは client または responses です。")
        self.delegation_mode = delegation_mode
        self.operations = OperationTrace()
        self.ledger = TranscriptLedger() if delegation_mode == "client" else None
        self.event_count = 0
        self.handoffs: list[dict[str, Any]] = []
        self.trace: list[dict[str, Any]] = []
        self.closed = False
        self._delegation_ids: set[str] = set()
        self._event_ids: set[str] = set()
        self._pending_transcript_event_ids: list[str] = []
        self._sequence = 0
        self._playground: dict[str, Any] | None = None

    def configure_playground(self, config: object) -> None:
        if self.closed:
            raise ValueError("セッションは終了しています。リセットしてください。")
        resolved = validate_playground_config(config)
        if self.delegation_mode == "responses" and resolved and resolved.get("backend", "azure") != "azure":
            raise ValueError("Responses delegation の判断方式は Function Calling です。")
        if resolved is not None and resolved != self._playground and any(
            item["status"] in {"queued", "awaiting_transcript", "executing"} for item in self.handoffs
        ):
            raise ValueError("実行中は判断モードを変更できません。完了を待つか、天気検索を OFF にしてください。")
        self._playground = resolved
        if resolved is None:
            self._trace("lab.playground", "disabled", "Playground cleared; delegation now returns the fixed stub.")
        else:
            self._trace(
                "lab.playground", "configured",
                f"{resolved['function_name']} / {self.delegation_mode} / {resolved.get('backend', 'azure')}.",
            )

    def _trace(self, event_type: str, action: str, detail: str) -> None:
        self.operations.mark(action, detail)
        self._sequence += 1
        self.trace.append(
            {"seq": self._sequence, "event_type": event_type, "action": action, "detail": detail}
        )
        self.trace = self.trace[-200:]

    def snapshot(self) -> dict[str, Any]:
        # consume_srt mutates cursors; preview only on a copy.
        preview = deepcopy(self.ledger).consume_srt() if self.ledger is not None else ""
        return {
            "type": "state",
            "delegation_mode": self.delegation_mode,
            "ledger_enabled": self.ledger is not None,
            "event_count": self.event_count,
            "ledger": [
                {**asdict(segment), "pending_text": segment.text[segment.delivered_characters :]}
                for segment in self.ledger._segments
            ] if self.ledger is not None else [],
            "pending_srt": preview,
            "handoffs": deepcopy(self.handoffs),
            "trace": self.trace.copy(),
            "closed": self.closed,
            "playground": deepcopy(self._playground),
        }

    def consume_transcript(self) -> tuple[str, list[str]]:
        if self.ledger is None:
            raise ValueError("Responses delegation では Ledger を使用しません。")
        srt = self.ledger.consume_srt()
        event_ids = self._pending_transcript_event_ids
        self._pending_transcript_event_ids = []
        return srt, event_ids

    def process(self, raw_event: object) -> dict[str, Any] | None:
        with self.operations.span("validate_event"):
            event = validate_event(raw_event)
        kind = event["type"]
        if self.closed:
            raise ValueError("This session is closed. Reset before adding events.")
        if self.event_count >= MAX_EVENTS:
            raise ValueError(f"Session limit of {MAX_EVENTS} events reached. Export and reset.")
        self.event_count += 1
        event_id = event.get("event_id")
        if isinstance(event_id, str):
            if event_id in self._event_ids:
                self._trace(kind, "duplicate", f"Ignored duplicate event_id: {event_id}")
                return None
            self._event_ids.add(event_id)
        if kind in TRANSCRIPT_TYPES:
            if self.ledger is None:
                return None
            if event.get("_lab_generated_event_id"):
                self._trace(kind, "local_event_id", "No server event_id; browser assigned a unique reception ID.")
            before = {segment.identifier: segment.text for segment in self.ledger._segments}
            with self.operations.span("TranscriptLedger.record_event"):
                self.ledger.record_event(event)
            after = {segment.identifier: segment.text for segment in self.ledger._segments}
            changed = [key for key, text in after.items() if before.get(key) != text]
            if changed:
                self._pending_transcript_event_ids.append(event["event_id"])
            action = "merge" if changed and all(key in before for key in changed) else "new_segment"
            if not changed:
                action = "empty_delta"
            self._trace(kind, action, ", ".join(changed) or "No transcript change.")
        elif kind == "session.delegation.created":
            delegation = event["delegation"]
            identifier = delegation["id"]
            if delegation["target"] != self.delegation_mode:
                self._trace(kind, "ignored", "Delegation does not match the selected mode.")
                return None
            if identifier in self._delegation_ids:
                self._trace(kind, "duplicate", f"Ignored repeated delegation: {identifier}")
                return None
            self._delegation_ids.add(identifier)
            if self.delegation_mode == "responses":
                response_id = delegation.get("response_id")
                self.handoffs.append({
                    "id": identifier, "offset_ms": event["offset_ms"], "event_id": event_id,
                    "srt": "", "transcript_event_ids": [], "backend_mode": "responses",
                    "response_id": response_id, "function_call": None, "function_calls": [],
                    "command": None, "commands": [], "status": "awaiting_model",
                    "backend": {"provider": "responses", "status": "running", "responses": []},
                })
                self._trace(kind, "responses_delegation", identifier)
                return None
            with self.operations.span("TranscriptLedger.consume_srt", "delegation"):
                srt, transcript_event_ids = self.consume_transcript()
            execute = self._playground is not None
            command = None
            if not execute:
                with self.operations.span("fixed stub / prepare command", "delegation"):
                    command = {
                        "type": "session.commentary.append",
                        "event_id": f"stub_{len(self.handoffs) + 1}",
                        "delegation_id": identifier,
                        "content": STUB_RESULT,
                    }
            self.handoffs.append(
                {
                    "id": identifier,
                    "offset_ms": event["offset_ms"],
                    "srt": srt,
                    "transcript_event_ids": transcript_event_ids,
                    "event_id": event_id,
                    "backend_mode": self._playground.get("backend", "azure") if self._playground is not None else None,
                    "function_call": {
                        "id": f"call_{uuid4().hex}",
                        "name": self._playground["function_name"],
                        "status": "queued",
                    } if self._playground is not None else None,
                    "command": command,
                    "status": "queued" if execute else "prepared",
                }
            )
            self._trace(
                kind,
                "consume_srt",
                "All undelivered text consumed now; offset_ms is metadata, not a causal cutoff. "
                "Late deltas remain pending for the next delegation.",
            )
            return command
        elif kind == "session.commentary.appended":
            command_id = event.get("client_event_id")
            if command_id is None and isinstance(event.get("delegation_id"), str):
                matching = [item for item in self.handoffs if item["id"] == event["delegation_id"]]
                if len(matching) == 1 and matching[0]["command"]:
                    command_id = matching[0]["command"]["event_id"]
            if command_id is None:
                self._trace(kind, "uncorrelated_ack", "Append accepted, but no ID identifies a stub command.")
            else:
                self.command_status(command_id, "acknowledged")
        elif kind == "error":
            error = event.get("error", {})
            client_event_id = event.get("client_event_id")
            if isinstance(error, dict):
                client_event_id = client_event_id or error.get("client_event_id") or error.get("event_id")
            self.command_status(client_event_id, "rejected")
            self._trace(kind, "api_error", "The server reported an error; inspect the raw event.")
        elif kind == "session.closed":
            self.closed = True
            self._trace(kind, "closed", "Session closed. Ledger remains visible until reset.")
        else:
            self._trace(kind, "observed", "Not a transcript delta; Ledger unchanged.")
        return None

    def consume(self) -> None:
        if self.closed:
            raise ValueError("This session is closed. Reset before consuming.")
        if len(self.handoffs) >= MAX_EVENTS:
            raise ValueError("Handoff limit reached. Export and reset.")
        with self.operations.span("TranscriptLedger.consume_srt (manual)", "delegation"):
            srt, transcript_event_ids = self.consume_transcript()
        self.handoffs.append(
            {
                "id": f"manual:{len(self.handoffs) + 1}",
                "offset_ms": None,
                "srt": srt,
                "transcript_event_ids": transcript_event_ids,
                "function_call": None,
                "command": None,
                "status": "consumed_locally",
            }
        )
        self._trace("lab.consume", "consume_srt", "Manual inspection only; nothing sent to GPT-Live.")

    def command_status(self, event_id: object, status: str, detail: str = "") -> None:
        for handoff in self.handoffs:
            for record in handoff.get("commands", []):
                if record["event"]["event_id"] == event_id:
                    if record["status"] == "pending":
                        record["status"] = status
                    if status in {"send_failed", "not_sent", "rejected"}:
                        handoff.update(status="failed", error=detail or status)
                    return
            command = handoff["command"]
            if command and command["event_id"] == event_id:
                # A fast server ACK must not be downgraded by local send confirmation.
                if status == "sent" and handoff["status"] in {"acknowledged", "rejected"}:
                    return
                handoff["status"] = status
                if detail:
                    handoff["error"] = detail[:500]
                self._trace("lab.command", status, f"{event_id}: {detail}" if detail else str(event_id))
                return
        if event_id is not None:
            self._trace("lab.command", "unmatched", f"No stub command matches {event_id}.")

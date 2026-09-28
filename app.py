"""Local-only Web UI: Python Ledger and trusted WebRTC session creation."""

from __future__ import annotations

import json
import logging
from pathlib import Path
from typing import Annotated, Literal
from copy import deepcopy

import httpx
from azure.core.exceptions import ClientAuthenticationError
from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException, Request, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, ConfigDict, Field, StringConstraints, ValidationError, field_validator
from starlette.middleware.trustedhost import TrustedHostMiddleware
from starlette.middleware.base import RequestResponseEndpoint
from starlette.responses import Response

from lab.provider import BackendSettings, LiveSettings
from lab.state import MAX_EVENTS, MAX_FRAME_BYTES, TranscriptLab, validate_playground_config
from lab.execution import DelegationExecutor, ResponsesExecutor
from lab.backend import INSTRUCTIONS as BACKEND_INSTRUCTIONS, WEATHER_TOOL
from lab.jev import JevSettings
from lab.weather import SUPPORTED_CITIES
from lab.timing import OperationTrace
from lab.upstream import session_error_detail

ROOT = Path(__file__).resolve().parent
load_dotenv(ROOT / ".env", override=False)
MODEL = "gpt-live-1"
INSTRUCTIONS = (
    "Speak Japanese, naturally and briefly. Explain that you are an AI voice. "
    "Delegate requests requiring information lookup or actions to the configured backend. "
    "The application can execute search_weather to retrieve current weather estimates. "
    "Delegate weather requests, including corrections, rather than answering from memory. "
    "Wait for the backend result before claiming success. Speak the confirmed result in Japanese, "
    "including that the lookup was performed and that the weather is a model estimate. "
    "If the backend reports failure, missing information, or disabled execution, explain that honestly. "
    "Do not treat receipt of a delegation as proof of execution."
)
logger = logging.getLogger("transcript_lab")

app = FastAPI(title="GPT-Live Transcript Lab", docs_url=None, redoc_url=None)
app.add_middleware(TrustedHostMiddleware, allowed_hosts=["localhost", "127.0.0.1", "[::1]"])
app.mount("/static", StaticFiles(directory=ROOT / "static", check_dir=False), name="static")


@app.middleware("http")
async def session_timings(request: Request, call_next: RequestResponseEndpoint) -> Response:
    if request.url.path != "/api/session":
        response = await call_next(request)
        if request.url.path == "/" or request.url.path.startswith("/static/"):
            response.headers["Cache-Control"] = "no-store"
        return response
    operations = OperationTrace()
    request.state.operations = operations
    response = await call_next(request)
    # Only fixed operation names and durations are exposed, including on HTTP errors.
    metrics = [
        f'{item["label"]};dur={item["end_ms"] - item["start_ms"]:.3f};'
        f'desc="{item["start_ms"]:.3f}:{item["status"]}"'
        for item in operations.spans
    ]
    response.headers["Server-Timing"] = ", ".join([*metrics, f"total;dur={operations.now():.3f}"])
    return response


class SessionOffer(BaseModel):
    model_config = ConfigDict(extra="forbid")
    delegation_mode: Literal["client", "responses"] = "client"
    sdp: str = Field(min_length=1, max_length=60_000)
    instructions: Annotated[str, StringConstraints(strip_whitespace=True)] = Field(
        default=INSTRUCTIONS, min_length=1, max_length=4_000
    )

    @field_validator("sdp")
    @classmethod
    def validate_sdp(cls, value: str) -> str:
        if not value.strip():
            raise ValueError("SDP must not be blank.")
        # SDP is a wire format: stripping its final CRLF causes Azure's parser to report EOF.
        return value


def same_origin(origin: str | None, host: str | None, scheme: str) -> bool:
    return bool(origin and host and origin == f"{scheme}://{host}")


@app.get("/")
async def index() -> FileResponse:
    return FileResponse(ROOT / "static" / "index.html")


@app.get("/api/config")
async def config() -> dict[str, object]:
    try:
        backend = BackendSettings.from_env()
        backend_config = {"backend_model": backend.model, "backend_available": True}
    except ValueError as error:
        backend_config = {"backend_model": "gpt-6-luna", "backend_available": False, "backend_error": str(error)}
    backends = {
        "azure": {
            "model": backend_config["backend_model"], "available": backend_config["backend_available"],
            "error": backend_config.get("backend_error"),
        },
    }
    try:
        jev = JevSettings.from_env()
        backends["jev"] = {"model": jev.model, "available": True, "threshold": jev.threshold}
    except ValueError as error:
        backends["jev"] = {"model": "jev-latest", "available": False, "error": str(error)}
    try:
        settings = LiveSettings.from_env()
        backends["responses"] = {"model": settings.responses_model, "available": settings.live_available}
    except ValueError as error:
        return {
            "api_key_configured": False,
            "live_available": False,
            "config_error": str(error),
            "model": MODEL,
            "instructions": INSTRUCTIONS,
            "max_events": MAX_EVENTS,
            "weather_cities": list(SUPPORTED_CITIES),
            "playground_protocol": 5,
            "backends": backends,
            **backend_config,
        }
    return {
        "api_key_configured": bool(settings.api_key),
        "live_available": settings.live_available,
        "provider": settings.provider,
        "auth_mode": settings.auth_mode,
        "model": settings.model,
        "instructions": INSTRUCTIONS,
        "max_events": MAX_EVENTS,
        "weather_cities": list(SUPPORTED_CITIES),
        "playground_protocol": 5,
        "backends": backends,
        **backend_config,
    }


@app.get("/api/health")
async def health() -> dict[str, str]:
    return {"status": "ok"}


@app.post("/api/session", status_code=201)
async def create_session(request: Request) -> dict[str, object]:
    if not same_origin(request.headers.get("origin"), request.headers.get("host"), request.url.scheme):
        raise HTTPException(403, "Unexpected origin. Open this app on localhost.")
    content = bytearray()
    async for chunk in request.stream():
        content.extend(chunk)
        if len(content) > MAX_FRAME_BYTES:
            raise HTTPException(413, "SDP request is too large.")
    try:
        offer = SessionOffer.model_validate_json(content)
    except ValidationError as error:
        raise HTTPException(422, "A nonempty SDP offer and optional instructions are required.") from error
    try:
        with request.state.operations.span("authentication", "transport"):
            settings = LiveSettings.from_env()
            headers = await settings.headers()
    except ValueError as error:
        raise HTTPException(503, str(error)) from error
    except ClientAuthenticationError as error:
        raise HTTPException(
            503,
            "Azure CLI authentication failed. Sign in with az login using an identity with "
            "Cognitive Services OpenAI User access to this resource, or set AZURE_OPENAI_API_KEY.",
        ) from error
    delegation: dict[str, object] = {"type": offer.delegation_mode}
    if offer.delegation_mode == "responses":
        try:
            responses_model = settings.responses_model
        except ValueError as error:
            raise HTTPException(422, str(error)) from error
        delegation["responses"] = {
            "model": responses_model, "instructions": BACKEND_INSTRUCTIONS,
            "tools": [deepcopy(WEATHER_TOOL)], "tool_choice": "auto", "parallel_tool_calls": False,
        }
    payload = {
        "session": {
            "model": settings.model,
            "instructions": offer.instructions,
            "delegation": delegation,
        },
        "transport": {"type": "webrtc", "sdp": offer.sdp},
    }
    # Session creation is billable: deliberately no automatic retries.
    try:
        with request.state.operations.span("upstream_session", "transport") as upstream_timing:
            async with httpx.AsyncClient(timeout=30.0) as client:
                response = await client.post(
                    settings.url,
                    headers=headers,
                    json=payload,
                )
                if not response.is_success:
                    upstream_timing["status"] = "error"
    except httpx.RequestError as error:
        logger.warning("Live session transport failed: %s", type(error).__name__)
        raise HTTPException(502, "Could not reach OpenAI. Check network connectivity.") from error
    if not response.is_success:
        detail = session_error_detail(
            response,
            settings.provider,
            sensitive_values=(
                *headers.values(),
                *(value.removeprefix("Bearer ") for value in headers.values()),
                offer.instructions,
                offer.sdp,
                *offer.sdp.splitlines(),
                *(
                    line.partition(":")[2]
                    for line in offer.sdp.splitlines()
                    if line.startswith(("a=ice-pwd:", "a=ice-ufrag:"))
                ),
            ),
        )
        logger.warning("Live session creation failed: HTTP %s (details in browser)", response.status_code)
        status = response.status_code if response.status_code in {400, 401, 403, 404, 429} else 502
        raise HTTPException(status, detail)
    try:
        result = response.json()
    except ValueError as error:
        raise HTTPException(502, "OpenAI returned an invalid session response.") from error
    if (
        not isinstance(result, dict)
        or not isinstance(result.get("session"), dict)
        or not isinstance(result["session"].get("id"), str)
        or not result["session"]["id"]
        or not isinstance(result.get("transport"), dict)
        or not isinstance(result["transport"].get("sdp"), str)
        or not result["transport"]["sdp"]
        or result["transport"].get("type") != "webrtc"
    ):
        raise HTTPException(502, "OpenAI response is missing the WebRTC session ID or SDP answer.")
    # Only the public session ID and SDP answer cross the trust boundary.
    return {
        "session": {"id": result["session"]["id"]},
        "transport": {"type": "webrtc", "sdp": result["transport"]["sdp"]},
    }


@app.websocket("/ws")
async def inspect_session(socket: WebSocket) -> None:
    scheme = "https" if socket.url.scheme == "wss" else "http"
    if not same_origin(socket.headers.get("origin"), socket.headers.get("host"), scheme):
        await socket.close(code=1008, reason="Unexpected origin")
        return
    await socket.accept()
    lab = TranscriptLab()
    executor = DelegationExecutor(lab, socket.send_json)
    responses_executor = ResponsesExecutor(lab, socket.send_json)
    await socket.send_json(lab.snapshot())
    try:
        while True:
            raw = await socket.receive_text()
            operations = OperationTrace()
            lab.operations = operations
            if len(raw.encode("utf-8")) > MAX_FRAME_BYTES:
                await socket.send_json({"type": "error", "message": "Event frame exceeds 64 KiB."})
                await socket.close(code=1009)
                return
            message = None
            try:
                with operations.span("JSON decode /ws", "inspector"):
                    message = json.loads(raw)
                if not isinstance(message, dict):
                    raise ValueError("Expected a message object.")
                request_id = message.get("request_id")
                if request_id is not None and not isinstance(request_id, str):
                    raise ValueError("request_id must be a string.")
                command = None
                queued = None
                match message.get("type"):
                    case "event":
                        before = len(lab.handoffs)
                        with operations.span("TranscriptLab.process"):
                            command = lab.process(message.get("event"))
                        if len(lab.handoffs) > before and lab.handoffs[-1]["status"] == "queued":
                            queued = lab.handoffs[-1]
                        if message["event"]["type"] == "session.input_transcript.delta":
                            executor.transcript_changed.set()
                        await responses_executor.observe(message["event"])
                        if lab.closed:
                            await executor.cancel()
                            await responses_executor.cancel()
                    case "reset":
                        playground = validate_playground_config(message.get("playground"))
                        replacement = TranscriptLab(message.get("delegation_mode", "client"))
                        replacement.configure_playground(playground)
                        await executor.cancel()
                        await responses_executor.cancel()
                        with operations.span("TranscriptLab.reset"):
                            lab = replacement
                            lab.operations = operations
                            executor = DelegationExecutor(lab, socket.send_json)
                            responses_executor = ResponsesExecutor(lab, socket.send_json)
                    case "consume":
                        with operations.span("TranscriptLab.consume", "delegation"):
                            lab.consume()
                    case "configure_playground":
                        with operations.span("TranscriptLab.configure_playground", "delegation"):
                            lab.configure_playground(message.get("playground"))
                        if message.get("playground") is None:
                            await executor.cancel()
                    case "cancel_execution":
                        await executor.cancel()
                        await responses_executor.cancel()
                    case "sent" | "send_failed" | "not_sent":
                        with operations.span("command_status", "command"):
                            lab.command_status(
                                message.get("event_id"),
                                message["type"],
                                str(message.get("detail", "")),
                            )
                            responses_executor.confirm(message.get("event_id"), message["type"])
                    case _:
                        raise ValueError("Unknown lab message type.")
            except ValueError as error:
                reply = {"type": "error", "message": str(error), "timing": operations.snapshot()}
                if isinstance(message, dict) and isinstance(message.get("request_id"), str):
                    reply["request_id"] = message["request_id"]
                await socket.send_json(reply)
                continue
            with operations.span("snapshot / non-consuming SRT preview"):
                snapshot = lab.snapshot()
            await socket.send_json({
                **snapshot, "request_id": request_id, "timing": operations.snapshot(),
            })
            if command is not None:
                await socket.send_json({"type": "command", "event": command, "request_id": request_id})
            if queued is not None:
                executor.submit(queued, request_id)
    except WebSocketDisconnect:
        logger.info("Transcript inspector disconnected; in-memory session discarded.")
    finally:
        await executor.cancel()
        await responses_executor.cancel()


if __name__ == "__main__":
    import argparse

    import uvicorn

    parser = argparse.ArgumentParser(description="Run the local GPT-Live Transcript Lab.")
    parser.add_argument("--port", type=int, default=8765)
    args = parser.parse_args()
    if not 1 <= args.port <= 65_535:
        parser.error("--port must be between 1 and 65535")
    uvicorn.run(app, host="127.0.0.1", port=args.port, ws_max_size=MAX_FRAME_BYTES)

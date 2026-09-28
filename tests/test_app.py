from __future__ import annotations

import os
import unittest
from unittest.mock import AsyncMock, patch

import httpx
from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

from app import app
from tests.test_lab import delegation, delta

ORIGIN = "http://localhost:8765"
HEADERS = {"origin": ORIGIN}
WS_URL = "ws://localhost:8765/ws"


class AppTests(unittest.TestCase):
    def setUp(self) -> None:
        self.environment = patch.dict(os.environ, {"LIVE_PROVIDER": "openai"})
        self.environment.start()
        self.addCleanup(self.environment.stop)
        self.client = TestClient(app, base_url=ORIGIN)

    def tearDown(self) -> None:
        self.client.close()

    def test_health_and_configuration_do_not_leak_key(self) -> None:
        with patch.dict(os.environ, {"OPENAI_API_KEY": "secret-test-key"}):
            response = self.client.get("/api/config")
        self.assertEqual(response.status_code, 200)
        self.assertTrue(response.json()["api_key_configured"])
        self.assertNotIn("secret-test-key", response.text)
        self.assertEqual(self.client.get("/api/health").json(), {"status": "ok"})

    def test_jev_configuration_is_independent_of_azure_and_keeps_key_private(self) -> None:
        with patch.dict(os.environ, {
            "LIVE_PROVIDER": "openai", "OPENAI_API_KEY": "",
            "TYPESAFE_API_KEY": "test-jev-private-key", "TYPESAFE_MODEL": "jev-latest",
            "JEV_CONFIDENCE_THRESHOLD": "0.8",
        }, clear=True):
            response = self.client.get("/api/config")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["playground_protocol"], 5)
        self.assertFalse(response.json()["backends"]["azure"]["available"])
        self.assertEqual(response.json()["backends"]["jev"],
                         {"model": "jev-latest", "available": True, "threshold": 0.8})
        self.assertNotIn("test-jev-private-key", response.text)

    def test_unconfigured_jev_is_reported_without_breaking_azure(self) -> None:
        with patch.dict(os.environ, {
            "LIVE_PROVIDER": "azure", "AZURE_OPENAI_ENDPOINT": "https://unit.openai.azure.com",
            "AZURE_OPENAI_API_KEY": "unit-azure-key", "TYPESAFE_API_KEY": "",
        }, clear=True):
            response = self.client.get("/api/config")
        self.assertTrue(response.json()["backends"]["azure"]["available"])
        self.assertFalse(response.json()["backends"]["jev"]["available"])
        self.assertIn("TYPESAFE_API_KEY", response.json()["backends"]["jev"]["error"])
        self.assertNotIn("unit-azure-key", response.text)

    def test_origin_host_body_and_missing_key_checks(self) -> None:
        self.assertEqual(self.client.post("/api/session", json={"sdp": "offer"}).status_code, 403)
        self.assertEqual(
            self.client.get("/api/config", headers={"host": "evil.example"}).status_code, 400
        )
        for invalid_offer in (
            {"sdp": " \r\n\t"},
            {"sdp": "offer", "instructions": " \r\n\t"},
            {"sdp": "offer", "instructions": "x" * 4001},
            {"sdp": "x" * 60_001},
        ):
            with self.subTest(offer=invalid_offer):
                self.assertEqual(
                    self.client.post("/api/session", json=invalid_offer, headers=HEADERS).status_code, 422
                )
        self.assertEqual(
            self.client.post("/api/session", content=b"x" * 65_537, headers=HEADERS).status_code,
            413,
        )
        with patch.dict(os.environ, {"OPENAI_API_KEY": ""}):
            response = self.client.post("/api/session", json={"sdp": "offer"}, headers=HEADERS)
        self.assertEqual(response.status_code, 503)

    def test_session_uses_current_protocol_and_client_delegation(self) -> None:
        upstream = httpx.Response(
            201,
            json={
                "session": {"id": "live_test", "private": "must-not-return"},
                "transport": {"type": "webrtc", "sdp": "answer"},
            },
        )
        with patch.dict(os.environ, {"OPENAI_API_KEY": "test-key"}), patch(
            "app.httpx.AsyncClient.post", new_callable=AsyncMock, return_value=upstream
        ) as post:
            response = self.client.post("/api/session", json={"sdp": "offer"}, headers=HEADERS)
        self.assertEqual(response.status_code, 201)
        self.assertEqual(response.json()["transport"]["sdp"], "answer")
        self.assertEqual(response.json()["session"], {"id": "live_test"})
        self.assertEqual(post.call_count, 1)
        self.assertEqual(post.call_args.args[0], "https://api.openai.com/v1/live/sessions")
        payload = post.call_args.kwargs["json"]
        self.assertEqual(payload["session"]["delegation"], {"type": "client"})
        self.assertEqual(payload["session"]["model"], "gpt-live-1")
        self.assertEqual(payload["transport"], {"type": "webrtc", "sdp": "offer"})
        self.assertNotIn("audio", payload["session"])

    def test_responses_session_registers_function_and_selected_model(self) -> None:
        upstream = httpx.Response(201, json={
            "session": {"id": "live_responses"}, "transport": {"type": "webrtc", "sdp": "answer"},
        })
        with patch.dict(os.environ, {"OPENAI_API_KEY": "test-key", "LIVE_RESPONSES_MODEL": "gpt-5.5"}), patch(
            "app.httpx.AsyncClient.post", new_callable=AsyncMock, return_value=upstream
        ) as post:
            response = self.client.post("/api/session", headers=HEADERS, json={
                "sdp": "offer", "delegation_mode": "responses",
            })
        self.assertEqual(response.status_code, 201)
        config = post.call_args.kwargs["json"]["session"]["delegation"]
        self.assertEqual(config["type"], "responses")
        self.assertEqual(config["responses"]["model"], "gpt-5.5")
        self.assertEqual(config["responses"]["tools"][0]["name"], "search_weather")
        self.assertFalse(config["responses"]["parallel_tool_calls"])

    def test_sdp_is_forwarded_verbatim_including_terminal_crlf(self) -> None:
        sdp = "v=0\r\no=- 1234 2 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\na=sendrecv\r\n"
        upstream = httpx.Response(
            201,
            json={"session": {"id": "live_test"}, "transport": {"type": "webrtc", "sdp": "answer\r\n"}},
        )
        with patch.dict(os.environ, {"OPENAI_API_KEY": "test-key"}), patch(
            "app.httpx.AsyncClient.post", new_callable=AsyncMock, return_value=upstream
        ) as post:
            response = self.client.post(
                "/api/session", json={"sdp": sdp, "instructions": "  Be concise. \n"}, headers=HEADERS
            )
        self.assertEqual(response.status_code, 201)
        self.assertEqual(post.call_args.kwargs["json"]["transport"]["sdp"], sdp)
        self.assertEqual(post.call_args.kwargs["json"]["session"]["instructions"], "Be concise.")
        self.assertEqual(response.json()["transport"]["sdp"], "answer\r\n")

    def test_api_failures_surface_without_retry_or_unstructured_body(self) -> None:
        for upstream, expected in [
            (httpx.Response(429, json={"error": {"message": "Rate limit exceeded"}}), 429),
            (httpx.Response(503, text="private upstream response"), 502),
            (httpx.Response(201, text="not json"), 502),
            (httpx.Response(201, json={"session": {}}), 502),
        ]:
            with self.subTest(status=upstream.status_code), patch.dict(
                os.environ, {"OPENAI_API_KEY": "test-key"}
            ), patch("app.httpx.AsyncClient.post", new_callable=AsyncMock, return_value=upstream) as post:
                response = self.client.post("/api/session", json={"sdp": "offer"}, headers=HEADERS)
                self.assertEqual(response.status_code, expected)
                self.assertNotIn("private upstream response", response.text)
                self.assertEqual(post.call_count, 1)
        with patch.dict(os.environ, {"OPENAI_API_KEY": "test-key"}), patch(
            "app.httpx.AsyncClient.post", new_callable=AsyncMock, side_effect=httpx.ConnectError("offline")
        ):
            response = self.client.post("/api/session", json={"sdp": "offer"}, headers=HEADERS)
        self.assertEqual(response.status_code, 502)

    def test_session_error_exposes_details_but_not_credentials_or_input(self) -> None:
        upstream = httpx.Response(
            400,
            json={"error": {"code": "invalid_request_error", "param": "transport.sdp",
                            "message": "Invalid SDP: private-offer, private-instructions, test-key, private-pwd, private-ufrag"}},
            headers={"apim-request-id": "request-test"},
        )
        with patch.dict(os.environ, {"OPENAI_API_KEY": "test-key"}), patch(
            "app.httpx.AsyncClient.post", new_callable=AsyncMock, return_value=upstream
        ) as post:
            response = self.client.post(
                "/api/session",
                json={
                    "sdp": "private-offer\r\na=ice-pwd:private-pwd\r\na=ice-ufrag:private-ufrag\r\n",
                    "instructions": "private-instructions",
                },
                headers=HEADERS,
            )
        self.assertEqual(response.status_code, 400)
        for text in ("invalid_request_error", "transport.sdp", "Invalid SDP", "request-test"):
            self.assertIn(text, response.json()["detail"])
        for text in ("test-key", "private-offer", "private-instructions", "private-pwd", "private-ufrag"):
            self.assertNotIn(text, response.text)
        self.assertEqual(post.call_count, 1)
    def test_websocket_replay_delegation_ack_reset_and_isolation(self) -> None:
        with self.client.websocket_connect(WS_URL, headers=HEADERS) as ws:
            self.assertEqual(ws.receive_json()["ledger"], [])
            ws.send_json({"type": "event", "event": delta("Tokyo")})
            self.assertEqual(ws.receive_json()["ledger"][0]["text"], "Tokyo")
            ws.send_json({"type": "event", "event": delegation()})
            self.assertEqual(ws.receive_json()["handoffs"][0]["status"], "prepared")
            command = ws.receive_json()
            self.assertEqual(command["type"], "command")
            ws.send_json({"type": "sent", "event_id": command["event"]["event_id"]})
            self.assertEqual(ws.receive_json()["handoffs"][0]["status"], "sent")
            ws.send_json({"type": "event", "event": delta(", Osaka", 100, 200, "t2")})
            snapshot = ws.receive_json()
            self.assertIn("Osaka", snapshot["pending_srt"])
            self.assertNotIn("Osaka", snapshot["handoffs"][0]["srt"])
            with self.client.websocket_connect(WS_URL, headers=HEADERS) as second:
                self.assertEqual(second.receive_json()["ledger"], [])
            ws.send_json({"type": "consume"})
            self.assertEqual(ws.receive_json()["pending_srt"], "")
            ws.send_json({"type": "reset"})
            self.assertEqual(ws.receive_json()["event_count"], 0)

    def test_websocket_rejects_origin_and_recovers_from_invalid_frames(self) -> None:
        with self.assertRaises(WebSocketDisconnect):
            with self.client.websocket_connect(WS_URL, headers={"origin": "http://evil.example"}):
                pass
        with self.client.websocket_connect(WS_URL, headers=HEADERS) as ws:
            ws.receive_json()
            for invalid in ["not json", "[]", '{"type":"unknown"}']:
                ws.send_text(invalid)
                self.assertEqual(ws.receive_json()["type"], "error")
            ws.send_json({"type": "event", "event": delta("valid")})
            self.assertEqual(ws.receive_json()["ledger"][0]["text"], "valid")
            ws.send_text("x" * 65_537)
            self.assertEqual(ws.receive_json()["type"], "error")
            with self.assertRaises(WebSocketDisconnect):
                ws.receive_json()

    def test_websocket_request_ids_correlate_state_commands_and_errors(self) -> None:
        with self.client.websocket_connect(WS_URL, headers=HEADERS) as ws:
            ws.receive_json()
            ws.send_json({"type": "event", "event": delegation(), "request_id": "run1:request1"})
            self.assertEqual(ws.receive_json()["request_id"], "run1:request1")
            self.assertEqual(ws.receive_json()["request_id"], "run1:request1")
            ws.send_json({"type": "event", "event": {}, "request_id": "run1:request2"})
            self.assertEqual(ws.receive_json()["request_id"], "run1:request2")
            ws.send_text("broken-json")
            self.assertNotIn("request_id", ws.receive_json())

    def test_request_timings_cover_ledger_consume_snapshot_errors_and_reset(self) -> None:
        with self.client.websocket_connect(WS_URL, headers=HEADERS) as ws:
            ws.receive_json()
            ws.send_json({"type": "event", "event": delta("context"), "request_id": "timing1"})
            result = ws.receive_json()
            spans = result["timing"]["spans"]
            self.assertIn("TranscriptLedger.record_event", [s["label"] for s in spans])
            self.assertIn("snapshot / non-consuming SRT preview", [s["label"] for s in spans])
            self.assertEqual(result["ledger"][0]["delivered_characters"], 0)
            for span in spans:
                self.assertLessEqual(0, span["start_ms"])
                self.assertLessEqual(span["start_ms"], span["end_ms"])
                self.assertLessEqual(span["end_ms"], result["timing"]["elapsed_ms"])
            ws.send_json({"type": "event", "event": delegation(), "request_id": "timing2"})
            result = ws.receive_json()
            labels = [s["label"] for s in result["timing"]["spans"]]
            self.assertIn("TranscriptLedger.consume_srt", labels)
            self.assertIn("fixed stub / prepare command", labels)
            self.assertNotIn("TranscriptLedger.record_event", labels)
            self.assertEqual(ws.receive_json()["request_id"], "timing2")
            ws.send_json({"type": "event", "event": {}, "request_id": "bad"})
            result = ws.receive_json()
            self.assertEqual(result["type"], "error")
            self.assertTrue(any(s["status"] == "error" for s in result["timing"]["spans"]))
            ws.send_json({"type": "reset"})
            result = ws.receive_json()
            self.assertEqual(result["ledger"], [])
            self.assertNotIn("context", str(result["timing"]))

    def test_http_timings_include_failed_upstream_without_sensitive_values(self) -> None:
        upstream = httpx.Response(400, json={"error": {"message": "invalid offer"}})
        with patch.dict(os.environ, {"OPENAI_API_KEY": "timing-secret"}), patch(
            "app.httpx.AsyncClient.post", new_callable=AsyncMock, return_value=upstream
        ):
            response = self.client.post(
                "/api/session", json={"sdp": "private-sdp"}, headers=HEADERS,
            )
        self.assertEqual(response.status_code, 400)
        timings = response.headers["Server-Timing"]
        self.assertIn("authentication;dur=", timings)
        self.assertIn("upstream_session;dur=", timings)
        self.assertIn("total;dur=", timings)
        self.assertRegex(timings, r'upstream_session;dur=[\d.]+;desc="[\d.]+:error"')
        self.assertNotIn("timing-secret", timings)
        self.assertNotIn("private-sdp", timings)

    def test_ui_assets_are_not_cached_across_diagnostic_updates(self) -> None:
        for path in ("/", "/static/app.js", "/static/trace-view.js", "/static/styles.css"):
            response = self.client.get(path)
            self.assertEqual(response.status_code, 200)
            self.assertEqual(response.headers["Cache-Control"], "no-store")


if __name__ == "__main__":
    unittest.main()

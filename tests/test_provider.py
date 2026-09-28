from __future__ import annotations

import os
import unittest
from unittest.mock import AsyncMock, patch

import httpx
from azure.core.credentials import AccessToken
from azure.core.exceptions import ClientAuthenticationError
from fastapi.testclient import TestClient

from app import app
from lab.provider import LiveSettings

AZURE_ENV = {
    "AZURE_OPENAI_ENDPOINT": "https://example.openai.azure.com/",
    "AZURE_OPENAI_DEPLOYMENT": "my-live-deployment",
}


class ProviderTests(unittest.IsolatedAsyncioTestCase):
    async def test_azure_configuration_and_entra(self) -> None:
        with patch.dict(os.environ, AZURE_ENV, clear=True):
            settings = LiveSettings.from_env()
        self.assertEqual(settings.provider, "azure")
        self.assertEqual(settings.auth_mode, "entra")
        self.assertEqual(settings.model, "my-live-deployment")
        self.assertEqual(settings.url, "https://example.openai.azure.com/openai/v1/live/sessions")
        self.assertTrue(settings.live_available)
        with patch(
            "lab.provider.AzureCliCredential.get_token",
            new_callable=AsyncMock,
            return_value=AccessToken("fake-token", 9_999_999_999),
        ) as get_token:
            self.assertEqual(await settings.headers(), {"Authorization": "Bearer fake-token"})
        get_token.assert_awaited_once_with("https://cognitiveservices.azure.com/.default")

    async def test_uppercase_azure_configuration_and_api_key(self) -> None:
        with patch.dict(
            os.environ,
            {
                "AZURE_OPENAI_ENDPOINT": "https://example.openai.azure.com/openai/v1/",
                "AZURE_OPENAI_DEPLOYMENT": "deployed-live",
                "AZURE_OPENAI_API_KEY": "secret-key",
            },
            clear=True,
        ):
            settings = LiveSettings.from_env()
        self.assertEqual(await settings.headers(), {"api-key": "secret-key"})
        self.assertNotIn("secret-key", repr(settings))
        self.assertEqual(settings.auth_mode, "api_key")

    async def test_explicit_openai_does_not_use_azure_credentials(self) -> None:
        with patch.dict(
            os.environ,
            {**AZURE_ENV, "LIVE_PROVIDER": "openai", "OPENAI_API_KEY": "openai-key"},
            clear=True,
        ):
            settings = LiveSettings.from_env()
        self.assertEqual(settings.provider, "openai")
        self.assertEqual(await settings.headers(), {"Authorization": "Bearer openai-key"})
        self.assertEqual(settings.url, "https://api.openai.com/v1/live/sessions")

    async def test_legacy_variable_names_are_not_used(self) -> None:
        legacy = {
            "endpoint": AZURE_ENV["AZURE_OPENAI_ENDPOINT"],
            "deployment_id": AZURE_ENV["AZURE_OPENAI_DEPLOYMENT"],
        }
        with patch.dict(os.environ, legacy, clear=True):
            settings = LiveSettings.from_env()
        self.assertEqual(settings.provider, "openai")
        self.assertFalse(settings.live_available)
        for missing in AZURE_ENV:
            for value in (None, "", "   "):
                environment = {**legacy, **AZURE_ENV, "LIVE_PROVIDER": "azure"}
                if value is None:
                    del environment[missing]
                else:
                    environment[missing] = value
                with self.subTest(missing=missing, value=value), patch.dict(
                    os.environ, environment, clear=True
                ), self.assertRaisesRegex(ValueError, missing):
                    LiveSettings.from_env()

    async def test_invalid_or_missing_configuration(self) -> None:
        for endpoint in [
            "http://example.openai.azure.com",
            "https://example.openai.azure.com.attacker.example",
            "https://user:secret@example.openai.azure.com",
            "https://example.openai.azure.com?api-key=secret",
            "https://example.openai.azure.com/unexpected",
        ]:
            with self.subTest(endpoint=endpoint), patch.dict(
                os.environ, {**AZURE_ENV, "AZURE_OPENAI_ENDPOINT": endpoint}, clear=True
            ), self.assertRaises(ValueError):
                LiveSettings.from_env()
        with patch.dict(os.environ, {"LIVE_PROVIDER": "openai"}, clear=True):
            settings = LiveSettings.from_env()
        self.assertFalse(settings.live_available)
        with self.assertRaises(ValueError):
            await settings.headers()
        with patch.dict(os.environ, {"LIVE_PROVIDER": "unsupported"}, clear=True), self.assertRaises(ValueError):
            LiveSettings.from_env()
        with patch.dict(
            os.environ, {"AZURE_OPENAI_ENDPOINT": AZURE_ENV["AZURE_OPENAI_ENDPOINT"]}, clear=True
        ), self.assertRaises(ValueError):
            LiveSettings.from_env()


class AzureAppTests(unittest.TestCase):
    def test_azure_http_request_and_public_configuration(self) -> None:
        upstream = httpx.Response(
            201,
            json={"session": {"id": "live_azure"}, "transport": {"type": "webrtc", "sdp": "answer"}},
        )
        with patch.dict(
            os.environ, {**AZURE_ENV, "AZURE_OPENAI_API_KEY": "azure-secret"}, clear=True
        ), TestClient(app, base_url="http://localhost:8765") as client, patch(
            "app.httpx.AsyncClient.post", new_callable=AsyncMock, return_value=upstream
        ) as post:
            config = client.get("/api/config")
            self.assertEqual(config.json()["provider"], "azure")
            self.assertEqual(config.json()["auth_mode"], "api_key")
            self.assertTrue(config.json()["live_available"])
            self.assertNotIn("azure-secret", config.text)
            response = client.post(
                "/api/session", json={"sdp": "offer"}, headers={"origin": "http://localhost:8765"}
            )
        self.assertEqual(response.status_code, 201)
        self.assertEqual(post.call_args.args[0], "https://example.openai.azure.com/openai/v1/live/sessions")
        self.assertEqual(post.call_args.kwargs["headers"], {"api-key": "azure-secret"})
        self.assertEqual(post.call_args.kwargs["json"]["session"]["model"], "my-live-deployment")

    def test_entra_failure_is_visible_without_token_details(self) -> None:
        with patch.dict(os.environ, AZURE_ENV, clear=True), TestClient(
            app, base_url="http://localhost:8765"
        ) as client, patch(
            "lab.provider.AzureCliCredential.get_token",
            new_callable=AsyncMock,
            side_effect=ClientAuthenticationError("sensitive error detail"),
        ):
            self.assertTrue(client.get("/api/config").json()["live_available"])
            response = client.post(
                "/api/session", json={"sdp": "offer"}, headers={"origin": "http://localhost:8765"}
            )
        self.assertEqual(response.status_code, 503)
        self.assertIn("Azure CLI", response.json()["detail"])
        self.assertNotIn("sensitive error detail", response.text)

    def test_bad_configuration_still_allows_replay(self) -> None:
        with patch.dict(os.environ, {"LIVE_PROVIDER": "bad"}, clear=True), TestClient(
            app, base_url="http://localhost:8765"
        ) as client:
            config = client.get("/api/config")
            self.assertEqual(config.status_code, 200)
            self.assertFalse(config.json()["live_available"])
            self.assertIn("config_error", config.json())
            with client.websocket_connect(
                "ws://localhost:8765/ws", headers={"origin": "http://localhost:8765"}
            ) as ws:
                self.assertEqual(ws.receive_json()["ledger"], [])


if __name__ == "__main__":
    unittest.main()

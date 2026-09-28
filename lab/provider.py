"""Server-only configuration for OpenAI or an existing Azure deployment."""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from urllib.parse import urlsplit

from azure.identity.aio import AzureCliCredential


def azure_origin() -> str:
    parsed = urlsplit(os.getenv("AZURE_OPENAI_ENDPOINT", "").strip())
    hostname = parsed.hostname or ""
    if (
        parsed.scheme != "https"
        or not hostname.endswith(
            (".openai.azure.com", ".cognitiveservices.azure.com", ".services.ai.azure.com")
        )
        or parsed.netloc != hostname
        or parsed.path.rstrip("/") not in {"", "/openai/v1"}
        or parsed.query
        or parsed.fragment
    ):
        raise ValueError("Set AZURE_OPENAI_ENDPOINT to a valid HTTPS resource URL (without query or credentials).")
    return f"https://{hostname}/openai/v1"


@dataclass(frozen=True)
class LiveSettings:
    provider: str
    url: str
    model: str
    api_key: str = field(repr=False)
    auth_mode: str

    @classmethod
    def from_env(cls) -> LiveSettings:
        endpoint = os.getenv("AZURE_OPENAI_ENDPOINT", "").strip()
        provider = os.getenv("LIVE_PROVIDER", "azure" if endpoint else "openai").strip().lower()
        if provider == "openai":
            return cls(
                provider,
                "https://api.openai.com/v1/live/sessions",
                "gpt-live-1",
                os.getenv("OPENAI_API_KEY", "").strip(),
                "api_key",
            )
        if provider != "azure":
            raise ValueError("LIVE_PROVIDER must be azure or openai.")
        origin = azure_origin()
        deployment = os.getenv("AZURE_OPENAI_DEPLOYMENT", "").strip()
        if not deployment:
            raise ValueError("Set AZURE_OPENAI_DEPLOYMENT to the GPT-Live deployment name.")
        key = os.getenv("AZURE_OPENAI_API_KEY", "").strip()
        return cls(
            provider,
            f"{origin}/live/sessions",
            deployment,
            key,
            "api_key" if key else "entra",
        )

    @property
    def live_available(self) -> bool:
        return bool(self.api_key) or self.auth_mode == "entra"

    @property
    def responses_model(self) -> str:
        default = os.getenv("AZURE_OPENAI_BACKEND_DEPLOYMENT", "gpt-6-luna") if self.provider == "azure" else "gpt-5.5"
        model = os.getenv("LIVE_RESPONSES_MODEL", default).strip()
        if not model:
            raise ValueError("LIVE_RESPONSES_MODEL must name a Responses deployment or model.")
        return model

    async def headers(self) -> dict[str, str]:
        if self.api_key:
            if self.provider == "azure":
                return {"api-key": self.api_key}
            return {"Authorization": f"Bearer {self.api_key}"}
        if self.auth_mode != "entra":
            raise ValueError("Set OPENAI_API_KEY in the server .env, then restart.")
        # This local-only app deliberately uses the CLI identity, not a fallback chain.
        async with AzureCliCredential(process_timeout=10) as credential:
            token = await credential.get_token("https://cognitiveservices.azure.com/.default")
        return {"Authorization": f"Bearer {token.token}"}


@dataclass(frozen=True)
class BackendSettings(LiveSettings):
    @classmethod
    def from_env(cls) -> BackendSettings:
        origin = azure_origin()
        deployment = os.getenv("AZURE_OPENAI_BACKEND_DEPLOYMENT", "gpt-6-luna").strip()
        if not deployment:
            raise ValueError("AZURE_OPENAI_BACKEND_DEPLOYMENT must name the gpt-6-luna deployment.")
        key = os.getenv("AZURE_OPENAI_API_KEY", "").strip()
        return cls("azure", f"{origin}/responses", deployment, key, "api_key" if key else "entra")

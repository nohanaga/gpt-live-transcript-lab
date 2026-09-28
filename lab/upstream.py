"""Bounded, credential-safe diagnostics for session creation failures."""

from __future__ import annotations

import re
from collections.abc import Iterable

import httpx


def session_error_detail(
    response: httpx.Response, provider: str, *, sensitive_values: Iterable[str] = ()
) -> str:
    redactions = sorted({value for value in sensitive_values if value}, key=len, reverse=True)

    def sanitized(value: object) -> str:
        if not isinstance(value, str):
            return ""
        for secret in redactions:
            value = value.replace(secret, "[redacted]")
        value = re.sub(r"(?i)\bBearer\s+\S+", "Bearer [redacted]", value)
        return " ".join(value.split())[:1500]

    try:
        body = response.json()
    except ValueError:
        body = None
    error = body.get("error") if isinstance(body, dict) else None
    parts = [f"{provider} returned HTTP {response.status_code}."]
    if isinstance(error, dict):
        for field in ("code", "type", "param", "message"):
            text = sanitized(error.get(field))
            if text:
                parts.append(f"{field}: {text}")
    if len(parts) == 1:
        parts.append("The service did not provide a structured error description.")
    request_id = next(
        (
            response.headers[name]
            for name in ("apim-request-id", "x-request-id", "x-ms-request-id")
            if response.headers.get(name)
        ),
        "",
    )
    if request_id:
        parts.append(f"request_id: {sanitized(request_id)}")
    parts.append("No automatic retry was attempted.")
    return "\n".join(parts)

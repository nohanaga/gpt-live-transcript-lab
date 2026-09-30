"""Language selection shared by the server modules.

The app supports Japanese (the default) and English. The language of the current
request, WebSocket session, or background task is kept in a ContextVar so that
deeply nested helpers (weather parsing, backend prompts, error messages) can pick
the right text without threading a parameter through every call. asyncio tasks
copy the context when they are created, so tasks spawned inside `use_language()`
keep that language.
"""

from __future__ import annotations

from collections.abc import Iterator
from contextlib import contextmanager
from contextvars import ContextVar
from typing import Literal

Language = Literal["ja", "en"]
LANGUAGES: tuple[Language, ...] = ("ja", "en")
DEFAULT_LANGUAGE: Language = "ja"

_current: ContextVar[Language] = ContextVar("transcript_lab_language", default=DEFAULT_LANGUAGE)


def normalize_language(value: object) -> Language:
    """Return a supported language code, falling back to the default for anything else."""
    return value if value in LANGUAGES else DEFAULT_LANGUAGE  # type: ignore[return-value]


def current_language() -> Language:
    return _current.get()


def set_language(language: object) -> Language:
    """Set the language for the rest of the current context (e.g. one WebSocket handler)."""
    resolved = normalize_language(language)
    _current.set(resolved)
    return resolved


@contextmanager
def use_language(language: object) -> Iterator[Language]:
    token = _current.set(normalize_language(language))
    try:
        yield _current.get()
    finally:
        _current.reset(token)


def text(ja: str, en: str) -> str:
    """Pick the Japanese or English variant for the current language."""
    return en if _current.get() == "en" else ja

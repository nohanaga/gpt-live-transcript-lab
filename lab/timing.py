"""Request-local timings; never collect credentials, SDP, or audio."""

from contextlib import contextmanager
from time import perf_counter
from typing import Generator, NotRequired, TypedDict


class OperationSpan(TypedDict):
    label: str
    lane: str
    start_ms: float
    end_ms: float
    status: str
    detail: NotRequired[str]


class OperationTrace:
    def __init__(self) -> None:
        self.origin = perf_counter()
        self.spans: list[OperationSpan] = []

    def now(self) -> float:
        return (perf_counter() - self.origin) * 1000

    @contextmanager
    def span(self, name: str, lane: str = "ledger") -> Generator[OperationSpan, None, None]:
        start = self.now()
        item: OperationSpan = {
            "label": name, "lane": lane, "start_ms": start, "end_ms": start, "status": "running",
        }
        self.spans.append(item)
        try:
            yield item
            if item["status"] == "running":
                item["status"] = "ok"
        finally:
            if item["status"] == "running":
                item["status"] = "error"
            item["end_ms"] = self.now()

    def mark(self, name: str, detail: str) -> None:
        now = self.now()
        self.spans.append({
            "label": name, "lane": "ledger", "start_ms": now, "end_ms": now,
            "status": "ok", "detail": detail,
        })

    def snapshot(self) -> dict[str, object]:
        return {"elapsed_ms": self.now(), "spans": self.spans.copy()}

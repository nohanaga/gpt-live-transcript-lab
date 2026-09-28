from __future__ import annotations

import unittest

from lab.state import MAX_EVENTS, TranscriptLab
from vendor.openai_cookbook.memory import TranscriptLedger


def delta(
    text: str,
    start: int = 0,
    end: int = 100,
    event_id: str = "t1",
    speaker: str = "input",
) -> dict[str, object]:
    return {
        "type": f"session.{speaker}_transcript.delta",
        "event_id": event_id,
        "delta": text,
        "start_ms": start,
        "end_ms": end,
    }


def delegation(identifier: str = "d1", offset: int = 0) -> dict[str, object]:
    return {
        "type": "session.delegation.created",
        "event_id": f"event_{identifier}",
        "offset_ms": offset,
        "delegation": {"id": identifier, "type": "delegation", "target": "client"},
    }


class LedgerTests(unittest.TestCase):
    def test_merges_same_speaker_at_500ms_boundary_but_not_501(self) -> None:
        lab = TranscriptLab()
        lab.process(delta("Hello"))
        lab.process(delta(" there", 600, 700, "t2"))
        lab.process(delta("New", 1201, 1300, "t3"))
        self.assertEqual([x["text"] for x in lab.snapshot()["ledger"]], ["Hello there", "New"])

    def test_preserves_whitespace_repetitions_and_overlapping_speakers(self) -> None:
        lab = TranscriptLab()
        lab.process(delta("I "))
        lab.process(delta("mhm", 50, 150, "a1", "output"))
        lab.process(delta("I agree", 100, 200, "t2"))
        self.assertEqual([x["text"] for x in lab.snapshot()["ledger"]], ["I I agree", "mhm"])

    def test_preview_does_not_consume(self) -> None:
        lab = TranscriptLab()
        lab.process(delta("test"))
        first = lab.snapshot()
        self.assertEqual(first["pending_srt"], lab.snapshot()["pending_srt"])
        self.assertEqual(first["ledger"][0]["delivered_characters"], 0)

    def test_handoff_consumes_all_pending_not_offset_cutoff(self) -> None:
        lab = TranscriptLab()
        lab.process(delta("Tokyo", 1000, 1200))
        lab.process(delta("Checking", 1100, 1300, "a1", "output"))
        command = lab.process(delegation(offset=5))
        assert command is not None
        self.assertEqual(command["delegation_id"], "d1")
        snapshot = lab.snapshot()
        self.assertIn("Tokyo", snapshot["handoffs"][0]["srt"])
        self.assertIn("Checking", snapshot["handoffs"][0]["srt"])
        self.assertEqual(snapshot["pending_srt"], "")
        self.assertEqual(snapshot["ledger"][0]["delivered_characters"], 5)
        self.assertIn("no lookup, decision, or external action", command["content"])

    def test_late_correction_is_only_in_next_handoff(self) -> None:
        lab = TranscriptLab()
        lab.process(delta("Tokyo"))
        lab.process(delegation())
        first = lab.snapshot()["handoffs"][0]["srt"]
        lab.process(delta(", no, Osaka", 150, 300, "t2"))
        lab.process(delegation("d2", 200))
        snapshot = lab.snapshot()
        self.assertEqual(snapshot["handoffs"][0]["srt"], first)
        self.assertIn("Osaka", snapshot["handoffs"][1]["srt"])
        self.assertNotIn("Tokyo", snapshot["handoffs"][1]["srt"])
        self.assertEqual(snapshot["pending_srt"], "")

    def test_duplicate_event_and_delegation_are_idempotent(self) -> None:
        lab = TranscriptLab()
        lab.process(delta("once"))
        lab.process(delta("once"))
        lab.process(delegation())
        self.assertIsNone(lab.process(delegation()))
        repeat = delegation()
        repeat["event_id"] = "different_event_same_delegation"
        self.assertIsNone(lab.process(repeat))
        self.assertEqual(len(lab.handoffs), 1)
        self.assertEqual(lab.snapshot()["ledger"][0]["text"], "once")

    def test_empty_delegation_and_manual_consume(self) -> None:
        lab = TranscriptLab()
        self.assertIsNotNone(lab.process(delegation()))
        self.assertEqual(lab.handoffs[0]["srt"], "")
        lab.process(delta("manual"))
        lab.consume()
        self.assertIsNone(lab.handoffs[1]["command"])
        self.assertIn("manual", lab.handoffs[1]["srt"])

    def test_ack_and_failure_keep_payload_available(self) -> None:
        lab = TranscriptLab()
        command = lab.process(delegation())
        assert command is not None
        lab.command_status(command["event_id"], "send_failed", "channel closed")
        self.assertEqual(lab.handoffs[0]["status"], "send_failed")
        lab.process(
            {"type": "session.commentary.appended", "client_event_id": command["event_id"]}
        )
        lab.command_status(command["event_id"], "sent")
        self.assertEqual(lab.handoffs[0]["status"], "acknowledged")

    def test_close_reset_isolation_and_limits(self) -> None:
        first, second = TranscriptLab(), TranscriptLab()
        first.process(delta("private"))
        self.assertEqual(second.snapshot()["ledger"], [])
        first.process({"type": "session.closed"})
        with self.assertRaises(ValueError):
            first.process(delta("after close", event_id="late"))
        second.event_count = MAX_EVENTS
        with self.assertRaises(ValueError):
            second.process(delta("over limit"))

    def test_azure_ack_and_nested_error_correlation(self) -> None:
        lab = TranscriptLab()
        command = lab.process(delegation())
        assert command is not None
        lab.command_status(command["event_id"], "sent")
        lab.process({"type": "session.commentary.appended"})
        self.assertEqual(lab.handoffs[0]["status"], "sent")
        self.assertEqual(lab.trace[-1]["action"], "uncorrelated_ack")
        lab.process({"type": "session.commentary.appended", "delegation_id": "d1"})
        self.assertEqual(lab.handoffs[0]["status"], "acknowledged")
        lab.process({"type": "error", "error": {"client_event_id": command["event_id"]}})
        self.assertEqual(lab.handoffs[0]["status"], "rejected")

    def test_invalid_input_does_not_change_state(self) -> None:
        lab = TranscriptLab()
        invalid = [
            None,
            [],
            {"type": 1},
            {**delta("bad"), "start_ms": -1},
            {**delta("bad"), "end_ms": False},
            {**delta("bad"), "event_id": ""},
            {**delta("bad"), "delta": []},
            {**delegation(), "delegation": {"id": "x", "target": []}},
        ]
        for event in invalid:
            with self.subTest(event=event), self.assertRaises(ValueError):
                lab.process(event)
        self.assertEqual(lab.event_count, 0)
        self.assertEqual(lab.snapshot()["ledger"], [])

    def test_original_sample_prefers_actual_over_projected(self) -> None:
        ledger = TranscriptLedger()
        ledger.record("user", "Hello", 0, 100, "turn:1", projected=True)
        ledger.record_event(delta("Hello"))
        self.assertEqual(ledger.consume_srt().count("Hello"), 1)
        self.assertFalse(ledger._segments[0].projected)

    def test_original_sample_unicode_cursor_and_shorter_replacement(self) -> None:
        ledger = TranscriptLedger()
        ledger.record("user", "\u6771\u4eac\U0001f600", 0, 100, "item1")
        ledger.consume_srt()
        self.assertEqual(ledger._segments[0].delivered_characters, 3)
        ledger.record("user", "\u5927\u962a", 0, 100, "item1")
        self.assertIn("\u5927\u962a", ledger.consume_srt())


if __name__ == "__main__":
    unittest.main()

import asyncio
import json
import sys
import threading
import time
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))
from recall_admission import OptionalLane, CheckLane, cheap_note


class AdmissionTest(unittest.IsolatedAsyncioTestCase):
    async def test_check_saturation_leaves_tool_executor_free(self):
        lane = CheckLane(workers=1, budget=0.03)
        entered, release = threading.Event(), threading.Event()
        def blocked():
            entered.set()
            release.wait(2)
            return {"decision": "allow"}
        first = asyncio.create_task(lane.run(blocked))
        await asyncio.to_thread(entered.wait, 1)
        try:
            burst = await asyncio.gather(*(lane.run(blocked) for _ in range(100)))
            self.assertTrue(all(result["skipped"] == "check lane busy" for result in burst))
            # This is the default worker route used by MCP/HTTP tool calls, not
            # the saturated optional executor.
            self.assertEqual(await asyncio.wait_for(asyncio.to_thread(lambda: "tool answered"), 0.2), "tool answered")
            self.assertEqual((await first)["skipped"], "check budget exceeded")
        finally:
            release.set()
            lane.pool.shutdown(wait=True)

    async def test_burst_has_one_worker_and_no_queue(self):
        lane = OptionalLane(budget=0.03)
        entered, release = threading.Event(), threading.Event()
        def work():
            entered.set()
            release.wait(2)
            return {"note": "late"}
        first = asyncio.create_task(lane.run("one", work))
        await asyncio.to_thread(entered.wait, 1)
        try:
            results = await asyncio.gather(*(lane.run(str(i), work) for i in range(500)))
            self.assertTrue(all(r.get("note") is None for r in results))
            self.assertEqual(lane.stats["started"], 1)
            self.assertEqual((await first)["skipped"], "optional budget exceeded")
            self.assertEqual((await lane.run("again", work))["skipped"], "optional lane busy")
        finally:
            release.set()
            lane.pool.shutdown(wait=True)

    async def test_negative_and_positive_results_are_checked_once(self):
        lane = OptionalLane()
        try:
            self.assertEqual((await lane.run("s", lambda: {"note": "quote"}))["note"], "quote")
            self.assertIsNone((await lane.run("s", lambda: self.fail("repeated")))["note"])
        finally:
            lane.pool.shutdown(wait=True)

    async def test_cache_is_bounded(self):
        lane = OptionalLane(cache_size=3)
        try:
            for i in range(10):
                await lane.run(str(i), lambda: {"note": None})
            self.assertEqual(len(lane.cache), 3)
        finally:
            lane.pool.shutdown(wait=True)


class SelectionTest(unittest.TestCase):
    def test_default_skips_without_model_or_database(self):
        with patch("recall_ask.llm", side_effect=AssertionError("model")), patch("recall_core.search", side_effect=AssertionError("database")):
            for text in ("yes", "/compact", "please fix the database performance", "[coord] remember earlier recall"):
                self.assertIsNone(cheap_note(text, session_id="s")["note"])

    def test_quote_is_cited_and_does_not_call_model(self):
        result = {"sessions": [{"session_id": "other", "hits": [{"event_id": 4, "snippet": "Decision: use the exported database."}]}],
                  "queries": [{"match": '"exported" AND "database"'}]}
        with patch("recall_ask.llm", side_effect=AssertionError("model")), \
             patch("recall_ask.lineage_of", return_value={"self"}), patch("recall_core.search", return_value=result):
            note = cheap_note("remember earlier exported database decision", session_id="self")
            self.assertIn("other#e4", note["note"])
            self.assertIn("Possibly stale", note["note"])

    def test_late_lineage_arrival_is_not_quoted(self):
        result = {"sessions": [{"session_id": "child", "hits": [{"event_id": 4, "snippet": "private"}]}],
                  "queries": [{"match": '"exported" AND "database"'}]}
        with patch("recall_ask.lineage_of", side_effect=[{"self"}, {"self", "child"}]), patch("recall_core.search", return_value=result):
            self.assertIsNone(cheap_note("remember earlier exported database decision", session_id="self")["note"])

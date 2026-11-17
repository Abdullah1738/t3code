import contextlib
import errno
import io
import json
import os
from pathlib import Path
import sqlite3
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))
import common
import msgs
import search
from search_timing import SearchTiming
import store


class SearchTimingTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.env = patch.dict(os.environ, MSGS_ROOT=str(self.root), MSGS_LOG_DIR=str(self.root / "logs"),
                              MSGS_TIMING="0")
        self.env.start()
        self.addCleanup(self.env.stop)
        self.db_path = patch.object(common, "DB_PATH", str(self.root / "index.db"))
        self.db_path.start()
        self.addCleanup(self.db_path.stop)
        self.root_patch = patch.object(common, "ROOT", str(self.root))
        self.root_patch.start()
        self.addCleanup(self.root_patch.stop)
        db = store.connect()
        for i in range(8):
            store.upsert(db, dict(source="email", account="gmail", ext_id=str(i),
                                 msgid=f"copy-{i // 2}", subject="refund receipt", body="AED 120 refund noon",
                                 ts=1793500000 + i))
        db.commit()
        db.close()

    def cli(self, *args):
        out, err = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            msgs.main(["search", *args])
        return out.getvalue(), err.getvalue()

    def test_timing_preserves_json_and_logs_stages(self):
        args = ('"refund" noon', "--json", "--date", "-n", "3", "--since", "2026-11-01")
        plain, plain_err = self.cli(*args)
        with patch.dict(os.environ, MSGS_TIMING="1"):
            timed, err = self.cli(*args)
        self.assertEqual(timed, plain)
        self.assertEqual(plain_err, "")
        record = json.loads(err.removeprefix("msgs timing: "))
        self.assertEqual(record["outcome"], "ok")
        self.assertEqual(record["rows_returned"], 3)
        self.assertEqual(record["rows_matched"], 5)
        for name in ("connect", "candidate_range", "fts_query", "fetch_filter", "dedupe", "chat_counts", "format", "close"):
            self.assertGreaterEqual(record["stages_ms"][name], 0)
        self.assertGreater(record["total_ms"], sum(record["stages_ms"].values()))
        self.assertGreaterEqual(record["inblock"], 0)
        self.assertGreaterEqual(record["cpu_ms"], 0)
        logs = [json.loads(line) for line in (self.root / "logs/search-timing.ndjson").read_text().splitlines()]
        self.assertEqual(logs[-1], record)
        self.assertNotIn("refund", json.dumps(logs))

    def test_unavailable_log_does_not_break_results(self):
        expected, _ = self.cli("receipt", "--json")
        file = self.root / "not-a-directory"
        file.write_text("x")
        with patch.dict(os.environ, MSGS_LOG_DIR=str(file)):
            self.assertEqual(self.cli("receipt", "--json")[0], expected)

    def test_stderr_failures_preserve_outcome_and_ndjson(self):
        expected, _ = self.cli("receipt", "--json")
        for error in (errno.ENOSPC, errno.EPIPE, errno.EIO):
            for invalid in (False, True):
                with self.subTest(errno=error, invalid=invalid):
                    out = io.StringIO()
                    with patch.dict(os.environ, MSGS_TIMING="1"), \
                            patch("sys.stderr.write", side_effect=OSError(error, "unavailable")), \
                            contextlib.redirect_stdout(out):
                        if invalid:
                            with self.assertRaises(SystemExit):
                                msgs.main(["search", "in:unknown", "--json"])
                        else:
                            msgs.main(["search", "receipt", "--json"])
                            self.assertEqual(out.getvalue(), expected)
                    records = (self.root / "logs/search-timing.ndjson").read_text().splitlines()
                    self.assertEqual(json.loads(records[-1])["outcome"], "error" if invalid else "ok")

    def test_invalid_query_still_logs_and_closes(self):
        with self.assertRaises(SystemExit):
            self.cli("in:unknown")
        record = json.loads((self.root / "logs/search-timing.ndjson").read_text())
        self.assertEqual(record["outcome"], "error")

    def test_reader_pragmas_and_no_writes(self):
        before = (self.root / "index.db").read_bytes()
        db = store.connect(readonly=True)
        try:
            self.assertEqual(db.execute("PRAGMA query_only").fetchone()[0], 1)
            self.assertEqual(db.execute("PRAGMA busy_timeout").fetchone()[0], 250)
            self.assertEqual(db.execute("PRAGMA cache_size").fetchone()[0], -16384)
            self.assertGreaterEqual(db.execute("PRAGMA mmap_size").fetchone()[0], 0)
            with self.assertRaises(sqlite3.OperationalError):
                db.execute("DELETE FROM items")
            self.assertEqual(len(search.run(db, "receipt", sort="date", limit=3)), 3)
        finally:
            db.close()
        self.assertEqual((self.root / "index.db").read_bytes(), before)

    def test_reader_timeout_does_not_shorten_writer_wait(self):
        with contextlib.closing(store.connect()) as writer, \
                contextlib.closing(store.connect(readonly=True)) as reader:
            self.assertEqual(writer.execute("PRAGMA busy_timeout").fetchone()[0], 30_000)
            self.assertEqual(reader.execute("PRAGMA busy_timeout").fetchone()[0], 250)
            with store.writing(writer):
                store.upsert(writer, dict(source="email", account="gmail", ext_id="new-receipt",
                                          subject="receipt", body="refund", ts=1793500010))
            self.assertEqual(writer.execute("PRAGMA busy_timeout").fetchone()[0], 30_000)
            self.assertEqual(reader.execute("SELECT count(*) FROM items WHERE ext_id='new-receipt'")
                             .fetchone()[0], 1)

    def test_instrumentation_preserves_query_variants(self):
        db = store.connect(readonly=True)
        self.addCleanup(db.close)
        for query in ('"refund"', "receipt", "order confirmation", '"refund" noon', "amazon", '"AED 120"',
                      "after:2999-01-01 refund", "account:gmail", "receipt -noon", "subject:receipt"):
            for sort in ("date", "rank"):
                for dedupe in (True, False):
                    with self.subTest(query=query, sort=sort, dedupe=dedupe):
                        expected = search.run(db, query, sort=sort, dedupe=dedupe, limit=3)
                        timing = SearchTiming()
                        actual = search.run(db, query, sort=sort, dedupe=dedupe, limit=3, metrics=timing)
                        self.assertEqual([dict(r) for r in actual], [dict(r) for r in expected])
                        self.assertEqual(timing.rows_returned, len(actual))

    def test_recent_date_search_formats_only_limited_candidates(self):
        db = store.connect()
        self.addCleanup(db.close)
        for i in range(100):
            store.upsert(db, dict(source="email", account="gmail", ext_id=f"many-{i}",
                                 msgid=f"unique-{i}", body="receipt", ts=1793500100 + i))
        db.commit()
        calls, statements = [], []
        db.create_function("observe_snippet", 1, lambda text: calls.append(text) or text)

        class Observed:
            @property
            def in_transaction(self):
                return db.in_transaction

            def rollback(self):
                db.rollback()

            def execute(self, sql, args=()):
                sql = sql.replace("snippet(items_fts, -1, '[', ']', '...', 14) AS snip",
                                  "observe_snippet(snippet(items_fts, -1, '[', ']', '...', 14)) AS snip")
                if "items_fts MATCH" in sql:
                    statements.extend(r[3] for r in db.execute("EXPLAIN QUERY PLAN " + sql, args))
                return db.execute(sql, args)

        rows = search.run(Observed(), "receipt after:2026-11-01", limit=3, sort="date")
        self.assertEqual([r["ext_id"] for r in rows], ["many-99", "many-98", "many-97"])
        self.assertLessEqual(len(calls), 12)
        self.assertTrue(any("items_ts" in s and "ts>?" in s for s in statements), statements)
        self.assertFalse(any("VIRTUAL TABLE" in s and "=" in s.split("INDEX", 1)[-1]
                             for s in statements), statements)

    def test_recent_date_results_match_original_query(self):
        db = store.connect()
        self.addCleanup(db.close)
        for i in range(40):
            store.upsert(db, dict(source="email", account="gmail", ext_id=f"tie-{i}", msgid=f"COPY-{i % 4}",
                                 body="refund receipt noon AED 120", subject="order confirmation",
                                 junk=int(i % 7 == 0), ts=1793500000))
        db.commit()
        queries = ('"refund"', "receipt", "order confirmation", '"refund" noon', "amazon", '"AED 120"',
                   "receipt -noon", "subject:order", "receipt is:junk", "receipt before:2027-01-01",
                   "receipt in:email", "receipt account:gmail", "receipt OR amazon")
        for query in queries:
            for dedupe in (True, False):
                for limit in (0, 1, 5, 20):
                    with self.subTest(query=query, dedupe=dedupe, limit=limit):
                        q = query + " after:2026-11-01"
                        fts, where, params, flags = search.parse(q)
                        if not flags["junk"]:
                            where.append("items.junk = 0")
                        sql = ("SELECT items.*, snippet(items_fts, -1, '[', ']', '...', 14) AS snip, "
                               f"bm25(items_fts, {search.WEIGHTS}) AS score FROM items_fts "
                               "JOIN items ON items.id = items_fts.rowid WHERE items_fts MATCH ? AND "
                               + " AND ".join(f"({w})" for w in where) + " ORDER BY items.ts DESC LIMIT ?")
                        expected, seen = [], set()
                        for row in db.execute(sql, [fts, *params, limit * 4 if dedupe else limit]):
                            key = (row["msgid"] or "").lower()
                            if dedupe and key and key in seen:
                                continue
                            if key:
                                seen.add(key)
                            expected.append(dict(row))
                            if len(expected) >= limit:
                                break
                        actual = search.run(db, q, sort="date", limit=limit, dedupe=dedupe)
                        self.assertEqual([dict(r) for r in actual], expected)


if __name__ == "__main__":
    unittest.main()

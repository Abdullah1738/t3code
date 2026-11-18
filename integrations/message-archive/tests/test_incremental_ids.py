import copy
import os
from pathlib import Path
import sys
import tempfile
import threading
import types
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))
sys.modules.setdefault("mail_oauth", types.ModuleType("mail_oauth"))

import common
import gmail_sync
import imap_sync
import mailparse
import store


NOW = 1_800_000_000


def item(ext, account="gmail", **values):
    return dict(source="email", account=account, ext_id=ext, ts=1,
                subject="mail " + ext, body="body " + ext, **values)


class ArchiveTest(unittest.TestCase):
    def setUp(self):
        root = self.enterContext(tempfile.TemporaryDirectory())
        self.root = root
        self.enterContext(patch.dict(os.environ, MSGS_ROOT=root))
        self.enterContext(patch.object(common, "ROOT", root))
        self.enterContext(patch.object(common, "DB_PATH", root + "/index.db"))
        self.enterContext(patch.object(common, "MAIL_DIR", root + "/mail"))
        self.enterContext(patch.object(store.time, "time", return_value=NOW))
        self.enterContext(patch.object(imap_sync.timing, "log"))
        self.db = store.connect()
        self.addCleanup(self.db.close)

    def seed(self, items, db=None):
        db = self.db if db is None else db
        with store.writing(db):
            for row in items:
                store.upsert(db, row)

    def rows(self, db=None):
        db = self.db if db is None else db
        return [dict(r) for r in db.execute("SELECT * FROM items ORDER BY id")]


class MembershipTest(ArchiveTest):
    def test_chunked_membership_is_scoped_and_includes_deleted(self):
        self.seed([item(str(i), deleted_at=10 if i == 4 else None) for i in range(1100)]
                  + [item("other", account="fund"), dict(item("chat"), source="imessage")])
        queries = []
        db = self.db

        class Capture:
            def execute(self, sql, args):
                queries.append((sql, args))
                return db.execute(sql, args)

        candidates = (str(i) for i in range(1201))
        self.assertEqual(store.existing_ext_ids(Capture(), "email", "gmail", candidates),
                         {str(i) for i in range(1100)})
        self.assertEqual([len(args) - 2 for _, args in queries], [500, 500, 201])
        for sql, args in queries:
            plan = [r[3] for r in db.execute("EXPLAIN QUERY PLAN " + sql, args)]
            self.assertTrue(any("SEARCH items USING COVERING INDEX sqlite_autoindex_items_1"
                                in line and "ext_id=?" in line for line in plan), plan)
            self.assertFalse(any("SCAN" in line for line in plan), plan)
        print("existing_ext_ids EXPLAIN: " + "; ".join(plan))
        queries.clear()
        self.assertEqual(store.existing_ext_ids(Capture(), "email", "gmail", []), set())
        self.assertEqual(queries, [])
        self.assertEqual(store.existing_ext_ids(db, "email", "gmail", ["4", "4", "other", "chat"]), {"4"})


class GmailHistoryTest(ArchiveTest):
    def test_history_reads_candidates_only_and_preserves_rows(self):
        self.seed([item(str(i)) for i in range(1200)]
                  + [item("return", deleted_at=10), item("gone"), item("fund-only", account="fund")])
        before = {r["ext_id"]: r for r in self.rows()}
        pages = [
            {"historyId": "8", "nextPageToken": "next", "history": [{
                "messagesAdded": [{"message": {"id": mid}}
                                  for mid in ("3", "new-b", "return", "new-b", "vanished")],
                "messagesDeleted": [{"message": {"id": "vanished"}}],
            }]},
            {"historyId": "9", "history": [{
                "messagesAdded": [{"message": {"id": mid}} for mid in ("new-a", "fund-only")],
                "messagesDeleted": [{"message": {"id": "gone"}}],
                "labelsAdded": [{"message": {"id": "3", "labelIds": ["SPAM"]}}],
            }]},
        ]
        api = unittest.mock.Mock()
        api.get.side_effect = pages
        fetched = []

        def fetch(db, api, acct, ids, names, stats, stop):
            fetched.extend(ids)
            store.upsert_many(db, [item(mid) for mid in ids], stats)
            return True

        statements = []
        self.db.set_trace_callback(statements.append)
        stats = dict(added=0, updated=0, same=0, deleted=0)
        with patch.object(store, "known_ext_ids", side_effect=AssertionError("full listing")), \
                patch.object(gmail_sync, "_fetch_many", side_effect=fetch):
            latest = gmail_sync._incremental(self.db, api, "gmail", "7", {}, stats, None)
        self.db.set_trace_callback(None)
        added = [a["message"]["id"] for p in pages for h in p["history"] for a in h.get("messagesAdded", [])]
        expected = [mid for mid in dict.fromkeys(added)
                    if mid not in {r["ext_id"] for r in before.values() if r["account"] == "gmail"}
                    and mid not in {"gone", "vanished"}]
        self.assertEqual(fetched, expected)
        self.assertEqual(fetched, ["new-b", "new-a", "fund-only"])
        self.assertEqual(latest, "9")
        reads = [s for s in statements if s.startswith("SELECT ext_id FROM items")]
        self.assertEqual(len(reads), 1)
        self.assertIn("ext_id IN (", reads[0])
        self.assertNotIn("1199", reads[0])
        rows = {(r["account"], r["ext_id"]): r for r in self.rows()}
        self.assertEqual(len(rows), 1206)
        self.assertEqual(rows["gmail", "1199"], before["1199"])
        self.assertIsNone(rows["gmail", "return"]["deleted_at"])
        self.assertEqual(rows["gmail", "gone"]["deleted_at"], NOW)
        self.assertEqual(rows["gmail", "3"]["junk"], 1)
        self.assertEqual(stats, dict(added=3, updated=1, same=0, deleted=1))

    def test_empty_history_does_not_read_membership(self):
        self.seed([item(str(i)) for i in range(50)])
        api = unittest.mock.Mock()
        api.get.return_value = {"historyId": "8"}
        statements = []
        self.db.set_trace_callback(statements.append)
        with patch.object(store, "known_ext_ids", side_effect=AssertionError("full listing")), \
                patch.object(gmail_sync, "_fetch_many", return_value=True) as fetch:
            self.assertEqual(gmail_sync._incremental(self.db, api, "gmail", "7", {},
                                                   dict(deleted=0), None), "8")
        self.assertEqual(fetch.call_args.args[3], [])
        self.assertFalse(any(s.startswith("SELECT ext_id FROM items") for s in statements))


class FakeIMAP:
    def __init__(self, uids, uv=7, exists=None, bad=()):
        self.uids, self.uv = set(uids), uv
        self.exists = len(self.uids) if exists is None else exists
        self.bad = set(bad)
        self.untagged_responses = {}
        self.fetched = []

    def list(self):
        return "OK", [b'(\\HasNoChildren) "/" "INBOX"']

    def select(self, name, readonly=False):
        self.untagged_responses = {"UIDVALIDITY": [str(self.uv).encode()]}
        return "OK", [str(self.exists).encode()]

    def uid(self, command, *args):
        if command == "SEARCH":
            return "OK", [" ".join(map(str, sorted(self.uids))).encode()]
        uids = [int(u) for u in args[0].split(",")]
        self.fetched.extend(uids)
        if self.bad & set(uids):
            return "NO", [b"message unavailable"]
        return "OK", [(f'1 (UID {u} INTERNALDATE "19-Oct-2026 10:00:00 +0400")'.encode(),
                       f"From: a@example.org\r\nSubject: mail {u}\r\n\r\nbody {u}".encode()) for u in uids]

    def logout(self):
        pass


class ImapIncrementalTest(ArchiveTest):
    def setUp(self):
        super().setUp()
        self.enterContext(patch.object(imap_sync, "BAD", {}))
        self.enterContext(patch.object(imap_sync, "RETRY_SLEEP", 0))
        self.enterContext(patch.object(mailparse, "save_raw"))

    def set_state(self, state, db=None):
        db = self.db if db is None else db
        with store.writing(db):
            store.set_state(db, "mail:icloud:INBOX", state)

    def run_sync(self, server, db=None):
        with patch.object(imap_sync, "connect", return_value=server):
            return imap_sync.sync("icloud", self.db if db is None else db)

    def check_case(self, server, state, expected_deleted, expected_fetched, known_listed,
                   initial=(1, 2, 3), tombstones=(), skipped=()):
        seeds = [item(f"INBOX:7:{u}", "icloud", deleted_at=10 if u in tombstones else None) for u in initial]
        self.seed(seeds)
        self.set_state(state)
        for u in skipped:
            imap_sync.BAD["icloud", "INBOX", server.uv, u] = imap_sync.BAD_LIMIT
        statements = []
        self.db.set_trace_callback(statements.append)
        stats = self.run_sync(server)
        self.db.set_trace_callback(None)
        self.assertEqual(stats["known_listed"], known_listed)
        full_reads = [s for s in statements if s.startswith("SELECT ext_id FROM items")
                      and "ext_id IN (" not in s and "deleted_at IS NOT NULL" not in s]
        self.assertEqual(bool(full_reads), known_listed)
        self.assertEqual(server.fetched, expected_fetched)
        self.assertEqual({r["ext_id"]: r["deleted_at"] for r in self.rows()}, expected_deleted)
        # Removing max_uid exercises the original full-list reconciliation on the same fixture.
        with patch.object(common, "DB_PATH", self.root + "/reference.db"):
            reference = store.connect()
        try:
            self.seed(seeds, reference)
            legacy_state = {k: v for k, v in state.items() if k not in ("max_uid", "pending_uids")}
            self.set_state(legacy_state, reference)
            expected_stats = self.run_sync(copy.deepcopy(server), reference)
            self.assertEqual(self.rows(), self.rows(reference))
            self.assertEqual({k: stats[k] for k in ("added", "updated", "same", "deleted")},
                             {k: expected_stats[k] for k in ("added", "updated", "same", "deleted")})
        finally:
            reference.close()
        return store.get_state(self.db, "mail:icloud:INBOX")

    def test_three_new_uids_and_next_unchanged_pass_do_not_list_known(self):
        server = FakeIMAP(range(1, 7))
        state = self.check_case(server, dict(uidvalidity=7, exists=3, max_uid=3),
                                {f"INBOX:7:{u}": None for u in range(1, 7)}, [4, 5, 6], False)
        self.assertEqual(state["max_uid"], 6)
        self.assertEqual(state["pending_uids"], [])
        with patch.object(store, "known_ext_ids", side_effect=AssertionError("full listing")), \
                patch.object(store, "existing_ext_ids", wraps=store.existing_ext_ids) as membership:
            self.assertFalse(self.run_sync(FakeIMAP(range(1, 7)))["known_listed"])
        membership.assert_not_called()

    def test_expunge_and_new_mail_in_same_pass(self):
        self.check_case(FakeIMAP([2, 3, 4]), dict(uidvalidity=7, exists=3, max_uid=3),
                        {"INBOX:7:1": NOW, **{f"INBOX:7:{u}": None for u in (2, 3, 4)}}, [4], True)

    def test_uidvalidity_change(self):
        state = self.check_case(FakeIMAP([1, 2], uv=8), dict(uidvalidity=7, exists=3, max_uid=3),
                                {**{f"INBOX:7:{u}": NOW for u in (1, 2, 3)},
                                 **{f"INBOX:8:{u}": None for u in (1, 2)}}, [1, 2], True)
        self.assertEqual((state["uidvalidity"], state["max_uid"]), (8, 2))

    def test_missing_max_uid_bootstraps_state(self):
        state = self.check_case(FakeIMAP([1, 2, 3, 4]), dict(uidvalidity=7, exists=3),
                                {f"INBOX:7:{u}": None for u in (1, 2, 3, 4)}, [4], True)
        self.assertEqual(state["max_uid"], 4)

    def test_missing_state_bootstraps_state(self):
        state = self.check_case(FakeIMAP([1, 2, 3, 4]), {},
                                {f"INBOX:7:{u}": None for u in (1, 2, 3, 4)}, [4], True)
        self.assertEqual(state["max_uid"], 4)

    def test_empty_listing_never_deletes_or_becomes_deletion_baseline(self):
        state = self.check_case(FakeIMAP([]), dict(uidvalidity=7, exists=3, max_uid=3),
                                {f"INBOX:7:{u}": None for u in (1, 2, 3)}, [], True)
        self.assertNotIn("max_uid", state)
        stats = self.run_sync(FakeIMAP([2, 3]))
        self.assertTrue(stats["known_listed"])
        self.assertEqual(stats["deleted"], 1)

    def test_listing_disagrees_with_exists(self):
        state = self.check_case(FakeIMAP([2, 3], exists=3), dict(uidvalidity=7, exists=3, max_uid=3),
                                {f"INBOX:7:{u}": None for u in (1, 2, 3)}, [], True)
        self.assertNotIn("max_uid", state)

    def test_deleted_rows_reappear_without_refetching(self):
        self.check_case(FakeIMAP([1, 2, 3]), dict(uidvalidity=7, exists=3, max_uid=3),
                        {f"INBOX:7:{u}": None for u in (1, 2, 3)}, [], True, tombstones=(2,))

    def test_restoration_cannot_mask_an_expunge(self):
        self.check_case(FakeIMAP([2, 3]), dict(uidvalidity=7, exists=2, max_uid=3),
                        {"INBOX:7:1": NOW, "INBOX:7:2": None, "INBOX:7:3": None},
                        [], True, tombstones=(2,))

    def test_unarchived_uid_return_cannot_mask_an_expunge(self):
        self.seed([item(f"INBOX:7:{u}", "icloud") for u in (1, 3)])
        self.set_state(dict(uidvalidity=7, exists=3, max_uid=3, pending_uids=[2]))
        self.run_sync(FakeIMAP([1, 3]))
        self.assertEqual(store.get_state(self.db, "mail:icloud:INBOX")["unlisted_uids"], [2])
        server = FakeIMAP([2, 3])
        stats = self.run_sync(server)
        self.assertTrue(stats["known_listed"])
        self.assertEqual(server.fetched, [2])
        self.assertEqual({r["ext_id"]: r["deleted_at"] for r in self.rows()},
                         {"INBOX:7:1": NOW, "INBOX:7:2": None, "INBOX:7:3": None})

    def test_incomplete_listing_retains_unarchived_uid_recovery(self):
        self.seed([item(f"INBOX:7:{u}", "icloud") for u in (1, 3)])
        self.set_state(dict(uidvalidity=7, exists=3, max_uid=3, pending_uids=[2]))
        self.run_sync(FakeIMAP([], exists=3))
        state = store.get_state(self.db, "mail:icloud:INBOX")
        self.assertNotIn("max_uid", state)
        self.assertEqual(state["unlisted_uids"], [2])
        self.run_sync(FakeIMAP([1, 3]))
        server = FakeIMAP([2, 3])
        stats = self.run_sync(server)
        self.assertTrue(stats["known_listed"])
        self.assertEqual(server.fetched, [2])
        self.assertEqual({r["ext_id"]: r["deleted_at"] for r in self.rows()},
                         {"INBOX:7:1": NOW, "INBOX:7:2": None, "INBOX:7:3": None})

    def test_interrupted_writes_force_reconciliation_before_reusing_counts(self):
        for interruption in ("stop", "write failure", "reconcile failure"):
            with self.subTest(interruption=interruption):
                with store.writing(self.db):
                    self.db.execute("DELETE FROM items")
                    self.db.execute("DELETE FROM sync_state")
                self.seed([item("INBOX:7:1", "icloud")])
                self.set_state(dict(uidvalidity=7, exists=1, max_uid=1))
                stop = threading.Event()
                upsert_many = store.upsert_many
                reconcile = store.reconcile

                def write(db, items, stats):
                    upsert_many(db, items, stats)
                    if interruption == "stop":
                        stop.set()
                    elif interruption == "write failure":
                        raise OSError("interrupted after committed batch")

                def fail_reconcile(*args, **kwargs):
                    reconcile(*args, **kwargs)
                    raise OSError("interrupted after reconciliation")

                with patch.object(imap_sync, "CHUNK", 1), \
                        patch.object(imap_sync, "connect", return_value=FakeIMAP(range(1, 23))), \
                        patch.object(store, "upsert_many", side_effect=write), \
                        patch.object(store, "reconcile", side_effect=fail_reconcile if
                                     interruption == "reconcile failure" else reconcile):
                    imap_sync.sync("icloud", self.db, stop=stop)
                state = store.get_state(self.db, "mail:icloud:INBOX")
                self.assertNotIn("max_uid", state)
                archived = {r["ext_id"] for r in self.rows()} - {"INBOX:7:1"}
                self.assertTrue(archived)
                # All partially committed UIDs disappear; EXISTS returns to the old count.
                stats = self.run_sync(FakeIMAP([1]))
                self.assertTrue(stats["known_listed"])
                self.assertEqual(stats["deleted"], len(archived))
                self.assertEqual({r["ext_id"]: r["deleted_at"] for r in self.rows()},
                                 {"INBOX:7:1": None, **{ext: NOW for ext in archived}})

    def test_bad_limit_skips_are_retained_below_the_watermark(self):
        state = self.check_case(FakeIMAP([1, 2, 3, 4]),
                                dict(uidvalidity=7, exists=3, max_uid=3, pending_uids=[2]),
                                {f"INBOX:7:{u}": None for u in (1, 3, 4)}, [4], False,
                                initial=(1, 3), skipped=(2,))
        self.assertEqual(state["max_uid"], 4)
        self.assertEqual(state["pending_uids"], [2])
        imap_sync.BAD.clear()
        server = FakeIMAP([1, 2, 3, 4])
        stats = self.run_sync(server)
        self.assertFalse(stats["known_listed"])
        self.assertEqual(server.fetched, [2])
        self.assertEqual(store.get_state(self.db, "mail:icloud:INBOX")["pending_uids"], [])

    def test_partial_fetch_retries_holes_even_after_higher_uids_are_archived(self):
        self.seed([item("INBOX:7:1", "icloud")])
        self.set_state(dict(uidvalidity=7, exists=1, max_uid=1))
        self.run_sync(FakeIMAP([1, 2, 3], bad=(2,)))
        state = store.get_state(self.db, "mail:icloud:INBOX")
        self.assertEqual(state["max_uid"], 3)
        self.assertEqual(state["pending_uids"], [2])
        server = FakeIMAP([1, 2, 3])
        self.assertFalse(self.run_sync(server)["known_listed"])
        self.assertEqual(server.fetched, [2])

    def test_failed_highest_uid_is_not_counted_as_new_again(self):
        self.seed([item("INBOX:7:1", "icloud")])
        self.set_state(dict(uidvalidity=7, exists=1, max_uid=1))
        self.run_sync(FakeIMAP([1, 2], bad=(2,)))
        state = store.get_state(self.db, "mail:icloud:INBOX")
        self.assertEqual(state["max_uid"], 1)
        self.assertEqual(state["pending_uids"], [2])
        imap_sync.BAD["icloud", "INBOX", 7, 2] = imap_sync.BAD_LIMIT
        server = FakeIMAP([1, 2], bad=(2,))
        self.assertFalse(self.run_sync(server)["known_listed"])
        self.assertEqual(server.fetched, [])
        imap_sync.BAD.clear()
        server = FakeIMAP([1, 2])
        self.assertFalse(self.run_sync(server)["known_listed"])
        self.assertEqual(server.fetched, [2])


if __name__ == "__main__":
    unittest.main()

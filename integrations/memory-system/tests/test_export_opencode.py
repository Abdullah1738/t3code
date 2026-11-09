"""Native export fixtures; production databases are never opened by this suite."""

import os
import sqlite3
import sys
import tempfile
import time
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'src'))
from export_opencode import Exporter, ReadBudgetExceeded


class NativeExportTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.source = self.root / 'source.sqlite'
        self.target = self.root / 'readonly/opencode.sqlite'
        self.src = sqlite3.connect(self.source, isolation_level=None)
        self.src.executescript('''
            PRAGMA journal_mode=WAL;
            CREATE TABLE session_v2(id TEXT PRIMARY KEY,parent_id TEXT,directory TEXT,title TEXT,
                metadata TEXT,time_created INTEGER,time_updated INTEGER,time_viewed INTEGER,time_suspended INTEGER,
                extra_lossless TEXT);
            CREATE TABLE session_message(id TEXT PRIMARY KEY,session_id TEXT,type TEXT,seq INTEGER,
                time_created INTEGER,time_updated INTEGER,data TEXT);
            CREATE UNIQUE INDEX message_seq ON session_message(session_id,seq);
            CREATE TABLE event_sequence(aggregate_id TEXT PRIMARY KEY,seq INTEGER);
            CREATE TABLE session_inbox(id TEXT PRIMARY KEY,session_id TEXT,payload TEXT);
            CREATE TABLE session_pending(id TEXT PRIMARY KEY,session_id TEXT,data TEXT);
            INSERT INTO session_v2 VALUES ('ses_a',NULL,'/repo','Title',NULL,1,1,1,NULL,'keep');
            INSERT INTO event_sequence VALUES ('ses_a',1);
            INSERT INTO session_message VALUES ('msg_a','ses_a','user',1,1,1,'{"text":"hello"}');
        ''')
        self.exporter = None

    def tearDown(self):
        if self.exporter:
            self.exporter.close()
        self.src.close()
        self.tmp.cleanup()

    def start(self, **kwargs):
        self.exporter = Exporter(self.source, self.target, page_size=2, chunk_size=1024, **kwargs)
        return self.exporter

    def finish(self):
        for _ in range(1000):
            if not self.exporter.step():
                return
        self.fail('export failed to converge')

    def out(self):
        return sqlite3.connect(self.target)

    def test_exports_only_required_tables_and_lossless_native_fields(self):
        self.start()
        self.finish()
        with self.out() as out:
            self.assertEqual(out.execute('SELECT data FROM session_message').fetchone()[0], '{"text":"hello"}')
            self.assertEqual(out.execute('SELECT extra_lossless FROM session_v2').fetchone()[0], 'keep')
            tables = {r[0] for r in out.execute("SELECT name FROM sqlite_schema WHERE type='table'")}
            self.assertNotIn('event_sequence', tables)
            self.assertNotIn('event', tables)
            self.assertEqual(dict(out.execute('SELECT key,value FROM ardud_readonly_meta'))['ready'], '1')
        self.assertEqual(self.target.stat().st_mode & 0o777, 0o600)
        self.assertEqual(self.exporter.src.execute('PRAGMA query_only').fetchone()[0], 1)
        with self.assertRaises(sqlite3.OperationalError):
            self.exporter.src.execute('DELETE FROM session_v2')

    def test_append_without_session_timestamp_and_streamed_rewrite_are_incremental(self):
        self.start()
        self.finish()
        self.src.executescript('''
            INSERT INTO session_message VALUES ('msg_b','ses_a','assistant',2,2,2,'{"text":"later"}');
            UPDATE event_sequence SET seq=2;
        ''')
        self.exporter.begin_cycle()
        self.finish()
        with self.out() as out:
            self.assertEqual(out.execute('SELECT count(*) FROM session_message').fetchone()[0], 2)
        now = int(time.time() * 1000)
        self.src.execute('UPDATE session_message SET data=?,time_updated=? WHERE id=?', ('{"text":"rewritten"}', now, 'msg_b'))
        self.src.execute('UPDATE event_sequence SET seq=3')
        self.exporter.begin_cycle()
        self.finish()
        with self.out() as out:
            self.assertIn('rewritten', out.execute("SELECT data FROM session_message WHERE id='msg_b'").fetchone()[0])

    def test_chunked_payload_resumes_after_restart_and_releases_source_between_steps(self):
        payload = '{"text":"' + 'x' * 9000 + '"}'
        self.src.execute('UPDATE session_message SET data=?', (payload,))
        self.start()
        for _ in range(50):
            self.exporter.step()
            state = self.exporter.out.execute('SELECT offset FROM ardud_native_payload').fetchone()
            if state and state[0] >= 2048:
                break
        else:
            self.fail('no partial payload')
        # No source SELECT/blob is left open while pacing or writing the target.
        self.src.execute("UPDATE session_v2 SET title='writer still free'")
        checkpoint = self.src.execute('PRAGMA wal_checkpoint(TRUNCATE)').fetchone()
        self.assertEqual(checkpoint[0], 0)
        self.exporter.close()
        self.start()
        self.finish()
        with self.out() as out:
            self.assertEqual(out.execute('SELECT data FROM session_message').fetchone()[0], payload)

    def test_partial_or_stale_export_never_claims_ready(self):
        self.start()
        self.exporter.step()
        with self.out() as out:
            self.assertEqual(dict(out.execute('SELECT key,value FROM ardud_readonly_meta'))['ready'], '0')
        self.finish()
        self.exporter.begin_cycle()
        with self.out() as out:
            self.assertEqual(dict(out.execute('SELECT key,value FROM ardud_readonly_meta'))['ready'], '0')

    def test_queue_retarget_and_claim_only_writes_are_revalidated_before_publish(self):
        self.start()
        for _ in range(100):
            if self.exporter.phase == 'publish':
                break
            self.exporter.step()
        self.src.execute("INSERT INTO session_inbox VALUES ('inbox','ses_a','{}')")
        self.src.execute('UPDATE session_v2 SET time_suspended=123,time_viewed=456')
        self.finish()
        with self.out() as out:
            self.assertEqual(out.execute('SELECT time_suspended,time_viewed FROM session_v2').fetchone(), (123, 456))
            self.assertEqual(out.execute('SELECT session_id FROM session_inbox').fetchone()[0], 'ses_a')

    def test_data_version_restart_clears_deleted_queue_rows(self):
        self.src.execute("INSERT INTO session_inbox VALUES ('inbox','ses_a','{}')")
        self.start()
        for _ in range(100):
            if self.exporter.phase == 'publish':
                break
            self.exporter.step()
        self.src.execute('DELETE FROM session_inbox')
        self.finish()
        with self.out() as out:
            self.assertEqual(out.execute('SELECT count(*) FROM session_inbox').fetchone()[0], 0)

    def test_session_deleted_during_payload_copy_does_not_leave_export_stuck(self):
        self.src.execute('UPDATE session_message SET data=?', ('z' * 9000,))
        self.start()
        for _ in range(100):
            self.exporter.step()
            if self.exporter.out.execute('SELECT 1 FROM ardud_native_payload').fetchone():
                break
        self.src.executescript('DELETE FROM session_v2; DELETE FROM session_message; DELETE FROM event_sequence')
        self.finish()
        with self.out() as out:
            self.assertEqual(out.execute('SELECT count(*) FROM session_message').fetchone()[0], 0)

    def test_message_session_and_queue_deletes_converge(self):
        self.src.execute("INSERT INTO session_inbox VALUES ('inbox','ses_a','secret not exported')")
        self.src.execute("INSERT INTO session_pending VALUES ('pending','ses_a','not exported')")
        self.start()
        self.finish()
        self.src.executescript("DELETE FROM session_inbox; DELETE FROM session_pending; DELETE FROM session_message; UPDATE event_sequence SET seq=2")
        self.exporter.begin_cycle()
        self.finish()
        with self.out() as out:
            for table in ('session_inbox', 'session_pending', 'session_message'):
                self.assertEqual(out.execute('SELECT count(*) FROM ' + table).fetchone()[0], 0)
        self.src.executescript('DELETE FROM session_v2; DELETE FROM event_sequence')
        self.exporter.begin_cycle()
        self.finish()
        with self.out() as out:
            self.assertEqual(out.execute('SELECT count(*) FROM session_v2').fetchone()[0], 0)

    def test_unchanged_messages_are_not_read_again(self):
        self.start()
        self.finish()
        # No source payload read is allowed for an unchanged aggregate.
        def authorize(action, table, column, *_):
            if action == sqlite3.SQLITE_READ and table == 'session_message' and column == 'data':
                return sqlite3.SQLITE_DENY
            return sqlite3.SQLITE_OK
        self.exporter.src.set_authorizer(authorize)
        self.exporter.begin_cycle()
        self.finish()

    def test_streaming_new_work_is_pinned_until_next_payload_generation(self):
        self.start()
        for _ in range(100):
            if self.exporter.phase == 'publish':
                break
            self.exporter.step()
        self.src.execute("INSERT INTO session_message VALUES ('msg_new','ses_a','user',2,2,2,'{\"text\":\"new\"}')")
        self.src.execute('UPDATE event_sequence SET seq=2')
        self.finish()
        with self.out() as out:
            self.assertEqual(out.execute("SELECT session_id FROM session_pending WHERE id='readonly:pending:ses_a'").fetchone()[0], 'ses_a')
        self.exporter.begin_cycle()
        self.finish()
        with self.out() as out:
            self.assertIsNotNone(out.execute("SELECT 1 FROM session_message WHERE id='msg_new'").fetchone())
            self.assertIsNone(out.execute("SELECT 1 FROM session_pending WHERE id='readonly:pending:ses_a'").fetchone())

    def test_change_during_blob_copy_discards_mixed_payload(self):
        self.src.execute('UPDATE session_message SET data=?', ('x' * 6000,))
        self.start()
        for _ in range(50):
            self.exporter.step()
            state = self.exporter.out.execute('SELECT offset FROM ardud_native_payload').fetchone()
            if state and state[0] >= 1024:
                break
        self.src.execute('UPDATE session_message SET data=?,time_updated=2', ('y' * 6000,))
        self.src.execute('UPDATE event_sequence SET seq=2')
        self.finish()
        self.exporter.begin_cycle()
        self.finish()
        with self.out() as out:
            self.assertEqual(out.execute('SELECT data FROM session_message').fetchone()[0], 'y' * 6000)

    def test_same_timestamp_blob_rewrite_is_deferred_not_mixed(self):
        self.src.execute('UPDATE session_message SET data=?', ('x' * 6000,))
        self.start()
        for _ in range(100):
            self.exporter.step()
            row = self.exporter.out.execute('SELECT offset FROM ardud_native_payload').fetchone()
            if row and row[0] >= 1024:
                break
        self.src.execute('UPDATE session_message SET data=?', ('y' * 6000,))
        self.src.execute('UPDATE event_sequence SET seq=2')
        self.finish()
        with self.out() as out:
            self.assertEqual(out.execute('SELECT count(*) FROM session_message').fetchone()[0], 0)
            self.assertEqual(dict(out.execute('SELECT key,value FROM ardud_readonly_meta'))['history_ready'], '0')
        self.exporter.begin_cycle()
        self.finish()
        with self.out() as out:
            self.assertEqual(out.execute('SELECT data FROM session_message').fetchone()[0], 'y' * 6000)

    def test_already_published_same_timestamp_rewrite_cannot_hit_cache(self):
        self.start()
        self.finish()
        self.src.execute("UPDATE session_message SET data='{\"text\":\"other\"}'")
        self.src.execute('UPDATE event_sequence SET seq=2')
        self.exporter.begin_cycle()
        self.finish()
        with self.out() as out:
            self.assertEqual(out.execute('SELECT data FROM session_message').fetchone()[0], '{"text":"other"}')

    def test_invalidated_published_message_cannot_escape_later_deletion(self):
        self.start()
        self.finish()
        self.src.execute('UPDATE session_message SET data=?', ('x' * 6000,))
        self.src.execute('UPDATE event_sequence SET seq=2')
        self.exporter.begin_cycle()
        for _ in range(100):
            self.exporter.step()
            row = self.exporter.out.execute('SELECT offset FROM ardud_native_payload').fetchone()
            if row and row[0] >= 1024:
                break
        self.src.execute('DELETE FROM session_message')
        self.src.execute('UPDATE event_sequence SET seq=3')
        self.finish()
        self.exporter.begin_cycle()
        self.finish()
        with self.out() as out:
            self.assertEqual(out.execute('SELECT count(*) FROM session_message').fetchone()[0], 0)
            self.assertEqual(out.execute('SELECT count(*) FROM ardud_native_messages').fetchone()[0], 0)

    def test_replacement_message_can_reuse_deleted_sequence(self):
        self.start()
        self.finish()
        self.src.executescript('''
            DELETE FROM session_message;
            INSERT INTO session_message VALUES ('msg_replacement','ses_a','user',1,1,1,'{"text":"replacement"}');
            UPDATE event_sequence SET seq=2;
        ''')
        self.exporter.begin_cycle()
        self.finish()
        with self.out() as out:
            self.assertEqual(out.execute('SELECT id FROM session_message').fetchall(), [('msg_replacement',)])

    def test_writes_after_final_metadata_scan_disable_destructive_evidence(self):
        self.start()
        for _ in range(100):
            if self.exporter.phase == 'publish':
                break
            self.exporter.step()
        self.src.execute('UPDATE session_v2 SET time_viewed=2')
        self.exporter.step()
        self.assertTrue(self.exporter.validating)
        for _ in range(100):
            if self.exporter.phase == 'publish':
                break
            self.exporter.step()
        self.src.execute("INSERT INTO session_inbox VALUES ('late','ses_a','{}')")
        self.finish()
        with self.out() as out:
            self.assertEqual(dict(out.execute('SELECT key,value FROM ardud_readonly_meta'))['destructive_ready'], '0')
        self.exporter.begin_cycle()
        self.finish()
        with self.out() as out:
            self.assertEqual(dict(out.execute('SELECT key,value FROM ardud_readonly_meta'))['destructive_ready'], '1')

    def test_restart_partial_forces_full_seen_generation_revalidation(self):
        self.src.execute("INSERT INTO session_message VALUES ('msg_b','ses_a','user',2,2,2,?)", ('x' * 6000,))
        self.start()
        for _ in range(100):
            self.exporter.step()
            row = self.exporter.out.execute('SELECT id,offset FROM ardud_native_payload').fetchone()
            if row and row[0] == 'msg_b' and row[1] >= 1024:
                break
        self.exporter.close()
        self.src.execute("DELETE FROM session_message WHERE id='msg_a'")
        self.src.execute('UPDATE event_sequence SET seq=2')
        self.start()
        self.finish()
        self.exporter.begin_cycle()
        self.finish()
        with self.out() as out:
            self.assertEqual(out.execute('SELECT id FROM session_message').fetchall(), [('msg_b',)])

    def test_target_payload_writes_are_chunk_bounded(self):
        self.src.execute('UPDATE session_message SET data=?', ('x' * 4_000_000,))
        self.start()
        # No zeroblob reserves/rewrites a multi-MB cell in the replica.
        for _ in range(30):
            self.exporter.step()
        with self.out() as out:
            self.assertLessEqual(out.execute('SELECT max(length(data)) FROM ardud_native_chunks').fetchone()[0], 1024)
        wal = Path(str(self.target) + '-wal')
        self.assertLess(wal.stat().st_size, 1_000_000)

    def test_retired_payloads_drain_resumably_and_keep_up_with_rewrites(self):
        self.src.execute('UPDATE session_message SET data=?', ('x' * 50000,))
        self.start()
        self.finish()
        for revision in range(2, 6):
            payload = chr(120 + revision) * 50000
            self.src.execute('UPDATE session_message SET data=?', (payload,))
            self.src.execute('UPDATE event_sequence SET seq=?', (revision,))
            self.exporter.begin_cycle()
            self.finish()
            # Publication is available while cleanup runs with no source read.
            self.assertEqual(self.exporter.meta('ready'), '1')
            self.assertTrue(self.exporter.collect_retired())
            if revision == 2:
                self.exporter.close()
                self.start()
                self.finish()
            for _ in range(1000):
                before = self.exporter.out.execute('SELECT count(*) FROM ardud_native_chunks').fetchone()[0]
                if not self.exporter.collect_retired():
                    break
                after = self.exporter.out.execute('SELECT count(*) FROM ardud_native_chunks').fetchone()[0]
                self.assertLessEqual(before - after, 2)
            else:
                self.fail('retired payload cleanup did not converge')
            with self.out() as out:
                self.assertEqual(out.execute('SELECT sum(length(data)) FROM ardud_native_chunks').fetchone()[0], 50000)
                self.assertEqual(out.execute('SELECT data FROM session_message').fetchone()[0], payload)
                self.assertEqual(out.execute('SELECT count(*) FROM ardud_native_retired').fetchone()[0], 0)

    def test_unicode_payload_chunk_boundaries_are_lossless(self):
        payload = '{"text":"' + ('مرحبا-日本語-é-' * 1200) + '"}'
        self.src.execute('UPDATE session_message SET data=?', (payload,))
        self.start()
        self.finish()
        with self.out() as out:
            self.assertEqual(out.execute('SELECT data FROM session_message').fetchone()[0], payload)

    def test_deleted_session_during_metadata_validation_is_pruned(self):
        self.start()
        for _ in range(100):
            if self.exporter.phase == 'publish':
                break
            self.exporter.step()
        self.src.executescript('DELETE FROM session_v2; DELETE FROM session_message; DELETE FROM event_sequence')
        self.finish()
        with self.out() as out:
            self.assertEqual(out.execute('SELECT count(*) FROM session_v2').fetchone()[0], 0)

    def test_rejects_aliases_and_exclusive_exporters(self):
        with self.assertRaises(ValueError):
            Exporter(self.source, self.source)
        self.target.parent.mkdir()
        os.link(self.source, self.target)
        with self.assertRaises(ValueError):
            Exporter(self.source, self.target)
        self.target.unlink()
        self.start()
        with self.assertRaises(RuntimeError):
            Exporter(self.source, self.target)

    def test_source_reads_are_interruptible_without_holding_transaction(self):
        self.start(read_ms=1)
        with self.assertRaises(ReadBudgetExceeded):
            self.exporter.read('WITH RECURSIVE n(x) AS (VALUES(0) UNION ALL SELECT x+1 FROM n WHERE x<10000000) SELECT sum(x) FROM n')
        self.assertFalse(self.exporter.src.in_transaction)
        self.assertEqual(self.src.execute('PRAGMA wal_checkpoint(TRUNCATE)').fetchone()[0], 0)


if __name__ == '__main__':
    unittest.main()

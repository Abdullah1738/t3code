"""Snapshot decision telemetry against isolated replicas, never caller data."""
from collections import OrderedDict
from contextlib import closing
import json
import os
import sqlite3
import unittest
from unittest.mock import patch

from test_opencode_lineage import stores
from test_recall_state_resume import PageReader
from replica_fixture import ready
import recall_core as rc
import toollog as tl

SECRET = 'caller-private-query-password=never-log'


class StateLineageLoggingTest(unittest.TestCase):
    def setUp(self):
        self.root = self.enterContext(stores())
        self.logs = self.root / 'logs'
        self.enterContext(patch.dict(os.environ, RECALL_TOOL_LOG_DIR=str(self.logs)))
        self.enterContext(patch.object(tl, '_replica_summaries', {}))
        self.enterContext(patch.object(tl, '_state_decisions', OrderedDict()))
        self.enterContext(patch.object(tl.threading, 'Timer'))
        self.enterContext(patch.object(rc, '_state_build', None))
        with closing(sqlite3.connect(rc.STATE_DB)) as con, con:
            con.execute("INSERT INTO orchestration_events VALUES(1,'readonly.watermark','','{}')")

    def rows(self):
        tl._flush_replica_summaries()
        return [json.loads(line) for path in self.logs.glob('*.ndjson') for line in path.read_text().splitlines()
                if json.loads(line)['name'] == 'state_lineage.decision']

    def props(self):
        return [row['props'] for row in self.rows()]

    def assert_fields(self, props):
        self.assertTrue({'branch', 'reason', 'old_repair', 'new_repair', 'device', 'inode', 'start_sequence',
                         'end_sequence', 'retained_min_sequence', 'retained_delta', 'sequence_delta',
                         'pages_done', 'pages_total', 'elapsed_ms', 'outcome', 'decisions'} <= props.keys(), props)
        for key in ('old_repair', 'new_repair'):
            self.assertEqual(set(props[key]), {'lineage_repair_revision', 'lineage_repair_watermark',
                                              'updated_at', 'last_rebuild_at'})
        self.assertGreaterEqual(props['elapsed_ms'], 0)

    def test_cold_overlay_and_reuse_with_complete_fields(self):
        rc._state_cache(caller=SECRET)
        with closing(sqlite3.connect(rc.STATE_DB)) as con, con:
            con.execute("INSERT INTO orchestration_events VALUES(2,'readonly.watermark','','{}')")
        rc._state_cache(caller=SECRET)
        rc._state_cache(caller=SECRET)
        props = self.props()
        self.assertEqual([(p['branch'], p['reason'], p['outcome']) for p in props], [
            ('cold_build', 'cache_cold', 'ok'), ('overlay', 'sequence_advanced', 'ok'),
            ('reuse', 'sequence_unchanged', 'ok')])
        for p in props:
            self.assert_fields(p)
        self.assertEqual(props[1]['sequence_delta'], 1)
        self.assertEqual(props[0]['new_repair']['lineage_repair_revision'], '0')
        self.assertNotIn(SECRET, json.dumps(self.rows()))

    def test_rebuild_reason_matrix_and_old_new_stamps(self):
        cases = ('repair_revision_changed', 'retained_prefix_gap', 'sequence_regressed',
                 'updated_at_changed', 'repair_marker_changed', 'repair_epoch_changed', 'inode_changed')
        for reason in cases:
            with self.subTest(reason=reason):
                rc._state_snapshot = rc._state_snapshot_generation = rc._state_build = None
                with closing(sqlite3.connect(rc.STATE_DB)) as con, con:
                    ready(con)
                    con.execute("DELETE FROM ardud_readonly_meta WHERE key='last_rebuild_at'")
                    con.execute('DELETE FROM orchestration_events')
                    con.execute("INSERT INTO orchestration_events VALUES(1,'readonly.watermark','','{}')")
                    if reason == 'updated_at_changed':
                        con.execute("DELETE FROM ardud_readonly_meta WHERE key LIKE 'lineage_repair_%'")
                old = rc._state_cache()
                old_inode = rc._state_snapshot_generation
                with closing(sqlite3.connect(rc.STATE_DB)) as con, con:
                    if reason == 'repair_revision_changed':
                        con.execute("UPDATE ardud_readonly_meta SET value='2' WHERE key='lineage_repair_revision'")
                    elif reason in ('retained_prefix_gap', 'sequence_regressed'):
                        con.execute('DELETE FROM orchestration_events')
                        con.execute("INSERT INTO orchestration_events VALUES(?,'readonly.watermark','','{}')",
                                    (10 if reason == 'retained_prefix_gap' else 0,))
                    elif reason == 'updated_at_changed':
                        ready(con)
                        con.execute("DELETE FROM ardud_readonly_meta WHERE key LIKE 'lineage_repair_%'")
                    elif reason == 'repair_marker_changed':
                        con.execute("DELETE FROM ardud_readonly_meta WHERE key='lineage_repair_watermark'")
                    elif reason == 'repair_epoch_changed':
                        con.execute("INSERT INTO ardud_readonly_meta VALUES('last_rebuild_at','2026-11-13T17:00:00Z')")
                if reason == 'inode_changed':
                    rc._state_snapshot_generation = (old_inode[0], old_inode[1] + 1, *old_inode[2:])
                rc._state_cache()
                props = self.props()
                rebuilt = props[-1]
                self.assertEqual(rebuilt['branch'], 'cold_build' if reason == 'inode_changed' else 'history_gap_rebuild')
                self.assertEqual(rebuilt['reason'], reason)
                self.assert_fields(rebuilt)
                self.assertEqual(rebuilt['old_repair']['updated_at'], old.repair_metadata['updated_at'])
                if reason == 'repair_revision_changed':
                    self.assertEqual(rebuilt['old_repair']['lineage_repair_revision'], '0')
                    self.assertEqual(rebuilt['new_repair']['lineage_repair_revision'], '2')
                if reason == 'retained_prefix_gap':
                    self.assertEqual((rebuilt['start_sequence'], rebuilt['end_sequence'],
                                      rebuilt['retained_min_sequence'], rebuilt['retained_delta']), (1, 10, 10, 9))
                if reason != 'inode_changed':
                    self.assertEqual(props[-2]['outcome'], 'refused')
                    self.assertEqual(props[-2]['reason'], reason)

    def test_timeout_and_resume_preserve_progress_without_callers(self):
        original = rc.connect_ro
        def stop(sql, parameters):
            if parameters[0]:
                raise rc.Timeout(SECRET)
        with patch.object(rc, '_STATE_CHUNK', 1), patch.object(rc, 'connect_ro',
                side_effect=lambda path: PageReader(original(path), stop, lambda *a: None)), \
             self.assertLogs('recall_core', level='WARNING') as logs:
            with self.assertRaises(rc._LineageReadError):
                rc._state_cache(caller=SECRET)
        diagnostic = json.loads(next(line.split('state lineage timeout ', 1)[1]
                                     for line in logs.output if 'state lineage timeout ' in line))
        self.assertEqual(diagnostic['branch'], 'cold_build')
        self.assertEqual(diagnostic['outcome'], 'timeout')
        for field in ('old_repair', 'new_repair', 'inode', 'retained_min_sequence', 'retained_delta'):
            self.assertIn(field, diagnostic)
        self.assertIsNone(rc._state_snapshot)
        rc._state_cache(caller=SECRET)
        props = self.props()
        self.assertEqual(props[-1]['branch'], 'resume')
        self.assertEqual(props[-1]['reason'], 'partial_build')
        self.assertGreater(props[-1]['pages_done'], diagnostic['pages_done'])
        self.assert_fields(props[-1])
        self.assertNotIn(SECRET, json.dumps(props) + json.dumps(diagnostic))

    def test_timeouts_before_and_after_snapshot_keep_fields_and_stage(self):
        for complete in (False, True):
            with self.subTest(complete=complete):
                if complete:
                    rc._state_cache()
                with self.assertLogs('recall_core', level='WARNING') as logs:
                    rc._lineage_read_error(rc.Timeout(), source='state replica', path=rc.STATE_DB)
                diagnostic = json.loads(next(line.split('state lineage timeout ', 1)[1]
                                             for line in logs.output if 'state lineage timeout ' in line))
                self.assertEqual(diagnostic['snapshot_complete'], complete)
                self.assertEqual(diagnostic['outcome'], 'timeout')
                if not complete:
                    self.assertEqual((diagnostic['branch'], diagnostic['reason']),
                                     ('verification', 'snapshot_not_started'))
                self.assert_fields(dict(diagnostic, decisions=1))

    def test_concurrent_builder_reuse(self):
        snapshot = rc._state_cache()
        generation = rc._state_snapshot_generation
        rc._state_snapshot = None
        class Publish:
            def __enter__(self):
                rc._state_snapshot, rc._state_snapshot_generation = snapshot, generation
            def __exit__(self, *args):
                pass
        with patch.object(rc, '_state_refresh_lock', Publish()):
            rc._state_cache()
        props = self.props()[-1]
        self.assertEqual(props['reason'], 'concurrent_build')
        self.assert_fields(props)

    def test_pruning_partial_build_uses_its_original_boundary(self):
        original = rc.connect_ro
        def stop(sql, parameters):
            if parameters[0]:
                raise rc.Timeout()
        def interrupted():
            with patch.object(rc, '_STATE_CHUNK', 1), patch.object(rc, 'connect_ro',
                    side_effect=lambda path: PageReader(original(path), stop, lambda *a: None)), \
                 self.assertLogs('recall_core', level='WARNING'):
                with self.assertRaises(rc._LineageReadError):
                    rc._state_cache()
        interrupted()
        with closing(sqlite3.connect(rc.STATE_DB)) as con, con:
            con.execute("INSERT INTO orchestration_events VALUES(2,'readonly.watermark','','{}')")
        interrupted()
        self.assertEqual((rc._state_build.sequence, rc._state_build.end_sequence), (1, 2))
        with closing(sqlite3.connect(rc.STATE_DB)) as con, con:
            con.execute('DELETE FROM orchestration_events WHERE sequence=1')
            con.execute("INSERT INTO orchestration_events VALUES(3,'readonly.watermark','','{}')")
        rc._state_cache()
        props = next(p for p in self.props() if p['branch'] == 'history_gap_rebuild' and p['outcome'] == 'ok')
        self.assertEqual(props['reason'], 'retained_prefix_gap')
        self.assertEqual((props['start_sequence'], props['retained_min_sequence'], props['retained_delta']), (1, 2, 1))

    def test_repeats_and_advancing_hot_snapshots_are_bounded(self):
        rc._state_cache()
        baseline = self.props()[-1]
        with patch.object(tl.time, 'monotonic', return_value=100):
            for i in range(1000):
                tl.state_lineage_decision(baseline)
                tl.state_lineage_decision(dict(baseline, branch='overlay', reason='sequence_advanced', end_sequence=i))
        rows = self.rows()
        self.assertLessEqual(len(rows), 5)
        overlays = [r for r in rows if r['props']['branch'] == 'overlay']
        self.assertEqual(len(overlays), 1)
        self.assertEqual(overlays[0]['props']['decisions'], 1000)
        self.assertEqual(overlays[0]['props']['end_sequence'], 999)
        self.assertLess(sum(len(json.dumps(r)) for r in rows), 6000)
        self.assertEqual(sum(r['props']['decisions'] for r in rows), 2001)

    def test_repeat_cache_is_bounded_and_evictions_flush_counts(self):
        props = dict(branch='cold_build', reason='cache_cold', outcome='ok')
        with patch.object(tl.time, 'monotonic', return_value=100):
            for inode in range(130):
                for _ in range(2):
                    tl.state_lineage_decision(dict(props, inode=inode))
        self.assertEqual(len(tl._state_decisions), 128)
        self.assertEqual(len(tl._replica_summaries), 128)
        self.assertEqual(sum(r['props']['decisions'] for r in self.rows()), 260)

    def test_allowlist_rejects_arbitrary_caller_and_stamp_values_and_io_failure(self):
        props = dict(branch='cold_build', reason='cache_cold', outcome='refused', caller=SECRET,
                     resumed_from={SECRET: SECRET}, path=SECRET, old_repair={'updated_at': SECRET},
                     new_repair={'lineage_repair_revision': SECRET, 'source': SECRET})
        tl.state_lineage_decision(props)
        self.assertNotIn(SECRET, json.dumps(self.rows()))
        with patch.object(tl, 'log_dir', side_effect=OSError(SECRET)):
            tl.state_lineage_decision(dict(props, reason='inode_changed'))

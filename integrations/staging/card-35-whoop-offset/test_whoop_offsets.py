"""Synthetic offsets through real import/upsert/sync/logging paths; no live IO."""
import importlib.util
import json
import os
from pathlib import Path
import sqlite3
import unittest

import test_toollog as fixture
from test_toollog import log, PACKAGE


class OffsetTests(unittest.TestCase):
    setUp = fixture.WhoopAuthTests.setUp
    patch = fixture.WhoopAuthTests.patch
    response = fixture.WhoopAuthTests.response
    STAMP = '2026-11-22T22:15:30.123Z'
    VALID = [
        ('+04:00', '2026-11-23T02:15:30+04:00'),
        ('-03:00', '2026-11-22T19:15:30-03:00'),
        ('+0400', '2026-11-23T02:15:30+04:00'),
        ('-0300', '2026-11-22T19:15:30-03:00'),
        ('+04', '2026-11-23T02:15:30+04:00'),
        ('-03', '2026-11-22T19:15:30-03:00'),
        ('+05:30', '2026-11-23T03:45:30+05:30'),
        ('+0530', '2026-11-23T03:45:30+05:30'),
        ('-03:30', '2026-11-22T18:45:30-03:30'),
        ('-0330', '2026-11-22T18:45:30-03:30'),
        ('+23:59', '2026-11-23T22:14:30+23:59'),
        ('-23:59', '2026-11-21T22:16:30-23:59'),
        *[(off, '2026-11-22T22:15:30+00:00') for off in
          ('Z', '', None, '+00:00', '-00:00', '+0000', '-0000', '+00', '-00')],
    ]
    INVALID = ['garbage', '+24:00', '-24', '+2360', '+04:60', '+4', '04',
               '0400', '04:00', '+4:00', '+04:0', '+040', '+04:', '++04:00',
               '+-04:00', '+04:00:00', '+04.5', 'z', 'UTC', ' Z ', '+04:00\n',
               ' +04:00', '+٠٤:٠٠', 4, False, [], {}]

    def test_every_supported_form_and_utc_defaults(self):
        for raw, expected in self.VALID:
            with self.subTest(raw=raw):
                self.assertEqual(self.w.local_iso(self.STAMP, raw), expected)
                self.assertIsNone(self.w.local_iso(None, raw))

    def test_malformed_shapes_ranges_and_types_fall_back(self):
        for raw in self.INVALID:
            with self.subTest(raw=raw):
                self.assertEqual(self.w.local_iso(self.STAMP, raw), '2026-11-22T22:15:30+00:00')

    def test_colon_offsets_match_previous_output_for_every_minute(self):
        # .base is source, but has no registered Python loader.
        from importlib.machinery import SourceFileLoader
        loader = SourceFileLoader('whoop_offset_base', str(PACKAGE / 'whoop.py.base'))
        spec = importlib.util.spec_from_loader(loader.name, loader)
        baseline = importlib.util.module_from_spec(spec)
        loader.exec_module(baseline)
        for sign in ('+', '-'):
            for hour in range(24):
                for minute in range(60):
                    raw = '%s%02d:%02d' % (sign, hour, minute)
                    self.assertEqual(self.w.local_iso(self.STAMP, raw), baseline.local_iso(self.STAMP, raw), raw)

    def database(self):
        con = sqlite3.connect(self.root / 'fixture.sqlite')
        con.row_factory = sqlite3.Row
        con.executescript((PACKAGE / 'schema.sql').read_text())
        return con

    def records(self, offsets, sleep=True):
        return [dict(id=('sleep-%d' % i if sleep else i), cycle_id=i,
                     start='2026-11-22T18:15:30.987Z', end=self.STAMP,
                     timezone_offset=off, score_state='SCORED')
                for i, off in enumerate(offsets)]

    def test_importers_keep_every_form_and_use_local_dates(self):
        con = self.database()
        self.addCleanup(con.close)
        for importer, table, key, sleep in ((self.w.import_sleep, 'whoop_sleep', 'sleep_id', True),
                                           (self.w.import_cycles, 'whoop_cycles', 'cycle_id', False)):
            with self.subTest(table=table):
                records = self.records([off for off, _ in self.VALID], sleep)
                self.assertEqual(importer(con, records, self.STAMP), len(records))
                for record, (_, expected) in zip(records, self.VALID):
                    row = con.execute('SELECT * FROM %s WHERE %s=?' % (table, key), (record['id'],)).fetchone()
                    self.assertEqual(row['end_at'], expected)
                    field, stamp = ('sleep_date', row['end_at']) if sleep else ('cycle_date', row['start_at'])
                    self.assertEqual(row[field], stamp[:10])
                # Re-import is an upsert, including UTC defaults.
                importer(con, records, self.STAMP)
                self.assertEqual(con.execute('SELECT count(*) FROM ' + table).fetchone()[0], len(records))

    def configure_sync(self, sleep_offsets, cycle_offsets):
        self.w.db.side_effect = self.database
        self.patch('set_status')
        sleeps = self.records(sleep_offsets)
        cycles = self.records(cycle_offsets, False)
        recoveries = [dict(cycle_id=i, sleep_id=r['id'], score_state='SCORED') for i, r in enumerate(sleeps)]
        data = {'/activity/sleep': sleeps, '/cycle': cycles, '/recovery': recoveries}
        self.payload = data
        def http(req, **kwargs):
            self.assertEqual(kwargs, {'timeout': 40})
            path = self.w.urllib.parse.urlparse(req.full_url).path.removeprefix('/developer/v2')
            self.assertIn(path, (*data, '/user/measurement/body'))
            return self.response({'records': data[path]} if path in data else {'max_heart_rate': 190})
        self.http.side_effect = http

    def run_sync(self, full=False):
        result = self.w.sync(full=full, trigger='schedule')
        rows = [json.loads(line) for p in (self.root / 'logs').glob('*.ndjson')
                for line in p.read_text().splitlines() if json.loads(line)['name'] == 'sync.run']
        row = rows[-1]
        self.last_sync_row = row
        self.assertTrue(row['ok'])
        self.assertEqual(row['props']['trigger'], 'schedule')
        self.assertIsNone(self.w._sync_metrics.get())
        return result, row['props']

    def assert_stored(self, table, expected):
        con = self.database()
        try:
            rows = con.execute('SELECT start_at,end_at FROM ' + table).fetchall()
            self.assertEqual(len(rows), len(expected))
            self.assertCountEqual([row['end_at'] for row in rows], expected)
            self.assertTrue(all(row['start_at'] for row in rows))
        finally:
            con.close()

    def test_mixed_colon_and_z_batch_syncs_all_records(self):
        self.configure_sync(['+04:00', 'Z'], ['Z', '+04:00'])
        result, props = self.run_sync(full=True)
        self.assertEqual(result['fetched'], {'sleep': 2, 'recovery': 2, 'cycles': 2, 'body': 1})
        for name in ('sleep', 'cycle', 'recovery'):
            self.assertEqual(props[name]['keptCount'], 2)
            self.assertEqual(props[name]['rawCount'], 2)
        self.assertEqual(props['offsetFallbacks'], 0)
        self.assertEqual(props['offsetSamples'], [])
        for table in ('whoop_sleep', 'whoop_cycles'):
            self.assert_stored(table, [self.VALID[0][1], '2026-11-22T22:15:30+00:00'])

    def test_one_bad_record_counts_once_with_both_timestamps(self):
        for sleep in (True, False):
            with self.subTest(sleep=sleep):
                self.configure_sync(['garbage'] if sleep else ['+04:00'],
                                    ['+04:00'] if sleep else ['garbage'])
                result, props = self.run_sync()
                self.assertEqual(result['fetched']['sleep'], 1)
                self.assertEqual(result['fetched']['cycles'], 1)
                self.assertEqual(props['offsetFallbacks'], 1)
                self.assertEqual(props['offsetSamples'], ['garbage'])
                self.assert_stored('whoop_sleep' if sleep else 'whoop_cycles', ['2026-11-22T22:15:30+00:00'])
                if os.environ.get('HEALTH_OFFSET_READBACK'):
                    Path(os.environ['HEALTH_OFFSET_READBACK']).write_text(json.dumps(
                        {'result': result, 'sync.run': self.last_sync_row}, indent=2) + '\n')

    def test_all_supported_offsets_are_not_fallbacks(self):
        offsets = [off for off, _ in self.VALID]
        self.configure_sync(offsets, offsets)
        result, props = self.run_sync()
        self.assertEqual((result['fetched']['sleep'], result['fetched']['cycles']),
                         (len(offsets), len(offsets)))
        self.assertEqual((props['offsetFallbacks'], props['offsetSamples']), (0, []))

    def test_bad_offsets_never_drop_records_and_samples_are_distinct_capped(self):
        raw = ['garbage', 'garbage', '+24:00', '+04:60', 'fourth']
        self.configure_sync(raw, ['Z', 'garbage'])
        result, props = self.run_sync()
        self.assertEqual(result['fetched']['sleep'], 5)
        self.assertEqual(result['fetched']['cycles'], 2)
        self.assertEqual(props['offsetFallbacks'], 6)
        self.assertEqual(props['offsetSamples'], ['garbage', '+24:00', '+04:60'])
        self.assert_stored('whoop_sleep', ['2026-11-22T22:15:30+00:00'] * 5)
        self.assert_stored('whoop_cycles', ['2026-11-22T22:15:30+00:00'] * 2)
        for name in ('sleep', 'cycle'):
            self.assertEqual(props[name]['keptCount'], props[name]['rawCount'])

    def test_invalid_type_records_import_with_utc(self):
        self.configure_sync([4, False, [], {}], [4, False, [], {}])
        result, props = self.run_sync()
        self.assertEqual((result['fetched']['sleep'], result['fetched']['cycles']), (4, 4))
        self.assertEqual(props['offsetFallbacks'], 8)
        self.assert_stored('whoop_sleep', ['2026-11-22T22:15:30+00:00'] * 4)
        self.assert_stored('whoop_cycles', ['2026-11-22T22:15:30+00:00'] * 4)

    def test_full_invalid_offset_matrix_survives_both_importers(self):
        self.configure_sync(self.INVALID, self.INVALID)
        result, props = self.run_sync()
        self.assertEqual((result['fetched']['sleep'], result['fetched']['cycles']),
                         (len(self.INVALID), len(self.INVALID)))
        self.assertEqual(props['offsetFallbacks'], 2 * len(self.INVALID))
        for table in ('whoop_sleep', 'whoop_cycles'):
            self.assert_stored(table, ['2026-11-22T22:15:30+00:00'] * len(self.INVALID))

    def test_metrics_reset_between_runs(self):
        self.configure_sync(['garbage'], ['Z'])
        self.assertEqual(self.run_sync()[1]['offsetFallbacks'], 1)
        self.configure_sync(['Z'], ['+04'])
        props = self.run_sync()[1]
        self.assertEqual((props['offsetFallbacks'], props['offsetSamples']), (0, []))

    def test_null_times_still_count_bad_record_once(self):
        self.configure_sync(['garbage'], ['Z'])
        self.payload['/activity/sleep'][0].update(start=None, end=None)
        result, props = self.run_sync()
        self.assertEqual(result['fetched']['sleep'], 1)
        self.assertEqual(props['offsetFallbacks'], 1)

    def test_sync_failure_retains_fallback_diagnostics(self):
        self.configure_sync(['garbage'], ['Z'])
        self.patch('mirror_sleep_sessions', side_effect=RuntimeError('synthetic failure'))
        with self.assertRaises(RuntimeError):
            self.w.sync()
        rows = [json.loads(line) for p in (self.root / 'logs').glob('*.ndjson')
                for line in p.read_text().splitlines() if json.loads(line)['name'] == 'sync.run']
        self.assertFalse(rows[-1]['ok'])
        self.assertEqual(rows[-1]['props']['offsetFallbacks'], 1)
        self.assertEqual(rows[-1]['props']['offsetSamples'], ['garbage'])
        self.assertIsNone(self.w._sync_metrics.get())

    def test_logger_allows_only_count_and_up_to_three_distinct_strings(self):
        props = log._props('sync.run', {'offsetFallbacks': 5,
            'offsetSamples': ['garbage', None, 'garbage', '+24:00', 4, '+04:60', 'fourth'],
            'unknown': 'discard'})
        self.assertEqual(props['offsetFallbacks'], 5)
        self.assertEqual(props['offsetSamples'], ['garbage', '+24:00', '+04:60'])
        self.assertNotIn('unknown', props)
        for count in (-1, True, '1'):
            self.assertNotIn('offsetFallbacks', log._props('sync.run', {'offsetFallbacks': count}))


if __name__ == '__main__':
    unittest.main()

import datetime as dt
import json
import os
from pathlib import Path
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import jobs

GB = 1024**3


class DiskDropTests(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name)
        self.logs = self.root/'logs'
        self.internal = Path('/System/Volumes/Data')
        self.external = Path('/Volumes/ExternalSSD')
        self.big = Path.home()/'.robob'
        self.ext_root = self.external/'wt'
        self.now = dt.datetime(2026, 11, 13, 12, tzinfo=dt.timezone.utc)
        for context in (patch.dict(os.environ, TOOLLOG_DIR=str(self.logs)),
                        patch.object(jobs, 'DIRECTORY_ROOTS', [self.big, self.ext_root]),
                        patch.object(jobs, 'BIG_ROOTS', {self.big})):
            context.start()
            self.addCleanup(context.stop)

    def rows(self, name):
        return [r for p in sorted(self.logs.glob('*.ndjson'))
                for r in map(json.loads, p.read_text().splitlines()) if r['name'] == name]

    def sample(self, internal=100, external=200, bad_file=False):
        self.now += dt.timedelta(minutes=30)
        def statvfs(volume):
            value = internal if volume == str(self.internal) else external
            if value is None:
                raise OSError('fixture')
            return SimpleNamespace(f_bavail=value*GB, f_frsize=1)
        original_stat = Path.stat
        def stat(path, *args, **kwargs):
            if path == self.root/'bad.sqlite':
                raise PermissionError('fixture')
            return original_stat(path, *args, **kwargs)
        with patch.object(jobs.os, 'statvfs', side_effect=statvfs), \
             patch.object(Path, 'stat', stat), \
             patch.object(jobs, 'storage_probes', return_value={'internalPurgeableGb': 2,
                          'internalLocalSnapshotCount': 0}), \
             patch.object(jobs.dt, 'datetime', wraps=dt.datetime) as clock, \
             patch.object(jobs.time, 'time', return_value=self.now.timestamp()):
            clock.now.return_value = self.now
            jobs.disk_sample(self.root, self.root/'tmp', paths=[self.root/'bad.sqlite'] if bad_file else [])
        return self.rows('disk.sample')[-1]['props']

    def inventory(self, growth=0, age=0, partial=False):
        at = (self.now+dt.timedelta(minutes=30)).timestamp()-age
        children = {str(self.big/('dir%d' % i)): (i+growth)*GB for i in range(1, 8)}
        children[str(self.big/'private-file')] = 999*GB
        state = dict(at=at, sizes={str(self.big): sum(children.values()), str(self.ext_root): GB},
                     children={str(self.big): children}, sourceErrors=int(partial),
                     partials={str(self.big): {'partial': True}} if partial else {},
                     childState={str(self.big): {p: dict(bytes=b, at=at, partial=False,
                         isDirectory=Path(p).name != 'private-file') for p, b in children.items()}})
        jobs.save_state('disk-inventory', state)

    def test_ok_error_ok_keeps_independent_numeric_baselines(self):
        first = self.sample()
        first_ts = self.rows('disk.sample')[-1]['ts']
        failed = self.sample(None, 198)
        second_ts = self.rows('disk.sample')[-1]['ts']
        last = self.sample(85, 197)
        self.assertIsNone(first['internalFreeGbDelta'])
        self.assertIsNone(failed['internalFreeGbDelta'])
        self.assertEqual(last['internalFreeGbDelta'], -15)
        self.assertEqual(last['internalDeltaFromTs'], first_ts)
        self.assertEqual(last['internalDeltaWindowS'], 3600)
        self.assertEqual(last['externalDeltaFromTs'], second_ts)
        self.assertEqual(last['externalDeltaWindowS'], 1800)
        self.assertEqual(last['deltaFromTs'], first_ts)
        self.assertEqual(last['deltaWindowS'], 3600)
        self.assertEqual(len(self.rows('disk.drop')), 1)

    def test_numeric_error_sample_is_the_next_baseline(self):
        self.sample()
        self.sample(95, bad_file=True)
        last = self.sample(90)
        self.assertEqual(last['internalFreeGbDelta'], -5)
        self.assertEqual(last['internalDeltaWindowS'], 1800)

    def test_thresholds_and_volumes(self):
        for delta, expected in ((15, 1), (5, 0), (10, 0), (10.001, 1), (-15, 0)):
            for volume in ('internal', 'external', 'both'):
                with self.subTest(delta=delta, volume=volume):
                    self.sample()
                    before = len(self.rows('disk.drop'))
                    self.sample(100-delta if volume != 'external' else 100,
                                200-delta if volume != 'internal' else 200)
                    drops = self.rows('disk.drop')[before:]
                    self.assertEqual(len(drops), expected*(2 if volume == 'both' else 1))
                    for row in drops:
                        p = row['props']
                        self.assertEqual(p['deltaGb'], -delta)
                        self.assertEqual(p['windowS'], 1800)
                        self.assertFalse(p['inventoryComplete'])
                        self.assertIn('purgeableGb', p)
                        self.assertIn('localSnapshotCount', p)

    def test_drop_top_five_directories_only(self):
        self.inventory()
        self.sample()
        self.inventory(growth=2)
        self.sample(85)
        p = self.rows('disk.drop')[-1]['props']
        self.assertTrue(p['inventoryComplete'])
        self.assertEqual(p['volume'], 'internal')
        self.assertEqual(p['purgeableGb'], 2)
        self.assertEqual(p['localSnapshotCount'], 0)
        self.assertEqual([p['grower%dBytes' % i] for i in range(1, 6)], [2*GB]*5)
        self.assertNotIn('private-file', json.dumps(p))
        self.assertNotIn('private-nested', json.dumps(p))
        self.assertEqual(p['grower1Name'], str(self.big/'dir1'))
        self.assertNotIn('grower6Name', p)

    def test_unverified_or_deeper_children_mark_incomplete_without_names(self):
        for status in ('unknown_type', 'partial', 'stale', 'nested'):
            with self.subTest(status=status):
                for growth, free in ((0, 100), (2, 85)):
                    self.inventory(growth=growth)
                    inventory = jobs.read_state('disk-inventory')
                    child = str(self.big/'dir1')
                    metadata = inventory['childState'][str(self.big)][child]
                    if status == 'unknown_type':
                        metadata.pop('isDirectory')
                    elif status == 'partial':
                        metadata['partial'] = True
                    elif status == 'stale':
                        metadata['at'] -= 7201
                    else:
                        child = str(self.big/'dir1'/'private-nested')
                        inventory['children'][str(self.big)][child] = (999+growth)*GB
                        inventory['childState'][str(self.big)][child] = dict(metadata)
                    jobs.save_state('disk-inventory', inventory)
                    self.sample(free)
                p = self.rows('disk.drop')[-1]['props']
                self.assertFalse(p['inventoryComplete'])
                self.assertNotIn(child, [p.get('grower%dName' % i) for i in range(1, 6)])

    def test_missing_stale_partial_and_reused_inventory(self):
        for status in ('missing', 'stale', 'partial', 'reused'):
            with self.subTest(status=status):
                self.inventory()
                self.sample()
                if status == 'missing':
                    jobs.state_path('disk-inventory').unlink()
                elif status != 'reused':
                    self.inventory(growth=2, age=7201 if status == 'stale' else 0,
                                   partial=status == 'partial')
                self.sample(85)
                p = self.rows('disk.drop')[-1]['props']
                self.assertFalse(p['inventoryComplete'])
                if status != 'partial':
                    self.assertNotIn('grower1Name', p)

    def test_corrupt_state_and_recovery(self):
        for text in ('{bad', 'null', '[]', '42', '{"unexpected":1}',
                     '{"sizes":[]}', '{"free":[]}', '{"sizes":{},"freeTs":[]}'):
            with self.subTest(text=text):
                self.sample()
                jobs.state_path('disk').write_text(text)
                p = self.sample()
                self.assertIsNone(p['internalFreeGbDelta'])
                self.assertEqual(p['deltaUnavailable'], 'corrupt_state')
                self.assertEqual(self.sample(99)['internalFreeGbDelta'], -1)

    def test_legacy_state_recovers_last_numeric_log_even_when_error(self):
        self.sample()
        self.sample(95, bad_file=True)
        legacy = jobs.read_state('disk')
        legacy.pop('free')
        jobs.save_state('disk', legacy)
        p = self.sample(80)
        self.assertEqual(p['internalFreeGbDelta'], -15)
        self.assertEqual(p['deltaWindowS'], 1800)

    def test_installed_free_schema_migration_preserves_timestamp_through_error(self):
        self.sample()
        previous = jobs.read_state('disk')
        first_ts = previous['ts']
        previous.pop('freeTs')
        jobs.save_state('disk', previous)
        self.sample(None)
        last = self.sample(85)
        self.assertEqual(last['internalFreeGbDelta'], -15)
        self.assertEqual(last['internalDeltaFromTs'], first_ts)
        self.assertEqual(last['internalDeltaWindowS'], 3600)

    def test_legacy_error_state_recovers_erased_volume_from_log(self):
        self.sample()
        first_ts = self.rows('disk.sample')[-1]['ts']
        self.sample(None)
        previous = jobs.read_state('disk')
        previous.pop('freeTs')
        previous['free'].pop('internalFreeGb')
        jobs.save_state('disk', previous)
        p = self.sample(85)
        self.assertEqual(p['internalFreeGbDelta'], -15)
        self.assertEqual(p['internalDeltaFromTs'], first_ts)
        self.assertEqual(p['internalDeltaWindowS'], 3600)

    def test_timestamp_forms_are_normalized_for_log_schema(self):
        for stamp in ('2026-11-13T12:00:00Z', '2026-11-13T12:00:00.000000+00:00',
                      '2026-11-13T16:00:00+04:00'):
            with self.subTest(stamp=stamp):
                jobs.save_state('disk', dict(free={'internalFreeGb': 100}, ts=stamp))
                p = self.sample(99)
                self.assertEqual(p['internalFreeGbDelta'], -1)
                self.assertEqual(p['internalDeltaFromTs'], '2026-11-13T12:00:00.000Z')

    def test_unknown_number_and_timestamp_forms(self):
        for value in (None, True, '100', -1, float('nan'), float('inf'), {}, []):
            with self.subTest(value=value):
                jobs.save_state('disk', dict(free={'internalFreeGb': value}, ts=self.now.isoformat()))
                p = self.sample()
                self.assertIsNone(p['internalFreeGbDelta'])
                self.assertEqual(p['internalDeltaUnavailable'], 'no_previous_numeric')
        for stamp in (None, 42, '', 'yesterday', '2026-11-13T12:00:00',
                      '9999-12-31T23:59:59.000Z', '9999-12-31T23:59:59-01:00',
                      '0001-01-01T00:00:00+01:00', '9999-12-31T23:59:59.999999Z'):
            with self.subTest(stamp=stamp):
                jobs.save_state('disk', dict(free={'internalFreeGb': 100}, ts=stamp))
                p = self.sample()
                self.assertIsNone(p['internalFreeGbDelta'])
                self.assertEqual(p['internalDeltaUnavailable'], 'invalid_timestamp')
                self.assertEqual(self.sample(99)['internalFreeGbDelta'], -1)

    def test_partial_child_is_excluded_on_both_sides(self):
        for partial_first in (True, False):
            with self.subTest(partial_first=partial_first):
                self.inventory()
                state = jobs.read_state('disk-inventory')
                child = str(self.big/'dir1')
                if partial_first:
                    state['childState'][str(self.big)][child]['partial'] = True
                jobs.save_state('disk-inventory', state)
                self.sample()
                self.inventory(growth=2)
                state = jobs.read_state('disk-inventory')
                if not partial_first:
                    state['childState'][str(self.big)][child]['partial'] = True
                jobs.save_state('disk-inventory', state)
                self.sample(85)
                p = self.rows('disk.drop')[-1]['props']
                self.assertNotIn(child, [p.get('grower%dName' % i) for i in range(1, 6)])


if __name__ == '__main__':
    unittest.main()

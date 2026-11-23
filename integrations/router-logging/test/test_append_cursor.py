import datetime as dt
from collections import Counter, defaultdict
import hashlib
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import append_cursor as cache
import listener_rollup
import rollup


DAY = '2026-11-21'
NOW = dt.datetime(2026, 11, 22, 1, tzinfo=dt.timezone.utc)


class StateTests(unittest.TestCase):
    def test_round_trip_preserves_types_factories_and_order_with_same_json_format(self):
        aggregate = dict(
            groups=defaultdict(cache.provider_group, {('m', True): dict(count=2, aborted=1, statuses=Counter({499: 1, 200: 1}))}),
            samples=defaultdict(list, {'hour': [1.5, 2, None, False, 'λ\n"']}),
            distinct={'one', 'two'}, at=NOW,
            counters=Counter({'second': 2, 'first': 2}),
        )
        cursor = cache.Cursor(hashlib.sha256(b'prefix'), offset=6, size=6)
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'state.json'
            cache.save(path, 3, cursor, aggregate)
            saved = cache.load(path, 3)
            decoded = cache.decode(saved['aggregate'])
            self.assertEqual(decoded, aggregate)
            self.assertIsInstance(decoded['groups'], defaultdict)
            self.assertIs(decoded['groups'].default_factory, cache.provider_group)
            self.assertIs(decoded['samples'].default_factory, list)
            self.assertIsInstance(decoded['groups'][('m', True)]['statuses'], Counter)
            self.assertEqual(decoded['counters'].most_common(), [('second', 2), ('first', 2)])
            self.assertEqual(saved['cursor']['sha256'], hashlib.sha256(b'prefix').hexdigest())
            self.assertEqual(cache.load(path, 2), {})
            # The existing streaming writer and the C encoder have the same wire format.
            with (Path(directory) / 'old.json').open('w') as out:
                json.dump(dict(version=3, cursor=cursor, aggregate=cache.encode(aggregate)), out,
                          separators=(',', ':'))
            self.assertEqual(path.read_bytes(), (Path(directory) / 'old.json').read_bytes())

    def test_save_matches_streaming_encoder_for_rollup_and_listener_shapes(self):
        samples = [0.0, -0.0, 1.23456789012345, 1e-100, 1e100,
                   float('nan'), float('inf'), -float('inf')]
        row = dict(ts='2026-11-22T17:02:17Z', tool='9router', name='poll.phases',
                   props=dict(zero=0, timings=samples, text='λ café 東京 \n"',
                              nested={'z': {'last': 1, 'first': 2}, 'a': []}))
        rollup_state = dict(times=defaultdict(list, {'poll.complete': samples}),
                            proxy={('m', '/v1/messages', True): dict(durations=samples, errors=Counter({499: 2, 200: 2}))},
                            host_pending=[row], generated=NOW)
        for aggregate in (rollup_state, [row]):
            with self.subTest(shape=type(aggregate).__name__), tempfile.TemporaryDirectory() as directory:
                path = Path(directory) / 'state.json'
                cursor = cache.Cursor(hashlib.sha256(b'prefix'), offset=6, size=6)
                cache.save(path, 3, cursor, aggregate)
                with (Path(directory) / 'old.json').open('w') as out:
                    json.dump(dict(version=3, cursor=cursor, aggregate=cache.encode(aggregate)), out,
                              separators=(',', ':'))
                self.assertEqual(path.read_bytes(), (Path(directory) / 'old.json').read_bytes())
                self.assertIn(b'NaN,Infinity,-Infinity', path.read_bytes())
                self.assertIn(b'\\u6771\\u4eac', path.read_bytes())
                self.assertTrue(cache.load(path, 3))

    def test_crash_before_replace_leaves_old_state_loadable(self):
        cursor = cache.Cursor(hashlib.sha256(b'prefix'), offset=6, size=6)
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'state.json'
            cache.save(path, 3, cursor, {'total': 7})
            before = path.read_bytes()
            script = (
                'import sys, os, hashlib\n'
                'from pathlib import Path\n'
                'sys.path.insert(0, sys.argv[1])\n'
                'import append_cursor as cache\n'
                'def crash(temporary, target):\n'
                ' assert cache.load(Path(temporary), 3)["aggregate"]\n'
                ' os._exit(73)\n'
                'cache.os.replace = crash\n'
                'cache.save(Path(sys.argv[2]), 3, cache.Cursor(hashlib.sha256(b"new"), offset=3, size=3), {"total": 99})\n'
            )
            child = subprocess.run([sys.executable, '-I', '-c', script, str(Path(cache.__file__).parent), str(path)])
            self.assertEqual(child.returncode, 73)
            self.assertEqual(path.read_bytes(), before)
            self.assertEqual(cache.decode(cache.load(path, 3)['aggregate']), {'total': 7})
            self.assertEqual(len(list(path.parent.glob('.aggregate-*'))), 1)
            cache.save(path, 3, cursor, {'total': 8})
            self.assertEqual(cache.decode(cache.load(path, 3)['aggregate']), {'total': 8})

    def test_rejected_state_rebuilds_both_caches_exactly(self):
        for damage in ('truncated', 'garbled', 'old_version', 'invalid_aggregate'):
            with self.subTest(damage=damage), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                source = root / (DAY + '.ndjson')
                event = dict(tool='9router', kind='event', name='listener.down', component='guard',
                             ts=DAY + 'T12:00:00Z', props=dict(listener='refused'))
                source.write_text(json.dumps(event) + '\n')
                expected = rollup.rollup(DAY, root, NOW)
                for prefix, version in (('.rollup-state-', rollup.AGGREGATE_VERSION), ('.listener-state-', 3)):
                    path = root / (prefix + DAY + '.json')
                    saved = json.loads(path.read_text())
                    if damage == 'truncated':
                        path.write_text(path.read_text()[:len(path.read_text()) // 2])
                    elif damage == 'garbled':
                        path.write_bytes(b'\xffnot-json')
                    else:
                        if damage == 'old_version':
                            saved['version'] = version - 1
                        else:
                            saved['aggregate'] = ['unknown', []]
                        path.write_text(json.dumps(saved))
                    if damage != 'invalid_aggregate':
                        self.assertEqual(cache.load(path, version), {})
                actual = rollup.rollup(DAY, root, NOW)
                self.assertEqual(json.dumps(actual), json.dumps(expected))
                self.assertEqual(json.dumps(actual), json.dumps(rollup.rollup(DAY, root, NOW, incremental=False)))
                self.assertEqual(list(listener_rollup.history_rows(source)), [event])

    def test_no_change_append_keeps_identical_state(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / (DAY + '.ndjson')
            source.write_text(json.dumps(dict(tool='9router', kind='event', name='listener.down',
                component='guard', ts=DAY + 'T12:00:00Z', props=dict(listener='refused'))) + '\n')
            expected = rollup.rollup(DAY, root, NOW)
            paths = [root / (prefix + DAY + '.json') for prefix in ('.rollup-state-', '.listener-state-')]
            before = [path.read_bytes() for path in paths]
            self.assertEqual(rollup.rollup(DAY, root, NOW), expected)
            self.assertEqual([path.read_bytes() for path in paths], before)
            with patch('append_cursor.save') as save:
                self.assertEqual(list(listener_rollup.history_rows(source)),
                                 list(listener_rollup.history_rows(source, incremental=False)))
            save.assert_not_called()


if __name__ == '__main__':
    unittest.main()

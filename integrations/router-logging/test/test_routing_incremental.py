import datetime as dt
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import append_cursor
import rollup

DAY = '2026-11-19'
NOW = dt.datetime(2026, 11, 20, 1, tzinfo=dt.timezone.utc)
MODEL = '0123456789abcdef'


def row(name, req='aaaaaaaa', **props):
    if name == 'proxy.request':
        props = dict(model=MODEL, route='/v1/messages', stream=True, **props)
    return dict(tool='9router', component='proxy', kind='event', name=name,
                ts=DAY + 'T13:00:00Z', ids={'req': req}, props=props)


def payload(rows):
    return ''.join(json.dumps(event) + '\n' for event in rows).encode()


def mixed_rows():
    return [row('proxy.sticky_miss', decision='moved'),
            row('proxy.sticky_miss', req='bbbbbbbb', reason='locked', decision='moved',
                prevLockCause='quota', provider='claude', model=MODEL),
            row('proxy.sticky_miss', req=None, reason='disabled', decision='hold', prevLockCause='auth'),
            row('proxy.sticky_miss', reason='over_budget', decision='503', prevLockCause='model'),
            row('proxy.fallback'),
            row('proxy.fallback', req='bbbbbbbb', reason='http_429', provider='codex', model=MODEL,
                fromProvider='claude', fromModel='abcdef0123456789'),
            row('proxy.fallback', req=None, reason='account_switch', provider='claude', model=MODEL),
            row('proxy.request', req='cccccccc'),
            row('proxy.retry', req='dddddddd')]


class RoutingIncrementalTests(unittest.TestCase):
    def compare(self, root, expected_offset):
        offsets = []
        original = append_cursor.lines

        def read(stream, cursor):
            offsets.append(cursor['offset'])
            return original(stream, cursor)

        with patch('append_cursor.lines', side_effect=read):
            incremental = rollup.rollup(DAY, root, NOW)
        # The first reader is the aggregate; listener history shares the codec.
        self.assertTrue(offsets)
        self.assertEqual(offsets[0], expected_offset)
        if expected_offset:
            self.assertGreater(offsets[0], 0)
        self.assertEqual(incremental, rollup.rollup(DAY, root, NOW, incremental=False))
        return incremental

    def seed(self, root):
        source = root / (DAY + '.ndjson')
        source.write_bytes(payload(mixed_rows()))
        self.compare(root, 0)
        return source

    def test_unchanged_cache_hits_preserve_all_routing_sections(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = self.seed(root)
            for _ in range(3):
                result = self.compare(root, source.stat().st_size)
                self.assertEqual(result['stickyMoves']['count'], 4)
                self.assertEqual(result['stickyMoves']['byReason']['unknown'], 1)
                self.assertEqual(result['fallbacks']['count'], 3)
                self.assertEqual(result['fallbacks']['chainLengthHistogram'], {'0': 2, '1': 2})

    def test_append_extends_cached_chains_and_zero_fallback_denominator(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = self.seed(root)
            offset = source.stat().st_size
            with source.open('ab') as out:
                out.write(payload([row('proxy.fallback', reason='http_503', provider='claude', model=MODEL),
                                   row('proxy.progress', req='eeeeeeee'),
                                   row('proxy.request', req='ffffffff')]))
            result = self.compare(root, offset)
            self.assertEqual(result['fallbacks']['chainLengthHistogram'], {'0': 4, '1': 1, '2': 1})
            self.assertEqual(result['fallbacks']['shareRequestsWithAtLeastTwoFallbacks'], 1 / 6)
            self.compare(root, source.stat().st_size)
            offset = source.stat().st_size
            with source.open('ab') as out:
                out.write(payload([row('proxy.sticky_miss', reason='removed', decision='moved'),
                                   row('proxy.fallback', reason='model_switch')]))
            result = self.compare(root, offset)
            self.assertEqual(result['stickyMoves']['count'], 5)
            self.assertEqual(result['fallbacks']['count'], 5)
            self.assertEqual(result['fallbacks']['chainLengthHistogram'], {'0': 4, '1': 1, '3': 1})
            self.compare(root, source.stat().st_size)

    def test_interrupted_checkpoints_resume_without_losing_or_recounting_rows(self):
        events = mixed_rows()
        for checkpoint in (1, 4, 6):
            with self.subTest(checkpoint=checkpoint), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                source = root / (DAY + '.ndjson')
                source.write_bytes(payload(events))
                state = root / ('.rollup-state-' + DAY + '.json')
                original = append_cursor.save
                saves = 0

                def interrupt(path, *args):
                    nonlocal saves
                    original(path, *args)
                    if path == state:
                        saves += 1
                        if saves == checkpoint:
                            raise KeyboardInterrupt('after durable checkpoint')

                with patch('rollup.CHECKPOINT_BYTES', 1), patch('append_cursor.save', side_effect=interrupt):
                    with self.assertRaises(KeyboardInterrupt):
                        rollup.rollup(DAY, root, NOW)
                offset = len(payload(events[:checkpoint]))
                self.assertEqual(json.loads(state.read_text())['cursor']['offset'], offset)
                self.compare(root, offset)
                self.compare(root, source.stat().st_size)

    def test_provisional_valid_and_malformed_tails_are_counted_once(self):
        tails = [row('proxy.sticky_miss', decision='moved'),
                 row('proxy.fallback', reason='http_503', provider='claude', model=MODEL),
                 row('proxy.request', req='eeeeeeee')]
        for tail in tails:
            with self.subTest(tail=tail['name']), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                source = self.seed(root)
                offset = source.stat().st_size
                with source.open('ab') as out:
                    out.write(json.dumps(tail).encode())
                for _ in range(3):
                    self.compare(root, offset)
                with source.open('ab') as out:
                    out.write(b'\n{broken')
                result = self.compare(root, offset)
                self.assertEqual(result['malformed'], 1)
                offset = source.stat().st_size - len(b'{broken')
                for _ in range(2):
                    result = self.compare(root, offset)
                    self.assertEqual(result['malformed'], 1)
                with source.open('ab') as out:
                    out.write(b'\n' + payload([row('proxy.fallback', reason='model_switch')]))
                result = self.compare(root, offset)
                self.assertEqual(result['malformed'], 1)
                self.assertEqual(result['total'], len(mixed_rows()) + 2)
                self.compare(root, source.stat().st_size)

    def test_old_missing_and_invalid_routing_cache_rebuilds(self):
        cases = ('old_version', 'missing_aggregate', 'missing_state', 'missing_field', 'extra_field',
                 'null_state', 'requests_list', 'chains_dict', 'boolean_count')
        for case in cases:
            with self.subTest(cache=case), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                source = self.seed(root)
                state = root / ('.rollup-state-' + DAY + '.json')
                saved = json.loads(state.read_text())
                aggregate = append_cursor.decode(saved['aggregate'])
                if case == 'old_version':
                    saved['version'] = rollup.AGGREGATE_VERSION - 1
                elif case == 'missing_aggregate':
                    saved.pop('aggregate')
                elif case == 'missing_state':
                    aggregate.pop('routing_state')
                elif case == 'missing_field':
                    aggregate['routing_state'].pop('requests')
                elif case == 'extra_field':
                    aggregate['routing_state']['unexpected'] = 0
                elif case == 'null_state':
                    aggregate['routing_state'] = None
                elif case == 'requests_list':
                    aggregate['routing_state']['requests'] = []
                elif case == 'chains_dict':
                    aggregate['routing_state']['chains'] = {}
                elif case == 'boolean_count':
                    aggregate['routing_state']['sticky_count'] = True
                if case != 'missing_aggregate':
                    saved['aggregate'] = append_cursor.encode(aggregate)
                state.write_text(json.dumps(saved))
                self.compare(root, 0)
                self.compare(root, source.stat().st_size)


if __name__ == '__main__':
    unittest.main()

"""Orders rollup compatibility fixtures; every reader and writer uses private logs."""
import contextlib
import datetime as dt
import importlib.util
import io
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch


ROOT = Path(__file__).resolve().parents[2]
FIXTURES = Path(__file__).with_name('fixtures')
DAY = '2026-11-12'
NEW_FIELDS = ('errorsByComponent', 'failureShare', 'topErrorSamplesByComponent',
              'topOrderFailuresByComponent', 'pollsByMerchant', 'canReportByOutcome')


def load(label, path):
    spec = importlib.util.spec_from_file_location(label, ROOT / path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


SHARED = load('component_shared', 'local-helpers/libexec/toollog/toollog.py')
AUTOMATIC = load('component_automatic', 'app-api-cli/toollog.py')
MONEY = load('component_money', 'robob-watch/checks/money-cases/toollog.py')
READERS = (SHARED, AUTOMATIC, MONEY)


class OrdersRollupTests(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.logs = Path(temp.name) / 'logs'
        self.folder = self.logs / 'orders'
        self.folder.mkdir(parents=True)
        env = patch.dict(os.environ, {'TOOLLOG_ROOT': str(self.logs),
                                     'ROBOB_TOOL_LOG_DIR': str(self.logs)})
        env.start()
        self.addCleanup(env.stop)

    def write(self, rows):
        (self.folder / (DAY + '.ndjson')).write_text(
            ''.join(json.dumps(row, separators=(',', ':')) + '\n' for row in rows))

    def fixture(self):
        return [json.loads(line) for line in
                (FIXTURES / 'orders-components.ndjson').read_text().splitlines()]

    def rollup(self, reader):
        if reader is SHARED:
            return reader.rollup('orders', DAY)
        result = reader.rollup(DAY)
        self.assertIsNotNone(result)
        self.assertEqual(result, json.loads(
            (self.folder / ('rollup-' + DAY + '.json')).read_text()))
        return result

    def test_three_components_additive_and_legacy_fields_byte_identical(self):
        (self.folder / (DAY + '.ndjson')).write_bytes(
            (FIXTURES / 'orders-components.ndjson').read_bytes())
        for reader in READERS:
            with self.subTest(reader=reader.__name__):
                result = self.rollup(reader)
                label = 'shared' if reader is SHARED else 'automatic'
                baseline_bytes = (FIXTURES / ('orders-components-' + label + '-legacy.json')).read_bytes()
                baseline = json.loads(baseline_bytes)
                legacy = {key: result[key] for key in baseline}
                legacy['durationsMs'] = {}
                for name, stats in baseline['durationsMs'].items():
                    actual = result['durationsMs'][name]
                    expected = dict(stats)
                    if reader is not SHARED and name.startswith('provider.'):
                        expected['byCaller'] = {'other': {'count': 4, **stats}}
                    self.assertEqual(actual, expected)
                    legacy['durationsMs'][name] = {
                        key: value for key, value in actual.items() if key in stats}
                self.assertEqual((json.dumps(legacy, separators=(',', ':')) + '\n').encode(),
                                 baseline_bytes)
                self.assertEqual(set(result) - set(baseline),
                                 set(NEW_FIELDS) | ({'countsByCaller'} if reader is not SHARED else set()))
                if reader is not SHARED:
                    self.assertEqual(result['countsByCaller'], {'other': 4})
                self.assertEqual(result['errorsByComponent'], {
                    'noon': {'OPERATION_FAILED': 1}, 'careem': {'OPERATION_FAILED': 1},
                    'amazon': {'TRACK_POLL_SOURCE_ERROR': 1}})
                self.assertEqual(result['failureShare'], {'noon': .5, 'careem': .5, 'amazon': 1 / 3})
                for component, name, timings in [
                    ('noon', 'provider.track', (10, 20, 20, 2)),
                    ('careem', 'provider.track', (100, 200, 200, 2)),
                    ('amazon', 'track.poll', (2000, 3000, 3000, 3)),
                ]:
                    expected = dict(zip(('p50', 'p95', 'max', 'count'), timings))
                    if reader is not SHARED and name.startswith('provider.'):
                        expected['byCaller'] = {'other': dict(expected)}
                    self.assertEqual(result['durationsMs'][component + ':' + name], expected)
                for component, line in [('noon', 2), ('careem', 4), ('amazon', 7)]:
                    sample, = result['topErrorSamplesByComponent'][component]
                    self.assertEqual(sample['sampleId'], {'file': DAY + '.ndjson', 'line': line})
                serialized = json.dumps(result)
                for private in ('private-order', 'private-address', 'private-card', 'private-message'):
                    self.assertNotIn(private, serialized)

    def test_can_report_counts_and_outcomes_in_every_reader(self):
        self.write([{'ts': DAY + 'T12:00:00Z', 'tool': 'orders', 'component': 'order-watch',
                     'name': 'order_watch.can_report', 'kind': 'event', 'ok': ok,
                     'props': {'outcome': 'success' if ok else 'refused',
                               'refusal': 'none' if ok else 'not_registered',
                               'untrackable': False, 'eta_given': ok}}
                    for ok in (True, False, False)])
        for reader in READERS:
            with self.subTest(reader=reader.__name__):
                result = self.rollup(reader)
                self.assertEqual(result['countsByName'], {'order_watch.can_report': 3})
                self.assertEqual(result['canReportByOutcome'], {'success': 1, 'refused': 2})
                self.assertEqual(result['total'], 3)
                self.assertEqual(result['okRate'], 1 / 3)
                if reader is not SHARED:
                    self.assertEqual(result['invalidLines'], 0)

    def test_shared_sampling_weights_apply_to_component_denominators_and_timings(self):
        rows = self.fixture()
        rows[0]['props']['sampleRate'] = 9
        rows[1]['props']['sampleRate'] = 999  # Errors remain unsampled.
        self.write(rows)
        result = self.rollup(SHARED)
        self.assertEqual(result['total'], 15)
        self.assertEqual(result['errorsByComponent']['noon'], {'OPERATION_FAILED': 1})
        self.assertEqual(result['failureShare']['noon'], 1 / 10)
        self.assertEqual(result['durationsMs']['noon:provider.track'],
                         {'p50': 10, 'p95': 20, 'max': 20, 'count': 10})

    def test_top_five_error_tags_per_component_rank_by_count_then_tag(self):
        tags = ['OPERATION_FAILED', 'AUTH_EXPIRED', 'TRACK_POLL_SOURCE_ERROR',
                'TRACK_REGISTRATION_FAILED', 'FAILED', 'SOURCE_ERRORS', 'OPERATION_FAILED']
        self.assertTrue(set(tags) <= AUTOMATIC._KNOWN_TAGS)
        rows = [{**self.fixture()[1], 'error': {'tag': tag, 'message': 'private-message'},
                 'ids': {'orderId': 'private-order', 'card': 'private-card'}} for tag in tags]
        self.write(rows)
        for reader in READERS:
            with self.subTest(reader=reader.__name__):
                result = self.rollup(reader)
                samples = result['topErrorSamplesByComponent']['noon']
                self.assertEqual([sample['tag'] for sample in samples],
                                 ['OPERATION_FAILED'] + sorted(set(tags) - {'OPERATION_FAILED'})[:4])
                self.assertEqual(samples[0]['count'], 2)
                for sample in samples:
                    self.assertEqual(sample['sampleId'], {
                        'file': DAY + '.ndjson', 'line': tags.index(sample['tag']) + 1})
                for key in NEW_FIELDS:
                    self.assertNotIn('private-', json.dumps(result[key]))

    def test_legacy_missing_and_invalid_components_are_unknown(self):
        for component in (None, '', {}, [], 123, 'private-component'):
            row = self.fixture()[1]
            if component is None:
                row.pop('component')
            else:
                row['component'] = component
            self.write([row])
            for reader in READERS:
                with self.subTest(component=component, reader=reader.__name__):
                    result = self.rollup(reader)
                    self.assertEqual(result['errorsByComponent'], {'unknown': {'OPERATION_FAILED': 1}})
                    self.assertEqual(result['failureShare'], {'unknown': 1})
                    self.assertIn('unknown:provider.track', result['durationsMs'])

    def test_error_kind_defines_failure_share_and_duration_validation(self):
        rows = [dict(self.fixture()[0], ok=False, durationMs=0),
                dict(self.fixture()[1], durationMs=-1),
                dict(self.fixture()[2], durationMs=float('inf')),
                dict(self.fixture()[4], durationMs=True)]
        rows[1].pop('error')
        self.write(rows)
        for reader in READERS:
            with self.subTest(reader=reader.__name__):
                result = self.rollup(reader)
                self.assertEqual(result['failureShare'], {'noon': .5, 'careem': 0, 'amazon': 0})
                self.assertEqual(result['errorsByComponent'], {
                    'noon': {'OPERATION_FAILED': 1}, 'careem': {}, 'amazon': {}})
                self.assertEqual(result['topErrorSamplesByComponent']['careem'], [])
                expected = {'p50': 0, 'p95': 0, 'max': 0, 'count': 1}
                if reader is not SHARED:
                    expected['byCaller'] = {'other': dict(expected)}
                self.assertEqual(result['durationsMs']['noon:provider.track'], expected)
                self.assertNotIn('careem:provider.track', result['durationsMs'])
                self.assertNotIn('amazon:track.poll', result['durationsMs'])

    def test_provider_durations_split_money_cases_from_other(self):
        rows = self.fixture()[:2]
        rows[0]['props']['caller'] = 'money-cases'
        self.write(rows)
        for reader in (AUTOMATIC, MONEY):
            with self.subTest(reader=reader.__name__):
                result = self.rollup(reader)
                expected = {
                    'p50': 10, 'p95': 20, 'max': 20, 'count': 2,
                    'byCaller': {
                        'money-cases': {'count': 1, 'p50': 10, 'p95': 10, 'max': 10},
                        'other': {'count': 1, 'p50': 20, 'p95': 20, 'max': 20}}}
                self.assertEqual(result['durationsMs']['noon:provider.track'], expected)
                self.assertEqual(result['durationsMs']['provider.track'],
                                 {key: value for key, value in expected.items() if key != 'count'})
                self.assertEqual(result['countsByCaller'], {'money-cases': 1, 'other': 1})

    def test_empty_day_has_empty_component_maps(self):
        for reader in READERS:
            result = self.rollup(reader)
            for key in NEW_FIELDS:
                self.assertEqual(result[key], {'success': 0, 'refused': 0} if key == 'canReportByOutcome' else {})

    def test_per_order_failure_top_five_and_amazon_poll_share_do_not_duplicate_errors(self):
        def row(order, *, component='order-watch', name='track.poll', ok=False, **props):
            return {'component': component, 'name': name, 'kind': 'perf' if ok else 'error',
                    'ok': ok, 'ids': {'orderId': order},
                    'props': {'merchant': 'amazon', **props}, 'durationMs': 100,
                    **({'error': {'tag': 'TRACK_POLL_SOURCE_ERROR'}} if not ok else {})}
        ids = [f'{i:016x}' for i in range(7)]
        rows = [row(order) for order in ids] + [row(ids[6]), row(ids[6])]
        rows += [row(ids[6], name='track.error') for _ in range(3)]
        rows += [row(ids[6], component='amazon', name='provider.track') for _ in range(3)]
        rows += [row('private-order'), row('private-order', ok=True), row(ids[6], ok=True)]
        rows += [row(ids[6], ok=True, polled=False),
                 row(ids[6], ok=True, component='amazon', name='provider.orders')]
        self.write(rows)
        for reader in READERS:
            with self.subTest(reader=reader.__name__):
                result = self.rollup(reader)
                self.assertEqual(result['topOrderFailuresByComponent'], {
                    'order-watch': [{'orderId': ids[6], 'count': 3}] +
                                   [{'orderId': order, 'count': 1} for order in ids[:4]],
                    'amazon': [{'orderId': ids[6], 'count': 3}]})
                self.assertEqual(result['pollsByMerchant'], {
                    'amazon': {'count': 12, 'failed': 10, 'failureShare': 10 / 12}})
                self.assertNotIn('private-', json.dumps(result['topOrderFailuresByComponent']))
        # The shared reader weights sampled successful polls, while errors are never sampled.
        rows[-3]['props']['sampleRate'] = 4
        self.write(rows)
        self.assertEqual(self.rollup(SHARED)['pollsByMerchant']['amazon'],
                         {'count': 15, 'failed': 10, 'failureShare': 10 / 15})

    def test_automatic_refresh_fills_additive_fields_without_schema_bump(self):
        class Clock(dt.datetime):
            @classmethod
            def now(cls, tz=None):
                return cls(2026, 11, 13, 1, tzinfo=dt.timezone.utc)
        for reader in (AUTOMATIC, MONEY):
            path = self.folder / ('rollup-' + DAY + '.json')
            path.write_text(json.dumps({'schemaVersion': 2, 'sourceBytes': 0}))
            with patch.object(reader.dt, 'datetime', Clock), \
                    patch.object(reader, 'rollup', wraps=reader.rollup) as run:
                reader.previous_day_rollup()
                reader.previous_day_rollup()
                run.assert_called_once_with(DAY)
            result = json.loads(path.read_text())
            self.assertEqual(result['schemaVersion'], 2)
            self.assertTrue(all(key in result for key in NEW_FIELDS))

    def test_shared_cli_writes_schema_one_and_other_boards_are_unchanged(self):
        self.write(self.fixture())
        with contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(SHARED.main(['rollup', '--board', 'orders', '--day', DAY]), 0)
        result = json.loads((self.folder / ('rollup-' + DAY + '.json')).read_text())
        self.assertEqual(result['schemaVersion'], 1)
        self.assertTrue(all(key in result for key in NEW_FIELDS))
        other = SHARED.rollup('agent-tools', DAY)
        self.assertFalse(set(NEW_FIELDS) & set(other))
        self.assertNotIn('durationsMs', other)

    def test_composite_duration_key_does_not_replace_a_legacy_event_name(self):
        rows = self.fixture()
        rows.append(dict(rows[0], name='noon:provider.track', durationMs=999))
        self.write(rows)
        result = self.rollup(SHARED)
        self.assertEqual(result['durationsMs']['noon:provider.track'],
                         {'p50': 999, 'p95': 999, 'max': 999})

    def test_portable_logger_copies_remain_identical(self):
        self.assertEqual((ROOT / 'app-api-cli/toollog.py').read_bytes(),
                         (ROOT / 'robob-watch/checks/money-cases/toollog.py').read_bytes(),
                         msg='app-api-cli/toollog.py and robob-watch/checks/money-cases/toollog.py must stay identical: copy the changed one over the other')

    def test_card_fill_component_and_errors_survive_every_reader(self):
        rows = [dict(ts=DAY + 'T12:00:00Z', tool='orders', component='card-vault-fill',
                     name='card.fill', kind='error', ok=False, durationMs=12,
                     error={'tag': code}, props={'route': 'phone', 'field': 'card_cvc', 'outcome': 'failure'})
                for code in ('CARD_FILL_TARGET_REQUIRED', 'CARD_FILL_NO_FOCUS', 'CARD_FILL_FAILED')]
        self.write(rows)
        for reader in READERS:
            with self.subTest(reader=reader.__name__):
                result = self.rollup(reader)
                self.assertEqual(result['errorsByComponent']['card-vault-fill'],
                                 {row['error']['tag']: 1 for row in rows})
                self.assertEqual(result['failureShare']['card-vault-fill'], 1)
                self.assertEqual(result['durationsMs']['card-vault-fill:card.fill'],
                                 {'p50': 12, 'p95': 12, 'max': 12, 'count': 3})


if __name__ == '__main__':
    unittest.main()

import contextlib
from datetime import datetime, timedelta, timezone
import io
import json
import os
from pathlib import Path
import stat
import sys
import tempfile
import time
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'libexec/toollog'))
import toollog


class ToolLogTests(unittest.TestCase):
    def test_shared_render_root_path_shapes_with_and_without_counters(self):
        import sqlite3
        with tempfile.TemporaryDirectory() as temp:
            cwd = Path(temp) / 'cwd'
            cwd.mkdir()
            cases = [('absolute', str(Path(temp) / 'absolute')), ('relative', 'logs'),
                     ('dot-relative', './dot-logs'), ('parent-relative', '../parent-logs'),
                     ('spaces', 'space logs'), ('uri-specials', 'logs?#%'), ('unicode', 'méta-logs')]
            previous = Path.cwd()
            try:
                os.chdir(cwd)
                for label, root in cases:
                    with self.subTest(shape=label), patch.dict(os.environ, {'TOOLLOG_ROOT': root}):
                        directory = toollog.board_dir('imessage')
                        directory.mkdir(parents=True)
                        (directory / (self.day + '.ndjson')).write_text(json.dumps({
                            'component': 'fixture', 'name': 'fixture.start', 'kind': 'event'}) + '\n')
                        self.assertEqual(toollog.rollup('imessage', self.day)['total'], 1)
                        with sqlite3.connect(directory / f'renders-{self.day}.sqlite') as db:
                            db.execute('CREATE TABLE bins (component TEXT, cardKind TEXT, chat TEXT, ms INTEGER, count INTEGER)')
                            db.execute('INSERT INTO bins VALUES (?, ?, ?, ?, ?)', ('delivery-renderer', 'delivery', 'owner', 7, 3))
                        result = toollog.rollup('imessage', self.day)
                        self.assertEqual(result['total'], 4)
                        self.assertEqual(result['recordedRows'], 1)
                        self.assertEqual(result['byComponent']['delivery-renderer']['card.render']['count'], 3)
            finally:
                os.chdir(previous)

    def test_shared_render_counters_merge_with_legacy_rows_without_counting_them_as_log_lines(self):
        import sqlite3
        directory = toollog.board_dir('imessage')
        directory.mkdir(parents=True)
        with sqlite3.connect(directory / f'renders-{self.day}.sqlite') as db:
            db.execute('CREATE TABLE bins (component TEXT, cardKind TEXT, chat TEXT, ms INTEGER, count INTEGER)')
            db.executemany('INSERT INTO bins VALUES (?, ?, ?, ?, ?)', [
                ('delivery-renderer', 'delivery', 'owner', 7, 3),
                ('delivery-renderer', 'delivery', 'owner', 9, 2),
                ('PRIVATE', 'delivery', 'owner', 1, 1),
                ('delivery-renderer', 'PRIVATE', 'owner', 1, 1),
                ('delivery-renderer', 'delivery', 'PRIVATE', 1, 1),
                ('delivery-renderer', 'delivery', 'owner', 971501234567, 1),
            ])
        legacy = {'component': 'delivery-renderer', 'name': 'card.renders', 'kind': 'perf',
                  'renders': {'count': 2, 'histogram': [[10, 2]]}}
        failed = {'component': 'delivery-renderer', 'name': 'card.render', 'kind': 'perf', 'ok': False,
                  'props': {'failureCode': 'preview_missing'}, 'durationMs': 11}
        (directory / (self.day + '.ndjson')).write_text(json.dumps(legacy) + '\n' + json.dumps(failed) + '\n')
        result = toollog.rollup('imessage', self.day)
        self.assertEqual(result['recordedRows'], 2)
        self.assertEqual(result['byComponent']['delivery-renderer']['card.render'], {
            'count': 8, 'ok': 7, 'failed': 1, 'errorRate': 1 / 8,
            'durationMs': {'p50': 9, 'p95': 11, 'max': 11}})
        self.assertNotIn('PRIVATE', json.dumps(result))
        self.assertNotIn('971501234567', json.dumps(result))

    def test_imessage_causes_and_render_counters_are_reduced(self):
        directory = toollog.board_dir('imessage')
        directory.mkdir(parents=True)
        rows = [
            {'component': 'delivery-renderer', 'kind': 'perf', 'name': 'card.renders', 'ok': True,
             'renders': {'count': 250, 'histogram': [[10, 250]]}},
            {'component': 'delivery-renderer', 'kind': 'perf', 'name': 'card.render', 'ok': False,
             'durationMs': 20, 'props': {'failureCode': 'preview_missing'}},
        ]
        for fields in [{'code': 'ECONNRESET'}, {'code': 'ECONNRESET'}, {'errno': -61}, {'status': 503}, {},
                       {'code': 'PRIVATE_TOKEN'}, {'code': 971501234567},
                       {'errno': '/Users/private/PRIVATE'}, {'code': 'https://private/?token=PRIVATE'}]:
            rows.append({'kind': 'error', 'name': 'bridge.catch', 'error': {
                'tag': 'router.catch1', 'name': 'Error', **fields}})
        rows.append({'kind': 'error', 'name': 'bridge.catch', 'error': {
            'tag': 'router.catch49', 'name': 'UnknownError', 'causeKey': 'background_watch'}})
        (directory / (self.day + '.ndjson')).write_text(''.join(json.dumps(row) + '\n' for row in rows))
        result = toollog.rollup('imessage', self.day)
        self.assertIn({'tag': 'router.catch1', 'causeKey': 'code.ECONNRESET', 'count': 2}, result['topCauses'])
        self.assertEqual(len(result['topCauses']), 5)
        self.assertEqual(result['cardRenderFailures'], {'preview_missing': 1})
        self.assertEqual(result['byComponent']['delivery-renderer']['card.render']['count'], 251)
        self.assertEqual(result['byComponent']['delivery-renderer']['card.render']['failed'], 1)
        self.assertNotIn('PRIVATE', json.dumps(result))
        self.assertNotIn('971501234567', json.dumps(result))

    def test_imessage_replayed_causes_match_shared_typescript_fixtures(self):
        fixtures = Path(__file__).resolve().parents[2] / 'spectrum-bridge/test/fixtures/rollup-causes.json'
        directory = toollog.board_dir('imessage')
        directory.mkdir(parents=True)
        for fixture in json.loads(fixtures.read_text()):
            with self.subTest(shape=fixture['name']):
                request = fixture.get('request', False)
                tag = 'control.request_failed' if request else fixture.get('tag', 'fixture.catch')
                row = {'component': 'robob' if request else 'router', 'kind': 'perf' if request else 'error',
                       'name': 'turn.robob_call' if request else 'bridge.catch', 'ok': False,
                       'props': {**fixture.get('props', {}), **({'failureFormat': 'single'} if fixture.get('single') else {})},
                       'error': {'tag': tag, **fixture['error']}}
                row.update(fixture.get('row', {}))
                for field in fixture.get('omit', []):
                    row.pop(field, None)
                (directory / (self.day + '.ndjson')).write_text(json.dumps(row) + '\n')
                result = toollog.rollup('imessage', self.day)
                expected = [{'tag': fixture.get('expectedTag', tag), 'causeKey': fixture['expected'], 'count': 1}] if fixture['expected'] else []
                self.assertEqual(result['topCauses'], expected)
                self.assertNotIn('PRIVATE_', json.dumps(result['topCauses']))

    def test_imessage_failure_formats_do_not_duplicate_legacy_diagnostics(self):
        directory = toollog.board_dir('imessage')
        directory.mkdir(parents=True)
        def raw(batch, single=False):
            return {'ts': self.day + 'T12:00:00Z', 'component': 'robob', 'kind': 'perf', 'name': 'turn.robob_call',
                    'ok': False, 'durationMs': 25000, 'ids': {'runId': 'same-run', 'callBatchId': batch},
                    'props': {'method': 'GET', 'route': '/threads/:id/messages', **({'failureFormat': 'single'} if single else {})},
                    'error': {'tag': 'control.request_failed', 'name': 'TimeoutError'}}
        def summary(batch):
            return {'component': 'robob', 'kind': 'perf', 'name': 'turn.robob_calls',
                    'ids': {'runId': 'same-run', 'callBatchId': batch},
                    'calls': {'messages': {'ok': 9, 'failed': 1, 'histogram': [[10, 9], [25000, 1]]}}}
        catch = {'component': 'control', 'kind': 'error', 'name': 'bridge.catch', 'ok': False,
                 'ids': {'runId': 'same-run'}, 'error': {'tag': 'control.catch1', 'name': 'TimeoutError'}}
        for shape in ['legacy', 'mixed', 'reversed', 'orphan', 'new_only', 'new_orphan', 'summary_only']:
            with self.subTest(shape=shape):
                rows = ([raw('new', True)] if shape == 'new_orphan' else
                        [raw('new', True), summary('new')] if shape == 'new_only' else
                        [summary('old')] if shape == 'summary_only' else
                        [catch, raw('old'), raw('new', True)] if shape == 'orphan' else
                        [catch, raw('old'), summary('old')] + ([] if shape == 'legacy' else [raw('new', True), summary('new')]))
                if shape == 'mixed':
                    for row in rows:
                        if row.get('ids', {}).get('callBatchId') == 'new':
                            row['ts'] = self.day + 'T13:00:00Z'
                if shape == 'reversed':
                    rows.reverse()
                (directory / (self.day + '.ndjson')).write_text(''.join(json.dumps(row) + '\n' for row in rows))
                result = toollog.rollup('imessage', self.day)
                total = 1 if shape == 'new_orphan' else 11 if shape == 'legacy' else 3 if shape == 'orphan' else 10 if shape in {'new_only', 'summary_only'} else 21
                new_only = shape in {'new_only', 'new_orphan'}
                has_catch = not new_only and shape != 'summary_only'
                call_failures = 1 if shape in {'legacy', 'summary_only'} or new_only else 2
                diagnostics = 0 if shape == 'summary_only' else 1 if shape == 'legacy' or new_only else 2
                self.assertEqual((result['total'], result['recordedRows'], result['errorRate'], result['failedCount']), (total, len(rows), diagnostics / total, call_failures + has_catch))
                self.assertEqual(result['byComponent']['robob']['messages']['failed'], call_failures)
                expected = ([] if not has_catch else [('control.catch1', 1)]) + ([] if shape in {'legacy', 'summary_only'} else [('control.request_failed', 1)])
                self.assertEqual([(item['tag'], item['count']) for item in result['topErrorTags']], expected)

    def test_imessage_rollup_summary_appended_after_read_is_never_double_counted(self):
        directory = toollog.board_dir('imessage')
        directory.mkdir(parents=True)
        path = directory / (self.day + '.ndjson')
        raw = {'component': 'robob', 'kind': 'perf', 'name': 'turn.robob_call', 'ok': False, 'durationMs': 1001,
               'ids': {'callBatchId': 'batch-fixture'}, 'props': {'method': 'GET', 'route': '/threads/:id'}}
        summary = {**raw, 'name': 'turn.robob_calls', 'calls': {'thread': {
            'ok': 2, 'failed': 1, 'histogram': [[10, 1], [20, 1], [1001, 1]]}}}
        path.write_text(json.dumps(raw) + '\n')
        original = toollog._read_records
        reads = 0
        def append_after_read(board, day):
            nonlocal reads
            yield from original(board, day)
            if day == self.day:
                reads += 1
                if reads == 1:
                    with path.open('a') as dest:
                        dest.write(json.dumps(summary) + '\n')
        with patch.object(toollog, '_read_records', append_after_read):
            first = toollog.rollup('imessage', self.day)
        self.assertEqual((first['total'], first['failedCount']), (1, 1))
        second = toollog.rollup('imessage', self.day)
        self.assertEqual((second['total'], second['failedCount']), (3, 1))

    def test_imessage_aggregate_counts_and_percentiles_without_duplicate_slow_rows(self):
        directory = toollog.board_dir('imessage')
        directory.mkdir(parents=True)
        stats = {'count': 3, 'ok': 2, 'failed': 1, 'p50': 10, 'p95': 1002, 'max': 1002,
                 'histogram': [[10, 2], [1002, 1]]}
        call = {'component': 'robob', 'kind': 'perf', 'name': 'turn.robob_call', 'ok': False,
                'durationMs': 1002, 'ids': {'runId': 'run-fixture', 'callBatchId': 'batch-fixture'},
                'error': {'tag': 'control.request_failed', 'name': 'TimeoutError'},
                'props': {'method': 'GET', 'route': '/threads/:id', 'failureFormat': 'single'}}
        rows = [{**call, 'name': 'turn.robob_calls', 'calls': {'thread': stats}}, call,
                {**call, 'durationMs': 2000, 'ids': {'callBatchId': 'orphan'}},
                {'component': 'router', 'kind': 'perf', 'name': 'turn.end', 'ok': True}]
        (directory / (self.day + '.ndjson')).write_text(''.join(json.dumps(row) + '\n' for row in rows))
        result = toollog.rollup('imessage', self.day)
        self.assertEqual((result['total'], result['recordedRows'], result['okCount'], result['failedCount']), (5, 4, 3, 2))
        self.assertEqual(result['countsByName']['turn.robob_call'], 4)
        self.assertEqual(result['errorRate'], 2 / 5)
        self.assertEqual(result['topErrorTags'][0]['count'], 2)
        self.assertFalse(result['sampled'])
        self.assertEqual(result['byComponent']['robob']['thread'], {
            'count': 4, 'ok': 2, 'failed': 2, 'errorRate': .5, 'durationMs': {'p50': 10, 'p95': 2000, 'max': 2000}})

    def test_imessage_aggregate_rejects_private_names_and_invalid_histograms(self):
        directory = toollog.board_dir('imessage')
        directory.mkdir(parents=True)
        for histogram, expected in [([[5, 1], [971501234567, 1]], 5), ([[5, 2]], None), ([[5, -1]], None)]:
            stats = {'ok': 1, 'failed': 0, 'histogram': histogram, 'p50': 'PRIVATE_BODY'}
            row = {'component': 'robob', 'kind': 'perf', 'name': 'turn.robob_calls',
                   'calls': {'PRIVATE_TOKEN': stats, 'thread': stats}}
            (directory / (self.day + '.ndjson')).write_text(json.dumps(row) + '\n')
            result = toollog.rollup('imessage', self.day)
            self.assertNotIn('PRIVATE', json.dumps(result))
            self.assertNotIn('971501234567', json.dumps(result))
            if expected:
                self.assertEqual(result['byComponent']['robob']['thread']['durationMs']['p95'], expected)
            else:
                self.assertNotIn('thread', result['byComponent']['robob'])

    def test_missing_override_uses_private_temp_root(self):
        with patch.dict(os.environ):
            os.environ.pop('TOOLLOG_ROOT', None)
            root = toollog.root()
            self.assertTrue(root.resolve().is_relative_to(Path(tempfile.gettempdir()).resolve()))
            self.assertFalse(root.is_relative_to(Path.home() / '.robob'))
            self.assertEqual(toollog.root(), root)
            toollog.emit('fixture', 'event', 'test.start', board='imessage')
            self.assertTrue(list((root / 'imessage').glob('*.ndjson')))

    def setUp(self):
        sampling = patch.object(toollog.random, 'random', return_value=0)
        sampling.start()
        self.addCleanup(sampling.stop)
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.env = patch.dict(os.environ, {'TOOLLOG_ROOT': self.tmp.name + '/logs'})
        self.env.start()
        self.addCleanup(self.env.stop)
        self.day = datetime.now(timezone.utc).strftime('%Y-%m-%d')

    def rows(self, board='agent-tools'):
        return list(toollog.read(board, self.day))

    def test_hook_identity_source_only_logs_known_values(self):
        for source in ('cache', 'control', 'negative-cache', 'PRIVATE_FIXTURE', {'secret': 'PRIVATE_FIXTURE'}):
            toollog.hook('codex', 'shell', 'allowed', 'no-policy', 0.1,
                         error_tag='identity-unavailable', identity_source=source)
        rows = self.rows()
        self.assertEqual([row['props'].get('identity_source') for row in rows],
                         ['cache', 'control', 'negative-cache', None, None])
        self.assertNotIn('PRIVATE_FIXTURE', json.dumps(rows))

    def test_orders_rollup_preserves_cause_groups_and_merchant_timings(self):
        directory = toollog.board_dir('orders')
        directory.mkdir(parents=True)
        records = []
        for merchant, status, duration in [('noon', 401, 10), ('noon', 401, 20),
                                           ('noon', 500, 30), ('amazon', 500, 5000),
                                           (None, None, 40)]:
            records.append({'ts': self.day + 'T12:00:00Z', 'tool': 'orders', 'component': 'order-watch',
                'name': 'track.poll', 'kind': 'error', 'durationMs': duration, 'ok': False,
                'props': {'merchant': merchant},
                'error': {'tag': 'OPERATION_FAILED', 'cause': {'httpStatus': status}}})
        (directory / (self.day + '.ndjson')).write_text(''.join(json.dumps(row) + '\n' for row in records))
        result = toollog.rollup('orders', self.day)
        self.assertEqual({(row['httpStatus'], row['merchant']): row['count'] for row in result['topErrors']},
                         {(401, 'noon'): 2, (500, 'noon'): 1, (500, 'amazon'): 1, (None, 'unknown'): 1})
        self.assertEqual(result['durationsMs']['track.poll']['byMerchant']['noon'],
                         {'count': 3, 'p50': 20, 'p95': 30, 'max': 30})
        self.assertEqual(result['durationMsByName']['track.poll'], {'p50': 30, 'p95': 5000, 'max': 5000})
        self.assertEqual(result['topErrorTags'][0]['count'], 5)

    def test_sampled_orders_rollup_weights_merchant_durations_and_groups_errors(self):
        directory = toollog.board_dir('orders')
        directory.mkdir(parents=True)
        records = []
        for merchant, kind, duration, rate, status in [
            ('noon', 'perf', 10, 20, None), ('noon', 'perf', 100, 1, None),
            ('noon', 'error', 1000, 128, 401), ('noon', 'error', 2000, 32, 401),
            ('careem', 'perf', 25, 2, None), ('amazon', 'perf', 50, 1, None),
            ('amazon', 'error', 3000, 64, 500), (None, 'error', 4000, 1, None),
        ]:
            records.append({'ts': self.day + 'T12:00:00Z', 'tool': 'orders',
                'name': 'track.poll', 'kind': kind, 'durationMs': duration, 'ok': kind != 'error',
                'props': {'merchant': merchant, 'sampleRate': rate},
                **({'error': {'tag': 'OPERATION_FAILED', 'cause': {'httpStatus': status}}}
                   if kind == 'error' else {})})
        records.append({'ts': self.day + 'T12:00:01Z', 'kind': 'error', 'name': 'log.cap',
            'props': {'component': 'hooks', 'capBytes': 100}, 'error': {'tag': 'LOG_CAP'}})
        (directory / (self.day + '.ndjson')).write_text(''.join(json.dumps(row) + '\n' for row in records))
        result = toollog.rollup('orders', self.day)
        self.assertEqual(result['recordedRows'], 9)
        self.assertEqual(result['total'], 29)
        self.assertTrue(result['sampled'])
        self.assertEqual(result['countsByName'], {'track.poll': 28, 'log.cap': 1})
        self.assertEqual(result['logCaps'], [{'component': 'hooks', 'capBytes': 100,
                                              'ts': self.day + 'T12:00:01Z'}])
        self.assertEqual({(r['tag'], r['httpStatus'], r['merchant']): r['count'] for r in result['topErrors']},
            {('OPERATION_FAILED', 401, 'noon'): 2, ('OPERATION_FAILED', 500, 'amazon'): 1,
             ('OPERATION_FAILED', None, 'unknown'): 1, ('LOG_CAP', None, 'unknown'): 1})
        self.assertEqual(result['durationMsByName']['track.poll'], {'p50': 10, 'p95': 3000, 'max': 4000})
        self.assertEqual(result['durationsMs']['track.poll']['byMerchant'], {
            'noon': {'count': 23, 'p50': 10, 'p95': 1000, 'max': 2000},
            'careem': {'count': 2, 'p50': 25, 'p95': 25, 'max': 25},
            'amazon': {'count': 2, 'p50': 50, 'p95': 3000, 'max': 3000},
            'unknown': {'count': 1, 'p50': 4000, 'p95': 4000, 'max': 4000}})

    def test_format_privacy_modes_and_fail_open(self):
        os.chmod(self.tmp.name, 0o755)
        command = 'curl --password do-not-log-me --header token-secret https://private.invalid'
        toollog.hook('codex-cu', 'shell', 'denied', 'test.deny', 1.5, command)
        toollog.emit('test', 'event', 'test.input', props={'command': command, 'password': 'secret', 'count': 2},
                     error_tag='exception containing secret')
        rows = self.rows()
        self.assertEqual(rows[0]['props']['firstWord'], 'curl')
        self.assertEqual(rows[0]['props']['commandLength'], len(command))
        self.assertEqual(rows[0]['durationMs'], 1.5)
        self.assertRegex(rows[0]['ts'], r'Z$')
        self.assertNotIn('do-not-log-me', json.dumps(rows))
        self.assertNotIn('token-secret', json.dumps(rows))
        self.assertNotIn('private.invalid', json.dumps(rows))
        path = toollog.board_dir('agent-tools') / (self.day + '.ndjson')
        self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o600)
        self.assertEqual(stat.S_IMODE(path.parent.stat().st_mode), 0o700)
        self.assertEqual(stat.S_IMODE(Path(self.tmp.name).stat().st_mode), 0o755)
        with patch.object(os, 'open', side_effect=OSError('private secret')):
            toollog.emit('test', 'error', 'test.failed')
        toollog.emit(None, 'error', None, props='broken')
        self.assertEqual(len(self.rows()), 2)

    def test_retention_and_cap_keep_errors_once_across_process_writers(self):
        directory = toollog.board_dir('agent-tools')
        directory.mkdir(parents=True)
        old = (datetime.now(timezone.utc) - timedelta(days=31)).strftime('%Y-%m-%d')
        for name in (old + '.ndjson', 'rollup-' + old + '.json', '.cap-' + old, '.cap-hooks-' + old):
            (directory / name).touch()
        (directory / 'unrelated').touch()
        toollog.emit('test', 'event', 'test.start')
        self.assertFalse((directory / (old + '.ndjson')).exists())
        self.assertFalse((directory / ('rollup-' + old + '.json')).exists())
        self.assertTrue((directory / 'unrelated').exists())
        with patch.object(toollog, 'CAP_BYTES', 1):
            for _ in range(3):
                toollog.emit('test', 'event', 'test.dropped')
                toollog.emit('test', 'error', 'test.kept', error_tag='fixture.error')
        names = [r['name'] for r in self.rows()]
        self.assertEqual(names.count('log.cap'), 1)
        for row in self.rows():
            if row['name'] == 'log.cap': print('TOOLLOG_SAMPLE ' + json.dumps(row, separators=(',', ':')))
        self.assertEqual(names.count('test.kept'), 3)
        self.assertNotIn('test.dropped', names)

    def test_component_caps_keep_other_components_and_errors(self):
        toollog.emit('rcsim', 'perf', 'sim.start')
        with patch.object(toollog, 'HOOKS_CAP_BYTES', 1), patch.object(toollog, 'CAP_BYTES', 100_000):
            for _ in range(3):
                toollog.emit('hooks', 'perf', 'hook.dropped')
                toollog.emit('rcsim', 'perf', 'sim.kept')
                toollog.hook('codex', 'shell', 'denied', 'fixture.denied', 0)
        rows = self.rows()
        self.assertNotIn('hook.dropped', [r['name'] for r in rows])
        self.assertEqual(sum(r['name'] == 'sim.kept' for r in rows), 3)
        self.assertEqual(sum(r['kind'] == 'error' and r['name'] == 'hook.decision' for r in rows), 3)
        caps = [r for r in rows if r['name'] == 'log.cap']
        self.assertEqual([r['props'] for r in caps], [{'component': 'hooks', 'capBytes': 1}])
        with patch.object(toollog, 'HOOKS_CAP_BYTES', 1), patch.object(toollog, 'CAP_BYTES', 1):
            toollog.emit('rcsim', 'perf', 'sim.dropped')
            toollog.emit('hooks', 'error', 'hook.kept', props={'sampleRate': 16})
            toollog.emit('rcsim', 'error', 'sim.error')
        self.assertEqual([r['props']['component'] for r in self.rows() if r['name'] == 'log.cap'], ['hooks', 'all'])
        self.assertNotIn('sim.dropped', [r['name'] for r in self.rows()])
        self.assertEqual(self.rows()[-1]['name'], 'sim.error')
        self.assertEqual(toollog.rollup('agent-tools', self.day)['logCaps'][0]['component'], 'hooks')

    def test_slim_hook_sampling_and_weighted_roundtrip(self):
        for decision in ('allowed', 'rewritten'):
            with patch.object(toollog.random, 'random', side_effect=[0, 1 / toollog.HOOK_SAMPLE_RATE, .99]):
                for _ in range(3):
                    toollog.hook('codex', 'shell', decision, 'fixture', 2, ids={'threadId': 'native:codex:fixture'})
        with patch.object(toollog.random, 'random', return_value=.99):
            toollog.hook('codex', 'shell', 'denied', 'fixture', 4, ids={'threadId': 'native:codex:fixture'})
            toollog.hook('codex', 'shell', 'allowed', 'failure', 4, error_tag='fixture.error')
        rows = self.rows()
        self.assertEqual(len(rows), 4)
        for row in rows[:2]:
            self.assertEqual(row['durationMs'], 2)
            self.assertEqual(row['ids']['threadId'], 'native:codex:fixture')
            self.assertEqual(row['props']['sampleRate'], toollog.HOOK_SAMPLE_RATE)
            for key in ('cwdClass', 'matchedRoot', 'argv0Class'):
                self.assertNotIn(key, row['props'])
        self.assertEqual(rows[0]['props'].get('repeatCount', 1), 1)
        self.assertEqual(rows[1]['props']['repeatCount'], 4)
        for row in rows[2:]:
            self.assertIn('repeatCount', row['props'])
            self.assertEqual(row['props']['argv0Class'], 'none')
            self.assertNotIn('sampleRate', row['props'])
        result = toollog.rollup('agent-tools', self.day)
        self.assertEqual(result['total'], 2 * toollog.HOOK_SAMPLE_RATE + 2)
        self.assertEqual(result['recordedRows'], 4)
        self.assertTrue(result['sampled'])
        self.assertEqual(result['okCount'], 2 * toollog.HOOK_SAMPLE_RATE)
        self.assertEqual(result['failedCount'], 2)
        self.assertEqual(result['countsByKind'], {'perf': 2 * toollog.HOOK_SAMPLE_RATE, 'error': 2})
        self.assertEqual(result['durationMsByName']['hook.decision'], {'p50': 2, 'p95': 2, 'max': 4})
        self.assertEqual(result['topThreadsByRule']['fixture'], [{'threadId': 'native:codex:fixture', 'count': toollog.HOOK_SAMPLE_RATE + 1, 'denied': 1, 'rewritten': toollog.HOOK_SAMPLE_RATE, 'attributed': True, 'sampled': True}])
        self.assertEqual(result['repeatLoops'][0]['maxCountInHour'], toollog.HOOK_SAMPLE_RATE)
        self.assertEqual(result['repeatLoops'][0]['decision'], 'rewritten')
        self.assertTrue(result['repeatLoops'][0]['sampled'])
        self.assertEqual(result['logCaps'], [])

    def hook_rollup(self, rows, top_n=20):
        path = toollog.board_dir('agent-tools') / (self.day + '.ndjson')
        path.parent.mkdir(parents=True, exist_ok=True)
        base = {'ts': self.day + 'T12:00:00Z', 'name': 'hook.decision', 'kind': 'error',
                'ok': False, 'ids': {'threadId': 'native:codex:refusals'}}
        path.write_text(''.join(json.dumps({**base, **row}) + '\n' for row in rows))
        return toollog.rollup('agent-tools', self.day, top_n)

    def test_sampled_allowed_is_not_a_refusal(self):
        result = self.hook_rollup([{'kind': 'perf', 'ok': True,
            'props': {'rule': 'retry', 'decision': 'allowed', 'sampleRate': 128}}])
        self.assertEqual(result['topThreadsByRule'], {})
        self.assertEqual(result['repeatLoops'], [])
        self.assertEqual(result['unattributedByRule'], {})
        self.assertEqual(result['unrecognizedThreadIds'], 0)
        self.assertEqual((result['total'], result['okCount'], result['countsByName']),
                         (128, 128, {'hook.decision': 128}))

    def test_denied_loop_and_separate_rewrites(self):
        result = self.hook_rollup([{'props': {'rule': 'retry', 'decision': decision}}
                                  for decision in ['denied'] * 25 + ['rewritten'] * 15])
        self.assertEqual(result['topThreadsByRule']['retry'], [{
            'threadId': 'native:codex:refusals', 'count': 40, 'denied': 25,
            'rewritten': 15, 'attributed': True, 'sampled': False}])
        self.assertEqual(result['repeatLoops'], [{
            'threadId': 'native:codex:refusals', 'rule': 'retry', 'decision': 'denied',
            'maxCountInHour': 25, 'repeatLoop': True, 'sampled': False}])
        split = self.hook_rollup([{'props': {'rule': 'retry', 'decision': decision}}
                                 for decision in ['denied'] * 15 + ['rewritten'] * 15])
        self.assertEqual(split['repeatLoops'], [])

    def test_unknown_refusals_visible_without_loops_or_top_limit(self):
        result = self.hook_rollup([{'ids': {'threadId': 'unknown:codex'},
                                   'props': {'rule': 'rootwide-search', 'decision': 'denied'}}] * 25, top_n=0)
        self.assertEqual(result['unattributedByRule']['rootwide-search'], [{
            'threadId': 'unknown:codex', 'count': 25, 'denied': 25, 'rewritten': 0,
            'attributed': False, 'sampled': False}])
        self.assertEqual(result['repeatLoops'], [])
        self.assertEqual(result['topThreadsByRule'], {})

    def test_ranking_thread_id_shapes(self):
        uuid = '393a4dd3-d1ca-468e-9367-7c1f1ba1bf32'
        cases = [(t, True) for t in [uuid, 'mcp:' + uuid, 'mcp:' + uuid + ':fork', 'ardud-control:thread:' + uuid,
            'ardud-control:thread:nightly-report', 'ardud-control:thread:request%3A2026%2F11',
            'ardud-opencode-import:thread:ses_e288ff742ffeQTYTEXLuPR3WIO',
            'import:codex:' + uuid, 'import:claudeAgent:session-id',
            'thread:mcp:namespace:request%3Akey:0',
            'thread:delegated-task:command%3Amcp%3Adelegate-task%3Arequest',
            'thread:project:7273c274-25cd-4aa6-8546-03e45da95f0e:' + uuid,
            'thread:project:ardud-opencode-import%3Aproject%3A%2FVolumes%2FExternalSSD%2Ft3code-fork:' + uuid,
            'native:claude:' + uuid, 'native:opencode:ses_e288ff742ffeQTYTEXLuPR3WIO']]
        cases += [(t, False) for t in ['child', 'parent', 'leaf', 'new-fixture', '',
            'native:', 'thread:project:fixture:child', 'mcp:fixture', 'sha256:abcd',
            uuid + '-suffix', 'prefix-' + uuid, 'mcp:' + uuid + ':other', 'ardud-control:thread:',
            'ardud-opencode-import:thread:', 'ardud-opencode-import:thread:ses_',
            'import::session', 'import:codex:', 'thread:mcp:namespace:key:child',
            'thread:delegated-task:']]
        for thread, recognized in cases:
            with self.subTest(thread=thread):
                result = self.hook_rollup([{'ids': {'threadId': thread},
                    'props': {'rule': 'retry', 'decision': 'denied'}}] * 25)
                self.assertEqual(result['unrecognizedThreadIds'], 0 if recognized else 25)
                self.assertFalse(result['unrecognizedThreadIdsSampled'])
                self.assertEqual(bool(result['topThreadsByRule']), recognized)
                self.assertEqual(bool(result['repeatLoops']), recognized)

    def test_legacy_decision_fallback_only_when_missing(self):
        cases = [({'kind': 'error'}, {}, True), ({'kind': 'perf', 'ok': False}, {}, True),
                 ({'kind': 'perf', 'ok': True}, {}, False),
                 ({'kind': 'error'}, {'decision': 'allowed'}, False),
                 ({'kind': 'error'}, {'decision': None}, False),
                 ({'kind': 'error'}, {'decision': 'other'}, False),
                 ({'kind': 'error'}, {'decision': ['denied']}, False)]
        for fields, props, expected in cases:
            with self.subTest(fields=fields, props=props):
                result = self.hook_rollup([{**fields, 'props': {'rule': 'retry', **props}}])
                self.assertEqual(bool(result['topThreadsByRule']), expected)

    def test_unexpected_sampled_refusals_are_labeled(self):
        for kind in ['error', 'perf']:
            for thread, block in [('native:codex:refusals', 'topThreadsByRule'),
                                  ('unknown:codex', 'unattributedByRule')]:
                with self.subTest(kind=kind, thread=thread):
                    result = self.hook_rollup([{'kind': kind, 'ids': {'threadId': thread},
                        'props': {'rule': 'retry', 'decision': 'denied', 'sampleRate': 128}}])
                    entry = result[block]['retry'][0]
                    self.assertEqual((entry['count'], entry['denied'], entry['sampled']), (128, 128, True))
                    self.assertEqual(result['total'], 1 if kind == 'error' else 128)

    def test_unrecognized_refusal_sample_rate_shapes(self):
        cases = [(None, 1), (True, 1), (False, 1), (0, 1), (-1, 1),
                 (1.5, 1), ('128', 1), (2**53, 1), (1, 1), (128, 128),
                 (2**53 - 1, 2**53 - 1)]
        for rate, weight in cases:
            with self.subTest(rate=rate):
                result = self.hook_rollup([{'ids': {'threadId': 'fixture'},
                    'props': {'rule': 'retry', 'decision': 'denied', 'sampleRate': rate}}])
                self.assertEqual(result['unrecognizedThreadIds'], weight)
                self.assertEqual(result['unrecognizedThreadIdsSampled'], weight > 1)
                self.assertEqual((result['total'], result['sampled']), (1, False))
                self.assertEqual(result['topThreadsByRule'], {})
                self.assertEqual(result['repeatLoops'], [])

    def test_rollup_legacy_caps_and_sample_rate_shapes(self):
        path = toollog.board_dir('agent-tools') / (self.day + '.ndjson')
        path.parent.mkdir(parents=True)
        rows = [{'kind': 'error', 'name': 'log.cap'},
                {'kind': 'error', 'name': 'fixture.error', 'props': {'sampleRate': 128}}]
        for rate in [None, True, False, 0, -1, 1.5, '128', 2**53, 1, 128]:
            rows.append({'kind': 'perf', 'name': 'fixture.run', 'props': {'sampleRate': rate}})
        path.write_text(''.join(json.dumps(row) + '\n' for row in rows))
        result = toollog.rollup('agent-tools', self.day)
        self.assertEqual(result['total'], 2 + 9 + 128)
        self.assertEqual(result['recordedRows'], 12)
        self.assertEqual(result['logCaps'], [{'component': 'all', 'capBytes': None, 'ts': None}])

    def test_hook_prop_defaults_and_nondefaults(self):
        for decision in ('allowed', 'rewritten', 'denied'):
            for key, defaults, nondefault in [
                    ('argv0Class', ['none', '', None], 'search'),
                    ('matchedRoot', ['none', '', None], 'filesystem'),
                    ('repeatCount', [0, 1, None], 2),
                    ('firstWord', ['', None], 'rg'),
                    ('commandLength', [0, None], 10),
                    ('cwdClass', ['other', '', None], 'worktree')]:
                for value in defaults + [nondefault]:
                    with self.subTest(decision=decision, key=key, value=value):
                        props = {'harness': 'codex', 'guard': 'shell', 'decision': decision, 'rule': 'fixture', key: value}
                        result = toollog.hook_props(props)
                        if decision == 'denied' or value == nondefault:
                            self.assertEqual(result[key], value)
                        else:
                            self.assertNotIn(key, result)
                        self.assertEqual({k: result[k] for k in ('harness', 'guard', 'decision', 'rule')},
                                         {k: props[k] for k in ('harness', 'guard', 'decision', 'rule')})

    def test_reader_and_rollup_two_boards(self):
        for board in ('agent-tools', 'orders'):
            for i in range(1, 21):
                toollog.emit('fixture', 'perf' if i < 20 else 'error', 'fixture.run', board=board,
                             duration_ms=i, ok=i < 20, ids={'sessionId': 'fixture-session'},
                             error_tag='fixture.failure' if i == 20 else None)
            path = toollog.board_dir(board) / (self.day + '.ndjson')
            with path.open('a') as dest:
                dest.write('partial invalid line\n')
            out = io.StringIO()
            with contextlib.redirect_stdout(out):
                self.assertEqual(toollog.main(['read', '--board', board, '--day', self.day, '--kind', 'error', '--name', 'fixture.run', '--limit', '1']), 0)
            self.assertEqual(len(out.getvalue().splitlines()), 1)
            with contextlib.redirect_stdout(io.StringIO()):
                self.assertEqual(toollog.main(['rollup', '--board', board, '--day', self.day]), 0)
            result = json.loads((toollog.board_dir(board) / ('rollup-' + self.day + '.json')).read_text())
            self.assertEqual(result['total'], 20)
            self.assertEqual(result['durationMsByName']['fixture.run'], {'p50': 10, 'p95': 19, 'max': 20})
            self.assertEqual(result['okRate'], .95)
            self.assertEqual(result['errorRate'], .05)
            self.assertEqual(result['topErrorTags'][0]['sampleId'], {'sessionId': 'fixture-session'})
        for board, day in [('../escape', self.day), ('orders', '../../escape'), ('Orders', self.day)]:
            with self.assertRaises(ValueError):
                list(toollog.read(board, day))

    def test_rollup_groups_error_tag_and_class(self):
        directory = toollog.board_dir('imessage')
        directory.mkdir(parents=True)
        path = directory / (self.day + '.ndjson')
        records = [{'kind': 'error', 'name': 'bridge.catch',
                    'error': {'tag': 'secrets.catch9', **({'name': name} if name else {})}}
                   for name in ('Error', 'Error', 'TypeError', None)]
        path.write_text(''.join(json.dumps(row) + '\n' for row in records))
        result = toollog.rollup('imessage', self.day)['topErrorTags']
        self.assertEqual([(row['tag'], row['name'], row['count']) for row in result], [
            ('secrets.catch9', 'Error', 2), ('secrets.catch9', 'TypeError', 1),
            ('secrets.catch9', 'UnknownError', 1)])
        self.assertEqual([row['sampleId']['line'] for row in result], [1, 3, 4])

    def test_imessage_rollup_reduces_untrusted_class_name_shapes(self):
        directory = toollog.board_dir('imessage')
        directory.mkdir(parents=True)
        cases = [('PRIVATE_FORM_VALUE', 'UnknownError'), ('PRIVATEError', 'UnknownError'),
                 ('PRIVATE_PHONE_971501234567', 'UnknownError'), ('https://private/?token=PRIVATE', 'UnknownError'),
                 ('/private/attachment.png', 'UnknownError'), (42, 'UnknownError'),
                 (None, 'UnknownError'), ('TypeError', 'TypeError'), ('ControlError', 'ControlError')]
        for name, expected in cases:
            with self.subTest(name=name):
                (directory / (self.day + '.ndjson')).write_text(json.dumps({
                    'kind': 'error', 'name': 'bridge.catch', 'error': {'tag': 'fixture.catch1', 'name': name}}) + '\n')
                result = toollog.rollup('imessage', self.day)['topErrorTags']
                self.assertEqual(result[0]['name'], expected)
                self.assertNotIn('PRIVATE', json.dumps(result))

    def test_rollup_prefers_available_error_ids(self):
        toollog.emit('fixture', 'error', 'fixture.error', error_tag='fixture.failure')
        toollog.emit('fixture', 'error', 'fixture.error', error_tag='fixture.failure', ids={'sessionId': 'available-id'})
        self.assertEqual(toollog.rollup('agent-tools', self.day)['topErrorTags'][0]['sampleId'], {'sessionId': 'available-id'})

    def test_rollup_sample_reference_shapes(self):
        cases = [
            ('ids-first', [{'sessionId': 'first'}, {}], 0, {'sessionId': 'first'}),
            ('ids-later', [{}, {'sessionId': 'later'}], 0, {'sessionId': 'later'}),
            ('ids-absent', [None], 0, None),
            ('ids-empty', [{}], 0, None),
            ('ids-all-empty', [None, {}], 0, None),
            ('invalid-prefix', [None], 1, None),
        ]
        for board, ids, prefix_lines, expected_ids in cases:
            with self.subTest(case=board):
                if prefix_lines:
                    directory = toollog.board_dir(board)
                    directory.mkdir(parents=True)
                    (directory / (self.day + '.ndjson')).write_text('invalid fixture line\n')
                for identity in ids:
                    toollog.emit('harness-cli', 'error', 'canary.run', board=board,
                                 error_tag='canary.runtime', ids=identity)
                result = toollog.rollup(board, self.day)['topErrorTags'][0]
                self.assertEqual(result['count'], len(ids))
                if expected_ids:
                    self.assertEqual(result['sampleId'], expected_ids)
                else:
                    sample = result['sampleId']
                    self.assertEqual(sample['file'], self.day + '.ndjson')
                    self.assertEqual(sample['line'], prefix_lines + 1)
                    path = toollog.board_dir(board) / sample['file']
                    record = json.loads(path.read_text().splitlines()[sample['line'] - 1])
                    self.assertEqual(sample['ts'], record['ts'])
                    self.assertEqual(record['error']['tag'], result['tag'])

    def test_hook_errors_keep_ids_in_rollups(self):
        native = 'thread:project:fixture%2Frepo:thread-id'
        toollog.hook('codex', 'shell', 'denied', 'fixture.denied', 1, ids={'threadId': native})
        self.assertEqual(toollog.rollup('agent-tools', self.day)['topErrorTags'][0]['sampleId'], {'threadId': native})

    def test_added_hook_logging_under_two_ms(self):
        # Warm-up includes retention, then measure the actual per-call write cost.
        toollog.hook('codex', 'shell', 'allowed', 'no-policy', 0, 'git status')
        started = time.perf_counter()
        for _ in range(500):
            toollog.hook('codex', 'shell', 'allowed', 'no-policy', 0, 'git status')
        ms = (time.perf_counter() - started) * 1000 / 500
        print(f'toollog added hook cost: {ms:.3f} ms/call')
        self.assertLess(ms, 2)
        self.assertEqual(len(self.rows()), 501)


if __name__ == '__main__':
    unittest.main()


class AttributionTests(unittest.TestCase):
    def test_classes_and_private_identity(self):
        with tempfile.TemporaryDirectory() as temp, patch.dict(os.environ, {'TOOLLOG_ROOT': temp + '/logs',
                'ROBOB_THREAD_ID': '', 'ROBOB_CARD_NUMBER': ''}):
            root = Path(temp)
            (root / 'repo/.git').mkdir(parents=True)
            (root / 'wt').mkdir()
            (root / 'wt/.git').write_text('gitdir: private-path')
            for cwd, expected in [(str(root/'repo'), 'repo-root'), (str(root/'wt'), 'worktree'),
                                  (str(Path.home()), 'home'), (temp, 'other')]:
                self.assertEqual(toollog.cwd_class(cwd), expected)
            for path, expected in [('/', 'filesystem'), ('/Users/ardud', 'home'),
                    ('/Volumes/ExternalSSD', 'external'), ('/Volumes/ExternalSSD/board-wt', 'board-worktrees'),
                    ('/private-fixture', 'other'), (None, 'none')]:
                self.assertEqual(toollog.matched_root(path), expected)
            for command, expected in [('rg private-fixture /', 'search'), ('/private/bin/python3 script', 'interpreter'),
                    ('npm install secret', 'package-manager'), ('go test ./...', 'build'),
                    ('git status', 'git'), ('secret-fixture --token', 'other')]:
                self.assertEqual(toollog.command_props(command)['argv0Class'], expected)
            toollog.hook('codex', 'shell', 'denied', 'privacy', 0, ids={'threadId': '/private-fixture',
                         'sessionId': '/secret-session', 'cardNumber': 'secret'}, cwd='/private-fixture', matched='/private-fixture')
            row = next(toollog.read('agent-tools', datetime.now(timezone.utc).strftime('%Y-%m-%d')))
            self.assertNotIn('/private-fixture', json.dumps(row))
            self.assertNotIn('/secret-session', json.dumps(row))
            self.assertNotIn('cardNumber', row['ids'])

    def test_repeats_survive_processes_and_expire(self):
        import subprocess
        with tempfile.TemporaryDirectory() as temp, patch.dict(os.environ, {'TOOLLOG_ROOT': temp + '/logs',
                'ROBOB_THREAD_ID': '', 'ROBOB_CARD_NUMBER': ''}):
            script = "import sys; sys.path.insert(0, sys.argv[1]); import toollog; toollog.hook('claude','shell','denied','retry',0,'rg private-fixture /',ids={'sessionId':sys.argv[2]})"
            for session in ['same', 'same', 'other']:
                subprocess.run([sys.executable, '-I', '-c', script, str(Path(toollog.__file__).parent), session], check=True)
            day = datetime.now(timezone.utc).strftime('%Y-%m-%d')
            self.assertEqual([r['props']['repeatCount'] for r in toollog.read('agent-tools', day)], [1, 2, 1])
            with patch.object(toollog.time, 'time', return_value=time.time() + 61):
                toollog.hook('claude','shell','denied','retry',0,'rg private-fixture /',ids={'sessionId':'same'})
            self.assertEqual(list(toollog.read('agent-tools', day))[-1]['props']['repeatCount'], 1)

    def test_rollup_sliding_loop_and_top_threads(self):
        with tempfile.TemporaryDirectory() as temp, patch.dict(os.environ, {'TOOLLOG_ROOT':temp}):
            day = '2026-11-13'
            directory = toollog.board_dir('agent-tools')
            directory.mkdir()
            rows = []
            base = datetime(2026, 11, 13, 0, 59, tzinfo=timezone.utc)
            for thread, count, spacing in [('native:codex:loop',21,10), ('native:codex:quiet',20,10), ('native:codex:spread',21,181)]:
                for i in range(count):
                    rows.append({'ts':(base+timedelta(seconds=i*spacing)).isoformat(), 'name':'hook.decision',
                        'kind':'error', 'ids':{'threadId':thread}, 'props':{'rule':'rootwide-search','decision':'denied'}})
            rows.append({'name':'other.event', 'ids':{'threadId':'loop'}, 'props':{'rule':'other'}})
            (directory/(day+'.ndjson')).write_text('\n'.join(json.dumps(r) for r in reversed(rows))+'\n')
            result = toollog.rollup('agent-tools',day,2)
            self.assertEqual(result['topThreadsByRule']['rootwide-search'], [{'threadId':t,'count':21,'denied':21,'rewritten':0,'attributed':True,'sampled':False} for t in ['native:codex:loop','native:codex:spread']])
            self.assertEqual(result['repeatLoops'], [{'threadId':'native:codex:loop','rule':'rootwide-search','decision':'denied','maxCountInHour':21,'repeatLoop':True,'sampled':False}])

    def test_attributed_hook_under_point_one_ms(self):
        with tempfile.TemporaryDirectory() as temp, patch.dict(os.environ, {'TOOLLOG_ROOT':temp}):
            def call():
                toollog.hook('claude','shell','denied','retry',0,'rg private-fixture /',ids={'sessionId':'perf-fixture'},cwd=temp,matched='/')
            call()
            started = time.perf_counter()
            for _ in range(500):
                call()
            ms = (time.perf_counter()-started)*1000/500
            print(f'attributed hook cost: {ms:.3f} ms/call')
            self.assertLess(ms, .1)

    def test_repeat_window_crosses_utc_midnight(self):
        with tempfile.TemporaryDirectory() as temp, patch.dict(os.environ, {'TOOLLOG_ROOT':temp}):
            ids={'threadId':'fixture', 'sessionId':'midnight-session'}
            base=datetime(2026,11,13,23,59,50,tzinfo=timezone.utc).timestamp()
            for offset, expected in [(0,1),(20,2),(81,1)]:
                with patch.object(toollog.time,'time',return_value=base+offset):
                    self.assertEqual(toollog._repeat_count('codex',ids,'shell','retry','rg'),expected)

    def test_midnight_sampled_loop_estimates(self):
        cases = [
            ('previous-sampled', 128, 1, -10, 'native:codex:fixture', 129, True),
            ('current-sampled', 1, 128, -10, 'native:codex:fixture', 129, True),
            ('both-unsampled', 1, 1, -10, 'native:codex:fixture', 2, False),
            ('outside-window', 128, 1, -3601, 'native:codex:fixture', 1, False),
            ('unrelated-thread', 128, 1, -10, 'native:codex:other', 1, False),
        ]
        for label, previous_rate, current_rate, offset, thread, peak, sampled in cases:
            with self.subTest(case=label), tempfile.TemporaryDirectory() as temp, patch.dict(os.environ, {'TOOLLOG_ROOT': temp}):
                directory = toollog.board_dir('agent-tools')
                directory.mkdir()
                base = datetime(2026, 11, 14, tzinfo=timezone.utc)
                for at, rate, identity in [(base + timedelta(seconds=offset), previous_rate, thread),
                                           (base, current_rate, 'native:codex:fixture')]:
                    row = {'ts': at.isoformat(), 'name': 'hook.decision', 'kind': 'perf',
                           'ids': {'threadId': identity}, 'props': {'rule': 'fixture', 'sampleRate': rate, 'decision': 'rewritten'}}
                    (directory / (at.strftime('%Y-%m-%d') + '.ndjson')).write_text(json.dumps(row) + '\n')
                result = toollog.rollup('agent-tools', '2026-11-14')
                self.assertEqual(result['sampled'], sampled)
                self.assertEqual(result['total'], current_rate)
                self.assertEqual(result['repeatLoops'][0]['maxCountInHour'] if peak > 20 else len(result['repeatLoops']),
                                 peak if peak > 20 else 0)

    def test_loop_window_boundaries_and_utc_day_attribution(self):
        cases=[('same-day',20,10,False),('midnight',21,10,True),('hour-edge',21,180,True),
               ('over-hour',21,181,False)]
        for label, count, spacing, expected in cases:
            with self.subTest(case=label), tempfile.TemporaryDirectory() as temp, patch.dict(os.environ,{'TOOLLOG_ROOT':temp}):
                directory=toollog.board_dir('agent-tools')
                directory.mkdir()
                base=datetime(2026,11,13,23,59,tzinfo=timezone.utc)
                for i in range(count):
                    at=base+timedelta(seconds=i*spacing)
                    row={'ts':at.isoformat(),'name':'hook.decision','ids':{'threadId':'native:codex:loop'},'props':{'rule':'retry','decision':'denied'}}
                    with (directory/(at.strftime('%Y-%m-%d')+'.ndjson')).open('a') as dest:
                        dest.write(json.dumps(row)+'\n')
                result=toollog.rollup('agent-tools','2026-11-14')
                self.assertEqual(bool(result['repeatLoops']),expected)
                current_count=sum(1 for i in range(count) if (base+timedelta(seconds=i*spacing)).day==14)
                self.assertEqual(result['total'],current_count)
                self.assertEqual(result['topThreadsByRule']['retry'][0]['count'],current_count)
                self.assertEqual(toollog.rollup('agent-tools','2026-11-13')['repeatLoops'],[])

import json
from pathlib import Path
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from rollup import rollup


class ProxyRollupTests(unittest.TestCase):
    def test_dimensions_latency_ttfb_and_abort_rate(self):
        with tempfile.TemporaryDirectory() as tmp:
            rows = []
            for model, route, stream in [('claude/haiku', '/v1/messages', False), ('claude/haiku', '/v1/messages', True), ('cx/image', '/v1/images/generations', False), ('claude/haiku', '/v1/chat/completions', False)]:
                for n in range(1, 101):
                    aborted = n % 10 == 0
                    rows.append(dict(tool='9router', component='proxy', kind='error' if aborted else 'perf', name='proxy.request', durationMs=n * 10, ok=not aborted, ids={'req': f'{n:08x}'}, props=dict(model=model, route=route, stream=stream, ttfbMs=n, client='aborted' if aborted else 'completed'), **({'error': {'tag': 'client_abort'}} if aborted else {})))
            (Path(tmp) / '2026-11-13.ndjson').write_text('\n'.join(map(json.dumps, rows)) + '\n')
            result = rollup('2026-11-13', tmp)
            self.assertEqual(len(result['proxy']), 4)
            for group in result['proxy']:
                self.assertEqual(group['durationMs'], dict(p50=500, p95=950, max=1000))
                self.assertEqual(group['ttfbMs'], dict(p50=50, p95=95, max=100))
                self.assertEqual(group['clientAbortRate'], .1)
                self.assertEqual(group['topErrors'], [dict(tag='client_abort', count=10, sampleReq='0000000a')])
            self.assertEqual(result['topErrors'][0]['sampleIds'], {'req': '0000000a'})

    def test_no_first_byte_is_not_zero(self):
        with tempfile.TemporaryDirectory() as tmp:
            row = dict(tool='9router', kind='error', name='proxy.request', props=dict(model='a', route='/v1/messages', stream=False, client='aborted'))
            (Path(tmp) / '2026-11-13.ndjson').write_text(json.dumps(row) + '\n')
            result = rollup('2026-11-13', tmp)
            self.assertIsNone(result['proxy'][0]['ttfbMs'])
            self.assertIsNone(result['proxy'][0]['durationMs'])
            self.assertEqual(result['proxy'][0]['clientAbortRate'], 1)

    def test_attempts_and_identity_across_old_and_new_rows(self):
        with tempfile.TemporaryDirectory() as tmp:
            props = [
                dict(model='a', client='codex', clientState='aborted', keyId='0123456789abcdef', status=499, attempts=3, ttfbMs=20),
                dict(model='a', client='codex', clientState='completed', keyId='0123456789abcdef', status=200, attempts=1, ttfbMs=1),
                dict(model='a', client='curl', status=499, keyId='none', attempts=1),
                dict(model='b', client='aborted', attempts=6, ttfbMs=100),
                dict(model='b', client='other', status=499, keyId={'bad': 1}, attempts=True, ttfbMs=-1),
            ]
            rows = [dict(tool='9router', kind='error', name='proxy.request', props=dict(route='/v1/responses', stream=True, **p)) for p in props]
            (Path(tmp) / '2026-11-15.ndjson').write_text('\n'.join(map(json.dumps, rows)))
            result = rollup('2026-11-15', tmp)['proxySummary']
            self.assertEqual(result['byModel'], [dict(model='a', count=3, aborted=2, clientAbortRate=2/3), dict(model='b', count=2, aborted=2, clientAbortRate=1)])
            self.assertEqual(result['abortsByClient'], dict(codex=1, curl=1, unknown=1, other=1))
            self.assertEqual(result['abortsByKeyId'], {'0123456789abcdef': 1, 'none': 1, 'unknown': 2})
            self.assertEqual(result['attemptsHistogram'], {'1': 2, '3': 1, '6': 1})
            self.assertEqual(result['abortTtfbMs'], dict(p50=20, p95=100, max=100))

    def test_caller_identity_counts_and_abort_denominators(self):
        fixture = Path(__file__).parent / 'fixtures/caller-identity.json'
        with tempfile.TemporaryDirectory() as tmp:
            rows = [dict(tool='9router', kind='perf', name='proxy.request',
                         props=dict(model='a', route='/v1/responses', stream=True, **props))
                    for props in json.loads(fixture.read_text())]
            (Path(tmp) / '2026-11-17.ndjson').write_text('\n'.join(map(json.dumps, rows)))
            result = rollup('2026-11-17', tmp)['proxySummary']
            def group(dimension, value, count, aborted):
                return dict(**{dimension: value}, count=count, aborted=aborted, clientAbortRate=aborted/count)
            self.assertEqual(result['byKeyId'], [
                group('keyId', '0123456789abcdef', 2, 1),
                group('keyId', 'lookup_failed', 2, 1),
                group('keyId', 'none', 1, 0),
                group('keyId', 'unknown', 2, 2),
                group('keyId', 'unreg:0123456789ab', 2, 1),
                group('keyId', 'unreg:abcdef012345', 3, 1),
            ])
            self.assertEqual(result['byClient'], [
                group('client', 'ai-sdk', 1, 0),
                group('client', 'claude-code', 2, 1),
                group('client', 'codex', 2, 1),
                group('client', 'opencode', 2, 1),
                group('client', 'other', 4, 2),
                group('client', 'unknown', 1, 1),
            ])
            self.assertEqual(result['otherByUaProduct'], [
                group('uaProduct', '', 2, 1), group('uaProduct', 'weird-agent', 2, 1),
            ])
            self.assertEqual(result['unregisteredRequests'], 5)
            self.assertEqual(result['distinctUnregisteredKeys'], 2)
            self.assertEqual(result['lookupFailedRequests'], 2)
            self.assertNotIn('RAW_KEY_CANARY_65', json.dumps(result))
            self.assertEqual(result['abortsByKeyId']['lookup_failed'], 1)
            self.assertEqual(result['abortsByClient']['opencode'], 1)

    def test_invalid_caller_dimensions_never_become_rollup_labels(self):
        key_forms = [None, {}, [], 'unreg:short', 'unreg:0123456789ABC', 'unreg:0123456789ab\n', 'raw-key']
        product_forms = [None, {}, [], 'odd space', 'a'*25, 'UPPER', 'trailing\n']
        with tempfile.TemporaryDirectory() as tmp:
            rows = [dict(tool='9router', kind='error', name='proxy.request',
                         props=dict(model='a', route='/v1/responses', stream=False, status=499,
                                    client='other', keyId=key_id, uaProduct=product))
                    for key_id, product in zip(key_forms, product_forms)]
            rows.append(dict(tool='9router', kind='perf', name='proxy.request',
                             props=dict(model='a', route='/v1/responses', stream=False, client=['bad'])))
            (Path(tmp) / '2026-11-17.ndjson').write_text('\n'.join(map(json.dumps, rows)))
            result = rollup('2026-11-17', tmp)
            self.assertEqual(result['malformed'], 0)
            self.assertEqual(result['proxySummary']['byKeyId'], [
                dict(keyId='unknown', count=8, aborted=7, clientAbortRate=7/8),
            ])
            self.assertEqual(result['proxySummary']['otherByUaProduct'], [
                dict(uaProduct='', count=7, aborted=7, clientAbortRate=1),
            ])


if __name__ == '__main__':
    unittest.main()

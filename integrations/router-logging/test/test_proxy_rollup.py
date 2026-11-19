import json
from pathlib import Path
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from rollup import rollup


class ProxyRollupTests(unittest.TestCase):
    def session_summary(self, rows):
        with tempfile.TemporaryDirectory() as tmp:
            events = [dict(row, tool='9router', kind='perf', name='proxy.request',
                           props=dict(route='/v1/responses', stream=True, **row['props']))
                      for row in rows]
            (Path(tmp) / '2026-11-19.ndjson').write_text('\n'.join(map(json.dumps, events)))
            return rollup('2026-11-19', tmp)['proxySummary']

    def test_sessions_count_all_requests_but_concentration_uses_all_aborts(self):
        rows = json.loads((Path(__file__).parent / 'fixtures/session-identity.json').read_text())
        result = self.session_summary(rows)
        self.assertEqual(result['distinctSessions'], 3)
        self.assertEqual(result['sessionsWithAborts'], 2)
        self.assertEqual(result['sessionSrcCounts'], dict(hdr_session=2, hdr_conversation=1, hdr_claude=1,
                                                         body_cache_key=1, none=1, unknown=1))
        self.assertEqual(result['abortsBySession'], [
            dict(sessionId='s:000000000001', client='t3', uaProduct='t3', model='codex/sol', count=3,
                 aborted=2, clientAbortRate=2/3, firstTs='2026-11-19T01:00:00.000Z', lastTs='2026-11-19T04:00:00.000Z'),
            dict(sessionId='s:000000000002', client='claude-code', uaProduct='', model='claude/opus', count=1,
                 aborted=1, clientAbortRate=1, firstTs='2026-11-19T02:00:00.000Z', lastTs='2026-11-19T02:00:00.000Z'),
        ])
        self.assertEqual(result['abortConcentration'], dict(top1=2/5, top5=3/5, top20=3/5))
        self.assertEqual(result['abortsByClient']['t3'], 2)

    def test_session_top_twenty_order_and_ties_are_stable(self):
        rows = []
        for n in range(1, 23):
            for _ in range(n):
                rows.append(dict(props=dict(model='a', client='t3', sessionId=f's:{n:012x}', status=499)))
        # Same abort count as session 22; lexical id breaks the tie.
        rows.extend(dict(props=dict(model='b', sessionId='s:000000000000', status=499)) for _ in range(22))
        result = self.session_summary(list(reversed(rows)))
        self.assertEqual(result['distinctSessions'], 23)
        self.assertEqual(result['sessionsWithAborts'], 23)
        self.assertEqual([r['sessionId'] for r in result['abortsBySession']],
                         ['s:000000000000'] + [f's:{n:012x}' for n in range(22, 3, -1)])
        total = sum(range(1, 23)) + 22
        self.assertEqual(result['abortConcentration'], dict(top1=22/total, top5=(22+22+21+20+19)/total,
                                                          top20=(total-1-2-3)/total))
        self.assertIsNone(result['abortsBySession'][0]['firstTs'])

    def test_session_labels_and_sources_reject_raw_or_invalid_values(self):
        ids = [None, {}, [], 'RAW_SESSION_CANARY_83', 's:short', 's:0123456789AB', 's:0123456789ab\n', 'none']
        rows = [dict(props=dict(model='a', status=499, sessionId=value, sessionSrc={'raw': 1})) for value in ids]
        result = self.session_summary(rows)
        self.assertEqual(result['distinctSessions'], 0)
        self.assertEqual(result['sessionsWithAborts'], 0)
        self.assertEqual(result['abortsBySession'], [])
        self.assertEqual(result['sessionSrcCounts'], dict(unknown=8))
        self.assertEqual(result['abortConcentration'], dict(top1=0, top5=0, top20=0))
        self.assertNotIn('RAW_SESSION_CANARY_83', json.dumps(result))

    def test_session_no_aborts_and_timestamp_normalization(self):
        rows = [dict(ts=stamp, props=dict(model='b', client='t3', uaProduct='t3', status=200,
                                         sessionId='s:000000000001', sessionSrc='hdr_session'))
                for stamp in ['2026-11-19T04:00:00+04:00', 'bad', None, '2026-11-19T10:00:00Z']]
        result = self.session_summary(rows)
        self.assertEqual(result['distinctSessions'], 1)
        self.assertEqual(result['sessionsWithAborts'], 0)
        self.assertEqual(result['abortConcentration'], dict(top1=None, top5=None, top20=None))
        rows.append(dict(ts='2026-11-19T01:00:00Z', props=dict(model='b', status=499, sessionId='s:000000000001')))
        group = self.session_summary(rows)['abortsBySession'][0]
        self.assertEqual(group['count'], 5)
        self.assertEqual(group['firstTs'], '2026-11-19T00:00:00.000Z')
        self.assertEqual(group['lastTs'], '2026-11-19T10:00:00.000Z')
        self.assertEqual(self.session_summary([])['abortConcentration'], dict(top1=None, top5=None, top20=None))

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

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


if __name__ == '__main__':
    unittest.main()

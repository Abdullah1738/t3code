import datetime as dt
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import append_cursor
from rejected_rollup import INTERVALS
from rollup import rollup, AGGREGATE_VERSION


DAY = '2026-11-22'
NOW = dt.datetime(2026, 11, 23, tzinfo=dt.timezone.utc)
KEY = 'unreg:be8d89b32fc9'
MODEL = 'gemini/gemini-2.5-flash-lite'


def rejection(ts=DAY + 'T10:00:00Z', **props):
    return dict(tool='9router', component='proxy', name='proxy.request', kind='error', ok=False,
                ts=ts, error=dict(tag='http_404_no_credentials'),
                props=dict(model=MODEL, route='/v1beta/models/gemini-2.5-flash-lite:streamGenerateContent',
                           stream=True, phase='pre_upstream', status=404, attempts=0,
                           keyId=KEY, client='python', **props))


def payload(rows):
    return ''.join(json.dumps(row) + '\n' for row in rows)


class RejectedRollupTests(unittest.TestCase):
    def summarize(self, rows):
        with tempfile.TemporaryDirectory() as tmp:
            (Path(tmp) / (DAY + '.ndjson')).write_text(payload(rows))
            return rollup(DAY, tmp, NOW)

    def test_split_rates_preserve_legacy_rates_and_shared_key_success(self):
        success = rejection()
        success.update(kind='perf', ok=True)
        success.pop('error')
        success['props'].update(status=200, phase='upstream', attempts=1)
        upstream = rejection()
        upstream['props'].update(phase='upstream', status=502, attempts=1)
        upstream['error']['tag'] = 'http_502'
        rows = [rejection(), rejection(), success, upstream,
                dict(tool='9router', kind='event', name='supervisor.start')]
        result = self.summarize(rows)
        self.assertEqual(result['total'], 5)
        self.assertEqual(result['countsByKind'], dict(error=3, perf=1, event=1))
        self.assertEqual(result['okRate'], 1/4)
        self.assertEqual(result['errorRate'], 3/5)
        self.assertEqual(result['failedRate'], 3/4)
        self.assertEqual(result['errorRateExcludingNoCredentials'], 1/3)
        self.assertEqual(result['failedRateExcludingNoCredentials'], 1/2)
        self.assertEqual(result['rejectedNoCredentials']['count'], 2)
        self.assertEqual(result['proxySummary']['byKeyId'][0]['count'], 4)
        self.assertEqual(result['topErrors'][0]['count'], 2)

    def test_exact_rejection_class_and_normalized_caller_dimensions(self):
        # Field | matching | retained in ordinary error rates
        cases = [
            ('phase', 'pre_upstream', 'upstream'), ('phase', 'pre_upstream', None),
            ('status', 404, 401), ('status', 404, '404'),
            ('attempts', 0, 1), ('attempts', 0, None), ('attempts', 0, False),
        ]
        for field, matching, other in cases:
            for value, expected in ((matching, 1), (other, 0)):
                with self.subTest(field=field, value=value):
                    row = rejection()
                    row['props'][field] = value
                    self.assertEqual(self.summarize([row])['rejectedNoCredentials']['count'], expected)
        for field, value in (('name', 'proxy.retry'), ('error', dict(tag='http_404'))):
            with self.subTest(field=field):
                row = rejection()
                row[field] = value
                self.assertEqual(self.summarize([row])['rejectedNoCredentials']['count'], 0)
        rows = [rejection(), rejection()]
        rows[1]['props'].update(keyId='0123456789abcdef', client='node', model='another/model')
        invalid = rejection()
        invalid['props'].update(keyId='RAW_KEY_CANARY', client=['PRIVATE_CLIENT'])
        rows.append(invalid)
        result = self.summarize(rows)['rejectedNoCredentials']
        self.assertEqual(result['count'], 3)
        self.assertEqual([(g['keyId'], g['model'], g['client'], g['count']) for g in result['byCaller']], [
            ('0123456789abcdef', 'another/model', 'node', 1),
            ('unknown', MODEL, 'unknown', 1), (KEY, MODEL, 'python', 1)])
        self.assertNotIn('RAW_KEY_CANARY', json.dumps(result))
        self.assertNotIn('PRIVATE_CLIENT', json.dumps(result))

    def test_cadence_histogram_boundaries_duplicates_and_out_of_order_rows(self):
        gaps = [0, .999, 1, 4.999, 5, 14.999, 15, 29.999, 30, 59.999,
                60, 89.999, 90, 119.999, 120, 299.999, 300]
        at = dt.datetime(2026, 11, 22, 10, tzinfo=dt.timezone.utc)
        rows = [rejection(at.isoformat())]
        for gap in gaps:
            at += dt.timedelta(seconds=gap)
            rows.append(rejection(at.isoformat()))
        result = self.summarize(list(reversed(rows)))['rejectedNoCredentials']['byCaller'][0]
        self.assertEqual(result['firstTs'], DAY + 'T10:00:00.000Z')
        self.assertEqual(result['lastTs'], at.isoformat(timespec='milliseconds').replace('+00:00', 'Z'))
        cadence = result['cadence']
        self.assertEqual(cadence['intervalCount'], 17)
        self.assertEqual(cadence['missingTimestampCount'], 0)
        self.assertEqual(cadence['intervalHistogramSeconds'],
                         {label: 1 if label == 'gte300' else 2 for label, _ in INTERVALS})
        self.assertEqual(cadence['intervalSeconds'], dict(min=0, p50=30, p95=300, max=300,
                                                       mean=round(sum(gaps)/len(gaps), 6)))

    def test_missing_invalid_and_timezone_timestamps_do_not_invent_intervals(self):
        rows = [rejection(ts) for ts in [None, 'bad', [], '2026-11-22T09:00:00',
                                        '0001-01-01T00:00:00+14:00', DAY + 'T14:00:00+04:00']]
        result = self.summarize(rows)['rejectedNoCredentials']['byCaller'][0]
        self.assertEqual(result['count'], 6)
        self.assertEqual(result['firstTs'], DAY + 'T10:00:00.000Z')
        self.assertEqual(result['lastTs'], result['firstTs'])
        self.assertEqual(result['cadence']['missingTimestampCount'], 5)
        self.assertEqual(result['cadence']['intervalCount'], 0)
        self.assertIsNone(result['cadence']['intervalSeconds'])

    def test_unmeasured_non_error_rejections_and_empty_denominators(self):
        for rows in ([], [rejection()]):
            result = self.summarize(rows)
            self.assertIsNone(result['errorRateExcludingNoCredentials'])
            self.assertIsNone(result['failedRateExcludingNoCredentials'])
        first, second = rejection(), rejection()
        first.pop('ok')
        second.update(kind='perf', ok=True)
        rows = [first, second, dict(tool='9router', name='health.request', kind='perf', ok=True)]
        result = self.summarize(rows)
        self.assertEqual(result['errorRate'], 1/3)
        self.assertEqual(result['failedRate'], 0)
        self.assertEqual(result['errorRateExcludingNoCredentials'], 0)
        self.assertEqual(result['failedRateExcludingNoCredentials'], 0)
        self.assertEqual(result['rejectedNoCredentials']['count'], 2)

    def test_append_cache_hit_partial_tail_and_old_cache_rebuild_match_full_scan(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            source = root / (DAY + '.ndjson')
            source.write_text(payload([rejection(DAY + 'T10:00:10Z')]))
            rollup(DAY, root, NOW)
            offset = source.stat().st_size
            with source.open('a') as out:
                out.write(payload([rejection(DAY + 'T10:00:00Z')]))
                out.write(json.dumps(rejection(DAY + 'T10:00:05Z')))
            for _ in range(2):
                offsets = []
                original = append_cursor.lines
                def read(stream, cursor):
                    offsets.append(cursor['offset'])
                    return original(stream, cursor)
                with patch('append_cursor.lines', side_effect=read):
                    result = rollup(DAY, root, NOW)
                self.assertEqual(offsets[0], offset)
                self.assertEqual(result, rollup(DAY, root, NOW, incremental=False))
                self.assertEqual(result['rejectedNoCredentials']['byCaller'][0]['cadence']['intervalCount'], 2)
                offset = source.stat().st_size - len(json.dumps(rejection(DAY + 'T10:00:05Z')).encode())
            with source.open('a') as out:
                out.write('\n')
            result = rollup(DAY, root, NOW)
            self.assertEqual(result['rejectedNoCredentials']['count'], 3)
            self.assertEqual(result, rollup(DAY, root, NOW, incremental=False))
            state = root / ('.rollup-state-' + DAY + '.json')
            saved = json.loads(state.read_text())
            saved['version'] = AGGREGATE_VERSION - 1
            state.write_text(json.dumps(saved))
            self.assertEqual(rollup(DAY, root, NOW), result)


if __name__ == '__main__':
    unittest.main()

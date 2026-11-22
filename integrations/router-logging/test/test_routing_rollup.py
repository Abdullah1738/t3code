import json
from pathlib import Path
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from rollup import rollup

DAY = '2026-11-19'
MODEL = '0123456789abcdef'


def row(name, req='aaaaaaaa', **props):
    return dict(tool='9router', component='proxy', kind='event', name=name,
                ts=DAY+'T13:00:00Z', ids={'req': req}, props=props)


def summarize(rows):
    with tempfile.TemporaryDirectory() as tmp:
        (Path(tmp)/(DAY+'.ndjson')).write_text('\n'.join(map(json.dumps, rows)))
        return rollup(DAY, tmp)


class RoutingRollupTests(unittest.TestCase):
    def test_legacy_and_new_rows_count_and_request_chain_denominator(self):
        rows = [row('proxy.sticky_miss', decision='moved'),
                row('proxy.sticky_miss', reason='locked', prevLockCause='quota', provider='claude', model=MODEL, decision='moved'),
                row('proxy.sticky_miss', req='bbbbbbbb', reason='disabled', prevLockCause='auth', decision='hold'),
                row('proxy.fallback', reason='http_429'), row('proxy.fallback'),
                row('proxy.fallback', req='bbbbbbbb', reason='http_503', provider='codex', model=MODEL, fromProvider='claude', fromModel='abcdef0123456789'),
                row('proxy.request', model='claude/m', route='/v1/messages', stream=True),
                row('proxy.request', req='cccccccc', model='claude/m', route='/v1/messages', stream=True)]
        result = summarize(rows)
        sticky, fallback = result['stickyMoves'], result['fallbacks']
        self.assertEqual(sticky['count'], result['countsByName']['proxy.sticky_miss'])
        self.assertEqual(sticky['byReason'], dict(unknown=1, locked=1, disabled=1))
        self.assertEqual(sticky['byPrevLockCause'], dict(unknown=1, quota=1, auth=1))
        self.assertEqual(sticky['byDecision'], dict(moved=2, hold=1))
        self.assertEqual(sticky['distinctRequests'], 2)
        self.assertEqual(sticky['byHour'], {'13': 3})
        self.assertEqual(sticky['unknownReasonShare'], 1/3)
        self.assertIn(dict(provider='claude', model=MODEL, count=1), sticky['byModel'])
        self.assertEqual(fallback['count'], result['countsByName']['proxy.fallback'])
        self.assertEqual(fallback['byReason'], dict(http_429=1, http_503=1, unknown=1))
        self.assertEqual(fallback['chainLengthHistogram'], {'0': 1, '1': 1, '2': 1})
        self.assertEqual(fallback['totalDistinctRequests'], 3)
        self.assertEqual(fallback['shareRequestsWithAtLeastTwoFallbacks'], 1/3)
        self.assertIn(dict(fromProvider='claude',fromModel='abcdef0123456789',toProvider='codex',toModel=MODEL,count=1),fallback['byProviderModel'])

    def test_unknown_fields_and_missing_request_ids_never_drop_rows(self):
        rows = []
        for value in [None, [], {}, True, 5, 'raw private text', 'a'*200, 'trailing\n']:
            rows.extend([row('proxy.sticky_miss', req=value, reason=value, model=value, provider=value, prevLockCause=value, decision=value),
                         row('proxy.fallback', req=value, reason=value, model=value, provider=value)])
        result = summarize(rows)
        self.assertEqual(result['malformed'], 0)
        self.assertEqual(result['stickyMoves']['byReason'], {'unknown': 8})
        self.assertEqual(result['fallbacks']['byReason'], {'unknown': 8})
        self.assertEqual(result['stickyMoves']['rowsWithoutRequest'], 8)
        self.assertEqual(result['fallbacks']['rowsWithoutRequest'], 8)
        self.assertIsNone(result['fallbacks']['shareRequestsWithAtLeastTwoFallbacks'])
        self.assertEqual(result['fallbacks']['chainLengthHistogram'], {})
        self.assertNotIn('raw private text', json.dumps(result))

    def test_every_reason_and_hour_in_utc(self):
        rows = [row('proxy.sticky_miss', reason=r, prevLockCause=c) for r,c in
                [('locked','quota'),('removed','none'),('disabled','auth'),('over_budget','model'),('unknown','overloaded')]]
        rows[0]['ts'] = DAY+'T17:00:00+04:00'
        rows[1]['ts'] = 'invalid'
        result = summarize(rows)['stickyMoves']
        self.assertEqual(result['byHour'], {'13': 4, 'unknown': 1})
        self.assertEqual(sum(result['byReason'].values()), 5)
        self.assertEqual(sum(result['byPrevLockCause'].values()), 5)
        self.assertEqual(sum(r['count'] for r in result['byHourReason']), 5)

    def test_empty_sections(self):
        result = summarize([])
        self.assertEqual(result['stickyMoves']['count'], 0)
        self.assertEqual(result['fallbacks']['count'], 0)
        self.assertIsNone(result['stickyMoves']['unknownReasonShare'])

class RoutingReviewRegressionTests(unittest.TestCase):
    def test_denominator_includes_each_nonterminal_proxy_event_class(self):
        for event in ['proxy.sticky_miss', 'proxy.retry', 'proxy.progress', 'proxy.request', 'proxy.other']:
            with self.subTest(event=event):
                observed = row(event,req='bbbbbbbb',model='m',route='/v1/messages',stream=True)
                rows = [row('proxy.fallback'),row('proxy.fallback'),observed]
                result = summarize(rows)['fallbacks']
                self.assertEqual(result['totalDistinctRequests'],2)
                self.assertEqual(result['shareRequestsWithAtLeastTwoFallbacks'],.5)
                self.assertEqual(result['chainLengthHistogram'],{'0':1,'2':1})

    def test_timestamp_input_class_keeps_all_rows(self):
        forms = [None, [], {}, True, 5, '', 'invalid', '0001-01-01T00:00:00+01:00',
                 '9999-12-31T23:59:59-01:00', '2026-11-19T00:00:00+25:00',
                 '2026-11-19T13:00:00', '2026-11-19T17:00:00+04:00', '2026-11-19T13:00:00Z']
        rows=[]
        for value in forms:
            entry=row('proxy.sticky_miss',reason='locked')
            entry['ts']=value
            rows.append(entry)
        result=summarize(rows)
        self.assertEqual(result['malformed'],0)
        self.assertEqual(result['stickyMoves']['count'],len(forms))
        self.assertEqual(result['stickyMoves']['byHour'],{'13':2,'unknown':len(forms)-2})


if __name__ == '__main__':
    unittest.main()

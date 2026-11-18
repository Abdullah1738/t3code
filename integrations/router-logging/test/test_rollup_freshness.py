import datetime as dt
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import poller
from rollup import rollup

UTC = dt.timezone.utc
DAY = '2026-11-15'


class FreshnessTests(unittest.TestCase):
    def test_complete_boundary_is_next_utc_midnight(self):
        cases = [
            ('2026-11-15T12:00:00+00:00', False),
            ('2026-11-15T23:59:59.999999+00:00', False),
            ('2026-11-16T00:00:00+00:00', True),
            ('2026-11-16T04:00:00+04:00', True),
        ]
        with tempfile.TemporaryDirectory() as tmp:
            for timestamp, complete in cases:
                with self.subTest(timestamp=timestamp):
                    result = rollup(DAY, tmp, now=dt.datetime.fromisoformat(timestamp))
                    self.assertIs(result['complete'], complete)
                    self.assertTrue(result['generatedAt'].endswith('Z'))

    def test_poll_repairs_missing_provisional_legacy_and_corrupt_once(self):
        for existing in (None, 'midday', '{}', '{broken', '[]', 'null', '{"complete":1}', '{"complete":"true"}'):
            with self.subTest(existing=existing), tempfile.TemporaryDirectory() as tmp:
                root = Path(tmp)
                source = root / (DAY + '.ndjson')
                source.write_text(json.dumps(dict(tool='9router', kind='event', name='fixture.first')) + '\n')
                report = root / ('rollup-' + DAY + '.json')
                if existing == 'midday':
                    self.assertFalse(rollup(DAY, root, now=dt.datetime(2026, 11, 15, 12, tzinfo=UTC))['complete'])
                elif existing is not None:
                    report.write_text(existing)
                source.write_text(source.read_text() * 2)
                before = report.read_bytes() if report.exists() else None
                def get(route):
                    return {'/api/providers': {'connections': []}, '/api/usage/logs': [], '/api/usage/stats?period=today': {'byAccount': {}}}[route]
                with patch.object(poller, 'emit'):
                    self.assertEqual(poller.poll(get, root, dt.datetime(2026, 11, 16, 0, 4, tzinfo=UTC)), 0)
                    self.assertEqual(report.read_bytes() if report.exists() else None, before)
                    self.assertEqual(poller.poll(get, root, dt.datetime(2026, 11, 16, 0, 5, tzinfo=UTC)), 0)
                    final = report.read_bytes()
                    self.assertIs(json.loads(final)['complete'], True)
                    self.assertEqual(json.loads(final)['total'], 2)
                    def current_only(day, *args, **kwargs):
                        self.assertNotEqual(day, DAY, 'complete rollup rewritten')
                        return rollup(day, *args, **kwargs)
                    with patch.object(poller, 'rollup', side_effect=current_only) as build:
                        self.assertEqual(poller.poll(get, root, dt.datetime(2026, 11, 16, 1, tzinfo=UTC)), 0)
                        self.assertEqual([call.args[0] for call in build.call_args_list], ['2026-11-16'])
                    self.assertEqual(report.read_bytes(), final)

    def test_distinct_dedupes_workers_and_restrikes_with_reset_metrics(self):
        account = '1234567890abcdef'
        rows = [dict(tool='9router', kind='event', name='account.lock', ids={'account': account, 'worker': str(n % 2)},
                     props=dict(provider='claude', model='account-wide', cause='quota',
                                until=until, lockMs=1800000-n*1000, capped=True, upstreamResetMs=18000000-n*1000))
                for n, until in enumerate(['2026-11-15T18:00:00.000Z', '2026-11-15T18:00:03Z',
                                          '2026-11-15T22:00:00+04:00', '2026-11-15T18:00:59.999Z'])]
        with tempfile.TemporaryDirectory() as tmp:
            source = Path(tmp) / (DAY + '.ndjson')
            source.write_text('\n'.join(map(json.dumps, rows)))
            locks = rollup(DAY, tmp)['locks']
            self.assertEqual((locks['count'], locks['distinct']), (4, 1))
            group = locks['byProviderModelCause'][0]
            self.assertEqual((group['count'], group['distinct'], group['capped']), (4, 1, 4))
            self.assertEqual(group['upstreamResetMs'], dict(p50=17998000, p95=18000000, max=18000000))
            self.assertEqual(locks['topAccounts'], [dict(account=account, count=4, distinct=1)])
            for field, value in [('provider', 'codex'), ('model', 'haiku'), ('until', '2026-11-15T18:01:00Z')]:
                with self.subTest(field=field):
                    other = {**rows[0], 'props': {**rows[0]['props'], field: value}}
                    source.write_text('\n'.join(map(json.dumps, rows + [other])))
                    self.assertEqual(rollup(DAY, tmp)['locks']['distinct'], 2)
            other = {**rows[0], 'ids': {'account': 'abcdef1234567890'}}
            source.write_text('\n'.join(map(json.dumps, rows + [other])))
            self.assertEqual(rollup(DAY, tmp)['locks']['distinct'], 2)

    def test_incomplete_identities_are_never_deduplicated(self):
        account = '1234567890abcdef'
        cases = [(field, value) for field in ('provider', 'model', 'account')
                 for value in (None, '', '   ', 'unknown', ' Unknown ')]
        cases += [('until', value) for value in (None, '', 'invalid', '2026-11-15T18:00:00')]
        for field, value in cases:
            with self.subTest(field=field, value=value), tempfile.TemporaryDirectory() as tmp:
                row = dict(tool='9router', kind='event', name='account.lock', ids={'account': account},
                           props=dict(provider='claude', model='account-wide', cause='quota', until='2026-11-15T18:00:00Z'))
                target = row['ids'] if field == 'account' else row['props']
                if value is None:
                    target.pop(field)
                else:
                    target[field] = value
                (Path(tmp) / (DAY + '.ndjson')).write_text('\n'.join(map(json.dumps, [row, row])))
                locks = rollup(DAY, tmp)['locks']
                self.assertEqual((locks['count'], locks['distinct']), (2, 2))
                self.assertEqual(locks['byProviderModelCause'][0]['distinct'], 2)
                expected_accounts = [] if field == 'account' else [dict(account=account, count=2, distinct=2)]
                self.assertEqual(locks['topAccounts'], expected_accounts)


if __name__ == '__main__':
    unittest.main()

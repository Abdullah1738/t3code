import datetime as dt
import hashlib
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import poller
from rollup import rollup
from toollog import clean


class LockRollupTests(unittest.TestCase):
    def test_fixture_day_groups_durations_top_five_and_unlocks(self):
        rows = []
        for n in range(1, 8):
            for _ in range(n):
                rows.append(dict(tool='9router', component='router', kind='event', name='account.lock', ids={'account': f'{n:016x}'}, props=dict(provider='codex', model='gpt-image-2', cause='quota', lockMs=n * 1000)))
        rows.extend([
            dict(tool='9router', kind='event', name='account.unlock'),
            dict(tool='9router', kind='event', name='account.lock', props=dict(provider='github', model='account-wide', cause='monthly_usage', lockMs=20000)),
            dict(tool='9router', kind='event', name='account.locked', props=dict(provider='codex', model='gpt-image-2', cause='quota')),
        ])
        with tempfile.TemporaryDirectory() as tmp:
            (Path(tmp) / '2026-11-15.ndjson').write_text('\n'.join(map(json.dumps, rows)) + '\n')
            result = rollup('2026-11-15', tmp)['locks']
        self.assertEqual(result['count'], 29)
        self.assertEqual(result['unlocks'], 1)
        self.assertEqual(result['byProviderModelCause'][0], dict(provider='codex', model='gpt-image-2', cause='quota', count=28, lockMs=dict(p50=5000, p95=7000, max=7000)))
        self.assertEqual(result['topAccounts'], [dict(account=f'{n:016x}', count=n) for n in range(7, 2, -1)])

    def test_snapshot_uses_exposed_deadlines_and_shared_hash_without_content(self):
        now = dt.datetime(2026, 11, 15, tzinfo=dt.timezone.utc)
        until = '2026-11-15T00:30:00.000Z'
        conn = dict(id='private@example.invalid', provider='codex', apiKey='sk-fixture', lastError='PRIVATE BODY', modelLock_image=until, modelLock___all=until, modelLock_expired='2020-01-01T00:00:00Z', modelLockCause_image=dict(until=until, cause='quota', status=429))
        events = []
        def emit(component, name, **fields):
            events.append(clean(dict(component=component, name=name, **{'kind': 'event', **fields}), now))
        with patch.object(poller, 'emit', side_effect=emit):
            poller.snapshot({'connections': [conn]}, [], {}, now)
        locked = [e for e in events if e['name'] == 'account.locked']
        self.assertEqual(len(locked), 2)
        self.assertEqual(locked[0]['props'], dict(provider='codex', model='image', scope='model', cause='quota', until=until))
        self.assertEqual(locked[1]['props']['scope'], 'account')
        self.assertEqual(locked[0]['ids']['account'], hashlib.sha256(conn['id'].encode()).hexdigest()[:16])
        for secret in ('private@example.invalid', 'sk-fixture', 'PRIVATE BODY'):
            self.assertNotIn(secret, json.dumps(events))

    def test_snapshot_deadline_input_class(self):
        now = dt.datetime(2026, 11, 15, tzinfo=dt.timezone.utc)
        cases = [
            ('2026-11-15T00:30:00.000Z', '2026-11-15T00:30:00.000Z'),
            ('2026-11-15T04:30:00+04:00', '2026-11-15T00:30:00.000Z'),
            ((now.timestamp() + 1800) * 1000, '2026-11-15T00:30:00.000Z'),
            ('2026-11-14T00:00:00Z', None), (None, None), (True, None),
            ('PRIVATE BODY', None), (float('nan'), None),
        ]
        for value, expected in cases:
            with self.subTest(value=value):
                events = []
                with patch.object(poller, 'emit', side_effect=lambda c, n, **f: events.append((n, f))):
                    poller.snapshot({'connections': [dict(id='fixture', modelLock_image=value)]}, [], {}, now)
                locked = [f['props']['until'] for n, f in events if n == 'account.locked']
                self.assertEqual(locked, [expected] if expected else [])

    def test_invalid_and_empty_lock_metrics(self):
        rows = [dict(tool='9router', kind='event', name='account.lock', props=dict(provider='codex', model='image', cause='quota', lockMs=v)) for v in (True, -1, '2000', None)]
        with tempfile.TemporaryDirectory() as tmp:
            (Path(tmp) / '2026-11-15.ndjson').write_text('\n'.join(map(json.dumps, rows)))
            result = rollup('2026-11-15', tmp)['locks']
            self.assertIsNone(result['byProviderModelCause'][0]['lockMs'])
            self.assertEqual(result['count'], 4)
            self.assertEqual(rollup('2026-11-16', tmp)['locks'], dict(count=0, unlocks=0, byProviderModelCause=[], topAccounts=[]))


if __name__ == '__main__':
    unittest.main()

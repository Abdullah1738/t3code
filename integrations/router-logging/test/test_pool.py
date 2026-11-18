import datetime as dt
import hashlib
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch, Mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from pool_alerts import PoolAlerts
from rollup import rollup

BASE = 1795000000000
IDENTITY = '01234567-0123-4567-89ab-0123456789ab'


class PoolTests(unittest.TestCase):
    def rig(self, state=None):
        self.alerts = []
        return PoolAlerts(state if state is not None else {}, lambda text, key: self.alerts.append((text, key)) or True, lambda: None)

    def episode(self, **changes):
        return dict(id=IDENTITY, provider='claude', since=BASE, open=True, failedRequests=3, **changes)

    def test_threshold_once_restart_and_one_recovery(self):
        alerts = self.rig()
        for elapsed in (0, 119999):
            alerts.step(BASE + elapsed, [self.episode()])
        self.assertEqual(self.alerts, [])
        alerts.step(BASE + 120000, [self.episode()])
        alerts.step(BASE + 135000, [self.episode()])
        self.assertEqual(len(self.alerts), 1)
        prior = self.alerts[0][1]
        alerts = self.rig(json.loads(json.dumps(alerts.state)))
        alerts.step(BASE + 150000, [self.episode()])
        self.assertEqual(self.alerts, [])
        ended = {**self.episode(), 'open': False, 'endedAt': BASE + 150000}
        alerts.step(BASE + 165000, [ended])
        alerts.step(BASE + 180000, [ended])
        self.assertEqual([key for _, key in self.alerts], [prior + ':recovered'])

    def test_short_completed_episode_is_quiet_and_long_completed_episode_alerts_once(self):
        for duration, count in ((119999, 0), (120000, 2)):
            with self.subTest(duration=duration):
                alerts = self.rig()
                ended = {**self.episode(), 'open': False, 'endedAt': BASE + duration}
                for _ in range(2):
                    alerts.step(BASE + 150000, [ended])
                self.assertEqual(len(self.alerts), count)

    def test_delivery_retry_uses_stable_keys(self):
        alerts = self.rig()
        calls = []
        alerts.notify = lambda text, key: calls.append((text, key)) or len(calls) > 1
        for elapsed in (120000, 135000, 150000):
            alerts.step(BASE + elapsed, [self.episode()])
        self.assertEqual(len(calls), 2)
        self.assertEqual(calls[0], calls[1])

    def test_lost_ack_replays_exact_text_after_restart_for_alert_and_recovery(self):
        alerts = self.rig()
        calls = []
        alerts.notify = lambda text, key: calls.append((text,key)) or False
        alerts.step(BASE+120000, [self.episode()])
        state = json.loads(json.dumps(alerts.state))
        alerts = self.rig(state)
        alerts.step(BASE+135000, [self.episode()])
        self.assertEqual(self.alerts, calls)
        ended = {**self.episode(), 'open':False, 'endedAt':BASE+150000}
        alerts.notify = lambda text, key: calls.append((text,key)) or False
        alerts.step(BASE+150000, [ended])
        state = json.loads(json.dumps(alerts.state))
        alerts = self.rig(state)
        alerts.step(BASE+180000, [{**ended, 'failedRequests':99}])
        self.assertEqual(self.alerts, [calls[-1]])

    def test_pending_delivery_survives_history_eviction_fetch_failure_and_restart(self):
        for pending in ('alert', 'recovery'):
            with self.subTest(pending=pending):
                alerts = self.rig()
                ended = {**self.episode(), 'open':False, 'endedAt':BASE+150000}
                if pending == 'recovery':
                    alerts.step(BASE+120000,[self.episode()])
                calls = []
                alerts.notify = lambda text,key:calls.append((text,key)) or False
                alerts.step(BASE+150000,[ended])
                original = calls[0]
                # More than the API history bound, all shorter than the alert threshold.
                later = [{**ended, 'id':f'{index:08x}-0123-4567-89ab-0123456789ab', 'endedAt':BASE+1000} for index in range(129)]
                alerts.step(BASE+180000,later)
                alerts = self.rig(json.loads(json.dumps(alerts.state)))
                alerts.step(BASE+31*86400000,[])
                self.assertIn(original,self.alerts)
                self.assertEqual(self.alerts.count(original),1)
                before = list(self.alerts)
                alerts.step(BASE+32*86400000,[])
                self.assertEqual(self.alerts,before)

    def test_rollup_dedupes_events_and_cache_and_clips_utc_days(self):
        since = dt.datetime(2026, 11, 18, 23, 59, tzinfo=dt.timezone.utc)
        ended = since + dt.timedelta(minutes=3)
        def iso(value):
            return value.isoformat(timespec='milliseconds').replace('+00:00', 'Z')
        identity = hashlib.sha256(IDENTITY.encode()).hexdigest()[:16]
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            cached = {IDENTITY: dict(provider='claude', since=int(since.timestamp()*1000), endedAt=int(ended.timestamp()*1000), open=False)}
            (root / '.pool-episodes.json').write_text(json.dumps(cached))
            rows = [dict(tool='9router', kind='event', name='pool.exhausted', ts=iso(since), ids=dict(incident=identity), props=dict(provider='claude', since=iso(since)))] * 2
            (root / '2026-11-18.ndjson').write_text(''.join(json.dumps(row)+'\n' for row in rows))
            first = rollup('2026-11-18', root, ended)['pools']
            second = rollup('2026-11-19', root, ended)['pools']
            self.assertEqual(first, [dict(provider='claude', episodes=1, startedEpisodes=1, openEpisodes=1, totalMs=60000, totalMinutes=1.0)])
            self.assertEqual(second, [dict(provider='claude', episodes=1, startedEpisodes=0, openEpisodes=0, totalMs=120000, totalMinutes=2.0)])

    def test_cache_loss_multiday_open_episode_ignores_intervening_ordinary_days(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            row = dict(tool='9router', kind='event', name='pool.exhausted',
                       ts='2026-11-17T23:59:00.000Z', ids=dict(incident='0123456789abcdef'),
                       props=dict(provider='claude', since='2026-11-17T23:59:00.000Z'))
            (root/'2026-11-17.ndjson').write_text(json.dumps(row)+'\n')
            (root/'2026-11-18.ndjson').write_text(json.dumps(dict(tool='9router',kind='event',name='ordinary'))+'\n')
            generated=dt.datetime(2026,11,19,1,tzinfo=dt.timezone.utc)
            result=rollup('2026-11-19',root,generated)['pools']
            self.assertEqual(result,[dict(provider='claude',episodes=1,startedEpisodes=0,openEpisodes=1,totalMs=3600000,totalMinutes=60.0)])

    def test_historical_outage_survives_each_incomplete_episode_cache_form(self):
        import pool_rollup
        unrelated = {'11111111-0123-4567-89ab-0123456789ab':dict(provider='codex',since=BASE,endedAt=BASE+1000,open=False)}
        for cache in (None, '', 'invalid-json', '{}', json.dumps(unrelated)):
            with self.subTest(cache=cache), tempfile.TemporaryDirectory() as directory:
                root=Path(directory)
                row=dict(tool='9router',kind='event',name='pool.exhausted',ts='2026-11-17T23:59:00.000Z',ids=dict(incident='0123456789abcdef'),props=dict(provider='claude',since='2026-11-17T23:59:00.000Z'))
                (root/'2026-11-17.ndjson').write_text(json.dumps(row)+'\n')
                (root/'2026-11-18.ndjson').write_text(json.dumps(dict(tool='9router',kind='event',name='ordinary'))+'\n')
                if cache is not None:
                    (root/'.pool-episodes.json').write_text(cache)
                generated=dt.datetime(2026,11,19,1,tzinfo=dt.timezone.utc)
                first=rollup('2026-11-19',root,generated)['pools']
                self.assertEqual(next(group for group in first if group['provider']=='claude')['totalMinutes'],60)
                with patch.object(pool_rollup,'transitions',side_effect=AssertionError('unchanged historical file rescanned')):
                    self.assertEqual(rollup('2026-11-19',root,generated)['pools'],first)

    def test_historical_index_rebuilds_missing_corrupt_appended_and_replaced_sources(self):
        for index in (None, 'invalid-json', '[]', '{"version":1,"files":{}}'):
            with self.subTest(index=index), tempfile.TemporaryDirectory() as directory:
                root=Path(directory)
                source=root/'2026-11-17.ndjson'
                exhausted=dict(tool='9router',kind='event',name='pool.exhausted',ts='2026-11-17T23:59:00.000Z',ids=dict(incident='0123456789abcdef'),props=dict(provider='claude',since='2026-11-17T23:59:00.000Z'))
                recovered={**exhausted,'name':'pool.recovered','ts':'2026-11-18T00:01:00.000Z'}
                source.write_text(json.dumps(exhausted)+'\n')
                if index is not None:
                    (root/'.pool-transitions.json').write_text(index)
                generated=dt.datetime(2026,11,19,1,tzinfo=dt.timezone.utc)
                self.assertEqual(rollup('2026-11-19',root,generated)['pools'][0]['totalMinutes'],60)
                with source.open('a') as out:
                    out.write(json.dumps(recovered)+'\n')
                self.assertEqual(rollup('2026-11-19',root,generated)['pools'],[])
                source.write_text(json.dumps(exhausted)+'\n')
                self.assertEqual(rollup('2026-11-19',root,generated)['pools'][0]['totalMinutes'],60)

    def test_listener_guard_keeps_checking_while_pool_delivery_child_is_blocked(self):
        import guard
        import signal
        with tempfile.TemporaryDirectory() as directory:
            runtime=Mock()
            runtime.state_file=Path(directory)/'guard.json'
            runtime.marker=Path(directory)/'deploy.json'
            runtime.lock_age_ms.return_value=None
            handlers={}
            checks=[]
            def observe():
                checks.append('observe')
                if len(checks)==2:
                    handlers[signal.SIGTERM]()
                return 'loaded','open'
            runtime.observe.side_effect=observe
            child=Mock()
            child.poll.return_value=None
            clock=iter(range(0,1000,16))
            with patch.object(guard,'Runtime',return_value=runtime), patch.object(guard.signal,'signal',side_effect=lambda key,callback:handlers.update({key:callback})), patch.object(guard.time,'monotonic',side_effect=lambda:next(clock)), patch.object(guard.subprocess,'Popen',return_value=child) as spawn:
                guard.serve()
            self.assertEqual(len(checks),2)
            runtime.notify.assert_not_called()
            self.assertTrue(any(call.args[0][-1]=='pool-alerts' for call in spawn.call_args_list))
            child.terminate.assert_called()


if __name__ == '__main__':
    unittest.main()

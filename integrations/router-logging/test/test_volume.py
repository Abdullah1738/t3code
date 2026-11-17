import datetime as dt
import json
import os
from pathlib import Path
import sys
import tempfile
import subprocess
import signal
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
import poller
import toollog
import volume
from rollup import rollup


class VolumeTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='router-volume-')
        self.root = Path(self.temp.name) / 'logs'
        self.env = patch.dict(os.environ, ROUTER_LOG_DIR=str(self.root))
        self.env.start()

    def tearDown(self):
        self.env.stop()
        self.temp.cleanup()

    def rows(self):
        return [json.loads(line) for path in self.root.glob('*.ndjson') for line in path.read_text().splitlines()]

    def test_small_cap_reports_cumulative_drops_and_preserves_errors(self):
        self.root.mkdir()
        day = dt.datetime.now(dt.timezone.utc).date().isoformat()
        (self.root / (day+'.ndjson')).write_bytes(b' '*128)
        with patch.object(toollog, 'CAP', 128):
            toollog.emit('proxy','proxy.request')
            toollog.emit('proxy','proxy.request')
            toollog.emit('proxy','proxy.request',kind='error',error={'tag':'http_502'})
            before = (self.root / (day+'.ndjson')).stat().st_size
            toollog.report_volume()
            toollog.report_volume()
        rows = self.rows()
        self.assertEqual(sum(row['name']=='log.cap' for row in rows),1)
        self.assertEqual(sum(row['name']=='proxy.request' for row in rows),1)
        reports = [row for row in rows if row['name']=='log.volume']
        self.assertEqual(len(reports),1)
        self.assertEqual(reports[0]['props'],dict(bytesToday=before,writtenLines=2,linesByName={'log.cap':1,'proxy.request':1},otherLines=0,droppedByReason={'daily_cap':2},droppedLines=2,writeErrors=0))
        self.assertEqual(reports[0]['kind'],'event')
        self.assertRegex(reports[0]['ids']['writer'],r'^[a-f0-9]{16}$')

    def test_invalid_and_oversized_lines_are_counted_without_rejected_metadata(self):
        toollog.emit('proxy','invalid name')
        toollog.emit('x'*100,'proxy.request',ids={key:'fixture' for key in toollog.IDS},props={key:'x'*100 for key in toollog.PROPS})
        toollog.emit('test','CANARY_EVENT_NAME')
        toollog.report_volume()
        report = next(row for row in self.rows() if row['name']=='log.volume')
        self.assertEqual(report['props']['droppedByReason'],dict(invalid_event=1,line_size=1))
        self.assertEqual(report['props']['droppedLines'],2)
        self.assertEqual(report['props']['linesByName'],{'other':1})
        self.assertNotIn('CANARY',json.dumps(report))

    def test_write_failure_is_visible_after_recovery(self):
        self.root.write_text('blocked')
        toollog.emit('proxy','proxy.request')
        self.root.unlink()
        self.root.mkdir()
        toollog.report_volume()
        report = self.rows()[0]
        self.assertEqual(report['props']['droppedByReason'],{'write_error':1})
        self.assertEqual(report['props']['writeErrors'],1)

    def test_delayed_snapshot_keeps_the_counted_day(self):
        self.root.mkdir()
        day = (dt.datetime.now(dt.timezone.utc).date() - dt.timedelta(days=1)).isoformat()
        volume.written(volume.state_for(self.root, day), 'proxy.request')
        toollog.report_volume()
        rows = [json.loads(line) for line in (self.root / (day + '.ndjson')).read_text().splitlines()]
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]['ts'][:10], day)
        self.assertEqual(rows[0]['props']['writtenLines'], 1)

    def test_python_shutdown_reports_drops_and_preserves_signal_behavior(self):
        cases = [(None, mode) for mode in ('natural', 'explicit')]
        cases += [(signum, mode) for signum in (signal.SIGTERM, signal.SIGINT) for mode in ('default', 'custom', 'ignore')]
        for signum, mode in cases:
            with self.subTest(signal=signum, mode=mode), tempfile.TemporaryDirectory(prefix='volume-shutdown-') as tmp:
                path = Path(tmp) / (dt.datetime.now(dt.timezone.utc).date().isoformat() + '.ndjson')
                path.write_bytes(b' ' * 128)
                source = 'import sys,os,signal,json\n'
                if mode == 'custom':
                    source += (f'def previous(signum, frame):\n'
                               f' assert "log.volume" in open({str(path)!r}).read()\n'
                               f' toollog.emit("proxy","proxy.request",kind="error")\n'
                               f' sys.exit(9)\n'
                               f'signal.signal({signum},previous)\n')
                elif mode == 'ignore':
                    source += f'signal.signal({signum},signal.SIG_IGN)\n'
                source += f'sys.path.insert(0,{str(ROOT)!r})\nimport toollog\ntoollog.CAP=128\ntoollog.emit("proxy","proxy.request")\n'
                if signum:
                    source += f'os.kill(os.getpid(),{signum})\n'
                if mode == 'ignore':
                    source += f'assert "log.volume" in open({str(path)!r}).read()\nos._exit(0)\n'
                elif mode == 'explicit':
                    source += 'sys.exit(7)\n'
                child = subprocess.run([sys.executable, '-I', '-c', source], env={**os.environ, 'ROUTER_LOG_DIR': tmp}, capture_output=True, timeout=10)
                expected = 9 if mode == 'custom' else 7 if mode == 'explicit' else -signum if signum and mode == 'default' else 0
                self.assertEqual(child.returncode, expected, child.stderr.decode())
                rows = [json.loads(line) for line in path.read_text().splitlines()]
                reports = [row for row in rows if row['name'] == 'log.volume']
                self.assertEqual(len(reports), 2 if mode == 'custom' else 1)
                self.assertEqual(reports[-1]['props']['droppedLines'], 1)
                self.assertEqual(reports[-1]['props']['writtenLines'], 2 if mode == 'custom' else 1)

    def test_current_day_rollup_rebuilds_once_per_hour(self):
        self.root.mkdir()
        now = dt.datetime(2026,11,15,10,tzinfo=dt.timezone.utc)
        path = self.root / '2026-11-15.ndjson'
        row = dict(tool='9router',name='fixture.source',kind='event')
        path.write_text(json.dumps(row)+'\n')
        fixture = json.loads((ROOT/'test/fixtures/poll.json').read_text())
        def get(route):
            return {'/api/providers':fixture['providers'],'/api/usage/logs':fixture['logs'],'/api/usage/stats?period=today':fixture['stats']}[route]
        with patch.object(poller,'rollup',wraps=poller.rollup) as build:
            self.assertEqual(poller.poll(get,self.root,now),0)
            current = self.root / 'rollup-2026-11-15.json'
            self.assertEqual(json.loads(current.read_text())['total'],1)
            with path.open('a') as out:
                out.write(json.dumps(row)+'\n')
            self.assertEqual(poller.poll(get,self.root,now.replace(minute=30)),0)
            self.assertEqual(json.loads(current.read_text())['total'],1)
            self.assertEqual(poller.poll(get,self.root,now.replace(hour=11)),0)
            self.assertEqual(json.loads(current.read_text())['total'],2)
            self.assertEqual(sum(call.args[0]=='2026-11-15' for call in build.call_args_list),2)

    def test_yesterday_finalization_keeps_the_last_hour_after_hourly_rollup(self):
        fixture = json.loads((ROOT/'test/fixtures/poll.json').read_text())
        def get(route):
            return {'/api/providers':fixture['providers'],'/api/usage/logs':fixture['logs'],'/api/usage/stats?period=today':fixture['stats']}[route]
        for hour,minute in [(0,4),(0,5),(12,0)]:
            with self.subTest(next_day=(hour,minute)):
                root = self.root / f'{hour}-{minute}'
                root.mkdir(parents=True)
                path = root/'2026-11-15.ndjson'
                request = dict(tool='9router',name='proxy.request',kind='perf',props=dict(model='m',route='/v1/responses',stream=True,attempts=1,status=200))
                path.write_text(json.dumps(request)+'\n')
                with patch.object(poller,'rollup',wraps=poller.rollup) as build:
                    self.assertEqual(poller.poll(get,root,dt.datetime(2026,11,15,23,tzinfo=dt.timezone.utc)),0)
                    target = root/'rollup-2026-11-15.json'
                    self.assertEqual(json.loads(target.read_text())['total'],1)
                    with path.open('a') as out:
                        for row in [request,dict(tool='9router',name='account.lock',kind='event',props=dict(provider='p',model='m',cause='quota')),dict(tool='9router',name='log.volume',kind='event',ids=dict(writer='a'*16),props=dict(droppedLines=2,droppedByReason=dict(daily_cap=2)))]:
                            out.write(json.dumps(row)+'\n')
                    now = dt.datetime(2026,11,16,hour,minute,tzinfo=dt.timezone.utc)
                    self.assertEqual(poller.poll(get,root,now),0)
                    if minute == 4:
                        self.assertEqual(json.loads(target.read_text())['total'],1)
                        self.assertEqual(poller.poll(get,root,now.replace(minute=5)),0)
                    final = json.loads(target.read_text())
                    self.assertEqual(final['total'],4)
                    self.assertEqual(final['countsByName']['proxy.request'],2)
                    self.assertEqual(final['locks']['count'],1)
                    self.assertEqual(final['droppedLines'],2)
                    self.assertEqual(poller.poll(get,root,now.replace(minute=10)),0)
                    self.assertEqual(sum(call.args[0]=='2026-11-15' for call in build.call_args_list),2)
                    self.assertEqual(json.loads((root/'.poll-state.json').read_text())['finalizedDay'],'2026-11-15')

    def test_rollup_uses_latest_cumulative_counts_per_writer(self):
        self.root.mkdir()
        rows = []
        for writer,drops in [('a'*16,{'daily_cap':2}),('a'*16,{'daily_cap':2}),('a'*16,{'daily_cap':1}),('a'*16,{'daily_cap':2,'queue_full':1}),('b'*16,{'write_error':2})]:
            rows.append(dict(tool='9router',kind='event',name='log.volume',ids={'writer':writer},props=dict(droppedLines=sum(drops.values()),droppedByReason=drops)))
        for bad in [None,True,-1,1.5,'2',float('nan')]:
            rows.append(dict(tool='9router',kind='event',name='log.volume',ids={'writer':'c'*16},props=dict(droppedLines=bad,droppedByReason={'daily_cap':bad})))
        (self.root/'2026-11-15.ndjson').write_text('\n'.join(map(json.dumps,rows))+'\n')
        result = rollup('2026-11-15',self.root)
        self.assertEqual(result['droppedLines'],5)
        self.assertEqual(result['dropsByReason'],dict(daily_cap=2,queue_full=1,write_error=2))
        self.assertEqual(result['volumeWriters'],2)
        self.assertIsNone(rollup('2026-11-14',self.root)['droppedLines'])

    def test_python_volume_schema_matches_js_privacy_contract(self):
        row = toollog.clean(dict(component='logger',name='log.volume',kind='event',ids={'writer':'CANARY_WRITER'},props=dict(bytesToday=10,queueDepth=True,linesByName={'proxy.request':2,'CANARY_BODY':1},droppedByReason={'daily_cap':1,'CANARY_BODY':2},writeErrors=-1)),dt.datetime.now(dt.timezone.utc))
        self.assertEqual(row['props'],dict(bytesToday=10,linesByName={'proxy.request':2},droppedByReason={'daily_cap':1}))
        self.assertNotIn('CANARY',json.dumps(row))


if __name__ == '__main__':
    unittest.main()

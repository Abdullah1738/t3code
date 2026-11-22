import datetime as dt
import importlib.machinery
import importlib.util
import io
import json
import os
from pathlib import Path
import stat
import subprocess
import sys
import tempfile
import time
import unittest
from unittest.mock import patch

HERE = Path(__file__).resolve().parents[1]
REPO = HERE.parents[1]
sys.path.insert(0, str(HERE))
import toollog
import jobs
import collector
from rollup import rollup


def load(name, path):
    loader = importlib.machinery.SourceFileLoader(name, str(path))
    spec = importlib.util.spec_from_loader(name, loader)
    module = importlib.util.module_from_spec(spec)
    loader.exec_module(module)
    return module


class LoggingTests(unittest.TestCase):
    def test_janitor_summary_and_phases_survive_the_real_logger_without_free_text(self):
        scripts = REPO / 'integrations/dev-resource-janitor/skill/scripts'
        sys.path.insert(0, str(scripts))
        import dev_janitor as janitor
        summary = janitor.leftover_processes.unavailable_report('process_scan_failed')['mcp_summary']
        with patch.object(janitor, 'emit', side_effect=toollog.emit):
            janitor.log_run(time.monotonic(), 3, 0, True, {'sessions': 1.2, 'processes.owner_recovery': 45.6}, summary)
        self.assertEqual(self.rows()[0]['props']['mcp_summary'], summary)
        self.assertFalse(self.rows()[0]['ok'])
        self.assertEqual(self.rows()[1]['props'], dict(found=3, killed=0,
                         phase_ms={'sessions': 1.2, 'processes.owner_recovery': 45.6}))
        poisoned = {**summary, 'command': 'secret-value', 'reason': 'secret-value',
                    'keep_reasons': {'unknown_owner': 2, 'secret-value': 1},
                    'families': {'secret-value': dict(count=1), 'cua-driver': dict(count=1, command='secret-value')},
                    'owner_calls': {'by_native': dict(count=1, p50_ms=1, p95_ms=1, max_ms=1,
                                                     failures={'503': 1, 'secret-value': 1})}}
        clean = toollog.safe_fields({'mcp_summary': poisoned}, 'janitor.mcp_summary')
        self.assertNotIn('secret-value', json.dumps(clean))
        self.assertEqual(clean['mcp_summary']['keep_reasons'], {'unknown_owner': 2})
        clean = toollog.safe_fields({'phase_ms': {'sessions': 1.2, 'secret-value': 1,
                                                'docker': float('inf'), 'expo': -1}}, 'janitor.run')
        self.assertEqual(clean, {'phase_ms': {'sessions': 1.2}})

    def test_inventory_summaries_preserve_only_bounded_metadata(self):
        root = '/Volumes/ExternalSSD/board-wt'
        values = {root:dict(deniedCount=2, timedOutCount=1, backedOffCount=1,
                           estimatedCount=2, completeWithDenied=True,
                           slowest1Path=root+'/child',slowest1Ms=600000,
                           privateContents='must not log')}
        clean = toollog.safe_fields(dict(roots=values), 'disk.inventory')
        self.assertEqual(clean['roots'][root]['slowest1Ms'], 600000)
        self.assertNotIn('privateContents', clean['roots'][root])
        self.assertEqual(toollog.safe_fields(dict(secondsByRoot={root:600}), 'disk.deep.end'),
                         dict(secondsByRoot={root:600}))
        self.assertEqual(toollog.safe_fields(dict(secondsByRoot={root:float('nan')}), 'disk.deep.end'),
                         dict(secondsByRoot={}))
        self.assertEqual(toollog.safe_fields(dict(roots=values)), {})

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.logs = self.root / 'logs'
        env = patch.dict(os.environ, TOOLLOG_DIR=str(self.logs))
        env.start()
        self.addCleanup(env.stop)
        probes = patch.object(jobs, 'storage_probes', return_value={})
        probes.start()
        self.addCleanup(probes.stop)

    def rows(self):
        return [json.loads(line) for p in sorted(self.logs.glob('*.ndjson')) for line in p.read_text().splitlines()]

    def test_format_privacy_modes_and_never_raises(self):
        now = dt.datetime(2026, 11, 13, 0, 0, 0, 123000, tzinfo=dt.timezone.utc)
        toollog.emit('backup', 'perf', 'backup.run', now=now, ok=True, duration_ms=1.2,
                     props={'bytes': 12, 'password': 'sensitive', 'health': 40, 'message': 'private text',
                            'package': 'Bearer abc', 'fromVersion': '4111111111111111', 'target': 'health'},
                     ids={'threadId': 'thread:test', 'token': 'abc'})
        row = self.rows()[0]
        self.assertEqual(row['ts'], '2026-11-13T00:00:00.123Z')
        self.assertEqual(row['props'], {'bytes': 12, 'target': 'health'})
        self.assertEqual(row['ids']['threadId'], 'thread:test')
        self.assertIn('runId',row['ids'])
        self.assertEqual(row['tool'], 'mac')
        self.assertEqual(stat.S_IMODE(self.logs.stat().st_mode), 0o700)
        self.assertEqual(stat.S_IMODE(next(self.logs.glob('*.ndjson')).stat().st_mode), 0o600)
        for kwargs in [dict(props={'bytes': float('nan')}), dict(props=object()), dict(name='bad\nname')]:
            args = dict(component='disk', kind='event', name='disk.sample')
            args.update(kwargs)
            toollog.emit(**args)
        with patch.object(toollog.os, 'open', side_effect=OSError('secret command output')):
            toollog.emit('disk', 'error', 'disk.sample', error_tag='disk.failed')
        self.assertNotIn('secret command output', str(self.rows()))

    def test_cap_retention_and_errors_survive(self):
        self.logs.mkdir()
        old = self.logs / '2026-09-01.ndjson'
        old.write_text('old')
        keep = self.logs / '2026-10-14.ndjson'
        keep.write_text('keep')
        now = dt.datetime(2026, 11, 13, tzinfo=dt.timezone.utc)
        with patch.object(toollog, 'CAP_BYTES', 1):
            for _ in range(4):
                toollog.emit('disk', 'event', 'disk.sample', now=now)
            toollog.emit('disk', 'error', 'disk.sample', now=now, error_tag='disk.failed')
        rows = [json.loads(x) for x in (self.logs / '2026-11-13.ndjson').read_text().splitlines()]
        self.assertEqual([r['name'] for r in rows], ['disk.sample', 'log.cap', 'disk.sample'])
        self.assertFalse(old.exists())
        self.assertTrue(keep.exists())
        self.assertEqual(rows[-1]['kind'], 'error')

    def test_invalid_numeric_fields_do_not_discard_a_record(self):
        for value in (10**400, -10**400, float('nan'), float('inf'), float('-inf'),
                      True, None, '123', {}, []):
            with self.subTest(value=value):
                count = len(self.rows())
                toollog.emit('disk', 'perf', 'disk.sample', duration_ms=value,
                             props={'externalFreeGb': 737, 'inventorySourceErrors': value})
                rows = self.rows()
                self.assertEqual(len(rows), count+1)
                self.assertEqual(rows[-1]['props'], {'externalFreeGb': 737})
                self.assertNotIn('durationMs', rows[-1])
        for value in (0, 1, -1, 1.5):
            with self.subTest(valid=value):
                toollog.emit('disk', 'event', 'disk.swing', props={'externalFreeGbDelta': value})
                self.assertEqual(self.rows()[-1]['props']['externalFreeGbDelta'], value)

    def test_rollup_fixture_and_quantiles(self):
        now = dt.datetime(2026, 11, 13, tzinfo=dt.timezone.utc)
        for value in range(1, 21):
            toollog.emit('disk', 'perf', 'disk.sample', now=now, duration_ms=value, ok=True)
        toollog.emit('backup', 'error', 'backup.run', now=now, ok=False,
                     ids={'runId': 'test:one'}, error_tag='backup.failed')
        with (self.logs / '2026-11-13.ndjson').open('a') as stream:
            stream.write('{broken\n')
        result = rollup('2026-11-13')
        self.assertEqual(result['durationMs']['disk.sample'], {'p50': 10, 'p95': 19, 'max': 20})
        self.assertEqual(result['countsByName'], {'disk.sample': 20, 'backup.run': 1})
        self.assertEqual(result['okRate'], 20/21)
        self.assertEqual(result['errorRate'], 1/21)
        self.assertEqual(result['topErrors'][0]['sampleIds'], {'runId': 'test:one'})
        self.assertEqual(result['malformed'], 1)
        self.assertEqual(stat.S_IMODE((self.logs / 'rollup-2026-11-13.json').stat().st_mode), 0o600)

    def test_disk_growth_baseline_success_and_failure(self):
        watch = self.root / 'watch'; watch.mkdir()
        (watch / 'tmp_kb').write_text('1024')
        paths = []
        for i in range(7):
            p = self.root / ('db%d' % i); p.write_bytes(b'x'); paths.append(p)
        jobs.disk_sample(watch, self.root/'temp', volumes=(self.root, self.root), paths=paths)
        for i,p in enumerate(paths):
            p.write_bytes(b'x'*(i+2))
        jobs.disk_sample(watch, self.root/'temp', volumes=(self.root, self.root), paths=paths)
        rows = self.rows()
        self.assertEqual(rows[0]['props']['baseline'], 1)
        self.assertEqual(rows[-1]['props']['count'], 5)
        self.assertEqual(rows[-1]['props']['grower1Path'], str(paths[-1]))
        jobs.disk_sample(watch, self.root/'temp', volumes=('/missing-one','/missing-two'), paths=paths)
        self.assertFalse(self.rows()[-1]['ok'])
        for code in ('0','1'):
            jobs.main(['alert', code])
        self.assertEqual([r['name'] for r in self.rows()][-2:], ['disk.alert','disk.alert'])
        self.assertEqual([r['ok'] for r in self.rows()][-2:], [True,False])

    def test_backup_summary_is_whitelisted_and_age_tracks_snapshots(self):
        summary=json.dumps(dict(total_bytes_processed=123,total_files_processed=4,password='banned',path='private'))
        with patch.object(jobs.time,'time',return_value=100):
            jobs.backup_run('health',90,0,0,99,summary)
        with patch.object(jobs.time,'time',return_value=110):
            jobs.backup_run('health',105,3,1,0,'failed with password')
        a,b=self.rows()
        self.assertEqual(a['props']['bytes'],123)
        self.assertEqual(a['props']['files'],4)
        self.assertEqual(a['props']['snapshotAgeS'],1)
        self.assertNotIn('snapshotAgeS', b['props'])
        self.assertEqual(b['props']['resticExitCode'],3)
        self.assertNotIn('banned',str(self.rows()))
        self.assertNotIn('failed with password',str(self.rows()))

    def test_cve_entrypoint_and_fix_success_failure_no_commands(self):
        cve=load('cve_test',REPO/'integrations/cve-sweep/cve-sweep')
        cve.STATE=str(self.root/'cve-state')
        report=dict(findings=[dict(kind='npm',severity='HIGH',name='pkg',version='1.0')],errors=[],actions=[dict(ok=True)])
        with patch.object(cve,'scan',return_value=report), patch.object(cve,'REPORTS',str(self.root/'reports')), \
             patch.object(cve,'HOLD_FILE',str(self.root/'hold.txt')), \
             patch.object(sys,'argv',['cve-sweep','--no-fix','--json']), patch('sys.stdout',new_callable=io.StringIO):
            cve.main()
        with patch.object(cve,'scan',side_effect=RuntimeError('password=secret')), patch.object(cve,'REPORTS',str(self.root/'reports')), patch.object(cve,'HOLD_FILE',str(self.root/'hold.txt')):
            with self.assertRaises(RuntimeError):
                cve.main()
        for ok in (True,False):
            actions=cve.FixActions(report)
            actions.append(dict(ok=ok,what='pkg 1.0 -> 1.1',did='npm install -g'))
        self.assertEqual([r['name'] for r in self.rows()],['sweep.run','sweep.run','sweep.fix','sweep.fix'])
        self.assertEqual([r['ok'] for r in self.rows()],[True,False,True,False])
        self.assertEqual(self.rows()[0]['props']['high'],1)
        self.assertEqual(self.rows()[2]['props']['fromVersion'],'1.0')
        self.assertNotIn('password',str(self.rows()))

    def test_janitor_hourly_entrypoint_and_kills_success_failure(self):
        scripts=REPO/'integrations/dev-resource-janitor/skill/scripts'
        sys.path.insert(0,str(scripts))
        import dev_janitor as janitor
        import janitor_watch as watcher
        state=self.root/'worker';state.mkdir()
        resources=[dict(id='expo:1',kind='expo',candidate=True,age_s=7200),
                   dict(id='container:local',kind='container',candidate=True,age_s=7400,image='localstack/localstack')]
        scan=dict(ts=0,liveness_unavailable=None,processes=dict(candidates=[],problems=[],checked=0,skipped=0,budget_skipped=0,
                  agent_browser=dict(inventory=[],candidates=[],problems=[],actions=[],reap_enabled=False),
                  xcode_builds=dict(inventory=[],candidates=[],problems=[],actions=[],stop_enabled=False),
                  owner_calls={key: dict(count=0,p50_ms=None,p95_ms=None,max_ms=None,failures={}) for key in ('by_native','detail','recovery')}),resources=resources,candidates=[r['id'] for r in resources])
        with patch.object(watcher,'STATE_DIR',state), patch.object(janitor,'scan',return_value=scan), \
             patch.object(janitor,'act',side_effect=[(True,'done'),(False,'password=secret')]), \
             patch.object(janitor,'audit'), patch.object(janitor,'sh',return_value=(1,'','')), \
             patch.object(janitor,'LOG_DIR',str(state)), patch.object(janitor,'LAST',str(state/'last.json')):
            with (state/'lock').open('w') as lock:
                self.assertEqual(watcher.worker(lock.fileno()),1)
        self.assertEqual([r['name'] for r in self.rows()],['janitor.kill','janitor.kill','janitor.mcp_summary','janitor.run'])
        self.assertEqual(self.rows()[0]['props']['resourceKind'],'metro')
        self.assertEqual(self.rows()[1]['props']['resourceKind'],'localstack')
        self.assertEqual(self.rows()[-1]['props'],{'found':2,'killed':1,'phase_ms':{}})
        with patch.object(janitor,'run',return_value=(0,0,True)):
            janitor.main()
        self.assertTrue(self.rows()[-1]['ok'])
        self.assertNotIn('password',str(self.rows()))

    def test_crash_readonly_cursor_and_midnight_rollup(self):
        reports=self.root/'reports'; reports.mkdir()
        now=dt.datetime(2026,11,13,0,6,tzinfo=dt.timezone.utc).timestamp()
        for name in ['kernel.panic','Finder_2026-11-13.ips','app.spin']:
            p=reports/name;p.write_text('{"app_name":"Finder","bug_type":"309"}\nprivate stack')
            os.utime(p,(now-100,now-100))
        reader=lambda a,b: {('restart','kernel'):1} if a==now-3600 else {}
        toollog.emit('backup', 'perf', 'backup.run', ok=True,
                     now=dt.datetime.fromtimestamp(now-86400, dt.timezone.utc),
                     props={'target':'memory', 'skipped':1})
        self.assertTrue(collector.collect(now, [reports], reader))
        observed=[r for r in self.rows() if r['name']=='crash.observed']
        self.assertEqual(sum(r['props']['count'] for r in observed),4)
        self.assertTrue((self.logs/'rollup-2026-11-12.json').exists())
        rollup_props = next(r['props'] for r in self.rows() if r['name']=='log.rollup')
        self.assertEqual(rollup_props['backup.skipped_runs.memory'], 1)
        self.assertEqual(rollup_props['backup.ok_runs.memory'], 0)
        self.assertEqual(rollup_props['backup.skipped_runs.health'], 0)
        collector.collect(now+1,[reports],lambda a,b:{})
        self.assertEqual(len([r for r in self.rows() if r['name']=='crash.observed']),4)
        collector.collect(now+2,[reports],lambda a,b: (_ for _ in ()).throw(RuntimeError('secret')))
        self.assertFalse(self.rows()[-1]['ok'])
        self.assertEqual(jobs.read_state('crashes')['unified'],now+1)
        self.assertNotIn('private stack',str(self.rows()))

    def test_unified_timestamp_forms_on_system_python(self):
        forms = ['1970-01-01 00:02:30.123456+0000', '1970-01-01T00:02:30.123456+00:00',
                 '1970-01-01T00:02:30.123456Z', '1969-12-31 20:02:30.123456-0400',
                 '1970-01-01 00:02:30.123456']
        from types import SimpleNamespace
        for timestamp in forms:
            with self.subTest(timestamp=timestamp):
                run=lambda *a,**kw: SimpleNamespace(returncode=0,stdout=json.dumps([dict(timestamp=timestamp,eventMessage='=== system boot')]))
                self.assertEqual(sum(collector.unified(100,200,run).values()),1)
                self.assertEqual(sum(collector.unified(150.123456,200,run).values()),0)

    def test_diagnostic_type_classification(self):
        root=self.root/'diagnostics';root.mkdir()
        for bug,expected in [('109','app_crash'),('309','app_crash'),('210','panic'),
                             ('288',None),('298',None),('142',None),('145',None),('999',None)]:
            with self.subTest(bug=bug):
                p=root/(bug+'.ips');p.write_text(json.dumps(dict(bug_type=bug,app_name='Fixture'))+'\n')
                os.utime(p,(150,150))
                counts=collector.reports(root,100,200)
                self.assertEqual(sum(counts.values()),sum(int(q.stem in ('109','309','210')) for q in root.iterdir()))
                if expected:
                    self.assertIn((expected,'kernel' if expected=='panic' else 'Fixture'),counts)

    def test_directory_inventory_detects_cache_and_worktree_growth(self):
        from types import SimpleNamespace
        cache=self.root/'cache';cache.mkdir()
        worktree=self.root/'worktree';worktree.mkdir()
        for root in (cache,worktree):
            (root/'child').mkdir()
        def make_due():
            state=jobs.read_state('disk-inventory')
            for children in state.get('childState',{}).values():
                for value in children.values():
                    value['at']-=86400
            jobs.save_state('disk-inventory',state)
        value=[100]
        def run(cmd,**kwargs):
            self.assertEqual(cmd[:2],['/usr/bin/du','-skl'])
            return SimpleNamespace(returncode=0,stdout=str(value[0])+'\t'+cmd[-1])
        jobs.directory_inventory([cache,worktree],run)
        jobs.disk_sample(self.root,self.root,volumes=(self.root,self.root),paths=[])
        value[0]=200
        make_due()
        jobs.directory_inventory([cache,worktree],run)
        jobs.disk_sample(self.root,self.root,volumes=(self.root,self.root),paths=[])
        row=self.rows()[-1]
        self.assertEqual(row['props']['count'],2)
        self.assertGreater(row['props']['grower1DeltaGb'],0)
        make_due()
        jobs.directory_inventory([cache],lambda *a,**kw: SimpleNamespace(returncode=1,stdout='private error'))
        self.assertFalse(self.rows()[-1]['ok'])
        self.assertEqual(self.rows()[-1]['name'],'disk.inventory')

    def test_janitor_partial_failure_keeps_completed_counts(self):
        scripts=REPO/'integrations/dev-resource-janitor/skill/scripts';sys.path.insert(0,str(scripts))
        import dev_janitor as janitor
        import janitor_watch as watcher
        resources=[dict(id='expo:1',kind='expo',candidate=True),dict(id='expo:2',kind='expo',candidate=True)]
        scan=dict(ts=0,liveness_unavailable=None,processes=dict(candidates=[],problems=[],checked=0,skipped=0,budget_skipped=0,
                  agent_browser=dict(inventory=[],candidates=[],problems=[],actions=[],reap_enabled=False),
                  xcode_builds=dict(inventory=[],candidates=[],problems=[],actions=[],stop_enabled=False),
                  owner_calls={key: dict(count=0,p50_ms=None,p95_ms=None,max_ms=None,failures={}) for key in ('by_native','detail','recovery')}),resources=resources,candidates=['expo:1','expo:2'])
        for entry in ('cli','hourly'):
            with self.subTest(entry=entry), patch.object(janitor,'scan',return_value=scan), \
                 patch.object(janitor,'act',side_effect=[(True,'done'),RuntimeError('failed')]), \
                 patch.object(janitor,'audit'),patch.object(janitor,'LOG_DIR',str(self.root)), \
                 patch.object(janitor,'LAST',str(self.root/'last.json')), patch.object(watcher,'STATE_DIR',self.root):
                if entry=='cli':
                    with patch.object(sys,'argv',['janitor','apply','--ids','expo:1,expo:2']), self.assertRaises(RuntimeError):
                        janitor.main()
                else:
                    with (self.root/'lock').open('w') as lock:
                        self.assertEqual(watcher.worker(lock.fileno()),1)
                self.assertEqual(self.rows()[-1]['props'],{'found':2,'killed':1,'phase_ms':{}})
                self.assertFalse(self.rows()[-1]['ok'])

    def test_cve_owner_and_browser_action_forms(self):
        cve=load('cve_forms',REPO/'integrations/cve-sweep/cve-sweep')
        cve.STATE=str(self.root/'cve-state')
        for finding in [dict(kind='electron',severity='MODERATE'),dict(kind='macos-update',severity='MODERATE'),
                        dict(kind='npm',name='node',severity='LOW')]:
            self.assertTrue(cve.needs_owner(finding,{'node'}))
        self.assertFalse(cve.needs_owner(dict(kind='npm',name='pkg',severity='LOW'),set()))
        for old in ('156.0.1.2','156.0.1.2, 155.0.1.2'):
            for ok in (True,False):
                with self.subTest(old=old,ok=ok):
                    actions=cve.FixActions(dict(findings=[],chrome_stable='157.0.1.2'))
                    actions.append(dict(did='agent-browser install + removed old Chrome',what=old,ok=ok))
                    self.assertEqual(self.rows()[-1]['props'],dict(package='agent-browser-chrome',fromVersion='156.0.1.2',toVersion='157.0.1.2'))

    def test_all_cve_action_formats_retain_identity_and_versions(self):
        cve=load('cve_all_actions',REPO/'integrations/cve-sweep/cve-sweep')
        cve.STATE=str(self.root/'cve-state')
        findings=[dict(name='pkg',version='1.0'),dict(name='@scope/pkg',version='1.0'),
                  dict(name='brew-a',version='1.1'),dict(name='brew-b',version='1.2'),
                  dict(path='/fixture/cache with space',version='1.3'),
                  dict(kind='pip',site='/fixture/uv/tools/uvtool/lib/python/site',name='dependency',version='9.0')]
        cases=[
            ('deleted','/fixture/cache with space',[('cache with space','1.3','removed')]),
            ('deleted stale puppeteer browser','/fixture/cache with space',[('cache with space','1.3','removed')]),
            ('npm uninstall -g','@scope/pkg (/fixture/node/lib/node_modules)',[('@scope/pkg','1.0','removed')]),
            ('pip uninstall','pkg',[('pkg','1.0','removed')]),
            ('agent-browser install + removed old Chrome','156.0.1.2, 155.0.1.2',[('agent-browser-chrome','156.0.1.2','157.0.1.2')]),
            ('brew upgrade','brew-a',[('brew-a','1.1','2.0')]),
            ('brew upgrades blocked: Command Line Tools/Xcode too old','brew-a, brew-b',[('brew-a','1.1','unknown'),('brew-b','1.2','unknown')]),
            ('needs approval (major bump)','pkg 1.0 -> 2.0',[('pkg','1.0','2.0')]),
            ('no fixed release upstream yet (already latest in major)','pkg 1.0',[('pkg','1.0','unknown')]),
            ('waiting (npm min-release-age 7d)','@scope/pkg 1.0',[('@scope/pkg','1.0','unknown')]),
            ('npm install -g','@scope/pkg 1.0 -> 2.0 (v26.13.1)',[('@scope/pkg','1.0','2.0')]),
            ('pip install --user','pkg 1.0 -> 2.0 (python3.9)',[('pkg','1.0','2.0')]),
            ('uv tool upgrade','uvtool',[('uvtool','0.5','2.0')]),
        ]
        with patch.object(cve,'local_uv_version',return_value='0.5') as uv:
            actions=cve.FixActions(dict(findings=findings,chrome_stable='157.0.1.2'))
            uv.return_value='2.0'
            for operation,what,expected in cases:
                for ok in (True,False):
                    with self.subTest(operation=operation,what=what,ok=ok), \
                         patch.object(cve.os.path,'exists',return_value=True), \
                         patch.object(cve.os.path,'realpath',return_value='/fixture/Cellar/pkg/2.0'):
                        before=len(self.rows())
                        actions.append(dict(did=operation,what=what,ok=ok))
                        rows=self.rows()[before:]
                        self.assertEqual(len(rows),len(expected))
                        for row,(package,old,new) in zip(rows,expected):
                            if not ok and (operation in ('uv tool upgrade','brew upgrade') or 'deleted' in operation or 'uninstall' in operation):
                                new='unknown'
                            self.assertEqual(row['props'],dict(package=package,fromVersion=old,toVersion=new))
                            self.assertEqual(row['ok'],ok)

    def test_unified_reader_only_uses_log_show(self):
        from types import SimpleNamespace
        calls=[]
        def run(cmd,**kwargs):
            calls.append(cmd)
            return SimpleNamespace(returncode=0,stdout=json.dumps([
                {'timestamp':'1970-01-01T00:02:30Z','eventMessage':'=== system boot'},
                {'timestamp':'1970-01-01T00:02:30Z','eventMessage':'PMU wdog'}]))
        self.assertEqual(sum(collector.unified(100,200,run).values()),2)
        self.assertEqual(calls[0][:3],['/usr/bin/log','show','--style'])
        self.assertNotIn('private',str(self.rows()))


class FakeDiskutil:
    def __init__(self, outcome='ok', reap_timeout=False):
        self.pid = 4321
        self.outcome = outcome
        self.returncode = None
        self.killed = False
        self.reaped = False
        self.reap_timeout = reap_timeout
        self.stdout = io.BytesIO()
        self.stderr = None

    def communicate(self, timeout):
        if self.killed:
            if self.reap_timeout:
                raise subprocess.TimeoutExpired('diskutil', timeout)
            self.reaped = True
            self.returncode = -9
            return b'', None
        if self.outcome == 'timeout':
            assert timeout == 20
            raise subprocess.TimeoutExpired('diskutil', timeout)
        if self.outcome == 'error':
            raise OSError('private failure')
        import plistlib
        self.returncode = 0
        return (plistlib.dumps({'WholeDisks': ['disk0', 'disk3']})
                if self.outcome == 'ok' else b'invalid plist'), None

    def kill(self):
        self.killed = True


class DiskProbeTests(unittest.TestCase):
    rows = LoggingTests.rows

    def setUp(self):
        LoggingTests.setUp(self)
        self.commands = []
        self.addCleanup(self.assert_read_only_commands)

    def assert_read_only_commands(self):
        for cmd in self.commands:
            self.assertNotIn(Path(cmd[0]).name, ('sudo', 'kill', 'killall'))

    def runner(self, absent=False, sample_fail=False, notify_fail=False, ps_form='present'):
        from types import SimpleNamespace
        def run(cmd, **kwargs):
            self.commands.append(cmd)
            if cmd[0] == '/bin/ps':
                self.assertEqual(kwargs['timeout'], 3)
                if ps_form == 'timeout':
                    raise subprocess.TimeoutExpired(cmd, kwargs['timeout'])
                if ps_form == 'unreadable':
                    raise OSError('ps unavailable')
                if ps_form == 'nonzero':
                    return SimpleNamespace(returncode=1, stdout='')
                if ps_form == 'malformed':
                    return SimpleNamespace(returncode=0, stdout='80846 invalid Ss /usr/libexec/storagekitd')
                return SimpleNamespace(returncode=0, stdout='' if absent else
                    ' PID ELAPSED STAT COMM\n 80846 1-02:03:04 Ss /usr/libexec/storagekitd\n'
                    ' 137 03:04 S /usr/libexec/diskarbitrationd\n')
            if cmd[0] == '/usr/bin/hdiutil':
                self.assertEqual(kwargs['timeout'], 10)
                return SimpleNamespace(returncode=0)
            if cmd[0] == '/usr/bin/sample':
                self.assertEqual(kwargs['timeout'], 15)
                self.assertFalse(self.child.killed)
                if sample_fail:
                    raise subprocess.TimeoutExpired(cmd, 15)
                Path(cmd[-1]).write_text('    + 10 -[SKHelperClient syncAllDisks]\nprivate stack\n')
                return SimpleNamespace(returncode=0)
            self.assertEqual(cmd[0], '/Users/ardud/.bun/bin/bun')
            self.assertNotIn('BUN_INSPECT', kwargs['env'])
            self.notifications.append(cmd)
            if notify_fail:
                raise OSError('private notify failure')
            return SimpleNamespace(returncode=0)
        return run

    def probe(self, outcome='ok', **kwargs):
        self.child = FakeDiskutil(outcome)
        self.notifications = getattr(self, 'notifications', [])
        return collector.disk_tooling_probe(self.runner(**kwargs),
                    lambda *a, **kw: self.child, lambda pid: False)

    def test_probe_ok_and_absent_daemons_survive_schema(self):
        for absent in (False, True):
            with self.subTest(absent=absent):
                self.probe(absent=absent)
                row = self.rows()[-1]
                self.assertEqual(row['name'], 'disk.tooling_probe')
                self.assertTrue(row['ok'])
                self.assertEqual(row['props']['diskCount'], 2)
                self.assertFalse(row['props']['timedOut'])
                self.assertEqual(row['props']['exitCode'], 0)
                if absent:
                    self.assertNotIn('storagekitdPid', row['props'])
                    self.assertNotIn('storagekitdUptimeS', row['props'])
                else:
                    self.assertEqual(row['props']['storagekitdPid'], 80846)
                    self.assertEqual(row['props']['storagekitdUptimeS'], 93784)
                self.assertEqual(row['props']['storagekitdStat'], None if absent else 'Ss')
                self.assertEqual(row['props']['diskarbitrationdUptimeS'], None if absent else 184)
                self.assertTrue(row['props']['hdiutilOk'])
                self.assertGreaterEqual(row['props']['hdiutilMs'], 0)
                self.assertFalse(jobs.state_path('disk-tooling-pid').exists())
        self.assertEqual(self.notifications, [])

    def test_probe_timeout_samples_then_kills_and_reaps(self):
        self.probe('timeout')
        row = self.rows()[-1]
        self.assertFalse(row['ok'])
        self.assertTrue(row['props']['timedOut'])
        self.assertEqual(row['props']['exitCode'], -9)
        self.assertIsNone(row['props']['diskCount'])
        self.assertEqual(row['props']['blockedIn'], 'SKHelperClient')
        sample = Path(row['props']['samplePath'])
        self.assertTrue(sample.is_file())
        self.assertEqual(sample.parent, self.logs/'state/diskutil-samples')
        self.assertEqual(stat.S_IMODE(sample.stat().st_mode), 0o600)
        self.assertTrue(self.child.killed)
        self.assertTrue(self.child.reaped)
        self.assertFalse(jobs.state_path('disk-tooling-pid').exists())
        self.assertNotIn('private stack', str(self.rows()))

    def test_sleeping_diskutil_alert_and_numeric_process_metadata(self):
        sleeper = self.root / 'diskutil.py'
        sleeper.write_text('import time\ntime.sleep(60)\n')
        self.notifications = []
        spawned = []
        real_popen = subprocess.Popen
        def popen(cmd, **kwargs):
            self.assertEqual(cmd, ['/usr/sbin/diskutil', 'list', '-plist'])
            self.child = child = real_popen([sys.executable, '-I', str(sleeper)], **kwargs)
            spawned.append(child)
            child.killed = False
            communicate = child.communicate
            def bounded_communicate(timeout):
                # Exercise a real sleeping child without waiting the production 20 s.
                return communicate(timeout=0.05 if timeout == 20 else timeout)
            child.communicate = bounded_communicate
            return child
        with patch.object(subprocess, 'Popen', wraps=real_popen) as subprocesses:
            try:
                # Use the spy for fixture launches as well as any accidental subprocess.
                real_popen = subprocesses
                for _ in range(2):
                    collector.disk_tooling_probe(self.runner(), popen, lambda pid: False)
                self.assertEqual(len(spawned), 2)
                self.assertTrue(all(child.poll() == -9 for child in spawned))
            finally:
                for child in spawned:
                    if child.poll() is None:
                        child.kill()
                        child.wait(timeout=5)
        for call in subprocesses.call_args_list:
            self.assertNotIn(Path(call.args[0][0]).name, ('sudo', 'kill', 'killall'))
        self.assertEqual(len(self.notifications), 1)
        cmd = self.notifications[0]
        text = cmd[cmd.index('--text')+1]
        self.assertIn('sudo killall storagekitd', text)
        self.assertIn('If diskutil list still times out after 10 s, run: sudo kill -9 80846', text)
        self.assertIn('(pid 80846, up 26.1h)', text)
        row = self.rows()[-1]
        self.assertTrue(row['props']['timedOut'])
        for key, value in [('storagekitdPid', 80846), ('storagekitdUptimeS', 93784)]:
            self.assertEqual(row['props'][key], value)
            self.assertIs(type(row['props'][key]), int)

    def test_unavailable_ps_omits_numeric_storagekitd_fields(self):
        for form in ('absent', 'nonzero', 'timeout', 'unreadable', 'malformed'):
            with self.subTest(form=form):
                self.probe('timeout', absent=form == 'absent', ps_form=form)
                row = self.rows()[-1]
                self.assertTrue(row['props']['timedOut'])
                self.assertNotIn('storagekitdPid', row['props'])
                self.assertNotIn('storagekitdUptimeS', row['props'])
                self.assertNotIn('probeError', row['props'])
        cmd = self.notifications[0]
        text = cmd[cmd.index('--text')+1]
        self.assertIn('(pid unknown, up unknown)', text)
        self.assertIn('sudo kill -9 <pid>', text)
        self.assertNotIn('sudo kill -9 None', text)

    def test_probe_previous_child_and_overlapping_collector_skip(self):
        import fcntl
        jobs.save_state('disk-tooling-pid', {'pid': 4321})
        with patch.object(collector.subprocess, 'Popen') as popen:
            collector.disk_tooling_probe(self.runner(), popen, lambda pid: pid == 4321)
            self.assertEqual(self.rows()[-1]['props']['skipped'], 'previous-probe-still-running')
            self.assertNotIn('ok', self.rows()[-1])
            popen.assert_not_called()
            with (jobs.state_path('disk-tooling-pid').parent/'disk-tooling.lock').open('a') as lock:
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
                collector.disk_tooling_probe(self.runner(), popen)
                self.assertEqual(self.rows()[-1]['props']['skipped'], 'previous-probe-still-running')
                popen.assert_not_called()

    def test_two_timeouts_alert_once_and_restart_has_new_incident(self):
        with patch.dict(os.environ, {'BUN_INSPECT': 'do-not-inherit'}):
            self.probe('timeout')
            self.assertEqual(self.notifications, [])
            self.probe('timeout')
            self.probe('timeout')
            self.assertEqual(len(self.notifications), 1)
            cmd = self.notifications[0]
            self.assertEqual(cmd[cmd.index('--key')+1], 'mac-upkeep:diskutil-hang:80846')
            self.probe('ok')
            self.probe('timeout')
            self.probe('timeout')
            self.assertEqual(len(self.notifications), 1)
            # A changed daemon must accumulate two fresh timeouts.
            props = dict(storagekitdPid=88888, storagekitdUptimeS=10, timedOut=True)
            collector.alert(props, self.runner())
            self.assertEqual(len(self.notifications), 1)
            collector.alert(props, self.runner())
            self.assertEqual(len(self.notifications), 2)
            self.assertEqual(self.notifications[-1][-1], 'mac-upkeep:diskutil-hang:88888')

    def test_success_breaks_consecutive_timeouts(self):
        for outcome in ('timeout', 'invalid', 'timeout', 'ok', 'timeout'):
            self.probe(outcome)
        self.assertEqual(self.notifications, [])

    def test_notify_failure_is_logged_and_retried(self):
        self.probe('timeout')
        self.probe('timeout', notify_fail=True)
        self.assertEqual(self.rows()[-1]['name'], 'disk.tooling_probe')
        alerts = [r for r in self.rows() if r['name'] == 'disk.tooling_alert']
        self.assertFalse(alerts[-1]['ok'])
        self.probe('timeout')
        self.probe('timeout')
        self.assertEqual(len(self.notifications), 2)
        self.assertNotIn('private notify failure', str(self.rows()))

    def test_notify_retry_freezes_text_as_uptime_changes(self):
        self.notifications = []
        props = dict(storagekitdPid=80846, storagekitdUptimeS=3600, timedOut=True)
        collector.alert(props, self.runner())
        collector.alert(props, self.runner(notify_fail=True))
        props['storagekitdUptimeS'] = 7200
        collector.alert(props, self.runner())
        self.assertEqual(self.notifications[0], self.notifications[1])

    def test_sample_failure_still_kills_child_and_old_samples_expire(self):
        root = jobs.state_path('disk-tooling-pid').parent/'diskutil-samples'
        root.mkdir()
        old, fresh = root/'diskutil-old.sample', root/'diskutil-fresh.sample'
        old.touch(); fresh.touch()
        os.utime(old, (time.time()-8*86400,)*2)
        self.probe('timeout', sample_fail=True)
        self.assertTrue(self.child.killed)
        self.assertTrue(self.child.reaped)
        self.assertEqual(self.rows()[-1]['props']['blockedIn'], 'unknown')
        self.assertFalse(old.exists())
        self.assertTrue(fresh.exists())

    def test_failed_reap_retains_pid_and_next_probe_skips(self):
        self.child = FakeDiskutil('timeout', reap_timeout=True)
        collector.disk_tooling_probe(self.runner(), lambda *a, **kw: self.child, lambda pid: False)
        self.assertEqual(jobs.read_state('disk-tooling-pid')['pid'], 4321)
        with patch.object(collector.subprocess, 'Popen') as popen:
            collector.disk_tooling_probe(self.runner(), popen, lambda pid: True)
            popen.assert_not_called()
        self.assertTrue(self.child.stdout.closed)

    def test_surviving_child_retries_failed_alert_without_spawning(self):
        self.probe('timeout')
        self.child = FakeDiskutil('timeout', reap_timeout=True)
        collector.disk_tooling_probe(self.runner(notify_fail=True),
                                    lambda *a, **kw: self.child, lambda pid: False)
        self.assertEqual(len(self.notifications), 1)
        samples = self.logs/'state/diskutil-samples'
        old = samples/'diskutil-old.sample'
        old.touch(); os.utime(old, (time.time()-8*86400,)*2)
        with patch.object(collector.subprocess, 'Popen') as popen:
            collector.disk_tooling_probe(self.runner(), popen, lambda pid: True)
            collector.disk_tooling_probe(self.runner(), popen, lambda pid: True)
            popen.assert_not_called()
        self.assertEqual(len(self.notifications), 2)
        self.assertEqual(self.notifications[0], self.notifications[1])
        self.assertFalse(old.exists())
        self.assertEqual(jobs.read_state('disk-tooling-alert')['consecutiveTimeouts'], 2)
        self.assertEqual(self.rows()[-1]['props']['skipped'], 'previous-probe-still-running')

    def test_surviving_child_alert_state_matrix(self):
        self.notifications = []
        key = 'mac-upkeep:diskutil-hang:80846'
        for count, alerted in [(0, False), (1, False), (2, True)]:
            with self.subTest(count=count, alerted=alerted):
                jobs.save_state('disk-tooling-alert', dict(pid=80846, consecutiveTimeouts=count,
                                alertedKey=key if alerted else None))
                jobs.save_state('disk-tooling-pid', {'pid': 4321})
                with patch.object(collector.subprocess, 'Popen') as popen:
                    collector.disk_tooling_probe(self.runner(), popen, lambda pid: True)
                    popen.assert_not_called()
                self.assertEqual(jobs.read_state('disk-tooling-alert')['consecutiveTimeouts'], count)
        self.assertEqual(self.notifications, [])

    def test_pending_alert_survives_skip_daemon_lookup_forms(self):
        from types import SimpleNamespace
        key = 'mac-upkeep:diskutil-hang:80846'
        # All missing-data forms preserve the incident; a known changed PID
        # starts a new one. No skipped lookup advances the timeout streak.
        for form in ('present', 'absent', 'nonzero', 'timeout', 'restarted'):
            with self.subTest(form=form):
                self.notifications = []
                jobs.save_state('disk-tooling-alert', dict(pid=80846, consecutiveTimeouts=2,
                                pendingKey=key, pendingText='fixed incident message'))
                jobs.save_state('disk-tooling-pid', {'pid': 4321})
                base = self.runner(absent=form == 'absent')
                def run(cmd, **kwargs):
                    if cmd[0] == '/bin/ps':
                        if form == 'nonzero':
                            return SimpleNamespace(returncode=1, stdout='')
                        if form == 'timeout':
                            raise subprocess.TimeoutExpired(cmd, 3)
                        if form == 'restarted':
                            return SimpleNamespace(returncode=0, stdout='88888 00:02 Ss /usr/libexec/storagekitd')
                    return base(cmd, **kwargs)
                with patch.object(collector.subprocess, 'Popen') as popen:
                    collector.disk_tooling_probe(run, popen, lambda pid: True)
                    collector.disk_tooling_probe(run, popen, lambda pid: True)
                    popen.assert_not_called()
                state = jobs.read_state('disk-tooling-alert')
                self.assertEqual(state['pid'], 88888 if form == 'restarted' else 80846)
                self.assertEqual(state['consecutiveTimeouts'], 0 if form == 'restarted' else 2)
                self.assertEqual(len(self.notifications), 0 if form == 'restarted' else 1)
                if self.notifications:
                    self.assertEqual(self.notifications[0][-1], key)
                    self.assertIn('fixed incident message', self.notifications[0])

    def test_exception_paths_reap_and_do_not_break_collector(self):
        for outcome in ('error', 'invalid'):
            self.probe(outcome)
            self.assertFalse(self.rows()[-1]['ok'])
            self.assertFalse(jobs.state_path('disk-tooling-pid').exists())
            if outcome == 'error':
                self.assertTrue(self.child.reaped)
        with patch.object(collector, 'homebrew_integrity'), patch.object(collector, 'disk_wait'), patch.object(collector, 'directory_inventory'), patch.object(collector, 'collect') as collect, \
             patch.object(collector, 'state_path', side_effect=OSError('private state failure')):
            collector.main()
            collect.assert_called_once()
        self.assertNotIn('private state failure', str(self.rows()))

    def test_blocking_frame_forms(self):
        from types import SimpleNamespace
        root = jobs.state_path('disk-tooling-pid').parent
        cases = [('    + 10 -[SKHelperClient syncAllDisks]', 'SKHelperClient'),
                 ('    ! 10 +[SKManager initializedManager]', 'SKManager'),
                 ('       10 DiskArbitration`waitForReply', 'DiskArbitration'),
                 ('    | 10 DASessionCopyDiskDescription', 'DASession'),
                 ('       10 mach_msg2_trap', 'unknown'),
                 ('Binary Images: DiskArbitration', 'unknown')]
        for frame, expected in cases:
            with self.subTest(frame=frame):
                def run(cmd, **kwargs):
                    Path(cmd[-1]).write_text(frame+'\n')
                    return SimpleNamespace(returncode=0)
                self.assertEqual(collector.sample_child(4321, root, run)['blockedIn'], expected)

    def test_stale_marker_does_not_skip_reused_unrelated_pid(self):
        from types import SimpleNamespace
        with patch.object(collector.os, 'kill'):
            for command, expected in [('/usr/sbin/diskutil', True), ('/usr/bin/python3', False)]:
                self.assertEqual(collector.alive(4321, lambda *a, **kw:
                    SimpleNamespace(returncode=0, stdout=command)), expected)
        with patch.object(collector.os, 'kill', side_effect=ProcessLookupError):
            self.assertFalse(collector.alive(4321))

    def test_etime_forms(self):
        cases = [('00:01', 1), ('59:59', 3599), ('01:02:03', 3723),
                 ('3-01:02:03', 262923), ('12-00:00:00', 1036800)]
        for value, expected in cases:
            with self.subTest(value=value):
                self.assertEqual(collector.elapsed_seconds(value), expected)

    def test_disk_rollup_counts_skips_and_latest_by_timestamp(self):
        now = dt.datetime(2026, 11, 13, tzinfo=dt.timezone.utc)
        for minute, timeout, skipped, blocked in [(1, False, False, None), (3, True, False, 'SKHelperClient'),
                                                  (2, True, False, 'DASession'), (4, False, True, None)]:
            props = dict(timedOut=timeout)
            if skipped:
                props['skipped'] = 'previous-probe-still-running'
            if blocked:
                props['blockedIn'] = blocked
            toollog.emit('disk', 'event', 'disk.tooling_probe', now=now.replace(minute=minute),
                         duration_ms=None if skipped else (20000 if timeout else 10), props=props)
        result = rollup('2026-11-13')
        self.assertEqual(result['diskTooling'], dict(probes=3, timeouts=2, maxDurationMs=20000,
                                                    latestBlockedIn='SKHelperClient'))


if __name__ == "__main__":
    unittest.main()

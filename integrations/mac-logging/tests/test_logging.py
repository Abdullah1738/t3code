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
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.logs = self.root / 'logs'
        env = patch.dict(os.environ, TOOLLOG_DIR=str(self.logs))
        env.start()
        self.addCleanup(env.stop)

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
        self.assertEqual(b['props']['snapshotAgeS'],11)
        self.assertEqual(b['props']['resticExitCode'],3)
        self.assertNotIn('password',str(self.rows()))

    def test_cve_entrypoint_and_fix_success_failure_no_commands(self):
        cve=load('cve_test',REPO/'integrations/cve-sweep/cve-sweep')
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
        scan=dict(resources=resources,candidates=[r['id'] for r in resources])
        with patch.object(watcher,'STATE_DIR',state), patch.object(janitor,'scan',return_value=scan), \
             patch.object(janitor,'act',side_effect=[(True,'done'),(False,'password=secret')]), \
             patch.object(janitor,'audit'), patch.object(janitor,'sh',return_value=(1,'','')), \
             patch.object(janitor,'LOG_DIR',str(state)), patch.object(janitor,'LAST',str(state/'last.json')):
            with (state/'lock').open('w') as lock:
                self.assertEqual(watcher.worker(lock.fileno()),1)
        self.assertEqual([r['name'] for r in self.rows()],['janitor.kill','janitor.kill','janitor.run'])
        self.assertEqual(self.rows()[0]['props']['resourceKind'],'metro')
        self.assertEqual(self.rows()[1]['props']['resourceKind'],'localstack')
        self.assertEqual(self.rows()[-1]['props'],{'found':2,'killed':1})
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
        reader=lambda a,b: {} if a==now else {('restart','kernel'):1}
        self.assertTrue(collector.collect(now, [reports], reader))
        observed=[r for r in self.rows() if r['name']=='crash.observed']
        self.assertEqual(sum(r['props']['count'] for r in observed),4)
        self.assertTrue((self.logs/'rollup-2026-11-12.json').exists())
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
        value=[100]
        def run(cmd,**kwargs):
            self.assertEqual(cmd[:2],['/usr/bin/du','-sk'])
            return SimpleNamespace(returncode=0,stdout=str(value[0])+'\t'+cmd[-1])
        jobs.directory_inventory([cache,worktree],run)
        jobs.disk_sample(self.root,self.root,volumes=(self.root,self.root),paths=[])
        value[0]=200
        jobs.directory_inventory([cache,worktree],run)
        jobs.disk_sample(self.root,self.root,volumes=(self.root,self.root),paths=[])
        row=self.rows()[-1]
        self.assertEqual(row['props']['count'],2)
        self.assertGreater(row['props']['grower1DeltaGb'],0)
        jobs.directory_inventory([cache],lambda *a,**kw: SimpleNamespace(returncode=1,stdout='private error'))
        self.assertFalse(self.rows()[-1]['ok'])
        self.assertEqual(self.rows()[-1]['name'],'disk.inventory')

    def test_janitor_partial_failure_keeps_completed_counts(self):
        scripts=REPO/'integrations/dev-resource-janitor/skill/scripts';sys.path.insert(0,str(scripts))
        import dev_janitor as janitor
        import janitor_watch as watcher
        resources=[dict(id='expo:1',kind='expo',candidate=True),dict(id='expo:2',kind='expo',candidate=True)]
        scan=dict(resources=resources,candidates=['expo:1','expo:2'])
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
                self.assertEqual(self.rows()[-1]['props'],{'found':2,'killed':1})
                self.assertFalse(self.rows()[-1]['ok'])

    def test_cve_owner_and_browser_action_forms(self):
        cve=load('cve_forms',REPO/'integrations/cve-sweep/cve-sweep')
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
            return SimpleNamespace(returncode=0,stdout=json.dumps([{'eventMessage':'=== system boot'},{'eventMessage':'PMU wdog'}]))
        self.assertEqual(sum(collector.unified(100,200,run).values()),2)
        self.assertEqual(calls[0][:3],['/usr/bin/log','show','--style'])
        self.assertNotIn('private',str(self.rows()))


if __name__=='__main__':
    unittest.main()

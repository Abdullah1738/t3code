import datetime as dt
import json
import os
from pathlib import Path
import shlex
import subprocess
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import cpu
import jobs
import toollog
import volume_crawls as scans

START = 'Mon Nov 16 12:00:00 2026'
HOME = '/Users/ardud'
THREAD = 'thread:project:ardud-opencode-import%3Aproject%3A%2FVolumes%2FExternalSSD%2Ft3code-fork:9f8eac7c-6e27-4c74-afd7-5f97f8e5ae5e'


def fixture(command='/usr/bin/rg', args='rg --files /Volumes/ExternalSSD', state='S', age='01:00'):
    # Exactly the header and fixed-column padding produced by Darwin ps.
    prefix = f'50 20 0:02.00 2048 {state} {START} {age} 501 {command}'
    offset = 180
    return ' '*offset+'SCAN_ARGV\n'+prefix.ljust(offset)+args+'\n'


class VolumeCrawlTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.env = patch.dict(os.environ, TOOLLOG_DIR=self.tmp.name)
        self.env.start()
        self.addCleanup(self.env.stop)
        self.calls = []

    def run_lsof(self, argv, **kwargs):
        self.calls.append((argv, kwargs))
        return SimpleNamespace(returncode=0, stdout='p50\nfcwd\nn/Volumes/ExternalSSD\n')

    def events(self):
        return [json.loads(line) for path in Path(self.tmp.name).glob('*.ndjson') for line in path.read_text().splitlines()]

    def sample(self, text=None, cwd='/Volumes/ExternalSSD', previous=None, run=None):
        rows = cpu.parse_ps(fixture() if text is None else text)
        self.assertEqual(rows[0]['family'], 'rg' if text is None else rows[0]['family'])
        if run is None:
            def run(argv, **kwargs):
                self.calls.append((argv,kwargs))
                return SimpleNamespace(returncode=0,stdout='p50\nfcwd\nn'+cwd+'\n')
        scans.volume_crawls(rows, previous or {}, 120, run, home=HOME)
        return self.events()

    def test_root_and_parent_chain_and_cpu_delta(self):
        rows = cpu.parse_ps(fixture())
        for pid, ppid in [(20, 10), (10, 1), (1, 0)]:
            rows.append(dict(rows[0],pid=pid,ppid=ppid,comm='/bin/zsh',args='zsh'))
        rows[1].update(comm='/usr/bin/node',args='node /source/t3ctl.mjs wait '+THREAD)
        previous = dict(at=60,processes={'50':dict(start=START,cpuS=1)})
        scans.volume_crawls(rows, previous, 120, self.run_lsof, HOME)
        event = self.events()[0]
        self.assertEqual(event['name'],'scan.volume_crawl')
        props = event['props']
        self.assertEqual(props['pid'],50)
        self.assertEqual(props['ppid'],20)
        self.assertEqual(props['parentChain'],[dict(pid=20,name='node'),dict(pid=10,name='zsh'),dict(pid=1,name='zsh')])
        self.assertEqual(props['threadId'],THREAD)
        self.assertEqual(props['elapsedS'],60)
        self.assertAlmostEqual(props['cpuPct'],1/60*100,places=3)
        self.assertEqual(props['argv'],['/usr/bin/rg','/Volumes/ExternalSSD'])
        self.assertEqual(self.calls[0][1]['timeout'],2)
        self.assertEqual(self.calls[0][0][:5],['/usr/sbin/lsof','-a','-d','cwd','-p'])

    def test_operand_class(self):
        volume, repo = '/Volumes/ExternalSSD', '/Volumes/ExternalSSD/t3code-fork/repo'
        cases = [
            ('rg --files /Volumes/ExternalSSD',repo,True),
            ('rg -n foo src/',repo,False),
            ('rg foo /Volumes/ExternalSSD/t3code-fork/src',volume,False),
            ('rg --files',volume,True),
            ('rg --files .',volume,True),
            ('rg -uu foo',volume,True),
            ('rg -g "*.py" -e foo /',repo,True),
            ('rg --regexp=foo --glob=src /Volumes/ExternalSSD/t3code-wt',repo,True),
            ('rg -efoo /Volumes/Other',repo,True),
            ('rg -f patterns /Users/ardud',repo,True),
            ('rg foo /Volumes/ExternalSSD/a/../t3code-wt/',repo,True),
            ('rg foo ~/project',volume,False),
            ('rg foo ~',repo,True),
            ('rg -- --weird-pattern src',repo,False),
        ]
        for args, cwd, hit in cases:
            with self.subTest(args=args,cwd=cwd),patch.object(scans,'emit') as emit:
                rows=cpu.parse_ps(fixture(args=args))
                run = lambda *a,**kw:SimpleNamespace(returncode=0,stdout='p50\nfcwd\nn'+cwd+'\n')
                scans.volume_crawls(rows,{},120,run,HOME)
                self.assertEqual(emit.called,hit)

    def test_every_tool_and_default_root(self):
        for tool,args in [('du','du -xk -d 2 /Volumes/ExternalSSD'),
                          ('find','find -H /Volumes/ExternalSSD -name .git -print'),
                          ('fd','fd -H foo /Volumes/ExternalSSD'),
                          ('ncdu','ncdu /'),('dust','dust -d 2 /Users/ardud'),
                          ('du','du'),('find','find . -name foo'),('fd','fd foo')]:
            with self.subTest(tool=tool,args=args),patch.object(scans,'emit') as emit:
                scans.volume_crawls(cpu.parse_ps(fixture('/usr/bin/'+tool,args)),{},120,self.run_lsof,HOME)
                self.assertTrue(emit.called)

    def test_repo_cwd_with_default_root_misses(self):
        self.assertEqual(self.sample(fixture(args='rg foo'),cwd='/Volumes/ExternalSSD/t3code-fork/src'),[])

    def test_lsof_exit_or_timeout_preserves_explicit_root(self):
        for run in (lambda *a,**kw:SimpleNamespace(returncode=1,stdout=''),
                    lambda *a,**kw:(_ for _ in ()).throw(subprocess.TimeoutExpired('lsof',2))):
            with self.subTest(run=run),patch.object(scans,'emit') as emit:
                scans.volume_crawls(cpu.parse_ps(fixture()),{},120,run,HOME)
                self.assertIsNone(emit.call_args.kwargs['props']['cwd'])
                self.assertIsNone(emit.call_args.kwargs['props']['cpuPct'])

    def test_exiting_or_young_pid_skips_cwd_probe(self):
        for state,age in [('?E','01:00'),('S','00:29')]:
            with self.subTest(state=state),patch.object(scans,'cwd_snapshot') as cwd:
                self.sample(fixture(state=state,age=age))
                cwd.assert_not_called()
        self.assertEqual(self.events(),[])

    def test_pid_exits_during_lsof_and_survivor_remains(self):
        result=SimpleNamespace(returncode=1,stdout='p51\nfcwd\nn/Volumes/ExternalSSD\n')
        self.assertEqual(scans.cwd_snapshot([50,51],lambda *a,**kw:result),{51:'/Volumes/ExternalSSD'})

    def test_bad_row_does_not_drop_other_processes(self):
        data=fixture()+''.join(f'{i} 1 0:01.00 1024 S {START} 01:00 501 /bin/sh\n' for i in range(100,111))+'gone\n'
        diag={}
        rows=cpu.parse_ps(data,diag)
        self.assertEqual(diag['skippedLines'],1)
        self.assertEqual(len(rows),12)
        self.assertEqual(rows[0]['args'],'rg --files /Volumes/ExternalSSD')

    def test_paths_are_retained_and_query_contents_omitted(self):
        self.sample(fixture(args='rg -e private-query /Volumes/ExternalSSD/secret-cache'))
        props=self.events()[0]['props']
        self.assertEqual(props['argv'],['/usr/bin/rg','/Volumes/ExternalSSD/secret-cache'])
        self.assertNotIn('private-query',json.dumps(props))

    def test_one_shared_ps_snapshot_and_no_argv_in_state(self):
        def run(argv,**kwargs):
            self.calls.append(argv)
            if argv==cpu.PS:
                return SimpleNamespace(returncode=0,stdout=fixture())
            if argv[0]=='/usr/sbin/lsof':
                return SimpleNamespace(returncode=0,stdout='p50\nfcwd\nn/Volumes/ExternalSSD\n')
            raise AssertionError(argv)
        with patch.object(cpu,'hints',return_value=None),patch.object(cpu.os,'getloadavg',return_value=(0,0,0)):
            cpu.sample(run=run,ticks_read=lambda:(1,2,3,4),children_read=lambda *a,**kw:({},{}),reader_factory=lambda:False)
        self.assertEqual(sum(argv[0]=='/bin/ps' for argv in self.calls),1)
        saved=jobs.read_state('cpu')
        self.assertNotIn('args',json.dumps(saved))
        self.assertEqual([e['name'] for e in self.events()],['scan.volume_crawl','cpu.sample'])

    def test_hourly_wrapper_preserves_du_options_roots_and_lock(self):
        argv=['/usr/bin/du','-skl','/Volumes/ExternalSSD/t3code-wt/repo']
        with patch.object(jobs.sys,'platform','darwin'):
            self.assertEqual(jobs.disk_throttle(argv),['/usr/sbin/taskpolicy','-d','throttle',*argv])
        with patch.object(jobs.sys,'platform','linux'):
            self.assertIs(jobs.disk_throttle(argv),argv)

    def test_corrupt_prior_state_and_data_aliases(self):
        for prior in ({'processes':None},{'processes':{'50':False}},{'at':False}):
            with self.subTest(prior=prior),patch.object(scans,'emit') as emit:
                scans.volume_crawls(cpu.parse_ps(fixture()),prior,120,self.run_lsof,HOME)
                self.assertIsNone(emit.call_args.kwargs['props']['cpuPct'])
        for path in ('/Volumes/Data/Volumes/ExternalSSD','/System/Volumes/Data/Users/ardud'):
            with self.subTest(path=path),patch.object(scans,'emit') as emit:
                scans.volume_crawls(cpu.parse_ps(fixture(args='rg foo '+path)),{},120,self.run_lsof,HOME)
                self.assertTrue(emit.called)

    def test_record_operand_budget_is_explicit(self):
        props=dict(pid=1,ppid=0,argv=['/usr/bin/du']+['/Volumes/ExternalSSD/'+'a'*100]*1000,
                   cwd='/Users/ardud',elapsedS=30,cpuPct=None,parentChain=[],threadId=None)
        record=toollog.record('scan','event','scan.volume_crawl',dt.datetime.now(dt.timezone.utc),props=props)
        self.assertLessEqual(len((json.dumps(record,separators=(',',':'))+'\n').encode()),8192)
        self.assertEqual(len(record['props']['argv'])+record['props']['argvOmitted'],1001)

    def test_ps_padded_comm_class(self):
        for comm,state in [('/usr/bin/rg','S'),('/usr/bin/du','U'),
                           ('/Applications/My App.app/Helper','S'),('(rg)','?E')]:
            with self.subTest(comm=comm,state=state):
                row=cpu.parse_ps(fixture(command=comm,state=state))[0]
                self.assertEqual(row['comm'],comm.strip('()'))
                self.assertEqual(row['args'],'rg --files /Volumes/ExternalSSD')

    def test_prefix_and_value_option_class(self):
        cases=[('find','find -x -E -s /Volumes/ExternalSSD -name foo',True),
               ('find','find -H /Volumes/ExternalSSD/repo/src -name foo',False),
               ('rg','rg --pre /Volumes/ExternalSSD foo src/',False),
               ('rg','rg --replace /Volumes/ExternalSSD foo src/',False),
               ('fd','fd --search-path /Volumes/ExternalSSD pattern',True),
               ('fd','fd --search-path=/Volumes/ExternalSSD pattern',True),
               ('fd','fd --base-directory /Volumes/ExternalSSD pattern',True),
               ('fd','fd --base-directory /Volumes/ExternalSSD pattern repo/src',False)]
        for tool,args,hit in cases:
            with self.subTest(args=args),patch.object(scans,'emit') as emit:
                scans.volume_crawls(cpu.parse_ps(fixture('/usr/bin/'+tool,args)),{},120,
                                   lambda *a,**kw:SimpleNamespace(returncode=0,stdout='p50\nfcwd\nn/Users/ardud/repo/src\n'),HOME)
                self.assertEqual(emit.called,hit)

    def test_review_option_arity_class(self):
        cases=[('fd',"fd -g '*.py' src/",False),
               ('fd',"fd --glob '*.py' /Volumes/ExternalSSD",True),
               ('fd',"fd -g '*.py' /Volumes/ExternalSSD",True),
               ('fd',"fd -e py pattern /Volumes/ExternalSSD",True),
               ('rg','rg --replace replacement private-query /Volumes/ExternalSSD',True),
               ('rg','rg -rreplacement private-query /Volumes/ExternalSSD',True),
               ('rg','rg -nrreplacement private-query /Volumes/ExternalSSD',True),
               ('rg','rg --replace replacement /Volumes/ExternalSSD src/',False),
               ('rg','rg --type-add special:*.py private-query /Volumes/ExternalSSD',True),
               ('rg','rg --unknown-option private-query /Volumes/ExternalSSD',False),
               ('find','find -f /Volumes/ExternalSSD -name foo',True),
               ('find','find -f src/ -name foo',False),
               ('find','find -s src/ -name foo',False)]
        for tool,args,hit in cases:
            with self.subTest(args=args),patch.object(scans,'emit') as emit:
                run = lambda *a,**kw:SimpleNamespace(returncode=0,stdout='p50\nfcwd\nn/Volumes/ExternalSSD/t3code-fork/repo\n')
                scans.volume_crawls(cpu.parse_ps(fixture('/usr/bin/'+tool,args)),{},120,run,HOME)
                self.assertEqual(emit.called,hit)
                if hit:
                    self.assertNotIn('private-query',json.dumps(emit.call_args.kwargs['props']))
                    self.assertNotIn('replacement',json.dumps(emit.call_args.kwargs['props']))

    def test_relative_operand_cwd_class(self):
        for tool,args in [('rg','rg -n foo src/'),('rg','rg -- --pattern src'),
                          ('fd',"fd -g '*.py' src/"),('find','find -s src/ -name foo')]:
            for cwd,hit in [('/Volumes/ExternalSSD',True),
                            ('/Volumes/ExternalSSD/t3code-fork/repo',False)]:
                with self.subTest(args=args,cwd=cwd),patch.object(scans,'emit') as emit:
                    run = lambda *a,**kw:SimpleNamespace(returncode=0,stdout='p50\nfcwd\nn'+cwd+'\n')
                    scans.volume_crawls(cpu.parse_ps(fixture('/usr/bin/'+tool,args)),{},120,run,HOME)
                    self.assertEqual(emit.called,hit)

    def test_log_non_operand_string_budget_class(self):
        for value in ('thread:'+'a'*9000,'thread:'+'界'*9000,'thread:invalid whitespace'):
            with self.subTest(value=value[:30]):
                props=dict(pid=50,ppid=20,elapsedS=30,cpuPct=None,
                           threadId=value,cwd='/'+'界'*9000,argv=['/'+'界'*9000],
                           parentChain=[dict(pid=p,name='界'*9000) for p in range(4)])
                row=toollog.record('scan','event','scan.volume_crawl',dt.datetime.now(dt.timezone.utc),props=props)
                self.assertLessEqual(len((json.dumps(row,separators=(',',':'))+'\n').encode()),8192)
                self.assertIsNone(row['props']['threadId'])
                self.assertIsNone(row['props']['cwd'])
                self.assertEqual(row['props']['stringsOmitted'],2)
                self.assertEqual(row['props']['argvOmitted'],1)

    def test_pattern_source_and_literal_option_class(self):
        cases=[('rg','rg src/ -e private-query',['src/']),
               ('rg','rg /Volumes/ExternalSSD -e private-query',['/Volumes/ExternalSSD']),
               ('rg','rg src/ --regexp=private-query',['src/']),
               ('rg','rg src/ -eprivate-query',['src/']),
               ('rg','rg src/ -f patterns',['src/']),
               ('rg','rg src/ --file=patterns',['src/']),
               ('rg','rg src/ -fpatterns',['src/']),
               ('rg','rg -- --files src/',['src/']),
               ('fd','fd -- --files src/',['src/']),
               ('rg','rg --files src/',['src/']),
               ('rg','rg private-query -',[])]
        for tool,args,paths in cases:
            words=shlex.split(args)[1:]
            with self.subTest(args=args):
                self.assertEqual(scans.search_paths(tool,words),paths)
            for cwd in ('/Volumes/ExternalSSD','/Volumes/ExternalSSD/t3code-fork/repo'):
                with self.subTest(args=args,cwd=cwd),patch.object(scans,'emit') as emit:
                    run=lambda *a,**kw:SimpleNamespace(returncode=0,stdout='p50\nfcwd\nn'+cwd+'\n')
                    scans.volume_crawls(cpu.parse_ps(fixture('/usr/bin/'+tool,args)),{},120,run,HOME)
                    hit=bool(paths) and (paths==['/Volumes/ExternalSSD'] or cwd=='/Volumes/ExternalSSD')
                    self.assertEqual(emit.called,hit)
                    if hit:
                        logged=emit.call_args.kwargs['props']['argv']
                        self.assertNotIn('private-query',json.dumps(logged))
                        self.assertNotIn('/Volumes/ExternalSSD/--files',logged)

    def test_dust_boolean_and_ncdu_import_class(self):
        for flags in ('-t','--file_types','--file-types','-rt'):
            for root in ('/Volumes/ExternalSSD','src/','/Volumes/ExternalSSD/repo/src'):
                with self.subTest(flags=flags,root=root),patch.object(scans,'emit') as emit:
                    run=lambda *a,**kw:SimpleNamespace(returncode=0,stdout='p50\nfcwd\nn/Volumes/ExternalSSD/t3code-fork/repo\n')
                    scans.volume_crawls(cpu.parse_ps(fixture('/usr/bin/dust','dust '+flags+' '+root)),{},120,run,HOME)
                    self.assertEqual(emit.called,root=='/Volumes/ExternalSSD')
        for args in ('ncdu -f /saved.json','ncdu -f/saved.json','ncdu -xf /saved.json',
                     'ncdu -f -','ncdu -f-','ncdu /Volumes/ExternalSSD'):
            with self.subTest(args=args),patch.object(scans,'emit') as emit:
                scans.volume_crawls(cpu.parse_ps(fixture('/usr/bin/ncdu',args)),{},120,self.run_lsof,HOME)
                self.assertEqual(emit.called,args=='ncdu /Volumes/ExternalSSD')

    def test_thread_identity_context_class(self):
        cases=[('/bin/sh',"sh -c 'rg -e thread:needle /Volumes/ExternalSSD; true'",None),
               ('/bin/zsh','zsh -c "echo '+THREAD+'"',None),
               ('/usr/bin/rg','rg -e '+THREAD+' /Volumes/ExternalSSD',None),
               ('/usr/bin/node','node /source/t3ctl.mjs send '+THREAD+' text',THREAD),
               ('/usr/bin/bun','bun /source/t3ctl.mjs events --thread='+THREAD,THREAD),
               ('/usr/bin/t3ctl','t3ctl events --thread '+THREAD,THREAD),
               ('/usr/bin/t3ctl','t3ctl send thread:needle text',None)]
        for comm,args,expected in cases:
            with self.subTest(comm=comm,args=args),patch.object(scans,'emit') as emit:
                rows=cpu.parse_ps(fixture())
                rows.append(dict(rows[0],pid=20,ppid=1,comm=comm,args=args))
                scans.volume_crawls(rows,{},120,self.run_lsof,HOME)
                self.assertEqual(emit.call_args.kwargs['props']['threadId'],expected)

    def test_parse_error_diagnostics_exclude_argv_class(self):
        for text in (fixture().replace('0:02.00','NaN'),fixture(state='!')):
            text=text.replace('rg --files /Volumes/ExternalSSD','rg -e query-sentinel /Volumes/ExternalSSD')
            def run(argv,**kwargs):
                self.assertEqual(argv,cpu.PS)
                return SimpleNamespace(returncode=0,stdout=text)
            with patch.object(cpu,'rusage_reader',return_value=False):
                self.assertEqual(cpu.sample(run=run)['failure'],'parse')
        self.assertNotIn('query-sentinel',json.dumps(self.events()))

    def test_bsd_find_prefix_forms_class(self):
        for root,hit in [('/Volumes/ExternalSSD',True),('/',True),(HOME,True),
                         ('/Volumes/ExternalSSD/t3code-wt',True),
                         ('/Volumes/ExternalSSD/t3code-fork/apps/server/src',False)]:
            for prefix in [['--',root],['-sx',root],['-f'+root],['-sxf'+root],
                           ['-H','-f',root],['-E','-X','-d','-L',root]]:
                for cwd in ('/Volumes/ExternalSSD','/Volumes/ExternalSSD/t3code-fork/repo'):
                    with self.subTest(prefix=prefix,cwd=cwd),patch.object(scans,'emit') as emit:
                        argv=prefix+['-name','private-query','-exec','echo','/Volumes/Other',';']
                        self.assertEqual(scans.search_paths('find',argv),[root])
                        text=fixture('/usr/bin/find','find '+shlex.join(argv))
                        run=lambda *a,**kw:SimpleNamespace(returncode=0,stdout='p50\nfcwd\nn'+cwd+'\n')
                        scans.volume_crawls(cpu.parse_ps(text),{},120,run,HOME)
                        self.assertEqual(emit.called,hit)
                        if hit:
                            self.assertEqual(emit.call_args.kwargs['props']['argv'],['/usr/bin/find',root])

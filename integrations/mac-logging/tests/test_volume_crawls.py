import datetime as dt
import json
import os
from pathlib import Path
import shlex
import subprocess
import sys
import tempfile
import time
from types import SimpleNamespace
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import cpu
import jobs
import toollog
import volume_crawls as scans
import process_argv

START = 'Mon Nov 16 12:00:00 2026'
HOME = '/Users/ardud'
THREAD = 'thread:project:ardud-opencode-import%3Aproject%3A%2FVolumes%2FExternalSSD%2Ft3code-fork:9f8eac7c-6e27-4c74-afd7-5f97f8e5ae5e'
VECTORS = {}
ARGV_READ = scans.argv_snapshot


def remember(command, args):
    # String literals are test shorthand only. ps renders the resulting vector
    # without quoting; the separate kernel fixture preserves its boundaries.
    words = shlex.split(args) if isinstance(args, str) else args
    raw = ' '.join(words)
    VECTORS[command, raw] = words
    return raw


def fixture(command='/usr/bin/rg', args='rg --files /Volumes/ExternalSSD', state='S', age='01:00', tool=None):
    # Exactly the header and fixed-column padding produced by Darwin ps.
    prefix = f'50 20 0:02.00 2048 {state} {START} {age} 501 {command}'
    tool = Path(command).name.strip('()') if tool is None else tool
    return ' '*160+'SCAN_TOOL'.ljust(20)+'SCAN_ARGV\n'+prefix.ljust(160)+tool.ljust(20)+remember(command,args)+'\n'


class VolumeCrawlTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.env = patch.dict(os.environ, TOOLLOG_DIR=self.tmp.name)
        self.env.start()
        self.addCleanup(self.env.stop)
        self.calls = []
        VECTORS.clear()
        read = patch.object(scans,'argv_snapshot',side_effect=lambda rows,run:
                            {p['pid']:dict(argv=VECTORS[p['comm'],p['args']],executable=p['comm']) for p in rows
                             if (p['comm'],p['args']) in VECTORS})
        self.vector_read = read.start()
        self.addCleanup(read.stop)

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
            rows.append(dict(rows[0],pid=pid,ppid=ppid,comm='/bin/zsh',tool='zsh',args='zsh'))
        rows[1].update(comm='/usr/bin/node',tool='node',args=remember('/usr/bin/node',['node','/source/t3ctl.mjs','wait',THREAD]))
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
                rows.append(dict(rows[0],pid=20,ppid=1,comm=comm,tool=Path(comm).name,args=remember(comm,args)))
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
                        text=fixture('/usr/bin/find',['find',*argv])
                        run=lambda *a,**kw:SimpleNamespace(returncode=0,stdout='p50\nfcwd\nn'+cwd+'\n')
                        scans.volume_crawls(cpu.parse_ps(text),{},120,run,HOME)
                        self.assertEqual(emit.called,hit)
                        if hit:
                            self.assertEqual(emit.call_args.kwargs['props']['argv'],['/usr/bin/find',root])

    def test_unquoted_ps_cannot_supply_argument_boundaries(self):
        cases=[(['rg','-e','prefix private-value','/Volumes/ExternalSSD'],True),
               (['rg','-e','prefix /Volumes/ExternalSSD','src/'],False),
               (['rg','prefix /Volumes/ExternalSSD','src/'],False),
               (['rg','-eprefix private-value','/Volumes/ExternalSSD'],True),
               (['rg','--regexp=prefix private-value','/Volumes/ExternalSSD'],True),
               (['rg','-e',"apostrophe' and back\\slash",'/Volumes/ExternalSSD'],True),
               (['rg','-e','','/Volumes/ExternalSSD'],True),
               (['rg','--files','/Volumes/ExternalSSD/a folder'],True)]
        for words,hit in cases:
            with self.subTest(words=words),patch.object(scans,'emit') as emit:
                raw=fixture(args=words)
                self.assertIn(' '.join(words),raw)
                run=lambda *a,**kw:SimpleNamespace(returncode=0,stdout='p50\nfcwd\nn/Volumes/ExternalSSD/t3code-fork/repo\n')
                scans.volume_crawls(cpu.parse_ps(raw),{},120,run,HOME)
                self.assertEqual(emit.called,hit)
                if hit:
                    self.assertEqual(emit.call_args.kwargs['props']['argv'],['/usr/bin/rg',words[-1]])
        # Identical ps bytes can represent different vectors. With no kernel
        # vector even a simple-looking explicit root must fail closed.
        rows=cpu.parse_ps(fixture(args=['rg','-e','prefix private-value','/Volumes/ExternalSSD']))
        self.vector_read.side_effect=lambda *a,**kw:{}
        with patch.object(scans,'emit') as emit:
            scans.volume_crawls(rows,{},120,self.run_lsof,HOME)
            emit.assert_not_called()

    def test_truncated_comm_uses_kernel_tool_and_executable(self):
        words=['/opt/homebrew/bin/rg','--files','/Volumes/ExternalSSD']
        rows=cpu.parse_ps(fixture(command='/opt/homebrew/b',args=words,tool='rg'))
        self.assertEqual(rows[0]['tool'],'rg')
        self.vector_read.side_effect=lambda *a,**kw:{50:dict(argv=words,executable=words[0])}
        with patch.object(scans,'emit') as emit:
            scans.volume_crawls(rows,{},120,self.run_lsof,HOME)
            self.assertEqual(emit.call_args.kwargs['props']['argv'],[words[0],words[-1]])

    def test_full_comm_last_preserves_cpu_families_and_hints(self):
        self.assertTrue(cpu.PS[-1].endswith('comm='))
        commands=[('/opt/homebrew/Cellar/node/28.0.0/bin/node','node'),
                  ('/opt/homebrew/Cellar/python@3.15/libexec/bin/python3.15','python'),
                  ('/opt/homebrew/Cellar/bun/1.5.0/bin/bun','bun'),
                  ('/Applications/Long App.app/Contents/Frameworks/Long App Helper.app/Contents/MacOS/Long App Helper','Long App Helper')]
        for command,expected in commands:
            with self.subTest(command=command):
                text=f'50 20 0:02.00 2048 S {START} 01:00 501 {command}\n'
                rows=cpu.parse_ps(text)
                self.assertEqual(rows[0]['comm'],command)
                self.assertEqual(rows[0]['family'],expected)
                previous=dict(at=60,processes={'50':dict(start=START,cpuS=1)})
                props,state=cpu.deltas(rows,previous,120)
                self.assertEqual(props['top'][0]['family'],expected)
                self.assertEqual(props['families'][0]['family'],expected)
                children,_=cpu.child_snapshot(rows,reader=lambda pid:dict(start=1,ownS=2,childS=0))
                self.assertEqual(children['50']['family'],expected)
                calls=[]
                def run(argv,**kwargs):
                    calls.append(argv)
                    return SimpleNamespace(returncode=0,stdout=f'50 {START} {command} /Volumes/ExternalSSD/repo/job.py\n')
                cpu.hints(props['top'],rows,run)
                self.assertEqual(bool(calls),expected in ('node','python','bun'))
                if calls:
                    self.assertEqual(props['top'][0]['hint'],'repo/job.py')

    def test_fd_execution_clause_class(self):
        for flag in ('-x','-X','--exec','--exec-batch','-Hx','--exec=echo'):
            for root,hit in [('/Volumes/ExternalSSD',True),
                             ('/Volumes/ExternalSSD/repo/src',False)]:
                for resumed in (False,True):
                    words=['fd','-H','.',root,flag,'echo','{}','/Volumes/Other','--hidden']
                    if resumed:
                        words+=[';','--color','never']
                    with self.subTest(flag=flag,root=root,resumed=resumed),patch.object(scans,'emit') as emit:
                        self.assertEqual(scans.search_paths('fd',words[1:]),[root])
                        scans.volume_crawls(cpu.parse_ps(fixture('/usr/bin/fd',words)),{},120,self.run_lsof,HOME)
                        self.assertEqual(emit.called,hit)
                        if hit:
                            self.assertEqual(emit.call_args.kwargs['props']['argv'],['/usr/bin/fd',root])
            for root in ('/Volumes/ExternalSSD','src/'):
                words=['fd',flag,'echo','{}',';','.',root]
                with self.subTest(flag=flag,resumed_root=root):
                    self.assertEqual(scans.search_paths('fd',words[1:]),[root])

    def test_bounded_kernel_vector_snapshot_class(self):
        rows=cpu.parse_ps(fixture())
        vector=dict(ppid=20,uid=501,startS=int(time.mktime(time.strptime(START,'%a %b %d %H:%M:%S %Y'))),
                    executable='/usr/bin/rg',argv=['rg','-e','prefix private-value','/Volumes/ExternalSSD'])
        for changes in ({},{'ppid':99},{'uid':0},{'startS':1},{'executable':'/bin/sh'},
                        {'argv':['rg','bad\0value']},{'argv':[]}):
            with self.subTest(changes=changes):
                calls=[]
                def run(argv,**kwargs):
                    calls.append((argv,kwargs))
                    return SimpleNamespace(returncode=0,stdout=json.dumps({'50':dict(vector,**changes)}))
                found=ARGV_READ(rows,run)
                self.assertEqual(bool(found),not changes)
                if found:
                    self.assertEqual(found[50]['argv'],vector['argv'])
                self.assertEqual(calls[0][1]['timeout'],2)
                self.assertEqual(calls[0][0][1],'-I')
        for run in (lambda *a,**kw:SimpleNamespace(returncode=1,stdout=''),
                    lambda *a,**kw:SimpleNamespace(returncode=0,stdout='x'*1048577),
                    lambda *a,**kw:SimpleNamespace(returncode=0,stdout='bad json'),
                    lambda *a,**kw:(_ for _ in ()).throw(subprocess.TimeoutExpired('argv',2))):
            self.assertEqual(ARGV_READ(rows,run),{})

    def test_ps_and_kernel_vector_flow_without_quoted_fixture(self):
        words=['rg','-e','prefix private-value','/Volumes/ExternalSSD']
        text=fixture(args=words)
        start=int(time.mktime(time.strptime(START,'%a %b %d %H:%M:%S %Y')))
        calls=[]
        def run(argv,**kwargs):
            calls.append(argv)
            if argv==cpu.PS:
                return SimpleNamespace(returncode=0,stdout=text)
            if argv[0]=='/usr/sbin/lsof':
                return SimpleNamespace(returncode=0,stdout='p50\nfcwd\nn/Volumes/ExternalSSD\n')
            self.assertTrue(argv[2].endswith('/process_argv.py'))
            return SimpleNamespace(returncode=0,stdout=json.dumps({'50':dict(
                argv=words,executable='/usr/bin/rg',startS=start,ppid=20,uid=501)}))
        with patch.object(scans,'argv_snapshot',wraps=ARGV_READ),patch.object(cpu,'hints',return_value=None),patch.object(cpu.os,'getloadavg',return_value=(0,0,0)):
            for _ in range(2):
                cpu.sample(run=run,ticks_read=lambda:(1,2,3,4),children_read=lambda *a,**kw:({},{}),reader_factory=lambda:False)
        self.assertEqual(len(calls),5)
        self.assertEqual(calls.count(cpu.PS),2)
        self.assertEqual(sum(call[0] == sys.executable for call in calls),1)
        self.assertTrue(jobs.read_state('cpu')['volumeCrawlCache'])
        self.assertEqual(self.events()[0]['props']['argv'],['/usr/bin/rg','/Volumes/ExternalSSD'])
        self.assertNotIn('private-value',json.dumps(self.events()))
        self.assertNotIn('private-value',json.dumps(jobs.read_state('cpu')))


class KernelArgvTests(unittest.TestCase):
    def blob(self,argv,executable='/usr/bin/rg'):
        header=os.fsencode(executable)+b'\0'
        header+=b'\0'*((-len(header))%8)
        return (len(argv).to_bytes(4,sys.byteorder,signed=True)+header+
                b'\0'.join(os.fsencode(a) for a in argv)+b'\0'+b'PRIVATE_ENV=do-not-emit\0')

    def test_nul_vectors_preserve_boundary_class_and_exclude_environment(self):
        for args in (['rg','-e','prefix private-value','/Volumes/ExternalSSD'],
                     ['rg','-e',"quote' slash\\",'/Volumes/ExternalSSD/a folder'],
                     ['rg','-e','','/Volumes/ExternalSSD'],['rg','--files','/Volumes/ExternalSSD/界']):
            with self.subTest(args=args):
                executable,words=process_argv.decode_args(self.blob(args))
                self.assertEqual(executable,'/usr/bin/rg')
                self.assertEqual(words,args)
                self.assertNotIn('PRIVATE_ENV',json.dumps(words))
        for data in (b'',b'\0'*10,(4097).to_bytes(4,sys.byteorder)+b'\0'*30,
                     self.blob(['rg'])[:17],b'x'*(process_argv.MAX_BYTES+1)):
            with self.subTest(size=len(data)),self.assertRaises(ValueError):
                process_argv.decode_args(data)

    def test_leading_empty_argv_class_preserves_environment_boundary(self):
        # Cross every executable-path alignment with leading, interior and
        # trailing empty arguments. None may consume the environment sentinel.
        for length in range(8):
            executable='/usr/bin/tool'+'x'*length
            for argv in (['','/Volumes/ExternalSSD'],['','','/Volumes/ExternalSSD'],
                         [''],['','',''],['du','','/Volumes/ExternalSSD','']):
                with self.subTest(length=length,argv=argv):
                    data=self.blob(argv,executable)
                    exe,words=process_argv.decode_args(data)
                    self.assertEqual((exe,words),(executable,argv))
                    identity=lambda pid:(pid,20,501,1234,500)
                    values=process_argv.collect([50],lambda pid:process_argv.read_process(pid,identity,lambda pid:data))
                    self.assertNotIn('PRIVATE_ENV',json.dumps(values))

    def test_identity_race_and_read_failure_class(self):
        identity=(50,20,501,1234,500)
        for after in (identity,(50,20,501,1235,500),(50,20,501,1234,501),
                      (50,21,501,1234,500)):
            with self.subTest(after=after):
                states=iter([identity,after])
                if after==identity:
                    value=process_argv.read_process(50,lambda pid:next(states),lambda pid:self.blob(['rg']))
                    self.assertEqual(value['argv'],['rg'])
                else:
                    with self.assertRaises(ValueError):
                        process_argv.read_process(50,lambda pid:next(states),lambda pid:self.blob(['rg']))
        def read(pid):
            if pid==1:
                raise PermissionError('denied')
            if pid==2:
                raise ProcessLookupError('exited')
            return dict(argv=['rg','--files','/Volumes/ExternalSSD'])
        self.assertEqual(set(process_argv.collect([1,2,3],read)),{'3'})

    def test_per_tick_pid_and_output_bounds(self):
        calls=[]
        def read(pid):
            calls.append(pid)
            return dict(argv=['rg','x'*20000])
        result=process_argv.collect(list(range(1000)),read)
        self.assertEqual(len(calls),process_argv.MAX_PIDS)
        self.assertLessEqual(len(json.dumps(result).encode()),process_argv.MAX_OUTPUT)


SESSION = '21860509-c0e3-429b-bd58-4bba747cb889'
OTHER_SESSION = 'dd8bf593-96d4-4aa1-9469-146b1290cd75'


class ProviderAttributionTests(unittest.TestCase):
    setUp = VolumeCrawlTests.setUp
    run_lsof = VolumeCrawlTests.run_lsof
    events = VolumeCrawlTests.events

    def chain(self, provider='claude', words=None):
        rows = cpu.parse_ps(fixture())
        rows[0].update(pid=81905, ppid=81901, elapsedS=81)
        for pid, ppid, name in [(81901,81531,'zsh'), (81531,35313,'zsh'),
                                (35313,3722,provider), (3722,1,'Robob')]:
            comm = '/bin/'+name
            args = remember(comm, words if pid == 35313 and words is not None else [name])
            rows.append(dict(rows[0], pid=pid, ppid=ppid, tool=name, comm=comm, args=args))
        return rows

    def props(self, rows, previous=None):
        with patch.object(scans, 'emit') as emit:
            cache = scans.volume_crawls(rows, previous or {}, 120, self.run_lsof, HOME)
            return emit.call_args.kwargs['props'], cache

    def test_live_shaped_claude_chain(self):
        props, cache = self.props(self.chain(words=['claude','--resume',SESSION]))
        self.assertEqual(props['providerPid'],35313)
        self.assertEqual(props['provider'],'claude')
        self.assertEqual(props['providerSessionId'],SESSION)
        self.assertFalse(props['providerSessionAmbiguous'])
        self.assertIsNone(props['threadId'])
        self.assertEqual(props['parentChain'],[dict(pid=p,name=n) for p,n in
            [(81901,'zsh'),(81531,'zsh'),(35313,'claude'),(3722,'Robob')]])
        row = toollog.record('scan','event','scan.volume_crawl',dt.datetime.now(dt.timezone.utc),props=props)
        self.assertEqual(row['props']['providerSessionId'],SESSION)
        self.assertEqual(row['props']['providerPid'],35313)
        self.assertNotIn('--resume',json.dumps(cache))

    def test_provider_session_argument_class(self):
        cases = [
            ('claude',['--resume',SESSION],SESSION,False),
            ('claude',['--resume='+SESSION],SESSION,False),
            ('claude',['--session-id',SESSION],SESSION,False),
            ('claude',['--session-id='+SESSION],SESSION,False),
            ('claude',['-r',SESSION],SESSION,False),
            ('claude',['--model','test','--session-id='+SESSION],SESSION,False),
            ('claude',['--settings','--resume',SESSION],None,False),
            ('claude',['--', '--resume',SESSION],None,False),
            ('claude',['prompt','--resume',SESSION],None,False),
            ('claude',['--resume'],None,True),
            ('claude',['--resume','last'],None,True),
            ('claude',['--session-id',SESSION,'--resume',OTHER_SESSION],None,True),
            ('claude',['--new-unknown-flag','--resume',SESSION],None,True),
            ('codex',['app-server'],None,True),
            ('codex',['app-server','--session-id',SESSION],None,True),
            ('codex',['resume',SESSION],SESSION,False),
            ('codex',['exec','resume',SESSION],SESSION,False),
            ('codex',['resume','--last'],None,True),
            ('opencode',['run','--session','ses_ABC123'], 'ses_ABC123',False),
            ('opencode',['--session=ses_ABC123'], 'ses_ABC123',False),
            ('opencode',['serve','--session','ses_ABC123'],None,True),
        ]
        for provider, words, expected, ambiguous in cases:
            with self.subTest(provider=provider, words=words):
                self.assertEqual(scans.provider_session(provider,[provider,*words]),(expected,ambiguous))

    def test_shared_server_global_option_class_on_cached_ticks(self):
        cases = [('codex',['app-server']),
                 ('codex',['--config','model="test"','app-server']),
                 ('codex',['--config=model="test"','app-server']),
                 ('codex',['-c','model="test"','app-server']),
                 ('codex',['-cmodel="test"','app-server']),
                 ('codex',['--enable','feature','--config','model="test"','app-server']),
                 ('codex',['--','app-server']),
                 ('opencode',['--port','1234','serve']),
                 ('opencode',['--port=1234','web'])]
        original = self.vector_read.side_effect
        for provider, args in cases:
            for tagged_pid in (81905,81901,35313):
                with self.subTest(provider=provider,args=args,tagged_pid=tagged_pid):
                    rows = self.chain(provider,[provider,*args])
                    def read(rows, run):
                        result = original(rows,run)
                        if tagged_pid in result:
                            result[tagged_pid]['threadId'] = THREAD
                        return result
                    self.vector_read.side_effect = read
                    props, cache = self.props(rows)
                    for props in (props,self.props(rows,dict(volumeCrawlCache=cache))[0]):
                        self.assertEqual(props['provider'],provider)
                        self.assertEqual(props['providerPid'],35313)
                        self.assertIsNone(props['providerSessionId'])
                        self.assertIsNone(props['threadId'])
                        self.assertTrue(props['providerSessionAmbiguous'])
                        row = toollog.record('scan','event','scan.volume_crawl',dt.datetime.now(dt.timezone.utc),props=props)
                        self.assertTrue(row['props']['providerSessionAmbiguous'])

    def test_claude_print_boolean_class_on_cached_ticks(self):
        for flag in ('-p','--print'):
            for identity in (['--session-id',SESSION],['--session-id='+SESSION],
                             ['--resume',SESSION],['--resume='+SESSION],['-r',SESSION]):
                for args in ([flag,*identity],[*identity,flag]):
                    with self.subTest(args=args):
                        props,cache = self.props(self.chain(words=['claude',*args]))
                        rows = self.chain(words=['claude',*args])
                        for props in (props,self.props(rows,dict(volumeCrawlCache=cache))[0]):
                            self.assertEqual(props['providerSessionId'],SESSION)
                            self.assertFalse(props['providerSessionAmbiguous'])
        for args in (['--config','app-server'],['exec','app-server'],
                     ['exec','--','app-server']):
            with self.subTest(args=args):
                self.assertEqual(scans.provider_session('codex',['codex',*args]),(None,False))

    def test_no_provider_chain(self):
        props, _ = self.props(self.chain('zsh'))
        self.assertIsNone(props['provider'])
        self.assertIsNone(props['providerPid'])
        self.assertIsNone(props['providerSessionId'])
        self.assertIsNone(props['threadId'])
        self.assertFalse(props['providerSessionAmbiguous'])

    def test_provider_exits_mid_read_cached_without_dropping_crawl(self):
        rows = self.chain(words=['claude','--resume',SESSION])
        original = self.vector_read.side_effect
        def read(rows,run):
            result = original(rows,run)
            result.pop(35313,None)
            return result
        self.vector_read.side_effect = read
        props, cache = self.props(rows)
        self.assertEqual(props['providerPid'],35313)
        self.assertIsNone(props['providerSessionId'])
        self.assertIsNone(props['threadId'])
        self.assertTrue(props['providerSessionAmbiguous'])
        self.props(rows,dict(volumeCrawlCache=cache))
        self.assertEqual(self.vector_read.call_count,1)

    def test_cache_survives_tick_and_invalidates_pid_reuse(self):
        rows = self.chain(words=['claude','--resume',SESSION])
        props, cache = self.props(rows)
        self.vector_read.reset_mock()
        props, cache = self.props(rows,dict(volumeCrawlCache=json.loads(json.dumps(cache))))
        self.assertEqual(props['providerSessionId'],SESSION)
        self.vector_read.assert_not_called()
        rows[0]['pid'] += 1
        self.props(rows,dict(volumeCrawlCache=cache))
        self.assertEqual([p['pid'] for p in self.vector_read.call_args.args[0]],[81906])
        self.vector_read.reset_mock()
        rows[3].update(start='Mon Nov 16 12:00:01 2026',args=remember('/bin/claude',['claude','--resume',OTHER_SESSION]))
        props, _ = self.props(rows,dict(volumeCrawlCache=cache))
        self.assertEqual(props['providerSessionId'],OTHER_SESSION)
        self.assertIn(35313,[p['pid'] for p in self.vector_read.call_args.args[0]])
        cache = scans.volume_crawls([],dict(volumeCrawlCache=cache),180,self.run_lsof,HOME)
        self.assertEqual(cache,{})

    def test_cache_does_not_persist_prompts_or_settings(self):
        props, cache = self.props(self.chain(words=['claude','--settings','private-settings',
                                                     '--session-id='+SESSION,'prompt-sentinel']))
        self.assertEqual(props['providerSessionId'],SESSION)
        self.assertNotIn('private-settings',json.dumps(cache))
        self.assertNotIn('prompt-sentinel',json.dumps(cache))
        self.assertNotIn('argv',json.dumps(cache))

    def test_node_helpers_do_not_hide_known_provider(self):
        for script, provider in [('/pkg/@anthropic-ai/claude-code/cli.js','claude'),
                                 ('/pkg/@openai/codex/bin/codex.js','codex'),
                                 ('/pkg/opencode-ai/bin/opencode','opencode'),
                                 ('/pkg/mcp/server.js',None),('/pkg/claude.js',None)]:
            with self.subTest(script=script):
                self.assertEqual(scans.provider_name(dict(tool='node'),['node',script]),provider)
        rows = self.chain(words=['claude','--resume',SESSION])
        rows[1].update(tool='node',comm='/bin/node',args=remember('/bin/node',['node','/pkg/mcp/server.js']))
        props, _ = self.props(rows)
        self.assertEqual(props['providerSessionId'],SESSION)

    def test_named_tag_only_when_valid_and_not_ambiguous(self):
        rows = self.chain(words=['claude','--resume',SESSION])
        original = self.vector_read.side_effect
        for tag in (THREAD,'not-a-thread',None):
            def read(rows,run):
                values = original(rows,run)
                values[35313]['threadId'] = tag
                return values
            self.vector_read.side_effect = read
            props, _ = self.props(rows)
            self.assertEqual(props['threadId'],THREAD if tag == THREAD else None)

    def test_thread_tag_location_class_on_cached_ticks(self):
        original = self.vector_read.side_effect
        for tagged_pid in (81905,81901,81531,35313):
            for provider, words in (('claude',['claude','--resume',SESSION]),('zsh',['zsh'])):
                with self.subTest(tagged_pid=tagged_pid,provider=provider):
                    def read(rows,run):
                        result = original(rows,run)
                        result[tagged_pid]['threadId'] = THREAD
                        return result
                    self.vector_read.side_effect = read
                    rows = self.chain(provider,words)
                    props,cache = self.props(rows)
                    for props in (props,self.props(rows,dict(volumeCrawlCache=cache))[0]):
                        self.assertEqual(props['threadId'],THREAD)

    def test_known_node_entry_preserves_provider_session(self):
        rows = self.chain('node',['node','/pkg/@anthropic-ai/claude-code/cli.js','--resume',SESSION])
        props, _ = self.props(rows)
        self.assertEqual(props['provider'],'claude')
        self.assertEqual(props['providerSessionId'],SESSION)

    def test_cache_bound_and_corrupt_state(self):
        rows = self.chain(words=['claude','--resume',SESSION])
        old = {}
        for i in range(600):
            row = dict(rows[-1],pid=100000+i)
            rows.append(row)
            old[str(row['pid'])] = dict(identity=scans.process_key(row))
        old['malformed'] = None
        _, cache = self.props(rows,dict(volumeCrawlCache=old))
        self.assertLessEqual(len(cache),scans.MAX_CACHE)
        for value in (None,[],42):
            props, _ = self.props(rows,dict(volumeCrawlCache=value))
            self.assertEqual(props['providerSessionId'],SESSION)

    def test_provider_schema_rejects_arbitrary_strings(self):
        props = toollog.record('scan','event','scan.volume_crawl',dt.datetime.now(dt.timezone.utc),
                               props={'provider':'private-value','providerSessionId':'secret-value',
                                      'providerPid':-1,'providerSessionAmbiguous':'true'})['props']
        self.assertNotIn('private-value',json.dumps(props))
        self.assertNotIn('secret-value',json.dumps(props))
        self.assertNotIn('providerPid',props)
        self.assertNotIn('providerSessionAmbiguous',props)


class NamedEnvironmentTests(unittest.TestCase):
    def test_only_exact_named_key_is_decoded(self):
        blob = KernelArgvTests().blob(['claude','--resume',SESSION])
        for suffix,expected in [(b'ROBOB_THREAD_ID='+THREAD.encode()+b'\0',THREAD),
                                (b'OTHER_THREAD_ID='+THREAD.encode()+b'\0',None),
                                (b'PREFIX_ROBOB_THREAD_ID='+THREAD.encode()+b'\0',None),
                                (b'ROBOB_THREAD_ID=one\0ROBOB_THREAD_ID=two\0',None)]:
            with self.subTest(suffix=suffix[:30]):
                value = process_argv.read_process(50,lambda pid:(pid,20,501,1234,500),lambda pid:blob+suffix)
                self.assertEqual(value['threadId'],expected)
                self.assertNotIn('PRIVATE_ENV',json.dumps(value))
                self.assertNotIn('do-not-emit',json.dumps(value))
                self.assertEqual(value['argv'],['claude','--resume',SESSION])


    def test_unterminated_environment_fails_closed(self):
        blob = KernelArgvTests().blob(['claude'])+b'ROBOB_THREAD_ID=unterminated'
        with self.assertRaises(ValueError):
            process_argv.decode_process(blob)

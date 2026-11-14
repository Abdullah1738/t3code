import datetime as dt
import json
import os
from pathlib import Path
import plistlib
import subprocess
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import memory
import toollog

FIXTURES = Path(__file__).parent / 'fixtures/memory'
# Captured on 14 Nov; top-incident substitutes the reported fseventsd 38G/34G row.
TOP = (FIXTURES / 'top-incident.txt').read_text()
VM = (FIXTURES / 'vm_stat.txt').read_text()
SWAP = (FIXTURES / 'swap.txt').read_text()
IO = (FIXTURES / 'iostat.txt').read_text()
PS = '''1227 1 04-00:01:12 /System/Library/fseventsd
176 1 02:03:04 /System/Library/WindowServer
482 1 00:55 /System/Finder
42 10 01:15 /Applications/Robob.app/Contents/MacOS/Robob
43 1 03:15 /some/codex
44 10 01:15 /some/opencode
45 1 01:15 /some/node
46 10 01:15 /some/node
47 1 01:15 /some/Python
48 10 01:15 /some/python3
49 1 01:15 /some/cua-driver
50 10 01:15 /some/claude
51 1 01:15 /some/ssh: private --token=credential
'''


class MemoryTests(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.root = Path(tmp.name)
        env = patch.dict(os.environ, TOOLLOG_DIR=str(self.root), BUN_INSPECT='private')
        env.start()
        self.addCleanup(env.stop)
        self.commands = []
        self.notifications = []

    def rows(self, name):
        return [json.loads(line) for p in self.root.glob('*.ndjson')
                for line in p.read_text().splitlines() if json.loads(line)['name'] == name]

    def runner(self, fail=None, fail_kind='timeout', notify_fail=False, top=TOP, ps=PS, vm=VM, boot=100,
               swap='total = 27238.40M used = 25907.20M', pressure=1, free=65):
        def run(argv, **kwargs):
            self.commands.append(argv)
            self.assertEqual(kwargs['timeout'], 10)
            self.assertNotIn('BUN_INSPECT', kwargs['env'])
            self.assertNotIn('args', ' '.join(argv))
            if fail and fail in argv:
                if fail_kind == 'timeout':
                    raise subprocess.TimeoutExpired(argv, 10)
                if fail_kind == 'unavailable':
                    raise OSError('private --token=credential')
                return SimpleNamespace(returncode=1 if fail_kind == 'exit' else 0, stdout='invalid private data')
            name = Path(argv[0]).name
            if name == 'bun':
                self.notifications.append(argv)
                if notify_fail:
                    raise subprocess.TimeoutExpired(argv, 10)
                text = ''
            elif name == 'sysctl':
                text = {'vm.swapusage': swap, 'vm.memory_pressure': str(pressure),
                        'kern.boottime': '{ sec = %d, usec = 10 }' % boot}[argv[-1]]
            elif name == 'vm_stat':
                text = vm
            elif name == 'memory_pressure':
                text = 'System-wide memory free percentage: %s%%\n' % free
            elif name == 'ps':
                text = ps
            elif name == 'iostat':
                text = IO
            elif name == 'top':
                if '-pid' in argv:
                    pids = [argv[i+1] for i,v in enumerate(argv) if v == '-pid']
                    text = 'PID COMMAND MEM CMPRS %CPU\n'+'\n'.join(
                        pid+' watcher 100M 32M 0.0' for pid in pids)
                else:
                    text = top
            else:
                self.fail('Unexpected command '+repr(argv))
            return SimpleNamespace(returncode=0, stdout=text)
        return run

    def test_units_whole_class(self):
        for suffix in ('', '+', '-'):
            for token, expected in [('512K', .5), ('20M', 20), ('1.5G', 1536), ('38G', 38912), ('34G', 34816), ('0B', 0), ('1024', 1/1024), ('1T', 1048576)]:
                with self.subTest(token=token+suffix):
                    self.assertAlmostEqual(memory.number(token+suffix), expected, places=6)
        for token in ('-1M', 'NaN', 'inf', '1GB', '1Q', 'M', '1M+-'):
            with self.subTest(token=token), self.assertRaises(memory.ProbeError):
                memory.number(token)

    def test_top_incident_and_spaced_truncated_names(self):
        rows = memory.parse_top(TOP)
        self.assertEqual(rows[0], dict(pid=1227, command='fseventsd', memMb=38912, cmprsMb=34816, cpu=0))
        text = 'PID COMMAND MEM CMPRS %CPU\n2 Robob Helper (Re 1024K+ 0B- 1.5\n'
        self.assertEqual(memory.parse_top(text), [dict(pid=2, command='Robob Helper (Re', memMb=1, cmprsMb=0, cpu=1.5)])
        for text in ('invalid', 'PID COMMAND MEM CMPRS %CPU\n2 Finder wrong 0B 0.0',
                     'PID COMMAND MEM CMPRS %CPU\n2 Finder 1M 0B nan'):
            with self.subTest(text=text), self.assertRaises(memory.ProbeError):
                memory.parse_top(text)
        self.assertEqual(len(memory.parse_top((FIXTURES/'top.txt').read_text())), 15)

    def test_captured_vm_swap_and_second_io_sample(self):
        vm = memory.parse_vm(VM)
        self.assertEqual(vm['pageSize'], 16384)
        self.assertGreater(vm['compressorPages'], 0)
        self.assertGreater(vm['swapouts'], 0)
        self.assertGreater(memory.parse_swap(SWAP)['usedMb'], 0)
        self.assertEqual(memory.parse_swap('total = 26G used = 512K'), dict(totalMb=26624, usedMb=.5))
        fields = IO.splitlines()[-1].split()
        self.assertEqual(memory.parse_io(IO), dict(tps=float(fields[1]), mbPerS=float(fields[2])))
        with self.assertRaises(memory.ProbeError):
            memory.parse_io('\n'.join(IO.splitlines()[:-1]))

    def test_sample_watched_counts_schema_and_deltas(self):
        run = self.runner()
        memory.sample(run, now=1000, notify=False)
        props = self.rows('memory.sample')[-1]['props']
        self.assertEqual(props['deltaError'], 'baseline')
        self.assertIsNone(props['swapinsDelta'])
        self.assertEqual(len(props['top']), 15)
        watched = {r['command']: r for r in props['watched']}
        self.assertEqual(set(watched), set(memory.WATCHED))
        self.assertEqual(watched['codex']['memMb'], 100)
        self.assertEqual(watched['codex']['cmprsMb'], 32)
        self.assertEqual(watched['fseventsd']['memMb'], 38912)
        counts = {r['command']: r for r in props['counts']}
        self.assertEqual(counts['node'], dict(command='node', count=2, ppid1Count=1))
        self.assertEqual(counts['python'], dict(command='python', count=2, ppid1Count=1))
        self.assertEqual(props['processCount'], 13)
        self.assertEqual(props['ppid1Count'], 8)
        self.assertEqual(len([c for c in self.commands if c[0] == '/usr/bin/top']), 2)
        memory.sample(run, now=1300, notify=False)
        props = self.rows('memory.sample')[-1]['props']
        self.assertEqual(props['swapinsDelta'], 0)
        self.assertEqual(props['deltaWindowS'], 300)
        self.assertNotIn('private', '\n'.join(p.read_text() for p in self.root.glob('*.ndjson')))
        state = json.loads((self.root/'state/memory.json').read_text())
        self.assertEqual(state['baseline']['at'], 1300)
        self.assertEqual((self.root/'state/memory.json').stat().st_mode & 0o777, 0o600)
        self.assertFalse(self.notifications)

    def test_failed_vm_does_not_advance_baseline_and_restart_recovers_it(self):
        memory.sample(self.runner(), now=1000, notify=False)
        memory.sample(self.runner(fail='/usr/bin/vm_stat'), now=1300, notify=False)
        memory.sample(self.runner(), now=1600, notify=False)
        props = self.rows('memory.sample')[-1]['props']
        self.assertEqual(props['deltaWindowS'], 600)
        self.assertEqual(props['swapoutsDelta'], 0)
        memory.sample(self.runner(boot=200), now=1900, notify=False)
        self.assertEqual(self.rows('memory.sample')[-1]['props']['deltaError'], 'baseline')
        (self.root/'state/memory.json').write_text('broken')
        memory.sample(self.runner(), now=2200, notify=False)
        self.assertEqual(self.rows('memory.sample')[-1]['props']['deltaError'], 'baseline')

    def test_lock_busy_starts_no_commands(self):
        import fcntl
        lock_path=memory.state_path('memory').with_suffix('.lock')
        with lock_path.open('a') as lock:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            self.assertIsNone(memory.sample(self.runner(), now=1000))
        self.assertFalse(self.commands)

    def test_counter_baselines_and_resets(self):
        vm = dict(swapins=100, swapouts=200)
        old = dict(vm=dict(swapins=90, swapouts=180), boot=1, at=100)
        result = memory.swap_deltas(vm, 1, old, 400)
        self.assertEqual(result, dict(swapinsDelta=10, swapoutsDelta=20, deltaWindowS=300, deltaError=None))
        for previous, boot, now in [({},1,400), (old,2,400), (old,1,50), (old,1,4000),
                                    (dict(old,vm=dict(swapins=101,swapouts=201)),1,400),
                                    (dict(old,vm=None),1,400)]:
            with self.subTest(previous=previous, boot=boot):
                result = memory.swap_deltas(vm,boot,previous,now)
                self.assertIsNone(result['swapinsDelta'])
                self.assertEqual(result['deltaError'], 'baseline')
        self.assertEqual(memory.swap_deltas(None,1,old,400)['deltaError'], 'unavailable')

    def test_each_command_failure_is_null_and_tagged(self):
        for cmd, field in [('vm.swapusage','swap'), ('/usr/bin/vm_stat','vm'),
                           ('vm.memory_pressure','pressure'), ('kern.boottime','boot'),
                           ('/usr/bin/memory_pressure','freePercent'), ('/usr/bin/top','top'),
                           ('/bin/ps','counts'), ('/usr/sbin/iostat','io')]:
            for error in ('timeout', 'exit', 'unavailable', 'parse'):
                with self.subTest(cmd=cmd, error=error):
                    memory.sample(self.runner(fail=cmd,fail_kind=error),now=1000,notify=False)
                    row = self.rows('memory.sample')[-1]
                    self.assertIsNone(row['props'][field])
                    self.assertEqual(row['props'][field+'Error'], error)
                    self.assertFalse(row['ok'])
                    self.assertEqual(row['error']['tag'], 'memory.partial')

    def test_watched_timeout_preserves_entries_as_null(self):
        memory.sample(self.runner(fail='-pid'),now=1000,notify=False)
        props = self.rows('memory.sample')[-1]['props']
        self.assertEqual(props['watchedError'], 'timeout')
        codex = next(p for p in props['watched'] if p['command']=='codex')
        self.assertIsNone(codex['memMb'])
        self.assertIsNone(codex['cmprsMb'])
        self.assertEqual(codex['error'], 'timeout')

    def test_threshold_boundaries(self):
        for total, used, mem, fsevent, expected in [(20000,16384,8192,4096,set()),
                (20000,16384.01,8192,4096,{'swap'}), (20000,0,8192.01,4096,{'footprint'}),
                (0,0,8192,4096.01,{'fseventsd'}), (0,0,38912,34816,{'footprint','fseventsd'})]:
            props = dict(swap=dict(totalMb=total,usedMb=used), top=[dict(pid=1,command='Robob',memMb=mem)],
                         watched=[dict(pid=2,command='fseventsd',memMb=fsevent)])
            self.assertEqual(set(memory.alert_reasons(props)),expected)

    def test_evaluator_healthy_and_incident_swap_cases(self):
        top='PID COMMAND MEM CMPRS %CPU\n1227 fseventsd 5.6M 2M 0.0\n'
        memory.sample(self.runner(top=top,swap='total = 7168M used = 5788M',pressure=0,free=72),now=1000)
        self.assertEqual(self.notifications, [])
        memory.sample(self.runner(top=top,swap='total = 26.6G used = 25.3G',pressure=0,free=72),now=1300)
        self.assertEqual(len(self.notifications), 1)
        self.assertEqual(self.rows('memory.alert')[-1]['props']['reason'], 'swap')

    def test_pressure_requires_consecutive_samples_and_resets(self):
        top='PID COMMAND MEM CMPRS %CPU\n1227 fseventsd 5.6M 2M 0.0\n'
        cases=[(1,15,None,0), (2,72,None,1), (0,14,None,2),
               (0,72,None,0), (2,72,None,1), (0,72,'/usr/bin/memory_pressure',0),
               (2,72,None,1), (2,72,None,2)]
        for i,(pressure,free,fail,streak) in enumerate(cases):
            memory.sample(self.runner(top=top,swap='total = 7168M used = 5788M',
                                      pressure=pressure,free=free,fail=fail),now=1000+300*i)
            self.assertEqual(self.rows('memory.sample')[-1]['props']['criticalSamples'], streak)
        self.assertEqual(len(self.notifications),1) # pressure shares its own 6h cooldown
        self.assertEqual(self.rows('memory.alert')[-1]['props']['reason'], 'pressure')
        state={}
        props=dict(pressure=2,freePercent=72)
        for at,expected in [(1000,1),(1300,2),(2000,1),(1900,1)]:
            memory.pressure_streak(props,state,at)
            self.assertEqual(props['criticalSamples'],expected)
        memory.pressure_streak(dict(pressure=None,freePercent=None),state,2200)
        self.assertEqual(state['pressure']['consecutive'],0)

    def test_alerts_six_hour_cooldown_and_day_rollover(self):
        run = self.runner()
        for now, expected in [(dt.datetime(2026,11,14,22,tzinfo=dt.timezone.utc).timestamp(),3),
                              (dt.datetime(2026,11,15,0,tzinfo=dt.timezone.utc).timestamp(),3),
                              (dt.datetime(2026,11,15,4,tzinfo=dt.timezone.utc).timestamp(),6)]:
            memory.sample(run,now=now)
            self.assertEqual(len(self.notifications),expected)
        self.assertEqual(len(self.rows('memory.alert')), 6)
        for argv in self.notifications:
            self.assertEqual(argv[argv.index('--source')+1], 'Mac memory')
            self.assertIn('mac-memory:', argv[-1])
            text=argv[argv.index('--text')+1]
            self.assertIn('38.0 GB',text)
            self.assertIn('#38',text)
            self.assertEqual(len(text.splitlines()),2)
        self.assertNotEqual(self.notifications[0][-1],self.notifications[-3][-1])

    def test_cooldown_allows_new_key_six_hours_later_same_day(self):
        at=dt.datetime(2026,11,14,tzinfo=dt.timezone.utc).timestamp()
        memory.sample(self.runner(),now=at)
        memory.sample(self.runner(),now=at+memory.COOLDOWN-1)
        self.assertEqual(len(self.notifications),3)
        memory.sample(self.runner(),now=at+memory.COOLDOWN)
        self.assertEqual(len(self.notifications),6)
        self.assertNotEqual(self.notifications[0][-1],self.notifications[3][-1])
        self.assertIn('20261114:',self.notifications[0][-1])
        self.assertIn('20261114:',self.notifications[3][-1])

    def test_ambiguous_send_retries_identical_key_and_text(self):
        memory.sample(self.runner(notify_fail=True),now=1000)
        first = self.notifications[:]
        # Changed measurements must not change a potentially queued payload.
        memory.sample(self.runner(top=TOP.replace('38G','39G')),now=1300)
        for a,b in zip(first,self.notifications[3:]):
            self.assertEqual(a,b)
        self.assertTrue(all(r['ok'] for r in self.rows('memory.alert')[-3:]))
        memory.sample(self.runner(),now=1600)
        self.assertEqual(len(self.notifications),6)

    def test_memory_schema_is_scoped_bounded_and_redacts(self):
        props = dict(top=[dict(pid=2,command='password=private',memMb=1,cmprsMb=0,cpu=1,
                              args='private')]*20, swap=dict(totalMb=1,usedMb=1,secret='private'),
                     swapinsDelta=None, arbitrary='private')
        toollog.emit('memory','event','memory.sample',props=props)
        row=self.rows('memory.sample')[-1]['props']
        self.assertEqual(len(row['top']),15)
        self.assertEqual(row['top'][0]['command'],'[redacted]')
        self.assertNotIn('args',row['top'][0])
        self.assertNotIn('arbitrary',row)
        self.assertNotIn('private',json.dumps(row))
        self.assertEqual(toollog.safe_fields(props,'unrelated'),{})
        self.assertEqual(toollog.memory_command('/path/private'), '[redacted]')

    def test_schedule_and_setup_coverage(self):
        root=Path(memory.__file__).parent
        label='com.abdullah.mac-memory'
        data=plistlib.loads((root/'launchd'/ (label+'.plist')).read_bytes())
        self.assertEqual(data['StartInterval'],300)
        self.assertEqual(data['ProgramArguments'][:2],['/bin/zsh','-c'])
        self.assertIn('memory.py',data['ProgramArguments'][2])
        setup=(root/'install.zsh').read_text()
        self.assertIn('collector.py memory.py deep_inventory.py',setup)
        self.assertIn(label,setup)

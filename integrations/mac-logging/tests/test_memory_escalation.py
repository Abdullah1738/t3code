import datetime as dt
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import memory
import toollog
import test_memory as legacy

START = 'Thu Nov 19 03:00:00 2026'


class EscalationTests(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.root = Path(tmp.name)
        env = patch.dict(os.environ, TOOLLOG_DIR=str(self.root))
        env.start()
        self.addCleanup(env.stop)
        self.state, self.sent = {}, []

    def runner(self, argv, **kwargs):
        self.assertEqual(kwargs['timeout'], 10)
        self.sent.append(argv)
        return SimpleNamespace(returncode=0, stdout='')

    def props(self, gb, pid=61946, start=START, swap=3):
        return dict(boot=1, top=[dict(pid=pid, start=start, command='Activity Monitor', memMb=gb*1024, cmprsMb=gb*1000)],
                    watched=[], swap=dict(usedMb=swap*1024, totalMb=64*1024),
                    vm=dict(pageSize=16384, compressorPages=1024), pressureLevel=2, freePercent=30)

    def observe(self, now, gb, **kwargs):
        p = self.props(gb, **kwargs)
        memory.process_growth(p, self.state, now)
        memory.alerts(p, self.state, now, self.runner)
        return p

    def events(self, reason=None):
        rows = [json.loads(line) for f in self.root.glob('*.ndjson') for line in f.read_text().splitlines()]
        return [r['props'] for r in rows if r['name']=='memory.alert' and (reason is None or r['props']['reason']==reason)]

    def test_footprint_growth_and_different_holder_obey_half_hour_gap(self):
        for at,gb,pid in [(1000,9,61946),(1300,13,61946),(2800,13,61946),(3000,9,20),(4600,9,20)]:
            self.observe(at,gb,pid=pid)
        rows=self.events('footprint')
        self.assertEqual([p['pid'] for p in rows],[61946,61946,20])
        self.assertEqual([p['escalation'] for p in rows],[False,True,True])
        self.assertIn('pid 61946: 13.0 GB',self.sent[1][self.sent[1].index('--text')+1])

    def test_smaller_new_holder_is_not_hidden_by_larger_steady_holder(self):
        self.observe(1000,12)
        p=self.props(12)
        p['top'].append(dict(pid=20,start=START,command='node',memMb=9*1024,cmprsMb=0))
        memory.alerts(p,self.state,2800,self.runner)
        self.assertEqual(self.events('footprint')[-1]['pid'],20)

    def test_all_existing_holders_get_initial_baselines(self):
        for reason in ('footprint', 'growth'):
            with self.subTest(reason=reason):
                self.state = {}
                before = len(self.events(reason))
                for at in (1000, 2800, 4600):
                    p = self.props(10)
                    p['top'].append(dict(pid=20, start=START, command='node', memMb=9*1024, cmprsMb=0))
                    if reason == 'growth':
                        p['growth'] = [dict(q, growthSamples=6, growthWindowS=1800, growthMbPerHour=1200) for q in p['top']]
                    memory.alerts(p, self.state, at, self.runner)
                self.assertEqual(len(self.events(reason))-before, 1)
                self.assertEqual(len(self.state['alerts'][reason]['holders']), 2)
                p['top'][1]['memMb'] = 13*1024
                if reason == 'growth':
                    p['growth'][1]['memMb'] = 13*1024
                memory.alerts(p, self.state, 6400, self.runner)
                self.assertEqual(self.events(reason)[-1]['pid'], 20)
                self.assertTrue(self.events(reason)[-1]['escalation'])

    def test_fseventsd_reasons_identify_the_qualifying_daemon(self):
        for reason in ('fseventsd', 'fseventsd_growth'):
            with self.subTest(reason=reason):
                self.state = {}
                p = self.props(7, pid=20)
                p['top'][0]['command'] = 'node'
                p['watched'] = [dict(pid=111, command='fseventsd', memMb=3072 if reason=='fseventsd' else 36,
                                     cmprsMb=0, etime='30:00', start=START)]
                if reason == 'fseventsd_growth':
                    p.update(fseventsdGrowthPid=111, fseventsdGrowthSamples=3,
                             fseventsdGrowthWindowS=900, fseventsdGrowthMbPerHour=120)
                memory.alerts(p, self.state, 1000, self.runner)
                alert = self.events(reason)[-1]
                self.assertEqual(alert['pid'], 111)
                self.assertEqual(alert['command'], 'fseventsd')
                self.assertEqual(alert['footprintGiB'], 3 if reason=='fseventsd' else 36/1024)
                text = self.sent[-1][self.sent[-1].index('--text')+1]
                self.assertIn('fseventsd pid 111', text)
                self.assertNotIn('node pid 20', text)

    def test_unselected_qualifying_baseline_survives_six_hours(self):
        for reason in ('footprint', 'growth'):
            for secondary_grows in (False, True):
                with self.subTest(reason=reason, secondary_grows=secondary_grows):
                    self.state = {}
                    before = len(self.events(reason))
                    sequence = [(1000, 10, 9), (19000, 14, 9),
                                (23000, 18, 13 if secondary_grows else 9),
                                (24800, 18, 13 if secondary_grows else 9)]
                    for at, first, second in sequence:
                        p = self.props(first)
                        p['top'].append(dict(pid=20, start=START, command='node', memMb=second*1024, cmprsMb=0))
                        if reason == 'growth':
                            p['growth'] = [dict(q, growthSamples=6, growthWindowS=1800, growthMbPerHour=1200)
                                           for q in p['top']]
                        memory.alerts(p, self.state, at, self.runner)
                        # Exercise the persisted receipt, including daemon restart.
                        self.state = memory.read_state('memory')
                    rows = self.events(reason)[before:]
                    self.assertEqual([r['pid'] for r in rows], [61946, 61946, 61946]+([20] if secondary_grows else []))
                    self.assertEqual(self.state['alerts'][reason]['holders'][memory.holder_key(p['top'][1], 1)]['memMb'],
                                     (13 if secondary_grows else 9)*1024)

    def test_footprint_boundary_uses_last_alert_not_last_sample(self):
        for at,gb in [(1000,8.1),(2800,12),(4600,12.1),(6400,16),(8200,16.1)]:
            self.observe(at,gb)
        self.assertEqual([p['footprintGiB'] for p in self.events('footprint')],[8.1,12.1,16.1])

    def test_swap_four_gib_escalation_and_three_point_nine_quiet(self):
        for at,gb in [(1000,17),(1300,21),(2800,20.9),(3100,21),(4900,25),(6700,29)]:
            self.observe(at,1,swap=gb)
        rows=self.events('swap')
        self.assertEqual(len(rows),4)
        self.assertEqual([r['escalation'] for r in rows],[False,True,True,True])
        self.assertIn('Swap 29.0 GB',self.sent[-1][self.sent[-1].index('--text')+1])

    def test_steady_holder_waits_six_hours(self):
        for at in (1000,2800,4600,10000,22599):self.observe(at,9)
        self.assertEqual(len(self.events('footprint')),1)
        self.observe(22600,9)
        self.assertEqual(len(self.events('footprint')),2)

    def test_growth_needs_size_window_and_sustained_intervals(self):
        for sequence in [(4,6,6,6,6,6,6),(3,3.1,3.2,3.3,3.4,3.5,3.5),(4,4.01,4.02,4.03,4.04,4.05,4.06)]:
            with self.subTest(sequence=sequence):
                self.state={}
                before=len(self.events('growth'))
                for i,gb in enumerate(sequence):self.observe(1000+300*i,gb)
                self.assertEqual(len(self.events('growth')),before)
        self.state={}
        for i in range(7):
            self.observe(1000+300*i,4+i*.15)
            self.assertEqual(len(self.events('growth')),int(i==6))
        self.assertAlmostEqual(self.events('growth')[-1]['growthGiBHour'],1.8)

    def test_birth_boot_gap_rollback_or_flat_resets_growth(self):
        for reset in ('birth','boot','gap','rollback','flat'):
            with self.subTest(reset=reset):
                state={}
                for i in range(6):
                    memory.process_growth(self.props(4+i*.15),state,1000+300*i)
                p=self.props(4.9,start='Thu Nov 19 03:30:00 2026' if reset=='birth' else START)
                if reset=='boot':p['boot']=2
                if reset=='flat':p['top'][0]['memMb']=4.75*1024
                memory.process_growth(p,state,4000 if reset=='gap' else 2400 if reset=='rollback' else 2800)
                self.assertEqual(memory.growth_candidates(p),[])

    def test_pid_reuse_is_new_holder_without_growth(self):
        self.observe(1000,9)
        p=self.observe(2800,20,start='Thu Nov 19 03:30:00 2026')
        self.assertEqual(memory.growth_candidates(p),[])
        self.assertTrue(self.events('footprint')[-1]['escalation'])
        self.assertEqual(len(self.state['alerts']['footprint']['holders']),2)

    def test_timeout_gap_preserves_streak_without_inventing_observation(self):
        for i in range(6):self.observe(1000+300*i,4+i*.15)
        p=dict(boot=1,top=None,topError='timeout',watched=[],countsError=None)
        memory.process_growth(p,self.state,2800)
        self.assertEqual(p['growth'],[])
        self.assertTrue(self.state['processGrowth']['61946']['gap'])
        self.assertEqual(len(memory.growth_candidates(self.observe(3100,5.05))),1)

    def test_ambiguous_retry_retains_payload_and_measurement(self):
        first=[]
        def fail(argv,**kwargs):
            first.append(argv)
            raise subprocess.TimeoutExpired(argv,10)
        memory.alerts(self.props(9),self.state,1000,fail)
        memory.alerts(self.props(20),self.state,1300,self.runner)
        self.assertEqual(self.sent[0],first[0])
        receipt=self.state['alerts']['footprint']
        self.assertEqual(next(iter(receipt['holders'].values()))['memMb'],9*1024)
        memory.alerts(self.props(20),self.state,3100,self.runner)
        self.assertEqual(len(self.sent),2)

    def test_legacy_receipt_seeds_baseline_quietly(self):
        self.state={'alerts':{'footprint':{'at':1000}}}
        self.observe(2800,9)
        self.assertEqual(self.sent,[])
        self.observe(4600,13)
        self.assertEqual(len(self.events('footprint')),1)

    def test_schema_and_text_keep_numbers_without_argv(self):
        for i in range(7):self.observe(1000+300*i,4+i*.15)
        row=self.events('growth')[-1]
        self.assertEqual(row['pid'],61946)
        self.assertEqual(row['footprintGiB'],4.9)
        self.assertFalse(row['escalation'])
        self.assertFalse(row['fallback'])
        safe=toollog.memory_fields(dict(row,command='password=private',args='secret',growthGiBHour=float('inf')),'memory.alert')
        self.assertNotIn('args',safe)
        self.assertEqual(safe['command'],'[redacted]')
        self.assertNotIn('growthGiBHour',safe)
        text=self.sent[-1][self.sent[-1].index('--text')+1]
        self.assertEqual(len(text.splitlines()),2)
        self.assertIn('(+1.8 GB/h)',text)
        self.assertIn('compressor',text)

    def test_recorded_nov19_replay(self):
        fixture=json.loads((Path(__file__).parent/'fixtures/memory/activity-monitor-20261119.json').read_text())
        events=[]
        for row in fixture['rows']:
            now=dt.datetime.fromisoformat(row['ts'].replace('Z','+00:00')).timestamp()
            p=dict(boot=row['boot'],top=[dict(row['holder'],start=START)] if row['holder'] else None,
                   topError=row['topError'],countsError=None,swap=row['swap'],vm=row['vm'])
            memory.process_growth(p,self.state,now)
            memory.alerts(p,self.state,now,self.runner)
            events.extend((now,e) for e in self.events()[len(events):])
        growth=[(at,p) for at,p in events if p['reason']=='growth']
        first=dt.datetime.fromtimestamp(growth[0][0],dt.timezone.utc)
        self.assertTrue((6,0)<=(first.hour,first.minute)<=(6,30),first)
        footprint=[p for _,p in events if p['reason']=='footprint']
        # At large sizes top rounded to whole GiB: 12.0 wasn't +4 from
        # 8.0449, so 13.0 is the first qualifying repeat. No17 GiB sample exists.
        self.assertEqual([p['footprintGiB'] for p in footprint],[8.044921875,13.0])
        self.assertFalse(any(p['reason']=='swap' for _,p in events))
        for reason in ('growth','footprint'):
            stamps=[at for at,p in events if p['reason']==reason]
            self.assertTrue(all(b-a>=1800 for a,b in zip(stamps,stamps[1:])))


class FallbackTests(unittest.TestCase):
    def test_growth_below_logged_top_list_is_tracked_from_full_snapshot(self):
        for steady_count in (1, 15, 31):
            with self.subTest(rank=steady_count+1):
                helper = legacy.MemoryTests()
                helper.setUp()
                try:
                    pid = steady_count+1
                    ps = ''.join('%s 1 30:00 %s /opt/node\n' % (i, START) for i in range(1, pid+1))
                    for i in range(7):
                        top = 'PID COMMAND MEM CMPRS\n'+''.join('%s node 5G 0B\n' % j for j in range(1, pid))
                        top += '%s node %sM 0B\n' % (pid, 4096+150*i)
                        memory.sample(helper.runner(top=top, ps=ps, swap='total = 4096M used = 100M'), now=1000+300*i)
                    alerts = [r['props'] for r in helper.rows('memory.alert') if r['props']['reason']=='growth']
                    self.assertEqual(len(alerts), 1)
                    self.assertEqual(alerts[0]['pid'], pid)
                    logged = helper.rows('memory.sample')[-1]['props']
                    self.assertEqual(len(logged['top']), min(15, pid))
                    self.assertEqual(len(logged['growth']), pid)
                    self.assertEqual(len([c for c in helper.commands if c[0]=='/usr/bin/top']), 7)
                finally:
                    helper.doCleanups()

    def test_only_three_previous_birth_matched_holders_are_probed(self):
        helper=legacy.MemoryTests()
        helper.setUp()
        self.addCleanup(helper.doCleanups)
        ps=''.join('%s 1 30:00 %s /Applications/App.app/Contents/MacOS/App\n' % (pid,START) for pid in range(1,5))
        base=helper.runner(ps=ps,fail='/usr/bin/top')
        calls=[]
        def run(argv,**kw):
            if argv[0]=='/usr/bin/footprint':
                calls.append(argv)
                self.assertEqual(kw['timeout'],5)
                return SimpleNamespace(returncode=0,stdout='    phys_footprint: 9663676416 B\n')
            if argv[:2]==['/bin/ps','-p']:
                self.assertEqual(kw['timeout'],5)
                return SimpleNamespace(returncode=0,stdout=START+'\n')
            return base(argv,**kw)
        previous=dict(boot=100,holders=[dict(pid=i,start=START) for i in range(1,5)])
        p,_=memory.collect(run,previous,1000)
        self.assertIsNone(p['top'])
        self.assertEqual([r['pid'] for r in p['fallback']],[1,2,3])
        self.assertTrue(all(r['memMb']==9216 for r in p['fallback']))
        self.assertEqual(len(calls),3)
        memory.alerts(p,{},1000,helper.runner())
        self.assertTrue(helper.rows('memory.alert')[-1]['props']['fallback'])
        previous['holders'][0]['start']='Thu Nov 19 02:00:00 2026'
        p,_=memory.collect(run,previous,1000)
        self.assertEqual([r['pid'] for r in p['fallback']],[2,3])
        def reused(argv,**kw):
            if argv[:2]==['/bin/ps','-p']:
                return SimpleNamespace(returncode=0,stdout='Thu Nov 19 02:00:00 2026\n')
            return run(argv,**kw)
        p,_=memory.collect(reused,previous,1000)
        self.assertTrue(all(r['memMb'] is None and r['error']=='gone' for r in p['fallback']))

    def test_ps_forms_preserve_spaced_names_and_birth(self):
        rows=memory.parse_ps('61946 1 01:20 Thu Nov 19 03:00:00 2026 /System/Applications/Activity Monitor.app/Contents/MacOS/Activity Monitor')
        self.assertEqual(rows[0]['start'],START)
        self.assertEqual(rows[0]['command'],'Activity Monitor')
        self.assertNotIn('start',memory.parse_ps('61946 1 01:20 /Applications/Activity Monitor')[0])

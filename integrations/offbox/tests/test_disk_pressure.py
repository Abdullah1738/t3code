"""Pool exhaustion must preserve live work and refuse growth before SQLite fails."""
import contextlib
import json
import os
from pathlib import Path
import sqlite3
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

if __package__:
    from .test_boatd import Base, boatd
else:
    from test_boatd import Base, boatd

disk = boatd.disk
G = disk.GIB


def storage(free=30*G, total=100*G):
    row = {'filesystem': 'offbox', 'free_bytes': free, 'total_bytes': total, 'free_pct': 100*free/total}
    row['level'] = disk.level(row, True)
    return {'sampled_at': 123, 'level': row['level'], 'disk_full': row['level'] == 'full',
            'disk_low': row['level'] != 'ok', 'filesystems': [row], 'errors': []}


def snaps(bid, count=6, kind='auto'):
    return [{'box': bid, 'dataset': f'offbox/incus/containers/{boatd.ct(bid)}@snapshot-{kind}-{i}',
             'name': f'{kind}-{i}', 'kind': kind, 'bytes': G, 'created_at': i, 'clones': False} for i in range(count)]


class Policy(unittest.TestCase):
    def test_thresholds_use_allocatable_space_and_inodes(self):
        for free, expected in [(30, 'ok'), (20, 'ok'), (19, 'low'), (10, 'low'), (9, 'full'), (0, 'full')]:
            with self.subTest(free=free):
                self.assertEqual(storage(free*G)['level'], expected)
        self.assertEqual(disk.level({'free_bytes': 5*G, 'total_bytes': 10*G, 'free_inodes': 0, 'total_inodes': 10}), 'full')
        self.assertEqual(disk.level({'free_bytes': 5*G, 'total_bytes': 10*G, 'free_inodes': 4, 'total_inodes': 100}), 'low')

    def test_large_pool_thresholds_have_absolute_ceilings(self):
        for free, expected in ((39, 'full'), (40, 'low'), (90, 'low'), (91, 'ok'), (131, 'ok')):
            with self.subTest(free=free):
                self.assertEqual(storage(free*G, 1744*G)['level'], expected)
        self.assertEqual(disk.pool_thresholds(1744*G)['target'], 130*G)
        self.assertEqual(disk.pool_thresholds(100*G), {'hard': 10*G, 'warn': 20*G, 'target': 25*G})

    def test_oldest_first_keeps_newest_three_run_points_clone_origins_and_timer_kinds(self):
        rows = snaps('a') + snaps('b') + snaps('a', kind='stop') + snaps('a', kind='hourly')
        rows[0]['clones'] = True
        got = disk.candidates(rows, {'b'})
        self.assertEqual(got, sorted(got,key=lambda r:(r['created_at'],r['name'])))
        self.assertTrue(any(r['kind']=='stop' for r in got))
        self.assertTrue(all(r['box']=='a' and r['kind'] in ('auto','stop') and not r['clones'] for r in got))
        self.assertFalse({'auto-5','stop-5','stop-4'} & {r['name'] for r in got})

    def test_raw_free_does_not_hide_slop_or_full_dataset(self):
        def command(args):
            if args[0] == 'zpool':
                return f'{100*G}\t{4*G}\n'
            return '0\n'
        with patch.object(disk,'command',side_effect=command), patch.object(disk,'filesystem',return_value={
                'filesystem':'state','free_bytes':2*G,'total_bytes':10*G,'free_inodes':50,'total_inodes':100}):
            result=disk.sample('offbox','state')
        self.assertTrue(result['disk_full'])
        self.assertEqual(result['filesystems'][0]['free_bytes'],0)

    def test_reservations_are_idempotent_and_never_shrink_existing_guarantee(self):
        script=Path(__file__).resolve().parents[1]/'server/install-host.sh'
        with tempfile.TemporaryDirectory() as name:
            root=Path(name); fake=root/'zfs'; state=root/'state.json'; log=root/'calls'
            state.write_text(json.dumps({'offbox/boatd':0,'offbox/incus-var':16*G}))
            fake.write_text('#!'+sys.executable+'\n'+'''import json,os,sys
from pathlib import Path
p=Path(os.environ['RES_STATE']);d=json.loads(p.read_text());a=sys.argv[1:]
if a[0]=='get':print(d[a[-1]])
else:
 d[a[-1]]=int(a[1].split('=')[1]);p.write_text(json.dumps(d))
 with open(os.environ['RES_LOG'],'a') as f:f.write(' '.join(a)+'\\n')
''');fake.chmod(0o755)
            env=dict(os.environ,PATH=str(root)+os.pathsep+os.environ['PATH'],RES_STATE=str(state),RES_LOG=str(log))
            for _ in range(2):
                subprocess.run(['bash',str(script),'disk-reservations'],check=True,env=env,capture_output=True)
            self.assertEqual(json.loads(state.read_text()),{'offbox/boatd':2*G,'offbox/incus-var':16*G})
            self.assertEqual(log.read_text().count('set '),1)


class ServerPressure(Base):
    def setUp(self):
        super().setUp()
        boatd.CFG['state_dataset']='offbox/boatd'
        self.stack=contextlib.ExitStack();self.addCleanup(self.stack.close)
        self.stack.enter_context(patch.object(disk,'sample',return_value=storage()))
        self.stack.enter_context(patch.object(disk,'inventory',return_value=({},[])))
        self.stack.enter_context(patch.object(disk,'cleanup_pressure',return_value={'freeing_bytes':0,'io_full_avg10':0,'io_some_avg10':0}))

    def test_large_pool_admission_and_health_use_capped_floor(self):
        boatd.READY.set()
        self.f.sh[('zpool','list')]=(0,'ONLINE')
        for free, admitted in ((90, True), (39, False)):
            with self.subTest(free=free), patch.object(disk, 'sample', return_value=storage(free*G,1744*G)):
                boatd.disk_state(fresh=True)
                if admitted:
                    boatd.disk_admit()
                else:
                    with self.assertRaises(boatd.Fail) as caught:
                        boatd.disk_admit()
                    self.assertEqual(caught.exception.code, 'server_disk_low')
                self.assertEqual(boatd.health(fresh=True)['ok'], admitted)

    def test_large_pool_cleanup_caps_persisted_target_and_clears_shortfall(self):
        self.con.execute("INSERT INTO meta(k,v) VALUES('disk_cleanup',?)", (json.dumps({'target_bytes':436*G}),))
        for free, shortfall in ((90,40), (131,0)):
            with self.subTest(free=free), patch.object(disk,'sample',return_value=storage(free*G,1744*G)):
                result=boatd.disk_maintenance(self.con)
                self.assertEqual(result['cleanup']['shortfall_bytes'],shortfall*G)
                state=json.loads(self.con.execute("SELECT v FROM meta WHERE k='disk_cleanup'").fetchone()[0])
                self.assertEqual(state['target_bytes'],130*G if shortfall else 0)
        self.assertFalse(any(c[:2]==('snapshot','delete') for c in self.f.calls))

    def test_cached_health_keeps_disk_truth_without_waiting_for_slow_refresh(self):
        boatd.READY.set()
        for level in ('ok', 'full', 'unknown'):
            value = dict(storage(), level=level, disk_full=level == 'full', disk_low=level != 'ok')
            with self.subTest(level=level), patch.object(boatd, 'disk_state', return_value=value):
                boatd.health(fresh=True)
                boatd._HEALTH['ts'] = boatd.now() - 900
                boatd._HEALTH_LOCK.acquire()
                try:
                    with patch.object(boatd, '_sh', side_effect=AssertionError('request must not refresh')), \
                            patch.object(disk, 'sample', side_effect=AssertionError('request must not sample')):
                        health = boatd.health()
                finally:
                    boatd._HEALTH_LOCK.release()
            self.assertEqual(health['disk']['level'], level)
            self.assertEqual(health['disk_full'], level == 'full')
            self.assertEqual(health['ok'], level == 'ok')
            self.assertGreaterEqual(health['snapshot_age_s'], 900)

    def test_all_protected_box_classes_survive(self):
        ids=[self.box('bx_'+str(i)*8,owner='moni' if i==1 else 'ardud') for i in range(9)]
        self.con.execute('UPDATE boxes SET pinned=1 WHERE id=?',(ids[0],))
        self.cmd(ids[2],status='running');self.cmd(ids[3],status='queued');self.cmd(ids[4],status='interrupted')
        self.con.execute("INSERT INTO saved(owner,name,source,status) VALUES('ardud','base',?,'pending')",(ids[5],))
        self.con.execute("UPDATE boxes SET state='resuming' WHERE id=?",(ids[6],))
        self.cmd(ids[7],status=None);self.cmd(ids[8],status='exited')
        self.assertEqual(boatd.snapshot_protected(self.con),set(ids))

    def test_pressure_prunes_oldest_only_and_logs_actual_free_bytes(self):
        bid=self.box();rows=snaps(bid)
        self.con.executemany('INSERT INTO snaps VALUES (?,?,?,?)',[(bid,r['name'],'auto',r['created_at']) for r in rows])
        self.f.snapshots[boatd.ct(bid)]=[{'name':r['name']} for r in rows]
        self.f.sh[('zfs','get')]=(0,'-')
        with patch.object(disk,'sample',side_effect=[storage(15*G),storage(30*G)]), \
             patch.object(disk,'inventory',return_value=({bid:{'snapshot_bytes':2*G,'live_bytes':10*G}},rows)), \
             patch.object(boatd.toollog,'emit') as emit:
            got=boatd.disk_maintenance(self.con)
        self.assertEqual(got['level'],'ok')
        self.assertEqual([c[3] for c in self.f.calls if c[:2]==('snapshot','delete')],['auto-0'])
        event=next(c for c in emit.call_args_list if c.args[1]=='snapshot.prune')
        self.assertEqual(event.kwargs['props']['bytes_freed'],15*G)
        self.assertIsNone(self.con.execute("SELECT * FROM snaps WHERE name='auto-0'").fetchone())
        self.assertEqual(json.loads(self.con.execute("SELECT v FROM meta WHERE k='disk'").fetchone()[0])['level'],'ok')

    def test_unknown_incusive_instances_are_never_cleanup_candidates(self):
        bid='bx_unknown0';rows=snaps(bid)
        self.f.snapshots[boatd.ct(bid)]=[{'name':r['name']} for r in rows]
        self.f.sh[('zfs','get')]=(0,'-')
        with patch.object(disk,'sample',return_value=storage(15*G)),patch.object(disk,'inventory',return_value=({},rows)):
            boatd.disk_maintenance(self.con)
        self.assertFalse(any(c[:2]==('snapshot','delete') for c in self.f.calls))

    def test_box_byte_limit_also_covers_resized_large_repository_boxes(self):
        bid=self.box(name='offbox robob-mission-control | repository pool');rows=snaps(bid)
        self.f.snapshots[boatd.ct(bid)]=[{'name':r['name']} for r in rows];self.f.sh[('zfs','get')]=(0,'-')
        self.con.execute("UPDATE boxes SET type='large' WHERE id=?",(bid,))
        with patch.object(disk,'inventory',side_effect=[({bid:{'snapshot_bytes':8*G,'live_bytes':10*G}},rows),
                                                     ({bid:{'snapshot_bytes':4*G,'live_bytes':10*G}},rows)]):
            boatd.disk_maintenance(self.con)
        self.assertEqual([c[3] for c in self.f.calls if c[:2]==('snapshot','delete')],['auto-0'])

    def test_auto_snapshot_skips_below_floor(self):
        bid=self.box()
        with patch.object(disk,'sample',return_value=storage(0)),patch.object(boatd.toollog,'emit') as emit:
            self.assertIsNone(boatd.snapshot(self.con,bid,'auto'))
        self.assertFalse(any(c[:2]==('snapshot','create') for c in self.f.calls))
        self.assertTrue(any(c.args[1]=='snapshot.skip' for c in emit.call_args_list))

    def test_creates_resumes_and_starts_refused_without_mutation(self):
        bid=self.box()
        with patch.object(disk,'sample',return_value=storage(0)):
            for action in [lambda:boatd.create_box(self.con,{},None,'ardud'),
                           lambda:boatd.resume_box(self.con,bid,{}),
                           lambda:boatd.start_cmd(self.con,bid,{'command':'true'})]:
                with self.subTest(action=action),self.assertRaises(boatd.Fail) as caught:action()
                self.assertEqual(caught.exception.code,'server_disk_low')
        self.assertEqual(self.con.execute('SELECT COUNT(*) FROM commands').fetchone()[0],0)
        self.assertFalse(self.f.spawned)

    def test_health_detects_full_even_when_database_reads_work_and_omits_box_data(self):
        boatd.READY.set();self.f.sh[('zpool','list')]=(0,'ONLINE')
        with patch.object(disk,'sample',return_value={**storage(0),'boxes':{'private':{}}}):
            out=boatd.health(fresh=True)
        self.assertFalse(out['ok']);self.assertTrue(out['disk_full']);self.assertNotIn('boxes',out['disk'])

    def test_full_write_failure_survives_healthy_reads_until_sampler_can_write(self):
        class FailedWrite:
            def execute(inner, *args):
                raise sqlite3.OperationalError('database or disk is full')
        with patch.object(disk,'sample',side_effect=lambda *a:storage()):
            boatd.disk_maintenance(FailedWrite())
            self.assertTrue(boatd.disk_state(fresh=True)['disk_full'])
            value=boatd.disk_maintenance(self.con)
            self.assertTrue(value['write_ok']);self.assertGreater(value['written_at'],0)
            self.assertEqual(boatd.disk_state(fresh=True)['level'],'ok')

    def test_sampler_keeps_pressure_in_memory_when_sqlite_cannot_write(self):
        with patch.object(disk,'sample',return_value=storage(0)),patch.object(boatd.toollog,'emit') as emit:
            out=boatd.disk_maintenance(None)
        self.assertTrue(out['disk_full']);self.assertTrue(boatd.DISK['value']['disk_full'])
        self.assertTrue(any(c.args[1]=='disk.sample' for c in emit.call_args_list))


class Round2(Base):
    def setUp(self):
        super().setUp()
        boatd.CFG['state_dataset']='offbox/boatd'
        self.stack=contextlib.ExitStack();self.addCleanup(self.stack.close)
        self.clock = 2000
        self.free = 15*G
        self.pressure = {'freeing_bytes': 0, 'io_full_avg10': 0, 'io_some_avg10': 0}
        self.stack.enter_context(patch.object(boatd, 'now', side_effect=lambda: self.clock))
        self.stack.enter_context(patch.object(disk, 'cleanup_pressure', side_effect=lambda *_: dict(self.pressure), create=True))
        self.stack.enter_context(patch.object(disk, 'sample', side_effect=lambda *_: storage(self.free)))
        self.f.sh[('zfs','get')] = (0, '-')

    def install_rows(self, rows, sizes):
        for row in rows:
            self.f.snapshots.setdefault(boatd.ct(row['box']), []).append({'name': row['name']})
        self.stack.enter_context(patch.object(disk, 'inventory', side_effect=lambda *_: (sizes, [
            r for r in rows if any(x['name'] == r['name'] for x in self.f.snapshots[boatd.ct(r['box'])]) ])))

    def deletes(self):
        return [c for c in self.f.calls if c[:2] == ('snapshot','delete')]

    def test_freeing_and_live_io_pressure_yield_without_delete(self):
        bid=self.box();self.install_rows(snaps(bid), {})
        for pressure in ({'freeing_bytes': 6*G}, {'io_full_avg10': 15}):
            with self.subTest(pressure=pressure), patch.object(boatd.toollog, 'emit') as emit:
                self.pressure.update(freeing_bytes=0, io_full_avg10=0, io_some_avg10=0)
                self.pressure.update(pressure)
                boatd.disk_maintenance(self.con)
                self.assertEqual(self.deletes(), [])
                self.assertTrue(any(c.args[1] == 'snapshot.yield' for c in emit.call_args_list))

    def test_count_retention_has_a_bounded_number_of_full_command_scans(self):
        for i in range(80):
            self.box('bx_'+str(i).zfill(8))
        queries=[]
        self.con.set_trace_callback(queries.append)
        try:
            boatd.disk_maintenance(self.con)
        finally:
            self.con.set_trace_callback(None)
        scans=[q for q in queries if q.upper().startswith('SELECT') and 'FROM COMMANDS' in q.upper()
               and 'WHERE BOX_ID' not in q.upper()]
        self.assertLess(len(scans),10, 'full protection scans must not grow with box count')

    def test_pin_added_during_count_selection_is_rechecked_before_delete(self):
        bid=self.box()
        self.install_rows(snaps(bid),{})
        original=boatd.snaps_to_prune
        def pin_during_selection(*args):
            selected=original(*args)
            self.con.execute('UPDATE boxes SET pinned=1 WHERE id=?',(bid,))
            return selected
        with patch.object(boatd,'snaps_to_prune',side_effect=pin_during_selection):
            boatd.disk_maintenance(self.con)
        self.assertEqual(self.deletes(),[])
        self.assertTrue(self.state(bid)['pinned'])

    def test_unreadable_backpressure_yields_instead_of_deleting(self):
        bid=self.box();self.install_rows(snaps(bid),{})
        with patch.object(disk,'cleanup_pressure',side_effect=OSError('unavailable')),patch.object(boatd.toollog,'emit') as emit:
            boatd.disk_maintenance(self.con)
        self.assertEqual(self.deletes(),[])
        self.assertTrue(any(c.args[1]=='snapshot.yield' and c.kwargs['props']['reason']=='pressure_unknown' for c in emit.call_args_list))

    def test_async_freeing_and_pacing_prevent_delete_bursts_across_ticks(self):
        bid=self.box();self.install_rows(snaps(bid), {})
        original=self.f.incus
        def remove(*a, **kw):
            result=original(*a, **kw)
            if a[:2] == ('snapshot','delete'):
                self.pressure['freeing_bytes']=6*G
            return result
        with patch.object(boatd, 'incus', side_effect=remove):
            boatd.disk_maintenance(self.con)
            self.assertEqual(len(self.deletes()), 1)
            self.clock+=60
            boatd.disk_maintenance(self.con)
            self.assertEqual(len(self.deletes()), 1)
            self.pressure['freeing_bytes']=0
            boatd.disk_maintenance(self.con)
            self.assertEqual(len(self.deletes()), 2)
            boatd.disk_maintenance(self.con)
            self.assertEqual(len(self.deletes()), 2)

    def test_budget_box_after_258_irrelevant_candidates_is_not_starved(self):
        self.free=30*G
        rows=[];sizes={}
        for i in range(86):
            bid=self.box('bx_'+str(i).zfill(8))
            rows+=snaps(bid)
            sizes[bid]={'snapshot_bytes':G, 'live_bytes':10*G}
        target=self.box('bx_target00', name='offbox mission-control | repository pool')
        newer=snaps(target)
        for row in newer:row['created_at']+=1000
        rows+=newer;sizes[target]={'snapshot_bytes':8*G,'live_bytes':10*G}
        self.install_rows(rows,sizes)
        boatd.disk_maintenance(self.con)
        self.assertEqual([(c[2],c[3]) for c in self.deletes()], [(boatd.ct(target),'auto-0')])

    def test_oversized_box_goes_first_only_while_the_pool_has_room(self):
        small=self.box('bx_small000');large=self.box('bx_large000',name='offbox repository pool')
        rows=snaps(small)+snaps(large)
        for row in rows:
            if row['box']==large:row['created_at']+=1000
        self.install_rows(rows,{small:{'snapshot_bytes':G,'live_bytes':10*G},
                                large:{'snapshot_bytes':8*G,'live_bytes':10*G}})
        self.free=30*G
        boatd.disk_maintenance(self.con)
        self.assertEqual([(c[2],c[3]) for c in self.deletes()],[(boatd.ct(large),'auto-0')])
        # Short pool: strictly oldest first across boxes, whatever their budgets.
        self.free=15*G;self.clock+=60
        boatd.disk_maintenance(self.con)
        self.assertEqual([(c[2],c[3]) for c in self.deletes()][1:],[(boatd.ct(small),'auto-0')])

    def test_byte_target_survives_warn_crossing_and_stop_snapshots_are_eligible(self):
        bid=self.box();self.install_rows(snaps(bid,kind='stop'), {})
        original=self.f.incus
        def remove(*a, **kw):
            result=original(*a, **kw)
            if a[:2] == ('snapshot','delete'):self.free+=6*G
            return result
        with patch.object(boatd, 'incus', side_effect=remove):
            boatd.disk_maintenance(self.con)
            self.assertEqual(len(self.deletes()), 1)
            self.assertEqual(self.free,21*G)
            self.clock+=60
            boatd.disk_maintenance(self.con)
            self.assertEqual(len(self.deletes()), 2)
            self.assertGreaterEqual(self.free,25*G)
            self.clock+=60
            boatd.disk_maintenance(self.con)
            self.assertEqual(len(self.deletes()), 2)

    def test_mixed_run_history_keeps_newest_three_and_protected_stop_snapshots(self):
        rows=snaps('a', kind='stop')+snaps('a')+snaps('b',kind='stop')+snaps('a',kind='hourly')
        rows[0]['clones']=True
        got=disk.candidates(rows,{'b'})
        self.assertTrue(any(r['kind']=='stop' for r in got))
        self.assertTrue(all(r['box']=='a' and r['kind'] in ('auto','stop') and not r['clones'] for r in got))
        newest=sorted([r for r in rows if r['box']=='a' and r['kind'] in ('auto','stop')],key=lambda r:(r['created_at'],r['name']),reverse=True)[:3]
        self.assertFalse({r['name'] for r in newest}&{r['name'] for r in got})

    def test_external_prune_and_delete_race_drop_stale_rows_without_freed_bytes(self):
        bid=self.box();rows=snaps(bid)
        self.install_rows(rows,{})
        self.con.execute('INSERT INTO snaps VALUES (?,?,?,?)',(bid,'auto-already-gone','auto',-1))
        self.con.execute('INSERT INTO snaps VALUES (?,?,?,?)',(bid,'auto-0','auto',0))
        original=self.f.incus
        def missing(*a, **kw):
            if a[:2] == ('snapshot','delete'):
                self.f.calls.append(a)
                return subprocess.CompletedProcess(a,1,b'',b'Error: Snapshot not found')
            return original(*a, **kw)
        with patch.object(boatd,'incus',side_effect=missing),patch.object(boatd.toollog,'emit') as emit:
            boatd.disk_maintenance(self.con)
            self.clock+=60
            boatd.disk_maintenance(self.con)
        names=[c[3] for c in self.deletes()]
        self.assertEqual(names.count('auto-0'),1)
        self.assertEqual(self.con.execute('SELECT COUNT(*) FROM snaps').fetchone()[0],0)
        events=[c for c in emit.call_args_list if c.args[1]=='snapshot.prune']
        self.assertTrue(events)
        self.assertTrue(all(c.kwargs['props']['reason']=='missing' and c.kwargs['props']['bytes_freed']==0 for c in events))
        self.assertTrue(all(c.kwargs['ok'] for c in events))

    def test_snapshot_created_during_inventory_is_not_removed_as_stale(self):
        bid=self.box()
        def inventory(*_):
            self.con.execute('INSERT OR IGNORE INTO snaps VALUES (?,?,?,?)',(bid,'auto-new','auto',self.clock+1))
            return {},[]
        with patch.object(disk,'inventory',side_effect=inventory):
            boatd.disk_maintenance(self.con)
        self.assertIsNotNone(self.con.execute("SELECT * FROM snaps WHERE name='auto-new'").fetchone())

    def test_short_pool_keeps_no_run_snapshot_back_and_skips_new_ones(self):
        # 22 Nov 2026: every box sat at its newest three, cleanup had no candidate and the pool stayed full for 22 h.
        bid=self.box(name='offbox mission-control | repository pool')
        self.install_rows(snaps(bid,count=3),{bid:{'snapshot_bytes':60*G,'live_bytes':100*G}})
        value=boatd.disk_maintenance(self.con)
        self.assertEqual(value['cleanup']['shortfall_bytes'],10*G)
        self.assertEqual(value['cleanup']['budget_shortfall_bytes'],10*G)
        self.assertEqual(value['cleanup']['snapshots_left'],3)
        self.assertEqual([c[3] for c in self.deletes()],['auto-0'])
        for _ in range(3):
            self.clock+=60
            value=boatd.disk_maintenance(self.con)
        self.assertEqual([c[3] for c in self.deletes()],['auto-0','auto-1','auto-2'])
        self.assertEqual(value['cleanup']['snapshots_left'],0)
        for kind in ('auto','stop'):
            self.assertIsNone(boatd.snapshot(self.con,bid,kind))
        self.assertFalse(any(c[:2]==('snapshot','create') for c in self.f.calls))

    def test_pool_with_room_keeps_the_newest_three(self):
        bid=self.box(name='offbox mission-control | repository pool')
        self.install_rows(snaps(bid,count=3),{bid:{'snapshot_bytes':60*G,'live_bytes':100*G}})
        self.free=30*G
        value=boatd.disk_maintenance(self.con)
        self.assertEqual(self.deletes(),[])
        self.assertEqual(value['cleanup']['snapshots_left'],0)

    def test_short_pool_never_takes_person_pinned_saved_busy_or_cloned_snapshots(self):
        hers=self.box('bx_hers0000',owner='moni');pinned=self.box('bx_pinned00');base=self.box('bx_base0000')
        busy=self.box('bx_busy0000');origin=self.box('bx_origin00');free=self.box('bx_free0000')
        self.con.execute('UPDATE boxes SET pinned=1 WHERE id=?',(pinned,))
        self.con.execute("INSERT INTO saved(owner,name,source,status) VALUES('ardud','base',?,'ready')",(base,))
        self.cmd(busy,status='running',age=5*86400)
        rows=[r for b in (hers,pinned,base,busy,origin) for r in snaps(b,count=2)]
        for row in rows:
            if row['box']==origin:row['clones']=True
        later=snaps(free,count=2)
        for row in later:row['created_at']+=1000
        self.install_rows(rows+later,{})
        for _ in range(4):
            boatd.disk_maintenance(self.con);self.clock+=60
        self.assertEqual([(c[2],c[3]) for c in self.deletes()],[(boatd.ct(free),'auto-0'),(boatd.ct(free),'auto-1')])

    def test_ended_command_without_a_result_protects_for_a_day_only(self):
        self.clock=10*86400
        old=self.box('bx_old00000');fresh=self.box('bx_fresh000');live=self.box('bx_live0000');done=self.box('bx_done0000')
        self.cmd(old,pid=1,status='interrupted',age=2*86400);self.cmd(old,pid=2,status='lost',age=3*86400)
        self.cmd(old,pid=3,status='exited',age=4*86400)
        self.cmd(fresh,status='interrupted',age=3600)
        self.cmd(live,pid=1,status='running',age=5*86400);self.cmd(live,pid=2,status='queued',age=5*86400)
        self.cmd(done,status='exited',age=60);self.con.execute('UPDATE commands SET exit_code=0 WHERE box_id=?',(done,))
        self.assertEqual(boatd.snapshot_protected(self.con),{fresh,live})
        boatd.CFG['unreconciled_protect_s']=5*86400
        self.assertEqual(boatd.snapshot_protected(self.con),{old,fresh,live})

    def test_protection_query_reads_the_index_not_the_command_rows(self):
        plan=' '.join(r[3] for r in self.con.execute(
            "EXPLAIN QUERY PLAN SELECT DISTINCT box_id FROM commands WHERE status IS NULL OR status IN ('queued','running') OR "
            "((status NOT IN ('exited','killed') OR exit_code IS NULL) AND "
            "MAX(COALESCE(ended_at,0), COALESCE(started_at,0), COALESCE(created_at,0)) > ?)",(0,)))
        self.assertIn('COVERING INDEX commands_unsettled',plan)

    def test_refused_snapshot_steps_aside_for_an_hour(self):
        bid=self.box();self.install_rows(snaps(bid,count=3),{})
        original=self.f.incus
        def refuse(*a,**kw):
            if a[:2]==('snapshot','delete') and a[3]=='auto-0':
                self.f.calls.append(a)
                return subprocess.CompletedProcess(a,1,b'',b'dataset is busy')
            return original(*a,**kw)
        with patch.object(boatd,'incus',side_effect=refuse):
            boatd.disk_maintenance(self.con);self.clock+=60
            boatd.disk_maintenance(self.con);self.clock+=3600
            boatd.disk_maintenance(self.con)
        self.assertEqual([c[3] for c in self.deletes()],['auto-0','auto-1','auto-0'])

    def test_count_retention_cannot_bypass_pacing_or_pressure(self):
        bid=self.box()
        self.install_rows(snaps(bid,count=25),{})
        self.con.executemany('INSERT INTO snaps VALUES (?,?,?,?)',[(bid,'auto-'+str(i),'auto',i) for i in range(25)])
        boatd.CFG['retention']['run_daily_days']=0
        self.pressure['io_full_avg10']=15
        boatd.prune_snaps(self.con,bid)
        self.assertEqual(self.deletes(),[])
        self.pressure['io_full_avg10']=0
        boatd.prune_snaps(self.con,bid)
        self.assertEqual(len(self.deletes()),1)
        boatd.prune_snaps(self.con,bid)
        self.assertEqual(len(self.deletes()),1)

    def test_delete_gap_starts_after_slow_delete_returns(self):
        bid=self.box();self.install_rows(snaps(bid),{})
        original=self.f.incus
        def slow(*a, **kw):
            result=original(*a, **kw)
            if a[:2]==('snapshot','delete'):self.clock+=60
            return result
        with patch.object(boatd,'incus',side_effect=slow):
            boatd.disk_maintenance(self.con)
            boatd.disk_maintenance(self.con)
        self.assertEqual(len(self.deletes()),1)

    def stop_with_cleanup_failure(self, failure, during_prune=False):
        bid=self.box('bx_stop0000')
        other=self.box('bx_cleanup0')
        self.install_rows(snaps(other),{})
        original=self.f.incus
        inventory=disk.inventory
        attempted=[]
        def remove(*a, **kw):
            if a[:2]==('snapshot','delete'):
                attempted.append(a)
                if failure=='delete_timeout':
                    self.f.calls.append(a)
                    self.clock+=120
                    raise subprocess.TimeoutExpired(a,120)
            return original(*a, **kw)
        def measured(*a):
            if attempted and failure=='post_delete_inventory':
                raise OSError('ZFS inventory unavailable')
            return inventory(*a)
        with contextlib.ExitStack() as stack:
            stack.enter_context(patch.object(boatd,'incus',side_effect=remove))
            stack.enter_context(patch.object(disk,'inventory',side_effect=measured))
            emit=stack.enter_context(patch.object(boatd.toollog,'emit'))
            if during_prune:
                stack.enter_context(patch.object(boatd,'snapshot',return_value=None))
            boatd.stop_box(self.con,bid,'idle')
        self.assertNotIn(bid,self.f.running)
        self.assertEqual(self.state(bid)['state'],'archived')
        self.assertEqual(self.state(bid)['stopped_at'],self.clock)
        self.assertEqual(self.state(other)['state'],'ready')
        self.assertIn(other,self.f.running)
        self.assertEqual([(a[2],a[3]) for a in attempted],[(boatd.ct(other),'auto-0')])
        fence=json.loads(self.con.execute("SELECT v FROM meta WHERE k='disk_cleanup'").fetchone()[0])
        self.assertEqual(fence['last_delete_at'],self.clock)
        events=[c for c in emit.call_args_list if c.args[1]=='snapshot.defer']
        self.assertEqual(len(events),1)
        self.assertFalse(events[0].kwargs['ok'])
        self.assertEqual(events[0].kwargs['ids'],{'box':bid})
        self.assertEqual(events[0].kwargs['props']['reason'],'cleanup_failed')
        self.assertIn('timed out' if failure=='delete_timeout' else 'inventory unavailable',events[0].kwargs['props']['error'])
        boatd.disk_maintenance(self.con)
        self.assertEqual(len(self.deletes()),1)

    def test_stop_archives_when_unrelated_delete_times_out_and_keeps_fence(self):
        self.stop_with_cleanup_failure('delete_timeout')

    def test_stop_archives_when_post_delete_inventory_fails_and_keeps_fence(self):
        self.stop_with_cleanup_failure('post_delete_inventory')

    def test_stop_archives_when_count_cleanup_delete_times_out_and_keeps_fence(self):
        self.stop_with_cleanup_failure('delete_timeout',during_prune=True)

    def test_container_stop_failure_still_propagates_without_archiving(self):
        bid=self.box()
        def stop_failure(*args,**kwargs):
            if args[0]=='stop': raise subprocess.TimeoutExpired(['incus','stop'],120)
            return self.f.incus(*args,**kwargs)
        with patch.object(boatd,'incus',side_effect=stop_failure) as incus, \
             patch.object(boatd.toollog,'emit') as emit:
            with self.assertRaises(subprocess.TimeoutExpired):
                boatd.stop_box(self.con,bid,'idle')
        self.assertIn(bid,self.f.running)
        self.assertEqual(self.state(bid)['state'],'stopping')
        self.assertTrue(any(c.args[0]=='stop' for c in incus.call_args_list))
        self.assertFalse(any(c.args[1]=='snapshot.defer' for c in emit.call_args_list))


class CleanupMeasurements(unittest.TestCase):
    def test_zfs_freeing_and_both_live_psi_lines_are_read(self):
        from unittest.mock import mock_open
        with patch.object(disk,'command',return_value=str(6*G)),patch('builtins.open',mock_open(read_data=
            'some avg10=22.0 avg60=0 avg300=0 total=100\nfull avg10=15.0 avg60=0 avg300=0 total=99\n')):
            measured=disk.cleanup_pressure('offbox')
        self.assertEqual(measured,{'freeing_bytes':6*G,'io_full_avg10':15.0,'io_some_avg10':22.0})
        self.assertEqual(disk.yield_reason(measured),'zfs_freeing')
        measured['freeing_bytes']=0
        self.assertEqual(disk.yield_reason(measured),'io_pressure')
        measured['io_full_avg10']=14.9
        self.assertIsNone(disk.yield_reason(measured))


class StoppedBoxes(Base):
    """The reaper's deletes of stopped disposable boxes: by age always, by space only as the last resort."""

    def setUp(self):
        super().setUp()
        boatd.CFG['state_dataset']='offbox/boatd'
        self.stack=contextlib.ExitStack();self.addCleanup(self.stack.close)
        self.clock=100*86400
        self.cleanup={'shortfall_bytes':10*G,'snapshots_left':0}
        self.pressure={'freeing_bytes':0,'io_full_avg10':0,'io_some_avg10':0}
        self.stack.enter_context(patch.object(boatd,'now',side_effect=lambda:self.clock))
        self.stack.enter_context(patch.object(boatd,'disk_state',side_effect=lambda *a,**k:{
            'level':'low','disk_low':True,'disk_full':False,'filesystems':[],'cleanup':dict(self.cleanup)}))
        self.stack.enter_context(patch.object(disk,'cleanup_pressure',side_effect=lambda *_:dict(self.pressure)))
        self.stack.enter_context(patch.object(boatd,'delete_box',side_effect=self.delete))
        boatd.REAP_REFUSED.clear()
        self.deleted=[];self.refuse=set()

    def delete(self,con,bid,why=None):
        if bid in self.refuse:
            raise boatd.Fail(409,'box_held',f'{bid} is held')
        self.deleted.append((bid,why))
        con.execute('UPDATE boxes SET deleted_at=? WHERE id=?',(self.clock,bid))

    def stopped(self,bid,hours,**kw):
        kw.setdefault('name','offbox some-repo | repository pool')
        self.box(bid,state='archived',running=False,**kw)
        self.con.execute('UPDATE boxes SET stopped_at=? WHERE id=?',(self.clock-hours*3600,bid))
        return bid

    def passes(self,count=1,gap=60):
        for _ in range(count):
            boatd.reap_once(self.con);self.clock+=gap

    def test_short_pool_with_no_snapshot_left_takes_the_longest_stopped_box_one_per_pass(self):
        a=self.stopped('bx_a0000000',30);b=self.stopped('bx_b0000000',50);self.stopped('bx_new00000',11)
        self.passes()
        self.assertEqual(self.deleted,[(b,'pool short of space: longest-stopped disposable box')])
        self.passes(3)
        self.assertEqual([d[0] for d in self.deleted],[b,a])

    def test_space_alone_never_takes_person_pinned_saved_busy_or_clone_origin_boxes(self):
        self.stopped('bx_hers0000',500,owner='moni');pinned=self.stopped('bx_pinned00',50)
        base=self.stopped('bx_base0000',50);pending=self.stopped('bx_pending0',50)
        recent=self.stopped('bx_recent00',50);origin=self.stopped('bx_origin00',50)
        self.con.execute('UPDATE boxes SET pinned=1 WHERE id=?',(pinned,))
        self.con.execute("INSERT INTO saved(owner,name,source,status) VALUES('ardud','base',?,'ready')",(base,))
        self.con.execute("INSERT INTO saved(owner,name,source,status) VALUES('ardud','next',?,'pending')",(pending,))
        self.cmd(recent,status='interrupted',age=3600)
        self.f.sh[('zfs','list','-Hp','-t','snapshot','-o','clones','-r',f'offbox/incus/containers/{boatd.ct(origin)}')]=(0,'-\noffbox/incus/containers/bx-copy\n')
        self.passes(3)
        self.assertEqual(self.deleted,[])

    def test_space_deletes_wait_for_snapshots_room_drain_and_gap(self):
        a=self.stopped('bx_a0000000',30);b=self.stopped('bx_b0000000',50)
        for change in ({'snapshots_left':4},{'shortfall_bytes':0}):
            with self.subTest(change=change):
                saved=dict(self.cleanup);self.cleanup.update(change)
                self.passes();self.assertEqual(self.deleted,[])
                self.cleanup=saved
        for pressure in ({'freeing_bytes':6*G},{'io_full_avg10':15}):
            with self.subTest(pressure=pressure):
                self.pressure.update(pressure)
                self.passes();self.assertEqual(self.deleted,[])
                self.pressure.update(freeing_bytes=0,io_full_avg10=0)
        self.passes(1,gap=15);self.passes(1,gap=15)
        self.assertEqual([d[0] for d in self.deleted],[b],'a second delete inside the gap would be a burst')
        self.passes(1,gap=60);self.passes()
        self.assertEqual([d[0] for d in self.deleted],[b,a])

    def test_age_alone_deletes_with_room_one_per_pass_oldest_first(self):
        self.cleanup={'shortfall_bytes':0,'snapshots_left':0}
        old=self.stopped('bx_old00000',9*24);older=self.stopped('bx_older000',20*24);self.stopped('bx_young000',6*24)
        self.passes()
        self.assertEqual(self.deleted,[(older,'archived box exceeded unused retention')])
        self.passes(2)
        self.assertEqual([d[0] for d in self.deleted],[older,old])

    def test_templates_and_other_named_boxes_keep_the_long_retention_and_never_go_for_space(self):
        template=self.stopped('bx_template',20*24,name='offbox template crpko-node')
        self.passes(3)
        self.assertEqual(self.deleted,[])
        self.con.execute('UPDATE boxes SET stopped_at=? WHERE id=?',(self.clock-31*86400,template))
        self.passes()
        self.assertEqual(self.deleted,[(template,'archived box exceeded unused retention')])

    def test_refused_box_steps_aside_so_the_next_one_goes(self):
        held=self.stopped('bx_held0000',50);free=self.stopped('bx_free0000',30)
        self.refuse.add(held)
        self.passes(2)
        self.assertEqual([d[0] for d in self.deleted],[free])
        self.refuse.clear();self.clock+=3600
        self.passes()
        self.assertEqual([d[0] for d in self.deleted],[free,held])


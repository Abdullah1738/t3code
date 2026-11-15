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

    def test_pressure_prioritizes_oversized_box_over_older_small_history(self):
        small=self.box('bx_small000');large=self.box('bx_large000',name='offbox repository pool')
        rows=snaps(small)+snaps(large)
        for row in rows:
            if row['box']==large:row['created_at']+=1000
        self.install_rows(rows,{small:{'snapshot_bytes':G,'live_bytes':10*G},
                                large:{'snapshot_bytes':8*G,'live_bytes':10*G}})
        boatd.disk_maintenance(self.con)
        self.assertEqual([(c[2],c[3]) for c in self.deletes()],[(boatd.ct(large),'auto-0')])

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

    def test_protected_floor_exposes_byte_shortfall_and_skips_new_run_snapshots(self):
        bid=self.box(name='offbox mission-control | repository pool')
        self.install_rows(snaps(bid,count=3),{bid:{'snapshot_bytes':60*G,'live_bytes':100*G}})
        value=boatd.disk_maintenance(self.con)
        self.assertEqual(value['cleanup']['shortfall_bytes'],10*G)
        self.assertEqual(value['cleanup']['budget_shortfall_bytes'],10*G)
        self.assertEqual(value['snapshot_bytes_by_kind']['auto'],3*G)
        self.assertEqual(self.deletes(),[])
        for kind in ('auto','stop'):
            self.assertIsNone(boatd.snapshot(self.con,bid,kind))
        self.assertFalse(any(c[:2]==('snapshot','create') for c in self.f.calls))

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

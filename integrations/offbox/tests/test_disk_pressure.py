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

    def test_oldest_first_keeps_newest_three_and_clone_origins_and_all_other_kinds(self):
        rows = snaps('a') + snaps('b') + snaps('a', kind='stop') + snaps('a', kind='hourly')
        rows[0]['clones'] = True
        got = disk.candidates(rows, {'b'})
        self.assertEqual([(r['box'],r['name']) for r in got], [('a','auto-1'),('a','auto-2')])

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

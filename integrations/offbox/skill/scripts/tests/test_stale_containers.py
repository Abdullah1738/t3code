"""Exercise cleanup ownership and failure behavior without a Docker daemon."""
import json
import os
from pathlib import Path
import subprocess
import sys
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from tests._env import clean_env
from offbox_lib import containers, runs
from test_capacity import Isolated

DOCKER = r'''#!/usr/bin/env python3
import json,os,pathlib,sys,time
p=pathlib.Path(os.environ['FAKE_STATE']); data=json.loads(p.read_text()); args=sys.argv[1:]
with open(os.environ['FAKE_CALLS'],'a') as f:f.write(json.dumps(args)+'\n')
if args[0]=='ps':
 if os.environ.get('PS_FAIL'):sys.exit(1)
 print('\n'.join(c['id'] for c in data))
elif args[0]=='inspect':
 if os.environ.get('INSPECT_FAIL'):sys.exit(1)
 for c in data:
  if c['id'] in args:print('\t'.join((c['id'],'/'+c['name'],str(c['running']).lower(),'0',c['created'])))
 if os.environ.get('ADD_LATE'):
  data.append(dict(id='c'*64,name='new-active',running=True,created='2026-11-13T00:00:00Z'));p.write_text(json.dumps(data))
elif args[0]=='rm':
 if os.environ.get('RM_HANG'):time.sleep(60)
 if os.environ.get('RM_FAIL'):sys.exit(1)
 p.write_text(json.dumps([c for c in data if c['id'] not in args]))
'''


def item(char, name='earlier', created='2026-11-12T00:00:00Z'):
    return dict(id=char*64, name=name, running=True, created=created)


class StaleContainersTests(Isolated):
    def setUp(self):
        super().setUp()
        self.home=Path(self.tmp.name)/'remote'; self.home.mkdir()
        bins=self.home/'bin'; bins.mkdir()
        tools={'docker':DOCKER,'systemctl':'#!/bin/sh\nexit ${SYSTEMCTL_RC:-0}\n',
               'timeout':'#!/bin/sh\n[ "$1" = -k ] && shift 2\nshift\nexec "$@"\n'}
        for name,body in tools.items():
            p=bins/name; p.write_text(body); p.chmod(0o755)
        self.state=self.home/'state'; self.state.write_text(json.dumps([item('a')]))
        self.calls=self.home/'calls'
        self.env=clean_env(HOME=str(self.home),PATH=str(bins)+os.pathsep+os.environ['PATH'],
                      FAKE_STATE=str(self.state),FAKE_CALLS=str(self.calls))
        self.box('bx',member=True)
        self.con.execute("INSERT INTO runs(run_id,box_id,status,end_at,docker) VALUES ('r','bx','killed',?,0)",(1794528000,))
        self.con.execute("INSERT INTO kv(k,v) VALUES ('containers_expected:r','1')"); self.con.commit()
        self.row=self.con.execute("SELECT * FROM runs WHERE run_id='r'").fetchone()

    def execute(self, preserve='', fast=False):
        script=containers.script('r',runs.BOUNDED_PROCESS,preserve=preserve)
        if fast: script=script.replace('], 12)','], 0.1)')
        return subprocess.run(['bash','-c',script+'\necho USER_COMMAND'],env=self.env,capture_output=True,text=True,timeout=8)

    def test_wrapper_orders_cleanup_after_restore_before_command(self):
        script=runs.remote_script('w','.', ['python3','-m','unittest'],None,'r',wait_images=True,preserve_containers='')
        self.assertLess(script.index(runs.IMAGE_WAIT),script.index('OFFBOX_CONTAINERS'))
        self.assertLess(script.index('OFFBOX_CONTAINERS'),script.index(runs.COMMAND_STARTED_MARKER))
        p=subprocess.run(['bash','-n','-c',script],capture_output=True,text=True)
        self.assertEqual(p.returncode,0,p.stderr)

    def test_reports_and_removes_only_initial_ids(self):
        self.env['ADD_LATE']='1'; p=self.execute()
        self.assertEqual(p.returncode,0,p.stderr)
        self.assertIn('1 container(s) left from earlier runs: earlier (~0 threads)',p.stderr)
        self.assertIn('USER_COMMAND',p.stdout)
        self.assertEqual([c['name'] for c in json.loads(self.state.read_text())],['new-active'])
        rm=[json.loads(l) for l in self.calls.read_text().splitlines() if json.loads(l)[0]=='rm']
        self.assertEqual(rm,[['rm','-f','a'*64]])

    def test_preserved_boxes_only_report(self):
        for reason in ('offbox keep pin','saved base','private lease'):
            with self.subTest(reason=reason):
                p=self.execute(preserve=reason)
                self.assertEqual(p.returncode,0,p.stderr)
                self.assertIn('report only',p.stderr)
                self.assertEqual(len(json.loads(self.state.read_text())),1)
        self.assertNotIn('"rm"',self.calls.read_text())

    def test_preservation_uses_existing_metadata(self):
        row=dict(self.con.execute("SELECT * FROM leases WHERE box_id='bx'").fetchone())
        for changes,expected in (({},''),({'pinned_until':10**12},'offbox keep pin'),({'source':'base:repo:warm'},'saved base')):
            with self.subTest(changes=changes):
                self.assertEqual(containers.preserve_reason(self.con,dict(row,**changes)),expected)
        self.con.execute('DELETE FROM pool_members'); self.con.commit()
        self.assertEqual(containers.preserve_reason(self.con,row),'private lease')

    def test_listing_removal_failure_and_timeout_never_fail_command(self):
        for flag in ('PS_FAIL','RM_FAIL','RM_HANG'):
            with self.subTest(flag=flag):
                self.env[flag]='1'; p=self.execute(fast=True)
                self.assertEqual(p.returncode,0,p.stderr)
                self.assertIn('continuing',p.stderr)
                self.assertIn('USER_COMMAND',p.stdout)
                self.env.pop(flag)

    def test_post_records_leftovers_after_killed_wrapper_once(self):
        self.execute(preserve='saved base')
        self.state.write_text(json.dumps([item('a'),item('b','leaked'),item('c','future',created='2099-01-01')]))
        def ssh(box,command,timeout):
            return subprocess.run(['bash','-c',command],env=self.env,capture_output=True,timeout=timeout)
        with patch.object(containers.ssh_sync,'ssh',side_effect=ssh):
            containers.record(self.con,self.row,runs.BOUNDED_PROCESS,timeout=8)
            containers.record(self.con,self.row,runs.BOUNDED_PROCESS,timeout=8)
        rows=self.con.execute('SELECT kind,detail FROM events').fetchall()
        self.assertEqual([r['kind'] for r in rows],['stale_containers','stale_containers_left'])
        self.assertEqual(json.loads(rows[1]['detail'])['names'],['leaked'])
        self.assertNotIn('"rm"',self.calls.read_text())

    def test_ssh_timeout_is_nonfatal(self):
        with patch.object(containers.ssh_sync,'ssh',side_effect=subprocess.TimeoutExpired('ssh',1)):
            containers.record(self.con,self.row,runs.BOUNDED_PROCESS,timeout=1)
        self.assertFalse(self.con.execute('SELECT 1 FROM events').fetchone())

    def test_legacy_run_never_probes_a_box(self):
        self.con.execute('DELETE FROM kv'); self.con.commit()
        with patch.object(containers.ssh_sync,'ssh',side_effect=AssertionError('legacy SSH')):
            containers.record(self.con,self.row,runs.BOUNDED_PROCESS)

    def test_clickhouse_warning_covers_suite_command_forms(self):
        positive=(
            'python3 -m unittest -v terraform/tests/test_news_clickhouse.py',
            '/usr/bin/python3.12 -m unittest tests.test_news',
            'python -m pytest tests', 'pytest -q',
            'npm test', 'npm run test:python', 'npm --prefix subdir test',
            'pnpm test', 'npx pytest tests',
            'node scripts/run-static-test-shard.mjs --shard 4/4',
            'bash -lc "python3 -m unittest tests/test_news.py"',
            'env FOO=1 timeout 60s python3 terraform/tests/test_news.py',
        )
        for cmd in positive:
            for size in ('large','xlarge'):
                with self.subTest(cmd=cmd,size=size):
                    self.assertIn('max_threads=8',runs.clickhouse_suite_warning('crpko-devops',size,cmd))
        for cmd in ('npm ci','npm run build','python3 -c "print(1)"','go test ./...', 'true'):
            with self.subTest(cmd=cmd):
                self.assertIsNone(runs.clickhouse_suite_warning('crpko-devops','xlarge',cmd))
        self.assertIsNone(runs.clickhouse_suite_warning('other','xlarge','npm test'))
        self.assertIsNone(runs.clickhouse_suite_warning('crpko-devops','small','npm test'))


    def test_failed_post_inventory_is_retried_without_duplicate_initial_event(self):
        self.execute(preserve='saved base')
        self.state.write_text(json.dumps([item('a'),item('b','leaked')]))
        def ssh(box,command,timeout):
            return subprocess.run(['bash','-c',command],env=self.env,capture_output=True,timeout=timeout)
        with patch.object(containers.ssh_sync,'ssh',side_effect=ssh):
            self.env['PS_FAIL']='1'
            containers.record(self.con,self.row,runs.BOUNDED_PROCESS,timeout=8)
            self.assertFalse(self.con.execute("SELECT 1 FROM kv WHERE k='containers_recorded:r'").fetchone())
            self.env.pop('PS_FAIL')
            containers.record(self.con,self.row,runs.BOUNDED_PROCESS,timeout=8)
        self.assertEqual([r[0] for r in self.con.execute('SELECT kind FROM events')],
                         ['stale_containers','stale_containers_left'])

    def test_inactive_docker_baseline_reports_only_containers_created_during_run(self):
        self.env['SYSTEMCTL_RC']='3'; self.execute()
        receipt=self.home/'.offbox/exit/r.containers.json'
        data=json.loads(receipt.read_text())
        self.assertFalse(data['initial_known'])
        data['started']=1794528000; receipt.write_text(json.dumps(data))
        self.state.write_text(json.dumps([item('a','preexisting'),item('b','leaked',created='2026-11-13T01:00:00Z')]))
        self.con.execute("UPDATE runs SET end_at=? WHERE run_id='r'",(1794614400,)); self.con.commit()
        self.env.pop('SYSTEMCTL_RC')
        def ssh(box,command,timeout):
            return subprocess.run(['bash','-c',command],env=self.env,capture_output=True,timeout=timeout)
        with patch.object(containers.ssh_sync,'ssh',side_effect=ssh):
            containers.record(self.con,self.row,runs.BOUNDED_PROCESS,timeout=8)
        rows=self.con.execute('SELECT kind,detail FROM events').fetchall()
        self.assertEqual([r['kind'] for r in rows],['stale_containers_left'])
        self.assertEqual(json.loads(rows[0]['detail'])['names'],['leaked'])
        self.assertNotIn('"rm"',self.calls.read_text())

    def test_all_terminal_statuses_reach_recorder(self):
        for status in ('done','failed','killed','lost','interrupted','infra'):
            with self.subTest(status=status), patch.object(containers,'record') as record:
                runs.settle_docker(self.con,self.row,status)
                record.assert_called_once()

    def test_post_check_shares_existing_settlement_deadline(self):
        row=dict(self.row,docker=1)
        with patch.object(containers,'record'), patch.object(runs.time,'monotonic',side_effect=[10,17]), patch.object(
                runs,'containers_seen',return_value=True) as seen:
            runs.settle_docker(self.con,row,'failed',timeout=10)
            seen.assert_called_once_with('bx','r',timeout=3)

    def test_kill_finish_integration_records_leftovers(self):
        self.execute(preserve='saved base')
        self.con.execute("UPDATE runs SET status='running',end_at=NULL WHERE run_id='r'"); self.con.commit()
        self.state.write_text(json.dumps([item('a'),item('b','leaked')]))
        def ssh(box,command,timeout):
            return subprocess.run(['bash','-c',command],env=self.env,capture_output=True,timeout=timeout)
        with patch.object(containers.ssh_sync,'ssh',side_effect=ssh), patch.object(
                runs.lease,'touch'), patch.object(runs.lease,'idle_ttl'):
            runs.finish('r',143,'killed',catch_up=False)
        self.assertTrue(self.con.execute("SELECT 1 FROM events WHERE kind='stale_containers_left'").fetchone())

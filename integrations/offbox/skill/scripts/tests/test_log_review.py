"""Review regressions: execution time, every lost settlement, and resolved sizes."""
import contextlib
import io
import json
import os
from pathlib import Path
import sys
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import toollog
from offbox_lib import api, cli, common, lease, misc, pool, reap, runs, ssh_sync
from test_capacity import Isolated


class LoggingReview(Isolated):
    def setUp(self):
        super().setUp()
        self.logdir = Path(self.tmp.name)/'shared-logs'
        self.stack.enter_context(patch.dict(os.environ, OFFBOX_TOOL_LOG_DIR=str(self.logdir)))
        self.stack.enter_context(patch.object(api, '_COMMAND_DURATIONS', {}))
        self.stack.enter_context(contextlib.redirect_stdout(io.StringIO()))
        self.stack.enter_context(contextlib.redirect_stderr(io.StringIO()))
        self.stack.enter_context(patch('urllib.request.urlopen', side_effect=AssertionError('unexpected backend request')))

    def rows(self, name):
        return [json.loads(line) for p in self.logdir.glob('*.ndjson') for line in p.read_text().splitlines()
                if json.loads(line)['name']==name]

    def command_row(self, rid, mode='bg', pid=42):
        self.con.execute("INSERT INTO runs(run_id,box_id,status,mode,start_at,command_at,process_id,command_id,remote_dir,rel_cwd,local_cwd) "
                         "VALUES (?,'bx_fixture','running',?,0,5,?,?, 'work','.',?)",
                         (rid,mode,pid,'cmd_'+rid,self.tmp.name))
        self.con.commit()
        return dict(self.con.execute('SELECT * FROM runs WHERE run_id=?',(rid,)).fetchone())

    def test_execution_timestamps_exclude_queue_collection_and_pulls(self):
        row=self.command_row('run-delayed')
        status={'processId':42,'commandId':row['command_id'],'running':False,'status':'exited',
                'startedAt':'2026-11-13T10:05:00Z','endedAt':'2026-11-13T10:05:02Z','exitCode':0}
        with patch.object(api,'call',return_value=status) as request:
            self.assertIs(api.cmd_status('bx_fixture',42),status)
        request.assert_called_once()
        with patch.object(runs,'now',return_value=3600), patch.object(misc, '_catch_up_finished'):
            runs.finish(row['run_id'],0,bookkeeping=False)

        row=self.command_row('run-pulls','fg',43)
        frame={'type':'exit','exitCode':0,'commandId':row['command_id'],
               'startedAt':'2026-11-13T11:00:00+00:00','endedAt':'2026-11-13T11:00:05+00:00'}
        with patch.object(api,'stream',return_value=iter([frame])) as stream:
            self.assertEqual(list(api.cmd_attach('bx_fixture',43)),[frame])
        stream.assert_called_once()
        clock={'now':100}
        def pull(*a,**kw):
            clock['now']+=600
            return {'ok':True,'files':2,'received':10}
        with patch.object(runs,'now',side_effect=lambda:clock['now']), patch.object(ssh_sync,'pull',side_effect=pull):
            runs.do_pulls('bx_fixture',row,['artifact'])
            runs.finish(row['run_id'],0,bookkeeping=False)
        unknown=self.command_row('run-unknown','fg',44)
        with patch.object(runs,'now',return_value=7200): runs.finish(unknown['run_id'],0,bookkeeping=False)
        records=self.rows('run.command')
        self.assertEqual([r.get('durationMs') for r in records],[2000,5000,None])
        self.assertTrue(all(r['props']['exitCode']==0 for r in records))
        day=next(self.logdir.glob('*.ndjson')).stem
        self.assertEqual(toollog.rollup(day)['durationMs']['run.command'],{'p50':2000,'p95':5000,'max':5000})

    def test_execution_timestamp_and_wall_time_input_class(self):
        valid_start='2026-11-13T10:00:00Z'
        cases=[
            ({'startedAt':valid_start,'endedAt':'2026-11-13T10:00:02.125Z'},2125),
            ({'startedAt':'2026-11-13T14:00:00+04:00','endedAt':'2026-11-13T10:00:02Z'},2000),
            ({'startedAt':valid_start,'endedAt':valid_start},0),
            ({'metrics':{'wall_s':2.5}},2500),
            ({'metrics':{'wall_s':0}},0),
            ({'startedAt':valid_start,'endedAt':'bad','metrics':{'wall_s':3}},3000),
            ({'startedAt':valid_start,'endedAt':'2026-11-13T10:00:02Z','metrics':{'wall_s':99}},2000),
            ({},None), ({'startedAt':valid_start},None),
            ({'startedAt':'2026-11-13T10:00:00','endedAt':'2026-11-13T10:00:02'},None),
            ({'startedAt':valid_start,'endedAt':'2026-11-13T09:59:59Z'},None),
            ({'startedAt':123,'endedAt':456},None),
            ({'metrics':{'wall_s':-1}},None), ({'metrics':{'wall_s':float('nan')}},None),
            ({'metrics':{'wall_s':float('inf')}},None), ({'metrics':{'wall_s':1e308}},None), ({'metrics':{'wall_s':True}},None),
            ({'metrics':{'wall_s':'2'}},None), ({'metrics':[]},None),
            ({'running':True,'metrics':{'wall_s':2}},None),
            ({'status':'queued','metrics':{'wall_s':2}},None),
        ]
        for terminal in ({'status':'interrupted'}, {'status':'lost'}, {'status':'exited','signal':'SIGTERM'}):
            timestamps={'startedAt':valid_start,'endedAt':'2026-11-13T11:00:10Z',**terminal}
            cases.extend([(timestamps,None),({**timestamps,'metrics':{'wall_s':10}},10000)])
        for status,expected in cases:
            with self.subTest(status=status): self.assertEqual(api.execution_ms(status),expected)

    def test_history_timings_and_command_identity_do_not_cross_runs(self):
        response={'command':{'commandId':'cmd_fixture','metrics':{'wall_s':1.25},'status':'exited'}}
        with patch.object(api,'call',return_value=response): api.history_get('bx_fixture','cmd_fixture')
        self.assertEqual(api.command_execution_ms('bx_fixture',99,'cmd_fixture'),1250)
        self.assertIsNone(api.command_execution_ms('bx_other',99,'cmd_fixture'))
        api.remember_execution('bx_fixture',{'commandId':'old','processId':42,'metrics':{'wall_s':50}})
        self.assertIsNone(api.command_execution_ms('bx_fixture',42,'new'))
        self.assertIsNone(api.command_execution_ms('bx_fixture',42,None))
        with patch.object(api,'call',return_value={'processId':42,'commandId':'new'}): api.cmd_start('bx_fixture','true')
        self.assertIsNone(api.command_execution_ms('bx_fixture',42,'new'))
        api.remember_execution('bx_fixture',{'command':'private command text','commandId':'new','metrics':{'wall_s':2}},pid=42)
        self.assertEqual(api.command_execution_ms('bx_fixture',42,'new'),2000)
        with patch.object(api,'stream',return_value=iter([{'type':'attempt','attempt':2}])):
            list(api.cmd_attach('bx_fixture',42))
        self.assertIsNone(api.command_execution_ms('bx_fixture',42,'new'))
        api.remember_execution('bx_fixture',{'commandId':'new','metrics':{'wall_s':2}},pid=42)
        with patch.object(api,'call',return_value={'commandId':'new','status':'queued'}): api.cmd_status('bx_fixture',42)
        self.assertIsNone(api.command_execution_ms('bx_fixture',42,'new'))
        closed=[]
        def frames():
            try:
                yield {'type':'stdout','data':'fixture'}
                yield {'type':'exit','metrics':{'wall_s':10}}
            finally: closed.append(True)
        with patch.object(api,'stream',return_value=frames()):
            attached=api.cmd_attach('bx_fixture',42)
            next(attached)
            attached.close()
        self.assertEqual(closed,[True])
        self.assertIsNone(api.command_execution_ms('bx_fixture',42,'new'))

    def test_all_direct_lost_paths_emit_once_after_commit(self):
        cases=[('stale-local','local',7*3600),('aged-fg','fg',3*3600),('aged-bg','bg',3*3600),
               ('orphan-fg','fg',300),('orphan-bg','bg',300)]
        for label,mode,age in cases:
            for state in ('starting','running'):
                rid='run-'+label+'-'+state
                self.con.execute("INSERT INTO runs(run_id,mode,status,start_at,client_pid) VALUES (?,?,?,?,999999999)",
                                 (rid,mode,state,common.now()-age))
        self.con.commit()
        emitted=runs.emit_terminal
        def after_commit(row):
            # An independent reader sees the terminal state and claim before the NDJSON write.
            with contextlib.closing(common.db()) as reader:
                stored=reader.execute('SELECT status,logged_end_at FROM runs WHERE run_id=?',(row['run_id'],)).fetchone()
                self.assertEqual(stored['status'],'lost')
                self.assertIsNotNone(stored['logged_end_at'])
            emitted(row)
        with patch.object(api,'list_boxes',return_value=[]), patch.object(runs,'emit_terminal',side_effect=after_commit):
            reap.reap()
            reap.reap()
        records=self.rows('run.end')
        self.assertEqual(len(records),len(cases)*2)
        self.assertTrue(all(r['kind']=='error' and r['ok'] is False for r in records))
        self.assertEqual({r['ids']['run'] for r in records},{'run-'+label+'-'+state for label,_,_ in cases for state in ('starting','running')})
        self.assertEqual(len({r['ids']['run'] for r in self.rows('reaper.action')}),len(cases)*2)
        self.assertEqual(self.rows('run.command'),[])

    def test_reaper_dry_run_and_live_client_do_not_emit_terminal(self):
        self.con.execute("INSERT INTO runs(run_id,mode,status,start_at,client_pid) VALUES ('run-live','bg','starting',?,?)",(common.now()-300,os.getpid()))
        self.con.execute("INSERT INTO runs(run_id,mode,status,start_at) VALUES ('run-old','local','running',?)",(common.now()-7*3600,))
        self.con.commit()
        with patch.object(api,'list_boxes',return_value=[]): reap.reap(dry=True)
        self.assertEqual(self.rows('run.end'),[])
        self.assertEqual(self.con.execute("SELECT status FROM runs WHERE run_id='run-old'").fetchone()[0],'running')
        with patch.object(api,'list_boxes',return_value=[]), patch.object(misc,'_client_alive',return_value=True): reap.reap()
        self.assertEqual([r['ids']['run'] for r in self.rows('run.end')],['run-old'])

    def test_resolved_default_and_automatic_xlarge_sizes_are_logged(self):
        for cmd,size in [('echo ok','default'),('docker compose up','xlarge')]:
            args=cli.build_parser().parse_args(['run','--',cmd])
            args.cmd=[cmd]
            cli._log_request(args,self.me)
            selected=[]
            def allocated(me,size=None,*a,**kw):
                selected.append(size)
                return {'box_id':'bx_fixture','size':size or 'default','remote_dir':'work','_log_lease_kind':'fresh'}
            runner=runs.Runner(args,self.me)
            with patch.object(pool,'_acquire_logged',side_effect=allocated), patch.object(runs.Runner,'_prepare_box',return_value=None), \
                    patch.object(runs,'_ttl_keeper'), patch.object(lease,'idle_ttl'), patch.object(lease,'touch'), \
                    patch.object(lease,'oom_recent',return_value=None), patch.object(api,'cmd_start',return_value={'processId':42,'commandId':'cmd_size'}):
                runner.start()
            self.assertEqual(selected,[None if size=='default' else 'xlarge'])
            self.assertFalse(self.rows('run.request')[-1]['props']['sizeGiven'])
            self.assertEqual(self.rows('run.lease')[-1]['props']['size'],size)

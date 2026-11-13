import contextlib
import io
import json
import os
from pathlib import Path
from types import SimpleNamespace
import sys
import tempfile
import unittest
from unittest.mock import patch
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'skill/scripts'))
import rcsim


class SimEvents(unittest.TestCase):
    def test_create_heartbeat_release_success_and_failure(self):
        with tempfile.TemporaryDirectory() as temp, patch.dict(os.environ, {'TOOLLOG_ROOT':temp+'/logs'}), patch.object(rcsim, 'DB_PATH', Path(temp)/'rcsim.db'), patch.object(rcsim, 'STATE_DIR', Path(temp)), patch.object(rcsim, 'whoami',return_value={'thread':'thread-fixture','resolution':'resolved'}), patch.object(rcsim,'print_created'), contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
            a=SimpleNamespace(thread=None,manager=None,platform='ios',hard_timeout='45m',inactivity_timeout='20m',name='fixture',model=None,region=None,install=None,install_asset=None,purpose=None,json=True)
            with patch.object(rcsim,'rc',return_value=(0,{'id':'fixture-session','createdAt':'2026-11-13T00:00:00Z'},'','')):
                rcsim.cmd_create(a)
            b=SimpleNamespace(**{k:v for k,v in vars(a).items() if not k.startswith('_')})
            with patch.object(rcsim,'rc',return_value=(1,{'error':{'httpStatus':502,'code':'api_origin_unavailable','message':'secret'}},'','')):
                with self.assertRaises(SystemExit): rcsim.cmd_create(b)
            rcsim.cmd_heartbeat(SimpleNamespace(thread=None, ids=['fixture-session']))
            with self.assertRaises(SystemExit): rcsim.cmd_heartbeat(SimpleNamespace(thread=None,ids=['missing']))
            con=rcsim.db()
            row=rcsim.get_row(con,'fixture-session')
            with patch.object(rcsim,'rc',return_value=(124,None,'','timeout')):
                self.assertFalse(rcsim.release(con,row,'fixture')[0])
            with patch.object(rcsim,'rc',return_value=(0,{},'','')):
                self.assertTrue(rcsim.release(con,row,'fixture')[0])
            rows=[json.loads(line) for path in Path(temp+'/logs/agent-tools').glob('*.ndjson') for line in path.read_text().splitlines()]
            for name in ('sim.create','sim.heartbeat','sim.release'):
                self.assertEqual({r['ok'] for r in rows if r['name']==name}, {True,False})
            self.assertTrue(any(r.get('error',{}).get('tag')=='502.api_origin_unavailable' for r in rows))
            self.assertIn('billedMinutes',next(r for r in rows if r['name']=='sim.release')['props'])
            for row in rows: print('TOOLLOG_SAMPLE ' + json.dumps(row, separators=(',', ':')), file=sys.__stdout__)
            self.assertNotIn('secret',json.dumps(rows))

    def test_unregistered_release_start_failure_is_logged(self):
        sid='11111111-2222-3333-4444-555555555555'
        with tempfile.TemporaryDirectory() as temp, patch.dict(os.environ, {'TOOLLOG_ROOT':temp+'/logs'}), patch.object(rcsim, 'DB_PATH', Path(temp)/'rcsim.db'), patch.object(rcsim, 'STATE_DIR', Path(temp)), patch.object(rcsim, 'whoami', return_value={}), patch.object(rcsim, 'rc', side_effect=OSError('secret path')):
            with self.assertRaises(OSError):
                rcsim.cmd_release(SimpleNamespace(thread=None,mine=False,ids=[sid]))
            rows=[json.loads(line) for path in Path(temp+'/logs/agent-tools').glob('*.ndjson') for line in path.read_text().splitlines()]
            self.assertEqual(rows[0]['name'],'sim.release')
            self.assertFalse(rows[0]['ok'])
            self.assertEqual(rows[0]['error']['tag'],'sim.release.start_failed')
            self.assertEqual(rows[0]['ids']['sessionId'],sid)
            self.assertNotIn('secret path',json.dumps(rows))


class AutomaticSimEvents(unittest.TestCase):
    SID = '11111111-2222-3333-4444-555555555555'

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.stack = contextlib.ExitStack()
        self.addCleanup(self.stack.close)
        self.stack.enter_context(patch.dict(os.environ, {'TOOLLOG_ROOT': str(self.root/'logs')}))
        for name, value in [('STATE_DIR', self.root), ('DB_PATH', self.root/'rcsim.db'),
                            ('TOUCH_LOG', self.root/'touch'), ('LOCK_PATH', self.root/'lock')]:
            self.stack.enter_context(patch.object(rcsim, name, value))
        self.stack.enter_context(patch.object(rcsim, 'now', return_value=10000.0))
        self.con = rcsim.db()
        self.addCleanup(self.con.close)
        self.stack.enter_context(patch.object(rcsim, 'db', return_value=self.con))
        self.stack.enter_context(patch.object(rcsim, 'log'))
        self.stack.enter_context(patch.object(rcsim, 'rc', return_value=(0, [], '', '')))
        lock = self.stack.enter_context((self.root/'lock').open('w'))
        self.stack.enter_context(patch.object(rcsim, 'open', return_value=lock, create=True))
        self.telegram = self.stack.enter_context(patch.object(rcsim, 'telegram'))

    def register(self, state='active', expires_at=10600.0):
        self.con.execute('DELETE FROM sims')
        self.con.execute("INSERT INTO sims (id, platform, created_at, expires_at, last_hb, state) VALUES (?, 'ios', 9400, ?, 9500, ?)",
                         (self.SID, expires_at, state))
        self.con.commit()

    def rows(self):
        return [json.loads(line) for path in (self.root/'logs').rglob('*.ndjson')
                for line in path.read_text().splitlines()]

    def test_interaction_heartbeat_records_only_applied_touches(self):
        cases = [
            ('fresh', 'active', f'9700 {self.SID}\n', 9700, 1),
            ('coalesced', 'active', f'9600 {self.SID}\n9700 {self.SID}\n', 9700, 1),
            ('stale', 'active', f'9400 {self.SID}\n', 9500, 0),
            ('same', 'active', f'9500 {self.SID}\n', 9500, 0),
            ('released', 'released', f'9700 {self.SID}\n', 9500, 0),
            ('unregistered', 'active', '9700 22222222-2222-3333-4444-555555555555\n', 9500, 0),
            ('malformed', 'active', f'bad {self.SID}\n9700 invalid-id\n', 9500, 0),
        ]
        for label, state, source, last_hb, count in cases:
            with self.subTest(case=label):
                self.register(state)
                before = len(self.rows())
                rcsim.TOUCH_LOG.write_text(source)
                rcsim.fold_touches(self.con)
                row = rcsim.get_row(self.con, self.SID)
                self.assertEqual(row['last_hb'], last_hb)
                records = self.rows()[before:]
                self.assertEqual(len(records), count)
                if records:
                    self.assertEqual(records[0]['name'], 'sim.heartbeat')
                    self.assertTrue(records[0]['ok'])
                    self.assertEqual(records[0]['ids']['sessionId'], self.SID)
                    self.assertEqual(records[0]['props']['operation'], 'interaction')
                    self.assertEqual(records[0]['props']['billedMinutes'], 5)
                    self.assertGreater(records[0]['durationMs'], 0)

    def test_monitor_reconciles_gone_sessions_and_terminal_minutes(self):
        for label, expires, minutes in [('hard-timeout', 9880.0, 8), ('outside', 10600.0, 10)]:
            for dry in (False, True):
                with self.subTest(case=label, dry=dry):
                    self.register(expires_at=expires)
                    before = len(self.rows())
                    rcsim.monitor(dry=dry)
                    row = rcsim.get_row(self.con, self.SID)
                    records = self.rows()[before:]
                    self.assertEqual(row['state'], 'active' if dry else 'released')
                    self.assertEqual(len(records), 0 if dry else 1)
                    if not dry:
                        self.assertEqual(records[0]['name'], 'sim.release')
                        self.assertTrue(records[0]['ok'])
                        self.assertEqual(records[0]['ids']['sessionId'], self.SID)
                        self.assertEqual(records[0]['props']['operation'], label)
                        self.assertEqual(records[0]['props']['billedMinutes'], minutes)
                        self.assertGreater(records[0]['durationMs'], 0)
                        # A later scan must not count the terminal transition twice.
                        rcsim.monitor()
                        self.assertEqual(len(self.rows()), before + 1)
        self.telegram.assert_not_called()

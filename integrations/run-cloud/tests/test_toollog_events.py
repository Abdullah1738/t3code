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

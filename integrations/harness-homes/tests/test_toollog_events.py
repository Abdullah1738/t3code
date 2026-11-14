import contextlib
import io
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import generate_homes as gh
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'shared'))
import check as mcp_check


class HomeLogEvents(unittest.TestCase):
    def test_request_props_survive_canonical_allowlist(self):
        with tempfile.TemporaryDirectory() as temp, patch.dict(os.environ, {'TOOLLOG_ROOT': temp+'/logs'}):
            props = {'method': 'http:DELETE', 'httpMethod': 'DELETE', 'ttfbMs': 2.5,
                     'reason': '{"error":"bad request"}', 'arguments': 'DO_NOT_LOG',
                     'unknown': 'DO_NOT_LOG'}
            gh.toollog.emit('shared-mcp', 'perf', 'mcp.request', props=props)
            row, = self.rows(temp)
            self.assertEqual(row['props'], {k: v for k, v in props.items() if k not in {'arguments', 'unknown'}})
            self.assertNotIn('DO_NOT_LOG', json.dumps(row))

    def test_generate_success_and_plan_failure(self):
        with tempfile.TemporaryDirectory() as temp, patch.dict(os.environ, {'TOOLLOG_ROOT':temp+'/logs'}):
            with patch.object(gh, 'plan_all', return_value=({'skillRoots':[]}, {}, [], [], {})), patch.object(gh, 'warn_mcp_parity'), contextlib.redirect_stdout(io.StringIO()):
                self.assertEqual(gh.generate(temp, True), 0)
            with patch.object(gh, 'plan_all', side_effect=gh.HomeError('fixture secret')):
                with self.assertRaises(gh.HomeError):
                    gh.generate(temp, True)
            rows = self.rows(temp)
            runs = [r for r in rows if r['name'] == 'generate.run']
            self.assertEqual([r['ok'] for r in runs], [True, False])
            self.assertNotIn('fixture secret', json.dumps(rows))

    def rows(self, temp):
        rows = [json.loads(line) for path in Path(temp+'/logs/agent-tools').glob('*.ndjson') for line in path.read_text().splitlines()]
        for row in rows: print('TOOLLOG_SAMPLE ' + json.dumps(row, separators=(',', ':')), file=sys.__stdout__)
        return rows

    def test_mcp_diff_and_shared_probe_failure(self):
        with tempfile.TemporaryDirectory() as temp, patch.dict(os.environ, {'TOOLLOG_ROOT':temp+'/logs'}), patch.object(gh, 'load_manifest', return_value={}), patch.object(gh, 'validate_manifest'), contextlib.redirect_stdout(io.StringIO()):
            for fail in (False, True):
                rows = [{'id':'fixture-server', 'status':'mismatch' if fail else 'ok'}]
                with patch.object(gh, 'mcp_parity', return_value=('fixture',rows,['drift'] if fail else [])):
                    self.assertEqual(gh.mcp_diff(json_output=True,opencode_config=None), int(fail))
            # Probe decorator exercises success, startup failure and timeout without a service.
            for exc in (None, RuntimeError('secret'), TimeoutError('secret')):
                def probe(url, name):
                    if exc: raise exc
                    return ['fixture_tool']
                try: mcp_check.logged_probe(probe)('http://fixture', 'fixture-server')
                except (RuntimeError, TimeoutError): pass
            events = self.rows(temp)
            self.assertEqual([r['ok'] for r in events if r['name']=='mcp_diff.run'], [True,False])
            self.assertEqual(len([r for r in events if r['name']=='mcp.probe']),3)
            self.assertEqual({r['ids']['home'] for r in events if r['name']=='mcp.probe'},{'shared'})

    def test_skill_duplicates_and_backups(self):
        with tempfile.TemporaryDirectory() as temp, patch.dict(os.environ, {'TOOLLOG_ROOT':temp+'/logs'}):
            for directory in ('alpha','alpha.bak-123'):
                path=Path(temp)/'skills'/directory
                path.mkdir(parents=True)
                (path/'SKILL.md').write_text('---\nname: alpha\n---\n')
            gh.discover_skills([temp+'/skills/alpha'])
            with self.assertRaises(gh.HomeError): gh.discover_skills([temp+'/skills'])
            self.assertEqual({r['name'] for r in self.rows(temp)}, {'skill.scan','skill.backup','skill.duplicate'})

    def test_check_success_and_drift(self):
        with tempfile.TemporaryDirectory() as temp, patch.dict(os.environ, {'TOOLLOG_ROOT':temp+'/logs'}), contextlib.redirect_stdout(io.StringIO()) as output:
            homes = {h: temp+'/'+h for h in gh.HARNESSES}
            with patch.object(gh, 'plan_all', return_value=({}, homes, [], [], {})):
                self.assertEqual(gh.check(temp), 0)
            with patch.object(gh, 'plan_all', return_value=({}, homes, [], [], {temp+'/claude/missing.txt': b'fixture'})):
                self.assertEqual(gh.check(temp), 1)
            rows = self.rows(temp)
            self.assertEqual([r['ok'] for r in rows if r['name']=='generate.check'], [True, False])
        for line in output.getvalue().splitlines():
            if line.startswith('TOOLLOG_SAMPLE'): print(line)

    def test_unreadable_skills_are_errors_even_at_cap(self):
        with tempfile.TemporaryDirectory() as temp, patch.dict(os.environ, {'TOOLLOG_ROOT': temp+'/logs'}):
            root = Path(temp)/'skills'
            root.mkdir()
            gh.toollog.emit('fixture', 'event', 'fixture.start')
            with patch.object(gh.os, 'scandir', side_effect=PermissionError('secret')), patch.object(gh.toollog, 'CAP_BYTES', 1):
                _, unreadable = gh.discover_skills([str(root)])
            self.assertTrue(unreadable)
            rows = self.rows(temp)
            row = next(r for r in rows if r['name']=='skill.scan')
            self.assertEqual(row['kind'], 'error')
            self.assertEqual(row['error']['tag'], 'skill.unreadable')

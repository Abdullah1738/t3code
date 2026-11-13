import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

SRC = Path(__file__).resolve().parents[1] / 'src'
sys.path.insert(0, str(SRC))
import quint_verify_guard as guard
import engine
import claude
import codex

CASES = json.loads(Path(__file__).with_name('quint_verify_cases.json').read_text())


class QuintVerifyTests(unittest.TestCase):
    def setUp(self):
        fixture = tempfile.TemporaryDirectory(prefix='quint-path-fixture-')
        self.addCleanup(fixture.cleanup)
        self.root = Path(fixture.name)
        (self.root / 'hook').mkdir()
        for directory in ['project', 'project/node_modules/.bin', 'project/sub', 'project/sub/node_modules/.bin']:
            executable = self.root / directory / 'quint'
            executable.parent.mkdir(parents=True, exist_ok=True)
            executable.write_text('#!/bin/sh\nexit 0\n')
            executable.chmod(0o755)
        self.cases = [{key: value.replace('{{fixture}}', str(self.root)) if isinstance(value, str) else value
                       for key, value in row.items()} for row in CASES]

    def test_matcher_table(self):
        for row in self.cases:
            with self.subTest(command=row['command']):
                self.assertEqual(guard.classify(row['command'], row.get('cwd', '/repo'), approved=row.get('approved', '')), row['denied'])

    def test_explicit_path_resolution_and_unknown_shell_path(self):
        with tempfile.TemporaryDirectory() as root:
            raw = Path(root) / 'quint'
            raw.write_text('#!/bin/sh\nexit 0\n')
            raw.chmod(0o755)
            self.assertTrue(guard.classify('quint verify', path=root, approved=''))
            self.assertTrue(guard.classify(f'PATH={root} quint verify', approved=''))
            self.assertFalse(guard.classify('quint verify', path=None, approved=''))
            with patch.object(guard.shutil, 'which', return_value='/Users/ardud/.local/share/quint-guard/bin/quint'):
                self.assertFalse(guard.classify('quint verify', path=root, approved=''))

    def test_native_adapters_and_code_mode_shells(self):
        with patch.object(engine, '_log'), patch.object(engine, 'resolve_identity', return_value={}), patch.object(engine, '_classify_offbox', return_value=None):
            for harness, adapter, tool, field in [
                ('claude', claude, 'Bash', 'command'), ('codex', codex, 'exec_command', 'cmd'),
                ('codex', codex, 'mcp__shell__exec_command', 'cmd'),
                ('claude', claude, 'mcp__shell__exec_command', 'cmd'),
            ]:
                for row in self.cases:
                    event = {'hook_event_name': 'PreToolUse', 'tool_name': tool, 'cwd': str(self.root / 'hook'),
                             'tool_input': {field: row['command'], 'workdir': row.get('cwd', '/repo')}}
                    with self.subTest(harness=harness, tool=tool, command=row['command']), patch.dict(os.environ, {guard.OVERRIDE: row.get('approved', '')}):
                        result = engine.decide(event, harness)
                        self.assertEqual(result['context'].get('rule') == 'quint-verify', row['denied'])
                        if row['denied']:
                            output = adapter.response(event, result)['hookSpecificOutput']
                            self.assertEqual(output['permissionDecision'], 'deny')
                            self.assertEqual(output['permissionDecisionReason'], guard.REASON)

    def test_inherited_override_and_no_script_reads(self):
        with patch.dict(os.environ, {guard.OVERRIDE: '1'}):
            self.assertFalse(guard.classify('npx quint verify'))
            self.assertTrue(guard.classify('env -u ' + guard.OVERRIDE + ' npx quint verify'))
        with patch('builtins.open', side_effect=AssertionError('opened a named file')):
            self.assertTrue(guard.classify('node /repo/@informalsystems/quint/dist/src/cli.js verify', approved=''))

    def test_claude_session_path(self):
        with tempfile.TemporaryDirectory() as root:
            env_file = Path(root) / 'env'
            with patch.dict(os.environ, {'CLAUDE_ENV_FILE': str(env_file)}):
                claude.session_start()
            line = env_file.read_text().splitlines()[0]
            self.assertLess(line.index('scripts/blockers'), line.index('coord-blockers'))
            self.assertLess(line.index('coord-blockers'), line.index('quint-guard/bin'))
            self.assertLess(line.index('quint-guard/bin'), line.index('$PATH'))


if __name__ == '__main__':
    unittest.main()

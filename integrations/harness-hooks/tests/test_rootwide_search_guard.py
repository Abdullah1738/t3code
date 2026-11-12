import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

SRC = Path(__file__).resolve().parents[1] / 'src'
sys.path.insert(0, str(SRC))
import rootwide_search_guard as guard
import engine
import claude
import codex

CORPUS = Path(__file__).with_name('rootwide_search_cases.json')


class RootwideSearchTests(unittest.TestCase):
    def test_operand_corpus(self):
        for case in json.loads(CORPUS.read_text()):
            with self.subTest(case=case):
                self.assertEqual(guard.classify(case['command'], case['cwd'], approved=case.get('approved', ''), home='/Users/ardud'), case['root'])

    def test_native_adapters_and_code_mode_shell_calls(self):
        cases = json.loads(CORPUS.read_text())
        with tempfile.TemporaryDirectory() as state, patch.dict(os.environ, {'HARNESS_HOOKS_STATE_DIR': state, 'AGENT_GUARD_APPROVED': ''}), patch.object(engine, 'resolve_identity', return_value={}), patch.object(engine, '_classify_offbox', return_value=None):
            for harness, adapter, tool, field in [('codex', codex, 'exec_command', 'cmd'), ('claude', claude, 'Bash', 'command'), ('codex', codex, 'mcp__shell__exec_command', 'cmd')]:
                for case in cases:
                    # The shared parser corpus covers synthetic HOME and env too;
                    # these adapter probes exercise commands with the real cwd.
                    if '~' in case['command'] or '$HOME' in case['command'] or '${HOME}' in case['command'] or case.get('approved'):
                        continue
                    event = {'hook_event_name': 'PreToolUse', 'cwd': '/tmp', 'tool_name': tool,
                             'tool_input': {field: case['command'], 'workdir': case['cwd']}}
                    result = engine.decide(event, harness)
                    with self.subTest(harness=harness, case=case):
                        self.assertEqual(result['context'].get('rule') == 'rootwide-search', bool(case['root']))
                        if case['root']:
                            response = adapter.response(event, result)['hookSpecificOutput']
                            self.assertEqual(response['permissionDecision'], 'deny')
                            self.assertIn('Refused: recursive search over ' + case['root'], response['permissionDecisionReason'])

    def test_guard_needs_no_identity_or_services(self):
        with patch.object(engine, '_log'), patch.object(engine, 'resolve_identity', side_effect=AssertionError('service called')):
            event = {'hook_event_name': 'PreToolUse', 'session_id': 'unavailable', 'tool_name': 'exec_command',
                     'tool_input': {'cmd': 'rg foo /Users/ardud/checkouts', 'workdir': '/tmp'}}
            self.assertEqual(engine.decide(event, 'codex')['context']['rule'], 'rootwide-search')

    def test_parser_failure_does_not_disable_the_database_guard(self):
        with patch.object(engine, '_log'), patch.object(guard, 'classify', side_effect=RuntimeError('parser failed')), patch.object(engine.statev2_guard, 'classify_detail', return_value=('live-database-read', None)):
            event = {'hook_event_name': 'PreToolUse', 'tool_name': 'exec_command',
                     'tool_input': {'cmd': 'echo fixture', 'workdir': '/tmp'}}
            self.assertEqual(engine.decide(event, 'codex')['context']['rule'], 'live-database-read')

    def test_inherited_override(self):
        with patch.dict(os.environ, {'AGENT_GUARD_APPROVED': 'owner-approved'}):
            self.assertIsNone(guard.classify('rg --files /Users/ardud/checkouts', '/tmp'))
            self.assertEqual(guard.classify('env -u AGENT_GUARD_APPROVED rg --files /Users/ardud/checkouts', '/tmp'), '/Users/ardud/checkouts')

    def test_manifest_registers_all_native_shell_entry_points_and_parity(self):
        manifest = json.loads((SRC.parents[1] / 'harness-homes/manifest.json').read_text())
        for harness in ['claude', 'codex']:
            matchers = [h['matcher'] for h in manifest['hooks'] if h['harness'] == harness and h['event'] == 'PreToolUse']
            self.assertTrue(any('exec_command' in m and 'shell_command' in m for m in matchers))
        self.assertIn('../harness-hooks/src/rootwide_search_guard.py', manifest['paritySources']['rootwide-search'])


if __name__ == '__main__':
    unittest.main()

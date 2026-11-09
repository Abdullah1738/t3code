"""Native hook stdin/output boundary, with isolated audit state."""
import contextlib
import importlib
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

SRC = Path(__file__).resolve().parents[1] / 'src'
sys.path.insert(0, str(SRC))
import engine

PAN = '4111111111111111'


class CardMaskHookTests(unittest.TestCase):
    def call(self, harness, tool, value, *flags):
        event = {'hook_event_name': 'PostToolUse', 'tool_name': tool, 'tool_response': value}
        with tempfile.TemporaryDirectory() as directory:
            result = subprocess.run([sys.executable, str(SRC / (harness + '.py')), *flags],
                                    input=json.dumps(event), text=True, capture_output=True,
                                    env={**os.environ, 'HARNESS_HOOKS_STATE_DIR': directory}, timeout=5)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(result.stderr, '')
            path = Path(directory) / 'decisions.jsonl'
            logs = path.read_text() if path.exists() else ''
            self.assertNotIn(PAN, logs)
            return json.loads(result.stdout) if result.stdout else None, logs

    def test_claude_main_preserves_bash_shape(self):
        result, logs = self.call('claude', 'Bash', {'stdout': PAN + ' CVV: 123 expiry: 12/25', 'stderr': '', 'interrupted': False})
        self.assertEqual(result, {'hookSpecificOutput': {'hookEventName': 'PostToolUse',
                         'updatedToolOutput': {'stdout': '•••• 1111 CVV: ••• expiry: ••/••', 'stderr': '', 'interrupted': False}}})
        self.assertEqual(sum(json.loads(line)['rule'] == 'card-mask' for line in logs.splitlines()), 1)
        self.assertIsNone(self.call('claude', 'Bash', {'stdout': 'done', 'stderr': '', 'interrupted': False})[0])

    def test_codex_main_mcp_only(self):
        value = {'content': [{'type': 'text', 'text': PAN}], 'isError': False}
        result, _ = self.call('codex', 'mcp__dia__dia_evaluate', value)
        self.assertEqual(result, {'hookSpecificOutput': {'hookEventName': 'PostToolUse',
                         'updatedMCPToolOutput': {'content': [{'type': 'text', 'text': '•••• 1111'}], 'isError': False}}})
        self.assertIsNone(self.call('codex', 'mcp__dia__dia_evaluate', {'content': []})[0])
        for tool in ['exec_command', 'apply_patch', 'shell']:
            result, logs = self.call('codex', tool, PAN)
            self.assertIsNone(result)
            self.assertNotIn('card-mask', logs)

    def test_masker_failure_keeps_result_and_emits_nothing(self):
        for harness in ['claude', 'codex']:
            adapter = importlib.import_module(harness)
            event = {'hook_event_name': 'PostToolUse', 'tool_name': 'mcp__test__call', 'tool_response': PAN}
            with tempfile.TemporaryDirectory() as directory, patch.dict(os.environ, HARNESS_HOOKS_STATE_DIR=directory), \
                    patch.object(engine.card_mask, 'mask_value', side_effect=RuntimeError('private text')), \
                    patch.object(sys, 'stdin', io.StringIO(json.dumps(event))), patch.object(sys, 'argv', [harness]), \
                    contextlib.redirect_stdout(io.StringIO()) as out:
                adapter.main()
                self.assertEqual(out.getvalue(), '')
                log = (Path(directory) / 'decisions.jsonl').read_text()
                self.assertIn('card-mask', log)
                self.assertNotIn('private text', log)
                self.assertNotIn(PAN, log)

    def test_desktop_overlapping_registration_finishes_once(self):
        for harness in ['claude', 'codex']:
            adapter = importlib.import_module(harness)
            event = {'hook_event_name': 'PostToolUse', 'tool_name': 'mcp__cua_driver__click', 'tool_response': PAN}
            with tempfile.TemporaryDirectory() as directory, patch.dict(os.environ, HARNESS_HOOKS_STATE_DIR=directory), \
                    patch.object(engine.desktop_lease, 'finish', return_value=('desktop-end', None)) as finish:
                for flags in [[], ['--card-mask']]:
                    with patch.object(sys, 'stdin', io.StringIO(json.dumps(event))), patch.object(sys, 'argv', [harness, *flags]), \
                            contextlib.redirect_stdout(io.StringIO()) as out:
                        adapter.main()
                        self.assertEqual(bool(out.getvalue()), not flags)
                finish.assert_called_once()


if __name__ == '__main__':
    unittest.main()

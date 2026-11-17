if __package__:
    from . import test_environment
else:
    import test_environment

import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'src'))
import shared_deps_guard as guard
import engine
import claude
import codex

CASES = json.loads(Path(__file__).with_name('shared_deps_cases.json').read_text())


class SharedDepsTests(unittest.TestCase):
    def test_shapes_commands_and_native_admission(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary) / 'work tree'
            store = Path(temporary) / 'main/node_modules'
            store.mkdir(parents=True)
            (store / '.pnpm').mkdir()
            (store / '.bin').mkdir()
            root.mkdir()
            (root / '.git').mkdir()
            for shape in ['node_modules', '.pnpm', '.bin']:
                if shape == 'node_modules':
                    link = root / shape
                else:
                    (root / 'node_modules').mkdir()
                    link = root / 'node_modules' / shape
                link.symlink_to(store if shape == 'node_modules' else store / shape)
                for row in CASES:
                    command = row["command"]
                    with self.subTest(shape=shape, command=command):
                        reason = guard.classify(command, str(root))
                        self.assertEqual(bool(reason), row['denied'])
                        if reason:
                            self.assertIn('shared dependencies', reason)
                        for harness, adapter, tool, field in [('claude', claude, 'Bash', 'command'), ('codex', codex, 'exec_command', 'cmd')]:
                            event = {'hook_event_name': 'PreToolUse', 'tool_name': tool, 'cwd': str(root), 'tool_input': {field: command}}
                            with patch.object(engine, '_log'):
                                result = engine.decide(event, harness)
                            self.assertEqual(result['context']['rule'] == 'shared-dependencies', row['denied'])
                            if row['denied']:
                                self.assertEqual(adapter.response(event, result)['hookSpecificOutput']['permissionDecision'], 'deny')
                for command in ['vp fmt a.ts', 'vp lint a.ts', 'pnpm --version', 'echo pnpm install', 'offbox run -- pnpm install', 'env -C /tmp corepack pnpm install', 'env --chdir=/tmp corepack pnpm install', 'command -v pnpm', 'command -V corepack', 'node -e "console.log(1)"', "vp run migrate-dev-db --source '$HOME/copy.sqlite'", "vp run migrate-dev-db --source '${HOME}/copy.sqlite'", "vp run migrate-dev-db --source '~/copy.sqlite'"]:
                    self.assertIsNone(guard.classify(command, str(root)), command)
                self.assertTrue(guard.classify('cd "' + str(root) + '" && corepack pnpm@11.10.0 i', temporary))
                self.assertTrue(guard.classify('pnpm --dir "' + str(root) + '" install', temporary))
                link.unlink()
                if shape != 'node_modules':
                    (root / 'node_modules').rmdir()
            self.assertIsNone(guard.classify('pnpm install', str(root)))

    def test_classifier_failure_preserves_independent_guards(self):
        with patch.object(engine.shared_deps_guard, 'classify', side_effect=ValueError('parser')):
            with patch.object(engine.snapshot_guard, 'exact_invocation', return_value=False):
                with patch.object(engine.statev2_guard, 'classify_detail', return_value=('live-database-read', None)):
                    with patch.object(engine, '_log'):
                        for harness, tool, field in [('claude', 'Bash', 'command'), ('codex', 'exec_command', 'cmd')]:
                            event = {'hook_event_name': 'PreToolUse', 'tool_name': tool, 'cwd': '/repo', 'tool_input': {field: 'echo safe'}}
                            result = engine.decide(event, harness)
                            self.assertEqual(result['decision'], 'deny')
                            self.assertEqual(result['context']['rule'], 'live-database-read')


if __name__ == '__main__':
    unittest.main()

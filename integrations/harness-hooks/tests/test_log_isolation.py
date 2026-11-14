if __package__:
    from . import test_environment
else:
    import test_environment

import ast
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import subprocess
import sys
import unittest


class LogIsolationTests(unittest.TestCase):
    def test_all_test_modules_load_isolation_before_hooks(self):
        for path in Path(__file__).parent.glob('test_*.py'):
            if path.name == 'test_environment.py':
                continue
            with self.subTest(module=path.name):
                statements = ast.parse(path.read_text()).body
                if isinstance(statements[0], ast.Expr):
                    statements = statements[1:]
                self.assertIsInstance(statements[0], ast.If)
                self.assertEqual(ast.unparse(statements[0].test), '__package__')
                self.assertEqual(statements[0].body[0].names[0].name, 'test_environment')
                self.assertEqual(statements[0].orelse[0].names[0].name, 'test_environment')

    def test_isolated_child_writes_both_logs_with_real_home(self):
        root = test_environment.LOG_ROOT.resolve()
        real = Path.home() / '.robob/logs/tools'
        self.assertFalse(root.is_relative_to(real.resolve()))
        self.assertEqual(Path(os.environ['TOOLLOG_ROOT']).resolve(), root)
        self.assertEqual(Path(os.environ['OFFBOX_TOOL_LOG_DIR']).resolve(), root / 'offbox')
        src = Path(__file__).resolve().parents[1] / 'src'
        child = subprocess.run([sys.executable, '-I', '-c',
            "import json,sys; sys.path.insert(0,sys.argv[1]); import toollog,offbox_toollog; "
            "print(json.dumps(str(toollog.board_dir('agent-tools')))); "
            "toollog.hook('codex','shell','denied','isolation-canary',0); "
            "offbox_toollog.emit('gate','gate.decision',kind='error',tag='isolation_canary')",
            str(src)], capture_output=True, text=True, check=True)
        self.assertEqual(Path(json.loads(child.stdout)).resolve(), root / 'agent-tools')
        day = datetime.now(timezone.utc).strftime('%Y-%m-%d') + '.ndjson'
        for board in ('agent-tools', 'offbox'):
            rows = [json.loads(line) for line in (root / board / day).read_text().splitlines()]
            self.assertTrue(any('isolation' in json.dumps(row) for row in rows), board)


if __name__ == '__main__':
    unittest.main()

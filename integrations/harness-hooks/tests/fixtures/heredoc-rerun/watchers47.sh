# cwd: /Volumes/ExternalSSD/t3code-wt/watchers-fastpath-telegram-helper-cause
# refused 2026-11-13T20:27Z (Codex exec_command), Watchers #47 thread a03d1570
cat > tmp/watchers47-offbox.EWpc2z/offline_suite.py <<'PY'
"""Linux-only test prerequisites; never a runtime install or a live credential call."""
import os
from pathlib import Path
import sys
import types
import unittest

repo = Path(__file__).resolve().parents[2]
helpers = repo / 'integrations/robob-watch/helpers'
# The isolated scratch subprocess has no installed fallback helpers on a Linux box.
os.environ['PYTHONPATH'] = str(helpers)
os.environ['ROBOB_TEST'] = '1'
# App request-callers import a native macOS Keychain binding before their mocks run.
# Supply an import-only boundary that fails if a test actually tries to use it.
keychain = types.ModuleType('keychain')
def denied(*args, **kwargs):
    raise AssertionError('UNMOCKED_KEYCHAIN_BOUNDARY')
keychain.load = keychain.store = denied
sys.modules['keychain'] = keychain
suite = unittest.defaultTestLoader.discover(str(repo / 'integrations/robob-watch/checks/inbox-triage'), pattern='test_*.py')
result = unittest.TextTestRunner(verbosity=1).run(suite)
sys.exit(not result.wasSuccessful())
PY
unset BUN_INSPECT
offbox run --bg --include tmp/watchers47-offbox.EWpc2z -- python3 -I tmp/watchers47-offbox.EWpc2z/offline_suite.py

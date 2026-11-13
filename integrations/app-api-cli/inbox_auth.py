"""Record exact SMS sender expectations before authorized requests reach the wire."""
import importlib.util
import json
import os
from pathlib import Path
import sys

_LIVE_DATA = Path.home() / 'Documents/assistant/inbox-triage'
_LIVE_WATCHERS = Path.home() / '.local/share/robob-watch/watchers'
DATA = _LIVE_DATA
WATCHERS = _LIVE_WATCHERS
SOURCE = Path(__file__).resolve().parent.parent / 'robob-watch/checks/inbox-triage/expected_auth.py'


def expect(senders):
    testing = (os.environ.get('ROBOB_TEST') or os.environ.get('NODE_ENV') == 'test'
               or os.environ.get('PYTEST_CURRENT_TEST') or 'unittest' in sys.modules)
    # Mocked requests must never suppress real alerts. Integration tests opt in
    # by redirecting both config and evidence outside the live directories.
    if testing and (DATA.resolve().is_relative_to(_LIVE_DATA.resolve())
                    or WATCHERS.resolve().is_relative_to(_LIVE_WATCHERS.resolve())):
        return
    definition = WATCHERS / 'inbox-triage-fastpath/watcher.json'
    if not definition.exists() or json.loads(definition.read_text()).get('paused'):
        return
    path = SOURCE if SOURCE.exists() else WATCHERS / 'inbox-triage/expected_auth.py'
    if not path.is_file():
        raise RuntimeError('INBOX_AUTH_REGISTRY_UNAVAILABLE')
    spec = importlib.util.spec_from_file_location('requested_inbox_auth', path)
    registry = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(registry)
    registry.record(senders, data=DATA)


def expect_payment(last4):
    senders = {'2342': ('EmiratesNBD', 'Emirates NBD', 'Emirates-NBD'),
               '9546': ('Mashreq',)}.get(last4)
    if senders:
        expect(senders)

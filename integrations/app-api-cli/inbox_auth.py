"""Record exact SMS sender expectations before authorized requests reach the wire."""
import importlib.util
import json
from pathlib import Path

DATA = Path.home() / 'Documents/assistant/inbox-triage'
WATCHERS = Path.home() / '.local/share/robob-watch/watchers'
SOURCE = Path(__file__).resolve().parent.parent / 'robob-watch/checks/inbox-triage/expected_auth.py'


def expect(senders):
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

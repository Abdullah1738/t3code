"""order-watch add receipts for commerce lanes.

`order-watch add` prints one JSON receipt line last. Exit 3 means the watcher
is registered but Moni's placement text failed; the order itself succeeded, so
lanes report the failure in their output instead of failing a paid flow.
moni_notice_held means payment was unconfirmed and her text waits for
recover-payment; the caller must reconcile and release or tell her.
"""
import json

RECIPIENTS = ('owner', 'moni')
NOTICE_FAILED_EXIT = 3


def command_args(recipient, total_minor=None):
    if recipient not in RECIPIENTS:
        raise ValueError('ORDER_RECIPIENT_INVALID')
    args = ['--for', recipient]
    if type(total_minor) is int and total_minor > 0:
        args += ['--total', f'AED {total_minor / 100:.2f}']
    return args


def reserved_minor(journal, flow_id):
    """Paid total from the journal, or None; a lookup never blocks registration."""
    try:
        value = journal.inspect(flow_id).get('reserved_minor')
    except Exception:
        return None
    return value if type(value) is int else None


def parse(stdout, returncode, recipient, tracker_id):
    """(registration_exit_ok, receipt fields for the lane's final output)."""
    if isinstance(stdout, bytes):
        stdout = stdout.decode('utf-8', 'replace')
    row = {}
    for line in reversed((stdout or '').splitlines()):
        try:
            candidate = json.loads(line)
        except ValueError:
            continue
        if isinstance(candidate, dict) and 'moni_notified' in candidate:
            row = candidate
            break
    notified = row.get('moni_notified')
    if type(notified) is not str:
        notified = 'failed:receipt_missing' if recipient == 'moni' else 'skipped'
    exit_ok = returncode == 0 or (returncode == NOTICE_FAILED_EXIT and recipient == 'moni')
    return exit_ok, {'for': recipient, 'tracker_id': tracker_id, 'watcher_registered': True,
                     'moni_notified': notified, 'moni_notice_failed': notified.startswith('failed'),
                     'moni_notice_held': notified.startswith('held')}


def fields(registration):
    """Receipt fields copied into a lane's final success output."""
    registration = registration if isinstance(registration, dict) else {}
    return {key: registration.get(key) for key in
            ('for', 'tracker_id', 'watcher_registered', 'moni_notified', 'moni_notice_failed',
             'moni_notice_held')}

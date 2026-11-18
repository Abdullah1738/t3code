"""Explicit spending consent for tests of the existing journal mechanics.

The gate tests use an empty ledger instead. This fixture records only the exact
synthetic scopes opened by the test and never reads or writes the owner's ledger.
"""
import datetime as dt
from pathlib import Path
import tempfile
import os
from unittest.mock import patch

import commerce_journal as journal
import owner_go


def isolated_owner_ledger(test):
    temp = tempfile.TemporaryDirectory()
    test.addCleanup(temp.cleanup)
    root = Path(temp.name)
    logs = patch.dict(os.environ, {'ROBOB_TOOL_LOG_DIR': str(root / 'logs'),
                                  'TOOLLOG_ROOT': str(root / 'logs')})
    logs.start(); test.addCleanup(logs.stop)
    return owner_go.Ledger(root / 'ledger')


def approve_test_flows(test):
    if getattr(test, '_owner_go_fixture', False):
        return
    test._owner_go_fixture = True
    temp = tempfile.TemporaryDirectory()
    test.addCleanup(temp.cleanup)
    ledger = owner_go.Ledger(Path(temp.name) / 'owner-go')
    import card_status
    card = patch.dict(os.environ, {'CARD_STATUS_FILE':str(Path(temp.name) / 'cards.json')})
    card.start(); test.addCleanup(card.stop)
    card_status.record_declined('9546', reason='synthetic-test-decline', source='unit-test')
    import commerce_receipts
    for module in (journal, commerce_receipts):
        root = patch.object(module, 'ROOT', Path(temp.name) / 'commerce')
        root.start(); test.addCleanup(root.stop)
    factory = patch.object(owner_go, 'Ledger', return_value=ledger)
    factory.start(); test.addCleanup(factory.stop)
    original = journal.open_flow

    def opened(**args):
        result = original(**args)
        ledger.record(vendor=args['app'], item=owner_go.commerce_item(args), amount=10**12,
                      currency='AED', quote='Yes to this synthetic test basket', source='unit-test',
                      at=dt.datetime.now(owner_go.UTC).isoformat())
        return result

    opening = patch.object(journal, 'open_flow', side_effect=opened)
    opening.start(); test.addCleanup(opening.stop)

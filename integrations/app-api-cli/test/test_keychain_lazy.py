"""Keychain initialization tests with mocked frameworks and isolated modules."""
from contextlib import contextmanager
import importlib
import os
from pathlib import Path
import sys
import types
import unittest
from unittest.mock import MagicMock, call, patch


class KeychainLazyTests(unittest.TestCase):
    @contextmanager
    def keychain(self, platform='darwin', interactive=None, error=None):
        security, foundation = MagicMock(), MagicMock()
        security.SecKeychainFindGenericPassword.return_value = -25300
        capture = str(Path(__file__).resolve().parents[1] / 'capture')
        with patch.dict(sys.modules), patch.dict(os.environ), \
                patch.object(sys, 'path', [capture, *sys.path]), \
                patch.object(sys, 'platform', platform), \
                patch('ctypes.CDLL', side_effect=error or [security, foundation]) as cdll:
            os.environ.pop('APP_API_KEYCHAIN_INTERACTIVE', None)
            if interactive is not None:
                os.environ['APP_API_KEYCHAIN_INTERACTIVE'] = interactive
            sys.modules.pop('keychain', None)
            module = importlib.reload(importlib.import_module('keychain'))
            cdll.assert_not_called()
            yield module, cdll, security, foundation

    def test_missing_framework_is_reported_on_use_not_import(self):
        error = OSError('framework unavailable')
        with self.keychain(error=error) as (module, cdll, _, _):
            with self.assertRaisesRegex(RuntimeError, '^KEYCHAIN_UNAVAILABLE:') as raised:
                module.load('x')
            self.assertIs(raised.exception.__cause__, error)
            cdll.assert_called_once()

    def test_non_darwin_never_attempts_to_load_frameworks(self):
        with self.keychain(platform='linux', error=OSError()) as (module, cdll, _, _):
            for operation, args in ((module.find, ('x',)), (module.load, ('x',)),
                                    (module.store, ('x', {}))):
                with self.subTest(operation=operation.__name__):
                    with self.assertRaisesRegex(RuntimeError, '^KEYCHAIN_UNAVAILABLE:'):
                        operation(*args)
            cdll.assert_not_called()

    def test_interaction_is_configured_once_before_first_read(self):
        for value, expected in ((None, False), ('1', True), ('0', False), ('true', False)):
            with self.subTest(interactive=value), self.keychain(interactive=value) as libs:
                module, cdll, security, _ = libs
                self.assertIsNone(module.load('x'))
                os.environ['APP_API_KEYCHAIN_INTERACTIVE'] = '0' if expected else '1'
                self.assertIsNone(module.load('x'))
                self.assertEqual(cdll.call_count, 2)
                security.SecKeychainSetUserInteractionAllowed.assert_called_once_with(expected)
                self.assertEqual(security.mock_calls[0],
                                 call.SecKeychainSetUserInteractionAllowed(expected))
                self.assertEqual(security.SecKeychainFindGenericPassword.call_count, 2)

    def test_other_read_status_still_raises(self):
        with self.keychain() as (module, _, security, _):
            security.SecKeychainFindGenericPassword.return_value = -25293
            with self.assertRaisesRegex(RuntimeError, '^Keychain read status -25293$'):
                module.load('x')

    def test_core_foundation_load_failure_is_chained(self):
        error = OSError('CoreFoundation unavailable')
        with self.keychain() as (module, cdll, security, _):
            cdll.side_effect = [security, error]
            with self.assertRaisesRegex(RuntimeError, '^KEYCHAIN_UNAVAILABLE:') as raised:
                module.load('x')
            self.assertIs(raised.exception.__cause__, error)
            security.SecKeychainSetUserInteractionAllowed.assert_not_called()

    def test_existing_fake_keychain_module_is_restored(self):
        fake = types.ModuleType('keychain')
        fake.load = MagicMock(return_value=None)
        fake.store = MagicMock()
        with patch.dict(sys.modules, {'keychain': fake}):
            with self.keychain() as (module, _, _, _):
                self.assertIsNot(module, fake)
                self.assertIsNone(module.load('x'))
            self.assertIs(sys.modules['keychain'], fake)
            fake.load.assert_not_called()
            fake.store.assert_not_called()

    def test_receipts_import_and_noon_serialization_need_no_talabat(self):
        blocked = dict.fromkeys(('talabat_http_checkout', 'talabat_place_contract',
                                 'talabat_quote_diagnostics'))
        with patch.dict(sys.modules, blocked):
            sys.modules.pop('commerce_receipts', None)
            receipts = importlib.reload(importlib.import_module('commerce_receipts'))
            receipt = receipts.Receipt('tracking', 'EXACT_ORDER_CONFIRMED', order_id='fixture')
            self.assertIsNone(receipts._wire(receipt)['context'])


if __name__ == '__main__':
    unittest.main()

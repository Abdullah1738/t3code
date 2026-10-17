"""Bridge tests independent of account secrets and unfinished auth deployment."""
import sys
from pathlib import Path
import types
import unittest
from unittest.mock import patch, Mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import talabat_native as native


class AccountBridgeTests(unittest.TestCase):
    def test_account_routes_to_adapter_not_guest(self):
        module = types.ModuleType('talabat_account_catalog')
        module.TalabatError = type('TalabatError', (Exception,), {})
        module.run = Mock(return_value={'ok': True, 'account': {'authenticated': True}})
        with patch.dict(sys.modules, {'talabat_account_catalog': module}), \
             patch.object(native, 'Talabat', side_effect=AssertionError('guest initialization')):
            result = native.run('menu', branch=717327, require_account=True)
        self.assertTrue(result['account']['authenticated'])
        self.assertEqual(module.run.call_args.kwargs['branch'], 717327)

    def test_unsupported_discovery_and_context_conflicts(self):
        with patch.object(native, 'Talabat') as guest:
            for mode in ('groceries', 'pharmacies', 'flowers', 'menu-match'):
                with self.assertRaises(native.NativeError) as exc:
                    native.run(mode, 'x', require_account=True)
                self.assertEqual(exc.exception.code, 'ACCOUNT_MODE_UNSUPPORTED')
            for kwargs in ({'force_web': True}, {'saved': {}}):
                with self.assertRaises(native.NativeError) as exc:
                    native.run('menu', branch=1, require_account=True, **kwargs)
                self.assertEqual(exc.exception.code, 'ACCOUNT_CONTEXT_CONFLICT')
            guest.assert_not_called()

    def test_unavailable_dependency_never_falls_back(self):
        with patch.dict(sys.modules, {'talabat_account_catalog': None}), patch.object(native, 'Talabat') as guest:
            with self.assertRaises(native.NativeError) as exc:
                native.run('menu', branch=1, require_account=True)
            self.assertEqual(exc.exception.code, 'ACCOUNT_CATALOG_DEPENDENCY_UNAVAILABLE')
            guest.assert_not_called()

    def test_sanitized_adapter_error(self):
        module = types.ModuleType('talabat_account_catalog')
        module.TalabatError = type('TalabatError', (Exception,), {})
        module.run = Mock(side_effect=module.TalabatError('HOME_MISMATCH'))
        with patch.dict(sys.modules, {'talabat_account_catalog': module}):
            with self.assertRaises(native.NativeError) as exc:
                native.run('menu', branch=1, require_account=True)
        self.assertEqual(exc.exception.code, 'HOME_MISMATCH')

    def test_guest_path_remains_guest(self):
        with patch.object(native, 'Talabat') as cls:
            tb = cls.return_value
            tb.fallbacks = []
            tb.menu.return_value = {'items': []}
            result = native.run('menu', branch=1)
        cls.assert_called_once_with(None, 20, native_only=False, force_web=False)
        self.assertFalse(result['account']['authenticated'])
        self.assertEqual(result['location'], native.HOME)


if __name__ == '__main__':
    unittest.main()

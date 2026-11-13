"""Run approval and affected commerce regressions without a live Keychain.

PYTHONPATH=.:test python3 test/run_owner_go_tests.py
"""
import sys
import types
import unittest


if sys.platform != 'darwin':
    # Legacy commerce imports the deployed macOS adapter even in tests. The
    # regression fixtures supply auth; an attempted real secret read must fail.
    keychain = types.ModuleType('keychain')

    def unavailable(*args, **kwargs):
        raise AssertionError('live Keychain is forbidden in these tests')

    keychain.load = keychain.store = unavailable
    sys.modules['keychain'] = keychain


if __name__ == '__main__':
    names = ['test_owner_go', 'test_owner_go_gates', 'test_install_cli',
             'test_commerce_journal', 'test_commerce_preorder_journal',
             'test_commerce_cli_baskets', 'test_commerce_flow', 'test_commerce_marketplace',
             'test_commerce_main_order', 'test_commerce_supermall_order', 'test_commerce_nownow_order',
             'test_commerce_minutes', 'test_commerce_nownow', 'test_commerce_preorder',
             'test_noon_minutes_checkout', 'test_noon_nownow_checkout', 'test_noon_marketplace_checkout']
    result = unittest.TextTestRunner(verbosity=1).run(unittest.defaultTestLoader.loadTestsFromNames(names))
    sys.exit(not result.wasSuccessful())

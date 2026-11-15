"""Run approval and affected commerce regressions without a live Keychain.

PYTHONPATH=.:test python3 test/run_owner_go_tests.py
"""
import sys
import os
import types
import unittest
from pathlib import Path

# -I excludes cwd and the script directory; resolve both test imports explicitly.
sys.path[:0] = [str(Path(__file__).resolve().parents[1]), str(Path(__file__).resolve().parent)]

# Captured lane fixtures use the explicitly selected Marriott fallback. The
# fixture helper supplies the synthetic 9546 decline required by current policy.
os.environ['COMMERCE_CARD_LAST4'] = '2342'


if sys.platform != 'darwin':
    # Legacy commerce imports the deployed macOS adapter even in tests. The
    # regression fixtures supply auth; an attempted real secret read must fail.
    keychain = types.ModuleType('keychain')

    def unavailable(*args, **kwargs):
        raise AssertionError('live Keychain is forbidden in these tests')

    keychain.load = keychain.store = unavailable
    sys.modules['keychain'] = keychain


if __name__ == '__main__':
    names = [
        'test_owner_go',
        'test_owner_go_delegation',
        'test_owner_go_gates',
        'test_install_cli',
        'test_commerce_journal',
        'test_commerce_preorder_journal',
        'test_commerce_cli_baskets',
        'test_commerce_flow',
        'test_commerce_marketplace',
        'test_commerce_main_order',
        'test_commerce_supermall_order',
        'test_commerce_nownow_order',
        'test_commerce_minutes',
        'test_commerce_nownow',
        'test_commerce_preorder',
        'test_noon_minutes_checkout',
        'test_noon_nownow_checkout',
        'test_noon_marketplace_checkout',
        'test_card_status_recover',
        'test_commerce_account_fence',
        'test_commerce_owner_attestation',
        'test_commerce_preorder_redirect',
        'test_commerce_preorder_release',
        'test_commerce_purchase_guards',
        'test_commerce_reconcile',
        'test_commerce_talabat',
        'test_food_capture_close',
        'test_marketplace_cleanup',
        'test_minutes_cart_recovery',
        'test_minutes_failed_close',
        'test_noon_food_financial',
        'test_nownow_active_orders',
        'test_nownow_cleanup',
        'test_talabat_duplicate',
        'test_talabat_fresh_review',
        'test_talabat_order_adapter',
        'test_talabat_payment_outcome',
        'test_talabat_submit_journal',
    ]
    result = unittest.TextTestRunner(verbosity=1).run(unittest.defaultTestLoader.loadTestsFromNames(names))
    sys.exit(not result.wasSuccessful())

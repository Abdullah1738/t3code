import sys
import unittest
from pathlib import Path
from unittest.mock import patch
sys.path.insert(0, str(Path(__file__).resolve().parents[1]/'capture'))
import probe_window
import metadata_only
from types import SimpleNamespace


class ProxyCleanupTests(unittest.TestCase):
    def test_clone_tls_interception_leaves_sdk_connections_untouched(self):
        for host, expected in [('api.talabat.com', False), ('firebaseinstallations.googleapis.com', True),
                               ('api.talabat.com.evil.test', True), (None, True)]:
            d = SimpleNamespace(client_hello=SimpleNamespace(sni=host), ignore_connection=False)
            metadata_only.tls_clienthello(d)
            self.assertEqual(d.ignore_connection, expected)

    def test_capture_allowlist_excludes_cart_and_payments(self):
        for path in ['/grocery/v2/cart', '/grocery/v2/cart/items', '/payment/foo', '/grocery/v1/checkout']:
            self.assertFalse(metadata_only.TALABAT_READ.search(path))
        self.assertTrue(metadata_only.TALABAT_READ.search('/search/api/v3/vendor'))

    def test_clear_cached_proxy_before_deleting_settings(self):
        before = dict.fromkeys(probe_window.KEYS, 'null')
        with patch.object(probe_window, 'adb') as adb, patch.object(probe_window.time, 'sleep'):
            self.assertEqual(probe_window.restore_proxy(before), [])
        self.assertEqual(adb.call_args_list[0].args,
                         ('shell', 'settings', 'put', 'global', 'http_proxy', ':0'))
        self.assertEqual([c.args[-1] for c in adb.call_args_list[1:]], probe_window.KEYS[1:])

    def test_failure_does_not_skip_remaining_cleanup(self):
        before = dict.fromkeys(probe_window.KEYS, 'null')
        with patch.object(probe_window, 'adb', side_effect=[RuntimeError(), None, None, None, None, None]) as adb:
            self.assertEqual(probe_window.restore_proxy(before), ['clear_cached_proxy'])
        self.assertEqual(adb.call_count, 5)


if __name__ == '__main__': unittest.main()

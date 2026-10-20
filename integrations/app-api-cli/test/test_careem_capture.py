import sys
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'capture'))
import careem_metadata
import firebase_clone
import phone_guard
import clone_diagnostics


class CareemCaptureTests(unittest.TestCase):
    def test_scope_excludes_unrelated_domains_and_suffix_impersonation(self):
        for host,allowed in [('rides.careemapis.com',True),('identity.careem.com',True),
                             ('careem.com.evil.test',False),('notcareem.com',False),
                             ('firebaseinstallations.googleapis.com',False),(None,False)]:
            data=SimpleNamespace(client_hello=SimpleNamespace(sni=host),ignore_connection=False,
                                 context=SimpleNamespace(server=SimpleNamespace(address=('192.0.2.1',443))))
            careem_metadata.tls_clienthello(data)
            self.assertEqual(data.ignore_connection,not allowed)

    def test_phone_ipv6_is_routed_by_observed_hostname_with_sni_preserved(self):
        server=SimpleNamespace(address=('2001:db8::1',443),sni=None)
        data=SimpleNamespace(client_hello=SimpleNamespace(sni='appengine.careemapis.com'),
                             context=SimpleNamespace(server=server))
        with patch.object(careem_metadata.socket,'gethostbyname',return_value='192.0.2.10') as dns, patch.object(careem_metadata,'emit'):
            careem_metadata.tls_clienthello(data)
        dns.assert_called_once_with('appengine.careemapis.com')
        self.assertEqual(server.address,('192.0.2.10',443))
        self.assertEqual(server.sni,'appengine.careemapis.com')
        self.assertEqual(careem_metadata.log_path('/identity/device/exampleDeviceID'),'/identity/device/{identifier}')

    def test_capture_blocks_booking_cart_and_payment_before_forwarding(self):
        for path in ['/v1/bookings','/v2/rides/orders','/v1/cart/items','/payments/cards','/checkout']:
            flow=SimpleNamespace(request=SimpleNamespace(pretty_url='https://rides.careemapis.com'+path),metadata={},response=None)
            with patch.object(careem_metadata,'emit'):
                careem_metadata.request(flow)
            self.assertEqual(flow.response.status_code,409)
            self.assertNotIn('careem_url',flow.metadata)
        self.assertFalse(careem_metadata.DENY.search('/v2/rides/estimate'))

    def test_firebase_patch_only_changes_two_header_values_and_is_repeatable(self):
        original='''# firebaseinstallations.googleapis.com
    const-string v1, "X-Android-Package"
    invoke-virtual {p0}, Landroid/content/Context;->getPackageName()Ljava/lang/String;
    move-result-object v3
    invoke-virtual {p1, v1, v3}, Ljava/net/URLConnection;->addRequestProperty(Ljava/lang/String;Ljava/lang/String;)V
    const-string p0, "X-Android-Cert"
    invoke-virtual {p1, p0, v0}, Ljava/net/URLConnection;->addRequestProperty(Ljava/lang/String;Ljava/lang/String;)V
    const-string p0, "x-goog-api-key"
    invoke-virtual {p1, p0, p2}, Ljava/net/URLConnection;->addRequestProperty(Ljava/lang/String;Ljava/lang/String;)V
'''
        with tempfile.TemporaryDirectory() as td:
            root=Path(td); smali=root/'smali/sdk/Firebase.smali'; smali.parent.mkdir(parents=True);smali.write_text(original)
            result=SimpleNamespace(returncode=0,stdout='Signer #1 certificate SHA-1 digest: '+'a'*40)
            with patch.object(firebase_clone.subprocess,'run',return_value=result):
                firebase_clone.patch_firebase(root,'base.apk','com.example.original','apksigner')
                first=smali.read_text()
                firebase_clone.patch_firebase(root,'base.apk','com.example.original','apksigner')
            self.assertEqual(smali.read_text(),first)
            self.assertIn('const-string v3, "com.example.original"',first)
            self.assertIn('const-string v0, "'+'A'*40+'"',first)
            self.assertTrue(first.endswith(original[original.index('    const-string p0, "x-goog-api-key"'):]))

    def test_fresh_hold_blocks_and_stale_hold_remains_present(self):
        with tempfile.TemporaryDirectory() as td:
            hold=Path(td)/'hold';hold.touch()
            with patch.object(phone_guard,'HOLD',hold),patch.object(phone_guard.time,'time',return_value=hold.stat().st_mtime+60):
                self.assertTrue(phone_guard.held())
                with self.assertRaises(SystemExit): phone_guard.check()
            with patch.object(phone_guard,'HOLD',hold),patch.object(phone_guard.time,'time',return_value=hold.stat().st_mtime+2701):
                self.assertFalse(phone_guard.held())
            self.assertTrue(hold.exists())

    def test_screen_redaction(self):
        value=phone_guard.redact('Mastercard •• 1234 number 4111 1111 1111 1111 API AIzaFakeExampleKey')
        self.assertNotIn('1234',value);self.assertNotIn('4111',value);self.assertNotIn('AIza',value)

    def test_log_summary_never_returns_firebase_options_or_credentials(self):
        log='''I/ActivityManager( 1): Start proc 123:com.careem.capture/u0a1
W/Firebase( 123): API_KEY_ANDROID_APP_BLOCKED Firebase options secret-example
E/Test( 123): java.io.IOException: token secret-example
I/Other( 222): FATAL EXCEPTION java.lang.RuntimeException
'''
        summary=clone_diagnostics.summarize(log,'com.careem.capture')
        self.assertTrue(summary['firebase_android_app_blocked'])
        self.assertFalse(summary['fatal_exception'])
        self.assertEqual(summary['exceptions'],['java.io.IOException'])
        self.assertNotIn('secret-example',str(summary))


if __name__ == '__main__': unittest.main()

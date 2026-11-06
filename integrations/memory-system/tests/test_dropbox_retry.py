"""dropbox_mirror.Api.call retries a truncated or reset response (2026-11-06:
one IncompleteRead on list_folder failed the whole mirror) and still fails
loudly when every attempt breaks. No network: urlopen and sleep are stubbed."""
import http.client, io, json, os, sys, unittest
from unittest import mock

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "src"))
import dropbox_mirror as m  # noqa: E402


class Resp(io.BytesIO):
    pass


def api():
    a = m.Api.__new__(m.Api)
    a.tok, a.t = "t", 1e18  # far future: never refreshes the token
    return a


class Retry(unittest.TestCase):
    def test_incomplete_read_then_success(self):
        calls = [http.client.IncompleteRead(b"x" * 10, 5), ConnectionResetError(54, "reset"),
                 Resp(json.dumps({"ok": 1}).encode())]

        def fake(req, timeout):
            r = calls.pop(0)
            if isinstance(r, BaseException):
                raise r
            return r
        with mock.patch.object(m.urllib.request, "urlopen", fake), mock.patch.object(m.time, "sleep"):
            self.assertEqual(api().call("files/list_folder", {}), {"ok": 1})
        self.assertEqual(calls, [])

    def test_truncated_json_is_retried(self):
        calls = [Resp(b'{"entries": ['), Resp(b'{"ok": 2}')]
        with mock.patch.object(m.urllib.request, "urlopen", lambda req, timeout: calls.pop(0)), \
                mock.patch.object(m.time, "sleep"):
            self.assertEqual(api().call("files/list_folder", {}), {"ok": 2})

    def test_persistent_failure_still_raises(self):
        def fake(req, timeout):
            raise http.client.IncompleteRead(b"", 1)
        with mock.patch.object(m.urllib.request, "urlopen", fake), mock.patch.object(m.time, "sleep"):
            with self.assertRaises(RuntimeError) as cm:
                api().call("files/list_folder", {})
        self.assertIn("retries exhausted", str(cm.exception))


if __name__ == "__main__":
    unittest.main()

"""dropbox_mirror.load_auth: trailing junk after the auth JSON is an error that
names the file and position, never silently accepted (card #11)."""
import json, os, sys, tempfile, unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "src"))
import dropbox_mirror as m  # noqa: E402

GOOD = {"": {"personal": {"refresh_token": "r", "app_key": "k"}}}


class LoadAuth(unittest.TestCase):
    def write(self, text):
        d = tempfile.mkdtemp()
        p = os.path.join(d, "auth.json")
        with open(p, "w", encoding="utf-8") as f:
            f.write(text)
        return p

    def test_clean_file_parses(self):
        self.assertEqual(m.load_auth(self.write(json.dumps(GOOD))), GOOD)

    def test_trailing_brace_is_rejected_with_position(self):
        p = self.write(json.dumps(GOOD) + "}")
        with self.assertRaises(RuntimeError) as cm:
            m.load_auth(p)
        msg = str(cm.exception)
        self.assertIn(p, msg)
        self.assertIn("trailing byte", msg)
        self.assertIn(str(len(json.dumps(GOOD))), msg)
        self.assertNotIn("refresh_token", msg)  # never echo the secret

    def test_json_whitespace_around_object_is_accepted(self):
        p = self.write("\n \t" + json.dumps(GOOD) + "\r\n")
        self.assertEqual(m.load_auth(p), GOOD)

    def test_nbsp_and_vertical_tab_after_object_are_rejected(self):
        for junk in ("\u00a0", "\x0b", "\u2028"):
            with self.subTest(junk=repr(junk)):
                p = self.write(json.dumps(GOOD) + junk)
                with self.assertRaises(RuntimeError):
                    m.load_auth(p)

    def test_upload_passes_token_in_env_not_auth_file(self):
        import unittest.mock as mock
        seen = {}

        def fake_run(argv, **kw):
            seen["env"] = kw.get("env", {})
            return mock.Mock(returncode=0, stderr="", stdout="")

        with mock.patch.object(m.subprocess, "run", side_effect=fake_run):
            self.assertIsNone(m.upload("/tmp/x", "/Dropbox/x", "TOKEN-123"))
        self.assertEqual(seen["env"].get("DBXCLI_ACCESS_TOKEN"), "TOKEN-123")
        self.assertNotIn(m.AUTH, str(seen["env"]))

    def test_truncated_file_names_the_file(self):
        p = self.write('{"": {"personal": {"refresh_')
        with self.assertRaises(RuntimeError) as cm:
            m.load_auth(p)
        self.assertIn(p, str(cm.exception))
        self.assertIn("not valid JSON", str(cm.exception))


if __name__ == "__main__":
    unittest.main()

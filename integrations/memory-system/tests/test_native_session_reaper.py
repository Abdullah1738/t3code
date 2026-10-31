"""native_session_reaper: report-only never unlinks; uncaptured files are not listed.

Temp dirs only:  python3 -m unittest discover -s tests -p 'test_native_session_reaper.py' -v
"""
import os
import sys
import tempfile
import time
import unittest
from unittest import mock

SRC = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "src")
sys.path.insert(0, SRC)

import native_session_reaper as nsr  # noqa: E402
import transcript_roots as tr  # noqa: E402


class ReportOnly(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.homes = os.path.join(self.tmp.name, "harness-homes")
        self.now = 1_800_000_000.0
        self.old = self.now - 200 * 86400
        self.file = self.write("codex/sessions/2026/rollout-old.jsonl", b'{"type":"session_meta"}\n')
        os.utime(self.file, (self.old, self.old))
        self.manifest = {"stamp": "M", "files": [{"path": "sessions/2026/rollout-old.jsonl"}]}
        self.ledger = {self.file: {"offset": len(b'{"type":"session_meta"}\n'), "error_count": 0,
                                   "thread_id": "th-settled"}}
        p = mock.patch.object(tr, "HARNESS_HOMES", self.homes)
        p.start()
        self.addCleanup(p.stop)

    def write(self, rel, data):
        path = os.path.join(self.homes, rel)
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "wb") as f:
            f.write(data)
        return path

    def roots(self):
        return tr.roots()

    def test_candidate_listed_when_settled_captured_and_in_manifest(self):
        out = nsr.plan(self.roots(), self.ledger, self.manifest, {"th-settled"}, now=self.now)
        self.assertEqual([c["path"] for c in out], [self.file])

    def test_uncaptured_file_not_listed(self):
        ledger = {self.file: {"offset": 3, "error_count": 0, "thread_id": "th-settled"}}
        out = nsr.plan(self.roots(), ledger, self.manifest, {"th-settled"}, now=self.now)
        self.assertEqual(out, [])

    def test_file_not_in_manifest_not_listed(self):
        out = nsr.plan(self.roots(), self.ledger, {"files": []}, {"th-settled"}, now=self.now)
        self.assertEqual(out, [])

    def test_unsettled_thread_not_listed(self):
        out = nsr.plan(self.roots(), self.ledger, self.manifest, set(), now=self.now)
        self.assertEqual(out, [])

    def test_recent_file_not_listed(self):
        recent = self.now - 10 * 86400
        os.utime(self.file, (recent, recent))
        out = nsr.plan(self.roots(), self.ledger, self.manifest, {"th-settled"}, now=self.now)
        self.assertEqual(out, [])

    def test_report_only_never_unlinks(self):
        state = os.path.join(self.tmp.name, "statev2.sqlite")
        ledger_db = os.path.join(self.tmp.name, "memory.db")
        import io
        with mock.patch.object(nsr.os, "remove") as rm, mock.patch.object(nsr.os, "unlink") as ul, \
                mock.patch("sys.stdout", new_callable=io.StringIO) as out:
            with mock.patch.object(nsr, "latest_manifest", return_value=self.manifest):
                with mock.patch.object(nsr, "load_ledger", return_value=self.ledger):
                    with mock.patch.object(nsr, "settled_threads", return_value={"th-settled"}):
                        nsr.main(["--ledger", ledger_db, "--state-db", state])
            self.assertIn('"deletes": 0', out.getvalue())
            rm.assert_not_called()
            ul.assert_not_called()
        self.assertTrue(os.path.exists(self.file))


if __name__ == "__main__":
    unittest.main()

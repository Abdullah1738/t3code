"""qcard clean never deletes a card that a live share still points at, and deletes nothing when the bridge can't say."""
import importlib.machinery
import importlib.util
import os
import sys
import shutil
import tempfile
import time
import unittest
from unittest import mock

HERE = os.path.dirname(os.path.abspath(__file__))
QCARD = os.path.join(HERE, "..", "bin", "qcard")


def load_qcard():
    sys.path.insert(0, os.path.join(HERE, "..", "libexec", "qcard"))
    loader = importlib.machinery.SourceFileLoader("qcard_under_test", QCARD)
    spec = importlib.util.spec_from_loader(loader.name, loader)
    module = importlib.util.module_from_spec(spec)
    loader.exec_module(module)
    return module


class QcardCleanTest(unittest.TestCase):
    def setUp(self):
        self.apps = tempfile.mkdtemp(prefix="qcard-clean-test-")
        self.qcard = load_qcard()
        self.qcard.APPS = self.apps
        old = time.time() - 30 * 86400
        for name in ("q-old-shared", "q-old-free", "q-new"):
            path = os.path.join(self.apps, name)
            os.makedirs(path)
            with open(os.path.join(path, "index.html"), "w") as fh:
                fh.write("<title>x</title>")
            os.utime(path, (old, old) if name != "q-new" else None)

    def tearDown(self):
        shutil.rmtree(self.apps, ignore_errors=True)

    def remaining(self):
        return sorted(os.listdir(self.apps))

    def test_a_live_share_keeps_its_card_directory(self):
        payload = {"shares": [{"app": "q-old-shared", "live": True}, {"app": "q-new", "live": True}]}
        with mock.patch.object(self.qcard, "bridge", return_value=payload):
            gone = self.qcard.clean(14)
        self.assertEqual(gone, ["q-old-free"])
        self.assertEqual(self.remaining(), ["q-new", "q-old-shared"])

    def test_a_share_that_is_down_still_keeps_its_card(self):
        # After a restart the origin may fail to bind, so shares reports live:false while the permanent link and its
        # files remain. Deleting the directory would break the link for good.
        payload = {"shares": [{"app": "q-old-shared", "live": False}]}
        with mock.patch.object(self.qcard, "bridge", return_value=payload):
            gone = self.qcard.clean(14)
        self.assertEqual(gone, ["q-old-free"])
        self.assertEqual(self.remaining(), ["q-new", "q-old-shared"])

    def test_unreadable_share_list_deletes_nothing(self):
        with mock.patch.object(self.qcard, "bridge", side_effect=SystemExit("bridge shares failed")):
            gone = self.qcard.clean(14)
        self.assertEqual(gone, [])
        self.assertEqual(self.remaining(), ["q-new", "q-old-free", "q-old-shared"])


if __name__ == "__main__":
    unittest.main()


class QcardLogTest(unittest.TestCase):
    def test_render_logs_success_and_failure_without_spec_data(self):
        q = load_qcard()
        with tempfile.TemporaryDirectory() as folder:
            args = ['qcard', 'stat', '--json', '{"title":"PRIVATE_CARD", "value":123}', '--out', folder, '--no-og']
            with mock.patch.object(q.sys, 'argv', args), mock.patch.object(q.render, 'build', return_value=('page', 'og', {'caption':'x', 'subcaption':'y', 'title':'t', 'description':'d'})), mock.patch.object(q, 'log_render') as log, mock.patch('builtins.print'):
                q.main()
                self.assertTrue(log.call_args.args[1])
            with mock.patch.object(q.sys, 'argv', args), mock.patch.object(q.render, 'build', side_effect=ValueError('PRIVATE_CARD')), mock.patch.object(q, 'log_render') as log:
                with self.assertRaises(ValueError):
                    q.main()
                self.assertFalse(log.call_args.args[1])

    def test_log_emitter_is_best_effort_and_sends_only_kind_duration_ok(self):
        q = load_qcard()
        with mock.patch.object(q.subprocess, 'Popen') as child, mock.patch.object(q.threading, 'Thread'):
            q.log_render(time.monotonic(), False)
            command = child.call_args.args[0]
            self.assertEqual(command[2:5], ['log-card-render', '--kind', 'quick'])
            self.assertEqual(command[-2:], ['--ok', 'false'])
        with mock.patch.object(q.subprocess, 'Popen', side_effect=OSError('unavailable')):
            q.log_render(time.monotonic(), True)

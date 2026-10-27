"""qcard clean never deletes a card that a live share still points at, and deletes nothing when the bridge can't say."""
import importlib.machinery
import importlib.util
import os
import shutil
import tempfile
import time
import unittest
from unittest import mock

HERE = os.path.dirname(os.path.abspath(__file__))
QCARD = os.path.join(HERE, "..", "bin", "qcard")


def load_qcard():
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

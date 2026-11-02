"""took.py skip: records a skipped dose in moved.json, never in taken.json."""
import datetime as dt
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
TOOK = os.environ.get(
    "TOOK_PY",
    os.path.join(HERE, "..", "..", "watchers", "meds-nag", "took.py"),
)
CHECK = os.environ.get(
    "CHECK_PY", os.path.join(HERE, "..", "..", "watchers", "meds-nag", "check.py")
)
DAY = "2026-10-29"


class TookSkipTest(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp(prefix="meds-skip-")
        shutil.copy(os.path.abspath(TOOK), os.path.join(self.dir, "took.py"))
        shutil.copy(CHECK, os.path.join(self.dir, "check.py"))
        for name in ("taken.json", "moved.json"):
            with open(os.path.join(self.dir, name), "w") as f:
                json.dump({}, f)

    def tearDown(self):
        shutil.rmtree(self.dir, ignore_errors=True)

    def run_took(self, *args):
        return subprocess.run(
            ["/usr/bin/python3", "took.py", *args],
            cwd=self.dir, capture_output=True, text=True,
        )

    def read(self, name):
        with open(os.path.join(self.dir, name)) as f:
            return json.load(f)

    def test_skip_writes_moved_json_not_taken(self):
        r = self.run_took(DAY, "skip", "reta", "--note", "x")
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertEqual(self.read("moved.json"), {DAY: {"skip": ["Reta"], "note": "x"}})
        self.assertEqual(self.read("taken.json"), {})

    def test_skip_twice_is_one_entry(self):
        self.assertEqual(self.run_took(DAY, "skip", "reta").returncode, 0)
        self.assertEqual(self.run_took(DAY, "skip", "reta").returncode, 0)
        self.assertEqual(self.read("moved.json")[DAY]["skip"], ["Reta"])

    def test_skip_clears_the_nag(self):
        self.assertEqual(self.run_took(DAY, "skip", "reta").returncode, 0)
        sys.path.insert(0, self.dir)
        try:
            os.environ["WATCH_DIR"] = self.dir
            import check
            left = check.outstanding(dt.date(2026, 10, 29), {})
        finally:
            sys.path.remove(self.dir)
            os.environ.pop("WATCH_DIR", None)
            sys.modules.pop("check", None)
        # Only the due-day Reta is checked. check.py's carry-forward can still list an older unconfirmed
        # Reta ("from Thu 22 Oct, missed"); that is pre-existing check.py behaviour, reported on the card.
        self.assertNotIn("Reta 3mg", left, left)
        self.assertTrue(any(x.startswith("Dutasteride 0.5mg") for x in left), left)

    def test_unknown_and_all_are_refused(self):
        before = self.read("moved.json")
        self.assertNotEqual(self.run_took(DAY, "skip", "bogus").returncode, 0)
        self.assertNotEqual(self.run_took(DAY, "skip", "all").returncode, 0)
        self.assertEqual(self.read("moved.json"), before)

    def test_taking_still_works(self):
        r = self.run_took(DAY, "dutasteride")
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertEqual(self.read("taken.json"), {DAY: ["dutasteride"]})


if __name__ == "__main__":
    unittest.main()

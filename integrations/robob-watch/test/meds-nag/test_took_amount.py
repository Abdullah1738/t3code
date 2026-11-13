"""Actual amounts, carry receipts and compatibility with the original confirmation commands."""
import ast
import datetime as dt
from decimal import Decimal
import importlib.util
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile
import unittest
from unittest import mock

SOURCE = Path(__file__).resolve().parents[2] / "watchers/meds-nag"
REPO = Path(__file__).resolve().parents[4]
# The branch-point script is the compatibility oracle, rather than the changing live install.
BASE_REF = "13aed0b18e95480862f8d2065bb0cf494f19f31f"
DAY = "2026-11-06"
VALUE = "2mg (actual, not the scheduled 3mg; carried from Thu 5 Nov)"


class TookAmountTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="meds-amount-")
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        for name in ("check.py", "took.py"):
            shutil.copy2(SOURCE / name, self.root / name)
        for name in ("taken", "doses", "moved", "sites", "nagstate", "snooze", "state"):
            self.write(name, {})
        self.env = dict(os.environ, MEDS_NOW="2026-11-06T22:38:00+04:00",
                        WATCH_DIR=str(self.root), PYTHONDONTWRITEBYTECODE="1",
                        HEALTH_TOOLLOG_DIR=str(self.root / "logs"))

    def write(self, name, value):
        (self.root / (name + ".json")).write_text(json.dumps(value))

    def read(self, name):
        return json.loads((self.root / (name + ".json")).read_text())

    def snapshot(self):
        return {p.name: p.read_bytes() for p in self.root.glob("*.json")}

    def took(self, *args, ok=True):
        r = subprocess.run(["/usr/bin/python3", "took.py", *args], cwd=self.root,
                           env=self.env, capture_output=True, text=True, timeout=10)
        if ok: self.assertEqual(r.returncode, 0, r.stderr)
        return r

    def outstanding(self):
        spec = importlib.util.spec_from_file_location("amount_check", self.root / "check.py")
        check = importlib.util.module_from_spec(spec)
        with mock.patch.dict(os.environ, self.env):
            spec.loader.exec_module(check)
            return check.outstanding(dt.date.fromisoformat(DAY), self.read("taken"))

    def test_carried_actual_records_flag_and_closes_carry(self):
        r = self.took(DAY, "reta=2mg")
        self.assertEqual(self.read("taken"), {DAY: ["reta"]})
        self.assertEqual(self.read("doses"), {DAY: {"reta": VALUE}})
        self.assertIn("flag: Reta 2mg differs from the scheduled 3mg (from Thu 5 Nov); logged as 2mg", r.stdout)
        self.assertIn("closes Reta 3mg from Thu 5 Nov", r.stdout)
        self.assertTrue(r.stdout.splitlines()[-1].startswith("still open for " + DAY))
        self.assertFalse(any(x.startswith("Reta") for x in self.outstanding()))

    def test_matching_amount_does_not_touch_doses(self):
        for text in ("3mg", "3.0MG", "03.000mg"):
            with self.subTest(text=text):
                before = (self.root / "doses.json").stat()
                raw = (self.root / "doses.json").read_bytes()
                r = self.took("2026-11-12", "reta=" + text)
                self.assertNotIn("flag:", r.stdout)
                self.assertEqual((self.root / "doses.json").read_bytes(), raw)
                self.assertEqual((self.root / "doses.json").stat().st_mtime_ns, before.st_mtime_ns)
        (self.root / "doses.json").unlink()
        self.took("2026-11-12", "reta=3mg")
        self.assertFalse((self.root / "doses.json").exists())

    def test_retry_keeps_carried_context_and_flags_once(self):
        self.took(DAY, "reta=2mg")
        before = self.snapshot()
        inode = (self.root / "doses.json").stat().st_ino
        r = self.took(DAY, "reta=2mg")
        self.assertEqual(self.snapshot(), before)
        self.assertEqual(self.read("doses"), {DAY: {"reta": VALUE}})
        self.assertEqual((self.root / "doses.json").stat().st_ino, inode)
        self.assertNotIn("flag:", r.stdout)
        self.assertNotIn("closes Reta", r.stdout)

    def test_corrected_actual_overwrites_one_entry(self):
        self.took(DAY, "reta=1mg")
        self.took(DAY, "reta=2mg")
        self.assertEqual(self.read("doses"), {DAY: {"reta": VALUE}})

    def test_bad_dose_file_never_changes_overrides_or_confirmations(self):
        for content in ('{"2026-11-01": {"reta": "1mg"},}', '', '{"2026-11-01":',
                        'null', '[]', '{"2026-11-06": []}'):
            with self.subTest(content=content):
                (self.root / "doses.json").write_text(content)
                before = self.snapshot()
                r = self.took(DAY, "reta=2mg", ok=False)
                self.assertNotEqual(r.returncode, 0)
                self.assertEqual(self.snapshot(), before)
                self.assertFalse(list(self.root.glob("*.tmp")))

    def test_unreadable_dose_file_never_changes_confirmations(self):
        path = self.root / "doses.json"
        path.unlink()
        path.mkdir()  # A directory is unreadable as a dose file on every test host.
        before = {p.name: p.read_bytes() for p in self.root.glob("*.json") if p.is_file()}
        r = self.took(DAY, "reta=2mg", ok=False)
        self.assertNotEqual(r.returncode, 0)
        self.assertIn("could not read doses.json:", r.stderr)
        self.assertTrue(path.is_dir())
        self.assertEqual({p.name: p.read_bytes() for p in self.root.glob("*.json") if p.is_file()}, before)
        self.assertFalse(list(self.root.glob("*.tmp")))

    def test_missing_dose_file_can_record_first_override(self):
        (self.root / "doses.json").unlink()
        self.took(DAY, "reta=2mg")
        self.assertEqual(self.read("doses"), {DAY: {"reta": VALUE}})

    def test_bad_amounts_never_write_any_state(self):
        self.write("snooze", {"reta": "2026-11-01T05:00:00+04:00"})
        before = self.snapshot()
        for token in ("reta=2ml", "reta=2", "reta=mg", "reta=-2mg", "reta=+2mg",
                      "reta=NaNmg", "reta=infmg", "reta=1e2mg", "reta=1.2.3mg",
                      "reta=2mg=3mg", "reta=2mg:L:R", "reta:L=2mg:R", "all=2mg",
                      "bogus=2mg", "reta=2mgjunk"):
            with self.subTest(token=token):
                r = self.took(DAY, "dutasteride", token, ok=False)
                self.assertNotEqual(r.returncode, 0)
                self.assertIn("usage:", r.stderr)
                self.assertEqual(self.snapshot(), before)
                self.assertFalse(list(self.root.glob("*.tmp")))

    def test_units_decimals_and_case_parse_in_hlog(self):
        for text, expected in (("2mg", (2., "mg")), ("250MCG", (250., "mcg")),
                               ("2IU", (2., "iu")), (".25mg", (.25, "mg")),
                               ("2.Mg", (2., "mg")), ("0mg", (0., "mg"))):
            with self.subTest(text=text):
                self.write("taken", {})
                self.write("doses", {})
                self.took(DAY, "RETA=" + text)
                value = self.read("doses")[DAY]["reta"]
                # hlog.parse_doses_json's exact regex (no import of its live command module).
                m = re.match(r"\s*([\d.]+)\s*(mg|iu|mcg)", value, re.I)
                self.assertIsNotNone(m, value)
                self.assertEqual((float(m[1]), m[2].lower()), expected)

    def test_no_schedule_still_records_actual(self):
        self.write("taken", {"2026-11-05": ["reta"]})
        r = self.took(DAY, "reta=2mg")
        self.assertEqual(self.read("doses"), {DAY: {"reta": "2mg (actual, not scheduled)"}})
        self.assertIn("flag: Reta 2mg is not scheduled; logged as 2mg", r.stdout)
        self.assertNotIn("closes Reta", r.stdout)

    def test_due_today_wins_over_old_carry(self):
        r = self.took("2026-11-12", "reta=2mg")
        self.assertEqual(self.read("doses")["2026-11-12"]["reta"], "2mg (actual, not the scheduled 3mg)")
        self.assertNotIn("closes Reta", r.stdout)

    def test_schedule_move_uses_first_amount_and_carry_date(self):
        self.write("moved", {"2026-11-05": {"skip": ["Reta"]},
                             "2026-11-04": {"add": ["Reta 4mg = 0.4ml"]}})
        self.took(DAY, "reta=2mg")
        self.assertEqual(self.read("doses")[DAY]["reta"],
                         "2mg (actual, not the scheduled 4mg; carried from Wed 4 Nov)")

    def test_multiple_amounts_preserve_unrelated_doses(self):
        self.write("doses", {"2026-11-01": {"reta": "1mg"}, DAY: {"tadalafil": "4mg"}})
        r = self.took(DAY, "reta=2mg", "arimidex=0.25mg")
        self.assertEqual(self.read("taken")[DAY], ["arimidex", "reta"])
        self.assertEqual(self.read("doses")["2026-11-01"], {"reta": "1mg"})
        self.assertEqual(self.read("doses")[DAY]["tadalafil"], "4mg")
        self.assertEqual(r.stdout.count("flag:"), 2)

    def test_meds_now_early_morning_keeps_previous_day(self):
        self.env["MEDS_NOW"] = "2026-11-07T00:32:00+04:00"
        self.took("reta=2mg")
        self.assertEqual(self.read("doses"), {DAY: {"reta": VALUE}})

    def test_legacy_commands_write_same_files_as_branch_point(self):
        baseline = subprocess.run(["git", "show", BASE_REF + ":integrations/robob-watch/watchers/meds-nag/took.py"],
                                  cwd=REPO, capture_output=True, text=True, check=True).stdout
        current = (SOURCE / "took.py").read_text()
        initial = self.snapshot()
        for args in (("reta",), ("skip", "reta"), ("all",), ("dutasteride", "tadalafil"),
                     ("skip", "reta", "--note", "later")):
            with self.subTest(args=args):
                outputs = []
                for code in (baseline, current):
                    for p in self.root.glob("*.json"): p.unlink()
                    for name, content in initial.items(): (self.root / name).write_bytes(content)
                    (self.root / "took.py").write_text(code)
                    result = self.took(DAY, *args)
                    outputs.append(self.snapshot())
                    if args == ("reta",) and code == current:
                        self.assertIn("closes Reta 3mg from Thu 5 Nov", result.stdout)
                self.assertEqual(*outputs)

    def test_amount_and_site_grammar_without_running_site_log(self):
        # Test only the parser: executing a site confirmation would call the real hlog site command.
        tree = ast.parse((SOURCE / "took.py").read_text())
        parser = next(n for n in ast.walk(tree) if isinstance(n, ast.FunctionDef) and n.name == "parse_dose")
        scope = dict(re=re, Decimal=Decimal, sys=sys, MEDS=["test", "reta"], USAGE="usage:")
        exec(compile(ast.Module(body=[parser], type_ignores=[]), "parse_dose", "exec"), scope)
        for text in ("test=100mg:R", "test:R=100mg", "TEST=100MG:r-sq", "test:R-VG=100mg"):
            with self.subTest(text=text):
                self.assertEqual(scope["parse_dose"](text), ("test", "R", ("100", "mg")))
        self.assertEqual(scope["parse_dose"]("test:L"), ("test", "L", None))


if __name__ == "__main__":
    unittest.main()

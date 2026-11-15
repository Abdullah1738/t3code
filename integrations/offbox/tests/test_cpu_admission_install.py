"""Admission-only provisioning and undo never invoke the host's service or package tools."""
import json
import os
from pathlib import Path
import sqlite3
import subprocess
import tempfile
import unittest


INSTALLER = Path(__file__).resolve().parents[1] / "server/install-host.sh"


class CpuAdmissionInstall(unittest.TestCase):
    def test_apply_is_repeatable_and_undo_preserves_later_settings(self):
        for original in ({"owners": ["ardud"]}, {"cpu_pressure_limit": 30, "max_running": 4}):
            with self.subTest(original=original), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                config = root / "config.json"
                config.write_text(json.dumps(original))
                before = config.read_bytes()
                env = {**os.environ, "BOATD_ETC": directory, "BOATD_VAR": directory}
                def run(action):
                    result = subprocess.run(["bash", str(INSTALLER), action], env=env,
                                            capture_output=True, text=True)
                    self.assertEqual(result.returncode, 0, result.stderr)
                    return json.loads(config.read_text())
                applied = run("cpu-admission")
                self.assertEqual(applied, {**original, "cpu_pressure_limit": 50})
                self.assertEqual(run("cpu-admission"), applied)
                self.assertEqual((root / "config.json.before-117").read_bytes(), before)
                self.assertEqual((root / "config.json.before-117").stat().st_mode & 0o777, 0o600)
                applied["sample_s"] = 17
                config.write_text(json.dumps(applied))
                undone = run("cpu-admission-undo")
                self.assertEqual(undone, {**original, "sample_s": 17,
                                         "cpu_pressure_limit": original.get("cpu_pressure_limit", 0)})
                self.assertEqual(run("cpu-admission-undo"), undone)

    def test_missing_undo_backup_does_not_change_config(self):
        with tempfile.TemporaryDirectory() as directory:
            config = Path(directory) / "config.json"
            config.write_text('{"owners": ["ardud"]}')
            before = config.read_bytes()
            result = subprocess.run(["bash", str(INSTALLER), "cpu-admission-undo"],
                                    env={**os.environ, "BOATD_ETC": directory, "BOATD_VAR": directory}, capture_output=True)
            self.assertNotEqual(result.returncode, 0)
            self.assertEqual(config.read_bytes(), before)

    def test_invalid_saved_backup_blocks_apply_and_undo(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            config = root / "config.json"
            config.write_text('{"owners": ["ardud"]}')
            before = config.read_bytes()
            for backup in ("partial backup", "[]", "null"):
                (root / "config.json.before-117").write_text(backup)
                for action in ("cpu-admission", "cpu-admission-undo"):
                    result = subprocess.run(["bash", str(INSTALLER), action],
                                            env={**os.environ, "BOATD_ETC": directory, "BOATD_VAR": directory}, capture_output=True)
                    self.assertNotEqual(result.returncode, 0)
                    self.assertEqual(config.read_bytes(), before)

    def test_undo_disables_a_previously_unrecognised_cpu_setting(self):
        for previous in (None, False, True, -1, 101, "nan", "inf", [], {}):
            with self.subTest(previous=previous), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                config = root / "config.json"
                original = {"cpu_pressure_limit": previous, "sample_s": 17}
                config.write_text(json.dumps(original))
                for action in ("cpu-admission", "cpu-admission-undo"):
                    result = subprocess.run(["bash", str(INSTALLER), action],
                                            env={**os.environ, "BOATD_ETC": directory, "BOATD_VAR": directory}, capture_output=True)
                    self.assertEqual(result.returncode, 0, result.stderr)
                self.assertEqual(json.loads(config.read_text()), {"cpu_pressure_limit": 0, "sample_s": 17})
                self.assertEqual(json.loads((root / "config.json.before-117").read_text()), original)

    def test_apply_indexes_existing_history_before_enabling_cpu_admission(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "config.json").write_text('{}')
            con = sqlite3.connect(root / "boatd.db")
            self.addCleanup(con.close)
            con.execute("CREATE TABLE commands(sync INTEGER,started_at REAL)")
            con.executemany("INSERT INTO commands VALUES(0,?)", ((i,) for i in range(10000)))
            con.commit()
            result = subprocess.run(["bash", str(INSTALLER), "cpu-admission"],
                                    env={**os.environ, "BOATD_ETC": directory, "BOATD_VAR": directory}, capture_output=True)
            self.assertEqual(result.returncode, 0, result.stderr)
            steps = []
            def bounded():
                steps.append(1)
                return len(steps) > 100
            con.set_progress_handler(bounded, 1)
            try:
                self.assertEqual(con.execute("SELECT MAX(started_at) FROM commands WHERE sync=0").fetchone()[0], 9999)
            finally:
                con.set_progress_handler(None, 0)

import datetime as dt
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import toollog


class BackupBytesPropsTests(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name)
        env = patch.dict(os.environ, TOOLLOG_DIR=str(self.root))
        env.start()
        self.addCleanup(env.stop)
        self.now = dt.datetime(2026, 11, 15, tzinfo=dt.timezone.utc)

    def emit(self, props):
        path = self.root/'2026-11-15.ndjson'
        before = len(path.read_text().splitlines()) if path.exists() else 0
        self.assertTrue(toollog.emit('memory', 'event', 'backup.run',
                                     now=self.now, ok=True, props=props))
        lines = path.read_text().splitlines()
        self.assertEqual(len(lines), before+1)
        return json.loads(lines[-1])['props']

    def test_backup_numbers_keep_values_and_types(self):
        values = dict(sentBytes=123456789, dbBytes=987654321, stageAgeS=42.5)
        props = self.emit(values)
        self.assertEqual(props, values)
        for key, value in values.items():
            with self.subTest(key=key):
                self.assertIs(type(props[key]), type(value))

    def test_each_backup_prop_accepts_ints_and_floats(self):
        for key in ('sentBytes', 'dbBytes', 'stageAgeS'):
            for value in (0, 123, 42.5):
                with self.subTest(key=key, value=value):
                    props = self.emit({key: value})
                    self.assertEqual(props[key], value)
                    self.assertIs(type(props[key]), type(value))

    def test_invalid_backup_numbers_preserve_valid_sibling(self):
        invalid = ('123', True, False, None, float('nan'), float('inf'),
                   float('-inf'), 10**309)
        for key in ('sentBytes', 'dbBytes', 'stageAgeS'):
            for value in invalid:
                with self.subTest(key=key, value=value):
                    props = self.emit({key: value, 'exitCode': 0})
                    self.assertNotIn(key, props)
                    self.assertEqual(props['exitCode'], 0)
                    self.assertIs(type(props['exitCode']), int)


if __name__ == '__main__':
    unittest.main()

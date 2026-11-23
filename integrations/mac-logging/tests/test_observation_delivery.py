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


class ObservationDeliveryTests(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.root = Path(tmp.name)
        env = patch.dict(os.environ, TOOLLOG_DIR=tmp.name)
        env.start()
        self.addCleanup(env.stop)
        self.when = dt.datetime(2026,11,21,tzinfo=dt.timezone.utc)
        self.path = self.root/'2026-11-21.ndjson'
        self.identity = 'a'*32

    def emit(self):
        return toollog.emit('crashes','event','crash.observed',ok=True,
                            props=dict(count=1), now=self.when, dedup_id=self.identity)

    def rows(self):
        rows = []
        for line in self.path.read_text().splitlines():
            try:
                rows.append(json.loads(line))
            except ValueError:
                pass
        return rows

    def test_short_writes_are_completed_before_acknowledgement(self):
        write = os.write
        def short(fd, data):
            return write(fd, data[:7])
        with patch.object(toollog.os, 'write', side_effect=short):
            self.assertTrue(self.emit())
        self.assertTrue(self.emit())
        self.assertEqual(len(self.rows()), 1)
        self.assertEqual(self.rows()[0]['props']['count'], 1)

    def test_truncated_matching_identity_is_not_delivery_proof(self):
        partial = dict(name='crash.observed', props=dict(observationId=self.identity, count=1))
        self.path.write_text(json.dumps(partial, separators=(',',':'))[:-1])
        self.assertTrue(self.emit())
        self.assertTrue(self.emit())
        self.assertEqual(len(self.rows()), 1)
        self.assertEqual(self.rows()[0]['props']['count'], 1)

    def test_complete_record_without_newline_is_completed_without_duplicate(self):
        self.assertTrue(self.emit())
        self.path.write_bytes(self.path.read_bytes().rstrip(b'\n'))
        self.assertTrue(self.emit())
        self.assertEqual(len(self.rows()), 1)
        self.assertTrue(self.path.read_bytes().endswith(b'\n'))

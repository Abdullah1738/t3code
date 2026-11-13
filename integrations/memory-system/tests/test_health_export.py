"""Export health uses fixture metadata only; no production DB metadata is read."""
import json
from pathlib import Path
import sqlite3
import sys
import tempfile
import unittest
from datetime import datetime, timezone
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'src'))
import health_check as hc


class ExportHealthTests(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.root = Path(tmp.name)
        self.db = self.root / 'opencode.sqlite'
        self.now = 1_800_000_000.0
        for patch in (
            mock.patch.object(hc, 'OC_DB', str(self.db)),
            mock.patch.object(hc.time, 'time', return_value=self.now),
            mock.patch.object(hc, 'launchd_exit', return_value=('0', 1, True)),
            mock.patch.object(hc.robob_readonly, '_live_paths', return_value={self.root / 'live.db'}),
        ):
            patch.start()
            self.addCleanup(patch.stop)
        self.meta()

    def meta(self, **fields):
        values = {'ready': '1', 'history_ready': '1', 'generation': '2898',
                  'updated_at': self.stamp(self.now - 60), 'progress_at': str(self.now)}
        values.update(fields)
        with sqlite3.connect(self.db) as con:
            con.execute('CREATE TABLE IF NOT EXISTS ardud_readonly_meta(key TEXT PRIMARY KEY,value TEXT)')
            con.execute('DELETE FROM ardud_readonly_meta')
            con.executemany('INSERT INTO ardud_readonly_meta VALUES (?,?)', values.items())

    @staticmethod
    def stamp(at):
        return datetime.fromtimestamp(at, timezone.utc).isoformat()

    def test_readiness_timestamp_and_bootstrap_matrix(self):
        cases = [
            ('fresh', {}, True),
            ('stale', {'updated_at': self.stamp(self.now - 1801)}, False),
            ('boundary', {'updated_at': self.stamp(self.now - 1800)}, True),
            ('future', {'updated_at': self.stamp(self.now + 31)}, False),
            ('invalid', {'updated_at': 'garbage'}, False),
            ('naive', {'updated_at': '2026-11-12T12:00:00'}, False),
            ('missing timestamp', {'updated_at': ''}, False),
            ('normal cycle', {'ready': '0'}, True),
            ('dead unready', {'ready': '0', 'updated_at': self.stamp(self.now - 4 * 86400)}, False),
            ('missing readiness', {'ready': ''}, False),
            ('bootstrap', {'ready': '0', 'history_ready': '0', 'updated_at': ''}, True),
            ('first bootstrap', {'ready': '0', 'history_ready': None, 'updated_at': ''}, True),
            ('dead bootstrap', {'ready': '0', 'history_ready': '0', 'updated_at': '', 'progress_at': str(self.now - 301)}, False),
            ('untracked bootstrap', {'ready': '0', 'history_ready': '0', 'updated_at': '', 'progress_at': ''}, False),
            ('future bootstrap', {'ready': '0', 'history_ready': '0', 'updated_at': '', 'progress_at': str(self.now + 31)}, False),
            ('nan bootstrap', {'ready': '0', 'history_ready': '0', 'updated_at': '', 'progress_at': 'nan'}, False),
            ('infinite bootstrap', {'ready': '0', 'history_ready': '0', 'updated_at': '', 'progress_at': 'inf'}, False),
        ]
        for label, fields, expected in cases:
            with self.subTest(label=label):
                self.meta(**fields)
                actual, message = hc.check_opencode_export()
                self.assertEqual(actual, expected, message)

    def test_missing_agent_fails_before_database_access(self):
        with mock.patch.object(hc, 'launchd_exit', return_value=(None, 0, False)), \
                mock.patch.object(hc.robob_readonly, 'connect_ro') as connect:
            self.assertFalse(hc.check_opencode_export()[0])
            connect.assert_not_called()

    def test_health_status_and_existing_notification_path(self):
        self.meta(ready='0', updated_at=self.stamp(self.now - 4 * 86400))
        self.assertIn(('opencode_export', hc.check_opencode_export), hc.CHECKS)
        with mock.patch.object(hc, 'CHECKS', [('opencode_export', hc.check_opencode_export)]), \
                mock.patch.object(hc, 'STATE', str(self.root / 'state.json')), \
                mock.patch.object(hc, 'LAST', str(self.root / 'last.json')), \
                mock.patch.object(hc, 'LOGS', str(self.root)), \
                mock.patch.object(hc, 'notify', return_value=True) as notify, \
                mock.patch.object(sys, 'argv', ['health_check.py']):
            hc.main()
            status = json.loads((self.root / 'last.json').read_text())
            self.assertFalse(status['checks']['opencode_export']['ok'])
            self.assertIn('ready=0', status['checks']['opencode_export']['msg'])
            self.assertTrue(notify.called)


if __name__ == '__main__':
    unittest.main()

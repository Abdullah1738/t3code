import datetime as dt
import json
from pathlib import Path
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from rollup import rollup


class SupervisorRollupTests(unittest.TestCase):
    def test_counts_signals_and_unions_duplicate_outage_observations(self):
        day = '2026-11-16'
        start = dt.datetime(2026, 11, 16, tzinfo=dt.timezone.utc).timestamp() * 1000

        def row(name, seconds, props=None, worker='1'):
            return dict(tool='9router', component='supervisor', kind='event', name=name,
                        ts=dt.datetime.fromtimestamp(start / 1000 + seconds, dt.timezone.utc).isoformat(),
                        ids=dict(worker=worker, supervisor='99'), props=props or {})

        rows = [row('worker.unresponsive', 30, dict(missingSince=start + 5000)),
                row('supervisor.heartbeat', 60, dict(missingSince=start + 5000)),
                row('worker.crawling', 70), row('worker.memory_high', 80),
                row('worker.killed', 90, dict(reason='memory', missingSince=start + 5000)),
                row('worker.exited', 91, dict(signal='SIGKILL', code=None, missingSince=start + 5000)),
                row('worker.exited', 100, dict(signal=None, code=0), '2'),
                row('worker.unresponsive', 125, dict(missingSince=start + 100000), '3'),
                row('worker.recovered', 150, dict(missingSince=start + 100000), '3')]
        with tempfile.TemporaryDirectory() as root:
            (Path(root) / f'{day}.ndjson').write_text('\n'.join(map(json.dumps, rows)) + '\n')
            result = rollup(day, root)['supervisor']
        self.assertEqual(result['unresponsive'], 2)
        self.assertEqual(result['crawling'], 1)
        self.assertEqual(result['memoryHigh'], 1)
        self.assertEqual(result['killedByReason'], dict(memory=1))
        self.assertEqual(result['exitedBySignal'], dict(SIGKILL=1, none=1))
        self.assertEqual(result['exitedByCode'], {'0': 1})
        self.assertEqual(result['noHeartbeatMs'], 135000)
        self.assertEqual(result['openNoHeartbeatWorkers'], 0)

    def test_cross_midnight_gap_is_clipped_to_day_and_open_gap_is_observed_only(self):
        row = dict(tool='9router', component='supervisor', kind='event', name='supervisor.heartbeat',
                   ts='2026-11-16T00:00:20Z', ids=dict(supervisor='99', worker='1'),
                   props=dict(missingSince=dt.datetime(2026, 11, 15, 23, 59, tzinfo=dt.timezone.utc).timestamp() * 1000))
        with tempfile.TemporaryDirectory() as root:
            (Path(root) / '2026-11-16.ndjson').write_text(json.dumps(row) + '\n')
            result = rollup('2026-11-16', root)['supervisor']
        self.assertEqual(result['noHeartbeatMs'], 20000)
        self.assertEqual(result['openNoHeartbeatWorkers'], 1)


if __name__ == '__main__':
    unittest.main()

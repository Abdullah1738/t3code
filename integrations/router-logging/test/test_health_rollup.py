import json
from pathlib import Path
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from rollup import rollup


class HealthRollupTests(unittest.TestCase):
    def report(self, rows):
        with tempfile.TemporaryDirectory() as root:
            (Path(root) / '2026-11-17.ndjson').write_text('\n'.join(map(json.dumps, rows)) + '\n')
            return rollup('2026-11-17', root)['healthByHour']

    def row(self, name, at, **props):
        return dict(tool='9router', component='worker' if name == 'health.request.late' else 'supervisor',
                    kind='perf', name=name, ts=at, props=props)

    def test_hourly_late_distribution_and_exact_probe_matching_in_any_write_order(self):
        rows = [self.row('supervisor.health_probe', '2026-11-17T18:22:59Z', probe='abcdef01', totalMs=7900,
                         maxLagMsSinceLast=2200, lagMs=50, hbAgeMs=100, loopDelayP99Ms=500, loopDelayMaxMs=2300),
                self.row('health.request.late', '2026-11-17T18:22:58Z', probe='abcdef01', acceptToHandlerMs=6000, idleMs=0, loopLagAtAcceptMs=1500),
                self.row('health.request.late', '2026-11-17T18:25:00Z', acceptToHandlerMs=1500),
                self.row('health.request.late', '2026-11-17T18:26:00Z', acceptToHandlerMs=9000),
                self.row('health.request.late', '2026-11-17T19:00:01Z', acceptToHandlerMs=2000),
                self.row('supervisor.health_probe_summary', '2026-11-17T19:00:00Z', over5s=1)]
        for ordered in (rows, rows[::-1]):
            hours = self.report(ordered)
            self.assertEqual(len(hours), 2)
            self.assertEqual(hours[0]['acceptToHandlerMs'], dict(p50=6000, p95=9000, max=9000))
            self.assertEqual(hours[0]['lateRows'], 3)
            self.assertEqual(hours[0]['probesOver5s'], 1)
            self.assertEqual(hours[0]['probesWithLateRow'], 1)
            self.assertEqual(hours[0]['probes'][0]['acceptToHandlerMs'], 6000)
            self.assertEqual(hours[0]['probes'][0]['maxLagMsSinceLast'], 2200)
            self.assertEqual(hours[0]['probes'][0]['loopDelayP99Ms'], 500)
            self.assertEqual(hours[1]['acceptToHandlerMs']['max'], 2000)

    def test_timeout_can_match_a_later_handler_across_the_hour_boundary(self):
        hours = self.report([
            self.row('supervisor.health_probe', '2026-11-17T18:59:59Z', probe='abcdef01', totalMs=10000),
            self.row('health.request.late', '2026-11-17T19:00:01Z', probe='abcdef01', acceptToHandlerMs=12000)])
        self.assertEqual(hours[0]['probes'][0]['acceptToHandlerMs'], 12000)
        self.assertIsNone(hours[0]['probes'][0]['maxLagMsSinceLast'])

    def test_strict_deadline_and_missing_rows_remain_unknown_not_zero(self):
        hours = self.report([
            self.row('supervisor.health_probe', '2026-11-17T18:00:00Z', totalMs=5000),
            self.row('supervisor.health_probe', '2026-11-17T18:00:01Z', totalMs=5001, maxLagMsSinceLast=0),
            self.row('supervisor.health_probe', '2026-11-17T18:00:02Z', totalMs=8000, probe='ffffffff'),
            self.row('health.request.late', '2026-11-17T18:00:02Z', probe='abcdef01', acceptToHandlerMs=3000)])
        self.assertEqual(hours[0]['probesOver5s'], 2)
        self.assertEqual(hours[0]['probesWithLateRow'], 0)
        self.assertTrue(all(p['acceptToHandlerMs'] is None for p in hours[0]['probes']))
        self.assertEqual(hours[0]['probes'][0]['maxLagMsSinceLast'], 0)
        self.assertIsNone(hours[0]['probes'][1]['maxLagMsSinceLast'])

    def test_rejects_bad_measurements_and_normalizes_offsets(self):
        rows = [self.row('health.request.late', '2026-11-17T20:00:00+02:00', acceptToHandlerMs=1001)]
        for value in (True, -1, '6000', None, float('inf'), float('nan')):
            rows.append(self.row('health.request.late', '2026-11-17T18:00:00Z', acceptToHandlerMs=value))
            rows.append(self.row('supervisor.health_probe', '2026-11-17T18:00:00Z', totalMs=value))
        hours = self.report(rows)
        self.assertEqual(hours[0]['hour'], '2026-11-17T18:00:00Z')
        self.assertEqual(hours[0]['lateRows'], 1)
        self.assertEqual(hours[0]['probesOver5s'], 0)

    def test_midnight_joins_in_both_directions_do_not_change_daily_counts(self):
        cases = [
            ('2026-11-17T23:59:59Z', '2026-11-18', '2026-11-18T00:00:01Z', 12000),
            ('2026-11-17T00:00:01Z', '2026-11-16', '2026-11-16T23:59:59Z', 7000),
        ]
        for probe_at, neighbor, late_at, accept in cases:
            with self.subTest(probe_at=probe_at), tempfile.TemporaryDirectory() as root:
                rows = [self.row('supervisor.health_probe', probe_at, probe='abcdef01', totalMs=10000)]
                (Path(root) / '2026-11-17.ndjson').write_text('\n'.join(map(json.dumps, rows)) + '\n')
                late = [self.row('health.request.late', late_at, probe='abcdef01', acceptToHandlerMs=accept),
                        self.row('health.request.late', late_at, probe='ffffffff', acceptToHandlerMs=500000)]
                (Path(root) / f'{neighbor}.ndjson').write_text('bad json\n' + '\n'.join(map(json.dumps, late)) + '\n')
                report = rollup('2026-11-17', root)
                self.assertEqual(report['total'], 1)
                self.assertEqual(report['countsByName'], {'supervisor.health_probe': 1})
                self.assertEqual(report['healthByHour'][0]['lateRows'], 0)
                self.assertIsNone(report['healthByHour'][0]['acceptToHandlerMs'])
                self.assertEqual(report['healthByHour'][0]['probes'][0]['acceptToHandlerMs'], accept)

    def test_join_window_and_missing_adjacent_files(self):
        with tempfile.TemporaryDirectory() as root:
            probe = self.row('supervisor.health_probe', '2026-11-17T00:00:01Z', probe='abcdef01', totalMs=10000)
            (Path(root) / '2026-11-17.ndjson').write_text(json.dumps(probe) + '\n')
            self.assertEqual(rollup('2026-11-17', root)['healthByHour'][0]['probesWithLateRow'], 0)
            for seconds, expected in [('55:01', 1), ('55:00', 0)]:
                with self.subTest(seconds=seconds):
                    late = self.row('health.request.late', f'2026-11-16T23:{seconds}Z', probe='abcdef01', acceptToHandlerMs=7000)
                    (Path(root) / '2026-11-16.ndjson').write_text(json.dumps(late) + '\n')
                    self.assertEqual(rollup('2026-11-17', root)['healthByHour'][0]['probesWithLateRow'], expected)


if __name__ == '__main__':
    unittest.main()

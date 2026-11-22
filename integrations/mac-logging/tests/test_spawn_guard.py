import contextlib
import io
import json
from pathlib import Path
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from spawn_sample import Monitor, SpawnSampler
from spawn_schema import fields
import rollup
import status


class GuardTests(unittest.TestCase):
    def setUp(self):
        self.now = 0
        self.s = SpawnSampler(SimpleNamespace(), clock=lambda: self.now, cpu=lambda: 0)
        self.m = Monitor(self.s, clock=lambda: self.now, cpu=lambda: 0)

    def minute(self, cpu_pct=.5, wall_ms=600, threads_ms=10, samples=True):
        cadence = self.s.interval
        count = 60//cadence
        for i in range(count if samples else 0):
            action = self.s.record_cost(wall_ms/count/1000, cpu_pct*.6/count,
                                       thread_wall_ms=threads_ms, thread_limit=self.s.thread_limit)
            self.m.results.append(dict(at=self.now+i*cadence, births=1, exits=0, parents=[],
                baseline=False, partialReasons=[], wallMs=wall_ms/count, cpuMs=cpu_pct*600/count,
                intervalS=self.s.interval, births_cadence_s=cadence,
                phaseCosts=dict(threads=dict(wallMs=threads_ms, cpuMs=1)),
                guardActions=[action] if action else []))
        self.now += 60
        return self.m.report()

    def test_wall_only_minutes_never_degrade(self):
        for _ in range(12):
            p = self.minute(wall_ms=6000)
            self.assertGreaterEqual(p['wallMs'], 6000)
            self.assertEqual(p['guardActions'], [])
            self.assertEqual((p['threadLimit'], p['intervalS']), (300, 5))

    def test_cpu_minute_degrades_but_tick_cpu_spike_does_not(self):
        self.assertIsNone(self.s.record_cost(.8, .2))
        self.assertEqual(self.s.thread_limit, 300)
        self.assertEqual(self.minute(cpu_pct=2)['guardActions'], [])
        p = self.minute(cpu_pct=2.1)
        self.assertEqual(p['threadLimit'], 150)
        self.assertEqual(p['guardActions'][-1]['reason'], 'minute_cpu')

    def test_two_consecutive_blocked_ticks_and_reset(self):
        def tick(wall, thread_wall=50):
            return self.s.record_cost(wall, .01, thread_wall_ms=thread_wall,
                                      thread_limit=self.s.thread_limit)
        self.assertIsNone(tick(1.5))
        self.assertEqual(self.s.thread_limit, 300)
        self.assertIsNone(tick(.9))
        self.assertIsNone(tick(1.5))
        action = tick(1.5)
        self.assertEqual(action['reason'], 'tick_wall')
        self.assertEqual(self.s.thread_limit, 150)
        self.assertIsNone(tick(1.5, 20))
        self.assertEqual(tick(1.5, 20)['threadLimit'], 75)

    def test_halving_stops_when_thread_wall_does_not_drop(self):
        self.assertEqual(self.minute(cpu_pct=3, threads_ms=40)['threadLimit'], 150)
        p = self.minute(cpu_pct=3, threads_ms=40)
        self.assertEqual((p['threadLimit'], p['intervalS']), (150, 15))
        action = p['guardActions'][-1]
        self.assertEqual(action['limitNote'], 'threads_wall_not_reduced')
        self.assertEqual(action['previousThreadsWallMs'], 40)
        self.assertEqual(action['threadsWallMs'], 40)
        self.assertEqual(self.minute(cpu_pct=3, threads_ms=80)['threadLimit'], 150)

    def test_effective_halving_can_continue(self):
        self.minute(cpu_pct=3, threads_ms=40)
        self.assertEqual(self.minute(cpu_pct=3, threads_ms=10)['threadLimit'], 75)

    def test_rate_keeps_the_cadence_used_before_a_guard_transition(self):
        p = self.minute(cpu_pct=3)
        self.assertEqual(p['births_per_min'], 12)
        self.assertEqual(p['births_cadence_s'], 5)
        p = self.minute(cpu_pct=3)
        self.assertEqual(p['intervalS'], 15)
        self.assertEqual(p['births_cadence_s'], 5)
        self.assertEqual(self.minute()['births_cadence_s'], 15)

    def test_schema_keeps_the_reason_for_not_halving(self):
        self.minute(cpu_pct=3, threads_ms=40)
        p = self.minute(cpu_pct=3, threads_ms=40)
        self.assertEqual(fields(p)['guardActions'], p['guardActions'])

    def test_recovery_interval_first_then_doubling(self):
        self.s.thread_limit, self.s.interval = 1, 15
        for _ in range(4):
            self.assertEqual(self.minute()['guardActions'], [])
        p = self.minute()
        self.assertEqual((p['threadLimit'], p['intervalS']), (1, 5))
        self.assertEqual(p['births_cadence_s'], 15)
        self.assertEqual(p['guardActions'][-1]['reason'], 'recover')
        self.assertEqual(p['guardActions'][-1]['previousIntervalS'], 15)
        for limit in (2, 4, 8, 16, 32, 64, 128, 256, 300):
            p = self.minute()
            self.assertEqual((p['threadLimit'], p['intervalS']), (limit, 5))
            self.assertEqual(p['guardActions'][-1]['reason'], 'recover')
        self.assertEqual(self.minute()['guardActions'], [])

    def test_recovery_resets_on_noncalm_or_missing_minutes(self):
        for change in (dict(cpu_pct=1), dict(wall_ms=4000), dict(samples=False)):
            self.setUp()
            self.s.thread_limit, self.s.interval = 1, 15
            for _ in range(4):
                self.minute()
            self.minute(**change)
            self.assertEqual(self.minute()['guardActions'], [])
            self.assertEqual(self.s.interval, 15)

    def test_bad_minute_mid_recovery_degrades_again(self):
        self.s.thread_limit, self.s.interval = 1, 15
        for _ in range(7):
            self.minute()
        self.assertEqual(self.s.thread_limit, 4)
        p = self.minute(cpu_pct=3)
        self.assertEqual(p['guardActions'][-1]['reason'], 'minute_cpu')
        self.assertEqual(p['threadLimit'], 2)
        for _ in range(4):
            self.assertEqual(self.minute()['guardActions'], [])
        self.assertEqual(self.minute()['guardActions'][-1]['reason'], 'recover')

    def test_schema_status_rollup_keep_cadence_and_recover(self):
        self.s.thread_limit, self.s.interval = 1, 15
        for _ in range(5):
            p = self.minute()
        safe = fields(p)
        self.assertEqual(safe['guardActions'], p['guardActions'])
        self.assertEqual(safe['births_cadence_s'], 15)
        with tempfile.TemporaryDirectory() as root:
            row = dict(tool='mac', kind='event', name='host.spawn_sample',
                       ts='2026-11-22T00:05:00Z', ok=True, props=safe)
            Path(root, '2026-11-22.ndjson').write_text(json.dumps(row)+'\n')
            result = status.report('2026-11-22T00:06:00Z', root)
            self.assertEqual(result['spawnSample']['births_cadence_s'], 15)
            self.assertEqual(rollup.rollup('2026-11-22', root)['spawnSample']['births_cadence_s'], 15)
            out = io.StringIO()
            with patch.object(sys, 'argv', ['status.py']), patch.object(status, 'report', return_value=result), contextlib.redirect_stdout(out):
                status.main()
            self.assertIn('births/min @15s', out.getvalue())

    def test_mixed_cadence_is_explicit(self):
        self.m.results.extend(dict(at=i*5, births=1, exits=0, parents=[], baseline=False,
            partialReasons=[], wallMs=1, cpuMs=1, births_cadence_s=cadence)
            for i, cadence in enumerate((5, 15)))
        self.now = 16
        p = fields(self.m.report())
        self.assertIsNone(p['births_cadence_s'])
        self.assertEqual(p['births_cadences_s'], [5, 15])

    def test_any_active_tick_prevents_recovery(self):
        for age, finishes in ((None, False), (.5, False), (1.5, False), (.5, True)):
            with self.subTest(age=age, finishes=finishes):
                self.setUp()
                self.s.thread_limit, self.s.interval = 1, 15
                for _ in range(4):
                    self.minute()
                self.m.active = None if age is None else self.now+60-age
                if finishes:
                    calls = []
                    def cpu():
                        calls.append(1)
                        if len(calls) == 2:
                            self.m.active = None
                        return 0
                    self.m.cpu = cpu
                p = self.minute()
                self.assertEqual(bool(p['guardActions']), age is None)
                self.assertEqual(p['costIncomplete'], age is not None)
                self.assertEqual(fields(p)['costIncomplete'], age is not None)
                self.assertEqual('tick_in_flight' in fields(p)['partialReasons'], age is not None)

    def test_cadence_changes_while_sleeping_keep_the_scheduled_gap(self):
        for previous, new in ((5, 15), (15, 5), (5, 5), (15, 15)):
            with self.subTest(previous=previous, new=new):
                self.setUp()
                self.s.interval = previous
                def sample():
                    return dict(at=self.now, births=1, exits=0, parents=[], baseline=False,
                                partialReasons=[])
                def wait(delay):
                    self.now += delay
                    if len(self.m.results) == 1:
                        self.s.interval = new
                stop = SimpleNamespace(is_set=lambda: len(self.m.results) >= 3, wait=wait)
                with patch.object(self.s, '_tick', side_effect=sample):
                    self.m.loop(stop)
                self.assertEqual([r['births_cadence_s'] for r in self.m.results],
                                 [previous, previous, new])
                self.assertEqual(self.m.results[1]['at']-self.m.results[0]['at'], previous)
                p = fields(self.m.report())
                self.assertEqual(p['births_cadences_s'], sorted({previous, new}))


if __name__ == '__main__':
    unittest.main()

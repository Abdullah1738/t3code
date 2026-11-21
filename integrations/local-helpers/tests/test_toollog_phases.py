from datetime import datetime, timezone
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'libexec/toollog'))
import toollog

SECRET = 'PHASE-FIXTURE-SECRET'


class SlowHookPhases(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        env = patch.dict(os.environ, {'TOOLLOG_ROOT': self.tmp.name + '/logs'})
        env.start()
        self.addCleanup(env.stop)
        # A sampler that would drop every sampled row.
        sampling = patch.object(toollog.random, 'random', return_value=.99)
        sampling.start()
        self.addCleanup(sampling.stop)
        self.day = datetime.now(timezone.utc).strftime('%Y-%m-%d')

    def rows(self):
        return [row for row in toollog.read('agent-tools', self.day) if row.get('name') == 'hook.decision']

    def test_rollup_names_the_largest_phase_of_each_slow_row(self):
        cases = [('claude', 'identity_ms', {'identity_ms': 4400, 'guard_ms': 3, 'log_write_ms': 1}),
                 ('codex', 'classify_ms', {'classify_ms': 3010, 'identity_ms': 40}),
                 ('codex', 'lineage_ms', {'lineage_ms': 1500, 'identity_ms': 600}),
                 ('claude', 'live_db_ms', {'live_db_ms': 2600, 'guard_ms': 2}),
                 ('codex-cu', 'lock_wait_ms', {'lock_wait_ms': 2400, 'desktop_ms': 300}),
                 ('claude', 'log_write_ms', {'log_write_ms': 5000}),
                 ('claude', 'mask_ms', {'mask_ms': 2100.4}),
                 ('opencode', 'classify_ms', {'spawn_ms': 12, 'classify_ms': 2004}),
                 ('opencode', 'classify_ms', {'spawn_ms': 9, 'classify_ms': 272800}),
                 ('opencode', 'spawn_ms', {'spawn_ms': 2700, 'classify_ms': 2})]
        for harness, _, phases in cases:
            total = sum(phases.values()) + 50
            toollog.hook(harness, 'shell', 'allowed', 'no-policy', total, 'echo ' + SECRET, phases=phases)
        # Measured phases far below the total leave the remainder as the largest part.
        toollog.hook('claude', 'shell', 'allowed', 'no-policy', 9000, phases={'identity_ms': 10})
        # A row from a writer that records no phases.
        toollog.hook('opencode', 'statev2', 'allowed', 'no-policy', 2500)
        rows = self.rows()
        self.assertEqual(len(rows), len(cases) + 2)
        self.assertNotIn(SECRET, json.dumps(rows))
        table = toollog.rollup('agent-tools', self.day)['slowestPhaseByCount']
        self.assertEqual(table['thresholdMs'], 2000)
        by_total = {row['durationMs']: row['largestPhase'] for row in table['slowestRows']}
        for harness, phase, phases in cases:
            self.assertEqual(by_total[round(sum(phases.values()) + 50, 3)], phase, (harness, phases))
        self.assertEqual(by_total[9000], 'unmeasured')
        self.assertIsNone(by_total[2500])
        harnesses = table['byHarness']
        self.assertEqual(harnesses['opencode']['rows'], 4)
        self.assertEqual(harnesses['opencode']['unphasedRows'], 1)
        self.assertEqual(harnesses['opencode']['largestPhase'], {'classify_ms': 2, 'spawn_ms': 1})
        self.assertEqual(harnesses['opencode']['phases']['classify_ms'], {'count': 3, 'p95': 272800})
        self.assertEqual(harnesses['claude']['largestPhase'],
                         {'identity_ms': 1, 'live_db_ms': 1, 'log_write_ms': 1, 'mask_ms': 1, 'unmeasured': 1})
        self.assertEqual(harnesses['codex-cu']['phases']['lock_wait_ms'], {'count': 1, 'p95': 2400})
        self.assertEqual(table['slowestRows'][0]['phases']['classify_ms'], 272800)

    def test_rows_at_or_under_two_seconds_carry_no_phase_fields(self):
        with patch.object(toollog.random, 'random', return_value=0):
            for total in (5, 1999.9, 2000, 2000.0004):
                toollog.hook('claude', 'shell', 'allowed', 'no-policy', total, phases={'identity_ms': total})
            toollog.hook('claude', 'shell', 'denied', 'fixture', 1999, phases={'identity_ms': 1999})
        rows = self.rows()
        self.assertEqual(len(rows), 5)
        for row in rows:
            self.assertFalse(set(row['props']) & set(toollog.HOOK_PHASES), row)
        self.assertEqual(toollog.rollup('agent-tools', self.day)['slowestPhaseByCount']['byHarness'], {})

    def test_slow_rows_survive_the_sampler_and_the_daily_caps(self):
        with patch.object(toollog, 'HOOKS_CAP_BYTES', 1), patch.object(toollog, 'CAP_BYTES', 1):
            toollog.emit('hooks', 'perf', 'fixture.fill')
            for _ in range(3):
                toollog.hook('codex', 'shell', 'allowed', 'no-policy', 12, phases={'identity_ms': 11})
                toollog.hook('codex', 'shell', 'rewritten', 'no-policy', 2000.5, phases={'identity_ms': 2000})
        rows = self.rows()
        self.assertEqual([row['durationMs'] for row in rows], [2000.5] * 3)
        for row in rows:
            self.assertNotIn('sampleRate', row['props'])
            self.assertEqual(row['props']['identity_ms'], 2000)
        result = toollog.rollup('agent-tools', self.day)
        # Kept slow rows weigh 1, so totals are not inflated by the sample rate.
        self.assertEqual(result['countsByName']['hook.decision'], 3)
        self.assertEqual(result['slowestPhaseByCount']['byHarness']['codex']['rows'], 3)

    def test_phase_fields_take_only_known_names_and_non_negative_numbers(self):
        toollog.hook('claude', 'shell', 'allowed', 'no-policy', 3000, 'curl --token ' + SECRET, phases={
            'identity_ms': 2999.6, 'classify_ms': -1, 'guard_ms': float('nan'), 'mask_ms': SECRET,
            'cmd': SECRET, 'command_ms': 5, 'log_write_ms': True})
        row = self.rows()[0]
        self.assertEqual({key: row['props'][key] for key in toollog.HOOK_PHASES if key in row['props']},
                         {'identity_ms': 3000})
        self.assertNotIn(SECRET, json.dumps(row))
        self.assertNotIn('cmd', row['props'])


if __name__ == '__main__':
    unittest.main()

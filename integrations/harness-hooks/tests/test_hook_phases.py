if __package__:
    from . import test_environment
else:
    import test_environment

from datetime import datetime, timezone
import fcntl
import json
import os
from pathlib import Path
import sys
import tempfile
import time
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'src'))
import desktop_lease
import engine

SECRET = 'PHASE-FIXTURE-SECRET'


class Clock:
    """Real monotonic time plus whatever a patched step says it spent."""

    def __init__(self):
        self.real = time.monotonic
        self.offset = 0.0

    def __call__(self):
        return self.real() + self.offset

    def spend(self, ms, result=None):
        def step(*args, **kwargs):
            self.offset += ms / 1000
            return result() if callable(result) else result
        return step


class HookPhases(unittest.TestCase):
    def setUp(self):
        sampling = patch.object(engine.toollog.random, 'random', return_value=0)
        sampling.start()
        self.addCleanup(sampling.stop)
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        env = patch.dict(os.environ, {'TOOLLOG_ROOT': self.temp.name + '/logs',
                                      'HARNESS_HOOKS_STATE_DIR': self.temp.name + '/state',
                                      'OFFBOX_STATE_DIR': self.temp.name + '/offbox',
                                      'OFFBOX_GATE_MODE': 'off'})
        env.start()
        self.addCleanup(env.stop)
        self.clock = Clock()
        clock = patch.object(engine.time, 'monotonic', self.clock)
        clock.start()
        self.addCleanup(clock.stop)

    def rows(self):
        return [json.loads(line) for path in Path(self.temp.name, 'logs/agent-tools').glob('*.ndjson')
                for line in path.read_text().splitlines()]

    def decision(self):
        rows = [row for row in self.rows() if row['name'] == 'hook.decision']
        self.assertEqual(len(rows), 1, rows)
        return rows[0]

    def bash(self, **extra):
        return {'hook_event_name': 'PreToolUse', 'tool_name': 'Bash', 'cwd': self.temp.name,
                'tool_input': {'command': 'echo ' + SECRET}, **extra}

    def assert_largest(self, row, phase, ms):
        props = row['props']
        self.assertGreater(row['durationMs'], 2000)
        self.assertNotIn('sampleRate', props)
        self.assertIsInstance(props[phase], int)
        self.assertGreaterEqual(props[phase], ms)
        self.assertLess(props[phase], ms + 1000)
        others = {key: props[key] for key in engine.toollog.HOOK_PHASES if key in props and key != phase}
        self.assertTrue(all(value < 1000 for value in others.values()), others)
        self.assertNotIn(SECRET, json.dumps(row))
        day = datetime.now(timezone.utc).strftime('%Y-%m-%d')
        table = engine.toollog.rollup('agent-tools', day)['slowestPhaseByCount']
        self.assertEqual(table['slowestRows'][0]['largestPhase'], phase)
        harness = row['props']['harness']
        self.assertEqual(table['byHarness'][harness]['largestPhase'], {phase: 1})

    def test_identity_lookup(self):
        identity = {'resolution': 'resolved', 'robobThreadId': 'thread-fixture', 'identity_source': 'control'}
        with patch.object(engine, 'resolve_identity', self.clock.spend(2600, identity)):
            engine.decide(self.bash(session_id='native-fixture'), 'claude')
        self.assert_largest(self.decision(), 'identity_ms', 2600)

    def test_offbox_classifier(self):
        with patch.dict(os.environ, {'OFFBOX_GATE_MODE': 'observe'}), \
                patch.object(engine, '_classify_offbox', self.clock.spend(3100, {'heavy': False})):
            engine.decide(self.bash(), 'codex')
        self.assert_largest(self.decision(), 'classify_ms', 3100)

    def test_lineage_walk(self):
        offbox = Path(self.temp.name, 'offbox')
        offbox.mkdir()
        (offbox / 'exemptions.json').write_text(json.dumps([{'thread_id': 'parent-fixture'}]))
        binary = offbox / 'offbox'
        binary.touch()
        identity = {'resolution': 'resolved', 'robobThreadId': 'thread-fixture', 'identity_source': 'cache'}
        verdict = {'heavy': True, 'why': 'fixture', 'rule': 'go-test', 'rewrite': 'offbox run -- fixture'}
        with patch.dict(os.environ, {'OFFBOX_GATE_MODE': 'enforce', 'HARNESS_HOOKS_OFFBOX_BIN': str(binary)}), \
                patch.object(engine, 'resolve_identity', return_value=identity), \
                patch.object(engine, '_classify_offbox', return_value=verdict), \
                patch.object(engine, '_lineage', self.clock.spend(2400, [{'threadId': 'parent-fixture'}])):
            result = engine.decide(self.bash(session_id='native-fixture'), 'claude')
        self.assertEqual(result['context']['rule'], 'offbox-exempt')
        self.assert_largest(self.decision(), 'lineage_ms', 2400)

    def test_live_database_guard(self):
        with patch.object(engine.statev2_guard, 'classify_detail', self.clock.spend(2500, (None, None))):
            engine.decide(self.bash(), 'claude')
        self.assert_largest(self.decision(), 'live_db_ms', 2500)

    def test_offbox_payload_scan_is_split_from_the_database_check(self):
        real = engine.statev2_guard.scripts_in
        nested = []

        def scripts_in(command, cwd, **kwargs):
            # Only scan_remote's recursive call passes a depth; the top-level check does not.
            if kwargs.get('_depth', 0) > 0:
                nested.append(kwargs['_depth'])
                self.clock.offset += 2.7
            return real(command, cwd, **kwargs)
        with patch.object(engine.statev2_guard, 'scripts_in', scripts_in):
            result = engine.decide(self.bash(tool_input={'command': "offbox run --step 'echo " + SECRET + "'"}), 'claude')
        self.assertEqual(result['decision'], 'allow')
        self.assertTrue(nested)
        row = self.decision()
        self.assert_largest(row, 'remote_scan_ms', 2700)
        self.assertLess(row['props']['live_db_ms'], 500)

    def test_nested_remote_scans_are_timed_once(self):
        real = engine.statev2_guard.scripts_in
        depths = []

        def scripts_in(command, cwd, **kwargs):
            if kwargs.get('_depth', 0) > 0:
                depths.append(kwargs['_depth'])
                self.clock.offset += 1.2
            return real(command, cwd, **kwargs)
        command = "offbox run --step \"offbox run --step 'echo nested'\""
        with patch.object(engine.statev2_guard, 'scripts_in', scripts_in):
            engine.decide(self.bash(tool_input={'command': command}), 'claude')
        self.assertGreaterEqual(len(depths), 2)
        props = self.decision()['props']
        # Each nested scan's time sits inside the outermost one, so the total is the clock's, not double.
        self.assertGreaterEqual(props['remote_scan_ms'], 1200 * len(depths))
        self.assertLess(props['remote_scan_ms'], 1200 * len(depths) + 500)

    def test_local_guard_parsers(self):
        with patch.object(engine.rootwide_search_guard, 'classify', self.clock.spend(2200, None)):
            engine.decide(self.bash(), 'claude')
        self.assert_largest(self.decision(), 'guard_ms', 2200)

    def test_desktop_lock_wait_is_split_from_the_lease_call(self):
        def admit(*args, **kwargs):
            desktop_lease.lock_wait_ms += 2700
            self.clock.offset += 2.8
            return 'allow', '', 'desktop-read-only', None
        with patch.object(engine.desktop_lease, 'admit', admit):
            engine.decide({'hook_event_name': 'PreToolUse', 'tool_name': desktop_lease.NODE_REPL,
                           'session_id': 'native-fixture', 'tool_input': {}}, 'codex')
        row = self.decision()
        self.assert_largest(row, 'lock_wait_ms', 2700)
        self.assertLess(row['props']['desktop_ms'], 200)

    def test_card_mask(self):
        with patch.object(engine.card_mask, 'mask_value', self.clock.spend(2300, ('masked', True))):
            engine.decide({'hook_event_name': 'PostToolUse', 'tool_name': 'Bash', 'tool_response': 'x'}, 'claude')
        self.assert_largest(self.decision(), 'mask_ms', 2300)

    def test_side_log_write(self):
        phone = {'matched': True, 'reason': None, 'rule': 'phone-adb-state', 'error': None, 'holder': None, 'adbVerb': None}
        real_log = engine._log

        def slow_log(**record):
            if record.get('rule') == 'phone-adb-state':
                self.clock.offset += 2.9
            return real_log(**record)
        with patch.object(engine.phone_adb_guard, 'classify', return_value=phone), \
                patch.object(engine, '_log', slow_log):
            engine.decide(self.bash(), 'claude')
        rows = [row for row in self.rows() if row['props'].get('rule') != 'phone-adb-state']
        self.assertEqual(len(rows), 1)
        self.assertGreaterEqual(rows[0]['props']['log_write_ms'], 2900)

    def test_fast_rows_carry_no_phases(self):
        with patch.dict(os.environ, {'OFFBOX_GATE_MODE': 'observe'}), \
                patch.object(engine, '_classify_offbox', self.clock.spend(1900, {'heavy': False})):
            engine.decide(self.bash(), 'codex')
        props = self.decision()['props']
        self.assertFalse(set(props) & set(engine.toollog.HOOK_PHASES), props)
        self.assertEqual(props['sampleRate'], engine.toollog.HOOK_SAMPLE_RATE)

    def test_real_lock_contention_is_measured(self):
        state = Path(self.temp.name, 'state')
        path = desktop_lease._pending_file(state, 'native-fixture')
        path.parent.mkdir(parents=True)
        holder = os.open(path.with_suffix('.lock'), os.O_RDWR | os.O_CREAT, 0o600)
        self.addCleanup(os.close, holder)
        fcntl.flock(holder, fcntl.LOCK_EX)
        before = desktop_lease.lock_wait_ms
        with patch.object(desktop_lease, 'PENDING_LOCK_WAIT', 0.05):
            self.assertEqual(desktop_lease._pending_update(state, 'native-fixture', add='call-fixture'), {})
        self.assertGreaterEqual(desktop_lease.lock_wait_ms - before, 50)


if __name__ == '__main__':
    unittest.main()

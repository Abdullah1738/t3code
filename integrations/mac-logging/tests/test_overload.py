import copy
import json
import os
from pathlib import Path
import queue
import socket
import subprocess
import sys
import tempfile
import threading
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

HERE = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(HERE))
import host
import overload as o
from overload_io import Dispatcher, load, save, launch
from overload_notify import attempt
from replay_overload import replay, day_rows, legacy, csv_rows, timestamp
from toollog import safe_fields

NORMAL = dict(load=[20, 20, 20], ncpu=16, swapUsedBytes=100, swapTotalBytes=1000,
              freePages=100000, pressureLevel=1)
BAD = dict(swap=dict(swapUsedBytes=800, freePages=39999),
           pressure=dict(pressureLevel=2), load=dict(load=[160, 160, 160]))


def feed(state, values, start, end):
    actions = []
    for now in range(start, end+1, 30):
        state, emitted = o.evaluate(state, values, now)
        actions.extend(emitted)
    return state, actions


class EvaluationTests(unittest.TestCase):
    def test_condition_windows_and_purity(self):
        for condition, changes in BAD.items():
            with self.subTest(condition=condition):
                values = dict(NORMAL, **changes)
                state, actions = feed({}, values, 0, o.HOLD[condition]-30)
                self.assertFalse(actions)
                original = copy.deepcopy(state)
                newer, actions = o.evaluate(state, values, o.HOLD[condition])
                self.assertEqual(state, original)
                self.assertEqual(actions[0]['event']['conditions'], [condition])
                self.assertEqual(actions[0]['event']['phase'], 'onset')
                self.assertEqual(actions[0]['notify']['severity'], 'attention')

    def test_boundaries_unknown_and_invalid(self):
        for values in ({}, {'errors':['swap']}, dict(NORMAL, swapTotalBytes=0),
                       dict(NORMAL, freePages=40000, swapUsedBytes=800),
                       dict(NORMAL, pressureLevel=None, load=None),
                       dict(NORMAL, pressureLevel=float('nan')), dict(NORMAL, ncpu=0)):
            with self.subTest(values=values):
                state, actions = feed({}, values, 0, 1200)
                self.assertFalse(actions)
        state, _ = feed({}, dict(NORMAL, pressureLevel=2), 0, 270)
        state, actions = o.evaluate(state, {}, 300)
        self.assertFalse(actions)
        self.assertNotIn('pressure', state['held'])

    def test_peak_clear_recovery_and_unknown(self):
        state, _ = feed({}, dict(NORMAL, pressureLevel=2), 0, o.HOLD['pressure'])
        onset = state['episode']['onset']
        state, actions = o.evaluate(state, dict(NORMAL, pressureLevel=4), onset+30)
        self.assertFalse(actions)
        state, actions = feed(state, dict(NORMAL, pressureLevel=4), int(onset)+60, int(onset)+600)
        self.assertEqual([a['event']['phase'] for a in actions], ['peak'])
        self.assertEqual(actions[0]['event']['peak']['pressureLevel'], 4)
        state, actions = feed(state, NORMAL, int(onset)+630, int(onset)+1200)
        self.assertFalse(actions)
        state, actions = o.evaluate(state, {}, onset+1230)
        self.assertFalse(actions)
        state, actions = feed(state, NORMAL, int(onset)+1260, int(onset)+1860)
        self.assertEqual([a['event']['phase'] for a in actions], ['end'])
        self.assertEqual(actions[0]['notify']['severity'], 'info')
        self.assertIn('peak load', actions[0]['notify']['text'])

    def test_cooldown_both_onset_and_end(self):
        state, _ = feed({}, dict(NORMAL, pressureLevel=2), 0, o.HOLD['pressure'])
        end = o.HOLD['pressure']+630
        state, actions = feed(state, NORMAL, o.HOLD['pressure']+30, end)
        self.assertEqual(actions[-1]['event']['phase'], 'end')
        state, actions = feed(state, dict(NORMAL, pressureLevel=2), end+30, end+30+o.HOLD['pressure'])
        self.assertEqual(actions[-1]['event']['phase'], 'onset')
        self.assertNotIn('notify', actions[-1])
        state, _ = feed(state, NORMAL, end+60+o.HOLD['pressure'], end+660+o.HOLD['pressure'])
        last_end = int(state['lastEnd'])
        state, _ = feed(state, NORMAL, last_end+30, last_end+3600)
        state, actions = feed(state, dict(NORMAL, pressureLevel=2), last_end+3630, last_end+3630+o.HOLD['pressure'])
        self.assertIn('notify', actions[-1])

    def test_self_lag_two_gaps_and_expiry(self):
        state, _ = o.evaluate({}, NORMAL, 0)
        state, actions = o.evaluate(state, NORMAL, 90)
        self.assertFalse(actions)
        state, actions = o.evaluate(state, NORMAL, 180)
        self.assertEqual(actions[0]['event']['conditions'], ['self-lag'])
        self.assertEqual(state['episode']['onset'], 180)
        state, actions = feed({}, NORMAL, 0, 60)
        state, _ = o.evaluate(state, NORMAL, 150)
        state, _ = feed(state, NORMAL, 180, 480)
        state, actions = o.evaluate(state, NORMAL, 570)
        self.assertFalse(actions)

    def test_bad_or_backwards_time(self):
        state, _ = o.evaluate({}, NORMAL, 100)
        for now in (99, 100, float('nan')):
            self.assertEqual(o.evaluate(state, NORMAL, now), (state, []))

    def test_event_schema(self):
        values = dict(NORMAL, pressureLevel=2, families=[dict(name='python',count=123)])
        _, actions = feed({}, values, 0, o.HOLD['pressure'])
        result = safe_fields(actions[-1]['event'], 'host.overload')
        self.assertEqual(result['conditions'], ['pressure'])
        self.assertEqual(result['families'], [dict(name='python',count=123)])
        self.assertEqual(result['peak']['pressureLevel'], 2)
        self.assertEqual(result['swapUsedMb'], 100/2**20)


class NotificationTests(unittest.TestCase):
    def test_persist_retry_identical_then_accept_and_restart(self):
        with tempfile.TemporaryDirectory() as directory:
            seen = []
            def sender(argv, **options):
                seen.append(argv)
                self.assertEqual(options['timeout'], 20)
                self.assertEqual(options['env']['BUN_INSPECT'], '')
                self.assertEqual(os.stat(payload).st_mode & 0o777, 0o600)
                durable = load(dispatch.path, {})
                self.assertEqual(durable['outbox'][0]['notify'], load(payload, {}))
                if len(seen)<3:
                    raise subprocess.TimeoutExpired(argv, 20)
                return SimpleNamespace(stdout=json.dumps(dict(id='notify:'+'a'*64)))
            def launcher(path, accepted):
                nonlocal payload, receipt
                payload, receipt = path, accepted
                try:
                    attempt(path, accepted, sender)
                except subprocess.SubprocessError:
                    pass
                return SimpleNamespace(poll=lambda: 0)
            payload = receipt = None
            dispatch = Dispatcher(lambda *_: True, directory, launcher)
            state, actions = feed({}, dict(NORMAL, pressureLevel=2), 0, o.HOLD['pressure'])
            dispatch.process(state, actions)
            dispatch.process(state, [])
            dispatch.process(state, [])
            self.assertEqual(len(seen), 3)
            self.assertEqual(seen[0], seen[1]); self.assertEqual(seen[1], seen[2])
            self.assertEqual(load(receipt, {})['key'], actions[0]['notify']['key'])
            newer = Dispatcher(lambda *_: True, directory, launcher)
            newer.process(state, [])
            self.assertEqual(len(seen), 3)
            self.assertEqual(newer.durable['outbox'], [])

    def test_tick_never_touches_io_or_waits_for_child(self):
        with tempfile.TemporaryDirectory() as directory:
            writer, launcher = Mock(), Mock()
            dispatch = Dispatcher(writer, directory, launcher)
            dispatch.child = SimpleNamespace(poll=Mock(side_effect=AssertionError('polled in tick')))
            with patch('overload_io.save', side_effect=AssertionError('saved in tick')):
                for now in range(0, o.HOLD['pressure']+1, 30):
                    dispatch.tick(dict(NORMAL, pressureLevel=2), now)
            writer.assert_not_called(); launcher.assert_not_called()
            self.assertFalse(dispatch.queue.empty())

    def test_persist_failure_cannot_launch_and_recovers(self):
        with tempfile.TemporaryDirectory() as directory:
            launcher = Mock(return_value=SimpleNamespace(poll=lambda: 0))
            dispatch = Dispatcher(lambda *_: True, directory, launcher)
            state, actions = feed({}, dict(NORMAL, pressureLevel=2), 0, o.HOLD['pressure'])
            with patch('overload_io.save', side_effect=OSError('disk unavailable')):
                with self.assertRaises(OSError):
                    dispatch.process(state, actions)
            launcher.assert_not_called()
            dispatch.process(state, [])
            launcher.assert_called_once()

    def test_detached_child_and_invalid_ack(self):
        with patch('overload_io.subprocess.Popen') as spawn:
            launch(Path('/a.pending.json'), Path('/a.accepted.json'))
        self.assertTrue(spawn.call_args.kwargs['start_new_session'])
        self.assertEqual(spawn.call_args.kwargs['stdin'], subprocess.DEVNULL)
        with tempfile.TemporaryDirectory() as d:
            payload, receipt = Path(d)/'pending.json', Path(d)/'accepted.json'
            save(payload, dict(key='key',text='text',severity='info'))
            with self.assertRaises(ValueError):
                attempt(payload, receipt, lambda *_a, **_k: SimpleNamespace(stdout='{"id":"wrong"}'))
            self.assertFalse(receipt.exists())

class ReplayTests(unittest.TestCase):
    def test_failed_probe_input_class_invalidates_cache(self):
        baseline = dict(load=[20, 20, 20], ncpu=16, pressureLevel=1,
                        swap=dict(usedMb=100,totalMb=1000), vm=dict(freePages=100000))
        cases = [
            ('swap absent', dict(swap=dict(usedMb=800,totalMb=1000),vm=dict(freePages=10)), 'swap', {}, ['swapUsedBytes','swapTotalBytes']),
            ('swap null', dict(swap=dict(usedMb=800,totalMb=1000),vm=dict(freePages=10)), 'swap', {'swap':None}, ['swapUsedBytes','swapTotalBytes']),
            ('swap partial used', dict(swap=dict(usedMb=800,totalMb=1000),vm=dict(freePages=10)), 'swap', {'swap':{'totalMb':1000}}, ['swapUsedBytes']),
            ('swap partial total', dict(swap=dict(usedMb=800,totalMb=1000),vm=dict(freePages=10)), 'swap', {'swap':{'usedMb':800}}, ['swapTotalBytes']),
            ('swap error with old value', dict(swap=dict(usedMb=800,totalMb=1000),vm=dict(freePages=10)), 'swap', {'swapError':'timeout'}, ['swapUsedBytes','swapTotalBytes']),
            ('swap invalid number', dict(swap=dict(usedMb=800,totalMb=1000),vm=dict(freePages=10)), 'swap', {'swap':{'usedMb':'800','totalMb':1000}}, ['swapUsedBytes']),
            ('VM absent', dict(swap=dict(usedMb=800,totalMb=1000),vm=dict(freePages=10)), 'vm', {}, ['freePages']),
            ('VM null', dict(swap=dict(usedMb=800,totalMb=1000),vm=dict(freePages=10)), 'vm', {'vm':None}, ['freePages']),
            ('VM partial', dict(swap=dict(usedMb=800,totalMb=1000),vm=dict(freePages=10)), 'vm', {'vm':{}}, ['freePages']),
            ('VM invalid number', dict(swap=dict(usedMb=800,totalMb=1000),vm=dict(freePages=10)), 'vm', {'vm':{'freePages':'10'}}, ['freePages']),
            ('VM error with old value', dict(swap=dict(usedMb=800,totalMb=1000),vm=dict(freePages=10)), 'vm', {'vmError':'timeout'}, ['freePages']),
            ('pressure absent', dict(pressureLevel=2), 'pressureLevel', {}, ['pressureLevel']),
            ('pressure null', dict(pressureLevel=2), 'pressureLevel', {'pressureLevel':None}, ['pressureLevel']),
            ('pressure invalid number', dict(pressureLevel=2), 'pressureLevel', {'pressureLevel':'2'}, ['pressureLevel']),
            ('pressure error with old value', dict(pressureLevel=2), 'pressureLevel', {'pressureLevelError':'timeout'}, ['pressureLevel']),
            ('load absent', dict(load=[200,200,200]), 'load', {}, ['load']),
            ('load null', dict(load=[200,200,200]), 'load', {'load':None}, ['load']),
            ('load invalid number', dict(load=[200,200,200]), 'load', {'load':[float('nan'),200,200]}, ['load']),
            ('load invalid shape', dict(load=[200,200,200]), 'load', {'load':[200]}, ['load']),
            ('load error with old value', dict(load=[200,200,200]), 'load', {'loadError':'unavailable'}, ['load']),
        ]
        for form, changes, probe, failed, invalidated in cases:
            with self.subTest(form=form):
                bad = dict(baseline, **changes)
                props = dict(bad)
                if probe+'Error' not in failed:
                    props.pop(probe, None)
                props.update(failed)
                def row(at, values):
                    return legacy(dict(name='memory.sample',ts=o.iso(at),props=values))
                hold = 600 if probe == 'load' else 300
                rows = [row(0,bad)]
                if hold == 600:
                    rows.append(row(300,bad))
                failure = row(hold-30,props)
                for field in invalidated:
                    self.assertIsNone(failure[1][field])
                rows.append(failure)
                self.assertEqual(replay(rows,finish=hold+30)['onsets'], [])
        # CPU errors invalidate only CPU-owned data; memory values expire on
        # their own clock rather than disappearing at every CPU-only sample.
        _, values = legacy(dict(name='cpu.sample',ts=o.iso(270),props={}))
        self.assertEqual(values, {'load':None})

    def test_csv_blank_snapshot_invalidates_cache(self):
        with tempfile.TemporaryDirectory() as root:
            path = Path(root)/'timeline.csv'
            path.write_text('bucket,load1Max,swapUsedMb,swapTotalMb,freePages,pressureLevel\n'
                            '2026-11-19T00:00:00Z,20,800,1000,10,1\n'
                            '2026-11-19T00:04:30Z,20,,,,1\n')
            self.assertEqual(replay(csv_rows(path),finish=timestamp('2026-11-19T00:05:30Z'))['onsets'], [])

    def test_trimmed_real_rows(self):
        fixture = HERE/'tests/fixtures/overload-1119.ndjson'
        result = replay(day_rows([fixture]))
        self.assertEqual(result['rows'], 32)
        self.assertEqual([(r['at'], r['conditions']) for r in result['onsets']],
                         [('2026-11-19T08:03:53.834Z', ['pressure'])])
        self.assertFalse(any('self-lag' in r['conditions'] for r in result['transitions']))

class IntegrationTests(unittest.TestCase):
    def test_blocked_notification_writer_does_not_stop_sampler(self):
        with tempfile.TemporaryDirectory() as directory:
            entered, release, second = threading.Event(), threading.Event(), threading.Event()
            def blocked_writer(*_):
                entered.set(); release.wait(2); return True
            dispatch = Dispatcher(blocked_writer, directory, Mock())
            state, actions = feed({}, dict(NORMAL, pressureLevel=2), 0, o.HOLD['pressure'])
            worker = threading.Thread(target=dispatch.process,args=(state,actions))
            worker.start()
            self.assertTrue(entered.wait(1))
            server = socket.socket(socket.AF_UNIX, socket.SOCK_DGRAM)
            server.bind(str(Path(directory)/'host.sock')); server.setblocking(False)
            stop = threading.Event()
            count = [0]
            def writer(*_):
                count[0] += 1
                if count[0] >= 2:
                    second.set(); stop.set()
            sample = SimpleNamespace(tick=lambda: NORMAL)
            thread = threading.Thread(target=host.serve,args=(sample,server,stop),
                kwargs=dict(interval=.01,duration=.1,writer=writer,overload=dispatch))
            try:
                with patch('subprocess.Popen',side_effect=AssertionError('spawned in sampler')):
                    thread.start()
                    self.assertTrue(second.wait(1))
                    self.assertTrue(worker.is_alive())
                    thread.join(1)
            finally:
                release.set(); worker.join(1); server.close()
            self.assertFalse(thread.is_alive())


if __name__ == "__main__":
    unittest.main()

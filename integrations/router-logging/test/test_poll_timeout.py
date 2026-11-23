import datetime as dt
import errno
import json
import os
from pathlib import Path
import select
import socket
import sys
import tempfile
import time
from types import SimpleNamespace
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import causes
import guard
import observer
import rollup
import toollog

NOW = dt.datetime(2026, 11, 22, 23, tzinfo=dt.timezone.utc)
HOST = dict(l1=230, c=16, p=2)


def finished(name='history_scan_parse', step=None, **changes):
    data = dict(p=name, ms=1000.125, cpu=100.125)
    if step:
        data['s'] = step
    else:
        data.update(ib=2, mf=3, iv=4, v=5)
    if name in causes.BYTE_PHASES:
        data.update(bh=123456, bp=23456)
    data.update(changes)
    return b'=' + json.dumps(data, separators=(',', ':')).encode()


class TimeoutRollupTests(unittest.TestCase):
    def row(self, **changes):
        start = NOW.timestamp() * 1000 - 243112
        props = dict(pid=42, phase='listener_history', wallMs=243112, cpuMs=5322,
                     startedAtMs=start, finishedAtMs=NOW.timestamp() * 1000)
        props.update(changes)
        return dict(tool='9router', component='poller', name='poll.timeout',
                    ts=observer.iso(props['finishedAtMs']), durationMs=243112, props=props)

    def test_legacy_timeout_uses_recorded_phase_and_cpu(self):
        cases = [('listener_history', 243112, 5322, 'starved'),
                 ('snapshot', 243343, 3833, 'starved'),
                 ('history_scan_parse', 241428, 16966, 'starved'),
                 ('history_scan_parse', 241323, 16382, 'starved'),
                 ('listener_history', 240951, 10508, 'starved'),
                 ('snapshot', 240000, 24000, 'blocked'),
                 ('snapshot', 240000, 200000, 'blocked')]
        for phase, wall, cpu, cause in cases:
            with self.subTest(phase=phase, cpu=cpu):
                row = self.row(phase=phase, wallMs=wall, cpuMs=cpu)
                gap = observer.gap_summary([row], '2026-11-22', NOW)['pollGaps'][0]
                self.assertEqual(gap['phase'], phase)
                self.assertEqual(gap['phaseMs'], wall)
                self.assertEqual(gap['wallMs'], wall)
                self.assertEqual(gap['cpuMs'], cpu)
                self.assertEqual(gap['cause'], 'tick_' + cause + ':' + phase)
                self.assertTrue(gap['timedOut'])
                self.assertEqual(gap['causeEvidenceField'], 'poll.timeout')
                self.assertEqual(gap['causeEvidenceValue'], wall)
                self.assertNotIn('missingEvidence', gap)

    def test_timeout_fallback_leaves_other_gap_rows_unchanged(self):
        for name in ('poll.phases', 'rollup.phases', 'observer.gap', 'guard.tick_late'):
            with self.subTest(name=name):
                row = self.row()
                row['name'] = name
                key = 'pollGaps'
                if name == 'guard.tick_late':
                    row['component'], key = 'guard', 'guardGaps'
                self.assertEqual(observer.gap_summary([row], '2026-11-22', NOW)[key], [dict(
                    number=1, start=observer.iso(row['props']['startedAtMs']), end=observer.iso(NOW.timestamp() * 1000),
                    component=row['component'], durationMs=243112,
                    cause='unknown_no_data', missingEvidence='tick_phase_durations')])

    def test_invalid_legacy_phase_or_wall_does_not_infer_a_cause(self):
        for changes in ({'phase': value} for value in ('other', 'none', 'new_phase', None, [])):
            row = self.row(**changes)
            gap = observer.gap_summary([row], '2026-11-22', NOW)['pollGaps'][0]
            self.assertEqual(gap['cause'], 'unknown_no_data')
        for wall in (0, -1, None, True, '243112', float('nan'), float('inf')):
            with self.subTest(wall=wall):
                row = self.row(wallMs=wall)
                gap = observer.gap_summary([row], '2026-11-22', NOW)['pollGaps'][0]
                self.assertEqual(gap['cause'], 'unknown_no_data')

    def test_legacy_timeout_full_and_cached_rollups_agree(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / '2026-11-22.ndjson').write_text(json.dumps(self.row()) + '\n')
            full = rollup.rollup('2026-11-22', root, NOW, incremental=False)
            self.assertEqual(full['pollGapsByCause'], [dict(
                cause='tick_starved:listener_history', count=1, durationMs=243112)])
            self.assertEqual(full, rollup.rollup('2026-11-22', root, NOW))
            self.assertEqual(full, rollup.rollup('2026-11-22', root, NOW))


class TimeoutTests(unittest.TestCase):
    def child(self, payload):
        script = ('import os,signal\n'
                  'os.write(int(os.environ["ROUTER_POLL_PROGRESS_FD"]),' + repr(payload) + ')\n'
                  'signal.pause()\n')
        child = guard.PollChild([sys.executable, '-I', '-c', script])
        self.addCleanup(child.stop)
        self.assertTrue(select.select([child.reader], [], [], 10)[0])
        return child

    def parser(self):
        child = guard.PollChild.__new__(guard.PollChild)
        child.phase, child.pending, child.completed = 'other', b'', {}
        child.started = child.phase_started = time.monotonic() - 10
        child.progress_started = child.phase_started = observer.progress_clock() - 10
        child.reported_start, child.discarding = None, False
        return child

    def test_hanging_child_timeout_remainder_cause_host_and_rollup(self):
        for counts, expected in [((0, 0, 40, 2), 'starved'), ((16, 0, 2, 40), 'io'),
                                 ((0, 0, 2, 2), 'blocked')]:
            with self.subTest(cause=expected), tempfile.TemporaryDirectory() as directory:
                payload = b'\n'.join([b'history_scan_parse', finished(step='SaveState'), finished(),
                                       b'snapshot', b''])
                child = self.child(payload)
                self.assertFalse(child.check())
                child.started -= 180
                child.phase_started -= 180
                child.wall_start = NOW.timestamp() * 1000 - 240000
                wait4 = guard.os.wait4
                def reap(pid, options):
                    actual_pid, status, _ = wait4(pid, options)
                    usage = SimpleNamespace(ru_utime=.2, ru_stime=.1,
                        **{attr: base + active for attr, base, active in
                           zip(causes.RESOURCE_FIELDS.values(), (2, 3, 4, 5), counts)})
                    return actual_pid, status, usage
                with patch('guard.POLL_DEADLINE_SECONDS', .001), patch('guard.os.wait4', side_effect=reap), \
                     patch('guard.Sampler', return_value=lambda: HOST), patch.dict(os.environ, ROUTER_LOG_DIR=directory), \
                     patch('toollog.report_volume'):
                    self.assertTrue(child.check())
                    self.assertTrue(child.check())
                rows = [json.loads(line) for path in Path(directory).glob('*.ndjson')
                        for line in path.read_text().splitlines()]
                self.assertEqual(len(rows), 1)
                row = rows[0]
                self.assertEqual((row['name'], row['error']['tag']), ('poll.timeout', 'tick_deadline'))
                props = row['props']
                self.assertEqual(props['phase'], 'snapshot')
                self.assertEqual(props['historyScanParseMs'], 1000.125)
                self.assertEqual(props['historyScanParseSaveStateCpuMs'], 100.125)
                self.assertEqual(props['historyScanParseBytesHashed'], 123456)
                self.assertAlmostEqual(props['activePhaseCpuMs'], 199.875)
                self.assertGreaterEqual(props['activePhaseMs'], 180000)
                for suffix, base, active in zip(causes.RESOURCE_FIELDS, (2, 3, 4, 5), counts):
                    self.assertEqual(props['activePhase' + suffix], active)
                    self.assertEqual(props['child' + suffix], base + active)
                self.assertEqual(props['host'], HOST)
                self.assertGreater(props['hostAtMs'], 0)
                self.assertEqual(props['cause'], 'tick_' + expected + ':snapshot')
                self.assertEqual(props['causeEvidenceField'], 'activePhaseMs')
                self.assertEqual(props['causeEvidenceValue'], props['activePhaseMs'])
                # Use stable UTC bounds for both full and incremental rollup paths.
                props['finishedAtMs'] = child.wall_start + 180100
                row['ts'] = NOW.isoformat().replace('+00:00', 'Z')
                root = Path(directory)
                for path in root.glob('*.ndjson'):
                    path.unlink()
                (root / '2026-11-22.ndjson').write_text(json.dumps(row) + '\n')
                report = rollup.rollup('2026-11-22', root, NOW)
                self.assertEqual(report, rollup.rollup('2026-11-22', root, NOW, incremental=False))
                self.assertEqual(report['pollGapsByCause'][0]['cause'], props['cause'])
                self.assertEqual(report['pollGapsByCause'][0]['count'], 1)
                gap = report['pollGaps'][0]
                self.assertEqual(gap['phase'], 'snapshot')
                self.assertTrue(gap['timedOut'])
                self.assertEqual(gap['causeEvidenceField'], 'poll.timeout')
                self.assertEqual(gap['wallMs'], props['wallMs'])
                self.assertEqual(gap['cpuMs'], props['cpuMs'])
                self.assertEqual(gap['host'], HOST)
                for key in causes.WAIT_FIELDS | causes.SUBSTEP_FIELDS:
                    if key in props:
                        self.assertEqual(gap[key], props[key])
                for key in causes.TIMEOUT_FIELDS:
                    self.assertEqual(gap[key], props[key])
                if expected == 'starved' and os.environ.get('ROUTER_TIMEOUT_SAMPLE'):
                    print('SAMPLE_TIMEOUT ' + json.dumps(row, separators=(',', ':')), flush=True)

    def test_validation_table_and_bounded_retention(self):
        valid = json.loads(finished()[1:])
        cases = [b'={', b'=null', b'=[]', b'=true', b'=1', b'=\xff']
        cases += [b'=' + json.dumps(dict(valid, **changes)).encode() for changes in (
            {'p': 'unknown'}, {'p': []}, {'s': 'unknown'}, {'s': []}, {'s': None},
            {'ms': -1}, {'cpu': float('nan')}, {'ib': float('inf')}, {'iv': True},
            {'mf': '3'}, {'v': 1.5}, {'bp': -1}, {'ms': 2**53}, {'extra': 1})]
        cases += [b'=' + json.dumps({k: v for k, v in valid.items() if k != 'cpu'}).encode(),
                  finished('snapshot', step='SaveState')]
        child = self.parser()
        child.progress_line(b'snapshot')
        for line in cases:
            with self.subTest(line=line):
                child.progress_line(line)
                self.assertEqual(child.completed, {})
                self.assertEqual(child.phase, 'snapshot')
        for name in observer.FIELDS:
            child.progress_line(finished(name))
        for name in causes.BYTE_PHASES:
            for step in causes.SUBSTEPS:
                child.progress_line(finished(name, step))
        expected = len(observer.FIELDS) * 6 + len(causes.BYTE_PHASES) * (2 + len(causes.SUBSTEPS) * 2)
        self.assertEqual(len(child.completed), expected)
        child.progress_line(finished(ms=500))
        self.assertEqual(child.completed['historyScanParseMs'], 1000.125)

    def test_fragmented_oversized_and_nonascii_lines_recover(self):
        child = self.parser()
        reader, writer = os.pipe()
        self.addCleanup(os.close, reader)
        self.addCleanup(os.close, writer)
        os.set_blocking(reader, False)
        child.reader = reader
        parts = [b'x' * 2000, b'x' * 2000 + b'\n' + finished()[:30], finished()[30:] + b'\n\xff\nsnapshot\n']
        for part in parts:
            for offset in range(0, len(part), 128):
                os.write(writer, part[offset:offset + 128])
                child.drain()
                self.assertLessEqual(len(child.pending), 1024)
        self.assertEqual(child.phase, 'snapshot')
        self.assertEqual(child.completed['historyScanParseMs'], 1000.125)

    def test_plain_name_child_keeps_original_timeout_fields(self):
        child = self.child(b'listener_history\n')
        self.assertFalse(child.check())
        with patch('guard.POLL_DEADLINE_SECONDS', 0), patch('guard.emit') as emit, \
             patch('guard.Sampler', return_value=lambda: HOST):
            self.assertTrue(child.check())
        props = emit.call_args.kwargs['props']
        self.assertTrue({'pid', 'phase', 'wallMs', 'cpuMs', 'startedAtMs', 'finishedAtMs'} <= props.keys())
        self.assertEqual(props['phase'], 'listener_history')
        self.assertEqual(props['activePhaseCpuMs'], props['cpuMs'])
        self.assertNotIn('listenerHistoryMs', props)

    def test_child_progress_is_nonblocking_and_old_guard_keeps_phase(self):
        reader_socket, writer_socket = socket.socketpair(type=socket.SOCK_DGRAM)
        reader, writer = reader_socket.detach(), writer_socket.detach()
        self.addCleanup(os.close, reader)
        self.addCleanup(os.close, writer)
        os.set_blocking(reader, False)
        with patch.dict(os.environ, ROUTER_POLL_PROGRESS_FD=str(writer)), \
             patch('observer.job_snapshot', return_value={}):
            with observer.Timings(threshold_ms=float('inf'), sampler=lambda: {}) as timing:
                with observer.phase('history_scan_parse'):
                    with observer.substep('SaveState'):
                        observer.count_bytes('BytesHashed', 100)
                    with observer.phase('state_save'):
                        pass
                lines = []
                while True:
                    try:
                        lines.extend(os.read(reader, 65536).splitlines())
                    except BlockingIOError:
                        break
                # This is the old guard's exact phase-name update rule.
                phase = 'other'
                for line in lines:
                    value = line.decode('ascii')
                    phase = value if value in (*observer.FIELDS, 'other') else 'other'
                self.assertEqual(phase, 'other')  # legacy 'none' outside a phase
                parsed = self.parser()
                for line in lines:
                    parsed.progress_line(line)
                self.assertEqual(parsed.completed['historyScanParseMs'], round(timing.values['history_scan_parse'], 3))
                self.assertEqual(parsed.completed['historyScanParseBytesHashed'], 100)
                self.assertIn('historyScanParseSaveStateMs', parsed.completed)
                # Fill the pipe. progress must return even if given a blocking FD.
                while True:
                    try:
                        os.write(writer, b'x' * 1024)
                    except OSError as error:
                        self.assertIn(error.errno, (errno.EAGAIN, errno.EWOULDBLOCK, errno.ENOBUFS))
                        break
                observer.progress('snapshot')
                observer.finished_progress(timing, 'history_scan_parse')
        with patch.dict(os.environ, ROUTER_POLL_PROGRESS_FD='-1'):
            observer.progress('snapshot')

    def test_start_timestamp_survives_delayed_drain_and_legacy_fallback(self):
        child = self.parser()
        start = observer.progress_clock() - 5
        child.progress_line(b'=' + json.dumps(dict(p='snapshot', at=start * 1000)).encode())
        child.progress_line(b'snapshot')
        self.assertAlmostEqual(child.phase_started, start)
        child.progress_line(b'usage_fetch')
        self.assertGreater(child.phase_started, start)
        invalid = [None, True, '123', [], -1, float('nan'), float('inf'), 2**53,
                   (child.progress_started - 1) * 1000, (observer.progress_clock() + 100) * 1000]
        for at in invalid:
            with self.subTest(at=at):
                child.progress_line(b'=' + json.dumps(dict(p='snapshot', at=at)).encode())
                self.assertIsNone(child.reported_start)

    def test_progress_clock_is_shared_with_real_child_on_supported_pythons(self):
        module_dir = str(Path(observer.__file__).parent)
        interpreters = {sys.executable}
        if sys.platform == 'darwin':
            interpreters.add('/usr/bin/python3')
        for executable in sorted(interpreters):
            with self.subTest(executable=executable):
                script = ('import sys,signal\n'
                          'sys.path.insert(0,' + repr(module_dir) + ')\n'
                          'import observer\n'
                          'observer.phase_progress("snapshot")\n'
                          'signal.pause()\n')
                before = observer.progress_clock()
                child = guard.PollChild([executable, '-I', '-c', script])
                try:
                    self.assertTrue(select.select([child.reader], [], [], 10)[0])
                    after = observer.progress_clock()
                    # Model a delayed guard drain without sleeping. The child
                    # timestamp must win over the later observation clock.
                    with patch('guard.progress_clock', return_value=after + 10):
                        self.assertFalse(child.check())
                    self.assertGreaterEqual(child.phase_started, before - .001)
                    self.assertLessEqual(child.phase_started, after)
                finally:
                    child.stop()

    def test_uninstrumented_remainder_never_inherits_completed_phase(self):
        cases = [('other', 180000), ('none', 180000), ('snapshot', 0)]
        for active, wall in cases:
            with self.subTest(active=active, wall=wall):
                child = self.parser()
                child.process = SimpleNamespace(pid=12345)
                child.wall_start = NOW.timestamp() * 1000 - 240000
                child.progress_line(finished())
                child.phase = active
                usage = SimpleNamespace(ru_utime=.2, ru_stime=.1,
                    **dict.fromkeys(causes.RESOURCE_FIELDS.values(), 50))
                with patch('guard.Sampler', return_value=lambda: HOST), \
                     patch('guard.progress_clock', return_value=child.phase_started + wall / 1000):
                    props = child.timeout_props(usage, 240)
                self.assertEqual(props['phase'], active)
                expected = 'tick_blocked:snapshot' if active == 'snapshot' else 'unknown_no_data'
                self.assertEqual(props['cause'], expected)
                props['finishedAtMs'] = child.wall_start + 240000
                row = toollog.clean(dict(component='poller', name='poll.timeout', kind='error', props=props), NOW)
                gap = observer.gap_summary([row], '2026-11-22', NOW)['pollGaps'][0]
                self.assertEqual((gap['phase'], gap['cause']), (active, expected))

    def test_full_pipe_cannot_block_poll_child(self):
        module_dir = str(Path(observer.__file__).parent)
        script = ('import sys\n'
                  'sys.path.insert(0,' + repr(module_dir) + ')\n'
                  'import observer\n'
                  'for _ in range(10000): observer.phase_progress("snapshot")\n')
        child = guard.PollChild([sys.executable, '-I', '-c', script])
        try:
            # Deliberately never drain the progress pipe.
            self.assertEqual(child.process.wait(timeout=10), 0)
            self.assertTrue(child.check())
        finally:
            child.stop()

    def test_all_completion_updates_survive_a_burst_between_guard_checks(self):
        frames = [finished(name) for name in observer.FIELDS]
        frames += [finished(name, step) for name in causes.BYTE_PHASES for step in causes.SUBSTEPS]
        script = ('import os,signal\n'
                  'fd=int(os.environ["ROUTER_POLL_PROGRESS_FD"])\n'
                  'for frame in ' + repr(frames + [b'snapshot']) + ': os.write(fd,frame+b"\\n")\n'
                  'signal.pause()\n')
        child = guard.PollChild([sys.executable, '-I', '-c', script])
        try:
            # select waits for data, not a sleep or repeated deadline polling.
            for _ in range(len(frames) + 1):
                self.assertTrue(select.select([child.reader], [], [], 10)[0])
                child.drain()
                if child.phase == 'snapshot':
                    break
            self.assertEqual(child.phase, 'snapshot')
            for name, field in observer.FIELDS.items():
                self.assertEqual(child.completed[field], 1000.125)
            self.assertTrue(causes.SUBSTEP_FIELDS <= child.completed.keys())
        finally:
            child.stop()

    def test_fully_populated_timeout_fits_real_writer_budget(self):
        child = self.parser()
        child.process = SimpleNamespace(pid=12345)
        child.wall_start = NOW.timestamp() * 1000 - 240000
        for name in observer.FIELDS:
            child.progress_line(finished(name))
        for name in causes.BYTE_PHASES:
            for step in causes.SUBSTEPS:
                child.progress_line(finished(name, step))
        child.phase = 'snapshot'
        child.phase_started -= 180
        usage = SimpleNamespace(ru_utime=5, ru_stime=1,
                                **dict.fromkeys(causes.RESOURCE_FIELDS.values(), 12345678))
        with tempfile.TemporaryDirectory() as directory, patch.dict(os.environ, ROUTER_LOG_DIR=directory), \
             patch('guard.Sampler', return_value=lambda: HOST), patch('toollog.report_volume'):
            props = child.timeout_props(usage, 240)
            toollog.emit('poller', 'poll.timeout', kind='error', ok=False, durationMs=240000,
                         error=dict(tag='tick_deadline'), props=props)
            lines = [line for path in Path(directory).glob('*.ndjson') for line in path.read_bytes().splitlines(keepends=True)]
            self.assertEqual(len(lines), 1)
            self.assertGreater(len(lines[0]), 4096)
            self.assertLessEqual(len(lines[0]), 8192)
            self.assertEqual(json.loads(lines[0])['props'], props)
            # Accepted numeric extremes still fit, rather than silently losing
            # the row when a counter becomes unusually large.
            child.completed = dict.fromkeys(child.completed, 2**53 - 1)
            props = child.timeout_props(usage, 240)
            self.assertEqual(props['activePhaseCpuMs'], 0)
            self.assertEqual(props['activePhaseInblockN'], 0)
            toollog.emit('poller', 'poll.timeout', kind='error', ok=False, durationMs=240000,
                         error=dict(tag='tick_deadline'), props=props)
            lines = [line for path in Path(directory).glob('*.ndjson') for line in path.read_bytes().splitlines(keepends=True)]
            self.assertEqual(len(lines), 2)
            self.assertLessEqual(len(lines[1]), 8192)
            self.assertEqual(json.loads(lines[1])['props'], props)


if __name__ == '__main__':
    unittest.main()

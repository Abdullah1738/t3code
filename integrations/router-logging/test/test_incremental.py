import datetime as dt
import json
import os
import plistlib
from pathlib import Path
import select
import subprocess
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import append_cursor
import guard
import listener_rollup
import observer
import rollup
from toollog import clean

DAY = '2026-11-21'
NOW = dt.datetime(2026, 11, 22, 1, tzinfo=dt.timezone.utc)


def row(name='proxy.request', **props):
    return dict(tool='9router', name=name, component='proxy', kind='perf', ok=True,
                ts=DAY + 'T12:00:00Z', durationMs=123,
                props=dict(model='m', route='/v1/messages', stream=True, **props))


class IncrementalTests(unittest.TestCase):
    def compare(self, root, now=NOW):
        incremental = rollup.rollup(DAY, root, now)
        full = rollup.rollup(DAY, root, now, incremental=False)
        self.assertEqual(json.dumps(incremental, separators=(',', ':')), json.dumps(full, separators=(',', ':')))
        return incremental

    def test_host_load_survives_append_future_boundaries_and_generation_changes(self):
        start = dt.datetime(2026, 11, 21, 12, tzinfo=dt.timezone.utc)
        ms = start.timestamp() * 1000
        host = dict(l1=315, c=16, p=4)
        events = [row(status=200),
                  row('poll.complete', host=host, hostAtMs=ms),
                  row('listener.up', downSince=DAY + 'T11:59:00Z', listener='open',
                      downListener='refused', hostStart=host, hostStartAtMs=ms + 60000,
                      hostEnd=dict(l1=1, c=16, e='timeout'), hostEndAtMs=ms + 120000),
                  dict(row('poll.complete', host=host, hostAtMs=ms + 240000), ts=DAY + 'T12:04:00Z')]
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / (DAY + '.ndjson')
            for event in events:
                with source.open('a') as out:
                    out.write(json.dumps(event) + '\n')
                self.compare(root, start)
            for minutes in (1, 2, 4, 0, 4):
                result = self.compare(root, start + dt.timedelta(minutes=minutes))
            self.assertEqual(result['hostLoad']['pollRows'], 2)
            self.assertEqual(result['hostLoad']['failedSnapshots'], {'timeout': 1})
            self.assertEqual(result['proxySummary']['byHour'][0]['count'], 1)
            next_day = root / '2026-11-22.ndjson'
            next_day.write_text(json.dumps(dict(row('poll.complete', host=dict(l1=7, c=16),
                hostAtMs=ms + 300000), ts='2026-11-22T00:01:00Z')) + '\n')
            self.assertEqual(self.compare(root)['hostLoad']['pollRows'], 3)
            self.compare(root)

    def test_priority_snapshot_and_plist(self):
        plist = Path(__file__).resolve().parents[2] / 'local-helpers/launchd/com.ardud.9router-log-poll.plist'
        self.assertEqual(plistlib.loads(plist.read_bytes())['ProcessType'], 'Standard')
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            target = root / 'Library/LaunchAgents' / plist.name
            target.parent.mkdir(parents=True)
            target.write_bytes(plist.read_bytes())
            with patch('guard.Path.home', return_value=root), patch('guard.os.getpriority', return_value=0), patch('guard.subprocess.run', return_value=subprocess.CompletedProcess([], 0, '31\n')):
                props = guard.scheduling_snapshot()
            self.assertEqual(props['processType'], 'Standard')
            self.assertEqual((props['nice'], props['priority']), (0, 31))
            self.assertEqual(clean(dict(component='guard', name='observer.priority', kind='event', props=props), NOW)['props'], props)

    def test_chunked_causes_keep_cpu_and_unmeasured_evidence(self):
        start = dt.datetime(2026, 11, 21, 12, tzinfo=dt.timezone.utc).timestamp() * 1000
        cases = [(dict(postEndDiagMs=180000, postEndDiagCpuMs=4), 'tick_starved:post_end_diag'),
                 (dict(postEndDiagMs=180000, postEndDiagCpuMs=20000), 'tick_blocked:post_end_diag'),
                 (dict(childWaitMs=180000, childWaitCpuMs=0), 'child_wait'),
                 (dict(tcpMs=1, tcpCpuMs=0), 'unknown_no_data')]
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            for index, (props, expected) in enumerate(cases):
                begin = start + index * 300000
                event = dict(row('guard.tick_late', startedAtMs=begin, finishedAtMs=begin + 180000,
                                 monotonicGapMs=180000, **props), component='guard', durationMs=180000)
                with (root / (DAY + '.ndjson')).open('a') as out:
                    out.write(json.dumps(event) + '\n')
                report = self.compare(root)
                self.assertEqual(report['guardGaps'][-1]['cause'], expected)
            self.assertEqual(report['coverage']['unknownCauses']['remaining'], {'unmeasured_tick_time': 1})

    def test_chunked_append_exact_all_fixtures(self):
        fixture = Path(__file__).with_name('fixtures')
        events = [row(status=499, provider='p', usage={'in': 12}, attempts=2, ttfbMs=200,
                      sessionId='s:aaaaaaaaaaaa', sessionSrc='hdr_session'),
                  row('account.lock', provider='p', cause='quota', until=DAY + 'T13:00:00Z', lockMs=100),
                  row('listener.down', listener='refused', downSince=DAY + 'T12:00:00Z'),
                  row('health.request.late', probe='aaaaaaaa', acceptToHandlerMs=12),
                  row('supervisor.health_probe', probe='aaaaaaaa', totalMs=6000)]
        events[1]['ids'] = {'account': 'a' * 16}
        for path in sorted(fixture.glob('*.json')):
            value = json.loads(path.read_text())
            if isinstance(value, list):
                events.extend(event for event in value if isinstance(event, dict) and event.get('tool') == '9router')
        events.extend([row('listener.up', listener='open', downListener='refused', downSince=DAY + 'T12:00:00Z'),
                       row('log.volume', droppedByReason={'daily_cap': 4}, droppedLines=4)])
        events[-1]['ids'] = {'writer': 'b' * 16}
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / (DAY + '.ndjson')
            self.compare(root)
            for i, event in enumerate(events):
                payload = (json.dumps(event) + '\n').encode()
                split = (i * 17 + 19) % len(payload)
                with source.open('ab') as out:
                    out.write(payload[:split])
                self.compare(root)
                with source.open('ab') as out:
                    out.write(payload[split:])
                result = self.compare(root)
            self.assertTrue(result['complete'])
            self.assertEqual(result['total'], len(events))
            self.compare(root)

    def test_cursor_invalidation_class(self):
        for change in ('truncate', 'truncate_regrow', 'replace', 'rewrite_same_size',
                       'rewrite_middle_and_grow', 'missing_witness', 'schema', 'corrupt', 'delete'):
            with self.subTest(change=change), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                source = root / (DAY + '.ndjson')
                before = [row(status=200), row('listener.down', listener='refused'), row(status=200)]
                source.write_text(''.join(json.dumps(event) + '\n' for event in before))
                self.compare(root)
                self.assertEqual(list(listener_rollup.history_rows(source)),
                                 list(listener_rollup.history_rows(source, incremental=False)))
                states = [root / (prefix + DAY + '.json') for prefix in ('.rollup-state-', '.listener-state-')]
                identity, size = source.stat().st_ino, source.stat().st_size
                if change == 'truncate':
                    source.write_text(json.dumps(row(status=499)) + '\n')
                elif change == 'truncate_regrow':
                    after = [row(status=499), row('listener.up', listener='open'),
                             row(status=499), row(status=499)]
                    source.write_text(''.join(json.dumps(event) + '\n' for event in after))
                    self.assertEqual(source.stat().st_ino, identity)
                    self.assertGreater(source.stat().st_size, size)
                elif change == 'replace':
                    replacement = root / 'replacement'
                    replacement.write_text((json.dumps(row('listener.up', listener='open')) + '\n') * 7)
                    replacement.replace(source)
                elif change == 'rewrite_same_size':
                    source.write_text(source.read_text().replace('123', '321'))
                elif change == 'rewrite_middle_and_grow':
                    source.write_text(source.read_text().replace('listener.down', 'listener.fake')
                                      + json.dumps(row(status=499)) + '\n')
                    self.assertEqual(source.stat().st_ino, identity)
                    self.assertGreater(source.stat().st_size, size)
                elif change in ('schema', 'missing_witness', 'corrupt'):
                    for state in states:
                        if change == 'corrupt':
                            state.write_text('{')
                            continue
                        value = json.loads(state.read_text())
                        if change == 'schema':
                            value['version'] = -1
                        else:
                            value['cursor'].pop('sha256', None)
                        state.write_text(json.dumps(value))
                else:
                    source.unlink()
                with self.subTest(cache='aggregate'):
                    result = self.compare(root)
                    if change == 'truncate_regrow':
                        self.assertEqual(result['proxySummary']['byModel'][0]['aborted'], 3)
                with self.subTest(cache='history'):
                    self.assertEqual(list(listener_rollup.history_rows(source)),
                                     list(listener_rollup.history_rows(source, incremental=False)))

    def test_unterminated_valid_tail_and_malformed_tail(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / (DAY + '.ndjson')
            source.write_text(json.dumps(row()))
            self.assertEqual(self.compare(root)['total'], 1)
            self.assertEqual(self.compare(root)['total'], 1)
            with source.open('a') as out:
                out.write('\n{broken')
            result = self.compare(root)
            self.assertEqual((result['total'], result['malformed']), (1, 1))
            with source.open('a') as out:
                out.write('\n' + json.dumps(row(status=499)) + '\n')
            result = self.compare(root)
            self.assertEqual((result['total'], result['malformed']), (2, 1))

    def test_only_appended_bytes_are_parsed(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / (DAY + '.ndjson')
            payload = (json.dumps(row()) + '\n').encode()
            source.write_bytes(payload * 100)
            rollup.rollup(DAY, root, NOW)
            with source.open('ab') as out:
                out.write(payload)
            offsets = []
            original = append_cursor.lines
            def read(stream, cursor):
                offsets.append(cursor['offset'])
                return original(stream, cursor)
            with patch('append_cursor.lines', side_effect=read):
                rollup.rollup(DAY, root, NOW)
            self.assertEqual(offsets, [len(payload) * 100] * 2)

    def test_normal_exit_at_deadline_does_not_restart_guard_or_log_timeout(self):
        script = ('import os,signal,sys,time\n'
                  'signal.signal(signal.SIGTERM,lambda *_:sys.exit(0))\n'
                  'os.write(int(os.environ["ROUTER_POLL_PROGRESS_FD"]),b"history_scan_parse\\n")\n'
                  'while True: time.sleep(60)\n')
        for stage in ('kill_reaps', 'wait4_reaps'):
            with self.subTest(stage=stage):
                child = guard.PollChild([sys.executable, '-I', '-c', script])
                try:
                    self.assertTrue(select.select([child.reader], [], [], 30)[0])
                    child.started -= guard.POLL_DEADLINE_SECONDS + 1
                    kill = child.process.kill
                    def exit_during_kill():
                        child.process.terminate()
                        if stage == 'kill_reaps':
                            self.assertEqual(child.process.wait(timeout=5), 0)
                            kill()
                    with patch.object(child.process, 'kill', side_effect=exit_during_kill), patch('guard.emit') as emit:
                        self.assertTrue(child.check())
                        self.assertTrue(child.check())
                    self.assertEqual(child.process.returncode, 0)
                    self.assertIsNone(child.reader)
                    emit.assert_not_called()
                    next_child = guard.PollChild([sys.executable, '-I', '-c', 'pass'])
                    try:
                        self.assertEqual(next_child.process.wait(timeout=5), 0)
                        self.assertTrue(next_child.check())
                    finally:
                        next_child.stop()
                finally:
                    child.stop()

    def test_deadline_interrupts_cold_rebuild_twice_then_resumes_exactly(self):
        module_dir = str(Path(rollup.__file__).parent)
        script = ("import sys,os,time\n"
                  "sys.path.insert(0,sys.argv[1])\n"
                  "import rollup,append_cursor\n"
                  "from pathlib import Path\n"
                  "root=Path(sys.argv[2]); cut=int(sys.argv[3])\n"
                  "rollup.CHECKPOINT_BYTES=1\n"
                  "save=append_cursor.save\n"
                  "def checkpoint(path,version,cursor,state):\n"
                  " save(path,version,cursor,state)\n"
                  " if path.name.startswith('.rollup-state-') and cursor['offset']>=cut:\n"
                  "  os.write(int(os.environ['ROUTER_POLL_PROGRESS_FD']),b'history_scan_parse\\n')\n"
                  "  time.sleep(60)\n"
                  "append_cursor.save=checkpoint\n"
                  "rollup.rollup('2026-11-21',root)\n")
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            payload = (json.dumps(row(status=499)) + '\n').encode()
            (root / (DAY + '.ndjson')).write_bytes(payload * 6)
            for count in (2, 4):
                child = guard.PollChild([sys.executable, '-I', '-c', script, module_dir, directory, str(len(payload) * count)])
                try:
                    self.assertTrue(select.select([child.reader], [], [], 30)[0])
                    child.started -= guard.POLL_DEADLINE_SECONDS + 1
                    with patch('guard.emit') as emit:
                        self.assertTrue(child.check())
                    self.assertEqual(emit.call_count, 1)
                    saved = json.loads((root / ('.rollup-state-' + DAY + '.json')).read_text())
                    self.assertEqual(saved['cursor']['offset'], len(payload) * count)
                    self.assertEqual(append_cursor.decode(saved['aggregate'])['total'], count)
                finally:
                    child.stop()
            result = self.compare(root)
            self.assertEqual(result['total'], 6)
            self.assertEqual(result['proxySummary']['byModel'][0]['aborted'], 6)

    def test_exclusive_cpu_and_starved_cause(self):
        wall, cpu = [0], [0]
        def sample():
            return dict(wallMs=1795219200000 + wall[0] * 1000, monotonicMs=wall[0] * 1000,
                        continuousMs=wall[0] * 1000, cpuMs=cpu[0] * 1000, pid=42)
        for used, cause in ((4, 'tick_starved:history_scan_parse'), (20, 'tick_blocked:history_scan_parse')):
            wall[0], cpu[0] = 0, 0
            usage = lambda _: SimpleNamespace(ru_inblock=0, ru_majflt=0, ru_nvcsw=0, ru_nivcsw=int(wall[0]))
            with patch('observer.resource.getrusage', side_effect=usage), patch('observer.time.monotonic', side_effect=lambda: wall[0]), patch('observer.time.process_time', side_effect=lambda: cpu[0]), patch('observer.clock_sample', side_effect=sample), patch('observer.job_snapshot', return_value={}), patch('observer.emit') as emit:
                with observer.Timings() as timing:
                    with observer.phase('history_scan_parse'):
                        wall[0] += 180
                        cpu[0] += used
                        with observer.phase('rollup_write'):
                            wall[0] += 1
                            cpu[0] += 1
                self.assertEqual(timing.cpu['history_scan_parse'], used * 1000)
                props = emit.call_args.kwargs['props']
                self.assertEqual(props['cause'], cause)
                self.assertEqual(props['historyScanParseCpuMs'], used * 1000)
                event = clean(dict(component='poller', name='poll.phases', **emit.call_args.kwargs), NOW)
                self.assertEqual(event['props']['cpuMs'], (used + 1) * 1000)
                self.assertEqual(observer.gap_summary([event], DAY, NOW)['pollGaps'][0]['cause'], cause)
        self.assertEqual(observer.phase_cause('tcp', 30000, 0), 'tick_blocked:tcp')
        self.assertEqual(observer.phase_cause('tcp', 120001, 12000.1), 'tick_blocked:tcp')

    def test_timeout_kills_only_owned_child_once_and_next_runs(self):
        script = ('import os,signal,time\n'
                  'signal.signal(signal.SIGTERM,signal.SIG_IGN)\n'
                  'os.write(int(os.environ["ROUTER_POLL_PROGRESS_FD"]),b"history_scan_parse\\n")\n'
                  'while True: time.sleep(60)\n')
        child = guard.PollChild([sys.executable, '-I', '-c', script])
        try:
            self.assertTrue(select.select([child.reader], [], [], 30)[0])
            self.assertFalse(child.check())
            child.started -= guard.POLL_DEADLINE_SECONDS + 1
            with patch('guard.emit') as emit:
                self.assertTrue(child.check())
                self.assertTrue(child.check())
            self.assertEqual(emit.call_count, 1)
            self.assertEqual(child.process.returncode, -9)
            props = emit.call_args.kwargs['props']
            self.assertEqual(props['pid'], child.process.pid)
            self.assertEqual(props['phase'], 'history_scan_parse')
            self.assertGreaterEqual(props['cpuMs'], 0)
            next_child = guard.PollChild([sys.executable, '-I', '-c', 'pass'])
            try:
                self.assertEqual(next_child.process.wait(timeout=5), 0)
                self.assertTrue(next_child.check())
            finally:
                next_child.stop()
        finally:
            child.stop()


if __name__ == '__main__':
    unittest.main()

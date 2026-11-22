import datetime as dt
import json
import os
import plistlib
from pathlib import Path
import select
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import append_cursor
import guard
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
    def compare(self, root):
        incremental = rollup.rollup(DAY, root, NOW)
        full = rollup.rollup(DAY, root, NOW, incremental=False)
        self.assertEqual(json.dumps(incremental, separators=(',', ':')), json.dumps(full, separators=(',', ':')))
        return incremental

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
        for change in ('truncate', 'replace', 'rewrite_same_size', 'schema', 'corrupt', 'delete'):
            with self.subTest(change=change), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                source = root / (DAY + '.ndjson')
                source.write_text((json.dumps(row()) + '\n') * 5)
                self.compare(root)
                if change == 'truncate':
                    source.write_text(json.dumps(row(status=499)) + '\n')
                elif change == 'replace':
                    replacement = root / 'replacement'
                    replacement.write_text((json.dumps(row(status=499)) + '\n') * 7)
                    replacement.replace(source)
                elif change == 'rewrite_same_size':
                    source.write_text(source.read_text().replace('123', '321'))
                elif change == 'schema':
                    state = root / ('.rollup-state-' + DAY + '.json')
                    value = json.loads(state.read_text())
                    value['version'] = -1
                    state.write_text(json.dumps(value))
                elif change == 'corrupt':
                    (root / ('.rollup-state-' + DAY + '.json')).write_text('{')
                else:
                    source.unlink()
                self.compare(root)

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

    def test_only_appended_bytes_are_scanned(self):
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
            with patch('observer.time.monotonic', side_effect=lambda: wall[0]), patch('observer.time.process_time', side_effect=lambda: cpu[0]), patch('observer.clock_sample', side_effect=sample), patch('observer.job_snapshot', return_value={}), patch('observer.emit') as emit:
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
        self.assertEqual(observer.phase_cause('tcp', 120000, 0), 'tick_blocked:tcp')
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

"""Pressure math and diagnostics cannot change command execution or log recovery."""
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parent))
from offbox_lib import api, common, resources, runs
from test_capacity import Isolated


def fixture(t, cpu=100, throttled=0, io=1000, psi=0):
    return resources.snapshot(f'''@uptime
{t} 500
@cpu
usage_usec {cpu}
nr_throttled {throttled}
throttled_usec {throttled * 100000}
@io
8:0 rbytes={io} wbytes=30 rios=4 wios=2 dbytes=0 dios=0
8:1 rbytes=15 wbytes=70 rios=1 wios=3 dbytes=0 dios=0
@memory
oom 0
high {throttled}
max 0
@psi_cpu
some avg10=12.50 avg60=1.00 avg300=1.00 total={psi}
full avg10=0.00 total=0
@psi_io
some avg10=8.00 total={psi}
full avg10=3.00 total={psi}
@psi_memory
some avg10=0.00 total=0
full avg10=0.00 total=0
''')


class Parsers(unittest.TestCase):
    def test_deltas_are_command_window_and_peak_is_max(self):
        r = resources.record(fixture(100), fixture(120, cpu=10000100, throttled=30, io=7000, psi=4000000),
                             'cpu_some 7100\nio_full 4000\nerrors 2\nsamples 3')
        self.assertEqual(r['wall_s'], 20)
        self.assertEqual(r['cpu'], dict(usage_usec=10000000, nr_throttled=30, throttled_usec=3000000,
                                        usage_avg_pct=50, throttled_wall_pct=15))
        self.assertEqual(r['io']['rbytes'], 6000)
        self.assertEqual(r['io']['wbytes'], 0)
        self.assertEqual(r['memory'], dict(oom=0, high=30, max=0))
        self.assertEqual(r['psi']['cpu']['some'], dict(total_usec=4000000, avg_pct=20, peak_avg10_pct=71))
        self.assertEqual(r['psi']['io']['full']['peak_avg10_pct'], 40)
        self.assertEqual((r['samples'], r['errors']), (3, 2))

    def test_missing_partial_and_malformed_files(self):
        for text in ('', '@cpu\n!error\n@psi_cpu\nsome avg10=nan total=oops',
                     '@cpu\nusage_usec\nnr_throttled -1\n@memory\noom bad'):
            with self.subTest(text=text):
                r = resources.record(resources.snapshot(text), fixture(100), '')
                self.assertIsNone(r['cpu']['usage_usec'])
                self.assertIsNone(r['psi']['cpu']['some']['avg_pct'])
                self.assertGreater(r['errors'], 0)
        p = resources.pressure('some total=500 avg10=1.50\nfull total=bad\npartial')
        self.assertEqual(p['some'], dict(total_usec=500, avg10_pct=1.5))
        self.assertIsNone(p['full']['total_usec'])
        self.assertEqual(resources.io_totals(''), dict.fromkeys(resources.IO, 0))
        self.assertEqual(resources.io_totals(None), dict.fromkeys(resources.IO))
        self.assertIsNone(resources.io_totals('8:0 rbytes=5\n8:1 rbytes=bad')['rbytes'])

    def test_reset_counters_and_nonpositive_wall_are_unknown(self):
        for end in (fixture(90, cpu=1), fixture(100, cpu=1)):
            r = resources.record(fixture(100), end, '')
            self.assertIsNone(r['cpu']['usage_usec'])
            self.assertIsNone(r['cpu']['usage_avg_pct'])
        for value in (True, 'NaN', '-1', float('inf'), {}, None):
            self.assertIsNone(resources.number(value))

    def test_threshold_matrix(self):
        for peak, throttle, expected in (
            (None, None, []), (19.99, 10, []), (20, 10, ['io-stalled']),
            (0, 10.01, ['cpu-throttled']), (20, 11, ['io-stalled', 'cpu-throttled'])):
            with self.subTest(peak=peak, throttle=throttle):
                d = dict(psi={'io': {'full': {'peak_avg10_pct': peak}}}, cpu={'throttled_wall_pct': throttle})
                self.assertEqual(resources.labels(d), expected)

    def test_summary_and_unknowns(self):
        r = resources.record(fixture(100), fixture(120, throttled=30), 'cpu_some 7100\nsamples 2')
        r['host_boxes'] = dict(start=9, end=14)
        text = resources.summary(r)
        self.assertIn('cpu some avg/peak 0%/71%', text)
        self.assertIn('throttled 3 s (nr 30)', text)
        self.assertIn('host boxes 9→14 running', text)
        self.assertIn('cpu-throttled', text)
        self.assertEqual(resources.summary(resources.unavailable('boat')),
                         'offbox: box pressure unavailable · host boxes ?→? running')


class Persistence(Isolated):
    def row(self):
        return dict(run_id='run-pressure', box_id='bx_fake', process_id=7, command_id='cmd_pressure', mode='bg')

    def test_footer_state_checkpoint_and_repeat_waits(self):
        d = resources.record(fixture(1), fixture(21, throttled=30), 'samples 2')
        d['unexpected'] = 'never persist this'
        row = self.row()
        path = runs.LOGS_DIR / 'run-pressure.log'
        payload = ('command output\n' + resources.PREFIX + row['run_id'] + ' ' + json.dumps(d) + '\n').encode()
        path.write_bytes(payload)
        common.atomic_write_json(common.offsets_path(path), dict(stdoutOffset=15, stderrOffset=100, logBytes=len(payload)))
        runs.save_run_state(row['run_id'], resources=resources.unavailable('pending'), exit_code=7)
        with patch.object(api, 'BACKEND', 'server'), patch.object(api, 'command_host_boxes', return_value=dict(start=9, end=14)):
            resources.finalize(row)
        saved = common.read_json(runs.LOGS_DIR / 'run-pressure.state.json', {})
        self.assertEqual(saved['exit_code'], 7)
        self.assertNotIn('unexpected', saved['resources'])
        self.assertEqual(saved['resources']['host_boxes'], dict(start=9, end=14))
        first = path.read_bytes()
        with patch.object(api, 'BACKEND', 'server'), patch.object(api, 'command_host_boxes', return_value=None):
            resources.finalize(row)
        self.assertEqual(path.read_bytes(), first)
        ck = common.read_json(common.offsets_path(path), {})
        self.assertEqual((ck['stdoutOffset'], ck['stderrOffset'], ck['logBytes']), (15, 100, len(first)))
        self.assertIn('cpu-throttled', resources.failure_suffix(row['run_id'], 7))
        self.assertEqual(resources.failure_suffix(row['run_id'], 0), '')

    def test_telemetry_exception_and_legacy_logs_are_untouched(self):
        path = runs.LOGS_DIR / 'run-pressure.log'
        path.write_text('unchanged\n')
        with patch.object(runs, 'save_run_state', side_effect=RuntimeError('broken')):
            resources.finalize(self.row())
        self.assertEqual(path.read_text(), 'unchanged\n')
        runs.save_run_state('run-pressure', resources=resources.unavailable())
        with patch.object(runs, 'save_run_state', side_effect=RuntimeError('broken')):
            resources.finalize(self.row())
        self.assertEqual(path.read_text(), 'unchanged\n')

    def test_empty_log_stays_recoverable_until_history_is_checkpointed(self):
        path = runs.LOGS_DIR / 'run-pressure.log'
        path.touch()
        runs.save_run_state('run-pressure', resources=resources.unavailable('pending'))
        resources.finalize(self.row())
        self.assertEqual(path.read_bytes(), b'')
        self.assertFalse(common.offsets_path(path).exists())
        common.atomic_write_json(common.offsets_path(path), dict(stdoutOffset=0, stderrOffset=0, logBytes=0))
        resources.finalize(self.row())
        self.assertEqual(path.read_bytes(), b'')

    def test_host_counts_reuse_status_and_attempt_invalidates(self):
        st = dict(status='exited', commandId='cmd_pressure', metrics={'host_boxes': dict(start=7, end=10)})
        with patch.object(api, 'call', side_effect=AssertionError('no network')):
            api.remember_execution('bx_fake', st, pid=7)
            self.assertEqual(api.command_host_boxes('bx_fake', 7, 'cmd_pressure'), dict(start=7, end=10))
            list(api._execution_frames('bx_fake', 7, [dict(type='attempt', attempt=2)]))
            self.assertIsNone(api.command_host_boxes('bx_fake', 7, 'cmd_pressure'))

    def test_footer_does_not_commit_uncheckpointed_remote_bytes(self):
        path = runs.LOGS_DIR / 'run-pressure.log'
        path.write_bytes(b'committed\nnot yet committed\n')
        ck = dict(stdoutOffset=10, stderrOffset=0, logBytes=10)
        common.atomic_write_json(common.offsets_path(path), ck)
        runs.save_run_state('run-pressure', resources=resources.unavailable('pending'))
        resources.finalize(self.row())
        self.assertEqual(path.read_bytes(), b'committed\nnot yet committed\n')
        self.assertEqual(common.read_json(common.offsets_path(path), {}), ck)

    def test_failed_publication_preserves_existing_evidence_and_failure_labels(self):
        data = resources.record(fixture(1), fixture(21, throttled=30), 'io_full 4000\nsamples 2')
        data['host_boxes'] = dict(start=9, end=14)
        row = self.row()
        path = runs.LOGS_DIR / 'run-pressure.log'
        path.write_text('command output\n')
        common.atomic_write_json(common.offsets_path(path), dict(stdoutOffset=15, stderrOffset=0, logBytes=15))
        runs.save_run_state(row['run_id'], resources=data, exit_code=7)
        state_path = runs.LOGS_DIR / 'run-pressure.state.json'
        before = state_path.read_bytes()
        cases = (
            ('log lock busy', patch.object(runs, 'log_lock', side_effect=common.OffboxError('busy'))),
            ('state write failed', patch.object(runs, 'save_run_state', side_effect=OSError('disk error'))),
            ('cached metadata failed', patch.object(api, 'command_host_boxes', side_effect=RuntimeError('metadata error'))),
        )
        for name, failure in cases:
            with self.subTest(name=name), patch.object(api, 'BACKEND', 'server'), failure:
                resources.finalize(row)
            self.assertEqual(state_path.read_bytes(), before)
            self.assertEqual(path.read_text(), 'command output\n')
            suffix = resources.failure_suffix(row['run_id'], 7)
            self.assertIn('io-stalled', suffix)
            self.assertIn('cpu-throttled', suffix)
            self.assertIn('host boxes 9→14 running', suffix)


@unittest.skipUnless(sys.platform == 'linux', 'the home wrapper runs on Linux')
class CommandSafety(unittest.TestCase):
    def run_shell(self, command):
        shell = 'export OFFBOX_RUN_ID=run-test\n' + resources.wrap(command, runs.BOUNDED_PROCESS)
        return subprocess.run(['bash', '-c', shell], capture_output=True, text=True, timeout=10)

    def test_nonzero_exit_and_stdout_survive(self):
        result = self.run_shell('printf "exact output\\n"; exit 7')
        self.assertEqual((result.returncode, result.stdout), (7, 'exact output\n'))
        self.assertIn(resources.PREFIX + 'run-test ', result.stderr)

    def test_missing_tools_with_errexit_and_nounset_preserve_result(self):
        with tempfile.TemporaryDirectory() as empty:
            shell = 'export OFFBOX_RUN_ID=run-test\n' + resources.wrap('printf "exact output\\n"; exit 7', runs.BOUNDED_PROCESS)
            result = subprocess.run(['/bin/bash', '-eu', '-o', 'pipefail', '-c', shell],
                                    env=dict(os.environ, PATH=empty), capture_output=True, text=True, timeout=10)
        self.assertEqual((result.returncode, result.stdout, result.stderr), (7, 'exact output\n', ''))

    def test_sampler_and_snapshot_failures_do_not_change_command(self):
        with patch.object(resources, 'CAPTURE', 'exit 1'), patch.object(resources, 'SAMPLER', 'exit 1'):
            result = self.run_shell('printf "exact output\\n"; exit 7')
        self.assertEqual((result.returncode, result.stdout), (7, 'exact output\n'))
        d = json.loads(result.stderr.split(resources.PREFIX + 'run-test ')[1])
        self.assertIsNone(d['wall_s'])
        self.assertGreater(d['errors'], 0)

    def test_telemetry_parser_exception_does_not_change_output_or_exit(self):
        source = Path(resources.__file__).read_text().split('# Only kernel pseudo-files')[0]
        source += '\ndef record(*args):\n    raise RuntimeError("must not leak")\n'
        with patch.object(resources.Path, 'read_text', return_value=source):
            result = self.run_shell('printf "exact output\\n"; exit 7')
        self.assertEqual((result.returncode, result.stdout), (7, 'exact output\n'))
        self.assertNotIn('must not leak', result.stderr)
        data = json.loads(result.stderr.split(resources.PREFIX + 'run-test ')[1])
        self.assertEqual((data['status'], data['errors']), ('unavailable', 1))


if __name__ == '__main__':
    unittest.main()

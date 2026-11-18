"""Replay missing receipts and signals without Boat, live state, or timing-based waits."""
import contextlib
import io
import os
from pathlib import Path
import shlex
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parent))
import offbox_protocol
from offbox_lib import common, misc, run_evidence, runs
from test_capacity import Isolated


class EvidenceScriptTests(unittest.TestCase):
    def invoke(self, steps, transform=lambda script: script):
        with tempfile.TemporaryDirectory() as home:
            tools = Path(home) / 'bin'
            tools.mkdir()
            tool = tools / 'systemctl'
            tool.write_text('#!/bin/sh\necho inactive\nexit 3\n')
            tool.chmod(0o755)
            script = transform(runs.steps_block(steps))
            command = runs.exit_recording_command(script, 'run-evidence').replace('bash -lc', 'bash -c')
            env = {**os.environ, 'HOME': home, 'PATH': str(tools) + ':' + os.environ['PATH']}
            proc = subprocess.run(shlex.split(command), env=env, capture_output=True, text=True, timeout=15)
            base = Path(home) / '.offbox/exit'
            trace = (base / 'run-evidence.trace').read_text()
            receipt = base / 'run-evidence.rc'
            return proc, trace, receipt.read_text().strip() if receipt.exists() else None

    def test_timeout_status_does_not_stop_later_steps_and_pid_is_retained(self):
        proc, trace, receipt = self.invoke(['exit 124', 'true', 'echo third'])
        self.assertEqual(proc.returncode, 124, proc.stderr)
        self.assertEqual(receipt, '124')
        self.assertRegex(trace, r'wrapper pid=\d+\nbegin pid=\d+ planned=3')
        for n, rc in ((1, 124), (2, 0), (3, 0)):
            self.assertIn(f'start step={n}\nend step={n} rc={rc}\n', trace)
            self.assertIn(f'offbox evidence start step={n}', proc.stderr)

    def test_catchable_step_signals_record_name_and_step(self):
        for signal in ('HUP', 'INT', 'TERM'):
            with self.subTest(signal=signal):
                proc, trace, receipt = self.invoke(['true', f'kill -{signal} $$', 'echo never'])
                self.assertNotEqual(proc.returncode, 0)
                self.assertEqual(receipt, '90')
                self.assertIn(f'signal={signal} step=2', trace)
                self.assertNotIn('start step=3', trace)
                self.assertIn(f'caught {signal} at step 2', run_evidence.describe(trace, trace=True))

    def test_wrapper_signals_record_a_receipt_and_current_step(self):
        for signal, code in (('HUP', 129), ('INT', 130), ('TERM', 143)):
            with self.subTest(signal=signal):
                proc, trace, receipt = self.invoke(['true', f'kill -{signal} "$PPID"'])
                self.assertEqual(proc.returncode, code, proc.stderr)
                self.assertEqual(receipt, str(code))
                self.assertIn(f'signal={signal} step=2', trace)

    def test_kill_between_steps_leaves_evidence_without_inventing_a_signal(self):
        proc, trace, receipt = self.invoke(['exit 124', 'true', 'echo never'],
            lambda script: script.replace('__offbox_current=3', 'kill -KILL "$PPID" $$\n__offbox_current=3'))
        self.assertNotEqual(proc.returncode, 0)
        self.assertIsNone(receipt)
        self.assertEqual(run_evidence.describe(trace, trace=True), 'step 1 rc=124, step 2 rc=0; wrapper vanished before step 3')
        self.assertNotIn('signal=KILL', trace)

    def test_kill_in_a_quiet_step_is_distinct_from_before_step(self):
        proc, trace, receipt = self.invoke(['true', 'true', 'kill -KILL "$PPID" $$'])
        self.assertIsNone(receipt)
        self.assertIn('wrapper vanished during step 3', run_evidence.describe(trace, trace=True))

    def test_preclaim_signals_cannot_overwrite_another_owners_receipt(self):
        for signal in ('HUP', 'INT', 'TERM'):
            with self.subTest(signal=signal), tempfile.TemporaryDirectory() as home:
                base = Path(home) / '.offbox/exit'
                base.mkdir(parents=True)
                receipt = base / 'run-evidence.rc'
                receipt.write_text('7\n')
                claim = Path(home) / '.offbox/claim/run-evidence'
                claim.mkdir(parents=True)
                (claim / 'pid').write_text('4242\n')
                command = runs.exit_recording_command('echo never', 'run-evidence')
                args = shlex.split(command)
                args[2] = args[2].replace('python3 - "$$"', f'kill -{signal} $$\npython3 - "$$"', 1)
                result = subprocess.run(args, env={**os.environ, 'HOME': home}, capture_output=True, timeout=5)
                self.assertNotEqual(result.returncode, 0)
                self.assertEqual(receipt.read_text(), '7\n')
                self.assertEqual((claim / 'pid').read_text(), '4242\n')
                self.assertNotIn(b'never', result.stdout)


class EvidenceDescriptionTests(unittest.TestCase):
    def test_legacy_log_makes_no_claim_about_step_start(self):
        text = 'offbox step 1 rc=124: timeout ...\noffbox step 2 rc=0: test ...\n'
        self.assertEqual(run_evidence.describe(text, 5),
                         'step 1 rc=124, step 2 rc=0; no result for step 3; legacy log cannot show whether it started')

    def test_retries_discard_earlier_step_evidence(self):
        first = 'offbox evidence begin pid=1 planned=3\noffbox evidence end step=2 rc=0\n'
        for reset in ('offbox evidence begin pid=2 planned=3', 'offbox-command-started: run-x',
                      'offbox-server: the server restarted while this run was going (attempt 1 is lost); it is queued again as attempt 2'):
            with self.subTest(reset=reset):
                self.assertNotIn('step 2 rc=0', run_evidence.describe(first + reset + '\n', 3, offbox_protocol.Protocol('run-x')))

    def test_gaps_never_look_like_all_results_completed(self):
        for planned, results, gap in ((3, (1, 3), 2), (3, (2, 3), 1), (4, (1, 2, 4), 3)):
            for prefixed in (False, True):
                with self.subTest(planned=planned, results=results, prefixed=prefixed):
                    text = f'begin pid=4 planned={planned}\n' + ''.join(f'end step={n} rc=0\n' for n in results)
                    if prefixed:
                        text = '\n'.join('offbox evidence ' + line for line in text.splitlines())
                    description = run_evidence.describe(text, trace=True)
                    self.assertIn(f'missing end markers for step {gap}', description)
                    self.assertNotIn('after all step results', description)

    def test_malformed_evidence_does_not_break_logs(self):
        self.assertEqual(run_evidence.describe('offbox evidence begin planned=oops\n'), '')
        self.assertEqual(run_evidence.describe('offbox evidence end step=1\n'), '')


class EvidenceEntryPointsTests(Isolated):
    def setUp(self):
        super().setUp()
        self.path = common.LOGS_DIR / 'run-x.log'
        self.path.write_text('offbox step 1 rc=124: timeout\noffbox step 2 rc=0: test\n')
        self.con.execute("INSERT INTO runs(run_id,box_id,mode,status,log_path,step_count) "
                         "VALUES ('run-x','bx','bg','failed',?,0)", (str(self.path),))
        self.con.commit()
        self.stack.enter_context(patch.object(misc, '_catch_up_log', return_value='complete'))

    def test_wait_and_plain_logs_explain_legacy_failure(self):
        for invoke in (lambda: misc.wait('run-x', None), lambda: misc.logs('run-x', False)):
            with self.subTest(invoke=invoke), contextlib.redirect_stdout(io.StringIO()), \
                    contextlib.redirect_stderr(io.StringIO()) as err:
                invoke()
                self.assertIn('step 1 rc=124, step 2 rc=0; no result for step 3', err.getvalue())

    def test_report_reads_durable_trace_when_stream_lost_end_markers(self):
        self.path.write_text('offbox evidence begin pid=4 planned=5\n')
        trace = b'begin pid=4 planned=5\nstart step=1\nend step=1 rc=124\nstart step=2\nend step=2 rc=0\n'
        row = dict(self.con.execute("SELECT * FROM runs WHERE run_id='run-x'").fetchone())
        err = io.StringIO()
        with patch('offbox_lib.ssh_sync.ssh', return_value=subprocess.CompletedProcess([], 0, trace)) as ssh, \
                contextlib.redirect_stderr(err):
            run_evidence.report(row)
        self.assertIn('wrapper vanished before step 3', err.getvalue())
        self.assertEqual(ssh.call_args.kwargs['timeout'], 3)

    def test_trace_does_not_replace_newer_log_or_a_queued_retry(self):
        begin = 'begin pid=4 planned=5 epoch=123'
        remote = (begin + '\nstart step=1\nend step=1 rc=124\n').encode()
        cases = [
            (begin + '\nstart step=1\nend step=1 rc=124\nstart step=2\nend step=2 rc=0\n', 'step 2 rc=0'),
            (begin + '\noffbox-server: the server restarted while this run was going (attempt 1 is lost); '
             'it is queued again as attempt 2\n', ''),
        ]
        for text, expected in cases:
            with self.subTest(text=text):
                self.path.write_text('\n'.join('offbox evidence ' + line if not line.startswith('offbox-server:') else line
                                               for line in text.splitlines()))
                err = io.StringIO()
                with patch('offbox_lib.ssh_sync.ssh', return_value=subprocess.CompletedProcess([], 0, remote)), \
                        contextlib.redirect_stderr(err):
                    run_evidence.report({'run_id': 'run-x', 'box_id': 'bx'}, self.path)
                if expected:
                    self.assertIn(expected, err.getvalue())
                else:
                    self.assertEqual(err.getvalue(), '')

    def test_trace_merge_keeps_step_results_when_evidence_writer_failed(self):
        begin = 'begin pid=4 planned=5 epoch=123'
        local = begin + '\nstart step=1\nend step=1 rc=124\nstart step=2\n'
        self.path.write_text('\n'.join('offbox evidence ' + line for line in local.splitlines()) +
                             '\noffbox step 2 rc=0: test\n')
        for next_start, expected in (('', 'before step 3'), ('start step=3\n', 'during step 3')):
            with self.subTest(next_start=next_start):
                trace = (local + next_start).encode()
                with patch('offbox_lib.ssh_sync.ssh', return_value=subprocess.CompletedProcess([], 0, trace)), \
                        contextlib.redirect_stderr(io.StringIO()) as err:
                    run_evidence.report({'run_id': 'run-x', 'box_id': 'bx'}, self.path)
                self.assertIn('step 2 rc=0', err.getvalue())
                self.assertIn(expected, err.getvalue())

    def test_recovered_receipt_survives_step_validation_in_wait_paths(self):
        from offbox_lib import lease
        self.con.execute("UPDATE runs SET status='running',step_count=3,process_id=7 WHERE run_id='run-x'")
        self.con.commit()
        for finalize in (False, True):
            for receipt in (0, 7):
                with self.subTest(finalize=finalize, receipt=receipt):
                    self.con.execute("UPDATE runs SET status='running',exit_code=NULL,known_exit_code=NULL WHERE run_id='run-x'")
                    self.con.commit()
                    row = self.con.execute("SELECT * FROM runs WHERE run_id='run-x'").fetchone()
                    with patch.object(misc, '_recover_by', return_value=(receipt, "the box's exit file")), \
                            patch.object(lease, 'idle_ttl'), patch.object(lease, 'touch'), \
                            patch.object(runs, 'settle_docker'), contextlib.redirect_stdout(io.StringIO()), \
                            contextlib.redirect_stderr(io.StringIO()) as err:
                        code = (misc._finalize(row, receipt, self.path) if finalize else
                                misc._holder_stuck(row, {'status': 'lost'}, self.path, 0, False))
                    self.assertEqual(code, 90)  # A receipt never supplies the missing planned results.
                    self.assertIn('steps incomplete', err.getvalue())
                    self.assertNotIn('no exit receipt', err.getvalue())
                    self.assertNotIn('wrapper vanished', err.getvalue())

    def test_known_exit_is_not_reported_as_a_missing_receipt(self):
        with patch('offbox_lib.ssh_sync.ssh') as ssh, contextlib.redirect_stderr(io.StringIO()) as err:
            run_evidence.report({'exit_code': 0}, self.path)
        self.assertEqual(err.getvalue(), '')
        ssh.assert_not_called()

    def test_expired_wait_budget_does_not_start_another_remote_probe(self):
        self.path.write_text('offbox evidence begin pid=4 planned=5\n')
        with patch('offbox_lib.ssh_sync.ssh') as ssh, patch.object(common, 'now', return_value=10), \
                contextlib.redirect_stderr(io.StringIO()):
            run_evidence.report({'run_id': 'run-x', 'box_id': 'bx'}, self.path, until=9)
        ssh.assert_not_called()


if __name__ == '__main__':
    unittest.main()

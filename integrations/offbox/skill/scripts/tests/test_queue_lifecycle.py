"""Evidence must distinguish a handled termination from a client that disappeared."""
import contextlib
import io
import json
import os
from pathlib import Path
import signal
import sys
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parent))
from offbox_lib import api, common, misc, pool, queue_lifecycle, reap, runs
from test_capacity import Isolated
import test_bg_queue_detach as fixtures


class LifecycleTests(Isolated):
    launch = fixtures.BackgroundQueueTests.launch
    stop_fixture = fixtures.BackgroundQueueTests.stop_fixture
    stop = fixtures.BackgroundQueueTests.stop
    stop_child = fixtures.BackgroundQueueTests.stop_child
    until = fixtures.BackgroundQueueTests.until

    def setUp(self):
        super().setUp()
        # Real children register their own hooks; unit contexts must not outlive their isolated log dirs.
        self.enterContext(patch.object(queue_lifecycle.atexit, 'register'))

    def records(self, rid):
        path = common.LOGS_DIR / f'{rid}.client.log'
        if not path.exists():
            return []
        return [json.loads(line.split(queue_lifecycle.PREFIX, 1)[1]) for line in path.read_text().splitlines()
                if queue_lifecycle.PREFIX in line]

    def test_handoff_records_identity_and_atexit_in_both_logs(self):
        proc, row = self.launch()
        rid = row['run_id']
        self.until(lambda: any(r['reason'] == 'following' for r in self.records(rid)), proc)
        self.assertFalse(any(r['event'] == 'end' for r in self.records(rid)))
        os.kill(row['client_pid'], signal.SIGTERM)
        self.until(lambda: any(r['reason'] == 'atexit' for r in self.records(rid)), proc)
        records = self.records(rid)
        start = next(r for r in records if r['event'] == 'start')
        self.assertEqual(start['pid'], row['client_pid'])
        for key in ('ppid', 'pgid', 'sid'):
            self.assertIsInstance(start[key], int)
        self.assertIn('following', [r['reason'] for r in records])
        self.assertIn('client end: SIGTERM', queue_lifecycle.last_end(rid))
        log = common.LOG_PATH.read_text()
        for r in records:
            self.assertIn(json.dumps(r, separators=(',', ':')), log)

    def test_explicit_kill_sigterm_is_named_and_wait_and_logs_keep_exit_130(self):
        with common.file_lock('fixture-slot'):
            proc, row = self.launch()
            self.until(lambda: (Path(self.tmp.name) / 'waiting').exists(), proc)
            with contextlib.redirect_stdout(io.StringIO()):
                self.assertEqual(misc.kill_run(row['run_id']), 0)
            self.until(lambda: any(r['reason'] == 'atexit' for r in self.records(row['run_id'])), proc)
            for action in (lambda: misc.wait(row['run_id'], 1), lambda: misc.logs(row['run_id'], False)):
                with contextlib.redirect_stderr(io.StringIO()) as err:
                    self.assertEqual(action(), 130)
                self.assertIn('client end: SIGTERM', err.getvalue())
                self.assertIn('killed while queued', err.getvalue())
            self.assertTrue(any(r['event'] == 'signal' and r['reason'] == 'SIGTERM'
                                for r in self.records(row['run_id'])))

    def test_sigkill_has_no_end_and_reaper_explains_loss(self):
        # The fixture handshake proves the child is in its queue wait before it is killed.
        with common.file_lock('fixture-slot'):
            proc, row = self.launch()
            self.until(lambda: (Path(self.tmp.name) / 'waiting').exists(), proc)
            os.kill(row['client_pid'], signal.SIGKILL)
            self.stop(proc)
            self.until(lambda: not misc._client_alive(row['client_pid'], row['start_at']))
            with patch.object(api, 'list_boxes', return_value=[]):
                reap.reap()
            self.assertFalse(any(r['event'] == 'end' for r in self.records(row['run_id'])))
            self.assertIn(f"run {row['run_id']} client_pid={row['client_pid']} check=pid_missing",
                          common.LOG_PATH.read_text())
            for action in (lambda: misc.wait(row['run_id'], 1), lambda: misc.logs(row['run_id'], False)):
                with contextlib.redirect_stderr(io.StringIO()) as err:
                    self.assertEqual(action(), common.EXIT_NOT_STARTED)
                self.assertIn('client log ends with no end record', err.getvalue())

    def test_exception_end_has_traceback_and_logging_does_not_mask_it(self):
        for broken_log in (False, True):
            stderr = io.StringIO()
            with patch.object(common, 'log', side_effect=OSError('disk') if broken_log else None) as logged, \
                    contextlib.redirect_stderr(stderr), self.assertRaisesRegex(ValueError, 'fixture failure'):
                with queue_lifecycle.client('run-exception'):
                    raise ValueError('fixture failure')
            records = [json.loads(line.split(queue_lifecycle.PREFIX, 1)[1])
                       for line in stderr.getvalue().splitlines()]
            self.assertEqual(records[-1]['reason'], 'ValueError')
            self.assertIn('Traceback', records[-2]['traceback'])
            self.assertEqual(logged.call_count, 3)

    def test_queue_failed_telemetry_preserves_signal_and_exception_class(self):
        import toollog
        for error in (runs._ClientSignal(), ValueError('fixture failure'),
                      pool.PoolBusyError('queue limit', queue_expired=True)):
            with patch.object(pool, '_acquire_logged', side_effect=error), \
                    patch.object(toollog, 'emit') as emitted, contextlib.redirect_stderr(io.StringIO()), \
                    self.assertRaises(type(error)):
                with queue_lifecycle.client('run-telemetry'):
                    if isinstance(error, runs._ClientSignal):
                        queue_lifecycle.received('run-telemetry', signal.SIGHUP)
                    pool.acquire(self.me, run_id='run-telemetry')
            event = next(call.kwargs for call in emitted.call_args_list if call.kwargs.get('tag') == 'queue_failed')
            props = toollog._props(event['props'])
            self.assertEqual(props['errorClass'], type(error).__name__)
            if isinstance(error, runs._ClientSignal):
                self.assertEqual(props['signalName'], 'SIGHUP')
            if getattr(error, 'queue_expired', False):
                self.assertTrue(props['queueExpired'])

    def test_background_log_lines_each_include_run_id(self):
        with patch.dict(os.environ, OFFBOX_BACKGROUND_RUN='run-context'):
            common.log('first\nsecond')
        self.assertEqual(len(common.LOG_PATH.read_text().splitlines()), 2)
        self.assertTrue(all('run=run-context' in line for line in common.LOG_PATH.read_text().splitlines()))

    def outcome(self, outcome, reason, code):
        with patch.dict(os.environ, OFFBOX_TEST_QUEUE_OUTCOME=outcome):
            proc, row = self.launch()
        rid = row['run_id']
        self.until(lambda: any(r['reason'] == 'atexit' for r in self.records(rid)), proc)
        ends = [r for r in self.records(rid) if r['event'] == 'end']
        self.assertEqual(ends[0]['reason'], reason)
        if code is not None:
            self.assertEqual(ends[0]['exit_code'], code)
        self.assertIn(f'client end: {reason}', queue_lifecycle.last_end(rid))
        self.assertFalse((Path(self.tmp.name) / 'starts').exists())
        log = common.LOG_PATH.read_text()
        for item in self.records(rid):
            self.assertIn(json.dumps(item, separators=(',', ':')), log)
        return self.records(rid)

    def test_wrapped_child_exception_records_original_stack_and_end(self):
        records = self.outcome('exception', 'OffboxError', common.EXIT_LOCAL)
        error = next(r for r in records if r['event'] == 'queue_failed')
        self.assertIn('fixture queue exception', error['message'])
        self.assertIn('in acquire', error['traceback'])
        self.assertIn('ValueError: fixture queue exception', error['traceback'])
        self.assertNotIn("raise ValueError(", error['traceback'])

    def test_queue_limit_records_reason_without_changing_exit(self):
        self.outcome('limit', 'queue_limit', common.EXIT_BUSY)

    def test_caller_lookup_failure_records_reason_without_changing_refusal(self):
        self.outcome('caller', 'caller_lookup_failure', 2)

    def test_settled_row_records_reason_without_starting(self):
        self.outcome('settled', 'row_no_longer_pending', 130)

    def test_all_handled_signals_record_name_and_parent(self):
        for signum in (signal.SIGINT, signal.SIGTERM, signal.SIGHUP):
            with self.subTest(signal=signum), contextlib.redirect_stderr(io.StringIO()) as err:
                with queue_lifecycle.client('run-signals'):
                    queue_lifecycle.received('run-signals', signum)
                record = json.loads(err.getvalue().splitlines()[-1].split(queue_lifecycle.PREFIX, 1)[1])
                self.assertEqual(record['reason'], signal.Signals(signum).name)
                self.assertEqual(record['ppid'], os.getppid())

    def test_reaper_pid_checks_explain_reuse_and_preserve_unknown_identity(self):
        with patch.object(misc.os, 'kill'), patch.object(misc, '_pid_started_at', return_value=104), \
                patch.object(misc, 'now', return_value=200):
            self.assertFalse(misc._client_alive(123, 100, reaper_run='run-reused'))
        self.assertIn('client_pid=123 check=pid_reused age_s=100.000', common.LOG_PATH.read_text())
        self.assertIn('row_start_at=100 observed_start_at=104', common.LOG_PATH.read_text())
        with patch.object(misc.os, 'kill'), patch.object(misc, '_pid_started_at', return_value=None):
            self.assertTrue(misc._client_alive(123, 100, reaper_run='run-unknown'))
        self.assertNotIn('run-unknown', common.LOG_PATH.read_text())

    def test_last_end_ignores_old_child_atexit_after_failover_and_malformed_lines(self):
        rid = 'run-moved'
        start = dict(run_id=rid, event='start', reason='fresh_exec', pid=22)
        old = dict(run_id=rid, event='end', reason='atexit', previous_reason='forwarded', pid=11)
        end = dict(run_id=rid, event='end', reason='SIGTERM', pid=22, exit_code=130)
        variants = [
            ([], 'no end record'),
            ([start, old], 'no end record'),
            ([end, start], 'no end record'),
            ([start, old, end], 'client end: SIGTERM'),
            ([start, end, old], 'client end: SIGTERM'),
            ([end], 'client end: SIGTERM'),
            ([dict(end, run_id='other')], 'no end record'),
        ]
        for records, expected in variants:
            with self.subTest(records=records):
                path = common.LOGS_DIR / f'{rid}.client.log'
                path.write_text('bg_queue []\nbg_queue invalid\n' + ''.join(
                    queue_lifecycle.PREFIX + json.dumps(item) + '\n' for item in records))
                self.assertIn(expected, queue_lifecycle.last_end(rid))

    def test_last_end_recovers_latest_start_beyond_any_fixed_tail(self):
        rid = 'run-long-queue'
        start = dict(run_id=rid, event='start', reason='fresh_exec', pid=22)
        old = dict(run_id=rid, event='end', reason='atexit', previous_reason='forwarded', pid=11, exit_code=0)
        end = dict(run_id=rid, event='end', reason='SIGTERM', pid=22, exit_code=130)
        for padding in (0, 65535, 65536, 65537, 2 * 65536 + 1):
            for records, expected in (([old], 'no end record'), ([end, old], 'client end: SIGTERM'),
                                      ([old, end], 'client end: SIGTERM')):
                with self.subTest(padding=padding, records=records):
                    (common.LOGS_DIR / f'{rid}.client.log').write_text(
                        queue_lifecycle.PREFIX + json.dumps(start) + '\n' + 'progress\n' * (padding // 9) +
                        'x' * (padding % 9) + '\n' + ''.join(
                            queue_lifecycle.PREFIX + json.dumps(item) + '\n' for item in records))
                    self.assertIn(expected, queue_lifecycle.last_end(rid))

    def test_syntax_exception_family_and_chains_never_log_source_text(self):
        marker = 'private-source-literal'
        for cls in (SyntaxError, IndentationError, TabError):
            for chain in ('direct', 'cause', 'context', 'suppressed'):
                with self.subTest(cls=cls, chain=chain), contextlib.redirect_stderr(io.StringIO()) as err, \
                        patch.object(common, 'log') as logged:
                    syntax = cls('fixture syntax', ('fixture.py', 4, 2, f'secret = "{marker}"\n'))
                    error = syntax
                    if chain != 'direct':
                        error = ValueError('wrapper')
                        if chain == 'cause':
                            error.__cause__ = syntax
                        else:
                            error.__context__ = syntax
                            error.__suppress_context__ = chain == 'suppressed'
                    with self.assertRaises(type(error)):
                        with queue_lifecycle.client('run-syntax'):
                            queue_lifecycle.failed('run-syntax', error)
                            raise error
                    for output in (err.getvalue(), '\n'.join(call.args[0] for call in logged.call_args_list)):
                        self.assertNotIn(marker, output)
                        self.assertNotIn('secret =', output)
                        if chain != 'suppressed':
                            self.assertIn(f'{cls.__name__}: fixture syntax (fixture.py, line 4)', output)

    def test_error_message_and_traceback_failures_preserve_original_exception(self):
        class BrokenMessage(Exception):
            def __str__(self):
                raise OSError('message formatting failed')

        for error in (ValueError('ordinary'), BrokenMessage()):
            for broken_traceback in (False, True):
                with self.subTest(error_class=type(error).__name__, broken_traceback=broken_traceback), \
                        contextlib.redirect_stderr(io.StringIO()) as err, contextlib.ExitStack() as stack:
                    if broken_traceback:
                        stack.enter_context(patch.object(queue_lifecycle, '_traceback', side_effect=OSError('formatter')))
                    try:
                        with queue_lifecycle.client('run-broken-format'):
                            details = queue_lifecycle.failed('run-broken-format', error)
                            self.assertEqual(details['errorClass'], type(error).__name__)
                            raise error
                    except Exception as caught:
                        self.assertIs(caught, error)
                    else:
                        self.fail('original failure was swallowed')
                    records = [json.loads(line.split(queue_lifecycle.PREFIX, 1)[1])
                               for line in err.getvalue().splitlines()]
                    self.assertEqual(records[-1]['reason'], type(error).__name__)
                    self.assertTrue(any(item['event'] == 'exception' for item in records))
                    self.assertTrue(any(item['event'] == 'queue_failed' for item in records))
                    if broken_traceback:
                        self.assertEqual(records[-2]['traceback_error'], 'OSError')

"""Offline run_mail retry/deadline checks; no worker processes or mail queries."""
import copy
import importlib.util
import json
from pathlib import Path
import subprocess
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('triage_retry', Path(__file__).with_name('triage.py'))
t = importlib.util.module_from_spec(spec)
spec.loader.exec_module(t)


class MailRetryTests(unittest.TestCase):
    def setUp(self):
        self.now = 100.0
        self.steps = []
        self.request = {'cursor': {'validity': 1, 'uid': 8}, 'now': 1000}
        clock = patch.object(t.time, 'monotonic', side_effect=lambda: self.now)
        clock.start()
        self.addCleanup(clock.stop)
        worker = patch.object(t.subprocess, 'run', side_effect=self.worker)
        self.run = worker.start()
        self.addCleanup(worker.stop)

    def worker(self, command, **kwargs):
        self.assertEqual(command[-2:], ['--mail-worker', 'juno'])
        self.assertEqual(json.loads(kwargs['input']), self.request)
        self.assertTrue(kwargs['text'])
        self.assertTrue(kwargs['capture_output'])
        timeout = kwargs['timeout']
        self.assertGreater(timeout, 0)
        self.assertLessEqual(timeout, 22)
        self.assertLessEqual(self.now + timeout, 125)
        duration, outcome = self.steps.pop(0)
        if duration > timeout:
            self.now += timeout
            raise subprocess.TimeoutExpired(command, timeout)
        self.now += duration
        if isinstance(outcome, Exception):
            raise outcome
        return outcome

    def success(self, partial=None):
        result = {'items': [{'id': 'mail:juno:1:9'}], 'cursor': {'validity': 1, 'uid': 9},
                  'drops': {}, 'scanned': 1, 'partial': partial}
        return subprocess.CompletedProcess([], 0, json.dumps(result), '')

    def failure(self, message):
        return subprocess.CompletedProcess([], 1, '', message)

    def test_success_and_completed_prefix_return_without_retry(self):
        for partial in (None, 'TimeoutError; completed prefix saved'):
            with self.subTest(partial=partial):
                self.now = 100
                self.run.reset_mock()
                result = self.success(partial)
                self.steps = [(4, result)]
                self.assertEqual(t.run_mail('juno', self.request), json.loads(result.stdout))
                self.run.assert_called_once()

    def test_transient_worker_errors_retry_once_with_remaining_time(self):
        for message in (
            'TimeoutError: The read operation timed out',
            'ConnectionResetError: [Errno 54] Connection reset by peer',
            'abort: command: FETCH => socket error: EOF',
            'RuntimeError: IMAP auth failed: [Errno 60] Operation timed out',
            'gaierror: [Errno -3] Temporary failure in name resolution',
        ):
            with self.subTest(message=message):
                self.now = 100
                self.run.reset_mock()
                result = self.success('time budget; completed prefix saved')
                self.steps = [(9.1, self.failure(message)), (2, result)]
                before = copy.deepcopy(self.request)
                self.assertEqual(t.run_mail('juno', self.request), json.loads(result.stdout))
                self.assertEqual(self.request, before)
                self.assertEqual(self.run.call_count, 2)
                self.assertAlmostEqual(self.run.call_args.kwargs['timeout'], 15.9)

    def test_subprocess_timeout_retries_with_only_three_seconds(self):
        result = self.success()
        self.steps = [(30, None), (2, result)]
        self.assertEqual(t.run_mail('juno', self.request), json.loads(result.stdout))
        self.assertEqual([c.kwargs['timeout'] for c in self.run.call_args_list], [22, 3])
        self.assertEqual(self.now, 124)

    def test_worker_alarm_leaves_six_seconds_for_retry(self):
        self.steps = [(19, self.failure('TimeoutError: mail worker budget exceeded')), (30, None)]
        with self.assertRaises(subprocess.TimeoutExpired):
            t.run_mail('juno', self.request)
        self.assertEqual([c.kwargs['timeout'] for c in self.run.call_args_list], [22, 6])
        self.assertEqual(self.now, 125)

    def test_two_stalls_stop_at_aggregate_deadline(self):
        self.steps = [(30, None), (30, None)]
        before = copy.deepcopy(self.request)
        with self.assertRaises(subprocess.TimeoutExpired):
            t.run_mail('juno', self.request)
        self.assertEqual(self.run.call_count, 2)
        self.assertEqual(self.now, 125)
        self.assertEqual(self.request, before)

    def test_second_quick_failure_does_not_get_third_attempt(self):
        self.steps = [(1, self.failure('TimeoutError: timed out')),
                      (1, self.failure('ConnectionResetError: connection reset by peer'))]
        with self.assertRaisesRegex(RuntimeError, 'ConnectionResetError'):
            t.run_mail('juno', self.request)
        self.assertEqual(self.run.call_count, 2)
        self.assertEqual(self.now, 102)

    def test_no_retry_when_failure_handling_consumed_budget(self):
        # Include elapsed cleanup/scheduling time, rather than just child timeouts.
        def late_failure(*args, **kwargs):
            self.now = 125
            return self.failure('TimeoutError: timed out')
        self.run.side_effect = late_failure
        with self.assertRaisesRegex(RuntimeError, 'TimeoutError'):
            t.run_mail('juno', self.request)
        self.run.assert_called_once()

    def test_permanent_and_unknown_worker_errors_do_not_retry(self):
        for message in (
            'RuntimeError: IMAP auth failed: AUTHENTICATIONFAILED invalid credentials',
            'RuntimeError: invalid_grant; previous request timed out',
            'RuntimeError: credential command failed (ortie rc=1)',
            'FileNotFoundError: No such file or directory: timeout-config.json',
            'SSLCertVerificationError: certificate verify failed',
            "KeyError: 'timeout'",
            'RuntimeError: select INBOX failed',
            '',
        ):
            with self.subTest(message=message):
                self.now = 100
                self.run.reset_mock()
                self.steps = [(1, self.failure(message))]
                with self.assertRaises(RuntimeError):
                    t.run_mail('juno', self.request)
                self.run.assert_called_once()

    def test_invalid_output_and_launch_errors_do_not_retry(self):
        for outcome, error_type in (
            (subprocess.CompletedProcess([], 0, '{invalid', ''), json.JSONDecodeError),
            (FileNotFoundError('missing interpreter'), FileNotFoundError),
            (PermissionError('interpreter permission denied'), PermissionError),
        ):
            with self.subTest(error_type=error_type):
                self.now = 100
                self.run.reset_mock()
                self.steps = [(1, outcome)]
                with self.assertRaises(error_type):
                    t.run_mail('juno', self.request)
                self.run.assert_called_once()


if __name__ == '__main__':
    unittest.main()

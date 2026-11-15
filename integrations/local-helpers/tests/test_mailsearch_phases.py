import contextlib
import importlib.machinery
import importlib.util
import io
import json
from pathlib import Path
import socket
import sys
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch


def load():
    loader = importlib.machinery.SourceFileLoader('mailsearch_phases',
        str(Path(__file__).resolve().parents[1] / 'bin/mailsearch'))
    module = importlib.util.module_from_spec(importlib.util.spec_from_loader(loader.name, loader))
    with patch.dict(sys.modules, mail_oauth=SimpleNamespace()), patch.object(socket, 'getaddrinfo'):
        loader.exec_module(module)
    return module


MAIL = load()


class MailsearchPhases(unittest.TestCase):
    def test_session_open_timeout_keeps_phase_and_elapsed_at_failure(self):
        diagnostic = {}
        with patch.object(MAIL, 'connect', side_effect=TimeoutError('private-cookie')), \
                patch.object(MAIL.time, 'monotonic', side_effect=[10, 10.75]):
            with self.assertRaises(TimeoutError):
                MAIL.search_account('icloud', 'fixture', 1, 5, False, 100, diagnostic)
        with patch.object(MAIL.time, 'monotonic', return_value=100):
            self.assertEqual(MAIL.phase_snapshot(diagnostic),
                             {'phase': 'session_open', 'phaseElapsedMs': 750})

    def test_order_list_and_parse_failures_are_distinguished(self):
        for phase in ('order_list', 'parse'):
            with self.subTest(phase=phase):
                connection = Mock()
                connection.select.return_value = ('OK', [])
                connection.uid.side_effect = [('OK', [b'1']), ('OK', [(b'UID 1', b'private-header')])]
                if phase == 'order_list':
                    connection.select.side_effect = TimeoutError('private-cookie')
                diagnostic = {}
                with patch.object(MAIL, 'connect', return_value=connection), \
                        patch.object(MAIL.time, 'time', return_value=10), \
                        patch.object(MAIL.email, 'message_from_bytes', side_effect=TimeoutError('private-body')):
                    with self.assertRaises(TimeoutError):
                        MAIL.search_account('icloud', 'fixture', 1, 5, False, 100, diagnostic)
                self.assertEqual(MAIL.phase_snapshot(diagnostic)['phase'], phase)
                self.assertNotIn('private-', json.dumps(MAIL.phase_snapshot(diagnostic)))

    def test_json_diagnostics_are_opt_in_and_pending_work_has_current_phase(self):
        for pending in (True, False):
            for enabled in (True, False):
                class Pool:
                    def __init__(self, **kwargs):
                        pass
                    def submit(self, fn, *args):
                        args[-1]['current'] = ('session_open', 10, 1000)
                        return Mock(result=Mock(side_effect=TimeoutError('fixture timeout')))
                output = io.StringIO()
                with patch.object(MAIL, 'ThreadPoolExecutor', Pool), \
                        patch.object(MAIL, 'wait', side_effect=lambda futures, **kw:
                                     (set(), set(futures)) if pending else (set(futures), set())), \
                        patch.object(MAIL.time, 'monotonic', return_value=10.5), \
                        patch.dict(MAIL.os.environ, MAILSEARCH_PHASE_DIAGNOSTICS='1' if enabled else '0'), \
                        patch.object(MAIL.os, '_exit') as exit_process, \
                        contextlib.redirect_stdout(output):
                    MAIL.cmd_search(['-a', 'icloud', '--json', 'fixture'])
                status = json.loads(output.getvalue())['status']['icloud']
                exit_process.assert_called_once_with(1)
                if enabled:
                    self.assertEqual(status['phase'], 'session_open')
                    self.assertEqual(status['phaseElapsedMs'], 500)
                else:
                    self.assertNotIn('phase', status)

    def test_helper_deadline_is_not_overwritten_by_late_worker_progress(self):
        clock = [10]
        diagnostic = {}
        with patch.dict(MAIL.os.environ, MAILSEARCH_PHASE_TOKEN='f' * 32), \
                patch.object(MAIL.time, 'monotonic', side_effect=lambda: clock[0]), \
                patch.object(MAIL.time, 'time', side_effect=lambda: 1000 + clock[0]), \
                patch.object(MAIL.os, 'write') as progress:
            MAIL.phase_start(diagnostic, 'session_open')
            clock[0] = 10.5
            MAIL.phase_failed(diagnostic, TimeoutError())
            clock[0] = 11
            MAIL.phase_start(diagnostic, 'order_list')
            MAIL.phase_progress(diagnostic, 'done')
        row = json.loads(progress.call_args.args[1].decode().split(' ', 1)[1])
        self.assertEqual(row['state'], 'failed')
        self.assertTrue(row['timedOut'])
        self.assertEqual(row['phase'], 'session_open')
        self.assertEqual(row['startedAt'], 1010)
        self.assertEqual(row['phaseElapsedMs'], 500)
        self.assertEqual(MAIL.phase_snapshot(diagnostic), {'phase': 'session_open', 'phaseElapsedMs': 500})

    def test_timeout_timing_excludes_logout_cleanup(self):
        clock = [0]
        connection = Mock()
        def timeout(*args, **kwargs):
            clock[0] = 5
            raise TimeoutError('fixture timeout')
        def cleanup():
            clock[0] = 100
        connection.select.side_effect = timeout
        connection.logout.side_effect = cleanup
        diagnostic = {}
        with patch.object(MAIL, 'connect', return_value=connection), \
                patch.object(MAIL.time, 'time', return_value=0), \
                patch.object(MAIL.time, 'monotonic', side_effect=lambda: clock[0]):
            with self.assertRaises(TimeoutError):
                MAIL.search_account('icloud', 'fixture', 1, 5, False, 200, diagnostic)
            self.assertEqual(MAIL.phase_snapshot(diagnostic),
                             {'phase': 'order_list', 'phaseElapsedMs': 5000})

    def test_read_stdout_and_timeouts_are_unchanged_when_reporting_progress(self):
        connection = Mock()
        connection.select.return_value = ('OK', [])
        raw = b'From: fixture@example.invalid\r\n\r\nprivate-body'
        connection.uid.return_value = ('OK', [(b'UID 1', raw)])
        for token in ('', 'f' * 32):
            output = io.StringIO()
            with patch.object(MAIL, 'connect', return_value=connection) as connect, \
                    patch.dict(MAIL.os.environ, MAILSEARCH_PHASE_TOKEN=token), \
                    patch.object(MAIL.os, 'write') as progress, contextlib.redirect_stdout(output):
                self.assertEqual(MAIL.cmd_read(['icloud', 'INBOX', '1', '--raw']), 0)
            self.assertEqual(output.getvalue(), raw.decode())
            connect.assert_called_once_with('icloud', 25)
            if token:
                self.assertTrue(progress.called)
                self.assertNotIn('private-body', str(progress.call_args_list))
                self.assertNotIn('icloud', str(progress.call_args_list))
            else:
                progress.assert_not_called()

    def test_progress_uses_shared_wall_time_across_different_monotonic_origins(self):
        with patch.dict(MAIL.os.environ, MAILSEARCH_PHASE_TOKEN='f' * 32), \
                patch.object(MAIL.time, 'monotonic', return_value=0.1), \
                patch.object(MAIL.time, 'time', return_value=1000), \
                patch.object(MAIL.os, 'write') as progress:
            MAIL.phase_start({}, 'session_open')
        row = json.loads(progress.call_args.args[1].decode().split(' ', 1)[1])
        self.assertEqual(row['startedAt'], 1000)
        self.assertEqual(row['phase'], 'session_open')
        self.assertNotIn('started', row)
